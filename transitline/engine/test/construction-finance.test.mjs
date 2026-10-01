import test from "node:test";
import assert from "node:assert/strict";
import {
  advanceConstructionPriceMonth,
  applyConstructionPriceShock,
  attachConstructionSitePackages,
  createConstructionPriceState,
  createIntegratedConstructionSchedule,
  ManagementGame,
  prepareConstructionPackageProcurement,
} from "../src/management/index.mjs";

function fixture() {
  const planGeometry = {
    planId: "plan:finance",
    stationCandidates: [{ id: "a", name: "A" }, { id: "b", name: "B" }],
    segments: [{ id: "ab", from: "a", to: "b", lengthMeters: 1_500, structureHint: "elevated" }],
  };
  const project = {
    id: "project:finance",
    planId: planGeometry.planId,
    status: "contracted",
    planGeometry,
    elapsedMonths: 0,
    progress: 0,
    delayMonths: 0,
    paid: 0,
    riskEvents: [],
    estimate: { guideway: 60_000_000_000, systems: 20_000_000_000, totalP50: 100_000_000_000, totalP90: 125_000_000_000, durationMonths: 36, parallelCivilFronts: 1 },
    tasks: [
      { id: "design", weight: 0.12, progress: 0 },
      { id: "civil", weight: 0.58, progress: 0 },
      { id: "systems", weight: 0.2, progress: 0 },
      { id: "testing", weight: 0.1, progress: 0 },
    ],
    stationDeliveryPackages: [],
    assets: [],
  };
  const stationPackages = planGeometry.stationCandidates.map((station) => ({
    id: `station-package:${station.id}`,
    connectedStationId: station.id,
    status: "awarded",
    progress: 0,
    statusHistory: [{ status: "awarded", atMinute: 0 }],
    awardedBid: { durationMonths: 8, priceP50: 1_000_000_000, priceP90: 1_250_000_000 },
  }));
  project.stationDeliveryPackages = structuredClone(stationPackages);
  const depots = [{ id: "depot-finance", name: "Finance Depot", status: "secured", progress: 1, assessment: { schedule: { durationMonths: 12 } } }];
  const vehicleOrders = [{ id: "vehicles-finance", stage: "accepted", elapsedMonths: 18, productionMonths: 18 }];
  const schedule = createIntegratedConstructionSchedule({ project, stationPackages, depots, vehicleOrders, approvalMonths: 6 });
  const site = (constructionSiteId, kind, connectedSegmentIds) => ({
    schema: "transitline.construction-site-geometry/1",
    contractVersion: 1,
    constructionSiteId,
    kind,
    connectedPlanId: planGeometry.planId,
    connectedSegmentIds,
    connectedStationId: null,
    connectedDepotSiteId: null,
    unknown: [],
    unknownReasons: {},
  });
  attachConstructionSitePackages(schedule, [
    site("site:civil", "viaduct", ["ab"]),
    site("site:systems", "systems", ["ab"]),
  ]);
  return { project, stationPackages, depots, vehicleOrders, schedule };
}

function financedGame({ cash = 250_000_000_000 } = {}) {
  const f = fixture();
  const game = new ManagementGame({ countryId: "JP", seed: 93, openingCash: cash });
  game.projects = [f.project];
  game.stationPackages = f.stationPackages;
  game.depots = f.depots;
  game.vehicleOrders = f.vehicleOrders;
  game.schedules = [f.schedule];
  game.ledger.commit({ id: `construction:${f.project.id}`, atMinute: 0, amount: f.project.estimate.totalP50, category: "construction", reference: f.project.id });
  prepareConstructionPackageProcurement(f.schedule, f.project);
  for (const deliveryPackage of f.schedule.constructionPackages.filter((entry) => entry.procurement)) {
    const tender = game.tenderConstructionPackage(f.schedule.id, deliveryPackage.constructionSiteId, { contractModel: deliveryPackage.kind === "systems" ? "fixed-price" : "index-linked" });
    game.awardConstructionPackage(f.schedule.id, deliveryPackage.constructionSiteId, tender.ranking[0].id);
  }
  game.integrateConstructionPackageAwards(f.schedule.id);
  return { game, ...f };
}

test("normal construction inflation compounds monthly while a shock remains a separate history item", () => {
  const state = createConstructionPriceState("JP");
  for (let month = 1; month <= 12; month++) advanceConstructionPriceMonth(state, month * 30 * 1440, "normal");
  assert.ok(Math.abs(state.currentIndex - 102) < 0.00001);
  const shock = applyConstructionPriceShock(state, { points: 3, sourceEventId: "event:price", atMinute: 12 * 30 * 1440 });
  assert.equal(shock.type, "shock");
  assert.ok(Math.abs(state.currentIndex - 105) < 0.00001);
  assert.equal(state.history.filter((entry) => entry.type === "normal").length, 12);
  assert.equal(state.history.at(-1).sourceEventId, "event:price");
});

test("a package awarded after market movement starts from the current index instead of charging pre-award inflation", () => {
  const f = fixture();
  const game = new ManagementGame({ countryId: "JP", seed: 2, openingCash: 250_000_000_000 });
  game.projects = [f.project];
  game.stationPackages = f.stationPackages;
  game.depots = f.depots;
  game.vehicleOrders = f.vehicleOrders;
  game.schedules = [f.schedule];
  game.ledger.commit({ id: `construction:${f.project.id}`, atMinute: 0, amount: f.project.estimate.totalP50, category: "construction", reference: f.project.id });
  game.constructionPriceState.currentIndex = 104.25;
  prepareConstructionPackageProcurement(f.schedule, f.project);
  const deliveryPackage = f.schedule.constructionPackages.find((entry) => entry.procurement);
  const tender = game.tenderConstructionPackage(f.schedule.id, deliveryPackage.constructionSiteId);
  const contract = game.awardConstructionPackage(f.schedule.id, deliveryPackage.constructionSiteId, tender.ranking[0].id);
  assert.equal(contract.priceIndexBase, 104.25);
  assert.equal(contract.lastSettledPriceIndex, 104.25);
});

test("monthly settlement raises the remaining commitment when cash is available", () => {
  const { game, project, schedule } = financedGame();
  const before = project.estimate.totalP50;
  const month = game.advanceMonth();
  assert.equal(month.priceSettlements[0].status, "settled");
  assert.ok(project.estimate.totalP50 > before);
  assert.equal(schedule.lastSettledConstructionPriceIndex, game.constructionPriceState.currentIndex);
  assert.equal(game.constructionFundingReport().length, 0);
  assert.equal(month.cycleReport.constructionPrice.settlements[0].status, "settled");
});

test("a funding gap blocks progress, and a construction loan funds settlement without hiding its future cost", () => {
  const { game, project, schedule } = financedGame();
  game.ledger.commit({ id: "reserved-program", atMinute: 0, amount: game.ledger.availableCash - 1, category: "other-program", reference: "other" });
  const beforeProgress = project.progress;
  const month = game.advanceMonth();
  const fundingCase = game.constructionFundingReport()[0];
  assert.equal(month.priceSettlements[0].status, "funding-required");
  assert.equal(month.construction[0].reason, "construction-funding-gap");
  assert.equal(project.progress, beforeProgress);
  const option = game.constructionFundingOptions(fundingCase.id).find((entry) => entry.id === "construction-loan");
  assert.ok(option.debtJPY > option.fundingJPY);
  assert.ok(option.futureMonthlyCostJPY > 0);
  const resolved = game.resolveConstructionFundingCase(fundingCase.id, option.id);
  assert.equal(resolved.fundingCase.status, "resolved");
  assert.equal(game.constructionFinanceReport(project.id)[0].kind, "construction-loan");
  assert.equal(schedule.lastSettledConstructionPriceIndex, game.constructionPriceState.currentIndex);
  assert.equal(game.ledger.commitments.get(`construction:${project.id}`).remaining, project.estimate.totalP50 - project.paid);
});

test("suspension preserves the open case; later equity funding resolves it and resumes construction", () => {
  const { game, project } = financedGame();
  game.ledger.commit({ id: "reserved-program", atMinute: 0, amount: game.ledger.availableCash - 1, category: "other-program", reference: "other" });
  game.advanceMonth();
  const fundingCase = game.constructionFundingReport()[0];
  game.resolveConstructionFundingCase(fundingCase.id, "suspend");
  assert.equal(project.status, "suspended");
  assert.throws(() => game.resumeProject(project.id), /funding gap/);
  const resolved = game.resolveConstructionFundingCase(fundingCase.id, "sponsor-equity");
  assert.equal(resolved.fundingCase.status, "resolved");
  assert.equal(game.requireProject(project.id).status, "contracted");
  const restored = ManagementGame.load(game.save());
  assert.deepEqual(restored.constructionFundingReport(), game.constructionFundingReport());
  assert.deepEqual(restored.constructionFinanceReport(), game.constructionFinanceReport());
  assert.deepEqual(restored.constructionPriceState, game.constructionPriceState);
});

test("an older save adopts its latest settled contract index without replaying inflation from month zero", () => {
  const { game, schedule } = financedGame();
  game.clock.minute = 20 * 30 * 1440;
  for (const deliveryPackage of schedule.constructionPackages.filter((entry) => entry.procurement?.contract)) {
    deliveryPackage.procurement.contract.lastSettledPriceIndex = 108;
  }
  const snapshot = game.snapshot();
  delete snapshot.constructionPriceState;
  delete snapshot.constructionFundingCases;
  delete snapshot.constructionFinancing;
  const restored = new ManagementGame({ countryId: "JP" }).restore(snapshot);
  assert.equal(restored.constructionPriceState.currentIndex, 108);
  assert.equal(restored.constructionPriceState.lastAdvancedMonth, 20);
  assert.equal(restored.constructionFundingReport().length, 0);
});
