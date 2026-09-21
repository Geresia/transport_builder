// Add `levels_underground` to packs/tokyo/obstacles.json buildings from the Tokyo Land Use Survey R3
// (23 wards; building shapefile, field BV_4 = basement floors, BV_3 = above-ground floors; CC BY 4.0).
// OSM building:levels:underground is ~0.04% of Kanto buildings, so it cannot be used.
// Usage: node scripts/tokyo-underground-levels.mjs <R03建物現況.shp> [--dry]
// Matching: each survey building's centroid is tested against OSM obstacle polygons (projected to
// JGD2011 Japan Zone IX, EPSG:6677, the shapefile's CRS); per obstacle the largest survey footprint wins.
import fs from "fs";
import { readPackJson } from "./pack-json.mjs";
import { fileURLToPath } from "url";
import { readDbf } from "./tokyo-lu-dbf.mjs";
const T = fileURLToPath(new URL("../packs/tokyo/", import.meta.url));
const shpPath = process.argv[2], dry = process.argv.includes("--dry");
if (!shpPath) throw new Error("pass path to R03建物現況.shp");

// --- Transverse Mercator forward, GRS80, Zone IX (GSI formulae) ---
const A = 6378137, F = 298.257222101, m0 = 0.9999, lat0 = 36 * Math.PI / 180, lon0 = 139.8333333333333 * Math.PI / 180;
const n = 1 / (2 * F - 1), n2 = n * n, n3 = n2 * n, n4 = n3 * n, n5 = n4 * n;
const Abar = (m0 * A / (1 + n)) * (1 + n2 / 4 + n4 / 64);
const al = [n / 2 - 2 * n2 / 3 + 5 * n3 / 16 + 41 * n4 / 180, 13 * n2 / 48 - 3 * n3 / 5 + 557 * n4 / 1440, 61 * n3 / 240 - 103 * n4 / 140, 49561 * n4 / 161280];
const Ac = [1 + n2 / 4 + n4 / 64, -1.5 * (n - n3 / 8 - n5 / 64), 15 / 16 * (n2 - n4 / 4), -35 / 48 * (n3 - 5 * n5 / 16), 315 / 512 * n4];
const S0 = (m0 * A / (1 + n)) * (Ac[0] * lat0 + Ac.slice(1).reduce((s, a, i) => s + a * Math.sin(2 * (i + 1) * lat0), 0));
const k = 2 * Math.sqrt(n) / (1 + n);
function project(lonDeg, latDeg) {
  const p = latDeg * Math.PI / 180, dl = lonDeg * Math.PI / 180 - lon0;
  const t = Math.sinh(Math.atanh(Math.sin(p)) - k * Math.atanh(k * Math.sin(p))), tc = Math.sqrt(1 + t * t);
  const xi = Math.atan2(t, Math.cos(dl)), eta = Math.atanh(Math.sin(dl) / tc);
  let x = xi, y = eta;
  for (let j = 1; j <= 4; j++) { x += al[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta); y += al[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta); }
  return [Abar * y, Abar * x - S0]; // [east, north] = shapefile [X, Y]
}

// --- obstacles + grid index (50 m cells) ---
const ob = readPackJson(T + "obstacles.json");
const CELL = 50, grid = new Map();
const polys = ob.obstacles.map((b, id) => {
  const pts = b.polygon.map(([lo, la]) => project(lo, la));
  let x0 = 1e18, y0 = 1e18, x1 = -1e18, y1 = -1e18;
  for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++) for (let cy = Math.floor(y0 / CELL); cy <= Math.floor(y1 / CELL); cy++) {
    const key = cx * 100003 + cy; (grid.get(key) ?? grid.set(key, []).get(key)).push(id);
  }
  return { pts, x0, y0, x1, y1 };
});
const inPoly = (x, y, pts) => { let c = false; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) { const [xi, yi] = pts[i], [xj, yj] = pts[j]; if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c; } return c; };
let gx0 = 1e18, gy0 = 1e18, gx1 = -1e18, gy1 = -1e18;
for (const p of polys) { gx0 = Math.min(gx0, p.x0); gy0 = Math.min(gy0, p.y0); gx1 = Math.max(gx1, p.x1); gy1 = Math.max(gy1, p.y1); }
console.log("obstacle XY bbox", [gx0, gy0, gx1, gy1].map(Math.round));

// --- stream survey shp records in lockstep with dbf rows ---
const shp = fs.readFileSync(shpPath), dbfRows = readDbf(shpPath.replace(/\.shp$/i, ".dbf"));
const best = new Map(); // obstacle id -> {area, bv3, bv4}
let off = 100, rec = 0, seen = 0;
while (off < shp.length) {
  const len = shp.readInt32BE(off + 4) * 2, s = off + 8, type = shp.readInt32LE(s);
  const row = dbfRows.next().value; rec++;
  off = s + len;
  if (type !== 5 && type !== 15) continue;
  const bx0 = shp.readDoubleLE(s + 4), by0 = shp.readDoubleLE(s + 12), bx1 = shp.readDoubleLE(s + 20), by1 = shp.readDoubleLE(s + 28);
  if (bx1 < gx0 || bx0 > gx1 || by1 < gy0 || by0 > gy1 || !(row.BV_3 > 0)) continue;
  seen++;
  const nParts = shp.readInt32LE(s + 36), nPts = shp.readInt32LE(s + 40);
  const p0 = s + 44 + 4 * nParts, first = shp.readInt32LE(s + 44), end = nParts > 1 ? shp.readInt32LE(s + 48) : nPts;
  let cx = 0, cy = 0; const m = end - first - 1; // centroid of outer ring vertices (closed ring repeats first point)
  for (let i = first; i < first + m; i++) { cx += shp.readDoubleLE(p0 + 16 * i); cy += shp.readDoubleLE(p0 + 16 * i + 8); }
  cx /= m; cy /= m;
  for (const id of grid.get(Math.floor(cx / CELL) * 100003 + Math.floor(cy / CELL)) ?? []) {
    const p = polys[id]; if (cx < p.x0 || cx > p.x1 || cy < p.y0 || cy > p.y1 || !inPoly(cx, cy, p.pts)) continue;
    const cur = best.get(id); if (!cur || row.AREA > cur.area) best.set(id, { area: row.AREA, bv3: row.BV_3, bv4: row.BV_4 });
  }
}
// --- apply ---
let matched = 0, withBasement = 0, lvAgree = 0, lvBoth = 0;
ob.obstacles.forEach((b, id) => {
  const m = best.get(id);
  if (!m) { b.levels_underground = null; return; }
  matched++; b.levels_underground = m.bv4; if (m.bv4 > 0) withBasement++;
  if (b.levels != null) { lvBoth++; if (Math.abs(b.levels - m.bv3) <= 1) lvAgree++; }
});
console.log({ surveyInBbox: seen, obstacles: ob.obstacles.length, matched, matchRate: +(matched / ob.obstacles.length).toFixed(3), withBasement, osmLevelsWithin1OfSurvey: lvBoth ? +(lvAgree / lvBoth).toFixed(3) : null, lvBoth });
if (!dry) { ob.undergroundNote = "levels_underground: basement floors from Tokyo Land Use Survey R3 (BV_4) matched by footprint centroid; null = no survey building matched; 0 may mean 'not recorded' for low-rise buildings."; fs.writeFileSync(T + "obstacles.json", JSON.stringify(ob)); }
