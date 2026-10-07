// A small synthetic world run through the REAL engine path (map access export -> applyStationDemandAccess -> a player policy ->
// applyStationDemandAllocation), used by the allocation-overlay tests, the example generator and the browser check.  It touches no
// file system (so it also loads in a browser) and says nothing about any real place: node:a lies between two access sites (Alpha and
// Beta) whose catchments overlap, node:b is Beta's alone, node:c is nobody's.
import { applyStationDemandAccess, stationDemandAccessApplicationReport } from "../../engine/src/station-demand-access-integration.mjs";
import { applyStationDemandAllocation, stationDemandAllocationApplicationReport } from "../../engine/src/station-demand-allocation-integration.mjs";
import { addLine, createState } from "../../engine/src/state.mjs";

export const ALLOCATION_VARIANTS = Object.freeze(["split", "partial", "blocked", "held", "unknown", "stale", "whole"]);
export const OVERLAY_PACK_ID = "allocation-overlay";

export const overlayPack = () => ({ manifest: { id: OVERLAY_PACK_ID, version: "1", origin: [139.01, 35], data: { license: "CC0-1.0", attribution: [] } }, demand: { model: "gravity", points: [
  { id: "node:a", location: [139.007, 35.0013], residents: 4000, jobs: 100 },
  { id: "node:b", location: [139.013, 34.9989], residents: 3000, jobs: 0 },
  { id: "node:c", location: [139.02, 35.001], residents: 200, jobs: 5000 },
], attractors: [] } });
const rect = (lon, lat) => [[lon - 0.006, lat - 0.0035], [lon + 0.006, lat - 0.0035], [lon + 0.006, lat + 0.0035], [lon - 0.006, lat + 0.0035]];
const lineOptions = { frequency: { high: 30, medium: 30, low: 30, veryLow: 30 } };

export function accessExport({ revisions = { a: "access:a:r1", b: "access:b:r1" }, coarse = false, onlyA = false } = {}) {
  const site = (key, name, source, lon, nodes) => {
    const stationAccessId = `access:${key}`;
    return {
      schema: "transitline.station-demand-access-geometry/1", contractVersion: 1, stationAccessId, stationAccessRevision: revisions[key], name, sourcePackId: OVERLAY_PACK_ID, sourcePackVersion: "1",
      location: [lon, 35], connectedPlanId: `plan:${key}`, connectedStationId: source, connectedNetworkId: `plan:${key}`,
      demandSourceRefs: [coarse ? { sourceId: "demand", kind: "demand-points", quality: "low", spatialResolution: "municipality-centroid" } : { sourceId: "demand", kind: "demand-points", quality: "medium", spatialResolution: "individual-demand-node" }],
      entrances: [], accessPoints: [],
      catchments: [{ catchmentId: `catch:${key}`, polygon: rect(lon + (key === "a" ? 0.002 : -0.002), 35), demandNodeIdsInside: nodes }],
      demandZones: [{ demandZoneId: `zone:${key}`, centroid: [139.01, 35], demandNodeRefs: nodes.map((id) => ({ demandNodeId: id, location: id === "node:a" ? [139.007, 35.0013] : [139.013, 34.9989] })), drawnConnection: { connected: true } }],
      walkLinks: [{ walkLinkId: `walk:${key}`, from: { kind: "station", id: stationAccessId }, to: { kind: "demand-zone", id: `zone:${key}` }, alignment: [[lon, 35], [139.01, 35]], lengthMeters: key === "a" ? 320 : 480, crossings: { river: 0, railway: 0, building: 0 }, unknownReasons: {} }],
      transfers: [],
    };
  };
  const sites = onlyA ? [site("a", "Alpha", "source:a", 139.004, ["node:a"])] : [site("a", "Alpha", "source:a", 139.004, ["node:a"]), site("b", "Beta", "source:b", 139.01, ["node:a", "node:b"])];
  return {
    schema: "transitline.station-demand-access-export/1", contractVersion: 1, packId: OVERLAY_PACK_ID, packVersion: "1",
    catchmentOverlaps: onlyA ? [] : [{ stationAccessIds: ["access:a", "access:b"], catchmentIds: ["catch:a", "catch:b"] }], sites,
  };
}

const POLICY = (rules, defaults = { exclusive: "assign" }) => ({ schema: "transitline.station-demand-allocation-policy/1", contractVersion: 1, policyId: "policy:overlay", defaults: { shared: "hold", areaNodeInclusion: "reject", ...defaults }, rules });
const splitRule = (shares) => ({ ruleId: "rule:split", scope: { stationAccessIds: ["access:a", "access:b"] }, boundTo: { "access:a": "access:a:r1", "access:b": "access:b:r1" }, mode: "fixed-shares", shares });

export function overlayWorld() {
  const state = createState(overlayPack(), { seed: 7 });
  for (const [id, lon, source] of [["physical:a", 139.004, "source:a"], ["physical:b", 139.01, "source:b"], ["physical:z", 139.018, "source:z"]]) state.stations.set(id, { id, location: [lon, 35], status: "available", sourceStationId: source });
  addLine(state, ["physical:a", "physical:z"], lineOptions);
  addLine(state, ["physical:b", "physical:z"], lineOptions);
  return state;
}

// -> { variant, pack, state, report, access, demandNodes, stations }: exactly what a host would give the overlay.
export function buildAppliedWorld(variant) {
  if (!ALLOCATION_VARIANTS.includes(variant)) throw new Error(`Unknown variant ${variant}`);
  const pack = overlayPack();
  const state = overlayWorld();
  if (variant === "blocked") { state.stations.delete("physical:b"); state.lines = state.lines.filter((l) => !l.stationIds.includes("physical:b")); state.networkDirty = true; }
  applyStationDemandAccess(state, { stationDemandAccess: accessExport({ coarse: variant === "unknown", onlyA: variant === "whole" }), pack });
  const policy = variant === "whole" || variant === "held" ? POLICY([]) : POLICY([splitRule(variant === "partial" ? { "access:a": 0.5, "access:b": 0.2 } : { "access:a": 0.6, "access:b": 0.4 })]);
  applyStationDemandAllocation(state, { policy });
  if (variant === "stale") applyStationDemandAccess(state, { stationDemandAccess: accessExport({ revisions: { a: "access:a:r2", b: "access:b:r1" } }), pack });
  return { variant, pack, state, report: stationDemandAllocationApplicationReport(state), access: stationDemandAccessApplicationReport(state), demandNodes: [...state.demandNodes.values()], stations: [...state.stations.values()] };
}
