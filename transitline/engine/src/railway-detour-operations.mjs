// Temporary railway detours are commercial operations, not map geometry.  A detour may start only
// from a current authorization; its monetary accrual is explicit and can be settled atomically by
// ScenarioRuntime.  This deliberately does not invent a train path from incomplete external topology.
export const RAILWAY_DETOUR_OPERATION_SCHEMA = "transitline.railway-detour-operation/1";

const key = (value) => String(value);
const clone = (value) => structuredClone(value);
const money = (value) => Math.round(value);

// 2026 JPY gameplay assumptions. They are operational balancing inputs, never map-derived facts.
export const DETOUR_OPERATION_COSTS = Object.freeze({
  trainCrewAndEnergyJPYPerTrainHour: 180_000,
  trackAccessJPYPerTrainKm: 420,
  averageCommercialSpeedKph: 45,
});

function storeOf(state) {
  state.railwayDetourOperations ??= { operations: [], nextSequence: 1 };
  state.railwayDetourOperations.operations ??= [];
  state.railwayDetourOperations.nextSequence ??= 1;
  return state.railwayDetourOperations;
}

function authorizationOf(state, authorizationId) {
  const authorization = state?.railwayDetourAuthorizations?.authorizations?.find((entry) => key(entry.id) === key(authorizationId));
  if (!authorization) throw new Error(`Unknown railway detour authorization ${authorizationId}`);
  if (authorization.status !== "authorized") throw new Error(`Railway detour authorization ${authorizationId} is ${authorization.status}`);
  return authorization;
}

function continuing(state, operation) {
  const event = state?.railwayDisruptions?.events?.find((entry) => key(entry.id) === key(operation.eventId));
  const order = state?.railwayControlOrders?.orders?.find((entry) => key(entry.id) === key(operation.controlOrderId));
  const authorization = state?.railwayDetourAuthorizations?.authorizations?.find((entry) => key(entry.id) === key(operation.authorizationId));
  return Boolean(event && ["active", "responding"].includes(event.status) && order?.status === "active" && authorization?.status === "authorized");
}

function measuredLength(authorization) {
  const length = Number(authorization?.detourLengthMeters ?? authorization?.lengthMeters);
  if (!(Number.isFinite(length) && length > 0)) throw new Error("A measured detour length is required to start railway detour operation");
  return length;
}

export function startRailwayDetourOperation(state, input = {}) {
  if (!state) throw new Error("Operational state is required");
  const authorization = authorizationOf(state, input.authorizationId);
  const detourLengthMeters = measuredLength(authorization);
  const store = storeOf(state);
  if (store.operations.some((entry) => entry.status !== "ended" && key(entry.controlOrderId) === key(authorization.controlOrderId))) {
    throw new Error(`Railway control order ${authorization.controlOrderId} already has an active detour operation`);
  }
  // Costs are engine rules, never caller-provided geometry/UI values.
  const trainCrewAndEnergyJPYPerTrainHour = DETOUR_OPERATION_COSTS.trainCrewAndEnergyJPYPerTrainHour;
  const trackAccessJPYPerTrainKm = DETOUR_OPERATION_COSTS.trackAccessJPYPerTrainKm;
  const averageCommercialSpeedKph = DETOUR_OPERATION_COSTS.averageCommercialSpeedKph;
  if (!(Number.isFinite(trainCrewAndEnergyJPYPerTrainHour) && trainCrewAndEnergyJPYPerTrainHour >= 0)) throw new Error("Detour train operating cost must be non-negative");
  if (!(Number.isFinite(trackAccessJPYPerTrainKm) && trackAccessJPYPerTrainKm >= 0)) throw new Error("Detour track access cost must be non-negative");
  if (!(Number.isFinite(averageCommercialSpeedKph) && averageCommercialSpeedKph > 0)) throw new Error("Detour commercial speed must be positive");
  const id = input.id ?? `railway-detour-operation:${store.nextSequence}`;
  if (store.operations.some((entry) => key(entry.id) === key(id))) throw new Error(`Duplicate railway detour operation ${id}`);
  const operation = {
    schema: RAILWAY_DETOUR_OPERATION_SCHEMA, contractVersion: 1, id, status: "active",
    authorizationId: authorization.id, eventId: authorization.eventId, controlOrderId: authorization.controlOrderId,
    detourGeometryId: authorization.detourGeometryId, detourGeometryRevision: authorization.detourGeometryRevision,
    vehicleModelId: authorization.vehicleModelId, trainsPerHour: authorization.trainsPerHour,
    trackAccessAgreementIds: [...(authorization.trackAccessAgreementIds ?? [])], detourLengthMeters,
    trainCrewAndEnergyJPYPerTrainHour, trackAccessJPYPerTrainKm, averageCommercialSpeedKph,
    startedAtMinute: state.simMinutes, startedAtGameMinute: Number.isFinite(input.startedAtGameMinute) ? input.startedAtGameMinute : null, endedAtMinute: null, endReason: null,
    accruedTrainMinutes: 0, accruedTrainKilometres: 0, settledOperatingCostJPY: 0, settledAccessCostJPY: 0,
  };
  store.operations.push(operation);
  store.nextSequence += 1;
  return clone(operation);
}

export function advanceRailwayDetourOperations(state, seconds = 0) {
  const store = storeOf(state);
  const elapsedMinutes = Math.max(0, Number(seconds) || 0) / 60;
  for (const operation of store.operations) {
    if (operation.status !== "active") continue;
    if (!continuing(state, operation)) {
      operation.status = "ended";
      operation.endedAtMinute = state.simMinutes;
      operation.endReason = "disruption-or-control-ended";
      continue;
    }
    const departures = elapsedMinutes * operation.trainsPerHour / 60;
    const trainMinutes = departures * operation.detourLengthMeters / 1000 / operation.averageCommercialSpeedKph * 60;
    operation.accruedTrainMinutes += trainMinutes;
    operation.accruedTrainKilometres += departures * operation.detourLengthMeters / 1000;
  }
}

export function railwayDetourSettlementDue(state) {
  return (state?.railwayDetourOperations?.operations ?? []).map((operation) => {
    const totalOperatingCostJPY = money(operation.accruedTrainMinutes / 60 * operation.trainCrewAndEnergyJPYPerTrainHour);
    const totalAccessCostJPY = money(operation.accruedTrainKilometres * operation.trackAccessJPYPerTrainKm);
    return { operationId: operation.id, operatingDueJPY: Math.max(0, totalOperatingCostJPY - operation.settledOperatingCostJPY), accessDueJPY: Math.max(0, totalAccessCostJPY - operation.settledAccessCostJPY) };
  }).filter((entry) => entry.operatingDueJPY > 0 || entry.accessDueJPY > 0);
}

export function markRailwayDetourSettled(state, operationId, settlement = {}) {
  const operation = state?.railwayDetourOperations?.operations?.find((entry) => key(entry.id) === key(operationId));
  if (!operation) throw new Error(`Unknown railway detour operation ${operationId}`);
  const due = railwayDetourSettlementDue(state).find((entry) => key(entry.operationId) === key(operationId)) ?? { operatingDueJPY: 0, accessDueJPY: 0 };
  if (settlement.operatingDueJPY !== due.operatingDueJPY || settlement.accessDueJPY !== due.accessDueJPY) throw new Error("Detour settlement must equal the current due amounts");
  operation.settledOperatingCostJPY += due.operatingDueJPY;
  operation.settledAccessCostJPY += due.accessDueJPY;
  return clone(operation);
}

export function railwayDetourOperationReport(state) {
  return clone(state?.railwayDetourOperations?.operations ?? []);
}
