import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  RAILWAY_TIMETABLE_OPERATION_REPORT_SCHEMA, TRAFFIC_COUNTERS, buildRailwayTimetableOperationReport,
} from "../src/railway-timetable-operation-report.mjs";
import { snapshotOperationalState } from "../src/integrated-save.mjs";
import { ScenarioRuntime } from "../src/scenario-runtime.mjs";
import { addLine, addPhysicalStation, addTrackSegment, createState } from "../src/state.mjs";
import { dispatchTrains, stepTrains } from "../src/trains.mjs";

function sourcePack() {
  return { manifest: { id: "timetable-operation-report", version: "1", data: { license: "test", attribution: [] } }, demand: { model: "gravity", points: [], attractors: [] } };
}

// The same real line the timetable integration tests use: A - B - C, service:a, legacy frequency 60 trains an hour.
function world() {
  const state = createState(sourcePack());
  addPhysicalStation(state, { id: "A", location: [139, 35] });
  addPhysicalStation(state, { id: "B", location: [139.01, 35] });
  addPhysicalStation(state, { id: "C", location: [139.02, 35] });
  addTrackSegment(state, { id: "ab", fromStationId: "A", toStationId: "B", lengthMeters: 1_000 });
  addTrackSegment(state, { id: "bc", fromStationId: "C", toStationId: "B", lengthMeters: 1_200 });
  const line = addLine(state, ["A", "B", "C"], { frequency: { high: 60, medium: 60, low: 60, veryLow: 60 } });
  line.trackSegmentIds = ["bc", "ab"];
  line.managementServiceId = "service:a";
  const service = { id: "service:a", status: "open", operationalLineId: line.id, commercialSpeedKph: 30, trainsPerHour: 4, operatorId: "player" };
  const runtime = new ScenarioRuntime({ pack: sourcePack(), operationalState: state });
  runtime.game.services.push(service);
  return { state, line, service, runtime };
}
const plan = (first = 361, last = 371, headway = 10) => ({ serviceId: "service:a", firstDepartureMinute: first, lastDepartureMinute: last, headwayMinutes: headway, terminalResourceId: "terminal:C:1" });
const assess = (w, servicePlans = [plan()]) => w.runtime.assessOperationalRailwayTimetable({ infrastructureRevision: "assets:1", servicePlans, infrastructureAssumptions: { directionMode: "double", minimumHeadwayMinutes: 3 } });
function activeWorld(servicePlans) {
  const w = world();
  const timetable = assess(w, servicePlans);
  w.runtime.approveRailwayTimetable(timetable.id);
  w.runtime.activateRailwayTimetable(timetable.id);
  return { ...w, timetable };
}
const dispatchAt = (state, minute) => { state.simMinutes = minute; dispatchTrains(state); };
const report = (w) => w.runtime.railwayTimetableOperationReport();
const row = (r, id) => r.timetables.find((t) => t.timetableId === id);
const deepFreeze = (o) => { if (o && typeof o === "object") { Object.values(o).forEach(deepFreeze); Object.freeze(o); } return o; };
const keysOf = (value) => (value && typeof value === "object" ? Object.entries(value).flatMap(([k, v]) => [k, ...keysOf(v)]) : []);

test("without an operational state or a timetable report the report says what is missing and invents nothing", () => {
  const none = buildRailwayTimetableOperationReport();
  assert.equal(none.schema, RAILWAY_TIMETABLE_OPERATION_REPORT_SCHEMA);
  assert.equal(none.status, "unavailable");
  assert.deepEqual([none.timetables, none.dispatches, none.lines, none.trains, none.issues, none.simMinutes], [null, null, null, null, null, null]);
  assert.deepEqual(none.totals, { timetablesByStatus: null, dispatches: null, liveTrains: null });
  assert.equal(none.unavailable.timetables, "the-timetable-report-was-not-provided");
  assert.equal(none.unavailable.operationalState, "the-operational-state-was-not-provided");
  const w = world();
  const stateOnly = buildRailwayTimetableOperationReport({ operationalState: w.state });
  assert.equal(stateOnly.timetables, null, "not provided is not the same as none");
  assert.deepEqual(stateOnly.dispatches, []);
  assert.equal(stateOnly.unavailable.operationalState, null);
  const tablesOnly = buildRailwayTimetableOperationReport({ timetables: [] });
  assert.deepEqual(tablesOnly.timetables, []);
  assert.equal(tablesOnly.trains, null);
  assert.equal(tablesOnly.status, "none");
  assert.equal(buildRailwayTimetableOperationReport({ operationalState: w.state, timetables: [] }).status, "none");
});

test("an active timetable: its status, the engine's accepted / rejected path counts, its dispatch and the live trains it produced", () => {
  const w = activeWorld();
  dispatchAt(w.state, 361);
  dispatchAt(w.state, 371);
  const r = report(w);
  const engine = w.runtime.railwayTimetableReport(w.timetable.id)[0];
  const t = row(r, w.timetable.id);
  assert.equal(t.status, "active");
  assert.equal(t.dayType, "weekday");
  assert.equal(t.verdict, "possible");
  assert.deepEqual(t.paths, { requested: engine.requestedPaths, accepted: engine.acceptedPaths.length, rejected: engine.rejectedPaths.length });
  assert.ok(t.paths.accepted > 0);
  assert.deepEqual(t.serviceIds, ["service:a"]);
  assert.equal(t.lifecycle.activatedAtMinute, engine.activatedAtMinute);
  assert.equal(t.lifecycle.approvedAtMinute, engine.approvedAtMinute);
  assert.equal(t.lifecycle.withdrawnAtMinute, null);
  assert.equal(t.dispatchCount, 1);
  assert.deepEqual(t.dispatchLineIds, [String(w.line.id)]);
  assert.deepEqual(t.trains, { live: 2, running: 2, positionUnknown: 0, done: 0, managementServiceIds: ["service:a"], trainIds: r.trains.map((x) => x.trainId) });
  assert.deepEqual(r.dispatches[0], {
    operationalLineId: String(w.line.id), dayType: "weekday", timetableId: w.timetable.id, serviceId: "service:a", blockedReason: null, lineSuspended: false,
    scheduledDeparturesPerDay: 2, departureMinutes: [361, 371], lastCheckedSimMinute: 371, missedDepartures: 0,
  });
  assert.deepEqual(r.trains.map((x) => [x.provenance, x.timetableId, x.managementServiceId, x.scheduledDepartureMinute, x.status]),
    [["timetable", w.timetable.id, "service:a", 361, "running"], ["timetable", w.timetable.id, "service:a", 371, "running"]]);
  assert.deepEqual(r.totals.liveTrains, { total: 2, withTimetable: 2, scheduledProvenanceUnrecorded: 0, legacyFrequency: 0, running: 2, positionUnknown: 0, done: 0 });
  assert.deepEqual(r.totals.timetablesByStatus, { active: 1, approved: 0, assessed: 0, withdrawn: 0, superseded: 0, other: 0 });
  assert.deepEqual(r.issues, []);
  const lineRow = r.lines[0];
  assert.deepEqual(lineRow.trains, { live: 2, withTimetable: 2, scheduledProvenanceUnrecorded: 0, legacyFrequency: 0 });
  assert.equal(lineRow.traffic.scheduledDispatchedTrains, 2);
  assert.equal(lineRow.traffic.unscheduledDispatchedTrains, 0, "a counter the engine recorded as zero is a zero");
  assert.equal(lineRow.managementServiceId, "service:a");
});

test("all five timetable states are told apart, with their lifecycle minutes and the state they were withdrawn from", () => {
  const w = world();
  const superseded = assess(w, [plan(361, 371)]);
  w.runtime.approveRailwayTimetable(superseded.id); w.runtime.activateRailwayTimetable(superseded.id);
  const active = assess(w, [plan(381, 391)]);
  w.runtime.approveRailwayTimetable(active.id); w.runtime.activateRailwayTimetable(active.id);
  const approved = assess(w, [plan(401, 411)]);
  w.runtime.approveRailwayTimetable(approved.id);
  const assessed = assess(w, [plan(421, 431)]);
  const withdrawn = assess(w, [plan(441, 451)]);
  w.runtime.approveRailwayTimetable(withdrawn.id);
  w.runtime.withdrawRailwayTimetable(withdrawn.id);
  const r = report(w);
  assert.deepEqual(Object.fromEntries(r.timetables.map((t) => [t.timetableId, t.status])), {
    [superseded.id]: "superseded", [active.id]: "active", [approved.id]: "approved", [assessed.id]: "assessed", [withdrawn.id]: "withdrawn",
  });
  assert.deepEqual(r.totals.timetablesByStatus, { active: 1, approved: 1, assessed: 1, withdrawn: 1, superseded: 1, other: 0 });
  assert.equal(row(r, withdrawn.id).lifecycle.withdrawnFromStatus, "approved");
  assert.equal(typeof row(r, withdrawn.id).lifecycle.withdrawnAtMinute, "number");
  assert.equal(typeof row(r, superseded.id).lifecycle.supersededAtMinute, "number");
  assert.equal(row(r, assessed.id).lifecycle.approvedAtMinute, null, "a transition that has not happened is null");
  assert.equal(row(r, assessed.id).lifecycle.activatedAtMinute, null);
  assert.equal(row(r, approved.id).dispatchCount, 0);
  assert.equal(row(r, approved.id).missedDepartures, null);
  assert.equal(row(r, approved.id).missedDeparturesReason, "no-dispatch-entry-for-this-timetable");
  assert.deepEqual(r.timetables.map((t) => t.timetableId), [...r.timetables.map((t) => t.timetableId)].sort((a, b) => a.localeCompare(b, "en", { numeric: true })));
});

test("a replaced timetable keeps its running trains: the old timetable is superseded and the report says the trains differ from the line's dispatch", () => {
  const w = activeWorld();
  dispatchAt(w.state, 361);
  const second = assess(w, [plan(500, 510)]);
  w.runtime.approveRailwayTimetable(second.id); w.runtime.activateRailwayTimetable(second.id);
  const r = report(w);
  assert.equal(row(r, w.timetable.id).status, "superseded");
  assert.equal(row(r, second.id).status, "active");
  assert.equal(row(r, w.timetable.id).trains.live, 1, "the train dispatched under the old timetable is still on the line");
  assert.equal(row(r, second.id).trains.live, 0);
  assert.equal(r.dispatches.length, 1);
  assert.equal(r.dispatches[0].timetableId, second.id);
  const issue = r.issues.find((i) => i.code === "train-timetable-differs-from-line-dispatch");
  assert.deepEqual([issue.timetableId, issue.lineDispatchTimetableIds], [w.timetable.id, [second.id]]);
});

test("legacy frequency trains are reported as having no timetable, with the reason, and are not attributed to any timetable", () => {
  const w = world();
  dispatchAt(w.state, 120);
  assert.equal(w.state.trains.length, 1);
  const r = report(w);
  assert.equal(r.status, "available");
  assert.deepEqual(r.timetables, []);
  const train = r.trains[0];
  assert.equal(train.provenance, "legacy-frequency");
  assert.equal(train.timetableId, null);
  assert.equal(train.timetableIdReason, "dispatched-by-line-frequency-not-by-a-timetable");
  assert.equal(train.managementServiceId, null);
  assert.equal(train.managementServiceIdReason, "dispatched-by-line-frequency-not-by-a-timetable");
  assert.equal(train.scheduledDepartureMinute, null);
  assert.deepEqual(r.totals.liveTrains, { total: 1, withTimetable: 0, scheduledProvenanceUnrecorded: 0, legacyFrequency: 1, running: 1, positionUnknown: 0, done: 0 });
  assert.deepEqual(r.dispatches, []);
  assert.deepEqual(r.lines[0].trains, { live: 1, withTimetable: 0, scheduledProvenanceUnrecorded: 0, legacyFrequency: 1 });
  assert.equal(r.lines[0].traffic.unscheduledDispatchedTrains, 1);
  assert.deepEqual(r.issues, []);
});

test("a scheduled train from a save made before B17-E0 is reported as scheduled without provenance, not as legacy and not as the active timetable's", () => {
  const w = activeWorld();
  dispatchAt(w.state, 361);
  delete w.state.trains[0].timetableId;
  delete w.state.trains[0].managementServiceId;
  const r = report(w);
  const train = r.trains[0];
  assert.equal(train.provenance, "scheduled-provenance-unrecorded");
  assert.equal(train.timetableId, null);
  assert.match(train.timetableIdReason, /provenance-was-not-recorded/);
  assert.equal(row(r, w.timetable.id).trains.live, 0, "it is not guessed to belong to the active timetable");
  assert.ok(r.issues.some((i) => i.code === "scheduled-train-without-provenance" && i.trainId === train.trainId));
  assert.equal(r.totals.liveTrains.scheduledProvenanceUnrecorded, 1);
});

test("missed departures: a freshly applied entry has a recorded 0, an unrecorded counter is null with a reason, a recorded miss is a number, and the line counter agrees", () => {
  const w = activeWorld();
  const before = report(w);
  assert.equal(before.dispatches[0].missedDepartures, 0, "B17-E2: the engine records the 0 when it applies the timetable");
  assert.equal("missedDeparturesReason" in before.dispatches[0], false);
  assert.equal(row(before, w.timetable.id).missedDepartures, 0);
  delete w.line.timetableDispatches.weekday.missedDepartures; // a hand-made schedule or an old save: nobody recorded a count
  const unrecorded = report(w);
  assert.equal(unrecorded.dispatches[0].missedDepartures, null);
  assert.match(unrecorded.dispatches[0].missedDeparturesReason, /counter-not-created/);
  assert.equal(row(unrecorded, w.timetable.id).missedDepartures, null);
  assert.match(row(unrecorded, w.timetable.id).missedDeparturesReason, /counter-not-created/);
  w.line.timetableDispatches.weekday.missedDepartures = 0;
  assert.equal(before.lines[0].traffic, null, "no traffic recorded yet: null with a reason, not a row of zeros");
  assert.equal(before.lines[0].trafficReason, "the-engine-has-recorded-no-traffic-for-this-line");
  assert.deepEqual(before.lines[0].trains, { live: 0, withTimetable: 0, scheduledProvenanceUnrecorded: 0, legacyFrequency: 0 });
  // the clock jumps past the grace window of departures 361 and 371: both are missed and no train is made
  dispatchAt(w.state, 380);
  assert.equal(w.state.trains.length, 0);
  const r = report(w);
  assert.equal(r.dispatches[0].missedDepartures, 2);
  assert.equal("missedDeparturesReason" in r.dispatches[0], false);
  assert.equal(row(r, w.timetable.id).missedDepartures, 2);
  assert.equal(r.lines[0].traffic.missedDepartures, 2);
  assert.equal(r.lines[0].traffic.scheduledDispatchedTrains, 0);
  assert.equal(r.trains.length, 0);
  assert.equal(r.totals.liveTrains.total, 0);
});

test("a suspended line: no train is made, the missed departures the engine counted are shown, and the suspension is flagged", () => {
  const w = activeWorld();
  w.line.suspended = true;
  dispatchAt(w.state, 361);
  dispatchAt(w.state, 371);
  const r = report(w);
  assert.equal(r.trains.length, 0);
  assert.equal(r.dispatches[0].lineSuspended, true);
  assert.equal(r.dispatches[0].missedDepartures, 2);
  assert.equal(r.lines[0].suspended, true);
  assert.ok(r.issues.some((i) => i.code === "suspended-line-with-dispatch" && i.timetableId === w.timetable.id));
  assert.match(r.limits.find((l) => l.id === "missed-departures-counted-per-dispatch-entry").text, /suspended line/);
});

test("trains whose position the engine cannot place are marked position-unknown with the reason, not running; done trains are told apart", () => {
  const w = activeWorld();
  dispatchAt(w.state, 361);
  dispatchAt(w.state, 371);
  const [first, second] = w.state.trains;
  first.t = Number.NaN;
  second.segIndex = 9;
  const r = report(w);
  const a = r.trains.find((x) => x.trainId === String(first.id));
  const b = r.trains.find((x) => x.trainId === String(second.id));
  assert.equal(a.status, "position-unknown");
  assert.deepEqual(a.positionUnknownReasons, ["progress-invalid"]);
  assert.equal(a.progress, null, "an unusable value is null, not 0");
  assert.deepEqual(b.positionUnknownReasons, ["segment-index-invalid"]);
  assert.equal(b.segIndex, 9);
  assert.equal(row(r, w.timetable.id).trains.positionUnknown, 2);
  assert.equal(row(r, w.timetable.id).trains.running, 0);
  assert.ok(r.issues.some((i) => i.code === "train-position-unknown" && i.trainId === a.trainId));
  first.t = 0.5; first.dir = 0;
  second.segIndex = 0; second.done = true;
  const again = report(w);
  assert.deepEqual(again.trains.find((x) => x.trainId === String(first.id)).positionUnknownReasons, ["direction-invalid"]);
  const done = again.trains.find((x) => x.trainId === String(second.id));
  assert.equal(done.status, "done");
  assert.equal(done.positionUnknownReasons, null);
  assert.equal(again.totals.liveTrains.done, 1);
  w.state.stations.delete("B");
  first.dir = 1;
  assert.ok(report(w).trains.find((x) => x.trainId === String(first.id)).positionUnknownReasons.includes("station-missing"));
  w.state.lines.length = 0;
  assert.ok(report(w).trains.find((x) => x.trainId === String(first.id)).positionUnknownReasons.includes("line-missing"));
});

test("a train that waits is reported with the engine's own reason and hold time", () => {
  const w = activeWorld();
  dispatchAt(w.state, 361);
  w.state.trains[0].waitingForSignal = { reason: "junction-occupied" };
  w.state.trains[0].holdUntilSimMinute = 400;
  const train = report(w).trains[0];
  assert.equal(train.waitingForSignalReason, "junction-occupied");
  assert.equal(train.holdUntilSimMinute, 400);
  w.state.trains[0].waitingForSignal = {};
  assert.equal(report(w).trains[0].waitingForSignalReason, null);
});

test("how many trains a timetable has completed is not known: null with a reason, while the line counters are copied exactly as recorded", () => {
  const w = activeWorld();
  dispatchAt(w.state, 361);
  for (let step = 0; step < 40_000 && w.state.trains.length; step += 1) { w.state.simMinutes += 1 / 60; stepTrains(w.state, 1); }
  assert.equal(w.state.trains.length, 0, "the train finished and was removed");
  const r = report(w);
  const t = row(r, w.timetable.id);
  assert.equal(t.completedTrains, null);
  assert.equal(t.completedTrainsReason, "finished-trains-are-removed-and-traffic-counters-are-per-line");
  assert.equal(t.trains.live, 0);
  const recorded = w.state.stats.railwayTrafficByLine[String(w.line.id)];
  assert.equal(r.lines[0].traffic.completedTrains, 1);
  assert.deepEqual(r.lines[0].traffic, Object.fromEntries(TRAFFIC_COUNTERS.map((name) => [name, recorded[name]])));
  assert.ok(!("departureDelaySeconds" in r.lines[0].traffic), "no delay figure is restated");
  assert.ok(r.limits.some((l) => l.id === "completed-trains-not-attributable"));
});

test("facts that disagree are listed as issues: an unknown or inactive timetable behind a dispatch, a blocked dispatch, an active timetable nobody dispatches", () => {
  const w = activeWorld();
  w.line.timetableDispatches.weekend = { ...w.line.timetableDispatches.weekday, dayType: "weekend", timetableId: "railway-timetable:99" };
  w.line.timetableDispatches.holiday = { ...w.line.timetableDispatches.weekday, dayType: "holiday", blockedReason: "unmapped service" };
  const r = report(w);
  const codes = r.issues.map((i) => i.code);
  assert.ok(codes.includes("dispatch-timetable-unknown"));
  assert.ok(codes.includes("dispatch-blocked"));
  assert.equal(r.issues.find((i) => i.code === "dispatch-blocked").blockedReason, "unmapped service");
  const second = assess(w, [plan(600, 610)]);
  assert.ok(r.issues.every((i) => i.code !== "dispatch-timetable-not-active"));
  w.line.timetableDispatches.holiday.timetableId = second.id;
  assert.ok(report(w).issues.some((i) => i.code === "dispatch-timetable-not-active" && i.status === "assessed"));
  delete w.line.timetableDispatches;
  assert.ok(report(w).issues.some((i) => i.code === "active-timetable-without-dispatch" && i.timetableId === w.timetable.id));
  const noDispatch = report(w);
  assert.equal(noDispatch.dispatches.length, 0);
  assert.deepEqual(noDispatch.lines, [], "a line with nothing to say has no row");
});

test("a train whose timetable the report does not know is flagged; without a timetable report nothing is claimed about it", () => {
  const w = activeWorld();
  dispatchAt(w.state, 361);
  w.state.trains[0].timetableId = "railway-timetable:42";
  const r = report(w);
  assert.ok(r.issues.some((i) => i.code === "train-timetable-unknown" && i.timetableId === "railway-timetable:42"));
  const withoutTables = buildRailwayTimetableOperationReport({ operationalState: w.state });
  assert.ok(withoutTables.issues.every((i) => i.code !== "train-timetable-unknown" && i.code !== "dispatch-timetable-unknown"));
  assert.equal(withoutTables.trains[0].timetableId, "railway-timetable:42");
});

test("the report changes nothing: frozen inputs work, and the operational state, the game snapshot (clock, random generator, events) and the save are untouched", () => {
  const w = activeWorld();
  dispatchAt(w.state, 361);
  dispatchAt(w.state, 380);
  const snapshots = () => ({ op: JSON.stringify(snapshotOperationalState(w.state)), game: JSON.stringify(w.runtime.game.snapshot()), save: w.runtime.save(), clock: w.runtime.game.clock.minute, sim: w.state.simMinutes, rng: w.state.rngState });
  const before = snapshots();
  const { random, now } = { random: Math.random, now: Date.now };
  Math.random = () => { throw new Error("random must not be used"); };
  Date.now = () => { throw new Error("the clock must not be read"); };
  try {
    report(w);
    const frozenState = {
      simMinutes: w.state.simMinutes, stations: w.state.stations,
      lines: deepFreeze(structuredClone(w.state.lines)), trains: deepFreeze(structuredClone(w.state.trains)), stats: deepFreeze(structuredClone(w.state.stats)),
    };
    const frozen = buildRailwayTimetableOperationReport({ operationalState: Object.freeze(frozenState), timetables: deepFreeze(w.runtime.railwayTimetableReport()) });
    assert.deepEqual(frozen, report(w));
  } finally { Math.random = random; Date.now = now; }
  assert.deepEqual(snapshots(), before);
});

test("the report is deterministic, independent of the order trains and timetables are stored in, and a copy", () => {
  const w = activeWorld();
  dispatchAt(w.state, 361);
  dispatchAt(w.state, 371);
  assess(w, [plan(800, 810)]);
  const a = report(w);
  assert.deepEqual(report(w), a);
  assert.equal(JSON.stringify(report(w)), JSON.stringify(a));
  w.state.trains.reverse();
  w.runtime.game.railwayTimetables.reverse();
  assert.deepEqual(report(w), a);
  a.trains[0].status = "tampered";
  a.timetables[0].paths.accepted = -1;
  a.dispatches[0].departureMinutes.push(999);
  const b = report(w);
  assert.equal(b.trains[0].status, "running");
  assert.notEqual(b.timetables[0].paths.accepted, -1);
  assert.deepEqual(b.dispatches[0].departureMinutes, [361, 371]);
  assert.deepEqual(w.line.timetableDispatches.weekday.departureMinutes, [361, 371]);
});

test("save and load: provenance, the line's traffic counters, the withdrawn history and the dispatch entry's own missed counter are all kept", () => {
  const w = activeWorld();
  dispatchAt(w.state, 361);
  const extra = assess(w, [plan(700, 710)]);
  w.runtime.withdrawRailwayTimetable(extra.id, { reason: "unused" });
  dispatchAt(w.state, 380);
  const saved = w.runtime.save();
  const before = report(w);
  assert.equal(before.dispatches[0].missedDepartures, 1);
  const other = world();
  other.runtime.load(saved);
  const after = other.runtime.railwayTimetableOperationReport();
  assert.deepEqual(after.trains, before.trains, "the train and the provenance it carries survive");
  assert.deepEqual(after.lines, before.lines, "the line's recorded traffic survives");
  assert.equal(after.lines[0].traffic.missedDepartures, 1);
  assert.deepEqual(after.totals, before.totals);
  assert.equal(row(after, extra.id).status, "withdrawn");
  assert.equal(row(after, extra.id).lifecycle.withdrawnFromStatus, "assessed");
  assert.deepEqual(after.timetables, before.timetables);
  // B17-E2: load re-applies the active timetable but continues the entry's own counter and check time
  assert.deepEqual(after.dispatches, before.dispatches);
  assert.equal(after.dispatches[0].missedDepartures, 1);
  assert.equal(after.dispatches[0].timetableId, w.timetable.id);
  assert.match(after.limits.find((l) => l.id === "missed-departures-counted-per-dispatch-entry").text, /kept across a save and load/);
});

test("the report names no delay, cost, fare, demand, crowding or passenger figure", () => {
  const w = activeWorld();
  dispatchAt(w.state, 361);
  const names = keysOf(report(w));
  assert.ok(names.length > 50);
  assert.deepEqual(names.filter((name) => /delay|cost|fare|demand|crowd|revenue|passenger|profit/i.test(name)), []);
});

test("the runtime wrapper is the builder over the runtime's own state and timetable report", () => {
  const w = activeWorld();
  dispatchAt(w.state, 361);
  assert.deepEqual(w.runtime.railwayTimetableOperationReport(), buildRailwayTimetableOperationReport({ operationalState: w.state, timetables: w.runtime.railwayTimetableReport() }));
  assert.equal(w.runtime.railwayTimetableOperationReport().simMinutes, w.state.simMinutes);
});

test("the module keeps its promises: no clock, no random number, no import, no write to the engine's objects", () => {
  const source = fs.readFileSync(fileURLToPath(new URL("../src/railway-timetable-operation-report.mjs", import.meta.url)), "utf8").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/Math\.random|Date\.now|new Date|performance\.now|localStorage/.test(source));
  assert.deepEqual([...source.matchAll(/^import .* from "(.*)";$/gm)].map((m) => m[1]), []);
  assert.ok(!/\b(state|train|line|timetable|entry)\.[A-Za-z.]+\s*=[^=]/.test(source), "no assignment to the engine's objects");
});
