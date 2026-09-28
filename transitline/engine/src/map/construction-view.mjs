// Read-only view of what the management engine returned for a construction package: its build phase, progress
// split into finished / unfinished corridor, and incident / complaint / material-shortage markers.
//
// The map only DISPLAYS engine output. Nothing here writes to the report, the packages, or any cash/contract/
// construction state, and nothing here imports ./management — the report is plain data.
export const PACKAGE_PHASES = Object.freeze({
  beforeStart: { label: "착공 전", color: "#8c93a4", dash: [4, 6] },
  underConstruction: { label: "공사 중", color: "#ffd60a", dash: [14, 5] },
  delayed: { label: "지연", color: "#ff9f1c", dash: [2, 7] },
  suspended: { label: "일시중단", color: "#e5484d", dash: [3, 3] },
  testing: { label: "시험 중", color: "#9b5de5", dash: [] },
  complete: { label: "완료", color: "#2fbf71", dash: [] },
  cancelled: { label: "✕ 취소", color: "#b0798a", dash: [1, 9] },
});
const UNKNOWN_STYLE = { label: "상태 불명", color: "#6b7d85", dash: [2, 4] };
const MARKER_KIND = { incident: { label: "사고", glyph: "!", color: "#e5484d" }, complaint: { label: "민원", glyph: "◆", color: "#ffb703" }, "material-shortage": { label: "자재 부족", glyph: "▲", color: "#4895ef" } };

// Project status (from the plan-level report, same vocabulary as overlay.mjs) -> package phase, used when the
// engine has not broken a status down per package. `estimated` sits before any contract, so it reads as "착공 전".
const PROJECT_PHASE = {
  estimated: "beforeStart", approved: "beforeStart", contracted: "underConstruction", underConstruction: "underConstruction",
  inspection: "testing", available: "complete", cancelled: "cancelled", suspended: "suspended", halted: "suspended",
};

// report.constructionPackages?: { [constructionSiteId]: { status, progress?, delayMonths? } } — package-level detail,
// once the engine has it. Until then a package's phase falls back to its plan's project status (report.projects[]).
function packageStatus(site, report) {
  const own = report?.constructionPackages?.[site.constructionSiteId];
  if (own) return own;
  const project = (Array.isArray(report?.projects) ? report.projects : Object.values(report?.projects ?? {})).find((p) => p.planId === site.connectedPlanId);
  return project ? { status: project.status, progress: project.progress ?? null, delayMonths: project.delayMonths ?? 0 } : null;
}
function phaseKeyFor(status) {
  if (!status) return null;
  if (status.status === "underConstruction" && (status.delayMonths ?? 0) > 0) return "delayed";
  return PROJECT_PHASE[status.status] ?? null;
}

const ringCentroid = (ring) => ring.reduce((s, p) => [s[0] + p[0] / ring.length, s[1] + p[1] / ring.length], [0, 0]);

// The corridor split at `progress` (0..1) along its length: the drawn-so-far half and the rest. Only meaningful
// for a ribbon polygon (an even list of left-side-then-right-side points, as ribbonPolygon in construction-site.mjs
// produces); other shapes just take the whole polygon's colour.
function splitByProgress(polygon, progress) {
  if (!polygon || polygon.length < 4 || polygon.length % 2 !== 0 || progress === null) return null;
  const half = polygon.length / 2;
  const left = polygon.slice(0, half);
  const right = polygon.slice(half).reverse();
  if (left.length < 2) return null; // too short a corridor to split into two real polygons
  const cut = Math.max(1, Math.min(left.length - 1, Math.round(left.length * progress)));
  const doneRing = [...left.slice(0, cut), ...right.slice(0, cut).reverse()];
  const remainingRing = [...left.slice(cut - 1), ...right.slice(cut - 1).reverse()];
  return doneRing.length >= 3 && remainingRing.length >= 3 ? { doneRing, remainingRing } : null;
}

// exp: a ConstructionExport. report: the engine's report (same shape overlay.mjs reads), plus an optional
// `constructionMarkers: [{ constructionSiteId, kind: "incident"|"complaint"|"material-shortage", location?, message? }]`.
export function buildConstructionView(exp, report = {}) {
  const markersBySite = new Map();
  for (const m of report?.constructionMarkers ?? []) markersBySite.set(m.constructionSiteId, [...(markersBySite.get(m.constructionSiteId) ?? []), m]);

  const sites = (exp?.sites ?? []).map((site) => {
    const status = packageStatus(site, report);
    const phaseKey = phaseKeyFor(status);
    const style = phaseKey ? PACKAGE_PHASES[phaseKey] : UNKNOWN_STYLE;
    const at = site.polygon ? ringCentroid(site.polygon) : site.workAreaCandidates?.[0] ? ringCentroid(site.workAreaCandidates[0].polygon) : null;
    const progress = status?.progress ?? null;
    const split = phaseKey === "underConstruction" || phaseKey === "delayed" ? splitByProgress(site.polygon, progress) : null;
    return {
      constructionSiteId: site.constructionSiteId, kind: site.kind, name: site.name, at,
      polygon: site.polygon, phase: phaseKey, style, progress, delayMonths: status?.delayMonths ?? 0,
      linked: status !== null,
      doneRing: split?.doneRing ?? null, remainingRing: split?.remainingRing ?? null,
      markers: (markersBySite.get(site.constructionSiteId) ?? []).map((m) => ({
        kind: m.kind, message: m.message ?? null,
        at: Array.isArray(m.location) ? m.location : at ?? [0, 0],
      })),
      missing: site.unknown.map((f) => ({ field: f, reason: site.unknownReasons[f] })),
      warnings: site.warnings,
    };
  });
  return { sites, unlinked: (exp?.warnings ?? []).filter((w) => w.code === "construction-no-geometry") };
}

const path = (ctx, pts, screen, close = false) => {
  ctx.beginPath();
  pts.map(screen).forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  if (close) ctx.closePath();
};
function marker(ctx, kind, [x, y]) {
  const spec = MARKER_KIND[kind] ?? MARKER_KIND.incident;
  ctx.fillStyle = spec.color;
  ctx.strokeStyle = "#111318";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(x, y, 7, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "#111318";
  ctx.font = "bold 9px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(spec.glyph, x, y + 0.5);
}

// `screen` maps [lon, lat] to canvas pixels.
export function drawConstructionOverlay(ctx, model, screen) {
  ctx.save();
  for (const site of model.sites) {
    if (!site.polygon) continue;
    ctx.lineJoin = "round";
    if (site.doneRing && site.remainingRing) {
      ctx.globalAlpha = 0.55;
      ctx.fillStyle = PACKAGE_PHASES.complete.color;
      path(ctx, site.doneRing, screen, true);
      ctx.fill();
      ctx.fillStyle = site.style.color;
      path(ctx, site.remainingRing, screen, true);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = site.style.color;
      ctx.lineWidth = 2;
      ctx.setLineDash(site.style.dash);
      path(ctx, site.polygon, screen, true);
      ctx.stroke();
      ctx.setLineDash([]);
    } else {
      ctx.fillStyle = site.style.color;
      ctx.globalAlpha = 0.4;
      path(ctx, site.polygon, screen, true);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = site.style.color;
      ctx.lineWidth = 2;
      ctx.setLineDash(site.style.dash);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (site.at) {
      const [x, y] = screen(site.at);
      const text = `${site.style.label}${site.progress !== null && (site.phase === "underConstruction" || site.phase === "delayed") ? ` ${Math.round(site.progress * 100)}%` : ""}`;
      ctx.font = "bold 11px Inter, system-ui, 'Malgun Gothic', sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.lineWidth = 3;
      ctx.strokeStyle = "#111318";
      ctx.strokeText(text, x, y - 14);
      ctx.fillStyle = site.style.color;
      ctx.fillText(text, x, y - 14);
    }
    for (const m of site.markers) marker(ctx, m.kind, screen(m.at));
  }
  ctx.restore();
}

// Player-controlled text (package names) only ever goes through textContent.
export function renderConstructionPanel(container, model) {
  container.replaceChildren();
  container.hidden = model.sites.length === 0;
  if (!model.sites.length) return;
  const doc = container.ownerDocument;
  const el = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  container.append(el("div", "section-label", `공구 ${model.sites.length}곳`));
  for (const site of model.sites) {
    container.append(el("div", "diag info", `${site.name ?? site.constructionSiteId} · ${site.kind} · ${site.style.label}${site.linked ? "" : " (엔진 보고 없음)"}`));
    for (const m of site.markers) container.append(el("div", "diag warning", `⚠ ${site.name ?? site.constructionSiteId}: ${MARKER_KIND[m.kind]?.label ?? m.kind}${m.message ? ` — ${m.message}` : ""}`));
    if (site.missing.length) container.append(el("div", "diag warning", `⚠ 미상: ${site.missing.map((x) => `${x.field}(${x.reason})`).join(", ")}`));
  }
}

// Legend for the phase colours (textContent only), same styles the overlay draws.
export function renderConstructionLegend(container, phases = PACKAGE_PHASES) {
  container.replaceChildren();
  const doc = container.ownerDocument;
  container.append(Object.assign(doc.createElement("div"), { className: "section-label", textContent: "공사 단계 (엔진 반환값)" }));
  for (const style of Object.values(phases)) {
    const row = doc.createElement("div");
    row.className = "phase-legend-row";
    const chip = doc.createElement("i");
    chip.className = "phase-chip";
    chip.style.borderTopColor = style.color;
    chip.style.borderTopStyle = style.dash.length ? "dashed" : "solid";
    const label = doc.createElement("span");
    label.textContent = style.label;
    row.append(chip, label);
    container.append(row);
  }
}
