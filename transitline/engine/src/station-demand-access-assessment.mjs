// B15-E1: engine-side interpretation of StationDemandAccessGeometry.
//
// The map contract deliberately contains no population values.  This module is
// the first place that may look up a demand node's residents/jobs, and it does
// so conservatively: a ward/municipality centroid is never treated as the
// population of a hand-drawn station catchment.  It produces inputs for a
// later allocation/ridership step; it does not create passengers or choose
// routes.

export const STATION_DEMAND_ACCESS_INPUT_SCHEMA = "transitline.station-demand-access-input/1";
export const STATION_DEMAND_ACCESS_EXPORT_SCHEMA = "transitline.station-demand-access-export/1";

const LOCAL_RESOLUTIONS = new Set([
  "individual-demand-node", "point", "node", "building", "parcel", "block", "mesh-250m", "mesh-500m",
]);
const COARSE_RESOLUTION = /(municipality|ward|city|prefecture|district|centroid)/i;
const byText = (a, b) => String(a).localeCompare(String(b));
const finiteNonNegative = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;

function packIdentity(pack) {
  return {
    id: pack?.manifest?.id ?? pack?.id ?? null,
    version: pack?.manifest?.version ?? pack?.version ?? null,
  };
}

function requireAccessExport(access, pack) {
  if (!access || access.schema !== STATION_DEMAND_ACCESS_EXPORT_SCHEMA || access.contractVersion !== 1) {
    throw new Error("StationDemandAccessExport v1 is required");
  }
  const identity = packIdentity(pack);
  if (!identity.id) throw new Error("A CityPack id is required");
  if (access.packId !== identity.id) throw new Error("Station demand access belongs to another pack");
  if (identity.version !== null && access.packVersion !== identity.version) throw new Error("Station demand access pack version does not match");
  if (!Array.isArray(access.sites) || !Array.isArray(access.catchmentOverlaps)) throw new Error("Station demand access export is incomplete");
  return identity;
}

function sourceAssessment(site) {
  const sources = Array.isArray(site.demandSourceRefs) ? site.demandSourceRefs.filter((source) => source?.kind === "demand-points") : [];
  if (!sources.length) return { status: "unknown", sourceIds: [], reason: "demand-points-source-missing" };
  const sourceIds = sources.map((source) => source.sourceId).filter(Boolean).sort(byText);
  for (const source of sources) {
    if (!source.sourceId) return { status: "unknown", sourceIds, reason: "demand-points-source-id-missing" };
    if (!["high", "medium"].includes(source.quality)) return { status: "unknown", sourceIds, reason: "demand-source-quality-insufficient" };
    if (typeof source.spatialResolution !== "string") return { status: "unknown", sourceIds, reason: "demand-source-resolution-unknown" };
    if (COARSE_RESOLUTION.test(source.spatialResolution)) return { status: "unknown", sourceIds, reason: "demand-source-coarse" };
    if (!LOCAL_RESOLUTIONS.has(source.spatialResolution)) return { status: "unknown", sourceIds, reason: "demand-source-resolution-unapproved" };
  }
  return { status: "available", sourceIds, reason: null };
}

function nodeIndex(demand) {
  const index = new Map();
  for (const node of demand?.points ?? []) if (node?.id && !index.has(node.id)) index.set(node.id, node);
  return index;
}

function overlapIndex(overlaps) {
  const result = new Map();
  for (const overlap of overlaps) {
    const stationIds = Array.isArray(overlap?.stationAccessIds) ? [...new Set(overlap.stationAccessIds)].sort(byText) : [];
    const catchmentIds = Array.isArray(overlap?.catchmentIds) ? [...new Set(overlap.catchmentIds)].sort(byText) : [];
    if (stationIds.length !== 2 || catchmentIds.length !== 2) continue;
    for (let index = 0; index < 2; index++) {
      const stationAccessId = stationIds[index];
      const entry = result.get(stationAccessId) ?? [];
      entry.push({ catchmentId: catchmentIds[index], otherStationAccessId: stationIds[1 - index], otherCatchmentId: catchmentIds[1 - index] });
      result.set(stationAccessId, entry);
    }
  }
  for (const list of result.values()) list.sort((a, b) => byText(`${a.catchmentId}|${a.otherStationAccessId}`, `${b.catchmentId}|${b.otherStationAccessId}`));
  return result;
}

function sumKnown(rows, field) {
  if (rows.some((row) => row[field] === null)) return null;
  return rows.reduce((total, row) => total + row[field], 0);
}

function assessSite(site, rawNodes, overlapsByStation) {
  const catchments = Array.isArray(site.catchments) ? site.catchments : [];
  const source = sourceAssessment(site);
  const overlaps = overlapsByStation.get(site.stationAccessId) ?? [];
  const overlapCatchments = new Set(overlaps.map((entry) => entry.catchmentId));
  const nodes = new Map();
  for (const catchment of catchments) {
    for (const demandNodeId of catchment?.demandNodeIdsInside ?? []) {
      if (!nodes.has(demandNodeId)) nodes.set(demandNodeId, { demandNodeId, catchmentIds: [] });
      nodes.get(demandNodeId).catchmentIds.push(catchment.catchmentId);
    }
  }
  const inputs = [...nodes.values()].map((entry) => {
    const catchmentIds = [...new Set(entry.catchmentIds)].sort(byText);
    const sharedWithStationAccessIds = [...new Set(overlaps.filter((overlap) => catchmentIds.includes(overlap.catchmentId)).map((overlap) => overlap.otherStationAccessId))].sort(byText);
    const shared = sharedWithStationAccessIds.length > 0;
    const raw = rawNodes.get(entry.demandNodeId) ?? null;
    let status = source.status === "available" ? (shared ? "shared" : "available") : "unknown";
    let reason = source.reason;
    let residents = null;
    let jobs = null;
    if (source.status === "available" && !raw) {
      status = "unknown";
      reason = "demand-node-missing-from-pack";
    } else if (source.status === "available") {
      residents = finiteNonNegative(raw.residents) ? raw.residents : null;
      jobs = finiteNonNegative(raw.jobs) ? raw.jobs : null;
      if (residents === null || jobs === null) {
        status = "unknown";
        reason = "demand-node-values-missing";
        // A partial node must not contribute one side of a trip calculation.
        // Keep the input atomic until the pack supplies both values.
        residents = null;
        jobs = null;
      }
    }
    return { demandNodeId: entry.demandNodeId, catchmentIds, sourceIds: source.sourceIds, status, reason, residents, jobs, sharedWithStationAccessIds };
  }).sort((a, b) => byText(a.demandNodeId, b.demandNodeId));
  const exclusive = inputs.filter((entry) => entry.status === "available");
  const shared = inputs.filter((entry) => entry.status === "shared");
  const unknown = inputs.filter((entry) => entry.status === "unknown");
  const coverage = !catchments.length ? "not-drawn" : !inputs.length ? "empty" : unknown.length ? "unknown" : shared.length ? "shared" : "available";
  return {
    stationAccessId: site.stationAccessId,
    stationAccessRevision: site.stationAccessRevision,
    connectedPlanId: site.connectedPlanId ?? null,
    connectedStationId: site.connectedStationId ?? null,
    catchmentStatus: coverage,
    catchmentIds: catchments.map((catchment) => catchment.catchmentId).filter(Boolean).sort(byText),
    sourceAssessment: source,
    demandNodeInputs: inputs,
    totals: {
      exclusive: { residents: sumKnown(exclusive, "residents"), jobs: sumKnown(exclusive, "jobs") },
      sharedCandidate: { residents: sumKnown(shared, "residents"), jobs: sumKnown(shared, "jobs") },
      allocated: null,
    },
    allocationStatus: shared.length ? "policy-required" : unknown.length ? "inputs-incomplete" : "not-allocated",
    unknownReasons: [...new Set(unknown.map((entry) => entry.reason).filter(Boolean))].sort(byText),
  };
}

// `demand` is the CityPack demand document, normally `pack.demand`.
// Values are exposed only after source-resolution checks.  Shared catchments
// are intentionally left unallocated: B15-E2 owns that policy.
export function assessStationDemandAccess({ stationDemandAccess, pack, demand = pack?.demand } = {}) {
  const identity = requireAccessExport(stationDemandAccess, pack);
  const rawNodes = nodeIndex(demand);
  const overlapsByStation = overlapIndex(stationDemandAccess.catchmentOverlaps);
  const sites = stationDemandAccess.sites.map((site) => assessSite(site, rawNodes, overlapsByStation)).sort((a, b) => byText(a.stationAccessId, b.stationAccessId));
  const unallocatedOverlaps = [...overlapsByStation.entries()].flatMap(([stationAccessId, entries]) => entries.map((entry) => ({ stationAccessId, ...entry }))).sort((a, b) => byText(`${a.stationAccessId}|${a.catchmentId}`, `${b.stationAccessId}|${b.catchmentId}`));
  return {
    schema: STATION_DEMAND_ACCESS_INPUT_SCHEMA,
    contractVersion: 1,
    sourcePackId: identity.id,
    sourcePackVersion: identity.version,
    demandModel: typeof demand?.model === "string" ? demand.model : null,
    sites,
    unallocatedOverlaps,
  };
}
