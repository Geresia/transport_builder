import { validatePlanGeometry } from "./domain.mjs";
import { synchronizeStationDeliveryPackages } from "./station-delivery.mjs";

export const TECHNICAL_PROFILES = Object.freeze({
  medium_steel: { id: "medium_steel", gaugeMm: 1435, carWidthM: 2.8, carLengthM: 20, minCars: 4, maxCars: 10, power: "overhead-1500v-dc", platformLengthPerCarM: 20.5, maxGradientPermille: 35, minimumCurveRadiusMeters: 160, guidewayCostFactor: 1, stationCostFactor: 1, systemsCostFactor: 0.18 },
  small_steel: { id: "small_steel", gaugeMm: 1435, carWidthM: 2.5, carLengthM: 16, minCars: 2, maxCars: 8, power: "third-rail-750v-dc", platformLengthPerCarM: 16.5, maxGradientPermille: 45, minimumCurveRadiusMeters: 120, guidewayCostFactor: 0.88, stationCostFactor: 0.86, systemsCostFactor: 0.18 },
  large_steel: { id: "large_steel", gaugeMm: 1435, carWidthM: 3.0, carLengthM: 20, minCars: 6, maxCars: 12, power: "overhead-1500v-dc", platformLengthPerCarM: 20.5, maxGradientPermille: 30, minimumCurveRadiusMeters: 200, guidewayCostFactor: 1.15, stationCostFactor: 1.12, systemsCostFactor: 0.19 },
  agt: { id: "agt", gaugeMm: null, carWidthM: 2.5, carLengthM: 9, minCars: 3, maxCars: 8, power: "guideway-750v-dc", platformLengthPerCarM: 9.5, maxGradientPermille: 60, minimumCurveRadiusMeters: 60, guidewayCostFactor: 0.8, stationCostFactor: 0.8, platformCostFactor: 0.75, systemsCostFactor: 0.18, technologyPreparation: 1_000_000_000 },
  monorail: { id: "monorail", gaugeMm: null, carWidthM: 3.0, carLengthM: 15, minCars: 4, maxCars: 8, power: "straddle-beam-1500v-dc", platformLengthPerCarM: 15.5, maxGradientPermille: 60, minimumCurveRadiusMeters: 70, guidewayCostFactor: 0.95, stationCostFactor: 0.9, systemsCostFactor: 0.21, technologyPreparation: 1_500_000_000 },
  linear_metro: { id: "linear_metro", gaugeMm: 1435, carWidthM: 2.5, carLengthM: 16, minCars: 4, maxCars: 8, power: "linear-motor-1500v-dc", platformLengthPerCarM: 16.5, maxGradientPermille: 60, minimumCurveRadiusMeters: 100, guidewayCostFactor: 0.9, stationCostFactor: 0.88, systemsCostFactor: 0.19, technologyPreparation: 1_000_000_000 },
});

const COST_PER_KM_JPY = {
  surface: 4_500_000_000,
  elevated: 12_000_000_000,
  "cut-cover": 14_500_000_000,
  shield: 16_500_000_000,
  deep: 24_000_000_000,
  bridge: 18_000_000_000,
  embankment: 6_000_000_000,
  cutting: 8_000_000_000,
};

const STATION_COST_JPY = { surface: 6_000_000_000, elevated: 10_000_000_000, "cut-cover": 12_000_000_000, shield: 12_000_000_000, deep: 25_000_000_000 };

export function assessPlan(plan, technicalProfileId, countryProfile) {
  const validation = validatePlanGeometry(plan);
  const profile = TECHNICAL_PROFILES[technicalProfileId];
  const violations = [...validation.violations];
  if (!profile) violations.push(`Unknown technical profile ${technicalProfileId}`);
  for (const station of plan?.stationCandidates ?? []) {
    const requiredLength = profile ? profile.platformLengthPerCarM * (station.plannedCars ?? profile.minCars) : 0;
    // Unknown measurements may arrive as either an omitted field (v1) or
    // explicit null (map producer convention). Never let JS coerce null to
    // zero and turn missing data into a false engineering violation.
    if (Number.isFinite(station.platformLengthM) && station.platformLengthM < requiredLength) violations.push(`Station ${station.id} platform is too short`);
  }
  const base = estimatePlan(plan, technicalProfileId, countryProfile, false);
  return {
    buildable: violations.length ? false : validation.missingInputs.length ? "conditional" : true,
    violations,
    missingInputs: validation.missingInputs,
    estimateRange: base ? [base.totalP50 * 0.85, base.totalP50 * 1.3] : null,
    durationRange: base ? [Math.ceil(base.durationMonths * 0.85), Math.ceil(base.durationMonths * 1.35)] : null,
    technicalProfileCompatibility: profile ? "compatible" : "incompatible",
  };
}

export function estimatePlan(plan, technicalProfileId, countryProfile, strict = true) {
  const validation = validatePlanGeometry(plan);
  const profile = TECHNICAL_PROFILES[technicalProfileId];
  if (!profile || (strict && validation.buildable === false)) return null;
  let guideway = 0;
  let sequentialCivilMonths = 0;
  let routeKm = 0;
  const byStructure = {};
  for (const segment of plan.segments ?? []) {
    const km = segment.lengthMeters / 1000;
    routeKm += km;
    const unit = (COST_PER_KM_JPY[segment.structureHint] ?? COST_PER_KM_JPY.elevated) * (profile.guidewayCostFactor ?? 1);
    const constraint = 1 + (segment.constraintFlags?.length ?? 0) * 0.06 + (segment.dataQuality === "low" ? 0.12 : 0);
    const cost = km * unit * constraint;
    guideway += cost;
    byStructure[segment.structureHint] = (byStructure[segment.structureHint] ?? 0) + cost;
    const productivityKmMonth = ["shield", "deep"].includes(segment.structureHint) ? 0.15 : segment.structureHint === "cut-cover" ? 0.12 : 0.42;
    sequentialCivilMonths += km / productivityKmMonth;
  }
  let stations = 0;
  const stationItems = [];
  for (const station of plan.stationCandidates ?? []) {
    const structure = station.structure ?? plan.segments?.[0]?.structureHint ?? "surface";
    const depth = Math.max(0, station.depthMeters ?? 0);
    const platform = (station.platformType === "island" ? 1.08 : 1) * (profile.platformCostFactor ?? 1);
    const cost = (STATION_COST_JPY[structure] ?? STATION_COST_JPY.surface) * (profile.stationCostFactor ?? 1) * platform * (1 + depth * 0.008);
    stations += cost;
    stationItems.push({ stationId: station.id, structure, directCost: cost * countryProfile.constructionCostModifier });
  }
  const systems = (guideway + stations) * (profile.systemsCostFactor ?? 0.18);
  const direct = guideway + stations + systems;
  const designManagement = direct * 0.08;
  const testing = direct * 0.01 + (profile.technologyPreparation ?? 0);
  const contingency = (direct + designManagement + testing) * 0.2;
  const modifier = countryProfile.constructionCostModifier;
  const totalP50 = (direct + designManagement + testing + contingency) * modifier;
  const parallelCivilFronts = Math.max(1, Math.min(2, Math.ceil(routeKm / 20)));
  const civilMonths = sequentialCivilMonths / parallelCivilFronts;
  const durationMonths = Math.ceil(countryProfile.approvalMonths + Math.max(18, civilMonths, (plan.stationCandidates?.length ?? 0) * 4) + 9);
  return { currency: "JPY", priceBaseYear: 2026, guideway: guideway * modifier, stations: stations * modifier, stationItems, systems: systems * modifier, designManagement: designManagement * modifier, testing: testing * modifier, contingency: contingency * modifier, totalP50, totalP90: totalP50 * 1.25, durationMonths, parallelCivilFronts, byStructure };
}

export function createConstructionProject(plan, technicalProfileId, countryProfile) {
  const assessment = assessPlan(plan, technicalProfileId, countryProfile);
  if (assessment.buildable === false) throw new Error(assessment.violations.join("; "));
  const estimate = estimatePlan(plan, technicalProfileId, countryProfile);
  return {
    id: `project:${plan.planId}`,
    planId: plan.planId,
    planVersion: plan.version ?? 1,
    planGeometry: structuredClone(plan),
    countryId: countryProfile.id,
    technicalProfileId,
    status: "estimated",
    estimate,
    progress: 0,
    elapsedMonths: 0,
    delayMonths: 0,
    paid: 0,
    tasks: [
      { id: "design", weight: 0.12, progress: 0 },
      { id: "civil", weight: 0.58, progress: 0 },
      { id: "systems", weight: 0.2, progress: 0 },
      { id: "testing", weight: 0.1, progress: 0 },
    ],
    assets: [],
    riskEvents: [],
  };
}

export function contractConstruction(project, ledger, clock) {
  if (project.status !== "estimated" && project.status !== "approved") throw new Error("Project must be estimated or approved");
  if (project.stationDeliveryPackages?.length && !project.stationPackageCoverageComplete) throw new Error("Every planned station must have an awarded delivery package before construction contract");
  const deposit = project.estimate.totalP50 * 0.1;
  ledger.commit({ id: `construction:${project.id}`, atMinute: clock.minute, amount: project.estimate.totalP50, category: "construction", reference: project.id });
  ledger.settle(`construction:${project.id}`, deposit, clock.minute, "Contract deposit");
  project.paid += deposit;
  project.status = "contracted";
  synchronizeStationDeliveryPackages(project, clock);
  return deposit;
}

export function advanceConstructionMonth(project, ledger, clock, rng, countryProfile, { randomRisk = true } = {}) {
  if (!["contracted", "underConstruction", "inspection"].includes(project.status)) throw new Error("Project is not active");
  if (project.status === "contracted") project.status = "underConstruction";
  synchronizeStationDeliveryPackages(project, clock);
  project.elapsedMonths++;
  const riskProbability = 0.025 * countryProfile.disputeDelayModifier + (project.elapsedMonths % 12 === 0 ? 0.02 : 0);
  const riskRoll = project.status === "underConstruction" ? rng.next() : 1;
  if (riskRoll < riskProbability) {
    const delay = 1 + Math.floor(rng.next() * 3);
    if (randomRisk) {
      project.delayMonths += delay;
      project.riskEvents.push({ atMinute: clock.minute, type: "construction-delay", delayMonths: delay });
      return { delayed: true, delayMonths: delay, payment: 0 };
    }
  }
  if (project.delayMonths > 0) {
    project.delayMonths--;
    return { delayed: true, delayMonths: 1, payment: 0 };
  }

  const buildMonths = Math.max(1, project.estimate.durationMonths - countryProfile.approvalMonths - 3);
  const increment = Math.min(1 - project.progress, 1 / buildMonths);
  const commitment = ledger.commitments.get(`construction:${project.id}`);
  const payment = Math.min(commitment?.remaining ?? 0, project.estimate.totalP50 - project.paid, project.estimate.totalP50 * increment);
  if (payment > 0) ledger.settle(`construction:${project.id}`, payment, clock.minute, "Monthly progress payment");
  project.paid += payment;
  project.progress += increment;
  let cumulative = 0;
  for (const task of project.tasks) {
    const start = cumulative;
    cumulative += task.weight;
    task.progress = Math.max(0, Math.min(1, (project.progress - start) / task.weight));
  }
  if (project.progress >= 1 - 1e-9) {
    project.progress = 1;
    project.status = "inspection";
  }
  if (project.status === "inspection" && project.elapsedMonths >= buildMonths + 3) {
    project.status = "available";
    const stationAssets = project.planGeometry.stationCandidates.map((station) => ({
      id: `station:${project.id}:${station.id}`,
      sourceId: station.id,
      kind: "station",
      name: station.name ?? station.id,
      location: [...station.location],
      structure: station.structure ?? "surface",
      depthMeters: station.depthMeters ?? 0,
      status: "available",
    }));
    const platformAssets = project.planGeometry.stationCandidates.map((station) => ({
      id: `platform:${project.id}:${station.id}`,
      stationAssetId: `station:${project.id}:${station.id}`,
      kind: "platform",
      platformType: station.platformType,
      lengthMeters: station.platformLengthM,
      status: "available",
    }));
    const trackAssets = project.planGeometry.segments.map((segment, index) => ({
      id: `track:${project.id}:${index + 1}`,
      kind: "track-segment",
      fromStationAssetId: `station:${project.id}:${segment.from}`,
      toStationAssetId: `station:${project.id}:${segment.to}`,
      lengthMeters: segment.lengthMeters,
      structure: segment.structureHint,
      status: "available",
    }));
    project.assets = [...stationAssets, ...platformAssets, ...trackAssets,
      { id: `systems:${project.id}`, kind: "power-signal", status: "available" }];
    ledger.release(`construction:${project.id}`);
  }
  synchronizeStationDeliveryPackages(project, clock);
  return { delayed: false, payment, progress: project.progress };
}

export function suspendConstruction(project, reason, clock) {
  if (!["contracted", "underConstruction", "inspection"].includes(project.status)) throw new Error("Only an active construction project can be suspended");
  project.resumeStatus = project.status;
  project.status = "suspended";
  project.suspendedAt = clock.minute;
  project.suspensionReason = String(reason || "Player decision");
  project.riskEvents.push({ atMinute: clock.minute, type: "construction-suspended", reason: project.suspensionReason });
  synchronizeStationDeliveryPackages(project, clock);
  return project;
}

export function resumeConstruction(project, clock) {
  if (project.status !== "suspended") throw new Error("Project is not suspended");
  project.status = project.resumeStatus ?? "underConstruction";
  delete project.resumeStatus;
  delete project.suspendedAt;
  delete project.suspensionReason;
  project.riskEvents.push({ atMinute: clock.minute, type: "construction-resumed" });
  synchronizeStationDeliveryPackages(project, clock);
  return project;
}

export function cancelConstruction(project, ledger, clock = { minute: 0 }) {
  if (["available", "cancelled"].includes(project.status)) throw new Error("Project cannot be cancelled");
  ledger.release(`construction:${project.id}`);
  project.status = "cancelled";
  project.cancelledAt = clock.minute;
  project.sunkCost = project.paid;
  synchronizeStationDeliveryPackages(project, clock);
  return project.sunkCost;
}
