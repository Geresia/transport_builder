import test from "node:test";
import assert from "node:assert/strict";
import { createThroughService, ManagementGame, reassessThroughService, THROUGH_SERVICE_SCHEMA } from "../src/management/index.mjs";
import { ScenarioRuntime } from "../src/scenario-runtime.mjs";

const handover = (state = "joined", id = "handover:1") => ({
  handoverId: id,
  physicalConnection: state === "joined" ? true : state === "separated" ? false : null,
  connectionState: state,
});
const route = (legs, handovers = legs.slice(1).map((_, index) => handover("joined", `handover:${index + 1}`))) => ({
  schema: "transitline.through-route-geometry/1",
  contractVersion: 1,
  throughRouteId: "through-route:1",
  geometryRevision: "through-route-revision:1",
  legs,
  handovers,
});
const existingLeg = (id, owner = "player", projectId = `project:${id}`) => ({ legId: id, sourceKind: "existing", connectedProjectId: projectId, externalNetworkId: null, externalLineId: null, infrastructureOwnerId: owner });
const externalLeg = (id, owner = "owner:external") => ({ legId: id, sourceKind: "external", connectedProjectId: null, externalNetworkId: "network:external", externalLineId: `line:${id}`, infrastructureOwnerId: owner });
const project = (id, technicalProfileId = "medium_steel", status = "available") => ({ id, technicalProfileId, status });
const catalog = (leg, overrides = {}) => ({ legId: leg.legId, externalNetworkId: leg.externalNetworkId, externalLineId: leg.externalLineId, infrastructureOwnerId: leg.infrastructureOwnerId, technicalProfileId: "medium_steel", status: "available", capacityTrainsPerHour: 20, ...overrides });
const input = (overrides = {}) => ({ throughServiceId: "through-service:1", operatorId: "player", guestModelId: "medium_4car", trainsPerHour: 4, ...overrides });

test("player operation over completed player infrastructure is possible with no access payer/payee", () => {
  const legs = [existingLeg("leg:1"), existingLeg("leg:2")];
  const out = createThroughService(input(), { route: route(legs), projects: legs.map((leg) => project(leg.connectedProjectId)), infrastructureCatalog: legs.map((leg) => catalog(leg)) });
  assert.equal(out.schema, THROUGH_SERVICE_SCHEMA);
  assert.equal(out.assessment.verdict, "possible");
  assert.equal(out.operatorId, "player");
  assert.equal(out.payerOperatorId, null);
  assert.equal(out.payeeOwnerId, null);
  assert.deepEqual(out.trackAccessAgreementIds, []);
  assert.ok(out.legs.every((leg) => leg.compatibility === "compatible" && leg.payerOperatorId === null));
});

test("a competitor guest on player track and a player guest on external track use the same payer/payee structure", () => {
  const ownLegs = [existingLeg("leg:own:1", "player", "project:own"), existingLeg("leg:own:2", "player", "project:own")];
  const competitorAgreement = { id: "agreement:competitor", status: "active", guestOperatorId: "competitor:a", infrastructureOwnerId: "player", hostProjectId: "project:own" };
  const competitor = createThroughService(input({ operatorId: "competitor:a", trackAccessAgreementIds: [competitorAgreement.id] }), {
    route: route(ownLegs),
    projects: ownLegs.map((leg) => project(leg.connectedProjectId)),
    infrastructureCatalog: ownLegs.map((leg) => catalog(leg)),
    trackAccessAgreements: [competitorAgreement],
  });
  assert.equal(competitor.assessment.verdict, "possible");
  assert.equal(competitor.payerOperatorId, "competitor:a");
  assert.equal(competitor.payeeOwnerId, "player");

  const external = [externalLeg("leg:external:1"), externalLeg("leg:external:2")];
  const playerAgreement = { id: "agreement:player", status: "active", guestOperatorId: "player", infrastructureOwnerId: "owner:external", hostProjectId: null };
  const playerGuest = createThroughService(input({ trackAccessAgreementIds: [playerAgreement.id] }), {
    route: route(external),
    infrastructureCatalog: external.map((leg) => catalog(leg)),
    trackAccessAgreements: [playerAgreement],
  });
  assert.equal(playerGuest.assessment.verdict, "possible");
  assert.equal(playerGuest.payerOperatorId, "player");
  assert.equal(playerGuest.payeeOwnerId, "owner:external");
  assert.deepEqual(playerGuest.trackAccessAgreementIds, [playerAgreement.id]);
});

test("a missing access agreement or unverified capacity is conditional, not secretly approved", () => {
  const legs = [externalLeg("leg:1"), externalLeg("leg:2")];
  const noAgreement = createThroughService(input(), { route: route(legs), infrastructureCatalog: legs.map((leg) => catalog(leg)) });
  assert.equal(noAgreement.assessment.verdict, "conditional");
  assert.ok(noAgreement.assessment.conditions.every((reason) => reason.endsWith("track-access-agreement-required")));
  const noCapacity = createThroughService(input({ operatorId: "owner:external" }), { route: route(legs), infrastructureCatalog: legs.map((leg) => catalog(leg, { capacityTrainsPerHour: undefined })) });
  assert.equal(noCapacity.assessment.verdict, "conditional");
  assert.ok(noCapacity.assessment.conditions.every((reason) => reason.endsWith("capacity-verification-required")));
});

test("unknown physical connection remains unknown while separated track is impossible", () => {
  const legs = [existingLeg("leg:1"), existingLeg("leg:2")];
  const context = { projects: legs.map((leg) => project(leg.connectedProjectId)), infrastructureCatalog: legs.map((leg) => catalog(leg)) };
  const unknown = createThroughService(input(), { ...context, route: route(legs, [handover("unknown")]) });
  assert.equal(unknown.assessment.verdict, "unknown");
  assert.deepEqual(unknown.assessment.violations, []);
  assert.ok(unknown.assessment.missingInputs.includes("handover:handover:1:physicalConnection"));
  const separated = createThroughService(input(), { ...context, route: route(legs, [handover("separated")]) });
  assert.equal(separated.assessment.verdict, "impossible");
  assert.ok(separated.assessment.violations.includes("handover:handover:1:physically-separated"));
});

test("planned, unfinished, incompatible and over-capacity legs are impossible for distinct reasons", () => {
  const planned = { ...existingLeg("leg:planned"), sourceKind: "planned", connectedProjectId: null };
  const built = existingLeg("leg:built");
  const plannedOut = createThroughService(input(), { route: route([planned, built]), projects: [project(built.connectedProjectId)], infrastructureCatalog: [catalog(planned), catalog(built)] });
  assert.ok(plannedOut.assessment.violations.includes("leg:leg:planned:infrastructure-not-built"));
  const unfinished = createThroughService(input(), { route: route([built, existingLeg("leg:2")]), projects: [project(built.connectedProjectId, "medium_steel", "underConstruction"), project("project:leg:2")], infrastructureCatalog: [catalog(built), catalog(existingLeg("leg:2"))] });
  assert.ok(unfinished.assessment.violations.includes("leg:leg:built:project-not-available"));
  const mismatch = createThroughService(input({ guestModelId: "agt_3car" }), { route: route([built, existingLeg("leg:2")]), projects: [project(built.connectedProjectId), project("project:leg:2")], infrastructureCatalog: [catalog(built), catalog(existingLeg("leg:2"))] });
  assert.ok(mismatch.assessment.violations.some((reason) => reason.endsWith("running-system-incompatible")));
  const capacity = createThroughService(input({ trainsPerHour: 8 }), { route: route([built, existingLeg("leg:2")]), projects: [project(built.connectedProjectId), project("project:leg:2")], infrastructureCatalog: [catalog(built, { capacityTrainsPerHour: 4 }), catalog(existingLeg("leg:2"))] });
  assert.ok(capacity.assessment.violations.includes("leg:leg:built:capacity-exceeded"));
});

test("through-service legs expose detailed technical failures and preserve missing facts", () => {
  const legs = [externalLeg("leg:detailed:1"), externalLeg("leg:detailed:2")];
  const baseCatalog = legs.map((leg) => catalog(leg));
  const wrongSignal = createThroughService(input(), {
    route: route(legs),
    infrastructureCatalog: baseCatalog.map((entry) => ({ ...entry, technicalSpecification: { signalSystemIds: ["other-atc"] } })),
    trackAccessAgreements: [{ id: "agreement:detail", status: "active", guestOperatorId: "player", infrastructureOwnerId: "owner:external", hostProjectId: null }],
  });
  assert.equal(wrongSignal.assessment.verdict, "impossible");
  assert.equal(wrongSignal.legs[0].technicalCompatibility.verdict, "impossible");
  assert.ok(wrongSignal.assessment.violations.includes("leg:leg:detailed:1:technical:signal-system-not-supported"));

  const unknownSignal = createThroughService(input(), {
    route: route(legs),
    infrastructureCatalog: baseCatalog.map((entry) => ({ ...entry, technicalSpecification: { signalSystemIds: null } })),
    trackAccessAgreements: [{ id: "agreement:detail", status: "active", guestOperatorId: "player", infrastructureOwnerId: "owner:external", hostProjectId: null }],
  });
  assert.equal(unknownSignal.assessment.verdict, "unknown");
  assert.equal(unknownSignal.legs[0].compatibility, "unknown");
  assert.ok(unknownSignal.assessment.missingInputs.includes("leg:leg:detailed:1:technical:signal-system-data-missing"));
});

test("missing owner, profile, project, model or route revision produces unknown", () => {
  const leg = externalLeg("leg:missing", null);
  const withoutRevision = route([leg, { ...leg, legId: "leg:missing:2", externalLineId: "line:2" }]);
  delete withoutRevision.geometryRevision;
  const out = createThroughService(input({ guestModelId: "missing-model" }), { route: withoutRevision, infrastructureCatalog: [] });
  assert.equal(out.assessment.verdict, "unknown");
  assert.ok(out.assessment.missingInputs.includes("route.geometryRevision"));
  assert.ok(out.assessment.missingInputs.includes("guestModelId"));
  assert.ok(out.assessment.missingInputs.some((reason) => reason.endsWith("infrastructureOwnerId")));
  assert.ok(out.assessment.missingInputs.some((reason) => reason.endsWith("technicalProfileId")));
});

test("stale, missing or role-mismatched agreement ids make the service impossible", () => {
  const legs = [externalLeg("leg:1"), externalLeg("leg:2")];
  const wrong = { id: "agreement:wrong", status: "active", guestOperatorId: "other", infrastructureOwnerId: "owner:external", hostProjectId: null };
  const out = createThroughService(input({ trackAccessAgreementIds: [wrong.id, "agreement:missing"] }), { route: route(legs), infrastructureCatalog: legs.map((leg) => catalog(leg)), trackAccessAgreements: [wrong] });
  assert.equal(out.assessment.verdict, "impossible");
  assert.ok(out.assessment.violations.includes("trackAccessAgreement:agreement:missing:not-found"));
  assert.ok(out.assessment.violations.includes("trackAccessAgreement:agreement:wrong:role-or-route-mismatch"));
});

test("reassessment detects a changed geometry revision without mutating either input", () => {
  const legs = [existingLeg("leg:1"), existingLeg("leg:2")];
  const context = { route: route(legs), projects: legs.map((leg) => project(leg.connectedProjectId)), infrastructureCatalog: legs.map((leg) => catalog(leg)) };
  const service = createThroughService(input(), context);
  const frozenService = structuredClone(service);
  const revisedRoute = structuredClone(context.route);
  revisedRoute.geometryRevision = "through-route-revision:2";
  const reassessed = reassessThroughService(service, { ...context, route: revisedRoute });
  assert.equal(reassessed.routeGeometryRevision, "through-route-revision:2");
  assert.deepEqual(service, frozenService);
  assert.equal(context.route.geometryRevision, "through-route-revision:1");
});

test("the contract is deterministic and contains no money, fee, score or mutable external state", () => {
  const legs = [existingLeg("leg:1"), existingLeg("leg:2")];
  const context = { route: route(legs), projects: legs.map((leg) => project(leg.connectedProjectId)), infrastructureCatalog: legs.map((leg) => catalog(leg)) };
  const first = createThroughService(input(), context);
  const second = createThroughService(structuredClone(input()), structuredClone(context));
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.deepEqual(Object.keys(first), ["schema", "contractVersion", "throughServiceId", "throughRouteId", "routeGeometryRevision", "status", "guestModelId", "trainsPerHour", "operatorId", "payerOperatorId", "payeeOwnerId", "legs", "handoverIds", "trackAccessAgreementIds", "assessment"]);
  const keys = [];
  const visit = (value) => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") for (const [key, child] of Object.entries(value)) { keys.push(key); visit(child); }
  };
  visit(first);
  assert.ok(keys.every((key) => !/cost|cash|fee|score|revenue|payment/i.test(key)), keys.join(","));
});

test("invalid schemas, ids and lifecycle states are rejected at the boundary", () => {
  assert.throws(() => createThroughService(input(), { route: { schema: "wrong", contractVersion: 1 } }), /ThroughRouteGeometry/);
  assert.throws(() => createThroughService({ ...input(), throughServiceId: "" }, { route: route([existingLeg("a"), existingLeg("b")]) }), /throughServiceId/);
  assert.throws(() => createThroughService(input({ status: "running" }), { route: route([existingLeg("a"), existingLeg("b")]) }), /Invalid through service status/);
});

test("ManagementGame creates, approves and save-loads a through service without consuming RNG", () => {
  const game = new ManagementGame({ seed: 211 });
  const legs = [existingLeg("leg:1"), existingLeg("leg:2")];
  game.projects.push(...legs.map((leg) => project(leg.connectedProjectId)));
  const rngBefore = game.rng.snapshot();
  const created = game.createThroughService(route(legs), { operatorId: "player", guestModelId: "medium_4car", trainsPerHour: 4 }, legs.map((leg) => catalog(leg)));
  assert.equal(created.throughServiceId, "through-service:1");
  assert.equal(created.status, "assessed");
  assert.equal(created.assessment.verdict, "possible");
  assert.equal(game.rng.snapshot(), rngBefore, "assessment is deterministic and consumes no game randomness");
  const approved = game.approveThroughService(created.throughServiceId);
  assert.equal(approved.status, "approved");
  const restored = ManagementGame.load(game.save());
  assert.deepEqual(restored.throughServiceReport(), game.throughServiceReport());
  assert.equal(restored.nextThroughServiceSequence, 2);
  const second = restored.createThroughService(route(legs), { operatorId: "player", guestModelId: "medium_4car", trainsPerHour: 2 }, legs.map((leg) => catalog(leg)));
  assert.equal(second.throughServiceId, "through-service:2");
});

test("old snapshots load an empty through-service collection without changing the save schema", () => {
  const original = new ManagementGame({ seed: 223 });
  const oldSnapshot = original.snapshot();
  delete oldSnapshot.throughServices;
  delete oldSnapshot.nextThroughServiceSequence;
  const restored = new ManagementGame().restore(oldSnapshot);
  assert.deepEqual(restored.throughServiceReport(), []);
  assert.equal(restored.nextThroughServiceSequence, 1);
  const encoded = JSON.parse(original.save());
  const roundTrip = JSON.parse(new ManagementGame().restore(oldSnapshot).save());
  assert.equal(roundTrip.schemaVersion, encoded.schemaVersion);
});

test("custom numeric ids advance the monotonic allocator and are never reused", () => {
  const game = new ManagementGame({ seed: 225 });
  const legs = [existingLeg("leg:1"), existingLeg("leg:2")];
  game.projects.push(...legs.map((leg) => project(leg.connectedProjectId)));
  const context = legs.map((leg) => catalog(leg));
  game.createThroughService(route(legs), input({ throughServiceId: "through-service:7" }), context);
  assert.equal(game.nextThroughServiceSequence, 8);
  assert.equal(game.createThroughService(route(legs), { operatorId: "player", guestModelId: "medium_4car", trainsPerHour: 3 }, context).throughServiceId, "through-service:8");
});

test("failed game creation and approval roll back collection, sequence, events and RNG", () => {
  const game = new ManagementGame({ seed: 227 });
  const before = game.snapshot();
  assert.throws(() => game.createThroughService({ schema: "wrong" }, input()), /ThroughRouteGeometry/);
  assert.deepEqual(game.snapshot(), before);
  const legs = [externalLeg("leg:1"), externalLeg("leg:2")];
  const conditional = game.createThroughService(route(legs), input(), legs.map((leg) => catalog(leg)));
  const afterCreate = game.snapshot();
  assert.equal(conditional.assessment.verdict, "conditional");
  assert.throws(() => game.approveThroughService(conditional.throughServiceId), /assessment is conditional/);
  assert.deepEqual(game.snapshot(), afterCreate);
});

test("game reassessment preserves identity, detects revisions and revokes stale approval", () => {
  const game = new ManagementGame({ seed: 229 });
  const legs = [existingLeg("leg:1"), existingLeg("leg:2")];
  game.projects.push(...legs.map((leg) => project(leg.connectedProjectId)));
  const catalogEntries = legs.map((leg) => catalog(leg));
  const originalRoute = route(legs);
  const created = game.createThroughService(originalRoute, input(), catalogEntries);
  game.approveThroughService(created.throughServiceId);
  const revisedRoute = structuredClone(originalRoute);
  revisedRoute.geometryRevision = "through-route-revision:changed";
  revisedRoute.handovers[0] = handover("separated");
  const revised = game.reassessThroughService(created.throughServiceId, revisedRoute, catalogEntries);
  assert.equal(revised.throughServiceId, created.throughServiceId);
  assert.equal(revised.routeGeometryRevision, "through-route-revision:changed");
  assert.equal(revised.status, "assessed");
  assert.equal(revised.assessment.verdict, "impossible");
  assert.throws(() => game.reassessThroughService(created.throughServiceId, { ...revisedRoute, throughRouteId: "other" }, catalogEntries), /identity does not match/);
});

function linkedGameFixture() {
  const game = new ManagementGame({ seed: 233 });
  const operatorId = game.competitors[0].id;
  const legs = [existingLeg("leg:host:1", "player", "project:host"), existingLeg("leg:host:2", "player", "project:host")];
  game.projects.push(project("project:host"));
  const agreement = {
    schema: "transitline.track-access-agreement/1",
    contractVersion: 1,
    id: "agreement:linked",
    hostServiceId: "service:host",
    hostProjectId: "project:host",
    infrastructureOwnerId: "player",
    guestOperatorId: operatorId,
    trainsPerHour: 4,
    dailyTrainKm: 640,
    dailyStationStops: 120,
    accessFeeJPYPerTrainKm: 1_000,
    stationFeeJPYPerStop: 10_000,
    hostCapacityTrainsPerHour: 20,
    startDay: 0,
    endDay: 365,
    lastSettledDay: -1,
    status: "active",
    totals: { settledDays: 0, accessRevenueJPY: 0 },
  };
  game.trackAccessAgreements.push(agreement);
  game.competitors[0].accessCommitments = 1;
  const service = game.createThroughService(route(legs), {
    operatorId,
    guestModelId: "medium_4car",
    trainsPerHour: 4,
    trackAccessAgreementIds: [agreement.id],
  }, legs.map((leg) => catalog(leg)));
  game.approveThroughService(service.throughServiceId);
  return { game, serviceId: service.throughServiceId, agreement, operatorId };
}

test("through-service suspension, resume and termination update one linked B11 agreement exactly once", () => {
  const { game, serviceId, agreement, operatorId } = linkedGameFixture();
  const agreementId = agreement.id;
  const currentAgreement = () => game.trackAccessAgreements.find((entry) => entry.id === agreementId);
  const currentCompany = () => game.competitors.find((entry) => entry.id === operatorId);
  const ledgerBefore = structuredClone(game.ledger.entries);
  const fixedTrainKm = agreement.dailyTrainKm;
  const fixedFrequency = agreement.trainsPerHour;
  const suspended = game.setThroughServiceStatus(serviceId, "suspended");
  assert.equal(suspended.status, "suspended");
  assert.equal(currentAgreement().status, "suspended");
  assert.equal(currentCompany().accessCommitments, 1, "suspension keeps the reserved commitment");
  assert.equal(currentAgreement().dailyTrainKm, fixedTrainKm);
  assert.equal(currentAgreement().trainsPerHour, fixedFrequency);
  const afterSuspend = game.snapshot();
  assert.throws(() => game.setThroughServiceStatus(serviceId, "suspended"), /cannot change/);
  assert.deepEqual(game.snapshot(), afterSuspend, "repeated suspension has no second effect");
  assert.equal(game.setThroughServiceStatus(serviceId, "approved").status, "approved");
  assert.equal(currentAgreement().status, "active");
  assert.equal(currentCompany().accessCommitments, 1, "resume does not reserve capacity twice");
  assert.equal(game.setThroughServiceStatus(serviceId, "terminated").status, "terminated");
  assert.equal(currentAgreement().status, "terminated");
  assert.equal(currentCompany().accessCommitments, 0, "termination releases the commitment once");
  const afterTerminate = game.snapshot();
  assert.throws(() => game.setThroughServiceStatus(serviceId, "terminated"), /cannot change/);
  assert.deepEqual(game.snapshot(), afterTerminate);
  assert.deepEqual(game.ledger.entries, ledgerBefore, "ID/status linkage posts no duplicate money");
});

test("a B11 agreement status change propagates to its linked through service", () => {
  const { game, serviceId, agreement } = linkedGameFixture();
  game.setTrackAccessAgreementStatus(agreement.id, "suspended");
  assert.equal(game.requireThroughService(serviceId).status, "suspended");
  game.setTrackAccessAgreementStatus(agreement.id, "active");
  assert.equal(game.requireThroughService(serviceId).status, "approved");
  game.setTrackAccessAgreementStatus(agreement.id, "terminated");
  const terminated = game.requireThroughService(serviceId);
  assert.equal(terminated.status, "terminated");
  assert.equal(terminated.terminatedByTrackAccessAgreementId, agreement.id);
});

test("ScenarioRuntime delegates the through-service lifecycle and reports a read-only copy", () => {
  const game = new ManagementGame({ seed: 239 });
  const runtime = Object.assign(Object.create(ScenarioRuntime.prototype), { game });
  const legs = [existingLeg("leg:runtime:1", "player", "project:runtime"), existingLeg("leg:runtime:2", "player", "project:runtime")];
  game.projects.push(project("project:runtime"));
  const geometry = route(legs);
  const infrastructure = legs.map((leg) => catalog(leg));

  const created = runtime.createThroughService(geometry, {
    operatorId: "player",
    guestModelId: "medium_4car",
    trainsPerHour: 4,
  }, infrastructure);
  assert.equal(runtime.approveThroughService(created.throughServiceId).status, "approved");
  assert.equal(runtime.setThroughServiceStatus(created.throughServiceId, "suspended").status, "suspended");
  assert.equal(runtime.setThroughServiceStatus(created.throughServiceId, "approved").status, "approved");

  const directReport = runtime.throughServiceReport(created.throughServiceId);
  const aggregateReport = runtime.report().throughServices;
  assert.deepEqual(aggregateReport, directReport);
  directReport[0].status = "tampered";
  aggregateReport[0].assessment.verdict = "tampered";
  assert.equal(game.requireThroughService(created.throughServiceId).status, "approved");
  assert.equal(game.requireThroughService(created.throughServiceId).assessment.verdict, "possible");

  const revisedGeometry = { ...geometry, geometryRevision: "through-route-revision:2" };
  assert.equal(runtime.reassessThroughService(created.throughServiceId, revisedGeometry, infrastructure).routeGeometryRevision, "through-route-revision:2");
});
