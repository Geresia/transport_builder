// Pop-based game-style simulation that sits BESIDE the old individual-passenger engine (user decision 2026-09-26).
// It reuses the old state/lines/trains (dispatchTrains + stepTrains move the trains) but replaces the passengers:
//   pops (commuter groups) -> 15-minute release -> mode split -> timetable routing -> board/alight -> fare on arrival,
// plus train operating cost and bonds. Commuters never abandon waiting; only 12 h of no progress drops a movement.
// The old spawnPassengers/expirePassengers are NOT called, so state.passengers stays empty.
// ponytail: the old engine has no elevation/water-crossing/lane data for a drawn line, so a one-time construction
// charge (below) prices every line as a flat, dry, standard double-track surface alignment (elevation -1 = the
// game's "atGrade" class, waterPct 0) - real geometry would need the map/plan-geometry layer's own cost estimator.
// Road congestion is a fixed hourly multiplier, not fed back from the pops.
import { RULES, DEFAULT_TRAIN_TYPE } from "./rules.mjs";
import { haversineMetres } from "./projection.mjs";
import { randomFrom } from "./rng.mjs";
import { dispatchTrains, stepTrains } from "./trains.mjs";
import { buildTimetable, routeJourney, WALK_MPS } from "./router-raptor.mjs";
import { patternsFromState, popTrains, terminalGhost, networkFootprint } from "./pop-adapter.mjs";
import { stepMovements, movementFor, popsToStart, dropRemovedTrains, sweepStuck, waitingByStation, waitingWarningLevel, riders } from "./pop-journey.mjs";
import { modeSplit, perceivedTransitTime, drivingTimeMultiplier } from "./mode-choice-pop.mjs";
import { computeJourneyFare } from "./fares.mjs";
import { journeyRevenue, trainOperatingCost, maintenanceCost, issueBond, bondHour } from "./economy.mjs";
import { trackCost, stationCost } from "./construction-cost.mjs";

const DAY_S = 86400;
const URBAN_DRIVE_MPS = 9; // ~32 km/h door to door
const DETOUR = 1.3; // road distance over straight line
const SURFACE_ELEVATION_M = -1; // elevationClass(-1) === "atGrade": a flat, no-tunnel, no-viaduct default

// Inverse-CDF sampler over the day, weighted by RULES.timeOfDay (column 2 = leaving home, 3 = leaving work).
function departureSampler(column) {
  const bands = RULES.timeOfDay.map(([a, b, home, work]) => ({ a, b, w: (b - a) * (column === "home" ? home : work) }));
  const total = bands.reduce((t, x) => t + x.w, 0);
  return (u) => {
    let x = u * total;
    for (const { a, b, w } of bands) { if (x <= w) return Math.floor((a + (x / w) * (b - a)) * 3600); x -= w; }
    return DAY_S - 1;
  };
}

export function createPopSim(state, demandModel, opts = {}) {
  const popSize = opts.popSize ?? 60, workerShare = opts.workerShare ?? 0.45;
  const rand = randomFrom(state);
  const homeAt = departureSampler("home"), workAt = departureSampler("work");
  const pops = new Map();
  let nextPopId = 1;
  for (const originId of demandModel.origins) {
    const home = (state.demandNodes ?? state.stations).get(originId);
    const commuters = Math.round((home?.residents ?? 0) * workerShare);
    for (let left = commuters; left > 0; left -= popSize) {
      const workId = demandModel.pick(state, originId, rand);
      const work = workId ? (state.demandNodes ?? state.stations).get(workId) : null;
      if (!work || workId === originId) continue;
      pops.set(nextPopId, { id: nextPopId, size: Math.min(left, popSize), homeId: originId, workId, homeLoc: home.location, workLoc: work.location, homeDeparture: homeAt(rand()), workDeparture: workAt(rand()), journey: null });
      nextPopId++;
    }
  }
  const nowS = state.simMinutes * 60;
  return {
    pops, movements: new Map(), tt: null, ttUntil: -Infinity,
    trainType: opts.trainType ?? DEFAULT_TRAIN_TYPE, fare: opts.fare ?? RULES.economy.defaultFare,
    nextReleaseS: Math.ceil(nowS / RULES.time.commuteIntervalS) * RULES.time.commuteIntervalS,
    nextHourS: Math.floor(nowS / 3600) * 3600 + 3600,
    nextInfraS: Math.ceil(nowS / RULES.economy.infrastructureChargeIntervalS) * RULES.economy.infrastructureChargeIntervalS,
    money: opts.startingMoney ?? RULES.economy.startingMoney, bonds: [],
    revenueToday: 0, costToday: 0, yesterdayRevenue: 0, dayIndex: Math.floor(nowS / DAY_S),
    nearCapacity: [],
    billedLineIds: new Set(), billedStationIds: new Set(),
    stats: { released: { transit: 0, driving: 0, walking: 0, noRoute: 0 }, completed: 0, ridersDelivered: 0, revenue: 0, operatingCost: 0, maintenanceCost: 0, constructionCost: 0, interest: 0, dropped: 0 },
  };
}

// One-time cost of every line not yet billed (a player-drawn line only: `external` lines were seeded from the real
// network at pack load and were never "built" by the player). Track is priced once per line; a station shared by
// several lines is priced once, the first time any line calls at it.
function billNewConstruction(sim, state) {
  for (const line of state.lines) {
    if (line.external || line.planOnly || line.stationIds.length < 2 || sim.billedLineIds.has(line.id)) continue;
    sim.billedLineIds.add(line.id);
    let lengthM = 0;
    for (let i = 0; i < line.stationIds.length - 1; i++) {
      lengthM += haversineMetres(state.stations.get(line.stationIds[i]).location, state.stations.get(line.stationIds[i + 1]).location);
    }
    let cost = trackCost({ lengthM, trainType: sim.trainType, elevation: SURFACE_ELEVATION_M, waterPct: 0 });
    for (const id of line.stationIds) {
      if (sim.billedStationIds.has(id)) continue;
      sim.billedStationIds.add(id);
      cost += stationCost({ trainType: sim.trainType, elevation: SURFACE_ELEVATION_M, waterPct: 0 });
    }
    sim.money -= cost; sim.costToday += cost; sim.stats.constructionCost += cost;
  }
}

// Stations plus service change once an hour (headways per band) and whenever the network is edited.
function refreshTimetable(sim, state, nowS) {
  if (!state.networkDirty && nowS < sim.ttUntil) return;
  sim.tt = buildTimetable({ stations: state.stations, patterns: patternsFromState(state, nowS) });
  sim.ttUntil = (Math.floor(nowS / 3600) + 1) * 3600;
  state.networkDirty = false;
}

function releaseJourneys(sim, state, nowS) {
  const secondsOfDay = nowS % DAY_S;
  const hour = Math.floor(secondsOfDay / 3600);
  const plans = new Map();
  const plan = (from, to, size, key) => {
    if (plans.has(key)) return plans.get(key);
    const straight = haversineMetres(from, to);
    const route = routeJourney(sim.tt, from, to, nowS);
    const fare = route ? computeJourneyFare(route.segments, {}, sim.fare) : 0;
    const driveM = straight * DETOUR;
    const split = modeSplit({
      population: size, drivingTime: driveM / URBAN_DRIVE_MPS, drivingDistance: driveM, walkTime: (straight * 1.2) / WALK_MPS,
      transitTime: route ? perceivedTransitTime(route.segments, nowS).perceivedTime : 1e12, transitCost: fare, drivingTimeMultiplier: drivingTimeMultiplier(hour),
    });
    const out = { route, fare, split };
    plans.set(key, out);
    return out;
  };
  for (const { popId, direction } of popsToStart({ pops: sim.pops, movements: sim.movements, secondsOfDay })) {
    const pop = sim.pops.get(popId);
    const [from, to] = direction === "home" ? [pop.homeLoc, pop.workLoc] : [pop.workLoc, pop.homeLoc];
    const { route, fare, split } = plan(from, to, pop.size, `${direction}|${pop.homeId}|${pop.workId}|${pop.size}`);
    sim.stats.released.driving += split.driving;
    sim.stats.released.walking += split.walking;
    if (!route) { sim.stats.released.noRoute += split.transit; continue; }
    if (split.transit === 0) continue;
    sim.stats.released.transit += split.transit;
    pop.journey = { transit: split.transit, segments: route.segments, fareCost: fare };
    sim.movements.set(popId, movementFor(route.segments[0], 0, nowS));
  }
}

export function popSimStep(sim, state, seconds = 1) {
  state.simMinutes += seconds / 60;
  const nowS = Math.round(state.simMinutes * 60 * 1000) / 1000; // simMinutes accumulates 1/60 per step: drop the float dust
  billNewConstruction(sim, state);
  refreshTimetable(sim, state, nowS);
  dispatchTrains(state);

  const before = new Map(state.trains.map((t) => [t.id, t]));
  stepTrains(state, seconds);
  const alive = new Set(state.trains.map((t) => t.id));
  const removed = new Set(), ghosts = [];
  for (const [id, t] of before) {
    if (alive.has(id)) continue;
    removed.add(id);
    const line = state.lines.find((l) => l.id === t.lineId);
    if (line) ghosts.push(terminalGhost(t, line, sim.trainType));
  }

  if (nowS >= sim.nextReleaseS) {
    releaseJourneys(sim, state, nowS);
    sim.nextReleaseS = Math.floor(nowS / RULES.time.commuteIntervalS) * RULES.time.commuteIntervalS + RULES.time.commuteIntervalS;
  }

  const res = stepMovements({ now: nowS, pops: sim.pops, movements: sim.movements, trains: [...popTrains(state, sim.trainType), ...ghosts], stationExists: (id) => state.stations.has(id) });
  const kept = dropRemovedTrains(res.movements, removed);
  sim.stats.dropped += res.movements.size - kept.size;
  sim.movements = kept;
  sim.nearCapacity = res.nearCapacity;
  for (const { pop } of res.completed) {
    if (!pop?.journey) continue;
    const revenue = journeyRevenue(pop, sim.fare);
    sim.money += revenue; sim.revenueToday += revenue;
    sim.stats.revenue += revenue; sim.stats.completed++; sim.stats.ridersDelivered += riders(pop);
    pop.journey = null;
  }

  const linesById = new Map(state.lines.map((l) => [l.id, l]));
  for (const t of state.trains) {
    const cars = linesById.get(t.lineId)?.carsPerTrain ?? 0;
    const cost = trainOperatingCost({ trainType: sim.trainType, cars, seconds });
    sim.money -= cost; sim.costToday += cost; sim.stats.operatingCost += cost;
  }

  if (nowS >= sim.nextInfraS) {
    const interval = RULES.economy.infrastructureChargeIntervalS;
    sim.nextInfraS += interval;
    const { trackLengthM, stationCount } = networkFootprint(state);
    const cost = maintenanceCost({ trackLengthM, stationCount, trainType: sim.trainType, seconds: interval });
    sim.money -= cost; sim.costToday += cost; sim.stats.maintenanceCost += cost;
  }

  if (nowS >= sim.nextHourS) {
    sim.nextHourS += 3600;
    sim.movements = sweepStuck(sim.movements, nowS);
    sim.bonds = sim.bonds.map((b) => {
      const r = bondHour(b);
      sim.money -= r.interest + r.repay; sim.stats.interest += r.interest;
      return r.bond;
    }).filter((b) => b.remaining > 0);
    const day = Math.floor(nowS / DAY_S);
    if (day !== sim.dayIndex) { sim.dayIndex = day; sim.yesterdayRevenue = sim.revenueToday; sim.revenueToday = 0; sim.costToday = 0; }
  }
}

export function advancePopSim(sim, state, simSeconds) {
  for (let i = 0; i < simSeconds; i++) popSimStep(sim, state, 1);
}

export function takeBond(sim, kind) {
  const bond = issueBond(kind, sim.yesterdayRevenue);
  if (!bond) return null;
  sim.bonds.push(bond);
  sim.money += bond.principal;
  return bond;
}

// Everything the HUD shows, computed on demand.
export function popSummary(sim) {
  let onboard = 0, walking = 0;
  for (const [popId, m] of sim.movements) {
    if (m.trigger.type === "train-disembark") onboard += riders(sim.pops.get(popId));
    else if (m.trigger.type === "time") walking += riders(sim.pops.get(popId));
  }
  const waitingAt = waitingByStation(sim.movements, sim.pops);
  const warnings = [...waitingAt].map(([stationId, count]) => ({ stationId, count, level: waitingWarningLevel(count) })).filter((w) => w.level > 0).sort((a, b) => b.count - a.count);
  return {
    money: sim.money, revenueToday: sim.revenueToday, costToday: sim.costToday, yesterdayRevenue: sim.yesterdayRevenue,
    waiting: [...waitingAt.values()].reduce((t, n) => t + n, 0), onboard, walking, warnings, nearCapacity: sim.nearCapacity.length,
    bonds: sim.bonds.length, stats: sim.stats,
  };
}
