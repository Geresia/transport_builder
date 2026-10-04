import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ManagementGame,
  activeThroughHandoverConfirmations,
  createThroughHandoverProject,
  estimateThroughHandoverProject,
  getCountryProfile,
} from "../src/management/index.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function shippedHandoverSites() {
  return ["tokyo", "example-radial", "example-corridor"].flatMap((packId) => {
    const directory = path.join(ROOT, "packs", packId, "through-handover-examples");
    return fs.readdirSync(directory).filter((name) => name.endsWith(".handover-site.json")).sort()
      .map((name) => ({ packId, name, site: JSON.parse(fs.readFileSync(path.join(directory, name), "utf8")) }));
  });
}

function site(overrides = {}) {
  return {
    schema: "transitline.through-handover-site-geometry/1",
    contractVersion: 1,
    throughRouteId: "through-route:connector",
    routeGeometryRevision: "through-route-revision:connector:1",
    handoverId: "through-handover:connector",
    handoverSiteId: "through-handover-site:connector",
    fromLegId: "leg:a",
    toLegId: "leg:b",
    connectionLengthMeters: 240,
    minimumCurveRadiusMeters: 220,
    maximumGradientPermille: 22,
    intersectedBuildingCount: 1,
    waterCrossingCount: 0,
    roadCrossingCount: 1,
    existingRailwayCrossingCount: 1,
    selectedWorkAreaCandidateId: "work-area:1",
    externalTopologyVerified: true,
    requiredInfrastructureOwnerIds: [],
    dataQuality: "medium",
    unknown: [],
    unknownReasons: {},
    ...overrides,
  };
}

function route(revision = "through-route-revision:connector:1") {
  return {
    schema: "transitline.through-route-geometry/1",
    contractVersion: 1,
    throughRouteId: "through-route:connector",
    geometryRevision: revision,
    sourcePackId: "test",
    legs: [
      { legId: "leg:a", sourceKind: "external", connectedProjectId: null, externalNetworkId: "network:a", externalLineId: "line:a", infrastructureOwnerId: "player" },
      { legId: "leg:b", sourceKind: "external", connectedProjectId: null, externalNetworkId: "network:b", externalLineId: "line:b", infrastructureOwnerId: "player" },
    ],
    handovers: [{ handoverId: "through-handover:connector", fromLegId: "leg:a", toLegId: "leg:b", physicalConnection: false, connectionState: "separated" }],
  };
}

function catalog(r = route()) {
  return {
    schema: "transitline.external-infrastructure-catalog/1",
    packId: "test",
    packVersion: "1",
    entries: r.legs.map((leg) => ({
      legId: leg.legId,
      throughRouteId: r.throughRouteId,
      routeGeometryRevision: r.geometryRevision,
      externalNetworkId: leg.externalNetworkId,
      externalLineId: leg.externalLineId,
      infrastructureOwnerId: "player",
      technicalProfileId: "medium_steel",
      technicalSpecification: null,
      status: "available",
      capacityTrainsPerHour: 20,
    })),
  };
}

test("a handover estimate is transparent 2026 JPY and keeps map facts immutable", () => {
  const input = site();
  const before = structuredClone(input);
  const estimate = estimateThroughHandoverProject({ site: input, technicalProfileId: "medium_steel", structureType: "at-grade", turnoutCount: 2, countryProfile: getCountryProfile("JP") });
  assert.deepEqual(input, before);
  assert.equal(estimate.currency, "JPY");
  assert.equal(estimate.priceBaseYear, 2026);
  assert.equal(estimate.costBreakdownJPY.civilJPY, 720_000_000);
  assert.equal(estimate.costBreakdownJPY.turnoutJPY, 1_200_000_000);
  assert.ok(estimate.totalP90JPY > estimate.totalP50JPY);
  assert.ok(estimate.durationMonths > estimate.phasesMonths.constructionMonths);
  assert.deepEqual(estimate.review.violations, []);
});

test("every shipped map handover uses the canonical building and connection evidence fields without coercing null", () => {
  const examples = shippedHandoverSites();
  assert.equal(examples.length, 12);
  for (const { packId, name, site: mapSite } of examples) {
    const estimate = estimateThroughHandoverProject({
      site: mapSite,
      technicalProfileId: "medium_steel",
      countryProfile: getCountryProfile("JP"),
    });
    assert.equal(estimate.spatialFacts.intersectedBuildingCount, mapSite.buildingIntersectionCount, `${packId}/${name}: buildings`);
    assert.equal(estimate.spatialFacts.externalTopologyVerified, mapSite.physicalConnectionEvidence.connected, `${packId}/${name}: connection`);
    if (mapSite.buildingIntersectionCount === null) assert.equal(estimate.estimateAssumptions?.intersectedBuildingCount ?? null, estimate.totalP50JPY === null ? null : 1);
    if (mapSite.structureType) assert.equal(estimate.structureType, mapSite.structureType, `${packId}/${name}: structure`);
  }
});

test("the stale shipped route remains unknown and cannot be tendered", () => {
  const stale = shippedHandoverSites().find((entry) => entry.name === "06-route-revision-stale.handover-site.json").site;
  const game = new ManagementGame({ openingCash: 100_000_000_000 });
  const project = game.proposeThroughHandoverProject(stale, { technicalProfileId: "medium_steel" });
  assert.equal(project.spatialFacts.externalTopologyVerified, null);
  assert.ok(project.review.conditions.includes("external-topology:not-verified"));
  assert.throws(() => game.tenderThroughHandoverProject(project.id), /topology must be verified/);
});

test("unknown critical length stays null and cannot silently become a zero-cost project", () => {
  const estimate = estimateThroughHandoverProject({ site: site({ connectionLengthMeters: null, unknown: ["connectionLengthMeters"], unknownReasons: { connectionLengthMeters: "external-alignment-unavailable" } }), technicalProfileId: "medium_steel", countryProfile: getCountryProfile("JP") });
  assert.equal(estimate.totalP50JPY, null);
  assert.equal(estimate.durationMonths, null);
  assert.ok(estimate.review.conditions.includes("connectionLengthMeters:not-verified"));
  const project = createThroughHandoverProject({ id: "handover-project:unknown", site: site({ connectionLengthMeters: null }), technicalProfileId: "medium_steel", countryProfile: getCountryProfile("JP") });
  assert.equal(project.status, "needs-information");
});

test("unknown crossing counts remain null and use disclosed conservative estimating assumptions", () => {
  const estimate = estimateThroughHandoverProject({
    site: site({ intersectedBuildingCount: null, waterCrossingCount: null, roadCrossingCount: null, existingRailwayCrossingCount: null }),
    technicalProfileId: "medium_steel",
    countryProfile: getCountryProfile("JP"),
  });
  assert.equal(estimate.spatialFacts.intersectedBuildingCount, null);
  assert.equal(estimate.spatialFacts.waterCrossingCount, null);
  assert.deepEqual(estimate.estimateAssumptions, { intersectedBuildingCount: 1, waterCrossingCount: 1, roadCrossingCount: 1, existingRailwayCrossingCount: 1 });
  assert.ok(estimate.costBreakdownJPY.crossingsJPY > 0);
  assert.ok(estimate.costBreakdownJPY.relocationJPY > 0);
});

test("curve, gradient and external topology conflicts block tender instead of becoming contingencies", () => {
  const game = new ManagementGame({ openingCash: 100_000_000_000 });
  const project = game.proposeThroughHandoverProject(site({ minimumCurveRadiusMeters: 80, maximumGradientPermille: 60, externalTopologyVerified: false }), { technicalProfileId: "medium_steel" });
  assert.deepEqual(project.review.violations, ["external-topology-conflict", "maximum-gradient-above-standard", "minimum-curve-radius-below-standard"]);
  const before = game.snapshot();
  assert.throws(() => game.tenderThroughHandoverProject(project.id), /technical violations/);
  assert.deepEqual(game.snapshot(), before);
});

test("unknown external topology remains a condition and blocks tender until the map verifies it", () => {
  const game = new ManagementGame({ openingCash: 100_000_000_000 });
  const project = game.proposeThroughHandoverProject(site({ externalTopologyVerified: null }), { technicalProfileId: "medium_steel" });
  assert.ok(project.review.conditions.includes("external-topology:not-verified"));
  const before = game.snapshot();
  assert.throws(() => game.tenderThroughHandoverProject(project.id), /topology must be verified/);
  assert.deepEqual(game.snapshot(), before);
});

test("every required infrastructure owner must grant permission before tender", () => {
  const game = new ManagementGame({ openingCash: 100_000_000_000 });
  const project = game.proposeThroughHandoverProject(site({ requiredInfrastructureOwnerIds: ["owner:b", "owner:a"] }), { technicalProfileId: "medium_steel" });
  assert.equal(project.status, "proposed");
  game.grantThroughHandoverPermission(project.id, "owner:a");
  assert.equal(game.requireThroughHandoverProject(project.id).status, "proposed");
  game.grantThroughHandoverPermission(project.id, "owner:b");
  assert.equal(game.requireThroughHandoverProject(project.id).status, "permitted");
  const tender = game.tenderThroughHandoverProject(project.id);
  assert.ok(tender.ranking.length >= 1);
});

test("award reserves cash, pays progress once, releases contractor and confirms only the exact route revision", () => {
  const game = new ManagementGame({ seed: 830, openingCash: 100_000_000_000 });
  const created = game.proposeThroughHandoverProject(site(), { technicalProfileId: "medium_steel", structureType: "at-grade" });
  const tender = game.tenderThroughHandoverProject(created.id);
  const contract = game.awardThroughHandoverProject(created.id, tender.ranking[0].id);
  const project = game.requireThroughHandoverProject(created.id);
  project.riskProbability = 0;
  assert.equal(project.status, "contracted");
  assert.ok(game.ledger.commitments.has(contract.commitmentId));
  assert.equal(project.paidJPY, Math.round(contract.priceP50 * 0.1));
  const contractor = game.constructionContractors.find((entry) => entry.id === contract.contractorId);
  const occupied = contractor.backlog;
  for (let month = 0; month < contract.constructionMonths + project.phasesMonths.integrationTestingMonths; month++) game.advanceMonth();
  assert.equal(project.status, "available");
  assert.equal(project.paidJPY, contract.priceP50);
  assert.equal(game.ledger.commitments.has(contract.commitmentId), false);
  assert.equal(contractor.backlog, occupied - 1);
  const confirmations = activeThroughHandoverConfirmations(game.throughHandoverProjects);
  assert.equal(confirmations.length, 1);
  assert.equal(confirmations[0].routeGeometryRevision, route().geometryRevision);

  const oldRoute = route();
  const oldService = game.createThroughService(oldRoute, { operatorId: "player", guestModelId: "medium_4car", trainsPerHour: 4 }, catalog(oldRoute));
  assert.equal(oldService.assessment.verdict, "possible");
  const changedRoute = route("through-route-revision:connector:2");
  const changedService = game.createThroughService(changedRoute, { operatorId: "player", guestModelId: "medium_4car", trainsPerHour: 4 }, catalog(changedRoute));
  assert.equal(changedService.assessment.verdict, "impossible");
  assert.ok(changedService.assessment.violations.includes("handover:through-handover:connector:physically-separated"));
});

test("a through service can be reassessed after the connector becomes available", () => {
  const game = new ManagementGame({ seed: 831, openingCash: 100_000_000_000 });
  const r = route();
  const service = game.createThroughService(r, { operatorId: "player", guestModelId: "medium_4car", trainsPerHour: 4 }, catalog(r));
  assert.equal(service.assessment.verdict, "impossible");
  const project = game.proposeThroughHandoverProject(site(), { technicalProfileId: "medium_steel" });
  const tender = game.tenderThroughHandoverProject(project.id);
  const contract = game.awardThroughHandoverProject(project.id, tender.ranking[0].id);
  game.requireThroughHandoverProject(project.id).riskProbability = 0;
  for (let month = 0; month < contract.constructionMonths + 3; month++) game.advanceMonth();
  const reassessed = game.reassessThroughService(service.throughServiceId, r, catalog(r));
  assert.equal(reassessed.assessment.verdict, "possible");
  assert.deepEqual(reassessed.assessment.violations, []);
});

test("insufficient award cash and invalid permission roll back every game mutation", () => {
  const game = new ManagementGame({ seed: 832, openingCash: 1_000_000_000 });
  const project = game.proposeThroughHandoverProject(site(), { technicalProfileId: "medium_steel" });
  const beforePermission = game.snapshot();
  assert.throws(() => game.grantThroughHandoverPermission(project.id, "invented-owner"), /not required/);
  assert.deepEqual(game.snapshot(), beforePermission);
  const tender = game.tenderThroughHandoverProject(project.id);
  const beforeAward = game.snapshot();
  assert.throws(() => game.awardThroughHandoverProject(project.id, tender.ranking[0].id), /Insufficient available cash/);
  assert.deepEqual(game.snapshot(), beforeAward);
});

test("save/load preserves projects and old saves migrate to an empty collection with a monotonic sequence", () => {
  const game = new ManagementGame({ seed: 833, openingCash: 100_000_000_000 });
  const project = game.proposeThroughHandoverProject(site(), { technicalProfileId: "medium_steel" });
  const restored = ManagementGame.load(game.save());
  assert.deepEqual(restored.throughHandoverProjectReport(), game.throughHandoverProjectReport());
  assert.equal(restored.nextThroughHandoverProjectSequence, 2);

  const old = game.snapshot();
  delete old.throughHandoverProjects;
  delete old.nextThroughHandoverProjectSequence;
  const migrated = new ManagementGame().restore(old);
  assert.deepEqual(migrated.throughHandoverProjects, []);
  assert.equal(migrated.nextThroughHandoverProjectSequence, 1);
  assert.equal(project.id, "through-handover-project:1");
});

test("cancellation releases the unspent commitment and contractor capacity but not sunk cost", () => {
  const game = new ManagementGame({ seed: 834, openingCash: 100_000_000_000 });
  const project = game.proposeThroughHandoverProject(site(), { technicalProfileId: "medium_steel" });
  const tender = game.tenderThroughHandoverProject(project.id);
  const contract = game.awardThroughHandoverProject(project.id, tender.ranking[0].id);
  const contractor = game.constructionContractors.find((entry) => entry.id === contract.contractorId);
  const occupied = contractor.backlog;
  const paid = game.requireThroughHandoverProject(project.id).paidJPY;
  const cancelled = game.cancelThroughHandoverProject(project.id);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.sunkCostJPY, paid);
  assert.equal(game.ledger.commitments.has(contract.commitmentId), false);
  assert.equal(contractor.backlog, occupied - 1);
});
