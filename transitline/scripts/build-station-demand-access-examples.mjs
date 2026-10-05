// Dev-time generator for the station demand / access examples in packs/<id>/station-demand-access-examples/.
//   node scripts/build-station-demand-access-examples.mjs [packId] [--out <dir>]   (npm run station-demand-access-examples)
// With --out the files go to <dir>/<packId>/ instead of the pack (the tests use that to check regeneration).
//
// Each example is a drawing the way the editor (station-demand-access-editor.mjs) would save it, on a station of a plan in
// packs/<id>/plan-examples/ (its real planId / station id). The DRAWINGS are synthetic: entrances, walking links, boundaries
// and zones were placed by hand here, not taken from any real station. Spatial layers: synthetic ones for the synthetic
// packs (scripts/lib/synthetic-layers.mjs), and for Tokyo only the layers that are tracked in the repository (water from
// barriers.json, building footprints from obstacles.json — four districts); the DEM and roads are git-ignored dev data and
// are left out so every file reproduces from the repository alone. The pack's demand / OD files are linked by source and
// quality only: no value of theirs is copied. Nothing here reads a clock or a random number.
import fs from "node:fs";
import path from "node:path";
import { demandNodesFromPack, existingNetworkToExternal } from "../engine/src/map/plan-geometry.mjs";
import { makeSpatialContext, waterLayerFromBarriers, buildingLayerFromObstacles } from "../engine/src/map/spatial.mjs";
import { round6 } from "../engine/src/map/ids.mjs";
import { buildStationDemandAccessExport, demandSourceRefsOf } from "../engine/src/map/station-demand-access.mjs";
import {
  activeStations, addAccessPoint, addCatchment, addDemandZone, addEntrance, addStation, addWalkLink, newStationDemandAccessDoc, setTransfer, toDrawnStation,
} from "../engine/src/map/station-demand-access-editor.mjs";
import { root, readJson, exists, loadPack } from "./lib/pack-spatial.mjs";
import { syntheticLayers } from "./lib/synthetic-layers.mjs";

const GENERATED_BY = "scripts/build-station-demand-access-examples.mjs";
const NOTE = "Synthetic drawing placed by hand for this example on a real plan station of this pack; the entrances, walking links, boundaries and zones are not any real station's. Demand and OD files are linked by source and quality only.";
const args = process.argv.slice(2);
const outFlag = args.indexOf("--out");
const outRoot = outFlag >= 0 ? path.resolve(args[outFlag + 1]) : null;
const only = args.find((a, i) => !a.startsWith("--") && i !== outFlag + 1);

const planExamples = (pack) => {
  const dir = path.join(root, pack.dir, "plan-examples");
  return fs.readdirSync(dir).filter((f) => f.endsWith(".plan.json")).sort().map((f) => readJson(`${pack.dir}/plan-examples/${f}`));
};
const byName = (plans, suffix) => plans.find((p) => p.source.drawnLine.key.endsWith(suffix));
// a point `east` / `north` metres from `c`, and a rectangle ring around it
const at = ([lon, lat], east, north) => [round6(lon + east / (111320 * Math.cos((lat * Math.PI) / 180))), round6(lat + north / 111320)];
const box = (c, e0, n0, e1, n1) => [at(c, e0, n0), at(c, e1, n0), at(c, e1, n1), at(c, e0, n1)];

// --- the pack's demand and OD files, as source references ---
const attributionFor = (pack, file) => (pack.manifest.data?.attribution ?? []).filter((line) => line.includes(`(${file}`));
function sourcesOf(pack, files) {
  return demandSourceRefsOf(files.map((f) => ({
    file: f.file, kind: f.kind, document: readJson(`${pack.dir}/${f.file}`), attribution: attributionFor(pack, f.file),
    spatialResolution: f.spatialResolution, quality: f.quality, license: pack.manifest.data?.license ?? null,
  })), pack.manifest.id);
}

// --- Tokyo layers that exist in the repository itself ---
function tokyoTrackedLayers(pack) {
  const layers = {};
  const [w, s, e, n] = pack.manifest.bbox;
  if (exists(`${pack.dir}/barriers.json`)) {
    layers.water = waterLayerFromBarriers(readJson(`${pack.dir}/barriers.json`), {
      covers: ([x, y]) => x >= w && x <= e && y >= s && y <= n, quality: "medium",
      source: { name: "国土交通省 国土数値情報 water polygons (via smartnews-smri/japan-topography), packs/tokyo/barriers.json", license: "MLIT-KSJ-terms" },
    });
  }
  if (exists(`${pack.dir}/obstacles.json`)) {
    layers.buildings = buildingLayerFromObstacles(readJson(`${pack.dir}/obstacles.json`), {
      quality: "high", source: { name: "OpenStreetMap building footprints, packs/tokyo/obstacles.json (four districts)", license: "ODbL-1.0" },
    });
  }
  return layers;
}

// spec: { file, case[], plan, index?, externalStationId?, mode?, key, name, layers: () => layers, layerSource, draw(doc, stationKey, ctx) }
function produce(pack, plans, spec, sources) {
  const planRecord = spec.plan;
  const planStation = planRecord.stationCandidates[spec.index ?? 0];
  const center = planStation.location;
  const spatial = makeSpatialContext(spec.layers(center));
  const network = pack.existingNetwork ? existingNetworkToExternal(pack) : null;
  const mapExport = { plans, demandNodes: demandNodesFromPack(pack), externalNetworks: spec.mode === "existing" && network ? [network] : [] };
  const doc = newStationDemandAccessDoc(pack.manifest.id, pack.manifest.version ?? null);
  const connect = spec.externalStationId ? { externalNetworkId: network.id, stationId: spec.externalStationId } : { planId: planRecord.planId, stationId: planStation.id };
  const st = addStation(doc, { key: spec.key, name: spec.name, connect });
  spec.draw(doc, st.key, { center });
  const out = buildStationDemandAccessExport({ pack, mapExport, stations: activeStations(doc).map(toDrawnStation), spatial, demandSources: sources });
  if (out.sites.length !== 1) throw new Error(`${pack.manifest.id}/${spec.file} was not built: ${JSON.stringify(out.warnings)}`);
  return { ...out.sites[0], source: { case: spec.case, synthetic: true, note: NOTE, layers: spec.layerSource, input: { drawn: toDrawnStation(activeStations(doc)[0]), mode: spec.mode ?? "scratch" }, generatedBy: GENERATED_BY } };
}

// The common drawing: two entrances, a crossing and a street access point, a residential zone to the north-east, links, two boundaries.
function standard(doc, key, { center }, { link = true } = {}) {
  const e1 = addEntrance(doc, key, { name: "North entrance", location: at(center, 30, 25) });
  addEntrance(doc, key, { name: "South entrance", location: at(center, -35, -20) });
  const p1 = addAccessPoint(doc, key, { name: "Crossing", location: at(center, 30, 110), kind: "crossing" });
  const p2 = addAccessPoint(doc, key, { name: "Back street", location: at(center, -40, -140), kind: "street" });
  const z1 = addDemandZone(doc, key, { name: "Homes north-east", kind: "residential", polygon: box(center, 60, 130, 260, 260) });
  if (link) {
    addWalkLink(doc, key, { name: "North entrance to crossing", from: { kind: "entrance", key: e1.key }, to: { kind: "access-point", key: p1.key }, via: [at(center, 30, 70)] });
    addWalkLink(doc, key, { name: "Crossing to the homes", from: { kind: "access-point", key: p1.key }, to: { kind: "demand-zone", key: z1.key }, widthMeters: 4 });
    addWalkLink(doc, key, { name: "Station to back street", from: { kind: "station" }, to: { kind: "access-point", key: p2.key } });
  }
  addCatchment(doc, key, { name: "Access boundary", polygon: box(center, -450, -350, 450, 350) });
  addCatchment(doc, key, { name: "North entrance boundary", entranceKey: e1.key, polygon: box(center, -80, -60, 300, 300) });
}

const SYNTHETIC_SOURCES = (pack) => sourcesOf(pack, [{ file: "demand.json", kind: "demand-points", spatialResolution: "synthetic-node", quality: null }]);

const EXAMPLES = {
  "example-radial": (pack, plans) => {
    const V = byName(plans, "station-variants");
    const stub = byName(plans, "transfer-stub");
    const std = { clearing: 0.003 }; // ~330 m without footprints around the station, so a drawn walk can be clear of them
    const synth = (opts) => (c) => syntheticLayers(c, opts);
    const src = (opts) => ({ kind: "synthetic-layers", options: opts });
    const blocked = (c) => [at(c, 25, 20), at(c, -30, -15), at(c, 30, 105)];
    return {
      sources: SYNTHETIC_SOURCES(pack),
      specs: [
        { file: "01-full-drawing", case: ["entrances", "access-points", "walk-links", "catchments", "demand-zone"], plan: V, index: 1, key: "example:radial:access-full", name: "Inner station with a full access drawing", layers: synth(std), layerSource: src(std), draw: (d, k, c) => standard(d, k, c) },
        { file: "02-entrance-through-buildings", case: ["entrance-inside-building", "walk-through-buildings"], plan: V, index: 3, key: "example:radial:access-blocked", name: "Station whose entrance and link land on buildings",
          layers: (c) => syntheticLayers(c, { clearing: 0, blockedAt: blocked(c) }), layerSource: src({ clearing: 0, blockedAt: "entrances and the crossing" }), draw: (d, k, c) => standard(d, k, c) },
        { file: "03-zone-and-points-without-links", case: ["no-walk-link-drawn", "catchment-excludes-station"], plan: V, index: 0, key: "example:radial:access-unlinked", name: "Outer station with nothing walked to yet",
          layers: synth(std), layerSource: src(std), draw: (d, k, c) => { standard(d, k, c, { link: false }); addCatchment(d, k, { name: "Boundary drawn beside the station", polygon: box(c.center, 200, 200, 500, 450) }); } },
        { file: "04-transfer-passage", case: ["transfer-passage", "entrance-for-passage"], plan: V, index: 2, key: "example:radial:access-transfer", name: "CBD station with a passage to the stub line's station",
          layers: synth(std), layerSource: src(std), draw: (d, k, c) => {
            const e = addEntrance(d, k, { name: "Concourse entrance", location: at(c.center, 25, 15) });
            addCatchment(d, k, { name: "Access boundary", polygon: box(c.center, -400, -300, 400, 300) });
            setTransfer(d, k, stub.stationCandidates[0].id, [at(c.center, 90, 25)], { fromEntranceKey: e.key, widthMeters: 5 });
          } },
        { file: "05-partial-layers", case: ["partial-layers"], plan: V, index: 4, key: "example:radial:access-partial", name: "Candidate with only terrain and roads known",
          layers: synth({ only: ["dem", "roads"] }), layerSource: src({ only: ["dem", "roads"] }), draw: (d, k, c) => standard(d, k, c) },
      ],
    };
  },
  "example-corridor": (pack, plans) => ({
    sources: SYNTHETIC_SOURCES(pack),
    specs: [
      { file: "01-no-layers", case: ["no-layers"], plan: plans[0], index: 1, key: "example:corridor:access-no-layers", name: "Corridor station with no spatial layers at all", layers: () => ({}), layerSource: { kind: "none" }, draw: (d, k, c) => standard(d, k, c) },
      { file: "02-nothing-drawn", case: ["nothing-drawn"], plan: plans[0], index: 0, key: "example:corridor:access-nothing", name: "Corridor terminal before the player drew anything", layers: () => ({}), layerSource: { kind: "none" }, draw: () => {} },
    ],
  }),
  tokyo: (pack, plans) => {
    const base = tokyoTrackedLayers(pack);
    const layerSource = { kind: "tokyo-tracked-layers", layers: Object.keys(base), note: "DEM and roads are git-ignored dev data and are not used, so their facts are unknown" };
    const free = byName(plans, "shinjuku-free-placed");
    const bay = byName(plans, "bay-ward-spine");
    const sources = sourcesOf(pack, [
      { file: "demand.json", kind: "demand-points", spatialResolution: "municipality-centroid", quality: "low" },
      { file: "od.json", kind: "od-commute", spatialResolution: "municipality", quality: "low" },
      { file: "od-school.json", kind: "od-school", spatialResolution: "municipality", quality: "low" },
    ]);
    return {
      sources,
      specs: [
        { file: "01-shinjuku-inside-building-coverage", case: ["footprints-known", "entrance-inside-building", "walk-links"], mode: "scratch", plan: free, index: 1, key: "example:tokyo:access-shinjuku", name: "Free-placed Shinjuku station inside the footprint coverage",
          layers: () => base, layerSource, draw: (d, k, c) => standard(d, k, c) },
        { file: "02-ward-station-outside-coverage", case: ["outside-coverage", "demand-node-inside-zone", "transfer-nearby"], mode: "existing", plan: bay, index: 2, key: "example:tokyo:access-minato", name: "Minato station on the existing-network start, outside the footprint coverage",
          layers: () => base, layerSource, draw: (d, k, c) => {
            standard(d, k, c);
            addDemandZone(d, k, { name: "Ward centroid area", kind: "mixed", polygon: box(c.center, -700, -600, 700, 600) });
          } },
        { file: "03-external-station-no-drawing", case: ["external-station", "nothing-drawn"], mode: "existing", plan: bay, index: 1, externalStationId: "ward-shinagawa", key: "example:tokyo:access-external", name: "An existing-network station, nothing drawn yet",
          layers: () => base, layerSource, draw: () => {} },
      ],
    };
  },
};

for (const id of Object.keys(EXAMPLES).filter((k) => !only || k === only)) {
  const pack = loadPack(id);
  const plans = planExamples(pack);
  const outDir = outRoot ? path.join(outRoot, id) : path.join(root, pack.dir, "station-demand-access-examples");
  fs.mkdirSync(outDir, { recursive: true });
  const { sources, specs } = EXAMPLES[id](pack, plans);
  for (const spec of specs) {
    const site = produce(pack, plans, spec, sources);
    fs.writeFileSync(path.join(outDir, `${spec.file}.station-demand-access.json`), `${JSON.stringify(site, null, 2)}\n`);
    console.log(`[${id}] ${spec.file}: ${site.stationAccessId} q=${site.dataQuality} kind=${site.stationKind} ent=${site.entrances.length} pts=${site.accessPoints.length} links=${site.walkLinks.length} xfer=${site.transfers.length} catch=${site.catchments.length} zones=${site.demandZones.length} flags=[${site.spatialFlags}] unknown=${site.unknown.length} warn=[${site.warnings.map((w) => w.code)}]`);
  }
}
