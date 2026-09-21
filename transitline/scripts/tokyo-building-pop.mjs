// Distribute each chome's real census population across its OSM buildings (MODELED, not measured).
// Usage: node --max-old-space-size=8192 scripts/tokyo-building-pop.mjs <tokyo23-buildings.geojson> <out.geojson> [report.json]
// Model (same as README "Building-level population model"): weight = footprint_m2 x building:levels (1 if untagged)
//   x type multiplier (0 for non-residential OSM tags, 1 otherwise); building pop = chome residents x weight / sum(weights).
// Chomes whose buildings are all non-residential fall back to footprint x levels over every building.
// Chome residents: subward.json (2020 census, e-Stat). Buildings are assigned to a chome by centroid point-in-polygon.
import fs from "fs";
import { fileURLToPath } from "url";
const T = fileURLToPath(new URL("../packs/tokyo/", import.meta.url));
const [src, out, reportPath] = process.argv.slice(2);
if (!src || !out) throw new Error("usage: <buildings.geojson> <out.geojson> [report.json]");

const ZERO = new Set(("commercial retail office public hotel university construction school warehouse hut shrine service college " +
  "train_station parking government hospital industrial toilets temple shed bridge kindergarten guardhouse transportation " +
  "sports_hall police no kiosk gate garage fire_station concert_hall church roof").split(" "));

const rd = (f) => JSON.parse(fs.readFileSync(T + f, "utf8").replace(/^﻿/, ""));
const sw = rd("subward.json");

// ---- chome polygons + grid index
const CELL = 0.005; // ~450 m
const chomes = []; // {code, residents, polys:[ [ring...] ], bbox}
const grid = new Map();
for (const w of Object.values(sw.wards)) for (const a of w.areas) {
  if (!a.polygons || !a.polygons.length) continue;
  const bb = [Infinity, Infinity, -Infinity, -Infinity];
  for (const poly of a.polygons) for (const [x, y] of poly[0]) { bb[0] = Math.min(bb[0], x); bb[1] = Math.min(bb[1], y); bb[2] = Math.max(bb[2], x); bb[3] = Math.max(bb[3], y); }
  const c = { code: a.code, name: a.name_ja, residents: a.residents, polys: a.polygons, bb, wsum: 0, asum: 0, n: 0 };
  const id = chomes.push(c) - 1;
  for (let gx = Math.floor(bb[0] / CELL); gx <= Math.floor(bb[2] / CELL); gx++)
    for (let gy = Math.floor(bb[1] / CELL); gy <= Math.floor(bb[3] / CELL); gy++) {
      const k = gx * 100000 + gy; (grid.get(k) ?? grid.set(k, []).get(k)).push(id);
    }
}
function inRing(ring, x, y) {
  let ins = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) ins = !ins;
  }
  return ins;
}
function findChome(x, y) {
  for (const id of grid.get(Math.floor(x / CELL) * 100000 + Math.floor(y / CELL)) ?? []) {
    const c = chomes[id];
    if (x < c.bb[0] || x > c.bb[2] || y < c.bb[1] || y > c.bb[3]) continue;
    for (const poly of c.polys) {
      if (!inRing(poly[0], x, y)) continue;
      let hole = false;
      for (let h = 1; h < poly.length; h++) if (inRing(poly[h], x, y)) { hole = true; break; }
      if (!hole) return id;
    }
  }
  return -1;
}

// ---- buildings
const fc = JSON.parse(fs.readFileSync(src, "utf8"));
const feats = fc.features;
const KLAT = 111320, KLON = 111320 * Math.cos(35.68 * Math.PI / 180);
let outside = 0;
const B = new Array(feats.length);
for (let i = 0; i < feats.length; i++) {
  const f = feats[i], ring = f.geometry.coordinates[0];
  let a2 = 0, cx = 0, cy = 0;
  for (let k = 0; k < ring.length - 1; k++) {
    const [x1, y1] = ring[k], [x2, y2] = ring[k + 1];
    a2 += (x1 * KLON) * (y2 * KLAT) - (x2 * KLON) * (y1 * KLAT); cx += x1; cy += y1;
  }
  cx /= ring.length - 1; cy /= ring.length - 1;
  const area = Math.abs(a2) / 2;
  const lv = Number(f.properties.levels); const levels = lv > 0 ? lv : 1;
  const mult = ZERO.has(f.properties.sourceKind) ? 0 : 1;
  const ci = findChome(cx, cy);
  if (ci < 0) outside++;
  else { const c = chomes[ci]; c.n++; c.wsum += area * levels * mult; c.asum += area * levels; }
  B[i] = { ci, w: area * levels * mult, fb: area * levels };
}

// ---- allocate
let allocated = 0, lost = 0, fallbackChomes = 0; const noBuilding = [];
for (const c of chomes) {
  if (c.residents > 0 && c.n === 0) { lost += c.residents; noBuilding.push(`${c.code} ${c.name} (${c.residents})`); }
  if (c.residents > 0 && c.n > 0 && c.wsum === 0) fallbackChomes++;
}
for (let i = 0; i < feats.length; i++) {
  const b = B[i], p = feats[i].properties; let pop = 0;
  if (b.ci >= 0) {
    const c = chomes[b.ci];
    if (c.wsum > 0) pop = c.residents * b.w / c.wsum;
    else if (c.asum > 0) pop = c.residents * b.fb / c.asum;
  }
  allocated += pop;
  p.pop = Math.round(pop * 10) / 10;
}
fs.writeFileSync(out, JSON.stringify(fc));
const totalRes = chomes.reduce((t, c) => t + c.residents, 0);
const rep = { buildings: feats.length, outsideAnyChome: outside, chomes: chomes.length, totalResidents: totalRes,
  allocated: Math.round(allocated), unallocatedNoBuilding: lost, chomesWithNoBuilding: noBuilding.length,
  chomesFallbackAllBuildings: fallbackChomes, noBuildingSample: noBuilding.slice(0, 30) };
if (reportPath) fs.writeFileSync(reportPath, JSON.stringify(rep, null, 1));
console.log(rep);
