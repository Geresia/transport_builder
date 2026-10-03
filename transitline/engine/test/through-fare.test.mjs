import test from "node:test";
import assert from "node:assert/strict";
import {
  acceptThroughFareAgreement,
  activateThroughFareAgreement,
  calculateThroughFareSettlement,
  createThroughFareAgreement,
  fileThroughFareAgreement,
  ManagementGame,
  setThroughFareAgreementStatus,
} from "../src/management/index.mjs";

function throughService(overrides = {}) {
  return {
    schema: "transitline.through-service/1",
    contractVersion: 1,
    throughServiceId: "through-service:fare-test",
    throughRouteId: "through-route:fare-test",
    routeGeometryRevision: "revision:fare-test",
    status: "approved",
    guestModelId: "medium_4car",
    trainsPerHour: 4,
    operatorId: "player",
    payerOperatorId: "player",
    payeeOwnerId: null,
    legs: [
      { legId: "leg:player:a", infrastructureOwnerId: "player" },
      { legId: "leg:external", infrastructureOwnerId: "operator:external" },
      { legId: "leg:player:b", infrastructureOwnerId: "player" },
    ],
    handoverIds: ["handover:a", "handover:b"],
    trackAccessAgreementIds: [],
    vehicleTechnicalOverrides: {},
    approvedRetrofitProgramIds: [],
    assessment: { verdict: "possible", violations: [], conditions: [], missingInputs: [] },
    ...overrides,
  };
}

function terms(overrides = {}) {
  return [
    { operatorId: "player", legIds: ["leg:player:a", "leg:player:b"], sectionFareJPY: 220, ...overrides.player },
    { operatorId: "operator:external", legIds: ["leg:external"], sectionFareJPY: 180, ...overrides.external },
  ];
}

function agreement(input = {}) {
  return createThroughFareAgreement({
    id: "through-fare:test",
    throughService: throughService(),
    participantTerms: terms(),
    jointDiscountJPY: 70,
    ...input,
  });
}

function activate(value, service = throughService()) {
  for (const operatorId of value.participants.map((entry) => entry.operatorId)) acceptThroughFareAgreement(value, operatorId, 10);
  fileThroughFareAgreement(value, 20);
  activateThroughFareAgreement(value, service, 30);
  return value;
}

test("section fares minus a proportional joint discount reconcile to the passenger fare", () => {
  const value = agreement();
  assert.equal(value.grossFareJPY, 400);
  assert.equal(value.jointDiscountJPY, 70);
  assert.equal(value.passengerFareJPY, 330);
  assert.equal(value.participants.reduce((sum, entry) => sum + entry.discountBurdenJPY, 0), 70);
  assert.equal(value.participants.reduce((sum, entry) => sum + entry.netFareJPY, 0), 330);
  assert.deepEqual(value.participants.map((entry) => [entry.operatorId, entry.discountBurdenJPY]), [
    ["operator:external", 32],
    ["player", 38],
  ]);
});

test("fixed discount shares are negotiated explicitly and preserve every yen", () => {
  const value = agreement({
    discountAllocationMethod: "fixed-share",
    participantTerms: terms({ player: { discountShareBps: 6_000 }, external: { discountShareBps: 4_000 } }),
  });
  assert.deepEqual(value.participants.map((entry) => [entry.operatorId, entry.discountBurdenJPY, entry.netFareJPY]), [
    ["operator:external", 28, 152],
    ["player", 42, 178],
  ]);
});

test("participant and leg input order do not change the agreement economics", () => {
  const first = agreement();
  const reversed = agreement({ participantTerms: [...terms()].reverse().map((entry) => ({ ...entry, legIds: [...entry.legIds].reverse() })) });
  assert.deepEqual(first, reversed);
});

test("every through-service leg must be covered exactly once", () => {
  assert.throws(() => agreement({ participantTerms: [{ operatorId: "player", legIds: ["leg:player:a"], sectionFareJPY: 220 }] }), /does not cover/);
  assert.throws(() => agreement({ participantTerms: [
    ...terms(),
    { operatorId: "operator:third", legIds: ["leg:external"], sectionFareJPY: 100 },
  ] }), /assigned more than once/);
  assert.throws(() => agreement({ participantTerms: [{ operatorId: "player", legIds: ["leg:invented"], sectionFareJPY: 220 }] }), /Unknown fare leg/);
});

test("invalid discounts and collectors are rejected instead of silently reallocated", () => {
  assert.throws(() => agreement({ jointDiscountJPY: 401 }), /cannot exceed/);
  assert.throws(() => agreement({ collectingOperatorId: "operator:not-party" }), /must be a fare participant/);
  assert.throws(() => agreement({
    discountAllocationMethod: "fixed-share",
    participantTerms: terms({ player: { discountShareBps: 7_000 }, external: { discountShareBps: 4_000 } }),
  }), /total 10000/);
  assert.throws(() => agreement({
    jointDiscountJPY: 390,
    discountAllocationMethod: "fixed-share",
    participantTerms: terms({ player: { discountShareBps: 1_000 }, external: { discountShareBps: 9_000 } }),
  }), /exceeds/);
});

test("all parties must accept before filing and service approval gates activation", () => {
  const value = agreement();
  assert.throws(() => fileThroughFareAgreement(value), /cannot be filed/);
  acceptThroughFareAgreement(value, "player", 5);
  assert.equal(value.status, "draft");
  acceptThroughFareAgreement(value, "operator:external", 6);
  assert.equal(value.status, "accepted");
  assert.equal(value.fullyAcceptedAtMinute, 6);
  fileThroughFareAgreement(value, 7);
  assert.throws(() => activateThroughFareAgreement(value, throughService({ status: "assessed" }), 8), /approved/);
  activateThroughFareAgreement(value, throughService(), 9);
  assert.equal(value.status, "active");
});

test("an active agreement suspends, resumes and terminates through legal transitions", () => {
  const value = activate(agreement());
  setThroughFareAgreementStatus(value, "suspended", 40);
  assert.equal(value.status, "suspended");
  activateThroughFareAgreement(value, throughService(), 50);
  assert.equal(value.status, "active");
  setThroughFareAgreementStatus(value, "terminated", 60);
  assert.equal(value.status, "terminated");
  assert.throws(() => setThroughFareAgreementStatus(value, "suspended", 70), /cannot change/);
});

test("actual passenger allocation reconciles gross fare, discount and every operator share", () => {
  const value = activate(agreement());
  const settlement = calculateThroughFareSettlement(value, { passengers: 1_003, settlementId: "fare-settlement:1" });
  assert.equal(settlement.grossSectionFareJPY, 401_200);
  assert.equal(settlement.jointDiscountJPY, 70_210);
  assert.equal(settlement.passengerRevenueJPY, 330_990);
  assert.equal(settlement.allocations.reduce((sum, entry) => sum + entry.netRevenueJPY, 0), settlement.passengerRevenueJPY);
  assert.equal(settlement.allocations.find((entry) => entry.operatorId === "player").netRevenueJPY, 182_546);
});

test("settlement requires an active agreement and a known non-negative passenger count", () => {
  assert.throws(() => calculateThroughFareSettlement(agreement(), { passengers: 10 }), /active/);
  const value = activate(agreement());
  assert.throws(() => calculateThroughFareSettlement(value, { passengers: -1 }), /non-negative integer/);
  assert.throws(() => calculateThroughFareSettlement(value, { passengers: 1.5 }), /non-negative integer/);
});

function fareGame() {
  const game = new ManagementGame({ seed: 271, openingCash: 10_000_000_000 });
  game.throughServices.push(throughService());
  return game;
}

test("ManagementGame negotiates, files, activates, saves and reports without cash or RNG use", () => {
  const game = fareGame();
  const beforeCash = game.ledger.cash;
  const beforeRng = game.snapshot().rngState;
  const proposed = game.proposeThroughFareAgreement("through-service:fare-test", { participantTerms: terms(), jointDiscountJPY: 70 });
  game.acceptThroughFareAgreement(proposed.id, "player");
  game.acceptThroughFareAgreement(proposed.id, "operator:external");
  game.fileThroughFareAgreement(proposed.id);
  game.activateThroughFareAgreement(proposed.id);
  assert.equal(game.ledger.cash, beforeCash);
  assert.deepEqual(game.snapshot().rngState, beforeRng);
  const restored = ManagementGame.load(game.save());
  assert.deepEqual(restored.throughFareAgreementReport(), game.throughFareAgreementReport());
  assert.equal(restored.throughFareAgreementReport()[0].status, "active");
});

test("through-service suspension, resume and termination propagate to its fare agreement once", () => {
  const game = fareGame();
  const proposed = game.proposeThroughFareAgreement("through-service:fare-test", { participantTerms: terms(), jointDiscountJPY: 70 });
  game.acceptThroughFareAgreement(proposed.id, "player");
  game.acceptThroughFareAgreement(proposed.id, "operator:external");
  game.fileThroughFareAgreement(proposed.id);
  game.activateThroughFareAgreement(proposed.id);
  game.setThroughServiceStatus("through-service:fare-test", "suspended");
  assert.equal(game.requireThroughFareAgreement(proposed.id).status, "suspended");
  game.setThroughServiceStatus("through-service:fare-test", "approved");
  assert.equal(game.requireThroughFareAgreement(proposed.id).status, "active");
  game.setThroughServiceStatus("through-service:fare-test", "terminated");
  assert.equal(game.requireThroughFareAgreement(proposed.id).status, "terminated");
});

test("a manually suspended fare agreement is not accidentally resumed with the through service", () => {
  const game = fareGame();
  const proposed = game.proposeThroughFareAgreement("through-service:fare-test", { participantTerms: terms(), jointDiscountJPY: 70 });
  game.acceptThroughFareAgreement(proposed.id, "player");
  game.acceptThroughFareAgreement(proposed.id, "operator:external");
  game.fileThroughFareAgreement(proposed.id);
  game.activateThroughFareAgreement(proposed.id);
  game.setThroughFareAgreementStatus(proposed.id, "suspended");
  game.setThroughServiceStatus("through-service:fare-test", "suspended");
  game.setThroughServiceStatus("through-service:fare-test", "approved");
  assert.equal(game.requireThroughFareAgreement(proposed.id).status, "suspended");
});

test("failed game proposals roll back the agreement collection, sequence, cash and RNG", () => {
  const game = fareGame();
  const before = game.snapshot();
  assert.throws(() => game.proposeThroughFareAgreement("through-service:fare-test", {
    participantTerms: [{ operatorId: "player", legIds: ["leg:player:a"], sectionFareJPY: 220 }],
  }), /does not cover/);
  assert.deepEqual(game.snapshot(), before);
});

test("old saves restore an empty fare-agreement collection and a monotonic sequence", () => {
  const game = fareGame();
  const snapshot = game.snapshot();
  delete snapshot.throughFareAgreements;
  delete snapshot.nextThroughFareSequence;
  const restored = new ManagementGame().restore(snapshot);
  assert.deepEqual(restored.throughFareAgreements, []);
  assert.equal(restored.nextThroughFareSequence, 1);
});
