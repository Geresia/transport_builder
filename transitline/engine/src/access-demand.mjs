import { findRoute } from "./routing.mjs";

// B15-E5: a demand node whose applied allocation links share it (60 % here, 40 % there) is routed by an explicit, deterministic
// schedule — never by "the closest station wins".  The schedule draws no random number: every call for such a node and role
// (origin / destination) takes the slot whose running count is furthest below its share of the trips so far, so after n trips each
// slot holds n x share (within one trip).  A share nobody routes (an unallocated remainder, a station that is gone) is a slot too:
// those trips get no station access at all and are never handed to a legacy link.  The counts live in the operational state, so a
// save and a restore carry on with the same sequence.  A node with no split link behaves exactly as before.
const MICRO = 1_000_000;
const WHOLE = 1 - 1e-9;
const NOBODY = ""; // slot id of the share that no station takes

function appliedAllocationLinksByDemandNode(state) {
  const result = new Map();
  for (const link of state.stationDemandAllocationLinks ?? []) {
    if (!state.demandNodes?.has?.(link?.demandNodeId)) continue;
    if (!state.stations?.has?.(link?.stationId)) continue;
    if (!(link.walkMinutes > 0) || !Number.isFinite(link.walkMinutes)) continue;
    const share = link.share === undefined ? 1 : link.share; // links written before B15-E5 carry no share: the whole node
    if (!Number.isFinite(share) || !(share > 0) || share > 1) continue;
    const row = result.get(link.demandNodeId) ?? [];
    row.push({ stationId: link.stationId, walkMinutes: link.walkMinutes, share });
    result.set(link.demandNodeId, row);
  }
  return result;
}

// A node is split when its valid links do not simply say "this one station, all of it".
function splitOf(row) {
  if (row.length === 1 && row[0].share >= WHOLE) return null;
  const byStation = new Map();
  for (const link of row) {
    const old = byStation.get(link.stationId);
    byStation.set(link.stationId, old ? { ...old, share: old.share + link.share, walkMinutes: Math.min(old.walkMinutes, link.walkMinutes) } : { ...link });
  }
  const slots = [...byStation.values()]
    .sort((a, b) => (a.stationId < b.stationId ? -1 : a.stationId > b.stationId ? 1 : 0))
    .map((link) => ({ id: link.stationId, stationId: link.stationId, walkMinutes: link.walkMinutes, micro: Math.round(Math.min(1, link.share) * MICRO) }));
  const left = MICRO - slots.reduce((sum, slot) => sum + slot.micro, 0);
  if (left > 0) slots.push({ id: NOBODY, stationId: null, walkMinutes: null, micro: left });
  return { slots, signature: slots.map((slot) => `${slot.id}:${slot.micro}`).join("|") };
}

function availableAccessByDemandNode(state) {
  const result = new Map();
  const splits = new Map();
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
      const split = splitOf(row);
      if (split) splits.set(demandNodeId, split);
      else for (const link of row) add(demandNodeId, link.stationId, link.walkMinutes);
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
  return { access: result, splits };
}

// The next slot of a split node for one role.  Integer arithmetic only (shares are held in millionths), ties go to the lowest
// station id, and the only thing that moves is the count kept in the state — no RNG, no clock.
function nextSlot(state, key, split) {
  const cursors = (state.stationDemandAllocationCursors ??= {});
  let cursor = cursors[key];
  if (!cursor || cursor.signature !== split.signature) cursor = cursors[key] = { signature: split.signature, total: 0, taken: {} };
  const next = cursor.total + 1;
  let best = null;
  let bestDeficit = -Infinity;
  for (const slot of split.slots) {
    const deficit = slot.micro * next - (cursor.taken[slot.id] ?? 0) * MICRO;
    if (deficit > bestDeficit) { best = slot; bestDeficit = deficit; }
  }
  cursor.total = next;
  cursor.taken[best.id] = (cursor.taken[best.id] ?? 0) + 1;
  return best;
}

const unroutedTrip = () => ({ unrouted: true, originStationId: null, destinationStationId: null, route: null, accessSeconds: 0, seconds: Infinity });

export function withStationAccess(baseModel, state) {
  let cachedVersion = -1;
  let access = new Map();
  let splits = new Map();
  const refresh = () => {
    const version = `${state.accessVersion ?? state.accessLinks?.length ?? 0}:${state.stationDemandAllocationVersion ?? state.stationDemandAllocationLinks?.length ?? 0}`;
    if (version !== cachedVersion) {
      ({ access, splits } = availableAccessByDemandNode(state));
      cachedVersion = version;
    }
  };
  // The stations a node may use for this trip: all its links, or — for a split node — the one its schedule gives (or none).
  const side = (demandNodeId, role) => {
    const split = splits.get(demandNodeId);
    if (!split) return { options: access.get(demandNodeId) ?? [], split: false };
    const slot = nextSlot(state, `${role}|${demandNodeId}`, split);
    return slot.stationId === null ? { options: [], split: true, nobody: true } : { options: [{ stationId: slot.stationId, walkMinutes: slot.walkMinutes }], split: true };
  };
  return {
    ...baseModel,
    locationFor: (demandNodeId) => (state.demandNodes ?? state.stations).get(demandNodeId)?.location ?? null,
    resolveTrip: (_state, graph, originDemandNodeId, destinationDemandNodeId) => {
      refresh();
      // Both roles always advance their own schedule, so origin and destination splits stay independent of each other.
      const originSide = side(originDemandNodeId, "origin");
      const destinationSide = side(destinationDemandNodeId, "destination");
      if (originSide.nobody || destinationSide.nobody) return unroutedTrip();
      let best = null;
      for (const origin of originSide.options) {
        for (const destination of destinationSide.options) {
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
      // A split node whose scheduled station has no route does not fall back to a legacy path or to its other station.
      if (!best && (originSide.split || destinationSide.split)) return unroutedTrip();
      return best;
    },
  };
}
