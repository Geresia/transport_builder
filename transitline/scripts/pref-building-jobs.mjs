// Per-building workers for Saitama / Chiba / Kanagawa (MODELED, not measured) — OSM building-tag model, since these
// three prefectures have no land-use survey like Tokyo's. Fixes the gap where only Tokyo (and Saitama City via its
// own PLATEAU-based jobs-buildings-saitama.json) had a per-building worker figure to click on.
// Usage: DEPS=<dir with node_modules of pmtiles,@mapbox/vector-tile,pbf> node --max-old-space-size=8000 scripts/pref-building-jobs.mjs \
//          <saitama|chiba|kanagawa> <existing <pref>-buildings.pmtiles, already carrying pop> <out.geojsonl> [report.json]
// Reads the buildings back from the existing z14 tiles (same tile-clip approach as pref-building-pop.mjs, so a
// building crossing a tile edge becomes one piece per tile and buffer duplicates vanish) and carries each piece's
// already-baked `pop` straight through unchanged. Job weight = footprint x building:levels (1 if untagged) x
// job-coefficients.json's osmKindJobsPer1000m2[kind] (same table used for Tokyo's OSM-tag fallback; untagged
// building=yes falls back to the "house" rate, i.e. treated as residential/low-job by default). Each chome's real
// 2021 Economic Census worker total (jobs-<pref>.json .areas[code].w) is then split across its buildings by weight.
import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { fileURLToPath } from "url";
const T = fileURLToPath(new URL("../packs/tokyo/", import.meta.url));
const req = createRequire(path.resolve(process.env.DEPS || ".", "x.js"));
const { PMTiles } = req("pmtiles");
const { VectorTile } = req("@mapbox/vector-tile");
const { PbfReader: Pbf } = req("pbf");
const [pref, tilesPath, out, reportPath] = process.argv.slice(2);
if (!pref || !tilesPath || !out) throw new Error("usage: <pref> <tiles.pmtiles> <out.geojsonl> [report.json]");

const COEF = JSON.parse(fs.readFileSync(T + "job-coefficients.json", "utf8").replace(/^﻿/, "")).osmKindJobsPer1000m2;
const FALLBACK = COEF.house; // building=yes with no other tag: same default as elsewhere in this pack ("treated as residential")
const coefOf = (kind) => (kind in COEF ? COEF[kind] : FALLBACK);

// ---- chomes: geometry from subward-<pref>.json, real worker totals from jobs-<pref>.json (same `code` key)
const sw = JSON.parse(fs.readFileSync(T + `subward-${pref}.json`, "utf8").replace(/^﻿/, ""));
const jb = JSON.parse(fs.readFileSync(T + `jobs-${pref}.json`, "utf8").replace(/^﻿/, ""));
const CELLG = 0.005, cg = new Map(), chomes = [];
let chomesNoJobsRow = 0;
for (const w of Object.values(sw.wards)) for (const a of w.areas) {
  if (!a.polygons || !a.polygons.length) continue;
  const code = String(a.code);
  const workers = jb.areas?.[code]?.w ?? 0;
  if (!(code in (jb.areas ?? {}))) chomesNoJobsRow++;
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const poly of a.polygons) for (const [x, y] of poly[0]) { b[0] = Math.min(b[0], x); b[1] = Math.min(b[1], y); b[2] = Math.max(b[2], x); b[3] = Math.max(b[3], y); }
  const id = chomes.push({ code, name: a.name_ja, workers, polys: a.polygons, bb: b, n: 0, wsum: 0, asum: 0 }) - 1;
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

// ---- tile helpers (identical to pref-building-pop.mjs)
const Z = 14;
const tile2lon = (x, z) => x / 2 ** z * 360 - 180;
const tile2lat = (y, z) => { const n = Math.PI - 2 * Math.PI * y / 2 ** z; return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))); };
const lon2tile = (lon, z) => Math.floor((lon + 180) / 360 * 2 ** z);
const lat2tile = (lat, z) => Math.floor((1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * 2 ** z);
function clipRing(pts, x0, y0, x1, y1) {
  const edges = [[(p) => p[0] >= x0, (a, b) => { const t = (x0 - a[0]) / (b[0] - a[0]); return [x0, a[1] + t * (b[1] - a[1])]; }],
    [(p) => p[0] <= x1, (a, b) => { const t = (x1 - a[0]) / (b[0] - a[0]); return [x1, a[1] + t * (b[1] - a[1])]; }],
    [(p) => p[1] >= y0, (a, b) => { const t = (y0 - a[1]) / (b[1] - a[1]); return [a[0] + t * (b[0] - a[0]), y0]; }],
    [(p) => p[1] <= y1, (a, b) => { const t = (y1 - a[1]) / (b[1] - a[1]); return [a[0] + t * (b[0] - a[0]), y1]; }]];
  let poly = pts;
  for (const [inside, inter] of edges) {
    if (!poly.length) break; const res = [];
    for (let i = 0; i < poly.length; i++) {
      const cur = poly[i], prev = poly[(i + poly.length - 1) % poly.length];
      if (inside(cur)) { if (!inside(prev)) res.push(inter(prev, cur)); res.push(cur); } else if (inside(prev)) res.push(inter(prev, cur));
    }
    poly = res;
  }
  return poly;
}
const ringArea = (r) => { let s = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) s += r[j][0] * r[i][1] - r[i][0] * r[j][1]; return s / 2; };

// ---- read tiles: keep the piece's existing `pop`, compute a job weight from `kind`
const fd = fs.openSync(tilesPath, "r");
const source = { getKey: () => tilesPath, getBytes: async (offset, length) => { const b = Buffer.alloc(length); fs.readSync(fd, b, 0, length, offset); return { data: b.buffer.slice(b.byteOffset, b.byteOffset + length) }; } };
const pm = new PMTiles(source);
let bbox = [Infinity, Infinity, -Infinity, -Infinity];
for (const c of chomes) { bbox[0] = Math.min(bbox[0], c.bb[0]); bbox[1] = Math.min(bbox[1], c.bb[1]); bbox[2] = Math.max(bbox[2], c.bb[2]); bbox[3] = Math.max(bbox[3], c.bb[3]); }
const x0 = lon2tile(bbox[0], Z), x1 = lon2tile(bbox[2], Z), y0 = lat2tile(bbox[3], Z), y1 = lat2tile(bbox[1], Z);
console.log(pref, "chomes", chomes.length, "with no jobs-pref.json row:", chomesNoJobsRow, "tile range", x1 - x0 + 1, "x", y1 - y0 + 1);

const tmp = out + ".tmp";
const wfd = fs.openSync(tmp, "w");
let pieces = 0, outside = 0, tilesRead = 0, buf = [];
const KLAT = 111320;
for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) {
  const r = await pm.getZxy(Z, tx, ty); if (!r) continue; tilesRead++;
  const vt = new VectorTile(new Pbf(new Uint8Array(r.data))); const layer = vt.layers.building; if (!layer) continue;
  const lonW = tile2lon(tx, Z), lonE = tile2lon(tx + 1, Z), latN = tile2lat(ty, Z), latS = tile2lat(ty + 1, Z);
  const EXT = layer.extent, mPerLon = 111320 * Math.cos((latN + latS) / 2 * Math.PI / 180);
  for (let fi = 0; fi < layer.length; fi++) {
    const f = layer.feature(fi); if (f.type !== 3) continue;
    const rings = f.loadGeometry().map((rg) => rg.map((p) => [p.x, p.y]));
    const polys = []; let cur = null;
    for (const rg of rings) { if (rg.length < 3) continue; const a = ringArea(rg); if (!cur || a * ringArea(cur[0]) > 0) polys.push(cur = [rg]); else cur.push(rg); }
    for (const pr of polys) {
      const cl = pr.map((rg) => clipRing(rg, 0, 0, EXT, EXT)).filter((rg) => rg.length >= 3);
      if (!cl.length || ringArea(cl[0]) === 0) continue;
      let area = 0, cx = 0, cy = 0;
      cl.forEach((rg, i) => { const a = Math.abs(ringArea(rg)); area += i === 0 ? a : -a; if (i === 0) { for (const p of rg) { cx += p[0]; cy += p[1]; } cx /= rg.length; cy /= rg.length; } });
      const mx = (lonE - lonW) / EXT * mPerLon, my = (latN - latS) / EXT * KLAT; area *= mx * my;
      const lon = lonW + cx / EXT * (lonE - lonW), lat = latN - cy / EXT * (latN - latS);
      const p = f.properties, lv = Number(p.levels), levels = lv > 0 ? lv : 1;
      const w = area * levels * coefOf(p.kind);
      const ci = findChome(lon, lat);
      if (ci < 0) outside++; else { const c = chomes[ci]; c.n++; c.wsum += w; c.asum += area * levels; }
      const coords = cl.map((rg) => { const q = rg.map(([x, y]) => [+(lonW + x / EXT * (lonE - lonW)).toFixed(7), +(latN - y / EXT * (latN - latS)).toFixed(7)]); q.push(q[0]); return q; });
      buf.push(JSON.stringify({ type: "Feature", properties: { kind: p.kind ?? null, levels: p.levels ?? null, height: p.height ?? null, pop: p.pop ?? 0, ci, w: +w.toFixed(3), fb: +(area * levels).toFixed(2) }, geometry: { type: "Polygon", coordinates: coords } }));
      pieces++;
    }
  }
  if (buf.length > 20000) { fs.writeSync(wfd, buf.join("\n") + "\n"); buf = []; }
}
if (buf.length) fs.writeSync(wfd, buf.join("\n") + "\n");
fs.closeSync(wfd);
console.log("tiles", tilesRead, "pieces", pieces);

// ---- allocate + rewrite
let allocated = 0, lost = 0, fallback = 0; const noBuilding = [];
for (const c of chomes) {
  if (c.workers > 0 && c.n === 0) { lost += c.workers; noBuilding.push(`${c.code} ${c.name} (${c.workers})`); }
  if (c.workers > 0 && c.n > 0 && c.wsum === 0) fallback++;
}
const rl = (await import("readline")).createInterface({ input: fs.createReadStream(tmp), crlfDelay: Infinity });
const ofd = fs.openSync(out, "w"); let ob = [];
for await (const line of rl) {
  if (!line) continue;
  const f = JSON.parse(line), p = f.properties; let jobs = 0;
  if (p.ci >= 0) { const c = chomes[p.ci]; if (c.wsum > 0) jobs = c.workers * p.w / c.wsum; else if (c.asum > 0) jobs = c.workers * p.fb / c.asum; }
  allocated += jobs;
  delete p.ci; delete p.w; delete p.fb; p.jobs = Math.round(jobs * 10) / 10;
  ob.push(JSON.stringify(f));
  if (ob.length > 20000) { fs.writeSync(ofd, ob.join("\n") + "\n"); ob = []; }
}
if (ob.length) fs.writeSync(ofd, ob.join("\n") + "\n");
fs.closeSync(ofd); fs.unlinkSync(tmp);
const totalWorkers = chomes.reduce((t, c) => t + c.workers, 0);
const rep = { pref, pieces, outsideAnyChome: outside, chomes: chomes.length, totalWorkers, allocated: Math.round(allocated),
  unallocatedNoBuilding: lost, chomesWithNoBuilding: noBuilding.length, chomesFallbackAllBuildings: fallback, noBuildingSample: noBuilding.slice(0, 20) };
if (reportPath) fs.writeFileSync(reportPath, JSON.stringify(rep, null, 1));
console.log(rep);
