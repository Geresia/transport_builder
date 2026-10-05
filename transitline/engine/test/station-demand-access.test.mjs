import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { buildMapExport } from "../src/map/plan-geometry.mjs";
import { makeSpatialContext, polygonLayer, roadLayerFromGeojson } from "../src/map/spatial.mjs";
import {
  ACCESS_POINT_KINDS, DEMAND_ZONE_KINDS, STATION_DEMAND_ACCESS_EXPORT_SCHEMA, STATION_DEMAND_ACCESS_SCHEMA, buildStationDemandAccess, buildStationDemandAccessExport,
  demandSourceRefsOf, stationAccessIdOf,
} from "../src/map/station-demand-access.mjs";
import {
  STATION_DEMAND_ACCESS_DOC_VERSION, activeStations, addAccessPoint, addCatchment, addDemandZone, addElement, addEntrance, addStation, addWalkLink, clearTransfer, insertVertex,
  moveElement, moveStation, moveVertex, newStationDemandAccessDoc, referencesTo, removeElement, removeStation, removeVertex, restoreStation, restoreStationDemandAccessDoc,
  rotateStation, serializeStationDemandAccessDoc, setTransfer, setWalkLinkEnds, setWalkLinkVia, toDrawnStation, updateElement, updateStation,
} from "../src/map/station-demand-access-editor.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");

// --- fixtures: a main line along lat 35 (stations 0.01 degrees ~ 910 m apart), one existing line, four demand nodes ---
const pack = {
  manifest: { id: "t", version: "1", data: { license: "CC0-1.0", attribution: ["test data"] } },
  demand: { points: [] },
  existingNetwork: { lines: [{ name: "E1", osmRelationId: 42, stationIds: ["d1", "d2"] }] },
};
const nodes = [
  { id: "d0", name: "d0", location: [139, 35], residents: 83117, jobs: 40213, kind: "residential" },
  { id: "d1", name: "d1", location: [139.01, 35], residents: 77031, jobs: null, kind: "mixed" },
  { id: "d2", name: "d2", location: [139.02, 35], residents: null, jobs: null, kind: "mixed" },
  { id: "far", name: "far", location: [139.5, 35.5], residents: 61223, jobs: 9917, kind: "commercial" },
];
pack.demand.points = nodes;
const line = (key, pts) => ({ key, name: key, vertices: pts.map((location) => ({ location, platformType: "side" })) });
const main = line("main", [[139, 35], [139.01, 35], [139.02, 35]]);
const scratch = buildMapExport({ pack, mode: "scratch", drawnLines: [main] });
const existing = buildMapExport({ pack, mode: "existing", drawnLines: [main] });
const plan = scratch.plans[0];
const [s0, s1] = plan.stationCandidates;
const S1 = [139.01, 35];

const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
const covers = ([x, y]) => x >= 138.99 && x <= 139.03 && y >= 34.98 && y <= 35.02;
const fullLayers = () => ({
  // buildings: x 139.0100..139.0104 / y 35.0004..35.0007 and x 139.0118..139.0122 / y 35.0001..35.0003;
  // a river along y 34.9990..34.9993; a major road along y 35.0003
  buildings: polygonLayer([{ rings: [rect(139.01, 35.0004, 139.0104, 35.0007)] }, { rings: [rect(139.0118, 35.0001, 139.0122, 35.0003)] }], { covers, quality: "high", source: { name: "test buildings", license: "CC0-1.0" } }),
  water: polygonLayer([{ rings: [rect(138.99, 34.999, 139.03, 34.9993)] }], { covers, quality: "medium", source: { name: "test river", license: "CC0-1.0" } }),
  roads: roadLayerFromGeojson({ features: [{ geometry: { coordinates: [[138.99, 35.0003], [139.03, 35.0003]] }, properties: { roadClass: "major" } }] }, { covers, quality: "medium", source: { name: "test roads", license: "CC0-1.0" } }),
});
const withLayers = makeSpatialContext(fullLayers());
const bare = makeSpatialContext();

const deepFreeze = (o) => { if (o && typeof o === "object") { Object.values(o).forEach(deepFreeze); Object.freeze(o); } return o; };
const station = (extra = {}) => ({ key: "st1", name: "Middle", connect: { planId: plan.planId, stationId: s1.id }, ...extra });
const build = (drawn, extra = {}) => {
  const site = buildStationDemandAccess(drawn, { pack, spatial: withLayers, plans: scratch.plans, externalNetworks: [], demandNodes: scratch.demandNodes, ...extra });
  assert.ok(site, "a site is built");
  return site;
};
const codes = (site) => site.warnings.map((w) => w.code);

// the full drawing: two entrances, two access points, a zone north of the station, three links, two boundaries
const FULL = () => station({
  entrances: [{ key: "e1", name: "North", location: [139.0102, 35.0002] }, { key: "e2", name: "South", location: [139.0098, 34.9997] }],
  accessPoints: [{ key: "p1", name: "Crossing", location: [139.0102, 35.0012], kind: "crossing" }, { key: "p2", location: [139.0102, 34.9985], kind: "street" }],
  demandZones: [{ key: "z1", name: "North homes", kind: "residential", polygon: rect(139.0095, 35.0014, 139.0125, 35.0030) }],
  walkLinks: [
    { key: "w1", from: { kind: "entrance", key: "e1" }, to: { kind: "access-point", key: "p1" }, via: [[139.0102, 35.0006]] },
    { key: "w2", from: { kind: "access-point", key: "p1" }, to: { kind: "demand-zone", key: "z1" } },
    { key: "w3", from: { kind: "station" }, to: { kind: "access-point", key: "p2" }, widthMeters: 3 },
  ],
  catchments: [{ key: "c1", name: "Walk boundary", polygon: rect(139.003, 34.995, 139.017, 35.005) }, { key: "c2", entranceKey: "e1", polygon: rect(139.0095, 34.9995, 139.0115, 35.0035) }],
});

// --- identity and determinism ---
test("same drawing gives byte-identical output and deterministic ids", () => {
  const a = build(FULL());
  const b = build(structuredClone(FULL()));
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.equal(a.schema, STATION_DEMAND_ACCESS_SCHEMA);
  assert.equal(a.stationAccessId, stationAccessIdOf("t", "st1"));
  const ids = [a.stationAccessId, ...a.entrances.map((x) => x.entranceId), ...a.accessPoints.map((x) => x.accessPointId), ...a.walkLinks.map((x) => x.walkLinkId), ...a.catchments.map((x) => x.catchmentId), ...a.demandZones.map((x) => x.demandZoneId), ...a.transfers.map((x) => x.transferId)];
  assert.equal(new Set(ids).size, ids.length, "ids never collide inside one station");
  assert.match(a.stationAccessRevision, /^stn-access-revision:/);
});

test("a keyed station keeps its id through renames, moves and reordering; its facts change the revision", () => {
  const first = build(FULL());
  const drawn = FULL();
  drawn.name = "Renamed";
  drawn.entrances.reverse();
  drawn.catchments.reverse();
  const again = build(drawn);
  assert.equal(again.stationAccessId, first.stationAccessId);
  assert.deepEqual(again.entrances.map((e) => e.entranceId), first.entrances.map((e) => e.entranceId));
  assert.deepEqual(again.catchments.map((c) => c.catchmentId), first.catchments.map((c) => c.catchmentId));
  const moved = FULL();
  moved.entrances[0].location = [139.0103, 35.0002];
  const edited = build(moved);
  assert.equal(edited.entrances.find((e) => e.key === "e1").entranceId, first.entrances.find((e) => e.key === "e1").entranceId, "a key keeps the id when the element moves");
  assert.notEqual(edited.stationAccessRevision, first.stationAccessRevision);
});

test("keyless elements are identified by place; a different place is a different id", () => {
  const a = build(station({ key: undefined, entrances: [{ location: [139.0102, 35.0002] }] }));
  const b = build(station({ key: undefined, entrances: [{ location: [139.0102, 35.0002] }] }));
  const c = build(station({ key: undefined, entrances: [{ location: [139.0103, 35.0002] }] }));
  assert.equal(a.entrances[0].entranceId, b.entrances[0].entranceId);
  assert.notEqual(a.entrances[0].entranceId, c.entrances[0].entranceId);
});

// --- the station itself ---
test("a station takes its place from the plan station, an external station or the player", () => {
  const fromPlan = build({ key: "a", connect: { planId: plan.planId, stationId: s1.id } });
  assert.deepEqual(fromPlan.location, S1);
  assert.equal(fromPlan.locationBasis, "plan-station");
  assert.equal(fromPlan.stationKind, "plan");
  assert.equal(fromPlan.offsetFromConnectedStationMeters, 0);
  const net = existing.externalNetworks[0];
  const ext = build({ key: "b", connect: { externalNetworkId: net.id, stationId: "d1" } }, { plans: existing.plans, externalNetworks: existing.externalNetworks });
  assert.equal(ext.stationKind, "external");
  assert.equal(ext.connectedNetworkId, net.id);
  const free = build({ key: "c", location: [139.015, 35.001] });
  assert.equal(free.stationKind, "free");
  assert.equal(free.locationBasis, "player");
  assert.equal(free.offsetFromConnectedStationMeters, null);
  assert.equal(free.unknownReasons.offsetFromConnectedStationMeters, "no-connection");
});

test("an unresolved connection is a warning, and a station with no place at all is not built", () => {
  const missingPlan = build({ key: "a", location: S1, connect: { planId: "plan:nope", stationId: "x" } });
  assert.ok(codes(missingPlan).includes("connection-plan-missing"));
  assert.equal(missingPlan.unknownReasons.offsetFromConnectedStationMeters, "connection-unresolved");
  const missingStation = build({ key: "b", location: S1, connect: { planId: plan.planId, stationId: "stn:nope" } });
  assert.ok(codes(missingStation).includes("connection-station-missing"));
  assert.equal(buildStationDemandAccess({ key: "c", connect: { planId: "plan:nope", stationId: "x" } }, { pack, plans: scratch.plans }), null);
  const out = buildStationDemandAccessExport({ pack, mapExport: scratch, stations: [{ key: "c", connect: { planId: "plan:nope", stationId: "x" } }], spatial: withLayers });
  assert.deepEqual(out.sites, []);
  assert.deepEqual(out.warnings.map((w) => w.code), ["station-no-location"]);
  assert.ok(codes(build({ key: "d", location: [999, 0], connect: { planId: plan.planId, stationId: s1.id } })).includes("station-location-invalid"));
});

// --- entrances and access points ---
test("entrances and access points report what stands there; the measurements are facts, not verdicts", () => {
  const site = build(station({
    entrances: [{ key: "in", location: [139.0102, 35.0005] }, { key: "out", location: [139.0098, 35.0010] }],
    accessPoints: [{ key: "p", location: [139.0102, 35.0006], kind: "plaza" }],
  }));
  const [inside, outside] = ["in", "out"].map((k) => site.entrances.find((e) => e.key === k));
  assert.equal(inside.insideBuildingCount, 1);
  assert.deepEqual(inside.spatialFlags, ["inside-building"]);
  assert.equal(outside.insideBuildingCount, 0, "a covered layer that finds nothing is a fact: 0");
  assert.equal(outside.insideWaterCount, 0);
  assert.ok(site.spatialFlags.includes("entrance-inside-building"));
  assert.ok(inside.distanceToStationMeters > 0);
  assert.equal(inside.roadsNearby.major, 1);
  assert.equal(site.accessPoints[0].kind, "plaza");
  assert.equal(site.accessPoints[0].insideBuildingCount, 1);
});

test("without layers every layer fact is null with its reason, never 0", () => {
  const site = build(station({ entrances: [{ key: "e", location: [139.0102, 35.0005] }], accessPoints: [{ key: "p", location: [139.0102, 35.0006], kind: "street" }], demandZones: [{ key: "z", kind: "mixed", polygon: rect(139.009, 35.001, 139.011, 35.002) }], catchments: [{ key: "c", polygon: rect(139.005, 34.996, 139.015, 35.004) }] }), { spatial: bare });
  const e = site.entrances[0];
  assert.equal(e.insideBuildingCount, null);
  assert.equal(e.insideWaterCount, null);
  assert.equal(e.roadsNearby, null);
  assert.deepEqual(e.unknown, ["insideBuildingCount", "insideWaterCount", "roadsNearby"]);
  assert.equal(e.unknownReasons.insideBuildingCount, "no-layer");
  assert.equal(site.catchments[0].buildingCount, null);
  assert.equal(site.demandZones[0].waterOverlapCount, null);
  const outside = build(station({ entrances: [{ key: "e", location: [140.5, 36] }] }));
  assert.equal(outside.entrances[0].insideBuildingCount, null);
  assert.equal(outside.entrances[0].unknownReasons.insideBuildingCount, "outside-coverage");
});

test("bad points and kinds are warnings; an unknown kind stays null", () => {
  const site = build(station({
    entrances: [{ key: "ok", location: [139.0102, 35.0002] }, { key: "bad", location: [200, 0] }, { key: "ok", location: [139.0102, 35.0002] }, { key: "none" }],
    accessPoints: [{ key: "k", location: [139.0102, 35.001], kind: "teleporter" }, { key: "n", location: [139.0103, 35.001] }, { location: "x" }],
  }));
  assert.equal(site.entrances.length, 1);
  assert.deepEqual(codes(site).filter((c) => c.startsWith("entrance") || c.startsWith("duplicate-entrance")), ["entrance-no-location", "duplicate-entrance", "entrance-no-location"]);
  const [teleport, plain] = ["k", "n"].map((k) => site.accessPoints.find((p) => p.key === k));
  assert.equal(teleport.kind, null);
  assert.equal(teleport.unknownReasons.kind, "not-provided");
  assert.equal(plain.kind, null);
  assert.ok(codes(site).includes("access-point-kind-invalid"));
  assert.ok(codes(site).includes("access-point-no-location"));
  assert.ok(ACCESS_POINT_KINDS.includes("crossing") && DEMAND_ZONE_KINDS.includes("residential"));
});

// --- walking links ---
test("a walking link measures its drawn line and what it crosses; width is the player's or unknown", () => {
  const site = build(FULL());
  const w1 = site.walkLinks.find((l) => l.key === "w1");
  assert.equal(w1.alignmentBasis, "player");
  assert.equal(w1.alignment.length, 3);
  assert.ok(w1.lengthMeters >= w1.straightDistanceMeters);
  assert.equal(w1.crossings.building, 1, "the drawn line passes through the building");
  assert.equal(w1.widthMeters, null);
  assert.equal(w1.unknownReasons.widthMeters, "not-provided");
  assert.equal(w1.from.kind, "entrance");
  assert.equal(w1.to.kind, "access-point");
  const w3 = site.walkLinks.find((l) => l.key === "w3");
  assert.equal(w3.widthMeters, 3);
  assert.equal(w3.crossings.river, 1);
  assert.deepEqual(w3.unknown, ["crossings.railway", "crossings.utility"], "a direct build has no rail layer; the export adds one from the external networks");
  assert.ok(site.spatialFlags.includes("walk-through-buildings"));
  assert.ok(site.spatialFlags.includes("walk-crosses-river"));
  assert.equal(site.walkLinks.find((l) => l.key === "w2").crossings.river, 0, "a covered layer that finds no crossing is 0");
});

test("a link without layers has null crossings with reasons", () => {
  const site = build(FULL(), { spatial: bare });
  const w1 = site.walkLinks.find((l) => l.key === "w1");
  assert.deepEqual(w1.crossings, { river: null, road: null, railway: null, building: null, utility: null });
  assert.equal(w1.unknownReasons["crossings.river"], "no-layer");
  assert.equal(w1.unknownReasons["crossings.utility"], "no-dataset", "no pack has utility data");
  assert.ok(!site.spatialFlags.includes("walk-through-buildings"), "no flag from missing data");
});

test("links that name nothing, name themselves, or carry bad waypoints / widths are reported and dropped or nulled", () => {
  const site = build(station({
    entrances: [{ key: "e1", location: [139.0102, 35.0002] }],
    accessPoints: [{ key: "p1", location: [139.0102, 35.0012], kind: "street" }],
    walkLinks: [
      { key: "ghost", from: { kind: "entrance", key: "e9" }, to: { kind: "station" } },
      { key: "loop", from: { kind: "entrance", key: "e1" }, to: { kind: "entrance", key: "e1" } },
      { key: "bend", from: { kind: "entrance", key: "e1" }, to: { kind: "access-point", key: "p1" }, via: [["x", 1]] },
      { key: "fat", from: { kind: "entrance", key: "e1" }, to: { kind: "access-point", key: "p1" }, widthMeters: -2 },
      { key: "bad-kind", from: { kind: "bus", key: "e1" }, to: { kind: "station" } },
    ],
  }));
  assert.deepEqual(site.walkLinks.map((l) => l.key), ["fat"]);
  assert.equal(site.walkLinks[0].widthMeters, null);
  assert.equal(site.walkLinks[0].unknownReasons.widthMeters, "width-invalid");
  assert.deepEqual(codes(site).filter((c) => c.startsWith("walk-link")), ["walk-link-endpoint-missing", "walk-link-same-endpoints", "walk-link-via-invalid", "walk-link-endpoint-missing"]);
  assert.ok(codes(site).includes("width-invalid"));
});

test("walk connection is the shortest drawn length, and no drawn link says so without saying unwalkable", () => {
  const site = build(FULL());
  const zone = site.demandZones[0];
  const w1 = site.walkLinks.find((l) => l.key === "w1");
  const w2 = site.walkLinks.find((l) => l.key === "w2");
  assert.equal(zone.drawnConnection.connected, true);
  assert.deepEqual(zone.drawnConnection.linkIds, [w1.walkLinkId, w2.walkLinkId]);
  assert.equal(zone.drawnConnection.lengthMeters, Math.round((w1.lengthMeters + w2.lengthMeters) * 10) / 10);
  assert.deepEqual(site.accessPoints.find((p) => p.key === "p1").drawnConnection.linkIds, [w1.walkLinkId]);
  assert.deepEqual(zone.linkedWalkLinkIds, [w2.walkLinkId]);
  const lone = build(station({ accessPoints: [{ key: "p", location: [139.0102, 35.0012], kind: "street" }], demandZones: [{ key: "z", polygon: rect(139.009, 35.001, 139.011, 35.002), kind: "mixed" }] }));
  assert.deepEqual(lone.accessPoints[0].drawnConnection, { connected: false });
  assert.deepEqual(lone.demandZones[0].drawnConnection, { connected: false });
  assert.ok(lone.spatialFlags.includes("access-point-without-walk-link") && lone.spatialFlags.includes("demand-zone-without-walk-link"));
});

test("the shortest of two drawn routes wins, deterministically", () => {
  const drawn = station({
    entrances: [{ key: "e", location: [139.0102, 35.0002] }],
    accessPoints: [{ key: "far", location: [139.0102, 35.0030], kind: "street" }, { key: "near", location: [139.0102, 35.0010], kind: "street" }],
    walkLinks: [
      { key: "long", from: { kind: "entrance", key: "e" }, to: { kind: "access-point", key: "far" }, via: [[139.0120, 35.0010]] },
      { key: "a", from: { kind: "entrance", key: "e" }, to: { kind: "access-point", key: "near" } },
      { key: "b", from: { kind: "access-point", key: "near" }, to: { kind: "access-point", key: "far" } },
    ],
  });
  const site = build(drawn);
  const far = site.accessPoints.find((p) => p.key === "far");
  const ids = Object.fromEntries(site.walkLinks.map((l) => [l.key, l.walkLinkId]));
  assert.deepEqual(far.drawnConnection.linkIds, [ids.a, ids.b]);
  assert.equal(JSON.stringify(build(drawn)), JSON.stringify(site));
});

// --- catchments and zones ---
test("a catchment is the player's polygon with spatial facts; it may be tied to one entrance", () => {
  const site = build(FULL());
  const [c1, c2] = ["c1", "c2"].map((k) => site.catchments.find((c) => c.key === k));
  assert.equal(c1.scope, "station");
  assert.equal("entranceId" in c1, false);
  assert.equal(c1.polygonBasis, "player");
  assert.equal(c1.containsStation, true);
  assert.equal(c1.containsEntranceIds.length, 2);
  assert.equal(c1.containsAccessPointIds.length, 2);
  assert.equal(c1.buildingCount, 2);
  assert.equal(c1.waterOverlapCount, 1);
  assert.deepEqual(c1.demandNodeIdsInside, ["d1"]);
  assert.ok(c1.areaSquareMeters > 1_000_000);
  assert.equal(c2.scope, "entrance");
  assert.equal(c2.entranceId, site.entrances.find((e) => e.key === "e1").entranceId);
  assert.deepEqual(c2.demandZoneIds, [site.demandZones[0].demandZoneId]);
  assert.deepEqual(c2.demandNodeIdsInside, ["d1"]);
});

test("a catchment away from its station is flagged, never corrected", () => {
  const site = build(station({ entrances: [{ key: "e", location: [139.0102, 35.0002] }], catchments: [{ key: "away", polygon: rect(139.02, 35.01, 139.025, 35.015) }, { key: "own", entranceKey: "e", polygon: rect(139.02, 35.01, 139.025, 35.015) }] }));
  assert.equal(site.catchments.find((c) => c.key === "away").containsStation, false);
  assert.ok(site.spatialFlags.includes("catchment-excludes-station"));
  assert.deepEqual(site.catchments.find((c) => c.key === "own").spatialFlags, ["excludes-station", "excludes-own-entrance"]);
  assert.deepEqual(build(station()).catchments, []);
  assert.ok(build(station()).spatialFlags.includes("no-catchment-drawn"));
});

test("degenerate polygons, unknown entrances and repeats are warnings", () => {
  const site = build(station({
    entrances: [{ key: "e", location: [139.0102, 35.0002] }],
    catchments: [{ key: "line", polygon: [[139, 35], [139.01, 35], [139.02, 35]] }, { key: "bow", polygon: [[139, 35], [139.01, 35.01], [139.01, 35], [139, 35.01]] }, { key: "ghost", entranceKey: "e9", polygon: rect(139, 35, 139.01, 35.01) }, { key: "ok", polygon: rect(139, 35, 139.01, 35.01) }, { key: "ok", polygon: rect(139, 35, 139.01, 35.01) }],
    demandZones: [{ key: "z", polygon: [[1, 1], [2, 2]] }, { key: "zk", polygon: rect(139, 35, 139.01, 35.01), kind: "spaceport" }],
  }));
  assert.deepEqual(site.catchments.map((c) => c.key), ["ok"]);
  assert.deepEqual(codes(site).filter((c) => c.includes("catchment")), ["catchment-degenerate", "catchment-degenerate", "catchment-entrance-missing", "duplicate-catchment"]);
  assert.equal(site.demandZones.length, 1);
  assert.equal(site.demandZones[0].kind, null);
  assert.equal(site.demandZones[0].unknownReasons.kind, "not-provided");
  assert.ok(codes(site).includes("demand-zone-degenerate") && codes(site).includes("demand-zone-kind-invalid"));
});

// --- demand data: ids, source and quality only ---
const SOURCES = demandSourceRefsOf([
  { file: "demand.json", kind: "demand-points", document: { formatVersion: 1, model: "gravity", points: [{ id: "x", residents: 83117 }] }, attribution: ["demand attribution"], spatialResolution: "municipality", quality: "low", license: "CC0-1.0" },
  { file: "od.json", kind: "od-commute", document: { formatVersion: 1, source: "census table", unit: "workers", origins: { a: { workers: 99999 } } }, spatialResolution: "municipality", quality: "medium" },
  { file: "od-school.json", kind: "od-school", document: {}, quality: "sloppy" },
], "t");

test("demand links carry ids, source and quality, and no value of the pack's files", () => {
  const site = build(FULL(), { demandSources: SOURCES });
  const zone = site.demandZones[0];
  assert.deepEqual(zone.demandNodeRefs, [], "no node lies inside the drawn zone: a fact");
  assert.ok(zone.spatialFlags.includes("no-demand-node-inside"));
  assert.equal(zone.nearestDemandNode.demandNodeId, "d1");
  assert.ok(zone.nearestDemandNode.distanceMeters > 0);
  const big = build(station({ demandZones: [{ key: "big", kind: "residential", polygon: rect(138.995, 34.995, 139.025, 35.005) }] }), { demandSources: SOURCES }).demandZones[0];
  assert.deepEqual(big.demandNodeRefs.map((n) => n.demandNodeId), ["d0", "d1", "d2"]);
  assert.deepEqual(big.demandNodeRefs.map((n) => n.fieldsPresent), [["residents", "jobs"], ["residents"], []]);
  assert.equal(big.nearestDemandNode.distanceMeters, 0);
  assert.deepEqual(big.demandSourceRefIds, [SOURCES.find((s) => s.file === "demand.json").sourceId]);
  const text = JSON.stringify(site) + JSON.stringify(big);
  for (const value of ["83117", "40213", "77031", "61223", "99999"]) assert.equal(text.includes(value), false, `${value} must not be copied from the pack's files`);
});

test("source refs copy only what the file states; the rest is unknown with a reason", () => {
  const [demand, od, school] = ["demand.json", "od.json", "od-school.json"].map((f) => SOURCES.find((s) => s.file === f));
  assert.equal(demand.source, null);
  assert.equal(demand.unknownReasons.source, "not-stated-in-file");
  assert.equal(demand.quality, "low");
  assert.equal(demand.model, "gravity");
  assert.deepEqual(demand.attribution, ["demand attribution"]);
  assert.equal(od.source, "census table");
  assert.equal(od.unit, "workers");
  assert.equal(od.spatialResolution, "municipality");
  assert.equal(school.quality, null, "an unrecognised quality is not carried over");
  assert.equal(school.unknownReasons.quality, "not-assessed");
  assert.equal(school.spatialResolution, null);
  for (const s of SOURCES) assert.deepEqual(Object.keys(s.unknownReasons).sort(), [...s.unknown]);
  assert.deepEqual(SOURCES.map((s) => s.sourceId), [...SOURCES.map((s) => s.sourceId)].sort());
});

test("the source quality caps the site quality, and no sources supplied is unknown", () => {
  const withSources = build(FULL(), { demandSources: SOURCES });
  assert.equal(withSources.dataQuality, "low");
  assert.deepEqual(withSources.demandSourceRefs, SOURCES);
  const none = build(FULL());
  assert.equal(none.demandSourceRefs, null);
  assert.equal(none.unknownReasons.demandSourceRefs, "no-source-supplied");
  assert.equal(none.demandZones[0].demandSourceRefIds, null);
  const noNodes = build(FULL(), { demandNodes: null });
  assert.equal(noNodes.demandZones[0].demandNodeRefs, null);
  assert.equal(noNodes.demandZones[0].unknownReasons.demandNodeRefs, "no-demand-nodes-supplied");
  assert.equal(noNodes.catchments[0].demandNodeIdsInside, null);
  const empty = build(FULL(), { demandNodes: [] });
  assert.deepEqual(empty.demandZones[0].demandNodeRefs, []);
  assert.equal(empty.demandZones[0].nearestDemandNode, null);
  assert.equal(empty.demandZones[0].unknownReasons.nearestDemandNode, "pack-has-no-demand-nodes");
});

// --- transfers ---
test("a nearby station is a transfer fact; a drawn passage replaces the straight line", () => {
  const ctx = { externalNetworks: existing.externalNetworks, plans: existing.plans, demandNodes: existing.demandNodes };
  const near = build({ key: "x", location: [139.0105, 35] }, ctx);
  const t = near.transfers.find((x) => x.targetKind === "external");
  assert.ok(t, "d1 is the external station within 500 m");
  assert.equal(t.basis, "nearby");
  assert.equal(t.alignmentBasis, "straight");
  assert.equal(t.targetLocationBasis, "demand-node");
  assert.equal(t.dataQuality, "low");
  assert.ok(codes(near).includes("external-station-locations-coarse"));
  assert.ok(near.spatialFlags.includes("external-station-locations-coarse"));
  const drawn = { key: "x", location: [139.0105, 35], entrances: [{ key: "e", location: [139.0103, 35.0002] }], transfers: [{ targetStationId: "d1", via: [[139.006, 35.0015]], fromEntranceKey: "e", widthMeters: 4 }] };
  const passage = build(drawn, ctx).transfers.find((x) => x.targetStationId === "d1");
  assert.equal(passage.basis, "player-passage");
  assert.equal(passage.alignmentBasis, "player");
  assert.equal(passage.from.kind, "entrance");
  assert.equal(passage.widthMeters, 4);
  assert.ok(passage.passageLengthMeters > passage.straightDistanceMeters);
  assert.equal(passage.targetNetworkId, existing.externalNetworks[0].id);
});

test("a neighbour on the station's own line is not a transfer; missing targets and bad passages are warnings", () => {
  const site = build(station({ transfers: [{ targetStationId: s0.id }, { targetStationId: "nope" }] }));
  assert.deepEqual(site.transfers, [], "s0 is on the same plan");
  assert.deepEqual(codes(site).filter((c) => c.startsWith("transfer")), ["transfer-target-missing", "transfer-target-missing"]);
  // a second plan whose first station is 0.0015 degrees (~170 m) from the middle station of the main plan
  const two = buildMapExport({ pack, mode: "scratch", drawnLines: [main, line("other", [[139.01, 35.0015], [139.03, 35.0015]])] });
  const mainPlan = two.plans.find((p) => p.name === "main");
  const target = two.plans.find((p) => p.name === "other").stationCandidates[0];
  const ctx = { plans: two.plans, externalNetworks: [], demandNodes: [] };
  const base = { key: "s", connect: { planId: mainPlan.planId, stationId: mainPlan.stationCandidates[1].id } };
  const nearby = build(base, ctx);
  assert.equal(nearby.transfers.find((x) => x.targetStationId === target.id).basis, "nearby");
  const badVia = build({ ...base, transfers: [{ targetStationId: target.id, via: [["z"]] }] }, ctx);
  assert.ok(codes(badVia).includes("transfer-via-invalid"));
  assert.equal(badVia.transfers.find((x) => x.targetStationId === target.id).basis, "nearby", "the nearby fact stays when the passage is refused");
  const ghostEntrance = build({ ...base, transfers: [{ targetStationId: target.id, fromEntranceKey: "ghost" }] }, ctx);
  assert.ok(codes(ghostEntrance).includes("transfer-entrance-missing"));
  assert.equal(ghostEntrance.transfers.find((x) => x.targetStationId === target.id).from.kind, "station", "an unknown entrance falls back to the station, with a warning");
});

// --- the null contract ---
const keysOf = (o, out = new Set()) => { if (Array.isArray(o)) o.forEach((x) => keysOf(x, out)); else if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) { out.add(k); keysOf(v, out); } return out; };
const records = (site) => [
  ["entrances", "entranceId"], ["accessPoints", "accessPointId"], ["walkLinks", "walkLinkId"], ["transfers", "transferId"], ["catchments", "catchmentId"], ["demandZones", "demandZoneId"], ["demandSourceRefs", "sourceId"],
].flatMap(([collection, idField]) => (site[collection] ?? []).map((rec) => ({ collection, id: rec[idField], rec })));
const resolve = (rec, field) => (field.startsWith("crossings.") ? rec.crossings[field.slice(10)] : rec[field]);

function assertUnknownContract(site) {
  assert.deepEqual(Object.keys(site.unknownReasons), [...site.unknown], "site: unknown and unknownReasons are 1:1, in the same order");
  for (const { rec } of records(site)) {
    assert.deepEqual(Object.keys(rec.unknownReasons).sort(), [...rec.unknown].sort());
    for (const f of rec.unknown) assert.equal(resolve(rec, f), null, `${f} is unknown, so null — not 0, false or []`);
    for (const r of Object.values(rec.unknownReasons)) assert.equal(typeof r, "string");
  }
  for (const p of site.unknown) {
    const parts = p.split(":");
    if (parts.length === 1) { assert.equal(site[p], null, p); continue; }
    const collection = parts[0];
    const field = parts.at(-1);
    const id = parts.slice(1, -1).join(":");
    const hit = records(site).find((r) => r.collection === collection && r.id === id);
    assert.ok(hit, `${p} names a record`);
    assert.equal(hit.rec.unknownReasons[field], site.unknownReasons[p]);
  }
  // no child unknown goes missing from the site list
  for (const { collection, id, rec } of records(site)) for (const f of rec.unknown) assert.ok(site.unknown.includes(`${collection}:${id}:${f}`), `${collection}:${id}:${f}`);
}

test("unknown[] and unknownReasons are 1:1 everywhere, and every unknown value is null", () => {
  for (const spatial of [withLayers, bare]) for (const extra of [{}, { demandSources: SOURCES }, { demandNodes: null }]) {
    assertUnknownContract(build(FULL(), { spatial, ...extra }));
    assertUnknownContract(build({ key: "free", location: [139.0005, 35] }, { spatial, ...extra }));
  }
});

test("the contract carries no passenger, fare, crowd, time, route or score field, and no number from the pack's files", () => {
  const banned = /passenger|rider|ridership|fare|crowd|congest|score|cost|cash|price|minute|probab|share|forecast|volume|headcount|population|residents|jobs|workers|students/i;
  const site = build(FULL(), { demandSources: SOURCES });
  const names = (o) => [...keysOf(o)].filter((k) => !/^(unknown|unknownReasons)$/.test(k) && banned.test(k));
  assert.deepEqual(names(site), [], "no key names a quantity the map must not compute");
  const big = build(station({ demandZones: [{ key: "big", polygon: rect(138.995, 34.995, 139.025, 35.005) }] }), { demandSources: SOURCES });
  assert.deepEqual(names(big), [], "residents / jobs appear only as the names of fields a node has, never as keys");
  assert.deepEqual(names(buildStationDemandAccessExport({ pack, mapExport: scratch, stations: [FULL()], spatial: withLayers, demandSources: SOURCES })), []);
});

test("inputs are never modified", () => {
  const drawn = deepFreeze(FULL());
  const ctx = { pack: deepFreeze(structuredClone(pack)), spatial: withLayers, plans: deepFreeze(structuredClone(scratch.plans)), externalNetworks: deepFreeze(structuredClone(existing.externalNetworks)), demandNodes: deepFreeze(structuredClone(scratch.demandNodes)), demandSources: deepFreeze(structuredClone(SOURCES)) };
  assert.ok(buildStationDemandAccess(drawn, ctx));
  const refs = deepFreeze(structuredClone([{ file: "x.json", kind: "od-commute", document: { source: "s" } }]));
  assert.equal(demandSourceRefsOf(refs, "t").length, 1);
});

test("the modules reach no engine state, file system, clock or random source", () => {
  for (const file of ["station-demand-access.mjs", "station-demand-access-editor.mjs"]) {
    const src = fs.readFileSync(path.join(root, "engine", "src", "map", file), "utf8");
    const imports = [...src.matchAll(/^import .* from "(.+)";$/gm)].map((m) => m[1]);
    assert.ok(imports.every((i) => /^\.\/[a-z-]+\.mjs$/.test(i) || i === "../projection.mjs"), `${file} imports ${imports}`);
    assert.doesNotMatch(src.replace(/\/\/.*$/gm, ""), /management|ledger|node:fs|Date\.now|Math\.random|\.commit\(|\.settle\(|\.post\(/);
  }
});

// --- export ---
test("the export sorts stations by id, skips removed ones, reports duplicates and shared boundaries", () => {
  const a = { key: "a", location: [139, 35], catchments: [{ key: "c", polygon: rect(138.998, 34.998, 139.004, 35.002) }] };
  const b = { key: "b", location: [139.006, 35], catchments: [{ key: "c", polygon: rect(139.002, 34.998, 139.008, 35.002) }] };
  const far = { key: "far", location: [139.02, 35.01], catchments: [{ key: "c", polygon: rect(139.019, 35.009, 139.021, 35.011) }] };
  const input = () => [far, { key: "gone", location: S1, deleted: true }, b, a, { ...a }];
  const out = buildStationDemandAccessExport({ pack, mapExport: scratch, stations: input(), spatial: withLayers, demandSources: SOURCES });
  assert.equal(out.schema, STATION_DEMAND_ACCESS_EXPORT_SCHEMA);
  assert.deepEqual(out.sites.map((s) => s.stationAccessId), [...out.sites.map((s) => s.stationAccessId)].sort());
  assert.equal(out.sites.length, 3);
  assert.deepEqual(out.inactive, [{ key: "gone", stationAccessId: stationAccessIdOf("t", "gone") }]);
  assert.deepEqual(out.warnings.map((w) => w.code), ["duplicate-station-access"]);
  assert.equal(out.catchmentOverlaps.length, 1);
  assert.deepEqual([...out.catchmentOverlaps[0].stationAccessIds].sort(), [stationAccessIdOf("t", "a"), stationAccessIdOf("t", "b")].sort());
  assert.equal(JSON.stringify(out), JSON.stringify(buildStationDemandAccessExport({ pack, mapExport: scratch, stations: structuredClone(input()), spatial: withLayers, demandSources: structuredClone(SOURCES) })));
});

// --- editing and saving ---
const docWith = () => {
  const doc = newStationDemandAccessDoc("t", "1");
  const st = addStation(doc, { name: "Middle", connect: { planId: plan.planId, stationId: s1.id } });
  const e1 = addEntrance(doc, st.key, { name: "North", location: [139.0102, 35.0002] });
  const p1 = addAccessPoint(doc, st.key, { location: [139.0102, 35.0012], kind: "crossing" });
  const z1 = addDemandZone(doc, st.key, { kind: "residential", polygon: rect(139.0095, 35.0014, 139.0125, 35.003) });
  const w1 = addWalkLink(doc, st.key, { from: { kind: "entrance", key: e1.key }, to: { kind: "access-point", key: p1.key } });
  const c1 = addCatchment(doc, st.key, { polygon: rect(139.003, 34.995, 139.017, 35.005) });
  return { doc, st, e1, p1, z1, w1, c1 };
};
const buildDoc = (doc, extra = {}) => buildStationDemandAccessExport({ pack, mapExport: scratch, stations: activeStations(doc).map(toDrawnStation), spatial: withLayers, ...extra });

test("the editor hands out keys that are never reused, and ids follow keys", () => {
  const { doc, st, e1, p1 } = docWith();
  assert.equal(st.key, "access-1");
  assert.equal(e1.key, "entrance-1");
  assert.equal(p1.key, "access-point-1");
  const before = buildDoc(doc).sites[0];
  removeElement(doc, st.key, "entrance", e1.key);
  const e2 = addEntrance(doc, st.key, { location: [139.0102, 35.0002] });
  assert.equal(e2.key, "entrance-2", "a removed key is never handed out again");
  const after = buildDoc(doc).sites[0];
  assert.equal(after.stationAccessId, before.stationAccessId);
  assert.notEqual(after.entrances[0].entranceId, before.entrances[0].entranceId);
  removeStation(doc, st.key);
  assert.equal(addStation(doc, {}).key, "access-2", "removed stations keep their key too");
  assert.deepEqual(activeStations(doc).map((s) => s.key), ["access-2"]);
  restoreStation(doc, st.key);
  assert.equal(buildDoc(doc).sites.length, 1, "access-2 has no place and is not built");
  assert.equal(addStation(doc, { key: "example:x:station" }).key, "example:x:station", "a caller's own key is kept");
  assert.throws(() => addStation(doc, { key: "example:x:station" }), /already used/);
  assert.throws(() => addElement(doc, st.key, "teleporter", {}), /Unknown element type/);
  assert.throws(() => addEntrance(doc, "access-9", {}), /Unknown station access/);
});

test("the player can redraw the access boundary vertex by vertex, and its id stays", () => {
  const { doc, st, c1 } = docWith();
  const first = buildDoc(doc).sites[0].catchments[0];
  moveVertex(doc, st.key, "catchment", c1.key, 1, [139.02, 34.995]);
  insertVertex(doc, st.key, "catchment", c1.key, 2, [139.019, 35.001]);
  const redrawn = buildDoc(doc).sites[0].catchments[0];
  assert.equal(redrawn.catchmentId, first.catchmentId);
  assert.notEqual(redrawn.areaSquareMeters, first.areaSquareMeters);
  removeVertex(doc, st.key, "catchment", c1.key, 2);
  assert.equal(doc.stations[0].catchments[0].polygon.length, 5);
  while (doc.stations[0].catchments[0].polygon.length > 3) removeVertex(doc, st.key, "catchment", c1.key, 0);
  assert.throws(() => removeVertex(doc, st.key, "catchment", c1.key, 0), /at least three/);
  assert.throws(() => moveVertex(doc, st.key, "catchment", c1.key, 9, S1), /No vertex/);
  assert.throws(() => moveVertex(doc, st.key, "entrance", "entrance-1", 0, S1), /no polygon/);
  updateElement(doc, st.key, "catchment", c1.key, { polygon: rect(139.003, 34.995, 139.017, 35.005), name: "again", key: "hijack" });
  assert.equal(doc.stations[0].catchments[0].key, c1.key, "a key cannot be changed");
});

test("the player can redraw the walking links; a removed element leaves its links as warnings, nothing vanishes", () => {
  const { doc, st, e1, p1, w1 } = docWith();
  const before = buildDoc(doc).sites[0].walkLinks[0];
  setWalkLinkVia(doc, st.key, w1.key, [[139.0108, 35.0006]]);
  const bent = buildDoc(doc).sites[0].walkLinks[0];
  assert.equal(bent.walkLinkId, before.walkLinkId);
  assert.ok(bent.lengthMeters > before.lengthMeters);
  setWalkLinkEnds(doc, st.key, w1.key, { to: { kind: "station" } });
  assert.equal(buildDoc(doc).sites[0].walkLinks[0].to.kind, "station");
  setWalkLinkEnds(doc, st.key, w1.key, { to: { kind: "access-point", key: p1.key } });
  assert.deepEqual(referencesTo(doc, st.key, "entrance", e1.key), [{ type: "walk-link", key: w1.key }]);
  moveElement(doc, st.key, "access-point", p1.key, [139.0102, 35.0016]);
  assert.ok(buildDoc(doc).sites[0].walkLinks[0].straightDistanceMeters > before.straightDistanceMeters);
  removeElement(doc, st.key, "entrance", e1.key);
  const site = buildDoc(doc).sites[0];
  assert.deepEqual(site.walkLinks, []);
  assert.deepEqual(site.warnings.map((w) => w.code), ["walk-link-endpoint-missing"]);
  assert.equal(doc.stations[0].walkLinks.length, 1, "the document still holds what the player drew");
  removeElement(doc, st.key, "walk-link", w1.key);
  assert.throws(() => removeElement(doc, st.key, "walk-link", w1.key), /Unknown walk-link/);
});

test("moving or turning a station takes everything it holds along, and keeps every id", () => {
  const { doc, st } = docWith();
  setTransfer(doc, st.key, "d1", [[139.012, 35.001]], { widthMeters: 2.5 });
  addEntrance(doc, st.key, { location: [139.0098, 34.9997] });
  const before = buildDoc(doc, { mapExport: existing }).sites[0];
  const ids = (s) => [s.stationAccessId, ...s.entrances.map((e) => e.entranceId), ...s.walkLinks.map((l) => l.walkLinkId), ...s.catchments.map((c) => c.catchmentId), ...s.demandZones.map((z) => z.demandZoneId)];
  moveStation(doc, st.key, 0.0001, -0.0001);
  const moved = buildDoc(doc, { mapExport: existing }).sites[0];
  assert.deepEqual(ids(moved), ids(before));
  assert.equal(moved.entrances[0].location[0], Math.round((before.entrances[0].location[0] + 0.0001) * 1e6) / 1e6);
  assert.deepEqual(doc.stations[0].transfers[0].via[0].map((v) => Math.round(v * 1e6) / 1e6), [139.0121, 35.0009]);
  rotateStation(doc, st.key, 90, S1);
  const turned = buildDoc(doc, { mapExport: existing }).sites[0];
  assert.deepEqual(ids(turned), ids(before));
  assert.ok(Math.abs(turned.walkLinks[0].lengthMeters - moved.walkLinks[0].lengthMeters) < 1, "a turn keeps lengths");
  clearTransfer(doc, st.key, "d1");
  assert.deepEqual(doc.stations[0].transfers, []);
  assert.equal(updateStation(doc, st.key, { name: "Renamed", key: "other" }).key, st.key);
});

test("save and restore give the same document and the same bytes of output", () => {
  const { doc } = docWith();
  setTransfer(doc, "access-1", "d1", [[139.012, 35.001]]);
  const text = serializeStationDemandAccessDoc(doc);
  const { doc: restored, warnings } = restoreStationDemandAccessDoc(text, pack);
  assert.deepEqual(warnings, []);
  assert.equal(restored.version, STATION_DEMAND_ACCESS_DOC_VERSION);
  assert.equal(serializeStationDemandAccessDoc(restored), text);
  assert.equal(JSON.stringify(buildDoc(restored, { mapExport: existing })), JSON.stringify(buildDoc(doc, { mapExport: existing })));
  addEntrance(restored, "access-1", { location: S1 });
  assert.equal(addEntrance(doc, "access-1", { location: S1 }).key, "entrance-2", "the key counter survives a save");
  assert.equal(restoreStationDemandAccessDoc(null, pack).doc.stations.length, 0);
});

test("a saved document of another pack, version or shape is refused and the current document is untouched", () => {
  const { doc } = docWith();
  const text = serializeStationDemandAccessDoc(doc);
  const other = restoreStationDemandAccessDoc(text, { manifest: { id: "other", version: "1" } });
  assert.deepEqual(other.warnings.map((w) => w.code), ["station-demand-access-doc-other-pack"]);
  assert.deepEqual(other.doc.stations, []);
  assert.equal(other.doc.packId, "other");
  assert.deepEqual(restoreStationDemandAccessDoc("{nope", pack).warnings.map((w) => w.code), ["station-demand-access-doc-unreadable"]);
  assert.deepEqual(restoreStationDemandAccessDoc(JSON.stringify({ ...JSON.parse(text), version: 2 }), pack).warnings.map((w) => w.code), ["station-demand-access-doc-version"]);
  assert.deepEqual(restoreStationDemandAccessDoc(JSON.stringify({ version: 1, packId: "t", stations: [{ name: "no key" }] }), pack).warnings.map((w) => w.code), ["station-demand-access-doc-version"]);
  const newer = restoreStationDemandAccessDoc(text, { manifest: { id: "t", version: "2" } });
  assert.deepEqual(newer.warnings.map((w) => w.code), ["pack-version-mismatch"]);
  assert.equal(newer.doc.stations.length, 1, "a version change is reported, not hidden, and the drawing is kept");
  assert.equal(doc.stations.length, 1);
});

// --- shipped examples ---
const exampleDir = (id) => path.join(root, "packs", id, "station-demand-access-examples");
const readExamples = (id) => fs.readdirSync(exampleDir(id)).filter((f) => f.endsWith(".station-demand-access.json")).sort().map((f) => ({ file: f, site: JSON.parse(fs.readFileSync(path.join(exampleDir(id), f), "utf8")) }));

test("shipped examples follow the contract, say how they were made, and never carry a pack figure", () => {
  for (const id of ["example-radial", "example-corridor", "tokyo"]) {
    const examples = readExamples(id);
    assert.ok(examples.length >= 2, id);
    for (const { file, site } of examples) {
      const { source, ...body } = site;
      assert.equal(body.schema, STATION_DEMAND_ACCESS_SCHEMA, file);
      assert.equal(body.sourcePackId, id);
      assert.equal(source.generatedBy, "scripts/build-station-demand-access-examples.mjs");
      assert.ok(Array.isArray(source.case) && source.case.length, file);
      assert.equal(typeof source.layers.kind, "string");
      assertUnknownContract(body);
      assert.equal(/"(residents|jobs|workers|passengers|fare|score)"\s*:/.test(JSON.stringify(body)), false, file);
    }
  }
});

test("the generator reproduces every shipped example byte for byte", () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "station-demand-access-examples-"));
  const run = spawnSync(process.execPath, [path.join(root, "scripts", "build-station-demand-access-examples.mjs"), "--out", out], { cwd: root, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  for (const id of ["example-radial", "example-corridor", "tokyo"]) {
    const shipped = fs.readdirSync(exampleDir(id)).sort();
    assert.deepEqual(fs.readdirSync(path.join(out, id)).sort(), shipped);
    for (const f of shipped) assert.equal(fs.readFileSync(path.join(out, id, f), "utf8"), fs.readFileSync(path.join(exampleDir(id), f), "utf8"), `${id}/${f}`);
  }
  fs.rmSync(out, { recursive: true, force: true });
});
