// Rail capacity design, browser side: an independent mount that needs nothing from the host page beyond a canvas, its
// projection, a pack and getters for the live plans, existing networks, through routes and station sites. On the plans the
// player drew they state what the map cannot know on its own: single or double track per section, block boundaries,
// turnouts and flat crossings, and each terminal's platforms and turnback / pull-out / stabling tracks. The mount builds
// the RailCapacityGeometry (M5) from that, shows it, and keeps the player's document in localStorage. It makes its own
// overlay, panel and <style>; the plans, routes and every other input are read, never written. Nothing here says anything
// about throughput, timetables, cost or any verdict: unknown stays unknown (null), "measured apart" stays false.
//
//   const bridge = mountRailCapacityDesign({ canvas, projection, pack, getPlans, getExternalNetworks, getRoutes, getStationSites, getSpatial, onChange });
//   bridge.output()  ->  { document, export, railGeometries, selected, selectedKey, warnings }
import { buildRailGeometryExport, planRevisionOf } from "./rail-capacity-geometry.mjs";
import {
  addBlockBoundary, addDesign, addJunction, addPlatform, addTerminal, addTurnbackTrack, clearBlockBoundaries, clearSectionFact, connectJunction, declareBlockBoundaries, declareJunctions, declareTerminals,
  disconnectJunction, moveBlockBoundary, moveJunction, newRailCapacityDoc, rebindRevisions, removeBlockBoundary, removeDesign, removeJunction, removePlatform, removeTerminal, removeTurnbackTrack, restoreRailCapacityDoc,
  serializeRailCapacityDoc, setSectionFact, toDrawnDesign,
} from "./rail-capacity-editor.mjs";
import { buildRailCapacityView, drawRailCapacityOverlay, renderRailCapacityLegend, renderRailCapacityPanel } from "./rail-capacity-view.mjs";
import { arr, clone, createShell, createStore } from "./map-mount-kit.mjs";
import { boundaryOf, hitSection, hitStation, sectionRefOf, sectionsAtStation, snapToSections, stationsOf } from "./rail-capacity-ui-tools.mjs";

export const RAIL_CAPACITY_UI_EVENT = "transitline:rail-capacity-design";
export const RAIL_CAPACITY_STORAGE_PREFIX = "transitline.rail-capacity.v1:";
export const SCOPE_NOTICE = "이 화면은 계획선 위의 선로 사실(단·복선, 폐색 경계, 분기기, 종착 시설)만 다룹니다. 정하지 않은 값은 미상으로 남습니다.";
export const TRACK_MODES = Object.freeze({ "track-single": "single", "track-double": "double" });
export const JUNCTION_ROLES = Object.freeze({ turnout: ["stem", "main", "branch"], crossing: ["a1", "a2", "b1", "b2"] });
export const TURNBACK_KINDS = Object.freeze({ turnback: "회차선", "pull-out": "인상선", stabling: "유치선" });
const STYLE_ID = "transitline-rail-capacity-style";
const CSS = `
.tl-rail-panel{position:fixed;left:12px;top:64px;z-index:7;width:340px;max-height:55vh;overflow:auto;padding:8px 10px;border:1px solid #2a2f3a;border-radius:8px;background:rgba(17,19,24,.94);color:#f1f2f5;font:12px/1.4 system-ui,'Malgun Gothic',sans-serif}
.tl-rail-panel .section-label{margin:6px 0 3px;color:#ffe66d;font-weight:600}
.tl-rail-panel .diag{margin:3px 0;padding:3px 6px;border-left:3px solid #4cc9f0;border-radius:3px;font-size:11px;overflow-wrap:anywhere}
.tl-rail-panel .diag.warning{border-left-color:#ffb703}.tl-rail-panel .diag.info{color:#aab1c0}
.tl-rail-panel .row{display:flex;align-items:center;gap:6px;margin:2px 0;flex-wrap:wrap}.tl-rail-panel .row.picked{background:rgba(255,255,255,.08)}
.tl-rail-panel button{margin:2px 3px 2px 0;padding:2px 7px}.tl-rail-panel button.on{outline:2px solid #f1f2f5}
`;
const DRAW_KINDS = ["draw-platform", "draw-turnback"];

export function mountRailCapacityDesign({ canvas, projection, pack, getPlans, getExternalNetworks = () => [], getRoutes = () => [], getStationSites = () => [], getSpatial = () => null, onChange = () => {}, enabled = true, autoRefreshMs = 250 }) {
  const shell = createShell({ canvas, projection, pack, styleId: STYLE_ID, css: CSS, panelClass: "tl-rail-panel" });
  const { box, screen, lonLat, el, pointer, button, win } = shell;
  const packId = pack.manifest?.id ?? "pack";
  const notes = [];
  const store = createStore({ win, key: `${RAIL_CAPACITY_STORAGE_PREFIX}${packId}`, pack, restore: restoreRailCapacityDoc, serialize: serializeRailCapacityDoc, notes });
  let designs = store.doc;
  const save = () => store.save(designs, "rail-capacity-doc-not-saved");

  let enabledNow = enabled;
  let selectedKey = null;
  let mode = null; // { kind, role?, junctionKey?, terminalKey?, trackKind?, points?, pending? }
  let version = 0;
  let dirty = true;
  let panelVersion = -1;
  let drawVersion = -1;
  let outputVersion = -1;
  let lastRect = "";
  let lastFingerprint = null;
  let built = { exportData: { designs: [], warnings: [] }, model: { designs: [], warnings: [] }, plans: [], routes: [] };

  const bump = () => { version += 1; };
  const touch = () => { dirty = true; };
  const note = (code, extra = {}) => { notes.push({ code, ...extra }); bump(); };
  const inputs = () => ({ plans: arr(getPlans?.(), "plans"), networks: arr(getExternalNetworks?.(), "networks"), routes: arr(getRoutes?.(), "routes"), stationSites: arr(getStationSites?.(), "sites") });
  const fingerprint = (i) => JSON.stringify([i.plans.map((p) => [p.planId, planRevisionOf(p)]), i.routes.map((r) => [r.throughRouteId, r.geometryRevision]), i.networks.map((n) => [n.id, (n.lines ?? []).length]), i.stationSites.map((s) => [s.stationSiteId, s.connectedStationId])]);
  const designDoc = (key = selectedKey) => designs.designs.find((d) => d.key === key) ?? null;
  const designOut = (key = selectedKey) => built.exportData.designs.find((d) => d.key === key) ?? null;

  function recompute(i) {
    const exportData = buildRailGeometryExport({ pack, mapExport: { plans: i.plans, externalNetworks: i.networks }, routes: i.routes, stationSites: i.stationSites, designs: designs.designs.map(toDrawnDesign), spatial: getSpatial?.() ?? undefined });
    const selectedOut = exportData.designs.find((d) => d.key === selectedKey) ?? null;
    built = { exportData, model: buildRailCapacityView({ exportData: { ...exportData, designs: exportData.designs }, selectedId: selectedOut?.railGeometryId ?? null }), plans: i.plans, routes: i.routes };
    bump();
  }
  const outputNow = () => ({ document: clone(designs), export: built.exportData, railGeometries: built.exportData.designs, selected: designOut(), selectedKey, warnings: [...notes, ...built.exportData.warnings] });
  function emit() {
    if (outputVersion === version) return;
    outputVersion = version;
    const out = outputNow();
    onChange(out);
    canvas.dispatchEvent(new CustomEvent(RAIL_CAPACITY_UI_EVENT, { detail: out }));
  }

  // --- the edit: one place that applies it, saves it and says so when the editor refuses ---
  function edit(fn) {
    try { const r = fn(); save(); touch(); refresh(); return r ?? true; } catch (error) { note("rail-capacity-edit-refused", { message: error.message }); touch(); refresh(); return false; }
  }
  const needDesign = () => { if (!selectedKey || !designDoc()) throw new Error("No rail design is selected"); return selectedKey; };

  function createDesign({ planIds = null, externalLineIds = [], routeId = null, name = null } = {}) {
    const i = inputs();
    const plans = planIds ? i.plans.filter((p) => planIds.includes(p.planId)) : i.plans;
    const route = routeId ? i.routes.find((r) => r.throughRouteId === routeId) ?? null : null;
    const made = edit(() => { const d = addDesign(designs, { plans, externalLineIds, route, name }); selectedKey = d.key; bump(); return d.key; });
    return made === false ? null : made;
  }
  const selectDesign = (key) => { selectedKey = designDoc(key) ? key : null; mode = null; bump(); refresh(); return selectedKey === key; };
  const deselect = () => { selectedKey = null; mode = null; bump(); refresh(); };
  const dropDesign = (key = selectedKey) => edit(() => { removeDesign(designs, key); if (selectedKey === key) selectedKey = null; mode = null; bump(); });
  const rebind = () => edit(() => {
    const d = designDoc();
    const i = inputs();
    rebindRevisions(designs, needDesign(), { plans: i.plans.filter((p) => d.planIds.includes(p.planId)), route: d.throughRouteId ? i.routes.find((r) => r.throughRouteId === d.throughRouteId) ?? null : null });
  });
  const setTrackCount = (ref, directionMode) => edit(() => { const k = needDesign(); if (directionMode === null) clearSectionFact(designs, k, ref); else setSectionFact(designs, k, ref, { directionMode, basis: "player" }); });
  const declareNoBlocks = () => edit(() => { declareBlockBoundaries(designs, needDesign()); });
  const clearBlocks = () => edit(() => { clearBlockBoundaries(designs, needDesign()); });
  const addBoundary = (boundary) => edit(() => { const k = needDesign(); if (designDoc(k).blockBoundaries === null) declareBlockBoundaries(designs, k); return addBlockBoundary(designs, k, boundary).key; });
  const moveBoundary = (boundaryKey, alongMeters) => edit(() => { moveBlockBoundary(designs, needDesign(), boundaryKey, alongMeters); });
  const removeBoundary = (boundaryKey) => edit(() => removeBlockBoundary(designs, needDesign(), boundaryKey));
  const placeJunction = (kind, location) => edit(() => { const k = needDesign(); if (!JUNCTION_ROLES[kind]) throw new Error(`Unknown junction kind ${kind}`); if (designDoc(k).junctions === null) declareJunctions(designs, k); return addJunction(designs, k, { kind, location }).key; });
  const shiftJunction = (junctionKey, location) => edit(() => { moveJunction(designs, needDesign(), junctionKey, location); });
  const connect = (junctionKey, ref, role) => edit(() => { connectJunction(designs, needDesign(), junctionKey, { ...ref, role }); });
  const disconnect = (junctionKey, role) => edit(() => { disconnectJunction(designs, needDesign(), junctionKey, role); });
  const dropJunction = (junctionKey) => edit(() => { removeJunction(designs, needDesign(), junctionKey); if (mode?.junctionKey === junctionKey) mode = null; bump(); });
  const placeTerminal = (stationId) => edit(() => { const k = needDesign(); if (designDoc(k).terminals === null) declareTerminals(designs, k); return addTerminal(designs, k, { stationId }).key; });
  const dropTerminal = (terminalKey) => edit(() => removeTerminal(designs, needDesign(), terminalKey));
  const placePlatform = (terminalKey, { approach, polyline, platformLengthMeters }) => edit(() => addPlatform(designs, needDesign(), terminalKey, { approach, polyline, ...(platformLengthMeters ? { platformLengthMeters } : {}) }).key);
  const dropPlatform = (terminalKey, platformKey) => edit(() => removePlatform(designs, needDesign(), terminalKey, platformKey));
  const placeTurnback = (terminalKey, { kind, polyline }) => edit(() => addTurnbackTrack(designs, needDesign(), terminalKey, { kind, polyline }).key);
  const dropTurnback = (terminalKey, trackKey) => edit(() => removeTurnbackTrack(designs, needDesign(), terminalKey, trackKey));

  // --- modes ---
  const setMode = (m) => { if (!selectedKey && m) { note("rail-capacity-no-design-selected"); refresh(); return false; } mode = m ? { ...m, points: m.points ?? [] } : null; bump(); refresh(); return true; };
  function finishDraw() {
    if (!mode || !DRAW_KINDS.includes(mode.kind)) return false;
    if (mode.points.length < 2) { note("rail-capacity-line-needs-two-points"); refresh(); return false; }
    const d = designOut();
    const terminal = designDoc()?.terminals?.find((t) => t.key === mode.terminalKey);
    if (!d || !terminal) { note("rail-capacity-terminal-missing"); mode = null; refresh(); return false; }
    if (mode.kind === "draw-turnback") { const polyline = mode.points; const kind = mode.trackKind; mode = null; bump(); return placeTurnback(terminal.key, { kind, polyline }); }
    // a platform comes in from one of the sections that reach the terminal's station: the only one, or the one the player points at
    const reach = sectionsAtStation(d, terminal.stationId);
    if (!reach.length) { note("rail-capacity-station-has-no-section", { stationId: terminal.stationId }); mode = null; refresh(); return false; }
    if (reach.length === 1) { const polyline = mode.points; mode = null; bump(); return placePlatform(terminal.key, { approach: sectionRefOf(reach[0]), polyline }); }
    mode = { ...mode, kind: "pick-approach", pending: mode.points };
    bump();
    refresh();
    return "pick-approach";
  }
  function onMapClick(p) {
    const d = designOut();
    if (!mode || !d) return false;
    if (mode.kind in TRACK_MODES || mode.kind === "track-clear") { const hit = hitSection(d, screen, p); if (hit) setTrackCount(hit.ref, mode.kind === "track-clear" ? null : TRACK_MODES[mode.kind]); return true; }
    if (mode.kind === "add-boundary") {
      const hit = hitSection(d, screen, p);
      const b = hit ? boundaryOf(hit) : null;
      if (hit && !b) note("rail-capacity-boundary-position-invalid", { alongMeters: hit.alongMeters });
      if (b) addBoundary(b);
      return true;
    }
    if (mode.kind === "add-turnout" || mode.kind === "add-crossing") { placeJunction(mode.kind === "add-turnout" ? "turnout" : "crossing", snapToSections(d, screen, p, lonLat)); return true; }
    if (mode.kind === "connect") { const hit = hitSection(d, screen, p); if (hit) connect(mode.junctionKey, hit.ref, mode.role); return true; }
    if (mode.kind === "add-terminal") { const st = hitStation(d, screen, p); if (st) placeTerminal(st.stationId); return true; }
    if (mode.kind === "pick-approach") {
      const hit = hitSection(d, screen, p);
      const terminal = designDoc()?.terminals?.find((t) => t.key === mode.terminalKey);
      if (hit && terminal && sectionsAtStation(d, terminal.stationId).some((s) => s.sectionId === hit.section.sectionId)) { const polyline = mode.pending; mode = null; bump(); placePlatform(terminal.key, { approach: hit.ref, polyline }); }
      return true;
    }
    if (DRAW_KINDS.includes(mode.kind)) {
      const first = mode.points.length === 0;
      const st = first || mode.kind === "draw-platform" ? hitStation(d, screen, p) : null;
      mode.points.push(st && first ? clone(st.location) : lonLat(p[0], p[1]));
      bump();
      refresh();
      return true;
    }
    return false;
  }

  // --- the map layer ---
  function drawLayer() {
    const rectKey = shell.fit(enabledNow);
    if (drawVersion === version && rectKey === lastRect) return;
    drawVersion = version;
    lastRect = rectKey;
    const ctx = shell.layer.getContext("2d");
    ctx.clearRect(0, 0, shell.layer.width, shell.layer.height);
    if (!enabledNow) return;
    drawRailCapacityOverlay(ctx, built.model, screen);
    const pts = mode?.points?.length ? mode.points : mode?.pending ?? [];
    if (pts.length) {
      ctx.save();
      ctx.strokeStyle = "#f4a261";
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 5]);
      ctx.beginPath();
      pts.map(screen).forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.stroke();
      ctx.restore();
    }
  }

  // --- the panel ---
  function renderPanel() {
    box.replaceChildren();
    box.hidden = !enabledNow;
    if (!enabledNow) return;
    const i = inputs();
    box.append(el("div", "section-label", "철도 공간 설계 (선로 사실)"));
    box.append(el("div", "diag info", SCOPE_NOTICE));
    box.append(el("div", "section-label", "계획선"));
    if (!i.plans.length) box.append(el("div", "diag warning", "설계할 계획선이 없습니다."));
    for (const p of i.plans) {
      const row = el("div", "row");
      row.append(el("span", "", `${p.planId} · 구간 ${(p.segments ?? []).length}`));
      button(row, "이 계획선으로 설계 만들기", () => createDesign({ planIds: [p.planId] }));
      box.append(row);
    }
    if (i.plans.length > 1) { const row = el("div", "row"); button(row, "모든 계획선으로 설계 만들기", () => createDesign()); box.append(row); }
    box.append(el("div", "section-label", `설계 ${designs.designs.length}건`));
    for (const d of designs.designs) {
      const out = designOut(d.key);
      const row = el("div", `row${d.key === selectedKey ? " picked" : ""}`);
      row.append(el("span", "", `${d.key} · 계획선 ${d.planIds.length}${out ? "" : " · 만들 수 없음"}${out && out.revision.state !== "current" ? ` · ${out.revision.state === "stale" ? "노선이 바뀜" : "개정 미기록"}` : ""}`));
      button(row, "선택", () => selectDesign(d.key));
      button(row, "설계 삭제", () => dropDesign(d.key));
      box.append(row);
    }
    const d = designDoc();
    const out = designOut();
    if (d) {
      box.append(el("div", "section-label", `선택한 설계: ${d.key}`));
      if (out && out.revision.state !== "current") { box.append(el("div", "diag warning", `↻ ${out.revision.state === "stale" ? "노선이 바뀌었습니다. 폐색·분기기·종착은 다시 확인하기 전까지 값이 없습니다." : "설계 기준 개정이 기록되지 않았습니다."}`)); button(box, "현재 계획선으로 다시 확인", rebind); }
      const modeBtn = (parent, label, m) => button(parent, label, () => setMode(mode?.kind === m.kind && mode?.role === m.role && mode?.junctionKey === m.junctionKey && mode?.terminalKey === m.terminalKey && mode?.trackKind === m.trackKind ? null : m), mode && mode.kind === m.kind && mode.role === m.role && mode.terminalKey === m.terminalKey && mode.trackKind === m.trackKind && mode.junctionKey === m.junctionKey ? "on" : "");
      if (mode) { box.append(el("div", "diag info", mode.kind === "pick-approach" ? "승강장이 들어오는 구간을 클릭하세요." : "지도를 클릭해 지정하세요. 선은 점을 찍고 완료(또는 더블클릭/Enter), 취소는 Esc.")); const bar = el("div"); if (DRAW_KINDS.includes(mode.kind)) button(bar, "완료", finishDraw); button(bar, "모드 끝내기", () => setMode(null)); box.append(bar); }
      box.append(el("div", "section-label", "단·복선 (구간을 클릭)"));
      const tb = el("div");
      modeBtn(tb, "단선으로 지정", { kind: "track-single" }); modeBtn(tb, "복선으로 지정", { kind: "track-double" }); modeBtn(tb, "지정 해제", { kind: "track-clear" });
      box.append(tb);
      box.append(el("div", "section-label", "폐색 경계"));
      const bb = el("div");
      modeBtn(bb, "폐색 경계 놓기", { kind: "add-boundary" });
      button(bb, "경계 없음으로 선언", declareNoBlocks);
      button(bb, "폐색 자료 지움(미상)", clearBlocks);
      box.append(bb);
      if (d.blockBoundaries === null) box.append(el("div", "diag info", "폐색: 미상 (자료 없음)"));
      for (const b of d.blockBoundaries ?? []) { const row = el("div", "row"); row.append(el("span", "", `${b.key} · ${Math.round(b.alongMeters)} m`)); button(row, "삭제", () => removeBoundary(b.key)); box.append(row); }
      if (Array.isArray(d.blockBoundaries) && !d.blockBoundaries.length) box.append(el("div", "diag info", "폐색 경계 없음으로 선언됨"));
      box.append(el("div", "section-label", "분기기·평면교차"));
      const jb = el("div");
      modeBtn(jb, "분기기 놓기", { kind: "add-turnout" }); modeBtn(jb, "평면교차 놓기", { kind: "add-crossing" });
      box.append(jb);
      if (d.junctions === null) box.append(el("div", "diag info", "분기기: 미상 (자료 없음)"));
      for (const j of d.junctions ?? []) {
        const row = el("div", "row");
        row.append(el("span", "", `${j.key} · ${j.kind === "turnout" ? "분기기" : "평면교차"} · 연결 ${j.connections.map((c) => c.role).join(",") || "없음"}`));
        for (const role of JUNCTION_ROLES[j.kind]) modeBtn(row, `${role} 연결`, { kind: "connect", role, junctionKey: j.key });
        for (const c of j.connections) button(row, `${c.role} 해제`, () => disconnect(j.key, c.role));
        button(row, "삭제", () => dropJunction(j.key));
        box.append(row);
      }
      box.append(el("div", "section-label", "종착 시설"));
      const tb2 = el("div");
      modeBtn(tb2, "종착 지정 (역 클릭)", { kind: "add-terminal" });
      box.append(tb2);
      if (d.terminals === null) box.append(el("div", "diag info", "종착: 미상 (자료 없음)"));
      for (const t of d.terminals ?? []) {
        const row = el("div", "row");
        row.append(el("span", "", `${t.key} · 역 ${t.stationId} · 승강장 ${t.platforms === null ? "미작도" : t.platforms.length} · 회차·유치선 ${t.turnbackTracks === null ? "미작도" : t.turnbackTracks.length}`));
        modeBtn(row, "승강장 그리기", { kind: "draw-platform", terminalKey: t.key });
        for (const [kind, label] of Object.entries(TURNBACK_KINDS)) modeBtn(row, `${label} 그리기`, { kind: "draw-turnback", terminalKey: t.key, trackKind: kind });
        button(row, "종착 삭제", () => dropTerminal(t.key));
        box.append(row);
        for (const p of t.platforms ?? []) { const r = el("div", "row"); r.append(el("span", "", `  승강장 ${p.key}`)); button(r, "삭제", () => dropPlatform(t.key, p.key)); box.append(r); }
        for (const p of t.turnbackTracks ?? []) { const r = el("div", "row"); r.append(el("span", "", `  ${TURNBACK_KINDS[p.kind] ?? p.kind} ${p.key}`)); button(r, "삭제", () => dropTurnback(t.key, p.key)); box.append(r); }
      }
      button(box, "설계 선택 해제", deselect);
    }
    if (built.model.designs.length) { const body = el("div"); box.append(body); renderRailCapacityPanel(body, { ...built.model, designs: built.model.designs.filter((x) => x.railGeometryId === out?.railGeometryId) }); }
    const legend = el("div");
    box.append(legend);
    renderRailCapacityLegend(legend);
    for (const w of [...notes, ...built.exportData.warnings]) box.append(el("div", "diag warning", `⚠ ${w.code}${w.reasons?.[0]?.code ? ` (${w.reasons[0].code})` : ""}`));
  }

  function refresh() {
    const i = inputs();
    const fp = fingerprint(i);
    if (dirty || fp !== lastFingerprint) { lastFingerprint = fp; dirty = false; recompute(i); }
    drawLayer();
    if (panelVersion !== version) { panelVersion = version; renderPanel(); }
    emit();
  }

  // --- pointer, keyboard ---
  const onPointerDown = (ev) => {
    if (!enabledNow || !mode) return;
    ev.stopImmediatePropagation?.();
    onMapClick(pointer(ev));
  };
  const onDblClick = () => { if (enabledNow && mode && DRAW_KINDS.includes(mode.kind)) finishDraw(); };
  const onKey = (ev) => {
    if (!enabledNow || shell.typing()) return;
    if (ev.key === "Enter" && mode && DRAW_KINDS.includes(mode.kind)) finishDraw();
    else if (ev.key === "Escape") { if (mode) setMode(null); else deselect(); }
  };
  const detach = shell.attach({ onPointerDown, onDblClick, onKey, refresh, autoRefreshMs });
  refresh();

  return {
    output: outputNow, createDesign, selectDesign, deselect, removeDesign: dropDesign, rebind,
    setTrackCount, declareNoBlocks, clearBlocks, addBoundary, moveBoundary, removeBoundary,
    placeJunction, moveJunction: shiftJunction, connectJunction: connect, disconnectJunction: disconnect, removeJunction: dropJunction,
    placeTerminal, removeTerminal: dropTerminal, addPlatform: placePlatform, removePlatform: dropPlatform, addTurnbackTrack: placeTurnback, removeTurnbackTrack: dropTurnback,
    setMode, finishDraw, addDraftPoint(location) { if (mode?.points) { mode.points.push(clone(location)); bump(); refresh(); } },
    save() { return save(); }, serialize: () => serializeRailCapacityDoc(designs),
    // Replaces the whole document (the host's own save). A refused document (other pack, unreadable, other version) leaves the current designs untouched.
    loadDoc(source) {
      if (source === null || source === undefined) return [];
      const before = notes.length;
      const incoming = restoreRailCapacityDoc(typeof source === "string" ? source : JSON.stringify(source), pack);
      const refused = incoming.warnings.some((w) => ["rail-capacity-doc-other-pack", "rail-capacity-doc-unreadable", "rail-capacity-doc-version"].includes(w.code));
      notes.push(...incoming.warnings);
      if (!refused) { designs = incoming.doc; selectedKey = null; mode = null; save(); touch(); }
      bump();
      refresh();
      return notes.slice(before);
    },
    refresh, setEnabled(value) { enabledNow = Boolean(value); bump(); refresh(); },
    get selectedKey() { return selectedKey; }, get mode() { return mode ? { ...mode } : null; }, get document() { return clone(designs); }, get storageKey() { return store.key; }, stations: () => stationsOf(designOut()),
    destroy: detach,
  };
}
