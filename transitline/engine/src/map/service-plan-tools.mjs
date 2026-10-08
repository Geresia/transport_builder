// The pure geometry behind the service plan editor mount: which section or station of a RailCapacityGeometry a click means,
// the station list of a geometry, and the one way a value is shown so that unknown (null), "no" (false), a stated zero (0) and
// a declared empty list ([]) never look alike. It invents no fact: a point farther than the radius from every section is on none.
import { nearestOnScreenLine } from "./map-mount-kit.mjs";

export const HIT_PX = 9;
export const STATION_PX = 13;

// the line a section is drawn along: its alignment, or (an existing line known only station to station) the straight line between its ends
export const lineOf = (section) => (section.alignment ?? [section.startLocation, section.endLocation]);

// The section nearest to a click (within `radius` px).
export function hitSection(geometry, screen, point, radius = HIT_PX) {
  let best = null;
  for (const section of geometry?.sections ?? []) {
    const h = nearestOnScreenLine(lineOf(section).map(screen), point);
    if (h && h.d <= radius && (!best || h.d < best.d || (h.d === best.d && section.sectionId < best.section.sectionId))) best = { section, d: h.d };
  }
  return best ? best.section : null;
}

// every station of a geometry (the ends of its sections) with its position, in id order
export function stationsOf(geometry) {
  const out = new Map();
  for (const s of geometry?.sections ?? []) { out.set(s.fromStationId, s.startLocation); out.set(s.toStationId, s.endLocation); }
  return [...out.entries()].map(([stationId, location]) => ({ stationId, location })).sort((a, b) => (a.stationId < b.stationId ? -1 : 1));
}
export function hitStation(stations, screen, point, radius = STATION_PX) {
  let best = null;
  for (const st of stations) {
    const d = Math.hypot(...screen(st.location).map((v, i) => v - point[i]));
    if (d <= radius && (!best || d < best.d || (d === best.d && st.stationId < best.stationId))) best = { stationId: st.stationId, d };
  }
  return best ? best.stationId : null;
}

// a short readable name for an id: "stn:0123456789abcdef" -> "역 …cdef", other ids as they are
export const stationLabel = (id) => (typeof id === "string" && /^stn:[0-9a-f]{8,}$/.test(id) ? `역 …${id.slice(-4)}` : String(id));
export const sectionLabel = (id) => (typeof id === "string" && id.includes(":") ? `구간 …${id.slice(-4)}` : String(id));

// null -> "미상" (+ the reason, when the contract gave one), [] -> "없음(선언됨)", 0 -> "0", false -> "아니오", true -> "예", lists joined
export function showValue(value, reason = null, reasons = {}) {
  if (value === null || value === undefined) return reason ? `미상 (${reasons[reason] ?? reason})` : "미상";
  if (value === true) return "예";
  if (value === false) return "아니오";
  if (Array.isArray(value)) return value.length ? value.map(String).join(", ") : "없음(선언됨)";
  return String(value);
}

// "" -> undefined (not stated); "12" -> 12; anything else that is not a finite number -> NaN (the caller refuses it)
export const parseNumber = (text) => {
  const t = String(text ?? "").trim();
  return t === "" ? undefined : Number.isFinite(Number(t)) ? Number(t) : Number.NaN;
};
