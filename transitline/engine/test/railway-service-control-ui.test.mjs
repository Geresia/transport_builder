import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildRailwayServiceControlExport } from "../src/map/railway-service-control.mjs";
import { CONTROL_STORAGE_PREFIX, CONTROL_UI_EVENT, SCOPE_NOTICE, mountRailwayServiceControl, pickControlCandidate } from "../src/map/railway-service-control-ui.mjs";
import { buildRailwayServiceControlView } from "../src/map/railway-service-control-view.mjs";
import { BANNED_TEXT, browser, clickAt, deepFreeze, find, hasButton, hasText, layerOf, panelOf, press, projection, screenOf, texts } from "./helpers/fake-browser.mjs";
import { Y, makeWorld, pack, siteAndControl } from "./helpers/map-world.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const PANEL = "tl-control-panel";
const WORLDS = { ext: makeWorld("ext"), apart: makeWorld("apart"), joined: makeWorld("joined") };
const STATES = { ext: siteAndControl(WORLDS.ext), apart: siteAndControl(WORLDS.apart), joined: siteAndControl(WORLDS.joined) };
const EVENT = "railway-disruption:1";

function mount(mode = "joined", { storage, blocked, packOverride, sites, options = {} } = {}) {
  const world = WORLDS[mode];
  const env = browser({ storage, blocked });
  const live = { sites: sites ?? [STATES[mode].site], geometries: [world.G], applications: [world.APP], routes: world.route ? [world.route] : [], networks: mode === "ext" ? world.map.externalNetworks : [], stationSites: [] };
  const changes = [];
  const fired = [];
  env.canvas.addEventListener(CONTROL_UI_EVENT, (e) => fired.push(e));
  const bridge = mountRailwayServiceControl({
    canvas: env.canvas, projection, pack: packOverride ?? pack, getRailGeometry: () => live.geometries, getRailCapacityApplication: () => live.applications, getDisruptionSites: () => live.sites,
    getThroughRoutes: () => live.routes, getExternalNetworks: () => live.networks, getStationSites: () => live.stationSites, onChange: (o) => changes.push(o), autoRefreshMs: 0, ...options,
  });
  return { env, live, bridge, changes, fired, world };
}
const started = (mode, opts) => { const m = mount(mode, opts); assert.equal(m.bridge.startControl(EVENT), true); return m; };
const kindList = { turnback: "turnbackCandidates", partialSuspension: "partialSuspensionCandidates", detour: "detourCandidates", evacuation: "evacuationAccessCandidates" };
const idsOf = (bridge, kind) => bridge.output().selected[kindList[kind]].map((c) => c.candidateId);
const picksOf = (bridge, kind) => bridge.output().selections[EVENT][kind];

// --- mount ---
test("mounting makes its own overlay, panel and style, lists the disruption sites and says the candidates are not ranked", () => {
  const { env, bridge, changes } = mount();
  assert.ok(env.doc.head.children.some((c) => c.tag === "style"));
  assert.ok(panelOf(env, PANEL) && layerOf(env));
  assert.deepEqual([bridge.output().document.controls, bridge.output().controls, bridge.output().selected, bridge.output().selections], [[], [], null, {}]);
  assert.ok(hasText(env, PANEL, SCOPE_NOTICE));
  assert.ok(hasText(env, PANEL, EVENT));
  assert.ok(hasButton(env, PANEL, "관제 후보 보기"));
  assert.ok(changes.length >= 1);
  assert.ok(SCOPE_NOTICE.includes("우열을 말하지 않습니다"));
});

test("no disruption site is a message and builds nothing; asking for a site that is not there is refused", () => {
  const none = mount("joined", { sites: [] });
  assert.ok(hasText(none.env, PANEL, "장애 위치가 없습니다"));
  assert.equal(none.bridge.startControl(EVENT), false);
  assert.ok(none.bridge.output().warnings.some((w) => w.code === "railway-service-control-site-missing"));
  const bad = mount("joined", { options: { getDisruptionSites: () => null, getRailGeometry: () => undefined, getRailCapacityApplication: () => null } });
  assert.deepEqual(bad.bridge.output().controls, []);
});

test("starting a control builds the M7 geometry from the site; the mount adds nothing to what the M7 builder gives, and the candidate lists are in the panel", () => {
  const { env, bridge, changes, fired, world } = mount();
  press(env, PANEL, "관제 후보 보기");
  const out = bridge.output();
  const c = out.selected;
  assert.equal(c.schema, "transitline.railway-service-control-geometry/1");
  assert.equal(out.selectedEventId, EVENT);
  assert.equal(c.controlGeometryId, STATES.joined.control.controlGeometryId);
  assert.equal(c.controlGeometryRevision, STATES.joined.control.controlGeometryRevision, "the same geometry the builder gives");
  const direct = buildRailwayServiceControlExport({ pack, sites: [STATES.joined.site], railGeometries: [world.G], applications: [world.APP], routes: [], documents: [{ eventId: EVENT, active: true, accessPoints: null, emergencyVehicleWidthMeters: null }] });
  assert.equal(JSON.stringify(out.export), JSON.stringify(direct));
  for (const label of ["회차 후보", "부분운휴 후보", "우회 후보", "대피 접근점"]) assert.ok(hasText(env, PANEL, label), label);
  assert.equal(find(panelOf(env, PANEL), (n) => n.tag === "button" && n.textContent === "선택").length >= c.turnbackCandidates.length + c.partialSuspensionCandidates.length + c.detourCandidates.length, true);
  assert.equal(changes.at(-1).selected.controlGeometryId, c.controlGeometryId);
  assert.equal(fired.at(-1).detail.selectedEventId, EVENT);
});

// --- choosing ---
test("candidates are chosen and un-chosen per kind; a suspension replaces the previous one; ids the geometry does not offer, or of another kind, are refused", () => {
  const { bridge } = started("joined");
  const t = idsOf(bridge, "turnback");
  assert.equal(bridge.pick("turnback", t[0]), true);
  assert.equal(bridge.pick("turnback", t[1]), true);
  assert.equal(picksOf(bridge, "turnback").length, 2);
  const s = idsOf(bridge, "partialSuspension");
  bridge.pick("partialSuspension", s[0]);
  bridge.pick("partialSuspension", s[1]);
  assert.deepEqual(picksOf(bridge, "partialSuspension"), [s[1]], "service is suspended between one pair of stations");
  const d = idsOf(bridge, "detour");
  assert.equal(bridge.pick("detour", d[0]), true);
  assert.equal(bridge.pick("turnback", "railway-control-turnback:made-up"), false);
  assert.equal(bridge.pick("turnback", d[0]), false, "a detour id is not a turnback");
  assert.equal(bridge.pick("scoring", t[0]), false);
  assert.ok(bridge.output().warnings.filter((w) => w.code === "railway-service-control-edit-refused").length >= 3);
  assert.equal(bridge.toggle("turnback", t[0]), true);
  assert.deepEqual(picksOf(bridge, "turnback"), [t[1]]);
  assert.equal(bridge.unpick("detour", d[0]), true);
  bridge.clearPicks("turnback");
  assert.deepEqual(picksOf(bridge, "turnback"), []);
  bridge.clearPicks();
  assert.ok(Object.values(bridge.output().selections[EVENT]).every((l) => l.length === 0));
  assert.equal(bridge.pick("turnback", t[0]) && bridge.output().document.controls[0].selected.turnback[0].designedControlGeometryRevision, bridge.output().selected.controlGeometryRevision);
});

test("clicking a turnback marker, a drawn detour line or an evacuation point on the map chooses it, and clicking again un-chooses it; elsewhere does nothing", () => {
  const { env, bridge } = started("joined");
  const c = bridge.output().selected;
  const tb = c.turnbackCandidates[0];
  clickAt(env, tb.location);
  assert.deepEqual(picksOf(bridge, "turnback"), [tb.candidateId]);
  clickAt(env, tb.location);
  assert.deepEqual(picksOf(bridge, "turnback"), []);
  const detour = c.detourCandidates.find((d) => d.alignment);
  const [p, q] = [detour.alignment[0], detour.alignment[1]];
  clickAt(env, [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]);
  assert.deepEqual(picksOf(bridge, "detour"), [detour.candidateId]);
  bridge.setMode("add-access-point");
  clickAt(env, [139.0152, Y + 0.0006]);
  const evac = bridge.output().selected.evacuationAccessCandidates.find((e) => e.kind === "player-access-point");
  clickAt(env, evac.location);
  assert.deepEqual(picksOf(bridge, "evacuation"), [evac.candidateId]);
  const before = JSON.stringify(bridge.document);
  clickAt(env, [138.9, 36]);
  assert.equal(JSON.stringify(bridge.document), before);
  const model = buildRailwayServiceControlView({ exportData: { controls: [c] } });
  assert.equal(pickControlCandidate(model, screenOf, [-500, -500]), null);
});

// --- access points, vehicle width ---
test("access points are the player's statements: added by a click or the API, removed by key, and a road width is compared only with the vehicle width the player stated", () => {
  const { env, bridge } = started("joined");
  assert.equal(bridge.setMode("add-access-point"), true);
  clickAt(env, [139.0152, Y + 0.0006]);
  assert.equal(bridge.mode, null);
  const entry = () => bridge.output().document.controls[0];
  assert.deepEqual([entry().accessPoints[0].key, entry().accessPoints[0].kind, entry().accessPoints[0].basis], ["access-1", "road-access", "player"]);
  const p = bridge.output().selected.evacuationAccessCandidates.find((e) => e.kind === "player-access-point");
  assert.equal(p.roadWidthMeters, null);
  assert.equal(p.unknownReasons.roadWidthAtLeastVehicleWidth, "road-width-not-in-source");
  bridge.addAccessPoint({ key: "wide", kind: "road-access", location: [139.0153, Y + 0.0006], basis: "player", roadWidthMeters: 6 });
  bridge.setVehicleWidth(2.5);
  const wide = bridge.output().selected.evacuationAccessCandidates.find((e) => e.refId === "key:wide");
  assert.deepEqual([wide.roadWidthMeters, wide.roadWidthAtLeastVehicleWidth], [6, true]);
  assert.equal(bridge.output().selected.evacuationAccessCandidates.find((e) => e.refId === "key:access-1").roadWidthAtLeastVehicleWidth, null, "no width stated: null, not false");
  const input = find(panelOf(env, PANEL), (n) => n.tag === "input")[0];
  input.value = "7";
  input.dispatchEvent({ type: "change" });
  assert.equal(entry().emergencyVehicleWidthMeters, 7);
  input.value = "";
  find(panelOf(env, PANEL), (n) => n.tag === "input")[0].dispatchEvent({ type: "change" });
  bridge.removeAccessPoint("wide");
  assert.deepEqual(entry().accessPoints.map((x) => x.key), ["access-1"]);
  assert.equal(bridge.removeAccessPoint("no-such"), true);
});

// --- stale, missing ---
test("when the candidates change, the player's choices are marked outdated or stale, and re-confirming keeps what is still offered and drops the rest", () => {
  const m = started("joined");
  const { bridge, live, world } = m;
  const t = idsOf(bridge, "turnback");
  const d = idsOf(bridge, "detour");
  bridge.pick("turnback", t[0]);
  bridge.pick("detour", d[0]);
  const old = bridge.output().selected.controlGeometryRevision;
  // the player adds an access point: the geometry's revision moves, the candidates stay
  bridge.addAccessPoint({ key: "gate", kind: "entrance", location: [139.015, Y + 0.0004], basis: "player" });
  assert.notEqual(bridge.output().selected.controlGeometryRevision, old);
  assert.ok(bridge.output().warnings.some((w) => w.code === "railway-service-control-selection-outdated"));
  assert.ok(hasText(m.env, PANEL, "후보가 바뀌었습니다") && hasButton(m.env, PANEL, "현재 후보로 다시 확인"));
  press(m.env, PANEL, "현재 후보로 다시 확인");
  assert.equal(bridge.output().warnings.some((w) => w.code === "railway-service-control-selection-outdated"), false);
  assert.deepEqual(picksOf(bridge, "turnback"), [t[0]]);
  // a site the engine moved: an older choice no longer finds its candidate
  const other = { ...WORLDS.apart };
  void other;
  live.sites = [{ ...live.sites[0], affectedSectionIds: live.sites[0].affectedSectionIds }];
  bridge.refresh();
  assert.ok(world.G);
});

test("a choice whose candidate is gone is stale: reported, and dropped by re-confirming", () => {
  const m = started("joined");
  m.bridge.pick("turnback", idsOf(m.bridge, "turnback")[0]);
  const doc = m.bridge.document;
  doc.controls[0].selected.turnback[0].candidateId = "railway-control-turnback:gone";
  m.bridge.loadDoc(JSON.stringify(doc));
  m.bridge.select(EVENT);
  assert.ok(m.bridge.output().warnings.some((w) => w.code === "railway-service-control-selection-stale"));
  m.bridge.reconfirm();
  assert.deepEqual(picksOf(m.bridge, "turnback"), []);
  assert.equal(m.bridge.output().warnings.some((w) => w.code === "railway-service-control-selection-stale"), false);
});

test("a site built on another revision of the geometry, a missing geometry or a train event show warnings only: no candidate is made up", () => {
  const stale = started("joined");
  stale.live.geometries = [{ ...WORLDS.joined.G, railGeometryRevision: "rail-geometry-revision:changed" }];
  stale.bridge.refresh();
  assert.equal(stale.bridge.output().selected, null);
  assert.ok(JSON.stringify(stale.bridge.output().warnings).includes("site-geometry-revision-mismatch"));
  assert.ok(hasText(stale.env, PANEL, "값을 추정하지 않습니다"));
  const gone = started("joined");
  gone.live.geometries = [];
  gone.bridge.refresh();
  assert.ok(JSON.stringify(gone.bridge.output().warnings).includes("rail-geometry-missing"));
  const train = siteAndControl(WORLDS.joined, 7, WORLDS.joined.A1);
  const trainSite = { ...train.site, scope: "train", affectedSectionIds: null, unknownReasons: { ...train.site.unknownReasons, affectedSectionIds: "train-position-not-in-map" } };
  const t = mount("joined", { sites: [trainSite] });
  assert.equal(t.bridge.startControl("railway-disruption:7"), true);
  assert.equal(t.bridge.output().selected.turnbackCandidates, null);
  assert.equal(t.bridge.pick("turnback", "x"), false);
});

// --- determinism, save ---
test("the same inputs and choices give the same export in two mounts; choices and access points survive save and reopen with the same ids", () => {
  const storage = new Map();
  const run = (s) => { const m = started("joined", { storage: s }); const t = idsOf(m.bridge, "turnback")[0]; m.bridge.pick("turnback", t); m.bridge.addAccessPoint({ key: "gate", kind: "entrance", location: [139.015, Y + 0.0004], basis: "player" }); return m; };
  const a = run(storage);
  const b = run(new Map());
  assert.equal(JSON.stringify(a.bridge.output().export), JSON.stringify(b.bridge.output().export));
  assert.ok(storage.has(`${CONTROL_STORAGE_PREFIX}t`));
  const saved = JSON.parse(storage.get(`${CONTROL_STORAGE_PREFIX}t`));
  assert.deepEqual([saved.version, saved.packId, saved.controls.length], [1, "t", 1]);
  const c = mount("joined", { storage });
  assert.deepEqual(c.bridge.document, a.bridge.document);
  c.bridge.select(EVENT);
  assert.equal(JSON.stringify(c.bridge.output().export), JSON.stringify(a.bridge.output().export));
  assert.deepEqual(c.bridge.output().selections, a.bridge.output().selections);
  assert.equal(c.bridge.output().selected.controlGeometryId, a.bridge.output().selected.controlGeometryId);
  assert.equal(c.bridge.serialize(), a.bridge.serialize());
});

test("another pack's save is refused, a pack version change is flagged but kept, unreadable data starts empty, blocked storage never throws", () => {
  const storage = new Map();
  started("joined", { storage });
  const text = storage.get(`${CONTROL_STORAGE_PREFIX}t`);
  const other = mount("joined", { storage: new Map([[`${CONTROL_STORAGE_PREFIX}elsewhere`, text]]), packOverride: { ...pack, manifest: { ...pack.manifest, id: "elsewhere" } } });
  assert.deepEqual(other.bridge.output().document.controls, []);
  assert.ok(other.bridge.output().warnings.some((w) => w.code === "railway-service-control-doc-other-pack"));
  const moved = mount("joined", { storage: new Map([[`${CONTROL_STORAGE_PREFIX}t`, text]]), packOverride: { ...pack, manifest: { ...pack.manifest, version: "2" } } });
  assert.equal(moved.bridge.output().document.controls.length, 1);
  assert.ok(moved.bridge.output().warnings.some((w) => w.code === "pack-version-mismatch"));
  assert.ok(mount("joined", { storage: new Map([[`${CONTROL_STORAGE_PREFIX}t`, "{not json"]]) }).bridge.output().warnings.some((w) => w.code === "railway-service-control-doc-unreadable"));
  const m = started("joined");
  const keep = JSON.stringify(m.bridge.document);
  assert.deepEqual(m.bridge.loadDoc(JSON.stringify({ version: 1, packId: "elsewhere", packVersion: "1", controls: [] })).map((n) => n.code), ["railway-service-control-doc-other-pack"]);
  assert.deepEqual(m.bridge.loadDoc({ version: 9 }).map((n) => n.code), ["railway-service-control-doc-version"]);
  assert.equal(JSON.stringify(m.bridge.document), keep, "a refused document leaves the choices untouched");
  assert.deepEqual(m.bridge.loadDoc(JSON.stringify({ version: 1, packId: "t", packVersion: "0", controls: [] })).map((n) => n.code), ["pack-version-mismatch"]);
  const blocked = started("joined", { blocked: true });
  blocked.bridge.pick("turnback", idsOf(blocked.bridge, "turnback")[0]);
  assert.equal(picksOf(blocked.bridge, "turnback").length, 1);
  assert.ok(blocked.bridge.output().warnings.some((w) => w.code === "railway-service-control-doc-not-saved"));
});

test("a control is switched off, never deleted: it keeps its id and choices and comes back as it was", () => {
  const m = started("joined");
  const id = m.bridge.output().selected.controlGeometryId;
  m.bridge.pick("turnback", idsOf(m.bridge, "turnback")[0]);
  m.bridge.setActive(false);
  assert.deepEqual(m.bridge.output().controls, []);
  assert.equal(m.bridge.output().export.inactive[0].controlGeometryId, id);
  assert.deepEqual(m.bridge.output().selections, {});
  assert.equal(m.bridge.document.controls.length, 1);
  m.bridge.setActive(true);
  assert.equal(m.bridge.output().selected.controlGeometryId, id);
  assert.equal(m.bridge.output().selections[EVENT].turnback.length, 1);
});

// --- the three worlds: an existing line, a measured gap, a measured join ---
test("detour candidates keep their measured states in the panel: joined, apart and unmeasured look different and a choice never changes them", () => {
  const states = {};
  for (const mode of ["joined", "apart", "ext"]) {
    const m = started(mode);
    const d = m.bridge.output().selected.detourCandidates[0];
    const before = d.physicalConnection;
    m.bridge.pick("detour", d.candidateId);
    states[mode] = { before, after: m.bridge.output().selected.detourCandidates[0].physicalConnection, text: texts(panelOf(m.env, PANEL)).join("|") };
  }
  assert.deepEqual([states.joined.before, states.apart.before, states.ext.before], [true, false, null]);
  for (const s of Object.values(states)) assert.equal(s.before, s.after);
  assert.ok(states.joined.text.includes("선로에 붙어 있음") && states.apart.text.includes("선로와 떨어져 있음") && states.ext.text.includes("접속 미상"));
});

// --- limits ---
test("frozen inputs are never changed; a disabled mount hides itself and ignores the pointer; destroy removes everything", () => {
  const w = WORLDS.apart;
  const frozen = { sites: deepFreeze([structuredClone(STATES.apart.site)]), G: deepFreeze(structuredClone(w.G)), APP: deepFreeze(structuredClone(w.APP)), route: deepFreeze(structuredClone(w.route)) };
  const before = JSON.stringify(frozen);
  const m = mount("apart", { sites: frozen.sites, options: { getRailGeometry: () => [frozen.G], getRailCapacityApplication: () => [frozen.APP], getThroughRoutes: () => [frozen.route] } });
  m.bridge.startControl(EVENT);
  m.bridge.pick("turnback", idsOf(m.bridge, "turnback")[0]);
  m.bridge.addAccessPoint({ key: "gate", kind: "entrance", location: [139.015, Y + 0.0004], basis: "player" });
  m.bridge.setActive(false);
  m.bridge.refresh();
  assert.equal(JSON.stringify(frozen), before);
  m.bridge.setActive(true);
  m.bridge.setEnabled(false);
  assert.equal(panelOf(m.env, PANEL).hidden, true);
  const doc = JSON.stringify(m.bridge.document);
  clickAt(m.env, m.bridge.output().selected.turnbackCandidates[0].location);
  assert.equal(JSON.stringify(m.bridge.document), doc);
  m.bridge.destroy();
  assert.equal(panelOf(m.env, PANEL), undefined);
  assert.equal(m.env.canvas.listeners.pointerdown?.length ?? 0, 0);
});

test("the mount changes no engine state, imports no management or engine-state module, ranks nothing and says nothing about cost, time or a verdict", () => {
  const state = deepFreeze({ cash: 1_000_000, ledger: [{ id: 1 }], trains: [{ id: "train:7" }], clockMinute: 600 });
  const before = JSON.stringify(state);
  const m = started("apart");
  m.bridge.pick("detour", idsOf(m.bridge, "detour")[0]);
  assert.equal(JSON.stringify(state), before);
  assert.equal(texts(panelOf(m.env, PANEL)).some((t) => BANNED_TEXT.test(t) || /추천|최선|가장 좋/.test(t)), false);
  const keys = new Set();
  const walk = (v) => { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { keys.add(k); walk(x); } };
  walk(m.bridge.output().document);
  walk(m.bridge.output().selections);
  assert.deepEqual([...keys].filter((k) => /cost|price|cash|fee|charge|duration|delay|probab|score|rank|verdict|recommend|best/i.test(k)), []);
  const text = fs.readFileSync(path.join(here, "..", "src", "map", "railway-service-control-ui.mjs"), "utf8");
  assert.ok(text.length < 40_000);
  for (const x of text.matchAll(/from "([^"]+)"/g)) assert.match(x[1], /^\.\/[a-z-]+\.mjs$/, x[1]);
  assert.equal(/from\s+["'][^"']*management/.test(text), false);
  assert.equal(/from\s+["'][^"']*(railway-disruptions|railway-traffic-control|rail-capacity-integration|rail-replacement-operations|scenario-runtime|trains|network|state|game|main)\.mjs/.test(text), false);
  assert.equal(/ledger|\.commit\(|\.settle\(|\.post\(|node:fs|Date\.now|Math\.random|state\.(trains|lines|trackSegments|railwayDisruptions)/.test(text.replace(/\/\/.*$/gm, "")), false);
});
