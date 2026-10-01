import test from "node:test";
import assert from "node:assert/strict";
import {
  applyVehicleOperatingWear,
  advanceVehicleRepairs,
  dispatchVehicleFleet,
  applyInfrastructureOperatingWear,
  Ledger,
  ManagementGame,
  recordOperatingFinanceSettlements,
  recordOperatingPeriod,
  settleProjectOperatingFinance,
  SimulationClock,
} from "../src/management/index.mjs";

function unit(id, mileageKm = 0) {
  return { id, modelId: "medium_4car", status: "available", mileageKm, nextInspectionKm: 30_000, acceptedAt: 0 };
}

test("vehicle kilometres degrade condition and depot capacity turns due mileage into a paid inspection", () => {
  const ledger = new Ledger(1_000_000_000);
  const clock = new SimulationClock(1440);
  const units = [unit("set-1", 29_990), unit("set-2", 10_000)];
  const result = applyVehicleOperatingWear({
    units,
    modelId: "medium_4car",
    trainKm: 200,
    days: 1,
    depot: { id: "depot", capacitySets: 2, inspectionSetsPerDay: 1 },
    ledger,
    clock,
    maxUsedSets: 2,
  });
  assert.deepEqual(result.inspectedUnitIds, ["set-1"]);
  assert.equal(result.inspectionDueUnitIds.length, 0);
  assert.equal(units[0].nextInspectionKm, 60_000);
  assert.ok(units[0].condition <= 1);
  assert.equal(ledger.entries.at(-1).category, "vehicle-inspection");
  assert.equal(-ledger.entries.at(-1).amount, result.inspectionCostJPY);
});

test("a failed diagram uses a reserve set, pays repair cost, and remains unavailable until repair finishes", () => {
  const ledger = new Ledger(10_000_000);
  const clock = new SimulationClock(1440);
  const units = [unit("set-a"), unit("set-b"), unit("set-c")];
  units[0].failureProbability = 30;
  units[1].failureProbability = 0;
  const rolls = [0, 0.8, 0.9];
  const dispatch = dispatchVehicleFleet({
    units,
    modelId: "medium_4car",
    requiredSets: 2,
    rng: { next: () => rolls.shift() ?? 0.9 },
    ledger,
    clock,
    serviceId: "service:reserve",
  });
  assert.equal(dispatch.failures, 1);
  assert.equal(dispatch.operatingSets, 2);
  assert.deepEqual(dispatch.reserveSubstitutionUnitIds, ["set-c"]);
  assert.equal(dispatch.lostServiceSets, 0);
  assert.equal(units[0].status, "repairing");
  assert.equal(units[0].repairDaysRemaining, 3);
  assert.equal(ledger.entries.at(-1).category, "vehicle-failure-repair");
  assert.equal(dispatch.incidents[0].serviceImpact, "reserve-substitution");
  assert.deepEqual(advanceVehicleRepairs(units, 2, 4320), []);
  assert.deepEqual(advanceVehicleRepairs(units, 1, 5760), ["set-a"]);
  assert.equal(units[0].status, "available");
});

test("a failure without a reserve cancels a diagram and is accumulated in the monthly reliability ledger", () => {
  const ledger = new Ledger(10_000_000);
  const clock = new SimulationClock(1440);
  const units = [unit("set-a"), unit("set-b")];
  units[0].failureProbability = 30;
  units[1].failureProbability = 0;
  const rolls = [0, 0.99, 0.9];
  const dispatch = dispatchVehicleFleet({ units, modelId: "medium_4car", requiredSets: 2, rng: { next: () => rolls.shift() ?? 0.9 }, ledger, clock, serviceId: "service:no-reserve" });
  assert.equal(dispatch.operatingSets, 1);
  assert.equal(dispatch.lostServiceSets, 1);
  assert.equal(dispatch.incidents[0].serviceImpact, "cancelled-diagram");
  const reports = [];
  recordOperatingPeriod(reports, {
    service: { id: "service:no-reserve", projectId: "project:1" },
    atMinute: clock.minute,
    days: 1,
    money: { vehicleRepairJPY: dispatch.repairCostJPY },
    reliability: dispatch,
    punctuality: 0.9,
  });
  assert.equal(reports[0].reliability.failures, 1);
  assert.equal(reports[0].reliability.cancelledSetDays, 1);
  assert.equal(reports[0].reliability.averagePunctuality, 0.9);
  assert.equal(reports[0].operatingCostJPY, dispatch.repairCostJPY);
});

test("loan service separates interest and principal while three unpaid months create default", () => {
  const clock = new SimulationClock(3 * 30 * 1440);
  const finance = [{
    id: "loan:1",
    projectId: "project:1",
    kind: "construction-loan",
    annualRate: 0.036,
    futureMonthlyCostJPY: 10_000,
    balanceJPY: 100_000,
    firstDueMonth: 1,
    lastServicedMonth: 0,
    arrearsJPY: 0,
    missedPayments: 0,
    status: "committed",
  }];
  const funded = new Ledger(1_000_000);
  const first = settleProjectOperatingFinance({ financing: finance, projectId: "project:1", throughMonth: 1, ledger: funded, clock });
  assert.equal(first[0].interestJPY, 300);
  assert.equal(first[0].principalPaidJPY, 9_700);
  assert.equal(finance[0].balanceJPY, 90_300);
  assert.equal(finance[0].status, "servicing");

  const unpaidFinance = structuredClone(finance);
  unpaidFinance[0].lastServicedMonth = 0;
  unpaidFinance[0].balanceJPY = 100_000;
  unpaidFinance[0].arrearsJPY = 0;
  unpaidFinance[0].missedPayments = 0;
  const empty = new Ledger(0);
  const missed = settleProjectOperatingFinance({ financing: unpaidFinance, projectId: "project:1", throughMonth: 3, ledger: empty, clock });
  assert.equal(missed.length, 3);
  assert.equal(unpaidFinance[0].status, "default");
  assert.ok(unpaidFinance[0].arrearsJPY > 0);
});

test("track, stations and systems age from calendar time while usage concentrates on railway systems", () => {
  const project = { assets: [
    { id: "station", kind: "station", status: "available" },
    { id: "track", kind: "track-segment", status: "available" },
    { id: "systems", kind: "power-signal", status: "available" },
  ] };
  const result = applyInfrastructureOperatingWear({ project, trainKm: 1_000_000, days: 365 });
  assert.ok(project.assets[0].condition > project.assets[1].condition);
  assert.ok(project.assets[1].condition > project.assets[2].condition);
  assert.ok(result.averageCondition < 1);
  assert.equal(project.assets[0].ageYears, 1);
});

test("monthly report keeps operating profit separate from financing and derives net cash", () => {
  const reports = [];
  const service = { id: "service:1", projectId: "project:1" };
  recordOperatingPeriod(reports, {
    service,
    atMinute: 30 * 1440,
    days: 1,
    passengers: 1_000,
    trainKm: 500,
    money: { fareRevenueJPY: 300_000, energyJPY: 50_000, staffJPY: 100_000, vehicleMaintenanceJPY: 20_000 },
  });
  recordOperatingFinanceSettlements(reports, service, [{ financeId: "loan", projectId: "project:1", month: 1, kind: "construction-loan", paidJPY: 40_000 }]);
  assert.equal(reports[0].operatingIncomeJPY, 300_000);
  assert.equal(reports[0].operatingCostJPY, 170_000);
  assert.equal(reports[0].operatingProfitJPY, 130_000);
  assert.equal(reports[0].financeCostJPY, 40_000);
  assert.equal(reports[0].netCashJPY, 90_000);
});

function operatingGame() {
  const game = new ManagementGame({ countryId: "JP", seed: 17, openingCash: 20_000_000_000 });
  const project = {
    id: "project:operation",
    planId: "plan:operation",
    status: "available",
    stationDeliveryPackages: [],
    stationPackageCoverageComplete: true,
    assets: [{ id: "systems", kind: "power-signal", status: "available" }],
  };
  game.projects.push(project);
  const depot = game.addDepot({ id: "depot:operation", name: "Operating Depot", locationStrategy: "terminal", capacitySets: 3, inspectionSetsPerDay: 1 });
  game.vehicleOrders.push({ id: "fleet:operation", stage: "accepted", modelId: "medium_4car", units: [unit("set-a", 29_990), unit("set-b"), unit("set-c")] });
  game.constructionFinancing.push({
    schema: "transitline.construction-finance/1",
    contractVersion: 1,
    id: "construction-finance:1",
    projectId: project.id,
    kind: "construction-loan",
    raisedJPY: 1_000_000_000,
    netConstructionFundingJPY: 990_000_000,
    feeJPY: 10_000_000,
    annualRate: 0.036,
    termMonths: 240,
    futureMonthlyCostJPY: 5_000_000,
    balanceJPY: 1_000_000_000,
    status: "committed",
    createdAtMinute: 0,
  });
  const service = game.createService({
    id: "service:operation",
    name: "Operation Line",
    projectId: project.id,
    vehicleOrderId: "fleet:operation",
    depotId: depot.id,
    modelId: "medium_4car",
    routeKm: 1,
    stations: 2,
    commercialSpeedKph: 30,
    trainsPerHour: 1,
    staffReady: true,
    timetableReady: true,
    trialOperationPassed: true,
    approvalsValid: true,
    platformLengthM: 100,
  });
  return { game, project, service };
}

test("an open service pays operations, inspections and monthly construction debt into one persistent report", () => {
  const { game, service } = operatingGame();
  const first = game.operateDay(service.id);
  assert.ok(first.money.fareRevenueJPY > 0);
  assert.ok(first.vehicle.inspectionCostJPY > 0);
  for (let day = 1; day < 30; day++) game.operateDay(service.id);
  const reports = game.operatingMonthReport(service.id);
  const debtMonth = reports.find((entry) => entry.financeCostJPY > 0);
  assert.ok(debtMonth);
  assert.ok(debtMonth.operatingCostJPY > 0);
  assert.equal(debtMonth.netCashJPY, debtMonth.operatingProfitJPY - debtMonth.financeCostJPY);
  assert.ok(game.constructionFinanceReport(service.projectId)[0].balanceJPY < 1_000_000_000);
  const restored = ManagementGame.load(game.save());
  assert.deepEqual(restored.operatingMonthReport(), game.operatingMonthReport());
  assert.deepEqual(restored.constructionFinanceReport(), game.constructionFinanceReport());
});

test("monthly calendar still services construction debt when a service has no traffic settlement", () => {
  const { game, service } = operatingGame();
  const before = game.constructionFinanceReport(service.projectId)[0].balanceJPY;
  const month = game.advanceMonth();
  assert.equal(month.operatingFinanceSettlements.length, 1);
  assert.ok(game.constructionFinanceReport(service.projectId)[0].balanceJPY < before);
  const report = game.operatingMonthReport(service.id, 1)[0];
  assert.equal(report.passengers, 0);
  assert.ok(report.financeCostJPY > 0);
});
