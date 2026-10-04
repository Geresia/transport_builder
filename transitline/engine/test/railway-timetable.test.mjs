import test from "node:test";
import assert from "node:assert/strict";
import {
  ManagementGame,
  buildRailwayTimetable,
  expandPeriodicService,
} from "../src/management/index.mjs";

const section = (sectionId, fromNodeId, toNodeId, overrides = {}) => ({
  sectionId, fromNodeId, toNodeId, directionMode: "double", runMinutes: 4, minimumHeadwayMinutes: 3,
  capacityTrainsPerHour: 20, junctionResourceIds: [], closureWindows: [], ...overrides,
});

const path = (pathId, departureMinute, overrides = {}) => ({
  pathId, serviceId: "service:a", operatorId: "player", priority: 0, departureMinute,
  direction: "forward", sectionIds: ["s1", "s2"], dwellMinutesAfterSection: [1, 0], ...overrides,
});

function timetable(overrides = {}) {
  return buildRailwayTimetable({
    id: "timetable:test", infrastructureRevision: "infrastructure:1", dayType: "weekday",
    sections: [section("s1", "A", "B"), section("s2", "B", "C", { runMinutes: 5 })],
    paths: [path("path:1", 60)], ...overrides,
  });
}

test("a valid path receives exact section entry, exit, dwell and arrival times", () => {
  const result = timetable();
  assert.equal(result.assessment.verdict, "possible");
  assert.deepEqual(result.acceptedPaths[0].timings, [
    { sectionId: "s1", fromNodeId: "A", toNodeId: "B", entryMinute: 60, exitMinute: 64, direction: "forward" },
    { sectionId: "s2", fromNodeId: "B", toNodeId: "C", entryMinute: 65, exitMinute: 70, direction: "forward" },
  ]);
  assert.equal(result.acceptedPaths[0].arrivalMinute, 70);
});

test("same-direction trains closer than the minimum headway conflict", () => {
  const result = timetable({ paths: [path("path:1", 60), path("path:2", 62)] });
  assert.equal(result.acceptedPaths.length, 1);
  assert.equal(result.rejectedPaths[0].reason, "minimum-headway");
  assert.equal(result.rejectedPaths[0].conflictPathId, "path:1");
});

test("opposite directions can share double track but not overlapping single track", () => {
  const forward = path("path:f", 60);
  const reverse = path("path:r", 60, { direction: "reverse", sectionIds: ["s2", "s1"], serviceId: "service:b" });
  const doubleTrack = timetable({ paths: [forward, reverse] });
  assert.equal(doubleTrack.acceptedPaths.length, 2);
  const singleTrack = timetable({
    sections: [section("s1", "A", "B", { directionMode: "single", runMinutes: 10 })],
    paths: [path("path:f", 60, { sectionIds: ["s1"] }), path("path:r", 65, { direction: "reverse", sectionIds: ["s1"], serviceId: "service:b" })],
  });
  assert.equal(singleTrack.rejectedPaths[0].reason, "single-track-conflict");
});

test("closures and hourly section capacity reject paths with distinct reasons", () => {
  const closed = timetable({
    sections: [section("s1", "A", "B", { closureWindows: [{ startMinute: 59, endMinute: 70, reason: "night-work" }] })],
    paths: [path("path:closed", 60, { sectionIds: ["s1"] })],
  });
  assert.equal(closed.rejectedPaths[0].reason, "section-closed");
  assert.equal(closed.rejectedPaths[0].detail, "night-work");
  const capped = timetable({
    sections: [section("s1", "A", "B", { capacityTrainsPerHour: 1, minimumHeadwayMinutes: 1 })],
    paths: [path("path:1", 60, { sectionIds: ["s1"] }), path("path:2", 70, { sectionIds: ["s1"] })],
  });
  assert.equal(capped.rejectedPaths[0].reason, "hourly-capacity");
});

test("different tracks still conflict at a shared junction resource", () => {
  const result = timetable({
    sections: [
      section("west", "A", "X", { runMinutes: 5, junctionResourceIds: ["junction:X"], junctionClearanceMinutes: 2 }),
      section("east", "C", "X", { runMinutes: 5, junctionResourceIds: ["junction:X"], junctionClearanceMinutes: 2 }),
    ],
    paths: [path("path:west", 60, { sectionIds: ["west"] }), path("path:east", 61, { sectionIds: ["east"], serviceId: "service:b" })],
  });
  assert.equal(result.acceptedPaths.length, 1);
  assert.equal(result.rejectedPaths[0].reason, "junction-conflict");
  assert.equal(result.rejectedPaths[0].detail, "junction:X");
});

test("terminal platform turnback occupancy blocks a second arriving train", () => {
  const result = timetable({
    sections: [section("west", "A", "T"), section("east", "B", "T")],
    paths: [
      path("path:west", 60, { sectionIds: ["west"], terminalTurnback: { resourceId: "terminal:T:1", durationMinutes: 10 } }),
      path("path:east", 65, { sectionIds: ["east"], serviceId: "service:b", terminalTurnback: { resourceId: "terminal:T:1", durationMinutes: 10 } }),
    ],
  });
  assert.equal(result.rejectedPaths[0].reason, "turnback-conflict");
});

test("priority decides scarce slots deterministically, independent of input order", () => {
  const low = path("path:low", 60, { priority: 1 });
  const high = path("path:high", 61, { priority: 10, serviceId: "service:express" });
  const first = timetable({ paths: [low, high] });
  const second = timetable({ paths: [high, low], sections: [section("s2", "B", "C", { runMinutes: 5 }), section("s1", "A", "B")] });
  assert.equal(first.acceptedPaths[0].pathId, "path:high");
  assert.deepEqual(first, second);
});

test("periodic service expansion creates stable departures without crossing midnight", () => {
  const paths = expandPeriodicService({ pathKey: "local", serviceId: "service:a", sectionIds: ["s1"], firstDepartureMinute: 300, lastDepartureMinute: 330, headwayMinutes: 10 });
  assert.deepEqual(paths.map((entry) => [entry.pathId, entry.departureMinute]), [["local:1", 300], ["local:2", 310], ["local:3", 320], ["local:4", 330]]);
  assert.throws(() => expandPeriodicService({ pathKey: "x", serviceId: "s", sectionIds: ["s1"], firstDepartureMinute: 1300, lastDepartureMinute: 60, headwayMinutes: 10 }), /cannot wrap/);
});

test("missing sections, disconnected routes and end-of-day overflow are explicit rejections", () => {
  const missing = timetable({ paths: [path("path:missing", 60, { sectionIds: ["missing"] })] });
  assert.equal(missing.rejectedPaths[0].detail, "section:missing:not-found");
  const disconnected = timetable({ sections: [section("s1", "A", "B"), section("s2", "C", "D")], paths: [path("path:bad", 60)] });
  assert.match(disconnected.rejectedPaths[0].detail, /route-disconnected/);
  const overflow = timetable({ sections: [section("s1", "A", "B", { runMinutes: 10 })], paths: [path("path:late", 1435, { sectionIds: ["s1"] })] });
  assert.match(overflow.rejectedPaths[0].detail, /outside-operating-day/);
});

test("empty demand is unknown and partial allocation is conditional unless the threshold permits it", () => {
  assert.equal(timetable({ paths: [] }).assessment.verdict, "unknown");
  const partial = timetable({ paths: [path("path:1", 60), path("path:2", 62)] });
  assert.equal(partial.assessment.verdict, "conditional");
  const acceptedThreshold = timetable({ paths: [path("path:1", 60), path("path:2", 62)], minimumAcceptanceRatio: 0.5 });
  assert.equal(acceptedThreshold.assessment.verdict, "possible");
});

test("invalid global schemas and values fail at the boundary", () => {
  assert.throws(() => timetable({ id: "" }), /requires an id/);
  assert.throws(() => timetable({ dayType: "snowday" }), /Invalid/);
  assert.throws(() => timetable({ sections: [section("s1", "A", "B"), section("s1", "A", "C")] }), /Duplicate/);
  assert.throws(() => timetable({ paths: [path("same", 60), path("same", 80)] }), /Duplicate/);
  assert.throws(() => timetable({ sections: [section("s1", "A", "B", { runMinutes: 0 })] }), /positive/);
  assert.throws(() => timetable({ sections: [section("s1", "A", "B", { capacityTrainsPerHour: 0.5 })] }), /positive integer/);
});

test("ManagementGame assesses, approves, activates, supersedes and saves timetables atomically", () => {
  const game = new ManagementGame({ seed: 1301 });
  game.services.push({ id: "service:a", status: "open" });
  const first = game.assessRailwayTimetable({ infrastructureRevision: "rev:1", sections: [section("s1", "A", "B")], paths: [path("path:1", 60, { sectionIds: ["s1"] })] });
  game.approveRailwayTimetable(first.id);
  game.activateRailwayTimetable(first.id);
  assert.equal(game.services[0].activeTimetableId, first.id);
  const second = game.assessRailwayTimetable({ infrastructureRevision: "rev:1", sections: [section("s1", "A", "B")], paths: [path("path:2", 90, { sectionIds: ["s1"] })] });
  game.approveRailwayTimetable(second.id);
  game.activateRailwayTimetable(second.id);
  assert.equal(game.requireRailwayTimetable(first.id).status, "superseded");
  assert.equal(game.services[0].activeTimetableId, second.id);
  const restored = ManagementGame.load(game.save());
  assert.deepEqual(restored.railwayTimetableReport(), game.railwayTimetableReport());
  assert.equal(restored.services[0].activeTimetableId, second.id);
});

test("conditional approval and unknown service activation roll back all state", () => {
  const game = new ManagementGame({ seed: 1302 });
  const partial = game.assessRailwayTimetable({ infrastructureRevision: "rev:1", sections: [section("s1", "A", "B")], paths: [path("path:1", 60, { sectionIds: ["s1"] }), path("path:2", 61, { sectionIds: ["s1"] })] });
  const beforeApproval = game.snapshot();
  assert.throws(() => game.approveRailwayTimetable(partial.id), /conditional/);
  assert.deepEqual(game.snapshot(), beforeApproval);
  const possible = game.assessRailwayTimetable({ infrastructureRevision: "rev:1", sections: [section("s1", "A", "B")], paths: [path("path:unknown", 90, { sectionIds: ["s1"], serviceId: "service:unknown" })] });
  game.approveRailwayTimetable(possible.id);
  const beforeActivation = game.snapshot();
  assert.throws(() => game.activateRailwayTimetable(possible.id), /Unknown timetable service/);
  assert.deepEqual(game.snapshot(), beforeActivation);
});

test("old saves restore an empty timetable collection and monotonic id allocator", () => {
  const game = new ManagementGame({ seed: 1303 });
  const snapshot = game.snapshot();
  delete snapshot.railwayTimetables;
  delete snapshot.nextRailwayTimetableSequence;
  const restored = new ManagementGame().restore(snapshot);
  assert.deepEqual(restored.railwayTimetables, []);
  assert.equal(restored.nextRailwayTimetableSequence, 1);
});

test("superseding a day type clears stale service timetable links", () => {
  const game = new ManagementGame({ seed: 1304 });
  game.services.push({ id: "service:a", status: "open" }, { id: "service:b", status: "open" });
  const first = game.assessRailwayTimetable({ infrastructureRevision: "rev:1", sections: [section("s1", "A", "B")], paths: [
    path("path:a", 60, { sectionIds: ["s1"], serviceId: "service:a" }),
    path("path:b", 70, { sectionIds: ["s1"], serviceId: "service:b" }),
  ] });
  game.approveRailwayTimetable(first.id);
  game.activateRailwayTimetable(first.id);
  const second = game.assessRailwayTimetable({ infrastructureRevision: "rev:1", sections: [section("s1", "A", "B")], paths: [path("path:a2", 90, { sectionIds: ["s1"], serviceId: "service:a" })] });
  game.approveRailwayTimetable(second.id);
  game.activateRailwayTimetable(second.id);
  assert.equal(game.services[0].activeTimetableId, second.id);
  assert.equal(game.services[1].activeTimetableId, undefined);
});
