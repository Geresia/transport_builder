const clone = (value) => structuredClone(value);

const BASE_COST_JPY = Object.freeze({
  "vehicle-failure": 20_000_000,
  "signal-failure": 35_000_000,
  "track-obstruction": 60_000_000,
  "severe-weather": 12_000_000,
  "construction-incident": 120_000_000,
});

const RESPONSES = Object.freeze([
  Object.freeze({ id: "emergency-recovery", label: "긴급 복구반 우선 투입", durationFactor: 0.45, costFactor: 2, reputationDelta: 1 }),
  Object.freeze({ id: "standard-recovery", label: "표준 복구 절차", durationFactor: 1, costFactor: 1, reputationDelta: 0 }),
  Object.freeze({ id: "safety-investigation", label: "안전조사 후 복구", durationFactor: 1.5, costFactor: 0.75, reputationDelta: 3 }),
  Object.freeze({ id: "wait-natural-recovery", label: "자연 회복·외부기관 조치 대기", durationFactor: 1.2, costFactor: 0, reputationDelta: -2 }),
]);

export function railwayDisruptionResponseOptions(event) {
  if (!BASE_COST_JPY[event?.kind]) throw new Error(`Unknown railway disruption kind ${event?.kind}`);
  return RESPONSES.map((response) => ({
    ...response,
    directCostJPY: Math.round(BASE_COST_JPY[event.kind] * response.costFactor),
  }));
}

export function applyRailwayDisruptionResponse(state, eventId, responseId, atMinute = state.simMinutes) {
  const event = state.railwayDisruptions?.events?.find((entry) => entry.id === eventId);
  if (!event) throw new Error(`Unknown railway disruption ${eventId}`);
  if (event.status !== "active") throw new Error(`Railway disruption ${eventId} cannot receive a response while ${event.status}`);
  if (event.response) throw new Error(`Railway disruption ${eventId} already has a response`);
  if (!Number.isFinite(atMinute) || atMinute < event.startedAtMinute) throw new Error("Railway disruption response time is invalid");
  const option = railwayDisruptionResponseOptions(event).find((entry) => entry.id === responseId);
  if (!option) throw new Error(`Unknown railway disruption response ${responseId}`);
  const remainingMinutes = Math.max(1, event.expectedEndMinute - atMinute);
  const revisedRemainingMinutes = Math.max(1, Math.round(remainingMinutes * option.durationFactor));
  event.status = "responding";
  event.expectedEndMinute = atMinute + revisedRemainingMinutes;
  event.response = {
    responseId: option.id,
    label: option.label,
    selectedAtMinute: atMinute,
    directCostJPY: option.directCostJPY,
    reputationDelta: option.reputationDelta,
    durationFactor: option.durationFactor,
    originalRemainingMinutes: remainingMinutes,
    revisedRemainingMinutes,
  };
  return clone(event.response);
}
