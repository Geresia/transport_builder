// Display of rail replacement transport geometries (see docs/rail-replacement-transport-contract.md): the suspended
// range, its stations and entrances, the roadside stops, the routes / stops / turning places the player drew and how
// they meet the roads. Read-only over an export: it changes no train, no cash, no disruption and no control state,
// and says nothing about cost, running time, fleet, capacity, demand or whether a service can run.

export const RAIL_REPLACEMENT_VIEW_SCHEMA = "transitline.rail-replacement-transport-map-view/1";

// every kind has its own colour, line and glyph, so a drawing by the player cannot be mistaken for a measured fact
export const STYLES = Object.freeze({
  rail: { key: "suspended-rail", color: "#c084fc", width: 5, dash: [2, 5], glyph: "‖", label: "운휴 구간" },
  station: { key: "station", color: "#f1f2f5", glyph: "◆", label: "범위 안 역 (경계역은 큰 마름모)" },
  entrance: { key: "entrance", color: "#9ca3af", glyph: "·", label: "역 출입구" },
  derivedStop: { key: "derived-stop", color: "#38bdf8", glyph: "■", label: "출입구 인근 도로변 정류장 후보 (자료 기반)" },
  playerStop: { key: "player-stop", color: "#fbbf24", glyph: "▲", label: "플레이어가 정한 임시 정류장" },
  walk: { key: "walk", color: "#9ca3af", dash: [1, 4], label: "출입구–정류장 직선 거리 (보행 경로 아님)" },
  area: { key: "area", color: "#f472b6", label: "플레이어가 표시한 장소" },
  constraint: { key: "constraint", color: "#fb923c", glyph: "⚠", label: "플레이어가 적은 공간 제약" },
});
export const AREA_GLYPHS = Object.freeze({ turnaround: "↻", waiting: "▭", boarding: "⇅" });
export const AREA_LABELS = Object.freeze({ turnaround: "회차 장소", waiting: "대기 공간", boarding: "임시 승강 공간" });
// a drawn route is coloured by how it measures against the roads, and always says it is the player's
export const ROUTE_STYLES = Object.freeze({
  true: { key: "on-road", color: "#4ade80", dash: [], label: "플레이어 경로 — 도로 위" },
  false: { key: "off-road", color: "#f87171", dash: [8, 5], label: "플레이어 경로 — 도로에서 떨어진 구간 있음" },
  null: { key: "road-unmeasured", color: "#9ca3af", dash: [3, 4], label: "플레이어 경로 — 도로와의 관계 미측정" },
});
export const FLAG_LABELS = Object.freeze({
  "no-road-graph": "도로 자료는 연결 그래프가 아니라 경로를 만들지 않음", "road-layer-missing": "도로 자료 없음", "entrance-data-missing": "출입구 자료 없음", "external-station-detail-missing": "외부 철도역 상세 자료 없음",
  "stations-left-without-rail": "철도가 남지 않는 역 있음", "boundary-stations-joined-by-retained-rail": "경계역이 남은 철도로 이어짐", "boundary-stations-separated": "경계역이 남은 철도로는 이어지지 않음",
  "player-route-drawn": "플레이어가 그린 경로 있음", "player-route-off-road": "도로에서 떨어진 구간이 있는 경로", "player-route-road-contact-unmeasured": "도로와의 접속이 측정되지 않은 경로",
  "route-order-differs-from-rail": "경로가 지나는 역 순서가 철도와 다름", "turnaround-not-stated": "회차·대기 장소 미입력", "selected-turnback-not-at-boundary": "고른 회차 후보가 경계역이 아님",
});
export const REASON_LABELS = Object.freeze({
  "no-road-layer": "도로 자료 없음", "outside-road-coverage": "도로 자료 범위 밖", "no-station-site": "역 부지 자료 없음", "external-station-detail-not-in-source": "외부 철도역 상세 자료 없음", "no-entrance-data": "출입구 자료 없음",
  "road-width-not-in-source": "도로 폭 자료 없음", "vehicle-width-not-stated": "차량 폭 미입력", "road-graph-not-in-source": "도로 연결 그래프 자료 없음", "walk-network-not-in-source": "보행망 자료 없음",
  "no-route-stated": "그린 경로 없음", "no-constraint-data": "공간 제약 입력 없음", "no-turnaround-area-stated": "장소 입력 없음", "external-alignment-not-in-source": "외부선 선형 자료 없음",
  "near-a-road-not-on-it": "도로 가까이이나 도로 위는 아님", "endpoint-near-road-not-joined": "끝점이 도로 가까이이나 붙지 않음", "no-temporary-stop-stated": "임시 정류장 입력 없음", "rail-geometry-not-supplied": "철도 공간 사실이 주어지지 않음",
});
const reasonText = (code) => (code ? REASON_LABELS[code] ?? code : null);
const num = (v, digits = 0) => v.toLocaleString("en-US", { maximumFractionDigits: digits });
const count = (list) => (list === null ? null : list.length);
const widthText = (r) => (r.roadWidthMeters === null ? "도로 폭 자료 없음" : r.roadWidthAtLeastVehicleWidth === null ? `도로 폭 ${num(r.roadWidthMeters, 1)} m (차량 폭 미입력)` : `도로 폭 ${num(r.roadWidthMeters, 1)} m ${r.roadWidthAtLeastVehicleWidth ? "≥" : "<"} 입력 차량 폭`);

// exportData: a rail replacement transport export
export function buildRailReplacementTransportView({ exportData, selectedId = null }) {
  const replacements = (exportData?.replacements ?? []).map((r) => ({
    replacementGeometryId: r.replacementGeometryId, eventId: r.eventId, selected: r.replacementGeometryId === selectedId,
    startStationId: r.startStationId, endStationId: r.endStationId,
    suspendedAlignments: (r.railSections ?? []).filter((s) => s.alignment).map((s) => s.alignment), unmeasuredRailSections: (r.railSections ?? []).filter((s) => !s.alignment).length,
    stations: r.stations.map((s) => ({ stationId: s.stationId, location: s.location, role: s.role, boundary: s.role !== "interior", isolated: s.isolated, external: s.external, turnbackSelected: s.turnbackSelected, entrances: (s.entrances ?? []).map((e) => ({ entranceId: e.entranceId, location: e.location })), entrancesKnown: s.entrances !== null, walkLinks: count(s.walkLinks) })),
    stops: (r.stopCandidates ?? []).map((s) => ({ stopCandidateId: s.stopCandidateId, kind: s.kind, location: s.location, style: s.kind === "player-temporary" ? STYLES.playerStop : STYLES.derivedStop, name: s.name, widthText: widthText(s) })),
    walkLinks: r.stations.flatMap((s) => (s.walkLinks ?? []).map((w) => ({ walkLinkId: w.walkLinkId, from: s.entrances.find((e) => e.entranceId === w.entranceId).location, to: (r.stopCandidates ?? []).find((p) => p.stopCandidateId === w.stopCandidateId).location, meters: w.straightDistanceMeters }))),
    routes: (r.routeCandidates ?? []).map((q) => ({
      routeId: q.routeId, name: q.name, key: q.key, polyline: q.polyline, lengthMeters: q.lengthMeters, style: ROUTE_STYLES[String(q.alongRoad === null ? null : q.alongRoad.fullyOnRoad)],
      visitedStations: q.visitedStationIds.length, orderMatchesRail: q.orderMatchesRail, offRoadRuns: q.alongRoad?.offRoadRuns.length ?? null, widthText: widthText(q),
      missing: q.unknown.map((field) => ({ field, reason: reasonText(q.unknownReasons[field]) })),
    })),
    areas: (r.turnaroundAreas ?? []).map((a) => ({ turnaroundAreaId: a.turnaroundAreaId, kind: a.kind, glyph: AREA_GLYPHS[a.kind], label: AREA_LABELS[a.kind], location: a.location, polygon: a.polygon, name: a.name })),
    constraints: (r.spatialConstraints ?? []).map((c) => ({ constraintId: c.constraintId, kind: c.kind, location: c.location, value: c.value, unit: c.unit })),
    counts: { routes: count(r.routeCandidates), stops: count(r.stopCandidates), areas: count(r.turnaroundAreas), constraints: count(r.spatialConstraints) },
    flags: r.spatialFlags.map((flag) => ({ flag, label: FLAG_LABELS[flag] ?? flag })),
    missing: r.unknown.filter((p) => !p.includes(":")).map((field) => ({ field, reason: reasonText(r.unknownReasons[field]) })),
    warnings: r.warnings,
  }));
  return { schema: RAIL_REPLACEMENT_VIEW_SCHEMA, replacements, warnings: exportData?.warnings ?? [] };
}

// --- canvas ---
const INK = "#111318";
const TEXT = "#f1f2f5";
const path = (ctx, pts) => pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
function stroke(ctx, pts, color, width, dash) {
  if (pts.length < 2) return;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.setLineDash(dash);
  ctx.beginPath();
  path(ctx, pts);
  ctx.stroke();
  ctx.setLineDash([]);
}
function badge(ctx, [x, y], glyph, color, { radius = 7, filled = true } = {}) {
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fillStyle = filled ? color : INK;
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = filled ? INK : color;
  ctx.font = "bold 10px system-ui, sans-serif";
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
export function drawRailReplacementTransportOverlay(ctx, model, screen) {
  ctx.save();
  const S = STYLES;
  for (const r of model.replacements) {
    for (const a of r.suspendedAlignments) stroke(ctx, a.map(screen), S.rail.color, S.rail.width + (r.selected ? 1.5 : 0), S.rail.dash);
    for (const a of r.areas) {
      if (a.polygon) { ctx.globalAlpha = 0.2; ctx.fillStyle = S.area.color; ctx.beginPath(); path(ctx, a.polygon.map(screen)); ctx.closePath(); ctx.fill(); ctx.globalAlpha = 1; stroke(ctx, [...a.polygon, a.polygon[0]].map(screen), S.area.color, 1.5, [3, 3]); }
      badge(ctx, screen(a.location), a.glyph, S.area.color, { filled: false });
    }
    for (const q of r.routes) stroke(ctx, q.polyline.map(screen), q.style.color, 4, q.style.dash);
    for (const w of r.walkLinks) stroke(ctx, [screen(w.from), screen(w.to)], S.walk.color, 1, S.walk.dash);
    for (const s of r.stations) {
      const p = screen(s.location);
      badge(ctx, p, S.station.glyph, S.station.color, { radius: s.boundary ? 9 : 6, filled: !s.isolated });
      for (const e of s.entrances) badge(ctx, screen(e.location), S.entrance.glyph, S.entrance.color, { radius: 3, filled: true });
      if (s.turnbackSelected) label(ctx, "회차 후보 선택됨", [p[0] + 12, p[1] - 8]);
      if (s.external) label(ctx, "외부 철도역 (상세 자료 없음)", [p[0] + 12, p[1] + 8], S.rail.color);
    }
    for (const s of r.stops) { const p = screen(s.location); badge(ctx, p, s.style.glyph, s.style.color, { radius: 6, filled: s.kind !== "player-temporary" }); }
    for (const c of r.constraints) badge(ctx, screen(c.location), S.constraint.glyph, S.constraint.color, { radius: 7, filled: false });
  }
  ctx.restore();
}

// --- DOM: player-controlled text only ever goes through textContent ---
export function renderRailReplacementTransportPanel(container, model) {
  container.replaceChildren();
  container.hidden = model.replacements.length === 0;
  if (!model.replacements.length) return;
  const doc = container.ownerDocument;
  const el = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const n = (v) => (v === null ? "미상" : num(v));
  container.append(el("div", "section-label", `대체수송 공간 후보 ${model.replacements.length}건`));
  for (const r of model.replacements) {
    const block = el("div", `rail-replacement${r.selected ? " selected" : ""}`);
    block.append(el("div", "replacement-fact", `역 ${r.stations.length} · 경로 ${n(r.counts.routes)} · 정류장 ${n(r.counts.stops)} · 장소 ${n(r.counts.areas)} · 제약 ${n(r.counts.constraints)}`));
    for (const s of r.stations) block.append(el("div", `replacement-row station${s.isolated ? " isolated" : ""}`, `${STYLES.station.glyph} ${s.stationId}${s.boundary ? " (경계역)" : ""}${s.external ? " · 외부 철도역" : ""} · 출입구 ${s.entrancesKnown ? s.entrances.length : "미상"}`));
    for (const q of r.routes) block.append(el("div", `replacement-row route ${q.style.key}`, `${q.name ?? q.key ?? "경로"} · ${q.style.label} · ${num(q.lengthMeters)} m · 지나는 역 ${q.visitedStations}${q.orderMatchesRail === false ? " (순서가 철도와 다름)" : ""}${q.offRoadRuns ? ` · 떨어진 구간 ${q.offRoadRuns}` : ""} · ${q.widthText}`));
    for (const s of r.stops) block.append(el("div", `replacement-row stop ${s.style.key}`, `${s.style.glyph} ${s.style.label}${s.name ? ` ${s.name}` : ""} · ${s.widthText}`));
    for (const a of r.areas) block.append(el("div", "replacement-row area", `${a.glyph} ${a.label}${a.name ? ` ${a.name}` : ""}`));
    for (const c of r.constraints) block.append(el("div", "replacement-row constraint", `${STYLES.constraint.glyph} ${c.kind}${c.value === null ? "" : ` ${num(c.value, 1)} ${c.unit}`}`));
    for (const f of r.flags) block.append(el("div", "diag warning", `⚠ ${f.label}`));
    for (const w of r.warnings) block.append(el("div", "diag warning", `⚠ ${w.code}`));
    container.append(block);
  }
  for (const w of model.warnings) container.append(el("div", "diag warning", `⚠ ${w.code}`));
}

export function renderRailReplacementTransportLegend(container) {
  container.replaceChildren();
  const doc = container.ownerDocument;
  const el = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  container.append(el("div", "section-label", "대체수송 범례"));
  for (const s of [STYLES.rail, STYLES.station, STYLES.entrance, STYLES.derivedStop, STYLES.playerStop, STYLES.walk, STYLES.area, STYLES.constraint]) container.append(el("div", `legend-row ${s.key}`, `${s.glyph ?? "┈"} ${s.label}`));
  for (const s of Object.values(ROUTE_STYLES)) container.append(el("div", `legend-row ${s.key}`, s.label));
  container.append(el("div", "legend-row", "지도는 경로를 찾지 않는다. 그려진 경로는 플레이어의 것이고, 도로와의 관계만 측정한다"));
}
