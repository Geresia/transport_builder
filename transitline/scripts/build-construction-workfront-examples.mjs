// Dev-time generator for the ConstructionWorkfrontGeometry examples in packs/<id>/construction-workfront-examples/.
//   node scripts/build-construction-workfront-examples.mjs [packId]
//
// Each example places a work front (shaft or work-area candidate) on the pack's own shipped
// construction-examples/*.construction.json sites, the same way build-construction-impact-examples.mjs reads
// them. Layers are decoded the same way; a layer that cannot be loaded is skipped and its fields come out
// unknown (null) — never 0.
import fs from "node:fs";
import path from "node:path";
import { buildConstructionWorkfrontExport } from "../engine/src/map/construction-workfront.mjs";
import { makeSpatialContext, roadLayerFromGeojson } from "../engine/src/map/spatial.mjs";
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
// A roads-only layer with no major/highway road at all, so majorRoadAccessible comes out a real `false`
// (not an unknown) — the roads layer is present and covers the point, it just has nothing major nearby.
const minorOnlyRoads = (centre) => roadLayerFromGeojson({ features: [
  { geometry: { coordinates: [[centre[0] - 0.02, centre[1] + 0.0007], [centre[0] + 0.02, centre[1] + 0.0007]] }, properties: { roadClass: "minor" } },
] }, { quality: "high", source: { name: "minor-only roads (example: no major road nearby)", license: "CC0-1.0" } });

// spec: { file, workfrontId, constructionSiteId, candidateRef, accessCandidateRef?, assemblyPolygon?, storagePolygon?, layers?: () => layers, layerSource }
async function produce(pack, constructionExport, spec) {
  const layers = (await spec.layers?.()) ?? {};
  const spatial = makeSpatialContext(layers);
  const drawn = {
    workfrontId: spec.workfrontId, constructionSiteId: spec.constructionSiteId, candidateRef: spec.candidateRef,
    accessCandidateRef: spec.accessCandidateRef, assemblyPolygon: spec.assemblyPolygon, storagePolygon: spec.storagePolygon,
  };
  const out = buildConstructionWorkfrontExport({ pack, constructionExport, spatial, workfronts: [drawn] });
  if (!out.workfronts[0]) throw new Error(`[${spec.file}] produced no work front: ${JSON.stringify(out.warnings)}`);
  return { ...out.workfronts[0], source: { drawnWorkfront: structuredClone(drawn), layers: spec.layerSource, generatedBy: "scripts/build-construction-workfront-examples.mjs" } };
}

const EXAMPLES = {
  tokyo: async (pack, byKey) => {
    const base = tokyoSpatial(pack).layers;
    const layersAt = (centre, radius = 1200) => tokyoDepotLayers(pack, bboxAround(centre, radius), base);
    const src = { kind: "tokyo-pack-layers", layers: ["dem", "water", "roads", "buildings", "residential", "railFacilities"] };
    const tunnel = byKey.get("cons-tunnel-ordinary");
    const cutCover = byKey.get("cons-cutcover-narrow");
    const viaduct = byKey.get("cons-viaduct-residential");
    const station = byKey.get("cons-station-shibuya");
    const depot = byKey.get("cons-depot-ota");
    const partial = byKey.get("cons-partial-data");
    const deepShaft = byKey.get("cons-deep-shaft");
    const shaftLoc = tunnel.shaftCandidates[0].location;
    const tinyAssembly = [[shaftLoc[0] - 0.00004, shaftLoc[1] - 0.00004], [shaftLoc[0] + 0.00004, shaftLoc[1] - 0.00004], [shaftLoc[0] + 0.00004, shaftLoc[1] + 0.00004], [shaftLoc[0] - 0.00004, shaftLoc[1] + 0.00004]];
    const residentialWorkArea = deepShaft.workAreaCandidates[0]; // the only work-area candidate found within 100 m of a real residential building here

    return [
      { file: "01-tunnel-tbm-assembly-shortage", workfrontId: "example:tokyo:wf-tunnel-tbm-shortage", constructionSiteId: tunnel.constructionSiteId, candidateRef: { kind: "shaft", id: tunnel.shaftCandidates[0].shaftId }, assemblyPolygon: tinyAssembly, layers: () => layersAt(shaftLoc), layerSource: src },
      { file: "02-cutcover-workarea", workfrontId: "example:tokyo:wf-cutcover-workarea", constructionSiteId: cutCover.constructionSiteId, candidateRef: { kind: "workArea", id: cutCover.workAreaCandidates[0].workAreaId }, layers: () => layersAt(centreOf(cutCover.workAreaCandidates[0])), layerSource: src },
      { file: "03-viaduct-crane-workarea", workfrontId: "example:tokyo:wf-viaduct-crane-workarea", constructionSiteId: viaduct.constructionSiteId, candidateRef: { kind: "workArea", id: viaduct.workAreaCandidates[1].workAreaId }, layers: () => layersAt(centreOf(viaduct.workAreaCandidates[1])), layerSource: src },
      { file: "04-station-construction", workfrontId: "example:tokyo:wf-station-construction", constructionSiteId: station.constructionSiteId, candidateRef: { kind: "workArea", id: station.workAreaCandidates[0].workAreaId }, layers: () => layersAt(centreOf(station.workAreaCandidates[0])), layerSource: src },
      { file: "05-depot-workarea", workfrontId: "example:tokyo:wf-depot-workarea", constructionSiteId: depot.constructionSiteId, candidateRef: { kind: "workArea", id: depot.workAreaCandidates[0].workAreaId }, layers: () => layersAt(centreOf(depot.workAreaCandidates[0])), layerSource: src },
      { file: "06-major-road-accessible", workfrontId: "example:tokyo:wf-major-road-accessible", constructionSiteId: tunnel.constructionSiteId, candidateRef: { kind: "shaft", id: tunnel.shaftCandidates[1].shaftId }, layers: () => layersAt(tunnel.shaftCandidates[1].location), layerSource: src },
      { file: "07-major-road-inaccessible", workfrontId: "example:tokyo:wf-major-road-inaccessible", constructionSiteId: cutCover.constructionSiteId, candidateRef: { kind: "workArea", id: cutCover.workAreaCandidates[1].workAreaId }, layers: async () => ({ ...(await layersAt(centreOf(cutCover.workAreaCandidates[1]))), roads: minorOnlyRoads(centreOf(cutCover.workAreaCandidates[1])) }), layerSource: { kind: "tokyo-pack-layers-minor-only-roads", layers: src.layers, centre: centreOf(cutCover.workAreaCandidates[1]) } },
      { file: "08-near-residential", workfrontId: "example:tokyo:wf-near-residential", constructionSiteId: deepShaft.constructionSiteId, candidateRef: { kind: "workArea", id: residentialWorkArea.workAreaId }, layers: () => layersAt(centreOf(residentialWorkArea)), layerSource: src },
      { file: "09-missing-layers", workfrontId: "example:tokyo:wf-missing-layers", constructionSiteId: partial.constructionSiteId, candidateRef: { kind: "shaft", id: partial.shaftCandidates[0].shaftId }, layers: () => ({}), layerSource: { kind: "none" } },
    ];
  },
  "example-radial": async (pack, byKey) => {
    const tunnel = byKey.get("cons-tunnel-ordinary");
    const cutCover = byKey.get("cons-cutcover-narrow");
    const viaduct = byKey.get("cons-viaduct-residential");
    const station = byKey.get("cons-station-cbd");
    const depot = byKey.get("cons-depot-outer-spoke");
    const partial = byKey.get("cons-partial-data");
    const shaftLoc = tunnel.shaftCandidates[0].location;
    const tinyAssembly = [[shaftLoc[0] - 0.00004, shaftLoc[1] - 0.00004], [shaftLoc[0] + 0.00004, shaftLoc[1] - 0.00004], [shaftLoc[0] + 0.00004, shaftLoc[1] + 0.00004], [shaftLoc[0] - 0.00004, shaftLoc[1] + 0.00004]];
    const near1 = viaduct.workAreaCandidates[0].polygon[0];
    const syn = (centre, opts = { clearing: 0.0015 }) => ({ layers: () => syntheticLayers(centre, opts), layerSource: { kind: "synthetic-layers", centre, options: opts } });

    return [
      { file: "01-tunnel-tbm-assembly-shortage", workfrontId: "example:radial:wf-tunnel-tbm-shortage", constructionSiteId: tunnel.constructionSiteId, candidateRef: { kind: "shaft", id: tunnel.shaftCandidates[0].shaftId }, assemblyPolygon: tinyAssembly, ...syn(shaftLoc) },
      { file: "02-cutcover-workarea", workfrontId: "example:radial:wf-cutcover-workarea", constructionSiteId: cutCover.constructionSiteId, candidateRef: { kind: "workArea", id: cutCover.workAreaCandidates[0].workAreaId }, ...syn(centreOf(cutCover.workAreaCandidates[0])) },
      { file: "03-viaduct-crane-workarea", workfrontId: "example:radial:wf-viaduct-crane-workarea", constructionSiteId: viaduct.constructionSiteId, candidateRef: { kind: "workArea", id: viaduct.workAreaCandidates[1].workAreaId }, ...syn(centreOf(viaduct.workAreaCandidates[1]), { clearing: 0 }) },
      { file: "04-station-construction", workfrontId: "example:radial:wf-station-construction", constructionSiteId: station.constructionSiteId, candidateRef: { kind: "workArea", id: station.workAreaCandidates[0].workAreaId }, ...syn(centreOf(station.workAreaCandidates[0])) },
      { file: "05-depot-workarea", workfrontId: "example:radial:wf-depot-workarea", constructionSiteId: depot.constructionSiteId, candidateRef: { kind: "workArea", id: depot.workAreaCandidates[0].workAreaId }, ...syn(centreOf(depot.workAreaCandidates[0])) },
      { file: "06-major-road-accessible", workfrontId: "example:radial:wf-major-road-accessible", constructionSiteId: tunnel.constructionSiteId, candidateRef: { kind: "shaft", id: tunnel.shaftCandidates[1].shaftId }, ...syn(tunnel.shaftCandidates[1].location) },
      { file: "07-major-road-inaccessible", workfrontId: "example:radial:wf-major-road-inaccessible", constructionSiteId: cutCover.constructionSiteId, candidateRef: { kind: "workArea", id: cutCover.workAreaCandidates[1].workAreaId }, layers: async () => ({ ...syntheticLayers(centreOf(cutCover.workAreaCandidates[1]), { clearing: 0.0015 }), roads: minorOnlyRoads(centreOf(cutCover.workAreaCandidates[1])) }), layerSource: { kind: "minor-only-roads", centre: centreOf(cutCover.workAreaCandidates[1]), options: { clearing: 0.0015 } } },
      { file: "08-near-residential", workfrontId: "example:radial:wf-near-residential", constructionSiteId: viaduct.constructionSiteId, candidateRef: { kind: "workArea", id: viaduct.workAreaCandidates[0].workAreaId }, ...syn(near1, { clearing: 0 }) },
      { file: "09-missing-layers", workfrontId: "example:radial:wf-missing-layers", constructionSiteId: partial.constructionSiteId, candidateRef: { kind: "shaft", id: partial.shaftCandidates[0].shaftId }, layers: () => ({}), layerSource: { kind: "none" } },
    ];
  },
  "example-corridor": async (pack, byKey) => {
    const viaduct = byKey.get("cons-viaduct");
    const depot = byKey.get("cons-depot");
    const partial = byKey.get("cons-partial-data");
    const near1 = viaduct.workAreaCandidates[0].polygon[0];
    const tinyAssembly = (c) => { const p = centreOf(c); return [[p[0] - 0.00004, p[1] - 0.00004], [p[0] + 0.00004, p[1] - 0.00004], [p[0] + 0.00004, p[1] + 0.00004], [p[0] - 0.00004, p[1] + 0.00004]]; };
    const syn = (centre, opts = {}) => ({ layers: () => syntheticLayers(centre, opts), layerSource: { kind: "synthetic-layers", centre, options: opts } });

    return [
      // no tunnel package in this pack: the shaft-only "TBM assembly shortage" scenario is shown as an undersized assembly area on a work area instead
      { file: "01-viaduct-workarea-assembly-shortage", workfrontId: "example:corridor:wf-assembly-shortage", constructionSiteId: viaduct.constructionSiteId, candidateRef: { kind: "workArea", id: viaduct.workAreaCandidates[0].workAreaId }, assemblyPolygon: tinyAssembly(viaduct.workAreaCandidates[0]), ...syn(centreOf(viaduct.workAreaCandidates[0])) },
      { file: "02-viaduct-workarea", workfrontId: "example:corridor:wf-viaduct-workarea", constructionSiteId: viaduct.constructionSiteId, candidateRef: { kind: "workArea", id: viaduct.workAreaCandidates[1].workAreaId }, ...syn(centreOf(viaduct.workAreaCandidates[1])) },
      { file: "03-depot-workarea", workfrontId: "example:corridor:wf-depot-workarea", constructionSiteId: depot.constructionSiteId, candidateRef: { kind: "workArea", id: depot.workAreaCandidates[0].workAreaId }, ...syn(centreOf(depot.workAreaCandidates[0])) },
      { file: "04-major-road-accessible", workfrontId: "example:corridor:wf-major-road-accessible", constructionSiteId: depot.constructionSiteId, candidateRef: { kind: "workArea", id: depot.workAreaCandidates[1].workAreaId }, ...syn(centreOf(depot.workAreaCandidates[1])) },
      { file: "05-major-road-inaccessible", workfrontId: "example:corridor:wf-major-road-inaccessible", constructionSiteId: viaduct.constructionSiteId, candidateRef: { kind: "workArea", id: viaduct.workAreaCandidates[1].workAreaId }, layers: async () => ({ ...syntheticLayers(centreOf(viaduct.workAreaCandidates[1]), {}), roads: minorOnlyRoads(centreOf(viaduct.workAreaCandidates[1])) }), layerSource: { kind: "minor-only-roads", centre: centreOf(viaduct.workAreaCandidates[1]), options: {} } },
      { file: "06-near-residential", workfrontId: "example:corridor:wf-near-residential", constructionSiteId: viaduct.constructionSiteId, candidateRef: { kind: "workArea", id: viaduct.workAreaCandidates[0].workAreaId }, ...syn(near1) },
      { file: "07-missing-layers", workfrontId: "example:corridor:wf-missing-layers", constructionSiteId: partial.constructionSiteId, candidateRef: { kind: "workArea", id: partial.workAreaCandidates[0].workAreaId }, layers: () => ({}), layerSource: { kind: "none" } },
    ];
  },
};

const only = process.argv[2];
for (const id of Object.keys(EXAMPLES).filter((k) => !only || k === only)) {
  const pack = loadPack(id);
  const { sites, byKey } = sitesOf(pack);
  const constructionExport = { schema: "transitline.construction-export/1", packId: pack.manifest.id, packVersion: pack.manifest.version, sites, warnings: [] };
  const outDir = path.join(root, pack.dir, "construction-workfront-examples");
  fs.mkdirSync(outDir, { recursive: true });
  for (const spec of await EXAMPLES[id](pack, byKey)) {
    const workfront = await produce(pack, constructionExport, spec);
    fs.writeFileSync(path.join(outDir, `${spec.file}.construction-workfront.json`), `${JSON.stringify(workfront, null, 2)}\n`);
    console.log(`[${id}] ${spec.file}: ${workfront.workfrontId} kind=${workfront.candidateRef.kind} q=${workfront.dataQuality} area=${workfront.usableAreaSquareMeters} assembly=${workfront.stagingFacts.assemblyAreaSquareMeters} majorRoad=${workfront.majorRoadAccessible} unknown=[${workfront.unknown}]`);
  }
}
