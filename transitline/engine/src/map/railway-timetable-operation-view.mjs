// Read-only map facts for railway timetable operation. It neither dispatches a
// train nor computes routes, delays, money or passenger numbers.
export const TIMETABLE_OPERATION_VIEW_SCHEMA = "transitline.railway-timetable-operation-map-view/1";
export const TIMETABLE_STATUS_STYLE = Object.freeze({
  active: { color: "#4ade80", dash: [], label: "active" }, approved: { color: "#60a5fa", dash: [7, 3], label: "approved" },
  assessed: { color: "#fbbf24", dash: [3, 3], label: "assessed" }, withdrawn: { color: "#9ca3af", dash: [2, 4], label: "withdrawn" }, superseded: { color: "#a78bfa", dash: [8, 3], label: "superseded" },
});
const text = (a, b) => String(a).localeCompare(String(b));
const list = (v) => v instanceof Map ? [...v.values()] : Array.isArray(v) ? v : v && typeof v === "object" ? Object.values(v) : [];
const loc = (v) => Array.isArray(v?.location) && v.location.length >= 2 && v.location.slice(0, 2).every(Number.isFinite) ? v.location.slice(0, 2) : null;
function shape(line, stations) { const ids = (line?.stationIds ?? []).map(String); const points = ids.map((id) => loc(stations.get(id))); return { stationIds: ids, points: points.every(Boolean) ? points : null, missingStationIds: ids.filter((_, i) => !points[i]) }; }
function trainPoint(train, stations) { const ids = (train?.serviceStationIds ?? []).map(String); const i = train?.segIndex; const dir = train?.dir; if (!Number.isInteger(i) || ![-1, 1].includes(dir) || !Number.isFinite(train?.t)) return null; const a = loc(stations.get(ids[i])); const b = loc(stations.get(ids[i + dir])); if (!a || !b) return null; const t = Math.max(0, Math.min(1, Number(train.t))); return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]; }

// Association is only through the factual line.timetableDispatches.timetableId.
// It never guesses from display names or a route that the view does not have.
export function buildRailwayTimetableOperationView({ timetables = [], lines = [], trains = [], stations = [], selectedTimetableId = null } = {}) {
  const stationById = new Map(list(stations).filter((x) => x?.id !== undefined).map((x) => [String(x.id), x]));
  const tableById = new Map(list(timetables).filter((x) => typeof x?.id === "string").map((x) => [x.id, x]));
  const missingStations = []; const missingTables = [];
  const lineViews = list(lines).filter((line) => line?.id !== undefined).map((line) => {
    const outline = shape(line, stationById); missingStations.push(...outline.missingStationIds);
    const dispatches = Object.values(line.timetableDispatches ?? {}).filter((x) => x && typeof x === "object");
    const schedules = [...new Map(dispatches.filter((x) => typeof x.timetableId === "string").map((d) => [d.timetableId, d])).entries()].map(([id, dispatch]) => {
      const table = tableById.get(id) ?? null; if (!table) missingTables.push(id); const style = TIMETABLE_STATUS_STYLE[table?.status] ?? { color: "#94a3b8", dash: [2, 4], label: table ? String(table.status) : "unknown" };
      return { timetableId: id, status: table?.status ?? null, statusLabel: style.label, color: style.color, dash: style.dash, dayType: dispatch.dayType ?? table?.dayType ?? null, serviceId: dispatch.serviceId ?? null, blockedReason: dispatch.blockedReason ?? null, departureMinutes: Array.isArray(dispatch.departureMinutes) ? [...dispatch.departureMinutes] : null, missedDepartures: Number.isFinite(dispatch.missedDepartures) ? dispatch.missedDepartures : null };
    }).sort((a, b) => text(a.timetableId, b.timetableId));
    return { lineId: String(line.id), name: line.name ?? null, shape: outline, schedules, selected: schedules.some((x) => x.timetableId === selectedTimetableId) };
  }).sort((a, b) => text(a.lineId, b.lineId));
  const trainViews = list(trains).filter((t) => t && t.done !== true).map((train) => { const p = trainPoint(train, stationById); if (!p) missingStations.push(...(train.serviceStationIds ?? [])); const table = typeof train.timetableId === "string" ? tableById.get(train.timetableId) : null; return { trainId: String(train.id), lineId: train.lineId === undefined ? null : String(train.lineId), timetableId: train.timetableId ?? null, managementServiceId: train.managementServiceId ?? null, scheduledDepartureMinute: train.scheduledDepartureMinute ?? null, location: p, timetableStatus: table?.status ?? null, color: TIMETABLE_STATUS_STYLE[table?.status]?.color ?? "#e2e8f0", selected: train.timetableId === selectedTimetableId }; }).sort((a, b) => text(a.trainId, b.trainId));
  const tableViews = [...tableById.values()].map((table) => { const style = TIMETABLE_STATUS_STYLE[table.status] ?? { color: "#94a3b8", label: String(table.status ?? "unknown") }; return { timetableId: table.id, status: table.status ?? null, statusLabel: style.label, color: style.color, dayType: table.dayType ?? null, requestedPathCount: table.requestedPaths ?? null, acceptedPathCount: Array.isArray(table.acceptedPaths) ? table.acceptedPaths.length : null, selected: table.id === selectedTimetableId }; }).sort((a, b) => text(a.timetableId, b.timetableId));
  const validSelected = tableViews.some((x) => x.timetableId === selectedTimetableId) ? selectedTimetableId : null;
  return { schema: TIMETABLE_OPERATION_VIEW_SCHEMA, status: tableViews.length ? "available" : "none", timetables: tableViews, lines: lineViews, trains: trainViews, selectedTimetableId: validSelected, missing: { stations: [...new Set(missingStations.map(String))].sort(text), timetableRecords: [...new Set(missingTables)].sort(text) }, banner: tableViews.length ? null : "No railway timetable is recorded." };
}
const path = (ctx, pts) => pts.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
function label(ctx, value, at, color) { ctx.font = "10px system-ui"; ctx.lineWidth = 3; ctx.strokeStyle = "#111827"; ctx.strokeText(value, ...at); ctx.fillStyle = color; ctx.fillText(value, ...at); }
export function drawRailwayTimetableOperationOverlay(ctx, model, screen) { ctx.save(); for (const line of model.lines) for (const schedule of line.schedules) { if (!line.shape.points) continue; ctx.globalAlpha = schedule.status === "active" ? .95 : .52; ctx.strokeStyle = schedule.color; ctx.lineWidth = schedule.status === "active" ? 5 : 3; ctx.setLineDash(schedule.dash); ctx.beginPath(); path(ctx, line.shape.points.map(screen)); ctx.stroke(); ctx.setLineDash([]); const p = screen(line.shape.points[0]); label(ctx, `${schedule.statusLabel}: ${schedule.timetableId}`, [p[0] + 5, p[1] - 7], schedule.color); } ctx.globalAlpha = 1; for (const train of model.trains) { if (!train.location) continue; const [x, y] = screen(train.location); ctx.fillStyle = train.color; ctx.strokeStyle = "#111827"; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, train.selected ? 7 : 5, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); label(ctx, train.timetableId ?? "legacy", [x + 8, y], train.color); } ctx.restore(); }
