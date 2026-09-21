// Extract per-building attributes from PLATEAU 3D Tiles (b3dm batch tables) into compact JSON.
// PLATEAU building tiles carry lon/lat centroids (_x/_y) plus survey attributes from the city's
// 都市計画基礎調査 (建物利用現況), so the glTF geometry never has to be decoded.
// Usage: node scripts/plateau-buildings.mjs <dir-with-b3dm> <out.json> [--stats]
// Fields per building: [lon, lat, 用途, 地上階数, 建築面積 m2, 延床面積 m2, 調査年, 建物利用現況_小分類, 構造, 図上面積 m2 (from geometry), 計測高さ m, 建物ID, part footprint m2 from mesh (roof+floor)/2]
// NOTE: 建物ID-level attributes (建築面積, 延床面積, 図上面積, 用途) repeat on every 枝番 part of a building.
import fs from "fs";
import path from "path";
import { meshHorizontalArea } from "./plateau-footprint.mjs";

const [dir, out] = process.argv.slice(2);
if (!dir || !out) throw new Error("usage: plateau-buildings.mjs <dir> <out.json>");

function* walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (p.endsWith(".b3dm")) yield p;
  }
}

const seen = new Set(), rows = [];
let tiles = 0, dup = 0;
for (const f of walk(dir)) {
  tiles++;
  const b = fs.readFileSync(f);
  const ftJ = b.readUInt32LE(12), ftB = b.readUInt32LE(16), btJ = b.readUInt32LE(20);
  const start = 28 + ftJ + ftB;
  const bt = JSON.parse(b.subarray(start, start + btJ).toString("utf8"));
  const n = JSON.parse(b.subarray(28, 28 + ftJ).toString("utf8")).BATCH_LENGTH;
  const bin = start + btJ;
  const mesh = meshHorizontalArea(b, n);
  const num = (k, i) => {
    const m = bt[k]; if (!m || Array.isArray(m)) return m?.[i] ?? null;
    return m.componentType === "DOUBLE" ? b.readDoubleLE(bin + m.byteOffset + 8 * i) : null;
  };
  for (let i = 0; i < n; i++) {
    const id = `${bt["建物ID"]?.[i]}-${bt["建物ID_枝番"]?.[i]}`;
    if (seen.has(id)) { dup++; continue; }
    seen.add(id);
    rows.push([
      +num("_x", i).toFixed(6), +num("_y", i).toFixed(6), bt["用途"]?.[i] ?? null, bt["地上階数"]?.[i] ?? null,
      bt["建物利用現況_建築面積"]?.[i] ?? null, bt["建物利用現況_延床面積"]?.[i] ?? null, bt["建物利用現況_調査年"]?.[i] ?? null,
      bt["建物利用現況_小分類"]?.[i] ?? null, bt["建物構造_自治体独自分類"]?.[i] ?? null,
      bt["建物利用現況_図上面積"]?.[i] ?? null, (() => { const h = num("計測高さ", i); return h == null ? null : +h.toFixed(1); })(),
      bt["建物ID"]?.[i] ?? null, +(mesh[i] / 2).toFixed(1),
    ]);
  }
}
fs.writeFileSync(out, JSON.stringify(rows));

const tally = (i) => { const c = {}; for (const r of rows) c[r[i]] = (c[r[i]] ?? 0) + 1; return Object.entries(c).sort((a, b) => b[1] - a[1]); };
const nn = (i) => rows.filter((r) => r[i] != null).length;
console.log({ tiles, buildings: rows.length, duplicatesSkipped: dup, withStoreys: nn(3), withFloorArea: nn(5), withUse: nn(2) });
console.log("years", tally(6).slice(0, 6));
console.log("用途", tally(2).slice(0, 20));
