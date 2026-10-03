import { buildThroughRoute } from "./map/through-route.mjs";

export const THROUGH_ROUTE_SOURCE_CATALOG_SCHEMA = "transitline.through-route-source-catalog/1";

const clone = (value) => structuredClone(value);
const text = (value) => (typeof value === "string" && value.trim() ? value.trim() : null);
const byId = (a, b) => a.sourceId.localeCompare(b.sourceId);

function requireMapExport(pack, mapExport) {
  const packId = pack?.manifest?.id ?? null;
  if (!packId) throw new Error("A city pack is required for through-route planning");
  if (mapExport?.schema !== "transitline.map-export/1") throw new Error("MapExport v1 is required for through-route planning");
  if (mapExport.packId !== packId) throw new Error(`Map export belongs to pack ${mapExport.packId}, not ${packId}`);
}

function projectSource(project, playerOperatorId) {
  const plan = project?.planGeometry;
  if (plan?.schema !== "transitline.plan-geometry/1" || !plan.planId) return null;
  const stationAssets = new Map((project.assets ?? [])
    .filter((asset) => asset.kind === "station" && asset.sourceId)
    .map((asset) => [asset.sourceId, asset.id]));
  const ownerId = text(project.infrastructureOwnerId) ?? text(playerOperatorId);
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
    operationalLineId: project.commissionedLineId === undefined ? null : String(project.commissionedLineId),
    selectable: true,
    operationReady: project.status === "available" && project.commissionedLineId !== undefined,
    stations: plan.stationCandidates.map((station) => ({
      stationId: station.id,
      operationalStationId: stationAssets.get(station.id) ?? null,
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
    const source = projectSource(project, playerOperatorId);
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
