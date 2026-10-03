import test from "node:test";
import assert from "node:assert/strict";
import {
  advanceVehicleRetrofitMonth,
  assessTechnicalCompatibility,
  authorizeVehicleRetrofitRetest,
  createVehicleRetrofitProgram,
  estimateVehicleRetrofit,
  Ledger,
  ManagementGame,
  mergeVehicleTechnicalOverrides,
  SimulationClock,
  startVehicleRetrofitProgram,
  vehicleRetrofitRequirements,
} from "../src/management/index.mjs";

function serviceWith(assessment) {
  return {
    throughServiceId: "through-service:retrofit",
    guestModelId: "medium_4car",
    operatorId: "player",
    legs: [{ legId: "leg:retrofit", technicalCompatibility: assessment }],
  };
}

function powerSignalAssessment() {
  return assessTechnicalCompatibility({
    technicalProfileId: "medium_steel",
    vehicleModelId: "medium_4car",
    infrastructureOverrides: {
      collectionSystemId: "third-rail",
      voltageV: 750,
      signalSystemIds: ["line-atc", "line-cbtc"],
    },
  });
}

test("only power and signal incompatibilities produce a retrofit requirement", () => {
  const requirements = vehicleRetrofitRequirements(serviceWith(powerSignalAssessment()));
  assert.equal(requirements.eligible, true);
  assert.deepEqual(requirements.blockers, []);
  assert.equal(requirements.powerSystems.length, 1);
  assert.deepEqual(requirements.signalAlternatives, [{ legId: "leg:retrofit", alternatives: ["line-atc", "line-cbtc"] }]);
});

test("gauge and loading-gauge failures remain physical blockers", () => {
  const assessment = assessTechnicalCompatibility({
    technicalProfileId: "medium_steel",
    vehicleModelId: "medium_4car",
    infrastructureOverrides: { gaugeMm: 1372, carWidthM: 2.5 },
  });
  const requirements = vehicleRetrofitRequirements(serviceWith(assessment));
  assert.equal(requirements.eligible, false);
  assert.deepEqual(requirements.blockers.map((entry) => entry.checkId), ["gauge", "loading-gauge-width"]);
  assert.throws(() => estimateVehicleRetrofit({ throughService: serviceWith(assessment), quantity: 4 }), /cannot solve/);
});

test("unknown infrastructure facts block a price instead of being assumed safe", () => {
  const assessment = assessTechnicalCompatibility({
    technicalProfileId: "medium_steel",
    vehicleModelId: "medium_4car",
    infrastructureOverrides: { signalSystemIds: null },
  });
  const requirements = vehicleRetrofitRequirements(serviceWith(assessment));
  assert.equal(requirements.eligible, "unknown");
  assert.ok(requirements.missingInputs.includes("leg:leg:retrofit:signal-system"));
  assert.throws(() => estimateVehicleRetrofit({ throughService: serviceWith(assessment), quantity: 4 }), /more technical data/);
});

test("the player must select one stated signal alternative and cost is transparent 2026 JPY", () => {
  const service = serviceWith(powerSignalAssessment());
  assert.throws(() => estimateVehicleRetrofit({ throughService: service, quantity: 4 }), /must be selected/);
  assert.throws(() => estimateVehicleRetrofit({ throughService: service, quantity: 4, selectedSignalSystemIds: ["invented"] }), /must be selected/);
  const estimate = estimateVehicleRetrofit({ throughService: service, quantity: 4, selectedSignalSystemIds: ["line-atc"] });
  assert.equal(estimate.currency, "JPY");
  assert.equal(estimate.priceBaseYear, 2026);
  assert.equal(estimate.costBreakdownJPY.powerEngineeringJPY, 900_000_000);
  assert.equal(estimate.costBreakdownJPY.powerEquipmentJPY, 880_000_000);
  assert.equal(estimate.costBreakdownJPY.signalEngineeringJPY, 500_000_000);
  assert.equal(estimate.costBreakdownJPY.signalEquipmentJPY, 560_000_000);
  assert.equal(estimate.costBreakdownJPY.integrationJPY, 350_000_000);
  assert.equal(estimate.costBreakdownJPY.approvalTestingJPY, 380_000_000);
  assert.equal(estimate.totalCostJPY, 4_284_000_000);
  assert.ok(estimate.durationMonths >= 10);
  assert.ok(estimate.approvalFailureProbability > 0);
});

test("start, monthly payments and a successful approval consume the full commitment", () => {
  const clock = new SimulationClock(0);
  const ledger = new Ledger(20_000_000_000);
  const program = createVehicleRetrofitProgram({
    id: "retrofit:1",
    throughService: serviceWith(powerSignalAssessment()),
    quantity: 4,
    selectedSignalSystemIds: ["line-atc"],
    strategyId: "standard",
  });
  startVehicleRetrofitProgram(program, { ledger, clock });
  assert.equal(program.status, "engineering");
  assert.equal(program.paidJPY, Math.round(program.totalCostJPY * 0.2));
  for (let month = 0; month < program.durationMonths; month++) {
    clock.advance(30 * 1440);
    advanceVehicleRetrofitMonth(program, { ledger, clock, rng: { next: () => 0.99 } });
  }
  assert.equal(program.status, "approved");
  assert.equal(program.paidJPY, program.totalCostJPY);
  assert.equal(ledger.commitments.has("vehicle-retrofit:retrofit:1"), false);
  assert.equal(ledger.entries.reduce((sum, entry) => sum - entry.amount, 0), program.totalCostJPY);
});

test("a failed approval can be funded and passed on a deterministic retest", () => {
  const clock = new SimulationClock(0);
  const ledger = new Ledger(30_000_000_000);
  const program = createVehicleRetrofitProgram({ id: "retrofit:2", throughService: serviceWith(powerSignalAssessment()), quantity: 2, selectedSignalSystemIds: ["line-cbtc"] });
  startVehicleRetrofitProgram(program, { ledger, clock });
  for (let month = 0; month < program.durationMonths; month++) {
    clock.advance(30 * 1440);
    advanceVehicleRetrofitMonth(program, { ledger, clock, rng: { next: () => 0 } });
  }
  assert.equal(program.status, "failed-testing");
  const baseTotal = program.totalCostJPY;
  authorizeVehicleRetrofitRetest(program, { ledger, clock });
  assert.equal(program.status, "retesting");
  assert.ok(program.totalCostJPY > baseTotal);
  for (let month = 0; month < 3; month++) {
    clock.advance(30 * 1440);
    advanceVehicleRetrofitMonth(program, { ledger, clock, rng: { next: () => 0.99 } });
  }
  assert.equal(program.status, "approved");
  assert.equal(program.testAttempts, 2);
  assert.equal(program.paidJPY, program.totalCostJPY);
});

test("approved additions merge without deleting or duplicating the vehicle's existing systems", () => {
  const merged = mergeVehicleTechnicalOverrides({
    supportedPowerSystems: [{ collectionSystemId: "overhead", currentSystem: "dc", voltageV: 1500 }],
    supportedSignalSystemIds: ["ats-p"],
  }, {
    supportedPowerSystems: [{ collectionSystemId: "third-rail", currentSystem: "dc", voltageV: 750 }],
    supportedSignalSystemIds: ["line-atc", "ats-p"],
  });
  assert.equal(merged.supportedPowerSystems.length, 2);
  assert.deepEqual(merged.supportedSignalSystemIds, ["ats-p", "line-atc"]);
});

test("invalid quantity, strategy and lifecycle transitions fail without mutation", () => {
  const service = serviceWith(powerSignalAssessment());
  assert.throws(() => estimateVehicleRetrofit({ throughService: service, quantity: 0, selectedSignalSystemIds: ["line-atc"] }), /positive integer/);
  assert.throws(() => estimateVehicleRetrofit({ throughService: service, quantity: 2, selectedSignalSystemIds: ["line-atc"], strategyId: "magic" }), /Unknown/);
  const program = createVehicleRetrofitProgram({ id: "retrofit:3", throughService: service, quantity: 2, selectedSignalSystemIds: ["line-atc"] });
  assert.throws(() => authorizeVehicleRetrofitRetest(program, { ledger: new Ledger(1), clock: new SimulationClock() }), /cannot retest/);
});

function retrofitGame(openingCash = 50_000_000_000, serviceInput = {}) {
  const game = new ManagementGame({ seed: 251, openingCash });
  const route = {
    schema: "transitline.through-route-geometry/1",
    contractVersion: 1,
    throughRouteId: "through-route:retrofit",
    geometryRevision: "through-route-revision:retrofit:1",
    sourcePackId: "test",
    legs: [
      { legId: "leg:retrofit:1", sourceKind: "external", connectedProjectId: null, externalNetworkId: "network:test", externalLineId: "line:test", infrastructureOwnerId: "player" },
      { legId: "leg:retrofit:2", sourceKind: "external", connectedProjectId: null, externalNetworkId: "network:test", externalLineId: "line:test", infrastructureOwnerId: "player" },
    ],
    handovers: [{ handoverId: "handover:retrofit", physicalConnection: true, connectionState: "joined" }],
  };
  const technicalSpecification = {
    runningSystemId: "steel-wheel", gaugeMm: 1435, carWidthM: 2.8, maxAxleLoadTonnes: 16,
    collectionSystemId: "third-rail", currentSystem: "dc", voltageV: 750, minimumCurveRadiusMeters: 160,
    maxGradientPermille: 35, signalSystemIds: ["line-atc"], platformHeightMm: 1100, doorLayoutId: "4-door-20m",
    minCars: 4, maxCars: 10, maintenanceSystemId: "medium_steel",
  };
  const catalog = {
    schema: "transitline.external-infrastructure-catalog/1",
    packId: "test",
    packVersion: "1",
    entries: route.legs.map((leg) => ({
      legId: leg.legId,
      throughRouteId: route.throughRouteId,
      routeGeometryRevision: route.geometryRevision,
      externalNetworkId: leg.externalNetworkId,
      externalLineId: leg.externalLineId,
      specificationId: "specification:retrofit",
      specificationRevision: "specification-revision:retrofit:1",
      infrastructureOwnerId: "player",
      technicalProfileId: null,
      technicalSpecification,
      notApplicable: [],
      status: "available",
      capacityTrainsPerHour: 20,
    })),
  };
  const service = game.createThroughService(route, {
    operatorId: "player",
    guestModelId: "medium_4car",
    trainsPerHour: 4,
    ...serviceInput,
  }, catalog);
  return { game, route, catalog, service };
}

test("a proposal spends no cash or RNG and callers cannot inject approved capabilities", () => {
  const { game, service } = retrofitGame(50_000_000_000, {
    vehicleTechnicalOverrides: {
      supportedPowerSystems: [{ collectionSystemId: "third-rail", currentSystem: "dc", voltageV: 750 }],
      supportedSignalSystemIds: ["line-atc"],
    },
    approvedRetrofitProgramIds: ["vehicle-retrofit:forged"],
  });
  assert.deepEqual(service.vehicleTechnicalOverrides, {});
  assert.deepEqual(service.approvedRetrofitProgramIds, []);
  const cashBefore = game.ledger.cash;
  const rngBefore = game.snapshot().rngState;
  game.proposeVehicleRetrofit(service.throughServiceId, { quantity: 4, selectedSignalSystemIds: ["line-atc"] });
  assert.equal(game.ledger.cash, cashBefore);
  assert.deepEqual(game.snapshot().rngState, rngBefore);
});

test("the player cannot fund a competitor-operated vehicle retrofit", () => {
  const { game, service } = retrofitGame(50_000_000_000, { operatorId: "competitor:metro" });
  const before = game.snapshot();
  assert.throws(
    () => game.proposeVehicleRetrofit(service.throughServiceId, { quantity: 4, selectedSignalSystemIds: ["line-atc"] }),
    /player-operated/,
  );
  assert.deepEqual(game.snapshot(), before);
});

test("ManagementGame funds, saves, advances and applies an approved retrofit before reassessment", () => {
  const { game, route, catalog, service } = retrofitGame();
  assert.equal(service.assessment.verdict, "impossible");
  const program = game.proposeVehicleRetrofit(service.throughServiceId, { quantity: 4, selectedSignalSystemIds: ["line-atc"] });
  game.startVehicleRetrofit(program.id);
  const restored = ManagementGame.load(game.save());
  const restoredProgram = restored.requireVehicleRetrofit(program.id);
  assert.equal(restoredProgram.status, "engineering");
  restoredProgram.approvalFailureProbability = 0;
  for (let month = 0; month < restoredProgram.durationMonths; month++) restored.advanceMonth();
  assert.equal(restoredProgram.status, "approved");
  const pending = restored.requireThroughService(service.throughServiceId);
  assert.equal(pending.status, "assessed");
  assert.equal(pending.retrofitReassessmentRequired, true);
  assert.deepEqual(pending.approvedRetrofitProgramIds, [program.id]);
  assert.equal(pending.vehicleTechnicalOverrides.supportedPowerSystems.length, 2);
  const beforeDirectApply = restored.snapshot();
  assert.throws(() => restored.applyApprovedVehicleRetrofit(program.id), /active game transaction/);
  assert.deepEqual(restored.snapshot(), beforeDirectApply);
  const reassessed = restored.reassessThroughService(service.throughServiceId, route, catalog);
  assert.equal(reassessed.assessment.verdict, "possible");
  assert.equal(reassessed.retrofitReassessmentRequired, undefined);
  assert.ok(reassessed.legs.every((leg) => leg.technicalCompatibility.verdict === "possible"));
});

test("insufficient retrofit funding rolls the entire game transaction back", () => {
  const { game, service } = retrofitGame(1_000_000_000);
  const program = game.proposeVehicleRetrofit(service.throughServiceId, { quantity: 4, selectedSignalSystemIds: ["line-atc"] });
  const before = game.snapshot();
  assert.throws(() => game.startVehicleRetrofit(program.id), /Insufficient available cash/);
  assert.deepEqual(game.snapshot(), before);
});

test("older saves restore an empty retrofit collection and a monotonic sequence", () => {
  const game = new ManagementGame({ seed: 257 });
  const snapshot = game.snapshot();
  delete snapshot.vehicleRetrofitPrograms;
  delete snapshot.nextVehicleRetrofitSequence;
  const restored = new ManagementGame().restore(snapshot);
  assert.deepEqual(restored.vehicleRetrofitPrograms, []);
  assert.equal(restored.nextVehicleRetrofitSequence, 1);
});
