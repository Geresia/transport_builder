// B23: a read-only spatial staging manifest for an optional 3D viewer. It
// labels supplied package/workfront/event facts at one requested time; it does
// not advance a schedule, calculate progress, or settle anything.

export const CONSTRUCTION_3D_STAGE_MANIFEST_SCHEMA = "transitline.construction-3d-stage-manifest/1";
export const CONSTRUCTION_3D_STAGE_NOT_COMPUTED = Object.freeze(["progress", "cost", "delay", "compensation", "risk", "schedule-verdict", "operations-settlement"]);
const text = (value) => typeof value === "string" && value.trim() ? value.trim() : null;
const clone = (value) => structuredClone(value);
const compare = (a, b) => String(a).localeCompare(String(b));
const point = (value) => Array.isArray(value) && value.length === 2 && value.every(Number.isFinite);

const entry = (value, kind) => {
  const id = text(value?.id ?? value?.[`${kind}Id`]);
  if (!id) return null;
  return { kind, id, revision: text(value?.revision ?? value?.[`${kind}Revision`]), status: text(value?.status), location: point(value?.location) ? [...value.location] : null, locationReason: point(value?.location) ? null : (value?.location === null ? "location-unknown" : "location-not-provided"), source: clone(value?.source ?? null) };
};

export function buildConstruction3dStageManifest({ pack, simMinute = null, packages = [], workfronts = [], events = [], disruptions = [] } = {}) {
  const packId = text(pack?.manifest?.id ?? pack?.id); if (!packId) throw new Error("3D stage manifest needs a pack id");
  const time = Number.isFinite(simMinute) && simMinute >= 0 ? Math.floor(simMinute) : null;
  const warnings = []; const rows = [];
  for (const [kind, values] of [["package", packages], ["workfront", workfronts], ["event", events], ["disruption", disruptions]]) {
    if (!Array.isArray(values)) { warnings.push({ code: "stage-collection-not-provided", kind }); continue; }
    for (const value of values) { const normalized = entry(value, kind); if (normalized) rows.push(normalized); else warnings.push({ code: "stage-entry-invalid", kind }); }
  }
  const seen = new Set();
  return { schema: CONSTRUCTION_3D_STAGE_MANIFEST_SCHEMA, contractVersion: 1, packId, packVersion: pack?.manifest?.version ?? pack?.version ?? null, simMinute: time,
    entries: rows.filter((row) => { const key = `${row.kind}|${row.id}`; if (seen.has(key)) { warnings.push({ code: "stage-entry-duplicate", kind: row.kind, id: row.id }); return false; } seen.add(key); return true; }).sort((a, b) => compare(a.kind, b.kind) || compare(a.id, b.id)),
    warnings: warnings.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))), notComputed: [...CONSTRUCTION_3D_STAGE_NOT_COMPUTED] };
}
