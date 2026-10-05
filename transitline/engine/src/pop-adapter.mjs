// Read-only bridge from the old engine's state (state.mjs lines/trains, trains.mjs motion) to what the pop model wants:
//   patternsFromState  -> router-raptor patterns (one out-and-back pattern per running line)
//   popTrains          -> pop-journey train objects { id, routeId, stopped, stationId, stationsAhead, maxCapacity }
// routeId is the old line id. trains.mjs is never edited; a train that finishes its round trip is removed by
// stepTrains within the same step, so popSimStep (pop-sim.mjs) passes `terminalGhost` for it once.
import { haversineMetres } from "./projection.mjs";
import { TRAIN_SPEED_MPS, DWELL_SECONDS } from "./network.mjs";
import { bandAt } from "./state.mjs";
import { TRAIN_TYPES, DEFAULT_TRAIN_TYPE } from "./rules.mjs";
import { outAndBackPattern } from "./router-raptor.mjs";
import { effectiveLineStationGroups } from "./railway-service-control.mjs";
import { activeRailReplacementOperations, railReplacementTripViews, REPLACEMENT_BUS_CLASSES } from "./rail-replacement-operations.mjs";

// Lines dispatchTrains would actually run: not suspended, two or more stations, a frequency for the current band.
export function runningLines(state) {
  const band = bandAt(state).id;
  return state.lines.filter((l) => !l.suspended && l.stationIds.length >= 2 && l.frequency[band] > 0);
}

export function patternsFromState(state, nowS) {
  const band = bandAt(state).id;
  const rail = runningLines(state).flatMap((line) => effectiveLineStationGroups(state, line).map((stationIds) => {
    const legSeconds = [];
    for (let i = 0; i < stationIds.length - 1; i++) {
      legSeconds.push(haversineMetres(state.stations.get(stationIds[i]).location, state.stations.get(stationIds[i + 1]).location) / TRAIN_SPEED_MPS);
    }
    const headwayS = 3600 / line.frequency[band];
    // the next dispatch happens one headway after the last one (dispatchTrains); a never-dispatched line leaves at once
    const phaseS = Number.isFinite(line.lastDispatch) ? line.lastDispatch * 60 + headwayS : nowS;
    return outAndBackPattern({ routeId: line.id, stationIds, legSeconds, dwellS: DWELL_SECONDS, headwayS, phaseS });
  }));
  const replacement = activeRailReplacementOperations(state).map((operation) => {
    const vehicle = REPLACEMENT_BUS_CLASSES[operation.vehicleClassId];
    return outAndBackPattern({
      routeId: operation.virtualLineId,
      stationIds: operation.stationIds,
      legSeconds: operation.legDistancesMeters.map((distance) => distance / vehicle.averageSpeedMps),
      dwellS: vehicle.dwellSeconds,
      headwayS: operation.headwaySeconds,
      phaseS: Number.isFinite(operation.lastDispatchMinute) ? operation.lastDispatchMinute * 60 + operation.headwaySeconds : nowS,
    });
  });
  return [...rail, ...replacement];
}

export const trainCapacityPop = (line, trainType = DEFAULT_TRAIN_TYPE) => line.carsPerTrain * TRAIN_TYPES[trainType].capacityPerCar;

// Stations from the train's current stop on, in travel order (the turn-back repeats the far end's neighbours).
function stationsAhead(ids, segIndex, dir) {
  if (dir === -1) return ids.slice(0, segIndex + 1).reverse();
  return [...ids.slice(segIndex), ...ids.slice(0, -1).reverse()];
}

export function popTrains(state, trainType = DEFAULT_TRAIN_TYPE) {
  const out = [];
  for (const t of state.trains) {
    const line = state.lines.find((l) => l.id === t.lineId);
    if (!line || t.done) continue;
    const stationIds = Array.isArray(t.serviceStationIds) && t.serviceStationIds.length >= 2 ? t.serviceStationIds : line.stationIds;
    out.push({
      id: t.id,
      routeId: line.id,
      stopped: t.dwell > 0 && t.t === 0,
      stationId: stationIds[t.segIndex],
      stationsAhead: stationsAhead(stationIds, t.segIndex, t.dir),
      maxCapacity: trainCapacityPop(line, trainType),
    });
  }
  return [...out, ...railReplacementTripViews(state)];
}

// Built infrastructure (every line with 2+ stations, regardless of suspension or frequency: maintenance is a fixed
// asset cost, not a service cost) for the maintenance charge in economy.mjs's maintenanceCost.
export function networkFootprint(state) {
  let trackLengthM = 0;
  const stationIds = new Set();
  for (const line of state.lines) {
    if (line.stationIds.length < 2) continue;
    for (const id of line.stationIds) stationIds.add(id);
    for (let i = 0; i < line.stationIds.length - 1; i++) {
      trackLengthM += haversineMetres(state.stations.get(line.stationIds[i]).location, state.stations.get(line.stationIds[i + 1]).location);
    }
  }
  return { trackLengthM, stationCount: stationIds.size };
}

// A train removed by stepTrains at its terminal: riders bound for the line's first station still get off there.
export function terminalGhost(train, line, trainType = DEFAULT_TRAIN_TYPE) {
  const first = line.stationIds[0];
  return { id: train.id, routeId: line.id, stopped: true, stationId: first, stationsAhead: [first], maxCapacity: trainCapacityPop(line, trainType) };
}
