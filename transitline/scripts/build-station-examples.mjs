// Dev-time generator for the StationSiteGeometry examples in packs/<id>/station-examples/.
//   node scripts/build-station-examples.mjs [packId]
//
// Each example is a site the way the station editor would save it (station-editor.mjs), connected to a station of a
// plan in packs/<id>/plan-examples/ (its real planId / station id), so the two sets of examples stay consistent.
// Tokyo layers are decoded from the pack's own vector tiles (needs: npm i --no-save pmtiles @mapbox/vector-tile pbf)
// plus the local DEM / roads. Synthetic packs use the generated layers of scripts/lib/synthetic-layers.mjs.
// A layer that cannot be loaded is skipped and its fields come out unknown (null) — never 0.
import fs from "node:fs";
import path from "node:path";
import { demandNodesFromPack, existingNetworkToExternal } from "../engine/src/map/plan-geometry.mjs";
import { buildStationExport } from "../engine/src/map/station-site.mjs";
import { activeSites, addEntrance, addSite, newStationDoc, setTransfer, suggestEntrancePoints } from "../engine/src/map/station-editor.mjs";
import { makeSpatialContext } from "../engine/src/map/spatial.mjs";
import { root, readJson, loadPack, tokyoSpatial, tokyoDepotLayers } from "./lib/pack-spatial.mjs";
import { syntheticLayers } from "./lib/synthetic-layers.mjs";

const planExamples = (pack) => {
  const dir = path.join(root, pack.dir, "plan-examples");
  return fs.readdirSync(dir).filter((f) => f.endsWith(".plan.json")).sort().map((f) => readJson(`${pack.dir}/plan-examples/${f}`));
};
const byName = (plans, suffix) => plans.find((p) => p.source.drawnLine.key.endsWith(suffix));
const bboxAround = ([lon, lat], m) => { const d = m / 111320; return [lon - d * 1.25, lat - d, lon + d * 1.25, lat + d]; };
const centroid = (ring) => [ring.reduce((s, p) => s + p[0], 0) / ring.length, ring.reduce((s, p) => s + p[1], 0) / ring.length];
const metres = (a, b) => Math.hypot((a[0] - b[0]) * 111320 * Math.cos((a[1] * Math.PI) / 180), (a[1] - b[1]) * 111320);

// spec: { file, mode, plan, index, key, name, offset?, entrances: "suggest" | [[lon,lat]...] | (layers, center) => points,
//         transfers?: [{ targetStationId, via }], layers?: (stationLocation) => layers, layerSource }
async function produce(pack, plans, spec) {
  const planRecord = spec.plan;
  const station = planRecord.stationCandidates[spec.index];
  const location = spec.offset ? [station.location[0] + spec.offset[0], station.location[1] + spec.offset[1]] : undefined;
  const layers = (await spec.layers?.(station.location)) ?? {};
  const spatial = makeSpatialContext(layers);
  const mapExport = {
    plans, demandNodes: demandNodesFromPack(pack),
    externalNetworks: spec.mode === "existing" && pack.existingNetwork ? [existingNetworkToExternal(pack)] : [],
  };
  const doc = newStationDoc(pack.manifest.id, pack.manifest.version ?? null);
  const site = addSite(doc, { key: spec.key, name: spec.name, connect: { planId: planRecord.planId, stationId: station.id }, ...(location ? { location } : {}) });
  const first = buildStationExport({ pack, mapExport, stations: activeSites(doc), spatial }).sites[0];
  const points = spec.entrances === "suggest"
    ? suggestEntrancePoints({ location: first.location, headingDegrees: first.bodyHeadingDegrees, lengthMeters: first.bodyLengthMeters, widthMeters: first.bodyWidthMeters })
    : typeof spec.entrances === "function" ? spec.entrances(layers, first.location) : spec.entrances ?? [];
  for (const p of points) addEntrance(doc, site.key, p);
  for (const t of spec.transfers ?? []) setTransfer(doc, site.key, t.targetStationId, t.via);
  const out = buildStationExport({ pack, mapExport, stations: activeSites(doc), spatial }).sites[0];
  return { ...out, source: { drawnStation: structuredClone(activeSites(doc)[0]), requestedMode: spec.mode, layers: spec.layerSource, generatedBy: "scripts/build-station-examples.mjs" } };
}

const EXAMPLES = {
  tokyo: async (pack, plans) => {
    const base = tokyoSpatial(pack).layers;
    const layersAt = (center) => tokyoDepotLayers(pack, bboxAround(center, 1500), base);
    const src = { kind: "tokyo-pack-layers", layers: ["dem", "water", "roads", "buildings", "landuse"] };
    const V = byName(plans, "station-variants");
    const bay = byName(plans, "bay-ward-spine");
    const shinjuku = byName(plans, "shinjuku-free-placed");
    const tama = byName(plans, "tama-hills");
    const inBuildings = (n) => (layers, center) => layers.buildings.items
      .map((it) => ({ c: centroid(it.rings[0].slice(0, -1)) }))
      .filter((x) => metres(x.c, center) <= 150)
      .sort((a, b) => metres(a.c, center) - metres(b.c, center) || a.c[0] - b.c[0])
      .slice(0, n).map((x) => x.c);
    const shinagawa = bay.stationCandidates[1].location;
    const ex = (file, mode, plan, index, key, name, extra = {}) => ({ file, mode, plan, index, key: `example:tokyo:${key}`, name, entrances: "suggest", layers: layersAt, layerSource: src, ...extra });
    return [
      ex("01-ground-side-general", "scratch", V, 0, "station-ground-side", "Setagaya ground station (side platforms)"),
      ex("02-elevated-island-general", "scratch", V, 1, "station-elevated-island", "Meguro elevated station (island platform)"),
      ex("03-shallow-cut-cover", "scratch", V, 2, "station-cut-cover", "Shibuya cut-and-cover station (12 m)"),
      ex("04-deep-station", "scratch", V, 3, "station-deep", "Shinjuku deep station (38 m)"),
      ex("05-existing-transfer", "existing", bay, 1, "station-existing-transfer", "Shinagawa transfer to the existing network", {
        offset: [0.0015, 0], transfers: [{ targetStationId: "ward-shinagawa", via: [[shinagawa[0] + 0.0007, shinagawa[1] - 0.0005]] }] }),
      ex("06-terminal-turnback", "scratch", V, 5, "station-terminal", "Taito terminal (turn-back candidate)"),
      ex("07-blocked-entrances", "scratch", shinjuku, 1, "station-blocked-entrances", "Shinjuku candidate whose entrances all land on buildings", { entrances: inBuildings(3) }),
      ex("08-partial-layers", "scratch", tama, 1, "station-partial-layers", "Hachioji candidate outside the building and road coverage"),
    ];
  },
  "example-radial": async (pack, plans) => {
    const V = byName(plans, "station-variants");
    const stub = byName(plans, "transfer-stub");
    const P = 0.0006;
    const std = { clearing: 0.0012 };
    const at = (index) => V.stationCandidates[index].location;
    const dense = (index) => { const [x, y] = at(index); return [[x + P / 2, y + P / 2], [x - P / 2, y + P / 2], [x + P / 2, y - P / 2]]; };
    const ex = (file, index, key, name, extra = {}) => {
      const opts = extra.opts ?? std;
      return { file, mode: "scratch", plan: V, index, key: `example:radial:${key}`, name, entrances: "suggest", layers: (c) => syntheticLayers(c, opts), layerSource: { kind: "synthetic-layers", options: opts }, ...extra.spec };
    };
    return [
      ex("01-ground-side-general", 0, "station-ground-side", "Outer ground station (side platforms)"),
      ex("02-elevated-island-general", 1, "station-elevated-island", "Inner elevated station (island platform)"),
      ex("03-shallow-cut-cover", 3, "station-cut-cover", "Cut-and-cover station (11 m)"),
      ex("04-deep-station", 2, "station-deep", "CBD deep station (36 m)"),
      // no existing network in a synthetic pack: the transfer target is a station of another plan (the stub beside the CBD)
      ex("05-plan-transfer", 2, "station-plan-transfer", "CBD deep station with a passage to the stub line's station", { spec: { transfers: [{ targetStationId: stub.stationCandidates[0].id, via: [[0.0016, 0.0002]] }] } }),
      ex("06-terminal-turnback", 5, "station-terminal", "Outer terminal (turn-back candidate)"),
      ex("07-blocked-entrances", 4, "station-blocked-entrances", "Dense-block candidate whose entrances all land on buildings", { opts: { clearing: 0, blockedAt: dense(4) }, spec: { entrances: dense(4) } }),
      ex("08-partial-layers", 4, "station-partial-layers", "Candidate with only terrain and roads known", { opts: { only: ["dem", "roads"] } }),
    ];
  },
  "example-corridor": async (pack, plans) => [
    { file: "01-corridor-no-layers", mode: "scratch", plan: plans[0], index: 1, key: "example:corridor:station-no-layers", name: "Corridor station with no spatial layers at all", entrances: "suggest", layerSource: { kind: "none" } },
  ],
};

const only = process.argv[2];
for (const id of Object.keys(EXAMPLES).filter((k) => !only || k === only)) {
  const pack = loadPack(id);
  const plans = planExamples(pack);
  const outDir = path.join(root, pack.dir, "station-examples");
  fs.mkdirSync(outDir, { recursive: true });
  for (const spec of await EXAMPLES[id](pack, plans)) {
    const site = await produce(pack, plans, spec);
    fs.writeFileSync(path.join(outDir, `${spec.file}.station.json`), `${JSON.stringify(site, null, 2)}\n`);
    console.log(`[${id}] ${spec.file}: ${site.stationSiteId} q=${site.dataQuality} head=${site.bodyHeadingDegrees} area=${site.bodyAreaSquareMeters} bldg=${site.intersectedBuildingCount} ent=${site.entranceCandidates.length} xfer=${site.transferCandidates.length} work=${site.workAreaCandidates.length} demand=${site.demandAccess.length} flags=[${site.spatialFlags}] unknown=[${site.unknown}]`);
  }
}
