import { assessTechnicalCompatibility } from "./management/technical-compatibility.mjs";
import { VEHICLE_MODELS } from "./management/rolling-stock.mjs";

// B16-E1: pre-screening of one service plan.  It reads the plan (the B16-M1 intent), the line's technical specification, the vehicle
// model, the fleet and the B13 rail-capacity application, and says for every fact the plan leans on whether it is there, missing
// or contradicts the plan.  It is NOT a timetable check: minimum headway, hourly capacity, single-track / junction / turnback
// conflicts and closure windows stay with B13 (`assessOperationalRailwayTimetable`), listed in `deferredToB13`.  It computes no
// demand, fare, cost or crowding, draws no random number, reads no clock and changes none of its inputs.
//
// Missing data: a fact that is not stated is `unknown` — never "possible".  The overall verdict is the worst check, with
// impossible > unknown > conditional > possible (a certain blocker outranks a missing fact; a missing fact outranks a condition).
export const SERVICE_PLAN_PRESCREENING_SCHEMA = "transitline.service-plan-prescreening/1";
export const PRESCREENING_VERDICTS = Object.freeze(["possible", "conditional", "impossible", "unknown"]);
export const DEFERRED_TO_B13 = Object.freeze(["minimum-headway", "hourly-capacity", "single-track-conflict", "junction-conflict", "turnback-conflict", "closure-window"]);

const RECOVERING_STATUSES = new Set(["repairing", "inspection-due"]);
const text = (value) => (typeof value === "string" && value.trim() ? value : null);
const key = (value) => (value === null || value === undefined ? null : String(value));
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const clone = (value) => (value === undefined ? null : structuredClone(value));
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const missing = (value) => value === null || value === undefined;

const check = (area, checkId, status, reason, facts = {}) => ({ checkId, area, status, reason: reason ?? null, facts: clone(facts) });
const worst = (statuses) => {
  for (const status of ["impossible", "unknown", "conditional"]) if (statuses.includes(status)) return status;
  return "possible";
};
const compatibilityStatus = { compatible: "possible", incompatible: "impossible", conditional: "conditional", unknown: "unknown" };

function getById(collection, id) {
  if (collection?.get) return collection.get(id) ?? collection.get(key(id)) ?? null;
  return (collection ?? []).find((entry) => key(entry?.id) === key(id)) ?? null;
}

function resolveLine(plan, state) {
  if (!text(plan.serviceId)) return { check: check("line", "operational-line", "unknown", "service-id-missing") };
  if (!state || !Array.isArray(state.lines)) return { check: check("line", "operational-line", "unknown", "operational-state-missing", { serviceId: plan.serviceId }) };
  const lines = state.lines.filter((line) => key(line.managementServiceId) === key(plan.serviceId));
  if (!lines.length) return { check: check("line", "operational-line", "impossible", "service-has-no-operational-line", { serviceId: plan.serviceId }) };
  if (lines.length > 1) return { check: check("line", "operational-line", "unknown", "service-maps-to-several-lines", { serviceId: plan.serviceId, lineIds: lines.map((line) => key(line.id)).sort() }) };
  return { line: lines[0], check: check("line", "operational-line", "possible", null, { serviceId: plan.serviceId, lineId: key(lines[0].id) }) };
}

function stateOf(entry) {
  if (!entry) return "missing";
  if (missing(entry.status)) return "unknown";
  return entry.status === "available" ? "available" : "unavailable";
}

function lineStateChecks(line, state) {
  const checks = [check("line", "line-suspension", line.suspended === true ? "conditional" : line.suspended === false ? "possible" : "unknown",
    line.suspended === true ? "line-suspended" : line.suspended === false ? null : "line-suspension-not-stated", { suspended: line.suspended ?? null })];
  const states = (ids, collection) => (Array.isArray(ids) ? ids.map((id) => ({ id: key(id), state: stateOf(getById(collection, id)) })) : null);
  const stationStates = states(line.stationIds, state.stations);
  const trackStates = Array.isArray(line.trackSegmentIds) && line.trackSegmentIds.length ? states(line.trackSegmentIds, state.trackSegments) : null;
  for (const [checkId, entries, noun] of [["station-state", stationStates, "station"], ["track-state", trackStates, "track-segment"]]) {
    if (entries === null) { checks.push(check("line", checkId, "unknown", `${noun}-list-missing`)); continue; }
    const bad = (name) => entries.filter((entry) => entry.state === name).map((entry) => entry.id).sort();
    const status = bad("missing").length || bad("unavailable").length ? "impossible" : bad("unknown").length ? "unknown" : "possible";
    const reason = bad("missing").length ? `${noun}-missing` : bad("unavailable").length ? `${noun}-not-available` : bad("unknown").length ? `${noun}-status-not-stated` : null;
    checks.push(check("line", checkId, status, reason, { missing: bad("missing"), unavailable: bad("unavailable"), unstated: bad("unknown"), checked: entries.length }));
  }
  return checks;
}

function technicalChecks(plan, line, technicalSpecs) {
  const spec = technicalSpecs?.[key(line?.id)] ?? null;
  const modelId = text(plan.vehicleModelId);
  if (!modelId) return [check("technical", "vehicle-model", "unknown", "vehicle-model-not-selected")];
  if (!VEHICLE_MODELS[modelId]) return [check("technical", "vehicle-model", "unknown", "vehicle-model-unknown", { vehicleModelId: modelId })];
  if (!line) return [check("technical", "line-technical-spec", "unknown", "operational-line-unresolved", { vehicleModelId: modelId })];
  if (!isObject(spec) || (!text(spec.technicalProfileId) && !isObject(spec.technicalSpecification))) {
    return [check("technical", "line-technical-spec", "unknown", "line-technical-spec-missing", { lineId: key(line.id), vehicleModelId: modelId })];
  }
  let report;
  try {
    report = assessTechnicalCompatibility({
      technicalProfileId: text(spec.technicalProfileId),
      vehicleModelId: modelId,
      infrastructureOverrides: isObject(spec.technicalSpecification) ? spec.technicalSpecification : {},
      notApplicable: spec.notApplicable ?? undefined,
    });
  } catch (error) {
    return [check("technical", "line-technical-spec", "unknown", "line-technical-spec-unusable", { lineId: key(line.id), message: String(error.message) })];
  }
  return report.checks.map((entry) => check("technical", `technical:${entry.checkId}`, compatibilityStatus[entry.status] ?? "unknown", entry.reason,
    { infrastructureValue: entry.infrastructureValue, vehicleValue: entry.vehicleValue }));
}

function fleetChecks(plan, context) {
  const modelId = text(plan.vehicleModelId);
  const needed = plan.requestedSets;
  if (!modelId || !VEHICLE_MODELS[modelId]) return [check("fleet", "fleet-sets", "unknown", "vehicle-model-not-usable")];
  if (!Number.isInteger(needed) || needed <= 0) return [check("fleet", "fleet-sets", "unknown", "requested-sets-invalid", { requestedSets: plan.requestedSets ?? null })];
  if (!Array.isArray(context.vehicleOrders)) return [check("fleet", "fleet-sets", "unknown", "fleet-data-missing", { requestedSets: needed })];
  const orders = context.vehicleOrders.filter((order) => order?.modelId === modelId && order.stage !== "cancelled");
  const units = orders.flatMap((order) => (Array.isArray(order.units) ? order.units : []));
  const onOrder = orders.filter((order) => order.stage !== "accepted").reduce((sum, order) => sum + (Number.isInteger(order.quantity) ? order.quantity : 0), 0);
  const poolsKnown = Array.isArray(context.operatingResourcePools);
  const elsewhere = new Set();
  for (const pool of context.operatingResourcePools ?? []) {
    for (const assignment of pool?.assignments ?? []) {
      if (key(assignment.serviceId) === key(plan.serviceId)) continue;
      for (const unitId of assignment.primaryUnitIds ?? []) elsewhere.add(key(unitId));
    }
  }
  const count = (predicate) => units.filter(predicate).length;
  const held = (unit) => elsewhere.has(key(unit.id));
  const recovering = (unit) => RECOVERING_STATUSES.has(unit.status);
  const unrecognised = (unit) => unit.status !== "available" && !recovering(unit);
  const facts = {
    requestedSets: needed, vehicleModelId: modelId, owned: units.length, onOrder,
    available: count((unit) => unit.status === "available"),
    recovering: count(recovering),
    unrecognisedStatus: count(unrecognised),
    assignedToOtherServices: poolsKnown ? count(held) : null,
    free: poolsKnown ? count((unit) => unit.status === "available" && !held(unit)) : null,
  };
  // Even counting every unit and every unit on order, the fleet cannot reach the request: a certain blocker whatever else is unknown.
  if (facts.owned + onOrder < needed) return [check("fleet", "fleet-sets", "impossible", "fleet-insufficient", facts)];
  if (!poolsKnown) return [check("fleet", "fleet-sets", "unknown", "assignment-data-missing", facts)];
  if (facts.free >= needed) return [check("fleet", "fleet-sets", "possible", null, facts)];
  const needs = { reassign: count((unit) => held(unit) && unit.status === "available"), recovery: count((unit) => !held(unit) && recovering(unit)), delivery: onOrder };
  const reachable = facts.free + needs.reassign + needs.recovery + needs.delivery;
  if (reachable >= needed) return [check("fleet", "fleet-sets", "conditional", "fleet-needs-reassignment-recovery-or-delivery", { ...facts, needs })];
  if (reachable + count((unit) => !held(unit) && unrecognised(unit)) >= needed) return [check("fleet", "fleet-sets", "unknown", "unit-status-unrecognised", facts)];
  return [check("fleet", "fleet-sets", "impossible", "fleet-insufficient", facts)];
}

const sourceId = (state, stationId) => key(getById(state.stations, stationId)?.sourceStationId ?? stationId);

function facilityChecks(plan, line, state) {
  const application = (state.railCapacityApplications ?? []).find((entry) => key(entry.operationalLineId) === key(line.id)) ?? null;
  if (!application) {
    return ["rail-capacity-application", "direction-mode", "block-data", "junction-resource", "terminal-resource", "turnback-connection"]
      .map((id) => check("track", id, "unknown", "rail-capacity-application-missing", { lineId: key(line.id) }));
  }
  const checks = [check("track", "rail-capacity-application", "possible", null, { railGeometryId: application.railGeometryId, railGeometryRevision: application.railGeometryRevision })];
  const sections = [];
  const uncovered = [];
  for (const segmentId of line.trackSegmentIds ?? []) {
    const section = (application.sections ?? []).find((entry) => key(entry.trackSegmentId) === key(segmentId));
    if (section) sections.push(section); else uncovered.push(key(segmentId));
  }
  const gap = uncovered.length ? { reason: "section-not-in-application", facts: { uncoveredTrackSegmentIds: uncovered.sort() } } : null;
  const stated = (checkId, field, reason, summary) => {
    if (gap) return check("track", checkId, "unknown", gap.reason, gap.facts);
    const unstated = sections.filter((section) => missing(section[field]));
    if (unstated.length) return check("track", checkId, "unknown", reason, { sectionIds: unstated.map((section) => section.railCapacitySectionId).sort() });
    return check("track", checkId, "possible", null, summary());
  };
  checks.push(stated("direction-mode", "directionMode", "direction-mode-not-stated", () => ({ single: sections.filter((section) => section.directionMode === "single").length, double: sections.filter((section) => section.directionMode === "double").length, sections: sections.length })));
  checks.push(stated("block-data", "blockIds", "block-data-missing", () => ({ blocks: sections.reduce((sum, section) => sum + section.blockIds.length, 0), sections: sections.length })));
  checks.push(junctionCheck(plan, application, sections, gap));
  checks.push(...terminalChecks(plan, line, state, application));
  return checks;
}

function junctionCheck(plan, application, sections, gap) {
  if (gap) return check("track", "junction-resource", "unknown", gap.reason, gap.facts);
  const unstated = sections.filter((section) => missing(section.junctionResourceIds));
  if (unstated.length) return check("track", "junction-resource", "unknown", "junction-data-missing", { sectionIds: unstated.map((section) => section.railCapacitySectionId).sort() });
  const named = new Set((Array.isArray(plan.junctionResourceIds) ? plan.junctionResourceIds : []).map(key));
  const wanted = [...new Set([...sections.flatMap((section) => section.junctionResourceIds).map(key), ...named])].sort(byText);
  if (!wanted.length) return check("track", "junction-resource", "possible", null, { junctionResourceIds: [] });
  if (!Array.isArray(application.junctions)) return check("track", "junction-resource", "unknown", "junction-data-missing", { junctionResourceIds: wanted });
  const found = new Map(application.junctions.map((junction) => [key(junction.junctionResourceId), junction]));
  const absentFromPlan = wanted.filter((id) => !found.has(id) && named.has(id));
  const unresolved = wanted.filter((id) => !found.has(id) && !named.has(id));
  const separated = wanted.filter((id) => found.get(id)?.attachedToAllSections === false);
  const unverified = wanted.filter((id) => found.has(id) && typeof found.get(id).attachedToAllSections !== "boolean");
  const incomplete = wanted.filter((id) => found.get(id)?.missingRoles?.length);
  const facts = { junctionResourceIds: wanted, absentFromPlan, unresolved, separated, unverified, incomplete };
  if (absentFromPlan.length) return check("track", "junction-resource", "impossible", "plan-junction-absent", facts);
  if (separated.length) return check("track", "junction-resource", "impossible", "junction-separated", facts);
  if (unresolved.length) return check("track", "junction-resource", "unknown", "junction-reference-unresolved", facts);
  if (unverified.length) return check("track", "junction-resource", "unknown", "junction-attachment-unverified", facts);
  if (incomplete.length) return check("track", "junction-resource", "unknown", "junction-sections-incomplete", facts);
  return check("track", "junction-resource", "possible", null, facts);
}

function terminalChecks(plan, line, state, application) {
  const wanted = text(plan.terminalResourceId);
  const both = (status, reason, facts) => ["terminal-resource", "turnback-connection"].map((id) => check("track", id, status, reason, facts));
  if (!wanted) return both("unknown", "terminal-resource-not-selected");
  if (!Array.isArray(application.terminals)) return both("unknown", "terminal-data-missing", { terminalResourceId: wanted });
  const terminal = application.terminals.find((entry) => key(entry.terminalResourceId) === wanted);
  if (!terminal) return both("impossible", "terminal-resource-absent", { terminalResourceId: wanted });
  const onLine = (line.stationIds ?? []).some((id) => key(id) === key(terminal.stationId) || sourceId(state, id) === key(terminal.stationId));
  const facts = { terminalResourceId: wanted, stationId: terminal.stationId };
  return [onLine ? check("track", "terminal-resource", "possible", null, facts) : check("track", "terminal-resource", "impossible", "terminal-not-on-line", facts), turnbackCheck(plan, terminal)];
}

function turnbackCheck(plan, terminal) {
  const base = { terminalResourceId: terminal.terminalResourceId };
  const candidates = terminal.turnbackCandidates;
  if (!Array.isArray(candidates)) return check("track", "turnback-connection", "unknown", "turnback-data-missing", base);
  const chosen = text(plan.turnbackCandidateId);
  if (chosen) {
    const candidate = candidates.find((entry) => key(entry.turnbackCandidateId) === chosen);
    if (!candidate) return check("track", "turnback-connection", "impossible", "turnback-candidate-absent", { ...base, turnbackCandidateId: chosen });
    const attached = candidate.attached;
    return check("track", "turnback-connection", attached === true ? "possible" : attached === false ? "impossible" : "unknown",
      attached === true ? null : attached === false ? "turnback-not-connected" : "turnback-connection-unverified", { ...base, turnbackCandidateId: chosen, attached: attached ?? null });
  }
  if (!candidates.length) {
    if (!Array.isArray(terminal.platformCandidates)) return check("track", "turnback-connection", "unknown", "platform-data-missing", base);
    return terminal.platformCandidates.length
      ? check("track", "turnback-connection", "conditional", "platform-turnback-only", base)
      : check("track", "turnback-connection", "impossible", "no-turnback-candidate", base);
  }
  const attachedIds = candidates.filter((entry) => entry.attached === true).map((entry) => key(entry.turnbackCandidateId)).sort(byText);
  const facts = { ...base, candidates: candidates.length, attachedCandidateIds: attachedIds };
  if (attachedIds.length) return check("track", "turnback-connection", "possible", null, facts);
  if (candidates.some((entry) => entry.attached !== false)) return check("track", "turnback-connection", "unknown", "turnback-connection-unverified", facts);
  return check("track", "turnback-connection", "impossible", "turnback-not-connected", facts);
}

function capacityCheck(line, technicalSpecs) {
  const value = technicalSpecs?.[key(line.id)]?.capacityTrainsPerHour;
  return Number.isFinite(value) && value > 0
    ? check("track", "capacity-data", "possible", null, { capacityTrainsPerHour: value })
    : check("track", "capacity-data", "unknown", "capacity-data-missing", { capacityTrainsPerHour: null });
}

function revisionCheck(plan) {
  const state = plan.mapRevision?.state;
  if (state === "current") return check("plan", "map-revision", "possible", null, { state });
  if (state === "stale") return check("plan", "map-revision", "impossible", "map-revision-stale", { state });
  return check("plan", "map-revision", "unknown", "map-revision-not-stated", { state: state ?? null });
}

// plan:    { servicePlanId, serviceId, vehicleModelId?, requestedSets?, terminalResourceId?, turnbackCandidateId?, junctionResourceIds?, mapRevision?: { state } }
// context: { operationalState?, technicalSpecs?: { [lineId]: { technicalProfileId?, technicalSpecification?, notApplicable?, capacityTrainsPerHour? } },
//            vehicleOrders?, operatingResourcePools? }   — undefined means "not provided" (unknown); [] means "none".
export function prescreenServicePlan(plan, context = {}) {
  const input = isObject(plan) ? plan : {};
  const state = context.operationalState ?? null;
  const checks = [];
  if (!text(input.servicePlanId)) checks.push(check("plan", "plan-identity", "unknown", "service-plan-id-missing"));
  checks.push(revisionCheck(input));
  const resolved = resolveLine(input, state);
  checks.push(resolved.check);
  if (resolved.line) checks.push(...lineStateChecks(resolved.line, state));
  checks.push(...technicalChecks(input, resolved.line ?? null, context.technicalSpecs));
  checks.push(...fleetChecks(input, context));
  if (resolved.line) checks.push(...facilityChecks(input, resolved.line, state), capacityCheck(resolved.line, context.technicalSpecs));
  const reasons = (status) => [...new Set(checks.filter((entry) => entry.status === status).map((entry) => entry.reason ?? entry.checkId))].sort(byText);
  return {
    schema: SERVICE_PLAN_PRESCREENING_SCHEMA,
    contractVersion: 1,
    servicePlanId: text(input.servicePlanId),
    serviceId: text(input.serviceId),
    lineId: resolved.line ? key(resolved.line.id) : null,
    verdict: worst(checks.map((entry) => entry.status)),
    areas: Object.fromEntries(["plan", "line", "technical", "fleet", "track"].map((area) => [area, worst(checks.filter((entry) => entry.area === area).map((entry) => entry.status))])),
    checks,
    blockers: reasons("impossible"),
    missingInputs: reasons("unknown"),
    conditions: reasons("conditional"),
    deferredToB13: [...DEFERRED_TO_B13],
  };
}

export function prescreenServicePlans(plans, context = {}) {
  return (Array.isArray(plans) ? plans : []).map((plan) => prescreenServicePlan(plan, context)).sort((a, b) => byText(a.servicePlanId ?? "", b.servicePlanId ?? ""));
}
