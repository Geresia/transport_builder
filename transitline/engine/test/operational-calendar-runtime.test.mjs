import test from "node:test";
import assert from "node:assert/strict";
import { OPERATIONAL_CALENDAR_SCHEMA } from "../src/operational-calendar.mjs";
import { ScenarioRuntime } from "../src/scenario-runtime.mjs";
import { addLine, addPhysicalStation, addTrackSegment, createState } from "../src/state.mjs";
import { dispatchTrains } from "../src/trains.mjs";

function sourcePack() {
  return { manifest: { id: "calendar-runtime", version: "1", data: { license: "test", attribution: [] } }, demand: { model: "gravity", points: [], attractors: [] } };
}

// A real ScenarioRuntime with one real line A-B-C (service:a); every timetable below is assessed, approved and activated through it.
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
  const runtime = new ScenarioRuntime({ pack: sourcePack(), operationalState: state });
  runtime.game.services.push({ id: "service:a", status: "open", operationalLineId: line.id, commercialSpeedKph: 30, trainsPerHour: 4, operatorId: "player" });
  return { runtime, state };
}
const calendar = (days) => ({ schema: OPERATIONAL_CALENDAR_SCHEMA, contractVersion: 1, dayTypesByOperatingDay: days });
const request = (dayType) => ({
  infrastructureRevision: "assets:1", dayType,
  servicePlans: [{ serviceId: "service:a", firstDepartureMinute: 361, lastDepartureMinute: 371, headwayMinutes: 10, terminalResourceId: "terminal:C:1" }],
  infrastructureAssumptions: { directionMode: "double", minimumHeadwayMinutes: 3 },
});
function activate(w, dayType = "weekday") {
  const timetable = w.runtime.assessOperationalRailwayTimetable(request(dayType));
  w.runtime.approveRailwayTimetable(timetable.id);
  w.runtime.activateRailwayTimetable(timetable.id);
  return timetable;
}
const go = (state, minute) => { state.simMinutes = minute; dispatchTrains(state); };
// one simulated day, walked the way the engine does: before the departures, at the first, after the grace of the second
const runDay = (state, day) => { if (day > 0) go(state, day * 1440 + 300); go(state, day * 1440 + 361); go(state, day * 1440 + 385); };
// key order is not a fact: a load re-applies the active timetables in day-type order, so compare with the keys sorted
const sorted = (value) => (value && typeof value === "object" && !Array.isArray(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])])) : Array.isArray(value) ? value.map(sorted) : value);
const entries = (state) => JSON.stringify(sorted(state.lines[0].timetableDispatches));
const stat = (state, name) => state.stats.railwayTrafficByLine["1"][name];
// the whole observable game: a rejected change must leave all of it as it was
const untouched = (w) => { const text = w.runtime.save(); const rng = w.state.rng.snapshot(); const clock = w.runtime.game.clock.minute; return () => { assert.equal(w.runtime.save(), text); assert.deepEqual(w.state.rng.snapshot(), rng); assert.equal(w.runtime.game.clock.minute, clock); }; };
function reload(w, text = w.runtime.save()) { const other = world(); other.runtime.load(text); return other; }

test("setting the calendar changes only the stored mapping and says which days changed type; assess is the same check without the change", () => {
  const w = world();
  const input = calendar({ 3: "holiday", 4: "weekday", 5: "weekend", 12: "holiday" }); // 4 and 5 already are what they would be
  const check = untouched(w);
  const preview = w.runtime.assessOperationalCalendar(input);
  assert.equal(preview.accepted, true);
  assert.deepEqual(preview.changedDays, [{ day: 3, from: "weekday", to: "holiday" }, { day: 12, from: "weekend", to: "holiday" }], "an entry equal to the default changes nothing");
  check();
  assert.equal(w.state.operationalCalendar, null);
  const result = w.runtime.setOperationalCalendar(input);
  assert.deepEqual([result.accepted, result.changedDays], [true, preview.changedDays]);
  assert.deepEqual(w.state.operationalCalendar.dayTypesByOperatingDay, { 3: "holiday", 4: "weekday", 5: "weekend", 12: "holiday" });
  assert.deepEqual(w.runtime.operationalCalendarReport(), { schema: "transitline.operational-calendar-report/1", contractVersion: 1, calendar: w.state.operationalCalendar, currentDay: 0, currentDayType: "weekday", holidayDays: [3, 12], supportsHoliday: true, activeTimetables: [], warnings: [] });
  // the state holds its own copy: neither the input nor the returned objects reach it
  input.dayTypesByOperatingDay[3] = "weekday";
  result.calendar.dayTypesByOperatingDay[3] = "weekday";
  w.runtime.operationalCalendarReport().calendar.dayTypesByOperatingDay[3] = "weekday";
  assert.equal(w.state.operationalCalendar.dayTypesByOperatingDay[3], "holiday");
  // clearing goes back to Monday-Friday / Saturday-Sunday with no holiday
  const cleared = w.runtime.setOperationalCalendar(null);
  assert.deepEqual([cleared.calendar, w.state.operationalCalendar, cleared.changedDays.map((entry) => entry.day)], [null, null, [3, 12]]);
  assert.equal(w.runtime.operationalCalendarReport().supportsHoliday, false);
});

test("an invalid calendar is rejected whole: nothing is dropped quietly and nothing moves", () => {
  const w = world();
  w.runtime.setOperationalCalendar(calendar({ 3: "holiday" }));
  const check = untouched(w);
  const before = structuredClone(w.state.operationalCalendar);
  const cases = [
    [calendar({ 3: "holiday", 5: "bank-holiday" }), ["operational-calendar-entry-invalid:5"]],
    [calendar({ 4: "holiday", "04": "holiday" }), ["operational-calendar-entry-invalid:04"]],
    [calendar({ "-1": "holiday" }), ["operational-calendar-entry-invalid:-1"]],
    [{ schema: "something-else", contractVersion: 1, dayTypesByOperatingDay: {} }, ["operational-calendar-schema-invalid"]],
    [{ schema: OPERATIONAL_CALENDAR_SCHEMA, contractVersion: 1, dayTypesByOperatingDay: [] }, ["operational-calendar-days-invalid"]],
    [{ schema: OPERATIONAL_CALENDAR_SCHEMA, contractVersion: 2, dayTypesByOperatingDay: {} }, ["operational-calendar-schema-invalid"]],
    ["holiday", ["operational-calendar-schema-invalid"]],
  ];
  for (const [input, warnings] of cases) {
    const plan = w.runtime.assessOperationalCalendar(input);
    assert.deepEqual([plan.accepted, plan.rejections], [false, [{ code: "operational-calendar-invalid", warnings }]]);
    assert.throws(() => w.runtime.setOperationalCalendar(input), (error) => /rejected: operational-calendar-invalid/.test(error.message) && error.rejections[0].warnings.join() === warnings.join());
    check();
    assert.deepEqual(w.state.operationalCalendar, before);
  }
});

test("remapping holidays leaves the active weekday and weekend timetables exactly as they were, and a remapped day simply runs another day type", () => {
  const w = world();
  const weekday = activate(w, "weekday");
  const weekend = activate(w, "weekend");
  runDay(w.state, 0); // a weekday: departure 361 dispatched, 371 missed
  assert.deepEqual([stat(w.state, "scheduledDispatchedTrains"), w.state.lines[0].timetableDispatches.weekday.missedDepartures], [1, 1]);
  const before = entries(w.state);
  const trains = JSON.stringify(w.state.trains);
  const result = w.runtime.setOperationalCalendar(calendar({ 1: "holiday" })); // tomorrow becomes a holiday
  assert.deepEqual(result.changedDays, [{ day: 1, from: "weekday", to: "holiday" }]);
  assert.deepEqual(result.activeTimetables, [weekday, weekend].map((t) => ({ timetableId: t.id, dayType: t.dayType, supportedByNewCalendar: true })).sort((a, b) => a.timetableId.localeCompare(b.timetableId)));
  assert.equal(entries(w.state), before, "no dispatch entry, count or check time moved");
  assert.equal(JSON.stringify(w.state.trains), trains);
  assert.deepEqual(w.runtime.railwayTimetableReport().map((t) => t.status), ["active", "active"]);
  // the holiday: no weekday departure is dispatched or counted (this line has no holiday timetable, so the engine falls back to frequency)
  runDay(w.state, 1);
  assert.deepEqual([stat(w.state, "scheduledDispatchedTrains"), w.state.lines[0].timetableDispatches.weekday.missedDepartures, stat(w.state, "missedDepartures")], [1, 1, 1]);
  assert.ok(stat(w.state, "unscheduledDispatchedTrains") > 0);
  // the next day is an ordinary weekday again with the same entry
  runDay(w.state, 2);
  assert.deepEqual([stat(w.state, "scheduledDispatchedTrains"), w.state.lines[0].timetableDispatches.weekday.missedDepartures], [2, 2]);
  assert.equal(w.state.lines[0].timetableDispatches.weekday.timetableId, weekday.id);
  assert.equal(w.state.lines[0].timetableDispatches.weekend.timetableId, weekend.id);
});

test("an active holiday timetable needs a holiday day: it applies once the calendar has one, survives a remap, and cannot be orphaned", () => {
  const w = world();
  activate(w, "weekday");
  const weekdayEntry = JSON.stringify(w.state.lines[0].timetableDispatches.weekday);
  const holiday = w.runtime.assessOperationalRailwayTimetable(request("holiday"));
  w.runtime.approveRailwayTimetable(holiday.id);
  const check = untouched(w);
  assert.throws(() => w.runtime.activateRailwayTimetable(holiday.id), /calendar mapping/);
  check(); // refused: rolled back whole
  w.runtime.setOperationalCalendar(calendar({ 2: "holiday" }));
  w.runtime.activateRailwayTimetable(holiday.id);
  assert.equal(w.state.lines[0].timetableDispatches.holiday.timetableId, holiday.id);
  assert.equal(JSON.stringify(w.state.lines[0].timetableDispatches.weekday), weekdayEntry, "activating the holiday timetable does not touch the weekday entry");
  const held = untouched(w);
  for (const input of [null, calendar({}), calendar({ 2: "weekday" })]) {
    const plan = w.runtime.assessOperationalCalendar(input);
    assert.deepEqual(plan.rejections, [{ code: "calendar-leaves-active-holiday-timetable-without-holiday-day", timetableIds: [holiday.id] }]);
    assert.equal(plan.activeTimetables.find((t) => t.timetableId === holiday.id).supportedByNewCalendar, false);
    assert.throws(() => w.runtime.setOperationalCalendar(input), /calendar-leaves-active-holiday-timetable-without-holiday-day/);
    held();
  }
  // moving the holiday to another day is fine; the holiday timetable then dispatches on the new day only
  const moved = w.runtime.setOperationalCalendar(calendar({ 3: "holiday" }));
  assert.deepEqual(moved.changedDays, [{ day: 2, from: "holiday", to: "weekday" }, { day: 3, from: "weekday", to: "holiday" }]);
  runDay(w.state, 1);
  runDay(w.state, 2);
  assert.equal(stat(w.state, "scheduledDispatchedTrains"), 2, "days 1 and 2 are weekdays: the weekday timetable dispatches its first departure on each");
  runDay(w.state, 3);
  assert.equal(stat(w.state, "scheduledDispatchedTrains"), 3);
  const last = w.state.trains.at(-1);
  assert.deepEqual([last.timetableId, last.managementServiceId, last.scheduledDepartureMinute], [holiday.id, "service:a", 3 * 1440 + 361], "the holiday train carries the holiday timetable's provenance");
});

test("the calendar and every dispatch entry survive a save and load; the load re-applies the timetables without losing any count", () => {
  const w = world();
  activate(w, "weekday");
  w.runtime.setOperationalCalendar(calendar({ 2: "holiday" }));
  const holiday = activate(w, "holiday");
  runDay(w.state, 0);
  runDay(w.state, 1);
  runDay(w.state, 2); // the holiday
  const before = entries(w.state);
  const restored = reload(w);
  assert.deepEqual(restored.state.operationalCalendar, w.state.operationalCalendar);
  assert.equal(entries(restored.state), before, "weekday and holiday entries, with their counts and check times");
  assert.deepEqual(restored.runtime.operationalCalendarReport(), w.runtime.operationalCalendarReport());
  assert.equal(restored.runtime.report().operationalTimetableWarnings.length, 0);
  assert.equal(restored.state.lines[0].timetableDispatches.holiday.timetableId, holiday.id);
  assert.deepEqual(restored.state.rng.snapshot(), w.state.rng.snapshot());
  assert.equal(restored.runtime.game.clock.minute, w.runtime.game.clock.minute);
  // and the restored game keeps behaving as the unbroken one: day 3 is a weekday again
  runDay(restored.state, 3);
  runDay(w.state, 3);
  assert.equal(entries(restored.state), entries(w.state));
  assert.equal(JSON.stringify(restored.state.stats.railwayTrafficByLine), JSON.stringify(w.state.stats.railwayTrafficByLine));
});

test("saves from before the calendar, or with a damaged one, load honestly: no calendar is null, damage is named, a holiday timetable is blocked", () => {
  const w = world();
  activate(w, "weekday");
  runDay(w.state, 0);
  const text = w.runtime.save();
  const variant = (change) => { const save = JSON.parse(text); change(save.operations); return JSON.stringify(save); };
  // a save from before the engine had a calendar: the key is simply absent
  const legacy = reload(w, variant((operations) => { delete operations.operationalCalendar; }));
  assert.equal(legacy.state.operationalCalendar, null);
  assert.deepEqual(legacy.runtime.operationalCalendarReport().warnings, []);
  assert.equal(entries(legacy.state), entries(w.state));
  // entries the engine would never honour are dropped from the state and named
  const damaged = reload(w, variant((operations) => { operations.operationalCalendar = calendar({ 3: "holiday", 5: "bank-holiday", "02": "weekend" }); }));
  assert.deepEqual(damaged.state.operationalCalendar.dayTypesByOperatingDay, { 3: "holiday" });
  assert.deepEqual(damaged.runtime.operationalCalendarReport().warnings, ["operational-calendar-entry-invalid:02", "operational-calendar-entry-invalid:5"]);
  assert.equal(damaged.runtime.setOperationalCalendar(calendar({ 3: "holiday" })).accepted, true);
  assert.deepEqual(damaged.runtime.operationalCalendarReport().warnings, [], "a successful change replaces the damaged record");
  // an unreadable calendar is none at all
  const wrongSchema = reload(w, variant((operations) => { operations.operationalCalendar = { schema: "x" }; }));
  assert.equal(wrongSchema.state.operationalCalendar, null);
  assert.deepEqual(wrongSchema.runtime.operationalCalendarReport().warnings, ["operational-calendar-schema-invalid"]);
  // an active holiday timetable whose calendar is gone is blocked with the facts it had, and the weekday timetable is untouched
  const h = world();
  activate(h, "weekday");
  h.runtime.setOperationalCalendar(calendar({ 2: "holiday" }));
  const holiday = activate(h, "holiday");
  const held = JSON.parse(h.runtime.save());
  delete held.operations.operationalCalendar;
  const blocked = reload(h, JSON.stringify(held));
  assert.match(blocked.state.lines[0].timetableDispatches.holiday.blockedReason, /calendar mapping/);
  assert.equal(blocked.state.lines[0].timetableDispatches.holiday.timetableId, holiday.id);
  assert.match(blocked.runtime.report().operationalTimetableWarnings[0].reason, /calendar mapping/);
  assert.equal(JSON.stringify(blocked.state.lines[0].timetableDispatches.weekday), JSON.stringify(h.state.lines[0].timetableDispatches.weekday));
  assert.equal(blocked.runtime.operationalCalendarReport().activeTimetables.find((t) => t.timetableId === holiday.id).supported, false);
});

test("a day that has begun cannot be reclassified once timetable dispatch bookkeeping exists; before that, and for later days, it can", () => {
  const bare = world(); // no timetable at all: nothing was dispatched by day type
  bare.state.simMinutes = 5 * 1440 + 100;
  assert.equal(bare.runtime.setOperationalCalendar(calendar({ 1: "holiday" })).accepted, true, "a past day is only history when nothing depends on it");
  const w = world();
  activate(w, "weekday");
  runDay(w.state, 0);
  runDay(w.state, 1);
  runDay(w.state, 2);
  const check = untouched(w);
  for (const day of [0, 1, 2]) {
    const input = calendar({ [day]: day === 1 ? "weekend" : "holiday" });
    const plan = w.runtime.assessOperationalCalendar(input);
    assert.deepEqual(plan.rejections, [{ code: "calendar-changes-started-day", days: [day], currentDay: 2 }]);
    assert.throws(() => w.runtime.setOperationalCalendar(input), /calendar-changes-started-day/);
    check();
  }
  // an entry that restates the default changes no day, so it is not a change of a started day
  assert.equal(w.runtime.setOperationalCalendar(calendar({ 1: "weekday", 3: "holiday" })).changedDays.length, 1);
  assert.deepEqual(w.runtime.operationalCalendarReport().holidayDays, [3]);
});

test("accepted changes consume no randomness and no clock, and every rejected one leaves the saved game byte-identical", () => {
  const w = world();
  activate(w, "weekday");
  runDay(w.state, 0);
  const rng = w.state.rng.snapshot();
  const clock = w.runtime.game.clock.minute;
  w.runtime.setOperationalCalendar(calendar({ 4: "holiday" }));
  w.runtime.assessOperationalCalendar(calendar({ 5: "holiday" }));
  w.runtime.operationalCalendarReport();
  w.runtime.setOperationalCalendar(calendar({ 5: "holiday", 6: "weekday" }));
  assert.deepEqual(w.state.rng.snapshot(), rng);
  assert.equal(w.runtime.game.clock.minute, clock);
  const keep = untouched(w);
  for (const bad of [calendar({ 1: "bank" }), calendar({ 0: "holiday" }), { schema: "x" }, 5, [], {}]) {
    assert.throws(() => w.runtime.setOperationalCalendar(bad), /rejected/);
    keep();
  }
});
