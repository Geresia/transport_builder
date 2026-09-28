import test from "node:test";
import assert from "node:assert/strict";
import {
  applyConstructionWorkfront,
  assessEquipmentWorkfront,
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
  settleConstructionPriceIndex,
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

function workfront(constructionSiteId = "site:tunnel", overrides = {}) {
  return {
    schema: "transitline.construction-workfront-geometry/1",
    contractVersion: 1,
    workfrontId: `workfront:${constructionSiteId}:main`,
    constructionSiteId,
    usableAreaSquareMeters: 1_500,
    minimumWidthMeters: 24,
    maximumSlopePercent: 2,
    intersectedBuildingCount: 0,
    waterOverlapCount: 0,
    linkedAccessCandidateRef: { kind: "vehicleAccess", id: "access:main" },
    majorRoadAccessible: true,
    equipmentAccessFacts: {
      entryWidthMeters: 8,
      turningSpaceSquareMeters: 450,
      roadWidthMeters: 6,
      overheadClearanceMeters: 5,
    },
    stagingFacts: {
      assemblyAreaSquareMeters: 650,
      storageAreaSquareMeters: 400,
      deliveryAccess: true,
    },
    unknown: [],
    unknownReasons: {},
    ...overrides,
  };
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

test("price-index settlement applies each contract model's owner share only to unfinished work", () => {
  const f = fixture();
  const contractors = createConstructionContractors("JP");
  prepareConstructionPackageProcurement(f.schedule, f.project);
  const models = new Map([
    ["site:tunnel", "fixed-price"],
    ["site:cut", "index-linked"],
    ["site:viaduct", "target-cost"],
    ["site:systems", "fixed-price"],
  ]);
  const rng = makeRng(101);
  for (const deliveryPackage of f.schedule.constructionPackages.filter((entry) => entry.procurement)) {
    const tender = tenderConstructionPackage(f.schedule, deliveryPackage.constructionSiteId, contractors, rng, {
      contractModel: models.get(deliveryPackage.constructionSiteId),
    });
    awardConstructionPackage(f.schedule, deliveryPackage.constructionSiteId, contractors, tender.ranking[0].id);
  }
  integrateConstructionPackageAwards(f.schedule, f.project);
  const tunnel = f.schedule.constructionPackages.find((entry) => entry.constructionSiteId === "site:tunnel");
  for (const taskId of tunnel.taskIds) f.schedule.tasks.find((entry) => entry.id === taskId).progress = 0.4;
  const beforeTotal = f.project.estimate.totalP50;
  const settlement = settleConstructionPriceIndex(f.schedule, f.project, 110, { minute: 1234 }, { sourceEventId: "construction-event:9" });

  const expected = f.schedule.constructionPackages.filter((entry) => entry.procurement).reduce((sum, deliveryPackage) => {
    const contract = deliveryPackage.procurement.contract;
    const progress = deliveryPackage === tunnel ? 0.4 : 0;
    const gross = Math.round(contract.originalPriceP50 * (1 - progress) * 0.1);
    return sum + Math.round(gross * contract.terms.priceAdjustmentShare);
  }, 0);
  assert.equal(settlement.ownerAdjustmentJPY, expected);
  assert.equal(f.project.estimate.totalP50, beforeTotal + expected);
  assert.equal(settlement.sourceEventId, "construction-event:9");
  assert.equal(tunnel.procurement.contract.priceAdjustments[0].progress, 0.4);
  assert.equal(tunnel.procurement.contract.lastSettledPriceIndex, 110);
  assert.ok(settlement.contractorAbsorbedJPY > 0);
});

test("the same price index is idempotent and a later settlement uses only the incremental index change", () => {
  const f = fixture();
  const contractors = createConstructionContractors("JP");
  awardAll(f, contractors, 41);
  integrateConstructionPackageAwards(f.schedule, f.project);
  const first = settleConstructionPriceIndex(f.schedule, f.project, 105, { minute: 100 });
  const afterFirst = f.project.estimate.totalP50;
  const duplicate = settleConstructionPriceIndex(f.schedule, f.project, 105, { minute: 200 });
  assert.equal(duplicate.ownerAdjustmentJPY, 0);
  assert.equal(duplicate.adjustments.length, 0);
  assert.equal(f.project.estimate.totalP50, afterFirst);
  const second = settleConstructionPriceIndex(f.schedule, f.project, 110, { minute: 300 });
  assert.ok(first.ownerAdjustmentJPY > 0);
  assert.equal(second.ownerAdjustmentJPY, first.ownerAdjustmentJPY, "equal five-point index rises at unchanged progress must settle equally");
  assert.throws(() => settleConstructionPriceIndex(f.schedule, f.project, 109), /cannot move below/);
});

test("game price-index settlement reprices the remaining commitment and survives save/load", () => {
  const f = fixture();
  const game = new ManagementGame({ countryId: "JP", seed: 15, openingCash: 500_000_000_000 });
  game.projects = [f.project];
  game.stationPackages = f.stationPackages;
  game.depots = f.depots;
  game.vehicleOrders = f.vehicleOrders;
  game.schedules = [f.schedule];
  game.ledger.commit({ id: `construction:${f.project.id}`, atMinute: 0, amount: f.project.estimate.totalP50, category: "construction", reference: f.project.id });
  awardAll(f, game.constructionContractors, 72);
  game.integrateConstructionPackageAwards(f.schedule.id);
  const previousRemaining = game.ledger.commitments.get(`construction:${f.project.id}`).remaining;
  const result = game.settleConstructionPriceIndex(f.schedule.id, 108);
  assert.equal(game.ledger.commitments.get(`construction:${f.project.id}`).remaining, previousRemaining + result.ownerAdjustmentJPY);
  const restored = ManagementGame.load(game.save());
  assert.deepEqual(restored.constructionContractorReport(f.schedule.id), game.constructionContractorReport(f.schedule.id));
  assert.deepEqual(restored.schedules[0].constructionPriceSettlements, game.schedules[0].constructionPriceSettlements);
});

test("equipment placement uses feasible, conditional and infeasible as the exact three verdicts", () => {
  const feasible = assessEquipmentWorkfront(workfront(), "tunnel-boring");
  assert.equal(feasible.placementStatus, "feasible");
  const conditional = assessEquipmentWorkfront(workfront("site:tunnel", {
    equipmentAccessFacts: { entryWidthMeters: 8, turningSpaceSquareMeters: 450, roadWidthMeters: null, overheadClearanceMeters: null },
    unknownReasons: { "equipmentAccessFacts.roadWidthMeters": "no-attribute", "equipmentAccessFacts.overheadClearanceMeters": "no-layer" },
  }), "tunnel-boring");
  assert.equal(conditional.placementStatus, "conditional");
  assert.deepEqual(conditional.conditions.map((entry) => entry.field), ["equipmentAccessFacts.roadWidthMeters", "equipmentAccessFacts.overheadClearanceMeters"]);
  const infeasible = assessEquipmentWorkfront(workfront("site:tunnel", { usableAreaSquareMeters: 200, majorRoadAccessible: false }), "tunnel-boring");
  assert.equal(infeasible.placementStatus, "infeasible");
  assert.ok(infeasible.failures.some((entry) => entry.field === "usableAreaSquareMeters"));
  assert.ok(infeasible.failures.some((entry) => entry.field === "majorRoadAccessible"));
});

test("an infeasible-only work front blocks tender, while a viable alternative is assigned to the awarded equipment", () => {
  const f = fixture();
  const contractors = createConstructionContractors("JP");
  prepareConstructionPackageProcurement(f.schedule, f.project);
  applyConstructionWorkfront(f.schedule, workfront("site:tunnel", { workfrontId: "workfront:bad", usableAreaSquareMeters: 100 }), contractors);
  assert.throws(() => tenderConstructionPackage(f.schedule, "site:tunnel", contractors, makeRng(2)), /No viable equipment work front/);
  const good = workfront("site:tunnel", { workfrontId: "workfront:good" });
  applyConstructionWorkfront(f.schedule, good, contractors);
  const tender = tenderConstructionPackage(f.schedule, "site:tunnel", contractors, makeRng(2));
  const contract = awardConstructionPackage(f.schedule, "site:tunnel", contractors, tender.ranking[0].id);
  assert.equal(contract.equipmentAssignments[0].workfrontId, good.workfrontId);
  assert.equal(contract.equipmentAssignments[0].placementStatus, "feasible");
  const report = constructionContractorSummary(f.schedule).find((entry) => entry.constructionSiteId === "site:tunnel");
  assert.equal(report.equipmentAssignments[0].contractorId, contract.contractorId);
  assert.equal(report.equipmentAssignments[0].packageContractId, contract.id);
});

test("pre-award work front assessments have a flat management report with plan and equipment context", () => {
  const f = fixture();
  const game = new ManagementGame({ countryId: "JP", seed: 34, openingCash: 500_000_000_000 });
  game.projects = [f.project];
  game.schedules = [f.schedule];
  game.prepareConstructionProcurement(f.schedule.id);
  const candidate = workfront("site:tunnel", { workfrontId: "workfront:pre-award" });
  game.applyConstructionWorkfront(f.schedule.id, candidate);

  assert.equal(game.equipmentAssignmentReport(f.schedule.id).length, 0, "equipment is not assigned before award");
  const assessments = game.workfrontAssessmentReport(f.schedule.id);
  assert.equal(assessments.length, 1);
  assert.deepEqual({
    scheduleId: assessments[0].scheduleId,
    projectId: assessments[0].projectId,
    planId: assessments[0].planId,
    constructionSiteId: assessments[0].constructionSiteId,
    equipmentType: assessments[0].equipmentType,
    workfrontId: assessments[0].workfrontId,
    placementStatus: assessments[0].placementStatus,
  }, {
    scheduleId: f.schedule.id,
    projectId: f.schedule.projectId,
    planId: f.schedule.planId,
    constructionSiteId: "site:tunnel",
    equipmentType: "tunnel-boring",
    workfrontId: candidate.workfrontId,
    placementStatus: "feasible",
  });
});

test("post-award reassignment to an infeasible work front blocks physical construction and survives save/load", () => {
  const f = fixture();
  const game = new ManagementGame({ countryId: "JP", seed: 33, openingCash: 500_000_000_000 });
  game.projects = [f.project];
  game.stationPackages = f.stationPackages;
  f.depots[0].status = "secured";
  f.vehicleOrders[0].stage = "accepted";
  game.depots = f.depots;
  game.vehicleOrders = f.vehicleOrders;
  game.schedules = [f.schedule];
  game.ledger.commit({ id: `construction:${f.project.id}`, atMinute: 0, amount: f.project.estimate.totalP50, category: "construction", reference: f.project.id });
  awardAll(f, game.constructionContractors, 88);
  game.integrateConstructionPackageAwards(f.schedule.id);
  const bad = workfront("site:tunnel", { workfrontId: "workfront:blocked", linkedAccessCandidateRef: null });
  const assessment = game.applyConstructionWorkfront(f.schedule.id, bad);
  assert.equal(assessment.placementStatus, "infeasible");
  assert.equal(game.equipmentAssignmentReport(f.schedule.id).find((entry) => entry.constructionSiteId === "site:tunnel").workfrontId, bad.workfrontId);
  assert.equal(game.advanceMonth().construction[0].reason, "equipment-workfront-infeasible");
  const restored = ManagementGame.load(game.save());
  assert.deepEqual(restored.equipmentAssignmentReport(f.schedule.id), game.equipmentAssignmentReport(f.schedule.id));
});
