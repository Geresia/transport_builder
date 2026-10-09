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
import { activeRailwayControlOrder, effectiveLineStationGroups, effectiveLineStationIds } from "./railway-service-control.mjs";
import { operationalDayTypeAt } from "./operational-calendar.mjs";

function recordDisruptionDelay(state, line, train, seconds) {
  if (!(seconds > 0)) return;
  train.disruptionDelaySeconds = (train.disruptionDelaySeconds ?? 0) + seconds;
  // Operational KPI completion belongs to the scheduled departure day, but disruption exposure belongs to the
  // calendar day on which it happened. This keeps a cross-midnight delay from disappearing into an already-settled day.
  recordRailwayTraffic(state, line.id, Math.floor(state.simMinutes / 1440), "disruptionDelaySeconds", seconds);
}

function originalLineSegmentIndex(line, leftStationId, rightStationId) {
  const left = String(leftStationId);
  const right = String(rightStationId);
  const matches = [];
  for (let index = 0; index < line.stationIds.length - 1; index += 1) {
    const from = String(line.stationIds[index]);
    const to = String(line.stationIds[index + 1]);
    if ((from === left && to === right) || (from === right && to === left)) matches.push(index);
  }
  return matches.length === 1 ? matches[0] : -1;
}

export function lineRoundTripMinutes(state, line) {
  let metres = 0;
  let stops = 0;
  for (const stationIds of effectiveLineStationGroups(state, line)) {
    for (let i = 0; i < stationIds.length - 1; i++) {
      metres += haversineMetres(
        state.stations.get(stationIds[i]).location,
        state.stations.get(stationIds[i + 1]).location
      );
    }
    stops += 2 * (stationIds.length - 1);
  }
  return ((2 * metres) / TRAIN_SPEED_MPS + stops * DWELL_SECONDS) / 60;
}

// Trains needed in service to hold `perHour` on this line.
export function targetTrains(state, line, bandId) {
  return (line.frequency[bandId] * lineRoundTripMinutes(state, line)) / 60;
}

function startTrain(state, line, serviceStationIds, scheduledDepartureMinute = null, scheduledReturnMinute = null, scheduledCompletionMinute = null, terminalResourceId = null, timetableId = null, managementServiceId = null) {
  const train = { id: state.nextTrainId++, lineId: line.id, segIndex: 0, t: 0, dir: 1, dwell: DWELL_SECONDS, serviceStationIds };
  if (scheduledDepartureMinute !== null) train.scheduledDepartureMinute = scheduledDepartureMinute;
  if (scheduledReturnMinute !== null) train.scheduledReturnMinute = scheduledReturnMinute;
  if (scheduledCompletionMinute !== null) train.scheduledCompletionMinute = scheduledCompletionMinute;
  if (terminalResourceId !== null) train.terminalResourceId = terminalResourceId;
  // A scheduled train retains the exact operational timetable and management
  // service that dispatched it. This is provenance, not a new dispatch rule:
  // legacy frequency trains deliberately keep neither field.
  if (typeof timetableId === "string" && timetableId !== "") train.timetableId = timetableId;
  if (typeof managementServiceId === "string" && managementServiceId !== "") train.managementServiceId = managementServiceId;
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
    if (operationalDayTypeAt(day * 1440, state.operationalCalendar) !== schedule.dayType) continue;
    for (const trip of schedule.roundTrips ?? schedule.departureMinutes.map((departureMinute) => ({ departureMinute, returnDepartureMinute: null }))) {
      const absoluteMinute = day * 1440 + trip.departureMinute;
      const returnMinute = trip.returnDepartureMinute === null ? null : day * 1440 + trip.returnDepartureMinute;
      const completionMinute = trip.completionMinute === null || trip.completionMinute === undefined ? null : day * 1440 + trip.completionMinute;
      if (absoluteMinute <= previous + 1e-9 || absoluteMinute > now + 1e-9) continue;
      const graceMinutes = Number.isFinite(schedule.dispatchGraceMinutes) ? Math.max(0, schedule.dispatchGraceMinutes) : 1;
      if (allowDispatch && now - absoluteMinute <= graceMinutes + 1e-9) {
        const order = activeRailwayControlOrder(state, line.id);
        const groups = effectiveLineStationGroups(state, line);
        groups.forEach((stationIds, index) => startTrain(state, line, stationIds, absoluteMinute, returnMinute, completionMinute,
          order?.retainedServices?.[index]?.terminalResourceIds?.[0] ?? trip.terminalResourceId ?? null,
          schedule.timetableId ?? null, schedule.serviceId ?? null));
      }
      else {
        // null is a restored count nobody recorded: it stays unknown instead of silently becoming "1 since the load"
        // (the line's own railwayTraffic counter below still counts every miss).  An absent counter is a hand-made schedule: it starts at 0.
        if (schedule.missedDepartures !== null) schedule.missedDepartures = (schedule.missedDepartures ?? 0) + 1;
        recordRailwayTraffic(state, line.id, day, "missedDepartures");
      }
    }
  }
  schedule.lastCheckedSimMinute = now;
}

export function dispatchTrains(state) {
  const band = bandAt(state);
  for (const line of state.lines) {
    const groups = effectiveLineStationGroups(state, line);
    if (!groups.length) continue;
    const currentDayType = operationalDayTypeAt(state.simMinutes, state.operationalCalendar);
    const scheduled = line.timetableDispatches?.[currentDayType] ?? null;
    for (const timetable of Object.values(line.timetableDispatches ?? {})) dispatchScheduledTrains(state, line, timetable, !line.suspended);
    if (line.suspended) continue;
    if (scheduled) continue;
    const perHour = line.frequency[band.id];
    if (perHour <= 0) continue;
    if (state.simMinutes - line.lastDispatch < 60 / perHour) continue;
    line.lastDispatch = state.simMinutes;
    const order = activeRailwayControlOrder(state, line.id);
    groups.forEach((stationIds, index) => startTrain(state, line, stationIds, null, null, null,
      order?.retainedServices?.[index]?.terminalResourceIds?.[0] ?? null));
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
        recordThroughTrainMovement(state, line, originalLineSegmentIndex(line, ids[train.segIndex], ids[nextIndex]), movedMetres);
        if (speedMps < TRAIN_SPEED_MPS) recordDisruptionDelay(state, line, train, remaining * (1 - speedMps / TRAIN_SPEED_MPS));
        remaining = 0;
        break;
      }

      remaining -= secondsToBoundary;
      const movedMetres = (nextBoundaryProgress - train.t) * segLength;
      state.stats.trainKmByLine[String(line.id)] = (state.stats.trainKmByLine[String(line.id)] ?? 0) + movedMetres / 1000;
      recordThroughTrainMovement(state, line, originalLineSegmentIndex(line, ids[train.segIndex], ids[nextIndex]), movedMetres);
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

