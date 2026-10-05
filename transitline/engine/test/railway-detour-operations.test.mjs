import test from "node:test";
import assert from "node:assert/strict";
import { advanceRailwayDetourOperations, markRailwayDetourSettled, railwayDetourOperationReport, railwayDetourSettlementDue, startRailwayDetourOperation } from "../src/railway-detour-operations.mjs";
import { ScenarioRuntime } from "../src/scenario-runtime.mjs";
import { createState } from "../src/state.mjs";

function state() {
  return {
    simMinutes: 10,
    railwayDisruptions: { events: [{ id: "event:1", status: "active" }] },
    railwayControlOrders: { orders: [{ id: "order:1", status: "active", eventId: "event:1" }] },
    railwayDetourAuthorizations: { nextSequence: 2, authorizations: [{ id: "authorization:1", status: "authorized", eventId: "event:1", controlOrderId: "order:1", detourGeometryId: "geometry:1", detourGeometryRevision: "revision:1", vehicleModelId: "medium_4car", trainsPerHour: 6, detourLengthMeters: 12_000, trackAccessAgreementIds: ["access:1"] }] },
  };
}

test("an authorized measured detour becomes an operational state and accrues train and access use", () => {
  const operational = state();
  const operation = startRailwayDetourOperation(operational, { authorizationId: "authorization:1" });
  assert.equal(operation.status, "active");
  advanceRailwayDetourOperations(operational, 3600);
  const due = railwayDetourSettlementDue(operational);
  assert.equal(due.length, 1);
  assert.equal(due[0].operationId, operation.id);
  assert.equal(due[0].operatingDueJPY, 288_000);
  assert.equal(due[0].accessDueJPY, 30_240);
  markRailwayDetourSettled(operational, operation.id, due[0]);
  assert.deepEqual(railwayDetourSettlementDue(operational), []);
});

test("an operation cannot silently start from an unmeasured route and ends once the incident ends", () => {
  const unknown = state();
  delete unknown.railwayDetourAuthorizations.authorizations[0].detourLengthMeters;
  assert.throws(() => startRailwayDetourOperation(unknown, { authorizationId: "authorization:1" }), /measured detour length/);
  const operational = state();
  const operation = startRailwayDetourOperation(operational, { authorizationId: "authorization:1" });
  operational.railwayDisruptions.events[0].status = "resolved";
  operational.simMinutes += 10;
  advanceRailwayDetourOperations(operational, 600);
  assert.deepEqual(railwayDetourOperationReport(operational).map((entry) => ({ id: entry.id, status: entry.status, endReason: entry.endReason })), [{ id: operation.id, status: "ended", endReason: "disruption-or-control-ended" }]);
});

test("settlement rejects partial or inflated amounts", () => {
  const operational = state();
  const operation = startRailwayDetourOperation(operational, { authorizationId: "authorization:1" });
  advanceRailwayDetourOperations(operational, 3600);
  const due = railwayDetourSettlementDue(operational)[0];
  assert.throws(() => markRailwayDetourSettled(operational, operation.id, { ...due, accessDueJPY: due.accessDueJPY + 1 }), /equal the current due/);
});

test("a caller cannot lower engine-owned detour cost assumptions", () => {
  const operational = state();
  const operation = startRailwayDetourOperation(operational, { authorizationId: "authorization:1", costAssumptions: { trainCrewAndEnergyJPYPerTrainHour: 0, trackAccessJPYPerTrainKm: 0, averageCommercialSpeedKph: 999 } });
  assert.equal(operation.trainCrewAndEnergyJPYPerTrainHour, 180_000);
  assert.equal(operation.trackAccessJPYPerTrainKm, 420);
  assert.equal(operation.averageCommercialSpeedKph, 45);
});

test("runtime posts both detour cost categories once and rolls back an unaffordable settlement", () => {
  const pack = { manifest: { id: "detour-operations", version: "1", data: { license: "test", attribution: [] } }, demand: { model: "gravity", points: [], attractors: [] } };
  const operational = createState(pack);
  Object.assign(operational, state());
  const runtime = new ScenarioRuntime({ pack, operationalState: operational });
  const operation = runtime.startRailwayDetourOperation({ authorizationId: "authorization:1" });
  operational.simMinutes += 60;
  advanceRailwayDetourOperations(operational, 3600);
  const due = railwayDetourSettlementDue(operational)[0];
  const cashBefore = runtime.game.ledger.cash;
  const settled = runtime.settleRailwayDetourOperations()[0];
  assert.deepEqual(settled, due);
  assert.equal(runtime.game.ledger.cash, cashBefore - due.operatingDueJPY - due.accessDueJPY);
  assert.deepEqual(runtime.settleRailwayDetourOperations(), []);

  operational.railwayDetourAuthorizations.authorizations.push({ ...operational.railwayDetourAuthorizations.authorizations[0], id: "authorization:2", controlOrderId: "order:2" });
  operational.railwayControlOrders.orders.push({ id: "order:2", status: "active", eventId: "event:1" });
  runtime.startRailwayDetourOperation({ authorizationId: "authorization:2" });
  operational.simMinutes += 60;
  advanceRailwayDetourOperations(operational, 3600);
  const before = structuredClone(operational.railwayDetourOperations);
  runtime.game.ledger.openingCash = 1;
  runtime.game.player.cash = 1;
  const cashBeforeFailure = runtime.game.ledger.cash;
  assert.throws(() => runtime.settleRailwayDetourOperations(), /Insufficient cash/);
  assert.equal(runtime.game.ledger.cash, cashBeforeFailure);
  assert.deepEqual(operational.railwayDetourOperations, before);
  assert.equal(railwayDetourOperationReport(operational).find((entry) => entry.id === operation.id).settledOperatingCostJPY, due.operatingDueJPY);
});
