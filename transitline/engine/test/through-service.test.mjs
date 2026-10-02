import test from "node:test";
import assert from "node:assert/strict";
import { createThroughService, reassessThroughService, THROUGH_SERVICE_SCHEMA } from "../src/management/index.mjs";

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
