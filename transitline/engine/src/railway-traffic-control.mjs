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
    sectionId: null,
    physicalDirection: null,
    resourceId: null,
    mappingError: resolved.error,
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
  };
}

export function signalBlockForTrain(state, train) {
  const candidate = trainSection(state, train);
  if (!candidate) return null;
  if (candidate.mappingError) return { reason: candidate.mappingError, sectionId: null, resourceId: null, blockingTrainId: null };
  if (candidate.segment.status && candidate.segment.status !== "available") {
    return { reason: "section-unavailable", sectionId: candidate.sectionId, resourceId: candidate.resourceId, blockingTrainId: null };
  }
  for (const other of state.trains) {
    if (other === train || other.done || !(other.t > 0)) continue;
    const occupied = trainSection(state, other);
    if (occupied?.resourceId !== candidate.resourceId) continue;
    return { reason: "block-occupied", sectionId: candidate.sectionId, resourceId: candidate.resourceId, blockingTrainId: other.id };
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
    arrivalDelaySeconds: 0,
    days: {},
  };
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
    arrivalDelaySeconds: 0,
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
  if (!stats?.days) return null;
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
