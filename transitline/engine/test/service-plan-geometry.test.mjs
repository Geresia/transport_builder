import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { buildMapExport } from "../src/map/plan-geometry.mjs";
import { stableId } from "../src/map/ids.mjs";
import { buildRailGeometry, planRevisionOf } from "../src/map/rail-capacity-geometry.mjs";
import {
  SERVICE_PLAN_EXPORT_SCHEMA, SERVICE_PLAN_SCHEMA, buildServicePlan, buildServicePlanExport, keyedServicePlanId, keylessServicePlanId,
} from "../src/map/service-plan-geometry.mjs";
import {
  activePlans, addAssumption, addBand, addBothDirections, addDepotRef, addDirection, addItem, addPlan, addTurnback, appendSection, clearList, clearRoute, deactivateBand, deactivatePlan,
  declareNone, drawnPlansOf, moveSection, newServicePlanDoc, nextPlanKey, rebindRevision, removeBand, removeDirection, removePlan, removeSection, removeTurnback, restoreBand,
  restorePlan, restoreServicePlanDoc, reverseRoute, serializeServicePlanDoc, setRoute, setVehicleIntent, toDrawnPlan, updateBand, updateDirection, updatePlan,
} from "../src/map/service-plan-editor.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const engineDir = path.resolve(here, "..");
const root = path.resolve(here, "..", "..");

// --- fixtures: two plans along lat 35 (a: 2 sections, b: 2 sections), an existing line E1 (d1..d3, station level only) and a rail capacity geometry over all of it ---
const pack = { manifest: { id: "t", version: "1", data: { license: "CC0-1.0", attribution: ["test"] } }, demand: { points: ["d0", "d1", "d2", "d3", "d4"].map((id, i) => ({ id, name: id, location: [139 + i * 0.01, 35] })) }, existingNetwork: { lines: [{ name: "E1", operator: "Operator X", osmRelationId: 42, stationIds: ["d1", "d2", "d3"] }] } };
const EXT = "ext-line:42";
const line = (key, pts) => ({ key, name: key, vertices: pts.map((location) => ({ location, platformType: "side" })) });
const ref = (plan, i) => ({ planId: plan.planId, segmentId: plan.segments[i].id });
const revisionsOf = (...plans) => ({ plans: Object.fromEntries(plans.map((p) => [p.planId, planRevisionOf(p)])), routes: {} });
const boundary = (key, plan, i, alongMeters) => ({ key, planId: plan.planId, segmentId: plan.segments[i].id, measuredFromStationId: plan.segments[i].from, alongMeters, basis: "player" });
const sectionOf = (g, plan, i) => g.sections.find((s) => s.planId === plan.planId && s.segmentId === plan.segments[i].id);

function makeWorld({ terminals = "stated", blocks = "declared", extraBoundary = false, packId = "t", singleA1 = true } = {}) {
  const p = { ...pack, manifest: { ...pack.manifest, id: packId } };
  const mapExport = buildMapExport({ pack: p, mode: "existing", drawnLines: [line("a", [[139, 35], [139.01, 35], [139.02, 35]]), line("b", [[139.02, 35], [139.03, 35], [139.04, 35]])] });
  const A = mapExport.plans.find((x) => x.planId === stableId("plan", packId, "key", "a"));
  const B = mapExport.plans.find((x) => x.planId === stableId("plan", packId, "key", "b"));
  const a0 = A.segments[0].from;
  const termList = terminals === "stated" ? [
    { key: "t-a0", stationId: a0, platforms: [{ key: "p0", approach: ref(A, 0), polyline: [[139, 35], [138.9985, 35]], platformLengthMeters: 120 }], turnbackTracks: [{ key: "tb0", kind: "turnback", polyline: [[139, 35], [138.9988, 35.0003]] }] },
    { key: "t-b2", stationId: B.segments[1].to, platforms: [], turnbackTracks: [{ key: "far", kind: "stabling", polyline: [[139.04, 35.002], [139.0415, 35.002]] }] },
    { key: "t-b1", stationId: B.segments[0].to },
  ] : terminals === "declared-none" ? [] : null;
  const boundaries = blocks === "declared" ? [boundary("b1", A, 0, 300), boundary("b2", A, 0, 600), ...(extraBoundary ? [boundary("b3", B, 0, 500)] : [])] : null;
  const out = buildRailGeometry({
    key: "g", planIds: [A.planId, B.planId], externalLineIds: [EXT], designedRevisions: revisionsOf(A, B),
    sectionFacts: [{ ref: ref(A, 1), directionMode: singleA1 ? "single" : "double", basis: "player" }, { ref: ref(B, 0), directionMode: "double", basis: "player" }],
    ...(boundaries ? { blockBoundaries: boundaries } : {}), ...(termList ? { terminals: termList } : {}),
  }, { pack: p, plans: mapExport.plans, externalNetworks: mapExport.externalNetworks });
  assert.ok(out.design, JSON.stringify(out.warnings));
  const G = out.design;
  const E = G.sections.filter((s) => s.sourceKind === "external").sort((x, y) => (x.fromStationId < y.fromStationId ? -1 : 1));
  const application = { schema: "transitline.rail-capacity-application/1", contractVersion: 1, applicationId: "rail-capacity-application:test", operationalLineId: "line:1", railGeometryId: G.railGeometryId, railGeometryRevision: G.railGeometryRevision, sections: G.sections.map((s, i) => ({ trackSegmentId: `track-segment:${i + 1}`, railCapacitySectionId: s.sectionId })) };
  return { pack: p, A, B, G, A0: sectionOf(G, A, 0), A1: sectionOf(G, A, 1), B0: sectionOf(G, B, 0), B1: sectionOf(G, B, 1), E1: E[0], E2: E[1], stations: { a0, a1: A.segments[0].to, a2: A.segments[1].to, b2: B.segments[1].to }, application, terminalId: (key) => G.terminals?.find((t) => t.key === key)?.terminalResourceId };
}
const W = makeWorld();

const base = (over = {}, w = W) => ({
  key: "plan-a", name: "Line A", railGeometryId: w.G.railGeometryId, designedRailGeometryRevision: w.G.railGeometryRevision, planKind: "regular", operatingPattern: "full", operationalLineId: "line:1",
  route: { sectionIds: [w.A0.sectionId, w.A1.sectionId] },
  directions: [{ key: "up", label: "Up", fromStationId: w.stations.a0, toStationId: w.stations.a2 }, { key: "down", label: "Down", fromStationId: w.stations.a2, toStationId: w.stations.a0 }],
  serviceBands: [{ key: "peak", label: "Peak", startMinute: 420, endMinute: 540, headwayMinutes: 5, trainsets: 6, formationCars: 8, directionKeys: ["up", "down"] }],
  turnbacks: [{ key: "end-a0", stationId: w.stations.a0, intent: "route-end", terminalResourceId: w.terminalId("t-a0") }],
  vehicleIntent: { vehicleModelId: "vehicle-model:x", requestedCars: 8, requestedTrainsets: 6 }, assumptions: [{ key: "a-1", text: "Peak trains run express" }],
  ...over,
});
const ctxOf = (w = W, extra = {}) => ({ pack: w.pack, railGeometry: w.G, application: w.application, ...extra });
const build = (drawn, w = W, extra = {}) => buildServicePlan(drawn, ctxOf(w, extra));
const plan = (drawn, w = W, extra = {}) => { const out = build(drawn, w, extra); assert.ok(out.plan, JSON.stringify(out.warnings)); return out.plan; };
const codes = (out) => out.warnings.map((w) => w.code);
const json = (v) => JSON.stringify(v);
const deepFreeze = (v) => { if (v && typeof v === "object" && !Object.isFrozen(v)) { Object.freeze(v); Object.values(v).forEach(deepFreeze); } return v; };
function* keysDeep(v) { if (Array.isArray(v)) for (const x of v) yield* keysDeep(x); else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { yield k; yield* keysDeep(x); } }
const FORBIDDEN = /cost|price|\bfee|fare|cash|probab|verdict|feasib|possib|approval|score|delay|duration|recover|crowd|passenger|ridership|demand|revenue|punctual|timetable|throughput|actual|compatib|(?<!rail)capacity(?!Application)|satisf/i;
// every `unknown` list names exactly the keys of `unknownReasons`, and every field it names is null
function assertUnknownContract(value, where) {
  if (Array.isArray(value)) return value.forEach((x, i) => assertUnknownContract(x, `${where}[${i}]`));
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value.unknown) && value.unknownReasons) {
    assert.deepEqual(Object.keys(value.unknownReasons).sort(), [...value.unknown].sort(), `${where}: unknown vs unknownReasons`);
    for (const f of value.unknown) if (!f.includes(":") && f in value) assert.equal(value[f], null, `${where}.${f} is unknown so it is null`);
    for (const r of Object.values(value.unknownReasons)) assert.equal(typeof r === "string" && r.length > 0, true, `${where}: a reason`);
  }
  for (const [k, v] of Object.entries(value)) assertUnknownContract(v, `${where}.${k}`);
}

// --- the contract: identity and what the player states ---
test("a plan carries the schema, the ids that tie it to the geometry and its application, and what the player stated", () => {
  const p = plan(base());
  assert.equal(p.schema, SERVICE_PLAN_SCHEMA);
  assert.equal(p.contractVersion, 1);
  assert.equal(p.servicePlanId, keyedServicePlanId("t", "plan-a"));
  assert.match(p.servicePlanRevision, /^service-plan-revision:/);
  assert.equal(p.sourcePackId, "t");
  assert.equal(p.sourcePackVersion, "1");
  assert.equal(p.railGeometryId, W.G.railGeometryId);
  assert.equal(p.railGeometryRevision, W.G.railGeometryRevision);
  assert.equal(p.capacityApplicationId, "rail-capacity-application:test");
  assert.equal(p.capacityApplicationRevision, W.G.railGeometryRevision);
  assert.equal(p.capacityApplicationState, "current");
  assert.equal(p.operationalLineId, "line:1");
  assert.equal(p.active, true);
  assert.equal(p.planKind, "regular");
  assert.equal(p.playerInputs.operatingPattern, "full");
  assert.deepEqual(p.playerInputs.assumptions.map((a) => a.text), ["Peak trains run express"]);
  assert.equal(p.serviceBands[0].playerRequestedHeadwayMinutes, 5);
  assert.equal(p.serviceBands[0].playerRequestedTrainsets, 6);
  assert.equal(p.serviceBands[0].playerRequestedFormationCars, 8);
  assert.equal(p.serviceBands[0].operating, true);
  assert.deepEqual([p.serviceBands[0].startMinute, p.serviceBands[0].endMinute], [420, 540]);
  assert.deepEqual(p.vehicleIntent, { vehicleModelId: "vehicle-model:x", requestedCars: 8, requestedTrainsets: 6, playerSelected: true, unknown: [], unknownReasons: {} });
  assert.equal(p.revision.state, "current");
  assert.deepEqual(p.warnings, []);
});

test("the route is read in the order the player chose: stations, how each section is run, how they join, and the facts of each section", () => {
  const r = plan(base()).route;
  const track = (section) => `track-segment:${W.G.sections.findIndex((s) => s.sectionId === section.sectionId) + 1}`;
  assert.deepEqual(r.sectionIds, [W.A0.sectionId, W.A1.sectionId]);
  assert.deepEqual(r.stationIds, [W.stations.a0, W.stations.a1, W.stations.a2]);
  assert.deepEqual([r.fromStationId, r.toStationId], [W.stations.a0, W.stations.a2]);
  assert.deepEqual(r.sections.map((s) => [s.order, s.sectionId, s.traversal, s.enterStationId, s.exitStationId, s.trackSegmentId]), [
    [1, W.A0.sectionId, "forward", W.stations.a0, W.stations.a1, track(W.A0)],
    [2, W.A1.sectionId, "forward", W.stations.a1, W.stations.a2, track(W.A1)],
  ]);
  assert.equal(r.links.length, 1);
  assert.deepEqual([r.links[0].viaStationId, r.links[0].sharedStation, r.links[0].physicalJoin], [W.stations.a1, true, true]);
  assert.deepEqual([r.stationsShared, r.physicallyJoined, r.includesExternal, r.externalSectionIds], [true, true, false, []]);
  assert.equal(r.coversWholeGeometry, false);
  assert.equal(r.omittedSectionIds.length, 4);
  const facts = plan(base()).spatialFacts.sections;
  assert.deepEqual(facts.map((s) => [s.sectionId, s.directionMode, s.directionModeBasis]), [[W.A0.sectionId, null, null], [W.A1.sectionId, "single", "player"]]);
  assert.equal(facts[0].blockIds.length, 3);
  assert.equal(facts[0].closureTarget, true);
  assert.equal(facts[0].unknownReasons.directionMode, "track-count-not-stated");
});

test("a route listed the other way round is run in the reverse way through each section", () => {
  const p = plan(base({ route: { sectionIds: [W.A1.sectionId, W.A0.sectionId] } }));
  assert.deepEqual(p.route.stationIds, [W.stations.a2, W.stations.a1, W.stations.a0]);
  assert.deepEqual(p.route.sections.map((s) => s.traversal), ["reverse", "reverse"]);
  assert.deepEqual(p.directions.find((d) => d.key === "up").orderedSectionIds, [W.A0.sectionId, W.A1.sectionId]);
});

test("directions read their sections and stations from the route, both ways, and a part of the route is allowed", () => {
  const p = plan(base({ directions: [...base().directions, { key: "short", fromStationId: W.stations.a0, toStationId: W.stations.a1 }, { key: "back-short", fromStationId: W.stations.a2, toStationId: W.stations.a1 }] }));
  const d = (key) => p.directions.find((x) => x.key === key);
  assert.deepEqual(d("up").orderedSectionIds, [W.A0.sectionId, W.A1.sectionId]);
  assert.deepEqual(d("up").orderedStationIds, [W.stations.a0, W.stations.a1, W.stations.a2]);
  assert.deepEqual(d("down").orderedSectionIds, [W.A1.sectionId, W.A0.sectionId]);
  assert.deepEqual(d("down").orderedStationIds, [W.stations.a2, W.stations.a1, W.stations.a0]);
  assert.deepEqual(d("short").orderedSectionIds, [W.A0.sectionId]);
  assert.deepEqual(d("back-short").orderedSectionIds, [W.A1.sectionId]);
  assert.equal(d("short").physicalConnection, true);
  assert.equal(d("up").physicalConnection, true);
  assert.deepEqual(d("up").reversalTurnbackIds, []); // the player named a turnback, but not at this direction's end
  assert.equal(d("down").reversalTurnbackIds.length, 1);
  assert.equal(d("up").directionId, stableId("service-direction", p.servicePlanId, "key", "up"));
});

test("a direction between stations that are not on the route is a warning with null facts, not a guess", () => {
  const out = build(base({ directions: [{ key: "x", fromStationId: W.stations.a0, toStationId: W.stations.b2 }] }));
  assert.ok(codes(out).includes("direction-station-not-on-route"));
  const d = out.plan.directions[0];
  assert.deepEqual([d.orderedSectionIds, d.orderedStationIds, d.physicalConnection], [null, null, null]);
  assert.equal(d.unknownReasons.orderedSectionIds, "direction-station-not-on-route");
  assert.deepEqual(codes(build(base({ directions: [{ key: "x", fromStationId: "s", toStationId: "s" }], serviceBands: null }))), ["direction-stations-invalid"]);
  assert.ok(codes(build(base({ directions: [{ key: "x", fromStationId: W.stations.a0, toStationId: W.stations.a2 }, { key: "y", fromStationId: W.stations.a0, toStationId: W.stations.a2 }] }))).includes("direction-duplicate"));
});

// --- null / false / 0 / [] ---
test("unknown is null with a reason: no track count, no blocks, no terminals and no application are never turned into a default", () => {
  const bare = makeWorld({ terminals: null, blocks: null, singleA1: false });
  const p = plan(base({ route: { sectionIds: [bare.A0.sectionId, bare.A1.sectionId] }, turnbacks: [{ key: "t", stationId: bare.stations.a0, intent: "route-end" }] }, bare), bare, { application: null });
  const [s0, s1] = p.spatialFacts.sections;
  assert.equal(s0.directionMode, null);
  assert.equal(s0.unknownReasons.directionMode, "track-count-not-stated");
  assert.equal(s1.directionMode, "double");
  assert.equal(s0.blockIds, null);
  assert.equal(s0.unknownReasons.blockIds, "no-block-data");
  assert.equal(s0.junctionResourceIds, null);
  assert.equal(p.terminals[0].facilities, null);
  assert.equal(p.turnbacks[0].facilityFacts.terminalResourceIdsAtStation, null);
  assert.equal(p.capacityApplicationId, null);
  assert.equal(p.capacityApplicationState, null);
  assert.equal(p.unknownReasons.capacityApplicationId, "capacity-application-not-supplied");
  assert.equal(p.route.sections[0].trackSegmentId, null);
  for (const flag of ["track-count-unknown", "terminal-data-missing", "block-data-missing"]) assert.ok(p.spatialFacts.spatialFlags.includes(flag), flag);
});

test("a declared empty list ([]) is a fact and an absent list is unknown: terminals, turnbacks, directions and bands", () => {
  const declared = makeWorld({ terminals: "declared-none", blocks: "declared" });
  const p = plan(base({ turnbacks: [{ key: "t", stationId: declared.stations.a0, intent: "route-end" }] }, declared), declared);
  assert.deepEqual(p.terminals[0].facilities, []); // the stated terminal data names no terminal here
  assert.equal("facilities" in p.terminals[0].unknownReasons, false);
  assert.deepEqual(p.turnbacks[0].facilityFacts.terminalResourceIdsAtStation, []);
  const none = plan(base({ turnbacks: [], directions: [], serviceBands: [] }));
  assert.deepEqual([none.turnbacks, none.directions, none.serviceBands], [[], [], []]);
  for (const f of ["turnbacks", "directions", "serviceBands"]) assert.equal(f in none.unknownReasons, false, f);
  const unstated = plan(base({ turnbacks: undefined, directions: null, serviceBands: undefined }));
  assert.deepEqual([unstated.directions, unstated.serviceBands, unstated.turnbacks], [null, null, null]);
  assert.equal(unstated.unknownReasons.directions, "directions-not-stated");
  assert.equal(unstated.unknownReasons.serviceBands, "service-bands-not-stated");
  assert.equal(unstated.unknownReasons.turnbacks, "turnbacks-not-stated");
});

test("0 is a stated zero and is kept; an impossible zero (headway, cars) is a warning and null, not 0", () => {
  const p = plan(base({ serviceBands: [{ key: "night", startMinute: 0, endMinute: 60, trainsets: 0, headwayMinutes: 15, formationCars: 6, directionKeys: ["up"] }] }));
  assert.equal(p.serviceBands[0].playerRequestedTrainsets, 0);
  assert.equal(p.serviceBands[0].startMinute, 0);
  assert.equal("playerRequestedTrainsets" in p.serviceBands[0].unknownReasons, false);
  const bad = build(base({ serviceBands: [{ key: "b", startMinute: 0, endMinute: 60, headwayMinutes: 0, trainsets: -1, formationCars: 0 }], vehicleIntent: { requestedCars: 0, requestedTrainsets: 0 } }));
  const b = bad.plan.serviceBands[0];
  assert.deepEqual([b.playerRequestedHeadwayMinutes, b.playerRequestedTrainsets, b.playerRequestedFormationCars], [null, null, null]);
  assert.deepEqual(codes(bad).sort(), ["formationCars-invalid", "headwayMinutes-invalid", "requestedCars-invalid", "trainsets-invalid"]);
  assert.equal(bad.plan.vehicleIntent.requestedCars, null);
  assert.equal(bad.plan.vehicleIntent.requestedTrainsets, 0);
  assert.equal(bad.plan.vehicleIntent.unknownReasons.vehicleModelId, "vehicleModelId-not-stated");
  assert.equal(b.unknownReasons.playerRequestedHeadwayMinutes, "headway-not-stated");
  const noVehicle = plan(base({ vehicleIntent: undefined }));
  assert.equal(noVehicle.vehicleIntent.playerSelected, false);
  assert.deepEqual([noVehicle.vehicleIntent.vehicleModelId, noVehicle.vehicleIntent.requestedCars, noVehicle.vehicleIntent.requestedTrainsets], [null, null, null]);
});

test("unknown joins and an unknown external line are null with a reason, never false", () => {
  const p = plan(base({ route: { sectionIds: [W.E1.sectionId, W.E2.sectionId] }, directions: null, serviceBands: null, turnbacks: null }));
  assert.deepEqual(p.route.stationIds, ["d1", "d2", "d3"]);
  assert.equal(p.route.includesExternal, true);
  assert.deepEqual(p.route.externalSectionIds, [W.E1.sectionId, W.E2.sectionId].sort());
  assert.equal(p.route.stationsShared, true);
  assert.equal(p.route.links[0].physicalJoin, null);
  assert.equal(p.route.links[0].unknownReasons.physicalJoin, "external-alignment-not-in-source");
  assert.equal(p.route.physicallyJoined, null);
  assert.equal(p.route.unknownReasons.physicallyJoined, "join-state-not-in-geometry");
  const s = p.spatialFacts.sections[0];
  assert.deepEqual([s.lengthMeters, s.directionMode, s.minimumCurveRadiusMeters, s.blockIds], [null, null, null, null]);
  assert.equal(s.unknownReasons.lengthMeters, "external-alignment-not-in-source");
  assert.equal(s.unknownReasons.directionMode, "external-track-data-not-in-source");
  assert.ok(p.spatialFacts.spatialFlags.includes("external-section-on-route"));
  // a plan section next to an external section: the two ends are not shown to meet, so this is unknown, not false
  const mixed = plan(base({ route: { sectionIds: [W.B1.sectionId, W.E1.sectionId] }, directions: null, serviceBands: null, turnbacks: null }));
  assert.equal(mixed.route.stationsShared, false);
  assert.equal(mixed.route.links[0].physicalJoin, null);
  assert.equal(mixed.route.links[0].sharedStation, false);
  assert.equal(mixed.route.stationIds, null);
  assert.equal(mixed.route.unknownReasons.stationIds, "route-sections-share-no-station");
  assert.ok(mixed.spatialFacts.spatialFlags.includes("route-sections-share-no-station"));
});

test("a section that is not in the geometry is reported, and the order and facts that depend on it are unknown", () => {
  const out = build(base({ route: { sectionIds: [W.A0.sectionId, "rail-section:gone"] } }));
  assert.ok(codes(out).includes("route-section-missing"));
  const p = out.plan;
  assert.deepEqual(p.route.missingSectionIds, ["rail-section:gone"]);
  assert.deepEqual([p.route.stationIds, p.route.sections, p.route.includesExternal], [null, null, null]);
  assert.deepEqual(p.spatialFacts.sections, []);
  assert.equal(p.route.unknownReasons.stationIds, "route-section-missing");
  assert.equal(p.directions[0].orderedSectionIds, null);
  // no route chosen yet: unknown, not an empty route
  const none = plan(base({ route: null }));
  assert.equal(none.route.sectionIds, null);
  assert.equal(none.route.unknownReasons.sectionIds, "route-not-selected");
  assert.equal(none.route.coversWholeGeometry, null);
  assert.deepEqual(plan(base({ route: { sectionIds: [] } })).route.sectionIds, []);
});

test("a lone section runs from its own first station unless the player started the route at its other end", () => {
  const forward = plan(base({ route: { sectionIds: [W.A0.sectionId] }, directions: null }));
  assert.deepEqual(forward.route.stationIds, [W.A0.fromStationId, W.A0.toStationId]);
  const turned = plan(base({ route: { sectionIds: [W.A0.sectionId], fromStationId: W.A0.toStationId }, directions: null }));
  assert.deepEqual(turned.route.stationIds, [W.A0.toStationId, W.A0.fromStationId]);
  assert.equal(turned.route.sections[0].traversal, "reverse");
  const differs = build(base({ route: { sectionIds: [W.A0.sectionId, W.A1.sectionId], fromStationId: W.stations.a2 } }));
  assert.ok(codes(differs).includes("route-endpoint-differs"));
  assert.equal(differs.plan.route.fromStationId, W.stations.a0);
  assert.equal(differs.plan.route.playerFromStationId, W.stations.a2);
});

// --- terminals and turnbacks: what the player picked vs what the map knows about the facility ---
test("a turnback the player picked is a statement; the facility facts are read from the geometry and keep their true / false / null", () => {
  const p = plan(base({ turnbacks: [
    { key: "end-a0", stationId: W.stations.a0, intent: "route-end", terminalResourceId: W.terminalId("t-a0") },
    { key: "mid", stationId: W.stations.a1, intent: "intermediate" },
  ] }));
  const end = p.turnbacks.find((t) => t.key === "end-a0");
  const mid = p.turnbacks.find((t) => t.key === "mid");
  assert.deepEqual([end.playerSelected, end.onRoute, end.position, end.intent], [true, true, "start", "route-end"]);
  assert.deepEqual([mid.position, mid.onRoute, mid.terminalResourceId], ["middle", true, null]);
  assert.equal(end.facilityFacts.terminalResourceKnown, true);
  assert.deepEqual(end.facilityFacts.terminalResourceIdsAtStation, [W.terminalId("t-a0")]);
  // the middle station: the terminal data is stated and names no terminal here — a fact within that data, with nothing selected
  assert.deepEqual(mid.facilityFacts.terminalResourceIdsAtStation, []);
  assert.equal(mid.facilityFacts.terminalResourceKnown, null);
  assert.equal(mid.facilityFacts.unknownReasons.terminalResourceKnown, "no-terminal-selected");
  const at = p.terminals.find((t) => t.stationId === W.stations.a0);
  assert.deepEqual(at.roles, ["route-start", "turnback"]);
  assert.deepEqual(at.playerSelectedTerminalResourceIds, [W.terminalId("t-a0")]);
  const f = at.facilities[0];
  assert.equal(f.playerSelected, true);
  assert.equal(f.platformCandidates.length, 1);
  assert.equal(f.platformCandidates[0].connected, true);
  assert.equal(f.turnbackCandidates[0].attached, true);
  const last = p.terminals.find((t) => t.stationId === W.stations.a2);
  assert.deepEqual(last.roles, ["route-end"]);
  assert.deepEqual(last.facilities, []);
});

test("a terminal the player picked that the geometry does not have at that station is a warning; a terminal with no platform data stays null", () => {
  const out = build(base({ turnbacks: [{ key: "bad", stationId: W.stations.a0, intent: "route-end", terminalResourceId: "rail-terminal:other" }] }));
  assert.ok(codes(out).includes("terminal-resource-not-at-station"));
  assert.equal(out.plan.turnbacks[0].facilityFacts.terminalResourceKnown, false);
  // t-b1 is stated with nothing about its tracks: its candidates are null (unknown), not []
  const p = plan(base({ route: { sectionIds: [W.B0.sectionId, W.B1.sectionId] }, directions: null, turnbacks: [{ key: "t", stationId: W.B0.toStationId, intent: "intermediate", terminalResourceId: W.terminalId("t-b1") }] }));
  const f = p.terminals.find((t) => t.stationId === W.B0.toStationId).facilities[0];
  assert.equal(f.platformCandidates, null);
  assert.equal(f.turnbackCandidates, null);
  assert.equal(f.unknownReasons.platformCandidates, "no-platform-data");
  // t-b2 is declared with an empty platform list ([] declared) and a stabling track that is apart from the approach
  const far = plan(base({ route: { sectionIds: [W.B0.sectionId, W.B1.sectionId] }, directions: null, turnbacks: [{ key: "t", stationId: W.stations.b2, intent: "route-end", terminalResourceId: W.terminalId("t-b2") }] }));
  const g = far.terminals.find((t) => t.stationId === W.stations.b2).facilities[0];
  assert.deepEqual(g.platformCandidates, []);
  assert.equal(g.turnbackCandidates[0].attached, false);
});

test("a turnback at an external station has unknown facilities, and a turnback off the route is a warning", () => {
  const ext = plan(base({ route: { sectionIds: [W.E1.sectionId, W.E2.sectionId] }, directions: null, turnbacks: [{ key: "t", stationId: "d2", intent: "intermediate" }] }));
  const d2 = ext.terminals.find((t) => t.stationId === "d2");
  assert.equal(d2.facilities, null);
  assert.equal(d2.unknownReasons.facilities, "external-station-terminal-not-in-source");
  const off = build(base({ turnbacks: [{ key: "t", stationId: W.stations.b2, intent: "intermediate" }] }));
  assert.ok(codes(off).includes("turnback-station-off-route"));
  assert.equal(off.plan.turnbacks[0].onRoute, false);
  assert.equal(off.plan.turnbacks[0].unknownReasons.position, "station-not-on-route");
});

// --- bands ---
test("bands keep the minutes the player gave; a bad range is a warning and the band is dropped; overlapping bands are only flagged", () => {
  const out = build(base({ serviceBands: [
    { key: "ok", startMinute: 360, endMinute: 480, headwayMinutes: 7.5, directionKeys: ["up"] },
    { key: "end-before-start", startMinute: 600, endMinute: 540 },
    { key: "past-midnight", startMinute: 1400, endMinute: 1500 },
    { key: "fraction", startMinute: 1.5, endMinute: 20 },
    { key: "overlap", startMinute: 450, endMinute: 520, headwayMinutes: 10, directionKeys: ["up", "down"] },
    { key: "other-direction", startMinute: 450, endMinute: 520, directionKeys: ["down"] },
    { key: "off", startMinute: 450, endMinute: 520, directionKeys: ["up"], active: false },
    { key: "wrong-key", startMinute: 1000, endMinute: 1100, directionKeys: ["up", "nope"] },
  ] }));
  assert.equal(codes(out).filter((c) => c === "band-time-invalid").length, 3);
  assert.deepEqual(out.plan.serviceBands.map((b) => b.key).sort(), ["off", "ok", "other-direction", "overlap", "wrong-key"]);
  assert.equal(out.plan.serviceBands.find((b) => b.key === "ok").playerRequestedHeadwayMinutes, 7.5);
  assert.equal(out.plan.serviceBands.find((b) => b.key === "off").operating, false);
  assert.equal(out.warnings.filter((w) => w.code === "bands-overlap").length, 2); // ok x overlap (up) and overlap x other-direction (down); the switched-off band overlaps nothing
  assert.ok(codes(out).includes("band-direction-unknown"));
  assert.equal(out.plan.serviceBands.find((b) => b.key === "ok").unknownReasons.playerRequestedTrainsets, "trainsets-not-stated");
  assert.equal(plan(base({ serviceBands: [{ key: "x", startMinute: 0, endMinute: 1440 }] })).serviceBands[0].endMinute, 1440);
});

// --- identity: ids follow the key, then the physical route; nothing depends on names, order, clock or randomness ---
test("the same input gives the same ids and byte-identical JSON", () => {
  assert.equal(json(plan(base())), json(plan(structuredClone(base()))));
  const exp = () => json(buildServicePlanExport({ pack: W.pack, railGeometries: [W.G], applications: [W.application], plans: [base(), base({ key: "plan-b", route: { sectionIds: [W.B0.sectionId, W.B1.sectionId] }, directions: null })] }));
  assert.equal(exp(), exp());
});

test("names, labels and the order of the arrays do not change any id; names and labels do not change the revision either", () => {
  const p = plan(base());
  const d = base();
  const q = plan(base({ name: "Renamed", directions: [...d.directions].reverse().map((x) => ({ ...x, label: `${x.label}!` })), serviceBands: [{ ...d.serviceBands[0], label: "Rush hour", directionKeys: ["down", "up"] }] }));
  assert.equal(q.servicePlanId, p.servicePlanId);
  assert.equal(q.servicePlanRevision, p.servicePlanRevision);
  assert.deepEqual(q.directions.map((x) => x.directionId), p.directions.map((x) => x.directionId));
  assert.deepEqual(q.serviceBands.map((x) => x.bandId), p.serviceBands.map((x) => x.bandId));
  assert.equal(q.name, "Renamed");
  const keyless = (ids) => plan(base({ key: undefined, route: { sectionIds: ids } }));
  const k1 = keyless([W.A0.sectionId, W.A1.sectionId]);
  const k2 = keyless([W.A1.sectionId, W.A0.sectionId]);
  assert.equal(k1.servicePlanId, k2.servicePlanId);
  assert.notEqual(k1.servicePlanRevision, k2.servicePlanRevision); // the order the player gave is part of what they stated
  assert.equal(k1.servicePlanId, keylessServicePlanId("t", W.G.railGeometryId, "regular", [W.A1.sectionId, W.A0.sectionId]));
});

test("a keyed plan keeps its id when everything about it is edited; a keyless plan's id follows the sections and the kind", () => {
  const id = (over) => plan(base(over)).servicePlanId;
  assert.equal(id({ route: { sectionIds: [W.A0.sectionId] } }), id({}));
  assert.equal(id({ planKind: "disruption-response" }), id({}));
  assert.equal(id({ name: "x", serviceBands: [], directions: [], turnbacks: [] }), id({}));
  assert.notEqual(id({ key: "plan-b" }), id({}));
  const keyless = (over) => plan(base({ key: undefined, ...over })).servicePlanId;
  assert.notEqual(keyless({ route: { sectionIds: [W.A0.sectionId] } }), keyless({}));
  assert.notEqual(keyless({ planKind: "disruption-response" }), keyless({}));
  assert.equal(keyless({ name: "other", serviceBands: [] }), keyless({}));
  assert.equal(keyless({ operatingPattern: "short-turn" }), keyless({}));
});

test("the revision changes when what the player stated changes; the id does not", () => {
  const p = plan(base());
  for (const over of [{ serviceBands: [{ ...base().serviceBands[0], headwayMinutes: 6 }] }, { turnbacks: [] }, { vehicleIntent: { vehicleModelId: "vehicle-model:y" } }, { planKind: "disruption-response" }, { active: false }]) {
    const q = plan(base(over));
    assert.equal(q.servicePlanId, p.servicePlanId);
    assert.notEqual(q.servicePlanRevision, p.servicePlanRevision, json(over));
  }
});

// --- revision and stale ---
test("a plan made on an older geometry revision is stale; one that never recorded a revision says so; the facts are still the current geometry's", () => {
  const next = makeWorld({ extraBoundary: true });
  assert.notEqual(next.G.railGeometryRevision, W.G.railGeometryRevision);
  assert.equal(next.G.railGeometryId, W.G.railGeometryId);
  const out = build(base({ designedRailGeometryRevision: W.G.railGeometryRevision }), next, { application: W.application });
  assert.equal(out.plan.revision.state, "stale");
  assert.equal(out.plan.revision.designedRailGeometryRevision, W.G.railGeometryRevision);
  assert.equal(out.plan.revision.currentRailGeometryRevision, next.G.railGeometryRevision);
  assert.equal(out.plan.railGeometryRevision, next.G.railGeometryRevision);
  assert.ok(codes(out).includes("revision-stale"));
  assert.ok(codes(out).includes("application-stale")); // the application was made for the older geometry
  assert.equal(out.plan.capacityApplicationState, "stale");
  assert.equal(out.plan.capacityApplicationRevision, W.G.railGeometryRevision);
  assert.equal(out.plan.route.sections[0].trackSegmentId, null);
  assert.equal("capacityApplicationId" in out.plan.unknownReasons, false); // it still names the revision it was made for
  assert.equal(out.plan.route.sections[0].unknownReasons.trackSegmentId, "capacity-application-stale");
  assert.ok(out.plan.spatialFacts.spatialFlags.includes("revision-stale"));
  assert.ok(out.plan.spatialFacts.spatialFlags.includes("capacity-application-stale"));
  const unrecorded = build(base({ designedRailGeometryRevision: undefined }));
  assert.equal(unrecorded.plan.revision.state, "not-recorded");
  assert.ok(codes(unrecorded).includes("revision-not-recorded"));
  // the plan's own revision follows the geometry it is read on
  assert.notEqual(plan(base(), next).servicePlanRevision, plan(base()).servicePlanRevision);
  assert.equal(plan(base(), next).servicePlanId, plan(base()).servicePlanId);
});

test("an application of another line is not used; a plan without a line names no application", () => {
  const out = build(base(), W, { application: { ...W.application, operationalLineId: "line:2" } });
  assert.ok(codes(out).includes("application-other-line-or-geometry"));
  assert.equal(out.plan.capacityApplicationId, null);
  const noLine = build(base({ operationalLineId: undefined }));
  assert.equal(noLine.plan.operationalLineId, null);
  assert.equal(noLine.plan.unknownReasons.operationalLineId, "operational-line-not-stated");
  assert.equal(noLine.plan.unknownReasons.capacityApplicationId, "operational-line-not-stated");
});

// --- rejection ---
test("a plan that cannot be tied to the geometry is rejected with a reason, and another pack's geometry is never read", () => {
  const rejected = (drawn, geometry = W.G) => build(drawn, W, { railGeometry: geometry });
  assert.deepEqual(codes(rejected(base({ railGeometryId: "rail-geometry:other" }))), ["rail-geometry-mismatch"]);
  assert.deepEqual(codes(rejected(base(), { ...W.G, sourcePackId: "other" })), ["rail-geometry-other-pack"]);
  assert.deepEqual(codes(rejected(base(), { ...W.G, schema: "x" })), ["rail-geometry-schema-invalid"]);
  assert.deepEqual(codes(rejected(base({ route: { sectionIds: [W.A0.sectionId, W.A0.sectionId] } }))), ["route-section-duplicate"]);
  assert.deepEqual(codes(rejected(base({ route: { sectionIds: "x" } }))), ["route-sections-invalid"]);
  assert.deepEqual(codes(rejected(base({ key: undefined, route: null }))), ["key-or-sections-required"]);
  assert.equal(rejected(base({ railGeometryId: undefined })).plan, null);
  assert.equal(plan(base({ route: null })).route.sectionIds, null); // a keyed plan may exist before any section is chosen
});

test("a geometry of another pack version only warns", () => {
  const out = build(base(), W, { pack: { ...pack, manifest: { ...pack.manifest, id: "t", version: "2" } } });
  assert.ok(out.plan);
  assert.ok(codes(out).includes("pack-version-mismatch"));
});

// --- export ---
test("the export is sorted by id, keeps a switched-off plan (active: false), and rejects a plan with no geometry or a duplicate", () => {
  const plans = [base({ key: "z" }), base({ key: "a", active: false }), base({ key: "m", railGeometryId: "rail-geometry:none" }), base({ key: undefined }), base({ key: undefined, name: "same sections" })];
  const exp = buildServicePlanExport({ pack: W.pack, railGeometries: [W.G], applications: [W.application], plans });
  assert.equal(exp.schema, SERVICE_PLAN_EXPORT_SCHEMA);
  assert.deepEqual([exp.packId, exp.packVersion], ["t", "1"]);
  assert.equal(exp.plans.length, 3);
  assert.deepEqual(exp.plans.map((p) => p.servicePlanId), [...exp.plans.map((p) => p.servicePlanId)].sort());
  assert.equal(exp.plans.find((p) => p.key === "a").active, false);
  assert.deepEqual(exp.warnings.map((w) => w.code).sort(), ["duplicate-service-plan", "service-plan-rejected"]);
  assert.equal(buildServicePlanExport({ pack: W.pack }).plans.length, 0);
  const reversed = buildServicePlanExport({ pack: W.pack, railGeometries: [W.G], applications: [W.application], plans: [...plans].reverse() });
  assert.deepEqual(reversed.plans.map((p) => p.servicePlanId), exp.plans.map((p) => p.servicePlanId));
});

test("every plan keeps unknown[] and unknownReasons 1:1 with null fields, and no field names a computed result", () => {
  for (const w of [W, makeWorld({ terminals: null, blocks: null }), makeWorld({ terminals: "declared-none" })]) {
    for (const over of [{}, { route: { sectionIds: [w.E1.sectionId, w.E2.sectionId] }, turnbacks: null }, { route: null, directions: null, serviceBands: null }, { route: { sectionIds: [w.A0.sectionId, "gone"] } }]) {
      const p = plan(base(over, w), w);
      assertUnknownContract(p, "plan");
      assert.deepEqual([...keysDeep(p)].filter((k) => !k.includes(":") && FORBIDDEN.test(k)), [], json(over));
    }
  }
});

test("nothing the plan says is a computed result: the only headway is the one the player asked for", () => {
  const keys = new Set(keysDeep(plan(base())));
  assert.deepEqual([...keys].filter((k) => /headway/i.test(k)), ["playerRequestedHeadwayMinutes"]);
  assert.equal([...keys].some((k) => /^(actual|expected|achievable|feasible|capacity(?!Application))/i.test(k)), false);
});

test("frozen input is not changed and the output shares no object with it", () => {
  const drawn = deepFreeze(base());
  const geometry = deepFreeze(structuredClone(W.G));
  const application = deepFreeze(structuredClone(W.application));
  const before = json([drawn, geometry, application]);
  const p = buildServicePlan(drawn, { pack: deepFreeze(structuredClone(W.pack)), railGeometry: geometry, application }).plan;
  assert.equal(json([drawn, geometry, application]), before);
  p.serviceBands[0].playerRequestedHeadwayMinutes = 99;
  p.route.sectionIds.push("x");
  assert.equal(drawn.serviceBands[0].headwayMinutes, 5);
  assert.equal(drawn.route.sectionIds.length, 2);
  assert.equal(buildServicePlanExport({ pack: W.pack, railGeometries: [geometry], applications: [application], plans: deepFreeze([base()]) }).plans.length, 1);
});

// --- the editor ---
test("an editing session: create, choose sections, directions, bands, turnbacks, vehicle; the built plan follows every step and the id never moves", () => {
  const doc = newServicePlanDoc("t", "1");
  const p = addPlan(doc, { name: "Line A", railGeometry: W.G, planKind: "regular", operationalLineId: "line:1" });
  assert.equal(p.key, "plan-1");
  assert.equal(p.designedRailGeometryRevision, W.G.railGeometryRevision);
  const built = () => plan(toDrawnPlan(doc.plans[0]));
  const first = built().servicePlanId;
  assert.equal(built().route.sectionIds, null);
  appendSection(doc, "plan-1", W.A0.sectionId, W.G);
  appendSection(doc, "plan-1", W.A1.sectionId, W.G);
  assert.throws(() => appendSection(doc, "plan-1", W.A1.sectionId, W.G), /once/);
  assert.throws(() => appendSection(doc, "plan-1", "rail-section:made-up", W.G), /Unknown section/);
  const [up, down] = addBothDirections(doc, "plan-1", W.stations.a0, W.stations.a2, ["Up", "Down"]);
  assert.deepEqual([up.key, down.key, down.fromStationId], ["direction-1", "direction-2", W.stations.a2]);
  const band = addBand(doc, "plan-1", { startMinute: 420, endMinute: 540, headwayMinutes: 5, trainsets: 6, formationCars: 8 });
  assert.deepEqual(band.directionKeys, ["direction-1", "direction-2"]); // a band starts on the directions the plan has
  updateBand(doc, "plan-1", band.key, { headwayMinutes: 4, bandId: "evil", key: "band-9" });
  assert.deepEqual([band.key, band.headwayMinutes, "bandId" in band], ["band-1", 4, false]);
  addTurnback(doc, "plan-1", { stationId: W.stations.a2, intent: "route-end" });
  setVehicleIntent(doc, "plan-1", { vehicleModelId: "vehicle-model:x", requestedCars: 8, requestedTrainsets: 6 });
  addAssumption(doc, "plan-1", "Doors open on the left");
  addDepotRef(doc, "plan-1", { depotSiteId: "depot:1", stationId: W.stations.a0, role: "pull-out" });
  const b = built();
  assert.equal(b.servicePlanId, first);
  assert.equal(b.serviceBands[0].playerRequestedHeadwayMinutes, 4);
  assert.equal(b.directions.length, 2);
  assert.equal(b.turnbacks[0].position, "end");
  assert.deepEqual([b.playerInputs.depotRefs[0].stationOnRoute, b.playerInputs.depotRefs[0].role], [true, "pull-out"]);
  // sections: move, reverse, remove — the id stays
  moveSection(doc, "plan-1", 1, 0);
  assert.deepEqual(doc.plans[0].route.sectionIds, [W.A1.sectionId, W.A0.sectionId]);
  reverseRoute(doc, "plan-1");
  assert.deepEqual(doc.plans[0].route.sectionIds, [W.A0.sectionId, W.A1.sectionId]);
  removeSection(doc, "plan-1", W.A1.sectionId);
  assert.equal(built().servicePlanId, first);
  assert.equal(built().route.coversWholeGeometry, false);
  updateDirection(doc, "plan-1", "direction-1", { label: "Outbound" });
  removeDirection(doc, "plan-1", "direction-2");
  removeBand(doc, "plan-1", "band-1");
  removeTurnback(doc, "plan-1", "turnback-1");
  assert.deepEqual([doc.plans[0].serviceBands, doc.plans[0].turnbacks], [[], []]); // removed down to nothing: the player now states "none"
  assert.equal(built().servicePlanId, first);
});

test("a band and a plan switched off keep everything, and come back as they were", () => {
  const doc = newServicePlanDoc("t", "1");
  addPlan(doc, { key: "k", railGeometry: W.G });
  setRoute(doc, "k", { sectionIds: [W.A0.sectionId, W.A1.sectionId] }, W.G);
  const b = addBand(doc, "k", { startMinute: 0, endMinute: 100, headwayMinutes: 10, trainsets: 0 });
  deactivateBand(doc, "k", b.key);
  const off = plan(toDrawnPlan(doc.plans[0])).serviceBands[0];
  assert.deepEqual([off.operating, off.playerRequestedTrainsets, off.playerRequestedHeadwayMinutes], [false, 0, 10]);
  restoreBand(doc, "k", b.key);
  assert.equal(plan(toDrawnPlan(doc.plans[0])).serviceBands[0].operating, true);
  deactivatePlan(doc, "k");
  assert.equal(plan(drawnPlansOf(doc)[0]).active, false);
  assert.equal(activePlans(doc).length, 1);
  restorePlan(doc, "k");
  assert.equal(plan(drawnPlansOf(doc)[0]).active, true);
});

test("a deleted key is never given out again, for plans and for items, also after saving and restoring", () => {
  const doc = newServicePlanDoc("t", "1");
  addPlan(doc, { railGeometry: W.G });
  addPlan(doc, { railGeometry: W.G });
  removePlan(doc, "plan-2");
  assert.equal(nextPlanKey(doc), "plan-3");
  assert.throws(() => addPlan(doc, { key: "plan-2", railGeometry: W.G }), /already used/);
  assert.equal(addPlan(doc, { railGeometry: W.G }).key, "plan-3");
  assert.throws(() => updatePlan(doc, "plan-2", { name: "x" }), /Unknown service plan/);
  assert.equal(drawnPlansOf(doc).length, 2);
  addDirection(doc, "plan-3", { fromStationId: "a", toStationId: "b" });
  removeDirection(doc, "plan-3", "direction-1");
  assert.equal(addDirection(doc, "plan-3", { fromStationId: "a", toStationId: "b" }).key, "direction-2");
  removePlan(doc, "plan-1");
  const again = restoreServicePlanDoc(serializeServicePlanDoc(doc), W.pack).doc;
  assert.equal(nextPlanKey(again), "plan-4");
  assert.throws(() => addPlan(again, { key: "plan-1", railGeometry: W.G }), /already used/);
  assert.equal(addDirection(again, "plan-3", { fromStationId: "a", toStationId: "b" }).key, "direction-3");
});

test("saving and restoring keeps every plan id, every revision and the export byte for byte, a switched-off plan included", () => {
  const doc = newServicePlanDoc("t", "1");
  addPlan(doc, { name: "Line A", railGeometry: W.G, planKind: "regular", operatingPattern: "full", operationalLineId: "line:1" });
  setRoute(doc, "plan-1", { sectionIds: [W.A0.sectionId, W.A1.sectionId] }, W.G);
  addBothDirections(doc, "plan-1", W.stations.a0, W.stations.a2);
  addBand(doc, "plan-1", { startMinute: 420, endMinute: 540, headwayMinutes: 5, trainsets: 0, formationCars: 8 });
  addTurnback(doc, "plan-1", { stationId: W.stations.a0, intent: "route-end", terminalResourceId: W.terminalId("t-a0") });
  declareNone(doc, "plan-1", "depot");
  addPlan(doc, { railGeometry: W.G });
  deactivatePlan(doc, "plan-2");
  const exportOf = (d) => json(buildServicePlanExport({ pack: W.pack, railGeometries: [W.G], applications: [W.application], plans: drawnPlansOf(d) }));
  const text = serializeServicePlanDoc(doc);
  const restored = restoreServicePlanDoc(text, W.pack);
  assert.deepEqual([restored.warnings, restored.rejected], [[], false]);
  assert.equal(serializeServicePlanDoc(restored.doc), text);
  assert.equal(exportOf(restored.doc), exportOf(doc));
  const built = JSON.parse(exportOf(restored.doc)).plans;
  assert.equal(built.length, 2);
  assert.equal(built.find((p) => p.key === "plan-2").active, false);
  assert.deepEqual(built.find((p) => p.key === "plan-1").playerInputs.depotRefs, []);
  assert.equal(restoreServicePlanDoc(null, W.pack).doc.plans.length, 0);
});

test("a saved document of another pack is refused and the document being edited is left as it is", () => {
  const current = newServicePlanDoc("t", "1");
  addPlan(current, { railGeometry: W.G });
  const before = serializeServicePlanDoc(current);
  const other = makeWorld({ packId: "other" });
  const saved = newServicePlanDoc("other", "1");
  addPlan(saved, { railGeometry: other.G });
  const out = restoreServicePlanDoc(serializeServicePlanDoc(saved), W.pack, { current });
  assert.equal(out.rejected, true);
  assert.equal(out.doc, current);
  assert.deepEqual(out.warnings, [{ code: "service-plan-doc-other-pack", savedPackId: "other" }]);
  assert.equal(serializeServicePlanDoc(current), before);
  for (const bad of ["{", JSON.stringify({ version: 2, packId: "t", plans: [] }), JSON.stringify({ version: 1, packId: "t", plans: [{ name: "no key" }] })]) {
    const r = restoreServicePlanDoc(bad, W.pack, { current });
    assert.deepEqual([r.rejected, r.doc === current], [true, true]);
  }
  assert.equal(restoreServicePlanDoc("{", W.pack).doc.plans.length, 0);
});

test("a pack version change is warned about and the plans are kept", () => {
  const doc = newServicePlanDoc("t", "0.9");
  addPlan(doc, { railGeometry: W.G });
  const out = restoreServicePlanDoc(serializeServicePlanDoc(doc), W.pack);
  assert.deepEqual(out.warnings, [{ code: "pack-version-mismatch", saved: "0.9", current: "1" }]);
  assert.deepEqual([out.doc.plans.length, out.rejected], [1, false]);
});

test("an edit never confirms a plan against a newer geometry; only rebindRevision does, and only for the same geometry", () => {
  const doc = newServicePlanDoc("t", "1");
  addPlan(doc, { key: "k", railGeometry: W.G });
  setRoute(doc, "k", { sectionIds: [W.A0.sectionId] }, W.G);
  const next = makeWorld({ extraBoundary: true });
  updatePlan(doc, "k", { name: "edited" });
  addDirection(doc, "k", { fromStationId: W.A0.fromStationId, toStationId: W.A0.toStationId });
  assert.equal(build(toDrawnPlan(doc.plans[0]), next, { application: null }).plan.revision.state, "stale");
  assert.throws(() => rebindRevision(doc, "k", { ...next.G, railGeometryId: "rail-geometry:other" }), /create a new plan/);
  rebindRevision(doc, "k", next.G);
  const after = build(toDrawnPlan(doc.plans[0]), next, { application: null });
  assert.equal(after.plan.revision.state, "current");
  assert.equal(after.plan.servicePlanId, keyedServicePlanId("t", "k"));
  clearRoute(doc, "k");
  clearList(doc, "k", "direction");
  assert.deepEqual([doc.plans[0].route, doc.plans[0].directions], [null, null]);
  assert.throws(() => addItem(doc, "k", "nonsense", {}), /Unknown item type/);
  assert.throws(() => addPlan(doc, { railGeometry: {} }), /rail geometry/);
});

test("the editor only lets the player set their own statements: ids, revisions and keys of items are not fields", () => {
  const doc = newServicePlanDoc("t", "1");
  addPlan(doc, { key: "k", railGeometry: W.G });
  updatePlan(doc, "k", { name: "n", servicePlanId: "evil", key: "other", designedRailGeometryRevision: "x", railGeometryId: "y" });
  assert.deepEqual([doc.plans[0].key, doc.plans[0].railGeometryId === W.G.railGeometryId, doc.plans[0].designedRailGeometryRevision], ["k", true, W.G.railGeometryRevision]);
  const band = addBand(doc, "k", { startMinute: 1, endMinute: 2, bandId: "evil", key: "band-9", operating: true });
  assert.deepEqual([band.key, "bandId" in band, "operating" in band], ["band-1", false, false]);
  const copy = toDrawnPlan(doc.plans[0]);
  assert.deepEqual(["seq" in copy, "deleted" in copy], [false, false]);
  copy.name = "changed";
  assert.equal(doc.plans[0].name, "n");
});

// --- boundaries ---
test("the map modules import no management or engine state, read no clock or randomness and touch no storage or file", () => {
  for (const file of ["service-plan-geometry", "service-plan-editor"]) {
    const text = fs.readFileSync(path.join(engineDir, "src", "map", `${file}.mjs`), "utf8");
    assert.ok(text.length < 40_000, `${file} holds code, not data`);
    for (const m of text.matchAll(/from "([^"]+)"/g)) assert.match(m[1], /^\.\/[a-z-]+\.mjs$/, `${file} imports ${m[1]}`);
    assert.equal(/from\s+["'][^"']*management/.test(text), false, file);
    assert.equal(/from\s+["'][^"']*(scenario-runtime|state|trains|game|passengers|access-demand|rail-capacity-integration)\.mjs/.test(text), false, file);
    assert.equal(/ledger|\.commit\(|\.settle\(|\.post\(|node:fs|Date\.now|new Date|Math\.random|performance\.now|setTimeout|setInterval|localStorage|sessionStorage|indexedDB|crypto\.getRandomValues/.test(text.replace(/\/\/.*$/gm, "")), false, file);
  }
});

test("a stand-in engine state is unchanged after building, editing and exporting", () => {
  const state = deepFreeze({ cash: 1_000_000, ledger: [{ id: 1 }], trains: [{ id: "train:7" }], services: [{ serviceId: "service:1", headwayMinutes: 6 }] });
  const before = json(state);
  const doc = newServicePlanDoc("t", "1");
  addPlan(doc, { key: "k", railGeometry: W.G });
  buildServicePlanExport({ pack: W.pack, railGeometries: [W.G], plans: drawnPlansOf(doc) });
  assert.equal(json(state), before);
});

// --- shipped examples ---
const examplePacks = ["example-radial", "example-corridor", "tokyo"];
const exampleDir = (id) => path.join(root, "packs", id, "service-plan-examples");
const exampleFiles = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".service-plan.json")).sort() : []);
const readExamples = (id) => exampleFiles(exampleDir(id)).map((file) => ({ file, example: JSON.parse(fs.readFileSync(path.join(exampleDir(id), file), "utf8")) }));

test("every shipped example satisfies the contract, is labelled synthetic and keeps its unknowns null", () => {
  let count = 0;
  for (const id of examplePacks) {
    for (const { file, example } of readExamples(id)) {
      count++;
      const { source, ...body } = example;
      assert.equal(body.schema, SERVICE_PLAN_SCHEMA, `${id}/${file}`);
      assert.equal(body.sourcePackId, id);
      assert.equal(source.generatedBy, "scripts/build-service-plan-examples.mjs");
      assert.equal(source.synthetic, true);
      assert.equal(body.servicePlanId, keyedServicePlanId(id, body.key), file);
      assertUnknownContract(body, `${id}/${file}`);
      assert.deepEqual([...keysDeep(body)].filter((k) => !k.includes(":") && FORBIDDEN.test(k)), [], file);
      assert.ok(source.input.savedDocument.plans.some((p) => p.key === body.key), file); // the player's saved document is part of the example
    }
  }
  assert.ok(count >= 10, `${count} examples`);
});

test("the example set covers every required case", () => {
  const all = examplePacks.flatMap((id) => readExamples(id).map((e) => e.example));
  const cases = new Set(all.flatMap((s) => s.source.case));
  for (const c of ["double-track-both-directions", "single-track-meeting-unknown", "short-working", "external-through-service", "terminal-resource-stated", "midway-turnback-no-facility-data", "several-blocks", "almost-no-track-data", "stale-geometry-revision", "inactive-saved-restored"]) assert.ok(cases.has(c), c);
  const caseOf = (c) => all.filter((s) => s.source.case.includes(c));
  assert.ok(caseOf("double-track-both-directions").every((s) => s.directions.length === 2 && s.spatialFacts.sections.every((x) => x.directionMode === "double") && s.turnbacks.some((t) => t.position === "end" || t.position === "start")));
  assert.ok(caseOf("single-track-meeting-unknown").every((s) => s.spatialFacts.sections.some((x) => x.directionMode === "single") && s.spatialFacts.sections.some((x) => x.blockIds === null) && s.spatialFacts.spatialFlags.includes("single-track-section-on-route")));
  assert.ok(caseOf("short-working").every((s) => s.route.coversWholeGeometry === false && s.route.omittedSectionIds.length > 0 && s.playerInputs.operatingPattern !== "full"));
  assert.ok(caseOf("external-through-service").every((s) => s.route.includesExternal === true && s.route.physicallyJoined === null && s.spatialFacts.sections.some((x) => x.lengthMeters === null)));
  assert.ok(caseOf("terminal-resource-stated").every((s) => s.turnbacks.some((t) => t.facilityFacts.terminalResourceKnown === true)));
  assert.ok(caseOf("midway-turnback-no-facility-data").every((s) => s.turnbacks.some((t) => t.position === "middle" && t.facilityFacts.terminalResourceIdsAtStation === null)));
  assert.ok(caseOf("several-blocks").every((s) => s.spatialFacts.sections.some((x) => x.blockIds?.length > 1)));
  assert.ok(caseOf("almost-no-track-data").every((s) => s.spatialFacts.sections.every((x) => x.directionMode === null && x.blockIds === null) && s.unknown.length > 5));
  assert.ok(caseOf("stale-geometry-revision").every((s) => s.revision.state === "stale" && s.warnings.some((w) => w.code === "revision-stale")));
  assert.ok(caseOf("inactive-saved-restored").every((s) => s.active === false && s.source.input.savedDocument.plans.find((p) => p.key === s.key).active === false));
});

test("re-running the generator rewrites every example to the same canonical content", () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "service-plan-examples-"));
  const run = spawnSync(process.execPath, [path.join(root, "scripts", "build-service-plan-examples.mjs"), "--out", out], { cwd: root, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const canonical = (text) => text.replaceAll("\r\n", "\n");
  for (const id of examplePacks) {
    const files = exampleFiles(exampleDir(id));
    assert.deepEqual(exampleFiles(path.join(out, id)), files, id);
    for (const f of files) assert.equal(canonical(fs.readFileSync(path.join(out, id, f), "utf8")), canonical(fs.readFileSync(path.join(exampleDir(id), f), "utf8")), `${id}/${f}`);
  }
  fs.rmSync(out, { recursive: true, force: true });
});
