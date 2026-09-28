// Work fronts and equipment access, browser side: an independent mount that needs nothing from the host page
// beyond a canvas, its projection and getters for the live ConstructionExport and the engine's report. Clicking a
// shaft or work-area candidate places (or re-selects) a work front there; a site can hold several at once. From
// there the player can pick which access-road/vehicle-access candidate serves as its equipment entry point, or
// hand-draw its assembly/storage areas. It makes its own overlay canvas, panel and <style>, so main.mjs /
// index.html / style.css stay untouched. It edits only its own work-front document; the export, the engine
// report and every management state are read, never written.
//
//   const bridge = mountConstructionWorkfront({ canvas, projection, pack, getConstructionExport, getReport, onChange });
//   bridge.output()  ->  the selected work front's ConstructionWorkfrontGeometry (or null if none is selected)
import { buildConstructionWorkfront, WORKFRONT_CANDIDATE_KINDS } from "./construction-workfront.mjs";
import {
  addWorkfront, removeWorkfront, restoreWorkfrontDoc, serializeWorkfrontDoc, setAccessCandidate, setAssemblyPolygon, setStoragePolygon, workfrontFor,
} from "./construction-workfront-editor.mjs";
import {
  buildEquipmentReportView, buildWorkfrontDetailView, buildWorkfrontMarkerViews, drawWorkfrontDetail, drawWorkfrontMarkers, renderWorkfrontPanel,
} from "./construction-workfront-view.mjs";
import { pickConstructionCandidate } from "./construction-selection.mjs";
import { makeSpatialContext } from "./spatial.mjs";

export const WORKFRONT_EVENT = "transitline:construction-workfront";
const STYLE_ID = "transitline-construction-workfront-style";
const CSS = `
.tl-workfront-panel{position:fixed;left:12px;bottom:64px;z-index:7;width:300px;max-height:40vh;overflow:auto;padding:8px 10px;border:1px solid #2a2f3a;border-radius:8px;background:rgba(17,19,24,.92);color:#f1f2f5;font:12px Inter,system-ui,'Malgun Gothic',sans-serif}
.tl-workfront-panel .section-label{margin:6px 0 3px;color:#ffe66d;font-weight:600}
.tl-workfront-panel .diag{margin:3px 0;padding:3px 6px;border-left:3px solid #4cc9f0;border-radius:3px;font-size:11px;overflow-wrap:anywhere}
.tl-workfront-panel .diag.warning{border-left-color:#ffb703}
.tl-workfront-panel .diag.info{color:#aab1c0}
.tl-workfront-panel button{margin:2px 3px 2px 0;padding:2px 7px}
`;

export function mountConstructionWorkfront({ canvas, projection, pack, getConstructionExport, getReport, getSpatial = () => makeSpatialContext(), onChange = () => {}, enabled = true, autoRefreshMs = 250 }) {
  const doc = canvas.ownerDocument;
  const win = doc.defaultView;
  if (!doc.getElementById(STYLE_ID)) { const s = doc.createElement("style"); s.id = STYLE_ID; s.textContent = CSS; doc.head.append(s); }
  const layer = doc.createElement("canvas");
  layer.style.cssText = "position:fixed;pointer-events:none;z-index:6";
  (canvas.parentNode ?? doc.body).append(layer);
  const box = doc.createElement("div");
  box.className = "tl-workfront-panel";
  box.hidden = true;
  doc.body.append(box);

  const packId = pack.manifest?.id ?? "pack";
  const storageKey = `transitline.workfronts.v1:${packId}`;
  let stored = null;
  try { stored = win.localStorage.getItem(storageKey); } catch { /* storage may be blocked: start empty */ }
  const restored = restoreWorkfrontDoc(stored, pack);
  const workfrontDoc = restored.doc;
  const notes = [...restored.warnings];
  const save = () => { try { win.localStorage.setItem(storageKey, serializeWorkfrontDoc(workfrontDoc)); } catch { notes.push({ code: "workfront-doc-not-saved" }); } };

  let enabledNow = enabled;
  let selectedWorkfrontId = null;
  let mode = null; // null | "pick-access" | "draw-assembly" | "draw-storage"
  let draftPoints = [];
  let lastKey = null;
  let lastOutput = null;
  let markerViews = [];
  let detailView = { active: false };
  let equipmentView = null;
  let builtWorkfronts = [];

  const screen = (loc) => projection.toScreen(loc, canvas.width, canvas.height);
  const origin = pack.manifest.origin;
  const lonLat = (x, y) => { // toScreen is affine in lon/lat, so its inverse follows from two sample points
    const o = screen(origin);
    const u = screen([origin[0] + 1, origin[1] + 1]);
    return [origin[0] + (x - o[0]) / (u[0] - o[0]), origin[1] + (y - o[1]) / (u[1] - o[1])];
  };
  const el = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const pointer = (ev) => { const r = canvas.getBoundingClientRect(); return [ev.clientX - r.left, ev.clientY - r.top]; };

  function buildAll() {
    const exp = getConstructionExport() ?? { sites: [] };
    const spatial = getSpatial();
    const out = [];
    for (const entry of workfrontDoc.entries) {
      const { workfront } = buildConstructionWorkfront(entry, { pack, spatial, constructionExport: exp });
      if (workfront) out.push(workfront);
    }
    return out;
  }

  function emit(output) {
    const key = JSON.stringify(output);
    if (key === lastOutput) return;
    lastOutput = key;
    onChange(output);
    canvas.dispatchEvent(new CustomEvent(WORKFRONT_EVENT, { detail: output }));
  }

  function refresh() {
    const exp = getConstructionExport() ?? { sites: [] };
    builtWorkfronts = buildAll();
    markerViews = buildWorkfrontMarkerViews(builtWorkfronts);
    const selected = selectedWorkfrontId ? builtWorkfronts.find((w) => w.workfrontId === selectedWorkfrontId) ?? null : null;
    const entry = selectedWorkfrontId ? workfrontFor(workfrontDoc, selectedWorkfrontId) : null;
    detailView = buildWorkfrontDetailView(selected, entry, exp);
    equipmentView = selected ? buildEquipmentReportView(getReport() ?? {}, selected) : null;
    const rect = canvas.getBoundingClientRect();
    Object.assign(layer.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    const key = JSON.stringify([markerViews, detailView, equipmentView, draftPoints, mode, selectedWorkfrontId, canvas.width, canvas.height, rect.left, rect.top]);
    if (key !== lastKey) {
      lastKey = key;
      if (layer.width !== canvas.width || layer.height !== canvas.height) { layer.width = canvas.width; layer.height = canvas.height; }
      const ctx = layer.getContext("2d");
      ctx.clearRect(0, 0, layer.width, layer.height);
      drawWorkfrontMarkers(ctx, markerViews, screen, selectedWorkfrontId);
      drawWorkfrontDetail(ctx, detailView, screen);
      if ((mode === "draw-assembly" || mode === "draw-storage") && draftPoints.length) {
        ctx.save();
        ctx.strokeStyle = mode === "draw-assembly" ? "#2dd4bf" : "#f4a261";
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
    emit(selected ?? null);
  }

  function renderPanel() {
    box.replaceChildren();
    box.hidden = false;
    if (selectedWorkfrontId) {
      const bar = el("div");
      const btn = (label, fn) => { const b = el("button", "", label); b.type = "button"; b.addEventListener("click", (e) => { e.stopPropagation(); fn(); }); bar.append(b); };
      if (mode === "draw-assembly" || mode === "draw-storage") { btn("완료", finishDraft); btn("취소", () => { mode = null; draftPoints = []; refresh(); }); }
      else if (mode === "pick-access") { btn("취소", () => { mode = null; refresh(); }); }
      else {
        btn("장비 반입점 선택", () => { mode = "pick-access"; refresh(); });
        btn("조립장 그리기", () => { mode = "draw-assembly"; draftPoints = []; refresh(); });
        btn("적치장 그리기", () => { mode = "draw-storage"; draftPoints = []; refresh(); });
        btn("작업면 삭제", () => { removeWorkfront(workfrontDoc, selectedWorkfrontId); save(); selectedWorkfrontId = null; refresh(); });
        btn("선택 해제", () => { selectedWorkfrontId = null; refresh(); });
      }
      box.append(bar);
    }
    if (mode === "pick-access") box.append(el("div", "diag info", "지도에서 공사용 도로 진입점 또는 차량 반입점을 클릭하세요."));
    if (mode === "draw-assembly" || mode === "draw-storage") box.append(el("div", "diag info", "점을 클릭해 영역을 그리고 완료(또는 더블클릭/Enter)를 누르세요."));
    const panelBody = el("div");
    box.append(panelBody);
    renderWorkfrontPanel(panelBody, markerViews, detailView, equipmentView);
    for (const n of notes) box.append(el("div", "diag warning", `⚠ ${n.code}`));
  }

  function finishDraft() {
    if (draftPoints.length < 3) { notes.push({ code: "workfront-polygon-needs-three-points" }); refresh(); return; }
    if (mode === "draw-assembly") setAssemblyPolygon(workfrontDoc, selectedWorkfrontId, draftPoints);
    else setStoragePolygon(workfrontDoc, selectedWorkfrontId, draftPoints);
    mode = null;
    draftPoints = [];
    save();
    refresh();
  }

  const onPointerDown = (ev) => {
    if (!enabledNow) return;
    ev.stopImmediatePropagation();
    const [x, y] = pointer(ev);
    if ((mode === "draw-assembly" || mode === "draw-storage") && selectedWorkfrontId) { draftPoints.push(lonLat(x, y)); refresh(); return; }
    const exp = getConstructionExport() ?? { sites: [] };
    const pick = pickConstructionCandidate(exp, screen, x, y);
    if (!pick) return;
    if (mode === "pick-access") {
      if (["accessRoad", "vehicleAccess"].includes(pick.kind) && selectedWorkfrontId) {
        setAccessCandidate(workfrontDoc, selectedWorkfrontId, { kind: pick.kind, id: pick.id });
        save();
        mode = null;
      }
      refresh();
      return;
    }
    if (WORKFRONT_CANDIDATE_KINDS.includes(pick.kind)) {
      const entry = addWorkfront(workfrontDoc, { constructionSiteId: pick.constructionSiteId, candidateRef: { kind: pick.kind, id: pick.id } });
      save();
      selectedWorkfrontId = entry.workfrontId;
      refresh();
    }
  };
  canvas.addEventListener("pointerdown", onPointerDown, true);
  const onDblClick = () => { if (enabledNow && (mode === "draw-assembly" || mode === "draw-storage")) finishDraft(); };
  canvas.addEventListener("dblclick", onDblClick);
  const onKey = (ev) => {
    if (!enabledNow || ["INPUT", "SELECT", "TEXTAREA"].includes(doc.activeElement?.tagName)) return;
    if (ev.key === "Enter" && (mode === "draw-assembly" || mode === "draw-storage")) finishDraft();
    else if (ev.key === "Escape") { if (mode) { mode = null; draftPoints = []; } else selectedWorkfrontId = null; refresh(); }
  };
  win.addEventListener("keydown", onKey);
  win.addEventListener("resize", refresh);
  const timer = autoRefreshMs > 0 ? win.setInterval(refresh, autoRefreshMs) : null;
  refresh();

  return {
    select(workfrontId) { selectedWorkfrontId = workfrontId; refresh(); },
    addWorkfront(constructionSiteId, candidateRef) { const e = addWorkfront(workfrontDoc, { constructionSiteId, candidateRef }); save(); selectedWorkfrontId = e.workfrontId; refresh(); return e.workfrontId; },
    removeWorkfront(workfrontId = selectedWorkfrontId) { if (workfrontId) { removeWorkfront(workfrontDoc, workfrontId); if (workfrontId === selectedWorkfrontId) selectedWorkfrontId = null; save(); } refresh(); },
    setAccessCandidate(candidateRef) { if (selectedWorkfrontId) { setAccessCandidate(workfrontDoc, selectedWorkfrontId, candidateRef); save(); } refresh(); },
    setAssemblyPolygon(polygon) { if (selectedWorkfrontId) { setAssemblyPolygon(workfrontDoc, selectedWorkfrontId, polygon); save(); } refresh(); },
    setStoragePolygon(polygon) { if (selectedWorkfrontId) { setStoragePolygon(workfrontDoc, selectedWorkfrontId, polygon); save(); } refresh(); },
    output: () => (selectedWorkfrontId ? builtWorkfronts.find((w) => w.workfrontId === selectedWorkfrontId) ?? null : null),
    // Replaces the whole document (e.g. from a host game's own integrated save) — same validation as opening a
    // saved document normally (wrong pack / pack-version mismatch / unreadable all surface as warnings, never a throw).
    loadDoc(doc) {
      const restored = restoreWorkfrontDoc(doc ? JSON.stringify(doc) : null, pack);
      notes.push(...restored.warnings);
      for (const key of Object.keys(workfrontDoc)) delete workfrontDoc[key];
      Object.assign(workfrontDoc, restored.doc);
      selectedWorkfrontId = null;
      save();
      refresh();
    },
    refresh,
    setEnabled(value) { enabledNow = Boolean(value); },
    get selectedWorkfrontId() { return selectedWorkfrontId; },
    get workfrontDoc() { return structuredClone(workfrontDoc); },
    get builtWorkfronts() { return builtWorkfronts; },
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
