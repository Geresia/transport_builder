import { TECHNICAL_PROFILES } from "./construction.mjs";
import { VEHICLE_MODELS } from "./rolling-stock.mjs";

export const DEPOT_SITE_SCHEMA = "transitline.depot-site-geometry/1";

export const DEPOT_STRUCTURES = Object.freeze({
  surface: { id: "surface", costFactor: 1, durationMonths: 48, landUseFactor: 1, noiseReduction: 0, expansionFactor: 1, opexFactor: 1 },
  deck: { id: "deck", costFactor: 1.55, durationMonths: 66, landUseFactor: 1, noiseReduction: 12, expansionFactor: 0.8, opexFactor: 1.12 },
  "semi-underground": { id: "semi-underground", costFactor: 2.25, durationMonths: 78, landUseFactor: 0.72, noiseReduction: 22, expansionFactor: 0.55, opexFactor: 1.3 },
  underground: { id: "underground", costFactor: 3.5, durationMonths: 96, landUseFactor: 0.55, noiseReduction: 35, expansionFactor: 0.3, opexFactor: 1.55 },
  extension: { id: "extension", costFactor: 0.85, durationMonths: 42, landUseFactor: 0.65, noiseReduction: 4, expansionFactor: 0.75, opexFactor: 0.92 },
  shared: { id: "shared", costFactor: 0.35, durationMonths: 30, landUseFactor: 0.25, noiseReduction: 6, expansionFactor: 0.25, opexFactor: 0.7 },
});

export const MITIGATION_PACKAGES = Object.freeze({
  minimum: { id: "minimum", costRate: 0.03, durationMonths: 0, oppositionReduction: 5 },
  standard: { id: "standard", costRate: 0.08, durationMonths: 3, oppositionReduction: 14 },
  enhanced: { id: "enhanced", costRate: 0.14, durationMonths: 6, oppositionReduction: 24 },
});

export const COMMUNITY_PACKAGES = Object.freeze({
  none: { id: "none", cost: 0, durationMonths: 0, oppositionReduction: 0, annualRevenue: 0 },
  "green-buffer": { id: "green-buffer", cost: 2_500_000_000, durationMonths: 2, oppositionReduction: 8, annualRevenue: 0 },
  connections: { id: "connections", cost: 6_000_000_000, durationMonths: 4, oppositionReduction: 14, annualRevenue: 0 },
  "civic-deck": { id: "civic-deck", cost: 14_000_000_000, durationMonths: 8, oppositionReduction: 22, annualRevenue: 650_000_000 },
  "passenger-access": { id: "passenger-access", cost: 25_000_000_000, durationMonths: 12, oppositionReduction: 28, annualRevenue: 300_000_000 },
});

const clamp = (value, minimum = 0, maximum = 100) => Math.max(minimum, Math.min(maximum, value));
const finite = (value) => Number.isFinite(value) ? value : null;

const SITE_CLASS_ASSUMPTIONS = Object.freeze({
  urban: { buildingDensity: 3_000, residentialDistance: 75, roadsThroughSite: 2, connectionBuildingCrossings: 1.5 },
  terminal: { buildingDensity: 1_000, residentialDistance: 250, roadsThroughSite: 1, connectionBuildingCrossings: 0.75 },
  suburban: { buildingDensity: 500, residentialDistance: 600, roadsThroughSite: 0.5, connectionBuildingCrossings: 0.5 },
  remote: { buildingDensity: 100, residentialDistance: 1_500, roadsThroughSite: 0.25, connectionBuildingCrossings: 0.25 },
  shared: { buildingDensity: 800, residentialDistance: 500, roadsThroughSite: 1, connectionBuildingCrossings: 0.75 },
  extension: { buildingDensity: 1_000, residentialDistance: 350, roadsThroughSite: 1, connectionBuildingCrossings: 1 },
});

function aggregateCount(value) {
  if (Number.isFinite(value)) return Math.max(0, value);
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const values = Object.values(value);
  if (!values.length || values.some((entry) => !Number.isFinite(entry))) return null;
  return values.reduce((sum, entry) => sum + Math.max(0, entry), 0);
}

function isDeclaredUnknown(site, field) {
  return (site.unknown ?? []).includes(field)
    || Object.prototype.hasOwnProperty.call(site.unknownReasons ?? {}, field);
}

function createSpatialCalculationInputs(site, siteClass, effectiveRequiredArea) {
  const imputedInputs = [];
  const assumptionDefaults = SITE_CLASS_ASSUMPTIONS[siteClass];
  const assume = (field, sourceValue, assumedValue, unit, basis) => {
    imputedInputs.push({
      field,
      sourceValue: sourceValue ?? null,
      assumedValue,
      unit,
      reason: site.unknownReasons?.[field] ?? "missing-value",
      basis,
    });
    return assumedValue;
  };
  const numberOrAssumption = (field, value, assumedValue, unit, basis) => {
    const observed = finite(value);
    return observed === null ? assume(field, value, assumedValue, unit, basis) : observed;
  };
  const countOrAssumption = (field, value, assumedValue, basis) => {
    const observed = aggregateCount(value);
    return observed === null ? assume(field, value, assumedValue, "count", basis) : observed;
  };

  const areaSquareMeters = numberOrAssumption(
    "areaSquareMeters",
    site.areaSquareMeters,
    effectiveRequiredArea,
    "m2",
    "minimum functional area required by the selected structure",
  );
  const connectionTrackLengthMeters = numberOrAssumption(
    "connectionTrackLengthMeters",
    site.connectionTrackLengthMeters,
    2_000,
    "m",
    "early-stage access-track allowance",
  );
  const distanceToTerminalMeters = numberOrAssumption(
    "distanceToTerminalMeters",
    site.distanceToTerminalMeters,
    siteClass === "remote" ? 15_000 : siteClass === "urban" || siteClass === "terminal" ? 2_000 : 8_000,
    "m",
    "site-class deadhead allowance",
  );
  const surroundingBuildingDensity = numberOrAssumption(
    "surroundingBuildingDensity",
    site.surroundingBuildingDensity,
    assumptionDefaults.buildingDensity,
    "buildings/km2",
    "site-class planning density",
  );
  const densityBasedBuildingCount = clamp(
    surroundingBuildingDensity * Math.max(areaSquareMeters, effectiveRequiredArea) / 1_000_000 * 0.25,
    0.5,
    12,
  );
  const intersectedBuildingCount = countOrAssumption(
    "intersectedBuildingCount",
    site.intersectedBuildingCount,
    densityBasedBuildingCount,
    "25% of site-class building density over the acquisition area, bounded for concept design",
  );
  const accessKm = connectionTrackLengthMeters / 1_000;
  const roadCrossingCount = countOrAssumption(
    "roadCrossingCount",
    site.roadCrossingCount,
    clamp(accessKm * 0.75, 0.5, 4),
    "concept-stage road crossing rate per access-track kilometre",
  );
  const waterCrossingCount = countOrAssumption(
    "waterCrossingCount",
    site.waterCrossingCount,
    0.25,
    "risk-weighted expected crossing when the water layer is unavailable",
  );
  const waterOverlapCount = countOrAssumption(
    "waterOverlapCount",
    site.waterOverlapCount,
    0.15,
    "risk-weighted expected overlap when the water layer is unavailable",
  );
  const roadsThroughSite = countOrAssumption(
    "roadsThroughSite",
    site.roadsThroughSite,
    assumptionDefaults.roadsThroughSite,
    "site-class severance allowance",
  );
  const connectionBuildingCrossings = countOrAssumption(
    "connectionCrossings.building",
    site.connectionCrossings?.building,
    assumptionDefaults.connectionBuildingCrossings,
    "site-class access-track building conflict allowance",
  );
  const maximumSlopePercent = numberOrAssumption(
    "maximumSlopePercent",
    site.maximumSlopePercent,
    2.5,
    "%",
    "concept-stage depot grading allowance",
  );

  let distanceToResidentialMeters = finite(site.distanceToResidentialMeters);
  if (distanceToResidentialMeters === null) {
    if (isDeclaredUnknown(site, "distanceToResidentialMeters")) {
      distanceToResidentialMeters = assume(
        "distanceToResidentialMeters",
        site.distanceToResidentialMeters,
        assumptionDefaults.residentialDistance,
        "m",
        "site-class residential exposure allowance",
      );
    } else {
      distanceToResidentialMeters = finite(site.residentialSearchRadiusMeters) ?? 2_000;
    }
  }

  return {
    areaSquareMeters,
    connectionTrackLengthMeters,
    distanceToTerminalMeters,
    surroundingBuildingDensity,
    intersectedBuildingCount,
    roadCrossingCount,
    waterCrossingCount,
    waterOverlapCount,
    roadsThroughSite,
    connectionBuildingCrossings,
    maximumSlopePercent,
    distanceToResidentialMeters,
    imputedInputs,
  };
}

function requireCatalogEntry(catalog, id, label) {
  const value = catalog[id];
  if (!value) throw new Error(`Unknown ${label} ${id}`);
  return value;
}

export function depotCapacityRequirement({ capacitySets, inspectionSetsPerDay, modelId, reserveAreaRatio = 0.15 }) {
  const model = VEHICLE_MODELS[modelId];
  if (!model) throw new Error(`Unknown vehicle model ${modelId}`);
  if (!Number.isInteger(capacitySets) || capacitySets < 1) throw new Error("Depot capacity must be a positive integer");
  if (!(inspectionSetsPerDay > 0)) throw new Error("Depot inspection capacity must be positive");
  const profile = TECHNICAL_PROFILES[model.profileId];
  const trainLengthMeters = model.cars * profile.platformLengthPerCarM;
  const stablingAreaSquareMeters = capacitySets * (1_200 + trainLengthMeters * 12);
  const maintenanceAreaSquareMeters = 20_000 + inspectionSetsPerDay * 5_000;
  const operationalAreaSquareMeters = stablingAreaSquareMeters + maintenanceAreaSquareMeters;
  return {
    capacitySets,
    inspectionSetsPerDay,
    modelId,
    trainLengthMeters,
    stablingAreaSquareMeters,
    maintenanceAreaSquareMeters,
    operationalAreaSquareMeters,
    requiredAreaSquareMeters: Math.ceil(operationalAreaSquareMeters * (1 + reserveAreaRatio)),
    reserveAreaRatio,
  };
}

export function classifyDepotSite(site, structureId = "surface") {
  if (structureId === "shared" || ["within", "overlaps", "adjacent"].includes(site.existingFacilityReuse?.status)) return "shared";
  if (structureId === "extension") return "extension";
  const density = finite(site.surroundingBuildingDensity);
  const residential = finite(site.distanceToResidentialMeters);
  if ((density !== null && density >= 2_500) || (residential !== null && residential < 100)) return "urban";
  const terminal = finite(site.distanceToTerminalMeters);
  if (terminal !== null && terminal <= 2_000) return "terminal";
  if (terminal !== null && terminal <= 12_000) return "suburban";
  return terminal === null ? "suburban" : "remote";
}

function landUnitCost(siteClass, density, residentialDistance) {
  const base = { urban: 900_000, terminal: 520_000, suburban: 190_000, remote: 80_000, shared: 65_000, extension: 260_000 }[siteClass];
  const densityFactor = clamp(0.8 + density / 5_000, 0.8, 1.8);
  const residentialFactor = residentialDistance < 100 ? 1.15 : 1;
  return base * densityFactor * residentialFactor;
}

function exposureScore(distanceMeters) {
  if (!Number.isFinite(distanceMeters)) return 45;
  return clamp(100 * (1 - distanceMeters / 1_000));
}

function computeCommunity(inputs, siteClass, structure, mitigation, community, { disclosedEarly = true, comparisonCount = 1 } = {}) {
  const residentialExposure = exposureScore(inputs.distanceToResidentialMeters);
  const relocationComplexity = clamp(inputs.intersectedBuildingCount * 7);
  const baseNoise = { urban: 80, terminal: 72, suburban: 54, remote: 34, shared: 42, extension: 56 }[siteClass];
  const noiseAndVibration = clamp(baseNoise - structure.noiseReduction);
  const nuisance = clamp(inputs.surroundingBuildingDensity / 45 + inputs.roadCrossingCount * 4 + inputs.connectionBuildingCrossings * 5);
  const severance = clamp(inputs.roadsThroughSite * 8 + inputs.waterCrossingCount * 10);
  const nature = clamp(inputs.waterOverlapCount * 18 + Math.max(0, inputs.maximumSlopePercent - 2) * 8);
  const processDistrust = clamp((disclosedEarly ? 20 : 65) - (comparisonCount >= 3 ? 18 : comparisonCount >= 2 ? 10 : 0));
  const grossPressure = 0.25 * residentialExposure + 0.2 * relocationComplexity + 0.15 * noiseAndVibration + 0.1 * nuisance + 0.1 * severance + 0.1 * nature + 0.1 * processDistrust;
  const benefitReduction = Math.min(35, mitigation.oppositionReduction + community.oppositionReduction);
  const oppositionPressure = clamp(grossPressure - benefitReduction);
  const publicAcceptance = 100 - oppositionPressure;
  const municipalSupport = clamp(60 + community.oppositionReduction * 0.7 + mitigation.oppositionReduction * 0.25 - oppositionPressure * 0.55);
  return {
    residentialExposure,
    relocationComplexity,
    noiseAndVibration,
    nuisance,
    severance,
    nature,
    processDistrust,
    grossPressure,
    benefitReduction,
    oppositionPressure,
    publicAcceptance,
    municipalSupport,
  };
}

export function deadheadEconomics({ oneWayDistanceKm, dailySets, operatingDays = 365, driverless = false, countryCostModifier = 1 }) {
  if (!(oneWayDistanceKm >= 0) || !(dailySets > 0) || !(operatingDays > 0)) throw new Error("Invalid deadhead assumptions");
  const annualTrainKm = oneWayDistanceKm * 2 * dailySets * operatingDays;
  const vehicleAndEnergyCost = annualTrainKm * 1_200 * countryCostModifier;
  const trainHours = annualTrainKm / 25;
  const crewAndControlCost = trainHours * (driverless ? 1_350 : 4_500) * countryCostModifier;
  const directAnnualCost = vehicleAndEnergyCost + crewAndControlCost;
  const slotCongestionCost = annualTrainKm * 250 * countryCostModifier;
  return { oneWayDistanceKm, annualTrainKm, trainHours, vehicleAndEnergyCost, crewAndControlCost, directAnnualCost, slotCongestionCost, totalAnnualCost: directAnnualCost + slotCongestionCost };
}

export function assessDepotCandidate({
  site,
  countryProfile,
  capacitySets,
  inspectionSetsPerDay,
  modelId,
  structureId = "surface",
  mitigationPackageId = "standard",
  communityPackageId = "green-buffer",
  disclosedEarly = true,
  comparisonCount = 1,
  driverless = false,
} = {}) {
  if (!site || site.schema !== DEPOT_SITE_SCHEMA || site.contractVersion !== 1) throw new Error("DepotSiteGeometry v1 is required");
  if (!countryProfile?.constructionCostModifier) throw new Error("Country profile is required");
  const structure = requireCatalogEntry(DEPOT_STRUCTURES, structureId, "depot structure");
  const mitigation = requireCatalogEntry(MITIGATION_PACKAGES, mitigationPackageId, "mitigation package");
  const communityPackage = requireCatalogEntry(COMMUNITY_PACKAGES, communityPackageId, "community package");
  const requirement = depotCapacityRequirement({ capacitySets, inspectionSetsPerDay, modelId });
  const siteClass = classifyDepotSite(site, structureId);
  const area = finite(site.areaSquareMeters);
  const effectiveRequiredArea = requirement.requiredAreaSquareMeters * structure.landUseFactor;
  const calculationInputs = createSpatialCalculationInputs(site, siteClass, effectiveRequiredArea);
  const areaRatio = area === null ? null : area / effectiveRequiredArea;
  const blockingReasons = [];
  const conditionalReasons = [];
  if (!site.connectedPlanId && !site.connectedExternalNetworkId) blockingReasons.push("본선 연결 대상이 없습니다.");
  if (areaRatio !== null && areaRatio < 0.7) blockingReasons.push("필수 유치·검수시설을 배치하기에 부지가 너무 작습니다.");
  else if (areaRatio !== null && areaRatio < 1) conditionalReasons.push("부족 면적을 입체화 또는 추가 취득으로 해결해야 합니다.");
  else if (areaRatio === null) conditionalReasons.push("부지면적 자료가 없어 용량 적합성을 확정할 수 없습니다.");
  if (finite(site.maximumSlopePercent) !== null && site.maximumSlopePercent > 5) blockingReasons.push("기지 배선 허용범위를 넘는 급경사 후보지입니다.");
  else if (finite(site.maximumSlopePercent) !== null && site.maximumSlopePercent > 3) conditionalReasons.push("대규모 평탄화와 옹벽 검토가 필요합니다.");
  else if (finite(site.maximumSlopePercent) === null) conditionalReasons.push("최대 경사 자료가 없어 기지 배선 적합성을 확정할 수 없습니다.");
  if (!Number.isFinite(site.connectionTrackLengthMeters) || !Number.isFinite(site.distanceToTerminalMeters)) conditionalReasons.push("입출고 회송거리 자료가 불완전합니다.");

  const modifier = countryProfile.constructionCostModifier;
  const pricedArea = calculationInputs.areaSquareMeters;
  const acquisitionArea = Math.max(effectiveRequiredArea, Math.min(pricedArea, effectiveRequiredArea * 1.5));
  const landAcquisitionCost = acquisitionArea * landUnitCost(siteClass, calculationInputs.surroundingBuildingDensity, calculationInputs.distanceToResidentialMeters) * (structureId === "underground" ? 0.35 : structureId === "shared" ? 0.12 : 1);
  const civilConstructionCost = effectiveRequiredArea * 260_000 * structure.costFactor * modifier;
  const buildingAndEquipmentCost = (capacitySets * 820_000_000 + inspectionSetsPerDay * 2_400_000_000) * Math.sqrt(structure.costFactor) * modifier;
  const accessKm = calculationInputs.connectionTrackLengthMeters / 1_000;
  const accessTrackCapex = (accessKm * 5_500_000_000 + calculationInputs.roadCrossingCount * 350_000_000 + calculationInputs.waterCrossingCount * 2_000_000_000 + calculationInputs.connectionBuildingCrossings * 250_000_000) * modifier;
  const relocationCost = calculationInputs.intersectedBuildingCount * 90_000_000 * modifier;
  const subtotalBeforePackages = landAcquisitionCost + civilConstructionCost + buildingAndEquipmentCost + accessTrackCapex + relocationCost;
  const mitigationCost = subtotalBeforePackages * mitigation.costRate;
  const communityPackageCost = communityPackage.cost * modifier;
  const designManagementTesting = (subtotalBeforePackages + mitigationCost + communityPackageCost) * 0.11;
  const unknownFields = new Set([
    ...(site.unknown ?? []),
    ...(site.constraintUnknown ?? []),
    ...Object.keys(site.unknownReasons ?? {}),
    ...calculationInputs.imputedInputs.map((entry) => entry.field),
  ]);
  const unknownCount = unknownFields.size;
  const contingencyRate = 0.16 + Math.min(0.14, unknownCount * 0.015) + (site.dataQuality === "low" ? 0.06 : site.dataQuality === "medium" ? 0.025 : 0);
  const contingency = (subtotalBeforePackages + mitigationCost + communityPackageCost + designManagementTesting) * contingencyRate;
  const totalP50 = subtotalBeforePackages + mitigationCost + communityPackageCost + designManagementTesting + contingency;

  const community = computeCommunity(calculationInputs, siteClass, structure, mitigation, communityPackage, { disclosedEarly, comparisonCount });
  const p90Factor = 1.16 + unknownCount * 0.015 + community.oppositionPressure * 0.0015;
  const totalP90 = totalP50 * p90Factor;
  const oneWayDistanceKm = (calculationInputs.connectionTrackLengthMeters + calculationInputs.distanceToTerminalMeters) / 1_000;
  const deadhead = deadheadEconomics({ oneWayDistanceKm, dailySets: capacitySets, driverless, countryCostModifier: modifier });
  const annualDepotOpex = (capacitySets * 58_000_000 + inspectionSetsPerDay * 240_000_000) * structure.opexFactor * modifier;
  const annualAncillaryRevenue = communityPackage.annualRevenue * (structureId === "deck" || structureId === "underground" ? 1 : 0.35);
  const countryCoordinationMonths = Math.max(0, countryProfile.approvalMonths - 24) * 0.5;
  const durationMonths = Math.ceil(structure.durationMonths + mitigation.durationMonths + communityPackage.durationMonths + countryCoordinationMonths + Math.min(24, community.oppositionPressure / 5 * countryProfile.disputeDelayModifier) + Math.min(18, unknownCount * 1.5) + Math.min(18, calculationInputs.intersectedBuildingCount / 2));
  const firstTrainPenaltyMinutes = oneWayDistanceKm / 25 * 60;

  const operationScore = clamp(100 - oneWayDistanceKm * 3.2 - firstTrainPenaltyMinutes * 0.35);
  const capexPerSet = totalP50 / capacitySets;
  const costScore = clamp(115 - capexPerSet / 120_000_000);
  const acceptanceScore = community.publicAcceptance;
  const calculationAreaRatio = calculationInputs.areaSquareMeters / effectiveRequiredArea;
  const expansionScore = clamp((areaRatio ?? calculationAreaRatio) * 75 * structure.expansionFactor);
  const resilienceScore = clamp(92 - calculationInputs.waterOverlapCount * 15 - calculationInputs.waterCrossingCount * 6 - Math.max(0, calculationInputs.maximumSlopePercent - 2) * 7);
  const ancillaryScore = clamp(annualAncillaryRevenue / 12_000_000 + communityPackage.oppositionReduction * 2);
  const overallScore = operationScore * 0.3 + costScore * 0.25 + acceptanceScore * 0.2 + expansionScore * 0.1 + resilienceScore * 0.1 + ancillaryScore * 0.05;

  return {
    siteId: site.depotSiteId,
    connectedPlanId: site.connectedPlanId ?? null,
    siteClass,
    structureId,
    mitigationPackageId,
    communityPackageId,
    countryId: countryProfile.id,
    currency: "JPY",
    priceBaseYear: 2026,
    requirement,
    areaSquareMeters: area,
    effectiveRequiredAreaSquareMeters: effectiveRequiredArea,
    areaRatio,
    feasibility: blockingReasons.length ? "infeasible" : conditionalReasons.length ? "conditional" : "feasible",
    blockingReasons,
    conditionalReasons,
    economics: {
      landAcquisitionCost,
      civilConstructionCost,
      buildingAndEquipmentCost,
      accessTrackCapex,
      relocationCost,
      mitigationCost,
      communityPackageCost,
      designManagementTesting,
      contingency,
      contingencyRate,
      totalP50,
      totalP90,
      annualDepotOpex,
      annualAncillaryRevenue,
      deadhead,
      netAnnualDepotCost: annualDepotOpex + deadhead.totalAnnualCost - annualAncillaryRevenue,
    },
    community,
    schedule: { durationMonths, firstTrainPenaltyMinutes },
    scores: { operation: operationScore, cost: costScore, acceptance: acceptanceScore, expansion: expansionScore, resilience: resilienceScore, ancillary: ancillaryScore, overall: overallScore },
    uncertainty: {
      unknown: [...(site.unknown ?? [])],
      unknownReasons: structuredClone(site.unknownReasons ?? {}),
      constraintUnknown: [...(site.constraintUnknown ?? [])],
      unknownCount,
      dataQuality: site.dataQuality ?? "low",
      imputedInputs: structuredClone(calculationInputs.imputedInputs),
    },
    sourceSite: structuredClone(site),
  };
}

export function compareDepotCandidates(assessments) {
  return [...assessments].sort((a, b) => {
    const rank = { feasible: 2, conditional: 1, infeasible: 0 };
    return rank[b.feasibility] - rank[a.feasibility] || b.scores.overall - a.scores.overall || a.economics.totalP50 - b.economics.totalP50;
  }).map((assessment, index) => ({ rank: index + 1, ...structuredClone(assessment) }));
}

export function createDepotDevelopment(input, countryProfile) {
  const assessment = assessDepotCandidate({ ...input, countryProfile });
  return {
    id: input.id,
    name: input.name,
    type: input.type ?? "D1",
    capacitySets: input.capacitySets,
    inspectionSetsPerDay: input.inspectionSetsPerDay,
    modelId: input.modelId,
    projectId: input.projectId ?? null,
    planId: assessment.connectedPlanId,
    siteId: assessment.siteId,
    locationStrategy: assessment.siteClass === "urban" ? "terminal" : assessment.siteClass === "extension" ? "terminal" : assessment.siteClass,
    assessment,
    status: "planned",
    entryRouteAvailable: false,
    heavyMaintenanceExternal: input.heavyMaintenanceExternal ?? true,
    elapsedMonths: 0,
    delayMonths: 0,
    progress: 0,
    paid: 0,
    riskEvents: [],
    deadheadKm: assessment.economics.deadhead.oneWayDistanceKm,
    communityRisk: assessment.community.oppositionPressure / 100,
    firstTrainPenaltyMinutes: assessment.schedule.firstTrainPenaltyMinutes,
    annualLeaseCost: assessment.economics.annualDepotOpex,
    annualAncillaryRevenue: assessment.economics.annualAncillaryRevenue,
    planningInput: structuredClone({
      site: input.site,
      capacitySets: input.capacitySets,
      inspectionSetsPerDay: input.inspectionSetsPerDay,
      modelId: input.modelId,
      structureId: input.structureId ?? "surface",
      mitigationPackageId: input.mitigationPackageId ?? "standard",
      communityPackageId: input.communityPackageId ?? "green-buffer",
      disclosedEarly: input.disclosedEarly ?? true,
      comparisonCount: input.comparisonCount ?? 1,
      driverless: input.driverless ?? false,
    }),
  };
}

export function reviseDepotDevelopment(depot, changes, countryProfile) {
  if (!["planned", "consultation"].includes(depot.status)) throw new Error("Only an uncontracted depot can be revised");
  const planningInput = { ...depot.planningInput, ...structuredClone(changes) };
  const assessment = assessDepotCandidate({ ...planningInput, countryProfile });
  depot.planningInput = planningInput;
  depot.assessment = assessment;
  depot.planId = assessment.connectedPlanId;
  depot.siteId = assessment.siteId;
  depot.locationStrategy = assessment.siteClass === "urban" || assessment.siteClass === "extension" ? "terminal" : assessment.siteClass;
  depot.deadheadKm = assessment.economics.deadhead.oneWayDistanceKm;
  depot.communityRisk = assessment.community.oppositionPressure / 100;
  depot.firstTrainPenaltyMinutes = assessment.schedule.firstTrainPenaltyMinutes;
  depot.annualLeaseCost = assessment.economics.annualDepotOpex;
  depot.annualAncillaryRevenue = assessment.economics.annualAncillaryRevenue;
  depot.status = "planned";
  delete depot.agreement;
  return depot;
}

export function negotiateDepotDevelopment(depot, terms = {}) {
  if (!["planned", "consultation"].includes(depot.status)) throw new Error("Depot is not available for negotiation");
  const operatorShare = terms.operatorShare ?? 0.6;
  const nationalGovernmentShare = terms.nationalGovernmentShare ?? 0.3;
  const localGovernmentShare = terms.localGovernmentShare ?? 0.1;
  const totalShare = operatorShare + nationalGovernmentShare + localGovernmentShare;
  if ([operatorShare, nationalGovernmentShare, localGovernmentShare].some((value) => value < 0) || Math.abs(totalShare - 1) > 1e-9) throw new Error("Depot funding shares must be non-negative and total 1");
  const negotiationScore = clamp(depot.assessment.community.municipalSupport + operatorShare * 20 - localGovernmentShare * 25);
  const accepted = depot.assessment.feasibility !== "infeasible" && negotiationScore >= 50;
  depot.agreement = {
    accepted,
    negotiationScore,
    operatorShare,
    nationalGovernmentShare,
    localGovernmentShare,
    operatorCapex: depot.assessment.economics.totalP50 * operatorShare,
    nationalGovernmentCapex: depot.assessment.economics.totalP50 * nationalGovernmentShare,
    localGovernmentCapex: depot.assessment.economics.totalP50 * localGovernmentShare,
    communityPackageId: depot.assessment.communityPackageId,
    mitigationPackageId: depot.assessment.mitigationPackageId,
  };
  depot.status = accepted ? "negotiated" : "consultation";
  return depot.agreement;
}

export function contractDepotDevelopment(depot, ledger, clock) {
  if (depot.status !== "negotiated" || !depot.agreement?.accepted) throw new Error("Depot agreement must be accepted before contract");
  if (depot.assessment.feasibility !== "feasible") throw new Error("Conditional depot design must resolve area, connection and engineering requirements before contract");
  const amount = depot.agreement.operatorCapex;
  ledger.commit({ id: `depot-development:${depot.id}`, atMinute: clock.minute, amount, category: "depot-development", reference: depot.id });
  const deposit = amount * 0.1;
  ledger.settle(`depot-development:${depot.id}`, deposit, clock.minute, "Depot design and land deposit");
  depot.paid = deposit;
  depot.status = "underConstruction";
  depot.contractedAt = clock.minute;
  return { depotId: depot.id, operatorCapex: amount, deposit };
}

export function advanceDepotDevelopmentMonth(depot, ledger, clock, rng, countryProfile) {
  if (depot.status !== "underConstruction") return { status: depot.status, payment: 0 };
  depot.elapsedMonths++;
  if (depot.delayMonths > 0) {
    depot.delayMonths--;
    return { status: depot.status, delayed: true, delayMonths: 1, payment: 0 };
  }
  const riskProbability = 0.012 + depot.communityRisk * 0.025 * countryProfile.disputeDelayModifier + depot.assessment.uncertainty.unknownCount * 0.001;
  if (rng.next() < riskProbability) {
    const delayMonths = 1 + Math.floor(rng.next() * 3);
    depot.delayMonths = delayMonths - 1;
    depot.riskEvents.push({ atMinute: clock.minute, type: "depot-delay", delayMonths });
    return { status: depot.status, delayed: true, delayMonths, payment: 0 };
  }
  depot.progress = Math.min(1, depot.elapsedMonths / depot.assessment.schedule.durationMonths);
  const operatorCapex = depot.agreement.operatorCapex;
  const targetPaid = Math.min(operatorCapex, operatorCapex * (0.1 + depot.progress * 0.8));
  const commitmentId = `depot-development:${depot.id}`;
  const commitment = ledger.commitments.get(commitmentId);
  const payment = Math.min(commitment?.remaining ?? 0, Math.max(0, targetPaid - depot.paid));
  if (payment > 0) ledger.settle(commitmentId, payment, clock.minute, "Depot monthly progress payment");
  depot.paid += payment;
  if (depot.progress >= 1) {
    const finalPayment = ledger.commitments.get(commitmentId)?.remaining ?? 0;
    if (finalPayment > 0) ledger.settle(commitmentId, finalPayment, clock.minute, "Depot testing and acceptance");
    depot.paid = operatorCapex;
    depot.status = "secured";
    depot.entryRouteAvailable = true;
    depot.completedAt = clock.minute;
  }
  return { status: depot.status, delayed: false, payment };
}
