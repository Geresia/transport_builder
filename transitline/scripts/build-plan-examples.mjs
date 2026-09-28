// Dev-time generator for the PlanGeometry examples in packs/<id>/plan-examples/.
//   node scripts/build-plan-examples.mjs [packId]
//
// The map code in engine/src/map holds no geometry; this script is what loads the pack-side data
// (and the local, git-ignored DEM / roads) and injects it as spatial layers. A layer whose file is
// missing is skipped, so its fields come out as unknown (null) — never 0. The layer summary is printed
// so a regeneration on a machine without the DEM is noticed instead of silently degrading the examples.
import fs from "node:fs";
import path from "node:path";
import { buildMapExport } from "../engine/src/map/plan-geometry.mjs";
import { makeSpatialContext } from "../engine/src/map/spatial.mjs";
import { root, readJson, loadPack, tokyoSpatial } from "./lib/pack-spatial.mjs";

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
      // stations of every structure the station-site examples need: ground, elevated, cut-and-cover, deep, shield, terminal
      { file: "05-station-variants-scratch", mode: "scratch", drawn: {
        key: "example:tokyo:station-variants", name: "Station variants (ground / elevated / cut-and-cover / deep / shield / terminal)",
        legs: [{ structureHint: "surface" }, { structureHint: "elevated" }, { structureHint: "cut-cover" }, { structureHint: "deep" }, { structureHint: "shield" }],
        vertices: [
          v(pack, "ward-setagaya", { structure: "surface", platformType: "side", platformLengthM: 88 }),
          v(pack, "ward-meguro", { structure: "elevated", platformType: "island", platformLengthM: 88 }),
          v(pack, "ward-shibuya", { structure: "cut-cover", depthMeters: 12, platformType: "side", platformLengthM: 88 }),
          v(pack, "ward-shinjuku", { structure: "deep", depthMeters: 38, platformType: "island", platformLengthM: 88 }),
          v(pack, "ward-bunkyo", { structure: "shield", depthMeters: 24, platformType: "side", platformLengthM: 88 }),
          v(pack, "ward-taito", { structure: "surface", platformType: "side", platformLengthM: 88 }),
        ] } },
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
    // stations a few hundred metres from the CBD stations, placed freely: the transfer target of the station-site examples
    { file: "05-transfer-stub", mode: "scratch", drawn: {
      key: "example:radial:transfer-stub", name: "Short stub line beside the CBD (transfer target)",
      vertices: [{ location: [0.003, 0.0012], platformType: "side", platformLengthM: 88 }, { location: [0.009, 0.004], platformType: "side", platformLengthM: 88 }] } },
    { file: "04-station-variants", mode: "scratch", drawn: {
      key: "example:radial:station-variants", name: "Station variants (ground / elevated / deep / cut-and-cover / shield / terminal)",
      legs: [{ structureHint: "surface" }, { structureHint: "elevated" }, { structureHint: "deep" }, { structureHint: "cut-cover" }, { structureHint: "shield" }],
      vertices: [
        v(pack, "outer-4", { structure: "surface", platformType: "side", platformLengthM: 88 }),
        v(pack, "inner-4", { structure: "elevated", platformType: "island", platformLengthM: 88 }),
        v(pack, "cbd", { structure: "deep", depthMeters: 36, platformType: "island", platformLengthM: 88 }),
        v(pack, "inner-1", { structure: "cut-cover", depthMeters: 11, platformType: "side", platformLengthM: 88 }),
        v(pack, "mid-1", { structure: "shield", depthMeters: 24, platformType: "side", platformLengthM: 88 }),
        v(pack, "outer-1", { structure: "surface", platformType: "side", platformLengthM: 88 }),
      ] } },
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
