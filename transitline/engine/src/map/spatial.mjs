// Spatial lookups for the map layer. Pure functions over layers that the caller injects.
//
// Licensing boundary (LICENSING.md rule 2): this module holds NO geometry. OSM-derived
// footprints, roads and water live in the CityPack; the caller loads them and hands them in
// through the `*LayerFrom*` adapters below. A layer that is absent, or that does not cover the
// alignment, yields `null` (unknown) — never 0.
import { haversineMetres } from "../projection.mjs";

export const bboxOf = (pts) => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
};
export const overlaps = (a, b) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
const inBox = ([x, y], b) => x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3];

export const polylineLength = (pts) => pts.slice(1).reduce((sum, p, i) => sum + haversineMetres(pts[i], p), 0);

// Points at most `step` metres apart along a polyline, always including every vertex.
export function sampleAlong(pts, step = 100) {
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const n = Math.max(1, Math.ceil(haversineMetres(pts[i - 1], pts[i]) / step));
    for (let k = 1; k < n; k++) {
      out.push([pts[i - 1][0] + ((pts[i][0] - pts[i - 1][0]) * k) / n, pts[i - 1][1] + ((pts[i][1] - pts[i - 1][1]) * k) / n]);
    }
    out.push(pts[i]);
  }
  return out;
}

// --- planar tests in lon/lat (intersection is affine-invariant, so no projection needed) ---
const orient = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
// Interior crossings only: touching at an endpoint (two lines meeting at a shared station) is not a crossing.
export const properCross = (p, q, r, s) => orient(p, q, r) * orient(p, q, s) < 0 && orient(r, s, p) * orient(r, s, q) < 0;

export function inRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
const inPolygon = (pt, rings) => rings.reduce((odd, ring) => odd !== inRing(pt, ring), false); // even-odd: rings[1..] are holes

export function polylineCrossesLine(poly, line) {
  for (let i = 1; i < poly.length; i++) for (let j = 1; j < line.length; j++) if (properCross(poly[i - 1], poly[i], line[j - 1], line[j])) return true;
  return false;
}

export const closed = (ring) => (ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1] ? ring : [...ring, ring[0]]);

export function polylineHitsPolygon(poly, rings) {
  if (poly.some((pt) => inPolygon(pt, rings))) return true;
  return rings.some((ring) => polylineCrossesLine(poly, closed(ring))); // an open ring still has its closing edge
}

// Two simple rings share area: one has a vertex inside the other, or their edges cross. Touching only does not count.
export function ringsOverlap(a, b) {
  return a.some((p) => inRing(p, b)) || b.some((p) => inRing(p, a)) || polylineCrossesLine(closed(a), closed(b));
}

// Number of distinct items the polyline touches; `hit` decides per item.
function countHits(poly, items, hit) {
  const box = bboxOf(poly);
  return items.filter((item) => overlaps(box, item.bbox) && hit(poly, item)).length;
}

// --- layer adapters: CityPack file shapes -> { items, covers?, quality, source } ---
export function waterLayerFromBarriers(json, extra = {}) {
  const items = json.barriers.filter((b) => b.kind === "water").map((b) => ({ rings: b.polygon, bbox: bboxOf(b.polygon[0]) }));
  return { items, ...extra };
}

// obstacles.json footprints only exist for a few districts; outside them we know nothing, so
// coverage is the per-district bounding box of the footprints, not the whole pack.
export function buildingLayerFromObstacles(json, extra = {}) {
  const buildings = json.obstacles.filter((o) => o.kind === "building");
  const items = buildings.map((o, index) => ({
    id: o.id ?? `building:${o.district ?? "unknown"}:${index}`,
    rings: [o.polygon],
    bbox: bboxOf(o.polygon),
    kind: o.sourceKind,
    heightMeters: Number.isFinite(o.height) ? o.height : (Number.isFinite(o.levels) ? o.levels * 3 : null),
  }));
  const byDistrict = new Map();
  for (const o of buildings) byDistrict.set(o.district, [...(byDistrict.get(o.district) ?? []), ...o.polygon]);
  const boxes = [...byDistrict.values()].map(bboxOf);
  return { items, covers: (pt) => boxes.some((b) => inBox(pt, b)), ...extra };
}

// Polygons the caller already decoded (e.g. from vector tiles): [{ rings: [[lon,lat]...], kind? }]
export function polygonLayer(polygons, extra = {}) {
  return { items: polygons.map((p) => ({ ...p, bbox: bboxOf(p.rings[0]) })), ...extra };
}

export function roadLayerFromGeojson(fc, extra = {}) {
  const items = fc.features.map((f) => ({ line: f.geometry.coordinates, bbox: bboxOf(f.geometry.coordinates), cls: f.properties.roadClass }));
  return { items, ...extra };
}

// Existing rail as straight station-to-station lines. The pack collapses stations onto demand points,
// so this is coarse — the layer says so through `quality`.
export function railLayerFromExternal(networks, extra = {}) {
  const items = [];
  for (const net of networks) {
    const at = new Map(net.stations.map((s) => [s.id, s.location]));
    for (const line of net.lines) {
      const pts = line.stationIds.map((id) => at.get(id)).filter(Boolean);
      if (pts.length >= 2) items.push({ line: pts, bbox: bboxOf(pts) });
    }
  }
  return { items, quality: "low", source: { name: "ExternalNetwork (station-level, coarse)", license: "same as the pack it was derived from" }, ...extra };
}

export const regionCovers = (polygons) => {
  const parts = polygons.map((rings) => ({ rings, box: bboxOf(rings[0]) }));
  return (pt) => parts.some((p) => inBox(pt, p.box) && inPolygon(pt, p.rings));
};

function slopeSamples(dem, poly) {
  if (!dem?.slopeAt) return null;
  const values = sampleAlong(poly, 100).map((pt) => (!dem.covers || dem.covers(pt) ? dem.slopeAt(pt) ?? null : null));
  return values.some((v) => v === null) ? null : values;
}

// layers: { dem?, water?, roads?, buildings?, rail? }
//   dem:  { elevationAt([lon,lat]) -> metres|null, slopeAt([lon,lat]) -> degrees|null, covers?, quality, source }
//   others: { items, covers?, quality, source } from the adapters above.
export function makeSpatialContext(layers = {}) {
  const { dem, water, roads, buildings, rail } = layers;
  const covered = (layer, poly) => !layer.covers || sampleAlong(poly, 200).every(layer.covers);
  const known = (layer, poly, compute) => (layer && covered(layer, poly) ? compute(layer) : null);

  return {
    layers,
    quality: { elevation: dem?.quality ?? null, river: water?.quality ?? null, road: roads?.quality ?? null, railway: rail?.quality ?? null, building: buildings?.quality ?? null },
    sources: Object.entries(layers).filter(([, l]) => l?.source).map(([layer, l]) => ({ layer, quality: l.quality ?? null, ...l.source })),

    elevationAt: (pt) => (dem && (!dem.covers || dem.covers(pt)) ? dem.elevationAt(pt) ?? null : null),
    slopeAt: (pt) => (dem?.slopeAt && (!dem.covers || dem.covers(pt)) ? dem.slopeAt(pt) ?? null : null),

    // Slope samples (degrees) every 100 m; null if any sample has no DEM value.
    // maxSlopeAlong is the steepest one. steepShareAlong is the fraction at or above `steepDeg`: that share,
    // not the max, marks steep terrain, because levees and cuttings make thin steep cells even on flat ground.
    maxSlopeAlong: (poly) => { const v = slopeSamples(dem, poly); return v && Math.max(...v); },
    steepShareAlong: (poly, steepDeg) => { const v = slopeSamples(dem, poly); return v && v.filter((s) => s >= steepDeg).length / v.length; },

    // Why a value came back null: the layer was never injected, it does not cover the place, or (DEM only) a covered cell has no value.
    // `poly` is a polyline, or a single point wrapped as [pt].
    whyUnknown: (layerName, poly) => {
      const layer = layers[layerName];
      if (!layer) return "no-layer";
      return !layer.covers || sampleAlong(poly, 200).every(layer.covers) ? "no-dem-value" : "outside-coverage";
    },

    // river/railway/building: distinct items crossed. road: per class. utility: no dataset exists yet -> always unknown.
    crossings: (poly) => ({
      river: known(water, poly, (l) => countHits(poly, l.items, (p, it) => polylineHitsPolygon(p, it.rings))),
      road: known(roads, poly, (l) => {
        const out = { highway: 0, major: 0, minor: 0 };
        const box = bboxOf(poly);
        for (const it of l.items) if (overlaps(box, it.bbox) && polylineCrossesLine(poly, it.line)) out[it.cls] = (out[it.cls] ?? 0) + 1;
        return out;
      }),
      railway: known(rail, poly, (l) => countHits(poly, l.items, (p, it) => polylineCrossesLine(p, it.line))),
      building: known(buildings, poly, (l) => countHits(poly, l.items, (p, it) => polylineHitsPolygon(p, it.rings))),
      utility: null,
    }),
  };
}
