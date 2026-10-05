import test from "node:test";
import assert from "node:assert/strict";
import { restoreOperationalState, snapshotOperationalState } from "../src/integrated-save.mjs";
import { buildRouteGraph } from "../src/network.mjs";
import { patternsFromState, popTrains } from "../src/pop-adapter.mjs";
import {
  advanceRailReplacementOperations,
  assessRailReplacementOperation,
  dispatchRailReplacementBuses,
  railReplacementOperationReport,
  startRailReplacementOperation,
  stepRailReplacementBuses,
} from "../src/rail-replacement-operations.mjs";
import { createRailwayControlOrder } from "../src/railway-service-control.mjs";
import { findRoute } from "../src/routing.mjs";
import { ScenarioRuntime } from "../src/scenario-runtime.mjs";
import { addLine, addPhysicalStation, addTrackSegment, createState } from "../src/state.mjs";

const pack = () => ({ manifest: { id: "replacement", version: "1", data: { license: "test", attribution: [] } }, demand: { model: "gravity", points: [], attractors: [] } });

function fixture(candidateOverrides = {}) {
  const state = createState(pack());
  for (let index = 0; index < 4; index += 1) addPhysicalStation(state, { id: String.fromCharCode(65 + index), location: [139 + index * 0.01, 35] });
  addTrackSegment(state, { id: "ab", fromStationId: "A", toStationId: "B", directionMode: "double" });
  addTrackSegment(state, { id: "bc", fromStationId: "B", toStationId: "C", directionMode: "double" });
  addTrackSegment(state, { id: "cd", fromStationId: "C", toStationId: "D", directionMode: "double" });
  const line = addLine(state, ["A", "B", "C", "D"], { frequency: { high: 6, medium: 6, low: 6, veryLow: 6 } });
  line.trackSegmentIds = ["ab", "bc", "cd"];
  const event = {
    schema: "transitline.railway-disruption/1", contractVersion: 1, id: "event:1", kind: "signal-failure", status: "active",
    lineId: String(line.id), trackSegmentId: "bc", blockId: null, trainId: null, startedAtMinute: state.simMinutes,
    expectedEndMinute: state.simMinutes + 600, resolvedAtMinute: null, resolutionReason: null, effect: { closed: true, speedLimitMps: 0 },
  };
  state.railwayDisruptions.events.push(event);
  const order = createRailwayControlOrder(state, {
    kind: "partial-suspension", eventId: event.id, lineId: line.id,
    candidateId: "partial-suspension:1", controlGeometryId: "control-geometry:1", controlGeometryRevision: "control-revision:1",
    retainedServices: [{ serviceId: "west", stationIds: ["A", "B"] }, { serviceId: "east", stationIds: ["C", "D"] }],
    suspendedTrackSegmentIds: ["bc"],
    turnbackCandidateIds: ["turnback:B", "turnback:C"],
  });
  const candidate = {
    candidateId: "replacement:B-C", geometryId: "replacement-geometry:1", geometryRevision: "revision:1",
    stationIds: ["B", "C"], legDistancesMeters: [3_000], roadConnection: true, minimumRoadWidthMeters: 3,
    ...candidateOverrides,
  };
  const input = { eventId: event.id, controlOrderId: order.id, candidate, vehicleClassId: "standard", procurementStrategyId: "emergency-charter", vehicleCount: 2 };
  return { state, line, event, order, candidate, input };
}

function replacementGeometry(overrides = {}) {
  const route = {
    routeId: "replacement-route:1", lengthMeters: 3_000,
    stationApproaches: [
      { stationId: "B", distanceMeters: 5, alongMeters: 100, passesNear: true },
      { stationId: "C", distanceMeters: 5, alongMeters: 3_100, passesNear: true },
    ],
    reachesStartStation: true, reachesEndStation: true, orderMatchesRail: true,
    alongRoad: { fullyOnRoad: true },
    roadAttachment: { start: { attached: true }, end: { attached: true } },
    roadWidthMeters: 3, roadWidthAtLeastVehicleWidth: true,
    constraintIdsNear: [], stopCandidateIdsNear: ["stop:B", "stop:C"],
  };
  return {
    schema: "transitline.rail-replacement-transport-geometry/1", contractVersion: 1,
    replacementGeometryId: "replacement-geometry:current", replacementGeometryRevision: "replacement-revision:1",
    eventId: "event:1", controlGeometryId: "control-geometry:1", controlGeometryRevision: "control-revision:1",
    operationalLineId: "1", partialSuspensionCandidateId: "partial-suspension:1",
    selectedTurnbackCandidateIds: ["turnback:B", "turnback:C"], suspendedTrackSegmentIds: ["bc"],
    stationSequence: ["B", "C"],
    stations: [
      { stationId: "B", derivedStopCandidateIds: ["stop:B"], playerStopCandidateIds: [] },
      { stationId: "C", derivedStopCandidateIds: ["stop:C"], playerStopCandidateIds: [] },
    ],
    stopCandidates: [
      { stopCandidateId: "stop:B", stationId: "B", roadAdjacent: true },
      { stopCandidateId: "stop:C", stationId: "C", roadAdjacent: true },
    ],
    routeCandidates: [route],
    ...overrides,
  };
}

test("assessment exposes mobilisation, headway, capacity and 2026-JPY assumptions without mutating operations", () => {
  const { state, input } = fixture();
  const before = snapshotOperationalState(state);
  const assessment = assessRailReplacementOperation(state, input);
  assert.equal(assessment.verdict, "feasible");
  assert.equal(assessment.mobilisationMinutes, 60);
  assert.equal(assessment.mobilisationCostJPY, 360_000);
  assert.equal(assessment.operatingCostJPYPerHour, 36_000);
  assert.equal(assessment.passengerCapacityPerDeparture, 70);
  assert.ok(assessment.headwaySeconds > assessment.oneWaySeconds);
  assert.deepEqual(snapshotOperationalState(state), before);
});

test("unknown road facts require confirmation, while measured disconnection and narrow roads remain impossible", () => {
  const unknown = fixture({ roadConnection: null, minimumRoadWidthMeters: null });
  assert.equal(assessRailReplacementOperation(unknown.state, unknown.input).verdict, "conditional");
  const confirmed = assessRailReplacementOperation(unknown.state, { ...unknown.input, confirmUnknownRoadFacts: true });
  assert.equal(confirmed.verdict, "feasible");
  assert.deepEqual(confirmed.assumptions.sort(), ["replacement-road-connection-unknown", "replacement-road-width-unknown"]);
  const disconnected = fixture({ roadConnection: false });
  assert.equal(assessRailReplacementOperation(disconnected.state, disconnected.input).verdict, "infeasible");
  const narrow = fixture({ minimumRoadWidthMeters: 2.2 });
  assert.deepEqual(assessRailReplacementOperation(narrow.state, narrow.input).failures, ["replacement-road-too-narrow"]);
});

test("M8 geometry maps the current route revision to measured operational legs", () => {
  const { state, input } = fixture();
  const geometry = replacementGeometry();
  const before = structuredClone(geometry);
  const assessment = assessRailReplacementOperation(state, {
    ...input, candidate: undefined, replacementGeometry: geometry,
    replacementGeometryRevision: geometry.replacementGeometryRevision, routeId: "replacement-route:1",
  });
  assert.equal(assessment.verdict, "feasible");
  assert.deepEqual(assessment.candidate.sourceStationIds, ["B", "C"]);
  assert.deepEqual(assessment.candidate.stationIds, ["B", "C"]);
  assert.deepEqual(assessment.candidate.legDistancesMeters, [3_000]);
  assert.equal(assessment.candidate.geometryId, "replacement-geometry:current");
  assert.equal(assessment.candidate.geometryRevision, "replacement-revision:1");
  assert.equal(assessment.candidate.stopConnection, true);
  assert.deepEqual(geometry, before);
});

test("M8 adapter rejects stale revisions and links before charging or starting service", () => {
  const { state, input } = fixture();
  const geometry = replacementGeometry();
  const request = { ...input, candidate: undefined, replacementGeometry: geometry, routeId: "replacement-route:1" };
  assert.throws(() => assessRailReplacementOperation(state, { ...request, replacementGeometryRevision: "old" }), /revision is stale/);
  assert.throws(() => assessRailReplacementOperation(state, {
    ...request, replacementGeometryRevision: geometry.replacementGeometryRevision,
    replacementGeometry: { ...geometry, controlGeometryRevision: "old" },
  }), /stale against the active control order/);
  assert.throws(() => assessRailReplacementOperation(state, {
    ...request, replacementGeometryRevision: geometry.replacementGeometryRevision,
    replacementGeometry: { ...geometry, suspendedTrackSegmentIds: ["ab"] },
  }), /stale operational track mappings/);
});

test("M8 false spatial facts remain impossible and unknown facts require explicit confirmation", () => {
  const disconnected = fixture();
  const falseGeometry = replacementGeometry({ routeCandidates: [{
    ...replacementGeometry().routeCandidates[0], alongRoad: { fullyOnRoad: false },
  }] });
  const base = {
    ...disconnected.input, candidate: undefined, replacementGeometry: falseGeometry,
    replacementGeometryRevision: falseGeometry.replacementGeometryRevision, routeId: "replacement-route:1",
  };
  assert.deepEqual(assessRailReplacementOperation(disconnected.state, base).failures, ["replacement-road-disconnected"]);

  const conditional = fixture();
  const unknownGeometry = replacementGeometry({
    stopCandidates: null,
    routeCandidates: [{
      ...replacementGeometry().routeCandidates[0], alongRoad: { fullyOnRoad: null }, roadWidthMeters: null,
      constraintIdsNear: ["constraint:bridge"],
    }],
  });
  const unknownRequest = {
    ...conditional.input, candidate: undefined, replacementGeometry: unknownGeometry,
    replacementGeometryRevision: unknownGeometry.replacementGeometryRevision, routeId: "replacement-route:1",
  };
  const assessment = assessRailReplacementOperation(conditional.state, unknownRequest);
  assert.equal(assessment.verdict, "conditional");
  assert.deepEqual(assessment.candidate.spatialConstraintIds, ["constraint:bridge"]);
  assert.equal(unknownRequest.confirmSpatialConstraints, undefined);
  assert.deepEqual(assessment.confirmations.sort(), [
    "replacement-road-connection-unknown",
    "replacement-road-width-unknown",
    "replacement-spatial-constraints-unassessed",
    "replacement-stop-connection-unknown",
  ]);
  const roadOnly = assessRailReplacementOperation(conditional.state, { ...unknownRequest, confirmUnknownRoadFacts: true });
  assert.equal(roadOnly.verdict, "conditional");
  const confirmed = assessRailReplacementOperation(conditional.state, {
    ...unknownRequest, confirmUnknownRoadFacts: true, confirmSpatialConstraints: true,
  });
  assert.equal(confirmed.verdict, "feasible");
  assert.deepEqual(confirmed.assumptions.sort(), assessment.confirmations.sort());
});

test("an active replacement bus reconnects split rail services in both routers and carries waiting passengers", () => {
  const { state, line, input } = fixture();
  const operation = startRailReplacementOperation(state, input);
  assert.equal(operation.status, "mobilising");
  state.simMinutes += 60;
  advanceRailReplacementOperations(state, 3_600);
  assert.equal(railReplacementOperationReport(state)[0].status, "active");
  const graph = buildRouteGraph(state);
  const route = findRoute(graph, "A", "D");
  assert.deepEqual(route.hops.map((hop) => hop.lineId), [line.id, operation.virtualLineId, line.id]);
  assert.ok(patternsFromState(state, state.simMinutes * 60).some((pattern) => pattern.routeId === operation.virtualLineId));

  state.passengers.push({ id: 1, originId: "B", destinationId: "C", currentStationId: "B", route: [{ lineId: operation.virtualLineId, boardStationId: "B", alightStationId: "C" }], hopIndex: 0, state: "waiting", trainId: null, spawnedAt: state.simMinutes, waitingSince: state.simMinutes });
  dispatchRailReplacementBuses(state);
  assert.equal(state.passengers[0].state, "onboard");
  assert.ok(popTrains(state).some((vehicle) => vehicle.routeId === operation.virtualLineId));
  state.simMinutes += 500 / 60;
  advanceRailReplacementOperations(state, 500);
  stepRailReplacementBuses(state, 500);
  assert.equal(state.passengers.length, 0);
  assert.equal(state.stats.deliveredByLine[String(line.id)], 1);
  assert.equal(railReplacementOperationReport(state)[0].passengersCarried, 1);
});

test("runtime pays mobilisation and accrued operation cost atomically", () => {
  const { state, input } = fixture();
  const runtime = new ScenarioRuntime({ pack: pack(), operationalState: state });
  const cashBefore = runtime.game.ledger.cash;
  const operation = runtime.startRailReplacementOperation(input);
  assert.equal(runtime.game.ledger.cash, cashBefore - operation.mobilisationCostJPY);
  state.simMinutes += 120;
  advanceRailReplacementOperations(state, 7_200);
  const [settlement] = runtime.settleOperatingDays();
  assert.equal(settlement.dueJPY, 72_000);
  assert.equal(runtime.game.ledger.cash, cashBefore - operation.mobilisationCostJPY - settlement.dueJPY);
  assert.equal(runtime.game.clock.minute, 120);
  assert.deepEqual(runtime.settleRailReplacementOperations(), []);
});

test("an unaffordable mobilisation rolls back the ledger and the operational store", () => {
  const { state, input } = fixture();
  const runtime = new ScenarioRuntime({ pack: pack(), operationalState: state });
  runtime.game.ledger.openingCash = 1;
  runtime.game.player.cash = 1;
  const before = snapshotOperationalState(state);
  assert.throws(() => runtime.startRailReplacementOperation(input), /Insufficient cash/);
  assert.equal(runtime.game.ledger.cash, 1);
  assert.deepEqual(snapshotOperationalState(state), before);
});

test("replacement operations and virtual line ids survive save and restore", () => {
  const { state, input } = fixture();
  startRailReplacementOperation(state, input);
  const restored = restoreOperationalState(JSON.parse(JSON.stringify(snapshotOperationalState(state))));
  assert.deepEqual(restored.railReplacementOperations, state.railReplacementOperations);
  assert.equal(restored.railReplacementOperations.operations[0].virtualLineId, -1);
});

test("resolving the disruption removes replacement routing and ends an idle operation", () => {
  const { state, input } = fixture();
  const runtime = new ScenarioRuntime({ pack: pack(), operationalState: state });
  const operation = runtime.startRailReplacementOperation(input);
  state.simMinutes += 60;
  advanceRailReplacementOperations(state, 3_600);
  assert.ok(buildRouteGraph(state).stationLines.get("B").has(operation.virtualLineId));
  runtime.resolveRailwayDisruption(input.eventId);
  assert.equal(runtime.railReplacementOperationReport()[0].status, "ended");
  assert.equal(buildRouteGraph(state).stationLines.get("B").has(operation.virtualLineId), false);
  const report = runtime.railReplacementOperationReport();
  report[0].stationIds.push("tampered");
  assert.deepEqual(runtime.railReplacementOperationReport()[0].stationIds, ["B", "C"]);
});
