import test from "node:test";
import assert from "node:assert/strict";
import {
  ManagementGame,
  attachConstructionSitePackages,
  createIntegratedConstructionSchedule,
} from "../src/management/index.mjs";

function fixture(openingCash = 500_000_000_000) {
  const planGeometry = {
    planId: "plan:change-orders",
    stationCandidates: [{ id: "a", name: "A" }, { id: "b", name: "B" }],
    segments: [{ id: "ab", from: "a", to: "b", lengthMeters: 2_000, structureHint: "shield" }],
  };
  const project = {
    id: "project:change-orders",
    planId: planGeometry.planId,
    status: "contracted",
    planGeometry,
    elapsedMonths: 0,
    progress: 0,
    delayMonths: 0,
    paid: 0,
    riskEvents: [],
    estimate: {
      guideway: 100_000_000_000,
      systems: 20_000_000_000,
      totalP50: 180_000_000_000,
      totalP90: 225_000_000_000,
      durationMonths: 48,
      parallelCivilFronts: 1,
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
  const depots = [{ id: "depot-1", siteId: "depot-site-1", status: "secured", progress: 0, assessment: { schedule: { durationMonths: 16 } } }];
  const vehicleOrders = [{ id: "vehicles-1", stage: "accepted", elapsedMonths: 0, productionMonths: 18 }];
  const schedule = createIntegratedConstructionSchedule({ project, stationPackages, depots, vehicleOrders, approvalMonths: 6 });
  const site = (constructionSiteId, kind, connectedSegmentIds) => ({
    schema: "transitline.construction-site-geometry/1",
    contractVersion: 1,
    constructionSiteId,
    kind,
    connectedPlanId: planGeometry.planId,
    connectedSegmentIds,
    connectedStationId: null,
    connectedDepotSiteId: null,
    unknown: [],
    unknownReasons: {},
  });
  attachConstructionSitePackages(schedule, [
    site("site:tunnel", "tunnel", ["ab"]),
    site("site:systems", "systems", ["ab"]),
  ], { depots });
  const game = new ManagementGame({ countryId: "JP", seed: 121, openingCash });
  game.projects = [project];
  game.stationPackages = stationPackages;
  game.depots = depots;
  game.vehicleOrders = vehicleOrders;
  game.schedules = [schedule];
  game.ledger.commit({ id: `construction:${project.id}`, atMinute: 0, amount: project.estimate.totalP50, category: "construction", reference: project.id });
  game.prepareConstructionProcurement(schedule.id);
  for (const deliveryPackage of schedule.constructionPackages.filter((entry) => entry.procurement)) {
    const tender = game.tenderConstructionPackage(schedule.id, deliveryPackage.constructionSiteId);
    game.awardConstructionPackage(schedule.id, deliveryPackage.constructionSiteId, tender.ranking[0].id);
  }
  game.integrateConstructionPackageAwards(schedule.id);
  return { game, project, schedule };
}

const proposal = (overrides = {}) => ({
  constructionSiteId: "site:tunnel",
  geometryRevisionBefore: "geometry:v1",
  geometryRevisionAfter: "geometry:v2",
  reason: "owner-design-change",
  requestedBy: "owner",
  responsibility: "owner",
  scopeDeltaRate: 0.08,
  durationDeltaMonths: 2,
  description: "터널 선형과 작업구 위치 조정",
  ...overrides,
});

test("a proposal calculates a transparent remaining-scope estimate without changing money or the awarded contract", () => {
  const { game, project, schedule } = fixture();
  const beforeEstimate = structuredClone(project.estimate);
  const beforeContract = structuredClone(schedule.constructionPackages.find((entry) => entry.constructionSiteId === "site:tunnel").procurement.contract);
  const order = game.requestConstructionChangeOrder(schedule.id, proposal());
  assert.equal(order.status, "proposed");
  assert.equal(order.ownerShare, 1);
  assert.equal(order.ownerCostDeltaP50, order.grossCostDeltaP50);
  assert.ok(order.grossCostDeltaP50 > 0);
  assert.deepEqual(project.estimate, beforeEstimate);
  assert.deepEqual(schedule.constructionPackages.find((entry) => entry.constructionSiteId === "site:tunnel").procurement.contract, beforeContract);
});

test("responsibility changes who bears a change, and disputed responsibility must be resolved before approval", () => {
  const { game, schedule } = fixture();
  const disputed = game.requestConstructionChangeOrder(schedule.id, proposal({ responsibility: "disputed" }));
  assert.equal(disputed.status, "disputed");
  assert.equal(disputed.ownerCostDeltaP50, null);
  assert.throws(() => game.approveConstructionChangeOrder(schedule.id, disputed.id), /cannot be approved from disputed/);
  const resolved = game.resolveConstructionChangeResponsibility(schedule.id, disputed.id, "shared");
  assert.equal(resolved.status, "proposed");
  assert.equal(resolved.ownerShare, 0.5);
  assert.equal(resolved.ownerCostDeltaP50 + resolved.contractorCostDeltaP50, resolved.grossCostDeltaP50);
});

test("approval updates contract P50/P90, master estimate, remaining commitment and the critical schedule exactly once", () => {
  const { game, project, schedule } = fixture();
  const deliveryPackage = schedule.constructionPackages.find((entry) => entry.constructionSiteId === "site:tunnel");
  const contractBefore = structuredClone(deliveryPackage.procurement.contract);
  const estimateBefore = structuredClone(project.estimate);
  const commitmentBefore = game.ledger.commitments.get(`construction:${project.id}`).remaining;
  const openingBefore = schedule.forecastOpeningMonth;
  const order = game.requestConstructionChangeOrder(schedule.id, proposal());
  const approved = game.approveConstructionChangeOrder(schedule.id, order.id);
  assert.equal(approved.status, "approved");
  assert.equal(deliveryPackage.procurement.contract.currentPriceP50, contractBefore.currentPriceP50 + order.ownerCostDeltaP50);
  assert.equal(deliveryPackage.procurement.contract.priceP90, contractBefore.priceP90 + order.ownerCostDeltaP90);
  assert.equal(project.estimate.totalP50, estimateBefore.totalP50 + order.ownerCostDeltaP50);
  assert.equal(game.ledger.commitments.get(`construction:${project.id}`).remaining, commitmentBefore + order.ownerCostDeltaP50);
  assert.ok(schedule.forecastOpeningMonth >= openingBefore + order.durationDeltaMonths);
  assert.ok(schedule.delayEvents.some((entry) => entry.source === `construction-change-order:${order.id}`));
  assert.throws(() => game.approveConstructionChangeOrder(schedule.id, order.id), /cannot be approved from approved/);
});

test("rejection leaves estimates, contracts and schedule untouched", () => {
  const { game, project, schedule } = fixture();
  const before = game.snapshot();
  const order = game.requestConstructionChangeOrder(schedule.id, proposal());
  const rejected = game.rejectConstructionChangeOrder(schedule.id, order.id, "대안 검토 필요");
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.rejectionReason, "대안 검토 필요");
  assert.deepEqual(project.estimate, before.projects[0].estimate);
  assert.equal(schedule.delayEvents.length, before.schedules[0].delayEvents.length);
  assert.equal(game.ledger.commitments.get(`construction:${project.id}`).remaining, before.ledger.commitments[0].remaining);
});

test("the same geometry revision pair cannot be priced twice", () => {
  const { game, schedule } = fixture();
  const first = game.requestConstructionChangeOrder(schedule.id, proposal());
  assert.equal(first.id, "construction-change-order:1");
  assert.throws(() => game.requestConstructionChangeOrder(schedule.id, proposal()), /already exists/);
  const second = game.requestConstructionChangeOrder(schedule.id, proposal({ geometryRevisionAfter: "geometry:v3" }));
  assert.equal(second.id, "construction-change-order:2", "a failed duplicate transaction must not consume an id");
});

test("an approved geometry revision makes parallel proposals from the old base stale", () => {
  const { game, schedule } = fixture();
  const accepted = game.requestConstructionChangeOrder(schedule.id, proposal({ geometryRevisionAfter: "geometry:v2a", durationDeltaMonths: 0 }));
  const parallel = game.requestConstructionChangeOrder(schedule.id, proposal({ geometryRevisionAfter: "geometry:v2b", durationDeltaMonths: 0 }));
  game.approveConstructionChangeOrder(schedule.id, accepted.id);
  assert.throws(() => game.approveConstructionChangeOrder(schedule.id, parallel.id), /Stale geometry revision/);
  assert.throws(() => game.requestConstructionChangeOrder(schedule.id, proposal({ geometryRevisionAfter: "geometry:v3" })), /Stale geometry revision/);
  const next = game.requestConstructionChangeOrder(schedule.id, proposal({ geometryRevisionBefore: "geometry:v2a", geometryRevisionAfter: "geometry:v3" }));
  assert.equal(next.geometryRevisionBefore, "geometry:v2a");
});

test("a submitted 3D edit may be attached, but drafts and mismatched base revisions are rejected", () => {
  const { game, schedule } = fixture();
  const designEdit = { schema: "transitline.site-design-edit/1", sessionId: "session:1", stationSiteId: "station-site:a", baseRevision: "geometry:v1", status: "submitted", body: {}, entranceChanges: [] };
  const order = game.requestConstructionChangeOrder(schedule.id, proposal({ designEdit }));
  assert.deepEqual(order.designEdit, designEdit);
  assert.throws(() => game.requestConstructionChangeOrder(schedule.id, proposal({ geometryRevisionAfter: "geometry:v3", designEdit: { ...designEdit, status: "draft" } })), /Only a submitted/);
  assert.throws(() => game.requestConstructionChangeOrder(schedule.id, proposal({ geometryRevisionAfter: "geometry:v4", designEdit: { ...designEdit, baseRevision: "geometry:old" } })), /base revision does not match/);
});

test("approved value engineering reduces only the owner's contractual share", () => {
  const { game, project, schedule } = fixture();
  const before = project.estimate.totalP50;
  const order = game.requestConstructionChangeOrder(schedule.id, proposal({
    geometryRevisionAfter: "geometry:value-engineered",
    reason: "value-engineering",
    requestedBy: "contractor",
    responsibility: "shared",
    scopeDeltaRate: -0.06,
    durationDeltaMonths: 1,
  }));
  assert.ok(order.ownerCostDeltaP50 < 0);
  assert.ok(order.contractorCostDeltaP50 < 0);
  game.approveConstructionChangeOrder(schedule.id, order.id);
  assert.equal(project.estimate.totalP50, before + order.ownerCostDeltaP50);
});

test("insufficient available cash rolls an approval back atomically", () => {
  const { game, project, schedule } = fixture(230_000_000_000);
  const order = game.requestConstructionChangeOrder(schedule.id, proposal({ scopeDeltaRate: 0.5, durationDeltaMonths: 8 }));
  const beforeEstimate = structuredClone(project.estimate);
  const beforeContract = structuredClone(schedule.constructionPackages.find((entry) => entry.constructionSiteId === "site:tunnel").procurement.contract);
  const beforeDelays = structuredClone(schedule.delayEvents);
  assert.throws(() => game.approveConstructionChangeOrder(schedule.id, order.id), /Insufficient available cash/);
  const restoredProject = game.projects.find((entry) => entry.id === project.id);
  const restoredSchedule = game.schedules.find((entry) => entry.id === schedule.id);
  assert.deepEqual(restoredProject.estimate, beforeEstimate);
  assert.deepEqual(restoredSchedule.constructionPackages.find((entry) => entry.constructionSiteId === "site:tunnel").procurement.contract, beforeContract);
  assert.deepEqual(restoredSchedule.delayEvents, beforeDelays);
  assert.equal(game.constructionChangeOrderReport(schedule.id)[0].status, "proposed");
});

test("save/load preserves orders and restores the next monotonic id", () => {
  const { game, schedule } = fixture();
  const first = game.requestConstructionChangeOrder(schedule.id, proposal());
  game.rejectConstructionChangeOrder(schedule.id, first.id, "반려");
  const restored = ManagementGame.load(game.save());
  assert.deepEqual(restored.constructionChangeOrderReport(schedule.id), game.constructionChangeOrderReport(schedule.id));
  const second = restored.requestConstructionChangeOrder(schedule.id, proposal({ geometryRevisionBefore: "geometry:v2", geometryRevisionAfter: "geometry:v3" }));
  assert.equal(second.id, "construction-change-order:2");
});

