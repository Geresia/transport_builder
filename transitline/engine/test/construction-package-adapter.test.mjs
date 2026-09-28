import test from "node:test";
import assert from "node:assert/strict";
import {
  ManagementGame,
  applyConstructionCandidateSelection,
  attachConstructionSitePackages,
  constructionPackageReports,
  createIntegratedConstructionSchedule,
  refreshIntegratedConstructionSchedule,
} from "../src/management/index.mjs";
import { buildConstructionView } from "../src/map/construction-view.mjs";

function fixture() {
  const planGeometry = {
    planId: "plan:works",
    stationCandidates: [
      { id: "a", name: "A" }, { id: "b", name: "B" }, { id: "c", name: "C" }, { id: "d", name: "D" },
    ],
    segments: [
      { id: "ab", from: "a", to: "b", lengthMeters: 1_000, structureHint: "shield" },
      { id: "bc", from: "b", to: "c", lengthMeters: 800, structureHint: "cut-cover" },
      { id: "cd", from: "c", to: "d", lengthMeters: 1_200, structureHint: "elevated" },
    ],
  };
  const project = {
    id: "project:works",
    planId: planGeometry.planId,
    status: "underConstruction",
    planGeometry,
    estimate: { parallelCivilFronts: 1 },
    tasks: [
      { id: "design", progress: 0 }, { id: "civil", progress: 0 }, { id: "systems", progress: 0 }, { id: "testing", progress: 0 },
    ],
  };
  const stationPackages = planGeometry.stationCandidates.map((station) => ({
    id: `package:${station.id}`, connectedStationId: station.id, status: "awarded", progress: 0, awardedBid: { durationMonths: 10 },
  }));
  const depots = [{ id: "depot-1", siteId: "depot-site-1", name: "Depot", status: "underConstruction", progress: 0, assessment: { schedule: { durationMonths: 18 } } }];
  const vehicleOrders = [{ id: "vehicles-1", stage: "design", elapsedMonths: 0, productionMonths: 20 }];
  const schedule = createIntegratedConstructionSchedule({ project, stationPackages, depots, vehicleOrders, approvalMonths: 6 });
  const base = (id, kind, extra = {}) => ({
    schema: "transitline.construction-site-geometry/1",
    contractVersion: 1,
    constructionSiteId: id,
    sourcePackId: "test",
    sourcePackVersion: "1",
    kind,
    name: id,
    connectedPlanId: planGeometry.planId,
    connectedSegmentIds: [],
    connectedStationId: null,
    connectedDepotSiteId: null,
    polygon: [[0, 0], [1, 0], [1, 1], [0, 1]],
    intersectedBuildingCount: null,
    unknown: ["intersectedBuildingCount"],
    unknownReasons: { intersectedBuildingCount: "no-layer" },
    warnings: [],
    ...extra,
  });
  const sites = [
    base("site:tunnel", "tunnel", { connectedSegmentIds: ["ab"] }),
    base("site:cut", "cutCover", { connectedSegmentIds: ["bc"] }),
    base("site:viaduct", "viaduct", { connectedSegmentIds: ["cd"] }),
    base("site:systems", "systems", { connectedSegmentIds: ["ab", "bc", "cd"] }),
    base("site:station", "station", { connectedStationId: "b" }),
    base("site:depot", "depot", { connectedDepotSiteId: "depot-site-1" }),
  ];
  return { project, stationPackages, depots, vehicleOrders, schedule, sites };
}

test("all six map package kinds link to the existing integrated schedule without changing spatial facts", () => {
  const f = fixture();
  const before = JSON.stringify(f.sites);
  const packages = attachConstructionSitePackages(f.schedule, f.sites, { depots: f.depots });
  assert.equal(JSON.stringify(f.sites), before, "the adapter only reads the map contract");
  assert.equal(packages.length, 6);
  assert.deepEqual(new Set(packages.map((entry) => entry.kind)), new Set(["tunnel", "cutCover", "viaduct", "systems", "station", "depot"]));
  assert.equal(packages.find((entry) => entry.kind === "tunnel").taskIds.length, 1);
  assert.equal(packages.find((entry) => entry.kind === "systems").taskIds[0], `systems:${f.project.id}`);
  assert.equal(packages.find((entry) => entry.kind === "station").spatialFacts.intersectedBuildingCount, null);
  assert.equal(packages.find((entry) => entry.kind === "station").spatialFacts.unknownReasons.intersectedBuildingCount, "no-layer");
});

test("package reports aggregate task progress and are consumed by the map view without a plan-level fallback", () => {
  const f = fixture();
  attachConstructionSitePackages(f.schedule, f.sites, { depots: f.depots });
  f.project.tasks.find((entry) => entry.id === "design").progress = 1;
  f.project.tasks.find((entry) => entry.id === "civil").progress = 0.4;
  refreshIntegratedConstructionSchedule(f.schedule, f, { minute: 8 * 30 * 1440 });
  const reports = constructionPackageReports(f.schedule);
  assert.equal(reports["site:tunnel"].status, "underConstruction");
  assert.ok(reports["site:tunnel"].progress > 0);
  assert.equal(reports["site:cut"].status, "estimated", "the next package on the same front remains blocked");
  const model = buildConstructionView({ sites: f.sites, warnings: [] }, { constructionPackages: reports });
  assert.equal(model.sites.find((entry) => entry.constructionSiteId === "site:tunnel").phase, "underConstruction");
  assert.equal(model.sites.find((entry) => entry.constructionSiteId === "site:cut").phase, "beforeStart");
});

test("a selected shaft or work area stays a management choice attached to that package", () => {
  const f = fixture();
  attachConstructionSitePackages(f.schedule, f.sites, { depots: f.depots });
  const selection = {
    schema: "transitline.construction-selection/1",
    contractVersion: 1,
    packId: "test",
    constructionSiteId: "site:tunnel",
    kind: "shaft",
    candidateId: "shaft:west",
    facts: { location: [139.1, 35.1], depthMeters: 32, unknown: [], unknownReasons: {} },
  };
  const chosen = applyConstructionCandidateSelection(f.schedule, selection);
  assert.equal(chosen.candidateId, "shaft:west");
  assert.deepEqual(f.schedule.constructionPackages.find((entry) => entry.constructionSiteId === "site:tunnel").selectedCandidate.facts.location, [139.1, 35.1]);
  assert.equal(selection.facts.depthMeters, 32, "the selection contract is not mutated");
});

test("ManagementGame saves validated incident markers and emits the exact map report shape", () => {
  const f = fixture();
  attachConstructionSitePackages(f.schedule, f.sites, { depots: f.depots });
  const game = new ManagementGame({ openingCash: 1_000_000_000 });
  game.projects = [f.project];
  game.stationPackages = f.stationPackages;
  game.depots = f.depots;
  game.vehicleOrders = f.vehicleOrders;
  game.schedules = [f.schedule];
  const marker = game.recordConstructionMarker({ constructionSiteId: "site:tunnel", kind: "incident", location: [139.1, 35.1], message: "작업 중지 사고" });
  const report = { constructionPackages: game.constructionPackageReport(), constructionMarkers: game.constructionMarkers };
  const model = buildConstructionView({ sites: f.sites, warnings: [] }, report);
  assert.equal(marker.kind, "incident");
  assert.equal(model.sites.find((entry) => entry.constructionSiteId === "site:tunnel").markers[0].message, "작업 중지 사고");
  const restored = ManagementGame.load(game.save());
  assert.deepEqual(restored.constructionMarkers, game.constructionMarkers);
  assert.deepEqual(restored.constructionPackageReport(), game.constructionPackageReport());
  assert.throws(() => game.recordConstructionMarker({ constructionSiteId: "site:nope", kind: "incident" }), /Unknown construction site/);
  assert.throws(() => game.recordConstructionMarker({ constructionSiteId: "site:tunnel", kind: "weather" }), /Unknown construction marker kind/);
});
