import test from "node:test";
import assert from "node:assert/strict";
import { restoreOperationalState, snapshotOperationalState } from "../src/integrated-save.mjs";
import { buildRouteGraph } from "../src/network.mjs";
import { advanceRailwayDisruptions, railwayDisruptionEffect } from "../src/railway-disruptions.mjs";
import { ScenarioRuntime } from "../src/scenario-runtime.mjs";
import {
  activeRailwayControlOrder,
  clearRailwayControlOrder,
  createRailwayControlOrder,
  createRailwayControlOrderFromGeometry,
  effectiveLineStationGroups,
  effectiveLineStationIds,
  railwayControlOrderReport,
} from "../src/railway-service-control.mjs";
import { addLine, addPhysicalStation, addTrackSegment, createState } from "../src/state.mjs";
import { dispatchTrains } from "../src/trains.mjs";

function sourcePack() {
  return { manifest: { id: "service-control", version: "1", data: { license: "test", attribution: [] } }, demand: { model: "gravity", points: [], attractors: [] } };
}

function fixture() {
  const state = createState(sourcePack());
  for (let index = 0; index < 4; index += 1) addPhysicalStation(state, { id: String.fromCharCode(65 + index), location: [139 + index * 0.01, 35] });
  addTrackSegment(state, { id: "ab", fromStationId: "A", toStationId: "B", directionMode: "double" });
  addTrackSegment(state, { id: "bc", fromStationId: "B", toStationId: "C", directionMode: "double" });
  addTrackSegment(state, { id: "cd", fromStationId: "C", toStationId: "D", directionMode: "double" });
  const line = addLine(state, ["A", "B", "C", "D"], { frequency: { high: 6, medium: 6, low: 6, veryLow: 6 } });
  line.trackSegmentIds = ["ab", "bc", "cd"];
  const event = {
    schema: "transitline.railway-disruption/1", contractVersion: 1, id: "event:1", kind: "signal-failure", status: "active",
    lineId: String(line.id), trackSegmentId: "cd", blockId: null, trainId: null, startedAtMinute: state.simMinutes,
    expectedEndMinute: state.simMinutes + 60, resolvedAtMinute: null, resolutionReason: null,
    effect: { closed: true, speedLimitMps: 0 },
  };
  state.railwayDisruptions.events.push(event);
  return { state, line, event };
}

function mappedControlFixture({ attachment = true } = {}) {
  const { state, line, event } = fixture();
  event.trackSegmentId = "bc";
  const application = {
    schema: "transitline.rail-capacity-application/1", contractVersion: 1,
    operationalLineId: String(line.id), railGeometryId: "geometry:1", railGeometryRevision: "revision:1",
    sections: [
      { trackSegmentId: "ab", railCapacitySectionId: "map:ab" },
      { trackSegmentId: "bc", railCapacitySectionId: "map:bc" },
      { trackSegmentId: "cd", railCapacitySectionId: "map:cd" },
    ],
  };
  state.railCapacityApplications = [application];
  const controlGeometry = {
    schema: "transitline.railway-service-control-geometry/1", contractVersion: 1,
    controlGeometryId: "control:1", controlGeometryRevision: "control-revision:1",
    eventId: event.id, operationalLineId: String(line.id),
    railGeometryId: application.railGeometryId, railGeometryRevision: application.railGeometryRevision,
    turnbackCandidates: [
      { candidateId: "turnback:B", stationId: "B", terminalResourceId: "terminal:B", physicalAttachment: attachment },
      { candidateId: "turnback:C", stationId: "C", terminalResourceId: "terminal:C", physicalAttachment: attachment },
    ],
    partialSuspensionCandidates: [{
      candidateId: "suspension:bc", startStationId: "B", endStationId: "C",
      suspendedSectionIds: ["map:bc"], retainedSectionIds: ["map:ab", "map:cd"],
    }],
  };
  const selection = { partialSuspension: ["suspension:bc"], turnback: ["turnback:B", "turnback:C"] };
  return { state, line, event, controlGeometry, selection };
}

test("a partial suspension removes the disrupted tail from routing and new train movement", () => {
  const { state, line, event } = fixture();
  state.passengers.push({ id: 1, state: "waiting", currentStationId: "A", destinationId: "D", hopIndex: 0, route: [{ lineId: line.id, boardStationId: "A", alightStationId: "D" }] });
  const order = createRailwayControlOrder(state, { kind: "partial-suspension", eventId: event.id, lineId: line.id, startStationId: "A", endStationId: "C" });
  assert.deepEqual(order.retainedStationIds, ["A", "B", "C"]);
  assert.deepEqual(order.omittedStationIds, ["D"]);
  assert.deepEqual(effectiveLineStationIds(state, line), ["A", "B", "C"]);
  const graph = buildRouteGraph(state);
  assert.equal(graph.stationLines.has("D"), false);
  assert.equal(state.passengers[0].route, null);
  state.simMinutes += 11;
  dispatchTrains(state);
  assert.deepEqual(state.trains[0].serviceStationIds, ["A", "B", "C"]);
});

test("a short-turn keeps its terminal resource and records trains already committed to the old path", () => {
  const { state, line, event } = fixture();
  state.trains.push({ id: 91, lineId: line.id, segIndex: 1, dir: 1, t: 0.2, dwell: 0 });
  const order = createRailwayControlOrder(state, {
    kind: "short-turn", eventId: event.id, lineId: line.id, startStationId: "A", endStationId: "C",
    turnbackStationId: "C", terminalResourceId: "terminal:C:1", candidateId: "candidate:turnback:C",
  });
  assert.equal(order.turnbackStationId, "C");
  assert.equal(order.terminalResourceId, "terminal:C:1");
  assert.deepEqual(order.pendingTrainIds, [91]);
  assert.equal(activeRailwayControlOrder(state, line.id).candidateId, "candidate:turnback:C");
});

test("M7 selections split a middle suspension into two independently routed and dispatched services", () => {
  const { state, line, event, controlGeometry, selection } = mappedControlFixture();
  const order = createRailwayControlOrderFromGeometry(state, { controlGeometry, controlGeometryRevision: controlGeometry.controlGeometryRevision, selection });
  assert.equal(order.eventId, event.id);
  assert.equal(order.candidateId, "suspension:bc");
  assert.deepEqual(order.suspendedTrackSegmentIds, ["bc"]);
  assert.deepEqual(order.retainedServices.map((service) => service.stationIds), [["A", "B"], ["C", "D"]]);
  assert.deepEqual(order.retainedServices.map((service) => service.terminalResourceIds), [["terminal:B"], ["terminal:C"]]);
  assert.deepEqual(effectiveLineStationGroups(state, line), [["A", "B"], ["C", "D"]]);

  const graph = buildRouteGraph(state);
  assert.ok(graph.adj.get(`A|${line.id}`).some((edge) => edge.to === `B|${line.id}`));
  assert.ok(graph.adj.get(`C|${line.id}`).some((edge) => edge.to === `D|${line.id}`));
  assert.equal(graph.adj.get(`B|${line.id}`)?.some((edge) => edge.to === `C|${line.id}`) ?? false, false);

  state.simMinutes += 11;
  dispatchTrains(state);
  assert.deepEqual(state.trains.map((train) => train.serviceStationIds), [["A", "B"], ["C", "D"]]);
  assert.deepEqual(state.trains.map((train) => train.terminalResourceId), ["terminal:B", "terminal:C"]);
});

test("M7 selections reject stale, detached and unknown turnbacks unless the unknown fact is explicitly confirmed", () => {
  const stale = mappedControlFixture();
  stale.controlGeometry.controlGeometryRevision = "control-revision:2";
  assert.throws(() => createRailwayControlOrderFromGeometry(stale.state, {
    controlGeometry: stale.controlGeometry, controlGeometryRevision: "control-revision:1", selection: stale.selection,
  }), /revision is stale/);
  assert.equal(stale.state.railwayControlOrders.orders.length, 0);

  const detached = mappedControlFixture({ attachment: false });
  assert.throws(() => createRailwayControlOrderFromGeometry(detached.state, { ...detached, controlGeometryRevision: detached.controlGeometry.controlGeometryRevision }), /physically detached/);
  assert.equal(detached.state.railwayControlOrders.orders.length, 0);

  const unknown = mappedControlFixture({ attachment: null });
  assert.throws(() => createRailwayControlOrderFromGeometry(unknown.state, { ...unknown, controlGeometryRevision: unknown.controlGeometry.controlGeometryRevision }), /unconfirmed physical attachment/);
  const order = createRailwayControlOrderFromGeometry(unknown.state, { ...unknown, controlGeometryRevision: unknown.controlGeometry.controlGeometryRevision, confirmUnknownPhysicalAttachment: true });
  assert.deepEqual(order.assumptions, ["turnback-attachment-unconfirmed:turnback:B", "turnback-attachment-unconfirmed:turnback:C"]);
});

test("multi-section control orders survive save and restore without collapsing to the first side", () => {
  const { state, line, controlGeometry, selection } = mappedControlFixture();
  createRailwayControlOrderFromGeometry(state, { controlGeometry, controlGeometryRevision: controlGeometry.controlGeometryRevision, selection });
  const restored = restoreOperationalState(JSON.parse(JSON.stringify(snapshotOperationalState(state))));
  assert.deepEqual(effectiveLineStationGroups(restored, restored.lines.find((entry) => entry.id === line.id)), [["A", "B"], ["C", "D"]]);
  assert.deepEqual(restored.railwayControlOrders, state.railwayControlOrders);
});

test("a physical disruption can control another service sharing the same track", () => {
  const { state, event } = fixture();
  const shared = addLine(state, ["A", "B", "C", "D"]);
  shared.trackSegmentIds = ["ab", "bc", "cd"];
  const order = createRailwayControlOrder(state, {
    kind: "partial-suspension", eventId: event.id, lineId: shared.id, startStationId: "A", endStationId: "C",
  });
  assert.equal(order.lineId, String(shared.id));
  assert.deepEqual(effectiveLineStationIds(state, shared), ["A", "B", "C"]);
});

test("orders fail atomically when they retain the disrupted section, use an invalid path, or overlap", () => {
  const { state, line, event } = fixture();
  const before = snapshotOperationalState(state);
  assert.throws(() => createRailwayControlOrder(state, { kind: "partial-suspension", eventId: event.id, lineId: line.id, startStationId: "B", endStationId: "D" }), /still crosses/);
  assert.deepEqual(snapshotOperationalState(state), before);
  assert.throws(() => createRailwayControlOrder(state, { kind: "partial-suspension", eventId: event.id, lineId: line.id, startStationId: "A", endStationId: "missing" }), /two distinct stations/);
  assert.deepEqual(snapshotOperationalState(state), before);
  createRailwayControlOrder(state, { kind: "partial-suspension", eventId: event.id, lineId: line.id, startStationId: "A", endStationId: "C" });
  assert.throws(() => createRailwayControlOrder(state, { kind: "short-turn", eventId: event.id, lineId: line.id, startStationId: "A", endStationId: "B" }), /already has an active/);
});

test("manual clear restores routing and reports are detached", () => {
  const { state, line, event } = fixture();
  const order = createRailwayControlOrder(state, { kind: "partial-suspension", eventId: event.id, lineId: line.id, startStationId: "A", endStationId: "C" });
  clearRailwayControlOrder(state, order.id, { reason: "dispatcher-cancelled" });
  assert.deepEqual(effectiveLineStationIds(state, line), line.stationIds);
  const report = railwayControlOrderReport(state);
  assert.equal(report[0].endReason, "dispatcher-cancelled");
  report[0].retainedStationIds.push("tampered");
  assert.deepEqual(state.railwayControlOrders.orders[0].retainedStationIds, ["A", "B", "C"]);
});

test("resolving a disruption ends its control order and restores the full service path", () => {
  const { state, line, event } = fixture();
  const runtime = new ScenarioRuntime({ pack: sourcePack(), operationalState: state });
  runtime.issueRailwayControlOrder({ kind: "partial-suspension", eventId: event.id, lineId: line.id, startStationId: "A", endStationId: "C" });
  runtime.resolveRailwayDisruption(event.id);
  assert.equal(runtime.railwayControlOrderReport()[0].status, "ended");
  assert.equal(runtime.railwayControlOrderReport()[0].endReason, "disruption-resolved");
  assert.deepEqual(effectiveLineStationIds(state, line), ["A", "B", "C", "D"]);
});

test("response choice changes recovery time, cash and reputation in one transaction", () => {
  const { state, event } = fixture();
  const runtime = new ScenarioRuntime({ pack: sourcePack(), operationalState: state });
  const cashBefore = runtime.game.ledger.cash;
  const reputationBefore = runtime.game.player.reputation;
  const response = runtime.respondRailwayDisruption(event.id, "emergency-recovery");
  assert.equal(response.directCostJPY, 70_000_000);
  assert.equal(runtime.game.ledger.cash, cashBefore - response.directCostJPY);
  assert.equal(runtime.game.player.reputation, reputationBefore + 1);
  assert.equal(event.status, "responding");
  assert.equal(event.expectedEndMinute, event.startedAtMinute + 27);
  assert.equal(railwayDisruptionEffect(state, { lineId: event.lineId, trackSegmentId: event.trackSegmentId }).closed, true);
  assert.throws(() => runtime.respondRailwayDisruption(event.id, "standard-recovery"), /while responding/);
  state.simMinutes = state.railwayDisruptions.events[0].expectedEndMinute;
  advanceRailwayDisruptions(state);
  assert.equal(state.railwayDisruptions.events[0].status, "resolved");
});

test("an unaffordable response rolls management and operational event state back together", () => {
  const { state, event } = fixture();
  const runtime = new ScenarioRuntime({ pack: sourcePack(), operationalState: state });
  runtime.game.ledger.openingCash = 1;
  runtime.game.player.cash = 1;
  const before = snapshotOperationalState(state);
  assert.throws(() => runtime.respondRailwayDisruption(event.id, "emergency-recovery"), /Insufficient cash/);
  assert.deepEqual(snapshotOperationalState(state), before);
  assert.equal(runtime.game.ledger.cash, 1);
  assert.equal(runtime.game.player.cash, 1);
});

test("control orders and responding events survive operational save and restore", () => {
  const { state, line, event } = fixture();
  const runtime = new ScenarioRuntime({ pack: sourcePack(), operationalState: state });
  runtime.issueRailwayControlOrder({ kind: "short-turn", eventId: event.id, lineId: line.id, startStationId: "A", endStationId: "C", turnbackStationId: "C" });
  runtime.respondRailwayDisruption(event.id, "safety-investigation");
  const restored = restoreOperationalState(JSON.parse(JSON.stringify(snapshotOperationalState(state))));
  assert.deepEqual(restored.railwayControlOrders, state.railwayControlOrders);
  assert.deepEqual(restored.railwayDisruptions, state.railwayDisruptions);
  assert.deepEqual(effectiveLineStationIds(restored, restored.lines[0]), ["A", "B", "C"]);
});
