import test from "node:test";
import assert from "node:assert/strict";
import { restoreOperationalState, snapshotOperationalState } from "../src/integrated-save.mjs";
import { applyStationDemandAccess, stationDemandAccessApplicationReport } from "../src/station-demand-access-integration.mjs";
import { ScenarioRuntime } from "../src/scenario-runtime.mjs";
import { createState } from "../src/state.mjs";

function pack() {
  return { manifest: { id: "station-access-runtime", version: "1", data: { license: "CC0-1.0", attribution: [] } }, demand: { model: "gravity", points: [
    { id: "node:a", location: [139, 35], residents: 100, jobs: 40 },
  ], attractors: [] } };
}
function accessExport(source = "individual-demand-node") {
  return {
    schema: "transitline.station-demand-access-export/1", contractVersion: 1, packId: "station-access-runtime", packVersion: "1",
    sites: [{ stationAccessId: "access:a", stationAccessRevision: "access:a:r1", connectedPlanId: "plan:a", connectedStationId: "station:a",
      demandSourceRefs: [{ sourceId: "source:demand", kind: "demand-points", quality: "medium", spatialResolution: source }],
      catchments: [{ catchmentId: "catch:a", demandNodeIdsInside: ["node:a"] }],
    }], catchmentOverlaps: [],
  };
}

test("a validated map export becomes a detached operational application and survives state snapshots", () => {
  const source = pack(); const state = createState(source); const geometry = structuredClone(accessExport());
  const before = JSON.stringify(geometry);
  const application = applyStationDemandAccess(state, { stationDemandAccess: geometry, pack: source });
  assert.equal(application.assessment.sites[0].totals.exclusive.residents, 100);
  assert.equal(JSON.stringify(geometry), before);
  application.assessment.sites[0].demandNodeInputs[0].residents = 0;
  assert.equal(state.stationDemandAccessApplication.assessment.sites[0].demandNodeInputs[0].residents, 100);
  const restored = restoreOperationalState(JSON.parse(JSON.stringify(snapshotOperationalState(state))));
  assert.deepEqual(stationDemandAccessApplicationReport(restored), stationDemandAccessApplicationReport(state));
});

test("wrong or coarse map exports fail closed without changing operational state", () => {
  const source = pack(); const state = createState(source); applyStationDemandAccess(state, { stationDemandAccess: accessExport(), pack: source });
  const before = snapshotOperationalState(state);
  assert.throws(() => applyStationDemandAccess(state, { stationDemandAccess: { ...accessExport(), packId: "other" }, pack: source }), /another pack/);
  assert.deepEqual(snapshotOperationalState(state), before);
  const coarse = applyStationDemandAccess(state, { stationDemandAccess: accessExport("municipality-centroid"), pack: source });
  assert.equal(coarse.assessment.sites[0].catchmentStatus, "unknown");
});

test("ScenarioRuntime reports, saves and restores the application without changing passenger simulation inputs", () => {
  const source = pack(); const state = createState(source); const runtime = new ScenarioRuntime({ pack: source, operationalState: state, networkMode: "scratch", seed: 1 });
  const beforeAccess = structuredClone(state.accessLinks);
  runtime.applyStationDemandAccess(accessExport());
  const report = runtime.report();
  assert.equal(report.stationDemandAccess.assessment.sites[0].demandNodeInputs[0].residents, 100);
  report.stationDemandAccess.access.sites[0].catchments.length = 0;
  assert.equal(runtime.stationDemandAccessReport().access.sites[0].catchments.length, 1);
  assert.deepEqual(state.accessLinks, beforeAccess);
  const saved = runtime.save();
  const restored = new ScenarioRuntime({ pack: source, operationalState: createState(source), networkMode: "scratch", seed: 2 });
  restored.load(saved);
  assert.deepEqual(restored.stationDemandAccessReport(), runtime.stationDemandAccessReport());
  const legacy = JSON.parse(saved); delete legacy.operations.stationDemandAccessApplication;
  restored.load(JSON.stringify(legacy));
  assert.equal(restored.stationDemandAccessReport(), null);
});
