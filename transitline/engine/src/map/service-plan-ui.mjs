// Service plan editor, browser side: an independent mount that needs nothing from the host page beyond a canvas, its projection,
// a pack and getters for the RailCapacityGeometry list and the applied capacity results. The player chooses a geometry (and the
// application of the line it belongs to), writes service plans on it — sections in order, directions, time bands with the headway /
// trainsets / cars they ASK for, turnbacks, the vehicle they have in mind, depot references, assumptions — and the mount keeps that
// document in localStorage. It builds the plans with service-plan-geometry.mjs and edits them with service-plan-editor.mjs; it makes
// its own overlay, panel and <style>; the geometries, applications and catalogs are read, never written. It computes nothing about
// running the plan (no cost, demand, crowding, timetable, capacity or verdict): unknown stays unknown, a request stays a request.
//
//   const bridge = mountServicePlanEditor({ canvas, projection, pack, getRailGeometries, getApplications, getVehicleModels, getDepots, onChange });
//   bridge.output()  ->  { document, export, plans, selected, selectedKey, geometryId, applicationLine, mode, view, warnings }
import { buildServicePlanExport } from "./service-plan-geometry.mjs";
import {
  addAssumption as editAddAssumption, addBand as editAddBand, addBothDirections, addDepotRef as editAddDepotRef, addDirection as editAddDirection, addPlan, addTurnback as editAddTurnback, appendSection, clearList as editClearList,
  clearRoute as editClearRoute, deactivateBand, deactivatePlan as editDeactivate, declareNone, drawnPlansOf, moveSection as editMoveSection, rebindRevision, removeAssumption as editRemoveAssumption, removeBand as editRemoveBand,
  removeDepotRef as editRemoveDepot, removeDirection as editRemoveDirection, removePlan as editRemovePlan, removeSection as editRemoveSection, removeTurnback as editRemoveTurnback, restoreBand, restorePlan as editRestore, restoreServicePlanDoc,
  reverseRoute as editReverseRoute, serializeServicePlanDoc, setVehicleIntent, updateBand as editUpdateBand, updatePlan, updateTurnback,
} from "./service-plan-editor.mjs";
import { buildServicePlanView, drawServicePlanOverlay } from "./service-plan-view.mjs";
import { renderServicePlanPanel } from "./service-plan-panel.mjs";
import { hitSection, hitStation, parseNumber, stationsOf } from "./service-plan-tools.mjs";
import { clone, createShell, createStore } from "./map-mount-kit.mjs";

export const SERVICE_PLAN_UI_EVENT = "transitline:service-plan-editor";
export const SERVICE_PLAN_STORAGE_PREFIX = "transitline.service-plan.v1:";
const STYLE_ID = "transitline-service-plan-style";
const CSS = `
.tl-plan-panel{position:fixed;right:12px;top:64px;z-index:7;width:380px;max-height:78vh;overflow:auto;padding:8px 10px;border:1px solid #2a2f3a;border-radius:8px;background:rgba(17,19,24,.95);color:#f1f2f5;font:12px/1.4 system-ui,'Malgun Gothic',sans-serif}
.tl-plan-panel .section-label{margin:8px 0 3px;color:#ffe66d;font-weight:600}
.tl-plan-panel .diag{margin:3px 0;padding:3px 6px;border-left:3px solid #4cc9f0;border-radius:3px;font-size:11px;overflow-wrap:anywhere}
.tl-plan-panel .diag.warning{border-left-color:#ffb703}.tl-plan-panel .diag.info{color:#aab1c0}
.tl-plan-panel .row{display:flex;align-items:center;gap:6px;margin:2px 0;flex-wrap:wrap}.tl-plan-panel .row.picked{background:rgba(255,255,255,.08)}
.tl-plan-panel label.field{display:inline-flex;align-items:center;gap:4px}.tl-plan-panel input[type=text],.tl-plan-panel select{max-width:170px;background:#1b1e26;color:#f1f2f5;border:1px solid #3a4152;border-radius:4px;padding:1px 4px}
.tl-plan-panel input.narrow{width:56px}.tl-plan-panel button{margin:2px 3px 2px 0;padding:2px 7px}.tl-plan-panel button.on{outline:2px solid #f1f2f5}
`;
const emptyBand = (directionKeys = null) => ({ editing: null, label: "", periodId: "", startMinute: "", endMinute: "", headwayMinutes: "", trainsets: "", formationCars: "", directionKeys });
const emptyVehicle = () => ({ vehicleModelId: "", requestedCars: "", requestedTrainsets: "" });
const emptyDepot = () => ({ depotSiteId: "", stationId: "", role: "" });
const text = (v) => (v === null || v === undefined ? "" : String(v));
const toList = (v, keys) => (Array.isArray(v) ? v : v ? (keys.map((k) => v[k]).find(Array.isArray) ?? [v]) : []);
const catalog = (v) => (v === null || v === undefined ? null : toList(v, ["items"]).map((x) => (typeof x === "string" ? { id: x, name: x } : { id: String(x.id), name: x.name ?? String(x.id) })));

export function mountServicePlanEditor({ canvas, projection, pack, getRailGeometries, getApplications = () => [], getVehicleModels = null, getDepots = null, onChange = () => {}, enabled = true, autoRefreshMs = 250 }) {
  const shell = createShell({ canvas, projection, pack, styleId: STYLE_ID, css: CSS, panelClass: "tl-plan-panel" });
  const { box, screen, el, pointer, win } = shell;
  const packId = pack.manifest?.id ?? "pack";
  const notes = [];
  const store = createStore({ win, key: `${SERVICE_PLAN_STORAGE_PREFIX}${packId}`, pack, restore: restoreServicePlanDoc, serialize: serializeServicePlanDoc, notes });
  let doc = store.doc;
  let saved = null;

  let enabledNow = enabled;
  let selectedKey = null;
  let geometryId = null;
  let applicationLine = null;
  let mode = null; // "pick-section" | "pick-turnback"
  let drafts = { planName: "", dirFrom: "", dirTo: "", assumption: "", band: emptyBand(), vehicle: emptyVehicle(), depot: emptyDepot() };
  let version = 0;
  let dirty = true;
  let panelVersion = -1;
  let drawVersion = -1;
  let outputVersion = -1;
  let lastRect = "";
  let lastFingerprint = null;
  let built = { exportData: { plans: [], warnings: [] }, geometries: [], applications: [], geometry: null, model: buildServicePlanView(), catalogs: { vehicleModels: null, depots: null } };

  const bump = () => { version += 1; };
  const touch = () => { dirty = true; };
  const note = (code, extra = {}) => { const last = notes.at(-1); if (!last || last.code !== code || last.message !== extra.message) notes.push({ code, ...extra }); bump(); };
  const planDoc = (key = selectedKey) => doc.plans.find((p) => p.key === key && !p.deleted) ?? null;
  const planOut = (key = selectedKey) => built.exportData.plans.find((p) => p.key === key) ?? null;
  const geometryById = (id) => built.geometries.find((g) => g.railGeometryId === id) ?? null;
  const inputs = () => ({
    geometries: toList(getRailGeometries?.(), ["railGeometries", "designs"]).filter((g) => g && g.sections), applications: toList(getApplications?.(), ["applications"]).filter((a) => a && a.railGeometryId),
    vehicleModels: catalog(getVehicleModels?.()), depots: catalog(getDepots?.()),
  });
  const fingerprint = (i) => JSON.stringify([i.geometries.map((g) => [g.railGeometryId, g.railGeometryRevision]), i.applications.map((a) => [a.operationalLineId, a.railGeometryId, a.railGeometryRevision, a.applicationId]), i.vehicleModels, i.depots]);

  function recompute(i) {
    const geometries = [...i.geometries].sort((a, b) => (a.railGeometryId < b.railGeometryId ? -1 : 1));
    if (!geometryId && geometries.length === 1) geometryId = geometries[0].railGeometryId;
    const exportData = buildServicePlanExport({ pack, railGeometries: geometries, applications: i.applications, plans: drawnPlansOf(doc) });
    const wanted = planDoc()?.railGeometryId ?? geometryId;
    const geometry = geometries.find((g) => g.railGeometryId === wanted) ?? null;
    const out = exportData.plans.find((p) => p.key === selectedKey) ?? null;
    built = { exportData, geometries, applications: i.applications, geometry, model: buildServicePlanView({ geometry, planOut: out }), catalogs: { vehicleModels: i.vehicleModels, depots: i.depots } };
    bump();
  }
  function outputNow() {
    const exportData = clone(built.exportData);
    return {
      document: clone(doc), export: exportData, plans: exportData.plans, selected: exportData.plans.find((p) => p.key === selectedKey) ?? null, selectedKey, geometryId, applicationLine, mode, view: clone(built.model),
      warnings: [...clone(notes), ...exportData.warnings],
    };
  }
  function emit() {
    if (outputVersion === version) return;
    outputVersion = version;
    const out = outputNow();
    onChange(out);
    canvas.dispatchEvent(new CustomEvent(SERVICE_PLAN_UI_EVENT, { detail: out }));
  }

  // --- the edit: one place that applies it, saves it and says so when the editor refuses ---
  function edit(fn, opts = {}) {
    try { const r = fn(); saved = store.save(doc, "service-plan-doc-not-saved"); touch(); refresh(opts); return r ?? true; } catch (error) { note("service-plan-edit-refused", { message: error.message }); touch(); refresh(); return false; }
  }
  const need = () => { const p = planDoc(); if (!p) throw new Error("No service plan is selected"); return p.key; };
  const draft = (field, value) => { drafts[field] = value; };

  // --- map and application ---
  const applicationsFor = () => (built.geometry ? built.applications.filter((a) => a.railGeometryId === built.geometry.railGeometryId).map((a) => ({ lineId: String(a.operationalLineId), state: a.railGeometryRevision === built.geometry.railGeometryRevision ? "current" : "stale" })).sort((a, b) => (a.lineId < b.lineId ? -1 : 1)) : []);
  function selectGeometry(id) { geometryId = id || null; if (!planDoc()) selectedKey = null; applicationLine = null; mode = null; touch(); bump(); refresh(); return geometryId === (id || null); }
  function selectApplication(lineId) {
    applicationLine = lineId || null;
    if (planDoc()) return edit(() => { updatePlan(doc, need(), { operationalLineId: applicationLine }); });
    bump(); refresh();
    return true;
  }

  // --- plans ---
  function createPlan({ name = drafts.planName } = {}) {
    const geometry = built.geometry;
    if (!geometry) { note("service-plan-no-geometry-selected"); refresh(); return null; }
    const key = edit(() => { const p = addPlan(doc, { name: name === "" ? null : name, railGeometry: geometry, operationalLineId: applicationLine }); selectedKey = p.key; drafts = { ...drafts, planName: "", band: emptyBand(), vehicle: emptyVehicle() }; return p.key; });
    return key === false ? null : key;
  }
  function selectPlan(key) {
    const p = planDoc(key);
    selectedKey = p ? key : null;
    mode = null;
    if (p) { geometryId = p.railGeometryId; applicationLine = p.operationalLineId ?? null; drafts = { ...drafts, band: emptyBand(), vehicle: { vehicleModelId: text(p.vehicleIntent?.vehicleModelId), requestedCars: text(p.vehicleIntent?.requestedCars), requestedTrainsets: text(p.vehicleIntent?.requestedTrainsets) }, depot: emptyDepot() }; }
    touch(); bump(); refresh();
    return Boolean(p);
  }
  const deselect = () => { selectedKey = null; mode = null; touch(); bump(); refresh(); };
  const deactivatePlan = (key = selectedKey) => edit(() => { editDeactivate(doc, key); });
  const restorePlan = (key = selectedKey) => edit(() => { editRestore(doc, key); });
  const removePlan = (key = selectedKey) => edit(() => { editRemovePlan(doc, key); if (selectedKey === key) { selectedKey = null; mode = null; } });
  const rebind = () => edit(() => { const p = planDoc(); const g = geometryById(p?.railGeometryId); if (!p || !g) throw new Error("The plan's rail geometry is not available"); rebindRevision(doc, p.key, g); });
  const setPlanField = (field, value) => edit(() => { if (!["name", "planKind", "operatingPattern", "operationalLineId"].includes(field)) throw new Error(`Not a plan field: ${field}`); updatePlan(doc, need(), { [field]: value }); if (field === "operationalLineId") applicationLine = value; }, { keepPanel: field === "name" });

  // --- route ---
  const addSection = (sectionId) => edit(() => { appendSection(doc, need(), sectionId, built.geometry); });
  const removeSection = (sectionId) => edit(() => { editRemoveSection(doc, need(), sectionId); });
  const moveSection = (from, to) => edit(() => { editMoveSection(doc, need(), from, to); });
  const reverseRoute = () => edit(() => { editReverseRoute(doc, need()); });
  const clearRoute = () => edit(() => { editClearRoute(doc, need()); });

  // --- directions ---
  function addDirection(fromStationId, toStationId, label) {
    return edit(() => {
      const p = planDoc(need());
      if (!fromStationId || !toStationId || fromStationId === toStationId) throw new Error("A direction needs two different stations");
      if ((p.directions ?? []).some((d) => d.fromStationId === fromStationId && d.toStationId === toStationId)) throw new Error("That direction is already there");
      return editAddDirection(doc, p.key, { fromStationId, toStationId, ...(label ? { label } : {}) }).key;
    });
  }
  function addDirections(kind) {
    const r = planOut()?.route;
    if (!r?.fromStationId || !r?.toStationId) { note("service-plan-route-ends-unknown"); refresh(); return false; }
    if (kind === "forward") return addDirection(r.fromStationId, r.toStationId, "정방향");
    if (kind === "reverse") return addDirection(r.toStationId, r.fromStationId, "역방향");
    return edit(() => {
      const p = planDoc(need());
      if ((p.directions ?? []).some((d) => (d.fromStationId === r.fromStationId && d.toStationId === r.toStationId) || (d.fromStationId === r.toStationId && d.toStationId === r.fromStationId))) throw new Error("Those directions are already there");
      return addBothDirections(doc, p.key, r.fromStationId, r.toStationId, ["정방향", "역방향"]).map((d) => d.key);
    });
  }
  const addManualDirection = () => addDirection(drafts.dirFrom, drafts.dirTo);
  const removeDirection = (key) => edit(() => { editRemoveDirection(doc, need(), key); });
  const clearList = (type) => edit(() => { editClearList(doc, need(), type); });

  // --- time bands: numbers are what the player asked for; a blank is "not stated" (null) ---
  const bandValues = (d) => {
    const nums = {};
    for (const f of ["startMinute", "endMinute", "headwayMinutes", "trainsets", "formationCars"]) {
      const v = parseNumber(d[f]);
      if (Number.isNaN(v)) throw new Error(`${f} is not a number`);
      nums[f] = v === undefined ? null : v;
    }
    if (nums.startMinute === null || nums.endMinute === null) throw new Error("A time band needs a start and an end minute");
    return { ...nums, label: d.label === "" ? null : d.label, periodId: d.periodId === "" ? null : d.periodId, ...(d.directionKeys === null ? {} : { directionKeys: [...d.directionKeys].sort() }) }; // untouched = every direction the plan has
  };
  const addBand = (values) => edit(() => editAddBand(doc, need(), values).key);
  const updateBand = (key, values) => edit(() => { editUpdateBand(doc, need(), key, values); });
  const toggleBand = (key) => edit(() => { const b = planDoc(need()).serviceBands?.find((x) => x.key === key); if (!b) throw new Error(`Unknown band ${key}`); if (b.active === false) restoreBand(doc, need(), key); else deactivateBand(doc, need(), key); });
  const removeBand = (key) => edit(() => { editRemoveBand(doc, need(), key); if (drafts.band.editing === key) drafts.band = emptyBand(); });
  function saveBand() {
    const d = drafts.band;
    return edit(() => {
      const values = bandValues(d);
      if (d.editing) editUpdateBand(doc, need(), d.editing, values); else editAddBand(doc, need(), values);
      drafts.band = emptyBand();
    });
  }
  function editBand(key) {
    const b = planDoc()?.serviceBands?.find((x) => x.key === key);
    if (!b) return false;
    drafts.band = { editing: key, label: text(b.label), periodId: text(b.periodId), startMinute: text(b.startMinute), endMinute: text(b.endMinute), headwayMinutes: text(b.headwayMinutes), trainsets: text(b.trainsets), formationCars: text(b.formationCars), directionKeys: b.directionKeys === null || b.directionKeys === undefined ? null : [...b.directionKeys] };
    bump(); refresh();
    return true;
  }
  const cancelBandEdit = () => { drafts.band = emptyBand(); bump(); refresh(); };

  // --- turnbacks ---
  function addTurnback(stationId) {
    return edit(() => {
      const p = planDoc(need());
      if ((p.turnbacks ?? []).some((t) => t.stationId === stationId)) throw new Error("A turnback is already there");
      const r = planOut(p.key)?.route;
      return editAddTurnback(doc, p.key, { stationId, intent: r && (r.fromStationId === stationId || r.toStationId === stationId) ? "route-end" : "intermediate" }).key;
    });
  }
  const setTurnback = (key, patch) => edit(() => { updateTurnback(doc, need(), key, patch); });
  const removeTurnback = (key) => edit(() => { editRemoveTurnback(doc, need(), key); });
  const declareNoTurnbacks = () => edit(() => { declareNone(doc, need(), "turnback"); });

  // --- vehicle, depot references, assumptions ---
  function setVehicle(values) {
    return edit(() => {
      const out = {};
      for (const [f, v] of Object.entries(values)) {
        if (f === "vehicleModelId") out[f] = v === "" || v === undefined ? null : String(v);
        else { const n = typeof v === "number" ? v : parseNumber(v); if (Number.isNaN(n)) throw new Error(`${f} is not a number`); out[f] = n === undefined ? null : n; }
      }
      setVehicleIntent(doc, need(), out);
    });
  }
  const saveVehicle = () => setVehicle(drafts.vehicle);
  const draftVehicle = (field, value) => { drafts.vehicle[field] = value; };
  const draftDepot = (field, value) => { drafts.depot[field] = value; };
  const draftBand = (field, value) => { drafts.band[field] = value; };
  const draftBandDirection = (key, on) => { const set = new Set(drafts.band.directionKeys ?? (planDoc()?.directions ?? []).map((d) => d.key)); if (on) set.add(key); else set.delete(key); drafts.band.directionKeys = [...set].sort(); };
  function addDepotRef(values = drafts.depot) {
    return edit(() => {
      if (!values.depotSiteId && !values.stationId) throw new Error("A depot reference needs a depot or a station");
      const key = editAddDepotRef(doc, need(), { depotSiteId: values.depotSiteId || undefined, stationId: values.stationId || undefined, role: values.role || undefined }).key;
      drafts.depot = emptyDepot();
      return key;
    });
  }
  const removeDepotRef = (key) => edit(() => { editRemoveDepot(doc, need(), key); });
  function addAssumption(value = drafts.assumption) {
    return edit(() => { if (String(value).trim() === "") throw new Error("An assumption needs some text"); const k = editAddAssumption(doc, need(), String(value).trim()).key; drafts.assumption = ""; return k; });
  }
  const removeAssumption = (key) => edit(() => { editRemoveAssumption(doc, need(), key); });

  // --- modes and the map ---
  function setMode(kind) {
    if (kind && !planDoc()) { note("service-plan-no-plan-selected"); refresh(); return false; }
    mode = kind && mode !== kind ? kind : null;
    bump(); refresh();
    return true;
  }
  const routeStations = () => {
    const ids = new Set(planDoc()?.route?.sectionIds ?? []);
    return stationsOf({ sections: (built.geometry?.sections ?? []).filter((s) => ids.has(s.sectionId)) });
  };
  function onMapClick(p) {
    const geometry = built.geometry;
    if (!geometry || !mode) return false;
    if (mode === "pick-section") {
      const hit = hitSection(geometry, screen, p);
      if (!hit) return false;
      if ((planDoc()?.route?.sectionIds ?? []).includes(hit.sectionId)) removeSection(hit.sectionId); else addSection(hit.sectionId);
      return true;
    }
    if (mode === "pick-turnback") {
      const own = routeStations();
      const id = hitStation(own.length ? own : stationsOf(geometry), screen, p);
      if (!id) return false;
      addTurnback(id);
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
    drawServicePlanOverlay(ctx, built.model, screen);
  }

  const helpers = {
    el, button: shell.button,
    select(parent, caption, value, options, onChange) {
      const wrap = el("label", "field");
      wrap.append(el("span", "", caption));
      const sel = el("select");
      const all = value && !options.some((o) => o.value === value) ? [...options, { value, label: `${value} (목록에 없음)` }] : options;
      for (const o of all) { const opt = el("option", "", o.label); opt.value = o.value; sel.append(opt); }
      wrap.append(sel);
      parent.append(wrap);
      sel.value = value ?? "";
      sel.addEventListener("change", () => onChange(sel.value));
      return sel;
    },
    input(parent, caption, value, onInput, { narrow = false } = {}) {
      const wrap = el("label", "field");
      wrap.append(el("span", "", caption));
      const inp = el("input", narrow ? "narrow" : "");
      inp.type = "text";
      inp.value = value ?? "";
      for (const type of ["input", "change"]) inp.addEventListener(type, () => onInput(inp.value));
      wrap.append(inp);
      parent.append(wrap);
      return inp;
    },
    check(parent, caption, checked, onChange) {
      const wrap = el("label", "field");
      const inp = el("input");
      inp.type = "checkbox";
      inp.checked = Boolean(checked);
      inp.addEventListener("change", () => onChange(inp.checked));
      wrap.append(inp, el("span", "", caption));
      parent.append(wrap);
      return inp;
    },
  };
  const act = {
    selectGeometry, selectApplication, createPlan: () => createPlan(), selectPlan, deselect, deactivatePlan, restorePlan, removePlan, rebind, setPlanField, setMode, moveSection, removeSection, reverseRoute, clearRoute,
    addDirections, addManualDirection, removeDirection, clearList: (type) => clearList(type), saveBand, editBand, cancelBandEdit, toggleBand, removeBand, setTurnback, removeTurnback, declareNoTurnbacks,
    saveVehicle, addDepot: () => addDepotRef(), removeDepot: removeDepotRef, addAssumption: () => addAssumption(), removeAssumption, draft, draftBand, draftBandDirection, draftVehicle, draftDepot,
  };

  function renderPanel() {
    const scrolled = box.scrollTop; // a rebuilt panel keeps the place the player was working at
    box.replaceChildren();
    box.hidden = !enabledNow;
    if (!enabledNow) return;
    const p = planDoc();
    const g = built.geometry;
    renderServicePlanPanel(box, helpers, {
      act, mode, drafts, notes, saved, exportWarnings: built.exportData.warnings, model: built.model, catalogs: built.catalogs,
      geometries: built.geometries.map((x) => ({ id: x.railGeometryId, label: x.name ?? x.key ?? "철도 용량 지도", revision: x.railGeometryRevision, sections: x.sections.length })), geometryId: g?.railGeometryId ?? geometryId, geometry: g,
      applications: applicationsFor(), applicationLine, selectedKey: p?.key ?? null, plan: p, planOut: p ? planOut(p.key) : null, routeStations: routeStations().map((x) => x.stationId),
      plans: doc.plans.filter((x) => !x.deleted).map((x) => ({ key: x.key, name: x.name, active: x.active !== false, state: planOut(x.key)?.revision.state ?? null })), removedKeys: doc.plans.filter((x) => x.deleted).map((x) => x.key),
    });
    if (scrolled) box.scrollTop = scrolled;
  }

  function refresh({ keepPanel = false } = {}) {
    const i = inputs();
    const fp = fingerprint(i);
    if (dirty || fp !== lastFingerprint) { lastFingerprint = fp; dirty = false; recompute(i); }
    if (selectedKey && !planDoc()) selectedKey = null;
    drawLayer();
    if (keepPanel) panelVersion = version;
    if (panelVersion !== version) { panelVersion = version; renderPanel(); }
    emit();
  }

  // --- pointer, keyboard: a click is taken only when it picks something; every other click goes on to the map ---
  const onPointerDown = (ev) => {
    if (!enabledNow || !mode) return;
    if (onMapClick(pointer(ev))) ev.stopImmediatePropagation?.();
  };
  const onDblClick = () => {};
  const onKey = (ev) => {
    if (!enabledNow || shell.typing()) return;
    if (ev.key === "Escape") { if (mode) setMode(null); else if (selectedKey) deselect(); }
  };
  const detach = shell.attach({ onPointerDown, onDblClick, onKey, refresh: () => refresh(), autoRefreshMs });
  refresh();

  return {
    output: outputNow, selectGeometry, selectApplication, createPlan, selectPlan, deselect, deactivatePlan, restorePlan, removePlan, rebind, setPlanField,
    addSection, removeSection, moveSection, reverseRoute, clearRoute, addDirection, addDirections, removeDirection, clearList,
    addBand, updateBand, toggleBand, removeBand, addTurnback, setTurnback, removeTurnback, declareNoTurnbacks, setVehicle, addDepotRef, removeDepotRef, addAssumption, removeAssumption, setMode,
    save() { saved = store.save(doc, "service-plan-doc-not-saved"); bump(); refresh(); return saved; }, serialize: () => serializeServicePlanDoc(doc),
    // Replaces the whole document (the host's own save). A refused document (other pack, unreadable, other version) leaves the current plans untouched.
    loadDoc(source) {
      if (source === null || source === undefined) return [];
      const before = notes.length;
      const incoming = restoreServicePlanDoc(typeof source === "string" ? source : JSON.stringify(source), pack, { current: doc });
      notes.push(...incoming.warnings);
      if (!incoming.rejected) { doc = incoming.doc; selectedKey = null; mode = null; saved = store.save(doc, "service-plan-doc-not-saved"); touch(); }
      bump();
      refresh();
      return notes.slice(before);
    },
    refresh: () => refresh(), setEnabled(value) { enabledNow = Boolean(value); bump(); refresh(); },
    get selectedKey() { return selectedKey; }, get mode() { return mode; }, get document() { return clone(doc); }, get storageKey() { return store.key; },
    destroy: detach,
  };
}
