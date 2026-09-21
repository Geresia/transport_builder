// Downloads GSI (国土地理院) DEM10 PNG tiles for the pack bbox: a coarse z11 scan of the whole bbox to find
// hilly ground, then native-resolution z14 tiles (~10 m mesh) under every z11 tile whose relief is >= RELIEF_M.
// Resumable (skips files that exist). Output: data-raw/terrain/gsi-dem10/{z}/{x}/{y}.png + coarse-scan.json
import fs from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";

const OUT = process.argv[2];
const BBOX = [138.18086, 34.90298, 140.86554, 37.1533];
const RELIEF_M = 30;
const BASE = "https://cyberjapandata.gsi.go.jp/xyz/dem_png";
const lon2x = (lon, z) => Math.floor((lon + 180) / 360 * 2 ** z);
const lat2y = (lat, z) => { const r = lat * Math.PI / 180; return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z); };
export const decode = (buf) => {
  const png = PNG.sync.read(buf); const out = new Float32Array(png.width * png.height);
  for (let i = 0; i < out.length; i++) {
    const x = png.data[i * 4] * 65536 + png.data[i * 4 + 1] * 256 + png.data[i * 4 + 2];
    out[i] = x === 8388608 ? NaN : (x < 8388608 ? x : x - 16777216) * 0.01;
  }
  return out;
};
async function get(z, x, y) {
  const f = path.join(OUT, String(z), String(x), `${y}.png`);
  if (fs.existsSync(f)) return fs.readFileSync(f);
  for (let a = 0; a < 4; a++) {
    try {
      const r = await fetch(`${BASE}/${z}/${x}/${y}.png`);
      if (r.status === 404) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f + ".404", ""); return null; }
      if (!r.ok) throw new Error(r.status);
      const b = Buffer.from(await r.arrayBuffer()); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, b); return b;
    } catch { await new Promise((s) => setTimeout(s, 500 * (a + 1))); }
  }
  throw new Error(`failed ${z}/${x}/${y}`);
}
async function pool(items, n, fn) { let i = 0, done = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const it = items[i++]; await fn(it); if (++done % 500 === 0) console.log("  ", done, "/", items.length); } })); }

const notFound = (z, x, y) => fs.existsSync(path.join(OUT, String(z), String(x), `${y}.png.404`));
// ---- coarse scan ----
const [x0, x1, y0, y1] = [lon2x(BBOX[0], 11), lon2x(BBOX[2], 11), lat2y(BBOX[3], 11), lat2y(BBOX[1], 11)];
const coarse = []; for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) coarse.push([x, y]);
console.log("z11 tiles", coarse.length);
const scan = {};
await pool(coarse, 8, async ([x, y]) => {
  const b = await get(11, x, y); if (!b) return;
  const d = decode(b); let mn = Infinity, mx = -Infinity, n = 0;
  for (const v of d) if (!Number.isNaN(v)) { n++; if (v < mn) mn = v; if (v > mx) mx = v; }
  if (n) scan[`${x}/${y}`] = { min: Math.round(mn), max: Math.round(mx), valid: +(n / d.length).toFixed(2) };
});
fs.writeFileSync(path.join(OUT, "coarse-scan.json"), JSON.stringify(scan));
const hilly = Object.entries(scan).filter(([, s]) => s.max - s.min >= RELIEF_M).map(([k]) => k.split("/").map(Number));
console.log("z11 tiles with data", Object.keys(scan).length, "hilly (relief >=", RELIEF_M, "m):", hilly.length);
// ---- native z14 under hilly z11 tiles ----
const fine = []; for (const [cx, cy] of hilly) for (let dx = 0; dx < 8; dx++) for (let dy = 0; dy < 8; dy++) fine.push([cx * 8 + dx, cy * 8 + dy]);
const todo = fine.filter(([x, y]) => !fs.existsSync(path.join(OUT, "14", String(x), `${y}.png`)) && !notFound(14, x, y));
console.log("z14 tiles", fine.length, "to download", todo.length);
await pool(todo, 10, ([x, y]) => get(14, x, y));
console.log("DONE");
