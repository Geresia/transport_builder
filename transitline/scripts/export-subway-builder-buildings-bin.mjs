// Converts subway-builder-export/buildings_index.<scope>.json (our JSON buildings index) into the binary
// `buildings_index.bin` that Subway Builder v1.7.1 actually reads for a city (loadBuildingIndex ->
// loadBinaryData -> createBinaryDetector; the game refuses JSON here, found 2026-09-26 from its console:
// "Binary load via absolute path is not supported" / "Not a building index binary (bad magic)").
//
// The layout below (88-byte header, then bounds / foundationDepths / ring offsets / coords / cell CSR) was read
// from the installed game's own encoder (encodeBuildingIndexBinary) - read-only, nothing copied, reimplemented.
// Two differences from our JSON worth knowing:
//  - the game derives the grid's longitude step as cellSize / cos(midLat) (square cells in metres), so the grid
//    is recomputed here rather than reused from the JSON.
//  - polygon is a list of rings; we only have each building's outer ring (same as the JSON), so one ring each.
// No heights and no OSM ids (flags = 0): the game then falls back to foundationDepth * 10 for height.
//
// The JSON is ~588 MB - over V8's string limit - so it is scanned as a stream, one building object at a time.
//
// Usage: node --max-old-space-size=6144 scripts/export-subway-builder-buildings-bin.mjs [scope=all] [cellSizeDeg=0.002]
//   in:  subway-builder-export/buildings_index.<scope>.json     out: subway-builder-export/city-TYOTL/buildings_index.bin
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const EXPORT = fileURLToPath(new URL("../subway-builder-export/", import.meta.url));
const scope = process.argv[2] || "all";
const cellSize = Number(process.argv[3]) || 0.002;
const inPath = `${EXPORT}buildings_index.${scope}.json`;
const outDir = `${EXPORT}city-TYOTL/`;
const outPath = `${outDir}buildings_index.bin`;
fs.mkdirSync(outDir, { recursive: true });

// ---- stream: yield each element of the top-level "buildings":[ ... ] array as parsed JSON ----
async function* buildingsOf(path) {
  const MARK = '"buildings":[';
  let depth = 0, inBuildings = false, carry = "", tail = "";
  for await (const chunk of fs.createReadStream(path, { encoding: "utf8", highWaterMark: 1 << 24 })) {
    let text = carry + chunk; carry = "";
    let i = 0;
    if (!inBuildings) {
      const joined = tail + text, at = joined.indexOf(MARK);
      if (at < 0) { tail = joined.slice(-MARK.length); continue; }
      text = joined.slice(at + MARK.length); tail = ""; inBuildings = true;
    }
    depth = 0; let start = -1; // a straddling object is carried over whole (it begins at 0), so rescan it from depth 0
    for (; i < text.length; i++) {
      const ch = text.charCodeAt(i);
      if (ch === 123) { if (depth === 0) start = i; depth++; }                                                   // {
      else if (ch === 125) { depth--; if (depth === 0) { yield JSON.parse(text.slice(start, i + 1)); start = -1; } } // }
      else if (ch === 93 && depth === 0) return;                                                                 // ] ends the array
    }
    if (depth > 0) carry = text.slice(start);
  }
}

// ---- pass over the JSON: bounds, one ring per building, growable coord buffer ----
let n = 0, cap = 1 << 20, coordCap = 1 << 24, coordN = 0;
let bounds = new Float64Array(cap * 4), ringStart = new Uint32Array(cap + 1), depthArr = new Float32Array(cap);
let coords = new Float64Array(coordCap * 2);
let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity, maxDepth = 0;
const grow = (a, len, C) => { const b = new C(len); b.set(a); return b; };
console.log("reading", inPath);
for await (const b of buildingsOf(inPath)) {
  if (n === cap) { cap *= 2; bounds = grow(bounds, cap * 4, Float64Array); ringStart = grow(ringStart, cap + 1, Uint32Array); depthArr = grow(depthArr, cap, Float32Array); }
  const ring = b.polygon;
  if (coordN + ring.length > coordCap) { coordCap = Math.max(coordCap * 2, coordN + ring.length); coords = grow(coords, coordCap * 2, Float64Array); }
  ringStart[n] = coordN;
  for (const [x, y] of ring) { coords[coordN * 2] = x; coords[coordN * 2 + 1] = y; coordN++; }
  const bb = b.bounds;
  bounds[n * 4] = bb.minX; bounds[n * 4 + 1] = bb.minY; bounds[n * 4 + 2] = bb.maxX; bounds[n * 4 + 3] = bb.maxY;
  depthArr[n] = b.foundationDepth || 0; if (depthArr[n] > maxDepth) maxDepth = depthArr[n];
  if (bb.minX < minLon) minLon = bb.minX; if (bb.maxX > maxLon) maxLon = bb.maxX;
  if (bb.minY < minLat) minLat = bb.minY; if (bb.maxY > maxLat) maxLat = bb.maxY;
  n++;
  if (n % 200000 === 0) console.log(`  ${n} buildings`);
}
if (n === 0) throw new Error("no buildings parsed - is the input the expected buildings_index JSON?");
ringStart[n] = coordN;
console.log(`parsed ${n} buildings, ${coordN} coords`);

// ---- grid, square in metres: lon step = cellSize / cos(midLat), same formula the game's detector uses ----
const cellSizeLon = cellSize / Math.cos(((minLat + maxLat) / 2) * Math.PI / 180);
const cols = Math.max(1, Math.ceil((maxLon - minLon) / cellSizeLon));
const rows = Math.max(1, Math.ceil((maxLat - minLat) / cellSize));
const cellMap = new Map(); // row * cols + col -> building ids
for (let i = 0; i < n; i++) {
  const c0 = Math.min(cols - 1, Math.floor((bounds[i * 4] - minLon) / cellSizeLon)), c1 = Math.min(cols - 1, Math.floor((bounds[i * 4 + 2] - minLon) / cellSizeLon));
  const r0 = Math.min(rows - 1, Math.floor((bounds[i * 4 + 1] - minLat) / cellSize)), r1 = Math.min(rows - 1, Math.floor((bounds[i * 4 + 3] - minLat) / cellSize));
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) { const k = r * cols + c; let l = cellMap.get(k); if (!l) cellMap.set(k, (l = [])); l.push(i); }
}
const cellKeys = [...cellMap.keys()].sort((a, b) => a - b); // row-major = the game's (row, col) sort
let totalCellRefs = 0; for (const k of cellKeys) totalCellRefs += cellMap.get(k).length;
console.log(`grid ${cols}x${rows}, ${cellKeys.length} non-empty cells, ${totalCellRefs} refs`);

// ---- layout (mirrors the game's computeSectionOffsets, no heights / osm ids) ----
const HEADER = 88, align8 = (v) => (v + 7) & -8;
const off = {}; let o = HEADER;
off.bounds = o; o += n * 32;
off.depths = o; o += n * 4; o = align8(o);
off.ringOffs = o; o += (n + 1) * 4;
off.coordOffs = o; o += (n + 1) * 4; o = align8(o); // totalRings === n (one ring per building)
off.coords = o; o += coordN * 16;
off.rowStarts = o; o += (rows + 1) * 4;
off.cellCols = o; o += cellKeys.length * 4;
off.cellOffs = o; o += (cellKeys.length + 1) * 4;
off.cellIds = o; o += totalCellRefs * 4;
const total = o;

const buf = new ArrayBuffer(total), dv = new DataView(buf);
dv.setUint32(0, 1229079123, true); dv.setUint8(4, 1); dv.setUint8(5, 0); dv.setUint16(6, 0, true);
[n, cols, rows, n, coordN, cellKeys.length, totalCellRefs, 0].forEach((v, i) => dv.setUint32(8 + i * 4, v, true));
[cellSize, maxDepth, minLon, minLat, maxLon, maxLat].forEach((v, i) => dv.setFloat64(40 + i * 8, v, true));
new Float64Array(buf, off.bounds, n * 4).set(bounds.subarray(0, n * 4));
new Float32Array(buf, off.depths, n).set(depthArr.subarray(0, n));
const ringOffs = new Uint32Array(buf, off.ringOffs, n + 1), coordOffs = new Uint32Array(buf, off.coordOffs, n + 1);
for (let i = 0; i <= n; i++) { ringOffs[i] = i; coordOffs[i] = ringStart[i]; }
new Float64Array(buf, off.coords, coordN * 2).set(coords.subarray(0, coordN * 2));
const rowStarts = new Uint32Array(buf, off.rowStarts, rows + 1), cellCols = new Uint32Array(buf, off.cellCols, cellKeys.length);
const cellOffs = new Uint32Array(buf, off.cellOffs, cellKeys.length + 1), cellIds = new Uint32Array(buf, off.cellIds, totalCellRefs);
let ref = 0, row = 0;
for (let i = 0; i < cellKeys.length; i++) {
  const r = Math.floor(cellKeys[i] / cols);
  while (row < r) { row++; rowStarts[row] = i; }
  cellCols[i] = cellKeys[i] - r * cols; cellOffs[i] = ref;
  for (const id of cellMap.get(cellKeys[i])) cellIds[ref++] = id;
}
cellOffs[cellKeys.length] = ref;
while (row < rows) { row++; rowStarts[row] = cellKeys.length; }

fs.writeFileSync(outPath, Buffer.from(buf));

// ---- self-check: re-read the file the way the game does and compare against what was parsed ----
{
  const back = fs.readFileSync(outPath), v = new DataView(back.buffer, back.byteOffset, back.byteLength);
  if (v.getUint32(0, true) !== 1229079123 || v.getUint8(4) !== 1) throw new Error("bad magic/version after write");
  if (back.length !== total) throw new Error(`size ${back.length} != layout ${total}`);
  const bb = new Float64Array(back.buffer, back.byteOffset + off.bounds, n * 4), cc = new Float64Array(back.buffer, back.byteOffset + off.coords, coordN * 2);
  const co = new Uint32Array(back.buffer, back.byteOffset + off.coordOffs, n + 1);
  for (const i of [0, 1, (n / 2) | 0, n - 1]) {
    const len = co[i + 1] - co[i];
    if (len < 3) throw new Error(`building ${i}: ring of ${len} points`);
    for (let k = 0; k < len; k++) { const x = cc[(co[i] + k) * 2], y = cc[(co[i] + k) * 2 + 1]; if (x < bb[i * 4] - 1e-9 || x > bb[i * 4 + 2] + 1e-9 || y < bb[i * 4 + 1] - 1e-9 || y > bb[i * 4 + 3] + 1e-9) throw new Error(`building ${i}: point outside its own bounds`); }
  }
  // every building must be reachable from the cell holding its bounds' min corner
  const rs = new Uint32Array(back.buffer, back.byteOffset + off.rowStarts, rows + 1), cs = new Uint32Array(back.buffer, back.byteOffset + off.cellCols, cellKeys.length);
  const co2 = new Uint32Array(back.buffer, back.byteOffset + off.cellOffs, cellKeys.length + 1), ids = new Uint32Array(back.buffer, back.byteOffset + off.cellIds, totalCellRefs);
  for (const i of [0, (n / 3) | 0, n - 1]) {
    const c = Math.min(cols - 1, Math.floor((bb[i * 4] - minLon) / cellSizeLon)), r = Math.min(rows - 1, Math.floor((bb[i * 4 + 1] - minLat) / cellSize));
    let hit = false;
    for (let j = rs[r]; j < rs[r + 1]; j++) if (cs[j] === c) for (let k = co2[j]; k < co2[j + 1]; k++) if (ids[k] === i) hit = true;
    if (!hit) throw new Error(`building ${i} not found in its own cell (${r},${c})`);
  }
}
console.log({ scope, buildings: n, coords: coordN, cols, rows, nonEmptyCells: cellKeys.length, bytes: total, outPath });
