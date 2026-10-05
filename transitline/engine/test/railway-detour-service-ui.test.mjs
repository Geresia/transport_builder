import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildMapExport } from "../src/map/plan-geometry.mjs";
import { stableId } from "../src/map/ids.mjs";
import { buildRailGeometry, planRevisionOf } from "../src/map/rail-capacity-geometry.mjs";
import { buildThroughRoute } from "../src/map/through-route.mjs";
import { buildRailwayDisruptionSite } from "../src/map/railway-disruption-site.mjs";
import { buildRailwayServiceControl } from "../src/map/railway-service-control.mjs";
import { buildRailwayDetourServiceExport } from "../src/map/railway-detour-service.mjs";
import { picksOf } from "../src/map/railway-detour-service-editor.mjs";
import { buildRailwayDetourView } from "../src/map/railway-detour-service-view.mjs";
import {
  DETOUR_STORAGE_PREFIX, DETOUR_UI_EVENT, PLAYER_LINE_NOTICE, SCOPE_NOTICE, STATE_LABELS, candidatesOf, mountRailwayDetourService, pickDetourItem, readDetourInputs, rebindDetourPlan, snapDetourPoint,
} from "../src/map/railway-detour-service-ui.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

// --- fixtures: the same three ways to give a1-a2 a detour as the M9 tests (existing line / plan c apart / plan c joined) ---
const pack = {
  manifest: { id: "t", version: "1", origin: [139, 35], data: { license: "CC0-1.0", attribution: ["test"] } },
  demand: { points: ["d0", "d1", "d2", "d3", "d4"].map((id, i) => ({ id, name: id, location: [139 + i * 0.01, 35] })) },
  existingNetwork: { lines: [{ name: "E1", operator: "Operator X", osmRelationId: 42, stationIds: ["d1", "d2", "d3"] }] },
};
const EXT = "ext-line:42";
const line = (key, pts) => ({ key, name: key, vertices: pts.map((location) => ({ location, platformType: "side" })) });
const revisionsOf = (...plans) => ({ plans: Object.fromEntries(plans.map((p) => [p.planId, planRevisionOf(p)])), routes: {} });
const sectionOf = (g, plan, i) => g.sections.find((s) => s.planId === plan.planId && s.segmentId === plan.segments[i].id);
const trackId = (g, section) => `track-segment:${g.sections.findIndex((s) => s.sectionId === section.sectionId) + 1}`;
const applicationOf = (g) => ({ schema: "transitline.rail-capacity-application/1", contractVersion: 1, operationalLineId: "line:1", railGeometryId: g.railGeometryId, railGeometryRevision: g.railGeometryRevision, sections: g.sections.map((s) => ({ trackSegmentId: trackId(g, s), railCapacitySectionId: s.sectionId })) });
const eventOf = (id, trackSegmentId) => ({
  schema: "transitline.railway-disruption/1", contractVersion: 1, id, kind: "signal-failure", status: "active", lineId: "line:1", trackSegmentId, blockId: null, trainId: null,
  startedAtMinute: 600, expectedEndMinute: 660, resolvedAtMinute: null, resolutionReason: null, severity: "major", effect: { closed: true, speedLimitMps: 0 }, infrastructureOwnerId: null, operatorId: null, responsibility: "unknown", source: "simulation",
});
function makeWorld(mode) {
  const Y = 35.0005;
  const drawn = [line("a", [[139, Y], [139.01, Y], [139.02, Y]]), line("b", [[139.02, Y], [139.03, Y], [139.04, Y]])];
  if (mode === "joined") drawn.push(line("c", [[139.01, Y], [139.015, Y + 0.003], [139.02, Y]]));
  if (mode === "apart") drawn.push(line("c", [[139.011, Y + 0.001], [139.019, Y + 0.001]]));
  const map = buildMapExport({ pack, mode: "existing", drawnLines: drawn });
  const plan = (k) => map.plans.find((p) => p.planId === stableId("plan", "t", "key", k));
  const [A, B, C] = [plan("a"), plan("b"), mode === "joined" || mode === "apart" ? plan("c") : null];
  const legs = mode === "ext" ? [
    { sourceKind: "planned", key: "l1", planId: A.planId, fromStationId: A.segments[0].from, toStationId: A.segments[0].to, infrastructureOwnerId: "owner:player" },
    { sourceKind: "external", key: "l2", externalLineId: EXT, fromStationId: "d1", toStationId: "d3", infrastructureOwnerId: "owner:other" },
    { sourceKind: "planned", key: "l3", planId: B.planId, infrastructureOwnerId: "owner:player" },
  ] : mode === "apart" ? [
    { sourceKind: "planned", key: "l1", planId: A.planId, fromStationId: A.segments[0].from, toStationId: A.segments[0].to, infrastructureOwnerId: "owner:player" },
    { sourceKind: "planned", key: "l2", planId: C.planId, infrastructureOwnerId: "owner:other" },
    { sourceKind: "planned", key: "l3", planId: B.planId, infrastructureOwnerId: "owner:player" },
  ] : null;
  const route = legs ? buildThroughRoute({ key: "r", legs }, { pack, plans: map.plans, externalNetworks: map.externalNetworks }).route : null;
  const planIds = [A.planId, B.planId, ...(C ? [C.planId] : [])];
  const G = buildRailGeometry({
    key: "g", planIds, externalLineIds: mode === "ext" ? [EXT] : [], ...(route ? { throughRouteId: route.throughRouteId } : {}),
    designedRevisions: { ...revisionsOf(A, B, ...(C ? [C] : [])), routes: route ? { [route.throughRouteId]: route.geometryRevision } : {} },
  }, { pack, plans: map.plans, externalNetworks: map.externalNetworks, routes: route ? [route] : [] }).design;
  const APP = applicationOf(G);
  const A1 = sectionOf(G, A, 1);
  const event = eventOf("railway-disruption:1", trackId(G, A1));
  const site = buildRailwayDisruptionSite({ eventId: event.id, designedRailGeometryRevision: G.railGeometryRevision }, { pack, events: [event], railGeometry: G, applications: [APP] }).site;
  const control = buildRailwayServiceControl({ eventId: event.id }, { pack, site, railGeometry: G, application: APP, routes: route ? [route] : [], externalNetworks: map.externalNetworks }).control;
  assert.ok(G && site && control);
  return { mode, map, G, APP, route, site, control, candidateId: control.detourCandidates[0].candidateId, a1: A.segments[0].to };
}
const WORLDS = { ext: makeWorld("ext"), apart: makeWorld("apart"), joined: makeWorld("joined") };
const EXTERNAL_NETWORKS = WORLDS.ext.map.externalNetworks;

// --- a minimal browser: elements, listeners, a canvas that records, localStorage, a window ---
class Node_ {
  constructor(tag, doc) { Object.assign(this, { tag, ownerDocument: doc, children: [], className: "", textContent: "", hidden: false, style: {}, listeners: {}, parentNode: null, width: 800, height: 600, id: "", type: "" }); }
  append(...kids) { for (const k of kids) { k.parentNode = this; this.children.push(k); } }
  replaceChildren(...kids) { this.children = []; this.append(...kids); }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((c) => c !== this); this.parentNode = null; }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] ?? []).filter((f) => f !== fn); }
  dispatchEvent(ev) { for (const fn of [...(this.listeners[ev.type] ?? [])]) fn(ev); return true; }
  getBoundingClientRect() { return { left: 0, top: 0, width: this.width, height: this.height }; }
  getContext() {
    this.calls ??= [];
    this.ctx ??= new Proxy({}, { get: (target, name) => (name in target ? target[name] : (...args) => { this.calls.push([name, target.strokeStyle, ...args]); }), set: (target, name, value) => { target[name] = value; if (name === "strokeStyle") this.calls.push(["set-strokeStyle", value]); return true; } });
    return this.ctx;
  }
}
function browser({ storage = new Map(), blocked = false } = {}) {
  const win = { listeners: {}, intervals: 0, localStorage: { getItem: (k) => { if (blocked) throw new Error("blocked"); return storage.has(k) ? storage.get(k) : null; }, setItem: (k, v) => { if (blocked) throw new Error("blocked"); storage.set(k, v); } },
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }, removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] ?? []).filter((f) => f !== fn); }, setInterval() { this.intervals += 1; return 1; }, clearInterval() {}, fire(type, ev) { for (const fn of this.listeners[type] ?? []) fn(ev); } };
  const doc = { defaultView: win, head: null, body: null, createElement: (tag) => new Node_(tag, doc), getElementById: (id) => doc.head.children.find((c) => c.id === id) ?? null };
  doc.head = new Node_("head", doc);
  doc.body = new Node_("body", doc);
  const canvas = new Node_("canvas", doc);
  doc.body.append(canvas);
  return { win, doc, canvas, storage };
}
const projection = { toScreen: ([lon, lat]) => [(lon - 139) * 20000, (35.01 - lat) * 20000] };
const screenOf = (p) => projection.toScreen(p);
const texts = (node) => [node.textContent, ...node.children.flatMap(texts)].filter(Boolean);
const find = (node, pred) => [pred(node) ? node : null, ...node.children.flatMap((c) => find(c, pred))].filter(Boolean);
const panelOf = (env) => env.doc.body.children.find((c) => c.className === "tl-detour-panel");
const layerOf = (env) => env.doc.body.children.find((c) => c.tag === "canvas" && c !== env.canvas) ?? env.canvas.parentNode?.children.find((c) => c.tag === "canvas" && c !== env.canvas);
const click = (env, point, type = "pointerdown") => env.canvas.dispatchEvent({ type, clientX: point[0], clientY: point[1], stopImmediatePropagation() {} });
const clickAt = (env, lonLat) => click(env, screenOf(lonLat));
const press = (env, label, nth = 0) => { const b = find(panelOf(env), (n) => n.tag === "button" && n.textContent === label)[nth]; assert.ok(b, `button ${label}`); b.dispatchEvent({ type: "click", stopPropagation() {} }); };
const hasText = (env, part) => texts(panelOf(env)).some((t) => t.includes(part));
const deepFreeze = (o) => { if (o && typeof o === "object") { Object.values(o).forEach(deepFreeze); Object.freeze(o); } return o; };

function hostFor(world, over = {}) {
  const live = { control: world.control, site: world.site, G: world.G, APP: world.APP, routes: world.route ? [world.route] : [], catalog: null, networks: world.mode === "ext" ? EXTERNAL_NETWORKS : [], stationSites: [] };
  return { live, getters: {
    getRailGeometry: () => live.G, getRailCapacityApplication: () => live.APP, getDisruptionSites: () => (live.site ? [live.site] : []), getServiceControls: () => (live.control ? [live.control] : []),
    getThroughRoutes: () => live.routes, getExternalCatalog: () => live.catalog, getExternalNetworks: () => live.networks, getStationSites: () => live.stationSites, ...over,
  } };
}
function mount(world = WORLDS.joined, { storage, blocked, packOverride, over, options = {} } = {}) {
  const env = browser({ storage, blocked });
  const host = hostFor(world, over);
  const changes = [];
  const events = [];
  env.canvas.addEventListener(DETOUR_UI_EVENT, (e) => events.push(e));
  const bridge = mountRailwayDetourService({ canvas: env.canvas, projection, pack: packOverride ?? pack, ...host.getters, onChange: (o) => changes.push(o), autoRefreshMs: 0, ...options });
  return { env, host, bridge, changes, events, world };
}
const withPlan = (world = WORLDS.joined, opts) => { const m = mount(world, opts); assert.equal(m.bridge.choose(world.control.eventId, world.candidateId), true); return m; };
const connectionStates = (out) => out.selected.connections.map((c) => c.physicalConnection);

// --- mount, candidates, plans ---
test("mounting makes its own overlay, panel and style, reads the getters, and starts empty without changing any input", () => {
  const frozen = deepFreeze(structuredClone(WORLDS.joined));
  const { env, bridge, changes } = mount(frozen);
  assert.ok(env.doc.head.children.some((c) => c.tag === "style"));
  assert.ok(panelOf(env) && layerOf(env));
  const out = bridge.output();
  assert.deepEqual([out.document.plans, out.picks, out.selected, out.selectedPlan], [[], {}, null, null]);
  assert.equal(out.export.detours.length, 0);
  assert.ok(changes.length >= 1, "onChange is called with the first output");
  assert.ok(hasText(env, SCOPE_NOTICE) && hasText(env, PLAYER_LINE_NOTICE));
});

test("only the detour candidates of the active control geometries are offered; no controls or no candidates is a message, not a value", () => {
  const listed = candidatesOf([WORLDS.joined.control, WORLDS.ext.control]);
  assert.deepEqual(listed.map((c) => c.candidateId).sort(), [WORLDS.joined.candidateId, WORLDS.ext.candidateId].sort());
  const { env } = mount(WORLDS.joined);
  assert.equal(find(panelOf(env), (n) => n.tag === "button" && n.textContent === "계획 만들기").length, 1);
  const none = mount(WORLDS.joined, { over: { getServiceControls: () => null } });
  assert.ok(hasText(none.env, "선택할 수 있는 우회 후보가 없습니다"));
  assert.equal(none.bridge.output().export.detours.length, 0);
  const noDetour = mount(WORLDS.joined, { over: { getServiceControls: () => [{ ...WORLDS.joined.control, detourCandidates: [] }] } });
  assert.ok(hasText(noDetour.env, "선택할 수 있는 우회 후보가 없습니다"));
  assert.equal(candidatesOf([{ ...WORLDS.joined.control, detourCandidates: null }]).length, 0, "an event with no map position offers none");
});

test("choosing an offered candidate makes the plan and rebuilds the M9 geometry; onChange and the DOM event carry the output", () => {
  const w = WORLDS.joined;
  const { bridge, changes, events, env } = mount(w);
  assert.equal(bridge.choose(w.control.eventId, w.candidateId), true);
  const out = bridge.output();
  assert.equal(out.selectedPlan.candidateId, w.candidateId);
  assert.equal(out.selected.selectedDetourCandidateId, w.candidateId);
  assert.equal(out.selected.schema, "transitline.railway-detour-service-geometry/1");
  assert.equal(out.export.detours.length, 1);
  assert.equal(changes.at(-1).selected.detourGeometryId, out.selected.detourGeometryId);
  assert.equal(events.at(-1).detail.selected.detourGeometryId, out.selected.detourGeometryId);
  assert.ok(hasText(env, "구간 "), "the legs are listed in the panel");
});

test("a candidate the control geometry does not offer is refused with a note and creates nothing", () => {
  const { bridge } = mount(WORLDS.joined);
  assert.equal(bridge.choose(WORLDS.joined.control.eventId, "railway-control-detour:made-up"), false);
  assert.equal(bridge.choose("railway-disruption:99", WORLDS.joined.candidateId), false);
  const out = bridge.output();
  assert.deepEqual(out.document.plans, []);
  assert.equal(out.warnings.filter((w) => w.code === "railway-detour-candidate-not-offered").length, 2);
});

test("the same inputs and choices give the same export, byte for byte, in two mounts", () => {
  const run = () => { const m = withPlan(WORLDS.apart); m.bridge.addPlayerConnection([[139.0105, 35.001], [139.0185, 35.001]], { key: "k" }); return JSON.stringify(m.bridge.output().export); };
  assert.equal(run(), run());
  const m = withPlan(WORLDS.apart);
  const direct = buildRailwayDetourServiceExport({ pack, sites: [WORLDS.apart.site], controls: [WORLDS.apart.control], railGeometries: [WORLDS.apart.G], applications: [WORLDS.apart.APP], routes: [WORLDS.apart.route], documents: [{ eventId: WORLDS.apart.control.eventId, detourCandidateId: WORLDS.apart.candidateId, selectedOnControlGeometryRevision: WORLDS.apart.control.controlGeometryRevision, connections: null, transferPaths: null, active: true }] });
  assert.equal(JSON.stringify(m.bridge.output().export), JSON.stringify(direct), "the UI adds nothing to what the M9 builder gives");
});

// --- picking ---
test("legs, source connections and transfer links can be picked and unpicked; only ids the geometry offers are accepted", () => {
  const { bridge } = withPlan(WORLDS.apart);
  const d = bridge.output().selected;
  assert.equal(bridge.pick("leg", d.legs[0].legId), true);
  assert.equal(bridge.pick("connection", d.connections[0].connectionId), true);
  assert.equal(bridge.pick("transfer", d.transferLinks[0].transferLinkId), true);
  const p = picksOf(bridge.document)[`${d.eventId}|${d.selectedDetourCandidateId}`];
  assert.deepEqual([p.legIds.length, p.connectionIds.length, p.transferIds.length], [1, 1, 1]);
  assert.equal(bridge.pick("leg", "railway-detour-leg:made-up"), false);
  assert.equal(bridge.pick("leg", d.connections[0].connectionId), false, "an id of another kind");
  assert.equal(bridge.pick("route", d.legs[0].legId), false, "a kind that does not exist");
  assert.ok(bridge.output().warnings.filter((w) => w.code === "railway-detour-pick-refused").length >= 3);
  assert.equal(bridge.unpick("leg", d.legs[0].legId), true);
  assert.deepEqual(picksOf(bridge.document)[`${d.eventId}|${d.selectedDetourCandidateId}`].legIds, []);
  bridge.clearPicks();
  assert.deepEqual(picksOf(bridge.document)[`${d.eventId}|${d.selectedDetourCandidateId}`], { legIds: [], connectionIds: [], transferIds: [] });
});

test("clicking a drawn leg or a connection marker on the map picks it, clicking again unpicks it, clicking elsewhere does nothing", () => {
  const { env, bridge } = withPlan(WORLDS.joined);
  const d = bridge.output().selected;
  const key = `${d.eventId}|${d.selectedDetourCandidateId}`;
  const [p0, p1] = d.legs[0].alignment;
  const mid = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2];
  clickAt(env, mid);
  assert.deepEqual(picksOf(bridge.document)[key].legIds, [d.legs[0].legId]);
  clickAt(env, mid);
  assert.deepEqual(picksOf(bridge.document)[key].legIds, []);
  clickAt(env, d.connections[0].location);
  assert.deepEqual(picksOf(bridge.document)[key].connectionIds, [d.connections[0].connectionId], "a connection marker wins over the leg under it");
  const before = JSON.stringify(bridge.document);
  clickAt(env, [138.9, 36]);
  assert.equal(JSON.stringify(bridge.document), before);
  const model = buildRailwayDetourView({ exportData: { detours: [d] } });
  assert.equal(pickDetourItem(model, screenOf, screenOf([138.9, 36])), null);
  assert.equal(pickDetourItem(model, screenOf, screenOf(d.connections[0].location)).kind, "connection");
});

// --- drawing ---
test("drawing a connection line with clicks, ending with a double click, keeps it as the player's with a stable key and id", () => {
  const { env, bridge } = withPlan(WORLDS.apart);
  const d = bridge.output().selected;
  const link = d.connections.find((c) => c.kind === "handover-link");
  assert.equal(bridge.startDrawing("connection"), true);
  assert.equal(bridge.mode, "draw-connection");
  clickAt(env, link.viaLocations[0]);
  clickAt(env, [139.0145, 35.0012]);
  clickAt(env, link.viaLocations[1]);
  click(env, [0, 0], "dblclick");
  assert.equal(bridge.mode, null);
  const out = bridge.output();
  const drawn = out.selected.playerConnections;
  assert.equal(drawn.length, 1);
  assert.equal(drawn[0].key, "connection-1");
  assert.equal(drawn[0].basis, "player");
  assert.deepEqual(drawn[0].ends.map((e) => e.attached), [true, true], "the end points snapped onto the stations");
  assert.equal(drawn[0].joinedAtBothEnds, true);
  assert.deepEqual(bridge.document.plans[0].connections.map((c) => c.key), ["connection-1"]);
  assert.equal(out.selected.playerConnections[0].playerConnectionId, stableId("railway-detour-player-connection", out.selected.detourGeometryId, "key", "connection-1"));
});

test("a transfer passage is drawn the same way and snaps to entrances; Escape cancels, Enter finishes, fewer than two points is refused", () => {
  const w = WORLDS.joined;
  const site = { connectedStationId: w.a1, stationSiteId: "stn-site:a1", entranceCandidates: [{ entranceId: "ent:n", location: [139.0103, 35.0007] }] };
  const { env, bridge } = withPlan(w, { over: { getStationSites: () => [site] } });
  bridge.startDrawing("transfer");
  clickAt(env, [139.0103, 35.00071]);
  clickAt(env, [139.0113, 35.0009]);
  env.win.fire("keydown", { key: "Enter" });
  const p = bridge.output().selected.playerTransferPaths[0];
  assert.equal(p.key, "transfer-1");
  assert.equal(p.ends[0].nearestEntranceId, "ent:n");
  assert.equal(p.polyline[0][0], 139.0103, "the first point snapped to the entrance");
  bridge.startDrawing("transfer");
  clickAt(env, [139.0113, 35.0009]);
  env.win.fire("keydown", { key: "Escape" });
  assert.equal(bridge.mode, null);
  assert.equal(bridge.output().selected.playerTransferPaths.length, 1);
  bridge.startDrawing("connection");
  clickAt(env, [139.0113, 35.0009]);
  assert.equal(bridge.finishDrawing(), false);
  assert.ok(bridge.output().warnings.some((x) => x.code === "railway-detour-line-needs-two-points"));
});

test("redrawing keeps the key and the id; deleting removes the line and its pick; the player's other drawings stay", () => {
  const { bridge } = withPlan(WORLDS.apart);
  bridge.addPlayerConnection([[139.0105, 35.001], [139.0185, 35.001]], { key: "mine", name: "My line" });
  bridge.addPlayerConnection([[139.0112, 35.0013], [139.0182, 35.0013]], { key: "other" });
  const first = bridge.output().selected.playerConnections.find((c) => c.key === "mine");
  bridge.pick("connection", first.playerConnectionId);
  bridge.redraw("connection", "mine");
  assert.equal(bridge.mode, "draw-connection");
  bridge.addDraftPoint([139.0115, 35.0011]);
  bridge.addDraftPoint([139.0175, 35.0011]);
  bridge.finishDrawing();
  const again = bridge.output().selected.playerConnections.find((c) => c.key === "mine");
  assert.equal(again.playerConnectionId, first.playerConnectionId);
  assert.equal(again.name, "My line");
  assert.notDeepEqual(again.polyline, first.polyline);
  assert.equal(bridge.removeDrawing("connection", "mine"), true);
  const out = bridge.output();
  assert.deepEqual(out.selected.playerConnections.map((c) => c.key), ["other"]);
  assert.deepEqual(Object.values(out.picks)[0].connectionIds, [], "the removed line is no longer picked");
  bridge.addPlayerTransferPath([[139.01, 35.0], [139.011, 35.0]], { key: "t" });
  assert.equal(bridge.removeDrawing("transfer", "t"), true);
  assert.deepEqual(bridge.document.plans[0].transferPaths, []);
  assert.equal(bridge.redraw("connection", "no-such-key"), false);
});

// --- true / false / null and the player's lines ---
test("a line the player draws never changes a source connection: true, false and null stay as measured", () => {
  for (const [mode, expected] of [["joined", true], ["apart", false], ["ext", null]]) {
    const w = WORLDS[mode];
    const { bridge } = withPlan(w);
    const before = connectionStates(bridge.output());
    assert.ok(before.every((s) => s === expected), `${mode}: every joint is ${expected}`);
    const stations = bridge.output().selected.stations;
    bridge.addPlayerConnection([stations[0].location, stations.at(-1).location], { key: "all-the-way" });
    bridge.addPlayerTransferPath([stations[0].location, stations[1].location], { key: "walk" });
    const out = bridge.output();
    assert.deepEqual(connectionStates(out), before);
    assert.equal(out.selected.physicalConnection, expected === null || mode === "ext" ? null : expected);
    assert.equal(out.selected.playerConnections.length, 1);
  }
});

test("true, false and null look different: three labels and colours in the panel, three ring colours on the map", () => {
  assert.equal(new Set(Object.values(STATE_LABELS)).size, 3);
  assert.deepEqual(Object.values(STATE_LABELS).map((l) => l.replace(/\(.*/, "")), ["측정상 연결", "실제로 끊김", "측정 못 함·미상"]);
  const rings = (mode) => { const m = withPlan(WORLDS[mode]); return { text: texts(panelOf(m.env)).join("|"), colours: new Set(layerOf(m.env).calls.filter((c) => c[0] === "set-strokeStyle").map((c) => c[1])), classes: find(panelOf(m.env), (n) => /state-(true|false|null)/.test(n.className)).map((n) => n.className) }; };
  const joined = rings("joined");
  const apart = rings("apart");
  const ext = rings("ext");
  assert.ok(joined.text.includes("측정상 연결(true)") && joined.colours.has("#22c55e") && !joined.colours.has("#ef4444"));
  assert.ok(apart.text.includes("실제로 끊김(false)") && apart.colours.has("#ef4444"));
  assert.ok(ext.text.includes("측정 못 함·미상(null)") && ext.colours.has("#9ca3af") && !ext.colours.has("#22c55e"));
  assert.ok(joined.classes.some((c) => c.includes("state-true")) && apart.classes.some((c) => c.includes("state-false")) && ext.classes.some((c) => c.includes("state-null")));
});

test("an existing line without alignment is not drawn as a line: only station positions and 'no detail' appear", () => {
  const { env, bridge } = withPlan(WORLDS.ext);
  const d = bridge.output().selected;
  assert.ok(d.legs.every((l) => l.alignment === null));
  const calls = layerOf(env).calls;
  const labels = calls.filter((c) => c[0] === "fillText" || c[0] === "strokeText").map((c) => String(c[2]));
  assert.ok(labels.some((t) => t.includes("기존선 역") && t.includes("상세 자료 없음")));
  assert.ok(hasText(env, "선형 자료 없음, 역 위치만"));
  const legLineTos = calls.filter((c) => c[0] === "lineTo").length;
  assert.equal(legLineTos <= 4, true, "only the faint candidate preview and the dotted station links, no leg alignment");
  assert.equal(d.alignment, null);
});

test("the panel always says that a drawn line does not change the connection facts, with a plan selected or not", () => {
  const m = mount(WORLDS.joined);
  assert.ok(hasText(m.env, PLAYER_LINE_NOTICE));
  m.bridge.choose(WORLDS.joined.control.eventId, WORLDS.joined.candidateId);
  assert.ok(hasText(m.env, PLAYER_LINE_NOTICE));
  m.bridge.addPlayerConnection([[139.01, 35.0], [139.02, 35.0]]);
  assert.ok(hasText(m.env, PLAYER_LINE_NOTICE));
  assert.ok(PLAYER_LINE_NOTICE.includes("접속 사실") && PLAYER_LINE_NOTICE.includes("바꾸지 않습니다"));
});

// --- save and restore ---
test("every edit is saved to localStorage under the pack's key; a new mount restores the plan, picks and drawings with the same ids and export", () => {
  const storage = new Map();
  const a = withPlan(WORLDS.apart, { storage });
  a.bridge.addPlayerConnection([[139.0105, 35.001], [139.0185, 35.001]], { key: "mine" });
  const d = a.bridge.output().selected;
  a.bridge.pick("leg", d.legs[0].legId);
  a.bridge.pick("connection", d.playerConnections[0].playerConnectionId);
  assert.ok(storage.has(`${DETOUR_STORAGE_PREFIX}t`));
  assert.equal(a.bridge.storageKey, `${DETOUR_STORAGE_PREFIX}t`);
  const saved = JSON.parse(storage.get(`${DETOUR_STORAGE_PREFIX}t`));
  assert.deepEqual([saved.version, saved.packId, saved.plans.length], [1, "t", 1]);
  const b = mount(WORLDS.apart, { storage });
  assert.deepEqual(b.bridge.document, a.bridge.document);
  assert.equal(b.bridge.selectedPlan, null, "the open selection is not saved");
  b.bridge.choose(WORLDS.apart.control.eventId, WORLDS.apart.candidateId);
  assert.equal(JSON.stringify(b.bridge.output().export), JSON.stringify(a.bridge.output().export));
  assert.equal(b.bridge.output().selected.playerConnections[0].playerConnectionId, d.playerConnections[0].playerConnectionId);
  assert.deepEqual(b.bridge.output().picks, a.bridge.output().picks);
  assert.equal(b.bridge.serialize(), a.bridge.serialize());
});

test("another pack's saved plans are refused with a warning; a pack version change is flagged but keeps the plans; unreadable data starts empty", () => {
  const storage = new Map();
  withPlan(WORLDS.joined, { storage });
  const text = storage.get(`${DETOUR_STORAGE_PREFIX}t`);
  const otherPack = { ...pack, manifest: { ...pack.manifest, id: "elsewhere" } };
  const other = mount(WORLDS.joined, { storage: new Map([[`${DETOUR_STORAGE_PREFIX}elsewhere`, text]]), packOverride: otherPack });
  assert.deepEqual(other.bridge.output().document.plans, []);
  assert.ok(other.bridge.output().warnings.some((w) => w.code === "railway-detour-doc-other-pack"));
  const newer = { ...pack, manifest: { ...pack.manifest, version: "2" } };
  const moved = mount(WORLDS.joined, { storage: new Map([[`${DETOUR_STORAGE_PREFIX}t`, text]]), packOverride: newer });
  assert.equal(moved.bridge.output().document.plans.length, 1);
  assert.ok(moved.bridge.output().warnings.some((w) => w.code === "pack-version-mismatch"));
  const junk = mount(WORLDS.joined, { storage: new Map([[`${DETOUR_STORAGE_PREFIX}t`, "{not json"]]) });
  assert.deepEqual(junk.bridge.output().document.plans, []);
  assert.ok(junk.bridge.output().warnings.some((w) => w.code === "railway-detour-doc-unreadable"));
  const m = withPlan(WORLDS.joined);
  const keep = JSON.stringify(m.bridge.document);
  const notes = m.bridge.loadDoc(JSON.stringify({ version: 1, packId: "elsewhere", packVersion: "1", plans: [] }));
  assert.deepEqual(notes.map((n) => n.code), ["railway-detour-doc-other-pack"]);
  assert.deepEqual(m.bridge.loadDoc({ version: 9 }).map((n) => n.code), ["railway-detour-doc-version"]);
  assert.deepEqual(m.bridge.loadDoc("{not json").map((n) => n.code), ["railway-detour-doc-unreadable"]);
  assert.equal(JSON.stringify(m.bridge.document), keep, "a refused document leaves the current plans and the saved copy untouched");
  assert.equal(JSON.parse(m.env.storage.get(`${DETOUR_STORAGE_PREFIX}t`)).plans.length, 1);
  assert.deepEqual(m.bridge.loadDoc(JSON.stringify({ version: 1, packId: "t", packVersion: "0", plans: [] })).map((n) => n.code), ["pack-version-mismatch"]);
  assert.deepEqual(m.bridge.document.plans, [], "an accepted document replaces the plans");
});

test("blocked storage never throws: the work continues in memory with a note", () => {
  const { bridge } = withPlan(WORLDS.joined, { blocked: true });
  bridge.addPlayerConnection([[139.01, 35.0], [139.02, 35.0]]);
  assert.equal(bridge.output().selected.playerConnections.length, 1);
  assert.ok(bridge.output().warnings.some((w) => w.code === "railway-detour-doc-not-saved"));
});

// --- stale and missing inputs ---
test("when the control geometry moves on, the plan shows a warning and no geometry, and re-confirming it brings the geometry back", () => {
  const w = WORLDS.joined;
  const m = withPlan(w);
  m.bridge.addPlayerConnection([[139.01, 35.0], [139.02, 35.0]], { key: "mine" });
  const d = m.bridge.output().selected;
  m.bridge.pick("leg", d.legs[0].legId);
  m.host.live.control = { ...w.control, controlGeometryRevision: "railway-service-control-revision:later" };
  m.bridge.refresh();
  const out = m.bridge.output();
  assert.equal(out.selected, null, "no value is guessed for a plan whose control geometry changed");
  assert.ok(out.warnings.some((x) => x.code === "railway-detour-plan-outdated"));
  assert.ok(out.warnings.some((x) => x.code === "railway-detour-service-rejected"));
  assert.ok(hasText(m.env, "값을 추정하지 않습니다"));
  assert.equal(out.export.detours.length, 0);
  assert.equal(m.bridge.rebind(), true, "re-confirming records the current revision");
  assert.ok(m.bridge.output().selected);
  assert.deepEqual(m.bridge.output().picks[`${d.eventId}|${d.selectedDetourCandidateId}`].legIds, [d.legs[0].legId], "a pick the geometry still offers is kept");
});

test("re-confirming a plan whose control geometry changed records the new revision and keeps the player's drawings", () => {
  const w = WORLDS.joined;
  const { host, bridge, env } = withPlan(w);
  bridge.addPlayerConnection([[139.01, 35.0], [139.02, 35.0]], { key: "mine" });
  const drawn = bridge.document.plans[0].connections;
  host.live.control = { ...w.control, controlGeometryRevision: "railway-service-control-revision:later" };
  bridge.refresh();
  press(env, "현재 관제 후보로 다시 확인");
  const out = bridge.output();
  assert.ok(out.selected, "the geometry is back");
  assert.equal(out.selected.controlGeometryRevision, "railway-service-control-revision:later");
  assert.deepEqual(bridge.document.plans[0].connections, drawn);
  assert.equal(bridge.document.plans[0].selectedOnControlGeometryRevision, "railway-service-control-revision:later");
  const plans = { plans: [{ eventId: "e", detourCandidateId: "c", picked: { legIds: ["x"], connectionIds: [], transferIds: [] }, selectedOnControlGeometryRevision: "old" }] };
  assert.throws(() => rebindDetourPlan(plans, "e", "other", { detourCandidates: [] }), /Unknown detour plan/);
  assert.throws(() => rebindDetourPlan(plans, "e", "c", { detourCandidates: [] }), /Unknown detour candidate/);
});

test("stale rail geometry, a missing site or missing inputs show warnings only: nothing is estimated and nothing throws", () => {
  const w = WORLDS.joined;
  const m = withPlan(w);
  m.host.live.G = { ...w.G, railGeometryRevision: "rail-geometry-revision:other" };
  m.bridge.refresh();
  assert.equal(m.bridge.output().selected, null);
  assert.ok(JSON.stringify(m.bridge.output().warnings).includes("control-rail-geometry-revision-mismatch") || JSON.stringify(m.bridge.output().warnings).includes("rail-geometry-revision-mismatch"));
  m.host.live.G = w.G;
  m.host.live.site = null;
  m.bridge.refresh();
  assert.equal(m.bridge.output().selected, null);
  assert.ok(JSON.stringify(m.bridge.output().warnings).includes("site-missing"));
  const empty = mount(WORLDS.joined, { over: { getRailGeometry: () => null, getRailCapacityApplication: () => undefined, getDisruptionSites: () => null, getServiceControls: () => null, getThroughRoutes: () => null, getExternalCatalog: () => null, getExternalNetworks: () => undefined, getStationSites: () => undefined } });
  assert.equal(empty.bridge.output().export.detours.length, 0);
  assert.deepEqual(readDetourInputs({}), { geometries: [], applications: [], sites: [], controls: [], routes: [], catalog: null, networks: [], stationSites: [] });
});

test("a plan whose candidate the control no longer offers is reported, and its geometry is not built", () => {
  const w = WORLDS.joined;
  const m = withPlan(w);
  m.host.live.control = { ...w.control, detourCandidates: [] };
  m.bridge.refresh();
  assert.ok(m.bridge.output().warnings.some((x) => x.code === "railway-detour-plan-not-offered"));
  assert.equal(m.bridge.output().selected, null);
  m.host.live.control = null;
  m.bridge.refresh();
  assert.ok(m.bridge.output().warnings.some((x) => x.code === "railway-detour-control-missing"));
});

// --- plans on and off, enabled, destroy ---
test("a plan is switched off and on, never deleted; a disabled mount hides itself and ignores the pointer", () => {
  const { env, bridge } = withPlan(WORLDS.joined);
  bridge.setPlanActive(false);
  assert.equal(bridge.output().export.detours.length, 0);
  assert.equal(bridge.document.plans.length, 1);
  assert.equal(bridge.document.plans[0].active, false);
  bridge.setPlanActive(true);
  assert.equal(bridge.output().export.detours.length, 1);
  bridge.setEnabled(false);
  assert.equal(panelOf(env).hidden, true);
  const before = JSON.stringify(bridge.document);
  clickAt(env, bridge.output().selected.legs[0].alignment[1]);
  assert.equal(JSON.stringify(bridge.document), before);
  bridge.setEnabled(true);
  assert.equal(panelOf(env).hidden, false);
});

test("destroying the mount removes its panel, overlay and listeners", () => {
  const { env, bridge } = withPlan(WORLDS.joined);
  bridge.destroy();
  assert.equal(panelOf(env), undefined);
  assert.equal(env.canvas.listeners.pointerdown?.length ?? 0, 0);
  assert.equal(env.win.listeners.keydown?.length ?? 0, 0);
});

// --- limits: no engine state, no management, no estimates ---
test("the UI changes no engine state and its output carries no cost, time, capacity, compatibility or verdict field or text", () => {
  const state = deepFreeze({ cash: 1_000_000, ledger: [{ id: 1 }], trains: [{ id: "train:7" }], railwayDisruptions: { events: [eventOf("railway-disruption:1", "track-segment:1")] }, clockMinute: 600 });
  const before = JSON.stringify(state);
  const m = withPlan(WORLDS.apart);
  m.bridge.addPlayerConnection([[139.0105, 35.001], [139.0185, 35.001]], { key: "k" });
  m.bridge.pick("leg", m.bridge.output().selected.legs[0].legId);
  assert.equal(JSON.stringify(state), before);
  const keys = new Set();
  const walk = (v) => { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { keys.add(k); walk(x); } };
  walk(m.bridge.output());
  const FORBIDDEN = /cost|price|\bfee|charge|cash|probab|verdict|feasib|possib|approval|score|delay|duration|minutes|(?<!rail)capacity|throughput|headway|timetable|trainCount|fleet|demand|passenger|loss|compensat|revenue|reputation|contract(?!Version)|compatib|gauge|voltage|rank|recommend/i;
  assert.deepEqual([...keys].filter((k) => !k.includes(":") && FORBIDDEN.test(k)), []);
  const BANNED_TEXT = /원|비용|공기|승인|확률|가능|불가|복구|지연|보상|평판|손실|시간|용량|수송력|점수|순위|접근료|계약|판정/;
  assert.equal(texts(panelOf(m.env)).some((t) => BANNED_TEXT.test(t)), false);
});

test("the UI module imports only sibling map modules, no management or engine-state module, and does no money, clock or file work", () => {
  const text = fs.readFileSync(path.join(here, "..", "src", "map", "railway-detour-service-ui.mjs"), "utf8");
  assert.ok(text.length < 40_000);
  for (const m of text.matchAll(/from "([^"]+)"/g)) assert.match(m[1], /^\.\/[a-z-]+\.mjs$/, m[1]);
  assert.equal(/from\s+["'][^"']*management/.test(text), false);
  assert.equal(/from\s+["'][^"']*(railway-disruptions|railway-traffic-control|rail-capacity-integration|rail-replacement-operations|scenario-runtime|trains|network|state|game|main)\.mjs/.test(text), false);
  assert.equal(/ledger|\.commit\(|\.settle\(|\.post\(|node:fs|Date\.now|Math\.random|state\.(trains|lines|trackSegments|railwayDisruptions)/.test(text.replace(/\/\/.*$/gm, "")), false);
  assert.equal(snapDetourPoint({ detours: [] }, screenOf, [0, 0]), null);
});

test("frozen inputs are never changed by any operation of the UI", () => {
  const w = deepFreeze(structuredClone(WORLDS.apart));
  const frozenNetworks = deepFreeze(structuredClone(EXTERNAL_NETWORKS));
  const before = JSON.stringify([w, frozenNetworks]);
  const m = mount(w, { over: { getExternalNetworks: () => frozenNetworks } });
  m.bridge.choose(w.control.eventId, w.candidateId);
  m.bridge.addPlayerConnection([[139.0105, 35.001], [139.0185, 35.001]], { key: "k" });
  m.bridge.addPlayerTransferPath([[139.01, 35.0], [139.011, 35.0]], { key: "t" });
  const d = m.bridge.output().selected;
  m.bridge.pick("leg", d.legs[0].legId);
  m.bridge.redraw("connection", "k");
  m.bridge.cancelDrawing();
  m.bridge.removeDrawing("transfer", "t");
  m.bridge.setPlanActive(false);
  m.bridge.refresh();
  assert.equal(JSON.stringify([w, frozenNetworks]), before);
});
