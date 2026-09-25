import { loadIntegratedGame, saveIntegratedGame } from "./integrated-save.mjs";
import { createMapEngineBridge } from "./map-engine-bridge.mjs";
import {
  ManagementGame,
  TECHNICAL_PROFILES,
  VEHICLE_MODELS,
  applyScenario,
  calculateFleetRequirement,
  createScenario,
  evaluateScenario,
  settleIntegratedServiceDay,
} from "./management/index.mjs";
import { stableId } from "./map/ids.mjs";

const VEHICLE_BY_PROFILE = Object.freeze({
  medium_steel: "medium_4car",
  small_steel: "small_4car",
  large_steel: "large_8car",
  agt: "agt_6car",
  monorail: "monorail_6car",
  linear_metro: "linear_6car",
});

function replaceState(target, source) {
  for (const key of Object.keys(target)) delete target[key];
  Object.assign(target, source);
}

function routeFacts(project) {
  return {
    routeKm: project.planGeometry.segments.reduce((sum, segment) => sum + segment.lengthMeters, 0) / 1000,
    stations: project.planGeometry.stationCandidates.length,
  };
}

export function stablePlanKey(packId, stationIds) {
  const forward = stationIds.join("|");
  const reverse = [...stationIds].reverse().join("|");
  return stableId("ui-plan", packId, forward < reverse ? forward : reverse);
}

export function planIdForKey(packId, key) {
  return stableId("plan", packId, "key", key);
}

export function planningDefaults(technicalProfileId, structure, platformType) {
  const profile = TECHNICAL_PROFILES[technicalProfileId];
  if (!profile) throw new Error(`Unknown technical profile ${technicalProfileId}`);
  const depthMeters = structure === "cut-cover" ? 10 : structure === "shield" ? 22 : structure === "deep" ? 40 : 0;
  return {
    structure,
    depthMeters,
    platformType,
    platformLengthM: profile.platformLengthPerCarM * profile.minCars,
  };
}

export class ScenarioRuntime {
  constructor({ pack, operationalState, countryId = "JP", networkMode = "scratch", fundingMode = "limited", difficulty = "normal", seed = 20260925 } = {}) {
    this.pack = pack;
    this.operationalState = operationalState;
    const type = networkMode === "existing" ? "congestion_relief" : "greenfield_growth";
    const scenario = createScenario({ id: `${countryId}:${type}:${difficulty}`, type, networkMode, fundingMode, difficulty, countryId });
    this.game = new ManagementGame({ countryId, seed, openingCash: scenario.startingCash });
    applyScenario(this.game, scenario, pack);
    this.bridge = createMapEngineBridge(this.game, operationalState);
  }

  report() {
    const assessments = {};
    for (const record of this.game.plans) assessments[record.planId] = structuredClone(record.assessment);
    return structuredClone({ plans: this.game.plans, projects: this.game.projects, assessments });
  }

  latestPlan(planId) {
    return this.game.plans.filter((record) => record.planId === planId).sort((a, b) => b.version - a.version)[0] ?? null;
  }

  projectForPlan(planId) {
    return this.game.projects.find((project) => project.planId === planId) ?? null;
  }

  submit(planGeometry, technicalProfileId) {
    return this.bridge.submitPlan(planGeometry, technicalProfileId);
  }

  approveAndCreate(planId) {
    const record = this.latestPlan(planId);
    if (!record) throw new Error("먼저 계획을 기술심사에 제출해야 합니다.");
    if (record.status === "assessed") this.bridge.approvePlan(record.id);
    if (this.game.requirePlan(record.id).status === "approved") return this.bridge.createProject(record.id);
    throw new Error(`계획 상태가 ${record.status}라 사업화할 수 없습니다.`);
  }

  contract(planId) {
    const project = this.projectForPlan(planId);
    if (!project) throw new Error("먼저 승인 계획을 사업화해야 합니다.");
    return this.bridge.contractProject(project.id);
  }

  prepareFleet(planId, { depotStrategy = "terminal", trainsPerHour = 4, manufacturerId = "maker-b" } = {}) {
    const project = this.projectForPlan(planId);
    if (!project) throw new Error("사업이 없습니다.");
    if (!project.technicalProfileId || !VEHICLE_BY_PROFILE[project.technicalProfileId]) throw new Error("지원 차량이 없는 기술 방식입니다.");
    const suffix = project.planId.replace(/[^a-zA-Z0-9_-]/g, "-");
    const depotId = `depot:${suffix}`;
    const orderId = `fleet:${suffix}`;
    if (this.game.depots.some((depot) => depot.id === depotId) || this.game.vehicleOrders.some((order) => order.id === orderId)) throw new Error("차량기지와 차량 발주가 이미 준비됐습니다.");
    const facts = routeFacts(project);
    const fleetRequirement = calculateFleetRequirement({ ...facts, commercialSpeedKph: 30, trainsPerHour });
    const quantity = fleetRequirement.minimumFleet;
    const depot = this.game.addDepot({ id: depotId, name: `${project.planGeometry.name ?? "신설선"} 차량기지`, locationStrategy: depotStrategy, capacitySets: quantity, inspectionSetsPerDay: Math.max(1, Math.ceil(quantity / 8)) });
    const order = this.game.orderVehicles({ id: orderId, modelId: VEHICLE_BY_PROFILE[project.technicalProfileId], quantity, manufacturerId });
    return { depot, order, fleetRequirement };
  }

  advanceMonths(months = 1) {
    if (!Number.isInteger(months) || months < 1) throw new Error("진행 개월은 양의 정수여야 합니다.");
    const results = [];
    for (let index = 0; index < months; index++) results.push(this.game.advanceMonth());
    return results;
  }

  suspend(planId, reason = "Player decision") {
    const project = this.projectForPlan(planId);
    if (!project) throw new Error("사업이 없습니다.");
    return this.bridge.suspendProject(project.id, reason);
  }

  resume(planId) {
    const project = this.projectForPlan(planId);
    if (!project) throw new Error("사업이 없습니다.");
    return this.bridge.resumeProject(project.id);
  }

  open(planId, { color, trainsPerHour = 4 } = {}) {
    const project = this.projectForPlan(planId);
    if (!project) throw new Error("사업이 없습니다.");
    if (project.status !== "available") throw new Error("시설 공사와 검사가 아직 끝나지 않았습니다.");
    const suffix = project.planId.replace(/[^a-zA-Z0-9_-]/g, "-");
    const depotId = `depot:${suffix}`;
    const orderId = `fleet:${suffix}`;
    const order = this.game.vehicleOrders.find((item) => item.id === orderId);
    if (order?.stage !== "accepted") throw new Error("영업용 차량 인수가 아직 끝나지 않았습니다.");
    const serviceId = `service:${suffix}`;
    if (this.game.services.some((service) => service.id === serviceId)) throw new Error("이미 개통한 서비스입니다.");
    const facts = routeFacts(project);
    const model = VEHICLE_MODELS[order.modelId];
    const profile = TECHNICAL_PROFILES[project.technicalProfileId];
    const knownLengths = project.planGeometry.stationCandidates.map((station) => station.platformLengthM).filter(Number.isFinite);
    const platformLengthM = knownLengths.length ? Math.min(...knownLengths) : model.cars * profile.platformLengthPerCarM;
    const service = this.game.createService({
      id: serviceId,
      name: project.planGeometry.name ?? project.planId,
      projectId: project.id,
      vehicleOrderId: orderId,
      depotId,
      modelId: order.modelId,
      ...facts,
      commercialSpeedKph: 30,
      trainsPerHour,
      staffReady: true,
      timetableReady: true,
      trialOperationPassed: true,
      approvalsValid: true,
      platformLengthM,
      passengerWeight: 100,
    });
    if (service.status !== "open") throw new Error(service.readiness.reasons.join("; "));
    const commissioned = this.bridge.commission({ projectId: project.id, serviceId, color, lineName: service.name });
    const lineId = String(commissioned.lineId);
    service.engineCursor = {
      day: Math.floor(this.operationalState.simMinutes / 1440),
      delivered: this.operationalState.stats.deliveredByLine[lineId] ?? 0,
      trainKm: this.operationalState.stats.trainKmByLine[lineId] ?? 0,
    };
    service.operationsStartedAtSimMinute = this.operationalState.simMinutes;
    service.operationsStartedAtGameMinute = this.game.clock.minute;
    return { service: structuredClone(service), commissioned };
  }

  settleOperatingDays() {
    const settlements = [];
    for (const service of this.game.services.filter((item) => item.status === "open" && item.operationalLineId !== undefined)) {
      const currentDay = Math.floor(this.operationalState.simMinutes / 1440);
      if (currentDay <= (service.engineCursor?.day ?? currentDay)) continue;
      const target = service.operationsStartedAtGameMinute + Math.max(0, this.operationalState.simMinutes - service.operationsStartedAtSimMinute);
      if (target > this.game.clock.minute) this.game.clock.advance(target - this.game.clock.minute);
      settlements.push(settleIntegratedServiceDay(this.game, this.operationalState, service.id));
    }
    return settlements;
  }

  evaluate() {
    return evaluateScenario(this.game, this.operationalState);
  }

  save() {
    return saveIntegratedGame({
      game: this.game,
      operationalState: this.operationalState,
      packId: this.pack.manifest.id,
      packVersion: this.pack.manifest.version,
    });
  }

  load(text) {
    const restored = loadIntegratedGame(text, { id: this.pack.manifest.id, version: this.pack.manifest.version });
    this.game = restored.game;
    replaceState(this.operationalState, restored.operationalState);
    this.bridge = createMapEngineBridge(this.game, this.operationalState);
    return this;
  }
}
