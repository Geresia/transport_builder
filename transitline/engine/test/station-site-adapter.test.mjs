import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  createStationDesignFromSite,
  estimateStationConstruction,
  getCountryProfile,
} from "../src/management/index.mjs";

const exampleUrl = (name) => new URL(`../../packs/example-radial/station-examples/${name}`, import.meta.url);
const example = async (name) => JSON.parse(await readFile(exampleUrl(name), "utf8"));

function adapt(site, selections = {}) {
  return createStationDesignFromSite({
    site,
    technicalProfileId: "medium_steel",
    vehicleModelId: "medium_4car",
    selections,
  });
}

function estimate(adaptation) {
  return estimateStationConstruction({
    stationPlan: adaptation.stationPlan,
    accessPlan: adaptation.accessPlan,
    context: adaptation.constructionContext,
    countryProfile: getCountryProfile("JP"),
  });
}

test("actual StationSiteGeometry example adapts without changing missing road width into zero", async () => {
  const result = adapt(await example("01-ground-side-general.station.json"));
  assert.equal(result.schema, "transitline.station-site-adaptation/1");
  assert.equal(result.stationPlan.structureId, "surface");
  assert.equal(result.stationPlan.layoutId, "side-2track");
  assert.equal(result.constructionContext.availableSurfaceWidthMeters, null);
  assert.equal(result.constructionContext.sourceStationSite.roadWidthMeters, null);

  const assessment = estimate(result);
  const widthImputation = assessment.uncertainty.imputedInputs.find((entry) => entry.field === "availableSurfaceWidthMeters");
  assert.equal(widthImputation.sourceValue, null);
  assert.equal(widthImputation.assumedValue, 24);
});

test("unknown public land remains unknown and is never treated as free or private", async () => {
  const result = adapt(await example("01-ground-side-general.station.json"));
  assert.ok(result.accessPlan.entrances.length > 0);
  assert.ok(result.accessPlan.entrances.every((entrance) => entrance.publicLand === null));
  assert.ok(result.adaptation.warnings.some((warning) => warning.code === "entrance-land-ownership-unknown"));
  assert.ok(estimate(result).rights.cost > 0);
});

test("unknown building conflicts remain null and cost more than verified zero through disclosed imputation", async () => {
  const site = await example("08-partial-layers.station.json");
  const unknown = adapt(site);
  assert.equal(unknown.constructionContext.affectedBuildingCount, null);
  const unknownEstimate = estimate(unknown);
  assert.ok(unknownEstimate.uncertainty.imputedInputs.some((entry) => entry.field === "affectedBuildingCount" && entry.assumedValue === 2));

  const verifiedSite = structuredClone(site);
  verifiedSite.intersectedBuildingCount = 0;
  for (const entrance of verifiedSite.entranceCandidates) entrance.collidingBuildingCount = 0;
  for (const workArea of verifiedSite.workAreaCandidates) workArea.intersectedBuildingCount = 0;
  const verified = adapt(verifiedSite);
  assert.equal(verified.constructionContext.affectedBuildingCount, 0);
  assert.ok(unknownEstimate.costs.totalP50 > estimate(verified).costs.totalP50);
});

test("only player-selected transfer candidates become external access links", async () => {
  const site = await example("05-plan-transfer.station.json");
  const none = adapt(site);
  assert.equal(none.accessPlan.transferLinks.length, 0);

  const transferId = site.transferCandidates[0].transferId;
  const selected = adapt(site, { selectedTransferIds: [transferId] });
  assert.equal(selected.accessPlan.transferLinks.length, 1);
  assert.equal(selected.accessPlan.transferLinks[0].targetStationId, site.transferCandidates[0].targetStationId);
  assert.equal(selected.accessPlan.transferLinks[0].toPlatformId, null);
  assert.equal(selected.accessPlan.transferLinks[0].spatialEvidence.basis, "player-passage");
});

test("a work-area candidate is not a secured construction shaft until explicitly secured and clear", async () => {
  const site = await example("05-plan-transfer.station.json");
  const workAreaId = site.workAreaCandidates.find((candidate) => candidate.intersectedBuildingCount === 0 && candidate.waterOverlapCount === 0).workAreaId;
  const candidateOnly = adapt(site, { selectedWorkAreaId: workAreaId });
  assert.equal(candidateOnly.constructionContext.constructionShaftAvailable, false);
  assert.equal(candidateOnly.constructionContext.selectedWorkArea.secured, false);

  const secured = adapt(site, { selectedWorkAreaId: workAreaId, workAreaSecured: true });
  assert.equal(secured.constructionContext.constructionShaftAvailable, true);
  assert.equal(secured.constructionContext.selectedWorkArea.secured, true);
});

test("default or plan-hint body dimensions remain a detailed-design condition", async () => {
  const result = adapt(await example("03-shallow-cut-cover.station.json"));
  assert.equal(result.constructionContext.bodyDimensionsConfirmed, false);
  assert.ok(estimate(result).conditions.some((condition) => condition.code === "placeholder-site-body"));
});

test("future platform length cannot exceed mapped extension space", async () => {
  const site = await example("03-shallow-cut-cover.station.json");
  site.bodyDimensionBasis = { length: "player", width: "player" };
  site.extensionSpace = [
    { end: "forward", freeLengthMeters: 5, unknown: [], unknownReasons: {} },
    { end: "backward", freeLengthMeters: 5, unknown: [], unknownReasons: {} },
  ];
  const result = adapt(site, { currentCars: 4, futureCars: 10 });
  const assessment = estimate(result);
  assert.ok(assessment.violations.some((violation) => violation.code === "extension-space-insufficient"));
});

test("adapter rejects a management selection connected to a different map station", async () => {
  const site = await example("01-ground-side-general.station.json");
  assert.throws(() => adapt(site, { connectedStationId: "different-station" }), /does not match/);
  assert.throws(() => adapt(site, { connectedPlanId: "different-plan" }), /does not match/);
});
