import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OPERATIONAL_CALENDAR_SCHEMA } from "../src/operational-calendar.mjs";
import {
  COVERAGE_REASONS, DISPATCH_SOURCES, OPERATIONAL_SERVICE_COVERAGE_REPORT_SCHEMA, buildOperationalServiceCoverageReport,
} from "../src/operational-service-coverage-report.mjs";
import { ScenarioRuntime } from "../src/scenario-runtime.mjs";
import { addLine, addPhysicalStation, addTrackSegment, createState } from "../src/state.mjs";
import { dispatchTrains } from "../src/trains.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const json = (value) => JSON.stringify(value);

function sourcePack() {
  return { manifest: { id: "coverage-report", version: "1", data: { license: "test", attribution: [] } }, demand: { model: "gravity", points: [], attractors: [] } };
}

// A real ScenarioRuntime with one real line A-B-C driven by service:a.
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
  return { runtime, state, line };
}
const calendar = (days) => ({ schema: OPERATIONAL_CALENDAR_SCHEMA, contractVersion: 1, dayTypesByOperatingDay: days });
function activate(w, dayType = "weekday") {
  const timetable = w.runtime.assessOperationalRailwayTimetable({
    infrastructureRevision: "assets:1", dayType,
    servicePlans: [{ serviceId: "service:a", firstDepartureMinute: 361, lastDepartureMinute: 371, headwayMinutes: 10, terminalResourceId: "terminal:C:1" }],
    infrastructureAssumptions: { directionMode: "double", minimumHeadwayMinutes: 3 },
  });
  w.runtime.approveRailwayTimetable(timetable.id);
  w.runtime.activateRailwayTimetable(timetable.id);
  return timetable;
}
const at = (w, day, minute = 400) => { w.state.simMinutes = day * 1440 + minute; return w.runtime.operationalServiceCoverageReport(); };
const rowOf = (report, lineId = "1") => report.lines.find((row) => row.operationalLineId === lineId && row.dispatchSource !== "no-operational-line") ?? report.lines.find((row) => row.operationalLineId === lineId);
const deepFreeze = (value) => { if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); for (const inner of value instanceof Map ? value.values() : Object.values(value)) deepFreeze(inner); } return value; };

test("weekday, weekend and an explicit holiday each name the source that applies: the entry of that day type, or frequency when there is none", () => {
  const w = world();
  const weekday = activate(w, "weekday");
  // a weekday: the weekday timetable
  let report = at(w, 1);
  assert.deepEqual([report.schema, report.contractVersion, report.currentDay, report.currentDayType, report.currentDayTypeSource], [OPERATIONAL_SERVICE_COVERAGE_REPORT_SCHEMA, 1, 1, "weekday", "default-rule"]);
  let row = rowOf(report);
  assert.deepEqual([row.dispatchSource, row.timetableId, row.timetableDayType, row.currentDayType, row.legacyFrequency], ["timetable", weekday.id, "weekday", "weekday", null]);
  assert.deepEqual(row.reasons, ["dispatch-entry-of-current-day-type"]);
  assert.equal(json(row.currentDispatchEntry), json(w.state.lines[0].timetableDispatches.weekday), "the recorded entry itself, not a summary");
  assert.deepEqual(row.dispatchEntryDayTypes, ["weekday"]);
  // a weekend with no weekend timetable: frequency, and the report says only weekday entries exist
  report = at(w, 5);
  row = rowOf(report);
  assert.deepEqual([report.currentDayType, row.dispatchSource, row.timetableId, row.timetableDayType, row.currentDispatchEntry], ["weekend", "legacy-frequency", null, null, null]);
  assert.deepEqual(row.legacyFrequency, { bandId: report.bandId, trainsPerHour: 60 });
  assert.deepEqual(row.reasons, ["dispatch-entries-only-for-other-day-types"]);
  // with a weekend timetable it is the timetable again
  const weekend = activate(w, "weekend");
  row = rowOf(at(w, 6));
  assert.deepEqual([row.dispatchSource, row.timetableId, row.timetableDayType], ["timetable", weekend.id, "weekend"]);
  assert.deepEqual(row.dispatchEntryDayTypes, ["weekday", "weekend"]);
  // an explicit holiday on a weekday, first without and then with a holiday timetable
  w.state.simMinutes = 360;
  w.runtime.setOperationalCalendar(calendar({ 7: "holiday" }));
  report = at(w, 7);
  row = rowOf(report);
  assert.deepEqual([report.currentDayType, report.currentDayTypeSource, row.dispatchSource, row.currentDispatchEntry, row.timetableId], ["holiday", "operating-calendar", "legacy-frequency", null, null]);
  assert.deepEqual(row.reasons, ["dispatch-entries-only-for-other-day-types"]);
  assert.deepEqual(at(w, 8).currentDayType, "weekday", "the next day is an ordinary weekday again");
  w.state.simMinutes = 360;
  const holiday = activate(w, "holiday");
  report = at(w, 7);
  row = rowOf(report);
  assert.deepEqual([row.dispatchSource, row.timetableId, row.timetableDayType, row.currentDayType], ["timetable", holiday.id, "holiday", "holiday"]);
  assert.deepEqual(row.dispatchEntryDayTypes, ["holiday", "weekday", "weekend"]);
  assert.deepEqual(report.counts, { rows: 1, bySource: { timetable: 1, "legacy-frequency": 0, suspended: 0, "no-operational-line": 0, unknown: 0 } });
});

test("a suspended line is reported as suspended whatever else it holds; an unrecorded flag and a plan-only line are named, not guessed", () => {
  const w = world();
  const weekday = activate(w, "weekday");
  w.line.suspended = true;
  let row = rowOf(at(w, 1));
  assert.deepEqual([row.dispatchSource, row.lineSuspended, row.reasons], ["suspended", true, ["line-suspended"]]);
  assert.equal(row.currentDispatchEntry.timetableId, weekday.id, "the held entry is still shown as a fact");
  assert.deepEqual([row.timetableId, row.legacyFrequency], [null, null], "but no dispatch source is claimed from it");
  // a plan-only drawing is created suspended
  w.line.planOnly = true;
  row = rowOf(at(w, 1));
  assert.deepEqual([row.planOnly, row.dispatchSource, row.reasons], [true, "suspended", ["plan-only-line", "line-suspended"]]);
  assert.deepEqual(row.warnings, []);
  // plan-only but not suspended: the dispatcher does not read planOnly, so the source follows its other records and the report warns
  w.line.suspended = false;
  w.state.lines[0].timetableDispatches = undefined;
  row = rowOf(at(w, 1));
  assert.deepEqual([row.planOnly, row.lineSuspended, row.dispatchSource], [true, false, "legacy-frequency"]);
  assert.deepEqual(row.warnings, ["plan-only-line-not-suspended"]);
  // a flag nobody recorded is null, and the engine's own rule (absent = not suspended) decides
  delete w.line.suspended;
  delete w.line.planOnly;
  row = rowOf(at(w, 1));
  assert.deepEqual([row.lineSuspended, row.planOnly, row.dispatchSource], [null, null, "legacy-frequency"]);
  assert.ok(row.reasons.includes("suspended-flag-unrecorded"));
  assert.equal(row.reasons.includes("plan-only-line"), false);
});

test("a line with no dispatch record, a zero frequency, a missing frequency and a blocked entry are four different facts", () => {
  const w = world();
  w.state.simMinutes = 400;
  // no record at all: frequency, and the list of entries is a declared empty list
  let row = rowOf(w.runtime.operationalServiceCoverageReport());
  assert.deepEqual([row.dispatchSource, row.currentDispatchEntry, row.dispatchEntryDayTypes, row.reasons], ["legacy-frequency", null, [], ["no-dispatch-entry-for-current-day-type"]]);
  assert.deepEqual(row.legacyFrequency.trainsPerHour, 60);
  const band = row.legacyFrequency.bandId;
  // a real 0 is a number, not "unknown"
  w.line.frequency[band] = 0;
  row = rowOf(w.runtime.operationalServiceCoverageReport());
  assert.deepEqual([row.dispatchSource, row.legacyFrequency, row.reasons], ["legacy-frequency", { bandId: band, trainsPerHour: 0 }, ["no-dispatch-entry-for-current-day-type", "frequency-is-zero-in-current-band"]]);
  // no number for the band: the source cannot be read
  delete w.line.frequency[band];
  row = rowOf(w.runtime.operationalServiceCoverageReport());
  assert.deepEqual([row.dispatchSource, row.legacyFrequency, row.reasons], ["unknown", { bandId: band, trainsPerHour: null }, ["no-dispatch-entry-for-current-day-type", "frequency-unrecorded-for-current-band"]]);
  w.line.frequency[band] = 60;
  // a blocked entry is still "timetable" (the engine does not fall back to frequency) and says so
  w.line.timetableDispatches = { weekday: { schema: "transitline.operational-timetable-application/1", dayType: "weekday", timetableId: "tt:blocked", serviceId: "service:a", departureMinutes: [], roundTrips: [], blockedReason: "Missing track between B and C", lastCheckedSimMinute: 400, missedDepartures: 0 } };
  row = rowOf(w.runtime.operationalServiceCoverageReport());
  assert.deepEqual([row.dispatchSource, row.timetableId, row.legacyFrequency, row.warnings], ["timetable", "tt:blocked", null, ["dispatch-entry-blocked"]]);
  assert.equal(row.currentDispatchEntry.missedDepartures, 0, "a recorded 0 stays 0");
  // an entry that names no timetable, or another day type, is shown with a warning instead of being repaired
  w.line.timetableDispatches = { weekday: { dayType: "weekend", departureMinutes: [361] } };
  row = rowOf(w.runtime.operationalServiceCoverageReport());
  assert.deepEqual([row.dispatchSource, row.timetableId, row.timetableDayType, row.warnings], ["timetable", null, "weekend", ["dispatch-entry-names-no-timetable", "dispatch-entry-day-type-mismatch"]]);
  // a malformed record list is not an entry
  w.line.timetableDispatches = "oops";
  row = rowOf(w.runtime.operationalServiceCoverageReport());
  assert.deepEqual([row.dispatchSource, row.dispatchEntryDayTypes], ["legacy-frequency", []]);
});

test("a management service with no operational line gets its own row as no-operational-line, and the line rows are not repeated for it", () => {
  const w = world();
  w.runtime.game.services.push({ id: "service:planned", status: "planned" });
  w.runtime.game.services.push({ id: "service:gone", status: "decommissioned", operationalLineId: 99 });
  w.runtime.game.services.push({ id: "service:old", status: "decommissioned", operationalLineId: null });
  const report = at(w, 1);
  assert.deepEqual(report.lines.map((row) => [row.operationalLineId, row.managementServiceId, row.dispatchSource]), [
    ["1", "service:a", "legacy-frequency"], ["99", "service:gone", "no-operational-line"], [null, "service:old", "no-operational-line"], [null, "service:planned", "no-operational-line"],
  ]);
  const planned = report.lines.find((row) => row.managementServiceId === "service:planned");
  assert.deepEqual([planned.serviceStatus, planned.reasons, planned.lineSuspended, planned.planOnly, planned.currentDispatchEntry, planned.legacyFrequency], ["planned", ["service-has-no-operational-line"], null, null, null, null]);
  assert.deepEqual(report.lines.find((row) => row.operationalLineId === "99").reasons, ["operational-line-missing"]);
  assert.deepEqual(report.counts, { rows: 4, bySource: { timetable: 0, "legacy-frequency": 1, suspended: 0, "no-operational-line": 3, unknown: 0 } });
});

test("the management service of a line comes from the line first; a link found the other way, a mismatch and an ambiguity are named", () => {
  const w = world();
  const first = rowOf(at(w, 1));
  assert.deepEqual([first.managementServiceId, first.managementServiceIdSource, first.serviceStatus, first.warnings], ["service:a", "line", "open", []]);
  delete w.line.managementServiceId;
  let row = rowOf(at(w, 1));
  assert.deepEqual([row.managementServiceId, row.managementServiceIdSource, row.warnings], ["service:a", "service-link", ["management-service-not-recorded-on-line", "management-service-found-through-service-link"]]);
  w.runtime.game.services.push({ id: "service:b", status: "open", operationalLineId: w.line.id });
  row = rowOf(at(w, 1));
  assert.deepEqual([row.managementServiceId, row.managementServiceIdSource, row.warnings], [null, null, ["management-service-not-recorded-on-line", "management-service-link-ambiguous"]]);
  w.line.managementServiceId = "service:b";
  w.runtime.game.services.find((service) => service.id === "service:b").operationalLineId = 42;
  row = rowOf(at(w, 1));
  assert.deepEqual([row.managementServiceId, row.warnings], ["service:b", ["management-service-link-mismatch"]]);
  w.line.managementServiceId = "service:unknown";
  row = rowOf(at(w, 1));
  assert.deepEqual([row.managementServiceId, row.serviceStatus, row.warnings], ["service:unknown", null, []], "a service the management state does not hold has no status, not an invented one");
});

test("save and load: the report after the load is the report before it, with the dispatch entry's facts intact (B17-E2) and the calendar kept", () => {
  const w = world();
  const weekday = activate(w, "weekday");
  w.runtime.setOperationalCalendar(calendar({ 3: "holiday" }));
  const holiday = activate(w, "holiday");
  for (const [day, minute] of [[0, 361], [0, 380], [1, 300], [1, 361], [1, 385], [2, 300], [2, 361], [2, 385], [3, 300], [3, 361], [3, 385]]) { w.state.simMinutes = day * 1440 + minute; dispatchTrains(w.state); }
  const before = w.runtime.operationalServiceCoverageReport();
  const row = rowOf(before);
  assert.deepEqual([before.currentDay, before.currentDayType, before.currentDayTypeSource, row.dispatchSource, row.timetableId, row.timetableDayType], [3, "holiday", "operating-calendar", "timetable", holiday.id, "holiday"]);
  assert.ok(Number.isInteger(row.currentDispatchEntry.missedDepartures) && row.currentDispatchEntry.lastCheckedSimMinute === w.state.simMinutes);
  const other = world();
  other.runtime.load(w.runtime.save());
  const after = other.runtime.operationalServiceCoverageReport();
  assert.equal(json(after), json(before));
  assert.equal(rowOf(after).currentDispatchEntry.missedDepartures, row.currentDispatchEntry.missedDepartures, "a load does not restart the entry's count");
  // the weekday on the other side of the holiday still reads the weekday entry that survived
  other.state.simMinutes = 4 * 1440 + 400;
  const next = rowOf(other.runtime.operationalServiceCoverageReport());
  assert.deepEqual([next.currentDayType, next.dispatchSource, next.timetableId], ["weekday", "timetable", weekday.id]);
});

test("a save that came back with a damaged or missing calendar still reports from what the state holds, and passes the calendar warnings on", () => {
  const w = world();
  activate(w, "weekday");
  const text = JSON.parse(w.runtime.save());
  text.operations.operationalCalendar = calendar({ 3: "holiday", 5: "bank-holiday" });
  const other = world();
  other.runtime.load(JSON.stringify(text));
  other.state.simMinutes = 3 * 1440 + 400;
  const report = other.runtime.operationalServiceCoverageReport();
  assert.deepEqual([report.currentDayType, report.currentDayTypeSource, report.warnings], ["holiday", "operating-calendar", ["operational-calendar-entry-invalid:5"]]);
  delete text.operations.operationalCalendar;
  const none = world();
  none.runtime.load(JSON.stringify(text));
  none.state.simMinutes = 3 * 1440 + 400;
  const plain = none.runtime.operationalServiceCoverageReport();
  assert.deepEqual([plain.currentDayType, plain.currentDayTypeSource], ["weekday", "default-rule"]);
});

test("the report only reads: frozen inputs work, nothing moves (state, saved text, RNG, clock), it is deterministic and shares no object with the state", () => {
  const w = world();
  activate(w, "weekday");
  w.state.simMinutes = 361;
  dispatchTrains(w.state);
  const text = w.runtime.save();
  const rng = w.state.rng.snapshot();
  const clock = w.runtime.game.clock.minute;
  const trains = json(w.state.trains);
  const first = w.runtime.operationalServiceCoverageReport();
  for (let i = 0; i < 3; i++) assert.equal(json(w.runtime.operationalServiceCoverageReport()), json(first));
  assert.equal(w.runtime.save(), text);
  assert.deepEqual(w.state.rng.snapshot(), rng);
  assert.equal(w.runtime.game.clock.minute, clock);
  assert.equal(json(w.state.trains), trains);
  assert.equal(w.state.stats.railwayTrafficByLine["1"].dispatchedTrains, 1, "no counter was created or changed");
  // frozen copies of the inputs give the same report
  const frozen = deepFreeze({ operationalState: structuredClone(w.state), services: structuredClone(w.runtime.game.services) });
  const before = json(frozen);
  assert.equal(json(buildOperationalServiceCoverageReport(frozen)), json(first));
  assert.equal(json(frozen), before);
  // the output is its own copy
  rowOf(first).currentDispatchEntry.departureMinutes.push(999);
  rowOf(first).reasons.length = 0;
  first.counts.rows = -1;
  assert.deepEqual(w.state.lines[0].timetableDispatches.weekday.departureMinutes, [361, 371]);
  assert.equal(json(w.runtime.operationalServiceCoverageReport()), json(buildOperationalServiceCoverageReport(frozen)));
  // and it does not depend on the order the inputs come in
  const shuffled = structuredClone({ operationalState: w.state, services: w.runtime.game.services });
  shuffled.services.reverse();
  shuffled.operationalState.lines.reverse();
  assert.equal(json(buildOperationalServiceCoverageReport(shuffled)), json(w.runtime.operationalServiceCoverageReport()));
});

test("missing and odd inputs give an honest report: an unknown time is null with a reason, nothing becomes 0, false or an empty row", () => {
  for (const input of [undefined, {}, { operationalState: "x", services: 5 }, { operationalState: null, services: [null, 3, {}] }]) {
    const report = buildOperationalServiceCoverageReport(input);
    assert.deepEqual([report.simMinutes, report.currentDay, report.currentDayType, report.currentDayTypeSource, report.bandId, report.lines], [null, null, null, null, null, []]);
    assert.deepEqual(report.counts, { rows: 0, bySource: { timetable: 0, "legacy-frequency": 0, suspended: 0, "no-operational-line": 0, unknown: 0 } });
  }
  const w = world();
  w.state.simMinutes = NaN;
  const row = rowOf(buildOperationalServiceCoverageReport({ operationalState: w.state, services: w.runtime.game.services }));
  assert.deepEqual([row.dispatchSource, row.currentDayType, row.currentDispatchEntry, row.legacyFrequency, row.reasons], ["unknown", null, null, null, ["day-type-unknown", "sim-minutes-unknown"]]);
  // a line that records no frequency at all cannot be read, and its unstated flags stay null
  const bare = buildOperationalServiceCoverageReport({ operationalState: { simMinutes: 400, lines: [{ id: 7, stationIds: ["a", "b"] }] }, services: [] }).lines[0];
  assert.deepEqual([bare.dispatchSource, bare.lineSuspended, bare.planOnly, bare.managementServiceId], ["unknown", null, null, null]);
});

test("the report names only sources and facts: no verdict, no counters of the B17 report, and the module reads nothing it should not", () => {
  const w = world();
  activate(w, "weekday");
  w.state.simMinutes = 361;
  dispatchTrains(w.state);
  const report = w.runtime.operationalServiceCoverageReport();
  const keys = [];
  const walk = (value, inside = false) => { if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) { if (!inside) keys.push(k); walk(v, inside || k === "currentDispatchEntry"); } };
  walk(report);
  // whole camelCase / kebab-case words, so "operationalLineId" is not mistaken for "ratio"
  const banned = new Set(["ratio", "cost", "demand", "crowding", "crowd", "capacity", "headway", "possible", "enough", "sufficient", "punctuality", "delay", "fare", "revenue", "dispatchedtrains", "completedtrains", "scheduleddispatchedtrains", "unscheduleddispatchedtrains", "ontimetrains"]);
  assert.deepEqual(keys.filter((k) => k.split(/(?=[A-Z])|-/).map((word) => word.toLowerCase()).concat(k.toLowerCase()).some((word) => banned.has(word))), []);
  assert.deepEqual(DISPATCH_SOURCES, ["timetable", "legacy-frequency", "suspended", "no-operational-line", "unknown"]);
  assert.ok(report.lines.every((row) => DISPATCH_SOURCES.includes(row.dispatchSource)));
  const every = new Set(report.lines.flatMap((row) => [...row.reasons, ...row.warnings]));
  for (const code of every) assert.ok(COVERAGE_REASONS[code], `${code} is a documented reason`);
  assert.ok(Object.isFrozen(COVERAGE_REASONS) && Object.isFrozen(DISPATCH_SOURCES));
  const src = fs.readFileSync(path.join(here, "..", "src", "operational-service-coverage-report.mjs"), "utf8");
  assert.deepEqual([...src.matchAll(/from "([^"]+)"/g)].map((m) => m[1]).sort(), ["./operational-calendar.mjs", "./state.mjs"]);
  assert.equal(/Math\.random|Date\.now|new Date|performance\.now|railwayTrafficStats|recordRailwayTraffic|startTrain|\.ledger|\.commit\(|\.settle\(|\.post\(|localStorage|node:fs|\.snapshot\(\)/.test(src.replace(/\/\/.*$/gm, "")), false);
});
