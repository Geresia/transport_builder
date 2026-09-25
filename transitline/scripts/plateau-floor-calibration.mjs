// Pool the surveyed floor-area / mesh-footprint ratio (per height band) across every PLATEAU city that has a real
// surveyed 延床面積 alongside a mesh footprint, and write scripts/plateau-floor-ratio.json. Cities with too few (or
// no) surveyed buildings of their own - Kashiwa, Chiba-shi, Kisarazu, Yachiyo, ... - fall back to this table in
// plateau-chome.mjs's buildingRecords(). MODELED: it assumes a city without surveys has a building stock whose
// floor/footprint-by-height relationship resembles the pooled Kanto cities'.
// Usage: node scripts/plateau-floor-calibration.mjs <plateau-city.json> [<plateau-city.json> ...]
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { fitFloorRatio } from "./plateau-chome.mjs";

const files = process.argv.slice(2);
if (!files.length) throw new Error("pass the plateau-<city>.json files (from plateau-buildings.mjs) to pool");
const rows = [], cities = {};
for (const f of files) {
  const r = JSON.parse(fs.readFileSync(f, "utf8"));
  const own = fitFloorRatio(r);
  cities[path.basename(f, ".json").replace(/^plateau-/, "")] = { surveyedWithMesh: own.n, all: own.all, unknown: own.unknown };
  for (const x of r) rows.push(x);
}
const pooled = fitFloorRatio(rows);
const out = { ...pooled, pooledFrom: cities, note: "median(surveyed 延床面積 / mesh footprint) per 計測高さ band, pooled over the listed cities; used only where a city has < 300 surveyed buildings of its own" };
fs.writeFileSync(fileURLToPath(new URL("./plateau-floor-ratio.json", import.meta.url)), JSON.stringify(out, null, 1));
console.log("bands (m):", out.edges.slice(0, -1).map((e, i) => `${e}-${out.edges[i + 1] > 1e6 ? "" : out.edges[i + 1]}`).join(" "));
console.log("ratio    :", out.ratios.join(" "));
console.log("n        :", out.binN.join(" "));
console.log("unknown height:", out.unknown, " overall:", out.all, " total surveyed buildings:", out.n);
console.log(cities);
