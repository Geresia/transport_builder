import test from "node:test";
import assert from "node:assert/strict";
import {
  advanceInfrastructureMaintenancePrograms,
  estimateInfrastructureMaintenance,
  infrastructureMaintenanceImpact,
  Ledger,
  ManagementGame,
  operateServiceDay,
  SimulationClock,
  startInfrastructureMaintenance,
} from "../src/management/index.mjs";

function project() {
  return {
    id: "project:maintenance",
    status: "available",
    stationDeliveryPackages: [],
    stationPackageCoverageComplete: true,
    assets: [
      { id: "station:1", kind: "station", structure: "surface", status: "available", condition: 0.5, ageYears: 28, maintenanceState: "renewal-due" },
      { id: "track:1", kind: "track-segment", structure: "surface", lengthMeters: 2_000, status: "available", condition: 0.7, ageYears: 20, maintenanceState: "attention" },
      { id: "systems:1", kind: "power-signal", status: "available", condition: 0.8, ageYears: 15, maintenanceState: "normal" },
    ],
  };
}

test("maintenance alternatives expose duration, cost, recovery, and operating capacity trade-offs", () => {
  const p = project();
  const night = estimateInfrastructureMaintenance({ project: p, assetIds: ["station:1"], strategyId: "night" });
  const intensive = estimateInfrastructureMaintenance({ project: p, assetIds: ["station:1"], strategyId: "intensive" });
  const renewal = estimateInfrastructureMaintenance({ project: p, assetIds: ["station:1"], strategyId: "renewal" });
  assert.ok(night.totalCostJPY < intensive.totalCostJPY);
  assert.ok(intensive.totalCostJPY < renewal.totalCostJPY);
  assert.ok(night.durationDays < intensive.durationDays);
  assert.ok(intensive.durationDays < renewal.durationDays);
  assert.ok(night.capacityFactor > intensive.capacityFactor);
  assert.ok(intensive.capacityFactor > renewal.capacityFactor);
});

test("an active maintenance programme pays by progress and restores condition only after its real duration", () => {
  const p = project();
  const ledger = new Ledger(10_000_000_000);
  const clock = new SimulationClock(0);
  const program = startInfrastructureMaintenance({ id: "maintenance:1", project: p, assetIds: ["station:1"], strategyId: "intensive", ledger, clock });
  const programs = [program];
  assert.equal(p.assets[0].maintenanceProgramId, program.id);
  assert.equal(infrastructureMaintenanceImpact(programs, p.id).capacityFactor, 0.6);
  clock.advance(44 * 1440);
  const partial = advanceInfrastructureMaintenancePrograms({ programs, projects: [p], throughDay: 44, ledger, clock });
  assert.deepEqual(partial.completedProgramIds, []);
  assert.equal(p.assets[0].condition, 0.5);
  clock.advance(1440);
  const complete = advanceInfrastructureMaintenancePrograms({ programs, projects: [p], throughDay: 45, ledger, clock });
  assert.deepEqual(complete.completedProgramIds, [program.id]);
  assert.equal(program.status, "complete");
  assert.equal(p.assets[0].condition, 0.68);
  assert.equal(p.assets[0].maintenanceState, "attention");
  assert.equal(p.assets[0].maintenanceProgramId, undefined);
  assert.equal(ledger.commitments.has(`infrastructure-maintenance:${program.id}`), false);
});

test("maintenance capacity limits reduce scheduled sets and punctuality", () => {
  const ledger = new Ledger(10_000_000_000);
  const clock = new SimulationClock(1440);
  const units = ["a", "b", "c"].map((id) => ({ id, modelId: "medium_4car", status: "available", mileageKm: 0, nextInspectionKm: 30_000, condition: 1, failureProbability: 0 }));
  const service = {
    id: "service:maintenance",
    status: "open",
    modelId: "medium_4car",
    fleetRequirement: { serviceSets: 2 },
    trainsPerHour: 4,
    dailyDemand: 10_000,
    tripsPerSetDay: 10,
    routeKm: 5,
    averageFare: 200,
    electricityYenPerKwh: 25,
    staffPerSet: 2,
    dailyStaffCost: 40_000,
    maintenanceYenPerCarKm: 60,
    deadheadYenPerSetKm: 1_000,
    dailyInfrastructureCost: 1_000_000,
    dailyPublicPayment: 0,
    dailyAdvertisingRevenue: 0,
  };
  const depot = { id: "depot", capacitySets: 3, inspectionSetsPerDay: 1, deadheadKm: 1, annualLeaseCost: 0 };
  const result = operateServiceDay({ service, units, depot, contract: null, infrastructureImpact: { capacityFactor: 0.5, punctualityPenalty: 0.03, activeProgramIds: ["maintenance:1"] } }, ledger, clock, { next: () => 0.99 });
  assert.equal(result.reliability.requestedSets, 1);
  assert.equal(result.reliability.operatingSets, 1);
  assert.ok(result.punctuality < 0.97);
  assert.deepEqual(result.infrastructureMaintenance.activeProgramIds, ["maintenance:1"]);
});

test("game save/load preserves maintenance progress and capital payments", () => {
  const game = new ManagementGame({ openingCash: 20_000_000_000 });
  const p = project();
  game.projects.push(p);
  game.services.push({ id: "service:maintenance", projectId: p.id });
  const program = game.startInfrastructureMaintenance(p.id, { assetIds: ["track:1"], strategyId: "renewal" });
  assert.ok(game.operatingMonthReport("service:maintenance")[0].capitalCostJPY > 0);
  game.advanceMonth();
  assert.equal(game.infrastructureMaintenanceReport(p.id)[0].elapsedDays, 30);
  const restored = ManagementGame.load(game.save());
  assert.deepEqual(restored.infrastructureMaintenanceReport(), game.infrastructureMaintenanceReport());
  assert.deepEqual(restored.operatingMonthReport(), game.operatingMonthReport());
  assert.equal(restored.infrastructureMaintenanceReport()[0].id, program.id);
});
