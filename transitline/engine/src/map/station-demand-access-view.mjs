// Display of station demand / access sites (see docs/station-demand-access-contract.md and docs/b15-m2-station-access-mount-2026-10-05.md):
// the station, its entrances and walking access points, the walking links the player drew, transfer passages, the access
// boundaries and the living-area zones, with the spatial facts the builder measured and what it could not know. Read-only over
// a site export: it changes no engine state and never says how many people come, what they pay, how crowded it is, how long
// a walk takes or how good a station is — only places, lengths in metres and counts of things on the map.

export const STATION_ACCESS_VIEW_SCHEMA = "transitline.station-demand-access-map-view/1";

export const STATION_KIND_LABELS = Object.freeze({ plan: "계획 역", external: "기존 역", free: "새 역" });
export const POINT_KIND_LABELS = Object.freeze({ street: "거리", crossing: "횡단 지점", plaza: "광장", "bus-stop": "정류장", other: "기타" });
export const POINT_GLYPHS = Object.freeze({ street: "길", crossing: "횡", plaza: "광", "bus-stop": "정", other: "·", unknown: "?" });
export const ZONE_KIND_LABELS = Object.freeze({ residential: "주거", employment: "업무", mixed: "혼합", school: "학교", visitor: "방문", other: "기타" });
export const ZONE_COLORS = Object.freeze({ residential: "#86efac", employment: "#93c5fd", mixed: "#fde68a", school: "#f9a8d4", visitor: "#fdba74", other: "#d1d5db", unknown: "#9ca3af" });
export const QUALITY_LABELS = Object.freeze({ high: "높음", medium: "중간", low: "낮음" });
export const ELEMENT_LABELS = Object.freeze({ entrance: "출입구", "access-point": "접근점", "walk-link": "보행 연결", transfer: "환승 통로", catchment: "접근권 경계", "demand-zone": "수요 구역", station: "역" });
export const FLAG_LABELS = Object.freeze({
  "no-entrance-drawn": "출입구를 아직 그리지 않음", "entrance-inside-building": "건물 위에 놓인 출입구가 있음", "no-catchment-drawn": "접근권 경계를 아직 그리지 않음",
  "catchment-excludes-station": "역을 포함하지 않는 경계가 있음", "no-demand-zone-drawn": "수요 구역을 아직 그리지 않음", "demand-zone-without-walk-link": "보행 연결이 없는 수요 구역이 있음",
  "access-point-without-walk-link": "보행 연결이 없는 접근점이 있음", "walk-through-buildings": "건물을 지나는 보행선이 있음", "walk-crosses-river": "하천을 건너는 보행선이 있음",
  "walk-crosses-railway": "철도를 건너는 보행선이 있음", "external-station-locations-coarse": "기존 역 위치가 거침 (시구 중심)",
  "inside-building": "건물 위", "in-water": "물 위", "excludes-station": "역이 경계 밖", "excludes-own-entrance": "기준 출입구가 경계 밖", "no-demand-node-inside": "안에 수요 노드 없음", "no-walk-link-drawn": "그려진 보행 연결 없음",
});
export const REASON_LABELS = Object.freeze({
  "no-layer": "해당 자료 없음", "outside-coverage": "자료 범위 밖", "no-connection": "연결한 역 없음", "connection-unresolved": "연결한 역을 찾지 못함", "not-provided": "지정 안 함",
  "no-dataset": "어느 팩에도 자료 없음", "no-demand-nodes-supplied": "수요 노드 목록 없음", "pack-has-no-demand-nodes": "팩에 수요 노드 없음", "no-source-supplied": "수요 출처 정보 없음",
  "no-entrance": "출입구 없음", "not-stated-in-file": "파일에 적혀 있지 않음", "not-assessed": "품질 미평가", "width-invalid": "폭 값이 올바르지 않음", unspecified: "이유 미상",
});
const reasonText = (code) => (code ? REASON_LABELS[code] ?? code : null);
const num = (v, digits = 0) => v.toLocaleString("en-US", { maximumFractionDigits: digits });
const orUnknown = (v, fn = num) => (v === null || v === undefined ? "미상" : fn(v));
const total = (road) => (road === null || road === undefined ? null : Object.values(road).reduce((s, v) => s + v, 0));
const crossText = (c) => `하천 ${orUnknown(c.river)} · 도로 ${orUnknown(total(c.road))} · 철도 ${orUnknown(c.railway)} · 건물 ${orUnknown(c.building)}`;

// selection: { stationAccessId, type, key } of what the player picked; the view marks it.
export function buildStationAccessView({ exportData, selection = null }) {
  const sites = (exportData?.sites ?? []).map((s) => {
    const mine = Boolean(selection && s.stationAccessId === selection.stationAccessId);
    const pick = (type, key) => mine && selection.type === type && selection.key === key;
    return {
      stationAccessId: s.stationAccessId, selected: mine, name: s.name, kind: s.stationKind, kindLabel: STATION_KIND_LABELS[s.stationKind] ?? s.stationKind, location: s.location,
      stationPicked: mine && selection.type === "station",
      entrances: s.entrances.map((e) => ({ id: e.entranceId, key: e.key, name: e.name, location: e.location, picked: pick("entrance", e.key), blocked: e.insideBuildingCount > 0 || e.insideWaterCount > 0 })),
      accessPoints: s.accessPoints.map((p) => ({ id: p.accessPointId, key: p.key, name: p.name, location: p.location, kind: p.kind, picked: pick("access-point", p.key) })),
      walkLinks: s.walkLinks.map((l) => ({ id: l.walkLinkId, key: l.key, name: l.name, alignment: l.alignment, throughBuildings: l.crossings.building > 0, picked: pick("walk-link", l.key) })),
      transfers: s.transfers.map((t) => ({ id: t.transferId, key: t.targetStationId, alignment: t.alignment, drawn: t.basis === "player-passage", name: t.targetName, picked: pick("transfer", t.targetStationId) })),
      catchments: s.catchments.map((c) => ({ id: c.catchmentId, key: c.key, name: c.name, polygon: c.polygon, scope: c.scope, picked: pick("catchment", c.key) })),
      demandZones: s.demandZones.map((z) => ({ id: z.demandZoneId, key: z.key, name: z.name, kind: z.kind, polygon: z.polygon, centroid: z.centroid, picked: pick("demand-zone", z.key) })),
      sources: s.demandSourceRefs === null ? null : s.demandSourceRefs.map((r) => ({ file: r.file, kind: r.kind, resolution: r.spatialResolution, quality: r.quality, qualityLabel: QUALITY_LABELS[r.quality] ?? "미평가" })),
      flags: s.spatialFlags.map((flag) => ({ flag, label: FLAG_LABELS[flag] ?? flag })),
      missing: s.unknown.filter((p) => !p.includes(":")).map((field) => ({ field, reason: reasonText(s.unknownReasons[field]) })),
      dataQuality: s.dataQuality, qualityLabel: QUALITY_LABELS[s.dataQuality] ?? s.dataQuality, warnings: s.warnings, site: s,
    };
  });
  return { schema: STATION_ACCESS_VIEW_SCHEMA, sites, warnings: exportData?.warnings ?? [], overlaps: exportData?.catchmentOverlaps ?? [] };
}

// --- canvas ---
const INK = "#111318";
const TEXT = "#f1f2f5";
const CATCH = "#4cc9f0";
const LINK = "#f1f2f5";
const XFER = "#c084fc";
const WARN = "#fb923c";
const path = (ctx, pts) => pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
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
function marker(ctx, [x, y], shape, glyph, color, picked, filled = false) {
  ctx.beginPath();
  if (shape === "circle") ctx.arc(x, y, 8, 0, Math.PI * 2);
  else if (shape === "square") ctx.rect(x - 7, y - 7, 14, 14);
  else { ctx.moveTo(x, y - 9); ctx.lineTo(x + 9, y); ctx.lineTo(x, y + 9); ctx.lineTo(x - 9, y); ctx.closePath(); }
  ctx.fillStyle = filled ? color : INK;
  ctx.fill();
  ctx.strokeStyle = picked ? TEXT : color;
  ctx.lineWidth = picked ? 3 : 2;
  ctx.setLineDash([]);
  ctx.stroke();
  ctx.fillStyle = filled ? INK : color;
  ctx.font = "bold 10px system-ui, 'Malgun Gothic', sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(glyph, x, y + 0.5);
}
function polygon(ctx, pts, color, alpha, dash, picked) {
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  ctx.beginPath();
  path(ctx, pts);
  ctx.closePath();
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = picked ? TEXT : color;
  ctx.lineWidth = picked ? 3 : 1.5;
  ctx.setLineDash(dash);
  ctx.stroke();
  ctx.setLineDash([]);
}
function line(ctx, pts, color, width, dash, picked) {
  if (picked) { ctx.strokeStyle = TEXT; ctx.lineWidth = width + 3; ctx.setLineDash([]); ctx.beginPath(); path(ctx, pts); ctx.stroke(); }
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.setLineDash(dash);
  ctx.beginPath();
  path(ctx, pts);
  ctx.stroke();
  ctx.setLineDash([]);
}

// `screen` maps [lon, lat] to canvas pixels. Order: boundaries and zones underneath, then lines, then the points on top.
export function drawStationAccessOverlay(ctx, model, screen) {
  ctx.save();
  for (const s of model.sites) {
    for (const c of s.catchments) {
      polygon(ctx, c.polygon.map(screen), CATCH, 0.1, c.scope === "entrance" ? [2, 4] : [8, 4], c.picked);
      const [x, y] = screen(c.polygon[0]);
      label(ctx, `${c.scope === "entrance" ? "출입구 경계" : "접근권 경계"}${c.name ? ` · ${c.name}` : ""}`, [x + 6, y - 8], CATCH);
    }
    for (const z of s.demandZones) {
      const color = ZONE_COLORS[z.kind ?? "unknown"];
      polygon(ctx, z.polygon.map(screen), color, 0.22, z.kind === null ? [3, 3] : [], z.picked);
      const [cx, cy] = screen(z.centroid);
      label(ctx, `${z.kind === null ? "종류 미지정" : ZONE_KIND_LABELS[z.kind]} 수요 구역${z.name ? ` · ${z.name}` : ""}`, [cx - 28, cy], color);
    }
    for (const t of s.transfers) line(ctx, t.alignment.map(screen), XFER, t.drawn ? 3 : 1.5, t.drawn ? [9, 4] : [2, 4], t.picked);
    for (const l of s.walkLinks) line(ctx, l.alignment.map(screen), l.throughBuildings ? WARN : LINK, 2.5, l.throughBuildings ? [6, 4] : [], l.picked);
    for (const p of s.accessPoints) marker(ctx, screen(p.location), "diamond", POINT_GLYPHS[p.kind ?? "unknown"], "#fde047", p.picked);
    for (const e of s.entrances) marker(ctx, screen(e.location), "square", "입", e.blocked ? WARN : "#4ade80", e.picked, !e.blocked);
    const at = screen(s.location);
    marker(ctx, at, "circle", "역", "#f1f2f5", s.stationPicked, true);
    label(ctx, `${s.name ?? s.kindLabel}`, [at[0] + 12, at[1] - 10]);
  }
  ctx.restore();
}

// Stations of other networks, drawn as small dots so the player can pick one (to draw access for, or as a transfer target).
export function drawStationDots(ctx, stations, screen, color = "#9ca3af") {
  ctx.save();
  ctx.fillStyle = color;
  for (const st of stations) { const [x, y] = screen(st.location); ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2); ctx.fill(); }
  ctx.restore();
}

// --- DOM: player-controlled text only ever goes through textContent ---
function elementFacts(site, selection) {
  const pick = (list, keyOf = (x) => x.key) => list.find((x) => keyOf(x) === selection.key);
  const unknown = (rec) => rec.unknown.map((f) => `미상: ${f}${rec.unknownReasons[f] ? ` (${reasonText(rec.unknownReasons[f])})` : ""}`);
  const rows = [];
  if (selection.type === "entrance") {
    const r = pick(site.entrances);
    if (r) rows.push(`역 중심에서 ${num(r.distanceToStationMeters, 1)} m`, `겹치는 건물 ${orUnknown(r.insideBuildingCount)} · 물 ${orUnknown(r.insideWaterCount)}`, ...unknown(r));
  } else if (selection.type === "access-point") {
    const r = pick(site.accessPoints);
    if (r) rows.push(`${r.kind ? POINT_KIND_LABELS[r.kind] : "종류 미지정"} · 역 중심에서 ${num(r.distanceToStationMeters, 1)} m`, r.drawnConnection.connected ? `그려진 연결 있음 · 그려진 길이 ${num(r.drawnConnection.lengthMeters, 1)} m` : "그려진 보행 연결 없음", ...unknown(r));
  } else if (selection.type === "walk-link") {
    const r = pick(site.walkLinks);
    if (r) rows.push(`그려진 길이 ${num(r.lengthMeters, 1)} m · 직선 ${num(r.straightDistanceMeters, 1)} m`, `폭 ${r.widthMeters === null ? "지정 안 함" : `${num(r.widthMeters, 1)} m`}`, `지나는 것: ${crossText(r.crossings)}`);
  } else if (selection.type === "transfer") {
    const r = pick(site.transfers, (t) => t.targetStationId);
    if (r) rows.push(`${r.basis === "player-passage" ? "그린 통로" : "근처 역 (직선)"} · 대상 ${r.targetName ?? r.targetStationId}`, `통로 길이 ${num(r.passageLengthMeters, 1)} m · 직선 ${num(r.straightDistanceMeters, 1)} m`, `지나는 것: ${crossText(r.crossings)}`);
  } else if (selection.type === "catchment") {
    const r = pick(site.catchments);
    if (r) rows.push(`면적 ${num(r.areaSquareMeters)} ㎡ · 역 ${r.containsStation ? "포함" : "밖"}`, `포함: 출입구 ${r.containsEntranceIds.length} · 접근점 ${r.containsAccessPointIds.length} · 수요 노드 ${orUnknown(r.demandNodeIdsInside?.length)}`, `겹치는 수요 구역 ${r.demandZoneIds.length} · 건물 ${orUnknown(r.buildingCount)}`, ...unknown(r));
  } else if (selection.type === "demand-zone") {
    const r = pick(site.demandZones);
    if (r) {
      rows.push(`${r.kind ? ZONE_KIND_LABELS[r.kind] : "종류 미지정"} · 면적 ${num(r.areaSquareMeters)} ㎡ · 건물 ${orUnknown(r.buildingCount)}`);
      rows.push(r.demandNodeRefs === null ? "안의 수요 노드: 미상" : r.demandNodeRefs.length ? `안의 수요 노드 ${r.demandNodeRefs.map((n) => `${n.name ?? n.demandNodeId} (항목: ${n.fieldsPresent.join(", ") || "없음"})`).join(", ")}` : "안에 수요 노드 없음");
      if (r.nearestDemandNode) rows.push(`가장 가까운 수요 노드 ${r.nearestDemandNode.demandNodeId} · ${num(r.nearestDemandNode.distanceMeters, 1)} m`);
      rows.push(r.drawnConnection.connected ? `역과 그려진 연결 있음 · 그려진 길이 ${num(r.drawnConnection.lengthMeters, 1)} m` : "역과 그려진 보행 연결 없음", ...unknown(r));
    }
  }
  return rows;
}

export function renderStationAccessPanel(container, model, selection = null) {
  container.replaceChildren();
  container.hidden = model.sites.length === 0;
  if (!model.sites.length) return;
  const doc = container.ownerDocument;
  const el = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  for (const s of model.sites) {
    const block = el("div", `access-site${s.selected ? " selected" : ""}`);
    block.append(el("div", "access-title", `${s.name ?? s.kindLabel} · ${s.kindLabel} · 자료 품질 ${s.qualityLabel}`));
    block.append(el("div", "access-fact", `출입구 ${s.entrances.length} · 접근점 ${s.accessPoints.length} · 보행 연결 ${s.walkLinks.length} · 환승 통로 ${s.transfers.length} · 접근권 경계 ${s.catchments.length} · 수요 구역 ${s.demandZones.length}`));
    for (const f of s.flags) block.append(el("div", "diag warning", `⚠ ${f.label}`));
    for (const m of s.missing) block.append(el("div", "diag info", `미상: ${m.field}${m.reason ? ` (${m.reason})` : ""}`));
    if (s.sources === null) block.append(el("div", "access-fact missing", "수요·OD 자료 출처: 미상"));
    else for (const r of s.sources) block.append(el("div", "access-fact", `수요 자료 출처 ${r.file} · 해상도 ${r.resolution ?? "미상"} · 품질 ${r.qualityLabel}`));
    if (s.selected && selection?.type && selection.type !== "station") for (const row of elementFacts(s.site, selection)) block.append(el("div", "access-fact", row));
    for (const w of s.warnings) block.append(el("div", "diag warning", `⚠ ${w.code}`));
    container.append(block);
  }
  for (const o of model.overlaps) container.append(el("div", "diag info", `다른 역의 접근권 경계와 겹침 (${o.catchmentIds.length}개 경계)`));
  for (const w of model.warnings) container.append(el("div", "diag warning", `⚠ ${w.code}`));
}

export function renderStationAccessLegend(container) {
  container.replaceChildren();
  const doc = container.ownerDocument;
  const el = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  container.append(el("div", "section-label", "접근권 범례"));
  for (const row of ["역 ● 역 중심", "입 ■ 출입구 (주황: 건물이나 물 위)", "◆ 접근점 (길·횡·광·정)", "━ 보행 연결 (주황 점선: 건물을 지남)", "┅ 환승 통로 (보라)", "┈ 접근권 경계 (하늘색)", "▨ 수요 구역 (색과 글자로 종류 구분)"]) container.append(el("div", "legend-row", row));
  container.append(el("div", "legend-row", "그리지 않은 것은 표시하지 않고, 모르는 값은 '미상'으로 적는다"));
}
