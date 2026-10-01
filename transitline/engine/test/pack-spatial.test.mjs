import test from "node:test";
import assert from "node:assert/strict";
import { spatialContextFromPack } from "../src/map/pack-spatial.mjs";

const ring = [[139.7, 35.7], [139.701, 35.7], [139.701, 35.701], [139.7, 35.701], [139.7, 35.7]];

test("spatialContextFromPack exposes real building height and water collision layers", () => {
  const spatial = spatialContextFromPack({
    manifest: { data: { license: "ODbL-1.0" } },
    obstacles: { obstacles: [{ kind: "building", district: "sample", sourceKind: "office", levels: 4, polygon: ring }] },
    barriers: { barriers: [{ kind: "water", polygon: [ring] }] },
  });
  assert.equal(spatial.layers.buildings.items.length, 1);
  assert.equal(spatial.layers.buildings.items[0].heightMeters, 12);
  assert.equal(spatial.layers.water.items.length, 1);
  assert.equal(spatial.quality.building, "medium");
  assert.equal(spatial.quality.river, "medium");
});

test("spatialContextFromPack keeps absent optional files unknown", () => {
  const spatial = spatialContextFromPack({ manifest: { data: { license: "CC0-1.0" } } });
  assert.equal(spatial.layers.buildings, undefined);
  assert.equal(spatial.layers.water, undefined);
  assert.equal(spatial.crossings(ring).building, null);
  assert.equal(spatial.crossings(ring).river, null);
});
