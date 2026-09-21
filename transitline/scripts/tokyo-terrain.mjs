// Turns the GSI DEM10 tiles in data-raw/terrain/gsi-dem10/14 into slope data for the tokyo pack area.
// One-off tool. Needs: npm i pngjs d3-contour @turf/simplify   (run from a folder that has them installed)
//   REPO=<repo root> node --max-old-space-size=8000 tokyo-terrain.mjs
//
// Outputs into data-raw/terrain/derived/:
//   elev-31m.i16 / slope-31m.u8 + grid.json   — raster grids, ~31 m cells (4x4 of the z14 pixels), see grid.json
//   slope-zones.geojson                        — nested polygons, slope >= 10 / 20 / 30 degrees
//   peaks.json (updated in place)              — each peak gets dem_ele + slope_mean_200m
//   terrain-stats.json                         — area per slope class
import fs from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import { contours } from "d3-contour";
import simplify from "@turf/simplify";

const REPO = process.env.REPO ?? path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1")), "../..");
const RAW = path.join(REPO, "transitline/data-raw/terrain/gsi-dem10/14");
const OUT = path.join(REPO, "transitline/data-raw/terrain/derived");
const Z = 14, CELL = 4, TS = 256;
const THRESHOLDS = [10, 20, 30];
const MIN_ZONE_CELLS = 30; // drop specks smaller than ~30 cells (~29,000 m2)
const M_PER_PX_EQ = 40075016.686 / (TS * 2 ** Z);

// SKIP_GRID=1: reuse elev-31m.i16 / slope-31m.u8 / grid.json from an earlier run (slope then has 1-degree
// resolution instead of float) and only redo the zones / peaks stages.
const SKIP_GRID = process.env.SKIP_GRID === "1";
const t0 = Date.now(), lap = (m) => console.log(`[${Math.round((Date.now() - t0) / 1000)}s] ${m}`);

// ---- tile index ----
const have = new Set(); let xmin = 1e9, xmax = -1, ymin = 1e9, ymax = -1;
let W, H;
if (SKIP_GRID) {
  const g = JSON.parse(fs.readFileSync(path.join(OUT, "grid.json"), "utf8"));
  xmin = g.originTileX; ymin = g.originTileY; W = g.width; H = g.height;
} else {
  for (const xd of fs.readdirSync(RAW)) {
    const x = Number(xd); if (!Number.isInteger(x)) continue;
    for (const f of fs.readdirSync(path.join(RAW, xd))) {
      if (!f.endsWith(".png")) continue; const y = parseInt(f, 10);
      have.add(x * 100000 + y); xmin = Math.min(xmin, x); xmax = Math.max(xmax, x); ymin = Math.min(ymin, y); ymax = Math.max(ymax, y);
    }
  }
  W = (xmax - xmin + 1) * (TS / CELL); H = (ymax - ymin + 1) * (TS / CELL);
}
console.log("tiles", have.size, "x", xmin, xmax, "y", ymin, ymax, "grid", W, "x", H, SKIP_GRID ? "(grids from disk)" : "");

const decode = (buf) => {
  const png = PNG.sync.read(buf), out = new Float32Array(TS * TS);
  for (let i = 0; i < out.length; i++) {
    const v = png.data[i * 4] * 65536 + png.data[i * 4 + 1] * 256 + png.data[i * 4 + 2];
    out[i] = v === 8388608 ? NaN : (v < 8388608 ? v : v - 16777216) * 0.01;
  }
  return out;
};
const cache = new Map();
const tile = (x, y) => {
  const k = x * 100000 + y; if (!have.has(k)) return null;
  let t = cache.get(k);
  if (!t) { t = decode(fs.readFileSync(path.join(RAW, String(x), `${y}.png`))); cache.set(k, t); if (cache.size > 600) cache.delete(cache.keys().next().value); }
  return t;
};

// ---- slope per pixel (Horn), aggregated to CELL x CELL cells ----
const elev = new Int16Array(W * H).fill(-32768), slopeMean = new Float32Array(W * H), slopeU8 = new Uint8Array(W * H).fill(255);
const cellAreaM2Sum = { 10: 0, 20: 0, 30: 0 }; // filled after smoothing
const rowLatCos = new Float64Array(H);
const pad = new Float32Array((TS + 2) * (TS + 2));
if (!SKIP_GRID) for (let ty = ymin; ty <= ymax; ty++) {
  for (let tx = xmin; tx <= xmax; tx++) {
    const c = tile(tx, ty); if (!c) continue;
    const nb = {}; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) nb[`${dx},${dy}`] = dx === 0 && dy === 0 ? c : tile(tx + dx, ty + dy);
    for (let py = -1; py <= TS; py++) for (let px = -1; px <= TS; px++) {
      const dx = px < 0 ? -1 : px >= TS ? 1 : 0, dy = py < 0 ? -1 : py >= TS ? 1 : 0, t = nb[`${dx},${dy}`];
      pad[(py + 1) * (TS + 2) + px + 1] = t ? t[((py + TS) % TS) * TS + ((px + TS) % TS)] : NaN;
    }
    const n = Math.PI - 2 * Math.PI * ((ty + 0.5) / 2 ** Z), lat = Math.atan(Math.sinh(n));
    const m = M_PER_PX_EQ * Math.cos(lat);
    for (let cy = 0; cy < TS / CELL; cy++) for (let cx = 0; cx < TS / CELL; cx++) {
      let sSum = 0, sN = 0, eSum = 0, eN = 0;
      for (let j = 0; j < CELL; j++) for (let i = 0; i < CELL; i++) {
        const px = cx * CELL + i, py = cy * CELL + j, o = (py + 1) * (TS + 2) + px + 1;
        const z5 = pad[o]; if (!Number.isNaN(z5)) { eSum += z5; eN++; }
        const z1 = pad[o - TS - 3], z2 = pad[o - TS - 2], z3 = pad[o - TS - 1], z4 = pad[o - 1], z6 = pad[o + 1], z7 = pad[o + TS + 1], z8 = pad[o + TS + 2], z9 = pad[o + TS + 3];
        const dzdx = ((z3 + 2 * z6 + z9) - (z1 + 2 * z4 + z7)) / (8 * m), dzdy = ((z7 + 2 * z8 + z9) - (z1 + 2 * z2 + z3)) / (8 * m);
        const s = Math.atan(Math.hypot(dzdx, dzdy)) * 180 / Math.PI;
        if (!Number.isNaN(s)) { sSum += s; sN++; }
      }
      const gx = (tx - xmin) * (TS / CELL) + cx, gy = (ty - ymin) * (TS / CELL) + cy, gi = gy * W + gx;
      rowLatCos[gy] = Math.cos(lat);
      if (eN >= (CELL * CELL) / 2 && sN >= (CELL * CELL) / 2) {
        elev[gi] = Math.round(eSum / eN); const s = sSum / sN; slopeMean[gi] = s; slopeU8[gi] = Math.min(90, Math.round(s));
      }
    }
  }
  if ((ty - ymin) % 10 === 0) console.log("  row", ty - ymin + 1, "/", ymax - ymin + 1);
}
fs.mkdirSync(OUT, { recursive: true });
if (SKIP_GRID) {
  const eb = fs.readFileSync(path.join(OUT, "elev-31m.i16")); elev.set(new Int16Array(eb.buffer, eb.byteOffset, eb.length / 2));
  slopeU8.set(fs.readFileSync(path.join(OUT, "slope-31m.u8")));
  for (let i = 0; i < slopeU8.length; i++) slopeMean[i] = slopeU8[i] === 255 ? 0 : slopeU8[i];
  for (let y = 0; y < H; y++) rowLatCos[y] = Math.cos(Math.atan(Math.sinh(Math.PI - 2 * Math.PI * (ymin * TS + y * CELL + CELL / 2) / (TS * 2 ** Z))));
}
if (!SKIP_GRID) fs.writeFileSync(path.join(OUT, "elev-31m.i16"), Buffer.from(elev.buffer));
if (!SKIP_GRID) fs.writeFileSync(path.join(OUT, "slope-31m.u8"), Buffer.from(slopeU8.buffer));
const grid = { note: "row-major, width x height cells. elev-31m.i16: little-endian Int16 metres, -32768 = no data (sea / outside coverage). slope-31m.u8: degrees 0-90, 255 = no data. Cell (i,j) covers z14 web-mercator pixels [i*4,(i+1)*4) x [j*4,(j+1)*4) counted from the top-left of tile (originTileX, originTileY); lon = (originTileX*256 + px)/(256*2^14)*360-180, lat = atan(sinh(pi - 2*pi*(originTileY*256 + py)/(256*2^14))).",
  zoom: Z, cellPixels: CELL, originTileX: xmin, originTileY: ymin, width: W, height: H, source: "GSI DEM10B tiles (dem_png z14), slope = Horn 3x3, mean over each 4x4 pixel cell" };
if (!SKIP_GRID) fs.writeFileSync(path.join(OUT, "grid.json"), JSON.stringify(grid, null, 1));
lap("grids ready");

// ---- smooth (3x3 mean over valid cells) then contour ----
const smooth = new Float32Array(W * H);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  let s = 0, n = 0;
  for (let dy = -1; dy <= 1; dy++) { const yy = y + dy; if (yy < 0 || yy >= H) continue; for (let dx = -1; dx <= 1; dx++) { const xx = x + dx; if (xx < 0 || xx >= W) continue; const i = yy * W + xx; if (slopeU8[i] !== 255) { s += slopeMean[i]; n++; } } }
  smooth[y * W + x] = n ? s / n : 0;
}
const stats = { cellsValid: 0, km2: { valid: 0 } };
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const i = y * W + x; if (slopeU8[i] === 255) continue;
  const px = M_PER_PX_EQ * rowLatCos[y], a = (CELL * px) ** 2 / 1e6; stats.cellsValid++; stats.km2.valid += a;
  for (const t of THRESHOLDS) if (smooth[i] >= t) stats.km2["slope>=" + t] = (stats.km2["slope>=" + t] ?? 0) + a;
}
for (const k of Object.keys(stats.km2)) stats.km2[k] = Math.round(stats.km2[k]);
console.log("area km2", stats.km2);

const toLonLat = ([gx, gy]) => {
  const px = xmin * TS + gx * CELL, py = ymin * TS + gy * CELL, N = TS * 2 ** Z;
  return [+((px / N) * 360 - 180).toFixed(5), +(Math.atan(Math.sinh(Math.PI - 2 * Math.PI * py / N)) * 180 / Math.PI).toFixed(5)];
};
const ringCells = (ring) => { let a = 0; for (let i = 0; i < ring.length - 1; i++) a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1]; return Math.abs(a) / 2; };
const feats = [];
// The zones are contoured on a half-resolution (~62 m) grid: a full-resolution contour over ~28,000 km2 of
// mountains produces polygons with millions of vertices and never finished. The 31 m grids stay on disk as-is.
const DS = 2, CW = W >> 1, CH = H >> 1, coarse = new Float32Array(CW * CH);
for (let y = 0; y < CH; y++) for (let x = 0; x < CW; x++) coarse[y * CW + x] = (smooth[2 * y * W + 2 * x] + smooth[2 * y * W + 2 * x + 1] + smooth[(2 * y + 1) * W + 2 * x] + smooth[(2 * y + 1) * W + 2 * x + 1]) / 4;
lap("downsampled to " + CW + " x " + CH);
const MIN_ZONE_COARSE = Math.ceil(MIN_ZONE_CELLS / (DS * DS));
for (const t of THRESHOLDS) {
  const c = contours().size([CW, CH]).contour(coarse, t);
  lap(`contour >= ${t}: ${c.coordinates.length} polygons`);
  let kept = 0;
  for (const poly of c.coordinates) {
    if (ringCells(poly[0]) < MIN_ZONE_COARSE) continue;
    const rings = [poly[0], ...poly.slice(1).filter((r) => ringCells(r) >= MIN_ZONE_COARSE)].map((r) => r.map(([x, y]) => toLonLat([x * DS, y * DS])));
    feats.push(simplify({ type: "Feature", properties: { min_deg: t }, geometry: { type: "Polygon", coordinates: rings } }, { tolerance: 0.0002, highQuality: false }));
    kept++;
  }
  lap(`slope >= ${t}: kept ${kept} polygons`);
}
fs.writeFileSync(path.join(OUT, "slope-zones.geojson"), JSON.stringify({ type: "FeatureCollection", features: feats }));
console.log("slope-zones.geojson bytes", fs.statSync(path.join(OUT, "slope-zones.geojson")).size);

// ---- peaks: DEM elevation + surrounding slope ----
const peaksPath = path.join(OUT, "peaks.json");
if (fs.existsSync(peaksPath)) {
  const peaks = JSON.parse(fs.readFileSync(peaksPath, "utf8")), N = TS * 2 ** Z;
  for (const p of peaks) {
    const px = (p.lon + 180) / 360 * N, r = p.lat * Math.PI / 180, py = (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * N;
    const gx = Math.floor((px - xmin * TS) / CELL), gy = Math.floor((py - ymin * TS) / CELL);
    p.dem_ele = null; p.slope_mean_200m = null;
    if (gx < 0 || gy < 0 || gx >= W || gy >= H || elev[gy * W + gx] === -32768) continue;
    p.dem_ele = elev[gy * W + gx];
    let s = 0, n = 0;
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) { const x = gx + dx, y = gy + dy; if (x < 0 || y < 0 || x >= W || y >= H) continue; const i = y * W + x; if (slopeU8[i] !== 255) { s += slopeMean[i]; n++; } }
    p.slope_mean_200m = n ? +(s / n).toFixed(1) : null;
  }
  fs.writeFileSync(peaksPath, JSON.stringify(peaks));
  const both = peaks.filter((p) => p.ele != null && p.dem_ele != null), diffs = both.map((p) => Math.abs(p.ele - p.dem_ele)).sort((a, b) => a - b);
  stats.peaks = { total: peaks.length, withDem: peaks.filter((p) => p.dem_ele != null).length, medianAbsDiffM: diffs[Math.floor(diffs.length / 2)] };
  console.log("peaks", stats.peaks);
}
fs.writeFileSync(path.join(OUT, "terrain-stats.json"), JSON.stringify(stats, null, 1));
console.log("DONE");
