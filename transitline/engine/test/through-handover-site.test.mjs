import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { buildMapExport } from "../src/map/plan-geometry.mjs";
import { stableId } from "../src/map/ids.mjs";
import { makeSpatialContext, polygonLayer, roadLayerFromGeojson } from "../src/map/spatial.mjs";
import { buildThroughRoute } from "../src/map/through-route.mjs";
import {
  JOIN_TOLERANCE_METERS,
  THROUGH_HANDOVER_EXPORT_SCHEMA,
  CONNECTION_STRUCTURE_TYPES,
  THROUGH_HANDOVER_SITE_SCHEMA,
  buildThroughHandoverExport,
  buildThroughHandoverSite,
  keyedHandoverSiteId,
  snapToLegAlignment,
  turnoutCandidatesNear,
} from "../src/map/through-handover-site.mjs";
import {
  addSite, addTurnout, addWaypoint, addWorkArea, clearConnectionPoint, moveTurnout, moveWaypoint, newThroughHandoverDoc, rebindRoute,
  redrawWorkArea, removeSite, removeTurnout, removeWaypoint, removeWorkArea, restoreThroughHandoverDoc, selectHandover,
  serializeThroughHandoverDoc, selectWorkArea, setConnectionPoint, setMaximumGradient, setStructureType, setTurnoutSelected, toDrawnSite,
} from "../src/map/through-handover-editor.mjs";
import {
  CONNECTION_STYLES, buildThroughHandoverView, drawThroughHandoverOverlay, renderThroughHandoverLegend, renderThroughHandoverPanel,
} from "../src/map/through-handover-view.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");

// --- fixtures: plans along lat 35. a: 139.00-139.02, b continues from a's end, n starts ~36 m past a's end, c is far away ---
const pack = {
  manifest: { id: "t", version: "1", data: { license: "CC0-1.0", attribution: ["test"] } },
  demand: { points: ["d0", "d1", "d2", "d3", "d4"].map((id, i) => ({ id, name: id, location: [139 + i * 0.01, 35] })) },
  existingNetwork: { lines: [{ name: "E1", operator: "Operator X", osmRelationId: 42, stationIds: ["d1", "d2", "d3"] }] },
};
const line = (key, lons, lat = 35) => ({ key, name: key, vertices: lons.map((lon) => ({ location: [lon, lat], platformType: "side" })) });
const mapExport = buildMapExport({
  pack, mode: "existing",
  drawnLines: [line("a", [139, 139.01, 139.02]), line("b", [139.02, 139.03, 139.04]), line("c", [139.1, 139.11], 35.1), line("n", [139.0204, 139.03])],
});
const planId = (key) => stableId("plan", "t", "key", key);
const leg = (key, extra = {}) => ({ sourceKind: "planned", planId: planId(key), ...extra });
const EXT = { sourceKind: "external", externalLineId: "ext-line:42" };
const makeRoute = (drawn) => {
  const out = buildThroughRoute(drawn, { pack, plans: mapExport.plans, externalNetworks: mapExport.externalNetworks });
  assert.ok(out.route, JSON.stringify(out.warnings));
  return out.route;
};
const rAB = makeRoute({ key: "r-ab", legs: [leg("a"), leg("b")] });
const rAN = makeRoute({ key: "r-an", legs: [leg("a"), leg("n")] });
const rAE = makeRoute({ key: "r-ae", legs: [leg("a"), EXT] });
const END_A = [139.02, 35];
const START_N = [139.0204, 35];
// externalNetworks defaults to none: the coarse station-level rail layer only exists when a test asks for it
const ctxOf = (route, extra = {}) => ({ pack, route, plans: mapExport.plans, externalNetworks: [], ...extra });
const base = (route, extra = {}) => ({
  key: "site-1", name: "A to B", throughRouteId: route.throughRouteId, handoverId: route.handovers[0].handoverId,
  fromLegId: route.handovers[0].fromLegId, toLegId: route.handovers[0].toLegId, routeGeometryRevision: route.geometryRevision, ...extra,
});
const build = (route, drawn, extra = {}) => {
  const out = buildThroughHandoverSite(drawn, ctxOf(route, extra));
  assert.ok(out.site, JSON.stringify(out.warnings));
  return out.site;
};
const rejected = (route, drawn, code) => {
  const out = buildThroughHandoverSite(drawn, ctxOf(route));
  assert.equal(out.site, null);
  assert.equal(out.warnings[0].code, code);
  return out.warnings[0];
};
// a perfectly joined handover: both points at the end of a / start of b, a one-vertex connection
const joined = (extra = {}) => base(rAB, { fromConnectionPoint: END_A, toConnectionPoint: END_A, connectionAlignment: [END_A], ...extra });
// a 36 m connection from a's end to n's start
const bridge = (extra = {}) => base(rAN, { fromConnectionPoint: END_A, toConnectionPoint: START_N, connectionAlignment: [END_A, START_N], ...extra });

const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
const everywhere = () => true;
const src = (name) => ({ name, license: "CC0-1.0" });
const boxOf = (l) => [Math.min(...l.map((p) => p[0])), Math.min(...l.map((p) => p[1])), Math.max(...l.map((p) => p[0])), Math.max(...l.map((p) => p[1]))];
const layersOf = (spec = {}) => makeSpatialContext({
  ...(spec.buildings ? { buildings: polygonLayer(spec.buildings.map((r) => ({ rings: [r], kind: "yes" })), { covers: everywhere, quality: "medium", source: src("test buildings") }) } : {}),
  ...(spec.water ? { water: polygonLayer(spec.water.map((r) => ({ rings: [r] })), { covers: everywhere, quality: "medium", source: src("test water") }) } : {}),
  ...(spec.roads ? { roads: roadLayerFromGeojson({ features: spec.roads.map((c) => ({ geometry: { coordinates: c }, properties: { roadClass: "minor" } })) }, { covers: everywhere, quality: "high", source: src("test roads") }) } : {}),
  ...(spec.rail ? { rail: { items: spec.rail.map((l) => ({ line: l, bbox: boxOf(l) })), covers: everywhere, quality: "low", source: src("test rail") } } : {}),
  ...(spec.slopeDegrees !== undefined ? { dem: { elevationAt: () => 10, slopeAt: () => spec.slopeDegrees, covers: everywhere, quality: "medium", source: src("test dem") } } : {}),
});
const keysDeep = (value, found = new Set()) => {
  if (Array.isArray(value)) value.forEach((v) => keysDeep(v, found));
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) { found.add(k); keysDeep(v, found); }
  return found;
};
const FORBIDDEN = /cost|price|fee|cash|duration|verdict|approval|approve|probability|score|possible|conditional|impossible/i;
const deepFreeze = (o) => { if (o && typeof o === "object") { Object.values(o).forEach(deepFreeze); Object.freeze(o); } return o; };
const FAR = rect(139.5, 36, 139.6, 36.1);

// --- identity ---
test("same input gives the same handoverSiteId and byte-identical JSON", () => {
  const drawn = joined();
  const a = build(rAB, drawn);
  assert.equal(JSON.stringify(a), JSON.stringify(build(rAB, structuredClone(drawn))));
  assert.equal(a.handoverSiteId, keyedHandoverSiteId("t", "site-1"));
  assert.equal(a.schema, THROUGH_HANDOVER_SITE_SCHEMA);
  assert.equal(a.contractVersion, 1);
  assert.equal(a.throughRouteId, rAB.throughRouteId);
  assert.equal(a.routeGeometryRevision, rAB.geometryRevision);
  assert.equal(a.handoverId, rAB.handovers[0].handoverId);
  assert.equal(a.fromLegId, rAB.handovers[0].fromLegId);
  assert.equal(a.toLegId, rAB.handovers[0].toLegId);
});

test("name, draw direction and the order of turnouts / work areas change no id or output", () => {
  const t1 = { key: "t1", location: END_A, selected: true };
  const t2 = { key: "t2", location: [139.0202, 35], selected: true };
  const w1 = { key: "w1", polygon: rect(139.0201, 34.9998, 139.0203, 34.9999) };
  const w2 = { key: "w2", polygon: rect(139.0201, 35.0001, 139.0203, 35.0002) };
  const one = build(rAN, bridge({ turnoutCandidates: [t1, t2], workAreas: [w1, w2] }));
  const reordered = build(rAN, bridge({ turnoutCandidates: [t2, t1], workAreas: [w2, w1], connectionAlignment: [START_N, END_A] }));
  assert.equal(JSON.stringify(reordered), JSON.stringify(one));
  const renamed = build(rAN, bridge({ name: "something else", turnoutCandidates: [t1, t2], workAreas: [w1, w2] }));
  assert.equal(renamed.handoverSiteId, one.handoverSiteId);
  assert.equal(renamed.siteRevision, one.siteRevision, "a name is not a spatial fact");
  assert.deepEqual({ ...renamed, name: null }, { ...one, name: null });
  assert.deepEqual(one.connectionAlignment, [END_A, START_N], "the drawn track always runs from the from-side to the to-side");
  const ids = one.selectedTurnoutPoints.map((t) => t.turnoutId);
  assert.deepEqual(ids, [...ids].sort());
});

test("a keyed site keeps its id after it is edited; a keyless one follows route + handover, never the drawing", () => {
  const before = build(rAN, bridge());
  const edited = build(rAN, bridge({ connectionAlignment: [END_A, [139.0202, 35.0001], START_N], turnoutCandidates: [{ location: END_A }] }));
  assert.equal(edited.handoverSiteId, before.handoverSiteId);
  assert.notEqual(edited.siteRevision, before.siteRevision);
  assert.notEqual(build(rAN, bridge({ key: "other" })).handoverSiteId, before.handoverSiteId);
  const keyless = (extra) => build(rAN, bridge({ key: undefined, ...extra }));
  assert.equal(keyless({ name: "x" }).handoverSiteId, keyless({ connectionAlignment: [END_A, [139.0202, 35.0002], START_N] }).handoverSiteId);
  assert.equal(keyless().handoverSiteId, stableId("through-handover-site", "t", rAN.throughRouteId, rAN.handovers[0].handoverId));
});

test("route, handover and leg ids are validated", () => {
  rejected(rAB, joined({ throughRouteId: "through-route:nope" }), "through-route-id-mismatch");
  rejected(rAB, joined({ handoverId: "through-handover:nope" }), "handover-missing");
  const w = rejected(rAB, joined({ fromLegId: rAB.handovers[0].toLegId, toLegId: rAB.handovers[0].fromLegId }), "handover-legs-mismatch");
  assert.deepEqual(w.handover, [rAB.handovers[0].fromLegId, rAB.handovers[0].toLegId]);
  rejected(rAB, joined({ fromLegId: undefined }), "handover-legs-mismatch");
  rejected({ ...rAB, schema: "other/1" }, joined(), "route-schema-invalid");
  rejected(rAB, joined({ fromConnectionPoint: ["x", 1] }), "connection-point-invalid");
  rejected(rAB, joined({ connectionAlignment: [[139, 35], [500, 35]] }), "connection-alignment-invalid");
  rejected(rAB, joined({ connectionAlignment: "line" }), "connection-alignment-invalid");
  const batch = buildThroughHandoverExport({ pack, routes: [rAB], mapExport, sites: [joined(), joined(), bridge(), joined({ throughRouteId: "nope", key: "k3" })] });
  assert.equal(batch.schema, THROUGH_HANDOVER_EXPORT_SCHEMA);
  assert.equal(batch.sites.length, 1);
  assert.deepEqual(batch.warnings.map((x) => x.code), ["duplicate-through-handover-site", "through-handover-site-rejected", "through-handover-site-rejected"]);
});

// --- physical connection evidence: true, false and null are three different answers ---
test("a connection that meets both legs is true, with the plan segments it sits on and a zero gap", () => {
  const s = build(rAB, joined());
  const e = s.physicalConnectionEvidence;
  assert.equal(e.connected, true);
  assert.equal(e.reason, null);
  assert.equal(e.basis, "drawn-connection-vs-leg-alignments");
  assert.equal(s.endpointGapMeters, 0);
  assert.equal(s.connectionLengthMeters, 0);
  assert.deepEqual(s.connectedPlanSegmentIds, [rAB.legs[0].segmentIds.at(-1), rAB.legs[1].segmentIds[0]].sort());
  assert.equal(s.fromConnectionPoint.onLegAlignment, true);
  assert.equal(s.fromConnectionPoint.distanceToHandoverEndMeters, 0);
  assert.equal(s.toConnectionPoint.distanceToHandoverEndMeters, 0);
  assert.ok(!s.unknown.includes("physicalConnectionEvidence"));
  assert.equal(s.externalNetworkId, null);
  assert.deepEqual(s.externalSides, []);
});

test("a drawn connection that bridges two ends 36 m apart is true when it touches both legs", () => {
  const s = build(rAN, bridge());
  assert.equal(s.physicalConnectionEvidence.connected, true);
  assert.ok(Math.abs(s.connectionLengthMeters - 36) < 1, String(s.connectionLengthMeters));
  assert.equal(s.endpointGapMeters, 0);
});

test("within 50 m but not joined stays null (never false), keeps the measured gap and says why", () => {
  const s = build(rAN, bridge({ connectionAlignment: [END_A, [139.0202, 35]] }));
  assert.equal(s.physicalConnectionEvidence.connected, null);
  assert.equal(s.physicalConnectionEvidence.reason, "endpoints-near-not-joined");
  assert.ok(s.endpointGapMeters > JOIN_TOLERANCE_METERS && s.endpointGapMeters < 50, String(s.endpointGapMeters));
  assert.ok(s.unknown.includes("physicalConnectionEvidence"));
  assert.equal(s.unknownReasons.physicalConnectionEvidence, "endpoints-near-not-joined");
  assert.ok(s.spatialFlags.includes("connection-gap-within-near-distance"));
  assert.ok(!s.spatialFlags.includes("connection-separated"));
});

test("a measured gap beyond 50 m is false, with the gap and the flag", () => {
  const s = build(rAN, bridge({ connectionAlignment: [END_A, [139.0198, 35.0003]] }));
  assert.equal(s.physicalConnectionEvidence.connected, false);
  assert.equal(s.physicalConnectionEvidence.reason, null);
  assert.ok(s.endpointGapMeters > 50);
  assert.ok(s.spatialFlags.includes("connection-separated"));
  assert.ok(!s.unknown.includes("physicalConnectionEvidence"));
  const offLeg = build(rAB, base(rAB, { fromConnectionPoint: [139.02, 35.001], toConnectionPoint: [139.02, 35.001], connectionAlignment: [[139.02, 35.001]] }));
  assert.equal(offLeg.physicalConnectionEvidence.connected, false, "a selected point 111 m off the leg is a measured separation");
  assert.equal(offLeg.fromConnectionPoint.onLegAlignment, false);
});

test("without a drawn connection or without points the answer is null with the reason, not false", () => {
  const none = build(rAN, base(rAN, { fromConnectionPoint: END_A, toConnectionPoint: START_N }));
  assert.equal(none.physicalConnectionEvidence.connected, null);
  assert.equal(none.physicalConnectionEvidence.reason, "no-connection-drawn");
  for (const f of ["connectionAlignment", "connectionLengthMeters", "endpointGapMeters", "buildingIntersectionCount", "waterCrossingCount", "roadCrossingCount", "existingRailwayCrossingCount", "averageSlopePercent", "maximumSlopePercent", "minimumCurveRadiusMeters"]) {
    assert.ok(none.unknown.includes(f), f);
    assert.equal(none[f], null, f);
  }
  assert.equal(none.unknownReasons.waterCrossingCount, "no-connection-drawn");
  assert.ok(none.spatialFlags.includes("no-connection-drawn"));
  const empty = build(rAN, base(rAN));
  assert.equal(empty.fromConnectionPoint.location, null);
  assert.equal(empty.physicalConnectionEvidence.connected, null);
  assert.equal(empty.physicalConnectionEvidence.reason, "point-not-selected");
  assert.ok(empty.unknown.includes("fromConnectionPoint") && empty.unknown.includes("toConnectionPoint"));
  assert.equal(empty.connectedPlanSegmentIds, null);
  assert.equal(empty.unknownReasons.connectedPlanSegmentIds, "point-not-selected");
});

test("an external leg without a real alignment never yields true, however well the drawing lines up", () => {
  const ext = rAE.legs[1];
  assert.equal(ext.alignment, null);
  const station = mapExport.externalNetworks[0].stations.find((x) => x.id === ext.stationIds[0]);
  assert.ok(station, "the external station exists in the pack");
  const s = build(rAE, base(rAE, { fromConnectionPoint: END_A, toConnectionPoint: station.location, connectionAlignment: [END_A, station.location] }));
  assert.equal(s.physicalConnectionEvidence.connected, null);
  assert.equal(s.physicalConnectionEvidence.reason, "external-alignment-not-in-source");
  assert.equal(s.toConnectionPoint.legAlignmentKnown, false);
  assert.equal(s.toConnectionPoint.onLegAlignment, null);
  assert.equal(s.toConnectionPoint.distanceToLegAlignmentMeters, null);
  assert.ok(s.toConnectionPoint.unknown.includes("onLegAlignment"));
  assert.equal(s.externalNetworkId, ext.externalNetworkId);
  assert.equal(s.externalLineId, "ext-line:42");
  assert.equal(s.externalSides[0].legId, ext.legId);
  assert.ok(s.spatialFlags.includes("leg-alignment-unknown"));
  assert.equal(s.connectedPlanSegmentIds.length, 1, "only the planned side contributes a plan segment");
  assert.equal(JSON.stringify(s).includes("Operator X"), false, "an operator tag is never copied into an owner or a connection");
});

test("a real alignment supplied for the external line makes the same drawing measurable", () => {
  const ext = rAE.legs[1];
  const alignments = [{ externalNetworkId: ext.externalNetworkId, externalLineId: ext.externalLineId, alignments: [[[139.0204, 35], [139.03, 35]]], quality: "medium", source: { name: "synthetic fixture alignment", license: "CC0-1.0" } }];
  const drawn = base(rAE, { fromConnectionPoint: END_A, toConnectionPoint: START_N, connectionAlignment: [END_A, START_N] });
  const good = build(rAE, drawn, { externalAlignments: alignments });
  assert.equal(good.physicalConnectionEvidence.connected, true);
  assert.equal(good.toConnectionPoint.legAlignmentKind, "external-alignment");
  assert.equal(good.toConnectionPoint.alongLegMeters, null, "the order of an external alignment is not in the source");
  assert.ok(good.sourceLayers.some((l) => l.layer === "external-rail-alignment" && l.name === "synthetic fixture alignment"));
  const apart = build(rAE, drawn, { externalAlignments: [{ ...alignments[0], alignments: [[[139.0204, 35.002], [139.03, 35.002]]] }] });
  assert.equal(apart.physicalConnectionEvidence.connected, false);
});

test("a design made against another route revision is stale: null + warning, nothing is confirmed", () => {
  const stale = buildThroughHandoverSite(joined({ routeGeometryRevision: "through-route-revision:old" }), ctxOf(rAB));
  assert.equal(stale.site.physicalConnectionEvidence.connected, null);
  assert.equal(stale.site.physicalConnectionEvidence.reason, "route-revision-stale");
  assert.equal(stale.site.physicalConnectionEvidence.designedAgainstCurrentRoute, false);
  assert.equal(stale.site.routeGeometryRevision, rAB.geometryRevision);
  assert.equal(stale.site.designedRouteGeometryRevision, "through-route-revision:old");
  assert.deepEqual(stale.warnings.map((w) => w.code), ["route-revision-stale"]);
  assert.ok(stale.site.spatialFlags.includes("route-revision-stale"));
  assert.equal(stale.site.endpointGapMeters, 0, "the measured gaps are still reported");
  const unrecorded = buildThroughHandoverSite(joined({ routeGeometryRevision: undefined }), ctxOf(rAB));
  assert.equal(unrecorded.site.physicalConnectionEvidence.connected, null);
  assert.equal(unrecorded.site.physicalConnectionEvidence.reason, "design-revision-not-recorded");
  assert.equal(unrecorded.site.physicalConnectionEvidence.designedAgainstCurrentRoute, null);
});

// --- spatial facts ---
test("without layers every count is null with a reason; present-but-empty layers give a real 0", () => {
  const bare = build(rAN, bridge());
  for (const f of ["buildingIntersectionCount", "waterCrossingCount", "roadCrossingCount", "existingRailwayCrossingCount", "averageSlopePercent", "maximumSlopePercent"]) {
    assert.equal(bare[f], null, f);
    assert.ok(bare.unknown.includes(f), f);
  }
  assert.equal(bare.unknownReasons.buildingIntersectionCount, "no-layer");
  const empty = build(rAN, bridge(), { spatial: layersOf({ buildings: [FAR], water: [FAR], roads: [[[139.5, 36], [139.6, 36]]], rail: [[[139.5, 36], [139.6, 36]]], slopeDegrees: 0 }) });
  assert.deepEqual([empty.buildingIntersectionCount, empty.waterCrossingCount, empty.roadCrossingCount, empty.existingRailwayCrossingCount], [0, 0, 0, 0]);
  assert.equal(empty.averageSlopePercent, 0);
  assert.equal(empty.unknown.some((f) => /Count|Slope/.test(f)), false);
  assert.deepEqual(empty.spatialFlags, ["no-turnout-selected"]);
  // a layer that does not cover the track is outside-coverage, not 0
  const outside = build(rAN, bridge(), { spatial: makeSpatialContext({ buildings: polygonLayer([{ rings: [FAR] }], { covers: () => false, quality: "high", source: src("never covers") }) }) });
  assert.equal(outside.buildingIntersectionCount, null);
  assert.equal(outside.unknownReasons.buildingIntersectionCount, "outside-coverage");
});

test("the connection's building, water, road and railway crossings are counted, with their flags", () => {
  const spatial = layersOf({
    buildings: [rect(139.0201, 34.9999, 139.0203, 35.0001), rect(139.0201, 35.001, 139.0203, 35.0012)],
    water: [rect(139.02005, 34.99995, 139.02035, 35.00005)],
    roads: [[[139.0202, 34.999], [139.0202, 35.001]], [[139.0201, 34.999], [139.0201, 35.001]]],
    rail: [[[139.0203, 34.999], [139.0203, 35.001]]],
    slopeDegrees: 2,
  });
  const s = build(rAN, bridge(), { spatial });
  assert.equal(s.buildingIntersectionCount, 1);
  assert.equal(s.waterCrossingCount, 1);
  assert.equal(s.roadCrossingCount, 2);
  assert.deepEqual(s.roadCrossingsByClass, { highway: 0, major: 0, minor: 2 });
  assert.equal(s.existingRailwayCrossingCount, 1);
  assert.equal(s.averageSlopePercent, 3.49);
  assert.equal(s.maximumSlopePercent, 3.49);
  for (const f of ["connection-through-buildings", "connection-crosses-water", "connection-crosses-road", "connection-crosses-existing-railway"]) assert.ok(s.spatialFlags.includes(f), f);
  assert.deepEqual(s.sourceLayers.map((l) => l.layer), ["through-route-geometry", "buildings", "dem", "rail", "roads", "water"]);
  assert.equal(s.dataQuality, "low", "the coarse rail layer lowers the quality");
  assert.deepEqual(s.license, { pack: "CC0-1.0", attribution: ["test"] });
});

test("existing rail is the coarse station-to-station layer only when external networks are supplied, and says so", () => {
  const s = build(rAN, bridge(), { externalNetworks: mapExport.externalNetworks });
  assert.equal(typeof s.existingRailwayCrossingCount, "number");
  const rail = s.sourceLayers.find((l) => l.layer === "rail");
  assert.equal(rail.quality, "low");
  assert.match(rail.name, /station-level, coarse/);
});

test("some layers missing: only those facts are unknown", () => {
  const s = build(rAN, bridge(), { spatial: layersOf({ buildings: [rect(139.0201, 34.9999, 139.0203, 35.0001)], slopeDegrees: 1 }) });
  assert.equal(s.buildingIntersectionCount, 1);
  assert.ok(s.averageSlopePercent > 1.7 && s.averageSlopePercent < 1.8);
  for (const f of ["waterCrossingCount", "roadCrossingCount", "existingRailwayCrossingCount"]) {
    assert.equal(s[f], null, f);
    assert.equal(s.unknownReasons[f], "no-layer", f);
  }
  assert.equal(s.roadCrossingsByClass, null);
});

test("selected turnouts: only the selected are output, with where they sit; off-track is false, unmeasurable is null", () => {
  const s = build(rAN, bridge({ turnoutCandidates: [
    { key: "on-leg", location: END_A },
    { key: "on-connection", location: [139.0202, 35] },
    { key: "off", location: [139.0202, 35.001] },
    { key: "candidate-only", location: [139.0203, 35], selected: false },
  ] }));
  assert.equal(s.selectedTurnoutPoints.length, 3);
  const byKey = Object.fromEntries(s.selectedTurnoutPoints.map((t) => [t.key, t]));
  assert.equal(byKey["on-leg"].onTrack, true);
  assert.equal(byKey["on-leg"].nearestLegId, rAN.handovers[0].fromLegId);
  assert.equal(byKey["on-connection"].onTrack, true);
  assert.equal(byKey["on-connection"].nearestLegId, null);
  assert.equal(byKey.off.onTrack, false);
  assert.ok(s.spatialFlags.includes("turnout-not-on-track"));
  assert.equal(byKey["on-leg"].turnoutId, stableId("through-turnout", s.handoverSiteId, "on-leg"));
  const ext = build(rAE, base(rAE, { fromConnectionPoint: END_A, turnoutCandidates: [{ key: "x", location: [139.0301, 35.0002] }] }));
  assert.equal(ext.selectedTurnoutPoints[0].onTrack, null, "no known alignment and no drawn connection: it cannot be said");
  assert.equal(ext.selectedTurnoutPoints[0].distanceToToLegMeters, null);
  assert.ok(!ext.spatialFlags.includes("turnout-not-on-track"));
  assert.equal(build(rAN, bridge()).selectedTurnoutPoints.length, 0);
});

test("work areas: canonical ring, area, overlaps, what they cover; degenerate ones are dropped with a warning", () => {
  const ring = rect(139.0199, 34.9998, 139.0205, 35.0002);
  const out = buildThroughHandoverSite(bridge({
    turnoutCandidates: [{ key: "t", location: END_A }],
    workAreas: [{ key: "w", polygon: ring.slice(0, 4) }, { polygon: [[1, 1], [2, 2]] }, { polygon: [[139, 35], [139.002, 35.001], [139.002, 35], [139, 35.002]] }],
  }), ctxOf(rAN, { spatial: layersOf({ buildings: [rect(139.0204, 34.9999, 139.0206, 35.0001)], water: [FAR] }) }));
  assert.deepEqual(out.warnings.map((w) => w.code), ["work-area-degenerate", "work-area-self-intersecting"]);
  assert.equal(out.site.workAreaCandidates.length, 1);
  const [w] = out.site.workAreaCandidates;
  assert.equal(w.workAreaId, stableId("through-work-area", out.site.handoverSiteId, "w"));
  assert.deepEqual(w.polygon[0], [139.0199, 34.9998], "starts at the lowest vertex");
  assert.ok(w.areaSquareMeters > 2300 && w.areaSquareMeters < 2600, String(w.areaSquareMeters));
  assert.equal(w.buildingIntersectionCount, 1);
  assert.equal(w.waterOverlapCount, 0);
  assert.equal(w.containsFromConnectionPoint, true);
  assert.equal(w.containsToConnectionPoint, true);
  assert.equal(w.coversConnectionAlignment, true);
  assert.deepEqual(w.containedTurnoutIds, [out.site.selectedTurnoutPoints[0].turnoutId]);
  assert.ok(out.site.spatialFlags.includes("work-area-building-overlap"));
  const noLayers = build(rAN, bridge({ workAreas: [{ key: "w", polygon: ring }] })).workAreaCandidates[0];
  assert.equal(noLayers.buildingIntersectionCount, null);
  assert.deepEqual(noLayers.unknown, ["buildingIntersectionCount", "waterOverlapCount"]);
  const small = build(rAN, bridge({ workAreas: [{ key: "w", polygon: rect(139.0201, 34.9999, 139.0202, 35.0001) }] })).workAreaCandidates[0];
  assert.equal(small.containsFromConnectionPoint, false);
  assert.equal(small.coversConnectionAlignment, false);
});

test("minimum curve radius: straight reports the cap, a bend its fillet radius, nothing drawn or zero length is null", () => {
  assert.equal(build(rAN, bridge()).minimumCurveRadiusMeters, 100000, "two vertices: a straight run");
  const bend = build(rAN, bridge({ connectionAlignment: [END_A, [139.0202, 35.0003], START_N] }));
  assert.ok(bend.minimumCurveRadiusMeters > 0 && bend.minimumCurveRadiusMeters < 100, String(bend.minimumCurveRadiusMeters));
  const sharper = build(rAN, bridge({ connectionAlignment: [END_A, [139.0202, 35.0006], START_N] }));
  assert.ok(sharper.minimumCurveRadiusMeters < bend.minimumCurveRadiusMeters * 2.5 && sharper.minimumCurveRadiusMeters !== bend.minimumCurveRadiusMeters);
  const none = build(rAN, base(rAN, { fromConnectionPoint: END_A }));
  assert.equal(none.minimumCurveRadiusMeters, null);
  assert.equal(none.unknownReasons.minimumCurveRadiusMeters, "no-connection-drawn");
  const zero = build(rAB, joined());
  assert.equal(zero.minimumCurveRadiusMeters, null);
  assert.equal(zero.unknownReasons.minimumCurveRadiusMeters, "zero-length-connection");
});

test("structure type is only what the player states, from the management engine's five types; never inferred from water or buildings", () => {
  assert.deepEqual([...CONNECTION_STRUCTURE_TYPES], ["at-grade", "cut-cover", "tunnel", "viaduct", "bridge"]);
  const spatial = layersOf({ water: [rect(139.02005, 34.99995, 139.02035, 35.00005)], buildings: [rect(139.0201, 34.9999, 139.0203, 35.0001)] });
  const unstated = build(rAN, bridge(), { spatial });
  assert.equal(unstated.waterCrossingCount, 1);
  assert.equal(unstated.structureType, null);
  assert.equal(unstated.structureTypeBasis, null);
  assert.ok(unstated.unknown.includes("structureType"));
  assert.equal(unstated.unknownReasons.structureType, "structure-not-stated");
  const stated = buildThroughHandoverSite(bridge({ structureType: "bridge" }), ctxOf(rAN, { spatial }));
  assert.equal(stated.site.structureType, "bridge");
  assert.equal(stated.site.structureTypeBasis, "player");
  assert.ok(!stated.site.unknown.includes("structureType"));
  for (const wrong of ["magic", "elevated", "surface"]) {
    const bad = buildThroughHandoverSite(bridge({ structureType: wrong }), ctxOf(rAN));
    assert.equal(bad.site.structureType, null, wrong);
    assert.equal(bad.warnings[0].code, "invalid-structure-type");
  }
  assert.notEqual(stated.site.siteRevision, unstated.siteRevision);
});

test("maximum gradient is only the designed value the player states; the ground slope never fills it", () => {
  const withDem = build(rAN, bridge(), { spatial: layersOf({ slopeDegrees: 2 }) });
  assert.equal(withDem.averageSlopePercent, 3.49);
  assert.equal(withDem.maximumGradientPermille, null, "a ground slope of 3.49 % is not a 34.9 permille track gradient");
  assert.equal(withDem.maximumGradientBasis, null);
  assert.ok(withDem.unknown.includes("maximumGradientPermille"));
  assert.equal(withDem.unknownReasons.maximumGradientPermille, "track-profile-not-designed");
  const stated = build(rAN, bridge({ maximumGradientPermille: 30.04 }));
  assert.equal(stated.maximumGradientPermille, 30);
  assert.equal(stated.maximumGradientBasis, "player");
  assert.ok(!stated.unknown.includes("maximumGradientPermille"));
  assert.equal(build(rAN, bridge({ maximumGradientPermille: 0 })).maximumGradientPermille, 0, "a designed level track is 0, not unknown");
  for (const wrong of [-1, "30", NaN, Infinity]) {
    const bad = buildThroughHandoverSite(bridge({ maximumGradientPermille: wrong }), ctxOf(rAN));
    assert.equal(bad.site.maximumGradientPermille, null, String(wrong));
    assert.equal(bad.warnings[0].code, "invalid-gradient");
  }
});

test("the chosen work area is reported by id; no area, no choice or a missing key are null with a reason", () => {
  const areas = [{ key: "w1", polygon: rect(139.0199, 34.9998, 139.0205, 35.0002) }, { key: "w2", polygon: rect(139.0201, 35.0001, 139.0203, 35.0002) }];
  const chosen = build(rAN, bridge({ workAreas: areas, selectedWorkAreaKey: "w2" }));
  assert.equal(chosen.selectedWorkAreaCandidateId, chosen.workAreaCandidates.find((w) => w.key === "w2").workAreaId);
  assert.equal(chosen.selectedWorkAreaCandidateId, stableId("through-work-area", chosen.handoverSiteId, "w2"));
  assert.ok(!chosen.unknown.includes("selectedWorkAreaCandidateId"));
  assert.equal(JSON.stringify(build(rAN, bridge({ workAreas: [...areas].reverse(), selectedWorkAreaKey: "w2" }))), JSON.stringify(chosen), "drawing order does not matter");
  const none = build(rAN, bridge({ workAreas: areas }));
  assert.equal(none.selectedWorkAreaCandidateId, null);
  assert.equal(none.unknownReasons.selectedWorkAreaCandidateId, "work-area-not-selected");
  const empty = build(rAN, bridge({ selectedWorkAreaKey: "w1" }));
  assert.equal(empty.selectedWorkAreaCandidateId, null);
  assert.equal(empty.unknownReasons.selectedWorkAreaCandidateId, "no-work-area-drawn");
  const missing = buildThroughHandoverSite(bridge({ workAreas: areas, selectedWorkAreaKey: "w9" }), ctxOf(rAN));
  assert.equal(missing.site.selectedWorkAreaCandidateId, null);
  assert.equal(missing.warnings[0].code, "selected-work-area-missing");
  assert.notEqual(chosen.siteRevision, build(rAN, bridge({ workAreas: areas, selectedWorkAreaKey: "w1" })).siteRevision);
});

test("turnoutCandidates lists every candidate with its selected flag; selectedTurnoutPoints only the chosen ones", () => {
  const s = build(rAN, bridge({ turnoutCandidates: [{ key: "a", location: END_A }, { key: "b", location: [139.0202, 35], selected: false }] }));
  assert.equal(s.turnoutCandidates.length, 2);
  assert.deepEqual(s.turnoutCandidates.map((t) => [t.key, t.selected]).sort(), [["a", true], ["b", false]]);
  assert.deepEqual(s.selectedTurnoutPoints.map((t) => t.key), ["a"]);
  assert.equal(s.turnoutCandidates.find((t) => t.key === "a").turnoutId, s.selectedTurnoutPoints[0].turnoutId);
  assert.deepEqual(build(rAN, bridge()).turnoutCandidates, []);
});

// --- the module is spatial only ---
test("no management import, no cost / price / duration / verdict / approval / probability field anywhere", () => {
  for (const file of ["through-handover-site", "through-handover-editor", "through-handover-view"]) {
    const text = fs.readFileSync(path.join(here, "..", "src", "map", `${file}.mjs`), "utf8");
    assert.equal(/from\s+["'][^"']*management/.test(text), false, file);
    assert.equal(/scenario-runtime|game\.mjs/.test(text.replace(/\/\/.*$/gm, "")), false, file);
  }
  const rich = build(rAN, bridge({ turnoutCandidates: [{ key: "t", location: END_A }], workAreas: [{ key: "w", polygon: rect(139.0199, 34.9998, 139.0205, 35.0002) }] }), {
    spatial: layersOf({ buildings: [rect(139.0201, 34.9999, 139.0203, 35.0001)], water: [rect(139.02005, 34.99995, 139.02035, 35.00005)], roads: [[[139.0202, 34.999], [139.0202, 35.001]]], rail: [[[139.0203, 34.999], [139.0203, 35.001]]], slopeDegrees: 2 }),
  });
  assert.deepEqual([...keysDeep(rich)].filter((k) => FORBIDDEN.test(k)), []);
  const view = buildThroughHandoverView({ routes: [rAN], exportData: { sites: [rich], warnings: [] } });
  assert.deepEqual([...keysDeep(view)].filter((k) => FORBIDDEN.test(k)), []);
});

test("the inputs are never mutated (frozen route, plans, drawn site, layers)", () => {
  const drawn = deepFreeze(bridge({ turnoutCandidates: [{ key: "t", location: END_A }], workAreas: [{ key: "w", polygon: rect(139.0199, 34.9998, 139.0205, 35.0002) }] }));
  const route = deepFreeze(structuredClone(rAN));
  const plans = deepFreeze(structuredClone(mapExport.plans));
  const before = JSON.stringify([drawn, route, plans]);
  const out = buildThroughHandoverSite(drawn, { pack, route, plans, externalNetworks: [], spatial: layersOf({ buildings: [rect(139.0201, 34.9999, 139.0203, 35.0001)] }) });
  assert.ok(out.site);
  assert.equal(JSON.stringify([drawn, route, plans]), before);
  const exp = buildThroughHandoverExport({ pack, routes: [route], mapExport: { plans, externalNetworks: [] }, sites: [drawn] });
  assert.equal(exp.sites.length, 1);
});

test("null stays null: no unknown value is ever turned into 0, false or an empty list", () => {
  const s = build(rAE, base(rAE));
  for (const f of ["connectionAlignment", "connectionLengthMeters", "endpointGapMeters", "connectedPlanSegmentIds", "buildingIntersectionCount", "waterCrossingCount", "roadCrossingCount", "existingRailwayCrossingCount", "averageSlopePercent", "maximumSlopePercent"]) {
    assert.equal(s[f], null, f);
    assert.ok(s.unknown.includes(f), f);
  }
  for (const f of s.unknown) assert.equal(typeof s.unknownReasons[f], "string", f);
  assert.equal(s.physicalConnectionEvidence.connected, null);
  for (const side of s.physicalConnectionEvidence.sides) assert.equal(side.joined, null);
  for (const p of [s.fromConnectionPoint, s.toConnectionPoint]) {
    assert.equal(p.onLegAlignment, null);
    for (const f of p.unknown) assert.equal(typeof p.unknownReasons[f], "string", f);
  }
});

test("snapToLegAlignment and turnoutCandidatesNear are pure helpers over the route's alignments", () => {
  const legId = rAB.legs[0].legId;
  const snapped = snapToLegAlignment(rAB, legId, [139.0151, 35.0002]);
  assert.deepEqual(snapped.location, [139.0151, 35]);
  assert.ok(Math.abs(snapped.distanceMeters - 22.3) < 0.5, String(snapped.distanceMeters));
  assert.equal(snapToLegAlignment(rAB, legId, [139.0151, 35.01]), null, "farther than 50 m");
  assert.equal(snapToLegAlignment(rAE, rAE.legs[1].legId, [139.03, 35]), null, "an external leg without alignment has nothing to snap to");
  const frozen = deepFreeze(structuredClone(rAB));
  assert.deepEqual(turnoutCandidatesNear(frozen, legId, [139.0195, 35], 100).map((c) => c.location), [[139.02, 35]]);
  assert.deepEqual(turnoutCandidatesNear(rAE, rAE.legs[1].legId, END_A), []);
});

// --- editor ---
test("editor: pick a handover, both points, waypoints, turnouts, work areas; the key and id never change", () => {
  const doc = newThroughHandoverDoc("t", "1");
  const site = addSite(doc, rAN, rAN.handovers[0].handoverId, { name: "n" });
  assert.equal(site.key, "handover-1");
  assert.equal(site.routeGeometryRevision, rAN.geometryRevision);
  const built = () => buildThroughHandoverSite(toDrawnSite(site), ctxOf(rAN)).site;
  const id = built().handoverSiteId;
  assert.equal(id, keyedHandoverSiteId("t", "handover-1"));
  assert.equal(built().physicalConnectionEvidence.reason, "point-not-selected");
  setConnectionPoint(doc, site.key, "from", [139.0199, 35.0002], { route: rAN });
  assert.deepEqual(site.fromConnectionPoint, [139.0199, 35], "snapped onto the leg's alignment");
  setConnectionPoint(doc, site.key, "to", START_N, { route: rAN });
  assert.equal(built().physicalConnectionEvidence.connected, true, "no waypoints: the connection is the two points");
  addWaypoint(doc, site.key, [139.0202, 35.0001]);
  addWaypoint(doc, site.key, [139.0203, 35.0001]);
  addWaypoint(doc, site.key, [139.02015, 35.0001], 0);
  assert.deepEqual(site.via, [[139.02015, 35.0001], [139.0202, 35.0001], [139.0203, 35.0001]]);
  moveWaypoint(doc, site.key, 1, [139.0202, 35.0003]);
  removeWaypoint(doc, site.key, 0);
  assert.deepEqual(built().connectionAlignment, [[139.0199, 35], [139.0202, 35.0003], [139.0203, 35.0001], START_N]);
  assert.equal(built().handoverSiteId, id);
  assert.throws(() => moveWaypoint(doc, site.key, 5, [0, 0]), /Unknown waypoint/);
  assert.throws(() => addWaypoint(doc, site.key, [0, 0], 9), /Bad waypoint/);
  setStructureType(doc, site.key, "viaduct");
  setMaximumGradient(doc, site.key, 25);
  assert.equal(built().structureType, "viaduct");
  assert.equal(built().maximumGradientPermille, 25);
  const t = addTurnout(doc, site.key, [139.0199, 35]);
  addTurnout(doc, site.key, [139.0203, 35], { selected: false });
  assert.equal(t.key, "turnout-1");
  assert.equal(built().selectedTurnoutPoints.length, 1);
  setTurnoutSelected(doc, site.key, "turnout-2", true);
  moveTurnout(doc, site.key, "turnout-1", [139.01995, 35]);
  assert.equal(built().selectedTurnoutPoints.length, 2);
  removeTurnout(doc, site.key, "turnout-1");
  assert.throws(() => removeTurnout(doc, site.key, "turnout-1"), /Unknown turnout/);
  const w = addWorkArea(doc, site.key, rect(139.0200, 34.9998, 139.0205, 35.0002));
  assert.equal(w.key, "work-1");
  redrawWorkArea(doc, site.key, "work-1", rect(139.0200, 34.9998, 139.0206, 35.0003));
  assert.equal(built().workAreaCandidates.length, 1);
  assert.equal(built().selectedWorkAreaCandidateId, null);
  selectWorkArea(doc, site.key, "work-1");
  assert.equal(built().selectedWorkAreaCandidateId, built().workAreaCandidates[0].workAreaId);
  assert.throws(() => selectWorkArea(doc, site.key, "work-9"), /Unknown work area/);
  removeWorkArea(doc, site.key, "work-1");
  assert.equal(site.selectedWorkAreaKey, null, "removing the chosen area clears the choice");
  assert.equal(built().workAreaCandidates.length, 0);
  clearConnectionPoint(doc, site.key, "to");
  assert.equal(built().toConnectionPoint.location, null);
  assert.equal(built().handoverSiteId, id);
  // retarget the site to another handover: the drawing is cleared, key, name and id stay
  const route3 = makeRoute({ key: "r-3", legs: [leg("a"), leg("n"), leg("b")] });
  selectHandover(doc, site.key, route3, route3.handovers[1].handoverId);
  assert.deepEqual([site.fromConnectionPoint, site.toConnectionPoint, site.via, site.turnoutCandidates, site.workAreas], [null, null, [], [], []]);
  assert.equal(site.throughRouteId, route3.throughRouteId);
  assert.equal(site.name, "n");
  assert.equal(buildThroughHandoverSite(toDrawnSite(site), ctxOf(route3)).site.handoverSiteId, id);
  assert.throws(() => addSite(doc, route3, "through-handover:nope"), /Unknown handover/);
  assert.throws(() => addSite(doc, { schema: "x" }, "h"), /Not a ThroughRouteGeometry/);
  assert.equal(addSite(doc, rAB, rAB.handovers[0].handoverId).key, "handover-2");
  removeSite(doc, "handover-1");
  assert.equal(addSite(doc, rAB, rAB.handovers[0].handoverId).key, "handover-1", "the smallest unused key is reused");
  assert.throws(() => removeSite(doc, "nope"), /Unknown handover site/);
});

test("editor: a route that changed leaves the site stale until the player re-confirms it", () => {
  const doc = newThroughHandoverDoc("t", "1");
  const site = addSite(doc, rAN, rAN.handovers[0].handoverId);
  setConnectionPoint(doc, site.key, "from", END_A);
  setConnectionPoint(doc, site.key, "to", START_N);
  const changed = { ...rAN, geometryRevision: "through-route-revision:changed" };
  const out = buildThroughHandoverSite(toDrawnSite(site), ctxOf(changed));
  assert.equal(out.site.physicalConnectionEvidence.reason, "route-revision-stale");
  assert.equal(out.warnings[0].code, "route-revision-stale");
  setConnectionPoint(doc, site.key, "from", END_A, { route: changed });
  assert.equal(buildThroughHandoverSite(toDrawnSite(site), ctxOf(changed)).site.physicalConnectionEvidence.reason, "route-revision-stale", "editing does not confirm the design");
  rebindRoute(doc, site.key, changed);
  const confirmed = buildThroughHandoverSite(toDrawnSite(site), ctxOf(changed));
  assert.deepEqual(confirmed.warnings, []);
  assert.equal(confirmed.site.physicalConnectionEvidence.connected, true, "re-confirmed: the measured facts decide again");
  assert.throws(() => rebindRoute(doc, site.key, makeRoute({ key: "r-an", legs: [leg("a"), leg("b")] })), /Unknown handover|joins other legs/);
});

test("saving and restoring keeps every site and id; another pack's save is refused", () => {
  const doc = newThroughHandoverDoc("t", "1");
  const site = addSite(doc, rAN, rAN.handovers[0].handoverId, { name: "n" });
  setConnectionPoint(doc, site.key, "from", END_A);
  addWaypoint(doc, site.key, [139.0202, 35.0001]);
  addTurnout(doc, site.key, END_A);
  addWorkArea(doc, site.key, rect(139.0200, 34.9998, 139.0205, 35.0002));
  const text = serializeThroughHandoverDoc(doc);
  const restored = restoreThroughHandoverDoc(text, pack);
  assert.deepEqual(restored.warnings, []);
  assert.equal(serializeThroughHandoverDoc(restored.doc), text);
  const siteOf = (s) => JSON.stringify(buildThroughHandoverSite(toDrawnSite(s), ctxOf(rAN)).site);
  assert.equal(siteOf(restored.doc.sites[0]), siteOf(site));
  const refused = restoreThroughHandoverDoc(text, { manifest: { id: "other", version: "1" } });
  assert.deepEqual(refused.warnings, [{ code: "through-handover-doc-other-pack", savedPackId: "t" }]);
  assert.equal(refused.doc.sites.length, 0);
  assert.equal(refused.doc.packId, "other");
  assert.equal(restoreThroughHandoverDoc(text, { manifest: { id: "t", version: "2" } }).warnings[0].code, "pack-version-mismatch");
  assert.equal(restoreThroughHandoverDoc("{nope", pack).warnings[0].code, "through-handover-doc-unreadable");
  assert.equal(restoreThroughHandoverDoc(JSON.stringify({ version: 9, sites: [] }), pack).warnings[0].code, "through-handover-doc-version");
  assert.deepEqual(restoreThroughHandoverDoc(null, pack).doc.sites, []);
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

test("view: the three states look different, unknown counts differ from a found count and from zero", () => {
  const spatial = layersOf({ buildings: [rect(139.0201, 34.9999, 139.0203, 35.0001)], water: [FAR] });
  const make = (route, drawn) => build(route, drawn, { spatial });
  const sites = [make(rAN, bridge()), make(rAN, bridge({ key: "gap", connectionAlignment: [END_A, [139.0198, 35.0003]] })), make(rAN, bridge({ key: "near", connectionAlignment: [END_A, [139.0202, 35]] })), make(rAE, base(rAE, { key: "ext", fromConnectionPoint: END_A }))];
  const model = buildThroughHandoverView({ routes: [rAN, rAE], exportData: { sites, warnings: [] }, selectedId: sites[0].handoverSiteId });
  assert.equal(model.schema, "transitline.through-handover-site-map-view/1");
  assert.deepEqual(model.sites.map((s) => s.joint.state), ["joined", "separated", "unknown", "unknown"]);
  assert.equal(new Set(Object.values(CONNECTION_STYLES).map((s) => s.color)).size, 4);
  assert.equal(new Set(Object.values(CONNECTION_STYLES).map((s) => s.glyph)).size, 4);
  assert.ok(CONNECTION_STYLES.unknown.dash.length > 0 && CONNECTION_STYLES.separated.dash.length === 0, "unknown is dashed, a measured separation is solid");
  assert.equal(model.sites[0].selected, true);
  const [building, water, road] = model.sites[0].conflicts;
  assert.deepEqual([building.state, building.count, water.state, water.count, road.state, road.count], ["found", 1, "none", 0, "unknown", null]);
  assert.equal(model.sites[0].legs.length, 2);
  assert.equal(model.sites[3].legs[1].alignment, null);
  assert.equal(model.sites[3].legs[1].alignmentKnown, false);
  const stale = buildThroughHandoverView({ routes: [rAN], exportData: { sites: [buildThroughHandoverSite(bridge({ routeGeometryRevision: "x" }), ctxOf(rAN)).site], warnings: [] } });
  assert.equal(stale.sites[0].joint.state, "stale");
  assert.equal(buildThroughHandoverView({ routes: [], exportData: { sites: [sites[0]], warnings: [] } }).warnings[0].code, "through-route-not-supplied");
});

test("view: draws the legs, the connection, points, turnouts, work area and conflict markers; no money text", () => {
  const site = build(rAN, bridge({ turnoutCandidates: [{ key: "t", location: END_A }], workAreas: [{ key: "w", polygon: rect(139.0199, 34.9998, 139.0205, 35.0002) }] }), { spatial: layersOf({ buildings: [rect(139.0201, 34.9999, 139.0203, 35.0001)], water: [FAR] }) });
  const model = { ...buildThroughHandoverView({ routes: [rAN], exportData: { sites: [site], warnings: [] }, selectedId: site.handoverSiteId }), draft: { kind: "connection", points: [END_A, START_N] } };
  const { ctx, calls } = fakeCtx();
  drawThroughHandoverOverlay(ctx, model, ([lon, lat]) => [(lon - 139) * 1000, (35 - lat) * 1000]);
  assert.equal(calls[0][0], "save");
  assert.equal(calls.at(-1)[0], "restore");
  const texts = calls.filter((c) => c[0] === "fillText" || c[0] === "strokeText").map((c) => String(c[1]));
  assert.ok(texts.includes("✓"), "joined glyph");
  assert.ok(texts.some((t) => t.includes("접속 확인")));
  assert.ok(texts.includes("1"), "building count badge");
  assert.ok(texts.includes("?"), "the road and rail layers are missing: hollow ? markers");
  assert.equal(texts.some((t) => /원|비용|공기|승인/.test(t)), false);
  assert.ok(calls.some((c) => c[0] === "set" && c[1] === "strokeStyle" && c[2] === CONNECTION_STYLES.joined.color));
  assert.ok(calls.some((c) => c[0] === "setLineDash" && c[1].length === 0));
});

test("view: the panel and legend use textContent only and never show cost or approval", () => {
  const hostile = "<img src=x onerror=alert(1)>";
  const site = build(rAN, bridge({ name: hostile }));
  const model = buildThroughHandoverView({ routes: [rAN], exportData: { sites: [site], warnings: [{ code: "through-handover-site-rejected" }] } });
  const panel = fakeDom();
  renderThroughHandoverPanel(panel, model);
  const all = textsOf(panel);
  assert.ok(all.includes(hostile), "the player's text is shown as text");
  assert.ok(all.some((t) => t.includes("접속 확인")));
  assert.ok(all.some((t) => t.startsWith("건물 관통: 미상")));
  assert.ok(all.some((t) => t.includes("through-handover-site-rejected")));
  assert.equal(all.some((t) => /원|비용|공기|승인|가능|불가/.test(t)), false);
  const empty = fakeDom();
  renderThroughHandoverPanel(empty, buildThroughHandoverView({ exportData: { sites: [], warnings: [] } }));
  assert.equal(empty.hidden, true);
  const legend = fakeDom();
  renderThroughHandoverLegend(legend);
  assert.ok(textsOf(legend).length >= 8);
});

// --- shipped examples: regenerated byte for byte by the script, and checked against the contract ---
const examplePacks = ["tokyo", "example-radial", "example-corridor"];
const exampleDir = (id) => path.join(root, "packs", id, "through-handover-examples");
const readExamples = (id) => fs.readdirSync(exampleDir(id)).filter((f) => f.endsWith(".handover-site.json")).sort().map((f) => ({ file: f, site: JSON.parse(fs.readFileSync(path.join(exampleDir(id), f), "utf8")) }));

test("every shipped example satisfies the contract and every unknown has a reason", () => {
  for (const id of examplePacks) {
    const examples = readExamples(id);
    assert.ok(examples.length >= 1, id);
    for (const { file, site } of examples) {
      assert.equal(site.schema, THROUGH_HANDOVER_SITE_SCHEMA, `${id}/${file}`);
      assert.equal(site.sourcePackId, id);
      assert.equal(site.source.generatedBy, "scripts/build-through-handover-examples.mjs");
      assert.deepEqual([...keysDeep(site)].filter((k) => FORBIDDEN.test(k)), [], file);
      for (const f of site.unknown) assert.equal(typeof site.unknownReasons[f], "string", `${file}:${f}`);
      assert.ok([true, false, null].includes(site.physicalConnectionEvidence.connected));
      assert.equal(site.physicalConnectionEvidence.connected === null, site.unknown.includes("physicalConnectionEvidence"), file);
      const route = JSON.parse(fs.readFileSync(path.join(root, "packs", id, "through-route-examples", `${site.source.routeExample}.through-route.json`), "utf8"));
      assert.equal(site.throughRouteId, route.throughRouteId, file);
      assert.ok(route.handovers.some((h) => h.handoverId === site.handoverId && h.fromLegId === site.fromLegId && h.toLegId === site.toLegId), file);
    }
  }
});

test("the example set covers every required case, with true, false and null all present", () => {
  const all = examplePacks.flatMap((id) => readExamples(id).map((e) => e.site));
  const cases = new Set(all.flatMap((s) => s.source.case));
  for (const c of ["external-connection-unknown", "player-legs-joined", "near-not-joined", "through-buildings", "water-crossing", "road-crossing", "external-alignment-unknown", "some-layers-missing", "route-revision-stale"]) assert.ok(cases.has(c), c);
  const state = (s) => s.physicalConnectionEvidence.connected;
  assert.ok(all.some((s) => state(s) === true) && all.some((s) => state(s) === false) && all.some((s) => state(s) === null));
});

test("re-running the generator rewrites every example byte for byte", () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "handover-examples-"));
  const run = spawnSync(process.execPath, [path.join(root, "scripts", "build-through-handover-examples.mjs"), "--out", out], { cwd: root, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  for (const id of examplePacks) {
    const files = fs.readdirSync(exampleDir(id)).filter((f) => f.endsWith(".handover-site.json")).sort();
    assert.deepEqual(fs.readdirSync(path.join(out, id)).sort(), files, id);
    for (const f of files) assert.equal(fs.readFileSync(path.join(out, id, f), "utf8"), fs.readFileSync(path.join(exampleDir(id), f), "utf8"), `${id}/${f}`);
  }
  fs.rmSync(out, { recursive: true, force: true });
});
