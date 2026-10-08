import test from "node:test";
import assert from "node:assert/strict";
import { ScenarioRuntime } from "../src/scenario-runtime.mjs";
import { addLine, addPhysicalStation, addTrackSegment, createState } from "../src/state.mjs";
import { snapshotOperationalState } from "../src/integrated-save.mjs";

const SPEC = { runningSystemId: "steel-wheel", gaugeMm: 1435, carWidthM: 2.9, maxAxleLoadTonnes: 16, collectionSystemId: "overhead", currentSystem: "dc", voltageV: 1500, minimumCurveRadiusMeters: 200, maxGradientPermille: 30, signalSystemIds: ["ats-p"], platformHeightMm: 1100, doorLayoutId: "4-door-20m", minCars: 4, maxCars: 10, maintenanceSystemId: "medium_steel" };

function pack() { return { manifest: { id: "service-plan-runtime", version: "1", data: { license: "test", attribution: [] } }, demand: { model: "gravity", points: [], attractors: [] } }; }
function setup() {
  const state = createState(pack());
  addPhysicalStation(state, { id: "A", location: [139, 35], status: "available" });
  addPhysicalStation(state, { id: "B", location: [139.01, 35], status: "available" });
  addTrackSegment(state, { id: "ab", fromStationId: "A", toStationId: "B", lengthMeters: 1000, status: "available", directionMode: "double", minimumHeadwayMinutes: 3, capacityTrainsPerHour: 20 });
  const line = addLine(state, ["A", "B"]); line.trackSegmentIds = ["ab"]; line.managementServiceId = "service:actual"; line.suspended = false;
  state.railCapacityApplications = [{ operationalLineId: line.id, railGeometryId: "geometry:1", railGeometryRevision: "revision:1", sections: [{ trackSegmentId: "ab", railCapacitySectionId: "section:ab", directionMode: "double", blockIds: [], junctionResourceIds: [] }], junctions: [], terminals: [{ terminalResourceId: "terminal:B", stationId: "B", platformCandidates: [], turnbackCandidates: [{ turnbackCandidateId: "turnback:B", attached: true }] }] }];
  const runtime = new ScenarioRuntime({ pack: pack(), operationalState: state });
  runtime.game.services.push({ id: "service:actual", operationalLineId: line.id, commercialSpeedKph: 30, operatorId: "player" });
  const servicePlan = {
    schema: "transitline.service-plan-geometry/1", contractVersion: 1, servicePlanId: "map-plan:1", servicePlanRevision: "map-revision:1", active: true,
    revision: { state: "current" }, capacityApplicationState: "current", capacityApplicationRevision: "revision:1", operationalLineId: String(line.id), playerInputs: { operatingPattern: "full" },
    route: { sections: [{ trackSegmentId: "ab", traversal: "forward" }] }, spatialFacts: { sections: [{ junctionResourceIds: [] }] },
    directions: [{ key: "out", fromStationId: "A", toStationId: "B", physicalConnection: true }, { key: "back", fromStationId: "B", toStationId: "A", physicalConnection: true }],
    serviceBands: [{ bandId: "band:1", operating: true, startMinute: 360, endMinute: 420, playerRequestedHeadwayMinutes: 10, playerRequestedTrainsets: 2, directionKeys: ["out", "back"] }],
    turnbacks: [{ stationId: "B", terminalResourceId: "terminal:B", turnbackCandidateId: "turnback:B" }], vehicleIntent: { vehicleModelId: "medium_4car", requestedTrainsets: 2 },
  };
  const input = { technicalSpecs: { [line.id]: { technicalSpecification: SPEC, capacityTrainsPerHour: 20 } }, vehicleOrders: [{ modelId: "medium_4car", stage: "accepted", quantity: 2, units: [{ id: "set:1", status: "available" }, { id: "set:2", status: "available" }] }], operatingResourcePools: [], infrastructureAssumptions: { directionMode: "double", minimumHeadwayMinutes: 3 } };
  return { runtime, state, servicePlan, input };
}

test("a ready mapped plan delegates exactly once to the existing B13 timetable assessment", () => {
  const { runtime, servicePlan, input } = setup();
  const result = runtime.assessServicePlanTimetable(servicePlan, { servicePlanId: "map-plan:1", serviceId: "service:actual" }, input);
  assert.equal(result.adaptation.status, "ready");
  assert.equal(result.timetable.schema, "transitline.railway-timetable/1");
  assert.equal(runtime.railwayTimetableReport().length, 1);
  assert.equal(result.timetable.operationalFacts.serviceIds[0], "service:actual");
});

test("an unbound or stale plan produces an explanation but cannot assess or mutate a timetable", () => {
  const { runtime, state, servicePlan, input } = setup();
  const before = JSON.stringify({ game: runtime.game.snapshot(), state: snapshotOperationalState(state) });
  for (const [plan, binding] of [[servicePlan, {}], [{ ...servicePlan, revision: { state: "stale" } }, { serviceId: "service:actual" }]]) {
    const result = runtime.assessServicePlanTimetable(plan, binding, input);
    assert.equal(result.timetable, null);
  }
  assert.equal(JSON.stringify({ game: runtime.game.snapshot(), state: snapshotOperationalState(state) }), before);
});

test("a batch is one B13 allocation, so plans using the same track compete", () => {
  const { runtime, state, servicePlan, input } = setup();
  const secondLine = addLine(state, ["A", "B"]);
  secondLine.trackSegmentIds = ["ab"];
  secondLine.managementServiceId = "service:second";
  secondLine.suspended = false;
  state.railCapacityApplications.push({ ...structuredClone(state.railCapacityApplications[0]), operationalLineId: secondLine.id });
  input.technicalSpecs[secondLine.id] = structuredClone(input.technicalSpecs[1]);
  runtime.game.services.push({ id: "service:second", operationalLineId: secondLine.id, commercialSpeedKph: 30, operatorId: "player" });
  const second = structuredClone(servicePlan);
  second.servicePlanId = "map-plan:2";
  second.servicePlanRevision = "map-revision:2";
  second.operationalLineId = String(secondLine.id);
  const batch = runtime.assessServicePlanTimetableBatch([
    { servicePlan, binding: { servicePlanId: "map-plan:1", serviceId: "service:actual" } },
    { servicePlan: second, binding: { servicePlanId: "map-plan:2", serviceId: "service:second" } },
  ], input);
  assert.equal(batch.adaptations.length, 2);
  assert.equal(runtime.railwayTimetableReport().length, 1);
  assert.equal(batch.timetable.requestedPaths, 28);
  assert.ok(batch.timetable.rejectedPaths.length > 0);
  assert.equal(batch.timetable.assessment.verdict, "conditional");
});

test("a rejected member rolls a batch back without leaving a timetable", () => {
  const { runtime, state, servicePlan, input } = setup();
  const before = JSON.stringify({ game: runtime.game.snapshot(), state: snapshotOperationalState(state) });
  assert.throws(() => runtime.assessServicePlanTimetableBatch([
    { servicePlan, binding: { servicePlanId: "map-plan:1", serviceId: "service:actual" } },
    { servicePlan: { ...servicePlan, servicePlanId: "map-plan:stale", revision: { state: "stale" } }, binding: { servicePlanId: "map-plan:stale", serviceId: "service:actual" } },
  ], input), /not ready/);
  assert.equal(JSON.stringify({ game: runtime.game.snapshot(), state: snapshotOperationalState(state) }), before);
});
