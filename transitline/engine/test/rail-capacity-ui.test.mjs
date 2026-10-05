import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildMapExport } from "../src/map/plan-geometry.mjs";
import { buildRailGeometryExport } from "../src/map/rail-capacity-geometry.mjs";
import {
  JUNCTION_ROLES, RAIL_CAPACITY_STORAGE_PREFIX, RAIL_CAPACITY_UI_EVENT, SCOPE_NOTICE, mountRailCapacityDesign,
} from "../src/map/rail-capacity-ui.mjs";
import { boundaryOf, hitSection, hitStation, sectionRefOf, sectionsAtStation, snapToSections, stationsOf } from "../src/map/rail-capacity-ui-tools.mjs";
import { BANNED_TEXT, browser, clickAt, deepFreeze, find, hasButton, hasText, layerOf, panelOf, press, projection, screenOf, texts } from "./helpers/fake-browser.mjs";
import { Y, makeWorld, pack } from "./helpers/map-world.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const world = makeWorld("none");
const PANEL = "tl-rail-panel";

function mount({ storage, blocked, packOverride, plans = world.plans, options = {} } = {}) {
  const env = browser({ storage, blocked });
  const live = { plans, routes: [], networks: world.map.externalNetworks, stationSites: [] };
  const changes = [];
  const events = [];
  env.canvas.addEventListener(RAIL_CAPACITY_UI_EVENT, (e) => events.push(e));
  const bridge = mountRailCapacityDesign({ canvas: env.canvas, projection, pack: packOverride ?? pack, getPlans: () => live.plans, getExternalNetworks: () => live.networks, getRoutes: () => live.routes, getStationSites: () => live.stationSites, onChange: (o) => changes.push(o), autoRefreshMs: 0, ...options });
  return { env, live, bridge, changes, events };
}
const withDesign = (opts) => { const m = mount(opts); const key = m.bridge.createDesign({ planIds: [world.A.planId] }); assert.equal(key, "rail-1"); return { ...m, key }; };
const sectionOut = (bridge, plan, i) => bridge.output().selected.sections.find((s) => s.planId === plan.planId && s.segmentId === plan.segments[i].id);
const midOf = (section, t = 0.5) => { const [p, q] = section.alignment; return [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]; };
const stationLocation = (bridge, id) => stationsOf(bridge.output().selected).find((s) => s.stationId === id).location;

// --- mount, designs ---
test("mounting makes its own overlay, panel and style, lists the plans and states what the map shows, and starts without designs", () => {
  const { env, bridge, changes } = mount();
  assert.ok(env.doc.head.children.some((c) => c.tag === "style"));
  assert.ok(panelOf(env, PANEL) && layerOf(env));
  assert.deepEqual([bridge.output().document.designs, bridge.output().selected, bridge.output().railGeometries], [[], null, []]);
  assert.ok(hasText(env, PANEL, SCOPE_NOTICE));
  assert.ok(hasText(env, PANEL, world.A.planId));
  assert.ok(hasButton(env, PANEL, "이 계획선으로 설계 만들기") && hasButton(env, PANEL, "모든 계획선으로 설계 만들기"));
  assert.ok(changes.length >= 1);
});

test("a design is made from a plan by the button or the API; the M5 geometry is built from it and onChange and the DOM event carry the output", () => {
  const { env, bridge, changes, events } = mount();
  press(env, PANEL, "이 계획선으로 설계 만들기");
  const out = bridge.output();
  assert.equal(out.selectedKey, "rail-1");
  assert.equal(out.document.designs.length, 1);
  assert.equal(out.railGeometries.length, 1);
  assert.equal(out.selected.schema, "transitline.rail-capacity-geometry/1");
  assert.equal(out.selected.railGeometryId, out.railGeometries[0].railGeometryId);
  assert.equal(out.selected.sections.length, 2);
  assert.equal(out.selected.revision.state, "current");
  assert.equal(changes.at(-1).selected.railGeometryId, out.selected.railGeometryId);
  assert.equal(events.at(-1).detail.selectedKey, "rail-1");
  assert.equal(bridge.createDesign({ planIds: ["plan:nope"] }), null, "a design needs at least one real plan");
  assert.ok(bridge.output().warnings.some((w) => w.code === "rail-capacity-edit-refused"));
  assert.equal(bridge.createDesign({ planIds: [world.B.planId], name: "B" }), "rail-2");
  assert.equal(bridge.selectDesign("rail-1"), true);
  assert.equal(bridge.selectDesign("rail-9"), false);
});

test("the same plans and the same edits give the same export, byte for byte, in two mounts", () => {
  const run = () => {
    const m = withDesign();
    m.bridge.setTrackCount(sectionRefOf(sectionOut(m.bridge, world.A, 0)), "double");
    m.bridge.addBoundary({ planId: world.A.planId, segmentId: world.A.segments[0].id, measuredFromStationId: world.A.segments[0].from, alongMeters: 300, basis: "player" });
    return JSON.stringify(m.bridge.output().export);
  };
  assert.equal(run(), run());
  const direct = buildRailGeometryExport({ pack, mapExport: { plans: world.plans, externalNetworks: world.map.externalNetworks }, routes: [], stationSites: [], designs: [withDesign().bridge.output().document.designs[0]] });
  assert.equal(direct.designs.length, 1);
});

// --- track count ---
test("single and double track are stated by clicking a section; clearing it makes it unknown again, never a guess", () => {
  const { env, bridge } = withDesign();
  const s0 = sectionOut(bridge, world.A, 0);
  assert.equal(s0.directionMode, null);
  assert.equal(s0.unknownReasons.directionMode, "track-count-not-stated");
  bridge.setMode({ kind: "track-double" });
  clickAt(env, midOf(s0));
  assert.equal(sectionOut(bridge, world.A, 0).directionMode, "double");
  assert.equal(sectionOut(bridge, world.A, 0).directionModeBasis, "player");
  bridge.setMode({ kind: "track-single" });
  clickAt(env, midOf(sectionOut(bridge, world.A, 1)));
  assert.equal(sectionOut(bridge, world.A, 1).directionMode, "single");
  bridge.setMode({ kind: "track-clear" });
  clickAt(env, midOf(s0));
  assert.equal(sectionOut(bridge, world.A, 0).directionMode, null);
  clickAt(env, [138.9, 36]);
  assert.equal(sectionOut(bridge, world.A, 1).directionMode, "single", "a click off every section changes nothing");
});

test("a mode needs a selected design; without one it is refused with a note", () => {
  const { bridge } = mount();
  assert.equal(bridge.setMode({ kind: "track-double" }), false);
  assert.ok(bridge.output().warnings.some((w) => w.code === "rail-capacity-no-design-selected"));
  assert.equal(bridge.mode, null);
  assert.equal(bridge.setTrackCount({ planId: world.A.planId, segmentId: world.A.segments[0].id }, "single"), false);
});

// --- block boundaries ---
test("a block boundary is placed by clicking a section: measured from its first station, strictly inside it; unknown, declared none and set are three different states", () => {
  const { env, bridge } = withDesign();
  assert.equal(bridge.output().selected.blocks, null, "no block data: null");
  bridge.setMode({ kind: "add-boundary" });
  const s0 = sectionOut(bridge, world.A, 0);
  clickAt(env, midOf(s0, 0.4));
  const design = bridge.output().document.designs[0];
  assert.equal(design.blockBoundaries.length, 1);
  const b = design.blockBoundaries[0];
  assert.deepEqual([b.planId, b.segmentId, b.measuredFromStationId, b.basis], [world.A.planId, world.A.segments[0].id, s0.fromStationId, "player"]);
  assert.ok(Math.abs(b.alongMeters - s0.lengthMeters * 0.4) < s0.lengthMeters * 0.02);
  const out = bridge.output().selected;
  assert.equal(out.blocks.filter((x) => x.sectionId === s0.sectionId).length, 2);
  assert.equal(out.signalCandidates.length, 2);
  clickAt(env, s0.startLocation);
  assert.equal(bridge.output().document.designs[0].blockBoundaries.length, 1, "on the station itself is not inside the section");
  assert.ok(bridge.output().warnings.some((w) => w.code === "rail-capacity-boundary-position-invalid"));
  assert.equal(bridge.moveBoundary("boundary-1", s0.lengthMeters * 0.7), true);
  assert.ok(Math.abs(bridge.output().document.designs[0].blockBoundaries[0].alongMeters - s0.lengthMeters * 0.7) < 1);
  bridge.removeBoundary("boundary-1");
  assert.deepEqual(bridge.output().document.designs[0].blockBoundaries, [], "removing the last one leaves a declared-empty list");
  assert.ok(bridge.output().selected.blocks.every((x) => x.declaredWithoutIntermediateBoundary));
  bridge.clearBlocks();
  assert.equal(bridge.output().selected.blocks, null);
  bridge.declareNoBlocks();
  assert.deepEqual(bridge.output().document.designs[0].blockBoundaries, []);
  assert.equal(bridge.removeBoundary("boundary-9"), false);
});

// --- junctions ---
test("a turnout is placed on the track and connected section by section with the role the player names; nothing is assumed", () => {
  const { env, bridge } = withDesign({});
  bridge.createDesign({ planIds: [world.A.planId, world.B.planId] });
  const a1 = stationLocation(bridge, world.a2);
  bridge.setMode({ kind: "add-turnout" });
  clickAt(env, a1);
  const j = bridge.output().document.designs[1].junctions[0];
  assert.deepEqual([j.key, j.kind, j.connections], ["junction-1", "turnout", []]);
  assert.ok(Math.abs(j.location[0] - 139.02) < 1e-5 && Math.abs(j.location[1] - Y) < 1e-5, "placed on the nearest track point");
  const exp0 = bridge.output().selected.junctions[0];
  assert.deepEqual(exp0.sectionIds, [], "unconnected: no section");
  assert.equal(exp0.attachedToAllSections, null, "nothing connected: not measured, so null");
  bridge.setMode({ kind: "connect", role: "stem", junctionKey: "junction-1" });
  clickAt(env, midOf(sectionOut(bridge, world.A, 1), 0.9));
  bridge.setMode({ kind: "connect", role: "main", junctionKey: "junction-1" });
  clickAt(env, midOf(sectionOut(bridge, world.B, 0), 0.1));
  const connected = bridge.output().selected.junctions[0];
  assert.deepEqual(bridge.output().document.designs[1].junctions[0].connections.map((c) => c.role).sort(), ["main", "stem"]);
  assert.equal(connected.sectionIds.length, 2);
  assert.equal(connected.attachedToAllSections, true);
  assert.deepEqual(connected.missingRoles, ["branch"]);
  assert.equal(bridge.disconnectJunction("junction-1", "main"), true);
  assert.equal(bridge.output().selected.junctions[0].sectionIds.length, 1);
  assert.equal(bridge.moveJunction("junction-1", [139.03, Y]), true);
  assert.equal(bridge.removeJunction("junction-1"), true);
  assert.deepEqual(bridge.output().document.designs[1].junctions, []);
});

test("a flat crossing has four roles; an unknown junction kind is refused; junction data stays unknown until the player declares or places one", () => {
  assert.deepEqual(JUNCTION_ROLES.crossing, ["a1", "a2", "b1", "b2"]);
  const { env, bridge } = withDesign();
  assert.equal(bridge.output().selected.junctions, null);
  assert.equal(bridge.placeJunction("roundabout", [139, Y]), false);
  assert.equal(bridge.output().selected.junctions, null, "a refused edit does not turn unknown into none");
  bridge.setMode({ kind: "add-crossing" });
  clickAt(env, [139.005, Y + 0.001]);
  const j = bridge.output().document.designs[0].junctions[0];
  assert.equal(j.kind, "crossing");
  assert.ok(Math.abs(j.location[1] - (Y + 0.001)) < 1e-4, "a click far from every track stays where it is");
  assert.equal(bridge.output().selected.junctions[0].attachedToAllSections, null);
});

// --- terminals ---
test("a terminal is placed by clicking a station; a platform and a turnback track are drawn with clicks and measured against the approach", () => {
  const { env, bridge } = withDesign();
  const at = stationLocation(bridge, world.a0);
  bridge.setMode({ kind: "add-terminal" });
  clickAt(env, at);
  assert.equal(bridge.output().document.designs[0].terminals[0].stationId, world.a0);
  assert.equal(bridge.output().selected.terminals[0].platformCandidates, null, "no platform drawn: unknown");
  assert.equal(bridge.output().selected.terminals[0].turnbackCandidates, null);
  bridge.setMode({ kind: "draw-platform", terminalKey: "terminal-1" });
  clickAt(env, at);
  clickAt(env, [139 - 0.0015, Y]);
  assert.ok(bridge.finishDraw());
  const platform = bridge.output().selected.terminals[0].platformCandidates[0];
  assert.equal(platform.connected, true, "the platform starts where the approach ends");
  assert.equal(platform.approachSectionId, sectionOut(bridge, world.A, 0).sectionId);
  assert.equal(bridge.mode, null);
  bridge.setMode({ kind: "draw-turnback", terminalKey: "terminal-1", trackKind: "pull-out" });
  clickAt(env, at);
  clickAt(env, [139 - 0.001, Y + 0.0004]);
  env.canvas.dispatchEvent({ type: "dblclick" });
  const track = bridge.output().selected.terminals[0].turnbackCandidates[0];
  assert.deepEqual([track.kind, track.attached], ["pull-out", true]);
  assert.equal(bridge.removePlatform("terminal-1", "platform-1"), true);
  assert.deepEqual(bridge.output().document.designs[0].terminals[0].platforms, [], "emptied by the player: a list, not unknown");
  assert.equal(bridge.removeTurnbackTrack("terminal-1", "turnback-1"), true);
  assert.equal(bridge.removeTerminal("terminal-1"), true);
});

test("a platform at a station that several sections reach asks which section it comes in from; a line of fewer than two points is refused", () => {
  const { env, bridge } = withDesign();
  bridge.createDesign({ planIds: [world.A.planId, world.B.planId] });
  const mid = stationLocation(bridge, world.a2);
  bridge.setMode({ kind: "add-terminal" });
  clickAt(env, mid);
  bridge.setMode({ kind: "draw-platform", terminalKey: "terminal-1" });
  clickAt(env, mid);
  clickAt(env, [139.0205, Y]);
  assert.equal(bridge.finishDraw(), "pick-approach");
  assert.equal(bridge.mode.kind, "pick-approach");
  assert.ok(hasText(env, PANEL, "승강장이 들어오는 구간을 클릭하세요"));
  clickAt(env, midOf(sectionOut(bridge, world.A, 0)));
  assert.equal(bridge.mode.kind, "pick-approach", "a section that does not reach the station is not an approach");
  clickAt(env, midOf(sectionOut(bridge, world.B, 0)));
  assert.equal(bridge.mode, null);
  const platform = bridge.output().document.designs[1].terminals[0].platforms[0];
  assert.deepEqual([platform.approach.planId, platform.approach.segmentId], [world.B.planId, world.B.segments[0].id]);
  bridge.setMode({ kind: "draw-turnback", terminalKey: "terminal-1", trackKind: "stabling" });
  clickAt(env, mid);
  assert.equal(bridge.finishDraw(), false);
  assert.ok(bridge.output().warnings.some((w) => w.code === "rail-capacity-line-needs-two-points"));
  env.win.fire("keydown", { key: "Escape" });
  assert.equal(bridge.mode, null);
});

// --- stale plans, missing inputs ---
test("when a plan changes after the design was made, the design shows it is stale, its positional facts become null, and re-confirming brings them back", () => {
  const m = withDesign();
  const { bridge, env, live } = m;
  bridge.setMode({ kind: "add-boundary" });
  clickAt(env, midOf(sectionOut(bridge, world.A, 0)));
  assert.equal(bridge.output().selected.blocks.length, 3);
  const moved = buildMapExport({ pack, mode: "existing", drawnLines: [{ key: "a", name: "a", vertices: [[139, Y], [139.01, Y + 0.0004], [139.02, Y]].map((location) => ({ location, platformType: "side" })) }, { key: "b", name: "b", vertices: [[139.02, Y], [139.03, Y], [139.04, Y]].map((location) => ({ location, platformType: "side" })) }] });
  live.plans = moved.plans;
  bridge.refresh();
  const stale = bridge.output().selected;
  assert.equal(stale.revision.state, "stale");
  assert.equal(stale.blocks, null, "the boundary was placed on the old line: not read");
  assert.equal(stale.unknownReasons.blocks, "design-revision-stale");
  assert.ok(hasText(env, PANEL, "노선이 바뀌었습니다") && hasButton(env, PANEL, "현재 계획선으로 다시 확인"));
  assert.equal(bridge.output().document.designs[0].blockBoundaries.length, 1, "the player's boundary is kept");
  press(env, PANEL, "현재 계획선으로 다시 확인");
  assert.equal(bridge.output().selected.revision.state, "current");
  assert.ok(Array.isArray(bridge.output().selected.blocks), "block data is read again");
  assert.ok(bridge.output().selected.warnings.some((w) => w.code === "boundary-section-missing"), "the redrawn segment has a new id, so the old boundary no longer finds its section");
});

test("a design whose plan is gone is reported and builds nothing; no plans at all is a message", () => {
  const { bridge, live } = withDesign();
  live.plans = [];
  bridge.refresh();
  assert.equal(bridge.output().selected, null);
  assert.deepEqual(bridge.output().railGeometries, []);
  assert.ok(JSON.stringify(bridge.output().warnings).includes("plan-missing"));
  const none = mount({ plans: [] });
  assert.ok(hasText(none.env, PANEL, "설계할 계획선이 없습니다"));
});

// --- save and restore ---
test("every edit is saved under the pack's key; a new mount restores the designs and the same geometry ids", () => {
  const storage = new Map();
  const a = withDesign({ storage });
  a.bridge.setTrackCount(sectionRefOf(sectionOut(a.bridge, world.A, 0)), "single");
  a.bridge.addBoundary({ planId: world.A.planId, segmentId: world.A.segments[1].id, measuredFromStationId: world.A.segments[1].from, alongMeters: 500, basis: "player" });
  assert.ok(storage.has(`${RAIL_CAPACITY_STORAGE_PREFIX}t`));
  assert.equal(a.bridge.storageKey, `${RAIL_CAPACITY_STORAGE_PREFIX}t`);
  const saved = JSON.parse(storage.get(`${RAIL_CAPACITY_STORAGE_PREFIX}t`));
  assert.deepEqual([saved.version, saved.packId, saved.designs.length], [1, "t", 1]);
  const b = mount({ storage });
  assert.deepEqual(b.bridge.document, a.bridge.document);
  b.bridge.selectDesign("rail-1");
  assert.equal(JSON.stringify(b.bridge.output().export), JSON.stringify(a.bridge.output().export));
  assert.equal(b.bridge.output().selected.railGeometryId, a.bridge.output().selected.railGeometryId);
  assert.equal(b.bridge.output().selected.railGeometryRevision, a.bridge.output().selected.railGeometryRevision);
  assert.equal(b.bridge.serialize(), a.bridge.serialize());
});

test("another pack's save is refused, a pack version change is flagged but kept, unreadable data starts empty, blocked storage never throws", () => {
  const storage = new Map();
  withDesign({ storage });
  const text = storage.get(`${RAIL_CAPACITY_STORAGE_PREFIX}t`);
  const other = mount({ storage: new Map([[`${RAIL_CAPACITY_STORAGE_PREFIX}elsewhere`, text]]), packOverride: { ...pack, manifest: { ...pack.manifest, id: "elsewhere" } } });
  assert.deepEqual(other.bridge.output().document.designs, []);
  assert.ok(other.bridge.output().warnings.some((w) => w.code === "rail-capacity-doc-other-pack"));
  const moved = mount({ storage: new Map([[`${RAIL_CAPACITY_STORAGE_PREFIX}t`, text]]), packOverride: { ...pack, manifest: { ...pack.manifest, version: "2" } } });
  assert.equal(moved.bridge.output().document.designs.length, 1);
  assert.ok(moved.bridge.output().warnings.some((w) => w.code === "pack-version-mismatch"));
  const junk = mount({ storage: new Map([[`${RAIL_CAPACITY_STORAGE_PREFIX}t`, "{not json"]]) });
  assert.ok(junk.bridge.output().warnings.some((w) => w.code === "rail-capacity-doc-unreadable"));
  const m = withDesign();
  const keep = JSON.stringify(m.bridge.document);
  assert.deepEqual(m.bridge.loadDoc(JSON.stringify({ version: 1, packId: "elsewhere", packVersion: "1", designs: [] })).map((n) => n.code), ["rail-capacity-doc-other-pack"]);
  assert.deepEqual(m.bridge.loadDoc("{not json").map((n) => n.code), ["rail-capacity-doc-unreadable"]);
  assert.deepEqual(m.bridge.loadDoc({ version: 9 }).map((n) => n.code), ["rail-capacity-doc-version"]);
  assert.equal(JSON.stringify(m.bridge.document), keep, "a refused document leaves the designs untouched");
  assert.deepEqual(m.bridge.loadDoc(JSON.stringify({ version: 1, packId: "t", packVersion: "0", designs: [] })).map((n) => n.code), ["pack-version-mismatch"]);
  assert.deepEqual(m.bridge.document.designs, []);
  const blocked = withDesign({ blocked: true });
  blocked.bridge.setTrackCount(sectionRefOf(sectionOut(blocked.bridge, world.A, 0)), "double");
  assert.equal(sectionOut(blocked.bridge, world.A, 0).directionMode, "double");
  assert.ok(blocked.bridge.output().warnings.some((w) => w.code === "rail-capacity-doc-not-saved"));
});

// --- the tools, the limits ---
test("the hit-testing tools are pure: a section within the radius, a station, a snapped point, a boundary position strictly inside", () => {
  const { bridge } = withDesign();
  const d = bridge.output().selected;
  const s0 = sectionOut(bridge, world.A, 0);
  const hit = hitSection(d, screenOf, screenOf(midOf(s0)));
  assert.equal(hit.section.sectionId, s0.sectionId);
  assert.ok(Math.abs(hit.alongMeters - s0.lengthMeters / 2) < s0.lengthMeters * 0.02);
  assert.equal(hitSection(d, screenOf, [-500, -500]), null);
  assert.equal(hitStation(d, screenOf, screenOf(s0.startLocation)).stationId, s0.fromStationId);
  assert.equal(hitStation(d, screenOf, [-500, -500]), null);
  assert.deepEqual(snapToSections(d, screenOf, [-500, -500], (x, y) => [x, y]), [-500, -500], "off every section the point stays where it is");
  assert.equal(boundaryOf({ ...hit, alongMeters: 0.2 }), null);
  assert.equal(boundaryOf(hit).measuredFromStationId, s0.fromStationId);
  assert.equal(sectionsAtStation(d, world.a1).length, 2);
  assert.deepEqual(sectionRefOf({ externalLineId: "e", fromStationId: "x", toStationId: "y" }), { externalLineId: "e", fromStationId: "x", toStationId: "y" });
});

test("frozen inputs are never changed by any operation, and a disabled mount hides itself and ignores the pointer", () => {
  const frozen = deepFreeze(structuredClone(world.plans));
  const frozenNet = deepFreeze(structuredClone(world.map.externalNetworks));
  const before = JSON.stringify([frozen, frozenNet]);
  const m = mount({ plans: frozen });
  m.live.networks = frozenNet;
  m.bridge.createDesign({ planIds: [world.A.planId] });
  m.bridge.setTrackCount(sectionRefOf(sectionOut(m.bridge, world.A, 0)), "double");
  m.bridge.placeJunction("turnout", [139.01, Y]);
  m.bridge.placeTerminal(world.a0);
  m.bridge.refresh();
  assert.equal(JSON.stringify([frozen, frozenNet]), before);
  m.bridge.setEnabled(false);
  assert.equal(panelOf(m.env, PANEL).hidden, true);
  const doc = JSON.stringify(m.bridge.document);
  m.bridge.setEnabled(true);
  m.bridge.setMode({ kind: "track-single" });
  m.bridge.setEnabled(false);
  clickAt(m.env, midOf(sectionOut(m.bridge, world.A, 1)));
  assert.equal(JSON.stringify(m.bridge.document), doc);
  m.bridge.destroy();
  assert.equal(panelOf(m.env, PANEL), undefined);
  assert.equal(m.env.canvas.listeners.pointerdown?.length ?? 0, 0);
});

test("the mount changes no engine state, imports no management or engine-state module, and says nothing about cost, time, size or a verdict", () => {
  const state = deepFreeze({ cash: 1_000_000, ledger: [{ id: 1 }], trains: [{ id: "train:7" }], clockMinute: 600 });
  const before = JSON.stringify(state);
  const m = withDesign();
  m.bridge.setTrackCount(sectionRefOf(sectionOut(m.bridge, world.A, 0)), "double");
  m.bridge.declareNoBlocks();
  assert.equal(JSON.stringify(state), before);
  assert.equal(texts(panelOf(m.env, PANEL)).some((t) => BANNED_TEXT.test(t)), false);
  const keys = new Set();
  const walk = (v) => { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { keys.add(k); walk(x); } };
  walk(m.bridge.output().document);
  assert.deepEqual([...keys].filter((k) => /cost|price|cash|fee|charge|time|delay|score|rank|verdict|throughput|headway|timetable|trainsPerHour|fleet/i.test(k)), []);
  for (const file of ["rail-capacity-ui", "rail-capacity-ui-tools", "map-mount-kit"]) {
    const text = fs.readFileSync(path.join(here, "..", "src", "map", `${file}.mjs`), "utf8");
    assert.ok(text.length < 40_000, file);
    for (const x of text.matchAll(/from "([^"]+)"/g)) assert.match(x[1], /^\.\/[a-z-]+\.mjs$/, `${file} imports ${x[1]}`);
    assert.equal(/from\s+["'][^"']*management/.test(text), false, file);
    assert.equal(/from\s+["'][^"']*(railway-disruptions|railway-traffic-control|rail-capacity-integration|rail-replacement-operations|scenario-runtime|trains|network|state|game|main)\.mjs/.test(text), false, file);
    assert.equal(/ledger|\.commit\(|\.settle\(|\.post\(|node:fs|Date\.now|Math\.random|state\.(trains|lines|trackSegments|railwayDisruptions)/.test(text.replace(/\/\/.*$/gm, "")), false, file);
  }
  assert.ok(find(panelOf(m.env, PANEL), (n) => n.tag === "button").length > 10);
});
