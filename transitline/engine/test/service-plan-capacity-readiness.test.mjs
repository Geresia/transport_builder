import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ASSUMPTION_BASIS, CAPACITY_READINESS_SCHEMA, MAP_FACT_BASIS, buildCapacityReadinessView, editorRequestOf, listState, modeState } from "../src/service-plan-capacity-readiness.mjs";
import { buildAssumptionExport } from "../src/service-plan-assumptions.mjs";
import { newAssumptionsDoc, setAssumptions } from "../src/service-plan-assumptions-editor.mjs";
import { READINESS_CASES, buildReadinessWorld } from "../../scripts/lib/capacity-readiness-world.mjs";
import { prescreenServicePlan } from "../src/service-plan-prescreening.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const deepFreeze = (o) => { if (o && typeof o === "object") { Object.values(o).forEach(deepFreeze); Object.freeze(o); } return o; };
const json = (v) => JSON.stringify(v);
const viewOf = (w, extra = {}) => buildCapacityReadinessView({ servicePlans: w.servicePlans, railGeometries: w.geometries, applications: w.applications, ...extra });
const planOf = (w, extra) => viewOf(w, extra).plans[0];
const checks = (p) => p.gaps.map((g) => g.checkId);

test("a real applied rail capacity geometry: the map states some facts and leaves others unknown, and each is shown as such", () => {
  const w = buildReadinessWorld("partial");
  const view = viewOf(w);
  assert.equal(view.schema, CAPACITY_READINESS_SCHEMA);
  assert.equal(view.basis, MAP_FACT_BASIS);
  const p = view.plans[0];
  assert.equal(p.application.state, "current");
  assert.equal(p.application.basis, MAP_FACT_BASIS);
  assert.equal(p.counts.sections, 2);
  assert.deepEqual(p.sections.map((s) => s.mapping), ["mapped", "mapped"]);
  assert.deepEqual(p.sections.map((s) => s.trackSegmentId), ["ab", "bc"]);
  // the first section's track count was never stated, the second one was stated single
  assert.deepEqual(p.sections.map((s) => s.directionMode.application), [{ state: "unknown", value: null }, { state: "stated", value: "single" }]);
  assert.deepEqual(p.sections.map((s) => s.directionMode.geometry), [{ state: "unknown", value: null }, { state: "stated", value: "single" }]);
  // blocks were drawn (3 and 1), junctions were never stated: null stays unknown, it is not an empty list
  assert.deepEqual(p.sections.map((s) => [s.blockIds.application.state, s.blockIds.application.count]), [["listed", 3], ["listed", 1]]);
  assert.deepEqual(p.sections.map((s) => [s.junctionResourceIds.application.state, s.junctionResourceIds.application.count, s.junctionResourceIds.application.ids]), [["unknown", null, null], ["unknown", null, null]]);
  assert.deepEqual(checks(p), ["direction-mode", "junction-resource", "terminal-resource"]);
  assert.deepEqual(p.gaps.find((g) => g.checkId === "direction-mode").sectionIds, [p.sections[0].sectionId]);
  assert.deepEqual(p.gaps.map((g) => g.kind), ["capacity-map", "capacity-map", "service-plan"]);
});

test("the terminal and the turnback the plan chose are read from the application, state by state", () => {
  const p = planOf(buildReadinessWorld("partial"));
  assert.equal(p.turnbacks.state, "listed");
  const [first, second] = p.turnbacks.items;
  assert.deepEqual([first.terminalState, first.turnbackState, first.attached, first.candidateCount, first.attachedCandidateCount], ["in-application", "attached", true, 1, 1]);
  assert.deepEqual([second.terminalState, second.turnbackState, second.attached, second.candidateCount], ["not-selected", "terminal-not-selected", null, null]);
  assert.deepEqual(p.gaps.filter((g) => g.checkId === "terminal-resource").map((g) => [g.reason, g.kind]), [["terminal-resource-not-selected", "service-plan"]]);
});

test("a plan on a map with nothing stated: every missing fact is a gap, null is never turned into none, and the places to fill are named", () => {
  const p = planOf(buildReadinessWorld("bare"));
  assert.ok(p.sections.every((s) => s.directionMode.application.state === "unknown" && s.blockIds.application.state === "unknown" && s.junctionResourceIds.application.state === "unknown"));
  assert.ok(p.sections.every((s) => s.blockIds.application.count === null && s.blockIds.application.ids === null));
  assert.deepEqual(new Set(checks(p)), new Set(["direction-mode", "block-data", "junction-resource", "terminal-resource"]));
  assert.equal(p.geometry.terminals.state, "unknown");
  assert.equal(p.geometry.blocks.state, "unknown");
  assert.ok(p.gaps.every((g) => typeof g.label === "string" && g.label.length > 0));
  assert.match(p.gaps.find((g) => g.checkId === "direction-mode").label, /단·복선 지정/);
  assert.match(p.gaps.find((g) => g.checkId === "block-data").label, /경계 없음으로 선언/);
  // no terminal was chosen, so the gap is the player's choice, not a missing terminal on the map
  assert.equal(p.gaps.some((g) => g.checkId === "terminal-resource" && g.reason === "terminal-data-missing"), false);
});

test("the capacity application is current, stale, none, not tied to a line or of another map: each is told apart", () => {
  const states = Object.fromEntries(READINESS_CASES.map((c) => [c, planOf(buildReadinessWorld(c)).application.state]));
  assert.deepEqual(states, { partial: "current", bare: "current", stale: "stale", "no-application": "none", "no-line": "line-not-stated" });
  const stale = planOf(buildReadinessWorld("stale"));
  assert.equal(stale.gaps[0].checkId, "rail-capacity-application");
  assert.match(stale.gaps[0].message, /낡음/);
  assert.equal(stale.gaps[0].kind, "capacity-map");
  assert.notEqual(stale.application.applicationRailGeometryRevision, stale.railGeometryRevision);
  assert.ok(stale.sections[0].directionMode.application, "a stale application's facts are still shown (and flagged as stale)");
  const none = planOf(buildReadinessWorld("no-application"));
  assert.deepEqual(checks(none), ["rail-capacity-application"]);
  assert.ok(none.sections.every((s) => s.mapping === "application-unavailable" && s.directionMode.application === null));
  const noLine = planOf(buildReadinessWorld("no-line"));
  assert.deepEqual([noLine.operationalLineId, noLine.gaps[0].kind], [null, "service-plan"]);
  // an application of the same line but another map
  const w = buildReadinessWorld("partial");
  const other = buildCapacityReadinessView({ servicePlans: w.servicePlans, applications: [{ ...w.applications[0], railGeometryId: "rail-geometry:other" }] });
  assert.equal(other.plans[0].application.state, "other-geometry");
  // the host gave no application list: the plan's own state is all that is known, and the panel says so
  const blind = buildCapacityReadinessView({ servicePlans: w.servicePlans }).plans[0];
  assert.deepEqual([blind.application.state, blind.application.detailsAvailable], ["current", false]);
  assert.ok(blind.sections.every((s) => s.mapping === "application-unavailable"));
  assert.equal(buildCapacityReadinessView({ servicePlans: buildReadinessWorld("no-application").servicePlans }).plans[0].application.state, "unknown");
});

test("a plan section that is not in the application is told apart from one the application does not state", () => {
  const w = buildReadinessWorld("partial");
  const app = structuredClone(w.applications[0]);
  app.sections = app.sections.filter((s) => s.trackSegmentId !== "bc");
  const p = buildCapacityReadinessView({ servicePlans: w.servicePlans, applications: [app] }).plans[0];
  assert.deepEqual(p.sections.map((s) => s.mapping), ["mapped", "not-in-application"]);
  assert.equal(p.sections[1].trackSegmentId, null);
  assert.deepEqual(p.gaps.find((g) => g.checkId === "section-not-in-application").sectionIds, [p.sections[1].sectionId]);
  assert.equal(p.counts.notInApplication, 1);
  // a section the application does not map is not also reported as missing a track count: that would be a second, wrong gap
  assert.deepEqual(p.gaps.find((g) => g.checkId === "direction-mode").sectionIds, [p.sections[0].sectionId]);
  // the plan holds a track id the application does not agree with
  const wrong = structuredClone(w.applications[0]);
  wrong.sections.find((s) => s.trackSegmentId === "ab").trackSegmentId = "zz";
  const d = buildCapacityReadinessView({ servicePlans: w.servicePlans, applications: [wrong] }).plans[0];
  assert.deepEqual([d.sections[0].trackSegmentIdDiffers, d.sections[1].trackSegmentIdDiffers], [true, false]);
});

test("[] declared by the map, 0 and a list are different facts: a declared 'none' is not a gap and never reads as a count", () => {
  const w = buildReadinessWorld("partial");
  const app = structuredClone(w.applications[0]);
  app.sections[0].directionMode = "double";
  app.sections[0].blockIds = [];
  app.sections[0].junctionResourceIds = [];
  app.sections[1].junctionResourceIds = ["rail-junction:one"];
  const p = buildCapacityReadinessView({ servicePlans: w.servicePlans, applications: [app] }).plans[0];
  assert.deepEqual(p.sections[0].blockIds.application, { state: "declared-none", count: 0, ids: [] });
  assert.deepEqual(p.sections[0].junctionResourceIds.application, { state: "declared-none", count: 0, ids: [] });
  assert.deepEqual(p.sections[1].junctionResourceIds.application, { state: "listed", count: 1, ids: ["rail-junction:one"] });
  assert.equal(p.sections[0].directionMode.application.value, "double");
  assert.equal(p.gaps.some((g) => ["direction-mode", "block-data", "junction-resource"].includes(g.checkId)), false);
  assert.notDeepEqual(listState([]), listState(null));
  assert.deepEqual(listState(undefined), listState(null));
  for (const odd of ["both", 0, false, "", undefined]) assert.deepEqual(modeState(odd), { state: "unknown", value: null });
  assert.equal(p.counts.directionModeStated, 2);
});

test("terminal and turnback facts: terminal data missing, a terminal that is not there, a turnback not attached or not verified", () => {
  const w = buildReadinessWorld("partial");
  const variant = (edit) => { const app = structuredClone(w.applications[0]); edit(app); return buildCapacityReadinessView({ servicePlans: w.servicePlans, applications: [app] }).plans[0]; };
  const noTerminals = variant((a) => { a.terminals = null; });
  assert.equal(noTerminals.turnbacks.items[0].terminalState, "terminal-data-unknown");
  assert.ok(noTerminals.gaps.some((g) => g.reason === "terminal-data-missing" && g.kind === "capacity-map"));
  const absent = variant((a) => { a.terminals = a.terminals.filter((t) => t.terminalResourceId !== w.servicePlans[0].turnbacks[0].terminalResourceId); });
  assert.equal(absent.turnbacks.items[0].terminalState, "not-in-application");
  assert.ok(absent.gaps.some((g) => g.reason === "terminal-resource-absent"));
  const apart = variant((a) => { for (const t of a.terminals) for (const c of t.turnbackCandidates ?? []) c.attached = false; });
  assert.deepEqual([apart.turnbacks.items[0].turnbackState, apart.turnbacks.items[0].attached], ["not-attached", false]);
  assert.equal(apart.gaps.some((g) => g.checkId === "turnback-connection"), false); // measured apart is a stated fact, not a missing one
  const unverified = variant((a) => { for (const t of a.terminals) for (const c of t.turnbackCandidates ?? []) c.attached = null; });
  assert.deepEqual([unverified.turnbacks.items[0].turnbackState, unverified.turnbacks.items[0].attached], ["unverified", null]);
  assert.ok(unverified.gaps.some((g) => g.checkId === "turnback-connection" && g.reason === "unverified"));
  const noCandidates = variant((a) => { for (const t of a.terminals) t.turnbackCandidates = null; });
  assert.equal(noCandidates.turnbacks.items[0].turnbackState, "turnback-data-unknown");
  const declaredNone = buildCapacityReadinessView({ servicePlans: w.servicePlans.map((s) => ({ ...s, turnbacks: [] })), applications: w.applications }).plans[0];
  assert.deepEqual([declaredNone.turnbacks.state, declaredNone.turnbacks.items], ["declared-none", []]);
  const notStated = buildCapacityReadinessView({ servicePlans: w.servicePlans.map((s) => ({ ...s, turnbacks: null })), applications: w.applications }).plans[0];
  assert.equal(notStated.turnbacks.state, "not-stated");
  assert.ok(notStated.gaps.some((g) => g.field === "turnbacks"));
  assert.equal(declaredNone.gaps.some((g) => g.field === "turnbacks"), false);
});

test("the player's assumptions are a separate block labelled as assumptions; they never fill or change a map fact", () => {
  const w = buildReadinessWorld("partial");
  const doc = newAssumptionsDoc(w.pack.manifest.id, "1");
  setAssumptions(doc, w.servicePlans[0], { directionMode: "double", minimumHeadwayMinutes: 3, capacityTrainsPerHour: 20 });
  const assumptions = buildAssumptionExport({ pack: w.pack, doc, servicePlans: w.servicePlans });
  const withA = planOf(w, { assumptions });
  const without = planOf(w);
  assert.equal(withA.assumptions.basis, ASSUMPTION_BASIS);
  assert.equal(withA.assumptions.present, true);
  assert.deepEqual([...withA.assumptions.statedFields].sort(), ["capacityTrainsPerHour", "directionMode", "minimumHeadwayMinutes"]);
  assert.deepEqual(withA.assumptions.compare[0].mapFact, { basis: MAP_FACT_BASIS, values: ["single"], allSectionsStated: false });
  assert.deepEqual(withA.assumptions.compare[0].assumption, { basis: ASSUMPTION_BASIS, value: "double" });
  assert.equal(withA.assumptions.compare[0].differs, true);
  assert.equal(withA.assumptions.capacityTrainsPerHour, 20);
  assert.equal(withA.assumptions.minimumHeadwayMinutes, 3);
  // the map's own facts and the gaps are exactly what they were without the assumptions
  assert.equal(json(withA.sections), json(without.sections));
  assert.equal(json(withA.gaps), json(without.gaps));
  assert.ok(withA.gaps.some((g) => g.checkId === "direction-mode"));
  assert.equal(without.assumptions.supplied, false);
  const none = planOf(w, { assumptions: buildAssumptionExport({ pack: w.pack, doc: newAssumptionsDoc(w.pack.manifest.id, "1"), servicePlans: w.servicePlans }) });
  assert.deepEqual([none.assumptions.supplied, none.assumptions.present], [true, false]);
  // an assumption made on an older plan revision is shown as stale
  const stale = buildAssumptionExport({ pack: w.pack, doc, servicePlans: [{ ...w.servicePlans[0], servicePlanRevision: "service-plan-revision:later" }] });
  assert.deepEqual([planOf(w, { assumptions: stale }).assumptions.state, planOf(w, { assumptions: stale }).assumptions.usable], ["stale", false]);
});

test("the gaps are the same track facts the pre-screening reads: where it finds the map unknown, this view lists a gap, and where it finds them stated, none", () => {
  const w = buildReadinessWorld("partial");
  const p = planOf(w);
  const { a0, a1, a2 } = w.base.stations;
  const state = { lines: [{ id: w.lineId, managementServiceId: "service:x", stationIds: [a0, a1, a2], trackSegmentIds: ["ab", "bc"] }], stations: new Map([a0, a1, a2].map((id) => [id, { id, status: "available" }])), trackSegments: ["ab", "bc"].map((id) => ({ id, status: "available" })), railCapacityApplications: w.applications };
  const t = w.servicePlans[0].turnbacks.find((x) => x.terminalResourceId);
  const e1 = prescreenServicePlan({ servicePlanId: w.servicePlans[0].servicePlanId, serviceId: "service:x", terminalResourceId: t.terminalResourceId, turnbackCandidateId: t.turnbackCandidateId, mapRevision: { state: "current" } }, { operationalState: state });
  const e1Status = (id) => e1.checks.find((c) => c.area === "track" && c.checkId === id)?.status;
  assert.equal(e1Status("direction-mode"), "unknown");
  assert.equal(e1Status("junction-resource"), "unknown");
  assert.equal(e1Status("block-data"), "possible");
  assert.equal(e1Status("terminal-resource"), "possible");
  assert.equal(e1Status("turnback-connection"), "possible");
  assert.deepEqual(checks(p).filter((id) => id !== "terminal-resource"), ["direction-mode", "junction-resource"]);
  assert.equal(checks(p).includes("block-data"), false);
  assert.equal(p.turnbacks.items[0].turnbackState, "attached");
});

test("the same inputs give the same output on every call; plans are sorted by id whatever order they come in", () => {
  const w = buildReadinessWorld("partial");
  const copy = structuredClone({ servicePlans: w.servicePlans, railGeometries: w.geometries, applications: w.applications });
  assert.equal(json(viewOf(w)), json(buildCapacityReadinessView(copy)));
  const renamed = { ...buildReadinessWorld("bare").servicePlans[0], servicePlanId: "service-plan:0000first", name: "First" };
  const plans = [w.servicePlans[0], renamed];
  const a = buildCapacityReadinessView({ servicePlans: plans, applications: w.applications });
  const b = buildCapacityReadinessView({ servicePlans: [...plans].reverse(), applications: [...w.applications].reverse() });
  assert.equal(json(a), json(b));
  assert.deepEqual(a.plans.map((p) => p.servicePlanId), [...a.plans.map((p) => p.servicePlanId)].sort());
  assert.deepEqual(buildCapacityReadinessView(), { schema: CAPACITY_READINESS_SCHEMA, contractVersion: 1, basis: MAP_FACT_BASIS, plans: [], counts: { plans: 0, applicationCurrent: 0, applicationStale: 0, applicationNone: 0, gaps: 0 } });
});

test("inputs are never changed and the output shares nothing with them; odd inputs give an empty or partial view, not an exception", () => {
  const w = buildReadinessWorld("partial");
  const frozen = deepFreeze(structuredClone({ servicePlans: w.servicePlans, railGeometries: w.geometries, applications: w.applications }));
  const before = json(frozen);
  const view = buildCapacityReadinessView(frozen);
  assert.equal(json(frozen), before);
  view.plans[0].sections[0].directionMode.application.value = "changed";
  view.plans[0].gaps.length = 0;
  assert.equal(json(frozen), before);
  for (const odd of [null, "x", 3, {}, [null, 4, "y"], { plans: "no" }]) {
    assert.doesNotThrow(() => buildCapacityReadinessView({ servicePlans: odd, railGeometries: odd, applications: odd, assumptions: odd }));
  }
  const bare = buildCapacityReadinessView({ servicePlans: [{ servicePlanId: "service-plan:x" }], applications: [] });
  assert.deepEqual(bare.plans[0].sections, []);
  assert.equal(bare.plans[0].application.state, "line-not-stated");
});

test("the editor request is a descriptor for the host: it names what to open and where, and changes nothing", () => {
  const w = buildReadinessWorld("partial");
  const p = planOf(w);
  const gap = p.gaps.find((g) => g.checkId === "direction-mode");
  assert.deepEqual(editorRequestOf(p, gap), { action: "open-capacity-editor", servicePlanId: p.servicePlanId, operationalLineId: w.lineId, railGeometryId: w.geometries[0].railGeometryId, field: "directionMode", checkId: "direction-mode", sectionIds: gap.sectionIds });
  assert.equal(editorRequestOf(p, p.gaps.find((g) => g.kind === "service-plan")).action, "open-service-plan-editor");
});

test("the view says nothing about running a plan: no verdict, no number computed from headway or capacity, no cost or demand, no imports", () => {
  const keys = new Set();
  const walk = (v) => { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { keys.add(k); walk(x); } };
  for (const c of READINESS_CASES) walk(viewOf(buildReadinessWorld(c)));
  assert.equal([...keys].some((k) => /possible|impossible|verdict|feasib|cost|fare|demand|crowd|score|passenger|timetable|ready|blocked/i.test(k)), false);
  assert.deepEqual([...keys].filter((k) => /headway|capacity/i.test(k)), []); // only the M4 assumptions block carries such names, and only as the player's own stated values (checked above)
  const src = fs.readFileSync(path.join(here, "..", "src", "service-plan-capacity-readiness.mjs"), "utf8");
  assert.deepEqual([...src.matchAll(/from "([^"]+)"/g)].map((m) => m[1]), []);
  const code = src.replace(/\/\/.*$/gm, "");
  assert.equal(/management|scenario-runtime|ledger|\.commit\(|\.settle\(|\.post\(|node:fs|Date\.now|new Date|Math\.random|performance\.now|setTimeout|localStorage|sessionStorage|fetch\(/.test(code), false);
  assert.equal(/60\s*\/|\/\s*60\b|Math\.floor\(|trainsPerHour\s*=/.test(code), false, "no headway <-> capacity arithmetic");
});
