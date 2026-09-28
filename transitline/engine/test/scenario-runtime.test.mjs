import test from "node:test";
import assert from "node:assert/strict";
import { buildMapExport } from "../src/map/plan-geometry.mjs";
import { planningDefaults, ScenarioRuntime, stablePlanKey } from "../src/scenario-runtime.mjs";
import { createState } from "../src/state.mjs";

function pack() {
  const points = Array.from({ length: 7 }, (_, index) => ({
    id: `point-${index + 1}`,
    name: `Point ${index + 1}`,
    location: [139 + index * 0.075, 35],
    residents: 7_000 + index * 500,
    jobs: 9_000 - index * 400,
  }));
  return {
    manifest: { id: "runtime", version: "1", data: { license: "test", attribution: [] } },
    demand: {
      model: "gravity",
      points,
      attractors: [],
    },
  };
}

function plan(source) {
  const options = planningDefaults("medium_steel", "elevated", "island");
  return buildMapExport({
    pack: source,
    mode: "scratch",
    drawnLines: [{
      key: stablePlanKey(source.manifest.id, source.demand.points.map((point) => point.id)),
      name: "Runtime Line",
      vertices: source.demand.points.map((point) => ({ location: point.location, demandNodeId: point.id, structure: options.structure, depthMeters: options.depthMeters, platformType: options.platformType, platformLengthM: options.platformLengthM })),
      legs: source.demand.points.slice(1).map(() => ({ structureHint: options.structure })),
    }],
  }).plans[0];
}

test("scenario runtime connects a map plan to suspended construction, fleet, commissioning and save", () => {
  const source = pack();
  const state = createState(source);
  const runtime = new ScenarioRuntime({ pack: source, operationalState: state, networkMode: "scratch", seed: 901 });
  const geometry = plan(source);
  assert.throws(() => runtime.submit(geometry, "medium_steel"), /사업공고/);
  const opportunity = runtime.viewOpportunity();
  assert.equal(opportunity.viewedAt, 0);
  assert.equal(opportunity.scope.minimumRouteKm, 40);
  assert.throws(() => runtime.submit(geometry, "medium_steel"), /Bid/);
  runtime.researchOpportunity(2);
  const decision = runtime.decideBid("bid", runtime.scenarioOpportunity().baselineAnnualCost * 0.9);
  assert.equal(decision.decision, "bid");
  const submitted = runtime.submit(geometry, "medium_steel");
  assert.equal(submitted.status, "assessed");
  assert.throws(() => runtime.approveAndCreate(geometry.planId), /수주/);
  const bid = runtime.submitTenderProposal(geometry.planId);
  assert.ok(bid.technicalScore >= runtime.scenarioOpportunity().minimumTechnical);
  const evaluated = runtime.evaluateTender();
  if (evaluated.status === "single-bid-review") runtime.reviewSingleBid(true);
  assert.equal(runtime.scenarioOpportunity().preferredBidderId, runtime.game.player.id);
  const award = runtime.concludeAward();
  assert.equal(award.operatorId, runtime.game.player.id);
  runtime.approveAndCreate(geometry.planId);
  runtime.contract(geometry.planId);
  const depotPreview = runtime.evaluateDepotCandidate(geometry.planId);
  assert.equal(depotPreview.assessment.feasibility, "feasible");
  assert.ok(depotPreview.operatorCapex > 0);
  assert.throws(() => runtime.evaluateDepotCandidate(geometry.planId, { depotSite: { ...depotPreview.site, connectedPlanId: "plan:other" } }), /현재 계획 노선/);
  const preparation = runtime.prepareFleet(geometry.planId);
  assert.equal(preparation.depot.status, "underConstruction");
  assert.equal(preparation.depot.entryRouteAvailable, false);
  assert.equal(preparation.usedEstimatedSite, true);
  assert.equal(preparation.schedule.projectId, runtime.projectForPlan(geometry.planId).id);
  assert.equal(runtime.constructionSchedule(geometry.planId).id, preparation.schedule.id);
  assert.equal(runtime.report().schedules.length, 1);
  const constructionSite = {
    schema: "transitline.construction-site-geometry/1",
    contractVersion: 1,
    constructionSiteId: "construction:runtime-first-segment",
    kind: "viaduct",
    name: "첫 구간 고가 공구",
    connectedPlanId: geometry.planId,
    connectedSegmentIds: [geometry.segments[0].id],
    connectedStationId: null,
    connectedDepotSiteId: null,
    polygon: null,
    unknown: ["polygon"],
    unknownReasons: { polygon: "test-fixture" },
    warnings: [],
  };
  runtime.configureConstructionPackages(geometry.planId, {
    schema: "transitline.construction-export/1",
    packId: source.manifest.id,
    packVersion: source.manifest.version,
    sites: [constructionSite],
    warnings: [],
  }, {
    schema: "transitline.construction-selection/1",
    contractVersion: 1,
    packId: source.manifest.id,
    constructionSiteId: constructionSite.constructionSiteId,
    kind: "workArea",
    candidateId: "work:test",
    facts: { polygon: [[139, 35], [139.001, 35], [139.001, 35.001]], areaSquareMeters: 500 },
  });
  runtime.recordConstructionMarker(geometry.planId, { constructionSiteId: constructionSite.constructionSiteId, kind: "complaint", message: "야간공사 협의" });
  assert.equal(runtime.report().constructionPackages[constructionSite.constructionSiteId].kind, "viaduct");
  assert.equal(runtime.report().constructionMarkers[0].kind, "complaint");

  runtime.advanceMonths(1);
  const project = runtime.projectForPlan(geometry.planId);
  const progress = project.progress;
  runtime.suspend(geometry.planId, "resident consultation");
  assert.equal(runtime.constructionSchedule(geometry.planId).status, "suspended");
  runtime.advanceMonths(2);
  assert.equal(project.status, "suspended");
  assert.equal(project.progress, progress, "a suspended project must not build or pay progress claims");
  runtime.resume(geometry.planId);

  for (let month = 0; month < 240; month++) {
    runtime.advanceMonths(1);
    if (project.status === "available"
      && runtime.game.vehicleOrders[0].stage === "accepted"
      && runtime.game.depots[0].status === "secured"
      && runtime.constructionSchedule(geometry.planId).ready) break;
  }
  assert.equal(project.status, "available");
  assert.equal(runtime.game.vehicleOrders[0].stage, "accepted");
  assert.equal(runtime.game.depots[0].status, "secured");
  assert.equal(runtime.game.depots[0].entryRouteAvailable, true);
  assert.equal(runtime.constructionSchedule(geometry.planId).ready, true);

  const conflict = project.assets.find((asset) => asset.kind === "station");
  state.stations.set(conflict.id, { id: conflict.id, name: "Conflict", location: conflict.location });
  assert.throws(() => runtime.open(geometry.planId, { color: "#e63946" }), /already exists/);
  assert.equal(runtime.game.services.length, 0, "failed commissioning must also roll back service creation");
  assert.equal(runtime.projectForPlan(geometry.planId).commissionedLineId, undefined);
  state.stations.delete(conflict.id);

  const opened = runtime.open(geometry.planId, { color: "#e63946" });
  assert.equal(opened.service.status, "open");
  assert.equal(state.lines.filter((line) => line.owned).length, 1);
  assert.equal(runtime.report().plans[0].status, "commissioned");

  const save = runtime.save();
  const restoredState = createState(source);
  const restored = new ScenarioRuntime({ pack: source, operationalState: restoredState, networkMode: "scratch" }).load(save);
  assert.equal(restored.game.projects[0].commissionedLineId, restoredState.lines.find((line) => line.owned).id);
  assert.equal(restored.constructionSchedule(geometry.planId).ready, true);
  assert.equal(restored.report().constructionMarkers[0].message, "야간공사 협의");
  assert.equal(restoredState.trackSegments.length, source.demand.points.length - 1);
});

test("stable editor plan keys ignore route drawing direction", () => {
  assert.equal(stablePlanKey("p", ["a", "b", "c"]), stablePlanKey("p", ["c", "b", "a"]));
  assert.notEqual(stablePlanKey("p", ["a", "b"]), stablePlanKey("p", ["a", "c"]));
});

test("JP and KR scenario announcements expose their real procedural context", () => {
  const source = pack();
  const jp = new ScenarioRuntime({ pack: source, operationalState: createState(source), countryId: "JP", networkMode: "scratch" });
  const kr = new ScenarioRuntime({ pack: source, operationalState: createState(source), countryId: "KR", networkMode: "scratch" });
  assert.match(jp.scenarioOpportunity().processLabel, /허가/);
  assert.match(kr.scenarioOpportunity().processLabel, /도시철도/);
  assert.notEqual(jp.scenarioOpportunity().authority, kr.scenarioOpportunity().authority);
  assert.equal(jp.opportunityViewed(), false);
  jp.viewOpportunity();
  assert.equal(jp.opportunityViewed(), true);
  const cashBefore = jp.game.ledger.cash;
  const basic = jp.researchOpportunity(1);
  assert.equal(basic.cost, 150_000_000);
  assert.equal(basic.capitalCostRange.length, 2);
  assert.equal(jp.game.ledger.cash, cashBefore - basic.cost);
  const detailed = jp.researchOpportunity(2);
  assert.equal(detailed.cost, 450_000_000);
  assert.equal(detailed.confidence, "detailed-due-diligence");
  assert.ok(detailed.capitalCostRange[1] - detailed.capitalCostRange[0] < basic.capitalCostRange[1] - basic.capitalCostRange[0]);
  assert.throws(() => jp.researchOpportunity(2), /increase/);
  const declined = jp.decideBid("no-bid");
  assert.equal(declined.decision, "no-bid");
  assert.equal(jp.scenarioOpportunity().status, "declined");
  assert.throws(() => jp.decideBid("bid"), /이미/);
});

function stationSiteFor(geometry, station, index) {
  return {
    schema: "transitline.station-site-geometry/1",
    contractVersion: 1,
    stationSiteId: `site:${station.id}`,
    name: station.name ?? station.id,
    connectedPlanId: geometry.planId,
    connectedStationId: station.id,
    connectedSegmentIds: [],
    planTerminalEnd: index === 0 ? "start" : index === geometry.stationCandidates.length - 1 ? "end" : null,
    planHints: { structure: "elevated", platformType: "island", depthMeters: 0 },
    bodyLengthMeters: 100,
    bodyWidthMeters: 24,
    bodyAreaSquareMeters: 2_400,
    bodyDimensionBasis: { length: "player", width: "player" },
    plannedDepthMeters: 0,
    roadWidthMeters: 40,
    intersectedBuildingCount: 0,
    dataQuality: "high",
    entranceCandidates: [{
      entranceId: `entrance:${station.id}`,
      location: station.location,
      collidingBuildingCount: 0,
      waterOverlapCount: 0,
      roadside: true,
      roadsideDistanceMeters: 0,
      nearestRoad: { roadClass: "major", distanceMeters: 0 },
      landUses: [],
      publicLand: null,
      publicLandEvidence: null,
      distanceToBodyMeters: 10,
      dataQuality: "high",
      unknown: ["publicLand"],
      unknownReasons: { publicLand: "no-parcel-data" },
    }],
    transferCandidates: [],
    demandAccess: [],
    workAreaCandidates: [{
      workAreaId: `work:${station.id}`,
      slot: "side-right",
      areaSquareMeters: 1_200,
      intersectedBuildingCount: 0,
      waterOverlapCount: 0,
      roadsThrough: { highway: 0, major: 0, minor: 0 },
      unknown: [],
      unknownReasons: {},
    }],
    extensionSpace: [
      { end: "forward", freeLengthMeters: 200, unknown: [], unknownReasons: {} },
      { end: "backward", freeLengthMeters: 200, unknown: [], unknownReasons: {} },
    ],
    constraintUnknown: [],
    unknown: [],
    unknownReasons: {},
  };
}

test("scenario runtime takes every mapped station through design, contractor award and master-cost integration", () => {
  const source = pack();
  const state = createState(source);
  const runtime = new ScenarioRuntime({ pack: source, operationalState: state, networkMode: "scratch", seed: 1201 });
  const geometry = plan(source);
  const project = runtime.game.createProject(geometry, "medium_steel");

  for (const [index, station] of geometry.stationCandidates.entries()) {
    const site = stationSiteFor(geometry, station, index);
    const deliveryPackage = runtime.designStation(geometry.planId, site, {
      structureId: "elevated",
      layoutId: "island-2track",
      selectedEntranceIds: [site.entranceCandidates[0].entranceId],
      selectedWorkAreaId: site.workAreaCandidates[0].workAreaId,
      workAreaSecured: true,
      utilityConflictLevel: "low",
      groundwaterRisk: "low",
      softGroundRisk: "low",
      existingRailwayProximity: "none",
    });
    if (deliveryPackage.unresolvedConditions.length) runtime.resolveStationDesign(deliveryPackage.id, deliveryPackage.unresolvedConditions.map((entry) => ({ code: entry.code, action: "detailed design resolved" })));
    const tender = runtime.tenderStation(deliveryPackage.id);
    runtime.awardStation(deliveryPackage.id, tender.ranking[0].id);
  }

  const before = project.estimate.totalP50;
  const summary = runtime.stationDeliverySummary(geometry.planId);
  assert.equal(summary.expected, 7);
  assert.equal(summary.awarded, 7);
  const replacement = runtime.integrateStations(geometry.planId);
  assert.equal(project.stationPackageCoverageComplete, true);
  assert.equal(project.estimate.totalP50, Math.round(before - replacement.legacyP50 + replacement.awardedP50));
  runtime.contract(geometry.planId);
  assert.equal(project.status, "contracted");
  assert.ok(project.stationDeliveryPackages.every((entry) => entry.status === "underConstruction"));
  const cancelled = runtime.cancel(geometry.planId);
  assert.ok(cancelled.sunkCost > 0);
  assert.equal(project.status, "cancelled");
  assert.ok(runtime.stationPackagesForPlan(geometry.planId).every((entry) => entry.status === "cancelled"));
});
