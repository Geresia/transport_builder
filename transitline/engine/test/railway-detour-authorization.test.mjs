import test from "node:test";
import assert from "node:assert/strict";
import { assessRailwayDetourAuthorization, authorizeRailwayDetour, railwayDetourAuthorizationReport } from "../src/railway-detour-authorization.mjs";

function state() {
  return { simMinutes: 10, railwayDisruptions: { events: [{ id: "event:1", status: "active" }] }, railwayControlOrders: { orders: [{ id: "order:1", status: "active", eventId: "event:1", controlGeometryId: "control:1", controlGeometryRevision: "rev:1", suspendedTrackSegmentIds: ["track:closed"] }] } };
}
function geometry(overrides = {}) {
  return { schema: "transitline.railway-detour-service-geometry/1", contractVersion: 1, detourGeometryId: "detour:1", detourGeometryRevision: "detour-rev:1", eventId: "event:1", controlGeometryId: "control:1", controlGeometryRevision: "rev:1", affectedTrackSegmentIds: ["track:closed"], connections: [{ connectionId: "connection:1", physicalConnection: true }], legs: [{ legId: "leg:1", sourceKind: "external", externalNetworkId: "net:1", externalLineId: "line:1", externalSpecificationId: "spec:1", externalSpecificationRevision: "spec-rev:1", infrastructureOwnerId: "owner:1", trackSegmentId: null }], ...overrides };
}
function catalog() {
  return { schema: "transitline.external-infrastructure-catalog/1", entries: [{ externalNetworkId: "net:1", externalLineId: "line:1", specificationId: "spec:1", specificationRevision: "spec-rev:1", infrastructureOwnerId: "owner:1", technicalProfileId: "medium_steel", technicalSpecification: { runningSystemId: "steel-wheel", gaugeMm: 1435, carWidthM: 3, maxAxleLoadTonnes: 16, collectionSystemId: "overhead", currentSystem: "dc", voltageV: 1500, minimumCurveRadiusMeters: 160, maxGradientPermille: 35, signalSystemIds: ["ats-p"], platformHeightMm: 1100, doorLayoutId: "4-door-20m", minCars: 4, maxCars: 8, maintenanceSystemId: "medium_steel" }, notApplicable: [], capacityTrainsPerHour: 12 }] };
}
function input(extra = {}) { const detour = geometry(); return { eventId: "event:1", controlOrderId: "order:1", detourGeometry: detour, detourGeometryRevision: detour.detourGeometryRevision, picks: { legIds: ["leg:1"], connectionIds: ["connection:1"] }, vehicleModelId: "medium_4car", trainsPerHour: 6, operatorId: "player", trackAccessAgreementIds: ["access:1"], trackAccessAgreements: [{ id: "access:1", status: "active", infrastructureOwnerId: "owner:1", guestOperatorId: "player" }], externalInfrastructureCatalog: catalog(), ...extra }; }

test("detour authorization requires every source leg and connection, and is read-only while assessing", () => {
  const operational = state(); const request = input(); const before = structuredClone(operational);
  assert.equal(assessRailwayDetourAuthorization(operational, request).verdict, "possible");
  assert.deepEqual(operational, before);
  assert.throws(() => assessRailwayDetourAuthorization(operational, { ...request, picks: { legIds: [], connectionIds: ["connection:1"] } }), /Every detour leg/);
});

test("separated and unmeasured connections never become authorised without the stated confirmation", () => {
  const separated = input({ detourGeometry: geometry({ connections: [{ connectionId: "connection:1", physicalConnection: false }] }) });
  assert.equal(assessRailwayDetourAuthorization(state(), separated).verdict, "impossible");
  const unknown = input({ detourGeometry: geometry({ connections: [{ connectionId: "connection:1", physicalConnection: null }] }) });
  assert.equal(assessRailwayDetourAuthorization(state(), unknown).verdict, "unknown");
  assert.equal(assessRailwayDetourAuthorization(state(), { ...unknown, confirmUnknownConnections: true }).verdict, "possible");
});

test("missing source facts and access authority cannot be confirmed into a running permission", () => {
  assert.equal(assessRailwayDetourAuthorization(state(), input({ externalInfrastructureCatalog: null })).verdict, "unknown");
  assert.equal(assessRailwayDetourAuthorization(state(), input({ trackAccessAgreementIds: [], trackAccessAgreements: [] })).verdict, "conditional");
});

test("authorisation records an exact current revision once and does not create a train route", () => {
  const operational = state(); const authorization = authorizeRailwayDetour(operational, input());
  assert.equal(authorization.status, "authorized"); assert.equal(authorization.detourGeometryRevision, "detour-rev:1");
  assert.equal(operational.lines, undefined); assert.equal(railwayDetourAuthorizationReport(operational).length, 1);
  assert.throws(() => authorizeRailwayDetour(operational, input()), /already has an authorized detour/);
});
