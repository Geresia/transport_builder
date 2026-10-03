import { buildThroughRoute } from "./map/through-route.mjs";

export const THROUGH_ROUTE_SOURCE_CATALOG_SCHEMA = "transitline.through-route-source-catalog/1";
export const THROUGH_OPERATION_DRAFT_SCHEMA = "transitline.through-operation-draft/1";

const clone = (value) => structuredClone(value);
const text = (value) => (typeof value === "string" && value.trim() ? value.trim() : null);
const byId = (a, b) => a.sourceId.localeCompare(b.sourceId);

function requireMapExport(pack, mapExport) {
  const packId = pack?.manifest?.id ?? null;
  if (!packId) throw new Error("A city pack is required for through-route planning");
  if (mapExport?.schema !== "transitline.map-export/1") throw new Error("MapExport v1 is required for through-route planning");
  if (mapExport.packId !== packId) throw new Error(`Map export belongs to pack ${mapExport.packId}, not ${packId}`);
}

function projectSource(project, playerOperatorId, operationalState) {
  const plan = project?.planGeometry;
  if (plan?.schema !== "transitline.plan-geometry/1" || !plan.planId) return null;
  const stationAssets = new Map((project.assets ?? [])
    .filter((asset) => asset.kind === "station" && asset.sourceId)
    .map((asset) => [asset.sourceId, asset.id]));
  const ownerId = text(project.infrastructureOwnerId) ?? text(playerOperatorId);
  const operationalLineId = project.commissionedLineId === undefined ? null : String(project.commissionedLineId);
  const operationalLine = operationalLineId === null ? null : (operationalState?.lines ?? [])
    .find((line) => String(line.id) === operationalLineId && line.projectId === project.id);
  return {
    sourceId: `project:${project.id}`,
    sourceKind: "existing",
    name: plan.name ?? project.id,
    connectedPlanId: plan.planId,
    connectedProjectId: project.id,
    externalNetworkId: null,
    externalLineId: null,
    infrastructureOwnerId: ownerId,
    infrastructureStatus: project.status ?? null,
    operationalLineId: operationalLine ? operationalLineId : null,
    selectable: true,
    operationReady: project.status === "available" && Boolean(operationalLine),
    stations: plan.stationCandidates.map((station) => ({
      stationId: station.id,
      operationalStationId: operationalLine?.stationIds.includes(stationAssets.get(station.id)) ? stationAssets.get(station.id) : null,
      name: station.name ?? station.id,
      location: clone(station.location),
    })),
    legTemplate: {
      sourceKind: "existing",
      planId: plan.planId,
      projectId: project.id,
      ...(ownerId ? { infrastructureOwnerId: ownerId } : {}),
    },
  };
}

function plannedSource(plan) {
  return {
    sourceId: `plan:${plan.planId}`,
    sourceKind: "planned",
    name: plan.name ?? plan.planId,
    connectedPlanId: plan.planId,
    connectedProjectId: null,
    externalNetworkId: null,
    externalLineId: null,
    infrastructureOwnerId: null,
    infrastructureStatus: "planning",
    operationalLineId: null,
    selectable: true,
    operationReady: false,
    stations: plan.stationCandidates.map((station) => ({
      stationId: station.id,
      operationalStationId: null,
      name: station.name ?? station.id,
      location: clone(station.location),
    })),
    legTemplate: { sourceKind: "planned", planId: plan.planId },
  };
}

function externalSource(network, line, operationalState) {
  const stations = new Map((network.stations ?? []).map((station) => [station.id, station]));
  const operationalLines = operationalState?.lines ?? [];
  const explicitLine = operationalLines.find((candidate) => candidate.external === true
    && candidate.externalNetworkId === network.id && candidate.externalLineId === line.id);
  // Save v1 predates the explicit external ids. Its exact ordered station path is stable enough to migrate;
  // names and array positions are deliberately not used. An ambiguous path remains unlinked.
  const legacyMatches = explicitLine ? [] : operationalLines.filter((candidate) => candidate.external === true
    && candidate.externalNetworkId === undefined && candidate.externalLineId === undefined
    && Array.isArray(candidate.stationIds) && candidate.stationIds.join("\u0000") === line.stationIds.join("\u0000"));
  const operationalLine = explicitLine ?? (legacyMatches.length === 1 ? legacyMatches[0] : null);
  const sourceOwner = text(line.infrastructureOwnerId) ?? text(network.infrastructureOwnerId);
  return {
    sourceId: `external:${network.id}/${line.id}`,
    sourceKind: "external",
    name: line.name ?? line.id,
    connectedPlanId: null,
    connectedProjectId: null,
    externalNetworkId: network.id,
    externalLineId: line.id,
    infrastructureOwnerId: sourceOwner,
    infrastructureStatus: null,
    operationalLineId: operationalLine ? String(operationalLine.id) : null,
    selectable: true,
    operationReady: Boolean(operationalLine),
    stations: line.stationIds.map((stationId) => ({
      stationId,
      operationalStationId: operationalLine?.stationIds.includes(stationId) ? stationId : null,
      name: stations.get(stationId)?.name ?? stationId,
      location: clone(stations.get(stationId)?.location ?? null),
    })),
    legTemplate: {
      sourceKind: "external",
      externalNetworkId: network.id,
      externalLineId: line.id,
      ...(sourceOwner ? { infrastructureOwnerId: sourceOwner } : {}),
    },
  };
}

function planningContext({ pack, mapExport, projects = [] }) {
  requireMapExport(pack, mapExport);
  const builtPlans = new Map();
  for (const project of projects) {
    const plan = project?.planGeometry;
    if (plan?.schema === "transitline.plan-geometry/1" && plan.planId && !builtPlans.has(plan.planId)) builtPlans.set(plan.planId, plan);
  }
  const plans = [...builtPlans.values()];
  for (const plan of mapExport.plans ?? []) if (!builtPlans.has(plan.planId)) plans.push(plan);
  return { plans, externalNetworks: mapExport.externalNetworks ?? [] };
}

export function buildThroughRouteSourceCatalog({
  pack,
  mapExport,
  projects = [],
  operationalState = null,
  playerOperatorId = "player",
} = {}) {
  const context = planningContext({ pack, mapExport, projects });
  const builtPlanIds = new Set();
  const sources = [];
  for (const project of projects) {
    const source = projectSource(project, playerOperatorId, operationalState);
    if (!source) continue;
    sources.push(source);
    builtPlanIds.add(source.connectedPlanId);
  }
  for (const plan of mapExport.plans ?? []) if (!builtPlanIds.has(plan.planId)) sources.push(plannedSource(plan));
  for (const network of context.externalNetworks) for (const line of network.lines ?? []) sources.push(externalSource(network, line, operationalState));
  return {
    schema: THROUGH_ROUTE_SOURCE_CATALOG_SCHEMA,
    contractVersion: 1,
    packId: pack.manifest.id,
    packVersion: pack.manifest.version ?? null,
    sources: sources.sort(byId),
  };
}

// selection: { key, name?, legs: [{ sourceId, direction?: "forward"|"reverse" }] }
// The adapter only resolves stable source ids into the pure map contract. It never decides compatibility,
// access rights, capacity, money or whether the service may be approved.
export function buildThroughRouteFromSelection(selection, options = {}) {
  const { pack, mapExport, projects = [] } = options;
  const catalog = buildThroughRouteSourceCatalog(options);
  const bySource = new Map(catalog.sources.map((source) => [source.sourceId, source]));
  if (!text(selection?.key)) throw new Error("A stable through-route key is required");
  if (!Array.isArray(selection?.legs) || selection.legs.length < 2) throw new Error("A through route requires at least two selected legs");
  const drawn = {
    key: selection.key,
    name: selection.name ?? null,
    legs: selection.legs.map((selected, sequence) => {
      const source = bySource.get(selected?.sourceId);
      if (!source) throw new Error(`Unknown through-route source ${selected?.sourceId}`);
      const direction = selected.direction ?? "forward";
      if (!["forward", "reverse"].includes(direction)) throw new Error(`Invalid through-route direction ${direction}`);
      const first = source.stations[0]?.stationId;
      const last = source.stations.at(-1)?.stationId;
      if (!first || !last || first === last) throw new Error(`Through-route source ${source.sourceId} has no usable station range`);
      return {
        ...clone(source.legTemplate),
        sequence,
        key: source.sourceId,
        fromStationId: direction === "forward" ? first : last,
        toStationId: direction === "forward" ? last : first,
      };
    }),
  };
  const context = planningContext({ pack, mapExport, projects });
  const result = buildThroughRoute(drawn, { pack, ...context });
  if (!result.route) {
    const codes = result.warnings.map((warning) => warning.code).join(", ");
    throw new Error(`Through route was rejected${codes ? `: ${codes}` : ""}`);
  }
  return { selection: clone(selection), route: result.route, warnings: result.warnings, catalog };
}

function sourceForLeg(leg, catalog) {
  if (leg.sourceKind === "existing") return catalog.sources.find((source) => source.sourceKind === "existing"
    && source.connectedProjectId === leg.connectedProjectId && source.connectedPlanId === leg.connectedPlanId) ?? null;
  if (leg.sourceKind === "external") return catalog.sources.find((source) => source.sourceKind === "external"
    && source.externalNetworkId === leg.externalNetworkId && source.externalLineId === leg.externalLineId) ?? null;
  return null;
}

function serviceLegFor(routeLeg, service) {
  return (service.legs ?? []).find((leg) => leg.legId === routeLeg.legId) ?? null;
}

function unionIds(left, right) {
  return [...new Set([...left, ...right])].sort();
}

// Turns an approved route's spatial sequence into the existing simulator's station/access arrays. A handover
// may collapse two asset ids onto one stop only when ThroughRouteGeometry already proves that their track
// endpoints are at the exact same point. Unknown or separated handovers fail closed.
export function buildThroughOperationDraft({ route, throughService, sourceCatalog, operationalState, name = null } = {}) {
  if (route?.schema !== "transitline.through-route-geometry/1" || route.contractVersion !== 1) throw new Error("ThroughRouteGeometry v1 is required");
  if (throughService?.schema !== "transitline.through-service/1" || throughService.contractVersion !== 1) throw new Error("ThroughService v1 is required");
  if (throughService.throughRouteId !== route.throughRouteId) throw new Error("Through service is linked to another route");
  if (throughService.routeGeometryRevision !== route.geometryRevision) throw new Error("Through service route revision is stale");
  if (sourceCatalog?.schema !== THROUGH_ROUTE_SOURCE_CATALOG_SCHEMA || sourceCatalog.packId !== route.sourcePackId) throw new Error("Matching through-route source catalog is required");
  const stationIds = [];
  const segmentAccessAgreementIds = [];
  const stationAccessAgreementIds = [];
  const legRanges = [];
  for (let index = 0; index < route.legs.length; index += 1) {
    const routeLeg = route.legs[index];
    if (routeLeg.sourceKind === "planned") throw new Error(`Leg ${routeLeg.legId} is not built`);
    const source = sourceForLeg(routeLeg, sourceCatalog);
    if (!source?.operationReady || !source.operationalLineId) throw new Error(`Leg ${routeLeg.legId} has no commissioned operational source`);
    const sourceStations = new Map(source.stations.map((station) => [station.stationId, station]));
    const operationalIds = routeLeg.stationIds.map((stationId) => sourceStations.get(stationId)?.operationalStationId ?? null);
    if (operationalIds.some((id) => !id || !operationalState?.stations?.has(id))) throw new Error(`Leg ${routeLeg.legId} has an unresolved operational station`);
    const serviceLeg = serviceLegFor(routeLeg, throughService);
    if (!serviceLeg) throw new Error(`Through service has no assessment for leg ${routeLeg.legId}`);
    const agreementId = serviceLeg.trackAccessAgreementId ?? null;
    const stopAccess = agreementId ? [agreementId] : [];
    const startIndex = stationIds.length === 0 ? 0 : stationIds.length - 1;
    if (index === 0) {
      for (let stationIndex = 0; stationIndex < operationalIds.length; stationIndex += 1) {
        if (stationIndex > 0) segmentAccessAgreementIds.push(agreementId);
        stationIds.push(operationalIds[stationIndex]);
        stationAccessAgreementIds.push([...stopAccess]);
      }
    } else {
      const handover = route.handovers[index - 1];
      if (!handover || handover.fromLegId !== route.legs[index - 1].legId || handover.toLegId !== routeLeg.legId) throw new Error("Through route handover order is invalid");
      if (handover.physicalConnection !== true && handover.connectionState !== "joined") throw new Error(`Handover ${handover.handoverId} is not physically confirmed`);
      // The route fact proves these are the same physical point. Keep the preceding asset as the simulator's
      // canonical stop and merge both owners' station-access obligations onto it.
      stationAccessAgreementIds[stationAccessAgreementIds.length - 1] = unionIds(stationAccessAgreementIds.at(-1), stopAccess);
      for (let stationIndex = 1; stationIndex < operationalIds.length; stationIndex += 1) {
        segmentAccessAgreementIds.push(agreementId);
        stationIds.push(operationalIds[stationIndex]);
        stationAccessAgreementIds.push([...stopAccess]);
      }
    }
    legRanges.push({
      legId: routeLeg.legId,
      operationalLineId: source.operationalLineId,
      fromStationIndex: startIndex,
      toStationIndex: stationIds.length - 1,
      trackAccessAgreementId: agreementId,
    });
  }
  if (stationIds.length < 2 || segmentAccessAgreementIds.length !== stationIds.length - 1 || stationAccessAgreementIds.length !== stationIds.length) {
    throw new Error("Through operation draft has inconsistent station and segment mappings");
  }
  return {
    schema: THROUGH_OPERATION_DRAFT_SCHEMA,
    contractVersion: 1,
    throughServiceId: throughService.throughServiceId,
    throughRouteId: route.throughRouteId,
    routeGeometryRevision: route.geometryRevision,
    name: name ?? route.name ?? `Through ${throughService.throughServiceId}`,
    stationIds,
    segmentAccessAgreementIds,
    stationAccessAgreementIds,
    legRanges,
  };
}

function routeStore(state) {
  if (!state || typeof state !== "object") throw new Error("Operational state is required");
  state.throughRoutePlans ??= [];
  return state.throughRoutePlans;
}

export function saveThroughRouteSelection(state, selection, options = {}) {
  const built = buildThroughRouteFromSelection(selection, options);
  const store = routeStore(state);
  const entry = {
    key: selection.key,
    selection: built.selection,
    route: clone(built.route),
  };
  const index = store.findIndex((candidate) => candidate.key === entry.key);
  if (index < 0) store.push(entry);
  else store[index] = entry;
  store.sort((a, b) => String(a.key).localeCompare(String(b.key)));
  return clone(entry);
}

export function removeThroughRouteSelection(state, key, linkedThroughServices = []) {
  const store = routeStore(state);
  const entry = store.find((candidate) => candidate.key === key);
  if (!entry) return false;
  if (linkedThroughServices.some((service) => service.throughRouteId === entry.route.throughRouteId)) {
    throw new Error("A route linked to a through service cannot be removed");
  }
  store.splice(store.indexOf(entry), 1);
  return true;
}

export function throughRoutePlanningReport(state, options = {}) {
  const catalog = buildThroughRouteSourceCatalog(options);
  return {
    catalog,
    routes: clone(state?.throughRoutePlans ?? []),
  };
}
