import test from "node:test";
import assert from "node:assert/strict";
import { assessConstruction3dSession, construction3dCoordinatorDocument, sameConstruction3dCoordinateFrame } from "../src/construction-3d-session-coordinator.mjs";
import { CONSTRUCTION_3D_ADAPTER_PROTOCOL } from "../src/construction-3d-adapter.mjs";
import { buildConstruction3dSceneManifest } from "../src/construction-3d-exchange.mjs";

const pack = { manifest: { id: "example-radial", version: "1" } };
const coordinates = { originLonLat: [139.7, 35.6], metersPerUnit: 1, axis: "east-up-north", verticalDatumMeters: 0 };
const source = { sourceType: "rail", sourceId: "r1", sourceRevision: "v1", sourcePackId: "example-radial", active: true, geometry: [[0, 0], [1, 1]] };
const scene = () => buildConstruction3dSceneManifest({ pack, coordinates, sources: [source] });
const ready = { protocol: CONSTRUCTION_3D_ADAPTER_PROTOCOL, contractVersion: 1, clientId: "unity-webgl", clientVersion: "1", capabilities: ["scene-manifest-v1", "change-set-v1"] };

test("only a ready client and exact current scene sources expose 3d availability", () => {
  const result = assessConstruction3dSession({ pack, client: ready, scene: scene(), currentSources: [source], selectedSourceIds: ["r1"] });
  assert.equal(result.mode, "3d-available");
  assert.equal(result.fallback, null);
  assert.deepEqual(result.blockers, []);
  assert.deepEqual(result.selectedSourceIds, ["r1"]);
});

test("missing, stale, inactive, and other-pack sources always remain on the 2d fallback", () => {
  for (const current of [[], [{ ...source, sourceRevision: "v2" }], [{ ...source, active: false }], [{ ...source, sourcePackId: "tokyo" }]]) {
    const result = assessConstruction3dSession({ pack, client: ready, scene: scene(), currentSources: current });
    assert.equal(result.mode, "2d-only");
    assert.ok(result.blockers.some((entry) => entry.startsWith("scene-source-")));
  }
});

test("a missing or incompatible optional client never blocks the 2d game", () => {
  for (const client of [null, { protocol: "wrong", contractVersion: 1, capabilities: [] }]) {
    const result = assessConstruction3dSession({ pack, client, scene: scene(), currentSources: [source] });
    assert.equal(result.mode, "2d-only");
    assert.deepEqual(result.blockers, []);
    assert.ok(result.warnings.some((entry) => entry.startsWith("3d-client-")));
  }
});

test("coordinate frames compare structurally and session serialization retains no client runtime", () => {
  assert.equal(sameConstruction3dCoordinateFrame(coordinates, { ...coordinates }), true);
  assert.equal(sameConstruction3dCoordinateFrame(coordinates, { ...coordinates, axis: "north-up-east" }), false);
  const session = assessConstruction3dSession({ pack, client: ready, scene: scene(), currentSources: [source] });
  const document = construction3dCoordinatorDocument({ client: ready, selectedSourceIds: ["r1"], session });
  assert.equal(document.client.clientId, "unity-webgl");
  assert.equal(JSON.stringify(document).includes("geometry"), false);
  assert.equal(JSON.stringify(document).includes("webgl"), true, "identity is permitted; a runtime blob is not");
});

test("assessment is detached and does not alter frozen scene or source facts", () => {
  const frozenScene = Object.freeze(scene()); const frozenSource = Object.freeze({ ...source });
  const result = assessConstruction3dSession({ pack, client: ready, scene: frozenScene, currentSources: [frozenSource] });
  result.client.status = "changed";
  assert.equal(frozenScene.sources[0].sourceRevision, "v1");
  assert.equal(frozenSource.sourceRevision, "v1");
});
