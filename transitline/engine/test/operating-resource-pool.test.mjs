import test from "node:test";
import assert from "node:assert/strict";
import {
  ManagementGame,
  createOperatingResourcePool,
  dispatchVehicleFleet,
  operatingResourcePoolReport,
} from "../src/management/index.mjs";

function unit(id, modelId = "medium_4car") {
  return { id, modelId, status: "available", mileageKm: 0, nextInspectionKm: 30_000, condition: 1 };
}

function setupGame({ staff = 10, units = 5 } = {}) {
  const game = new ManagementGame({ seed: 8112, openingCash: 100_000_000_000 });
  for (const id of ["a", "b"]) game.projects.push({ id: `project:${id}`, status: "available", stationDeliveryPackages: [], stationPackageCoverageComplete: true, assets: [{ id: `systems:${id}`, kind: "power-signal", status: "available" }] });
  game.depots.push({ id: "depot:shared", name: "Shared depot", status: "secured", locationStrategy: "shared", capacitySets: 5, inspectionSetsPerDay: 2, entryRouteAvailable: true, annualLeaseCost: 365_000_000, annualAncillaryRevenue: 36_500_000, deadheadKm: 4 });
  game.vehicleOrders.push({ id: "fleet:shared", modelId: "medium_4car", stage: "accepted", units: Array.from({ length: units }, (_, index) => unit(`set:${index + 1}`)) });
  for (const id of ["a", "b"]) game.createService({ id: `service:${id}`, projectId: `project:${id}`, vehicleOrderId: "fleet:shared", depotId: "depot:shared", modelId: "medium_4car", routeKm: 1, stations: 2, commercialSpeedKph: 30, trainsPerHour: 1, staffReady: true, timetableReady: true, trialOperationPassed: true, approvalsValid: true, platformLengthM: 100 });
  game.createOperatingResourcePool({ id: "pool:city", name: "City shared operations", vehicleOrderIds: ["fleet:shared"], depotIds: ["depot:shared"], totalStaffConcurrent: staff });
  return game;
}

test("resource pool validates referenced fleets, depots, and staff", () => {
  assert.throws(() => createOperatingResourcePool({ id: "bad", vehicleOrderIds: ["missing"], depotIds: ["depot"], totalStaffConcurrent: 1 }), /Unknown vehicle order/);
  assert.throws(() => createOperatingResourcePool({ id: "bad", vehicleOrderIds: ["fleet"], depotIds: ["missing"], totalStaffConcurrent: 1 }, { vehicleOrders: [{ id: "fleet" }] }), /Unknown depot/);
  assert.throws(() => createOperatingResourcePool({ id: "bad", vehicleOrderIds: ["fleet"], depotIds: ["depot"], totalStaffConcurrent: -1 }, { vehicleOrders: [{ id: "fleet" }], depots: [{ id: "depot" }] }), /non-negative/);
});

test("two services receive stable exclusive primary sets and share only the reserve", () => {
  const game = setupGame();
  game.assignServiceToOperatingResourcePool("service:a", "pool:city", { priority: 10 });
  const report = game.assignServiceToOperatingResourcePool("service:b", "pool:city", { priority: 5 });
  const a = report.assignments.find((entry) => entry.serviceId === "service:a");
  const b = report.assignments.find((entry) => entry.serviceId === "service:b");
  assert.equal(a.primaryUnitIds.length, 1);
  assert.equal(b.primaryUnitIds.length, 1);
  assert.notEqual(a.primaryUnitIds[0], b.primaryUnitIds[0]);
  assert.equal(report.sharedReserveUnitIds.length, 3);
  const revision = report.revision;
  const stateBeforeReport = structuredClone(game.operatingResourcePools[0]);
  const reread = game.operatingResourcePoolReport("pool:city");
  assert.equal(reread.revision, revision, "read-only reports do not invent revisions");
  assert.deepEqual(reread.assignments, report.assignments);
  assert.deepEqual(game.operatingResourcePools[0], stateBeforeReport, "reporting does not mutate saved pool state");
});

test("priority allocates finite concurrent staff and reports the constrained line", () => {
  const game = setupGame({ staff: 2.5 });
  game.assignServiceToOperatingResourcePool("service:b", "pool:city", { priority: 1 });
  const report = game.assignServiceToOperatingResourcePool("service:a", "pool:city", { priority: 20 });
  const high = report.assignments.find((entry) => entry.serviceId === "service:a");
  const low = report.assignments.find((entry) => entry.serviceId === "service:b");
  assert.equal(high.maximumStaffedSets, 1);
  assert.equal(low.maximumStaffedSets, 0);
  assert.ok(low.shortfalls.includes("staff-shortfall"));
  assert.ok(report.warnings.includes("staff-shortfall"));
});

test("same-day dispatch lock prevents one shared reserve from serving two lines", () => {
  const game = setupGame({ units: 3 });
  game.assignServiceToOperatingResourcePool("service:a", "pool:city", { priority: 10 });
  game.assignServiceToOperatingResourcePool("service:b", "pool:city", { priority: 5 });
  const a = game.resolveOperatingResources("service:a");
  const b = game.resolveOperatingResources("service:b");
  const common = a.units.find((entry) => b.units.some((candidate) => candidate.id === entry.id) && !a.preferredUnitIds.includes(entry.id) && !b.preferredUnitIds.includes(entry.id));
  assert.ok(common);
  const ledger = { post() {} };
  const clock = { minute: 1440 };
  const rng = { next: () => 1 };
  const first = dispatchVehicleFleet({ units: a.units, modelId: "medium_4car", requiredSets: 2, rng, ledger, clock, serviceId: "service:a", preferredUnitIds: a.preferredUnitIds, operatingDay: 1 });
  const second = dispatchVehicleFleet({ units: b.units, modelId: "medium_4car", requiredSets: 2, rng, ledger, clock, serviceId: "service:b", preferredUnitIds: b.preferredUnitIds, operatingDay: 1 });
  assert.ok(first.operatingUnitIds.includes(common.id));
  assert.ok(!second.operatingUnitIds.includes(common.id));
  assert.equal(second.lostServiceSets, 1);
});

test("a failed primary uses a shared reserve and records its service", () => {
  const units = [unit("primary"), unit("reserve")];
  units[0].failureProbability = 30;
  const rolls = [0, 0, 1];
  const result = dispatchVehicleFleet({ units, modelId: "medium_4car", requiredSets: 1, rng: { next: () => rolls.shift() ?? 1 }, ledger: { post() {} }, clock: { minute: 2880 }, serviceId: "service:a", preferredUnitIds: ["primary"], operatingDay: 2 });
  assert.deepEqual(result.reserveSubstitutionUnitIds, ["reserve"]);
  assert.equal(units[1].lastDispatchedDay, 2);
  assert.equal(units[1].lastDispatchedServiceId, "service:a");
  assert.equal(units[0].repairDaysRemaining, 1);
  dispatchVehicleFleet({ units, modelId: "medium_4car", requiredSets: 0, rng: { next: () => 1 }, ledger: { post() {} }, clock: { minute: 2880 }, serviceId: "service:b", operatingDay: 2 });
  assert.equal(units[0].repairDaysRemaining, 1, "another line cannot consume a repair day on the same calendar day");
});

test("frequency revision rebalances primary demand and pool state survives save/load", () => {
  const game = setupGame({ units: 5, staff: 20 });
  game.assignServiceToOperatingResourcePool("service:a", "pool:city", { priority: 10 });
  game.assignServiceToOperatingResourcePool("service:b", "pool:city", { priority: 5 });
  const before = game.operatingResourcePoolReport("pool:city");
  game.updateServicePolicy("service:a", { trainsPerHour: 20 });
  const after = game.operatingResourcePoolReport("pool:city");
  assert.ok(after.assignments.find((entry) => entry.serviceId === "service:a").requestedPrimarySets > before.assignments.find((entry) => entry.serviceId === "service:a").requestedPrimarySets);
  assert.ok(after.warnings.includes("primary-fleet-shortfall"));
  const restored = ManagementGame.load(game.save());
  assert.deepEqual(restored.operatingResourcePoolReport("pool:city"), after);
  assert.equal(restored.services.find((entry) => entry.id === "service:a").resourcePoolId, "pool:city");
});

test("pooled operation obeys a zero-staff allocation while legacy service remains compatible", () => {
  const pooled = setupGame({ staff: 0 });
  pooled.assignServiceToOperatingResourcePool("service:a", "pool:city", { priority: 1 });
  const settlement = pooled.operateDay("service:a");
  assert.equal(settlement.reliability.requestedSets, 0);
  assert.equal(settlement.resourcePoolId, "pool:city");
  assert.ok(settlement.resourceWarnings.includes("staff-shortfall"));

  const legacy = setupGame();
  const legacySettlement = legacy.operateDay("service:a");
  assert.equal(legacySettlement.resourcePoolId, null);
  assert.ok(legacySettlement.reliability.requestedSets > 0);
});

test("pure pool report exposes depot storage and inspection capacity", () => {
  const pool = createOperatingResourcePool({ id: "pool", vehicleOrderIds: ["fleet"], depotIds: ["depot"], totalStaffConcurrent: 4 }, {
    vehicleOrders: [{ id: "fleet", modelId: "medium_4car", units: [unit("u1"), unit("u2")] }],
    depots: [{ id: "depot", capacitySets: 1, inspectionSetsPerDay: 1 }],
  });
  const report = operatingResourcePoolReport(pool, {
    services: [],
    vehicleOrders: [{ id: "fleet", modelId: "medium_4car", units: [unit("u1"), unit("u2")] }],
    depots: [{ id: "depot", capacitySets: 1, inspectionSetsPerDay: 1 }],
  });
  assert.equal(report.capacity.depotStorageShortfallSets, 1);
  assert.equal(report.capacity.totalInspectionSetsPerDay, 1);
  assert.ok(report.warnings.includes("depot-storage-shortfall"));
});
