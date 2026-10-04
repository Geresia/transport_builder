import { TRAIN_SPEED_MPS } from "./network.mjs";
import { haversineMetres } from "./projection.mjs";

const key = (value) => String(value);

function segmentForLeg(state, line, fromStationId, toStationId) {
  const allowed = new Set((line.trackSegmentIds ?? []).map(key));
  if (!allowed.size) return { segment: null, error: "unmapped-section" };
  const matches = state.trackSegments.filter((segment) => allowed.has(key(segment.id))
    && ((key(segment.fromStationId) === key(fromStationId) && key(segment.toStationId) === key(toStationId))
      || (key(segment.fromStationId) === key(toStationId) && key(segment.toStationId) === key(fromStationId))));
  if (matches.length === 0) return { segment: null, error: "unmapped-section" };
  if (matches.length > 1) return { segment: null, error: "ambiguous-section" };
  return { segment: matches[0], error: null };
}

function controlledLine(line) {
  return Boolean(line.owned || line.managementServiceId || line.throughServiceId || line.timetableDispatches || line.railwayTrafficControl);
}

export function trainSection(state, train) {
  const line = state.lines.find((entry) => key(entry.id) === key(train.lineId));
  if (!line) return null;
  const nextIndex = train.segIndex + train.dir;
  if (nextIndex < 0 || nextIndex >= line.stationIds.length) return null;
  const fromStationId = line.stationIds[train.segIndex];
  const toStationId = line.stationIds[nextIndex];
  const resolved = segmentForLeg(state, line, fromStationId, toStationId);
  if (!resolved.segment && line.railwayTrafficControlMode === "legacy-unmapped") return null;
  if (!resolved.segment) return controlledLine(line) ? {
    line,
    segment: null,
    fromStationId: key(fromStationId),
    toStationId: key(toStationId),
    sectionId: null,
    physicalDirection: null,
    resourceId: null,
    mappingError: resolved.error,
    entersTerminal: nextIndex === line.stationIds.length - 1 && train.dir === 1,
  } : null;
  const segment = resolved.segment;
  const physicalDirection = key(segment.fromStationId) === key(fromStationId) ? "forward" : "reverse";
  const configuredDirectionMode = line.railwayTrafficControl?.sectionDirectionModes?.[key(segment.id)];
  const directionMode = ["single", "double"].includes(configuredDirectionMode)
    ? configuredDirectionMode
    : ["single", "double"].includes(segment.directionMode) ? segment.directionMode : "single";
  return {
    line,
    segment,
    sectionId: key(segment.id),
    physicalDirection,
    resourceId: directionMode === "single" ? `section:${segment.id}:shared` : `section:${segment.id}:${physicalDirection}`,
    junctionResourceIds: [...(line.railwayTrafficControl?.sectionJunctionResourceIds?.[key(segment.id)] ?? segment.junctionResourceIds ?? [])].map(key).sort(),
    junctionClearanceMinutes: Number(line.railwayTrafficControl?.sectionJunctionClearanceMinutes?.[key(segment.id)]
      ?? segment.junctionClearanceMinutes ?? 0),
    entersTerminal: nextIndex === line.stationIds.length - 1 && train.dir === 1,
  };
}

function junctionWindow(state, train, section) {
  const from = state.stations.get(section.line.stationIds[train.segIndex]);
  const nextIndex = train.segIndex + train.dir;
  const to = state.stations.get(section.line.stationIds[nextIndex]);
  if (!from || !to) return null;
  const totalMinutes = haversineMetres(from.location, to.location) / TRAIN_SPEED_MPS / 60;
  const exitMinute = state.simMinutes + Math.max(0, 1 - (Number(train.t) || 0)) * totalMinutes;
  const clearance = Math.max(0, Number(section.junctionClearanceMinutes) || 0);
  return { startMinute: exitMinute - clearance, endMinute: exitMinute + clearance };
}

function overlaps(left, right) {
  return left.startMinute < right.endMinute - 1e-9 && right.startMinute < left.endMinute - 1e-9;
}

function sameStationPair(left, right) {
  if (!left || !right) return false;
  const leftPair = [key(left.fromStationId), key(left.toStationId)].sort();
  const rightPair = [key(right.fromStationId), key(right.toStationId)].sort();
  return leftPair[0] === rightPair[0] && leftPair[1] === rightPair[1];
}

export function releaseTrainSectionJunctions(state, train, atMinute = state.simMinutes) {
  const section = trainSection(state, train);
  if (!section || section.mappingError || !section.junctionResourceIds.length) return [];
  state.railwayInterlocking ??= { junctionReleaseMinutes: {} };
  state.railwayInterlocking.junctionReleaseMinutes ??= {};
  const releaseMinute = Number(atMinute) + Math.max(0, Number(section.junctionClearanceMinutes) || 0);
  for (const resourceId of section.junctionResourceIds) {
    state.railwayInterlocking.junctionReleaseMinutes[resourceId] = Math.max(
      state.railwayInterlocking.junctionReleaseMinutes[resourceId] ?? -Infinity,
      releaseMinute,
    );
  }
  return section.junctionResourceIds.map((resourceId) => ({ resourceId, releaseMinute }));
}

export function signalBlockForTrain(state, train) {
  const candidate = trainSection(state, train);
  if (!candidate) return null;
  if (candidate.mappingError) return { reason: candidate.mappingError, sectionId: null, resourceId: null, blockingTrainId: null };
  if (candidate.segment.status && candidate.segment.status !== "available") {
    return { reason: "section-unavailable", sectionId: candidate.sectionId, resourceId: candidate.resourceId, blockingTrainId: null };
  }
  const candidateJunctionWindow = junctionWindow(state, train, candidate);
  for (const resourceId of candidate.junctionResourceIds) {
    const releaseMinute = state.railwayInterlocking?.junctionReleaseMinutes?.[resourceId];
    if (candidateJunctionWindow && Number.isFinite(releaseMinute) && releaseMinute > candidateJunctionWindow.startMinute + 1e-9) {
      return { reason: "junction-clearance", sectionId: candidate.sectionId, resourceId, blockingTrainId: null, releaseMinute };
    }
  }
  if (train.terminalResourceId && candidate.entersTerminal) {
    for (const other of state.trains) {
      if (other === train || other.done || other.terminalResourceId !== train.terminalResourceId) continue;
      const otherLine = state.lines.find((entry) => key(entry.id) === key(other.lineId));
      const otherSection = trainSection(state, other);
      const heldAtTerminal = otherLine && other.segIndex === otherLine.stationIds.length - 1 && other.dir === -1 && !(other.t > 0);
      const approachingTerminal = otherSection?.entersTerminal && other.t > 0;
      if (heldAtTerminal || approachingTerminal) {
        return { reason: otherSection?.mappingError ? "terminal-occupancy-unknown" : "terminal-occupied", sectionId: candidate.sectionId, resourceId: train.terminalResourceId, blockingTrainId: other.id };
      }
    }
  }
  for (const other of state.trains) {
    if (other === train || other.done || !(other.t > 0)) continue;
    const occupied = trainSection(state, other);
    if (occupied?.mappingError && sameStationPair(candidate.segment, occupied)) {
      return { reason: "occupancy-unknown", sectionId: candidate.sectionId, resourceId: candidate.resourceId, blockingTrainId: other.id };
    }
    if (occupied?.resourceId === candidate.resourceId) return { reason: "block-occupied", sectionId: candidate.sectionId, resourceId: candidate.resourceId, blockingTrainId: other.id };
    const occupiedJunctionWindow = occupied && !occupied.mappingError ? junctionWindow(state, other, occupied) : null;
    const sharedJunction = candidateJunctionWindow && occupiedJunctionWindow && overlaps(candidateJunctionWindow, occupiedJunctionWindow)
      ? candidate.junctionResourceIds.find((resourceId) => occupied.junctionResourceIds?.includes(resourceId))
      : null;
    if (sharedJunction) return { reason: "junction-occupied", sectionId: candidate.sectionId, resourceId: sharedJunction, blockingTrainId: other.id };
  }
  return null;
}

export function railwayTrafficStats(state, lineId) {
  state.stats.railwayTrafficByLine ??= {};
  const defaults = {
    dispatchedTrains: 0,
    completedTrains: 0,
    scheduledDispatchedTrains: 0,
    unscheduledDispatchedTrains: 0,
    scheduledCompletedTrains: 0,
    onTimeTrains: 0,
    missedDepartures: 0,
    departureDelaySeconds: 0,
    signalDelaySeconds: 0,
    junctionDelaySeconds: 0,
    terminalDelaySeconds: 0,
    arrivalDelaySeconds: 0,
    lateCompletedTrains: 0,
    lateArrivalDelaySeconds: 0,
    days: {},
  };
  const existing = state.stats.railwayTrafficByLine[key(lineId)];
  if (existing && existing.days === undefined) existing.legacyUnbucketed = true;
  const stats = state.stats.railwayTrafficByLine[key(lineId)] ??= structuredClone(defaults);
  for (const [field, value] of Object.entries(defaults)) stats[field] ??= structuredClone(value);
  return stats;
}

function emptyDay() {
  return {
    dispatchedTrains: 0,
    completedTrains: 0,
    scheduledDispatchedTrains: 0,
    unscheduledDispatchedTrains: 0,
    scheduledCompletedTrains: 0,
    onTimeTrains: 0,
    missedDepartures: 0,
    departureDelaySeconds: 0,
    signalDelaySeconds: 0,
    junctionDelaySeconds: 0,
    terminalDelaySeconds: 0,
    arrivalDelaySeconds: 0,
    lateCompletedTrains: 0,
    lateArrivalDelaySeconds: 0,
  };
}

export function recordRailwayTraffic(state, lineId, operatingDay, field, amount = 1) {
  const stats = railwayTrafficStats(state, lineId);
  if (!Object.hasOwn(emptyDay(), field)) throw new Error(`Unknown railway traffic field ${field}`);
  const day = String(operatingDay);
  stats.days[day] ??= emptyDay();
  stats[field] += amount;
  stats.days[day][field] += amount;
  return stats;
}

export function railwayTrafficForDays(state, lineId, fromDay, toDayExclusive) {
  const stats = state?.stats?.railwayTrafficByLine?.[key(lineId)];
  if (!stats?.days || stats.legacyUnbucketed) return null;
  const result = emptyDay();
  for (let day = fromDay; day < toDayExclusive; day += 1) {
    const row = stats.days[String(day)];
    if (!row) continue;
    for (const field of Object.keys(result)) result[field] += row[field] ?? 0;
  }
  return result;
}

export function railwayTrafficReport(state) {
  return Object.entries(state?.stats?.railwayTrafficByLine ?? {}).map(([operationalLineId, values]) => ({
    operationalLineId,
    ...structuredClone(values),
    completionOnTimeRatio: values.scheduledCompletedTrains ? values.onTimeTrains / values.scheduledCompletedTrains : null,
    serviceDeliveryRatio: values.scheduledDispatchedTrains + values.missedDepartures
      ? values.onTimeTrains / (values.scheduledDispatchedTrains + values.missedDepartures)
      : null,
  })).sort((a, b) => a.operationalLineId.localeCompare(b.operationalLineId));
}
