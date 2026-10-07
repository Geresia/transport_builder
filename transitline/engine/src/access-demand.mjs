import { findRoute } from "./routing.mjs";

function appliedAllocationLinksByDemandNode(state) {
  const result = new Map();
  for (const link of state.stationDemandAllocationLinks ?? []) {
    if (!state.demandNodes?.has?.(link?.demandNodeId)) continue;
    if (!state.stations?.has?.(link?.stationId)) continue;
    if (!(link.walkMinutes > 0) || !Number.isFinite(link.walkMinutes)) continue;
    const row = result.get(link.demandNodeId) ?? [];
    row.push({ stationId: link.stationId, walkMinutes: link.walkMinutes });
    result.set(link.demandNodeId, row);
  }
  return result;
}

function availableAccessByDemandNode(state) {
  const result = new Map();
  const add = (demandNodeId, stationId, walkMinutes) => {
    if (!state.stations.has(stationId)) return;
    const row = result.get(demandNodeId) ?? [];
    row.push({ stationId, walkMinutes });
    result.set(demandNodeId, row);
  };
  // A B15 allocation is an explicit player decision for one demand node. It
  // therefore replaces both the legacy zero-minute adapter and geometry's
  // automatic-radius links only for that node; every other node stays exactly
  // on the legacy path. Allocation links are kept in their own collection so
  // applying a policy never overwrites project geometry facts.
  const allocated = appliedAllocationLinksByDemandNode(state);
  for (const demandNodeId of state.demandNodes?.keys?.() ?? []) {
    const row = allocated.get(demandNodeId);
    if (row?.length) {
      for (const link of row) add(demandNodeId, link.stationId, link.walkMinutes);
    } else if (state.stations.has(demandNodeId)) {
      // Legacy packs remain playable through a zero-minute adapter. New physical
      // stations can coexist and compete through explicit access links.
      add(demandNodeId, demandNodeId, 0);
    }
  }
  for (const link of state.accessLinks ?? []) {
    if (allocated.has(link.demandNodeId)) continue;
    add(link.demandNodeId, link.stationId, link.walkMinutes);
  }
  return result;
}

export function withStationAccess(baseModel, state) {
  let cachedVersion = -1;
  let access = new Map();
  const refresh = () => {
    const version = `${state.accessVersion ?? state.accessLinks?.length ?? 0}:${state.stationDemandAllocationVersion ?? state.stationDemandAllocationLinks?.length ?? 0}`;
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
