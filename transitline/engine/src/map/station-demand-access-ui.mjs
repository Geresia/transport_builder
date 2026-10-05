// Station access, browser side: an independent mount that needs nothing from the host page beyond a canvas, its projection, a
// pack and getters for the plans, the existing networks and (optionally) the demand nodes, demand sources and spatial layers.
// The player picks a station (a plan station, an existing one, or a new place) and draws, on the map, its entrances, walking
// access points, the walking links between them, transfer passages, the access boundary and the living-area zones; every one
// of them can be moved, reshaped, renamed or deleted. The mount builds the StationDemandAccessGeometry (B15-M1) and keeps
// the player's document in localStorage. It makes its own overlay, panel and <style>. Nothing here says how many people come,
// what they pay, how crowded it is, how long a walk takes or how good a station is: it handles places, shapes and lengths.
//
//   const bridge = mountStationDemandAccess({ canvas, projection, pack, getPlans, getExternalNetworks, getDemandNodes, getDemandSources, getSpatial, onChange });
//   bridge.output()  ->  { document, export, sites, selected, selectedStationKey, selection, warnings }
import { demandNodesFromPack } from "./plan-geometry.mjs";
import { makeSpatialContext } from "./spatial.mjs";
import { ACCESS_POINT_KINDS, DEMAND_ZONE_KINDS, buildStationDemandAccessExport, stationAccessIdOf } from "./station-demand-access.mjs";
import {
  addAccessPoint, addCatchment, addDemandZone, addEntrance, addStation, addWalkLink, clearTransfer, insertVertex, moveElement, moveStation, moveVertex,
  referencesTo, removeElement, removeStation, removeVertex, restoreStation, restoreStationDemandAccessDoc, serializeStationDemandAccessDoc, setTransfer, setWalkLinkVia, toDrawnStation,
  updateElement, updateStation,
} from "./station-demand-access-editor.mjs";
import {
  ELEMENT_LABELS, STATION_KIND_LABELS, buildStationAccessView, drawStationAccessOverlay, drawStationDots, renderStationAccessLegend, renderStationAccessPanel,
} from "./station-demand-access-view.mjs";
import { edgeAt, endpointAt, hitSite, stationAt, vertexAt } from "./station-demand-access-tools.mjs";
import { arr, clone, createShell, createStore } from "./map-mount-kit.mjs";

export const STATION_ACCESS_UI_EVENT = "transitline:station-demand-access";
export const STATION_ACCESS_STORAGE_PREFIX = "transitline.station-demand-access.v1:";
export const SCOPE_NOTICE = "이 화면은 출입구, 접근점, 보행 연결, 환승 통로, 접근권 경계, 수요 구역의 위치와 모양만 다룹니다. 이용자 수, 운임, 혼잡, 걸음 소요는 계산하지 않고, 그리지 않은 것은 미상으로 남습니다.";
export const MODES = Object.freeze(["pick-station", "place-station", "entrance", "access-point", "catchment", "catchment-entrance", "zone", "walk-link", "transfer", "move", "vertex-move", "vertex-add", "vertex-remove"]);
const HINTS = {
  "pick-station": "지도에서 접근을 그릴 역(작은 점)을 클릭하세요.", "place-station": "새 역을 놓을 곳을 클릭하세요.", entrance: "출입구를 놓을 곳을 클릭하세요. (Esc로 끝냄)", "access-point": "접근점을 놓을 곳을 클릭하세요. (Esc로 끝냄)",
  catchment: "점을 클릭해 접근권 경계를 그리고 완료(Enter, 더블클릭)를 누르세요.", "catchment-entrance": "점을 클릭해 선택한 출입구의 경계를 그리고 완료를 누르세요.", zone: "점을 클릭해 수요 구역을 그리고 완료를 누르세요.",
  "walk-link": "시작할 출입구·접근점·역·구역을 클릭하고, 빈 곳을 클릭해 굽이를 더한 뒤, 끝낼 대상을 클릭하세요.", transfer: "빈 곳을 클릭해 통로의 굽이를 더하고, 대상 역(작은 점)을 클릭해 끝내세요.",
  move: "옮길 곳을 클릭하세요. 역을 고른 경우 그림 전체가 같은 만큼 옮겨집니다.", "vertex-move": "옮길 꼭짓점을 클릭하고, 새 위치를 클릭하세요.", "vertex-add": "선이나 경계 위의 점을 클릭해 꼭짓점을 더하세요.", "vertex-remove": "지울 꼭짓점을 클릭하세요.",
};
const STYLE_ID = "transitline-station-access-style";
const CSS = `
.tl-access-panel{position:fixed;right:12px;top:64px;z-index:7;width:360px;max-height:56vh;overflow:auto;padding:8px 10px;border:1px solid #2a2f3a;border-radius:8px;background:rgba(17,19,24,.94);color:#f1f2f5;font:12px/1.4 system-ui,'Malgun Gothic',sans-serif}
.tl-access-panel .section-label{margin:6px 0 3px;color:#ffe66d;font-weight:600}
.tl-access-panel .diag{margin:3px 0;padding:3px 6px;border-left:3px solid #4cc9f0;border-radius:3px;font-size:11px;overflow-wrap:anywhere}
.tl-access-panel .diag.warning{border-left-color:#ffb703}.tl-access-panel .diag.info{color:#aab1c0}
.tl-access-panel .row{display:flex;align-items:center;gap:6px;margin:2px 0;flex-wrap:wrap}.tl-access-panel .row.picked{background:rgba(255,255,255,.08)}
.tl-access-panel button{margin:2px 3px 2px 0;padding:2px 7px}.tl-access-panel button.on{outline:2px solid #f1f2f5}.tl-access-panel input{width:90px;margin-right:4px}
.tl-access-panel .access-fact{margin:2px 0;font-size:11px}.tl-access-panel .access-title{font-weight:600}
`;
const POINT_BUTTONS = { street: "거리", crossing: "횡단 지점", plaza: "광장", "bus-stop": "정류장", other: "접근점 기타" };
const ZONE_BUTTONS = { residential: "주거", employment: "업무", mixed: "혼합", school: "학교", visitor: "방문", other: "구역 기타" };
const POINT_TYPES = new Set(["entrance", "access-point"]);
const POLYGON_TYPES = new Set(["catchment", "demand-zone"]);
const LINE_TYPES = new Set(["walk-link", "transfer"]);
const POLYGON_MODES = new Set(["catchment", "catchment-entrance", "zone"]);
const hasKey = (v) => v !== undefined && v !== null && v !== "";
const isLonLat = (p) => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90;
const sameConnect = (a, b) => Boolean(a && b) && a.planId === b.planId && a.externalNetworkId === b.externalNetworkId && a.stationId === b.stationId;

export function mountStationDemandAccess({ canvas, projection, pack, getPlans, getExternalNetworks, getDemandNodes, getDemandSources, getSpatial, onChange = () => {}, enabled = true, autoRefreshMs = 250 }) {
  const shell = createShell({ canvas, projection, pack, styleId: STYLE_ID, css: CSS, panelClass: "tl-access-panel" });
  const { box, screen, lonLat, el, pointer, button, win } = shell;
  const packId = pack.manifest?.id ?? "pack";
  const notes = [];
  const store = createStore({ win, key: `${STATION_ACCESS_STORAGE_PREFIX}${packId}`, pack, restore: restoreStationDemandAccessDoc, serialize: serializeStationDemandAccessDoc, notes });
  let doc = store.doc;
  const save = () => store.save(doc, "station-demand-access-doc-not-saved");

  let enabledNow = enabled;
  let stationKey = null; // the drawing being worked on
  let sel = null; // { type, key } inside it
  let mode = null;
  let draft = [];
  let linkFrom = null;
  let movingVertex = null;
  let pointKind = "street";
  let zoneKind = "residential";
  let version = 0;
  let dirty = true;
  let panelVersion = -1;
  let drawVersion = -1;
  let outputVersion = -1;
  let lastRect = "";
  let lastFingerprint = null;
  let inputsNow = { plans: [], externals: [], nodes: [], sources: null, spatial: null };
  let built = { exportData: { sites: [], inactive: [], catchmentOverlaps: [], warnings: [] }, model: { sites: [], warnings: [], overlaps: [] } };

  const bump = () => { version += 1; };
  const touch = () => { dirty = true; };
  const note = (code, extra = {}) => { notes.push({ code, ...extra }); bump(); };
  const inputs = () => {
    const sources = getDemandSources?.();
    return {
      plans: arr(getPlans?.(), "plans"), externals: arr(getExternalNetworks?.(), "externalNetworks"),
      nodes: getDemandNodes ? arr(getDemandNodes(), "demandNodes") : demandNodesFromPack(pack),
      sources: sources === undefined || sources === null ? null : arr(sources, "sources"), spatial: getSpatial?.() ?? null,
    };
  };
  const fingerprint = (i) => JSON.stringify([
    i.plans.map((p) => [p.planId, (p.stationCandidates ?? []).map((s) => [s.id, s.name, s.location])]), i.externals.map((n) => [n.id, (n.stations ?? []).length, n.stations?.[0]?.id ?? null]),
    i.nodes.length, i.nodes[0]?.id ?? null, i.sources?.map((s) => [s.sourceId, s.quality]) ?? null,
  ]);
  const allStations = () => [
    ...inputsNow.plans.flatMap((p) => (p.stationCandidates ?? []).map((s) => ({ id: s.id, name: s.name ?? null, location: s.location, connect: { planId: p.planId, stationId: s.id } }))),
    ...inputsNow.externals.flatMap((n) => (n.stations ?? []).map((s) => ({ id: s.id, name: s.name ?? null, location: s.location, connect: { externalNetworkId: n.id, stationId: s.id } }))),
  ];
  const stationOf = (key = stationKey) => doc.stations.find((s) => s.key === key && !s.deleted) ?? null;
  const siteOut = (key = stationKey) => built.exportData.sites.find((s) => s.stationAccessId === stationAccessIdOf(packId, key)) ?? null;
  const viewSite = (key = stationKey) => built.model.sites.find((s) => s.stationAccessId === stationAccessIdOf(packId, key)) ?? null;
  const needStation = () => { const s = stationOf(); if (!s) throw new Error("No station is selected"); return s; };
  const selectionForView = () => (stationKey ? { stationAccessId: stationAccessIdOf(packId, stationKey), type: sel?.type ?? "station", key: sel?.key ?? null } : null);
  const listOf = (s, type) => ({ entrance: s.entrances, "access-point": s.accessPoints, "walk-link": s.walkLinks, catchment: s.catchments, "demand-zone": s.demandZones })[type];
  const elementOf = (s, type, key) => (type === "transfer" ? s.transfers.find((t) => t.targetStationId === key) : listOf(s, type)?.find((x) => x.key === key)) ?? null;
  const targetsOf = (s) => allStations().filter((t) => t.id !== s?.connect?.stationId && !(s?.connect?.planId && t.connect.planId === s.connect.planId));

  function recompute(i) {
    inputsNow = i;
    const exportData = buildStationDemandAccessExport({
      pack, mapExport: { plans: i.plans, externalNetworks: i.externals, demandNodes: i.nodes }, stations: doc.stations.map(toDrawnStation), spatial: i.spatial ?? makeSpatialContext(), demandSources: i.sources,
    });
    built = { exportData, model: buildStationAccessView({ exportData, selection: selectionForView() }) };
    bump();
  }
  const outputNow = () => ({
    document: clone(doc), export: built.exportData, sites: built.exportData.sites, selected: siteOut(), selectedStationKey: stationKey, selection: sel ? { ...sel } : null,
    warnings: [...notes, ...built.exportData.warnings, ...built.exportData.sites.flatMap((s) => s.warnings.map((w) => ({ ...w, stationAccessId: s.stationAccessId })))],
  });
  function emit() {
    if (outputVersion === version) return;
    outputVersion = version;
    const out = outputNow();
    onChange(out);
    canvas.dispatchEvent(new CustomEvent(STATION_ACCESS_UI_EVENT, { detail: out }));
  }
  function edit(fn) {
    try { fn(); save(); touch(); refresh(); return true; } catch (error) { note("station-demand-access-edit-refused", { message: error.message }); touch(); refresh(); return false; }
  }
  const endOk = (s, e) => e?.kind === "station" || (hasKey(e?.key) && Boolean(({ entrance: s.entrances, "access-point": s.accessPoints, "demand-zone": s.demandZones })[e.kind]?.some((x) => x.key === e.key)));
  const sameEnd = (a, b) => a.kind === b.kind && (a.key ?? null) === (b.key ?? null);
  const points = (list, min = 0) => { if (!Array.isArray(list) || list.length < min || !list.every(isLonLat)) throw new Error(min ? `At least ${min} valid points are needed` : "Waypoints must be [lon, lat] pairs"); return clone(list); };

  // --- stations ---
  function startStation(target = {}) {
    const connect = target.planId ? { planId: target.planId, stationId: target.stationId } : target.externalNetworkId ? { externalNetworkId: target.externalNetworkId, stationId: target.stationId } : null;
    const known = connect ? allStations().find((t) => sameConnect(t.connect, connect)) : null;
    if (connect && !known) { note("station-demand-access-target-missing", { target: connect }); refresh(); return false; }
    if (!connect && !isLonLat(target.location)) { note("station-demand-access-target-missing", { target: null }); refresh(); return false; }
    const same = connect ? doc.stations.find((s) => sameConnect(s.connect, connect)) : null;
    if (same) return edit(() => { if (same.deleted) restoreStation(doc, same.key); stationKey = same.key; sel = null; });
    return edit(() => { const s = addStation(doc, { name: target.name ?? known?.name ?? null, connect, location: connect ? null : clone(target.location) }); stationKey = s.key; sel = null; mode = null; });
  }
  const selectStation = (key) => { const ok = Boolean(stationOf(key)); stationKey = ok ? key : null; sel = null; mode = null; draft = []; linkFrom = null; bump(); touch(); refresh(); return ok; };
  const deselect = () => { stationKey = null; sel = null; mode = null; draft = []; linkFrom = null; bump(); touch(); refresh(); };
  function selectElement(type, key) {
    const s = stationOf();
    const ok = type === "station" ? Boolean(s) : Boolean(s && elementOf(s, type, key));
    sel = ok ? { type, key: type === "station" ? null : key } : null;
    mode = null; draft = []; linkFrom = null; movingVertex = null; bump(); touch(); refresh();
    return ok;
  }
  const dropStation = (key = stationKey) => edit(() => { if (!stationOf(key)) throw new Error(`Unknown station ${key}`); removeStation(doc, key); if (key === stationKey) { stationKey = null; sel = null; mode = null; } });
  const bringBack = (key) => edit(() => { restoreStation(doc, key); });

  // --- elements ---
  const addAt = (type, add, make) => edit(() => { const s = needStation(); const e = add(doc, s.key, make(s)); sel = { type, key: e.key }; });
  const putEntrance = (location, { name = null } = {}) => addAt("entrance", addEntrance, () => ({ name, location: points([location])[0] }));
  const putAccessPoint = (location, { kind = pointKind, name = null } = {}) => addAt("access-point", addAccessPoint, () => {
    if (kind !== null && !ACCESS_POINT_KINDS.includes(kind)) throw new Error(`Unknown access point kind ${kind}`);
    return { name, kind, location: points([location])[0] };
  });
  const putCatchment = (polygon, { entranceKey = null, name = null } = {}) => addAt("catchment", addCatchment, (s) => {
    if (entranceKey !== null && !s.entrances.some((e) => e.key === entranceKey)) throw new Error(`Unknown entrance ${entranceKey}`);
    return { name, polygon: points(polygon, 3), ...(entranceKey === null ? {} : { entranceKey }) };
  });
  const putZone = (polygon, { kind = zoneKind, name = null } = {}) => addAt("demand-zone", addDemandZone, () => {
    if (kind !== null && !DEMAND_ZONE_KINDS.includes(kind)) throw new Error(`Unknown zone kind ${kind}`);
    return { name, kind, polygon: points(polygon, 3) };
  });
  const putWalkLink = ({ from, to, via = [], widthMeters = null, name = null }) => addAt("walk-link", addWalkLink, (s) => {
    if (!endOk(s, from) || !endOk(s, to)) throw new Error("A walking link must start and end on the station, an entrance, an access point or a zone of this station");
    if (sameEnd(from, to)) throw new Error("A walking link needs two different ends");
    return { name, from: clone(from), to: clone(to), via: points(via), widthMeters };
  });
  const putTransfer = (targetStationId, via = [], { fromEntranceKey = null, widthMeters = null } = {}) => edit(() => {
    const s = needStation();
    if (!targetsOf(s).some((t) => t.id === targetStationId)) throw new Error(`${targetStationId} is not a station this one can have a transfer passage to`);
    if (fromEntranceKey !== null && !s.entrances.some((e) => e.key === fromEntranceKey)) throw new Error(`Unknown entrance ${fromEntranceKey}`);
    setTransfer(doc, s.key, targetStationId, points(via), { fromEntranceKey, widthMeters });
    sel = { type: "transfer", key: targetStationId };
  });
  const moveTo = (type, key, location) => edit(() => { if (!POINT_TYPES.has(type)) throw new Error(`${type} is not a point`); moveElement(doc, needStation().key, type, key, points([location])[0]); });
  const moveDrawing = (location) => edit(() => {
    const s = needStation();
    const at = siteOut(s.key)?.location ?? s.location;
    if (!at) throw new Error("This station has no place to move from");
    const [lon, lat] = points([location])[0];
    moveStation(doc, s.key, lon - at[0], lat - at[1]);
  });
  // the player's own points of a polygon, or the waypoints of a line: what the vertex tools work on
  const vertices = (s = stationOf(), type = sel?.type, key = sel?.key) => {
    const e = s && type ? elementOf(s, type, key) : null;
    return e ? (POLYGON_TYPES.has(type) ? e.polygon : e.via ?? []) : null;
  };
  const setVia = (s, type, key, via) => {
    if (type === "walk-link") setWalkLinkVia(doc, s.key, key, via);
    else { const t = elementOf(s, "transfer", key); setTransfer(doc, s.key, key, via, { fromEntranceKey: t.fromEntranceKey ?? null, widthMeters: t.widthMeters ?? null }); }
  };
  const vertexOp = (type, key, fn) => edit(() => {
    const s = needStation();
    if (!POLYGON_TYPES.has(type) && !LINE_TYPES.has(type)) throw new Error(`${type} has no vertices`);
    if (!elementOf(s, type, key)) throw new Error(`Unknown ${type} ${key}`);
    fn(s, vertices(s, type, key));
  });
  const moveVertexTo = (type, key, index, location) => vertexOp(type, key, (s, list) => {
    const at = points([location])[0];
    if (POLYGON_TYPES.has(type)) moveVertex(doc, s.key, type, key, index, at);
    else { if (!(index >= 0 && index < list.length)) throw new Error(`No waypoint ${index}`); setVia(s, type, key, list.map((p, i) => (i === index ? at : p))); }
  });
  const addVertexAt = (type, key, index, location) => vertexOp(type, key, (s, list) => {
    const at = points([location])[0];
    if (POLYGON_TYPES.has(type)) insertVertex(doc, s.key, type, key, index, at);
    else { if (!(index >= 0 && index <= list.length)) throw new Error(`No waypoint position ${index}`); setVia(s, type, key, [...list.slice(0, index), at, ...list.slice(index)]); }
  });
  const dropVertex = (type, key, index) => vertexOp(type, key, (s, list) => {
    if (POLYGON_TYPES.has(type)) removeVertex(doc, s.key, type, key, index);
    else { if (!(index >= 0 && index < list.length)) throw new Error(`No waypoint ${index}`); setVia(s, type, key, list.filter((_, i) => i !== index)); }
  });
  // name, kind (access point, zone), width (link, passage), the entrance a boundary is drawn for
  const CHANGEABLE = { station: ["name"], entrance: ["name"], "access-point": ["name", "kind"], "walk-link": ["name", "widthMeters"], transfer: ["widthMeters"], catchment: ["name", "entranceKey"], "demand-zone": ["name", "kind"] };
  const change = (type, key, patch) => edit(() => {
    const s = needStation();
    const e = type === "station" ? s : elementOf(s, type, key);
    if (!e) throw new Error(`Unknown ${type} ${key}`);
    const bad = Object.keys(patch).find((f) => !(CHANGEABLE[type] ?? []).includes(f));
    if (bad) throw new Error(`${bad} cannot be changed on a ${type}`);
    if ("kind" in patch && patch.kind !== null && !(type === "access-point" ? ACCESS_POINT_KINDS : DEMAND_ZONE_KINDS).includes(patch.kind)) throw new Error(`Unknown kind ${patch.kind}`);
    if ("widthMeters" in patch && patch.widthMeters !== null && !(Number.isFinite(patch.widthMeters) && patch.widthMeters > 0)) throw new Error("A width is a positive number of metres");
    if ("entranceKey" in patch && patch.entranceKey !== null && !s.entrances.some((x) => x.key === patch.entranceKey)) throw new Error(`Unknown entrance ${patch.entranceKey}`);
    if (type === "station") updateStation(doc, s.key, patch);
    else if (type === "transfer") setTransfer(doc, s.key, key, e.via ?? [], { fromEntranceKey: e.fromEntranceKey ?? null, widthMeters: patch.widthMeters });
    else updateElement(doc, s.key, type, key, patch);
  });
  const dropElement = (type, key) => edit(() => {
    const s = needStation();
    if (!elementOf(s, type, key)) throw new Error(`Unknown ${type} ${key}`);
    const left = type === "transfer" ? [] : referencesTo(doc, s.key, type, key);
    if (type === "transfer") clearTransfer(doc, s.key, key); else removeElement(doc, s.key, type, key);
    if (sel?.type === type && sel.key === key) sel = null;
    if (left.length) notes.push({ code: "station-demand-access-references-left", type, key, references: left });
  });

  // --- modes and map clicks ---
  const lineOrPolygon = (t) => POLYGON_TYPES.has(t) || LINE_TYPES.has(t);
  const needsSel = { move: (t) => t === "station" || POINT_TYPES.has(t), "vertex-move": lineOrPolygon, "vertex-add": lineOrPolygon, "vertex-remove": lineOrPolygon, "catchment-entrance": (t) => t === "entrance" };
  function setMode(m, options = {}) {
    if (m !== null && !MODES.includes(m)) { note("station-demand-access-unknown-mode", { mode: m }); refresh(); return false; }
    if (m && m !== "pick-station" && m !== "place-station" && !stationOf()) { note("station-demand-access-no-station-selected"); refresh(); return false; }
    if (m && needsSel[m] && !needsSel[m](sel?.type)) { note("station-demand-access-nothing-selected-for-mode", { mode: m }); refresh(); return false; }
    if (ACCESS_POINT_KINDS.includes(options.pointKind)) pointKind = options.pointKind;
    if (DEMAND_ZONE_KINDS.includes(options.zoneKind)) zoneKind = options.zoneKind;
    mode = m; draft = []; linkFrom = null; movingVertex = null; bump(); refresh();
    return true;
  }
  function finishDraft() {
    if (!POLYGON_MODES.has(mode)) return false;
    if (draft.length < 3) { note("station-demand-access-polygon-needs-three-points"); refresh(); return false; }
    const pts = draft;
    const m = mode;
    const entranceKey = m === "catchment-entrance" ? sel.key : null;
    mode = null; draft = []; bump();
    return m === "zone" ? putZone(pts) : putCatchment(pts, { entranceKey });
  }
  function onMapClick(p) {
    const at = lonLat(p[0], p[1]);
    const vs = viewSite();
    if (mode === "pick-station") {
      const hit = stationAt(allStations(), screen, p);
      if (hit) { mode = null; bump(); startStation(hit.connect); }
    } else if (mode === "place-station") { mode = null; bump(); startStation({ location: at }); }
    else if (mode === "entrance") putEntrance(at);
    else if (mode === "access-point") putAccessPoint(at);
    else if (POLYGON_MODES.has(mode)) { draft.push(at); bump(); refresh(); }
    else if (mode === "walk-link" && vs) {
      const end = endpointAt(vs, screen, p);
      if (!linkFrom) { if (end) { linkFrom = end; bump(); refresh(); } return; }
      if (end && !sameEnd(end, linkFrom)) { const from = linkFrom; const via = draft; mode = null; linkFrom = null; draft = []; bump(); putWalkLink({ from, to: end, via }); }
      else if (!end) { draft.push(at); bump(); refresh(); }
    } else if (mode === "transfer") {
      const target = stationAt(targetsOf(stationOf()), screen, p);
      if (!target) { draft.push(at); bump(); refresh(); return; }
      const via = draft;
      mode = null; draft = []; bump();
      putTransfer(target.id, via, { fromEntranceKey: sel?.type === "entrance" ? sel.key : null });
    } else if (mode === "move") {
      const m = sel;
      mode = null; bump();
      if (m?.type === "station") moveDrawing(at); else if (m) moveTo(m.type, m.key, at);
    } else if (mode?.startsWith("vertex-")) vertexClick(p, at);
  }
  function vertexClick(p, at) {
    const list = vertices();
    if (!list || !sel) return;
    if (mode === "vertex-move") {
      const i = vertexAt(list, screen, p);
      if (movingVertex === null) { if (i >= 0) { movingVertex = i; bump(); refresh(); } return; }
      const index = movingVertex;
      movingVertex = null;
      moveVertexTo(sel.type, sel.key, index, at);
    } else if (mode === "vertex-remove") { const i = vertexAt(list, screen, p); if (i >= 0) dropVertex(sel.type, sel.key, i); }
    else {
      // a polygon is edited in its own points; a line's new waypoint goes between the two ends it falls between
      const poly = POLYGON_TYPES.has(sel.type);
      const full = poly ? list : viewSite()?.[sel.type === "walk-link" ? "walkLinks" : "transfers"].find((x) => x.key === sel.key)?.alignment ?? [];
      const k = edgeAt(full, screen, p, poly);
      if (k >= 0) addVertexAt(sel.type, sel.key, poly ? k : k - 1, at);
    }
  }
  // with no mode a click selects what is under it — and is taken from the map only when it hit something
  function selectAt(p, ev) {
    const order = [...built.model.sites].sort((a, b) => Number(b.selected) - Number(a.selected));
    for (const site of order) {
      const hit = hitSite(site, screen, p);
      if (!hit) continue;
      ev.stopImmediatePropagation?.();
      const key = doc.stations.find((s) => stationAccessIdOf(packId, s.key) === site.stationAccessId)?.key;
      if (key !== stationKey) { stationKey = key; bump(); touch(); }
      selectElement(hit.type, hit.key);
      return;
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
    if (mode === "pick-station") drawStationDots(ctx, allStations(), screen);
    if (mode === "transfer" && stationOf()) drawStationDots(ctx, targetsOf(stationOf()), screen, "#c084fc");
    drawStationAccessOverlay(ctx, built.model, screen);
    ctx.save();
    if (draft.length) {
      ctx.strokeStyle = "#fb923c";
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 5]);
      ctx.beginPath();
      draft.map(screen).forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.stroke();
    }
    if (mode?.startsWith("vertex-")) {
      ctx.fillStyle = "#fb923c";
      (vertices() ?? []).forEach((pt, i) => { const [x, y] = screen(pt); ctx.beginPath(); ctx.arc(x, y, i === movingVertex ? 7 : 5, 0, Math.PI * 2); ctx.fill(); });
    }
    ctx.restore();
  }

  // --- the panel ---
  const modeButton = (parent, label, m, options) => { const b = button(parent, label, () => setMode(mode === m ? null : m, options)); if (mode === m) b.className = "on"; return b; };
  function renderPanel() {
    box.replaceChildren();
    box.hidden = !enabledNow;
    if (!enabledNow) return;
    box.append(el("div", "section-label", "역 접근권 (지도 편집)"));
    box.append(el("div", "diag info", SCOPE_NOTICE));
    const bar = el("div");
    modeButton(bar, "지도에서 역 고르기", "pick-station");
    modeButton(bar, "새 역 위치 지정", "place-station");
    box.append(bar);
    const station = stationOf();
    if (station) {
      renderTools(station);
      const body = el("div");
      box.append(body);
      renderStationAccessPanel(body, { ...built.model, sites: built.model.sites.filter((s) => s.selected), overlaps: [] }, selectionForView());
    }
    const active = doc.stations.filter((s) => !s.deleted);
    const off = doc.stations.filter((s) => s.deleted);
    box.append(el("div", "section-label", `그린 역 ${active.length}곳`));
    if (!active.length) box.append(el("div", "diag info", "아직 접근을 그린 역이 없습니다."));
    for (const s of active) {
      const out = siteOut(s.key);
      const row = el("div", `row${s.key === stationKey ? " picked" : ""}`);
      row.append(el("span", "", `${s.name ?? s.key} · ${out ? STATION_KIND_LABELS[out.stationKind] : "위치를 만들지 못함"}`));
      button(row, "선택", () => selectStation(s.key));
      button(row, "끄기", () => dropStation(s.key));
      box.append(row);
    }
    const unplaced = inputsNow.plans.flatMap((p) => (p.stationCandidates ?? []).map((st) => ({ p, st }))).filter(({ p, st }) => !doc.stations.some((s) => !s.deleted && s.connect?.planId === p.planId && s.connect.stationId === st.id));
    if (unplaced.length) box.append(el("div", "section-label", `계획 역 ${unplaced.length}곳 (그림 없음)`));
    for (const { p, st } of unplaced.slice(0, 6)) { const row = el("div", "row"); row.append(el("span", "", `${p.name ?? p.planId} · ${st.name ?? st.id}`)); button(row, "접근 그리기 시작", () => startStation({ planId: p.planId, stationId: st.id })); box.append(row); }
    if (off.length) { box.append(el("div", "section-label", "꺼진 역")); for (const s of off) { const row = el("div", "row"); row.append(el("span", "", s.name ?? s.key)); button(row, "되살리기", () => bringBack(s.key)); box.append(row); } }
    const legend = el("div");
    box.append(legend);
    renderStationAccessLegend(legend);
    for (const w of [...notes, ...built.exportData.warnings]) box.append(el("div", "diag warning", `⚠ ${w.code}${w.message ? ` (${w.message})` : ""}`));
  }
  function renderTools(station) {
    box.append(el("div", "section-label", `선택한 역: ${station.name ?? station.key}`));
    if (mode) {
      box.append(el("div", "diag info", HINTS[mode]));
      const bar = el("div");
      if (POLYGON_MODES.has(mode)) button(bar, "완료", finishDraft);
      button(bar, "취소", () => setMode(null));
      box.append(bar);
    }
    const bar = el("div");
    modeButton(bar, "출입구 추가", "entrance");
    modeButton(bar, "접근점 추가", "access-point");
    modeButton(bar, "보행 연결 그리기", "walk-link");
    modeButton(bar, "환승 통로 그리기", "transfer");
    modeButton(bar, "접근권 경계 그리기", "catchment");
    if (sel?.type === "entrance") modeButton(bar, "출입구 기준 경계", "catchment-entrance");
    modeButton(bar, "수요 구역 그리기", "zone");
    box.append(bar);
    const kinds = el("div", "row");
    for (const [kind, label] of Object.entries(POINT_BUTTONS)) { const b = button(kinds, label, () => { pointKind = kind; if (sel?.type === "access-point") change("access-point", sel.key, { kind }); else { bump(); refresh(); } }); if (pointKind === kind) b.className = "on"; }
    box.append(kinds);
    const zones = el("div", "row");
    for (const [kind, label] of Object.entries(ZONE_BUTTONS)) { const b = button(zones, label, () => { zoneKind = kind; if (sel?.type === "demand-zone") change("demand-zone", sel.key, { kind }); else { bump(); refresh(); } }); if (zoneKind === kind) b.className = "on"; }
    box.append(zones);
    if (sel) renderSelection(station);
    const end = el("div");
    modeButton(end, "역 그림 이동", "move");
    button(end, "역 선택 해제", deselect);
    box.append(end);
  }
  function renderSelection(station) {
    const { type, key } = sel;
    const e = type === "station" ? station : elementOf(station, type, key);
    if (!e) return;
    box.append(el("div", "section-label", `선택: ${ELEMENT_LABELS[type]}${e.name ? ` · ${e.name}` : ""}`));
    const row = el("div", "row");
    if (type !== "transfer") {
      const input = el("input");
      input.type = "text";
      input.value = e.name ?? "";
      row.append(input);
      button(row, "이름 적용", () => change(type, key, { name: input.value.trim() === "" ? null : input.value.trim() }));
    }
    if (type === "walk-link" || type === "transfer") {
      const width = el("input");
      width.type = "number";
      width.value = e.widthMeters ?? "";
      row.append(width);
      button(row, "폭 적용", () => change(type, key, { widthMeters: width.value === "" ? null : Number(width.value) }));
      button(row, "폭 지움", () => change(type, key, { widthMeters: null }));
    }
    if (type === "catchment" && e.entranceKey) button(row, "역 전체 경계로 바꾸기", () => change("catchment", key, { entranceKey: null }));
    box.append(row);
    const tools = el("div", "row");
    if (type === "station" || POINT_TYPES.has(type)) modeButton(tools, "이동", "move");
    if (lineOrPolygon(type)) { modeButton(tools, "꼭짓점 이동", "vertex-move"); modeButton(tools, "꼭짓점 추가", "vertex-add"); modeButton(tools, "꼭짓점 지움", "vertex-remove"); }
    if (type !== "station") {
      const refs = type === "transfer" ? [] : referencesTo(doc, station.key, type, key);
      button(tools, "삭제", () => dropElement(type, key));
      if (refs.length) tools.append(el("span", "diag warning", `이 요소를 가리키는 연결 ${refs.length}개는 경고로 남습니다`));
    }
    box.append(tools);
  }

  function refresh() {
    const i = inputs();
    const fp = fingerprint(i);
    if (dirty || fp !== lastFingerprint || i.spatial !== inputsNow.spatial) { lastFingerprint = fp; dirty = false; recompute(i); }
    drawLayer();
    if (panelVersion !== version) { panelVersion = version; renderPanel(); }
    emit();
  }

  const onPointerDown = (ev) => {
    if (!enabledNow) return;
    if (mode) { ev.stopImmediatePropagation?.(); onMapClick(pointer(ev)); return; }
    selectAt(pointer(ev), ev);
  };
  const onDblClick = () => { if (enabledNow && POLYGON_MODES.has(mode)) finishDraft(); };
  const onKey = (ev) => {
    if (!enabledNow || shell.typing()) return;
    if (ev.key === "Enter") finishDraft();
    else if (ev.key === "Escape") { if (mode) setMode(null); else if (sel) { sel = null; bump(); touch(); refresh(); } else if (stationKey) deselect(); }
    else if ((ev.key === "Delete" || ev.key === "Backspace") && sel && sel.type !== "station" && !mode) dropElement(sel.type, sel.key);
  };
  const detach = shell.attach({ onPointerDown, onDblClick, onKey, refresh, autoRefreshMs });
  refresh();

  return {
    output: outputNow, startStation, selectStation, selectElement, deselect, removeStation: dropStation, restoreStation: bringBack,
    addEntrance: putEntrance, addAccessPoint: putAccessPoint, addCatchment: putCatchment, addDemandZone: putZone, addWalkLink: putWalkLink, setTransfer: putTransfer,
    moveElement: moveTo, moveDrawing, moveVertex: moveVertexTo, insertVertex: addVertexAt, removeVertex: dropVertex, update: change, removeElement: dropElement,
    setMode, finishDraft, addDraftPoint(location) { if (isLonLat(location) && mode) { draft.push(clone(location)); bump(); refresh(); } },
    save() { return save(); }, serialize: () => serializeStationDemandAccessDoc(doc),
    // Replaces the whole document (the host's own save). A refused document (other pack, unreadable, other version) leaves the current drawings untouched.
    loadDoc(source) {
      if (source === null || source === undefined) return [];
      const before = notes.length;
      const incoming = restoreStationDemandAccessDoc(typeof source === "string" ? source : JSON.stringify(source), pack);
      const refused = incoming.warnings.some((w) => ["station-demand-access-doc-other-pack", "station-demand-access-doc-unreadable", "station-demand-access-doc-version"].includes(w.code));
      notes.push(...incoming.warnings);
      if (!refused) { doc = incoming.doc; stationKey = null; sel = null; mode = null; draft = []; linkFrom = null; save(); touch(); }
      bump();
      refresh();
      return notes.slice(before);
    },
    refresh, setEnabled(value) { enabledNow = Boolean(value); bump(); refresh(); },
    get selectedStationKey() { return stationKey; }, get selection() { return sel ? { ...sel } : null; }, get mode() { return mode; }, get document() { return clone(doc); }, get storageKey() { return store.key; },
    destroy: detach,
  };
}
