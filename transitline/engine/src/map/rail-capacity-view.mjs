// Display of rail capacity geometry (see docs/rail-capacity-geometry-contract.md): physical sections with their track
// count, how they join, block boundaries and signal position candidates, junctions, terminals and the spatial
// constraints. Read-only over an export. Nothing here says anything about throughput, timetables, cost or a verdict:
// the map shows spatial facts, and unknown (no data) is drawn differently to false (measured apart / not joined).

export const RAIL_CAPACITY_VIEW_SCHEMA = "transitline.rail-capacity-map-view/1";

// state: true = measured joined, false = measured apart, null = unknown. Three different colours, glyphs and dashes.
export const STATE_STYLES = Object.freeze({
  joined: { key: "joined", color: "#34d399", dash: [], glyph: "✓", label: "접속 확인" },
  apart: { key: "apart", color: "#f87171", dash: [], glyph: "✕", label: "떨어져 있음 확인" },
  unknown: { key: "unknown", color: "#fbbf24", dash: [4, 4], glyph: "?", label: "미확인" },
});
const styleOf = (state) => (state === true ? STATE_STYLES.joined : state === false ? STATE_STYLES.apart : STATE_STYLES.unknown);
export const SECTION_STYLES = Object.freeze({
  double: { key: "double", color: "#60a5fa", width: 6, label: "복선" },
  single: { key: "single", color: "#60a5fa", width: 3, label: "단선" },
  unknown: { key: "unknown-mode", color: "#9ca3af", width: 3, label: "단·복선 미상" },
  "no-alignment": { key: "no-alignment", color: "#9ca3af", width: 0, label: "선형 자료 없음" },
});
export const FLAG_LABELS = Object.freeze({
  "section-direction-unknown": "단·복선 미상 구간 있음",
  "external-alignment-unknown": "외부선 선형 자료 없음",
  "block-data-missing": "폐색 자료 없음",
  "junction-data-missing": "분기기 자료 없음",
  "terminal-data-missing": "종착 자료 없음",
  "revision-stale": "노선이 바뀜 (설계 재확인 필요)",
  "revision-not-recorded": "설계 기준 개정 미기록",
  "junction-separated": "분기기가 구간에서 떨어져 있음",
  "junction-attachment-unverified": "분기기 부착 미확인",
  "junction-sections-incomplete": "분기기에 연결된 구간이 일부만 지정됨",
  "crossing-without-crossing-geometry": "평면교차인데 선형이 교차하지 않음",
  "platform-not-connected": "승강장이 진입선에서 떨어져 있음",
  "platform-connection-unverified": "승강장 연결 미확인",
  "approach-not-at-terminal": "접근 구간이 종착역에 닿지 않음",
  "turnback-not-connected": "회차·유치선이 떨어져 있음",
  "turnback-connection-unverified": "회차·유치선 연결 미확인",
});
export const REASON_LABELS = Object.freeze({
  "no-block-data": "폐색 자료 없음", "no-junction-data": "분기기 자료 없음", "no-terminal-data": "종착 자료 없음",
  "design-revision-stale": "노선이 바뀌어 설계 재확인 필요", "design-revision-not-recorded": "설계 기준 개정 미기록",
  "track-count-not-stated": "단·복선 미지정", "external-track-data-not-in-source": "외부선 선로 자료 없음",
  "external-alignment-not-in-source": "외부선 선형 자료 없음", "signal-system-not-in-source": "신호방식 자료 없음",
  "endpoints-near-not-joined": "50 m 이내이나 접속 미확인", "track-profile-not-designed": "선로 종단 설계 없음",
  "no-layer": "공간 자료 없음", "outside-coverage": "자료 범위 밖", "no-platform-data": "승강장 미작도", "no-turnback-data": "회차선 미작도",
  "platform-length-not-stated": "승강장 길이 미지정", "no-through-route": "직통 경로 없음",
});
const reasonText = (code) => (code ? REASON_LABELS[code] ?? code : null);
const num = (v, digits = 0) => v.toLocaleString("en-US", { maximumFractionDigits: digits });

export function buildRailCapacityView({ exportData, selectedId = null }) {
  const designs = (exportData?.designs ?? []).map((d) => ({
    railGeometryId: d.railGeometryId, name: d.name, selected: d.railGeometryId === selectedId, revisionState: d.revision.state,
    sections: d.sections.map((s) => ({
      sectionId: s.sectionId, alignment: s.alignment, startLocation: s.startLocation, endLocation: s.endLocation, lengthMeters: s.lengthMeters,
      style: SECTION_STYLES[s.alignment ? s.directionMode ?? "unknown" : "no-alignment"],
      ends: s.ends.map((e) => ({ endpoint: e.endpoint, location: e.location, style: styleOf(e.state) })),
      blockCount: s.blockIds === null ? null : s.blockIds.length,
    })),
    boundaries: (d.blocks ?? []).filter((b) => b.endBoundary.kind === "boundary").map((b) => ({ boundaryId: b.endBoundary.boundaryId, location: b.endLocation, basis: b.endBoundary.basis })),
    signalCandidates: (d.signalCandidates ?? []).map((c) => ({ signalCandidateId: c.signalCandidateId, location: c.location, facingStationId: c.facingStationId })),
    junctions: (d.junctions ?? []).map((j) => ({
      junctionResourceId: j.junctionResourceId, kind: j.kind, location: j.location, style: styleOf(j.attachedToAllSections),
      combinationCount: j.routeCombinations.length, conflictCount: j.routeCombinations.reduce((n, c) => n + (c.conflictsWith?.length ?? 0), 0),
      conflictUnknown: j.routeCombinations.some((c) => c.conflictsWith === null),
    })),
    terminals: (d.terminals ?? []).map((t) => ({
      terminalResourceId: t.terminalResourceId, stationId: t.stationId, location: t.location,
      platforms: t.platformCandidates === null ? null : t.platformCandidates.map((p) => ({ platformCandidateId: p.platformCandidateId, polyline: p.polyline, style: styleOf(p.connected), platformLengthMeters: p.platformLengthMeters })),
      turnbacks: t.turnbackCandidates === null ? null : t.turnbackCandidates.map((p) => ({ turnbackCandidateId: p.turnbackCandidateId, kind: p.kind, polyline: p.polyline, style: styleOf(p.attached) })),
    })),
    constraints: d.sections.map((s) => ({ sectionId: s.sectionId, curve: s.minimumCurveRadiusMeters, groundGradient: s.groundGradientPermille, designedGradient: s.designedGradientPermille, structure: s.structureHint, structureBasis: s.structureHintBasis, building: s.buildingIntersectionCount, water: s.waterCrossingCount, road: s.roadCrossingCount, railway: s.existingRailwayCrossingCount })),
    flags: d.spatialFlags.map((flag) => ({ flag, label: FLAG_LABELS[flag] ?? flag })),
    missing: d.unknown.filter((p) => !p.includes(":")).map((field) => ({ field, reason: reasonText(d.unknownReasons[field]) })),
    warnings: d.warnings,
  }));
  return { schema: RAIL_CAPACITY_VIEW_SCHEMA, designs, warnings: exportData?.warnings ?? [] };
}

// --- canvas ---
const INK = "#111318";
const TEXT = "#f1f2f5";
const path = (ctx, pts) => pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
function glyph(ctx, [x, y], text, color, filled) {
  ctx.beginPath();
  ctx.arc(x, y, 7, 0, Math.PI * 2);
  ctx.fillStyle = filled ? color : INK;
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = filled ? INK : color;
  ctx.font = "bold 10px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, x, y + 0.5);
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
export function drawRailCapacityOverlay(ctx, model, screen) {
  ctx.save();
  for (const d of model.designs) {
    for (const s of d.sections) {
      if (s.alignment) {
        const pts = s.alignment.map(screen);
        ctx.strokeStyle = s.style.color;
        ctx.lineWidth = s.style.width + (d.selected ? 1 : 0);
        ctx.setLineDash(s.style.key === "unknown-mode" ? [6, 4] : []);
        ctx.beginPath();
        path(ctx, pts);
        ctx.stroke();
        if (s.style.key === "double") { // a double track reads as two lines: the middle is cut out
          ctx.strokeStyle = INK;
          ctx.lineWidth = 2;
          ctx.setLineDash([]);
          ctx.beginPath();
          path(ctx, pts);
          ctx.stroke();
        }
      } else {
        const [x, y] = screen([(s.startLocation[0] + s.endLocation[0]) / 2, (s.startLocation[1] + s.endLocation[1]) / 2]);
        label(ctx, s.style.label, [x, y], SECTION_STYLES["no-alignment"].color);
      }
      ctx.setLineDash([]);
      for (const e of s.ends) glyph(ctx, screen(e.location), e.style.glyph, e.style.color, e.style.key === "joined");
    }
    for (const b of d.boundaries) {
      const [x, y] = screen(b.location);
      ctx.strokeStyle = TEXT;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x - 6, y - 6);
      ctx.lineTo(x + 6, y + 6);
      ctx.stroke();
    }
    for (const c of d.signalCandidates) {
      const [x, y] = screen(c.location);
      ctx.fillStyle = INK;
      ctx.strokeStyle = TEXT;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.rect(x - 3, y - 11, 6, 6);
      ctx.fill();
      ctx.stroke();
    }
    for (const j of d.junctions) {
      const [x, y] = screen(j.location);
      ctx.strokeStyle = j.style.color;
      ctx.fillStyle = j.style.key === "joined" ? j.style.color : INK;
      ctx.lineWidth = 2;
      ctx.setLineDash(j.style.dash);
      ctx.beginPath();
      if (j.kind === "turnout") { ctx.moveTo(x, y - 9); ctx.lineTo(x + 8, y + 6); ctx.lineTo(x - 8, y + 6); ctx.closePath(); ctx.fill(); }
      else { ctx.moveTo(x - 8, y - 8); ctx.lineTo(x + 8, y + 8); ctx.moveTo(x + 8, y - 8); ctx.lineTo(x - 8, y + 8); }
      ctx.stroke();
      ctx.setLineDash([]);
      label(ctx, `${j.kind === "turnout" ? "분기기" : "평면교차"}${j.conflictUnknown ? " · 진로 충돌 미상" : ` · 충돌 진로쌍 ${num(j.conflictCount)}`}`, [x + 12, y], j.style.color);
    }
    for (const t of d.terminals) {
      for (const p of t.platforms ?? []) {
        ctx.strokeStyle = p.style.color;
        ctx.lineWidth = 5;
        ctx.setLineDash(p.style.dash);
        ctx.beginPath();
        path(ctx, p.polyline.map(screen));
        ctx.stroke();
      }
      for (const p of t.turnbacks ?? []) {
        ctx.strokeStyle = p.style.color;
        ctx.lineWidth = 3;
        ctx.setLineDash([2, 3].concat(p.style.dash));
        ctx.beginPath();
        path(ctx, p.polyline.map(screen));
        ctx.stroke();
      }
      ctx.setLineDash([]);
      const [x, y] = screen(t.location);
      label(ctx, `종착 · 승강장 ${t.platforms === null ? "미작도" : num(t.platforms.length)} · 회차·유치선 ${t.turnbacks === null ? "미작도" : num(t.turnbacks.length)}`, [x + 10, y - 14]);
    }
  }
  ctx.restore();
}

// --- DOM: player-controlled text (design names) only ever goes through textContent ---
export function renderRailCapacityPanel(container, model) {
  container.replaceChildren();
  container.hidden = model.designs.length === 0;
  if (!model.designs.length) return;
  const doc = container.ownerDocument;
  const el = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  container.append(el("div", "section-label", `철도 공간 사실 ${model.designs.length}건`));
  for (const d of model.designs) {
    const block = el("div", `rail-design${d.selected ? " selected" : ""}`);
    block.append(el("div", "rail-design-title", d.name ?? d.railGeometryId));
    if (d.revisionState !== "current") block.append(el("div", "diag warning", `↻ ${d.revisionState === "stale" ? "노선이 바뀜 (설계 재확인 필요)" : "설계 기준 개정 미기록"}`));
    block.append(el("div", "rail-fact", `구간 ${num(d.sections.length)}개: ${[...new Set(d.sections.map((s) => s.style.label))].join(", ")}`));
    block.append(el("div", "rail-fact", d.sections.every((s) => s.blockCount === null) ? "폐색: 미상 (폐색 자료 없음)" : `폐색 구간 ${num(d.sections.reduce((n, s) => n + (s.blockCount ?? 0), 0))}개 · 신호 후보 ${num(d.signalCandidates.length)}곳`));
    for (const j of d.junctions) block.append(el("div", "rail-fact", `${j.kind === "turnout" ? "분기기" : "평면교차"}: ${j.style.glyph} ${j.style.label}${j.conflictUnknown ? "" : ` · 충돌 진로쌍 ${num(j.conflictCount)}`}`));
    for (const t of d.terminals) block.append(el("div", "rail-fact", `종착 승강장 ${t.platforms === null ? "미상" : t.platforms.map((p) => p.style.glyph).join(" ")} · 회차·유치선 ${t.turnbacks === null ? "미상" : t.turnbacks.map((p) => p.style.glyph).join(" ")}`));
    for (const c of d.constraints) {
      block.append(el("div", `rail-fact${c.curve === null ? " missing" : ""}`, `곡선반경 ${c.curve === null ? "미상" : c.curve >= 100000 ? "직선" : `${num(c.curve)} m`} · 설계 구배 ${c.designedGradient === null ? "미상" : `${num(c.designedGradient, 1)} ‰`} · 횡단 건물 ${c.building === null ? "미상" : num(c.building)} 수역 ${c.water === null ? "미상" : num(c.water)} 도로 ${c.road === null ? "미상" : num(c.road)} 철도 ${c.railway === null ? "미상" : num(c.railway)}`));
    }
    for (const f of d.flags) block.append(el("div", "diag warning", `⚠ ${f.label}`));
    for (const w of d.warnings) block.append(el("div", "diag warning", `⚠ ${w.code}`));
    container.append(block);
  }
  for (const w of model.warnings) container.append(el("div", "diag warning", `⚠ ${w.code}`));
}

export function renderRailCapacityLegend(container) {
  container.replaceChildren();
  const doc = container.ownerDocument;
  const el = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  container.append(el("div", "section-label", "철도 공간 사실 범례"));
  for (const s of Object.values(SECTION_STYLES)) container.append(el("div", `legend-row ${s.key}`, `━ ${s.label}`));
  for (const s of Object.values(STATE_STYLES)) container.append(el("div", `legend-row ${s.key}`, `${s.glyph} ${s.label}`));
  container.append(el("div", "legend-row", "╲ 폐색 경계 · ▢ 신호 위치 후보 · △ 분기기 · ✕ 평면교차"));
  container.append(el("div", "legend-row", "굵은 선 승강장 · 점선 회차·유치선"));
}
