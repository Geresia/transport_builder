import test from "node:test";
import assert from "node:assert/strict";
import { buildPlanGeometry, demandNodesFromPack, PLAN_SCHEMA } from "../src/map/plan-geometry.mjs";
import { ManagementGame, PLAN_GEOMETRY_SCHEMA } from "../src/management/index.mjs";

test("map producer PlanGeometry is accepted unchanged by the management engine", () => {
  const pack = {
    manifest: { id: "contract-city", version: "1.2.3" },
    demand: {
      points: [
        { id: "d0", name: "West", location: [139, 35], residents: 1000, jobs: 500 },
        { id: "d1", name: "East", location: [139.006, 35], residents: 500, jobs: 1000 },
      ],
    },
  };
  const spatial = {
    quality: { elevation: "high", river: "high", road: "high", railway: "high", building: "high" },
    elevationAt: ([lon]) => lon < 139.004 ? 5 : 7,
    maxSlopeAlong: () => 0.2,
    crossings: () => ({ river: 0, road: 1, railway: 0, building: 0 }),
  };
  const demandNodes = demandNodesFromPack(pack);
  const drawn = {
    key: "player-line-1",
    name: "Contract Line",
    vertices: [
      { location: [139, 35], name: "West", demandNodeId: "d0", structure: "surface", depthMeters: 0, platformType: "side", platformLengthM: 100 },
      { location: [139.003, 35], name: "Central", structure: "elevated", depthMeters: 0, platformType: "island", platformLengthM: 100 },
      { location: [139.006, 35], name: "East", demandNodeId: "d1", structure: "elevated", depthMeters: 0, platformType: "side", platformLengthM: 100 },
    ],
    legs: [{ structureHint: "surface" }, { structureHint: "elevated" }],
  };
  const plan = buildPlanGeometry(drawn, { pack, spatial, demandNodes, externalNetworks: [], mode: "scratch" });
  assert.equal(plan.schema, PLAN_SCHEMA);
  assert.equal(plan.schema, PLAN_GEOMETRY_SCHEMA);
  assert.equal(plan.stationCandidates.length, 3);
  assert.equal(plan.segments.length, 2);
  assert.ok(plan.accessLinks.length >= 2);
  const game = new ManagementGame({ openingCash: 1_000_000_000_000 });
  const record = game.submitPlan(plan, "medium_steel");
  assert.equal(record.status, "assessed");
  game.approvePlan(record.id);
  const project = game.createProjectFromPlan(record.id);
  assert.equal(project.planGeometry.schema, PLAN_SCHEMA);
  assert.equal(project.planGeometry.sourcePackVersion, "1.2.3");
});

test("map producer preserves unknown engineering inputs as conditional, never zero", () => {
  const pack = { manifest: { id: "unknown-city", version: "1" }, demand: { points: [] } };
  const spatial = {
    quality: { elevation: "low", river: "low", road: "low", railway: "low", building: "low" },
    elevationAt: () => null,
    maxSlopeAlong: () => null,
    crossings: () => ({ river: null, road: null, railway: null, building: null }),
  };
  const plan = buildPlanGeometry({
    key: "unknown",
    vertices: [
      { location: [139, 35] },
      { location: [139.01, 35] },
    ],
  }, { pack, spatial, demandNodes: [], externalNetworks: [], mode: "scratch" });
  assert.equal(plan.stationCandidates[0].platformType, null);
  assert.equal("platformLengthM" in plan.stationCandidates[0], false);
  assert.equal(plan.segments[0].elevationStartMeters, null);
  const game = new ManagementGame();
  const record = game.submitPlan(plan, "medium_steel");
  assert.equal(record.status, "needs-information");
  assert.ok(record.assessment.missingInputs.some((item) => item.includes("platformType")));
});
