import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildStationSite } from "../src/map/station-site.mjs";
import { makeSpatialContext, polygonLayer } from "../src/map/spatial.mjs";
import { recomputeCollision, validateInboundMessage, SITE_DESIGN_IFRAME_PATH } from "../src/map/site-design-bridge.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const pack = { manifest: { id: "t", version: "1", data: { license: "CC0-1.0", attribution: [] } } };
const CENTRE = [139.7, 35.7];
const sq = (lon, lat, d = 0.0004) => [[[lon, lat], [lon + d, lat], [lon + d, lat + d], [lon, lat + d], [lon, lat]]];

// A real StationSiteGeometry fixture (surface station, two entrances) with a real building layer so collision
// facts are genuine, not synthetic guesses.
const buildingNearBody = polygonLayer([{ rings: sq(139.7002, 35.7001), kind: "house" }], { quality: "high", source: { name: "b", license: "CC0-1.0" } });
const emptyBuildings = polygonLayer([], { quality: "high", source: { name: "empty", license: "CC0-1.0" } });
const emptyWater = polygonLayer([], { quality: "high", source: { name: "empty-water", license: "CC0-1.0" } });

function makeSite(spatial) {
  const drawn = {
    key: "fixture", location: CENTRE, headingDegrees: 0, lengthMeters: 160, widthMeters: 24,
    entrances: [{ key: "north", location: [139.7, 35.7012] }, { key: "south", location: [139.7, 35.6988] }],
  };
  return buildStationSite(drawn, { pack, spatial });
}

test("recomputeCollision finds a real body collision when the pack's own building layer overlaps the moved body", () => {
  const spatial = makeSpatialContext({ buildings: buildingNearBody });
  const site = makeSite(makeSpatialContext());
  const request = { body: { location: [139.7002, 35.70015], headingDegrees: 0, lengthMeters: 160, widthMeters: 24 }, entranceChanges: [] };
  const result = recomputeCollision(request, site.entranceCandidates, { pack, spatial });
  assert.equal(result.bodyCollision, true);
});

test("recomputeCollision returns null (not false) when no building layer is available at all", () => {
  const site = makeSite(makeSpatialContext());
  const request = { body: { location: CENTRE, headingDegrees: 0, lengthMeters: 160, widthMeters: 24 }, entranceChanges: [] };
  const result = recomputeCollision(request, site.entranceCandidates, { pack, spatial: makeSpatialContext() });
  assert.equal(result.bodyCollision, null);
  for (const e of result.entranceCollisions) assert.equal(e.collides, null);
});

test("recomputeCollision returns a real false when a layer covers the area and finds nothing", () => {
  const site = makeSite(makeSpatialContext());
  const spatial = makeSpatialContext({ buildings: emptyBuildings, water: emptyWater });
  const request = { body: { location: CENTRE, headingDegrees: 0, lengthMeters: 160, widthMeters: 24 }, entranceChanges: [] };
  const result = recomputeCollision(request, site.entranceCandidates, { pack, spatial });
  assert.equal(result.bodyCollision, false);
});

test("recomputeCollision checks each entrance independently, using a moved location only for the entrance that moved", () => {
  const site = makeSite(makeSpatialContext());
  const [north, south] = site.entranceCandidates.sort((a, b) => (a.location[1] < b.location[1] ? 1 : -1)); // north has higher lat
  const spatial = makeSpatialContext({ buildings: buildingNearBody, water: emptyWater });
  // move the "south" entrance onto the building; leave "north" at its original (unaffected) location
  const request = {
    body: { location: CENTRE, headingDegrees: 0, lengthMeters: 160, widthMeters: 24 },
    entranceChanges: [{ entranceId: south.entranceId, location: [139.7002, 35.70015] }],
  };
  const result = recomputeCollision(request, site.entranceCandidates, { pack, spatial });
  const movedResult = result.entranceCollisions.find((e) => e.entranceId === south.entranceId);
  const untouchedResult = result.entranceCollisions.find((e) => e.entranceId === north.entranceId);
  assert.equal(movedResult.collides, true, "the moved entrance now sits on the building");
  assert.equal(untouchedResult.collides, false, "the untouched entrance keeps its own (clear) original location");
});

test("recomputeCollision never mutates the original entrance candidates it was given", () => {
  const site = makeSite(makeSpatialContext());
  const before = JSON.stringify(site.entranceCandidates);
  const spatial = makeSpatialContext({ buildings: buildingNearBody });
  const request = { body: { location: [139.7002, 35.70015], headingDegrees: 0, lengthMeters: 160, widthMeters: 24 }, entranceChanges: [] };
  recomputeCollision(request, site.entranceCandidates, { pack, spatial });
  assert.equal(JSON.stringify(site.entranceCandidates), before);
});

// --- inbound message validation ---
const EXPECT = { origin: "http://localhost:8123", sessionId: "sess-1", stationSiteId: "stn-site:abc" };

test("validateInboundMessage accepts a well-formed message and rejects a mismatched origin", () => {
  const ok = { schema: "transitline.site-design-edit/1", sessionId: "sess-1", stationSiteId: "stn-site:abc" };
  assert.equal(validateInboundMessage(ok, "http://localhost:8123", EXPECT), null);
  assert.equal(validateInboundMessage(ok, "http://evil.example", EXPECT), "origin-mismatch");
});

test("validateInboundMessage rejects an unknown schema, a wrong sessionId, and a wrong stationSiteId", () => {
  assert.equal(validateInboundMessage({ schema: "transitline.other/1" }, EXPECT.origin, EXPECT), "unknown-schema");
  assert.equal(validateInboundMessage({ schema: "transitline.site-design-edit/1", sessionId: "sess-2", stationSiteId: "stn-site:abc" }, EXPECT.origin, EXPECT), "session-mismatch");
  assert.equal(validateInboundMessage({ schema: "transitline.site-design-edit/1", sessionId: "sess-1", stationSiteId: "stn-site:zzz" }, EXPECT.origin, EXPECT), "station-mismatch");
});

test("validateInboundMessage passes a ready message (no sessionId/stationSiteId of its own) as long as schema+origin are right", () => {
  assert.equal(validateInboundMessage({ schema: "transitline.site-design-ready/1" }, EXPECT.origin, EXPECT), null);
});

test("validateInboundMessage treats a wildcard expected origin as always matching, and rejects an empty message", () => {
  assert.equal(validateInboundMessage({ schema: "transitline.site-design-ready/1" }, "http://anything", { ...EXPECT, origin: "*" }), null);
  assert.equal(validateInboundMessage(null, EXPECT.origin, EXPECT), "empty-message");
  assert.equal(validateInboundMessage("not-an-object", EXPECT.origin, EXPECT), "empty-message");
});

// --- boundary: never touches the management engine, cash, or the file system; stays reasonably small ---
test("site-design-bridge.mjs does not import the management engine or touch cash/ledger/files, and holds code not data", () => {
  const src = fs.readFileSync(path.join(root, "engine/src/map/site-design-bridge.mjs"), "utf8");
  for (const m of src.matchAll(/from "([^"]+)"/g)) assert.match(m[1], /^\.\/[a-z-]+\.mjs$/, `imports ${m[1]}`);
  assert.doesNotMatch(src, /ledger|\.commit\(|\.settle\(|\.post\(|node:fs/, "must not reach engine state or the file system");
  assert.ok(src.length < 40_000, "holds code, not data");
});

test("the iframe path points at the untouched standalone editor page", () => {
  assert.equal(SITE_DESIGN_IFRAME_PATH, "../packs/tokyo/site-design.html");
});
