import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { ManagementGame } from "../src/management/index.mjs";
import { buildNewTownDemandCandidates, NEW_TOWN_DEMAND_CANDIDATES_SCHEMA, NEW_TOWN_DEMAND_NOT_COMPUTED, STATED_DEMAND_KINDS } from "../src/new-town-demand-candidates.mjs";

const read = (rel) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
// a real B19-M1 development (drawn in the editor, built by the M1 builder)
const EXAMPLE = JSON.parse(read("../../packs/example-radial/new-town-development-examples/01-two-phases-with-synthetic-pond-and-road.new-town.json"));
const [P1, P2] = EXAMPLE.phases.map((p) => p.phaseId);
const PARTIES = { municipality: { name: "Example City" }, developer: { name: "Example Dev" } };
const AGREEMENT = { burdens: [{ itemId: "land", bearers: ["developer"] }] };
const deepFreeze = (o) => { if (o && typeof o === "object") { Object.values(o).forEach(deepFreeze); Object.freeze(o); } return o; };
const geo = (over = {}) => ({ ...structuredClone(EXAMPLE), ...over });

// the real B19-E1 lifecycle, made up to "servicing", with the given occupancy facts per phase
function lifecycle(factsByPhase = {}, { geometry = EXAMPLE, after = null, supply = [{ phaseId: P1, unit: "housing-units", quantity: 500 }] } = {}) {
  const game = new ManagementGame({ seed: 1902 });
  const { id } = game.proposeNewTownDevelopment({ geometry, parties: PARTIES, phaseSupply: supply });
  game.agreeNewTownDevelopment(id, AGREEMENT, { geometry });
  game.startNewTownServicing(id, { geometry, phaseIds: [P1, P2] });
  for (const [phaseId, facts] of Object.entries(factsByPhase)) for (const fact of facts) game.recordNewTownOccupancy(id, phaseId, fact, { geometry });
  if (after) after(game, id);
  return { game, id, hooks: game.newTownDevelopmentHooks(id) };
}
const RESIDENTS = { statedOccupiedUnits: 120, unit: "residents", source: "player-stated" };
const keysOf = (v, out = new Set()) => { if (Array.isArray(v)) v.forEach((x) => keysOf(x, out)); else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { out.add(k); keysOf(x, out); } return out; };

test("a real E1 lifecycle and the real M1 geometry give a complete candidate that copies only what the player stated", () => {
  const { hooks } = lifecycle({ [P1]: [RESIDENTS] });
  const result = buildNewTownDemandCandidates({ hooks, geometry: EXAMPLE });
  assert.equal(result.schema, NEW_TOWN_DEMAND_CANDIDATES_SCHEMA);
  assert.deepEqual([result.contractVersion, result.developmentId, result.developmentRevision, result.sourcePackId, result.sourcePackVersion], [1, EXAMPLE.developmentId, EXAMPLE.developmentRevision, "example-radial", "0.1.0"]);
  assert.deepEqual([result.lifecycleStatus, result.geometryStatus], ["occupied", { status: "current", reasons: [] }]);
  assert.equal(result.candidates.length, 1);
  const c = result.candidates[0];
  assert.equal(c.candidateId, `new-town-demand-candidate:${EXAMPLE.developmentId}:${P1}`);
  assert.deepEqual([c.developmentId, c.phaseId, c.phaseRevision, c.lifecycleHookId, c.sequence], [EXAMPLE.developmentId, P1, EXAMPLE.phases[0].phaseRevision, `new-town-development:1:phase:${P1}`, 1]);
  assert.deepEqual([c.lifecycleStatus, c.phaseLifecycleStatus, c.geometryStatus, c.recordedGeometryStatus, c.playerDeclaredLandUse], ["occupied", "occupied", { status: "current", reasons: [] }, "current", "housing"]);
  assert.deepEqual(c.location, EXAMPLE.phases[0].location);
  assert.deepEqual(c.demandNodeRefsInside, [], "[] is the map's measured 'no recorded node inside', not null and not zero demand");
  assert.deepEqual(c.statedDemandFacts, [{ factId: `new-town-development:1:phase:${P1}:occupancy:1`, sequence: 1, recordedAtMinute: 0, kind: "residents", quantity: 120, source: "player-stated", note: null }]);
  assert.deepEqual(c.occupancyFactIds, [`new-town-development:1:phase:${P1}:occupancy:1`]);
  assert.deepEqual(c.state, { stale: false, inactive: false, otherPack: false, cancelled: false, delayed: false });
  assert.deepEqual(c.inputCompleteness, { status: "complete", blockers: [], missing: [] });
  assert.equal(c.eligibleForB15, true);
  assert.deepEqual(c.basis, { derivation: "copied-as-stated", statedBy: "player", lifecycleSchema: "transitline.new-town-development-hooks/1", geometryDevelopmentRevision: EXAMPLE.developmentRevision });
  assert.deepEqual(result.phasesWithoutCandidate, [{ phaseId: P2, phaseLifecycleStatus: "servicing", reason: "no-occupancy-fact" }]);
  assert.deepEqual(result.sourceReferences.geometry, { schema: EXAMPLE.schema, developmentId: EXAMPLE.developmentId, developmentRevision: EXAMPLE.developmentRevision, sourcePackId: "example-radial", sourcePackVersion: "0.1.0" });
  assert.equal(result.sourceReferences.lifecycle.developmentHookId, "new-town-development:1");
  assert.equal(result.sourceReferences.lifecycle.transitionIds.length, hooks.transitions.length);
  assert.deepEqual(result.notComputed, [...NEW_TOWN_DEMAND_NOT_COMPUTED]);
  assert.deepEqual(STATED_DEMAND_KINDS, ["residents", "jobs"]);
});

test("an occupied phase whose facts state no residents or jobs stays a candidate but creates no population: statedDemandFacts is null with the reason", () => {
  const cases = {
    "housing-units": { statedOccupiedUnits: 500, unit: "housing-units", source: "survey" },
    "unit not stated": { statedOccupiedUnits: 80, source: "survey" },
    "only a planned number": { statedPlannedUnits: 300, unit: "residents", source: "survey" },
    "other word": { statedOccupiedUnits: 10, unit: "Residents", source: "survey" },
  };
  for (const [name, fact] of Object.entries(cases)) {
    const { hooks } = lifecycle({ [P1]: [fact] });
    assert.equal(hooks.status, "occupied");
    const c = buildNewTownDemandCandidates({ hooks, geometry: EXAMPLE }).candidates[0];
    assert.equal(c.statedDemandFacts, null, name);
    assert.equal(c.unknownReasons.statedDemandFacts, "no-occupancy-fact-states-a-demand-kind", name);
    assert.deepEqual(c.unknown, ["statedDemandFacts"]);
    assert.equal(c.eligibleForB15, null, `${name}: input is incomplete, not 'eligible'`);
    assert.deepEqual(c.inputCompleteness, { status: "incomplete", blockers: [], missing: ["statedDemandFacts"] });
    assert.equal(c.occupancyFactIds.length, 1, "the occupancy fact is still referenced");
    assert.ok(c.warnings.some((w) => w.code === "occupancy-facts-without-a-demand-kind"));
  }
  // each ignored fact says why
  const why = (fact) => buildNewTownDemandCandidates({ hooks: lifecycle({ [P1]: [fact] }).hooks, geometry: EXAMPLE }).candidates[0].warnings.find((w) => w.code === "occupancy-facts-without-a-demand-kind").reasons;
  assert.deepEqual(why(cases["housing-units"]), ["occupancy-unit-not-a-demand-kind:housing-units"]);
  assert.deepEqual(why(cases["unit not stated"]), ["occupancy-unit-not-stated"]);
  assert.deepEqual(why(cases["only a planned number"]), ["occupancy-fact-states-no-occupied-quantity"]);
  assert.deepEqual(why(cases["other word"]), ["occupancy-unit-not-a-demand-kind:Residents"]);
  // the stated supply of the lifecycle (500 housing units) is not turned into anything
  const { hooks } = lifecycle({ [P1]: [cases["housing-units"]] });
  assert.deepEqual(hooks.phases[0].statedSupply, { unit: "housing-units", quantity: 500 });
  const result = buildNewTownDemandCandidates({ hooks, geometry: EXAMPLE });
  const shown = JSON.stringify({ ...result, notComputed: null });
  assert.ok(!/"quantity":|"kind":/.test(shown), "no number or kind appears that the player did not state in a demand kind");
  assert.equal(result.candidates[0].phaseLifecycleStatus, "occupied");
});

test("zero is a stated zero; null is not stated; [] and false are not confused with either", () => {
  const { hooks } = lifecycle({ [P1]: [{ statedOccupiedUnits: 0, unit: "jobs", source: "survey", note: "no one has started work yet" }], [P2]: [{ statedPlannedUnits: 40, unit: "jobs", source: "plan" }] });
  const result = buildNewTownDemandCandidates({ hooks, geometry: EXAMPLE });
  const [one, two] = result.candidates;
  assert.equal(one.statedDemandFacts[0].quantity, 0);
  assert.ok(Object.is(one.statedDemandFacts[0].quantity, 0), "0, not null");
  assert.equal(one.statedDemandFacts[0].note, "no one has started work yet");
  assert.equal(one.eligibleForB15, true, "a stated zero is a complete fact");
  assert.equal(two.statedDemandFacts, null, "nothing stated about occupied people");
  assert.equal(two.eligibleForB15, null);
  assert.deepEqual(one.demandNodeRefsInside, []);
  const without = buildNewTownDemandCandidates({ hooks, geometry: null });
  assert.equal(without.candidates[0].demandNodeRefsInside, null, "unknown, not []");
  assert.equal(without.candidates[0].location, null);
  assert.equal(without.candidates[0].state.cancelled, false, "false is a measured 'not cancelled', not unknown");
  assert.equal(one.state.delayed, false);
  // a map that does not say where the nodes are: null with the map's own reason, not []
  const noNodes = geo(); noNodes.phases = noNodes.phases.map((p, i) => (i === 0 ? { ...p, spatialFacts: { ...p.spatialFacts, demandNodeRefsInside: null, unknownReasons: { demandNodeRefsInside: "no-demand-nodes-in-pack" } } } : p));
  const c = buildNewTownDemandCandidates({ hooks, geometry: noNodes }).candidates[0];
  assert.deepEqual([c.demandNodeRefsInside, c.unknownReasons.demandNodeRefsInside], [null, "no-demand-nodes-in-pack"]);
  const nodes = geo(); nodes.phases = nodes.phases.map((p, i) => (i === 0 ? { ...p, spatialFacts: { ...p.spatialFacts, demandNodeRefsInside: ["node:3", "node:1"] } } : p));
  assert.deepEqual(buildNewTownDemandCandidates({ hooks, geometry: nodes }).candidates[0].demandNodeRefsInside, ["node:3", "node:1"], "only the ids, in the map's order");
});

test("stated facts are copied one by one, never added together or merged, and other kinds do not hide them", () => {
  const { hooks } = lifecycle({ [P1]: [RESIDENTS, { statedOccupiedUnits: 150, unit: "residents", source: "second survey" }, { statedOccupiedUnits: 30, unit: "jobs", source: "employer" }, { statedOccupiedUnits: 9, unit: "housing-units", source: "x" }] });
  const c = buildNewTownDemandCandidates({ hooks, geometry: EXAMPLE }).candidates[0];
  assert.deepEqual(c.statedDemandFacts.map((f) => [f.kind, f.quantity, f.source, f.sequence]), [["residents", 120, "player-stated", 1], ["residents", 150, "second survey", 2], ["jobs", 30, "employer", 3]]);
  assert.equal(c.occupancyFactIds.length, 4);
  assert.deepEqual(c.warnings.map((w) => w.code).sort(), ["occupancy-facts-without-a-demand-kind", "several-stated-facts-for-one-kind-not-merged"]);
  assert.deepEqual(c.warnings.find((w) => w.code === "occupancy-facts-without-a-demand-kind").reasons, ["occupancy-unit-not-a-demand-kind:housing-units"]);
  assert.equal(c.eligibleForB15, true);
});

test("a stale, inactive, other-pack or cancelled candidate is not a B15 candidate (eligibleForB15 false) and says which", () => {
  const { hooks } = lifecycle({ [P1]: [RESIDENTS] });
  const blocked = {
    "revision changed": [geo({ developmentRevision: "new-town-revision:0000000000000000" }), "stale", "geometry-revision-changed", "geometry-stale"],
    "development switched off": [geo({ active: false }), "inactive", "geometry-inactive", "geometry-inactive"],
    "other pack": [geo({ sourcePackId: "other-pack" }), "other-pack", "geometry-source-pack-changed", "geometry-other-pack"],
    "pack version changed": [geo({ sourcePackVersion: "9.9.9" }), "stale", "geometry-source-pack-version-changed", "geometry-stale"],
    "other development": [geo({ developmentId: "new-town:other" }), "stale", "geometry-other-development", "geometry-stale"],
  };
  for (const [name, [geometry, status, reason, blocker]] of Object.entries(blocked)) {
    const result = buildNewTownDemandCandidates({ hooks, geometry });
    assert.deepEqual(result.geometryStatus, { status, reasons: [reason] }, name);
    const c = result.candidates[0];
    assert.deepEqual([c.eligibleForB15, c.geometryStatus.status, c.inputCompleteness.status, c.inputCompleteness.blockers], [false, status, "blocked", [blocker]], name);
    assert.deepEqual([c.location, c.demandNodeRefsInside], [null, null], `${name}: a map that is not the current one gives no location`);
    assert.equal(c.unknownReasons.location, `geometry-${status}`);
    assert.deepEqual([c.state.stale, c.state.inactive, c.state.otherPack], [status === "stale", status === "inactive", status === "other-pack"], name);
    assert.ok(c.statedDemandFacts, "the stated facts are still shown, only not applicable");
  }
  // a single phase: not in the map any more / switched off / land use redeclared
  const noPhase = geo(); noPhase.phases = noPhase.phases.slice(1);
  assert.deepEqual(buildNewTownDemandCandidates({ hooks, geometry: noPhase }).candidates[0].geometryStatus, { status: "stale", reasons: ["phase-not-in-geometry"] });
  const off = geo(); off.phases = off.phases.map((p, i) => (i === 0 ? { ...p, active: false } : p));
  const offResult = buildNewTownDemandCandidates({ hooks, geometry: off });
  assert.deepEqual([offResult.geometryStatus.status, offResult.candidates[0].geometryStatus, offResult.candidates[0].eligibleForB15], ["current", { status: "inactive", reasons: ["phase-inactive"] }, false], "the development is current, the phase is not");
  const landUse = geo(); landUse.phases = landUse.phases.map((p, i) => (i === 0 ? { ...p, playerDeclaredLandUse: "employment" } : p));
  assert.deepEqual(buildNewTownDemandCandidates({ hooks, geometry: landUse }).candidates[0].geometryStatus, { status: "stale", reasons: ["phase-land-use-changed"] });
  // cancelled (the lifecycle): kept in the list, never applicable, facts untouched
  const cancelled = lifecycle({ [P1]: [RESIDENTS] }, { after: (game, id) => game.cancelNewTownDevelopment(id, "the player stopped it") });
  const result = buildNewTownDemandCandidates({ hooks: cancelled.hooks, geometry: EXAMPLE });
  assert.equal(result.lifecycleStatus, "cancelled");
  assert.ok(result.warnings.some((w) => w.code === "development-cancelled"));
  const c = result.candidates[0];
  assert.deepEqual([c.eligibleForB15, c.state.cancelled, c.inputCompleteness.blockers, c.phaseLifecycleStatus], [false, true, ["lifecycle-cancelled"], "occupied"]);
  assert.equal(c.statedDemandFacts[0].quantity, 120);
});

test("a geometry that is missing, unusable, or a lifecycle without pack identity is unknown (null), never eligible", () => {
  const { hooks } = lifecycle({ [P1]: [RESIDENTS] });
  const cases = [
    [undefined, "missing", "geometry-not-provided"], [null, "missing", "geometry-not-provided"], ["x", "invalid", "geometry-not-an-object"], [[], "invalid", "geometry-not-an-object"],
    [{ schema: "other/1" }, "invalid", "geometry-schema-invalid"], [geo({ sourcePackId: null }), "invalid", "geometry-source-pack-unknown"], [geo({ sourcePackId: " " }), "invalid", "geometry-source-pack-unknown"],
    [geo({ active: null }), "invalid", "geometry-active-unknown"], [geo({ active: undefined }), "invalid", "geometry-active-unknown"], [geo({ phases: null }), "invalid", "geometry-phases-unknown"],
    [{ schema: "transitline.new-town-development-export/1", developments: [] }, "missing", "geometry-development-not-in-export"],
  ];
  for (const [geometry, status, reason] of cases) {
    const result = buildNewTownDemandCandidates({ hooks, geometry });
    assert.deepEqual(result.geometryStatus, { status, reasons: [reason] }, JSON.stringify(geometry)?.slice(0, 60));
    assert.equal(result.candidates[0].eligibleForB15, null, `${status}/${reason}`);
    assert.deepEqual(result.candidates[0].inputCompleteness, { status: "incomplete", blockers: [], missing: [`geometry-${status}`] });
    assert.deepEqual([result.unknown.includes("geometry"), result.unknownReasons.geometry], [true, reason]);
    // no development at all -> no reference; an unusable development is still referenced, with what it says
    const noDevelopment = ["geometry-not-provided", "geometry-not-an-object", "geometry-schema-invalid", "geometry-development-not-in-export"].includes(reason);
    assert.equal(result.sourceReferences.geometry === null, noDevelopment, reason);
  }
  // the lifecycle kept no pack identity (an old save): never assume the geometry's pack is the right one
  const legacy = structuredClone(hooks); legacy.sourcePack = null;
  const result = buildNewTownDemandCandidates({ hooks: legacy, geometry: EXAMPLE });
  assert.deepEqual([result.sourcePackId, result.sourcePackVersion, result.unknown], [null, null, ["geometry", "sourcePackId", "sourcePackVersion"]]);
  assert.deepEqual(result.geometryStatus, { status: "pack-unknown", reasons: ["lifecycle-source-pack-unknown"] });
  assert.equal(result.candidates[0].eligibleForB15, null);
  const noVersion = structuredClone(hooks); noVersion.sourcePack = { packId: "example-radial", packVersion: null };
  const nv = buildNewTownDemandCandidates({ hooks: noVersion, geometry: EXAMPLE });
  assert.deepEqual([nv.sourcePackVersion, nv.unknown, nv.unknownReasons.sourcePackVersion, nv.geometryStatus.status], [null, ["sourcePackVersion"], "not-stated", "current"]);
});

test("a delayed development is kept and shown as delayed, not hidden and not blocked", () => {
  const { hooks } = lifecycle({ [P1]: [RESIDENTS] }, { after: (game, id) => game.delayNewTownDevelopment(id, "land permit is late") });
  const result = buildNewTownDemandCandidates({ hooks, geometry: EXAMPLE });
  const c = result.candidates[0];
  assert.equal(result.lifecycleStatus, "delayed");
  assert.deepEqual([c.lifecycleStatus, c.state.delayed, c.state.cancelled, c.eligibleForB15], ["delayed", true, false, true]);
  assert.ok(c.warnings.some((w) => w.code === "development-delayed") && result.warnings.some((w) => w.code === "development-delayed"));
  assert.equal(c.statedDemandFacts[0].quantity, 120);
});

test("the geometry may be one development or the whole M1 export; a phase with no stated facts has no candidate", () => {
  const { hooks } = lifecycle({ [P2]: [{ statedOccupiedUnits: 55, unit: "jobs", source: "employer" }] });
  const single = buildNewTownDemandCandidates({ hooks, geometry: EXAMPLE });
  const other = { ...structuredClone(EXAMPLE), developmentId: "new-town:other", phases: [] };
  const whole = buildNewTownDemandCandidates({ hooks, geometry: { schema: "transitline.new-town-development-export/1", packId: "example-radial", packVersion: "0.1.0", developments: [other, EXAMPLE], warnings: [] } });
  assert.deepEqual(whole, single);
  assert.deepEqual(single.candidates.map((c) => c.phaseId), [P2]);
  assert.equal(single.candidates[0].playerDeclaredLandUse, "employment");
  assert.deepEqual(single.phasesWithoutCandidate.map((p) => p.phaseId), [P1]);
  const nothing = buildNewTownDemandCandidates({ hooks: lifecycle().hooks, geometry: EXAMPLE });
  assert.deepEqual([nothing.candidates, nothing.phasesWithoutCandidate.length], [[], 2], "no stated fact anywhere: no candidate, and the phases are listed");
});

test("the output is deterministic: the same inputs give the same bytes, whatever the geometry's phase order, and ids survive a new revision", () => {
  const { hooks } = lifecycle({ [P1]: [RESIDENTS], [P2]: [{ statedOccupiedUnits: 7, unit: "jobs", source: "s" }] });
  const a = JSON.stringify(buildNewTownDemandCandidates({ hooks, geometry: EXAMPLE }));
  assert.equal(JSON.stringify(buildNewTownDemandCandidates({ hooks, geometry: EXAMPLE })), a);
  const reversed = geo(); reversed.phases = [...reversed.phases].reverse();
  assert.equal(JSON.stringify(buildNewTownDemandCandidates({ hooks, geometry: reversed })), a);
  const parsed = JSON.parse(a);
  assert.deepEqual(parsed.candidates.map((c) => c.sequence), [1, 2]);
  assert.equal(new Set(parsed.candidates.map((c) => c.candidateId)).size, 2);
  const redrawn = buildNewTownDemandCandidates({ hooks, geometry: geo({ developmentRevision: "new-town-revision:1111111111111111" }) });
  assert.deepEqual(redrawn.candidates.map((c) => c.candidateId), parsed.candidates.map((c) => c.candidateId), "a redraw changes the status, not the id");
});

test("inputs are not changed and the output shares nothing with them", () => {
  const { hooks } = lifecycle({ [P1]: [RESIDENTS] });
  const frozenHooks = deepFreeze(structuredClone(hooks));
  const frozenGeometry = deepFreeze(structuredClone(EXAMPLE));
  const before = JSON.stringify([frozenHooks, frozenGeometry]);
  const result = buildNewTownDemandCandidates({ hooks: frozenHooks, geometry: frozenGeometry });
  assert.equal(JSON.stringify([frozenHooks, frozenGeometry]), before);
  result.candidates[0].location[0] = 999; result.candidates[0].statedDemandFacts[0].quantity = 999; result.candidates[0].occupancyFactIds.length = 0;
  const again = buildNewTownDemandCandidates({ hooks: frozenHooks, geometry: frozenGeometry });
  assert.deepEqual([again.candidates[0].location, again.candidates[0].statedDemandFacts[0].quantity, again.candidates[0].occupancyFactIds.length], [EXAMPLE.phases[0].location, 120, 1]);
  // the lifecycle itself is untouched by the bridge
  const run = lifecycle({ [P1]: [RESIDENTS] });
  const snapshot = JSON.stringify(run.game.snapshot());
  buildNewTownDemandCandidates({ hooks: run.hooks, geometry: EXAMPLE });
  assert.equal(JSON.stringify(run.game.snapshot()), snapshot);
});

test("a hooks input that is not the E1 hooks is refused", () => {
  const { hooks } = lifecycle({ [P1]: [RESIDENTS] });
  for (const bad of [undefined, null, {}, "x", [], { ...hooks, schema: "other/1" }, { ...hooks, phases: null }, { ...hooks, transitions: undefined }, { ...hooks, developmentId: "" }, { ...hooks, phases: [{ phaseId: "p", occupancyFacts: null }] }]) {
    assert.throws(() => buildNewTownDemandCandidates({ hooks: bad }), /hooks/, JSON.stringify(bad)?.slice(0, 60));
  }
  assert.throws(() => buildNewTownDemandCandidates(), /hooks/);
});

test("nothing is computed: no output key names a population, rate, trip, passenger, fare, crowding, cost, score or probability", () => {
  const { hooks } = lifecycle({ [P1]: [RESIDENTS, { statedOccupiedUnits: 500, unit: "housing-units", source: "x" }] });
  const keys = [...keysOf(buildNewTownDemandCandidates({ hooks, geometry: EXAMPLE }))];
  assert.ok(keys.length > 40);
  assert.deepEqual(keys.filter((k) => /population|rate|ratio|percent|trip|passenger|fare|crowd|congest|cost|price|score|probab|weight|share|estimate/i.test(k)), []);
  assert.deepEqual(keys.filter((k) => /demand/i.test(k)).sort(), ["demandNodeRefsInside", "statedDemandFacts"]);
});

test("the module keeps its promises: no import, no B15 / management / engine state, no clock, no random number, no storage", () => {
  // the list of what is NOT computed names the forbidden words on purpose; everything else is scanned
  const source = read("../src/new-town-demand-candidates.mjs").replace(/^\s*\/\/.*$/gm, "").replace(/^export const NEW_TOWN_DEMAND_NOT_COMPUTED = .*$/m, "");
  assert.deepEqual([...source.matchAll(/^import .*$/gm)].map((m) => m[0]), []);
  assert.ok(!/require\(|import\(/.test(source));
  assert.ok(!/management|demand-engine|access-demand|passengers|scenario-runtime|state\.mjs|map\//i.test(source), "no B15 / management / engine module");
  assert.ok(!/Math\.random|Date\.|performance\.now|setTimeout|setInterval|localStorage|sessionStorage|indexedDB|process\.|fetch\(/.test(source));
  assert.ok(!/\.(residents|jobs)\s*=|demandNodes|\.points\b/.test(source), "no demand node is read or written");
  const code = source.replace(/"[^"\n]*"|`[^`\n]*`/g, '""');
  assert.ok(!/quantity\s*[-+*/]|[-+*/]\s*quantity|statedOccupiedUnits\s*[-+*/]|reduce\(|Math\./.test(code), "a stated number is copied, never computed");
  assert.ok(!/\b(population|occupancyRate|fare|crowding|probability)\b/.test(source));
});
