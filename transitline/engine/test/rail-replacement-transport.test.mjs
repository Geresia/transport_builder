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
import { buildRailwayDisruptionSite, disruptionSiteIdOf } from "../src/map/railway-disruption-site.mjs";
import { buildRailwayServiceControl, controlGeometryIdOf } from "../src/map/railway-service-control.mjs";
import { makeSpatialContext, polygonLayer, roadLayerFromGeojson } from "../src/map/spatial.mjs";
import {
  RAIL_REPLACEMENT_TRANSPORT_EXPORT_SCHEMA, RAIL_REPLACEMENT_TRANSPORT_SCHEMA, buildRailReplacementTransport, buildRailReplacementTransportExport, replacementGeometryIdOf,
} from "../src/map/rail-replacement-transport.mjs";
import * as editorModule from "../src/map/rail-replacement-transport-editor.mjs";
import {
  activePlans, addPlan, deactivatePlan, declareNone, deselectTurnback, newRailReplacementDoc, reconcilePlan, removeConstraint, removeRoute, removeTemporaryStop, removeTurnaroundArea,
  restorePlan, restoreRailReplacementDoc, selectTurnback, serializeRailReplacementDoc, setConstraint, setRoute, setTemporaryStop, setTurnaroundArea, setVehicleWidth, toReplacementDocument,
} from "../src/map/rail-replacement-transport-editor.mjs";
import {
  ROUTE_STYLES, STYLES, buildRailReplacementTransportView, drawRailReplacementTransportOverlay, renderRailReplacementTransportLegend, renderRailReplacementTransportPanel,
} from "../src/map/rail-replacement-transport-view.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");

// --- fixtures: two plans along lat 35 (a: a0 a1 a2, b: a2 b1 b2), an existing line E1 (d1..d3), optionally a parallel plan c between a1 and a2 ---
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

function makeWorld({ names = ["a", "b"], reverse = false, loop = false } = {}) {
  const drawn = [line("a", [[139, 35], [139.01, 35], [139.02, 35]], names[0]), line("b", [[139.02, 35], [139.03, 35], [139.04, 35]], names[1]), ...(loop ? [line("c", [[139.01, 35], [139.015, 35.003], [139.02, 35]])] : [])];
  const map = buildMapExport({ pack, mode: "existing", drawnLines: reverse ? [...drawn].reverse() : drawn });
  const plan = (k) => map.plans.find((p) => p.planId === stableId("plan", "t", "key", k));
  const [A, B, C] = [plan("a"), plan("b"), loop ? plan("c") : null];
  const planIds = [A.planId, B.planId, ...(C ? [C.planId] : [])];
  const G = buildRailGeometry({
    key: "g", planIds, externalLineIds: [EXT], designedRevisions: revisionsOf(A, B, ...(C ? [C] : [])),
    sectionFacts: [{ ref: { planId: A.planId, segmentId: A.segments[1].id }, directionMode: "single", basis: "player" }],
  }, { pack, plans: map.plans, externalNetworks: map.externalNetworks, routes: [] }).design;
  assert.ok(G);
  return { map, A, B, G, APP: applicationOf(G), A0: sectionOf(G, A, 0), A1: sectionOf(G, A, 1), B1: sectionOf(G, B, 1), EXT_SECTION: G.sections.find((s) => s.sourceKind === "external"), a0: A.segments[0].from, a1: A.segments[0].to, a2: A.segments[1].to, b2: B.segments[1].to };
}
const W = makeWorld();
const roads = (lines, extra = {}) => roadLayerFromGeojson({ features: lines.map(([coordinates, roadClass]) => ({ geometry: { coordinates }, properties: { roadClass } })) }, { quality: "medium", source: { name: "test roads", license: "CC0-1.0" }, ...extra });
const FULL_ROAD = roads([[[[138.99, 35.0002], [139.05, 35.0002]], "major"]]);
const SPATIAL = makeSpatialContext({ roads: FULL_ROAD });
const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const STATION_SITES = [{ connectedStationId: W.a1, stationSiteId: "stn-site:a1", entranceCandidates: [{ entranceId: "ent:near", name: "North gate", location: [139.0101, 35.0003] }, { entranceId: "ent:far", name: "Far gate", location: [139.0102, 35.003] }] }];

// the control geometry of an event on a section, and the replacement built on a suspension candidate of it
const eventFor = (world, n, section) => eventOf(`railway-disruption:${n}`, trackId(world.G, section));
function siteAndControl(world, event, { drawn = {}, spatial = null } = {}) {
  const site = buildRailwayDisruptionSite({ eventId: event.id, designedRailGeometryRevision: world.G.railGeometryRevision, ...drawn }, { pack, events: [event], railGeometry: world.G, applications: [world.APP] }).site;
  assert.ok(site);
  const out = buildRailwayServiceControl({ eventId: event.id }, { pack, site, railGeometry: world.G, application: world.APP, routes: [], externalNetworks: world.map.externalNetworks, spatial });
  assert.ok(out.control, JSON.stringify(out.warnings));
  return { site, control: out.control };
}
const ctxFor = (world, { site, control }, extra = {}) => ({ pack, site, control, railGeometry: world.G, application: world.APP, ...extra });
const lenOf = (n) => (control) => control.partialSuspensionCandidates.find((c) => c.suspendedSectionIds.length === n);
const S1 = siteAndControl(W, eventFor(W, 1, W.A1));
const ONE = lenOf(1)(S1.control);
const FOUR = lenOf(4)(S1.control);
const baseDoc = (candidate = ONE, over = {}) => ({ eventId: S1.site.eventId, partialSuspensionCandidateId: candidate.candidateId, ...over });
function build(over = {}, { ctx = {}, candidate = ONE, state = S1, world = W } = {}) {
  const out = buildRailReplacementTransport(baseDoc(candidate, over), ctxFor(world, state, ctx));
  assert.ok(out.replacement, JSON.stringify(out.warnings));
  return out.replacement;
}
const rejected = (document, code, { ctx = {}, state = S1, world = W } = {}) => {
  const out = buildRailReplacementTransport(document, ctxFor(world, state, ctx));
  assert.equal(out.replacement, null);
  assert.equal(out.warnings[0].code, code);
  return out.warnings[0];
};
// a route / stop along the A1 section, ~22 m north of the rail (the road lies there)
const ALONG = [[139.01, 35.0002], [139.015, 35.0002], [139.02, 35.0002]];
const keysDeep = (value, found = new Set()) => {
  if (Array.isArray(value)) value.forEach((v) => keysDeep(v, found));
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) { found.add(k); keysDeep(v, found); }
  return found;
};
// no cost, time, fleet, capacity, demand, score, rank, contract, cash, reputation or drivability field (infrastructure / railGeometry / railCapacity names are rail ids)
const FORBIDDEN = /cost|price|\bfee|cash|probab|verdict|feasib|possib|approval|score|delay|duration|recover|runningTime|travelTime|minutes|(?<!rail)capacity|throughput|headway|timetable|trainsPerHour|fleet|vehicleCount|busCount|demand|passenger|loss|compensat|refund|reputation|contract(?!Version)|severity|responsib|rank|recommend|\bbest|(?<!infrastructure)owner|operator/i;
const fieldNames = (value) => [...keysDeep(value)].filter((k) => !k.includes(":"));
const deepFreeze = (o) => { if (o && typeof o === "object") { Object.values(o).forEach(deepFreeze); Object.freeze(o); } return o; };
function assertUnknownContract(value, where = "replacement") {
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
const ROUTE = { key: "bus-1", name: "Replacement bus", polyline: ALONG };

// --- identity ---
test("same input gives the same replacementGeometryId and byte-identical JSON, tied to the site, the control geometry and the chosen suspension", () => {
  const a = build({ routes: [ROUTE] }, { ctx: { spatial: SPATIAL } });
  const b = build({ routes: [structuredClone(ROUTE)] }, { ctx: { spatial: SPATIAL } });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.equal(a.schema, RAIL_REPLACEMENT_TRANSPORT_SCHEMA);
  assert.equal(a.contractVersion, 1);
  assert.equal(a.replacementGeometryId, replacementGeometryIdOf("t", S1.site.eventId, ONE.candidateId));
  assert.deepEqual([a.eventId, a.disruptionSiteId, a.disruptionSiteRevision, a.controlGeometryId, a.controlGeometryRevision, a.railGeometryId, a.railGeometryRevision, a.partialSuspensionCandidateId],
    [S1.site.eventId, S1.site.disruptionSiteId, S1.site.siteRevision, S1.control.controlGeometryId, S1.control.controlGeometryRevision, W.G.railGeometryId, W.G.railGeometryRevision, ONE.candidateId]);
  for (const f of ["replacementGeometryRevision", "startStationId", "endStationId", "suspendedSectionIds", "suspendedTrackSegmentIds", "stationSequence", "railSections", "boundaryConnections", "stations", "stopCandidates", "routeCandidates", "derivedRouteCandidates", "turnaroundAreas", "spatialConstraints", "spatialFlags", "dataQuality", "unknown", "unknownReasons", "sourceLayers", "license"]) assert.ok(f in a, f);
});

test("the id follows the event, the pack and the chosen suspension; drawings change the revision, never the id", () => {
  const plain = build();
  const drawn = build({ routes: [ROUTE], vehicleWidthMeters: 2.5 }, { ctx: { spatial: SPATIAL } });
  assert.equal(drawn.replacementGeometryId, plain.replacementGeometryId);
  assert.notEqual(drawn.replacementGeometryRevision, plain.replacementGeometryRevision);
  assert.notEqual(build({}, { candidate: FOUR }).replacementGeometryId, plain.replacementGeometryId, "another suspension is another plan");
  assert.notEqual(replacementGeometryIdOf("other", S1.site.eventId, ONE.candidateId), plain.replacementGeometryId);
  assert.equal(JSON.stringify(build({ routes: [{ polyline: ALONG, name: "Replacement bus", key: "bus-1" }] }, { ctx: { spatial: SPATIAL } })), JSON.stringify(build({ routes: [ROUTE] }, { ctx: { spatial: SPATIAL } })));
});

test("array order, a route drawn the other way round and every name leave ids and bytes unchanged", () => {
  const stops = [{ key: "s1", stationId: W.a1, location: [139.0102, 35.0002] }, { key: "s2", stationId: W.a2, location: [139.0198, 35.0002] }];
  const routes = [ROUTE, { key: "bus-2", polyline: [[139.012, 35.0002], [139.018, 35.0002]] }];
  const forward = build({ routes, temporaryStops: stops }, { ctx: { spatial: SPATIAL } });
  const flipped = build({ routes: [{ ...routes[1], polyline: [...routes[1].polyline].reverse() }, { ...ROUTE, polyline: [...ALONG].reverse(), name: "Another name" }], temporaryStops: [...stops].reverse() }, { ctx: { spatial: SPATIAL } });
  assert.deepEqual(forward.routeCandidates.map((r) => r.routeId), flipped.routeCandidates.map((r) => r.routeId));
  assert.deepEqual(forward.routeCandidates.map((r) => r.polyline), flipped.routeCandidates.map((r) => r.polyline), "the polyline is turned to run from the start station");
  assert.deepEqual(forward.stopCandidates.map((s) => s.stopCandidateId), flipped.stopCandidates.map((s) => s.stopCandidateId));
  // without keys the ids follow the drawing, not its direction
  const a = build({ routes: [{ polyline: ALONG }] }, { ctx: { spatial: SPATIAL } });
  const b = build({ routes: [{ polyline: [...ALONG].reverse() }] }, { ctx: { spatial: SPATIAL } });
  assert.equal(a.routeCandidates[0].routeId, b.routeCandidates[0].routeId);
  const renamed = makeWorld({ names: ["Zeta", "Alpha"], reverse: true });
  const renamedState = siteAndControl(renamed, eventFor(renamed, 1, renamed.A1));
  const other = buildRailReplacementTransport(baseDoc(lenOf(1)(renamedState.control)), ctxFor(renamed, renamedState)).replacement;
  assert.equal(other.replacementGeometryId, build().replacementGeometryId, "plan names and drawing order do not change the plan id");
  assert.deepEqual(other.stationSequence, build().stationSequence);
  const s1 = { eventId: S1.site.eventId, partialSuspensionCandidateId: ONE.candidateId };
  const s2 = { eventId: S1.site.eventId, partialSuspensionCandidateId: FOUR.candidateId };
  const args = { pack, sites: [S1.site], controls: [S1.control], railGeometries: [W.G], applications: [W.APP] };
  assert.equal(JSON.stringify(buildRailReplacementTransportExport({ ...args, documents: [s1, s2] })), JSON.stringify(buildRailReplacementTransportExport({ ...args, documents: [s2, s1] })));
});

test("the inputs are never mutated (frozen site, control, geometry, application, document, station sites)", () => {
  const document = deepFreeze(baseDoc(ONE, { routes: [ROUTE], temporaryStops: [{ key: "s", stationId: W.a1, location: [139.0102, 35.0002], roadWidthMeters: 6 }], turnaroundAreas: [{ key: "t", polygon: rect(139.0105, 35.0004, 139.0108, 35.0006) }], constraints: [{ key: "c", kind: "bridge", location: [139.015, 35.0002] }], vehicleWidthMeters: 2.5, turnbackCandidateIds: [ONE.startTurnbackCandidateId] }));
  const frozen = { site: deepFreeze(structuredClone(S1.site)), control: deepFreeze(structuredClone(S1.control)), railGeometry: deepFreeze(structuredClone(W.G)), application: deepFreeze(structuredClone(W.APP)), stationSites: deepFreeze(structuredClone(STATION_SITES)), pack: deepFreeze(structuredClone(pack)) };
  const before = JSON.stringify([document, frozen]);
  const out = buildRailReplacementTransport(document, { ...frozen, spatial: SPATIAL });
  assert.ok(out.replacement);
  assert.equal(JSON.stringify([document, frozen]), before);
  const exp = buildRailReplacementTransportExport({ pack: frozen.pack, sites: [frozen.site], controls: [frozen.control], railGeometries: [frozen.railGeometry], applications: [frozen.application], stationSites: frozen.stationSites, documents: [document] });
  assert.equal(exp.replacements.length, 1);
  assert.equal(buildRailReplacementTransportView({ exportData: deepFreeze(exp) }).replacements.length, 1);
});

// --- stale and wrong links ---
test("a site or control geometry of another revision, a selection made on an older control geometry and every wrong link are rejected", () => {
  rejected({}, "event-missing");
  rejected({ eventId: S1.site.eventId }, "partial-suspension-missing");
  rejected(baseDoc(), "site-schema-invalid", { state: { ...S1, site: { ...S1.site, schema: "other/1" } } });
  rejected(baseDoc(), "control-schema-invalid", { state: { ...S1, control: { ...S1.control, schema: "other/1" } } });
  rejected(baseDoc(), "site-other-pack", { state: { ...S1, site: { ...S1.site, sourcePackId: "elsewhere" } } });
  rejected(baseDoc(), "control-other-pack", { state: { ...S1, control: { ...S1.control, sourcePackId: "elsewhere" } } });
  rejected({ ...baseDoc(), eventId: "railway-disruption:99" }, "document-event-mismatch");
  rejected(baseDoc(), "control-site-mismatch", { state: { ...S1, control: { ...S1.control, disruptionSiteId: "railway-disruption-site:other" } } });
  rejected(baseDoc(), "control-site-revision-mismatch", { state: { ...S1, site: { ...S1.site, siteRevision: "railway-disruption-site-revision:new" } } });
  rejected(baseDoc(), "control-site-revision-mismatch", { state: { ...S1, control: { ...S1.control, disruptionSiteRevision: "railway-disruption-site-revision:old" } } });
  rejected(baseDoc(ONE, { selectedOnControlGeometryRevision: "railway-service-control-revision:old" }), "selection-revision-mismatch");
  rejected(baseDoc(), "rail-geometry-schema-invalid", { ctx: { railGeometry: { ...W.G, schema: "other/1" } } });
  rejected(baseDoc(), "rail-geometry-other-pack", { ctx: { railGeometry: { ...W.G, sourcePackId: "elsewhere" } } });
  rejected(baseDoc(), "rail-geometry-mismatch", { ctx: { railGeometry: { ...W.G, railGeometryId: "rail-geometry:other" } } });
  rejected(baseDoc(), "rail-geometry-revision-mismatch", { ctx: { railGeometry: { ...W.G, railGeometryRevision: "rail-geometry-revision:new" } } });
  rejected(baseDoc(), "suspended-section-missing", { ctx: { railGeometry: { ...W.G, sections: W.G.sections.filter((s) => s.sectionId !== W.A1.sectionId) } } });
  const fresh = build({ selectedOnControlGeometryRevision: S1.control.controlGeometryRevision });
  assert.equal(fresh.controlGeometryRevision, S1.control.controlGeometryRevision);
});

test("the chosen suspension and turnback candidates must be ones the current control geometry offers", () => {
  rejected(baseDoc({ candidateId: "railway-control-suspension:made-up" }), "partial-suspension-not-offered");
  rejected(baseDoc(ONE, { turnbackCandidateIds: ["railway-control-turnback:made-up"] }), "turnback-not-offered");
  rejected(baseDoc(ONE, { turnbackCandidateIds: [S1.control.partialSuspensionCandidates[0].candidateId] }), "turnback-not-offered", {});
  const trainEvent = eventOf("railway-disruption:7", null, { kind: "vehicle-failure", trainId: "train:7" });
  const train = siteAndControl(W, trainEvent);
  assert.equal(train.control.partialSuspensionCandidates, null);
  rejected({ eventId: trainEvent.id, partialSuspensionCandidateId: ONE.candidateId }, "partial-suspension-not-offered", { state: train });
  const ok = build({ turnbackCandidateIds: [ONE.endTurnbackCandidateId, ONE.startTurnbackCandidateId, ONE.startTurnbackCandidateId] });
  assert.deepEqual(ok.selectedTurnbackCandidateIds, [ONE.startTurnbackCandidateId, ONE.endTurnbackCandidateId].sort());
  assert.ok(!ok.spatialFlags.includes("selected-turnback-not-at-boundary"));
  const inside = FOUR.endTurnbackCandidateId;
  const middle = S1.control.turnbackCandidates.find((t) => ![FOUR.startStationId, FOUR.endStationId].includes(t.stationId)).candidateId;
  assert.ok(build({ turnbackCandidateIds: [middle] }, { candidate: FOUR }).spatialFlags.includes("selected-turnback-not-at-boundary"));
  assert.ok(inside);
});

// --- boundary stations and rail section ids ---
test("the stations and rail sections of the range are the geometry's own, in rail order from the start station to the end station", () => {
  const four = build({}, { candidate: FOUR });
  assert.equal(four.stationSequence[0], FOUR.startStationId);
  assert.equal(four.stationSequence.at(-1), FOUR.endStationId);
  assert.equal(four.stationSequence.length, 5);
  assert.deepEqual([...four.railSections.map((s) => s.sectionId)].sort(), [...FOUR.suspendedSectionIds].sort());
  four.railSections.forEach((s, i) => { assert.equal(s.fromStationId, four.stationSequence[i]); assert.equal(s.toStationId, four.stationSequence[i + 1]); });
  assert.deepEqual(four.stations.map((s) => [s.stationId, s.role]), four.stationSequence.map((id, i) => [id, i === 0 ? "start-boundary" : i === 4 ? "end-boundary" : "interior"]));
  assert.equal(four.railLengthMeters, Math.round(four.railSections.reduce((a, s) => a + s.lengthMeters, 0) * 10) / 10);
  assert.ok(four.railSections.every((s) => Array.isArray(s.alignment)));
  assert.deepEqual([...four.suspendedSectionIds, ...four.retainedSectionIds].sort(), W.G.sections.map((s) => s.sectionId).sort());
  const sectionIds = new Set(W.G.sections.map((s) => s.sectionId));
  assert.ok(four.suspendedSectionIds.every((id) => sectionIds.has(id)));
  assert.ok(four.stations.every((s) => W.G.sections.some((x) => x.fromStationId === s.stationId || x.toStationId === s.stationId)));
  const one = build();
  assert.deepEqual(one.stationSequence, [ONE.startStationId, ONE.endStationId]);
  assert.deepEqual(one.stations.map((s) => s.isolated), [false, false]);
  assert.ok(four.stations.every((s) => s.isolated));
  assert.ok(four.spatialFlags.includes("stations-left-without-rail"));
});

test("the operational track segments come through the application only; a stale or missing one is null with the reason", () => {
  assert.deepEqual(build().suspendedTrackSegmentIds, [trackId(W.G, W.A1)]);
  assert.deepEqual(build({}, { candidate: FOUR }).suspendedTrackSegmentIds, FOUR.suspendedSectionIds.map((id) => trackId(W.G, W.G.sections.find((s) => s.sectionId === id))).sort());
  const none = build({}, { ctx: { application: null } });
  assert.equal(none.suspendedTrackSegmentIds, null);
  assert.equal(none.unknownReasons.suspendedTrackSegmentIds, "no-application");
  const out = buildRailReplacementTransport(baseDoc(), ctxFor(W, S1, { application: { ...W.APP, railGeometryRevision: "rail-geometry-revision:old" } }));
  assert.equal(out.replacement.suspendedTrackSegmentIds, null);
  assert.equal(out.replacement.unknownReasons.suspendedTrackSegmentIds, "application-stale");
  assert.deepEqual(out.warnings.map((w) => w.code), ["application-stale"]);
  const partial = buildRailReplacementTransport(baseDoc(), ctxFor(W, S1, { application: { ...W.APP, sections: W.APP.sections.filter((s) => s.railCapacitySectionId !== W.A1.sectionId) } })).replacement;
  assert.equal(partial.unknownReasons.suspendedTrackSegmentIds, "section-not-in-application");
});

test("without the rail geometry the range is only its two boundary stations: sequence, sections and length are null, not guessed", () => {
  const out = build({}, { ctx: { railGeometry: null } });
  assert.deepEqual(out.stations.map((s) => s.stationId), [ONE.startStationId, ONE.endStationId]);
  for (const f of ["stationSequence", "railSections", "railLengthMeters", "boundaryStationsConnectedByRetainedRail"]) { assert.equal(out[f], null, f); assert.equal(out.unknownReasons[f], "rail-geometry-not-supplied", f); }
  assert.deepEqual(out.stations.map((s) => s.external), [null, null]);
  assert.ok(out.boundaryConnections.every((b) => b.retainedSectionIds === null));
});

test("whether the retained rail still joins the two boundary stations is measured on the geometry: separated on a line, joined when a parallel track remains", () => {
  assert.equal(build().boundaryStationsConnectedByRetainedRail, false);
  assert.ok(build().spatialFlags.includes("boundary-stations-separated"));
  const loop = makeWorld({ loop: true });
  const state = siteAndControl(loop, eventFor(loop, 1, loop.A1));
  const one = lenOf(1)(state.control);
  const out = buildRailReplacementTransport(baseDoc(one), ctxFor(loop, state)).replacement;
  assert.equal(out.boundaryStationsConnectedByRetainedRail, true);
  assert.ok(out.spatialFlags.includes("boundary-stations-joined-by-retained-rail"));
  const ends = out.boundaryConnections;
  assert.deepEqual(ends.map((b) => b.side), ["start", "end"]);
  assert.ok(ends.every((b) => b.retainedSectionIds.length > 0 && !b.retainedSectionIds.includes(loop.A1.sectionId)));
  assert.ok(ends.every((b) => b.turnbackCandidateId === state.control.turnbackCandidates.find((t) => t.stationId === b.stationId).candidateId));
});

// --- player routes: kept as drawn, measured, never invented ---
test("a player route is kept as the player's (basis, length, original coordinates) and the input is never altered", () => {
  const input = { key: "bus-1", polyline: [...ALONG].reverse().map((p) => [...p]) };
  const copy = structuredClone(input);
  const r = build({ routes: [input] }, { ctx: { spatial: SPATIAL } }).routeCandidates[0];
  assert.deepEqual(input, copy);
  assert.equal(r.basis, "player");
  assert.deepEqual(r.polyline, ALONG, "turned to run from the start station");
  assert.ok(Math.abs(r.lengthMeters - 910) < 15, String(r.lengthMeters));
  assert.equal(r.routeId, stableId("rail-replacement-route", replacementGeometryIdOf("t", S1.site.eventId, ONE.candidateId), "key", "bus-1"));
  const bad = buildRailReplacementTransport(baseDoc(ONE, { routes: [{ key: "x", polyline: [[139, 35]] }, { key: "y", polyline: [["a", 1], [2, 3]] }, ROUTE] }), ctxFor(W, S1, { spatial: SPATIAL }));
  assert.equal(bad.replacement.routeCandidates.length, 1);
  assert.deepEqual(bad.warnings.map((w) => w.code), ["route-polyline-invalid", "route-polyline-invalid"]);
});

test("no road layer, or a layer that is only lines: no route is invented, no straight line is passed off as a road", () => {
  const withRoads = build({}, { ctx: { spatial: SPATIAL } });
  assert.equal(withRoads.routeCandidates, null, "nothing drawn: no candidate, and null is not []");
  assert.equal(withRoads.unknownReasons.routeCandidates, "no-route-stated");
  assert.equal(withRoads.derivedRouteCandidates, null);
  assert.equal(withRoads.unknownReasons.derivedRouteCandidates, "road-graph-not-in-source");
  assert.ok(withRoads.spatialFlags.includes("no-road-graph"));
  const none = build({ routes: [ROUTE] });
  assert.equal(none.derivedRouteCandidates, null);
  const r = none.routeCandidates[0];
  assert.deepEqual([r.alongRoad, r.roadAttachment, r.roadClassesNear], [null, null, null]);
  assert.deepEqual([r.unknownReasons.alongRoad, r.unknownReasons.roadAttachment, r.unknownReasons.roadClassesNear], ["no-road-layer", "no-road-layer", "no-road-layer"]);
  assert.ok(none.spatialFlags.includes("road-layer-missing"));
  assert.equal(none.routeCandidates.length, 1, "only what the player drew");
  assert.ok(none.stopCandidates === null && none.unknownReasons.stopCandidates === "no-stop-candidate-data");
  const declared = build({ routes: [] }, { ctx: { spatial: SPATIAL } });
  assert.deepEqual(declared.routeCandidates, [], "the player declared there is none");
});

test("a route on the road is measured on it; one across a gap has the gap named; one beside no road is off it", () => {
  const split = makeSpatialContext({ roads: roads([[[[139.0, 35.0002], [139.0125, 35.0002]], "major"], [[[139.0175, 35.0002], [139.05, 35.0002]], "minor"]]) });
  const on = build({ routes: [{ key: "on", polyline: ALONG }] }, { ctx: { spatial: SPATIAL } }).routeCandidates[0];
  assert.equal(on.alongRoad.fullyOnRoad, true);
  assert.equal(on.alongRoad.onRoadCount, on.alongRoad.sampleCount);
  assert.deepEqual(on.alongRoad.offRoadRuns, []);
  assert.deepEqual([on.roadAttachment.start.attached, on.roadAttachment.end.attached], [true, true]);
  assert.deepEqual(on.roadClassesNear, ["major"]);
  const across = build({ routes: [{ key: "gap", polyline: ALONG }] }, { ctx: { spatial: split } }).routeCandidates[0];
  assert.equal(across.alongRoad.fullyOnRoad, false);
  assert.equal(across.alongRoad.offRoadRuns.length, 1);
  assert.ok(across.alongRoad.offRoadRuns[0].toAlongMeters > across.alongRoad.offRoadRuns[0].fromAlongMeters);
  assert.deepEqual([across.roadAttachment.start.attached, across.roadAttachment.end.attached], [true, true], "both ends meet a road; the middle does not");
  assert.deepEqual(across.roadClassesNear, ["major", "minor"]);
  const beside = build({ routes: [{ key: "off", polyline: [[139.01, 35.004], [139.02, 35.004]] }] }, { ctx: { spatial: SPATIAL } });
  const off = beside.routeCandidates[0];
  assert.equal(off.alongRoad.fullyOnRoad, false);
  assert.deepEqual([off.roadAttachment.start.attached, off.roadAttachment.end.attached], [false, false], "measured not joined is false, not null");
  assert.ok(beside.spatialFlags.includes("player-route-off-road"));
  assert.equal(off.reachesStartStation, false);
});

test("outside the road data's coverage nothing is measured: null with the reason, never on or off", () => {
  const elsewhere = makeSpatialContext({ roads: roads([[[[10, 10], [10.01, 10]], "major"]], { covers: ([x, y]) => x > 9 && x < 11 && y > 9 && y < 11 }) });
  const out = build({ routes: [ROUTE], temporaryStops: [{ key: "s", stationId: W.a1, location: [139.0102, 35.0002] }] }, { ctx: { spatial: elsewhere, stationSites: STATION_SITES } });
  const r = out.routeCandidates[0];
  assert.equal(r.alongRoad.unmeasuredCount, r.alongRoad.sampleCount);
  assert.equal(r.alongRoad.fullyOnRoad, null);
  assert.equal(r.alongRoad.unknownReasons.fullyOnRoad, "outside-road-coverage");
  assert.deepEqual([r.roadAttachment.start.attached, r.roadAttachment.start.gapMeters], [null, null]);
  assert.equal(r.roadClassesNear.length, 0);
  assert.equal(out.stopCandidates.find((s) => s.kind === "player-temporary").roadAdjacent, null);
  assert.ok(out.spatialFlags.includes("player-route-road-contact-unmeasured"));
  const station = out.stations.find((s) => s.stationId === W.a1);
  assert.equal(station.derivedStopCandidateIds, null);
  assert.equal(station.unknownReasons.derivedStopCandidateIds, "outside-road-coverage");
});

test("the order a route passes the stations is measured against the rail order", () => {
  const four = build({ routes: [{ key: "in-order", polyline: [[139.0, 35.0002], [139.04, 35.0002]] }] }, { candidate: FOUR, ctx: { spatial: SPATIAL } }).routeCandidates[0];
  assert.equal(four.visitedStationIds.length, 5);
  assert.equal(four.orderMatchesRail, true);
  assert.equal(four.reachesStartStation && four.reachesEndStation, true);
  assert.deepEqual(four.stationApproaches.map((a) => a.passesNear), [true, true, true, true, true]);
  const zigzag = build({ routes: [{ key: "zigzag", polyline: [[139.0, 35.0002], [139.0, 35.003], [139.03, 35.003], [139.03, 35.0002], [139.01, 35.0003]] }] }, { candidate: FOUR, ctx: { spatial: SPATIAL } });
  assert.equal(zigzag.routeCandidates[0].orderMatchesRail, false);
  assert.ok(zigzag.spatialFlags.includes("route-order-differs-from-rail"));
  const short = build({ routes: [{ key: "short", polyline: [[139.0, 35.0002], [139.0005, 35.0002]] }] }, { candidate: FOUR, ctx: { spatial: SPATIAL } }).routeCandidates[0];
  assert.equal(short.orderMatchesRail, null);
  assert.equal(short.unknownReasons.orderMatchesRail, "fewer-than-two-stations-passed");
});

// --- road width, entrances, stops ---
test("road width is null unless the player stated it; it is compared only with a vehicle width the player stated", () => {
  const out = build({
    routes: [{ key: "wide", polyline: ALONG, roadWidthMeters: 7 }, { key: "thin", polyline: ALONG, roadWidthMeters: 2 }, { key: "unstated", polyline: ALONG }],
    temporaryStops: [{ key: "stop", stationId: W.a1, location: [139.0102, 35.0002], roadWidthMeters: 6 }], vehicleWidthMeters: 2.5,
  }, { ctx: { spatial: SPATIAL, stationSites: STATION_SITES } });
  const byKey = (k) => out.routeCandidates.find((r) => r.key === k);
  assert.deepEqual([byKey("wide").roadWidthAtLeastVehicleWidth, byKey("thin").roadWidthAtLeastVehicleWidth, byKey("unstated").roadWidthAtLeastVehicleWidth], [true, false, null]);
  assert.equal(byKey("unstated").roadWidthMeters, null);
  assert.equal(byKey("unstated").unknownReasons.roadWidthMeters, "road-width-not-in-source");
  assert.equal(out.stopCandidates.find((s) => s.kind === "player-temporary").roadWidthAtLeastVehicleWidth, true);
  const derived = out.stopCandidates.filter((s) => s.kind === "entrance-roadside");
  assert.ok(derived.length > 0 && derived.every((s) => s.roadWidthMeters === null && s.roadWidthAtLeastVehicleWidth === null && s.unknownReasons.roadWidthMeters === "road-width-not-in-source"), "the road layer has no width");
  const noVehicle = build({ routes: [{ key: "wide", polyline: ALONG, roadWidthMeters: 7 }] }, { ctx: { spatial: SPATIAL } });
  assert.equal(noVehicle.routeCandidates[0].roadWidthAtLeastVehicleWidth, null);
  assert.equal(noVehicle.routeCandidates[0].unknownReasons.roadWidthAtLeastVehicleWidth, "vehicle-width-not-stated");
  assert.equal(noVehicle.vehicleWidthMeters, null);
});

test("entrances: a roadside entrance implies a stop at the road point; a far one does not; no entrance data is null, an entrance-less site is []; a station centre is never a stop", () => {
  const out = build({}, { ctx: { spatial: SPATIAL, stationSites: STATION_SITES } });
  const a1 = out.stations.find((s) => s.stationId === W.a1);
  assert.deepEqual(a1.entrances.map((e) => [e.entranceId, e.roadside]), [["ent:far", false], ["ent:near", true]]);
  assert.equal(a1.entrances.find((e) => e.entranceId === "ent:near").nearestRoad.roadClass, "major");
  assert.equal(a1.derivedStopCandidateIds.length, 1, "only the roadside entrance gives a stop");
  const stop = out.stopCandidates.find((s) => s.entranceId === "ent:near");
  assert.deepEqual([stop.kind, stop.basis, stop.stationId], ["entrance-roadside", "source", W.a1]);
  assert.ok(Math.abs(stop.location[1] - 35.0002) < 1e-6, "on the road line, not at the entrance and not at the station");
  assert.ok(out.stopCandidates.every((s) => JSON.stringify(s.location) !== JSON.stringify(W.A1.startLocation)));
  const a2 = out.stations.find((s) => s.stationId === W.a2);
  assert.equal(a2.entrances, null);
  assert.equal(a2.unknownReasons.entrances, "no-station-site");
  assert.equal(a2.derivedStopCandidateIds, null);
  assert.equal(a2.walkLinks, null);
  assert.ok(out.spatialFlags.includes("entrance-data-missing"));
  const empty = build({}, { ctx: { spatial: SPATIAL, stationSites: [{ connectedStationId: W.a1, stationSiteId: "s", entranceCandidates: [] }, { connectedStationId: W.a2, stationSiteId: "s2", entranceCandidates: [] }] } });
  assert.deepEqual(empty.stations.map((s) => [s.entrances, s.derivedStopCandidateIds]), [[[], []], [[], []]], "a site that states no entrance has none, which is not unknown");
  assert.deepEqual(empty.stopCandidates, []);
  const noRoads = build({}, { ctx: { stationSites: STATION_SITES } });
  assert.equal(noRoads.stations.find((s) => s.stationId === W.a1).derivedStopCandidateIds, null);
  assert.equal(noRoads.stations.find((s) => s.stationId === W.a1).unknownReasons.derivedStopCandidateIds, "no-road-layer");
});

test("walk links are straight distances between an entrance and a stop of its station; there is no walking network", () => {
  const out = build({ temporaryStops: [{ key: "gate-stop", stationId: W.a1, location: [139.0103, 35.0004], name: "Gate stop" }] }, { ctx: { spatial: SPATIAL, stationSites: STATION_SITES } });
  const a1 = out.stations.find((s) => s.stationId === W.a1);
  assert.equal(a1.walkLinks.length, 4, "two entrances x (one roadside stop + one stated stop)");
  const link = a1.walkLinks.find((w) => w.entranceId === "ent:near" && w.stopCandidateId === out.stopCandidates.find((s) => s.key === "gate-stop").stopCandidateId);
  assert.ok(link.straightDistanceMeters > 0 && link.straightDistanceMeters < 50);
  assert.equal(link.withinNearDistance, true);
  assert.equal(a1.walkLinks.find((w) => w.entranceId === "ent:far" && w.stopCandidateId === link.stopCandidateId).withinNearDistance, false);
  assert.equal(out.walkNetwork, null);
  assert.equal(out.unknownReasons.walkNetwork, "walk-network-not-in-source");
  assert.ok(a1.walkLinks.every((w) => !("alignment" in w) && !("walkPath" in w)));
  const noStops = build({}, { ctx: { stationSites: STATION_SITES } });
  assert.equal(noStops.stations.find((s) => s.stationId === W.a1).walkLinks, null);
  assert.equal(noStops.stations.find((s) => s.stationId === W.a1).unknownReasons.walkLinks, "no-stop-candidates");
});

test("a stop the player states must serve a station of the range; duplicates and bad coordinates are reported, not guessed", () => {
  const out = buildRailReplacementTransport(baseDoc(ONE, { temporaryStops: [
    { key: "ok", stationId: W.a1, location: [139.0102, 35.0002] }, { key: "ok", stationId: W.a1, location: [139.0103, 35.0002] }, { key: "far-station", stationId: W.b2, location: [139.04, 35.0002] }, { key: "no-place", stationId: W.a1, location: ["x", 1] },
  ] }), ctxFor(W, S1, { spatial: SPATIAL }));
  assert.equal(out.replacement.stopCandidates.length, 1);
  assert.deepEqual(out.warnings.map((w) => w.code).sort(), ["duplicate-temporary-stop", "temporary-stop-location-invalid", "temporary-stop-station-not-in-range"]);
});

// --- the stations that are not described ---
test("an existing line's stations have no detail in the source: external, no entrances, no alignment, no length — null with the reasons", () => {
  const ext = siteAndControl(W, eventFor(W, 2, W.EXT_SECTION));
  const candidate = lenOf(1)(ext.control);
  const out = buildRailReplacementTransport({ eventId: ext.site.eventId, partialSuspensionCandidateId: candidate.candidateId, routes: [{ key: "r", polyline: candidate.geometry.boundaryLocations }] }, ctxFor(W, ext, { stationSites: STATION_SITES, spatial: SPATIAL })).replacement;
  assert.deepEqual(out.stations.map((s) => s.external), [true, true]);
  assert.ok(out.stations.every((s) => s.entrances === null && s.unknownReasons.entrances === "external-station-detail-not-in-source"));
  assert.equal(out.railLengthMeters, null);
  assert.equal(out.unknownReasons.railLengthMeters, "external-alignment-not-in-source");
  assert.ok(out.railSections.every((s) => s.alignment === null && s.lengthMeters === null && s.unknownReasons.alignment === "external-alignment-not-in-source"));
  assert.ok(out.spatialFlags.includes("external-station-detail-missing"));
  assert.equal(out.routeCandidates[0].basis, "player");
  assert.equal(out.suspendedBlockIds, null);
});

// --- turning places and constraints ---
test("turning, waiting and boarding places are the player's: measured against stations, roads, buildings and routes; none stated is null, declared none is []", () => {
  const buildings = polygonLayer([{ rings: [rect(139.0105, 35.0004, 139.0108, 35.0006)] }], { quality: "medium", source: { name: "test buildings", license: "CC0-1.0" } });
  const spatial = makeSpatialContext({ roads: FULL_ROAD, buildings });
  const out = build({
    routes: [ROUTE], turnaroundAreas: [
      { key: "turn", kind: "turnaround", polygon: rect(139.0104, 35.0003, 139.0109, 35.0007) }, { key: "wait", kind: "waiting", polygon: rect(139.016, 35.0003, 139.017, 35.0005) }, { key: "board", kind: "boarding", location: [139.012, 35.0003] },
      { key: "bad-kind", kind: "parking", location: [139.012, 35.0003] }, { key: "bowtie", polygon: [[139, 35], [139.001, 35.001], [139.001, 35], [139, 35.001]] },
    ],
  }, { ctx: { spatial } });
  assert.deepEqual(out.turnaroundAreas.map((a) => a.kind).sort(), ["boarding", "turnaround", "waiting"]);
  const turn = out.turnaroundAreas.find((a) => a.kind === "turnaround");
  assert.ok(turn.areaSquareMeters > 1500 && turn.areaSquareMeters < 2500);
  assert.equal(turn.buildingOverlapCount, 1);
  assert.equal(out.turnaroundAreas.find((a) => a.kind === "waiting").buildingOverlapCount, 0);
  assert.equal(turn.waterOverlapCount, null);
  assert.equal(turn.unknownReasons.waterOverlapCount, "no-layer");
  assert.equal(turn.roadAdjacent, true);
  assert.deepEqual(turn.distancesToStationsMeters.map((d) => d.stationId), [ONE.startStationId, ONE.endStationId]);
  const board = out.turnaroundAreas.find((a) => a.kind === "boarding");
  assert.equal(board.areaSquareMeters, null);
  assert.equal(board.unknownReasons.areaSquareMeters, "no-polygon-drawn");
  assert.deepEqual(board.routeIdsNear, [out.routeCandidates[0].routeId]);
  assert.equal(out.turnaroundAreas.find((a) => a.kind === "waiting").routeIdsNear.length, 1);
  assert.equal(out.turnaroundAreas.every((a) => a.basis === "player"), true);
  const bad = buildRailReplacementTransport(baseDoc(ONE, { turnaroundAreas: [{ kind: "parking", location: [139.012, 35.0003] }, { polygon: [[139, 35], [139.001, 35.001], [139.001, 35], [139, 35.001]] }] }), ctxFor(W, S1));
  assert.deepEqual(bad.warnings.map((w) => w.code), ["turnaround-area-invalid", "turnaround-polygon-degenerate"]);
  const none = build();
  assert.equal(none.turnaroundAreas, null);
  assert.equal(none.unknownReasons.turnaroundAreas, "no-turnaround-area-stated");
  assert.deepEqual(build({ turnaroundAreas: [] }).turnaroundAreas, []);
  const noRoute = build({ turnaroundAreas: [{ key: "t", location: [139.012, 35.0003] }] });
  assert.equal(noRoute.turnaroundAreas[0].routeIdsNear, null);
});

test("spatial constraints are only what the player or a source stated; a route's nearby ones are measured, none stated is null", () => {
  const out = build({ routes: [ROUTE], constraints: [{ key: "br", kind: "bridge", location: [139.015, 35.0002] }, { key: "lim", kind: "height-limit", location: [139.0151, 35.0002], value: 3.2, unit: "m" }, { key: "far", kind: "tunnel", location: [139.015, 35.01], basis: "source" }, { kind: "ferry", location: [139.015, 35.0002] }] }, { ctx: { spatial: SPATIAL } });
  assert.equal(out.spatialConstraints.length, 3);
  const [lim] = out.spatialConstraints.filter((c) => c.kind === "height-limit");
  assert.deepEqual([lim.value, lim.unit], [3.2, "m"]);
  const bridge = out.spatialConstraints.find((c) => c.kind === "bridge");
  assert.equal(bridge.value, null);
  assert.equal(bridge.unknownReasons.value, "value-not-stated");
  assert.equal(out.spatialConstraints.find((c) => c.kind === "tunnel").basis, "source");
  assert.deepEqual(out.routeCandidates[0].constraintIdsNear, out.spatialConstraints.filter((c) => c.kind !== "tunnel").map((c) => c.constraintId).sort());
  assert.ok(out.warnings.some((w) => w.code === "constraint-invalid"));
  const plain = build({ routes: [ROUTE] }, { ctx: { spatial: SPATIAL } });
  assert.equal(plain.spatialConstraints, null);
  assert.equal(plain.unknownReasons.spatialConstraints, "no-constraint-data");
  assert.equal(plain.routeCandidates[0].constraintIdsNear, null);
  assert.deepEqual(build({ constraints: [] }).spatialConstraints, []);
});

test("the river and building footprints a drawn route crosses are counted from the layers, null where a layer is missing", () => {
  const buildings = polygonLayer([{ rings: [rect(139.0149, 35.0001, 139.0151, 35.0003)] }], { quality: "medium" });
  const water = polygonLayer([{ rings: [rect(139.0125, 34.999, 139.0135, 35.01)] }], { quality: "medium" });
  const spatial = makeSpatialContext({ roads: FULL_ROAD, buildings, water });
  const r = build({ routes: [ROUTE] }, { ctx: { spatial } }).routeCandidates[0];
  assert.deepEqual([r.waterCrossingCount, r.buildingIntersectionCount], [1, 1]);
  const bare = build({ routes: [ROUTE] }, { ctx: { spatial: SPATIAL } }).routeCandidates[0];
  assert.deepEqual([bare.waterCrossingCount, bare.buildingIntersectionCount], [null, null]);
  assert.equal(bare.unknownReasons.waterCrossingCount, "no-layer");
});

// --- null, false and [] ---
test("unknown[] and unknownReasons are 1:1 everywhere, and every unknown value is null, in every kind of case", () => {
  const spatial = makeSpatialContext({ roads: FULL_ROAD, buildings: polygonLayer([{ rings: [rect(139.0105, 35.0004, 139.0108, 35.0006)] }], { quality: "medium" }) });
  const cases = [
    build({ routes: [ROUTE, { key: "off", polyline: [[139.01, 35.004], [139.02, 35.004]] }], temporaryStops: [{ key: "s", stationId: W.a1, location: [139.0102, 35.0002] }], turnaroundAreas: [{ key: "t", location: [139.012, 35.0003] }], constraints: [{ key: "c", kind: "bridge", location: [139.015, 35.0002] }], vehicleWidthMeters: 2.5 }, { ctx: { spatial, stationSites: STATION_SITES } }),
    build({}, { candidate: FOUR }),
    build({ routes: [ROUTE] }, { ctx: { railGeometry: null } }),
  ];
  const ext = siteAndControl(W, eventFor(W, 2, W.EXT_SECTION));
  cases.push(buildRailReplacementTransport({ eventId: ext.site.eventId, partialSuspensionCandidateId: lenOf(1)(ext.control).candidateId }, ctxFor(W, ext)).replacement);
  cases.forEach((c, i) => assertUnknownContract(c, `replacement ${i}`));
});

test("null is never turned into 0, false or []: an unknown road fact stays null next to a measured false", () => {
  const out = build({ routes: [{ key: "off", polyline: [[139.01, 35.004], [139.02, 35.004]] }, ROUTE] }, { ctx: { spatial: SPATIAL, stationSites: STATION_SITES } });
  const off = out.routeCandidates.find((r) => r.key === "off");
  const on = out.routeCandidates.find((r) => r.key === "bus-1");
  assert.equal(off.roadAttachment.start.attached, false, "measured apart");
  assert.equal(off.roadAttachment.start.gapMeters !== null, true);
  assert.equal(on.waterCrossingCount, null, "no water layer: not 0");
  assert.equal(on.roadWidthMeters, null, "no width: not 0");
  assert.equal(on.roadWidthAtLeastVehicleWidth, null, "no width: not false");
  assert.equal(on.constraintIdsNear, null, "no constraint data: not []");
  assert.equal(out.stations.find((s) => s.stationId === W.a2).entrances, null, "no station site: not []");
  assert.equal(out.vehicleWidthMeters, null);
  assert.ok(out.stations.every((s) => s.playerStopCandidateIds === null), "no stop stated: not []");
});

test("a station with no entrance data never gets its centre as a stop, with or without a road layer", () => {
  for (const spatial of [SPATIAL, null]) {
    const out = build({}, { ctx: { spatial, stationSites: [] } });
    assert.equal(out.stopCandidates, null);
    assert.equal(out.unknownReasons.stopCandidates, "no-stop-candidate-data");
    assert.ok(out.stations.every((s) => s.derivedStopCandidateIds === null));
  }
});

// --- the module's own limits ---
test("no cost, time, fleet, capacity, demand, score, rank or verdict field anywhere in the output, the export or the view", () => {
  const rich = build({
    routes: [ROUTE], temporaryStops: [{ key: "s", stationId: W.a1, location: [139.0102, 35.0002], roadWidthMeters: 6 }], turnaroundAreas: [{ key: "t", location: [139.012, 35.0003] }], constraints: [{ key: "c", kind: "weight-limit", location: [139.015, 35.0002], value: 20, unit: "t" }],
    vehicleWidthMeters: 2.5, turnbackCandidateIds: [ONE.startTurnbackCandidateId],
  }, { ctx: { spatial: SPATIAL, stationSites: STATION_SITES } });
  assert.deepEqual(fieldNames(rich).filter((k) => FORBIDDEN.test(k)), []);
  const exp = buildRailReplacementTransportExport({ pack, sites: [S1.site], controls: [S1.control], railGeometries: [W.G], applications: [W.APP], spatial: SPATIAL, documents: [baseDoc(ONE, { routes: [ROUTE] })] });
  assert.equal(RAIL_REPLACEMENT_TRANSPORT_EXPORT_SCHEMA, exp.schema);
  assert.deepEqual(fieldNames(exp).filter((k) => FORBIDDEN.test(k)), []);
  assert.deepEqual(fieldNames(buildRailReplacementTransportView({ exportData: exp })).filter((k) => FORBIDDEN.test(k)), []);
});

test("no management, engine-state or train import and no money, clock or file access in any new map module, each under 40 KB", () => {
  for (const file of ["rail-replacement-transport", "rail-replacement-transport-candidates", "rail-replacement-transport-editor", "rail-replacement-transport-view"]) {
    const text = fs.readFileSync(path.join(here, "..", "src", "map", `${file}.mjs`), "utf8");
    assert.ok(text.length < 40_000, `${file} holds code, not data`);
    for (const m of text.matchAll(/from "([^"]+)"/g)) assert.match(m[1], /^\.\/[a-z-]+\.mjs$/, `${file} imports ${m[1]}`);
    assert.equal(/from\s+["'][^"']*management/.test(text), false, file);
    assert.equal(/from\s+["'][^"']*(railway-disruptions|railway-traffic-control|rail-capacity-integration|scenario-runtime|trains|network|state|game)\.mjs/.test(text), false, file);
    assert.equal(/ledger|\.commit\(|\.settle\(|\.post\(|node:fs|Date\.now|Math\.random|state\.(trains|lines|trackSegments|railwayDisruptions)/.test(text.replace(/\/\/.*$/gm, "")), false, file);
  }
});

test("a map replacement geometry does not touch cash, trains or disruption state: a stand-in engine state is unchanged after building, editing and viewing", () => {
  const state = deepFreeze({ cash: 1_000_000, ledger: [{ id: 1 }], trains: [{ id: "train:7", lineId: "line:1" }], trackSegments: [{ id: "track-segment:1" }], railwayDisruptions: { events: [eventOf("railway-disruption:1", "track-segment:1")], nextSequence: 2 } });
  const before = JSON.stringify(state);
  const doc = newRailReplacementDoc("t", "1");
  addPlan(doc, S1.site.eventId, ONE.candidateId, S1.control);
  setRoute(doc, S1.site.eventId, ONE.candidateId, ROUTE);
  const exp = buildRailReplacementTransportExport({ pack, sites: [S1.site], controls: [S1.control], railGeometries: [W.G], applications: [W.APP], spatial: SPATIAL, documents: doc.plans.map(toReplacementDocument) });
  buildRailReplacementTransportView({ exportData: exp });
  assert.equal(JSON.stringify(state), before);
});

// --- export ---
test("the export builds active plans, lists a switched-off one by id, and names what it cannot build", () => {
  const args = { pack, sites: [S1.site], controls: [S1.control], railGeometries: [W.G], applications: [W.APP] };
  const exp = buildRailReplacementTransportExport({ ...args, documents: [baseDoc(ONE), baseDoc(FOUR, { active: false }), baseDoc(ONE), { eventId: "railway-disruption:9", partialSuspensionCandidateId: "x" }, baseDoc({ candidateId: "railway-control-suspension:nope" })] });
  assert.deepEqual(exp.replacements.map((r) => r.partialSuspensionCandidateId), [ONE.candidateId]);
  assert.deepEqual(exp.inactive, [{ eventId: S1.site.eventId, partialSuspensionCandidateId: FOUR.candidateId, replacementGeometryId: replacementGeometryIdOf("t", S1.site.eventId, FOUR.candidateId) }]);
  assert.deepEqual(exp.warnings.map((w) => w.code), ["duplicate-rail-replacement-transport", "rail-replacement-transport-rejected", "rail-replacement-transport-rejected"]);
  assert.equal(exp.warnings[1].reasons[0].code, "site-missing");
  assert.equal(exp.warnings[2].reasons[0].code, "partial-suspension-not-offered");
  assert.equal(buildRailReplacementTransportExport({ ...args, controls: [], documents: [baseDoc(ONE)] }).warnings[0].reasons[0].code, "control-missing");
});

// --- editor ---
test("editor: a plan is made only on an offered suspension, keeps the player's drawings by key, and distinguishes nothing stated from none", () => {
  const doc = newRailReplacementDoc("t", "1");
  const id = S1.site.eventId;
  assert.throws(() => addPlan(doc, id, "railway-control-suspension:made-up", S1.control), /Unknown partialSuspension candidate/);
  const plan = addPlan(doc, id, ONE.candidateId, S1.control);
  assert.equal(addPlan(doc, id, ONE.candidateId, S1.control), plan, "the same choice keeps its plan");
  assert.deepEqual([plan.routes, plan.temporaryStops, plan.turnaroundAreas, plan.constraints, plan.vehicleWidthMeters], [null, null, null, null, null]);
  assert.equal(plan.selectedOnControlGeometryRevision, S1.control.controlGeometryRevision);
  const at = [doc, id, ONE.candidateId];
  const route = { key: "r1", polyline: [[139.01, 35.0002], [139.02, 35.0002]] };
  setRoute(...at, route);
  route.polyline[0][0] = 0;
  assert.equal(plan.routes[0].polyline[0][0], 139.01, "the document keeps its own copy");
  setRoute(...at, { key: "r1", polyline: ALONG, name: "renamed" });
  assert.equal(plan.routes.length, 1, "a key replaces");
  setRoute(...at, { key: "r2", polyline: ALONG });
  removeRoute(...at, "r1");
  assert.deepEqual(plan.routes.map((r) => r.key), ["r2"]);
  setTemporaryStop(...at, { key: "s", stationId: W.a1, location: [139.0102, 35.0002] });
  setTurnaroundArea(...at, { key: "t", location: [139.012, 35.0003] });
  setConstraint(...at, { key: "c", kind: "bridge", location: [139.015, 35.0002] });
  removeTemporaryStop(...at, "s");
  removeTurnaroundArea(...at, "t");
  removeConstraint(...at, "c");
  assert.deepEqual([plan.temporaryStops, plan.turnaroundAreas, plan.constraints], [[], [], []], "removing the last one leaves a list the player emptied, not null");
  declareNone(...at, "route");
  assert.deepEqual(plan.routes, []);
  assert.throws(() => declareNone(...at, "bridge"), /Unknown drawing kind/);
  setVehicleWidth(...at, 2.5);
  assert.equal(plan.vehicleWidthMeters, 2.5);
  setVehicleWidth(...at, 0);
  assert.equal(plan.vehicleWidthMeters, null);
  assert.throws(() => setRoute(doc, id, "railway-control-suspension:other", route), /Unknown replacement plan/);
});

test("editor: turnback choices come from the control geometry; a plan chosen on an older control geometry is outdated, a gone candidate is stale", () => {
  const doc = newRailReplacementDoc("t", "1");
  const id = S1.site.eventId;
  addPlan(doc, id, ONE.candidateId, S1.control);
  selectTurnback(doc, id, ONE.candidateId, ONE.startTurnbackCandidateId, S1.control);
  selectTurnback(doc, id, ONE.candidateId, ONE.startTurnbackCandidateId, S1.control);
  selectTurnback(doc, id, ONE.candidateId, ONE.endTurnbackCandidateId, S1.control);
  assert.equal(doc.plans[0].turnbackCandidateIds.length, 2);
  assert.throws(() => selectTurnback(doc, id, ONE.candidateId, "railway-control-turnback:made-up", S1.control), /Unknown turnback candidate/);
  deselectTurnback(doc, id, ONE.candidateId, ONE.endTurnbackCandidateId);
  assert.deepEqual(doc.plans[0].turnbackCandidateIds, [ONE.startTurnbackCandidateId]);
  assert.deepEqual(reconcilePlan(doc, id, ONE.candidateId, S1.control), { offered: true, outdated: false, staleTurnbackCandidateIds: [] });
  const later = { ...S1.control, controlGeometryRevision: "railway-service-control-revision:later", turnbackCandidates: S1.control.turnbackCandidates.filter((t) => t.candidateId !== ONE.startTurnbackCandidateId) };
  assert.deepEqual(reconcilePlan(doc, id, ONE.candidateId, later), { offered: true, outdated: true, staleTurnbackCandidateIds: [ONE.startTurnbackCandidateId] });
  assert.equal(reconcilePlan(doc, id, ONE.candidateId, { ...later, partialSuspensionCandidates: [] }).offered, false);
});

test("editor: a plan is switched off, never deleted; saving and restoring keeps every plan, drawing and id; another pack's save is refused", () => {
  const doc = newRailReplacementDoc("t", "1");
  const id = S1.site.eventId;
  addPlan(doc, id, ONE.candidateId, S1.control);
  setRoute(doc, id, ONE.candidateId, ROUTE);
  selectTurnback(doc, id, ONE.candidateId, ONE.startTurnbackCandidateId, S1.control);
  deactivatePlan(doc, id, ONE.candidateId);
  assert.equal(activePlans(doc).length, 0);
  assert.equal(doc.plans.length, 1);
  restorePlan(doc, id, ONE.candidateId);
  assert.equal(activePlans(doc).length, 1);
  assert.deepEqual(Object.keys(editorModule).filter((k) => /^(remove|delete|drop)(Plan|Document)/i.test(k)), [], "a plan has no delete");
  const text = serializeRailReplacementDoc(doc);
  const back = restoreRailReplacementDoc(text, pack);
  assert.deepEqual(back.doc, doc);
  assert.equal(serializeRailReplacementDoc(back.doc), text);
  const before = buildRailReplacementTransport(toReplacementDocument(doc.plans[0]), ctxFor(W, S1, { spatial: SPATIAL })).replacement;
  const after = buildRailReplacementTransport(toReplacementDocument(back.doc.plans[0]), ctxFor(W, S1, { spatial: SPATIAL })).replacement;
  assert.equal(after.replacementGeometryId, before.replacementGeometryId, "the id survives save and reopen");
  assert.equal(JSON.stringify(after), JSON.stringify(before));
  const other = restoreRailReplacementDoc(text, { manifest: { id: "other", version: "1" } });
  assert.deepEqual(other.doc.plans, []);
  assert.equal(other.warnings[0].code, "rail-replacement-doc-other-pack");
  assert.equal(restoreRailReplacementDoc("{not json", pack).warnings[0].code, "rail-replacement-doc-unreadable");
  assert.equal(restoreRailReplacementDoc(JSON.stringify({ version: 9 }), pack).warnings[0].code, "rail-replacement-doc-version");
  assert.equal(restoreRailReplacementDoc(text, { manifest: { id: "t", version: "2" } }).warnings[0].code, "pack-version-mismatch");
  assert.deepEqual(restoreRailReplacementDoc(null, pack).doc.plans, []);
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
const BANNED_TEXT = /원|비용|공기|승인|확률|가능|불가|복구|지연|보상|평판|손실|시간|용량|수송력|점수|순위/;
const viewExport = () => buildRailReplacementTransportExport({
  pack, sites: [S1.site], controls: [S1.control], railGeometries: [W.G], applications: [W.APP], stationSites: STATION_SITES, spatial: SPATIAL,
  documents: [baseDoc(ONE, { routes: [ROUTE, { key: "off", polyline: [[139.01, 35.004], [139.02, 35.004]] }], temporaryStops: [{ key: "s", stationId: W.a1, location: [139.0102, 35.0002], roadWidthMeters: 6 }], turnaroundAreas: [{ key: "t", kind: "turnaround", polygon: rect(139.0104, 35.0003, 139.0109, 35.0007) }], constraints: [{ key: "c", kind: "bridge", location: [139.015, 35.0002] }], vehicleWidthMeters: 2.5, turnbackCandidateIds: [ONE.startTurnbackCandidateId] })],
});

test("view: a measured stop, a stop the player named, a drawn route and a place are different kinds; a route is coloured by how it meets the road", () => {
  const styles = [STYLES.rail, STYLES.derivedStop, STYLES.playerStop, STYLES.area, STYLES.constraint];
  assert.equal(new Set(styles.map((s) => s.color)).size, styles.length);
  assert.equal(new Set(Object.values(ROUTE_STYLES).map((s) => s.color)).size, 3);
  assert.notDeepEqual(ROUTE_STYLES.true.dash, ROUTE_STYLES.false.dash);
  const model = buildRailReplacementTransportView({ exportData: viewExport() });
  assert.equal(model.schema, "transitline.rail-replacement-transport-map-view/1");
  const r = model.replacements[0];
  assert.deepEqual(r.routes.map((q) => [q.key, q.style.key]).sort(), [["bus-1", "on-road"], ["off", "off-road"]]);
  assert.deepEqual(new Set(r.stops.map((s) => s.style.key)), new Set(["derived-stop", "player-stop"]));
  assert.equal(r.areas[0].label, "회차 장소");
  assert.equal(r.stations.filter((s) => s.boundary).length, 2);
  assert.ok(r.walkLinks.length > 0 && r.walkLinks.every((w) => w.meters >= 0));
  assert.equal(buildRailReplacementTransportView({ exportData: { replacements: [], inactive: [], warnings: [] }, selectedId: "x" }).replacements.length, 0);
});

test("view: drawing is read-only, marks the player's routes and places, draws no line where there is no road route, and no marker for unknown entrances", () => {
  const exportData = deepFreeze(viewExport());
  const model = buildRailReplacementTransportView({ exportData, selectedId: exportData.replacements[0].replacementGeometryId });
  const f = fakeCtx();
  drawRailReplacementTransportOverlay(f.ctx, model, screen);
  const texts = f.calls.filter((c) => c[0] === "fillText").map((c) => String(c[1]));
  for (const glyph of [STYLES.station.glyph, STYLES.derivedStop.glyph, STYLES.playerStop.glyph, STYLES.constraint.glyph, "↻"]) assert.ok(texts.includes(glyph), glyph);
  assert.ok(f.calls.filter((c) => c[0] === "stroke").length >= 4);
  assert.ok(f.calls.every((c) => !["fetch", "commit", "settle", "post"].includes(c[0])));
  const bare = buildRailReplacementTransportView({ exportData: buildRailReplacementTransportExport({ pack, sites: [S1.site], controls: [S1.control], railGeometries: [W.G], documents: [baseDoc(ONE)] }) });
  const g = fakeCtx();
  drawRailReplacementTransportOverlay(g.ctx, bare, screen);
  assert.equal(g.calls.filter((c) => c[0] === "lineTo").length >= 1, true, "the suspended rail itself is drawn");
  assert.equal(g.calls.some((c) => c[0] === "fillText" && c[1] === STYLES.derivedStop.glyph), false, "no stop is drawn where none is known");
  assert.equal(bare.replacements[0].routes.length, 0);
  assert.equal(bare.replacements[0].stations.every((s) => s.entrancesKnown === false), true);
});

test("view: the panel and legend use textContent only, say the map finds no route, and never show cost, time, fleet or a usable-or-not verdict", () => {
  const model = buildRailReplacementTransportView({ exportData: { ...viewExport(), warnings: [{ code: "rail-replacement-transport-rejected" }] } });
  model.replacements[0].routes[0].name = "<img src=x onerror=alert(1)>";
  const panel = fakeDom();
  renderRailReplacementTransportPanel(panel, model);
  const all = textsOf(panel);
  assert.ok(all.some((t) => t.includes("<img src=x onerror=alert(1)>")), "a player-supplied string is shown as text");
  assert.ok(all.some((t) => t.startsWith("대체수송 공간 후보 1건")));
  assert.ok(all.some((t) => t.includes("rail-replacement-transport-rejected")));
  assert.ok(all.some((t) => t.includes("도로 폭")));
  assert.ok(all.some((t) => t.includes("연결 그래프가 아니라")));
  assert.equal(all.some((t) => BANNED_TEXT.test(t)), false);
  const empty = fakeDom();
  renderRailReplacementTransportPanel(empty, buildRailReplacementTransportView({ exportData: { replacements: [], inactive: [], warnings: [] } }));
  assert.equal(empty.hidden, true);
  const legend = fakeDom();
  renderRailReplacementTransportLegend(legend);
  const legendText = textsOf(legend);
  assert.ok(legendText.length >= 12);
  assert.ok(legendText.some((t) => t.includes("지도는 경로를 찾지 않는다")));
  assert.equal(legendText.some((t) => BANNED_TEXT.test(t)), false);
});

// --- shipped examples: regenerated by the script, and checked against the contract and the M6 / M7 examples ---
const examplePacks = ["tokyo", "example-radial", "example-corridor"];
const exampleDir = (id) => path.join(root, "packs", id, "rail-replacement-transport-examples");
const readExamples = (id) => fs.readdirSync(exampleDir(id)).filter((f) => f.endsWith(".rail-replacement-transport.json")).sort().map((f) => ({ file: f, replacement: JSON.parse(fs.readFileSync(path.join(exampleDir(id), f), "utf8")) }));

test("every shipped example satisfies the contract: synthetic label, player basis, unknown contract, no forbidden fields, resolving ids", () => {
  for (const id of examplePacks) {
    const examples = readExamples(id);
    assert.ok(examples.length >= 1, id);
    for (const { file, replacement: example } of examples) {
      const { source, ...body } = example;
      assert.equal(body.schema, RAIL_REPLACEMENT_TRANSPORT_SCHEMA, `${id}/${file}`);
      assert.equal(body.sourcePackId, id);
      assert.equal(source.generatedBy, "scripts/build-rail-replacement-transport-examples.mjs");
      assert.equal(source.synthetic, true);
      assert.equal(body.replacementGeometryId, replacementGeometryIdOf(id, body.eventId, body.partialSuspensionCandidateId), file);
      assert.deepEqual(fieldNames(body).filter((k) => FORBIDDEN.test(k)), [], file);
      assertUnknownContract(body, `${id}/${file}`);
      assert.equal(body.derivedRouteCandidates, null, file);
      assert.equal(body.unknownReasons.derivedRouteCandidates, "road-graph-not-in-source");
      assert.ok((body.routeCandidates ?? []).every((r) => r.basis === "player"), `${file}: every route is the player's`);
      assert.ok((body.turnaroundAreas ?? []).every((a) => a.basis === "player"));
      const stopIds = new Set((body.stopCandidates ?? []).map((s) => s.stopCandidateId));
      for (const s of body.stations) for (const sid of [...(s.derivedStopCandidateIds ?? []), ...(s.playerStopCandidateIds ?? [])]) assert.ok(stopIds.has(sid), `${file}: stop ${sid}`);
      for (const s of body.stations) for (const w of s.walkLinks ?? []) assert.ok(stopIds.has(w.stopCandidateId) && s.entrances.some((e) => e.entranceId === w.entranceId), `${file}: walk link`);
      if (body.stationSequence) assert.deepEqual(body.stations.map((s) => s.stationId), body.stationSequence, file);
    }
  }
});

test("no id regression: each example's disruption site and control geometry still have the ids and revisions of the shipped M6 / M7 example it was built on", () => {
  for (const id of examplePacks) {
    for (const { file, replacement: body } of readExamples(id)) {
      const m7 = JSON.parse(fs.readFileSync(path.join(root, "packs", id, "railway-service-control-examples", `${body.source.m7Example}.service-control.json`), "utf8"));
      assert.equal(m7.controlGeometryId, controlGeometryIdOf(id, m7.eventId), `${id}/${body.source.m7Example}`);
      assert.equal(m7.disruptionSiteId, disruptionSiteIdOf(id, m7.eventId));
      if (!body.source.retargeted) {
        assert.equal(body.controlGeometryId, m7.controlGeometryId, file);
        assert.equal(body.controlGeometryRevision, m7.controlGeometryRevision, `${file}: the control geometry revision moved`);
        assert.equal(body.disruptionSiteId, m7.disruptionSiteId, file);
        assert.equal(body.disruptionSiteRevision, m7.disruptionSiteRevision, file);
        assert.ok(m7.partialSuspensionCandidates.some((c) => c.candidateId === body.partialSuspensionCandidateId), `${file}: the chosen suspension is one the M7 example offers`);
      }
    }
    // every shipped M6 and M7 example keeps the id its event and pack give it
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
  const all = examplePacks.flatMap((id) => readExamples(id).map((e) => e.replacement));
  const cases = new Set(all.flatMap((s) => s.source.case));
  for (const c of ["middle-section", "boundary-stations", "line-end", "several-stations", "route-order", "station-entrances", "temporary-stop", "player-route", "road-disconnected", "road-width", "entrance-data-unknown", "no-road-layer", "bus-turnaround", "waiting-space", "boarding-space", "outside-road-coverage", "external-station"]) assert.ok(cases.has(c), c);
  const caseOf = (c) => all.filter((s) => s.source.case.includes(c));
  assert.ok(caseOf("middle-section").every((s) => s.stationSequence.length === 2 && s.stations.every((x) => x.role !== "interior") && s.routeCandidates.some((r) => r.reachesStartStation && r.reachesEndStation)));
  assert.ok(caseOf("several-stations").every((s) => s.stationSequence.length >= 3 && s.routeCandidates.some((r) => r.orderMatchesRail === true && r.visitedStationIds.length === s.stationSequence.length)));
  assert.ok(caseOf("station-entrances").every((s) => s.stations.some((x) => x.entrances?.length > 0 && x.derivedStopCandidateIds?.length > 0 && x.walkLinks?.length > 0)));
  assert.ok(caseOf("road-disconnected").every((s) => s.routeCandidates.some((r) => r.alongRoad.fullyOnRoad === false && r.alongRoad.offRoadRuns.length > 0)));
  assert.ok(caseOf("road-width").every((s) => s.routeCandidates.some((r) => r.roadWidthMeters !== null)));
  assert.ok(caseOf("road-width").some((s) => s.routeCandidates.some((r) => r.roadWidthMeters === null && r.roadWidthAtLeastVehicleWidth === null) && s.routeCandidates.some((r) => r.roadWidthAtLeastVehicleWidth === true) && s.routeCandidates.some((r) => r.roadWidthAtLeastVehicleWidth === false)));
  assert.ok(caseOf("entrance-data-unknown").every((s) => s.stations.every((x) => x.entrances === null)));
  assert.ok(caseOf("no-road-layer").every((s) => s.routeCandidates.every((r) => r.alongRoad === null) && s.spatialFlags.includes("road-layer-missing")));
  assert.ok(caseOf("bus-turnaround").every((s) => ["turnaround", "waiting", "boarding"].every((k) => s.turnaroundAreas.some((a) => a.kind === k))));
  assert.ok(caseOf("outside-road-coverage").every((s) => s.routeCandidates.some((r) => r.alongRoad.unmeasuredCount > 0)));
  assert.ok(caseOf("external-station").every((s) => s.stations.every((x) => x.external === true && x.entrances === null) && s.railLengthMeters === null));
  assert.ok(caseOf("player-route").length >= 4);
  assert.ok(all.some((s) => s.selectedTurnbackCandidateIds.length === 2), "a plan with both boundary turnbacks chosen");
});

test("re-running the generator rewrites every example to the same canonical content", () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "rail-replacement-examples-"));
  const run = spawnSync(process.execPath, [path.join(root, "scripts", "build-rail-replacement-transport-examples.mjs"), "--out", out], { cwd: root, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const canonical = (text) => text.replaceAll("\r\n", "\n");
  for (const id of examplePacks) {
    const files = fs.readdirSync(exampleDir(id)).filter((f) => f.endsWith(".rail-replacement-transport.json")).sort();
    assert.deepEqual(fs.readdirSync(path.join(out, id)).sort(), files, id);
    for (const f of files) assert.equal(canonical(fs.readFileSync(path.join(out, id, f), "utf8")), canonical(fs.readFileSync(path.join(exampleDir(id), f), "utf8")), `${id}/${f}`);
  }
  fs.rmSync(out, { recursive: true, force: true });
});
