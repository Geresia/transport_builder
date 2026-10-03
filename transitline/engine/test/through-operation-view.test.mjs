import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  HANDOVER_STYLES,
  LEG_STYLES,
  THROUGH_OPERATION_MAP_VIEW_SCHEMA,
  buildThroughOperationView,
  drawThroughOperationOverlay,
  renderThroughOperationLegend,
  renderThroughOperationPanel,
} from "../src/map/through-operation-view.mjs";
import { keyedThroughRouteId } from "../src/map/through-route.mjs";
import {
  acceptThroughFareAgreement,
  activateThroughFareAgreement,
  calculateThroughOperatingSettlement,
  createThroughFareAgreement,
  fileThroughFareAgreement,
} from "../src/management/index.mjs";

// --- fixtures: a three-leg route (a drawn leg, an external leg with no alignment, a drawn leg) ---
const ROUTE_ID = "through-route:t";
const REV = "through-route-revision:t";
const A = [139, 35];
const B = [139.01, 35];
const C = [139.02, 35];
const D = [139.03, 35];
const unknownReason = { physicalConnection: "external-topology-not-in-source" };
const baseRoute = () => ({
  schema: "transitline.through-route-geometry/1", contractVersion: 1, throughRouteId: ROUTE_ID, geometryRevision: REV, name: "A to D", sourcePackId: "t",
  legs: [
    { legId: "leg:1", sequence: 0, sourceKind: "existing", connectedPlanId: "plan:1", connectedProjectId: "project:1", externalNetworkId: null, externalLineId: null, infrastructureOwnerId: null, stationIds: ["s1", "s2"], alignment: [A, B], lengthMeters: 911.8, unknown: ["infrastructureOwnerId"], unknownReasons: { infrastructureOwnerId: "owner-not-in-source-data" } },
    { legId: "leg:2", sequence: 1, sourceKind: "external", connectedPlanId: null, connectedProjectId: null, externalNetworkId: "external:t", externalLineId: "ext-line:1", infrastructureOwnerId: null, stationIds: ["d1", "d2"], alignment: null, lengthMeters: null, unknown: ["alignment"], unknownReasons: { alignment: "external-location-basis:demand-node" } },
    { legId: "leg:3", sequence: 2, sourceKind: "existing", connectedPlanId: "plan:2", connectedProjectId: "project:2", externalNetworkId: null, externalLineId: null, infrastructureOwnerId: null, stationIds: ["s3", "s4"], alignment: [C, D], lengthMeters: 911.8, unknown: [], unknownReasons: {} },
  ],
  handovers: [
    { handoverId: "handover:1", sequence: 0, stationId: null, location: null, fromLegId: "leg:1", toLegId: "leg:2", physicalConnection: null, connectionState: "unknown", gapMeters: null, unknown: ["physicalConnection"], unknownReasons: unknownReason },
    { handoverId: "handover:2", sequence: 1, stationId: null, location: null, fromLegId: "leg:2", toLegId: "leg:3", physicalConnection: null, connectionState: "unknown", gapMeters: null, unknown: ["physicalConnection"], unknownReasons: unknownReason },
  ],
});
// a two-leg fully drawn route whose boundary is joined (true) / separated (false) / unknown (null)
const drawnRoute = (physicalConnection) => ({
  ...baseRoute(),
  legs: [baseRoute().legs[0], { ...baseRoute().legs[2], legId: "leg:2", sequence: 1, alignment: physicalConnection === true ? [B, C] : [C, D] }],
  handovers: [{ handoverId: "handover:1", sequence: 0, stationId: physicalConnection === true ? "s2" : null, location: physicalConnection === true ? B : null, fromLegId: "leg:1", toLegId: "leg:2", physicalConnection, gapMeters: physicalConnection === true ? 0 : physicalConnection === false ? 1823.6 : 36.4, unknown: physicalConnection === null ? ["physicalConnection"] : [], unknownReasons: physicalConnection === null ? { physicalConnection: "endpoints-near-not-joined" } : {} }],
});
const serviceLeg = (legId, extra = {}) => ({ legId, sourceKind: "existing", infrastructureOwnerId: "player", operatorId: "player", compatibility: "compatible", technicalCompatibility: { verdict: "possible" }, infrastructureStatus: "available", capacityTrainsPerHour: 12, trackAccessAgreementId: null, ...extra });
const baseService = (route, extra = {}) => ({
  schema: "transitline.through-service/1", contractVersion: 1, throughServiceId: "through-service:t", throughRouteId: route.throughRouteId, routeGeometryRevision: route.geometryRevision,
  status: "approved", guestModelId: "medium_4car", trainsPerHour: 4, operatorId: "player", legs: route.legs.map((l) => serviceLeg(l.legId, { sourceKind: l.sourceKind })),
  handoverIds: route.handovers.map((h) => h.handoverId), trackAccessAgreementIds: [], approvedRetrofitProgramIds: [],
  assessment: { verdict: "possible", violations: [], conditions: [], missingInputs: [] }, ...extra,
});
const settlement = (day, extra = {}) => ({ schema: "transitline.through-operating-settlement/1", contractVersion: 1, settlementId: `through-operation:through-service:t:${day}`, throughServiceId: "through-service:t", settledAtMinute: day * 1440, operatingDay: day, passengers: 1000 + day, trainKm: 500 + day, carKm: 2000, trackAccessUsage: [], ...extra });
const view = (input = {}) => {
  const route = input.route ?? drawnRoute(true);
  return buildThroughOperationView({ ...input, route, service: input.service ?? baseService(route) });
};
const keysDeep = (value, found = new Set()) => {
  if (Array.isArray(value)) value.forEach((v) => keysDeep(v, found));
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) { found.add(k); keysDeep(v, found); }
  return found;
};
const FORBIDDEN = /cost|cash|revenue|profit|fare|fee|price|payment|jpy|money|income|score/i;
const deepFreeze = (o) => { if (o && typeof o === "object") { Object.values(o).forEach(deepFreeze); Object.freeze(o); } return o; };
const fakeBox = () => { const doc = { createElement: (tag) => ({ tag, children: [], style: {}, className: "", textContent: "", hidden: false, ownerDocument: doc, append(...c) { this.children.push(...c); }, replaceChildren(...c) { this.children = c; } }) }; return doc.createElement("div"); };
const texts = (box) => box.children.flatMap((c) => [c.textContent, ...c.children.map((x) => x.textContent)]);
// records every canvas call as [name, ...args]; property assignments are recorded as `set:<name>`
const fakeCtx = () => {
  const calls = [];
  const target = new Proxy({}, {
    get: (_t, name) => (name === "calls" ? calls : (...args) => { calls.push([String(name), ...args]); }),
    set: (_t, name, value) => { calls.push([`set:${String(name)}`, value]); return true; },
  });
  return target;
};
const screen = ([lon, lat]) => [(lon - 139) * 1000, (35 - lat) * 1000];
const train = (extra = {}) => ({ trainRunId: "run:1", throughServiceId: "through-service:t", legId: "leg:1", progress: null, location: null, direction: null, delayMinutes: 0, ...extra });

// --- identity and purity ---
test("the same input gives byte-identical output, and the inputs are not changed", () => {
  const route = drawnRoute(true);
  const service = baseService(route, { throughOperatingTotals: { days: 2, passengers: 5, trainKm: 7, fareRevenueJPY: 9 }, lastThroughOperatingDay: 4 });
  const input = { route, service, settlements: [settlement(3), settlement(4)], liveActuals: { operatingDay: 5, serviceMinute: 60, trains: [train({ progress: 0.5, direction: "forward", delayMinutes: 1 })] } };
  const before = structuredClone(input);
  const one = buildThroughOperationView(input);
  assert.deepEqual(input, before, "the inputs are deepEqual after building");
  assert.equal(JSON.stringify(one), JSON.stringify(buildThroughOperationView(structuredClone(input))));
  assert.equal(JSON.stringify(buildThroughOperationView(deepFreeze(structuredClone(input)))), JSON.stringify(one), "frozen inputs build too");
  one.legs[0].alignment[0][0] = 999;
  one.legs[0].issues.push("x");
  assert.deepEqual(input, before, "the output does not alias the input");
  assert.equal(one.schema, THROUGH_OPERATION_MAP_VIEW_SCHEMA);
});

test("the map module imports no management code, touches no storage, files or network, and builds no HTML", () => {
  const source = fs.readFileSync(new URL("../src/map/through-operation-view.mjs", import.meta.url), "utf8");
  assert.ok(!/from\s+["'][^"']*management/.test(source), "no management import");
  for (const banned of ["node:fs", "localStorage", "sessionStorage", "indexedDB", "fetch(", "XMLHttpRequest", "innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "new Function"]) assert.ok(!source.includes(banned), `no ${banned}`);
  assert.ok(!/\b(calculate|settle|approve|suspend|terminate)\w*\s*\(/.test(source), "calls no settlement or lifecycle function");
});

test("the view has no cost, cash, revenue, fare, profit or money fields, even when the settlement carries money", () => {
  const route = drawnRoute(true);
  const moneySettlement = settlement(4, { playerFareRevenueJPY: 1, passengerRevenueJPY: 2, fareAllocations: [{ operatorId: "player", netRevenueJPY: 3 }], money: { operatingCostJPY: 4, operatingProfitJPY: 5, trackAccessCostJPY: 6 }, trackAccessUsage: [{ agreementId: "access:1", infrastructureOwnerId: "owner", trainKm: 10, stationStops: 2, accessCostJPY: 7 }] });
  const out = view({ route, settlements: [moneySettlement], service: baseService(route, { throughOperatingTotals: { days: 1, passengers: 2, trainKm: 3, fareRevenueJPY: 4, operatingCostJPY: 5, operatingProfitJPY: 6 }, lastThroughOperatingDay: 4 }) });
  for (const key of keysDeep(out)) assert.ok(!FORBIDDEN.test(key), `unexpected money field ${key}`);
  assert.ok(!JSON.stringify(out).includes("accessCost"));
  assert.deepEqual(Object.keys(out.latestSettlement).sort(), ["carKm", "operatingDay", "passengers", "settledAtMinute", "settlementId", "trackAccessUsage", "trainKm"]);
  assert.deepEqual(out.operatingTotals, { days: 1, passengers: 2, trainKm: 3, lastOperatingDay: 4 });
});

// --- accepting / rejecting what it is given ---
test("a service of another route is rejected, a changed route revision only warns", () => {
  const route = drawnRoute(true);
  assert.throws(() => view({ route, service: baseService(route, { throughRouteId: "through-route:other" }) }), (e) => e.code === "route-service-mismatch");
  assert.throws(() => buildThroughOperationView({ route: { ...route, schema: "x" }, service: baseService(route) }), (e) => e.code === "route-invalid");
  assert.throws(() => buildThroughOperationView({ route, service: { ...baseService(route), schema: "x" } }), (e) => e.code === "service-invalid");
  assert.throws(() => buildThroughOperationView({}), (e) => e.code === "route-invalid");
  const stale = view({ route, service: baseService(route, { routeGeometryRevision: "through-route-revision:older" }) });
  assert.equal(stale.stale, true);
  assert.deepEqual(stale.warnings.find((w) => w.code === "route-revision-mismatch"), { code: "route-revision-mismatch", serviceRevision: "through-route-revision:older", routeRevision: REV });
  assert.equal(stale.routeGeometryRevision, REV);
  assert.equal(stale.serviceRouteGeometryRevision, "through-route-revision:older");
  assert.equal(view({ route }).stale, false);
  const noRevision = view({ route, service: baseService(route, { routeGeometryRevision: null }) });
  assert.equal(noRevision.stale, false, "an unknown revision is not a mismatch");
  assert.equal(noRevision.unknownReasons.serviceRouteGeometryRevision, "service-has-no-route-geometry-revision");
});

test("legs are joined by legId only: a leg the service does not know, or the route does not have, is reported", () => {
  const route = drawnRoute(true);
  const service = baseService(route, { legs: [serviceLeg("leg:2", { operatorId: "other" }), serviceLeg("leg:ghost")] });
  const out = view({ route, service });
  assert.deepEqual(out.warnings.map((w) => w.code).sort(), ["route-leg-not-in-service", "service-leg-not-on-route"]);
  const [first, second] = out.legs;
  assert.equal(first.legId, "leg:1");
  assert.equal(first.compatibility, null, "no service entry for leg:1: unknown, not 'compatible'");
  assert.equal(first.unknownReasons.compatibility, "leg-not-in-service");
  assert.equal(second.operatorId, "other", "the second leg takes its own service entry, not the array position");
  const reordered = view({ route, service: baseService(route, { legs: [...baseService(route).legs].reverse() }) });
  assert.equal(JSON.stringify(reordered.legs), JSON.stringify(view({ route }).legs), "the order of the service's legs does not matter");
});

test("settlements: none is fine, the latest operating day wins, and settlements of another service are dropped with a warning", () => {
  const route = drawnRoute(true);
  const none = view({ route });
  assert.equal(none.latestSettlement, null, "no settlement is null, not 0 or {}");
  assert.equal(none.unknownReasons.latestSettlement, "no-settlement-for-service");
  assert.ok(none.unknown.includes("latestSettlement"));
  assert.equal(view({ route, settlements: [] }).latestSettlement, null);
  const many = view({ route, settlements: [settlement(5), settlement(9), settlement(7), settlement(8)] });
  assert.equal(many.latestSettlement.operatingDay, 9);
  assert.equal(many.latestSettlement.passengers, 1009);
  assert.equal(JSON.stringify(view({ route, settlements: [settlement(9), settlement(7), settlement(5), settlement(8)] }).latestSettlement), JSON.stringify(many.latestSettlement), "input order does not matter");
  const mixed = view({ route, settlements: [settlement(3), { ...settlement(99), throughServiceId: "through-service:other" }, { ...settlement(98), schema: "nope" }, { ...settlement(97), operatingDay: -1 }, { ...settlement(96), operatingDay: 1.5 }] });
  assert.equal(mixed.latestSettlement.operatingDay, 3, "settlements of another service or malformed ones are never the latest");
  assert.deepEqual(mixed.warnings.map((w) => w.code), ["settlement-invalid", "settlement-invalid", "settlement-invalid", "settlement-other-service"]);
  const same = view({ route, settlements: [settlement(4, { settledAtMinute: 10, passengers: 1 }), settlement(4, { settledAtMinute: 20, passengers: 2, settlementId: "through-operation:through-service:t:4b" })] });
  assert.equal(same.latestSettlement.passengers, 2);
  assert.ok(same.warnings.some((w) => w.code === "settlement-duplicate-day"));
});

test("settlement numbers are copied as stated: null stays null, never 0", () => {
  const route = drawnRoute(true);
  const out = view({ route, settlements: [settlement(4, { passengers: undefined, trainKm: null, carKm: "x", settledAtMinute: undefined })] });
  assert.equal(out.latestSettlement.passengers, null);
  assert.equal(out.latestSettlement.trainKm, null);
  assert.equal(out.latestSettlement.carKm, null);
  assert.equal(out.latestSettlement.settledAtMinute, null);
  const withUsage = view({ route, settlements: [settlement(4, { trackAccessUsage: [{ agreementId: "access:b", trainKm: 2, stationStops: 1 }, { agreementId: "access:a", trainKm: null, stationStops: 3 }, { trainKm: 1 }] })] });
  assert.deepEqual(withUsage.latestSettlement.trackAccessUsage.map((u) => [u.agreementId, u.trainKm, u.stationStops]), [["access:a", null, 3], ["access:b", 2, 1]]);
  assert.equal(view({ route }).operatingTotals, null, "no totals on the service: null, not zeros");
});

// --- handovers: unknown is not separated ---
test("an unknown physical connection and a separated one look different, and neither is turned into the other", () => {
  const unknown = view({ route: drawnRoute(null) }).handovers[0];
  const separated = view({ route: drawnRoute(false) }).handovers[0];
  const joined = view({ route: drawnRoute(true) }).handovers[0];
  assert.equal(unknown.physicalConnection, null);
  assert.equal(unknown.connectionState, "unknown");
  assert.equal(unknown.style.key, "unknown");
  assert.equal(unknown.unknownReasons.physicalConnection, "endpoints-near-not-joined");
  assert.ok(unknown.unknown.includes("physicalConnection"));
  assert.equal(separated.physicalConnection, false);
  assert.equal(separated.connectionState, "separated");
  assert.equal(separated.style.key, "separated");
  assert.ok(!separated.unknown.includes("physicalConnection"), "false is a fact, not unknown");
  assert.equal(joined.connectionState, "joined");
  assert.notEqual(unknown.style.color, separated.style.color);
  assert.notEqual(unknown.style.glyph, separated.style.glyph);
  assert.equal(new Set(Object.values(HANDOVER_STYLES).map((s) => s.color)).size, 3);
  const missing = baseRoute();
  delete missing.handovers[0].physicalConnection;
  assert.equal(buildThroughOperationView({ route: missing, service: baseService(missing) }).handovers[0].connectionState, "unknown", "a route that says nothing is unknown, not separated");
  assert.equal(unknown.gapMeters, 36.4);
  assert.equal(separated.gapMeters, 1823.6);
});

test("a handover is drawn only where the route says or where a leg's own alignment ends; an external leg is not bridged", () => {
  const out = buildThroughOperationView({ route: baseRoute(), service: baseService(baseRoute()) });
  const [first, second] = out.handovers;
  assert.deepEqual(first.at, B, "leg:1 ends at B");
  assert.equal(first.atBasis, "from-leg-end");
  assert.deepEqual(first.fromEnd, B);
  assert.equal(first.toStart, null, "the external leg has no start point to join to");
  assert.deepEqual(second.at, C, "leg:3 starts at C");
  assert.equal(second.atBasis, "to-leg-start");
  assert.equal(second.fromEnd, null);
  const noAnywhere = baseRoute();
  noAnywhere.legs[0].alignment = null;
  noAnywhere.legs[2].alignment = null;
  const none = buildThroughOperationView({ route: noAnywhere, service: baseService(noAnywhere) });
  assert.equal(none.handovers[0].at, null);
  assert.equal(none.handovers[0].unknownReasons.at, "no-location-and-no-adjacent-alignment");
  assert.ok(none.warnings.some((w) => w.code === "handover-position-unknown"));
  const located = baseRoute();
  located.handovers[0].location = [139.005, 35.001];
  assert.equal(buildThroughOperationView({ route: located, service: baseService(located) }).handovers[0].atBasis, "handover-location");
});

// --- legs: alignment, owners, operators, styles ---
test("an external leg keeps alignment null, is not drawn, and says why", () => {
  const out = buildThroughOperationView({ route: baseRoute(), service: baseService(baseRoute()) });
  const external = out.legs[1];
  assert.equal(external.alignment, null);
  assert.equal(external.display, "none");
  assert.equal(external.style.key, "no-alignment");
  assert.equal(external.style.width, 0);
  assert.ok(external.unknown.includes("alignment"));
  assert.equal(external.unknownReasons.alignment, "external-location-basis:demand-node");
  assert.deepEqual(out.warnings.find((w) => w.code === "leg-not-drawable"), { code: "leg-not-drawable", legId: "leg:2", reason: "external-location-basis:demand-node" });
  assert.equal(out.legs[0].display, "line");
  assert.deepEqual(out.legs[0].alignment, [A, B]);
  const ctx = fakeCtx();
  drawThroughOperationOverlay(ctx, out, screen);
  // two drawn legs: a casing stroke and a line stroke each. The external leg adds no stroke and no line to anywhere.
  const legStrokes = ctx.calls.filter(([n]) => n === "stroke").length;
  const handoverStrokes = out.handovers.length; // each joined/unknown marker outlines its dot once
  assert.equal(legStrokes, 2 * 2 + handoverStrokes);
  // Every line segment starts at a drawn leg's start and ends at its end: leg:1 is A->B and leg:3 is C->D, and nothing
  // runs B->C across the external leg between them.
  const starts = ctx.calls.filter(([n]) => n === "moveTo").map(([, x, y]) => `${x},${y}`);
  const ends = ctx.calls.filter(([n]) => n === "lineTo").map(([, x, y]) => `${x},${y}`);
  assert.deepEqual([...new Set(starts)].sort(), [screen(A).join(","), screen(C).join(",")].sort());
  assert.deepEqual([...new Set(ends)].sort(), [screen(B).join(","), screen(D).join(",")].sort());
});

test("owner and operator combinations each get their own style", () => {
  const route = drawnRoute(true);
  const style = (owner, operator) => view({ route, service: baseService(route, { legs: [serviceLeg("leg:1", { infrastructureOwnerId: owner, operatorId: operator }), serviceLeg("leg:2")] }) }).legs[0];
  assert.equal(style("player", "player").style.key, "player-owned-player-operated");
  assert.equal(style("operator:x", "player").style.key, "external-owned-player-operated");
  assert.equal(style("player", "operator:x").style.key, "player-owned-external-operated");
  assert.equal(style("operator:x", "operator:y").style.key, "external-owned-external-operated");
  assert.equal(style("operator:x", "player").role, "external-owned-player-operated");
  assert.equal(style(null, "player").style.key, "unknown", "an unknown owner cannot be classed");
  assert.equal(style(null, "player").unknownReasons.infrastructureOwnerId, "owner-not-stated");
  assert.equal(style("player", "player").infrastructureOwnerId, "player");
  const colors = ["player-owned-player-operated", "external-owned-player-operated", "player-owned-external-operated", "external-owned-external-operated"].map((k) => LEG_STYLES[k].color);
  assert.equal(new Set(colors).size, 4);
  assert.equal(view({ route, playerOperatorId: "me", service: baseService(route, { legs: [serviceLeg("leg:1", { infrastructureOwnerId: "me", operatorId: "me" }), serviceLeg("leg:2")] }) }).legs[0].style.key, "player-owned-player-operated");
});

test("a leg shows its track access agreement and, if reported, its agreement usage", () => {
  const route = drawnRoute(true);
  const service = baseService(route, { legs: [serviceLeg("leg:1"), serviceLeg("leg:2", { infrastructureOwnerId: "operator:x", trackAccessAgreementId: "access:1", capacityTrainsPerHour: 8 })], trackAccessAgreementIds: ["access:1"] });
  const out = view({ route, service, settlements: [settlement(6, { trackAccessUsage: [{ agreementId: "access:1", infrastructureOwnerId: "operator:x", trainKm: 120, stationStops: 4 }] })] });
  assert.equal(out.legs[1].trackAccessAgreementId, "access:1");
  assert.deepEqual(out.legs[1].agreementUsage, { trainKm: 120, stationStops: 4 });
  assert.equal(out.legs[1].capacityTrainsPerHour, 8);
  assert.equal(out.legs[0].trackAccessAgreementId, null);
  assert.equal(out.legs[0].agreementUsage, null);
});

test("service status approved, suspended and terminated are shown, and suspended and terminated override the leg colours", () => {
  const route = drawnRoute(true);
  const withStatus = (status) => view({ route, service: baseService(route, { status }) });
  assert.equal(withStatus("approved").statusLabel, "승인");
  assert.equal(withStatus("approved").legs[0].style.key, "player-owned-player-operated");
  const suspended = withStatus("suspended");
  assert.equal(suspended.status, "suspended");
  assert.equal(suspended.statusLabel, "운행 중단");
  assert.deepEqual(suspended.legs.map((l) => l.style.key), ["suspended", "suspended"]);
  const terminated = withStatus("terminated");
  assert.equal(terminated.statusLabel, "종료");
  assert.deepEqual(terminated.legs.map((l) => l.style.key), ["terminated", "terminated"]);
  assert.equal(withStatus("assessed").statusLabel, "판정됨");
  assert.equal(withStatus("draft").statusLabel, "초안");
  const none = view({ route, service: baseService(route, { status: undefined }) });
  assert.equal(none.status, null);
  assert.equal(none.statusLabel, null);
  assert.equal(none.unknownReasons.status, "service-has-no-status");
  assert.equal(new Set([suspended, terminated].map((m) => m.legs[0].style.color)).size, 2);
});

test("the engine's verdict is shown as returned: possible, conditional, unknown and impossible", () => {
  const route = drawnRoute(true);
  const verdict = (assessment, legs) => view({ route, service: baseService(route, { assessment: { violations: [], conditions: [], missingInputs: [], ...assessment }, ...(legs ? { legs } : {}) }) });
  const possible = verdict({ verdict: "possible" });
  assert.equal(possible.assessmentVerdict, "possible");
  assert.equal(possible.assessmentVerdictLabel, "가능");
  const conditional = verdict({ verdict: "conditional", conditions: ["leg:leg:2:track-access-agreement-required"] });
  assert.equal(conditional.assessmentVerdict, "conditional");
  assert.equal(conditional.legs[1].conditional, true);
  assert.equal(conditional.legs[0].conditional, false);
  assert.deepEqual(conditional.legs[1].issues, [{ kind: "condition", code: "track-access-agreement-required" }]);
  const unknown = verdict({ verdict: "unknown", missingInputs: ["leg:leg:2:technicalProfileId"] }, [serviceLeg("leg:1"), serviceLeg("leg:2", { compatibility: "unknown" })]);
  assert.equal(unknown.assessmentVerdictLabel, "미상");
  assert.deepEqual(unknown.legs.map((l) => l.style.key), ["player-owned-player-operated", "unknown"]);
  const impossible = verdict({ verdict: "impossible", violations: ["leg:leg:2:running-system-incompatible"] }, [serviceLeg("leg:1"), serviceLeg("leg:2", { compatibility: "incompatible" })]);
  assert.equal(impossible.assessmentVerdictLabel, "불가능");
  assert.deepEqual(impossible.legs.map((l) => l.style.key), ["player-owned-player-operated", "impossible"]);
  assert.deepEqual(impossible.assessment.violations, ["leg:leg:2:running-system-incompatible"]);
  const missing = view({ route, service: baseService(route, { assessment: undefined }) });
  assert.equal(missing.assessmentVerdict, null);
  assert.equal(missing.unknownReasons.assessmentVerdict, "service-has-no-assessment");
  const wholeService = verdict({ verdict: "impossible", violations: ["trackAccessAgreement:access:9:not-found"] });
  assert.deepEqual(wholeService.legs.map((l) => l.style.key), ["impossible", "impossible"], "a finding that names no leg concerns every leg");
});

test("a separated handover is shown on the handover, not by turning both legs red", () => {
  const route = drawnRoute(false);
  const out = view({ route, service: baseService(route, { assessment: { verdict: "impossible", violations: ["handover:handover:1:physically-separated"], conditions: [], missingInputs: [] } }) });
  assert.equal(out.assessmentVerdict, "impossible");
  assert.deepEqual(out.legs.map((l) => l.style.key), ["player-owned-player-operated", "player-owned-player-operated"]);
  assert.equal(out.handovers[0].style.key, "separated");
  assert.deepEqual(out.handovers[0].issues, [{ kind: "violation", code: "physically-separated" }]);
});

// --- trains ---
test("trains: a reported position is shown as reported, an alignment and a progress interpolate, nothing else gets a position", () => {
  const route = drawnRoute(true);
  const live = (...trains) => view({ route, liveActuals: { operatingDay: 4, serviceMinute: 90, passengers: 10, trainKm: 5, trackAccessUsage: [{ agreementId: "access:1", trainKm: 2, stationStops: 1 }], trains } }).trainMarkers;
  const [reported] = live(train({ location: [139.004, 35.0001], progress: 0.9 }));
  assert.deepEqual(reported.location, [139.004, 35.0001]);
  assert.equal(reported.locationBasis, "reported");
  assert.equal(reported.drawable, true);
  const [mid] = live(train({ progress: 0.5, direction: "forward" }));
  assert.equal(mid.locationBasis, "interpolated");
  assert.ok(Math.abs(mid.location[0] - 139.005) < 1e-5 && mid.location[1] === 35);
  const [back] = live(train({ progress: 0.25, direction: "reverse" }));
  assert.ok(Math.abs(back.location[0] - 139.0075) < 1e-5, "reverse travel starts at the far end");
  assert.deepEqual(live(train({ progress: 0, direction: "forward" }))[0].location, A);
  assert.deepEqual(live(train({ progress: 1, direction: "forward" }))[0].location, B);
  const [no] = live(train());
  assert.equal(no.location, null, "no location and no progress: no position");
  assert.equal(no.drawable, false);
  assert.equal(no.unknownReasons.location, "no-location-and-no-progress");
  assert.equal(live(train({ progress: 0.5 }))[0].location, null, "a progress with no direction is not turned into a position");
  assert.equal(live(train({ progress: 0.5 }))[0].unknownReasons.location, "direction-unknown-for-progress");
  assert.equal(JSON.stringify(live(train({ progress: 0.5, direction: "forward" }))), JSON.stringify(live(train({ progress: 0.5, direction: "forward" }))), "interpolation is deterministic");
});

test("trains on a leg with no alignment have no position, and bad trains are dropped with a warning", () => {
  const route = baseRoute();
  const service = baseService(route);
  const out = buildThroughOperationView({ route, service, liveActuals: { trains: [
    train({ trainRunId: "run:ext", legId: "leg:2", progress: 0.5, direction: "forward" }),
    train({ trainRunId: "run:other", throughServiceId: "through-service:other" }),
    train({ trainRunId: "run:ghost", legId: "leg:ghost" }),
    train({ trainRunId: "run:badprogress", progress: 7, direction: "forward" }),
    train({ trainRunId: "run:baddirection", progress: 0.5, direction: "sideways" }),
    train({ trainRunId: "run:badlocation", location: [1] }),
    { legId: "leg:1", throughServiceId: "through-service:t" },
    train({ trainRunId: "dup" }), train({ trainRunId: "dup", progress: 0.5, direction: "forward" }),
  ] } });
  assert.deepEqual(out.trainMarkers.map((t) => t.trainRunId), ["run:badlocation", "run:badprogress", "run:baddirection", "run:ext"].sort());
  const ext = out.trainMarkers.find((t) => t.trainRunId === "run:ext");
  assert.equal(ext.location, null);
  assert.equal(ext.unknownReasons.location, "leg-has-no-alignment");
  assert.equal(ext.drawable, false);
  assert.deepEqual(out.warnings.map((w) => w.code).filter((c) => c !== "leg-not-drawable"), ["duplicate-train-run", "train-direction-invalid", "train-invalid", "train-leg-unknown", "train-location-invalid", "train-other-service", "train-progress-invalid"]);
  assert.equal(out.trainMarkers.find((t) => t.trainRunId === "run:badprogress").progress, null, "an invalid progress is null, not clamped");
  assert.ok(!out.trainMarkers.some((t) => t.trainRunId === "dup"), "a repeated run id is refused, whichever comes first");
  const none = buildThroughOperationView({ route, service });
  assert.deepEqual(none.trainMarkers, [], "no live input: no markers and no invented positions");
  assert.equal(none.live, null);
  const shuffled = buildThroughOperationView({ route, service, liveActuals: { trains: [train({ trainRunId: "b", location: A }), train({ trainRunId: "a", location: B })] } });
  assert.deepEqual(shuffled.trainMarkers.map((t) => t.trainRunId), ["a", "b"]);
});

test("live actuals are carried for display only and are never summed into a settlement", () => {
  const route = drawnRoute(true);
  const out = view({ route, liveActuals: { operatingDay: 3, serviceMinute: 30.5, passengers: 12, trainKm: null, trackAccessUsage: [{ agreementId: "access:b", trainKm: 1, stationStops: 2 }, { agreementId: "access:a", trainKm: 3, stationStops: 4 }], trains: [] } });
  assert.deepEqual(out.live, { operatingDay: 3, serviceMinute: 30.5, passengers: 12, trainKm: null, trackAccessUsage: [{ agreementId: "access:a", trainKm: 3, stationStops: 4 }, { agreementId: "access:b", trainKm: 1, stationStops: 2 }] });
  assert.equal(out.latestSettlement, null);
});

// --- missing data is never turned into a value ---
test("missing data stays null with a reason: never false, 0 or []", () => {
  const route = baseRoute();
  const service = baseService(route, { status: undefined, operatorId: undefined, legs: [] });
  const out = buildThroughOperationView({ route, service });
  assert.equal(out.operatorId, null);
  assert.equal(out.status, null);
  assert.equal(out.trainsPerHour, 4);
  const [leg] = out.legs;
  assert.equal(leg.infrastructureOwnerId, null);
  assert.equal(leg.operatorId, null);
  assert.equal(leg.compatibility, null);
  assert.equal(leg.technicalVerdict, null);
  assert.equal(leg.infrastructureStatus, null);
  assert.equal(leg.capacityTrainsPerHour, null);
  assert.equal(leg.trackAccessAgreementId, null);
  assert.equal(leg.style.key, "unknown");
  assert.equal(out.legs[1].alignment, null, "a null alignment is not [] or a line");
  assert.equal(out.handovers[0].physicalConnection, null);
  for (const entry of [out, ...out.legs, ...out.handovers]) {
    assert.deepEqual([...entry.unknown].sort(), Object.keys(entry.unknownReasons).sort(), "unknown[] and unknownReasons correspond");
    for (const f of entry.unknown) assert.ok(entry.unknownReasons[f]);
  }
});

// --- rendering ---
test("the panel writes names only as text, so markup in a name is never inserted", () => {
  const evil = "<img src=x onerror=alert(1)><script>boom()</script>";
  const route = { ...drawnRoute(true), name: evil };
  const service = baseService(route, { operatorId: evil, legs: [serviceLeg("leg:1", { operatorId: evil, infrastructureOwnerId: evil, trackAccessAgreementId: evil }), serviceLeg("leg:2")], trackAccessAgreementIds: [evil] });
  const box = fakeBox();
  renderThroughOperationPanel(box, buildThroughOperationView({ route, service, liveActuals: { trains: [train({ trainRunId: evil, location: A })] }, settlements: [settlement(4, { trackAccessUsage: [{ agreementId: evil, trainKm: 1, stationStops: 1 }] })] }));
  assert.ok(texts(box).some((t) => t.includes(evil)), "the text is shown, as text");
  assert.ok(box.children.every((c) => c.tag === "div" && c.children.length === 0), "only plain text elements, no markup nodes");
  assert.ok(!("innerHTML" in box), "the panel never sets innerHTML");
  assert.equal(box.hidden, false);
  renderThroughOperationPanel(box, null);
  assert.equal(box.hidden, true);
  assert.equal(box.children.length, 0);
});

test("the panel tells the player what is unknown, not drawn, stale or missing", () => {
  const route = baseRoute();
  const out = buildThroughOperationView({ route, service: baseService(route, { routeGeometryRevision: "through-route-revision:older", assessment: { verdict: "unknown", violations: [], conditions: ["leg:leg:2:track-access-agreement-required"], missingInputs: ["handover:handover:1:physicalConnection"] } }) });
  const box = fakeBox();
  renderThroughOperationPanel(box, out);
  const all = texts(box).join("\n");
  assert.match(all, /선형이 없어 지도에 그리지 않습니다/);
  assert.match(all, /접속 미상/);
  assert.match(all, /external-topology-not-in-source/);
  assert.match(all, /재판정이 필요/);
  assert.match(all, /track-access-agreement-required/);
  assert.match(all, /최근 운행정산 없음/);
  assert.match(all, /경영 판정 미상/);
});

test("the legend lists every style the overlay can draw", () => {
  const box = fakeBox();
  renderThroughOperationLegend(box);
  const labels = box.children.slice(1).map((row) => row.children[1].textContent);
  for (const style of [...Object.values(LEG_STYLES), ...Object.values(HANDOVER_STYLES)]) assert.ok(labels.some((l) => l.includes(style.label)), style.label);
  assert.ok(labels.some((l) => l.includes("열차")));
  assert.equal(box.children[0].textContent, "직통운행 (경영 엔진 반환값)");
  assert.equal(Object.keys(LEG_STYLES).length, 9);
});

test("the overlay draws handover markers and only trains that have a position", () => {
  const route = drawnRoute(false);
  const out = view({ route, liveActuals: { trains: [train({ trainRunId: "a", location: A }), train({ trainRunId: "b" })] } });
  const ctx = fakeCtx();
  drawThroughOperationOverlay(ctx, out, screen);
  assert.equal(ctx.calls.filter(([n]) => n === "arc").length, 2, "one handover marker and one drawable train");
  assert.ok(ctx.calls.some(([n, glyph]) => n === "fillText" && glyph === HANDOVER_STYLES.separated.glyph), "a separated boundary is marked with its own glyph");
  assert.equal(ctx.calls.filter(([n]) => n === "save").length, 1);
  assert.equal(ctx.calls.filter(([n]) => n === "restore").length, 1);
});

// --- real management output goes through the view unchanged (the module itself imports none of it) ---
test("a real settlement from the management engine is accepted, and the view reads it as it is without its money", () => {
  const route = drawnRoute(true);
  const legs = [{ legId: "leg:1", infrastructureOwnerId: "player" }, { legId: "leg:2", infrastructureOwnerId: "operator:external" }];
  const throughService = { ...baseService(route, { throughServiceId: "through-service:t", payerOperatorId: "player", payeeOwnerId: "operator:external", trackAccessAgreementIds: ["access:external"] }), legs };
  const agreement = createThroughFareAgreement({ id: "through-fare:t", throughService, participantTerms: [{ operatorId: "player", legIds: ["leg:1"], sectionFareJPY: 220 }, { operatorId: "operator:external", legIds: ["leg:2"], sectionFareJPY: 180 }], jointDiscountJPY: 70 });
  acceptThroughFareAgreement(agreement, "player");
  acceptThroughFareAgreement(agreement, "operator:external");
  fileThroughFareAgreement(agreement);
  activateThroughFareAgreement(agreement, throughService);
  const real = calculateThroughOperatingSettlement({
    throughService,
    fareAgreement: agreement,
    trackAccessAgreements: [{ schema: "transitline.track-access-agreement/1", contractVersion: 1, id: "access:external", infrastructureOwnerId: "operator:external", guestOperatorId: "player", accessFeeJPYPerTrainKm: 1000, stationFeeJPYPerStop: 10000, status: "active", totals: {} }],
    actuals: { operatingDay: 6, passengers: 1000, trainKm: 500, trackAccessUsage: [{ agreementId: "access:external", trainKm: 200, stationStops: 10 }] },
  });
  assert.ok(real.money.operatingCostJPY > 0, "the real settlement does carry money");
  const service = baseService(route, { legs: [serviceLeg("leg:1"), serviceLeg("leg:2", { infrastructureOwnerId: "operator:external", trackAccessAgreementId: "access:external" })], trackAccessAgreementIds: ["access:external"] });
  const out = view({ route, service, settlements: [real] });
  assert.equal(out.latestSettlement.operatingDay, 6);
  assert.equal(out.latestSettlement.passengers, 1000);
  assert.equal(out.latestSettlement.trainKm, 500);
  assert.equal(out.latestSettlement.carKm, real.carKm);
  assert.deepEqual(out.latestSettlement.trackAccessUsage, [{ agreementId: "access:external", infrastructureOwnerId: "operator:external", trainKm: 200, stationStops: 10 }]);
  assert.deepEqual(out.legs[1].agreementUsage, { trainKm: 200, stationStops: 10 });
  assert.equal(out.legs[1].style.key, "external-owned-player-operated");
  for (const key of keysDeep(out)) assert.ok(!FORBIDDEN.test(key), key);
});

// --- shipped examples (packs/<id>/through-operation-map-examples), tied to that pack's through-route examples ---
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const readJson = (p) => JSON.parse(fs.readFileSync(path.join(root, p), "utf8"));
const PACKS = ["tokyo", "example-radial", "example-corridor"];
const loadExamples = (id) => fs.readdirSync(path.join(root, "packs", id, "through-operation-map-examples")).filter((f) => f.endsWith(".view.json")).sort()
  .map((f) => ({ file: f, view: readJson(`packs/${id}/through-operation-map-examples/${f}`) }));
const routeFileOf = (id, example) => readJson(`packs/${id}/through-route-examples/${example.source.throughRouteExample}.through-route.json`);

test("every pack ships examples, each marked as a synthetic management report", () => {
  assert.ok(loadExamples("tokyo").length >= 4);
  assert.ok(loadExamples("example-radial").length >= 4);
  assert.ok(loadExamples("example-corridor").length >= 3);
  for (const id of PACKS) for (const { file, view: v } of loadExamples(id)) {
    assert.equal(v.schema, THROUGH_OPERATION_MAP_VIEW_SCHEMA, file);
    assert.equal(v.source.synthetic, true, `${id}/${file} says it is synthetic`);
    assert.match(v.source.note, /Synthetic management report/);
    assert.match(v.throughServiceId, /synthetic/);
    for (const key of keysDeep(v)) assert.ok(!FORBIDDEN.test(key), `${file}: ${key}`);
  }
});

test("examples are tied to a real through-route example of the same pack by id and revision", () => {
  for (const id of PACKS) for (const { file, view: v } of loadExamples(id)) {
    const route = routeFileOf(id, v);
    assert.equal(v.throughRouteId, route.throughRouteId, file);
    assert.equal(v.routeGeometryRevision, route.geometryRevision, file);
    assert.equal(v.stale, false);
    assert.equal(route.throughRouteId, keyedThroughRouteId(id, route.key), "the through-route example id is untouched");
    assert.deepEqual(v.legs.map((l) => l.legId), route.legs.map((l) => l.legId));
    assert.deepEqual(v.handovers.map((h) => h.handoverId), route.handovers.map((h) => h.handoverId));
    for (const entry of [v, ...v.legs, ...v.handovers, ...v.trainMarkers]) assert.deepEqual([...entry.unknown].sort(), Object.keys(entry.unknownReasons).sort(), file);
  }
});

test("the examples cover every required case", () => {
  const all = PACKS.flatMap((id) => loadExamples(id).map((e) => ({ id, file: e.file, v: e.view })));
  const cases = new Set(all.flatMap((e) => e.v.source.case));
  for (const required of ["approved-normal", "external-included", "connection-unknown", "physically-separated", "track-access-condition-unmet", "technically-impossible", "suspended", "terminated", "recent-settlement", "live-train-reported", "live-train-interpolated", "external-no-alignment-and-no-train-position"]) assert.ok(cases.has(required), required);
  const pick = (tag) => all.filter((e) => e.v.source.case.includes(tag)).map((e) => e.v);
  assert.ok(pick("approved-normal").every((v) => v.status === "approved" && v.assessmentVerdict === "possible"));
  assert.ok(pick("external-included").every((v) => v.legs.some((l) => l.sourceKind === "external" && l.alignment === null && l.display === "none")));
  assert.ok(pick("connection-unknown").every((v) => v.handovers.some((h) => h.physicalConnection === null && h.connectionState === "unknown")));
  assert.ok(pick("physically-separated").every((v) => v.handovers.some((h) => h.physicalConnection === false && h.connectionState === "separated") && v.assessmentVerdict === "impossible"));
  assert.ok(pick("track-access-condition-unmet").every((v) => v.assessmentVerdict === "conditional" && v.legs.some((l) => l.conditional)));
  assert.ok(pick("technically-impossible").every((v) => v.legs.some((l) => l.style.key === "impossible")));
  assert.ok(pick("suspended").every((v) => v.status === "suspended" && v.legs.every((l) => l.style.key === "suspended")));
  assert.ok(pick("terminated").every((v) => v.status === "terminated" && v.legs.every((l) => l.style.key === "terminated")));
  assert.ok(pick("recent-settlement").every((v) => v.latestSettlement !== null));
  assert.ok(pick("live-train-reported").every((v) => v.trainMarkers.some((t) => t.locationBasis === "reported")));
  assert.ok(pick("live-train-interpolated").every((v) => v.trainMarkers.some((t) => t.locationBasis === "interpolated")));
  const none = pick("external-no-alignment-and-no-train-position");
  assert.ok(none.length && none.every((v) => v.trainMarkers.some((t) => t.location === null && t.drawable === false) && v.legs.some((l) => l.alignment === null)));
  const styles = new Set(all.flatMap((e) => e.v.legs.map((l) => l.style.key)));
  for (const key of ["player-owned-player-operated", "external-owned-player-operated", "suspended", "terminated", "unknown", "impossible", "no-alignment"]) assert.ok(styles.has(key), `an example draws the ${key} style`);
});

test("examples regenerate byte-for-byte from their recorded inputs", () => {
  for (const id of PACKS) for (const { file, view: stored } of loadExamples(id)) {
    const { source, ...body } = stored;
    const { source: _drop, ...route } = routeFileOf(id, stored);
    assert.equal(JSON.stringify(buildThroughOperationView({ route, ...source.input })), JSON.stringify(body), `${id}/${file} is stale: run npm run through-operation-map-examples`);
  }
});
