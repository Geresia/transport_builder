// Selection bridge, display: highlights the chosen station / entrances / passages / work area and shows what the
// management engine returned about them — construction phase, verdict and errors — read-only. The engine's words
// come from the overlay model (overlay.mjs) built from its report; nothing here writes to the export, the report,
// the plans or any state, and nothing here says anything about cost, duration, score, method or compensation.
import { PHASES } from "./overlay.mjs";
import { engineStatusFor } from "./station-view.mjs";
import { selectionOutput } from "./station-selection.mjs";

const HIGHLIGHT = "#ffe66d";
const SEVERITY_ICON = { error: "⛔", warning: "⚠", info: "ⓘ" };
const MAP_NOTES_SHOWN = 3; // map-side notes can be many; the panel shows the first few and counts the rest

// What the engine said that applies to this station: its own diagnostics, those on the segments that reach it, and
// the plan-wide ones. Map-side notes (missing spatial data) are kept apart from the engine's.
function engineFacts(site, overlay) {
  const plan = overlay?.plans?.find((p) => p.planId === site.connectedPlanId) ?? null;
  const scope = (d) => (d.target.type === "station" && d.target.id === site.connectedStationId ? "station"
    : d.target.type === "segment" && site.connectedSegmentIds.includes(d.target.id) ? "segment"
      : d.target.type === "plan" && d.target.id === site.connectedPlanId ? "plan" : null);
  const mine = (overlay?.diagnostics ?? []).filter((d) => d.planId === site.connectedPlanId).map((d) => ({ d, scope: scope(d) })).filter((x) => x.scope);
  const pick = (source) => mine.filter((x) => x.d.source === source).map(({ d, scope: s }) => ({ severity: d.severity, code: d.code, message: d.message, scope: s, target: d.target }));
  return {
    readOnly: true,
    linked: plan !== null,
    construction: plan ? { phase: plan.phase, label: plan.phase === null ? "상태 불명" : PHASES[plan.phase].label, status: plan.status, delayed: plan.delayed, progress: plan.progress } : null,
    status: engineStatusFor(site, overlay),
    errors: pick("engine"),
    mapNotes: pick("map"),
  };
}

const chosen = (list, ids) => ids.map((id) => list.find((x) => x.id === id)).filter(Boolean);

// exp: a StationExport; sel: the selection; overlay: buildOverlayModel(...) or null.
export function buildSelectionView(exp, sel, overlay = null) {
  const site = sel.stationSiteId === null ? null : exp?.sites?.find((s) => s.stationSiteId === sel.stationSiteId) ?? null;
  if (!site) return { active: false, output: selectionOutput(sel, exp) };
  const entrances = site.entranceCandidates.map((e) => ({ id: e.entranceId, location: e.location, blocked: e.spatialFlags.includes("building-collision") || e.spatialFlags.includes("in-water"), flags: e.spatialFlags }));
  const transfers = site.transferCandidates.map((t) => ({ id: t.transferId, alignment: t.alignment, basis: t.basis, target: t.targetName ?? t.targetStationId, distance: t.walkingDistanceMeters }));
  const work = site.workAreaCandidates.map((w) => ({ id: w.workAreaId, polygon: w.polygon, slot: w.slot, flags: w.spatialFlags }));
  return {
    active: true,
    stationSiteId: site.stationSiteId,
    name: site.name,
    location: site.location,
    body: site.bodyPolygon,
    entrances: chosen(entrances, sel.entranceIds),
    transfers: chosen(transfers, sel.transferIds),
    workArea: work.find((w) => w.id === sel.workAreaId) ?? null,
    engine: engineFacts(site, overlay),
    output: selectionOutput(sel, exp),
  };
}

const trace = (ctx, pts, screen, close = false) => {
  ctx.beginPath();
  pts.map(screen).forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  if (close) ctx.closePath();
};
const halo = (ctx, draw) => { // a dark under-stroke, then the highlight, so it reads on any layer
  ctx.strokeStyle = "#111318";
  ctx.lineWidth = 7;
  draw();
  ctx.strokeStyle = HIGHLIGHT;
  ctx.lineWidth = 3.5;
  draw();
};

// `screen` maps [lon, lat] to canvas pixels. Drawn above the station layers; never blocks input.
export function drawStationSelection(ctx, view, screen) {
  if (!view.active) return;
  ctx.save();
  ctx.lineJoin = "round";
  if (view.body) halo(ctx, () => { trace(ctx, view.body, screen, true); ctx.stroke(); });
  else { const [x, y] = screen(view.location); halo(ctx, () => { ctx.strokeRect(x - 9, y - 9, 18, 18); }); }
  if (view.workArea) { ctx.setLineDash([6, 4]); halo(ctx, () => { trace(ctx, view.workArea.polygon, screen, true); ctx.stroke(); }); ctx.setLineDash([]); }
  for (const t of view.transfers) halo(ctx, () => { trace(ctx, t.alignment, screen); ctx.stroke(); });
  for (const e of view.entrances) {
    const [x, y] = screen(e.location);
    halo(ctx, () => { ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2); ctx.stroke(); });
  }
  // the engine's word for the station, as a read-only chip under it
  const [sx, sy] = screen(view.location);
  const engine = view.engine;
  const text = `선택 · ${view.name ?? "역 후보"}${engine.status ? ` · 엔진: ${engine.status.label}` : engine.construction ? ` · ${engine.construction.label}` : ""}${engine.errors.some((e) => e.severity === "error") ? " · 오류 있음" : ""}`;
  ctx.font = "bold 11px Inter, system-ui, 'Malgun Gothic', sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const w = ctx.measureText(text).width + 12;
  ctx.fillStyle = "#111318";
  ctx.strokeStyle = HIGHLIGHT;
  ctx.lineWidth = 2;
  ctx.fillRect(sx - w / 2, sy + 22, w, 18);
  ctx.strokeRect(sx - w / 2, sy + 22, w, 18);
  ctx.fillStyle = HIGHLIGHT;
  ctx.fillText(text, sx, sy + 31);
  ctx.restore();
}

// Player-controlled text (names) only ever goes through textContent.
export function renderSelectionPanel(container, view) {
  container.replaceChildren();
  container.hidden = !view.active;
  if (!view.active) return;
  const doc = container.ownerDocument;
  const el = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const o = view.output;
  container.append(el("div", "section-label", `선택: ${view.name ?? o.stationSiteId}`));
  container.append(el("div", "diag info", `출입구 ${o.selectedEntranceIds.length} · 환승통로 ${o.selectedTransferIds.length} · 작업장 ${o.selectedWorkAreaId ? 1 : 0}`));
  const e = view.engine;
  container.append(el("div", "section-label", "경영 엔진 (읽기 전용)"));
  if (!e.linked) container.append(el("div", "diag info", "계획 역에 연결되지 않은 후보라 엔진이 반환한 상태가 없습니다."));
  else {
    container.append(el("div", "diag info", `공사 상태: ${e.construction.label}${e.construction.delayed ? " · 지연" : ""}${e.construction.progress !== null && e.construction.phase === "underConstruction" ? ` ${Math.round(e.construction.progress * 100)}%` : ""}`));
    container.append(el("div", "diag info", e.status ? `판정: ${e.status.label}` : "판정: 아직 반환되지 않음"));
    for (const d of e.errors) container.append(el("div", `diag ${d.severity}`, `${SEVERITY_ICON[d.severity]} ${d.message}`));
    if (!e.errors.length) container.append(el("div", "diag info", "엔진이 반환한 오류·경고 없음"));
  }
  for (const d of e.mapNotes.slice(0, MAP_NOTES_SHOWN)) container.append(el("div", "diag info", `지도 입력: ${d.message}`));
  if (e.mapNotes.length > MAP_NOTES_SHOWN) container.append(el("div", "diag info", `…지도 입력 메모 ${e.mapNotes.length - MAP_NOTES_SHOWN}건 더`));
}
