import test from "node:test";
import assert from "node:assert/strict";
import {
  ManagementGame,
  createIntegratedConstructionSchedule,
  integratedScheduleSummary,
  recordIntegratedTaskDelay,
  refreshIntegratedConstructionSchedule,
  SCHEDULE_MONTH_MINUTES,
} from "../src/management/index.mjs";

function geometry(id = "integrated") {
  return {
    contractVersion: 1,
    schema: "transitline.plan-geometry/1",
    planId: id,
    coordinateReference: "EPSG:4326",
    sourcePackId: "synthetic",
    sourcePackVersion: "1",
    stationCandidates: [
      { id: "a", name: "A", location: [139, 35], platformType: "side", platformLengthM: 100, structure: "surface" },
      { id: "b", name: "B", location: [139.01, 35], platformType: "island", platformLengthM: 100, structure: "shield" },
      { id: "c", name: "C", location: [139.02, 35], platformType: "side", platformLengthM: 100, structure: "shield" },
    ],
    segments: [
      { id: "ab", from: "a", to: "b", lengthMeters: 1_000, elevationStartMeters: 0, elevationEndMeters: 0, structureHint: "surface", constraintFlags: [], dataQuality: "high" },
      { id: "bc", from: "b", to: "c", lengthMeters: 2_000, elevationStartMeters: 0, elevationEndMeters: -20, structureHint: "shield", constraintFlags: [], dataQuality: "high" },
    ],
    accessLinks: [],
  };
}

function entities() {
  const plan = geometry();
  const project = {
    id: "project:integrated",
    planId: plan.planId,
    status: "underConstruction",
    planGeometry: plan,
    estimate: { parallelCivilFronts: 1 },
    tasks: [
      { id: "design", progress: 0 },
      { id: "civil", progress: 0 },
      { id: "systems", progress: 0 },
      { id: "testing", progress: 0 },
    ],
  };
  const stationPackages = plan.stationCandidates.map((station) => ({
    id: `package:${station.id}`,
    connectedStationId: station.id,
    status: "awarded",
    progress: 0,
    awardedBid: { durationMonths: 12 },
  }));
  const depots = [{ id: "depot-1", name: "통합 차량기지", status: "underConstruction", progress: 0, assessment: { schedule: { durationMonths: 18 } } }];
  const vehicleOrders = [{ id: "order-1", stage: "design", elapsedMonths: 0, productionMonths: 20 }];
  return { project, stationPackages, depots, vehicleOrders };
}

test("integrated schedule links segment, station, depot, systems and vehicle work in one acyclic graph", () => {
  const input = entities();
  const before = JSON.stringify(input);
  const schedule = createIntegratedConstructionSchedule({ ...input, approvalMonths: 12, clock: { minute: 0 } });
  assert.equal(JSON.stringify(input), before, "building a schedule must not mutate the management entities");
  assert.equal(schedule.schema, "transitline.integrated-construction-schedule/1");
  for (const kind of ["design-approval", "segment-civil", "station-civil", "depot-construction", "vehicle-production", "railway-systems", "integrated-testing", "opening-readiness"]) {
    assert.ok(schedule.tasks.some((entry) => entry.kind === kind), `${kind} is present`);
  }
  const segments = schedule.tasks.filter((entry) => entry.kind === "segment-civil");
  assert.ok(segments[1].dependencies.includes(segments[0].id), "one civil front performs its segments in sequence");
  const systems = schedule.tasks.find((entry) => entry.kind === "railway-systems");
  assert.ok(segments.every((entry) => systems.dependencies.includes(entry.id)));
  const testing = schedule.tasks.find((entry) => entry.kind === "integrated-testing");
  assert.ok(testing.dependencies.includes(systems.id));
  assert.ok(testing.dependencies.some((id) => id.startsWith("depot:")));
  assert.ok(testing.dependencies.some((id) => id.startsWith("vehicle:")));
  assert.ok(schedule.baselineOpeningMonth > 0);
  assert.equal(schedule.forecastOpeningMonth, schedule.baselineOpeningMonth);
});

test("a delay on the critical civil chain moves every downstream forecast but never rewrites the baseline", () => {
  const input = entities();
  const schedule = createIntegratedConstructionSchedule({ ...input, approvalMonths: 12, clock: { minute: 0 } });
  const baseline = schedule.baselineOpeningMonth;
  const civil = schedule.tasks.filter((entry) => entry.kind === "segment-civil").at(-1);
  assert.equal(civil.critical, true);
  const event = recordIntegratedTaskDelay(schedule, civil.id, { months: 4, reason: "unexpected utility relocation", source: "test" }, { minute: 0 });
  refreshIntegratedConstructionSchedule(schedule, input, { minute: 0 });
  assert.equal(event.months, 4);
  assert.equal(schedule.baselineOpeningMonth, baseline);
  assert.equal(schedule.forecastOpeningMonth, baseline + 4);
  assert.equal(schedule.delayMonths, 4);
  assert.ok(schedule.tasks.find((entry) => entry.kind === "railway-systems").delayMonths >= 4);
  assert.ok(schedule.tasks.find((entry) => entry.kind === "integrated-testing").delayMonths >= 4);
});

test("completion makes the opening milestone ready and reports no unfinished blocker", () => {
  const input = entities();
  const schedule = createIntegratedConstructionSchedule({ ...input, approvalMonths: 12, clock: { minute: 0 } });
  input.project.status = "available";
  input.project.tasks.forEach((entry) => { entry.progress = 1; });
  input.stationPackages.forEach((entry) => { entry.status = "available"; entry.progress = 1; });
  input.depots.forEach((entry) => { entry.status = "secured"; entry.progress = 1; });
  input.vehicleOrders.forEach((entry) => { entry.stage = "accepted"; entry.elapsedMonths = entry.productionMonths; });
  refreshIntegratedConstructionSchedule(schedule, input, { minute: 40 * SCHEDULE_MONTH_MINUTES });
  const summary = integratedScheduleSummary(schedule);
  assert.equal(summary.ready, true);
  assert.equal(summary.status, "ready");
  assert.equal(summary.progress, 1);
  assert.deepEqual(summary.blockers, []);
});

test("a completed railway project cannot bypass an unfinished depot or vehicle order", () => {
  const input = entities();
  const schedule = createIntegratedConstructionSchedule({ ...input, approvalMonths: 12, clock: { minute: 0 } });
  input.project.status = "available";
  input.project.tasks.forEach((entry) => { entry.progress = 1; });
  input.stationPackages.forEach((entry) => { entry.status = "available"; entry.progress = 1; });
  refreshIntegratedConstructionSchedule(schedule, input, { minute: 36 * SCHEDULE_MONTH_MINUTES });
  const testing = schedule.tasks.find((entry) => entry.kind === "integrated-testing");
  assert.equal(testing.status, "blocked");
  assert.equal(schedule.ready, false);
  assert.ok(schedule.blockers.some((entry) => entry.kind === "depot-construction"));
  assert.ok(schedule.blockers.some((entry) => entry.kind === "vehicle-production"));
});

test("a recorded delay remains an opening gate even if its source reports completion early", () => {
  const input = entities();
  const schedule = createIntegratedConstructionSchedule({ ...input, approvalMonths: 12, clock: { minute: 0 } });
  const civil = schedule.tasks.filter((entry) => entry.kind === "segment-civil").at(-1);
  recordIntegratedTaskDelay(schedule, civil.id, { months: 4, reason: "safety stand-down" }, { minute: 0 });
  input.project.status = "available";
  input.project.tasks.forEach((entry) => { entry.progress = 1; });
  input.stationPackages.forEach((entry) => { entry.status = "available"; entry.progress = 1; });
  input.depots.forEach((entry) => { entry.status = "secured"; entry.progress = 1; });
  input.vehicleOrders.forEach((entry) => { entry.stage = "accepted"; entry.elapsedMonths = entry.productionMonths; });

  refreshIntegratedConstructionSchedule(schedule, input, { minute: civil.baselineFinishMonth * SCHEDULE_MONTH_MINUTES });
  assert.equal(civil.status, "delayed");
  assert.equal(schedule.ready, false);
  refreshIntegratedConstructionSchedule(schedule, input, { minute: civil.notBeforeFinishMonth * SCHEDULE_MONTH_MINUTES });
  assert.equal(civil.status, "complete");
  assert.equal(schedule.ready, true);
});

test("ManagementGame saves, restores and advances the integrated schedule with its source projects", () => {
  const game = new ManagementGame({ seed: 88, openingCash: 1_000_000_000_000 });
  const project = game.createProject(geometry("game-schedule"), "medium_steel");
  game.contractProject(project.id);
  const depot = game.addDepot({ id: "ready-depot", name: "기존 차량기지", locationStrategy: "shared", capacitySets: 4, inspectionSetsPerDay: 1 });
  const order = game.orderVehicles({ id: "schedule-order", modelId: "medium_4car", quantity: 4, manufacturerId: "maker-b" });
  const schedule = game.createIntegratedSchedule({ projectId: project.id, depotIds: [depot.id], vehicleOrderIds: [order.id] });
  const delayedTask = schedule.tasks.find((entry) => entry.critical && entry.kind !== "opening-readiness" && entry.status !== "complete");
  game.delayIntegratedTask(schedule.id, delayedTask.id, { months: 2, reason: "permit hold" });
  const month = game.advanceMonth();
  assert.equal(month.schedules.length, 1);
  assert.equal(month.schedules[0].currentMonth, 1);
  assert.equal(game.schedules[0].delayEvents.length, 1);

  const restored = ManagementGame.load(game.save());
  assert.deepEqual(restored.schedules, game.schedules);
  assert.equal(restored.requireSchedule(schedule.id).linkedVehicleOrderIds[0], order.id);
  const next = restored.advanceMonth();
  assert.equal(next.schedules[0].currentMonth, 2);
  assert.equal(restored.ledger.assertInvariant(), true);
});
