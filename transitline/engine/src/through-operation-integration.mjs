export const THROUGH_OPERATION_BINDING_SCHEMA = "transitline.through-operation-binding/1";

const clone = (value) => structuredClone(value);
const lineKey = (value) => String(value);

function requireOperationalState(state) {
  if (!state || !Array.isArray(state.lines) || !state.stats) throw new Error("Operational state is required");
  state.throughServiceBindings ??= [];
  state.stats.throughOperations ??= {};
  return state;
}

function requireThroughService(service) {
  if (service?.schema !== "transitline.through-service/1" || service.contractVersion !== 1) throw new Error("ThroughService v1 is required");
  if (!service.throughServiceId) throw new Error("Through service id is required");
  return service;
}

function normalizeStationAccess(value, stationCount, linkedIds) {
  if (value === undefined && linkedIds.size === 0) return Array.from({ length: stationCount }, () => []);
  if (!Array.isArray(value) || value.length !== stationCount) throw new Error("Station access mapping must match the operational line station count");
  return value.map((ids, index) => {
    if (!Array.isArray(ids)) throw new Error(`Station access mapping ${index} must be an array`);
    const normalized = [...new Set(ids.map(String))].sort();
    for (const id of normalized) if (!linkedIds.has(id)) throw new Error(`Station access mapping uses unlinked agreement ${id}`);
    return normalized;
  });
}

function normalizeSegmentAccess(value, segmentCount, linkedIds) {
  if (value === undefined && linkedIds.size === 0) return Array(segmentCount).fill(null);
  if (!Array.isArray(value) || value.length !== segmentCount) throw new Error("Segment access mapping must match the operational line segment count");
  return value.map((id) => {
    if (id === null) return null;
    const normalized = String(id);
    if (!linkedIds.has(normalized)) throw new Error(`Segment access mapping uses unlinked agreement ${normalized}`);
    return normalized;
  });
}

function newDay(binding) {
  return {
    passengers: 0,
    trainKm: 0,
    trackAccessUsage: Object.fromEntries(binding.trackAccessAgreementIds.map((agreementId) => [agreementId, { trainKm: 0, stationStops: 0 }])),
  };
}

function operationStats(state, binding) {
  requireOperationalState(state);
  return state.stats.throughOperations[binding.throughServiceId] ??= { days: {} };
}

function dayStats(state, binding, day = Math.floor(state.simMinutes / 1440)) {
  const stats = operationStats(state, binding);
  return stats.days[String(day)] ??= newDay(binding);
}

export function throughOperationBinding(state, throughServiceId) {
  return (state?.throughServiceBindings ?? []).find((entry) => entry.throughServiceId === throughServiceId) ?? null;
}

export function bindThroughServiceToLine(state, throughService, input = {}) {
  requireOperationalState(state);
  const service = requireThroughService(throughService);
  if (service.status !== "approved") throw new Error("Only an approved through service can enter operation");
  if (throughOperationBinding(state, service.throughServiceId)) throw new Error(`Through service ${service.throughServiceId} already has an operational binding`);
  const line = state.lines.find((candidate) => lineKey(candidate.id) === lineKey(input.operationalLineId));
  if (!line) throw new Error(`Unknown operational line ${input.operationalLineId}`);
  if (line.planOnly) throw new Error("A planning-only line cannot carry a through service");
  if (line.throughServiceId) throw new Error(`Operational line ${line.id} is already assigned to a through service`);
  const passengerWeight = Number(input.passengerWeight ?? 1);
  if (!Number.isSafeInteger(passengerWeight) || passengerWeight <= 0) throw new Error("Through passenger weight must be a positive integer");
  const passengerMode = input.passengerMode ?? "terminal-to-terminal";
  if (!["terminal-to-terminal", "all-deliveries"].includes(passengerMode)) throw new Error(`Unknown through passenger mode ${passengerMode}`);
  const trackAccessAgreementIds = [...new Set((service.trackAccessAgreementIds ?? []).map(String))].sort();
  const linkedIds = new Set(trackAccessAgreementIds);
  const segmentAccessAgreementIds = normalizeSegmentAccess(input.segmentAccessAgreementIds, line.stationIds.length - 1, linkedIds);
  const stationAccessAgreementIds = normalizeStationAccess(input.stationAccessAgreementIds, line.stationIds.length, linkedIds);
  const referenced = new Set([...segmentAccessAgreementIds.filter(Boolean), ...stationAccessAgreementIds.flat()]);
  for (const agreementId of linkedIds) if (!referenced.has(agreementId)) throw new Error(`Operational mapping does not cover linked agreement ${agreementId}`);
  const startDay = Math.floor(state.simMinutes / 1440);
  const binding = {
    schema: THROUGH_OPERATION_BINDING_SCHEMA,
    contractVersion: 1,
    bindingId: `through-operation-binding:${service.throughServiceId}`,
    throughServiceId: service.throughServiceId,
    throughRouteId: service.throughRouteId,
    routeGeometryRevision: service.routeGeometryRevision,
    operationalLineId: lineKey(line.id),
    passengerWeight,
    passengerMode,
    trackAccessAgreementIds,
    segmentAccessAgreementIds,
    stationAccessAgreementIds,
    startDay,
    startedAtSimMinute: state.simMinutes,
    startedAtGameMinute: Number.isFinite(input.startedAtGameMinute) ? input.startedAtGameMinute : null,
  };
  line.throughServiceId = service.throughServiceId;
  line.throughOperationBindingId = binding.bindingId;
  state.throughServiceBindings.push(binding);
  operationStats(state, binding);
  return clone(binding);
}

export function unbindThroughServiceFromLine(state, throughServiceId) {
  requireOperationalState(state);
  const index = state.throughServiceBindings.findIndex((entry) => entry.throughServiceId === throughServiceId);
  if (index < 0) return false;
  const binding = state.throughServiceBindings[index];
  const days = state.stats.throughOperations?.[throughServiceId]?.days ?? {};
  const hasUnsettledFacts = Object.values(days).some((day) => day.passengers > 0 || day.trainKm > 0
    || Object.values(day.trackAccessUsage ?? {}).some((usage) => usage.trainKm > 0 || usage.stationStops > 0));
  if (hasUnsettledFacts) throw new Error("Through operation has unsettled facts and cannot be unbound");
  state.throughServiceBindings.splice(index, 1);
  const line = state.lines.find((candidate) => lineKey(candidate.id) === binding.operationalLineId);
  if (line?.throughServiceId === throughServiceId) {
    delete line.throughServiceId;
    delete line.throughOperationBindingId;
  }
  delete state.stats.throughOperations[throughServiceId];
  return true;
}

export function setThroughOperationSuspended(state, throughServiceId, suspended) {
  const binding = throughOperationBinding(state, throughServiceId);
  if (!binding) return false;
  const line = state.lines.find((candidate) => lineKey(candidate.id) === binding.operationalLineId);
  if (!line) return false;
  const next = Boolean(suspended);
  if (line.suspended === next) return true;
  line.suspended = next;
  if (next) state.trains = state.trains.filter((train) => lineKey(train.lineId) !== binding.operationalLineId);
  state.networkDirty = true;
  return true;
}

export function recordThroughTrainMovement(state, line, segmentIndex, movedMetres) {
  if (!line?.throughServiceId || !(movedMetres > 0)) return;
  const binding = throughOperationBinding(state, line.throughServiceId);
  if (!binding || lineKey(line.id) !== binding.operationalLineId) return;
  const stats = dayStats(state, binding);
  const trainKm = movedMetres / 1000;
  stats.trainKm += trainKm;
  const agreementId = binding.segmentAccessAgreementIds[segmentIndex] ?? null;
  if (agreementId) stats.trackAccessUsage[agreementId].trainKm += trainKm;
}

export function recordThroughStationStop(state, line, stationId) {
  if (!line?.throughServiceId) return;
  const binding = throughOperationBinding(state, line.throughServiceId);
  if (!binding || lineKey(line.id) !== binding.operationalLineId) return;
  const stationIndex = line.stationIds.indexOf(stationId);
  if (stationIndex < 0) return;
  const stats = dayStats(state, binding);
  for (const agreementId of binding.stationAccessAgreementIds[stationIndex]) stats.trackAccessUsage[agreementId].stationStops += 1;
}

export function recordThroughJourneyDelivery(state, line, transitSegments, passengerCount) {
  if (!line?.throughServiceId) return false;
  const binding = throughOperationBinding(state, line.throughServiceId);
  if (!binding || lineKey(line.id) !== binding.operationalLineId) return false;
  const count = Number(passengerCount);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error("Through passenger count must be a non-negative integer");
  const segments = Array.isArray(transitSegments) ? transitSegments : [];
  const directHop = segments.length === 1 && lineKey(segments[0]?.lineId ?? segments[0]?.routeId) === lineKey(line.id);
  const endpoints = new Set([line.stationIds[0], line.stationIds.at(-1)]);
  const from = segments[0]?.boardStationId ?? segments[0]?.fromStopId;
  const to = segments[0]?.alightStationId ?? segments[0]?.toStopId;
  const terminalJourney = directHop && endpoints.has(from) && endpoints.has(to) && from !== to;
  if (binding.passengerMode === "terminal-to-terminal" && !terminalJourney) return false;
  dayStats(state, binding).passengers += count;
  return true;
}

export function recordThroughPassengerDelivery(state, line, passenger) {
  const binding = line?.throughServiceId ? throughOperationBinding(state, line.throughServiceId) : null;
  if (!binding) return false;
  const route = (passenger?.route ?? []).map((segment, index, segments) => ({
    ...segment,
    boardStationId: segment.boardStationId ?? (index === 0 ? passenger.originId : undefined),
    alightStationId: segment.alightStationId ?? (index === segments.length - 1 ? passenger.destinationId : undefined),
  }));
  return recordThroughJourneyDelivery(state, line, route, binding.passengerWeight);
}

export function throughOperationActualsForDay(state, throughServiceId, operatingDay) {
  const binding = throughOperationBinding(state, throughServiceId);
  if (!binding) throw new Error(`No operational binding for through service ${throughServiceId}`);
  if (!Number.isSafeInteger(operatingDay) || operatingDay < binding.startDay) throw new Error("Operating day is outside the through-service binding");
  const stored = operationStats(state, binding).days[String(operatingDay)] ?? newDay(binding);
  return {
    operatingDay,
    passengers: stored.passengers,
    trainKm: stored.trainKm,
    trackAccessUsage: binding.trackAccessAgreementIds.map((agreementId) => ({
      agreementId,
      trainKm: stored.trackAccessUsage[agreementId]?.trainKm ?? 0,
      stationStops: stored.trackAccessUsage[agreementId]?.stationStops ?? 0,
    })),
  };
}

export function clearThroughOperationDay(state, throughServiceId, operatingDay) {
  const binding = throughOperationBinding(state, throughServiceId);
  if (!binding) return false;
  return delete operationStats(state, binding).days[String(operatingDay)];
}

export function throughOperationReport(state) {
  return (state?.throughServiceBindings ?? []).map((binding) => ({
    ...clone(binding),
    actualsByDay: clone(state?.stats?.throughOperations?.[binding.throughServiceId]?.days ?? {}),
  }));
}
