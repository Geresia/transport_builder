// Display of railway disruption sites (see docs/railway-disruption-site-contract.md): the affected stretch of track,
// the event's status, whether it closes the track or limits its speed, where it is (or that nobody said), the influence
// polygon and what the stretch touches. Read-only over a site export: it changes no engine state, and says nothing about
// cost, probability, how long it lasts or whether trains can still run.

export const RAILWAY_DISRUPTION_VIEW_SCHEMA = "transitline.railway-disruption-site-map-view/1";

export const KIND_LABELS = Object.freeze({
  "vehicle-failure": "차량 고장", "signal-failure": "신호 장애", "track-obstruction": "선로 지장물", "severe-weather": "악천후", "construction-incident": "공사 사고",
});
export const STATUS_STYLES = Object.freeze({
  active: { key: "active", label: "발생 중", alpha: 1, widthFactor: 1, outline: false },
  responding: { key: "responding", label: "대응 중", alpha: 1, widthFactor: 1, outline: true },
  resolved: { key: "resolved", label: "해결됨", alpha: 0.4, widthFactor: 0.5, outline: false },
  unknown: { key: "unknown-status", label: "상태 미상", alpha: 0.7, widthFactor: 0.7, outline: false },
});
// a closed track and a speed limit are different things: different colour, line, glyph and label
export const EFFECT_STYLES = Object.freeze({
  closed: { key: "closed", color: "#f87171", width: 6, dash: [], glyph: "✕", label: "폐쇄" },
  "speed-limit": { key: "speed-limit", color: "#fb923c", width: 5, dash: [9, 5], glyph: "▼", label: "속도 제한" },
  unknown: { key: "unknown-effect", color: "#9ca3af", width: 3, dash: [3, 5], glyph: "?", label: "효과 미상" },
});
const RESOLVED_COLOR = "#9ca3af";
export const SCOPE_LABELS = Object.freeze({ section: "구간 전체", block: "해당 폐색", train: "열차" });
export const FLAG_LABELS = Object.freeze({
  "whole-section-affected": "구간 전체에 걸침", "single-block-affected": "폐색 하나에 한정", "train-position-not-in-map": "열차 위치는 지도에 없음",
  "location-unknown": "위치 미상", "location-not-on-section": "지정 위치가 구간에서 떨어져 있음", "location-outside-affected-extent": "지정 위치가 영향 범위 밖",
  "polygon-not-drawn": "영향권 미작도", "polygon-not-covering-location": "영향권이 위치를 덮지 않음", "external-alignment-unknown": "외부선 선형 자료 없음",
  "block-data-missing": "폐색 자료 없음", "no-section-link": "지도 구간과 연결되지 않음", "rail-geometry-not-current": "철도 공간 사실이 최신이 아님",
  "design-revision-stale": "철도 공간 사실이 바뀜 (재확인 필요)", "design-revision-not-recorded": "설계 기준 개정 미기록",
  "junction-affected": "분기기 포함", "signal-candidate-affected": "신호 위치 후보 포함", "station-affected": "역 포함", "terminal-approach-affected": "종착 접근 구간 포함",
});
export const REASON_LABELS = Object.freeze({
  "location-not-stated": "위치 미지정", "no-polygon-drawn": "영향권 미작도", "no-section-link": "지도 구간 연결 없음", "rail-capacity-link-stale": "구간 연결이 오래됨",
  "train-position-not-in-map": "열차 위치는 지도에 없음", "external-alignment-not-in-source": "외부선 선형 자료 없음", "no-block-data": "폐색 자료 없음",
  "no-junction-data": "분기기 자료 없음", "no-terminal-data": "종착 자료 없음", "design-revision-stale": "철도 공간 사실이 바뀌어 재확인 필요", "design-revision-not-recorded": "설계 기준 개정 미기록",
  "junction-position-unknown": "분기기 위치 미상", "location-not-on-section": "지정 위치가 구간에서 떨어져 있음", "polygon-degenerate": "영향권 모양이 올바르지 않음",
  "status-not-recognized": "상태를 알 수 없음", "effect-not-stated": "폐쇄·속도 제한 미지정", "location-not-measured": "위치 측정 안 됨",
});
const reasonText = (code) => (code ? REASON_LABELS[code] ?? code : null);
const num = (v, digits = 0) => v.toLocaleString("en-US", { maximumFractionDigits: digits });
const count = (list) => (list === null ? null : list.length);

const effectOf = (effect) => {
  if (effect === null) return { style: EFFECT_STYLES.unknown, text: EFFECT_STYLES.unknown.label };
  if (effect.closed) return { style: EFFECT_STYLES.closed, text: EFFECT_STYLES.closed.label };
  if (effect.speedLimitMps === null) return { style: EFFECT_STYLES.unknown, text: EFFECT_STYLES.unknown.label };
  return { style: EFFECT_STYLES["speed-limit"], text: `${EFFECT_STYLES["speed-limit"].label} ${num(effect.speedLimitMps * 3.6)} km/h` };
};

export function buildRailwayDisruptionView({ exportData, selectedId = null }) {
  const sites = (exportData?.sites ?? []).map((s) => {
    const effect = effectOf(s.effect);
    return {
      disruptionSiteId: s.disruptionSiteId, eventId: s.eventId, selected: s.disruptionSiteId === selectedId,
      kind: s.kind, kindLabel: KIND_LABELS[s.kind] ?? s.kind,
      status: s.status, statusStyle: STATUS_STYLES[s.status ?? "unknown"],
      effect: s.effect, effectStyle: effect.style, effectText: effect.text,
      scope: s.scope, scopeLabel: SCOPE_LABELS[s.scope],
      alignment: s.alignment, extentStart: s.affectedExtent?.startLocation ?? null, extentEnd: s.affectedExtent?.endLocation ?? null,
      location: s.location,
      // an event nobody located is not drawn at the middle of its stretch: the whole stretch is marked and the text says so
      locationText: s.location === null ? `위치 미상—${SCOPE_LABELS[s.scope]}` : null,
      polygon: s.affectedPolygon,
      affected: { sections: count(s.affectedSectionIds), blocks: count(s.affectedBlockIds), signals: count(s.affectedSignalCandidateIds), junctions: count(s.affectedJunctionResourceIds), stations: count(s.affectedStationIds), terminals: count(s.affectedTerminalResourceIds) },
      accessCandidates: count(s.alternativeAccessCandidates),
      flags: s.spatialFlags.map((flag) => ({ flag, label: FLAG_LABELS[flag] ?? flag })),
      missing: s.unknown.filter((p) => !p.includes(":")).map((field) => ({ field, reason: reasonText(s.unknownReasons[field]) })),
      warnings: s.warnings,
    };
  });
  return { schema: RAILWAY_DISRUPTION_VIEW_SCHEMA, sites, warnings: exportData?.warnings ?? [] };
}

// --- canvas ---
const INK = "#111318";
const TEXT = "#f1f2f5";
const path = (ctx, pts) => pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
function badge(ctx, [x, y], glyph, color, filled) {
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
  ctx.font = "10px Inter, system-ui, 'Malgun Gothic', sans-serif";
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
export function drawRailwayDisruptionOverlay(ctx, model, screen) {
  ctx.save();
  for (const s of model.sites) {
    const e = s.effectStyle;
    const st = s.statusStyle;
    if (s.polygon) {
      ctx.globalAlpha = st.alpha * 0.16;
      ctx.fillStyle = e.color;
      ctx.beginPath();
      path(ctx, s.polygon.map(screen));
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = st.alpha;
      ctx.strokeStyle = e.color;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 3]);
      ctx.stroke();
    }
    ctx.globalAlpha = st.alpha;
    if (s.alignment) {
      const pts = s.alignment.map(screen);
      if (st.outline) { // a site being responded to is outlined
        ctx.strokeStyle = TEXT;
        ctx.lineWidth = e.width * st.widthFactor + 4;
        ctx.setLineDash([]);
        ctx.beginPath();
        path(ctx, pts);
        ctx.stroke();
      }
      ctx.strokeStyle = e.color;
      ctx.lineWidth = (e.width + (s.selected ? 1.5 : 0)) * st.widthFactor;
      ctx.setLineDash(e.dash);
      ctx.beginPath();
      path(ctx, pts);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    const resolved = st.key === "resolved";
    if (s.location) {
      const [x, y] = screen(s.location);
      badge(ctx, [x, y], resolved ? "✓" : e.glyph, resolved ? RESOLVED_COLOR : e.color, !resolved && e.key === "closed");
      label(ctx, `${s.kindLabel} · ${st.label} · ${s.effectText}`, [x + 12, y], resolved ? RESOLVED_COLOR : e.color);
    } else if (s.extentStart) {
      // no location: mark the stretch's own start with the words, not a marker in its middle
      const [x, y] = screen(s.extentStart);
      label(ctx, `${s.kindLabel} · ${st.label} · ${s.effectText}`, [x + 10, y - 10], resolved ? RESOLVED_COLOR : e.color);
      label(ctx, `${s.locationText}${s.alignment ? "" : " · 선형 자료 없음"}`, [x + 10, y + 4], TEXT);
    }
  }
  ctx.restore();
}

// --- DOM: player-controlled text only ever goes through textContent ---
export function renderRailwayDisruptionPanel(container, model) {
  container.replaceChildren();
  container.hidden = model.sites.length === 0;
  if (!model.sites.length) return;
  const doc = container.ownerDocument;
  const el = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  container.append(el("div", "section-label", `운행 장애 ${model.sites.length}건`));
  for (const s of model.sites) {
    const block = el("div", `disruption-site${s.selected ? " selected" : ""}`);
    block.append(el("div", "disruption-title", `${s.kindLabel} · ${s.statusStyle.label}`));
    block.append(el("div", `diag disruption-effect ${s.effectStyle.key}`, `${s.effectStyle.glyph} ${s.effectText}`));
    block.append(el("div", `disruption-fact${s.location === null ? " missing" : ""}`, s.location === null ? s.locationText : `위치: 지정됨 (${s.scopeLabel} 범위)`));
    const n = (v) => (v === null ? "미상" : num(v));
    block.append(el("div", "disruption-fact", `영향 구간 ${n(s.affected.sections)} · 폐색 ${n(s.affected.blocks)} · 신호 후보 ${n(s.affected.signals)} · 분기기 ${n(s.affected.junctions)} · 역 ${n(s.affected.stations)} · 종착 ${n(s.affected.terminals)}`));
    block.append(el("div", "disruption-fact", `대체 접근 후보: ${n(s.accessCandidates)}`));
    for (const f of s.flags) block.append(el("div", "diag warning", `⚠ ${f.label}`));
    for (const w of s.warnings) block.append(el("div", "diag warning", `⚠ ${w.code}`));
    container.append(block);
  }
  for (const w of model.warnings) container.append(el("div", "diag warning", `⚠ ${w.code}`));
}

export function renderRailwayDisruptionLegend(container) {
  container.replaceChildren();
  const doc = container.ownerDocument;
  const el = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  container.append(el("div", "section-label", "운행 장애 범례"));
  for (const s of Object.values(EFFECT_STYLES)) container.append(el("div", `legend-row ${s.key}`, `${s.glyph} ${s.label}`));
  for (const s of Object.values(STATUS_STYLES)) container.append(el("div", `legend-row ${s.key}`, `상태: ${s.label}`));
  container.append(el("div", "legend-row", "위치를 모르는 사건은 영향 구간 전체를 표시하고 글자로 '위치 미상'이라 적는다"));
}
