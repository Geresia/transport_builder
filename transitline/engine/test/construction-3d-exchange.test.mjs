import test from "node:test";
import assert from "node:assert/strict";
import { assessConstruction3dChangeSet, buildConstruction3dSceneManifest } from "../src/construction-3d-exchange.mjs";

const pack = { manifest: { id: "tokyo", version: "1" } };
const coordinates = { originLonLat: [139.7, 35.6], metersPerUnit: 1, axis: "east-up-north", verticalDatumMeters: 0 };
const source = { sourceType: "rail-geometry", sourceId: "rail-a", sourceRevision: "r1", sourcePackId: "tokyo", active: true, geometry: { alignment: [[139.7, 35.6], [139.71, 35.61]] } };

test("scene manifest is deterministic and contains only supplied 2D facts", () => {
  const manifest = buildConstruction3dSceneManifest({ pack, coordinates, sources: [source] });
  assert.equal(manifest.schema, "transitline.construction-3d-scene/1");
  assert.deepEqual(manifest.sources[0].geometry, source.geometry);
  assert.ok(manifest.notOwned.includes("ledger"));
  const again = buildConstruction3dSceneManifest({ pack, coordinates, sources: [source] });
  assert.equal(JSON.stringify(manifest), JSON.stringify(again));
});

test("a 3D change set is only applicable for the exact pack, coordinates, and revision", () => {
  const changeSet = { schema: "transitline.construction-3d-change-set/1", contractVersion: 1, packId: "tokyo", status: "proposed", coordinates, changes: [{ sourceType: "rail-geometry", sourceId: "rail-a", sourceRevision: "r1" }] };
  assert.equal(assessConstruction3dChangeSet(changeSet, { pack, coordinates, currentSources: [source] }).applicable, true);
  assert.ok(assessConstruction3dChangeSet({ ...changeSet, packId: "other" }, { pack, coordinates, currentSources: [source] }).blockers.includes("change-set-other-pack"));
  assert.ok(assessConstruction3dChangeSet({ ...changeSet, changes: [{ ...changeSet.changes[0], sourceRevision: "old" }] }, { pack, coordinates, currentSources: [source] }).blockers.includes("change-target-stale:rail-geometry:rail-a"));
});
test("a 3D change set never accepts a source whose pack provenance is unknown", () => {
  const changeSet = { schema: "transitline.construction-3d-change-set/1", contractVersion: 1, packId: "tokyo", status: "proposed", coordinates, changes: [{ sourceType: "rail-geometry", sourceId: "rail-a", sourceRevision: "r1" }] };
  const assessed = assessConstruction3dChangeSet(changeSet, { pack, coordinates, currentSources: [{ ...source, sourcePackId: null }] });
  assert.equal(assessed.applicable, false);
  assert.deepEqual(assessed.blockers, ["change-target-pack-unknown:rail-geometry:rail-a"]);
});
