import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { haversineMetres } from "../src/projection.mjs";
import { buildMapExport } from "../src/map/plan-geometry.mjs";
import { makeSpatialContext, polygonLayer } from "../src/map/spatial.mjs";
import { buildStationDemandAccessExport } from "../src/map/station-demand-access.mjs";
import { STATION_DEMAND_ACCESS_EXPORT_SCHEMA } from "../src/station-demand-access-assessment.mjs";
import {
  STATION_DEMAND_WALKING_ACCESS_SCHEMA, WALKING_MODEL, buildStationDemandWalkingAccess, normalizeWalkingPolicy, walkMinutesOf,
} from "../src/station-demand-walking-model.mjs";

const SITE_SCHEMA = "transitline.station-demand-access-geometry/1";
const pack = { manifest: { id: "t", version: "1", data: { license: "CC0-1.0", attribution: [] } }, demand: { points: [] } };
const deepFreeze = (o) => { if (o && typeof o === "object") { Object.values(o).forEach(deepFreeze); Object.freeze(o); } return o; };

// --- hand-made sites: every case below states exactly the facts it needs ---
const CLEAR = { river: 0, road: 0, railway: 0, building: 0, utility: null };
const STATION = { kind: "station", id: "stn:A" };
const ENT = { kind: "entrance", id: "ent:1" };
const AP = { kind: "access-point", id: "ap:1" };
const ZONE = { kind: "demand-zone", id: "zone:1" };
const here = [139.01, 35];
function link(walkLinkId, from, to, lengthMeters, over = {}) {
  return { walkLinkId, from, to, alignment: [here, [139.011, 35]], lengthMeters, straightDistanceMeters: lengthMeters, widthMeters: null, crossings: { ...CLEAR }, unknown: [], unknownReasons: {}, ...over };
}
function makeSite(over = {}) {
  return {
    schema: SITE_SCHEMA, contractVersion: 1, stationAccessId: "stn:A", stationAccessRevision: "rev:A1", sourcePackId: "t", sourcePackVersion: "1",
    location: here, connectedPlanId: "plan:1", connectedStationId: "st:1",
    entrances: [{ entranceId: "ent:1", location: [139.0102, 35.0002], insideBuildingCount: 0, insideWaterCount: 0 }],
    accessPoints: [{ accessPointId: "ap:1", location: [139.0105, 35.001], insideBuildingCount: 0, insideWaterCount: 0, drawnConnection: { connected: true } }],
    demandZones: [{ demandZoneId: "zone:1", centroid: [139.011, 35.002], drawnConnection: { connected: true }, demandNodeRefs: [{ demandNodeId: "n1", location: [139.011, 35.002] }] }],
    walkLinks: [link("walk:1", ENT, AP, 100), link("walk:2", AP, ZONE, 200)],
    transfers: [],
    ...over,
  };
}
const makeAccess = (sites = [makeSite()], over = {}) => ({ schema: STATION_DEMAND_ACCESS_EXPORT_SCHEMA, packId: "t", packVersion: "1", sites, catchmentOverlaps: [], inactive: [], warnings: [], ...over });
const run = (sites, options = {}) => buildStationDemandWalkingAccess({ stationDemandAccess: makeAccess(sites), pack, ...options });
const one = (site, options) => run([site], options);
const linkOf = (result, id) => result.links.find((l) => l.walkLinkId === id);
const zonePath = (result) => result.paths.find((p) => p.subject.id === "zone:1");
const apPath = (result) => result.paths.find((p) => p.subject.id === "ap:1");
const withLinks = (links, extra = {}) => makeSite({ walkLinks: links, ...extra });
const bareZone = (connected, refs = []) => [{ demandZoneId: "zone:1", centroid: [139.011, 35.002], drawnConnection: { connected }, demandNodeRefs: refs }];
const transfer = (over = {}) => ({
  transferId: "xfer:1", basis: "player-passage", targetStationId: "other:1", targetKind: "plan", targetNetworkId: "plan:2", targetLocationBasis: "player-placed",
  from: STATION, alignment: [here, [139.012, 35]], straightDistanceMeters: 150, passageLengthMeters: 180, widthMeters: 4, crossings: { ...CLEAR }, unknownReasons: {}, ...over,
});

// --- time ---
test("minutes are max(1, round(meters / 80)) for a measured length and nothing else", () => {
  const table = [[0, 1], [1, 1], [39.9, 1], [40, 1], [119.9, 1], [120, 2], [400, 5], [1000, 13], [1234, 15]];
  for (const [meters, minutes] of table) assert.equal(walkMinutesOf(meters), minutes, `${meters} m`);
  for (const bad of [null, undefined, NaN, Infinity, -1, "100", {}]) assert.equal(walkMinutesOf(bad), null, String(bad));
  assert.equal(WALKING_MODEL.metersPerMinute, 80);
  assert.equal(WALKING_MODEL.estimateDetourFactor, 1.3);
});

test("a drawn path takes its minutes from the total length, not from the sum of per-link rounding", () => {
  const result = one(withLinks([link("walk:1", ENT, AP, 30), link("walk:2", AP, ZONE, 30)], { demandZones: bareZone(true) }));
  assert.equal(zonePath(result).meters, 60);
  assert.equal(zonePath(result).walkMinutes, 1);
  assert.equal(linkOf(result, "walk:1").walkMinutes + linkOf(result, "walk:2").walkMinutes, 2, "the links alone would round up to 2");
  const long = one(withLinks([link("walk:1", ENT, AP, 500), link("walk:2", AP, ZONE, 500)]));
  assert.equal(zonePath(long).walkMinutes, 13, "1000 m");
});

test("the measured drawn length is the only length used, and the zone residual is its own unscaled component", () => {
  const node = [139.0113, 35.0022];
  const result = one(makeSite({ demandZones: bareZone(true, [{ demandNodeId: "n1", location: node }]) }));
  const residual = Math.round(haversineMetres([139.011, 35.002], node) * 10) / 10;
  const record = result.nodes[0];
  assert.deepEqual(record.components, [{ kind: "drawn-path", meters: 300, linkIds: ["walk:1", "walk:2"] }, { kind: "zone-residual-straight", meters: residual }]);
  assert.equal(record.meters, Math.round((300 + residual) * 10) / 10);
  assert.equal(record.walkMinutes, walkMinutesOf(record.meters));
  assert.equal(record.estimated, false);
  assert.equal(record.status, "usable");
});

test("width never changes a time", () => {
  const minutes = (width) => zonePath(one(withLinks([link("walk:1", ENT, AP, 100, { widthMeters: width }), link("walk:2", AP, ZONE, 200, { widthMeters: width })]))).walkMinutes;
  assert.equal(minutes(null), minutes(1));
  assert.equal(minutes(1), minutes(12));
  const result = one(withLinks([link("walk:1", ENT, AP, 100, { widthMeters: 0 })]));
  assert.equal(linkOf(result, "walk:1").widthMeters, null);
  assert.ok(linkOf(result, "walk:1").flags.includes("width-invalid"));
  assert.equal(linkOf(result, "walk:1").walkMinutes, 1);
});

// --- null, false, 0 ---
test("a measured 0 m link is a fact (1 minute floor); a null length is unknown and never becomes 0", () => {
  const zero = one(withLinks([link("walk:1", ENT, AP, 0)]));
  assert.equal(linkOf(zero, "walk:1").status, "usable");
  assert.equal(linkOf(zero, "walk:1").meters, 0);
  assert.equal(linkOf(zero, "walk:1").walkMinutes, 1);
  assert.ok(linkOf(zero, "walk:1").flags.includes("zero-length-drawn"));
  for (const missing of [null, undefined, NaN, -5, "12"]) {
    const result = one(withLinks([link("walk:1", ENT, AP, missing)]));
    const l = linkOf(result, "walk:1");
    assert.equal(l.status, "unknown");
    assert.equal(l.meters, null);
    assert.equal(l.walkMinutes, null);
    assert.deepEqual(l.reasons, ["length-unmeasured"]);
    assert.equal(l.acknowledgeable, false, "an unmeasured length cannot be confirmed into existence");
    assert.equal(apPath(result).meters, null);
    assert.equal(apPath(result).walkMinutes, null);
  }
});

test("not drawn (false), unknown (null) and measured zero are three different path states", () => {
  const notDrawn = one(withLinks([], { demandZones: bareZone(false) }));
  assert.equal(zonePath(notDrawn).status, "not-drawn");
  assert.equal(zonePath(notDrawn).mapReportedConnection, false);
  assert.equal(zonePath(notDrawn).meters, null);
  assert.deepEqual(zonePath(notDrawn).reasons, ["no-walk-link-drawn"]);
  const unknown = one(withLinks([link("walk:1", ENT, ZONE, null)], { demandZones: bareZone(true) }));
  assert.equal(zonePath(unknown).status, "unknown");
  assert.equal(zonePath(unknown).mapReportedConnection, true);
  const zero = one(withLinks([link("walk:1", ENT, ZONE, 0)], { demandZones: bareZone(true) }));
  assert.equal(zonePath(zero).status, "usable");
  assert.equal(zonePath(zero).meters, 0);
  assert.equal(zonePath(zero).walkMinutes, 1);
  const absent = one(withLinks([], { demandZones: [{ demandZoneId: "zone:1", centroid: [139.011, 35.002], demandNodeRefs: [] }] }));
  assert.equal(zonePath(absent).mapReportedConnection, null, "a missing connection fact is null, not false");
});

// --- estimate ---
test("no straight-line estimate unless the policy asks; the default is none", () => {
  const site = withLinks([], { demandZones: [{ demandZoneId: "zone:1", centroid: [139.012, 35.002], drawnConnection: { connected: false }, demandNodeRefs: [{ demandNodeId: "n1", location: [139.012, 35.002] }] }] });
  for (const policy of [undefined, null, {}, { walkEstimate: "none" }]) {
    const result = one(site, { policy });
    assert.equal(result.policy.walkEstimate, "none");
    assert.equal(zonePath(result).status, "not-drawn");
    assert.equal(zonePath(result).usable, false);
    assert.equal(result.nodes[0].status, "not-drawn");
    assert.equal(result.nodes[0].walkMinutes, null);
  }
});

test("an explicitly allowed estimate is straight distance x 1.3, flagged, and measured from the node itself", () => {
  const nodeAt = [139.012, 35.002];
  const site = withLinks([], { demandZones: [{ demandZoneId: "zone:1", centroid: [139.013, 35.003], drawnConnection: { connected: false }, demandNodeRefs: [{ demandNodeId: "n1", location: nodeAt }] }] });
  const result = one(site, { policy: { walkEstimate: "straight-line" } });
  const anchors = [here, [139.0102, 35.0002]];
  const straight = Math.round(Math.min(...anchors.map((a) => haversineMetres(nodeAt, a))) * 10) / 10;
  const node = result.nodes[0];
  assert.equal(node.status, "estimated");
  assert.equal(node.usable, true);
  assert.equal(node.estimated, true);
  assert.equal(node.meters, Math.round(straight * 1.3 * 10) / 10);
  assert.equal(node.walkMinutes, walkMinutesOf(node.meters));
  assert.deepEqual(node.components, [{ kind: "straight-line-estimate", straightMeters: straight, detourFactor: 1.3, meters: node.meters }]);
  assert.ok(node.flags.includes("barriers-not-checked"));
  assert.equal(zonePath(result).status, "estimated");
});

test("an estimate never replaces a blocked or unconfirmed drawn path", () => {
  const blocked = withLinks([link("walk:1", ENT, ZONE, 100, { crossings: { ...CLEAR, river: 1 } })]);
  const result = one(blocked, { policy: { walkEstimate: "straight-line" } });
  assert.equal(zonePath(result).status, "blocked");
  assert.equal(zonePath(result).estimated, false);
  assert.equal(result.nodes[0].usable, false);
  assert.equal(result.nodes[0].walkMinutes, null);
  const unmeasured = withLinks([link("walk:1", ENT, ZONE, 100, { crossings: { ...CLEAR, building: null }, unknownReasons: { "crossings.building": "no-layer" } })]);
  const second = one(unmeasured, { policy: { walkEstimate: "straight-line" } });
  assert.equal(zonePath(second).status, "unknown");
  assert.equal(zonePath(second).estimated, false);
});

test("a drawn path wins over the estimate even when the policy allows one", () => {
  const result = one(makeSite(), { policy: { walkEstimate: "straight-line" } });
  assert.equal(zonePath(result).status, "usable");
  assert.equal(zonePath(result).estimated, false);
  assert.equal(zonePath(result).meters, 300);
});

// --- barriers ---
test("a link across a river, railway or building is blocked with a named reason, never assumed safe", () => {
  for (const kind of ["river", "railway", "building"]) {
    const result = one(withLinks([link("walk:1", ENT, AP, 100, { crossings: { ...CLEAR, [kind]: 2 } })]));
    const l = linkOf(result, "walk:1");
    assert.equal(l.status, "blocked", kind);
    assert.equal(l.usable, false);
    assert.deepEqual(l.reasons, [`crosses-${kind}`]);
    assert.equal(l.barrier[kind].state, "crossed");
    assert.equal(l.barrier[kind].count, 2);
    assert.equal(l.acknowledgeable, true);
    assert.equal(apPath(result).status, "blocked");
    assert.equal(apPath(result).walkMinutes, null);
    assert.deepEqual(apPath(result).acknowledgeLinkIds, ["walk:1"]);
  }
});

test("a missing layer is unknown (not blocked), a measured 0 is clear, and the two are never merged", () => {
  const unknown = one(withLinks([link("walk:1", ENT, AP, 100, { crossings: { ...CLEAR, river: null }, unknownReasons: { "crossings.river": "outside-coverage" } })]));
  const l = linkOf(unknown, "walk:1");
  assert.equal(l.status, "unknown");
  assert.deepEqual(l.reasons, ["barrier-unmeasured:river:outside-coverage"]);
  assert.equal(l.barrier.river.state, "unmeasured");
  assert.equal(l.barrier.river.count, null);
  assert.equal(l.barrier.railway.state, "clear");
  assert.equal(l.barrier.railway.count, 0);
  assert.equal(l.meters, 100, "the length is still measured");
  const absent = one(withLinks([link("walk:1", ENT, AP, 100, { crossings: undefined })]));
  assert.deepEqual([...linkOf(absent, "walk:1").reasons].sort(), ["barrier-unmeasured:building:not-in-export", "barrier-unmeasured:railway:not-in-export", "barrier-unmeasured:river:not-in-export"]);
  const mixed = one(withLinks([link("walk:1", ENT, AP, 100, { crossings: { ...CLEAR, river: 1, building: null }, unknownReasons: { "crossings.building": "no-layer" } })]));
  assert.equal(linkOf(mixed, "walk:1").status, "blocked", "a known crossing outranks an unmeasured layer");
  assert.equal(linkOf(mixed, "walk:1").reasons.length, 2);
});

test("a player-acknowledged link becomes usable and says so; an unmeasured layer can also be accepted by policy, a known crossing cannot", () => {
  const blocked = withLinks([link("walk:1", ENT, AP, 100, { crossings: { ...CLEAR, river: 1 } }), link("walk:2", AP, ZONE, 100, { crossings: { ...CLEAR, building: null }, unknownReasons: { "crossings.building": "no-layer" } })]);
  const acknowledged = one(blocked, { policy: { acknowledgedWalkLinkIds: ["walk:1", "walk:2"] } });
  assert.equal(linkOf(acknowledged, "walk:1").status, "usable");
  assert.equal(linkOf(acknowledged, "walk:1").acknowledged, true);
  assert.deepEqual(linkOf(acknowledged, "walk:1").flags, ["acknowledged:crosses-river"]);
  assert.equal(zonePath(acknowledged).status, "usable");
  assert.equal(zonePath(acknowledged).walkMinutes, 3);
  const accepted = one(blocked, { policy: { acceptUnmeasuredLayers: true } });
  assert.equal(linkOf(accepted, "walk:1").status, "blocked", "layer acceptance never clears a known crossing");
  assert.equal(linkOf(accepted, "walk:2").status, "usable");
  assert.deepEqual(linkOf(accepted, "walk:2").flags, ["accepted:barrier-unmeasured:building:no-layer"]);
  const stray = one(blocked, { policy: { acknowledgedWalkLinkIds: ["walk:nope"] } });
  assert.ok(stray.warnings.some((w) => w.code === "acknowledged-link-not-in-map" && w.walkLinkId === "walk:nope"));
});

test("a link ending in water is blocked and cannot be acknowledged; ending inside a building is only a flag", () => {
  const inWater = [{ accessPointId: "ap:1", location: [139.0105, 35.001], insideBuildingCount: 0, insideWaterCount: 1, drawnConnection: { connected: true } }];
  const result = one(withLinks([link("walk:1", ENT, AP, 100)], { accessPoints: inWater }), { policy: { acknowledgedWalkLinkIds: ["walk:1"] } });
  assert.equal(linkOf(result, "walk:1").status, "blocked");
  assert.deepEqual(linkOf(result, "walk:1").reasons, ["endpoint-in-water:ap:1"]);
  assert.equal(linkOf(result, "walk:1").acknowledgeable, false);
  const inBuilding = [{ accessPointId: "ap:1", location: [139.0105, 35.001], insideBuildingCount: 3, insideWaterCount: 0, drawnConnection: { connected: true } }];
  const building = one(withLinks([link("walk:1", ENT, AP, 100)], { accessPoints: inBuilding }));
  assert.equal(linkOf(building, "walk:1").status, "usable");
  assert.deepEqual(linkOf(building, "walk:1").flags, ["endpoint-inside-building:ap:1"]);
});

test("a blocked shortcut does not hide a usable longer route, and the shortest usable path wins", () => {
  const site = withLinks([link("walk:a", ENT, ZONE, 50, { crossings: { ...CLEAR, river: 1 } }), link("walk:b", ENT, AP, 100), link("walk:c", AP, ZONE, 120)]);
  const result = one(site);
  assert.equal(zonePath(result).status, "usable");
  assert.equal(zonePath(result).meters, 220);
  assert.deepEqual(zonePath(result).linkIds, ["walk:b", "walk:c"]);
  const shorter = one(withLinks([link("walk:a", ENT, ZONE, 50), link("walk:b", ENT, AP, 100), link("walk:c", AP, ZONE, 120)]));
  assert.deepEqual(zonePath(shorter).linkIds, ["walk:a"]);
});

// --- broken / stale ---
test("a broken endpoint, a deleted target or a bad alignment is never usable", () => {
  const result = one(withLinks([
    link("walk:gone", { kind: "entrance", id: "ent:deleted" }, AP, 100),
    link("walk:same", AP, AP, 100),
    link("walk:flat", ENT, ZONE, 100, { alignment: [here] }),
    link("walk:kind", { kind: "pier", id: "x" }, AP, 100),
  ]));
  assert.equal(linkOf(result, "walk:gone").status, "broken");
  assert.deepEqual(linkOf(result, "walk:gone").reasons, ["endpoint-missing:from"]);
  assert.deepEqual(linkOf(result, "walk:same").reasons, ["endpoints-identical"]);
  assert.deepEqual(linkOf(result, "walk:flat").reasons, ["alignment-invalid"]);
  assert.deepEqual(linkOf(result, "walk:kind").reasons, ["endpoint-missing:from"]);
  for (const l of result.links) { assert.equal(l.usable, false); assert.equal(l.acknowledgeable, false); }
  // a broken link is not routed through, and a path the map still reports as drawn is broken, not "not drawn"
  assert.equal(zonePath(result).status, "broken");
  assert.deepEqual(zonePath(result).reasons, ["drawn-path-has-broken-link"]);
  assert.equal(zonePath(result).mapReportedConnection, true);
  assert.equal(result.nodes[0].usable, false);
});

test("a stale map revision, another pack or an invalid site schema makes everything unusable", () => {
  const site = withLinks([link("walk:1", ENT, AP, 100), link("walk:2", AP, ZONE, 200)], { transfers: [transfer()] });
  const current = one(site, { expectedRevisions: { "stn:A": "rev:A1" } });
  assert.equal(current.sites[0].status, "current");
  assert.equal(zonePath(current).usable, true);
  const stale = one(site, { expectedRevisions: { "stn:A": "rev:OLD" }, policy: { walkEstimate: "straight-line", acknowledgedWalkLinkIds: ["walk:1"] } });
  assert.equal(stale.sites[0].status, "stale");
  assert.deepEqual(stale.sites[0].reasons, ["stale-map-revision"]);
  for (const record of [...stale.links, ...stale.paths, ...stale.nodes, ...stale.transfers]) { assert.equal(record.status, "stale"); assert.equal(record.usable, false); }
  assert.equal(stale.nodes[0].walkMinutes, null);
  assert.equal(stale.links[0].meters, 100, "measured facts stay visible");
  const other = one(makeSite({ sourcePackVersion: "2" }));
  assert.equal(other.sites[0].status, "stale");
  assert.deepEqual(other.sites[0].reasons, ["site-pack-mismatch"]);
  const invalid = one(makeSite({ schema: "wrong" }));
  assert.equal(invalid.sites[0].status, "broken");
  assert.equal(invalid.nodes[0].usable, false);
});

test("an expected station that vanished from the export is reported, not silently ignored", () => {
  const result = one(makeSite(), { expectedRevisions: { "stn:A": "rev:A1", "stn:gone": "rev:x" } });
  assert.deepEqual(result.warnings.filter((w) => w.code === "expected-station-missing"), [{ code: "expected-station-missing", stationAccessId: "stn:gone" }]);
  assert.equal(result.sites.length, 1);
});

// --- transfers ---
test("a transfer passage is its own fact: measured, timed apart, and explicitly not for demand allocation", () => {
  const without = one(makeSite());
  const result = one(makeSite({ transfers: [transfer()] }));
  const t = result.transfers[0];
  assert.equal(t.status, "usable");
  assert.equal(t.meters, 180);
  assert.equal(t.passageWalkMinutes, 2);
  assert.equal(t.usedForDemandAllocation, false);
  assert.equal(t.widthMeters, 4);
  assert.equal("walkMinutes" in t, false, "named differently so it cannot be mistaken for an access time");
  // nothing about access changes when a transfer is added or removed
  for (const key of ["links", "paths", "nodes"]) assert.equal(JSON.stringify(result[key]), JSON.stringify(without[key]), key);
  for (const record of [...result.paths, ...result.nodes]) assert.ok(!JSON.stringify(record).includes("xfer:1"));
});

test("a nearby (not drawn) transfer has no passage; only an explicit policy estimates it; width changes nothing", () => {
  const nearby = transfer({ basis: "nearby", alignmentBasis: "straight", straightDistanceMeters: 300, passageLengthMeters: 300 });
  const plain = one(makeSite({ transfers: [nearby] })).transfers[0];
  assert.equal(plain.status, "not-drawn");
  assert.equal(plain.usable, false);
  assert.equal(plain.meters, null);
  assert.equal(plain.straightMeters, 300);
  assert.equal(plain.passageWalkMinutes, null);
  assert.deepEqual(plain.reasons, ["no-passage-drawn"]);
  const estimated = one(makeSite({ transfers: [nearby] }), { policy: { walkEstimate: "straight-line" } }).transfers[0];
  assert.equal(estimated.status, "estimated");
  assert.equal(estimated.meters, 390);
  assert.equal(estimated.passageWalkMinutes, 5);
  assert.ok(estimated.flags.includes("straight-line-estimate"));
  const minutesAt = (widthMeters) => one(makeSite({ transfers: [transfer({ widthMeters })] })).transfers[0].passageWalkMinutes;
  assert.equal(minutesAt(1), minutesAt(40));
});

test("a transfer to a coarse (ward-centroid) station, across a barrier, or to a deleted target is not usable", () => {
  const coarse = one(makeSite({ transfers: [transfer({ targetLocationBasis: "demand-node" })] })).transfers[0];
  assert.equal(coarse.status, "unknown");
  assert.deepEqual(coarse.reasons, ["target-location-coarse"]);
  assert.equal(coarse.passageWalkMinutes, null);
  const river = transfer({ crossings: { ...CLEAR, river: 1 } });
  const blocked = one(makeSite({ transfers: [river] })).transfers[0];
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.acknowledgeable, true);
  assert.equal(one(makeSite({ transfers: [river] }), { policy: { acknowledgedTransferIds: ["xfer:1"] } }).transfers[0].status, "usable");
  assert.equal(one(makeSite({ transfers: [river] }), { policy: { acknowledgedWalkLinkIds: ["xfer:1"] } }).transfers[0].status, "blocked", "a walk-link acknowledgement does not cover a transfer");
  const deleted = one(makeSite({ transfers: [transfer()] }), { knownTargetStationIds: ["somebody:else"] }).transfers[0];
  assert.equal(deleted.status, "broken");
  assert.deepEqual(deleted.reasons, ["transfer-target-missing"]);
  assert.equal(one(makeSite({ transfers: [transfer()] }), { knownTargetStationIds: ["other:1"] }).transfers[0].status, "usable");
  assert.deepEqual(one(makeSite({ transfers: [transfer({ from: { kind: "entrance", id: "ent:deleted" } })] })).transfers[0].reasons, ["transfer-entrance-missing"]);
  const noLength = one(makeSite({ transfers: [transfer({ passageLengthMeters: null })] })).transfers[0];
  assert.equal(noLength.status, "unknown");
  assert.equal(noLength.meters, null);
  assert.equal(noLength.acknowledgeable, false);
});

// --- ids, shape, determinism, immutability ---
test("ids are stable and centred on station / node / link: a node keeps one record per zone it sits in", () => {
  const second = { demandZoneId: "zone:2", centroid: [139.0112, 35.0021], drawnConnection: { connected: true }, demandNodeRefs: [{ demandNodeId: "n1", location: [139.0112, 35.0021] }] };
  const site = makeSite({ demandZones: [makeSite().demandZones[0], second], walkLinks: [link("walk:1", ENT, AP, 100), link("walk:2", AP, ZONE, 200), link("walk:3", AP, { kind: "demand-zone", id: "zone:2" }, 90)] });
  const result = one(site);
  assert.equal(result.nodes.length, 2);
  assert.equal(new Set(result.nodes.map((n) => n.nodeAccessId)).size, 2);
  assert.ok(result.nodes.every((n) => n.demandNodeId === "n1" && n.stationAccessId === "stn:A" && n.pathId.startsWith("walk-path:")));
  assert.ok(result.nodes.every((n) => /^walk-node:[0-9a-f]{16}$/.test(n.nodeAccessId)));
  assert.deepEqual(result.links.map((l) => l.walkLinkId), ["walk:1", "walk:2", "walk:3"], "the map's walkLinkId is kept as is");
  assert.deepEqual(result.nodes.map((n) => n.pathId).sort(), result.paths.filter((p) => p.subject.kind === "demand-zone").map((p) => p.pathId).sort());
  assert.deepEqual(one(structuredClone(site)).nodes.map((n) => n.nodeAccessId), result.nodes.map((n) => n.nodeAccessId));
});

test("a zone without supplied demand nodes yields a path and a warning, not invented nodes", () => {
  const result = one(makeSite({ demandZones: [{ demandZoneId: "zone:1", centroid: [139.011, 35.002], drawnConnection: { connected: true }, demandNodeRefs: null }] }));
  assert.equal(result.nodes.length, 0);
  assert.equal(zonePath(result).usable, true);
  assert.ok(result.warnings.some((w) => w.code === "zone-demand-nodes-not-supplied"));
});

test("same input gives byte-identical output whatever the order of sites, links, zones and transfers", () => {
  const a = makeSite({ stationAccessId: "stn:A", transfers: [transfer({ transferId: "xfer:1" }), transfer({ transferId: "xfer:2", targetStationId: "other:2" })] });
  const b = makeSite({ stationAccessId: "stn:B", stationAccessRevision: "rev:B1", walkLinks: [link("walk:b1", { kind: "station", id: "stn:B" }, AP, 70)], entrances: [] });
  const forward = run([a, b], { policy: { acknowledgedWalkLinkIds: ["walk:2", "walk:1"] } });
  const shuffled = structuredClone([b, a]);
  shuffled[1].walkLinks.reverse();
  shuffled[1].transfers.reverse();
  const backward = run(shuffled, { policy: { acknowledgedWalkLinkIds: ["walk:1", "walk:2", "walk:1"] } });
  assert.equal(JSON.stringify(forward), JSON.stringify(backward));
  assert.equal(JSON.stringify(run([a, b])), JSON.stringify(run([a, b])));
  assert.equal(forward.schema, STATION_DEMAND_WALKING_ACCESS_SCHEMA);
  assert.deepEqual(forward.sites.map((s) => s.stationAccessId), ["stn:A", "stn:B"]);
});

test("inputs are never mutated and the result shares no objects with them", () => {
  const access = deepFreeze(makeAccess([makeSite({ transfers: [transfer()] })]));
  const policy = deepFreeze({ walkEstimate: "straight-line", acknowledgedWalkLinkIds: ["walk:1"], acknowledgedTransferIds: [], acceptUnmeasuredLayers: false });
  const result = buildStationDemandWalkingAccess({
    stationDemandAccess: access, pack: deepFreeze(structuredClone(pack)), policy, expectedRevisions: deepFreeze({ "stn:A": "rev:A1" }), knownTargetStationIds: deepFreeze(["other:1"]),
  });
  assert.equal(result.links.length, 2);
  result.links[0].status = "mutated";
  result.model.metersPerMinute = 1;
  assert.equal(access.sites[0].walkLinks[0].lengthMeters, 100);
  assert.equal(WALKING_MODEL.metersPerMinute, 80);
});

test("the contract rejects what it cannot read: wrong schema, version, pack, or an invalid policy", () => {
  const bad = (access, options = {}) => assert.throws(() => buildStationDemandWalkingAccess({ stationDemandAccess: access, pack, ...options }));
  bad(null);
  bad({ ...makeAccess(), schema: "other" });
  bad({ ...makeAccess(), contractVersion: 2 });
  bad({ ...makeAccess(), packId: "other" });
  bad({ ...makeAccess(), packVersion: "2" });
  bad({ ...makeAccess(), sites: null });
  assert.throws(() => buildStationDemandWalkingAccess({ stationDemandAccess: makeAccess(), pack: {} }), /CityPack id/);
  bad(makeAccess(), { policy: { walkEstimate: "fast" } });
  bad(makeAccess(), { policy: { acceptUnmeasuredLayers: "yes" } });
  bad(makeAccess(), { policy: { acknowledgedWalkLinkIds: [3] } });
  bad(makeAccess(), { policy: [] });
  bad(makeAccess(), { expectedRevisions: [] });
  assert.equal(buildStationDemandWalkingAccess({ stationDemandAccess: { ...makeAccess(), contractVersion: 1 }, pack }).sites.length, 1);
  assert.deepEqual(normalizeWalkingPolicy({ acknowledgedWalkLinkIds: ["b", "a", "b"] }), { walkEstimate: "none", acknowledgedWalkLinkIds: ["a", "b"], acknowledgedTransferIds: [], acceptUnmeasuredLayers: false });
});

test("the result carries no money, demand, crowd, score, probability, passenger, management or random field", () => {
  const result = one(makeSite({ transfers: [transfer()] }), { policy: { walkEstimate: "straight-line", acknowledgedWalkLinkIds: ["walk:1"] } });
  const keys = new Set();
  const walk = (value) => { if (Array.isArray(value)) value.forEach(walk); else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) { keys.add(k); walk(v); } };
  walk(result);
  keys.delete("usedForDemandAllocation"); // the one deliberate mention: a constant `false`, asserted above
  const forbidden = /(cost|price|fare|money|yen|jpy|budget|resident|jobs|passenger|crowd|congest|score|rank|probab|likelihood|random|rng|seed|demand(?!NodeId|ZoneId)|ridership|revenue|capacity)/i;
  assert.deepEqual([...keys].filter((k) => forbidden.test(k)), []);
});

test("the module reads no management, clock or random source and imports only the map id helper, projection and the E1 schema constant", () => {
  const source = fs.readFileSync(fileURLToPath(new URL("../src/station-demand-walking-model.mjs", import.meta.url)), "utf8");
  const imports = [...source.matchAll(/^import .* from "(.+)";$/gm)].map((m) => m[1]).sort();
  assert.deepEqual(imports, ["./map/ids.mjs", "./projection.mjs", "./station-demand-access-assessment.mjs"]);
  assert.equal(/Math\.random|Date\.now|new Date|performance\.now|process\.|localStorage|sessionStorage|management|scenario-runtime|state\.mjs|rng/i.test(source.replace(/\/\/.*$/gm, "")), false);
});

// --- against the real map builder ---
const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
const covers = ([x, y]) => x >= 138.99 && x <= 139.03 && y >= 34.98 && y <= 35.02;
function realExport({ layers = true } = {}) {
  const realPack = { manifest: { id: "t", version: "1", data: { license: "CC0-1.0", attribution: [] } }, existingNetwork: { lines: [] }, demand: { points: [{ id: "d0", name: "d0", location: [139.0105, 35.002], residents: 5, jobs: 5, kind: "mixed" }] } };
  const lineOf = (key, pts) => ({ key, name: key, vertices: pts.map((location) => ({ location, platformType: "side" })) });
  const scratch = buildMapExport({ pack: realPack, mode: "scratch", drawnLines: [lineOf("main", [[139, 35], [139.01, 35], [139.02, 35]]), lineOf("other", [[139.0125, 35.0004], [139.0125, 35.01]])] });
  const [plan, otherPlan] = scratch.plans;
  const spatial = makeSpatialContext(layers ? {
    buildings: polygonLayer([{ rings: [rect(139.01, 35.0004, 139.0104, 35.0007)] }], { covers, quality: "high", source: { name: "b", license: "x" } }),
    water: polygonLayer([{ rings: [rect(138.99, 34.999, 139.03, 34.9993)] }], { covers, quality: "medium", source: { name: "w", license: "x" } }),
  } : {});
  const drawn = {
    key: "st1", name: "Middle", connect: { planId: plan.planId, stationId: plan.stationCandidates[1].id },
    entrances: [{ key: "e1", location: [139.0102, 35.0002] }],
    accessPoints: [{ key: "p1", location: [139.0102, 35.0012], kind: "crossing" }, { key: "p2", location: [139.0102, 34.9985], kind: "street" }],
    demandZones: [{ key: "z1", kind: "residential", polygon: rect(139.0095, 35.0014, 139.0125, 35.0030) }],
    walkLinks: [
      { key: "w1", from: { kind: "entrance", key: "e1" }, to: { kind: "access-point", key: "p1" }, via: [[139.0102, 35.0006]] },
      { key: "w2", from: { kind: "access-point", key: "p1" }, to: { kind: "demand-zone", key: "z1" } },
      { key: "w3", from: { kind: "station" }, to: { kind: "access-point", key: "p2" }, widthMeters: 3 },
    ],
    transfers: [{ targetStationId: otherPlan.stationCandidates[0].id, via: [[139.0112, 35.0002]], widthMeters: 4 }],
  };
  const access = buildStationDemandAccessExport({ pack: realPack, mapExport: scratch, stations: [drawn], spatial });
  return { access, realPack, otherPlan };
}

test("the real map export (which carries no contractVersion field) is read; a building and a river on the drawing block exactly those links", () => {
  const { access, realPack } = realExport();
  assert.equal(access.contractVersion, undefined, "this is the shape the map really produces");
  const result = buildStationDemandWalkingAccess({ stationDemandAccess: deepFreeze(structuredClone(access)), pack: realPack });
  const idOf = (key) => access.sites[0].walkLinks.find((w) => w.key === key).walkLinkId;
  const byKey = (key) => result.links.find((l) => l.walkLinkId === idOf(key));
  assert.equal(byKey("w1").status, "blocked");
  assert.deepEqual(byKey("w1").reasons, ["crosses-building"]);
  assert.equal(byKey("w2").status, "usable");
  assert.equal(byKey("w3").status, "blocked");
  assert.deepEqual(byKey("w3").reasons, ["crosses-river"]);
  assert.equal(byKey("w3").widthMeters, 3);
  assert.equal(byKey("w2").meters, access.sites[0].walkLinks.find((w) => w.key === "w2").lengthMeters);
  const node = result.nodes[0];
  assert.equal(node.demandNodeId, "d0");
  assert.equal(node.status, "blocked");
  assert.equal(node.walkMinutes, null);
  assert.deepEqual(node.acknowledgeLinkIds, [idOf("w1")]);
  // the player confirms the building passage (say, a covered arcade) and the node becomes usable
  const confirmed = buildStationDemandWalkingAccess({ stationDemandAccess: access, pack: realPack, policy: { acknowledgedWalkLinkIds: [idOf("w1")] } });
  assert.equal(confirmed.nodes[0].status, "usable");
  assert.ok(confirmed.nodes[0].walkMinutes >= 1);
});

test("with no building or water layer the same drawing is unknown with the layer's own reason, not blocked and not clear", () => {
  const { access, realPack } = realExport({ layers: false });
  const result = buildStationDemandWalkingAccess({ stationDemandAccess: access, pack: realPack });
  for (const l of result.links) {
    assert.equal(l.status, "unknown");
    assert.ok(l.reasons.every((r) => /^barrier-unmeasured:(river|building):no-layer$/.test(r)), l.reasons.join());
    assert.equal(l.barrier.railway.state, "clear", "a blank map has no external rail: that zero is a fact");
    assert.ok(l.meters > 0);
  }
  assert.equal(result.nodes[0].status, "unknown");
  assert.equal(buildStationDemandWalkingAccess({ stationDemandAccess: access, pack: realPack, policy: { acceptUnmeasuredLayers: true } }).nodes[0].status, "usable");
});

test("the real map's transfer passage is separate from access, and a target missing from the map is reported broken", () => {
  const { access, realPack, otherPlan } = realExport();
  const result = buildStationDemandWalkingAccess({ stationDemandAccess: access, pack: realPack, knownTargetStationIds: [otherPlan.stationCandidates[0].id] });
  assert.equal(result.transfers.length, access.sites[0].transfers.length);
  const t = result.transfers.find((x) => x.basis === "player-passage");
  assert.equal(t.meters, access.sites[0].transfers.find((x) => x.basis === "player-passage").passageLengthMeters);
  assert.equal(t.usedForDemandAllocation, false);
  assert.notEqual(t.status, "broken");
  const gone = buildStationDemandWalkingAccess({ stationDemandAccess: access, pack: realPack, knownTargetStationIds: [] });
  assert.ok(gone.transfers.every((x) => x.status === "broken"));
});
