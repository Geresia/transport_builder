// Display of through-running handover sites (see docs/through-handover-site-contract.md): the two original legs, the
// connection the player drew, the connection state, selected turnouts, work areas and what the connection crosses.
// Read-only over a handover site export. Nothing here says anything about cost, duration, approval or a verdict:
// the map shows spatial facts only, and unknown (no data) is drawn differently to false (measured apart).
import { THROUGH_ROUTE_SCHEMA } from "./through-route.mjs";

export const THROUGH_HANDOVER_VIEW_SCHEMA = "transitline.through-handover-site-map-view/1";

// joined = true, separated = false, unknown = null: three different looks (colour, line, glyph and label).
export const CONNECTION_STYLES = Object.freeze({
  joined: { key: "joined", color: "#34d399", dash: [], glyph: "✓", label: "접속 확인" },
  separated: { key: "separated", color: "#f87171", dash: [], glyph: "✕", label: "물리적 분리 확인" },
  unknown: { key: "unknown", color: "#fbbf24", dash: [4, 4], glyph: "?", label: "접속 미확인" },
  stale: { key: "stale", color: "#a78bfa", dash: [2, 5], glyph: "↻", label: "노선 변경됨 (재확인 필요)" },
});
export const LEG_COLOR = "#60a5fa";
export const CONFLICT_KINDS = Object.freeze({
  building: { label: "건물 관통", color: "#fb923c" },
  water: { label: "수역 횡단", color: "#38bdf8" },
  road: { label: "도로 횡단", color: "#e5e7eb" },
  railway: { label: "기존 철도 횡단", color: "#c084fc" },
});
const COUNT_FIELD = { building: "buildingIntersectionCount", water: "waterCrossingCount", road: "roadCrossingCount", railway: "existingRailwayCrossingCount" };

export const FLAG_LABELS = Object.freeze({
  "no-connection-drawn": "연락선 미작도",
  "connection-separated": "접속점과 선로가 떨어져 있음",
  "connection-gap-within-near-distance": "50 m 이내 간격이 남아 있음",
  "leg-alignment-unknown": "선로 선형 자료 없음",
  "route-revision-stale": "직통 경로가 바뀜",
  "connection-through-buildings": "연락선 건물 관통",
  "connection-crosses-water": "연락선 수역 횡단",
  "connection-crosses-road": "연락선 도로 횡단",
  "connection-crosses-existing-railway": "연락선 기존 철도 횡단",
  "connection-point-away-from-leg-end": "접속점이 구간 끝에서 멂",
  "no-turnout-selected": "분기기 미선택",
  "turnout-not-on-track": "분기기가 선로 위가 아님",
  "work-area-building-overlap": "작업구역 건물 중첩",
  "work-area-water-overlap": "작업구역 수역 중첩",
});
export const REASON_LABELS = Object.freeze({
  "point-not-selected": "접속점 미선택", "not-selected": "접속점 미선택",
  "no-connection-drawn": "연락선 미작도",
  "external-alignment-not-in-source": "외부선 선형 자료 없음",
  "leg-alignment-not-in-route": "구간 선형 없음",
  "endpoints-near-not-joined": "50 m 이내이나 접속 미확인",
  "route-revision-stale": "직통 경로가 바뀌어 재확인 필요",
  "design-revision-not-recorded": "설계 기준 경로 미기록",
  "no-layer": "공간 자료 없음", "outside-coverage": "자료 범위 밖", "no-dem-value": "고도 자료 결측",
  "plan-missing": "계획 노선 없음", "zero-length-connection": "연락선 길이 0", "structure-not-stated": "구조형식 미지정",
  "track-profile-not-designed": "선로 종단 설계 없음", "work-area-not-selected": "작업구역 미선택", "no-work-area-drawn": "작업구역 미작도", "external-leg-end-not-in-source": "외부 구간 끝 위치 자료 없음",
});
const reasonText = (code) => (code ? REASON_LABELS[code] ?? code : null);

const num = (v, digits = 0) => v.toLocaleString("en-US", { maximumFractionDigits: digits });
// the point half way along a polyline (by length, in degrees: only used to place a marker)
const mid = (poly) => {
  if (!poly?.length) return null;
  let total = 0;
  const segs = poly.slice(1).map((p, i) => { const l = Math.hypot(p[0] - poly[i][0], p[1] - poly[i][1]); total += l; return l; });
  if (total === 0) return poly[0];
  let run = 0;
  for (let i = 0; i < segs.length; i++) {
    if (run + segs[i] >= total / 2) { const t = (total / 2 - run) / segs[i]; return [poly[i][0] + (poly[i + 1][0] - poly[i][0]) * t, poly[i][1] + (poly[i + 1][1] - poly[i][1]) * t]; }
    run += segs[i];
  }
  return poly.at(-1);
};

// routes: ThroughRouteGeometry v1 objects (the original legs are drawn from them); exportData: a handover site export.
// draft: { kind: "connection" | "work-area", points: [[lon,lat]...] } the player is drawing right now.
export function buildThroughHandoverView({ routes = [], exportData, selectedId = null, draft = null }) {
  const warnings = [...(exportData?.warnings ?? [])];
  const sites = (exportData?.sites ?? []).map((s) => {
    const route = routes.find((r) => r?.schema === THROUGH_ROUTE_SCHEMA && r.throughRouteId === s.throughRouteId) ?? null;
    if (!route) warnings.push({ code: "through-route-not-supplied", handoverSiteId: s.handoverSiteId });
    const stale = s.physicalConnectionEvidence.reason === "route-revision-stale";
    const state = stale ? "stale" : s.physicalConnectionEvidence.connected === true ? "joined" : s.physicalConnectionEvidence.connected === false ? "separated" : "unknown";
    const legOf = (id, side) => {
      const point = s[`${side}ConnectionPoint`];
      const leg = route?.legs.find((l) => l.legId === id) ?? null;
      return { legId: id, side, sourceKind: point.sourceKind, alignment: leg?.alignment ?? null, alignmentKnown: point.legAlignmentKnown, alignmentKind: point.legAlignmentKind, point: point.location, onLegAlignment: point.onLegAlignment };
    };
    const a = s.fromConnectionPoint.location;
    const b = s.toConnectionPoint.location;
    const joint = a && b ? [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] : a ?? b ?? s.connectionAlignment?.[0] ?? null;
    const at = mid(s.connectionAlignment) ?? joint;
    const conflicts = Object.keys(CONFLICT_KINDS).map((kind) => {
      const count = s[COUNT_FIELD[kind]];
      return { kind, label: CONFLICT_KINDS[kind].label, count, state: count === null ? "unknown" : count > 0 ? "found" : "none", at, reason: count === null ? reasonText(s.unknownReasons[COUNT_FIELD[kind]]) : null };
    });
    return {
      handoverSiteId: s.handoverSiteId, name: s.name, selected: s.handoverSiteId === selectedId, stale,
      legs: [legOf(s.fromLegId, "from"), legOf(s.toLegId, "to")],
      joint: joint ? { location: joint, state, style: CONNECTION_STYLES[state], reason: reasonText(s.physicalConnectionEvidence.reason), gapMeters: s.endpointGapMeters } : null,
      connection: s.connectionAlignment ? { alignment: s.connectionAlignment, lengthMeters: s.connectionLengthMeters, style: CONNECTION_STYLES[state] } : null,
      turnouts: s.selectedTurnoutPoints.map((t) => ({ turnoutId: t.turnoutId, location: t.location, onTrack: t.onTrack })),
      workAreas: s.workAreaCandidates.map((w) => ({ workAreaId: w.workAreaId, selected: w.workAreaId === s.selectedWorkAreaCandidateId, polygon: w.polygon, location: w.location, areaSquareMeters: w.areaSquareMeters, buildingIntersectionCount: w.buildingIntersectionCount, waterOverlapCount: w.waterOverlapCount })),
      conflicts,
      curve: { minimumRadiusMeters: s.minimumCurveRadiusMeters, reason: s.minimumCurveRadiusMeters === null ? reasonText(s.unknownReasons.minimumCurveRadiusMeters) : null },
      structure: { type: s.structureType, reason: s.structureType === null ? reasonText(s.unknownReasons.structureType) : null },
      gradient: { maximumPermille: s.maximumGradientPermille, reason: s.maximumGradientPermille === null ? reasonText(s.unknownReasons.maximumGradientPermille) : null },
      selectedWorkAreaId: s.selectedWorkAreaCandidateId,
      selectedWorkAreaReason: s.selectedWorkAreaCandidateId === null ? reasonText(s.unknownReasons.selectedWorkAreaCandidateId) : null,
      slope: { average: s.averageSlopePercent, maximum: s.maximumSlopePercent, reason: s.averageSlopePercent === null ? reasonText(s.unknownReasons.averageSlopePercent) : null },
      evidence: { connected: s.physicalConnectionEvidence.connected, reason: reasonText(s.physicalConnectionEvidence.reason), endpointGapMeters: s.endpointGapMeters, connectionLengthMeters: s.connectionLengthMeters },
      flags: s.spatialFlags.map((flag) => ({ flag, label: FLAG_LABELS[flag] ?? flag })),
      missing: s.unknown.map((field) => ({ field, reason: reasonText(s.unknownReasons[field]) })),
      warnings: s.warnings,
    };
  });
  return { schema: THROUGH_HANDOVER_VIEW_SCHEMA, sites, draft, warnings };
}

// --- canvas ---
const INK = "#111318";
const TEXT = "#f1f2f5";
const FONT = "10px Inter, system-ui, 'Malgun Gothic', sans-serif";

function path(ctx, pts) {
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
}
function badge(ctx, [x, y], glyph, color, filled = true) {
  ctx.beginPath();
  ctx.arc(x, y, 8, 0, Math.PI * 2);
  ctx.fillStyle = filled ? color : INK;
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = filled ? INK : color;
  ctx.font = "bold 11px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(glyph, x, y + 0.5);
}
function label(ctx, text, [x, y], color = TEXT) {
  ctx.font = FONT;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  ctx.lineWidth = 3;
  ctx.strokeStyle = INK;
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

// `screen` maps [lon, lat] to canvas pixels.
export function drawThroughHandoverOverlay(ctx, model, screen) {
  ctx.save();
  for (const s of model.sites) {
    // the two original legs, solid where the route knows their alignment; a leg without one is not drawn as a line
    for (const leg of s.legs) {
      if (leg.alignment) {
        ctx.strokeStyle = LEG_COLOR;
        ctx.lineWidth = s.selected ? 5 : 4;
        ctx.setLineDash([]);
        ctx.beginPath();
        path(ctx, leg.alignment.map(screen));
        ctx.stroke();
      }
    }
    for (const w of s.workAreas) {
      ctx.fillStyle = w.selected ? "rgba(52, 211, 153, 0.28)" : s.selected ? "rgba(251, 191, 36, 0.22)" : "rgba(251, 191, 36, 0.12)";
      ctx.strokeStyle = w.selected ? "#34d399" : "#fbbf24";
      ctx.lineWidth = w.selected ? 2.5 : 1.5;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      path(ctx, w.polygon.map(screen));
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
    if (s.connection) {
      ctx.strokeStyle = s.connection.style.color;
      ctx.lineWidth = s.selected ? 4 : 3;
      ctx.setLineDash(s.connection.style.dash);
      ctx.beginPath();
      path(ctx, s.connection.alignment.map(screen));
      ctx.stroke();
    }
    ctx.setLineDash([]);
    // connection points: a hollow ring when the point is not known to lie on a real alignment (unknown, not "off")
    for (const leg of s.legs) {
      if (!leg.point) continue;
      const [x, y] = screen(leg.point);
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fillStyle = leg.onLegAlignment === true ? LEG_COLOR : INK;
      ctx.fill();
      ctx.strokeStyle = leg.onLegAlignment === false ? CONNECTION_STYLES.separated.color : leg.onLegAlignment === null ? CONNECTION_STYLES.unknown.color : LEG_COLOR;
      ctx.lineWidth = 2;
      ctx.stroke();
      if (leg.onLegAlignment === null && !leg.alignmentKnown) label(ctx, "선형 자료 없음", [x + 8, y + 12], CONNECTION_STYLES.unknown.color);
    }
    for (const t of s.turnouts) {
      const [x, y] = screen(t.location);
      ctx.fillStyle = t.onTrack === false ? CONNECTION_STYLES.separated.color : t.onTrack === null ? CONNECTION_STYLES.unknown.color : TEXT;
      ctx.strokeStyle = INK;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x, y - 7); ctx.lineTo(x + 6, y); ctx.lineTo(x, y + 7); ctx.lineTo(x - 6, y); ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
    if (s.joint) {
      const [x, y] = screen(s.joint.location);
      badge(ctx, [x, y - 16], s.joint.style.glyph, s.joint.style.color, s.joint.state === "joined" || s.joint.state === "separated");
      label(ctx, `${s.name ?? "접속부"} · ${s.joint.style.label}`, [x + 12, y - 16], s.joint.style.color);
    }
    // conflicts: filled marker with the count when found, a hollow "?" when unknown; "none" draws nothing
    let row = 0;
    for (const c of s.conflicts) {
      if (c.state === "none" || !c.at) continue;
      const [x, y] = screen(c.at);
      const py = y + 14 + row * 16;
      const color = CONFLICT_KINDS[c.kind].color;
      badge(ctx, [x, py], c.state === "found" ? String(c.count) : "?", color, c.state === "found");
      label(ctx, c.state === "found" ? c.label : `${c.label} 미상`, [x + 12, py], color);
      row++;
    }
  }
  if (model.draft?.points?.length) {
    ctx.strokeStyle = TEXT;
    ctx.fillStyle = TEXT;
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 5]);
    ctx.beginPath();
    const pts = model.draft.points.map(screen);
    path(ctx, pts);
    if (model.draft.kind === "work-area" && pts.length > 2) ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);
    for (const [x, y] of pts) { ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2); ctx.fill(); }
  }
  ctx.restore();
}

// --- DOM: player-controlled text (site names) only ever goes through textContent ---
export function renderThroughHandoverPanel(container, model) {
  container.replaceChildren();
  container.hidden = model.sites.length === 0;
  if (!model.sites.length) return;
  const doc = container.ownerDocument;
  const el = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  container.append(el("div", "section-label", `직통 접속부 ${model.sites.length}곳`));
  for (const s of model.sites) {
    const block = el("div", `handover-site${s.selected ? " selected" : ""}`);
    block.append(el("div", "handover-site-title", s.name ?? s.handoverSiteId));
    const state = s.joint?.style ?? CONNECTION_STYLES.unknown;
    block.append(el("div", `diag handover-state ${state.key}`, `${state.glyph} ${state.label}${s.evidence.reason ? ` — ${s.evidence.reason}` : ""}`));
    const reasonOf = (field) => s.missing.find((m) => m.field === field)?.reason;
    const fact = (name, value, reason) => block.append(el("div", `handover-fact${value === null ? " missing" : ""}`, `${name}: ${value ?? `미상${reason ? ` (${reason})` : ""}`}`));
    fact("연락선 길이", s.evidence.connectionLengthMeters === null ? null : `${num(s.evidence.connectionLengthMeters, 1)} m`, reasonOf("connectionLengthMeters"));
    fact("단부 간격", s.evidence.endpointGapMeters === null ? null : `${num(s.evidence.endpointGapMeters, 1)} m`, reasonOf("endpointGapMeters"));
    for (const c of s.conflicts) fact(c.label, c.count === null ? null : `${num(c.count)}곳`, c.reason);
    fact("지반 경사 평균/최대", s.slope.average === null ? null : `${num(s.slope.average, 1)} / ${num(s.slope.maximum, 1)} %`, s.slope.reason);
    fact("최소 곡선반경", s.curve.minimumRadiusMeters === null ? null : s.curve.minimumRadiusMeters >= 100000 ? "직선" : `${num(s.curve.minimumRadiusMeters)} m`, s.curve.reason);
    fact("구조형식(플레이어 지정)", s.structure.type, s.structure.reason);
    fact("최대 구배(플레이어 지정)", s.gradient.maximumPermille === null ? null : `${num(s.gradient.maximumPermille, 1)} ‰`, s.gradient.reason);
    fact("선택한 작업구역", s.selectedWorkAreaId === null ? null : "선택됨", s.selectedWorkAreaReason);
    block.append(el("div", "handover-fact", `선택한 분기기: ${num(s.turnouts.length)}개 · 작업구역: ${num(s.workAreas.length)}곳`));
    for (const f of s.flags) block.append(el("div", "diag warning", `⚠ ${f.label}`));
    for (const w of s.warnings) block.append(el("div", "diag warning", `⚠ ${w.code}`));
    container.append(block);
  }
  for (const w of model.warnings) container.append(el("div", "diag warning", `⚠ ${w.code}`));
}

export function renderThroughHandoverLegend(container) {
  container.replaceChildren();
  const doc = container.ownerDocument;
  const el = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  container.append(el("div", "section-label", "직통 접속부 범례"));
  for (const s of Object.values(CONNECTION_STYLES)) container.append(el("div", `legend-row ${s.key}`, `${s.glyph} ${s.label}`));
  container.append(el("div", "legend-row", "● 접속점 (속이 빈 원: 선로 선형 자료 없음)"));
  container.append(el("div", "legend-row", "◆ 선택한 분기기"));
  for (const c of Object.values(CONFLICT_KINDS)) container.append(el("div", "legend-row", `● n ${c.label} / ? 자료 없음 (표시 없음 = 0곳 확인)`));
}
