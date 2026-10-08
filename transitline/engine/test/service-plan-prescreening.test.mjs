import test from "node:test";
import assert from "node:assert/strict";
import { snapshotOperationalState } from "../src/integrated-save.mjs";
import { applyRailCapacityGeometry } from "../src/rail-capacity-integration.mjs";
import { addLine, addPhysicalStation, addTrackSegment, createState } from "../src/state.mjs";
import { DEFERRED_TO_B13, SERVICE_PLAN_PRESCREENING_SCHEMA, prescreenServicePlan, prescreenServicePlans } from "../src/service-plan-prescreening.mjs";

// The B16-M1 plan contract does not exist yet, so the plan below is a synthetic fixture of the fields E1 reads; everything else
// (operational state, B13 rail-capacity application, vehicle model, vehicle orders, pools) is built through the real code.
const SPEC = Object.freeze({
  runningSystemId: "steel-wheel", gaugeMm: 1435, carWidthM: 2.9, maxAxleLoadTonnes: 16, collectionSystemId: "overhead", currentSystem: "dc", voltageV: 1500,
  minimumCurveRadiusMeters: 200, maxGradientPermille: 30, signalSystemIds: ["ats-p"], platformHeightMm: 1100, doorLayoutId: "4-door-20m", minCars: 4, maxCars: 10, maintenanceSystemId: "medium_steel",
});

function geometry() {
  return {
    schema: "transitline.rail-capacity-geometry/1", contractVersion: 1, railGeometryId: "geometry:1", railGeometryRevision: "geometry-revision:1", revision: { state: "current" },
    sections: [
      { sectionId: "section:ab", fromStationId: "map:A", toStationId: "map:B", directionMode: "double", blockIds: ["block:1"], junctionResourceIds: ["junction:1"] },
      { sectionId: "section:bc", fromStationId: "map:B", toStationId: "map:C", directionMode: "single", blockIds: ["block:2"], junctionResourceIds: [] },
    ],
    blocks: [
      { blockId: "block:1", sectionId: "section:ab", startAlongMeters: 0, endAlongMeters: 1000, blockLengthMeters: 1000, startBoundary: {}, endBoundary: {} },
      { blockId: "block:2", sectionId: "section:bc", startAlongMeters: 0, endAlongMeters: 1000, blockLengthMeters: 1000, startBoundary: {}, endBoundary: {} },
    ],
    junctions: [{ junctionResourceId: "junction:1", kind: "turnout", attachedToAllSections: true, missingRoles: [] }],
    terminals: [{
      terminalResourceId: "terminal:c", stationId: "map:C", approachSectionIds: ["section:bc"],
      platformCandidates: [{ platformCandidateId: "platform:c1" }],
      turnbackCandidates: [{ turnbackCandidateId: "turnback:c1", attached: true }, { turnbackCandidateId: "turnback:c2", attached: false }],
    }],
    closureTargets: [],
  };
}

function world() {
  const state = createState({ manifest: { id: "prescreen", version: "1" }, demand: { model: "gravity", points: [], attractors: [] } });
  addPhysicalStation(state, { id: "A", sourceStationId: "map:A", location: [139, 35] });
  addPhysicalStation(state, { id: "B", sourceStationId: "map:B", location: [139.01, 35] });
  addPhysicalStation(state, { id: "C", sourceStationId: "map:C", location: [139.02, 35] });
  addTrackSegment(state, { id: "track:ab", fromStationId: "A", toStationId: "B", lengthMeters: 1000 });
  addTrackSegment(state, { id: "track:bc", fromStationId: "B", toStationId: "C", lengthMeters: 1000 });
  const line = addLine(state, ["A", "B", "C"]);
  line.trackSegmentIds = ["track:ab", "track:bc"];
  line.managementServiceId = "service:1";
  applyRailCapacityGeometry(state, { lineId: line.id, geometry: geometry() });
  const unit = (n, status = "available") => ({ id: `order:1:set-${n}`, modelId: "medium_4car", status });
  return {
    state,
    line,
    plan: { servicePlanId: "plan:1", serviceId: "service:1", vehicleModelId: "medium_4car", requestedSets: 2, terminalResourceId: "terminal:c", mapRevision: { state: "current" } },
    context: {
      operationalState: state,
      technicalSpecs: { [line.id]: { technicalSpecification: { ...SPEC }, capacityTrainsPerHour: 12 } },
      vehicleOrders: [{ id: "order:1", modelId: "medium_4car", stage: "accepted", quantity: 3, units: [unit(1), unit(2), unit(3)] }],
      operatingResourcePools: [{ id: "pool:1", assignments: [] }],
    },
  };
}

const find = (report, checkId) => report.checks.find((entry) => entry.checkId === checkId);
const statusOf = (report, checkId) => find(report, checkId)?.status;
// A reason names a failure of one kind only, so it is checked together with the verdict it must carry.
const IMPOSSIBLE = new Set(["service-has-no-operational-line", "terminal-resource-absent", "terminal-not-on-line", "turnback-not-connected", "turnback-candidate-absent", "no-turnback-candidate", "junction-separated", "plan-junction-absent", "fleet-insufficient", "track-segment-not-available", "map-revision-stale"]);
const CONDITIONAL = new Set(["line-suspended", "platform-turnback-only", "fleet-needs-reassignment-recovery-or-delivery"]);
function assertReason(report, checkId, reason) {
  const entry = find(report, checkId);
  assert.equal(entry?.reason, reason);
  assert.equal(entry.status, IMPOSSIBLE.has(reason) ? "impossible" : CONDITIONAL.has(reason) ? "conditional" : "unknown", `${checkId}: ${reason}`);
}
const run = (mutate) => { const w = world(); mutate?.(w); return { w, report: prescreenServicePlan(w.plan, w.context) }; };

test("a plan whose every checked fact is stated and fits is possible, with B13's judgements listed as deferred", () => {
  const { report } = run();
  assert.equal(report.schema, SERVICE_PLAN_PRESCREENING_SCHEMA);
  assert.equal(report.verdict, "possible");
  assert.deepEqual(report.areas, { plan: "possible", line: "possible", technical: "possible", fleet: "possible", track: "possible" });
  assert.deepEqual([report.blockers, report.missingInputs, report.conditions], [[], [], []]);
  assert.deepEqual(report.deferredToB13, [...DEFERRED_TO_B13]);
  assert.equal(report.lineId, "1");
  for (const entry of report.checks) assert.deepEqual(Object.keys(entry), ["checkId", "area", "status", "reason", "facts"]);
});

test("the report is deterministic, input-order independent and carries no cost, fare, demand or crowding field", () => {
  const { w, report } = run();
  assert.deepEqual(prescreenServicePlan(w.plan, w.context), report);
  assert.ok(!/cost|fare|demand|crowd|revenue|passenger/i.test(JSON.stringify(Object.keys(report).concat(report.checks.map((entry) => entry.checkId)))));
  const other = { ...w.plan, servicePlanId: "plan:0" };
  assert.deepEqual(prescreenServicePlans([w.plan, other], w.context).map((entry) => entry.servicePlanId), ["plan:0", "plan:1"]);
  assert.deepEqual(prescreenServicePlans([other, w.plan], w.context), prescreenServicePlans([w.plan, other], w.context));
  assert.deepEqual(prescreenServicePlans(null), []);
});

test("it never changes its inputs and uses no random number or clock", () => {
  const { w } = run();
  const bytes = () => JSON.stringify({ state: snapshotOperationalState(w.state), plan: w.plan, specs: w.context.technicalSpecs, orders: w.context.vehicleOrders, pools: w.context.operatingResourcePools });
  const before = bytes();
  const { random, now } = { random: Math.random, now: Date.now };
  Math.random = () => { throw new Error("random"); };
  Date.now = () => { throw new Error("clock"); };
  try {
    const report = prescreenServicePlan(w.plan, w.context);
    report.checks[0].facts.tampered = true;
    report.deferredToB13.push("tampered");
  } finally { Math.random = random; Date.now = now; }
  assert.equal(bytes(), before);
  assert.equal(DEFERRED_TO_B13.length, 6);
});

test("worst-check precedence: a certain blocker outranks a missing fact, which outranks a condition", () => {
  const { report } = run((w) => { w.context.technicalSpecs[w.line.id].technicalSpecification = { ...SPEC, gaugeMm: 1067, signalSystemIds: null }; });
  assert.equal(report.verdict, "impossible");
  assert.equal(run((w) => { w.line.suspended = true; w.plan.mapRevision = {}; }).report.verdict, "unknown");
  assert.equal(run((w) => { w.line.suspended = true; }).report.verdict, "conditional");
});

test("malformed or empty plans are reported as unknown rather than thrown", () => {
  for (const plan of [null, undefined, "x", [], {}]) {
    const report = prescreenServicePlan(plan, {});
    assert.equal(report.verdict, "unknown");
    assert.ok(report.missingInputs.includes("service-id-missing"));
  }
  assert.equal(prescreenServicePlan({ servicePlanId: "p", serviceId: "service:1" }).verdict, "unknown");
});

test("map revision: stale blocks the plan, an unstated revision is unknown", () => {
  assert.deepEqual(run((w) => { w.plan.mapRevision = { state: "stale" }; }).report.blockers, ["map-revision-stale"]);
  assert.equal(statusOf(run((w) => { delete w.plan.mapRevision; }).report, "map-revision"), "unknown");
});

test("service-to-line mapping: no line is impossible, several lines or no state are unknown", () => {
  const none = run((w) => { w.plan.serviceId = "service:9"; }).report;
  assert.equal(none.blockers[0], "service-has-no-operational-line");
  assert.equal(none.lineId, null);
  const two = run((w) => { const second = addLine(w.state, ["A", "B"]); second.managementServiceId = "service:1"; }).report;
  assert.equal(statusOf(two, "operational-line"), "unknown");
  assertReason(two, "operational-line", "service-maps-to-several-lines");
  const noState = prescreenServicePlan({ servicePlanId: "p", serviceId: "service:1" }, {});
  assertReason(noState, "operational-line", "operational-state-missing");
});

test("a suspended line is conditional; a missing or unavailable station / track segment is impossible; an unstated status is unknown", () => {
  assertReason(run((w) => { w.line.suspended = true; }).report, "line-suspension", "line-suspended");
  assert.equal(statusOf(run((w) => { delete w.line.suspended; }).report, "line-suspension"), "unknown");
  assert.equal(statusOf(run((w) => { w.state.stations.get("B").status = "closed"; }).report, "station-state"), "impossible");
  assert.equal(statusOf(run((w) => { w.state.stations.delete("B"); }).report, "station-state"), "impossible");
  assert.equal(statusOf(run((w) => { delete w.state.stations.get("B").status; }).report, "station-state"), "unknown");
  assertReason(run((w) => { w.state.trackSegments[1].status = "closed"; }).report, "track-state", "track-segment-not-available");
  assert.equal(statusOf(run((w) => { delete w.line.trackSegmentIds; }).report, "track-state"), "unknown");
});

test("technical fit: a mismatching limit is impossible, a null fact is unknown (never compatible)", () => {
  const gauge = run((w) => { w.context.technicalSpecs[w.line.id].technicalSpecification = { ...SPEC, gaugeMm: 1067 }; }).report;
  assert.equal(statusOf(gauge, "technical:gauge"), "impossible");
  assert.ok(gauge.blockers.includes("gauge-not-supported"));
  assert.equal(gauge.areas.technical, "impossible");
  const nullGauge = run((w) => { w.context.technicalSpecs[w.line.id].technicalSpecification = { ...SPEC, gaugeMm: null }; }).report;
  assert.equal(statusOf(nullGauge, "technical:gauge"), "unknown");
  assert.equal(nullGauge.verdict, "unknown");
  assert.equal(statusOf(run((w) => { w.context.technicalSpecs[w.line.id].technicalSpecification = { ...SPEC, maxCars: 3 }; }).report, "technical:formation"), "impossible");
  assert.equal(statusOf(run((w) => { w.context.technicalSpecs[w.line.id].technicalSpecification = { ...SPEC, signalSystemIds: ["other"] }; }).report, "technical:signal-system"), "impossible");
});

test("technical fit: a gauge declared not applicable is not a mismatch, a profile id alone is enough, and unusable specs are unknown", () => {
  const agt = run((w) => { w.plan.vehicleModelId = "agt_3car"; w.context.technicalSpecs[w.line.id] = { technicalSpecification: { runningSystemId: "rubber-tire-guideway", gaugeMm: null }, notApplicable: ["gaugeMm"] }; }).report;
  assert.equal(statusOf(agt, "technical:gauge"), "possible");
  assert.equal(statusOf(agt, "technical:signal-system"), "unknown");
  const profile = run((w) => { w.context.technicalSpecs[w.line.id] = { technicalProfileId: "medium_steel" }; }).report;
  assert.ok(profile.checks.some((entry) => entry.checkId === "technical:formation"));
  assert.equal(statusOf(profile, "technical:running-system"), "possible");
  const unknownProfile = run((w) => { w.context.technicalSpecs[w.line.id] = { technicalProfileId: "nope" }; }).report;
  assertReason(unknownProfile, "line-technical-spec", "line-technical-spec-unusable");
  assertReason(run((w) => { delete w.context.technicalSpecs; }).report, "line-technical-spec", "line-technical-spec-missing");
  assert.equal(find(run((w) => { w.context.technicalSpecs[w.line.id] = {}; }).report, "line-technical-spec").status, "unknown");
});

test("vehicle model: none selected or not in the catalogue is unknown, and the fleet check does not guess", () => {
  const none = run((w) => { delete w.plan.vehicleModelId; }).report;
  assert.equal(statusOf(none, "vehicle-model"), "unknown");
  assertReason(none, "fleet-sets", "vehicle-model-not-usable");
  const unknown = run((w) => { w.plan.vehicleModelId = "ghost_9car"; }).report;
  assertReason(unknown, "vehicle-model", "vehicle-model-unknown");
  assert.equal(unknown.verdict, "unknown");
});

test("fleet: enough free sets is possible; units of the plan's own service count as free", () => {
  const ok = run().report;
  assert.deepEqual(find(ok, "fleet-sets").facts, { requestedSets: 2, vehicleModelId: "medium_4car", owned: 3, onOrder: 0, available: 3, recovering: 0, unrecognisedStatus: 0, assignedToOtherServices: 0, free: 3 });
  const own = run((w) => { w.plan.requestedSets = 3; w.context.operatingResourcePools = [{ assignments: [{ serviceId: "service:1", primaryUnitIds: ["order:1:set-1", "order:1:set-2", "order:1:set-3"] }] }]; }).report;
  assert.equal(statusOf(own, "fleet-sets"), "possible");
});

test("fleet: units assigned to another service, recovering units or units still on order make it conditional, and say which", () => {
  const elsewhere = run((w) => { w.plan.requestedSets = 3; w.context.operatingResourcePools = [{ assignments: [{ serviceId: "service:2", primaryUnitIds: ["order:1:set-3"] }] }]; }).report;
  assert.equal(statusOf(elsewhere, "fleet-sets"), "conditional");
  assert.deepEqual(find(elsewhere, "fleet-sets").facts.needs, { reassign: 1, recovery: 0, delivery: 0 });
  const repairing = run((w) => { w.plan.requestedSets = 3; w.context.vehicleOrders[0].units[2].status = "repairing"; }).report;
  assert.deepEqual(find(repairing, "fleet-sets").facts.needs, { reassign: 0, recovery: 1, delivery: 0 });
  const ordered = run((w) => { w.plan.requestedSets = 5; w.context.vehicleOrders.push({ id: "order:2", modelId: "medium_4car", stage: "production", quantity: 2, units: [] }); }).report;
  assert.equal(statusOf(ordered, "fleet-sets"), "conditional");
  assert.deepEqual(find(ordered, "fleet-sets").facts.needs, { reassign: 0, recovery: 0, delivery: 2 });
  assert.equal(ordered.verdict, "conditional");
});

test("fleet: too few sets even counting everything is impossible; cancelled orders and other models do not count", () => {
  assertReason(run((w) => { w.plan.requestedSets = 4; }).report, "fleet-sets", "fleet-insufficient");
  const cancelled = run((w) => { w.plan.requestedSets = 4; w.context.vehicleOrders.push({ id: "order:2", modelId: "medium_4car", stage: "cancelled", quantity: 5, units: [] }); }).report;
  assert.equal(statusOf(cancelled, "fleet-sets"), "impossible");
  const otherModel = run((w) => { w.plan.requestedSets = 4; w.context.vehicleOrders.push({ id: "order:3", modelId: "large_8car", stage: "accepted", quantity: 9, units: [{ id: "x", modelId: "large_8car", status: "available" }] }); }).report;
  assert.equal(statusOf(otherModel, "fleet-sets"), "impossible");
  const unrecognised = run((w) => { w.plan.requestedSets = 3; w.context.operatingResourcePools = [{ assignments: [{ serviceId: "service:2", primaryUnitIds: ["order:1:set-1"] }] }]; w.context.vehicleOrders[0].units[1].status = "scrapped"; }).report;
  assertReason(unrecognised, "fleet-sets", "unit-status-unrecognised");
});

test("fleet: missing fleet data or missing assignment data is unknown, and an empty pool list is not the same as none given", () => {
  assertReason(run((w) => { delete w.context.vehicleOrders; }).report, "fleet-sets", "fleet-data-missing");
  assertReason(run((w) => { delete w.context.operatingResourcePools; }).report, "fleet-sets", "assignment-data-missing");
  assert.equal(statusOf(run((w) => { w.context.operatingResourcePools = []; }).report, "fleet-sets"), "possible");
  for (const sets of [undefined, 0, -1, 1.5, "2"]) assertReason(run((w) => { w.plan.requestedSets = sets; }).report, "fleet-sets", "requested-sets-invalid");
  assert.equal(statusOf(run((w) => { delete w.context.operatingResourcePools; w.plan.requestedSets = 9; }).report, "fleet-sets"), "impossible");
});

test("no rail-capacity application leaves every track fact unknown", () => {
  const { report } = run((w) => { w.state.railCapacityApplications = []; });
  for (const id of ["rail-capacity-application", "direction-mode", "block-data", "junction-resource", "terminal-resource", "turnback-connection"]) {
    assertReason(report, id, "rail-capacity-application-missing");
    assert.equal(statusOf(report, id), "unknown");
  }
  assert.equal(report.verdict, "unknown");
});

test("single / double track and blocks: stated values pass as facts, null is unknown, an empty block list is a declared fact", () => {
  const ok = run().report;
  assert.deepEqual(find(ok, "direction-mode").facts, { single: 1, double: 1, sections: 2 });
  assert.deepEqual(find(ok, "block-data").facts, { blocks: 2, sections: 2 });
  const direction = run((w) => { w.state.railCapacityApplications[0].sections[0].directionMode = null; }).report;
  assert.equal(statusOf(direction, "direction-mode"), "unknown");
  assert.equal(find(direction, "direction-mode").facts.sectionIds.length, 1);
  assert.equal(statusOf(run((w) => { w.state.railCapacityApplications[0].sections[1].blockIds = null; }).report, "block-data"), "unknown");
  assert.equal(statusOf(run((w) => { w.state.railCapacityApplications[0].sections[1].blockIds = []; }).report, "block-data"), "possible");
});

test("a line segment the application does not cover makes section facts unknown, not passed", () => {
  const { report } = run((w) => { w.state.railCapacityApplications[0].sections.pop(); });
  for (const id of ["direction-mode", "block-data", "junction-resource"]) assertReason(report, id, "section-not-in-application");
  assert.deepEqual(find(report, "direction-mode").facts.uncoveredTrackSegmentIds, ["track:bc"]);
});

test("junctions: undeclared is unknown, none declared is fine, separated is impossible, unverified or incomplete is unknown", () => {
  const app = (w) => w.state.railCapacityApplications[0];
  assert.deepEqual(find(run().report, "junction-resource").facts.junctionResourceIds, ["junction:1"]);
  assertReason(run((w) => { app(w).sections[0].junctionResourceIds = null; }).report, "junction-resource", "junction-data-missing");
  assert.equal(statusOf(run((w) => { app(w).sections[0].junctionResourceIds = []; }).report, "junction-resource"), "possible");
  assertReason(run((w) => { app(w).junctions[0].attachedToAllSections = false; }).report, "junction-resource", "junction-separated");
  assertReason(run((w) => { delete app(w).junctions[0].attachedToAllSections; }).report, "junction-resource", "junction-attachment-unverified");
  assertReason(run((w) => { app(w).junctions[0].attachedToAllSections = null; }).report, "junction-resource", "junction-attachment-unverified");
  assertReason(run((w) => { app(w).junctions[0].missingRoles = ["stem"]; }).report, "junction-resource", "junction-sections-incomplete");
  assertReason(run((w) => { app(w).junctions = []; }).report, "junction-resource", "junction-reference-unresolved");
  assertReason(run((w) => { app(w).junctions = null; }).report, "junction-resource", "junction-data-missing");
});

test("a junction the plan names must exist in the application", () => {
  assert.equal(statusOf(run((w) => { w.plan.junctionResourceIds = ["junction:1"]; }).report, "junction-resource"), "possible");
  const absent = run((w) => { w.plan.junctionResourceIds = ["junction:9"]; }).report;
  assertReason(absent, "junction-resource", "plan-junction-absent");
  assert.deepEqual(find(absent, "junction-resource").facts.absentFromPlan, ["junction:9"]);
});

test("terminal resource: not selected or no terminal data is unknown, an id the application lacks is impossible", () => {
  const none = run((w) => { delete w.plan.terminalResourceId; }).report;
  assertReason(none, "terminal-resource", "terminal-resource-not-selected");
  assert.equal(find(none, "turnback-connection").status, "unknown");
  const noData = run((w) => { w.state.railCapacityApplications[0].terminals = null; }).report;
  assertReason(noData, "terminal-resource", "terminal-data-missing");
  const absent = run((w) => { w.plan.terminalResourceId = "terminal:zzz"; }).report;
  assert.equal(statusOf(absent, "terminal-resource"), "impossible");
  assert.equal(statusOf(absent, "turnback-connection"), "impossible");
  assert.equal(statusOf(run((w) => { w.state.railCapacityApplications[0].terminals = []; }).report, "terminal-resource"), "impossible");
  assertReason(run((w) => { w.state.railCapacityApplications[0].terminals[0].stationId = "map:elsewhere"; }).report, "terminal-resource", "terminal-not-on-line");
});

test("turnback: a connected candidate passes, a chosen one is judged by its own fact, unverified is unknown, all-unconnected is impossible", () => {
  const candidates = (w) => w.state.railCapacityApplications[0].terminals[0].turnbackCandidates;
  assert.deepEqual(find(run().report, "turnback-connection").facts.attachedCandidateIds, ["turnback:c1"]);
  assert.equal(statusOf(run((w) => { w.plan.turnbackCandidateId = "turnback:c1"; }).report, "turnback-connection"), "possible");
  assertReason(run((w) => { w.plan.turnbackCandidateId = "turnback:c2"; }).report, "turnback-connection", "turnback-not-connected");
  assertReason(run((w) => { w.plan.turnbackCandidateId = "turnback:zzz"; }).report, "turnback-connection", "turnback-candidate-absent");
  assertReason(run((w) => { w.plan.turnbackCandidateId = "turnback:c1"; candidates(w)[0].attached = null; }).report, "turnback-connection", "turnback-connection-unverified");
  assertReason(run((w) => { candidates(w)[0].attached = null; }).report, "turnback-connection", "turnback-connection-unverified");
  assertReason(run((w) => { candidates(w)[0].attached = false; }).report, "turnback-connection", "turnback-not-connected");
});

test("turnback: no drawn turnback track means platform-only (conditional), nothing at all (impossible) or unknown data", () => {
  const terminal = (w) => w.state.railCapacityApplications[0].terminals[0];
  assertReason(run((w) => { terminal(w).turnbackCandidates = []; }).report, "turnback-connection", "platform-turnback-only");
  assertReason(run((w) => { terminal(w).turnbackCandidates = []; terminal(w).platformCandidates = []; }).report, "turnback-connection", "no-turnback-candidate");
  assertReason(run((w) => { terminal(w).turnbackCandidates = []; terminal(w).platformCandidates = null; }).report, "turnback-connection", "platform-data-missing");
  assertReason(run((w) => { terminal(w).turnbackCandidates = null; }).report, "turnback-connection", "turnback-data-missing");
});

test("capacity data is reported as stated or unknown and is never compared with the plan", () => {
  assert.deepEqual(find(run().report, "capacity-data").facts, { capacityTrainsPerHour: 12 });
  for (const value of [undefined, null, 0, -3, "12", NaN]) assert.equal(statusOf(run((w) => { w.context.technicalSpecs[w.line.id].capacityTrainsPerHour = value; }).report, "capacity-data"), "unknown");
  const greedy = run((w) => { w.plan.trainsPerHour = 9999; w.plan.headwayMinutes = 0.1; }).report;
  assert.equal(greedy.verdict, "possible");
  assert.ok(greedy.checks.every((entry) => !/headway|hourly/.test(entry.checkId)));
});

test("blockers, missing inputs and conditions list the distinct reasons of the checks that raised them", () => {
  const { report } = run((w) => {
    w.line.suspended = true;
    w.context.technicalSpecs[w.line.id].technicalSpecification = { ...SPEC, gaugeMm: 1067 };
    w.state.railCapacityApplications[0].sections[0].blockIds = null;
  });
  assert.deepEqual(report.blockers, ["gauge-not-supported"]);
  assert.deepEqual(report.missingInputs, ["block-data-missing"]);
  assert.deepEqual(report.conditions, ["line-suspended"]);
  assert.equal(report.verdict, "impossible");
});
