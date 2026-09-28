// Selection bridge, browser side: an independent mount that needs nothing from the host page beyond a canvas, its
// projection and two getters. It makes its own overlay canvas (highlights, above the map, never taking input),
// its own read-only panel and its own <style>, so main.mjs / index.html / style.css stay untouched.
//
//   const bridge = mountStationSelection({ canvas, projection, getStationExport: () => stationUi.stationExport,
//                                          getOverlay: () => state.mapOverlay, onChange: (output) => ... });
//   bridge.output()  ->  { stationSiteId, selectedEntranceIds[], selectedTransferIds[], selectedWorkAreaId, ... }
//
// The output also goes out as a DOM event `transitline:station-selection` on the canvas (detail = the output), for a
// UI that would rather listen than import. While enabled the bridge owns the pointer on the canvas (capture phase),
// like the other map editors: switch it off with setEnabled(false) when another tool is drawing.
// It edits nothing but its own selection; the export, the report and every management state are read, never written.
import {
  applyPick, clearSelection, cloneSelection, createStationSelection, pickStationItem, pruneSelection, restoreSelection, selectItem, selectionOutput,
} from "./station-selection.mjs";
import { buildSelectionView, drawStationSelection, renderSelectionPanel } from "./station-selection-view.mjs";

export const SELECTION_EVENT = "transitline:station-selection";
const STYLE_ID = "transitline-station-selection-style";
const CSS = `
.tl-selection-panel{position:fixed;left:12px;bottom:64px;z-index:7;width:290px;max-height:40vh;overflow:auto;padding:8px 10px;border:1px solid #2a2f3a;border-radius:8px;background:rgba(17,19,24,.92);color:#f1f2f5;font:12px Inter,system-ui,'Malgun Gothic',sans-serif}
.tl-selection-panel .section-label{margin:6px 0 3px;color:#ffe66d;font-weight:600}
.tl-selection-panel .diag{margin:3px 0;padding:3px 6px;border-left:3px solid #4895ef;border-radius:3px;font-size:11px;overflow-wrap:anywhere}
.tl-selection-panel .diag.error{border-left-color:#e5484d}
.tl-selection-panel .diag.warning{border-left-color:#ffb703}
.tl-selection-panel .diag.info{color:#aab1c0}
`;

export function mountStationSelection({ canvas, projection, getStationExport, getOverlay = () => null, panel = null, onChange = () => {}, enabled = true, autoRefreshMs = 200 }) {
  const doc = canvas.ownerDocument;
  const win = doc.defaultView;
  if (!doc.getElementById(STYLE_ID)) { const s = doc.createElement("style"); s.id = STYLE_ID; s.textContent = CSS; doc.head.append(s); }
  const layer = doc.createElement("canvas");
  layer.style.cssText = "position:fixed;pointer-events:none;z-index:6";
  (canvas.parentNode ?? doc.body).append(layer);
  const box = panel ?? Object.assign(doc.createElement("div"), { className: "tl-selection-panel", hidden: true });
  if (!panel) doc.body.append(box);

  const selection = createStationSelection();
  let enabledNow = enabled;
  let lastKey = null;
  let lastOutput = null;
  let warnings = [];
  const screen = (loc) => projection.toScreen(loc, canvas.width, canvas.height);
  const exportNow = () => getStationExport() ?? { sites: [] };

  function emit(output) {
    const key = JSON.stringify(output);
    if (key === lastOutput) return;
    lastOutput = key;
    onChange(output);
    canvas.dispatchEvent(new CustomEvent(SELECTION_EVENT, { detail: output }));
  }

  function refresh() {
    const exp = exportNow();
    warnings = pruneSelection(selection, exp);
    const view = buildSelectionView(exp, selection, getOverlay());
    const rect = canvas.getBoundingClientRect();
    Object.assign(layer.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    const key = JSON.stringify([view, canvas.width, canvas.height, rect.left, rect.top]);
    if (key !== lastKey) { // redraw only when something the highlight shows has changed
      lastKey = key;
      if (layer.width !== canvas.width || layer.height !== canvas.height) { layer.width = canvas.width; layer.height = canvas.height; }
      const ctx = layer.getContext("2d");
      ctx.clearRect(0, 0, layer.width, layer.height);
      drawStationSelection(ctx, view, screen);
      renderSelectionPanel(box, view);
    }
    emit(view.output);
    return view.output;
  }

  const onPointerDown = (ev) => {
    if (!enabledNow) return;
    ev.stopImmediatePropagation();
    const r = canvas.getBoundingClientRect();
    const exp = exportNow();
    applyPick(selection, exp, pickStationItem(exp, screen, ev.clientX - r.left, ev.clientY - r.top), { additive: ev.shiftKey || ev.ctrlKey || ev.metaKey });
    refresh();
  };
  const onKey = (ev) => { if (enabledNow && ev.key === "Escape" && !["INPUT", "SELECT", "TEXTAREA"].includes(doc.activeElement?.tagName)) { clearSelection(selection); refresh(); } };
  canvas.addEventListener("pointerdown", onPointerDown, true);
  win.addEventListener("keydown", onKey);
  win.addEventListener("resize", refresh);
  const timer = autoRefreshMs > 0 ? win.setInterval(refresh, autoRefreshMs) : null;
  refresh();

  return {
    select(kind, id, options) { const done = selectItem(selection, exportNow(), kind, id, options); refresh(); return done; },
    clear() { clearSelection(selection); return refresh(); },
    restore(output) { const r = restoreSelection(output, exportNow()); Object.assign(selection, r.selection); refresh(); return r.warnings; },
    output: () => selectionOutput(selection, exportNow()),
    view: () => buildSelectionView(exportNow(), selection, getOverlay()),
    refresh,
    setEnabled(value) { enabledNow = Boolean(value); },
    get selection() { return cloneSelection(selection); },
    get warnings() { return structuredClone(warnings); },
    destroy() {
      canvas.removeEventListener("pointerdown", onPointerDown, true);
      win.removeEventListener("keydown", onKey);
      win.removeEventListener("resize", refresh);
      if (timer !== null) win.clearInterval(timer);
      layer.remove();
      if (!panel) box.remove();
    },
  };
}
