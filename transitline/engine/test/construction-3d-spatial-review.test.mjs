import test from "node:test";
import assert from "node:assert/strict";
import { assessConstruction3dSpatialReview, normalizeConstruction3dSpatialReview } from "../src/construction-3d-spatial-review.mjs";
const pack = { manifest: { id: "tokyo" } }; const source = { sourceType: "station-site", sourceId: "s1", sourceRevision: "r1", active: true };
const review = { schema: "transitline.construction-3d-spatial-review/1", contractVersion: 1, reviewId: "review:1", packId: "tokyo", observations: [{ observationId: "o1", sourceType: "station-site", sourceId: "s1", sourceRevision: "r1", state: "conflict", reason: "player-marked" }] };
test("3D review accepts only exact current source facts and keeps conflict as a fact", () => {
  const result = assessConstruction3dSpatialReview(review, { pack, currentSources: [source] });
  assert.equal(result.applicable, true); assert.ok(result.notComputed.includes("buildability"));
  assert.ok(assessConstruction3dSpatialReview({ ...review, packId: "other" }, { pack, currentSources: [source] }).blockers.includes("review-other-pack"));
  assert.ok(assessConstruction3dSpatialReview({ ...review, observations: [{ ...review.observations[0], sourceRevision: "old" }] }, { pack, currentSources: [source] }).blockers.includes("review-source-stale:station-site:s1"));
});
test("normalization never turns unknown into clear or invents observations", () => {
  const normalized = normalizeConstruction3dSpatialReview({ ...review, observations: [...review.observations, { observationId: "o2", sourceType: "station-site", sourceId: "s1", sourceRevision: "r1", state: "unknown" }] });
  assert.deepEqual(normalized.observations.map((entry) => entry.state), ["conflict", "unknown"]);
  assert.equal(normalizeConstruction3dSpatialReview({}).observations.length, 0);
});
