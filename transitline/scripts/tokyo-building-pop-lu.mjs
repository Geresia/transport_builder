// Per-building residents for Tokyo's 23 wards, weighted by REAL building use + floors from the Tokyo Metropolitan
// Government Land Use Survey R3 (2021; CC BY 4.0), instead of the OSM-tag-only guess in tokyo-building-pop.mjs.
// Usage: node --max-old-space-size=12000 scripts/tokyo-building-pop-lu.mjs <tokyo23-buildings.geojson> <R03建物現況 dir or .shp> <out.geojson> [report.json]
// Model (still MODELED, not measured):
//  1. Fit residents per m2 of floor area for each survey use class by non-negative weighted least squares at chome level:
//       chome residents ~ sum_k coef_k * (sum of footprint x floors of survey buildings of class k in the chome)
//     (survey buildings only, joined to subward.json by the 11-digit chome code).
//  2. Each OSM building takes the use class + floors of the survey building that contains its centroid (else the nearest
//     within 12 m); weight = OSM footprint x survey floors x coef[class]. Unmatched buildings: OSM levels x coef[detached house],
//     0 for non-residential OSM tags.
//  3. A chome's real residents are split over its buildings by weight (so chome totals are exact).
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { readDbf } from "./tokyo-lu-dbf.mjs";
const T = fileURLToPath(new URL("../packs/tokyo/", import.meta.url));
const [src, luArg, out, reportPath] = process.argv.slice(2);
if (!src || !luArg || !out) throw new Error("usage: <buildings.geojson> <lu dir|.shp> <out.geojson> [report.json]");
const shpPath = luArg.endsWith(".shp") ? luArg : path.join(luArg, "R03建物現況.shp");
const dbfPath = shpPath.replace(/\.shp$/, ".dbf");

const ZERO = new Set(("commercial retail office public hotel university construction school warehouse hut shrine service college " +
  "train_station parking government hospital industrial toilets temple shed bridge kindergarten guardhouse transportation " +
  "sports_hall police no kiosk gate garage fire_station concert_hall church roof").split(" "));
const USE = [111, 112, 113, 114, 121, 122, 123, 124, 125, 131, 132, 141, 142, 143, 150];

// ---- JGD2011 / Japan plane rectangular zone IX (Transverse Mercator, GRS80) forward projection
const A = 6378137, F = 1 / 298.257222101, E2 = F * (2 - F), N = F / (2 - F);
const LON0 = 139 + 50 / 60, LAT0 = 36, K0 = 0.9999;
const a0 = 1 + N * N / 4 + N ** 4 / 64, a1 = -1.5 * (N - N ** 3 / 8), a2 = 0.9375 * (N * N - N ** 4 / 4), a3 = -35 / 48 * N ** 3, a4 = 315 / 512 * N ** 4;
const sArc = (p) => A / (1 + N) * (a0 * p + a1 * Math.sin(2 * p) + a2 * Math.sin(4 * p) + a3 * Math.sin(6 * p) + a4 * Math.sin(8 * p));
const S0 = sArc(LAT0 * Math.PI / 180);
function toPlane(lon, lat) {
  const p = lat * Math.PI / 180, dl = (lon - LON0) * Math.PI / 180;
  const sp = Math.sin(p), cp = Math.cos(p), t = Math.tan(p), eta2 = E2 / (1 - E2) * cp * cp;
  const nu = A / Math.sqrt(1 - E2 * sp * sp);
  const x = K0 * (sArc(p) - S0 + nu * sp * cp * dl * dl / 2 * (1 + dl * dl * cp * cp / 12 * (5 - t * t + 9 * eta2 + 4 * eta2 * eta2)));
  const y = K0 * nu * cp * dl * (1 + dl * dl * cp * cp / 6 * (1 - t * t + eta2) + dl ** 4 * cp ** 4 / 120 * (5 - 18 * t * t + t ** 4));
  return [y, x]; // [easting, northing] like the shapefile
}

// ---- survey: shp polygons + dbf attributes
console.log("reading survey ...");
const shp = fs.readFileSync(shpPath);
const rd = (f) => JSON.parse(fs.readFileSync(T + f, "utf8").replace(/^﻿/, ""));
const sw = rd("subward.json");
// The survey has its own town numbering, so join to subward.json by ward (first 5 digits) + chome name; names that are
// ambiguous within a ward are skipped.
const resByCode = new Map(), dupKeys = new Set();
for (const w of Object.values(sw.wards)) for (const a of w.areas) {
  const k = String(a.code).slice(0, 5) + "|" + a.name_ja;
  if (resByCode.has(k)) dupKeys.add(k); else resByCode.set(k, a.residents);
}
for (const k of dupKeys) resByCode.delete(k);

const nSurvey = 1808305; // upper bound; trimmed below
const bb = new Float64Array(nSurvey * 4);
const ptOff = new Uint32Array(nSurvey + 1);
const partOff = new Uint32Array(nSurvey + 1);
const pts = [], parts = []; // flat: x,y ... ; part start indexes (global point idx)
const cls = new Uint16Array(nSurvey), flr = new Uint8Array(nSurvey);
const codes = new Array(nSurvey);
let ns = 0, ptCount = 0;
{
  let pos = 100;
  const dbf = readDbf(dbfPath);
  for (const r of dbf) {
    const len = shp.readInt32BE(pos + 4) * 2;
    const st = shp.readInt32LE(pos + 8);
    if (st === 5) {
      const base = pos + 8;
      bb[ns * 4] = shp.readDoubleLE(base + 4); bb[ns * 4 + 1] = shp.readDoubleLE(base + 12);
      bb[ns * 4 + 2] = shp.readDoubleLE(base + 20); bb[ns * 4 + 3] = shp.readDoubleLE(base + 28);
      const np = shp.readInt32LE(base + 36), npt = shp.readInt32LE(base + 40);
      partOff[ns] = parts.length;
      for (let k = 0; k < np; k++) parts.push(ptCount + shp.readInt32LE(base + 44 + 4 * k));
      const po = base + 44 + 4 * np;
      for (let k = 0; k < npt; k++) pts.push(shp.readDoubleLE(po + 16 * k), shp.readDoubleLE(po + 16 * k + 8));
      ptOff[ns] = ptCount; ptCount += npt;
      cls[ns] = r.BV_6; flr[ns] = r.BV_3 > 0 ? Math.min(255, r.BV_3) : 1;
      codes[ns] = String(r.CODE5).slice(0, 5) + "|" + r.NAME2;
      // stash footprint area in bb? keep separately
      ns++;
    } else { /* null shape: skip but keep dbf alignment */ }
    pos += 8 + len;
  }
}
ptOff[ns] = ptCount; partOff[ns] = parts.length;
const P = Float64Array.from(pts); pts.length = 0;
console.log("survey buildings", ns, "points", ptCount);

// ---- chome fit: residents ~ sum coef_k * floor_area_k
const agg = new Map(); // code -> Float64Array(USE.length)
const UI = new Map(USE.map((u, i) => [u, i]));
const areaOf = (i) => { // polygon footprint from shp (outer ring shoelace, m2 in plane coords)
  let s = 0; const a = ptOff[i], b = ptOff[i + 1], p0 = partOff[i], p1 = partOff[i + 1];
  for (let pi = p0; pi < p1; pi++) {
    const st = parts[pi], en = pi + 1 < p1 ? parts[pi + 1] : ptOff[i] + (b - a);
    let r = 0; for (let k = st; k < en - 1; k++) r += P[2 * k] * P[2 * (k + 1) + 1] - P[2 * (k + 1)] * P[2 * k + 1];
    s += pi === p0 ? Math.abs(r) / 2 : -Math.abs(r) / 2; // first ring outer, others holes
  }
  return s;
};
const sArea = new Float32Array(ns);
for (let i = 0; i < ns; i++) {
  sArea[i] = areaOf(i);
  const u = UI.get(cls[i]); if (u === undefined) continue;
  let v = agg.get(codes[i]); if (!v) agg.set(codes[i], v = new Float64Array(USE.length));
  v[u] += sArea[i] * flr[i];
}
const rows = [];
for (const [code, v] of agg) { const y = resByCode.get(code); if (y !== undefined) rows.push({ code, v, y }); }
console.log("chomes in fit", rows.length, "of", resByCode.size);
const K = USE.length, wts = rows.map((r) => 1 / (r.y + 200));
const M = Array.from({ length: K }, () => new Float64Array(K)), bvec = new Float64Array(K);
rows.forEach((r, n) => { const w = wts[n]; for (let i = 0; i < K; i++) { bvec[i] += w * r.v[i] * r.y; for (let j = 0; j < K; j++) M[i][j] += w * r.v[i] * r.v[j]; } });
const coef = new Float64Array(K);
for (let it = 0; it < 20000; it++) for (let i = 0; i < K; i++) {
  if (M[i][i] === 0) continue; let s = bvec[i]; for (let j = 0; j < K; j++) if (j !== i) s -= M[i][j] * coef[j];
  coef[i] = Math.max(0, s / M[i][i]);
}
let ssRes = 0, ssTot = 0, ym = rows.reduce((t, r) => t + r.y, 0) / rows.length;
for (const r of rows) { let p = 0; for (let i = 0; i < K; i++) p += coef[i] * r.v[i]; ssRes += (r.y - p) ** 2; ssTot += (r.y - ym) ** 2; }
const r2 = 1 - ssRes / ssTot;
const coefObj = Object.fromEntries(USE.map((u, i) => [u, +(coef[i] * 1000).toFixed(3)])); // residents per 1000 m2 floor area
console.log("coef (residents per 1000 m2 floor):", coefObj, "R2", r2.toFixed(3));
const cDetached = coef[UI.get(131)] || 0.01;

// ---- survey grid index
const CELL = 100, grid = new Map();
const gk = (gx, gy) => gx * 200003 + gy;
for (let i = 0; i < ns; i++) {
  for (let gx = Math.floor(bb[i * 4] / CELL); gx <= Math.floor(bb[i * 4 + 2] / CELL); gx++)
    for (let gy = Math.floor(bb[i * 4 + 1] / CELL); gy <= Math.floor(bb[i * 4 + 3] / CELL); gy++) {
      const k = gk(gx, gy); let l = grid.get(k); if (!l) grid.set(k, l = []); l.push(i);
    }
}
function inSurvey(i, x, y) {
  if (x < bb[i * 4] || x > bb[i * 4 + 2] || y < bb[i * 4 + 1] || y > bb[i * 4 + 3]) return false;
  let ins = false; const p0 = partOff[i], p1 = partOff[i + 1], tot = ptOff[i + 1] - ptOff[i];
  for (let pi = p0; pi < p1; pi++) {
    const st = parts[pi], en = pi + 1 < p1 ? parts[pi + 1] : ptOff[i] + tot;
    for (let a = st, b = en - 1; a < en; b = a++) {
      const xa = P[2 * a], ya = P[2 * a + 1], xb = P[2 * b], yb = P[2 * b + 1];
      if ((ya > y) !== (yb > y) && x < ((xb - xa) * (y - ya)) / (yb - ya) + xa) ins = !ins;
    }
  }
  return ins;
}
function findSurvey(x, y) {
  const l = grid.get(gk(Math.floor(x / CELL), Math.floor(y / CELL)));
  if (!l) return -1;
  for (const i of l) if (inSurvey(i, x, y)) return i;
  let best = -1, bd = 12 * 12; // nearest survey building centre within 12 m
  for (const i of l) { const cx = (bb[i * 4] + bb[i * 4 + 2]) / 2, cy = (bb[i * 4 + 1] + bb[i * 4 + 3]) / 2; const d = (cx - x) ** 2 + (cy - y) ** 2; if (d < bd) { bd = d; best = i; } }
  return best;
}

// ---- chome polygons (for OSM building -> chome)
const CELLG = 0.005, cg = new Map(), chomes = [];
for (const w of Object.values(sw.wards)) for (const a of w.areas) {
  if (!a.polygons || !a.polygons.length) continue;
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const poly of a.polygons) for (const [x, y] of poly[0]) { b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], y); b[2] = Math.max(b[2], x); b[3] = Math.max(b[3], y); }
  const id = chomes.push({ code: String(a.code), name: a.name_ja, residents: a.residents, polys: a.polygons, bb: b, n: 0, wsum: 0, asum: 0 }) - 1;
  for (let gx = Math.floor(b[0] / CELLG); gx <= Math.floor(b[2] / CELLG); gx++) for (let gy = Math.floor(b[1] / CELLG); gy <= Math.floor(b[3] / CELLG); gy++) {
    const k = gx * 100000 + gy; let l = cg.get(k); if (!l) cg.set(k, l = []); l.push(id);
  }
}
function inRing(ring, x, y) { let ins = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const [xi, yi] = ring[i], [xj, yj] = ring[j]; if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) ins = !ins; } return ins; }
function findChome(x, y) {
  for (const id of cg.get(Math.floor(x / CELLG) * 100000 + Math.floor(y / CELLG)) ?? []) {
    const c = chomes[id]; if (x < c.bb[0] || x > c.bb[2] || y < c.bb[1] || y > c.bb[3]) continue;
    for (const poly of c.polys) { if (!inRing(poly[0], x, y)) continue; let hole = false; for (let h = 1; h < poly.length; h++) if (inRing(poly[h], x, y)) { hole = true; break; } if (!hole) return id; }
  }
  return -1;
}

// ---- OSM buildings
console.log("reading OSM buildings ...");
const fc = JSON.parse(fs.readFileSync(src, "utf8")), feats = fc.features;
const KLAT = 111320, KLON = 111320 * Math.cos(35.68 * Math.PI / 180);
let outside = 0, matched = 0;
const B = new Array(feats.length);
for (let i = 0; i < feats.length; i++) {
  const f = feats[i], ring = f.geometry.coordinates[0];
  let a2 = 0, cx = 0, cy = 0;
  for (let k = 0; k < ring.length - 1; k++) { const [x1, y1] = ring[k], [x2, y2] = ring[k + 1]; a2 += x1 * KLON * y2 * KLAT - x2 * KLON * y1 * KLAT; cx += x1; cy += y1; }
  cx /= ring.length - 1; cy /= ring.length - 1;
  const area = Math.abs(a2) / 2, lv = Number(f.properties.levels), osmLevels = lv > 0 ? lv : 1;
  const ci = findChome(cx, cy);
  const [px, py] = toPlane(cx, cy);
  const si = findSurvey(px, py);
  let w, fb;
  if (si >= 0) {
    matched++;
    const u = UI.get(cls[si]); const c = u === undefined ? 0 : coef[u];
    w = area * flr[si] * c; fb = area * flr[si] * cDetached; f.properties.lu = cls[si];
  } else {
    w = area * osmLevels * (ZERO.has(f.properties.sourceKind) ? 0 : cDetached); fb = area * osmLevels * cDetached;
  }
  if (ci < 0) outside++; else { const c = chomes[ci]; c.n++; c.wsum += w; c.asum += fb; }
  B[i] = { ci, w, fb };
}

// ---- allocate
let allocated = 0, lost = 0, fallback = 0; const noBuilding = [];
for (const c of chomes) {
  if (c.residents > 0 && c.n === 0) { lost += c.residents; noBuilding.push(`${c.code} ${c.name} (${c.residents})`); }
  if (c.residents > 0 && c.n > 0 && c.wsum === 0) fallback++;
}
for (let i = 0; i < feats.length; i++) {
  const b = B[i]; let pop = 0;
  if (b.ci >= 0) { const c = chomes[b.ci]; if (c.wsum > 0) pop = c.residents * b.w / c.wsum; else if (c.asum > 0) pop = c.residents * b.fb / c.asum; }
  allocated += pop; feats[i].properties.pop = Math.round(pop * 10) / 10;
}
fs.writeFileSync(out, JSON.stringify(fc));
const rep = { surveyBuildings: ns, chomesInFit: rows.length, r2: +r2.toFixed(3), residentsPer1000m2Floor: coefObj, osmBuildings: feats.length,
  osmMatchedToSurvey: matched, outsideAnyChome: outside, totalResidents: chomes.reduce((t, c) => t + c.residents, 0), allocated: Math.round(allocated),
  unallocatedNoBuilding: lost, chomesWithNoBuilding: noBuilding.length, chomesFallbackAllBuildings: fallback };
if (reportPath) fs.writeFileSync(reportPath, JSON.stringify(rep, null, 1));
fs.writeFileSync(T + "pop-coefficients.json", JSON.stringify({
  formatVersion: 1, modeled: true,
  method: "Non-negative weighted least squares (weight 1/(residents+200)), chome residents ~ sum over survey use class of (footprint x above-ground floors), no intercept.",
  sources: ["Tokyo Metropolitan Government Urban Development Bureau, Land Use Survey R3 (2021), 23 wards, building data (CC BY 4.0)", "2020 census small-area residents, e-Stat (subward.json)"],
  chomesUsed: rows.length, r2: +r2.toFixed(3), residentsPer1000m2Floor: coefObj,
  useClasses: { 111: "官公庁", 112: "教育文化", 113: "厚生医療", 114: "供給処理", 121: "事務所", 122: "商業", 123: "住商併用", 124: "宿泊遊興", 125: "スポーツ興行", 131: "独立住宅", 132: "集合住宅", 141: "専用工場", 142: "住居併用工場", 143: "倉庫運輸", 150: "その他" },
}, null, 1));
console.log(rep);
