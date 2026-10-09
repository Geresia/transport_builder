// B21-P1: data-only exchange boundary for an optional 3D construction client.
// JavaScript 2D remains the source of truth. A scene manifest is a snapshot to
// display; a change set is a proposal that still needs a 2D owner to apply it.

export const CONSTRUCTION_3D_SCENE_SCHEMA = "transitline.construction-3d-scene/1";
export const CONSTRUCTION_3D_CHANGE_SET_SCHEMA = "transitline.construction-3d-change-set/1";
export const CONSTRUCTION_3D_COORDINATES_SCHEMA = "transitline.construction-3d-coordinates/1";
export const CONSTRUCTION_3D_NOT_OWNED = Object.freeze(["cash", "ledger", "demand", "passengers", "timetables", "rng", "game-clock", "operating-settlement"]);

const clone = (value) => structuredClone(value);
const text = (value) => typeof value === "string" && value.trim() ? value.trim() : null;
const finitePoint = (value) => Array.isArray(value) && value.length === 2 && value.every(Number.isFinite);
const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : value && typeof value === "object" ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}` : JSON.stringify(value ?? null);
const compare = (a, b) => String(a).localeCompare(String(b));

export function normalizeConstruction3dCoordinates(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("3D coordinates are required");
  if (!finitePoint(value.originLonLat)) throw new Error("3D coordinates need finite originLonLat");
  if (!Number.isFinite(value.metersPerUnit) || value.metersPerUnit <= 0) throw new Error("3D metersPerUnit must be positive");
  if (value.axis !== "east-up-north") throw new Error("3D axis must be east-up-north");
  if (!Number.isFinite(value.verticalDatumMeters)) throw new Error("3D verticalDatumMeters must be finite");
  return { schema: CONSTRUCTION_3D_COORDINATES_SCHEMA, contractVersion: 1, originLonLat: [...value.originLonLat], metersPerUnit: value.metersPerUnit, axis: value.axis, verticalDatumMeters: value.verticalDatumMeters };
}

// sources are 2D facts: { sourceType, sourceId, sourceRevision, packId?,
// active?, geometry? }. Geometry is copied only if supplied, never invented.
export function buildConstruction3dSceneManifest({ pack, coordinates, sources = [] } = {}) {
  const packId = text(pack?.manifest?.id ?? pack?.id); if (!packId) throw new Error("3D scene needs a pack id");
  const warnings = []; const kept = new Map();
  for (const source of sources ?? []) {
    const sourceType = text(source?.sourceType); const sourceId = text(source?.sourceId); const sourceRevision = text(source?.sourceRevision);
    if (!sourceType || !sourceId || !sourceRevision) { warnings.push({ code: "scene-source-invalid" }); continue; }
    const sourcePackId = text(source.sourcePackId ?? source.packId) ?? packId;
    const key = `${sourceType}|${sourceId}`; if (kept.has(key)) { warnings.push({ code: "scene-source-duplicate", sourceType, sourceId }); continue; }
    kept.set(key, { sourceType, sourceId, sourceRevision, sourcePackId, active: source.active === false ? false : true, geometry: source.geometry === undefined ? null : clone(source.geometry) });
  }
  return { schema: CONSTRUCTION_3D_SCENE_SCHEMA, contractVersion: 1, packId, packVersion: pack?.manifest?.version ?? pack?.version ?? null,
    coordinates: normalizeConstruction3dCoordinates(coordinates), sources: [...kept.values()].sort((a, b) => compare(a.sourceType, b.sourceType) || compare(a.sourceId, b.sourceId)),
    warnings: warnings.sort((a, b) => canonical(a).localeCompare(canonical(b))), notOwned: [...CONSTRUCTION_3D_NOT_OWNED] };
}

// This validates a proposal without applying it. `currentSources` are the
// current 2D facts keyed by source type/id/revision. Any absent, inactive,
// other-pack, or revision-mismatched target makes the proposal non-applicable.
export function assessConstruction3dChangeSet(changeSet, { pack, coordinates, currentSources = [] } = {}) {
  const blockers = [];
  const packId = text(pack?.manifest?.id ?? pack?.id);
  if (!changeSet || typeof changeSet !== "object" || Array.isArray(changeSet)) return { schema: "transitline.construction-3d-change-set-assessment/1", contractVersion: 1, applicable: false, blockers: ["change-set-not-an-object"] };
  if (changeSet.schema !== CONSTRUCTION_3D_CHANGE_SET_SCHEMA || changeSet.contractVersion !== 1) blockers.push("change-set-schema-invalid");
  if (!packId || text(changeSet.packId) !== packId) blockers.push("change-set-other-pack");
  try { if (canonical(normalizeConstruction3dCoordinates(changeSet.coordinates)) !== canonical(normalizeConstruction3dCoordinates(coordinates))) blockers.push("coordinates-changed"); } catch { blockers.push("coordinates-invalid"); }
  if (changeSet.status !== "proposed") blockers.push(`change-set-status-${changeSet.status ?? "unknown"}`);
  if (!Array.isArray(changeSet.changes) || !changeSet.changes.length) blockers.push("change-set-has-no-changes");
  const index = new Map((currentSources ?? []).map((source) => [`${source.sourceType}|${source.sourceId}`, source]));
  for (const change of Array.isArray(changeSet.changes) ? changeSet.changes : []) {
    const type = text(change?.sourceType); const id = text(change?.sourceId); const revision = text(change?.sourceRevision);
    const source = type && id ? index.get(`${type}|${id}`) : null;
    if (!type || !id || !revision) { blockers.push("change-target-invalid"); continue; }
    if (!source) blockers.push(`change-target-missing:${type}:${id}`);
    else if (source.active === false) blockers.push(`change-target-inactive:${type}:${id}`);
    else if (text(source.sourcePackId ?? source.packId) && text(source.sourcePackId ?? source.packId) !== packId) blockers.push(`change-target-other-pack:${type}:${id}`);
    else if (source.sourceRevision !== revision) blockers.push(`change-target-stale:${type}:${id}`);
  }
  return { schema: "transitline.construction-3d-change-set-assessment/1", contractVersion: 1, applicable: blockers.length === 0, blockers: [...new Set(blockers)].sort(compare), notOwned: [...CONSTRUCTION_3D_NOT_OWNED] };
}
