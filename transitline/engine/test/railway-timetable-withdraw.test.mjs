import test from "node:test";
import assert from "node:assert/strict";
import { ManagementGame, WITHDRAWABLE_RAILWAY_TIMETABLE_STATUSES, withdrawRailwayTimetable } from "../src/management/index.mjs";
import { ScenarioRuntime } from "../src/scenario-runtime.mjs";
import { snapshotOperationalState } from "../src/integrated-save.mjs";
import { createState } from "../src/state.mjs";

const section = (sectionId, fromNodeId, toNodeId) => ({
  sectionId, fromNodeId, toNodeId, directionMode: "double", runMinutes: 4, minimumHeadwayMinutes: 3,
  capacityTrainsPerHour: 20, junctionResourceIds: [], closureWindows: [],
});
const path = (pathId, departureMinute, overrides = {}) => ({
  pathId, serviceId: "service:a", operatorId: "player", priority: 0, departureMinute,
  direction: "forward", sectionIds: ["s1"], dwellMinutesAfterSection: [0], ...overrides,
});
const input = (pathId = "path:1", minute = 60, overrides = {}) => ({ infrastructureRevision: "rev:1", sections: [section("s1", "A", "B")], paths: [path(pathId, minute)], ...overrides });
function newGame() {
  const game = new ManagementGame({ seed: 1601 });
  game.services.push({ id: "service:a", status: "open" });
  return game;
}
const approvedTimetable = (game, pathId = "path:1", minute = 60) => {
  const timetable = game.assessRailwayTimetable(input(pathId, minute));
  game.approveRailwayTimetable(timetable.id);
  return game.requireRailwayTimetable(timetable.id);
};
const statusOf = (game, id) => game.requireRailwayTimetable(id).status;
const WITHDRAW_KEYS = ["withdrawnAtMinute", "withdrawnFromStatus", "withdrawalReason"];

test("only assessed and approved timetables are withdrawable", () => {
  assert.deepEqual([...WITHDRAWABLE_RAILWAY_TIMETABLE_STATUSES], ["assessed", "approved"]);
  assert.throws(() => withdrawRailwayTimetable({ schema: "x" }), /RailwayTimetable v1/);
  assert.throws(() => withdrawRailwayTimetable(null), /RailwayTimetable v1/);
});

test("an assessed timetable is withdrawn, kept in the report with its audit fields, and recorded as an event", () => {
  const game = newGame();
  const timetable = game.assessRailwayTimetable(input());
  const result = game.withdrawRailwayTimetable(timetable.id);
  assert.equal(result.status, "withdrawn");
  assert.equal(result.withdrawnFromStatus, "assessed");
  assert.equal(result.withdrawnAtMinute, game.clock.minute);
  assert.equal("withdrawalReason" in result, false);
  const reported = game.railwayTimetableReport(timetable.id);
  assert.equal(reported.length, 1, "withdrawing never deletes");
  assert.deepEqual(reported[0], result);
  assert.equal(reported[0].acceptedPaths.length, 1, "the assessment itself is kept for the audit");
  assert.equal(game.railwayTimetables.length, 1);
  assert.ok(game.events.entries.some((entry) => entry.type === "railway-timetable-withdrawn"));
});

test("an approved timetable is withdrawn and remembers it was approved; the service is not touched", () => {
  const game = newGame();
  const timetable = approvedTimetable(game);
  const approvedAt = timetable.approvedAtMinute;
  const result = game.withdrawRailwayTimetable(timetable.id, { reason: "  replaced by a faster plan  " });
  assert.equal(result.status, "withdrawn");
  assert.equal(result.withdrawnFromStatus, "approved");
  assert.equal(result.withdrawalReason, "replaced by a faster plan");
  assert.equal(result.approvedAtMinute, approvedAt, "the approval stays in the history");
  assert.equal(game.services[0].activeTimetableId, undefined);
});

test("withdrawing twice is refused and changes nothing", () => {
  const game = newGame();
  const timetable = game.assessRailwayTimetable(input());
  game.withdrawRailwayTimetable(timetable.id);
  const before = game.snapshot();
  assert.throws(() => game.withdrawRailwayTimetable(timetable.id), /cannot be withdrawn from withdrawn/);
  assert.deepEqual(game.snapshot(), before);
});

test("an active timetable cannot be withdrawn and stays active with its service link", () => {
  const game = newGame();
  const timetable = approvedTimetable(game);
  game.activateRailwayTimetable(timetable.id);
  const before = game.snapshot();
  assert.throws(() => game.withdrawRailwayTimetable(timetable.id), /cannot be withdrawn from active/);
  assert.deepEqual(game.snapshot(), before);
  assert.equal(statusOf(game, timetable.id), "active");
  assert.equal(game.services[0].activeTimetableId, timetable.id);
});

test("a superseded timetable cannot be withdrawn either; it ends its life by being replaced", () => {
  const game = newGame();
  const first = approvedTimetable(game, "path:1", 60);
  game.activateRailwayTimetable(first.id);
  const second = approvedTimetable(game, "path:2", 90);
  game.activateRailwayTimetable(second.id);
  assert.equal(statusOf(game, first.id), "superseded");
  const before = game.snapshot();
  assert.throws(() => game.withdrawRailwayTimetable(first.id), /cannot be withdrawn from superseded/);
  assert.deepEqual(game.snapshot(), before);
});

test("a withdrawn timetable can no longer be approved or activated", () => {
  const game = newGame();
  const assessed = game.assessRailwayTimetable(input("path:1", 60));
  game.withdrawRailwayTimetable(assessed.id);
  const approvedThenWithdrawn = approvedTimetable(game, "path:2", 90);
  game.withdrawRailwayTimetable(approvedThenWithdrawn.id);
  const before = game.snapshot();
  assert.throws(() => game.approveRailwayTimetable(assessed.id), /cannot be approved from withdrawn/);
  assert.throws(() => game.activateRailwayTimetable(assessed.id), /cannot be activated from withdrawn/);
  assert.throws(() => game.approveRailwayTimetable(approvedThenWithdrawn.id), /cannot be approved from withdrawn/);
  assert.throws(() => game.activateRailwayTimetable(approvedThenWithdrawn.id), /cannot be activated from withdrawn/);
  assert.deepEqual(game.snapshot(), before);
  assert.equal(game.services[0].activeTimetableId, undefined);
});

test("activating a replacement supersedes the old active timetable, leaves withdrawn ones alone, and a withdrawn one never replaces anything", () => {
  const game = newGame();
  const first = approvedTimetable(game, "path:1", 60);
  game.activateRailwayTimetable(first.id);
  const withdrawn = approvedTimetable(game, "path:2", 90);
  game.withdrawRailwayTimetable(withdrawn.id, { reason: "not needed" });
  const withdrawnBefore = structuredClone(game.requireRailwayTimetable(withdrawn.id));
  assert.equal(statusOf(game, first.id), "active", "withdrawing another timetable does not touch the active one");
  assert.throws(() => game.activateRailwayTimetable(withdrawn.id), /withdrawn/);
  assert.equal(statusOf(game, first.id), "active");
  assert.equal(game.services[0].activeTimetableId, first.id);

  const replacement = approvedTimetable(game, "path:3", 120);
  game.activateRailwayTimetable(replacement.id);
  assert.equal(statusOf(game, first.id), "superseded");
  assert.equal(statusOf(game, replacement.id), "active");
  assert.equal(game.services[0].activeTimetableId, replacement.id);
  assert.deepEqual(game.requireRailwayTimetable(withdrawn.id), withdrawnBefore, "the withdrawn record is byte for byte what it was");
});

test("an unknown timetable and a bad reason are refused", () => {
  const game = newGame();
  const timetable = game.assessRailwayTimetable(input());
  const before = game.snapshot();
  assert.throws(() => game.withdrawRailwayTimetable("railway-timetable:99"), /Unknown railway timetable/);
  for (const reason of ["", "   ", 5, "x".repeat(201), {}]) assert.throws(() => game.withdrawRailwayTimetable(timetable.id, { reason }), /reason/);
  assert.deepEqual(game.snapshot(), before);
  assert.equal(statusOf(game, timetable.id), "assessed");
  assert.equal(game.withdrawRailwayTimetable(timetable.id, { reason: null }).status, "withdrawn", "no reason is fine");
});

test("a failure inside the transaction rolls back the state, the events, the random generator and the id sequence", () => {
  const game = newGame();
  const timetable = approvedTimetable(game);
  const before = game.snapshot();
  const events = game.events.entries.length;
  const realAssert = game.ledger.assertInvariant.bind(game.ledger);
  game.ledger.assertInvariant = () => { throw new Error("ledger broke after the transition"); };
  assert.throws(() => game.withdrawRailwayTimetable(timetable.id, { reason: "will not stick" }), /ledger broke/);
  game.ledger.assertInvariant = realAssert;
  assert.deepEqual(game.snapshot(), before, "state, rng state, events and sequences are all back");
  assert.equal(game.events.entries.length, events);
  assert.equal(statusOf(game, timetable.id), "approved");
  assert.equal("withdrawnAtMinute" in game.requireRailwayTimetable(timetable.id), false);
  const next = game.assessRailwayTimetable(input("path:next", 200));
  assert.equal(next.id, `railway-timetable:${Number(timetable.id.split(":")[1]) + 1}`, "the id sequence did not move");
  assert.equal(game.withdrawRailwayTimetable(timetable.id).status, "withdrawn", "and the same call works once the failure is gone");
});

test("a withdrawn timetable survives save and load, and its id is never handed out again", () => {
  const game = newGame();
  const gone = game.assessRailwayTimetable(input("path:1", 60));
  game.withdrawRailwayTimetable(gone.id, { reason: "audit me" });
  const kept = approvedTimetable(game, "path:2", 90);
  game.activateRailwayTimetable(kept.id);
  const restored = ManagementGame.load(game.save());
  assert.deepEqual(restored.railwayTimetableReport(), game.railwayTimetableReport());
  assert.equal(restored.requireRailwayTimetable(gone.id).status, "withdrawn");
  assert.equal(restored.requireRailwayTimetable(gone.id).withdrawalReason, "audit me");
  assert.deepEqual(restored.snapshot(), game.snapshot(), "the restored game is the same game (save() itself carries a wall-clock savedAt, so snapshots are compared)");
  assert.throws(() => restored.approveRailwayTimetable(gone.id), /withdrawn/);
  assert.throws(() => restored.withdrawRailwayTimetable(gone.id), /withdrawn/);
  const created = restored.assessRailwayTimetable(input("path:3", 150));
  assert.notEqual(created.id, gone.id);
  assert.notEqual(created.id, kept.id);
});

test("old saves keep working: timetables without any withdrawal field restore, are not given one, and can be withdrawn later", () => {
  const game = newGame();
  const assessed = game.assessRailwayTimetable(input("path:1", 60));
  const approved = approvedTimetable(game, "path:2", 90);
  const active = approvedTimetable(game, "path:3", 120);
  game.activateRailwayTimetable(active.id);
  const snapshot = game.snapshot();
  for (const timetable of snapshot.railwayTimetables) for (const key of WITHDRAW_KEYS) assert.equal(key in timetable, false, `${timetable.id} has no ${key} before any withdrawal`);
  const before = JSON.stringify(snapshot);
  const restored = new ManagementGame().restore(JSON.parse(before));
  assert.equal(JSON.stringify(restored.snapshot()), before, "restoring and saving an old save changes no byte");
  assert.equal(restored.withdrawRailwayTimetable(assessed.id).status, "withdrawn");
  assert.equal(restored.withdrawRailwayTimetable(approved.id).status, "withdrawn");
  assert.throws(() => restored.withdrawRailwayTimetable(active.id), /active/);
  const old = new ManagementGame({ seed: 5 }).snapshot();
  delete old.railwayTimetables; delete old.nextRailwayTimetableSequence;
  const noTimetables = new ManagementGame().restore(old);
  assert.deepEqual(noTimetables.railwayTimetableReport(), []);
  assert.throws(() => noTimetables.withdrawRailwayTimetable("railway-timetable:1"), /Unknown railway timetable/);
});

test("the report hands out copies: changing it cannot withdraw or revive a timetable", () => {
  const game = newGame();
  const timetable = game.assessRailwayTimetable(input());
  game.withdrawRailwayTimetable(timetable.id);
  const report = game.railwayTimetableReport(timetable.id);
  report[0].status = "approved";
  assert.equal(statusOf(game, timetable.id), "withdrawn");
});

// --- through the ScenarioRuntime ---
const PACK = { manifest: { id: "timetable-withdraw", version: "1", data: { license: "test", attribution: [] } }, demand: { model: "gravity", points: [], attractors: [] } };
function runtimeWorld() {
  const state = createState(PACK);
  const runtime = new ScenarioRuntime({ pack: PACK, operationalState: state });
  runtime.game.services.push({ id: "service:a", status: "open" });
  return { runtime, state };
}

test("ScenarioRuntime.withdrawRailwayTimetable withdraws through the game, keeps the map state untouched, and survives save and load", () => {
  const { runtime, state } = runtimeWorld();
  const first = runtime.assessRailwayTimetable(input("path:1", 60));
  const second = runtime.assessRailwayTimetable(input("path:2", 90));
  runtime.approveRailwayTimetable(second.id);
  const mapBefore = JSON.stringify(snapshotOperationalState(state));
  const result = runtime.withdrawRailwayTimetable(first.id, { reason: "unused" });
  assert.equal(result.status, "withdrawn");
  assert.equal(runtime.withdrawRailwayTimetable(second.id).withdrawnFromStatus, "approved");
  assert.equal(JSON.stringify(snapshotOperationalState(state)), mapBefore);
  assert.deepEqual(runtime.railwayTimetableReport().map((entry) => entry.status), ["withdrawn", "withdrawn"]);
  assert.deepEqual(runtime.report().railwayTimetables.map((entry) => entry.status), ["withdrawn", "withdrawn"]);
  const saved = runtime.save();
  const other = runtimeWorld().runtime;
  other.load(saved);
  assert.deepEqual(other.railwayTimetableReport(), runtime.railwayTimetableReport());
  assert.throws(() => other.approveRailwayTimetable(first.id), /withdrawn/);
});

test("a refused withdrawal through the runtime changes not one byte of the save", () => {
  const { runtime } = runtimeWorld();
  const timetable = runtime.assessRailwayTimetable(input());
  runtime.approveRailwayTimetable(timetable.id);
  runtime.game.activateRailwayTimetable(timetable.id); // the management step only: this test world has no commissioned line to apply it to
  const before = runtime.save();
  assert.throws(() => runtime.withdrawRailwayTimetable(timetable.id), /cannot be withdrawn from active/);
  assert.throws(() => runtime.withdrawRailwayTimetable("railway-timetable:77"), /Unknown railway timetable/);
  assert.equal(runtime.save(), before);
});
