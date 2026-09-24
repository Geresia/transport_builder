// Shared by saitama-job-coefficients.mjs and saitama-jobs-buildings.mjs: assign PLATEAU buildings to chome
// (point-in-polygon on subward-saitama.json) and collapse 枝番 parts into one record per 建物ID.
// Survey attributes (延床面積, 用途, ...) repeat on every part, so parts must never be summed for those.
// Floor area = 延床面積 when surveyed, else mesh footprint x round(計測高さ / 3 m) summed over parts.

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

// rows from plateau-buildings.mjs -> [{ id, lon, lat, use (null if unknown), floorM2, footprintM2, storeys,
// surveyed, chome, basementLevels (null if the city's dataset doesn't carry 地下階数, e.g. Saitama) }]
export function buildingRecords(rows, locate) {
  const byId = new Map();
  for (const r of rows) (byId.get(r[11]) ?? byId.set(r[11], []).get(r[11])).push(r);
  const out = [], stat = { ids: byId.size, surveyed: 0, estimated: 0, outside: 0, noArea: 0 };
  for (const [id, parts] of byId) {
    const [lon, lat, use, storeys, , tot] = parts[0];
    const chome = locate(lon, lat);
    if (chome < 0) { stat.outside++; continue; }
    const footprintM2 = parts.reduce((s, r) => s + (r[12] > 0 ? r[12] : 0), 0);
    let floorM2 = tot, surveyed = tot > 0;
    if (!surveyed) floorM2 = parts.reduce((s, r) => s + (r[12] > 0 ? r[12] * Math.max(1, Math.round((r[10] ?? 3) / 3)) : 0), 0);
    if (!(floorM2 > 0)) { stat.noArea++; continue; }
    stat[surveyed ? "surveyed" : "estimated"]++;
    // basement levels repeats per-part like the other 建物ID-level fields; the parts' max is the building's depth
    const basementLevels = parts.reduce((m, r) => (r[13] > (m ?? -1) ? r[13] : m), null);
    out.push({ id, lon, lat, use, floorM2, footprintM2, storeys, surveyed, chome, basementLevels });
  }
  return { records: out, stat };
}
