// Spawning (with mode choice), route retries, abandonment, and the board/
// alight bookkeeping triggered by trains.mjs when a train stops.
import { findRoute } from "./routing.mjs";
import { chooseMode } from "./mode-choice.mjs";
import { hourOfDay, trainCapacity } from "./state.mjs";

const ABANDON_AFTER_MINUTES = 25;

export function spawnPassengers(state, model, graph, dtMinutes) {
  for (const stationId of model.origins) {
    const expected = model.rate(state, stationId) * dtMinutes;
    const count = Math.floor(expected) + (Math.random() < expected % 1 ? 1 : 0);
    for (let i = 0; i < count; i++) {
      const destinationId = model.pick(state, stationId);
      if (!destinationId) continue;

      const route = findRoute(graph, stationId, destinationId);
      const mode = chooseMode(state, state.stations.get(stationId), state.stations.get(destinationId), route);
      state.stats.spawned++;
      state.stats.spawnedByHour[hourOfDay(state)]++;
      state.stats.modeShare[mode]++;
      if (mode !== "transit") continue; // drives or walks; never reaches a station

      state.passengers.push({
        id: state.nextPassengerId++,
        originId: stationId,
        destinationId,
        currentStationId: stationId,
        route: route.hops,
        hopIndex: 0,
        state: "waiting",
        trainId: null,
        spawnedAt: state.simMinutes,
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
          continue; // drop: delivered
        }
        p.hopIndex++;
        p.currentStationId = stationId;
        p.state = "waiting";
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
  const stopIndex = train.segIndex;
  const capacity = trainCapacity(line);
  for (const p of state.passengers) {
    if (load >= capacity) break; // full: the rest keep waiting
    if (p.state !== "waiting" || !p.route || !p.route[p.hopIndex]) continue;
    const hop = p.route[p.hopIndex];
    if (hop.lineId !== line.id || hop.boardStationId !== stationId) continue;
    if (train.dir === -1 && ids.indexOf(hop.alightStationId) >= stopIndex) continue;
    p.state = "onboard";
    p.trainId = train.id;
    load++;
  }
}
