import test from "node:test";
import assert from "node:assert/strict";
import { ManagementGame, applyScenario, commissionProject, createScenario, evaluateScenario, scenarioCatalog, settleIntegratedServiceDay, suspendCommissionedService } from "../src/management/index.mjs";
import { createState } from "../src/state.mjs";
import { buildDemandModel } from "../src/demand-engine.mjs";
import { withStationAccess } from "../src/access-demand.mjs";
import { buildRouteGraph } from "../src/network.mjs";
import { createMapEngineBridge } from "../src/map-engine-bridge.mjs";
import { loadIntegratedGame, saveIntegratedGame, snapshotOperationalState } from "../src/integrated-save.mjs";
import { ScenarioRuntime } from "../src/scenario-runtime.mjs";

function integrationPack() {
  return {
    demand: {
      model: "gravity",
      points: [
        { id: "d0", name: "West demand", location: [139, 35], residents: 10_000, jobs: 1_000 },
        { id: "d1", name: "Central demand", location: [139.02, 35], residents: 4_000, jobs: 12_000 },
        { id: "d2", name: "East demand", location: [139.04, 35], residents: 7_000, jobs: 8_000 },
      ],
      attractors: [],
    },
  };
}

function integrationPlan() {
  return {
    contractVersion: 1,
    schema: "transitline.plan-geometry/1",
    planId: "map-line",
    name: "Map Line",
    coordinateReference: "EPSG:4326",
    sourcePackId: "integration",
    sourcePackVersion: "1",
    stationCandidates: [
      { id: "a", name: "West", location: [139.001, 35], platformType: "side", platformLengthM: 100, structure: "surface" },
      { id: "b", name: "Central", location: [139.021, 35], platformType: "island", platformLengthM: 100, structure: "elevated" },
      { id: "c", name: "East", location: [139.041, 35], platformType: "side", platformLengthM: 100, structure: "elevated" },
    ],
    segments: [
      { from: "a", to: "b", lengthMeters: 2300, elevationStartMeters: 0, elevationEndMeters: 8, structureHint: "surface", constraintFlags: [], dataQuality: "high" },
      { from: "b", to: "c", lengthMeters: 2400, elevationStartMeters: 8, elevationEndMeters: 10, structureHint: "elevated", constraintFlags: [], dataQuality: "high" },
    ],
    accessLinks: [
      { id: "access-0", demandNodeId: "d0", stationCandidateId: "a", walkMinutes: 6 },
      { id: "access-1", demandNodeId: "d1", stationCandidateId: "b", walkMinutes: 4 },
      { id: "access-2", demandNodeId: "d2", stationCandidateId: "c", walkMinutes: 5 },
    ],
  };
}

function completeProjectAndFleet(game) {
  const record = game.submitPlan(integrationPlan(), "medium_steel");
  game.approvePlan(record.id);
  const project = game.createProjectFromPlan(record.id);
  game.contractProject(project.id);
  game.addDepot({ id: "integrated-depot", name: "Integrated Depot", locationStrategy: "terminal", capacitySets: 4, inspectionSetsPerDay: 2 });
  game.orderVehicles({ id: "integrated-fleet", modelId: "medium_4car", quantity: 4, manufacturerId: "maker-a" });
  for (let month = 0; month < 120; month++) {
    game.advanceMonth();
    if (game.projects[0].status === "available" && game.vehicleOrders[0].stage === "accepted") break;
  }
  const service = game.createService({
    id: "integrated-service",
    name: "Integrated Service",
    projectId: project.id,
    vehicleOrderId: "integrated-fleet",
    depotId: "integrated-depot",
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
    passengerWeight: 100,
  });
  assert.equal(service.status, "open");
  return { record, project, service };
}

test("PlanGeometry is versioned, assessed, approved and locked into a project", () => {
  const game = new ManagementGame({ openingCash: 1_000_000_000_000 });
  const plan = integrationPlan();
  const first = game.submitPlan(plan, "medium_steel");
  assert.equal(first.status, "assessed");
  assert.equal(first.version, 1);
  assert.throws(() => game.submitPlan(plan, "medium_steel"), /unchanged/);
  const revised = integrationPlan();
  revised.stationCandidates[1].name = "Central Revised";
  const second = game.submitPlan(revised, "medium_steel");
  assert.equal(second.version, 2);
  assert.throws(() => game.approvePlan(first.id), /newer version/);
  game.approvePlan(second.id);
  const project = game.createProjectFromPlan(second.id);
  assert.equal(project.planVersion, 2);
  assert.equal(project.planGeometry.stationCandidates[1].name, "Central Revised");
  assert.equal(game.requirePlan(second.id).status, "in-project");
});

test("conditional or incompatible plans cannot be approved", () => {
  const game = new ManagementGame();
  const conditional = integrationPlan();
  delete conditional.stationCandidates[0].platformType;
  const record = game.submitPlan(conditional, "medium_steel");
  assert.equal(record.status, "needs-information");
  assert.throws(() => game.approvePlan(record.id), /not ready/);
  const invalid = integrationPlan();
  invalid.contractVersion = 99;
  const rejected = game.submitPlan(invalid, "medium_steel");
  assert.equal(rejected.status, "rejected");
});

test("available project becomes physical stations, track, access links and a service line atomically", () => {
  const game = new ManagementGame({ seed: 71, openingCash: 1_000_000_000_000 });
  const { record, project, service } = completeProjectAndFleet(game);
  const state = createState(integrationPack(), { materializeDemandStations: false, seed: 71 });
  assert.equal(state.stations.size, 0);
  const result = commissionProject(game, state, { projectId: project.id, serviceId: service.id, color: "#e63946" });
  assert.equal(state.stations.size, 3);
  assert.equal(state.platforms.length, 3);
  assert.equal(state.trackSegments.length, 2);
  assert.equal(state.accessLinks.length, 3);
  assert.deepEqual(state.lines[0].stationIds, result.stationIds);
  assert.equal(game.requirePlan(record.id).status, "commissioned");
  assert.equal(game.projects[0].commissionedLineId, state.lines[0].id);
  assert.throws(() => commissionProject(game, state, { projectId: project.id, serviceId: service.id }), /already commissioned/);
  assert.equal(state.lines.length, 1);
});

test("failed commissioning restores both management and operational state", () => {
  const game = new ManagementGame({ openingCash: 1_000_000_000_000 });
  const record = game.submitPlan(integrationPlan(), "medium_steel");
  game.approvePlan(record.id);
  const project = game.createProjectFromPlan(record.id);
  const state = createState(integrationPack(), { materializeDemandStations: false });
  const before = game.snapshot();
  assert.throws(() => commissionProject(game, state, { projectId: project.id }), /not available/);
  assert.deepEqual(game.snapshot(), before);
  assert.equal(state.stations.size, 0);
  assert.equal(state.lines.length, 0);
});

test("demand nodes select commissioned stations through access links", () => {
  const game = new ManagementGame({ seed: 91, openingCash: 1_000_000_000_000 });
  const { project, service } = completeProjectAndFleet(game);
  const pack = integrationPack();
  const state = createState(pack, { materializeDemandStations: false, seed: 91 });
  commissionProject(game, state, { projectId: project.id, serviceId: service.id });
  const model = withStationAccess(buildDemandModel(state, pack.demand), state);
  const graph = buildRouteGraph(state);
  const resolved = model.resolveTrip(state, graph, "d0", "d2");
  assert.equal(resolved.originStationId, state.lines[0].stationIds[0]);
  assert.equal(resolved.destinationStationId, state.lines[0].stationIds[2]);
  assert.equal(resolved.route.hops.length, 1);
  assert.equal(resolved.accessSeconds, 11 * 60);
});

test("actual network counters settle once per simulation day into the management ledger", () => {
  const game = new ManagementGame({ seed: 101, openingCash: 1_000_000_000_000 });
  const { project, service } = completeProjectAndFleet(game);
  const state = createState(integrationPack(), { materializeDemandStations: false, seed: 101 });
  commissionProject(game, state, { projectId: project.id, serviceId: service.id });
  const lineId = String(state.lines[0].id);
  state.simMinutes = 1440;
  state.stats.deliveredByLine[lineId] = 125;
  state.stats.trainKmByLine[lineId] = 880;
  const result = settleIntegratedServiceDay(game, state, service.id);
  assert.equal(result.passengers, 12_500);
  assert.equal(result.trainKm, 880);
  assert.ok(result.income > 0);
  assert.ok(result.cost > 0);
  assert.equal(result.operatingMonth.passengers, 12_500);
  assert.ok(result.operatingMonth.operatingCostJPY > 0);
  assert.equal(game.operatingMonthReport(service.id).length, 1);
  assert.throws(() => settleIntegratedServiceDay(game, state, service.id), /already settled/);
  assert.equal(game.services[0].integratedTotals.passengers, 12_500);
  suspendCommissionedService(game, state, service.id, true);
  assert.equal(state.lines[0].suspended, true);
  assert.equal(game.services[0].status, "suspended");
});

test("observed timetable misses and signal delays flow into the operating KPI", () => {
  const game = new ManagementGame({ seed: 102, openingCash: 1_000_000_000_000 });
  const { project, service } = completeProjectAndFleet(game);
  const state = createState(integrationPack(), { materializeDemandStations: false, seed: 102 });
  commissionProject(game, state, { projectId: project.id, serviceId: service.id });
  const lineId = String(state.lines[0].id);
  state.simMinutes = 1440;
  state.stats.railwayTrafficByLine = { [lineId]: {
    dispatchedTrains: 8,
    completedTrains: 8,
    scheduledDispatchedTrains: 8,
    unscheduledDispatchedTrains: 0,
    scheduledCompletedTrains: 8,
    onTimeTrains: 4,
    missedDepartures: 2,
    departureDelaySeconds: 180,
    signalDelaySeconds: 900,
    arrivalDelaySeconds: 1_200,
  } };
  const result = settleIntegratedServiceDay(game, state, service.id);
  assert.equal(result.railwayTraffic.serviceDeliveryRatio, 0.4);
  assert.equal(result.railwayTraffic.signalDelaySeconds, 900);
  assert.equal(result.punctuality, 0.5, "the existing settlement floor remains, but observed operation can lower the model KPI");
  assert.equal(game.services[0].engineCursor.completedTrains, 8);
  assert.equal(game.services[0].engineCursor.missedDepartures, 2);
});

test("dispatched but unfinished scheduled trains count against the settled service day", () => {
  const game = new ManagementGame({ seed: 104, openingCash: 1_000_000_000_000 });
  const { project, service } = completeProjectAndFleet(game);
  const state = createState(integrationPack(), { materializeDemandStations: false, seed: 104 });
  commissionProject(game, state, { projectId: project.id, serviceId: service.id });
  const lineId = String(state.lines[0].id);
  state.simMinutes = 1440;
  state.stats.railwayTrafficByLine = { [lineId]: {
    dispatchedTrains: 10,
    completedTrains: 0,
    scheduledDispatchedTrains: 10,
    unscheduledDispatchedTrains: 0,
    scheduledCompletedTrains: 0,
    onTimeTrains: 0,
    missedDepartures: 0,
    departureDelaySeconds: 0,
    signalDelaySeconds: 36_000,
    arrivalDelaySeconds: 0,
  } };
  const result = settleIntegratedServiceDay(game, state, service.id);
  assert.equal(result.railwayTraffic.serviceDeliveryRatio, 0);
  assert.equal(result.punctuality, 0.5);
});

test("combined integrated settlement rolls back management and line frequency when accounting fails", () => {
  const game = new ManagementGame({ seed: 103, openingCash: 1_000_000_000_000 });
  const { project, service } = completeProjectAndFleet(game);
  const state = createState(integrationPack(), { materializeDemandStations: false, seed: 103 });
  commissionProject(game, state, { projectId: project.id, serviceId: service.id });
  const lineId = String(state.lines[0].id);
  state.simMinutes = 1440;
  state.stats.deliveredByLine[lineId] = 50;
  state.stats.trainKmByLine[lineId] = 320;
  const managementBefore = game.snapshot();
  const operationsBefore = snapshotOperationalState(state);
  const applyOperatingSettlement = game.applyOperatingSettlement;
  game.applyOperatingSettlement = () => { throw new Error("forced accounting failure"); };
  try {
    assert.throws(() => settleIntegratedServiceDay(game, state, service.id), /forced accounting failure/);
  } finally {
    game.applyOperatingSettlement = applyOperatingSettlement;
  }
  assert.deepEqual(game.snapshot(), managementBefore);
  assert.deepEqual(snapshotOperationalState(state), operationsBefore);
});

test("scenario settlement aligns simulation days with the game calendar and rolls the whole batch back", () => {
  const game = new ManagementGame({ seed: 107, openingCash: 1_000_000_000_000 });
  const { project, service } = completeProjectAndFleet(game);
  const state = createState(integrationPack(), { materializeDemandStations: false, seed: 107 });
  commissionProject(game, state, { projectId: project.id, serviceId: service.id });
  service.engineCursor = { day: 0, delivered: 0, trainKm: 0 };
  service.operationsStartedAtSimMinute = 0;
  service.operationsStartedAtGameMinute = game.clock.minute;
  const startDay = Math.floor(game.clock.minute / 1440);
  game.trackAccessAgreements.push({
    id: "agreement:calendar",
    hostServiceId: service.id,
    guestOperatorId: game.competitors[0].id,
    trainsPerHour: 1,
    hostCapacityTrainsPerHour: 12,
    dailyTrainKm: 100,
    dailyStationStops: 20,
    accessFeeJPYPerTrainKm: 1_000,
    stationFeeJPYPerStop: 10_000,
    startDay,
    endDay: startDay + 365,
    lastSettledDay: startDay - 1,
    status: "active",
    totals: { settledDays: 0, accessRevenueJPY: 0 },
  });
  const runtime = Object.create(ScenarioRuntime.prototype);
  runtime.pack = { manifest: { id: "integration", version: "1" } };
  runtime.game = game;
  runtime.operationalState = state;
  runtime.bridge = createMapEngineBridge(game, state);
  const lineId = String(state.lines[0].id);
  state.simMinutes = 1440;
  state.stats.deliveredByLine[lineId] = 25;
  state.stats.trainKmByLine[lineId] = 160;
  const [first] = runtime.settleOperatingDays();
  assert.equal(first.day, 1, "simulation cursor uses the map day");
  assert.equal(first.operatingDay, startDay + 1, "economic settlement uses the synchronized game day");
  assert.equal(first.trackAccess.settlement.settlements[0].throughDay, startDay);
  assert.ok(first.money.trackAccessRevenueJPY > 0);
  assert.equal(runtime.game.operatingMonthReport(service.id).length, 1);

  state.simMinutes = 2880;
  state.stats.deliveredByLine[lineId] = 40;
  state.stats.trainKmByLine[lineId] = 260;
  const managementBefore = runtime.game.snapshot();
  const operationsBefore = snapshotOperationalState(runtime.operationalState);
  runtime.game.applyOperatingSettlement = () => { throw new Error("forced batch failure"); };
  assert.throws(() => runtime.settleOperatingDays(), /forced batch failure/);
  assert.deepEqual(runtime.game.snapshot(), managementBefore, "clock, ledger, cursor and agreement totals all roll back");
  assert.deepEqual(snapshotOperationalState(runtime.operationalState), operationsBefore, "map-side line state rolls back too");
});

test("manual calendar jumps do not freeze daily fleet dispatch or back-bill idle access days", () => {
  const game = new ManagementGame({ seed: 109, openingCash: 1_000_000_000_000 });
  const { project, service } = completeProjectAndFleet(game);
  const state = createState(integrationPack(), { materializeDemandStations: false, seed: 109 });
  commissionProject(game, state, { projectId: project.id, serviceId: service.id });
  service.engineCursor = { day: 0, delivered: 0, trainKm: 0 };
  service.operationsStartedAtSimMinute = 0;
  service.operationsStartedAtGameMinute = game.clock.minute;
  const startDay = Math.floor(game.clock.minute / 1440);
  game.trackAccessAgreements.push({
    id: "agreement:jump",
    hostServiceId: service.id,
    guestOperatorId: game.competitors[0].id,
    trainsPerHour: 1,
    hostCapacityTrainsPerHour: 12,
    dailyTrainKm: 100,
    dailyStationStops: 20,
    accessFeeJPYPerTrainKm: 1_000,
    stationFeeJPYPerStop: 10_000,
    startDay,
    endDay: startDay + 365,
    lastSettledDay: startDay - 1,
    status: "active",
    totals: { settledDays: 0, accessRevenueJPY: 0 },
  });
  const runtime = Object.create(ScenarioRuntime.prototype);
  Object.assign(runtime, {
    pack: { manifest: { id: "integration", version: "1" } },
    game,
    operationalState: state,
    bridge: createMapEngineBridge(game, state),
  });
  game.advanceMonth();
  const operatingDays = [];
  for (let day = 1; day <= 4; day += 1) {
    state.simMinutes = day * 1440;
    state.stats.deliveredByLine[String(state.lines[0].id)] = day * 10;
    state.stats.trainKmByLine[String(state.lines[0].id)] = day * 100;
    const [settlement] = runtime.settleOperatingDays();
    const dispatchedDays = game.vehicleOrders.find((order) => order.id === service.vehicleOrderId).units
      .filter((unit) => settlement.reliability.operatingUnitIds.includes(unit.id))
      .map((unit) => unit.lastDispatchedDay);
    operatingDays.push(Math.max(...dispatchedDays));
    assert.equal(settlement.reliability.operatingSets, settlement.reliability.requestedSets, `day ${day} dispatches its requested fleet`);
    assert.equal(settlement.trackAccess.settlement.settlements[0].days, 1, `day ${day} bills one actual operating day`);
  }
  assert.deepEqual(operatingDays, [1, 2, 3, 4], "dispatch uses the monotonic map-service day rather than the jumped calendar day");
  assert.equal(game.trackAccessAgreements[0].totals.settledDays, 4);
});

test("zero dispatched sets produce zero map frequency", () => {
  const game = new ManagementGame({ seed: 113, openingCash: 1_000_000_000_000 });
  const { project, service } = completeProjectAndFleet(game);
  const state = createState(integrationPack(), { materializeDemandStations: false, seed: 113 });
  commissionProject(game, state, { projectId: project.id, serviceId: service.id });
  for (const unit of game.vehicleOrders.find((order) => order.id === service.vehicleOrderId).units) unit.status = "withdrawn";
  state.simMinutes = 1440;
  const settlement = settleIntegratedServiceDay(game, state, service.id);
  assert.equal(settlement.reliability.operatingSets, 0);
  assert.ok(Object.values(state.lines[0].frequency).every((value) => value === 0));
});

test("no due settlement returns before copying a large management snapshot", () => {
  const game = new ManagementGame({ seed: 127, openingCash: 1_000_000_000_000 });
  const { project, service } = completeProjectAndFleet(game);
  const state = createState(integrationPack(), { materializeDemandStations: false, seed: 127 });
  commissionProject(game, state, { projectId: project.id, serviceId: service.id });
  service.engineCursor = { day: 0, delivered: 0, trainKm: 0 };
  service.operationsStartedAtSimMinute = 0;
  service.operationsStartedAtGameMinute = game.clock.minute;
  const runtime = Object.create(ScenarioRuntime.prototype);
  Object.assign(runtime, {
    pack: { manifest: { id: "integration", version: "1" } },
    game,
    operationalState: state,
    bridge: createMapEngineBridge(game, state),
  });
  game.ledger.entries.push(...Array.from({ length: 3_000 }, (_, index) => ({ atMinute: index, amount: 0, category: "test", reference: `entry:${index}` })));
  let snapshotCalls = 0;
  const snapshot = game.snapshot.bind(game);
  game.snapshot = () => { snapshotCalls += 1; return snapshot(); };
  assert.deepEqual(runtime.settleOperatingDays(), []);
  assert.equal(snapshotCalls, 0);
});

test("a failure in the second service rolls the entire settlement batch back", () => {
  const game = new ManagementGame({ seed: 131, openingCash: 1_000_000_000_000 });
  const { project, service } = completeProjectAndFleet(game);
  const state = createState(integrationPack(), { materializeDemandStations: false, seed: 131 });
  commissionProject(game, state, { projectId: project.id, serviceId: service.id });
  service.engineCursor = { day: 0, delivered: 0, trainKm: 0 };
  service.operationsStartedAtSimMinute = 0;
  service.operationsStartedAtGameMinute = game.clock.minute;
  const second = structuredClone(service);
  second.id = "integrated-service:second";
  second.operationalLineId = 2;
  second.engineCursor = { day: 0, delivered: 0, trainKm: 0 };
  game.services.push(second);
  const secondLine = structuredClone(state.lines[0]);
  secondLine.id = 2;
  state.lines.push(secondLine);
  state.simMinutes = 1440;
  for (const line of state.lines) {
    state.stats.deliveredByLine[String(line.id)] = 10;
    state.stats.trainKmByLine[String(line.id)] = 100;
  }
  const runtime = Object.create(ScenarioRuntime.prototype);
  Object.assign(runtime, {
    pack: { manifest: { id: "integration", version: "1" } },
    game,
    operationalState: state,
    bridge: createMapEngineBridge(game, state),
  });
  const managementBefore = game.snapshot();
  const operationsBefore = snapshotOperationalState(state);
  const apply = game.applyOperatingSettlement.bind(game);
  let calls = 0;
  game.applyOperatingSettlement = (...args) => {
    calls += 1;
    if (calls === 2) throw new Error("forced second-service failure");
    return apply(...args);
  };
  assert.throws(() => runtime.settleOperatingDays(), /forced second-service failure/);
  assert.deepEqual(runtime.game.snapshot(), managementBefore, "ledger, RNG, cursors, contracts and the first service settlement all roll back");
  assert.deepEqual(snapshotOperationalState(runtime.operationalState), operationsBefore, "both map lines roll back with the batch");
});

test("map bridge exposes commands and read-only serialisable results", () => {
  const game = new ManagementGame({ openingCash: 1_000_000_000_000 });
  const state = createState(integrationPack(), { materializeDemandStations: false });
  const bridge = createMapEngineBridge(game, state);
  const submitted = bridge.submitPlan(integrationPlan(), "medium_steel");
  assert.equal(submitted.status, "assessed");
  submitted.assessment.violations.push("client mutation");
  assert.equal(game.requirePlan(submitted.planRecordId).assessment.violations.length, 0);
  bridge.approvePlan(submitted.planRecordId);
  const project = bridge.createProject(submitted.planRecordId);
  const overlay = bridge.getProjectOverlay(project.projectId);
  assert.equal(overlay.stations.length, 3);
  assert.equal(overlay.segments.length, 2);
  assert.equal(overlay.status, "estimated");
});

test("integrated save restores commissioned assets, links, RNG and management references", () => {
  const game = new ManagementGame({ seed: 111, openingCash: 1_000_000_000_000 });
  const { project, service } = completeProjectAndFleet(game);
  const state = createState(integrationPack(), { materializeDemandStations: false, seed: 222 });
  commissionProject(game, state, { projectId: project.id, serviceId: service.id });
  state.simMinutes = 4321;
  const text = saveIntegratedGame({ game, operationalState: state, packId: "integration", packVersion: "1" });
  const restored = loadIntegratedGame(text, { id: "integration", version: "1" });
  assert.equal(restored.operationalState.stations.size, 3);
  assert.equal(restored.operationalState.trackSegments.length, 2);
  assert.equal(restored.operationalState.accessLinks.length, 3);
  assert.equal(restored.operationalState.lines[0].projectId, project.id);
  assert.equal(restored.operationalState.lines[0].lastDispatch, -Infinity);
  assert.equal(restored.game.projects[0].commissionedLineId, restored.operationalState.lines[0].id);
  assert.equal(restored.operationalState.simMinutes, 4321);
  assert.equal(restored.operationalState.rng.snapshot(), state.rng.snapshot());
  assert.throws(() => loadIntegratedGame(text, { id: "integration", version: "2" }), /pack version/);
});

test("scenario modes enforce existing-network requirements and difficulty tuning", () => {
  assert.throws(() => createScenario({ id: "bad", type: "congestion_relief", networkMode: "scratch" }), /requires/);
  const easy = createScenario({ id: "easy", type: "greenfield_growth", networkMode: "scratch", difficulty: "easy" });
  const hard = createScenario({ id: "hard", type: "greenfield_growth", networkMode: "scratch", difficulty: "hard" });
  assert.ok(easy.startingCash > hard.startingCash);
  assert.ok(easy.objectives.minimumDailyPassengers < hard.objectives.minimumDailyPassengers);
  assert.equal(scenarioCatalog("JP").length, 12);
});

test("scenario evaluation reads commissioned infrastructure and actual operating totals", () => {
  const game = new ManagementGame({ openingCash: 1_000_000_000_000 });
  const scenario = createScenario({ id: "test-scenario", type: "greenfield_growth", networkMode: "scratch", fundingMode: "sandbox", difficulty: "easy" });
  applyScenario(game, scenario, integrationPack());
  game.services.push({ integratedTotals: { passengers: 110_000, income: 200, cost: 100 }, daysOperated: 1 });
  const state = createState(integrationPack(), { materializeDemandStations: false });
  state.stations.set("a", { id: "a", location: [139, 35] });
  state.stations.set("b", { id: "b", location: [139.1, 35] });
  state.lines.push({ id: 1, owned: true, suspended: false, stationIds: ["a", "b"], trackSegmentIds: ["t"] });
  state.trackSegments.push({ id: "t", lengthMeters: 40_000 });
  const result = evaluateScenario(game, state);
  assert.equal(result.checks.passengers, true);
  assert.equal(result.checks.routeLength, true);
  assert.equal(result.checks.stations, false);
  assert.equal(result.status, "active");
});
