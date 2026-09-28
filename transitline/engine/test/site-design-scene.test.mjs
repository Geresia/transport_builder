import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildStationSiteScene, buildSurroundingScene, SITE_DESIGN_SCENE_SCHEMA, SITE_DESIGN_MODEL, SURROUNDING_DEFAULT_BUILDING_HEIGHT_METERS } from "../src/map/site-design-scene.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const readJson = (p) => JSON.parse(fs.readFileSync(path.join(root, p), "utf8"));

const groundSite = readJson("packs/tokyo/station-examples/01-ground-side-general.station.json");
const deepSite = readJson("packs/tokyo/station-examples/04-deep-station.station.json");
const blockedSite = readJson("packs/tokyo/station-examples/07-blocked-entrances.station.json");

// deep-clone jsonable fixtures so mutation checks compare against a pristine copy
const clone = (v) => JSON.parse(JSON.stringify(v));

test("rejects anything that is not a StationSite", () => {
  assert.throws(() => buildStationSiteScene(null), /StationSite/);
  assert.throws(() => buildStationSiteScene({ schema: "something-else" }), /StationSite/);
});

test("does not mutate the input site", () => {
  const before = clone(groundSite);
  buildStationSiteScene(groundSite);
  assert.deepEqual(groundSite, before);
});

test("surface station: body sits on the ground plane, one entrance/work-area per candidate", () => {
  const scene = buildStationSiteScene(groundSite);
  assert.equal(scene.schema, SITE_DESIGN_SCENE_SCHEMA);
  assert.equal(scene.stationSiteId, groundSite.stationSiteId);
  assert.ok(scene.body);
  assert.equal(scene.body.baseZMeters, 0);
  assert.equal(scene.body.heightMeters, SITE_DESIGN_MODEL.bodyHeightMeters);
  assert.equal(scene.body.polygonXY.length, groundSite.bodyPolygon.length);
  // the frame is centred on site.location, so the body ring (tens of metres wide) stays close to the origin
  for (const [x, y] of scene.body.polygonXY) { assert.ok(Math.abs(x) < 200); assert.ok(Math.abs(y) < 200); }
  assert.equal(scene.entrances.length, groundSite.entranceCandidates.length);
  assert.equal(scene.workAreas.length, groundSite.workAreaCandidates.length);
});

test("a station with a positive planned depth renders its body below the ground plane", () => {
  const scene = buildStationSiteScene(deepSite);
  assert.equal(deepSite.plannedDepthMeters, 38);
  assert.equal(scene.body.baseZMeters, -38);
});

test("entrance flags carry through as the blocked flag, read-only", () => {
  const scene = buildStationSiteScene(blockedSite);
  assert.ok(scene.entrances.length > 0);
  for (const e of scene.entrances) assert.equal(e.blocked, e.flags.includes("building-collision") || e.flags.includes("in-water"));
  assert.ok(scene.entrances.some((e) => e.blocked));
});

test("requirement 1: buildSurroundingScene converts buildings/roads/water/existingRail to local-metre geometry, defaulting missing categories to []", () => {
  const origin = groundSite.location;
  const empty = buildSurroundingScene(null, origin);
  assert.deepEqual(empty, { buildings: [], roads: [], water: [], existingRail: [] });

  const [lon0, lat0] = origin;
  const nearbySquare = (dx, dy) => [[lon0, lat0], [lon0 + dx, lat0], [lon0 + dx, lat0 + dy], [lon0, lat0 + dy]];
  const data = {
    buildings: [{ id: "b1", polygon: nearbySquare(0.0005, 0.0005), heightMeters: 12 }, { polygon: nearbySquare(0.0003, 0.0003) }],
    roads: [{ id: "r1", line: [[lon0, lat0], [lon0 + 0.001, lat0]], class: "major" }],
    water: [{ polygon: nearbySquare(0.0008, 0.0008) }],
    existingRail: [{ line: [[lon0 - 0.001, lat0], [lon0, lat0]] }],
  };
  const scene = buildSurroundingScene(data, origin);
  assert.equal(scene.buildings.length, 2);
  assert.equal(scene.buildings[0].id, "b1");
  assert.equal(scene.buildings[0].heightMeters, 12);
  assert.equal(scene.buildings[1].heightMeters, SURROUNDING_DEFAULT_BUILDING_HEIGHT_METERS); // no height given -> nominal default
  assert.equal(scene.buildings[0].polygonXY.length, 4);
  assert.equal(scene.roads.length, 1);
  assert.equal(scene.roads[0].roadClass, "major");
  assert.equal(scene.roads[0].lineXY.length, 2);
  assert.equal(scene.water.length, 1);
  assert.equal(scene.existingRail.length, 1);
  // local-metre coordinates: everything here is within a couple hundred metres of the origin
  for (const b of scene.buildings) for (const [x, y] of b.polygonXY) { assert.ok(Math.abs(x) < 200); assert.ok(Math.abs(y) < 200); }
});

test("never carries a cost, duration or risk figure — this module only renders spatial facts", () => {
  const scene = buildStationSiteScene(groundSite);
  const forbidden = /cost|budget|price|duration|schedule|days|months|risk|probability|score/i;
  const walk = (v) => {
    if (v && typeof v === "object") for (const [k, child] of Object.entries(v)) { assert.doesNotMatch(k, forbidden, `unexpected key "${k}" in site-design scene`); walk(child); }
  };
  walk(scene);
});
