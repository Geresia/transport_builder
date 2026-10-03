import test from "node:test";
import assert from "node:assert/strict";
import { buildThroughServiceManagementView } from "../src/through-service-management-ui.mjs";

const service = (overrides = {}) => ({
  schema: "transitline.through-service/1", contractVersion: 1,
  throughServiceId: "through-service:ui", throughRouteId: "route:ui", routeGeometryRevision: "revision:1",
  status: "assessed", guestModelId: "medium_4car", trainsPerHour: 4, operatorId: "player",
  legs: [{ legId: "leg:a", operatorId: "player", infrastructureOwnerId: "player" }],
  trackAccessAgreementIds: [], vehicleTechnicalOverrides: {}, approvedRetrofitProgramIds: [],
  assessment: { verdict: "possible", violations: [], conditions: [], missingInputs: [] },
  ...overrides,
});

test("management view joins service, fare, retrofit, binding and latest settlement by stable ids", () => {
  const report = {
    throughServices: [service({ status: "approved" })],
    throughFareAgreements: [{ id: "fare:1", throughServiceId: "through-service:ui", status: "active", passengerFareJPY: 300 }],
    vehicleRetrofits: [{ id: "retrofit:1", throughServiceId: "through-service:ui", status: "approved", completedAtMinute: 5 }],
    throughOperationBindings: [{ throughServiceId: "through-service:ui", operationalLineId: "4", actualsByDay: {} }],
    throughOperatingSettlements: [
      { throughServiceId: "through-service:ui", operatingDay: 2 },
      { throughServiceId: "through-service:ui", operatingDay: 7 },
    ],
  };
  const before = structuredClone(report);
  const [view] = buildThroughServiceManagementView(report);
  assert.equal(view.fare.id, "fare:1");
  assert.equal(view.retrofit.id, "retrofit:1");
  assert.equal(view.binding.operationalLineId, "4");
  assert.equal(view.latestSettlement.operatingDay, 7);
  assert.deepEqual(view.operationBlockers, []);
  assert.deepEqual(report, before);
});

test("action gates distinguish assessed, approved, suspended and impossible services", () => {
  const [assessed] = buildThroughServiceManagementView({ throughServices: [service()] });
  assert.equal(assessed.actions.approve, true);
  assert.equal(assessed.actions.proposeFare, true);
  assert.equal(assessed.actions.commission, false);
  const [impossible] = buildThroughServiceManagementView({ throughServices: [service({ assessment: { verdict: "impossible", violations: ["gauge"], conditions: [], missingInputs: [] } })] });
  assert.equal(impossible.actions.approve, false);
  const [suspended] = buildThroughServiceManagementView({ throughServices: [service({ status: "suspended" })] });
  assert.equal(suspended.actions.resume, true);
  assert.equal(suspended.actions.suspend, false);
});

test("an approved service needs both an active fare and a map binding before operation is ready", () => {
  const approved = service({ status: "approved" });
  const [none] = buildThroughServiceManagementView({ throughServices: [approved] });
  assert.deepEqual(none.operationBlockers, ["활성 연락운임 협정 필요", "지도 직통 운행선 연결 필요"]);
  const [fareOnly] = buildThroughServiceManagementView({
    throughServices: [approved],
    throughFareAgreements: [{ throughServiceId: approved.throughServiceId, status: "active" }],
  });
  assert.deepEqual(fareOnly.operationBlockers, ["지도 직통 운행선 연결 필요"]);
  assert.equal(fareOnly.actions.commission, true);
});

test("terminated fare history does not block a replacement agreement", () => {
  const [row] = buildThroughServiceManagementView({
    throughServices: [service({ status: "approved" })],
    throughFareAgreements: [{ id: "fare:old", throughServiceId: "through-service:ui", status: "terminated", terminatedAtMinute: 10 }],
  });
  assert.equal(row.fare.id, "fare:old");
  assert.equal(row.actions.proposeFare, true);
});
