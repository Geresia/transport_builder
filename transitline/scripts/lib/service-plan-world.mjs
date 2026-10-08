// A small synthetic world for the service plan editor UI: two plans along lat 35 (a: 2 sections, b: 2 sections), an existing
// line E1 drawn one row north (station level only, no alignment), and a RailCapacityGeometry over all of it with the track
// facts a player might have stated. It runs through the REAL map pipeline (buildMapExport -> buildRailGeometry), touches no file
// system (so it also loads in a browser) and says nothing about any real place.
import { buildMapExport } from "../../engine/src/map/plan-geometry.mjs";
import { stableId } from "../../engine/src/map/ids.mjs";
import { buildRailGeometry, planRevisionOf } from "../../engine/src/map/rail-capacity-geometry.mjs";

export const WORLD_VARIANTS = Object.freeze(["base", "bare", "next"]);
export const WORLD_PACK_ID = "service-plan-ui";
const EXT = "ext-line:42";

export const worldPack = (packId = WORLD_PACK_ID) => ({
  manifest: { id: packId, version: "1", origin: [139.02, 35.001], data: { license: "CC0-1.0", attribution: ["synthetic"] } },
  demand: { points: ["d0", "d1", "d2", "d3", "d4"].map((id, i) => ({ id, name: id, location: [139 + i * 0.01, 35.003] })) },
  existingNetwork: { lines: [{ name: "E1", operator: "Operator X", osmRelationId: 42, stationIds: ["d1", "d2", "d3"] }] },
});
const line = (key, pts) => ({ key, name: key, vertices: pts.map((location) => ({ location, platformType: "side" })) });
const ref = (plan, i) => ({ planId: plan.planId, segmentId: plan.segments[i].id });
const boundary = (key, plan, i, alongMeters) => ({ key, planId: plan.planId, segmentId: plan.segments[i].id, measuredFromStationId: plan.segments[i].from, alongMeters, basis: "player" });
const sectionOf = (g, plan, i) => g.sections.find((s) => s.planId === plan.planId && s.segmentId === plan.segments[i].id);

// variant: "base" (terminals and block boundaries stated), "bare" (nothing stated about tracks), "next" (base plus one more block boundary: another revision)
export function buildServicePlanWorld(variant = "base", packId = WORLD_PACK_ID) {
  if (!WORLD_VARIANTS.includes(variant)) throw new Error(`Unknown variant ${variant}`);
  const pack = worldPack(packId);
  const mapExport = buildMapExport({ pack, mode: "existing", drawnLines: [line("a", [[139, 35], [139.01, 35], [139.02, 35]]), line("b", [[139.02, 35], [139.03, 35], [139.04, 35]])] });
  const A = mapExport.plans.find((x) => x.planId === stableId("plan", packId, "key", "a"));
  const B = mapExport.plans.find((x) => x.planId === stableId("plan", packId, "key", "b"));
  const a0 = A.segments[0].from;
  const stated = variant !== "bare";
  const design = {
    key: "g", name: "Synthetic rail geometry", planIds: [A.planId, B.planId], externalLineIds: [EXT],
    designedRevisions: { plans: { [A.planId]: planRevisionOf(A), [B.planId]: planRevisionOf(B) }, routes: {} },
    sectionFacts: stated ? [{ ref: ref(A, 1), directionMode: "single", basis: "player" }, { ref: ref(B, 0), directionMode: "double", basis: "player" }] : [],
    ...(stated ? { blockBoundaries: [boundary("b1", A, 0, 300), boundary("b2", A, 0, 600), ...(variant === "next" ? [boundary("b3", B, 0, 500)] : [])] } : {}),
    ...(stated ? { terminals: [
      { key: "t-a0", stationId: a0, platforms: [{ key: "p0", approach: ref(A, 0), polyline: [[139, 35], [138.9985, 35]], platformLengthMeters: 120 }], turnbackTracks: [{ key: "tb0", kind: "turnback", polyline: [[139, 35], [138.9988, 35.0003]] }] },
      { key: "t-b2", stationId: B.segments[1].to, platforms: [], turnbackTracks: [{ key: "far", kind: "stabling", polyline: [[139.04, 35.002], [139.0415, 35.002]] }] },
    ] } : {}),
  };
  const out = buildRailGeometry(design, { pack, plans: mapExport.plans, externalNetworks: mapExport.externalNetworks });
  if (!out.design) throw new Error(`rail geometry rejected ${JSON.stringify(out.warnings)}`);
  const G = out.design;
  const ext = G.sections.filter((s) => s.sourceKind === "external").sort((x, y) => (x.fromStationId < y.fromStationId ? -1 : 1));
  const application = {
    schema: "transitline.rail-capacity-application/1", contractVersion: 1, applicationId: `rail-capacity-application:${G.railGeometryId}`, operationalLineId: "line:1",
    railGeometryId: G.railGeometryId, railGeometryRevision: G.railGeometryRevision, sections: G.sections.map((s, i) => ({ trackSegmentId: `track-segment:${i + 1}`, railCapacitySectionId: s.sectionId })),
  };
  return {
    variant, pack, G, application, geometries: [G], applications: [application],
    A, B, A0: sectionOf(G, A, 0), A1: sectionOf(G, A, 1), B0: sectionOf(G, B, 0), B1: sectionOf(G, B, 1), E1: ext[0], E2: ext[1],
    stations: { a0, a1: A.segments[0].to, a2: A.segments[1].to, b2: B.segments[1].to },
    vehicleModels: [{ id: "vehicle-model:8-car", name: "8-car set" }, { id: "vehicle-model:4-car", name: "4-car set" }],
    depots: [{ id: "depot:north", name: "North depot" }],
    terminalId: (key) => G.terminals?.find((t) => t.key === key)?.terminalResourceId ?? null,
  };
}
