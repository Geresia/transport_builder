import test from "node:test";
import assert from "node:assert/strict";
import {
  calculateFleetRequirement,
  checkVehicleCompatibility,
  createConstructionProject,
  createScenario,
  estimatePlan,
  getCountryProfile,
} from "../src/management/index.mjs";

function underground40KmPlan() {
  return {
    schema: "transitline.plan-geometry/1",
    planId: "benchmark-40km-7stations",
    coordinateReference: "EPSG:4326",
    sourcePackId: "benchmark",
    sourcePackVersion: "1",
    stationCandidates: Array.from({ length: 7 }, (_, index) => ({
      id: `s${index + 1}`,
      location: [139 + index * 0.06, 35],
      structure: "shield",
      depthMeters: 20,
      platformType: "island",
    })),
    segments: Array.from({ length: 6 }, (_, index) => ({
      from: `s${index + 1}`,
      to: `s${index + 2}`,
      lengthMeters: 40_000 / 6,
      structureHint: "shield",
      constraintFlags: [],
      dataQuality: "medium",
    })),
    accessLinks: [],
  };
}

test("40 km / 7 station underground benchmark is calibrated by country and running system", () => {
  const plan = underground40KmPlan();
  const jpAgt = estimatePlan(plan, "agt", getCountryProfile("JP"));
  const krAgt = estimatePlan(plan, "agt", getCountryProfile("KR"));
  const jpLinear = estimatePlan(plan, "linear_metro", getCountryProfile("JP"));
  const jpMedium = estimatePlan(plan, "medium_steel", getCountryProfile("JP"));

  assert.ok(jpAgt.totalP50 >= 850_000_000_000 && jpAgt.totalP50 <= 970_000_000_000, "JP AGT stays near the documented ¥893.8bn planning benchmark");
  assert.ok(krAgt.totalP50 < jpAgt.totalP50 && krAgt.totalP50 > 700_000_000_000);
  assert.ok(jpAgt.totalP50 < jpLinear.totalP50 && jpLinear.totalP50 < jpMedium.totalP50, "system choice must change capital cost");
  assert.ok(jpAgt.durationMonths >= 160 && jpAgt.durationMonths <= 190, "approval plus roughly twelve construction years");
  assert.equal(jpAgt.parallelCivilFronts, 2);
  assert.ok(krAgt.durationMonths > jpAgt.durationMonths, "KR approval profile is longer in the current rules");
});

test("40 km service needs a real fleet and the normal scenario can fund the compact option", () => {
  const plan = underground40KmPlan();
  const project = createConstructionProject(plan, "agt", getCountryProfile("JP"));
  const fleet = calculateFleetRequirement({ routeKm: 40, stations: 7, commercialSpeedKph: 30, trainsPerHour: 4 });
  assert.equal(fleet.minimumFleet, 14);
  assert.equal(checkVehicleCompatibility("agt_3car", project).compatible, true);
  assert.equal(checkVehicleCompatibility("medium_4car", project).compatible, false);

  const normal = createScenario({ id: "normal", type: "greenfield_growth", networkMode: "scratch", difficulty: "normal" });
  const hard = createScenario({ id: "hard", type: "greenfield_growth", networkMode: "scratch", difficulty: "hard" });
  assert.ok(normal.startingCash > project.estimate.totalP50);
  assert.ok(hard.startingCash < project.estimate.totalP50, "hard mode forces a cheaper alignment or additional finance");
});
