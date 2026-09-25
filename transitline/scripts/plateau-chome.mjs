// Shared by saitama-job-coefficients.mjs and saitama-jobs-buildings.mjs: assign PLATEAU buildings to chome
// (point-in-polygon on subward-saitama.json) and collapse 枝番 parts into one record per 建物ID.
// Survey attributes (延床面積, 用途, ...) repeat on every part, so parts must never be summed for those.
// Floor area = 延床面積 when surveyed, else mesh footprint x a LEARNED floor/footprint ratio for the building's
// height (see fitFloorRatio) - not a fixed height/3 rule: LOD1 height is the roof ridge, so height/3 counts a 2-storey
// house as 3 storeys (F/(footprint*height/3) measured 0.6-1.0 across height bands in Saitama/Kawasaki/Yokosuka).

import fs from "fs";
import { fileURLToPath } from "url";

// wards: subward-saitama.json `wards`; keep estat ward codes lo..hi (Saitama City = 11101..11110)
export function chomeIndex(wards, lo = 11101, hi = 11110) {
  const CELL = 0.005, grid = new Map(), areas = [];
  for (const [wk, w] of Object.entries(wards)) {
    const c5 = +wk.slice(0, 5);
    if (c5 < lo || c5 > hi) continue;
    for (const a of w.areas) {
      const id = areas.length;
      let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
      for (const poly of a.polygons) for (const ring of poly) for (const [x, y] of ring) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
      areas.push({ code: a.code, name_ja: a.name_ja, ward: wk, polygons: a.polygons, x0, y0, x1, y1 });
      for (let i = Math.floor(x0 / CELL); i <= Math.floor(x1 / CELL); i++) for (let j = Math.floor(y0 / CELL); j <= Math.floor(y1 / CELL); j++) {
        const k = i * 100003 + j; (grid.get(k) ?? grid.set(k, []).get(k)).push(id);
      }
    }
  }
  const inRing = (x, y, r) => { let c = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const [xi, yi] = r[i], [xj, yj] = r[j]; if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c; } return c; };
  const inArea = (a, x, y) => x >= a.x0 && x <= a.x1 && y >= a.y0 && y <= a.y1 && a.polygons.some((poly) => poly.reduce((s, ring) => s ^ inRing(x, y, ring), false));
  const locate = (x, y) => { for (const id of grid.get(Math.floor(x / CELL) * 100003 + Math.floor(y / CELL)) ?? []) if (inArea(areas[id], x, y)) return id; return -1; };
  return { areas, locate };
}

// Height bands (m, of 計測高さ) in which the surveyed floor-area / mesh-footprint ratio is learned.
export const RATIO_EDGES = [0, 3, 4.5, 6, 7.5, 9, 10.5, 12, 15, 18, 24, 36, 60, 1e9];
const binOf = (h) => { for (let i = RATIO_EDGES.length - 2; i >= 0; i--) if (h >= RATIO_EDGES[i]) return i; return 0; };
const median = (a) => { const b = [...a].sort((x, y) => x - y); return b[b.length >> 1]; };
const POOLED_FILE = fileURLToPath(new URL("./plateau-floor-ratio.json", import.meta.url));

// Per-building view used for both learning and applying the ratio: footprint = sum of parts' mesh footprint,
// height = footprint-weighted mean of the parts' 計測高さ (null if none has one).
function buildingView(parts) {
  const M = parts.reduce((s, r) => s + (r[12] > 0 ? r[12] : 0), 0);
  let hw = 0, hm = 0;
  for (const r of parts) if (r[12] > 0 && r[10] > 0) { hw += r[12]; hm += r[12] * r[10]; }
  return { M, h: hw > 0 ? hm / hw : null };
}

// Learn median(延床面積 / mesh footprint) per height band from buildings that HAVE a surveyed 延床面積 and a mesh
// footprint. Returns { edges, ratios[bin] (null where < minN samples), unknown (buildings without height), all, n }.
export function fitFloorRatio(rows, minN = 30) {
  const byId = new Map();
  for (const r of rows) (byId.get(r[11]) ?? byId.set(r[11], []).get(r[11])).push(r);
  const bins = RATIO_EDGES.slice(1).map(() => []), unk = [], all = [];
  for (const parts of byId.values()) {
    const F = parts[0][5]; if (!(F > 0)) continue;
    const { M, h } = buildingView(parts); if (!(M > 0)) continue;
    const q = F / M; all.push(q);
    if (h == null) unk.push(q); else bins[binOf(h)].push(q);
  }
  return {
    edges: RATIO_EDGES, n: all.length,
    ratios: bins.map((a) => (a.length >= minN ? +median(a).toFixed(4) : null)),
    binN: bins.map((a) => a.length),
    unknown: unk.length >= minN ? +median(unk).toFixed(4) : null,
    all: all.length ? +median(all).toFixed(4) : null,
  };
}

export function loadPooledRatio() {
  try { return JSON.parse(fs.readFileSync(POOLED_FILE, "utf8")); } catch { return null; }
}

// Ratio for a building of height h: this city's own band if it has one, else the pooled table's, else the
// nearest band that has any value (own first), else the overall median.
function ratioFor(h, own, pooled) {
  const pick = (t, i) => (t && t.ratios[i] != null ? t.ratios[i] : null);
  if (h == null) return own.unknown ?? pooled?.unknown ?? own.all ?? pooled?.all ?? 1;
  const i = binOf(h);
  for (const t of [own, pooled]) { const v = pick(t, i); if (v != null) return v; }
  for (let d = 1; d < RATIO_EDGES.length; d++) for (const j of [i - d, i + d]) for (const t of [own, pooled]) { const v = j >= 0 ? pick(t, j) : null; if (v != null) return v; }
  return own.all ?? pooled?.all ?? 1;
}

// rows from plateau-buildings.mjs -> [{ id, lon, lat, use (null if unknown), floorM2, footprintM2, storeys,
// surveyed, chome, basementLevels (null if the city's dataset doesn't carry 地下階数, e.g. Saitama) }]
// Unsurveyed buildings get floorM2 = mesh footprint x learned ratio (own city if it has >= 300 surveyed
// buildings with a mesh footprint, otherwise the pooled table in plateau-floor-ratio.json).
export function buildingRecords(rows, locate) {
  const own = fitFloorRatio(rows), pooled = own.n >= 300 ? null : loadPooledRatio();
  const byId = new Map();
  for (const r of rows) (byId.get(r[11]) ?? byId.set(r[11], []).get(r[11])).push(r);
  const out = [], stat = { ids: byId.size, surveyed: 0, estimated: 0, outside: 0, noArea: 0, ratioSource: own.n >= 300 ? "own city (" + own.n + " surveyed buildings)" : pooled ? "pooled table" : "none" };
  for (const [id, parts] of byId) {
    const [lon, lat, use, storeys, , tot] = parts[0];
    const chome = locate(lon, lat);
    if (chome < 0) { stat.outside++; continue; }
    const { M: footprintM2, h } = buildingView(parts);
    let floorM2 = tot, surveyed = tot > 0;
    if (!surveyed) floorM2 = footprintM2 > 0 ? footprintM2 * ratioFor(h, own, own.n >= 300 ? null : pooled) : 0;
    if (!(floorM2 > 0)) { stat.noArea++; continue; }
    stat[surveyed ? "surveyed" : "estimated"]++;
    // basement levels repeats per-part like the other 建物ID-level fields; the parts' max is the building's depth
    const basementLevels = parts.reduce((m, r) => (r[13] > (m ?? -1) ? r[13] : m), null);
    out.push({ id, lon, lat, use, floorM2, footprintM2, storeys, surveyed, chome, basementLevels });
  }
  return { records: out, stat };
}
