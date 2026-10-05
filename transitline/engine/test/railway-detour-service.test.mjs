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
import { buildThroughRoute } from "../src/map/through-route.mjs";
import { buildRailwayDisruptionSite, disruptionSiteIdOf } from "../src/map/railway-disruption-site.mjs";
import { buildRailwayServiceControl, controlGeometryIdOf } from "../src/map/railway-service-control.mjs";
import {
  RAILWAY_DETOUR_SERVICE_EXPORT_SCHEMA, RAILWAY_DETOUR_SERVICE_SCHEMA, buildRailwayDetourService, buildRailwayDetourServiceExport, detourGeometryIdOf,
} from "../src/map/railway-detour-service.mjs";
import * as editorModule from "../src/map/railway-detour-service-editor.mjs";
import {
  activePlans, addPlan, clearPicks, deactivatePlan, declareNone, newRailwayDetourDoc, pick, picksOf, reconcilePlan, removeConnection, removeTransferPath, restorePlan,
  restoreRailwayDetourDoc, serializeRailwayDetourDoc, setConnection, setTransferPath, toDetourDocument, unpick,
} from "../src/map/railway-detour-service-editor.mjs";
import {
  CONNECTION_STYLES, STYLES, buildRailwayDetourView, drawRailwayDetourOverlay, renderRailwayDetourLegend, renderRailwayDetourPanel,
} from "../src/map/railway-detour-service-view.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");

// --- fixtures: plans a (a0 a1 a2) and b (a2 b1 b2) along lat 35, an existing line E1 (d1..d3), and three ways to give the section a1-a2 a detour ---
//   "ext":    a loop through the existing line: handovers between differing stations, the existing line has no alignment
//   "apart":  a loop through plan c whose two handovers join stations 100 m apart (measured apart)
//   "joined": plan c drawn between a1 and a2 themselves (shared stations, alignments that meet)
const pack = {
  manifest: { id: "t", version: "1", data: { license: "CC0-1.0", attribution: ["test"] } },
  demand: { points: ["d0", "d1", "d2", "d3", "d4"].map((id, i) => ({ id, name: id, location: [139 + i * 0.01, 35] })) },
  existingNetwork: { lines: [{ name: "E1", operator: "Operator X", osmRelationId: 42, stationIds: ["d1", "d2", "d3"] }] },
};
const EXT = "ext-line:42";
const line = (key, pts, name = key) => ({ key, name, vertices: pts.map((location) => ({ location, platformType: "side" })) });
const revisionsOf = (...plans) => ({ plans: Object.fromEntries(plans.map((p) => [p.planId, planRevisionOf(p)])), routes: {} });
const sectionOf = (g, plan, i) => g.sections.find((s) => s.planId === plan.planId && s.segmentId === plan.segments[i].id);
const trackId = (g, section) => `track-segment:${g.sections.findIndex((s) => s.sectionId === section.sectionId) + 1}`;
const applicationOf = (g, extra = {}) => ({ schema: "transitline.rail-capacity-application/1", contractVersion: 1, operationalLineId: "line:1", railGeometryId: g.railGeometryId, railGeometryRevision: g.railGeometryRevision, sections: g.sections.map((s) => ({ trackSegmentId: trackId(g, s), railCapacitySectionId: s.sectionId })), ...extra });
const eventOf = (id, trackSegmentId, over = {}) => ({
  schema: "transitline.railway-disruption/1", contractVersion: 1, id, kind: "signal-failure", status: "active", lineId: "line:1", trackSegmentId, blockId: null, trainId: null,
  startedAtMinute: 600, expectedEndMinute: 660, resolvedAtMinute: null, resolutionReason: null, severity: "major", effect: { closed: true, speedLimitMps: 0 }, infrastructureOwnerId: null, operatorId: null, responsibility: "unknown", source: "simulation", ...over,
});

function makeWorld({ mode = "ext", names = ["a", "b"], reverse = false } = {}) {
  // the plans run 55 m north of the existing line's stations, so that no two stations share a position
  const Y = 35.0005;
  const drawn = [line("a", [[139, Y], [139.01, Y], [139.02, Y]], names[0]), line("b", [[139.02, Y], [139.03, Y], [139.04, Y]], names[1])];
  if (mode === "joined") drawn.push(line("c", [[139.01, Y], [139.015, Y + 0.003], [139.02, Y]]));
  if (mode === "apart") drawn.push(line("c", [[139.011, Y + 0.001], [139.019, Y + 0.001]]));
  const map = buildMapExport({ pack, mode: "existing", drawnLines: reverse ? [...drawn].reverse() : drawn });
  const plan = (k) => map.plans.find((p) => p.planId === stableId("plan", "t", "key", k));
  const [A, B, C] = [plan("a"), plan("b"), mode === "joined" || mode === "apart" ? plan("c") : null];
  let route = null;
  const legs = mode === "ext" ? [
    { sourceKind: "planned", key: "l1", planId: A.planId, fromStationId: A.segments[0].from, toStationId: A.segments[0].to, infrastructureOwnerId: "owner:player" },
    { sourceKind: "external", key: "l2", externalLineId: EXT, fromStationId: "d1", toStationId: "d3", infrastructureOwnerId: "owner:other" },
    { sourceKind: "planned", key: "l3", planId: B.planId, infrastructureOwnerId: "owner:player" },
  ] : mode === "apart" ? [
    { sourceKind: "planned", key: "l1", planId: A.planId, fromStationId: A.segments[0].from, toStationId: A.segments[0].to, infrastructureOwnerId: "owner:player" },
    { sourceKind: "planned", key: "l2", planId: C.planId, infrastructureOwnerId: "owner:other" },
    { sourceKind: "planned", key: "l3", planId: B.planId, infrastructureOwnerId: "owner:player" },
  ] : null;
  if (legs) {
    const out = buildThroughRoute({ key: "r", legs }, { pack, plans: map.plans, externalNetworks: map.externalNetworks });
    assert.ok(out.route, JSON.stringify(out.warnings));
    route = out.route;
  }
  const planIds = [A.planId, B.planId, ...(C ? [C.planId] : [])];
  const G = buildRailGeometry({
    key: "g", planIds, externalLineIds: mode === "ext" ? [EXT] : [], ...(route ? { throughRouteId: route.throughRouteId } : {}),
    designedRevisions: { ...revisionsOf(A, B, ...(C ? [C] : [])), routes: route ? { [route.throughRouteId]: route.geometryRevision } : {} },
    sectionFacts: [{ ref: { planId: A.planId, segmentId: A.segments[1].id }, directionMode: "single", basis: "player" }],
  }, { pack, plans: map.plans, externalNetworks: map.externalNetworks, routes: route ? [route] : [] }).design;
  assert.ok(G);
  return { mode, map, A, B, C, route, G, APP: applicationOf(G), A1: sectionOf(G, A, 1), a0: A.segments[0].from, a1: A.segments[0].to, a2: A.segments[1].to, EXT_SECTION: G.sections.find((s) => s.sourceKind === "external") };
}
const WORLDS = { ext: makeWorld({ mode: "ext" }), apart: makeWorld({ mode: "apart" }), joined: makeWorld({ mode: "joined" }) };
const W = WORLDS.ext;

function stateOf(world, n = 1, section = world.A1) {
  const event = eventOf(`railway-disruption:${n}`, trackId(world.G, section));
  const site = buildRailwayDisruptionSite({ eventId: event.id, designedRailGeometryRevision: world.G.railGeometryRevision }, { pack, events: [event], railGeometry: world.G, applications: [world.APP] }).site;
  assert.ok(site);
  const out = buildRailwayServiceControl({ eventId: event.id }, { pack, site, railGeometry: world.G, application: world.APP, routes: world.route ? [world.route] : [], externalNetworks: world.map.externalNetworks });
  assert.ok(out.control, JSON.stringify(out.warnings));
  return { site, control: out.control };
}
const STATES = { ext: stateOf(W), apart: stateOf(WORLDS.apart), joined: stateOf(WORLDS.joined) };
const candidateOf = (state) => state.control.detourCandidates[0];
const CATALOG = { schema: "transitline.external-infrastructure-catalog/1", packId: "t", packVersion: "1", entries: [{
  legId: "through-leg:x", throughRouteId: "through-route:x", routeGeometryRevision: "r", externalNetworkId: W.map.externalNetworks[0].id, externalLineId: EXT, specificationId: "external-rail-spec:42", specificationRevision: "external-rail-spec-revision:1",
  infrastructureOwnerId: "owner:catalog", technicalProfileId: "profile:x", technicalSpecification: { gaugeMm: 1067, voltageV: 1500 }, notApplicable: [], status: "in-service", capacityTrainsPerHour: 12, unknown: [], unknownReasons: {},
}], unmatchedLegIds: [], warnings: [] };
const SITE_A1 = { connectedStationId: W.a1, stationSiteId: "stn-site:a1", planHints: { platformType: "island" }, entranceCandidates: [{ entranceId: "ent:n", name: "North", location: [139.0101, 35.0003] }, { entranceId: "ent:s", name: "South", location: [139.0099, 34.9997] }] };
const SITE_A2 = { connectedStationId: W.a2, stationSiteId: "stn-site:a2", planHints: { platformType: null }, entranceCandidates: [{ entranceId: "ent:w", location: [139.0199, 35.0002] }] };

function ctxFor(world, { site, control }, extra = {}) {
  return { pack, site, control, railGeometry: world.G, application: world.APP, routes: world.route ? [world.route] : [], externalNetworks: [], ...extra };
}
const docFor = (state, over = {}) => ({ eventId: state.site.eventId, detourCandidateId: candidateOf(state).candidateId, ...over });
function build(over = {}, { world = W, state = STATES[world.mode], ctx = {} } = {}) {
  const out = buildRailwayDetourService(docFor(state, over), ctxFor(world, state, ctx));
  assert.ok(out.detour, JSON.stringify(out.warnings));
  return out.detour;
}
const rejected = (document, code, { world = W, state = STATES[world.mode], ctx = {} } = {}) => {
  const out = buildRailwayDetourService(document, ctxFor(world, state, ctx));
  assert.equal(out.detour, null);
  assert.equal(out.warnings[0].code, code);
  return out.warnings[0];
};
const keysDeep = (value, found = new Set()) => {
  if (Array.isArray(value)) value.forEach((v) => keysDeep(v, found));
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) { found.add(k); keysDeep(v, found); }
  return found;
};
// no verdict, technical-compatibility, capacity, headway, train, charge, compensation, revenue, demand, reputation, time, delay or contract field
// (infrastructureOwner* is the owner the source stated, railGeometry* / railCapacity* name the rail contracts, contractVersion is the schema version)
const FORBIDDEN = /cost|price|\bfee|charge|cash|probab|verdict|feasib|possib|approval|score|delay|duration|recover|runningTime|travelTime|minutes|(?<!rail)capacity|throughput|headway|timetable|trainsPerHour|trainCount|fleet|demand|passenger|loss|compensat|refund|revenue|reputation|contract(?!Version)|severity|responsib|rank|recommend|\bbest|compatib|gauge|voltage|(?<!infrastructure)owner|operator|technical(?!Spec)/i;
const fieldNames = (value) => [...keysDeep(value)].filter((k) => !k.includes(":"));
const deepFreeze = (o) => { if (o && typeof o === "object") { Object.values(o).forEach(deepFreeze); Object.freeze(o); } return o; };
function assertUnknownContract(value, where = "detour") {
  if (Array.isArray(value)) return value.forEach((v, i) => assertUnknownContract(v, `${where}[${i}]`));
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value.unknown) && value.unknownReasons && typeof value.unknownReasons === "object") {
    assert.deepEqual([...value.unknown].sort(), Object.keys(value.unknownReasons).sort(), `${where}: unknown and unknownReasons are 1:1`);
    for (const f of value.unknown) {
      if (!f.includes(":")) assert.ok(value[f] === null || value[f] === undefined, `${where}.${f} is unknown so it must be null`);
      assert.equal(typeof value.unknownReasons[f], "string", `${where}.${f} has a reason`);
    }
  }
  for (const [k, v] of Object.entries(value)) if (k !== "unknown" && k !== "unknownReasons" && k !== "warnings") assertUnknownContract(v, `${where}.${k}`);
}
const linkOf = (d) => d.connections.filter((c) => c.kind === "handover-link");

// --- identity ---
test("same input gives the same detourGeometryId and byte-identical JSON, tied to the site, control, rail geometry and the chosen detour", () => {
  const a = build();
  const b = build();
  assert.equal(JSON.stringify(a), JSON.stringify(structuredClone(b)));
  assert.equal(a.schema, RAILWAY_DETOUR_SERVICE_SCHEMA);
  assert.equal(a.contractVersion, 1);
  const { site, control } = STATES.ext;
  assert.equal(a.detourGeometryId, detourGeometryIdOf("t", site.eventId, candidateOf(STATES.ext).candidateId));
  assert.deepEqual([a.eventId, a.disruptionSiteId, a.disruptionSiteRevision, a.controlGeometryId, a.controlGeometryRevision, a.railGeometryId, a.railGeometryRevision, a.selectedDetourCandidateId, a.sourcePackId, a.sourcePackVersion],
    [site.eventId, site.disruptionSiteId, site.siteRevision, control.controlGeometryId, control.controlGeometryRevision, W.G.railGeometryId, W.G.railGeometryRevision, candidateOf(STATES.ext).candidateId, "t", "1"]);
  for (const f of ["detourGeometryRevision", "throughRouteId", "originalBoundaryStationIds", "affectedSectionIds", "affectedTrackSegmentIds", "legs", "connections", "stations", "transferLinks", "playerConnections", "playerTransferPaths", "physicalConnection", "infrastructureOwnerIds", "spatialFlags", "dataQuality", "unknown", "unknownReasons", "sourceLayers", "license"]) assert.ok(f in a, f);
  assert.deepEqual(a.originalBoundaryStationIds, [candidateOf(STATES.ext).startStationId, candidateOf(STATES.ext).endStationId]);
  assert.deepEqual(a.affectedSectionIds, [W.A1.sectionId]);
});

test("the id follows the event, the pack and the chosen detour; a player drawing changes the revision, never the id", () => {
  const plain = build();
  const drawn = build({ connections: [{ key: "c", polyline: [[139.01, 35], [139.0, 35]] }] });
  assert.equal(drawn.detourGeometryId, plain.detourGeometryId);
  assert.notEqual(drawn.detourGeometryRevision, plain.detourGeometryRevision);
  assert.notEqual(detourGeometryIdOf("other", plain.eventId, plain.selectedDetourCandidateId), plain.detourGeometryId);
  assert.notEqual(detourGeometryIdOf("t", "railway-disruption:2", plain.selectedDetourCandidateId), plain.detourGeometryId);
  assert.equal(JSON.stringify(build({ connections: [{ polyline: [[139.01, 35], [139.0, 35]], key: "c", name: "other name" }] }).detourGeometryId), JSON.stringify(plain.detourGeometryId));
});

test("array order, a line drawn the other way round, every name and a renamed, redrawn plan leave ids and bytes unchanged", () => {
  const lines = [{ key: "one", polyline: [[139.0095, 35.0001], [139.0105, 35.0001]] }, { key: "two", polyline: [[139.0195, 35.0001], [139.0205, 35.0001]] }];
  const forward = build({ connections: lines });
  const flipped = build({ connections: [...lines].reverse().map((l) => ({ ...l, polyline: [...l.polyline].reverse(), name: "Renamed" })) });
  assert.deepEqual(forward.playerConnections.map((c) => c.playerConnectionId), flipped.playerConnections.map((c) => c.playerConnectionId));
  assert.deepEqual(forward.playerConnections.map((c) => c.polyline), flipped.playerConnections.map((c) => c.polyline), "turned to run from the origin boundary station");
  const a = build({ connections: [{ polyline: [[139.0095, 35.0001], [139.0105, 35.0001]] }] });
  const b = build({ connections: [{ polyline: [[139.0105, 35.0001], [139.0095, 35.0001]] }] });
  assert.equal(a.playerConnections[0].playerConnectionId, b.playerConnections[0].playerConnectionId, "without a key the id follows the drawing, not its direction");
  const renamed = makeWorld({ mode: "ext", names: ["Zeta", "Alpha"], reverse: true });
  const renamedState = stateOf(renamed);
  const other = buildRailwayDetourService(docFor(renamedState), ctxFor(renamed, renamedState)).detour;
  assert.equal(other.detourGeometryId, build().detourGeometryId);
  assert.deepEqual(other.legs.map((l) => l.legId), build().legs.map((l) => l.legId));
  assert.deepEqual(other.connections.map((c) => c.connectionId), build().connections.map((c) => c.connectionId));
  const s = STATES.ext;
  const args = { pack, sites: [s.site], controls: [s.control], railGeometries: [W.G], applications: [W.APP], routes: [W.route] };
  const d1 = docFor(s);
  const d2 = docFor(s, { connections: lines });
  assert.equal(JSON.stringify(buildRailwayDetourServiceExport({ ...args, documents: [d1, d2] })), JSON.stringify(buildRailwayDetourServiceExport({ ...args, documents: [d2, d1] })));
});

test("the inputs are never mutated (frozen site, control, geometry, application, route, catalog, station sites, document)", () => {
  const document = deepFreeze(docFor(STATES.ext, { connections: [{ key: "c", polyline: [[139.0095, 35.0001], [139.0105, 35.0001]] }], transferPaths: [{ key: "t", polyline: [[139.0101, 35.0003], [139.0102, 35.0004]] }] }));
  const frozen = {
    site: deepFreeze(structuredClone(STATES.ext.site)), control: deepFreeze(structuredClone(STATES.ext.control)), railGeometry: deepFreeze(structuredClone(W.G)), application: deepFreeze(structuredClone(W.APP)),
    routes: deepFreeze([structuredClone(W.route)]), externalCatalog: deepFreeze(structuredClone(CATALOG)), stationSites: deepFreeze([structuredClone(SITE_A1), structuredClone(SITE_A2)]), externalNetworks: deepFreeze(structuredClone(W.map.externalNetworks)), pack: deepFreeze(structuredClone(pack)),
  };
  const before = JSON.stringify([document, frozen]);
  const out = buildRailwayDetourService(document, frozen);
  assert.ok(out.detour);
  assert.equal(JSON.stringify([document, frozen]), before);
  const exp = buildRailwayDetourServiceExport({ pack: frozen.pack, sites: [frozen.site], controls: [frozen.control], railGeometries: [frozen.railGeometry], applications: [frozen.application], routes: frozen.routes, externalCatalog: frozen.externalCatalog, stationSites: frozen.stationSites, documents: [document] });
  assert.equal(exp.detours.length, 1);
  assert.equal(buildRailwayDetourView({ exportData: deepFreeze(exp) }).detours.length, 1);
});

// --- stale and wrong links ---
test("a site, control geometry or rail geometry of another revision, an older selection and every wrong link are rejected", () => {
  const s = STATES.ext;
  rejected({}, "event-missing");
  rejected({ eventId: s.site.eventId }, "detour-candidate-missing");
  rejected(docFor(s), "site-schema-invalid", { state: { ...s, site: { ...s.site, schema: "other/1" } } });
  rejected(docFor(s), "control-schema-invalid", { state: { ...s, control: { ...s.control, schema: "other/1" } } });
  rejected(docFor(s), "site-other-pack", { state: { ...s, site: { ...s.site, sourcePackId: "elsewhere" } } });
  rejected(docFor(s), "control-other-pack", { state: { ...s, control: { ...s.control, sourcePackId: "elsewhere" } } });
  rejected({ ...docFor(s), eventId: "railway-disruption:99" }, "document-event-mismatch");
  rejected(docFor(s), "control-site-mismatch", { state: { ...s, control: { ...s.control, disruptionSiteId: "railway-disruption-site:other" } } });
  rejected(docFor(s), "control-site-revision-mismatch", { state: { ...s, site: { ...s.site, siteRevision: "railway-disruption-site-revision:new" } } });
  rejected(docFor(s), "control-site-revision-mismatch", { state: { ...s, control: { ...s.control, disruptionSiteRevision: "railway-disruption-site-revision:old" } } });
  rejected(docFor(s), "control-rail-geometry-revision-mismatch", { state: { ...s, control: { ...s.control, railGeometryRevision: "rail-geometry-revision:old" } } });
  rejected(docFor(s, { selectedOnControlGeometryRevision: "railway-service-control-revision:old" }), "selection-revision-mismatch");
  rejected(docFor(s), "rail-geometry-schema-invalid", { ctx: { railGeometry: { ...W.G, schema: "other/1" } } });
  rejected(docFor(s), "rail-geometry-other-pack", { ctx: { railGeometry: { ...W.G, sourcePackId: "elsewhere" } } });
  rejected(docFor(s), "rail-geometry-mismatch", { ctx: { railGeometry: { ...W.G, railGeometryId: "rail-geometry:other" } } });
  rejected(docFor(s), "rail-geometry-revision-mismatch", { ctx: { railGeometry: { ...W.G, railGeometryRevision: "rail-geometry-revision:new" } } });
  rejected(docFor(s), "detour-section-missing", { ctx: { railGeometry: { ...W.G, sections: W.G.sections.filter((x) => x.sectionId !== candidateOf(s).sectionIds[0]) } } });
  assert.equal(build({ selectedOnControlGeometryRevision: s.control.controlGeometryRevision }).controlGeometryRevision, s.control.controlGeometryRevision);
});

test("the chosen detour must be one the current control geometry offers; an event with no map position offers none", () => {
  rejected({ eventId: STATES.ext.site.eventId, detourCandidateId: "railway-control-detour:made-up" }, "detour-not-offered");
  rejected({ eventId: STATES.ext.site.eventId, detourCandidateId: STATES.ext.control.partialSuspensionCandidates[0].candidateId }, "detour-not-offered");
  const trainEvent = eventOf("railway-disruption:7", null, { kind: "vehicle-failure", trainId: "train:7" });
  const site = buildRailwayDisruptionSite({ eventId: trainEvent.id }, { pack, events: [trainEvent], railGeometry: W.G, applications: [W.APP] }).site;
  const control = buildRailwayServiceControl({ eventId: trainEvent.id }, { pack, site, railGeometry: W.G, application: W.APP }).control;
  assert.equal(control.detourCandidates, null);
  rejected({ eventId: trainEvent.id, detourCandidateId: candidateOf(STATES.ext).candidateId }, "detour-not-offered", { state: { site, control } });
});

// --- the legs ---
test("legs follow the detour in order, each tied to the map section, the operational track, its plan or existing line, with a connected chain of stations", () => {
  const d = build();
  const c = candidateOf(STATES.ext);
  assert.deepEqual(d.legs.map((l) => l.sectionId), c.sectionIds);
  assert.deepEqual(d.legs.map((l) => l.sequenceIndex), [0, 1]);
  assert.equal(d.connections.length, d.legs.length + 1);
  for (let i = 1; i < d.legs.length; i++) assert.equal(d.legs[i].fromStationId, d.legs[i - 1].toStationId, "a shared station joins consecutive legs");
  assert.ok(d.legs.every((l) => l.basis === "source" && l.sourceKind === "external" && l.externalLineId === EXT && l.externalNetworkId === W.map.externalNetworks[0].id));
  assert.ok(d.legs.every((l) => l.trackSegmentId === trackId(W.G, W.G.sections.find((s) => s.sectionId === l.sectionId))));
  assert.deepEqual(d.legs.map((l) => l.trackSegmentIds.length), [1, 1]);
  assert.deepEqual(d.legs.map((l) => l.throughLegId), [W.route.legs[1].legId, W.route.legs[1].legId]);
  assert.deepEqual(d.stations.map((s) => s.stationId).filter((id) => ["d1", "d2", "d3"].includes(id)), ["d1", "d2", "d3"].filter((id) => d.legs.some((l) => [l.fromStationId, l.toStationId].includes(id))));
  const ids = new Set(W.G.sections.map((s) => s.sectionId));
  assert.ok(d.legs.every((l) => ids.has(l.sectionId)));
  assert.equal(new Set(d.legs.map((l) => l.legId)).size, 2);
  const planLeg = build({}, { world: WORLDS.joined }).legs[0];
  assert.equal(planLeg.sourceKind, "plan");
  assert.equal(planLeg.planId !== null && planLeg.segmentId !== null, true);
});

test("the operational track segment comes through the application only; a stale or missing one is null with the reason, several are not guessed", () => {
  assert.deepEqual(build({}, { ctx: { application: null } }).legs.map((l) => [l.trackSegmentId, l.trackSegmentIds, l.unknownReasons.trackSegmentId]), [[null, null, "no-application"], [null, null, "no-application"]]);
  const stale = buildRailwayDetourService(docFor(STATES.ext), ctxFor(W, STATES.ext, { application: { ...W.APP, railGeometryRevision: "rail-geometry-revision:old" } }));
  assert.deepEqual(stale.warnings.map((w) => w.code), ["application-stale"]);
  assert.ok(stale.detour.legs.every((l) => l.trackSegmentId === null && l.unknownReasons.trackSegmentId === "application-stale"));
  const first = candidateOf(STATES.ext).sectionIds[0];
  const two = build({}, { ctx: { application: { ...W.APP, sections: [...W.APP.sections, { trackSegmentId: "track-segment:extra", railCapacitySectionId: first }] } } });
  assert.equal(two.legs[0].trackSegmentId, null);
  assert.equal(two.legs[0].unknownReasons.trackSegmentId, "several-track-segments-for-section");
  assert.equal(two.legs[0].trackSegmentIds.length, 2);
  const missing = build({}, { ctx: { application: { ...W.APP, sections: W.APP.sections.filter((s) => s.railCapacitySectionId !== first) } } });
  assert.deepEqual([missing.legs[0].trackSegmentIds, missing.legs[0].unknownReasons.trackSegmentId], [[], "section-not-in-application"]);
  assert.ok(build().spatialFlags.includes("existing-line-leg"));
  assert.equal(build().spatialFlags.includes("operational-track-unmapped"), false);
});

test("an existing line has no alignment: alignment and length are null with the reason; a drawn plan leg has both", () => {
  const ext = build();
  assert.ok(ext.legs.every((l) => l.alignment === null && l.lengthMeters === null && l.unknownReasons.alignment === "external-alignment-not-in-source" && l.unknownReasons.lengthMeters === "external-alignment-not-in-source"));
  assert.equal(ext.alignment, null);
  assert.equal(ext.lengthMeters, null);
  assert.equal(ext.unknownReasons.lengthMeters, "external-alignment-not-in-source");
  assert.ok(ext.spatialFlags.includes("external-alignment-unknown"));
  const joined = build({}, { world: WORLDS.joined });
  assert.ok(joined.legs.every((l) => Array.isArray(l.alignment) && l.alignment.length >= 2 && l.lengthMeters > 0));
  assert.equal(joined.lengthMeters, Math.round(joined.legs.reduce((a, l) => a + l.lengthMeters, 0) * 10) / 10);
  assert.ok(Array.isArray(joined.alignment));
  assert.deepEqual(joined.legs[0].alignment[0], WORLDS.joined.G.sections.find((s) => s.sectionId === joined.legs[0].sectionId).alignment[joined.legs[0].fromStationId === WORLDS.joined.G.sections.find((s) => s.sectionId === joined.legs[0].sectionId).fromStationId ? 0 : WORLDS.joined.G.sections.find((s) => s.sectionId === joined.legs[0].sectionId).alignment.length - 1]);
});

test("a leg's spatial constraints are the section's own facts, null for an existing line", () => {
  const joined = build({}, { world: WORLDS.joined });
  assert.ok(joined.legs.every((l) => l.spatialConstraints !== null && "minimumCurveRadiusMeters" in l.spatialConstraints && "buildingIntersectionCount" in l.spatialConstraints));
  assert.ok(Object.values(build().legs[0].spatialConstraints).every((v) => v === null));
  assert.equal(build({}, { ctx: { railGeometry: null } }).legs[0].spatialConstraints, null);
});

// --- owners and identification ---
test("the owner is only what the through route, the catalog or the network's own line data stated; an operator tag is never an owner", () => {
  const withRoute = build();
  assert.ok(withRoute.legs.every((l) => l.infrastructureOwnerId === "owner:other" && l.infrastructureOwnerBasis === "through-route"));
  assert.deepEqual(withRoute.infrastructureOwnerIds, ["owner:other"]);
  const none = build({}, { ctx: { routes: [] } });
  assert.ok(none.legs.every((l) => l.infrastructureOwnerId === null && l.unknownReasons.infrastructureOwnerId === "owner-not-in-source-data"));
  assert.equal(none.infrastructureOwnerIds, null);
  assert.equal(none.unknownReasons.infrastructureOwnerIds, "owner-not-in-source-data");
  assert.ok(none.spatialFlags.includes("infrastructure-owner-unknown"));
  assert.equal(JSON.stringify(none).includes("Operator X"), false, "the pack's operator tag is never read as an owner");
  const catalog = build({}, { ctx: { routes: [], externalCatalog: CATALOG } });
  assert.ok(catalog.legs.every((l) => l.infrastructureOwnerId === "owner:catalog" && l.infrastructureOwnerBasis === "external-catalog"));
  const network = build({}, { ctx: { routes: [], externalNetworks: [{ ...W.map.externalNetworks[0], lines: W.map.externalNetworks[0].lines.map((l) => ({ ...l, infrastructureOwnerId: "owner:network" })) }] } });
  assert.ok(network.legs.every((l) => l.infrastructureOwnerBasis === "external-network" && l.infrastructureOwnerId === "owner:network"));
  const conflict = buildRailwayDetourService(docFor(STATES.ext), ctxFor(W, STATES.ext, { externalCatalog: CATALOG }));
  assert.ok(conflict.detour.legs.every((l) => l.infrastructureOwnerId === null && l.unknownReasons.infrastructureOwnerId === "owner-sources-disagree"));
  assert.ok(conflict.warnings.some((w) => w.code === "leg-owner-sources-disagree"));
});

test("the catalog is used for identification only: ids and revisions of the specification, none of its technical facts", () => {
  const d = build({}, { ctx: { externalCatalog: CATALOG, routes: [W.route] } });
  assert.ok(d.legs.every((l) => l.externalSpecificationId === "external-rail-spec:42" && l.externalSpecificationRevision === "external-rail-spec-revision:1"));
  const text = JSON.stringify(d);
  for (const word of ["gaugeMm", "voltageV", "technicalSpecification", "capacityTrainsPerHour", "in-service", "profile:x", "technicalProfileId"]) assert.equal(text.includes(word), false, word);
  const without = build();
  assert.ok(without.legs.every((l) => l.externalSpecificationId === null && l.unknownReasons.externalSpecificationId === "no-catalog"));
  assert.ok(without.spatialFlags.includes("existing-line-not-in-catalog"));
  const elsewhere = buildRailwayDetourService(docFor(STATES.ext), ctxFor(W, STATES.ext, { externalCatalog: { ...CATALOG, packId: "elsewhere" } }));
  assert.deepEqual(elsewhere.warnings.map((w) => w.code), ["catalog-ignored"]);
  const unlisted = build({}, { ctx: { externalCatalog: { ...CATALOG, entries: [] } } });
  assert.ok(unlisted.legs.every((l) => l.unknownReasons.externalSpecificationId === "line-not-in-catalog"));
});

// --- connections: true, false, null ---
test("a join between measured alignments is true with its measured gap; the evidence says how it was found", () => {
  const d = build({}, { world: WORLDS.joined });
  assert.ok(d.connections.every((c) => c.kind === "shared-station" && c.physicalConnection === true && c.gapMeters === 0 && c.evidence === "measured-alignments" && c.basis === "source"));
  assert.equal(d.physicalConnection, true);
  assert.ok(d.spatialFlags.includes("all-connections-measured-joined"));
  assert.deepEqual(d.connections.map((c) => [c.fromSectionId, c.toSectionId]), d.connections.map((c, i) => [c.fromSectionId, c.toSectionId]));
  assert.equal(d.connections[0].fromSectionId, WORLDS.joined.A1.sectionId, "the first joint is where the affected section meets the detour");
  assert.equal(d.connections.at(-1).toSectionId, WORLDS.joined.A1.sectionId);
  assert.ok(d.connections.every((c) => Array.isArray(c.location) && c.viaLocations === null));
  assert.equal(d.handoverIds, null);
  assert.equal(d.unknownReasons.handoverIds, "no-through-route");
});

test("a handover between stations measured apart is false with the gap the route recorded; the whole detour is then false", () => {
  const d = build({}, { world: WORLDS.apart });
  const links = linkOf(d);
  assert.equal(links.length, 2);
  assert.ok(links.every((c) => c.physicalConnection === false && c.gapMeters > 50 && c.evidence === "through-route-handover" && c.handoverId !== null && c.stationId === null && c.viaStationIds.length === 2));
  assert.equal(d.physicalConnection, false);
  assert.ok(d.spatialFlags.includes("connection-measured-apart") && d.spatialFlags.includes("handover-between-different-stations"));
  assert.deepEqual(d.handoverIds, WORLDS.apart.route.handovers.map((h) => h.handoverId).sort());
  assert.ok(links.every((c) => c.unknown.includes("junctionResourceIds") === false || c.junctionResourceIds === null));
  assert.deepEqual(d.infrastructureOwnerIds, ["owner:other"]);
});

test("an existing line's connection is null, never true, whatever the stations say: no alignment, no recorded topology", () => {
  const d = build();
  assert.equal(d.physicalConnection, null);
  assert.equal(d.unknownReasons.physicalConnection, "external-topology-not-in-source");
  assert.ok(d.connections.every((c) => c.physicalConnection === null && c.gapMeters === null && c.evidence === "no-measurement"));
  assert.ok(d.connections.every((c) => c.unknownReasons.physicalConnection === "external-topology-not-in-source" && /external-/.test(c.unknownReasons.gapMeters)));
  assert.equal(d.spatialFlags.includes("all-connections-measured-joined"), false);
  assert.ok(d.spatialFlags.includes("connection-unmeasured"));
  assert.ok(linkOf(d).every((c) => c.handoverId !== null && c.location === null && c.viaLocations.length === 2));
});

test("without the through route a link has no handover, no gap and no connection: all null with the reason", () => {
  const d = build({}, { ctx: { routes: [] } });
  assert.ok(linkOf(d).every((c) => c.physicalConnection === null && c.gapMeters === null && c.evidence === "no-measurement"), "no route: no handover facts to read the gap from");
  assert.ok(d.spatialFlags.includes("through-route-not-supplied"));
  assert.equal(d.throughRouteId, null);
  const stale = buildRailwayDetourService(docFor(STATES.ext), ctxFor(W, STATES.ext, { routes: [{ ...W.route, geometryRevision: "through-route-revision:old" }] }));
  assert.deepEqual(stale.warnings.map((w) => w.code), ["through-route-stale"]);
  assert.equal(stale.detour.throughRouteId, null);
});

// --- stations, transfers ---
test("stations carry where they are, whether they belong to an existing line, entrances and platform type from a station site, and null with the reason where there is none", () => {
  const d = build({}, { ctx: { stationSites: [SITE_A1, SITE_A2] } });
  const a1 = d.stations.find((s) => s.stationId === W.a1);
  assert.deepEqual(a1.entrances.map((e) => e.entranceId), ["ent:n", "ent:s"]);
  assert.equal(a1.platformType, "island");
  assert.equal(a1.stationSiteId, "stn-site:a1");
  assert.equal(a1.external, false);
  const a2 = d.stations.find((s) => s.stationId === W.a2);
  assert.equal(a2.platformType, null);
  assert.equal(a2.unknownReasons.platformType, "platform-detail-not-in-source");
  const ext = d.stations.find((s) => s.stationId === "d1");
  assert.deepEqual([ext.external, ext.entrances, ext.platformType, ext.unknownReasons.entrances, ext.unknownReasons.platformType], [true, null, null, "external-station-detail-not-in-source", "external-station-detail-not-in-source"]);
  assert.ok(d.stations.every((s) => Array.isArray(s.location)), "station-level positions of an existing line are known");
  assert.deepEqual(d.stations.filter((s) => s.role !== "detour-via").map((s) => s.role).sort(), ["destination-boundary", "origin-boundary"]);
  assert.ok(d.stations.filter((s) => s.handoverEndpoint).length >= 4);
  assert.ok(d.spatialFlags.includes("entrance-data-missing") && d.spatialFlags.includes("platform-detail-missing"));
  const joined = build({}, { world: WORLDS.joined });
  assert.ok(joined.stations.every((s) => s.entrances === null && s.unknownReasons.entrances === "no-station-site"));
});

test("transfer links are straight distances between the two stations a handover joins; there is no walking network and no walking path", () => {
  const d = build({}, { ctx: { stationSites: [SITE_A1, SITE_A2] } });
  assert.equal(d.transferLinks.length, 2);
  for (const t of d.transferLinks) {
    assert.equal(t.basis, "source");
    assert.ok(t.straightDistanceMeters > 0);
    assert.ok(!("walkPath" in t) && !("alignment" in t) && !("walkingDistanceMeters" in t));
    assert.ok(linkOf(d).some((c) => c.connectionId === t.connectionId && c.handoverId === t.handoverId));
  }
  assert.equal(d.walkNetwork, null);
  assert.equal(d.unknownReasons.walkNetwork, "walk-network-not-in-source");
  const withPairs = d.transferLinks.find((t) => [t.fromStationId, t.toStationId].includes(W.a1));
  assert.equal(withPairs.entrancePairs, null, "the existing-line side has no entrances");
  assert.equal(withPairs.unknownReasons.entrancePairs, "entrance-data-missing");
  const none = build({}, { world: WORLDS.joined });
  assert.deepEqual(none.transferLinks, [], "joints at shared stations are not transfer links");
  const apart = build({}, { world: WORLDS.apart, ctx: { stationSites: [SITE_A1, SITE_A2] } });
  assert.equal(apart.transferLinks.length, 2);
  assert.ok(apart.transferLinks.every((t) => t.straightDistanceMeters > 50 && t.straightDistanceMeters < 300));
});

test("an interchange is a station where the detour changes from one plan or line to another", () => {
  const joined = build({}, { world: WORLDS.joined });
  assert.ok(joined.stations.some((s) => s.isInterchange), "the bypass plan meets the main plan at a1 and a2");
  assert.equal(build().stations.filter((s) => s.isInterchange).length >= 0, true);
  assert.ok(build({}, { world: WORLDS.joined }).stations.every((s) => typeof s.isInterchange === "boolean"));
});

// --- the player's drawings ---
test("a player connection line is kept as the player's and never turns a null or false connection into true", () => {
  const link = linkOf(build()).find((c) => c.viaLocations[0][0] !== c.viaLocations[1][0]);
  const [a, b] = link.viaLocations;
  const d = build({ connections: [{ key: "drawn", name: "Drawn link", polyline: [a, b] }] });
  const p = d.playerConnections[0];
  assert.equal(p.basis, "player");
  assert.equal(p.measuredAgainst, "station-location");
  assert.deepEqual(p.ends.map((e) => e.attached), [true, true]);
  assert.equal(p.joinedAtBothEnds, true);
  assert.deepEqual(p.bridgesConnectionIds, [link.connectionId]);
  assert.ok(p.lengthMeters > 500);
  assert.equal(d.physicalConnection, null, "the drawing is not a measurement of the track");
  assert.equal(d.connections.find((c) => c.connectionId === link.connectionId).physicalConnection, null);
  assert.ok(d.spatialFlags.includes("player-connection-drawn") && d.sourceLayers.some((l) => l.layer === "player-drawing"));
  const apart = build({ connections: [{ key: "drawn", polyline: linkOf(build({}, { world: WORLDS.apart }))[0].viaLocations }] }, { world: WORLDS.apart });
  assert.equal(apart.physicalConnection, false, "a drawn line over a measured gap leaves the gap false");
  assert.equal(apart.playerConnections[0].joinedAtBothEnds, true);
});

test("a drawn line away from the stations is measured apart (false), one in between is null, never joined by guessing", () => {
  const away = build({ connections: [{ key: "away", polyline: [[139.0, 35.01], [139.005, 35.01]] }] }).playerConnections[0];
  assert.deepEqual(away.ends.map((e) => e.attached), [false, false]);
  assert.equal(away.joinedAtBothEnds, false);
  assert.ok(build({ connections: [{ key: "away", polyline: [[139.0, 35.01], [139.005, 35.01]] }] }).spatialFlags.includes("player-connection-not-at-stations"));
  const [a] = linkOf(build()).find((c) => c.viaLocations[0][0] !== c.viaLocations[1][0]).viaLocations;
  const between = build({ connections: [{ key: "mid", polyline: [[a[0] + 0.0003, a[1]], [a[0] + 0.0004, a[1]]] }] }).playerConnections[0];
  assert.equal(between.ends[0].attached, null);
  assert.equal(between.ends[0].unknownReasons.attached, "end-near-station-not-on-it");
  assert.equal(between.joinedAtBothEnds, null);
  const same = build({ connections: [{ key: "same", polyline: [a, [a[0] + 0.00001, a[1]]] }] }).playerConnections[0];
  assert.equal(same.joinedAtBothEnds, null);
  assert.equal(same.unknownReasons.joinedAtBothEnds, "both-ends-at-one-station");
});

test("a transfer passage the player drew is measured only at its ends against stations and entrances", () => {
  const d = build({ transferPaths: [{ key: "passage", name: "Passage", polyline: [[139.0101, 35.0003], [139.0103, 35.0004]] }] }, { ctx: { stationSites: [SITE_A1, SITE_A2] } });
  const p = d.playerTransferPaths[0];
  assert.equal(p.basis, "player");
  assert.deepEqual(p.ends.map((e) => e.nearestEntranceId), ["ent:n", "ent:n"]);
  assert.equal(p.ends[0].entranceDistanceMeters, 0);
  assert.equal(p.ends[0].nearestStationId, W.a1);
  assert.ok(p.stationIdsAtEnds.includes(W.a1) === (p.ends.some((e) => e.attached === true)));
  assert.ok(d.spatialFlags.includes("player-transfer-path-drawn"));
  const noEntrances = build({ transferPaths: [{ key: "passage", polyline: [[139.0101, 35.0003], [139.0103, 35.0004]] }] }).playerTransferPaths[0];
  assert.ok(noEntrances.ends.every((e) => e.nearestEntranceId === null && e.entranceDistanceMeters === null && e.unknownReasons.nearestEntranceId === "entrance-data-missing"));
});

test("nothing drawn is null, a declared 'none' is []; bad and duplicate drawings are reported", () => {
  const plain = build();
  assert.equal(plain.playerConnections, null);
  assert.equal(plain.unknownReasons.playerConnections, "no-player-connection-stated");
  assert.equal(plain.playerTransferPaths, null);
  assert.deepEqual(build({ connections: [], transferPaths: [] }).playerConnections, []);
  assert.deepEqual(build({ connections: [], transferPaths: [] }).playerTransferPaths, []);
  const out = buildRailwayDetourService(docFor(STATES.ext, { connections: [{ key: "x", polyline: [[139, 35]] }, { key: "y", polyline: [["a", 1], [2, 3]] }, { key: "dup", polyline: [[139.0, 35], [139.001, 35]] }, { key: "dup", polyline: [[139.0, 35.001], [139.001, 35.001]] }], transferPaths: [{ polyline: "no" }] }), ctxFor(W, STATES.ext));
  assert.equal(out.detour.playerConnections.length, 1);
  assert.deepEqual(out.warnings.map((w) => w.code).sort(), ["duplicate-player-connection", "player-connection-polyline-invalid", "player-connection-polyline-invalid", "player-transfer-path-polyline-invalid"]);
});

// --- missing inputs ---
test("without the rail geometry the legs keep their ids and the sections, and everything that needs a geometry is null with the reason", () => {
  const d = build({}, { ctx: { railGeometry: null } });
  assert.deepEqual(d.legs.map((l) => l.sectionId), candidateOf(STATES.ext).sectionIds);
  assert.ok(d.legs.every((l) => l.fromStationId === null && l.toStationId === null && l.alignment === null && l.unknownReasons.fromStationId === "rail-geometry-not-supplied"));
  assert.ok(d.connections.every((c) => c.gapMeters === null && c.location === null && c.viaLocations === null));
  assert.deepEqual(d.stations.map((s) => s.stationId).sort(), [...new Set([candidateOf(STATES.ext).startStationId, ...candidateOf(STATES.ext).viaStationIds, candidateOf(STATES.ext).endStationId])].sort());
  assertUnknownContract(d, "no geometry");
  assert.equal(d.railGeometryId, W.G.railGeometryId);
});

test("unknown[] and unknownReasons are 1:1 everywhere, and every unknown value is null, in every kind of case", () => {
  const cases = [
    build({ connections: [{ key: "c", polyline: [[139.0, 35.01], [139.005, 35.01]] }], transferPaths: [{ key: "t", polyline: [[139.0101, 35.0003], [139.0103, 35.0004]] }] }, { ctx: { stationSites: [SITE_A1, SITE_A2], externalCatalog: CATALOG } }),
    build({}, { world: WORLDS.joined }), build({}, { world: WORLDS.apart }), build({}, { ctx: { routes: [], application: null } }), build({}, { ctx: { railGeometry: null } }),
  ];
  cases.forEach((c, i) => { assertUnknownContract(c, `detour ${i}`); assert.deepEqual([...c.unknown], Object.keys(c.unknownReasons).sort()); });
});

// --- the module's own limits ---
test("no verdict, technical-compatibility, capacity, headway, train, charge, compensation, revenue, demand, reputation, time or contract field anywhere", () => {
  const rich = build({ connections: [{ key: "c", polyline: [[139.0, 35.01], [139.005, 35.01]] }], transferPaths: [{ key: "t", polyline: [[139.0101, 35.0003], [139.0103, 35.0004]] }] }, { ctx: { stationSites: [SITE_A1, SITE_A2], externalCatalog: CATALOG } });
  assert.deepEqual(fieldNames(rich).filter((k) => FORBIDDEN.test(k)), []);
  const exp = buildRailwayDetourServiceExport({ pack, sites: [STATES.ext.site], controls: [STATES.ext.control], railGeometries: [W.G], applications: [W.APP], routes: [W.route], externalCatalog: CATALOG, documents: [docFor(STATES.ext)] });
  assert.equal(exp.schema, RAILWAY_DETOUR_SERVICE_EXPORT_SCHEMA);
  assert.deepEqual(fieldNames(exp).filter((k) => FORBIDDEN.test(k)), []);
  assert.deepEqual(fieldNames(buildRailwayDetourView({ exportData: exp })).filter((k) => FORBIDDEN.test(k)), []);
});

test("no management, engine-state or train import and no money, clock or file access in any new map module, each under 40 KB", () => {
  for (const file of ["railway-detour-service", "railway-detour-service-candidates", "railway-detour-service-editor", "railway-detour-service-view"]) {
    const text = fs.readFileSync(path.join(here, "..", "src", "map", `${file}.mjs`), "utf8");
    assert.ok(text.length < 40_000, `${file} holds code, not data`);
    for (const m of text.matchAll(/from "([^"]+)"/g)) assert.match(m[1], /^\.\/[a-z-]+\.mjs$/, `${file} imports ${m[1]}`);
    assert.equal(/from\s+["'][^"']*management/.test(text), false, file);
    assert.equal(/from\s+["'][^"']*(railway-disruptions|railway-traffic-control|rail-capacity-integration|rail-replacement-operations|rail-replacement-geometry-adapter|scenario-runtime|trains|network|state|game)\.mjs/.test(text), false, file);
    assert.equal(/ledger|\.commit\(|\.settle\(|\.post\(|node:fs|Date\.now|Math\.random|state\.(trains|lines|trackSegments|railwayDisruptions)/.test(text.replace(/\/\/.*$/gm, "")), false, file);
  }
});

test("a map detour geometry does not touch cash, trains or disruption state: a stand-in engine state is unchanged after building, editing and viewing", () => {
  const state = deepFreeze({ cash: 1_000_000, ledger: [{ id: 1 }], trains: [{ id: "train:7", lineId: "line:1" }], trackSegments: [{ id: "track-segment:1" }], railwayDisruptions: { events: [eventOf("railway-disruption:1", "track-segment:1")], nextSequence: 2 } });
  const before = JSON.stringify(state);
  const doc = newRailwayDetourDoc("t", "1");
  const s = STATES.ext;
  addPlan(doc, s.site.eventId, candidateOf(s).candidateId, s.control);
  setConnection(doc, s.site.eventId, candidateOf(s).candidateId, { key: "c", polyline: [[139.0, 35.01], [139.005, 35.01]] });
  const exp = buildRailwayDetourServiceExport({ pack, sites: [s.site], controls: [s.control], railGeometries: [W.G], applications: [W.APP], routes: [W.route], documents: doc.plans.map(toDetourDocument) });
  buildRailwayDetourView({ exportData: exp, picks: picksOf(doc) });
  assert.equal(JSON.stringify(state), before);
});

// --- export ---
test("the export builds active plans, lists a switched-off one by id, and names what it cannot build", () => {
  const s = STATES.ext;
  const args = { pack, sites: [s.site], controls: [s.control], railGeometries: [W.G], applications: [W.APP], routes: [W.route] };
  const exp = buildRailwayDetourServiceExport({ ...args, documents: [docFor(s), docFor(s, { active: false, detourCandidateId: "railway-control-detour:other" }), docFor(s), { eventId: "railway-disruption:9", detourCandidateId: "x" }, { eventId: s.site.eventId, detourCandidateId: "railway-control-detour:nope" }] });
  assert.deepEqual(exp.detours.map((d) => d.selectedDetourCandidateId), [candidateOf(s).candidateId]);
  assert.deepEqual(exp.inactive, [{ eventId: s.site.eventId, detourCandidateId: "railway-control-detour:other", detourGeometryId: detourGeometryIdOf("t", s.site.eventId, "railway-control-detour:other") }]);
  assert.deepEqual(exp.warnings.map((w) => w.code), ["duplicate-railway-detour-service", "railway-detour-service-rejected", "railway-detour-service-rejected"]);
  assert.equal(exp.warnings[1].reasons[0].code, "site-missing");
  assert.equal(exp.warnings[2].reasons[0].code, "detour-not-offered");
  assert.equal(buildRailwayDetourServiceExport({ ...args, controls: [], documents: [docFor(s)] }).warnings[0].reasons[0].code, "control-missing");
});

// --- editor ---
test("editor: a plan is made only on an offered detour; picks come from the built geometry; drawings are kept by key and nothing stated differs from none", () => {
  const s = STATES.ext;
  const cid = candidateOf(s).candidateId;
  const doc = newRailwayDetourDoc("t", "1");
  assert.throws(() => addPlan(doc, s.site.eventId, "railway-control-detour:made-up", s.control), /Unknown detour candidate/);
  const plan = addPlan(doc, s.site.eventId, cid, s.control);
  assert.equal(addPlan(doc, s.site.eventId, cid, s.control), plan);
  assert.deepEqual([plan.connections, plan.transferPaths], [null, null]);
  const at = [doc, s.site.eventId, cid];
  const line1 = { key: "c1", polyline: [[139.0095, 35.0001], [139.0105, 35.0001]] };
  setConnection(...at, line1);
  line1.polyline[0][0] = 0;
  assert.equal(plan.connections[0].polyline[0][0], 139.0095, "the document keeps its own copy");
  setConnection(...at, { key: "c1", polyline: [[139.0095, 35.0001], [139.0105, 35.0002]], name: "again" });
  assert.equal(plan.connections.length, 1, "a key replaces");
  setTransferPath(...at, { key: "t1", polyline: [[139.01, 35], [139.011, 35]] });
  removeConnection(...at, "c1");
  removeTransferPath(...at, "t1");
  assert.deepEqual([plan.connections, plan.transferPaths], [[], []]);
  declareNone(...at, "connection");
  assert.throws(() => declareNone(...at, "bridge"), /Unknown drawing kind/);
  const detour = build({ connections: [{ key: "c2", polyline: [[139.0095, 35.0001], [139.0105, 35.0001]] }] });
  pick(...at, "leg", detour.legs[0].legId, detour);
  pick(...at, "leg", detour.legs[0].legId, detour);
  pick(...at, "connection", detour.connections[1].connectionId, detour);
  pick(...at, "connection", detour.playerConnections[0].playerConnectionId, detour);
  pick(...at, "transfer", detour.transferLinks[0].transferLinkId, detour);
  assert.deepEqual([plan.picked.legIds.length, plan.picked.connectionIds.length, plan.picked.transferIds.length], [1, 2, 1]);
  assert.equal(plan.selectedOnDetourGeometryRevision, detour.detourGeometryRevision);
  assert.throws(() => pick(...at, "leg", "railway-detour-leg:made-up", detour), /Unknown leg/);
  assert.throws(() => pick(...at, "leg", detour.connections[0].connectionId, detour), /Unknown leg/, "an id of another kind is not accepted");
  assert.throws(() => pick(...at, "route", "x", detour), /Unknown pick kind/);
  assert.throws(() => pick(...at, "leg", detour.legs[0].legId, { ...detour, selectedDetourCandidateId: "other" }), /not the one of this plan/);
  unpick(...at, "leg", detour.legs[0].legId);
  assert.deepEqual(plan.picked.legIds, []);
  clearPicks(...at, "connection");
  assert.deepEqual(plan.picked.connectionIds, []);
  clearPicks(...at);
  assert.deepEqual(plan.picked, { legIds: [], connectionIds: [], transferIds: [] });
  assert.throws(() => setConnection(doc, s.site.eventId, "railway-control-detour:other", line1), /Unknown detour plan/);
});

test("editor: a plan chosen on an older control geometry is outdated, a pick the current geometry no longer offers is stale", () => {
  const s = STATES.ext;
  const cid = candidateOf(s).candidateId;
  const doc = newRailwayDetourDoc("t", "1");
  addPlan(doc, s.site.eventId, cid, s.control);
  const detour = build();
  pick(doc, s.site.eventId, cid, "leg", detour.legs[0].legId, detour);
  assert.deepEqual(reconcilePlan(doc, s.site.eventId, cid, s.control, detour), { offered: true, outdated: false, stale: [] });
  const later = { ...s.control, controlGeometryRevision: "railway-service-control-revision:later" };
  assert.equal(reconcilePlan(doc, s.site.eventId, cid, later, detour).outdated, true);
  const changed = { ...detour, legs: detour.legs.slice(1) };
  assert.deepEqual(reconcilePlan(doc, s.site.eventId, cid, s.control, changed).stale, [{ kind: "leg", id: detour.legs[0].legId, reason: "no-longer-offered" }]);
  assert.equal(reconcilePlan(doc, s.site.eventId, cid, { ...s.control, detourCandidates: [] }).offered, false);
});

test("editor: a plan is switched off, never deleted; saving and restoring keeps every plan, pick, drawing and id; another pack's save is refused", () => {
  const s = STATES.ext;
  const cid = candidateOf(s).candidateId;
  const doc = newRailwayDetourDoc("t", "1");
  addPlan(doc, s.site.eventId, cid, s.control);
  setConnection(doc, s.site.eventId, cid, { key: "c", polyline: [[139.0095, 35.0001], [139.0105, 35.0001]] });
  const detour = build({ connections: doc.plans[0].connections });
  pick(doc, s.site.eventId, cid, "connection", detour.playerConnections[0].playerConnectionId, detour);
  deactivatePlan(doc, s.site.eventId, cid);
  assert.equal(activePlans(doc).length, 0);
  assert.equal(doc.plans.length, 1);
  restorePlan(doc, s.site.eventId, cid);
  assert.deepEqual(Object.keys(editorModule).filter((k) => /^(remove|delete|drop)(Plan|Document)/i.test(k)), [], "a plan has no delete");
  const text = serializeRailwayDetourDoc(doc);
  const back = restoreRailwayDetourDoc(text, pack);
  assert.deepEqual(back.doc, doc);
  assert.equal(serializeRailwayDetourDoc(back.doc), text);
  const before = buildRailwayDetourService(toDetourDocument(doc.plans[0]), ctxFor(W, s)).detour;
  const after = buildRailwayDetourService(toDetourDocument(back.doc.plans[0]), ctxFor(W, s)).detour;
  assert.equal(after.detourGeometryId, before.detourGeometryId, "the id survives save and reopen");
  assert.equal(JSON.stringify(after), JSON.stringify(before));
  assert.deepEqual(picksOf(back.doc)[`${s.site.eventId}|${cid}`].connectionIds, [detour.playerConnections[0].playerConnectionId]);
  const other = restoreRailwayDetourDoc(text, { manifest: { id: "other", version: "1" } });
  assert.deepEqual(other.doc.plans, []);
  assert.equal(other.warnings[0].code, "railway-detour-doc-other-pack");
  assert.equal(restoreRailwayDetourDoc("{not json", pack).warnings[0].code, "railway-detour-doc-unreadable");
  assert.equal(restoreRailwayDetourDoc(JSON.stringify({ version: 9 }), pack).warnings[0].code, "railway-detour-doc-version");
  assert.equal(restoreRailwayDetourDoc(text, { manifest: { id: "t", version: "2" } }).warnings[0].code, "pack-version-mismatch");
  assert.deepEqual(restoreRailwayDetourDoc(null, pack).doc.plans, []);
});

// --- view ---
function fakeCtx() {
  const calls = [];
  const ctx = new Proxy({}, {
    get: (target, name) => (name in target ? target[name] : (...args) => { calls.push([name, ...args]); }),
    set: (target, name, value) => { target[name] = value; calls.push(["set", name, value]); return true; },
  });
  return { ctx, calls };
}
function fakeDom() {
  const make = () => ({ className: "", textContent: "", hidden: false, children: [], ownerDocument: null, append(...kids) { this.children.push(...kids); }, replaceChildren(...kids) { this.children = kids; } });
  const doc = { createElement: () => { const e = make(); e.ownerDocument = doc; return e; } };
  const rootEl = make();
  rootEl.ownerDocument = doc;
  return rootEl;
}
const textsOf = (node) => [node.textContent, ...node.children.flatMap(textsOf)].filter(Boolean);
const screen = ([lon, lat]) => [(lon - 139) * 20000, (35.01 - lat) * 20000];
const BANNED_TEXT = /원|비용|공기|승인|확률|가능|불가|복구|지연|보상|평판|손실|시간|용량|수송력|점수|순위|접근료|계약|판정/;
const exportOf = (world, over = {}, ctx = {}) => {
  const state = STATES[world.mode];
  return buildRailwayDetourServiceExport({ pack, sites: [state.site], controls: [state.control], railGeometries: [world.G], applications: [world.APP], routes: world.route ? [world.route] : [], stationSites: [SITE_A1, SITE_A2], documents: [docFor(state, over)], ...ctx });
};

test("view: plan legs, existing-line legs, measured links, player lines and measured joins look different, and the player's own marks say so", () => {
  const colours = [STYLES.planLeg, STYLES.playerConnection, STYLES.playerTransfer, STYLES.link].map((s) => s.color);
  assert.equal(new Set(colours).size, colours.length);
  assert.equal(new Set(Object.values(CONNECTION_STYLES).map((s) => s.glyph)).size, 3);
  const model = buildRailwayDetourView({ exportData: exportOf(WORLDS.joined, { connections: [{ key: "c", polyline: [[139.01, 35.001], [139.02, 35.001]] }], transferPaths: [{ key: "t", polyline: [[139.01, 35.0], [139.0102, 35.0]] }] }) });
  assert.equal(model.schema, "transitline.railway-detour-service-map-view/1");
  const d = model.detours[0];
  assert.deepEqual(new Set(d.legs.map((l) => l.style.key)), new Set(["plan-leg"]));
  assert.ok(d.connections.every((c) => c.style.key === "joined"));
  assert.equal(d.playerConnections[0].style.key, "player-connection");
  const ext = buildRailwayDetourView({ exportData: exportOf(W) }).detours[0];
  assert.deepEqual(new Set(ext.legs.map((l) => l.style.key)), new Set(["existing-leg"]));
  assert.ok(ext.connections.every((c) => c.style.key === "unmeasured"));
  assert.ok(ext.legs.every((l) => l.infrastructureOwnerText === "owner:other" && l.infrastructureOwnerMissing === false));
  const apart = buildRailwayDetourView({ exportData: exportOf(WORLDS.apart) }).detours[0];
  assert.ok(apart.connections.filter((c) => c.kind === "handover-link").every((c) => c.style.key === "apart"));
  assert.equal(buildRailwayDetourView({ exportData: { detours: [], inactive: [], warnings: [] } }).detours.length, 0);
});

test("view: drawing is read-only, draws no line for an existing line without alignment, marks picks and the player's lines", () => {
  const exportData = deepFreeze(exportOf(W, { connections: [{ key: "c", polyline: [[139.0095, 35.0001], [139.0105, 35.0001]] }] }));
  const d = exportData.detours[0];
  const picks = { [`${d.eventId}|${d.selectedDetourCandidateId}`]: { legIds: [d.legs[0].legId], connectionIds: [d.playerConnections[0].playerConnectionId], transferIds: [] } };
  const run = (p) => { const f = fakeCtx(); drawRailwayDetourOverlay(f.ctx, buildRailwayDetourView({ exportData, picks: p }), screen); return f.calls; };
  const plain = run({});
  const picked = run(picks);
  assert.ok(picked.filter((c) => c[0] === "stroke").length > plain.filter((c) => c[0] === "stroke").length, "a pick is drawn with an extra halo");
  const texts = (calls) => calls.filter((c) => c[0] === "fillText" || c[0] === "strokeText").map((c) => String(c[1]));
  assert.ok(texts(plain).some((t) => t.includes("소유자 owner:other")));
  assert.ok(texts(plain).some((t) => t.includes("기존선 역")));
  assert.ok(plain.some((c) => c[0] === "fillText" && c[1] === STYLES.existingLeg.glyph));
  assert.ok(plain.every((c) => !["fetch", "commit", "settle", "post"].includes(c[0])));
  const joined = fakeCtx();
  drawRailwayDetourOverlay(joined.ctx, buildRailwayDetourView({ exportData: exportOf(WORLDS.joined) }), screen);
  assert.ok(joined.calls.filter((c) => c[0] === "lineTo").length >= 2, "a drawn plan leg has its alignment drawn");
  const noOwner = fakeCtx();
  drawRailwayDetourOverlay(noOwner.ctx, buildRailwayDetourView({ exportData: exportOf(WORLDS.joined) }), screen);
  assert.ok(texts(noOwner.calls).some((t) => t.includes("소유자 자료 없음")));
});

test("view: the panel and legend use textContent only and never show a verdict, compatibility, charge, time or contract wording", () => {
  const model = buildRailwayDetourView({ exportData: { ...exportOf(W, { connections: [{ key: "c", name: "<img src=x onerror=alert(1)>", polyline: [[139.0095, 35.0001], [139.0105, 35.0001]] }] }), warnings: [{ code: "railway-detour-service-rejected" }] } });
  const panel = fakeDom();
  renderRailwayDetourPanel(panel, model);
  const all = textsOf(panel);
  assert.ok(all.some((t) => t.includes("<img src=x onerror=alert(1)>")), "a player-supplied string is shown as text");
  assert.ok(all.some((t) => t.startsWith("우회 공간 사실 1건")));
  assert.ok(all.some((t) => t.includes("railway-detour-service-rejected")));
  assert.ok(all.some((t) => t.includes("보행 경로 아님")));
  assert.ok(all.some((t) => t.includes("접속 미상")));
  assert.equal(all.some((t) => BANNED_TEXT.test(t)), false);
  const empty = fakeDom();
  renderRailwayDetourPanel(empty, buildRailwayDetourView({ exportData: { detours: [], inactive: [], warnings: [] } }));
  assert.equal(empty.hidden, true);
  const legend = fakeDom();
  renderRailwayDetourLegend(legend);
  const legendText = textsOf(legend);
  assert.ok(legendText.length >= 10);
  assert.equal(legendText.some((t) => BANNED_TEXT.test(t)), false);
});

// --- shipped examples: regenerated by the script, and checked against the contract and the shipped M6 / M7 examples ---
const examplePacks = ["tokyo", "example-radial", "example-corridor"];
const exampleDir = (id) => path.join(root, "packs", id, "railway-detour-service-examples");
const readExamples = (id) => fs.readdirSync(exampleDir(id)).filter((f) => f.endsWith(".railway-detour-service.json")).sort().map((f) => ({ file: f, detour: JSON.parse(fs.readFileSync(path.join(exampleDir(id), f), "utf8")) }));

test("every shipped example satisfies the contract: synthetic label, unknown contract, no forbidden fields, resolving ids", () => {
  for (const id of examplePacks) {
    const examples = readExamples(id);
    assert.ok(examples.length >= 1, id);
    for (const { file, detour: example } of examples) {
      const { source, ...body } = example;
      assert.equal(body.schema, RAILWAY_DETOUR_SERVICE_SCHEMA, `${id}/${file}`);
      assert.equal(body.sourcePackId, id);
      assert.equal(source.generatedBy, "scripts/build-railway-detour-service-examples.mjs");
      assert.equal(source.synthetic, true);
      assert.equal(body.detourGeometryId, detourGeometryIdOf(id, body.eventId, body.selectedDetourCandidateId), file);
      assert.deepEqual(fieldNames(body).filter((k) => FORBIDDEN.test(k)), [], file);
      assertUnknownContract(body, `${id}/${file}`);
      assert.equal(body.connections.length, body.legs.length + 1, file);
      assert.ok(body.legs.every((l) => l.basis === "source") && (body.playerConnections ?? []).every((p) => p.basis === "player") && (body.playerTransferPaths ?? []).every((p) => p.basis === "player"));
      assert.equal(body.walkNetwork, null);
      const external = body.legs.some((l) => l.sourceKind === "external");
      if (external) assert.ok(body.connections.every((c) => c.physicalConnection !== true || c.kind === "shared-station" && c.evidence === "measured-alignments"), `${file}: an existing line's connection is never true`);
      const picked = source.picked ?? {};
      const known = { leg: body.legs.map((l) => l.legId), connection: [...body.connections.map((c) => c.connectionId), ...(body.playerConnections ?? []).map((c) => c.playerConnectionId)], transfer: [...body.transferLinks.map((t) => t.transferLinkId), ...(body.playerTransferPaths ?? []).map((t) => t.transferPathId)] };
      for (const [kind, list] of Object.entries(picked)) for (const pid of list) assert.ok(known[kind].includes(pid), `${file}: picked ${kind}`);
    }
  }
});

test("no id regression: each example built on a shipped M7 example keeps that example's site and control ids and revisions, and every shipped M6 / M7 example keeps its id", () => {
  for (const id of examplePacks) {
    for (const { file, detour: body } of readExamples(id)) {
      if (!body.source.m7Example) continue;
      const m7 = JSON.parse(fs.readFileSync(path.join(root, "packs", id, "railway-service-control-examples", `${body.source.m7Example}.service-control.json`), "utf8"));
      assert.equal(body.controlGeometryId, m7.controlGeometryId, file);
      assert.equal(body.controlGeometryRevision, m7.controlGeometryRevision, `${file}: the control geometry revision moved`);
      assert.equal(body.disruptionSiteId, m7.disruptionSiteId, file);
      assert.equal(body.disruptionSiteRevision, m7.disruptionSiteRevision, file);
      assert.ok(m7.detourCandidates.some((c) => c.candidateId === body.selectedDetourCandidateId), `${file}: the chosen detour is one the M7 example offers`);
    }
    for (const dir of ["railway-disruption-examples", "railway-service-control-examples"]) {
      for (const f of fs.readdirSync(path.join(root, "packs", id, dir)).filter((x) => x.endsWith(".json"))) {
        const x = JSON.parse(fs.readFileSync(path.join(root, "packs", id, dir, f), "utf8"));
        if (x.controlGeometryId) assert.equal(x.controlGeometryId, controlGeometryIdOf(id, x.eventId), f);
        else assert.equal(x.disruptionSiteId, disruptionSiteIdOf(id, x.eventId), f);
      }
    }
  }
});

test("the example set covers every required case", () => {
  const all = examplePacks.flatMap((id) => readExamples(id).map((e) => e.detour));
  const cases = new Set(all.flatMap((s) => s.source.case));
  for (const c of ["measured-joined", "measured-apart", "connection-unmeasured", "external-alignment-unknown", "player-connection", "player-transfer-path", "no-station-detail", "station-entrances", "catalog-identification", "owner-unknown", "other-company-owner", "picked-legs"]) assert.ok(cases.has(c), c);
  const caseOf = (c) => all.filter((s) => s.source.case.includes(c));
  assert.ok(caseOf("measured-joined").every((s) => s.physicalConnection === true && s.connections.every((c) => c.gapMeters === 0)));
  assert.ok(caseOf("measured-apart").every((s) => s.physicalConnection === false && s.connections.some((c) => c.physicalConnection === false && c.gapMeters > 50)));
  assert.ok(caseOf("connection-unmeasured").every((s) => s.physicalConnection === null && s.connections.some((c) => c.physicalConnection === null && c.gapMeters === null)));
  assert.ok(caseOf("external-alignment-unknown").every((s) => s.alignment === null && s.lengthMeters === null && s.legs.some((l) => l.alignment === null && l.unknownReasons.alignment === "external-alignment-not-in-source")));
  assert.ok(caseOf("player-connection").every((s) => s.playerConnections.length > 0 && s.playerConnections.every((p) => p.basis === "player") && s.physicalConnection !== true || s.connections.every((c) => c.physicalConnection === true)));
  assert.ok(caseOf("player-connection").filter((s) => s.source.case.includes("measured-apart") || s.source.case.includes("connection-unmeasured")).every((s) => s.physicalConnection !== true), "a drawn line never makes the detour joined");
  assert.ok(caseOf("player-transfer-path").every((s) => s.playerTransferPaths.length > 0));
  assert.ok(caseOf("no-station-detail").every((s) => s.stations.every((x) => x.entrances === null && x.platformType === null)));
  assert.ok(caseOf("station-entrances").every((s) => s.stations.some((x) => x.entrances?.length > 0)));
  assert.ok(caseOf("catalog-identification").every((s) => s.legs.filter((l) => l.sourceKind === "external").every((l) => l.externalSpecificationId !== null)));
  assert.ok(caseOf("owner-unknown").every((s) => s.infrastructureOwnerIds === null && s.legs.every((l) => l.infrastructureOwnerId === null)));
  assert.ok(caseOf("other-company-owner").every((s) => s.infrastructureOwnerIds.length > 0));
});

test("re-running the generator rewrites every example to the same canonical content", () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "railway-detour-examples-"));
  const run = spawnSync(process.execPath, [path.join(root, "scripts", "build-railway-detour-service-examples.mjs"), "--out", out], { cwd: root, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const canonical = (text) => text.replaceAll("\r\n", "\n");
  for (const id of examplePacks) {
    const files = fs.readdirSync(exampleDir(id)).filter((f) => f.endsWith(".railway-detour-service.json")).sort();
    assert.deepEqual(fs.readdirSync(path.join(out, id)).sort(), files, id);
    for (const f of files) assert.equal(canonical(fs.readFileSync(path.join(out, id, f), "utf8")), canonical(fs.readFileSync(path.join(exampleDir(id), f), "utf8")), `${id}/${f}`);
  }
  fs.rmSync(out, { recursive: true, force: true });
});
