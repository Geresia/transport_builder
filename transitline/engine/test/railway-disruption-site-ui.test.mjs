import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildRailGeometry } from "../src/map/rail-capacity-geometry.mjs";
import { buildRailwayDisruptionSiteExport } from "../src/map/railway-disruption-site.mjs";
import { DISRUPTION_STORAGE_PREFIX, DISRUPTION_UI_EVENT, SCOPE_NOTICE, mountRailwayDisruptionSite } from "../src/map/railway-disruption-site-ui.mjs";
import { BANNED_TEXT, browser, clickAt, deepFreeze, find, hasButton, hasText, layerOf, panelOf, press, projection, texts } from "./helpers/fake-browser.mjs";
import { Y, applicationOf, eventOf, makeWorld, pack, revisionsOf, trackId } from "./helpers/map-world.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const PANEL = "tl-disruption-panel";
const world = makeWorld("none");
const A1_TRACK = trackId(world.G, world.A1);
const EVENTS = [eventOf("railway-disruption:1", A1_TRACK), eventOf("railway-disruption:2", null, { kind: "vehicle-failure", trainId: "train:7" }), eventOf("railway-disruption:3", "track-segment:unlinked")];
// a second geometry of the same plans with a block boundary in section a0, for block-scope events
const G2 = buildRailGeometry({
  key: "g2", planIds: [world.A.planId, world.B.planId], designedRevisions: revisionsOf(world.A, world.B),
  blockBoundaries: [{ key: "b1", planId: world.A.planId, segmentId: world.A.segments[0].id, measuredFromStationId: world.A.segments[0].from, alongMeters: 300, basis: "player" }],
}, { pack, plans: world.plans, externalNetworks: world.map.externalNetworks, routes: [] }).design;
const APP2 = applicationOf(G2);

function mount({ storage, blocked, packOverride, events = EVENTS, geometries = [world.G], applications = [world.APP], options = {} } = {}) {
  const env = browser({ storage, blocked });
  const live = { events, geometries, applications };
  const changes = [];
  const fired = [];
  env.canvas.addEventListener(DISRUPTION_UI_EVENT, (e) => fired.push(e));
  const bridge = mountRailwayDisruptionSite({ canvas: env.canvas, projection, pack: packOverride ?? pack, getRailGeometry: () => live.geometries, getRailCapacityApplication: () => live.applications, getDisruptionEvents: () => live.events, onChange: (o) => changes.push(o), autoRefreshMs: 0, ...options });
  return { env, live, bridge, changes, fired };
}
const started = (opts, eventId = "railway-disruption:1") => { const m = mount(opts); assert.equal(m.bridge.startSite(eventId), true); return m; };
const midOfA1 = () => { const [p, q] = world.A1.alignment; return [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]; };

// --- mount, events ---
test("mounting makes its own overlay, panel and style, lists the engine's events and states that an unlocated event has no position", () => {
  const { env, bridge, changes } = mount();
  assert.ok(env.doc.head.children.some((c) => c.tag === "style"));
  assert.ok(panelOf(env, PANEL) && layerOf(env));
  assert.deepEqual([bridge.output().document.sites, bridge.output().sites, bridge.output().selected], [[], [], null]);
  assert.ok(hasText(env, PANEL, SCOPE_NOTICE));
  for (const e of EVENTS) assert.ok(hasText(env, PANEL, e.id));
  assert.equal(find(panelOf(env, PANEL), (n) => n.tag === "button" && n.textContent === "위치 지정 시작").length, 3);
  assert.ok(changes.length >= 1);
  assert.ok(SCOPE_NOTICE.includes("구간 중앙으로 가정하지 않습니다"));
});

test("no events or no geometry is a message: nothing is built and nothing throws", () => {
  const none = mount({ events: [] });
  assert.ok(hasText(none.env, PANEL, "지금 장애가 없습니다"));
  const noGeometry = mount({ geometries: [], applications: [] });
  assert.ok(hasText(noGeometry.env, PANEL, "철도 공간 설계가 없어서"));
  assert.equal(noGeometry.bridge.startSite("railway-disruption:1"), true);
  assert.equal(noGeometry.bridge.output().selected, null);
  assert.ok(JSON.stringify(noGeometry.bridge.output().warnings).includes("rail-geometry-missing"));
  const bad = mount({ events: null, geometries: null, applications: undefined });
  assert.deepEqual(bad.bridge.output().sites, []);
  assert.equal(bad.bridge.startSite("railway-disruption:1"), false);
  assert.ok(bad.bridge.output().warnings.some((w) => w.code === "railway-disruption-event-missing"));
});

test("starting a site builds the M6 geometry through the application; its location is null and says so, never the middle of the section", () => {
  const { env, bridge, changes, fired } = mount();
  press(env, PANEL, "위치 지정 시작");
  const out = bridge.output();
  assert.equal(out.selectedEventId, "railway-disruption:1");
  const site = out.selected;
  assert.equal(site.schema, "transitline.railway-disruption-site-geometry/1");
  assert.equal(site.railCapacitySectionId, world.A1.sectionId);
  assert.equal(site.sectionLinkBasis, "application");
  assert.equal(site.location, null);
  assert.equal(site.unknownReasons.location, "location-not-stated");
  assert.equal(site.locationAttach, null);
  assert.ok(site.spatialFlags.includes("location-unknown"));
  assert.ok(hasText(env, PANEL, "위치 미상—구간 전체"));
  assert.equal(changes.at(-1).selected.disruptionSiteId, site.disruptionSiteId);
  assert.equal(fired.at(-1).detail.selectedEventId, "railway-disruption:1");
  assert.equal(JSON.stringify(site).includes(JSON.stringify(midOfA1())), false, "the middle of the section appears nowhere");
});

// --- location ---
test("a click puts the event on the section (snapped onto it) and measures where; clearing the location makes it unknown again", () => {
  const { env, bridge } = started();
  bridge.setMode("locate");
  assert.equal(bridge.mode, "locate");
  clickAt(env, [midOfA1()[0], midOfA1()[1] + 0.0001]);
  assert.equal(bridge.mode, null, "one click per placement");
  const site = bridge.output().selected;
  assert.ok(Math.abs(site.location[1] - Y) < 1e-6, "snapped onto the section's line");
  assert.equal(site.locationBasis, "player");
  assert.equal(site.locationAttach.onSection, true);
  assert.ok(Math.abs(site.locationAttach.alongMeters - world.A1.lengthMeters / 2) < world.A1.lengthMeters * 0.02);
  assert.ok(hasText(env, PANEL, "위치 있음") || hasText(env, PANEL, "위치"));
  press(env, PANEL, "위치 지움");
  assert.equal(bridge.output().selected.location, null);
  assert.equal(bridge.output().selected.unknownReasons.location, "location-not-stated");
});

test("a click far from the section is kept as the player's statement and flagged as not on the section, never moved onto it", () => {
  const { env, bridge } = started();
  bridge.setMode("locate");
  clickAt(env, [139.015, Y + 0.004]);
  const site = bridge.output().selected;
  assert.ok(Math.abs(site.location[1] - (Y + 0.004)) < 1e-4);
  assert.equal(site.locationAttach.onSection, false);
  assert.ok(site.spatialFlags.includes("location-not-on-section"));
});

test("a train event has no position on the map: it cannot be located, and its facts stay null", () => {
  const { bridge } = started({}, "railway-disruption:2");
  assert.equal(bridge.output().selected.scope, "train");
  assert.equal(bridge.setMode("locate"), false);
  assert.ok(bridge.output().warnings.some((w) => w.code === "railway-disruption-train-has-no-position"));
  assert.equal(bridge.locate([139.01, Y]), false);
  assert.equal(bridge.output().selected.location, null);
  assert.equal(bridge.output().selected.railCapacitySectionId, null);
  assert.equal(bridge.output().selected.unknownReasons.railCapacitySectionId, "train-position-not-in-map");
});

test("a block-scope event is measured against its block: a location in another block is flagged outside the affected extent", () => {
  const block = G2.blocks.filter((b) => b.sectionId === G2.sections.find((s) => s.segmentId === world.A.segments[0].id && s.planId === world.A.planId).sectionId).sort((a, b) => a.startAlongMeters - b.startAlongMeters)[0];
  const sec = G2.sections.find((s) => s.sectionId === block.sectionId);
  const event = eventOf("railway-disruption:9", trackId(G2, sec), { blockId: block.blockId });
  const { env, bridge } = started({ events: [event], geometries: [G2], applications: [APP2] }, event.id);
  assert.equal(bridge.output().selected.scope, "block");
  assert.deepEqual(bridge.output().selected.affectedBlockIds, [block.blockId]);
  bridge.setMode("locate");
  const [p, q] = sec.alignment;
  clickAt(env, [p[0] + (q[0] - p[0]) * 0.9, p[1] + (q[1] - p[1]) * 0.9]);
  assert.equal(bridge.output().selected.locationAttach.withinAffectedExtent, false);
  assert.ok(bridge.output().selected.spatialFlags.includes("location-outside-affected-extent"));
  bridge.setMode("locate");
  clickAt(env, [p[0] + (q[0] - p[0]) * 0.1, p[1] + (q[1] - p[1]) * 0.1]);
  assert.equal(bridge.output().selected.locationAttach.withinAffectedExtent, true);
});

// --- influence polygon ---
test("an influence polygon is drawn with clicks and finished; fewer than three points is refused; a degenerate one is dropped with a warning", () => {
  const { env, bridge } = started();
  bridge.setMode("polygon");
  clickAt(env, [139.012, Y + 0.001]);
  clickAt(env, [139.018, Y + 0.001]);
  assert.equal(bridge.finishPolygon(), false);
  assert.ok(bridge.output().warnings.some((w) => w.code === "railway-disruption-polygon-needs-three-points"));
  clickAt(env, [139.015, Y - 0.001]);
  env.canvas.dispatchEvent({ type: "dblclick" });
  assert.equal(bridge.mode, null);
  const site = bridge.output().selected;
  assert.equal(site.affectedPolygon.length, 3);
  assert.ok(site.polygonFacts.sectionIdsCrossed.includes(world.A1.sectionId));
  press(env, PANEL, "영향권 지움");
  assert.equal(bridge.output().selected.affectedPolygon, null);
  assert.equal(bridge.output().selected.unknownReasons.affectedPolygon, "no-polygon-drawn");
  assert.equal(bridge.setPolygon([[139, Y], [139.001, Y + 0.001], [139.001, Y], [139, Y + 0.001]]), true);
  assert.equal(bridge.output().selected.affectedPolygon, null);
  assert.ok(bridge.output().selected.warnings.some((w) => w.code === "polygon-degenerate"));
});

// --- section link, geometry choice ---
test("an event the application does not know has no section; the player links one by clicking it, and it is then marked as an explicit link", () => {
  const { env, bridge } = started({}, "railway-disruption:3");
  const before = bridge.output().selected;
  assert.equal(before.railCapacitySectionId, null);
  assert.equal(before.unknownReasons.railCapacitySectionId, "no-section-link");
  assert.ok(before.spatialFlags.includes("no-section-link"));
  bridge.setMode("link-section");
  clickAt(env, midOfA1());
  const site = bridge.output().selected;
  assert.equal(site.railCapacitySectionId, world.A1.sectionId);
  assert.equal(site.sectionLinkBasis, "explicit");
  assert.equal(bridge.unlinkSection(), true);
  assert.equal(bridge.output().selected.railCapacitySectionId, null);
  bridge.setMode("link-section");
  clickAt(env, [138.9, 36]);
  assert.equal(bridge.mode, "link-section", "a click off every section changes nothing");
});

test("with two geometries and no application naming one, the player chooses the design; until then nothing is built", () => {
  const m = mount({ geometries: [world.G, G2], applications: [] });
  m.bridge.startSite("railway-disruption:1");
  assert.equal(m.bridge.output().selected, null);
  assert.ok(hasText(m.env, PANEL, "철도 설계를 고르세요"));
  press(m.env, PANEL, "이 설계 사용", 1);
  assert.equal(m.bridge.document.sites[0].railGeometryId, G2.railGeometryId);
  assert.equal(m.bridge.chooseGeometry("rail-geometry:nope"), false);
});

// --- stale ---
test("when the rail geometry changes, the site shows it is stale, its positional facts are null, and re-confirming brings them back", () => {
  const m = started();
  m.bridge.setMode("locate");
  clickAt(m.env, midOfA1());
  assert.equal(m.bridge.output().selected.locationAttach.onSection, true);
  const moved = { ...world.G, railGeometryRevision: "rail-geometry-revision:changed" };
  m.live.geometries = [moved];
  m.live.applications = [{ ...world.APP, railGeometryRevision: moved.railGeometryRevision }];
  m.bridge.refresh();
  const site = m.bridge.output().selected;
  assert.ok(site.spatialFlags.includes("design-revision-stale"));
  assert.equal(site.locationAttach, null);
  assert.equal(site.unknownReasons.locationAttach, "design-revision-stale");
  assert.ok(site.location, "the player's own point is kept");
  assert.ok(hasText(m.env, PANEL, "철도 설계가 바뀌었습니다") && hasButton(m.env, PANEL, "현재 철도 설계로 다시 확인"));
  press(m.env, PANEL, "현재 철도 설계로 다시 확인");
  assert.equal(m.bridge.output().selected.locationAttach.onSection, true);
});

test("an event the engine no longer has, or whose track the geometry lost, is reported and builds nothing", () => {
  const m = started();
  m.live.events = [];
  m.bridge.refresh();
  assert.equal(m.bridge.output().selected, null);
  assert.ok(JSON.stringify(m.bridge.output().warnings).includes("event-missing"));
  m.live.events = EVENTS;
  m.live.applications = [{ ...world.APP, sections: [{ trackSegmentId: A1_TRACK, railCapacitySectionId: "rail-section:gone" }] }];
  m.bridge.refresh();
  assert.equal(m.bridge.output().selected, null);
  assert.ok(JSON.stringify(m.bridge.output().warnings).includes("section-missing"));
});

// --- determinism, save ---
test("the same inputs and edits give the same export and the same site ids, byte for byte, in two mounts", () => {
  const run = () => { const m = started(); m.bridge.locate(midOfA1()); m.bridge.setPolygon([[139.012, Y + 0.001], [139.018, Y + 0.001], [139.015, Y - 0.001]]); return JSON.stringify(m.bridge.output().export); };
  assert.equal(run(), run());
  const m = started();
  const direct = buildRailwayDisruptionSiteExport({ pack, events: EVENTS, railGeometries: [world.G], applications: [world.APP], sites: m.bridge.document.sites });
  assert.equal(JSON.stringify(m.bridge.output().export), JSON.stringify(direct), "the mount adds nothing to what the M6 builder gives");
});

test("every edit is saved under the pack's key; a new mount restores the site with the same ids; a switched-off site keeps its id", () => {
  const storage = new Map();
  const a = started({ storage });
  a.bridge.locate(midOfA1());
  a.bridge.setPolygon([[139.012, Y + 0.001], [139.018, Y + 0.001], [139.015, Y - 0.001]]);
  assert.ok(storage.has(`${DISRUPTION_STORAGE_PREFIX}t`));
  const saved = JSON.parse(storage.get(`${DISRUPTION_STORAGE_PREFIX}t`));
  assert.deepEqual([saved.version, saved.packId, saved.sites.length], [1, "t", 1]);
  const b = mount({ storage });
  assert.deepEqual(b.bridge.document, a.bridge.document);
  b.bridge.select("railway-disruption:1");
  assert.equal(JSON.stringify(b.bridge.output().export), JSON.stringify(a.bridge.output().export));
  assert.equal(b.bridge.output().selected.disruptionSiteId, a.bridge.output().selected.disruptionSiteId);
  const id = b.bridge.output().selected.disruptionSiteId;
  b.bridge.setActive(false);
  assert.deepEqual(b.bridge.output().sites, []);
  assert.equal(b.bridge.output().export.inactive[0].disruptionSiteId, id);
  assert.equal(b.bridge.document.sites.length, 1, "switched off, never deleted");
  b.bridge.setActive(true);
  assert.equal(b.bridge.output().selected.disruptionSiteId, id);
});

test("another pack's save is refused, a pack version change is flagged but kept, unreadable data starts empty, blocked storage never throws", () => {
  const storage = new Map();
  started({ storage });
  const text = storage.get(`${DISRUPTION_STORAGE_PREFIX}t`);
  const other = mount({ storage: new Map([[`${DISRUPTION_STORAGE_PREFIX}elsewhere`, text]]), packOverride: { ...pack, manifest: { ...pack.manifest, id: "elsewhere" } } });
  assert.deepEqual(other.bridge.output().document.sites, []);
  assert.ok(other.bridge.output().warnings.some((w) => w.code === "railway-disruption-doc-other-pack"));
  const moved = mount({ storage: new Map([[`${DISRUPTION_STORAGE_PREFIX}t`, text]]), packOverride: { ...pack, manifest: { ...pack.manifest, version: "2" } } });
  assert.equal(moved.bridge.output().document.sites.length, 1);
  assert.ok(moved.bridge.output().warnings.some((w) => w.code === "pack-version-mismatch"));
  assert.ok(mount({ storage: new Map([[`${DISRUPTION_STORAGE_PREFIX}t`, "{not json"]]) }).bridge.output().warnings.some((w) => w.code === "railway-disruption-doc-unreadable"));
  const m = started();
  const keep = JSON.stringify(m.bridge.document);
  assert.deepEqual(m.bridge.loadDoc(JSON.stringify({ version: 1, packId: "elsewhere", packVersion: "1", sites: [] })).map((n) => n.code), ["railway-disruption-doc-other-pack"]);
  assert.deepEqual(m.bridge.loadDoc({ version: 9 }).map((n) => n.code), ["railway-disruption-doc-version"]);
  assert.equal(JSON.stringify(m.bridge.document), keep, "a refused document leaves the sites untouched");
  assert.deepEqual(m.bridge.loadDoc(JSON.stringify({ version: 1, packId: "t", packVersion: "0", sites: [] })).map((n) => n.code), ["pack-version-mismatch"]);
  const blocked = started({ blocked: true });
  blocked.bridge.locate(midOfA1());
  assert.ok(blocked.bridge.output().selected.location);
  assert.ok(blocked.bridge.output().warnings.some((w) => w.code === "railway-disruption-doc-not-saved"));
});

// --- limits ---
test("frozen inputs are never changed; a disabled mount hides itself and ignores the pointer; destroy removes everything", () => {
  const frozenEvents = deepFreeze(structuredClone(EVENTS));
  const frozenG = deepFreeze(structuredClone(world.G));
  const frozenApp = deepFreeze(structuredClone(world.APP));
  const before = JSON.stringify([frozenEvents, frozenG, frozenApp]);
  const m = started({ events: frozenEvents, geometries: [frozenG], applications: [frozenApp] });
  m.bridge.locate(midOfA1());
  m.bridge.setPolygon([[139.012, Y + 0.001], [139.018, Y + 0.001], [139.015, Y - 0.001]]);
  m.bridge.linkSection(world.A1.sectionId);
  m.bridge.setActive(false);
  m.bridge.refresh();
  assert.equal(JSON.stringify([frozenEvents, frozenG, frozenApp]), before);
  m.bridge.setActive(true);
  m.bridge.setMode("locate");
  m.bridge.setEnabled(false);
  assert.equal(panelOf(m.env, PANEL).hidden, true);
  const doc = JSON.stringify(m.bridge.document);
  clickAt(m.env, midOfA1());
  assert.equal(JSON.stringify(m.bridge.document), doc);
  m.bridge.destroy();
  assert.equal(panelOf(m.env, PANEL), undefined);
  assert.equal(m.env.canvas.listeners.pointerdown?.length ?? 0, 0);
});

test("the mount changes no engine state, imports no management or engine-state module, and says nothing about duration, cost, probability or whether trains can run", () => {
  const state = deepFreeze({ cash: 1_000_000, ledger: [{ id: 1 }], trains: [{ id: "train:7" }], railwayDisruptions: { events: EVENTS }, clockMinute: 600 });
  const before = JSON.stringify(state);
  const m = started();
  m.bridge.locate(midOfA1());
  assert.equal(JSON.stringify(state), before);
  assert.equal(texts(panelOf(m.env, PANEL)).some((t) => BANNED_TEXT.test(t)), false);
  const keys = new Set();
  const walk = (v) => { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { keys.add(k); walk(x); } };
  walk(m.bridge.output().document);
  assert.deepEqual([...keys].filter((k) => /cost|price|cash|fee|charge|duration|delay|probab|score|rank|verdict|recover|expectedEnd|severity/i.test(k)), []);
  const text = fs.readFileSync(path.join(here, "..", "src", "map", "railway-disruption-site-ui.mjs"), "utf8");
  assert.ok(text.length < 40_000);
  for (const x of text.matchAll(/from "([^"]+)"/g)) assert.match(x[1], /^\.\/[a-z-]+\.mjs$/, x[1]);
  assert.equal(/from\s+["'][^"']*management/.test(text), false);
  assert.equal(/from\s+["'][^"']*(railway-disruptions|railway-traffic-control|rail-capacity-integration|rail-replacement-operations|scenario-runtime|trains|network|state|game|main)\.mjs/.test(text), false);
  assert.equal(/ledger|\.commit\(|\.settle\(|\.post\(|node:fs|Date\.now|Math\.random|state\.(trains|lines|trackSegments|railwayDisruptions)/.test(text.replace(/\/\/.*$/gm, "")), false);
});
