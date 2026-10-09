// B18-E4: which dispatch SOURCE applies to each operational line today.  A fact report, nothing else.
//
// For the current simulated day it reads the day type (operating calendar, else the default Mon-Fri / Sat-Sun rule), each line's
// recorded `timetableDispatches[dayType]` entry, its suspension and plan-only flags and its `frequency`, and says which of the
// engine's own dispatch rules (trains.mjs: suspended, else the entry of the current day type, else line.frequency) applies.
// It does not say whether service is possible, enough, punctual, busy or worth anything; it computes no demand, cost, crowding,
// headway or capacity; it does not repeat the per-timetable execution counters of the B17 operation report; and it never touches
// the state, the RNG or any clock (nothing here calls a function that creates a record).
// null = not recorded, false/0/[] = recorded as such: the four are never merged.
import { OPERATIONAL_DAY_TYPES, operationalDayTypeAt } from "./operational-calendar.mjs";
import { bandAt } from "./state.mjs";

export const OPERATIONAL_SERVICE_COVERAGE_REPORT_SCHEMA = "transitline.operational-service-coverage-report/1";
export const DISPATCH_SOURCES = Object.freeze(["timetable", "legacy-frequency", "suspended", "no-operational-line", "unknown"]);

// Every reason / warning the report can give, with what it means.  Facts about wiring or records, never verdicts.
export const COVERAGE_REASONS = Object.freeze({
  "line-suspended": "The line is suspended: the engine dispatches nothing from it (departures of a held timetable are counted as missed).",
  "plan-only-line": "The line is a plan-only drawing (planOnly).",
  "suspended-flag-unrecorded": "The line records no suspended flag; the engine treats an absent flag as not suspended.",
  "dispatch-entry-of-current-day-type": "The line holds a dispatch entry for the current day type; the engine dispatches from it and not from frequency.",
  "no-dispatch-entry-for-current-day-type": "The line holds no dispatch entry at all, so the engine falls back to line.frequency.",
  "dispatch-entries-only-for-other-day-types": "The line holds dispatch entries, but none for the current day type, so the engine falls back to line.frequency.",
  "frequency-is-zero-in-current-band": "line.frequency is 0 for the current band: the frequency rule releases no train.",
  "frequency-unrecorded-for-current-band": "line.frequency holds no number for the current band, so the frequency rule cannot be read.",
  "partial-service-control-order-active": "A railway control order is active on the line (the engine dispatches the retained services).",
  "service-has-no-operational-line": "The management service names no operational line (not commissioned, or decommissioned).",
  "operational-line-missing": "The management service names an operational line that is not in the operational state.",
  "sim-minutes-unknown": "The simulated time is not a number, so the current day and day type are unknown.",
  "day-type-unknown": "No day type could be determined for the current day.",
  "plan-only-line-not-suspended": "A plan-only line is not suspended; the dispatcher does not read planOnly, so it dispatches by its own records.",
  "dispatch-entry-blocked": "The dispatch entry for the current day type is blocked (blockedReason): it holds no departures and the frequency rule does not run.",
  "dispatch-entry-day-type-mismatch": "The entry stored under this day type names another day type itself.",
  "dispatch-entry-names-no-timetable": "The dispatch entry names no timetableId.",
  "management-service-not-recorded-on-line": "The line records no managementServiceId.",
  "management-service-found-through-service-link": "The line records no managementServiceId; the one management service that points at it was used.",
  "management-service-link-mismatch": "The line's managementServiceId and the service's operationalLineId do not point at each other.",
  "management-service-link-ambiguous": "More than one management service points at this line.",
});

const clone = (value) => structuredClone(value);
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value) => (typeof value === "string" && value !== "" ? value : null);
const key = (value) => (value === null || value === undefined ? null : String(value));
const cmp = (a, b) => String(a).localeCompare(String(b), "en", { numeric: true });
const hasLine = (service) => service.operationalLineId !== undefined && service.operationalLineId !== null;

function managementLink(line, services) {
  const lineId = String(line.id);
  const pointing = services.filter((service) => hasLine(service) && String(service.operationalLineId) === lineId);
  const recorded = text(line.managementServiceId);
  const warnings = [];
  if (recorded !== null) {
    const service = services.find((entry) => entry.id === recorded) ?? null;
    if (service && !(hasLine(service) && String(service.operationalLineId) === lineId)) warnings.push("management-service-link-mismatch");
    if (pointing.length > 1) warnings.push("management-service-link-ambiguous");
    return { managementServiceId: recorded, managementServiceIdSource: "line", warnings };
  }
  warnings.push("management-service-not-recorded-on-line");
  if (pointing.length === 1) return { managementServiceId: text(pointing[0].id), managementServiceIdSource: "service-link", warnings: [...warnings, "management-service-found-through-service-link"] };
  if (pointing.length > 1) warnings.push("management-service-link-ambiguous");
  return { managementServiceId: null, managementServiceIdSource: null, warnings };
}

function lineRow(line, { state, services, dayType, bandId }) {
  const entries = isObject(line.timetableDispatches) ? line.timetableDispatches : null;
  const link = managementLink(line, services);
  const reasons = [];
  const warnings = [...link.warnings];
  const lineSuspended = typeof line.suspended === "boolean" ? line.suspended : null;
  const planOnly = typeof line.planOnly === "boolean" ? line.planOnly : null;
  const entry = dayType !== null && entries !== null && isObject(entries[dayType]) ? entries[dayType] : null;
  const service = link.managementServiceId === null ? null : services.find((candidate) => candidate.id === link.managementServiceId) ?? null;
  const row = {
    operationalLineId: String(line.id),
    managementServiceId: link.managementServiceId,
    managementServiceIdSource: link.managementServiceIdSource,
    serviceStatus: text(service?.status),
    lineSuspended,
    planOnly,
    currentDayType: dayType,
    currentDispatchEntry: entry === null ? null : clone(entry),
    dispatchEntryDayTypes: entries === null ? [] : Object.keys(entries).filter((name) => isObject(entries[name])).sort(cmp),
    dispatchSource: "unknown",
    timetableId: null,
    timetableDayType: null,
    legacyFrequency: null,
    reasons,
    warnings,
  };
  if (planOnly === true) reasons.push("plan-only-line");
  if (planOnly === true && lineSuspended !== true) warnings.push("plan-only-line-not-suspended");
  if (state.railwayControlOrders?.orders?.some((order) => order?.status === "active" && key(order.lineId) === row.operationalLineId)) reasons.push("partial-service-control-order-active");
  if (dayType === null) { reasons.push("day-type-unknown"); return row; }
  // the order trains.mjs decides in: suspended first, then the entry of the current day type, then frequency
  if (lineSuspended === null) reasons.push("suspended-flag-unrecorded");
  if (line.suspended) {
    row.dispatchSource = "suspended";
    reasons.push("line-suspended");
    return row;
  }
  if (entry !== null) {
    row.dispatchSource = "timetable";
    row.timetableId = text(entry.timetableId);
    row.timetableDayType = text(entry.dayType);
    reasons.push("dispatch-entry-of-current-day-type");
    if (row.timetableId === null) warnings.push("dispatch-entry-names-no-timetable");
    if (row.timetableDayType !== null && row.timetableDayType !== dayType) warnings.push("dispatch-entry-day-type-mismatch");
    if (text(entry.blockedReason) !== null) warnings.push("dispatch-entry-blocked");
    return row;
  }
  reasons.push(row.dispatchEntryDayTypes.length ? "dispatch-entries-only-for-other-day-types" : "no-dispatch-entry-for-current-day-type");
  const perHour = bandId === null ? undefined : line.frequency?.[bandId];
  if (Number.isFinite(perHour)) {
    row.dispatchSource = "legacy-frequency";
    row.legacyFrequency = { bandId, trainsPerHour: perHour };
    if (perHour === 0) reasons.push("frequency-is-zero-in-current-band");
  } else {
    row.legacyFrequency = { bandId, trainsPerHour: null };
    reasons.push("frequency-unrecorded-for-current-band");
  }
  return row;
}

// A management service that no operational line serves: one row, source "no-operational-line".
function serviceWithoutLineRow(service, dayType) {
  const named = hasLine(service);
  return {
    operationalLineId: named ? String(service.operationalLineId) : null,
    managementServiceId: text(service.id),
    managementServiceIdSource: "service",
    serviceStatus: text(service.status),
    lineSuspended: null,
    planOnly: null,
    currentDayType: dayType,
    currentDispatchEntry: null,
    dispatchEntryDayTypes: [],
    dispatchSource: "no-operational-line",
    timetableId: null,
    timetableDayType: null,
    legacyFrequency: null,
    reasons: [named ? "operational-line-missing" : "service-has-no-operational-line"],
    warnings: [],
  };
}

export function buildOperationalServiceCoverageReport({ operationalState = null, services = [] } = {}) {
  const state = isObject(operationalState) ? operationalState : null;
  const list = Array.isArray(services) ? services.filter(isObject) : [];
  const simMinutes = Number.isFinite(state?.simMinutes) ? state.simMinutes : null;
  const currentDay = simMinutes === null ? null : Math.floor(simMinutes / 1440);
  const currentDayType = simMinutes === null ? null : operationalDayTypeAt(simMinutes, state.operationalCalendar);
  const explicit = currentDay === null ? undefined : state.operationalCalendar?.dayTypesByOperatingDay?.[String(currentDay)];
  const bandId = simMinutes === null ? null : bandAt(state)?.id ?? null;
  const lines = Array.isArray(state?.lines) ? state.lines.filter((line) => isObject(line) && line.id !== undefined && line.id !== null) : [];
  const lineIds = new Set(lines.map((line) => String(line.id)));
  const rows = lines.map((line) => lineRow(line, { state, services: list, dayType: currentDayType, bandId }));
  const unserved = list.filter((service) => text(service.id) !== null && !(hasLine(service) && lineIds.has(String(service.operationalLineId))))
    .map((service) => serviceWithoutLineRow(service, currentDayType));
  const all = [...rows, ...unserved].sort((a, b) => (a.operationalLineId === null) - (b.operationalLineId === null) || cmp(a.operationalLineId ?? "", b.operationalLineId ?? "") || cmp(a.managementServiceId ?? "", b.managementServiceId ?? ""));
  if (simMinutes === null) for (const row of all) row.reasons.push("sim-minutes-unknown");
  const bySource = Object.fromEntries(DISPATCH_SOURCES.map((source) => [source, all.filter((row) => row.dispatchSource === source).length]));
  return {
    schema: OPERATIONAL_SERVICE_COVERAGE_REPORT_SCHEMA,
    contractVersion: 1,
    basis: "engine-state-facts",
    simMinutes,
    currentDay,
    currentDayType,
    currentDayTypeSource: currentDayType === null ? null : OPERATIONAL_DAY_TYPES.includes(explicit) ? "operating-calendar" : "default-rule",
    bandId,
    lines: all,
    counts: { rows: all.length, bySource },
    warnings: clone(state?.operationalCalendarWarnings ?? []),
  };
}
