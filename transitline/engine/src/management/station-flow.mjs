import { STATION_PLAN_SCHEMA } from "./station-planning.mjs";

export const STATION_ACCESS_SCHEMA = "transitline.station-access-plan/1";

export const FLOW_ASSUMPTIONS = Object.freeze({
  walkingMetersPerMinute: 75,
  entrancePerWidthMeterPerMinute: 40,
  stairPerWidthMeterPerMinute: 35,
  corridorPerWidthMeterPerMinute: 50,
  escalatorPerUnitPerMinute: 75,
  elevatorPerUnitPerMinute: 15,
  faregatePerLanePerMinute: 35,
  comfortablePlatformDensity: 1.5,
  crowdedPlatformDensity: 2.5,
  maximumPlatformDensity: 4,
  evacuationTargetMinutes: 6,
  boardPerDoorPerSecond: 0.65,
  alightPerDoorPerSecond: 0.9,
});

const round = (value, digits = 3) => Number(value.toFixed(digits));
const sum = (values) => values.reduce((total, value) => total + value, 0);

function assertStationPlan(stationPlan) {
  if (!stationPlan || stationPlan.schema !== STATION_PLAN_SCHEMA || stationPlan.contractVersion !== 1) throw new Error("StationPlan v1 is required");
}

function positive(value, label, allowZero = false) {
  if (!Number.isFinite(value) || (allowZero ? value < 0 : value <= 0)) throw new Error(`${label} must be ${allowZero ? "non-negative" : "positive"}`);
  return value;
}

function circulationCapacity(item, direction) {
  if (item.open === false) return 0;
  if (item.direction && !["both", direction].includes(item.direction)) return 0;
  if (item.type === "stair") return positive(item.widthMeters, "Stair width") * FLOW_ASSUMPTIONS.stairPerWidthMeterPerMinute;
  if (item.type === "corridor") return positive(item.widthMeters, "Corridor width") * FLOW_ASSUMPTIONS.corridorPerWidthMeterPerMinute;
  if (item.type === "escalator") return positive(item.units ?? 1, "Escalator units") * FLOW_ASSUMPTIONS.escalatorPerUnitPerMinute;
  if (item.type === "elevator") return positive(item.units ?? 1, "Elevator units") * FLOW_ASSUMPTIONS.elevatorPerUnitPerMinute;
  throw new Error(`Unknown circulation type ${item.type}`);
}

function gateCapacity(gate, direction) {
  if (gate.open === false) return 0;
  const lanes = positive(gate.lanes, "Faregate lanes");
  if (gate.direction === direction) return lanes * FLOW_ASSUMPTIONS.faregatePerLanePerMinute;
  if (gate.direction === "both" || gate.direction === undefined) return lanes * FLOW_ASSUMPTIONS.faregatePerLanePerMinute * 0.5;
  return 0;
}

function queueMetrics(demandPerMinute, capacityPerMinute) {
  const demand = Math.max(0, demandPerMinute);
  const capacity = Math.max(0, capacityPerMinute);
  if (capacity === 0) return { demandPerMinute: demand, capacityPerMinute: 0, utilization: null, queueDelayMinutes: null, backlogPerMinute: demand, servedPerMinute: 0 };
  const utilization = demand / capacity;
  let queueDelayMinutes;
  if (utilization <= 0.7) queueDelayMinutes = utilization * 0.08;
  else if (utilization < 1) queueDelayMinutes = 0.1 + 0.35 * utilization ** 2 / (1 - utilization);
  else queueDelayMinutes = 10 + (utilization - 1) * 30;
  return {
    demandPerMinute: round(demand),
    capacityPerMinute: round(capacity),
    utilization: round(utilization),
    queueDelayMinutes: round(queueDelayMinutes),
    backlogPerMinute: round(Math.max(0, demand - capacity)),
    servedPerMinute: round(Math.min(demand, capacity)),
  };
}

function makeDefaultCirculation(stationPlan) {
  return stationPlan.platforms.flatMap((platform) => [
    { id: `${platform.id}:stair:1`, platformId: platform.id, type: "stair", widthMeters: 2, direction: "both", open: true },
    { id: `${platform.id}:stair:2`, platformId: platform.id, type: "stair", widthMeters: 2, direction: "both", open: true },
    { id: `${platform.id}:escalator:up`, platformId: platform.id, type: "escalator", units: 1, direction: "out", open: true },
    { id: `${platform.id}:escalator:down`, platformId: platform.id, type: "escalator", units: 1, direction: "in", open: true },
    { id: `${platform.id}:elevator`, platformId: platform.id, type: "elevator", units: 1, direction: "both", accessible: true, open: true },
  ]);
}

export function createStationAccessPlan(stationPlan, input = {}) {
  assertStationPlan(stationPlan);
  const entrances = structuredClone(input.entrances ?? [
    { id: `${stationPlan.id}:entrance:1`, widthMeters: 3, walkDistanceMeters: 120, accessible: true, demandShare: 0.6, open: true },
    { id: `${stationPlan.id}:entrance:2`, widthMeters: 2.5, walkDistanceMeters: 220, accessible: false, demandShare: 0.4, open: true },
  ]);
  const circulation = structuredClone(input.circulation ?? makeDefaultCirculation(stationPlan));
  const gates = structuredClone(input.gates ?? [{ id: `${stationPlan.id}:gates:main`, lanes: 8, direction: "both", open: true }]);
  const transferLinks = structuredClone(input.transferLinks ?? []);
  const platformIds = new Set(stationPlan.platforms.map((platform) => platform.id));

  if (!entrances.length) throw new Error("At least one station entrance is required");
  for (const entrance of entrances) {
    if (!entrance.id) throw new Error("Entrance id is required");
    positive(entrance.widthMeters, "Entrance width");
    positive(entrance.walkDistanceMeters ?? 0, "Entrance walk distance", true);
    positive(entrance.demandShare ?? 0, "Entrance demand share", true);
  }
  for (const item of circulation) {
    if (!item.id || !platformIds.has(item.platformId)) throw new Error("Circulation must reference a platform in the station plan");
    if (!new Set(["stair", "corridor", "escalator", "elevator"]).has(item.type)) throw new Error(`Unknown circulation type ${item.type}`);
    if (item.direction && !new Set(["both", "in", "out"]).has(item.direction)) throw new Error(`Unknown circulation direction ${item.direction}`);
    circulationCapacity(item, "in");
    circulationCapacity(item, "out");
  }
  for (const gate of gates) gateCapacity(gate, "in");
  for (const link of transferLinks) {
    const localDestination = link.toPlatformId && platformIds.has(link.toPlatformId);
    if (!link.id || !platformIds.has(link.fromPlatformId) || (!localDestination && !link.targetStationId)) throw new Error("Transfer link must reference a local origin platform and a local platform or external target station");
    positive(link.distanceMeters, "Transfer distance", true);
    positive(link.widthMeters, "Transfer width");
    positive(link.levelChanges ?? 0, "Transfer level changes", true);
  }

  return {
    schema: STATION_ACCESS_SCHEMA,
    contractVersion: 1,
    stationPlanId: stationPlan.id,
    entrances,
    circulation,
    gates,
    transferLinks,
    evacuationTargetMinutes: input.evacuationTargetMinutes ?? FLOW_ASSUMPTIONS.evacuationTargetMinutes,
    accessibilityRequired: input.accessibilityRequired ?? true,
  };
}

function entranceSummary(accessPlan, direction) {
  const open = accessPlan.entrances.filter((entrance) => entrance.open !== false);
  const capacityPerMinute = sum(open.map((entrance) => entrance.widthMeters * FLOW_ASSUMPTIONS.entrancePerWidthMeterPerMinute));
  const statedShare = sum(open.map((entrance) => entrance.demandShare ?? 0));
  const weightedWalkMinutes = open.length
    ? sum(open.map((entrance) => {
      const share = statedShare > 0 ? (entrance.demandShare ?? 0) / statedShare : 1 / open.length;
      return share * (entrance.walkDistanceMeters ?? 0) / FLOW_ASSUMPTIONS.walkingMetersPerMinute;
    }))
    : null;
  return {
    direction,
    openCount: open.length,
    capacityPerMinute,
    weightedWalkMinutes: weightedWalkMinutes === null ? null : round(weightedWalkMinutes),
    accessibleOpen: open.some((entrance) => entrance.accessible),
  };
}

function circulationSummary(accessPlan, direction) {
  const byPlatform = new Map();
  for (const item of accessPlan.circulation) {
    const capacity = circulationCapacity(item, direction);
    byPlatform.set(item.platformId, (byPlatform.get(item.platformId) ?? 0) + capacity);
  }
  return { byPlatform, total: sum([...byPlatform.values()]) };
}

function transferSummary(accessPlan, demandPerMinute) {
  const open = accessPlan.transferLinks.filter((link) => link.open !== false);
  const capacityPerMinute = sum(open.map((link) => link.widthMeters * FLOW_ASSUMPTIONS.corridorPerWidthMeterPerMinute));
  const details = open.map((link) => {
    const walkMinutes = link.distanceMeters / FLOW_ASSUMPTIONS.walkingMetersPerMinute;
    const verticalMinutes = (link.levelChanges ?? 0) * 0.75;
    const gateMinutes = link.gateCrossing ? 1 : 0;
    const transferMinutes = walkMinutes + verticalMinutes + gateMinutes;
    return {
      id: link.id,
      transferMinutes: round(transferMinutes),
      generalizedPenaltyMinutes: round(transferMinutes + Math.max(0, transferMinutes - 3) * 0.35),
      capacityPerMinute: round(link.widthMeters * FLOW_ASSUMPTIONS.corridorPerWidthMeterPerMinute),
    };
  });
  return { ...queueMetrics(demandPerMinute, capacityPerMinute), links: details };
}

export function assessStationFlow({ stationPlan, accessPlan, demand = {} } = {}) {
  assertStationPlan(stationPlan);
  if (!accessPlan || accessPlan.schema !== STATION_ACCESS_SCHEMA || accessPlan.contractVersion !== 1 || accessPlan.stationPlanId !== stationPlan.id) throw new Error("Matching StationAccessPlan v1 is required");
  const entriesPerHour = positive(demand.entriesPerHour ?? 0, "Entries", true);
  const exitsPerHour = positive(demand.exitsPerHour ?? 0, "Exits", true);
  const transfersPerHour = positive(demand.transfersPerHour ?? 0, "Transfers", true);
  const peakFactor = positive(demand.peakFactor ?? 1.25, "Peak factor");
  const headwayMinutes = positive(demand.headwayMinutes ?? 5, "Headway");
  const directions = positive(demand.serviceDirections ?? 2, "Service directions");
  const entryRate = entriesPerHour / 60 * peakFactor;
  const exitRate = exitsPerHour / 60 * peakFactor;
  const transferRate = transfersPerHour / 60 * peakFactor;

  const entranceIn = entranceSummary(accessPlan, "in");
  const entranceOut = entranceSummary(accessPlan, "out");
  const circulationIn = circulationSummary(accessPlan, "in");
  const circulationOut = circulationSummary(accessPlan, "out");
  const gatesIn = sum(accessPlan.gates.map((gate) => gateCapacity(gate, "in")));
  const gatesOut = sum(accessPlan.gates.map((gate) => gateCapacity(gate, "out")));
  const entryCapacity = Math.min(entranceIn.capacityPerMinute, gatesIn, circulationIn.total);
  const exitCapacity = Math.min(entranceOut.capacityPerMinute, gatesOut, circulationOut.total);
  const entryFlow = queueMetrics(entryRate, entryCapacity);
  const exitFlow = queueMetrics(exitRate, exitCapacity);
  const transferFlow = transferSummary(accessPlan, transferRate);

  const platformArea = sum(stationPlan.platforms.map((platform) => platform.effectiveAreaSquareMeters));
  const waitingPassengers = (entryFlow.servedPerMinute + transferFlow.servedPerMinute) * headwayMinutes / directions;
  const alightingPulse = exitFlow.servedPerMinute * headwayMinutes / directions;
  const platformOccupancy = waitingPassengers + alightingPulse;
  const platformDensity = platformArea > 0 ? platformOccupancy / platformArea : null;
  const densityStatus = platformDensity === null || platformDensity > FLOW_ASSUMPTIONS.maximumPlatformDensity
    ? "unsafe"
    : platformDensity > FLOW_ASSUMPTIONS.crowdedPlatformDensity
      ? "crowded"
      : platformDensity > FLOW_ASSUMPTIONS.comfortablePlatformDensity ? "busy" : "comfortable";

  const availableDoors = stationPlan.currentCars * stationPlan.interface.doorsPerSidePerCar;
  const boardingPerTrain = entryFlow.servedPerMinute * headwayMinutes / directions;
  const alightingPerTrain = exitFlow.servedPerMinute * headwayMinutes / directions;
  const boardSeconds = boardingPerTrain / (availableDoors * FLOW_ASSUMPTIONS.boardPerDoorPerSecond);
  const alightSeconds = alightingPerTrain / (availableDoors * FLOW_ASSUMPTIONS.alightPerDoorPerSecond);
  const mixedSeconds = (boardingPerTrain + alightingPerTrain) / (availableDoors * 1.1);
  const concentrationFactor = accessPlan.circulation.length / stationPlan.platforms.length < 3 ? 1.25 : 1;
  const crowdingSeconds = platformDensity === null ? 20 : Math.max(0, platformDensity - FLOW_ASSUMPTIONS.comfortablePlatformDensity) * 4;
  const fixedDwellSeconds = stationPlan.screenDoor.id === "none" ? 20 : 23;
  const recommendedDwellSeconds = Math.ceil(fixedDwellSeconds + Math.max(boardSeconds, alightSeconds, mixedSeconds) * concentrationFactor + crowdingSeconds);

  const emergencyCapacity = Math.min(entranceOut.capacityPerMinute, circulationOut.total * 0.8);
  const evacuationMinutes = emergencyCapacity > 0 ? platformOccupancy / emergencyCapacity : null;
  const accessibleVertical = accessPlan.circulation.some((item) => item.open !== false && item.accessible && item.type === "elevator");
  const accessibleRouteAvailable = entranceIn.accessibleOpen && accessibleVertical;
  const violations = [];
  const warnings = [];
  if (!entranceIn.openCount) violations.push({ code: "no-open-entrance", message: "사용 가능한 출입구가 없습니다." });
  if (accessPlan.accessibilityRequired && !accessibleRouteAvailable) violations.push({ code: "accessible-route-missing", message: "출입구에서 승강장까지 이어지는 무장애 경로가 없습니다." });
  if (entryFlow.backlogPerMinute > 0) violations.push({ code: "entry-capacity-exceeded", message: "첨두 유입이 출입구·개찰·승강장 동선 용량을 넘습니다." });
  if (exitFlow.backlogPerMinute > 0) violations.push({ code: "exit-capacity-exceeded", message: "첨두 유출이 승강장·개찰·출입구 동선 용량을 넘습니다." });
  if (transfersPerHour > 0 && !accessPlan.transferLinks.some((link) => link.open !== false)) violations.push({ code: "transfer-path-missing", message: "환승 수요가 있지만 열린 환승통로가 없습니다." });
  if (transferFlow.backlogPerMinute > 0) violations.push({ code: "transfer-capacity-exceeded", message: "환승통로 용량이 환승 수요보다 작습니다." });
  if (densityStatus === "unsafe") violations.push({ code: "unsafe-platform-density", message: "승강장 예상 밀도가 안전 한계를 넘습니다." });
  else if (densityStatus === "crowded") warnings.push({ code: "crowded-platform", message: "승강장이 혼잡해 정차시간과 지연 위험이 증가합니다." });
  if (evacuationMinutes === null || evacuationMinutes > accessPlan.evacuationTargetMinutes) violations.push({ code: "evacuation-target-failed", message: "비상시 목표시간 안에 승강장을 대피시키기 어렵습니다." });
  if (recommendedDwellSeconds > (demand.scheduledDwellSeconds ?? 45)) warnings.push({ code: "scheduled-dwell-too-short", message: "예정 정차시간이 승하차 처리시간보다 짧습니다." });

  const bottlenecks = [
    { id: "entrances-in", utilization: entranceIn.capacityPerMinute ? entryRate / entranceIn.capacityPerMinute : Infinity },
    { id: "gates-in", utilization: gatesIn ? entryRate / gatesIn : Infinity },
    { id: "vertical-in", utilization: circulationIn.total ? entryRate / circulationIn.total : Infinity },
    { id: "vertical-out", utilization: circulationOut.total ? exitRate / circulationOut.total : Infinity },
    { id: "gates-out", utilization: gatesOut ? exitRate / gatesOut : Infinity },
    { id: "entrances-out", utilization: entranceOut.capacityPerMinute ? exitRate / entranceOut.capacityPerMinute : Infinity },
  ].sort((a, b) => b.utilization - a.utilization).map((item) => ({ id: item.id, utilization: Number.isFinite(item.utilization) ? round(item.utilization) : null }));

  return {
    stationPlanId: stationPlan.id,
    status: violations.length ? "inadequate" : warnings.length ? "constrained" : "adequate",
    demand: { entriesPerHour, exitsPerHour, transfersPerHour, peakFactor, headwayMinutes, serviceDirections: directions },
    access: { inbound: entranceIn, outbound: entranceOut, accessibleRouteAvailable },
    flows: { entry: entryFlow, exit: exitFlow, transfer: transferFlow },
    platform: { effectiveAreaSquareMeters: round(platformArea, 1), waitingPassengers: round(waitingPassengers, 1), alightingPulse: round(alightingPulse, 1), occupancy: round(platformOccupancy, 1), densityPersonsPerSquareMeter: platformDensity === null ? null : round(platformDensity), densityStatus },
    dwell: { availableDoors, boardingPerTrain: round(boardingPerTrain, 1), alightingPerTrain: round(alightingPerTrain, 1), recommendedDwellSeconds, scheduledDwellSeconds: demand.scheduledDwellSeconds ?? 45, delayRisk: recommendedDwellSeconds > (demand.scheduledDwellSeconds ?? 45) },
    emergency: { capacityPerMinute: round(emergencyCapacity), evacuationMinutes: evacuationMinutes === null ? null : round(evacuationMinutes), targetMinutes: accessPlan.evacuationTargetMinutes, passes: evacuationMinutes !== null && evacuationMinutes <= accessPlan.evacuationTargetMinutes },
    bottlenecks,
    violations,
    warnings,
  };
}

