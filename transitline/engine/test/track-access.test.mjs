import test from "node:test";
import assert from "node:assert/strict";
import {
  ManagementGame,
  awardTrackAccessOffer,
  createCompetitors,
  createTrackAccessOpportunity,
  generateTrackAccessOffers,
  setTrackAccessAgreementStatus,
  settleTrackAccessRevenue,
  trackAccessImpact,
} from "../src/management/index.mjs";

function hostFixture() {
  const hostProject = { id: "project:host", status: "available", technicalProfileId: "medium_steel" };
  const hostService = { id: "service:host", name: "Host Line", status: "open", projectId: hostProject.id, modelId: "medium_4car", routeKm: 12, stations: 8, trainsPerHour: 8 };
  return { hostProject, hostService };
}

function opportunity(overrides = {}) {
  const { hostProject, hostService } = hostFixture();
  return createTrackAccessOpportunity({ id: "access:1", hostCapacityTrainsPerHour: 16, minimumGuestTrainsPerHour: 2, maximumGuestTrainsPerHour: 4, ...overrides }, { hostProject, hostService, atMinute: 100 });
}

function deterministicAgreement(overrides = {}) {
  const tender = opportunity(overrides);
  const competitors = createCompetitors();
  const ranking = generateTrackAccessOffers(tender, competitors, { next: () => 0.1 });
  assert.ok(ranking.length > 1);
  const agreement = awardTrackAccessOffer(tender, ranking[0].id, { agreements: [], competitors, startDay: 3 });
  return { tender, competitors, ranking, agreement };
}

function gameFixture() {
  const game = new ManagementGame({ seed: 23, openingCash: 100_000_000_000 });
  game.projects.push({ id: "project:host", status: "available", technicalProfileId: "medium_steel", stationDeliveryPackages: [], stationPackageCoverageComplete: true, assets: [{ id: "systems", kind: "power-signal", status: "available" }] });
  game.depots.push({ id: "depot:host", name: "Host depot", status: "secured", capacitySets: 8, inspectionSetsPerDay: 2, entryRouteAvailable: true, annualLeaseCost: 0, deadheadKm: 1 });
  game.vehicleOrders.push({ id: "fleet:host", modelId: "medium_4car", stage: "accepted", units: Array.from({ length: 8 }, (_, index) => ({ id: `set:${index + 1}`, modelId: "medium_4car", status: "available", mileageKm: 0, nextInspectionKm: 30_000 })) });
  game.createService({ id: "service:host", name: "Host Line", projectId: "project:host", vehicleOrderId: "fleet:host", depotId: "depot:host", modelId: "medium_4car", routeKm: 5, stations: 3, commercialSpeedKph: 35, trainsPerHour: 4, staffReady: true, timetableReady: true, trialOperationPassed: true, approvalsValid: true, platformLengthM: 100 });
  return game;
}

test("opportunity validates host capacity and the guest running system", () => {
  const { hostProject, hostService } = hostFixture();
  assert.throws(() => createTrackAccessOpportunity({ id: "bad", guestModelId: "agt_3car" }, { hostProject, hostService }), /does not match/);
  assert.throws(() => createTrackAccessOpportunity({ id: "bad", hostCapacityTrainsPerHour: 8 }, { hostProject, hostService }), /no access capacity/);
  const created = opportunity();
  assert.equal(created.compatibility.compatible, true);
  assert.equal(created.maximumGuestTrainsPerHour, 4);
});

test("competitor AI produces deterministic commercial and technical offers", () => {
  const a = opportunity();
  const b = opportunity();
  const competitors = createCompetitors();
  const first = generateTrackAccessOffers(a, structuredClone(competitors), { next: () => 0.1 });
  const second = generateTrackAccessOffers(b, structuredClone(competitors), { next: () => 0.1 });
  assert.deepEqual(first, second);
  assert.equal(a.status, "offers-received");
  assert.ok(first.every((offer) => offer.accessFeeJPYPerTrainKm > 0 && offer.projectedAnnualHostRevenueJPY > 0));
  assert.ok(first[0].totalScore >= first.at(-1).totalScore);
});

test("award reserves capacity and creates an auditable access agreement", () => {
  const { tender, competitors, ranking, agreement } = deterministicAgreement();
  assert.equal(tender.status, "awarded");
  assert.equal(agreement.guestOperatorId, ranking[0].bidderId);
  assert.equal(agreement.status, "active");
  assert.equal(agreement.startDay, 3);
  assert.equal(competitors.find((entry) => entry.id === agreement.guestOperatorId).accessCommitments, 1);
  const duplicate = opportunity({ id: "access:2", hostCapacityTrainsPerHour: 10, minimumGuestTrainsPerHour: 2, maximumGuestTrainsPerHour: 2 });
  generateTrackAccessOffers(duplicate, competitors, { next: () => 0.1 });
  assert.throws(() => awardTrackAccessOffer(duplicate, duplicate.ranking[0].id, { agreements: [agreement], competitors, startDay: 3 }), /exceed host line capacity/);
  const changedFrequency = opportunity({ id: "access:3", hostCapacityTrainsPerHour: 10, minimumGuestTrainsPerHour: 2, maximumGuestTrainsPerHour: 2 });
  generateTrackAccessOffers(changedFrequency, competitors, { next: () => 0.1 });
  assert.throws(() => awardTrackAccessOffer(changedFrequency, changedFrequency.ranking[0].id, { agreements: [], competitors, startDay: 3, hostTrainsPerHour: 9 }), /exceed host line capacity/);
});

test("active access consumes line capacity and adds a bounded punctuality penalty", () => {
  const { agreement } = deterministicAgreement();
  const impact = trackAccessImpact([agreement], agreement.hostServiceId, 12);
  assert.equal(impact.guestTrainsPerHour, agreement.trainsPerHour);
  assert.ok(impact.utilisation > 0.8);
  assert.ok(impact.punctualityPenalty > 0 && impact.punctualityPenalty <= 0.06);
  assert.equal(impact.capacityExceeded, false);
  const exceeded = trackAccessImpact([agreement], agreement.hostServiceId, 20);
  assert.equal(exceeded.capacityExceeded, true);
});

test("daily access fees settle once and suspension days are not back-billed", () => {
  const { agreement, competitors } = deterministicAgreement();
  const agreements = [agreement];
  const first = settleTrackAccessRevenue(agreements, agreement.hostServiceId, 3);
  assert.equal(first.settlements[0].days, 1);
  assert.ok(first.accessRevenueJPY > 0);
  assert.equal(settleTrackAccessRevenue(agreements, agreement.hostServiceId, 3).accessRevenueJPY, 0);
  setTrackAccessAgreementStatus(agreement, "suspended", competitors, 4);
  assert.throws(() => setTrackAccessAgreementStatus(agreement, "suspended", competitors, 5), /Only an active agreement/);
  assert.equal(settleTrackAccessRevenue(agreements, agreement.hostServiceId, 6).accessRevenueJPY, 0);
  setTrackAccessAgreementStatus(agreement, "active", competitors, 7);
  const resumed = settleTrackAccessRevenue(agreements, agreement.hostServiceId, 7);
  assert.equal(resumed.settlements[0].days, 1);
  setTrackAccessAgreementStatus(agreement, "terminated", competitors, 8);
  assert.equal(competitors.find((entry) => entry.id === agreement.guestOperatorId).accessCommitments, 0);
});

test("an explicit operating window never back-bills idle calendar days", () => {
  const { agreement } = deterministicAgreement();
  const result = settleTrackAccessRevenue([agreement], agreement.hostServiceId, 32, [], 1);
  assert.equal(result.settlements.length, 1);
  assert.equal(result.settlements[0].fromDay, 32);
  assert.equal(result.settlements[0].throughDay, 32);
  assert.equal(result.settlements[0].days, 1);
  assert.equal(agreement.lastSettledDay, 32);
  assert.equal(agreement.totals.settledDays, 1);
});

test("contract expiry releases the competitor commitment", () => {
  const { agreement, competitors } = deterministicAgreement({ contractYears: 1 });
  agreement.endDay = agreement.startDay;
  const result = settleTrackAccessRevenue([agreement], agreement.hostServiceId, agreement.endDay, competitors);
  assert.equal(result.settlements[0].days, 1);
  assert.equal(agreement.status, "expired");
  assert.equal(competitors.find((entry) => entry.id === agreement.guestOperatorId).accessCommitments, 0);
});

test("game API carries awarded access into operation, monthly P&L, and save/load", () => {
  const game = gameFixture();
  const announced = game.announceTrackAccessOpportunity("service:host", { minimumTechnicalScore: 0, hostCapacityTrainsPerHour: 12, minimumGuestTrainsPerHour: 1, maximumGuestTrainsPerHour: 2 });
  const offers = game.solicitTrackAccessOffers(announced.id);
  assert.ok(offers.length > 0);
  const agreement = game.awardTrackAccessOffer(announced.id, offers[0].id);
  const settlement = game.operateDay("service:host");
  assert.equal(settlement.trackAccess.impact.agreementIds[0], agreement.id);
  assert.ok(settlement.money.trackAccessRevenueJPY > 0);
  assert.equal(settlement.trackAccess.settlement.settlements[0].days, 1, "the first 24 hours settle exactly one access day");
  const monthly = game.operatingMonthReport("service:host")[0];
  assert.equal(monthly.money.trackAccessRevenueJPY, settlement.money.trackAccessRevenueJPY);
  assert.ok(game.corporateFinancialStatements().monthly[0].revenueJPY >= monthly.operatingIncomeJPY);
  const restored = ManagementGame.load(game.save());
  assert.deepEqual(restored.trackAccessReport("service:host"), game.trackAccessReport("service:host"));
  assert.equal(restored.nextTrackAccessSequence, game.nextTrackAccessSequence);
});

test("failed access transactions roll back opportunity, competitor, and agreement state", () => {
  const game = gameFixture();
  const announced = game.announceTrackAccessOpportunity("service:host", { minimumTechnicalScore: 0, hostCapacityTrainsPerHour: 12 });
  const offers = game.solicitTrackAccessOffers(announced.id);
  const before = game.snapshot();
  assert.throws(() => game.awardTrackAccessOffer(announced.id, "missing-offer"), /Unknown track access offer/);
  assert.deepEqual(game.snapshot(), before);
  assert.equal(game.trackAccessAgreements.length, 0);
  assert.ok(offers.length > 0);
});

test("game-level access settlement cannot mutate contract totals outside a transaction", () => {
  const game = gameFixture();
  assert.throws(() => game.settleTrackAccessForService("service:host", 0), /requires an active game transaction/);
  delete game._transactionDepth;
  assert.throws(() => game.settleTrackAccessForService("service:host", 0), /requires an active game transaction/, "a missing guard state must fail closed");
  assert.equal(game.trackAccessAgreements.length, 0);
});
