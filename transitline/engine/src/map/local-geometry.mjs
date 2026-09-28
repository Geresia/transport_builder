// Small planar geometry in a local metre frame (equirectangular around one origin), shared by the depot
// and station builders. Pure functions over [x, y] metre pairs; lon/lat only enter through frameAt().
import { bboxOf, inRing } from "./spatial.mjs";

const M_LAT = 111320;
export const frameAt = ([lon0, lat0]) => {
  const kx = M_LAT * Math.cos((lat0 * Math.PI) / 180);
  return { xy: ([lon, lat]) => [(lon - lon0) * kx, (lat - lat0) * M_LAT], ll: ([x, y]) => [lon0 + x / kx, lat0 + y / M_LAT] };
};
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
export const len = (a) => Math.hypot(a[0], a[1]);

export function nearestOnSegment(p, a, b) {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2));
  const point = [a[0] + ab[0] * t, a[1] + ab[1] * t];
  return { point, d: len(sub(p, point)) };
}
export function nearestOnPolyline(p, poly) {
  let best = null;
  for (let i = 1; i < poly.length; i++) {
    const s = nearestOnSegment(p, poly[i - 1], poly[i]);
    if (!best || s.d < best.d) best = s;
  }
  return best ?? { point: poly[0], d: len(sub(p, poly[0])) };
}
export const distPointRing = (p, ring) => (inRing(p, ring) ? 0 : nearestOnPolyline(p, [...ring, ring[0]]).d);
// the closest points of two non-overlapping polygons include a vertex of one of them
export const distRingRing = (a, b) => Math.min(...a.map((p) => distPointRing(p, b)), ...b.map((p) => distPointRing(p, a)));

export function areaAndCentroid(xy) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < xy.length; i++) {
    const [x0, y0] = xy[i];
    const [x1, y1] = xy[(i + 1) % xy.length];
    const c = x0 * y1 - x1 * y0;
    a += c; cx += (x0 + x1) * c; cy += (y0 + y1) * c;
  }
  return { area: Math.abs(a) / 2, centroid: [cx / (3 * a), cy / (3 * a)] };
}

// Deterministic sample points over a polygon (grid clipped to it), a few hundred at most.
export function gridSamples(xyRing, stepM = 50, maxSamples = 400) {
  const [x0, y0, x1, y1] = bboxOf(xyRing);
  let step = stepM;
  while (((x1 - x0) / step + 1) * ((y1 - y0) / step + 1) > maxSamples * 2) step *= 1.5;
  const pts = [];
  for (let x = x0 + step / 2; x < x1; x += step) for (let y = y0 + step / 2; y < y1; y += step) if (inRing([x, y], xyRing)) pts.push([x, y]);
  return pts.length ? pts : xyRing;
}
export function boundarySamples(xyRing) {
  const n = xyRing.length;
  const total = xyRing.reduce((s, p, i) => s + len(sub(xyRing[(i + 1) % n], p)), 0);
  const step = Math.max(25, total / 300);
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = xyRing[i], b = xyRing[(i + 1) % n];
    const k = Math.max(1, Math.ceil(len(sub(b, a)) / step));
    for (let j = 0; j < k; j++) out.push([a[0] + ((b[0] - a[0]) * j) / k, a[1] + ((b[1] - a[1]) * j) / k]);
  }
  return out;
}

export const QUALITY = ["high", "medium", "low"];
export const qualityOf = (unknownCount) => (unknownCount === 0 ? "high" : unknownCount <= 2 ? "medium" : "low");
export const worse = (a, b) => (QUALITY.indexOf(a) >= QUALITY.indexOf(b) ? a : b);
