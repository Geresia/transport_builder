// Display of railway service control candidates (see docs/railway-service-control-contract.md): the affected stretch,
// the stations where trains could turn back, the station pairs service could be suspended between, the other tracks that
// join the ends of the affected section, the places people could leave the track, and which of them the player chose.
// Read-only over a control export: it changes no train, no cash and no disruption state, and says nothing about cost,
// time, passenger loss or whether any candidate can actually be used.

export const RAILWAY_SERVICE_CONTROL_VIEW_SCHEMA = "transitline.railway-service-control-map-view/1";

// each kind of candidate has its own colour, line and glyph, so they cannot be mistaken for one another
export const CANDIDATE_STYLES = Object.freeze({
  affected: { key: "affected", color: "#f87171", width: 6, dash: [], glyph: "✕", label: "장애 영향 범위" },
  turnback: { key: "turnback", color: "#4ade80", width: 0, dash: [], glyph: "◆", label: "회차 후보" },
  suspension: { key: "suspension", color: "#c084fc", width: 5, dash: [2, 5], glyph: "‖", label: "부분운휴 경계" },
  detour: { key: "detour", color: "#60a5fa", width: 4, dash: [10, 5], glyph: "↷", label: "우회 경로" },
  evacuation: { key: "evacuation", color: "#fbbf24", width: 0, dash: [], glyph: "▲", label: "대피 접근점" },
});
export const EVACUATION_GLYPHS = Object.freeze({ station: "◉", entrance: "▣", "player-access-point": "◈", "road-point": "═" });
export const EVACUATION_LABELS = Object.freeze({ station: "역", entrance: "출입구", "player-access-point": "지정 접근점", "road-point": "가장 가까운 도로" });
// a measured join, a measured gap and an unmeasured one look different
export const ATTACHMENT_STYLES = Object.freeze({
  true: { key: "attached", label: "선로에 붙어 있음", glyph: "●" },
  false: { key: "not-attached", label: "선로와 떨어져 있음", glyph: "✕" },
  null: { key: "attachment-unknown", label: "접속 미상", glyph: "?" },
});
export const FLAG_LABELS = Object.freeze({
  "whole-section-affected": "구간 전체가 영향 범위", "single-block-affected": "폐색 하나가 영향 범위", "train-position-not-in-map": "열차 위치는 지도에 없음", "location-unknown": "장애 위치 미상",
  "partial-suspension-enumeration-limited": "부분운휴 후보는 일부만 나열됨", "detour-enumeration-limited": "우회 후보는 일부만 나열됨", "no-detour-in-geometry": "철도 공간 사실 안에 우회 경로 없음",
  "road-data-missing": "도로 자료 없음", "entrance-data-missing": "출입구 자료 없음", "terminal-data-missing": "종착·회차 시설 자료 없음", "turnback-attachment-confirmed": "선로에 붙은 회차 시설 있음",
  "single-track-section-affected": "단선 구간이 영향 범위", "double-track-section-affected": "복선 구간이 영향 범위", "track-count-unknown": "선로 수 미상", "duplicate-section-id": "같은 id의 구간이 둘 이상",
  "no-turnback-facility-stated": "회차 시설 기록 없음", "turnback-not-attached": "선로와 떨어진 회차 시설 있음", "through-route-not-supplied": "직통 경로 자료 없음", "external-alignment-unknown": "외부선 선형 자료 없음",
});
export const REASON_LABELS = Object.freeze({
  "no-terminal-data": "종착 자료 없음", "terminal-not-stated": "이 역의 종착 자료 없음", "no-platform-data": "승강장 자료 없음", "no-turnback-data": "회차 선로 자료 없음", "no-junction-data": "분기기 자료 없음",
  "attachment-not-measured": "접속이 측정되지 않음", "no-block-data": "폐색 자료 없음", "no-existing-line-in-geometry": "기존선이 철도 공간 사실에 없음", "external-alignment-not-in-source": "외부선 선형 자료 없음",
  "external-topology-not-in-source": "외부선 접속 자료 없음", "endpoints-near-not-joined": "끝점이 가까우나 붙지 않음", "owner-not-in-source-data": "선로 소유자 자료 없음", "no-through-route": "직통 경로 없음",
  "road-width-not-in-source": "도로 폭 자료 없음", "emergency-vehicle-width-not-stated": "차량 폭 미입력", "no-road-layer": "도로 자료 없음", "outside-road-coverage": "도로 자료 범위 밖",
  "disruption-position-not-in-source": "장애 위치 자료 없음", "train-position-not-in-map": "열차 위치는 지도에 없음", "no-section-link": "지도 구간과 연결되지 않음",
});
const reasonText = (code) => (code ? REASON_LABELS[code] ?? code : null);
const num = (v, digits = 0) => v.toLocaleString("en-US", { maximumFractionDigits: digits });
const count = (list) => (list === null ? null : list.length);
const widthText = (c) => (c.roadWidthMeters === null ? "도로 폭 자료 없음" : c.roadWidthAtLeastVehicleWidth === null ? `도로 폭 ${num(c.roadWidthMeters, 1)} m (차량 폭 미입력)` : `도로 폭 ${num(c.roadWidthMeters, 1)} m ${c.roadWidthAtLeastVehicleWidth ? "≥" : "<"} 입력 차량 폭`);

// exportData: a railway service control export. selections: { [eventId]: { turnback: [id], partialSuspension: [id], detour: [id], evacuation: [id] } }
export function buildRailwayServiceControlView({ exportData, selections = {}, selectedEventId = null }) {
  const controls = (exportData?.controls ?? []).map((c) => {
    const chosen = selections[c.eventId] ?? {};
    const picked = (kind, id) => (chosen[kind] ?? []).includes(id);
    return {
      controlGeometryId: c.controlGeometryId, eventId: c.eventId, selected: c.eventId === selectedEventId, scope: c.scope,
      affectedAlignment: c.affectedAlignment, disruptionLocation: c.disruptionLocation,
      locationText: c.disruptionLocation === null ? "위치 미상—영향 범위 전체" : null,
      turnbacks: (c.turnbackCandidates ?? []).map((t) => ({
        candidateId: t.candidateId, stationId: t.stationId, location: t.location, selected: picked("turnback", t.candidateId), adjacent: t.adjacentToDisruption,
        hasTerminal: t.terminalResourceId !== null, attachment: ATTACHMENT_STYLES[String(t.physicalAttachment)],
        missing: t.unknown.map((field) => ({ field, reason: reasonText(t.unknownReasons[field]) })),
      })),
      suspensions: (c.partialSuspensionCandidates ?? []).map((s) => ({
        candidateId: s.candidateId, startStationId: s.startStationId, endStationId: s.endStationId, boundaryLocations: s.geometry.boundaryLocations, selected: picked("partialSuspension", s.candidateId),
        alignments: s.geometry.sectionAlignments.filter((a) => a.alignment).map((a) => a.alignment), unmeasuredSections: s.geometry.sectionAlignments.filter((a) => !a.alignment).length,
        suspendedSections: s.suspendedSectionIds.length, isolatedStations: s.isolatedStationIds.length,
      })),
      detours: (c.detourCandidates ?? []).map((d) => ({
        candidateId: d.candidateId, alignment: d.alignment, selected: picked("detour", d.candidateId), sections: d.sectionIds.length, externalLines: d.externalLineIds.length,
        physicalConnection: d.physicalConnection, connection: ATTACHMENT_STYLES[String(d.physicalConnection)],
        missing: d.unknown.map((field) => ({ field, reason: reasonText(d.unknownReasons[field]) })),
      })),
      evacuations: (c.evacuationAccessCandidates ?? []).map((e) => ({
        candidateId: e.candidateId, kind: e.kind, kindLabel: EVACUATION_LABELS[e.kind] ?? e.kind, glyph: EVACUATION_GLYPHS[e.kind] ?? "▲", location: e.location, selected: picked("evacuation", e.candidateId),
        nearest: e.nearestOfKind === true, distanceMeters: e.distanceMeters, widthText: widthText(e), name: e.name,
      })),
      flags: c.spatialFlags.map((flag) => ({ flag, label: FLAG_LABELS[flag] ?? flag })),
      missing: c.unknown.filter((p) => !p.includes(":")).map((field) => ({ field, reason: reasonText(c.unknownReasons[field]) })),
      counts: { turnback: count(c.turnbackCandidates), partialSuspension: count(c.partialSuspensionCandidates), detour: count(c.detourCandidates), evacuation: count(c.evacuationAccessCandidates) },
      warnings: c.warnings,
    };
  });
  return { schema: RAILWAY_SERVICE_CONTROL_VIEW_SCHEMA, controls, warnings: exportData?.warnings ?? [] };
}

// --- canvas ---
const INK = "#111318";
const TEXT = "#f1f2f5";
const path = (ctx, pts) => pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
function stroke(ctx, pts, color, width, dash, halo) {
  if (pts.length < 2) return;
  ctx.setLineDash([]);
  if (halo) { ctx.strokeStyle = TEXT; ctx.lineWidth = width + 4; ctx.beginPath(); path(ctx, pts); ctx.stroke(); }
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.setLineDash(dash);
  ctx.beginPath();
  path(ctx, pts);
  ctx.stroke();
  ctx.setLineDash([]);
}
function badge(ctx, [x, y], glyph, color, { filled = true, dashed = false, halo = false } = {}) {
  ctx.beginPath();
  ctx.arc(x, y, halo ? 10 : 8, 0, Math.PI * 2);
  ctx.fillStyle = filled ? color : INK;
  ctx.fill();
  ctx.strokeStyle = halo ? TEXT : color;
  ctx.lineWidth = 2;
  ctx.setLineDash(dashed ? [3, 2] : []);
  ctx.stroke();
  ctx.setLineDash([]);
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

// `screen` maps [lon, lat] to canvas pixels. Draws only: it never calls anything that changes game state.
export function drawRailwayServiceControlOverlay(ctx, model, screen) {
  ctx.save();
  const S = CANDIDATE_STYLES;
  for (const c of model.controls) {
    // the affected stretch, under everything else (not drawn when nobody has its alignment: the panel says so)
    if (c.affectedAlignment) stroke(ctx, c.affectedAlignment.map(screen), S.affected.color, S.affected.width + (c.selected ? 1.5 : 0), [], false);
    for (const d of c.detours) if (d.alignment) stroke(ctx, d.alignment.map(screen), S.detour.color, S.detour.width + (d.selected ? 2 : 0), d.physicalConnection === false ? [2, 6] : S.detour.dash, d.selected);
    for (const s of c.suspensions) {
      if (s.selected) for (const a of s.alignments) stroke(ctx, a.map(screen), S.suspension.color, S.suspension.width + 2, S.suspension.dash, true);
      for (const p of s.boundaryLocations) badge(ctx, screen(p), S.suspension.glyph, S.suspension.color, { filled: s.selected, halo: s.selected });
    }
    for (const t of c.turnbacks) {
      const [x, y] = screen(t.location);
      // measured attached = filled, measured apart = crossed, unknown = hollow dashed ring
      badge(ctx, [x, y], t.attachment.key === "not-attached" ? "✕" : S.turnback.glyph, S.turnback.color, { filled: t.attachment.key === "attached", dashed: t.attachment.key === "attachment-unknown", halo: t.selected });
      if (t.selected) label(ctx, `${S.turnback.label} ✔`, [x + 12, y - 8], S.turnback.color);
    }
    for (const e of c.evacuations) {
      const [x, y] = screen(e.location);
      badge(ctx, [x, y], e.glyph, S.evacuation.color, { filled: e.nearest, halo: e.selected });
      if (e.selected) label(ctx, `${S.evacuation.label} ✔`, [x + 12, y + 8], S.evacuation.color);
    }
    if (c.disruptionLocation) badge(ctx, screen(c.disruptionLocation), S.affected.glyph, S.affected.color);
    else if (c.affectedAlignment) label(ctx, c.locationText, screen(c.affectedAlignment[0]).map((v, i) => v + (i ? -10 : 10)));
  }
  ctx.restore();
}

// --- DOM: player-controlled text only ever goes through textContent ---
export function renderRailwayServiceControlPanel(container, model) {
  container.replaceChildren();
  container.hidden = model.controls.length === 0;
  if (!model.controls.length) return;
  const doc = container.ownerDocument;
  const el = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const n = (v) => (v === null ? "미상" : num(v));
  container.append(el("div", "section-label", `장애 관제 후보 ${model.controls.length}건`));
  for (const c of model.controls) {
    const block = el("div", `service-control${c.selected ? " selected" : ""}`);
    block.append(el("div", "control-fact", `회차 후보 ${n(c.counts.turnback)} · 부분운휴 후보 ${n(c.counts.partialSuspension)} · 우회 후보 ${n(c.counts.detour)} · 대피 접근점 ${n(c.counts.evacuation)}`));
    if (c.locationText) block.append(el("div", "control-fact missing", c.locationText));
    for (const t of c.turnbacks) block.append(el("div", `control-row turnback${t.selected ? " selected" : ""}`, `${t.selected ? "✔ " : ""}${CANDIDATE_STYLES.turnback.glyph} 회차 ${t.stationId}${t.adjacent ? " (장애 구간 끝)" : ""} · ${t.attachment.glyph} ${t.attachment.label}${t.hasTerminal ? "" : " · 종착 자료 없음"}`));
    for (const s of c.suspensions) block.append(el("div", `control-row suspension${s.selected ? " selected" : ""}`, `${s.selected ? "✔ " : ""}${CANDIDATE_STYLES.suspension.glyph} ${s.startStationId} ~ ${s.endStationId} · 구간 ${s.suspendedSections}${s.unmeasuredSections ? ` (선형 미상 ${s.unmeasuredSections})` : ""} · 고립 역 ${s.isolatedStations}`));
    for (const d of c.detours) block.append(el("div", `control-row detour${d.selected ? " selected" : ""}`, `${d.selected ? "✔ " : ""}${CANDIDATE_STYLES.detour.glyph} 우회 구간 ${d.sections} · 기존선 ${d.externalLines} · 접속 ${d.connection.glyph} ${d.connection.label}${d.alignment ? "" : " · 선형 미상"}`));
    for (const e of c.evacuations) block.append(el("div", `control-row evacuation${e.selected ? " selected" : ""}`, `${e.selected ? "✔ " : ""}${e.glyph} ${e.kindLabel}${e.name ? ` ${e.name}` : ""}${e.nearest ? " (종류별 가장 가까움)" : ""} · ${e.distanceMeters === null ? "거리 미상" : `${num(e.distanceMeters)} m`} · ${e.widthText}`));
    for (const f of c.flags) block.append(el("div", "diag warning", `⚠ ${f.label}`));
    for (const w of c.warnings) block.append(el("div", "diag warning", `⚠ ${w.code}`));
    container.append(block);
  }
  for (const w of model.warnings) container.append(el("div", "diag warning", `⚠ ${w.code}`));
}

export function renderRailwayServiceControlLegend(container) {
  container.replaceChildren();
  const doc = container.ownerDocument;
  const el = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  container.append(el("div", "section-label", "장애 관제 후보 범례"));
  for (const s of Object.values(CANDIDATE_STYLES)) container.append(el("div", `legend-row ${s.key}`, `${s.glyph} ${s.label}`));
  for (const s of Object.values(ATTACHMENT_STYLES)) container.append(el("div", `legend-row ${s.key}`, `회차 시설: ${s.glyph} ${s.label}`));
  container.append(el("div", "legend-row", "후보는 선택지이며 지도는 후보의 우열을 말하지 않는다. ✔는 플레이어가 고른 후보"));
}
