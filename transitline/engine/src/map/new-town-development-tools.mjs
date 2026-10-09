// The pure geometry and wording behind the new-town development editor mount: which vertex, edge, phase, station or rail line a
// click means, the stations and rail lines of a map export, and the one way a value is shown so that unknown (null), a stated
// empty list, a measured empty list and a measured 0 never look alike.  It invents no fact and computes no figure about the
// development: a click that is near nothing means nothing.
import { nearestOnScreenLine } from "./map-mount-kit.mjs";
import { inRing } from "./spatial.mjs";

export const VERTEX_PX = 9;
export const EDGE_PX = 8;
export const STATION_PX = 12;
export const RAIL_PX = 9;

const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const finitePoint = (p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite);

// the vertex of a polygon nearest to a click (within `radius` px): its index
export function hitVertex(polygon, screen, point, radius = VERTEX_PX) {
  let best = null;
  (polygon ?? []).forEach((p, index) => {
    const [x, y] = screen(p);
    const d = Math.hypot(x - point[0], y - point[1]);
    if (d <= radius && (!best || d < best.d)) best = { index, d };
  });
  return best ? best.index : null;
}

// the edge of the closed polygon nearest to a click: the position a new vertex would be inserted at (between its two ends)
export function hitEdge(polygon, screen, point, radius = EDGE_PX) {
  if (!polygon || polygon.length < 3) return null;
  const pts = polygon.map(screen);
  const h = nearestOnScreenLine([...pts, pts[0]], point);
  return h && h.d <= radius ? h.segment + 1 : null;
}

// the phase whose polygon holds a click: the one drawn last (highest in the order) wins.  `phases`: [{ key, polygon }] in drawing order.
export function hitPhase(phases, screen, point) {
  for (const phase of [...phases].reverse()) if (phase.polygon && inRing(point, phase.polygon.map(screen))) return phase;
  return null;
}

// every station of a map export (planned and existing) with its position, in kind-then-id order
export function mapStations(mapExport) {
  const out = [];
  for (const p of mapExport?.plans ?? []) for (const s of p.stationCandidates ?? []) if (finitePoint(s.location)) out.push({ stationId: String(s.id), stationKind: "plan", location: s.location, name: s.name ?? null });
  for (const n of mapExport?.externalNetworks ?? []) for (const s of n.stations ?? []) if (finitePoint(s.location)) out.push({ stationId: String(s.id), stationKind: "external", location: s.location, name: s.name ?? null });
  return out.sort((a, b) => byText(a.stationKind, b.stationKind) || byText(a.stationId, b.stationId));
}

export const refText = (ref) => (ref.planId ? `plan:${ref.planId}/${ref.segmentId ?? "*"}` : `ext:${ref.externalNetworkId ?? "*"}/${ref.externalLineId}`);
export const sameRef = (a, b) => refText(a) === refText(b);

// every rail line of a map export as a polyline (a planned segment's alignment, an existing line station to station) with the reference that names it
export function mapRailLines(mapExport) {
  const out = [];
  for (const p of mapExport?.plans ?? []) for (const s of p.segments ?? []) if (Array.isArray(s.alignment) && s.alignment.length >= 2 && s.alignment.every(finitePoint)) out.push({ ref: { planId: String(p.planId), segmentId: String(s.id) }, line: s.alignment, name: p.name ?? null });
  for (const n of mapExport?.externalNetworks ?? []) {
    const at = new Map((n.stations ?? []).map((s) => [s.id, s.location]));
    for (const l of n.lines ?? []) {
      const line = (l.stationIds ?? []).map((id) => at.get(id)).filter(finitePoint);
      if (line.length >= 2) out.push({ ref: { externalNetworkId: String(n.id), externalLineId: String(l.id) }, line, name: l.name ?? null });
    }
  }
  return out.sort((a, b) => byText(refText(a.ref), refText(b.ref)));
}

export function hitStation(stations, screen, point, radius = STATION_PX) {
  let best = null;
  for (const s of stations) {
    const [x, y] = screen(s.location);
    const d = Math.hypot(x - point[0], y - point[1]);
    if (d <= radius && (!best || d < best.d || (d === best.d && s.stationId < best.s.stationId))) best = { d, s };
  }
  return best ? best.s : null;
}
export function hitRail(lines, screen, point, radius = RAIL_PX) {
  let best = null;
  for (const l of lines) {
    const h = nearestOnScreenLine(l.line.map(screen), point);
    if (h && h.d <= radius && (!best || h.d < best.d || (h.d === best.d && refText(l.ref) < refText(best.l.ref)))) best = { d: h.d, l };
  }
  return best ? best.l : null;
}

// --- wording ---
export const LAND_USE_LABELS = Object.freeze({
  housing: "주거", employment: "업무·고용", mixed: "복합", "public-space": "공공 공간", commercial: "상업", education: "교육", civic: "공공 시설", "transport-facility": "교통 시설", utility: "기반 시설", reserved: "유보",
});
export const FLAG_LABELS = Object.freeze({
  "building-overlap": "건물과 겹침", "outside-pack-bbox": "팩 범위 밖", "overlaps-other-phase": "다른 단계와 겹침", "roads-through-area": "도로가 구역을 지남", "station-inside-area": "역이 구역 안에 있음", "water-overlap": "수역과 겹침",
});
export const REASON_LABELS = Object.freeze({
  "no-polygon": "다각형 없음", "polygon-degenerate": "다각형이 면을 이루지 않음", "polygon-self-intersecting": "다각형 변이 서로 교차", "polygon-invalid-coordinates": "좌표가 올바르지 않음",
  "no-layer": "레이어 없음", "outside-coverage": "레이어 범위 밖", "no-dem-value": "고도 값 결측", "no-station-data": "역 자료 없음", "no-planned-stations": "계획 역 없음", "no-existing-stations": "기존 역 없음",
  "no-rail-data": "선로 자료 없음", "no-demand-nodes-in-pack": "팩에 노드 기록 없음", "no-pack-bbox": "팩 범위 미기록", "not-stated": "말하지 않음", invalid: "올바르지 않은 값",
  "no-active-phase": "활성 단계 없음", "active-phase-without-polygon": "다각형 없는 활성 단계가 있음",
});
export const RELATION_LABELS = Object.freeze({
  within: "선로가 구역 안에 있음", crosses: "선로가 구역을 지남", near: "가까이 있음", "beyond-search-radius": "지정했으나 검색 반경 밖", "through-area": "도로가 구역을 지남",
});
export const WARNING_LABELS = Object.freeze({
  "new-town-doc-other-pack": "다른 팩의 저장 문서라 불러오지 않았습니다", "new-town-doc-unreadable": "저장 문서를 읽을 수 없어 불러오지 않았습니다", "new-town-doc-version": "알 수 없는 버전의 저장 문서라 불러오지 않았습니다",
  "pack-version-mismatch": "저장 문서와 팩 버전이 다릅니다", "new-town-edit-refused": "편집이 거절되었습니다", "polygon-needs-three-points": "다각형은 점이 3개 이상이어야 합니다",
  "polygon-degenerate": "다각형이 면을 이루지 않습니다", "polygon-self-intersecting": "다각형 변이 서로 교차합니다", "polygon-invalid-coordinates": "다각형 좌표가 올바르지 않습니다",
  "station-ref-missing": "오래된 참조: 지도에서 찾을 수 없는 역입니다", "station-ref-ambiguous": "오래된 참조: 같은 ID의 역이 여럿입니다", "rail-ref-missing": "오래된 참조: 지도에서 찾을 수 없는 선로입니다",
  "land-use-not-in-suggested-vocabulary": "제안 목록에 없는 용도 낱말입니다(그대로 보관)", "land-use-invalid": "용도 선언이 올바르지 않습니다", "delivery-order-not-a-positive-integer": "인도 순서는 1 이상의 정수여야 합니다",
  "location-covers-only-phases-with-polygon": "위치·경계는 다각형이 있는 단계만 덮습니다", "development-has-no-phase": "단계가 아직 없습니다", "duplicate-development": "같은 key의 개발 구역이 겹칩니다",
});

// null -> "미상" (+ the reason, when the contract gave one); true / false / numbers as they are (a measured 0 stays "0")
export function showValue(value, reason = null) {
  if (value === null || value === undefined) return reason ? `미상 (${REASON_LABELS[reason] ?? reason})` : "미상";
  if (value === true) return "예";
  if (value === false) return "아니오";
  return String(value);
}
// a list the MAP measured: [] is "none found", never "the player said none"
export function showMeasured(list, reason = null, render = String) {
  if (list === null || list === undefined) return showValue(null, reason);
  return list.length ? list.map(render).join(", ") : "없음 (측정됨)";
}
// a list the PLAYER stated: null = not stated, [] = stated that there are none
export function showDeclared(list, reason = "not-stated", render = String) {
  if (list === null || list === undefined) return showValue(null, reason);
  return list.length ? list.map(render).join(", ") : "없음 (플레이어가 없다고 선언)";
}

// "" -> undefined (not stated); "12" -> 12; anything else that is not a finite number -> NaN (the caller refuses it)
export const parseNumber = (text) => {
  const t = String(text ?? "").trim();
  return t === "" ? undefined : Number.isFinite(Number(t)) ? Number(t) : Number.NaN;
};
export const shortId = (id) => (typeof id === "string" && id.includes(":") ? `${id.split(":")[0]}:…${id.slice(-4)}` : String(id));
