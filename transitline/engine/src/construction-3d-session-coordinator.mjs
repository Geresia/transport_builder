// B21-C1 host-side launch gate. It decides whether an optional 3D client may
// be offered a supplied 2D scene snapshot. It neither loads Unity nor applies
// a change set; every non-current/missing condition stays on the 2D fallback.

import { assessConstruction3dClient, construction3dSessionDocument } from "./construction-3d-adapter.mjs";
import { CONSTRUCTION_3D_SCENE_SCHEMA, normalizeConstruction3dCoordinates } from "./construction-3d-exchange.mjs";

export const CONSTRUCTION_3D_SESSION_COORDINATOR_SCHEMA = "transitline.construction-3d-session-coordinator/1";
const text = (value) => typeof value === "string" && value.trim() ? value.trim() : null;
const clone = (value) => structuredClone(value);
const cmp = (a, b) => String(a).localeCompare(String(b));
const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : value && typeof value === "object" ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}` : JSON.stringify(value ?? null);

export function assessConstruction3dSession({ pack, client = null, scene = null, currentSources = [], selectedSourceIds = null } = {}) {
  const packId = text(pack?.manifest?.id ?? pack?.id);
  const clientAssessment = assessConstruction3dClient(client);
  const blockers = [];
  const warnings = [];
  if (!packId) blockers.push("pack-id-missing");
  if (!scene || typeof scene !== "object" || Array.isArray(scene)) blockers.push("scene-not-provided");
  else {
    if (scene.schema !== CONSTRUCTION_3D_SCENE_SCHEMA || scene.contractVersion !== 1) blockers.push("scene-schema-invalid");
    if (text(scene.packId) !== packId) blockers.push("scene-other-pack");
    try { normalizeConstruction3dCoordinates(scene.coordinates); } catch { blockers.push("scene-coordinates-invalid"); }
    const index = new Map((Array.isArray(currentSources) ? currentSources : []).map((source) => [`${source?.sourceType}|${source?.sourceId}`, source]));
    if (!Array.isArray(currentSources)) warnings.push("current-sources-not-provided");
    if (!Array.isArray(scene.sources)) blockers.push("scene-sources-invalid");
    else for (const source of scene.sources) {
      const type = text(source?.sourceType); const id = text(source?.sourceId); const revision = text(source?.sourceRevision);
      const current = type && id ? index.get(`${type}|${id}`) : null;
      if (!type || !id || !revision) blockers.push("scene-source-invalid");
      else if (!current) blockers.push(`scene-source-missing:${type}:${id}`);
      else if (current.active === false) blockers.push(`scene-source-inactive:${type}:${id}`);
      else if (text(current.sourcePackId ?? current.packId) && text(current.sourcePackId ?? current.packId) !== packId) blockers.push(`scene-source-other-pack:${type}:${id}`);
      else if (text(current.sourceRevision) !== revision) blockers.push(`scene-source-stale:${type}:${id}`);
    }
  }
  if (!clientAssessment.usable) warnings.push(`3d-client-${clientAssessment.status}`);
  const selected = selectedSourceIds === null || selectedSourceIds === undefined ? null : Array.isArray(selectedSourceIds) ? [...new Set(selectedSourceIds.filter((value) => text(value)))].sort(cmp) : null;
  if (selectedSourceIds !== null && selectedSourceIds !== undefined && selected === null) warnings.push("selected-source-ids-invalid");
  const mode = clientAssessment.usable && blockers.length === 0 ? "3d-available" : "2d-only";
  return { schema: CONSTRUCTION_3D_SESSION_COORDINATOR_SCHEMA, contractVersion: 1, packId: packId ?? null, mode, fallback: mode === "2d-only" ? "2d-only" : null,
    client: clone(clientAssessment), scene: scene && typeof scene === "object" ? { schema: scene.schema ?? null, packId: scene.packId ?? null, sourceCount: Array.isArray(scene.sources) ? scene.sources.length : null } : null,
    selectedSourceIds: selected, blockers: [...new Set(blockers)].sort(cmp), warnings: [...new Set(warnings)].sort(cmp),
    notPerformed: ["unity-load", "webgl-initialization", "change-set-apply", "construction-approval", "cash", "clock", "demand"] };
}

// The serializable host state holds reference IDs only. It deliberately uses
// the adapter's session document instead of retaining a renderer/client blob.
export function construction3dCoordinatorDocument({ client = null, selectedSourceIds = null, selectedChangeSetId = null, session = null } = {}) {
  const base = construction3dSessionDocument({ client, selectedSourceIds, selectedChangeSetId });
  return { ...base, coordinator: session ? { mode: session.mode, packId: session.packId, scene: clone(session.scene), blockers: clone(session.blockers), warnings: clone(session.warnings) } : null };
}

export function sameConstruction3dCoordinateFrame(a, b) {
  try { return canonical(normalizeConstruction3dCoordinates(a)) === canonical(normalizeConstruction3dCoordinates(b)); } catch { return false; }
}
