// B22: verifies a submitted 3D spatial-review proposal against the exact 2D
// source revisions.  `clear`, `conflict`, and `unknown` are observations only.
// They are explicitly not construction approval, cost, or permit conclusions.

export const CONSTRUCTION_3D_SPATIAL_REVIEW_SCHEMA = "transitline.construction-3d-spatial-review/1";
export const CONSTRUCTION_3D_REVIEW_STATES = Object.freeze(["clear", "conflict", "unknown"]);
export const CONSTRUCTION_3D_REVIEW_NOT_COMPUTED = Object.freeze(["buildability", "permit", "cost", "schedule", "demand", "capacity", "safety-verdict"]);
const text = (value) => typeof value === "string" && value.trim() ? value.trim() : null;
const clone = (value) => structuredClone(value);
const compare = (a, b) => String(a).localeCompare(String(b));

function sourceIndex(sources) {
  const index = new Map();
  for (const source of sources ?? []) {
    const type = text(source?.sourceType); const id = text(source?.sourceId); const revision = text(source?.sourceRevision);
    if (type && id && revision && !index.has(`${type}|${id}`)) index.set(`${type}|${id}`, source);
  }
  return index;
}

export function assessConstruction3dSpatialReview(review, { pack, currentSources = [] } = {}) {
  const packId = text(pack?.manifest?.id ?? pack?.id); const blockers = [];
  if (!review || typeof review !== "object" || Array.isArray(review)) return { schema: "transitline.construction-3d-spatial-review-assessment/1", contractVersion: 1, applicable: false, blockers: ["review-not-an-object"] };
  if (review.schema !== CONSTRUCTION_3D_SPATIAL_REVIEW_SCHEMA || review.contractVersion !== 1) blockers.push("review-schema-invalid");
  if (!packId || text(review.packId) !== packId) blockers.push("review-other-pack");
  if (!Array.isArray(review.observations)) blockers.push("review-observations-invalid");
  const sources = sourceIndex(currentSources);
  for (const observation of Array.isArray(review.observations) ? review.observations : []) {
    const type = text(observation?.sourceType); const id = text(observation?.sourceId); const revision = text(observation?.sourceRevision);
    const source = type && id ? sources.get(`${type}|${id}`) : null;
    if (!type || !id || !revision || !CONSTRUCTION_3D_REVIEW_STATES.includes(observation?.state)) blockers.push("review-observation-invalid");
    else if (!source) blockers.push(`review-source-missing:${type}:${id}`);
    else if (source.active === false) blockers.push(`review-source-inactive:${type}:${id}`);
    else if (source.sourceRevision !== revision) blockers.push(`review-source-stale:${type}:${id}`);
  }
  return { schema: "transitline.construction-3d-spatial-review-assessment/1", contractVersion: 1, applicable: blockers.length === 0, blockers: [...new Set(blockers)].sort(compare), notComputed: [...CONSTRUCTION_3D_REVIEW_NOT_COMPUTED] };
}

// Normalizes a proposed review for storage by a later domain-specific owner.
// Only a caller who has a valid current source list should accept it.
export function normalizeConstruction3dSpatialReview(review) {
  const observations = Array.isArray(review?.observations) ? review.observations.map((entry) => ({ observationId: text(entry?.observationId), sourceType: text(entry?.sourceType), sourceId: text(entry?.sourceId), sourceRevision: text(entry?.sourceRevision), state: CONSTRUCTION_3D_REVIEW_STATES.includes(entry?.state) ? entry.state : null, reason: text(entry?.reason), geometry: entry?.geometry === undefined ? null : clone(entry.geometry) })).filter((entry) => entry.observationId && entry.sourceType && entry.sourceId && entry.sourceRevision && entry.state) : [];
  const seen = new Set();
  return { schema: CONSTRUCTION_3D_SPATIAL_REVIEW_SCHEMA, contractVersion: 1, reviewId: text(review?.reviewId), packId: text(review?.packId), observations: observations.filter((entry) => { if (seen.has(entry.observationId)) return false; seen.add(entry.observationId); return true; }).sort((a, b) => compare(a.observationId, b.observationId)), notComputed: [...CONSTRUCTION_3D_REVIEW_NOT_COMPUTED] };
}
