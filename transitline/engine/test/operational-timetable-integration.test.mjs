import test from "node:test";
import assert from "node:assert/strict";
import { restoreOperationalState, snapshotOperationalState } from "../src/integrated-save.mjs";
import {
  applyActiveRailwayTimetable,
  buildOperationalRailwayTimetableInput,
  operationalDayType,
  operationalInfrastructureRevision,
  resolveOperationalLinePath,
} from "../src/operational-timetable-integration.mjs";
import { ScenarioRuntime } from "../src/scenario-runtime.mjs";
import { addLine, addPhysicalStation, addTrackSegment, createState } from "../src/state.mjs";
import { dispatchTrains, stepTrains } from "../src/trains.mjs";

function sourcePack() {
  return {
    manifest: { id: "operational-timetable", version: "1", data: { license: "test", attribution: [] } },
    demand: { model: "gravity", points: [], attractors: [] },
  };
}

function fixture() {
  const state = createState(sourcePack());
  addPhysicalStation(state, { id: "A", location: [139, 35] });
  addPhysicalStation(state, { id: "B", location: [139.01, 35] });
  addPhysicalStation(state, { id: "C", location: [139.02, 35] });
  addTrackSegment(state, { id: "ab", fromStationId: "A", toStationId: "B", lengthMeters: 1_000 });
  addTrackSegment(state, { id: "bc", fromStationId: "C", toStationId: "B", lengthMeters: 1_200 });
  const line = addLine(state, ["A", "B", "C"], { frequency: { high: 60, medium: 60, low: 60, veryLow: 60 } });
  line.trackSegmentIds = ["bc", "ab"];
  line.managementServiceId = "service:a";
  const service = { id: "service:a", status: "open", operationalLineId: line.id, commercialSpeedKph: 30, trainsPerHour: 4, operatorId: "player" };
  return { state, line, service };
}

test("actual line topology resolves track order and mixed stored segment orientation", () => {
  const { state, line } = fixture();
  const route = resolveOperationalLinePath(state, line);
  assert.deepEqual(route.sectionIds, ["ab", "bc"]);
  assert.deepEqual(route.sectionDirections, ["forward", "reverse"]);
});

test("operational timetable draft uses actual assets, disclosed assumptions and per-section directions", () => {
  const { state, service } = fixture();
  const draft = buildOperationalRailwayTimetableInput({
    operationalState: state,
    services: [service],
    infrastructureRevision: "assets:1",
    servicePlans: [{ serviceId: service.id, firstDepartureMinute: 361, lastDepartureMinute: 371, headwayMinutes: 10, terminalResourceId: "terminal:C:1" }],
    closureWindowsBySectionId: { bc: [{ startMinute: 500, endMinute: 510, reason: "inspection" }] },
    infrastructureAssumptions: { directionMode: "double", minimumHeadwayMinutes: 3 },
  });
  assert.deepEqual(draft.sections.map((entry) => entry.sectionId).sort(), ["ab", "bc"]);
  assert.deepEqual(draft.paths[0].sectionDirections, ["forward", "reverse"]);
  assert.deepEqual(draft.paths.find((entry) => entry.direction === "reverse").sectionDirections, ["forward", "reverse"]);
  assert.deepEqual(draft.sections.find((entry) => entry.sectionId === "bc").closureWindows, [{ startMinute: 500, endMinute: 510, reason: "inspection" }]);
  assert.ok(draft.operationalFacts.assumptions.includes("ab:directionMode:explicit-assumption-double"));
  assert.ok(draft.operationalFacts.assumptions.includes("bc:runMinutes:derived-from-length-and-slowest-service-speed"));
});

test("missing or ambiguous physical links fail closed", () => {
  const { state, line, service } = fixture();
  state.trackSegments = state.trackSegments.filter((entry) => entry.id !== "bc");
  assert.throws(() => resolveOperationalLinePath(state, line), /Missing track/);
  addTrackSegment(state, { id: "bc-2", fromStationId: "B", toStationId: "C", lengthMeters: 1_200 });
  line.trackSegmentIds.push("bc-2");
  addTrackSegment(state, { id: "bc-3", fromStationId: "B", toStationId: "C", lengthMeters: 1_200 });
  line.trackSegmentIds.push("bc-3");
  assert.throws(() => buildOperationalRailwayTimetableInput({ operationalState: state, services: [service], infrastructureRevision: "x", servicePlans: [{ serviceId: service.id }] }), /Ambiguous track/);
});

test("unknown signalling and track direction cannot become optimistic capacity", () => {
  const { state, service } = fixture();
  assert.throws(() => buildOperationalRailwayTimetableInput({
    operationalState: state, services: [service], infrastructureRevision: "x", servicePlans: [{ serviceId: service.id }],
  }), /minimumHeadwayMinutes is unknown/);
});

test("active timetable dispatches at exact accepted minutes instead of frequency headways", () => {
  const { state, line, service } = fixture();
  const runtime = new ScenarioRuntime({ pack: sourcePack(), operationalState: state });
  runtime.game.services.push(service);
  const assessed = runtime.assessOperationalRailwayTimetable({
    infrastructureRevision: "assets:1",
    servicePlans: [{ serviceId: service.id, firstDepartureMinute: 361, lastDepartureMinute: 371, headwayMinutes: 10, terminalResourceId: "terminal:C:1" }],
    infrastructureAssumptions: { directionMode: "double", minimumHeadwayMinutes: 3 },
  });
  assert.equal(assessed.assessment.verdict, "possible");
  assert.deepEqual(assessed.acceptedPaths[0].timings.map((entry) => entry.direction), ["forward", "reverse"]);
  runtime.approveRailwayTimetable(assessed.id);
  runtime.activateRailwayTimetable(assessed.id);
  assert.deepEqual(line.timetableDispatches.weekday.departureMinutes, [361, 371]);
  state.simMinutes = 360.9;
  dispatchTrains(state);
  assert.equal(state.trains.length, 0, "legacy 60 trains/hour frequency is suppressed while a timetable is active");
  state.simMinutes = 361;
  dispatchTrains(state);
  assert.equal(state.trains.length, 1);
  assert.equal(state.trains[0].scheduledDepartureMinute, 361);
  assert.ok(state.trains[0].scheduledReturnMinute > assessed.acceptedPaths.find((entry) => entry.direction === "forward").arrivalMinute);
  assert.equal(state.trains[0].terminalResourceId, "terminal:C:1");
  assert.deepEqual(line.railwayTrafficControl.sectionJunctionClearanceMinutes, { ab: 1, bc: 1 });
  state.simMinutes = 371;
  dispatchTrains(state);
  assert.equal(state.trains.length, 2);
  assert.equal(state.trains[1].scheduledDepartureMinute, 371);
});

test("a train waits at the far terminal until its accepted inbound path", () => {
  const { state, line } = fixture();
  line.timetableDispatches = { weekday: { dayType: "weekday", departureMinutes: [361], roundTrips: [{ departureMinute: 361, returnDepartureMinute: 400 }], lastCheckedSimMinute: 360 } };
  state.simMinutes = 361;
  dispatchTrains(state);
  const train = state.trains[0];
  train.segIndex = 1;
  train.dir = 1;
  train.t = 0.9999;
  train.dwell = 0;
  state.simMinutes = 390;
  stepTrains(state, 1);
  assert.equal(train.segIndex, 2);
  assert.equal(train.dir, -1);
  assert.equal(train.holdUntilSimMinute, 400);
  const heldPosition = train.t;
  state.simMinutes = 399;
  stepTrains(state, 1);
  assert.equal(train.t, heldPosition);
  state.simMinutes = 400;
  stepTrains(state, 1);
  assert.ok(train.t > heldPosition);
});

test("suspension consumes missed timetable paths instead of backfilling them on resume", () => {
  const { state, line } = fixture();
  line.timetableDispatches = { weekday: { dayType: "weekday", departureMinutes: [361], lastCheckedSimMinute: 360 } };
  line.suspended = true;
  state.simMinutes = 362;
  dispatchTrains(state);
  line.suspended = false;
  dispatchTrains(state);
  assert.equal(state.trains.length, 0);
  assert.equal(line.timetableDispatches.weekday.lastCheckedSimMinute, 362);
});

test("runtime activation rolls management and operations back when paths do not match the real line", () => {
  const { state, line, service } = fixture();
  const runtime = new ScenarioRuntime({ pack: sourcePack(), operationalState: state });
  runtime.game.services.push(service);
  const assessed = runtime.assessRailwayTimetable({
    infrastructureRevision: "wrong:1",
    sections: [{ sectionId: "wrong", fromNodeId: "X", toNodeId: "Y", directionMode: "double", runMinutes: 2, minimumHeadwayMinutes: 3 }],
    paths: [{ pathId: "wrong:path", serviceId: service.id, departureMinute: 400, direction: "forward", sectionIds: ["wrong"] }],
  });
  runtime.approveRailwayTimetable(assessed.id);
  const managementBefore = runtime.game.snapshot();
  const operationsBefore = snapshotOperationalState(state);
  assert.throws(() => runtime.activateRailwayTimetable(assessed.id), /does not cover operational line/);
  assert.deepEqual(runtime.game.snapshot(), managementBefore);
  assert.deepEqual(snapshotOperationalState(state), operationsBefore);
  assert.equal(line.timetableDispatches, undefined);
});

test("operational activation rejects unpaired returns, duplicate line mappings and unmapped holidays", () => {
  const { state, line, service } = fixture();
  const outbound = { pathId: "out", dutyId: "duty:a", serviceId: service.id, direction: "forward", departureMinute: 400, arrivalMinute: 410, timings: [
    { sectionId: "ab", fromNodeId: "A", toNodeId: "B", direction: "forward" },
    { sectionId: "bc", fromNodeId: "B", toNodeId: "C", direction: "reverse" },
  ] };
  const base = {
    schema: "transitline.railway-timetable/1", contractVersion: 1, id: "tt", status: "active", dayType: "weekday", infrastructureRevision: operationalInfrastructureRevision(state.trackSegments),
    serviceSummary: [{ serviceId: service.id, acceptedPaths: 1 }], acceptedPaths: [outbound],
  };
  assert.throws(() => applyActiveRailwayTimetable({ operationalState: state, timetable: base, services: [service] }), /accepted inbound/);
  assert.equal(line.timetableDispatches, undefined);
  const inbound = { pathId: "in", dutyId: "duty:a", serviceId: service.id, direction: "reverse", departureMinute: 420, arrivalMinute: 430, timings: [
    { sectionId: "bc", fromNodeId: "C", toNodeId: "B", direction: "forward" },
    { sectionId: "ab", fromNodeId: "B", toNodeId: "A", direction: "reverse" },
  ] };
  const secondService = { ...service, id: "service:b" };
  const duplicateLine = {
    ...base,
    serviceSummary: [{ serviceId: service.id, acceptedPaths: 2 }, { serviceId: secondService.id, acceptedPaths: 2 }],
    acceptedPaths: [outbound, inbound, { ...outbound, pathId: "out-b", dutyId: "duty:b", serviceId: secondService.id }, { ...inbound, pathId: "in-b", dutyId: "duty:b", serviceId: secondService.id }],
  };
  assert.throws(() => applyActiveRailwayTimetable({ operationalState: state, timetable: duplicateLine, services: [service, secondService] }), /Multiple timetable services/);
  assert.throws(() => applyActiveRailwayTimetable({ operationalState: state, timetable: { ...base, dayType: "holiday" }, services: [service] }), /calendar mapping/);
});

test("activation requires the exact physical sections, stable duty mates and live infrastructure revision", () => {
  const { state, service } = fixture();
  const revision = operationalInfrastructureRevision(state.trackSegments);
  const outbound = { pathId: "out", dutyId: "duty:1", serviceId: service.id, direction: "forward", departureMinute: 400, arrivalMinute: 410, timings: [
    { sectionId: "parallel-ab", fromNodeId: "A", toNodeId: "B", direction: "forward" },
    { sectionId: "bc", fromNodeId: "B", toNodeId: "C", direction: "reverse" },
  ] };
  const inbound = { pathId: "in", dutyId: "duty:1", serviceId: service.id, direction: "reverse", departureMinute: 420, arrivalMinute: 430, timings: [
    { sectionId: "bc", fromNodeId: "C", toNodeId: "B", direction: "forward" },
    { sectionId: "ab", fromNodeId: "B", toNodeId: "A", direction: "reverse" },
  ] };
  const timetable = {
    schema: "transitline.railway-timetable/1", contractVersion: 1, id: "exact", status: "active", dayType: "weekday", infrastructureRevision: revision,
    serviceSummary: [{ serviceId: service.id, acceptedPaths: 2 }], acceptedPaths: [outbound, inbound],
  };
  assert.throws(() => applyActiveRailwayTimetable({ operationalState: state, timetable, services: [service] }), /wrong track section/);
  const exactOutbound = { ...outbound, timings: [{ ...outbound.timings[0], sectionId: "ab" }, outbound.timings[1]] };
  assert.throws(() => applyActiveRailwayTimetable({
    operationalState: state,
    timetable: { ...timetable, acceptedPaths: [exactOutbound, { ...inbound, dutyId: "duty:2" }] },
    services: [service],
  }), /requires its accepted inbound/);
  state.trackSegments[0].minimumHeadwayMinutes = 4;
  assert.throws(() => applyActiveRailwayTimetable({ operationalState: state, timetable: { ...timetable, acceptedPaths: [exactOutbound, inbound] }, services: [service] }), /stale/);
});

test("dispatch scans both sides of a weekday-to-weekend boundary", () => {
  const { state, line } = fixture();
  const previous = 5 * 1440 - 2;
  line.timetableDispatches = {
    weekday: { dayType: "weekday", departureMinutes: [1439], lastCheckedSimMinute: previous },
    weekend: { dayType: "weekend", departureMinutes: [1], lastCheckedSimMinute: previous },
  };
  state.simMinutes = 5 * 1440 + 1;
  dispatchTrains(state);
  assert.deepEqual(state.trains.map((entry) => entry.scheduledDepartureMinute), [5 * 1440 + 1]);
  assert.equal(line.timetableDispatches.weekday.missedDepartures, 1);
});

test("load reconciles an active management timetable when the operational application is absent", () => {
  const { state, service } = fixture();
  const runtime = new ScenarioRuntime({ pack: sourcePack(), operationalState: state });
  runtime.game.services.push(service);
  const assessed = runtime.assessOperationalRailwayTimetable({
    infrastructureRevision: "assets:1",
    servicePlans: [{ serviceId: service.id, firstDepartureMinute: 400, lastDepartureMinute: 400, headwayMinutes: 10 }],
    infrastructureAssumptions: { directionMode: "double", minimumHeadwayMinutes: 3 },
  });
  runtime.approveRailwayTimetable(assessed.id);
  runtime.activateRailwayTimetable(assessed.id);
  const legacyVariant = JSON.parse(runtime.save());
  delete legacyVariant.operations.lines[0].timetableDispatches;
  runtime.load(JSON.stringify(legacyVariant));
  assert.equal(runtime.operationalState.lines[0].timetableDispatches.weekday.timetableId, assessed.id);
  assert.equal(runtime.report().operationalTimetableApplications.length, 1);
});

test("legacy active holiday timetables load fail-closed with a visible warning", () => {
  const { state, service } = fixture();
  const runtime = new ScenarioRuntime({ pack: sourcePack(), operationalState: state });
  runtime.game.services.push(service);
  runtime.game.railwayTimetables.push({
    schema: "transitline.railway-timetable/1", contractVersion: 1, id: "legacy-holiday", status: "active", dayType: "holiday", infrastructureRevision: "legacy",
    serviceSummary: [{ serviceId: service.id, acceptedPaths: 1 }], acceptedPaths: [{ pathId: "old", serviceId: service.id, direction: "forward", departureMinute: 400, arrivalMinute: 410, timings: [] }],
  });
  runtime.load(runtime.save());
  assert.equal(runtime.game.requireRailwayTimetable("legacy-holiday").status, "active");
  assert.match(runtime.report().operationalTimetableWarnings[0].reason, /calendar mapping/);
  assert.equal(runtime.operationalState.lines[0].timetableDispatches.holiday.blockedReason.includes("calendar mapping"), true);
});

test("applications survive operational save/restore and day types are deterministic", () => {
  const { state, line, service } = fixture();
  const timetable = {
    schema: "transitline.railway-timetable/1", contractVersion: 1, id: "tt", status: "active", dayType: "weekend", infrastructureRevision: operationalInfrastructureRevision(state.trackSegments),
    serviceSummary: [{ serviceId: service.id, acceptedPaths: 2 }],
    acceptedPaths: [
      { pathId: "p-out", dutyId: "duty:1", serviceId: service.id, direction: "forward", departureMinute: 500, arrivalMinute: 510, timings: [
        { sectionId: "ab", fromNodeId: "A", toNodeId: "B", direction: "forward" },
        { sectionId: "bc", fromNodeId: "B", toNodeId: "C", direction: "reverse" },
      ] },
      { pathId: "p-in", dutyId: "duty:1", serviceId: service.id, direction: "reverse", departureMinute: 520, arrivalMinute: 530, timings: [
        { sectionId: "bc", fromNodeId: "C", toNodeId: "B", direction: "forward" },
        { sectionId: "ab", fromNodeId: "B", toNodeId: "A", direction: "reverse" },
      ] },
    ],
  };
  applyActiveRailwayTimetable({ operationalState: state, timetable, services: [service] });
  const reopened = restoreOperationalState(JSON.parse(JSON.stringify(snapshotOperationalState(state))));
  assert.deepEqual(reopened.lines[0].timetableDispatches, line.timetableDispatches);
  assert.equal(operationalDayType(4 * 1440), "weekday");
  assert.equal(operationalDayType(5 * 1440), "weekend");
});
