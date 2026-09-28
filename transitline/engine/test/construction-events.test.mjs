import test from "node:test";
import assert from "node:assert/strict";
import {
  ManagementGame,
  applyConstructionCandidateSelection,
  attachConstructionSitePackages,
  constructionEventRisk,
  createIntegratedConstructionSchedule,
  rollConstructionEvent,
} from "../src/management/index.mjs";
import { buildConstructionImpact } from "../src/map/construction-impact.mjs";
import { makeSpatialContext } from "../src/map/spatial.mjs";

function fixture({ cash = 500_000_000_000 } = {}) {
  const planGeometry = {
    planId: "plan:event-test",
    stationCandidates: [{ id: "a", name: "A" }, { id: "b", name: "B" }],
    segments: [{ id: "ab", from: "a", to: "b", lengthMeters: 2_000, structureHint: "shield" }],
  };
  const project = {
    id: "project:event-test",
    planId: planGeometry.planId,
    status: "underConstruction",
    planGeometry,
    estimate: { totalP50: 200_000_000_000, durationMonths: 36, parallelCivilFronts: 1 },
    progress: 0.2,
    elapsedMonths: 8,
    delayMonths: 0,
    paid: 40_000_000_000,
    tasks: [
      { id: "design", weight: 0.12, progress: 1 },
      { id: "civil", weight: 0.58, progress: 0.14 },
      { id: "systems", weight: 0.2, progress: 0 },
      { id: "testing", weight: 0.1, progress: 0 },
    ],
    riskEvents: [],
  };
  const stationPackages = planGeometry.stationCandidates.map((station) => ({
    id: `station-package:${station.id}`,
    connectedStationId: station.id,
    status: "awarded",
    progress: 0,
    awardedBid: { durationMonths: 8 },
  }));
  const depots = [{ id: "depot:event-test", siteId: "depot-site:event-test", status: "planned", progress: 0, assessment: { schedule: { durationMonths: 12 } } }];
  const vehicleOrders = [{ id: "vehicles:event-test", stage: "design", elapsedMonths: 0, productionMonths: 14 }];
  const schedule = createIntegratedConstructionSchedule({ project, stationPackages, depots, vehicleOrders, approvalMonths: 1 });
  const site = {
    schema: "transitline.construction-site-geometry/1",
    contractVersion: 1,
    constructionSiteId: "construction-site:tunnel",
    kind: "tunnel",
    name: "도심 실드 공구",
    connectedPlanId: planGeometry.planId,
    connectedSegmentIds: ["ab"],
    connectedStationId: null,
    connectedDepotSiteId: null,
    polygon: [[139, 35], [139.01, 35], [139.01, 35.001], [139, 35.001]],
    spatialFlags: ["near-residential", "steep-corridor"],
    intersectedBuildingCount: 4,
    vehicleAccessCandidates: [],
    constraintUnknown: ["groundwater", "soft-ground", "utilities"],
    shaftCandidates: [{ shaftId: "shaft:east", location: [139.005, 35.0005] }],
    workAreaCandidates: [],
    materialYardCandidates: [],
    accessRoadCandidates: [],
    vehicleAccessCandidates: [],
    dataQuality: "low",
    unknown: ["groundwater", "soft-ground", "utilities"],
    unknownReasons: { groundwater: "no-layer", "soft-ground": "no-layer", utilities: "no-layer" },
  };
  attachConstructionSitePackages(schedule, [site], { depots });
  applyConstructionCandidateSelection(schedule, {
    schema: "transitline.construction-selection/1",
    contractVersion: 1,
    constructionSiteId: site.constructionSiteId,
    kind: "shaft",
    candidateId: "shaft:east",
    facts: { location: [139.005, 35.0005], depthMeters: 28, unknown: [], unknownReasons: {} },
  });
  const game = new ManagementGame({ countryId: "JP", seed: 801, openingCash: cash });
  game.projects = [project];
  game.stationPackages = stationPackages;
  game.depots = depots;
  game.vehicleOrders = vehicleOrders;
  game.schedules = [schedule];
  return { game, project, schedule, site };
}

test("spatial facts affect a transparent monthly risk value without mutating the map contract", () => {
  const { game, schedule, site } = fixture();
  const before = structuredClone(site);
  const deliveryPackage = schedule.constructionPackages[0];
  const risk = constructionEventRisk(deliveryPackage, game.country, 1.35);
  assert.ok(risk.monthlyProbability > 0.006);
  assert.equal(risk.dataQuality, "low");
  assert.deepEqual(site, before);
});

test("a deterministic roll creates at most one event with reproducible kind and severity", () => {
  const { game, project, schedule } = fixture();
  const values = [0, 0, 0];
  const rng = { next: () => values.shift() ?? 0 };
  const event = rollConstructionEvent({
    id: "construction-event:forced-roll",
    schedule,
    project,
    countryProfile: game.country,
    difficultyFactor: 1,
    rng,
    clock: game.clock,
    existingEvents: [],
  });
  assert.equal(event.kind, "cost-inflation");
  assert.equal(event.severity, "minor");
  assert.equal(event.constructionSiteId, "construction-site:tunnel");
  assert.ok(event.responses.length >= 3);
});

test("an incident records unavoidable delay and a map marker, then a response changes cash and management metrics", () => {
  const { game, project, schedule } = fixture();
  const baselineFinish = schedule.forecastOpeningMonth;
  const event = game.triggerConstructionEvent(schedule.id, {
    constructionSiteId: "construction-site:tunnel",
    kind: "incident",
    severity: "major",
  });
  assert.equal(event.unavoidableDelayMonths, 2);
  assert.deepEqual(event.eventLocation, [139.005, 35.0005]);
  const affectedTask = schedule.tasks.find((entry) => entry.id === event.affectedTaskId);
  assert.ok(affectedTask.extraDelayMonths >= 2);
  assert.ok(schedule.forecastOpeningMonth >= baselineFinish, "a non-critical package may consume float before moving opening");
  assert.equal(game.constructionMarkers[0].eventId, event.id);
  assert.equal(game.constructionMarkers[0].kind, "incident");
  assert.equal(game.constructionMarkers[0].status, "unresolved");

  const cashBefore = game.ledger.cash;
  const reputationBefore = game.player.reputation;
  const result = game.respondConstructionEvent(event.id, "accelerated-recovery");
  assert.ok(result.outcome.upfrontCostJPY > 0);
  assert.equal(game.ledger.cash, cashBefore - result.outcome.upfrontCostJPY);
  assert.equal(game.player.reputation, reputationBefore);
  assert.ok(project.constructionMetrics.safety > 70);
  assert.equal(game.constructionMarkers[0].status, "resolved");
  assert.throws(() => game.respondConstructionEvent(event.id, "full-investigation"), /already resolved/);
});

test("complaint choices expose a real cost-delay-reputation trade-off", () => {
  const { game, schedule } = fixture();
  const event = game.triggerConstructionEvent(schedule.id, {
    constructionSiteId: "construction-site:tunnel",
    kind: "complaint",
    severity: "moderate",
  });
  const mitigation = event.responses.find((entry) => entry.id === "community-mitigation");
  const continueWork = event.responses.find((entry) => entry.id === "continue-work");
  assert.ok(mitigation.upfrontCostJPY > continueWork.upfrontCostJPY);
  assert.ok(mitigation.delayMonths > continueWork.delayMonths);
  assert.ok(mitigation.reputationDelta > continueWork.reputationDelta);
  const priorReputation = game.player.reputation;
  game.respondConstructionEvent(event.id, "continue-work");
  assert.equal(game.player.reputation, priorReputation - 8);
});

test("unanswered events use the designated affordable default after one month", () => {
  const { game, project, schedule } = fixture();
  const event = game.triggerConstructionEvent(schedule.id, {
    constructionSiteId: "construction-site:tunnel",
    kind: "utility-conflict",
    severity: "minor",
  });
  project.status = "suspended";
  game.clock.advance(30 * 1440);
  game.resolveExpiredConstructionEvents();
  const resolved = game.requireConstructionEvent(event.id);
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.selectedResponseId, "relocate-utility");
  assert.equal(resolved.outcome.automatic, true);
});

test("events, responses, metrics and marker status survive save and load", () => {
  const { game, schedule } = fixture();
  const event = game.triggerConstructionEvent(schedule.id, {
    constructionSiteId: "construction-site:tunnel",
    kind: "unexpected-ground",
    severity: "moderate",
  });
  game.respondConstructionEvent(event.id, "ground-improvement");
  const restored = ManagementGame.load(game.save());
  assert.deepEqual(restored.constructionEvents, game.constructionEvents);
  assert.deepEqual(restored.constructionMarkers, game.constructionMarkers);
  assert.deepEqual(restored.projects[0].constructionMetrics, game.projects[0].constructionMetrics);
  assert.equal(restored.ledger.cash, game.ledger.cash);
});

test("a validated map impact selection changes the offered response cost and delay and enters responding state", () => {
  const { game, schedule } = fixture();
  const event = game.triggerConstructionEvent(schedule.id, {
    constructionSiteId: "construction-site:tunnel",
    kind: "access-blocked",
    severity: "moderate",
  });
  const before = event.responses.find((entry) => entry.id === "alternate-access");
  const result = game.applyConstructionImpact(event.id, {
    schema: "transitline.construction-impact-geometry/1",
    contractVersion: 1,
    eventId: event.id,
    constructionSiteId: event.constructionSiteId,
    eventKind: event.kind,
    eventLocation: [139.006, 35.0006],
    affectedPolygon: [[139, 35], [139.001, 35], [139.001, 35.001]],
    spatialFacts: { majorRoadAccessible: true, distanceToResidentialMeters: 180 },
    linkedCandidateIds: [],
    alternativeCandidates: [{ kind: "vehicleAccess", id: "vehicle-access:alt", constructionSiteId: event.constructionSiteId, distanceMeters: 300, location: [139.006, 35.0006] }],
    selectedResponseCandidateId: "vehicle-access:alt",
    dataQuality: "medium",
    unknown: [],
    unknownReasons: {},
  });
  const after = result.event.responses.find((entry) => entry.id === "alternate-access");
  assert.equal(result.event.status, "responding");
  assert.equal(result.adjustment.selectedResponseCandidateId, "vehicle-access:alt");
  assert.ok(after.delayMonths < before.delayMonths);
  assert.notEqual(after.upfrontCostJPY, before.upfrontCostJPY);
  assert.deepEqual(game.constructionMarkers[0].location, [139.006, 35.0006]);
  assert.equal(game.constructionMarkers[0].status, "responding");
});

test("ignoring an event is a terminal choice with real delay and reputation penalties", () => {
  const { game, schedule } = fixture();
  const event = game.triggerConstructionEvent(schedule.id, {
    constructionSiteId: "construction-site:tunnel",
    kind: "complaint",
    severity: "moderate",
  });
  const reputation = game.player.reputation;
  const result = game.ignoreConstructionEvent(event.id);
  assert.equal(result.event.status, "ignored");
  assert.equal(result.outcome.ignored, true);
  assert.equal(game.player.reputation, reputation - 8);
  assert.equal(game.constructionMarkers[0].status, "ignored");
  assert.throws(() => game.respondConstructionEvent(event.id, "continue-work"), /already ignored/);
});

test("construction event ids are monotonic and are never reused after save and load", () => {
  const { game, schedule } = fixture();
  const first = game.triggerConstructionEvent(schedule.id, { constructionSiteId: "construction-site:tunnel", kind: "incident", severity: "minor" });
  game.respondConstructionEvent(first.id, "minimum-compliance");
  const restored = ManagementGame.load(game.save());
  const second = restored.triggerConstructionEvent(schedule.id, { constructionSiteId: "construction-site:tunnel", kind: "complaint", severity: "minor" });
  assert.equal(first.id, "construction-event:1");
  assert.equal(second.id, "construction-event:2");
});

test("a failed response transaction rolls back the event, cash and reputation", () => {
  const { game, schedule } = fixture({ cash: 1_000_000 });
  const event = game.triggerConstructionEvent(schedule.id, {
    constructionSiteId: "construction-site:tunnel",
    kind: "unexpected-ground",
    severity: "major",
  });
  const before = game.snapshot();
  assert.throws(() => game.respondConstructionEvent(event.id, "change-method"), /Insufficient cash/);
  assert.deepEqual(game.snapshot(), before);
});

test("new map event marker kinds are accepted while unknown kinds are rejected", () => {
  for (const kind of ["permit-delay", "utility-conflict", "unexpected-ground", "access-blocked"]) {
    const { game } = fixture();
    const marker = game.recordConstructionMarker({ constructionSiteId: "construction-site:tunnel", kind });
    assert.equal(marker.kind, kind);
  }
  const { game } = fixture();
  assert.throws(() => game.recordConstructionMarker({ constructionSiteId: "construction-site:tunnel", kind: "weather" }), /Unknown construction marker kind/);
});

test("an engine marker carries its selected construction candidate into the spatial impact contract", () => {
  const { game, schedule, site } = fixture();
  const event = game.triggerConstructionEvent(schedule.id, {
    constructionSiteId: site.constructionSiteId,
    kind: "incident",
    severity: "minor",
  });
  const marker = game.constructionMarkers[0];
  assert.deepEqual(marker.candidateRef, { kind: "shaft", id: "shaft:east" });
  const result = buildConstructionImpact({
    eventId: marker.eventId,
    eventKind: marker.kind,
    constructionSiteId: marker.constructionSiteId,
    candidateRef: marker.candidateRef,
  }, {
    pack: { manifest: { id: "test", version: "1", data: { license: "CC0-1.0" } } },
    spatial: makeSpatialContext(),
    constructionExport: { sites: [site] },
  });
  assert.equal(result.impact.eventId, event.id);
  assert.deepEqual(result.impact.eventLocation, [139.005, 35.0005]);
  assert.ok(result.impact.linkedCandidateIds.some((candidate) => candidate.id === "shaft:east"));
});
