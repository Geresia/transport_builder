import test from "node:test";
import assert from "node:assert/strict";
import { restoreOperationalState, snapshotOperationalState } from "../src/integrated-save.mjs";
import { operationalInfrastructureRevision } from "../src/operational-timetable-integration.mjs";
import { applyRailCapacityGeometry, railCapacityApplicationReport } from "../src/rail-capacity-integration.mjs";
import { createRailwayDisruption, railwayDisruptionEffect } from "../src/railway-disruptions.mjs";
import { signalBlockForTrain, trainSection } from "../src/railway-traffic-control.mjs";
import { addLine, addPhysicalStation, addTrackSegment, createState } from "../src/state.mjs";

function fixture(directionMode = "double") {
  const pack = { manifest: { id: "capacity-integration", version: "1" }, demand: { model: "gravity", points: [], attractors: [] } };
  const state = createState(pack);
  addPhysicalStation(state, { id: "A", sourceStationId: "map:A", location: [139, 35] });
  addPhysicalStation(state, { id: "B", sourceStationId: "map:B", location: [139.01, 35] });
  addTrackSegment(state, { id: "track:ab", fromStationId: "A", toStationId: "B", lengthMeters: 1_000, directionMode });
  const line = addLine(state, ["A", "B"]);
  line.trackSegmentIds = ["track:ab"];
  line.managementServiceId = "service:1";
  const geometry = {
    schema: "transitline.rail-capacity-geometry/1",
    contractVersion: 1,
    railGeometryId: "geometry:1",
    railGeometryRevision: "geometry-revision:1",
    revision: { state: "current", mismatches: [], missing: [] },
    sections: [{
      sectionId: "section:ab",
      fromStationId: "map:A",
      toStationId: "map:B",
      directionMode,
      blockIds: ["block:1", "block:2"],
      junctionResourceIds: ["junction:1"],
    }],
    blocks: [
      { blockId: "block:1", sectionId: "section:ab", startAlongMeters: 0, endAlongMeters: 500, blockLengthMeters: 500, startBoundary: {}, endBoundary: {} },
      { blockId: "block:2", sectionId: "section:ab", startAlongMeters: 500, endAlongMeters: 1_000, blockLengthMeters: 500, startBoundary: {}, endBoundary: {} },
    ],
    junctions: [{ junctionResourceId: "junction:1", kind: "turnout" }],
    terminals: null,
    closureTargets: [{ sectionId: "section:ab", blockIds: ["block:1", "block:2"], lengthMeters: 1_000 }],
  };
  return { state, line, geometry };
}

test("M5 geometry maps source station endpoints to operational sections and remains detached in reports", () => {
  const { state, line, geometry } = fixture();
  const application = applyRailCapacityGeometry(state, { lineId: line.id, geometry });
  assert.equal(application.sections[0].railCapacitySectionId, "section:ab");
  assert.deepEqual(application.sections[0].blockIds, ["block:1", "block:2"]);
  assert.equal(state.trackSegments[0].railCapacityGeometryRevision, "geometry-revision:1");
  assert.deepEqual(state.trackSegments[0].junctionResourceIds, ["junction:1"]);
  const report = railCapacityApplicationReport(state, line.id);
  report[0].sections[0].blockIds.push("tampered");
  assert.deepEqual(state.railCapacityApplications[0].sections[0].blockIds, ["block:1", "block:2"]);
});

test("stale, missing, ambiguous and unresolved block mappings fail before operational mutation", () => {
  const { state, line, geometry } = fixture();
  const before = snapshotOperationalState(state);
  assert.throws(() => applyRailCapacityGeometry(state, { lineId: line.id, geometry: { ...geometry, revision: { state: "stale" } } }), /stale/);
  assert.deepEqual(snapshotOperationalState(state), before);
  assert.throws(() => applyRailCapacityGeometry(state, { lineId: line.id, geometry: { ...geometry, sections: [] } }), /No rail capacity section/);
  assert.deepEqual(snapshotOperationalState(state), before);
  assert.throws(() => applyRailCapacityGeometry(state, { lineId: line.id, geometry: { ...geometry, sections: [...geometry.sections, { ...geometry.sections[0], sectionId: "section:duplicate" }] } }), /Ambiguous/);
  assert.deepEqual(snapshotOperationalState(state), before);
  assert.throws(() => applyRailCapacityGeometry(state, { lineId: line.id, geometry: { ...geometry, blocks: [geometry.blocks[0]] } }), /unresolved block references/);
  assert.deepEqual(snapshotOperationalState(state), before);
});

test("double track uses M5 block resources while single track remains section-wide fail-safe", () => {
  const double = fixture("double");
  applyRailCapacityGeometry(double.state, { lineId: double.line.id, geometry: double.geometry });
  const leading = { id: 1, lineId: double.line.id, segIndex: 0, dir: 1, t: 0.25, dwell: 0 };
  const following = { id: 2, lineId: double.line.id, segIndex: 0, dir: 1, t: 0, dwell: 0 };
  double.state.trains = [leading, following];
  assert.equal(signalBlockForTrain(double.state, following).blockingTrainId, 1);
  following.t = 0.75;
  assert.equal(trainSection(double.state, following).blockId, "block:2");
  assert.equal(signalBlockForTrain(double.state, following), null);

  const single = fixture("single");
  applyRailCapacityGeometry(single.state, { lineId: single.line.id, geometry: single.geometry });
  const outward = { id: 1, lineId: single.line.id, segIndex: 0, dir: 1, t: 0.25, dwell: 0 };
  const inward = { id: 2, lineId: single.line.id, segIndex: 1, dir: -1, t: 0.25, dwell: 0 };
  single.state.trains = [outward, inward];
  assert.equal(trainSection(single.state, outward).resourceId, "section:track:ab:shared");
  assert.equal(trainSection(single.state, inward).resourceId, "section:track:ab:shared");
  assert.equal(signalBlockForTrain(single.state, inward).blockingTrainId, 1);
});

test("a block-specific disruption affects only its confirmed M5 block", () => {
  const { state, line, geometry } = fixture();
  applyRailCapacityGeometry(state, { lineId: line.id, geometry });
  const event = createRailwayDisruption(state, {
    kind: "signal-failure", lineId: line.id, trackSegmentId: "track:ab", blockId: "block:2", durationMinutes: 20,
  });
  assert.equal(event.blockId, "block:2");
  assert.equal(railwayDisruptionEffect(state, { lineId: line.id, trackSegmentId: "track:ab", blockId: "block:1" }).active, false);
  assert.deepEqual(railwayDisruptionEffect(state, { lineId: line.id, trackSegmentId: "track:ab", blockId: "block:2" }).eventIds, [event.id]);
  assert.throws(() => createRailwayDisruption(state, {
    kind: "signal-failure", lineId: line.id, trackSegmentId: "track:ab", blockId: "missing", durationMinutes: 20,
  }), /Unknown railway block/);
});

test("M5 applications and block facts survive save/restore and invalidate timetable revisions", () => {
  const { state, line, geometry } = fixture();
  const before = operationalInfrastructureRevision(state.trackSegments);
  applyRailCapacityGeometry(state, { lineId: line.id, geometry });
  const after = operationalInfrastructureRevision(state.trackSegments);
  assert.notEqual(after, before);
  const restored = restoreOperationalState(JSON.parse(JSON.stringify(snapshotOperationalState(state))));
  assert.deepEqual(restored.railCapacityApplications, state.railCapacityApplications);
  assert.deepEqual(restored.trackSegments[0].railwayBlocks, state.trackSegments[0].railwayBlocks);
  restored.trackSegments[0].railwayBlocks[0].endAlongMeters = 450;
  assert.notEqual(operationalInfrastructureRevision(restored.trackSegments), after);
});

test("unknown block data stays null and retains conservative whole-section control", () => {
  const { state, line, geometry } = fixture("double");
  geometry.sections[0].blockIds = null;
  geometry.blocks = null;
  applyRailCapacityGeometry(state, { lineId: line.id, geometry });
  assert.equal(state.trackSegments[0].railwayBlocks, null);
  const train = { id: 1, lineId: line.id, segIndex: 0, dir: 1, t: 0, dwell: 0 };
  assert.equal(trainSection(state, train).resourceId, "section:track:ab:forward");
  assert.throws(() => createRailwayDisruption(state, {
    kind: "signal-failure", lineId: line.id, trackSegmentId: "track:ab", blockId: "block:unknown", durationMinutes: 10,
  }), /no confirmed block data/);
});
