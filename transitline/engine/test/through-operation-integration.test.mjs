import test from "node:test";
import assert from "node:assert/strict";
import { createMapEngineBridge } from "../src/map-engine-bridge.mjs";
import {
  acceptThroughFareAgreement,
  activateThroughFareAgreement,
  createThroughFareAgreement,
  fileThroughFareAgreement,
  ManagementGame,
} from "../src/management/index.mjs";
import { ScenarioRuntime } from "../src/scenario-runtime.mjs";
import { addLine, createState } from "../src/state.mjs";
import { dispatchTrains, stepTrains } from "../src/trains.mjs";
import {
  bindThroughServiceToLine,
  recordThroughJourneyDelivery,
  recordThroughPassengerDelivery,
  throughOperationActualsForDay,
  throughOperationReport,
} from "../src/through-operation-integration.mjs";
import { snapshotOperationalState } from "../src/integrated-save.mjs";

const pack = {
  manifest: { id: "through-integration", version: "1", bbox: [139, 35, 140, 36], origin: [139.5, 35.5] },
  demand: {
    model: "gravity",
    points: [
      { id: "a", name: "A", location: [139.5, 35.5], residents: 1_000, jobs: 1_000 },
      { id: "b", name: "B", location: [139.501, 35.5], residents: 1_000, jobs: 1_000 },
      { id: "c", name: "C", location: [139.502, 35.5], residents: 1_000, jobs: 1_000 },
    ],
    attractors: [],
  },
};

function service(overrides = {}) {
  return {
    schema: "transitline.through-service/1",
    contractVersion: 1,
    throughServiceId: "through-service:integration",
    throughRouteId: "through-route:integration",
    routeGeometryRevision: "revision:1",
    status: "approved",
    guestModelId: "medium_4car",
    trainsPerHour: 4,
    operatorId: "player",
    payerOperatorId: "player",
    payeeOwnerId: "external",
    legs: [
      { legId: "leg:player", infrastructureOwnerId: "player" },
      { legId: "leg:external", infrastructureOwnerId: "external" },
    ],
    handoverIds: ["handover:1"],
    trackAccessAgreementIds: ["access:external"],
    vehicleTechnicalOverrides: {},
    approvedRetrofitProgramIds: [],
    assessment: { verdict: "possible", violations: [], conditions: [], missingInputs: [] },
    ...overrides,
  };
}

function activeFare(linkedService = service()) {
  const agreement = createThroughFareAgreement({
    id: "through-fare:integration",
    throughService: linkedService,
    participantTerms: [
      { operatorId: "player", legIds: ["leg:player"], sectionFareJPY: 220 },
      { operatorId: "external", legIds: ["leg:external"], sectionFareJPY: 180 },
    ],
    jointDiscountJPY: 70,
  });
  acceptThroughFareAgreement(agreement, "player");
  acceptThroughFareAgreement(agreement, "external");
  fileThroughFareAgreement(agreement);
  activateThroughFareAgreement(agreement, linkedService);
  return agreement;
}

function accessAgreement() {
  return {
    schema: "transitline.track-access-agreement/1",
    contractVersion: 1,
    id: "access:external",
    infrastructureOwnerId: "external",
    guestOperatorId: "player",
    accessFeeJPYPerTrainKm: 1_000,
    stationFeeJPYPerStop: 10_000,
    status: "active",
    totals: { settledDays: 0, accessRevenueJPY: 0 },
  };
}

function stateAndLine() {
  const state = createState(pack, { seed: 17 });
  state.simMinutes = 0;
  const line = addLine(state, ["a", "b", "c"], { frequency: { high: 60, medium: 60, low: 60, veryLow: 60 } });
  return { state, line };
}

function bind(state, line, linkedService = service()) {
  return bindThroughServiceToLine(state, linkedService, {
    operationalLineId: line.id,
    passengerWeight: 100,
    segmentAccessAgreementIds: [null, "access:external"],
    stationAccessAgreementIds: [[], ["access:external"], ["access:external"]],
    startedAtGameMinute: 0,
  });
}

function runtimeFixture(openingCash = 10_000_000) {
  const linkedService = service();
  const game = new ManagementGame({ seed: 19, openingCash });
  game.throughServices.push(linkedService);
  game.throughFareAgreements.push(activeFare(linkedService));
  game.trackAccessAgreements.push(accessAgreement());
  const { state, line } = stateAndLine();
  const runtime = Object.assign(Object.create(ScenarioRuntime.prototype), {
    pack,
    game,
    operationalState: state,
    bridge: createMapEngineBridge(game, state),
  });
  runtime.bindThroughServiceOperation(linkedService.throughServiceId, {
    operationalLineId: line.id,
    passengerWeight: 100,
    segmentAccessAgreementIds: [null, "access:external"],
    stationAccessAgreementIds: [[], ["access:external"], ["access:external"]],
  });
  return { runtime, line };
}

test("binding is explicit, deterministic and reports without mutating its inputs", () => {
  const { state, line } = stateAndLine();
  const beforeService = structuredClone(service());
  const binding = bind(state, line);
  assert.equal(binding.operationalLineId, String(line.id));
  assert.deepEqual(service(), beforeService);
  const stateBeforeReport = snapshotOperationalState(state);
  const first = throughOperationReport(state);
  const second = throughOperationReport(state);
  assert.deepEqual(first, second);
  assert.deepEqual(snapshotOperationalState(state), stateBeforeReport);
  first[0].segmentAccessAgreementIds[1] = "tampered";
  assert.equal(state.throughServiceBindings[0].segmentAccessAgreementIds[1], "access:external");
});

test("binding rejects plan lines, duplicate use, unlinked access and incomplete agreement coverage", () => {
  const { state, line } = stateAndLine();
  line.planOnly = true;
  assert.throws(() => bind(state, line), /planning-only/);
  line.planOnly = false;
  assert.throws(() => bindThroughServiceToLine(state, service(), {
    operationalLineId: line.id,
    segmentAccessAgreementIds: [null, "not-linked"],
    stationAccessAgreementIds: [[], [], []],
  }), /unlinked/);
  assert.throws(() => bindThroughServiceToLine(state, service(), {
    operationalLineId: line.id,
    segmentAccessAgreementIds: [null, null],
    stationAccessAgreementIds: [[], [], []],
  }), /does not cover/);
  bind(state, line);
  assert.throws(() => bind(state, line), /already has/);
});

test("actual train movement and station calls are recorded per completed simulation day", () => {
  const { state, line } = stateAndLine();
  bind(state, line);
  dispatchTrains(state);
  stepTrains(state, 120);
  const actuals = throughOperationActualsForDay(state, service().throughServiceId, 0);
  assert.ok(actuals.trainKm > 0);
  assert.ok(actuals.trackAccessUsage[0].trainKm > 0, "the second physical segment belongs to the external agreement");
  assert.ok(actuals.trackAccessUsage[0].stationStops >= 2, "actual external station calls are counted, not estimated");
});

test("terminal fare mode excludes partial riders and counts a direct end-to-end delivery once", () => {
  const { state, line } = stateAndLine();
  bind(state, line);
  const partial = { originId: "b", destinationId: "c", route: [{ lineId: line.id }] };
  const transfer = { originId: "a", destinationId: "c", route: [{ lineId: 99 }, { lineId: line.id }] };
  const direct = { originId: "a", destinationId: "c", route: [{ lineId: line.id }] };
  assert.equal(recordThroughPassengerDelivery(state, line, partial), false);
  assert.equal(recordThroughPassengerDelivery(state, line, transfer), false);
  assert.equal(recordThroughPassengerDelivery(state, line, direct), true);
  assert.equal(throughOperationActualsForDay(state, service().throughServiceId, 0).passengers, 100);
  assert.equal(recordThroughJourneyDelivery(state, line, [{ kind: "transit", routeId: line.id, fromStopId: "a", toStopId: "c" }], 37), true);
  assert.equal(throughOperationActualsForDay(state, service().throughServiceId, 0).passengers, 137, "pop riders are already weighted and must not be multiplied again");
});

test("runtime closes completed days automatically, clears map buckets and preserves save data", () => {
  const { runtime, line } = runtimeFixture();
  const direct = { originId: "a", destinationId: "c", route: [{ lineId: line.id }] };
  recordThroughPassengerDelivery(runtime.operationalState, line, direct);
  dispatchTrains(runtime.operationalState);
  stepTrains(runtime.operationalState, 120);
  runtime.operationalState.simMinutes = 1440;
  const [settlement] = runtime.settleOperatingDays();
  assert.equal(settlement.schema, "transitline.through-operating-settlement/1");
  assert.equal(settlement.operatingDay, 0);
  assert.equal(settlement.passengers, 100);
  assert.ok(settlement.trainKm > 0);
  assert.equal(runtime.throughOperationReport()[0].actualsByDay[0], undefined);
  assert.deepEqual(runtime.settleOperatingDays(), [], "the completed day cannot settle twice");
  const save = JSON.parse(runtime.save());
  assert.equal(save.operations.throughServiceBindings[0].throughServiceId, service().throughServiceId);
  assert.ok(save.management.throughOperatingSettlements.length === 1);
});

test("runtime commissions a dedicated physical through line atomically", () => {
  const linkedService = service();
  const game = new ManagementGame({ openingCash: 10_000_000 });
  game.throughServices.push(linkedService);
  game.throughFareAgreements.push(activeFare(linkedService));
  game.trackAccessAgreements.push(accessAgreement());
  const state = createState(pack, { seed: 23 });
  const runtime = Object.assign(Object.create(ScenarioRuntime.prototype), {
    pack,
    game,
    operationalState: state,
    bridge: createMapEngineBridge(game, state),
  });
  const before = snapshotOperationalState(state);
  assert.throws(() => runtime.commissionThroughServiceOperation(linkedService.throughServiceId, {
    stationIds: ["a", "b", "c"],
    segmentAccessAgreementIds: [null, null],
    stationAccessAgreementIds: [[], [], []],
  }), /does not cover/);
  assert.deepEqual(snapshotOperationalState(state), before, "a rejected mapping leaves no half-created line or consumed line id");
  const commissioned = runtime.commissionThroughServiceOperation(linkedService.throughServiceId, {
    stationIds: ["a", "b", "c"],
    passengerWeight: 1,
    segmentAccessAgreementIds: [null, "access:external"],
    stationAccessAgreementIds: [[], ["access:external"], ["access:external"]],
  });
  assert.equal(commissioned.line.carsPerTrain, 4);
  assert.equal(commissioned.line.throughOperation, true);
  assert.equal(runtime.throughOperationReport()[0].operationalLineId, String(commissioned.line.id));
});

test("a conventional commissioned line cannot be double-bound to through settlement", () => {
  const linkedService = service();
  const game = new ManagementGame({ openingCash: 10_000_000 });
  game.throughServices.push(linkedService);
  game.throughFareAgreements.push(activeFare(linkedService));
  const { state, line } = stateAndLine();
  game.services.push({ id: "service:ordinary", operationalLineId: line.id });
  const runtime = Object.assign(Object.create(ScenarioRuntime.prototype), {
    pack,
    game,
    operationalState: state,
    bridge: createMapEngineBridge(game, state),
  });
  assert.throws(() => runtime.bindThroughServiceOperation(linkedService.throughServiceId, {
    operationalLineId: line.id,
    segmentAccessAgreementIds: [null, "access:external"],
    stationAccessAgreementIds: [[], ["access:external"], ["access:external"]],
  }), /중복 연결/);
  assert.deepEqual(runtime.throughOperationReport(), []);
});

test("a failed automatic settlement restores management, clock and raw operational facts", () => {
  const { runtime, line } = runtimeFixture(0);
  dispatchTrains(runtime.operationalState);
  stepTrains(runtime.operationalState, 120);
  runtime.operationalState.simMinutes = 1440;
  const managementBefore = runtime.game.snapshot();
  const operationsBefore = snapshotOperationalState(runtime.operationalState);
  assert.throws(() => runtime.settleOperatingDays(), /Insufficient cash/);
  assert.deepEqual(runtime.game.snapshot(), managementBefore);
  assert.deepEqual(snapshotOperationalState(runtime.operationalState), operationsBefore);
  assert.ok(runtime.throughOperationReport()[0].actualsByDay[0], "failed-day facts remain available for retry");
  assert.equal(line.throughServiceId, service().throughServiceId);
});

test("through-service status changes suspend and resume the physical through line", () => {
  const { runtime, line } = runtimeFixture();
  assert.equal(line.suspended, false);
  runtime.setThroughServiceStatus(service().throughServiceId, "suspended");
  assert.equal(line.suspended, true);
  runtime.setThroughServiceStatus(service().throughServiceId, "approved");
  assert.equal(line.suspended, false);
  runtime.setThroughServiceStatus(service().throughServiceId, "terminated");
  assert.equal(line.suspended, true);
});

test("fare suspension stops the physical line and reactivation resumes it", () => {
  const { runtime, line } = runtimeFixture();
  runtime.setThroughFareAgreementStatus("through-fare:integration", "suspended");
  assert.equal(line.suspended, true);
  runtime.activateThroughFareAgreement("through-fare:integration");
  assert.equal(line.suspended, false);
});

test("old operational saves without binding collections report an empty list without mutation", () => {
  const { state } = stateAndLine();
  const before = snapshotOperationalState(state);
  assert.deepEqual(throughOperationReport(state), []);
  assert.deepEqual(snapshotOperationalState(state), before);
});

test("unbinding cannot discard unsettled physical facts", () => {
  const { state, line } = stateAndLine();
  bind(state, line);
  dispatchTrains(state);
  stepTrains(state, 30);
  assert.throws(() => {
    const runtime = Object.assign(Object.create(ScenarioRuntime.prototype), { operationalState: state });
    runtime.unbindThroughServiceOperation(service().throughServiceId);
  }, /unsettled facts/);
  assert.equal(state.throughServiceBindings.length, 1);
});
