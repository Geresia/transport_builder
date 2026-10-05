// Disruption sites, browser side: an independent mount that needs nothing from the host page beyond a canvas, its projection,
// a pack and getters for the engine's disruption events, the rail capacity geometries (M5) and the rail capacity applications.
// For an event the engine raised, the player says where on the rail geometry it is (a click, snapped onto the section), draws
// the area it affects, and, where the application does not already say which map section an operational track is, links
// one. The mount builds the RailwayDisruptionSiteGeometry (M6) and keeps the player's document in localStorage. It makes its
// own overlay, panel and <style>; the events and geometries are read, never written. An event nobody located has NO location:
// it is never put at the middle of its section. Nothing here says how long a disruption lasts, what it costs, how likely it
// is or whether trains can still run.
//
//   const bridge = mountRailwayDisruptionSite({ canvas, projection, pack, getRailGeometry, getRailCapacityApplication, getDisruptionEvents, onChange });
//   bridge.output()  ->  { document, export, sites, selected, selectedEventId, warnings }
import { buildRailwayDisruptionSiteExport } from "./railway-disruption-site.mjs";
import {
  addSite, clearAffectedPolygon, clearLocation, deactivateSite, newRailwayDisruptionDoc, rebindRailGeometry, restoreRailwayDisruptionDoc, restoreSite, serializeRailwayDisruptionDoc, setAffectedPolygon, setLocation,
  setSectionLink, toDrawnSite,
} from "./railway-disruption-site-editor.mjs";
import { buildRailwayDisruptionView, drawRailwayDisruptionOverlay, renderRailwayDisruptionLegend, renderRailwayDisruptionPanel } from "./railway-disruption-site-view.mjs";
import { arr, clone, createShell, createStore } from "./map-mount-kit.mjs";
import { hitSection } from "./rail-capacity-ui-tools.mjs";

export const DISRUPTION_UI_EVENT = "transitline:railway-disruption-site";
export const DISRUPTION_STORAGE_PREFIX = "transitline.railway-disruption.v1:";
export const SCOPE_NOTICE = "이 화면은 장애가 지도의 어디에 있는지와 영향 범위만 다룹니다. 위치를 정하지 않으면 위치 미상으로 남고, 구간 중앙으로 가정하지 않습니다.";
const STYLE_ID = "transitline-railway-disruption-style";
const CSS = `
.tl-disruption-panel{position:fixed;left:12px;bottom:64px;z-index:7;width:340px;max-height:50vh;overflow:auto;padding:8px 10px;border:1px solid #2a2f3a;border-radius:8px;background:rgba(17,19,24,.94);color:#f1f2f5;font:12px/1.4 system-ui,'Malgun Gothic',sans-serif}
.tl-disruption-panel .section-label{margin:6px 0 3px;color:#ffe66d;font-weight:600}
.tl-disruption-panel .diag{margin:3px 0;padding:3px 6px;border-left:3px solid #4cc9f0;border-radius:3px;font-size:11px;overflow-wrap:anywhere}
.tl-disruption-panel .diag.warning{border-left-color:#ffb703}.tl-disruption-panel .diag.info{color:#aab1c0}
.tl-disruption-panel .row{display:flex;align-items:center;gap:6px;margin:2px 0;flex-wrap:wrap}.tl-disruption-panel .row.picked{background:rgba(255,255,255,.08)}
.tl-disruption-panel button{margin:2px 3px 2px 0;padding:2px 7px}.tl-disruption-panel button.on{outline:2px solid #f1f2f5}
`;

export function mountRailwayDisruptionSite({ canvas, projection, pack, getRailGeometry, getRailCapacityApplication, getDisruptionEvents, onChange = () => {}, enabled = true, autoRefreshMs = 250 }) {
  const shell = createShell({ canvas, projection, pack, styleId: STYLE_ID, css: CSS, panelClass: "tl-disruption-panel" });
  const { box, screen, lonLat, el, pointer, button, win } = shell;
  const packId = pack.manifest?.id ?? "pack";
  const notes = [];
  const store = createStore({ win, key: `${DISRUPTION_STORAGE_PREFIX}${packId}`, pack, restore: restoreRailwayDisruptionDoc, serialize: serializeRailwayDisruptionDoc, notes });
  let sites = store.doc;
  const save = () => store.save(sites, "railway-disruption-doc-not-saved");

  let enabledNow = enabled;
  let selectedId = null;
  let mode = null; // null | "locate" | "polygon" | "link-section"
  let draft = [];
  let version = 0;
  let dirty = true;
  let panelVersion = -1;
  let drawVersion = -1;
  let outputVersion = -1;
  let lastRect = "";
  let lastFingerprint = null;
  let inputsNow = { events: [], geometries: [], applications: [] };
  let built = { exportData: { sites: [], inactive: [], warnings: [] }, model: { sites: [], warnings: [] } };

  const bump = () => { version += 1; };
  const touch = () => { dirty = true; };
  const note = (code, extra = {}) => { notes.push({ code, ...extra }); bump(); };
  const inputs = () => ({ events: arr(getDisruptionEvents?.(), "events"), geometries: arr(getRailGeometry?.(), "designs"), applications: arr(getRailCapacityApplication?.(), "applications") });
  const fingerprint = (i) => JSON.stringify([i.events.map((e) => [e.id, e.status, e.trackSegmentId, e.blockId, e.trainId, e.kind, e.effect]), i.geometries.map((g) => [g.railGeometryId, g.railGeometryRevision]), i.applications.map((a) => [a.railGeometryId, a.railGeometryRevision, a.operationalLineId, (a.sections ?? []).length])]);
  const entryOf = (eventId = selectedId) => sites.sites.find((s) => s.eventId === eventId) ?? null;
  const siteOut = (eventId = selectedId) => built.exportData.sites.find((s) => s.eventId === eventId) ?? null;
  const eventOf = (eventId) => inputsNow.events.find((e) => e.id === eventId) ?? null;
  const geometryOf = (id) => inputsNow.geometries.find((g) => g.railGeometryId === id) ?? null;
  // the geometry an event is looked at on: the one its line's application was made on, else the only one there is
  const defaultGeometry = (event) => {
    const app = inputsNow.applications.find((a) => event && String(a.operationalLineId) === String(event.lineId));
    return geometryOf(app?.railGeometryId) ?? (inputsNow.geometries.length === 1 ? inputsNow.geometries[0] : null);
  };
  // the geometry this entry is on: its own, else the default
  const geometryForEntry = (entry) => geometryOf(entry?.railGeometryId) ?? defaultGeometry(eventOf(entry?.eventId));

  function recompute(i) {
    inputsNow = i;
    const exportData = buildRailwayDisruptionSiteExport({ pack, events: i.events, railGeometries: i.geometries, applications: i.applications, sites: sites.sites.map(toDrawnSite) });
    built = { exportData, model: buildRailwayDisruptionView({ exportData, selectedId: siteOut()?.disruptionSiteId ?? null }) };
    bump();
  }
  const outputNow = () => ({ document: clone(sites), export: built.exportData, sites: built.exportData.sites, selected: siteOut(), selectedEventId: selectedId, warnings: [...notes, ...built.exportData.warnings] });
  function emit() {
    if (outputVersion === version) return;
    outputVersion = version;
    const out = outputNow();
    onChange(out);
    canvas.dispatchEvent(new CustomEvent(DISRUPTION_UI_EVENT, { detail: out }));
  }
  function edit(fn) {
    try { fn(); save(); touch(); refresh(); return true; } catch (error) { note("railway-disruption-edit-refused", { message: error.message }); touch(); refresh(); return false; }
  }
  const needEntry = () => { const e = entryOf(); if (!e) throw new Error("No disruption site is selected"); return e; };

  // --- operations ---
  function startSite(eventId, railGeometryId = null) {
    const event = eventOf(eventId);
    if (!event) { note("railway-disruption-event-missing", { eventId }); refresh(); return false; }
    const geometry = railGeometryId ? geometryOf(railGeometryId) : defaultGeometry(event);
    const ok = edit(() => { addSite(sites, eventId, { railGeometry: geometry }); selectedId = eventId; bump(); });
    if (ok && !geometry) note("railway-disruption-geometry-not-chosen", { eventId });
    return ok;
  }
  const selectEvent = (eventId) => { selectedId = entryOf(eventId) ? eventId : null; mode = null; draft = []; bump(); refresh(); return selectedId === eventId; };
  const deselect = () => { selectedId = null; mode = null; draft = []; bump(); refresh(); };
  const chooseGeometry = (railGeometryId) => edit(() => { const g = geometryOf(railGeometryId); if (!g) throw new Error(`Unknown rail geometry ${railGeometryId}`); const e = needEntry(); rebindRailGeometry(sites, e.eventId, g); });
  const rebind = () => edit(() => { const e = needEntry(); const g = geometryForEntry(e); if (!g) throw new Error("No rail geometry to re-confirm against"); rebindRailGeometry(sites, e.eventId, g); });
  // where the event is: a point snapped onto the section the site is on (within 50 m), else kept as the player's statement
  const locate = (location) => edit(() => {
    const e = needEntry();
    const event = eventOf(e.eventId);
    if (event?.trainId && !event.trackSegmentId) throw new Error("A train has no position on the map");
    setLocation(sites, e.eventId, location, { railGeometry: geometryForEntry(e), sectionId: siteOut(e.eventId)?.railCapacitySectionId ?? e.railCapacitySectionId ?? null });
  });
  const unlocate = () => edit(() => clearLocation(sites, needEntry().eventId));
  const polygon = (points) => edit(() => setAffectedPolygon(sites, needEntry().eventId, points));
  const unpolygon = () => edit(() => clearAffectedPolygon(sites, needEntry().eventId));
  const linkSection = (sectionId) => edit(() => setSectionLink(sites, needEntry().eventId, sectionId));
  const setActive = (active) => edit(() => (active ? restoreSite : deactivateSite)(sites, needEntry().eventId));

  const setMode = (m) => {
    if (m && !entryOf()) { note("railway-disruption-no-site-selected"); refresh(); return false; }
    if (m === "locate" && eventOf(selectedId)?.trainId && !eventOf(selectedId)?.trackSegmentId) { note("railway-disruption-train-has-no-position", { eventId: selectedId }); refresh(); return false; }
    mode = m; draft = []; bump(); refresh(); return true;
  };
  function finishPolygon() {
    if (mode !== "polygon") return false;
    if (draft.length < 3) { note("railway-disruption-polygon-needs-three-points"); refresh(); return false; }
    const points = draft;
    mode = null;
    draft = [];
    bump();
    return polygon(points);
  }
  function onMapClick(p) {
    if (mode === "locate") { locate(lonLat(p[0], p[1])); mode = null; bump(); refresh(); return; }
    if (mode === "polygon") { draft.push(lonLat(p[0], p[1])); bump(); refresh(); return; }
    if (mode === "link-section") {
      const g = geometryForEntry(entryOf());
      const hit = g ? hitSection(g, screen, p) : null;
      if (hit) { linkSection(hit.section.sectionId); mode = null; bump(); refresh(); }
    }
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
    drawRailwayDisruptionOverlay(ctx, built.model, screen);
    if (draft.length) {
      ctx.save();
      ctx.strokeStyle = "#fb923c";
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 5]);
      ctx.beginPath();
      draft.map(screen).forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.stroke();
      ctx.restore();
    }
  }

  // --- the panel ---
  function renderPanel() {
    box.replaceChildren();
    box.hidden = !enabledNow;
    if (!enabledNow) return;
    box.append(el("div", "section-label", "운행 장애 위치 (지도 편집)"));
    box.append(el("div", "diag info", SCOPE_NOTICE));
    box.append(el("div", "section-label", `엔진의 장애 ${inputsNow.events.length}건`));
    if (!inputsNow.events.length) box.append(el("div", "diag info", "지금 장애가 없습니다."));
    if (!inputsNow.geometries.length) box.append(el("div", "diag warning", "철도 공간 설계가 없어서 위치를 지정할 수 없습니다."));
    for (const e of inputsNow.events) {
      const entry = entryOf(e.id);
      const out = siteOut(e.id);
      const row = el("div", `row${e.id === selectedId ? " picked" : ""}`);
      row.append(el("span", "", `${e.id} · ${e.kind} · ${e.status}${entry ? (entry.active === false ? " · 꺼짐" : out ? (out.location ? " · 위치 있음" : " · 위치 미상") : " · 만들 수 없음") : ""}`));
      button(row, entry ? "선택" : "위치 지정 시작", () => (entry ? selectEvent(e.id) : startSite(e.id)));
      box.append(row);
    }
    const entry = entryOf();
    const out = siteOut();
    if (entry) {
      box.append(el("div", "section-label", `선택한 장애: ${entry.eventId}`));
      const g = geometryForEntry(entry);
      if (!entry.railGeometryId || !geometryOf(entry.railGeometryId)) {
        box.append(el("div", "diag warning", "이 장애를 놓을 철도 설계를 고르세요."));
        for (const geo of inputsNow.geometries) { const r = el("div", "row"); r.append(el("span", "", geo.name ?? geo.railGeometryId)); button(r, "이 설계 사용", () => chooseGeometry(geo.railGeometryId)); box.append(r); }
      }
      if (g && entry.designedRailGeometryRevision !== g.railGeometryRevision) { box.append(el("div", "diag warning", "철도 설계가 바뀌었습니다. 위치와 영향권은 다시 확인하기 전까지 값이 없습니다.")); button(box, "현재 철도 설계로 다시 확인", rebind); }
      if (mode) { box.append(el("div", "diag info", mode === "locate" ? "지도에서 장애 위치를 클릭하세요." : mode === "polygon" ? "점을 클릭해 영향권을 그리고 완료(또는 더블클릭/Enter)를 누르세요." : "연결할 철도 구간을 클릭하세요.")); const bar = el("div"); if (mode === "polygon") button(bar, "완료", finishPolygon); button(bar, "취소", () => setMode(null)); box.append(bar); }
      else {
        const bar = el("div");
        button(bar, "위치 지정", () => setMode("locate"));
        button(bar, "위치 지움", unlocate);
        button(bar, "영향권 그리기", () => setMode("polygon"));
        button(bar, "영향권 지움", unpolygon);
        button(bar, "구간 연결 지정", () => setMode("link-section"));
        button(bar, entry.railCapacitySectionId ? "구간 연결 해제" : "연결 해제 없음", () => entry.railCapacitySectionId && linkSection(null));
        button(bar, entry.active === false ? "켜기" : "끄기", () => setActive(entry.active === false));
        button(bar, "선택 해제", deselect);
        box.append(bar);
      }
      if (!out && entry.active !== false) box.append(el("div", "diag warning", "이 장애의 위치 사실을 만들 수 없습니다: 아래 경고를 확인하세요. 값을 추정하지 않습니다."));
    }
    if (out) { const body = el("div"); box.append(body); renderRailwayDisruptionPanel(body, { ...built.model, sites: built.model.sites.filter((s) => s.eventId === out.eventId) }); }
    const legend = el("div");
    box.append(legend);
    renderRailwayDisruptionLegend(legend);
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

  const onPointerDown = (ev) => {
    if (!enabledNow || !mode) return;
    ev.stopImmediatePropagation?.();
    onMapClick(pointer(ev));
  };
  const onDblClick = () => { if (enabledNow && mode === "polygon") finishPolygon(); };
  const onKey = (ev) => {
    if (!enabledNow || shell.typing()) return;
    if (ev.key === "Enter" && mode === "polygon") finishPolygon();
    else if (ev.key === "Escape") { if (mode) setMode(null); else deselect(); }
  };
  const detach = shell.attach({ onPointerDown, onDblClick, onKey, refresh, autoRefreshMs });
  refresh();

  return {
    output: outputNow, startSite, select: selectEvent, deselect, chooseGeometry, rebind, locate, clearLocation: unlocate, setPolygon: polygon, clearPolygon: unpolygon, linkSection, unlinkSection: () => linkSection(null), setActive,
    setMode, finishPolygon, addDraftPoint(location) { if (mode === "polygon") { draft.push(clone(location)); bump(); refresh(); } },
    save() { return save(); }, serialize: () => serializeRailwayDisruptionDoc(sites),
    // Replaces the whole document (the host's own save). A refused document (other pack, unreadable, other version) leaves the current sites untouched.
    loadDoc(source) {
      if (source === null || source === undefined) return [];
      const before = notes.length;
      const incoming = restoreRailwayDisruptionDoc(typeof source === "string" ? source : JSON.stringify(source), pack);
      const refused = incoming.warnings.some((w) => ["railway-disruption-doc-other-pack", "railway-disruption-doc-unreadable", "railway-disruption-doc-version"].includes(w.code));
      notes.push(...incoming.warnings);
      if (!refused) { sites = incoming.doc; selectedId = null; mode = null; draft = []; save(); touch(); }
      bump();
      refresh();
      return notes.slice(before);
    },
    refresh, setEnabled(value) { enabledNow = Boolean(value); bump(); refresh(); },
    get selectedEventId() { return selectedId; }, get mode() { return mode; }, get document() { return clone(sites); }, get storageKey() { return store.key; },
    destroy: detach,
  };
}
