// node --test engine/test/placement-validation.test.mjs — placement rules for Heavy Metro
// (max slope 5.5 %, min curve 29 m, station curve 150 m, platform 97.75..285.25 m).
import test from "node:test";
import assert from "node:assert/strict";
import { validateTrack, validateStationTrack, validateOverlap, validateWater } from "../src/placement-validation.mjs";

const codes = (errors) => errors.map((e) => e.code);
const T = { trainType: "heavy-metro" };

test("track length, slope, curve and elevation limits", () => {
  assert.deepEqual(validateTrack({ ...T, lengthM: 500 }), []);
  assert.deepEqual(codes(validateTrack({ ...T, lengthM: 9 })), ["too-short"]);
  assert.deepEqual(validateTrack({ ...T, lengthM: 10000.05 }), [], "10 000 m + 0.1 is allowed");
  assert.deepEqual(codes(validateTrack({ ...T, lengthM: 10001 })), ["too-long"]);
  assert.deepEqual(validateTrack({ ...T, lengthM: 1000, elevationStartM: 0, elevationEndM: -55 }), [], "5.5 % is the limit");
  assert.deepEqual(codes(validateTrack({ ...T, lengthM: 1000, elevationEndM: -60 })), ["slope"]);
  assert.deepEqual(codes(validateTrack({ ...T, lengthM: 500, minRadiusM: 20 })), ["curve"]);
  assert.deepEqual(codes(validateTrack({ ...T, lengthM: 500, elevationStartM: 30, elevationEndM: 30 })), ["elevation-range", "elevation-range"]);
  assert.deepEqual(codes(validateTrack({ ...T, points: 1, lengthM: 500 })), ["points"]);
});

test("light rail climbs steeper than heavy metro", () => {
  assert.deepEqual(codes(validateTrack({ trainType: "heavy-metro", lengthM: 100, elevationEndM: 6 })), ["slope"]);
  assert.deepEqual(validateTrack({ trainType: "light-rail", lengthM: 100, elevationEndM: 6 }), []);
});

test("station track: fits the train set, level, straight", () => {
  assert.deepEqual(validateStationTrack({ ...T, lengthM: 100 }), []);
  assert.deepEqual(codes(validateStationTrack({ ...T, lengthM: 90 })), ["station-short"]);
  assert.deepEqual(validateStationTrack({ ...T, lengthM: 285.4 }), [], "max set + 0.2 m tolerance");
  assert.deepEqual(codes(validateStationTrack({ ...T, lengthM: 286 })), ["station-long"]);
  assert.deepEqual(codes(validateStationTrack({ ...T, lengthM: 100, elevationEndM: 0.5 })), ["station-level"]);
  assert.deepEqual(codes(validateStationTrack({ ...T, lengthM: 100, minRadiusM: 100 })), ["station-curve"]);
  assert.deepEqual(validateStationTrack({ ...T, lengthM: 100, totalBendRad: 0.6 }), []);
  assert.deepEqual(codes(validateStationTrack({ ...T, lengthM: 100, totalBendRad: 0.7 })), ["station-bend"]);
});

test("crossing tracks: same height joins, 4 m apart passes over, in between is an error, stations need the full 4 m", () => {
  assert.deepEqual(validateOverlap({ heightDiffM: 0.01 }), []);
  assert.deepEqual(codes(validateOverlap({ heightDiffM: 0.01, sameTrainType: false })), ["junction-type"]);
  assert.deepEqual(codes(validateOverlap({ heightDiffM: 1 })), ["overlap"]);
  assert.deepEqual(validateOverlap({ heightDiffM: -4 }), []);
  assert.deepEqual(validateOverlap({ heightDiffM: 4, sameTrainType: false }), []);
  assert.deepEqual(codes(validateOverlap({ heightDiffM: 0, involvesStation: true })), ["station-overlap"]);
  assert.deepEqual(codes(validateOverlap({ heightDiffM: 3.9, involvesStation: true })), ["station-overlap"]);
});

test("track over water: tunnel below the seabed or a viaduct 5 m up", () => {
  assert.deepEqual(validateWater({ trackElevationM: -30, seabedElevationM: -20 }), []);
  assert.deepEqual(validateWater({ trackElevationM: 5, seabedElevationM: -20, groundElevationM: 0 }), []);
  assert.deepEqual(codes(validateWater({ trackElevationM: 2, seabedElevationM: -20, groundElevationM: 0 })), ["water"]);
});
