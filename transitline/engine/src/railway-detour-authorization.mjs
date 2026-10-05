// B14 detour authorization is deliberately separate from train routing.  A map geometry can prove
// what was measured, but it cannot create a physical operational line or silently grant foreign access.
import { VEHICLE_MODELS } from "./management/rolling-stock.mjs";
import { assessTechnicalCompatibility } from "./management/technical-compatibility.mjs";

export const RAILWAY_DETOUR_AUTHORIZATION_SCHEMA = "transitline.railway-detour-authorization/1";
const DETOUR_SCHEMA = "transitline.railway-detour-service-geometry/1";
const key = (value) => String(value);
const sameSet = (left, right) => Array.isArray(left) && Array.isArray(right)
  && [...new Set(left.map(key))].sort().join("|") === [...new Set(right.map(key))].sort().join("|");
const clone = (value) => structuredClone(value);

function eventOf(state, eventId) {
  const event = state?.railwayDisruptions?.events?.find((entry) => key(entry.id) === key(eventId));
  if (!event || !["active", "responding"].includes(event.status)) throw new Error(`Railway disruption ${eventId} is not ongoing`);
  return event;
}
function orderOf(state, id, eventId) {
  const order = state?.railwayControlOrders?.orders?.find((entry) => key(entry.id) === key(id));
  if (!order || order.status !== "active" || key(order.eventId) !== key(eventId)) throw new Error(`Railway control order ${id} is not active for disruption ${eventId}`);
  return order;
}
function currentCatalogEntry(catalog, leg) {
  const entries = catalog?.schema === "transitline.external-infrastructure-catalog/1" ? catalog.entries : catalog?.entries ?? catalog;
  if (!Array.isArray(entries)) return null;
  const rows = entries.filter((entry) => key(entry.externalNetworkId) === key(leg.externalNetworkId) && key(entry.externalLineId) === key(leg.externalLineId));
  if (rows.length !== 1) return null;
  const entry = rows[0];
  return entry.specificationId === leg.externalSpecificationId && entry.specificationRevision === leg.externalSpecificationRevision ? entry : null;
}
function agreementFor(agreements, ownerId, operatorId, requestedIds) {
  const rows = (agreements ?? []).filter((entry) => entry.status === "active" && key(entry.infrastructureOwnerId) === key(ownerId) && key(entry.guestOperatorId) === key(operatorId));
  if (requestedIds.length) return rows.find((entry) => requestedIds.includes(key(entry.id))) ?? null;
  return rows.length === 1 ? rows[0] : null;
}

export function assessRailwayDetourAuthorization(state, input = {}) {
  const geometry = input.detourGeometry;
  if (geometry?.schema !== DETOUR_SCHEMA || geometry.contractVersion !== 1) throw new Error("RailwayDetourServiceGeometry v1 is required");
  if (input.detourGeometryRevision === undefined || key(input.detourGeometryRevision) !== key(geometry.detourGeometryRevision)) throw new Error("Selected detour geometry revision is stale");
  const event = eventOf(state, input.eventId ?? geometry.eventId);
  const order = orderOf(state, input.controlOrderId, event.id);
  if (key(geometry.eventId) !== key(event.id) || key(geometry.controlGeometryId) !== key(order.controlGeometryId) || key(geometry.controlGeometryRevision) !== key(order.controlGeometryRevision)) throw new Error("Detour geometry is stale against the active control order");
  if (!sameSet(geometry.affectedTrackSegmentIds, order.suspendedTrackSegmentIds)) throw new Error("Detour geometry has stale suspended track mappings");
  const picks = input.picks ?? {};
  const allLegIds = (geometry.legs ?? []).map((leg) => key(leg.legId));
  const allConnectionIds = (geometry.connections ?? []).map((connection) => key(connection.connectionId));
  if (!sameSet(picks.legIds, allLegIds)) throw new Error("Every detour leg must be explicitly selected");
  if (!sameSet(picks.connectionIds, allConnectionIds)) throw new Error("Every detour connection must be explicitly selected");
  const model = VEHICLE_MODELS[input.vehicleModelId] ?? null;
  const trainsPerHour = Number(input.trainsPerHour);
  if (!model) throw new Error(`Unknown detour vehicle model ${input.vehicleModelId}`);
  if (!(Number.isFinite(trainsPerHour) && trainsPerHour > 0)) throw new Error("Detour trains per hour must be positive");
  const operatorId = key(input.operatorId ?? "player");
  const requestedAgreementIds = [...new Set((input.trackAccessAgreementIds ?? []).map(key))].sort();
  const violations = [];
  const missingInputs = [];
  const conditions = [];
  for (const connection of geometry.connections ?? []) {
    if (connection.physicalConnection === false) violations.push(`connection:${connection.connectionId}:physically-separated`);
    else if (connection.physicalConnection !== true) missingInputs.push(`connection:${connection.connectionId}:physicalConnection`);
  }
  const legs = [];
  const usedAgreementIds = new Set();
  for (const leg of geometry.legs ?? []) {
    const ownerId = leg.infrastructureOwnerId ?? null;
    let catalog = null;
    let technical = null;
    if (!ownerId) missingInputs.push(`leg:${leg.legId}:infrastructureOwnerId`);
    if (leg.sourceKind === "external") {
      catalog = currentCatalogEntry(input.externalInfrastructureCatalog, leg);
      if (!catalog) missingInputs.push(`leg:${leg.legId}:externalTechnicalSpecification`);
      else {
        technical = assessTechnicalCompatibility({ legId: leg.legId, technicalProfileId: catalog.technicalProfileId, vehicleModelId: model.id, infrastructureOverrides: catalog.technicalSpecification, notApplicable: catalog.notApplicable });
        if (technical.verdict === "impossible") violations.push(`leg:${leg.legId}:technical-incompatible`);
        if (technical.verdict === "unknown") missingInputs.push(`leg:${leg.legId}:technicalCompatibility`);
        if (technical.verdict === "conditional") conditions.push(`leg:${leg.legId}:technicalConfirmationRequired`);
        if (catalog.capacityTrainsPerHour === null) missingInputs.push(`leg:${leg.legId}:capacityTrainsPerHour`);
        else if (trainsPerHour > catalog.capacityTrainsPerHour) violations.push(`leg:${leg.legId}:capacity-exceeded`);
      }
    }
    let agreementId = null;
    if (ownerId && ownerId !== operatorId) {
      const agreement = agreementFor(input.trackAccessAgreements, ownerId, operatorId, requestedAgreementIds);
      if (!agreement) conditions.push(`leg:${leg.legId}:trackAccessAgreementRequired`);
      else { agreementId = key(agreement.id); usedAgreementIds.add(agreementId); }
    }
    legs.push({ legId: key(leg.legId), infrastructureOwnerId: ownerId, sourceKind: leg.sourceKind, trackSegmentId: leg.trackSegmentId ?? null, technicalCompatibility: technical, trackAccessAgreementId: agreementId });
  }
  for (const agreementId of requestedAgreementIds) if (!usedAgreementIds.has(agreementId)) violations.push(`trackAccessAgreement:${agreementId}:role-or-route-mismatch`);
  // A player may acknowledge an unmeasured connection, but may never acknowledge missing ownership,
  // capacity or technical-source data into existence.
  const unresolvedMissing = missingInputs.filter((entry) => !entry.includes(":physicalConnection") || input.confirmUnknownConnections !== true);
  const unresolvedTechnicalConditions = conditions.filter((entry) => entry.includes(":technicalConfirmationRequired") && input.confirmConditionalTechnical !== true);
  const unresolvedConditions = conditions.filter((entry) => !entry.includes(":technicalConfirmationRequired") || unresolvedTechnicalConditions.includes(entry));
  const verdict = violations.length ? "impossible" : unresolvedMissing.length ? "unknown" : unresolvedConditions.length ? "conditional" : "possible";
  return { schema: "transitline.railway-detour-assessment/1", contractVersion: 1, eventId: event.id, controlOrderId: order.id, detourGeometryId: geometry.detourGeometryId, detourGeometryRevision: geometry.detourGeometryRevision, detourLengthMeters: Number.isFinite(geometry.lengthMeters) && geometry.lengthMeters > 0 ? geometry.lengthMeters : null, operatorId, vehicleModelId: model.id, trainsPerHour, verdict, violations: [...new Set(violations)].sort(), missingInputs: [...new Set(missingInputs)].sort(), conditions: [...new Set(conditions)].sort(), legs, trackAccessAgreementIds: [...usedAgreementIds].sort() };
}

export function authorizeRailwayDetour(state, input = {}) {
  const assessment = assessRailwayDetourAuthorization(state, input);
  if (assessment.verdict !== "possible") throw new Error(`Detour cannot be authorized: ${[...assessment.violations, ...assessment.missingInputs, ...assessment.conditions].join(", ")}`);
  state.railwayDetourAuthorizations ??= { authorizations: [], nextSequence: 1 };
  if (state.railwayDetourAuthorizations.authorizations.some((entry) => entry.status === "authorized" && key(entry.controlOrderId) === key(assessment.controlOrderId))) throw new Error(`Control order ${assessment.controlOrderId} already has an authorized detour`);
  const id = input.id ?? `railway-detour-authorization:${state.railwayDetourAuthorizations.nextSequence++}`;
  const authorization = { schema: RAILWAY_DETOUR_AUTHORIZATION_SCHEMA, contractVersion: 1, id, status: "authorized", authorizedAtMinute: state.simMinutes, endedAtMinute: null, endReason: null, ...assessment };
  state.railwayDetourAuthorizations.authorizations.push(authorization);
  return clone(authorization);
}

export function railwayDetourAuthorizationReport(state) { return clone(state?.railwayDetourAuthorizations?.authorizations ?? []); }

export function syncRailwayDetourAuthorizations(state, atMinute = state?.simMinutes ?? 0) {
  const events = new Map((state?.railwayDisruptions?.events ?? []).map((event) => [key(event.id), event]));
  const orders = new Map((state?.railwayControlOrders?.orders ?? []).map((order) => [key(order.id), order]));
  const ended = [];
  for (const authorization of state?.railwayDetourAuthorizations?.authorizations ?? []) {
    if (authorization.status !== "authorized") continue;
    const event = events.get(key(authorization.eventId));
    const order = orders.get(key(authorization.controlOrderId));
    if (event && ["active", "responding"].includes(event.status) && order?.status === "active") continue;
    authorization.status = "ended";
    authorization.endedAtMinute = atMinute;
    authorization.endReason = !event || !["active", "responding"].includes(event.status) ? "disruption-ended" : "control-order-ended";
    ended.push(clone(authorization));
  }
  return ended;
}
