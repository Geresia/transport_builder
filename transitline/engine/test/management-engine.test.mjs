import test from "node:test";
import assert from "node:assert/strict";
import {
  Ledger,
  ManagementGame,
  addAccessLink,
  cityPackToDomain,
  economicAssessment,
  getCountryProfile,
  validatePlanGeometry,
  TECHNICAL_PROFILES,
  ageVehicleFleet,
  closeProjectFinance,
  constructionRiskDistribution,
  createAdvancedContract,
  createConsortium,
  createD2Depot,
  createMarketEntrant,
  createProjectFinance,
  createSpv,
  detailedEngineeringAssessment,
  evaluateLease,
  fundSpv,
  mergeCompanies,
  requestRenegotiation,
  resolveDefault,
  serviceDebtYear,
} from "../src/management/index.mjs";

function plan(id = "line-a") {
  return {
    contractVersion: 1,
    schema: "transitline.plan-geometry/1",
    planId: id,
    coordinateReference: "EPSG:4326",
    sourcePackId: "synthetic",
    sourcePackVersion: "1",
    stationCandidates: [
      { id: "a", location: [139, 35], platformType: "side", platformLengthM: 100, structure: "surface" },
      { id: "b", location: [139.02, 35], platformType: "island", platformLengthM: 100, structure: "elevated" },
      { id: "c", location: [139.04, 35], platformType: "side", platformLengthM: 100, structure: "elevated" },
    ],
    segments: [
      { from: "a", to: "b", lengthMeters: 2300, elevationStartMeters: 0, elevationEndMeters: 9, structureHint: "surface", constraintFlags: [], dataQuality: "high" },
      { from: "b", to: "c", lengthMeters: 2400, elevationStartMeters: 9, elevationEndMeters: 11, structureHint: "elevated", constraintFlags: ["road-median"], dataQuality: "medium" },
    ],
    accessLinks: [],
  };
}

test("ledger reconstructs cash and enforces commitments", () => {
  const ledger = new Ledger(1_000);
  ledger.post({ atMinute: 0, amount: 200, category: "income", reference: "x" });
  ledger.commit({ id: "c", atMinute: 0, amount: 700, category: "works", reference: "p" });
  ledger.settle("c", 300, 1);
  assert.equal(ledger.cash, 900);
  assert.equal(ledger.committed, 400);
  assert.equal(ledger.availableCash, 500);
  assert.throws(() => ledger.commit({ id: "too-much", atMinute: 2, amount: 501, category: "x", reference: "x" }));
  assert.equal(ledger.assertInvariant(), true);
});

test("CityPack demand nodes are independent from buildable stations", () => {
  const domain = cityPackToDomain({ demand: { points: [{ id: "d", location: [139, 35], residents: 10, jobs: 5 }] } });
  assert.equal(domain.demandNodes.length, 1);
  assert.equal(domain.stations.length, 0);
  domain.stations.push({ id: "s", location: [139.001, 35] });
  addAccessLink(domain, { id: "walk", demandNodeId: "d", stationId: "s", walkMinutes: 8 });
  assert.equal(domain.accessLinks[0].walkMinutes, 8);
});

test("PlanGeometry validates missing and invalid inputs", () => {
  assert.equal(validatePlanGeometry(plan()).buildable, true);
  const bad = plan("bad");
  bad.segments[0].lengthMeters = 0;
  bad.stationCandidates[0].platformType = undefined;
  const result = validatePlanGeometry(bad);
  assert.equal(result.buildable, false);
  assert.ok(result.violations.length > 0);
  assert.ok(result.missingInputs.length > 0);
});

test("Japan and Korea produce different procedures and estimates", () => {
  const jp = new ManagementGame({ countryId: "JP" });
  const kr = new ManagementGame({ countryId: "KR" });
  const jpAssessment = jp.assess(plan(), "medium_steel");
  const krAssessment = kr.assess(plan(), "medium_steel");
  assert.notEqual(jpAssessment.estimateRange[0], krAssessment.estimateRange[0]);
  assert.notDeepEqual(getCountryProfile("JP").approvalStages, getCountryProfile("KR").approvalStages);
});

test("O&M tender supports research, technical threshold and deterministic award", () => {
  const game = new ManagementGame({ seed: 19, openingCash: 100_000_000_000 });
  game.announceOpportunity({ id: "om-1", title: "Five-station O&M", deadlineMinute: 1000, contractYears: 20, baselineAnnualCost: 5_000_000_000, minimumTechnical: 70 });
  const research = game.research("om-1", 2);
  assert.ok(research.annualCostRange[1] - research.annualCostRange[0] < 1_000_000_000);
  game.bid("om-1", { requestedAnnualPayment: 4_000_000_000, technicalScore: 100, staffingScore: 95 });
  const evaluated = game.closeTender("om-1");
  assert.equal(evaluated.ranking[0].bidderId, "player");
  const contract = game.award("om-1", "player");
  assert.equal(contract.operatorId, "player");
  assert.equal(game.ledger.commitments.has("bond:om-1"), false);
});

test("single-bid review can reject a proposal and reannounce changed terms", () => {
  const game = new ManagementGame({ seed: 22, openingCash: 100_000_000_000 });
  for (const company of game.competitors) company.activeBids = company.bidCapacity;
  game.announceOpportunity({ id: "single", title: "Single bid", deadlineMinute: 100, contractYears: 20, baselineAnnualCost: 5_000_000_000, minimumTechnical: 70 });
  game.bid("single", { requestedAnnualPayment: 5_100_000_000, technicalScore: 90, staffingScore: 85 });
  const evaluated = game.closeTender("single");
  assert.equal(evaluated.status, "single-bid-review");
  assert.equal(evaluated.singleBidReview.status, "pending");
  const reviewed = game.reviewSingleBid("single", false);
  assert.equal(reviewed.status, "retender");
  assert.equal(game.player.activeBids, 0);
  assert.equal(game.ledger.commitments.has("bond:single"), false);
  const oldPayment = game.requireOpportunity("single").fixedAnnualPayment;
  const reannounced = game.reannounceTender("single", { deadlineDays: 30, paymentAdjustment: 1.1 });
  assert.equal(reannounced.status, "announced");
  assert.equal(reannounced.retenderCount, 1);
  assert.equal(reannounced.bids.length, 0);
  assert.equal(reannounced.fixedAnnualPayment, oldPayment * 1.1);
  assert.equal(reannounced.deadlineMinute, game.clock.minute + 30 * 1440);
});

test("failed preferred-bidder negotiation advances to the next bidder", () => {
  const game = new ManagementGame({ seed: 23, openingCash: 100_000_000_000 });
  game.competitors.forEach((company, index) => {
    if (index === 0) company.strategy.riskTolerance = 10;
    else company.activeBids = company.bidCapacity;
  });
  game.announceOpportunity({ id: "next", title: "Next bidder", deadlineMinute: 100, contractYears: 20, baselineAnnualCost: 5_000_000_000, minimumTechnical: 60 });
  game.bid("next", { requestedAnnualPayment: 3_000_000_000, technicalScore: 100, staffingScore: 95 });
  const evaluated = game.closeTender("next");
  assert.equal(evaluated.ranking.length, 2);
  assert.equal(evaluated.ranking[0].bidderId, "player");
  game.award("next", "player", false);
  const opportunity = game.requireOpportunity("next");
  assert.equal(opportunity.preferredBidderId, "competitor-1");
  assert.equal(game.player.activeBids, 0);
  assert.equal(game.ledger.commitments.has("bond:next"), false);
  const contract = game.award("next", "competitor-1");
  assert.equal(contract.operatorId, "competitor-1");
  assert.equal(game.competitors[0].activeBids, 0);
});

test("technical failure closes participation and releases the bid bond", () => {
  const game = new ManagementGame({ seed: 24, openingCash: 100_000_000_000 });
  for (const company of game.competitors) company.activeBids = company.bidCapacity;
  game.announceOpportunity({ id: "technical-fail", title: "Technical fail", deadlineMinute: 100, contractYears: 20, baselineAnnualCost: 5_000_000_000, minimumTechnical: 90 });
  game.bid("technical-fail", { requestedAnnualPayment: 3_000_000_000, technicalScore: 60, staffingScore: 60 });
  const evaluated = game.closeTender("technical-fail");
  assert.equal(evaluated.status, "failed-technical");
  assert.equal(game.player.activeBids, 0);
  assert.equal(game.ledger.commitments.has("bond:technical-fail"), false);
});

test("failed management transactions roll back state and cash", () => {
  const game = new ManagementGame({ openingCash: 1_000_000 });
  const before = game.save();
  assert.throws(() => game.createProject(plan("unaffordable"), "medium_steel") && game.contractProject("project:unaffordable"));
  assert.equal(game.ledger.cash, 1_000_000);
  assert.equal(game.ledger.entries.length, 0);
  assert.ok(game.projects.length === 1, "project creation is a completed earlier command, only contract rolls back");
  assert.notEqual(game.save(), before);
});

test("construction, vehicle production, depot and service form one playable vertical slice", () => {
  const game = new ManagementGame({ seed: 7, openingCash: 1_000_000_000_000 });
  const project = game.createProject(plan("vertical"), "medium_steel");
  game.contractProject(project.id);
  game.addDepot({ id: "depot-1", name: "East Depot", locationStrategy: "terminal", capacitySets: 4, inspectionSetsPerDay: 2 });
  game.orderVehicles({ id: "order-1", modelId: "medium_4car", quantity: 4, manufacturerId: "maker-a" });
  for (let month = 0; month < 120; month++) {
    game.advanceMonth();
    if (game.projects[0].status === "available" && game.vehicleOrders[0].stage === "accepted") break;
  }
  assert.equal(game.projects[0].status, "available");
  assert.equal(game.vehicleOrders[0].stage, "accepted");
  assert.equal(game.vehicleOrders[0].units.length, 4);
  const service = game.createService({
    id: "service-1",
    projectId: project.id,
    vehicleOrderId: "order-1",
    depotId: "depot-1",
    modelId: "medium_4car",
    routeKm: 4.7,
    stations: 3,
    commercialSpeedKph: 30,
    trainsPerHour: 4,
    staffReady: true,
    timetableReady: true,
    trialOperationPassed: true,
    approvalsValid: true,
    platformLengthM: 100,
  });
  assert.equal(service.status, "open");
  const cashBefore = game.ledger.cash;
  for (let day = 0; day < 30; day++) game.operateDay(service.id);
  assert.equal(game.services[0].daysOperated, 30);
  assert.notEqual(game.ledger.cash, cashBefore);
  assert.ok(game.services[0].totals.boarded > 0);
  game.ledger.assertInvariant();
});

test("save/load preserves RNG and future results", () => {
  const a = new ManagementGame({ seed: 44 });
  a.createProject(plan("save"), "medium_steel");
  a.contractProject("project:save");
  a.advanceMonth();
  const b = ManagementGame.load(a.save());
  for (let i = 0; i < 12; i++) {
    a.advanceMonth();
    b.advanceMonth();
  }
  assert.deepEqual(a.snapshot(), b.snapshot());
  const future = JSON.parse(a.save());
  future.schemaVersion = 999;
  assert.throws(() => ManagementGame.load(JSON.stringify(future)), /Unsupported save schema/);
});

test("economic assessment separates social B/C from company NPV and reports DSCR", () => {
  const assessment = economicAssessment({ socialBenefits: 130, socialCosts: 100, companyCashflows: [-100, 20, 20, 20, 20, 20], debtService: [10, 10, 10, 10, 10] });
  assert.equal(assessment.sociallyViable, true);
  assert.equal(assessment.commerciallyViable, false);
  assert.equal(assessment.minimumDscr, 2);
});

test("one-year operation remains identical across a mid-year save", () => {
  const setup = () => {
    const game = new ManagementGame({ seed: 303, openingCash: 1_000_000_000_000 });
    const project = game.createProject(plan("year"), "medium_steel");
    game.contractProject(project.id);
    game.addDepot({ id: "year-depot", name: "Year Depot", locationStrategy: "suburban", capacitySets: 4, inspectionSetsPerDay: 2 });
    game.orderVehicles({ id: "year-fleet", modelId: "medium_4car", quantity: 4, manufacturerId: "maker-b" });
    for (let month = 0; month < 120; month++) {
      game.advanceMonth();
      if (game.projects[0].status === "available" && game.vehicleOrders[0].stage === "accepted") break;
    }
    game.createService({ id: "year-service", projectId: project.id, vehicleOrderId: "year-fleet", depotId: "year-depot", modelId: "medium_4car", routeKm: 4.7, stations: 3, commercialSpeedKph: 30, trainsPerHour: 4, staffReady: true, timetableReady: true, trialOperationPassed: true, approvalsValid: true, platformLengthM: 100 });
    return game;
  };
  const uninterrupted = setup();
  for (let day = 0; day < 365; day++) uninterrupted.operateDay("year-service");
  const resumed = setup();
  for (let day = 0; day < 183; day++) resumed.operateDay("year-service");
  const loaded = ManagementGame.load(resumed.save());
  for (let day = 183; day < 365; day++) loaded.operateDay("year-service");
  assert.deepEqual(uninterrupted.snapshot(), loaded.snapshot());
  assert.equal(uninterrupted.services[0].daysOperated, 365);
  uninterrupted.ledger.assertInvariant();
});

test("consortium, SPV finance, debt default and lender step-in are enforceable", () => {
  const companies = [
    { id: "a", cash: 80, reputation: 80, operatingScore: 75, bidCapacity: 2, backlog: 0 },
    { id: "b", cash: 80, reputation: 70, operatingScore: 85, bidCapacity: 2, backlog: 0 },
  ];
  const consortium = createConsortium({ id: "c", name: "Metro Consortium", members: [{ companyId: "a", share: 0.6 }, { companyId: "b", share: 0.4 }] });
  const spv = createSpv({ id: "spv", consortium, equity: 100, debt: 200, projectId: "p" });
  fundSpv(spv, companies);
  assert.equal(companies[0].cash, 20);
  const finance = createProjectFinance({ id: "loan", equity: 100, debt: 200, annualRate: 0.05, termYears: 10 });
  closeProjectFinance(spv, finance);
  const payment = serviceDebtYear(spv, 1);
  assert.equal(payment.defaulted, true);
  assert.equal(resolveDefault(spv, { replacementOperatorAvailable: true }), "lender-step-in");
});

test("advanced contracts allocate risk and only verified triggers renegotiate", () => {
  const contract = createAdvancedContract({ id: "bto", template: "bto", termYears: 30, value: 1000, parties: ["authority", "spv"] });
  assert.equal(contract.riskAllocation.demand, "operator");
  assert.equal(requestRenegotiation(contract, { type: "ordinary-demand-loss", verifiedCost: 100 }).accepted, false);
  const accepted = requestRenegotiation(contract, { type: "law-change", verifiedCost: 100, sharedRatio: 0.5, delayMonths: 6 });
  assert.equal(accepted.accepted, true);
  assert.equal(contract.value, 1050);
  assert.equal(contract.termYears, 30.5);
});

test("engineering depth changes feasibility, cost, duration and risk distribution", () => {
  const deepPlan = plan("deep");
  deepPlan.segments[0].elevationEndMeters = 120;
  deepPlan.segments[0].curveRadiusMeters = 80;
  deepPlan.segments[1].groundwater = "high";
  deepPlan.segments[1].structureHint = "shield";
  deepPlan.segments[1].utilityCrossings = 5;
  deepPlan.segments[1].seismicClass = "high";
  const engineering = detailedEngineeringAssessment(deepPlan, TECHNICAL_PROFILES.medium_steel);
  assert.equal(engineering.feasible, false);
  assert.ok(engineering.costMultiplier > 1.2);
  assert.ok(engineering.durationMultiplier > 1);
  const risks = constructionRiskDistribution({ countryProfile: getCountryProfile("JP"), undergroundShare: 0.8, lowQualityShare: 0.5, communityExposure: 0.4 });
  assert.ok(risks.geology > risks.accident);
});

test("D2 depot, fleet aging, leasing and market changes have concrete effects", () => {
  const depot = createD2Depot({ id: "d2", capacitySets: 20, heavyInspectionBays: 2 });
  assert.equal(depot.type, "D2");
  const units = [{ id: "u", mileageKm: 20_000, nextInspectionKm: 30_000, status: "available" }];
  ageVehicleFleet(units, 60_000, 2, 0.985);
  assert.equal(units[0].status, "inspection-due");
  assert.ok(units[0].condition < 1);
  assert.ok(["lease", "purchase"].includes(evaluateLease({ annualLease: 20, years: 10, residualRisk: 5, purchasePrice: 180 }).preferred));
  const acquirer = createMarketEntrant({ id: "m1", name: "One", capital: 500, role: "operator", countryId: "JP" });
  const target = createMarketEntrant({ id: "m2", name: "Two", capital: 100, role: "operator", countryId: "KR" });
  mergeCompanies(acquirer, target, 200);
  assert.equal(target.status, "acquired");
  assert.equal(acquirer.cash, 400);
});
