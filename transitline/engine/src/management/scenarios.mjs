const DIFFICULTY = {
  easy: { budgetFactor: 1.35, demandFactor: 1.1, delayFactor: 0.7, competitorStrength: 0.85, targetFactor: 0.85 },
  normal: { budgetFactor: 1, demandFactor: 1, delayFactor: 1, competitorStrength: 1, targetFactor: 1 },
  hard: { budgetFactor: 0.78, demandFactor: 0.9, delayFactor: 1.35, competitorStrength: 1.15, targetFactor: 1.2 },
};

const TYPES = {
  congestion_relief: {
    name: "신도시 교통난 해결",
    requiresExistingNetwork: true,
    baseBudget: 420_000_000_000,
    deadlineYears: 8,
    targetDailyPassengers: 85_000,
    targetStations: 5,
    targetRouteKm: 18,
  },
  greenfield_growth: {
    name: "무철도 도시 성장",
    requiresExistingNetwork: false,
    // Calibrated so the normal 40 km / 7 station objective can fund a
    // compact underground AGT with a modest reserve, while heavy rail still
    // requires a cheaper alignment, extra finance or scope trade-offs.
    baseBudget: 1_050_000_000_000,
    deadlineYears: 10,
    targetDailyPassengers: 120_000,
    targetStations: 7,
    targetRouteKm: 40,
  },
  airport_connector: {
    name: "공항 접근철도",
    requiresExistingNetwork: false,
    baseBudget: 900_000_000_000,
    deadlineYears: 9,
    targetDailyPassengers: 70_000,
    targetStations: 4,
    targetRouteKm: 32,
  },
  network_resilience: {
    name: "기존망 우회축 확보",
    requiresExistingNetwork: true,
    baseBudget: 520_000_000_000,
    deadlineYears: 7,
    targetDailyPassengers: 65_000,
    targetStations: 6,
    targetRouteKm: 24,
  },
};

export function createScenario({ id, type, networkMode, fundingMode = "limited", difficulty = "normal", countryId = "JP" }) {
  const template = TYPES[type];
  const tuning = DIFFICULTY[difficulty];
  if (!template) throw new Error(`Unknown scenario type ${type}`);
  if (!tuning) throw new Error(`Unknown difficulty ${difficulty}`);
  if (!["existing", "scratch"].includes(networkMode)) throw new Error(`Unknown network mode ${networkMode}`);
  if (!["sandbox", "limited"].includes(fundingMode)) throw new Error(`Unknown funding mode ${fundingMode}`);
  if (template.requiresExistingNetwork && networkMode !== "existing") throw new Error(`${template.name} requires the existing-network mode`);
  const budget = fundingMode === "sandbox" ? Number.MAX_SAFE_INTEGER : template.baseBudget * tuning.budgetFactor;
  return {
    id,
    type,
    name: template.name,
    countryId,
    networkMode,
    fundingMode,
    difficulty,
    startingCash: budget,
    demandFactor: tuning.demandFactor,
    delayFactor: tuning.delayFactor,
    competitorStrength: tuning.competitorStrength,
    deadlineMinute: template.deadlineYears * 365 * 1440,
    objectives: {
      minimumDailyPassengers: Math.round(template.targetDailyPassengers * tuning.targetFactor),
      minimumStations: template.targetStations,
      minimumRouteKm: template.targetRouteKm,
      maximumPublicCost: fundingMode === "sandbox" ? null : budget,
      positiveOperatingProfit: difficulty !== "easy",
    },
    status: "not-started",
    score: null,
  };
}

export function applyScenario(game, scenario, pack) {
  if (scenario.status !== "not-started") throw new Error(`Scenario ${scenario.id} already started`);
  if (scenario.networkMode === "existing" && !(pack.existingNetwork?.lines?.length > 0)) throw new Error("Scenario requires an existing network in the selected pack");
  game.scenario = structuredClone(scenario);
  game.scenario.status = "active";
  game.scenario.startedAt = game.clock.minute;
  game.scenario.initialCash = game.ledger.cash;
  game.scenario.initialNetworkLines = scenario.networkMode === "existing" ? pack.existingNetwork.lines.length : 0;
  for (const competitor of game.competitors) {
    competitor.operatingScore = Math.min(100, competitor.operatingScore * scenario.competitorStrength);
    competitor.cash *= scenario.competitorStrength;
  }
  game.events.record(game.clock.minute, "scenario-started", { scenarioId: scenario.id, networkMode: scenario.networkMode, difficulty: scenario.difficulty });
  return game.scenario;
}

export function evaluateScenario(game, operationalState) {
  const scenario = game.scenario;
  if (!scenario) throw new Error("No active scenario");
  const ownedLines = operationalState.lines.filter((line) => line.owned && !line.suspended);
  const ownedStationIds = new Set(ownedLines.flatMap((line) => line.stationIds));
  const routeKm = operationalState.trackSegments.filter((segment) => ownedLines.some((line) => line.trackSegmentIds?.includes(segment.id)))
    .reduce((sum, segment) => sum + segment.lengthMeters / 1000, 0);
  const integrated = game.services.reduce((totals, service) => {
    totals.passengers += service.integratedTotals?.passengers ?? service.totals?.boarded ?? 0;
    totals.days += service.daysOperated || (service.engineCursor ? 1 : 0);
    totals.profit += (service.integratedTotals?.income ?? service.totals?.revenue ?? 0) - (service.integratedTotals?.cost ?? service.totals?.cost ?? 0);
    return totals;
  }, { passengers: 0, days: 0, profit: 0 });
  const dailyPassengers = integrated.days > 0 ? integrated.passengers / integrated.days : 0;
  const spent = scenario.initialCash - game.ledger.cash;
  const checks = {
    deadline: game.clock.minute <= scenario.deadlineMinute,
    passengers: dailyPassengers >= scenario.objectives.minimumDailyPassengers,
    stations: ownedStationIds.size >= scenario.objectives.minimumStations,
    routeLength: routeKm >= scenario.objectives.minimumRouteKm,
    budget: scenario.objectives.maximumPublicCost === null || spent <= scenario.objectives.maximumPublicCost,
    operatingProfit: !scenario.objectives.positiveOperatingProfit || integrated.profit > 0,
  };
  const weights = { deadline: 15, passengers: 30, stations: 15, routeLength: 15, budget: 15, operatingProfit: 10 };
  const score = Object.entries(checks).reduce((sum, [key, passed]) => sum + (passed ? weights[key] : 0), 0);
  const mandatory = checks.deadline && checks.passengers && checks.stations && checks.routeLength && checks.budget;
  scenario.score = score;
  scenario.status = mandatory ? "completed" : game.clock.minute > scenario.deadlineMinute ? "failed" : "active";
  return { status: scenario.status, score, checks, metrics: { dailyPassengers, stations: ownedStationIds.size, routeKm, spent, operatingProfit: integrated.profit } };
}

export function scenarioCatalog(countryId = "JP") {
  const catalog = [];
  for (const type of Object.keys(TYPES)) {
    for (const difficulty of Object.keys(DIFFICULTY)) {
      const networkMode = TYPES[type].requiresExistingNetwork ? "existing" : "scratch";
      catalog.push(createScenario({ id: `${countryId}:${type}:${difficulty}`, type, networkMode, fundingMode: "limited", difficulty, countryId }));
    }
  }
  return catalog;
}
