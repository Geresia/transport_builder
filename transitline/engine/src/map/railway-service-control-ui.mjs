// Service control candidates, browser side: an independent mount that needs nothing from the host page beyond a canvas, its
// projection, a pack and getters for the disruption sites (M6), the rail capacity geometries (M5) and applications, the through
// routes, the existing networks, station sites and the spatial layers. For an event the player picks it up, the mount builds
// the RailwayServiceControlGeometry (M7) — the turnback, partial suspension, detour and evacuation candidates around the
// disruption — shows them on the map, and records which of them the player chose, with the access points they stated. It
// records the player's choice and nothing else: a candidate is not ranked, priced or judged, and carrying a choice out belongs
// to the management engine. It makes its own overlay, panel and <style>; every input is read, never written.
//
//   const bridge = mountRailwayServiceControl({ canvas, projection, pack, getRailGeometry, getRailCapacityApplication, getDisruptionSites,
//     getThroughRoutes, getExternalNetworks, getStationSites, getSpatial, onChange });
//   bridge.output()  ->  { document, export, controls, selections, selected, selectedEventId, warnings }
import { buildRailwayServiceControlExport } from "./railway-service-control.mjs";
import {
  activeControls, addAccessPoint, addControl, clearSelection, deactivateControl, deselectCandidate, newRailwayServiceControlDoc, reconcileSelections, removeAccessPoint, restoreControl,
  restoreRailwayServiceControlDoc, selectCandidate, selectionsOf, serializeRailwayServiceControlDoc, setEmergencyVehicleWidth, toControlDocument,
} from "./railway-service-control-editor.mjs";
import { buildRailwayServiceControlView, drawRailwayServiceControlOverlay, renderRailwayServiceControlLegend } from "./railway-service-control-view.mjs";
import { arr, clone, createShell, createStore, nearestOnScreenLine } from "./map-mount-kit.mjs";

export const CONTROL_UI_EVENT = "transitline:railway-service-control";
export const CONTROL_STORAGE_PREFIX = "transitline.railway-service-control.v1:";
export const SCOPE_NOTICE = "후보는 선택지이며 지도는 후보의 우열을 말하지 않습니다. 여기서 고른 것은 플레이어의 선택 기록이고, 실행과 판단은 경영 엔진이 합니다.";
export const KIND_LABELS = Object.freeze({ turnback: "회차 후보", partialSuspension: "부분운휴 후보", detour: "우회 후보", evacuation: "대피 접근점" });
const STYLE_ID = "transitline-railway-service-control-style";
const HIT_PX = 10;
const CSS = `
.tl-control-panel{position:fixed;right:12px;top:64px;z-index:7;width:360px;max-height:70vh;overflow:auto;padding:8px 10px;border:1px solid #2a2f3a;border-radius:8px;background:rgba(17,19,24,.94);color:#f1f2f5;font:12px/1.4 system-ui,'Malgun Gothic',sans-serif}
.tl-control-panel .section-label{margin:6px 0 3px;color:#ffe66d;font-weight:600}
.tl-control-panel .diag{margin:3px 0;padding:3px 6px;border-left:3px solid #4cc9f0;border-radius:3px;font-size:11px;overflow-wrap:anywhere}
.tl-control-panel .diag.warning{border-left-color:#ffb703}.tl-control-panel .diag.info{color:#aab1c0}
.tl-control-panel .row{display:flex;align-items:center;gap:6px;margin:2px 0;flex-wrap:wrap}.tl-control-panel .row.picked{background:rgba(255,255,255,.08)}
.tl-control-panel button{margin:2px 3px 2px 0;padding:2px 7px}.tl-control-panel button.on{outline:2px solid #f1f2f5}
`;

// The candidate nearest to a click on a control view model: evacuation points and turnback stations (markers) first, then detour lines.
// Partial suspensions share their boundary stations, so they are chosen from the panel only.
export function pickControlCandidate(model, screen, point, radius = HIT_PX) {
  let best = null;
  const offer = (kind, id, d, rank) => { if (d <= radius && (!best || d < best.d - 1e-9 || (Math.abs(d - best.d) <= 1e-9 && rank < best.rank))) best = { kind, id, d, rank }; };
  for (const c of model?.controls ?? []) {
    for (const e of c.evacuations) offer("evacuation", e.candidateId, Math.hypot(...screen(e.location).map((v, i) => v - point[i])), 0);
    for (const t of c.turnbacks) offer("turnback", t.candidateId, Math.hypot(...screen(t.location).map((v, i) => v - point[i])), 1);
    for (const d of c.detours) if (d.alignment) offer("detour", d.candidateId, nearestOnScreenLine(d.alignment.map(screen), point)?.d ?? Infinity, 2);
  }
  return best ? { kind: best.kind, id: best.id } : null;
}

export function mountRailwayServiceControl({
  canvas, projection, pack, getRailGeometry, getRailCapacityApplication, getDisruptionSites, getThroughRoutes = () => [], getExternalNetworks = () => [], getStationSites = () => [], getSpatial = () => null,
  onChange = () => {}, enabled = true, autoRefreshMs = 250,
}) {
  const shell = createShell({ canvas, projection, pack, styleId: STYLE_ID, css: CSS, panelClass: "tl-control-panel" });
  const { box, screen, lonLat, el, pointer, button, win, doc: htmlDoc } = shell;
  const packId = pack.manifest?.id ?? "pack";
  const notes = [];
  const store = createStore({ win, key: `${CONTROL_STORAGE_PREFIX}${packId}`, pack, restore: restoreRailwayServiceControlDoc, serialize: serializeRailwayServiceControlDoc, notes });
  let controls = store.doc;
  const save = () => store.save(controls, "railway-service-control-doc-not-saved");

  let enabledNow = enabled;
  let selectedId = null;
  let mode = null; // null | "add-access-point"
  let version = 0;
  let dirty = true;
  let panelVersion = -1;
  let drawVersion = -1;
  let outputVersion = -1;
  let lastRect = "";
  let lastFingerprint = null;
  let inputsNow = { sites: [], geometries: [], applications: [], routes: [], networks: [], stationSites: [] };
  let built = { exportData: { controls: [], inactive: [], warnings: [] }, model: { controls: [], warnings: [] }, issues: [] };

  const bump = () => { version += 1; };
  const touch = () => { dirty = true; };
  const note = (code, extra = {}) => { notes.push({ code, ...extra }); bump(); };
  const inputs = () => ({
    sites: arr(getDisruptionSites?.(), "sites"), geometries: arr(getRailGeometry?.(), "designs"), applications: arr(getRailCapacityApplication?.(), "applications"),
    routes: arr(getThroughRoutes?.(), "routes"), networks: arr(getExternalNetworks?.(), "networks"), stationSites: arr(getStationSites?.(), "sites"),
  });
  const fingerprint = (i) => JSON.stringify([
    i.sites.map((s) => [s.eventId, s.siteRevision]), i.geometries.map((g) => [g.railGeometryId, g.railGeometryRevision]), i.applications.map((a) => [a.railGeometryId, a.railGeometryRevision, (a.sections ?? []).length]),
    i.routes.map((r) => [r.throughRouteId, r.geometryRevision]), i.networks.map((n) => [n.id, n.infrastructureOwnerId ?? null, (n.lines ?? []).map((l) => [l.id, l.infrastructureOwnerId ?? null])]),
    i.stationSites.map((s) => [s.stationSiteId, s.connectedStationId, (s.entranceCandidates ?? []).map((e) => e.entranceId)]),
  ]);
  const entryOf = (eventId = selectedId) => controls.controls.find((c) => c.eventId === eventId) ?? null;
  const controlOut = (eventId = selectedId) => built.exportData.controls.find((c) => c.eventId === eventId) ?? null;

  function recompute(i) {
    inputsNow = i;
    const exportData = buildRailwayServiceControlExport({
      pack, sites: i.sites, railGeometries: i.geometries, applications: i.applications, routes: i.routes, externalNetworks: i.networks, stationSites: i.stationSites, spatial: getSpatial?.() ?? null,
      documents: controls.controls.map(toControlDocument),
    });
    // what the player's choices are now against the candidates the geometry offers: only compared, never estimated
    const issues = [];
    for (const c of activeControls(controls)) {
      const out = exportData.controls.find((x) => x.eventId === c.eventId);
      if (!out) continue;
      const r = reconcileSelections(controls, c.eventId, out);
      for (const s of r.stale) issues.push({ code: "railway-service-control-selection-stale", eventId: c.eventId, kind: s.kind, candidateId: s.candidateId });
      if (r.current.some((x) => x.outdated)) issues.push({ code: "railway-service-control-selection-outdated", eventId: c.eventId });
    }
    built = { exportData, issues, model: buildRailwayServiceControlView({ exportData, selections: selectionsOf(controls), selectedEventId: selectedId }) };
    bump();
  }
  const warningsNow = () => [...notes, ...built.exportData.warnings, ...built.issues];
  const outputNow = () => ({ document: clone(controls), export: built.exportData, controls: built.exportData.controls, selections: selectionsOf(controls), selected: controlOut(), selectedEventId: selectedId, warnings: warningsNow() });
  function emit() {
    if (outputVersion === version) return;
    outputVersion = version;
    const out = outputNow();
    onChange(out);
    canvas.dispatchEvent(new CustomEvent(CONTROL_UI_EVENT, { detail: out }));
  }
  function edit(fn) {
    try { fn(); save(); touch(); refresh(); return true; } catch (error) { note("railway-service-control-edit-refused", { message: error.message }); touch(); refresh(); return false; }
  }

  // --- operations ---
  function startControl(eventId) {
    if (!inputsNow.sites.some((s) => s.eventId === eventId)) { note("railway-service-control-site-missing", { eventId }); refresh(); return false; }
    return edit(() => { addControl(controls, eventId); selectedId = eventId; bump(); });
  }
  const selectEvent = (eventId) => { selectedId = entryOf(eventId) ? eventId : null; mode = null; bump(); refresh(); return selectedId === eventId; };
  const deselect = () => { selectedId = null; mode = null; bump(); refresh(); };
  const pick = (kind, candidateId) => edit(() => { const out = controlOut(); if (!out) throw new Error("No control geometry to choose from"); selectCandidate(controls, selectedId, kind, candidateId, out); });
  const unpick = (kind, candidateId) => edit(() => deselectCandidate(controls, selectedId, kind, candidateId));
  const toggle = (kind, candidateId) => (entryOf()?.selected[kind]?.some((s) => s.candidateId === candidateId) ? unpick(kind, candidateId) : pick(kind, candidateId));
  const clearPicks = (kind = null) => edit(() => clearSelection(controls, selectedId, kind));
  // the player looked at the current candidates again and keeps their choices: the ones still offered are re-recorded, the others dropped
  const reconfirm = () => edit(() => {
    const out = controlOut();
    const entry = entryOf();
    if (!out || !entry) throw new Error("No control geometry to re-confirm against");
    const r = reconcileSelections(controls, entry.eventId, out);
    for (const s of r.stale) deselectCandidate(controls, entry.eventId, s.kind, s.candidateId);
    for (const c of r.current) selectCandidate(controls, entry.eventId, c.kind, c.candidateId, out);
  });
  const addPoint = (point) => edit(() => addAccessPoint(controls, selectedId, point));
  const removePoint = (key) => edit(() => removeAccessPoint(controls, selectedId, key));
  const setWidth = (meters) => edit(() => setEmergencyVehicleWidth(controls, selectedId, meters));
  const setActive = (active) => edit(() => (active ? restoreControl : deactivateControl)(controls, selectedId));
  const setMode = (m) => { if (m && !entryOf()) { note("railway-service-control-no-event-selected"); refresh(); return false; } mode = m; bump(); refresh(); return true; };
  const nextKey = () => { const used = new Set((entryOf()?.accessPoints ?? []).map((p) => p.key)); let n = 1; while (used.has(`access-${n}`)) n += 1; return `access-${n}`; };

  // --- the map layer ---
  function drawLayer() {
    const rectKey = shell.fit(enabledNow);
    if (drawVersion === version && rectKey === lastRect) return;
    drawVersion = version;
    lastRect = rectKey;
    const ctx = shell.layer.getContext("2d");
    ctx.clearRect(0, 0, shell.layer.width, shell.layer.height);
    if (!enabledNow) return;
    const selectedModel = { ...built.model, controls: built.model.controls.filter((c) => c.eventId === selectedId) };
    drawRailwayServiceControlOverlay(ctx, selectedModel, screen);
  }

  // --- the panel ---
  function renderPanel() {
    box.replaceChildren();
    box.hidden = !enabledNow;
    if (!enabledNow) return;
    box.append(el("div", "section-label", "장애 관제 후보 (지도 편집)"));
    box.append(el("div", "diag info", SCOPE_NOTICE));
    box.append(el("div", "section-label", `장애 위치 ${inputsNow.sites.length}건`));
    if (!inputsNow.sites.length) box.append(el("div", "diag warning", "관제 후보를 볼 장애 위치가 없습니다. 장애 위치부터 지정하세요."));
    for (const s of inputsNow.sites) {
      const entry = entryOf(s.eventId);
      const out = controlOut(s.eventId);
      const row = el("div", `row${s.eventId === selectedId ? " picked" : ""}`);
      row.append(el("span", "", `${s.eventId} · ${s.kind}${entry ? (entry.active === false ? " · 꺼짐" : out ? "" : " · 만들 수 없음") : ""}`));
      button(row, entry ? "선택" : "관제 후보 보기", () => (entry ? selectEvent(s.eventId) : startControl(s.eventId)));
      box.append(row);
    }
    const entry = entryOf();
    const out = controlOut();
    if (entry) {
      box.append(el("div", "section-label", `선택한 장애: ${entry.eventId}`));
      if (!out && entry.active !== false) box.append(el("div", "diag warning", "이 장애의 관제 후보를 만들 수 없습니다: 아래 경고를 확인하세요. 값을 추정하지 않습니다."));
      if (built.issues.some((i) => i.eventId === entry.eventId)) { box.append(el("div", "diag warning", "후보가 바뀌었습니다. 고른 것 중 일부는 더 이상 후보가 아니거나 이전 후보 기준입니다.")); button(box, "현재 후보로 다시 확인", reconfirm); }
      const bar = el("div");
      button(bar, "접근점 추가", () => setMode(mode === "add-access-point" ? null : "add-access-point"), mode === "add-access-point" ? "on" : "");
      button(bar, "고른 것 모두 해제", () => clearPicks());
      button(bar, entry.active === false ? "켜기" : "끄기", () => setActive(entry.active === false));
      button(bar, "선택 해제", deselect);
      box.append(bar);
      if (mode === "add-access-point") box.append(el("div", "diag info", "지도에서 출입구나 도로 접근점을 클릭하세요."));
      const width = htmlDoc.createElement("input");
      width.type = "number";
      width.value = entry.emergencyVehicleWidthMeters === null ? "" : String(entry.emergencyVehicleWidthMeters);
      width.addEventListener("change", () => setWidth(width.value === "" ? null : Number(width.value)));
      const wrow = el("div", "row");
      wrow.append(el("span", "", "차량 폭(m, 입력한 값과의 비교에만 쓰임)"));
      wrow.append(width);
      box.append(wrow);
      for (const p of entry.accessPoints ?? []) { const r = el("div", "row"); r.append(el("span", "", `${p.key} · ${p.kind === "entrance" ? "출입구" : "도로 접근점"}${p.roadWidthMeters ? ` · 도로 폭 ${p.roadWidthMeters} m` : " · 도로 폭 자료 없음"}`)); button(r, "삭제", () => removePoint(p.key)); box.append(r); }
      if (out) {
        const m = built.model.controls.find((c) => c.eventId === entry.eventId);
        const picked = (kind, id) => entry.selected[kind].some((s) => s.candidateId === id);
        const rowFor = (kind, id, text) => { const on = picked(kind, id); const r = el("div", `row${on ? " picked" : ""}`); r.append(el("span", "", `${on ? "✔ " : ""}${text}`)); button(r, on ? "해제" : "선택", () => toggle(kind, id), on ? "on" : ""); box.append(r); };
        box.append(el("div", "section-label", `${KIND_LABELS.turnback} ${m.counts.turnback === null ? "미상" : m.counts.turnback}`));
        for (const t of m.turnbacks) rowFor("turnback", t.candidateId, `${t.stationId}${t.adjacent ? " (장애 구간 끝)" : ""} · ${t.attachment.glyph} ${t.attachment.label}${t.hasTerminal ? "" : " · 종착 자료 없음"}`);
        box.append(el("div", "section-label", `${KIND_LABELS.partialSuspension} ${m.counts.partialSuspension === null ? "미상" : m.counts.partialSuspension}`));
        for (const s of m.suspensions) rowFor("partialSuspension", s.candidateId, `${s.startStationId} ~ ${s.endStationId} · 구간 ${s.suspendedSections}${s.unmeasuredSections ? ` (선형 미상 ${s.unmeasuredSections})` : ""} · 고립 역 ${s.isolatedStations}`);
        box.append(el("div", "section-label", `${KIND_LABELS.detour} ${m.counts.detour === null ? "미상" : m.counts.detour}`));
        for (const d of m.detours) rowFor("detour", d.candidateId, `우회 구간 ${d.sections} · 기존선 ${d.externalLines} · 접속 ${d.connection.glyph} ${d.connection.label}${d.alignment ? "" : " · 선형 미상"}`);
        box.append(el("div", "section-label", `${KIND_LABELS.evacuation} ${m.counts.evacuation === null ? "미상" : m.counts.evacuation}`));
        for (const e of m.evacuations) rowFor("evacuation", e.candidateId, `${e.glyph} ${e.kindLabel}${e.name ? ` ${e.name}` : ""}${e.nearest ? " (종류별 가장 가까움)" : ""} · ${e.distanceMeters === null ? "거리 미상" : `${Math.round(e.distanceMeters)} m`} · ${e.widthText}`);
        for (const f of m.flags) box.append(el("div", "diag warning", `⚠ ${f.label}`));
      }
    }
    const legend = el("div");
    box.append(legend);
    renderRailwayServiceControlLegend(legend);
    for (const w of warningsNow()) box.append(el("div", "diag warning", `⚠ ${w.code}${w.reasons?.[0]?.code ? ` (${w.reasons[0].code})` : ""}`));
  }

  function refresh() {
    const i = inputs();
    const fp = fingerprint(i);
    if (dirty || fp !== lastFingerprint) { lastFingerprint = fp; dirty = false; recompute(i); }
    drawLayer();
    if (panelVersion !== version) { panelVersion = version; renderPanel(); }
    emit();
  }

  const onPointerDown = (ev) => {
    if (!enabledNow || !entryOf()) return;
    const p = pointer(ev);
    if (mode === "add-access-point") { ev.stopImmediatePropagation?.(); addPoint({ key: nextKey(), kind: "road-access", location: lonLat(p[0], p[1]), basis: "player" }); mode = null; bump(); refresh(); return; }
    const hit = controlOut() ? pickControlCandidate({ controls: built.model.controls.filter((c) => c.eventId === selectedId) }, screen, p) : null;
    if (hit) { ev.stopImmediatePropagation?.(); toggle(hit.kind, hit.id); }
  };
  const onDblClick = () => {};
  const onKey = (ev) => {
    if (!enabledNow || shell.typing()) return;
    if (ev.key === "Escape") { if (mode) setMode(null); else deselect(); }
  };
  const detach = shell.attach({ onPointerDown, onDblClick, onKey, refresh, autoRefreshMs });
  refresh();

  return {
    output: outputNow, startControl, select: selectEvent, deselect, pick, unpick, toggle, clearPicks, reconfirm, addAccessPoint: addPoint, removeAccessPoint: removePoint, setVehicleWidth: setWidth, setActive, setMode,
    save() { return save(); }, serialize: () => serializeRailwayServiceControlDoc(controls),
    // Replaces the whole document (the host's own save). A refused document (other pack, unreadable, other version) leaves the current choices untouched.
    loadDoc(source) {
      if (source === null || source === undefined) return [];
      const before = notes.length;
      const incoming = restoreRailwayServiceControlDoc(typeof source === "string" ? source : JSON.stringify(source), pack);
      const refused = incoming.warnings.some((w) => ["railway-service-control-doc-other-pack", "railway-service-control-doc-unreadable", "railway-service-control-doc-version"].includes(w.code));
      notes.push(...incoming.warnings);
      if (!refused) { controls = incoming.doc; selectedId = null; mode = null; save(); touch(); }
      bump();
      refresh();
      return notes.slice(before);
    },
    refresh, setEnabled(value) { enabledNow = Boolean(value); bump(); refresh(); },
    get selectedEventId() { return selectedId; }, get mode() { return mode; }, get document() { return clone(controls); }, get storageKey() { return store.key; },
    destroy: detach,
  };
}
