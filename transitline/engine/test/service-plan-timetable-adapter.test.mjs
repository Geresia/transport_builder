import test from "node:test";
import assert from "node:assert/strict";
import { adaptServicePlanToOperationalTimetable, SERVICE_PLAN_TIMETABLE_ADAPTATION_SCHEMA } from "../src/service-plan-timetable-adapter.mjs";
import { addLine, addPhysicalStation, addTrackSegment, createState } from "../src/state.mjs";

function world() {
  const state = createState({ manifest: { id: "adapter", version: "1", data: { license: "test", attribution: [] } }, demand: { points: [] } });
  addPhysicalStation(state, { id: "A", location: [139, 35], status: "available" });
  addPhysicalStation(state, { id: "B", location: [139.01, 35], status: "available" });
  addTrackSegment(state, { id: "ab", fromStationId: "A", toStationId: "B", lengthMeters: 1000, status: "available", directionMode: "double", minimumHeadwayMinutes: 3 });
  const line = addLine(state, ["A", "B"], { frequency: { high: 10 } });
  line.trackSegmentIds = ["ab"]; line.managementServiceId = "service:actual"; line.suspended = false;
  return { state, line, services: [{ id: "service:actual", operationalLineId: line.id, commercialSpeedKph: 30, operatorId: "player" }] };
}
function plan(overrides = {}) {
  return {
    schema: "transitline.service-plan-geometry/1", contractVersion: 1, servicePlanId: "map-plan:1", servicePlanRevision: "rev:1", active: true,
    revision: { state: "current" }, capacityApplicationState: "current", capacityApplicationRevision: "capacity:1", operationalLineId: "line:1",
    playerInputs: { operatingPattern: "full" }, vehicleIntent: { vehicleModelId: null, requestedTrainsets: null },
    route: { sections: [{ trackSegmentId: "ab", traversal: "forward" }] }, spatialFacts: { sections: [{ junctionResourceIds: [] }] },
    directions: [
      { key: "out", fromStationId: "A", toStationId: "B", physicalConnection: true },
      { key: "back", fromStationId: "B", toStationId: "A", physicalConnection: true },
    ],
    serviceBands: [{ bandId: "band:1", operating: true, startMinute: 360, endMinute: 600, playerRequestedHeadwayMinutes: 10, playerRequestedTrainsets: 2, directionKeys: ["out", "back"] }],
    turnbacks: [{ stationId: "B", terminalResourceId: "terminal:B", turnbackCandidateId: null }], ...overrides,
  };
}

function readyContext(w) {
  w.state.railCapacityApplications = [{
    operationalLineId: w.line.id, railGeometryId: "geometry:1", railGeometryRevision: "revision:1",
    sections: [{ trackSegmentId: "ab", railCapacitySectionId: "section:ab", directionMode: "double", blockIds: [], junctionResourceIds: [] }],
    junctions: [], terminals: [{ terminalResourceId: "terminal:B", stationId: "B", platformCandidates: [], turnbackCandidates: [{ turnbackCandidateId: "turnback:B", attached: true }] }],
  }];
  return {
    technicalSpecs: { [w.line.id]: { technicalProfileId: "medium_steel", capacityTrainsPerHour: 20 } },
    vehicleOrders: [{ modelId: "medium_4car", stage: "accepted", quantity: 2, units: [{ id: "set:1", status: "available" }, { id: "set:2", status: "available" }] }],
    operatingResourcePools: [],
  };
}

test("requires an explicit binding and never equates a map plan id with a management service id", () => {
  const w = world(); const out = adaptServicePlanToOperationalTimetable({ servicePlan: plan(), operationalState: w.state, services: w.services });
  assert.equal(out.schema, SERVICE_PLAN_TIMETABLE_ADAPTATION_SCHEMA);
  assert.equal(out.serviceId, null); assert.equal(out.operationalRequest, null);
  assert.ok(out.issues.some((entry) => entry.code === "explicit-management-service-binding-required"));
});

test("builds one B13 request only for a current full bidirectional matching route", () => {
  const w = world(); const out = adaptServicePlanToOperationalTimetable({ servicePlan: plan({ operationalLineId: String(w.line.id), vehicleIntent: { vehicleModelId: "medium_4car", requestedTrainsets: 2 }, turnbacks: [{ stationId: "B", terminalResourceId: "terminal:B", turnbackCandidateId: "turnback:B" }] }), binding: { servicePlanId: "map-plan:1", serviceId: "service:actual" }, operationalState: w.state, services: w.services, prescreenContext: readyContext(w) });
  assert.equal(out.status, "ready");
  assert.deepEqual(out.operationalRequest.servicePlans, [{ serviceId: "service:actual", firstDepartureMinute: 360, lastDepartureMinute: 600, headwayMinutes: 10, terminalResourceId: "terminal:B", turnbackMinutes: 8 }]);
  assert.equal(out.prescreenInput.serviceId, "service:actual");
});

test("does not turn a short route, a one-way plan, a stale map, or a different track into a whole-line B13 timetable", () => {
  const w = world();
  for (const changed of [
    { playerInputs: { operatingPattern: "short-turn" } },
    { directions: [{ key: "out", fromStationId: "A", toStationId: "B", physicalConnection: true }] },
    { revision: { state: "stale" } },
    { route: { sections: [{ trackSegmentId: "other", traversal: "forward" }] } },
  ]) {
    const out = adaptServicePlanToOperationalTimetable({ servicePlan: plan({ operationalLineId: String(w.line.id), ...changed }), binding: { serviceId: "service:actual" }, operationalState: w.state, services: w.services });
    assert.equal(out.operationalRequest, null);
  }
});

test("does not mutate frozen inputs and preserves zero versus unknown in the prescreen input", () => {
  const w = world(); const source = plan({ vehicleIntent: { vehicleModelId: null, requestedTrainsets: 0 }, serviceBands: [{ bandId: "band:1", operating: true, startMinute: 360, endMinute: 600, playerRequestedHeadwayMinutes: 10, playerRequestedTrainsets: 0, directionKeys: ["out", "back"] }] });
  Object.freeze(source); Object.freeze(source.vehicleIntent); Object.freeze(source.serviceBands); Object.freeze(source.serviceBands[0]);
  const out = adaptServicePlanToOperationalTimetable({ servicePlan: { ...source, operationalLineId: String(w.line.id) }, binding: { serviceId: "service:actual" }, operationalState: w.state, services: w.services });
  assert.equal(out.prescreenInput.requestedSets, 0);
  assert.equal(out.prescreenInput.vehicleModelId, null);
});
