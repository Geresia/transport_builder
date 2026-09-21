// Tokyo 23 wards building layer built from the OFFICIAL land use survey (東京都 令和3年度 区部土地利用現況調査, R03 建物現況, CC BY 4.0)
// instead of OpenStreetMap: every building polygon carries its real use class and floors, and gets MODELED per-building residents (pop),
// workers (jobs) and employed residents (emp) whose chome totals equal the census exactly.
//
// Usage: node --max-old-space-size=12000 scripts/tokyo-survey-buildings.mjs <R03建物現況 dir or .shp> <out.ndjson> [report.json]
// Output: newline-delimited GeoJSON (one Feature per line, WGS84) for Planetiler.
//
// Model (same family as tokyo-building-pop-lu.mjs / -jobs-lu / -emp-lu, minus the OSM matching step):
//  1. For each of three targets fit units-per-m2-of-floor-area by survey use class with non-negative weighted least squares at chome level
//       target(chome) ~ sum_k coef_k * (sum of footprint x floors of survey buildings of class k)     weight 1/(target+200), no intercept
//     targets: residents (subward*.json), workers (jobs.json), employed residents (employed.json); chomes joined by ward + chome name.
//  2. building weight = footprint x floors x coef[class]; a chome's census total is split by weight (fallback footprint x floors when all
//     weights are 0). Buildings are assigned to a chome by centroid point-in-polygon on the census small-area polygons.
// Survey classes other than 111-150 (about 18k polygons: codes 210/220/300/400/510/520/61x/700/800/900, definition sheet unreadable) are
// not treated as buildings and are dropped. Floors: BV_3 (above ground), 1 when missing.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { readDbf } from "./tokyo-lu-dbf.mjs";
import { readPackJson } from "./pack-json.mjs";
import { toLonLat } from "./jp-plane-ix.mjs";

const T = fileURLToPath(new URL("../packs/tokyo/", import.meta.url));
const [luArg, outPath, reportPath] = process.argv.slice(2);
if (!luArg || !outPath) throw new Error("usage: <R03建物現況 dir|.shp> <out.ndjson> [report.json]");
const shpPath = luArg.endsWith(".shp") ? luArg : path.join(luArg, "R03建物現況.shp");
const dbfPath = shpPath.replace(/\.shp$/, ".dbf");
const USE = [111, 112, 113, 114, 121, 122, 123, 124, 125, 131, 132, 141, 142, 143, 150];
const UI = new Map(USE.map((u, i) => [u, i]));
const K = USE.length;
const WARDS = new Set(Array.from({ length: 23 }, (_, i) => String(13101 + i)));

// ---- ward slugs for the `district` property (ward-chiyoda -> chiyoda), from demand.json
const demand = readPackJson(T + "demand.json");
const slug = new Map();
for (const p of demand.points) if (p.jisCode !== undefined && /^ward-/.test(p.id)) slug.set(String(p.jisCode).slice(0, 5), p.id.replace(/^ward-/, ""));

// ---- census targets per chome (joined by ward code + chome name because the survey has its own town numbering)
const sw = readPackJson(T + "subward.json");
const jobsJson = readPackJson(T + "jobs.json");
const empJson = readPackJson(T + "employed.json");
const targets = { pop: new Map(), jobs: new Map(), emp: new Map() }, dup = new Set();
for (const w of Object.values(sw.wards)) for (const a of w.areas) {
  const k = String(a.code).slice(0, 5) + "|" + a.name_ja;
  if (targets.pop.has(k)) { dup.add(k); continue; }
  targets.pop.set(k, a.residents ?? 0);
  if (jobsJson.areas[a.code]) targets.jobs.set(k, jobsJson.areas[a.code].w);
  if (empJson.areas[a.code] !== undefined) targets.emp.set(k, empJson.areas[a.code]);
}
for (const k of dup) for (const m of Object.values(targets)) m.delete(k);

// ---- read the survey: polygons (plane coords) + attributes
console.log("reading survey ...");
const shp = fs.readFileSync(shpPath);
const NMAX = 1808305;
const cls = new Uint16Array(NMAX), flr = new Uint8Array(NMAX), area = new Float32Array(NMAX), keep = new Uint8Array(NMAX);
const ptOff = new Uint32Array(NMAX + 1), partStart = new Uint32Array(NMAX + 1);
const xs = [], ys = [], parts = [], codeKey = new Array(NMAX), wardOf = new Array(NMAX);
let n = 0, nPts = 0, dropped = 0, offWard = 0;
{
  let pos = 100;
  for (const r of readDbf(dbfPath)) {
    const len = shp.readInt32BE(pos + 4) * 2, st = shp.readInt32LE(pos + 8);
    if (st === 5) {
      const base = pos + 8, np = shp.readInt32LE(base + 36), npt = shp.readInt32LE(base + 40);
      const ward = String(r.CODE5).slice(0, 5), c = r.BV_6;
      const isBuilding = UI.has(c) && WARDS.has(ward);
      if (!UI.has(c)) dropped++; else if (!WARDS.has(ward)) offWard++;
      cls[n] = c; flr[n] = r.BV_3 > 0 ? Math.min(255, r.BV_3) : 1; keep[n] = isBuilding ? 1 : 0;
      partStart[n] = parts.length; ptOff[n] = nPts;
      if (isBuilding) {
        for (let k = 0; k < np; k++) parts.push(nPts + shp.readInt32LE(base + 44 + 4 * k));
        const po = base + 44 + 4 * np;
        for (let k = 0; k < npt; k++) { xs.push(shp.readDoubleLE(po + 16 * k)); ys.push(shp.readDoubleLE(po + 16 * k + 8)); }
        nPts += npt;
      }
      codeKey[n] = ward + "|" + r.NAME2; wardOf[n] = ward;
      n++;
    }
    pos += 8 + len;
  }
  ptOff[n] = nPts; partStart[n] = parts.length;
}
// ptOff/partStart[i] record the start of polygon i for kept AND skipped shapes (skipped ones store nothing), so [i, i+1) is always its range
const X = Float64Array.from(xs), Y = Float64Array.from(ys); xs.length = 0; ys.length = 0;
console.log(`survey polygons ${n}, buildings kept ${keep.reduce((s, v) => s + v, 0)}, non-building classes dropped ${dropped}, outside the 23 wards ${offWard}`);

// footprint area from the plane coordinates (outer ring minus holes)
const ringArea = (a, b) => { let s = 0; for (let k = a; k < b - 1; k++) s += X[k] * Y[k + 1] - X[k + 1] * Y[k]; return s / 2; };
function partRanges(i) {
  const out = [], p0 = partStart[i], p1 = partStart[i + 1];
  for (let pi = p0; pi < p1; pi++) out.push([parts[pi], pi + 1 < p1 ? parts[pi + 1] : ptOff[i + 1]]);
  return out;
}
for (let i = 0; i < n; i++) {
  if (!keep[i]) continue;
  let s = 0; const rs = partRanges(i);
  rs.forEach(([a, b], k) => { const ar = ringArea(a, b); s += k === 0 ? Math.abs(ar) : -Math.abs(ar); });
  area[i] = Math.max(s, 0.5);
}

// ---- chome fits: units per m2 floor area by class, three targets
const agg = new Map(); // key -> Float64Array(K) of footprint x floors by class
for (let i = 0; i < n; i++) {
  if (!keep[i]) continue;
  let v = agg.get(codeKey[i]); if (!v) agg.set(codeKey[i], v = new Float64Array(K));
  v[UI.get(cls[i])] += area[i] * flr[i];
}
function fit(target) {
  const rows = []; for (const [k, y] of target) { const v = agg.get(k); if (v) rows.push({ v, y }); }
  const wt = rows.map((r) => 1 / (r.y + 200)), M = Array.from({ length: K }, () => new Float64Array(K)), b = new Float64Array(K);
  rows.forEach((r, i) => { for (let a = 0; a < K; a++) { b[a] += wt[i] * r.v[a] * r.y; for (let c = 0; c < K; c++) M[a][c] += wt[i] * r.v[a] * r.v[c]; } });
  const coef = new Float64Array(K);
  for (let it = 0; it < 20000; it++) for (let a = 0; a < K; a++) { if (M[a][a] === 0) continue; let s = b[a]; for (let c = 0; c < K; c++) if (c !== a) s -= M[a][c] * coef[c]; coef[a] = Math.max(0, s / M[a][a]); }
  const ym = rows.reduce((t, r) => t + r.y, 0) / rows.length; let ssr = 0, sst = 0;
  for (const r of rows) { let p = 0; for (let a = 0; a < K; a++) p += coef[a] * r.v[a]; ssr += (r.y - p) ** 2; sst += (r.y - ym) ** 2; }
  return { coef, r2: 1 - ssr / sst, chomes: rows.length };
}
const fits = {}; for (const m of ["pop", "jobs", "emp"]) { fits[m] = fit(targets[m]); console.log(m, "chomes", fits[m].chomes, "R2", fits[m].r2.toFixed(3)); }

// ---- chome polygons (census small-area) for building -> chome
const CELLG = 0.005, cg = new Map(), chomes = [];
for (const w of Object.values(sw.wards)) for (const a of w.areas) {
  if (!a.polygons || !a.polygons.length) continue;
  const bb = [Infinity, Infinity, -Infinity, -Infinity];
  for (const poly of a.polygons) for (const [x, y] of poly[0]) { bb[0] = Math.min(bb[0], x); bb[1] = Math.min(bb[1], y); bb[2] = Math.max(bb[2], x); bb[3] = Math.max(bb[3], y); }
  const id = chomes.push({ code: String(a.code), polys: a.polygons, bb, total: { pop: a.residents ?? 0, jobs: jobsJson.areas[a.code]?.w ?? 0, emp: empJson.areas[a.code] ?? 0 }, w: { pop: 0, jobs: 0, emp: 0 }, fb: 0, n: 0 }) - 1;
  for (let gx = Math.floor(bb[0] / CELLG); gx <= Math.floor(bb[2] / CELLG); gx++) for (let gy = Math.floor(bb[1] / CELLG); gy <= Math.floor(bb[3] / CELLG); gy++) { const k = gx * 100000 + gy; let l = cg.get(k); if (!l) cg.set(k, l = []); l.push(id); }
}
const inRing = (ring, x, y) => { let ins = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const [xi, yi] = ring[i], [xj, yj] = ring[j]; if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) ins = !ins; } return ins; };
function findChome(x, y) {
  for (const id of cg.get(Math.floor(x / CELLG) * 100000 + Math.floor(y / CELLG)) ?? []) {
    const c = chomes[id]; if (x < c.bb[0] || x > c.bb[2] || y < c.bb[1] || y > c.bb[3]) continue;
    for (const poly of c.polys) { if (!inRing(poly[0], x, y)) continue; let hole = false; for (let h = 1; h < poly.length; h++) if (inRing(poly[h], x, y)) { hole = true; break; } if (!hole) return id; }
  }
  return -1;
}

// ---- convert to WGS84, assign chomes, accumulate weights
console.log("projecting + assigning chomes ...");
const chomeOf = new Int32Array(n).fill(-1), lonlat = new Array(n), wgt = { pop: new Float64Array(n), jobs: new Float64Array(n), emp: new Float64Array(n) }, fbw = new Float64Array(n);
let outside = 0;
for (let i = 0; i < n; i++) {
  if (!keep[i]) continue;
  const rs = partRanges(i), rings = rs.map(([a, b]) => { const r = []; for (let k = a; k < b; k++) { const [lo, la] = toLonLat(X[k], Y[k]); r.push([Math.round(lo * 1e6) / 1e6, Math.round(la * 1e6) / 1e6]); } return r; });
  lonlat[i] = rings;
  let cx = 0, cy = 0; const outer = rings[0]; for (let k = 0; k < outer.length - 1; k++) { cx += outer[k][0]; cy += outer[k][1]; } cx /= Math.max(1, outer.length - 1); cy /= Math.max(1, outer.length - 1);
  const ci = findChome(cx, cy); chomeOf[i] = ci;
  const fa = area[i] * flr[i], u = UI.get(cls[i]);
  fbw[i] = fa;
  for (const m of ["pop", "jobs", "emp"]) wgt[m][i] = fa * fits[m].coef[u];
  if (ci < 0) outside++; else { const c = chomes[ci]; c.n++; c.fb += fa; for (const m of ["pop", "jobs", "emp"]) c.w[m] += wgt[m][i]; }
}

// ---- write features
const out = fs.createWriteStream(outPath);
const ring2 = (rs) => { // shapefile rings: outer clockwise, holes counter-clockwise -> GeoJSON Polygon/MultiPolygon
  const polys = []; let cur = null;
  for (const r of rs) {
    let s = 0; for (let k = 0; k < r.length - 1; k++) s += r[k][0] * r[k + 1][1] - r[k + 1][0] * r[k][1];
    if (s <= 0 || !cur) { cur = [r]; polys.push(cur); } else cur.push(r); // s<=0: clockwise in lon/lat = outer
  }
  return polys.length === 1 ? { type: "Polygon", coordinates: polys[0] } : { type: "MultiPolygon", coordinates: polys };
};
const alloc = { pop: 0, jobs: 0, emp: 0 }, totals = { pop: 0, jobs: 0, emp: 0 }, fallback = { pop: 0, jobs: 0, emp: 0 }, nobuilding = { pop: [], jobs: [], emp: [] };
for (const c of chomes) for (const m of ["pop", "jobs", "emp"]) { totals[m] += c.total[m]; if (c.total[m] > 0 && c.n === 0) nobuilding[m].push(c.code); if (c.total[m] > 0 && c.n > 0 && c.w[m] === 0) fallback[m]++; }
let written = 0;
for (let i = 0; i < n; i++) {
  if (!keep[i]) continue;
  const props = { kind: "building", district: slug.get(wardOf[i]) ?? wardOf[i], sourceKind: "survey", levels: flr[i], lu: cls[i] };
  for (const m of ["pop", "jobs", "emp"]) {
    let v = 0; const ci = chomeOf[i];
    if (ci >= 0) { const c = chomes[ci]; if (c.w[m] > 0) v = c.total[m] * wgt[m][i] / c.w[m]; else if (c.fb > 0) v = c.total[m] * fbw[i] / c.fb; }
    alloc[m] += v; props[m] = Math.round(v * 10) / 10;
  }
  out.write(JSON.stringify({ type: "Feature", properties: props, geometry: ring2(lonlat[i]) }) + "\n"); written++;
}
await new Promise((r) => out.end(r));
const rep = {
  surveyPolygons: n, buildings: written, droppedNonBuildingClasses: dropped, outsideAnyChome: outside,
  fits: Object.fromEntries(Object.entries(fits).map(([m, f]) => [m, { r2: +f.r2.toFixed(3), chomes: f.chomes, per1000m2Floor: Object.fromEntries(USE.map((u, i) => [u, +(f.coef[i] * 1000).toFixed(3)])) }])),
  census: totals, allocated: Object.fromEntries(Object.entries(alloc).map(([m, v]) => [m, Math.round(v)])),
  allocatedShare: Object.fromEntries(Object.entries(alloc).map(([m, v]) => [m, +(v / totals[m]).toFixed(5)])),
  chomesWithNoBuilding: Object.fromEntries(Object.entries(nobuilding).map(([m, l]) => [m, l.length])), chomesFallbackAllBuildings: fallback,
};
if (reportPath) fs.writeFileSync(reportPath, JSON.stringify(rep, null, 1));
console.log(JSON.stringify(rep, null, 1));
