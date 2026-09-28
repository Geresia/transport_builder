import { TECHNICAL_PROFILES } from "./construction.mjs";
import { STATION_ACCESS_SCHEMA } from "./station-flow.mjs";
import { STATION_PLAN_SCHEMA } from "./station-planning.mjs";

export const STATION_CONSTRUCTION_CONTEXT_SCHEMA = "transitline.station-construction-context/1";

export const STATION_CONSTRUCTION_METHODS = Object.freeze({
  surface: { id: "surface", structures: ["surface"], fixedCost: 2_000_000_000, bodyCostPerSquareMeter: 900_000, baseCivilMonths: 18, minimumDepthMeters: 0, maximumDepthMeters: 4 },
  elevated: { id: "elevated", structures: ["elevated"], fixedCost: 4_000_000_000, bodyCostPerSquareMeter: 1_800_000, baseCivilMonths: 26, minimumDepthMeters: 0, maximumDepthMeters: 0 },
  "cut-cover": { id: "cut-cover", structures: ["cut-cover"], fixedCost: 5_000_000_000, bodyCostPerSquareMeter: 3_000_000, baseCivilMonths: 36, minimumDepthMeters: 6, maximumDepthMeters: 25, requiresSurfaceWorkZone: true },
  "mined-cavern": { id: "mined-cavern", structures: ["shield", "deep"], fixedCost: 9_000_000_000, bodyCostPerSquareMeter: 5_200_000, baseCivilMonths: 48, minimumDepthMeters: 15, maximumDepthMeters: 50, requiresShaft: true },
  "deep-mined": { id: "deep-mined", structures: ["deep"], fixedCost: 15_000_000_000, bodyCostPerSquareMeter: 7_200_000, baseCivilMonths: 60, minimumDepthMeters: 35, maximumDepthMeters: 80, requiresShaft: true },
});

const DEFAULT_METHOD = Object.freeze({ surface: "surface", elevated: "elevated", "cut-cover": "cut-cover", shield: "mined-cavern", deep: "deep-mined" });
const DEFAULT_LAND_UNIT_COST = Object.freeze({ JP: 600_000, KR: 500_000 });
const round = (value, digits = 0) => Number(value.toFixed(digits));
const finite = (value) => Number.isFinite(value) ? value : null;
const sum = (values) => values.reduce((total, value) => total + value, 0);

function assertPlan(stationPlan, accessPlan) {
  if (!stationPlan || stationPlan.schema !== STATION_PLAN_SCHEMA || stationPlan.contractVersion !== 1) throw new Error("StationPlan v1 is required");
  if (!accessPlan || accessPlan.schema !== STATION_ACCESS_SCHEMA || accessPlan.contractVersion !== 1 || accessPlan.stationPlanId !== stationPlan.id) throw new Error("Matching StationAccessPlan v1 is required");
}

function requireMethod(methodId) {
  const method = STATION_CONSTRUCTION_METHODS[methodId];
  if (!method) throw new Error(`Unknown station construction method ${methodId}`);
  return method;
}

function issue(code, message, details = {}) {
  return { code, message, ...details };
}

export function createStationConstructionContext(input = {}) {
  if (!input.stationPlanId) throw new Error("stationPlanId is required");
  const unknown = [...new Set(input.unknown ?? [])];
  return {
    schema: STATION_CONSTRUCTION_CONTEXT_SCHEMA,
    contractVersion: 1,
    stationPlanId: input.stationPlanId,
    stationSiteId: input.stationSiteId ?? null,
    connectedPlanId: input.connectedPlanId ?? null,
    connectedStationId: input.connectedStationId ?? null,
    depthMeters: finite(input.depthMeters),
    availableSurfaceWidthMeters: finite(input.availableSurfaceWidthMeters),
    surfaceAcquisitionAreaSquareMeters: finite(input.surfaceAcquisitionAreaSquareMeters),
    affectedBuildingCount: finite(input.affectedBuildingCount),
    utilityConflictLevel: input.utilityConflictLevel ?? null,
    groundwaterRisk: input.groundwaterRisk ?? null,
    softGroundRisk: input.softGroundRisk ?? null,
    constructionShaftAvailable: typeof input.constructionShaftAvailable === "boolean" ? input.constructionShaftAvailable : null,
    existingRailwayProximity: input.existingRailwayProximity ?? null,
    siteBodyLengthMeters: finite(input.siteBodyLengthMeters),
    siteBodyWidthMeters: finite(input.siteBodyWidthMeters),
    bodyDimensionsConfirmed: typeof input.bodyDimensionsConfirmed === "boolean" ? input.bodyDimensionsConfirmed : null,
    selectedWorkArea: input.selectedWorkArea ? structuredClone(input.selectedWorkArea) : null,
    extensionSpace: Array.isArray(input.extensionSpace) ? structuredClone(input.extensionSpace) : [],
    landUnitCostJpyPerSquareMeter: finite(input.landUnitCostJpyPerSquareMeter),
    dataQuality: input.dataQuality ?? "low",
    unknown,
    unknownReasons: structuredClone(input.unknownReasons ?? {}),
    sourceStationSite: input.sourceStationSite ? structuredClone(input.sourceStationSite) : null,
  };
}

function resolveContext(context, stationPlan, bodyAreaSquareMeters, countryProfile) {
  if (!context || context.schema !== STATION_CONSTRUCTION_CONTEXT_SCHEMA || context.contractVersion !== 1 || context.stationPlanId !== stationPlan.id) throw new Error("Matching StationConstructionContext v1 is required");
  const imputedInputs = [];
  const assume = (field, value, assumedValue, unit, basis) => {
    imputedInputs.push({ field, sourceValue: value ?? null, assumedValue, unit, reason: context.unknownReasons?.[field] ?? "missing-value", basis });
    return assumedValue;
  };
  const number = (field, value, assumedValue, unit, basis) => finite(value) ?? assume(field, value, assumedValue, unit, basis);
  const category = (field, value, assumedValue, basis) => value ?? assume(field, value, assumedValue, "category", basis);
  const flag = (field, value, assumedValue, basis) => typeof value === "boolean" ? value : assume(field, value, assumedValue, "boolean", basis);
  const depthDefault = { surface: 0, elevated: 0, "cut-cover": 15, shield: 25, deep: 45 }[stationPlan.structureId];
  const depthMeters = number("depthMeters", context.depthMeters, depthDefault, "m", "station structure concept depth");
  const landUnitCost = number("landUnitCostJpyPerSquareMeter", context.landUnitCostJpyPerSquareMeter, DEFAULT_LAND_UNIT_COST[countryProfile.id] ?? 600_000, "JPY/m2", "country concept-stage urban land allowance");
  return {
    depthMeters,
    availableSurfaceWidthMeters: number("availableSurfaceWidthMeters", context.availableSurfaceWidthMeters, 24, "m", "concept-stage work-zone width"),
    surfaceAcquisitionAreaSquareMeters: number("surfaceAcquisitionAreaSquareMeters", context.surfaceAcquisitionAreaSquareMeters, stationPlan.structureId === "surface" || stationPlan.structureId === "elevated" ? bodyAreaSquareMeters * 0.35 : bodyAreaSquareMeters * 0.12, "m2", "structure-based permanent and temporary surface rights allowance"),
    affectedBuildingCount: number("affectedBuildingCount", context.affectedBuildingCount, 2, "count", "concept-stage urban station conflict allowance"),
    utilityConflictLevel: category("utilityConflictLevel", context.utilityConflictLevel, "medium", "concept-stage utility allowance"),
    groundwaterRisk: category("groundwaterRisk", context.groundwaterRisk, "medium", "concept-stage underground risk allowance"),
    softGroundRisk: category("softGroundRisk", context.softGroundRisk, "medium", "concept-stage ground risk allowance"),
    constructionShaftAvailable: flag("constructionShaftAvailable", context.constructionShaftAvailable, false, "unverified shaft site is not treated as secured"),
    existingRailwayProximity: category("existingRailwayProximity", context.existingRailwayProximity, "none", "no verified overlap with an operating railway"),
    landUnitCostJpyPerSquareMeter: landUnitCost,
    imputedInputs,
  };
}

function buildSchedule({ countryProfile, method, resolved, stationPlan, accessPlan }) {
  const utilityMonths = { low: 4, medium: 8, high: 16 }[resolved.utilityConflictLevel] ?? 10;
  const rightsMonths = Math.ceil((8 + resolved.affectedBuildingCount * 1.5) * countryProfile.landAndUndergroundRights.negotiationModifier);
  const depthMonths = Math.max(0, resolved.depthMeters - 15) * 0.25;
  const groundMonths = ({ low: 0, medium: 4, high: 10 }[resolved.groundwaterRisk] ?? 5) + ({ low: 0, medium: 3, high: 8 }[resolved.softGroundRisk] ?? 4);
  const complexityMonths = Math.max(0, stationPlan.tracks.length - 2) * 4 + Math.max(0, accessPlan.entrances.length - 2) * 2;
  const tasks = [
    { id: "design-approval", durationMonths: countryProfile.approvalMonths, dependencies: [] },
    { id: "rights", durationMonths: rightsMonths, dependencies: ["design-approval"] },
    { id: "utility-relocation", durationMonths: utilityMonths, dependencies: ["design-approval"] },
    { id: "enabling-works", durationMonths: 4 + (method.requiresShaft ? 8 : 0), dependencies: ["rights", "utility-relocation"] },
    { id: "civil-structure", durationMonths: Math.ceil(method.baseCivilMonths + depthMonths + groundMonths + complexityMonths), dependencies: ["enabling-works"] },
    { id: "architecture-platforms", durationMonths: 10 + Math.ceil(stationPlan.platforms.length * 2), dependencies: ["civil-structure"] },
    { id: "mep-fire-life-safety", durationMonths: 12 + Math.ceil(resolved.depthMeters / 10), dependencies: ["civil-structure"] },
    { id: "rail-systems", durationMonths: 8 + Math.max(0, stationPlan.tracks.length - 2) * 2, dependencies: ["civil-structure"] },
    { id: "integrated-testing", durationMonths: 6, dependencies: ["architecture-platforms", "mep-fire-life-safety", "rail-systems"] },
  ];
  const finish = new Map();
  for (const task of tasks) {
    task.startMonth = Math.max(0, ...task.dependencies.map((dependency) => finish.get(dependency) ?? 0));
    task.finishMonth = task.startMonth + task.durationMonths;
    finish.set(task.id, task.finishMonth);
  }
  const durationMonths = Math.max(...tasks.map((task) => task.finishMonth));
  const criticalTaskIds = [];
  let cursor = tasks.find((task) => task.finishMonth === durationMonths);
  while (cursor) {
    criticalTaskIds.unshift(cursor.id);
    const priorId = cursor.dependencies.find((dependency) => finish.get(dependency) === cursor.startMonth);
    cursor = tasks.find((task) => task.id === priorId);
  }
  return { durationMonths, tasks, criticalTaskIds };
}

export function estimateStationConstruction({ stationPlan, accessPlan, context, countryProfile, methodId = DEFAULT_METHOD[stationPlan?.structureId] } = {}) {
  assertPlan(stationPlan, accessPlan);
  if (!countryProfile?.constructionCostModifier || !countryProfile.landAndUndergroundRights) throw new Error("Country profile is required");
  const method = requireMethod(methodId);
  const technicalProfile = TECHNICAL_PROFILES[stationPlan.technicalProfileId];
  const platformStructuralArea = sum(stationPlan.platforms.map((platform) => platform.structuralLengthMeters * platform.widthMeters));
  const trackEnvelopeWidth = stationPlan.tracks.length * (technicalProfile.carWidthM + 1.2);
  const bodyWidthMeters = sum(stationPlan.platforms.map((platform) => platform.widthMeters)) + trackEnvelopeWidth;
  const bodyLengthMeters = stationPlan.structuralPlatformLengthMeters + 20;
  const bodyAreaSquareMeters = bodyWidthMeters * bodyLengthMeters;
  const resolved = resolveContext(context, stationPlan, bodyAreaSquareMeters, countryProfile);
  const violations = [];
  const conditions = [];
  if (!method.structures.includes(stationPlan.structureId)) violations.push(issue("method-structure-mismatch", "선택 공법이 역 구조형식을 지원하지 않습니다."));
  if (resolved.depthMeters < method.minimumDepthMeters || resolved.depthMeters > method.maximumDepthMeters) violations.push(issue("method-depth-outside-range", "계획 깊이가 선택 공법의 적용 범위를 벗어납니다.", { depthMeters: resolved.depthMeters, minimumDepthMeters: method.minimumDepthMeters, maximumDepthMeters: method.maximumDepthMeters }));
  if (method.requiresSurfaceWorkZone && resolved.availableSurfaceWidthMeters < bodyWidthMeters + 6) conditions.push(issue("surface-work-zone-short", "개착 작업폭이 부족해 도로 전면점용이나 추가 토지사용권이 필요합니다.", { requiredWidthMeters: round(bodyWidthMeters + 6, 1), availableWidthMeters: resolved.availableSurfaceWidthMeters }));
  if (method.requiresShaft && !resolved.constructionShaftAvailable) conditions.push(issue("construction-shaft-unsecured", "굴착·자재반입용 작업구 부지가 확보되지 않았습니다."));
  if (resolved.existingRailwayProximity === "overlap") conditions.push(issue("live-rail-interface", "영업 중 철도와 겹쳐 단계시공·야간차단 계획이 필요합니다."));
  if (context.bodyDimensionsConfirmed === false) conditions.push(issue("placeholder-site-body", "지도 본체 크기가 자리표시 값이므로 상세 구조 크기에 맞춘 재검토가 필요합니다."));
  const extraStructuralLength = Number.isFinite(context.siteBodyLengthMeters) ? Math.max(0, stationPlan.structuralPlatformLengthMeters - context.siteBodyLengthMeters) : null;
  if (extraStructuralLength > 0) {
    const knownExtension = context.extensionSpace.filter((entry) => Number.isFinite(entry.freeLengthMeters));
    if (knownExtension.length !== context.extensionSpace.length || knownExtension.length < 2) conditions.push(issue("extension-space-unknown", "장래 승강장 연장 공간을 확정할 수 없습니다.", { requiredExtraLengthMeters: round(extraStructuralLength, 1) }));
    else if (sum(knownExtension.map((entry) => entry.freeLengthMeters)) < extraStructuralLength) violations.push(issue("extension-space-insufficient", "장래 편성 증결에 필요한 직선 연장 공간이 부족합니다.", { requiredExtraLengthMeters: round(extraStructuralLength, 1), availableLengthMeters: round(sum(knownExtension.map((entry) => entry.freeLengthMeters)), 1) }));
  }

  const modifier = countryProfile.constructionCostModifier;
  const depthFactor = 1 + Math.max(0, resolved.depthMeters - 10) * 0.012;
  const groundRiskFactor = 1 + ({ low: 0, medium: 0.08, high: 0.2 }[resolved.groundwaterRisk] ?? 0.1) + ({ low: 0, medium: 0.06, high: 0.16 }[resolved.softGroundRisk] ?? 0.08);
  const civilStructure = (method.fixedCost + bodyAreaSquareMeters * method.bodyCostPerSquareMeter * depthFactor * groundRiskFactor) * modifier;
  const platformFinishes = platformStructuralArea * 350_000 * modifier;
  const platformEdgeLength = sum(stationPlan.platforms.flatMap((platform) => platform.edges.map((edge) => edge.usableLengthMeters)));
  const screenDoorUnit = { none: 0, "half-height": 5_000_000, "full-height": 8_000_000, "wide-opening": 11_000_000 }[stationPlan.screenDoor.id];
  const platformEdgesAndDoors = platformEdgeLength * (120_000 + screenDoorUnit) * modifier;
  const entranceStructures = accessPlan.entrances.length * (stationPlan.structureId === "surface" ? 450_000_000 : 900_000_000) * modifier;
  const verticalCirculation = sum(accessPlan.circulation.map((item) => item.type === "elevator" ? (item.units ?? 1) * 180_000_000 : item.type === "escalator" ? (item.units ?? 1) * 120_000_000 : (item.widthMeters ?? 1) * 45_000_000)) * modifier;
  const fareCollection = sum(accessPlan.gates.map((gate) => gate.lanes * 18_000_000)) * modifier;
  const transferWorks = sum(accessPlan.transferLinks.map((link) => link.distanceMeters * link.widthMeters * 1_200_000)) * modifier;
  const trackAndGuideway = stationPlan.tracks.length * bodyLengthMeters * 1_800_000 * (technicalProfile.guidewayCostFactor ?? 1) * modifier;
  const mepFireAndVentilation = bodyAreaSquareMeters * (stationPlan.structureId === "surface" ? 180_000 : stationPlan.structureId === "elevated" ? 260_000 : 650_000 + resolved.depthMeters * 8_000) * modifier;

  const rightsKind = stationPlan.structureId === "surface" || stationPlan.structureId === "elevated" ? "surface-acquisition" : resolved.depthMeters >= 40 && countryProfile.landAndUndergroundRights.deepUndergroundAvailable ? "deep-underground-right" : "subsurface-and-temporary-rights";
  const rightsRate = rightsKind === "surface-acquisition" ? 1 : rightsKind === "deep-underground-right" ? 0.03 : 0.12;
  const landAndRights = (resolved.surfaceAcquisitionAreaSquareMeters * resolved.landUnitCostJpyPerSquareMeter * rightsRate + resolved.affectedBuildingCount * 120_000_000) * countryProfile.landAndUndergroundRights.negotiationModifier;
  const direct = civilStructure + platformFinishes + platformEdgesAndDoors + entranceStructures + verticalCirculation + fareCollection + transferWorks + trackAndGuideway + mepFireAndVentilation + landAndRights;
  const designManagement = direct * 0.12;
  const testing = direct * 0.03;
  const unknownFields = new Set([...(context.unknown ?? []), ...Object.keys(context.unknownReasons ?? {}), ...resolved.imputedInputs.map((entry) => entry.field)]);
  const contingencyRate = 0.18 + Math.min(0.18, unknownFields.size * 0.015) + (context.dataQuality === "low" ? 0.06 : context.dataQuality === "medium" ? 0.025 : 0);
  const contingency = (direct + designManagement + testing) * contingencyRate;
  const totalP50 = direct + designManagement + testing + contingency;
  const p90Factor = 1.18 + unknownFields.size * 0.012 + conditions.length * 0.025;
  const totalP90 = totalP50 * p90Factor;
  const schedule = buildSchedule({ countryProfile, method, resolved, stationPlan, accessPlan });
  schedule.durationP90Months = Math.ceil(schedule.durationMonths * (1.12 + unknownFields.size * 0.015 + conditions.length * 0.03));

  return {
    stationPlanId: stationPlan.id,
    stationSiteId: context.stationSiteId,
    methodId,
    countryId: countryProfile.id,
    currency: "JPY",
    priceBaseYear: 2026,
    feasibility: violations.length ? "infeasible" : conditions.length ? "conditional" : "feasible",
    violations,
    conditions,
    quantities: { bodyLengthMeters: round(bodyLengthMeters, 1), bodyWidthMeters: round(bodyWidthMeters, 1), bodyAreaSquareMeters: round(bodyAreaSquareMeters, 1), platformStructuralAreaSquareMeters: round(platformStructuralArea, 1), platformEdgeLengthMeters: round(platformEdgeLength, 1), entranceCount: accessPlan.entrances.length, trackCount: stationPlan.tracks.length },
    rights: { kind: rightsKind, surfaceAreaSquareMeters: resolved.surfaceAcquisitionAreaSquareMeters, affectedBuildingCount: resolved.affectedBuildingCount, cost: round(landAndRights) },
    costs: {
      civilStructure: round(civilStructure),
      platformFinishes: round(platformFinishes),
      platformEdgesAndDoors: round(platformEdgesAndDoors),
      entranceStructures: round(entranceStructures),
      verticalCirculation: round(verticalCirculation),
      fareCollection: round(fareCollection),
      transferWorks: round(transferWorks),
      trackAndGuideway: round(trackAndGuideway),
      mepFireAndVentilation: round(mepFireAndVentilation),
      landAndRights: round(landAndRights),
      designManagement: round(designManagement),
      testing: round(testing),
      contingency: round(contingency),
      contingencyRate: round(contingencyRate, 4),
      totalP50: round(totalP50),
      totalP90: round(totalP90),
    },
    schedule,
    uncertainty: { unknown: [...(context.unknown ?? [])], unknownReasons: structuredClone(context.unknownReasons ?? {}), unknownCount: unknownFields.size, dataQuality: context.dataQuality, imputedInputs: structuredClone(resolved.imputedInputs) },
    sourceContext: structuredClone(context),
  };
}

