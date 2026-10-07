import test from "node:test";
import assert from "node:assert/strict";
import { withStationAccess } from "../src/access-demand.mjs";
import { buildDemandModel } from "../src/demand-engine.mjs";
import { restoreOperationalState, snapshotOperationalState } from "../src/integrated-save.mjs";
import { buildRouteGraph } from "../src/network.mjs";
import { ScenarioRuntime } from "../src/scenario-runtime.mjs";
import { applyStationDemandAccess } from "../src/station-demand-access-integration.mjs";
import { applyStationDemandAllocation, assessStationDemandAllocation, stationDemandAllocationApplicationReport } from "../src/station-demand-allocation-integration.mjs";
import { createState } from "../src/state.mjs";

function pack() {
  return { manifest: { id: "allocation-runtime", version: "1", data: { license: "CC0-1.0", attribution: [] } }, demand: { model: "gravity", points: [
    { id: "node:a", location: [139, 35], residents: 100, jobs: 20 },
    { id: "node:b", location: [139.03, 35], residents: 70, jobs: 40 },
  ], attractors: [] } };
}

function accessExport(revision = "access:a:r1") {
  const stationAccessId = "access:a";
  return {
    schema: "transitline.station-demand-access-export/1", contractVersion: 1, packId: "allocation-runtime", packVersion: "1", catchmentOverlaps: [],
    sites: [{
      schema: "transitline.station-demand-access-geometry/1", contractVersion: 1,
      stationAccessId, stationAccessRevision: revision, sourcePackId: "allocation-runtime", sourcePackVersion: "1",
      location: [139.01, 35], connectedPlanId: "plan:a", connectedStationId: "source:a", connectedNetworkId: "plan:a",
      demandSourceRefs: [{ sourceId: "demand", kind: "demand-points", quality: "medium", spatialResolution: "individual-demand-node" }],
      entrances: [], accessPoints: [],
      catchments: [{ catchmentId: "catch:a", demandNodeIdsInside: ["node:a"] }],
      demandZones: [{ demandZoneId: "zone:a", centroid: [139.02, 35], demandNodeRefs: [{ demandNodeId: "node:a", location: [139.02, 35] }, { demandNodeId: "node:b", location: [139.03, 35] }], drawnConnection: { connected: true } }],
      walkLinks: [{ walkLinkId: "walk:a", from: { kind: "station", id: stationAccessId }, to: { kind: "demand-zone", id: "zone:a" }, alignment: [[139.01, 35], [139.02, 35]], lengthMeters: 80, crossings: { river: 0, railway: 0, building: 0 }, unknownReasons: {} }],
      transfers: [],
    }],
  };
}

function policy() {
  return { schema: "transitline.station-demand-allocation-policy/1", contractVersion: 1, policyId: "policy:a", defaults: { exclusive: "assign", shared: "hold", areaNodeInclusion: "reject" }, rules: [] };
}

function operationalState() {
  const state = createState(pack());
  state.stations.set("physical:a", { id: "physical:a", sourceStationId: "source:a", location: [139.01, 35], status: "available" });
  state.lines = [{ id: 1, stationIds: ["node:a", "physical:a", "node:b"], suspended: false }];
  state.accessLinks = [{ id: "legacy:a", demandNodeId: "node:a", stationId: "node:a", walkMinutes: 1 }];
  return state;
}

test("preview is read-only; applying current policy plus usable walk creates isolated operational links", () => {
  const state = operationalState();
  applyStationDemandAccess(state, { stationDemandAccess: accessExport(), pack: pack() });
  const before = snapshotOperationalState(state);
  const preview = assessStationDemandAllocation(state, { policy: policy() });
  assert.equal(preview.links.length, 1);
  assert.deepEqual(snapshotOperationalState(state), before);
  const applied = applyStationDemandAllocation(state, { policy: policy() });
  assert.equal(applied.status, "current");
  assert.equal(applied.allocationPolicy.policyId, "policy:a");
  assert.equal(applied.walkingPolicy.walkEstimate, "none");
  assert.deepEqual(state.stationDemandAllocationLinks.map((link) => [link.demandNodeId, link.stationId, link.walkMinutes]), [["node:a", "physical:a", 1]]);
  assert.equal(state.accessLinks[0].id, "legacy:a", "map geometry link is not overwritten");
  const model = withStationAccess(buildDemandModel(state, pack().demand), state);
  assert.equal(model.resolveTrip(state, buildRouteGraph(state), "node:a", "node:b").originStationId, "physical:a");
  applied.links[0].stationId = "changed";
  assert.equal(stationDemandAllocationApplicationReport(state).links[0].stationId, "physical:a");
});

test("an access-export revision makes the stored allocation stale without silently rerouting", () => {
  const state = operationalState();
  applyStationDemandAccess(state, { stationDemandAccess: accessExport(), pack: pack() });
  applyStationDemandAllocation(state, { policy: policy() });
  const links = structuredClone(state.stationDemandAllocationLinks);
  applyStationDemandAccess(state, { stationDemandAccess: accessExport("access:a:r2"), pack: pack() });
  assert.equal(stationDemandAllocationApplicationReport(state).status, "stale");
  assert.deepEqual(state.stationDemandAllocationLinks, links);
});

test("runtime reports, saves and rolls back a rejected allocation command", () => {
  const state = operationalState();
  const runtime = new ScenarioRuntime({ pack: pack(), operationalState: state, networkMode: "scratch", seed: 3 });
  runtime.applyStationDemandAccess(accessExport());
  const before = snapshotOperationalState(state);
  assert.throws(() => runtime.applyStationDemandAllocation({}), /valid explicit allocation policy/);
  assert.deepEqual(snapshotOperationalState(state), before);
  runtime.applyStationDemandAllocation({ policy: policy() });
  assert.equal(runtime.report().stationDemandAllocation.links.length, 1);
  const restored = restoreOperationalState(JSON.parse(JSON.stringify(snapshotOperationalState(state))));
  assert.deepEqual(stationDemandAllocationApplicationReport(restored), runtime.stationDemandAllocationReport());
});
