import test from "node:test";
import assert from "node:assert/strict";
import {
  ManagementGame,
  assessDepotCandidate,
  compareDepotCandidates,
  deadheadEconomics,
  depotCapacityRequirement,
  getCountryProfile,
} from "../src/management/index.mjs";

function site(overrides = {}) {
  return {
    schema: "transitline.depot-site-geometry/1",
    contractVersion: 1,
    depotSiteId: "site:terminal",
    sourcePackId: "test",
    sourcePackVersion: "1",
    name: "Terminal candidate",
    location: [139, 35],
    polygon: [[139, 35], [139.01, 35], [139.01, 35.01], [139, 35.01]],
    areaSquareMeters: 120_000,
    connectedPlanId: "plan:line",
    connectedSegmentId: "segment:1",
    connectionTrackLengthMeters: 300,
    distanceToTerminalMeters: 500,
    distanceToNearestStationMeters: 450,
    averageSlopePercent: 0.4,
    maximumSlopePercent: 1.2,
    intersectedBuildingCount: 1,
    roadCrossingCount: 1,
    waterCrossingCount: 0,
    waterOverlapCount: 0,
    roadsThroughSite: { highway: 0, major: 1, minor: 0 },
    connectionCrossings: { building: 0, road: 1, water: 0 },
    distanceToResidentialMeters: 300,
    surroundingBuildingDensity: 800,
    existingFacilityReuse: { status: "none", facilities: [] },
    dataQuality: "medium",
    unknown: ["groundwater"],
    unknownReasons: {},
    constraintUnknown: ["groundwater", "soft-ground"],
    sourceLayers: [],
    ...structuredClone(overrides),
  };
}

function input(overrides = {}) {
  return {
    site: site(),
    capacitySets: 14,
    inspectionSetsPerDay: 2,
    modelId: "medium_4car",
    structureId: "surface",
    mitigationPackageId: "standard",
    communityPackageId: "green-buffer",
    disclosedEarly: true,
    comparisonCount: 3,
    ...overrides,
  };
}

test("depot capacity derives physical area from fleet, train length and inspection work", () => {
  const medium = depotCapacityRequirement({ capacitySets: 14, inspectionSetsPerDay: 2, modelId: "medium_4car" });
  const agt = depotCapacityRequirement({ capacitySets: 14, inspectionSetsPerDay: 2, modelId: "agt_3car" });
  assert.ok(medium.requiredAreaSquareMeters > agt.requiredAreaSquareMeters);
  assert.ok(medium.requiredAreaSquareMeters > medium.operationalAreaSquareMeters);
  assert.equal(medium.trainLengthMeters, 82);
});

test("site assessment separates CAPEX, deadhead OPEX, community pressure and weighted score", () => {
  const assessment = assessDepotCandidate({ ...input(), countryProfile: getCountryProfile("JP") });
  assert.equal(assessment.feasibility, "feasible");
  assert.equal(assessment.siteClass, "terminal");
  assert.ok(assessment.economics.totalP90 > assessment.economics.totalP50);
  assert.ok(assessment.economics.landAcquisitionCost > 0);
  assert.ok(assessment.economics.accessTrackCapex > 0);
  assert.ok(assessment.economics.deadhead.annualTrainKm > 0);
  assert.ok(assessment.community.oppositionPressure >= 0 && assessment.community.oppositionPressure <= 100);
  assert.ok(Number.isFinite(assessment.community.severance));
  assert.ok(assessment.scores.overall >= 0 && assessment.scores.overall <= 100);
  assert.deepEqual(assessment.uncertainty.constraintUnknown, ["groundwater", "soft-ground"]);
  assert.deepEqual(assessment.uncertainty.imputedInputs, []);
});

test("unknown spatial values remain null at the contract boundary and use disclosed conservative assumptions", () => {
  const countryProfile = getCountryProfile("JP");
  const explicitZero = assessDepotCandidate({
    ...input({
      site: site({
        maximumSlopePercent: 0,
        intersectedBuildingCount: 0,
        roadCrossingCount: 0,
        waterCrossingCount: 0,
        waterOverlapCount: 0,
        roadsThroughSite: { highway: 0, major: 0, minor: 0 },
        connectionCrossings: { building: 0, road: { highway: 0, major: 0, minor: 0 }, river: 0 },
      }),
    }),
    countryProfile,
  });
  const unknownFields = [
    "maximumSlopePercent",
    "intersectedBuildingCount",
    "roadCrossingCount",
    "waterCrossingCount",
    "waterOverlapCount",
    "roadsThroughSite",
  ];
  const unknown = assessDepotCandidate({
    ...input({
      site: site({
        maximumSlopePercent: null,
        intersectedBuildingCount: null,
        roadCrossingCount: null,
        waterCrossingCount: null,
        waterOverlapCount: null,
        roadsThroughSite: null,
        connectionCrossings: { building: null, road: null, river: null },
        unknown: ["groundwater", ...unknownFields],
        unknownReasons: Object.fromEntries(unknownFields.map((field) => [field, "outside-coverage"])),
        dataQuality: "low",
      }),
    }),
    countryProfile,
  });

  assert.equal(unknown.sourceSite.intersectedBuildingCount, null);
  assert.equal(unknown.sourceSite.maximumSlopePercent, null);
  assert.equal(unknown.feasibility, "conditional");
  assert.ok(unknown.conditionalReasons.some((reason) => reason.includes("최대 경사")));
  assert.ok(unknown.economics.totalP50 > explicitZero.economics.totalP50);
  assert.ok(unknown.economics.totalP90 > explicitZero.economics.totalP90);
  assert.ok(unknown.community.relocationComplexity > explicitZero.community.relocationComplexity);
  assert.ok(unknown.scores.resilience < explicitZero.scores.resilience);
  assert.equal(unknown.uncertainty.unknownReasons.intersectedBuildingCount, "outside-coverage");
  assert.ok(unknown.uncertainty.imputedInputs.some((entry) => entry.field === "intersectedBuildingCount" && entry.assumedValue > 0));
  assert.ok(unknown.uncertainty.imputedInputs.some((entry) => entry.field === "connectionCrossings.building" && entry.assumedValue > 0));
});

test("remote land can be cheaper while deadheading and first-train time are worse", () => {
  const countryProfile = getCountryProfile("JP");
  const terminal = assessDepotCandidate({ ...input(), countryProfile });
  const remoteSite = site({
    depotSiteId: "site:remote",
    name: "Remote candidate",
    connectionTrackLengthMeters: 5_000,
    distanceToTerminalMeters: 20_000,
    distanceToResidentialMeters: 1_500,
    surroundingBuildingDensity: 100,
    intersectedBuildingCount: 0,
  });
  const remote = assessDepotCandidate({ ...input({ site: remoteSite }), countryProfile });
  assert.equal(remote.siteClass, "remote");
  assert.ok(remote.economics.landAcquisitionCost < terminal.economics.landAcquisitionCost);
  assert.ok(remote.economics.deadhead.totalAnnualCost > terminal.economics.deadhead.totalAnnualCost * 10);
  assert.ok(remote.schedule.firstTrainPenaltyMinutes > terminal.schedule.firstTrainPenaltyMinutes);
  assert.deepEqual(compareDepotCandidates([remote, terminal]).map((item) => item.rank), [1, 2]);
});

test("strong mitigation and underground construction buy acceptance with money and time", () => {
  const countryProfile = getCountryProfile("JP");
  const minimum = assessDepotCandidate({ ...input({ mitigationPackageId: "minimum", communityPackageId: "none" }), countryProfile });
  const protectedSite = assessDepotCandidate({ ...input({ structureId: "underground", mitigationPackageId: "enhanced", communityPackageId: "civic-deck" }), countryProfile });
  assert.ok(protectedSite.economics.totalP50 > minimum.economics.totalP50);
  assert.ok(protectedSite.schedule.durationMonths > minimum.schedule.durationMonths);
  assert.ok(protectedSite.community.oppositionPressure < minimum.community.oppositionPressure);
  assert.ok(protectedSite.economics.annualAncillaryRevenue > minimum.economics.annualAncillaryRevenue);
});

test("country profile changes the same physical depot estimate", () => {
  const jp = assessDepotCandidate({ ...input(), countryProfile: getCountryProfile("JP") });
  const kr = assessDepotCandidate({ ...input(), countryProfile: getCountryProfile("KR") });
  assert.ok(kr.economics.totalP50 < jp.economics.totalP50);
  assert.ok(kr.schedule.durationMonths >= jp.schedule.durationMonths);
});

test("insufficient area and excessive slope are explicit blocking reasons", () => {
  const assessment = assessDepotCandidate({
    ...input({ site: site({ areaSquareMeters: 10_000, maximumSlopePercent: 7 }) }),
    countryProfile: getCountryProfile("JP"),
  });
  assert.equal(assessment.feasibility, "infeasible");
  assert.equal(assessment.blockingReasons.length, 2);
});

test("a point-only conditional candidate cannot enter a construction contract", () => {
  const game = new ManagementGame({ countryId: "JP", openingCash: 500_000_000_000 });
  const depot = game.planDepot({ id: "depot:point", name: "Point candidate", ...input({ site: site({ areaSquareMeters: null, polygon: null }) }) });
  assert.equal(depot.assessment.feasibility, "conditional");
  assert.equal(game.negotiateDepot(depot.id).accepted, true);
  assert.throws(() => game.contractDepot(depot.id), /Conditional/);
});

test("the documented 30-set, 5 km deadhead example reproduces its direct annual loss", () => {
  const result = deadheadEconomics({ oneWayDistanceKm: 5, dailySets: 30 });
  assert.equal(result.annualTrainKm, 109_500);
  assert.equal(result.vehicleAndEnergyCost, 131_400_000);
  assert.equal(result.crewAndControlCost, 19_710_000);
  assert.equal(result.directAnnualCost, 151_110_000);
});

test("depot planning, negotiation, contract, multi-year construction and save all preserve money", () => {
  const game = new ManagementGame({ countryId: "JP", seed: 77, openingCash: 500_000_000_000 });
  const depot = game.planDepot({ id: "depot:new", name: "New depot", projectId: "project:line", ...input() });
  assert.equal(depot.status, "planned");
  const agreement = game.negotiateDepot(depot.id, { operatorShare: 0.6, nationalGovernmentShare: 0.3, localGovernmentShare: 0.1 });
  assert.equal(agreement.accepted, true);
  const contract = game.contractDepot(depot.id);
  assert.equal(depot.status, "underConstruction");
  assert.equal(contract.deposit, agreement.operatorCapex * 0.1);
  assert.equal(game.ledger.commitments.has(`depot-development:${depot.id}`), true);

  game.advanceMonth();
  const restored = ManagementGame.load(game.save());
  assert.deepEqual(restored.requireDepot(depot.id), game.requireDepot(depot.id));
  for (let month = 0; month < 180 && game.requireDepot(depot.id).status !== "secured"; month++) game.advanceMonth();
  assert.equal(game.requireDepot(depot.id).status, "secured");
  assert.equal(game.requireDepot(depot.id).entryRouteAvailable, true);
  assert.equal(game.ledger.commitments.has(`depot-development:${depot.id}`), false);
  assert.equal(game.requireDepot(depot.id).paid, agreement.operatorCapex);
  assert.equal(game.ledger.assertInvariant(), true);
});

test("a rejected municipal agreement requires a revised plan before contract", () => {
  const game = new ManagementGame({ countryId: "JP", openingCash: 500_000_000_000 });
  const hostile = site({ distanceToResidentialMeters: 0, intersectedBuildingCount: 20, surroundingBuildingDensity: 5_000, roadsThroughSite: 8 });
  const depot = game.planDepot({ id: "depot:hostile", name: "Hostile depot", ...input({ site: hostile, mitigationPackageId: "minimum", communityPackageId: "none", disclosedEarly: false, comparisonCount: 1 }) });
  const agreement = game.negotiateDepot(depot.id, { operatorShare: 0.4, nationalGovernmentShare: 0.2, localGovernmentShare: 0.4 });
  assert.equal(agreement.accepted, false);
  assert.equal(depot.status, "consultation");
  assert.throws(() => game.contractDepot(depot.id), /agreement/);
  game.reviseDepot(depot.id, { structureId: "underground", mitigationPackageId: "enhanced", communityPackageId: "civic-deck", disclosedEarly: true, comparisonCount: 3 });
  const revisedDepot = game.requireDepot(depot.id);
  assert.equal(revisedDepot.status, "planned");
  const revised = game.negotiateDepot(depot.id, { operatorShare: 0.8, nationalGovernmentShare: 0.2, localGovernmentShare: 0 });
  assert.equal(revised.accepted, true);
  assert.equal(game.contractDepot(depot.id).depotId, depot.id);
});
