import { TECHNICAL_PROFILES } from "./construction.mjs";
import { VEHICLE_MODELS } from "./rolling-stock.mjs";

export const STATION_PLAN_SCHEMA = "transitline.station-plan/1";

export const STATION_STRUCTURES = Object.freeze({
  surface: { id: "surface", maximumTrackCount: 4 },
  elevated: { id: "elevated", maximumTrackCount: 4 },
  "cut-cover": { id: "cut-cover", maximumTrackCount: 4 },
  shield: { id: "shield", maximumTrackCount: 2 },
  deep: { id: "deep", maximumTrackCount: 2 },
});

export const PLATFORM_SCREEN_DOORS = Object.freeze({
  none: { id: "none", maximumStoppingErrorMm: null, requiresDoorPattern: false },
  "half-height": { id: "half-height", maximumStoppingErrorMm: 600, requiresDoorPattern: true },
  "full-height": { id: "full-height", maximumStoppingErrorMm: 350, requiresDoorPattern: true },
  "wide-opening": { id: "wide-opening", maximumStoppingErrorMm: 700, requiresDoorPattern: false },
});

export const VEHICLE_INTERFACE_PROFILES = Object.freeze({
  medium_steel: { platformHeightMm: 1_100, nominalGapMm: 50, doorsPerSidePerCar: 4, doorWidthMm: 1_300, doorFractions: [0.14, 0.38, 0.62, 0.86], guidewayInterface: "steel-wheel-standard" },
  small_steel: { platformHeightMm: 1_000, nominalGapMm: 50, doorsPerSidePerCar: 3, doorWidthMm: 1_300, doorFractions: [0.18, 0.5, 0.82], guidewayInterface: "steel-wheel-compact" },
  large_steel: { platformHeightMm: 1_100, nominalGapMm: 50, doorsPerSidePerCar: 4, doorWidthMm: 1_300, doorFractions: [0.14, 0.38, 0.62, 0.86], guidewayInterface: "steel-wheel-large" },
  agt: { platformHeightMm: 1_100, nominalGapMm: 45, doorsPerSidePerCar: 2, doorWidthMm: 1_400, doorFractions: [0.25, 0.75], guidewayInterface: "rubber-tyred-agt" },
  monorail: { platformHeightMm: 1_100, nominalGapMm: 55, doorsPerSidePerCar: 3, doorWidthMm: 1_300, doorFractions: [0.2, 0.5, 0.8], guidewayInterface: "straddle-beam-monorail" },
  linear_metro: { platformHeightMm: 1_000, nominalGapMm: 50, doorsPerSidePerCar: 3, doorWidthMm: 1_300, doorFractions: [0.18, 0.5, 0.82], guidewayInterface: "steel-wheel-linear-motor" },
});

const SIDE_PLATFORM_WIDTH = Object.freeze({
  medium_steel: 4,
  small_steel: 3.5,
  large_steel: 4.5,
  agt: 3.2,
  monorail: 3.5,
  linear_metro: 3.5,
});

export const STATION_LAYOUTS = Object.freeze({
  "side-2track": {
    id: "side-2track",
    trackRoles: ["service", "service"],
    platforms: [
      { kind: "side", edgeTracks: [0] },
      { kind: "side", edgeTracks: [1] },
    ],
    supportsOvertaking: false,
    builtInTurnback: false,
  },
  "island-2track": {
    id: "island-2track",
    trackRoles: ["service", "service"],
    platforms: [{ kind: "island", edgeTracks: [0, 1] }],
    supportsOvertaking: false,
    builtInTurnback: false,
  },
  "single-side": {
    id: "single-side",
    trackRoles: ["service"],
    platforms: [{ kind: "side", edgeTracks: [0] }],
    supportsOvertaking: false,
    builtInTurnback: false,
  },
  "single-bilateral": {
    id: "single-bilateral",
    trackRoles: ["service"],
    platforms: [
      { kind: "side", edgeTracks: [0] },
      { kind: "side", edgeTracks: [0] },
    ],
    supportsOvertaking: false,
    builtInTurnback: false,
    simultaneousBothSides: true,
  },
  "two-platform-3-track": {
    id: "two-platform-3-track",
    trackRoles: ["service", "turnback-or-passing", "service"],
    platforms: [
      { kind: "side", edgeTracks: [0] },
      { kind: "island", edgeTracks: [1, 2] },
    ],
    supportsOvertaking: true,
    builtInTurnback: true,
  },
  "two-platform-4-track": {
    id: "two-platform-4-track",
    trackRoles: ["service", "passing", "passing", "service"],
    platforms: [
      { kind: "side", edgeTracks: [0] },
      { kind: "side", edgeTracks: [3] },
    ],
    supportsOvertaking: true,
    builtInTurnback: false,
  },
  "double-island-4-track": {
    id: "double-island-4-track",
    trackRoles: ["service", "service", "service", "service"],
    platforms: [
      { kind: "island", edgeTracks: [0, 1] },
      { kind: "island", edgeTracks: [2, 3] },
    ],
    supportsOvertaking: true,
    builtInTurnback: false,
    supportsCrossPlatformTransfer: true,
  },
  "terminal-bay": {
    id: "terminal-bay",
    trackRoles: ["terminal", "terminal"],
    platforms: [{ kind: "island", edgeTracks: [0, 1] }],
    supportsOvertaking: false,
    builtInTurnback: true,
    bufferStops: 2,
  },
});

const round = (value, digits = 3) => Number(value.toFixed(digits));

function requireEntry(catalog, id, label) {
  const entry = catalog[id];
  if (!entry) throw new Error(`Unknown ${label} ${id}`);
  return entry;
}

function pushIssue(collection, code, message, details = {}) {
  collection.push({ code, message, ...details });
}

function doorCenters(profile, cars, carLengthMeters) {
  const centers = [];
  for (let car = 0; car < cars; car++) {
    for (const fraction of profile.doorFractions) centers.push(round(car * carLengthMeters + fraction * carLengthMeters));
  }
  return centers;
}

function curveGapAdditionMm(carLengthMeters, alignment, curveRadiusMeters) {
  if (alignment !== "curved") return 0;
  if (!Number.isFinite(curveRadiusMeters) || curveRadiusMeters <= 0) return null;
  return round(Math.min(120, carLengthMeters ** 2 / (8 * curveRadiusMeters) * 1_000 * 0.35), 1);
}

function defaultStoppingAccuracy(operationMode) {
  return operationMode === "goa4" ? 200 : operationMode === "ato" ? 350 : 1_000;
}

function minimumPlatformWidth(profileId, kind) {
  const side = SIDE_PLATFORM_WIDTH[profileId];
  return kind === "island" ? round(side * 1.9, 1) : side;
}

function widthForPlatform(input, platformIndex, minimumWidth) {
  if (Array.isArray(input.platformWidthsMeters)) return input.platformWidthsMeters[platformIndex] ?? minimumWidth;
  if (Number.isFinite(input.platformWidthMeters)) return input.platformWidthMeters;
  return minimumWidth;
}

export function createStationPlan(input = {}) {
  if (!input.id) throw new Error("Station plan id is required");
  const technicalProfile = requireEntry(TECHNICAL_PROFILES, input.technicalProfileId, "technical profile");
  const vehicleModel = requireEntry(VEHICLE_MODELS, input.vehicleModelId, "vehicle model");
  const structure = requireEntry(STATION_STRUCTURES, input.structureId ?? "surface", "station structure");
  const layout = requireEntry(STATION_LAYOUTS, input.layoutId ?? "side-2track", "station layout");
  const screenDoor = requireEntry(PLATFORM_SCREEN_DOORS, input.screenDoorType ?? "none", "platform screen door type");
  if (vehicleModel.profileId !== technicalProfile.id) throw new Error("The design vehicle does not match the station running system");

  const currentCars = input.currentCars ?? vehicleModel.cars;
  const futureCars = input.futureCars ?? currentCars;
  if (!Number.isInteger(currentCars) || currentCars < technicalProfile.minCars || currentCars > technicalProfile.maxCars) throw new Error("Current formation is outside the technical profile range");
  if (!Number.isInteger(futureCars) || futureCars < currentCars || futureCars > technicalProfile.maxCars) throw new Error("Future formation must be between the current formation and profile maximum");

  const operationMode = input.operationMode ?? "manual";
  if (!new Set(["manual", "ato", "goa4"]).has(operationMode)) throw new Error(`Unknown operation mode ${operationMode}`);
  const alignment = input.alignment ?? "straight";
  if (!new Set(["straight", "curved"]).has(alignment)) throw new Error(`Unknown platform alignment ${alignment}`);
  const stoppingAccuracyMm = input.stoppingAccuracyMm ?? defaultStoppingAccuracy(operationMode);
  if (!(stoppingAccuracyMm >= 0)) throw new Error("Stopping accuracy must be non-negative");

  const currentRequiredLengthMeters = round(currentCars * technicalProfile.platformLengthPerCarM, 1);
  const futureRequiredLengthMeters = round(futureCars * technicalProfile.platformLengthPerCarM, 1);
  const finishedPlatformLengthMeters = input.finishedPlatformLengthMeters ?? currentRequiredLengthMeters;
  const structuralPlatformLengthMeters = input.structuralPlatformLengthMeters ?? Math.max(finishedPlatformLengthMeters, futureRequiredLengthMeters);
  if (!(finishedPlatformLengthMeters > 0) || !(structuralPlatformLengthMeters > 0)) throw new Error("Platform lengths must be positive");

  const vehicleInterface = requireEntry(VEHICLE_INTERFACE_PROFILES, technicalProfile.id, "vehicle interface profile");
  const curveAdditionMm = curveGapAdditionMm(technicalProfile.carLengthM, alignment, input.curveRadiusMeters);
  const horizontalGapMm = curveAdditionMm === null ? null : round(vehicleInterface.nominalGapMm + curveAdditionMm, 1);
  const platformHeightMm = input.platformHeightMm ?? vehicleInterface.platformHeightMm;
  const doorProfileId = `${vehicleModel.id}:${currentCars}car:${vehicleInterface.doorsPerSidePerCar}door`;
  const screenDoorProfileId = input.screenDoorProfileId ?? doorProfileId;

  let edgeSequence = 0;
  const platforms = layout.platforms.map((template, platformIndex) => {
    const minimumWidthMeters = minimumPlatformWidth(technicalProfile.id, template.kind);
    const widthMeters = widthForPlatform(input, platformIndex, minimumWidthMeters);
    const platformId = `${input.id}:platform:${platformIndex + 1}`;
    const edges = template.edgeTracks.map((trackIndex) => {
      edgeSequence++;
      return {
        id: `${input.id}:edge:${edgeSequence}`,
        platformId,
        trackId: `${input.id}:track:${trackIndex + 1}`,
        usableLengthMeters: finishedPlatformLengthMeters,
        doorSide: edgeSequence % 2 === 1 ? "left" : "right",
        screenDoorType: screenDoor.id,
        screenDoorProfileId: screenDoor.id === "none" ? null : screenDoorProfileId,
        screenDoorInstalledLengthMeters: screenDoor.id === "none" ? 0 : finishedPlatformLengthMeters,
      };
    });
    const grossAreaSquareMeters = round(structuralPlatformLengthMeters * widthMeters, 1);
    const safetyAreaSquareMeters = round(finishedPlatformLengthMeters * edges.length * 1.25, 1);
    const blockedAreaSquareMeters = round(grossAreaSquareMeters * 0.15, 1);
    return {
      id: platformId,
      kind: template.kind,
      widthMeters,
      minimumWidthMeters,
      finishedLengthMeters: finishedPlatformLengthMeters,
      structuralLengthMeters: structuralPlatformLengthMeters,
      grossAreaSquareMeters,
      blockedAreaSquareMeters,
      safetyAreaSquareMeters,
      effectiveAreaSquareMeters: round(Math.max(0, grossAreaSquareMeters - blockedAreaSquareMeters - safetyAreaSquareMeters), 1),
      edges,
    };
  });

  const edgeTrackIds = new Set(platforms.flatMap((platform) => platform.edges.map((edge) => edge.trackId)));
  const tracks = layout.trackRoles.map((role, index) => ({
    id: `${input.id}:track:${index + 1}`,
    role,
    hasPlatformEdge: edgeTrackIds.has(`${input.id}:track:${index + 1}`),
  }));
  const turnbackFacility = input.turnbackFacility ?? (layout.builtInTurnback ? "layout" : "none");
  if (!new Set(["none", "layout", "crossover", "pocket", "reverse-siding"]).has(turnbackFacility)) throw new Error(`Unknown turnback facility ${turnbackFacility}`);

  return {
    schema: STATION_PLAN_SCHEMA,
    contractVersion: 1,
    id: input.id,
    name: input.name ?? input.id,
    stationRole: input.stationRole ?? "intermediate",
    technicalProfileId: technicalProfile.id,
    designVehicleModelId: vehicleModel.id,
    structureId: structure.id,
    layoutId: layout.id,
    currentCars,
    futureCars,
    currentRequiredLengthMeters,
    futureRequiredLengthMeters,
    finishedPlatformLengthMeters,
    structuralPlatformLengthMeters,
    alignment,
    curveRadiusMeters: alignment === "curved" ? input.curveRadiusMeters ?? null : null,
    operationMode,
    positioningSystem: input.positioningSystem ?? operationMode !== "manual",
    stoppingAccuracyMm,
    doorInterlock: input.doorInterlock ?? screenDoor.id !== "none",
    platformMonitoring: input.platformMonitoring ?? operationMode === "goa4",
    emergencyResponsePlan: input.emergencyResponsePlan ?? operationMode === "goa4",
    platformHeightMm,
    interface: {
      guidewayInterface: vehicleInterface.guidewayInterface,
      nominalGapMm: vehicleInterface.nominalGapMm,
      curveGapAdditionMm: curveAdditionMm,
      horizontalGapMm,
      vehicleFloorHeightMm: vehicleInterface.platformHeightMm,
      verticalStepMm: Math.abs(vehicleInterface.platformHeightMm - platformHeightMm),
      doorProfileId,
      doorsPerSidePerCar: vehicleInterface.doorsPerSidePerCar,
      doorWidthMm: vehicleInterface.doorWidthMm,
      doorCentersMeters: doorCenters(vehicleInterface, currentCars, technicalProfile.carLengthM),
    },
    screenDoor: { ...screenDoor, profileId: screenDoor.id === "none" ? null : screenDoorProfileId },
    tracks,
    platforms,
    turnback: {
      facility: turnbackFacility,
      available: turnbackFacility !== "none",
      minimumReversalSeconds: input.minimumReversalSeconds ?? (layout.id === "terminal-bay" ? 150 : 210),
    },
    capabilities: {
      supportsOvertaking: layout.supportsOvertaking,
      supportsCrossPlatformTransfer: layout.supportsCrossPlatformTransfer ?? false,
      simultaneousBothSides: layout.simultaneousBothSides ?? false,
    },
    state: input.state ?? "planned",
  };
}

export function assessVehiclePlatformCompatibility(stationPlan, vehicleModelId = stationPlan?.designVehicleModelId) {
  if (!stationPlan || stationPlan.schema !== STATION_PLAN_SCHEMA || stationPlan.contractVersion !== 1) throw new Error("StationPlan v1 is required");
  const model = VEHICLE_MODELS[vehicleModelId];
  const stationProfile = TECHNICAL_PROFILES[stationPlan.technicalProfileId];
  const vehicleProfile = model ? TECHNICAL_PROFILES[model.profileId] : null;
  const vehicleInterface = vehicleProfile ? VEHICLE_INTERFACE_PROFILES[vehicleProfile.id] : null;
  const violations = [];
  const conditions = [];

  if (!model || !stationProfile || !vehicleProfile || !vehicleInterface) {
    pushIssue(violations, "unknown-vehicle-or-profile", "차량 또는 기술 프로필을 찾을 수 없습니다.");
    return { status: "incompatible", compatible: false, violations, conditions };
  }
  if (model.profileId !== stationPlan.technicalProfileId) pushIssue(violations, "running-system-mismatch", "차량 주행 시스템과 역 시설 인터페이스가 다릅니다.");

  const requiredLengthMeters = round(model.cars * vehicleProfile.platformLengthPerCarM, 1);
  const shortestEdge = Math.min(...stationPlan.platforms.flatMap((platform) => platform.edges.map((edge) => edge.usableLengthMeters)));
  if (shortestEdge < requiredLengthMeters) pushIssue(violations, "platform-too-short", "현재 마감된 승강장 길이가 편성보다 짧습니다.", { requiredLengthMeters, availableLengthMeters: shortestEdge });
  if (stationPlan.structuralPlatformLengthMeters >= requiredLengthMeters && shortestEdge < requiredLengthMeters) {
    pushIssue(conditions, "future-structure-not-finished", "구조 길이는 충분하지만 영업용 승강장 마감이 필요합니다.");
  }

  const verticalStepMm = Math.abs(vehicleInterface.platformHeightMm - stationPlan.platformHeightMm);
  const curveAdditionMm = curveGapAdditionMm(vehicleProfile.carLengthM, stationPlan.alignment, stationPlan.curveRadiusMeters);
  if (curveAdditionMm === null) pushIssue(conditions, "curve-radius-unknown", "곡선 승강장의 반경 자료가 없어 단차·간격을 확정할 수 없습니다.");
  const horizontalGapMm = curveAdditionMm === null ? null : vehicleInterface.nominalGapMm + curveAdditionMm;
  if (verticalStepMm > 250 || (horizontalGapMm !== null && horizontalGapMm > 180)) pushIssue(violations, "unsafe-platform-interface", "차량과 승강장의 단차 또는 수평 간격이 지원 범위를 넘습니다.", { verticalStepMm, horizontalGapMm });
  else if (verticalStepMm > 75 || (horizontalGapMm !== null && horizontalGapMm > 100)) pushIssue(conditions, "boarding-aid-required", "가동발판 또는 승하차 보조설비가 필요합니다.", { verticalStepMm, horizontalGapMm });

  const screenDoor = PLATFORM_SCREEN_DOORS[stationPlan.screenDoor.id];
  const doorProfileId = `${model.id}:${model.cars}car:${vehicleInterface.doorsPerSidePerCar}door`;
  if (screenDoor.requiresDoorPattern && stationPlan.screenDoor.profileId !== doorProfileId) pushIssue(violations, "screen-door-pattern-mismatch", "차량 문 위치와 홈도어 개구부가 맞지 않습니다.");
  if (screenDoor.maximumStoppingErrorMm !== null && stationPlan.stoppingAccuracyMm > screenDoor.maximumStoppingErrorMm) pushIssue(violations, "stopping-accuracy-insufficient", "정위치 정차 오차가 홈도어 허용범위를 넘습니다.");
  if (screenDoor.id !== "none" && (!stationPlan.positioningSystem || !stationPlan.doorInterlock)) pushIssue(violations, "screen-door-control-incomplete", "홈도어 정위치 제어 또는 출입문 연동이 준비되지 않았습니다.");

  if (stationPlan.operationMode === "goa4") {
    if (screenDoor.id === "none") pushIssue(violations, "goa4-screen-door-required", "무인운전에는 승강장 안전문이 필요합니다.");
    if (!stationPlan.positioningSystem || !stationPlan.doorInterlock || !stationPlan.platformMonitoring || !stationPlan.emergencyResponsePlan) pushIssue(violations, "goa4-safety-system-incomplete", "정위치 정차·문 연동·감시·비상 대응을 모두 갖춰야 합니다.");
  }
  if (stationPlan.stationRole === "terminal" && !stationPlan.turnback.available) pushIssue(violations, "turnback-missing", "종착역에 회차 설비가 없습니다.");

  const status = violations.length ? "incompatible" : conditions.length ? "conditional" : "compatible";
  return {
    status,
    compatible: status === "compatible",
    vehicleModelId,
    requiredLengthMeters,
    availableLengthMeters: shortestEdge,
    verticalStepMm,
    horizontalGapMm: horizontalGapMm === null ? null : round(horizontalGapMm, 1),
    violations,
    conditions,
  };
}

export function assessStationPlan(stationPlan, vehicleModelIds = [stationPlan?.designVehicleModelId]) {
  if (!stationPlan || stationPlan.schema !== STATION_PLAN_SCHEMA || stationPlan.contractVersion !== 1) throw new Error("StationPlan v1 is required");
  const structure = requireEntry(STATION_STRUCTURES, stationPlan.structureId, "station structure");
  const violations = [];
  const conditions = [];
  if (stationPlan.tracks.length > structure.maximumTrackCount) pushIssue(conditions, "wide-layout-special-design", "선택한 역 구조에서 이 배선은 특수 대단면 설계가 필요합니다.");
  for (const platform of stationPlan.platforms) {
    if (platform.widthMeters < platform.minimumWidthMeters) pushIssue(violations, "platform-too-narrow", "승강장 폭이 선택한 차량·배선의 최소 계획폭보다 좁습니다.", { platformId: platform.id, requiredWidthMeters: platform.minimumWidthMeters, widthMeters: platform.widthMeters });
    if (platform.effectiveAreaSquareMeters <= 0) pushIssue(violations, "no-effective-platform-area", "안전구역과 장애물을 제외한 유효 승강장 면적이 없습니다.", { platformId: platform.id });
  }
  if (stationPlan.finishedPlatformLengthMeters > stationPlan.structuralPlatformLengthMeters) pushIssue(violations, "finish-exceeds-structure", "영업 마감 길이가 시공된 구조 길이를 넘습니다.");
  const vehicleAssessments = vehicleModelIds.map((modelId) => assessVehiclePlatformCompatibility(stationPlan, modelId));
  for (const assessment of vehicleAssessments) {
    violations.push(...assessment.violations.map((issue) => ({ ...issue, vehicleModelId: assessment.vehicleModelId })));
    conditions.push(...assessment.conditions.map((issue) => ({ ...issue, vehicleModelId: assessment.vehicleModelId })));
  }
  const status = violations.length ? "incompatible" : conditions.length ? "conditional" : "compatible";
  return { status, buildable: status === "incompatible" ? false : status === "conditional" ? "conditional" : true, violations, conditions, vehicleAssessments };
}

