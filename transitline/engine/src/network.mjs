// Builds a routing graph from the player-drawn lines. Nodes are
// `${stationId}|${lineId}` pairs rather than bare stations so a line change
// costs a transfer penalty in routing.mjs's Dijkstra.
import { haversineMetres } from "./projection.mjs";
import { effectiveLineStationGroups } from "./railway-service-control.mjs";
import { railReplacementGraphServices } from "./rail-replacement-operations.mjs";

export const TRAIN_SPEED_MPS = 12; // running speed between stops (~43 km/h)
export const DWELL_SECONDS = 20; // Subway Builder's STATION_STOP_TIME default
const TRANSFER_PENALTY_SECONDS = 180;

export function buildRouteGraph(state) {
  const adj = new Map(); // node -> [{ to, weight }]
  const stationLines = new Map(); // stationId -> Set(lineId)

  const addEdge = (a, b, weight) => {
    if (!adj.has(a)) adj.set(a, []);
    adj.get(a).push({ to: b, weight });
  };

  for (const line of state.lines) {
    if (line.suspended) continue;
    for (const ids of effectiveLineStationGroups(state, line)) {
      for (const sid of ids) {
        if (!stationLines.has(sid)) stationLines.set(sid, new Set());
        stationLines.get(sid).add(line.id);
      }
      for (let i = 0; i < ids.length - 1; i++) {
        const a = state.stations.get(ids[i]);
        const b = state.stations.get(ids[i + 1]);
        const weight = haversineMetres(a.location, b.location) / TRAIN_SPEED_MPS + DWELL_SECONDS;
        addEdge(`${ids[i]}|${line.id}`, `${ids[i + 1]}|${line.id}`, weight);
        addEdge(`${ids[i + 1]}|${line.id}`, `${ids[i]}|${line.id}`, weight);
      }
    }
  }

  for (const service of railReplacementGraphServices(state)) {
    for (const stationId of service.stationIds) {
      if (!stationLines.has(stationId)) stationLines.set(stationId, new Set());
      stationLines.get(stationId).add(service.lineId);
    }
    for (let index = 0; index < service.stationIds.length - 1; index += 1) {
      const from = service.stationIds[index];
      const to = service.stationIds[index + 1];
      const weight = service.legSeconds[index] + service.dwellSeconds;
      addEdge(`${from}|${service.lineId}`, `${to}|${service.lineId}`, weight);
      addEdge(`${to}|${service.lineId}`, `${from}|${service.lineId}`, weight);
    }
  }

  for (const [sid, lineSet] of stationLines) {
    const lines = [...lineSet];
    for (const a of lines) {
      for (const b of lines) {
        if (a !== b) addEdge(`${sid}|${a}`, `${sid}|${b}`, TRANSFER_PENALTY_SECONDS);
      }
    }
  }

  return { adj, stationLines };
}
