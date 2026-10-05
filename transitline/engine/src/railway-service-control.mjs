export const RAILWAY_CONTROL_ORDER_SCHEMA = "transitline.railway-control-order/1";
export const RAILWAY_SERVICE_CONTROL_GEOMETRY_SCHEMA = "transitline.railway-service-control-geometry/1";

const clone = (value) => structuredClone(value);
const key = (value) => String(value);

function ensureStore(state) {
  state.railwayControlOrders ??= { orders: [], nextSequence: 1 };
  state.railwayControlOrders.orders ??= [];
  state.railwayControlOrders.nextSequence ??= Math.max(0, ...state.railwayControlOrders.orders.map((order) => Number(String(order.id ?? "").split(":").at(-1)) || 0)) + 1;
  return state.railwayControlOrders;
}

function ongoingEvent(state, eventId) {
  const event = state.railwayDisruptions?.events?.find((entry) => entry.id === eventId);
  if (!event) throw new Error(`Unknown railway disruption ${eventId}`);
  if (!["active", "responding"].includes(event.status)) throw new Error(`Railway disruption ${eventId} is not ongoing`);
  return event;
}

function requireLine(state, lineId) {
  const line = state.lines?.find((entry) => key(entry.id) === key(lineId));
  if (!line) throw new Error(`Unknown operational line ${lineId}`);
  return line;
}

function retainedPath(line, input) {
  const start = line.stationIds.findIndex((stationId) => key(stationId) === key(input.startStationId));
  const end = line.stationIds.findIndex((stationId) => key(stationId) === key(input.endStationId));
  if (start < 0 || end < 0 || start === end) throw new Error("A control order requires two distinct stations on the line");
  const low = Math.min(start, end);
  const high = Math.max(start, end);
  const stationIds = line.stationIds.slice(low, high + 1);
  if (stationIds.length === line.stationIds.length) throw new Error("A partial control order must shorten the service");
  return { stationIds, startIndex: low, endIndex: high };
}

function serviceOf(stationIds, extra = {}) {
  return {
    serviceId: extra.serviceId ?? `retained-service:${stationIds.map(key).join(":")}`,
    stationIds: stationIds.map(key),
    turnbackCandidateIds: [...(extra.turnbackCandidateIds ?? [])].map(key).sort(),
    terminalResourceIds: [...(extra.terminalResourceIds ?? [])].map(key).sort(),
  };
}

function validateRetainedServices(state, line, event, services) {
  if (!Array.isArray(services) || !services.length) throw new Error("A control order requires at least one retained service");
  const seenIds = new Set();
  for (const service of services) {
    if (!service?.serviceId || seenIds.has(key(service.serviceId))) throw new Error("Retained service ids must be unique");
    seenIds.add(key(service.serviceId));
    if (!Array.isArray(service.stationIds) || service.stationIds.length < 2) throw new Error("A retained service requires at least two stations");
    for (let index = 0; index < service.stationIds.length - 1; index += 1) {
      const matches = segmentBetween(state, line, service.stationIds[index], service.stationIds[index + 1]);
      if (matches.length !== 1) throw new Error(`Retained service path is ${matches.length ? "ambiguous" : "unmapped"}`);
      if (event.trackSegmentId !== null && key(matches[0].id) === key(event.trackSegmentId)) throw new Error("Retained service path still crosses the disrupted track segment");
    }
  }
}

function sourceStationId(state, stationId) {
  const station = state.stations?.get(stationId) ?? state.stations?.get(key(stationId));
  return key(station?.sourceStationId ?? stationId);
}

function operationalStationId(state, line, sourceId) {
  const matches = line.stationIds.filter((stationId) => sourceStationId(state, stationId) === key(sourceId));
  if (matches.length !== 1) throw new Error(matches.length
    ? `Map station ${sourceId} is ambiguous on operational line ${line.id}`
    : `Map station ${sourceId} is not on operational line ${line.id}`);
  return key(matches[0]);
}

function mappedTrackIds(application, sectionIds) {
  const result = [];
  for (const sectionId of sectionIds) {
    const matches = (application.sections ?? []).filter((entry) => key(entry.railCapacitySectionId) === key(sectionId));
    if (matches.length !== 1) throw new Error(matches.length
      ? `Rail capacity section ${sectionId} maps to several operational tracks`
      : `Rail capacity section ${sectionId} is not applied to the operational line`);
    result.push(key(matches[0].trackSegmentId));
  }
  return [...new Set(result)].sort();
}

function retainedComponents(state, line, suspendedTrackIds) {
  const suspended = new Set(suspendedTrackIds.map(key));
  const components = [];
  let current = [key(line.stationIds[0])];
  for (let index = 0; index < line.stationIds.length - 1; index += 1) {
    const left = line.stationIds[index];
    const right = line.stationIds[index + 1];
    const matches = segmentBetween(state, line, left, right);
    if (matches.length !== 1) throw new Error(`Operational line path is ${matches.length ? "ambiguous" : "unmapped"}`);
    if (suspended.has(key(matches[0].id))) {
      if (current.length >= 2) components.push(current);
      current = [key(right)];
    } else current.push(key(right));
  }
  if (current.length >= 2) components.push(current);
  return components;
}

function selectionList(selection, kind) {
  const values = selection?.[kind] ?? [];
  if (!Array.isArray(values)) throw new Error(`Service-control selection ${kind} must be an array`);
  return values.map((value) => key(value?.candidateId ?? value));
}

function candidateById(list, candidateId, kind) {
  const matches = (list ?? []).filter((candidate) => key(candidate.candidateId) === key(candidateId));
  if (matches.length !== 1) throw new Error(`Selected ${kind} candidate ${candidateId} is not current`);
  return matches[0];
}

function segmentBetween(state, line, left, right) {
  const allowed = new Set((line.trackSegmentIds ?? []).map(key));
  return state.trackSegments?.filter((segment) => allowed.has(key(segment.id))
    && ((key(segment.fromStationId) === key(left) && key(segment.toStationId) === key(right))
      || (key(segment.fromStationId) === key(right) && key(segment.toStationId) === key(left)))) ?? [];
}

function invalidateWaitingRoutes(state, lineId) {
  for (const passenger of state.passengers ?? []) {
    if (passenger.state !== "waiting" || !Array.isArray(passenger.route)) continue;
    if (!passenger.route.slice(passenger.hopIndex ?? 0).some((hop) => key(hop.lineId) === key(lineId))) continue;
    passenger.route = null;
    passenger.hopIndex = 0;
  }
}

export function createRailwayControlOrder(state, input = {}) {
  if (!state) throw new Error("Operational state is required");
  if (!["short-turn", "partial-suspension"].includes(input.kind)) throw new Error(`Unknown railway control order kind ${input.kind}`);
  const event = ongoingEvent(state, input.eventId);
  const line = requireLine(state, input.lineId ?? event.lineId);
  const usesAffectedTrack = event.trackSegmentId !== null && (line.trackSegmentIds ?? []).map(key).includes(key(event.trackSegmentId));
  const ownsAffectedTrain = event.trainId !== null && key(line.id) === key(event.lineId);
  if (!usesAffectedTrack && !ownsAffectedTrain) throw new Error(`Disruption ${event.id} does not affect line ${line.id}`);
  const path = input.retainedServices ? null : retainedPath(line, input);
  const retainedServices = input.retainedServices
    ? input.retainedServices.map((service) => serviceOf(service.stationIds, service))
    : [serviceOf(path.stationIds, {
      turnbackCandidateIds: input.candidateId ? [input.candidateId] : [],
      terminalResourceIds: input.terminalResourceId ? [input.terminalResourceId] : [],
    })];
  validateRetainedServices(state, line, event, retainedServices);
  const current = state.railwayControlOrders?.orders?.find((order) => order.status === "active" && key(order.lineId) === key(line.id));
  if (current) throw new Error(`Operational line ${line.id} already has an active control order`);
  const existingStore = state.railwayControlOrders;
  const sequence = existingStore?.nextSequence
    ?? Math.max(0, ...(existingStore?.orders ?? []).map((order) => Number(String(order.id ?? "").split(":").at(-1)) || 0)) + 1;
  const id = input.id ?? `railway-control-order:${sequence}`;
  if (!(typeof id === "string" && id) || (existingStore?.orders ?? []).some((order) => order.id === id)) throw new Error(`Duplicate or invalid railway control order id ${id}`);
  const store = ensureStore(state);
  const order = {
    schema: RAILWAY_CONTROL_ORDER_SCHEMA,
    contractVersion: 1,
    id,
    kind: input.kind,
    status: "active",
    eventId: event.id,
    lineId: key(line.id),
    candidateId: input.candidateId ?? null,
    startStationId: key(retainedServices[0].stationIds[0]),
    endStationId: key(retainedServices[0].stationIds.at(-1)),
    retainedStationIds: [...retainedServices[0].stationIds],
    retainedServices,
    omittedStationIds: line.stationIds.filter((stationId) => !retainedServices.some((service) => service.stationIds.includes(key(stationId)))).map(key),
    turnbackStationId: input.kind === "short-turn" ? key(input.turnbackStationId ?? retainedServices[0].stationIds.at(-1)) : null,
    terminalResourceId: input.terminalResourceId ?? null,
    controlGeometryId: input.controlGeometryId ?? null,
    controlGeometryRevision: input.controlGeometryRevision ?? null,
    suspendedTrackSegmentIds: [...(input.suspendedTrackSegmentIds ?? [])].map(key).sort(),
    turnbackCandidateIds: [...(input.turnbackCandidateIds ?? [])].map(key).sort(),
    assumptions: [...(input.assumptions ?? [])].map(key).sort(),
    issuedAtMinute: Number(state.simMinutes ?? 0),
    endedAtMinute: null,
    endReason: null,
    pendingTrainIds: (state.trains ?? []).filter((train) => key(train.lineId) === key(line.id)).map((train) => train.id).sort((a, b) => key(a).localeCompare(key(b))),
  };
  store.orders.push(order);
  const numericSequence = Number(String(id).match(/^railway-control-order:(\d+)$/)?.[1]);
  store.nextSequence = Math.max(sequence + 1, Number.isSafeInteger(numericSequence) ? numericSequence + 1 : sequence + 1);
  state.networkDirty = true;
  invalidateWaitingRoutes(state, line.id);
  return clone(order);
}

export function createRailwayControlOrderFromGeometry(state, input = {}) {
  const control = input.controlGeometry;
  if (control?.schema !== RAILWAY_SERVICE_CONTROL_GEOMETRY_SCHEMA || control.contractVersion !== 1) throw new Error("RailwayServiceControlGeometry v1 is required");
  const event = ongoingEvent(state, input.eventId ?? control.eventId);
  if (key(control.eventId) !== key(event.id)) throw new Error("Service-control geometry belongs to another disruption");
  const line = requireLine(state, input.lineId ?? control.operationalLineId ?? event.lineId);
  if (control.operationalLineId !== null && key(control.operationalLineId) !== key(line.id)) throw new Error("Service-control geometry belongs to another operational line");
  const application = (state.railCapacityApplications ?? []).find((entry) => key(entry.operationalLineId) === key(line.id));
  if (!application) throw new Error(`Operational line ${line.id} has no rail-capacity application`);
  if (key(application.railGeometryId) !== key(control.railGeometryId) || key(application.railGeometryRevision) !== key(control.railGeometryRevision)) {
    throw new Error("Service-control geometry is stale against the applied rail geometry");
  }
  if (input.controlGeometryRevision === undefined || key(input.controlGeometryRevision) !== key(control.controlGeometryRevision)) {
    throw new Error("Selected service-control geometry revision is stale");
  }
  const suspensionIds = selectionList(input.selection, "partialSuspension");
  if (suspensionIds.length !== 1) throw new Error("Exactly one partial-suspension candidate must be selected");
  const suspension = candidateById(control.partialSuspensionCandidates, suspensionIds[0], "partial-suspension");
  const suspendedTrackSegmentIds = mappedTrackIds(application, suspension.suspendedSectionIds ?? []);
  if (!suspendedTrackSegmentIds.length) throw new Error("The selected suspension does not map to an operational track");
  if (event.trackSegmentId !== null && !suspendedTrackSegmentIds.includes(key(event.trackSegmentId))) {
    throw new Error("The selected suspension does not include the disrupted track segment");
  }
  const components = retainedComponents(state, line, suspendedTrackSegmentIds);
  if (!components.length) throw new Error("The selected suspension leaves no operable service section");

  const turnbackIds = selectionList(input.selection, "turnback");
  const turnbacks = turnbackIds.map((id) => candidateById(control.turnbackCandidates, id, "turnback"));
  const byOperationalStation = new Map();
  for (const candidate of turnbacks) {
    const stationId = operationalStationId(state, line, candidate.stationId);
    if (byOperationalStation.has(stationId)) throw new Error(`Several selected turnback candidates cover boundary ${stationId}`);
    byOperationalStation.set(stationId, candidate);
  }
  const assumptions = [];
  const usedTurnbackIds = new Set();
  const services = components.map((stationIds, index) => {
    const internalBoundaries = [stationIds[0], stationIds.at(-1)].filter((stationId) => stationId !== key(line.stationIds[0]) && stationId !== key(line.stationIds.at(-1)));
    const selected = internalBoundaries.map((stationId) => {
      const candidate = byOperationalStation.get(key(stationId));
      if (!candidate) throw new Error(`No selected turnback candidate covers retained-service boundary ${stationId}`);
      if (![true, false, null].includes(candidate.physicalAttachment)) throw new Error(`Turnback candidate ${candidate.candidateId} has invalid physical attachment`);
      if (candidate.physicalAttachment === false) throw new Error(`Turnback candidate ${candidate.candidateId} is physically detached`);
      if (candidate.physicalAttachment === null) {
        if (!input.confirmUnknownPhysicalAttachment) throw new Error(`Turnback candidate ${candidate.candidateId} has unconfirmed physical attachment`);
        assumptions.push(`turnback-attachment-unconfirmed:${candidate.candidateId}`);
      }
      usedTurnbackIds.add(key(candidate.candidateId));
      return candidate;
    });
    return serviceOf(stationIds, {
      serviceId: `retained-service:${index + 1}`,
      turnbackCandidateIds: selected.map((candidate) => candidate.candidateId),
      terminalResourceIds: selected.map((candidate) => candidate.terminalResourceId).filter(Boolean),
    });
  });
  const unusedTurnbackIds = turnbackIds.filter((id) => !usedTurnbackIds.has(id));
  if (unusedTurnbackIds.length) throw new Error(`Selected turnback candidates do not match a retained-service boundary: ${unusedTurnbackIds.join(", ")}`);
  return createRailwayControlOrder(state, {
    kind: "partial-suspension",
    eventId: event.id,
    lineId: line.id,
    candidateId: suspension.candidateId,
    retainedServices: services,
    controlGeometryId: control.controlGeometryId,
    controlGeometryRevision: control.controlGeometryRevision,
    suspendedTrackSegmentIds,
    turnbackCandidateIds: turnbackIds,
    assumptions,
  });
}

export function clearRailwayControlOrder(state, orderId, { atMinute = state.simMinutes, reason = "manual-clear" } = {}) {
  const order = state.railwayControlOrders?.orders?.find((entry) => entry.id === orderId);
  if (!order) throw new Error(`Unknown railway control order ${orderId}`);
  if (order.status !== "active") throw new Error(`Railway control order ${orderId} is already ${order.status}`);
  if (!Number.isFinite(atMinute) || atMinute < order.issuedAtMinute) throw new Error("Control order end time is invalid");
  order.status = "ended";
  order.endedAtMinute = atMinute;
  order.endReason = String(reason);
  state.networkDirty = true;
  invalidateWaitingRoutes(state, order.lineId);
  return clone(order);
}

export function syncRailwayControlOrders(state, atMinute = state.simMinutes) {
  const events = new Map((state.railwayDisruptions?.events ?? []).map((event) => [event.id, event]));
  const ended = [];
  for (const order of state.railwayControlOrders?.orders ?? []) {
    if (order.status !== "active") continue;
    const event = events.get(order.eventId);
    if (event && ["active", "responding"].includes(event.status)) continue;
    order.status = "ended";
    order.endedAtMinute = atMinute;
    order.endReason = event ? "disruption-resolved" : "event-missing";
    ended.push(clone(order));
  }
  if (ended.length) {
    state.networkDirty = true;
    for (const order of ended) invalidateWaitingRoutes(state, order.lineId);
  }
  return ended;
}

export function activeRailwayControlOrder(state, lineId) {
  const order = state?.railwayControlOrders?.orders?.find((entry) => entry.status === "active" && key(entry.lineId) === key(lineId));
  return order ? clone(order) : null;
}

export function effectiveLineStationIds(state, line, train = null) {
  if (Array.isArray(train?.serviceStationIds) && train.serviceStationIds.length >= 2) return [...train.serviceStationIds];
  const order = state?.railwayControlOrders?.orders?.find((entry) => entry.status === "active" && key(entry.lineId) === key(line.id));
  return order ? [...order.retainedStationIds] : [...line.stationIds];
}

export function effectiveLineStationGroups(state, line, train = null) {
  if (Array.isArray(train?.serviceStationIds) && train.serviceStationIds.length >= 2) return [[...train.serviceStationIds]];
  const order = state?.railwayControlOrders?.orders?.find((entry) => entry.status === "active" && key(entry.lineId) === key(line.id));
  if (!order) return [[...line.stationIds]];
  if (Array.isArray(order.retainedServices) && order.retainedServices.length) return order.retainedServices.map((service) => [...service.stationIds]);
  return [[...order.retainedStationIds]];
}

export function railwayControlOrderReport(state, lineId = null) {
  const orders = state?.railwayControlOrders?.orders ?? [];
  return clone(lineId === null ? orders : orders.filter((order) => key(order.lineId) === key(lineId)));
}
