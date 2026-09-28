import test from "node:test";
import assert from "node:assert/strict";
import {
  ManagementGame,
  attachConstructionSitePackages,
  awardConstructionPackage,
  constructionContractorSummary,
  createConstructionContractors,
  createIntegratedConstructionSchedule,
  integrateConstructionPackageAwards,
  makeRng,
  prepareConstructionPackageProcurement,
  releaseConstructionPackageContract,
  tenderConstructionPackage,
} from "../src/management/index.mjs";
import { constructionContractorView } from "../src/construction-contractor-ui.mjs";

function fixture() {
  const planGeometry = {
    planId: "plan:contractors",
    stationCandidates: [{ id: "a", name: "A" }, { id: "b", name: "B" }, { id: "c", name: "C" }, { id: "d", name: "D" }],
    segments: [
      { id: "ab", from: "a", to: "b", lengthMeters: 1_500, structureHint: "shield" },
      { id: "bc", from: "b", to: "c", lengthMeters: 900, structureHint: "cut-cover" },
      { id: "cd", from: "c", to: "d", lengthMeters: 1_200, structureHint: "elevated" },
    ],
  };
  const project = {
    id: "project:contractors",
    planId: planGeometry.planId,
    status: "contracted",
    planGeometry,
    elapsedMonths: 0,
    progress: 0,
    delayMonths: 0,
    paid: 0,
    riskEvents: [],
    estimate: {
      guideway: 90_000_000_000,
      systems: 30_000_000_000,
      totalP50: 180_000_000_000,
      totalP90: 225_000_000_000,
      durationMonths: 48,
      parallelCivilFronts: 2,
    },
    tasks: [
      { id: "design", weight: 0.12, progress: 0 },
      { id: "civil", weight: 0.58, progress: 0 },
      { id: "systems", weight: 0.2, progress: 0 },
      { id: "testing", weight: 0.1, progress: 0 },
    ],
    assets: [],
  };
  const stationPackages = planGeometry.stationCandidates.map((station) => ({
    id: `station-package:${station.id}`,
    connectedStationId: station.id,
    status: "awarded",
    progress: 0,
    awardedBid: { durationMonths: 10 },
  }));
  const depots = [{ id: "depot-1", siteId: "depot-site-1", status: "underConstruction", progress: 0, assessment: { schedule: { durationMonths: 16 } } }];
  const vehicleOrders = [{ id: "vehicles-1", stage: "design", elapsedMonths: 0, productionMonths: 18 }];
  const schedule = createIntegratedConstructionSchedule({ project, stationPackages, depots, vehicleOrders, approvalMonths: 6 });
  const site = (constructionSiteId, kind, extra = {}) => ({
    schema: "transitline.construction-site-geometry/1",
    contractVersion: 1,
    constructionSiteId,
    kind,
    connectedPlanId: planGeometry.planId,
    connectedSegmentIds: [],
    connectedStationId: null,
    connectedDepotSiteId: null,
    unknown: [],
    unknownReasons: {},
    ...extra,
  });
  const sites = [
    site("site:tunnel", "tunnel", { connectedSegmentIds: ["ab"] }),
    site("site:cut", "cutCover", { connectedSegmentIds: ["bc"] }),
    site("site:viaduct", "viaduct", { connectedSegmentIds: ["cd"] }),
    site("site:systems", "systems", { connectedSegmentIds: ["ab", "bc", "cd"] }),
    site("site:station", "station", { connectedStationId: "b" }),
    site("site:depot", "depot", { connectedDepotSiteId: "depot-site-1" }),
  ];
  attachConstructionSitePackages(schedule, sites, { depots });
  return { project, schedule, stationPackages, depots, vehicleOrders, sites };
}

function awardAll(f, contractors, seed = 17) {
  const rng = makeRng(seed);
  prepareConstructionPackageProcurement(f.schedule, f.project);
  for (const deliveryPackage of f.schedule.constructionPackages.filter((entry) => entry.procurement)) {
    const tender = tenderConstructionPackage(f.schedule, deliveryPackage.constructionSiteId, contractors, rng, {}, { minute: 10 });
    awardConstructionPackage(f.schedule, deliveryPackage.constructionSiteId, contractors, tender.ranking[0].id, { minute: 20 });
  }
}

test("procurement replaces exactly the legacy civil and systems allowances while station and depot contracts stay separate", () => {
  const f = fixture();
  prepareConstructionPackageProcurement(f.schedule, f.project);
  const procured = f.schedule.constructionPackages.filter((entry) => entry.procurement);
  assert.equal(procured.reduce((sum, entry) => sum + entry.procurement.legacyAllowanceP50, 0), f.project.estimate.guideway + f.project.estimate.systems);
  assert.equal(f.schedule.constructionPackages.find((entry) => entry.kind === "station").contractSource, "existing-specialist-contract");
  assert.equal(f.schedule.constructionPackages.find((entry) => entry.kind === "depot").contractSource, "existing-specialist-contract");
});

test("construction bids are deterministic and require a capable contractor with the matching equipment", () => {
  const left = fixture();
  const right = fixture();
  const leftContractors = createConstructionContractors("JP");
  const rightContractors = createConstructionContractors("JP");
  prepareConstructionPackageProcurement(left.schedule, left.project);
  prepareConstructionPackageProcurement(right.schedule, right.project);
  const a = tenderConstructionPackage(left.schedule, "site:tunnel", leftContractors, makeRng(77));
  const b = tenderConstructionPackage(right.schedule, "site:tunnel", rightContractors, makeRng(77));
  assert.deepEqual(a, b);
  for (const bid of a.ranking) {
    const contractor = leftContractors.find((entry) => entry.id === bid.contractorId);
    assert.ok(contractor.packageKinds.includes("tunnel"));
    assert.ok(contractor.equipmentUnits["tunnel-boring"] > 0);
  }
});

test("awarding a package occupies contractor backlog and one named equipment unit", () => {
  const f = fixture();
  const contractors = createConstructionContractors("JP");
  prepareConstructionPackageProcurement(f.schedule, f.project);
  const tender = tenderConstructionPackage(f.schedule, "site:tunnel", contractors, makeRng(4));
  const contract = awardConstructionPackage(f.schedule, "site:tunnel", contractors, tender.ranking[0].id);
  const contractor = contractors.find((entry) => entry.id === contract.contractorId);
  assert.equal(contractor.backlog, (Number(contractor.id.split(":").at(-1)) - 1) % 2 + 1);
  assert.equal(contractor.equipmentAssignments.filter((entry) => entry.status === "assigned").length, 1);
  assert.equal(contract.equipmentAssignments[0].equipmentType, "tunnel-boring");
});

test("all awards replace legacy allowances once and contract durations flow into the integrated schedule", () => {
  const f = fixture();
  const contractors = createConstructionContractors("JP");
  const original = f.project.estimate.totalP50;
  awardAll(f, contractors);
  const replacement = integrateConstructionPackageAwards(f.schedule, f.project);
  assert.equal(f.project.estimate.totalP50, original + replacement.deltaP50);
  assert.ok(f.schedule.tasks.some((entry) => Number.isFinite(entry.contractDurationMonths)));
  assert.equal(f.schedule.contractorProcurementIntegrated, true);
  assert.deepEqual(integrateConstructionPackageAwards(f.schedule, f.project), replacement, "a second integration must not add the prices again");
});

test("ManagementGame blocks physical progress after procurement starts and reprices only the remaining master commitment", () => {
  const f = fixture();
  const game = new ManagementGame({ countryId: "JP", seed: 91, openingCash: 500_000_000_000 });
  game.projects = [f.project];
  game.stationPackages = f.stationPackages;
  f.depots[0].status = "secured";
  f.vehicleOrders[0].stage = "accepted";
  game.depots = f.depots;
  game.vehicleOrders = f.vehicleOrders;
  game.schedules = [f.schedule];
  game.ledger.commit({ id: `construction:${f.project.id}`, atMinute: 0, amount: f.project.estimate.totalP50, category: "construction", reference: f.project.id });
  game.ledger.settle(`construction:${f.project.id}`, 18_000_000_000, 0, "deposit");
  f.project.paid = 18_000_000_000;
  game.prepareConstructionProcurement(f.schedule.id);
  const blocked = game.advanceMonth().construction[0];
  assert.equal(blocked.reason, "construction-package-procurement");
  assert.equal(f.project.progress, 0);
  for (const deliveryPackage of f.schedule.constructionPackages.filter((entry) => entry.procurement)) {
    const tender = game.tenderConstructionPackage(f.schedule.id, deliveryPackage.constructionSiteId);
    game.awardConstructionPackage(f.schedule.id, deliveryPackage.constructionSiteId, tender.ranking[0].id);
  }
  game.integrateConstructionPackageAwards(f.schedule.id);
  const commitment = game.ledger.commitments.get(`construction:${f.project.id}`);
  assert.equal(commitment.original, f.project.estimate.totalP50);
  assert.equal(commitment.remaining, f.project.estimate.totalP50 - f.project.paid);
  assert.equal(game.advanceMonth().construction[0].blocked, undefined);
});

test("save/load preserves the contractor market, package contracts, and equipment reservations", () => {
  const f = fixture();
  const game = new ManagementGame({ countryId: "JP", seed: 5 });
  game.projects = [f.project];
  game.stationPackages = f.stationPackages;
  game.depots = f.depots;
  game.vehicleOrders = f.vehicleOrders;
  game.schedules = [f.schedule];
  game.prepareConstructionProcurement(f.schedule.id);
  const tender = game.tenderConstructionPackage(f.schedule.id, "site:tunnel");
  game.awardConstructionPackage(f.schedule.id, "site:tunnel", tender.ranking[0].id);
  const restored = ManagementGame.load(game.save());
  assert.deepEqual(restored.constructionContractors, game.constructionContractors);
  assert.deepEqual(restored.constructionContractorReport(), game.constructionContractorReport());
});

test("closing a package releases capacity and equipment exactly once", () => {
  const f = fixture();
  const contractors = createConstructionContractors("JP");
  prepareConstructionPackageProcurement(f.schedule, f.project);
  const tender = tenderConstructionPackage(f.schedule, "site:tunnel", contractors, makeRng(3));
  awardConstructionPackage(f.schedule, "site:tunnel", contractors, tender.ranking[0].id);
  const deliveryPackage = f.schedule.constructionPackages.find((entry) => entry.constructionSiteId === "site:tunnel");
  const contractor = contractors.find((entry) => entry.id === deliveryPackage.procurement.contract.contractorId);
  const occupied = contractor.backlog;
  assert.equal(releaseConstructionPackageContract(deliveryPackage, contractors, "completed", { minute: 30 }), true);
  assert.equal(contractor.backlog, occupied - 1);
  assert.equal(contractor.completedPackages, 1);
  assert.equal(releaseConstructionPackageContract(deliveryPackage, contractors, "completed", { minute: 60 }), false);
  assert.equal(contractor.completedPackages, 1);
  assert.equal(constructionContractorSummary(f.schedule).find((entry) => entry.constructionSiteId === "site:tunnel").procurementStatus, "awarded");
});

test("contractor UI view exposes only legal next steps", () => {
  const f = fixture();
  const runtime = { constructionSchedule: () => f.schedule };
  let view = constructionContractorView(runtime, f.project.planId);
  assert.equal(view.canPrepare, true);
  assert.equal(view.canIntegrate, false);
  const contractors = createConstructionContractors("JP");
  awardAll(f, contractors);
  view = constructionContractorView(runtime, f.project.planId);
  assert.equal(view.canPrepare, false);
  assert.equal(view.canIntegrate, true);
  integrateConstructionPackageAwards(f.schedule, f.project);
  assert.equal(constructionContractorView(runtime, f.project.planId).integrated, true);
});

test("procurement rejects missing or overlapping civil work coverage", () => {
  const missing = fixture();
  missing.schedule.constructionPackages = missing.schedule.constructionPackages.filter((entry) => entry.constructionSiteId !== "site:cut");
  assert.throws(() => prepareConstructionPackageProcurement(missing.schedule, missing.project), /exactly one construction package/);
  const overlap = fixture();
  overlap.schedule.constructionPackages.find((entry) => entry.constructionSiteId === "site:tunnel").taskIds.push(
    overlap.schedule.constructionPackages.find((entry) => entry.constructionSiteId === "site:cut").taskIds[0],
  );
  assert.throws(() => prepareConstructionPackageProcurement(overlap.schedule, overlap.project), /exactly one construction package/);
});
