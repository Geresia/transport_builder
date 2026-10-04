import test from "node:test";
import assert from "node:assert/strict";
import {
  Ledger,
  ManagementGame,
  SimulationClock,
  createConstructionContractors,
  createThroughHandoverPossessionPlan,
  createThroughHandoverProject,
  getCountryProfile,
  settleThroughHandoverPossessionMonth,
  tenderThroughHandoverProject,
  throughHandoverPossessionImpact,
} from "../src/management/index.mjs";

function site() {
  return {
    schema: "transitline.through-handover-site-geometry/1", contractVersion: 1,
    throughRouteId: "route:possession", routeGeometryRevision: "revision:1", handoverId: "handover:1", handoverSiteId: "site:1",
    connectionLengthMeters: 300, minimumCurveRadiusMeters: 220, maximumGradientPermille: 20,
    intersectedBuildingCount: 0, waterCrossingCount: 0, roadCrossingCount: 1, existingRailwayCrossingCount: 1,
    selectedWorkAreaCandidateId: "work:1", externalTopologyVerified: true, unknown: [], unknownReasons: {}, dataQuality: "medium",
  };
}

function project(id = "handover-project:possession") {
  return createThroughHandoverProject({ id, site: site(), technicalProfileId: "medium_steel", countryProfile: getCountryProfile("JP") });
}

test("night, weekend and closure strategies expose a real time-service-cost trade-off", () => {
  const p = project();
  const baseline = { "service:a": 10_000_000 };
  const night = createThroughHandoverPossessionPlan({ id: "possession:night", project: p, strategyId: "night-only", affectedServiceIds: ["service:a"], baselineDailyRevenueJPYByService: baseline });
  const weekend = createThroughHandoverPossessionPlan({ id: "possession:weekend", project: p, strategyId: "weekend-blockade", affectedServiceIds: ["service:a"], baselineDailyRevenueJPYByService: baseline });
  const closure = createThroughHandoverPossessionPlan({ id: "possession:closure", project: p, strategyId: "intensive-closure", affectedServiceIds: ["service:a"], baselineDailyRevenueJPYByService: baseline });
  assert.ok(night.forecast.expectedConstructionMonths > weekend.forecast.expectedConstructionMonths);
  assert.ok(weekend.forecast.expectedConstructionMonths > closure.forecast.expectedConstructionMonths);
  assert.ok(night.strategy.capacityFactor > weekend.strategy.capacityFactor);
  assert.ok(weekend.strategy.capacityFactor > closure.strategy.capacityFactor);
  assert.ok(night.forecast.expectedLostRevenueJPYPerMonth < closure.forecast.expectedLostRevenueJPYPerMonth);
  assert.ok(night.forecast.directCashCostJPYPerMonth < closure.forecast.directCashCostJPYPerMonth);
});

test("a possession plan requires named services and known non-negative revenue baselines", () => {
  const p = project();
  assert.throws(() => createThroughHandoverPossessionPlan({ id: "x", project: p, affectedServiceIds: [], baselineDailyRevenueJPYByService: {} }), /At least one/);
  assert.throws(() => createThroughHandoverPossessionPlan({ id: "x", project: p, affectedServiceIds: ["service:a"], baselineDailyRevenueJPYByService: {} }), /known non-negative/);
  assert.throws(() => createThroughHandoverPossessionPlan({ id: "x", project: p, strategyId: "instant", affectedServiceIds: ["service:a"], baselineDailyRevenueJPYByService: { "service:a": 1 } }), /Unknown/);
});

test("possession strategy changes contractor bid price and construction duration", () => {
  const nightProject = project("handover-project:night");
  nightProject.possessionPlan = createThroughHandoverPossessionPlan({ id: "possession:night", project: nightProject, strategyId: "night-only", affectedServiceIds: ["service:a"], baselineDailyRevenueJPYByService: { "service:a": 1_000_000 } });
  const closureProject = project("handover-project:closure");
  closureProject.possessionPlan = createThroughHandoverPossessionPlan({ id: "possession:closure", project: closureProject, strategyId: "intensive-closure", affectedServiceIds: ["service:a"], baselineDailyRevenueJPYByService: { "service:a": 1_000_000 } });
  const nightTender = tenderThroughHandoverProject(nightProject, createConstructionContractors("JP"), { next: () => 0.5 });
  const closureTender = tenderThroughHandoverProject(closureProject, createConstructionContractors("JP"), { next: () => 0.5 });
  const nightBid = nightTender.ranking.find((entry) => entry.contractorId === closureTender.ranking[0].contractorId) ?? nightTender.ranking[0];
  const closureBid = closureTender.ranking.find((entry) => entry.contractorId === nightBid.contractorId);
  assert.ok(closureBid.priceP50 > nightBid.priceP50);
  assert.ok(closureBid.durationMonths < nightBid.durationMonths);
});

test("monthly possession settlement posts only direct cash costs and records lost revenue as exposure", () => {
  const p = project();
  p.status = "under-construction";
  const plan = createThroughHandoverPossessionPlan({ id: "possession:settle", project: { ...p, status: "proposed" }, strategyId: "weekend-blockade", affectedServiceIds: ["service:a"], baselineDailyRevenueJPYByService: { "service:a": 10_000_000 } });
  const ledger = new Ledger(5_000_000_000);
  const clock = new SimulationClock(30 * 1440);
  const before = ledger.cash;
  const settlement = settleThroughHandoverPossessionMonth(plan, p, { ledger, clock });
  assert.equal(settlement.lostRevenueExposureJPY, 50_000_000);
  assert.equal(settlement.directCashCostJPY, 185_000_000);
  assert.equal(ledger.cash, before - 185_000_000);
  assert.equal(settleThroughHandoverPossessionMonth(plan, p, { ledger, clock }), null, "same month is idempotent");
  assert.equal(ledger.cash, before - 185_000_000);
  clock.advance(30 * 1440);
  settleThroughHandoverPossessionMonth(plan, p, { ledger, clock });
  assert.equal(plan.totals.months, 2);
  assert.equal(plan.totals.lostRevenueExposureJPY, 100_000_000);
});

test("simultaneous active works compound capacity and punctuality impact", () => {
  const first = project("handover-project:first");
  first.possessionPlan = createThroughHandoverPossessionPlan({ id: "possession:first", project: first, strategyId: "night-only", affectedServiceIds: ["service:a"], baselineDailyRevenueJPYByService: { "service:a": 1 } });
  first.status = "under-construction";
  const second = project("handover-project:second");
  second.possessionPlan = createThroughHandoverPossessionPlan({ id: "possession:second", project: second, strategyId: "weekend-blockade", affectedServiceIds: ["service:a"], baselineDailyRevenueJPYByService: { "service:a": 1 } });
  second.status = "contracted";
  const impact = throughHandoverPossessionImpact([first, second], "service:a");
  assert.equal(impact.capacityFactor, 0.92 * 0.78);
  assert.equal(impact.punctualityPenalty, 0.035);
  assert.deepEqual(impact.activePlanIds, ["possession:first", "possession:second"]);
  assert.deepEqual(throughHandoverPossessionImpact([first, second], "service:b"), { capacityFactor: 1, punctualityPenalty: 0, activePlanIds: [] });
});

test("ManagementGame derives a baseline from audited operating reports and saves the plan", () => {
  const game = new ManagementGame({ openingCash: 100_000_000_000 });
  game.services.push({ id: "service:a", daysOperated: 10, totals: { revenue: 120_000_000 } });
  game.operatingMonthReports.push({ serviceId: "service:a", month: 0, days: 5, operatingIncomeJPY: 75_000_000 });
  const handover = game.proposeThroughHandoverProject(site(), { technicalProfileId: "medium_steel" });
  const plan = game.planThroughHandoverPossession(handover.id, { strategyId: "night-only", affectedServiceIds: ["service:a"] });
  assert.deepEqual(plan.affectedServices, [{ serviceId: "service:a", baselineDailyRevenueJPY: 15_000_000 }]);
  const restored = ManagementGame.load(game.save());
  assert.deepEqual(restored.requireThroughHandoverProject(handover.id).possessionPlan, plan);
});

test("the game charges one possession settlement per construction month and closes the plan at availability", () => {
  const game = new ManagementGame({ seed: 905, openingCash: 100_000_000_000 });
  game.services.push({ id: "service:a", daysOperated: 10, totals: { revenue: 100_000_000 } });
  const handover = game.proposeThroughHandoverProject(site(), { technicalProfileId: "medium_steel" });
  game.planThroughHandoverPossession(handover.id, { strategyId: "weekend-blockade", affectedServiceIds: ["service:a"] });
  const tender = game.tenderThroughHandoverProject(handover.id);
  const contract = game.awardThroughHandoverProject(handover.id, tender.ranking[0].id);
  const projectState = game.requireThroughHandoverProject(handover.id);
  projectState.riskProbability = 0;
  for (let month = 0; month < contract.constructionMonths + projectState.phasesMonths.integrationTestingMonths; month++) game.advanceMonth();
  assert.equal(projectState.status, "available");
  assert.equal(projectState.possessionPlan.status, "completed");
  assert.equal(projectState.possessionPlan.settlements.length, contract.constructionMonths);
  assert.equal(projectState.possessionPlan.totals.directCashCostJPY, contract.constructionMonths * 185_000_000);
});

test("missing game baselines and duplicate plans roll back atomically", () => {
  const game = new ManagementGame({ seed: 904, openingCash: 10_000_000_000 });
  game.services.push({ id: "service:a", daysOperated: 0, totals: { revenue: 0 } });
  const handover = game.proposeThroughHandoverProject(site(), { technicalProfileId: "medium_steel" });
  const before = game.snapshot();
  assert.throws(() => game.planThroughHandoverPossession(handover.id, { affectedServiceIds: ["service:a"] }), /No operating revenue baseline/);
  assert.deepEqual(game.snapshot(), before);
  game.planThroughHandoverPossession(handover.id, { strategyId: "intensive-closure", affectedServiceIds: ["service:a"], baselineDailyRevenueJPYByService: { "service:a": 1_000_000 } });
  const planned = game.snapshot();
  assert.throws(() => game.planThroughHandoverPossession(handover.id, { affectedServiceIds: ["service:a"], baselineDailyRevenueJPYByService: { "service:a": 1 } }), /already has/);
  assert.deepEqual(game.snapshot(), planned);
});
