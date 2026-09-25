import { findRoute } from "./routing.mjs";

function availableAccessByDemandNode(state) {
  const result = new Map();
  const add = (demandNodeId, stationId, walkMinutes) => {
    if (!state.stations.has(stationId)) return;
    const row = result.get(demandNodeId) ?? [];
    row.push({ stationId, walkMinutes });
    result.set(demandNodeId, row);
  };
  // Legacy packs remain playable through a zero-minute adapter. New physical
  // stations can coexist and compete through explicit access links.
  for (const demandNodeId of state.demandNodes?.keys?.() ?? []) {
    if (state.stations.has(demandNodeId)) add(demandNodeId, demandNodeId, 0);
  }
  for (const link of state.accessLinks ?? []) add(link.demandNodeId, link.stationId, link.walkMinutes);
  return result;
}

export function withStationAccess(baseModel, state) {
  let cachedVersion = -1;
  let access = new Map();
  const refresh = () => {
    const version = state.accessVersion ?? state.accessLinks?.length ?? 0;
    if (version !== cachedVersion) {
      access = availableAccessByDemandNode(state);
      cachedVersion = version;
    }
  };
  return {
    ...baseModel,
    locationFor: (demandNodeId) => (state.demandNodes ?? state.stations).get(demandNodeId)?.location ?? null,
    resolveTrip: (_state, graph, originDemandNodeId, destinationDemandNodeId) => {
      refresh();
      const origins = access.get(originDemandNodeId) ?? [];
      const destinations = access.get(destinationDemandNodeId) ?? [];
      let best = null;
      for (const origin of origins) {
        for (const destination of destinations) {
          const route = findRoute(graph, origin.stationId, destination.stationId);
          if (!route?.hops?.length) continue;
          const accessSeconds = (origin.walkMinutes + destination.walkMinutes) * 60;
          const seconds = route.seconds + accessSeconds;
          if (!best || seconds < best.seconds) best = {
            originStationId: origin.stationId,
            destinationStationId: destination.stationId,
            route,
            accessSeconds,
            seconds,
          };
        }
      }
      return best;
    },
  };
}
