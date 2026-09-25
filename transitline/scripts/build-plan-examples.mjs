// Dev-time generator for the PlanGeometry examples in packs/<id>/plan-examples/.
//   node scripts/build-plan-examples.mjs [packId]
//
// The map code in engine/src/map holds no geometry; this script is what loads the pack-side data
// (and the local, git-ignored DEM / roads) and injects it as spatial layers. A layer whose file is
// missing is skipped, so its fields come out as unknown (null) — never 0. The layer summary is printed
// so a regeneration on a machine without the DEM is noticed instead of silently degrading the examples.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildMapExport } from "../engine/src/map/plan-geometry.mjs";
import {
  makeSpatialContext, waterLayerFromBarriers, buildingLayerFromObstacles, roadLayerFromGeojson, regionCovers,
} from "../engine/src/map/spatial.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (p) => JSON.parse(fs.readFileSync(path.join(root, p), "utf8"));
const exists = (p) => fs.existsSync(path.join(root, p));

function loadPack(id) {
  const dir = `packs/${id}`;
  const manifest = readJson(`${dir}/manifest.json`);
  return {
    dir, manifest,
    demand: readJson(`${dir}/${manifest.files.demand}`),
    existingNetwork: manifest.files.existingNetwork ? readJson(`${dir}/${manifest.files.existingNetwork}`) : null,
  };
}

// --- GSI DEM10B 31 m grid (data-raw/terrain/README.md documents the pixel formula) ---
function loadDem() {
  const base = "data-raw/terrain/derived";
  if (!exists(`${base}/elev-31m.i16`) || !exists(`${base}/slope-31m.u8`)) return null;
  const g = readJson(`${base}/grid.json`);
  const raw = fs.readFileSync(path.join(root, `${base}/elev-31m.i16`));
  const elev = new Int16Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length));
  const slope = fs.readFileSync(path.join(root, `${base}/slope-31m.u8`));
  const world = 256 * 2 ** g.zoom;
  const cell = ([lon, lat]) => {
    const px = ((lon + 180) / 360) * world;
    const latR = (lat * Math.PI) / 180;
    const py = ((1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2) * world;
    const x = Math.floor((px - g.originTileX * 256) / g.cellPixels);
    const y = Math.floor((py - g.originTileY * 256) / g.cellPixels);
    return x >= 0 && y >= 0 && x < g.width && y < g.height ? y * g.width + x : -1;
  };
  return {
    elevationAt: (pt) => { const i = cell(pt); return i < 0 || elev[i] === -32768 ? null : elev[i]; },
    slopeAt: (pt) => { const i = cell(pt); return i < 0 || slope[i] === 255 ? null : slope[i]; },
    quality: "medium", // 31 m mean cells: cliffs and cuttings narrower than that are averaged away
    source: { name: "国土地理院 数値標高モデル DEM10B (dem_png z14), 31 m mean grid", license: "GSI terms of use (credit: 国土地理院)" },
  };
}

function tokyoSpatial(pack) {
  const layers = {};
  const dem = loadDem();
  if (dem) layers.dem = dem;

  if (exists(`${pack.dir}/barriers.json`)) {
    const [w, s, e, n] = pack.manifest.bbox;
    layers.water = waterLayerFromBarriers(readJson(`${pack.dir}/barriers.json`), {
      covers: ([x, y]) => x >= w && x <= e && y >= s && y <= n, quality: "medium",
      source: { name: "国土交通省 国土数値情報 water polygons (via smartnews-smri/japan-topography), packs/tokyo/barriers.json", license: "MLIT-KSJ-terms" },
    });
  }

  // OSM footprints exist only for four districts; coverage is those districts (see buildingLayerFromObstacles)
  if (exists(`${pack.dir}/obstacles.json`)) {
    layers.buildings = buildingLayerFromObstacles(readJson(`${pack.dir}/obstacles.json`), {
      quality: "high", source: { name: "OpenStreetMap building footprints, packs/tokyo/obstacles.json", license: "ODbL-1.0" },
    });
  }

  // OSM roads were fetched for the 23 wards only: coverage = the 23 ward polygons
  if (exists("subway-builder-export/roads.all.geojson")) {
    const wards = readJson(`${pack.dir}/wards-reference.json`).wards;
    layers.roads = roadLayerFromGeojson(readJson("subway-builder-export/roads.all.geojson"), {
      covers: regionCovers(wards.flatMap((w) => w.polygons)), quality: "high",
      source: { name: "OpenStreetMap roads (23 wards), subway-builder-export/roads.all.geojson", license: "ODbL-1.0" },
    });
  }
  const status = Object.fromEntries(["dem", "water", "buildings", "roads"].map((k) => [k, Boolean(layers[k])]));
  return { spatial: makeSpatialContext(layers), status };
}

const at = (pack, id) => pack.demand.points.find((p) => p.id === id).location;
const v = (pack, id, extra = {}) => ({ location: at(pack, id), demandNodeId: id, ...extra });

const EXAMPLES = {
  tokyo: (pack) => {
    // free-placed stations inside the Shinjuku footprint coverage (bbox of that district's OSM footprints)
    const shinjuku = readJson(`${pack.dir}/obstacles.json`).obstacles.filter((o) => o.district === "shinjuku");
    const xs = shinjuku.flatMap((o) => o.polygon.map((p) => p[0]));
    const ys = shinjuku.flatMap((o) => o.polygon.map((p) => p[1]));
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const at01 = (a, b) => [x0 + (x1 - x0) * a, y0 + (y1 - y0) * b];
    return [
      { file: "01-bay-ward-spine-existing", mode: "existing", drawn: {
        key: "example:tokyo:bay-ward-spine", name: "Bay ward spine (Ota-Shinagawa-Minato-Chiyoda)",
        vertices: ["ward-ota", "ward-shinagawa", "ward-minato", "ward-chiyoda"].map((id) => v(pack, id, { platformType: "side" })) } },
      { file: "02-east-river-crossing-existing", mode: "existing", drawn: {
        key: "example:tokyo:east-river-crossing", name: "East river crossing (Koto-Sumida-Edogawa)",
        legs: [{ structureHint: "elevated" }, { structureHint: "shield" }],
        vertices: [v(pack, "ward-koto", { platformType: "island" }), v(pack, "ward-sumida", { platformType: "island" }), v(pack, "ward-edogawa", { platformType: "side", structure: "shield", depthMeters: 24 })] } },
      { file: "03-tama-hills-scratch", mode: "scratch", drawn: {
        key: "example:tokyo:tama-hills", name: "Tama hills (Ome-Hachioji)",
        vertices: [v(pack, "kanto-13205"), v(pack, "kanto-13201")] } },
      { file: "04-shinjuku-free-placed-scratch", mode: "scratch", drawn: {
        key: "example:tokyo:shinjuku-free-placed", name: "Shinjuku free-placed stations",
        legs: [{ via: [at01(0.55, 0.3)] }, {}],
        vertices: [{ location: at01(0.2, 0.25) }, { location: at01(0.5, 0.75), platformType: "island" }, { location: at01(0.85, 0.6) }] } },
    ];
  },
  "example-radial": (pack) => [
    { file: "01-radial-spoke-annotated", mode: "scratch", drawn: {
      key: "example:radial:spoke", name: "Radial spoke (fully annotated)",
      legs: [{ structureHint: "surface" }, { structureHint: "elevated" }, { structureHint: "elevated" }],
      vertices: ["cbd", "inner-1", "mid-1", "outer-1"].map((id) => v(pack, id, { platformType: "side", platformLengthM: 120 })) } },
    { file: "02-ring-arc-unannotated", mode: "scratch", drawn: {
      key: "example:radial:ring-arc", name: "Ring arc (nothing annotated)",
      vertices: ["mid-1", "mid-2", "mid-3", "mid-4"].map((id) => v(pack, id)) } },
    { file: "03-cross-city-with-bend", mode: "scratch", drawn: {
      key: "example:radial:cross-city", name: "Cross-city through the CBD (with a waypoint)",
      legs: [{ structureHint: "shield" }, { structureHint: "shield", via: [[0.012, -0.012]] }],
      vertices: [v(pack, "outer-1", { platformType: "island", depthMeters: 22 }), v(pack, "cbd", { platformType: "island", depthMeters: 28 }), v(pack, "outer-7", { platformType: "island", depthMeters: 22 })] } },
  ],
  "example-corridor": (pack) => [
    { file: "01-corridor-trunk", mode: "scratch", drawn: {
      key: "example:corridor:trunk", name: "Corridor trunk (matrix pack: residents/jobs unknown)",
      vertices: pack.demand.points.slice(0, 4).map((p) => v(pack, p.id, { platformType: "side" })) } },
  ],
};

const only = process.argv[2];
for (const id of Object.keys(EXAMPLES).filter((k) => !only || k === only)) {
  const pack = loadPack(id);
  const { spatial, status } = id === "tokyo" ? tokyoSpatial(pack) : { spatial: makeSpatialContext(), status: null };
  console.log(`[${id}] layers:`, status ?? "none (synthetic pack: spatial fields are unknown)");
  const outDir = path.join(root, pack.dir, "plan-examples");
  fs.mkdirSync(outDir, { recursive: true });
  for (const ex of EXAMPLES[id](pack)) {
    const exp = buildMapExport({ pack, mode: ex.mode, drawnLines: [ex.drawn], spatial });
    const plan = { ...exp.plans[0], source: { drawnLine: ex.drawn, requestedMode: ex.mode, generatedBy: "scripts/build-plan-examples.mjs" } };
    fs.writeFileSync(path.join(outDir, `${ex.file}.plan.json`), `${JSON.stringify(plan, null, 2)}\n`);
    console.log(`  ${ex.file}: ${plan.planId} quality=${plan.dataQuality} unknown=[${plan.unknownSummary.join(", ")}]`);
  }
}
