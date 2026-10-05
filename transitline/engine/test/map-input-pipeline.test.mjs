import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PIPELINE_DOC_SCHEMA, PIPELINE_STAGES, PIPELINE_UI_EVENT, mountMapInputPipeline } from "../src/map/map-input-pipeline.mjs";
import { BANNED_TEXT, browser, deepFreeze, projection } from "./helpers/fake-browser.mjs";
import { applicationOf, eventOf, makeWorld, pack, sectionOf, trackId } from "./helpers/map-world.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const world = makeWorld("joined");
const EVENT = "railway-disruption:1";
const PANELS = ["tl-rail-panel", "tl-disruption-panel", "tl-control-panel", "tl-detour-panel"];

function mount({ storage, blocked, packOverride, options = {}, withApplication = true } = {}) {
  const env = browser({ storage, blocked });
  const live = { events: [], application: null, withApplication };
  const changes = [];
  const fired = [];
  env.canvas.addEventListener(PIPELINE_UI_EVENT, (e) => fired.push(e));
  const pipeline = mountMapInputPipeline({
    canvas: env.canvas, projection, pack: packOverride ?? pack, getPlans: () => world.plans, getRoutes: () => [], getExternalNetworks: () => world.map.externalNetworks,
    getExternalCatalog: () => null, getStationSites: () => [], getRailCapacityApplication: () => (live.withApplication && live.application ? [live.application] : []),
    getDisruptionEvents: () => live.events, onChange: (o) => changes.push(o), autoRefreshMs: 0, ...options,
  });
  return { env, live, pipeline, changes, fired };
}
// design the rails on the plans, give the engine's application and one disruption event on the section a1-a2
function drive(m) {
  const key = m.pipeline.stages.railCapacity.createDesign({ planIds: [world.A.planId, world.B.planId, world.C.planId] });
  assert.ok(key);
  const g = m.pipeline.output().railGeometries[0];
  m.live.application = applicationOf(g);
  m.live.events = [eventOf(EVENT, trackId(g, sectionOf(g, world.A, 1)))];
  m.pipeline.refresh();
  return g;
}
const full = (m) => {
  drive(m);
  assert.equal(m.pipeline.stages.disruptionSite.startSite(EVENT), true);
  assert.equal(m.pipeline.stages.serviceControl.startControl(EVENT), true);
  const control = m.pipeline.output().serviceControls.controls[0];
  m.pipeline.stages.serviceControl.pick("turnback", control.turnbackCandidates[0].candidateId);
  return m;
};

test("mounting brings up the four editors, each with its own overlay panel and style, and starts with nothing made up", () => {
  const { env, pipeline, changes, fired } = mount();
  for (const cls of PANELS) assert.ok(env.doc.body.children.some((c) => c.className === cls), cls);
  assert.equal(env.doc.head.children.filter((c) => c.tag === "style").length, 5, "four editors and the layout that stacks their panels");
  const out = pipeline.output();
  assert.deepEqual([out.railGeometries, out.applications.needed, out.applications.missing, out.documents.railCapacity.designs], [[], [], [], []]);
  assert.deepEqual(Object.keys(pipeline.stages), PIPELINE_STAGES);
  assert.ok(out.railGeometry && out.disruptionSites && out.serviceControls && out.detour, "each stage hands over an (empty) export");
  assert.equal(changes.length, 1);
  assert.equal(fired.length, 1);
  assert.equal(fired[0].detail.railGeometries.length, 0);
});

test("a design made in the rail editor flows to the later stages through getters, and the host gets one onChange for the whole burst", () => {
  const m = mount();
  const before = m.changes.length;
  m.pipeline.stages.railCapacity.createDesign({ planIds: [world.A.planId, world.B.planId, world.C.planId] });
  assert.equal(m.changes.length - before, 1, "a stage and the stages after it follow in one onChange");
  assert.equal(m.fired.length, m.changes.length);
  const out = m.pipeline.output();
  assert.equal(out.railGeometries.length, 1);
  assert.equal(out.railGeometry.designs.length, 1);
  assert.equal(out.railGeometry.designs[0].railGeometryId, out.railGeometries[0].railGeometryId);
  assert.equal(out.selected.railCapacity, "rail-1");
});

test("the application slot lists what the engine still has to supply and clears once it matches the geometry revision", () => {
  const m = mount();
  drive(m);
  const g = m.pipeline.output().railGeometries[0];
  assert.deepEqual(m.pipeline.output().applications.needed, [{ railGeometryId: g.railGeometryId, railGeometryRevision: g.railGeometryRevision, sectionIds: g.sections.map((s) => s.sectionId) }]);
  assert.deepEqual(m.pipeline.output().applications.missing, []);
  m.live.withApplication = false;
  m.pipeline.refresh();
  assert.deepEqual(m.pipeline.output().applications.missing, [g.railGeometryId]);
  assert.deepEqual(m.pipeline.output().applications.supplied, []);
  m.live.application = { ...m.live.application, railGeometryRevision: "rail-geometry-revision:old" };
  m.live.withApplication = true;
  m.pipeline.refresh();
  assert.deepEqual(m.pipeline.output().applications.missing, [g.railGeometryId], "an application for another revision does not count");
});

test("with no application, an engine event is listed but never placed: the map does not guess which section it is", () => {
  const m = mount({ withApplication: false });
  drive(m);
  assert.equal(m.pipeline.stages.disruptionSite.startSite(EVENT), true);
  const site = m.pipeline.output().disruptionSites.sites[0];
  assert.deepEqual([site.railCapacitySectionId, site.affectedSectionIds, site.sectionLinkBasis], [null, null, null]);
  assert.equal(site.unknownReasons.affectedSectionIds, "no-section-link");
  assert.equal(m.pipeline.output().applications.missing.length, 1);
});

test("the whole flow: design, disruption site, service control candidate, and the detour stage sees the control's candidates", () => {
  const m = full(mount());
  const out = m.pipeline.output();
  assert.equal(out.disruptionSites.sites.length, 1);
  assert.equal(out.disruptionSites.sites[0].eventId, EVENT);
  assert.equal(out.serviceControls.controls.length, 1);
  assert.equal(out.serviceControls.controls[0].disruptionSiteRevision, out.disruptionSites.sites[0].siteRevision);
  assert.deepEqual(out.documents.serviceControl.controls[0].selected.turnback.length, 1);
  assert.deepEqual([out.selected.disruptionSite, out.selected.serviceControl], [EVENT, EVENT]);
  const detourSeen = m.pipeline.stages.detour.output();
  assert.deepEqual(detourSeen.export.detours.length, 0, "the detour stage makes no plan until the player picks one");
  const candidate = out.serviceControls.controls[0].detourCandidates[0];
  assert.ok(candidate, "joined world: the loop through plan c is a detour candidate");
  assert.equal(m.pipeline.stages.detour.choose(EVENT, candidate.candidateId), true);
  assert.equal(m.pipeline.output().documents.detour.plans.length, 1);
  assert.equal(m.pipeline.output().detour.detours.length, 1);
});

test("removing the design makes the later stages report the missing geometry in warnings, tagged by stage, and keeps their own documents", () => {
  const m = full(mount());
  const docs = JSON.stringify([m.pipeline.output().documents.disruptionSite, m.pipeline.output().documents.serviceControl]);
  m.pipeline.stages.railCapacity.removeDesign("rail-1");
  const out = m.pipeline.output();
  assert.deepEqual(out.railGeometries, []);
  assert.equal(out.serviceControls.controls.length, 0);
  assert.ok(out.warnings.some((w) => w.stage === "disruptionSite"), JSON.stringify(out.warnings.map((w) => [w.stage, w.code])));
  assert.equal(JSON.stringify([out.documents.disruptionSite, out.documents.serviceControl]), docs, "the player's drawn site and choices are not lost");
});

test("the integrated save carries the four documents and a fresh mount restores them to identical exports", () => {
  const a = full(mount());
  const text = a.pipeline.serialize();
  const saved = JSON.parse(text);
  assert.deepEqual([saved.schema, saved.version, saved.packId, Object.keys(saved.stages)], [PIPELINE_DOC_SCHEMA, 1, "t", PIPELINE_STAGES]);
  const b = mount();
  b.live.events = a.live.events;
  b.live.application = a.live.application;
  const notes = b.pipeline.loadDoc(text);
  assert.deepEqual(notes, []);
  b.pipeline.refresh();
  assert.equal(JSON.stringify(b.pipeline.output().documents), JSON.stringify(a.pipeline.output().documents));
  assert.equal(JSON.stringify(b.pipeline.output().railGeometry), JSON.stringify(a.pipeline.output().railGeometry));
  assert.equal(b.pipeline.serialize(), text);
  b.pipeline.stages.disruptionSite.select(EVENT);
  b.pipeline.stages.serviceControl.select(EVENT);
  assert.equal(JSON.stringify(b.pipeline.output().disruptionSites), JSON.stringify(a.pipeline.output().disruptionSites));
  assert.equal(JSON.stringify(b.pipeline.output().serviceControls), JSON.stringify(a.pipeline.output().serviceControls));
});

test("the same inputs and player steps give the same bytes in two separate mounts", () => {
  const a = full(mount());
  const b = full(mount());
  assert.equal(JSON.stringify(a.pipeline.output()), JSON.stringify(b.pipeline.output()));
  assert.equal(a.pipeline.serialize(), b.pipeline.serialize());
});

test("each stage keeps saving to its own localStorage key, so the editors also work on their own", () => {
  const storage = new Map();
  const a = full(mount({ storage }));
  a.pipeline.save();
  const keys = [...storage.keys()].sort();
  assert.equal(keys.length, 4, keys.join());
  const b = mount({ storage });
  assert.equal(JSON.stringify(b.pipeline.output().documents), JSON.stringify(a.pipeline.output().documents));
});

test("an unreadable, wrong-schema, other-version or other-pack envelope is refused whole and leaves every stage untouched", () => {
  const a = full(mount());
  const text = a.pipeline.serialize();
  const keep = JSON.stringify(a.pipeline.output().documents);
  const edit = (patch) => JSON.stringify({ ...JSON.parse(text), ...patch });
  assert.deepEqual(a.pipeline.loadDoc("{not json").map((n) => n.code), ["map-input-pipeline-doc-unreadable"]);
  assert.deepEqual(a.pipeline.loadDoc({ version: 1 }).map((n) => n.code), ["map-input-pipeline-doc-unreadable"]);
  assert.deepEqual(a.pipeline.loadDoc(edit({ version: 9 })).map((n) => n.code), ["map-input-pipeline-doc-version"]);
  assert.deepEqual(a.pipeline.loadDoc(edit({ packId: "elsewhere" })).map((n) => n.code), ["map-input-pipeline-doc-other-pack"]);
  assert.equal(JSON.stringify(a.pipeline.output().documents), keep);
  assert.ok(a.pipeline.output().warnings.some((w) => w.stage === "pipeline" && w.code === "map-input-pipeline-doc-other-pack"));
  assert.deepEqual(a.pipeline.loadDoc(null), []);
});

test("a pack version change is flagged but the documents load; a stage the envelope lacks is left as it is", () => {
  const a = full(mount());
  const saved = JSON.parse(a.pipeline.serialize());
  const b = mount();
  b.live.events = a.live.events;
  b.live.application = a.live.application;
  b.pipeline.loadDoc(JSON.stringify({ ...saved, stages: { railCapacity: saved.stages.railCapacity } }));
  assert.equal(b.pipeline.output().documents.railCapacity.designs.length, 1);
  assert.deepEqual(b.pipeline.output().documents.disruptionSite.sites, []);
  const c = mount();
  const notes = c.pipeline.loadDoc(JSON.stringify({ ...saved, packVersion: "0" }));
  assert.deepEqual(notes.map((n) => n.code), ["pack-version-mismatch"]);
  assert.equal(c.pipeline.output().documents.railCapacity.designs.length, 1);
});

test("a stage's own refusal (a document of another pack inside the envelope) is reported with its stage and the rest still loads", () => {
  const a = full(mount());
  const saved = JSON.parse(a.pipeline.serialize());
  saved.stages.disruptionSite.packId = "elsewhere";
  const b = mount();
  const notes = b.pipeline.loadDoc(JSON.stringify(saved));
  assert.ok(notes.some((n) => n.stage === "disruptionSite" && /other-pack/.test(n.code)), JSON.stringify(notes));
  assert.equal(b.pipeline.output().documents.railCapacity.designs.length, 1);
  assert.deepEqual(b.pipeline.output().documents.disruptionSite.sites, []);
});

test("blocked storage never throws: the pipeline works in memory and still serializes", () => {
  const m = full(mount({ blocked: true }));
  m.pipeline.save();
  assert.equal(m.pipeline.output().documents.railCapacity.designs.length, 1);
  assert.ok(JSON.parse(m.pipeline.serialize()).stages.serviceControl.controls.length === 1);
});

test("the host's getters may return nothing or odd shapes without breaking the pipeline", () => {
  const env = browser();
  const pipeline = mountMapInputPipeline({ canvas: env.canvas, projection, pack, getPlans: () => null, getRoutes: () => undefined, getExternalNetworks: () => ({ networks: [] }), autoRefreshMs: 0 });
  assert.deepEqual(pipeline.output().railGeometries, []);
  pipeline.refresh();
  assert.equal(pipeline.output().applications.missing.length, 0);
});

test("frozen inputs are never changed", () => {
  const plans = deepFreeze(structuredClone(world.plans));
  const events = deepFreeze([eventOf(EVENT, "track-segment:1")]);
  const application = deepFreeze({ ...applicationOf(world.G) });
  const env = browser();
  const pipeline = mountMapInputPipeline({ canvas: env.canvas, projection, pack, getPlans: () => plans, getRoutes: () => [], getExternalNetworks: () => world.map.externalNetworks, getRailCapacityApplication: () => application, getDisruptionEvents: () => events, autoRefreshMs: 0 });
  const before = JSON.stringify([plans, events, application]);
  pipeline.stages.railCapacity.createDesign({ planIds: [world.A.planId] });
  pipeline.stages.disruptionSite.startSite(EVENT);
  pipeline.refresh();
  assert.equal(JSON.stringify([plans, events, application]), before);
});

test("setEnabled hides and shows all four panels; destroy removes them and the pointer listeners", () => {
  const m = full(mount());
  m.pipeline.setEnabled(false);
  for (const cls of PANELS) assert.equal(m.env.doc.body.children.find((c) => c.className === cls).hidden, true, cls);
  m.pipeline.setEnabled(true);
  for (const cls of PANELS) assert.equal(m.env.doc.body.children.find((c) => c.className === cls).hidden, false, cls);
  m.pipeline.destroy();
  for (const cls of PANELS) assert.equal(m.env.doc.body.children.find((c) => c.className === cls), undefined, cls);
  assert.equal(m.env.canvas.listeners.pointerdown?.length ?? 0, 0);
});

test("the pipeline decides nothing: no cost, time, verdict or score in its output, none of the engine's state touched, and the module stays map-only", () => {
  const state = deepFreeze({ cash: 1_000_000, ledger: [{ id: 1 }], trains: [{ id: "train:7" }] });
  const before = JSON.stringify(state);
  const m = full(mount());
  assert.equal(JSON.stringify(state), before);
  const keys = new Set();
  const walk = (v) => { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { keys.add(k); walk(x); } };
  walk(m.pipeline.output().documents);
  assert.deepEqual([...keys].filter((k) => /cost|price|cash|fee|charge|duration|delay|probab|score|rank|verdict|recommend|best/i.test(k)), []);
  const text = fs.readFileSync(path.join(here, "..", "src", "map", "map-input-pipeline.mjs"), "utf8");
  assert.ok(text.length < 40_000);
  for (const x of text.matchAll(/from "([^"]+)"/g)) assert.match(x[1], /^\.\/[a-z-]+\.mjs$/, x[1]);
  assert.equal(/from\s+["'][^"']*management/.test(text), false);
  assert.equal(/from\s+["'][^"']*(railway-disruptions|railway-traffic-control|rail-capacity-integration|rail-replacement-operations|scenario-runtime|trains|network|state|game|main)\.mjs/.test(text), false);
  assert.equal(/ledger|\.commit\(|\.settle\(|\.post\(|node:fs|Date\.now|Math\.random|state\.(trains|lines|trackSegments|railwayDisruptions)/.test(text.replace(/\/\/.*$/gm, "")), false);
  assert.equal(BANNED_TEXT.test(PIPELINE_DOC_SCHEMA), false);
});
