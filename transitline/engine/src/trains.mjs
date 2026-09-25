// Trains are dispatched from a line's first station at the headway implied by
// the current band's trains/hour, dwell at each stop, run out to the far end
// and back, then retire. Capacity is cars * CAR_CAPACITY (see state.mjs).
import { haversineMetres } from "./projection.mjs";
import { TRAIN_SPEED_MPS, DWELL_SECONDS } from "./network.mjs";
import { handleStop } from "./passengers.mjs";
import { bandAt } from "./state.mjs";

export function lineRoundTripMinutes(state, line) {
  let metres = 0;
  for (let i = 0; i < line.stationIds.length - 1; i++) {
    metres += haversineMetres(
      state.stations.get(line.stationIds[i]).location,
      state.stations.get(line.stationIds[i + 1]).location
    );
  }
  const stops = 2 * (line.stationIds.length - 1);
  return ((2 * metres) / TRAIN_SPEED_MPS + stops * DWELL_SECONDS) / 60;
}

// Trains needed in service to hold `perHour` on this line.
export function targetTrains(state, line, bandId) {
  return (line.frequency[bandId] * lineRoundTripMinutes(state, line)) / 60;
}

export function dispatchTrains(state) {
  const band = bandAt(state);
  for (const line of state.lines) {
    if (line.suspended || line.stationIds.length < 2) continue;
    const perHour = line.frequency[band.id];
    if (perHour <= 0) continue;
    if (state.simMinutes - line.lastDispatch < 60 / perHour) continue;
    line.lastDispatch = state.simMinutes;
    const train = { id: state.nextTrainId++, lineId: line.id, segIndex: 0, t: 0, dir: 1, dwell: DWELL_SECONDS };
    state.trains.push(train);
    handleStop(state, train, line.stationIds[0]); // let waiting origin passengers board
  }
}

export function stepTrains(state, dtSeconds) {
  for (const train of state.trains) {
    const line = state.lines.find((l) => l.id === train.lineId);
    if (!line || line.stationIds.length < 2) {
      train.done = true;
      continue;
    }

    let remaining = Math.max(0, dtSeconds);
    const ids = line.stationIds;
    let guard = 0;
    while (remaining > 1e-9 && !train.done && guard++ < 10000) {
      if (train.dwell > 0) {
        const used = Math.min(train.dwell, remaining);
        train.dwell -= used;
        remaining -= used;
        if (remaining <= 1e-9) break;
      }

      const nextIndex = train.segIndex + train.dir;
      if (nextIndex < 0 || nextIndex >= ids.length) {
        train.done = true;
        break;
      }
      const from = state.stations.get(ids[train.segIndex]);
      const to = state.stations.get(ids[nextIndex]);
      const segLength = Math.max(haversineMetres(from.location, to.location), 1);
      const secondsToArrival = ((1 - train.t) * segLength) / TRAIN_SPEED_MPS;
      if (remaining + 1e-9 < secondsToArrival) {
        const movedMetres = TRAIN_SPEED_MPS * remaining;
        train.t += movedMetres / segLength;
        state.stats.trainKmByLine[String(line.id)] = (state.stats.trainKmByLine[String(line.id)] ?? 0) + movedMetres / 1000;
        remaining = 0;
        break;
      }

      remaining -= secondsToArrival;
      const movedMetres = (1 - train.t) * segLength;
      state.stats.trainKmByLine[String(line.id)] = (state.stats.trainKmByLine[String(line.id)] ?? 0) + movedMetres / 1000;
      train.t = 0;
      train.segIndex = nextIndex;
      const finished = train.segIndex === 0 && train.dir === -1;
      handleStop(state, train, ids[train.segIndex], !finished);
      if (finished) {
        train.done = true;
        break;
      }
      if (train.segIndex === ids.length - 1) train.dir = -1;
      train.dwell = DWELL_SECONDS;
    }
  }
  state.trains = state.trains.filter((t) => !t.done);
}

