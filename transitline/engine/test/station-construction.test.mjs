import test from "node:test";
import assert from "node:assert/strict";
import {
  createStationAccessPlan,
  createStationConstructionContext,
  createStationPlan,
  estimateStationConstruction,
  getCountryProfile,
} from "../src/management/index.mjs";

function design(structureId = "cut-cover", overrides = {}) {
  const stationPlan = createStationPlan({
    id: `station:${structureId}`,
    technicalProfileId: "medium_steel",
    vehicleModelId: "medium_4car",
    structureId,
    layoutId: "side-2track",
    screenDoorType: "full-height",
    operationMode: "ato",
    ...overrides,
  });
  return { stationPlan, accessPlan: createStationAccessPlan(stationPlan) };
}

function completeContext(stationPlan, overrides = {}) {
  const depth = { surface: 0, elevated: 0, "cut-cover": 15, shield: 25, deep: 45 }[stationPlan.structureId];
  return createStationConstructionContext({
    stationPlanId: stationPlan.id,
    stationSiteId: `site:${stationPlan.id}`,
    depthMeters: depth,
    availableSurfaceWidthMeters: 40,
    surfaceAcquisitionAreaSquareMeters: 1_000,
    affectedBuildingCount: 0,
    utilityConflictLevel: "low",
    groundwaterRisk: "low",
    softGroundRisk: "low",
    constructionShaftAvailable: true,
    existingRailwayProximity: "none",
    landUnitCostJpyPerSquareMeter: 600_000,
    dataQuality: "high",
    unknown: [],
    unknownReasons: {},
    ...overrides,
  });
}

function estimate(structureId, countryId = "JP", contextOverrides = {}, designOverrides = {}) {
  const { stationPlan, accessPlan } = design(structureId, designOverrides);
  const context = completeContext(stationPlan, contextOverrides);
  return estimateStationConstruction({ stationPlan, accessPlan, context, countryProfile: getCountryProfile(countryId) });
}

test("station estimate separates quantities, rights, direct components, P50, P90 and schedule", () => {
  const result = estimate("cut-cover");
  assert.equal(result.feasibility, "feasible");
  assert.ok(result.quantities.bodyAreaSquareMeters > result.quantities.platformStructuralAreaSquareMeters);
  assert.ok(result.costs.civilStructure > 0);
  assert.ok(result.costs.platformEdgesAndDoors > 0);
  assert.ok(result.costs.landAndRights > 0);
  assert.ok(result.costs.totalP90 > result.costs.totalP50);
  assert.ok(result.schedule.durationP90Months > result.schedule.durationMonths);
  assert.ok(result.schedule.criticalTaskIds.includes("civil-structure"));
});

test("surface, elevated, cut-cover and deep stations produce an ordered cost and time burden", () => {
  const surface = estimate("surface");
  const elevated = estimate("elevated");
  const underground = estimate("cut-cover");
  const deep = estimate("deep");
  assert.ok(elevated.costs.totalP50 > surface.costs.totalP50);
  assert.ok(underground.costs.totalP50 > elevated.costs.totalP50);
  assert.ok(deep.costs.totalP50 > underground.costs.totalP50);
  assert.ok(deep.schedule.durationMonths > underground.schedule.durationMonths);
});

test("a narrow cut-cover work zone stays conditional and explains the extra right needed", () => {
  const result = estimate("cut-cover", "JP", { availableSurfaceWidthMeters: 12 });
  assert.equal(result.feasibility, "conditional");
  assert.ok(result.conditions.some((entry) => entry.code === "surface-work-zone-short"));
});

test("a mined station cannot treat an unverified construction shaft as secured", () => {
  const result = estimate("deep", "JP", { constructionShaftAvailable: false });
  assert.equal(result.feasibility, "conditional");
  assert.ok(result.conditions.some((entry) => entry.code === "construction-shaft-unsecured"));
});

test("a construction method that contradicts the station structure is infeasible", () => {
  const { stationPlan, accessPlan } = design("surface");
  const context = completeContext(stationPlan);
  const result = estimateStationConstruction({ stationPlan, accessPlan, context, countryProfile: getCountryProfile("JP"), methodId: "deep-mined" });
  assert.equal(result.feasibility, "infeasible");
  assert.ok(result.violations.some((entry) => entry.code === "method-structure-mismatch"));
  assert.ok(result.violations.some((entry) => entry.code === "method-depth-outside-range"));
});

test("deep stations use deep-underground rights while surface stations require acquisition", () => {
  assert.equal(estimate("deep").rights.kind, "deep-underground-right");
  assert.equal(estimate("surface").rights.kind, "surface-acquisition");
});

test("unknown building conflicts remain null in the source and use a disclosed nonzero estimate", () => {
  const { stationPlan, accessPlan } = design("cut-cover");
  const known = completeContext(stationPlan, { affectedBuildingCount: 0 });
  const unknown = completeContext(stationPlan, {
    affectedBuildingCount: null,
    dataQuality: "low",
    unknown: ["affectedBuildingCount"],
    unknownReasons: { affectedBuildingCount: "outside-coverage" },
  });
  const knownResult = estimateStationConstruction({ stationPlan, accessPlan, context: known, countryProfile: getCountryProfile("JP") });
  const unknownResult = estimateStationConstruction({ stationPlan, accessPlan, context: unknown, countryProfile: getCountryProfile("JP") });
  assert.equal(unknownResult.sourceContext.affectedBuildingCount, null);
  assert.ok(unknownResult.rights.affectedBuildingCount > 0);
  assert.ok(unknownResult.costs.totalP50 > knownResult.costs.totalP50);
  assert.ok(unknownResult.costs.totalP90 > knownResult.costs.totalP90);
  assert.ok(unknownResult.uncertainty.imputedInputs.some((entry) => entry.field === "affectedBuildingCount" && entry.reason === "outside-coverage"));
});

test("the same physical station is cheaper but takes longer through the Korean country profile", () => {
  const jp = estimate("cut-cover", "JP");
  const kr = estimate("cut-cover", "KR");
  assert.ok(kr.costs.totalP50 < jp.costs.totalP50);
  assert.ok(kr.schedule.durationMonths > jp.schedule.durationMonths);
});

test("extra entrances and transfer works increase explicit components instead of a hidden multiplier", () => {
  const { stationPlan, accessPlan } = design("cut-cover");
  const base = estimateStationConstruction({ stationPlan, accessPlan, context: completeContext(stationPlan), countryProfile: getCountryProfile("JP") });
  const expandedAccess = createStationAccessPlan(stationPlan, {
    entrances: [...accessPlan.entrances, { id: "entrance:3", widthMeters: 3, walkDistanceMeters: 300, accessible: true, demandShare: 0.2, open: true }],
    transferLinks: [{ id: "transfer:1", fromPlatformId: stationPlan.platforms[0].id, toPlatformId: stationPlan.platforms[1].id, distanceMeters: 150, levelChanges: 1, widthMeters: 3, open: true }],
  });
  const expanded = estimateStationConstruction({ stationPlan, accessPlan: expandedAccess, context: completeContext(stationPlan), countryProfile: getCountryProfile("JP") });
  assert.ok(expanded.costs.entranceStructures > base.costs.entranceStructures);
  assert.ok(expanded.costs.transferWorks > base.costs.transferWorks);
  assert.ok(expanded.costs.totalP50 > base.costs.totalP50);
});

test("the task graph starts a task only after every dependency is finished", () => {
  const result = estimate("deep");
  const byId = new Map(result.schedule.tasks.map((task) => [task.id, task]));
  for (const task of result.schedule.tasks) {
    for (const dependency of task.dependencies) assert.ok(task.startMonth >= byId.get(dependency).finishMonth, `${task.id} before ${dependency}`);
  }
});

