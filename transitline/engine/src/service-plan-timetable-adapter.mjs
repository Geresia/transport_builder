import { resolveOperationalLinePath } from "./operational-timetable-integration.mjs";
import { prescreenServicePlan } from "./service-plan-prescreening.mjs";

// B16-C1 connects a player-authored ServicePlanGeometry to the existing B13
// timetable input.  It deliberately does not invent a management service, a
// route, a headway, or a turnback: B13 still owns every capacity judgement.
export const SERVICE_PLAN_TIMETABLE_ADAPTATION_SCHEMA = "transitline.service-plan-timetable-adaptation/1";

const text = (value) => typeof value === "string" && value.trim() ? value : null;
const key = (value) => value === null || value === undefined ? null : String(value);
const clone = (value) => structuredClone(value);
const byText = (a, b) => String(a).localeCompare(String(b));
const same = (left, right) => left.length === right.length && left.every((value, index) => value === right[index]);

function reason(code, facts = {}) { return { code, facts: clone(facts) }; }

function serviceBinding({ operationalState, services = [], throughServices = [] }, serviceId) {
  const service = (services ?? []).find((entry) => key(entry?.id) === serviceId) ?? null;
  if (service) {
    const line = (operationalState?.lines ?? []).find((entry) => key(entry?.id) === key(service.operationalLineId)) ?? null;
    return { kind: "standard", service, line };
  }
  const through = (throughServices ?? []).find((entry) => key(entry?.throughServiceId) === serviceId) ?? null;
  if (!through) return { kind: null, service: null, line: null };
  const binding = (operationalState?.throughServiceBindings ?? []).find((entry) => key(entry?.throughServiceId) === serviceId) ?? null;
  const line = (operationalState?.lines ?? []).find((entry) => key(entry?.id) === key(binding?.operationalLineId)) ?? null;
  return { kind: "through", service: through, line };
}

function activeBand(plan) {
  if (!Array.isArray(plan?.serviceBands)) return { band: null, reasons: [reason("service-bands-not-stated")] };
  const bands = plan.serviceBands.filter((band) => band?.operating !== false);
  if (!bands.length) return { band: null, reasons: [reason("no-operating-service-band")] };
  if (bands.length !== 1) return { band: null, reasons: [reason("multiple-operating-service-bands-unsupported", { bandIds: bands.map((band) => key(band.bandId)).sort(byText) })] };
  return { band: bands[0], reasons: [] };
}

function directionState(plan, route) {
  if (!Array.isArray(plan?.directions)) return [reason("directions-not-stated")];
  const first = key(route?.segments?.[0]?.fromStationId);
  const last = key(route?.segments?.at(-1)?.toStationId);
  const forward = plan.directions.find((direction) => key(direction.fromStationId) === first && key(direction.toStationId) === last) ?? null;
  const reverse = plan.directions.find((direction) => key(direction.fromStationId) === last && key(direction.toStationId) === first) ?? null;
  if (!forward || !reverse || plan.directions.length !== 2) return [reason("bidirectional-full-line-directions-required", { firstStationId: first, lastStationId: last })];
  const joins = [forward, reverse].map((direction) => direction.physicalConnection);
  if (joins.some((value) => value === false)) return [reason("direction-physical-connection-false")];
  if (joins.some((value) => value !== true)) return [reason("direction-physical-connection-unknown")];
  return [];
}

function terminalForFarEnd(plan, route) {
  const stationId = key(route?.segments?.at(-1)?.toStationId);
  const candidates = (Array.isArray(plan?.turnbacks) ? plan.turnbacks : [])
    .filter((turnback) => key(turnback?.stationId) === stationId && text(turnback?.terminalResourceId))
    .map((turnback) => ({ terminalResourceId: text(turnback.terminalResourceId), turnbackCandidateId: text(turnback.turnbackCandidateId) }));
  const ids = [...new Set(candidates.map((entry) => entry.terminalResourceId))].sort(byText);
  if (!ids.length) return { terminalResourceId: null, turnbackCandidateId: null, reasons: [reason("far-terminal-resource-not-selected", { stationId })] };
  if (ids.length > 1) return { terminalResourceId: null, turnbackCandidateId: null, reasons: [reason("far-terminal-resource-ambiguous", { stationId, terminalResourceIds: ids })] };
  const selected = candidates.find((entry) => entry.terminalResourceId === ids[0]);
  return { ...selected, reasons: [] };
}

function statusOf(reasons, prescreen) {
  const codes = new Set(reasons.map((entry) => entry.code));
  if (["service-plan-invalid", "service-plan-inactive", "map-revision-stale", "capacity-application-stale", "route-does-not-match-operational-line", "direction-physical-connection-false"].some((code) => codes.has(code)) || prescreen?.verdict === "impossible") return "blocked";
  if ([...codes].some((code) => code.includes("unsupported"))) return "unsupported";
  if (reasons.length || prescreen?.verdict === "unknown") return "unknown";
  return "ready";
}

// `binding.serviceId` is mandatory on purpose.  A map servicePlanId is a
// design-document ID, not the id of a commissioned management service.
export function adaptServicePlanToOperationalTimetable({
  servicePlan, binding = {}, operationalState = null, services = [], throughServices = [], prescreenContext = {},
  dayType = "weekday", closureWindowsBySectionId = {}, infrastructureAssumptions = null, minimumAcceptanceRatio = 1,
} = {}) {
  const plan = servicePlan && typeof servicePlan === "object" ? servicePlan : null;
  const issues = [];
  if (!plan || plan.schema !== "transitline.service-plan-geometry/1" || plan.contractVersion !== 1) issues.push(reason("service-plan-invalid"));
  const servicePlanId = text(plan?.servicePlanId);
  const serviceId = text(binding?.serviceId);
  if (!servicePlanId) issues.push(reason("service-plan-id-missing"));
  if (!serviceId) issues.push(reason("explicit-management-service-binding-required"));
  if (text(binding?.servicePlanId) && text(binding.servicePlanId) !== servicePlanId) issues.push(reason("binding-service-plan-mismatch", { boundServicePlanId: text(binding.servicePlanId), servicePlanId }));
  if (plan?.active !== true) issues.push(reason("service-plan-inactive"));
  if (plan?.revision?.state === "stale") issues.push(reason("map-revision-stale"));
  else if (plan?.revision?.state !== "current") issues.push(reason("map-revision-not-current", { state: plan?.revision?.state ?? null }));
  if (plan?.capacityApplicationState === "stale") issues.push(reason("capacity-application-stale"));
  else if (plan?.capacityApplicationState !== "current") issues.push(reason("capacity-application-not-current", { state: plan?.capacityApplicationState ?? null }));

  const resolved = serviceId ? serviceBinding({ operationalState, services, throughServices }, serviceId) : { kind: null, service: null, line: null };
  if (serviceId && !resolved.service) issues.push(reason("management-service-not-found", { serviceId }));
  if (resolved.kind === "through") issues.push(reason("through-service-prescreen-unsupported"));
  if (resolved.service && !resolved.line) issues.push(reason("management-service-operational-line-missing", { serviceId }));
  if (text(plan?.operationalLineId) && resolved.line && text(plan.operationalLineId) !== key(resolved.line.id)) issues.push(reason("map-operational-line-mismatch", { mapOperationalLineId: text(plan.operationalLineId), operationalLineId: key(resolved.line.id) }));

  let route = null;
  if (resolved.line) {
    try { route = resolveOperationalLinePath(operationalState, resolved.line); }
    catch (error) { issues.push(reason("operational-line-route-unusable", { message: String(error.message) })); }
  }
  const mappedIds = Array.isArray(plan?.route?.sections) ? plan.route.sections.map((section) => key(section.trackSegmentId)) : null;
  if (!mappedIds || mappedIds.some((id) => id === null)) issues.push(reason("service-plan-track-segment-mapping-missing"));
  if (route && mappedIds && mappedIds.every((id) => id !== null) && !same(mappedIds, route.sectionIds)) issues.push(reason("route-does-not-match-operational-line", { mappedTrackSegmentIds: mappedIds, operationalTrackSegmentIds: route.sectionIds }));
  const traversals = Array.isArray(plan?.route?.sections) ? plan.route.sections.map((section) => section.traversal ?? null) : null;
  if (route && traversals && traversals.every((value) => value !== null) && !same(traversals, route.sectionDirections)) issues.push(reason("route-direction-does-not-match-operational-line", { traversals, operationalDirections: route.sectionDirections }));
  if (plan?.playerInputs?.operatingPattern !== "full") issues.push(reason("partial-or-unstated-operating-pattern-unsupported", { operatingPattern: plan?.playerInputs?.operatingPattern ?? null }));
  if (route) issues.push(...directionState(plan, route));

  const selectedBand = activeBand(plan);
  issues.push(...selectedBand.reasons);
  const band = selectedBand.band;
  if (band && !(typeof band.playerRequestedHeadwayMinutes === "number" && band.playerRequestedHeadwayMinutes > 0)) issues.push(reason("player-requested-headway-missing-or-invalid"));
  if (band && (!Number.isInteger(band.startMinute) || !Number.isInteger(band.endMinute) || band.startMinute >= band.endMinute)) issues.push(reason("service-band-time-invalid"));
  if (band && route) {
    const keys = new Set((band.directionKeys ?? []).map(key));
    const required = (plan.directions ?? []).map((direction) => key(direction.key));
    if (!Array.isArray(band.directionKeys) || required.some((id) => !keys.has(id))) issues.push(reason("service-band-does-not-cover-both-directions"));
  }
  const terminal = route ? terminalForFarEnd(plan, route) : { terminalResourceId: null, turnbackCandidateId: null, reasons: [] };
  issues.push(...terminal.reasons);

  const prescreenInput = {
    servicePlanId, serviceId, vehicleModelId: text(plan?.vehicleIntent?.vehicleModelId), requestedSets: band?.playerRequestedTrainsets ?? plan?.vehicleIntent?.requestedTrainsets ?? null,
    terminalResourceId: terminal.terminalResourceId, turnbackCandidateId: terminal.turnbackCandidateId,
    junctionResourceIds: Array.isArray(plan?.spatialFacts?.sections) ? [...new Set(plan.spatialFacts.sections.flatMap((section) => section.junctionResourceIds ?? []))].map(key).sort(byText) : null,
    mapRevision: { state: plan?.revision?.state ?? null },
  };
  const prescreen = prescreenServicePlan(prescreenInput, { ...prescreenContext, operationalState });
  const sortedIssues = issues.sort((left, right) => byText(left.code, right.code));
  const status = statusOf(sortedIssues, prescreen);
  const operationalRequest = status === "ready" ? {
    infrastructureRevision: plan.capacityApplicationRevision,
    dayType, closureWindowsBySectionId: clone(closureWindowsBySectionId), infrastructureAssumptions: clone(infrastructureAssumptions), minimumAcceptanceRatio,
    servicePlans: [{ serviceId, firstDepartureMinute: band.startMinute, lastDepartureMinute: band.endMinute, headwayMinutes: band.playerRequestedHeadwayMinutes, terminalResourceId: terminal.terminalResourceId, turnbackMinutes: 8 }],
  } : null;
  return {
    schema: SERVICE_PLAN_TIMETABLE_ADAPTATION_SCHEMA, contractVersion: 1,
    servicePlanId, servicePlanRevision: text(plan?.servicePlanRevision), serviceId, operationalLineId: key(resolved.line?.id),
    status, issues: sortedIssues, prescreenInput, prescreen, operationalRequest,
  };
}
