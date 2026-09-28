// Dev-time generator for the ConstructionImpactGeometry examples in packs/<id>/construction-impact-examples/.
//   node scripts/build-construction-impact-examples.mjs [packId]
//
// Each example is a construction event the way the management engine would report it (eventId/eventKind/location
// or a linked candidate id), evaluated against the pack's own shipped construction-examples/*.construction.json
// (already-built ConstructionSiteGeometry sites). Layers are decoded the same way build-construction-examples.mjs
// decodes them for the affected area around the event; a layer that cannot be loaded is skipped and its fields
// come out unknown (null) — never 0.
import fs from "node:fs";
import path from "node:path";
import { buildConstructionImpactExport } from "../engine/src/map/construction-impact.mjs";
import { makeSpatialContext } from "../engine/src/map/spatial.mjs";
import { root, readJson, loadPack, tokyoSpatial, tokyoDepotLayers } from "./lib/pack-spatial.mjs";
import { syntheticLayers } from "./lib/synthetic-layers.mjs";

const sitesOf = (pack) => {
  const dir = path.join(root, pack.dir, "construction-examples");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".construction.json")).sort();
  const sites = files.map((f) => readJson(`${pack.dir}/construction-examples/${f}`));
  const byKey = new Map(sites.map((s) => [s.source.drawnPackage.key.replace(/^example:[a-z-]+:/, ""), s]));
  return { sites, byKey };
};
const bboxAround = ([lon, lat], m) => { const d = m / 111320; return [lon - d * 1.25, lat - d, lon + d * 1.25, lat + d]; };
// materialYard/workArea candidates are areas (polygon only); accessRoad/vehicleAccess/shaft candidates are points (location).
const centreOf = (c) => c.location ?? c.polygon.reduce((s, p) => [s[0] + p[0] / c.polygon.length, s[1] + p[1] / c.polygon.length], [0, 0]);

// spec: { file, eventId, eventKind, siteKey, candidateRef?, location?, selectedResponseCandidateId?, layers?: () => layers, layerSource }
async function produce(pack, constructionExport, spec) {
  const layers = (await spec.layers?.()) ?? {};
  const spatial = makeSpatialContext(layers);
  const event = { eventId: spec.eventId, eventKind: spec.eventKind, constructionSiteId: spec.constructionSiteId, location: spec.location, candidateRef: spec.candidateRef, selectedResponseCandidateId: spec.selectedResponseCandidateId };
  const out = buildConstructionImpactExport({ pack, constructionExport, spatial, events: [event] });
  if (!out.impacts[0]) throw new Error(`[${spec.file}] produced no impact: ${JSON.stringify(out.warnings)}`);
  return { ...out.impacts[0], source: { drawnEvent: structuredClone(event), layers: spec.layerSource, generatedBy: "scripts/build-construction-impact-examples.mjs" } };
}

const EXAMPLES = {
  tokyo: async (pack, byKey) => {
    const base = tokyoSpatial(pack).layers;
    const layersAt = (centre, radius = 2000) => tokyoDepotLayers(pack, bboxAround(centre, radius), base);
    const src = { kind: "tokyo-pack-layers", layers: ["dem", "water", "roads", "buildings", "residential", "railFacilities"] };
    const tunnel = byKey.get("cons-tunnel-ordinary");
    const viaduct = byKey.get("cons-viaduct-residential");
    const cutCover = byKey.get("cons-cutcover-narrow");
    const deepShaft = byKey.get("cons-deep-shaft");
    const depot = byKey.get("cons-depot-ota");
    const partial = byKey.get("cons-partial-data");
    const near1 = viaduct.workAreaCandidates[0].polygon[0];

    return [
      { file: "01-tunnel-incident-shaft", eventId: "example:tokyo:impact-tunnel-incident", eventKind: "incident", constructionSiteId: tunnel.constructionSiteId, candidateRef: { kind: "shaft", id: tunnel.shaftCandidates[0].shaftId }, layers: () => layersAt(tunnel.shaftCandidates[0].location, 1200), layerSource: src },
      { file: "02-viaduct-complaint-residential", eventId: "example:tokyo:impact-viaduct-complaint", eventKind: "complaint", constructionSiteId: viaduct.constructionSiteId, location: near1, layers: () => layersAt(near1, 1200), layerSource: src },
      { file: "03-cutcover-access-blocked", eventId: "example:tokyo:impact-cutcover-access-blocked", eventKind: "access-blocked", constructionSiteId: cutCover.constructionSiteId, candidateRef: { kind: "accessRoad", id: cutCover.accessRoadCandidates[0].roadAccessId }, layers: () => layersAt(cutCover.accessRoadCandidates[0].location, 1200), layerSource: src },
      { file: "04-material-yard-unavailable", eventId: "example:tokyo:impact-material-yard-unavailable", eventKind: "material-shortage", constructionSiteId: deepShaft.constructionSiteId, candidateRef: { kind: "materialYard", id: deepShaft.materialYardCandidates[0].materialYardId }, layers: () => layersAt(centreOf(deepShaft.materialYardCandidates[0]), 1200), layerSource: src },
      { file: "05-utility-conflict", eventId: "example:tokyo:impact-utility-conflict", eventKind: "utility-conflict", constructionSiteId: cutCover.constructionSiteId, candidateRef: { kind: "workArea", id: cutCover.workAreaCandidates[0].workAreaId }, layers: () => layersAt(centreOf(cutCover.workAreaCandidates[0]), 1200), layerSource: src },
      { file: "06-unexpected-ground", eventId: "example:tokyo:impact-unexpected-ground", eventKind: "unexpected-ground", constructionSiteId: deepShaft.constructionSiteId, candidateRef: { kind: "shaft", id: deepShaft.shaftCandidates[1].shaftId }, layers: () => layersAt(deepShaft.shaftCandidates[1].location, 1200), layerSource: src },
      { file: "07-material-shortage-unknown-location", eventId: "example:tokyo:impact-material-shortage-unknown-location", eventKind: "material-shortage", constructionSiteId: depot.constructionSiteId, layers: () => ({}), layerSource: { kind: "none" } },
      { file: "08-missing-layers", eventId: "example:tokyo:impact-missing-layers", eventKind: "incident", constructionSiteId: partial.constructionSiteId, candidateRef: { kind: "shaft", id: partial.shaftCandidates[0].shaftId }, layers: () => ({}), layerSource: { kind: "none" } },
    ];
  },
  "example-radial": async (pack, byKey) => {
    const tunnel = byKey.get("cons-tunnel-ordinary");
    const viaduct = byKey.get("cons-viaduct-residential");
    const cutCover = byKey.get("cons-cutcover-narrow");
    const deepShaft = byKey.get("cons-deep-shaft");
    const depot = byKey.get("cons-depot-outer-spoke");
    const partial = byKey.get("cons-partial-data");
    const near1 = viaduct.workAreaCandidates[0].polygon[0];
    const syn = (centre, opts = { clearing: 0.0015 }) => ({ layers: () => syntheticLayers(centre, opts), layerSource: { kind: "synthetic-layers", centre, options: opts } });

    return [
      { file: "01-tunnel-incident-shaft", eventId: "example:radial:impact-tunnel-incident", eventKind: "incident", constructionSiteId: tunnel.constructionSiteId, candidateRef: { kind: "shaft", id: tunnel.shaftCandidates[0].shaftId }, ...syn(tunnel.shaftCandidates[0].location) },
      { file: "02-viaduct-complaint-residential", eventId: "example:radial:impact-viaduct-complaint", eventKind: "complaint", constructionSiteId: viaduct.constructionSiteId, location: near1, ...syn(near1, { clearing: 0 }) },
      { file: "03-cutcover-access-blocked", eventId: "example:radial:impact-cutcover-access-blocked", eventKind: "access-blocked", constructionSiteId: cutCover.constructionSiteId, candidateRef: { kind: "accessRoad", id: cutCover.accessRoadCandidates[0].roadAccessId }, ...syn(cutCover.accessRoadCandidates[0].location) },
      { file: "04-material-yard-unavailable", eventId: "example:radial:impact-material-yard-unavailable", eventKind: "material-shortage", constructionSiteId: deepShaft.constructionSiteId, candidateRef: { kind: "materialYard", id: deepShaft.materialYardCandidates[0].materialYardId }, ...syn(centreOf(deepShaft.materialYardCandidates[0])) },
      { file: "05-utility-conflict", eventId: "example:radial:impact-utility-conflict", eventKind: "utility-conflict", constructionSiteId: cutCover.constructionSiteId, candidateRef: { kind: "workArea", id: cutCover.workAreaCandidates[0].workAreaId }, ...syn(centreOf(cutCover.workAreaCandidates[0])) },
      { file: "06-unexpected-ground", eventId: "example:radial:impact-unexpected-ground", eventKind: "unexpected-ground", constructionSiteId: deepShaft.constructionSiteId, candidateRef: { kind: "shaft", id: deepShaft.shaftCandidates[1].shaftId }, ...syn(deepShaft.shaftCandidates[1].location) },
      { file: "07-material-shortage-unknown-location", eventId: "example:radial:impact-material-shortage-unknown-location", eventKind: "material-shortage", constructionSiteId: depot.constructionSiteId, layers: () => ({}), layerSource: { kind: "none" } },
      { file: "08-missing-layers", eventId: "example:radial:impact-missing-layers", eventKind: "incident", constructionSiteId: partial.constructionSiteId, candidateRef: { kind: "shaft", id: partial.shaftCandidates[0].shaftId }, layers: () => ({}), layerSource: { kind: "none" } },
    ];
  },
  "example-corridor": async (pack, byKey) => {
    const viaduct = byKey.get("cons-viaduct");
    const depot = byKey.get("cons-depot");
    const partial = byKey.get("cons-partial-data");
    const near1 = viaduct.workAreaCandidates[0].polygon[0];
    const syn = (centre, opts = {}) => ({ layers: () => syntheticLayers(centre, opts), layerSource: { kind: "synthetic-layers", centre, options: opts } });

    return [
      { file: "01-viaduct-incident-workarea", eventId: "example:corridor:impact-viaduct-incident", eventKind: "incident", constructionSiteId: viaduct.constructionSiteId, candidateRef: { kind: "workArea", id: viaduct.workAreaCandidates[0].workAreaId }, ...syn(centreOf(viaduct.workAreaCandidates[0])) },
      { file: "02-viaduct-complaint-residential", eventId: "example:corridor:impact-viaduct-complaint", eventKind: "complaint", constructionSiteId: viaduct.constructionSiteId, location: near1, ...syn(near1) },
      { file: "03-viaduct-access-blocked", eventId: "example:corridor:impact-access-blocked", eventKind: "access-blocked", constructionSiteId: viaduct.constructionSiteId, candidateRef: { kind: "accessRoad", id: viaduct.accessRoadCandidates[0].roadAccessId }, ...syn(viaduct.accessRoadCandidates[0].location) },
      { file: "04-material-yard-unavailable", eventId: "example:corridor:impact-material-yard-unavailable", eventKind: "material-shortage", constructionSiteId: viaduct.constructionSiteId, candidateRef: { kind: "materialYard", id: viaduct.materialYardCandidates[0].materialYardId }, ...syn(centreOf(viaduct.materialYardCandidates[0])) },
      { file: "05-utility-conflict", eventId: "example:corridor:impact-utility-conflict", eventKind: "utility-conflict", constructionSiteId: depot.constructionSiteId, candidateRef: { kind: "workArea", id: depot.workAreaCandidates[0].workAreaId }, ...syn(centreOf(depot.workAreaCandidates[0])) },
      { file: "06-unexpected-ground", eventId: "example:corridor:impact-unexpected-ground", eventKind: "unexpected-ground", constructionSiteId: viaduct.constructionSiteId, candidateRef: { kind: "workArea", id: viaduct.workAreaCandidates[1].workAreaId }, ...syn(centreOf(viaduct.workAreaCandidates[1])) },
      { file: "07-material-shortage-unknown-location", eventId: "example:corridor:impact-material-shortage-unknown-location", eventKind: "material-shortage", constructionSiteId: depot.constructionSiteId, layers: () => ({}), layerSource: { kind: "none" } },
      { file: "08-missing-layers", eventId: "example:corridor:impact-missing-layers", eventKind: "incident", constructionSiteId: partial.constructionSiteId, candidateRef: { kind: "workArea", id: partial.workAreaCandidates[0].workAreaId }, layers: () => ({}), layerSource: { kind: "none" } },
    ];
  },
};

const only = process.argv[2];
for (const id of Object.keys(EXAMPLES).filter((k) => !only || k === only)) {
  const pack = loadPack(id);
  const { sites, byKey } = sitesOf(pack);
  const constructionExport = { schema: "transitline.construction-export/1", packId: pack.manifest.id, packVersion: pack.manifest.version, sites, warnings: [] };
  const outDir = path.join(root, pack.dir, "construction-impact-examples");
  fs.mkdirSync(outDir, { recursive: true });
  for (const spec of await EXAMPLES[id](pack, byKey)) {
    const impact = await produce(pack, constructionExport, spec);
    fs.writeFileSync(path.join(outDir, `${spec.file}.construction-impact.json`), `${JSON.stringify(impact, null, 2)}\n`);
    console.log(`[${id}] ${spec.file}: ${impact.eventId} kind=${impact.eventKind} q=${impact.dataQuality} bldg=${impact.spatialFacts.intersectedBuildingCount} linked=${impact.linkedCandidateIds.length} alt=${impact.alternativeCandidates.length} unknown=[${impact.unknown}]`);
  }
}
