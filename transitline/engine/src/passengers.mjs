// Spawning (with mode choice), route retries, abandonment, and the board/
// alight bookkeeping triggered by trains.mjs when a train stops.
import { findRoute } from "./routing.mjs";
import { chooseMode } from "./mode-choice.mjs";
import { hourOfDay, trainCapacity } from "./state.mjs";
import { randomFrom } from "./rng.mjs";
import { recordThroughPassengerDelivery } from "./through-operation-integration.mjs";

// Commuters do not give up on a crowded platform (user decision 2026-09-26; the reference game has no wait limit
// either). Only a passenger stuck for a whole 12 h - e.g. stranded by a deleted line - is swept away, like the game's
// hourly stuck-movement sweep. `stats.abandoned` now counts those stranded ones.
const ABANDON_AFTER_MINUTES = 12 * 60;

export function spawnPassengers(state, model, graph, dtMinutes) {
  const random = randomFrom(state);
  for (const demandOriginId of model.origins) {
    const expected = model.rate(state, demandOriginId) * dtMinutes;
    const count = Math.floor(expected) + (random() < expected % 1 ? 1 : 0);
    for (let i = 0; i < count; i++) {
      const demandDestinationId = model.pick(state, demandOriginId, random);
      if (!demandDestinationId) continue;

      const resolved = model.resolveTrip?.(state, graph, demandOriginId, demandDestinationId) ?? null;
      const originStationId = resolved?.originStationId ?? demandOriginId;
      const destinationStationId = resolved?.destinationStationId ?? demandDestinationId;
      const route = resolved?.route ?? findRoute(graph, originStationId, destinationStationId);
      const perceivedRoute = route && resolved ? { ...route, seconds: route.seconds + resolved.accessSeconds } : route;
      const origin = model.locationFor?.(demandOriginId) ? { location: model.locationFor(demandOriginId) } : state.stations.get(demandOriginId);
      const destination = model.locationFor?.(demandDestinationId) ? { location: model.locationFor(demandDestinationId) } : state.stations.get(demandDestinationId);
      if (!origin || !destination) continue;
      const mode = chooseMode(state, origin, destination, perceivedRoute, random);
      state.stats.spawned++;
      state.stats.spawnedByHour[hourOfDay(state)]++;
      state.stats.modeShare[mode]++;
      if (mode !== "transit") continue; // drives or walks; never reaches a station

      state.passengers.push({
        id: state.nextPassengerId++,
        originId: originStationId,
        destinationId: destinationStationId,
        demandOriginId,
        demandDestinationId,
        currentStationId: originStationId,
        route: route.hops,
        hopIndex: 0,
        state: "waiting",
        trainId: null,
        spawnedAt: state.simMinutes,
        waitingSince: state.simMinutes,
      });
    }
  }
}

// Waiting passengers whose route was invalidated (e.g. a line was deleted)
// get another shot whenever the network changes.
export function retryPendingRoutes(state, graph) {
  for (const p of state.passengers) {
    if (p.state === "waiting" && !p.route) {
      p.route = findRoute(graph, p.currentStationId, p.destinationId)?.hops ?? null;
      p.hopIndex = 0;
      p.waitingSince = state.simMinutes;
    }
  }
}

export function expirePassengers(state) {
  state.passengers = state.passengers.filter((p) => {
    const waitingSince = p.waitingSince ?? p.spawnedAt;
    if (p.state === "waiting" && state.simMinutes - waitingSince > ABANDON_AFTER_MINUTES) {
      state.stats.abandoned++;
      return false;
    }
    return true;
  });
}

// Called by trains.mjs when `train` stops at `stationId`. `allowBoarding` is
// false at a terminating train's final stop so nobody boards a train that is
// about to leave service.
export function handleStop(state, train, stationId, allowBoarding = true) {
  const line = state.lines.find((l) => l.id === train.lineId);

  // Alight first so a same-station transfer can re-board within this stop.
  const stillHere = [];
  let load = 0;
  for (const p of state.passengers) {
    if (p.state === "onboard" && p.trainId === train.id) {
      if (p.route[p.hopIndex].alightStationId === stationId) {
        p.trainId = null;
        if (p.hopIndex === p.route.length - 1) {
          state.stats.delivered++;
          state.stats.deliveredByHour[hourOfDay(state)]++;
          state.stats.deliveredByLine[String(train.lineId)] = (state.stats.deliveredByLine[String(train.lineId)] ?? 0) + 1;
          recordThroughPassengerDelivery(state, line, p);
          continue; // drop: delivered
        }
        p.hopIndex++;
        p.currentStationId = stationId;
        p.state = "waiting";
        p.waitingSince = state.simMinutes;
      } else {
        load++;
      }
    }
    stillHere.push(p);
  }
  state.passengers = stillHere;
  if (!allowBoarding || !line) return;

  // A train on its way back can only carry riders to stations still ahead of
  // it; otherwise they would ride to the terminus and be stranded.
  const ids = line.stationIds;
  const stopIndex = ids.indexOf(stationId);
  const capacity = trainCapacity(line);
  for (const p of state.passengers) {
    if (load >= capacity) break; // full: the rest keep waiting
    if (p.state !== "waiting" || !p.route || !p.route[p.hopIndex]) continue;
    const hop = p.route[p.hopIndex];
    if (hop.lineId !== line.id || hop.boardStationId !== stationId) continue;
    const alightIndex = ids.indexOf(hop.alightStationId);
    if (alightIndex < 0) continue;
    if (train.dir === 1 && alightIndex <= stopIndex) continue;
    if (train.dir === -1 && alightIndex >= stopIndex) continue;
    p.state = "onboard";
    p.trainId = train.id;
    load++;
  }
}
