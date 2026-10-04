export const RAILWAY_CONTROL_ORDER_SCHEMA = "transitline.railway-control-order/1";

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
  const path = retainedPath(line, input);
  for (let index = 0; index < path.stationIds.length - 1; index += 1) {
    const matches = segmentBetween(state, line, path.stationIds[index], path.stationIds[index + 1]);
    if (matches.length !== 1) throw new Error(`Retained service path is ${matches.length ? "ambiguous" : "unmapped"}`);
    if (event.trackSegmentId !== null && key(matches[0].id) === key(event.trackSegmentId)) throw new Error("Retained service path still crosses the disrupted track segment");
  }
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
    startStationId: key(path.stationIds[0]),
    endStationId: key(path.stationIds.at(-1)),
    retainedStationIds: path.stationIds.map(key),
    omittedStationIds: line.stationIds.filter((_, index) => index < path.startIndex || index > path.endIndex).map(key),
    turnbackStationId: input.kind === "short-turn" ? key(input.turnbackStationId ?? path.stationIds.at(-1)) : null,
    terminalResourceId: input.terminalResourceId ?? null,
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

export function railwayControlOrderReport(state, lineId = null) {
  const orders = state?.railwayControlOrders?.orders ?? [];
  return clone(lineId === null ? orders : orders.filter((order) => key(order.lineId) === key(lineId)));
}
