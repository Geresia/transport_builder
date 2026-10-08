// What the service plan editor shows on the map and in the "what the map knows" part of its panel, as pure functions of a
// RailCapacityGeometry and a built service plan (service-plan-geometry.mjs). Nothing here computes anything about running
// the plan: it draws the sections the player chose in the order they chose them, the way each direction runs through them,
// where they asked trains to turn back and what the map knows (yes / no / not known) about the facility there. A value that
// is unknown is shown as unknown (a dashed "?"), never as a default; a stale plan is dimmed.
import { lineOf, sectionLabel, showValue, stationLabel, stationsOf } from "./service-plan-tools.mjs";

export const SERVICE_PLAN_VIEW_SCHEMA = "transitline.service-plan-editor-view/1";
export const COLORS = Object.freeze({ route: "#4cc9f0", stale: "#ffb703", other: "#6b7386", join: "#9ad1d4", unknown: "#aab1c0", good: "#52b788", bad: "#e5383b", amber: "#ffb703", info: "#74c0fc" });
export const DIRECTION_COLORS = Object.freeze(["#4cc9f0", "#b5e48c", "#f4a261", "#cdb4db", "#ffd6a5", "#90dbf4"]);

// how the facility facts at a turnback station are drawn: the glyph, the colour, whether the ring is dashed, and the words
export const TURNBACK_STATES = Object.freeze({
  known: { glyph: "✓", color: COLORS.good, dashed: false, text: "고른 종착 설비가 지도에 있음" },
  mismatch: { glyph: "✕", color: COLORS.bad, dashed: false, text: "고른 종착 설비가 이 역에 없음" },
  "not-picked": { glyph: "○", color: COLORS.info, dashed: true, text: "이 역에 종착 설비가 있으나 고르지 않음" },
  "none-here": { glyph: "–", color: COLORS.amber, dashed: true, text: "종착 자료에 이 역의 설비가 없음" },
  unknown: { glyph: "?", color: COLORS.unknown, dashed: true, text: "종착 자료 없음 (미상)" },
});
export const REASON_LABELS = Object.freeze({
  "track-count-not-stated": "단·복선을 지도에 적지 않음", "external-track-data-not-in-source": "기존선의 선로 자료 없음", "no-block-data": "폐색 자료 없음", "no-junction-data": "분기기 자료 없음",
  "external-alignment-not-in-source": "기존선 선형 자료 없음", "join-state-not-in-geometry": "접속을 지도에서 읽을 수 없음", "route-sections-share-no-station": "이웃 구간이 같은 역을 공유하지 않음",
  "sections-share-no-station": "이웃 구간이 같은 역을 공유하지 않음", "route-section-missing": "지도에 없는 구간이 있음", "route-not-selected": "구간을 아직 고르지 않음", "route-station-order-unknown": "역 순서를 읽을 수 없음",
  "route-station-order-ambiguous": "역 순서가 하나로 정해지지 않음", "no-terminal-data": "종착 자료 없음", "no-platform-data": "승강장 자료 없음", "no-turnback-data": "회차선 자료 없음",
  "external-station-terminal-not-in-source": "기존선 역의 종착 자료 없음", "no-terminal-selected": "종착 설비를 고르지 않음", "directions-not-stated": "방향을 적지 않음", "service-bands-not-stated": "시간대를 적지 않음",
  "turnbacks-not-stated": "회차를 적지 않음", "headway-not-stated": "배차 요청을 적지 않음", "trainsets-not-stated": "요청 편성 수를 적지 않음", "formation-cars-not-stated": "요청 량 수를 적지 않음",
  "band-direction-not-stated": "시간대의 방향을 적지 않음", "vehicleModelId-not-stated": "차량 모델을 고르지 않음", "requestedCars-not-stated": "요청 량 수를 적지 않음", "requestedTrainsets-not-stated": "요청 편성 수를 적지 않음",
  "operational-line-not-stated": "운영 노선을 연결하지 않음", "capacity-application-not-supplied": "용량 적용 결과 없음", "capacity-application-stale": "용량 적용 결과가 낡음", "planKind-not-stated": "평시/장애 대응을 고르지 않음",
  "operatingPattern-not-stated": "운행 방식을 고르지 않음", "direction-station-not-on-route": "노선 위에 없는 역", "station-not-on-route": "노선 위에 없는 역", "not-in-geometry": "지도에 값이 없음", "depot-role-not-stated": "입·출고 구분을 적지 않음",
  "depot-station-not-stated": "차량기지 연결 역을 적지 않음", "turnback-intent-not-stated": "회차 종류를 적지 않음", "section-not-in-application": "적용 결과에 없는 구간",
});
export const WARNING_LABELS = Object.freeze({
  "revision-stale": "지도가 바뀐 뒤 다시 확인하지 않음", "revision-not-recorded": "계획을 만든 지도 개정이 기록되지 않음", "application-stale": "용량 적용 결과가 현재 지도보다 낡음",
  "application-other-line-or-geometry": "다른 노선·다른 지도의 용량 적용 결과", "route-section-missing": "지도에 없는 구간이 노선에 있음", "band-time-invalid": "시간대의 분 범위가 올바르지 않아 뺐음",
  "headwayMinutes-invalid": "배차 요청 값이 올바르지 않아 비웠음", "trainsets-invalid": "요청 편성 수가 올바르지 않아 비웠음", "formationCars-invalid": "요청 량 수가 올바르지 않아 비웠음",
  "requestedCars-invalid": "요청 량 수가 올바르지 않아 비웠음", "requestedTrainsets-invalid": "요청 편성 수가 올바르지 않아 비웠음", "bands-overlap": "같은 방향의 시간대가 겹침", "band-direction-unknown": "시간대가 없는 방향을 가리킴",
  "direction-station-not-on-route": "방향의 역이 노선 위에 없음", "direction-duplicate": "같은 방향이 두 번 있음", "turnback-station-off-route": "회차역이 노선 위에 없음", "terminal-resource-not-at-station": "고른 종착 설비가 이 역에 없음",
  "route-endpoint-differs": "적은 시작·끝 역이 구간 순서와 다름", "pack-version-mismatch": "팩 버전이 다름",
});
export const reasonLabel = (code) => REASON_LABELS[code] ?? code;
export const warningLabel = (w) => WARNING_LABELS[w.code] ?? w.code;

// the middle of a lon/lat line and a point a little further along it (for an arrow), optionally walking it backwards
function midpoint(line, reversed) {
  const pts = reversed ? [...line].reverse() : line;
  const k = Math.cos((pts[0][1] * Math.PI) / 180);
  const seg = pts.slice(1).map((p, i) => Math.hypot((p[0] - pts[i][0]) * k, p[1] - pts[i][1]));
  let rest = seg.reduce((s, v) => s + v, 0) / 2;
  for (let i = 0; i < seg.length; i++) {
    if (rest <= seg[i] || i === seg.length - 1) {
      const t = seg[i] === 0 ? 0 : Math.min(1, rest / seg[i]);
      const at = [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t];
      const t2 = Math.min(1, t + 0.1);
      return { at, ahead: [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t2, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t2] };
    }
    rest -= seg[i];
  }
  return { at: pts[0], ahead: pts[0] };
}

function turnbackState(t) {
  const f = t.facilityFacts;
  if (f.terminalResourceKnown === true) return "known";
  if (f.terminalResourceKnown === false) return "mismatch";
  if (f.terminalResourceIdsAtStation === null) return "unknown";
  return f.terminalResourceIdsAtStation.length === 0 ? "none-here" : "not-picked";
}

// geometry: RailCapacityGeometry v1 (or null); planOut: one built service plan of buildServicePlanExport (or null)
export function buildServicePlanView({ geometry = null, planOut = null } = {}) {
  const banners = [];
  if (!geometry) return { schema: SERVICE_PLAN_VIEW_SCHEMA, status: "no-geometry", geometryId: null, geometryRevision: null, sections: [], stations: [], directions: [], turnbacks: [], joins: [], banners, dim: false };
  const stations = stationsOf(geometry).map((s) => ({ ...s, label: stationLabel(s.stationId), roles: [] }));
  const at = new Map(stations.map((s) => [s.stationId, s]));
  const route = planOut?.route ?? null;
  const orderOf = new Map((route?.sections ?? []).map((s) => [s.sectionId, s]));
  const onRoute = new Set(route?.sectionIds ?? []);
  const dim = planOut ? planOut.revision.state !== "current" : false;
  if (planOut) {
    if (planOut.revision.state === "stale") banners.push({ kind: "stale", text: "지도가 바뀐 뒤 다시 확인하지 않은 계획입니다. 구간과 사실은 지금 지도에서 읽었습니다." });
    if (planOut.revision.state === "not-recorded") banners.push({ kind: "not-recorded", text: "이 계획을 만든 지도 개정이 기록되지 않았습니다." });
    if (planOut.capacityApplicationState === "stale") banners.push({ kind: "application-stale", text: "연결한 용량 적용 결과가 현재 지도보다 낡았습니다. 구간별 트랙 번호는 비워 둡니다." });
    if (planOut.capacityApplicationState === null) banners.push({ kind: "application-none", text: planOut.operationalLineId === null ? "운영 노선(용량 적용 결과)을 연결하지 않았습니다." : "연결한 노선의 용량 적용 결과가 없습니다." });
    if (route?.missingSectionIds?.length) banners.push({ kind: "missing", text: `지도에 없는 구간 ${route.missingSectionIds.length}개가 노선에 있습니다.` });
  }
  const sections = geometry.sections.map((s) => ({
    sectionId: s.sectionId, line: lineOf(s), stationLevel: !s.alignment, onRoute: onRoute.has(s.sectionId), order: orderOf.get(s.sectionId)?.order ?? null,
    traversal: orderOf.get(s.sectionId)?.traversal ?? null, directionMode: s.directionMode ?? null,
  }));
  const bySection = new Map(geometry.sections.map((s) => [s.sectionId, s]));
  const directions = (planOut?.directions ?? []).map((d, i) => {
    const arrows = [];
    if (d.orderedSectionIds && d.orderedStationIds) {
      d.orderedSectionIds.forEach((id, k) => {
        const s = bySection.get(id);
        if (!s) return;
        arrows.push({ sectionId: id, ...midpoint(lineOf(s), d.orderedStationIds[k] !== s.fromStationId) });
      });
    }
    return { directionId: d.directionId, key: d.key, label: d.label, color: DIRECTION_COLORS[i % DIRECTION_COLORS.length], index: i, count: planOut.directions.length, known: Boolean(d.orderedSectionIds), reason: d.unknownReasons?.orderedSectionIds ?? null, arrows };
  });
  if (route?.fromStationId && at.has(route.fromStationId)) at.get(route.fromStationId).roles.push("시작");
  if (route?.toStationId && at.has(route.toStationId)) at.get(route.toStationId).roles.push("끝");
  const turnbacks = (planOut?.turnbacks ?? []).filter((t) => at.has(t.stationId)).map((t) => {
    const state = turnbackState(t);
    return { turnbackId: t.turnbackId, stationId: t.stationId, location: at.get(t.stationId).location, state, text: TURNBACK_STATES[state].text, intent: t.intent, position: t.position, onRoute: t.onRoute };
  });
  const joins = (route?.links ?? []).filter((l) => l.viaStationId && at.has(l.viaStationId)).map((l) => ({ stationId: l.viaStationId, location: at.get(l.viaStationId).location, state: l.physicalJoin }));
  return { schema: SERVICE_PLAN_VIEW_SCHEMA, status: planOut ? "plan" : "no-plan", geometryId: geometry.railGeometryId, geometryRevision: geometry.railGeometryRevision, sections, stations, directions, turnbacks, joins, banners, dim };
}

const chevron = (ctx, x, y, angle, size) => {
  ctx.beginPath();
  ctx.moveTo(x + Math.cos(angle) * size, y + Math.sin(angle) * size);
  ctx.lineTo(x + Math.cos(angle + 2.5) * size, y + Math.sin(angle + 2.5) * size);
  ctx.lineTo(x + Math.cos(angle - 2.5) * size, y + Math.sin(angle - 2.5) * size);
  ctx.closePath();
  ctx.fill();
};
const lineStroke = (ctx, line, screen) => { ctx.beginPath(); line.map(screen).forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.stroke(); };

export function drawServicePlanOverlay(ctx, model, screen, { hover = null } = {}) {
  if (!model || model.status === "no-geometry") return;
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const s of model.sections.filter((x) => !x.onRoute)) { ctx.strokeStyle = COLORS.other; ctx.lineWidth = 2; ctx.setLineDash(s.stationLevel ? [3, 4] : []); lineStroke(ctx, s.line, screen); }
  if (hover) { const s = model.sections.find((x) => x.sectionId === hover); if (s) { ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 3; ctx.setLineDash([]); lineStroke(ctx, s.line, screen); } }
  ctx.globalAlpha = model.dim ? 0.55 : 1;
  for (const s of model.sections.filter((x) => x.onRoute)) {
    ctx.strokeStyle = model.dim ? COLORS.stale : COLORS.route;
    ctx.lineWidth = 6;
    ctx.setLineDash(s.stationLevel ? [7, 5] : []);
    lineStroke(ctx, s.line, screen);
  }
  ctx.setLineDash([]);
  ctx.font = "bold 11px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const s of model.sections.filter((x) => x.order !== null)) {
    const [x, y] = screen(midpoint(s.line, false).at);
    ctx.fillStyle = "#101319";
    ctx.beginPath(); ctx.arc(x, y - 12, 8, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "#f1f2f5";
    ctx.fillText(String(s.order), x, y - 12);
  }
  // one chevron per direction on each section it runs through, set apart from the others so two directions do not overlap
  for (const d of model.directions) {
    ctx.fillStyle = d.color;
    for (const a of d.arrows) {
      const [x0, y0] = screen(a.at);
      const [x1, y1] = screen(a.ahead);
      const angle = Math.atan2(y1 - y0, x1 - x0);
      const off = (d.index - (d.count - 1) / 2) * 13;
      chevron(ctx, x0 - Math.sin(angle) * off, y0 + Math.cos(angle) * off, angle, 8);
    }
  }
  for (const j of model.joins) {
    const [x, y] = screen(j.location);
    ctx.fillStyle = j.state === true ? COLORS.good : j.state === false ? COLORS.bad : COLORS.unknown;
    ctx.fillText(j.state === true ? "●" : j.state === false ? "✕" : "?", x + 9, y - 9);
  }
  for (const st of model.stations) {
    const [x, y] = screen(st.location);
    ctx.fillStyle = "#f1f2f5"; ctx.strokeStyle = "#101319"; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    if (st.roles.length) { ctx.fillStyle = "#f1f2f5"; ctx.fillText(st.roles.join("·"), x, y + 14); }
  }
  for (const t of model.turnbacks) {
    const style = TURNBACK_STATES[t.state];
    const [x, y] = screen(t.location);
    ctx.strokeStyle = style.color; ctx.fillStyle = style.color; ctx.lineWidth = 2.5; ctx.setLineDash(style.dashed ? [3, 3] : []);
    ctx.beginPath(); ctx.arc(x, y, 12, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = "bold 12px system-ui, sans-serif";
    ctx.fillText(style.glyph, x, y);
  }
  ctx.restore();
}

export function renderServicePlanLegend(root, el) {
  root.replaceChildren();
  root.append(el("div", "section-label", "범례"));
  const line = (glyph, text) => root.append(el("div", "diag info", `${glyph} ${text}`));
  line("━ (번호)", "고른 구간과 고른 순서. 점선은 선형이 없는 기존선(역과 역 사이)");
  line("▶", "방향별 진행(방향마다 색이 다름)");
  line("● / ✕ / ?", "이웃 구간의 접속: 읽음 / 만나지 않음 / 지도에서 읽을 수 없음");
  for (const style of Object.values(TURNBACK_STATES)) line(style.glyph, `회차: ${style.text}`);
  line("흐림", "지도가 바뀐 뒤 다시 확인하지 않은 계획");
}

// The "what the map knows" part of the panel: one row per fact, unknown / no / zero / declared-empty told apart.
export function renderServicePlanFacts(root, el, planOut) {
  root.replaceChildren();
  if (!planOut) return;
  root.append(el("div", "section-label", "지도가 읽은 사실 (읽기만 함)"));
  const row = (text, cls = "diag info") => root.append(el("div", cls, text));
  const r = planOut.route;
  const un = (field, reasons) => showValue(null, reasons?.[field] ?? null, REASON_LABELS);
  row(`노선: 구간 ${r.sectionIds === null ? un("sectionIds", r.unknownReasons) : r.sectionIds.length} · 역 순서 ${r.stationIds === null ? un("stationIds", r.unknownReasons) : `${r.stationIds.length}개 역`} · 기존선 포함 ${r.includesExternal === null ? un("includesExternal", r.unknownReasons) : showValue(r.includesExternal)} · 지도 전체를 덮음 ${r.coversWholeGeometry === null ? un("coversWholeGeometry", r.unknownReasons) : showValue(r.coversWholeGeometry)}`);
  row(`이웃 구간이 역을 공유함 ${r.stationsShared === null ? un("stationsShared", r.unknownReasons) : showValue(r.stationsShared)} · 선로가 이어짐 ${r.physicallyJoined === null ? un("physicallyJoined", r.unknownReasons) : showValue(r.physicallyJoined)}`);
  const listText = (value, field, reasons) => (value === null ? un(field, reasons) : value.length === 0 ? "없음(선언됨)" : `${value.length}개`);
  for (const f of planOut.spatialFacts.sections) {
    const mode = f.directionMode === null ? un("directionMode", f.unknownReasons) : f.directionMode === "single" ? "단선" : "복선";
    row(`${sectionLabel(f.sectionId)}: 단·복선 ${mode} · 폐색 ${listText(f.blockIds, "blockIds", f.unknownReasons)} · 분기기 ${listText(f.junctionResourceIds, "junctionResourceIds", f.unknownReasons)} · 길이 ${f.lengthMeters === null ? un("lengthMeters", f.unknownReasons) : `${f.lengthMeters} m`}`);
  }
  for (const d of planOut.directions ?? []) row(`방향 ${d.key ?? d.directionId}: ${stationLabel(d.fromStationId)} → ${stationLabel(d.toStationId)} · ${d.orderedSectionIds === null ? un("orderedSectionIds", d.unknownReasons) : `${d.orderedSectionIds.length}개 구간`} · 이어짐 ${d.physicalConnection === null ? un("physicalConnection", d.unknownReasons) : showValue(d.physicalConnection)}`);
  for (const t of planOut.turnbacks ?? []) row(`회차 ${t.key ?? t.turnbackId}: ${stationLabel(t.stationId)} · 노선 위 ${t.onRoute === null ? un("onRoute", t.unknownReasons) : showValue(t.onRoute)} · ${TURNBACK_STATES[turnbackState(t)].text}`);
  for (const w of planOut.warnings) row(`⚠ ${warningLabel(w)}`, "diag warning");
}
