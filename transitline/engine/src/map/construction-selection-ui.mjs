// Construction-site candidate selection, browser side: an independent mount that needs nothing from the host page
// beyond a canvas, its projection and a getter for the current ConstructionExport. It makes its own overlay
// canvas (highlight, above the map, never taking input), its own read-only panel and its own <style>.
//
//   const bridge = mountConstructionSelection({ canvas, projection, getConstructionExport: () => constructionUi.constructionExport,
//                                                onChange: (output) => ... });
//   bridge.output()  ->  { constructionSiteId, kind, candidateId, facts }
//
// The output also goes out as a DOM event `transitline:construction-selection` on the canvas (detail = the
// output). While enabled the bridge owns the pointer on the canvas (capture phase), like the other map editors:
// switch it off with setEnabled(false) when another tool is drawing. It edits nothing but its own selection; the
// export and every management state are read, never written.
import {
  applyConstructionPick, clearConstructionSelection, cloneConstructionSelection, createConstructionSelection,
  pickConstructionCandidate, pruneConstructionSelection, restoreConstructionSelection, selectConstructionCandidate, constructionSelectionOutput,
} from "./construction-selection.mjs";
import { buildConstructionSelectionView, drawConstructionSelection, renderConstructionSelectionPanel } from "./construction-selection-view.mjs";

export const CONSTRUCTION_SELECTION_EVENT = "transitline:construction-selection";
const STYLE_ID = "transitline-construction-selection-style";
const CSS = `
.tl-construction-selection-panel{position:fixed;left:12px;bottom:64px;z-index:7;width:270px;max-height:32vh;overflow:auto;padding:8px 10px;border:1px solid #2a2f3a;border-radius:8px;background:rgba(17,19,24,.92);color:#f1f2f5;font:12px Inter,system-ui,'Malgun Gothic',sans-serif}
.tl-construction-selection-panel .section-label{margin:6px 0 3px;color:#ffe66d;font-weight:600}
.tl-construction-selection-panel .diag{margin:3px 0;padding:3px 6px;border-left:3px solid #4895ef;border-radius:3px;font-size:11px;overflow-wrap:anywhere}
.tl-construction-selection-panel .diag.warning{border-left-color:#ffb703}
.tl-construction-selection-panel .diag.info{color:#aab1c0}
`;

export function mountConstructionSelection({ canvas, projection, getConstructionExport, panel = null, onChange = () => {}, enabled = true, autoRefreshMs = 200 }) {
  const doc = canvas.ownerDocument;
  const win = doc.defaultView;
  if (!doc.getElementById(STYLE_ID)) { const s = doc.createElement("style"); s.id = STYLE_ID; s.textContent = CSS; doc.head.append(s); }
  const layer = doc.createElement("canvas");
  layer.style.cssText = "position:fixed;pointer-events:none;z-index:6";
  (canvas.parentNode ?? doc.body).append(layer);
  const box = panel ?? Object.assign(doc.createElement("div"), { className: "tl-construction-selection-panel", hidden: true });
  if (!panel) doc.body.append(box);

  const selection = createConstructionSelection();
  let enabledNow = enabled;
  let lastKey = null;
  let lastOutput = null;
  let warnings = [];
  const screen = (loc) => projection.toScreen(loc, canvas.width, canvas.height);
  const exportNow = () => getConstructionExport() ?? { sites: [] };

  function emit(output) {
    const key = JSON.stringify(output);
    if (key === lastOutput) return;
    lastOutput = key;
    onChange(output);
    canvas.dispatchEvent(new CustomEvent(CONSTRUCTION_SELECTION_EVENT, { detail: output }));
  }

  function refresh() {
    const exp = exportNow();
    warnings = pruneConstructionSelection(selection, exp);
    const view = buildConstructionSelectionView(exp, selection);
    const rect = canvas.getBoundingClientRect();
    Object.assign(layer.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    const key = JSON.stringify([view, canvas.width, canvas.height, rect.left, rect.top]);
    if (key !== lastKey) {
      lastKey = key;
      if (layer.width !== canvas.width || layer.height !== canvas.height) { layer.width = canvas.width; layer.height = canvas.height; }
      const ctx = layer.getContext("2d");
      ctx.clearRect(0, 0, layer.width, layer.height);
      drawConstructionSelection(ctx, view, screen);
      renderConstructionSelectionPanel(box, view);
    }
    emit(view.output);
    return view.output;
  }

  const onPointerDown = (ev) => {
    if (!enabledNow) return;
    ev.stopImmediatePropagation();
    const r = canvas.getBoundingClientRect();
    applyConstructionPick(selection, exportNow(), pickConstructionCandidate(exportNow(), screen, ev.clientX - r.left, ev.clientY - r.top));
    refresh();
  };
  const onKey = (ev) => { if (enabledNow && ev.key === "Escape" && !["INPUT", "SELECT", "TEXTAREA"].includes(doc.activeElement?.tagName)) { clearConstructionSelection(selection); refresh(); } };
  canvas.addEventListener("pointerdown", onPointerDown, true);
  win.addEventListener("keydown", onKey);
  win.addEventListener("resize", refresh);
  const timer = autoRefreshMs > 0 ? win.setInterval(refresh, autoRefreshMs) : null;
  refresh();

  return {
    select(kind, id) { const done = selectConstructionCandidate(selection, exportNow(), kind, id); refresh(); return done; },
    clear() { clearConstructionSelection(selection); return refresh(); },
    restore(output) { const r = restoreConstructionSelection(output, exportNow()); Object.assign(selection, r.selection); refresh(); return r.warnings; },
    output: () => constructionSelectionOutput(selection, exportNow()),
    view: () => buildConstructionSelectionView(exportNow(), selection),
    refresh,
    setEnabled(value) { enabledNow = Boolean(value); },
    get selection() { return cloneConstructionSelection(selection); },
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
