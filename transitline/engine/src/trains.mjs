// Trains are dispatched from a line's first station at the headway implied by
// the current band's trains/hour, dwell at each stop, run out to the far end
// and back, then retire. Capacity is cars * CAR_CAPACITY (see state.mjs).
import { haversineMetres } from "./projection.mjs";
import { TRAIN_SPEED_MPS, DWELL_SECONDS } from "./network.mjs";
import { handleStop } from "./passengers.mjs";
import { bandAt } from "./state.mjs";
import { recordThroughStationStop, recordThroughTrainMovement } from "./through-operation-integration.mjs";
import { recordRailwayTraffic, releaseTrainSectionJunctions, signalBlockForTrain, trainSection } from "./railway-traffic-control.mjs";
import { railwayDisruptionEffect } from "./railway-disruptions.mjs";
import { effectiveLineStationIds } from "./railway-service-control.mjs";

function recordDisruptionDelay(state, line, train, seconds) {
  if (!(seconds > 0)) return;
  train.disruptionDelaySeconds = (train.disruptionDelaySeconds ?? 0) + seconds;
  // Operational KPI completion belongs to the scheduled departure day, but disruption exposure belongs to the
  // calendar day on which it happened. This keeps a cross-midnight delay from disappearing into an already-settled day.
  recordRailwayTraffic(state, line.id, Math.floor(state.simMinutes / 1440), "disruptionDelaySeconds", seconds);
}

export function lineRoundTripMinutes(state, line) {
  const stationIds = effectiveLineStationIds(state, line);
  let metres = 0;
  for (let i = 0; i < stationIds.length - 1; i++) {
    metres += haversineMetres(
      state.stations.get(stationIds[i]).location,
      state.stations.get(stationIds[i + 1]).location
    );
  }
  const stops = 2 * (stationIds.length - 1);
  return ((2 * metres) / TRAIN_SPEED_MPS + stops * DWELL_SECONDS) / 60;
}

// Trains needed in service to hold `perHour` on this line.
export function targetTrains(state, line, bandId) {
  return (line.frequency[bandId] * lineRoundTripMinutes(state, line)) / 60;
}

function dayTypeAt(simMinutes) {
  const day = Math.floor(simMinutes / 1440);
  const weekday = ((day % 7) + 7) % 7;
  return weekday >= 5 ? "weekend" : "weekday";
}

function startTrain(state, line, scheduledDepartureMinute = null, scheduledReturnMinute = null, scheduledCompletionMinute = null, terminalResourceId = null) {
  line.lastDispatch = state.simMinutes;
  const serviceStationIds = effectiveLineStationIds(state, line);
  const train = { id: state.nextTrainId++, lineId: line.id, segIndex: 0, t: 0, dir: 1, dwell: DWELL_SECONDS, serviceStationIds };
  if (scheduledDepartureMinute !== null) train.scheduledDepartureMinute = scheduledDepartureMinute;
  if (scheduledReturnMinute !== null) train.scheduledReturnMinute = scheduledReturnMinute;
  if (scheduledCompletionMinute !== null) train.scheduledCompletionMinute = scheduledCompletionMinute;
  if (terminalResourceId !== null) train.terminalResourceId = terminalResourceId;
  train.trafficOperatingDay = Math.floor((scheduledDepartureMinute ?? state.simMinutes) / 1440);
  state.trains.push(train);
  recordRailwayTraffic(state, line.id, train.trafficOperatingDay, "dispatchedTrains");
  recordRailwayTraffic(state, line.id, train.trafficOperatingDay, scheduledDepartureMinute === null ? "unscheduledDispatchedTrains" : "scheduledDispatchedTrains");
  if (scheduledDepartureMinute !== null) recordRailwayTraffic(state, line.id, train.trafficOperatingDay, "departureDelaySeconds", Math.max(0, (state.simMinutes - scheduledDepartureMinute) * 60));
  recordThroughStationStop(state, line, serviceStationIds[0]);
  handleStop(state, train, serviceStationIds[0]);
}

function dispatchScheduledTrains(state, line, schedule, allowDispatch = true) {
  const now = state.simMinutes;
  const previous = Number.isFinite(schedule.lastCheckedSimMinute) ? schedule.lastCheckedSimMinute : now;
  if (now <= previous) {
    schedule.lastCheckedSimMinute = now;
    return;
  }
  const firstDay = Math.floor(previous / 1440);
  const lastDay = Math.floor(now / 1440);
  for (let day = firstDay; day <= lastDay; day += 1) {
    if (dayTypeAt(day * 1440) !== schedule.dayType) continue;
    for (const trip of schedule.roundTrips ?? schedule.departureMinutes.map((departureMinute) => ({ departureMinute, returnDepartureMinute: null }))) {
      const absoluteMinute = day * 1440 + trip.departureMinute;
      const returnMinute = trip.returnDepartureMinute === null ? null : day * 1440 + trip.returnDepartureMinute;
      const completionMinute = trip.completionMinute === null || trip.completionMinute === undefined ? null : day * 1440 + trip.completionMinute;
      if (absoluteMinute <= previous + 1e-9 || absoluteMinute > now + 1e-9) continue;
      const graceMinutes = Number.isFinite(schedule.dispatchGraceMinutes) ? Math.max(0, schedule.dispatchGraceMinutes) : 1;
      if (allowDispatch && now - absoluteMinute <= graceMinutes + 1e-9) startTrain(state, line, absoluteMinute, returnMinute, completionMinute, trip.terminalResourceId ?? null);
      else {
        schedule.missedDepartures = (schedule.missedDepartures ?? 0) + 1;
        recordRailwayTraffic(state, line.id, day, "missedDepartures");
      }
    }
  }
  schedule.lastCheckedSimMinute = now;
}

export function dispatchTrains(state) {
  const band = bandAt(state);
  for (const line of state.lines) {
    if (effectiveLineStationIds(state, line).length < 2) continue;
    const currentDayType = dayTypeAt(state.simMinutes);
    const scheduled = line.timetableDispatches?.[currentDayType] ?? null;
    for (const timetable of Object.values(line.timetableDispatches ?? {})) dispatchScheduledTrains(state, line, timetable, !line.suspended);
    if (line.suspended) continue;
    if (scheduled) continue;
    const perHour = line.frequency[band.id];
    if (perHour <= 0) continue;
    if (state.simMinutes - line.lastDispatch < 60 / perHour) continue;
    startTrain(state, line);
  }
}

export function stepTrains(state, dtSeconds) {
  for (const train of state.trains) {
    const line = state.lines.find((l) => l.id === train.lineId);
    if (!line || effectiveLineStationIds(state, line, train).length < 2) {
      train.done = true;
      continue;
    }

    let remaining = Math.max(0, dtSeconds);
    const ids = effectiveLineStationIds(state, line, train);
    let guard = 0;
    while (remaining > 1e-9 && !train.done && guard++ < 10000) {
      if (Number.isFinite(train.holdUntilSimMinute)) {
        if (state.simMinutes + 1e-9 < train.holdUntilSimMinute) break;
        delete train.holdUntilSimMinute;
      }
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
      const controlSection = trainSection(state, train);
      const atControlPoint = !(train.t > 0)
        || Math.abs(train.t - (controlSection?.blockEntryProgress ?? -1)) <= 1e-8;
      if (atControlPoint) {
        const block = signalBlockForTrain(state, train);
        if (block) {
          train.signalWaitSeconds = (train.signalWaitSeconds ?? 0) + remaining;
          train.waitingForSignal = block;
          recordRailwayTraffic(state, line.id, train.trafficOperatingDay ?? Math.floor(state.simMinutes / 1440), "signalDelaySeconds", remaining);
          if (block.reason.startsWith("junction-")) recordRailwayTraffic(state, line.id, train.trafficOperatingDay ?? Math.floor(state.simMinutes / 1440), "junctionDelaySeconds", remaining);
          if (block.reason.startsWith("terminal-")) recordRailwayTraffic(state, line.id, train.trafficOperatingDay ?? Math.floor(state.simMinutes / 1440), "terminalDelaySeconds", remaining);
          if (block.reason === "disruption-closure") recordDisruptionDelay(state, line, train, remaining);
          break;
        }
        delete train.waitingForSignal;
      }
      const section = trainSection(state, train);
      const disruption = railwayDisruptionEffect(state, {
        lineId: line.id,
        trackSegmentId: section?.sectionId ?? null,
        blockId: section?.blockId ?? null,
        trainId: train.id,
      });
      const speedMps = disruption.speedLimitMps === null ? TRAIN_SPEED_MPS : Math.min(TRAIN_SPEED_MPS, disruption.speedLimitMps);
      if (disruption.closed || !(speedMps > 0)) {
        train.waitingForDisruption = { reason: "disruption-closure", eventIds: disruption.eventIds, sectionId: section?.sectionId ?? null };
        recordDisruptionDelay(state, line, train, remaining);
        break;
      }
      delete train.waitingForDisruption;
      const segLength = Math.max(haversineMetres(from.location, to.location), 1);
      const nextBoundaryProgress = Math.max(train.t, Math.min(1, section?.nextBlockBoundaryProgress ?? 1));
      const secondsToBoundary = ((nextBoundaryProgress - train.t) * segLength) / speedMps;
      if (remaining + 1e-9 < secondsToBoundary) {
        const movedMetres = speedMps * remaining;
        train.t += movedMetres / segLength;
        state.stats.trainKmByLine[String(line.id)] = (state.stats.trainKmByLine[String(line.id)] ?? 0) + movedMetres / 1000;
        recordThroughTrainMovement(state, line, Math.min(train.segIndex, nextIndex), movedMetres);
        if (speedMps < TRAIN_SPEED_MPS) recordDisruptionDelay(state, line, train, remaining * (1 - speedMps / TRAIN_SPEED_MPS));
        remaining = 0;
        break;
      }

      remaining -= secondsToBoundary;
      const movedMetres = (nextBoundaryProgress - train.t) * segLength;
      state.stats.trainKmByLine[String(line.id)] = (state.stats.trainKmByLine[String(line.id)] ?? 0) + movedMetres / 1000;
      recordThroughTrainMovement(state, line, Math.min(train.segIndex, nextIndex), movedMetres);
      if (speedMps < TRAIN_SPEED_MPS) recordDisruptionDelay(state, line, train, secondsToBoundary * (1 - speedMps / TRAIN_SPEED_MPS));
      train.t = nextBoundaryProgress;
      if (train.t < 1 - 1e-9) continue;
      releaseTrainSectionJunctions(state, train, state.simMinutes);
      train.t = 0;
      train.segIndex = nextIndex;
      const finished = train.segIndex === 0 && train.dir === -1;
      recordThroughStationStop(state, line, ids[train.segIndex]);
      handleStop(state, train, ids[train.segIndex], !finished);
      if (finished) {
        const trafficDay = train.trafficOperatingDay ?? Math.floor(state.simMinutes / 1440);
        recordRailwayTraffic(state, line.id, trafficDay, "completedTrains");
        const arrivalDelaySeconds = Number.isFinite(train.scheduledCompletionMinute)
          ? Math.max(0, (state.simMinutes - train.scheduledCompletionMinute) * 60)
          : 0;
        if (Number.isFinite(train.scheduledCompletionMinute)) {
          recordRailwayTraffic(state, line.id, trafficDay, "scheduledCompletedTrains");
          recordRailwayTraffic(state, line.id, trafficDay, "arrivalDelaySeconds", arrivalDelaySeconds);
          if (arrivalDelaySeconds <= 300) recordRailwayTraffic(state, line.id, trafficDay, "onTimeTrains");
        }
        const completionDay = Math.floor(state.simMinutes / 1440);
        if (completionDay > trafficDay) {
          recordRailwayTraffic(state, line.id, completionDay, "lateCompletedTrains");
          recordRailwayTraffic(state, line.id, completionDay, "lateArrivalDelaySeconds", arrivalDelaySeconds);
        }
        train.done = true;
        break;
      }
      if (train.segIndex === ids.length - 1) {
        train.dir = -1;
        if (Number.isFinite(train.scheduledReturnMinute)) {
          train.holdUntilSimMinute = train.scheduledReturnMinute;
          train.dwell = 0;
        } else train.dwell = DWELL_SECONDS;
      } else train.dwell = DWELL_SECONDS;
    }
  }
  state.trains = state.trains.filter((t) => !t.done);
}

