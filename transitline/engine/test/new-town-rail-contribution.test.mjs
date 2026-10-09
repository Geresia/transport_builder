import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ManagementGame, NEW_TOWN_RAIL_CONTRIBUTION_LEDGER_CATEGORY as CATEGORY, NEW_TOWN_RAIL_CONTRIBUTION_NOT_COMPUTED, NEW_TOWN_RAIL_CONTRIBUTION_SCHEMA,
  NEW_TOWN_RAIL_CONTRIBUTION_STATUSES, NEW_TOWN_RAIL_CONTRIBUTION_TRANSITIONS, newTownRailContributionHooks,
} from "../src/management/index.mjs";
import { ScenarioRuntime } from "../src/scenario-runtime.mjs";
import { createState } from "../src/state.mjs";

const read = (rel) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
// a real B19-M1 development (drawn in the editor, built by the M1 builder)
const EXAMPLE = JSON.parse(read("../../packs/example-radial/new-town-development-examples/01-two-phases-with-synthetic-pond-and-road.new-town.json"));
const [P1, P2] = EXAMPLE.phases.map((p) => p.phaseId);
const PARTIES = { municipality: { name: "Example City" }, developer: { name: "Example Dev" } };
const E1_AGREEMENT = { burdens: [{ itemId: "land", bearers: ["developer"] }] };
const AMOUNT = 3_000_000_000;
const deepFreeze = (o) => { if (o && typeof o === "object") { Object.values(o).forEach(deepFreeze); Object.freeze(o); } return o; };
const geo = (over = {}) => ({ ...structuredClone(EXAMPLE), ...over });

const INPUT = (developmentRecordId, over = {}) => ({
  developmentRecordId, payerKind: "municipality", payeeKind: "player-railway", statedPurpose: "station", statedAmountYen: AMOUNT, phaseIds: [P1],
  linkedPlanIds: ["plan:1"], linkedStationSiteIds: ["site:1"], conditions: [{ conditionId: "c1", text: "The station opens before phase 1 is serviced" }], ...over,
});
const CONFIRM = { confirmedAmountYen: AMOUNT, confirmedBy: "payer", reference: "municipal council resolution" };
const CONFS = [{ conditionId: "c1", note: "station opened" }];
const CTX = (over = {}) => ({ geometry: EXAMPLE, currentLinks: { planIds: ["plan:1"], stationSiteIds: ["site:1"] }, ...over });
const money = (g) => JSON.stringify({ cash: g.ledger.cash, entries: g.ledger.entries, playerCash: g.player.cash });

function world() {
  const g = new ManagementGame({ seed: 1903 });
  const development = g.proposeNewTownDevelopment({ geometry: EXAMPLE, parties: PARTIES });
  g.projects.push({ id: "project:1", status: "active" }); // a project the contribution can name
  return { g, devId: development.id };
}
// bring a contribution to each status
function make(status, over = {}, w = world()) {
  const { g, devId } = w;
  const id = g.draftNewTownRailContribution(INPUT(devId, over)).contributionId;
  const out = { g, id, devId };
  if (status === "draft") return out;
  g.proposeNewTownRailContribution(id, CTX());
  if (status === "proposed") return out;
  g.agreeNewTownRailContribution(id, {}, CTX());
  if (status === "agreed") return out;
  g.fundNewTownRailContribution(id, CONFIRM, CTX());
  if (status === "funded") return out;
  if (status === "released") { g.releaseNewTownRailContribution(id, CTX({ conditionConfirmations: CONFS })); return out; }
  if (status === "delayed") { g.delayNewTownRailContribution(id, "the municipal budget is late"); return out; }
  g.terminateNewTownRailContribution(id, "the agreement fell through");
  return out;
}

test("the lifecycle table: every step is allowed or blocked exactly as the read-only assessment says, in every state, and a blocked step changes nothing", () => {
  const attempt = {
    propose: (g, id) => g.proposeNewTownRailContribution(id, CTX()),
    agree: (g, id) => g.agreeNewTownRailContribution(id, {}, CTX()),
    fund: (g, id) => g.fundNewTownRailContribution(id, CONFIRM, CTX()),
    release: (g, id) => g.releaseNewTownRailContribution(id, CTX({ conditionConfirmations: CONFS })),
    delay: (g, id) => g.delayNewTownRailContribution(id, "late"),
    resume: (g, id) => g.resumeNewTownRailContribution(id, CTX()),
    terminate: (g, id) => g.terminateNewTownRailContribution(id, "stop"),
  };
  assert.deepEqual(Object.keys(attempt).sort(), Object.keys(NEW_TOWN_RAIL_CONTRIBUTION_TRANSITIONS).sort());
  const seen = {};
  for (const status of NEW_TOWN_RAIL_CONTRIBUTION_STATUSES) {
    const base = make(status);
    const snapshot = base.g.snapshot();
    assert.equal(base.g.requireNewTownRailContribution(base.id).status, status);
    const assessment = base.g.assessNewTownRailContribution({ id: base.id, ...CTX({ conditionConfirmations: CONFS }), confirmation: CONFIRM });
    for (const kind of Object.keys(attempt)) {
      const g = new ManagementGame().restore(structuredClone(snapshot));
      const { allowed, blockers } = assessment.transitions[kind];
      seen[`${status}/${kind}`] = allowed;
      if (allowed) assert.equal(attempt[kind](g, base.id).contributionId, base.id, `${status}/${kind}`);
      else {
        assert.ok(blockers.length > 0, `${status}/${kind} has blockers`);
        assert.throws(() => attempt[kind](g, base.id), (error) => blockers.every((code) => error.message.includes(code)), `${status}/${kind}`);
        assert.deepEqual(g.snapshot(), snapshot, `${status}/${kind} changed state`);
      }
    }
  }
  const allowedKinds = (status) => Object.keys(attempt).filter((kind) => seen[`${status}/${kind}`]);
  assert.deepEqual(allowedKinds("draft"), ["propose", "terminate"]);
  assert.deepEqual(allowedKinds("proposed"), ["agree", "delay", "terminate"]);
  assert.deepEqual(allowedKinds("agreed"), ["fund", "delay", "terminate"]);
  assert.deepEqual(allowedKinds("funded"), ["release", "delay", "terminate"]);
  assert.deepEqual(allowedKinds("released"), [], "a released contribution is final");
  assert.deepEqual(allowedKinds("delayed"), ["resume", "terminate"]);
  assert.deepEqual(allowedKinds("terminated"), []);
});

test("a draft records only what was stated: ids go up, kinds are required, 0 is not null, [] is not null", () => {
  const { g, devId } = world();
  const c = g.draftNewTownRailContribution(INPUT(devId, { name: "Hanamaki station share" }));
  assert.equal(c.schema, NEW_TOWN_RAIL_CONTRIBUTION_SCHEMA);
  assert.deepEqual([c.contributionId, c.contractVersion, c.status, c.name, c.developmentRecordId, c.developmentId, c.developmentRevision], ["new-town-rail-contribution:1", 1, "draft", "Hanamaki station share", devId, EXAMPLE.developmentId, EXAMPLE.developmentRevision]);
  assert.deepEqual(c.sourcePack, { packId: "example-radial", packVersion: "0.1.0" });
  assert.deepEqual([c.payerKind, c.payeeKind, c.statedPurpose, c.statedAmountYen, c.phaseIds], ["municipality", "player-railway", "station", AMOUNT, [P1]]);
  assert.deepEqual([c.linkedProjectIds, c.linkedPlanIds, c.linkedStationSiteIds], [null, ["plan:1"], ["site:1"]], "unstated links are null");
  assert.deepEqual(c.history.map((h) => [h.transitionId, h.kind, h.from, h.to]), [["new-town-rail-contribution:1:transition:1", "draft", null, "draft"]]);
  assert.deepEqual([c.gate, c.agreement, c.funding, c.release, c.delay, c.termination], [null, null, null, null, null, null]);
  // amount: nothing stated is null, a stated zero is 0
  assert.equal(g.draftNewTownRailContribution(INPUT(devId, { statedAmountYen: undefined })).statedAmountYen, null);
  assert.equal(g.draftNewTownRailContribution(INPUT(devId, { statedAmountYen: null })).statedAmountYen, null);
  assert.ok(Object.is(g.draftNewTownRailContribution(INPUT(devId, { statedAmountYen: 0 })).statedAmountYen, 0));
  // phases: null = the whole development, [] = states there are none, a list = those phases
  assert.equal(g.draftNewTownRailContribution(INPUT(devId, { phaseIds: undefined })).phaseIds, null);
  assert.deepEqual(g.draftNewTownRailContribution(INPUT(devId, { phaseIds: [] })).phaseIds, []);
  assert.deepEqual(g.draftNewTownRailContribution(INPUT(devId, { phaseIds: [P2, P1] })).phaseIds, [P1, P2].sort());
  assert.deepEqual(g.draftNewTownRailContribution(INPUT(devId, { conditions: [] })).conditions, [], "none stated is not 'not stated'");
  assert.equal(g.draftNewTownRailContribution(INPUT(devId, { conditions: undefined })).conditions, null);
  // nothing is defaulted and nothing is estimated
  for (const bad of [{ payerKind: undefined }, { payerKind: "mayor" }, { payeeKind: undefined }, { payeeKind: "bank" }, { statedPurpose: undefined }, { statedPurpose: "park" }, { statedAmountYen: -1 }, { statedAmountYen: 1.5 }, { statedAmountYen: "10" }, { statedAmountYen: Infinity },
    { phaseIds: "p1" }, { phaseIds: [""] }, { phaseIds: [P1, P1] }, { linkedProjectIds: [1] }, { conditions: "x" }, { conditions: [{ conditionId: "", text: "x" }] }, { conditions: [{ conditionId: "a", text: "x" }, { conditionId: "a", text: "y" }] }]) {
    assert.throws(() => g.draftNewTownRailContribution(INPUT(devId, bad)), Error, JSON.stringify(bad));
  }
  assert.throws(() => g.draftNewTownRailContribution(INPUT("new-town-development:99")), /Unknown new town development/);
  assert.throws(() => g.draftNewTownRailContribution({}), /Unknown new town development/);
  const ids = g.newTownRailContributions.map((x) => x.contributionId);
  assert.deepEqual(ids, ids.map((_, i) => `new-town-rail-contribution:${i + 1}`), "failed drafts used no id");
  g.cancelNewTownDevelopment(devId, "stopped");
  assert.throws(() => g.draftNewTownRailContribution(INPUT(devId)), /is cancelled/);
});

test("no amount is ever derived: development facts are not read, and an unstated amount stays null until a person states it", () => {
  const { g, devId } = world();
  g.agreeNewTownDevelopment(devId, E1_AGREEMENT, { geometry: EXAMPLE });
  g.startNewTownServicing(devId, { geometry: EXAMPLE, phaseIds: [P1, P2] });
  g.recordNewTownOccupancy(devId, P1, { statedOccupiedUnits: 9000, unit: "residents", source: "survey" }, { geometry: EXAMPLE });
  const c = g.draftNewTownRailContribution(INPUT(devId, { statedAmountYen: undefined, areaSquareMeters: 5_000_000, population: 40_000, demand: 1e9, subsidyRate: 0.5 }));
  assert.equal(c.statedAmountYen, null);
  assert.ok(!/areaSquareMeters|population|demand|subsidyRate|5000000|40000|9000/.test(JSON.stringify(c)), "nothing but the stated fields is kept");
  const id = c.contributionId;
  g.proposeNewTownRailContribution(id, CTX());
  assert.deepEqual(g.assessNewTownRailContribution({ id, ...CTX() }).transitions.agree, { allowed: false, blockers: ["amount-not-stated"] });
  assert.throws(() => g.agreeNewTownRailContribution(id, {}, CTX()), /amount-not-stated/);
  assert.equal(g.agreeNewTownRailContribution(id, { statedAmountYen: 0 }, CTX()).statedAmountYen, 0, "a stated zero is an amount");
  assert.equal(g.requireNewTownRailContribution(id).agreement.statedAmountYen, 0);
});

test("agree needs a stated amount and stated conditions; terms given at agreement win over the draft; a project payee needs a project", () => {
  const w = world();
  const a = make("proposed", { statedAmountYen: undefined, conditions: undefined }, w);
  assert.throws(() => a.g.agreeNewTownRailContribution(a.id, {}, CTX()), /amount-not-stated, conditions-not-stated/);
  assert.throws(() => a.g.agreeNewTownRailContribution(a.id, { statedAmountYen: 100 }, CTX()), /conditions-not-stated/);
  assert.throws(() => a.g.agreeNewTownRailContribution(a.id, { statedAmountYen: -5, conditions: [] }, CTX()), /non-negative/);
  const agreed = a.g.agreeNewTownRailContribution(a.id, { statedAmountYen: 100, conditions: [] }, CTX());
  assert.deepEqual([agreed.statedAmountYen, agreed.conditions, agreed.agreement], [100, [], { agreedAtMinute: 0, statedAmountYen: 100, conditions: [] }]);
  const b = make("proposed", { statedAmountYen: 500 }, w);
  assert.equal(b.g.agreeNewTownRailContribution(b.id, { statedAmountYen: 700 }, CTX()).statedAmountYen, 700);
  const p = make("proposed", { payeeKind: "project" }, w);
  assert.throws(() => p.g.agreeNewTownRailContribution(p.id, {}, CTX()), /payee-project-needs-a-linked-project/);
  const q = make("proposed", { payeeKind: "project", linkedProjectIds: ["project:1"] }, w);
  assert.equal(q.g.agreeNewTownRailContribution(q.id, {}, CTX()).status, "agreed");
});

test("money: nothing but release touches the cash or the ledger, and release posts the stated amount exactly once", () => {
  const { g, id } = make("draft");
  const base = money(g);
  const queue = JSON.stringify(g.clock.queue);
  g.proposeNewTownRailContribution(id, CTX());
  g.agreeNewTownRailContribution(id, {}, CTX());
  assert.equal(money(g), base, "an agreement creates no cash");
  g.fundNewTownRailContribution(id, CONFIRM, CTX());
  assert.equal(money(g), base, "a payer's confirmed payment is a fact, not cash");
  g.delayNewTownRailContribution(id, "late"); g.resumeNewTownRailContribution(id, CTX());
  g.assessNewTownRailContribution({ id, ...CTX() }); g.newTownRailContributionReport(); g.newTownRailContributionHooks(id);
  assert.equal(money(g), base);
  const cashBefore = g.ledger.cash; const entriesBefore = g.ledger.entries.length;
  const released = g.releaseNewTownRailContribution(id, CTX({ conditionConfirmations: CONFS }));
  assert.equal(g.ledger.cash, cashBefore + AMOUNT);
  assert.equal(g.player.cash, g.ledger.cash, "the player's cash follows the ledger");
  assert.equal(g.ledger.entries.length, entriesBefore + 1);
  const entry = g.ledger.entries.at(-1);
  assert.deepEqual([entry.amount, entry.category, entry.reference, entry.atMinute], [AMOUNT, CATEGORY, id, 0]);
  assert.deepEqual(released.release, { releasedAtMinute: 0, amountYen: AMOUNT, ledgerEffect: "posted", ledgerEffectReason: null, ledgerEntryId: entry.id, conditionConfirmations: [{ conditionId: "c1", note: "station opened" }] });
  assert.equal(released.status, "released");
  assert.equal(JSON.stringify(g.clock.queue), queue, "nothing was scheduled");
  assert.equal(g.ledger.commitments.size, 0);
  // a second release cannot count twice
  const after = money(g);
  assert.throws(() => g.releaseNewTownRailContribution(id, CTX({ conditionConfirmations: CONFS })), /status-not-allowed:released/);
  assert.equal(money(g), after);
  assert.equal(g.ledger.entries.filter((e) => e.category === CATEGORY && e.reference === id).length, 1);
  for (const call of [() => g.terminateNewTownRailContribution(id, "undo"), () => g.delayNewTownRailContribution(id, "undo"), () => g.fundNewTownRailContribution(id, CONFIRM, CTX())]) assert.throws(call, /status-not-allowed:released/);
  assert.equal(money(g), after);
});

test("a ledger entry that already exists for the contribution stops a second posting even if the status were wrong", () => {
  const { g, id } = make("funded");
  g.ledger.post({ atMinute: 0, amount: 5, category: CATEGORY, reference: id, memo: "stray" });
  g.player.cash = g.ledger.cash;
  const before = g.snapshot();
  assert.throws(() => g.releaseNewTownRailContribution(id, CTX({ conditionConfirmations: CONFS })), /already has a ledger entry/);
  assert.deepEqual(g.snapshot(), before);
  assert.equal(g.requireNewTownRailContribution(id).status, "funded");
});

test("release effect: only a payer other than the player paying the player's side moves cash; a stated zero and a non-player payee move none", () => {
  const cases = {
    "player pays": [{ payerKind: "player" }, "payer-is-the-player-no-cash-created", AMOUNT],
    "payee is someone else": [{ payeeKind: "other" }, "payee-is-not-the-player-side", AMOUNT],
    "stated zero": [{ statedAmountYen: 0 }, "stated-zero", 0],
  };
  for (const [name, [over, reason, amount]] of Object.entries(cases)) {
    const { g, id } = make("agreed", over);
    g.fundNewTownRailContribution(id, { ...CONFIRM, confirmedAmountYen: amount }, CTX());
    const preview = g.assessNewTownRailContribution({ id, ...CTX({ conditionConfirmations: CONFS }) }).releaseEffect;
    assert.deepEqual(preview, { kind: "none", amountYen: amount, reason }, name);
    const base = money(g);
    const released = g.releaseNewTownRailContribution(id, CTX({ conditionConfirmations: CONFS }));
    assert.equal(money(g), base, `${name}: no cash`);
    assert.deepEqual([released.release.ledgerEffect, released.release.ledgerEffectReason, released.release.ledgerEntryId, released.release.amountYen], ["none", reason, null, amount], name);
  }
  const { g, id } = make("funded", { payeeKind: "project", linkedProjectIds: ["project:1"] });
  assert.deepEqual(g.assessNewTownRailContribution({ id, ...CTX({ conditionConfirmations: CONFS }) }).releaseEffect, { kind: "post", amountYen: AMOUNT, reason: null });
  assert.equal(g.releaseNewTownRailContribution(id, CTX({ conditionConfirmations: CONFS })).release.ledgerEffect, "posted");
  const agreed = make("agreed");
  assert.equal(agreed.g.assessNewTownRailContribution({ id: agreed.id, ...CTX() }).releaseEffect.reason, "not-funded");
});

test("fund records only the payer's explicit confirmation, which must match the stated amount; it never invents one", () => {
  const { g, id } = make("agreed");
  for (const [bad, code] of [[undefined, "confirmation-not-provided"], [null, "confirmation-not-provided"], [{}, "confirmation-invalid"], [{ confirmedAmountYen: AMOUNT, confirmedBy: "payer" }, "confirmation-invalid"],
    [{ ...CONFIRM, confirmedAmountYen: null }, "confirmation-invalid"], [{ ...CONFIRM, confirmedAmountYen: -1 }, "confirmation-invalid"], [{ ...CONFIRM, confirmedAmountYen: 1.5 }, "confirmation-invalid"], [{ ...CONFIRM, confirmedAmountYen: "3" }, "confirmation-invalid"],
    [{ ...CONFIRM, confirmedAmountYen: AMOUNT - 1 }, "confirmed-amount-differs-from-stated"], [{ ...CONFIRM, confirmedAmountYen: 0 }, "confirmed-amount-differs-from-stated"]]) {
    assert.throws(() => g.fundNewTownRailContribution(id, bad, CTX()), new RegExp(code), JSON.stringify(bad));
  }
  assert.equal(g.requireNewTownRailContribution(id).status, "agreed");
  const funded = g.fundNewTownRailContribution(id, { ...CONFIRM, reference: "  council minute 12  " }, CTX());
  assert.deepEqual(funded.funding, { fundedAtMinute: 0, confirmedAmountYen: AMOUNT, confirmedBy: "payer", reference: "council minute 12" });
  assert.deepEqual([funded.release, funded.status], [null, "funded"]);
  // a stated zero is confirmed as a zero
  const z = make("agreed", { statedAmountYen: 0 });
  assert.equal(z.g.fundNewTownRailContribution(z.id, { ...CONFIRM, confirmedAmountYen: 0 }, CTX()).funding.confirmedAmountYen, 0);
});

test("conditions are never met automatically: release needs every stated condition confirmed by the caller", () => {
  const two = { conditions: [{ conditionId: "c1", text: "Station opens" }, { conditionId: "c2", text: "Depot land handed over" }] };
  const { g, id } = make("funded", two);
  const release = (confirmations, ctx = {}) => g.releaseNewTownRailContribution(id, CTX({ conditionConfirmations: confirmations, ...ctx }));
  for (const [given, pattern] of [[undefined, /condition-not-confirmed:c1, condition-not-confirmed:c2/], [[], /condition-not-confirmed:c1, condition-not-confirmed:c2/], [[{ conditionId: "c1" }], /condition-not-confirmed:c2/],
    [[{ conditionId: "c1" }, { conditionId: "c2" }, { conditionId: "c3" }], /condition-unknown:c3/], [[{ conditionId: "c1" }, { conditionId: "c1" }, { conditionId: "c2" }], /condition-confirmation-repeated:c1/], [[{}, { conditionId: "c1" }, { conditionId: "c2" }], /condition-unknown:null/]]) {
    assert.throws(() => release(given), pattern, JSON.stringify(given));
  }
  assert.equal(g.requireNewTownRailContribution(id).status, "funded");
  assert.equal(g.ledger.entries.filter((e) => e.category === CATEGORY).length, 0);
  assert.equal(g.assessNewTownRailContribution({ id, ...CTX() }).transitions.release.allowed, false, "nothing marks a condition satisfied by itself");
  const released = release([{ conditionId: "c2", note: "handed over" }, { conditionId: "c1" }]);
  assert.deepEqual(released.release.conditionConfirmations, [{ conditionId: "c1", note: null }, { conditionId: "c2", note: "handed over" }]);
  // [] stated conditions: nothing to confirm; confirming one that does not exist is an error
  const none = make("funded", { conditions: [] });
  assert.throws(() => none.g.releaseNewTownRailContribution(none.id, CTX({ conditionConfirmations: CONFS })), /condition-unknown:c1/);
  assert.equal(none.g.releaseNewTownRailContribution(none.id, CTX()).status, "released");
});

test("release finds the linked projects, plans and station sites current; what cannot be checked is not assumed current", () => {
  const check = (over, ctxOver, pattern) => {
    const { g, id } = make("funded", over);
    const run = () => g.releaseNewTownRailContribution(id, CTX({ conditionConfirmations: CONFS, ...ctxOver }));
    if (pattern) { assert.throws(run, pattern, JSON.stringify([over, ctxOver])); assert.equal(g.requireNewTownRailContribution(id).status, "funded"); } else assert.equal(run().status, "released");
  };
  check({}, { currentLinks: { planIds: ["plan:1"], stationSiteIds: ["site:1"] } }, null);
  check({}, { currentLinks: { planIds: ["plan:2"], stationSiteIds: ["site:1"] } }, /linked-plan-not-current:plan:1/);
  check({}, { currentLinks: { planIds: ["plan:1"], stationSiteIds: [] } }, /linked-station-site-not-current:site:1/);
  check({}, { currentLinks: { stationSiteIds: ["site:1"] } }, /linked-plans-not-verifiable/);
  check({}, { currentLinks: null }, /linked-plans-not-verifiable, linked-station-sites-not-verifiable/);
  check({ linkedPlanIds: null, linkedStationSiteIds: [] }, { currentLinks: null }, null);
  check({ linkedProjectIds: ["project:1"] }, {}, null);
  check({ linkedProjectIds: ["project:9"] }, {}, /linked-project-missing:project:9/);
  const cancelled = make("funded", { linkedProjectIds: ["project:1"] });
  cancelled.g.projects[0].status = "cancelled";
  assert.throws(() => cancelled.g.releaseNewTownRailContribution(cancelled.id, CTX({ conditionConfirmations: CONFS })), /linked-project-cancelled:project:1/);
  assert.equal(cancelled.g.ledger.entries.filter((e) => e.category === CATEGORY).length, 0);
});

test("a development that is stale, from another pack, cancelled or of unknown revision blocks propose, agree, fund, release and resume; delay and terminate still work", () => {
  const gates = {
    "revision changed": [geo({ developmentRevision: "new-town-revision:0000000000000000" }), /geometry-stale, geometry-revision-changed/],
    "other pack": [geo({ sourcePackId: "other-pack" }), /geometry-stale, geometry-source-pack-changed/],
    "pack version changed": [geo({ sourcePackVersion: "9.9.9" }), /geometry-stale, geometry-source-pack-version-changed/],
    "no pack in the geometry": [geo({ sourcePackId: null }), /geometry-invalid, geometry-source-pack-unknown/],
    inactive: [geo({ active: false }), /geometry-inactive/],
    "unknown active": [geo({ active: null }), /geometry-invalid, geometry-active-unknown/],
    missing: [null, /geometry-missing, geometry-not-provided/],
    "other development": [geo({ developmentId: "new-town:other" }), /geometry-stale, geometry-other-development/],
  };
  for (const [name, [bad, pattern]] of Object.entries(gates)) {
    const ctx = CTX({ geometry: bad });
    const draft = make("draft"); assert.throws(() => draft.g.proposeNewTownRailContribution(draft.id, ctx), pattern, `propose/${name}`);
    const proposed = make("proposed"); assert.throws(() => proposed.g.agreeNewTownRailContribution(proposed.id, {}, ctx), pattern, `agree/${name}`);
    const agreed = make("agreed"); assert.throws(() => agreed.g.fundNewTownRailContribution(agreed.id, CONFIRM, ctx), pattern, `fund/${name}`);
    const funded = make("funded"); assert.throws(() => funded.g.releaseNewTownRailContribution(funded.id, { ...ctx, conditionConfirmations: CONFS }), pattern, `release/${name}`);
    assert.equal(funded.g.ledger.entries.filter((e) => e.category === CATEGORY).length, 0, `${name}: no cash`);
    const delayed = make("delayed"); assert.throws(() => delayed.g.resumeNewTownRailContribution(delayed.id, ctx), pattern, `resume/${name}`);
    assert.equal(funded.g.delayNewTownRailContribution(funded.id, "the map changed").status, "delayed", `delay/${name}`);
    assert.equal(agreed.g.terminateNewTownRailContribution(agreed.id, "the map changed").status, "terminated", `terminate/${name}`);
  }
  // a cancelled development
  const c = make("agreed");
  c.g.cancelNewTownDevelopment(c.devId, "the town was dropped");
  assert.throws(() => c.g.fundNewTownRailContribution(c.id, CONFIRM, CTX()), /development-cancelled/);
  assert.deepEqual(c.g.assessNewTownRailContribution({ id: c.id, ...CTX(), confirmation: CONFIRM }).transitions.delay, { allowed: true, blockers: [] });
  assert.equal(c.g.terminateNewTownRailContribution(c.id, "the town was dropped").status, "terminated");
  const f = make("funded");
  f.g.cancelNewTownDevelopment(f.devId, "dropped");
  assert.throws(() => f.g.releaseNewTownRailContribution(f.id, CTX({ conditionConfirmations: CONFS })), /development-cancelled/);
  assert.equal(f.g.ledger.entries.filter((e) => e.category === CATEGORY).length, 0, "a cancelled development releases no money");
  assert.deepEqual(f.g.terminateNewTownRailContribution(f.id, "dropped").termination, { reason: "dropped", terminatedAtMinute: 0, fromStatus: "funded", fundedNotReleased: true });
  // revision / pack unknown: the development was drafted without a geometry
  const g = new ManagementGame({ seed: 1 });
  const bare = g.draftNewTownDevelopment({ developmentId: "dev:bare" });
  const cid = g.draftNewTownRailContribution(INPUT(bare.id, { phaseIds: undefined })).contributionId;
  assert.deepEqual([g.requireNewTownRailContribution(cid).developmentRevision, g.requireNewTownRailContribution(cid).sourcePack], [null, null]);
  assert.throws(() => g.proposeNewTownRailContribution(cid, CTX()), /development-revision-unknown, source-pack-unknown/);
  assert.equal(g.terminateNewTownRailContribution(cid, "no map yet").status, "terminated");
});

test("linked phases must exist in the development; a development-wide contribution (null) and a no-phase one ([]) need none; unknown phases are unverifiable", () => {
  const unknown = make("draft", { phaseIds: ["new-town-phase:ffffffffffffffff"] });
  assert.throws(() => unknown.g.proposeNewTownRailContribution(unknown.id, CTX()), /phase-unknown:new-town-phase:ffffffffffffffff/);
  for (const phaseIds of [null, [], [P1, P2]]) { const ok = make("draft", { phaseIds }); assert.equal(ok.g.proposeNewTownRailContribution(ok.id, CTX()).status, "proposed", JSON.stringify(phaseIds)); }
  // a development with no known phases (drafted without a geometry) cannot confirm a named phase
  const g = new ManagementGame({ seed: 2 });
  const bare = g.draftNewTownDevelopment({ developmentId: EXAMPLE.developmentId });
  assert.equal(bare.phases, null);
  const id = g.draftNewTownRailContribution(INPUT(bare.id)).contributionId;
  assert.ok(g.assessNewTownRailContribution({ id, ...CTX() }).transitions.propose.blockers.includes("linked-phases-unverifiable"));
});

test("delay remembers where it came from and resume goes back there (with a current map); terminate keeps the history; ids never repeat", () => {
  for (const from of ["proposed", "agreed", "funded"]) {
    const { g, id } = make(from);
    const delayed = g.delayNewTownRailContribution(id, "  budget is late  ");
    assert.deepEqual(delayed.delay, { reason: "budget is late", delayedAtMinute: 0, fromStatus: from, resumedAtMinute: null });
    g.clock.minute = 700;
    assert.throws(() => g.resumeNewTownRailContribution(id, CTX({ geometry: null })), /geometry-missing/);
    const resumed = g.resumeNewTownRailContribution(id, CTX());
    assert.deepEqual([resumed.status, resumed.delay.resumedAtMinute], [from, 700]);
    assert.deepEqual(resumed.history.slice(-2).map((h) => [h.kind, h.from, h.to, h.atMinute, h.reason]), [["delay", from, "delayed", 0, "budget is late"], ["resume", "delayed", from, 700, null]]);
  }
  for (const bad of [undefined, null, "", "   ", 5, "x".repeat(201)]) {
    const { g, id } = make("agreed");
    assert.throws(() => g.delayNewTownRailContribution(id, bad), /reason/);
    assert.throws(() => g.terminateNewTownRailContribution(id, bad), /reason/);
  }
  const { g, id } = make("delayed");
  const t = g.terminateNewTownRailContribution(id, "gave up");
  assert.deepEqual(t.termination, { reason: "gave up", terminatedAtMinute: 0, fromStatus: "delayed", fundedNotReleased: true });
  assert.equal(g.newTownRailContributionReport(id)[0].history.length, 6);
  assert.equal(g.draftNewTownRailContribution(INPUT(g.newTownDevelopments[0].id)).contributionId, "new-town-rail-contribution:2", "a terminated contribution's id is not reused");
});

test("a failure inside the transaction rolls back the contribution, the cash, the ledger, the events, the random generator and the id counter", () => {
  const cases = {
    draft: (w) => () => w.g.draftNewTownRailContribution(INPUT(w.devId)),
    propose: (w) => { const id = w.g.draftNewTownRailContribution(INPUT(w.devId)).contributionId; return () => w.g.proposeNewTownRailContribution(id, CTX()); },
    agree: (w) => { const { id } = make("proposed", {}, w); return () => w.g.agreeNewTownRailContribution(id, {}, CTX()); },
    fund: (w) => { const { id } = make("agreed", {}, w); return () => w.g.fundNewTownRailContribution(id, CONFIRM, CTX()); },
    release: (w) => { const { id } = make("funded", {}, w); return () => w.g.releaseNewTownRailContribution(id, CTX({ conditionConfirmations: CONFS })); },
    delay: (w) => { const { id } = make("funded", {}, w); return () => w.g.delayNewTownRailContribution(id, "late"); },
    resume: (w) => { const { id } = make("delayed", {}, w); return () => w.g.resumeNewTownRailContribution(id, CTX()); },
    terminate: (w) => { const { id } = make("funded", {}, w); return () => w.g.terminateNewTownRailContribution(id, "stop"); },
  };
  for (const [name, prepare] of Object.entries(cases)) {
    const w = world();
    const run = prepare(w);
    const before = w.g.snapshot();
    const events = w.g.events.entries.length;
    const real = w.g.ledger.assertInvariant.bind(w.g.ledger);
    w.g.ledger.assertInvariant = () => { throw new Error("ledger broke after the step"); };
    assert.throws(run, /ledger broke/, name);
    w.g.ledger.assertInvariant = real;
    assert.deepEqual(w.g.snapshot(), before, `${name}: state, ledger, rng, events and counters are back`);
    assert.equal(w.g.events.entries.length, events, name);
    assert.equal(w.g.player.cash, before.ledger.openingCash + before.ledger.entries.reduce((s, e) => s + e.amount, 0), `${name}: cash`);
  }
  // a release whose ledger posting itself fails leaves the contribution funded and the ledger untouched
  const { g, id } = make("funded");
  const before = g.snapshot();
  g.ledger.post = () => { throw new Error("posting failed"); };
  assert.throws(() => g.releaseNewTownRailContribution(id, CTX({ conditionConfirmations: CONFS })), /posting failed/);
  assert.deepEqual(g.snapshot(), before);
  assert.equal(g.requireNewTownRailContribution(id).status, "funded");
  // the id the failed draft took is free again
  const x = world();
  const first = x.g.draftNewTownRailContribution(INPUT(x.devId)).contributionId;
  const failing = x.g.ledger.assertInvariant;
  x.g.ledger.assertInvariant = () => { throw new Error("boom"); };
  assert.throws(() => x.g.draftNewTownRailContribution(INPUT(x.devId)), /boom/);
  x.g.ledger.assertInvariant = failing;
  assert.deepEqual([first, x.g.draftNewTownRailContribution(INPUT(x.devId)).contributionId], ["new-town-rail-contribution:1", "new-town-rail-contribution:2"]);
});

test("save and load: every state round-trips exactly, a loaded release still cannot count twice, and old saves still load", () => {
  const w = world();
  const ids = {};
  for (const status of ["draft", "proposed", "agreed", "funded", "released", "delayed", "terminated"]) ids[status] = make(status, {}, w).id;
  const { g } = w;
  const restored = ManagementGame.load(g.save());
  assert.deepEqual(restored.snapshot(), g.snapshot());
  assert.equal(JSON.stringify(restored.snapshot()), JSON.stringify(g.snapshot()), "byte for byte");
  assert.deepEqual(restored.newTownRailContributionReport(), g.newTownRailContributionReport());
  assert.deepEqual(restored.newTownRailContributions.map((c) => c.status), ["draft", "proposed", "agreed", "funded", "released", "delayed", "terminated"]);
  for (const id of Object.values(ids)) assert.deepEqual(restored.newTownRailContributionHooks(id), g.newTownRailContributionHooks(id));
  assert.equal(restored.ledger.cash, g.ledger.cash);
  assert.throws(() => restored.releaseNewTownRailContribution(ids.released, CTX({ conditionConfirmations: CONFS })), /status-not-allowed:released/);
  assert.equal(restored.releaseNewTownRailContribution(ids.funded, CTX({ conditionConfirmations: CONFS })).status, "released");
  assert.equal(restored.ledger.entries.filter((e) => e.category === CATEGORY).length, 2);
  assert.equal(restored.resumeNewTownRailContribution(ids.delayed, CTX()).status, "funded");
  // monotonic, never reused
  assert.equal(restored.draftNewTownRailContribution(INPUT(w.devId)).contributionId, "new-town-rail-contribution:8");
  const lost = g.snapshot(); delete lost.nextNewTownRailContributionSequence;
  assert.equal(new ManagementGame().restore(lost).nextNewTownRailContributionSequence, 8, "a save that lost its counter never reuses an id");
  // an old save without the new keys
  const old = new ManagementGame({ seed: 5 }).snapshot();
  delete old.newTownRailContributions; delete old.nextNewTownRailContributionSequence;
  const loaded = new ManagementGame().restore(old);
  assert.deepEqual([loaded.newTownRailContributions, loaded.nextNewTownRailContributionSequence, loaded.newTownRailContributionReport()], [[], 1, []]);
  assert.throws(() => loaded.terminateNewTownRailContribution("new-town-rail-contribution:1", "x"), /Unknown new town rail contribution/);
  const fresh = new ManagementGame({ seed: 5 }).snapshot();
  assert.deepEqual([fresh.newTownRailContributions, fresh.nextNewTownRailContributionSequence], [[], 1]);
});

test("assess and report change nothing - not the state, the random generator, the clock or the ledger - and do not depend on call order; frozen inputs work", () => {
  const { g, id } = make("funded");
  const before = JSON.stringify(g.snapshot());
  const rng = JSON.stringify(g.rng.snapshot()); const minute = g.clock.minute;
  const ctx = deepFreeze({ id, geometry: structuredClone(EXAMPLE), currentLinks: { planIds: ["plan:1"], stationSiteIds: ["site:1"] }, confirmation: { ...CONFIRM }, conditionConfirmations: [{ conditionId: "c1" }], terms: { statedAmountYen: 1 } });
  const a = g.assessNewTownRailContribution(ctx);
  assert.equal(JSON.stringify(g.assessNewTownRailContribution(ctx)), JSON.stringify(a));
  g.assessNewTownRailContribution({ id }); g.assessNewTownRailContribution({ id, geometry: null });
  g.newTownRailContributionReport(); g.newTownRailContributionReport(id); g.newTownRailContributionHooks(id);
  assert.equal(JSON.stringify(g.snapshot()), before);
  assert.equal(JSON.stringify(g.rng.snapshot()), rng);
  assert.equal(g.clock.minute, minute);
  assert.equal(a.transitions.release.allowed, true);
  assert.deepEqual(a.releaseEffect, { kind: "post", amountYen: AMOUNT, reason: null });
  assert.deepEqual(a.notComputed, [...NEW_TOWN_RAIL_CONTRIBUTION_NOT_COMPUTED]);
  assert.deepEqual(g.assessNewTownRailContribution({ id }).transitions.release.blockers.slice(0, 3), ["geometry-missing", "geometry-not-provided", "condition-not-confirmed:c1"], "no input is not 'allowed'");
  assert.throws(() => g.assessNewTownRailContribution({ id: "new-town-rail-contribution:99" }), /Unknown new town rail contribution/);
  assert.throws(() => g.assessNewTownRailContribution(), /Unknown new town rail contribution/);
  // frozen inputs also work for the steps themselves
  const w = world();
  const c = w.g.draftNewTownRailContribution(deepFreeze(INPUT(w.devId))).contributionId;
  assert.equal(w.g.proposeNewTownRailContribution(c, deepFreeze(CTX({ geometry: structuredClone(EXAMPLE) }))).status, "proposed");
  assert.equal(w.g.agreeNewTownRailContribution(c, deepFreeze({ statedAmountYen: 7 }), deepFreeze(CTX())).statedAmountYen, 7);
});

test("the stored record shares nothing with what was passed in or handed out", () => {
  const w = world();
  const input = INPUT(w.devId);
  const returned = w.g.draftNewTownRailContribution(input);
  input.linkedPlanIds.push("tampered"); input.conditions[0].text = "tampered"; input.phaseIds.push("tampered");
  returned.status = "tampered"; returned.history.length = 0; returned.conditions[0].text = "tampered";
  const stored = w.g.newTownRailContributionReport()[0];
  assert.deepEqual([stored.status, stored.linkedPlanIds, stored.conditions[0].text, stored.phaseIds, stored.history.length], ["draft", ["plan:1"], "The station opens before phase 1 is serviced", [P1], 1]);
  stored.status = "tampered";
  assert.equal(w.g.newTownRailContributionReport()[0].status, "draft");
  const terms = { conditions: [{ conditionId: "z", text: "z" }] };
  const { g, id } = make("proposed", {}, w);
  g.agreeNewTownRailContribution(id, terms, CTX());
  terms.conditions[0].text = "tampered";
  assert.ok(!JSON.stringify(g.newTownRailContributionReport(id)).includes("tampered"));
});

test("the record notes what the development looked like when each forward step was accepted", () => {
  const { g, id, devId } = make("funded");
  assert.deepEqual(g.requireNewTownRailContribution(id).gate, { developmentRevision: EXAMPLE.developmentRevision, sourcePack: { packId: "example-radial", packVersion: "0.1.0" }, developmentStatus: "proposed", developmentLastTransitionId: `${devId}:transition:2`, geometryStatus: "current", checkedAtMinute: 0 });
  g.agreeNewTownDevelopment(devId, E1_AGREEMENT, { geometry: EXAMPLE });
  g.startNewTownServicing(devId, { geometry: EXAMPLE });
  g.clock.minute = 90;
  g.delayNewTownRailContribution(id, "x"); g.resumeNewTownRailContribution(id, CTX());
  const gate = g.requireNewTownRailContribution(id).gate;
  assert.deepEqual([gate.developmentStatus, gate.checkedAtMinute, gate.developmentLastTransitionId], ["servicing", 90, `${devId}:transition:4`]);
});

test("hooks give stable ids and the stated facts for a UI, a B15 bridge or a B14 bridge, and fire nothing", () => {
  const { g, id, devId } = make("released", { linkedProjectIds: ["project:1"] });
  const hooks = g.newTownRailContributionHooks(id);
  assert.deepEqual([hooks.hookId, hooks.contributionId, hooks.developmentRecordId, hooks.developmentId, hooks.developmentRevision, hooks.status], [id, id, devId, EXAMPLE.developmentId, EXAMPLE.developmentRevision, "released"]);
  assert.deepEqual(hooks.sourcePack, { packId: "example-radial", packVersion: "0.1.0" });
  assert.deepEqual(hooks.phaseHookIds, [`${devId}:phase:${P1}`]);
  assert.deepEqual([hooks.payerKind, hooks.payeeKind, hooks.statedPurpose, hooks.statedAmountYen, hooks.funded, hooks.released], ["municipality", "player-railway", "station", AMOUNT, true, true]);
  assert.deepEqual(hooks.links, { linkedProjectIds: ["project:1"], linkedPlanIds: ["plan:1"], linkedStationSiteIds: ["site:1"] });
  assert.deepEqual(hooks.ledger, { entryId: g.ledger.entries.at(-1).id, amountYen: AMOUNT });
  assert.deepEqual(hooks.transitions.map((t) => [t.transitionId.split(":").at(-1), t.kind, t.to]), [["1", "draft", "draft"], ["2", "propose", "proposed"], ["3", "agree", "agreed"], ["4", "fund", "funded"], ["5", "release", "released"]]);
  assert.deepEqual(newTownRailContributionHooks(g.newTownRailContributions[0]), hooks);
  assert.deepEqual(hooks.notComputed, [...NEW_TOWN_RAIL_CONTRIBUTION_NOT_COMPUTED]);
  hooks.transitions.length = 0;
  assert.equal(g.newTownRailContributionHooks(id).transitions.length, 5);
  const draft = make("draft");
  assert.equal(draft.g.newTownRailContributionHooks(draft.id).phaseHookIds.length, 1);
  const wide = make("draft", { phaseIds: undefined });
  assert.equal(wide.g.newTownRailContributionHooks(wide.id).phaseHookIds, null);
  // no event of another kind (B14) and no scheduled work was created by any step
  const types = [...new Set(g.events.entries.map((e) => e.type).filter((t) => t.includes("contribution")))].sort();
  assert.deepEqual(types, ["new-town-rail-contribution-agreed", "new-town-rail-contribution-drafted", "new-town-rail-contribution-funded", "new-town-rail-contribution-proposed", "new-town-rail-contribution-released"]);
  assert.deepEqual(g.clock.queue, []);
});

test("ScenarioRuntime delegates every step, exposes the report, and saves and loads the contributions", () => {
  const pack = { manifest: { id: "contribution-runtime", version: "1", data: { license: "test", attribution: [] } }, demand: { model: "gravity", points: [], attractors: [] } };
  const build = () => new ScenarioRuntime({ pack, operationalState: createState(pack) });
  const runtime = build();
  const development = runtime.proposeNewTownDevelopment({ geometry: EXAMPLE, parties: PARTIES });
  assert.deepEqual(runtime.report().newTownRailContributions, []);
  const id = runtime.draftNewTownRailContribution(INPUT(development.id)).contributionId;
  assert.equal(runtime.assessNewTownRailContribution({ id, ...CTX() }).transitions.propose.allowed, true);
  runtime.proposeNewTownRailContribution(id, CTX());
  runtime.agreeNewTownRailContribution(id, {}, CTX());
  runtime.fundNewTownRailContribution(id, CONFIRM, CTX());
  const cashBefore = runtime.game.ledger.cash;
  runtime.delayNewTownRailContribution(id, "late");
  assert.equal(runtime.newTownRailContributionReport(id)[0].status, "delayed");
  assert.deepEqual(runtime.report().newTownRailContributions, runtime.newTownRailContributionReport());
  assert.throws(() => runtime.resumeNewTownRailContribution(id, CTX({ geometry: geo({ developmentRevision: "new-town-revision:1111111111111111" }) })), /geometry-stale/);
  const other = build();
  other.load(runtime.save());
  assert.deepEqual(other.newTownRailContributionReport(), runtime.newTownRailContributionReport());
  assert.equal(other.resumeNewTownRailContribution(id, CTX()).status, "funded");
  assert.equal(other.releaseNewTownRailContribution(id, CTX({ conditionConfirmations: CONFS })).status, "released");
  assert.equal(other.game.ledger.cash, cashBefore + AMOUNT);
  assert.equal(other.newTownRailContributionHooks(id).ledger.amountYen, AMOUNT);
  assert.throws(() => other.releaseNewTownRailContribution(id, CTX({ conditionConfirmations: CONFS })), /status-not-allowed:released/);
  assert.equal(other.game.ledger.entries.filter((e) => e.category === CATEGORY).length, 1);
  const terminated = build();
  const tid = terminated.draftNewTownRailContribution(INPUT(terminated.proposeNewTownDevelopment({ geometry: EXAMPLE, parties: PARTIES }).id)).contributionId;
  assert.equal(terminated.terminateNewTownRailContribution(tid, "stop").status, "terminated");
});

test("the module keeps its promises: no clock, random number, area / population / demand / occupancy, or B15 / map code; only release touches the ledger", () => {
  const source = read("../src/management/new-town-rail-contribution.mjs").replace(/^\s*\/\/.*$/gm, "").replace(/^export const NEW_TOWN_RAIL_CONTRIBUTION_NOT_COMPUTED = .*$/m, "");
  assert.deepEqual([...source.matchAll(/^import .* from "(.*)";$/gm)].map((m) => m[1]), ["./new-town-development.mjs"]);
  const code = source.replace(/"[^"\n]*"|`[^`\n]*`/g, '""');
  assert.ok(!/Math\.|Date\.|new Date|performance\.now|\brng\b|setTimeout|localStorage/.test(code));
  assert.ok(!/\bcash\b|\.post\(|\.commit\(|\.settle\(|\.entries\b/i.test(code), "the module never touches a ledger itself");
  assert.ok(!/areaSquareMeters|statedOccupiedUnits|statedSupply|occupancyFacts|playerDeclaredLandUse|residents|demandNode|population|demand-engine|map\//.test(source), "no amount can come from the development's size, use, people or occupancy");
  assert.ok(!/\bamount\w*\s*[*/]|[*/]\s*amount|[Rr]ate\b|percent|estimate\(/.test(code), "no amount is multiplied, divided or estimated");
  const game = read("../src/management/game.mjs");
  const block = game.slice(game.indexOf("// --- B19-E3"), game.indexOf("railwayTimetableReport(timetableId = null) {"));
  assert.equal([...block.matchAll(/this\.ledger\.post\(/g)].length, 1, "exactly one ledger posting in the contribution code");
  assert.ok(block.indexOf("this.ledger.post(") > block.indexOf("  releaseNewTownRailContribution("), "and it is in release");
  for (const name of ["draft", "propose", "agree", "fund", "release", "delay", "resume", "terminate"]) {
    const at = block.indexOf(`  ${name}NewTownRailContribution(`);
    assert.ok(at >= 0 && block.slice(at, block.indexOf("\n  }\n", at)).includes("this.transact("), `${name} runs inside the management transaction`);
  }
});
