import test from "node:test";
import assert from "node:assert/strict";
import {
  applyServicePolicy,
  createOperatingCompetitor,
  electricityPriceForPeriod,
  ManagementGame,
  serviceDemandMultiplier,
  settleOperatingMarketDay,
} from "../src/management/index.mjs";

function service() {
  return { id: "service:policy", averageFare: 220, trainsPerHour: 4, dailyDemand: 40_000, baseAverageFare: 220, baseTrainsPerHour: 4, baseDailyDemand: 40_000 };
}

test("fare and frequency policies change forecast demand in opposite directions", () => {
  const base = service();
  assert.equal(serviceDemandMultiplier(base, 4), 1);
  const expensive = { ...base, averageFare: 440 };
  const frequent = { ...base, trainsPerHour: 8 };
  assert.ok(serviceDemandMultiplier(expensive, 4) < 1);
  assert.ok(serviceDemandMultiplier(frequent, 8) > 1);
});

test("policy revisions preserve history and apply staffing and electricity choices", () => {
  const target = service();
  const revision = applyServicePolicy(target, { fareJPY: 260, trainsPerHour: 6, staffingPolicyId: "resilient", electricityContractId: "fixed" }, { atMinute: 100 });
  assert.equal(revision.revision, 1);
  assert.equal(target.averageFare, 260);
  assert.equal(target.trainsPerHour, 6);
  assert.equal(target.staffPerSet, 3.2);
  assert.equal(target.electricityYenPerKwh, 28);
  assert.equal(target.policyHistory.length, 1);
  assert.throws(() => applyServicePolicy(target, { fareJPY: 50 }), /between JPY 100/);
});

test("fixed electricity is stable while spot electricity follows bounded deterministic prices", () => {
  assert.equal(electricityPriceForPeriod({ electricityContractId: "fixed" }, { next: () => 0 }), 28);
  const low = electricityPriceForPeriod({ electricityContractId: "spot" }, { next: () => 0 });
  const high = electricityPriceForPeriod({ electricityContractId: "spot" }, { next: () => 1 });
  assert.ok(low < 24);
  assert.ok(high > 24);
  assert.ok(high < 30);
});

test("operating competitors divide one addressable market by fare, frequency, and punctuality", () => {
  const target = service();
  const cheapFrequent = createOperatingCompetitor({ id: "rival:a", fareJPY: 180, trainsPerHour: 6, punctuality: 0.98 });
  const costlySparse = createOperatingCompetitor({ id: "rival:b", fareJPY: 400, trainsPerHour: 2, punctuality: 0.9 });
  const market = settleOperatingMarketDay({ service: target, competitors: [cheapFrequent, costlySparse], addressableDemand: 60_000, playerPunctuality: 0.97, routeKm: 10 });
  assert.ok(market.playerShare > 0 && market.playerShare < 1);
  assert.ok(market.competitors[0].share > market.competitors[1].share);
  assert.equal(cheapFrequent.totals.passengers, market.competitors[0].passengers);
  assert.equal(market.competitors.reduce((sum, entry) => sum + entry.share, market.playerShare), 1);
});

test("game policy and competitors survive save/load and expose fleet shortfall", () => {
  const game = new ManagementGame({ openingCash: 100_000_000_000 });
  game.projects.push({ id: "project:policy", status: "available", stationDeliveryPackages: [], stationPackageCoverageComplete: true, assets: [{ id: "systems", kind: "power-signal", status: "available" }] });
  game.depots.push({ id: "depot:policy", status: "secured", capacitySets: 2, inspectionSetsPerDay: 1, entryRouteAvailable: true, annualLeaseCost: 0, deadheadKm: 1 });
  game.vehicleOrders.push({ id: "fleet:policy", stage: "accepted", units: [{ id: "set:1", modelId: "medium_4car", status: "available", mileageKm: 0, nextInspectionKm: 30_000 }, { id: "set:2", modelId: "medium_4car", status: "available", mileageKm: 0, nextInspectionKm: 30_000 }] });
  const opened = game.createService({ id: "service:policy", projectId: "project:policy", vehicleOrderId: "fleet:policy", depotId: "depot:policy", modelId: "medium_4car", routeKm: 5, stations: 3, commercialSpeedKph: 30, trainsPerHour: 1, staffReady: true, timetableReady: true, trialOperationPassed: true, approvalsValid: true, platformLengthM: 100 });
  const result = game.updateServicePolicy(opened.id, { fareJPY: 300, trainsPerHour: 12, staffingPolicyId: "lean", electricityContractId: "renewable" });
  assert.ok(result.warnings.includes("fleet-shortfall"));
  assert.equal(game.player.reputation, 73);
  game.addOperatingCompetitor(opened.id, { id: "rival:1", fareJPY: 250, trainsPerHour: 5 });
  const restored = ManagementGame.load(game.save());
  assert.equal(restored.services[0].averageFare, 300);
  assert.equal(restored.services[0].operatingCompetitors[0].id, "rival:1");
  assert.equal(restored.services[0].policyHistory.length, 1);
});
