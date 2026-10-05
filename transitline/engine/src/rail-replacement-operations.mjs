export const RAIL_REPLACEMENT_OPERATION_SCHEMA = "transitline.rail-replacement-operation/1";

export const REPLACEMENT_BUS_CLASSES = Object.freeze({
  minibus: Object.freeze({ id: "minibus", label: "Minibus", passengerCapacity: 25, widthMeters: 2.1, averageSpeedMps: 7.0, dwellSeconds: 25, layoverSeconds: 240 }),
  standard: Object.freeze({ id: "standard", label: "Standard route bus", passengerCapacity: 70, widthMeters: 2.5, averageSpeedMps: 7.5, dwellSeconds: 30, layoverSeconds: 300 }),
  coach: Object.freeze({ id: "coach", label: "Charter coach", passengerCapacity: 55, widthMeters: 2.5, averageSpeedMps: 8.3, dwellSeconds: 45, layoverSeconds: 300 }),
});

// 2026 JPY gameplay balancing values. They are explicit commercial assumptions, not map facts or market quotations.
export const REPLACEMENT_BUS_PROCUREMENT = Object.freeze({
  "emergency-charter": Object.freeze({ id: "emergency-charter", label: "Emergency charter", mobilizationMinutes: 60, mobilizationJPYPerVehicle: 180_000, operatingJPYPerVehicleHour: 18_000, reputationDelta: 0 }),
  "mutual-aid": Object.freeze({ id: "mutual-aid", label: "Operator mutual aid", mobilizationMinutes: 120, mobilizationJPYPerVehicle: 100_000, operatingJPYPerVehicleHour: 15_000, reputationDelta: 1 }),
  "municipal-request": Object.freeze({ id: "municipal-request", label: "Municipal emergency request", mobilizationMinutes: 180, mobilizationJPYPerVehicle: 60_000, operatingJPYPerVehicleHour: 12_000, reputationDelta: -1 }),
});

const clone = (value) => structuredClone(value);
const key = (value) => String(value);
const roundMoney = (value) => Math.round(value);

function ensureStore(state) {
  state.railReplacementOperations ??= { operations: [], trips: [], nextSequence: 1, nextTripSequence: 1, nextVirtualLineId: -1 };
  state.railReplacementOperations.operations ??= [];
  state.railReplacementOperations.trips ??= [];
  state.railReplacementOperations.nextSequence ??= 1;
  state.railReplacementOperations.nextTripSequence ??= 1;
  state.railReplacementOperations.nextVirtualLineId ??= -1;
  return state.railReplacementOperations;
}

function ongoingEvent(state, eventId) {
  const event = state.railwayDisruptions?.events?.find((entry) => key(entry.id) === key(eventId));
  if (!event) throw new Error(`Unknown railway disruption ${eventId}`);
  if (!["active", "responding"].includes(event.status)) throw new Error(`Railway disruption ${eventId} is not ongoing`);
  return event;
}

function activeControlOrder(state, orderId, eventId) {
  const order = state.railwayControlOrders?.orders?.find((entry) => key(entry.id) === key(orderId));
  if (!order) throw new Error(`Unknown railway control order ${orderId}`);
  if (order.status !== "active" || key(order.eventId) !== key(eventId)) throw new Error(`Railway control order ${orderId} is not active for disruption ${eventId}`);
  return order;
}

function operationalStationId(state, line, sourceId) {
  const matches = line.stationIds.filter((stationId) => {
    const station = state.stations.get(stationId) ?? state.stations.get(key(stationId));
    return key(station?.sourceStationId ?? stationId) === key(sourceId);
  });
  if (matches.length !== 1) throw new Error(matches.length
    ? `Replacement stop ${sourceId} is ambiguous on operational line ${line.id}`
    : `Replacement stop ${sourceId} is not on operational line ${line.id}`);
  return matches[0];
}

function normaliseCandidate(state, line, candidate) {
  if (!candidate?.candidateId) throw new Error("A replacement-transport candidate id is required");
  const sourceStationIds = candidate.stationIds ?? candidate.railStationIds;
  if (!Array.isArray(sourceStationIds) || sourceStationIds.length < 2) throw new Error("A replacement-transport candidate requires at least two rail stations");
  const stationIds = sourceStationIds.map((stationId) => operationalStationId(state, line, stationId));
  if (new Set(stationIds.map(key)).size !== stationIds.length) throw new Error("A replacement-transport candidate cannot repeat a station");
  let legDistancesMeters = candidate.legDistancesMeters;
  if (!Array.isArray(legDistancesMeters) && stationIds.length === 2 && Number.isFinite(candidate.roadDistanceMeters)) legDistancesMeters = [candidate.roadDistanceMeters];
  if (!Array.isArray(legDistancesMeters) || legDistancesMeters.length !== stationIds.length - 1
    || legDistancesMeters.some((distance) => !(Number.isFinite(distance) && distance > 0))) {
    throw new Error("Measured road distance is required for every replacement-transport leg");
  }
  if (![true, false, null].includes(candidate.roadConnection)) throw new Error("Replacement road connection must be true, false or null");
  if (candidate.minimumRoadWidthMeters !== null && !(Number.isFinite(candidate.minimumRoadWidthMeters) && candidate.minimumRoadWidthMeters > 0)) {
    throw new Error("Replacement minimum road width must be positive or null");
  }
  return { candidateId: key(candidate.candidateId), stationIds, legDistancesMeters: [...legDistancesMeters], roadConnection: candidate.roadConnection,
    minimumRoadWidthMeters: candidate.minimumRoadWidthMeters, geometryId: candidate.geometryId ?? candidate.replacementTransportGeometryId ?? null,
    geometryRevision: candidate.geometryRevision ?? candidate.replacementTransportGeometryRevision ?? null };
}

export function assessRailReplacementOperation(state, input = {}) {
  if (!state) throw new Error("Operational state is required");
  const event = ongoingEvent(state, input.eventId);
  const order = activeControlOrder(state, input.controlOrderId, event.id);
  const line = state.lines.find((entry) => key(entry.id) === key(order.lineId));
  if (!line) throw new Error(`Unknown operational line ${order.lineId}`);
  const candidate = normaliseCandidate(state, line, input.candidate);
  const vehicleClass = REPLACEMENT_BUS_CLASSES[input.vehicleClassId];
  const procurement = REPLACEMENT_BUS_PROCUREMENT[input.procurementStrategyId];
  if (!vehicleClass) throw new Error(`Unknown replacement bus class ${input.vehicleClassId}`);
  if (!procurement) throw new Error(`Unknown replacement bus procurement ${input.procurementStrategyId}`);
  const vehicleCount = Number(input.vehicleCount);
  if (!Number.isSafeInteger(vehicleCount) || vehicleCount < 1 || vehicleCount > 100) throw new Error("Replacement vehicle count must be an integer from 1 to 100");

  const failures = [];
  const confirmations = [];
  if (candidate.roadConnection === false) failures.push("replacement-road-disconnected");
  if (candidate.roadConnection === null) confirmations.push("replacement-road-connection-unknown");
  if (candidate.minimumRoadWidthMeters === null) confirmations.push("replacement-road-width-unknown");
  else if (candidate.minimumRoadWidthMeters + 1e-9 < vehicleClass.widthMeters) failures.push("replacement-road-too-narrow");
  const assumptions = [];
  if (confirmations.length && input.confirmUnknownRoadFacts === true) assumptions.push(...confirmations);
  const verdict = failures.length ? "infeasible" : confirmations.length && !input.confirmUnknownRoadFacts ? "conditional" : "feasible";
  const oneWayRunSeconds = candidate.legDistancesMeters.reduce((total, distance) => total + distance / vehicleClass.averageSpeedMps, 0);
  const oneWaySeconds = oneWayRunSeconds + Math.max(0, candidate.stationIds.length - 2) * vehicleClass.dwellSeconds;
  const cycleSeconds = oneWaySeconds * 2 + vehicleClass.layoverSeconds * 2;
  const headwaySeconds = cycleSeconds / vehicleCount;
  const departuresPerHourPerDirection = 3600 / headwaySeconds;
  return {
    schema: "transitline.rail-replacement-assessment/1", contractVersion: 1,
    eventId: event.id, controlOrderId: order.id, operationalLineId: key(line.id), candidate,
    vehicleClassId: vehicleClass.id, procurementStrategyId: procurement.id, vehicleCount,
    verdict, failures, confirmations, assumptions,
    mobilisationMinutes: procurement.mobilizationMinutes,
    oneWaySeconds, cycleSeconds, headwaySeconds, departuresPerHourPerDirection,
    passengerCapacityPerDeparture: vehicleClass.passengerCapacity,
    passengerCapacityPerHourPerDirection: departuresPerHourPerDirection * vehicleClass.passengerCapacity,
    mobilisationCostJPY: roundMoney(procurement.mobilizationJPYPerVehicle * vehicleCount),
    operatingCostJPYPerHour: roundMoney(procurement.operatingJPYPerVehicleHour * vehicleCount),
    reputationDelta: procurement.reputationDelta,
  };
}

export function startRailReplacementOperation(state, input = {}) {
  const assessment = assessRailReplacementOperation(state, input);
  if (assessment.verdict !== "feasible") throw new Error(`Replacement operation cannot start: ${[...assessment.failures, ...assessment.confirmations].join(", ")}`);
  const store = ensureStore(state);
  if (store.operations.some((operation) => operation.status !== "ended" && key(operation.controlOrderId) === key(assessment.controlOrderId))) {
    throw new Error(`Railway control order ${assessment.controlOrderId} already has replacement transport`);
  }
  const sequence = store.nextSequence;
  const operation = {
    schema: RAIL_REPLACEMENT_OPERATION_SCHEMA, contractVersion: 1, id: input.id ?? `rail-replacement-operation:${sequence}`,
    status: assessment.mobilisationMinutes > 0 ? "mobilising" : "active",
    eventId: assessment.eventId, controlOrderId: assessment.controlOrderId, operationalLineId: assessment.operationalLineId,
    candidateId: assessment.candidate.candidateId, geometryId: assessment.candidate.geometryId, geometryRevision: assessment.candidate.geometryRevision,
    virtualLineId: store.nextVirtualLineId, stationIds: assessment.candidate.stationIds, legDistancesMeters: assessment.candidate.legDistancesMeters,
    roadConnection: assessment.candidate.roadConnection, minimumRoadWidthMeters: assessment.candidate.minimumRoadWidthMeters,
    vehicleClassId: assessment.vehicleClassId, procurementStrategyId: assessment.procurementStrategyId, vehicleCount: assessment.vehicleCount,
    passengerCapacityPerDeparture: assessment.passengerCapacityPerDeparture, headwaySeconds: assessment.headwaySeconds,
    oneWaySeconds: assessment.oneWaySeconds, cycleSeconds: assessment.cycleSeconds,
    mobilisationCostJPY: assessment.mobilisationCostJPY, operatingCostJPYPerHour: assessment.operatingCostJPYPerHour,
    assumptions: assessment.assumptions, requestedAtMinute: state.simMinutes,
    requestedAtGameMinute: Number.isFinite(input.requestedAtGameMinute) ? input.requestedAtGameMinute : null,
    serviceStartsAtMinute: state.simMinutes + assessment.mobilisationMinutes, endedAtMinute: null, endReason: null,
    lastDispatchMinute: -Infinity, accruedVehicleMinutes: 0, settledOperatingCostJPY: 0,
    passengersCarried: 0, vehicleKilometres: 0,
  };
  if (store.operations.some((entry) => entry.id === operation.id)) throw new Error(`Duplicate rail replacement operation ${operation.id}`);
  store.operations.push(operation);
  store.nextSequence += 1;
  store.nextVirtualLineId -= 1;
  if (operation.status === "active") state.networkDirty = true;
  return clone(operation);
}

export function activeRailReplacementOperations(state) {
  return clone((state?.railReplacementOperations?.operations ?? []).filter((operation) => operation.status === "active"));
}

export function advanceRailReplacementOperations(state, seconds) {
  const store = ensureStore(state);
  const events = new Map((state.railwayDisruptions?.events ?? []).map((event) => [key(event.id), event]));
  const orders = new Map((state.railwayControlOrders?.orders ?? []).map((order) => [key(order.id), order]));
  const previousMinute = state.simMinutes - Math.max(0, seconds) / 60;
  for (const operation of store.operations) {
    if (operation.status === "ended") continue;
    const event = events.get(key(operation.eventId));
    const order = orders.get(key(operation.controlOrderId));
    const ongoing = event && ["active", "responding"].includes(event.status) && order?.status === "active";
    if (!ongoing && operation.status !== "ending") {
      operation.status = "ending";
      operation.endReason = !event || !["active", "responding"].includes(event.status) ? "disruption-ended" : "control-order-ended";
      state.networkDirty = true;
    }
    if (operation.status === "mobilising" && ongoing && state.simMinutes + 1e-9 >= operation.serviceStartsAtMinute) {
      operation.status = "active";
      state.networkDirty = true;
    }
    if (operation.status === "active") {
      const activeMinutes = Math.max(0, state.simMinutes - Math.max(previousMinute, operation.serviceStartsAtMinute));
      operation.accruedVehicleMinutes += activeMinutes * operation.vehicleCount;
    } else if (operation.status === "ending") operation.accruedVehicleMinutes += Math.max(0, seconds) * operation.vehicleCount / 60;
    if (operation.status === "ending" && !store.trips.some((trip) => trip.operationId === operation.id)) {
      operation.status = "ended";
      operation.endedAtMinute = state.simMinutes;
    }
  }
  store.trips = store.trips.filter((trip) => store.operations.some((operation) => operation.id === trip.operationId && ["active", "ending"].includes(operation.status)));
}

function handleReplacementStop(state, trip, operation, stationId, allowBoarding = true) {
  const kept = [];
  let load = 0;
  for (const passenger of state.passengers ?? []) {
    if (passenger.state === "onboard" && passenger.replacementTripId === trip.id) {
      const hop = passenger.route?.[passenger.hopIndex];
      if (hop?.alightStationId === stationId) {
        passenger.replacementTripId = null;
        if (passenger.hopIndex === passenger.route.length - 1) {
          state.stats.delivered += 1;
          state.stats.deliveredByHour[Math.floor(state.simMinutes / 60) % 24] += 1;
          state.stats.deliveredByLine[operation.operationalLineId] = (state.stats.deliveredByLine[operation.operationalLineId] ?? 0) + 1;
          operation.passengersCarried += 1;
          continue;
        }
        passenger.hopIndex += 1;
        passenger.currentStationId = stationId;
        passenger.state = "waiting";
        passenger.waitingSince = state.simMinutes;
      } else load += 1;
    }
    kept.push(passenger);
  }
  state.passengers = kept;
  if (!allowBoarding) return;
  const ids = trip.stationIds;
  const stopIndex = trip.segIndex;
  for (const passenger of state.passengers) {
    if (load >= trip.passengerCapacity) break;
    if (passenger.state !== "waiting" || !passenger.route?.[passenger.hopIndex]) continue;
    const hop = passenger.route[passenger.hopIndex];
    if (Number(hop.lineId) !== operation.virtualLineId || key(hop.boardStationId) !== key(stationId)) continue;
    const alightIndex = ids.findIndex((id) => key(id) === key(hop.alightStationId));
    if (alightIndex < 0 || (trip.dir === 1 ? alightIndex <= stopIndex : alightIndex >= stopIndex)) continue;
    passenger.state = "onboard";
    passenger.trainId = null;
    passenger.replacementTripId = trip.id;
    load += 1;
  }
}

export function dispatchRailReplacementBuses(state) {
  const store = ensureStore(state);
  for (const operation of store.operations) {
    if (operation.status !== "active") continue;
    if ((state.simMinutes - operation.lastDispatchMinute) * 60 + 1e-9 < operation.headwaySeconds) continue;
    operation.lastDispatchMinute = state.simMinutes;
    const vehicleClass = REPLACEMENT_BUS_CLASSES[operation.vehicleClassId];
    const trip = {
      id: `rail-replacement-trip:${store.nextTripSequence++}`, operationId: operation.id, routeId: operation.virtualLineId,
      stationIds: [...operation.stationIds], legDistancesMeters: [...operation.legDistancesMeters], passengerCapacity: vehicleClass.passengerCapacity,
      segIndex: 0, dir: 1, progress: 0, dwellSeconds: vehicleClass.dwellSeconds, done: false,
    };
    store.trips.push(trip);
    handleReplacementStop(state, trip, operation, trip.stationIds[0]);
  }
}

export function stepRailReplacementBuses(state, seconds) {
  const store = ensureStore(state);
  const operations = new Map(store.operations.map((operation) => [operation.id, operation]));
  for (const trip of store.trips) {
    const operation = operations.get(trip.operationId);
    if (!operation || !["active", "ending"].includes(operation.status)) { trip.done = true; continue; }
    const vehicleClass = REPLACEMENT_BUS_CLASSES[operation.vehicleClassId];
    let remaining = Math.max(0, seconds);
    while (remaining > 1e-9 && !trip.done) {
      if (trip.dwellSeconds > 0) {
        const used = Math.min(trip.dwellSeconds, remaining);
        trip.dwellSeconds -= used;
        remaining -= used;
        if (remaining <= 1e-9) break;
      }
      const nextIndex = trip.segIndex + trip.dir;
      if (nextIndex < 0 || nextIndex >= trip.stationIds.length) { trip.done = true; break; }
      const physicalLegIndex = Math.min(trip.segIndex, nextIndex);
      const legDistance = trip.legDistancesMeters[physicalLegIndex];
      const secondsToEnd = (1 - trip.progress) * legDistance / vehicleClass.averageSpeedMps;
      if (remaining + 1e-9 < secondsToEnd) {
        const moved = remaining * vehicleClass.averageSpeedMps;
        trip.progress += moved / legDistance;
        operation.vehicleKilometres += moved / 1000;
        remaining = 0;
        break;
      }
      remaining -= secondsToEnd;
      operation.vehicleKilometres += (1 - trip.progress) * legDistance / 1000;
      trip.progress = 0;
      trip.segIndex = nextIndex;
      const finished = trip.segIndex === 0 && trip.dir === -1;
      handleReplacementStop(state, trip, operation, trip.stationIds[trip.segIndex], !finished && operation.status === "active");
      if (finished) { trip.done = true; break; }
      if (trip.segIndex === trip.stationIds.length - 1) trip.dir = -1;
      trip.dwellSeconds = trip.segIndex === 0 || trip.segIndex === trip.stationIds.length - 1 ? vehicleClass.layoverSeconds : vehicleClass.dwellSeconds;
    }
  }
  store.trips = store.trips.filter((trip) => !trip.done);
  for (const operation of store.operations) if (operation.status === "ending" && !store.trips.some((trip) => trip.operationId === operation.id)) {
    operation.status = "ended";
    operation.endedAtMinute = state.simMinutes;
  }
}

export function railReplacementGraphServices(state) {
  return activeRailReplacementOperations(state).map((operation) => ({
    lineId: operation.virtualLineId, stationIds: operation.stationIds,
    legSeconds: operation.legDistancesMeters.map((distance) => distance / REPLACEMENT_BUS_CLASSES[operation.vehicleClassId].averageSpeedMps),
    dwellSeconds: REPLACEMENT_BUS_CLASSES[operation.vehicleClassId].dwellSeconds,
  }));
}

export function railReplacementTripViews(state) {
  const operations = new Map((state?.railReplacementOperations?.operations ?? []).map((operation) => [operation.id, operation]));
  return (state?.railReplacementOperations?.trips ?? []).map((trip) => {
    const operation = operations.get(trip.operationId);
    const ids = trip.stationIds;
    const ahead = trip.dir === -1 ? ids.slice(0, trip.segIndex + 1).reverse() : [...ids.slice(trip.segIndex), ...ids.slice(0, -1).reverse()];
    return { id: trip.id, routeId: operation.virtualLineId, stopped: trip.dwellSeconds > 0 && trip.progress === 0,
      stationId: ids[trip.segIndex], stationsAhead: ahead, maxCapacity: trip.passengerCapacity };
  });
}

export function railReplacementSettlementDue(state) {
  return (state?.railReplacementOperations?.operations ?? []).map((operation) => {
    const totalOperatingCostJPY = roundMoney(operation.accruedVehicleMinutes / 60 * operation.operatingCostJPYPerHour);
    return { operationId: operation.id, totalOperatingCostJPY, dueJPY: Math.max(0, totalOperatingCostJPY - operation.settledOperatingCostJPY) };
  }).filter((entry) => entry.dueJPY > 0);
}

export function markRailReplacementSettled(state, operationId, amountJPY) {
  const operation = state.railReplacementOperations?.operations?.find((entry) => entry.id === operationId);
  if (!operation) throw new Error(`Unknown rail replacement operation ${operationId}`);
  if (!Number.isSafeInteger(amountJPY) || amountJPY < 0) throw new Error("Replacement settlement amount must be a non-negative integer");
  const due = railReplacementSettlementDue(state).find((entry) => entry.operationId === operationId)?.dueJPY ?? 0;
  if (amountJPY !== due) throw new Error(`Replacement settlement must equal due amount ${due}`);
  operation.settledOperatingCostJPY += amountJPY;
  return clone(operation);
}

export function railReplacementOperationReport(state) {
  return clone(state?.railReplacementOperations?.operations ?? []);
}
