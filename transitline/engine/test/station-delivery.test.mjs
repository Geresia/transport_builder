import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  Ledger,
  SimulationClock,
  awardStationDelivery,
  contractConstruction,
  createConstructionProject,
  createStationContractors,
  createStationDeliveryPackage,
  createStationDesignFromSite,
  estimateStationConstruction,
  getCountryProfile,
  integrateStationDeliveryPackages,
  ManagementGame,
  makeRng,
  resolveStationDeliveryConditions,
  stationDeliveryReadiness,
  synchronizeStationDeliveryPackages,
  tenderStationDelivery,
} from "../src/management/index.mjs";

const json = async (relative) => JSON.parse(await readFile(new URL(`../../${relative}`, import.meta.url), "utf8"));

async function fixture() {
  const site = await json("packs/example-radial/station-examples/01-ground-side-general.station.json");
  const plan = await json("packs/example-radial/plan-examples/04-station-variants.plan.json");
  const adaptation = createStationDesignFromSite({ site, technicalProfileId: "medium_steel", vehicleModelId: "medium_4car" });
  const estimate = estimateStationConstruction({
    stationPlan: adaptation.stationPlan,
    accessPlan: adaptation.accessPlan,
    context: adaptation.constructionContext,
    countryProfile: getCountryProfile("JP"),
  });
  const deliveryPackage = createStationDeliveryPackage({ id: "station-package:outer-4", adaptation, constructionEstimate: estimate });
  return { site, plan, adaptation, estimate, deliveryPackage };
}

async function completeFixture() {
  const plan = await json("packs/example-radial/plan-examples/04-station-variants.plan.json");
  plan.stationCandidates = plan.stationCandidates.slice(0, 2);
  plan.segments = plan.segments.slice(0, 1);
  const retainedStationIds = new Set(plan.stationCandidates.map((station) => station.id));
  plan.accessLinks = (plan.accessLinks ?? []).filter((link) => retainedStationIds.has(link.stationCandidateId ?? link.stationId));
  const sites = await Promise.all([
    json("packs/example-radial/station-examples/01-ground-side-general.station.json"),
    json("packs/example-radial/station-examples/02-elevated-island-general.station.json"),
  ]);
  const packages = sites.map((site, index) => {
    const adaptation = createStationDesignFromSite({ site, technicalProfileId: "medium_steel", vehicleModelId: "medium_4car" });
    const estimate = estimateStationConstruction({ stationPlan: adaptation.stationPlan, accessPlan: adaptation.accessPlan, context: adaptation.constructionContext, countryProfile: getCountryProfile("JP") });
    return createStationDeliveryPackage({ id: `station-package:complete:${index + 1}`, adaptation, constructionEstimate: estimate });
  });
  return { plan, packages };
}

function awardAll(packages, contractors, seed = 1) {
  const rng = makeRng(seed);
  for (const deliveryPackage of packages) {
    resolveAll(deliveryPackage);
    tenderStationDelivery(deliveryPackage, contractors, rng);
    awardStationDelivery(deliveryPackage, contractors);
  }
}

function resolveAll(deliveryPackage) {
  resolveStationDeliveryConditions(deliveryPackage, deliveryPackage.unresolvedConditions.map((condition) => ({
    code: condition.code,
    action: `Detailed design closes ${condition.code}`,
    addedCostJpy: 50_000_000,
    addedMonths: 1,
  })));
}

test("station tender cannot hide design violations or unresolved conditions", async () => {
  const { deliveryPackage } = await fixture();
  const contractors = createStationContractors("JP");
  assert.ok(deliveryPackage.unresolvedConditions.length > 0);
  assert.throws(() => tenderStationDelivery(deliveryPackage, contractors, makeRng(1)), /unresolved conditions/);
  resolveAll(deliveryPackage);
  deliveryPackage.unresolvedViolations.push({ code: "unsafe-test" });
  assert.throws(() => tenderStationDelivery(deliveryPackage, contractors, makeRng(1)), /unresolved violations/);
});

test("qualified contractors compete on price, technology and safety before award", async () => {
  const { deliveryPackage } = await fixture();
  resolveAll(deliveryPackage);
  const contractors = createStationContractors("JP");
  const tender = tenderStationDelivery(deliveryPackage, contractors, makeRng(23), { minute: 100 });
  assert.ok(tender.bidderCount >= 3);
  assert.ok(tender.ranking.every((bid) => bid.priceP50 > 0 && bid.priceP90 > bid.priceP50));
  assert.ok(tender.ranking[0].totalScore >= tender.ranking.at(-1).totalScore);
  const winner = awardStationDelivery(deliveryPackage, contractors, undefined, { minute: 200 });
  assert.equal(deliveryPackage.status, "awarded");
  assert.equal(contractors.find((entry) => entry.id === winner.contractorId).backlog, 1 + (Number(winner.contractorId.endsWith(2))));
});

test("detailed station award replaces the legacy allowance instead of being added twice", async () => {
  const { plan, deliveryPackage } = await fixture();
  resolveAll(deliveryPackage);
  const contractors = createStationContractors("JP");
  tenderStationDelivery(deliveryPackage, contractors, makeRng(7));
  awardStationDelivery(deliveryPackage, contractors);
  const project = createConstructionProject(plan, "medium_steel", getCountryProfile("JP"));
  const originalP50 = project.estimate.totalP50;
  const replacement = integrateStationDeliveryPackages(project, [deliveryPackage], { allowPartial: true });
  assert.equal(project.estimate.totalP50, Math.round(originalP50 - replacement.legacyP50 + replacement.awardedP50));
  assert.notEqual(project.estimate.totalP50, Math.round(originalP50 + replacement.awardedP50));
  assert.equal(project.stationDeliveryPackages.length, 1);
});

test("full integration requires exactly one awarded package per planned station", async () => {
  const { plan, deliveryPackage } = await fixture();
  resolveAll(deliveryPackage);
  const contractors = createStationContractors("JP");
  tenderStationDelivery(deliveryPackage, contractors, makeRng(2));
  awardStationDelivery(deliveryPackage, contractors);
  const project = createConstructionProject(plan, "medium_steel", getCountryProfile("JP"));
  assert.throws(() => integrateStationDeliveryPackages(project, [deliveryPackage]), /Every planned station/);
});

test("the master construction ledger pays the adjusted total once with no station-side commitment", async () => {
  const { plan, packages } = await completeFixture();
  const contractors = createStationContractors("JP");
  awardAll(packages, contractors, 3);
  const project = createConstructionProject(plan, "medium_steel", getCountryProfile("JP"));
  integrateStationDeliveryPackages(project, packages);
  const ledger = new Ledger(project.estimate.totalP50 * 2);
  const clock = new SimulationClock(500);
  const deposit = contractConstruction(project, ledger, clock);
  assert.equal(deposit, project.estimate.totalP50 * 0.1);
  assert.equal(ledger.commitments.size, 1);
  assert.ok(ledger.commitments.has(`construction:${project.id}`));
  assert.equal(project.stationDeliveryPackages[0].status, "underConstruction");
});

test("station packages follow suspension, testing and availability and gate opening", async () => {
  const { plan, packages } = await completeFixture();
  const contractors = createStationContractors("JP");
  awardAll(packages, contractors, 4);
  const project = createConstructionProject(plan, "medium_steel", getCountryProfile("JP"));
  integrateStationDeliveryPackages(project, packages);

  project.status = "suspended";
  synchronizeStationDeliveryPackages(project, { minute: 10 });
  assert.equal(project.stationDeliveryPackages[0].status, "suspended");
  assert.equal(stationDeliveryReadiness(project).ready, false);
  project.status = "inspection";
  project.progress = 1;
  synchronizeStationDeliveryPackages(project, { minute: 20 });
  assert.equal(project.stationDeliveryPackages[0].status, "testing");
  project.status = "available";
  synchronizeStationDeliveryPackages(project, { minute: 30 });
  assert.equal(stationDeliveryReadiness(project).ready, true);
  assert.equal(project.stationDeliveryPackages[0].progress, 1);
});

test("ManagementGame persists the station design, tender, award and adjusted project contract", async () => {
  const { plan, packages } = await completeFixture();
  const game = new ManagementGame({ countryId: "JP", seed: 41, openingCash: 5_000_000_000_000 });
  const project = game.createProject(plan, "medium_steel");
  const ids = [];
  for (const [index, source] of packages.entries()) {
    const deliveryPackage = game.designStationPackage({ id: `station-package:game:${index + 1}`, adaptation: source.design });
    game.resolveStationPackage(deliveryPackage.id, deliveryPackage.unresolvedConditions.map((condition) => ({ code: condition.code, action: "Verified by detailed design" })));
    const tender = game.tenderStationPackage(deliveryPackage.id);
    game.awardStationPackage(deliveryPackage.id, tender.ranking[0].id);
    ids.push(deliveryPackage.id);
  }
  game.integrateStationPackages(project.id, ids);
  const adjusted = game.requireProject(project.id).estimate.totalP50;
  game.contractProject(project.id);

  const restored = ManagementGame.load(game.save());
  assert.equal(restored.requireProject(project.id).estimate.totalP50, adjusted);
  assert.ok(ids.every((id) => restored.requireStationPackage(id).status === "underConstruction"));
  assert.equal(restored.ledger.commitments.size, 1);
  assert.equal(restored.stationContractors.length, 6);
});

test("project cancellation cancels its station package, releases cash and contractor capacity", async () => {
  const { plan, packages } = await completeFixture();
  const game = new ManagementGame({ countryId: "JP", seed: 51, openingCash: 5_000_000_000_000 });
  const project = game.createProject(plan, "medium_steel");
  const ids = [];
  const awards = [];
  for (const [index, source] of packages.entries()) {
    const deliveryPackage = game.designStationPackage({ id: `station-package:cancel:${index + 1}`, adaptation: source.design });
    game.resolveStationPackage(deliveryPackage.id, deliveryPackage.unresolvedConditions.map((condition) => ({ code: condition.code, action: "Resolved" })));
    const tender = game.tenderStationPackage(deliveryPackage.id);
    awards.push(game.awardStationPackage(deliveryPackage.id, tender.ranking[0].id));
    ids.push(deliveryPackage.id);
  }
  game.integrateStationPackages(project.id, ids);
  game.contractProject(project.id);
  const contractor = game.stationContractors.find((entry) => entry.id === awards[0].contractorId);
  const backlogBeforeCancel = contractor.backlog;
  game.cancelProject(project.id);
  assert.equal(game.requireProject(project.id).status, "cancelled");
  assert.ok(ids.every((id) => game.requireStationPackage(id).status === "cancelled"));
  const releasedFromContractor = awards.filter((award) => award.contractorId === contractor.id).length;
  assert.equal(contractor.backlog, backlogBeforeCancel - releasedFromContractor);
  assert.equal(game.ledger.commitments.size, 0);
});

test("partial detailed design can be estimated but cannot enter the master construction contract", async () => {
  const { plan, deliveryPackage } = await fixture();
  resolveAll(deliveryPackage);
  const contractors = createStationContractors("JP");
  tenderStationDelivery(deliveryPackage, contractors, makeRng(9));
  awardStationDelivery(deliveryPackage, contractors);
  const project = createConstructionProject(plan, "medium_steel", getCountryProfile("JP"));
  integrateStationDeliveryPackages(project, [deliveryPackage], { allowPartial: true });
  assert.equal(project.stationPackageCoverageComplete, false);
  assert.throws(() => contractConstruction(project, new Ledger(project.estimate.totalP50 * 2), new SimulationClock()), /Every planned station/);
});
