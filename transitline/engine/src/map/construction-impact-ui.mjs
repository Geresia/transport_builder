// Construction incidents and responses, browser side: an independent mount that needs nothing from the host page
// beyond a canvas, its projection and getters for the live ConstructionExport and the engine's report. It shows
// every event marker (all 7 kinds, coloured by status), lets the player click one to inspect it, compare its
// linked vs alternative response candidates (work area / material yard / road access / vehicle access / shaft),
// pick one as the response, or redraw the affected area by hand. It makes its own overlay canvas, panel and
// <style>, so main.mjs / index.html / style.css stay untouched. It edits only its own response document; the
// export, the engine report and every management state are read, never written.
//
//   const bridge = mountConstructionImpact({ canvas, projection, pack, getConstructionExport, getReport, onChange });
//   bridge.output()  ->  the selected event's ConstructionImpactGeometry (or null if none is selected)
import { buildConstructionImpact } from "./construction-impact.mjs";
import {
  clearResponse, responseFor, restoreImpactResponseDoc, serializeImpactResponseDoc, setCustomAffectedPolygon, setResponseCandidate,
} from "./construction-impact-editor.mjs";
import { buildImpactDetailView, buildImpactMarkerViews, drawImpactDetail, drawImpactMarkers, renderImpactPanel } from "./construction-impact-view.mjs";
import { inRing, makeSpatialContext } from "./spatial.mjs";

export const IMPACT_EVENT = "transitline:construction-impact";
const STYLE_ID = "transitline-construction-impact-style";
const CSS = `
.tl-impact-panel{position:fixed;right:12px;bottom:64px;z-index:7;width:300px;max-height:40vh;overflow:auto;padding:8px 10px;border:1px solid #2a2f3a;border-radius:8px;background:rgba(17,19,24,.92);color:#f1f2f5;font:12px Inter,system-ui,'Malgun Gothic',sans-serif}
.tl-impact-panel .section-label{margin:6px 0 3px;color:#ffe66d;font-weight:600}
.tl-impact-panel .diag{margin:3px 0;padding:3px 6px;border-left:3px solid #4895ef;border-radius:3px;font-size:11px;overflow-wrap:anywhere}
.tl-impact-panel .diag.warning{border-left-color:#ffb703}
.tl-impact-panel .diag.info{color:#aab1c0}
.tl-impact-panel button{margin:2px 3px 2px 0;padding:2px 7px}
`;
const MARKER_PX = 12;
const CANDIDATE_PX = 10;

export function mountConstructionImpact({ canvas, projection, pack, getConstructionExport, getReport, getSpatial = () => makeSpatialContext(), onChange = () => {}, enabled = true, autoRefreshMs = 250 }) {
  const doc = canvas.ownerDocument;
  const win = doc.defaultView;
  if (!doc.getElementById(STYLE_ID)) { const s = doc.createElement("style"); s.id = STYLE_ID; s.textContent = CSS; doc.head.append(s); }
  const layer = doc.createElement("canvas");
  layer.style.cssText = "position:fixed;pointer-events:none;z-index:6";
  (canvas.parentNode ?? doc.body).append(layer);
  const box = doc.createElement("div");
  box.className = "tl-impact-panel";
  box.hidden = true;
  doc.body.append(box);

  const packId = pack.manifest?.id ?? "pack";
  const storageKey = `transitline.impact-responses.v1:${packId}`;
  let stored = null;
  try { stored = win.localStorage.getItem(storageKey); } catch { /* storage may be blocked: start empty */ }
  const restored = restoreImpactResponseDoc(stored, pack);
  const responseDoc = restored.doc;
  const notes = [...restored.warnings];
  const save = () => { try { win.localStorage.setItem(storageKey, serializeImpactResponseDoc(responseDoc)); } catch { notes.push({ code: "impact-response-doc-not-saved" }); } };

  let enabledNow = enabled;
  let selectedEventId = null;
  let drawMode = null; // "custom-polygon" while the player is redrawing the affected area
  let draftPoints = [];
  let lastKey = null;
  let lastOutput = null;
  let markerViews = [];
  let detailView = { active: false };

  const screen = (loc) => projection.toScreen(loc, canvas.width, canvas.height);
  const origin = pack.manifest.origin;
  const lonLat = (x, y) => { // toScreen is affine in lon/lat, so its inverse follows from two sample points
    const o = screen(origin);
    const u = screen([origin[0] + 1, origin[1] + 1]);
    return [origin[0] + (x - o[0]) / (u[0] - o[0]), origin[1] + (y - o[1]) / (u[1] - o[1])];
  };
  const el = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const pointer = (ev) => { const r = canvas.getBoundingClientRect(); return [ev.clientX - r.left, ev.clientY - r.top]; };

  function currentImpact() {
    if (!selectedEventId) return null;
    const raw = getReport()?.constructionMarkers?.find((m) => m.eventId === selectedEventId);
    if (!raw) return null;
    const response = responseFor(responseDoc, selectedEventId);
    const drawn = {
      eventId: raw.eventId, eventKind: raw.kind, constructionSiteId: raw.constructionSiteId,
      location: Array.isArray(raw.location) ? raw.location : undefined,
      candidateRef: raw.candidateRef ?? undefined,
      selectedResponseCandidateId: response?.selectedResponseCandidateId ?? null,
      customAffectedPolygon: response?.customAffectedPolygon ?? undefined,
    };
    const { impact } = buildConstructionImpact(drawn, { pack, spatial: getSpatial(), constructionExport: getConstructionExport() });
    return impact;
  }

  function emit(output) {
    const key = JSON.stringify(output);
    if (key === lastOutput) return;
    lastOutput = key;
    onChange(output);
    canvas.dispatchEvent(new CustomEvent(IMPACT_EVENT, { detail: output }));
  }

  function refresh() {
    const exp = getConstructionExport() ?? { sites: [] };
    markerViews = buildImpactMarkerViews(getReport() ?? {}, exp);
    const impact = currentImpact();
    detailView = buildImpactDetailView(impact, exp);
    const rect = canvas.getBoundingClientRect();
    Object.assign(layer.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    const key = JSON.stringify([markerViews, detailView, draftPoints, drawMode, selectedEventId, canvas.width, canvas.height, rect.left, rect.top]);
    if (key !== lastKey) {
      lastKey = key;
      if (layer.width !== canvas.width || layer.height !== canvas.height) { layer.width = canvas.width; layer.height = canvas.height; }
      const ctx = layer.getContext("2d");
      ctx.clearRect(0, 0, layer.width, layer.height);
      drawImpactMarkers(ctx, markerViews, screen, selectedEventId);
      drawImpactDetail(ctx, detailView, screen);
      if (drawMode === "custom-polygon" && draftPoints.length) {
        ctx.save();
        ctx.strokeStyle = "#f1f2f5";
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 5]);
        ctx.beginPath();
        draftPoints.map(screen).forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = "#f1f2f5";
        for (const [x, y] of draftPoints.map(screen)) { ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2); ctx.fill(); }
        ctx.restore();
      }
      renderPanel();
    }
    emit(impact ?? null);
  }

  function renderPanel() {
    box.replaceChildren();
    box.hidden = false;
    if (selectedEventId) {
      const bar = el("div");
      const btn = (label, fn) => { const b = el("button", "", label); b.type = "button"; b.addEventListener("click", (e) => { e.stopPropagation(); fn(); }); bar.append(b); };
      if (drawMode === "custom-polygon") { btn("완료", finishDraft); btn("취소", () => { drawMode = null; draftPoints = []; refresh(); }); }
      else {
        btn("영향권 직접 수정", () => { drawMode = "custom-polygon"; draftPoints = []; refresh(); });
        if (responseFor(responseDoc, selectedEventId)?.customAffectedPolygon) btn("영향권 되돌리기", () => { setCustomAffectedPolygon(responseDoc, selectedEventId, null); save(); refresh(); });
        if (responseFor(responseDoc, selectedEventId)?.selectedResponseCandidateId) btn("응답 후보 해제", () => { setResponseCandidate(responseDoc, selectedEventId, null); save(); refresh(); });
        btn("선택 해제", () => { selectedEventId = null; refresh(); });
      }
      box.append(bar);
    }
    const panelBody = el("div");
    box.append(panelBody);
    renderImpactPanel(panelBody, markerViews, detailView);
    if (selectedEventId && detailView.active) {
      box.append(el("div", "section-label", "응답 후보 (누르면 선택)"));
      for (const c of [...detailView.linkedCandidates, ...detailView.alternativeCandidates]) {
        const row = el("div");
        const b = el("button", "", `${c.kind}${c.selected ? " ✓" : ""} · ${c.id.slice(0, 14)}…`);
        b.type = "button";
        b.addEventListener("click", (e) => { e.stopPropagation(); setResponseCandidate(responseDoc, selectedEventId, c.id); save(); refresh(); });
        row.append(b);
        box.append(row);
      }
    }
    for (const n of notes) box.append(el("div", "diag warning", `⚠ ${n.code}`));
  }

  function finishDraft() {
    if (draftPoints.length < 3) { notes.push({ code: "impact-polygon-needs-three-points" }); refresh(); return; }
    setCustomAffectedPolygon(responseDoc, selectedEventId, draftPoints);
    drawMode = null;
    draftPoints = [];
    save();
    refresh();
  }

  function pickMarker(x, y) {
    let best = null;
    for (const mv of markerViews) {
      if (!mv.location) continue;
      const [mx, my] = screen(mv.location);
      const d = Math.hypot(mx - x, my - y);
      if (d <= MARKER_PX && (!best || d < best.d)) best = { d, eventId: mv.eventId };
    }
    return best?.eventId ?? null;
  }
  function pickCandidate(x, y) {
    if (!detailView.active) return null;
    const p = [x, y];
    for (const c of [...detailView.linkedCandidates, ...detailView.alternativeCandidates]) {
      if (c.polygon) { if (inRing(p, c.polygon.map(screen))) return c.id; }
      else if (c.location) { const [cx, cy] = screen(c.location); if (Math.hypot(cx - x, cy - y) <= CANDIDATE_PX) return c.id; }
    }
    return null;
  }

  const onPointerDown = (ev) => {
    if (!enabledNow) return;
    ev.stopImmediatePropagation();
    const [x, y] = pointer(ev);
    if (drawMode === "custom-polygon" && selectedEventId) { draftPoints.push(lonLat(x, y)); refresh(); return; }
    const candidateId = pickCandidate(x, y);
    if (candidateId) { setResponseCandidate(responseDoc, selectedEventId, candidateId); save(); refresh(); return; }
    selectedEventId = pickMarker(x, y);
    refresh();
  };
  canvas.addEventListener("pointerdown", onPointerDown, true);
  const onDblClick = () => { if (enabledNow && drawMode === "custom-polygon") finishDraft(); };
  canvas.addEventListener("dblclick", onDblClick);
  const onKey = (ev) => {
    if (!enabledNow || ["INPUT", "SELECT", "TEXTAREA"].includes(doc.activeElement?.tagName)) return;
    if (ev.key === "Enter" && drawMode === "custom-polygon") finishDraft();
    else if (ev.key === "Escape") { if (drawMode) { drawMode = null; draftPoints = []; } else selectedEventId = null; refresh(); }
  };
  win.addEventListener("keydown", onKey);
  win.addEventListener("resize", refresh);
  const timer = autoRefreshMs > 0 ? win.setInterval(refresh, autoRefreshMs) : null;
  refresh();

  return {
    select(eventId) { selectedEventId = eventId; refresh(); },
    setResponse(candidateId) { if (selectedEventId) { setResponseCandidate(responseDoc, selectedEventId, candidateId); save(); } refresh(); },
    setCustomAffectedPolygon(polygon) { if (selectedEventId) { setCustomAffectedPolygon(responseDoc, selectedEventId, polygon); save(); } refresh(); },
    clearResponse(eventId = selectedEventId) { if (eventId) { clearResponse(responseDoc, eventId); save(); } refresh(); },
    output: () => currentImpact(),
    refresh,
    setEnabled(value) { enabledNow = Boolean(value); },
    get selectedEventId() { return selectedEventId; },
    get responseDoc() { return structuredClone(responseDoc); },
    destroy() {
      canvas.removeEventListener("pointerdown", onPointerDown, true);
      canvas.removeEventListener("dblclick", onDblClick);
      win.removeEventListener("keydown", onKey);
      win.removeEventListener("resize", refresh);
      if (timer !== null) win.clearInterval(timer);
      layer.remove();
      box.remove();
    },
  };
}
