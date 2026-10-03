import test from "node:test";
import assert from "node:assert/strict";
import {
  acceptThroughFareAgreement,
  activateThroughFareAgreement,
  calculateThroughOperatingSettlement,
  createThroughFareAgreement,
  fileThroughFareAgreement,
  ManagementGame,
  VEHICLE_MODELS,
} from "../src/management/index.mjs";

function service(overrides = {}) {
  return {
    schema: "transitline.through-service/1",
    contractVersion: 1,
    throughServiceId: "through-service:operation",
    throughRouteId: "through-route:operation",
    routeGeometryRevision: "revision:operation",
    status: "approved",
    guestModelId: "medium_4car",
    trainsPerHour: 4,
    operatorId: "player",
    payerOperatorId: "player",
    payeeOwnerId: "operator:external",
    legs: [
      { legId: "leg:player", infrastructureOwnerId: "player" },
      { legId: "leg:external", infrastructureOwnerId: "operator:external" },
    ],
    handoverIds: ["handover:operation"],
    trackAccessAgreementIds: ["access:external"],
    vehicleTechnicalOverrides: {},
    approvedRetrofitProgramIds: [],
    assessment: { verdict: "possible", violations: [], conditions: [], missingInputs: [] },
    ...overrides,
  };
}

function fareAgreement(overrides = {}) {
  const linkedService = service();
  const value = createThroughFareAgreement({
    id: "through-fare:operation",
    throughService: linkedService,
    participantTerms: [
      { operatorId: "player", legIds: ["leg:player"], sectionFareJPY: 220 },
      { operatorId: "operator:external", legIds: ["leg:external"], sectionFareJPY: 180 },
    ],
    jointDiscountJPY: 70,
    ...overrides,
  });
  acceptThroughFareAgreement(value, "player");
  acceptThroughFareAgreement(value, "operator:external");
  fileThroughFareAgreement(value);
  activateThroughFareAgreement(value, linkedService);
  return value;
}

function accessAgreement(overrides = {}) {
  return {
    schema: "transitline.track-access-agreement/1",
    contractVersion: 1,
    id: "access:external",
    infrastructureOwnerId: "operator:external",
    guestOperatorId: "player",
    accessFeeJPYPerTrainKm: 1_000,
    stationFeeJPYPerStop: 10_000,
    status: "active",
    totals: { settledDays: 0, accessRevenueJPY: 0 },
    ...overrides,
  };
}

function actuals(overrides = {}) {
  return {
    operatingDay: 1,
    passengers: 1_000,
    trainKm: 500,
    trackAccessUsage: [{ agreementId: "access:external", trainKm: 200, stationStops: 10 }],
    ...overrides,
  };
}

test("through operation combines fare shares, actual train-km and track-access usage", () => {
  const result = calculateThroughOperatingSettlement({
    throughService: service(),
    fareAgreement: fareAgreement(),
    trackAccessAgreements: [accessAgreement()],
    actuals: actuals(),
  });
  const model = VEHICLE_MODELS.medium_4car;
  assert.equal(result.passengerRevenueJPY, 330_000);
  assert.equal(result.playerFareRevenueJPY, 182_000);
  assert.equal(result.externalFareAllocationJPY, 148_000);
  assert.equal(result.trackAccessUsage[0].accessCostJPY, 300_000);
  assert.equal(result.carKm, 500 * model.cars);
  assert.equal(result.money.energyJPY, Math.round(result.carKm * model.energyKwhPerCarKm * 25));
  assert.equal(result.money.operatingProfitJPY, result.money.playerFareRevenueJPY - result.money.operatingCostJPY);
});

test("calculation is deterministic and leaves services, agreements and actuals unchanged", () => {
  const inputs = { throughService: service(), fareAgreement: fareAgreement(), trackAccessAgreements: [accessAgreement()], actuals: actuals() };
  const before = structuredClone(inputs);
  const first = calculateThroughOperatingSettlement(inputs);
  const second = calculateThroughOperatingSettlement(structuredClone(inputs));
  assert.deepEqual(first, second);
  assert.deepEqual(inputs, before);
});

test("track-access usage must exactly match active linked agreements and the guest operator", () => {
  const base = { throughService: service(), fareAgreement: fareAgreement(), trackAccessAgreements: [accessAgreement()] };
  assert.throws(() => calculateThroughOperatingSettlement({ ...base, actuals: actuals({ trackAccessUsage: [] }) }), /cover every linked/);
  assert.throws(() => calculateThroughOperatingSettlement({ ...base, actuals: actuals({ trackAccessUsage: [
    { agreementId: "access:external", trainKm: 200, stationStops: 10 },
    { agreementId: "access:external", trainKm: 1, stationStops: 0 },
  ] }) }), /repeats/);
  assert.throws(() => calculateThroughOperatingSettlement({ ...base, trackAccessAgreements: [accessAgreement({ status: "suspended" })], actuals: actuals() }), /not active/);
  assert.throws(() => calculateThroughOperatingSettlement({ ...base, trackAccessAgreements: [accessAgreement({ guestOperatorId: "competitor" })], actuals: actuals() }), /another guest/);
  assert.throws(() => calculateThroughOperatingSettlement({ ...base, actuals: actuals({ trackAccessUsage: [{ agreementId: "access:external", trainKm: 501, stationStops: 10 }] }) }), /cannot exceed/);
});

test("service, fare and actual-input gates fail closed", () => {
  const base = { throughService: service(), fareAgreement: fareAgreement(), trackAccessAgreements: [accessAgreement()], actuals: actuals() };
  assert.throws(() => calculateThroughOperatingSettlement({ ...base, throughService: service({ status: "suspended" }) }), /approved service/);
  const mismatchedFare = fareAgreement();
  mismatchedFare.throughServiceId = "through-service:other";
  assert.throws(() => calculateThroughOperatingSettlement({ ...base, fareAgreement: mismatchedFare }), /Matching/);
  assert.throws(() => calculateThroughOperatingSettlement({ ...base, actuals: actuals({ passengers: -1 }) }), /Passengers/);
  assert.throws(() => calculateThroughOperatingSettlement({ ...base, actuals: actuals({ trainKm: -1 }) }), /Train-km/);
});

function operationGame(openingCash = 10_000_000) {
  const game = new ManagementGame({ seed: 277, openingCash });
  game.throughServices.push(service());
  game.throughFareAgreements.push(fareAgreement());
  game.trackAccessAgreements.push(accessAgreement());
  return game;
}

test("ManagementGame posts one net operating day, updates totals and survives save/load", () => {
  const game = operationGame();
  const cashBefore = game.ledger.cash;
  const rngBefore = game.snapshot().rngState;
  const result = game.settleThroughServiceOperatingDay("through-service:operation", actuals());
  assert.equal(game.ledger.cash - cashBefore, result.money.operatingProfitJPY);
  assert.deepEqual(game.snapshot().rngState, rngBefore);
  assert.equal(game.requireThroughService("through-service:operation").throughOperatingTotals.days, 1);
  assert.equal(game.trackAccessAgreements[0].totals.guestAccessCostJPY, 300_000);
  const statement = game.corporateFinancialStatements({ fromMonth: 0, throughMonth: 0 }).monthly[0];
  assert.equal(statement.revenueJPY, result.money.playerFareRevenueJPY);
  assert.equal(statement.operatingCostJPY, result.money.operatingCostJPY);
  assert.equal(statement.cashFlow.operatingJPY, result.money.operatingProfitJPY);
  const restored = ManagementGame.load(game.save());
  assert.deepEqual(restored.throughOperatingSettlementReport(), game.throughOperatingSettlementReport());
  assert.deepEqual(restored.requireThroughService("through-service:operation").throughOperatingTotals, game.requireThroughService("through-service:operation").throughOperatingTotals);
});

test("duplicate or out-of-order operating days roll the whole transaction back", () => {
  const game = operationGame();
  game.settleThroughServiceOperatingDay("through-service:operation", actuals({ operatingDay: 5 }));
  const before = game.snapshot();
  assert.throws(() => game.settleThroughServiceOperatingDay("through-service:operation", actuals({ operatingDay: 5 })), /later than 5/);
  assert.deepEqual(game.snapshot(), before);
  assert.throws(() => game.settleThroughServiceOperatingDay("through-service:operation", actuals({ operatingDay: 4 })), /later than 5/);
  assert.deepEqual(game.snapshot(), before);
});

test("insufficient cash during operating costs rolls back income, costs, totals and access usage", () => {
  const game = operationGame(0);
  const before = game.snapshot();
  assert.throws(() => game.settleThroughServiceOperatingDay("through-service:operation", actuals({ passengers: 0 })), /Insufficient cash/);
  assert.deepEqual(game.snapshot(), before);
});

test("a suspended fare agreement blocks operation without changing state", () => {
  const game = operationGame();
  game.throughFareAgreements[0].status = "suspended";
  const before = game.snapshot();
  assert.throws(() => game.settleThroughServiceOperatingDay("through-service:operation", actuals()), /no active fare/);
  assert.deepEqual(game.snapshot(), before);
});

test("old saves restore an empty through-operating settlement collection", () => {
  const game = operationGame();
  const snapshot = game.snapshot();
  delete snapshot.throughOperatingSettlements;
  const restored = new ManagementGame().restore(snapshot);
  assert.deepEqual(restored.throughOperatingSettlements, []);
});
