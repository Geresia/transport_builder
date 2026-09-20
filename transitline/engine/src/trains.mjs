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

    let remaining = dtSeconds;
    if (train.dwell > 0) {
      const used = Math.min(train.dwell, remaining);
      train.dwell -= used;
      remaining -= used;
    }
    if (remaining <= 0) continue;

    const ids = line.stationIds;
    const from = state.stations.get(ids[train.segIndex]);
    const to = state.stations.get(ids[train.segIndex + train.dir]);
    const segLength = Math.max(haversineMetres(from.location, to.location), 1);

    train.t += (TRAIN_SPEED_MPS * remaining) / segLength;
    if (train.t < 1) continue;

    // One arrival per tick: the dwell that follows uses the rest of the time.
    train.t -= 1;
    train.segIndex += train.dir;
    const finished = train.segIndex === 0 && train.dir === -1;
    handleStop(state, train, ids[train.segIndex], !finished);
    if (finished) {
      train.done = true; // back at the origin: round trip complete
      continue;
    }
    train.dwell = DWELL_SECONDS;
    if (train.segIndex + train.dir >= ids.length) train.dir = -1; // reverse at the far terminus
  }
  state.trains = state.trains.filter((t) => !t.done);
}

export function trainScreenPosition(state, train, projection, width, height) {
  const line = state.lines.find((l) => l.id === train.lineId);
  const ids = line.stationIds;
  const from = state.stations.get(ids[train.segIndex]);
  const to = state.stations.get(ids[train.segIndex + train.dir]);
  const [fx, fy] = projection.toScreen(from.location, width, height);
  const [tx, ty] = projection.toScreen(to.location, width, height);
  return [fx + (tx - fx) * train.t, fy + (ty - fy) * train.t];
}
