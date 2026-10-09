// New-town development editor, browser side: an independent mount that needs nothing from the host page beyond a canvas, its projection,
// a pack and two getters (the map export - planned stations and segments, existing stations and lines - and the spatial layers).  The
// player creates development areas and their phases, draws and edits the polygons, switches areas and phases off and on, reorders the
// phases, declares a land use and a delivery order, names station sites and rail lines, and reads the spatial FACTS the map holds for the
// phase they picked.  The mount keeps the document in memory only: serialize() gives the host a string to keep and loadDoc() takes it
// back (another pack's document, an unreadable one or one of an unknown version is refused and the current document stays).  It builds
// the facts with new-town-development.mjs and edits with new-town-development-editor.mjs; it makes its own overlay, panel and <style>,
// reads the map export and the layers, and writes nothing but its own document.  It shows no figure about people, homes, jobs, demand,
// traffic, cost, occupancy or schedule - none is made - and a distance to a rail line is never shown as a connection.
//
//   const bridge = mountNewTownDevelopment({ canvas, projection, pack, getMapExport, getSpatial, onChange, enabled, autoRefreshMs });
//   bridge.output()  ->  { document, export, selected, warnings }
import { buildNewTownDevelopmentExport, keyedDevelopmentId, keyedPhaseId } from "./new-town-development.mjs";
import {
  activePhases, addDevelopment, addPhase, deactivateDevelopment, deactivatePhase, drawnDevelopmentsOf, insertVertex, moveVertex, newNewTownDoc, removeDevelopment as editRemoveDevelopment, removePhase as editRemovePhase,
  removeVertex as editRemoveVertex, reorderPhase as editReorderPhase, restoreDevelopment, restoreNewTownDoc, restorePhase, serializeNewTownDoc, setPolygon, setRailRefs, setStationRefs, updateDevelopment, updatePhase,
} from "./new-town-development-editor.mjs";
import { buildNewTownDevelopmentView, drawNewTownDevelopmentOverlay } from "./new-town-development-view.mjs";
import { renderNewTownDevelopmentPanel } from "./new-town-development-panel.mjs";
import { REASON_LABELS, WARNING_LABELS, hitEdge, hitPhase, hitRail, hitStation, hitVertex, mapRailLines, mapStations, parseNumber, sameRef, shortId } from "./new-town-development-tools.mjs";
import { clone, createShell } from "./map-mount-kit.mjs";
import { makeSpatialContext } from "./spatial.mjs";

export const NEW_TOWN_UI_EVENT = "transitline:new-town-development";
const STYLE_ID = "transitline-new-town-development-style";
const CSS = `
.tl-nt-panel{position:fixed;left:12px;top:64px;z-index:7;width:372px;max-height:80vh;overflow:auto;padding:8px 10px;border:1px solid #2a2f3a;border-radius:8px;background:rgba(17,19,24,.95);color:#f1f2f5;font:12px/1.4 system-ui,'Malgun Gothic',sans-serif}
.tl-nt-panel .section-label{margin:8px 0 3px;color:#2dd4bf;font-weight:600}
.tl-nt-panel .diag{margin:3px 0;padding:3px 6px;border-left:3px solid #4cc9f0;border-radius:3px;font-size:11px;overflow-wrap:anywhere}
.tl-nt-panel .diag.warning{border-left-color:#ffb703}.tl-nt-panel .diag.info{color:#aab1c0}
.tl-nt-panel .fact{margin:1px 0;font-size:11px;overflow-wrap:anywhere}.tl-nt-panel .fact.sub{margin-left:10px;color:#aab1c0}
.tl-nt-panel .row{display:flex;align-items:center;gap:4px;margin:2px 0;flex-wrap:wrap}.tl-nt-panel .row.picked{background:rgba(255,255,255,.08)}
.tl-nt-panel label.field{display:inline-flex;align-items:center;gap:4px;margin:2px 0}.tl-nt-panel input[type=text]{max-width:200px;background:#1b1e26;color:#f1f2f5;border:1px solid #3a4152;border-radius:4px;padding:1px 4px}
.tl-nt-panel input.narrow{width:56px}.tl-nt-panel button{margin:2px 3px 2px 0;padding:2px 7px}
`;
const NO_SELECTION = () => ({ developmentKey: null, phaseKey: null, vertexIndex: null });

export function mountNewTownDevelopment({ canvas, projection, pack, getMapExport = () => ({}), getSpatial = () => null, onChange = () => {}, enabled = true, autoRefreshMs = 250 }) {
  const shell = createShell({ canvas, projection, pack, styleId: STYLE_ID, css: CSS, panelClass: "tl-nt-panel" });
  const { box, screen, el, pointer } = shell;
  const packId = pack.manifest?.id ?? "pack";
  const notes = [];
  let doc = newNewTownDoc(packId, pack.manifest?.version ?? null);

  let enabledNow = enabled;
  let selection = NO_SELECTION();
  let mode = null; // "draw" | "pick-station" | "pick-rail"
  let draft = null; // { points: [lon, lat][], target: { developmentKey, phaseKey } }
  let drag = null; // { index, moved }
  const drafts = { stationId: "" };
  let version = 0;
  let dirty = true;
  let panelVersion = -1;
  let drawVersion = -1;
  let outputVersion = -1;
  let lastRect = "";
  let lastFingerprint = null;
  let built = { map: { plans: [], externalNetworks: [] }, exportData: { developments: [], warnings: [] }, stations: [], railLines: [], model: null };

  const bump = () => { version += 1; };
  const note = (code, extra = {}) => { const last = notes.at(-1); if (!last || last.code !== code || last.message !== extra.message) notes.push({ code, ...extra }); bump(); };
  const devDoc = (key = selection.developmentKey) => doc.developments.find((d) => d.key === key && !d.deleted) ?? null;
  const phaseDoc = () => devDoc()?.phases.find((p) => p.key === selection.phaseKey && !p.deleted) ?? null;
  const devOut = () => (selection.developmentKey ? built.exportData.developments.find((d) => d.developmentId === keyedDevelopmentId(packId, selection.developmentKey)) ?? null : null);
  const phaseOut = () => devOut()?.phases.find((p) => p.phaseId === keyedPhaseId(devOut().developmentId, selection.phaseKey)) ?? null;

  // --- inputs: only read ---
  const mapNow = () => { const m = getMapExport?.(); return { plans: Array.isArray(m?.plans) ? m.plans : [], externalNetworks: Array.isArray(m?.externalNetworks) ? m.externalNetworks : [] }; };
  const fingerprint = (map, spatial) => JSON.stringify([
    map.plans.map((p) => [p.planId, (p.stationCandidates ?? []).length, (p.segments ?? []).length, p.stationCandidates?.[0]?.location ?? null, p.stationCandidates?.at(-1)?.location ?? null]),
    map.externalNetworks.map((n) => [n.id, (n.stations ?? []).length, (n.lines ?? []).length]),
    Object.keys(spatial.layers ?? {}).sort().map((k) => [k, spatial.layers[k]?.items?.length ?? null, spatial.layers[k]?.source?.name ?? null]),
  ]);

  function pickOverlay() {
    const refs = phaseDoc();
    if (mode === "pick-station") return { kind: "station", stations: built.stations.map((s) => ({ location: s.location, picked: (refs?.stationRefs ?? []).some((r) => r.stationId === s.stationId && r.stationKind === s.stationKind) })) };
    if (mode === "pick-rail") return { kind: "rail", lines: built.railLines.map((l) => ({ line: l.line, picked: (refs?.railRefs ?? []).some((r) => sameRef(r, l.ref)) })) };
    return null;
  }
  const rebuildModel = () => { built.model = buildNewTownDevelopmentView({ doc, exportData: built.exportData, selection, mode, draft, pick: pickOverlay() }); };
  const touchView = () => { rebuildModel(); bump(); };
  function recompute(map, spatial) {
    const exportData = buildNewTownDevelopmentExport({ pack, mapExport: map, developments: drawnDevelopmentsOf(doc), spatial });
    built = { map, exportData, stations: mapStations(map), railLines: mapRailLines(map), model: null };
    rebuildModel();
    bump();
  }

  // --- what the mount tells the host ---
  const layersMissing = (phase) => {
    const missing = {};
    for (const f of phase.unknown) { const r = phase.unknownReasons[f]; if (r === "no-layer" || r === "outside-coverage") (missing[r] ??= []).push(f); }
    return Object.entries(missing);
  };
  function collectWarnings() {
    const out = clone(notes);
    out.push(...clone(built.exportData.warnings));
    for (const d of built.exportData.developments) {
      for (const w of d.warnings) out.push({ ...clone(w), developmentId: d.developmentId });
      for (const p of d.phases) {
        for (const w of p.warnings) out.push({ ...clone(w), developmentId: d.developmentId, phaseId: p.phaseId });
        for (const [reason, fields] of layersMissing(p)) out.push({ code: "layer-missing", reason, fields, developmentId: d.developmentId, phaseId: p.phaseId });
      }
    }
    return out;
  }
  function selectedOut() {
    const d = devDoc();
    if (!d) return null;
    return { developmentKey: d.key, phaseKey: phaseDoc()?.key ?? null, vertexIndex: selection.vertexIndex, mode, development: clone(devOut()), phase: clone(phaseOut()) };
  }
  function outputNow() { return { document: clone(doc), export: clone(built.exportData), selected: selectedOut(), warnings: collectWarnings() }; }
  function emit() {
    if (outputVersion === version) return;
    outputVersion = version;
    const out = outputNow();
    onChange(out);
    canvas.dispatchEvent(new CustomEvent(NEW_TOWN_UI_EVENT, { detail: out }));
  }
  // the warnings the panel lists: the mount's own notes, the export's, and those of what the player has picked
  function panelWarnings() {
    const picked = devOut();
    const phase = phaseOut();
    const list = [...notes, ...built.exportData.warnings, ...(picked?.warnings ?? []), ...(phase?.warnings ?? [])];
    const lines = list.map((w) => ({ text: `${WARNING_LABELS[w.code] ?? w.code}${w.message ? `: ${w.message}` : ""}${w.stationId ? ` (${shortId(w.stationId)})` : ""}${w.value ? ` (${w.value})` : ""}` }));
    if (phase) for (const [reason, fields] of layersMissing(phase)) lines.push({ text: `레이어 결측 (${REASON_LABELS[reason]}): ${fields.join(", ")} → 미상으로 표시` });
    return [...new Map(lines.map((l) => [l.text, l])).values()];
  }

  // --- the edit: one place that applies it and says so when the editor refuses ---
  function edit(fn) {
    try { const r = fn(); dirty = true; bump(); refresh(); return r ?? true; } catch (error) { note("new-town-edit-refused", { message: error.message }); refresh(); return false; }
  }
  const needPhase = () => { const p = phaseDoc(); if (!p) throw new Error("No phase is selected"); return p; };
  const clearDraw = () => { mode = null; draft = null; };

  // --- actions ---
  function select(developmentKey, phaseKey = null) { selection = { developmentKey, phaseKey, vertexIndex: null }; clearDraw(); drag = null; touchView(); refresh(); }
  function createDevelopment() { return edit(() => { const d = addDevelopment(doc, { name: `신도시 ${doc.developments.length + 1}` }); selection = { developmentKey: d.key, phaseKey: null, vertexIndex: null }; clearDraw(); }); }
  function createPhase() {
    return edit(() => {
      const d = devDoc();
      if (!d) throw new Error("No development is selected");
      const p = addPhase(doc, d.key, { name: `단계 ${d.phases.length + 1}` });
      selection = { developmentKey: d.key, phaseKey: p.key, vertexIndex: null };
      clearDraw();
    });
  }
  const rename = (text) => (text.trim() === "" ? null : text.trim());
  const renameDevelopment = (text) => edit(() => { updateDevelopment(doc, devDoc().key, { name: rename(text) }); });
  const renamePhase = (text) => edit(() => { updatePhase(doc, selection.developmentKey, needPhase().key, { name: rename(text) }); });
  const toggleDevelopment = (key) => edit(() => { (devDoc(key).active !== false ? deactivateDevelopment : restoreDevelopment)(doc, key); });
  const togglePhase = (developmentKey, key) => edit(() => { const p = devDoc(developmentKey).phases.find((x) => x.key === key && !x.deleted); (p.active !== false ? deactivatePhase : restorePhase)(doc, developmentKey, key); });
  const removeDevelopment = (key) => edit(() => { editRemoveDevelopment(doc, key); if (selection.developmentKey === key) { selection = NO_SELECTION(); clearDraw(); } });
  const removePhase = (developmentKey, key) => edit(() => { editRemovePhase(doc, developmentKey, key); if (selection.phaseKey === key && selection.developmentKey === developmentKey) { selection = { developmentKey, phaseKey: null, vertexIndex: null }; clearDraw(); } });
  const reorderPhase = (key, delta) => edit(() => {
    const d = devDoc();
    const live = activePhases(d);
    const i = live.findIndex((p) => p.key === key);
    const to = i + delta;
    if (i < 0 || to < 0 || to >= live.length) return;
    editReorderPhase(doc, d.key, key, to);
  });
  const setLandUse = (text) => edit(() => { updatePhase(doc, selection.developmentKey, needPhase().key, { playerDeclaredLandUse: text.trim() === "" ? null : text }); });
  const setDeliveryOrder = (text) => edit(() => {
    const value = parseNumber(text);
    if (Number.isNaN(value)) throw new Error("A delivery order is a whole number from 1");
    updatePhase(doc, selection.developmentKey, needPhase().key, { playerDeclaredDeliveryOrder: value === undefined ? null : value });
  });

  // --- the polygon ---
  function startDraw() {
    if (!phaseDoc()) { note("new-town-edit-refused", { message: "No phase is selected" }); refresh(); return false; }
    mode = "draw";
    draft = { points: [], target: { developmentKey: selection.developmentKey, phaseKey: selection.phaseKey } };
    selection.vertexIndex = null;
    touchView(); refresh();
    return true;
  }
  function addDraftPoint(at) { draft.points.push(at); touchView(); refresh(); }
  function finishDraw() {
    if (!draft) return false;
    if (draft.points.length < 3) { note("polygon-needs-three-points"); touchView(); refresh(); return false; }
    return edit(() => { const t = draft.target; setPolygon(doc, t.developmentKey, t.phaseKey, draft.points); clearDraw(); });
  }
  function cancelDraw() { clearDraw(); touchView(); refresh(); }
  const removeVertexNow = () => edit(() => {
    if (selection.vertexIndex === null) throw new Error("No vertex is selected");
    editRemoveVertex(doc, selection.developmentKey, needPhase().key, selection.vertexIndex);
    selection.vertexIndex = null;
  });
  const deselectVertex = () => { selection.vertexIndex = null; touchView(); refresh(); };

  // --- station sites and rail lines the player names (taking the last one away goes back to "not stated", it does not declare "none") ---
  const setPick = (next) => { mode = next; draft = null; touchView(); refresh(); };
  const stationRefsOf = () => needPhase().stationRefs ?? [];
  const railRefsOf = () => needPhase().railRefs ?? [];
  const orNotStated = (list) => (list.length ? list : null);
  const addStationRef = (s) => edit(() => {
    const cur = stationRefsOf();
    if (cur.some((r) => r.stationId === s.stationId && r.stationKind === s.stationKind)) return;
    setStationRefs(doc, selection.developmentKey, selection.phaseKey, [...cur, { stationId: s.stationId, stationKind: s.stationKind }]);
  });
  const removeStationRef = (i) => edit(() => { setStationRefs(doc, selection.developmentKey, selection.phaseKey, orNotStated(stationRefsOf().filter((_, k) => k !== i))); });
  const addRailRef = (ref) => edit(() => {
    const cur = railRefsOf();
    if (cur.some((r) => sameRef(r, ref))) return;
    setRailRefs(doc, selection.developmentKey, selection.phaseKey, [...cur, { ...ref }]);
  });
  const removeRailRef = (i) => edit(() => { setRailRefs(doc, selection.developmentKey, selection.phaseKey, orNotStated(railRefsOf().filter((_, k) => k !== i))); });
  function addStationById() {
    const id = drafts.stationId.trim();
    const matches = built.stations.filter((s) => s.stationId === id);
    if (!id || matches.length !== 1) { note("new-town-edit-refused", { message: !id ? "역 ID를 입력하세요" : matches.length ? "같은 ID의 역이 여럿입니다" : "지도에서 찾을 수 없는 역 ID입니다" }); refresh(); return false; }
    drafts.stationId = "";
    return addStationRef(matches[0]);
  }

  const act = {
    createDevelopment, selectDevelopment: (key) => select(key), toggleDevelopment, removeDevelopment, renameDevelopment, createPhase, selectPhase: (d, p) => select(d, p), togglePhase, removePhase, reorderPhase, renamePhase, setLandUse, setDeliveryOrder,
    startDraw, finishDraw, cancelDraw, removeVertex: removeVertexNow, deselectVertex, setMode: (next) => setPick(next),
    removeStationRef, declareNoStations: () => edit(() => { setStationRefs(doc, selection.developmentKey, needPhase().key, []); }), clearStations: () => edit(() => { setStationRefs(doc, selection.developmentKey, needPhase().key, null); }),
    draftStationId: (v) => { drafts.stationId = v; }, addStationById,
    removeRailRef, declareNoRail: () => edit(() => { setRailRefs(doc, selection.developmentKey, needPhase().key, []); }), clearRail: () => edit(() => { setRailRefs(doc, selection.developmentKey, needPhase().key, null); }),
  };
  const helpers = {
    el, button: shell.button,
    input(parent, caption, value, onInput, { narrow = false } = {}) {
      const wrap = el("label", "field");
      wrap.append(el("span", "", caption));
      const inp = el("input", narrow ? "narrow" : "");
      inp.type = "text";
      inp.value = value ?? "";
      inp.addEventListener("change", () => onInput(inp.value));
      wrap.append(inp);
      parent.append(wrap);
      return inp;
    },
  };

  function renderPanel() {
    const scrolled = box.scrollTop; // a rebuilt panel keeps the place the player was working at
    box.replaceChildren();
    box.hidden = !enabledNow;
    if (!enabledNow) return;
    renderNewTownDevelopmentPanel(box, helpers, {
      act, mode, drafts, draftCount: draft?.points.length ?? 0, model: built.model, warnings: panelWarnings(), devDoc: devDoc(), phaseDoc: phaseDoc(), devOut: devOut(), phaseOut: phaseOut(), vertexIndex: selection.vertexIndex,
      map: { stations: built.stations.length, railLines: built.railLines.length },
      removed: { developments: doc.developments.filter((d) => d.deleted).length, phases: devDoc() ? devDoc().phases.filter((p) => p.deleted).length : 0 },
    });
    if (scrolled) box.scrollTop = scrolled;
  }
  function drawLayer() {
    const rectKey = shell.fit(enabledNow);
    if (drawVersion === version && rectKey === lastRect) return;
    drawVersion = version;
    lastRect = rectKey;
    const ctx = shell.layer.getContext("2d");
    ctx.clearRect(0, 0, shell.layer.width, shell.layer.height);
    if (!enabledNow || !built.model) return;
    drawNewTownDevelopmentOverlay(ctx, built.model, screen);
  }

  // an id the document no longer holds leaves the selection
  function pruneSelection() {
    const before = JSON.stringify(selection);
    if (selection.developmentKey && !devDoc()) selection = NO_SELECTION();
    else if (selection.phaseKey && !phaseDoc()) selection = { developmentKey: selection.developmentKey, phaseKey: null, vertexIndex: null };
    else if (selection.vertexIndex !== null && selection.vertexIndex >= (phaseDoc()?.polygon?.length ?? 0)) selection.vertexIndex = null;
    if (JSON.stringify(selection) !== before) { if (!selection.phaseKey && mode !== "draw") clearDraw(); touchView(); }
  }
  function refresh({ force = false, keepPanel = false } = {}) {
    const map = mapNow();
    const spatial = getSpatial?.() ?? makeSpatialContext();
    const fp = fingerprint(map, spatial);
    if (dirty || force || fp !== lastFingerprint) { lastFingerprint = fp; dirty = false; recompute(map, spatial); }
    pruneSelection();
    drawLayer();
    if (keepPanel) panelVersion = version;
    if (panelVersion !== version) { panelVersion = version; renderPanel(); }
    emit();
  }

  // --- pointer, keyboard: a click is taken only when it picks something (or a mode is on); every other click goes on to the map ---
  const take = (ev) => ev.stopImmediatePropagation?.();
  const onPointerDown = (ev) => {
    if (!enabledNow) return;
    const p = pointer(ev);
    if (mode === "draw") { take(ev); addDraftPoint(shell.lonLat(...p)); return; }
    if (mode === "pick-station") { take(ev); const s = hitStation(built.stations, screen, p); if (s) addStationRef(s); return; }
    if (mode === "pick-rail") { take(ev); const l = hitRail(built.railLines, screen, p); if (l) addRailRef(l.ref); return; }
    const picked = phaseDoc();
    if (picked?.polygon) {
      const v = hitVertex(picked.polygon, screen, p);
      if (v !== null) {
        take(ev);
        selection.vertexIndex = v;
        drag = { index: v, moved: false };
        try { canvas.setPointerCapture?.(ev.pointerId); } catch { /* a synthetic pointer cannot be captured: dragging still works */ }
        touchView(); refresh();
        return;
      }
    }
    const hit = hitPhase(built.model.developments.flatMap((d) => d.phases.filter((x) => x.polygon).map((x) => ({ developmentKey: d.key, key: x.key, polygon: x.polygon }))), screen, p);
    if (hit) { take(ev); select(hit.developmentKey, hit.key); }
  };
  const onMove = (ev) => {
    if (!drag || !enabledNow) return;
    take(ev);
    try { moveVertex(doc, selection.developmentKey, selection.phaseKey, drag.index, shell.lonLat(...pointer(ev))); drag.moved = true; touchView(); refresh({ keepPanel: true }); } catch (error) { note("new-town-edit-refused", { message: error.message }); }
  };
  const onUp = () => {
    if (!drag) return;
    const moved = drag.moved;
    drag = null;
    if (moved) { dirty = true; bump(); }
    refresh();
  };
  const onDblClick = (ev) => {
    if (!enabledNow || mode) return;
    const picked = phaseDoc();
    if (!picked?.polygon) return;
    const p = pointer(ev);
    if (hitVertex(picked.polygon, screen, p) !== null) return;
    const index = hitEdge(picked.polygon, screen, p);
    if (index === null) return;
    edit(() => { insertVertex(doc, selection.developmentKey, picked.key, index, shell.lonLat(...p)); selection.vertexIndex = index; });
  };
  const onKey = (ev) => {
    if (!enabledNow || shell.typing()) return;
    if (ev.key === "Enter" && mode === "draw") finishDraw();
    else if (ev.key === "Escape") {
      if (mode) { clearDraw(); touchView(); refresh(); }
      else if (selection.vertexIndex !== null) deselectVertex();
      else if (selection.phaseKey) select(selection.developmentKey, null);
      else if (selection.developmentKey) select(null, null);
    } else if (ev.key === "Backspace" && mode === "draw") { ev.preventDefault?.(); draft.points.pop(); touchView(); refresh(); }
    else if (ev.key === "Delete" && !mode && selection.vertexIndex !== null) { ev.preventDefault?.(); removeVertexNow(); }
  };
  const detachShell = shell.attach({ onPointerDown, onDblClick, onKey, refresh: () => refresh(), autoRefreshMs });
  canvas.addEventListener("pointermove", onMove, true);
  canvas.addEventListener("pointerup", onUp, true);
  canvas.addEventListener("pointercancel", onUp, true);
  refresh();

  return {
    output: outputNow,
    serialize: () => serializeNewTownDoc(doc),
    // Replaces the whole document (the host's own save).  A refused document (other pack, unreadable, other version) leaves the current one untouched.
    loadDoc(source) {
      if (source === null || source === undefined) return [];
      const before = notes.length;
      const incoming = restoreNewTownDoc(typeof source === "string" ? source : JSON.stringify(source), pack, { current: doc });
      notes.push(...incoming.warnings);
      if (!incoming.rejected) { doc = incoming.doc; selection = NO_SELECTION(); clearDraw(); drag = null; dirty = true; }
      bump();
      refresh();
      return clone(notes.slice(before));
    },
    refresh: () => refresh({ force: true }),
    setEnabled(value) { enabledNow = Boolean(value); if (!enabledNow) { clearDraw(); drag = null; } touchView(); refresh(); },
    destroy() {
      canvas.removeEventListener("pointermove", onMove, true);
      canvas.removeEventListener("pointerup", onUp, true);
      canvas.removeEventListener("pointercancel", onUp, true);
      detachShell();
    },
  };
}
