// B17-E1: a read-only report of how railway timetables are actually being operated.  It only gathers facts the engine already holds:
//   - each timetable's status and its accepted / rejected path counts           (management railway timetable report)
//   - each line's applied timetable dispatches: scheduled departures, missed departures, blocked reason   (line.timetableDispatches)
//   - the trains running now with the timetableId / managementServiceId they were dispatched under      (train provenance, B17-E0)
//   - the per-line traffic counters the engine already recorded                                          (state.stats.railwayTrafficByLine)
// It makes no dispatch rule, no train, no timetable verdict, no delay, cost, demand or crowding figure; it reads no clock and no random
// number and changes nothing.  What the engine does not know stays `null` with a reason next to it — never 0, false or [] in its place.
// In particular: finished trains are removed from `state.trains` when they finish and the traffic counters are per line, so how many
// trains a given timetable has completed is not known (`completedTrains: null`).
export const RAILWAY_TIMETABLE_OPERATION_REPORT_SCHEMA = "transitline.railway-timetable-operation-report/1";
export const TIMETABLE_STATUSES = Object.freeze(["active", "approved", "assessed", "withdrawn", "superseded"]);
// The counters copied from the engine's per-line traffic record.  Delay sums and ratios are left out on purpose: the report does not
// compute or restate delays.
export const TRAFFIC_COUNTERS = Object.freeze(["dispatchedTrains", "completedTrains", "scheduledDispatchedTrains", "unscheduledDispatchedTrains", "scheduledCompletedTrains", "onTimeTrains", "missedDepartures", "lateCompletedTrains"]);

const COMPLETED_REASON = "finished-trains-are-removed-and-traffic-counters-are-per-line";
const MISSED_REASON = "counter-not-created: no count was recorded for this dispatch entry (a hand-made schedule, or a save from before the engine kept it), so its absence is not recorded as zero";

const listOf = (value) => (Array.isArray(value) ? value : []);
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value) => (typeof value === "string" && value !== "" ? value : null);
const finite = (value) => (Number.isFinite(value) ? value : null);
const key = (value) => (value === null || value === undefined ? null : String(value));
const cmp = (a, b) => String(a).localeCompare(String(b), "en", { numeric: true });
const clone = (value) => structuredClone(value);
const sortedUnique = (values) => [...new Set(values)].sort(cmp);

function dispatchRows(state) {
  const rows = [];
  for (const line of listOf(state.lines)) {
    const dispatches = isObject(line?.timetableDispatches) ? line.timetableDispatches : {};
    for (const dayKey of Object.keys(dispatches).sort(cmp)) {
      const entry = dispatches[dayKey];
      if (!isObject(entry)) continue;
      const trips = Array.isArray(entry.roundTrips) ? entry.roundTrips : Array.isArray(entry.departureMinutes) ? entry.departureMinutes : null;
      rows.push({
        operationalLineId: String(line.id), dayType: text(entry.dayType) ?? dayKey, timetableId: text(entry.timetableId), serviceId: text(entry.serviceId),
        blockedReason: text(entry.blockedReason),
        lineSuspended: typeof line.suspended === "boolean" ? line.suspended : null,
        scheduledDeparturesPerDay: trips === null ? null : trips.length,
        departureMinutes: Array.isArray(entry.departureMinutes) ? entry.departureMinutes.filter(Number.isFinite) : null,
        lastCheckedSimMinute: finite(entry.lastCheckedSimMinute),
        missedDepartures: finite(entry.missedDepartures),
        ...(finite(entry.missedDepartures) === null ? { missedDeparturesReason: MISSED_REASON } : {}),
        ...(trips === null ? { scheduledDeparturesReason: "no-departure-list-in-the-applied-schedule" } : {}),
        ...(text(entry.timetableId) === null ? { timetableIdReason: "dispatch-entry-carries-no-timetable-id" } : {}),
      });
    }
  }
  return rows.sort((a, b) => cmp(a.operationalLineId, b.operationalLineId) || cmp(a.dayType, b.dayType));
}

// "Where is this train": only what its own fields and the station table say.  No position is computed.
function positionState(train, line, stations) {
  if (train.done === true) return { status: "done", reasons: null };
  const reasons = [];
  if (!line) reasons.push("line-missing");
  const ids = Array.isArray(train.serviceStationIds) ? train.serviceStationIds.map(String) : null;
  if (ids === null) reasons.push("service-stations-missing");
  if (!Number.isInteger(train.segIndex) || (ids !== null && (train.segIndex < 0 || train.segIndex >= ids.length))) reasons.push("segment-index-invalid");
  if (train.dir !== 1 && train.dir !== -1) reasons.push("direction-invalid");
  if (!Number.isFinite(train.t) || train.t < 0 || train.t > 1) reasons.push("progress-invalid");
  if (ids !== null && Number.isInteger(train.segIndex) && !reasons.includes("segment-index-invalid")) {
    const here = ids[train.segIndex];
    const next = ids[train.segIndex + (train.dir === -1 ? -1 : 1)];
    if (!stations.has(here) || (next !== undefined && !stations.has(next))) reasons.push("station-missing");
  }
  return reasons.length ? { status: "position-unknown", reasons } : { status: "running", reasons: null };
}

function trainRows(state, lineById, stations) {
  return listOf(state.trains).filter(isObject).map((train) => {
    const timetableId = text(train.timetableId);
    const scheduled = finite(train.scheduledDepartureMinute) !== null;
    const provenance = timetableId !== null ? "timetable" : scheduled ? "scheduled-provenance-unrecorded" : "legacy-frequency";
    const position = positionState(train, lineById.get(String(train.lineId)) ?? null, stations);
    return {
      trainId: key(train.id), operationalLineId: key(train.lineId), provenance,
      timetableId,
      ...(timetableId === null ? { timetableIdReason: provenance === "legacy-frequency" ? "dispatched-by-line-frequency-not-by-a-timetable" : "dispatched-against-a-schedule-but-the-provenance-was-not-recorded (saved before B17-E0)" } : {}),
      managementServiceId: text(train.managementServiceId),
      ...(text(train.managementServiceId) === null ? { managementServiceIdReason: provenance === "legacy-frequency" ? "dispatched-by-line-frequency-not-by-a-timetable" : "not-recorded" } : {}),
      scheduledDepartureMinute: finite(train.scheduledDepartureMinute), scheduledCompletionMinute: finite(train.scheduledCompletionMinute),
      status: position.status, positionUnknownReasons: position.reasons,
      segIndex: Number.isInteger(train.segIndex) ? train.segIndex : null, direction: train.dir === 1 || train.dir === -1 ? train.dir : null, progress: finite(train.t),
      waitingForSignalReason: text(train.waitingForSignal?.reason), holdUntilSimMinute: finite(train.holdUntilSimMinute),
    };
  }).sort((a, b) => cmp(a.trainId, b.trainId));
}

function timetableRows(timetables, dispatches, trains) {
  return timetables.filter(isObject).map((timetable) => {
    const id = text(timetable.id);
    const mine = dispatches.filter((d) => d.timetableId !== null && d.timetableId === id);
    const live = trains.filter((t) => t.timetableId !== null && t.timetableId === id);
    const facts = isObject(timetable.operationalFacts) ? timetable.operationalFacts : null;
    const count = (value) => (Array.isArray(value) ? value.length : null);
    return {
      timetableId: id, status: text(timetable.status), dayType: text(timetable.dayType), verdict: text(timetable.assessment?.verdict),
      infrastructureRevision: text(timetable.infrastructureRevision),
      paths: { requested: finite(timetable.requestedPaths), accepted: count(timetable.acceptedPaths), rejected: count(timetable.rejectedPaths) },
      serviceIds: facts !== null && Array.isArray(facts.serviceIds) ? sortedUnique(facts.serviceIds.map(String)) : null,
      ...(facts === null || !Array.isArray(facts.serviceIds) ? { serviceIdsReason: "the-timetable-carries-no-operational-facts" } : {}),
      lifecycle: {
        createdAtMinute: finite(timetable.createdAtMinute), approvedAtMinute: finite(timetable.approvedAtMinute), activatedAtMinute: finite(timetable.activatedAtMinute),
        supersededAtMinute: finite(timetable.supersededAtMinute), withdrawnAtMinute: finite(timetable.withdrawnAtMinute), withdrawnFromStatus: text(timetable.withdrawnFromStatus),
      },
      lifecycleNote: "null = that transition has not happened or was not recorded",
      dispatchCount: mine.length, dispatchLineIds: sortedUnique(mine.map((d) => d.operationalLineId)),
      missedDepartures: mine.length === 0 || mine.some((d) => d.missedDepartures === null) ? null : mine.reduce((sum, d) => sum + d.missedDepartures, 0),
      ...(mine.length === 0 ? { missedDeparturesReason: "no-dispatch-entry-for-this-timetable" } : mine.some((d) => d.missedDepartures === null) ? { missedDeparturesReason: MISSED_REASON } : {}),
      trains: {
        live: live.length, running: live.filter((t) => t.status === "running").length, positionUnknown: live.filter((t) => t.status === "position-unknown").length, done: live.filter((t) => t.status === "done").length,
        managementServiceIds: sortedUnique(live.map((t) => t.managementServiceId).filter(Boolean)), trainIds: live.map((t) => t.trainId),
      },
      completedTrains: null, completedTrainsReason: COMPLETED_REASON,
    };
  }).sort((a, b) => cmp(a.timetableId ?? "", b.timetableId ?? ""));
}

function lineRows(state, dispatches, trains) {
  const traffic = isObject(state.stats?.railwayTrafficByLine) ? state.stats.railwayTrafficByLine : {};
  return listOf(state.lines).filter(isObject).map((line) => {
    const id = String(line.id);
    const mineDispatch = dispatches.filter((d) => d.operationalLineId === id);
    const mineTrains = trains.filter((t) => t.operationalLineId === id);
    const recorded = isObject(traffic[id]) ? traffic[id] : null;
    if (!mineDispatch.length && !mineTrains.length && recorded === null) return null;
    return {
      operationalLineId: id, name: text(line.name), managementServiceId: text(line.managementServiceId),
      ...(text(line.managementServiceId) === null ? { managementServiceIdReason: "the-line-carries-no-management-service-id" } : {}),
      suspended: typeof line.suspended === "boolean" ? line.suspended : null,
      dispatchDayTypes: sortedUnique(mineDispatch.map((d) => d.dayType)),
      traffic: recorded === null ? null : Object.fromEntries(TRAFFIC_COUNTERS.map((name) => [name, finite(recorded[name])])),
      ...(recorded === null ? { trafficReason: "the-engine-has-recorded-no-traffic-for-this-line" } : {}),
      trains: {
        live: mineTrains.length, withTimetable: mineTrains.filter((t) => t.provenance === "timetable").length,
        scheduledProvenanceUnrecorded: mineTrains.filter((t) => t.provenance === "scheduled-provenance-unrecorded").length,
        legacyFrequency: mineTrains.filter((t) => t.provenance === "legacy-frequency").length,
      },
    };
  }).filter(Boolean).sort((a, b) => cmp(a.operationalLineId, b.operationalLineId));
}

// Cross-references between facts that disagree.  They state a disagreement; they do not decide who is right.
function issuesOf({ timetables, dispatches, trains, timetablesKnown }) {
  const issues = [];
  const byId = new Map(timetables.map((t) => [t.timetableId, t]));
  for (const d of dispatches) {
    const where = { operationalLineId: d.operationalLineId, dayType: d.dayType, timetableId: d.timetableId };
    if (d.timetableId !== null && timetablesKnown) {
      const table = byId.get(d.timetableId);
      if (!table) issues.push({ code: "dispatch-timetable-unknown", ...where });
      else if (table.status !== "active") issues.push({ code: "dispatch-timetable-not-active", ...where, status: table.status });
    }
    if (d.blockedReason !== null) issues.push({ code: "dispatch-blocked", ...where, blockedReason: d.blockedReason });
    if (d.lineSuspended === true) issues.push({ code: "suspended-line-with-dispatch", ...where });
  }
  if (timetablesKnown) {
    for (const t of timetables) if (t.status === "active" && t.dispatchCount === 0) issues.push({ code: "active-timetable-without-dispatch", timetableId: t.timetableId });
  }
  const dispatchIdsOfLine = new Map();
  for (const d of dispatches) dispatchIdsOfLine.set(d.operationalLineId, [...(dispatchIdsOfLine.get(d.operationalLineId) ?? []), d.timetableId].filter(Boolean));
  for (const train of trains) {
    if (train.provenance === "scheduled-provenance-unrecorded") issues.push({ code: "scheduled-train-without-provenance", trainId: train.trainId, operationalLineId: train.operationalLineId });
    if (train.status === "position-unknown") issues.push({ code: "train-position-unknown", trainId: train.trainId, reasons: [...train.positionUnknownReasons] });
    if (train.timetableId === null) continue;
    if (timetablesKnown && !byId.has(train.timetableId)) issues.push({ code: "train-timetable-unknown", trainId: train.trainId, timetableId: train.timetableId });
    const lineIds = dispatchIdsOfLine.get(train.operationalLineId) ?? [];
    if (!lineIds.includes(train.timetableId)) issues.push({ code: "train-timetable-differs-from-line-dispatch", trainId: train.trainId, timetableId: train.timetableId, lineDispatchTimetableIds: sortedUnique(lineIds) });
  }
  const subject = (issue) => issue.trainId ?? issue.timetableId ?? issue.operationalLineId ?? "";
  return issues.sort((a, b) => cmp(a.code, b.code) || cmp(subject(a), subject(b)) || cmp(a.dayType ?? "", b.dayType ?? ""));
}

const LIMITS = Object.freeze([
  { id: "completed-trains-not-attributable", text: "Finished trains are removed from the train list when they finish and the engine's traffic counters are per line, so the number of trains a timetable has completed is not known (completedTrains: null). Line counters are reported per line." },
  { id: "missed-departures-counted-per-dispatch-entry", text: "A dispatch entry's missed-departure counter is kept across a save and load (B17-E2; only a save from before the engine kept it restores as null), and it does not say why a departure was missed (a suspended line and a late check both count). The per-line traffic counter is kept across a save." },
  { id: "live-trains-only", text: "Only trains still on the line are listed. A train marked done is normally removed in the same step; 'done' does not say whether it finished normally." },
  { id: "no-delay-cost-demand-crowding", text: "No delay, cost, demand or crowding figure is computed or restated here." },
]);

// operationalState: the live ScenarioRuntime operational state;  timetables: the management railway timetable report (array) or undefined when not available.
export function buildRailwayTimetableOperationReport({ operationalState = null, timetables = undefined } = {}) {
  const state = isObject(operationalState) ? operationalState : null;
  const tableList = Array.isArray(timetables) ? timetables : null;
  const dispatches = state ? dispatchRows(state) : null;
  const stations = state && state.stations instanceof Map ? state.stations : new Map();
  const lineById = new Map(state ? listOf(state.lines).filter(isObject).map((line) => [String(line.id), line]) : []);
  const trains = state ? trainRows(state, lineById, stations) : null;
  const timetableOut = tableList === null ? null : timetableRows(tableList, dispatches ?? [], trains ?? []);
  const lines = state ? lineRows(state, dispatches, trains) : null;
  const byStatus = Object.fromEntries([...TIMETABLE_STATUSES, "other"].map((name) => [name, 0]));
  for (const row of timetableOut ?? []) byStatus[TIMETABLE_STATUSES.includes(row.status) ? row.status : "other"] += 1;
  const count = (rows, predicate) => rows.filter(predicate).length;
  const anything = (timetableOut ?? []).length || (dispatches ?? []).length || (trains ?? []).length;
  return clone({
    schema: RAILWAY_TIMETABLE_OPERATION_REPORT_SCHEMA, contractVersion: 1,
    simMinutes: state ? finite(state.simMinutes) : null,
    status: timetableOut === null && state === null ? "unavailable" : anything ? "available" : "none",
    unavailable: { timetables: timetableOut === null ? "the-timetable-report-was-not-provided" : null, operationalState: state === null ? "the-operational-state-was-not-provided" : null },
    totals: {
      timetablesByStatus: timetableOut === null ? null : byStatus,
      dispatches: dispatches === null ? null : dispatches.length,
      liveTrains: trains === null ? null : {
        total: trains.length, withTimetable: count(trains, (t) => t.provenance === "timetable"), scheduledProvenanceUnrecorded: count(trains, (t) => t.provenance === "scheduled-provenance-unrecorded"),
        legacyFrequency: count(trains, (t) => t.provenance === "legacy-frequency"), running: count(trains, (t) => t.status === "running"), positionUnknown: count(trains, (t) => t.status === "position-unknown"), done: count(trains, (t) => t.status === "done"),
      },
    },
    timetables: timetableOut, dispatches, lines, trains,
    issues: dispatches === null || trains === null ? null : issuesOf({ timetables: timetableOut ?? [], dispatches, trains, timetablesKnown: timetableOut !== null }),
    limits: LIMITS,
  });
}
