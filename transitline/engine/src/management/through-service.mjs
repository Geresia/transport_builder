import { TECHNICAL_PROFILES } from "./construction.mjs";
import { VEHICLE_MODELS } from "./rolling-stock.mjs";
import { assessTechnicalCompatibility } from "./technical-compatibility.mjs";

export const THROUGH_SERVICE_SCHEMA = "transitline.through-service/1";
export const THROUGH_SERVICE_VERDICTS = Object.freeze(["possible", "conditional", "impossible", "unknown"]);
export const THROUGH_SERVICE_STATUSES = Object.freeze(["draft", "assessed", "approved", "suspended", "terminated"]);

const copy = (value) => structuredClone(value);
const text = (value) => (typeof value === "string" && value.trim() ? value : null);

function catalogEntryFor(leg, catalog) {
  return catalog.find((entry) => entry.legId === leg.legId)
    ?? catalog.find((entry) => leg.sourceKind === "external"
      && entry.externalNetworkId === leg.externalNetworkId
      && entry.externalLineId === leg.externalLineId)
    ?? null;
}

function catalogEntriesOf(catalog, route) {
  if (Array.isArray(catalog)) return catalog;
  if (catalog?.schema === "transitline.external-infrastructure-catalog/1" && Array.isArray(catalog.entries)) {
    if (route.sourcePackId && catalog.packId !== route.sourcePackId) throw new Error("External infrastructure catalog belongs to another pack");
    const entries = catalog.entries.filter((entry) => entry.throughRouteId === route.throughRouteId);
    if (entries.some((entry) => entry.routeGeometryRevision && entry.routeGeometryRevision !== route.geometryRevision)) {
      throw new Error("External infrastructure catalog route revision is stale");
    }
    return entries;
  }
  throw new Error("Infrastructure catalog must be an entry list or ExternalInfrastructureCatalog v1");
}

function agreementFor({ ownerId, operatorId, leg, requestedIds, agreements }) {
  const candidates = agreements.filter((agreement) => agreement.guestOperatorId === operatorId
    && agreement.infrastructureOwnerId === ownerId
    && agreement.status === "active"
    && (leg.connectedProjectId === null || leg.connectedProjectId === undefined || agreement.hostProjectId === leg.connectedProjectId));
  if (requestedIds.length) return candidates.find((agreement) => requestedIds.includes(agreement.id)) ?? null;
  return candidates.length === 1 ? candidates[0] : null;
}

function verdictOf({ violations, missingInputs, conditions }) {
  if (violations.length) return "impossible";
  if (missingInputs.length) return "unknown";
  if (conditions.length) return "conditional";
  return "possible";
}

export function assessThroughService(input, {
  route,
  projects = [],
  infrastructureCatalog = [],
  trackAccessAgreements = [],
  playerOperatorId = "player",
} = {}) {
  if (route?.schema !== "transitline.through-route-geometry/1" || route.contractVersion !== 1 || !route.throughRouteId) {
    throw new Error("ThroughRouteGeometry v1 is required");
  }
  const operatorId = text(input?.operatorId);
  const model = VEHICLE_MODELS[input?.guestModelId] ?? null;
  const trainsPerHour = Number(input?.trainsPerHour);
  const requestedAgreementIds = [...new Set((input?.trackAccessAgreementIds ?? []).map(String))].sort();
  const catalogEntries = catalogEntriesOf(infrastructureCatalog, route);
  const violations = [];
  const conditions = [];
  const missingInputs = [];
  if (!text(route.geometryRevision)) missingInputs.push("route.geometryRevision");
  if (!operatorId) missingInputs.push("operatorId");
  if (!model) missingInputs.push("guestModelId");
  if (!Number.isFinite(trainsPerHour)) missingInputs.push("trainsPerHour");
  else if (!(trainsPerHour > 0)) violations.push("trainsPerHour must be greater than zero");

  const legStates = [];
  const usedAgreementIds = new Set();
  for (const leg of route.legs ?? []) {
    const catalog = catalogEntryFor(leg, catalogEntries);
    const project = leg.connectedProjectId === null || leg.connectedProjectId === undefined
      ? null
      : projects.find((entry) => entry.id === leg.connectedProjectId) ?? null;
    let ownerId = text(leg.infrastructureOwnerId);
    let technicalProfileId = text(catalog?.technicalProfileId);
    let infrastructureStatus = text(catalog?.status);
    let capacityTrainsPerHour = Number.isFinite(catalog?.capacityTrainsPerHour) ? Number(catalog.capacityTrainsPerHour) : null;

    if (leg.sourceKind === "planned") {
      violations.push(`leg:${leg.legId}:infrastructure-not-built`);
    } else if (leg.sourceKind === "existing") {
      if (!project) missingInputs.push(`leg:${leg.legId}:connectedProject`);
      else {
        const projectOwner = text(project.infrastructureOwnerId) ?? playerOperatorId;
        if (ownerId && ownerId !== projectOwner) violations.push(`leg:${leg.legId}:owner-conflict`);
        ownerId ??= projectOwner;
        technicalProfileId = text(project.technicalProfileId);
        infrastructureStatus = text(project.status);
        if (project.status !== "available") violations.push(`leg:${leg.legId}:project-not-available`);
      }
    } else if (leg.sourceKind === "external") {
      if (!catalog) missingInputs.push(`leg:${leg.legId}:externalInfrastructure`);
      const catalogOwner = text(catalog?.infrastructureOwnerId);
      if (ownerId && catalogOwner && ownerId !== catalogOwner) violations.push(`leg:${leg.legId}:owner-conflict`);
      ownerId ??= catalogOwner;
      if (infrastructureStatus && !["available", "open"].includes(infrastructureStatus)) violations.push(`leg:${leg.legId}:infrastructure-not-available`);
    } else violations.push(`leg:${leg.legId}:source-kind-invalid`);

    if (!ownerId) missingInputs.push(`leg:${leg.legId}:infrastructureOwnerId`);
    const suppliedTechnicalSpecification = catalog?.technicalSpecification ?? project?.technicalSpecification ?? null;
    const knownTechnicalProfile = technicalProfileId ? TECHNICAL_PROFILES[technicalProfileId] ?? null : null;
    if ((!technicalProfileId && !suppliedTechnicalSpecification) || (technicalProfileId && !knownTechnicalProfile)) {
      missingInputs.push(`leg:${leg.legId}:technicalProfileId`);
    }
    const technicalCompatibility = model && (knownTechnicalProfile || suppliedTechnicalSpecification)
      ? assessTechnicalCompatibility({
        legId: leg.legId,
        technicalProfileId,
        vehicleModelId: model.id,
        infrastructureOverrides: suppliedTechnicalSpecification ?? {},
        notApplicable: catalog?.notApplicable ?? project?.notApplicable,
      })
      : null;
    const compatibility = technicalCompatibility?.verdict === "possible"
      ? "compatible"
      : technicalCompatibility?.verdict === "impossible"
        ? "incompatible"
        : technicalCompatibility?.verdict ?? "unknown";
    if (technicalCompatibility?.verdict === "impossible") {
      violations.push(`leg:${leg.legId}:running-system-incompatible`);
      for (const reason of technicalCompatibility.violations) violations.push(`leg:${leg.legId}:technical:${reason}`);
    }
    for (const reason of technicalCompatibility?.conditions ?? []) conditions.push(`leg:${leg.legId}:technical:${reason}`);
    for (const reason of technicalCompatibility?.missingInputs ?? []) missingInputs.push(`leg:${leg.legId}:technical:${reason}`);
    if (capacityTrainsPerHour === null) conditions.push(`leg:${leg.legId}:capacity-verification-required`);
    else if (trainsPerHour > capacityTrainsPerHour) violations.push(`leg:${leg.legId}:capacity-exceeded`);

    const foreignOwner = ownerId !== null && operatorId !== null && ownerId !== operatorId;
    const agreement = foreignOwner
      ? agreementFor({ ownerId, operatorId, leg, requestedIds: requestedAgreementIds, agreements: trackAccessAgreements })
      : null;
    if (foreignOwner && !agreement) conditions.push(`leg:${leg.legId}:track-access-agreement-required`);
    if (agreement) usedAgreementIds.add(agreement.id);
    legStates.push({
      legId: leg.legId,
      sourceKind: leg.sourceKind,
      connectedProjectId: leg.connectedProjectId ?? null,
      externalNetworkId: leg.externalNetworkId ?? null,
      externalLineId: leg.externalLineId ?? null,
      externalSpecificationId: text(catalog?.specificationId),
      externalSpecificationRevision: text(catalog?.specificationRevision),
      infrastructureOwnerId: ownerId,
      operatorId,
      payerOperatorId: foreignOwner ? operatorId : null,
      payeeOwnerId: foreignOwner ? ownerId : null,
      technicalProfileId,
      vehicleProfileId: model?.profileId ?? null,
      compatibility,
      technicalCompatibility,
      infrastructureStatus,
      capacityTrainsPerHour,
      trackAccessAgreementId: agreement?.id ?? null,
    });
  }

  for (const handover of route.handovers ?? []) {
    const connectionState = handover.connectionState
      ?? (handover.physicalConnection === true ? "joined" : handover.physicalConnection === false ? "separated" : "unknown");
    if (connectionState === "separated") violations.push(`handover:${handover.handoverId}:physically-separated`);
    else if (connectionState !== "joined") missingInputs.push(`handover:${handover.handoverId}:physicalConnection`);
  }
  for (const agreementId of requestedAgreementIds) {
    const agreement = trackAccessAgreements.find((entry) => entry.id === agreementId);
    if (!agreement) violations.push(`trackAccessAgreement:${agreementId}:not-found`);
    else if (!usedAgreementIds.has(agreementId)) violations.push(`trackAccessAgreement:${agreementId}:role-or-route-mismatch`);
  }

  const foreignOwners = [...new Set(legStates.map((leg) => leg.payeeOwnerId).filter(Boolean))].sort();
  if (foreignOwners.length > 1) conditions.push("multiple-infrastructure-owners-require-separate-settlement");
  const assessment = {
    verdict: verdictOf({ violations, missingInputs, conditions }),
    violations: [...new Set(violations)],
    conditions: [...new Set(conditions)],
    missingInputs: [...new Set(missingInputs)],
  };
  return {
    operatorId,
    payerOperatorId: foreignOwners.length ? operatorId : null,
    payeeOwnerId: foreignOwners.length === 1 ? foreignOwners[0] : null,
    legs: legStates,
    handoverIds: (route.handovers ?? []).map((entry) => entry.handoverId),
    trackAccessAgreementIds: [...usedAgreementIds].sort(),
    assessment,
  };
}

export function createThroughService(input, context = {}) {
  if (!text(input?.throughServiceId)) throw new Error("Through service requires throughServiceId");
  if (!THROUGH_SERVICE_STATUSES.includes(input.status ?? "draft")) throw new Error(`Invalid through service status ${input.status}`);
  const route = context.route;
  const assessed = assessThroughService(input, context);
  return {
    schema: THROUGH_SERVICE_SCHEMA,
    contractVersion: 1,
    throughServiceId: input.throughServiceId,
    throughRouteId: route.throughRouteId,
    routeGeometryRevision: route.geometryRevision ?? null,
    status: input.status ?? "draft",
    guestModelId: input.guestModelId ?? null,
    trainsPerHour: Number.isFinite(Number(input.trainsPerHour)) ? Number(input.trainsPerHour) : null,
    ...assessed,
  };
}

export function reassessThroughService(service, context = {}) {
  if (service?.schema !== THROUGH_SERVICE_SCHEMA || service.contractVersion !== 1) throw new Error("ThroughService v1 is required");
  return createThroughService({
    throughServiceId: service.throughServiceId,
    status: service.status,
    operatorId: service.operatorId,
    guestModelId: service.guestModelId,
    trainsPerHour: service.trainsPerHour,
    trackAccessAgreementIds: service.trackAccessAgreementIds,
  }, context);
}

export function cloneThroughService(service) {
  return copy(service);
}
