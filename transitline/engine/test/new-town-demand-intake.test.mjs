import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ManagementGame, NEW_TOWN_DEMAND_INTAKE_ASSESSMENT_SCHEMA, NEW_TOWN_DEMAND_INTAKE_NOT_COMPUTED, NEW_TOWN_DEMAND_INTAKE_SCHEMA, NEW_TOWN_DEMAND_INTAKE_STATUSES, NEW_TOWN_DEMAND_INTAKE_TRANSITIONS,
} from "../src/management/index.mjs";
import { ScenarioRuntime } from "../src/scenario-runtime.mjs";
import { createState } from "../src/state.mjs";

const read = (rel) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
// a real B19-M1 development (drawn in the editor, built by the M1 builder)
const EXAMPLE = JSON.parse(read("../../packs/example-radial/new-town-development-examples/01-two-phases-with-synthetic-pond-and-road.new-town.json"));
const [P1, P2] = EXAMPLE.phases.map((p) => p.phaseId);
const PARTIES = { municipality: { name: "Example City" }, developer: { name: "Example Dev" } };
const AGREEMENT = { burdens: [{ itemId: "land", bearers: ["developer"] }] };
const RESIDENTS = { statedOccupiedUnits: 120, unit: "residents", source: "player-stated" };
const JOBS = { statedOccupiedUnits: 0, unit: "jobs", source: "player-stated" };
const HOUSING = { statedOccupiedUnits: 3, unit: "housing-units", source: "s" };
const deepFreeze = (o) => { if (o && typeof o === "object") { Object.values(o).forEach(deepFreeze); Object.freeze(o); } return o; };
const geo = (over = {}) => ({ ...structuredClone(EXAMPLE), ...over });
const candidateId = (phase = P1) => `new-town-demand-candidate:${EXAMPLE.developmentId}:${phase}`;
const factId = (n = 1, phase = P1) => `new-town-development:1:phase:${phase}:occupancy:${n}`;
const snap = (game) => JSON.stringify(game.snapshot());
const strip = ({ standing: _standing, ...record }) => record;

// the real B19-E1 lifecycle on a game or a runtime, made up to "servicing", with the given occupancy facts per phase
function lifecycle(factsByPhase = {}, { game = new ManagementGame({ seed: 1904 }), after = null } = {}) {
  const geometry = EXAMPLE;
  const { id } = game.proposeNewTownDevelopment({ geometry, parties: PARTIES });
  game.agreeNewTownDevelopment(id, AGREEMENT, { geometry });
  game.startNewTownServicing(id, { geometry, phaseIds: [P1, P2] });
  for (const [phaseId, facts] of Object.entries(factsByPhase)) for (const fact of facts) game.recordNewTownOccupancy(id, phaseId, fact, { geometry });
  if (after) after(game, id);
  return { game, id };
}
const acceptInput = (id, over = {}) => ({ developmentRecordId: id, candidateId: candidateId(), statedDemandFactIds: [factId()], geometry: EXAMPLE, ...over });
function accepted(over = {}) {
  const made = lifecycle({ [P1]: [RESIDENTS] });
  return { ...made, record: made.game.acceptNewTownDemandCandidate(acceptInput(made.id, over)) };
}
const standingOf = (game, geometry) => game.newTownDemandIntakeReport(null, { geometry })[0].standing;

test("the contract: a candidate is accepted only by the player's explicit choice, and the record keeps exactly what was approved", () => {
  const { game, id } = lifecycle({ [P1]: [RESIDENTS] });
  assert.deepEqual(game.newTownDemandIntakeReport(), [], "nothing is accepted until the player says so");
  const a = game.assessNewTownDemandIntake({ developmentRecordId: id, geometry: EXAMPLE });
  assert.equal(a.schema, NEW_TOWN_DEMAND_INTAKE_ASSESSMENT_SCHEMA);
  assert.deepEqual(a.candidates.map((c) => [c.candidateId, c.currentStatus, c.eligibleForB15, c.intakeId]), [[candidateId(), "pending", true, null]]);
  assert.deepEqual(a.candidates[0].accept, { allowed: true, blockers: [] });
  // the map may also be handed in as the whole B19-M1 export
  const exported = { schema: "transitline.new-town-development-export/1", packId: "example-radial", developments: [EXAMPLE] };
  assert.deepEqual(game.assessNewTownDemandIntake({ developmentRecordId: id, geometry: exported }).candidates[0].accept, { allowed: true, blockers: [] });
  const record = game.acceptNewTownDemandCandidate(acceptInput(id, { note: "approved after the site visit" }));
  assert.equal(record.schema, NEW_TOWN_DEMAND_INTAKE_SCHEMA);
  assert.deepEqual(record, {
    schema: NEW_TOWN_DEMAND_INTAKE_SCHEMA, contractVersion: 1, id: "new-town-demand-intake:1", developmentRecordId: id, developmentId: EXAMPLE.developmentId, candidateId: candidateId(), phaseId: P1,
    lifecycleHookId: `${id}:phase:${P1}`, status: "accepted",
    acceptance: {
      acceptedAtMinute: 0, note: "approved after the site visit", statedDemandFactIds: [factId()],
      statedDemandFacts: [{ factId: factId(), sequence: 1, recordedAtMinute: 0, kind: "residents", quantity: 120, source: "player-stated", note: null }],
      occupancyFactIds: [factId()], developmentRevision: EXAMPLE.developmentRevision, phaseRevision: EXAMPLE.phases[0].phaseRevision,
      sourcePack: { packId: "example-radial", packVersion: "0.1.0" },
      lifecycle: { status: "occupied", phaseStatus: "occupied", transitionIds: game.newTownDevelopmentHooks(id).transitions.map((t) => t.transitionId) },
    },
    revocation: null, history: [{ decisionId: "new-town-demand-intake:1:decision:1", sequence: 1, kind: "accept", from: "pending", to: "accepted", atMinute: 0, reason: null }], createdAtMinute: 0, updatedAtMinute: 0,
  });
  assert.deepEqual(game.newTownDemandIntakeReport()[0].standing, { currentStatus: "accepted", verification: { status: "unverified", reasons: ["geometry-missing", "geometry-not-provided", "candidate-eligibility-unknown"] } });
  assert.deepEqual(standingOf(game, EXAMPLE), { currentStatus: "accepted", verification: { status: "current", reasons: [] } });
  assert.deepEqual(NEW_TOWN_DEMAND_INTAKE_STATUSES, ["pending", "accepted", "held", "rejected", "stale", "revoked"]);
  assert.deepEqual(Object.keys(NEW_TOWN_DEMAND_INTAKE_TRANSITIONS), ["accept", "hold", "reject", "revoke"]);
  assert.ok(game.events.entries.some((e) => e.type === "new-town-demand-candidate-accepted"), "the decision is in the event log");
  // the same steps in a fresh game give the same record, ids included
  const again = lifecycle({ [P1]: [RESIDENTS] });
  assert.deepEqual(again.game.acceptNewTownDemandCandidate(acceptInput(again.id, { note: "approved after the site visit" })), record);
});

test("only an eligible candidate can be accepted: incomplete, stale, inactive, other-pack, missing geometry and a cancelled development are refused, and nothing changes", () => {
  const cases = [
    ["incomplete (no demand kind stated)", () => lifecycle({ [P1]: [{ statedOccupiedUnits: 500, unit: "housing-units", source: "s" }] }), {}, ["candidate-not-eligible:null", "candidate-missing:statedDemandFacts"]],
    ["stale map revision", () => lifecycle({ [P1]: [RESIDENTS] }), { geometry: geo({ developmentRevision: "new-town-revision:other" }) }, ["candidate-not-eligible:false", "candidate-blocker:geometry-stale", "geometry-stale", "geometry-revision-changed"]],
    ["inactive map", () => lifecycle({ [P1]: [RESIDENTS] }), { geometry: geo({ active: false }) }, ["candidate-blocker:geometry-inactive", "geometry-inactive"]],
    ["another pack", () => lifecycle({ [P1]: [RESIDENTS] }), { geometry: geo({ sourcePackId: "other-pack" }) }, ["candidate-blocker:geometry-other-pack", "geometry-other-pack", "geometry-source-pack-changed"]],
    ["no map given", () => lifecycle({ [P1]: [RESIDENTS] }), { geometry: null }, ["candidate-not-eligible:null", "geometry-missing", "geometry-not-provided"]],
    ["cancelled development", () => lifecycle({ [P1]: [RESIDENTS] }, { after: (g, id) => g.cancelNewTownDevelopment(id, "stopped") }), {}, ["candidate-not-eligible:false", "candidate-blocker:lifecycle-cancelled"]],
  ];
  for (const [label, make, over, expected] of cases) {
    const { game, id } = make();
    const before = snap(game);
    const input = acceptInput(id, over);
    const assessed = game.assessNewTownDemandIntake(input).selected.accept;
    assert.equal(assessed.allowed, false, label);
    for (const blocker of expected) assert.ok(assessed.blockers.includes(blocker), `${label}: ${blocker} in ${assessed.blockers}`);
    assert.throws(() => game.acceptNewTownDemandCandidate(input), (error) => error.message === `New town demand candidate ${candidateId()} cannot accept: ${assessed.blockers.join(", ")}`, label);
    assert.equal(snap(game), before, `${label}: nothing changed`);
    assert.deepEqual(game.newTownDemandIntakeReport(), []);
  }
  // hold and reject need only that the candidate exists
  const { game, id } = lifecycle({ [P1]: [{ statedOccupiedUnits: 500, unit: "housing-units", source: "s" }] });
  assert.equal(game.holdNewTownDemandCandidate({ developmentRecordId: id, candidateId: candidateId(), reason: "wait for the survey" }).status, "held");
});

test("the player names the stated facts: none, duplicates, unknown ids, another candidate's ids and two facts of one kind are refused; two kinds are kept apart", () => {
  const { game, id } = lifecycle({ [P1]: [RESIDENTS, { statedOccupiedUnits: 130, unit: "residents", source: "player-stated" }, JOBS], [P2]: [{ statedOccupiedUnits: 40, unit: "jobs", source: "player-stated" }] });
  const before = snap(game);
  const refuse = (ids, expected) => {
    const input = acceptInput(id, { statedDemandFactIds: ids });
    assert.throws(() => game.acceptNewTownDemandCandidate(input), (error) => expected.every((e) => error.message.includes(e)), `${JSON.stringify(ids)}`);
    if (ids !== undefined) assert.deepEqual(game.assessNewTownDemandIntake(input).selected.accept.blockers.filter((b) => expected.includes(b)), expected);
    assert.equal(snap(game), before);
  };
  refuse(undefined, ["stated-demand-fact-ids-not-chosen"]);
  refuse([], ["stated-demand-fact-ids-not-chosen"]);
  refuse("fact", ["stated-demand-fact-ids-not-chosen"]);
  refuse([factId(1), factId(1)], [`stated-demand-fact-id-duplicate:${factId(1)}`]);
  refuse([factId(1, P2)], [`stated-demand-fact-not-in-candidate:${factId(1, P2)}`]);
  refuse(["new-town-development:1:phase:nope:occupancy:1"], ["stated-demand-fact-not-in-candidate:new-town-development:1:phase:nope:occupancy:1"]);
  refuse([5, ""], ["stated-demand-fact-id-invalid:0", "stated-demand-fact-id-invalid:1"]);
  refuse([factId(1), factId(2)], ["stated-demand-fact-kind-repeated:residents"]);
  // another candidate's id as the candidate, or a made-up one
  assert.throws(() => game.acceptNewTownDemandCandidate(acceptInput(id, { candidateId: "new-town-demand-candidate:other:p" })), /cannot accept: candidate-not-found/);
  assert.throws(() => game.acceptNewTownDemandCandidate(acceptInput(id, { candidateId: candidateId(P2) })), /stated-demand-fact-not-in-candidate/, "phase 2's candidate with phase 1's fact");
  assert.equal(snap(game), before);
  // one residents fact and one jobs fact: both kept, as stated, never added or converted
  const record = game.acceptNewTownDemandCandidate(acceptInput(id, { statedDemandFactIds: [factId(1), factId(3)] }));
  assert.deepEqual(record.acceptance.statedDemandFacts.map((f) => [f.factId, f.kind, f.quantity]), [[factId(1), "residents", 120], [factId(3), "jobs", 0]], "a stated 0 stays 0");
  assert.deepEqual(record.acceptance.statedDemandFactIds, [factId(1), factId(3)]);
  assert.deepEqual(Object.keys(record.acceptance).sort(), ["acceptedAtMinute", "developmentRevision", "lifecycle", "note", "occupancyFactIds", "phaseRevision", "sourcePack", "statedDemandFactIds", "statedDemandFacts"], "no combined or derived figure");
  assert.equal(record.acceptance.note, null, "null stays null");
});

test("after an acceptance, a changed map, pack, occupancy fact or lifecycle is reported stale, never repaired and never re-approved", () => {
  const stale = (label, { mutate = null, geometry = EXAMPLE }, reasons) => {
    const made = accepted();
    const before = strip(made.game.newTownDemandIntakeReport()[0]);
    if (mutate) mutate(made);
    const standing = standingOf(made.game, geometry);
    assert.equal(standing.currentStatus, "stale", label);
    assert.equal(standing.verification.status, "stale", label);
    for (const reason of reasons) assert.ok(standing.verification.reasons.includes(reason), `${label}: ${reason} in ${standing.verification.reasons}`);
    assert.deepEqual(strip(made.game.newTownDemandIntakeReport()[0]), before, `${label}: the stored record is untouched`);
    assert.equal(made.game.newTownDemandIntakeReport()[0].status, "accepted");
    assert.throws(() => made.game.acceptNewTownDemandCandidate(acceptInput(made.id)), /cannot accept: .*status-not-allowed:accepted/, `${label}: no second approval`);
    return made;
  };
  stale("map revision", { geometry: geo({ developmentRevision: "new-town-revision:changed" }) }, ["geometry-stale", "geometry-revision-changed"]);
  stale("another pack", { geometry: geo({ sourcePackId: "other-pack" }) }, ["geometry-other-pack", "geometry-source-pack-changed"]);
  stale("map switched off", { geometry: geo({ active: false }) }, ["geometry-inactive"]);
  stale("development gone from the export", { geometry: { schema: "transitline.new-town-development-export/1", developments: [] } }, ["geometry-missing", "geometry-development-not-in-export"]);
  stale("a new occupancy fact", { mutate: ({ game, id }) => { game.recordNewTownOccupancy(id, P1, { statedOccupiedUnits: 130, unit: "residents", source: "player-stated" }, { geometry: EXAMPLE }); } }, ["occupancy-facts-changed", "lifecycle-transitions-changed"]);
  stale("a delay", { mutate: ({ game, id }) => { game.delayNewTownDevelopment(id, "permit is late"); } }, ["lifecycle-status-changed", "lifecycle-transitions-changed"]);
  const resumed = stale("delay then resume", { mutate: ({ game, id }) => { game.delayNewTownDevelopment(id, "late"); game.resumeNewTownDevelopment(id, { geometry: EXAMPLE }); } }, ["lifecycle-transitions-changed"]);
  assert.equal(resumed.game.newTownDevelopmentReport(resumed.id)[0].status, "occupied", "the status is back, the history is not");
  stale("a cancelled development", { mutate: ({ game, id }) => { game.cancelNewTownDevelopment(id, "stopped"); } }, ["lifecycle-cancelled", "lifecycle-status-changed"]);
  // unchanged: current with the map, unverified without it - unknown is never "still fine"
  const same = accepted();
  assert.deepEqual(standingOf(same.game, EXAMPLE).verification, { status: "current", reasons: [] });
  assert.equal(standingOf(same.game, null).verification.status, "unverified");
  assert.equal(standingOf(same.game, null).currentStatus, "accepted");
  // the player revokes (no map needed) and decides again: a new record, the old one kept
  const revoked = same.game.revokeNewTownDemandCandidate(same.record.id, "the map moved");
  assert.deepEqual([revoked.status, revoked.revocation.reason, revoked.revocation.fromStatus, revoked.acceptance.statedDemandFactIds], ["revoked", "the map moved", "accepted", [factId()]]);
  assert.equal(same.game.newTownDemandIntakeReport()[0].standing.currentStatus, "revoked");
  const again = same.game.acceptNewTownDemandCandidate(acceptInput(same.id));
  assert.equal(again.id, "new-town-demand-intake:2");
  assert.deepEqual(same.game.newTownDemandIntakeReport().map((r) => [r.id, r.status]), [["new-town-demand-intake:1", "revoked"], ["new-town-demand-intake:2", "accepted"]]);
});

test("hold, reject and revoke follow the transition table, need a reason, and a held or rejected candidate can still be accepted", () => {
  const { game, id } = lifecycle({ [P1]: [RESIDENTS] });
  const input = { developmentRecordId: id, candidateId: candidateId() };
  assert.throws(() => game.holdNewTownDemandCandidate({ ...input }), /A hold reason must be a non-empty text/);
  assert.throws(() => game.rejectNewTownDemandCandidate({ ...input, reason: "x".repeat(201) }), /A reject reason must be a non-empty text of at most 200/);
  assert.deepEqual(game.newTownDemandIntakeReport(), [], "a refused decision leaves no record and uses no id");
  const held = game.holdNewTownDemandCandidate({ ...input, reason: "wait for the survey" });
  assert.deepEqual([held.id, held.status, held.acceptance, held.history.map((h) => [h.kind, h.from, h.to, h.reason])], ["new-town-demand-intake:1", "held", null, [["hold", "pending", "held", "wait for the survey"]]]);
  assert.throws(() => game.holdNewTownDemandCandidate({ ...input, reason: "again" }), /cannot hold: status-not-allowed:held/);
  assert.throws(() => game.revokeNewTownDemandCandidate(held.id, "no"), /cannot revoke: status-not-allowed:held/);
  assert.equal(game.rejectNewTownDemandCandidate({ ...input, reason: "too early" }).id, held.id, "the same live record moves on");
  assert.throws(() => game.rejectNewTownDemandCandidate({ ...input, reason: "again" }), /status-not-allowed:rejected/);
  assert.equal(game.holdNewTownDemandCandidate({ ...input, reason: "look again" }).status, "held");
  const acceptedRecord = game.acceptNewTownDemandCandidate(acceptInput(id));
  assert.deepEqual([acceptedRecord.id, acceptedRecord.status, acceptedRecord.history.map((h) => `${h.from}>${h.to}`)], [held.id, "accepted", ["pending>held", "held>rejected", "rejected>held", "held>accepted"]]);
  assert.throws(() => game.holdNewTownDemandCandidate({ ...input, reason: "x" }), /status-not-allowed:accepted/);
  assert.throws(() => game.rejectNewTownDemandCandidate({ ...input, reason: "x" }), /status-not-allowed:accepted/);
  assert.throws(() => game.revokeNewTownDemandCandidate(held.id, ""), /A revocation reason must be/);
  assert.throws(() => game.revokeNewTownDemandCandidate("new-town-demand-intake:99", "x"), /Unknown new town demand intake/);
  assert.throws(() => game.holdNewTownDemandCandidate({ developmentRecordId: "new-town-development:99", candidateId: candidateId(), reason: "x" }), /Unknown new town development/);
  assert.throws(() => game.holdNewTownDemandCandidate({ ...input, candidateId: "new-town-demand-candidate:nope", reason: "x" }), /cannot hold: candidate-not-found/);
  const revoked = game.revokeNewTownDemandCandidate(held.id, "changed my mind");
  assert.deepEqual(revoked.history.map((h) => h.decisionId), [1, 2, 3, 4, 5].map((n) => `${held.id}:decision:${n}`));
  assert.throws(() => game.revokeNewTownDemandCandidate(held.id, "again"), /status-not-allowed:revoked/);
  const a = game.assessNewTownDemandIntake({ developmentRecordId: id, geometry: EXAMPLE, candidateId: candidateId() });
  assert.deepEqual([a.selected.currentStatus, a.selected.intakeId, a.selected.revoke.allowed, a.selected.accept.allowed], ["pending", null, false, true], "revoked is final; the candidate is pending again");
  assert.equal(game.assessNewTownDemandIntake({ developmentRecordId: id, candidateId: "nope" }).selected.accept.blockers[0], "candidate-not-found");
});

test("transactions: a refused or failing decision leaves records, ids, clock, random state and money exactly as they were", () => {
  const { game, id } = lifecycle({ [P1]: [RESIDENTS] });
  const before = snap(game);
  assert.throws(() => game.acceptNewTownDemandCandidate(acceptInput(id, { statedDemandFactIds: [] })), /cannot accept/);
  assert.throws(() => game.acceptNewTownDemandCandidate(acceptInput(id, { note: "   " })), /An acceptance note must be/);
  assert.equal(snap(game), before);
  // the log write fails after the record was made: the whole decision is rolled back, the id is not used up
  game.events.record = () => { throw new Error("log failed"); };
  assert.throws(() => game.acceptNewTownDemandCandidate(acceptInput(id)), /log failed/);
  assert.equal(snap(game), before);
  assert.deepEqual(game.newTownDemandIntakeReport(), []);
  assert.equal(game.acceptNewTownDemandCandidate(acceptInput(id)).id, "new-town-demand-intake:1");
  // no random number, no clock move, no money
  const quiet = lifecycle({ [P1]: [RESIDENTS], [P2]: [HOUSING] });
  const s0 = quiet.game.snapshot();
  quiet.game.acceptNewTownDemandCandidate(acceptInput(quiet.id));
  quiet.game.holdNewTownDemandCandidate({ developmentRecordId: quiet.id, candidateId: candidateId(P2), reason: "x" });
  quiet.game.rejectNewTownDemandCandidate({ developmentRecordId: quiet.id, candidateId: candidateId(P2), reason: "y" });
  quiet.game.revokeNewTownDemandCandidate("new-town-demand-intake:1", "z");
  const s1 = quiet.game.snapshot();
  for (const key of ["rngState", "constructionEventRngState", "clock", "ledger", "player", "projects", "plans", "services", "newTownDevelopments", "newTownRailContributions"]) assert.deepEqual(s1[key], s0[key], key);
  assert.equal(s1.newTownDemandIntakes.length, 2);
});

test("save and restore: records, ids and standing come back; an id is never reused, even from an old or damaged counter", () => {
  const { game, id, record } = accepted();
  const saved = game.snapshot();
  const restored = new ManagementGame({ seed: 1 }).restore(structuredClone(saved));
  assert.deepEqual(restored.newTownDemandIntakeReport(null, { geometry: EXAMPLE }), game.newTownDemandIntakeReport(null, { geometry: EXAMPLE }));
  assert.equal(restored.newTownDemandIntakeReport()[0].id, record.id);
  restored.revokeNewTownDemandCandidate(record.id, "x");
  assert.equal(restored.acceptNewTownDemandCandidate(acceptInput(id)).id, "new-town-demand-intake:2");
  // a counter that went back (or was lost) still never hands out an id that exists
  const damaged = structuredClone(restored.snapshot());
  damaged.nextNewTownDemandIntakeSequence = 1;
  assert.equal(new ManagementGame({ seed: 1 }).restore(damaged).nextNewTownDemandIntakeSequence, 3);
  delete damaged.nextNewTownDemandIntakeSequence;
  assert.equal(new ManagementGame({ seed: 1 }).restore(damaged).nextNewTownDemandIntakeSequence, 3);
  // a save from before B19-E4 has no intake list
  const old = structuredClone(saved);
  delete old.newTownDemandIntakes; delete old.nextNewTownDemandIntakeSequence;
  const legacy = new ManagementGame({ seed: 1 }).restore(old);
  assert.deepEqual([legacy.newTownDemandIntakeReport(), legacy.nextNewTownDemandIntakeSequence], [[], 1]);
  // through JSON, as a file
  const loaded = new ManagementGame({ seed: 1 }).restore(JSON.parse(JSON.stringify(game.snapshot())));
  assert.deepEqual(loaded.newTownDemandIntakeReport(), game.newTownDemandIntakeReport());
});

test("frozen inputs are never changed, and outputs share nothing with the game or with the input", () => {
  const { game, id } = lifecycle({ [P1]: [RESIDENTS] });
  const geometry = deepFreeze(structuredClone(EXAMPLE));
  const input = deepFreeze({ developmentRecordId: id, candidateId: candidateId(), statedDemandFactIds: [factId()], geometry, note: "ok" });
  const copy = structuredClone(input);
  const assessed = game.assessNewTownDemandIntake(input);
  const record = game.acceptNewTownDemandCandidate(input);
  game.newTownDemandIntakeReport(null, { geometry });
  assert.deepEqual(input, copy);
  assert.deepEqual(geometry, EXAMPLE);
  assessed.candidates[0].statedDemandFacts[0].quantity = 999;
  record.acceptance.statedDemandFacts[0].quantity = 999;
  record.acceptance.statedDemandFactIds.push("x");
  const report = game.newTownDemandIntakeReport();
  report[0].acceptance.statedDemandFacts[0].quantity = 777;
  report[0].standing.currentStatus = "tampered";
  const stored = game.newTownDemandIntakeReport()[0];
  assert.equal(stored.acceptance.statedDemandFacts[0].quantity, 120);
  assert.deepEqual(stored.acceptance.statedDemandFactIds, [factId()]);
  assert.notEqual(stored.standing.currentStatus, "tampered");
  assert.equal(game.newTownDemandIntakeReport("new-town-demand-intake:1").length, 1);
  assert.equal(game.newTownDemandIntakeReport("new-town-demand-intake:9").length, 0);
});

test("assess is read-only and the contract names what it does not compute", () => {
  const { game, id } = lifecycle({ [P1]: [RESIDENTS], [P2]: [HOUSING] });
  const before = snap(game);
  const a = game.assessNewTownDemandIntake({ developmentRecordId: id, geometry: EXAMPLE });
  assert.equal(snap(game), before);
  assert.deepEqual(a.candidates.map((c) => [c.phaseId, c.completeness, c.eligibleForB15, c.currentStatus]), [[P1, "complete", true, "pending"], [P2, "incomplete", null, "pending"]]);
  assert.deepEqual(a.candidates[1].hold, { allowed: true, blockers: [] });
  assert.deepEqual(a.candidates[1].revoke, { allowed: false, blockers: ["status-not-allowed:none"] });
  assert.deepEqual(a.geometry, { status: "current", reasons: [] });
  assert.deepEqual(a.notComputed, [...NEW_TOWN_DEMAND_INTAKE_NOT_COMPUTED]);
  for (const word of ["population", "demand", "trips", "passengers", "fare", "crowding", "cost", "score", "probability", "quantity-sum", "residents-jobs-conversion", "b15-application"]) assert.ok(a.notComputed.includes(word), word);
  // a lifecycle record with no occupancy fact has no candidate at all
  const none = lifecycle({});
  assert.deepEqual(none.game.assessNewTownDemandIntake({ developmentRecordId: none.id, geometry: EXAMPLE }).candidates, []);
  assert.throws(() => none.game.acceptNewTownDemandCandidate(acceptInput(none.id)), /cannot accept: candidate-not-found/);
});

test("the module reads and changes no B15 state, computes no figure, and keeps its imports to the lifecycle and the candidates", () => {
  const source = read("../src/management/new-town-demand-intake.mjs");
  const code = source.replace(/\/\/.*$/gm, "");
  assert.ok(Buffer.byteLength(source) < 40_000);
  assert.deepEqual([...source.matchAll(/from "([^"]+)"/g)].map((m) => m[1]), ["./new-town-development.mjs", "../new-town-demand-candidates.mjs"]);
  assert.equal(/operationalState|accessLinks|demandNodes|stationDemand|passengers\.mjs|demand-engine|access-demand|rng|clock/i.test(code), false);
  assert.equal(/Math\.|Number\(|parseFloat|parseInt|\.reduce\(|Date\.now|new Date|setTimeout/.test(code), false);
});

test("ScenarioRuntime: the same decisions through the runtime, in report(), through save and load - and not one B15 value changes", () => {
  const pack = { manifest: { id: "new-town-intake", version: "1", data: { license: "test", attribution: [] } }, demand: { model: "gravity", points: [], attractors: [] } };
  const build = () => new ScenarioRuntime({ pack, operationalState: createState(pack) });
  const runtime = build();
  const b15 = (r) => ({ state: structuredClone(r.operationalState), access: r.report().stationDemandAccess, allocation: r.report().stationDemandAllocation, diagnostics: r.report().stationDemandAllocationDiagnostics });
  const { id } = lifecycle({ [P1]: [RESIDENTS], [P2]: [HOUSING] }, { game: runtime });
  const b15Before = b15(runtime);
  assert.deepEqual(runtime.report().newTownDemandIntakes, []);
  assert.deepEqual(runtime.newTownDemandIntakeReport(), []);
  const assessed = runtime.assessNewTownDemandIntake({ developmentRecordId: id, geometry: EXAMPLE, candidateId: candidateId(), statedDemandFactIds: [factId()] });
  assert.equal(assessed.selected.accept.allowed, true);
  assert.deepEqual(b15(runtime), b15Before, "asking changes nothing: zero B15 values without an explicit acceptance");
  const record = runtime.acceptNewTownDemandCandidate(acceptInput(id));
  assert.equal(record.id, "new-town-demand-intake:1");
  assert.equal(runtime.holdNewTownDemandCandidate({ developmentRecordId: id, candidateId: candidateId(P2), reason: "no demand facts yet" }).status, "held");
  assert.equal(runtime.rejectNewTownDemandCandidate({ developmentRecordId: id, candidateId: candidateId(P2), reason: "not used" }).status, "rejected");
  assert.deepEqual(runtime.report().newTownDemandIntakes, runtime.newTownDemandIntakeReport());
  assert.equal(runtime.newTownDemandIntakeReport(record.id, { geometry: EXAMPLE })[0].standing.verification.status, "current");
  assert.deepEqual(b15(runtime), b15Before, "accepting, holding and rejecting change no B15 value either");
  // through the runtime's own save and load
  const other = build();
  other.load(runtime.save());
  assert.deepEqual(other.newTownDemandIntakeReport(), runtime.newTownDemandIntakeReport());
  assert.equal(other.newTownDemandIntakeReport(null, { geometry: geo({ developmentRevision: "new-town-revision:changed" }) })[0].standing.currentStatus, "stale");
  assert.equal(other.revokeNewTownDemandCandidate(record.id, "after load").status, "revoked");
  assert.equal(other.acceptNewTownDemandCandidate(acceptInput(id)).id, "new-town-demand-intake:3", "ids are not reused after a load");
  assert.deepEqual(b15(other).access, b15Before.access);
});
