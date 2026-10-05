import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { demandSourceRefsOf, stationAccessIdOf } from "../src/map/station-demand-access.mjs";
import { STATION_ACCESS_STORAGE_PREFIX, STATION_ACCESS_UI_EVENT, SCOPE_NOTICE, mountStationDemandAccess } from "../src/map/station-demand-access-ui.mjs";
import { BANNED_TEXT, browser, clickAt, deepFreeze, find, hasText, layerOf, panelOf, press, projection, texts } from "./helpers/fake-browser.mjs";
import { makeWorld, pack } from "./helpers/map-world.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const PANEL = "tl-access-panel";
const world = makeWorld("none");
const A1 = world.A.stationCandidates[1];
const S = A1.location; // screen (200, 190) in the fake projection: 20 000 px per degree
const at = (dx, dy) => [S[0] + dx / 20000, S[1] - dy / 20000]; // a place `dx` px right and `dy` px down (negative: up, north) of the station on the screen
const sources = demandSourceRefsOf([{ file: "demand.json", kind: "demand-points", document: { formatVersion: 1 }, spatialResolution: "synthetic-node", quality: "low" }], "t");
const rectAt = (x0, y0, x1, y1) => [at(x0, y0), at(x1, y0), at(x1, y1), at(x0, y1)];

function mount({ storage, blocked, packOverride, live: over = {}, options = {} } = {}) {
  const env = browser({ storage, blocked });
  const live = { plans: world.plans, externals: world.map.externalNetworks, ...over };
  const changes = [];
  const fired = [];
  env.canvas.addEventListener(STATION_ACCESS_UI_EVENT, (e) => fired.push(e));
  const bridge = mountStationDemandAccess({
    canvas: env.canvas, projection, pack: packOverride ?? pack, getPlans: () => live.plans, getExternalNetworks: () => live.externals, getDemandSources: () => sources, getSpatial: () => live.spatial,
    onChange: (o) => changes.push(o), autoRefreshMs: 0, ...options,
  });
  return { env, live, bridge, changes, fired };
}
const planStation = { planId: world.A.planId, stationId: A1.id };
const started = (opts) => { const m = mount(opts); assert.equal(m.bridge.startStation(planStation), true); return m; };
const out = (m) => m.bridge.output();
const site = (m) => out(m).selected;
const keyDown = (env, key) => env.win.fire("keydown", { key });
const modeClick = (m, mode, ...pts) => { assert.equal(m.bridge.setMode(mode), true); for (const p of pts) clickAt(m.env, p); };
const codes = (m) => out(m).warnings.map((w) => w.code);
const panelTexts = (m) => texts(panelOf(m.env, PANEL));
const arcs = (m) => (layerOf(m.env).calls ?? []).filter((c) => c[0] === "arc");

// a drawn station: an entrance, an access point, a zone to the north-east, a boundary around everything
function drawn() {
  const m = started();
  m.bridge.addEntrance(at(40, -20), { name: "North gate" });
  m.bridge.addAccessPoint(at(40, -80), { kind: "crossing" });
  m.bridge.addDemandZone(rectAt(80, -160, 160, -100), { kind: "residential", name: "Homes" });
  m.bridge.addCatchment(rectAt(-150, -120, 200, 200), { name: "Boundary" });
  return m;
}

// --- mount ---
test("mounting makes its own overlay, panel and style, states the scope and uses no verdict, price, time or size words", () => {
  const { env, bridge, changes } = mount();
  assert.ok(env.doc.head.children.some((c) => c.tag === "style"));
  assert.ok(panelOf(env, PANEL) && layerOf(env));
  assert.deepEqual([bridge.output().document.stations, bridge.output().sites, bridge.output().selected], [[], [], null]);
  assert.ok(hasText(env, PANEL, SCOPE_NOTICE));
  assert.ok(changes.length >= 1);
  assert.equal(bridge.storageKey, `${STATION_ACCESS_STORAGE_PREFIX}t`);
  // every plan station without a drawing is offered
  assert.equal(find(panelOf(env, PANEL), (n) => n.tag === "button" && n.textContent === "접근 그리기 시작").length, 6);
  const m = drawn();
  m.bridge.selectElement("entrance", "entrance-1");
  m.bridge.setMode("walk-link");
  for (const t of panelTexts(m)) assert.doesNotMatch(t, BANNED_TEXT, t);
  m.bridge.selectElement("demand-zone", "demand-zone-1");
  for (const t of panelTexts(m)) assert.doesNotMatch(t, BANNED_TEXT, t);
});

test("no plans, odd getter shapes and no getters at all are messages, never exceptions", () => {
  const none = mount({ live: { plans: [], externals: [] } });
  assert.ok(hasText(none.env, PANEL, "아직 접근을 그린 역이 없습니다"));
  const odd = mount({ live: { plans: null, externals: undefined } });
  assert.deepEqual(odd.bridge.output().sites, []);
  assert.equal(odd.bridge.startStation(planStation), false);
  assert.ok(odd.bridge.output().warnings.some((w) => w.code === "station-demand-access-target-missing"));
  const env = browser();
  const bare = mountStationDemandAccess({ canvas: env.canvas, projection, pack, autoRefreshMs: 0 });
  assert.deepEqual(bare.output().sites, []);
  assert.equal(bare.startStation({ location: at(0, 0) }), true, "a new station needs no getter");
  assert.equal(bare.output().selected.stationKind, "free");
});

// --- stations ---
test("starting a plan station builds the M1 site on its place; starting it again selects the same drawing", () => {
  const m = mount();
  press(m.env, PANEL, "접근 그리기 시작");
  assert.equal(out(m).selectedStationKey, "access-1");
  assert.equal(site(m).schema, "transitline.station-demand-access-geometry/1");
  assert.equal(site(m).stationKind, "plan");
  assert.equal(site(m).stationAccessId, stationAccessIdOf("t", "access-1"));
  assert.ok(hasText(m.env, PANEL, "선택한 역"));
  m.bridge.deselect();
  const pressed = m.bridge.document.stations[0].connect;
  const other = world.plans.flatMap((p) => p.stationCandidates.map((s) => ({ planId: p.planId, stationId: s.id }))).find((c) => c.stationId !== pressed.stationId);
  assert.equal(m.bridge.startStation(other), true);
  assert.equal(m.bridge.startStation(other), true);
  assert.equal(m.bridge.document.stations.length, 2, "the same plan station never gets two drawings");
});

test("an existing station and a free place can be drawn for too, by clicking the map", () => {
  const m = mount();
  assert.equal(m.bridge.setMode("pick-station"), true);
  assert.ok(arcs(m).length >= 6, "stations are drawn as dots to pick from");
  clickAt(m.env, [139.01, 35]); // d1, an existing station
  assert.equal(site(m).stationKind, "external");
  assert.equal(site(m).connectedStationId, "d1");
  assert.equal(m.bridge.mode, null);
  m.bridge.deselect();
  modeClick(m, "place-station", at(300, 300));
  assert.equal(site(m).stationKind, "free");
  assert.equal(site(m).locationBasis, "player");
  clickAt(m.env, [139.5, 36]); // not in a mode: nothing happens
  assert.equal(m.bridge.document.stations.length, 2);
});

test("a station is switched off and brought back with the same id and drawing; a dead target is a note", () => {
  const m = drawn();
  const before = JSON.stringify(site(m));
  assert.equal(m.bridge.removeStation(), true);
  assert.deepEqual(out(m).sites, []);
  assert.equal(m.bridge.selectedStationKey, null);
  assert.ok(hasText(m.env, PANEL, "꺼진 역"));
  press(m.env, PANEL, "되살리기");
  assert.equal(m.bridge.selectStation("access-1"), true);
  assert.equal(JSON.stringify(site(m)), before);
  assert.equal(m.bridge.selectStation("access-9"), false);
  assert.equal(m.bridge.removeStation("access-9"), false);
  assert.ok(codes(m).includes("station-demand-access-edit-refused"));
});

// --- drawing ---
test("entrances and access points are placed by clicking; kinds come from the buttons; Esc ends the mode", () => {
  const m = started();
  modeClick(m, "entrance", at(40, -20), at(-40, 20));
  assert.equal(site(m).entrances.length, 2);
  assert.deepEqual(m.bridge.selection, { type: "entrance", key: "entrance-2" });
  keyDown(m.env, "Escape");
  assert.equal(m.bridge.mode, null);
  press(m.env, PANEL, "광장");
  modeClick(m, "access-point", at(60, -60));
  assert.equal(site(m).accessPoints[0].kind, "plaza");
  press(m.env, PANEL, "정류장"); // with an access point selected, the button changes it
  assert.equal(site(m).accessPoints[0].kind, "bus-stop");
  assert.equal(m.bridge.addAccessPoint(at(0, 60), { kind: "teleporter" }), false);
  assert.ok(codes(m).includes("station-demand-access-edit-refused"));
  assert.equal(m.bridge.addEntrance(["x", 1]), false);
  assert.equal(site(m).entrances.length, 2);
});

test("a boundary and a zone are drawn point by point and finished with the button, Enter or a double click; two points are not enough", () => {
  const m = started();
  const ring = rectAt(-100, -100, 100, 100);
  modeClick(m, "catchment", ring[0], ring[1]);
  assert.equal(m.bridge.finishDraft(), false);
  assert.ok(codes(m).includes("station-demand-access-polygon-needs-three-points"));
  clickAt(m.env, ring[2]);
  press(m.env, PANEL, "완료");
  assert.equal(site(m).catchments.length, 1);
  assert.equal(site(m).catchments[0].polygonBasis, "player");
  assert.equal(site(m).catchments[0].containsStation, true);
  m.bridge.setMode("zone");
  rectAt(80, 80, 140, 140).slice(0, 3).forEach((p) => clickAt(m.env, p));
  keyDown(m.env, "Enter");
  assert.equal(site(m).demandZones[0].kind, "residential");
  press(m.env, PANEL, "혼합");
  m.bridge.setMode("zone");
  rectAt(-140, 80, -80, 140).slice(0, 3).forEach((p) => clickAt(m.env, p));
  m.env.canvas.dispatchEvent({ type: "dblclick" });
  assert.equal(site(m).demandZones.length, 2);
  assert.equal(m.bridge.addDemandZone(rectAt(0, 0, 10, 10).slice(0, 2)), false);
  assert.equal(m.bridge.addDemandZone(rectAt(0, 0, 10, 10), { kind: null }), true);
  assert.equal(site(m).demandZones.find((z) => z.kind === null).unknownReasons.kind, "not-provided", "an unstated kind stays unknown");
});

test("a boundary can be drawn for one entrance, and turned back into a whole-station boundary", () => {
  const m = started();
  m.bridge.addEntrance(at(30, -10));
  assert.equal(m.bridge.setMode("catchment-entrance"), true, "an entrance is selected after adding it");
  rectAt(-60, -60, 100, 60).slice(0, 3).forEach((p) => clickAt(m.env, p));
  m.bridge.finishDraft();
  const c = site(m).catchments[0];
  assert.equal(c.scope, "entrance");
  assert.equal(c.entranceId, site(m).entrances[0].entranceId);
  m.bridge.selectElement("catchment", c.key);
  press(m.env, PANEL, "역 전체 경계로 바꾸기");
  assert.equal(site(m).catchments[0].scope, "station");
  m.bridge.selectElement("catchment", c.key);
  assert.equal(m.bridge.setMode("catchment-entrance"), false, "only with an entrance selected");
  assert.equal(m.bridge.addCatchment(rectAt(0, 0, 9, 9), { entranceKey: "entrance-9" }), false);
});

test("a walking link runs from one end to another through the waypoints clicked on open ground", () => {
  const m = started();
  m.bridge.addEntrance(at(40, -20));
  m.bridge.addAccessPoint(at(40, -80), { kind: "street" });
  m.bridge.addDemandZone(rectAt(100, -160, 180, -100), { kind: "mixed" });
  modeClick(m, "walk-link", at(40, -20));
  clickAt(m.env, at(70, -50)); // open ground: a waypoint
  clickAt(m.env, at(40, -80));
  assert.equal(m.bridge.mode, null);
  const [link] = site(m).walkLinks;
  assert.equal(link.alignment.length, 3);
  assert.equal(link.from.kind, "entrance");
  assert.equal(link.to.kind, "access-point");
  assert.ok(link.lengthMeters >= link.straightDistanceMeters);
  assert.equal(link.widthMeters, null, "no width was stated");
  // inside a zone is an end
  modeClick(m, "walk-link", at(40, -80), at(130, -130));
  assert.equal(site(m).walkLinks.length, 2);
  assert.equal(site(m).demandZones[0].drawnConnection.connected, true);
  assert.equal(site(m).demandZones[0].drawnConnection.linkIds.length, 2, "the zone reaches the station side through the access point and the entrance");
  // two clicks on the same end make no link
  modeClick(m, "walk-link", at(40, -20), at(40, -20));
  assert.equal(site(m).walkLinks.length, 2);
  m.bridge.setMode(null);
  assert.equal(m.bridge.addWalkLink({ from: { kind: "entrance", key: "entrance-9" }, to: { kind: "station" } }), false);
  assert.equal(m.bridge.addWalkLink({ from: { kind: "station" }, to: { kind: "station" } }), false);
  assert.equal(m.bridge.addWalkLink({ from: { kind: "station" }, to: { kind: "access-point", key: "access-point-1" }, via: [[1, 1], "x"] }), false);
  assert.equal(site(m).walkLinks.length, 2);
});

test("a transfer passage ends on another network's station, through waypoints; the station's own line is no target", () => {
  const m = started();
  modeClick(m, "transfer", at(120, -60));
  assert.ok(arcs(m).length >= 3, "the stations that can be a target are drawn");
  clickAt(m.env, [139.02, 35]); // d2
  const t = site(m).transfers.find((x) => x.basis === "player-passage");
  assert.equal(t.targetStationId, "d2");
  assert.equal(t.alignment.length, 3);
  assert.deepEqual(m.bridge.selection, { type: "transfer", key: "d2" });
  assert.equal(m.bridge.setTransfer(world.A.stationCandidates[0].id), false, "a station of the same plan is not a transfer");
  assert.equal(m.bridge.setTransfer("nowhere"), false);
  assert.equal(m.bridge.setTransfer("d2", [[1, 1]], { fromEntranceKey: "entrance-9" }), false);
  assert.equal(site(m).transfers.filter((x) => x.basis === "player-passage").length, 1);
});

// --- selecting ---
test("with no mode a click selects what is under it, and a click on nothing is left to the map", () => {
  const m = drawn();
  m.bridge.addWalkLink({ from: { kind: "entrance", key: "entrance-1" }, to: { kind: "access-point", key: "access-point-1" } });
  m.bridge.selectElement("station");
  const taken = [];
  const click = (ll) => { const p = projection.toScreen(ll); m.env.canvas.dispatchEvent({ type: "pointerdown", clientX: p[0], clientY: p[1], stopImmediatePropagation() { taken.push(p); } }); };
  click(at(40, -20));
  assert.deepEqual(m.bridge.selection, { type: "entrance", key: "entrance-1" });
  click(at(40, -50)); // on the link, between its ends
  assert.deepEqual(m.bridge.selection, { type: "walk-link", key: "walk-link-1" });
  click(at(120, -130));
  assert.deepEqual(m.bridge.selection, { type: "demand-zone", key: "demand-zone-1" }, "a zone inside the boundary is picked before the boundary");
  click(at(-140, -110));
  assert.deepEqual(m.bridge.selection, { type: "catchment", key: "catchment-1" });
  const count = taken.length;
  click(at(600, -600));
  assert.equal(taken.length, count, "a click that hit nothing is not taken from the map");
  assert.deepEqual(m.bridge.selection, { type: "catchment", key: "catchment-1" });
  keyDown(m.env, "Escape");
  assert.equal(m.bridge.selection, null);
  assert.equal(m.bridge.selectedStationKey, "access-1");
  keyDown(m.env, "Escape");
  assert.equal(m.bridge.selectedStationKey, null);
  assert.ok(taken.length >= 4);
});

test("selecting a thing shows the spatial facts measured for it, with unknown values written as unknown", () => {
  const m = drawn();
  m.bridge.selectElement("demand-zone", "demand-zone-1");
  assert.ok(hasText(m.env, PANEL, "수요 노드"));
  assert.ok(hasText(m.env, PANEL, "가장 가까운 수요 노드"));
  assert.ok(hasText(m.env, PANEL, "수요 자료 출처 demand.json"));
  assert.ok(hasText(m.env, PANEL, "품질 낮음"));
  m.bridge.selectElement("entrance", "entrance-1");
  assert.ok(hasText(m.env, PANEL, "겹치는 건물 미상"), "no building layer: unknown, not 0");
  assert.ok(hasText(m.env, PANEL, "해당 자료 없음"));
  assert.equal(m.bridge.selectElement("entrance", "entrance-9"), false);
  assert.equal(m.bridge.selection, null);
});

// --- editing ---
test("names and widths are applied from the panel; a bad width is refused and the old value stays", () => {
  const m = started();
  m.bridge.addEntrance(at(40, -20));
  m.bridge.addAccessPoint(at(40, -80), { kind: "street" });
  m.bridge.addWalkLink({ from: { kind: "entrance", key: "entrance-1" }, to: { kind: "access-point", key: "access-point-1" } });
  m.bridge.selectElement("entrance", "entrance-1");
  find(panelOf(m.env, PANEL), (n) => n.tag === "input")[0].value = " North gate ";
  press(m.env, PANEL, "이름 적용");
  assert.equal(site(m).entrances[0].name, "North gate");
  m.bridge.selectElement("walk-link", "walk-link-1");
  find(panelOf(m.env, PANEL), (n) => n.tag === "input")[1].value = "3.5";
  press(m.env, PANEL, "폭 적용");
  assert.equal(site(m).walkLinks[0].widthMeters, 3.5);
  m.bridge.selectElement("walk-link", "walk-link-1");
  find(panelOf(m.env, PANEL), (n) => n.tag === "input")[1].value = "-2";
  press(m.env, PANEL, "폭 적용");
  assert.equal(site(m).walkLinks[0].widthMeters, 3.5, "the width did not change");
  assert.ok(codes(m).includes("station-demand-access-edit-refused"));
  press(m.env, PANEL, "폭 지움");
  assert.equal(site(m).walkLinks[0].widthMeters, null);
  assert.equal(site(m).walkLinks[0].unknownReasons.widthMeters, "not-provided");
  assert.equal(m.bridge.update("entrance", "entrance-1", { location: [0, 0] }), false, "only names, kinds and widths change this way");
  assert.equal(m.bridge.update("demand-zone", "demand-zone-9", { name: "x" }), false);
});

test("a point is moved with the move mode; its id stays, the walking link follows it, and a line is not moved as a point", () => {
  const m = started();
  m.bridge.addEntrance(at(40, -20));
  m.bridge.addAccessPoint(at(40, -80), { kind: "street" });
  m.bridge.addWalkLink({ from: { kind: "entrance", key: "entrance-1" }, to: { kind: "access-point", key: "access-point-1" } });
  const id = site(m).entrances[0].entranceId;
  const length = site(m).walkLinks[0].lengthMeters;
  m.bridge.selectElement("entrance", "entrance-1");
  modeClick(m, "move", at(120, -20));
  assert.equal(site(m).entrances[0].entranceId, id);
  assert.notEqual(site(m).walkLinks[0].lengthMeters, length);
  assert.equal(m.bridge.mode, null);
  m.bridge.selectElement("walk-link", "walk-link-1");
  assert.equal(m.bridge.setMode("move"), false, "a line is reshaped by its vertices");
  assert.equal(m.bridge.moveElement("walk-link", "walk-link-1", at(0, 0)), false);
});

test("the whole drawing moves with its station and keeps every id", () => {
  const m = drawn();
  const ids = () => [site(m).stationAccessId, ...site(m).entrances.map((e) => e.entranceId), ...site(m).catchments.map((c) => c.catchmentId), ...site(m).demandZones.map((z) => z.demandZoneId)];
  const before = ids();
  const first = site(m).entrances[0].location;
  m.bridge.selectElement("station");
  modeClick(m, "move", at(10, -10)); // the drawing moves by the same amount as the station would
  assert.deepEqual(ids(), before);
  assert.notDeepEqual(site(m).entrances[0].location, first);
  assert.deepEqual(site(m).location, S.map((v) => Math.round(v * 1e6) / 1e6), "a plan station keeps its own place");
});

test("polygon vertices are moved, added and removed by clicking; three stay", () => {
  const m = started();
  m.bridge.addDemandZone(rectAt(80, 80, 160, 160), { kind: "mixed" });
  const id = site(m).demandZones[0].demandZoneId;
  const area = site(m).demandZones[0].areaSquareMeters;
  const count = () => m.bridge.document.stations[0].demandZones[0].polygon.length;
  assert.equal(m.bridge.setMode("vertex-move"), true);
  clickAt(m.env, at(80, 80));
  clickAt(m.env, at(40, 40));
  assert.notEqual(site(m).demandZones[0].areaSquareMeters, area);
  assert.equal(site(m).demandZones[0].demandZoneId, id);
  m.bridge.setMode("vertex-add");
  clickAt(m.env, at(120, 160)); // on the top edge
  assert.equal(count(), 5);
  m.bridge.setMode("vertex-remove");
  clickAt(m.env, at(120, 160));
  assert.equal(count(), 4);
  clickAt(m.env, at(160, 160));
  assert.equal(count(), 3);
  clickAt(m.env, at(160, 80));
  assert.equal(count(), 3, "a polygon keeps three vertices");
  assert.ok(codes(m).includes("station-demand-access-edit-refused"));
  assert.equal(m.bridge.moveVertex("demand-zone", "demand-zone-1", 9, at(0, 0)), false);
  assert.equal(m.bridge.moveVertex("entrance", "entrance-1", 0, at(0, 0)), false);
});

test("a walking link and a transfer passage are reshaped by their waypoints", () => {
  const m = started();
  m.bridge.addEntrance(at(40, -20));
  m.bridge.addAccessPoint(at(40, -120), { kind: "street" });
  m.bridge.addWalkLink({ from: { kind: "entrance", key: "entrance-1" }, to: { kind: "access-point", key: "access-point-1" }, via: [at(80, -60)] });
  m.bridge.selectElement("walk-link", "walk-link-1");
  const len = () => site(m).walkLinks[0].lengthMeters;
  const first = len();
  m.bridge.setMode("vertex-move");
  clickAt(m.env, at(80, -60));
  clickAt(m.env, at(160, -60));
  assert.ok(len() > first);
  m.bridge.setMode("vertex-add");
  clickAt(m.env, at(100, -90)); // on the last stretch, between the waypoint (160, -60) and the end (40, -120)
  assert.equal(m.bridge.document.stations[0].walkLinks[0].via.length, 2);
  m.bridge.setMode("vertex-remove");
  clickAt(m.env, at(100, -90));
  clickAt(m.env, at(160, -60));
  assert.equal(m.bridge.document.stations[0].walkLinks[0].via.length, 0, "a link may have no waypoint at all");
  assert.equal(site(m).walkLinks[0].lengthMeters, site(m).walkLinks[0].straightDistanceMeters);
  m.bridge.setTransfer("d2", [at(200, -100)], { widthMeters: 4 });
  assert.equal(m.bridge.moveVertex("transfer", "d2", 0, at(220, -90)), true);
  assert.equal(m.bridge.document.stations[0].transfers[0].via.length, 1);
  assert.equal(m.bridge.document.stations[0].transfers[0].widthMeters, 4, "reshaping keeps the width");
  assert.equal(m.bridge.removeVertex("transfer", "d2", 0), true);
  assert.equal(m.bridge.moveVertex("transfer", "d2", 0, at(0, 0)), false, "no waypoint left to move");
});

// --- deleting ---
test("deleting an element removes it; what pointed at it stays in the document as a warning", () => {
  const m = started();
  m.bridge.addEntrance(at(40, -20));
  m.bridge.addAccessPoint(at(40, -80), { kind: "street" });
  m.bridge.addWalkLink({ from: { kind: "entrance", key: "entrance-1" }, to: { kind: "access-point", key: "access-point-1" } });
  m.bridge.selectElement("entrance", "entrance-1");
  assert.ok(hasText(m.env, PANEL, "이 요소를 가리키는 연결 1개는 경고로 남습니다"));
  press(m.env, PANEL, "삭제");
  assert.deepEqual(site(m).entrances, []);
  assert.deepEqual(site(m).walkLinks, []);
  assert.equal(m.bridge.document.stations[0].walkLinks.length, 1, "nothing the player drew is lost silently");
  assert.ok(codes(m).includes("station-demand-access-references-left"));
  assert.ok(site(m).warnings.some((w) => w.code === "walk-link-endpoint-missing"));
  assert.ok(codes(m).includes("walk-link-endpoint-missing"), "the host sees the site warnings in the output too");
  assert.equal(m.bridge.selection, null);
  m.bridge.selectElement("access-point", "access-point-1");
  keyDown(m.env, "Delete");
  assert.deepEqual(site(m).accessPoints, []);
  m.bridge.addEntrance(at(40, -20));
  assert.equal(m.bridge.document.stations[0].entrances[0].key, "entrance-2", "a deleted key is never handed out again");
  assert.equal(m.bridge.removeElement("entrance", "entrance-1"), false);
  m.bridge.setTransfer("d2", []);
  assert.equal(m.bridge.removeElement("transfer", "d2"), true);
  assert.equal(site(m).transfers.filter((t) => t.basis === "player-passage").length, 0);
});

// --- save and restore ---
test("every edit is saved; a reload reproduces the drawing and its output byte for byte", () => {
  const storage = new Map();
  const first = mount({ storage });
  first.bridge.startStation(planStation);
  first.bridge.addEntrance(at(40, -20));
  first.bridge.addAccessPoint(at(40, -80), { kind: "street" });
  first.bridge.addWalkLink({ from: { kind: "entrance", key: "entrance-1" }, to: { kind: "access-point", key: "access-point-1" }, via: [at(60, -50)], widthMeters: 3 });
  first.bridge.addCatchment(rectAt(-100, -100, 100, 100));
  first.bridge.addDemandZone(rectAt(80, 100, 160, 160), { kind: "school" });
  first.bridge.setTransfer("d2", [at(200, -100)]);
  const saved = storage.get(first.bridge.storageKey);
  assert.equal(saved, first.bridge.serialize());
  const again = mount({ storage });
  assert.equal(again.bridge.serialize(), saved);
  assert.equal(JSON.stringify(again.bridge.output().export), JSON.stringify(first.bridge.output().export));
  assert.equal(again.bridge.selectedStationKey, null, "nothing is selected after a reload");
});

test("loadDoc replaces the drawing; another pack, an unreadable text and another version are refused and change nothing", () => {
  const m = drawn();
  const text = m.bridge.serialize();
  const other = mount({ packOverride: { ...pack, manifest: { ...pack.manifest, id: "other" } } });
  assert.deepEqual(other.bridge.loadDoc(text).map((w) => w.code), ["station-demand-access-doc-other-pack"]);
  assert.deepEqual(other.bridge.document.stations, []);
  const mine = started();
  mine.bridge.addEntrance(at(40, -20));
  const keep = mine.bridge.serialize();
  assert.deepEqual(mine.bridge.loadDoc("{nope").map((w) => w.code), ["station-demand-access-doc-unreadable"]);
  assert.deepEqual(mine.bridge.loadDoc(JSON.stringify({ ...JSON.parse(text), version: 9 })).map((w) => w.code), ["station-demand-access-doc-version"]);
  assert.equal(mine.bridge.serialize(), keep);
  assert.deepEqual(mine.bridge.loadDoc(null), []);
  assert.deepEqual(mine.bridge.loadDoc(text), []);
  assert.equal(mine.bridge.serialize(), text);
  assert.equal(mine.bridge.selectedStationKey, null);
  assert.deepEqual(mine.bridge.output().export.sites.map((s) => s.entrances.length), [1]);
  const newer = mount({ packOverride: { ...pack, manifest: { ...pack.manifest, version: "2" } } });
  assert.deepEqual(newer.bridge.loadDoc(text).map((w) => w.code), ["pack-version-mismatch"]);
  assert.equal(newer.bridge.document.stations.length, 1, "a pack version change is reported, the drawing is kept");
});

test("blocked storage is a note, never an exception, and the drawing still works", () => {
  const m = mount({ blocked: true });
  assert.equal(m.bridge.startStation(planStation), true);
  assert.equal(m.bridge.addEntrance(at(40, -20)), true);
  assert.equal(site(m).entrances.length, 1);
  assert.ok(codes(m).includes("station-demand-access-doc-not-saved"));
});

// --- inputs ---
test("the output follows the host's plans: a removed plan is a warning, a moved station moves its site, and nothing is rebuilt for nothing", () => {
  const m = started();
  m.bridge.addEntrance(at(40, -20));
  const calls = m.changes.length;
  m.bridge.refresh();
  assert.equal(m.changes.length, calls, "no change, no onChange");
  m.live.plans = [];
  m.bridge.refresh();
  assert.deepEqual(out(m).sites, [], "a drawing whose plan is gone is not built");
  assert.ok(out(m).export.warnings.some((w) => w.code === "station-no-location"));
  assert.ok(hasText(m.env, PANEL, "위치를 만들지 못함"));
  m.live.plans = world.plans;
  m.bridge.refresh();
  assert.equal(out(m).sites[0].entrances.length, 1);
  const moved = structuredClone(world.plans);
  moved[0].stationCandidates[1].location = [S[0] + 0.001, S[1]];
  m.live.plans = moved;
  m.bridge.refresh();
  assert.ok(Math.abs(out(m).sites[0].location[0] - (S[0] + 0.001)) < 1e-9);
  assert.ok(m.changes.length > calls);
});

test("inputs the host hands over are never modified, and the demand sources, nodes and spatial layers it gives are used", () => {
  const plans = deepFreeze(structuredClone(world.plans));
  const externals = deepFreeze(structuredClone(world.map.externalNetworks));
  const m = started({ live: { plans, externals } });
  m.bridge.addDemandZone(rectAt(-400, -400, 400, 400), { kind: "mixed" });
  assert.ok(site(m).demandZones[0].demandNodeRefs.length >= 1, "the pack's demand nodes are linked by id");
  assert.equal(site(m).demandSourceRefs[0].file, "demand.json");
  assert.equal(site(m).demandSourceRefs[0].quality, "low");
  assert.ok(hasText(m.env, PANEL, "품질 낮음"));
  const env = browser();
  const custom = mountStationDemandAccess({ canvas: env.canvas, projection, pack, getPlans: () => plans, getExternalNetworks: () => externals, getDemandNodes: () => [], autoRefreshMs: 0 });
  custom.startStation(planStation);
  custom.addDemandZone(rectAt(-400, -400, 400, 400));
  assert.deepEqual(custom.output().selected.demandZones[0].demandNodeRefs, [], "no nodes given: none inside");
  assert.equal(custom.output().selected.demandSourceRefs, null, "no sources given: unknown");
});

// --- the contract ---
const keysOf = (o, set = new Set()) => { if (Array.isArray(o)) o.forEach((x) => keysOf(x, set)); else if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) { set.add(k); keysOf(v, set); } return set; };

test("the output carries no passenger, fare, crowd, walking-time, route or score field, and onChange fires once per edit", () => {
  const m = drawn();
  m.bridge.addWalkLink({ from: { kind: "entrance", key: "entrance-1" }, to: { kind: "access-point", key: "access-point-1" } });
  const banned = /passenger|rider|fare|crowd|congest|score|cost|cash|price|minute|probab|share|forecast|volume|headcount|population|residents|jobs|workers/i;
  assert.deepEqual([...keysOf(m.bridge.output().export)].filter((k) => banned.test(k) && !/^unknown/.test(k)), []);
  const before = m.changes.length;
  m.bridge.addEntrance(at(-40, 40));
  assert.equal(m.changes.length, before + 1);
  assert.equal(m.fired.length, m.changes.length);
});

test("enabling, disabling and destroying take the panel and the overlay in and out", () => {
  const m = drawn();
  m.bridge.setMode("entrance");
  m.bridge.setEnabled(false);
  assert.equal(panelOf(m.env, PANEL).hidden, true);
  const n = m.bridge.document.stations[0].entrances.length;
  clickAt(m.env, at(-40, 40)); // hidden: clicks are ignored
  assert.equal(m.bridge.document.stations[0].entrances.length, n);
  m.bridge.setEnabled(true);
  assert.equal(panelOf(m.env, PANEL).hidden, false);
  m.bridge.destroy();
  assert.equal(panelOf(m.env, PANEL), undefined);
  assert.equal(layerOf(m.env), undefined);
  assert.deepEqual(m.env.canvas.listeners.pointerdown, []);
});

test("the modules import only their map neighbours and reach no engine state, clock, random source or file system", () => {
  for (const file of ["station-demand-access-ui.mjs", "station-demand-access-view.mjs", "station-demand-access-tools.mjs"]) {
    const src = fs.readFileSync(path.join(root, "engine", "src", "map", file), "utf8");
    const imports = [...src.matchAll(/^import[\s\S]*?from "(.+)";$/gm)].map((m) => m[1]);
    assert.ok(imports.every((i) => /^\.\/[a-z-]+\.mjs$/.test(i)), `${file} imports ${imports}`);
    assert.doesNotMatch(src.replace(/\/\/.*$/gm, ""), /management|ledger|node:fs|Date\.now|Math\.random|\.commit\(|\.settle\(|\.post\(/);
    assert.ok(src.length < 40_000, file);
  }
});
