// The pure geometry behind the rail capacity design mount: which section, station or point of a built rail design a click
// means, and how far along a section a click is. Everything works on a RailCapacityGeometry export (sections with their
// alignment, stations at their ends) and a screen projection; it invents no fact: a section without an alignment cannot
// be clicked, and a point farther than the radius from every section is not on any.
import { nearestOnScreenLine } from "./map-mount-kit.mjs";

export const HIT_PX = 10;
export const STATION_PX = 14;
export const MIN_ALONG_METERS = 1;

// the reference of a section as the editor and the builder key it: a plan segment, or an existing line's station pair
export const sectionRefOf = (s) => (s.planId ? { planId: s.planId, segmentId: s.segmentId } : { externalLineId: s.externalLineId, fromStationId: s.fromStationId, toStationId: s.toStationId });

// metres of a lon/lat polyline, flat around its own latitude (the same planar measure the rail capacity builder uses for blocks)
function metres(poly) {
  const kx = Math.cos((poly[0][1] * Math.PI) / 180) * 111320;
  const seg = poly.slice(1).map((p, i) => Math.hypot((p[0] - poly[i][0]) * kx, (p[1] - poly[i][1]) * 110540));
  return { seg, total: seg.reduce((s, v) => s + v, 0) };
}

// The section of a design nearest to a click (within `radius` px): the section, where on it, and that point as lon/lat.
export function hitSection(design, screen, point, radius = HIT_PX) {
  let best = null;
  for (const section of design?.sections ?? []) {
    if (!section.alignment) continue;
    const h = nearestOnScreenLine(section.alignment.map(screen), point);
    if (h && h.d <= radius && (!best || h.d < best.d)) best = { section, d: h.d, segment: h.segment, t: h.t };
  }
  if (!best) return null;
  const a = best.section.alignment[best.segment];
  const b = best.section.alignment[best.segment + 1];
  const location = [a[0] + (b[0] - a[0]) * best.t, a[1] + (b[1] - a[1]) * best.t];
  // distance along the section's own length, measured from its `fromStationId` end
  const { seg, total } = metres(best.section.alignment);
  const planar = seg.slice(0, best.segment).reduce((s, v) => s + v, 0) + seg[best.segment] * best.t;
  const alongMeters = total === 0 ? 0 : Math.round(((planar / total) * best.section.lengthMeters) * 10) / 10;
  return { section: best.section, ref: sectionRefOf(best.section), location, alongMeters, distancePx: best.d };
}

// every station of a design (the ends of its sections) with its position
export function stationsOf(design) {
  const out = new Map();
  for (const s of design?.sections ?? []) { out.set(s.fromStationId, s.startLocation); out.set(s.toStationId, s.endLocation); }
  return [...out.entries()].map(([stationId, location]) => ({ stationId, location })).sort((a, b) => (a.stationId < b.stationId ? -1 : 1));
}
export function hitStation(design, screen, point, radius = STATION_PX) {
  let best = null;
  for (const st of stationsOf(design)) {
    const d = Math.hypot(...screen(st.location).map((v, i) => v - point[i]));
    if (d <= radius && (!best || d < best.d)) best = { ...st, d };
  }
  return best ? { stationId: best.stationId, location: best.location } : null;
}
// the click moved onto the nearest section (within the radius), else left where it is: a junction can be placed off any track,
// and the builder then measures it as not attached
export function snapToSections(design, screen, point, lonLat, radius = HIT_PX) {
  const hit = hitSection(design, screen, point, radius);
  return hit ? hit.location : lonLat(point[0], point[1]);
}
// the sections that reach a station: where a terminal's platform track can come in from
export const sectionsAtStation = (design, stationId) => (design?.sections ?? []).filter((s) => s.fromStationId === stationId || s.toStationId === stationId);

// where a block boundary click goes in the editor's own terms: measured from the section's `fromStationId`, strictly inside it
export function boundaryOf(hit) {
  const len = hit.section.lengthMeters;
  if (!(len > 2 * MIN_ALONG_METERS) || hit.alongMeters < MIN_ALONG_METERS || hit.alongMeters > len - MIN_ALONG_METERS) return null;
  return { ...hit.ref, measuredFromStationId: hit.section.fromStationId, alongMeters: hit.alongMeters, basis: "player" };
}
