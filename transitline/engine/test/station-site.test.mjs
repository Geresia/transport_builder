import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildMapExport } from "../src/map/plan-geometry.mjs";
import { haversineMetres } from "../src/projection.mjs";
import { makeSpatialContext, polygonLayer, roadLayerFromGeojson } from "../src/map/spatial.mjs";
import { buildStationExport, buildStationSite, keyedStationSiteId, STATION_EXPORT_SCHEMA, STATION_SITE_SCHEMA } from "../src/map/station-site.mjs";
import {
  activeSites, addEntrance, addSite, moveEntrance, moveSite, newStationDoc, nextStationKey, removeEntrance, removeSite, removeTransfer, resizeSite,
  restoreSite, restoreStationDoc, rotateSite, serializeStationDoc, setTransfer, suggestEntrancePoints, updateSite,
} from "../src/map/station-editor.mjs";
import { buildStationView, drawStationOverlay, engineStatusFor, LAYERS } from "../src/map/station-view.mjs";
import { buildOverlayModel } from "../src/map/overlay.mjs";
import { syntheticLayers } from "../../scripts/lib/synthetic-layers.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const readJson = (p) => JSON.parse(fs.readFileSync(path.join(root, p), "utf8"));

// --- fixtures: a mainline along lat 35 (bearing 90), three stations 0.01 degrees (~910 m) apart ---
const pack = {
  manifest: { id: "t", version: "1", data: { license: "CC0-1.0", attribution: [] } },
  demand: { points: [{ id: "d0", name: "d0", location: [139, 35] }, { id: "d1", name: "d1", location: [139.01, 35] }, { id: "d2", name: "d2", location: [139.02, 35] }, { id: "far", name: "far", location: [139.5, 35.5] }] },
  existingNetwork: { lines: [{ name: "E1", osmRelationId: 42, stationIds: ["d0", "d1"] }] },
};
const line = {
  key: "main", name: "Main",
  legs: [{ structureHint: "cut-cover" }, { structureHint: "elevated" }],
  vertices: [
    { location: [139, 35], structure: "surface", platformType: "side", platformLengthM: 100 },
    { location: [139.01, 35], structure: "cut-cover", depthMeters: 12, platformType: "island", platformLengthM: 100 },
    { location: [139.02, 35], structure: "elevated", platformType: "side", platformLengthM: 100 },
  ],
};
const scratch = buildMapExport({ pack, mode: "scratch", drawnLines: [line] });
const existing = buildMapExport({ pack, mode: "existing", drawnLines: [line] });
const plan = scratch.plans[0];
const [s0, s1, s2] = plan.stationCandidates;
const site = (extra = {}) => ({ key: "st1", name: "Middle", connect: { planId: plan.planId, stationId: s1.id }, ...extra });
const ctxWith = (layers = {}, map = scratch) => ({ pack, spatial: makeSpatialContext(layers), plans: map.plans, externalNetworks: map.externalNetworks, demandNodes: map.demandNodes });
const build = (drawn, layers = {}, map = scratch) => buildStationSite(drawn, ctxWith(layers, map));
const near = (actual, expected, tolerance, label = "") => assert.ok(Math.abs(actual - expected) <= tolerance, `${label} expected ${expected} +/- ${tolerance}, got ${actual}`);
const sq = (lon, lat, d = 0.0002) => [[lon, lat], [lon + d, lat], [lon + d, lat + d], [lon, lat + d], [lon, lat]];
const source = (name) => ({ name, license: "CC0-1.0" });
const dem = { elevationAt: () => 10, slopeAt: () => 2, quality: "medium", source: source("test dem") };
const M_PER_LON = 111320 * Math.cos((35 * Math.PI) / 180);

// --- identity ---
test("same input gives the same stationSiteId and byte-identical output", () => {
  const layers = { dem };
  assert.equal(JSON.stringify(build(site(), layers)), JSON.stringify(build(structuredClone(site()), layers)));
  assert.equal(build(site()).schema, STATION_SITE_SCHEMA);
});

test("the id does not depend on the name; a keyed id follows the key, a keyless one the location", () => {
  assert.equal(build(site({ name: "A" })).stationSiteId, build(site({ name: "B" })).stationSiteId);
  assert.equal(build(site()).stationSiteId, keyedStationSiteId("t", "st1"));
  const keyless = (extra) => build({ connect: site().connect, ...extra }).stationSiteId;
  assert.equal(keyless({ name: "x" }), keyless({ name: "y" }));
  assert.notEqual(keyless({ location: [139.0102, 35] }), keyless({}));
  assert.notEqual(build(site({ key: "other" })).stationSiteId, build(site()).stationSiteId);
});

test("the order entrances and work areas were drawn in does not change the output", () => {
  const entrances = [{ location: [139.0102, 35.0003] }, { location: [139.0098, 34.9997] }, { key: "k", location: [139.011, 35] }];
  const work = [{ key: "w1", polygon: sq(139.012, 35.001) }, { polygon: sq(139.008, 34.998) }];
  const a = build(site({ entrances, workAreas: work }), { dem });
  const b = build(site({ entrances: [...entrances].reverse(), workAreas: [...work].reverse() }), { dem });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.equal(new Set(a.entranceCandidates.map((e) => e.entranceId)).size, 3);
});

test("a keyed site keeps its id through move, rotate, resize, delete and restore; deleted keys are never reused", () => {
  const doc = newStationDoc("t", "1");
  const a = addSite(doc, { name: "A", location: s1.location, connect: site().connect });
  const id = () => buildStationExport({ pack, mapExport: scratch, stations: activeSites(doc) }).sites[0]?.stationSiteId;
  const before = id();
  moveSite(doc, a.key, 0.001, 0.0005);
  assert.equal(id(), before);
  rotateSite(doc, a.key, 30, 90);
  assert.equal(id(), before);
  resizeSite(doc, a.key, { lengthMeters: 200, widthMeters: 30 });
  assert.equal(id(), before);
  removeSite(doc, a.key);
  assert.equal(id(), undefined, "a deleted site is not exported");
  assert.equal(nextStationKey(doc), "station-2", "the deleted key stays reserved");
  restoreSite(doc, a.key);
  assert.equal(id(), before);
});

// --- save and reopen ---
test("save then reopen gives the same ids and byte-identical facts", () => {
  const doc = newStationDoc("t", "1");
  const a = addSite(doc, { name: "A", location: s1.location, connect: site().connect, headingDegrees: 45 });
  addEntrance(doc, a.key, [139.0104, 35.0002]);
  addEntrance(doc, a.key, [139.0096, 34.9998]);
  setTransfer(doc, a.key, s2.id, [[139.015, 35.0004]]);
  const b = addSite(doc, { name: "B", location: [139.005, 35.0004] });
  removeSite(doc, b.key);
  const layers = { dem };
  const first = JSON.stringify(buildStationExport({ pack, mapExport: scratch, stations: activeSites(doc), spatial: makeSpatialContext(layers) }));
  const restored = restoreStationDoc(serializeStationDoc(doc), pack);
  assert.deepEqual(restored.warnings, []);
  assert.equal(JSON.stringify(buildStationExport({ pack, mapExport: scratch, stations: activeSites(restored.doc), spatial: makeSpatialContext(layers) })), first);
  assert.equal(restored.doc.sites.length, 2, "the deleted site is kept as a tombstone");
  assert.equal(restored.doc.sites[1].deleted, true);
});

test("a saved document is not applied to another pack, and a pack version change is reported", () => {
  const doc = newStationDoc("t", "1");
  addSite(doc, { location: s1.location });
  const text = serializeStationDoc(doc);
  const other = restoreStationDoc(text, { manifest: { id: "elsewhere", version: "1" } });
  assert.equal(other.doc.sites.length, 0);
  assert.equal(other.warnings[0].code, "station-doc-other-pack");
  assert.equal(restoreStationDoc(text, { manifest: { id: "t", version: "2" } }).warnings[0].code, "pack-version-mismatch");
  assert.equal(restoreStationDoc("{not json", pack).warnings[0].code, "station-doc-unreadable");
  assert.equal(restoreStationDoc(null, pack).doc.sites.length, 0);
});

// --- contract ---
test("a site carries every documented field, its pack license and its data sources", () => {
  const s = build(site(), { dem });
  for (const k of [
    "schema", "contractVersion", "stationSiteId", "sourcePackId", "sourcePackVersion", "name", "coordinateReference", "location",
    "connectedPlanId", "connectedStationId", "connectedSegmentIds", "planStationIndex", "planTerminalEnd", "planHints", "trackHeadingDegrees",
    "bodyHeadingDegrees", "bodyPolygon", "bodyLengthMeters", "bodyWidthMeters", "bodyAreaSquareMeters", "groundElevationMeters", "elevationRangeMeters",
    "averageSlopePercent", "maximumSlopePercent", "plannedDepthMeters", "plannedTrackElevationMeters", "intersectedBuildingCount", "waterOverlapCount",
    "roadsThroughBody", "nearestRoad", "roadWidthMeters", "nearestExistingStation", "transferCandidates", "entranceCandidates", "demandAccess",
    "workAreaCandidates", "extensionSpace", "spatialFlags", "dataQuality", "unknown", "unknownReasons", "constraintUnknown", "warnings", "sourceLayers", "license",
  ]) assert.ok(k in s, `missing ${k}`);
  assert.equal(s.contractVersion, 1);
  assert.equal(s.connectedPlanId, plan.planId);
  assert.equal(s.connectedStationId, s1.id);
  assert.deepEqual(s.connectedSegmentIds, plan.segments.map((x) => x.id).sort());
  assert.equal(s.license.pack, "CC0-1.0");
  assert.equal(s.sourceLayers[0].name, "test dem");
  assert.notEqual(s.dataQuality, "high", "ground data does not exist, so quality is capped");
  assert.ok(s.constraintUnknown.includes("groundwater") && s.constraintUnknown.includes("utilities"));
});

const forbidden = /cost|price|score|capacity|compensation|duration|opposition|negotiat|schedule|budget|fare|cash|ledger|profit|revenue/i;
const forbiddenExact = new Set(["stationType", "platformLayout", "constructionMethod", "method", "structureType"]);
function keysOf(value, out = new Set()) {
  if (Array.isArray(value)) value.forEach((v) => keysOf(v, out));
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) { out.add(k); keysOf(v, out); }
  return out;
}
test("the contract has no cost, score, capacity, method or station-type fields: those belong to the management engine", () => {
  const s = build(site({ entrances: [{ location: [139.0102, 35.0003] }] }), { dem });
  for (const k of keysOf(s)) {
    assert.doesNotMatch(k, forbidden, `field ${k}`);
    assert.ok(!forbiddenExact.has(k), `field ${k}`);
  }
});

// --- missing data: null + unknown[] + a reason, never 0 ---
test("with no spatial layers everything spatial is null with a reason, and nothing is filled with 0", () => {
  const s = build(site({ entrances: [{ location: [139.0102, 35.0003] }] }));
  for (const f of ["intersectedBuildingCount", "waterOverlapCount", "roadsThroughBody", "nearestRoad", "averageSlopePercent", "maximumSlopePercent", "groundElevationMeters", "elevationRangeMeters", "plannedTrackElevationMeters"]) {
    assert.equal(s[f], null, f);
    assert.ok(s.unknown.includes(f), `${f} listed as unknown`);
  }
  assert.equal(s.unknownReasons.intersectedBuildingCount, "no-layer");
  assert.equal(s.unknownReasons.groundElevationMeters, "no-layer");
  assert.equal(s.unknownReasons.roadWidthMeters, "no-layer");
  const [e] = s.entranceCandidates;
  assert.equal(e.collidingBuildingCount, null);
  assert.equal(e.roadside, null);
  assert.equal(e.publicLand, null);
  assert.equal(e.unknownReasons.publicLand, "no-parcel-data");
  for (const w of s.workAreaCandidates) { assert.equal(w.intersectedBuildingCount, null); assert.ok(w.unknown.includes("intersectedBuildingCount")); }
  for (const x of s.extensionSpace) { assert.equal(x.freeLengthMeters, null); assert.equal(x.unknownReasons.freeLengthMeters, "no-layer"); }
  assert.ok(s.bodyAreaSquareMeters > 0, "the body itself is geometry, so it is still there");
});

test("a layer that does not cover the site is 'outside-coverage', not 0; a covering layer that finds nothing is a real 0", () => {
  const empty = polygonLayer([], { quality: "high", source: source("empty buildings") });
  const covering = build(site(), { buildings: empty });
  assert.equal(covering.intersectedBuildingCount, 0);
  assert.ok(!covering.unknown.includes("intersectedBuildingCount"));
  const elsewhere = build(site(), { buildings: { ...empty, covers: () => false } });
  assert.equal(elsewhere.intersectedBuildingCount, null);
  assert.equal(elsewhere.unknownReasons.intersectedBuildingCount, "outside-coverage");
  assert.equal(elsewhere.extensionSpace[0].freeLengthMeters, null, "a missing layer could hide a blocker: no answer beats a wrong one");
  const noSlopeGrid = build(site(), { dem: { elevationAt: () => 10, quality: "low", source: source("elevation only") } });
  assert.equal(noSlopeGrid.averageSlopePercent, null);
  assert.equal(noSlopeGrid.groundElevationMeters, 10);
});

test("a site tied to no plan has no track heading: no body is invented, unless the player gives a heading", () => {
  const free = build({ key: "free", location: [139.5, 35.5] });
  assert.equal(free.bodyPolygon, null);
  assert.equal(free.bodyAreaSquareMeters, null);
  assert.equal(free.trackHeadingDegrees, null);
  assert.equal(free.unknownReasons.bodyPolygon, "no-heading");
  assert.equal(free.unknownReasons.trackHeadingDegrees, "no-connection");
  assert.deepEqual(free.workAreaCandidates, []);
  assert.equal(free.connectedPlanId, null);
  const headed = build({ key: "free", location: [139.5, 35.5], headingDegrees: 45 });
  assert.equal(headed.bodyPolygon.length, 4);
  assert.equal(headed.bodyHeadingBasis, "player");
});

// --- geometry ---
test("the body follows the track: heading = alignment bearing, length from the plan's platform length, canonical ring", () => {
  const s = build(site());
  near(s.trackHeadingDegrees, 90, 0.2, "east-west line");
  assert.equal(s.bodyHeadingBasis, "alignment");
  assert.equal(s.bodyLengthMeters, 100);
  assert.equal(s.bodyDimensionBasis.length, "plan-platform-length");
  assert.equal(s.bodyDimensionBasis.width, "default");
  near(s.bodyAreaSquareMeters, 100 * 24, 20);
  const lons = s.bodyPolygon.map((p) => p[0]);
  near((Math.max(...lons) - Math.min(...lons)) * M_PER_LON, 100, 1, "length along the track");
  const lats = s.bodyPolygon.map((p) => p[1]);
  near((Math.max(...lats) - Math.min(...lats)) * 111320, 24, 1, "width across it");
  assert.equal(JSON.stringify(build(site({ headingDegrees: 270 })).bodyPolygon), JSON.stringify(build(site({ headingDegrees: 90 })).bodyPolygon), "a body reversed end for end is the same ring");
  const rotated = build(site({ headingDegrees: 0 }));
  near((Math.max(...rotated.bodyPolygon.map((p) => p[1])) - Math.min(...rotated.bodyPolygon.map((p) => p[1]))) * 111320, 100, 1, "north-south body");
});

test("terrain and the planned track height: ground minus depth, and no invented height for a viaduct", () => {
  const cut = build(site(), { dem });
  assert.equal(cut.groundElevationMeters, 10);
  assert.equal(cut.plannedDepthMeters, 12);
  assert.equal(cut.plannedTrackElevationMeters, -2);
  near(cut.averageSlopePercent, Math.tan((2 * Math.PI) / 180) * 100, 0.01);
  assert.ok(cut.spatialFlags.includes("steep-site"));
  const elevated = build(site({ connect: { planId: plan.planId, stationId: s2.id }, key: "st2" }), { dem });
  assert.equal(elevated.plannedTrackElevationMeters, null);
  assert.equal(elevated.unknownReasons.plannedTrackElevationMeters, "no-structure-height");
  const surface = build(site({ connect: { planId: plan.planId, stationId: s0.id }, key: "st0" }), { dem });
  assert.equal(surface.plannedTrackElevationMeters, 10, "a surface station has depth 0");
  assert.equal(surface.planTerminalEnd, "start");
  assert.equal(elevated.planTerminalEnd, "end");
});

test("buildings, water and roads overlapping the body are counted; a building beside it is not", () => {
  const buildings = polygonLayer([{ rings: [sq(139.0099, 34.9999)], kind: "yes" }, { rings: [sq(139.0099, 35.001)], kind: "yes" }], { quality: "high", source: source("b") });
  const water = polygonLayer([{ rings: [sq(139.0095, 34.9995, 0.001)] }], { quality: "medium", source: source("w") });
  const roads = roadLayerFromGeojson({ features: [{ geometry: { coordinates: [[139, 35.00005], [139.02, 35.00005]] }, properties: { roadClass: "major" } }] }, { quality: "high", source: source("r") });
  const s = build(site(), { buildings, water, roads });
  assert.equal(s.intersectedBuildingCount, 1);
  assert.equal(s.waterOverlapCount, 1);
  assert.deepEqual(s.roadsThroughBody, { highway: 0, major: 1, minor: 0 });
  assert.equal(s.nearestRoad.distanceMeters, 0);
  assert.ok(["body-building-overlap", "body-water-overlap"].every((f) => s.spatialFlags.includes(f)));
  assert.equal(s.unknownReasons.roadWidthMeters, "no-attribute", "the road layer has a class, not a width");
  assert.equal(s.roadWidthMeters, null);
});

test("free space beyond a body end stops at the first building, measured in 10 m steps", () => {
  const blocker = polygonLayer([{ rings: [sq(139.0116, 34.9999)], kind: "yes" }], { quality: "high", source: source("b") });
  const s = build(site(), { buildings: blocker, water: polygonLayer([], { quality: "medium", source: source("w") }) });
  const forward = s.extensionSpace.find((x) => x.end === "forward");
  const backward = s.extensionSpace.find((x) => x.end === "backward");
  // the building's west edge is ~146 m east of the centre, the body ends 50 m east: ~96 m free, reported as 90
  near(forward.freeLengthMeters, 90, 10);
  assert.equal(forward.blockedBy, "building");
  assert.equal(backward.freeLengthMeters, 400);
  assert.equal(backward.blockedBy, null);
});

// --- entrances ---
test("entrance candidates: building collision, road edge, open space, and every unknown kept apart", () => {
  const buildings = polygonLayer([{ rings: [sq(139.0112, 34.9999)], kind: "yes" }], { quality: "high", source: source("b") });
  const roads = roadLayerFromGeojson({ features: [{ geometry: { coordinates: [[139, 35.0004], [139.02, 35.0004]] }, properties: { roadClass: "minor" } }] }, { quality: "high", source: source("r") });
  const landuse = polygonLayer([{ rings: [sq(139.0085, 34.9995, 0.0006)], kind: "park" }, { rings: [sq(139.0085, 35.001, 0.0004)], kind: "garden" }], { quality: "high", source: source("l") });
  const s = build(site({ entrances: [
    { key: "on-building", location: [139.0113, 35] },
    { key: "on-road", location: [139.0104, 35.0004] },
    { key: "in-park", location: [139.0088, 34.9998] },
    { key: "in-garden", location: [139.0087, 35.0012] },
  ] }), { buildings, roads, landuse });
  const idOf = (k) => build(site({ entrances: [{ key: k, location: [0, 0] }] })).entranceCandidates[0].entranceId; // a keyed entrance's id follows its key, not its place
  const by = (k) => s.entranceCandidates.find((e) => e.entranceId === idOf(k));
  const blocked = by("on-building");
  assert.equal(blocked.collidingBuildingCount, 1);
  assert.ok(blocked.spatialFlags.includes("building-collision"));
  const road = by("on-road");
  assert.equal(road.roadside, true);
  assert.equal(road.publicLand, true);
  assert.equal(road.publicLandEvidence, "road-edge");
  const park = by("in-park");
  assert.deepEqual(park.landUses, ["park"]);
  assert.equal(park.publicLandEvidence, "osm-open-space");
  const garden = by("in-garden");
  assert.deepEqual(garden.landUses, ["garden"]);
  assert.equal(garden.publicLand, null, "no evidence of public land is not evidence of private land");
  assert.equal(garden.unknownReasons.publicLand, "no-parcel-data");
  assert.ok(s.entranceCandidates.every((e) => e.distanceToBodyMeters >= 0));
});

test("no entrance candidates, or all of them on buildings, are spatial flags", () => {
  assert.ok(build(site()).spatialFlags.includes("no-entrance-candidate"));
  const layers = { buildings: polygonLayer([{ rings: [sq(139.0102, 34.9999)], kind: "yes" }, { rings: [sq(139.0092, 34.9999)], kind: "yes" }], { quality: "high", source: source("b") }) };
  const s = build(site({ entrances: [{ location: [139.0103, 35] }, { location: [139.0093, 35] }] }), layers);
  assert.ok(s.spatialFlags.includes("all-entrances-blocked"));
  assert.ok(!s.spatialFlags.includes("no-entrance-candidate"));
  const mixed = build(site({ entrances: [{ location: [139.0103, 35] }, { location: [139.0125, 35.002] }] }), layers);
  assert.ok(!mixed.spatialFlags.includes("all-entrances-blocked"));
});

// --- transfers, demand access, work areas ---
test("transfer candidates: nearby existing stations, the passage the player drew, and no self-transfer", () => {
  const withNone = build(site());
  assert.deepEqual(withNone.transferCandidates, []);
  assert.equal(withNone.nearestExistingStation, null, "a blank-map start has no existing network: a fact, not an unknown");
  assert.ok(!withNone.unknown.includes("nearestExistingStation"));

  const s = build(site({ location: [139.0016, 35.0004], key: "off" }), {}, existing);
  assert.deepEqual(s.transferCandidates.map((t) => t.targetStationId), ["d0"], "d0 is ~150 m away; d1 is ~0.8 km away");
  assert.equal(s.transferCandidates[0].basis, "nearby");
  assert.equal(s.transferCandidates[0].targetKind, "external");
  assert.equal(s.transferCandidates[0].dataQuality, "low", "existing stations sit on demand nodes, not real platforms");
  assert.ok(s.warnings.some((w) => w.code === "external-station-locations-coarse"));
  assert.equal(s.nearestExistingStation.stationId, "d0");

  const drawn = build(site({ location: [139.0016, 35.0004], key: "off", transfers: [{ targetStationId: "d0", via: [[139.0008, 35.0006]] }] }), {}, existing);
  const [p] = drawn.transferCandidates;
  assert.equal(drawn.transferCandidates.length, 1, "one passage per target: the drawn one replaces the nearby one");
  assert.equal(p.basis, "player-passage");
  assert.equal(p.alignment.length, 3);
  assert.deepEqual(p.alignment[1], [139.0008, 35.0006]);
  assert.ok(p.passageLengthMeters >= p.straightDistanceMeters);
  assert.equal(p.walkingDistanceMeters, p.passageLengthMeters);
  assert.ok(!drawn.transferCandidates.some((t) => t.targetStationId === s1.id));

  assert.ok(build(site({ transfers: [{ targetStationId: "nowhere" }] })).warnings.some((w) => w.code === "transfer-target-missing"));
});

test("another plan's station is a transfer target only if it is a different station", () => {
  const other = buildMapExport({ pack, mode: "scratch", drawnLines: [line, { key: "stub", vertices: [{ location: [139.0031, 35.0008], platformType: "side" }, { location: [139.009, 35.004], platformType: "side" }] }] });
  const s = build(site(), {}, other);
  assert.ok(!s.transferCandidates.some((t) => t.targetStationId === s1.id), "the same station of another plan is the site's own");
  assert.ok(s.nearestPlannedStation.distanceMeters > 0);
  assert.ok(s.nearestPlannedStation.stationId !== s1.id);
});

test("demand points: within walking range measured from the nearest entrance; none in range is [] (a fact); a far node is ignored", () => {
  const s = build(site({ entrances: [{ location: [139.0103, 35] }] }));
  assert.equal(s.demandAccess.length, 1);
  assert.equal(s.demandAccess[0].demandNodeId, "d1");
  assert.equal(s.demandAccess[0].measuredFrom, "entrance");
  near(s.demandAccess[0].distanceMeters, 0.0003 * M_PER_LON, 1);
  assert.ok(s.demandAccess[0].walkMinutes >= 1, "a station is never zero minutes away");
  const none = build({ key: "empty", location: [139.3, 35.3], headingDegrees: 0 });
  assert.deepEqual(none.demandAccess, [], "a demand point with no station, and a site with no demand point, are both fine");
  assert.ok(!none.unknown.includes("demandAccess"));
  assert.ok(!s.demandAccess.some((d) => d.demandNodeId === "far"));
});

test("work-area candidates: four around the body, checked for buildings and road access; drawn ones are kept", () => {
  const roads = roadLayerFromGeojson({ features: [{ geometry: { coordinates: [[139, 35.01], [139.02, 35.01]] }, properties: { roadClass: "major" } }] }, { quality: "high", source: source("r") });
  const buildings = polygonLayer([{ rings: [sq(139.0107, 34.9999)], kind: "yes" }], { quality: "high", source: source("b") }); // 64-82 m east: inside the forward work area
  const s = build(site({ workAreas: [{ key: "yard", polygon: sq(139.008, 35.0006, 0.0004) }] }), { roads, buildings });
  assert.deepEqual(s.workAreaCandidates.map((w) => w.slot).sort(), ["end-backward", "end-forward", "player", "side-left", "side-right"]);
  const forward = s.workAreaCandidates.find((w) => w.slot === "end-forward");
  assert.equal(forward.intersectedBuildingCount, 1);
  assert.ok(forward.spatialFlags.includes("building-overlap"));
  assert.equal(s.workAreaCandidates.find((w) => w.slot === "end-backward").intersectedBuildingCount, 0);
  assert.ok(s.workAreaCandidates.find((w) => w.slot === "player").areaSquareMeters > 0);
  assert.ok(!s.spatialFlags.includes("no-clear-work-area"), "one blocked candidate is not all of them");
});

// --- connection to PlanGeometry ---
test("the connection is checked against the plan the map exported", () => {
  const missingPlan = build(site({ connect: { planId: "plan:nope", stationId: s1.id }, location: s1.location }));
  assert.equal(missingPlan.connectedPlanId, null);
  assert.ok(missingPlan.warnings.some((w) => w.code === "connection-plan-missing"));
  const unplaced = buildStationExport({ pack, mapExport: scratch, stations: [site({ connect: { planId: plan.planId, stationId: "stn:nope" } })] });
  assert.equal(unplaced.sites.length, 0, "no place of its own and no plan station to take one from");
  assert.equal(unplaced.warnings[0].code, "station-no-location");
  assert.equal(unplaced.warnings[0].connect.stationId, "stn:nope");
  const missingStation = build(site({ connect: { planId: plan.planId, stationId: "stn:nope" }, location: s1.location }));
  assert.equal(missingStation.connectedStationId, null);
  assert.ok(missingStation.warnings.some((w) => w.code === "connection-station-missing"));
  assert.equal(missingStation.unknownReasons.trackHeadingDegrees, "connection-unresolved");
  assert.equal(build(site()).offsetFromPlanStationMeters, 0);
  near(build(site({ location: [139.0111, 35] })).offsetFromPlanStationMeters, 0.0011 * M_PER_LON, 1);
});

test("an export never repeats a site, and reports a candidate with no place", () => {
  const out = buildStationExport({ pack, mapExport: scratch, stations: [site(), site({ name: "again" }), { key: "nowhere", name: "nowhere" }] });
  assert.equal(out.schema, STATION_EXPORT_SCHEMA);
  assert.equal(out.sites.length, 1);
  assert.deepEqual(out.warnings.map((w) => w.code).sort(), ["duplicate-station-site", "station-no-location"]);
});

// --- editor operations ---
test("rotate turns the body, entrances and passage points together about the centre", () => {
  const doc = newStationDoc("t", "1");
  const a = addSite(doc, { location: s1.location, connect: site().connect });
  const e = addEntrance(doc, a.key, [139.0104, 35]);
  const centre = [...a.location];
  const dist = () => haversineMetres(a.location, a.entrances.find((x) => x.key === e.key).location);
  const before = dist();
  rotateSite(doc, a.key, 90, 90);
  assert.deepEqual(a.location, centre, "the centre is the fixed point");
  near(dist(), before, 0.3, "a rigid rotation keeps the distance");
  assert.ok(a.entrances[0].location[1] < 35 - 0.0002, "east of the centre turned 90 degrees clockwise is south of it");
  assert.equal(a.headingDegrees, 180);
  rotateSite(doc, a.key, 200);
  assert.equal(a.headingDegrees, 20, "headings wrap into 0..360");
});

test("entrance edits: keys are handed out once, move keeps the key, delete removes only that entrance", () => {
  const doc = newStationDoc("t", "1");
  const a = addSite(doc, { location: s1.location });
  const e1 = addEntrance(doc, a.key, [139.0104, 35]);
  const e2 = addEntrance(doc, a.key, [139.0096, 35]);
  assert.deepEqual([e1.key, e2.key], ["entrance-1", "entrance-2"]);
  moveEntrance(doc, a.key, e1.key, [139.0105, 35.0001]);
  removeEntrance(doc, a.key, e1.key);
  assert.equal(addEntrance(doc, a.key, [139.011, 35]).key, "entrance-3", "a deleted entrance's key is not reused");
  assert.deepEqual(a.entrances.map((x) => x.key), ["entrance-2", "entrance-3"]);
  setTransfer(doc, a.key, "x", []);
  setTransfer(doc, a.key, "x", [[139.0105, 35]]);
  assert.equal(a.transfers.length, 1, "one passage per target");
  removeTransfer(doc, a.key, "x");
  assert.equal(a.transfers.length, 0);
  assert.throws(() => moveEntrance(doc, a.key, "entrance-99", [0, 0]), /Unknown entrance/);
  assert.throws(() => updateSite(doc, "station-99", {}), /Unknown station site/);
});

test("suggested entrances are four deterministic points just outside the body", () => {
  const s = build(site());
  const args = { location: s.location, headingDegrees: s.bodyHeadingDegrees, lengthMeters: s.bodyLengthMeters, widthMeters: s.bodyWidthMeters };
  const pts = suggestEntrancePoints(args);
  assert.equal(pts.length, 4);
  assert.deepEqual(pts, suggestEntrancePoints(args));
  const withThem = build(site({ entrances: pts.map((location) => ({ location })) }));
  assert.ok(withThem.entranceCandidates.every((e) => e.distanceToBodyMeters > 5 && e.distanceToBodyMeters < 15));
  assert.deepEqual(suggestEntrancePoints({ ...args, headingDegrees: null }), [], "no heading, no guess");
});

// --- display: layers, engine verdict, read-only ---
const overlayFor = (report) => buildOverlayModel(scratch, report);
test("the engine's word for a station is shown as reported: not possible / conditional / approved / under construction / complete", () => {
  const s = build(site());
  const id = s1.id;
  const verdict = (extra) => overlayFor({ plans: [], projects: [], assessments: { [plan.planId]: { buildable: true, violations: [], missingInputs: [], ...extra } } });
  assert.equal(engineStatusFor(s, null), null, "no report, no word");
  assert.equal(engineStatusFor(s, verdict({})), null);
  assert.equal(engineStatusFor(s, verdict({ buildable: false, violations: [`Station ${id} platform is too short`] })).label, "불가");
  assert.equal(engineStatusFor(s, verdict({ buildable: "conditional", missingInputs: [`stationCandidates.${id}.platformType`] })).label, "조건부");
  const withStatus = (project, record) => overlayFor({ plans: record ? [{ planId: plan.planId, status: record }] : [], projects: project ? [{ planId: plan.planId, status: project, progress: 0.4 }] : [], assessments: {} });
  assert.equal(engineStatusFor(s, withStatus(null, "approved")).label, "승인");
  assert.equal(engineStatusFor(s, withStatus("underConstruction")).label, "공사 중");
  assert.equal(engineStatusFor(s, withStatus("available")).label, "완공");
  assert.equal(engineStatusFor(s, withStatus("suspended")).label, "공사 중단");
  assert.equal(engineStatusFor(s, withStatus("cancelled")).label, "사업 취소");
  assert.notEqual(engineStatusFor(s, withStatus("suspended")).label, engineStatusFor(s, withStatus("cancelled")).label, "a pause and an end are not the same word");
  assert.equal(engineStatusFor({ ...s, connectedPlanId: null }, withStatus("available")), null, "a site tied to no plan gets no verdict");
});

function deepFreeze(o) { if (o && typeof o === "object" && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; }
const recorder = () => {
  const calls = [];
  const ctx = new Proxy({}, { get: (t, k) => (k in t ? t[k] : k === "measureText" ? () => ({ width: 40 }) : (...args) => calls.push([k, ...args])), set: (t, k, v) => { t[k] = v; calls.push(["set", k, v]); return true; } });
  return { calls, ctx };
};

test("the view is read-only over the export and the report, and each layer draws on its own", () => {
  const exportBefore = buildStationExport({ pack, mapExport: scratch, stations: [site({ entrances: [{ location: [139.0104, 35] }] })], spatial: makeSpatialContext({ dem }) });
  const snapshot = JSON.stringify(exportBefore);
  const overlay = deepFreeze(overlayFor({ plans: [], projects: [{ planId: plan.planId, status: "underConstruction", progress: 0.5 }], assessments: {} }));
  const view = buildStationView(deepFreeze(exportBefore), overlay, exportBefore.sites[0].stationSiteId);
  assert.equal(JSON.stringify(exportBefore), snapshot);
  assert.equal(view.sites[0].engine.label, "공사 중");
  assert.ok(view.sites[0].facts.some((f) => f.label === "지표고" && f.text === "10 m"));
  assert.ok(view.sites[0].facts.some((f) => f.missing && f.text === "미상"), "unknowns read 미상, not 0");
  const screen = ([lon, lat]) => [(lon - 139) * 1e5, -(lat - 35) * 1e5];
  const draw = (layers) => { const r = recorder(); drawStationOverlay(r.ctx, view, screen, layers); return r.calls; };
  const all = draw(new Set(LAYERS));
  assert.ok(all.some((c) => c[0] === "fillRect"), "entrances");
  assert.ok(all.some((c) => c[0] === "fillText" && String(c[1]).includes("엔진: 공사 중")), "engine layer");
  const bodyOnly = draw(new Set(["body"]));
  assert.ok(!bodyOnly.some((c) => c[0] === "fillRect" || (c[0] === "fillText" && String(c[1]).includes("엔진"))), "body alone draws no entrance or engine chip");
  assert.ok(!draw(new Set(LAYERS.filter((l) => l !== "engine"))).some((c) => c[0] === "fillText" && String(c[1]).includes("엔진")), "the engine layer can be switched off");
  assert.ok(draw(new Set()).every((c) => ["save", "restore"].includes(c[0])), "no layers, nothing drawn");
});

// --- boundary: the station modules never touch the management engine or money ---
test("station modules do not import the management engine or touch cash, construction state or files", () => {
  for (const f of ["station-site.mjs", "station-editor.mjs", "station-view.mjs", "station-ui.mjs", "local-geometry.mjs"]) {
    const src = fs.readFileSync(path.join(root, "engine/src/map", f), "utf8");
    for (const m of src.matchAll(/from "([^"]+)"/g)) assert.match(m[1], /^\.\/[a-z-]+\.mjs$|^\.\.\/(projection|geometry)\.mjs$/, `${f} imports ${m[1]}`);
    assert.doesNotMatch(src, /ledger|\.commit\(|\.settle\(|\.post\(|node:fs/, `${f} must not reach engine state or the file system`);
  }
});

// --- shipped examples (packs/<id>/station-examples), tied to that pack's plan-examples ---
const files = (id, kind, ext) => fs.readdirSync(path.join(root, "packs", id, kind)).filter((f) => f.endsWith(ext)).sort();
const loadExamples = (id) => ({
  manifest: readJson(`packs/${id}/manifest.json`),
  plans: files(id, "plan-examples", ".plan.json").map((f) => readJson(`packs/${id}/plan-examples/${f}`)),
  sites: files(id, "station-examples", ".station.json").map((f) => ({ file: f, site: readJson(`packs/${id}/station-examples/${f}`) })),
});
const IDS = ["tokyo", "example-radial", "example-corridor"];

test("Tokyo and the synthetic pack each ship the eight station kinds", () => {
  for (const id of ["tokyo", "example-radial"]) {
    const { sites } = loadExamples(id);
    assert.equal(sites.length, 8, id);
    const s = sites.map((x) => x.site);
    const structures = new Set(s.map((x) => x.planHints?.structure));
    for (const k of ["surface", "elevated", "cut-cover", "deep"]) assert.ok(structures.has(k), `${id}: ${k}`);
    const platforms = new Set(s.map((x) => x.planHints?.platformType));
    assert.ok(platforms.has("side") && platforms.has("island"), `${id}: both platform types`);
    assert.ok(s.some((x) => x.planTerminalEnd === "end" && x.extensionSpace.length === 2), `${id}: a terminal / turn-back candidate`);
    assert.ok(s.some((x) => x.transferCandidates.some((t) => t.basis === "player-passage")), `${id}: a transfer`);
    assert.ok(s.some((x) => x.spatialFlags.includes("all-entrances-blocked")), `${id}: blocked entrances`);
    assert.ok(s.some((x) => x.unknown.includes("intersectedBuildingCount") && x.unknownReasons.intersectedBuildingCount), `${id}: a site with a missing layer`);
    assert.ok(s.every((x) => x.entranceCandidates.length > 0 && x.workAreaCandidates.length === 4));
  }
  assert.ok(loadExamples("example-corridor").sites.length >= 1);
});

test("the Tokyo transfer example uses the existing network; the scratch ones have none", () => {
  const { sites } = loadExamples("tokyo");
  const transfer = sites.find((x) => x.file.includes("existing-transfer")).site;
  assert.equal(transfer.transferCandidates[0].targetKind, "external");
  assert.equal(transfer.source.requestedMode, "existing");
  assert.ok(transfer.nearestExistingStation);
  assert.ok(sites.filter((x) => x.site.source.requestedMode === "scratch").every((x) => x.site.nearestExistingStation === null));
});

test("every example connects to a plan and station that exist in the same pack's PlanGeometry examples", () => {
  for (const id of IDS) {
    const { plans, sites } = loadExamples(id);
    for (const { file, site: s } of sites) {
      const p = plans.find((x) => x.planId === s.connectedPlanId);
      assert.ok(p, `${id}/${file}: plan ${s.connectedPlanId}`);
      const st = p.stationCandidates.find((x) => x.id === s.connectedStationId);
      assert.ok(st, `${id}/${file}: station ${s.connectedStationId}`);
      assert.ok(s.connectedSegmentIds.every((sid) => p.segments.some((x) => x.id === sid)), `${id}/${file}: segments`);
      assert.equal(s.planStationIndex, p.stationCandidates.indexOf(st));
      assert.equal(s.stationSiteId, keyedStationSiteId(id, s.source.drawnStation.key), "the id follows the saved key");
    }
  }
});

test("examples keep unknowns null with a reason, carry the pack license and sources, and have no cost or score fields", () => {
  for (const id of IDS) {
    const { manifest, sites } = loadExamples(id);
    for (const { file, site: s } of sites) {
      assert.equal(s.schema, STATION_SITE_SCHEMA);
      assert.equal(s.license.pack, manifest.data.license, `${id}/${file}`);
      for (const f of s.unknown) {
        assert.ok(s.unknownReasons[f], `${id}/${file}: ${f} needs a reason`);
        assert.ok(s[f] === null || s[f] === undefined, `${id}/${file}: unknown ${f} must be null, got ${JSON.stringify(s[f])}`);
      }
      for (const child of [...s.entranceCandidates, ...s.workAreaCandidates, ...s.extensionSpace, ...s.transferCandidates]) {
        for (const f of child.unknown) assert.ok(child.unknownReasons[f], `${id}/${file}: ${f}`);
      }
      assert.notEqual(s.dataQuality, "high");
      for (const k of keysOf(s)) assert.doesNotMatch(k, forbidden, `${id}/${file}: field ${k}`);
    }
  }
  const tokyo = loadExamples("tokyo").sites.map((x) => x.site);
  assert.ok(tokyo.flatMap((s) => s.sourceLayers).some((l) => l.license === "ODbL-1.0"));
  for (const s of tokyo) for (const l of s.sourceLayers) assert.ok(l.name && l.license, `${l.layer} needs a name and a license`);
  assert.ok(tokyo.every((s) => s.license.pack === "ODbL-1.0"), "OSM-derived facts only ship under the pack's ODbL");
});

test("synthetic-pack examples regenerate byte-for-byte from their saved sites and generated layers", () => {
  for (const id of ["example-radial", "example-corridor"]) {
    const { manifest, plans, sites } = loadExamples(id);
    const demand = readJson(`packs/${id}/${manifest.files.demand}`);
    const p = { manifest, demand };
    const mapExport = { plans, externalNetworks: [], demandNodes: buildMapExport({ pack: p, mode: "scratch", drawnLines: [] }).demandNodes };
    for (const { file, site: s } of sites) {
      const { source: src, ...body } = s;
      const at = plans.find((x) => x.planId === s.connectedPlanId).stationCandidates[s.planStationIndex].location;
      const layers = src.layers.kind === "synthetic-layers" ? syntheticLayers(at, src.layers.options) : {};
      const fresh = buildStationExport({ pack: p, mapExport, stations: [src.drawnStation], spatial: makeSpatialContext(layers) }).sites[0];
      assert.equal(JSON.stringify(fresh), JSON.stringify(body), `${id}/${file} is stale: run npm run station-examples`);
    }
  }
});
