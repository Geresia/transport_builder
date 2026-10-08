import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ASSUMPTIONS_EXPORT_SCHEMA, ASSUMPTIONS_SCHEMA, ASSUMPTION_BASIS, DAY_TYPES, STATEMENT_FIELDS, assessmentInputFor, assumptionSetIdOf, buildAssumptionExport, buildAssumptionSet, normalizeStatements,
  technicalSpecsOf, validateClosureWindows, validateClosureWindowsBySectionId, validateDayType, validateDirectionMode, validateMinimumAcceptanceRatio, validateMinimumHeadwayMinutes,
  validateNotApplicable, validateTechnicalProfileId, validateTechnicalSpecification, validateCapacityTrainsPerHour,
} from "../src/service-plan-assumptions.mjs";
import {
  clearAssumption, declareNoClosures, entryOf, newAssumptionsDoc, rebindAssumptions, removeAssumptions, restoreAssumptionsDoc, serializeAssumptionsDoc, setAssumptions, setClosureWindows,
} from "../src/service-plan-assumptions-editor.mjs";
import { RAILWAY_TIMETABLE_DAY_TYPES } from "../src/management/railway-timetable.mjs";
import { TECHNICAL_PROFILES } from "../src/management/construction.mjs";
import { ScenarioRuntime } from "../src/scenario-runtime.mjs";
import { addLine, addPhysicalStation, addTrackSegment, createState } from "../src/state.mjs";
import { snapshotOperationalState } from "../src/integrated-save.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const pack = { manifest: { id: "assume", version: "1", data: { license: "CC0-1.0", attribution: [] } }, demand: { model: "gravity", points: [], attractors: [] } };
const plan = (over = {}) => ({ schema: "transitline.service-plan-geometry/1", contractVersion: 1, servicePlanId: "service-plan:aaaa", servicePlanRevision: "service-plan-revision:1", operationalLineId: "line:1", route: { sections: [{ trackSegmentId: "ab" }, { trackSegmentId: "bc" }] }, ...over });
const SPEC = { runningSystemId: "steel-wheel", gaugeMm: 1435, carWidthM: 2.9, maxAxleLoadTonnes: 16, collectionSystemId: "overhead", currentSystem: "dc", voltageV: 1500, minimumCurveRadiusMeters: 200, maxGradientPermille: 30, signalSystemIds: ["ats-p"], platformHeightMm: 1100, doorLayoutId: "4-door-20m", minCars: 4, maxCars: 10, maintenanceSystemId: "medium_steel" };
const deepFreeze = (o) => { if (o && typeof o === "object") { Object.values(o).forEach(deepFreeze); Object.freeze(o); } return o; };
const json = (v) => JSON.stringify(v);
const throwsWith = (fn, part) => assert.throws(fn, (e) => (part ? e.message.includes(part) : true));
const build = (doc, plans = [plan()], extra = {}) => buildAssumptionExport({ pack, doc, servicePlans: plans, ...extra });
const docWith = (patch, p = plan()) => { const doc = newAssumptionsDoc("assume", "1"); setAssumptions(doc, p, patch); return doc; };

test("the day types and technical profile ids this module accepts are the ones B13 and the construction catalog know", () => {
  assert.deepEqual([...DAY_TYPES], [...RAILWAY_TIMETABLE_DAY_TYPES]);
  for (const id of Object.keys(TECHNICAL_PROFILES)) assert.equal(validateTechnicalProfileId(id, Object.keys(TECHNICAL_PROFILES)), id);
  throwsWith(() => validateTechnicalProfileId("steam", Object.keys(TECHNICAL_PROFILES)), "Unknown technical profile");
  assert.equal(validateTechnicalProfileId("anything", null), "anything"); // no catalog given: only the shape is checked
});

test("a minimum headway must be a real number above zero; 0, negative, text, NaN and too large are refused; null is not stated", () => {
  for (const ok of [3, 0.5, 1440]) assert.equal(validateMinimumHeadwayMinutes(ok), ok);
  for (const no of [0, -1, "3", NaN, Infinity, 1441, false, true, [], {}]) throwsWith(() => validateMinimumHeadwayMinutes(no), "minimumHeadwayMinutes");
  assert.equal(validateMinimumHeadwayMinutes(null), null);
  for (const no of [0, 1.5, -2, "20", NaN]) throwsWith(() => validateCapacityTrainsPerHour(no), "capacityTrainsPerHour");
  assert.equal(validateCapacityTrainsPerHour(20), 20);
});

test("direction mode, day type and acceptance ratio accept only their values; a ratio of 0 is a stated zero", () => {
  assert.deepEqual(["single", "double"].map(validateDirectionMode), ["single", "double"]);
  for (const no of ["both", "", false, 0, 1]) throwsWith(() => validateDirectionMode(no), "directionMode");
  assert.deepEqual(DAY_TYPES.map(validateDayType), [...DAY_TYPES]);
  for (const no of ["Monday", "", false, 0]) throwsWith(() => validateDayType(no), "dayType");
  assert.equal(validateMinimumAcceptanceRatio(0), 0);
  assert.equal(validateMinimumAcceptanceRatio(1), 1);
  assert.equal(validateMinimumAcceptanceRatio(null), null);
  for (const no of [-0.1, 1.01, "0.5", NaN, false]) throwsWith(() => validateMinimumAcceptanceRatio(no), "minimumAcceptanceRatio");
});

test("closure windows are whole minutes inside one day that do not overlap; [] is a stated 'none' and is not null", () => {
  assert.deepEqual(validateClosureWindows([]), []);
  assert.deepEqual(validateClosureWindows([{ startMinute: 600, endMinute: 660, reason: "works" }, { startMinute: 0, endMinute: 60 }, { startMinute: 660, endMinute: 700 }]), [{ startMinute: 0, endMinute: 60 }, { startMinute: 600, endMinute: 660, reason: "works" }, { startMinute: 660, endMinute: 700 }]);
  assert.deepEqual(validateClosureWindows([{ startMinute: 1380, endMinute: 1440 }]), [{ startMinute: 1380, endMinute: 1440 }]);
  for (const bad of [[{ startMinute: 60, endMinute: 60 }], [{ startMinute: 70, endMinute: 60 }], [{ startMinute: -1, endMinute: 10 }], [{ startMinute: 1440, endMinute: 1441 }], [{ startMinute: 0, endMinute: 1441 }],
    [{ startMinute: 0.5, endMinute: 10 }], [{ startMinute: "0", endMinute: 10 }], [{ startMinute: 0, endMinute: 10, reason: "" }], [{ startMinute: 0, endMinute: 10 }, { startMinute: 5, endMinute: 20 }], [null], "x", null, {}]) {
    throwsWith(() => validateClosureWindows(bad));
  }
  assert.equal(validateClosureWindowsBySectionId(null), null);
  assert.deepEqual(validateClosureWindowsBySectionId({}), {});
  assert.deepEqual(validateClosureWindowsBySectionId({ bc: [], ab: [{ startMinute: 1, endMinute: 2 }] }), { ab: [{ startMinute: 1, endMinute: 2 }], bc: [] });
  throwsWith(() => validateClosureWindowsBySectionId({ "": [] }), "section id");
  throwsWith(() => validateClosureWindowsBySectionId([]), "closureWindowsBySectionId");
  throwsWith(() => validateClosureWindowsBySectionId({ ab: null }), "closure windows");
});

test("a technical specification takes only the known fields with usable values; nothing is filled in", () => {
  assert.deepEqual(validateTechnicalSpecification(SPEC), Object.fromEntries(Object.entries(SPEC).sort(([a], [b]) => (a < b ? -1 : 1))));
  assert.equal(validateTechnicalSpecification(null), null);
  assert.deepEqual(validateTechnicalSpecification({}), {}); // stated: no overrides
  for (const bad of [{ colour: "red" }, { gaugeMm: -1 }, { gaugeMm: null }, { gaugeMm: "1435" }, { carWidthM: 0 }, { minCars: 2.5 }, { minCars: 8, maxCars: 4 }, { signalSystemIds: [] }, { signalSystemIds: [""] }, { runningSystemId: "" }, { doorLayoutId: 3 }, [], "x"]) {
    throwsWith(() => validateTechnicalSpecification(bad));
  }
  assert.deepEqual(validateNotApplicable([]), []);
  assert.deepEqual(validateNotApplicable(["gaugeMm", "gaugeMm"]), ["gaugeMm"]);
  assert.equal(validateNotApplicable(null), null);
  throwsWith(() => validateNotApplicable(["power"]), "notApplicable");
});

test("nothing stated means everything unknown with a reason: no field gets a default and the assessment input has no invented value", () => {
  const out = build(docWith({}));
  const set = out.sets[0];
  assert.equal(set.schema, ASSUMPTIONS_SCHEMA);
  assert.equal(out.schema, ASSUMPTIONS_EXPORT_SCHEMA);
  assert.equal(set.basis, ASSUMPTION_BASIS);
  assert.deepEqual(Object.keys(set.statements), [...STATEMENT_FIELDS]);
  assert.ok(Object.values(set.statements).every((v) => v === null));
  assert.deepEqual(set.statedFields, []);
  assert.deepEqual(set.unknown, [...STATEMENT_FIELDS].sort());
  assert.ok(Object.values(set.unknownReasons).every((r) => typeof r === "string" && r.endsWith("-not-stated")));
  assert.deepEqual(set.assessInput, { technicalSpecs: {}, infrastructureAssumptions: null });
  assert.deepEqual(set.defaultsApplyDownstream.map((d) => d.field).sort(), ["closureWindowsBySectionId", "dayType", "minimumAcceptanceRatio"]);
  assert.deepEqual(set.closureSectionsNotStated, ["ab", "bc"]);
});

test("null, 0, false and [] are four different things: a stated 0 ratio and a declared 'no closure' reach the assessment input as themselves", () => {
  const doc = docWith({ minimumAcceptanceRatio: 0, notApplicable: [], closureWindowsBySectionId: { ab: [], bc: [{ startMinute: 60, endMinute: 120 }] } });
  const set = build(doc).sets[0];
  assert.equal(set.statements.minimumAcceptanceRatio, 0);
  assert.deepEqual(set.statements.notApplicable, []);
  assert.deepEqual(set.statedFields, ["notApplicable", "closureWindowsBySectionId", "minimumAcceptanceRatio"]);
  assert.equal(set.assessInput.minimumAcceptanceRatio, 0);
  assert.deepEqual(set.assessInput.closureWindowsBySectionId, { ab: [], bc: [{ startMinute: 60, endMinute: 120 }] });
  assert.deepEqual(set.assessInput.technicalSpecs, { "line:1": { notApplicable: [] } });
  assert.equal("dayType" in set.assessInput, false); // not stated: left out, not set to a default
  assert.equal("dayType" in set.unknownReasons, true);
  assert.deepEqual(set.closureSectionsNotStated, []);
  assert.deepEqual(set.defaultsApplyDownstream.map((d) => d.field), ["dayType"]);
  // a section the player left out of the closure statement is listed, not read as "no closure"
  const half = build(docWith({ closureWindowsBySectionId: { ab: [] } })).sets[0];
  assert.deepEqual(half.closureSectionsNotStated, ["bc"]);
  assert.equal(JSON.stringify(half).includes("false"), false); // `false` is never a value of this contract
});

test("every statement carries that the player stated it, and headway and capacity are never derived from each other", () => {
  const onlyHeadway = build(docWith({ minimumHeadwayMinutes: 3 })).sets[0];
  assert.equal(onlyHeadway.statements.capacityTrainsPerHour, null);
  assert.deepEqual(onlyHeadway.assessInput.technicalSpecs, {});
  assert.deepEqual(onlyHeadway.assessInput.infrastructureAssumptions, { minimumHeadwayMinutes: 3 });
  const onlyCapacity = build(docWith({ capacityTrainsPerHour: 20 })).sets[0];
  assert.equal(onlyCapacity.statements.minimumHeadwayMinutes, null);
  assert.equal(onlyCapacity.assessInput.infrastructureAssumptions, null);
  assert.deepEqual(onlyCapacity.assessInput.technicalSpecs, { "line:1": { capacityTrainsPerHour: 20 } });
  const both = build(docWith({ minimumHeadwayMinutes: 3, capacityTrainsPerHour: 7 })).sets[0];
  assert.deepEqual([both.statements.minimumHeadwayMinutes, both.statements.capacityTrainsPerHour], [3, 7]); // 60/3 = 20 is not 7: the two are not reconciled
  assert.equal(both.basis, "player-stated-assumption");
  assert.equal(build(docWith({})).basis, "player-stated-assumption");
});

test("the assessment input is bound to the plan's line; a plan with no line cannot carry a technical specification", () => {
  const noLine = plan({ operationalLineId: null });
  const set = build(docWith({ technicalProfileId: "medium_steel", directionMode: "double" }, noLine), [noLine]).sets[0];
  assert.deepEqual(set.assessInput.technicalSpecs, {});
  assert.ok(set.warnings.some((w) => w.code === "operational-line-not-stated" && w.fields.includes("technicalProfileId")));
  assert.deepEqual(set.assessInput.infrastructureAssumptions, { directionMode: "double" });
  const withLine = build(docWith({ technicalProfileId: "medium_steel", technicalSpecification: { minCars: 4 }, notApplicable: ["gaugeMm"] })).sets[0];
  assert.deepEqual(withLine.assessInput.technicalSpecs, { "line:1": { technicalProfileId: "medium_steel", technicalSpecification: { minCars: 4 }, notApplicable: ["gaugeMm"] } });
});

test("the same input gives the same ids and byte-identical output; the order statements were written in does not matter", () => {
  const a = docWith({ directionMode: "single", minimumHeadwayMinutes: 4, dayType: "weekday" });
  const b = newAssumptionsDoc("assume", "1");
  setAssumptions(b, plan(), { dayType: "weekday" });
  setAssumptions(b, plan(), { minimumHeadwayMinutes: 4 });
  setAssumptions(b, plan(), { directionMode: "single" });
  assert.equal(json(build(a)), json(build(b)));
  assert.equal(json(build(a)), json(build(structuredClone(a))));
  const set = build(a).sets[0];
  assert.equal(set.assumptionSetId, assumptionSetIdOf("assume", "service-plan:aaaa"));
  assert.match(set.assumptionSetRevision, /^service-plan-assumptions-revision:/);
  const c = docWith({ directionMode: "single", minimumHeadwayMinutes: 5, dayType: "weekday" });
  assert.equal(build(c).sets[0].assumptionSetId, set.assumptionSetId);
  assert.notEqual(build(c).sets[0].assumptionSetRevision, set.assumptionSetRevision);
  const other = buildAssumptionExport({ pack: { manifest: { id: "other", version: "1" } }, doc: a, servicePlans: [plan()] }).sets[0];
  assert.notEqual(other.assumptionSetId, set.assumptionSetId);
});

test("a set is bound to one plan revision: when the plan changes it is stale and unusable until the player confirms it", () => {
  const doc = docWith({ directionMode: "double", minimumHeadwayMinutes: 3 });
  const changed = plan({ servicePlanRevision: "service-plan-revision:2" });
  const stale = build(doc, [changed]).sets[0];
  assert.deepEqual([stale.state, stale.usable, stale.assessInput], ["stale", false, null]);
  assert.equal(stale.boundServicePlanRevision, "service-plan-revision:1");
  assert.equal(stale.currentServicePlanRevision, "service-plan-revision:2");
  assert.ok(stale.warnings.some((w) => w.code === "service-plan-revision-changed"));
  assert.equal(assessmentInputFor(build(doc, [changed]), "service-plan:aaaa"), null);
  assert.deepEqual(build(doc, [changed]).technical.technicalSpecs, {});
  assert.equal(stale.statements.directionMode, "double"); // what the player wrote is kept and shown, only not used
  // editing while stale does not confirm it
  setAssumptions(doc, changed, { minimumHeadwayMinutes: 4 });
  assert.equal(build(doc, [changed]).sets[0].state, "stale");
  rebindAssumptions(doc, changed);
  const current = build(doc, [changed]).sets[0];
  assert.deepEqual([current.state, current.usable], ["current", true]);
  assert.deepEqual(assessmentInputFor(build(doc, [changed]), "service-plan:aaaa").infrastructureAssumptions, { directionMode: "double", minimumHeadwayMinutes: 4 });
  const missing = build(doc, []).sets[0];
  assert.deepEqual([missing.state, missing.usable, missing.assessInput], ["plan-missing", false, null]);
  assert.ok(missing.warnings.some((w) => w.code === "service-plan-missing"));
});

test("a closure section that is not on the plan's route is reported, not silently dropped", () => {
  const set = build(docWith({ closureWindowsBySectionId: { ab: [], zz: [{ startMinute: 1, endMinute: 2 }] } })).sets[0];
  assert.ok(set.warnings.some((w) => w.code === "closure-section-not-on-route" && w.sectionIds.join() === "zz"));
  assert.deepEqual(Object.keys(set.assessInput.closureWindowsBySectionId), ["ab", "zz"]);
  // a route whose track segments are not all known: the not-stated list is unknown, not empty
  const unmapped = plan({ route: { sections: [{ trackSegmentId: "ab" }, { trackSegmentId: null }] } });
  assert.equal(build(docWith({}, unmapped), [unmapped]).sets[0].closureSectionsNotStated, null);
});

test("the editor refuses a bad value and writes nothing; a patch is all or nothing; unknown fields are refused", () => {
  const doc = docWith({ directionMode: "double" });
  const before = serializeAssumptionsDoc(doc);
  throwsWith(() => setAssumptions(doc, plan(), { minimumHeadwayMinutes: 0 }), "minimumHeadwayMinutes");
  throwsWith(() => setAssumptions(doc, plan(), { dayType: "weekend", minimumHeadwayMinutes: -3 }), "minimumHeadwayMinutes");
  throwsWith(() => setAssumptions(doc, plan(), { servicePlanId: "x" }), "Not an assumption field");
  throwsWith(() => setAssumptions(doc, plan(), { closureWindowsBySectionId: { ab: [{ startMinute: 100, endMinute: 50 }] } }), "ends");
  throwsWith(() => setAssumptions(doc, plan(), { technicalProfileId: "steam" }, { knownTechnicalProfileIds: ["medium_steel"] }), "Unknown technical profile");
  assert.equal(serializeAssumptionsDoc(doc), before);
  throwsWith(() => setAssumptions(doc, { servicePlanId: "x" }, {}), "servicePlanRevision");
  throwsWith(() => clearAssumption(doc, "service-plan:nope", "dayType"), "No assumptions");
  throwsWith(() => clearAssumption(doc, "service-plan:aaaa", "colour"), "Not an assumption field");
  assert.equal(serializeAssumptionsDoc(doc), before);
  // a new plan's first bad patch does not leave an empty entry behind
  const fresh = newAssumptionsDoc("assume", "1");
  throwsWith(() => setAssumptions(fresh, plan(), { directionMode: "both" }), "directionMode");
  assert.deepEqual(fresh.entries, []);
});

test("closure editing: one section at a time, [] for none, null to un-state, 'no closure anywhere' only when every track segment is known", () => {
  const doc = newAssumptionsDoc("assume", "1");
  setClosureWindows(doc, plan(), "bc", [{ startMinute: 300, endMinute: 330, reason: "inspection" }]);
  setClosureWindows(doc, plan(), "ab", []);
  assert.deepEqual(entryOf(doc, "service-plan:aaaa").statements.closureWindowsBySectionId, { ab: [], bc: [{ startMinute: 300, endMinute: 330, reason: "inspection" }] });
  setClosureWindows(doc, plan(), "ab", null);
  setClosureWindows(doc, plan(), "bc", null);
  assert.equal(entryOf(doc, "service-plan:aaaa").statements.closureWindowsBySectionId, null);
  declareNoClosures(doc, plan());
  assert.deepEqual(entryOf(doc, "service-plan:aaaa").statements.closureWindowsBySectionId, { ab: [], bc: [] });
  throwsWith(() => declareNoClosures(doc, plan({ route: { sections: [{ trackSegmentId: "ab" }, {}] } })), "not all known");
  throwsWith(() => declareNoClosures(doc, plan({ route: null })), "not all known");
  throwsWith(() => setClosureWindows(doc, plan(), "", []), "section id");
  throwsWith(() => setClosureWindows(doc, plan(), "ab", [{ startMinute: 5, endMinute: 5 }]), "ends");
  assert.deepEqual(entryOf(doc, "service-plan:aaaa").statements.closureWindowsBySectionId, { ab: [], bc: [] });
  clearAssumption(doc, "service-plan:aaaa", "closureWindowsBySectionId");
  assert.equal(entryOf(doc, "service-plan:aaaa").statements.closureWindowsBySectionId, null);
});

test("technical specs of several plans merge by line; two different statements for one line are a conflict and that line is left out", () => {
  const p1 = plan();
  const p2 = plan({ servicePlanId: "service-plan:bbbb" });
  const p3 = plan({ servicePlanId: "service-plan:cccc", operationalLineId: "line:2" });
  const doc = newAssumptionsDoc("assume", "1");
  setAssumptions(doc, p1, { technicalProfileId: "medium_steel" });
  setAssumptions(doc, p2, { technicalProfileId: "medium_steel" });
  setAssumptions(doc, p3, { technicalProfileId: "small_steel" });
  const same = build(doc, [p1, p2, p3]).technical;
  assert.deepEqual(same.technicalSpecs, { "line:1": { technicalProfileId: "medium_steel" }, "line:2": { technicalProfileId: "small_steel" } });
  assert.deepEqual(same.conflicts, []);
  setAssumptions(doc, p2, { technicalProfileId: "large_steel" });
  const conflict = build(doc, [p1, p2, p3]).technical;
  assert.deepEqual(conflict.technicalSpecs, { "line:2": { technicalProfileId: "small_steel" } });
  assert.equal(conflict.conflicts.length, 1);
  assert.equal(conflict.conflicts[0].operationalLineId, "line:1");
  assert.equal(conflict.conflicts[0].assumptionSetIds.length, 2);
  assert.deepEqual(technicalSpecsOf([]), { technicalSpecs: {}, conflicts: [] });
});

test("saving and restoring keeps every entry and the export byte for byte; another pack's document is refused and the current one is left alone", () => {
  const doc = docWith({ directionMode: "double", minimumHeadwayMinutes: 3, dayType: "weekend", minimumAcceptanceRatio: 0, closureWindowsBySectionId: { ab: [], bc: [{ startMinute: 0, endMinute: 30 }] } });
  const text = serializeAssumptionsDoc(doc);
  const restored = restoreAssumptionsDoc(text, pack);
  assert.deepEqual([restored.rejected, restored.warnings], [false, []]);
  assert.equal(serializeAssumptionsDoc(restored.doc), text);
  assert.equal(json(build(restored.doc)), json(build(doc)));
  const foreign = JSON.stringify({ ...JSON.parse(text), packId: "someone-else" });
  const before = serializeAssumptionsDoc(doc);
  const refused = restoreAssumptionsDoc(foreign, pack, { current: doc });
  assert.deepEqual([refused.rejected, refused.doc === doc, refused.warnings.map((w) => w.code)], [true, true, ["service-plan-assumptions-doc-other-pack"]]);
  assert.equal(serializeAssumptionsDoc(doc), before);
  for (const [bad, code] of [["{", "service-plan-assumptions-doc-unreadable"], [JSON.stringify({ version: 9, packId: "assume", entries: [] }), "service-plan-assumptions-doc-version"], [JSON.stringify({ version: 1, packId: "assume", entries: [{ servicePlanId: 1 }] }), "service-plan-assumptions-doc-version"]]) {
    const r = restoreAssumptionsDoc(bad, pack, { current: doc });
    assert.deepEqual([r.rejected, r.doc === doc, r.warnings[0].code], [true, true, code]);
  }
  assert.equal(restoreAssumptionsDoc("{", pack).doc.entries.length, 0);
  assert.equal(restoreAssumptionsDoc(null, pack).doc.entries.length, 0);
  const olderPack = JSON.stringify({ ...JSON.parse(text), packVersion: "0.5" });
  assert.deepEqual(restoreAssumptionsDoc(olderPack, pack).warnings, [{ code: "pack-version-mismatch", saved: "0.5", current: "1" }]);
});

test("a saved entry that no longer passes the checks is kept as it is and reported by the builder, never repaired", () => {
  const text = JSON.stringify({ version: 1, packId: "assume", packVersion: "1", entries: [{ servicePlanId: "service-plan:aaaa", boundServicePlanRevision: "service-plan-revision:1", statements: { minimumHeadwayMinutes: -5, directionMode: "double" } }] });
  const restored = restoreAssumptionsDoc(text, pack);
  assert.equal(restored.doc.entries[0].statements.minimumHeadwayMinutes, -5);
  const set = build(restored.doc).sets[0];
  assert.equal(set.usable, false);
  assert.equal(set.assessInput, null);
  assert.ok(set.warnings.some((w) => w.code === "statements-invalid" && /minimumHeadwayMinutes/.test(w.message)));
  assert.ok(Object.values(set.statements).every((v) => v === null)); // nothing from an entry that does not pass is used
});

test("inputs are never changed and the outputs share nothing with them", () => {
  const p = deepFreeze(plan());
  const patch = { closureWindowsBySectionId: { ab: [{ startMinute: 0, endMinute: 10 }] }, technicalSpecification: { signalSystemIds: ["ats-p"] } };
  const doc = newAssumptionsDoc("assume", "1");
  setAssumptions(doc, p, deepFreeze(structuredClone(patch)));
  const text = serializeAssumptionsDoc(doc);
  const frozenDoc = deepFreeze(JSON.parse(text));
  const out = buildAssumptionExport({ pack: deepFreeze(structuredClone(pack)), doc: frozenDoc, servicePlans: [p] });
  assert.equal(serializeAssumptionsDoc(frozenDoc), text);
  out.sets[0].assessInput.closureWindowsBySectionId.ab[0].endMinute = 999;
  out.sets[0].statements.technicalSpecification.signalSystemIds.push("x");
  assert.equal(serializeAssumptionsDoc(frozenDoc), text);
  const mutable = structuredClone(patch);
  const d2 = newAssumptionsDoc("assume", "1");
  setAssumptions(d2, plan(), mutable);
  mutable.closureWindowsBySectionId.ab[0].endMinute = 5;
  assert.equal(entryOf(d2, "service-plan:aaaa").statements.closureWindowsBySectionId.ab[0].endMinute, 10);
  removeAssumptions(d2, "service-plan:aaaa");
  assert.deepEqual(d2.entries, []);
  throwsWith(() => removeAssumptions(d2, "service-plan:aaaa"), "No assumptions");
  assert.deepEqual(Object.keys(normalizeStatements({})), [...STATEMENT_FIELDS]);
  assert.equal(buildAssumptionSet({ servicePlanId: "service-plan:aaaa", boundServicePlanRevision: "r", statements: {} }, { pack, servicePlans: [] }).state, "plan-missing");
});

// --- the hand-over to B16-M3 / E2: the same fixture as the runtime integration test, with the track facts a player has not drawn ---
function runtimeWorld({ mapDirectionMode = null } = {}) {
  const rtPack = { manifest: { id: "assume-rt", version: "1", data: { license: "test", attribution: [] } }, demand: { model: "gravity", points: [], attractors: [] } };
  const state = createState(rtPack);
  addPhysicalStation(state, { id: "A", location: [139, 35], status: "available" });
  addPhysicalStation(state, { id: "B", location: [139.01, 35], status: "available" });
  // the track says nothing about its track count, its minimum headway or its capacity
  addTrackSegment(state, { id: "ab", fromStationId: "A", toStationId: "B", lengthMeters: 1000, status: "available" });
  const line = addLine(state, ["A", "B"]); line.trackSegmentIds = ["ab"]; line.managementServiceId = "service:actual"; line.suspended = false;
  state.railCapacityApplications = [{ operationalLineId: line.id, railGeometryId: "geometry:1", railGeometryRevision: "revision:1", sections: [{ trackSegmentId: "ab", railCapacitySectionId: "section:ab", directionMode: mapDirectionMode, blockIds: [], junctionResourceIds: [] }], junctions: [], terminals: [{ terminalResourceId: "terminal:B", stationId: "B", platformCandidates: [], turnbackCandidates: [{ turnbackCandidateId: "turnback:B", attached: true }] }] }];
  const runtime = new ScenarioRuntime({ pack: rtPack, operationalState: state });
  runtime.game.services.push({ id: "service:actual", operationalLineId: line.id, commercialSpeedKph: 30, operatorId: "player" });
  const servicePlan = {
    schema: "transitline.service-plan-geometry/1", contractVersion: 1, servicePlanId: "map-plan:1", servicePlanRevision: "map-revision:1", active: true,
    revision: { state: "current" }, capacityApplicationState: "current", capacityApplicationRevision: "revision:1", operationalLineId: String(line.id), playerInputs: { operatingPattern: "full" },
    route: { sections: [{ trackSegmentId: "ab", traversal: "forward" }] }, spatialFacts: { sections: [{ junctionResourceIds: [] }] },
    directions: [{ key: "out", fromStationId: "A", toStationId: "B", physicalConnection: true }, { key: "back", fromStationId: "B", toStationId: "A", physicalConnection: true }],
    serviceBands: [{ bandId: "band:1", operating: true, startMinute: 360, endMinute: 420, playerRequestedHeadwayMinutes: 10, playerRequestedTrainsets: 2, directionKeys: ["out", "back"] }],
    turnbacks: [{ stationId: "B", terminalResourceId: "terminal:B", turnbackCandidateId: "turnback:B" }], vehicleIntent: { vehicleModelId: "medium_4car", requestedTrainsets: 2 },
  };
  const host = { vehicleOrders: [{ modelId: "medium_4car", stage: "accepted", quantity: 2, units: [{ id: "set:1", status: "available" }, { id: "set:2", status: "available" }] }], operatingResourcePools: [] };
  return { runtime, state, servicePlan, host };
}

test("without the player's assumptions the timetable assessment stays blocked as unknown; with them it runs, and B13 records them as assumptions", () => {
  const binding = { servicePlanId: "map-plan:1", serviceId: "service:actual" };
  const statedAll = (servicePlan) => {
    const doc = newAssumptionsDoc("assume", "1");
    setAssumptions(doc, servicePlan, { technicalSpecification: SPEC, capacityTrainsPerHour: 20, directionMode: "double", minimumHeadwayMinutes: 3, dayType: "weekend", minimumAcceptanceRatio: 0.5 });
    declareNoClosures(doc, servicePlan);
    return { doc, exported: buildAssumptionExport({ pack, doc, servicePlans: [servicePlan] }) };
  };
  // 1) nothing stated: the technical specification and the capacity are unknown, and so is the track count
  const world = runtimeWorld({ mapDirectionMode: "double" });
  const empty = world.runtime.assessServicePlanTimetable(world.servicePlan, binding, world.host);
  assert.equal(empty.adaptation.status, "unknown");
  assert.equal(empty.timetable, null);
  assert.deepEqual(empty.adaptation.prescreen.checks.filter((c) => c.status === "unknown").map((c) => c.checkId).sort(), ["capacity-data", "line-technical-spec"]);
  // 2) only the technical specification stated: the capacity is still not known, so the assessment is still not run (nothing is guessed from the headway)
  const half = buildAssumptionExport({ pack, doc: docWith({ technicalSpecification: SPEC, minimumHeadwayMinutes: 3 }, world.servicePlan), servicePlans: [world.servicePlan] });
  const partial = world.runtime.assessServicePlanTimetable(world.servicePlan, binding, { ...world.host, ...assessmentInputFor(half, "map-plan:1") });
  assert.equal(partial.adaptation.status, "unknown");
  assert.deepEqual(partial.adaptation.prescreen.checks.filter((c) => c.status === "unknown").map((c) => c.checkId), ["capacity-data"]);
  assert.equal(partial.timetable, null);
  // 3) everything stated: B13 runs, takes the stated values as they are and records the track assumptions as explicit assumptions
  const { exported } = statedAll(world.servicePlan);
  const input = assessmentInputFor(exported, "map-plan:1");
  assert.deepEqual(Object.keys(input).sort(), ["closureWindowsBySectionId", "dayType", "infrastructureAssumptions", "minimumAcceptanceRatio", "technicalSpecs"]);
  assert.deepEqual(exported.technical.technicalSpecs, { [world.servicePlan.operationalLineId]: { technicalSpecification: validateTechnicalSpecification(SPEC), capacityTrainsPerHour: 20 } });
  const snapshot = () => JSON.stringify({ game: world.runtime.game.snapshot(), state: snapshotOperationalState(world.state) });
  const before = snapshot();
  const result = world.runtime.assessServicePlanTimetable(world.servicePlan, binding, { ...world.host, ...input });
  assert.equal(result.adaptation.status, "ready", JSON.stringify(result.adaptation));
  assert.deepEqual(result.adaptation.operationalRequest.infrastructureAssumptions, { directionMode: "double", minimumHeadwayMinutes: 3 });
  assert.deepEqual(result.adaptation.operationalRequest.closureWindowsBySectionId, { ab: [] });
  assert.equal(result.adaptation.operationalRequest.dayType, "weekend");
  assert.equal(result.adaptation.operationalRequest.minimumAcceptanceRatio, 0.5);
  assert.equal(result.timetable.dayType, "weekend");
  assert.deepEqual(result.timetable.operationalFacts.assumptions.filter((a) => /explicit-assumption/.test(a)).sort(), ["ab:directionMode:explicit-assumption-double", "ab:minimumHeadwayMinutes:explicit-assumption-3"]);
  assert.notEqual(snapshot(), before); // the assessment itself is B13's and records a timetable; building the assumptions changed nothing
  // 4) the map does not state the track count: the pre-screen still reads that from the map, so the player's track count does not unblock it
  const unstatedMap = runtimeWorld({ mapDirectionMode: null });
  const blocked = unstatedMap.runtime.assessServicePlanTimetable(unstatedMap.servicePlan, binding, { ...unstatedMap.host, ...assessmentInputFor(statedAll(unstatedMap.servicePlan).exported, "map-plan:1") });
  assert.equal(blocked.adaptation.status, "unknown");
  assert.deepEqual(blocked.adaptation.prescreen.checks.filter((c) => c.status === "unknown").map((c) => c.checkId), ["direction-mode"]);
  assert.equal(blocked.timetable, null);
  // 5) when the plan changes, the same assumptions are not handed over any more
  assert.equal(assessmentInputFor(buildAssumptionExport({ pack, doc: statedAll(world.servicePlan).doc, servicePlans: [{ ...world.servicePlan, servicePlanRevision: "map-revision:2" }] }), "map-plan:1"), null);
});

test("the assumptions modules import no management or map state, run no clock or randomness and compute no capacity, headway or verdict", () => {
  for (const file of ["service-plan-assumptions", "service-plan-assumptions-editor"]) {
    const src = fs.readFileSync(path.join(here, "..", "src", `${file}.mjs`), "utf8");
    for (const m of src.matchAll(/from "([^"]+)"/g)) assert.match(m[1], /^\.\/(map\/ids|service-plan-assumptions)\.mjs$/, `${file} imports ${m[1]}`);
    const code = src.replace(/\/\/.*$/gm, "");
    assert.equal(/management|scenario-runtime|ledger|\.commit\(|\.settle\(|\.post\(|node:fs|Date\.now|new Date|Math\.random|performance\.now|setTimeout|localStorage|sessionStorage/.test(code), false, file);
    assert.equal(/60\s*\/|\/\s*60\b|trainsPerHour\s*=|Math\.floor\(/.test(code), false, `${file} must not turn a headway into a capacity or back`);
  }
});
