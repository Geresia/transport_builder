// Passenger-group ("pop") movement of the reference game (doc "승객 이동·승하차·수익"). Pure functions; the caller owns
// the maps. A pop is a group that boards a train all-or-nothing:
//   pop      = { id, size, journey: { transit: <riders>, segments: [{ kind: "walk"|"drive"|"transit", routeId,
//                fromStopId, toStopId, departureTime, arrivalTime }] }, homeDeparture?, workDeparture? }
//   movement = { trigger, lastUpdated, journeyIndex }
//   trigger  = { type: "time", seconds } | { type: "train-embark", routeId, stationId }
//            | { type: "train-disembark", trainId, destinationStationId }
//   train    = { id, routeId, stopped, stationId (where it stands), stationsAhead: [ids from the current stop on],
//                maxCapacity }
import { RULES } from "./rules.mjs";

export const riders = (pop) => pop.journey?.transit ?? pop.size;

export function movementFor(segment, index, now) {
  const trigger = segment.kind === "transit"
    ? { type: "train-embark", routeId: segment.routeId, stationId: segment.fromStopId }
    : { type: "time", seconds: segment.arrivalTime };
  return { trigger, lastUpdated: now, journeyIndex: index };
}

// Stations a train can still reach before it turns back onto a station it already listed (first leg of a round trip).
export function firstLegStations(stationsAhead) {
  const seen = new Set();
  for (const s of stationsAhead) {
    if (seen.has(s)) break;
    seen.add(s);
  }
  return seen;
}

const headedTo = (train, target) => train.stationsAhead.length >= 2 && firstLegStations(train.stationsAhead).has(target);

// One sweep over every movement. Returns the new movement map plus completed journeys and near-capacity trains.
// ctx = { now, pops: Map, movements: Map, trains: Map|Array, stationExists?: (id) => bool, emptySeatsWarn? }
export function stepMovements(ctx) {
  const { now, pops, movements } = ctx;
  const trains = ctx.trains instanceof Map ? ctx.trains : new Map(ctx.trains.map((t) => [t.id, t]));
  const warnBelow = ctx.emptySeatsWarn ?? RULES.economy.capacityWarningEmptySeats;
  const stoppedByRoute = new Map();
  for (const t of trains.values()) if (t.stopped) (stoppedByRoute.get(t.routeId) ?? stoppedByRoute.set(t.routeId, []).get(t.routeId)).push(t);

  // Riders currently aboard each train, from disembark triggers; capacity changes accumulate during the sweep.
  const aboard = new Map(), exiting = new Map();
  for (const [popId, m] of movements) {
    if (m.trigger.type !== "train-disembark") continue;
    const n = riders(pops.get(popId)), key = `${m.trigger.trainId}|${m.trigger.destinationStationId}`;
    aboard.set(m.trigger.trainId, (aboard.get(m.trigger.trainId) ?? 0) + n);
    exiting.set(key, (exiting.get(key) ?? 0) + n);
  }
  const pending = new Map();
  const exitingAt = (train) => exiting.get(`${train.id}|${train.stationId}`) ?? 0;

  const next = new Map(), completed = [], nearCapacity = new Map();
  for (const [popId, m] of movements) {
    const pop = pops.get(popId);
    const seg = pop?.journey?.segments;
    const t = m.trigger;
    if (!pop || !seg?.length) { completed.push({ pop, movement: m }); continue; }

    if (t.type === "time") {
      if (!(t.seconds < now)) { next.set(popId, m); continue; }
      const i = m.journeyIndex + 1;
      if (i >= seg.length) completed.push({ pop, movement: m });
      else next.set(popId, movementFor(seg[i], i, now));
    } else if (t.type === "train-embark") {
      if (ctx.stationExists && !ctx.stationExists(t.stationId)) continue; // station deleted: drop the pop
      const i = m.journeyIndex;
      if (i >= seg.length) { completed.push({ pop, movement: m }); continue; }
      const size = riders(pop);
      const train = (stoppedByRoute.get(t.routeId) ?? []).find((tr) => {
        if (tr.stationId !== t.stationId || !headedTo(tr, seg[i].toStopId)) return false;
        const free = tr.maxCapacity - ((aboard.get(tr.id) ?? 0) - exitingAt(tr) + (pending.get(tr.id) ?? 0));
        return size <= free;
      });
      if (!train) { next.set(popId, m); continue; }
      pending.set(train.id, (pending.get(train.id) ?? 0) + size);
      const occupied = (aboard.get(train.id) ?? 0) + pending.get(train.id);
      if (train.maxCapacity - occupied <= warnBelow) nearCapacity.set(`${train.id}-${t.stationId}`, { trainId: train.id, stationId: t.stationId, occupied, maxCapacity: train.maxCapacity });
      next.set(popId, { trigger: { type: "train-disembark", trainId: train.id, destinationStationId: seg[i].toStopId }, lastUpdated: now, journeyIndex: i });
    } else if (t.type === "train-disembark") {
      const train = trains.get(t.trainId);
      if (!train?.stopped || train.stationId !== t.destinationStationId) { next.set(popId, m); continue; }
      aboard.set(train.id, (aboard.get(train.id) ?? 0) - riders(pop));
      const i = m.journeyIndex + 1;
      if (i >= seg.length) { completed.push({ pop, movement: m }); continue; }
      const s = seg[i];
      next.set(popId, s.kind !== "transit"
        ? { trigger: { type: "time", seconds: now + (s.arrivalTime - s.departureTime) }, lastUpdated: now, journeyIndex: i }
        : movementFor(s, i, now));
    } else next.set(popId, m);
  }
  return { movements: next, completed, nearCapacity: [...nearCapacity.values()] };
}

// Pops riding a removed train vanish (no refund, no revenue).
export function dropRemovedTrains(movements, removedTrainIds) {
  const out = new Map();
  for (const [id, m] of movements) if (!(m.trigger.type === "train-disembark" && removedTrainIds.has(m.trigger.trainId))) out.set(id, m);
  return out;
}

// Hourly sweep: movements untouched for more than 12 game hours are dropped.
export function sweepStuck(movements, now) {
  const out = new Map();
  for (const [id, m] of movements) if (now - m.lastUpdated <= RULES.time.maxJourneyS) out.set(id, m);
  return out;
}

// Riders waiting to board, per station; and the game's escalating waiting-crowd warning levels.
export function waitingByStation(movements, pops) {
  const out = new Map();
  for (const [popId, m] of movements) if (m.trigger.type === "train-embark") out.set(m.trigger.stationId, (out.get(m.trigger.stationId) ?? 0) + riders(pops.get(popId)));
  return out;
}
export const WAITING_WARNING_LEVELS = [100, 200, 500, 1000, 2000, 10000, 100000];
export const waitingWarningLevel = (count) => WAITING_WARNING_LEVELS.findLast((l) => count >= l) ?? 0;

// Every 15 minutes: idle pops whose fixed daily departure falls inside the next window start a journey.
export function popsToStart({ pops, movements, secondsOfDay, windowS = RULES.time.commuteIntervalS }) {
  const out = [];
  for (const pop of pops.values()) {
    if (movements.has(pop.id)) continue;
    const home = pop.homeDeparture - secondsOfDay, work = pop.workDeparture - secondsOfDay;
    if (home >= 0 && home <= windowS) out.push({ popId: pop.id, direction: "home" });
    else if (work >= 0 && work <= windowS) out.push({ popId: pop.id, direction: "work" });
  }
  return out;
}
