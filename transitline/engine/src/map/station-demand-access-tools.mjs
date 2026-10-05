// Which thing on the map a click means, for the station access mount: entrances, access points, the station, drawn walking
// links and transfer passages, polygon outlines and insides, polygon / line vertices and the edges between them. Pure
// geometry over screen pixels and the view model (station-demand-access-view.mjs); it invents no fact and never changes a
// document: a click that is not near anything means nothing.
import { nearestOnScreenLine } from "./map-mount-kit.mjs";
import { inRing } from "./spatial.mjs";

export const POINT_PX = 10;
export const STATION_PX = 12;
export const LINE_PX = 8;
export const VERTEX_PX = 9;

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const closedRing = (pts) => [...pts, pts[0]];
const nearestPoint = (items, p, px) => {
  let best = null;
  for (const it of items) { const d = dist(it.at, p); if (d <= px && (!best || d < best.d)) best = { ...it, d }; }
  return best;
};
const nearestLine = (items, p, px) => {
  let best = null;
  for (const it of items) { const h = nearestOnScreenLine(it.pts, p); if (h && h.d <= px && (!best || h.d < best.d)) best = { ...it, d: h.d }; }
  return best;
};
// shoelace area in pixels: the smaller polygon wins when zones overlap, so a zone inside a bigger one stays clickable
const pixelArea = (pts) => Math.abs(pts.reduce((s, [x, y], i) => { const [x2, y2] = pts[(i + 1) % pts.length]; return s + (x * y2 - x2 * y); }, 0)) / 2;
const smallest = (list) => list.sort((a, b) => a.area - b.area)[0] ?? null;

// site: one entry of buildStationAccessView().sites. -> { type, key } | null
export function hitSite(site, screen, p) {
  const entrance = nearestPoint(site.entrances.map((e) => ({ type: "entrance", key: e.key, at: screen(e.location) })), p, POINT_PX);
  const point = nearestPoint(site.accessPoints.map((a) => ({ type: "access-point", key: a.key, at: screen(a.location) })), p, POINT_PX);
  const near = [entrance, point].filter(Boolean).sort((a, b) => a.d - b.d)[0];
  if (near) return { type: near.type, key: near.key };
  if (dist(screen(site.location), p) <= STATION_PX) return { type: "station", key: null };
  const lines = nearestLine([
    ...site.walkLinks.map((l) => ({ type: "walk-link", key: l.key, pts: l.alignment.map(screen) })),
    ...site.transfers.filter((t) => t.drawn).map((t) => ({ type: "transfer", key: t.key, pts: t.alignment.map(screen) })),
  ], p, LINE_PX);
  if (lines) return { type: lines.type, key: lines.key };
  const polys = [
    ...site.demandZones.map((z) => ({ type: "demand-zone", key: z.key, pts: z.polygon.map(screen) })),
    ...site.catchments.map((c) => ({ type: "catchment", key: c.key, pts: c.polygon.map(screen) })),
  ];
  const edge = nearestLine(polys.map((q) => ({ ...q, pts: closedRing(q.pts) })), p, LINE_PX);
  if (edge) return { type: edge.type, key: edge.key };
  // inside: zones before boundaries (a boundary usually encloses the zones), the smallest first
  const inside = (type) => smallest(polys.filter((q) => q.type === type && inRing(p, q.pts)).map((q) => ({ ...q, area: pixelArea(q.pts) })));
  const hit = inside("demand-zone") ?? inside("catchment");
  return hit ? { type: hit.type, key: hit.key } : null;
}

// what a walking link can end on: an entrance, an access point, the station, or the inside of a zone. -> { kind, key? } | null
export function endpointAt(site, screen, p) {
  const near = nearestPoint([
    ...site.entrances.map((e) => ({ kind: "entrance", key: e.key, at: screen(e.location) })),
    ...site.accessPoints.map((a) => ({ kind: "access-point", key: a.key, at: screen(a.location) })),
  ], p, POINT_PX);
  if (near) return { kind: near.kind, key: near.key };
  if (dist(screen(site.location), p) <= STATION_PX) return { kind: "station" };
  const zone = smallest(site.demandZones.map((z) => ({ z, pts: z.polygon.map(screen) })).filter((q) => inRing(p, q.pts)).map((q) => ({ ...q, area: pixelArea(q.pts) })));
  return zone ? { kind: "demand-zone", key: zone.z.key } : null;
}

// the index of the vertex nearest a click (within VERTEX_PX), else -1; `points` are lon/lat
export function vertexAt(points, screen, p) {
  let best = -1;
  let bestD = VERTEX_PX + 1e-9;
  points.forEach((pt, i) => { const d = dist(screen(pt), p); if (d < bestD) { best = i; bestD = d; } });
  return best;
}

// where a new vertex goes: the index to insert at when the click is on the edge between two vertices (within LINE_PX), else -1.
// closed: a polygon (the last edge returns to the first vertex); open: a line, the edges between consecutive points.
export function edgeAt(points, screen, p, closed) {
  const pts = (closed ? closedRing(points) : points).map(screen);
  const hit = pts.length > 1 ? nearestOnScreenLine(pts, p) : null;
  return hit && hit.d <= LINE_PX ? hit.segment + 1 : -1;
}

// the nearest of `stations` ({ id, location }) to a click, within STATION_PX
export function stationAt(stations, screen, p) {
  const hit = nearestPoint(stations.map((s) => ({ s, at: screen(s.location) })), p, STATION_PX);
  return hit ? hit.s : null;
}
