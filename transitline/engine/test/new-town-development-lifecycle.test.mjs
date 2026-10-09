import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ManagementGame, NEW_TOWN_DEVELOPMENT_SCHEMA, NEW_TOWN_GEOMETRY_SCHEMA, NEW_TOWN_NOT_COMPUTED, NEW_TOWN_STATUSES, NEW_TOWN_TRANSITIONS, checkNewTownGeometry, newTownDevelopmentHooks,
} from "../src/management/index.mjs";
import { ScenarioRuntime } from "../src/scenario-runtime.mjs";
import { createState } from "../src/state.mjs";

const geometry = (over = {}) => ({
  schema: NEW_TOWN_GEOMETRY_SCHEMA, contractVersion: 1, developmentId: "dev:a", developmentRevision: "rev:1", sourcePackId: "pack:tokyo", sourcePackVersion: "1", active: true,
  phases: [{ phaseId: "p1", sequence: 1, playerDeclaredLandUse: "residential" }, { phaseId: "p2", sequence: 2, playerDeclaredLandUse: null }, { phaseId: "p3", sequence: 3, playerDeclaredLandUse: "commercial" }],
  ...over,
});
const PARTIES = { municipality: { name: "Hanamaki City" }, developer: { partyId: "dev-co", name: "Dev Co" } };
const AGREEMENT = {
  burdens: [{ itemId: "rail-construction", bearers: ["municipality", "player"], statedAmountJPY: 1_000_000 }, { itemId: "land-assembly", bearers: ["developer"] }],
  connectionConditions: [{ conditionId: "c1", text: "The station opens before phase 2 is serviced", linkedStationSiteId: "site:1" }],
};
const FACTS = { statedOccupiedUnits: 120, statedPlannedUnits: 500, unit: "housing-units", source: "player-stated" };
const newGame = () => new ManagementGame({ seed: 1901 });
const deepFreeze = (o) => { if (o && typeof o === "object") { Object.values(o).forEach(deepFreeze); Object.freeze(o); } return o; };
const money = (g) => JSON.stringify({ ledger: g.snapshot().ledger, cash: g.player.cash });

// bring a development to each status
function make(status, g = newGame(), geo = geometry()) {
  const record = g.proposeNewTownDevelopment({ geometry: geo, name: "Hanamaki New Town", parties: PARTIES, links: { linkedPlanIds: ["plan:1"] }, phaseSupply: [{ phaseId: "p1", unit: "housing-units", quantity: 500 }] });
  const id = record.id;
  if (status === "proposed") return { g, id, geo };
  g.agreeNewTownDevelopment(id, AGREEMENT, { geometry: geo });
  if (status === "agreed") return { g, id, geo };
  g.startNewTownServicing(id, { geometry: geo });
  if (status === "servicing") return { g, id, geo };
  if (status === "delayed") { g.delayNewTownDevelopment(id, "land permit is late"); return { g, id, geo }; }
  g.recordNewTownOccupancy(id, "p1", FACTS, { geometry: geo });
  if (status === "occupied") return { g, id, geo };
  g.cancelNewTownDevelopment(id, "player stopped it");
  return { g, id, geo };
}
function makeDraft(g = newGame(), geo = geometry()) { return { g, id: g.draftNewTownDevelopment({ geometry: geo, parties: PARTIES }).id, geo }; }

test("the geometry check: only an active, well-formed geometry of the same development and revision is current; every unknown is a reason, never a pass", () => {
  assert.deepEqual(checkNewTownGeometry(geometry()), { status: "current", reasons: [] });
  const cases = [
    [null, "missing", ["geometry-not-provided"]], [undefined, "missing", ["geometry-not-provided"]], ["x", "invalid", ["geometry-not-an-object"]], [[], "invalid", ["geometry-not-an-object"]],
    [geometry({ schema: "other/1" }), "invalid", ["geometry-schema-invalid"]], [geometry({ contractVersion: 2 }), "invalid", ["geometry-schema-invalid"]],
    [geometry({ developmentId: "" }), "invalid", ["geometry-development-id-missing"]], [geometry({ developmentRevision: null }), "invalid", ["geometry-revision-unknown"]],
    [geometry({ phases: null }), "invalid", ["geometry-phases-unknown"]], [geometry({ phases: undefined }), "invalid", ["geometry-phases-unknown"]], [geometry({ phases: [] }), "invalid", ["geometry-has-no-phases"]],
    [geometry({ phases: [{ phaseId: "p1", sequence: 1 }, { phaseId: "p1", sequence: 2 }] }), "invalid", ["geometry-phase-duplicate:p1"]],
    [geometry({ phases: [{ phaseId: "p1", sequence: 1 }, { phaseId: "p2", sequence: 1 }] }), "invalid", ["geometry-phase-sequence-duplicate:1"]],
    [geometry({ phases: [{ phaseId: "", sequence: 1 }] }), "invalid", ["geometry-phase-invalid:0"]], [geometry({ phases: [{ phaseId: "p1", sequence: -1 }] }), "invalid", ["geometry-phase-invalid:0"]],
    [geometry({ phases: [{ phaseId: "p1", sequence: 1, playerDeclaredLandUse: 5 }] }), "invalid", ["geometry-phase-invalid:0"]],
    [geometry({ active: false }), "inactive", ["geometry-inactive"]], [geometry({ active: null }), "invalid", ["geometry-active-unknown"]], [geometry({ active: undefined }), "invalid", ["geometry-active-unknown"]], [geometry({ active: "true" }), "invalid", ["geometry-active-unknown"]],
  ];
  for (const [value, status, reasons] of cases) assert.deepEqual(checkNewTownGeometry(value), { status, reasons }, JSON.stringify(value)?.slice(0, 80));
  assert.equal(checkNewTownGeometry(geometry({ phases: [{ phaseId: "p1", sequence: 1 }] })).status, "current", "a land use that is not declared is allowed");
});

test("a record that remembers its revision and phases finds a changed map stale; a draft without a map adopts the first one", () => {
  const { g, id } = makeDraft();
  const record = g.requireNewTownDevelopment(id);
  assert.deepEqual(checkNewTownGeometry(geometry(), record), { status: "current", reasons: [] });
  assert.deepEqual(checkNewTownGeometry(geometry({ developmentRevision: "rev:2" }), record), { status: "stale", reasons: ["geometry-revision-changed"] });
  assert.deepEqual(checkNewTownGeometry(geometry({ developmentId: "dev:b" }), record), { status: "stale", reasons: ["geometry-other-development"] });
  assert.deepEqual(checkNewTownGeometry(geometry({ phases: geometry().phases.slice(0, 2) }), record), { status: "stale", reasons: ["geometry-phases-changed"] });
  const landUse = geometry(); landUse.phases[1].playerDeclaredLandUse = "industrial";
  assert.deepEqual(checkNewTownGeometry(landUse, record), { status: "stale", reasons: ["geometry-phases-changed"] });
  assert.equal(checkNewTownGeometry(geometry({ active: false }), record).status, "inactive");
  assert.deepEqual(checkNewTownGeometry(geometry({ developmentRevision: "rev:2" }), { ...record, developmentRevision: null, phases: null }), { status: "current", reasons: [] });
});

test("the lifecycle table: every step is allowed or blocked exactly as the read-only assessment says, in every state, and a blocked step changes nothing", () => {
  const attempt = {
    propose: (g, id, geo) => g.proposeNewTownDevelopment({ id, geometry: geo }),
    agree: (g, id, geo) => g.agreeNewTownDevelopment(id, AGREEMENT, { geometry: geo }),
    startServicing: (g, id, geo) => g.startNewTownServicing(id, { geometry: geo }),
    recordOccupancy: (g, id, geo) => g.recordNewTownOccupancy(id, "p1", FACTS, { geometry: geo }),
    delay: (g, id) => g.delayNewTownDevelopment(id, "late"),
    resume: (g, id, geo) => g.resumeNewTownDevelopment(id, { geometry: geo }),
    cancel: (g, id) => g.cancelNewTownDevelopment(id, "stop"),
  };
  assert.deepEqual(Object.keys(attempt).sort(), Object.keys(NEW_TOWN_TRANSITIONS).sort());
  const seen = {};
  for (const status of NEW_TOWN_STATUSES) {
    const base = status === "draft" ? makeDraft() : make(status);
    const snapshot = base.g.snapshot();
    assert.equal(base.g.requireNewTownDevelopment(base.id).status, status);
    const assessment = base.g.assessNewTownDevelopment({ id: base.id, geometry: base.geo });
    for (const kind of Object.keys(attempt)) {
      const g = new ManagementGame().restore(structuredClone(snapshot));
      const allowed = assessment.transitions[kind].allowed;
      seen[`${status}/${kind}`] = allowed;
      if (allowed) {
        assert.equal(attempt[kind](g, base.id, base.geo).id, base.id, `${status}/${kind}`);
      } else {
        assert.ok(assessment.transitions[kind].blockers.length > 0, `${status}/${kind} has blockers`);
        assert.throws(() => attempt[kind](g, base.id, base.geo), (error) => assessment.transitions[kind].blockers.some((code) => error.message.includes(code)), `${status}/${kind}`);
        assert.deepEqual(g.snapshot(), snapshot, `${status}/${kind} changed state`);
      }
    }
  }
  const allowedKinds = (status) => Object.keys(attempt).filter((kind) => seen[`${status}/${kind}`]);
  assert.deepEqual(allowedKinds("draft"), ["propose", "cancel"]);
  assert.deepEqual(allowedKinds("proposed"), ["agree", "cancel"]);
  assert.deepEqual(allowedKinds("agreed"), ["startServicing", "delay", "cancel"]);
  assert.deepEqual(allowedKinds("servicing"), ["startServicing", "recordOccupancy", "delay", "cancel"]);
  assert.deepEqual(allowedKinds("occupied"), ["startServicing", "recordOccupancy", "delay", "cancel"]);
  assert.deepEqual(allowedKinds("delayed"), ["resume", "cancel"]);
  assert.deepEqual(allowedKinds("cancelled"), [], "a cancelled development can do nothing");
});

test("propose: a development is drafted and proposed in one transaction, or an earlier draft is proposed; the record carries the map's facts and the player's", () => {
  const g = newGame();
  const record = g.proposeNewTownDevelopment({ geometry: geometry(), name: "Hanamaki New Town", parties: PARTIES, links: { linkedPlanIds: ["plan:2", "plan:1"], linkedStationSiteIds: ["site:1"], linkedServicePlanIds: [] }, phaseSupply: [{ phaseId: "p1", unit: "housing-units", quantity: 500 }] });
  assert.equal(record.schema, NEW_TOWN_DEVELOPMENT_SCHEMA);
  assert.equal(record.id, "new-town-development:1");
  assert.deepEqual([record.developmentId, record.developmentRevision, record.status, record.name], ["dev:a", "rev:1", "proposed", "Hanamaki New Town"]);
  assert.deepEqual(record.phases.map((p) => [p.phaseId, p.sequence, p.playerDeclaredLandUse, p.status, p.statedSupply, p.occupancyFacts, p.hookId]), [
    ["p1", 1, "residential", "planned", { unit: "housing-units", quantity: 500 }, [], "new-town-development:1:phase:p1"],
    ["p2", 2, null, "planned", null, [], "new-town-development:1:phase:p2"],
    ["p3", 3, "commercial", "planned", null, [], "new-town-development:1:phase:p3"],
  ]);
  assert.deepEqual(record.links, { linkedPlanIds: ["plan:1", "plan:2"], linkedStationSiteIds: ["site:1"], linkedServicePlanIds: [] });
  assert.deepEqual(record.parties.player, { role: "player", partyId: "player", name: null, absent: false });
  assert.deepEqual(record.parties.municipality, { role: "municipality", partyId: null, name: "Hanamaki City", absent: false });
  assert.deepEqual(record.geometry, { developmentRevision: "rev:1", status: "current", reasons: [], checkedAtMinute: 0 });
  assert.deepEqual(record.history.map((h) => [h.transitionId, h.kind, h.from, h.to]), [["new-town-development:1:transition:1", "draft", null, "draft"], ["new-town-development:1:transition:2", "propose", "draft", "proposed"]]);
  const drafted = g.draftNewTownDevelopment({ developmentId: "dev:b" });
  assert.deepEqual([drafted.id, drafted.status, drafted.phases, drafted.developmentRevision, drafted.geometry.status, drafted.geometry.reasons], ["new-town-development:2", "draft", null, null, "missing", ["geometry-not-provided"]], "no map: phases are unknown (null), not empty");
  assert.throws(() => g.proposeNewTownDevelopment({ id: drafted.id }), /geometry-missing, geometry-not-provided/);
  const proposed = g.proposeNewTownDevelopment({ id: drafted.id, geometry: geometry({ developmentId: "dev:b", developmentRevision: "rev:9" }) });
  assert.deepEqual([proposed.status, proposed.developmentRevision, proposed.phases.length], ["proposed", "rev:9", 3]);
  assert.equal(g.draftNewTownDevelopment({ geometry: geometry({ developmentId: "dev:c" }), phaseSupply: [{ phaseId: "p2", unit: "jobs", quantity: 0 }] }).phases[1].statedSupply.quantity, 0, "a stated zero is a zero");
});

test("propose refuses what it cannot trust: no / unusable / inactive geometry, a second active record for the same development, bad parties, links and supply", () => {
  const g = newGame();
  for (const bad of [null, undefined, geometry({ active: false }), geometry({ active: null }), geometry({ developmentRevision: "" }), geometry({ phases: [] })]) {
    assert.throws(() => g.proposeNewTownDevelopment({ geometry: bad }), /geometry|developmentId/);
  }
  assert.equal(g.newTownDevelopments.length, 0);
  assert.equal(g.nextNewTownDevelopmentSequence, 1, "a refused proposal does not use up an id");
  const first = g.proposeNewTownDevelopment({ geometry: geometry() });
  assert.throws(() => g.proposeNewTownDevelopment({ geometry: geometry() }), /already has an active record new-town-development:1/);
  assert.throws(() => g.draftNewTownDevelopment({ developmentId: "dev:a" }), /already has an active record/);
  g.cancelNewTownDevelopment(first.id, "start over");
  assert.equal(g.proposeNewTownDevelopment({ geometry: geometry({ developmentRevision: "rev:2" }) }).id, "new-town-development:2", "a cancelled record does not block a new one, and its id is not reused");
  for (const input of [{ parties: { municipality: { absent: true, name: "x" } } }, { parties: { developer: "x" } }, { links: { linkedPlanIds: "plan" } }, { links: { linkedPlanIds: [""] } },
    { phaseSupply: [{ phaseId: "p9", unit: "u", quantity: 1 }] }, { phaseSupply: [{ phaseId: "p1", unit: "u", quantity: -1 }] }, { phaseSupply: [{ phaseId: "p1", unit: "u", quantity: 1.5 }] },
    { phaseSupply: [{ phaseId: "p1", unit: "", quantity: 1 }] }, { phaseSupply: [{ phaseId: "p1", unit: "u", quantity: 1 }, { phaseId: "p1", unit: "u", quantity: 2 }] }, { phaseSupply: {} }]) {
    assert.throws(() => g.draftNewTownDevelopment({ geometry: geometry({ developmentId: "dev:z" }), ...input }), Error, JSON.stringify(input));
  }
  assert.throws(() => g.draftNewTownDevelopment({ phaseSupply: [{ phaseId: "p1", unit: "u", quantity: 1 }], developmentId: "dev:y" }), /geometry/);
  assert.throws(() => g.draftNewTownDevelopment({}), /developmentId/);
});

test("agree: burdens say who bears what and money is only a stated number; the counterparties must be named (or stated absent) and the map must be current", () => {
  const { g, id, geo } = make("proposed");
  const agreed = g.agreeNewTownDevelopment(id, AGREEMENT, { geometry: geo });
  assert.equal(agreed.status, "agreed");
  assert.deepEqual(agreed.agreement, {
    agreedAtMinute: 0,
    burdens: [{ itemId: "land-assembly", bearers: ["developer"], statedAmountJPY: null, note: null }, { itemId: "rail-construction", bearers: ["municipality", "player"], statedAmountJPY: 1_000_000, note: null }],
    connectionConditions: [{ conditionId: "c1", text: "The station opens before phase 2 is serviced", linkedStationSiteId: "site:1", linkedServicePlanId: null }],
  });
  const noConditions = make("proposed");
  assert.equal(noConditions.g.agreeNewTownDevelopment(noConditions.id, { burdens: AGREEMENT.burdens }, { geometry: noConditions.geo }).agreement.connectionConditions, null, "conditions not stated are null, not an empty list");
  const none = make("proposed");
  assert.deepEqual(none.g.agreeNewTownDevelopment(none.id, { burdens: AGREEMENT.burdens, connectionConditions: [] }, { geometry: none.geo }).agreement.connectionConditions, []);

  const unknownParties = newGame();
  const draft = unknownParties.proposeNewTownDevelopment({ geometry: geometry() });
  assert.throws(() => unknownParties.agreeNewTownDevelopment(draft.id, AGREEMENT, { geometry: geometry() }), /party-unknown:municipality, party-unknown:developer/);
  const named = unknownParties.agreeNewTownDevelopment(draft.id, { ...AGREEMENT, parties: PARTIES }, { geometry: geometry() });
  assert.deepEqual([named.parties.municipality.name, named.parties.developer.partyId], ["Hanamaki City", "dev-co"]);
  const publicOnly = newGame();
  const p = publicOnly.proposeNewTownDevelopment({ geometry: geometry(), parties: { municipality: { name: "City" }, developer: { absent: true } } });
  assert.throws(() => publicOnly.agreeNewTownDevelopment(p.id, { burdens: [{ itemId: "x", bearers: ["developer"] }] }, { geometry: geometry() }), /developer/);
  assert.equal(publicOnly.agreeNewTownDevelopment(p.id, { burdens: [{ itemId: "x", bearers: ["municipality"] }] }, { geometry: geometry() }).status, "agreed", "a party stated absent is not 'unknown'");
});

test("agree refuses a bad agreement whole and changes nothing", () => {
  const { g, id, geo } = make("proposed");
  const before = g.snapshot();
  const bad = [
    undefined, null, "x", {}, { burdens: [] }, { burdens: "x" }, { burdens: [{ itemId: "", bearers: ["player"] }] }, { burdens: [{ itemId: "a", bearers: [] }] }, { burdens: [{ itemId: "a", bearers: ["mayor"] }] },
    { burdens: [{ itemId: "a", bearers: ["player", "player"] }] }, { burdens: [{ itemId: "a", bearers: ["player"] }, { itemId: "a", bearers: ["developer"] }] },
    { burdens: [{ itemId: "a", bearers: ["player"], statedAmountJPY: -1 }] }, { burdens: [{ itemId: "a", bearers: ["player"], statedAmountJPY: 1.5 }] }, { burdens: [{ itemId: "a", bearers: ["player"], statedAmountJPY: "10" }] },
    { burdens: AGREEMENT.burdens, connectionConditions: "x" }, { burdens: AGREEMENT.burdens, connectionConditions: [{ conditionId: "c", text: "" }] },
    { burdens: AGREEMENT.burdens, connectionConditions: [{ conditionId: "c", text: "a" }, { conditionId: "c", text: "b" }] },
  ];
  for (const agreement of bad) assert.throws(() => g.agreeNewTownDevelopment(id, agreement, { geometry: geo }), Error, JSON.stringify(agreement));
  assert.deepEqual(g.snapshot(), before);
});

test("a map that is missing, unusable, inactive or stale blocks every step that moves a development forward, with the reasons; delaying and cancelling still work", () => {
  const blockedGeometries = {
    missing: [null, /geometry-missing, geometry-not-provided/], unknown: [geometry({ active: null }), /geometry-invalid, geometry-active-unknown/], inactive: [geometry({ active: false }), /geometry-inactive/],
    revision: [geometry({ developmentRevision: "rev:2" }), /geometry-stale, geometry-revision-changed/], phases: [geometry({ phases: geometry().phases.slice(1) }), /geometry-stale, geometry-phases-changed/],
    other: [geometry({ developmentId: "dev:other" }), /geometry-stale, geometry-other-development/],
  };
  for (const [name, [bad, pattern]] of Object.entries(blockedGeometries)) {
    const proposed = make("proposed");
    assert.throws(() => proposed.g.agreeNewTownDevelopment(proposed.id, AGREEMENT, { geometry: bad }), pattern, `agree/${name}`);
    const agreed = make("agreed");
    assert.throws(() => agreed.g.startNewTownServicing(agreed.id, { geometry: bad }), /geometry-/, `servicing/${name}`);
    const servicing = make("servicing");
    assert.throws(() => servicing.g.recordNewTownOccupancy(servicing.id, "p1", FACTS, { geometry: bad }), /geometry-/, `occupancy/${name}`);
    const delayed = make("delayed");
    assert.throws(() => delayed.g.resumeNewTownDevelopment(delayed.id, { geometry: bad }), /geometry-/, `resume/${name}`);
    const draft = makeDraft();
    assert.throws(() => draft.g.proposeNewTownDevelopment({ id: draft.id, geometry: bad }), /geometry-/, `propose/${name}`);
    assert.equal(servicing.g.requireNewTownDevelopment(servicing.id).status, "servicing");
    assert.equal(servicing.g.delayNewTownDevelopment(servicing.id, "the map changed").status, "delayed", `delay/${name}`);
    assert.equal(proposed.g.cancelNewTownDevelopment(proposed.id, "the map changed").status, "cancelled", `cancel/${name}`);
  }
  const stale = make("servicing");
  const assessment = stale.g.assessNewTownDevelopment({ id: stale.id, geometry: geometry({ developmentRevision: "rev:2" }) });
  assert.deepEqual(assessment.geometry, { status: "stale", reasons: ["geometry-revision-changed"] });
  assert.deepEqual(assessment.transitions.recordOccupancy, { allowed: false, blockers: ["geometry-stale", "geometry-revision-changed"] });
  assert.equal(assessment.transitions.delay.allowed, true);
  assert.equal(stale.g.requireNewTownDevelopment(stale.id).geometry.status, "current", "the stored state is only what the last accepted step saw");
});

test("servicing starts phases in order: by default the first planned phase, or the ones named; a later phase cannot jump the queue", () => {
  const { g, id, geo } = make("agreed");
  assert.throws(() => g.startNewTownServicing(id, { geometry: geo, phaseIds: ["p2"] }), /p2/);
  assert.throws(() => g.startNewTownServicing(id, { geometry: geo, phaseIds: [] }), /phaseIds/);
  assert.throws(() => g.startNewTownServicing(id, { geometry: geo, phaseIds: ["p1", "p1"] }), /phaseIds/);
  assert.throws(() => g.startNewTownServicing(id, { geometry: geo, phaseIds: ["p9"] }), /p9/);
  const first = g.startNewTownServicing(id, { geometry: geo });
  assert.deepEqual(first.phases.map((p) => p.status), ["servicing", "planned", "planned"]);
  assert.equal(first.status, "servicing");
  assert.throws(() => g.startNewTownServicing(id, { geometry: geo, phaseIds: ["p1"] }), /p1/);
  const both = g.startNewTownServicing(id, { geometry: geo, phaseIds: ["p2", "p3"] });
  assert.deepEqual(both.phases.map((p) => p.status), ["servicing", "servicing", "servicing"]);
  assert.throws(() => g.startNewTownServicing(id, { geometry: geo }), /no-planned-phase/);
  assert.deepEqual(both.history.at(-1).phaseIds, ["p2", "p3"]);
  assert.deepEqual([both.history.at(-1).from, both.history.at(-1).to], ["servicing", "servicing"]);
});

test("occupancy: stated facts are appended as they were stated, per phase, with stable ids; the first one makes the development occupied; no rate is computed", () => {
  const { g, id, geo } = make("servicing");
  assert.throws(() => g.recordNewTownOccupancy(id, "p2", FACTS, { geometry: geo }), /p2/);
  assert.throws(() => g.recordNewTownOccupancy(id, "p9", FACTS, { geometry: geo }), /p9/);
  for (const bad of [undefined, null, {}, { source: "x" }, { statedOccupiedUnits: null, statedPlannedUnits: null, source: "x" }, { statedOccupiedUnits: -1, source: "x" }, { statedOccupiedUnits: 1.5, source: "x" }, { statedOccupiedUnits: "3", source: "x" }, { statedOccupiedUnits: 3 }, { statedOccupiedUnits: 3, source: " " }]) {
    assert.throws(() => g.recordNewTownOccupancy(id, "p1", bad, { geometry: geo }), Error, JSON.stringify(bad));
  }
  assert.equal(g.requireNewTownDevelopment(id).status, "servicing");
  const one = g.recordNewTownOccupancy(id, "p1", FACTS, { geometry: geo });
  assert.equal(one.status, "occupied");
  assert.deepEqual(one.phases[0].occupancyFacts, [{ factId: "new-town-development:1:phase:p1:occupancy:1", sequence: 1, recordedAtMinute: 0, statedOccupiedUnits: 120, statedPlannedUnits: 500, unit: "housing-units", source: "player-stated", note: null }]);
  assert.equal(one.phases[0].status, "occupied");
  const two = g.recordNewTownOccupancy(id, "p1", { statedOccupiedUnits: 0, source: "survey", note: "nobody has moved in yet" }, { geometry: geo });
  assert.deepEqual(two.phases[0].occupancyFacts.map((f) => [f.factId.split(":").at(-1), f.statedOccupiedUnits, f.statedPlannedUnits]), [["1", 120, 500], ["2", 0, null]], "a stated zero is kept as zero and an unstated number as null");
  assert.deepEqual(two.phases[0].occupancyFacts[0], one.phases[0].occupancyFacts[0], "earlier facts are never rewritten");
  assert.equal(JSON.stringify(two).match(/rate|ratio|percent|population|demandNodes/i), null, "nothing derived from the facts");
  const second = g.startNewTownServicing(id, { geometry: geo });
  assert.deepEqual(second.phases.map((p) => p.status), ["occupied", "servicing", "planned"]);
  assert.equal(second.status, "occupied");
});

test("delay and resume: a delay needs a reason and remembers where it came from; resume goes back there and needs a current map; cancel is final", () => {
  const { g, id, geo } = make("servicing");
  for (const bad of [undefined, null, "", "   ", 5, "x".repeat(201)]) assert.throws(() => g.delayNewTownDevelopment(id, bad), /reason/);
  const delayed = g.delayNewTownDevelopment(id, "  land permit is late  ");
  assert.deepEqual(delayed.delay, { reason: "land permit is late", delayedAtMinute: 0, fromStatus: "servicing", resumedAtMinute: null });
  assert.throws(() => g.recordNewTownOccupancy(id, "p1", FACTS, { geometry: geo }), /status-not-allowed:delayed/);
  assert.throws(() => g.resumeNewTownDevelopment(id, {}), /geometry-missing/);
  g.clock.minute = 500;
  const resumed = g.resumeNewTownDevelopment(id, { geometry: geo });
  assert.equal(resumed.status, "servicing");
  assert.equal(resumed.delay.resumedAtMinute, 500);
  assert.deepEqual(resumed.history.slice(-2).map((h) => [h.kind, h.from, h.to, h.atMinute, h.reason]), [["delay", "servicing", "delayed", 0, "land permit is late"], ["resume", "delayed", "servicing", 500, null]]);
  const again = g.delayNewTownDevelopment(id, "second delay");
  assert.equal(again.delay.delayedAtMinute, 500);
  assert.equal(again.history.length, resumed.history.length + 1);
  const agreed = make("agreed");
  agreed.g.delayNewTownDevelopment(agreed.id, "waiting for the city");
  assert.equal(agreed.g.resumeNewTownDevelopment(agreed.id, { geometry: agreed.geo }).status, "agreed", "it goes back to where it was");
  assert.throws(() => g.cancelNewTownDevelopment(id, ""), /reason/);
  const cancelled = g.cancelNewTownDevelopment(id, "the developer withdrew");
  assert.deepEqual(cancelled.cancellation, { reason: "the developer withdrew", cancelledAtMinute: 500, fromStatus: "delayed" });
  for (const kind of ["delayNewTownDevelopment", "cancelNewTownDevelopment"]) assert.throws(() => g[kind](id, "again"), /status-not-allowed:cancelled/);
});

test("cancelling stops unfinished phases and keeps the people who already moved in as occupied", () => {
  const { g, id, geo } = make("occupied");
  g.startNewTownServicing(id, { geometry: geo });
  const cancelled = g.cancelNewTownDevelopment(id, "market collapsed");
  assert.deepEqual(cancelled.phases.map((p) => p.status), ["occupied", "cancelled", "cancelled"]);
  assert.equal(cancelled.phases[0].occupancyFacts.length, 1, "the facts stay");
  const draft = makeDraft();
  assert.equal(draft.g.cancelNewTownDevelopment(draft.id, "never mind").status, "cancelled");
  const g2 = newGame();
  const d2 = g2.draftNewTownDevelopment({ developmentId: "dev:q" });
  assert.equal(g2.cancelNewTownDevelopment(d2.id, "no map ever came").phases, null, "unknown phases stay unknown");
});

test("no money moves, no random number is drawn and the clock is only read: every step leaves the ledger, the cash, the random generator and the clock as they were", () => {
  const g = newGame();
  const before = { money: money(g), rng: JSON.stringify(g.rng.snapshot()), clock: g.clock.minute, queue: JSON.stringify(g.clock.queue) };
  const geo = geometry();
  const { id } = g.proposeNewTownDevelopment({ geometry: geo, parties: PARTIES });
  g.assessNewTownDevelopment({ id, geometry: geo }); g.assessNewTownDevelopment({ geometry: geo });
  g.agreeNewTownDevelopment(id, AGREEMENT, { geometry: geo });
  g.startNewTownServicing(id, { geometry: geo });
  g.recordNewTownOccupancy(id, "p1", FACTS, { geometry: geo });
  g.delayNewTownDevelopment(id, "late"); g.resumeNewTownDevelopment(id, { geometry: geo });
  g.newTownDevelopmentReport(); g.newTownDevelopmentHooks(id);
  g.cancelNewTownDevelopment(id, "done");
  assert.deepEqual({ money: money(g), rng: JSON.stringify(g.rng.snapshot()), clock: g.clock.minute, queue: JSON.stringify(g.clock.queue) }, before);
  assert.deepEqual([...new Set(g.events.entries.filter((e) => e.type.startsWith("new-town-development")).map((e) => e.type))].sort(), [
    "new-town-development-agreed", "new-town-development-cancelled", "new-town-development-delayed", "new-town-development-occupancy-recorded", "new-town-development-proposed", "new-town-development-resumed", "new-town-development-servicing-started",
  ]);
});

test("the read-only assessment and report change nothing and do not depend on call order; frozen inputs work", () => {
  const { g, id } = make("agreed");
  const before = JSON.stringify(g.snapshot());
  const frozen = deepFreeze(geometry());
  const a = g.assessNewTownDevelopment({ id, geometry: frozen });
  assert.equal(JSON.stringify(g.assessNewTownDevelopment({ id, geometry: frozen })), JSON.stringify(a));
  g.assessNewTownDevelopment({ geometry: frozen }); g.assessNewTownDevelopment({}); g.assessNewTownDevelopment();
  g.newTownDevelopmentReport(); g.newTownDevelopmentReport(id); g.newTownDevelopmentHooks(id);
  assert.equal(JSON.stringify(g.snapshot()), before);
  assert.deepEqual(a.notComputed, [...NEW_TOWN_NOT_COMPUTED]);
  const create = g.assessNewTownDevelopment({ geometry: frozen });
  assert.deepEqual(create.create.propose, { allowed: false, blockers: ["development-already-has-an-active-record:new-town-development:1"] });
  assert.deepEqual(create.create.draft, { allowed: false, blockers: ["development-already-has-an-active-record:new-town-development:1"] }, "the assessment agrees with what drafting would do");
  assert.equal(g.assessNewTownDevelopment({ geometry: geometry({ developmentId: "dev:new" }) }).create.draft.allowed, true);
  assert.equal(g.assessNewTownDevelopment({ geometry: geometry({ developmentId: "dev:new" }) }).create.propose.allowed, true);
  assert.deepEqual(g.assessNewTownDevelopment({ geometry: null }).create.propose.blockers, ["geometry-missing", "geometry-not-provided"], "no map is not 'allowed'");
  assert.deepEqual(g.assessNewTownDevelopment({ id }).transitions.startServicing, { allowed: false, blockers: ["geometry-missing", "geometry-not-provided"] });
  assert.throws(() => g.assessNewTownDevelopment({ id: "new-town-development:99" }), /Unknown new town development/);
  const fresh = newGame();
  assert.equal(fresh.proposeNewTownDevelopment({ geometry: deepFreeze(geometry({ developmentId: "dev:frozen" })), parties: deepFreeze({ ...PARTIES }), links: deepFreeze({ linkedPlanIds: ["a"] }), phaseSupply: deepFreeze([{ phaseId: "p1", unit: "u", quantity: 1 }]) }).status, "proposed");
});

test("the stored record shares nothing with what was passed in or handed out", () => {
  const g = newGame();
  const geo = geometry();
  const parties = { municipality: { name: "City" }, developer: { name: "Dev" } };
  const links = { linkedPlanIds: ["plan:1"] };
  const returned = g.proposeNewTownDevelopment({ geometry: geo, parties, links });
  geo.phases[0].playerDeclaredLandUse = "tampered"; geo.developmentRevision = "tampered"; parties.municipality.name = "tampered"; links.linkedPlanIds.push("tampered");
  returned.status = "tampered"; returned.phases[0].status = "tampered"; returned.history.length = 0;
  const stored = g.newTownDevelopmentReport()[0];
  assert.deepEqual([stored.status, stored.developmentRevision, stored.phases[0].playerDeclaredLandUse, stored.parties.municipality.name, stored.links.linkedPlanIds], ["proposed", "rev:1", "residential", "City", ["plan:1"]]);
  stored.status = "tampered";
  assert.equal(g.newTownDevelopmentReport()[0].status, "proposed");
  const agreement = structuredClone(AGREEMENT);
  const agreed = make("proposed");
  agreed.g.agreeNewTownDevelopment(agreed.id, agreement, { geometry: agreed.geo });
  agreement.burdens[0].bearers.push("tampered");
  assert.ok(!JSON.stringify(agreed.g.newTownDevelopmentReport()).includes("tampered"));
});

test("links are references only: any text is kept as stated, sorted and de-duplicated, and none is looked up; unstated links are null", () => {
  const g = newGame();
  const a = g.proposeNewTownDevelopment({ geometry: geometry(), links: { linkedPlanIds: ["no-such-plan", "no-such-plan", " b "], linkedStationSiteIds: [], linkedServicePlanIds: ["map-plan:9"] } });
  assert.deepEqual(a.links, { linkedPlanIds: ["b", "no-such-plan"], linkedStationSiteIds: [], linkedServicePlanIds: ["map-plan:9"] });
  const b = g.proposeNewTownDevelopment({ geometry: geometry({ developmentId: "dev:b" }) });
  assert.deepEqual(b.links, { linkedPlanIds: null, linkedStationSiteIds: null, linkedServicePlanIds: null });
});

test("ids only go up and are never reused, across failures, cancellations, save and load", () => {
  const g = newGame();
  const ids = [];
  for (let i = 0; i < 3; i += 1) ids.push(g.proposeNewTownDevelopment({ geometry: geometry({ developmentId: `dev:${i}` }) }).id);
  assert.deepEqual(ids, ["new-town-development:1", "new-town-development:2", "new-town-development:3"]);
  assert.throws(() => g.proposeNewTownDevelopment({ geometry: null }));
  g.cancelNewTownDevelopment(ids[2], "no");
  assert.equal(g.draftNewTownDevelopment({ developmentId: "dev:x" }).id, "new-town-development:4");
  const restored = ManagementGame.load(g.save());
  assert.equal(restored.draftNewTownDevelopment({ developmentId: "dev:y" }).id, "new-town-development:5");
  const lost = new ManagementGame().restore((() => { const s = g.snapshot(); delete s.nextNewTownDevelopmentSequence; return s; })());
  assert.equal(lost.nextNewTownDevelopmentSequence, 5, "a save that lost its counter still never reuses an id");
  assert.equal(lost.draftNewTownDevelopment({ developmentId: "dev:z" }).id, "new-town-development:5");
  assert.equal(g.newTownDevelopments.length, 4, "nothing is ever deleted");
});

test("a failure inside the transaction rolls back the record, the history, the events, the random generator and the id counter", () => {
  const g = newGame();
  const { id, geo } = make("proposed", g);
  const kinds = {
    draft: () => g.draftNewTownDevelopment({ developmentId: "dev:r" }),
    propose: () => g.proposeNewTownDevelopment({ geometry: geometry({ developmentId: "dev:r2" }) }),
    agree: () => g.agreeNewTownDevelopment(id, AGREEMENT, { geometry: geo }),
  };
  for (const [name, run] of Object.entries(kinds)) {
    const before = g.snapshot();
    const events = g.events.entries.length;
    const real = g.ledger.assertInvariant.bind(g.ledger);
    g.ledger.assertInvariant = () => { throw new Error("ledger broke after the step"); };
    assert.throws(run, /ledger broke/, name);
    g.ledger.assertInvariant = real;
    assert.deepEqual(g.snapshot(), before, `${name}: state, rng, events and counters are back`);
    assert.equal(g.events.entries.length, events);
  }
  assert.equal(g.requireNewTownDevelopment(id).status, "proposed");
  assert.equal(g.nextNewTownDevelopmentSequence, 2);
  assert.equal(g.draftNewTownDevelopment({ developmentId: "dev:r" }).id, "new-town-development:2", "the id that the failed step took is free again");
  const sg = newGame();
  const s = make("servicing", sg);
  for (const run of [() => sg.recordNewTownOccupancy(s.id, "p1", FACTS, { geometry: s.geo }), () => sg.delayNewTownDevelopment(s.id, "late"), () => sg.cancelNewTownDevelopment(s.id, "stop"), () => sg.startNewTownServicing(s.id, { geometry: s.geo })]) {
    const before = sg.snapshot();
    const real = sg.ledger.assertInvariant.bind(sg.ledger);
    sg.ledger.assertInvariant = () => { throw new Error("late failure"); };
    assert.throws(run, /late failure/);
    sg.ledger.assertInvariant = real;
    assert.deepEqual(sg.snapshot(), before);
  }
});

test("save and load: every state round-trips exactly, hooks and ids included", () => {
  const g = newGame();
  const a = make("occupied", g, geometry({ developmentId: "dev:1" }));
  const b = make("delayed", g, geometry({ developmentId: "dev:2" }));
  const c = make("cancelled", g, geometry({ developmentId: "dev:3" }));
  const d = make("proposed", g, geometry({ developmentId: "dev:4" }));
  const e = makeDraft(g, geometry({ developmentId: "dev:5" }));
  g.draftNewTownDevelopment({ developmentId: "dev:6" });
  const restored = ManagementGame.load(g.save());
  assert.deepEqual(restored.snapshot(), g.snapshot());
  assert.deepEqual(restored.newTownDevelopmentReport(), g.newTownDevelopmentReport());
  assert.deepEqual(restored.newTownDevelopments.map((r) => r.status), ["occupied", "delayed", "cancelled", "proposed", "draft", "draft"]);
  for (const { id } of [a, b, c, d, e]) assert.deepEqual(restored.newTownDevelopmentHooks(id), g.newTownDevelopmentHooks(id));
  assert.equal(JSON.stringify(restored.snapshot()), JSON.stringify(g.snapshot()), "byte for byte");
  assert.equal(restored.recordNewTownOccupancy(a.id, "p1", FACTS, { geometry: a.geo }).phases[0].occupancyFacts.at(-1).factId, `${a.id}:phase:p1:occupancy:2`);
  assert.equal(restored.resumeNewTownDevelopment(b.id, { geometry: b.geo }).status, "servicing");
  assert.throws(() => restored.proposeNewTownDevelopment({ id: c.id, geometry: c.geo }), /status-not-allowed:cancelled/);
});

test("old saves keep working: a save without the new keys restores with no developments and the first id", () => {
  const snapshot = newGame().snapshot();
  delete snapshot.newTownDevelopments;
  delete snapshot.nextNewTownDevelopmentSequence;
  const restored = new ManagementGame().restore(snapshot);
  assert.deepEqual(restored.newTownDevelopments, []);
  assert.equal(restored.nextNewTownDevelopmentSequence, 1);
  assert.deepEqual(restored.newTownDevelopmentReport(), []);
  assert.throws(() => restored.cancelNewTownDevelopment("new-town-development:1", "x"), /Unknown new town development/);
  assert.equal(restored.proposeNewTownDevelopment({ geometry: geometry() }).id, "new-town-development:1");
  const empty = newGame().snapshot();
  assert.deepEqual([empty.newTownDevelopments, empty.nextNewTownDevelopmentSequence], [[], 1]);
});

test("hooks: stable ids for the demand and event bridges, the player's stated facts copied as they are, and nothing converted", () => {
  const { g, id } = make("occupied");
  g.delayNewTownDevelopment(id, "late");
  const hooks = g.newTownDevelopmentHooks(id);
  assert.equal(hooks.developmentHookId, id);
  assert.deepEqual([hooks.developmentId, hooks.developmentRevision, hooks.status, hooks.geometryStatus], ["dev:a", "rev:1", "delayed", "current"]);
  assert.deepEqual(hooks.phases.map((p) => [p.hookId, p.phaseId, p.sequence, p.status, p.playerDeclaredLandUse]), [
    ["new-town-development:1:phase:p1", "p1", 1, "occupied", "residential"], ["new-town-development:1:phase:p2", "p2", 2, "planned", null], ["new-town-development:1:phase:p3", "p3", 3, "planned", "commercial"],
  ]);
  assert.deepEqual(hooks.phases[0].statedSupply, { unit: "housing-units", quantity: 500 });
  assert.equal(hooks.phases[0].occupancyFacts[0].statedOccupiedUnits, 120);
  assert.deepEqual(hooks.transitions.map((t) => [t.transitionId.split(":").at(-1), t.kind, t.to]), [["1", "draft", "draft"], ["2", "propose", "proposed"], ["3", "agree", "agreed"], ["4", "startServicing", "servicing"], ["5", "recordOccupancy", "occupied"], ["6", "delay", "delayed"]]);
  assert.deepEqual(hooks.links, { linkedPlanIds: ["plan:1"], linkedStationSiteIds: null, linkedServicePlanIds: null });
  assert.deepEqual(hooks.notComputed, [...NEW_TOWN_NOT_COMPUTED]);
  assert.deepEqual(newTownDevelopmentHooks(g.newTownDevelopments[0]), hooks);
  hooks.phases[0].occupancyFacts.length = 0;
  assert.equal(g.newTownDevelopmentHooks(id).phases[0].occupancyFacts.length, 1);
});

test("ScenarioRuntime: the same steps through the runtime, in report(), and through a runtime save and load", () => {
  const pack = { manifest: { id: "new-town-runtime", version: "1", data: { license: "test", attribution: [] } }, demand: { model: "gravity", points: [], attractors: [] } };
  const build = () => new ScenarioRuntime({ pack, operationalState: createState(pack) });
  const runtime = build();
  const geo = geometry();
  assert.deepEqual(runtime.report().newTownDevelopments, []);
  assert.equal(runtime.assessNewTownDevelopment({ geometry: geo }).create.propose.allowed, true);
  const draft = runtime.draftNewTownDevelopment({ geometry: geo, parties: PARTIES });
  runtime.proposeNewTownDevelopment({ id: draft.id, geometry: geo });
  runtime.agreeNewTownDevelopment(draft.id, AGREEMENT, { geometry: geo });
  runtime.startNewTownServicing(draft.id, { geometry: geo });
  runtime.recordNewTownOccupancy(draft.id, "p1", FACTS, { geometry: geo });
  runtime.delayNewTownDevelopment(draft.id, "late");
  assert.equal(runtime.newTownDevelopmentReport()[0].status, "delayed");
  assert.deepEqual(runtime.report().newTownDevelopments, runtime.newTownDevelopmentReport());
  assert.throws(() => runtime.resumeNewTownDevelopment(draft.id, { geometry: geometry({ developmentRevision: "rev:2" }) }), /geometry-stale/);
  const other = build();
  other.load(runtime.save());
  assert.deepEqual(other.newTownDevelopmentReport(), runtime.newTownDevelopmentReport());
  assert.equal(other.newTownDevelopmentReport()[0].delay.fromStatus, "occupied");
  assert.equal(other.resumeNewTownDevelopment(draft.id, { geometry: geo }).status, "occupied");
  assert.equal(other.newTownDevelopmentHooks(draft.id).phases[0].occupancyFacts.length, 1);
  assert.equal(other.cancelNewTownDevelopment(draft.id, "stop").status, "cancelled");
  assert.throws(() => other.proposeNewTownDevelopment({ geometry: null }), /developmentId/);
});

test("pack identity: a geometry without a source pack is never current; the record keeps the pack it was first linked to", () => {
  for (const bad of [undefined, null, "", "  ", 7]) {
    const g = geometry({ sourcePackId: bad });
    assert.deepEqual(checkNewTownGeometry(g), { status: "invalid", reasons: ["geometry-source-pack-unknown"] }, String(bad));
    assert.throws(() => newGame().proposeNewTownDevelopment({ geometry: g }), /geometry-source-pack-unknown/);
  }
  assert.deepEqual(checkNewTownGeometry(geometry({ sourcePackVersion: 3 })), { status: "invalid", reasons: ["geometry-source-pack-version-invalid"] });
  assert.equal(checkNewTownGeometry(geometry({ sourcePackVersion: undefined })).status, "current", "a version not stated is stored as unknown (null), not guessed");
  const g = newGame();
  const proposed = g.proposeNewTownDevelopment({ geometry: geometry({ sourcePackId: " pack:tokyo ", sourcePackVersion: "1" }) });
  assert.deepEqual(proposed.sourcePack, { packId: "pack:tokyo", packVersion: "1" });
  const noVersion = newGame().proposeNewTownDevelopment({ geometry: geometry({ sourcePackVersion: null }) });
  assert.deepEqual(noVersion.sourcePack, { packId: "pack:tokyo", packVersion: null });
  // a draft without a map has no pack yet; the first map that proposes it fixes the pack
  const draft = newGame();
  const d = draft.draftNewTownDevelopment({ developmentId: "dev:a" });
  assert.equal(d.sourcePack, null);
  assert.equal(draft.proposeNewTownDevelopment({ id: d.id, geometry: geometry({ sourcePackId: "pack:osaka" }) }).sourcePack.packId, "pack:osaka");
  assert.equal(g.newTownDevelopmentHooks(proposed.id).sourcePack.packId, "pack:tokyo");
});

test("another pack's geometry with the same developmentId blocks every step that moves forward; stopping still works", () => {
  const other = geometry({ sourcePackId: "pack:osaka" });
  const reasons = /geometry-stale, geometry-source-pack-changed/;
  const proposed = make("proposed");
  assert.throws(() => proposed.g.agreeNewTownDevelopment(proposed.id, AGREEMENT, { geometry: other }), reasons);
  const agreed = make("agreed");
  assert.throws(() => agreed.g.startNewTownServicing(agreed.id, { geometry: other }), reasons);
  const servicing = make("servicing");
  assert.throws(() => servicing.g.recordNewTownOccupancy(servicing.id, "p1", FACTS, { geometry: other }), reasons);
  const delayed = make("delayed");
  assert.throws(() => delayed.g.resumeNewTownDevelopment(delayed.id, { geometry: other }), reasons);
  const draft = makeDraft();
  assert.throws(() => draft.g.proposeNewTownDevelopment({ id: draft.id, geometry: other }), reasons);
  const assessment = servicing.g.assessNewTownDevelopment({ id: servicing.id, geometry: other });
  assert.deepEqual(assessment.geometry, { status: "stale", reasons: ["geometry-source-pack-changed"] });
  assert.equal(assessment.transitions.delay.allowed, true);
  assert.equal(servicing.g.delayNewTownDevelopment(servicing.id, "wrong pack loaded").status, "delayed");
  assert.equal(proposed.g.cancelNewTownDevelopment(proposed.id, "wrong pack loaded").status, "cancelled");
  // the same pack still passes, and a changed version of the same pack is stale as well
  assert.equal(servicing.g.requireNewTownDevelopment(servicing.id).sourcePack.packId, "pack:tokyo");
  const fresh = make("agreed");
  assert.deepEqual(fresh.g.assessNewTownDevelopment({ id: fresh.id, geometry: geometry({ sourcePackVersion: "2" }) }).geometry, { status: "stale", reasons: ["geometry-source-pack-version-changed"] });
  assert.equal(fresh.g.assessNewTownDevelopment({ id: fresh.id, geometry: geometry({ sourcePackVersion: null }) }).geometry.status, "current", "an unstated version cannot be compared, so it does not block on its own");
  assert.equal(fresh.g.startNewTownServicing(fresh.id, { geometry: geometry() }).status, "servicing");
});

test("a record saved before pack identity was kept reports it as unknown and is never assumed to be the current pack", () => {
  const { g, id, geo } = make("servicing");
  const legacy = g.snapshot();
  for (const record of legacy.newTownDevelopments) delete record.sourcePack;
  const restored = new ManagementGame().restore(legacy);
  assert.equal(restored.newTownDevelopmentHooks(id).sourcePack, null, "unknown is reported as null, not as a pack");
  assert.equal("sourcePack" in restored.newTownDevelopmentReport()[0], false, "nothing is filled in on restore");
  const assessment = restored.assessNewTownDevelopment({ id, geometry: geo });
  assert.deepEqual(assessment.geometry, { status: "stale", reasons: ["record-source-pack-unknown"] });
  for (const kind of ["startServicing", "recordOccupancy"]) assert.equal(assessment.transitions[kind].allowed, false, kind);
  assert.throws(() => restored.recordNewTownOccupancy(id, "p1", FACTS, { geometry: geo }), /record-source-pack-unknown/);
  assert.throws(() => restored.startNewTownServicing(id, { geometry: geo }), /record-source-pack-unknown/);
  assert.equal(restored.delayNewTownDevelopment(id, "pack identity unknown").status, "delayed", "stopping is still possible");
  assert.throws(() => restored.resumeNewTownDevelopment(id, { geometry: geo }), /record-source-pack-unknown/);
  assert.equal(restored.cancelNewTownDevelopment(id, "start again from the current map").status, "cancelled");
  // a legacy draft that never had a map has nothing to compare, so the first map can still be linked
  const empty = newGame();
  const d = empty.draftNewTownDevelopment({ developmentId: "dev:a" });
  const snapshot = empty.snapshot();
  delete snapshot.newTownDevelopments[0].sourcePack;
  const reloaded = new ManagementGame().restore(snapshot);
  assert.equal(reloaded.proposeNewTownDevelopment({ id: d.id, geometry: geometry() }).sourcePack.packId, "pack:tokyo");
});

test("the module keeps its promises: no random number, clock, money, map or demand code, and no import", () => {
  const source = fs.readFileSync(fileURLToPath(new URL("../src/management/new-town-development.mjs", import.meta.url)), "utf8").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/Math\.random|Date\.now|new Date|performance\.now|rng|\.next\(\)/.test(source));
  assert.ok(!/ledger|cash|commit\(|settle\(|\.pay|price\s*\(|cost\s*\(/i.test(source), "no money is moved or estimated");
  assert.ok(!/demand-engine|map\/|state\.mjs|trains|passengers/.test(source));
  assert.deepEqual([...source.matchAll(/^import .* from "(.*)";$/gm)].map((m) => m[1]), []);
  const game = fs.readFileSync(fileURLToPath(new URL("../src/management/game.mjs", import.meta.url)), "utf8");
  for (const name of ["draftNewTownDevelopment", "proposeNewTownDevelopment", "agreeNewTownDevelopment", "startNewTownServicing", "recordNewTownOccupancy", "delayNewTownDevelopment", "resumeNewTownDevelopment", "cancelNewTownDevelopment"]) {
    const start = game.indexOf(`  ${name}(`);
    assert.ok(start >= 0, `${name} exists`);
    assert.ok(game.slice(start, game.indexOf("\n  }\n", start)).includes("this.transact("), `${name} runs inside the management transaction`);
  }
});
