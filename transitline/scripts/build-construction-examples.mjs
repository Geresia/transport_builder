// Dev-time generator for the ConstructionSiteGeometry examples in packs/<id>/construction-examples/.
//   node scripts/build-construction-examples.mjs [packId]
//
// Each example is a package the way the construction editor would save it (construction-editor.mjs), connected to
// real ids from the same pack's plan-examples (and, for a depot package, depot-examples). Tokyo layers are decoded
// from the pack's own vector tiles plus the local DEM / roads (see scripts/lib/pack-spatial.mjs); synthetic packs
// use the generated layers of scripts/lib/synthetic-layers.mjs. A layer that cannot be loaded is skipped and its
// fields come out unknown (null) — never 0.
import fs from "node:fs";
import path from "node:path";
import { buildConstructionExport } from "../engine/src/map/construction-site.mjs";
import { makeSpatialContext } from "../engine/src/map/spatial.mjs";
import { existingNetworkToExternal } from "../engine/src/map/plan-geometry.mjs";
import { root, readJson, loadPack, tokyoSpatial, tokyoDepotLayers } from "./lib/pack-spatial.mjs";
import { syntheticLayers } from "./lib/synthetic-layers.mjs";

const planExamples = (pack) => {
  const dir = path.join(root, pack.dir, "plan-examples");
  return fs.readdirSync(dir).filter((f) => f.endsWith(".plan.json")).sort().map((f) => readJson(`${pack.dir}/plan-examples/${f}`));
};
// Depot examples are read straight off disk (already-built DepotSiteGeometry objects) rather than recomputed, so a
// construction depot package connects to exactly the same depotSiteId the shipped depot examples use.
const depotExamplesAsExport = (pack) => {
  const dir = path.join(root, pack.dir, "depot-examples");
  if (!fs.existsSync(dir)) return null;
  const sites = fs.readdirSync(dir).filter((f) => f.endsWith(".depot.json")).sort().map((f) => readJson(`${pack.dir}/depot-examples/${f}`));
  return { schema: "transitline.depot-export/1", packId: pack.manifest.id, packVersion: pack.manifest.version, sites, warnings: [] };
};
const byName = (plans, suffix) => plans.find((p) => p.source.drawnLine.key.endsWith(suffix));
const midpoint = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
const bboxAround = ([lon, lat], m) => { const d = m / 111320; return [lon - d * 1.25, lat - d, lon + d * 1.25, lat + d]; };

// spec: { file, kind, planId?, segmentIds?, stationId?, depotSiteId?, key, name, layers?: () => layers, layerSource }
async function produce(pack, mapExport, depotExport, spec) {
  const layers = (await spec.layers?.()) ?? {};
  const spatial = makeSpatialContext(layers);
  const drawn = { key: spec.key, name: spec.name, kind: spec.kind, planId: spec.planId, segmentIds: spec.segmentIds, stationId: spec.stationId, depotSiteId: spec.depotSiteId };
  const out = buildConstructionExport({ pack, mapExport, depotExport, packages: [drawn], spatial });
  if (!out.sites[0]) throw new Error(`[${spec.file}] produced no site: ${JSON.stringify(out.warnings)}`);
  return { ...out.sites[0], source: { drawnPackage: structuredClone(drawn), layers: spec.layerSource, generatedBy: "scripts/build-construction-examples.mjs" } };
}

const EXAMPLES = {
  tokyo: async (pack, plans, depotExport) => {
    const base = tokyoSpatial(pack).layers;
    const layersAt = (centre, radius = 2000) => tokyoDepotLayers(pack, bboxAround(centre, radius), base);
    const src = { kind: "tokyo-pack-layers", layers: ["dem", "water", "roads", "buildings", "residential", "railFacilities"] };
    const V = byName(plans, "station-variants");
    const river = byName(plans, "east-river-crossing");
    const tama = byName(plans, "tama-hills");
    const [seg0, seg1, seg2, seg3, seg4] = V.segments;
    const [st0, st1, st2, st3, st4, st5] = V.stationCandidates; // Setagaya, Meguro, Shibuya, Shinjuku, Bunkyo, Taito
    void seg0;
    const ota = depotExport.sites.find((s) => s.source.drawnSite.key === "example:tokyo:depot-ota-rail-land");

    return [
      { file: "01-tunnel-shield-ordinary", kind: "tunnel", planId: V.planId, segmentIds: [seg4.id], key: "example:tokyo:cons-tunnel-ordinary", name: "Bunkyo-Taito shield tunnel", layers: () => layersAt(midpoint(st4.location, st5.location), 2800), layerSource: src },
      { file: "02-cutcover-narrow", kind: "cutCover", planId: V.planId, segmentIds: [seg2.id], key: "example:tokyo:cons-cutcover-narrow", name: "Shibuya-Shinjuku cut-and-cover (narrow street corridor)", layers: () => layersAt(midpoint(st2.location, st3.location), 2800), layerSource: src },
      { file: "03-river-crossing", kind: "tunnel", planId: river.planId, segmentIds: [river.segments[1].id], key: "example:tokyo:cons-river-crossing", name: "Sumida-Edogawa river-crossing tunnel", layers: () => layersAt(midpoint(river.stationCandidates[1].location, river.stationCandidates[2].location), 3200), layerSource: src },
      { file: "04-viaduct-near-residential", kind: "viaduct", planId: V.planId, segmentIds: [seg1.id], key: "example:tokyo:cons-viaduct-residential", name: "Meguro-Shibuya elevated viaduct", layers: () => layersAt(midpoint(st1.location, st2.location), 2800), layerSource: src },
      { file: "05-deep-tunnel-shaft", kind: "tunnel", planId: V.planId, segmentIds: [seg3.id], key: "example:tokyo:cons-deep-shaft", name: "Shinjuku-Bunkyo deep tunnel (38 m shaft at Shinjuku)", layers: () => layersAt(midpoint(st3.location, st4.location), 2800), layerSource: src },
      { file: "06-depot-connection", kind: "depot", depotSiteId: ota.depotSiteId, key: "example:tokyo:cons-depot-ota", name: "Ota depot-connection works", layers: () => layersAt(ota.location, 1500), layerSource: src },
      { file: "07-station-package", kind: "station", planId: V.planId, stationId: st2.id, key: "example:tokyo:cons-station-shibuya", name: "Shibuya station work package", layers: () => layersAt(st2.location), layerSource: src },
      { file: "08-systems-full-line", kind: "systems", planId: V.planId, segmentIds: V.segments.map((s) => s.id), key: "example:tokyo:cons-systems-full-line", name: "Power / signal / track works, full line", layers: () => layersAt(midpoint(st0.location, st5.location), 8000), layerSource: src },
      { file: "09-partial-data", kind: "tunnel", planId: tama.planId, segmentIds: [tama.segments[0].id], key: "example:tokyo:cons-partial-data", name: "Ome-Hachioji tunnel outside the mapped districts", layers: () => ({}), layerSource: { kind: "none" } },
    ];
  },
  "example-radial": async (pack, plans, depotExport) => {
    const V = byName(plans, "station-variants");
    const [seg0, seg1, seg2, seg3, seg4] = V.segments;
    const [st0, st1, st2, st3, st4, st5] = V.stationCandidates;
    const spoke = depotExport.sites.find((s) => s.source.drawnSite.key === "example:radial:depot-outer-spoke");
    const std = { clearing: 0.0015 };
    // one point defines both the layers and how they are recorded, so the example test can regenerate them exactly
    const syn = (centre, opts = std) => ({ layers: () => syntheticLayers(centre, opts), layerSource: { kind: "synthetic-layers", centre, options: opts } });
    // the synthetic river band sits at (cy-0.0045)..(cy-0.0035): centring on a point of the corridor plus 0.004 puts the band right on it
    const along = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    const riverCentre = (() => { const [x, y] = along(st3.location, st4.location, 0.4); return [x, y + 0.004]; })();

    return [
      { file: "01-tunnel-shield-ordinary", kind: "tunnel", planId: V.planId, segmentIds: [seg4.id], key: "example:radial:cons-tunnel-ordinary", name: "Outer shield tunnel", ...syn(midpoint(st4.location, st5.location)) },
      { file: "02-cutcover-narrow", kind: "cutCover", planId: V.planId, segmentIds: [seg3.id], key: "example:radial:cons-cutcover-narrow", name: "Cut-and-cover corridor", ...syn(midpoint(st3.location, st4.location)) },
      { file: "03-river-crossing", kind: "tunnel", planId: V.planId, segmentIds: [seg3.id], key: "example:radial:cons-river-crossing", name: "River-crossing tunnel", ...syn(riverCentre) },
      { file: "04-viaduct-near-residential", kind: "viaduct", planId: V.planId, segmentIds: [seg1.id], key: "example:radial:cons-viaduct-residential", name: "Elevated viaduct near housing", ...syn(midpoint(st1.location, st2.location), { clearing: 0 }) },
      { file: "05-deep-tunnel-shaft", kind: "tunnel", planId: V.planId, segmentIds: [seg2.id], key: "example:radial:cons-deep-shaft", name: "CBD deep tunnel (36 m shaft)", ...syn(midpoint(st2.location, st3.location)) },
      { file: "06-depot-connection", kind: "depot", depotSiteId: spoke.depotSiteId, key: "example:radial:cons-depot-outer-spoke", name: "Outer depot-connection works", ...syn(spoke.location) },
      { file: "07-station-package", kind: "station", planId: V.planId, stationId: st2.id, key: "example:radial:cons-station-cbd", name: "CBD station work package", ...syn(st2.location) },
      { file: "08-systems-full-line", kind: "systems", planId: V.planId, segmentIds: V.segments.map((s) => s.id), key: "example:radial:cons-systems-full-line", name: "Power / signal / track works, full line", ...syn(midpoint(st0.location, st5.location), { clearing: 0.02 }) },
      { file: "09-partial-data", kind: "tunnel", planId: V.planId, segmentIds: [seg0.id], key: "example:radial:cons-partial-data", name: "Outer surface run with no spatial layers", layers: () => ({}), layerSource: { kind: "none" } },
    ];
  },
  "example-corridor": async (pack, plans, depotExport) => {
    const trunk = plans[0];
    const yard = depotExport.sites[0];
    const syn = (centre, opts = {}) => ({ layers: () => syntheticLayers(centre, opts), layerSource: { kind: "synthetic-layers", centre, options: opts } });
    return [
      { file: "01-viaduct-corridor", kind: "viaduct", planId: trunk.planId, segmentIds: [trunk.segments[0].id], key: "example:corridor:cons-viaduct", name: "Corridor viaduct package", ...syn(midpoint(trunk.stationCandidates[0].location, trunk.stationCandidates[1].location)) },
      { file: "02-depot-connection", kind: "depot", depotSiteId: yard.depotSiteId, key: "example:corridor:cons-depot", name: "Corridor depot-connection works", ...syn(yard.location) },
      { file: "03-partial-data", kind: "viaduct", planId: trunk.planId, segmentIds: [trunk.segments[2].id], key: "example:corridor:cons-partial-data", name: "Corridor stretch with no spatial layers", layers: () => ({}), layerSource: { kind: "none" } },
    ];
  },
};

const only = process.argv[2];
for (const id of Object.keys(EXAMPLES).filter((k) => !only || k === only)) {
  const pack = loadPack(id);
  const plans = planExamples(pack);
  const depotExport = depotExamplesAsExport(pack);
  const mapExport = { plans, externalNetworks: pack.existingNetwork ? [existingNetworkToExternal(pack)] : [] };
  const outDir = path.join(root, pack.dir, "construction-examples");
  fs.mkdirSync(outDir, { recursive: true });
  for (const spec of await EXAMPLES[id](pack, plans, depotExport)) {
    const site = await produce(pack, mapExport, depotExport, spec);
    fs.writeFileSync(path.join(outDir, `${spec.file}.construction.json`), `${JSON.stringify(site, null, 2)}\n`);
    console.log(`[${id}] ${spec.file}: ${site.constructionSiteId} kind=${site.kind} q=${site.dataQuality} area=${site.areaSquareMeters} len=${site.lengthMeters} bldg=${site.intersectedBuildingCount} water=${site.waterCrossingCount} res=${site.distanceToResidentialMeters} shafts=${site.shaftCandidates.length} unknown=[${site.unknown}]`);
  }
}
