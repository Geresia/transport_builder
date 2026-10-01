import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  ManagementGame,
  createStationDesignFromSite,
} from "../src/management/index.mjs";

const json = async (relative) => JSON.parse(await readFile(new URL(`../../${relative}`, import.meta.url), "utf8"));

async function fixture({ openingCash = 5_000_000_000_000 } = {}) {
  const plan = await json("packs/example-radial/plan-examples/04-station-variants.plan.json");
  plan.stationCandidates = plan.stationCandidates.slice(0, 2);
  plan.segments = plan.segments.slice(0, 1);
  const stationIds = new Set(plan.stationCandidates.map((station) => station.id));
  plan.accessLinks = (plan.accessLinks ?? []).filter((link) => stationIds.has(link.stationCandidateId ?? link.stationId));
  const sites = await Promise.all([
    json("packs/example-radial/station-examples/01-ground-side-general.station.json"),
    json("packs/example-radial/station-examples/02-elevated-island-general.station.json"),
  ]);
  const game = new ManagementGame({ countryId: "JP", seed: 811, openingCash });
  const project = game.createProject(plan, "medium_steel");
  const packageIds = [];
  for (const [index, site] of sites.entries()) {
    const adaptation = createStationDesignFromSite({ site, technicalProfileId: "medium_steel", vehicleModelId: "medium_4car" });
    const deliveryPackage = game.designStationPackage({ id: `station-package:design-change:${index + 1}`, adaptation });
    game.resolveStationPackage(deliveryPackage.id, deliveryPackage.unresolvedConditions.map((condition) => ({ code: condition.code, action: "Resolved before tender" })));
    const tender = game.tenderStationPackage(deliveryPackage.id);
    game.awardStationPackage(deliveryPackage.id, tender.ranking[0].id);
    packageIds.push(deliveryPackage.id);
  }
  game.integrateStationPackages(project.id, packageIds);
  game.contractProject(project.id);
  game.depots.push({ id: "depot:design-change", name: "Test depot", status: "secured", progress: 1, assessment: { schedule: { durationMonths: 1 } } });
  game.vehicleOrders.push({ id: "fleet:design-change", stage: "accepted", productionMonths: 1, elapsedMonths: 1, units: [] });
  const schedule = game.createIntegratedSchedule({ projectId: project.id, depotIds: ["depot:design-change"], vehicleOrderIds: ["fleet:design-change"] });
  return { game, project: game.requireProject(project.id), schedule, sites, packageIds };
}

function editFor(deliveryPackage, site, overrides = {}) {
  const body = {
    location: [...site.location],
    headingDegrees: site.bodyHeadingDegrees,
    lengthMeters: deliveryPackage.estimate.quantities.bodyLengthMeters + 20,
    widthMeters: deliveryPackage.estimate.quantities.bodyWidthMeters + 8,
    depthMeters: deliveryPackage.design.stationPlan.structureId === "elevated" ? -12 : deliveryPackage.design.constructionContext.depthMeters,
    ...(overrides.body ?? {}),
  };
  return {
    schema: "transitline.site-design-edit/1",
    sessionId: overrides.sessionId ?? "site-session:1",
    stationSiteId: deliveryPackage.stationSiteId,
    baseRevision: overrides.baseRevision ?? deliveryPackage.geometryRevision,
    status: overrides.status ?? "submitted",
    body,
    entranceChanges: overrides.entranceChanges ?? [],
  };
}

function clearCollision(edit) {
  return {
    schema: "transitline.site-design-collision-result/1",
    sessionId: edit.sessionId,
    requestId: "collision:1",
    bodyCollision: false,
    entranceCollisions: edit.entranceChanges.filter((entry) => (entry.action ?? "move") !== "remove").map((entry) => ({ entranceId: entry.entranceId, collides: false })),
    workAreaCollisions: (edit.workAreaChanges ?? []).map((entry) => ({ workAreaId: entry.workAreaId, collides: false })),
  };
}

function scaledPolygon(polygon, factor) {
  const center = polygon.reduce((sum, point) => [sum[0] + point[0] / polygon.length, sum[1] + point[1] / polygon.length], [0, 0]);
  return polygon.map((point) => [center[0] + (point[0] - center[0]) * factor, center[1] + (point[1] - center[1]) * factor]);
}

test("a submitted 3D edit is repriced without mutating contract, project, cash or schedule before approval", async () => {
  const { game, project, schedule, sites, packageIds } = await fixture();
  const deliveryPackage = game.requireStationPackage(packageIds[0]);
  const edit = editFor(deliveryPackage, sites[0]);
  const before = {
    estimate: structuredClone(deliveryPackage.estimate),
    bid: structuredClone(deliveryPackage.awardedBid),
    projectP50: project.estimate.totalP50,
    cash: game.ledger.cash,
    commitment: structuredClone(game.ledger.commitments.get(`construction:${project.id}`)),
    task: structuredClone(schedule.tasks.find((entry) => entry.source.type === "station-package" && entry.source.entityId === deliveryPackage.id)),
  };

  const proposal = game.requestStationDesignChange(deliveryPackage.id, { designEdit: edit, collisionResult: clearCollision(edit) });
  assert.equal(proposal.schema, "transitline.station-design-change/1");
  assert.equal(proposal.status, "proposed");
  assert.equal(proposal.baseRevision, "station-design:station-package:design-change:1:0");
  assert.ok(proposal.costDeltaP50 > 0);
  assert.ok(proposal.estimateAfter.quantities.bodyLengthMeters > proposal.estimateBefore.quantities.bodyLengthMeters);
  assert.ok(proposal.estimateAfter.quantities.bodyWidthMeters > proposal.estimateBefore.quantities.bodyWidthMeters);
  assert.deepEqual(deliveryPackage.estimate, before.estimate);
  assert.deepEqual(deliveryPackage.awardedBid, before.bid);
  assert.equal(project.estimate.totalP50, before.projectP50);
  assert.equal(game.ledger.cash, before.cash);
  assert.deepEqual(game.ledger.commitments.get(`construction:${project.id}`), before.commitment);
  assert.deepEqual(schedule.tasks.find((entry) => entry.id === before.task.id), before.task);
});

test("approval atomically updates station design, contract, project replacement, commitment, schedule and revision", async () => {
  const { game, project, schedule, sites, packageIds } = await fixture();
  const deliveryPackage = game.requireStationPackage(packageIds[0]);
  const edit = editFor(deliveryPackage, sites[0]);
  const projectP50 = project.estimate.totalP50;
  const replacementP50 = project.estimate.stationDetailReplacement.awardedP50;
  const cash = game.ledger.cash;
  const proposal = game.requestStationDesignChange(deliveryPackage.id, { designEdit: edit, collisionResult: clearCollision(edit) });
  const approved = game.approveStationDesignChange(deliveryPackage.id, proposal.id);

  assert.equal(approved.status, "approved");
  assert.equal(deliveryPackage.geometryRevision, proposal.proposedRevision);
  assert.equal(deliveryPackage.designRevision, 1);
  assert.equal(deliveryPackage.estimate.costs.totalP50, proposal.estimateAfter.costs.totalP50);
  assert.equal(deliveryPackage.awardedBid.priceP50, proposal.contractAfter.priceP50);
  assert.equal(project.estimate.totalP50, projectP50 + proposal.costDeltaP50);
  assert.equal(project.estimate.stationDetailReplacement.awardedP50, replacementP50 + proposal.costDeltaP50);
  assert.equal(game.ledger.cash, cash, "approval adjusts the commitment but makes no immediate payment");
  const commitment = game.ledger.commitments.get(`construction:${project.id}`);
  assert.equal(commitment.original, project.estimate.totalP50);
  assert.equal(commitment.remaining, project.estimate.totalP50 - project.paid);
  const embedded = project.stationDeliveryPackages.find((entry) => entry.id === deliveryPackage.id);
  assert.equal(embedded.geometryRevision, proposal.proposedRevision);
  assert.equal(embedded.awardedBid.priceP50, proposal.contractAfter.priceP50);
  const task = schedule.tasks.find((entry) => entry.source.type === "station-package" && entry.source.entityId === deliveryPackage.id);
  assert.equal(task.currentDurationMonths, Math.max(task.baselineDurationMonths, proposal.contractAfter.durationMonths));
});

test("cancelled, stale, mismatched and duplicate session edits are rejected without consuming an id", async () => {
  const { game, sites, packageIds } = await fixture();
  const deliveryPackage = game.requireStationPackage(packageIds[0]);
  const sequence = game.nextStationDesignChangeSequence;
  assert.throws(() => game.requestStationDesignChange(deliveryPackage.id, { designEdit: editFor(deliveryPackage, sites[0], { status: "cancelled" }) }), /submitted/);
  assert.throws(() => game.requestStationDesignChange(deliveryPackage.id, { designEdit: editFor(deliveryPackage, sites[0], { baseRevision: "stale" }) }), /base revision/);
  const mismatch = editFor(deliveryPackage, sites[0]);
  mismatch.stationSiteId = "station-site:other";
  assert.throws(() => game.requestStationDesignChange(deliveryPackage.id, { designEdit: mismatch }), /does not match/);
  assert.equal(game.nextStationDesignChangeSequence, sequence);

  const edit = editFor(deliveryPackage, sites[0]);
  game.requestStationDesignChange(deliveryPackage.id, { designEdit: edit });
  assert.throws(() => game.requestStationDesignChange(deliveryPackage.id, { designEdit: edit }), /Duplicate|awaiting/);
  assert.equal(game.nextStationDesignChangeSequence, sequence + 1);
});

test("a rejected edit can be corrected and resubmitted from the same still-open 3D session", async () => {
  const { game, sites, packageIds } = await fixture();
  const deliveryPackage = game.requireStationPackage(packageIds[0]);
  const firstEdit = editFor(deliveryPackage, sites[0], { sessionId: "site-session:retry" });
  const first = game.requestStationDesignChange(deliveryPackage.id, { designEdit: firstEdit, collisionResult: clearCollision(firstEdit) });
  game.rejectStationDesignChange(deliveryPackage.id, first.id, "Please reduce the footprint");
  const secondEdit = editFor(game.requireStationPackage(deliveryPackage.id), sites[0], {
    sessionId: "site-session:retry",
    body: { lengthMeters: deliveryPackage.estimate.quantities.bodyLengthMeters + 10 },
  });
  const second = game.requestStationDesignChange(deliveryPackage.id, { designEdit: secondEdit, collisionResult: clearCollision(secondEdit) });
  assert.equal(second.id, "station-design-change:2");
  assert.equal(second.sessionId, first.sessionId);
  assert.notEqual(second.designEdit.body.lengthMeters, first.designEdit.body.lengthMeters);
});

test("confirmed collision blocks approval while rejection leaves the approved design unchanged", async () => {
  const { game, project, sites, packageIds } = await fixture();
  const deliveryPackage = game.requireStationPackage(packageIds[0]);
  const edit = editFor(deliveryPackage, sites[0]);
  const collision = { ...clearCollision(edit), bodyCollision: true };
  const before = structuredClone(deliveryPackage.design);
  const projectP50 = project.estimate.totalP50;
  const proposal = game.requestStationDesignChange(deliveryPackage.id, { designEdit: edit, collisionResult: collision });
  assert.throws(() => game.approveStationDesignChange(deliveryPackage.id, proposal.id), /spatial collision/);
  assert.deepEqual(game.requireStationPackage(deliveryPackage.id).design, before);
  assert.equal(game.requireProject(project.id).estimate.totalP50, projectP50);
  const rejected = game.rejectStationDesignChange(deliveryPackage.id, proposal.id, "Move the body away from the building");
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.rejectionReason, "Move the body away from the building");
  assert.deepEqual(deliveryPackage.design, before);
});

test("missing collision review cannot be approved and an unaffordable approval rolls back atomically", async () => {
  const { game, project, sites, packageIds } = await fixture();
  let deliveryPackage = game.requireStationPackage(packageIds[0]);
  const edit = editFor(deliveryPackage, sites[0]);
  const unknown = game.requestStationDesignChange(deliveryPackage.id, { designEdit: edit });
  assert.equal(unknown.collision.status, "unknown");
  assert.throws(() => game.approveStationDesignChange(deliveryPackage.id, unknown.id), /collision review is incomplete/);
  game.rejectStationDesignChange(deliveryPackage.id, unknown.id, "Collision facts required");

  deliveryPackage = game.requireStationPackage(packageIds[0]);
  const hugeEdit = editFor(deliveryPackage, sites[0], {
    sessionId: "site-session:huge",
    body: { lengthMeters: 2_000, widthMeters: 600 },
  });
  const proposal = game.requestStationDesignChange(deliveryPackage.id, { designEdit: hugeEdit, collisionResult: clearCollision(hugeEdit) });
  game.ledger.commit({ id: "other-capital-program", atMinute: game.clock.minute, amount: game.ledger.availableCash - 1, category: "other-project", reference: "test" });
  const projectBefore = structuredClone(game.requireProject(project.id));
  const packageBefore = structuredClone(game.requireStationPackage(deliveryPackage.id));
  const commitmentBefore = structuredClone(game.ledger.commitments.get(`construction:${project.id}`));
  assert.throws(() => game.approveStationDesignChange(deliveryPackage.id, proposal.id), /Insufficient available cash/);
  assert.deepEqual(game.requireProject(project.id), projectBefore);
  assert.deepEqual(game.requireStationPackage(deliveryPackage.id), packageBefore);
  assert.deepEqual(game.ledger.commitments.get(`construction:${project.id}`), commitmentBefore);
});

test("elevated negative editor depth becomes track elevation, not negative excavation depth", async () => {
  const { game, sites, packageIds } = await fixture();
  const deliveryPackage = game.requireStationPackage(packageIds[1]);
  const edit = editFor(deliveryPackage, sites[1]);
  const proposal = game.requestStationDesignChange(deliveryPackage.id, { designEdit: edit, collisionResult: clearCollision(edit) });
  assert.equal(proposal.revisedDesign.constructionContext.depthMeters, 0);
  assert.equal(proposal.revisedDesign.constructionContext.sourceStationSite.plannedTrackElevationMeters, 12);
  game.rejectStationDesignChange(deliveryPackage.id, proposal.id, "depth validation test");
  assert.throws(() => game.requestStationDesignChange(deliveryPackage.id, {
    designEdit: editFor(deliveryPackage, sites[1], { sessionId: "site-session:bad", body: { depthMeters: 5 } }),
  }), /elevated station/);
});

test("entrance add and selected work-area resize flow into the revised access plan and land estimate", async () => {
  const { game, sites, packageIds } = await fixture();
  const deliveryPackage = game.requireStationPackage(packageIds[0]);
  const selected = deliveryPackage.design.constructionContext.selectedWorkArea;
  assert.ok(selected?.workAreaId && selected?.polygon);
  const edit = editFor(deliveryPackage, sites[0], {
    sessionId: "site-session:spatial-edits",
    entranceChanges: [{ entranceId: "ent-draft:test", action: "add", location: [sites[0].location[0] + 0.0001, sites[0].location[1]] }],
  });
  edit.workAreaChanges = [{ workAreaId: selected.workAreaId, polygon: scaledPolygon(selected.polygon, 1.5) }];
  const proposal = game.requestStationDesignChange(deliveryPackage.id, { designEdit: edit, collisionResult: clearCollision(edit) });
  assert.equal(proposal.revisedDesign.accessPlan.entrances.length, deliveryPackage.design.accessPlan.entrances.length + 1);
  assert.ok(proposal.revisedDesign.accessPlan.entrances.find((entry) => entry.id === "ent-draft:test").demandShare > 0);
  assert.ok(Math.abs(proposal.revisedDesign.accessPlan.entrances.reduce((sum, entry) => sum + entry.demandShare, 0) - 1) < 1e-9);
  assert.ok(proposal.revisedDesign.constructionContext.selectedWorkArea.areaSquareMeters > selected.areaSquareMeters);
  assert.ok(proposal.estimateAfter.rights.surfaceAreaSquareMeters > proposal.estimateBefore.rights.surfaceAreaSquareMeters);
  assert.ok(proposal.estimateAfter.costs.entranceStructures > proposal.estimateBefore.costs.entranceStructures);
});

test("approved station design revisions and the next sequence survive save and load", async () => {
  const { game, sites, packageIds } = await fixture();
  const deliveryPackage = game.requireStationPackage(packageIds[0]);
  const edit = editFor(deliveryPackage, sites[0]);
  const proposal = game.requestStationDesignChange(deliveryPackage.id, { designEdit: edit, collisionResult: clearCollision(edit) });
  game.approveStationDesignChange(deliveryPackage.id, proposal.id);
  const restored = ManagementGame.load(game.save());
  const restoredPackage = restored.requireStationPackage(deliveryPackage.id);
  assert.equal(restoredPackage.geometryRevision, proposal.proposedRevision);
  assert.equal(restoredPackage.designChanges[0].status, "approved");
  assert.equal(restored.nextStationDesignChangeSequence, 2);
  assert.deepEqual(restored.stationDesignChangeReport(deliveryPackage.id), restoredPackage.designChanges);
});
// End of station design change regression coverage.
