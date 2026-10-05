// Display of railway detour service geometries (see docs/railway-detour-service-contract.md): the legs of a chosen
// detour, who the source says owns each, where the legs meet and how that was measured, the stations, and the
// connection lines and transfer passages the player drew. Read-only over an export: it changes no train, no cash, no
// disruption and no control state, and says nothing about whether a train may run there, compatibility, charges or time.

export const RAILWAY_DETOUR_VIEW_SCHEMA = "transitline.railway-detour-service-map-view/1";

// every kind has its own colour, line and glyph, so a drawing by the player cannot be mistaken for a measured fact
export const STYLES = Object.freeze({
  planLeg: { key: "plan-leg", color: "#60a5fa", width: 5, dash: [], label: "우회 구간 — 계획선 (선형 있음)" },
  existingLeg: { key: "existing-leg", color: "#a78bfa", width: 0, dash: [], glyph: "◇", label: "우회 구간 — 기존선 (선형 자료 없음, 역 위치만)" },
  station: { key: "station", color: "#f1f2f5", glyph: "◆", label: "우회가 지나는 역 (경계역은 큰 마름모, ⇄ 는 노선이 바뀌는 역)" },
  link: { key: "handover-link", color: "#9ca3af", dash: [2, 4], label: "서로 다른 두 역을 잇는 연결 (직선은 표시용, 경로가 아님)" },
  playerConnection: { key: "player-connection", color: "#fbbf24", width: 4, dash: [], label: "플레이어가 그린 연결선" },
  playerTransfer: { key: "player-transfer", color: "#f472b6", width: 3, dash: [3, 3], label: "플레이어가 그린 환승 동선" },
});
// a measured join, a measured gap and an unmeasured one look different
export const CONNECTION_STYLES = Object.freeze({
  true: { key: "joined", glyph: "●", label: "측정으로 이어짐" },
  false: { key: "apart", glyph: "✕", label: "측정으로 떨어짐" },
  null: { key: "unmeasured", glyph: "?", label: "접속 미상" },
});
export const FLAG_LABELS = Object.freeze({
  "existing-line-leg": "기존선 구간 포함", "external-alignment-unknown": "외부선 선형 자료 없음", "connection-unmeasured": "접속이 측정되지 않은 연결 있음", "connection-measured-apart": "측정으로 떨어진 연결 있음",
  "all-connections-measured-joined": "모든 연결이 측정으로 이어짐", "handover-between-different-stations": "서로 다른 두 역을 잇는 연결 있음", "infrastructure-owner-unknown": "선로 소유자 자료 없음",
  "through-route-not-supplied": "직통 경로 자료 없음", "existing-line-not-in-catalog": "기존선 식별 자료 없음", "entrance-data-missing": "출입구 자료 없음", "platform-detail-missing": "승강장 상세 자료 없음",
  "player-connection-drawn": "플레이어가 그린 연결선 있음", "player-transfer-path-drawn": "플레이어가 그린 환승 동선 있음", "player-connection-not-at-stations": "그린 연결선이 역에서 떨어져 있음",
  "operational-track-unmapped": "운행 선로구간과 연결되지 않은 구간 있음", "long-detour": "구간이 많은 우회",
});
export const REASON_LABELS = Object.freeze({
  "external-alignment-not-in-source": "외부선 선형 자료 없음", "external-topology-not-in-source": "외부선 접속 자료 없음", "owner-not-in-source-data": "선로 소유자 자료 없음", "owner-sources-disagree": "출처끼리 소유자가 다름",
  "no-through-route": "직통 경로 없음", "no-application": "운행 선로 연결 자료 없음", "application-stale": "운행 선로 연결 자료가 오래됨", "rail-geometry-not-supplied": "철도 공간 사실이 주어지지 않음",
  "no-station-site": "역 부지 자료 없음", "external-station-detail-not-in-source": "외부 철도역 상세 자료 없음", "platform-detail-not-in-source": "승강장 상세 자료 없음", "entrance-data-missing": "출입구 자료 없음",
  "walk-network-not-in-source": "보행망 자료 없음", "no-catalog": "기존선 식별 자료 없음", "line-not-in-catalog": "이 기존선의 식별 자료 없음", "end-near-station-not-on-it": "끝점이 역 가까이이나 역 위는 아님",
});
const reasonText = (code) => (code ? REASON_LABELS[code] ?? code : null);
const num = (v, digits = 0) => v.toLocaleString("en-US", { maximumFractionDigits: digits });
const count = (list) => (list === null ? null : list.length);

// exportData: a railway detour service export. picks: { "<eventId>|<detourCandidateId>": { legIds, connectionIds, transferIds } }
export function buildRailwayDetourView({ exportData, picks = {}, selectedId = null }) {
  const detours = (exportData?.detours ?? []).map((d) => {
    const chosen = picks[`${d.eventId}|${d.selectedDetourCandidateId}`] ?? {};
    const has = (list, id) => (chosen[list] ?? []).includes(id);
    const at = (id) => d.stations.find((s) => s.stationId === id)?.location ?? null;
    return {
      detourGeometryId: d.detourGeometryId, eventId: d.eventId, selected: d.detourGeometryId === selectedId, originalBoundaryStationIds: d.originalBoundaryStationIds,
      legs: d.legs.map((l) => ({
        legId: l.legId, sourceKind: l.sourceKind, style: l.alignment ? STYLES.planLeg : STYLES.existingLeg, alignment: l.alignment, fromLocation: at(l.fromStationId), toLocation: at(l.toStationId),
        infrastructureOwnerText: l.infrastructureOwnerId, infrastructureOwnerMissing: l.infrastructureOwnerId === null, picked: has("legIds", l.legId), lengthMeters: l.lengthMeters,
        missing: l.unknown.map((field) => ({ field, reason: reasonText(l.unknownReasons[field]) })),
      })),
      connections: d.connections.map((c) => ({
        connectionId: c.connectionId, kind: c.kind, style: CONNECTION_STYLES[String(c.physicalConnection)], location: c.location, viaLocations: c.viaLocations, gapMeters: c.gapMeters, picked: has("connectionIds", c.connectionId),
      })),
      stations: d.stations.map((s) => ({ stationId: s.stationId, location: s.location, boundary: s.role !== "detour-via", interchange: s.isInterchange, external: s.external, entrances: (s.entrances ?? []).map((e) => ({ entranceId: e.entranceId, location: e.location })), entrancesKnown: s.entrances !== null })),
      playerConnections: (d.playerConnections ?? []).map((p) => ({ playerConnectionId: p.playerConnectionId, polyline: p.polyline, lengthMeters: p.lengthMeters, joined: p.joinedAtBothEnds, style: STYLES.playerConnection, picked: has("connectionIds", p.playerConnectionId), name: p.name })),
      transferPaths: (d.playerTransferPaths ?? []).map((p) => ({ transferPathId: p.transferPathId, polyline: p.polyline, lengthMeters: p.lengthMeters, style: STYLES.playerTransfer, picked: has("transferIds", p.transferPathId), name: p.name })),
      transferLinks: d.transferLinks.map((t) => ({ transferLinkId: t.transferLinkId, from: at(t.fromStationId), to: at(t.toStationId), straightDistanceMeters: t.straightDistanceMeters, picked: has("transferIds", t.transferLinkId) })),
      counts: { legs: d.legs.length, connections: d.connections.length, playerConnections: count(d.playerConnections), transferPaths: count(d.playerTransferPaths) },
      infrastructureOwnerIds: d.infrastructureOwnerIds, flags: d.spatialFlags.map((flag) => ({ flag, label: FLAG_LABELS[flag] ?? flag })),
      missing: d.unknown.filter((p) => !p.includes(":")).map((field) => ({ field, reason: reasonText(d.unknownReasons[field]) })), warnings: d.warnings,
    };
  });
  return { schema: RAILWAY_DETOUR_VIEW_SCHEMA, detours, warnings: exportData?.warnings ?? [] };
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
function badge(ctx, [x, y], glyph, color, { radius = 7, filled = true, halo = false } = {}) {
  ctx.beginPath();
  ctx.arc(x, y, halo ? radius + 3 : radius, 0, Math.PI * 2);
  ctx.fillStyle = filled ? color : INK;
  ctx.fill();
  ctx.strokeStyle = halo ? TEXT : color;
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
export function drawRailwayDetourOverlay(ctx, model, screen) {
  ctx.save();
  const S = STYLES;
  for (const d of model.detours) {
    for (const l of d.legs) {
      if (l.alignment) stroke(ctx, l.alignment.map(screen), S.planLeg.color, S.planLeg.width + (d.selected ? 1 : 0), S.planLeg.dash, l.picked);
      else if (l.fromLocation) badge(ctx, screen(l.fromLocation), S.existingLeg.glyph, S.existingLeg.color, { filled: false, halo: l.picked });
      const at = l.alignment ? screen(l.alignment[0]) : l.fromLocation ? screen(l.fromLocation) : null;
      if (at) label(ctx, l.infrastructureOwnerMissing ? "소유자 자료 없음" : `소유자 ${l.infrastructureOwnerText}`, [at[0] + 10, at[1] - 12], l.infrastructureOwnerMissing ? "#9ca3af" : S.planLeg.color);
    }
    for (const t of d.transferLinks) if (t.from && t.to) stroke(ctx, [screen(t.from), screen(t.to)], S.link.color, 1.5, S.link.dash, t.picked);
    for (const p of d.playerConnections) stroke(ctx, p.polyline.map(screen), S.playerConnection.color, S.playerConnection.width, S.playerConnection.dash, p.picked);
    for (const p of d.transferPaths) stroke(ctx, p.polyline.map(screen), S.playerTransfer.color, S.playerTransfer.width, S.playerTransfer.dash, p.picked);
    for (const c of d.connections) {
      for (const p of c.location ? [c.location] : c.viaLocations ?? []) if (p) badge(ctx, screen(p), c.style.glyph, c.picked ? TEXT : "#4ade80", { radius: 5, filled: c.style.key === "joined", halo: c.picked });
    }
    for (const s of d.stations) {
      if (!s.location) continue;
      const p = screen(s.location);
      badge(ctx, p, S.station.glyph, S.station.color, { radius: s.boundary ? 9 : 6, filled: !s.external });
      if (s.interchange) label(ctx, "⇄", [p[0] + 11, p[1] + 9]);
      if (s.external) label(ctx, "기존선 역 (상세 자료 없음)", [p[0] + 11, p[1] + 9], S.existingLeg.color);
      for (const e of s.entrances) badge(ctx, screen(e.location), "·", "#9ca3af", { radius: 3 });
    }
  }
  ctx.restore();
}

// --- DOM: player-controlled text only ever goes through textContent ---
export function renderRailwayDetourPanel(container, model) {
  container.replaceChildren();
  container.hidden = model.detours.length === 0;
  if (!model.detours.length) return;
  const doc = container.ownerDocument;
  const el = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const n = (v) => (v === null ? "미상" : num(v));
  container.append(el("div", "section-label", `우회 공간 사실 ${model.detours.length}건`));
  for (const d of model.detours) {
    const block = el("div", `railway-detour${d.selected ? " selected" : ""}`);
    block.append(el("div", "detour-fact", `구간 ${d.counts.legs} · 연결 ${d.counts.connections} · 그린 연결선 ${n(d.counts.playerConnections)} · 그린 환승 동선 ${n(d.counts.transferPaths)}`));
    for (const l of d.legs) block.append(el("div", `detour-row leg ${l.style.key}${l.picked ? " picked" : ""}`, `${l.picked ? "✔ " : ""}${l.sourceKind === "external" ? "기존선" : "계획선"} 구간 · ${l.lengthMeters === null ? "길이 미상" : `${num(l.lengthMeters)} m`} · ${l.infrastructureOwnerMissing ? "소유자 자료 없음" : `소유자 ${l.infrastructureOwnerText}`}`));
    for (const c of d.connections) block.append(el("div", `detour-row connection ${c.style.key}${c.picked ? " picked" : ""}`, `${c.picked ? "✔ " : ""}${c.style.glyph} ${c.kind === "handover-link" ? "두 역을 잇는 연결" : "같은 역에서 만남"} · ${c.style.label}${c.gapMeters === null ? " · 간격 미상" : ` · 간격 ${num(c.gapMeters, 1)} m`}`));
    for (const t of d.transferLinks) block.append(el("div", `detour-row transfer${t.picked ? " picked" : ""}`, `${t.picked ? "✔ " : ""}환승 연결 · ${t.straightDistanceMeters === null ? "직선 거리 미상" : `직선 거리 ${num(t.straightDistanceMeters)} m (보행 경로 아님)`}`));
    for (const p of d.playerConnections) block.append(el("div", `detour-row player-connection${p.picked ? " picked" : ""}`, `${p.picked ? "✔ " : ""}${p.name ?? "연결선"} · 플레이어가 그림 · ${num(p.lengthMeters)} m · 역에 닿음 ${p.joined === null ? "미상" : p.joined ? "예" : "아니오"}`));
    for (const p of d.transferPaths) block.append(el("div", `detour-row player-transfer${p.picked ? " picked" : ""}`, `${p.picked ? "✔ " : ""}${p.name ?? "환승 동선"} · 플레이어가 그림 · ${num(p.lengthMeters)} m`));
    for (const f of d.flags) block.append(el("div", "diag warning", `⚠ ${f.label}`));
    for (const w of d.warnings) block.append(el("div", "diag warning", `⚠ ${w.code}`));
    container.append(block);
  }
  for (const w of model.warnings) container.append(el("div", "diag warning", `⚠ ${w.code}`));
}

export function renderRailwayDetourLegend(container) {
  container.replaceChildren();
  const doc = container.ownerDocument;
  const el = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  container.append(el("div", "section-label", "우회 범례"));
  for (const s of Object.values(STYLES)) container.append(el("div", `legend-row ${s.key}`, `${s.glyph ?? "━"} ${s.label}`));
  for (const s of Object.values(CONNECTION_STYLES)) container.append(el("div", `legend-row ${s.key}`, `연결: ${s.glyph} ${s.label}`));
  container.append(el("div", "legend-row", "지도는 접속과 위치만 말한다. 플레이어가 그린 선은 접속의 근거가 되지 않는다. ✔는 플레이어가 고른 것"));
}
