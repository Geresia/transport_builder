// Moves each line's train at constant speed, ping-ponging between the two
// ends of its station sequence, and fires passengers.mjs's handleStop on
// every arrival. No capacity/crowding — Phase 3 owns that.
import { haversineMetres } from "./projection.mjs";
import { TRAIN_SPEED_MPS } from "./network.mjs";
import { handleStop } from "./passengers.mjs";

export function stepTrains(state, dtSeconds) {
  for (const train of state.trains) {
    const line = state.lines.find((l) => l.id === train.lineId);
    if (!line || line.stationIds.length < 2) continue;

    const ids = line.stationIds;
    const from = state.stations.get(ids[train.segIndex]);
    const to = state.stations.get(ids[train.segIndex + train.dir]);
    const segLength = Math.max(haversineMetres(from.location, to.location), 1);

    train.t += (TRAIN_SPEED_MPS * dtSeconds) / segLength;
    while (train.t >= 1) {
      train.t -= 1;
      train.segIndex += train.dir;
      handleStop(state, line.id, ids[train.segIndex]);
      const next = train.segIndex + train.dir;
      if (next < 0 || next >= ids.length) train.dir *= -1; // reverse at the terminus
    }
  }
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
