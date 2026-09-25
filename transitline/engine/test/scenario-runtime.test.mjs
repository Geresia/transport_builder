import test from "node:test";
import assert from "node:assert/strict";
import { buildMapExport } from "../src/map/plan-geometry.mjs";
import { planningDefaults, ScenarioRuntime, stablePlanKey } from "../src/scenario-runtime.mjs";
import { createState } from "../src/state.mjs";

function pack() {
  return {
    manifest: { id: "runtime", version: "1", data: { license: "test", attribution: [] } },
    demand: {
      model: "gravity",
      points: [
        { id: "west", name: "West", location: [139, 35], residents: 10_000, jobs: 1_000 },
        { id: "centre", name: "Centre", location: [139.02, 35], residents: 4_000, jobs: 12_000 },
        { id: "east", name: "East", location: [139.04, 35], residents: 7_000, jobs: 8_000 },
      ],
      attractors: [],
    },
  };
}

function plan(source) {
  const options = planningDefaults("medium_steel", "elevated", "island");
  return buildMapExport({
    pack: source,
    mode: "scratch",
    drawnLines: [{
      key: stablePlanKey(source.manifest.id, ["west", "centre", "east"]),
      name: "Runtime Line",
      vertices: source.demand.points.map((point) => ({ location: point.location, demandNodeId: point.id, structure: options.structure, depthMeters: options.depthMeters, platformType: options.platformType, platformLengthM: options.platformLengthM })),
      legs: [{ structureHint: options.structure }, { structureHint: options.structure }],
    }],
  }).plans[0];
}

test("scenario runtime connects a map plan to suspended construction, fleet, commissioning and save", () => {
  const source = pack();
  const state = createState(source);
  const runtime = new ScenarioRuntime({ pack: source, operationalState: state, networkMode: "scratch", seed: 901 });
  const geometry = plan(source);
  const submitted = runtime.submit(geometry, "medium_steel");
  assert.equal(submitted.status, "assessed");
  runtime.approveAndCreate(geometry.planId);
  runtime.contract(geometry.planId);
  runtime.prepareFleet(geometry.planId);

  runtime.advanceMonths(1);
  const project = runtime.projectForPlan(geometry.planId);
  const progress = project.progress;
  runtime.suspend(geometry.planId, "resident consultation");
  runtime.advanceMonths(2);
  assert.equal(project.status, "suspended");
  assert.equal(project.progress, progress, "a suspended project must not build or pay progress claims");
  runtime.resume(geometry.planId);

  for (let month = 0; month < 120; month++) {
    runtime.advanceMonths(1);
    if (project.status === "available" && runtime.game.vehicleOrders[0].stage === "accepted") break;
  }
  assert.equal(project.status, "available");
  assert.equal(runtime.game.vehicleOrders[0].stage, "accepted");
  const opened = runtime.open(geometry.planId, { color: "#e63946" });
  assert.equal(opened.service.status, "open");
  assert.equal(state.lines.filter((line) => line.owned).length, 1);
  assert.equal(runtime.report().plans[0].status, "commissioned");

  const save = runtime.save();
  const restoredState = createState(source);
  const restored = new ScenarioRuntime({ pack: source, operationalState: restoredState, networkMode: "scratch" }).load(save);
  assert.equal(restored.game.projects[0].commissionedLineId, restoredState.lines.find((line) => line.owned).id);
  assert.equal(restoredState.trackSegments.length, 2);
});

test("stable editor plan keys ignore route drawing direction", () => {
  assert.equal(stablePlanKey("p", ["a", "b", "c"]), stablePlanKey("p", ["c", "b", "a"]));
  assert.notEqual(stablePlanKey("p", ["a", "b"]), stablePlanKey("p", ["a", "c"]));
});
