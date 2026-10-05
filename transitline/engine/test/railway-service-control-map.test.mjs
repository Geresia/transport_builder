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
import { buildRailwayDisruptionSite } from "../src/map/railway-disruption-site.mjs";
import { makeSpatialContext, roadLayerFromGeojson } from "../src/map/spatial.mjs";
import {
  RAILWAY_SERVICE_CONTROL_EXPORT_SCHEMA, RAILWAY_SERVICE_CONTROL_SCHEMA, buildRailwayServiceControl, buildRailwayServiceControlExport, controlGeometryIdOf,
} from "../src/map/railway-service-control.mjs";
import * as editorModule from "../src/map/railway-service-control-editor.mjs";
import {
  activeControls, addAccessPoint, addControl, clearSelection, deactivateControl, deselectCandidate, newRailwayServiceControlDoc, reconcileSelections, removeAccessPoint, restoreControl,
  restoreRailwayServiceControlDoc, selectCandidate, selectionsOf, serializeRailwayServiceControlDoc, setEmergencyVehicleWidth, toControlDocument,
} from "../src/map/railway-service-control-editor.mjs";
import {
  ATTACHMENT_STYLES, CANDIDATE_STYLES, buildRailwayServiceControlView, drawRailwayServiceControlOverlay, renderRailwayServiceControlLegend, renderRailwayServiceControlPanel,
} from "../src/map/railway-service-control-view.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");

// --- fixtures: two plans along lat 35 (a, b), an existing line E1 (d1..d3), a through route that joins them, and a rail capacity geometry over all of it ---
const pack = {
  manifest: { id: "t", version: "1", data: { license: "CC0-1.0", attribution: ["test"] } },
  demand: { points: ["d0", "d1", "d2", "d3", "d4"].map((id, i) => ({ id, name: id, location: [139 + i * 0.01, 35] })) },
  existingNetwork: { lines: [{ name: "E1", operator: "Operator X", osmRelationId: 42, stationIds: ["d1", "d2", "d3"] }] },
};
const EXT = "ext-line:42";
const E = [139.02, 35];
const line = (key, pts, name = key) => ({ key, name, vertices: pts.map((location) => ({ location, platformType: "side" })) });
const ref = (plan, i) => ({ planId: plan.planId, segmentId: plan.segments[i].id });
const revisionsOf = (...plans) => ({ plans: Object.fromEntries(plans.map((p) => [p.planId, planRevisionOf(p)])), routes: {} });
const boundary = (key, plan, i, alongMeters) => ({ key, planId: plan.planId, segmentId: plan.segments[i].id, measuredFromStationId: plan.segments[i].from, alongMeters, basis: "player" });
const sectionOf = (g, plan, i) => g.sections.find((s) => s.planId === plan.planId && s.segmentId === plan.segments[i].id);
const blocksOf = (g, section) => g.blocks.filter((b) => b.sectionId === section.sectionId).sort((a, b) => a.startAlongMeters - b.startAlongMeters);
const alongPoint = (section, fraction) => { const [a, b] = [section.startLocation, section.endLocation]; return [a[0] + (b[0] - a[0]) * fraction, a[1] + (b[1] - a[1]) * fraction]; };
const trackId = (g, section) => `track-segment:${g.sections.findIndex((s) => s.sectionId === section.sectionId) + 1}`;
const applicationOf = (g, extra = {}) => ({ schema: "transitline.rail-capacity-application/1", contractVersion: 1, operationalLineId: "line:1", railGeometryId: g.railGeometryId, railGeometryRevision: g.railGeometryRevision, sections: g.sections.map((s) => ({ trackSegmentId: trackId(g, s), railCapacitySectionId: s.sectionId })), ...extra });
const eventOf = (g, n, over = {}) => ({
  schema: "transitline.railway-disruption/1", contractVersion: 1, id: `railway-disruption:${n}`, kind: "signal-failure", status: "active", lineId: "line:1",
  trackSegmentId: null, blockId: null, trainId: null, startedAtMinute: 600, expectedEndMinute: 660, resolvedAtMinute: null, resolutionReason: null,
  severity: "major", effect: { closed: true, speedLimitMps: 0 }, infrastructureOwnerId: null, operatorId: null, responsibility: "unknown", source: "simulation", ...over,
});
// the site of an event on a geometry
function siteOf(g, app, event, drawn = {}) {
  const out = buildRailwayDisruptionSite({ eventId: event.id, designedRailGeometryRevision: g.railGeometryRevision, ...drawn }, { pack, events: [event], railGeometry: g, applications: [app] });
  assert.ok(out.site, JSON.stringify(out.warnings));
  return out.site;
}

function makeWorld({ names = ["a", "b"], reverse = false, withTerminals = true, withRoute = true } = {}) {
  const drawnLines = [line("a", [[139, 35], [139.01, 35], [139.02, 35]], names[0]), line("b", [[139.02, 35], [139.03, 35], [139.04, 35]], names[1])];
  const mapExport = buildMapExport({ pack, mode: "existing", drawnLines: reverse ? [...drawnLines].reverse() : drawnLines });
  const A = mapExport.plans.find((p) => p.planId === stableId("plan", "t", "key", "a"));
  const B = mapExport.plans.find((p) => p.planId === stableId("plan", "t", "key", "b"));
  let route = null;
  if (withRoute) {
    // a loop: the plan up to its second station, the existing line, then the second plan — joined at differing stations, so each handover is an explicit link
    const out = buildThroughRoute({ key: "r", legs: [
      { sourceKind: "planned", key: "l1", planId: A.planId, fromStationId: A.segments[0].from, toStationId: A.segments[0].to, infrastructureOwnerId: "owner:player" },
      { sourceKind: "external", key: "l2", externalLineId: EXT, fromStationId: "d1", toStationId: "d3", infrastructureOwnerId: "owner:other" },
      { sourceKind: "planned", key: "l3", planId: B.planId, infrastructureOwnerId: "owner:player" },
    ] }, { pack, plans: mapExport.plans, externalNetworks: mapExport.externalNetworks });
    assert.ok(out.route, JSON.stringify(out.warnings));
    route = out.route;
  }
  const a0 = A.segments[0].from;
  const b1 = B.segments[0].to;
  const b2 = B.segments[1].to;
  const terminals = withTerminals ? [
    // a0: a platform and a turnback track that start where the approach ends (measured attached)
    { key: "t-a0", stationId: a0, platforms: [{ key: "p0", approach: ref(A, 0), polyline: [[139, 35], [138.9985, 35]], platformLengthMeters: 120 }], turnbackTracks: [{ key: "tb0", kind: "turnback", polyline: [[139, 35], [138.9988, 35.0003]] }] },
    // b2: declared with no platform and one stabling track 220 m away from the approach (measured apart)
    { key: "t-b2", stationId: b2, platforms: [], turnbackTracks: [{ key: "far", kind: "stabling", polyline: [[139.04, 35.002], [139.0415, 35.002]] }] },
    // b1: stated but nothing said about its tracks
    { key: "t-b1", stationId: b1 },
  ] : null;
  const out = buildRailGeometry({
    key: "g", planIds: [A.planId, B.planId], externalLineIds: [EXT], ...(route ? { throughRouteId: route.throughRouteId } : {}),
    designedRevisions: { ...revisionsOf(A, B), routes: route ? { [route.throughRouteId]: route.geometryRevision } : {} },
    sectionFacts: [{ ref: ref(A, 1), directionMode: "single", basis: "player" }, { ref: ref(B, 0), directionMode: "double", basis: "player" }],
    blockBoundaries: [boundary("b1", A, 0, 300)],
    junctions: [
      { key: "mid", kind: "turnout", location: [139.0045, 35], connections: [{ ...ref(A, 0), role: "stem" }] },
      { key: "end", kind: "turnout", location: E, connections: [{ ...ref(A, 1), role: "stem" }, { ...ref(B, 0), role: "main" }] },
    ],
    terminals,
  }, { pack, plans: mapExport.plans, externalNetworks: mapExport.externalNetworks, routes: route ? [route] : [] });
  assert.ok(out.design, JSON.stringify(out.warnings));
  const G = out.design;
  return { mapExport, A, B, route, G, APP: applicationOf(G), a0, b1, b2, A0: sectionOf(G, A, 0), A1: sectionOf(G, A, 1), B0: sectionOf(G, B, 0), EXT_SECTION: G.sections.find((s) => s.sourceKind === "external") };
}
const W = makeWorld();
const roads = roadLayerFromGeojson({ features: [{ geometry: { coordinates: [[139.0, 35.0004], [139.03, 35.0004]] }, properties: { roadClass: "minor" } }] }, { quality: "medium", source: { name: "test roads", license: "CC0-1.0" } });
const SPATIAL = makeSpatialContext({ roads });
const STATION_SITES = [{ connectedStationId: W.A1.fromStationId, entranceCandidates: [{ entranceId: "ent:north", name: "North gate", location: [139.0101, 35.0002] }] }];

// the site of event n (default: a signal failure on A1, the whole section) and the control geometry on it
const ev = (n, over = {}, world = W) => eventOf(world.G, n, { trackSegmentId: trackId(world.G, world.A1), ...over });
const siteFor = (n, over = {}, drawn = {}, world = W) => siteOf(world.G, world.APP, ev(n, over, world), drawn);
const ctxOf = (site, extra = {}, world = W) => ({ pack, site, railGeometry: world.G, application: world.APP, routes: world.route ? [world.route] : [], externalNetworks: world.mapExport.externalNetworks, ...extra });
function control(n = 1, { event = {}, drawn = {}, doc = {}, extra = {}, world = W } = {}) {
  const site = siteFor(n, event, drawn, world);
  const out = buildRailwayServiceControl({ eventId: site.eventId, ...doc }, ctxOf(site, extra, world));
  assert.ok(out.control, JSON.stringify(out.warnings));
  return out.control;
}
const rejected = (document, code, { site = siteFor(1), extra = {} } = {}) => {
  const out = buildRailwayServiceControl(document, { ...ctxOf(site), ...extra });
  assert.equal(out.control, null);
  assert.equal(out.warnings[0].code, code);
  return out.warnings[0];
};

const keysDeep = (value, found = new Set()) => {
  if (Array.isArray(value)) value.forEach((v) => keysDeep(v, found));
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) { found.add(k); keysDeep(v, found); }
  return found;
};
// no cost, price, cash, probability, verdict, score, ranking, delay, duration, recovery, compensation, reputation, passenger-loss or timetable field.
// (railGeometryId / railCapacity... name the rail capacity contract and infrastructureOwnerIds is a required field: both are allowed names)
const FORBIDDEN = /cost|price|\bfee|cash|probab|verdict|feasib|possib|approval|score|delay|duration|recover|expectedEnd|resolvedAt|startedAt|(?<!rail)capacity|trainsPerHour|headway|timetable|throughput|severity|responsib|compensat|refund|reputation|passengerLoss|demandLoss|(?<!infrastructure)owner|operator|rank|recommend|\bbest/i;
const fieldNames = (value) => [...keysDeep(value)].filter((k) => !k.includes(":"));
const deepFreeze = (o) => { if (o && typeof o === "object") { Object.values(o).forEach(deepFreeze); Object.freeze(o); } return o; };
function assertUnknownContract(value, where = "control") {
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
const turnbackOf = (c, stationId) => c.turnbackCandidates.find((t) => t.stationId === stationId);
const ids = (list) => list.map((x) => x.candidateId);

// --- identity ---
test("same input gives the same controlGeometryId and byte-identical JSON", () => {
  const a = control(1, { drawn: { location: alongPoint(W.A1, 0.5) } });
  const b = control(1, { drawn: { location: alongPoint(W.A1, 0.5) } });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.equal(a.schema, RAILWAY_SERVICE_CONTROL_SCHEMA);
  assert.equal(a.contractVersion, 1);
  assert.equal(a.controlGeometryId, controlGeometryIdOf("t", "railway-disruption:1"));
  assert.deepEqual([a.eventId, a.railGeometryId, a.railGeometryRevision, a.operationalLineId], ["railway-disruption:1", W.G.railGeometryId, W.G.railGeometryRevision, "line:1"]);
  for (const f of ["controlGeometryRevision", "disruptionSiteId", "affectedTrackSegmentIds", "affectedSectionIds", "affectedBlockIds", "turnbackCandidates", "partialSuspensionCandidates", "detourCandidates", "evacuationAccessCandidates", "spatialFlags", "dataQuality", "unknown", "unknownReasons", "sourceLayers", "license"]) assert.ok(f in a, f);
});

test("the id follows the event and the pack; what the player adds changes the revision, never the id", () => {
  const plain = control(1);
  const withPoint = control(1, { doc: { accessPoints: [{ key: "gate", kind: "entrance", location: [139.015, 35.0004], basis: "player" }] } });
  assert.equal(withPoint.controlGeometryId, plain.controlGeometryId);
  assert.notEqual(withPoint.controlGeometryRevision, plain.controlGeometryRevision);
  assert.notEqual(control(2).controlGeometryId, plain.controlGeometryId);
  assert.notEqual(controlGeometryIdOf("other", "railway-disruption:1"), plain.controlGeometryId);
  const keysReordered = buildRailwayServiceControl({ accessPoints: [{ basis: "player", location: [139.015, 35.0004], kind: "entrance", key: "gate" }], eventId: "railway-disruption:1" }, ctxOf(siteFor(1))).control;
  assert.equal(JSON.stringify(keysReordered), JSON.stringify(withPoint));
});

test("input array order, drawing order and plan names change no id and no byte of the output", () => {
  const renamed = makeWorld({ names: ["Zeta Line", "Alpha Line"], reverse: true });
  assert.equal(renamed.G.railGeometryId, W.G.railGeometryId);
  const a = control(1, { drawn: { location: alongPoint(W.A1, 0.5) } });
  const b = control(1, { drawn: { location: alongPoint(renamed.A1, 0.5) }, world: renamed });
  assert.equal(JSON.stringify(a.turnbackCandidates), JSON.stringify(b.turnbackCandidates));
  assert.deepEqual(ids(a.partialSuspensionCandidates), ids(b.partialSuspensionCandidates));
  assert.deepEqual(ids(a.detourCandidates), ids(b.detourCandidates));
  assert.deepEqual(ids(a.evacuationAccessCandidates), ids(b.evacuationAccessCandidates));
  const s1 = siteFor(1);
  const s2 = siteFor(2, { trackSegmentId: trackId(W.G, W.B0) });
  const docs = [{ eventId: s1.eventId }, { eventId: s2.eventId }];
  const forward = buildRailwayServiceControlExport({ pack, sites: [s1, s2], railGeometries: [W.G], applications: [W.APP], routes: [W.route], documents: docs });
  const backward = buildRailwayServiceControlExport({ pack, sites: [s2, s1], railGeometries: [W.G], applications: [W.APP], routes: [W.route], documents: [...docs].reverse() });
  assert.equal(JSON.stringify(forward), JSON.stringify(backward));
});

test("the inputs are never mutated (frozen site, geometry, application, route, document)", () => {
  const site = deepFreeze(siteFor(1, {}, { location: alongPoint(W.A1, 0.5) }));
  const geometry = deepFreeze(structuredClone(W.G));
  const route = deepFreeze(structuredClone(W.route));
  const app = deepFreeze(structuredClone(W.APP));
  const document = deepFreeze({ eventId: site.eventId, accessPoints: [{ key: "g", kind: "road-access", location: [139.015, 35.0004], basis: "player", roadWidthMeters: 5 }], emergencyVehicleWidthMeters: 2.5 });
  const frozenPack = deepFreeze(structuredClone(pack));
  const before = JSON.stringify([site, geometry, route, app, document, frozenPack]);
  const out = buildRailwayServiceControl(document, { pack: frozenPack, site, railGeometry: geometry, application: app, routes: [route], stationSites: deepFreeze(structuredClone(STATION_SITES)), spatial: SPATIAL });
  assert.ok(out.control);
  assert.equal(JSON.stringify([site, geometry, route, app, document, frozenPack]), before);
  const exp = buildRailwayServiceControlExport({ pack: frozenPack, sites: [site], railGeometries: [geometry], applications: [app], routes: [route], documents: [document] });
  assert.equal(exp.controls.length, 1);
  assert.equal(buildRailwayServiceControlView({ exportData: deepFreeze(exp) }).controls.length, 1);
});

// --- null, [] and the true / false / null of a physical attachment ---
test("null means nothing is known, [] means none: a station nobody described is null, a terminal declared without platforms is []", () => {
  const c = control(1);
  const unstated = turnbackOf(c, W.A1.fromStationId);
  assert.deepEqual([unstated.terminalResourceId, unstated.platformCandidateIds, unstated.turnbackTrackCandidateIds, unstated.physicalAttachment, unstated.facilityAttachments], [null, null, null, null, null]);
  assert.equal(unstated.unknownReasons.terminalResourceId, "terminal-not-stated");
  const declared = turnbackOf(c, W.b2);
  assert.deepEqual(declared.platformCandidateIds, [], "a terminal that states no platform has none");
  assert.equal(declared.turnbackTrackCandidateIds.length, 1);
  assert.ok(!declared.unknown.includes("platformCandidateIds"));
  const nothingSaid = turnbackOf(c, W.b1);
  assert.equal(nothingSaid.platformCandidateIds, null);
  assert.equal(nothingSaid.unknownReasons.platformCandidateIds, "no-platform-data");
  assert.equal(nothingSaid.unknownReasons.turnbackTrackCandidateIds, "no-turnback-data");
});

test("physicalAttachment: true when a facility track measurably meets the approach, false when every stated one is measurably apart, null when unmeasured or not stated", () => {
  const c = control(1);
  assert.equal(turnbackOf(c, W.a0).physicalAttachment, true);
  assert.deepEqual(turnbackOf(c, W.a0).facilityAttachments.map((f) => [f.kind, f.attached]).sort(), [["platform", true], ["turnback-track", true]]);
  assert.equal(turnbackOf(c, W.b2).physicalAttachment, false);
  assert.deepEqual(turnbackOf(c, W.b2).facilityAttachments.map((f) => f.attached), [false]);
  assert.equal(turnbackOf(c, W.b1).physicalAttachment, null);
  assert.equal(turnbackOf(c, W.b1).unknownReasons.physicalAttachment, "no-platform-data");
  assert.equal(turnbackOf(c, W.A1.fromStationId).physicalAttachment, null);
  assert.ok(c.spatialFlags.includes("turnback-attachment-confirmed") && c.spatialFlags.includes("turnback-not-attached"));
  // a geometry with no terminal data at all: every station is null with the geometry's own reason
  const bare = makeWorld({ withTerminals: false });
  const none = control(1, { world: bare });
  assert.ok(none.turnbackCandidates.every((t) => t.physicalAttachment === null && t.unknownReasons.physicalAttachment === "no-terminal-data"));
  assert.ok(none.spatialFlags.includes("terminal-data-missing") && none.spatialFlags.includes("no-turnback-facility-stated"));
});

test("physicalAttachment is only a statement about track: the candidate carries no verdict, ranking or capability field", () => {
  const c = control(1, { drawn: { location: alongPoint(W.A1, 0.5) }, doc: { accessPoints: [{ key: "g", kind: "road-access", location: [139.015, 35.0004], basis: "player", roadWidthMeters: 5 }], emergencyVehicleWidthMeters: 2.5 }, extra: { spatial: SPATIAL, stationSites: STATION_SITES } });
  assert.deepEqual(fieldNames(c).filter((k) => FORBIDDEN.test(k)), []);
  const view = buildRailwayServiceControlView({ exportData: { controls: [c], inactive: [], warnings: [] } });
  assert.deepEqual(fieldNames(view).filter((k) => FORBIDDEN.test(k)), []);
});

// --- a particular block versus the whole section ---
test("a whole-section event affects every block of the section; a block event only that block, but the suspended range still holds whole sections", () => {
  const whole = control(1, { event: { trackSegmentId: trackId(W.G, W.A0) } });
  assert.equal(whole.scope, "section");
  assert.deepEqual(whole.affectedBlockIds, blocksOf(W.G, W.A0).map((b) => b.blockId).sort());
  assert.ok(whole.spatialFlags.includes("whole-section-affected"));
  const one = blocksOf(W.G, W.A0)[1];
  const single = control(2, { event: { trackSegmentId: trackId(W.G, W.A0), blockId: one.blockId } });
  assert.equal(single.scope, "block");
  assert.deepEqual(single.affectedBlockIds, [one.blockId]);
  assert.ok(single.spatialFlags.includes("single-block-affected") && !single.spatialFlags.includes("whole-section-affected"));
  assert.deepEqual(single.affectedSectionIds, whole.affectedSectionIds);
  for (const s of single.partialSuspensionCandidates) {
    assert.ok(s.suspendedSectionIds.includes(W.A0.sectionId));
    assert.ok(blocksOf(W.G, W.A0).every((b) => s.suspendedBlockIds.includes(b.blockId)), "the whole section stops, not only the block");
  }
});

test("a section with no block data keeps its blocks null, never []", () => {
  const out = control(1, { event: { trackSegmentId: trackId(W.G, W.EXT_SECTION) } });
  assert.equal(out.affectedBlockIds, null);
  assert.equal(out.unknownReasons.affectedBlockIds, "external-alignment-not-in-source");
  assert.ok(out.partialSuspensionCandidates.every((s) => s.suspendedBlockIds === null && s.unknownReasons.suspendedBlockIds === "external-alignment-not-in-source"));
});

test("which track is affected: the application maps the map section to the track segment; a stale application is ignored with a warning", () => {
  const c = control(1);
  assert.deepEqual(c.affectedTrackSegmentIds, [trackId(W.G, W.A1)]);
  assert.deepEqual(c.affectedSectionIds, [W.A1.sectionId]);
  const extra = { sections: [...W.APP.sections, { trackSegmentId: "track-segment:second-track", railCapacitySectionId: W.A1.sectionId }] };
  const site = siteFor(1);
  const two = buildRailwayServiceControl({ eventId: site.eventId }, { ...ctxOf(site), application: { ...W.APP, ...extra } }).control;
  assert.deepEqual(two.affectedTrackSegmentIds, [trackId(W.G, W.A1), "track-segment:second-track"].sort());
  const stale = buildRailwayServiceControl({ eventId: site.eventId }, { ...ctxOf(site), application: { ...W.APP, ...extra, railGeometryRevision: "rail-geometry-revision:old" } });
  assert.deepEqual(stale.control.affectedTrackSegmentIds, [trackId(W.G, W.A1)]);
  assert.deepEqual(stale.warnings.map((w) => w.code), ["application-stale"]);
  const none = buildRailwayServiceControl({ eventId: site.eventId }, { ...ctxOf(site), application: null }).control;
  assert.deepEqual(none.affectedTrackSegmentIds, [trackId(W.G, W.A1)], "without an application only the event's own track id is known");
});

test("the single or double track the player stated is a flag; an unstated track count is a flag too, not a guess", () => {
  assert.ok(control(1).spatialFlags.includes("single-track-section-affected"));
  assert.ok(control(2, { event: { trackSegmentId: trackId(W.G, W.B0) } }).spatialFlags.includes("double-track-section-affected"));
  assert.ok(control(3, { event: { trackSegmentId: trackId(W.G, W.A0) } }).spatialFlags.includes("track-count-unknown"));
});

// --- the candidate lists and their ids ---
test("turnback candidates: the stations on both sides of the affected section, with the geometry's own ids", () => {
  const c = control(1);
  assert.deepEqual(c.turnbackCandidates.map((t) => t.stationId).sort(), [W.a0, W.A1.fromStationId, W.A1.toStationId, W.b1, W.b2].sort());
  const at = (id) => turnbackOf(c, id);
  assert.deepEqual([at(W.A1.fromStationId).adjacentToDisruption, at(W.A1.toStationId).adjacentToDisruption, at(W.a0).adjacentToDisruption], [true, true, false]);
  assert.deepEqual([at(W.a0).sectionsFromDisruption, at(W.b1).sectionsFromDisruption, at(W.b2).sectionsFromDisruption], [1, 1, 2]);
  assert.ok(at(W.a0).approachSectionIds.every((id) => id !== W.A1.sectionId) && at(W.a0).approachSectionIds.includes(W.A0.sectionId));
  const terminal = W.G.terminals.find((t) => t.stationId === W.a0);
  assert.equal(at(W.a0).terminalResourceId, terminal.terminalResourceId);
  assert.deepEqual(at(W.a0).platformCandidateIds, terminal.platformCandidates.map((p) => p.platformCandidateId));
  assert.deepEqual(at(W.a0).turnbackTrackCandidateIds, terminal.turnbackCandidates.map((t) => t.turnbackCandidateId));
  assert.deepEqual(at(W.a0).location, W.A0.startLocation);
  assert.deepEqual(at(W.A1.fromStationId).junctionResourceIds, W.G.junctions.filter((j) => j.key === "mid").map((j) => j.junctionResourceId).filter(() => false), "no junction within 50 m of a1");
  assert.deepEqual(at(W.A1.toStationId).junctionResourceIds, [W.G.junctions.find((j) => j.key === "end").junctionResourceId], "the junction at a2 is within 50 m");
  assert.equal(new Set(ids(c.turnbackCandidates)).size, 5);
});

test("partial suspension candidates: every station pair that brackets the affected section, the sections between, the rest retained, ids that resolve", () => {
  const c = control(1);
  const sus = c.partialSuspensionCandidates;
  assert.equal(sus.length, 6, "2 ways on one side x 3 on the other");
  const turnbackIds = new Set(ids(c.turnbackCandidates));
  const allSections = new Set(W.G.sections.map((s) => s.sectionId));
  for (const s of sus) {
    assert.ok(s.suspendedSectionIds.includes(W.A1.sectionId));
    assert.deepEqual([...s.suspendedSectionIds, ...s.retainedSectionIds].sort(), [...allSections].sort(), "suspended and retained partition the geometry");
    assert.ok(turnbackIds.has(s.startTurnbackCandidateId) && turnbackIds.has(s.endTurnbackCandidateId), "the boundary stations are turnback candidates");
    assert.equal(s.startTurnbackCandidateId, stableId("railway-control-turnback", c.controlGeometryId, s.startStationId));
    assert.deepEqual(s.geometry.boundaryLocations.length, 2);
    assert.equal(s.geometry.sectionAlignments.length, s.suspendedSectionIds.length);
    assert.equal(typeof s.geometry.suspendedLengthMeters, "number");
  }
  const smallest = sus.find((s) => s.suspendedSectionIds.length === 1);
  assert.deepEqual([smallest.startStationId, smallest.endStationId].sort(), [W.A1.fromStationId, W.A1.toStationId].sort());
  assert.deepEqual(smallest.isolatedStationIds, [], "both end stations keep a section in service");
  const long = sus.find((s) => s.suspendedSectionIds.length === 4);
  assert.ok([long.startStationId, long.endStationId].includes(W.a0) && [long.startStationId, long.endStationId].includes(W.b2));
  assert.deepEqual(long.isolatedStationIds, [W.a0, W.A1.fromStationId, W.A1.toStationId, W.b1, W.b2].sort(), "every station of the range is left with no track in service, the two line ends included");
  assert.deepEqual(long.retainedSectionIds.filter((id) => W.G.sections.find((s) => s.sectionId === id).sourceKind === "plan"), []);
  assert.deepEqual(smallest.boundaryJunctionResourceIds, [W.G.junctions.find((j) => j.key === "end").junctionResourceId], "the junction at a2 joins a suspended and a retained section");
});

test("replacement connections: [] when the geometry has existing lines and none meets the range, null when it has none at all", () => {
  const withLine = control(1).partialSuspensionCandidates;
  assert.ok(withLine.every((s) => Array.isArray(s.replacementConnectionStationIds)));
  const noLineG = buildRailGeometry({ key: "g2", planIds: [W.A.planId, W.B.planId], designedRevisions: revisionsOf(W.A, W.B) }, { pack, plans: W.mapExport.plans, externalNetworks: [], routes: [] }).design;
  const world = { ...W, G: noLineG, APP: applicationOf(noLineG), A1: sectionOf(noLineG, W.A, 1) };
  const c = control(1, { world });
  assert.ok(c.partialSuspensionCandidates.every((s) => s.replacementConnectionStationIds === null && s.unknownReasons.replacementConnectionStationIds === "no-existing-line-in-geometry"));
});

test("detour candidates: only paths the geometry and the through route state; handovers, other-company owners and unknown external connections are kept apart", () => {
  const c = control(1);
  assert.equal(c.detourCandidates.length, 1);
  const d = c.detourCandidates[0];
  const extSections = W.G.sections.filter((s) => s.sourceKind === "external").map((s) => s.sectionId).sort();
  assert.deepEqual([...d.sectionIds].sort(), extSections);
  assert.deepEqual(d.externalLineIds, [EXT]);
  assert.deepEqual(d.handoverIds, W.route.handovers.map((h) => h.handoverId).sort(), "both links are handovers of the route");
  assert.deepEqual(d.infrastructureOwnerIds, ["owner:other"]);
  assert.equal(d.alignment, null);
  assert.equal(d.unknownReasons.alignment, "external-alignment-not-in-source");
  assert.equal(d.physicalConnection, null, "an existing line's connection is not in the source: unknown, not true or false");
  assert.equal(d.unknownReasons.physicalConnection, "external-topology-not-in-source");
  assert.equal(d.connections.length, 3);
  assert.ok(d.connections.every((x) => x.physicalConnection === null && x.unknownReasons.physicalConnection === "external-topology-not-in-source"));
  assert.deepEqual([d.startStationId, d.endStationId].sort(), [W.A1.fromStationId, W.A1.toStationId].sort());
  assert.deepEqual(d.junctionResourceIds, []);
  assert.ok(!c.spatialFlags.includes("no-detour-in-geometry"));
});

test("a detour over measured tracks joined end to end is physicalConnection true, with its alignment", () => {
  const extra = line("c", [[139.01, 35], [139.015, 35.003], [139.02, 35]]);
  const map = buildMapExport({ pack, mode: "existing", drawnLines: [line("a", [[139, 35], [139.01, 35], [139.02, 35]]), line("b", [[139.02, 35], [139.03, 35], [139.04, 35]]), extra] });
  const [A, B, C] = ["a", "b", "c"].map((k) => map.plans.find((p) => p.planId === stableId("plan", "t", "key", k)));
  const G = buildRailGeometry({ key: "g3", planIds: [A.planId, B.planId, C.planId], designedRevisions: revisionsOf(A, B, C) }, { pack, plans: map.plans, externalNetworks: [], routes: [] }).design;
  const world = { G, APP: applicationOf(G), mapExport: map, route: null, A1: sectionOf(G, A, 1) };
  const c = control(1, { world });
  assert.equal(c.detourCandidates.length, 1);
  const d = c.detourCandidates[0];
  assert.equal(d.sectionIds.length, 2);
  assert.equal(d.physicalConnection, true);
  assert.ok(d.connections.every((x) => x.physicalConnection === true));
  assert.ok(Array.isArray(d.alignment) && d.alignment.length >= 3);
  assert.equal(d.handoverIds, null, "no through route in this geometry");
  assert.equal(d.unknownReasons.handoverIds, "no-through-route");
  assert.equal(d.infrastructureOwnerIds, null, "who owns a planned track is not in the map");
  assert.equal(d.unknownReasons.infrastructureOwnerIds, "owner-not-in-source-data");
});

test("without the through route no link exists: no detour is listed ([] with a flag) and the route's absence is flagged; a stale route is ignored", () => {
  const site = siteFor(1);
  const none = buildRailwayServiceControl({ eventId: site.eventId }, { ...ctxOf(site), routes: [] }).control;
  assert.deepEqual(none.detourCandidates, []);
  assert.ok(none.spatialFlags.includes("no-detour-in-geometry") && none.spatialFlags.includes("through-route-not-supplied"));
  const stale = buildRailwayServiceControl({ eventId: site.eventId }, { ...ctxOf(site), routes: [{ ...W.route, geometryRevision: "through-route-revision:old" }] });
  assert.deepEqual(stale.control.detourCandidates, []);
  assert.deepEqual(stale.warnings.map((w) => w.code), ["through-route-stale"]);
});

test("a long line lists service suspension only a few sections out and says so; a long detour is not listed and says so", () => {
  const long = line("long", Array.from({ length: 9 }, (_, i) => [139 + i * 0.01, 35.2]));
  const loop = line("loop", [[139, 35.2], [139.08, 35.2]]);
  const map = buildMapExport({ pack, mode: "existing", drawnLines: [long, loop] });
  const [L, Q] = ["long", "loop"].map((k) => map.plans.find((p) => p.planId === stableId("plan", "t", "key", k)));
  const G = buildRailGeometry({ key: "g4", planIds: [L.planId, Q.planId], designedRevisions: revisionsOf(L, Q) }, { pack, plans: map.plans, externalNetworks: [], routes: [] }).design;
  const base = { G, APP: applicationOf(G), mapExport: map, route: null };
  const middle = control(1, { world: { ...base, A1: sectionOf(G, L, 3) } });
  assert.ok(middle.spatialFlags.includes("partial-suspension-enumeration-limited"));
  assert.ok(middle.partialSuspensionCandidates.every((s) => s.suspendedSectionIds.length <= 7));
  const shortcut = control(2, { world: { ...base, A1: sectionOf(G, Q, 0) } });
  assert.ok(shortcut.spatialFlags.includes("detour-enumeration-limited"), "the 8-section way round is longer than the listing limit");
  assert.deepEqual(shortcut.detourCandidates, []);
});

// --- evacuation access ---
test("evacuation access: stations, entrances, stated points and the nearest road point, each with its measured distance; the nearest of a kind is marked", () => {
  const c = control(1, {
    drawn: { location: alongPoint(W.A1, 0.5) },
    doc: { accessPoints: [{ key: "wide", kind: "road-access", location: [139.0152, 35.0004], basis: "player", roadWidthMeters: 6, name: "Service road" }, { key: "narrow", kind: "entrance", location: [139.0148, 35.0006], basis: "player" }], emergencyVehicleWidthMeters: 2.5 },
    extra: { spatial: SPATIAL, stationSites: STATION_SITES },
  });
  const kinds = (k) => c.evacuationAccessCandidates.filter((e) => e.kind === k);
  assert.equal(kinds("station").length, 2);
  assert.equal(kinds("entrance").length, 1);
  assert.equal(kinds("player-access-point").length, 2);
  assert.equal(kinds("road-point").length, 1);
  assert.ok(c.evacuationAccessCandidates.every((e) => e.distanceBasis === "location" && typeof e.distanceMeters === "number"));
  assert.equal(kinds("entrance")[0].refId, "ent:north");
  assert.equal(kinds("entrance")[0].stationId, W.A1.fromStationId);
  assert.equal(kinds("entrance")[0].nearestRoad.roadClass, "minor");
  assert.equal(kinds("road-point")[0].roadAdjacent, true);
  const [near, far] = [...kinds("player-access-point")].sort((a, b) => a.distanceMeters - b.distanceMeters);
  assert.deepEqual([near.nearestOfKind, far.nearestOfKind], [true, false]);
  assert.ok(c.sourceLayers.some((l) => l.layer === "roads") && c.sourceLayers.some((l) => l.layer === "station-site-geometry"));
});

test("a road existing is not a vehicle passing: width is null without data, and only compared against a width the player stated", () => {
  const points = [{ key: "wide", kind: "road-access", location: [139.0152, 35.0004], basis: "player", roadWidthMeters: 6 }, { key: "thin", kind: "road-access", location: [139.0151, 35.0004], basis: "player", roadWidthMeters: 2 }, { key: "unknown", kind: "road-access", location: [139.0153, 35.0004], basis: "player" }];
  const withVehicle = control(1, { drawn: { location: alongPoint(W.A1, 0.5) }, doc: { accessPoints: points, emergencyVehicleWidthMeters: 2.5 }, extra: { spatial: SPATIAL } });
  const byKey = (c, key) => c.evacuationAccessCandidates.find((e) => e.refId === `key:${key}`);
  assert.equal(byKey(withVehicle, "wide").roadWidthAtLeastVehicleWidth, true);
  assert.equal(byKey(withVehicle, "thin").roadWidthAtLeastVehicleWidth, false);
  assert.equal(byKey(withVehicle, "unknown").roadWidthAtLeastVehicleWidth, null);
  assert.equal(byKey(withVehicle, "unknown").unknownReasons.roadWidthAtLeastVehicleWidth, "road-width-not-in-source");
  assert.ok(byKey(withVehicle, "wide").roadAdjacent === true, "the road exists");
  const noVehicle = control(1, { doc: { accessPoints: points }, extra: { spatial: SPATIAL } });
  assert.equal(byKey(noVehicle, "wide").roadWidthMeters, 6);
  assert.equal(byKey(noVehicle, "wide").roadWidthAtLeastVehicleWidth, null);
  assert.equal(byKey(noVehicle, "wide").unknownReasons.roadWidthAtLeastVehicleWidth, "emergency-vehicle-width-not-stated");
  const stations = withVehicle.evacuationAccessCandidates.filter((e) => e.kind === "station");
  assert.ok(stations.every((e) => e.roadWidthMeters === null && e.roadWidthAtLeastVehicleWidth === null && e.unknownReasons.roadWidthMeters === "road-width-not-in-source"), "the road layer has no width");
});

test("no road layer, no entrances and no stated points: the access candidates are the stations only, with unknown road facts as null and the flags set", () => {
  const c = control(1);
  assert.deepEqual(c.evacuationAccessCandidates.map((e) => e.kind), ["station", "station"]);
  for (const e of c.evacuationAccessCandidates) {
    assert.deepEqual([e.roadAdjacent, e.nearestRoad], [null, null]);
    assert.equal(e.unknownReasons.roadAdjacent, "no-road-layer");
    assert.equal(e.distanceBasis, "affected-extent", "no stated location: measured to the stretch, which the stations end");
  }
  assert.ok(c.spatialFlags.includes("road-data-missing") && c.spatialFlags.includes("entrance-data-missing"));
  const outside = control(1, { extra: { spatial: makeSpatialContext({ roads: { ...roads, covers: () => false } }) } });
  assert.ok(outside.evacuationAccessCandidates.every((e) => e.roadAdjacent === null && e.unknownReasons.roadAdjacent === "outside-road-coverage"));
});

test("with no stated location the distance is measured to the affected stretch; with no alignment either it is null", () => {
  const onAlignment = control(1, { extra: { spatial: SPATIAL } });
  assert.ok(onAlignment.evacuationAccessCandidates.every((e) => e.distanceBasis === "affected-extent" && typeof e.distanceMeters === "number"));
  assert.equal(onAlignment.disruptionLocation, null);
  const external = control(1, { event: { trackSegmentId: trackId(W.G, W.EXT_SECTION) } });
  assert.equal(external.affectedAlignment, null);
  assert.ok(external.evacuationAccessCandidates.every((e) => e.distanceMeters === null && e.distanceBasis === null));
  assert.ok(external.spatialFlags.includes("external-alignment-unknown") && external.spatialFlags.includes("location-unknown"));
});

// --- data that is not there ---
test("an existing line has no alignment: its turnbacks, suspensions and detours are still listed from station ids, with unknowns marked", () => {
  const c = control(1, { event: { trackSegmentId: trackId(W.G, W.EXT_SECTION) } });
  assert.ok(c.turnbackCandidates.length >= 2);
  assert.ok(c.partialSuspensionCandidates.every((s) => s.geometry.suspendedLengthMeters === null && s.geometry.unknownReasons.suspendedLengthMeters === "external-alignment-not-in-source"));
  assert.ok(c.detourCandidates.every((d) => d.alignment === null));
  assert.deepEqual(c.affectedSectionIds, [W.EXT_SECTION.sectionId]);
});

test("an event on a train has no place on the map: every candidate list is null with the reason, the control still builds", () => {
  const c = control(1, { event: { kind: "vehicle-failure", trackSegmentId: null, trainId: "train:7" } });
  for (const f of ["affectedTrackSegmentIds", "affectedSectionIds", "affectedBlockIds", "turnbackCandidates", "partialSuspensionCandidates", "detourCandidates", "evacuationAccessCandidates"]) {
    assert.equal(c[f], null, f);
    assert.equal(c.unknownReasons[f], "train-position-not-in-map", f);
  }
  assert.ok(c.spatialFlags.includes("train-position-not-in-map"));
});

test("an event not yet linked to a map section is null with the reason, not guessed", () => {
  const c = control(1, { event: { trackSegmentId: "track-segment:unlinked" } });
  assert.equal(c.turnbackCandidates, null);
  assert.equal(c.unknownReasons.turnbackCandidates, "no-section-link");
});

test("unknown[] and unknownReasons are 1:1 everywhere, and every unknown value is null", () => {
  const cases = [
    control(1, { drawn: { location: alongPoint(W.A1, 0.5) }, doc: { accessPoints: [{ key: "p", kind: "road-access", location: [139.015, 35.0004], basis: "player", roadWidthMeters: 4 }] }, extra: { spatial: SPATIAL, stationSites: STATION_SITES } }),
    control(2, { event: { trackSegmentId: trackId(W.G, W.A0), blockId: blocksOf(W.G, W.A0)[0].blockId } }),
    control(3, { event: { trackSegmentId: trackId(W.G, W.EXT_SECTION) } }),
    control(4, { event: { kind: "vehicle-failure", trackSegmentId: null, trainId: "train:7" } }),
    control(5, { event: { trackSegmentId: "track-segment:unlinked" } }),
    control(6, { world: makeWorld({ withTerminals: false, withRoute: false }) }),
  ];
  cases.forEach((c, i) => { assertUnknownContract(c, `control ${i}`); assert.deepEqual([...c.unknown], Object.keys(c.unknownReasons).sort()); });
});

// --- links and rejections ---
test("site, geometry and document links are validated", () => {
  rejected({}, "event-missing");
  rejected({ eventId: "railway-disruption:99" }, "document-event-mismatch");
  rejected({ eventId: "railway-disruption:1" }, "site-schema-invalid", { site: { ...siteFor(1), schema: "other/1" } });
  rejected({ eventId: "railway-disruption:1" }, "site-other-pack", { site: { ...siteFor(1), sourcePackId: "elsewhere" } });
  rejected({ eventId: "railway-disruption:1" }, "rail-geometry-schema-invalid", { extra: { railGeometry: { ...W.G, schema: "other/1" } } });
  rejected({ eventId: "railway-disruption:1" }, "rail-geometry-other-pack", { extra: { railGeometry: { ...W.G, sourcePackId: "elsewhere" } } });
  rejected({ eventId: "railway-disruption:1" }, "site-geometry-mismatch", { site: { ...siteFor(1), railGeometryId: "rail-geometry:other" } });
  rejected({ eventId: "railway-disruption:1" }, "site-geometry-revision-mismatch", { site: { ...siteFor(1), railGeometryRevision: "rail-geometry-revision:old" } });
  rejected({ eventId: "railway-disruption:1" }, "affected-section-missing", { site: { ...siteFor(1), affectedSectionIds: ["rail-section:nope"] } });
  rejected({ eventId: "railway-disruption:1" }, "several-affected-sections", { site: { ...siteFor(1), affectedSectionIds: [W.A0.sectionId, W.A1.sectionId] } });
});

test("candidate ids in every list resolve to the ids of the geometry they name", () => {
  const c = control(1);
  const sectionIds = new Set(W.G.sections.map((s) => s.sectionId));
  const junctionIds = new Set(W.G.junctions.map((j) => j.junctionResourceId));
  for (const t of c.turnbackCandidates) { t.approachSectionIds.forEach((id) => assert.ok(sectionIds.has(id))); (t.junctionResourceIds ?? []).forEach((id) => assert.ok(junctionIds.has(id))); }
  for (const s of c.partialSuspensionCandidates) { s.suspendedSectionIds.concat(s.retainedSectionIds).forEach((id) => assert.ok(sectionIds.has(id))); s.boundaryJunctionResourceIds.forEach((id) => assert.ok(junctionIds.has(id))); }
  for (const d of c.detourCandidates) { d.sectionIds.forEach((id) => assert.ok(sectionIds.has(id))); d.handoverIds.forEach((id) => assert.ok(W.route.handovers.some((h) => h.handoverId === id))); }
  const all = [...c.turnbackCandidates, ...c.partialSuspensionCandidates, ...c.detourCandidates, ...c.evacuationAccessCandidates];
  assert.equal(new Set(ids(all)).size, all.length, "no id is shared between kinds");
});

// --- the export ---
test("the export builds active documents, lists a switched-off one by id, and names what it cannot build", () => {
  const s1 = siteFor(1);
  const s2 = siteFor(2, { trackSegmentId: trackId(W.G, W.B0) });
  const exp = buildRailwayServiceControlExport({ pack, sites: [s1, s2], railGeometries: [W.G], applications: [W.APP], routes: [W.route], documents: [{ eventId: s1.eventId }, { eventId: s2.eventId, active: false }, { eventId: s1.eventId }, { eventId: "railway-disruption:9" }] });
  assert.equal(exp.schema, RAILWAY_SERVICE_CONTROL_EXPORT_SCHEMA);
  assert.deepEqual(exp.controls.map((c) => c.eventId), [s1.eventId]);
  assert.deepEqual(exp.inactive, [{ eventId: s2.eventId, controlGeometryId: controlGeometryIdOf("t", s2.eventId) }]);
  assert.deepEqual(exp.warnings.map((w) => w.code), ["duplicate-railway-service-control", "railway-service-control-rejected"]);
  assert.equal(exp.warnings[1].reasons[0].code, "site-missing");
  const noGeometry = buildRailwayServiceControlExport({ pack, sites: [s1], railGeometries: [], documents: [{ eventId: s1.eventId }] });
  assert.equal(noGeometry.warnings[0].reasons[0].code, "rail-geometry-missing");
});

// --- the module's own limits ---
test("no management, engine-state or train import and no money, clock or file access in any new map module", () => {
  for (const file of ["railway-service-control", "railway-service-control-candidates", "railway-service-control-editor", "railway-service-control-view"]) {
    const text = fs.readFileSync(path.join(here, "..", "src", "map", `${file}.mjs`), "utf8");
    assert.ok(text.length < 40_000, `${file} holds code, not data`);
    for (const m of text.matchAll(/from "([^"]+)"/g)) assert.match(m[1], /^\.\/[a-z-]+\.mjs$/, `${file} imports ${m[1]}`);
    assert.equal(/from\s+["'][^"']*management/.test(text), false, file);
    assert.equal(/from\s+["'][^"']*(railway-disruptions|railway-traffic-control|rail-capacity-integration|scenario-runtime|trains|state|game)\.mjs/.test(text), false, file);
    assert.equal(/ledger|\.commit\(|\.settle\(|\.post\(|node:fs|Date\.now|Math\.random|state\.(trains|lines|trackSegments|railwayDisruptions)/.test(text.replace(/\/\/.*$/gm, "")), false, file);
  }
});

test("a map control geometry does not touch cash, trains or disruption state: a stand-in engine state is unchanged after building, editing and viewing", () => {
  const state = deepFreeze({ cash: 1_000_000, ledger: [{ id: 1 }], trains: [{ id: "train:7", lineId: "line:1" }], trackSegments: [{ id: "track-segment:1" }], railwayDisruptions: { events: [ev(1)], nextSequence: 2 } });
  const before = JSON.stringify(state);
  const doc = newRailwayServiceControlDoc("t", "1");
  addControl(doc, "railway-disruption:1");
  const site = siteFor(1);
  const exp = buildRailwayServiceControlExport({ pack, sites: [site], railGeometries: [W.G], applications: [W.APP], routes: [W.route], documents: doc.controls.map(toControlDocument) });
  selectCandidate(doc, "railway-disruption:1", "turnback", exp.controls[0].turnbackCandidates[0].candidateId, exp.controls[0]);
  buildRailwayServiceControlView({ exportData: exp, selections: selectionsOf(doc) });
  assert.equal(JSON.stringify(state), before);
});

// --- editor ---
test("editor: candidates are chosen from what the geometry offers, per kind, and cleared one by one or all at once", () => {
  const c = control(1);
  const doc = newRailwayServiceControlDoc("t", "1");
  addControl(doc, c.eventId);
  const pick = (kind, id) => selectCandidate(doc, c.eventId, kind, id, c);
  pick("turnback", c.turnbackCandidates[0].candidateId);
  pick("turnback", c.turnbackCandidates[1].candidateId);
  pick("partialSuspension", c.partialSuspensionCandidates[0].candidateId);
  pick("partialSuspension", c.partialSuspensionCandidates[1].candidateId);
  pick("detour", c.detourCandidates[0].candidateId);
  pick("evacuation", c.evacuationAccessCandidates[0].candidateId);
  const chosen = selectionsOf(doc)[c.eventId];
  assert.equal(chosen.turnback.length, 2, "several turnbacks can be chosen");
  assert.deepEqual(chosen.partialSuspension, [c.partialSuspensionCandidates[1].candidateId], "service is suspended between one pair of stations: the last choice replaces");
  assert.throws(() => pick("turnback", "railway-control-turnback:made-up"), /Unknown turnback candidate/);
  assert.throws(() => pick("turnback", c.detourCandidates[0].candidateId), /Unknown turnback candidate/, "an id of another kind is not accepted");
  assert.throws(() => pick("scoring", "x"), /Unknown selection kind/);
  deselectCandidate(doc, c.eventId, "turnback", c.turnbackCandidates[0].candidateId);
  assert.deepEqual(selectionsOf(doc)[c.eventId].turnback, [c.turnbackCandidates[1].candidateId]);
  clearSelection(doc, c.eventId, "detour");
  assert.deepEqual(selectionsOf(doc)[c.eventId].detour, []);
  clearSelection(doc, c.eventId);
  assert.ok(Object.values(selectionsOf(doc)[c.eventId]).every((l) => l.length === 0));
  const stateless = control(2, { world: makeWorld({ withRoute: false }), event: { kind: "vehicle-failure", trackSegmentId: null, trainId: "t" } });
  assert.throws(() => selectCandidate(doc, c.eventId, "turnback", "x", stateless), /no turnbackCandidates to choose from/);
});

test("editor: a choice made on an older geometry is marked outdated, and one the geometry no longer offers is stale", () => {
  const c = control(1);
  const doc = newRailwayServiceControlDoc("t", "1");
  addControl(doc, c.eventId);
  selectCandidate(doc, c.eventId, "turnback", c.turnbackCandidates[0].candidateId, c);
  selectCandidate(doc, c.eventId, "detour", c.detourCandidates[0].candidateId, c);
  assert.deepEqual(reconcileSelections(doc, c.eventId, c).current.map((s) => s.outdated), [false, false]);
  const later = control(1, { doc: { accessPoints: [{ key: "g", kind: "entrance", location: [139.015, 35.0004], basis: "player" }] } });
  assert.deepEqual(reconcileSelections(doc, c.eventId, later).current.map((s) => s.outdated), [true, true]);
  const without = { ...later, detourCandidates: [] };
  const r = reconcileSelections(doc, c.eventId, without);
  assert.deepEqual(r.stale, [{ kind: "detour", candidateId: c.detourCandidates[0].candidateId, reason: "candidate-no-longer-offered" }]);
});

test("editor: access points and the vehicle width are the player's statements; an entry is switched off, never deleted", () => {
  const doc = newRailwayServiceControlDoc("t", "1");
  const entry = addControl(doc, "railway-disruption:1");
  assert.equal(addControl(doc, "railway-disruption:1"), entry, "an event keeps its entry");
  assert.equal(entry.accessPoints, null, "no statement is not an empty statement");
  addAccessPoint(doc, "railway-disruption:1", { key: "gate", kind: "entrance", location: [139.015, 35.0004] });
  assert.equal(entry.accessPoints[0].basis, "player");
  removeAccessPoint(doc, "railway-disruption:1", "gate");
  assert.deepEqual(entry.accessPoints, []);
  setEmergencyVehicleWidth(doc, "railway-disruption:1", 2.5);
  assert.equal(entry.emergencyVehicleWidthMeters, 2.5);
  setEmergencyVehicleWidth(doc, "railway-disruption:1", -1);
  assert.equal(entry.emergencyVehicleWidthMeters, null);
  deactivateControl(doc, "railway-disruption:1");
  assert.equal(activeControls(doc).length, 0);
  assert.equal(doc.controls.length, 1);
  restoreControl(doc, "railway-disruption:1");
  assert.equal(activeControls(doc).length, 1);
  assert.deepEqual(Object.keys(editorModule).filter((k) => /^(remove|delete|drop)(Control|Selection)/i.test(k)), [], "an entry has no delete");
  assert.throws(() => deselectCandidate(doc, "railway-disruption:404", "turnback", "x"), /Unknown service control/);
});

test("saving and restoring keeps every entry, choice and id; another pack's save is refused", () => {
  const c = control(1);
  const doc = newRailwayServiceControlDoc("t", "1");
  addControl(doc, c.eventId);
  selectCandidate(doc, c.eventId, "turnback", c.turnbackCandidates[0].candidateId, c);
  addAccessPoint(doc, c.eventId, { key: "gate", kind: "entrance", location: [139.015, 35.0004] });
  const text = serializeRailwayServiceControlDoc(doc);
  const back = restoreRailwayServiceControlDoc(text, pack);
  assert.deepEqual(back.doc, doc);
  assert.equal(serializeRailwayServiceControlDoc(back.doc), text);
  const rebuilt = buildRailwayServiceControl(toControlDocument(back.doc.controls[0]), ctxOf(siteFor(1))).control;
  assert.equal(rebuilt.controlGeometryId, c.controlGeometryId, "the id survives save and reopen");
  assert.deepEqual(selectionsOf(back.doc)[c.eventId].turnback, [c.turnbackCandidates[0].candidateId]);
  const other = restoreRailwayServiceControlDoc(text, { manifest: { id: "other", version: "1" } });
  assert.deepEqual(other.doc.controls, []);
  assert.equal(other.warnings[0].code, "railway-service-control-doc-other-pack");
  assert.equal(restoreRailwayServiceControlDoc("{not json", pack).warnings[0].code, "railway-service-control-doc-unreadable");
  assert.equal(restoreRailwayServiceControlDoc(JSON.stringify({ version: 9 }), pack).warnings[0].code, "railway-service-control-doc-version");
  assert.equal(restoreRailwayServiceControlDoc(text, { manifest: { id: "t", version: "2" } }).warnings[0].code, "pack-version-mismatch");
  assert.deepEqual(restoreRailwayServiceControlDoc(null, pack).doc.controls, []);
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
const BANNED_TEXT = /원|비용|공기|승인|확률|가능|불가|복구|지연|보상|평판|손실/;
const viewControl = () => control(1, { drawn: { location: alongPoint(W.A1, 0.5) }, doc: { accessPoints: [{ key: "g", kind: "road-access", location: [139.0152, 35.0004], basis: "player", roadWidthMeters: 6 }], emergencyVehicleWidthMeters: 2.5 }, extra: { spatial: SPATIAL, stationSites: STATION_SITES } });

test("view: the five kinds have different colours, glyphs and lines, and an attached, apart and unmeasured facility look different", () => {
  const styles = Object.values(CANDIDATE_STYLES);
  assert.equal(new Set(styles.map((s) => s.color)).size, styles.length);
  assert.equal(new Set(styles.map((s) => s.glyph)).size, styles.length);
  assert.notDeepEqual(CANDIDATE_STYLES.suspension.dash, CANDIDATE_STYLES.detour.dash);
  assert.equal(new Set(Object.values(ATTACHMENT_STYLES).map((s) => s.glyph)).size, 3);
  const c = viewControl();
  const model = buildRailwayServiceControlView({ exportData: { controls: [c], inactive: [], warnings: [] } });
  assert.equal(model.schema, "transitline.railway-service-control-map-view/1");
  const m = model.controls[0];
  assert.deepEqual([m.counts.turnback, m.counts.partialSuspension, m.counts.detour].map(Boolean), [true, true, true]);
  assert.deepEqual(new Set(m.turnbacks.map((t) => t.attachment.key)), new Set(["attached", "not-attached", "attachment-unknown"]));
  assert.equal(m.locationText, null);
});

test("view: the chosen candidates are drawn differently, a nobody-located event gets words and no marker, and drawing is read-only", () => {
  const c = viewControl();
  const exportData = deepFreeze({ controls: [c], inactive: [], warnings: [] });
  const pickedId = c.turnbackCandidates[0].candidateId;
  const run = (selections) => { const model = buildRailwayServiceControlView({ exportData, selections }); const f = fakeCtx(); drawRailwayServiceControlOverlay(f.ctx, model, screen); return f.calls; };
  const plain = run({});
  const picked = run({ [c.eventId]: { turnback: [pickedId], partialSuspension: [c.partialSuspensionCandidates[0].candidateId], detour: [c.detourCandidates[0].candidateId], evacuation: [] } });
  const texts = (calls) => calls.filter((x) => x[0] === "fillText").map((x) => String(x[1]));
  assert.ok(texts(picked).some((t) => t.includes("✔")) && !texts(plain).some((t) => t.includes("✔")), "a chosen candidate carries a check mark");
  assert.ok(picked.filter((x) => x[0] === "stroke").length > plain.filter((x) => x[0] === "stroke").length, "a chosen candidate is drawn with extra strokes");
  for (const glyph of [CANDIDATE_STYLES.turnback.glyph, CANDIDATE_STYLES.suspension.glyph, "▣", "◉", "✕"]) assert.ok(texts(plain).includes(glyph) || texts(picked).includes(glyph), glyph);
  const unlocated = control(2, { event: { trackSegmentId: trackId(W.G, W.A0) } });
  const model = buildRailwayServiceControlView({ exportData: { controls: [unlocated], inactive: [], warnings: [] } });
  assert.equal(model.controls[0].locationText, "위치 미상—영향 범위 전체");
  const f = fakeCtx();
  drawRailwayServiceControlOverlay(f.ctx, { ...model, controls: [{ ...model.controls[0], turnbacks: [], suspensions: [], detours: [], evacuations: [] }] }, screen);
  assert.equal(f.calls.some((x) => x[0] === "arc"), false, "no marker for an unknown place");
  assert.ok(texts(f.calls).some((t) => t.includes("위치 미상")));
});

test("view: the panel and legend use textContent only and never show cost, time, loss or a usable-or-not verdict", () => {
  const c = viewControl();
  const model = buildRailwayServiceControlView({ exportData: { controls: [c], inactive: [], warnings: [{ code: "railway-service-control-rejected" }] }, selections: { [c.eventId]: { evacuation: [c.evacuationAccessCandidates[0].candidateId] } } });
  model.controls[0].evacuations[0].name = "<img src=x onerror=alert(1)>";
  const panel = fakeDom();
  renderRailwayServiceControlPanel(panel, model);
  const all = textsOf(panel);
  assert.ok(all.some((t) => t.includes("<img src=x onerror=alert(1)>")), "a player-supplied string is shown as text");
  assert.ok(all.some((t) => t.startsWith("장애 관제 후보 1건")));
  assert.ok(all.some((t) => t.includes("railway-service-control-rejected")));
  assert.ok(all.some((t) => t.includes("도로 폭")));
  assert.equal(all.some((t) => BANNED_TEXT.test(t)), false);
  const empty = fakeDom();
  renderRailwayServiceControlPanel(empty, buildRailwayServiceControlView({ exportData: { controls: [], inactive: [], warnings: [] } }));
  assert.equal(empty.hidden, true);
  const legend = fakeDom();
  renderRailwayServiceControlLegend(legend);
  const legendText = textsOf(legend);
  assert.ok(legendText.length >= 9);
  assert.equal(legendText.some((t) => BANNED_TEXT.test(t)), false);
});

// --- shipped examples: regenerated by the script, and checked against the contract ---
const examplePacks = ["tokyo", "example-radial", "example-corridor"];
const exampleDir = (id) => path.join(root, "packs", id, "railway-service-control-examples");
const readExamples = (id) => fs.readdirSync(exampleDir(id)).filter((f) => f.endsWith(".service-control.json")).sort().map((f) => ({ file: f, control: JSON.parse(fs.readFileSync(path.join(exampleDir(id), f), "utf8")) }));

test("every shipped example satisfies the contract: it is labelled synthetic, keeps its unknowns null and resolves its ids", () => {
  for (const id of examplePacks) {
    const examples = readExamples(id);
    assert.ok(examples.length >= 3, id);
    for (const { file, control: example } of examples) {
      const { source, ...body } = example;
      assert.equal(body.schema, RAILWAY_SERVICE_CONTROL_SCHEMA, `${id}/${file}`);
      assert.equal(body.sourcePackId, id);
      assert.equal(source.generatedBy, "scripts/build-railway-service-control-examples.mjs");
      assert.equal(source.synthetic, true);
      assert.equal(body.controlGeometryId, controlGeometryIdOf(id, body.eventId), file);
      assert.deepEqual(fieldNames(body).filter((k) => FORBIDDEN.test(k)), [], file);
      assertUnknownContract(body, `${id}/${file}`);
      for (const list of [body.turnbackCandidates, body.partialSuspensionCandidates, body.detourCandidates, body.evacuationAccessCandidates]) if (list) assert.equal(new Set(ids(list)).size, list.length, file);
      if (body.partialSuspensionCandidates && body.turnbackCandidates) {
        const turnbackIds = new Set(ids(body.turnbackCandidates));
        for (const s of body.partialSuspensionCandidates) assert.ok(turnbackIds.has(s.startTurnbackCandidateId) && turnbackIds.has(s.endTurnbackCandidateId), `${file}: boundary turnback ids`);
      }
      for (const [kind, key] of Object.entries(source.selection ?? {})) for (const cid of key) assert.ok(body[{ turnback: "turnbackCandidates", partialSuspension: "partialSuspensionCandidates", detour: "detourCandidates", evacuation: "evacuationAccessCandidates" }[kind]].some((x) => x.candidateId === cid), `${file}: chosen ${kind}`);
    }
  }
});

test("the example set covers every required case", () => {
  const all = examplePacks.flatMap((id) => readExamples(id).map((e) => e.control));
  const cases = new Set(all.flatMap((s) => s.source.case));
  for (const c of ["terminal-turnback", "midway-turnback-candidate", "partial-suspension", "single-track", "single-block", "other-company-detour", "external-connection-unknown", "no-turnback-facility-data", "no-evacuation-access-data"]) assert.ok(cases.has(c), c);
  const caseOf = (c) => all.filter((s) => s.source.case.includes(c));
  assert.ok(caseOf("terminal-turnback").every((s) => s.turnbackCandidates.some((t) => t.terminalResourceId !== null && t.physicalAttachment === true)));
  assert.ok(caseOf("midway-turnback-candidate").every((s) => s.turnbackCandidates.some((t) => t.terminalResourceId === null && t.physicalAttachment === null)));
  assert.ok(caseOf("partial-suspension").every((s) => s.partialSuspensionCandidates.length > 1));
  assert.ok(caseOf("single-track").every((s) => s.spatialFlags.includes("single-track-section-affected")));
  assert.ok(caseOf("single-block").every((s) => s.scope === "block" && s.affectedBlockIds.length === 1));
  assert.ok(caseOf("other-company-detour").every((s) => s.detourCandidates.some((d) => d.infrastructureOwnerIds?.length > 0 && d.sectionIds.length > 0)));
  assert.ok(caseOf("external-connection-unknown").every((s) => s.detourCandidates.some((d) => d.physicalConnection === null && /external/.test(d.unknownReasons.physicalConnection))));
  assert.ok(caseOf("no-turnback-facility-data").every((s) => s.turnbackCandidates.every((t) => t.physicalAttachment === null)));
  assert.ok(caseOf("no-evacuation-access-data").every((s) => s.evacuationAccessCandidates.every((e) => e.nearestRoad === null && e.roadAdjacent === null)));
  assert.ok(all.some((s) => s.source.selection && Object.values(s.source.selection).some((l) => l.length)), "an example shows the player's saved choice");
});

test("re-running the generator rewrites every example to the same canonical content", () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "service-control-examples-"));
  const run = spawnSync(process.execPath, [path.join(root, "scripts", "build-railway-service-control-examples.mjs"), "--out", out], { cwd: root, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const canonical = (text) => text.replaceAll("\r\n", "\n");
  for (const id of examplePacks) {
    const files = fs.readdirSync(exampleDir(id)).filter((f) => f.endsWith(".service-control.json")).sort();
    assert.deepEqual(fs.readdirSync(path.join(out, id)).sort(), files, id);
    for (const f of files) assert.equal(canonical(fs.readFileSync(path.join(out, id, f), "utf8")), canonical(fs.readFileSync(path.join(exampleDir(id), f), "utf8")), `${id}/${f}`);
  }
  fs.rmSync(out, { recursive: true, force: true });
});
