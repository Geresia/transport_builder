import test from "node:test";
import assert from "node:assert/strict";
import { restoreOperationalState, snapshotOperationalState } from "../src/integrated-save.mjs";
import { railwayTrafficForDays, railwayTrafficReport, signalBlockForTrain, trainSection } from "../src/railway-traffic-control.mjs";
import { addLine, addPhysicalStation, addTrackSegment, createState } from "../src/state.mjs";
import { stepTrains } from "../src/trains.mjs";

function fixture(directionMode = "double") {
  const pack = { demand: { model: "gravity", points: [], attractors: [] } };
  const state = createState(pack);
  addPhysicalStation(state, { id: "A", location: [139, 35] });
  addPhysicalStation(state, { id: "B", location: [139.01, 35] });
  addTrackSegment(state, { id: "ab", fromStationId: "A", toStationId: "B", lengthMeters: 1_000, directionMode });
  const line = addLine(state, ["A", "B"]);
  line.trackSegmentIds = ["ab"];
  return { state, line };
}

test("a physical block is shared by same-direction trains and by both directions on single track", () => {
  const { state, line } = fixture("double");
  const leader = { id: 1, lineId: line.id, segIndex: 0, dir: 1, t: 0.5, dwell: 0 };
  const follower = { id: 2, lineId: line.id, segIndex: 0, dir: 1, t: 0, dwell: 0 };
  const opposing = { id: 3, lineId: line.id, segIndex: 1, dir: -1, t: 0, dwell: 0 };
  state.trains = [leader, follower, opposing];
  assert.equal(trainSection(state, leader).resourceId, "section:ab:forward");
  assert.deepEqual(signalBlockForTrain(state, follower), { reason: "block-occupied", sectionId: "ab", resourceId: "section:ab:forward", blockingTrainId: 1 });
  assert.equal(signalBlockForTrain(state, opposing), null, "opposite double-track direction has its own block");
  state.trackSegments[0].directionMode = "single";
  assert.equal(signalBlockForTrain(state, opposing).blockingTrainId, 1);
});

test("unknown track direction is conservatively shared until an assessed control fact is applied", () => {
  const { state, line } = fixture("double");
  delete state.trackSegments[0].directionMode;
  const forward = { id: 1, lineId: line.id, segIndex: 0, dir: 1, t: 0.5, dwell: 0 };
  const reverse = { id: 2, lineId: line.id, segIndex: 1, dir: -1, t: 0, dwell: 0 };
  state.trains = [forward, reverse];
  assert.equal(signalBlockForTrain(state, reverse).blockingTrainId, 1);
  line.railwayTrafficControl = { infrastructureRevision: "x", sectionDirectionModes: { ab: "double" } };
  assert.equal(signalBlockForTrain(state, reverse), null);
});

test("a red signal holds the following train and records actual signal delay", () => {
  const { state, line } = fixture("double");
  const leader = { id: 1, lineId: line.id, segIndex: 0, dir: 1, t: 0.5, dwell: 0 };
  const follower = { id: 2, lineId: line.id, segIndex: 0, dir: 1, t: 0, dwell: 0 };
  state.trains = [leader, follower];
  stepTrains(state, 2);
  assert.equal(follower.t, 0);
  assert.equal(follower.waitingForSignal.reason, "block-occupied");
  assert.equal(follower.signalWaitSeconds, 2);
  assert.equal(state.stats.railwayTrafficByLine[String(line.id)].signalDelaySeconds, 2);
});

test("single-track entry is deterministic and an unavailable section fails closed", () => {
  const { state, line } = fixture("single");
  line.railwayTrafficControl = { infrastructureRevision: "rev:1", sectionDirectionModes: { ab: "single" } };
  const first = { id: 1, lineId: line.id, segIndex: 0, dir: 1, t: 0, dwell: 0 };
  const second = { id: 2, lineId: line.id, segIndex: 1, dir: -1, t: 0, dwell: 0 };
  state.trains = [first, second];
  stepTrains(state, 1);
  assert.ok(first.t > 0);
  assert.equal(second.t, 0);
  assert.equal(second.waitingForSignal.blockingTrainId, 1);
  state.trackSegments[0].status = "closed";
  first.t = 0;
  assert.equal(signalBlockForTrain(state, first).reason, "section-unavailable");
});

test("completed scheduled trains produce cumulative on-time facts and a detached report", () => {
  const { state, line } = fixture("double");
  state.simMinutes = 500;
  state.trains = [{ id: 1, lineId: line.id, segIndex: 1, dir: -1, t: 0.9999, dwell: 0, scheduledCompletionMinute: 499 }];
  stepTrains(state, 1);
  const stats = state.stats.railwayTrafficByLine[String(line.id)];
  assert.equal(stats.completedTrains, 1);
  assert.equal(stats.onTimeTrains, 1);
  assert.equal(stats.arrivalDelaySeconds, 60);
  const report = railwayTrafficReport(state);
  assert.equal(report[0].completionOnTimeRatio, 1);
  assert.equal(report[0].serviceDeliveryRatio, null, "a manually injected completion is not a scheduled obligation");
  report[0].completedTrains = 99;
  assert.equal(stats.completedTrains, 1);
});

test("managed lines fail closed when their physical section mapping is missing or ambiguous", () => {
  const { state, line } = fixture("double");
  line.managementServiceId = "service:a";
  line.trackSegmentIds = [];
  const train = { id: 1, lineId: line.id, segIndex: 0, dir: 1, t: 0, dwell: 0 };
  state.trains = [train];
  assert.equal(signalBlockForTrain(state, train).reason, "unmapped-section");
  line.trackSegmentIds = ["ab", "ab-parallel"];
  addTrackSegment(state, { id: "ab-parallel", fromStationId: "A", toStationId: "B", lengthMeters: 1_000, directionMode: "double" });
  assert.equal(signalBlockForTrain(state, train).reason, "ambiguous-section");
});

test("unscheduled completions do not dilute timetable punctuality", () => {
  const { state, line } = fixture("double");
  state.simMinutes = 500;
  state.trains = [{ id: 1, lineId: line.id, segIndex: 1, dir: -1, t: 0.9999, dwell: 0, trafficOperatingDay: 0 }];
  stepTrains(state, 1);
  const stats = state.stats.railwayTrafficByLine[String(line.id)];
  assert.equal(stats.completedTrains, 1);
  assert.equal(stats.scheduledCompletedTrains, 0);
  assert.equal(stats.onTimeTrains, 0);
});

test("a cross-midnight completion stays attributed to its scheduled departure day and saves cleanly", () => {
  const { state, line } = fixture("single");
  state.simMinutes = 1441;
  state.trains = [{
    id: 1, lineId: line.id, segIndex: 1, dir: -1, t: 0.9999, dwell: 0,
    trafficOperatingDay: 0, scheduledDepartureMinute: 1430, scheduledCompletionMinute: 1439,
    signalWaitSeconds: 30, waitingForSignal: { reason: "block-occupied", sectionId: "ab", blockingTrainId: 9 },
  }];
  stepTrains(state, 1);
  const dayZero = railwayTrafficForDays(state, line.id, 0, 1);
  const dayOne = railwayTrafficForDays(state, line.id, 1, 2);
  assert.equal(dayZero.completedTrains, 1);
  assert.equal(dayZero.scheduledCompletedTrains, 1);
  assert.equal(dayOne.completedTrains, 0);
  state.trains.push({ id: 2, lineId: line.id, segIndex: 0, dir: 1, t: 0, dwell: 0, trafficOperatingDay: 1, signalWaitSeconds: 12, waitingForSignal: { reason: "block-occupied", sectionId: "ab", blockingTrainId: 3 } });
  const reopened = restoreOperationalState(JSON.parse(JSON.stringify(snapshotOperationalState(state))));
  assert.deepEqual(reopened.stats.railwayTrafficByLine, state.stats.railwayTrafficByLine);
  assert.deepEqual(reopened.lines[0].trackSegmentIds, ["ab"]);
  assert.deepEqual(reopened.lines[0].railwayTrafficControl, line.railwayTrafficControl);
  assert.deepEqual(reopened.trains[0].waitingForSignal, state.trains[0].waitingForSignal);
});
