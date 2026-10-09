// B19-R1: an audit of the whole B19 chain (E1 lifecycle -> E3 rail contribution -> E4 intake -> E5 explicit demand source) through a real
// ScenarioRuntime: save and restore at every stage, the same staleness seen by every link, pack mixing, saves from before each B19 step,
// atomic rollback of every command, ids that are never reused, and isolation from B15 state, the random generator, the clock and money.
// It changes no production code: it states what the chain already promises, in one place, so a regression in any link is caught here.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { ScenarioRuntime } from "../src/scenario-runtime.mjs";
import { createState } from "../src/state.mjs";

const read = (rel) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const EXAMPLE = JSON.parse(read("../../packs/example-radial/new-town-development-examples/01-two-phases-with-synthetic-pond-and-road.new-town.json"));
const [P1, P2] = EXAMPLE.phases.map((p) => p.phaseId);
const PACK = { manifest: { id: "r1-pack", version: "1", data: { license: "test", attribution: [] } }, demand: { model: "gravity", points: [], attractors: [] } };
const OTHER_PACK = { manifest: { id: "r1-other-pack", version: "1", data: { license: "test", attribution: [] } }, demand: { model: "gravity", points: [], attractors: [] } };
const deepFreeze = (o) => { if (o && typeof o === "object") { Object.values(o).forEach(deepFreeze); Object.freeze(o); } return o; };
const build = (pack = PACK) => new ScenarioRuntime({ pack, operationalState: createState(pack) });
const geo = (over = {}) => ({ ...structuredClone(EXAMPLE), sourcePackId: "r1-pack", sourcePackVersion: "1", ...over });

const D = "new-town-development:1";
const C = "new-town-rail-contribution:1";
const AMOUNT = 3_000_000_000;
const candidateId = (phase) => `new-town-demand-candidate:${EXAMPLE.developmentId}:${phase}`;
const factId = (phase, development = D) => `${development}:phase:${phase}:occupancy:1`;
const SOURCE = (n) => `new-town-explicit-demand-source:new-town-demand-intake:${n}`;

// every payload and the geometry of a run, optionally deep-frozen
function kit(freeze = false) {
  const k = {
    geometry: geo(), parties: { municipality: { name: "Example City" }, developer: { name: "Example Dev" } }, agreement: { burdens: [{ itemId: "land", bearers: ["developer"] }] },
    residents: { statedOccupiedUnits: 120, unit: "residents", source: "player-stated" }, jobs: { statedOccupiedUnits: 0, unit: "jobs", source: "player-stated" },
    contribution: { developmentRecordId: D, payerKind: "municipality", payeeKind: "player-railway", statedPurpose: "station", statedAmountYen: AMOUNT, phaseIds: [P1], linkedPlanIds: ["plan:1"], linkedStationSiteIds: ["site:1"], conditions: [{ conditionId: "c1", text: "The station opens before phase 1 is serviced" }] },
    confirm: { confirmedAmountYen: AMOUNT, confirmedBy: "payer", reference: "municipal council resolution" },
    currentLinks: { planIds: ["plan:1"], stationSiteIds: ["site:1"] }, conditionConfirmations: [{ conditionId: "c1", note: "station opened" }],
  };
  return freeze ? deepFreeze(k) : k;
}
const ctx = (k, over = {}) => ({ geometry: k.geometry, currentLinks: k.currentLinks, ...over });
const decision = (k, phase, extra = {}) => ({ developmentRecordId: D, candidateId: candidateId(phase), geometry: k.geometry, ...extra });

// the whole chain as a script; each step is one runtime command
const STEPS = [
  ["e1.draft", (r, k) => r.draftNewTownDevelopment({ geometry: k.geometry, parties: k.parties })],
  ["e1.propose", (r, k) => r.proposeNewTownDevelopment({ id: D, geometry: k.geometry })],
  ["e1.agree", (r, k) => r.agreeNewTownDevelopment(D, k.agreement, { geometry: k.geometry })],
  ["e1.startServicing", (r, k) => r.startNewTownServicing(D, { geometry: k.geometry, phaseIds: [P1, P2] })],
  ["e1.recordOccupancy.p1", (r, k) => r.recordNewTownOccupancy(D, P1, k.residents, { geometry: k.geometry })],
  ["e1.recordOccupancy.p2", (r, k) => r.recordNewTownOccupancy(D, P2, k.jobs, { geometry: k.geometry })],
  ["e3.draft", (r, k) => r.draftNewTownRailContribution(k.contribution)],
  ["e3.propose", (r, k) => r.proposeNewTownRailContribution(C, ctx(k))],
  ["e3.agree", (r, k) => r.agreeNewTownRailContribution(C, {}, ctx(k))],
  ["e3.fund", (r, k) => r.fundNewTownRailContribution(C, k.confirm, ctx(k))],
  ["e4.accept.p1", (r, k) => r.acceptNewTownDemandCandidate(decision(k, P1, { statedDemandFactIds: [factId(P1)], note: "audit" }))],
  ["e5.apply.p1", (r, k) => r.applyNewTownExplicitDemandSource({ intakeId: "new-town-demand-intake:1", geometry: k.geometry })],
  ["e4.hold.p2", (r, k) => r.holdNewTownDemandCandidate(decision(k, P2, { reason: "wait" }))],
  ["e4.reject.p2", (r, k) => r.rejectNewTownDemandCandidate(decision(k, P2, { reason: "no" }))],
  ["e4.accept.p2", (r, k) => r.acceptNewTownDemandCandidate(decision(k, P2, { statedDemandFactIds: [factId(P2)] }))],
  ["e5.apply.p2", (r, k) => r.applyNewTownExplicitDemandSource({ intakeId: "new-town-demand-intake:2", geometry: k.geometry })],
  ["e5.withdraw.p2", (r) => r.withdrawNewTownExplicitDemandSource(SOURCE(2), "taken back")],
  ["e4.revoke.p2", (r) => r.revokeNewTownDemandCandidate("new-town-demand-intake:2", "re-decide")],
  ["e3.delay", (r) => r.delayNewTownRailContribution(C, "the municipal budget is late")],
  ["e3.resume", (r, k) => r.resumeNewTownRailContribution(C, ctx(k))],
  ["e1.delay", (r) => r.delayNewTownDevelopment(D, "land permit is late")],
  ["e1.resume", (r, k) => r.resumeNewTownDevelopment(D, { geometry: k.geometry })],
  ["e3.release", (r, k) => r.releaseNewTownRailContribution(C, ctx(k, { conditionConfirmations: k.conditionConfirmations }))],
  ["e5.withdraw.p1", (r) => r.withdrawNewTownExplicitDemandSource(SOURCE(1), "taken back")],
  ["e4.revoke.p1", (r) => r.revokeNewTownDemandCandidate("new-town-demand-intake:1", "re-decide")],
  ["e1.cancel", (r) => r.cancelNewTownDevelopment(D, "player stopped it")],
];
const indexOf = (name) => STEPS.findIndex(([n]) => n === name);
const runStep = (name, w) => STEPS[indexOf(name)][1](w.runtime, w.k);
function world({ freeze = false, upTo = null, pack = PACK } = {}) {
  const runtime = build(pack);
  runtime.game.projects.push({ id: "project:1", status: "active" });
  const w = { runtime, k: kit(freeze) };
  if (upTo !== null) for (const [, run] of STEPS.slice(0, indexOf(upTo) + 1)) run(runtime, w.k);
  return w;
}
const reports = (r, geometry = null) => ({
  developments: r.newTownDevelopmentReport(), contributions: r.newTownRailContributionReport(), intakes: r.newTownDemandIntakeReport(null, { geometry }), sources: r.newTownExplicitDemandSourceReport({ geometry }),
});
const opsOf = (r) => JSON.parse(r.save()).operations;
const mgmtOf = (r) => JSON.parse(r.save()).management;
const withoutKey = (o, key) => { const { [key]: _gone, ...rest } = o; return rest; };
const withoutSources = (o) => withoutKey(o, "newTownExplicitDemandSources");

test("every stage survives a runtime save and restore: the four B19 stores, their standing and the next ids, byte for byte after the first load", () => {
  const straight = world();
  const resumed = world();
  let carried = resumed.runtime;
  for (const [name, run] of STEPS.slice(0, indexOf("e5.apply.p2") + 1)) {
    run(straight.runtime, straight.k);
    run(carried, resumed.k);
    // save, load into a brand-new runtime, and carry on from that one
    const next = build();
    next.load(carried.save());
    assert.deepEqual(reports(next, resumed.k.geometry), reports(carried, resumed.k.geometry), `${name}: reports after load`);
    carried = next;
  }
  const normalise = (r) => { const again = build(); again.load(r.save()); return again.save(); };
  const firstDifference = (p, q, path = "") => {
    if (JSON.stringify(p) === JSON.stringify(q)) return null;
    if (p && q && typeof p === "object" && typeof q === "object") for (const key of new Set([...Object.keys(p), ...Object.keys(q)])) { const d = firstDifference(p[key], q[key], `${path}.${key}`); if (d) return d; }
    return `${path}: ${JSON.stringify(p)?.slice(0, 120)} vs ${JSON.stringify(q)?.slice(0, 120)}`;
  };
  // Finding (see the B19-R1 doc): the order of keys in `operations` follows the history of the state object - a key added after a load sits
  // after the restored ones - so two equal saves can differ in key order only.  Content is compared with the keys sorted.
  const sorted = (v) => (Array.isArray(v) ? v.map(sorted) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])])) : v);
  assert.equal(firstDifference(sorted(JSON.parse(normalise(straight.runtime))), sorted(JSON.parse(carried.save()))), null, "a run that was saved and loaded at every step ends in the same save as one that never was");
  assert.equal(JSON.stringify(sorted(JSON.parse(normalise(straight.runtime)))), JSON.stringify(sorted(JSON.parse(carried.save()))), "and in the same bytes once the keys are in order");
  // the same history always gives the same raw bytes
  assert.equal(world({ upTo: "e5.apply.p2" }).runtime.save(), straight.runtime.save());
  // the loaded runtime keeps handing out the next ids
  assert.equal(carried.draftNewTownRailContribution(resumed.k.contribution).contributionId, "new-town-rail-contribution:2");
});

test("one change of the map, seen by every link: E1, E3, E4 and E5 all call it stale, nothing stored changes, and nothing can go forward", () => {
  const changes = [
    ["map revision", () => geo({ developmentRevision: "new-town-revision:changed" }), "geometry-stale"],
    ["another pack's map", () => geo({ sourcePackId: "r1-other-pack" }), "geometry-stale"],
    ["map switched off", () => geo({ active: false }), "geometry-inactive"],
  ];
  for (const [label, makeGeometry, e1Blocker] of changes) {
    const w = world({ upTo: "e5.apply.p1" });
    const stored = { ops: opsOf(w.runtime), mgmt: mgmtOf(w.runtime) };
    const geometry = makeGeometry();
    const e1 = w.runtime.assessNewTownDevelopment({ id: D, geometry });
    for (const kind of ["agree", "startServicing", "recordOccupancy", "resume"]) assert.ok(e1.transitions[kind].blockers.includes(e1Blocker), `${label}: E1 ${kind} blocked by ${e1Blocker}`);
    assert.equal(e1.transitions.cancel.allowed, true, `${label}: stopping never needs the map`);
    const e3 = w.runtime.assessNewTownRailContribution({ id: C, geometry, currentLinks: w.k.currentLinks });
    assert.equal(e3.transitions.release.allowed, false, `${label}: E3 release is blocked`);
    assert.ok(e3.transitions.release.blockers.some((b) => /geometry/.test(b)), `${label}: E3 says why: ${e3.transitions.release.blockers}`);
    assert.equal(e3.transitions.terminate.allowed, true, `${label}: terminating needs no map`);
    const intake = w.runtime.newTownDemandIntakeReport(null, { geometry })[0];
    assert.deepEqual([intake.status, intake.standing.currentStatus], ["accepted", "stale"], `${label}: E4`);
    const source = w.runtime.newTownExplicitDemandSourceReport({ geometry })[0];
    assert.deepEqual([source.status, source.standing.status], ["applied", "stale"], `${label}: E5`);
    assert.throws(() => w.runtime.applyNewTownExplicitDemandSource({ intakeId: "new-town-demand-intake:1", geometry }), /cannot be applied/);
    assert.throws(() => w.runtime.acceptNewTownDemandCandidate(decision({ geometry }, P2, { statedDemandFactIds: [factId(P2)] })), /cannot accept: /);
    assert.deepEqual({ ops: opsOf(w.runtime), mgmt: mgmtOf(w.runtime) }, stored, `${label}: reading never changed a thing`);
  }
});

test("a change that is not the map's - an occupancy fact, a delay, a cancellation, a revocation - stales exactly the links that depend on it", () => {
  const cases = [
    ["a new occupancy fact", (w) => w.runtime.recordNewTownOccupancy(D, P1, { statedOccupiedUnits: 130, unit: "residents", source: "player-stated" }, { geometry: w.k.geometry }), "occupancy-facts-changed"],
    ["a development delay", (w) => w.runtime.delayNewTownDevelopment(D, "late"), "lifecycle-status-changed"],
    ["a development cancellation", (w) => w.runtime.cancelNewTownDevelopment(D, "stopped"), "lifecycle-cancelled"],
  ];
  for (const [label, change, reason] of cases) {
    const w = world({ upTo: "e5.apply.p1" });
    const contributionBefore = w.runtime.newTownRailContributionReport();
    change(w);
    const [intake] = w.runtime.newTownDemandIntakeReport(null, { geometry: w.k.geometry });
    const [source] = w.runtime.newTownExplicitDemandSourceReport({ geometry: w.k.geometry });
    assert.equal(intake.standing.currentStatus, "stale", label);
    assert.ok(intake.standing.verification.reasons.includes(reason) && source.standing.reasons.includes(reason), `${label}: ${reason}`);
    assert.deepEqual([intake.status, source.status], ["accepted", "applied"], `${label}: nothing was withdrawn or revoked behind the player's back`);
    assert.deepEqual(w.runtime.newTownRailContributionReport(), contributionBefore, `${label}: the contribution record is untouched`);
    assert.throws(() => w.runtime.applyNewTownExplicitDemandSource({ intakeId: "new-town-demand-intake:1", geometry: w.k.geometry }), /cannot be applied/);
  }
  const w = world({ upTo: "e5.apply.p1" });
  w.runtime.revokeNewTownDemandCandidate("new-town-demand-intake:1", "no");
  assert.deepEqual(w.runtime.newTownExplicitDemandSourceReport({ geometry: w.k.geometry })[0].standing, { status: "stale", reasons: ["intake-revoked"] });
  // controls: reading, saving and loading make nothing stale
  const c = world({ upTo: "e5.apply.p1" });
  const loaded = build();
  loaded.load(c.runtime.save());
  assert.equal(loaded.newTownDemandIntakeReport(null, { geometry: c.k.geometry })[0].standing.verification.status, "current");
  assert.equal(loaded.newTownExplicitDemandSourceReport({ geometry: c.k.geometry })[0].standing.status, "current");
});

test("packs are never mixed: a save refuses another pack, and another pack's map or development never reaches B15", () => {
  const w = world({ upTo: "e5.apply.p1" });
  const text = w.runtime.save();
  assert.throws(() => build(OTHER_PACK).load(text), /pack/i, "a save of one pack does not load into another");
  const bumped = JSON.parse(text);
  bumped.packVersion = "2";
  assert.throws(() => build().load(JSON.stringify(bumped)), /pack version/i);
  // a development drawn on another pack is recorded with that pack, and E5 will not take it
  const foreign = world();
  const geometry = geo({ sourcePackId: "r1-other-pack" });
  const { id } = foreign.runtime.proposeNewTownDevelopment({ geometry, parties: foreign.k.parties });
  foreign.runtime.agreeNewTownDevelopment(id, foreign.k.agreement, { geometry });
  foreign.runtime.startNewTownServicing(id, { geometry, phaseIds: [P1, P2] });
  foreign.runtime.recordNewTownOccupancy(id, P1, foreign.k.residents, { geometry });
  assert.equal(foreign.runtime.newTownDevelopmentReport(id)[0].sourcePack.packId, "r1-other-pack");
  foreign.runtime.acceptNewTownDemandCandidate({ developmentRecordId: id, candidateId: candidateId(P1), statedDemandFactIds: [factId(P1, id)], geometry });
  assert.throws(() => foreign.runtime.applyNewTownExplicitDemandSource({ intakeId: "new-town-demand-intake:1", geometry }), /source-pack-differs-from-scenario:r1-other-pack/);
  assert.deepEqual(foreign.runtime.report().newTownExplicitDemandSources, []);
  assert.equal(foreign.runtime.assessNewTownExplicitDemandSources({ geometry }).sources[0].apply.allowed, false);
  // this scenario's own map for the other pack's record is "other pack", not current
  const [intake] = foreign.runtime.newTownDemandIntakeReport(null, { geometry: geo() });
  assert.equal(intake.standing.currentStatus, "stale");
  assert.ok(intake.standing.verification.reasons.some((r) => /pack/.test(r)), intake.standing.verification.reasons.join());
});

// Finding F-3 (see the B19-R1 doc): the scenario's own pack is compared only at E5.  E1, E3 and E4 take the pack from the geometry they are
// handed, so a development drawn on another pack can be drafted, agreed and - the one money step - RELEASED into this scenario's ledger.
// This states the wanted behaviour; it is `todo` until the owner decides where the guard belongs (runtime wrapper for release/propose).
test("a contribution for a development drawn on another pack is not released into this scenario's ledger", { todo: "F-3: no scenario-pack check before E3 release" }, () => {
  const w = world();
  const geometry = geo({ sourcePackId: "r1-other-pack", sourcePackVersion: "9" });
  const dev = w.runtime.proposeNewTownDevelopment({ geometry, parties: w.k.parties });
  const c = w.runtime.draftNewTownRailContribution({ ...w.k.contribution, developmentRecordId: dev.id });
  const context = { geometry, currentLinks: w.k.currentLinks };
  w.runtime.proposeNewTownRailContribution(c.contributionId, context);
  w.runtime.agreeNewTownRailContribution(c.contributionId, {}, context);
  w.runtime.fundNewTownRailContribution(c.contributionId, w.k.confirm, context);
  const cash = w.runtime.game.ledger.cash;
  assert.throws(() => w.runtime.releaseNewTownRailContribution(c.contributionId, { ...context, conditionConfirmations: w.k.conditionConfirmations }));
  assert.equal(w.runtime.game.ledger.cash, cash);
});

test("saves from before each B19 step still load: missing stores are empty, ids carry on, and a half-present chain never throws", () => {
  const w = world({ upTo: "e5.apply.p1" });
  const text = w.runtime.save();
  const variants = {
    "before E5": (s) => { delete s.operations.newTownExplicitDemandSources; },
    "before E4": (s) => { delete s.operations.newTownExplicitDemandSources; delete s.management.newTownDemandIntakes; delete s.management.nextNewTownDemandIntakeSequence; },
    "before E3": (s) => { delete s.operations.newTownExplicitDemandSources; delete s.management.newTownDemandIntakes; delete s.management.nextNewTownDemandIntakeSequence; delete s.management.newTownRailContributions; delete s.management.nextNewTownRailContributionSequence; },
    "before B19": (s) => { delete s.operations.newTownExplicitDemandSources; for (const key of ["newTownDemandIntakes", "nextNewTownDemandIntakeSequence", "newTownRailContributions", "nextNewTownRailContributionSequence", "newTownDevelopments", "nextNewTownDevelopmentSequence"]) delete s.management[key]; },
    "intakes lost, source kept": (s) => { delete s.management.newTownDemandIntakes; },
    "developments lost, rest kept": (s) => { delete s.management.newTownDevelopments; },
  };
  for (const [label, damage] of Object.entries(variants)) {
    const save = JSON.parse(text);
    damage(save);
    const r = build();
    r.load(JSON.stringify(save));
    const full = reports(r, w.k.geometry);
    assert.doesNotThrow(() => r.report(), `${label}: report()`);
    assert.doesNotThrow(() => r.assessNewTownExplicitDemandSources({ geometry: w.k.geometry }), `${label}: assess`);
    const expectEmpty = { "before E5": ["sources"], "before E4": ["intakes", "sources"], "before E3": ["contributions", "intakes", "sources"], "before B19": ["developments", "contributions", "intakes", "sources"] }[label] ?? [];
    for (const store of expectEmpty) assert.deepEqual(full[store], [], `${label}: ${store} is empty`);
    if (label === "intakes lost, source kept") assert.deepEqual([full.sources[0].status, full.sources[0].standing], ["applied", { status: "stale", reasons: ["intake-record-missing"] }], "a source whose intake is gone is stale, not valid");
    if (label === "developments lost, rest kept") {
      assert.equal(full.intakes[0].standing.currentStatus, "stale");
      assert.ok(full.intakes[0].standing.verification.reasons.includes("development-record-missing"));
      assert.equal(full.sources[0].standing.status, "stale");
      // the counter outlived the records, so a new development does not take over the old one's id
      assert.equal(r.draftNewTownDevelopment({ geometry: w.k.geometry, parties: w.k.parties }).id, "new-town-development:2");
    }
    if (label === "before E5") assert.equal(r.applyNewTownExplicitDemandSource({ intakeId: "new-town-demand-intake:1", geometry: w.k.geometry }).sourceId, SOURCE(1), `${label}: the apply works on the old save`);
    if (label === "before E4") assert.equal(r.acceptNewTownDemandCandidate(decision(w.k, P1, { statedDemandFactIds: [factId(P1)] })).id, "new-town-demand-intake:1");
    if (label === "before E3") assert.equal(r.draftNewTownRailContribution(w.k.contribution).contributionId, C);
    if (label === "before B19") assert.equal(r.draftNewTownDevelopment({ geometry: w.k.geometry, parties: w.k.parties }).id, D);
  }
});

test("every command of the chain is atomic: a failure after the work leaves the whole save as it was, and the same command then succeeds", () => {
  for (let i = 0; i < STEPS.length; i += 1) {
    const [name, run] = STEPS[i];
    const w = world();
    for (const [, before] of STEPS.slice(0, i)) before(w.runtime, w.k);
    const saved = w.runtime.save();
    w.runtime.game.events.record = () => { throw new Error("log failed"); };
    assert.throws(() => run(w.runtime, w.k), /log failed/, name);
    assert.equal(w.runtime.save(), saved, `${name}: nothing changed`);
    assert.doesNotThrow(() => run(w.runtime, w.k), `${name}: and it works afterwards`);
    assert.notEqual(w.runtime.save(), saved, `${name}: and then it did change something`);
  }
  // terminating (the other end of a contribution) too
  const w = world({ upTo: "e3.fund" });
  const saved = w.runtime.save();
  w.runtime.game.events.record = () => { throw new Error("log failed"); };
  assert.throws(() => w.runtime.terminateNewTownRailContribution(C, "the agreement fell through"), /log failed/);
  assert.equal(w.runtime.save(), saved);
  assert.equal(w.runtime.terminateNewTownRailContribution(C, "the agreement fell through").status, "terminated");
});

test("ids are never reused: after revocations, withdrawals, cancellations and a load, every next id is new", () => {
  const w = world({ upTo: "e1.cancel" });
  const r = build();
  r.load(w.runtime.save());
  assert.deepEqual(r.newTownDemandIntakeReport().map((i) => [i.id, i.status]), [["new-town-demand-intake:1", "revoked"], ["new-town-demand-intake:2", "revoked"]]);
  const D2 = "new-town-development:2";
  assert.equal(r.draftNewTownDevelopment({ geometry: w.k.geometry, parties: w.k.parties }).id, D2, "the cancelled development's id is not reused");
  r.proposeNewTownDevelopment({ id: D2, geometry: w.k.geometry });
  r.agreeNewTownDevelopment(D2, w.k.agreement, { geometry: w.k.geometry });
  r.startNewTownServicing(D2, { geometry: w.k.geometry, phaseIds: [P1, P2] });
  r.recordNewTownOccupancy(D2, P1, w.k.residents, { geometry: w.k.geometry });
  const intake = r.acceptNewTownDemandCandidate({ developmentRecordId: D2, candidateId: candidateId(P1), statedDemandFactIds: [factId(P1, D2)], geometry: w.k.geometry });
  assert.equal(intake.id, "new-town-demand-intake:3");
  assert.equal(r.applyNewTownExplicitDemandSource({ intakeId: intake.id, geometry: w.k.geometry }).sourceId, SOURCE(3));
  assert.equal(r.draftNewTownRailContribution({ ...w.k.contribution, developmentRecordId: D2 }).contributionId, "new-town-rail-contribution:2");
  assert.deepEqual(r.newTownExplicitDemandSourceReport({ geometry: w.k.geometry }).map((s) => [s.sourceId, s.status]), [[SOURCE(1), "withdrawn"], [SOURCE(2), "withdrawn"], [SOURCE(3), "applied"]]);
});

test("isolation: the chain moves no B15 state, random number or clock, and money moves exactly once - at the contribution's release", () => {
  const start = world();
  const startOps = opsOf(start.runtime);
  const startMgmt = mgmtOf(start.runtime);
  const w = world({ upTo: "e3.resume" });
  const mid = { ops: opsOf(w.runtime), mgmt: mgmtOf(w.runtime) };
  assert.deepEqual(withoutSources(mid.ops), withoutSources(startOps), "the operational state is the same apart from the source record");
  for (const key of ["rngState", "constructionEventRngState", "clock", "ledger", "player"]) assert.deepEqual(mid.mgmt[key], startMgmt[key], key);
  assert.equal(mid.mgmt.ledger.entries.length, 0, "no ledger entry before release");
  // the release posts once
  const cashBefore = w.runtime.game.ledger.cash;
  runStep("e3.release", w);
  assert.equal(w.runtime.game.ledger.cash - cashBefore, AMOUNT, "the stated amount, once");
  const posted = mgmtOf(w.runtime).ledger.entries;
  assert.equal(posted.length, 1);
  assert.equal(posted[0].category, "new-town-rail-contribution");
  assert.throws(() => runStep("e3.release", w), /release/i);
  assert.equal(mgmtOf(w.runtime).ledger.entries.length, 1);
  // the rest of the script (E4/E5/E1) moves nothing more
  const afterRelease = w.runtime.game.ledger.cash;
  for (const [, run] of STEPS.slice(indexOf("e3.release") + 1)) run(w.runtime, w.k);
  assert.equal(w.runtime.game.ledger.cash, afterRelease);
  assert.equal(mgmtOf(w.runtime).ledger.entries.length, 1);
  assert.deepEqual(withoutSources(opsOf(w.runtime)), withoutSources(startOps));
  // a save and load keeps the one posting
  const loaded = build();
  loaded.load(w.runtime.save());
  assert.equal(loaded.game.ledger.cash, afterRelease);
  assert.equal(mgmtOf(loaded).ledger.entries.length, 1);
});

test("the whole script twice gives the same bytes, frozen inputs are never touched, and the order of reads does not matter", () => {
  const a = world({ upTo: "e1.cancel" });
  const b = world({ upTo: "e1.cancel", freeze: true });
  assert.equal(a.runtime.save(), b.runtime.save(), "frozen payloads give the same save");
  assert.deepEqual(b.k, kit(), "and the frozen payloads are unchanged");
  const reads = [
    (r, k) => r.report(), (r, k) => reports(r, k.geometry), (r, k) => r.assessNewTownExplicitDemandSources({ geometry: k.geometry }), (r, k) => r.assessNewTownDemandIntake({ developmentRecordId: D, geometry: k.geometry }),
    (r, k) => r.assessNewTownRailContribution({ id: C, geometry: k.geometry, currentLinks: k.currentLinks }), (r, k) => r.assessNewTownDevelopment({ id: D, geometry: k.geometry }),
  ];
  const run = (order) => { const w = world({ upTo: "e5.apply.p2" }); for (const i of order) reads[i](w.runtime, w.k); return w.runtime.save(); };
  assert.equal(run([0, 1, 2, 3, 4, 5]), run([5, 4, 3, 2, 1, 0]));
  assert.equal(run([]), run([2, 2, 0, 3]));
});

test("a development cancelled under live approvals leaves every record in place, reported stale, until the player withdraws or revokes each", () => {
  const w = world({ upTo: "e5.apply.p2" });
  w.runtime.cancelNewTownDevelopment(D, "player stopped it");
  const counts = () => ({ d: w.runtime.newTownDevelopmentReport().length, c: w.runtime.newTownRailContributionReport().length, i: w.runtime.newTownDemandIntakeReport().length, s: w.runtime.report().newTownExplicitDemandSources.length });
  assert.deepEqual(counts(), { d: 1, c: 1, i: 2, s: 2 });
  assert.deepEqual(w.runtime.newTownExplicitDemandSourceReport({ geometry: w.k.geometry }).map((s) => s.standing.status), ["stale", "stale"]);
  assert.deepEqual(w.runtime.newTownDemandIntakeReport(null, { geometry: w.k.geometry }).map((i) => i.standing.currentStatus), ["stale", "stale"]);
  // the contribution cannot go forward, but can still be ended by the player
  const assessed = w.runtime.assessNewTownRailContribution({ id: C, geometry: w.k.geometry, currentLinks: w.k.currentLinks });
  assert.equal(assessed.transitions.release.allowed, false);
  assert.equal(assessed.transitions.terminate.allowed, true);
  for (const id of [SOURCE(1), SOURCE(2)]) w.runtime.withdrawNewTownExplicitDemandSource(id, "development cancelled");
  for (const id of ["new-town-demand-intake:1", "new-town-demand-intake:2"]) w.runtime.revokeNewTownDemandCandidate(id, "development cancelled");
  w.runtime.terminateNewTownRailContribution(C, "development cancelled");
  assert.deepEqual(counts(), { d: 1, c: 1, i: 2, s: 2 }, "nothing was deleted - ending is a status, not an erasure");
});
