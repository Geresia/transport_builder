import test from "node:test";
import assert from "node:assert/strict";
import {
  assessStationFlow,
  createStationAccessPlan,
  createStationPlan,
} from "../src/management/index.mjs";

function station(overrides = {}) {
  return createStationPlan({
    id: "station:flow",
    technicalProfileId: "medium_steel",
    vehicleModelId: "medium_4car",
    structureId: "cut-cover",
    layoutId: "side-2track",
    screenDoorType: "full-height",
    operationMode: "ato",
    ...overrides,
  });
}

function demand(overrides = {}) {
  return {
    entriesPerHour: 3_000,
    exitsPerHour: 3_000,
    transfersPerHour: 0,
    headwayMinutes: 5,
    scheduledDwellSeconds: 45,
    ...overrides,
  };
}

test("a complete default station reports access, platform, dwell and evacuation results", () => {
  const stationPlan = station();
  const accessPlan = createStationAccessPlan(stationPlan);
  const result = assessStationFlow({ stationPlan, accessPlan, demand: demand() });
  assert.equal(result.status, "adequate");
  assert.equal(result.access.accessibleRouteAvailable, true);
  assert.ok(result.platform.effectiveAreaSquareMeters > 0);
  assert.ok(result.dwell.recommendedDwellSeconds > 20);
  assert.equal(result.emergency.passes, true);
  assert.equal(result.violations.length, 0);
});

test("closing the nearest entrance reroutes passengers and can create an entrance bottleneck", () => {
  const stationPlan = station();
  const accessPlan = createStationAccessPlan(stationPlan);
  const normal = assessStationFlow({ stationPlan, accessPlan, demand: demand({ entriesPerHour: 5_000 }) });
  accessPlan.entrances[0].open = false;
  const closed = assessStationFlow({ stationPlan, accessPlan, demand: demand({ entriesPerHour: 5_000 }) });
  assert.ok(closed.access.inbound.weightedWalkMinutes > normal.access.inbound.weightedWalkMinutes);
  assert.ok(closed.flows.entry.capacityPerMinute < normal.flows.entry.capacityPerMinute);
  assert.ok(closed.violations.some((issue) => issue.code === "entry-capacity-exceeded"));
});

test("closed gates preserve demand as backlog instead of silently serving it", () => {
  const stationPlan = station();
  const accessPlan = createStationAccessPlan(stationPlan);
  accessPlan.gates[0].open = false;
  const result = assessStationFlow({ stationPlan, accessPlan, demand: demand() });
  assert.equal(result.flows.entry.servedPerMinute, 0);
  assert.ok(result.flows.entry.backlogPerMinute > 0);
  assert.ok(result.violations.some((issue) => issue.code === "entry-capacity-exceeded"));
});

test("an accessible entrance without an elevator is not a complete accessible route", () => {
  const stationPlan = station();
  const accessPlan = createStationAccessPlan(stationPlan);
  for (const item of accessPlan.circulation) if (item.type === "elevator") item.open = false;
  const result = assessStationFlow({ stationPlan, accessPlan, demand: demand() });
  assert.equal(result.access.accessibleRouteAvailable, false);
  assert.ok(result.violations.some((issue) => issue.code === "accessible-route-missing"));
});

test("transfer distance, levels and gate crossing add time and generalized resistance", () => {
  const stationPlan = station({ layoutId: "island-2track" });
  const platformId = stationPlan.platforms[0].id;
  const accessPlan = createStationAccessPlan(stationPlan, {
    transferLinks: [{
      id: "transfer:external",
      fromPlatformId: platformId,
      toPlatformId: platformId,
      distanceMeters: 180,
      levelChanges: 2,
      widthMeters: 2,
      gateCrossing: true,
      open: true,
    }],
  });
  const result = assessStationFlow({ stationPlan, accessPlan, demand: demand({ transfersPerHour: 1_800 }) });
  assert.equal(result.flows.transfer.links.length, 1);
  assert.ok(result.flows.transfer.links[0].transferMinutes > 4);
  assert.ok(result.flows.transfer.links[0].generalizedPenaltyMinutes > result.flows.transfer.links[0].transferMinutes);
});

test("transfer demand without a physical path is rejected", () => {
  const stationPlan = station();
  const accessPlan = createStationAccessPlan(stationPlan);
  const result = assessStationFlow({ stationPlan, accessPlan, demand: demand({ transfersPerHour: 1_000 }) });
  assert.ok(result.violations.some((issue) => issue.code === "transfer-path-missing"));
  assert.equal(result.flows.transfer.servedPerMinute, 0);
});

test("higher demand increases platform density and required dwell time", () => {
  const stationPlan = station();
  const accessPlan = createStationAccessPlan(stationPlan);
  const quiet = assessStationFlow({ stationPlan, accessPlan, demand: demand({ entriesPerHour: 1_000, exitsPerHour: 1_000 }) });
  const busy = assessStationFlow({ stationPlan, accessPlan, demand: demand({ entriesPerHour: 6_000, exitsPerHour: 6_000, scheduledDwellSeconds: 30 }) });
  assert.ok(busy.platform.densityPersonsPerSquareMeter > quiet.platform.densityPersonsPerSquareMeter);
  assert.ok(busy.dwell.recommendedDwellSeconds > quiet.dwell.recommendedDwellSeconds);
  assert.equal(busy.dwell.delayRisk, true);
  assert.ok(busy.warnings.some((issue) => issue.code === "scheduled-dwell-too-short"));
});

test("narrow emergency paths fail the evacuation target even when normal demand is modest", () => {
  const stationPlan = station({ layoutId: "island-2track", platformWidthMeters: 20 });
  const platformId = stationPlan.platforms[0].id;
  const accessPlan = createStationAccessPlan(stationPlan, {
    entrances: [{ id: "entrance:narrow", widthMeters: 0.5, walkDistanceMeters: 100, accessible: true, demandShare: 1, open: true }],
    circulation: [
      { id: "stair:narrow", platformId, type: "stair", widthMeters: 0.5, direction: "both", open: true },
      { id: "lift:one", platformId, type: "elevator", units: 1, direction: "both", accessible: true, open: true },
    ],
    gates: [{ id: "gates:wide", lanes: 10, direction: "both", open: true }],
    evacuationTargetMinutes: 2,
  });
  const result = assessStationFlow({ stationPlan, accessPlan, demand: demand({ entriesPerHour: 1_500, exitsPerHour: 1_500, headwayMinutes: 10 }) });
  assert.equal(result.emergency.passes, false);
  assert.ok(result.violations.some((issue) => issue.code === "evacuation-target-failed"));
});

test("flow assessment is deterministic and does not mutate the plans", () => {
  const stationPlan = station();
  const accessPlan = createStationAccessPlan(stationPlan);
  const beforeStation = structuredClone(stationPlan);
  const beforeAccess = structuredClone(accessPlan);
  const first = assessStationFlow({ stationPlan, accessPlan, demand: demand() });
  const second = assessStationFlow({ stationPlan, accessPlan, demand: demand() });
  assert.deepEqual(second, first);
  assert.deepEqual(stationPlan, beforeStation);
  assert.deepEqual(accessPlan, beforeAccess);
});

