// Converts real building footprints (scripts/tokyo-survey-buildings.mjs's NDJSON, official Tokyo land-use
// survey polygons) into the `buildings_index.json` shape the game reads (BuildingsIndex in
// compatibility-test-mod's src/types/index.d.ts, MIT-licensed API types - reused as a target format).
//
// Scope: any set of wards, or "all" for the full 23. A 23-ward file is several hundred MB, so this streams
// the NDJSON twice (bounds+grid pass, then a building-by-building write) instead of holding the whole output
// in memory as one JSON string - the previous single-ward version's JSON.stringify(everything) approach
// doesn't scale to that size.
//
// What's real: every building's footprint polygon and grid placement (from the official survey, not OSM).
// What's a placeholder: `foundationDepth` is 0 for every building. A real value needs basement floor counts
// (obstacles.json's levels_underground, from a DIFFERENT building set - OSM footprints, not survey polygons)
// joined onto these buildings; that join was out of scope for this pass, so we do not fabricate a depth.
//
// Usage: node --max-old-space-size=4096 scripts/export-subway-builder-buildings.mjs <tokyo23-survey.ndjson> [scope=chiyoda] [cellSizeDeg]
//   scope: a ward slug, a comma-separated list of ward slugs, or "all" for every ward in the file.
//   Output file name: buildings_index.<scope-or-"all">.json (commas become "+").
import fs from "node:fs";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
const OUT = fileURLToPath(new URL("../subway-builder-export/", import.meta.url));
fs.mkdirSync(OUT, { recursive: true });

const [ndjsonPath, scopeArg, cellArg] = process.argv.slice(2);
if (!ndjsonPath) throw new Error("usage: export-subway-builder-buildings.mjs <tokyo23-survey.ndjson> [scope=chiyoda|ward1,ward2|all] [cellSizeDeg]");
const scope = scopeArg || "chiyoda";
const wantAll = scope === "all";
const wanted = wantAll ? null : new Set(scope.split(","));
const keep = (d) => wantAll || wanted.has(d);
const cellSize = Number(cellArg) || 0.002; // degrees; ~200m at Tokyo's latitude
const outName = `buildings_index.${scope.replace(/,/g, "+")}.json`;
const outPath = OUT + outName;

const ringOf = (f) => (f.geometry.type === "Polygon" ? f.geometry.coordinates[0] : f.geometry.coordinates[0][0]); // outer ring only - this format has no hole support

// ---- pass 1: bounds + district counts + global bbox (numbers only, cheap even at 1.79M buildings) ----
console.log("pass 1: reading bounds ...");
const minXs = [], minYs = [], maxXs = [], maxYs = [];
let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
const perWard = {};
{
  const rl = readline.createInterface({ input: fs.createReadStream(ndjsonPath), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    const f = JSON.parse(line);
    const d = f.properties.district;
    if (!keep(d)) continue;
    perWard[d] = (perWard[d] || 0) + 1;
    const ring = ringOf(f);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of ring) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    minXs.push(x0); minYs.push(y0); maxXs.push(x1); maxYs.push(y1);
    if (x0 < minLon) minLon = x0; if (x1 > maxLon) maxLon = x1; if (y0 < minLat) minLat = y0; if (y1 > maxLat) maxLat = y1;
  }
}
const n = minXs.length;
if (n === 0) throw new Error(`no buildings found for scope '${scope}' in ${ndjsonPath}`);
console.log(`pass 1 done: ${n} buildings, wards: ${JSON.stringify(perWard)}`);

const cols = Math.max(1, Math.ceil((maxLon - minLon) / cellSize));
const rows = Math.max(1, Math.ceil((maxLat - minLat) / cellSize));
const cells = Array.from({ length: cols * rows }, () => []);
for (let i = 0; i < n; i++) {
  const c0 = Math.min(cols - 1, Math.floor((minXs[i] - minLon) / cellSize)), c1 = Math.min(cols - 1, Math.floor((maxXs[i] - minLon) / cellSize));
  const r0 = Math.min(rows - 1, Math.floor((minYs[i] - minLat) / cellSize)), r1 = Math.min(rows - 1, Math.floor((maxYs[i] - minLat) / cellSize));
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) cells[r * cols + c].push(i);
}
const nonEmptyCells = cells.reduce((s, c) => s + (c.length > 0 ? 1 : 0), 0);
console.log(`grid: ${cols}x${rows} = ${cells.length} cells, ${nonEmptyCells} non-empty`);

// ---- pass 2: re-stream the NDJSON, writing each building object straight to disk (never holding the full
//      output in memory) using the same bounds computed above so building index i lines up in both passes. ----
console.log("pass 2: writing buildings ...");
const out = fs.createWriteStream(outPath);
let streamError = null;
out.on("error", (e) => { streamError = e; });
const write = (chunk) => new Promise((resolve, reject) => {
  if (streamError) return reject(streamError);
  if (out.write(chunk)) resolve();
  else out.once("drain", () => (streamError ? reject(streamError) : resolve()));
});
await write(`{"cellSize":${cellSize},"minLon":${minLon},"maxLon":${maxLon},"minLat":${minLat},"maxLat":${maxLat},"cols":${cols},"rows":${rows},"cells":${JSON.stringify(cells)},"buildings":[`);
{
  const rl = readline.createInterface({ input: fs.createReadStream(ndjsonPath), crlfDelay: Infinity });
  let i = 0;
  for await (const line of rl) {
    if (!line) continue;
    const f = JSON.parse(line);
    if (!keep(f.properties.district)) continue;
    const ring = ringOf(f);
    const b = { id: `bldg-${i}`, bounds: { minX: minXs[i], minY: minYs[i], maxX: maxXs[i], maxY: maxYs[i], foundationDepth: 0 }, polygon: ring, foundationDepth: 0 };
    await write((i > 0 ? "," : "") + JSON.stringify(b));
    i++;
    if (i % 200000 === 0) console.log(`  ${i}/${n}`);
  }
  if (i !== n) throw new Error(`pass 2 wrote ${i} buildings but pass 1 counted ${n} - the file changed between passes`);
}
await write(`],"buildingCount":${n},"nonEmptyCells":${nonEmptyCells},"maxFoundationDepth":0}`);
await new Promise((resolve) => out.end(resolve));

console.log({ scope, buildings: n, cols, rows, nonEmptyCells, cellsTotal: cells.length, bytes: fs.statSync(outPath).size, outPath });
