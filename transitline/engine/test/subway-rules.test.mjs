// node --test engine/test/subway-rules.test.mjs — checks of the reference-game model modules against numbers read from
// the game's own tutorial clips / footage (see docs/subway-builder-mechanics-study.md 2.5) and its documented rules.
import test from "node:test";
import assert from "node:assert/strict";
import { RULES, TRAIN_TYPES } from "../src/rules.mjs";
import { elevationClass, finalMultiplier, stationCost, stationMaxCars, stationLengthRangeM, trackCost, deepBoreSegment, buildingOverpassCost } from "../src/construction-cost.mjs";
import { motionStep, distanceToReachSpeed, speedLimit, demandLevel, idealTrainCount, operatingLevels } from "../src/train-physics.mjs";
import { stepMovements, movementFor, firstLegStations, waitingWarningLevel, sweepStuck, popsToStart } from "../src/pop-journey.mjs";
import { journeyRevenue, trainOperatingCost, maintenanceCost, issueBond, bondHour } from "../src/economy.mjs";

test("elevation classes follow the documented thresholds", () => {
  const cls = [-150, -100, -50, -24, -10, -4, -3, -1, 0, 3, 4.9, 5, 20].map(elevationClass);
  assert.deepEqual(cls, ["deepBore", "deepBore", "standardTunnel", "standardTunnel", "cutAndCover", "cutAndCover", "trenched", "trenched", "atGrade", "ramp", "ramp", "elevated", "elevated"]);
});

test("water share scales the multiplier; open classes are effectively unbuildable over water", () => {
  assert.equal(finalMultiplier(-6, 0), 1);
  assert.equal(finalMultiplier(-6, 100), 3); // cut and cover over water x3
  assert.ok(Math.abs(finalMultiplier(0, 10) - (0.9 * 0.35 + 0.1 * 0.35 * 100)) < 1e-9); // at-grade, 10% water: x100 on that share
});

test("station cost: tutorial clip ratio 10 cars : 15 cars = 50.42 : 55.00", () => {
  const len = (cars) => TRAIN_TYPES["heavy-metro"].stationCarLength * cars + RULES.construction.stationLengthBufferM;
  assert.equal(stationMaxCars({ platformLengthM: len(10), trainType: "heavy-metro" }), 10);
  assert.equal(stationMaxCars({ platformLengthM: len(15), trainType: "heavy-metro" }), 15);
  const c10 = stationCost({ trainType: "heavy-metro", platformLengthM: len(10), elevation: -6 });
  const c15 = stationCost({ trainType: "heavy-metro", platformLengthM: len(15), elevation: -6 });
  assert.ok(Math.abs(c10 / c15 - 50.42 / 55.0) < 5e-4, `${c10 / c15}`);
  assert.equal(c15, 6e7); // v1.7.1 base; the clip shows 55.00M (older build)
});

test("station multipliers: single 0.75, quad 1.5, express layout 1.25", () => {
  const base = stationCost({ trainType: "heavy-metro", elevation: -6 });
  assert.equal(stationCost({ trainType: "heavy-metro", elevation: -6, lanes: "single" }) / base, 0.75);
  assert.equal(stationCost({ trainType: "heavy-metro", elevation: -6, lanes: "quad", layout: "express" }) / base, 1.5 * 1.25);
});

test("station platform length range and track cost", () => {
  assert.deepEqual(stationLengthRangeM("heavy-metro"), { min: 97.75, max: 285.25 });
  assert.equal(trackCost({ lengthM: 1000, trainType: "heavy-metro", lanes: 2, elevation: -6 }), 3e7);
  assert.equal(trackCost({ lengthM: 1000, trainType: "heavy-metro", lanes: 1, elevation: -30 }), 1000 * 3e4 * 0.75 * 2);
});

test("deep bore: short bore pays mobilisation only, long bore pays its raw cost", () => {
  assert.deepEqual(deepBoreSegment(1e7), { mobilization: 4e7, trackCost: 0 });
  const long = deepBoreSegment(1e8);
  assert.equal(long.mobilization + long.trackCost, 1e8);
});

test("building overpass grows with span and height", () => {
  const a = buildingOverpassCost({ spanM: 35, heightM: 10, trainType: "heavy-metro" });
  const b = buildingOverpassCost({ spanM: 60, heightM: 10, trainType: "heavy-metro" });
  assert.ok(b > a && a >= 2e6);
});

test("motion: jerk-limited acceleration, immediate braking, 4-decimal rounding", () => {
  const p = { target: 20, maxAcc: 1.12, maxDec: 1.34 };
  const s1 = motionStep({ speed: 0, accel: 0, ...p });
  assert.equal(s1.speed, 0.075); // jerk 0.3 x 0.5^2
  const s2 = motionStep({ ...s1, ...p });
  assert.equal(s2.speed, 0.225); // acceleration may grow by 0.075 per tick
  assert.equal(motionStep({ speed: 10, accel: 0, target: 0, maxAcc: 1, maxDec: 1.34 }).speed, 9.33);
  assert.equal(motionStep({ speed: 5.005, accel: 0, target: 5, maxAcc: 1, maxDec: 1 }).speed, 5.005); // inside the 0.01 margin
  assert.ok(distanceToReachSpeed({ speed: 24.72, target: 0, maxAcc: 1.12, maxDec: 1.34 }) > 200);
});

test("speed limit reproduces the tutorial labels: 89 km/h straight, 47 km/h in station, 61 km/h on a bend", () => {
  const kmh = (v) => Math.round(v * 3.6);
  assert.equal(kmh(speedLimit({ trainType: "heavy-metro" })), 89);
  assert.equal(kmh(speedLimit({ trainType: "heavy-metro", inStation: true })), 47);
  assert.equal(kmh(speedLimit({ trainType: "heavy-metro", radiusM: 1156 })), 61); // integer m/s = 17
  assert.equal(speedLimit({ trainType: "heavy-metro", slopePct: 5.5 }), 24.72 * 0.6);
});

test("demand levels and train-count fade around a level change", () => {
  assert.deepEqual([0, 3, 6, 7, 12, 16, 19, 20, 23].map(demandLevel), ["veryLow", "low", "medium", "high", "medium", "high", "medium", "low", "veryLow"]);
  const sched = { high: 9, medium: 5, low: 3, veryLow: 2 };
  const cycle = 1200; // 20 min round trip -> +-20 min fade
  assert.equal(idealTrainCount(sched, 12 * 3600, cycle), 5);
  assert.equal(idealTrainCount(sched, 8 * 3600 + 1800, cycle), 9);
  assert.equal(idealTrainCount(sched, 7 * 3600, cycle), 7); // exactly at the medium->high boundary: halfway (5+9)/2
  assert.equal(idealTrainCount(sched, 6 * 3600 + 3000, cycle), 6); // 6:50, a quarter of the way
  // Long routes (80 min, footage) make adjacent windows overlap; like the game, the earliest matching transition wins.
  assert.equal(idealTrainCount(sched, 7 * 3600, 4800), 5);
  assert.deepEqual(operatingLevels(4, sched), { high: true, medium: true, low: false, veryLow: false });
  assert.deepEqual(operatingLevels(9, sched), { high: false, medium: false, low: false, veryLow: false });
});

// ---- passenger movement -------------------------------------------------------------------------------------------
const pop = (id, size, segments) => ({ id, size, journey: { transit: size, segments } });
const ride = (from, to, route = "R") => ({ kind: "transit", routeId: route, fromStopId: from, toStopId: to, departureTime: 0, arrivalTime: 600 });
const walk = (dep, arr) => ({ kind: "walk", departureTime: dep, arrivalTime: arr });
const trainAt = (id, stationId, stationsAhead, maxCapacity = 100) => ({ id, routeId: "R", stopped: true, stationId, stationsAhead, maxCapacity });

test("pop boards all-or-nothing, travels, transfers by walking and completes on arrival", () => {
  const pops = new Map([[1, pop(1, 60, [walk(0, 100), ride("A", "C")])], [2, pop(2, 60, [ride("A", "C")])]]);
  let movements = new Map([[1, movementFor(pops.get(1).journey.segments[0], 0, 0)], [2, movementFor(pops.get(2).journey.segments[0], 0, 0)]]);
  // t=200: pop 1 finished walking -> embark trigger at A
  let r = stepMovements({ now: 200, pops, movements, trains: [] });
  movements = r.movements;
  assert.equal(movements.get(1).trigger.type, "train-embark");
  // train stops at A with 100 seats: pop 1 boards (60), pop 2 (60) does not fit and keeps waiting
  const train = trainAt("T1", "A", ["A", "B", "C"], 100);
  r = stepMovements({ now: 210, pops, movements, trains: [train] });
  assert.equal(r.movements.get(1).trigger.type, "train-disembark");
  assert.equal(r.movements.get(2).trigger.type, "train-embark", "second group does not fit and keeps waiting (no splitting)");
  assert.equal(r.nearCapacity.length, 1);
  // train reaches C: pop 1 disembarks, journey ends
  r = stepMovements({ now: 900, pops, movements: r.movements, trains: [trainAt("T1", "C", ["C", "B", "A"])] });
  assert.equal(r.completed.length, 1);
  assert.equal(r.completed[0].pop.id, 1);
  assert.equal(journeyRevenue(r.completed[0].pop), 60 * 3 * 365);
});

test("a train only takes riders to stations on its first leg, and seats freed at this stop can be reused", () => {
  assert.deepEqual([...firstLegStations(["A", "B", "C", "B", "A"])], ["A", "B", "C"]);
  const pops = new Map([[1, pop(1, 50, [ride("B", "A")])], [2, pop(2, 50, [ride("A", "B")])], [3, pop(3, 50, [ride("A", "B")])]]);
  const movements = new Map([[2, movementFor(pops.get(2).journey.segments[0], 0, 0)], [3, movementFor(pops.get(3).journey.segments[0], 0, 0)]]);
  movements.set(1, { trigger: { type: "train-disembark", trainId: "T1", destinationStationId: "B" }, lastUpdated: 0, journeyIndex: 0 });
  const atB = trainAt("T1", "B", ["B", "A"], 100);
  const r = stepMovements({ now: 5, pops, movements, trains: [atB] });
  assert.equal(r.completed.length, 1); // pop 1 got off at B
  assert.equal(r.movements.get(2).trigger.type, "train-embark"); // pops 2/3 wait at A, T1 is at B: no boarding
});

test("removed trains delete their passengers; stuck movements are swept after 12 h; warnings escalate", () => {
  const m = new Map([[1, { trigger: { type: "time", seconds: 1e9 }, lastUpdated: 0, journeyIndex: 0 }], [2, { trigger: { type: "time", seconds: 1e9 }, lastUpdated: 40000, journeyIndex: 0 }]]);
  assert.deepEqual([...sweepStuck(m, 44000).keys()], [2]);
  assert.deepEqual([50, 100, 250, 999, 1000, 10 ** 6].map(waitingWarningLevel), [0, 100, 200, 500, 1000, 100000]);
  const pops = new Map([[1, { id: 1, size: 1, homeDeparture: 8 * 3600 + 300, workDeparture: 17 * 3600 }], [2, { id: 2, size: 1, homeDeparture: 1, workDeparture: 8 * 3600 + 600 }]]);
  assert.deepEqual(popsToStart({ pops, movements: new Map(), secondsOfDay: 8 * 3600 }), [{ popId: 1, direction: "home" }, { popId: 2, direction: "work" }]);
});

// ---- economy ------------------------------------------------------------------------------------------------------
test("train cost uses the 365 scale; parked trains are free", () => {
  assert.equal(trainOperatingCost({ trainType: "heavy-metro", cars: 5, seconds: 3600 }), (250 + 5 * 25) * 365);
  assert.equal(trainOperatingCost({ cars: 5, seconds: 3600, parked: true }), 0);
});

test("maintenance: annual track+station rates billed for the elapsed time, x the maintenance multiplier", () => {
  // Heavy Metro: trackMaintPerM 180/yr, stationMaintPerYear 1.6e5; 5 km of track, 4 stations, one 5-minute tick.
  const daily = (180 * 5000 + 1.6e5 * 4) / 365;
  assert.equal(maintenanceCost({ trackLengthM: 5000, stationCount: 4, seconds: 300 }), daily * (300 / 86400) * 2);
  assert.equal(maintenanceCost({ trackLengthM: 0, stationCount: 0, seconds: 300 }), 0);
});

test("bonds: eligibility by yesterday's revenue, hourly interest on remaining, repayment on original", () => {
  assert.equal(issueBond("MEDIUM", 5e7), null);
  const b = issueBond("SMALL", 1e7);
  const h = bondHour(b);
  assert.equal(h.interest, (1e8 * 0.06) / 24);
  assert.equal(h.repay, 1e5);
  assert.equal(h.bond.remaining, 1e8 - 1e5);
  const h2 = bondHour(h.bond);
  assert.equal(h2.interest, ((1e8 - 1e5) * 0.06) / 24);
});
