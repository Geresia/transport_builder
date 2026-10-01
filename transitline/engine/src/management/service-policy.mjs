export const SERVICE_POLICY_SCHEMA = "transitline.service-policy/1";

export const STAFFING_POLICIES = Object.freeze({
  lean: { id: "lean", staffPerSet: 2, dailyStaffCostJPY: 39_000, punctualityAdjustment: -0.012, label: "최소인력" },
  balanced: { id: "balanced", staffPerSet: 2.5, dailyStaffCostJPY: 42_000, punctualityAdjustment: 0, label: "균형인력" },
  resilient: { id: "resilient", staffPerSet: 3.2, dailyStaffCostJPY: 47_000, punctualityAdjustment: 0.009, label: "예비인력" },
});

export const ELECTRICITY_CONTRACTS = Object.freeze({
  spot: { id: "spot", baseYenPerKwh: 24, volatility: 0.3, switchingCostJPY: 5_000_000, label: "시장연동" },
  fixed: { id: "fixed", baseYenPerKwh: 28, volatility: 0, switchingCostJPY: 18_000_000, label: "고정단가" },
  renewable: { id: "renewable", baseYenPerKwh: 31, volatility: 0.03, switchingCostJPY: 25_000_000, reputationDelta: 1, label: "재생에너지" },
});

function positive(value, label) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be positive`);
  return value;
}

export function serviceDemandMultiplier(service, effectiveFrequency = service.trainsPerHour) {
  const baseFare = service.baseAverageFare ?? 220;
  const baseFrequency = service.baseTrainsPerHour ?? service.trainsPerHour ?? 1;
  const fareRatio = Math.max(0.2, service.averageFare / baseFare);
  const frequencyRatio = Math.max(0.05, effectiveFrequency / Math.max(0.1, baseFrequency));
  return Math.max(0.2, Math.min(2.5, fareRatio ** -0.38 * frequencyRatio ** 0.28));
}

export function staffingPunctualityAdjustment(service) {
  return STAFFING_POLICIES[service.staffingPolicyId ?? "balanced"]?.punctualityAdjustment ?? 0;
}

export function electricityPriceForPeriod(service, rng) {
  const contract = ELECTRICITY_CONTRACTS[service.electricityContractId ?? "spot"] ?? ELECTRICITY_CONTRACTS.spot;
  if (!contract.volatility) return contract.baseYenPerKwh;
  return contract.baseYenPerKwh * (1 - contract.volatility / 2 + rng.next() * contract.volatility);
}

export function applyServicePolicy(service, input, { atMinute = 0 } = {}) {
  const fareJPY = positive(Number(input.fareJPY ?? service.averageFare), "Fare");
  const trainsPerHour = positive(Number(input.trainsPerHour ?? service.trainsPerHour), "Trains per hour");
  if (fareJPY < 100 || fareJPY > 2_000) throw new Error("Fare must be between JPY 100 and JPY 2,000");
  if (trainsPerHour < 0.5 || trainsPerHour > 30) throw new Error("Frequency must be between 0.5 and 30 trains per hour");
  const staffing = STAFFING_POLICIES[input.staffingPolicyId ?? service.staffingPolicyId ?? "balanced"];
  if (!staffing) throw new Error(`Unknown staffing policy ${input.staffingPolicyId}`);
  const electricity = ELECTRICITY_CONTRACTS[input.electricityContractId ?? service.electricityContractId ?? "spot"];
  if (!electricity) throw new Error(`Unknown electricity contract ${input.electricityContractId}`);
  service.baseAverageFare ??= service.averageFare;
  service.baseTrainsPerHour ??= service.trainsPerHour;
  service.baseDailyDemand ??= service.dailyDemand;
  const previous = {
    fareJPY: service.averageFare,
    trainsPerHour: service.trainsPerHour,
    staffingPolicyId: service.staffingPolicyId ?? "balanced",
    electricityContractId: service.electricityContractId ?? "spot",
  };
  service.averageFare = Math.round(fareJPY);
  service.trainsPerHour = trainsPerHour;
  service.staffingPolicyId = staffing.id;
  service.staffPerSet = staffing.staffPerSet;
  service.dailyStaffCost = staffing.dailyStaffCostJPY;
  service.electricityContractId = electricity.id;
  service.electricityYenPerKwh = electricity.baseYenPerKwh;
  service.policyRevision = (service.policyRevision ?? 0) + 1;
  service.policyHistory ??= [];
  const policy = {
    schema: SERVICE_POLICY_SCHEMA,
    contractVersion: 1,
    revision: service.policyRevision,
    atMinute,
    previous,
    current: { fareJPY: service.averageFare, trainsPerHour, staffingPolicyId: staffing.id, electricityContractId: electricity.id },
    forecastDemandMultiplier: serviceDemandMultiplier(service, trainsPerHour),
  };
  service.policyHistory.push(policy);
  return structuredClone(policy);
}

export function createOperatingCompetitor(input) {
  return {
    id: input.id,
    name: input.name ?? input.id,
    fareJPY: positive(Number(input.fareJPY ?? 240), "Competitor fare"),
    trainsPerHour: positive(Number(input.trainsPerHour ?? 3), "Competitor frequency"),
    punctuality: Math.max(0.5, Math.min(0.999, Number(input.punctuality ?? 0.965))),
    capacityPerTrain: positive(Number(input.capacityPerTrain ?? 500), "Competitor capacity"),
    costPerTrainKmJPY: positive(Number(input.costPerTrainKmJPY ?? 14_000), "Competitor train-km cost"),
    totals: { passengers: 0, revenueJPY: 0, costJPY: 0, profitJPY: 0 },
  };
}

function attractiveness({ fareJPY, trainsPerHour, punctuality }) {
  return Math.max(0.0001, trainsPerHour ** 0.42 * punctuality ** 1.8 / fareJPY ** 0.55);
}

export function settleOperatingMarketDay({ service, competitors = [], addressableDemand, playerPunctuality, routeKm } = {}) {
  if (!competitors.length) return { addressableDemand, playerShare: 1, competitors: [] };
  const playerScore = attractiveness({ fareJPY: service.averageFare, trainsPerHour: service.trainsPerHour, punctuality: playerPunctuality });
  const scores = competitors.map((entry) => attractiveness(entry));
  const total = playerScore + scores.reduce((sum, value) => sum + value, 0);
  const playerShare = playerScore / total;
  const results = competitors.map((entry, index) => {
    const share = scores[index] / total;
    const passengers = Math.round(addressableDemand * share);
    const trainKm = entry.trainsPerHour * 18 * routeKm * 2;
    const revenueJPY = Math.round(passengers * entry.fareJPY);
    const costJPY = Math.round(trainKm * entry.costPerTrainKmJPY);
    const profitJPY = revenueJPY - costJPY;
    entry.totals.passengers += passengers;
    entry.totals.revenueJPY += revenueJPY;
    entry.totals.costJPY += costJPY;
    entry.totals.profitJPY += profitJPY;
    return { competitorId: entry.id, share, passengers, trainKm, revenueJPY, costJPY, profitJPY };
  });
  return { addressableDemand, playerShare, competitors: results };
}
