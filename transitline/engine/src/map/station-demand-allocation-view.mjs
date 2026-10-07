// Display of an applied station demand allocation (see docs/b15-m4-station-demand-allocation-overlay-2026-10-08.md): where each demand
// node is, which station access site(s) it was given to and at what share, which links the engine really made, and which nodes
// stayed unallocated, without a route, blocked or unknown — read straight from runtime.stationDemandAllocationReport().
// Read-only and display-only: it counts no passenger, computes no demand, crowding, fare, cost, score or walking time, and a share is
// shown as the policy's expected share, never as a number of people. A value the report did not give stays "unknown" (null): it is
// never drawn or written as 0, false or none.

export const ALLOCATION_VIEW_SCHEMA = "transitline.station-demand-allocation-map-view/1";

export const DECISION_LABELS = Object.freeze({ assigned: "전부 배정", shares: "일부 배정", held: "보류 (배정 안 함)", unknown: "미상 (배정 안 함)" });
export const POLICY_LABELS = Object.freeze({ none: "없음", valid: "정상", rejected: "거절됨" });
export const STATE_LABELS = Object.freeze({ exclusive: "단독 접근", shared: "겹치는 접근", unknown: "미상" });
export const COVERAGE_LABELS = Object.freeze({
  "not-drawn": "접근권 없음", "empty-confirmed": "비어 있음 (확인됨)", "empty-unseen": "안 보임 (미상)", unknown: "일부 미상", shared: "겹침 있음", available: "단독 노드만",
});
export const VISUAL = Object.freeze({
  assigned: { key: "assigned", glyph: "✓", color: "#4ade80", dash: [], label: "전부 배정" },
  split: { key: "split", glyph: "%", color: "#38bdf8", dash: [], label: "비율 배정" },
  held: { key: "held", glyph: "‖", color: "#fbbf24", dash: [4, 3], label: "보류" },
  unknown: { key: "unknown", glyph: "?", color: "#9ca3af", dash: [2, 3], label: "미상" },
});
export const REASON_LABELS = Object.freeze({
  "exclusive-needs-policy": "단독 노드 · 배정 규칙 없음", "shared-needs-policy": "겹치는 노드 · 배정 규칙 없음", "rule-stale": "규칙이 낡음 (역 개정이 바뀜)",
  "rule-claimants-changed": "노드를 주장하는 역이 바뀜", "policy-rejected": "정책이 거절됨",
  "demand-source-coarse": "수요 자료가 시구 단위로 거침", "demand-source-quality-insufficient": "수요 자료 품질이 낮음", "demand-points-source-missing": "수요 자료 출처 없음",
  "demand-points-source-id-missing": "수요 자료 출처 ID 없음", "demand-source-resolution-unknown": "수요 자료 해상도 미기재", "demand-source-resolution-unapproved": "수요 자료 해상도가 맞지 않음",
  "area-footprint-unavailable": "면적형 자료 (중심점 가정 없음)", "demand-node-values-missing": "노드 값이 비어 있음", "demand-node-missing-from-pack": "팩에 노드가 없음",
  "demand-node-values-conflict": "역마다 노드 값이 다름", "demand-node-unknown-in-claimant": "겹친 역 쪽에서 미상", "assessment-revision-mismatch": "평가와 지도 개정이 다름", "access-site-missing": "지도에 역이 없음",
});
export const BLOCK_LABELS = Object.freeze({ "walk-path-unavailable": "걸어갈 경로가 그려지지 않음", "station-not-operational": "운행 역이 아직 없음", "station-operational-ambiguous": "운행 역이 둘 이상" });
const reasonText = (code) => REASON_LABELS[code] ?? code;

const num = (v) => v.toLocaleString("en-US", { maximumFractionDigits: 1 });
// a share as the policy's expected share: 0.6 -> "60%".  null stays unknown.
export const percentText = (share) => (share === null || share === undefined ? "미상" : `${num(Math.round(share * 1000) / 10)}%`);
const known = (v) => (v === null || v === undefined ? "미상" : num(v));
const yesNo = (v) => (v === null || v === undefined ? "미상" : v ? "있음" : "없음");

const entries = (v) => (v instanceof Map ? [...v.entries()].map(([k, x]) => ({ id: k, ...x })) : Array.isArray(v) ? v : v && typeof v === "object" ? Object.entries(v).map(([k, x]) => ({ id: k, ...x })) : []);
const where = (rec) => (Array.isArray(rec?.location) && rec.location.length >= 2 && rec.location.slice(0, 2).every(Number.isFinite) ? [rec.location[0], rec.location[1]] : null);
const byId = (list) => new Map(list.filter((r) => r?.id !== undefined).map((r) => [r.id, r]));
const text = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const uniq = (list) => [...new Set(list)].sort(text);

// report: stationDemandAllocationReport() or null.  access: stationDemandAccessReport() (or its export): the sites' places and catchments.
// demandNodes / stations: lists or Maps of { id, location } (the engine's demand nodes and operational stations).
export function buildAllocationOverlayView({ report = null, access = null, demandNodes = [], stations = [], selectedNodeId = null } = {}) {
  const allocation = report?.allocation ?? null;
  const nodeAt = byId(entries(demandNodes));
  const stationAt = byId(entries(stations));
  const sites = byId(entries(access?.access?.sites ?? access?.sites ?? []).map((s) => ({ ...s, id: s.stationAccessId })));
  const links = report?.links ?? [];
  const blocked = report?.blockedLinks ?? [];
  const split = byId((report?.splitNodes ?? []).map((s) => ({ ...s, id: s.demandNodeId })));
  const missing = { nodes: [], stations: [], sites: [] };
  const stale = report?.status === "stale";

  const siteViews = (allocation?.stations ?? []).map((s) => {
    const site = sites.get(s.stationAccessId) ?? null;
    const location = where(site);
    if (!location) missing.sites.push(s.stationAccessId);
    return {
      stationAccessId: s.stationAccessId, name: site?.name ?? null, location, coverage: s.coverage, coverageLabel: COVERAGE_LABELS[s.coverage] ?? s.coverage,
      polygons: (site?.catchments ?? []).filter((c) => Array.isArray(c?.polygon) && c.polygon.length >= 3).map((c) => c.polygon),
      unknownNodeCount: s.unknownNodeCount, complete: s.complete,
    };
  }).sort((a, b) => text(a.stationAccessId, b.stationAccessId));
  const siteById = byId(siteViews.map((s) => ({ ...s, id: s.stationAccessId })));

  const nodeViews = (allocation?.nodes ?? []).map((n) => {
    const location = where(nodeAt.get(n.demandNodeId));
    if (!location) missing.nodes.push(n.demandNodeId);
    const mine = links.filter((l) => l.demandNodeId === n.demandNodeId);
    const splitInfo = split.get(n.demandNodeId) ?? null;
    const partial = n.assignments.some((a) => a.share < 1) || splitInfo !== null;
    const visual = n.state === "unknown" ? VISUAL.unknown : n.decision === "held" ? VISUAL.held : partial || n.decision === "shares" ? VISUAL.split : VISUAL.assigned;
    const assignments = n.assignments.map((a) => {
      const link = mine.find((l) => l.stationAccessId === a.stationAccessId) ?? null;
      const stop = blocked.find((b) => b.demandNodeId === n.demandNodeId && b.stationAccessId === a.stationAccessId) ?? null;
      const stationLocation = link ? where(stationAt.get(link.stationId)) : null;
      if (link && !stationLocation) missing.stations.push(link.stationId);
      return {
        stationAccessId: a.stationAccessId, siteName: siteById.get(a.stationAccessId)?.name ?? null, share: a.share, percent: percentText(a.share),
        linkState: link ? "linked" : stop ? "blocked" : "none", stationId: link?.stationId ?? null, stationLocation, walkMinutes: link?.walkMinutes ?? null,
        blockCode: stop?.code ?? null, blockLabel: stop ? BLOCK_LABELS[stop.code] ?? stop.code : null,
      };
    });
    return {
      demandNodeId: n.demandNodeId, location, selected: n.demandNodeId === selectedNodeId, state: n.state, stateLabel: STATE_LABELS[n.state] ?? n.state,
      decision: n.decision, decisionLabel: visual.key === "split" ? (n.decision === "shares" ? "일부만 비율대로 배정 (나머지 미배정)" : "비율대로 나눠 배정") : DECISION_LABELS[n.decision] ?? n.decision, visual, claimants: n.claimants,
      residents: n.residents, jobs: n.jobs, residentsText: known(n.residents), jobsText: known(n.jobs),
      reasons: n.reasons.map((code) => ({ code, label: reasonText(code) })),
      assignments,
      unallocatedShare: n.unallocatedShare, unallocatedText: n.unallocatedShare === null ? null : percentText(n.unallocatedShare),
      unroutedShare: splitInfo ? splitInfo.unroutedShare : null, unroutedText: splitInfo ? percentText(splitInfo.unroutedShare) : null,
      legacy: n.legacy?.supplied ? { linkCount: n.legacy.linkCount, overrideRequired: n.legacy.overrideRequired, conflictsWithAllocation: n.legacy.conflictsWithAllocation, activeWhileUnallocated: n.legacy.activeWhileUnallocated } : null,
    };
  }).sort((a, b) => text(a.demandNodeId, b.demandNodeId));

  // the lines: what the engine actually linked (from the node to the operational station), and what it could not (to the access site)
  const lines = [];
  for (const n of nodeViews) for (const a of n.assignments) {
    if (a.linkState === "linked" && n.location && a.stationLocation) lines.push({ kind: "link", demandNodeId: n.demandNodeId, stationAccessId: a.stationAccessId, stationId: a.stationId, from: n.location, to: a.stationLocation, share: a.share, percent: a.percent, fractional: a.share < 1 });
    else if (a.linkState === "blocked") {
      const to = siteById.get(a.stationAccessId)?.location ?? null;
      if (n.location && to) lines.push({ kind: "blocked", demandNodeId: n.demandNodeId, stationAccessId: a.stationAccessId, stationId: null, from: n.location, to, share: a.share, percent: a.percent, fractional: a.share < 1, label: a.blockLabel });
    }
  }
  const count = (f) => nodeViews.filter(f).length;
  return {
    schema: ALLOCATION_VIEW_SCHEMA,
    status: report === null ? "none" : stale ? "stale" : "current", stale,
    staleReasons: report?.staleReasons ?? [], policyStatus: report?.policyStatus ?? null, policyId: allocation?.policyId ?? null, allocationId: allocation?.allocationId ?? null,
    banner: report === null ? "적용된 배정이 없습니다." : stale ? "낡은 배정 — 지도 개정이 바뀌었습니다. 아래는 마지막으로 적용한 결과입니다." : null,
    sites: siteViews, nodes: nodeViews, lines: lines.sort((a, b) => text(`${a.demandNodeId}|${a.stationAccessId}|${a.kind}`, `${b.demandNodeId}|${b.stationAccessId}|${b.kind}`)),
    totals: allocation === null ? null : { nodes: nodeViews.length, assigned: count((n) => n.visual.key === "assigned"), split: count((n) => n.visual.key === "split"), held: count((n) => n.visual.key === "held"), unknown: count((n) => n.visual.key === "unknown"), links: links.length, blocked: blocked.length },
    missing: { nodes: uniq(missing.nodes), stations: uniq(missing.stations), sites: uniq(missing.sites) },
    selectedNodeId: nodeViews.some((n) => n.demandNodeId === selectedNodeId) ? selectedNodeId : null,
  };
}

// --- canvas ---
const INK = "#111318";
const TEXT = "#f1f2f5";
const path = (ctx, pts) => pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
function label(ctx, words, [x, y], color = TEXT) {
  ctx.font = "10px Inter, system-ui, 'Malgun Gothic', sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  ctx.lineWidth = 3;
  ctx.strokeStyle = INK;
  ctx.strokeText(words, x, y);
  ctx.fillStyle = color;
  ctx.fillText(words, x, y);
}
function badge(ctx, [x, y], glyph, color, dash, selected, hollow) {
  ctx.beginPath();
  ctx.arc(x, y, selected ? 10 : 8, 0, Math.PI * 2);
  ctx.fillStyle = hollow ? INK : color;
  ctx.fill();
  ctx.strokeStyle = selected ? TEXT : color;
  ctx.lineWidth = selected ? 3 : 2;
  ctx.setLineDash(dash);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = hollow ? color : INK;
  ctx.font = "bold 11px system-ui, 'Malgun Gothic', sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(glyph, x, y + 0.5);
}

// `screen` maps [lon, lat] to canvas pixels.  A stale allocation is drawn faded and marked, never hidden.
export function drawAllocationOverlay(ctx, model, screen) {
  ctx.save();
  const base = model.stale ? 0.5 : 1;
  for (const s of model.sites) for (const poly of s.polygons) {
    ctx.fillStyle = "#4cc9f0";
    ctx.globalAlpha = base * 0.12;
    ctx.beginPath();
    path(ctx, poly.map(screen));
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = base;
    ctx.strokeStyle = "#4cc9f0";
    ctx.lineWidth = 1;
    ctx.setLineDash([8, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  ctx.globalAlpha = base;
  for (const l of model.lines) {
    const [a, b] = [screen(l.from), screen(l.to)];
    ctx.strokeStyle = l.kind === "blocked" ? "#f87171" : VISUAL[l.fractional ? "split" : "assigned"].color;
    ctx.lineWidth = 1.5 + 4 * l.share; // a share is shown as a thicker line; it is not a count of anyone
    ctx.setLineDash(l.kind === "blocked" ? [3, 4] : l.fractional ? [6, 3] : []);
    ctx.beginPath();
    path(ctx, [a, b]);
    ctx.stroke();
    ctx.setLineDash([]);
    label(ctx, l.kind === "blocked" ? `${l.percent} 차단: ${l.label}` : `예상 ${l.percent}`, [(a[0] + b[0]) / 2 + 4, (a[1] + b[1]) / 2 - 4], l.kind === "blocked" ? "#f87171" : TEXT);
  }
  for (const s of model.sites) {
    if (!s.location) continue;
    const [x, y] = screen(s.location);
    ctx.fillStyle = INK;
    ctx.strokeStyle = TEXT;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.rect(x - 7, y - 7, 14, 14);
    ctx.fill();
    ctx.stroke();
    label(ctx, `${s.name ?? s.stationAccessId}${model.stale ? " · 낡음" : ""}`, [x + 10, y - 10]);
  }
  for (const n of model.nodes) {
    if (!n.location) continue; // a node with no known place is listed in the panel, never put somewhere
    const at = screen(n.location);
    badge(ctx, at, n.visual.glyph, n.visual.color, n.visual.dash, n.selected, n.visual.key === "unknown" || n.visual.key === "held");
    label(ctx, `${n.demandNodeId} · ${n.visual.label}`, [at[0] + 12, at[1]], n.visual.color);
    if (n.unroutedShare !== null && n.unroutedShare > 0) { // the part of the node no link takes: a short grey stub, not a path
      ctx.strokeStyle = "#9ca3af";
      ctx.lineWidth = 2;
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      path(ctx, [[at[0], at[1] - 9], [at[0], at[1] - 24]]);
      ctx.stroke();
      ctx.setLineDash([]);
      label(ctx, `경로 없음 ${n.unroutedText}`, [at[0] + 4, at[1] - 28], "#9ca3af");
    }
  }
  ctx.restore();
}

// The node nearest a click (within `radius` px), or null.
export function hitAllocationNode(model, screen, point, radius = 12) {
  let best = null;
  for (const n of model.nodes) {
    if (!n.location) continue;
    const [x, y] = screen(n.location);
    const d = Math.hypot(x - point[0], y - point[1]);
    if (d <= radius && (!best || d < best.d || (d === best.d && n.demandNodeId < best.id))) best = { id: n.demandNodeId, d };
  }
  return best ? best.id : null;
}

// --- DOM: every text goes through textContent ---
export function renderAllocationPanel(container, model) {
  container.replaceChildren();
  const doc = container.ownerDocument;
  const el = (tag, cls, words) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (words !== undefined) e.textContent = words; return e; };
  if (model.banner) container.append(el("div", `diag ${model.stale ? "warning" : "info"} alloc-banner`, model.banner));
  if (model.totals) {
    const t = model.totals;
    container.append(el("div", "alloc-fact", `노드 ${t.nodes} · 전부 배정 ${t.assigned} · 비율 배정 ${t.split} · 보류 ${t.held} · 미상 ${t.unknown}`));
    container.append(el("div", "alloc-fact", `적용된 링크 ${t.links} · 차단된 링크 ${t.blocked}${model.policyStatus ? ` · 정책 ${POLICY_LABELS[model.policyStatus] ?? model.policyStatus}` : ""}`));
    for (const w of model.staleReasons) container.append(el("div", "diag warning", `⚠ ${w}`));
  }
  const picked = model.nodes.find((n) => n.selected);
  if (picked) {
    container.append(el("div", "section-label", `선택한 노드: ${picked.demandNodeId}`));
    container.append(el("div", "alloc-fact", `${picked.stateLabel} · ${picked.decisionLabel}`));
    container.append(el("div", "alloc-fact", `거주 ${picked.residentsText} · 종사 ${picked.jobsText}`));
    for (const r of picked.reasons) container.append(el("div", "diag info", r.label));
    for (const a of picked.assignments) {
      const link = a.linkState === "linked" ? `연결됨 (운행 역 ${a.stationId}${a.walkMinutes === null ? "" : ` · 엔진의 걸음 ${known(a.walkMinutes)}분`})` : a.linkState === "blocked" ? `차단: ${a.blockLabel}` : "링크 정보 없음 (미상)";
      container.append(el("div", "alloc-fact", `${a.siteName ?? a.stationAccessId} · 예상 비율 ${a.percent} · ${link}`));
    }
    if (!picked.assignments.length && picked.state !== "unknown") container.append(el("div", "alloc-fact", "어느 역에도 배정되지 않음"));
    if (picked.unallocatedText !== null && picked.unallocatedShare > 0) container.append(el("div", "alloc-fact", `정책이 배정하지 않은 몫 ${picked.unallocatedText}`));
    if (picked.unroutedShare !== null && picked.unroutedShare > 0) container.append(el("div", "alloc-fact", `경로 없음 ${picked.unroutedText} (다른 접근으로 보내지 않음)`));
    if (picked.legacy) container.append(el("div", "alloc-fact", `기존 링크 ${known(picked.legacy.linkCount)}개 · 새 배정과 충돌 ${yesNo(picked.legacy.conflictsWithAllocation)} · 대체 필요 ${yesNo(picked.legacy.overrideRequired)}`));
    else container.append(el("div", "alloc-fact", "기존 링크 정보: 미상 (넘겨받지 않음)"));
  }
  if (model.nodes.length) {
    container.append(el("div", "section-label", `노드 ${model.nodes.length}개`));
    for (const n of model.nodes.slice(0, 30)) container.append(el("div", `alloc-row${n.selected ? " picked" : ""}`, `${n.visual.glyph} ${n.demandNodeId} · ${n.visual.label}${n.location ? "" : " · 위치 미상"}`));
    if (model.nodes.length > 30) container.append(el("div", "alloc-fact", `외 ${model.nodes.length - 30}개`));
  }
  const gone = [...model.missing.nodes.map((id) => `노드 ${id}`), ...model.missing.stations.map((id) => `운행 역 ${id}`), ...model.missing.sites.map((id) => `접근 역 ${id}`)];
  if (gone.length) container.append(el("div", "diag warning", `위치를 모르는 것은 그리지 않습니다: ${gone.join(", ")}`));
}

export function renderAllocationLegend(container) {
  container.replaceChildren();
  const doc = container.ownerDocument;
  const el = (tag, cls, words) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (words !== undefined) e.textContent = words; return e; };
  container.append(el("div", "section-label", "배정 범례"));
  for (const v of Object.values(VISUAL)) container.append(el("div", `legend-row ${v.key}`, `${v.glyph} ${v.label}`));
  for (const row of ["━ 적용된 링크 (굵기와 '예상 N%'는 정책의 몫, 승객 수 아님)", "┅ 비율 링크 (점선)", "┈ 차단된 링크 (붉은 점선)", "▭ 접근 역 / 하늘색 점선 = 접근권", "회색 짧은 선 = 경로 없는 몫"]) container.append(el("div", "legend-row", row));
  container.append(el("div", "legend-row", "낡은 배정은 흐리게 그리고 '낡음'을 적는다. 모르는 값은 '미상'이다."));
}
