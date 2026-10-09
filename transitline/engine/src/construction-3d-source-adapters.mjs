// B22/B23 bridge: normalize current 2D map contracts into B21 source facts.
// It copies supplied geometry and identity only; it never creates a mesh,
// terrain, conflict verdict, schedule, or engineering decision.

const clone = (value) => structuredClone(value);
const text = (value) => typeof value === "string" && value.trim() ? value.trim() : null;
const cmp = (a, b) => String(a).localeCompare(String(b));
const list = (value, key) => Array.isArray(value) ? value : Array.isArray(value?.[key]) ? value[key] : [];
const point = (value) => Array.isArray(value) && value.length === 2 && value.every(Number.isFinite);

export const CONSTRUCTION_3D_SOURCE_ADAPTER_SCHEMA = "transitline.construction-3d-source-adapter/1";

export function construction3dSourcesFrom2d({ railGeometries = [], stationSites = [], depotSites = [], developments = [] } = {}) {
  const rows = []; const warnings = [];
  const add = (sourceType, sourceId, sourceRevision, sourcePackId, active, geometry) => {
    if (!sourceId || !sourceRevision) { warnings.push({ code: "source-identity-missing", sourceType, sourceId: sourceId ?? null }); return; }
    rows.push({ sourceType, sourceId, sourceRevision, sourcePackId: sourcePackId ?? null, active: active !== false, geometry: geometry === undefined ? null : clone(geometry) });
  };
  for (const rail of list(railGeometries, "designs")) {
    const id = text(rail?.railGeometryId); const revision = text(rail?.railGeometryRevision);
    const lines = Array.isArray(rail?.sections) ? rail.sections.map((section) => Array.isArray(section?.alignment) ? clone(section.alignment) : null).filter(Boolean) : null;
    add("rail-geometry", id, revision, text(rail?.sourcePackId), rail?.active, lines);
  }
  for (const site of list(stationSites, "sites")) add("station-site", text(site?.stationSiteId), text(site?.stationSiteRevision ?? site?.revision), text(site?.sourcePackId), site?.active, point(site?.center) ? [site.center] : null);
  for (const site of list(depotSites, "sites")) add("depot-site", text(site?.depotSiteId), text(site?.depotSiteRevision ?? site?.revision), text(site?.sourcePackId), site?.active, clone(site?.polygon ?? null));
  for (const development of list(developments, "developments")) {
    const id = text(development?.developmentId); const revision = text(development?.developmentRevision);
    const polygons = Array.isArray(development?.phases) ? development.phases.map((phase) => phase?.polygon ?? null).filter(Boolean) : null;
    add("new-town-development", id, revision, text(development?.sourcePackId), development?.active, polygons);
  }
  const kept = new Map();
  for (const row of rows) { const key = `${row.sourceType}|${row.sourceId}`; if (kept.has(key)) warnings.push({ code: "source-duplicate", sourceType: row.sourceType, sourceId: row.sourceId }); else kept.set(key, row); }
  return { schema: CONSTRUCTION_3D_SOURCE_ADAPTER_SCHEMA, contractVersion: 1, sources: [...kept.values()].sort((a, b) => cmp(a.sourceType, b.sourceType) || cmp(a.sourceId, b.sourceId)), warnings: warnings.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))), notComputed: ["mesh", "terrain", "conflict", "cost", "schedule", "approval"] };
}
