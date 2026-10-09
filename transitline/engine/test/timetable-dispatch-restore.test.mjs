import test from "node:test";
import assert from "node:assert/strict";
import { carriedDispatchFacts } from "../src/operational-timetable-integration.mjs";
import { ScenarioRuntime } from "../src/scenario-runtime.mjs";
import { addLine, addPhysicalStation, addTrackSegment, createState } from "../src/state.mjs";
import { dispatchTrains } from "../src/trains.mjs";

function sourcePack() {
  return { manifest: { id: "dispatch-restore", version: "1", data: { license: "test", attribution: [] } }, demand: { model: "gravity", points: [], attractors: [] } };
}

// Real ScenarioRuntime with one or two real lines (A-B-C as service:a, D-E-F as service:b), each timetable-driven.
function world({ lines = 1 } = {}) {
  const state = createState(sourcePack());
  const names = [["A", "B", "C", "ab", "bc", "service:a"], ["D", "E", "F", "de", "fe", "service:b"]].slice(0, lines);
  names.forEach(([a, b, c, first, second, serviceId], i) => {
    addPhysicalStation(state, { id: a, location: [139 + i * 0.1, 35] });
    addPhysicalStation(state, { id: b, location: [139.01 + i * 0.1, 35] });
    addPhysicalStation(state, { id: c, location: [139.02 + i * 0.1, 35] });
    addTrackSegment(state, { id: first, fromStationId: a, toStationId: b, lengthMeters: 1_000 });
    addTrackSegment(state, { id: second, fromStationId: c, toStationId: b, lengthMeters: 1_200 });
    const line = addLine(state, [a, b, c], { frequency: { high: 60, medium: 60, low: 60, veryLow: 60 } });
    line.trackSegmentIds = [second, first];
    line.managementServiceId = serviceId;
  });
  const runtime = new ScenarioRuntime({ pack: sourcePack(), operationalState: state });
  names.forEach(([, , , , , serviceId], i) => runtime.game.services.push({ id: serviceId, status: "open", operationalLineId: state.lines[i].id, commercialSpeedKph: 30, trainsPerHour: 4, operatorId: "player" }));
  return { runtime, state, serviceIds: names.map((entry) => entry[5]) };
}
const plan = (serviceId, terminal) => ({ serviceId, firstDepartureMinute: 361, lastDepartureMinute: 371, headwayMinutes: 10, terminalResourceId: terminal });
function activate(w, dayType = "weekday") {
  const timetable = w.runtime.assessOperationalRailwayTimetable({
    infrastructureRevision: "assets:1", dayType,
    servicePlans: w.serviceIds.map((id, i) => plan(id, `terminal:${i}`)),
    infrastructureAssumptions: { directionMode: "double", minimumHeadwayMinutes: 3 },
  });
  w.runtime.approveRailwayTimetable(timetable.id);
  w.runtime.activateRailwayTimetable(timetable.id);
  return timetable;
}
const go = (state, minute) => { state.simMinutes = minute; dispatchTrains(state); };
const entryOf = (state, index = 0, dayType = "weekday") => state.lines[index].timetableDispatches[dayType];
const canon = (value) => JSON.stringify(value, (key, inner) => (inner && typeof inner === "object" && !Array.isArray(inner) ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => a.localeCompare(b))) : inner));
const traffic = (state, index = 0) => state.stats.railwayTrafficByLine[String(state.lines[index].id)];
function reload(w, text = w.runtime.save(), lines = w.serviceIds.length) {
  const other = world({ lines });
  other.runtime.load(text);
  return other;
}
const facts = (state) => canon({ dispatches: state.lines.map((line) => line.timetableDispatches ?? null), traffic: state.stats.railwayTrafficByLine, trains: state.trains });

test("save and load keep the dispatch entry's missedDepartures and lastCheckedSimMinute, together with its provenance", () => {
  const w = world();
  const timetable = activate(w);
  assert.deepEqual([entryOf(w.state).missedDepartures, entryOf(w.state).lastCheckedSimMinute], [0, 360], "a fresh application records a real 0");
  go(w.state, 361);
  go(w.state, 380); // departure 371 is past its grace window: missed, no train
  const before = structuredClone(entryOf(w.state));
  assert.deepEqual([before.missedDepartures, before.lastCheckedSimMinute], [1, 380]);
  const restored = reload(w);
  const after = entryOf(restored.runtime.operationalState);
  assert.equal(canon(after), canon(before), "the whole entry is the same after the load re-applied the active timetable");
  assert.deepEqual([after.timetableId, after.serviceId, after.dayType, after.infrastructureRevision], [timetable.id, "service:a", "weekday", before.infrastructureRevision]);
  assert.equal(traffic(restored.runtime.operationalState).missedDepartures, 1, "the line's own counter agrees");
  assert.equal(restored.runtime.railwayTimetableOperationReport().dispatches[0].missedDepartures, 1);
  // loading consumes neither randomness nor the management clock
  assert.deepEqual(restored.runtime.operationalState.rng.snapshot(), w.state.rng.snapshot());
  assert.equal(restored.runtime.game.clock.minute, w.runtime.game.clock.minute);
});

test("right after a load nothing in the past is dispatched again or counted again", () => {
  const w = world();
  activate(w);
  go(w.state, 361);
  go(w.state, 371);
  assert.equal(w.state.trains.length, 2);
  const restored = reload(w);
  const state = restored.runtime.operationalState;
  const snapshot = facts(state);
  go(state, 371);
  assert.equal(facts(state), snapshot, "no train, no counter and no entry changed");
  go(state, 371.4);
  go(state, 372);
  assert.equal(entryOf(state).lastCheckedSimMinute, 372, "only the check time moves on");
  entryOf(state).lastCheckedSimMinute = 371;
  assert.equal(facts(state), snapshot, "and nothing else changed");
  assert.equal(state.trains.length, 2);
  assert.equal(traffic(state).scheduledDispatchedTrains, 2);
  assert.equal(entryOf(state).missedDepartures, 0);
  // a load that happens between two checks continues the same scan an unbroken run would make: departures between the saved check time and now are handled once
  const lagging = world();
  activate(lagging);
  go(lagging.state, 361);
  lagging.state.simMinutes = 380; // the clock moved but dispatchTrains has not run yet: lastCheckedSimMinute is 361
  const savedText = lagging.runtime.save();
  const unbroken = lagging.state;
  const resumed = reload(lagging, savedText).runtime.operationalState;
  go(unbroken, 380);
  go(resumed, 380);
  assert.equal(entryOf(resumed).missedDepartures, 1);
  assert.equal(facts(resumed), facts(unbroken), "load then continue equals continue");
});

test("the next departure and the next missed departure after a load are each counted exactly once", () => {
  const w = world();
  activate(w);
  go(w.state, 361);
  go(w.state, 380);
  const restored = reload(w);
  const state = restored.runtime.operationalState;
  go(state, 1440 + 300); // the next weekday: nothing is due
  assert.deepEqual([state.trains.length, entryOf(state).missedDepartures], [1, 1]);
  go(state, 1440 + 361);
  assert.deepEqual([state.trains.length, traffic(state).scheduledDispatchedTrains, entryOf(state).missedDepartures], [2, 2, 1]);
  assert.equal(state.trains[1].scheduledDepartureMinute, 1440 + 361);
  go(state, 1440 + 361);
  go(state, 1440 + 362);
  assert.equal(state.trains.length, 2, "a repeated check does not dispatch departure 361 twice");
  go(state, 1440 + 385); // departure 371 is missed
  go(state, 1440 + 385);
  go(state, 1440 + 390);
  assert.deepEqual([entryOf(state).missedDepartures, traffic(state).missedDepartures], [2, 2], "and is counted once");
  // a save in the middle of that day gives the same result as never saving
  const unbroken = world();
  activate(unbroken);
  for (const minute of [361, 380, 1440 + 300, 1440 + 361, 1440 + 385]) go(unbroken.state, minute);
  const interrupted = world();
  activate(interrupted);
  for (const minute of [361, 380, 1440 + 300]) go(interrupted.state, minute);
  const continued = reload(interrupted).runtime.operationalState;
  for (const minute of [1440 + 361, 1440 + 385]) go(continued, minute);
  assert.equal(facts(continued), facts(unbroken.state));
});

test("weekday and weekend entries keep their own counts and check times across a load", () => {
  const w = world();
  w.state.simMinutes = 5 * 1440 + 300; // a weekend day
  const weekday = activate(w, "weekday");
  const weekend = activate(w, "weekend");
  go(w.state, 5 * 1440 + 361);
  go(w.state, 5 * 1440 + 380); // the weekend departure 371 is missed
  assert.deepEqual([entryOf(w.state, 0, "weekday").missedDepartures, entryOf(w.state, 0, "weekend").missedDepartures], [0, 1]);
  const restored = reload(w);
  const state = restored.runtime.operationalState;
  assert.equal(canon(entryOf(state, 0, "weekday")), canon(entryOf(w.state, 0, "weekday")));
  assert.equal(canon(entryOf(state, 0, "weekend")), canon(entryOf(w.state, 0, "weekend")));
  assert.deepEqual([entryOf(state, 0, "weekday").timetableId, entryOf(state, 0, "weekend").timetableId], [weekday.id, weekend.id]);
  go(state, 6 * 1440 + 361);
  go(state, 6 * 1440 + 385); // weekend again
  assert.deepEqual([entryOf(state, 0, "weekday").missedDepartures, entryOf(state, 0, "weekend").missedDepartures], [0, 2]);
  go(state, 7 * 1440 + 300);
  go(state, 7 * 1440 + 361); // a weekday
  assert.equal(traffic(state).scheduledDispatchedTrains, 3);
  assert.deepEqual([entryOf(state, 0, "weekday").missedDepartures, entryOf(state, 0, "weekend").missedDepartures], [0, 2], "each day type counts only its own days");
});

test("a suspended line and several active lines: every entry keeps its own facts and a miss is still counted once", () => {
  const w = world({ lines: 2 });
  const timetable = activate(w);
  w.state.lines[1].suspended = true;
  go(w.state, 361); // line 1 dispatches; the suspended line 2 consumes the departure as missed
  go(w.state, 371);
  assert.deepEqual([entryOf(w.state, 0).missedDepartures, entryOf(w.state, 1).missedDepartures], [0, 2]);
  assert.equal(w.state.trains.length, 2);
  const restored = reload(w);
  const state = restored.runtime.operationalState;
  assert.equal(state.lines[1].suspended, true);
  for (const index of [0, 1]) assert.equal(canon(entryOf(state, index)), canon(entryOf(w.state, index)));
  assert.deepEqual(state.lines.map((line) => line.timetableDispatches.weekday.serviceId), ["service:a", "service:b"]);
  assert.ok(state.lines.every((line) => line.timetableDispatches.weekday.timetableId === timetable.id));
  go(state, 1440 + 300);
  go(state, 1440 + 361);
  assert.deepEqual([entryOf(state, 0).missedDepartures, entryOf(state, 1).missedDepartures], [0, 3]);
  assert.equal(traffic(state, 0).scheduledDispatchedTrains, 3);
  assert.equal(traffic(state, 1).missedDepartures, 3);
  state.lines[1].suspended = false;
  go(state, 1440 + 371);
  assert.equal(state.trains.filter((train) => String(train.lineId) === String(state.lines[1].id)).length, 1, "after resuming only the departure due now is dispatched, nothing is backfilled");
});

test("B17-E0 provenance survives: trains saved before the load keep it and trains dispatched after it carry it from the re-applied entry", () => {
  const w = world({ lines: 2 });
  const timetable = activate(w);
  go(w.state, 361);
  const restored = reload(w);
  const state = restored.runtime.operationalState;
  assert.deepEqual(state.trains.map((train) => [train.timetableId, train.managementServiceId]), [[timetable.id, "service:a"], [timetable.id, "service:b"]]);
  go(state, 371);
  assert.equal(state.trains.length, 4);
  assert.deepEqual(state.trains.map((train) => [train.timetableId, train.managementServiceId, train.scheduledDepartureMinute]), [
    [timetable.id, "service:a", 361], [timetable.id, "service:b", 361], [timetable.id, "service:a", 371], [timetable.id, "service:b", 371],
  ]);
  const report = restored.runtime.railwayTimetableOperationReport();
  assert.equal(report.trains.every((train) => train.provenance === "timetable"), true);
});

test("saves from before the engine kept these facts load honestly: an unrecorded count is null, never 0, and stays null", () => {
  const w = world();
  const timetable = activate(w);
  go(w.state, 361);
  go(w.state, 380);
  const text = w.runtime.save();
  const variant = (change) => { const save = JSON.parse(text); change(save.operations.lines[0].timetableDispatches.weekday, save.operations); return JSON.stringify(save); };
  // (a) no counter in the entry, as before the engine kept one
  const noCount = reload(w, variant((entry) => { delete entry.missedDepartures; })).runtime.operationalState;
  assert.equal(entryOf(noCount).missedDepartures, null);
  assert.equal(entryOf(noCount).lastCheckedSimMinute, 380, "the check time that was recorded is kept");
  assert.equal(entryOf(noCount).timetableId, timetable.id);
  assert.equal(noCount.trains.length, 1);
  go(noCount, 1440 + 300);
  go(noCount, 1440 + 361); // departure 361 of day 1 is dispatched
  go(noCount, 1440 + 385); // 371 is missed
  assert.equal(entryOf(noCount).missedDepartures, null, "it does not turn into a count that only starts at the load");
  assert.equal(traffic(noCount).missedDepartures, 2, "the line's own counter (1 before, 1 now) still sees every miss");
  // (b) a recorded count from an old save is kept as it is
  const counted = reload(w, variant((entry) => { entry.missedDepartures = 3; })).runtime.operationalState;
  assert.equal(entryOf(counted).missedDepartures, 3);
  // (c) no check time: it falls back to the load time, the same as trains.mjs does for a schedule without one, and nothing is re-scanned
  const noCheck = reload(w, variant((entry) => { delete entry.lastCheckedSimMinute; })).runtime.operationalState;
  assert.equal(entryOf(noCheck).lastCheckedSimMinute, noCheck.simMinutes);
  assert.equal(entryOf(noCheck).missedDepartures, 1);
  go(noCheck, noCheck.simMinutes);
  assert.equal(noCheck.trains.length, 1);
  // (d) nonsense counts are unrecorded, not repaired into numbers
  for (const bad of [-1, 1.5, "2", NaN, null]) {
    const odd = reload(w, variant((entry) => { entry.missedDepartures = bad; })).runtime.operationalState;
    assert.equal(entryOf(odd).missedDepartures, null, String(bad));
  }
  // (e) the application was never saved, or belongs to another timetable: a fresh application with a recorded 0
  const absent = reload(w, variant((entry, operations) => { delete operations.lines[0].timetableDispatches; })).runtime.operationalState;
  assert.deepEqual([entryOf(absent).missedDepartures, entryOf(absent).lastCheckedSimMinute], [0, absent.simMinutes]);
  const other = reload(w, variant((entry) => { entry.timetableId = "timetable:old"; entry.missedDepartures = 9; })).runtime.operationalState;
  assert.deepEqual([entryOf(other).timetableId, entryOf(other).missedDepartures], [timetable.id, 0], "another timetable's count is not inherited");
});

test("carriedDispatchFacts: the pure rule, case by case", () => {
  const key = { timetableId: "tt", serviceId: "svc", dayType: "weekday" };
  const held = { ...key, lastCheckedSimMinute: 500, missedDepartures: 4 };
  assert.deepEqual(carriedDispatchFacts(held, key, 900), { lastCheckedSimMinute: 500, missedDepartures: 4 });
  assert.deepEqual(carriedDispatchFacts({ ...held, missedDepartures: 0 }, key, 900), { lastCheckedSimMinute: 500, missedDepartures: 0 });
  assert.deepEqual(carriedDispatchFacts({ ...held, missedDepartures: undefined }, key, 900), { lastCheckedSimMinute: 500, missedDepartures: null });
  assert.deepEqual(carriedDispatchFacts({ ...held, lastCheckedSimMinute: undefined }, key, 900), { lastCheckedSimMinute: 900, missedDepartures: 4 });
  for (const previous of [undefined, null, "x", { ...held, timetableId: "other" }, { ...held, serviceId: "other" }, { ...held, dayType: "weekend" }]) {
    assert.deepEqual(carriedDispatchFacts(previous, key, 900), { lastCheckedSimMinute: 900, missedDepartures: 0 });
  }
});

test("a timetable that cannot be re-applied on load is blocked with the facts it had, not with a blank counter", () => {
  const w = world();
  const timetable = activate(w);
  go(w.state, 361);
  go(w.state, 380);
  const save = JSON.parse(w.runtime.save());
  save.operations.trackSegments[0].lengthMeters = 2_000; // the infrastructure revision no longer matches
  const restored = reload(w, JSON.stringify(save));
  const state = restored.runtime.operationalState;
  const entry = entryOf(state);
  assert.match(entry.blockedReason, /stale/);
  assert.deepEqual([entry.timetableId, entry.serviceId, entry.missedDepartures, entry.lastCheckedSimMinute], [timetable.id, "service:a", 1, 380]);
  assert.deepEqual(entry.departureMinutes, []);
  assert.equal(restored.runtime.report().operationalTimetableWarnings.length, 1);
  go(state, 1440 + 361);
  assert.equal(state.trains.length, 1, "a blocked entry dispatches nothing");
  assert.equal(entryOf(state).missedDepartures, 1);
});

test("a failed load or a failed activation changes nothing: the whole saved game, the randomness and the clock are as they were", () => {
  const w = world();
  const timetable = activate(w);
  go(w.state, 361);
  go(w.state, 380);
  const text = w.runtime.save();
  const rng = w.state.rng.snapshot();
  const clock = w.runtime.game.clock.minute;
  const unchanged = () => { assert.equal(w.runtime.save(), text); assert.deepEqual(w.state.rng.snapshot(), rng); assert.equal(w.runtime.game.clock.minute, clock); };
  assert.throws(() => w.runtime.load("not a save"));
  unchanged();
  const wrongPack = JSON.parse(text);
  wrongPack.packId = "another-pack";
  assert.throws(() => w.runtime.load(JSON.stringify(wrongPack)), /requires pack/);
  unchanged();
  const wrongVersion = JSON.parse(text);
  wrongVersion.schemaVersion = 99;
  assert.throws(() => w.runtime.load(JSON.stringify(wrongVersion)), /Unsupported/);
  unchanged();
  // a second timetable whose paths do not match the real line is refused and rolled back, the dispatch facts of the active one included
  const before = canon(entryOf(w.state));
  const wrong = w.runtime.assessRailwayTimetable({
    infrastructureRevision: "wrong:1",
    sections: [{ sectionId: "wrong", fromNodeId: "X", toNodeId: "Y", directionMode: "double", runMinutes: 2, minimumHeadwayMinutes: 3 }],
    paths: [{ pathId: "wrong:path", serviceId: "service:a", departureMinute: 400, direction: "forward", sectionIds: ["wrong"] }],
  });
  w.runtime.approveRailwayTimetable(wrong.id);
  const approvedText = w.runtime.save();
  assert.throws(() => w.runtime.activateRailwayTimetable(wrong.id));
  assert.equal(w.runtime.save(), approvedText);
  assert.equal(canon(entryOf(w.state)), before);
  assert.equal(w.runtime.railwayTimetableReport(timetable.id)[0].status, "active");
  assert.deepEqual(w.state.rng.snapshot(), rng);
  assert.equal(w.runtime.game.clock.minute, clock);
});
