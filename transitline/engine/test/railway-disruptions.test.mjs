import test from "node:test";
import assert from "node:assert/strict";
import { restoreOperationalState, snapshotOperationalState } from "../src/integrated-save.mjs";
import { TRAIN_SPEED_MPS } from "../src/network.mjs";
import { railwayTrafficForDays } from "../src/railway-traffic-control.mjs";
import {
  advanceRailwayDisruptions,
  createRailwayDisruption,
  evaluateRailwayDisruptionHour,
  railwayDisruptionEffect,
  railwayDisruptionReport,
  resolveRailwayDisruption,
} from "../src/railway-disruptions.mjs";
import { addLine, addPhysicalStation, addTrackSegment, createState } from "../src/state.mjs";
import { stepTrains } from "../src/trains.mjs";

function fixture(seed = 17) {
  const state = createState({ demand: { model: "gravity", points: [], attractors: [] } }, { seed });
  addPhysicalStation(state, { id: "A", location: [139, 35] });
  addPhysicalStation(state, { id: "B", location: [139.01, 35] });
  addPhysicalStation(state, { id: "C", location: [139.02, 35] });
  addTrackSegment(state, { id: "ab", fromStationId: "A", toStationId: "B", directionMode: "double" });
  addTrackSegment(state, { id: "bc", fromStationId: "B", toStationId: "C", directionMode: "double" });
  const line = addLine(state, ["A", "B", "C"], { name: "Player line" });
  line.owned = true;
  line.operatorId = "player";
  line.infrastructureOwnerId = "owner:player";
  line.trackSegmentIds = ["ab", "bc"];
  return { state, line };
}

test("a section speed restriction is a physical overlay shared by every line using that section", () => {
  const { state, line } = fixture();
  const shared = addLine(state, ["A", "B"]);
  shared.trackSegmentIds = ["ab"];
  const event = createRailwayDisruption(state, {
    kind: "severe-weather", lineId: line.id, trackSegmentId: "ab", durationMinutes: 45, speedLimitMps: 8,
  });
  assert.equal(event.infrastructureOwnerId, "owner:player");
  assert.deepEqual(railwayDisruptionEffect(state, { lineId: line.id, trackSegmentId: "ab", trainId: 1 }), {
    active: true, closed: false, speedLimitMps: 8, eventIds: [event.id], kinds: ["severe-weather"],
  });
  assert.equal(railwayDisruptionEffect(state, { lineId: shared.id, trackSegmentId: "ab" }).speedLimitMps, 8);
  assert.equal(railwayDisruptionEffect(state, { lineId: line.id, trackSegmentId: "bc" }).active, false);
});

test("a restricted train moves at the lower speed and records only the attributable delay", () => {
  const { state, line } = fixture();
  const train = { id: 1, lineId: line.id, segIndex: 0, dir: 1, t: 0, dwell: 0, trafficOperatingDay: 0 };
  state.trains = [train];
  createRailwayDisruption(state, {
    kind: "severe-weather", lineId: line.id, trackSegmentId: "ab", durationMinutes: 60, speedLimitMps: 10,
  });
  stepTrains(state, 10);
  assert.ok(train.t > 0);
  assert.ok(train.t < TRAIN_SPEED_MPS * 10 / 800, "the train did not use the unrestricted speed");
  const expectedDelay = 10 * (1 - 10 / TRAIN_SPEED_MPS);
  assert.ok(Math.abs(train.disruptionDelaySeconds - expectedDelay) < 1e-9);
  assert.ok(Math.abs(state.stats.railwayTrafficByLine[String(line.id)].disruptionDelaySeconds - expectedDelay) < 1e-9);
  assert.ok(Math.abs(state.stats.trainKmByLine[String(line.id)] - 0.1) < 1e-9);
});

test("a closure stops an in-flight train, then natural recovery releases it", () => {
  const { state, line } = fixture();
  const train = { id: 1, lineId: line.id, segIndex: 0, dir: 1, t: 0.4, dwell: 0, trafficOperatingDay: 0 };
  state.trains = [train];
  const event = createRailwayDisruption(state, {
    kind: "track-obstruction", lineId: line.id, trackSegmentId: "ab", durationMinutes: 5,
  });
  stepTrains(state, 12);
  assert.equal(train.t, 0.4);
  assert.deepEqual(train.waitingForDisruption.eventIds, [event.id]);
  assert.equal(train.disruptionDelaySeconds, 12);
  state.simMinutes += 5;
  const advanced = advanceRailwayDisruptions(state);
  assert.deepEqual(advanced.resolved.map((entry) => entry.id), [event.id]);
  stepTrains(state, 1);
  assert.ok(train.t > 0.4);
  assert.equal(train.waitingForDisruption, undefined);
});

test("manual clearing is validated and overlapping restrictions reduce to the minimum speed", () => {
  const { state, line } = fixture();
  const weather = createRailwayDisruption(state, { kind: "severe-weather", lineId: line.id, trackSegmentId: "ab", durationMinutes: 90, speedLimitMps: 12 });
  const signal = createRailwayDisruption(state, { kind: "signal-failure", lineId: line.id, trackSegmentId: "ab", durationMinutes: 20 });
  assert.equal(railwayDisruptionEffect(state, { lineId: line.id, trackSegmentId: "ab" }).speedLimitMps, 0);
  resolveRailwayDisruption(state, signal.id, { reason: "signal-reset" });
  assert.equal(railwayDisruptionEffect(state, { lineId: line.id, trackSegmentId: "ab" }).speedLimitMps, 12);
  assert.throws(() => resolveRailwayDisruption(state, signal.id), /already resolved/);
  assert.equal(resolveRailwayDisruption(state, weather.id).status, "resolved");
});

test("a physical vehicle failure stops only the named train", () => {
  const { state, line } = fixture();
  state.trains = [
    { id: 1, lineId: line.id, segIndex: 0, dir: 1, t: 0.2, dwell: 0 },
    { id: 2, lineId: line.id, segIndex: 0, dir: 1, t: 0.1, dwell: 0 },
  ];
  const event = createRailwayDisruption(state, { kind: "vehicle-failure", lineId: line.id, trainId: 1, durationMinutes: 20 });
  assert.deepEqual(railwayDisruptionEffect(state, { lineId: line.id, trackSegmentId: "ab", trainId: 1 }).eventIds, [event.id]);
  assert.equal(railwayDisruptionEffect(state, { lineId: line.id, trackSegmentId: "ab", trainId: 2 }).active, false);
});

test("hourly hazards are deterministic, target-order independent and use a separate saved RNG", () => {
  const left = fixture(91);
  const right = fixture(91);
  left.state.trains = [{ id: 9, lineId: left.line.id, segIndex: 0, dir: 1, t: 0.2, dwell: 0 }];
  right.state.trains = [{ id: 9, lineId: right.line.id, segIndex: 0, dir: 1, t: 0.2, dwell: 0 }];
  right.state.trackSegments.reverse();
  const leftEvents = evaluateRailwayDisruptionHour(left.state, 7, { probabilityMultiplier: 100_000 });
  const rightEvents = evaluateRailwayDisruptionHour(right.state, 7, { probabilityMultiplier: 100_000 });
  assert.deepEqual(leftEvents, rightEvents);
  assert.ok(leftEvents.some((entry) => entry.trackSegmentId));
  const restored = restoreOperationalState(JSON.parse(JSON.stringify(snapshotOperationalState(left.state))));
  assert.deepEqual(evaluateRailwayDisruptionHour(left.state, 8, { probabilityMultiplier: 100_000 }), evaluateRailwayDisruptionHour(restored, 8, { probabilityMultiplier: 100_000 }));
});

test("the report is detached and does not migrate an old state merely by reading it", () => {
  const { state, line } = fixture();
  createRailwayDisruption(state, { kind: "signal-failure", lineId: line.id, trackSegmentId: "ab", durationMinutes: 10 });
  const report = railwayDisruptionReport(state);
  report.events[0].status = "tampered";
  assert.equal(state.railwayDisruptions.events[0].status, "active");
  const oldState = structuredClone(state);
  delete oldState.railwayDisruptions;
  assert.deepEqual(railwayDisruptionReport(oldState), {
    schema: "transitline.railway-disruption-report/1", contractVersion: 1, activeCount: 0, events: [],
  });
  assert.equal(Object.hasOwn(oldState, "railwayDisruptions"), false);
  assert.equal(railwayDisruptionReport(undefined).activeCount, 0);
});

test("cross-midnight disruption exposure is recorded on the actual day, not an already-settled departure day", () => {
  const { state, line } = fixture();
  state.simMinutes = 1441;
  state.trains = [{ id: 1, lineId: line.id, segIndex: 0, dir: 1, t: 0.3, dwell: 0, trafficOperatingDay: 0 }];
  createRailwayDisruption(state, { kind: "severe-weather", lineId: line.id, trackSegmentId: "ab", durationMinutes: 30, speedLimitMps: 8 });
  stepTrains(state, 10);
  assert.equal(railwayTrafficForDays(state, line.id, 0, 1).disruptionDelaySeconds, 0);
  assert.ok(railwayTrafficForDays(state, line.id, 1, 2).disruptionDelaySeconds > 0);
});

test("invalid targets, duplicate ids and invalid closure semantics fail before changing the event collection", () => {
  const { state, line } = fixture();
  const before = structuredClone(state.railwayDisruptions);
  assert.throws(() => createRailwayDisruption(state, { kind: "signal-failure", lineId: line.id, trackSegmentId: "missing" }), /Unknown disruption track segment/);
  assert.throws(() => createRailwayDisruption(state, { kind: "severe-weather", lineId: line.id, trackSegmentId: "ab", durationMinutes: 0 }), /duration must be positive/);
  assert.throws(() => createRailwayDisruption(state, { kind: "signal-failure", lineId: line.id, trackSegmentId: "ab", speedLimitMps: 5 }), /closed.*zero speed/i);
  assert.throws(() => createRailwayDisruption(state, { kind: "severe-weather", lineId: line.id, trackSegmentId: "ab", speedLimitMps: 0 }), /open.*positive speed/i);
  assert.deepEqual(state.railwayDisruptions, before);
  const oldState = structuredClone(state);
  delete oldState.railwayDisruptions;
  assert.throws(() => createRailwayDisruption(oldState, { kind: "severe-weather", lineId: line.id, trackSegmentId: "ab", durationMinutes: 0 }), /duration must be positive/);
  assert.equal(Object.hasOwn(oldState, "railwayDisruptions"), false);
  assert.throws(() => resolveRailwayDisruption(oldState, "missing"), /Unknown railway disruption/);
  assert.equal(Object.hasOwn(oldState, "railwayDisruptions"), false);
});

test("a saved zero disruption RNG state is valid and is not replaced while advancing", () => {
  const { state } = fixture();
  state.railwayDisruptions.rngState = 0;
  state.railwayDisruptions.lastEvaluatedHour = 6;
  evaluateRailwayDisruptionHour(state, 7, { probabilityMultiplier: 0 });
  assert.notEqual(state.railwayDisruptions.rngState, 0);
});
