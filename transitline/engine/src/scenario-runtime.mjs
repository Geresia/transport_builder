import { loadIntegratedGame, restoreOperationalState, saveIntegratedGame, snapshotOperationalState } from "./integrated-save.mjs";
import { createMapEngineBridge } from "./map-engine-bridge.mjs";
import {
  ManagementGame,
  TECHNICAL_PROFILES,
  VEHICLE_MODELS,
  applyScenario,
  calculateFleetRequirement,
  createScenario,
  createStationDesignFromSite,
  depotCapacityRequirement,
  evaluateScenario,
  investmentMemo,
  settleIntegratedServiceDay,
  stationDeliveryReadiness,
} from "./management/index.mjs";
import { stableId } from "./map/ids.mjs";
import { addLine } from "./state.mjs";
import {
  bindThroughServiceToLine,
  clearThroughOperationDay,
  setThroughOperationSuspended,
  throughOperationActualsForDay,
  throughOperationBinding,
  throughOperationReport,
  unbindThroughServiceFromLine,
} from "./through-operation-integration.mjs";
import {
  buildThroughOperationDraft,
  buildThroughRouteFromSelection,
  removeThroughRouteSelection,
  saveThroughRouteSelection,
  throughRoutePlanningReport,
} from "./through-route-planning-integration.mjs";

const VEHICLE_BY_PROFILE = Object.freeze({
  medium_steel: "medium_4car",
  small_steel: "small_4car",
  large_steel: "large_8car",
  agt: "agt_3car",
  monorail: "monorail_6car",
  linear_metro: "linear_6car",
});

function replaceState(target, source) {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, source);
}

function routeFacts(project) {
  return {
    routeKm: project.planGeometry.segments.reduce((sum, segment) => sum + segment.lengthMeters, 0) / 1000,
    stations: project.planGeometry.stationCandidates.length,
  };
}

function planFacts(plan) {
  return {
    routeKm: (plan.segments ?? []).reduce((sum, segment) => sum + segment.lengthMeters, 0) / 1000,
    stations: plan.stationCandidates?.length ?? 0,
  };
}

function fallbackDepotSite(project, strategy, requirement) {
  const assumptions = {
    terminal: { connection: 300, terminal: 700, residential: 220, density: 1_500, areaFactor: 1.35 },
    suburban: { connection: 1_500, terminal: 7_000, residential: 450, density: 650, areaFactor: 1.6 },
    remote: { connection: 4_000, terminal: 20_000, residential: 1_500, density: 100, areaFactor: 1.9 },
    shared: { connection: 200, terminal: 8_000, residential: 350, density: 900, areaFactor: 0.8 },
  }[strategy];
  if (!assumptions) throw new Error(`지원하지 않는 차량기지 입지전략입니다: ${strategy}`);
  const station = project.planGeometry.stationCandidates[0];
  return {
    schema: "transitline.depot-site-geometry/1",
    contractVersion: 1,
    depotSiteId: `estimated-site:${project.planId}:${strategy}`,
    sourcePackId: project.planGeometry.sourcePackId,
    sourcePackVersion: project.planGeometry.sourcePackVersion ?? null,
    name: `${project.planGeometry.name ?? "신설선"} ${strategy} 추정후보`,
    location: station?.location ?? [0, 0],
    polygon: null,
    areaSquareMeters: requirement.requiredAreaSquareMeters * assumptions.areaFactor,
    connectedPlanId: project.planId,
    connectedSegmentId: project.planGeometry.segments[0]?.id ?? null,
    connectionTrackLengthMeters: assumptions.connection,
    distanceToMainlineMeters: assumptions.connection,
    distanceToTerminalMeters: assumptions.terminal,
    distanceToNearestStationMeters: assumptions.connection,
    averageSlopePercent: 0.8,
    maximumSlopePercent: 1.8,
    intersectedBuildingCount: strategy === "terminal" ? 2 : 0,
    roadCrossingCount: strategy === "remote" ? 2 : 1,
    waterCrossingCount: 0,
    waterOverlapCount: 0,
    roadsThroughSite: strategy === "terminal" ? 2 : 0,
    connectionCrossings: { building: strategy === "terminal" ? 1 : 0, road: strategy === "remote" ? 2 : 1, water: 0 },
    distanceToResidentialMeters: assumptions.residential,
    surroundingBuildingDensity: assumptions.density,
    existingFacilityReuse: { status: strategy === "shared" ? "adjacent" : "none", facilities: [] },
    dataQuality: "low",
    unknown: ["polygon", "groundwater", "soft-ground", "land-price"],
    constraintUnknown: ["groundwater", "soft-ground"],
    sourceLayers: [],
  };
}

function scenarioOpportunityInput(scenario, countryId) {
  const japanese = countryId === "JP";
  const deadlineDays = scenario.difficulty === "hard" ? 120 : scenario.difficulty === "easy" ? 240 : 180;
  const minimumTechnical = scenario.difficulty === "hard" ? 82 : scenario.difficulty === "easy" ? 68 : 75;
  const estimatedCapitalCost = scenario.startingCash * 0.85;
  const baselineOperatingCost = scenario.startingCash * 0.012;
  return {
    id: `opportunity:${scenario.id}`,
    type: "design-build-operate",
    title: `${scenario.name} 철도사업자 공모`,
    authority: japanese ? "도시권 광역교통·철도사업 조정기관" : "국가·지방자치단체 도시철도 사업단",
    processLabel: japanese ? "철도사업 허가 연계 DBO 공모" : "도시철도 사업자·DBO 통합공모",
    deadlineMinute: deadlineDays * 1440,
    contractYears: 30,
    baselineAnnualCost: estimatedCapitalCost / 30 + baselineOperatingCost,
    baselineOperatingCost,
    estimatedCapitalCost,
    researchCosts: { 1: 150_000_000, 2: 450_000_000 },
    preparationCost: scenario.startingCash * 0.001,
    bidBond: scenario.startingCash * 0.01,
    minimumTechnical,
    qualification: {
      minimumCash: Math.min(50_000_000_000, scenario.startingCash * 0.08),
      minimumReputation: scenario.difficulty === "hard" ? 70 : 60,
    },
    scope: {
      networkMode: scenario.networkMode,
      minimumRouteKm: scenario.objectives.minimumRouteKm,
      minimumStations: scenario.objectives.minimumStations,
      targetDailyPassengers: scenario.objectives.minimumDailyPassengers,
      maximumPublicCost: scenario.objectives.maximumPublicCost,
      alignmentPolicy: "performance-specification",
    },
    viewedAt: null,
  };
}

export function stablePlanKey(packId, stationIds) {
  const forward = stationIds.join("|");
  const reverse = [...stationIds].reverse().join("|");
  return stableId("ui-plan", packId, forward < reverse ? forward : reverse);
}

export function planIdForKey(packId, key) {
  return stableId("plan", packId, "key", key);
}

export function planningDefaults(technicalProfileId, structure, platformType) {
  const profile = TECHNICAL_PROFILES[technicalProfileId];
  if (!profile) throw new Error(`Unknown technical profile ${technicalProfileId}`);
  const depthMeters = structure === "cut-cover" ? 10 : structure === "shield" ? 22 : structure === "deep" ? 40 : 0;
  return {
    structure,
    depthMeters,
    platformType,
    platformLengthM: profile.platformLengthPerCarM * profile.minCars,
  };
}

export class ScenarioRuntime {
  constructor({ pack, operationalState, countryId = "JP", networkMode = "scratch", fundingMode = "limited", difficulty = "normal", seed = 20260925 } = {}) {
    this.pack = pack;
    this.operationalState = operationalState;
    const type = networkMode === "existing" ? "congestion_relief" : "greenfield_growth";
    const scenario = createScenario({ id: `${countryId}:${type}:${difficulty}`, type, networkMode, fundingMode, difficulty, countryId });
    this.game = new ManagementGame({ countryId, seed, openingCash: scenario.startingCash });
    applyScenario(this.game, scenario, pack);
    this.game.announceOpportunity(scenarioOpportunityInput(this.game.scenario, countryId));
    this.bridge = createMapEngineBridge(this.game, operationalState);
  }

  report() {
    const assessments = {};
    for (const record of this.game.plans) assessments[record.planId] = structuredClone(record.assessment);
    return structuredClone({
      plans: this.game.plans,
      projects: this.game.projects,
      schedules: this.game.schedules,
      constructionPackages: this.game.constructionPackageReport(),
      equipmentAssignments: this.game.equipmentAssignmentReport(),
      workfrontAssessments: this.game.workfrontAssessmentReport(),
      constructionChangeOrders: this.game.constructionChangeOrderReport(),
      constructionMarkers: this.game.constructionMarkers,
      constructionEvents: this.game.constructionEventReport(),
      constructionCycles: this.game.constructionCycleReport(),
      constructionPrice: this.game.constructionPriceState,
      constructionFundingCases: this.game.constructionFundingReport(),
      constructionFinancing: this.game.constructionFinanceReport(),
      services: this.game.services,
      operatingMonths: this.game.operatingMonthReport(),
      operatingResourcePools: this.game.operatingResourcePoolReport(),
      trackAccess: this.game.trackAccessReport(),
      throughServices: this.game.throughServiceReport(),
      vehicleRetrofits: this.game.vehicleRetrofitReport(),
      throughFareAgreements: this.game.throughFareAgreementReport(),
      throughOperatingSettlements: this.game.throughOperatingSettlementReport(null, 24),
      throughOperationBindings: throughOperationReport(this.operationalState),
      throughRoutes: structuredClone(this.operationalState?.throughRoutePlans ?? []),
      corporateFinance: this.game.corporateFinancialStatements({ fromMonth: Math.max(0, Math.floor(this.game.clock.minute / (30 * 1440)) - 11) }),
      assessments,
    });
  }

  latestPlan(planId) {
    return this.game.plans.filter((record) => record.planId === planId).sort((a, b) => b.version - a.version)[0] ?? null;
  }

  projectForPlan(planId) {
    return this.game.projects.find((project) => project.planId === planId) ?? null;
  }

  scenarioOpportunity() {
    return this.game.opportunities.find((opportunity) => opportunity.id === `opportunity:${this.game.scenario.id}`) ?? null;
  }

  viewOpportunity() {
    const opportunity = this.scenarioOpportunity();
    if (!opportunity) throw new Error("시나리오 사업공고가 없습니다.");
    if (opportunity.viewedAt !== null) return structuredClone(opportunity);
    return this.game.transact("opportunity-viewed", () => {
      opportunity.viewedAt = this.game.clock.minute;
      return structuredClone(opportunity);
    });
  }

  opportunityViewed() {
    return this.scenarioOpportunity()?.viewedAt !== null;
  }

  researchOpportunity(level) {
    if (!this.opportunityViewed()) throw new Error("사업공고를 먼저 확인해야 추가조사를 할 수 있습니다.");
    return this.game.research(this.scenarioOpportunity().id, level);
  }

  bidMemo(requestedAnnualPayment = this.scenarioOpportunity()?.fixedAnnualPayment) {
    const opportunity = this.scenarioOpportunity();
    if (!opportunity) throw new Error("시나리오 사업공고가 없습니다.");
    if (!(requestedAnnualPayment > 0)) throw new Error("요구 연간지급액은 0보다 커야 합니다.");
    return investmentMemo(opportunity, { requestedAnnualPayment });
  }

  decideBid(decision, requestedAnnualPayment = this.scenarioOpportunity()?.fixedAnnualPayment) {
    if (!this.opportunityViewed()) throw new Error("사업공고를 먼저 확인해야 투자심의를 할 수 있습니다.");
    if (!["bid", "no-bid"].includes(decision)) throw new Error("투자심의 결정은 bid 또는 no-bid여야 합니다.");
    const opportunity = this.scenarioOpportunity();
    if (opportunity.investmentDecision) throw new Error("투자심의가 이미 끝났습니다.");
    return this.game.transact(decision === "bid" ? "bid-approved" : "bid-declined", () => {
      const memo = this.bidMemo(requestedAnnualPayment);
      opportunity.investmentDecision = { decision, atMinute: this.game.clock.minute, requestedAnnualPayment, memo };
      if (decision === "no-bid") opportunity.status = "declined";
      return structuredClone(opportunity.investmentDecision);
    });
  }

  submitTenderProposal(planId, { staffingScore = 82 } = {}) {
    const opportunity = this.scenarioOpportunity();
    if (opportunity?.investmentDecision?.decision !== "bid") throw new Error("Bid 투자심의를 먼저 통과해야 합니다.");
    const record = this.latestPlan(planId);
    if (!record || record.status !== "assessed") throw new Error("기술심사를 통과한 계획안이 필요합니다.");
    if (opportunity.bids.some((bid) => bid.isPlayer)) throw new Error("플레이어 제안서는 이미 제출됐습니다.");
    const facts = planFacts(record.geometry);
    if (facts.routeKm + 1e-6 < opportunity.scope.minimumRouteKm || facts.stations < opportunity.scope.minimumStations) {
      throw new Error(`공고 최소규모 ${opportunity.scope.minimumRouteKm}km·${opportunity.scope.minimumStations}역을 충족해야 합니다.`);
    }
    const routeCoverage = Math.min(1, facts.routeKm / Math.max(1, opportunity.scope.minimumRouteKm));
    const stationCoverage = Math.min(1, facts.stations / Math.max(1, opportunity.scope.minimumStations));
    const quality = record.geometry.dataQuality === "high" ? 3 : record.geometry.dataQuality === "low" ? -3 : 0;
    const technicalScore = Math.max(0, Math.min(100,
      65 + opportunity.researchLevel * 5 + 10 + routeCoverage * 7 + stationCoverage * 5 + quality
    ));
    return this.game.bid(opportunity.id, {
      requestedAnnualPayment: opportunity.investmentDecision.requestedAnnualPayment,
      technicalScore,
      staffingScore,
      planId,
      planRecordId: record.id,
      offeredRouteKm: facts.routeKm,
      offeredStations: facts.stations,
    });
  }

  evaluateTender() {
    const opportunity = this.scenarioOpportunity();
    if (!opportunity?.bids.some((bid) => bid.isPlayer)) throw new Error("먼저 제안서를 제출해야 합니다.");
    if (opportunity.status !== "announced") throw new Error(`입찰을 평가할 수 없는 상태입니다: ${opportunity.status}`);
    return this.game.closeTender(opportunity.id);
  }

  reviewSingleBid(accepted = true) {
    const opportunity = this.scenarioOpportunity();
    if (opportunity?.status !== "single-bid-review") throw new Error("단독응찰 원가·적정성 검토 대상이 아닙니다.");
    return this.game.reviewSingleBid(opportunity.id, accepted);
  }

  concludeAward() {
    const opportunity = this.scenarioOpportunity();
    if (opportunity?.status !== "preferred-bidder") throw new Error("우선협상자를 먼저 선정해야 합니다.");
    if (opportunity.preferredBidderId !== this.game.player.id) throw new Error("플레이어가 우선협상자가 아니므로 사업을 수주할 수 없습니다.");
    return this.game.award(opportunity.id, this.game.player.id);
  }

  failPreferredNegotiation() {
    const opportunity = this.scenarioOpportunity();
    if (opportunity?.status !== "preferred-bidder") throw new Error("결렬 처리할 우선협상자가 없습니다.");
    return this.game.award(opportunity.id, opportunity.preferredBidderId, false);
  }

  reannounceTender(options = {}) {
    const opportunity = this.scenarioOpportunity();
    if (!opportunity) throw new Error("시나리오 사업공고가 없습니다.");
    return this.game.reannounceTender(opportunity.id, options);
  }

  hasPlayerAward() {
    const opportunity = this.scenarioOpportunity();
    return opportunity?.status === "awarded" && opportunity.awardedBidderId === this.game.player.id;
  }

  submit(planGeometry, technicalProfileId) {
    if (!this.opportunityViewed()) throw new Error("사업공고를 먼저 확인해야 계획을 제출할 수 있습니다.");
    const opportunity = this.scenarioOpportunity();
    if (opportunity?.status !== "announced") throw new Error("입찰 마감 전 공고 상태에서만 계획을 제출할 수 있습니다.");
    if (opportunity.investmentDecision?.decision !== "bid") throw new Error("Bid 투자심의를 통과해야 계획을 제출할 수 있습니다.");
    if (opportunity.bids.some((bid) => bid.isPlayer)) throw new Error("제안서 제출 후에는 계획을 변경할 수 없습니다.");
    return this.bridge.submitPlan(planGeometry, technicalProfileId);
  }

  approveAndCreate(planId) {
    if (!this.hasPlayerAward()) throw new Error("사업을 수주해야 계획 승인과 사업화를 진행할 수 있습니다.");
    const record = this.latestPlan(planId);
    if (!record) throw new Error("먼저 계획을 기술심사에 제출해야 합니다.");
    if (record.status === "assessed") this.bridge.approvePlan(record.id);
    if (this.game.requirePlan(record.id).status === "approved") return this.bridge.createProject(record.id);
    throw new Error(`계획 상태가 ${record.status}라 사업화할 수 없습니다.`);
  }

  contract(planId) {
    const project = this.projectForPlan(planId);
    if (!project) throw new Error("먼저 승인 계획을 사업화해야 합니다.");
    return this.bridge.contractProject(project.id);
  }

  stationPackagesForPlan(planId) {
    return this.game.stationPackages.filter((item) => item.connectedPlanId === planId);
  }

  stationDeliverySummary(planId) {
    const project = this.projectForPlan(planId);
    if (!project) return { expected: 0, designed: 0, awarded: 0, integrated: false, ready: false, reasons: ["사업이 없습니다."] };
    const packages = this.stationPackagesForPlan(planId);
    const expected = project.planGeometry.stationCandidates.length;
    const readiness = stationDeliveryReadiness(project);
    return {
      expected,
      designed: packages.length,
      awarded: packages.filter((item) => ["awarded", "underConstruction", "suspended", "testing", "available"].includes(item.status)).length,
      integrated: project.stationPackageCoverageComplete === true,
      ready: project.stationPackageCoverageComplete === true && readiness.ready,
      reasons: readiness.reasons,
      packages: structuredClone(packages),
    };
  }

  designStation(planId, stationSite, selections = {}) {
    const project = this.projectForPlan(planId);
    if (!project) throw new Error("먼저 승인 계획을 사업화해야 역을 상세설계할 수 있습니다.");
    if (!["estimated", "approved"].includes(project.status)) throw new Error("본공사 계약 전까지만 역 상세설계를 추가할 수 있습니다.");
    if (!stationSite) throw new Error("지도에서 역 후보를 선택하세요.");
    if (stationSite.connectedPlanId !== planId) throw new Error("선택한 역 후보가 현재 계획 노선에 연결되어 있지 않습니다.");
    const vehicleModelId = VEHICLE_BY_PROFILE[project.technicalProfileId];
    if (!vehicleModelId) throw new Error("이 주행 시스템에 연결된 설계 차량이 없습니다.");
    const adaptation = createStationDesignFromSite({
      site: stationSite,
      technicalProfileId: project.technicalProfileId,
      vehicleModelId,
      selections,
    });
    const id = `station-package:${stationSite.stationSiteId.replace(/[^a-zA-Z0-9:_-]/g, "-")}`;
    return this.game.designStationPackage({ id, adaptation, methodId: selections.methodId });
  }

  resolveStationDesign(packageId, resolutions) {
    return this.game.resolveStationPackage(packageId, resolutions);
  }

  tenderStation(packageId) {
    return this.game.tenderStationPackage(packageId);
  }

  awardStation(packageId, bidId) {
    return this.game.awardStationPackage(packageId, bidId);
  }

  integrateStations(planId) {
    const project = this.projectForPlan(planId);
    if (!project) throw new Error("사업이 없습니다.");
    const packages = this.stationPackagesForPlan(planId);
    if (!packages.length) throw new Error("상세설계한 역이 없습니다.");
    return this.game.integrateStationPackages(project.id, packages.map((item) => item.id));
  }

  stationDesignRevision(packageId) {
    const deliveryPackage = this.game.requireStationPackage(packageId);
    return deliveryPackage.geometryRevision ?? `station-design:${deliveryPackage.id}:0`;
  }

  requestStationDesignChange(planId, packageId, input) {
    const project = this.projectForPlan(planId);
    if (!project) throw new Error("A project is required before changing a station design.");
    const deliveryPackage = this.game.requireStationPackage(packageId);
    if (deliveryPackage.connectedPlanId !== planId) throw new Error("The station package is connected to a different plan.");
    return this.game.requestStationDesignChange(packageId, input);
  }

  approveStationDesignChange(planId, packageId, changeId) {
    const project = this.projectForPlan(planId);
    if (!project) throw new Error("A project is required before approving a station design change.");
    const deliveryPackage = this.game.requireStationPackage(packageId);
    if (deliveryPackage.connectedPlanId !== planId) throw new Error("The station package is connected to a different plan.");
    return this.game.approveStationDesignChange(packageId, changeId);
  }

  rejectStationDesignChange(planId, packageId, changeId, reason) {
    const project = this.projectForPlan(planId);
    if (!project) throw new Error("A project is required before rejecting a station design change.");
    const deliveryPackage = this.game.requireStationPackage(packageId);
    if (deliveryPackage.connectedPlanId !== planId) throw new Error("The station package is connected to a different plan.");
    return this.game.rejectStationDesignChange(packageId, changeId, reason);
  }

  evaluateDepotCandidate(planId, {
    depotStrategy = "terminal",
    depotSite = null,
    depotStructure = null,
    mitigationPackageId = "standard",
    communityPackageId = "green-buffer",
    operatorShare = 0.25,
    comparisonCount = null,
    trainsPerHour = 4,
  } = {}) {
    const project = this.projectForPlan(planId);
    if (!project) throw new Error("사업이 없습니다.");
    const modelId = VEHICLE_BY_PROFILE[project.technicalProfileId];
    if (!modelId) throw new Error("지원 차량이 없는 기술 방식입니다.");
    const facts = routeFacts(project);
    const fleetRequirement = calculateFleetRequirement({ ...facts, commercialSpeedKph: 30, trainsPerHour });
    const quantity = fleetRequirement.minimumFleet;
    const inspectionSetsPerDay = Math.max(1, Math.ceil(quantity / 8));
    const requirement = depotCapacityRequirement({ capacitySets: quantity, inspectionSetsPerDay, modelId });
    const structureId = depotStructure ?? (depotStrategy === "shared" ? "shared" : "surface");
    const effectiveStrategy = structureId === "shared" ? "shared" : depotStrategy;
    const site = depotSite ?? fallbackDepotSite(project, effectiveStrategy, requirement);
    if (depotSite && effectiveStrategy !== "shared" && depotSite.connectedPlanId !== project.planId) {
      throw new Error("선택한 차량기지 후보가 현재 계획 노선에 연결되어 있지 않습니다.");
    }
    const assessment = this.game.evaluateDepotCandidate({
      site,
      capacitySets: quantity,
      inspectionSetsPerDay,
      modelId,
      structureId,
      mitigationPackageId,
      communityPackageId,
      disclosedEarly: true,
      comparisonCount: comparisonCount ?? (depotSite ? 2 : 1),
    });
    return {
      assessment,
      fleetRequirement,
      requirement,
      quantity,
      inspectionSetsPerDay,
      modelId,
      site,
      structureId,
      operatorCapex: assessment.economics.totalP50 * operatorShare,
      usedEstimatedSite: !depotSite,
    };
  }

  prepareFleet(planId, {
    depotStrategy = "terminal",
    depotSite = null,
    depotStructure = null,
    mitigationPackageId = "standard",
    communityPackageId = "green-buffer",
    fundingShares = { operatorShare: 0.25, nationalGovernmentShare: 0.55, localGovernmentShare: 0.2 },
    comparisonCount = null,
    trainsPerHour = 4,
    manufacturerId = "maker-b",
  } = {}) {
    const project = this.projectForPlan(planId);
    if (!project) throw new Error("사업이 없습니다.");
    if (!project.technicalProfileId || !VEHICLE_BY_PROFILE[project.technicalProfileId]) throw new Error("지원 차량이 없는 기술 방식입니다.");
    const suffix = project.planId.replace(/[^a-zA-Z0-9_-]/g, "-");
    const depotId = `depot:${suffix}`;
    const orderId = `fleet:${suffix}`;
    if (this.game.depots.some((depot) => depot.id === depotId) || this.game.vehicleOrders.some((order) => order.id === orderId)) throw new Error("차량기지와 차량 발주가 이미 준비됐습니다.");
    const planning = this.evaluateDepotCandidate(planId, {
      depotStrategy,
      depotSite,
      depotStructure,
      mitigationPackageId,
      communityPackageId,
      operatorShare: fundingShares.operatorShare,
      comparisonCount,
      trainsPerHour,
    });
    const { fleetRequirement, requirement, quantity, modelId, inspectionSetsPerDay, site, structureId } = planning;
    const checkpoint = this.save();
    try {
      const depot = this.game.planDepot({
        id: depotId,
        name: `${project.planGeometry.name ?? "신설선"} 차량기지`,
        projectId: project.id,
        site,
        capacitySets: quantity,
        inspectionSetsPerDay,
        modelId,
        structureId,
        mitigationPackageId,
        communityPackageId,
        disclosedEarly: true,
        comparisonCount: depotSite ? 2 : 1,
      });
      const agreement = this.game.negotiateDepot(depot.id, fundingShares);
      if (!agreement.accepted) throw new Error("차량기지 지자체·주민 협의가 성립하지 않았습니다.");
      const depotContract = this.game.contractDepot(depot.id);
      const order = this.game.orderVehicles({ id: orderId, modelId, quantity, manufacturerId });
      const schedule = this.game.createIntegratedSchedule({ projectId: project.id, depotIds: [depot.id], vehicleOrderIds: [order.id] });
      return { depot, agreement, depotContract, order, schedule, fleetRequirement, requirement, usedEstimatedSite: planning.usedEstimatedSite };
    } catch (error) {
      this.load(checkpoint);
      throw error;
    }
  }

  advanceMonths(months = 1) {
    if (!Number.isInteger(months) || months < 1) throw new Error("진행 개월은 양의 정수여야 합니다.");
    const results = [];
    for (let index = 0; index < months; index++) results.push(this.game.advanceMonth());
    for (const binding of throughOperationReport(this.operationalState)) this.syncThroughOperationLine(binding.throughServiceId);
    return results;
  }

  constructionCycleReport(limit = null) {
    return this.game.constructionCycleReport(limit);
  }

  resolveConstructionFundingCase(caseId, optionId) {
    return this.game.resolveConstructionFundingCase(caseId, optionId);
  }

  constructionFundingOptions(caseId) {
    return this.game.constructionFundingOptions(caseId);
  }

  constructionSchedule(planId) {
    const project = this.projectForPlan(planId);
    if (!project) return null;
    return this.game.schedules.find((schedule) => schedule.projectId === project.id) ?? null;
  }

  delayConstructionTask(planId, taskId, { months, reason, source } = {}) {
    const schedule = this.constructionSchedule(planId);
    if (!schedule) throw new Error("통합 공정표가 없습니다. 차량기지와 차량 발주를 먼저 준비하세요.");
    return this.game.delayIntegratedTask(schedule.id, taskId, { months, reason, source });
  }

  configureConstructionPackages(planId, constructionExport, selections = []) {
    const schedule = this.constructionSchedule(planId);
    if (!schedule) throw new Error("통합 공정표가 없습니다. 차량기지와 차량 발주를 먼저 준비하세요.");
    const sites = (constructionExport?.sites ?? []).filter((site) => site.connectedPlanId === planId);
    if (!sites.length) throw new Error("현재 계획 노선에 연결된 공사 공구가 없습니다.");
    const ids = new Set(sites.map((site) => site.constructionSiteId));
    const selected = (Array.isArray(selections) ? selections : [selections]).filter((selection) => ids.has(selection?.constructionSiteId));
    return this.game.configureConstructionPackages(schedule.id, { ...structuredClone(constructionExport), sites }, selected);
  }

  selectConstructionCandidate(planId, selection) {
    const schedule = this.constructionSchedule(planId);
    if (!schedule) throw new Error("통합 공정표가 없습니다.");
    return this.game.selectConstructionCandidate(schedule.id, selection);
  }

  prepareConstructionProcurement(planId) {
    const schedule = this.constructionSchedule(planId);
    if (!schedule) throw new Error("통합 공정표가 없습니다.");
    return this.game.prepareConstructionProcurement(schedule.id);
  }

  tenderConstructionPackage(planId, constructionSiteId, options = {}) {
    const schedule = this.constructionSchedule(planId);
    if (!schedule) throw new Error("통합 공정표가 없습니다.");
    return this.game.tenderConstructionPackage(schedule.id, constructionSiteId, options);
  }

  awardConstructionPackage(planId, constructionSiteId, bidId) {
    const schedule = this.constructionSchedule(planId);
    if (!schedule) throw new Error("통합 공정표가 없습니다.");
    return this.game.awardConstructionPackage(schedule.id, constructionSiteId, bidId);
  }

  integrateConstructionPackageAwards(planId) {
    const schedule = this.constructionSchedule(planId);
    if (!schedule) throw new Error("통합 공정표가 없습니다.");
    return this.game.integrateConstructionPackageAwards(schedule.id);
  }

  settleConstructionPriceIndex(planId, priceIndex, options = {}) {
    const schedule = this.constructionSchedule(planId);
    if (!schedule) throw new Error("통합 공정표가 없습니다.");
    return this.game.settleConstructionPriceIndex(schedule.id, priceIndex, options);
  }

  applyConstructionWorkfront(planId, workfront) {
    const schedule = this.constructionSchedule(planId);
    if (!schedule) throw new Error("통합 공정표가 없습니다.");
    if (!schedule.constructionPackages?.some((entry) => entry.constructionSiteId === workfront?.constructionSiteId)) throw new Error("현재 계획 노선의 공사 공구가 아닙니다.");
    return this.game.applyConstructionWorkfront(schedule.id, workfront);
  }

  requestConstructionChangeOrder(planId, input) {
    const schedule = this.constructionSchedule(planId);
    if (!schedule) throw new Error("통합 공정표가 없습니다.");
    if (!schedule.constructionPackages?.some((entry) => entry.constructionSiteId === input?.constructionSiteId)) throw new Error("현재 계획 노선의 공사 공구가 아닙니다.");
    return this.game.requestConstructionChangeOrder(schedule.id, input);
  }

  resolveConstructionChangeResponsibility(planId, changeOrderId, responsibility) {
    const schedule = this.constructionSchedule(planId);
    if (!schedule) throw new Error("통합 공정표가 없습니다.");
    return this.game.resolveConstructionChangeResponsibility(schedule.id, changeOrderId, responsibility);
  }

  approveConstructionChangeOrder(planId, changeOrderId) {
    const schedule = this.constructionSchedule(planId);
    if (!schedule) throw new Error("통합 공정표가 없습니다.");
    return this.game.approveConstructionChangeOrder(schedule.id, changeOrderId);
  }

  rejectConstructionChangeOrder(planId, changeOrderId, reason) {
    const schedule = this.constructionSchedule(planId);
    if (!schedule) throw new Error("통합 공정표가 없습니다.");
    return this.game.rejectConstructionChangeOrder(schedule.id, changeOrderId, reason);
  }

  recordConstructionMarker(planId, marker) {
    const schedule = this.constructionSchedule(planId);
    if (!schedule) throw new Error("통합 공정표가 없습니다.");
    if (!schedule.constructionPackages?.some((entry) => entry.constructionSiteId === marker?.constructionSiteId)) throw new Error("현재 계획 노선의 공사 공구가 아닙니다.");
    return this.game.recordConstructionMarker(marker);
  }

  triggerConstructionEvent(planId, input) {
    const schedule = this.constructionSchedule(planId);
    if (!schedule) throw new Error("통합 공정표가 없습니다.");
    if (!schedule.constructionPackages?.some((entry) => entry.constructionSiteId === input?.constructionSiteId)) throw new Error("현재 계획 노선의 공사 공구가 아닙니다.");
    return this.game.triggerConstructionEvent(schedule.id, input);
  }

  respondConstructionEvent(eventId, responseId) {
    return this.game.respondConstructionEvent(eventId, responseId);
  }

  applyConstructionImpact(eventId, impact) {
    return this.game.applyConstructionImpact(eventId, impact);
  }

  ignoreConstructionEvent(eventId) {
    return this.game.ignoreConstructionEvent(eventId);
  }

  suspend(planId, reason = "Player decision") {
    const project = this.projectForPlan(planId);
    if (!project) throw new Error("사업이 없습니다.");
    return this.bridge.suspendProject(project.id, reason);
  }

  resume(planId) {
    const project = this.projectForPlan(planId);
    if (!project) throw new Error("사업이 없습니다.");
    return this.bridge.resumeProject(project.id);
  }

  cancel(planId) {
    const project = this.projectForPlan(planId);
    if (!project) throw new Error("사업이 없습니다.");
    return this.game.cancelProject(project.id);
  }

  // passengerWeight: how many real people one "delivered" unit in operationalState.stats.deliveredByLine represents.
  // The old individual-passenger engine spawns a small synthetic-agent count, so it defaults to 100 (unchanged
  // behaviour). A service meant to be driven by the ?model=pop simulation (pop-sim.mjs) must pass 1: a pop's rider
  // count is already real people, so scaling it up again here would inflate settlement 100x.
  open(planId, { color, trainsPerHour = 4, passengerWeight = 100 } = {}) {
    const project = this.projectForPlan(planId);
    if (!project) throw new Error("사업이 없습니다.");
    if (project.status !== "available") throw new Error("시설 공사와 검사가 아직 끝나지 않았습니다.");
    const schedule = this.constructionSchedule(planId);
    if (schedule && !schedule.ready) throw new Error("통합 공정표의 선행 작업과 지연 조치가 아직 끝나지 않았습니다.");
    const suffix = project.planId.replace(/[^a-zA-Z0-9_-]/g, "-");
    const depotId = `depot:${suffix}`;
    const orderId = `fleet:${suffix}`;
    const order = this.game.vehicleOrders.find((item) => item.id === orderId);
    if (order?.stage !== "accepted") throw new Error("영업용 차량 인수가 아직 끝나지 않았습니다.");
    const serviceId = `service:${suffix}`;
    if (this.game.services.some((service) => service.id === serviceId)) throw new Error("이미 개통한 서비스입니다.");
    const checkpoint = this.save();
    const facts = routeFacts(project);
    const model = VEHICLE_MODELS[order.modelId];
    const profile = TECHNICAL_PROFILES[project.technicalProfileId];
    const knownLengths = project.planGeometry.stationCandidates.map((station) => station.platformLengthM).filter(Number.isFinite);
    const platformLengthM = knownLengths.length ? Math.min(...knownLengths) : model.cars * profile.platformLengthPerCarM;
    try {
      const service = this.game.createService({
        id: serviceId,
        name: project.planGeometry.name ?? project.planId,
        projectId: project.id,
        vehicleOrderId: orderId,
        depotId,
        modelId: order.modelId,
        ...facts,
        commercialSpeedKph: 30,
        trainsPerHour,
        staffReady: true,
        timetableReady: true,
        trialOperationPassed: true,
        approvalsValid: true,
        contractId: this.game.contracts.find((contract) => contract.opportunityId === this.scenarioOpportunity()?.id)?.id,
        platformLengthM,
        passengerWeight,
      });
      if (service.status !== "open") throw new Error(service.readiness.reasons.join("; "));
      const commissioned = this.bridge.commission({ projectId: project.id, serviceId, color, lineName: service.name });
      const lineId = String(commissioned.lineId);
      service.engineCursor = {
        day: Math.floor(this.operationalState.simMinutes / 1440),
        delivered: this.operationalState.stats.deliveredByLine[lineId] ?? 0,
        trainKm: this.operationalState.stats.trainKmByLine[lineId] ?? 0,
      };
      service.operationsStartedAtSimMinute = this.operationalState.simMinutes;
      service.operationsStartedAtGameMinute = this.game.clock.minute;
      return { service: structuredClone(service), commissioned };
    } catch (error) {
      this.load(checkpoint);
      throw error;
    }
  }

  settleOperatingDays() {
    const commissioned = this.game.services.filter((item) => item.operationalLineId !== undefined && item.operationsStartedAtGameMinute !== undefined);
    const currentDay = Math.floor(this.operationalState.simMinutes / 1440);
    const dueServices = this.game.services.filter((item) => item.status === "open"
      && item.operationalLineId !== undefined
      && currentDay > (item.engineCursor?.day ?? currentDay));
    const maximumDueDays = dueServices.reduce((maximum, service) => Math.max(maximum,
      currentDay - (service.engineCursor?.day ?? currentDay)), 0);
    const throughBindings = throughOperationReport(this.operationalState);
    const dueThrough = [];
    for (const binding of throughBindings) {
      const service = this.game.throughServices.find((entry) => entry.throughServiceId === binding.throughServiceId);
      const hasActiveFare = this.game.throughFareAgreements.some((agreement) => agreement.throughServiceId === binding.throughServiceId && agreement.status === "active");
      if (!service || service.status !== "approved" || !hasActiveFare) continue;
      const firstDay = Math.max(binding.startDay, (service.lastThroughOperatingDay ?? binding.startDay - 1) + 1);
      for (let day = firstDay; day < currentDay; day += 1) dueThrough.push({ binding, service, day });
    }
    const throughCalendarTargets = throughBindings
      .filter((binding) => dueThrough.some((entry) => entry.binding.throughServiceId === binding.throughServiceId))
      .map((binding) => (binding.startedAtGameMinute ?? this.game.clock.minute)
        + Math.max(0, this.operationalState.simMinutes - binding.startedAtSimMinute));
    const calendarTarget = dueServices.length || dueThrough.length
      ? Math.max(
        this.game.clock.minute + maximumDueDays * 1440,
        ...commissioned.map((service) => service.operationsStartedAtGameMinute + Math.max(0, this.operationalState.simMinutes - service.operationsStartedAtSimMinute)),
        ...throughCalendarTargets,
      )
      : this.game.clock.minute;
    const targetMonth = Math.floor(calendarTarget / (30 * 1440));
    const projectsWithFinanceDue = new Set(commissioned.filter((service) => this.game.constructionFinancing.some((entry) => entry.projectId === service.projectId
      && entry.firstDueMonth !== undefined
      && (entry.lastServicedMonth ?? entry.firstDueMonth - 1) < targetMonth
      && !["repaid", "closed"].includes(entry.status))).map((service) => service.projectId));
    if (!dueServices.length && !dueThrough.length && !projectsWithFinanceDue.size) return [];

    const managementCheckpoint = this.game.snapshot();
    const operationalCheckpoint = snapshotOperationalState(this.operationalState);
    try {
      const settlements = [];
      if (calendarTarget > this.game.clock.minute) this.game.clock.advance(calendarTarget - this.game.clock.minute);
      for (const service of dueServices) {
        settlements.push(settleIntegratedServiceDay(this.game, this.operationalState, service.id));
      }
      for (const { service, day } of dueThrough) {
        const actuals = throughOperationActualsForDay(this.operationalState, service.throughServiceId, day);
        settlements.push(this.game.settleThroughServiceOperatingDay(service.throughServiceId, actuals));
        clearThroughOperationDay(this.operationalState, service.throughServiceId, day);
      }
      const seenProjects = new Set();
      for (const service of commissioned) {
        if (seenProjects.has(service.projectId) || !projectsWithFinanceDue.has(service.projectId)) continue;
        seenProjects.add(service.projectId);
        this.game.settleOperatingFinanceCalendar(service.id);
      }
      return settlements;
    } catch (error) {
      this.game = new ManagementGame({ countryId: managementCheckpoint.countryId }).restore(managementCheckpoint);
      replaceState(this.operationalState, restoreOperationalState(operationalCheckpoint));
      this.bridge = createMapEngineBridge(this.game, this.operationalState);
      throw error;
    }
  }

  updateServicePolicy(serviceId, input) {
    const result = this.game.updateServicePolicy(serviceId, input);
    const service = this.game.services.find((entry) => entry.id === serviceId);
    const line = service?.operationalLineId === undefined ? null : this.operationalState.lines.find((entry) => String(entry.id) === String(service.operationalLineId));
    if (line) {
      const base = service.trainsPerHour;
      line.frequency = { high: Math.min(30, Math.round(base * 1.5)), medium: Math.round(base), low: Math.max(1, Math.round(base * 0.5)), veryLow: Math.max(1, Math.round(base * 0.25)) };
      service.nominalLineFrequency = structuredClone(line.frequency);
    }
    return result;
  }

  addOperatingCompetitor(serviceId, input) {
    return this.game.addOperatingCompetitor(serviceId, input);
  }

  createOperatingResourcePool(input) {
    return this.game.createOperatingResourcePool(input);
  }

  assignServiceToOperatingResourcePool(serviceId, poolId, options = {}) {
    return this.game.assignServiceToOperatingResourcePool(serviceId, poolId, options);
  }

  removeServiceFromOperatingResourcePool(serviceId) {
    return this.game.removeServiceFromOperatingResourcePool(serviceId);
  }

  operatingResourcePoolReport(poolId = null) {
    return this.game.operatingResourcePoolReport(poolId);
  }

  announceTrackAccessOpportunity(serviceId, input = {}) {
    return this.game.announceTrackAccessOpportunity(serviceId, input);
  }

  solicitTrackAccessOffers(opportunityId) {
    return this.game.solicitTrackAccessOffers(opportunityId);
  }

  awardTrackAccessOffer(opportunityId, offerId) {
    return this.game.awardTrackAccessOffer(opportunityId, offerId);
  }

  setTrackAccessAgreementStatus(agreementId, status) {
    const result = this.game.setTrackAccessAgreementStatus(agreementId, status);
    for (const binding of throughOperationReport(this.operationalState)) this.syncThroughOperationLine(binding.throughServiceId);
    return result;
  }

  trackAccessReport(serviceId = null) {
    return this.game.trackAccessReport(serviceId);
  }

  throughRoutePlanningReport(mapExport) {
    return throughRoutePlanningReport(this.operationalState, {
      pack: this.pack,
      mapExport,
      projects: this.game.projects,
      operationalState: this.operationalState,
      playerOperatorId: this.game.player.id,
    });
  }

  saveThroughRouteSelection(selection, mapExport) {
    return saveThroughRouteSelection(this.operationalState, selection, {
      pack: this.pack,
      mapExport,
      projects: this.game.projects,
      operationalState: this.operationalState,
      playerOperatorId: this.game.player.id,
    });
  }

  removeThroughRouteSelection(key) {
    return removeThroughRouteSelection(this.operationalState, key, this.game.throughServices);
  }

  createThroughServiceFromSelection(selection, mapExport, input = {}, infrastructureCatalog = []) {
    const options = {
      pack: this.pack,
      mapExport,
      projects: this.game.projects,
      operationalState: this.operationalState,
      playerOperatorId: this.game.player.id,
    };
    const built = buildThroughRouteFromSelection(selection, options);
    const service = this.game.createThroughService(built.route, input, infrastructureCatalog);
    saveThroughRouteSelection(this.operationalState, selection, options);
    return { route: structuredClone(built.route), service };
  }

  throughOperationDraft(throughServiceId, mapExport) {
    const service = this.game.requireThroughService(throughServiceId);
    const stored = (this.operationalState.throughRoutePlans ?? []).find((entry) => entry.route.throughRouteId === service.throughRouteId);
    if (!stored) throw new Error(`No saved route geometry for through service ${throughServiceId}`);
    const planning = this.throughRoutePlanningReport(mapExport);
    return buildThroughOperationDraft({
      route: stored.route,
      throughService: service,
      sourceCatalog: planning.catalog,
      operationalState: this.operationalState,
    });
  }

  createThroughService(route, input = {}, infrastructureCatalog = []) {
    return this.game.createThroughService(route, input, infrastructureCatalog);
  }

  reassessThroughService(throughServiceId, route, infrastructureCatalog = []) {
    const result = this.game.reassessThroughService(throughServiceId, route, infrastructureCatalog);
    this.syncThroughOperationLine(throughServiceId);
    return result;
  }

  approveThroughService(throughServiceId) {
    const result = this.game.approveThroughService(throughServiceId);
    this.syncThroughOperationLine(throughServiceId);
    return result;
  }

  setThroughServiceStatus(throughServiceId, status) {
    const result = this.game.setThroughServiceStatus(throughServiceId, status);
    this.syncThroughOperationLine(throughServiceId);
    return result;
  }

  throughServiceReport(throughServiceId = null) {
    return this.game.throughServiceReport(throughServiceId);
  }

  proposeVehicleRetrofit(throughServiceId, input = {}) {
    return this.game.proposeVehicleRetrofit(throughServiceId, input);
  }

  startVehicleRetrofit(programId) {
    return this.game.startVehicleRetrofit(programId);
  }

  authorizeVehicleRetrofitRetest(programId) {
    return this.game.authorizeVehicleRetrofitRetest(programId);
  }

  vehicleRetrofitReport(throughServiceId = null) {
    return this.game.vehicleRetrofitReport(throughServiceId);
  }

  proposeThroughFareAgreement(throughServiceId, input = {}) {
    return this.game.proposeThroughFareAgreement(throughServiceId, input);
  }

  acceptThroughFareAgreement(agreementId, operatorId) {
    return this.game.acceptThroughFareAgreement(agreementId, operatorId);
  }

  fileThroughFareAgreement(agreementId) {
    return this.game.fileThroughFareAgreement(agreementId);
  }

  activateThroughFareAgreement(agreementId) {
    const result = this.game.activateThroughFareAgreement(agreementId);
    this.syncThroughOperationLine(result.throughServiceId);
    return result;
  }

  setThroughFareAgreementStatus(agreementId, status) {
    const result = this.game.setThroughFareAgreementStatus(agreementId, status);
    this.syncThroughOperationLine(result.throughServiceId);
    return result;
  }

  throughFareAgreementReport(throughServiceId = null) {
    return this.game.throughFareAgreementReport(throughServiceId);
  }

  settleThroughServiceOperatingDay(throughServiceId, actuals = {}) {
    const result = this.game.settleThroughServiceOperatingDay(throughServiceId, actuals);
    if (throughOperationBinding(this.operationalState, throughServiceId)) clearThroughOperationDay(this.operationalState, throughServiceId, actuals.operatingDay);
    return result;
  }

  throughOperatingSettlementReport(throughServiceId = null, limit = null) {
    return this.game.throughOperatingSettlementReport(throughServiceId, limit);
  }

  syncThroughOperationLine(throughServiceId) {
    const service = this.game.throughServices.find((entry) => entry.throughServiceId === throughServiceId);
    const activeFare = this.game.throughFareAgreements.some((agreement) => agreement.throughServiceId === throughServiceId && agreement.status === "active");
    return setThroughOperationSuspended(this.operationalState, throughServiceId, service?.status !== "approved" || !activeFare);
  }

  commissionThroughServiceOperation(throughServiceId, input = {}) {
    const service = this.game.requireThroughService(throughServiceId);
    if (service.status !== "approved") throw new Error("직통 서비스 승인이 필요합니다.");
    if (!this.game.throughFareAgreements.some((agreement) => agreement.throughServiceId === throughServiceId && agreement.status === "active")) throw new Error("활성 연락운임 협정이 필요합니다.");
    if (throughOperationBinding(this.operationalState, throughServiceId)) throw new Error("이미 운행선에 연결된 직통 서비스입니다.");
    const model = VEHICLE_MODELS[service.guestModelId];
    if (!model) throw new Error(`Unknown through-service vehicle model ${service.guestModelId}`);
    const checkpoint = snapshotOperationalState(this.operationalState);
    try {
      const trainsPerHour = Math.max(1, Math.round(service.trainsPerHour));
      const line = addLine(this.operationalState, input.stationIds, {
        name: input.name ?? `직통 ${throughServiceId}`,
        color: input.color,
        carsPerTrain: model.cars,
        frequency: input.frequency ?? { high: trainsPerHour, medium: trainsPerHour, low: trainsPerHour, veryLow: trainsPerHour },
      });
      line.throughOperation = true;
      const binding = bindThroughServiceToLine(this.operationalState, service, {
        ...input,
        operationalLineId: line.id,
        startedAtGameMinute: this.game.clock.minute,
      });
      return { line: structuredClone(line), binding };
    } catch (error) {
      replaceState(this.operationalState, restoreOperationalState(checkpoint));
      this.bridge = createMapEngineBridge(this.game, this.operationalState);
      throw error;
    }
  }

  bindThroughServiceOperation(throughServiceId, input = {}) {
    const service = this.game.requireThroughService(throughServiceId);
    if (!this.game.throughFareAgreements.some((agreement) => agreement.throughServiceId === throughServiceId && agreement.status === "active")) throw new Error("활성 연락운임 협정이 필요합니다.");
    const lineId = String(input.operationalLineId);
    if (this.game.services.some((entry) => String(entry.operationalLineId) === lineId)) throw new Error("일반 노선 정산에 연결된 운행선은 직통 정산에 중복 연결할 수 없습니다.");
    return bindThroughServiceToLine(this.operationalState, service, { ...input, startedAtGameMinute: this.game.clock.minute });
  }

  unbindThroughServiceOperation(throughServiceId) {
    return unbindThroughServiceFromLine(this.operationalState, throughServiceId);
  }

  throughOperationReport() {
    return throughOperationReport(this.operationalState);
  }

  evaluate() {
    return evaluateScenario(this.game, this.operationalState);
  }

  save() {
    return saveIntegratedGame({
      game: this.game,
      operationalState: this.operationalState,
      packId: this.pack.manifest.id,
      packVersion: this.pack.manifest.version,
    });
  }

  load(text) {
    const restored = loadIntegratedGame(text, { id: this.pack.manifest.id, version: this.pack.manifest.version });
    this.game = restored.game;
    replaceState(this.operationalState, restored.operationalState);
    this.bridge = createMapEngineBridge(this.game, this.operationalState);
    for (const binding of throughOperationReport(this.operationalState)) this.syncThroughOperationLine(binding.throughServiceId);
    return this;
  }
}
