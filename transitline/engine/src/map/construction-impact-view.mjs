// Read-only view of construction events: markers per event kind and status (from ScenarioRuntime.report(), the
// same `constructionMarkers` / `constructionPackages` construction-view.mjs already reads), the selected event's
// affected area, its linked construction package, and its linked vs alternative response candidates.
//
// The map only DISPLAYS engine output. Nothing here writes to the report, the events, the packages or any
// cash/contract/construction state, and nothing here imports ./management or ./construction-impact-editor.
const EVENT_STYLE = {
  incident: { label: "사고", glyph: "!", color: "#e5484d" },
  complaint: { label: "민원", glyph: "◆", color: "#ffb703" },
  "material-shortage": { label: "자재 부족", glyph: "▲", color: "#4895ef" },
  "permit-delay": { label: "인허가 지연", glyph: "§", color: "#9b5de5" },
  "utility-conflict": { label: "지장물 충돌", glyph: "⌁", color: "#ff9f1c" },
  "unexpected-ground": { label: "예상 못한 지반", glyph: "▽", color: "#8c5a3c" },
  "access-blocked": { label: "접근 차단", glyph: "⛔", color: "#b0798a" },
};
export const STATUS_STYLE = {
  unresolved: { label: "해결 전", ring: "#e5484d" },
  responding: { label: "대응 중", ring: "#ffd60a" },
  resolved: { label: "해결", ring: "#2fbf71" },
  ignored: { label: "무시", ring: "#6b7d85" },
};
const UNKNOWN_STATUS = { label: "상태 불명", ring: "#3a3f4d" };

const ringCentroid = (ring) => ring.reduce((s, p) => [s[0] + p[0] / ring.length, s[1] + p[1] / ring.length], [0, 0]);

// A construction site's own representative point, for a marker whose event gave no location at all.
function siteCentre(site) {
  if (!site) return null;
  if (site.polygon) return ringCentroid(site.polygon);
  return site.workAreaCandidates?.[0] ? ringCentroid(site.workAreaCandidates[0].polygon) : null;
}

// report: ScenarioRuntime.report() (or an equivalent plain object). constructionExport: buildConstructionExport()'s
// result, used only to find a package's centre when a marker gives no location of its own.
// Returns one view row per `report.constructionMarkers` entry — every kind the marker names is shown, even one
// this map does not otherwise recognise (labelled with its own kind text rather than dropped).
export function buildImpactMarkerViews(report, constructionExport) {
  const sitesById = new Map((constructionExport?.sites ?? []).map((s) => [s.constructionSiteId, s]));
  return (report?.constructionMarkers ?? []).map((marker) => {
    const site = sitesById.get(marker.constructionSiteId) ?? null;
    const hasLocation = Array.isArray(marker.location) && marker.location.length === 2;
    const fallback = hasLocation ? null : siteCentre(site);
    const style = EVENT_STYLE[marker.kind] ?? { label: marker.kind ?? "?", glyph: "?", color: "#8c93a4" };
    const status = marker.status ? (STATUS_STYLE[marker.status] ?? { label: marker.status, ring: "#8c93a4" }) : UNKNOWN_STATUS;
    return {
      eventId: marker.eventId ?? null,
      kind: marker.kind, style,
      status: marker.status ?? null, statusStyle: status,
      location: hasLocation ? marker.location : fallback,
      locationUnknown: !hasLocation,
      constructionSiteId: marker.constructionSiteId ?? null,
      message: marker.message ?? null,
    };
  });
}

// impact: one entry from buildConstructionImpactExport (or buildConstructionImpact) for the event under
// inspection. constructionExport: the same export the impact was built against, to draw the linked package and
// resolve each candidate's own location/polygon for the map.
export function buildImpactDetailView(impact, constructionExport) {
  if (!impact) return { active: false };
  const site = constructionExport?.sites?.find((s) => s.constructionSiteId === impact.constructionSiteId) ?? null;
  const LIST_FIELD = { shaft: "shaftCandidates", workArea: "workAreaCandidates", materialYard: "materialYardCandidates", accessRoad: "accessRoadCandidates", vehicleAccess: "vehicleAccessCandidates" };
  const ID_FIELD = { shaft: "shaftId", workArea: "workAreaId", materialYard: "materialYardId", accessRoad: "roadAccessId", vehicleAccess: "vehicleAccessId" };
  const resolve = (c) => {
    const found = site?.[LIST_FIELD[c.kind]]?.find((x) => x[ID_FIELD[c.kind]] === c.id);
    return { kind: c.kind, id: c.id, location: found?.location ?? c.location ?? null, polygon: found?.polygon ?? null, selected: c.id === impact.selectedResponseCandidateId };
  };
  return {
    active: true,
    eventId: impact.eventId,
    eventKind: impact.eventKind,
    eventLocation: impact.eventLocation,
    affectedPolygon: impact.affectedPolygon,
    constructionSiteId: impact.constructionSiteId,
    linkedPackagePolygon: site?.polygon ?? null,
    linkedCandidates: impact.linkedCandidateIds.map(resolve),
    alternativeCandidates: impact.alternativeCandidates.map((c) => resolve({ kind: c.kind, id: c.id, location: c.location })),
    selectedResponseCandidateId: impact.selectedResponseCandidateId,
    spatialFacts: impact.spatialFacts,
    missing: impact.unknown.map((f) => ({ field: f, reason: impact.unknownReasons[f] })),
  };
}

const trace = (ctx, pts, screen, close = false) => {
  ctx.beginPath();
  pts.map(screen).forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  if (close) ctx.closePath();
};

function marker(ctx, [x, y], style, statusStyle, locationUnknown) {
  ctx.save();
  if (locationUnknown) { ctx.setLineDash([2, 3]); ctx.globalAlpha = 0.75; }
  ctx.fillStyle = style.color;
  ctx.strokeStyle = statusStyle.ring;
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.arc(x, y, 8, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = "#111318";
  ctx.font = "bold 10px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(style.glyph, x, y + 0.5);
  if (locationUnknown) { ctx.fillStyle = statusStyle.ring; ctx.font = "bold 9px system-ui, sans-serif"; ctx.fillText("?", x + 9, y - 9); }
  ctx.restore();
}

// `screen` maps [lon, lat] to canvas pixels. `selectedEventId` (optional) draws that marker larger.
export function drawImpactMarkers(ctx, markerViews, screen, selectedEventId = null) {
  ctx.save();
  for (const mv of markerViews) {
    if (!mv.location) continue;
    const [x, y] = screen(mv.location);
    if (mv.eventId === selectedEventId) { ctx.save(); ctx.translate(x, y); ctx.scale(1.4, 1.4); ctx.translate(-x, -y); marker(ctx, [x, y], mv.style, mv.statusStyle, mv.locationUnknown); ctx.restore(); }
    else marker(ctx, [x, y], mv.style, mv.statusStyle, mv.locationUnknown);
  }
  ctx.restore();
}

const AFFECTED = "rgba(255, 230, 109, 0.28)";
const AFFECTED_LINE = "#ffe66d";
const PACKAGE_LINE = "#4cc9f0";
const LINKED = "#2dd4bf";
const ALTERNATIVE = "#8c93a4";
const SELECTED = "#2fbf71";

// Drawn above the marker layer: the selected event's affected polygon, its linked package outline, and its
// candidates (linked = solid teal, alternative = dashed grey, the player's chosen response = a green check).
export function drawImpactDetail(ctx, view, screen) {
  if (!view?.active) return;
  ctx.save();
  if (view.linkedPackagePolygon) {
    ctx.strokeStyle = PACKAGE_LINE;
    ctx.lineWidth = 3;
    ctx.setLineDash([10, 6]);
    trace(ctx, view.linkedPackagePolygon, screen, true);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  if (view.affectedPolygon) {
    ctx.fillStyle = AFFECTED;
    trace(ctx, view.affectedPolygon, screen, true);
    ctx.fill();
    ctx.strokeStyle = AFFECTED_LINE;
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  const drawCandidate = (c, color, dashed) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = c.selected ? 4 : 2;
    if (dashed) ctx.setLineDash([5, 4]);
    if (c.polygon) { trace(ctx, c.polygon, screen, true); ctx.stroke(); } else if (c.location) { const [x, y] = screen(c.location); ctx.beginPath(); ctx.arc(x, y, c.selected ? 9 : 6, 0, Math.PI * 2); ctx.stroke(); }
    ctx.setLineDash([]);
    if (c.selected) {
      const at = c.location ?? (c.polygon && c.polygon[0]);
      if (at) { const [x, y] = screen(at); ctx.fillStyle = SELECTED; ctx.font = "bold 12px system-ui, sans-serif"; ctx.textAlign = "center"; ctx.fillText("✓", x, y - 14); }
    }
  };
  for (const c of view.alternativeCandidates) drawCandidate(c, ALTERNATIVE, true);
  for (const c of view.linkedCandidates) drawCandidate(c, LINKED, false);
  ctx.restore();
}

// Player-controlled text never appears in this contract (event/candidate ids and coded kinds only), but this
// still only ever writes through textContent.
export function renderImpactPanel(container, markerViews, detailView) {
  container.replaceChildren();
  container.hidden = markerViews.length === 0 && !detailView?.active;
  const doc = container.ownerDocument;
  const el = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  if (markerViews.length) {
    container.append(el("div", "section-label", `공사 사건 ${markerViews.length}건`));
    for (const mv of markerViews) {
      const line = `${mv.style.label} · ${mv.statusStyle.label}${mv.locationUnknown ? " · 위치 미상(공구 중심점 임시 표시)" : ""}${mv.message ? ` — ${mv.message}` : ""}`;
      container.append(el("div", "diag info", line));
    }
  }
  if (detailView?.active) {
    container.append(el("div", "section-label", `선택한 사건: ${EVENT_STYLE[detailView.eventKind]?.label ?? detailView.eventKind}`));
    const f = detailView.spatialFacts;
    const num = (v, digits = 0) => (v === null || v === undefined ? "미상" : v.toLocaleString("en-US", { maximumFractionDigits: digits }));
    container.append(el("div", "diag info", `영향권 건물 ${num(f.intersectedBuildingCount)}동 · 주거지 ${f.distanceToResidentialMeters === null ? "미상" : `${num(f.distanceToResidentialMeters, 1)} m`}`));
    container.append(el("div", "diag info", `가장 가까운 주요 도로: ${f.nearestMajorRoad ? `${num(f.nearestMajorRoad.distanceMeters, 1)} m` : "미상"} · 접근 가능: ${f.majorRoadAccessible === null ? "미상" : f.majorRoadAccessible ? "예" : "아니오"}`));
    container.append(el("div", "diag info", `연결 후보 ${detailView.linkedCandidates.length}개 · 대체 후보 ${detailView.alternativeCandidates.length}개${detailView.selectedResponseCandidateId ? ` · 선택: ${detailView.selectedResponseCandidateId}` : ""}`));
    if (detailView.missing.length) container.append(el("div", "diag warning", `⚠ 미상: ${detailView.missing.map((m) => `${m.field}(${m.reason})`).join(", ")}`));
  }
}
