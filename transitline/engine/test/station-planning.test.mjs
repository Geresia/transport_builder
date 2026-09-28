import test from "node:test";
import assert from "node:assert/strict";
import {
  STATION_PLAN_SCHEMA,
  assessStationPlan,
  assessVehiclePlatformCompatibility,
  createStationPlan,
} from "../src/management/index.mjs";

function medium(overrides = {}) {
  return createStationPlan({
    id: "station:test",
    name: "Test Station",
    technicalProfileId: "medium_steel",
    vehicleModelId: "medium_4car",
    structureId: "surface",
    layoutId: "side-2track",
    ...overrides,
  });
}

test("station plan separates current operating length from future structural provision", () => {
  const plan = medium({ futureCars: 8 });
  assert.equal(plan.schema, STATION_PLAN_SCHEMA);
  assert.equal(plan.currentRequiredLengthMeters, 82);
  assert.equal(plan.futureRequiredLengthMeters, 164);
  assert.equal(plan.finishedPlatformLengthMeters, 82);
  assert.equal(plan.structuralPlatformLengthMeters, 164);
  assert.ok(plan.platforms.every((platform) => platform.finishedLengthMeters === 82 && platform.structuralLengthMeters === 164));
});

test("side and island layouts create distinct platforms while preserving two track edges", () => {
  const side = medium({ layoutId: "side-2track" });
  const island = medium({ layoutId: "island-2track" });
  assert.equal(side.tracks.length, 2);
  assert.equal(side.platforms.length, 2);
  assert.equal(side.platforms.flatMap((platform) => platform.edges).length, 2);
  assert.equal(island.tracks.length, 2);
  assert.equal(island.platforms.length, 1);
  assert.equal(island.platforms[0].edges.length, 2);
  assert.ok(island.platforms[0].minimumWidthMeters > side.platforms[0].minimumWidthMeters);
});

test("passing and terminal layouts expose physical operating capabilities", () => {
  const passing = medium({ layoutId: "two-platform-4-track" });
  const terminal = medium({ layoutId: "terminal-bay", stationRole: "terminal" });
  assert.equal(passing.tracks.length, 4);
  assert.equal(passing.tracks.filter((track) => track.role === "passing").length, 2);
  assert.equal(passing.capabilities.supportsOvertaking, true);
  assert.equal(terminal.turnback.available, true);
  assert.equal(terminal.turnback.facility, "layout");
  assert.equal(assessStationPlan(terminal).status, "compatible");
});

test("a terminal label without a turnback route is rejected", () => {
  const plan = medium({ stationRole: "terminal", layoutId: "side-2track", turnbackFacility: "none" });
  const result = assessStationPlan(plan);
  assert.equal(result.status, "incompatible");
  assert.ok(result.violations.some((issue) => issue.code === "turnback-missing"));
});

test("future civil provision does not make a short unfinished platform operable", () => {
  const plan = medium({ futureCars: 8, finishedPlatformLengthMeters: 70, structuralPlatformLengthMeters: 164 });
  const result = assessVehiclePlatformCompatibility(plan, "medium_4car");
  assert.equal(result.status, "incompatible");
  assert.ok(result.violations.some((issue) => issue.code === "platform-too-short"));
  assert.ok(result.conditions.some((issue) => issue.code === "future-structure-not-finished"));
});

test("running-system mismatch rejects AGT, monorail and large steel vehicles at a medium-steel station", () => {
  const plan = medium();
  for (const modelId of ["agt_3car", "monorail_6car", "large_8car"]) {
    const result = assessVehiclePlatformCompatibility(plan, modelId);
    assert.equal(result.status, "incompatible", modelId);
    assert.ok(result.violations.some((issue) => issue.code === "running-system-mismatch"), modelId);
  }
});

test("screen doors require matching door positions and sufficient stopping accuracy", () => {
  const inaccurate = medium({ screenDoorType: "full-height", stoppingAccuracyMm: 500, operationMode: "ato" });
  const inaccurateResult = assessVehiclePlatformCompatibility(inaccurate);
  assert.ok(inaccurateResult.violations.some((issue) => issue.code === "stopping-accuracy-insufficient"));

  const wrongDoors = medium({ screenDoorType: "full-height", operationMode: "ato", screenDoorProfileId: "other-door-pattern" });
  const wrongDoorsResult = assessVehiclePlatformCompatibility(wrongDoors);
  assert.ok(wrongDoorsResult.violations.some((issue) => issue.code === "screen-door-pattern-mismatch"));

  const compatible = medium({ screenDoorType: "full-height", operationMode: "ato", stoppingAccuracyMm: 300 });
  assert.equal(assessVehiclePlatformCompatibility(compatible).status, "compatible");
});

test("a curved platform without radius stays conditional instead of assuming a straight gap", () => {
  const unknown = medium({ alignment: "curved" });
  const unknownResult = assessVehiclePlatformCompatibility(unknown);
  assert.equal(unknown.interface.horizontalGapMm, null);
  assert.equal(unknownResult.status, "conditional");
  assert.ok(unknownResult.conditions.some((issue) => issue.code === "curve-radius-unknown"));

  const tight = medium({ alignment: "curved", curveRadiusMeters: 120 });
  const tightResult = assessVehiclePlatformCompatibility(tight);
  assert.ok(tightResult.horizontalGapMm > 100);
  assert.ok(tightResult.conditions.some((issue) => issue.code === "boarding-aid-required"));
});

test("platform width below the system and layout minimum is an explicit violation", () => {
  const plan = medium({ layoutId: "island-2track", platformWidthMeters: 4 });
  const result = assessStationPlan(plan);
  assert.equal(result.status, "incompatible");
  assert.ok(result.violations.some((issue) => issue.code === "platform-too-narrow"));
});

test("GoA4 needs screen doors, positioning, interlock, monitoring and emergency response", () => {
  const unsafe = medium({ operationMode: "goa4", screenDoorType: "none" });
  const unsafeResult = assessVehiclePlatformCompatibility(unsafe);
  assert.ok(unsafeResult.violations.some((issue) => issue.code === "goa4-screen-door-required"));

  const ready = medium({ operationMode: "goa4", screenDoorType: "full-height" });
  assert.equal(assessVehiclePlatformCompatibility(ready).status, "compatible");
});

test("deep four-track layouts are retained but marked for special large-section design", () => {
  const plan = medium({ structureId: "deep", layoutId: "double-island-4-track" });
  const result = assessStationPlan(plan);
  assert.equal(result.status, "conditional");
  assert.ok(result.conditions.some((issue) => issue.code === "wide-layout-special-design"));
});

test("invalid formations and an incompatible design vehicle fail before a plan is created", () => {
  assert.throws(() => medium({ currentCars: 2 }), /outside/);
  assert.throws(() => medium({ currentCars: 8, futureCars: 6 }), /Future/);
  assert.throws(() => medium({ vehicleModelId: "agt_3car" }), /does not match/);
});

