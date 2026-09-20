// Spawning, routing retries, abandonment, and the board/alight bookkeeping
// triggered by trains.mjs when a train stops at a station.
import { findRoute } from "./routing.mjs";
import { pickDestination } from "./demand-engine.mjs";
import { hourOfDay } from "./state.mjs";

const ABANDON_AFTER_MINUTES = 25;

export function spawnPassengers(state, gravityModel, graph, factor, dtMinutes) {
  for (const stationId of state.stations.keys()) {
    const entry = gravityModel.weights.get(stationId);
    if (!entry) continue;
    const expected = entry.spawnRate * factor * dtMinutes;
    const count = Math.floor(expected) + (Math.random() < expected % 1 ? 1 : 0);
    for (let i = 0; i < count; i++) {
      const destinationId = pickDestination(gravityModel, stationId);
      if (!destinationId) continue;
      state.passengers.push({
        id: state.nextPassengerId++,
        originId: stationId,
        destinationId,
        currentStationId: stationId,
        route: findRoute(graph, stationId, destinationId),
        hopIndex: 0,
        state: "waiting",
        trainLineId: null,
        spawnedAt: state.simMinutes,
      });
      state.stats.spawned++;
      state.stats.spawnedByHour[hourOfDay(state)]++;
    }
  }
}

// Waiting passengers whose route was null (network not connected yet at
// spawn time) get another shot whenever the network changes.
export function retryPendingRoutes(state, graph) {
  for (const p of state.passengers) {
    if (p.state === "waiting" && !p.route) {
      p.route = findRoute(graph, p.currentStationId, p.destinationId);
      p.hopIndex = 0;
    }
  }
}

export function expirePassengers(state) {
  state.passengers = state.passengers.filter((p) => {
    if (p.state === "waiting" && state.simMinutes - p.spawnedAt > ABANDON_AFTER_MINUTES) {
      state.stats.abandoned++;
      return false;
    }
    return true;
  });
}

// Called by trains.mjs when a train on `lineId` stops at `stationId`.
export function handleStop(state, lineId, stationId) {
  // Alight first so a same-station transfer can re-board within this stop.
  const stillHere = [];
  for (const p of state.passengers) {
    if (p.state === "onboard" && p.trainLineId === lineId && p.route[p.hopIndex].alightStationId === stationId) {
      p.trainLineId = null;
      if (p.hopIndex === p.route.length - 1) {
        state.stats.delivered++;
        state.stats.deliveredByHour[hourOfDay(state)]++;
        continue; // drop: delivered
      }
      p.hopIndex++;
      p.currentStationId = stationId;
      p.state = "waiting";
    }
    stillHere.push(p);
  }
  state.passengers = stillHere;

  for (const p of state.passengers) {
    if (p.state !== "waiting" || !p.route || !p.route[p.hopIndex]) continue;
    const hop = p.route[p.hopIndex];
    if (hop.lineId !== lineId || hop.boardStationId !== stationId) continue;
    p.state = "onboard";
    p.trainLineId = lineId;
  }
}
