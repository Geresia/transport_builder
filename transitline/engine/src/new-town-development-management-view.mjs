// B19-M3: what the new-town development management panel shows, as plain data.  It joins three things that already exist and invents none:
//   - the map's development export (B19-M2 / B19-M1: `transitline.new-town-development-export/1`), matched by `developmentId`;
//   - the lifecycle records of B19-E1 (`runtime.newTownDevelopmentReport()`), each with the runtime's own `assessNewTownDevelopment` result;
//   - the B19-E2 demand candidates read from the lifecycle hooks (`buildNewTownDemandCandidates`, read-only).
// Every blocker and every status is copied from those results.  This module decides nothing: no step is "allowed" by its own rule, no
// default is filled in, and no population, demand, cost, occupancy rate, passengers, fare or crowding is computed or estimated.
// A row is one lifecycle record, or one map development that has no lifecycle record yet.
import { buildNewTownDemandCandidates } from "./new-town-demand-candidates.mjs";

export const MANAGEMENT_VIEW_SCHEMA = "transitline.new-town-development-management-view/1";
const EXPORT_SCHEMA = "transitline.new-town-development-export/1";

// how the map and a lifecycle record relate.  "no-record" = the map has the development and the lifecycle has none.
export const MAP_STATES = Object.freeze(["no-record", "current", "stale", "inactive", "other-pack", "map-missing", "invalid"]);
export const MAP_STATE_TEXT = Object.freeze({
  "no-record": "지도에 있음 · 생애주기 기록 없음",
  current: "현재 지도와 같음",
  stale: "낡음 (지도가 기록과 다름)",
  inactive: "지도에서 꺼져 있음",
  "other-pack": "다른 팩의 기록",
  "map-missing": "현재 지도에 없음",
  invalid: "지도 geometry를 쓸 수 없음",
});

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const clone = (v) => structuredClone(v);
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// the host's export, or the reason it cannot be used.  Nothing is repaired.
export function readGeometryExport(value) {
  if (value === null || value === undefined) return { exportData: null, problem: "geometry-export-not-provided" };
  if (!isObject(value) || value.schema !== EXPORT_SCHEMA) return { exportData: null, problem: "geometry-export-schema-invalid" };
  if (!Array.isArray(value.developments)) return { exportData: null, problem: "geometry-export-developments-unknown" };
  return { exportData: value, problem: null };
}

export const geometryOf = (exportData, developmentId) => exportData?.developments.find((d) => isObject(d) && d.developmentId === developmentId) ?? null;

// the rows, in a fixed order: by developmentId; records in the order the runtime keeps them; a development without a live record last.
export function planManagementRows(exportData, records) {
  const ids = new Set([...records.map((r) => r.developmentId), ...(exportData?.developments ?? []).filter(isObject).map((d) => d.developmentId)]);
  const rows = [];
  for (const developmentId of [...ids].sort(cmp)) {
    const geometry = geometryOf(exportData, developmentId);
    const mine = records.filter((r) => r.developmentId === developmentId);
    for (const record of mine) rows.push({ rowKey: `record:${record.id}`, developmentId, record, geometry });
    if (geometry && !mine.some((r) => r.status !== "cancelled")) rows.push({ rowKey: `map:${developmentId}`, developmentId, record: null, geometry });
  }
  return rows;
}

function mapStateOf(row, assess, exportData) {
  if (!row.record) return "no-record";
  const pack = row.record.sourcePack ?? null;
  const packChanged = pack !== null && exportData !== null && typeof exportData.packId === "string" && pack.packId !== exportData.packId;
  if (row.geometry === null) return packChanged ? "other-pack" : "map-missing";
  const { status, reasons } = assess.geometry;
  if (packChanged || reasons.includes("geometry-source-pack-changed")) return "other-pack";
  if (status === "current" || status === "stale" || status === "inactive") return status;
  return status === "missing" ? "map-missing" : "invalid";
}

function candidatesOf(row, hooks) {
  if (!row.record) return null;
  try {
    const out = buildNewTownDemandCandidates({ hooks, geometry: row.geometry });
    return {
      geometryStatus: { status: out.geometryStatus.status, reasons: [...out.geometryStatus.reasons] },
      candidates: out.candidates.map((c) => ({ phaseId: c.phaseId, status: c.inputCompleteness.status, eligibleForB15: c.eligibleForB15 })),
      phasesWithoutCandidate: out.phasesWithoutCandidate.map((p) => p.phaseId),
      notComputed: [...out.notComputed], error: null,
    };
  } catch (error) {
    return { geometryStatus: null, candidates: [], phasesWithoutCandidate: [], notComputed: [], error: String(error?.message ?? error) };
  }
}

// assessments: rowKey -> runtime.assessNewTownDevelopment result;  hooks: record id -> runtime.newTownDevelopmentHooks(id)
export function buildNewTownManagementView({ exportData = null, problem = null, records = [], assessments = {}, hooks = {}, selectedRowKey = null } = {}) {
  const rows = planManagementRows(exportData, records).map((row) => {
    const assess = assessments[row.rowKey];
    const mapState = mapStateOf(row, assess, exportData);
    return {
      rowKey: row.rowKey, developmentId: row.developmentId, recordId: row.record?.id ?? null,
      name: row.record?.name ?? row.geometry?.name ?? null, lifecycleStatus: row.record?.status ?? null, mapState,
      mapRevision: row.geometry?.developmentRevision ?? null, recordedRevision: row.record?.developmentRevision ?? null,
      assessment: { geometry: clone(assess.geometry), transitions: clone(assess.transitions), create: clone(assess.create) },
      record: row.record ? clone(row.record) : null,
      mapPhases: row.geometry ? row.geometry.phases.map((p) => ({ phaseId: p.phaseId, sequence: p.sequence, playerDeclaredLandUse: p.playerDeclaredLandUse ?? null })) : null,
      candidates: candidatesOf(row, hooks[row.record?.id]),
      selected: row.rowKey === selectedRowKey,
    };
  });
  const byMapState = Object.fromEntries(MAP_STATES.map((s) => [s, rows.filter((r) => r.mapState === s).length]));
  return {
    schema: MANAGEMENT_VIEW_SCHEMA, packId: exportData?.packId ?? null, packVersion: exportData?.packVersion ?? null, mapProblem: problem,
    rows, counts: { rows: rows.length, mapDevelopments: exportData?.developments.length ?? 0, records: records.length, byMapState },
  };
}
