import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  NEW_TOWN_EXPLICIT_DEMAND_NOT_COMPUTED, NEW_TOWN_EXPLICIT_DEMAND_SOURCE_APPLICATION_SCHEMA, NEW_TOWN_EXPLICIT_DEMAND_SOURCE_SCHEMA, NEW_TOWN_EXPLICIT_DEMAND_SOURCES_SCHEMA, explicitDemandSourceIdOf,
} from "../src/new-town-explicit-demand-source.mjs";
import { ScenarioRuntime } from "../src/scenario-runtime.mjs";
import { createState } from "../src/state.mjs";

const read = (rel) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
// a real B19-M1 development, re-labelled as drawn on the scenario's own pack
const EXAMPLE = JSON.parse(read("../../packs/example-radial/new-town-development-examples/01-two-phases-with-synthetic-pond-and-road.new-town.json"));
const [P1, P2] = EXAMPLE.phases.map((p) => p.phaseId);
const GEO = { ...structuredClone(EXAMPLE), sourcePackId: "e5-pack", sourcePackVersion: "1" };
const PACK = { manifest: { id: "e5-pack", version: "1", data: { license: "test", attribution: [] } }, demand: { model: "gravity", points: [], attractors: [] } };
const PARTIES = { municipality: { name: "Example City" }, developer: { name: "Example Dev" } };
const AGREEMENT = { burdens: [{ itemId: "land", bearers: ["developer"] }] };
const RESIDENTS = { statedOccupiedUnits: 120, unit: "residents", source: "player-stated" };
const JOBS = { statedOccupiedUnits: 0, unit: "jobs", source: "player-stated" };
const HOUSING = { statedOccupiedUnits: 3, unit: "housing-units", source: "s" };
const deepFreeze = (o) => { if (o && typeof o === "object") { Object.values(o).forEach(deepFreeze); Object.freeze(o); } return o; };
const geo = (over = {}) => ({ ...structuredClone(GEO), ...over });
const candidateId = (phase = P1) => `new-town-demand-candidate:${EXAMPLE.developmentId}:${phase}`;
const factId = (n = 1, phase = P1) => `new-town-development:1:phase:${phase}:occupancy:${n}`;
const build = () => new ScenarioRuntime({ pack: PACK, operationalState: createState(PACK) });
const IDS = { intake1: "new-town-demand-intake:1", source1: explicitDemandSourceIdOf("new-town-demand-intake:1") };

function world(factsByPhase = { [P1]: [RESIDENTS] }, { geometry = GEO, runtime = build() } = {}) {
  const { id } = runtime.proposeNewTownDevelopment({ geometry, parties: PARTIES });
  runtime.agreeNewTownDevelopment(id, AGREEMENT, { geometry });
  runtime.startNewTownServicing(id, { geometry, phaseIds: [P1, P2] });
  for (const [phaseId, facts] of Object.entries(factsByPhase)) for (const fact of facts) runtime.recordNewTownOccupancy(id, phaseId, fact, { geometry });
  return { runtime, id, geometry };
}
const accept = (w, over = {}) => w.runtime.acceptNewTownDemandCandidate({ developmentRecordId: w.id, candidateId: candidateId(), statedDemandFactIds: [factId()], geometry: w.geometry, ...over });
const apply = (w, intakeId = IDS.intake1, geometry = w.geometry) => w.runtime.applyNewTownExplicitDemandSource({ intakeId, geometry });
const opState = (runtime) => structuredClone(runtime.operationalState);
const withoutSources = (state) => { const { newTownExplicitDemandSources: _s, ...rest } = state; return rest; };
const b15Reports = (runtime) => { const r = runtime.report(); return { access: r.stationDemandAccess, allocation: r.stationDemandAllocation, diagnostics: r.stationDemandAllocationDiagnostics }; };

test("no explicit acceptance, no source: pending, held, rejected and revoked intakes make no B15 input and cannot be applied", () => {
  const w = world({ [P1]: [RESIDENTS], [P2]: [HOUSING] });
  const before = opState(w.runtime);
  assert.deepEqual(w.runtime.assessNewTownExplicitDemandSources({ geometry: GEO }).sources, [], "pending candidates make nothing");
  assert.deepEqual(w.runtime.report().newTownExplicitDemandSources, []);
  assert.throws(() => apply(w), /cannot be applied: intake-not-found/);
  // revoked (P1, intake 1), then held and rejected (P2, intake 2)
  accept(w);
  w.runtime.revokeNewTownDemandCandidate(IDS.intake1, "changed my mind");
  w.runtime.holdNewTownDemandCandidate({ developmentRecordId: w.id, candidateId: candidateId(P2), reason: "wait" });
  const assessed = w.runtime.assessNewTownExplicitDemandSources({ geometry: GEO });
  assert.deepEqual(assessed.sources, [], "no source object for a held or revoked intake");
  assert.deepEqual(assessed.excluded.map((e) => [e.intakeId, e.status, e.reasons]), [["new-town-demand-intake:1", "revoked", ["intake-not-accepted:revoked"]], ["new-town-demand-intake:2", "held", ["intake-not-accepted:held"]]]);
  assert.throws(() => apply(w, "new-town-demand-intake:1"), /cannot be applied: intake-not-accepted:revoked/);
  assert.throws(() => apply(w, "new-town-demand-intake:2"), /cannot be applied: intake-not-accepted:held/);
  w.runtime.rejectNewTownDemandCandidate({ developmentRecordId: w.id, candidateId: candidateId(P2), reason: "no" });
  assert.throws(() => apply(w, "new-town-demand-intake:2"), /cannot be applied: intake-not-accepted:rejected/);
  assert.deepEqual(w.runtime.report().newTownExplicitDemandSources, []);
  assert.deepEqual(opState(w.runtime), before, "the operational state never saw any of it");
});

test("an accepted, current intake becomes exactly one explicit source whose facts are the player's, copied: 0 stays 0, nothing is added or converted", () => {
  const w = world({ [P1]: [RESIDENTS, JOBS] });
  accept(w, { statedDemandFactIds: [factId(1), factId(2)], note: "both kinds" });
  const a = w.runtime.assessNewTownExplicitDemandSources({ geometry: GEO });
  assert.equal(a.schema, NEW_TOWN_EXPLICIT_DEMAND_SOURCES_SCHEMA);
  assert.deepEqual([a.sourcePackId, a.sourcePackVersion, a.excluded], ["e5-pack", "1", []]);
  assert.equal(a.sources.length, 1);
  const { standing, applied, apply: gate, ...source } = a.sources[0];
  assert.deepEqual(source, {
    schema: NEW_TOWN_EXPLICIT_DEMAND_SOURCE_SCHEMA, contractVersion: 1, sourceId: IDS.source1, intakeId: IDS.intake1, candidateId: candidateId(), developmentRecordId: w.id, developmentId: EXAMPLE.developmentId, phaseId: P1,
    lifecycleHookId: `${w.id}:phase:${P1}`, sourcePack: { packId: "e5-pack", packVersion: "1" }, developmentRevision: EXAMPLE.developmentRevision, phaseRevision: EXAMPLE.phases[0].phaseRevision,
    lifecycle: { status: "occupied", phaseStatus: "occupied", transitionIds: w.runtime.newTownDevelopmentHooks(w.id).transitions.map((t) => t.transitionId) },
    statedDemandFactIds: [factId(1), factId(2)],
    statedDemandFacts: [
      { factId: factId(1), sequence: 1, recordedAtMinute: 0, kind: "residents", quantity: 120, source: "player-stated", note: null, unit: "residents" },
      { factId: factId(2), sequence: 2, recordedAtMinute: 0, kind: "jobs", quantity: 0, source: "player-stated", note: null, unit: "jobs" },
    ],
    basis: { derivation: "copied-as-stated", statedBy: "player", approvedBy: "new-town-demand-intake", intakeSchema: "transitline.new-town-demand-intake/1" },
  });
  assert.deepEqual([standing, applied, gate], [{ status: "current", reasons: [] }, null, { allowed: true, blockers: [] }]);
  assert.deepEqual(a.notComputed, [...NEW_TOWN_EXPLICIT_DEMAND_NOT_COMPUTED]);
  for (const word of ["quantity-sum", "residents-jobs-conversion", "ratio", "demand-node", "access-link", "b15-policy-approval"]) assert.ok(a.notComputed.includes(word), word);
  // without a map the same intake can be seen but not applied
  const blind = w.runtime.assessNewTownExplicitDemandSources().sources[0];
  assert.equal(blind.standing.status, "unverified");
  assert.equal(blind.apply.allowed, false);
  assert.ok(blind.apply.blockers.includes("intake-unverified") && blind.apply.blockers.includes("geometry-not-provided"));
  assert.throws(() => apply(w, IDS.intake1, null), /cannot be applied: intake-unverified/);
  assert.equal(w.runtime.report().newTownExplicitDemandSources.length, 0);
});

test("applying is an explicit command that writes one record and touches no demand node, access link, other source or B15 report", () => {
  const w = world();
  accept(w);
  const demandBefore = JSON.stringify(PACK.demand);
  const before = opState(w.runtime);
  const reports = b15Reports(w.runtime);
  const stored = apply(w);
  assert.equal(stored.status, "applied");
  assert.deepEqual([stored.appliedAtSimMinute, stored.withdrawal, stored.sourceId], [w.runtime.operationalState.simMinutes, null, IDS.source1]);
  const after = opState(w.runtime);
  assert.deepEqual(withoutSources(after), withoutSources(before), "everything else in the operational state is as it was");
  assert.equal(after.newTownExplicitDemandSources.schema, NEW_TOWN_EXPLICIT_DEMAND_SOURCE_APPLICATION_SCHEMA);
  assert.deepEqual(after.newTownExplicitDemandSources.sources.map((s) => s.sourceId), [IDS.source1]);
  assert.equal(w.runtime.operationalState.demandNodes.size, before.demandNodes.size);
  assert.deepEqual(w.runtime.operationalState.accessLinks, before.accessLinks);
  assert.deepEqual(b15Reports(w.runtime), reports);
  assert.equal(JSON.stringify(PACK.demand), demandBefore);
  const r = w.runtime.newTownExplicitDemandSourceReport({ geometry: GEO });
  assert.deepEqual([r.length, r[0].standing, r[0].status], [1, { status: "current", reasons: [] }, "applied"]);
  assert.equal(w.runtime.report().newTownExplicitDemandSources[0].standing.status, "unverified", "report() has no map, so it can only say unverified");
  assert.equal(w.runtime.assessNewTownExplicitDemandSources({ geometry: GEO }).sources[0].applied, "applied");
  assert.throws(() => apply(w), /intake-already-applied:new-town-explicit-demand-source:new-town-demand-intake:1/);
  assert.ok(w.runtime.game.events.entries.some((e) => e.type === "new-town-explicit-demand-source-applied"));
});

test("after applying, a changed map, pack, occupancy fact, lifecycle or revoked intake leaves the source in place and reports it stale - never applied again or repaired", () => {
  const check = (label, change, geometry, reasons) => {
    const w = world();
    accept(w);
    apply(w);
    const stored = structuredClone(w.runtime.operationalState.newTownExplicitDemandSources);
    change?.(w);
    const [row] = w.runtime.newTownExplicitDemandSourceReport({ geometry });
    assert.equal(row.standing.status, "stale", label);
    for (const reason of reasons) assert.ok(row.standing.reasons.includes(reason), `${label}: ${reason} in ${row.standing.reasons}`);
    assert.equal(row.status, "applied", `${label}: not withdrawn on its own`);
    assert.deepEqual(w.runtime.operationalState.newTownExplicitDemandSources, stored, `${label}: the stored record is untouched`);
    assert.throws(() => apply(w), /cannot be applied: /, label);
    assert.equal(w.runtime.operationalState.newTownExplicitDemandSources.sources.length, 1, `${label}: no second source`);
  };
  check("map revision", null, geo({ developmentRevision: "new-town-revision:changed" }), ["geometry-stale", "geometry-revision-changed"]);
  check("another pack's map", null, geo({ sourcePackId: "other-pack" }), ["geometry-other-pack"]);
  check("map switched off", null, geo({ active: false }), ["geometry-inactive"]);
  check("a new occupancy fact", ({ runtime, id }) => runtime.recordNewTownOccupancy(id, P1, { statedOccupiedUnits: 130, unit: "residents", source: "player-stated" }, { geometry: GEO }), GEO, ["occupancy-facts-changed"]);
  check("a delay", ({ runtime, id }) => runtime.delayNewTownDevelopment(id, "late"), GEO, ["lifecycle-status-changed"]);
  check("a cancelled development", ({ runtime, id }) => runtime.cancelNewTownDevelopment(id, "stopped"), GEO, ["lifecycle-cancelled"]);
  check("a revoked intake", ({ runtime }) => runtime.revokeNewTownDemandCandidate(IDS.intake1, "no longer wanted"), GEO, ["intake-revoked"]);
  // the stale intake itself cannot be applied either
  const w = world();
  accept(w);
  assert.throws(() => apply(w, IDS.intake1, geo({ developmentRevision: "new-town-revision:changed" })), /cannot be applied: intake-stale, .*geometry-revision-changed/);
  assert.deepEqual(w.runtime.report().newTownExplicitDemandSources, []);
});

test("one live source per candidate: nothing is overwritten; the old source must be withdrawn by the player, and a withdrawn one never comes back", () => {
  const w = world();
  accept(w);
  apply(w);
  w.runtime.revokeNewTownDemandCandidate(IDS.intake1, "re-decide");
  const second = accept(w);
  assert.equal(second.id, "new-town-demand-intake:2");
  const secondSource = explicitDemandSourceIdOf("new-town-demand-intake:2");
  const before = structuredClone(w.runtime.operationalState.newTownExplicitDemandSources);
  assert.throws(() => apply(w, "new-town-demand-intake:2"), new RegExp(`cannot be applied: candidate-already-has-source:${IDS.source1}`));
  assert.deepEqual(w.runtime.operationalState.newTownExplicitDemandSources, before, "the first source was not overwritten");
  assert.throws(() => w.runtime.withdrawNewTownExplicitDemandSource(IDS.source1, ""), /A withdrawal reason must be/);
  assert.throws(() => w.runtime.withdrawNewTownExplicitDemandSource("new-town-explicit-demand-source:nope", "x"), /Unknown new town explicit demand source/);
  const withdrawn = w.runtime.withdrawNewTownExplicitDemandSource(IDS.source1, "replaced by the new approval");
  assert.deepEqual([withdrawn.status, withdrawn.withdrawal.reason], ["withdrawn", "replaced by the new approval"]);
  assert.equal(w.runtime.newTownExplicitDemandSourceReport({ geometry: GEO })[0].standing.status, "withdrawn");
  assert.throws(() => w.runtime.withdrawNewTownExplicitDemandSource(IDS.source1, "again"), /status-not-allowed:withdrawn/);
  assert.throws(() => apply(w, IDS.intake1), /cannot be applied: intake-not-accepted:revoked/);
  assert.equal(apply(w, "new-town-demand-intake:2").sourceId, secondSource);
  assert.deepEqual(w.runtime.newTownExplicitDemandSourceReport({ geometry: GEO }).map((s) => [s.sourceId, s.status, s.standing.status]), [[IDS.source1, "withdrawn", "withdrawn"], [secondSource, "applied", "current"]]);
});

test("a withdrawn source's intake, if still accepted, cannot be applied again", () => {
  const w = world();
  accept(w);
  apply(w);
  w.runtime.withdrawNewTownExplicitDemandSource(IDS.source1, "taken back");
  assert.throws(() => apply(w), new RegExp(`cannot be applied: intake-source-withdrawn:${IDS.source1}`));
});

test("a source from another pack or pack version is refused: packs are never mixed", () => {
  const other = world({ [P1]: [RESIDENTS] }, { geometry: geo({ sourcePackId: "other-pack" }) });
  accept(other);
  const before = opState(other.runtime);
  assert.throws(() => apply(other), /cannot be applied: source-pack-differs-from-scenario:other-pack/);
  assert.deepEqual(opState(other.runtime), before);
  assert.equal(other.runtime.assessNewTownExplicitDemandSources({ geometry: other.geometry }).sources[0].apply.allowed, false);
  const version = world({ [P1]: [RESIDENTS] }, { geometry: geo({ sourcePackVersion: "2" }) });
  accept(version);
  assert.throws(() => apply(version), /cannot be applied: source-pack-version-differs-from-scenario:2/);
  // a pack version that was not stated is unknown, not a mismatch
  const unversioned = world({ [P1]: [RESIDENTS] }, { geometry: geo({ sourcePackVersion: null }) });
  accept(unversioned);
  assert.equal(apply(unversioned).sourcePack.packVersion, null, "null is kept as null");
});

test("save, load and rollback: the sources survive a runtime save byte for byte, an old save loads with none, and a failed apply leaves nothing behind", () => {
  const w = world();
  accept(w);
  apply(w);
  const text = w.runtime.save();
  assert.equal(w.runtime.save(), text, "saving twice gives the same bytes");
  const other = build();
  other.load(text);
  assert.deepEqual(other.newTownExplicitDemandSourceReport({ geometry: GEO }), w.runtime.newTownExplicitDemandSourceReport({ geometry: GEO }));
  const sourcesOf = (saved) => JSON.stringify(JSON.parse(saved).operations.newTownExplicitDemandSources);
  assert.equal(sourcesOf(other.save()), sourcesOf(text), "the sources come back byte for byte");
  const third = build();
  third.load(other.save());
  assert.equal(third.save(), other.save(), "and a second load and save changes nothing");
  assert.deepEqual(other.operationalState.newTownExplicitDemandSources, w.runtime.operationalState.newTownExplicitDemandSources);
  // a save made before B19-E5 has no such key
  const old = JSON.parse(text);
  delete old.operations.newTownExplicitDemandSources;
  const legacy = build();
  legacy.load(JSON.stringify(old));
  assert.deepEqual(legacy.report().newTownExplicitDemandSources, []);
  assert.equal(legacy.operationalState.newTownExplicitDemandSources, undefined);
  assert.equal(legacy.assessNewTownExplicitDemandSources({ geometry: GEO }).sources[0].applied, null, "the intake is still there, the source is not");
  assert.equal(apply({ runtime: legacy, geometry: GEO }).sourceId, IDS.source1);
  // a failure inside the transaction: operational state and management state both come back
  const f = world();
  accept(f);
  const operationalBefore = opState(f.runtime);
  const managementBefore = JSON.stringify(f.runtime.game.snapshot());
  f.runtime.game.events.record = () => { throw new Error("log failed"); };
  assert.throws(() => apply(f), /log failed/);
  assert.deepEqual(opState(f.runtime), operationalBefore);
  assert.equal(JSON.stringify(f.runtime.game.snapshot()), managementBefore);
  assert.equal(f.runtime.operationalState.newTownExplicitDemandSources, undefined);
  assert.equal(apply(f).sourceId, IDS.source1, "and the same apply works afterwards");
  f.runtime.game.events.record = () => { throw new Error("log failed again"); };
  assert.throws(() => f.runtime.withdrawNewTownExplicitDemandSource(IDS.source1, "x"), /log failed again/);
  assert.equal(f.runtime.operationalState.newTownExplicitDemandSources.sources[0].status, "applied", "a failed withdrawal changes nothing");
});

test("frozen inputs are never changed, outputs share nothing with the state, and no random number, clock or money is touched", () => {
  const w = world();
  const geometry = deepFreeze(structuredClone(GEO));
  accept(w, { geometry });
  const input = deepFreeze({ intakeId: IDS.intake1, geometry });
  const copy = structuredClone(input);
  const rngBefore = w.runtime.operationalState.rng.snapshot();
  const gameBefore = w.runtime.game.snapshot();
  w.runtime.assessNewTownExplicitDemandSources({ geometry });
  const stored = w.runtime.applyNewTownExplicitDemandSource(input);
  w.runtime.newTownExplicitDemandSourceReport({ geometry });
  assert.deepEqual(input, copy);
  assert.deepEqual(geometry, GEO);
  assert.deepEqual(w.runtime.operationalState.rng.snapshot(), rngBefore, "no random number");
  const gameAfter = w.runtime.game.snapshot();
  for (const key of ["rngState", "constructionEventRngState", "clock", "ledger", "player", "newTownDevelopments", "newTownDemandIntakes"]) assert.deepEqual(gameAfter[key], gameBefore[key], key);
  stored.statedDemandFacts[0].quantity = 999;
  stored.statedDemandFactIds.push("x");
  w.runtime.report().newTownExplicitDemandSources[0].statedDemandFacts[0].quantity = 777;
  const assessed = w.runtime.assessNewTownExplicitDemandSources({ geometry });
  assessed.sources[0].statedDemandFacts[0].quantity = 555;
  const now = w.runtime.operationalState.newTownExplicitDemandSources.sources[0];
  assert.equal(now.statedDemandFacts[0].quantity, 120);
  assert.deepEqual(now.statedDemandFactIds, [factId()]);
});

test("the same steps give the same ids and the same bytes, whatever order the reads are made in", () => {
  const run = (reads) => {
    const w = world({ [P1]: [RESIDENTS], [P2]: [JOBS] });
    accept(w);
    accept(w, { candidateId: candidateId(P2), statedDemandFactIds: [factId(1, P2)] });
    for (const read of reads) read(w);
    apply(w, IDS.intake1);
    apply(w, "new-town-demand-intake:2");
    return w.runtime.save();
  };
  const a = run([(w) => w.runtime.assessNewTownExplicitDemandSources({ geometry: GEO }), (w) => w.runtime.report()]);
  const b = run([(w) => w.runtime.report(), (w) => w.runtime.newTownExplicitDemandSourceReport({ geometry: GEO }), (w) => w.runtime.assessNewTownExplicitDemandSources()]);
  assert.equal(a, b);
  assert.deepEqual(JSON.parse(a).operations.newTownExplicitDemandSources.sources.map((s) => s.sourceId), [explicitDemandSourceIdOf("new-town-demand-intake:1"), explicitDemandSourceIdOf("new-town-demand-intake:2")]);
});

test("the module imports nothing, names no demand node or access link, and does arithmetic on no figure", () => {
  const source = read("../src/new-town-explicit-demand-source.mjs");
  const code = source.replace(/\/\/.*$/gm, "");
  assert.ok(Buffer.byteLength(source) < 40_000);
  assert.deepEqual([...source.matchAll(/^import .*from "([^"]+)"/gm)], []);
  assert.equal(/demandNodes|accessLinks|\.stations|rng|clock|Math\.|Number\(|parseFloat|parseInt|\.reduce\(|Date\.now|new Date|setTimeout/.test(code), false);
  assert.equal(/\.quantity|\+=/.test(code), false);
});
