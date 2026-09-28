export const CONSTRUCTION_CONTRACTOR_SCHEMA = "transitline.construction-contractor/1";
export const CONSTRUCTION_PACKAGE_CONTRACT_SCHEMA = "transitline.construction-package-contract/1";

const PROCURED_KINDS = new Set(["tunnel", "cutCover", "viaduct", "systems"]);
const EQUIPMENT_BY_KIND = Object.freeze({
  tunnel: "tunnel-boring",
  cutCover: "retaining-wall",
  viaduct: "heavy-lift",
  systems: "rail-systems",
});
export const EQUIPMENT_PLACEMENT_STATUSES = Object.freeze(["feasible", "conditional", "infeasible"]);
export const EQUIPMENT_WORKFRONT_REQUIREMENTS = Object.freeze({
  "tunnel-boring": Object.freeze({ usableAreaSquareMeters: 1_000, minimumWidthMeters: 18, turningSpaceSquareMeters: 250, entryWidthMeters: 6, roadWidthMeters: 5.5, overheadClearanceMeters: 4.5, assemblyAreaSquareMeters: 500, storageAreaSquareMeters: 300, maximumSlopePercent: 3, majorRoad: true }),
  "retaining-wall": Object.freeze({ usableAreaSquareMeters: 600, minimumWidthMeters: 12, turningSpaceSquareMeters: 160, entryWidthMeters: 4, roadWidthMeters: 4.5, overheadClearanceMeters: 4.2, assemblyAreaSquareMeters: 150, storageAreaSquareMeters: 150, maximumSlopePercent: 4, majorRoad: true }),
  "heavy-lift": Object.freeze({ usableAreaSquareMeters: 800, minimumWidthMeters: 16, turningSpaceSquareMeters: 220, entryWidthMeters: 5, roadWidthMeters: 5, overheadClearanceMeters: 4.5, assemblyAreaSquareMeters: 200, storageAreaSquareMeters: 120, maximumSlopePercent: 3, majorRoad: true }),
  "rail-systems": Object.freeze({ usableAreaSquareMeters: 300, minimumWidthMeters: 8, turningSpaceSquareMeters: 80, entryWidthMeters: 3.5, roadWidthMeters: 3.5, overheadClearanceMeters: 3.8, assemblyAreaSquareMeters: 80, storageAreaSquareMeters: 120, maximumSlopePercent: 5, majorRoad: false }),
});
const clone = (value) => structuredClone(value);
const round = (value, digits = 0) => Number(Number(value).toFixed(digits));
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const TEMPLATES = Object.freeze([
  { key: "major-civil", name: "Metropolitan Infrastructure", kinds: ["tunnel", "cutCover", "viaduct"], equipment: { "tunnel-boring": 2, "retaining-wall": 3, "heavy-lift": 2 }, technical: 91, safety: 92, quality: 90, financial: 94, price: 1.06, capacity: 4 },
  { key: "underground", name: "Urban Underground Engineering", kinds: ["tunnel", "cutCover"], equipment: { "tunnel-boring": 3, "retaining-wall": 2 }, technical: 96, safety: 94, quality: 95, financial: 88, price: 1.12, capacity: 3 },
  { key: "viaduct", name: "Regional Bridge & Viaduct", kinds: ["viaduct", "cutCover"], equipment: { "retaining-wall": 1, "heavy-lift": 3 }, technical: 89, safety: 88, quality: 90, financial: 83, price: 0.99, capacity: 3 },
  { key: "systems", name: "Rail Systems Integration", kinds: ["systems"], equipment: { "rail-systems": 4 }, technical: 95, safety: 91, quality: 96, financial: 86, price: 1.08, capacity: 4 },
  { key: "value", name: "Transit Value Construction", kinds: ["cutCover", "viaduct", "systems"], equipment: { "retaining-wall": 2, "heavy-lift": 1, "rail-systems": 2 }, technical: 80, safety: 79, quality: 81, financial: 72, price: 0.91, capacity: 4 },
  { key: "international", name: "East Asia Rail Builders", kinds: ["tunnel", "cutCover", "viaduct", "systems"], equipment: { "tunnel-boring": 1, "retaining-wall": 2, "heavy-lift": 2, "rail-systems": 2 }, technical: 87, safety: 86, quality: 88, financial: 91, price: 1.01, capacity: 5 },
]);

function assertSchedule(schedule) {
  if (schedule?.schema !== "transitline.integrated-construction-schedule/1") throw new Error("A valid integrated construction schedule is required");
}

function requirePackage(schedule, constructionSiteId) {
  const deliveryPackage = schedule.constructionPackages?.find((entry) => entry.constructionSiteId === constructionSiteId);
  if (!deliveryPackage) throw new Error(`Unknown construction site ${constructionSiteId}`);
  return deliveryPackage;
}

function equipmentAvailable(contractor, equipmentType) {
  const total = contractor.equipmentUnits[equipmentType] ?? 0;
  const assigned = contractor.equipmentAssignments.filter((entry) => entry.equipmentType === equipmentType && entry.status === "assigned").length;
  return total - assigned;
}

function packageWeight(schedule, deliveryPackage) {
  const byId = new Map(schedule.tasks.map((entry) => [entry.id, entry]));
  return deliveryPackage.taskIds.reduce((sum, id) => sum + Math.max(1, byId.get(id)?.baselineDurationMonths ?? 1), 0);
}

function allocateAllowance(schedule, packages, budget) {
  const totalWeight = packages.reduce((sum, entry) => sum + packageWeight(schedule, entry), 0);
  let allocated = 0;
  return packages.map((entry, index) => {
    const amount = index === packages.length - 1
      ? round(budget - allocated)
      : round(budget * packageWeight(schedule, entry) / Math.max(1, totalWeight));
    allocated += amount;
    return [entry.constructionSiteId, amount];
  });
}

function contractTerms(model) {
  if (model === "fixed-price") return { priceAdjustmentShare: 0.1, ownerDesignChangeShare: 1, ownerGroundRiskShare: 0.35, liquidatedDamagesMonthlyRate: 0.005, earlyCompletionBonusMonthlyRate: 0.002 };
  if (model === "index-linked") return { priceAdjustmentShare: 0.75, ownerDesignChangeShare: 1, ownerGroundRiskShare: 0.6, liquidatedDamagesMonthlyRate: 0.004, earlyCompletionBonusMonthlyRate: 0.0015 };
  if (model === "target-cost") return { priceAdjustmentShare: 0.5, ownerDesignChangeShare: 0.8, ownerGroundRiskShare: 0.5, liquidatedDamagesMonthlyRate: 0.003, earlyCompletionBonusMonthlyRate: 0.003 };
  throw new Error(`Unknown construction contract model ${model}`);
}

export function assessEquipmentWorkfront(workfront, equipmentType) {
  if (workfront?.schema !== "transitline.construction-workfront-geometry/1" || workfront.contractVersion !== 1) throw new Error("A valid ConstructionWorkfrontGeometry is required");
  const requirements = EQUIPMENT_WORKFRONT_REQUIREMENTS[equipmentType];
  if (!requirements) throw new Error(`Unknown construction equipment type ${equipmentType}`);
  const failures = [];
  const conditions = [];
  const checkMinimum = (field, value, required) => {
    if (!Number.isFinite(value)) conditions.push({ field, reason: workfront.unknownReasons?.[field] ?? "not-verified", required });
    else if (value < required) failures.push({ field, actual: value, required, reason: "below-minimum" });
  };
  checkMinimum("usableAreaSquareMeters", workfront.usableAreaSquareMeters, requirements.usableAreaSquareMeters);
  checkMinimum("minimumWidthMeters", workfront.minimumWidthMeters, requirements.minimumWidthMeters);
  checkMinimum("equipmentAccessFacts.turningSpaceSquareMeters", workfront.equipmentAccessFacts?.turningSpaceSquareMeters, requirements.turningSpaceSquareMeters);
  checkMinimum("equipmentAccessFacts.entryWidthMeters", workfront.equipmentAccessFacts?.entryWidthMeters, requirements.entryWidthMeters);
  checkMinimum("equipmentAccessFacts.roadWidthMeters", workfront.equipmentAccessFacts?.roadWidthMeters, requirements.roadWidthMeters);
  checkMinimum("equipmentAccessFacts.overheadClearanceMeters", workfront.equipmentAccessFacts?.overheadClearanceMeters, requirements.overheadClearanceMeters);
  checkMinimum("stagingFacts.assemblyAreaSquareMeters", workfront.stagingFacts?.assemblyAreaSquareMeters, requirements.assemblyAreaSquareMeters);
  checkMinimum("stagingFacts.storageAreaSquareMeters", workfront.stagingFacts?.storageAreaSquareMeters, requirements.storageAreaSquareMeters);
  if (!Number.isFinite(workfront.maximumSlopePercent)) conditions.push({ field: "maximumSlopePercent", reason: workfront.unknownReasons?.maximumSlopePercent ?? "not-verified", maximum: requirements.maximumSlopePercent });
  else if (workfront.maximumSlopePercent > requirements.maximumSlopePercent) failures.push({ field: "maximumSlopePercent", actual: workfront.maximumSlopePercent, maximum: requirements.maximumSlopePercent, reason: "above-maximum" });
  for (const field of ["intersectedBuildingCount", "waterOverlapCount"]) {
    const value = workfront[field];
    if (!Number.isFinite(value)) conditions.push({ field, reason: workfront.unknownReasons?.[field] ?? "not-verified", maximum: 0 });
    else if (value > 0) failures.push({ field, actual: value, maximum: 0, reason: "physical-obstruction" });
  }
  if (!workfront.linkedAccessCandidateRef) failures.push({ field: "linkedAccessCandidateRef", reason: "no-equipment-access" });
  if (requirements.majorRoad) {
    if (workfront.majorRoadAccessible === null || workfront.majorRoadAccessible === undefined) conditions.push({ field: "majorRoadAccessible", reason: workfront.unknownReasons?.majorRoadAccessible ?? "not-verified", required: true });
    else if (!workfront.majorRoadAccessible) failures.push({ field: "majorRoadAccessible", actual: false, required: true, reason: "no-major-road-access" });
  } else {
    const delivery = workfront.stagingFacts?.deliveryAccess;
    if (delivery === null || delivery === undefined) conditions.push({ field: "stagingFacts.deliveryAccess", reason: workfront.unknownReasons?.["stagingFacts.deliveryAccess"] ?? "not-verified", required: true });
    else if (!delivery) failures.push({ field: "stagingFacts.deliveryAccess", actual: false, required: true, reason: "no-delivery-access" });
  }
  const placementStatus = failures.length ? "infeasible" : conditions.length ? "conditional" : "feasible";
  return {
    workfrontId: workfront.workfrontId,
    constructionSiteId: workfront.constructionSiteId,
    equipmentType,
    placementStatus,
    failures,
    conditions,
    requirements: clone(requirements),
  };
}

export function applyConstructionWorkfront(schedule, workfront, contractors = [], clock = { minute: 0 }) {
  assertSchedule(schedule);
  const deliveryPackage = requirePackage(schedule, workfront?.constructionSiteId);
  const procurement = deliveryPackage.procurement;
  if (!procurement?.equipmentType) throw new Error(`Construction site ${workfront?.constructionSiteId} must prepare contractor procurement first`);
  const assessment = assessEquipmentWorkfront(workfront, procurement.equipmentType);
  procurement.workfrontAssessments ??= [];
  procurement.workfrontAssessments = procurement.workfrontAssessments.filter((entry) => entry.workfrontId !== assessment.workfrontId);
  procurement.workfrontAssessments.push({ ...clone(assessment), assessedAtMinute: clock.minute });
  const contract = procurement.contract;
  if (contract) {
    const fields = { workfrontId: assessment.workfrontId, placementStatus: assessment.placementStatus, placementFailures: clone(assessment.failures), placementConditions: clone(assessment.conditions), placementAssessedAtMinute: clock.minute };
    for (const assignment of contract.equipmentAssignments) Object.assign(assignment, fields);
    const contractor = contractors.find((entry) => entry.id === contract.contractorId);
    for (const assignment of contractor?.equipmentAssignments ?? []) {
      if (assignment.constructionSiteId === deliveryPackage.constructionSiteId && assignment.status === "assigned") Object.assign(assignment, clone(fields));
    }
  }
  return clone(assessment);
}

export function createConstructionContractors(countryId = "JP") {
  return TEMPLATES.map((template, index) => ({
    schema: CONSTRUCTION_CONTRACTOR_SCHEMA,
    contractVersion: 1,
    id: `construction-contractor:${countryId}:${index + 1}`,
    countryId,
    name: template.name,
    packageKinds: [...template.kinds],
    equipmentUnits: clone(template.equipment),
    equipmentAssignments: [],
    technicalScore: template.technical,
    safetyScore: template.safety,
    qualityScore: template.quality,
    financialStrength: template.financial,
    priceFactor: template.price,
    packageCapacity: template.capacity,
    backlog: index % 2,
    completedPackages: 0,
    defaultedPackages: 0,
    claimsHistory: [],
  }));
}

export function prepareConstructionPackageProcurement(schedule, project) {
  assertSchedule(schedule);
  if (schedule.projectId !== project?.id) throw new Error("Construction schedule does not match its project");
  if (!(schedule.constructionPackages?.length > 0)) throw new Error("Construction packages must be configured first");
  if (schedule.contractorProcurementPrepared) return schedule.constructionPackages;
  const civil = schedule.constructionPackages.filter((entry) => ["tunnel", "cutCover", "viaduct"].includes(entry.kind));
  const systems = schedule.constructionPackages.filter((entry) => entry.kind === "systems");
  const civilTaskIds = schedule.tasks.filter((entry) => entry.kind === "segment-civil").map((entry) => entry.id);
  const civilCoverage = new Map(civilTaskIds.map((id) => [id, 0]));
  for (const deliveryPackage of civil) {
    for (const taskId of deliveryPackage.taskIds) civilCoverage.set(taskId, (civilCoverage.get(taskId) ?? 0) + 1);
  }
  const invalidCoverage = [...civilCoverage].filter(([, count]) => count !== 1);
  if (invalidCoverage.length) throw new Error(`Every civil schedule task must belong to exactly one construction package: ${invalidCoverage.map(([id, count]) => `${id}=${count}`).join(", ")}`);
  if (schedule.tasks.some((entry) => entry.kind === "railway-systems") && systems.length === 0) throw new Error("A railway systems construction package is required");
  const allowances = new Map([
    ...allocateAllowance(schedule, civil, project.estimate.guideway),
    ...allocateAllowance(schedule, systems, project.estimate.systems),
  ]);
  for (const deliveryPackage of schedule.constructionPackages) {
    if (!PROCURED_KINDS.has(deliveryPackage.kind)) {
      deliveryPackage.contractSource = "existing-specialist-contract";
      continue;
    }
    const legacyAllowanceP50 = allowances.get(deliveryPackage.constructionSiteId) ?? 0;
    deliveryPackage.procurement = {
      status: "planned",
      equipmentType: EQUIPMENT_BY_KIND[deliveryPackage.kind],
      legacyAllowanceP50,
      legacyAllowanceP90: round(legacyAllowanceP50 * 1.25),
      bids: [],
      ranking: [],
      tenderRound: 0,
      contract: null,
    };
  }
  schedule.contractorProcurementPrepared = true;
  schedule.contractorProcurementRequired = schedule.constructionPackages.some((entry) => PROCURED_KINDS.has(entry.kind));
  schedule.contractorProcurementReady = !schedule.contractorProcurementRequired;
  schedule.contractorProcurementIntegrated = !schedule.contractorProcurementRequired;
  return schedule.constructionPackages;
}

export function tenderConstructionPackage(schedule, constructionSiteId, contractors, rng, { contractModel = "fixed-price", evaluation = "best-value" } = {}, clock = { minute: 0 }) {
  assertSchedule(schedule);
  if (!rng?.next) throw new Error("A deterministic RNG is required");
  const deliveryPackage = requirePackage(schedule, constructionSiteId);
  const procurement = deliveryPackage.procurement;
  if (!procurement || !PROCURED_KINDS.has(deliveryPackage.kind)) throw new Error(`Construction site ${constructionSiteId} uses another contract system`);
  if (!["planned", "retender"].includes(procurement.status)) throw new Error(`Construction package tender cannot start from ${procurement.status}`);
  if (procurement.workfrontAssessments?.length && procurement.workfrontAssessments.every((entry) => entry.placementStatus === "infeasible")) throw new Error("No viable equipment work front is available for this construction package");
  const terms = contractTerms(contractModel);
  const selectedFacts = deliveryPackage.selectedCandidate?.facts ?? null;
  const accessKnown = selectedFacts !== null;
  const spatialUnknowns = deliveryPackage.spatialFacts?.unknown?.length ?? 0;
  const eligible = contractors.filter((contractor) => contractor.packageKinds.includes(deliveryPackage.kind)
    && contractor.backlog < contractor.packageCapacity
    && equipmentAvailable(contractor, procurement.equipmentType) > 0
    && contractor.financialStrength >= 65);
  procurement.tenderRound++;
  procurement.contractModel = contractModel;
  procurement.evaluation = evaluation;
  procurement.terms = terms;
  procurement.bids = eligible.map((contractor) => {
    const workloadFactor = 1 + contractor.backlog * 0.035;
    const uncertaintyPremium = 1 + Math.min(0.18, spatialUnknowns * 0.008) + (accessKnown ? 0 : 0.035);
    const modelFactor = contractModel === "fixed-price" ? 1.06 : contractModel === "index-linked" ? 0.99 : 1.02;
    const noise = 0.97 + rng.next() * 0.07;
    const priceP50 = round(procurement.legacyAllowanceP50 * contractor.priceFactor * workloadFactor * uncertaintyPremium * modelFactor * noise);
    const riskRatio = 1.12 + (100 - contractor.qualityScore) / 250 + spatialUnknowns * 0.003;
    const taskMonths = packageWeight(schedule, deliveryPackage);
    const durationMonths = Math.max(1, Math.ceil(taskMonths * (100 / contractor.technicalScore) * (1 + contractor.backlog * 0.05) * (accessKnown ? 0.97 : 1.05)));
    return {
      id: `construction-bid:${constructionSiteId}:${procurement.tenderRound}:${contractor.id}`,
      contractorId: contractor.id,
      contractModel,
      priceP50,
      priceP90: round(priceP50 * riskRatio),
      durationMonths,
      technicalScore: contractor.technicalScore,
      safetyScore: contractor.safetyScore,
      qualityScore: contractor.qualityScore,
      financialStrength: contractor.financialStrength,
      equipmentType: procurement.equipmentType,
      submittedAtMinute: clock.minute,
    };
  });
  if (!procurement.bids.length) throw new Error("No qualified construction contractor has capacity and equipment");
  const lowest = Math.min(...procurement.bids.map((entry) => entry.priceP50));
  const weights = evaluation === "lowest-price" ? { price: 0.7, technical: 0.12, safety: 0.1, delivery: 0.08 }
    : evaluation === "safety-first" ? { price: 0.3, technical: 0.2, safety: 0.35, delivery: 0.15 }
      : { price: 0.4, technical: 0.25, safety: 0.2, delivery: 0.15 };
  const fastest = Math.min(...procurement.bids.map((entry) => entry.durationMonths));
  procurement.ranking = procurement.bids.map((bid) => {
    const priceScore = lowest / bid.priceP50 * 100;
    const deliveryScore = fastest / bid.durationMonths * 100;
    return {
      ...bid,
      priceScore: round(priceScore, 3),
      deliveryScore: round(deliveryScore, 3),
      totalScore: round(priceScore * weights.price + bid.technicalScore * weights.technical + bid.safetyScore * weights.safety + deliveryScore * weights.delivery, 3),
    };
  }).sort((a, b) => b.totalScore - a.totalScore || a.priceP50 - b.priceP50);
  procurement.status = "tendered";
  procurement.tenderedAtMinute = clock.minute;
  return { constructionSiteId, bidderCount: procurement.bids.length, ranking: clone(procurement.ranking) };
}

export function awardConstructionPackage(schedule, constructionSiteId, contractors, bidId, clock = { minute: 0 }) {
  assertSchedule(schedule);
  const deliveryPackage = requirePackage(schedule, constructionSiteId);
  const procurement = deliveryPackage.procurement;
  if (procurement?.status !== "tendered") throw new Error("Construction package tender has not been evaluated");
  const bid = procurement.ranking.find((entry) => entry.id === (bidId ?? procurement.ranking[0]?.id));
  if (!bid) throw new Error(`Unknown construction bid ${bidId}`);
  const contractor = contractors.find((entry) => entry.id === bid.contractorId);
  if (!contractor || contractor.backlog >= contractor.packageCapacity || equipmentAvailable(contractor, procurement.equipmentType) < 1) throw new Error("Selected construction contractor no longer has capacity or equipment");
  contractor.backlog++;
  const assignment = {
    id: `equipment-assignment:${constructionSiteId}:${procurement.tenderRound}`,
    constructionSiteId,
    equipmentType: procurement.equipmentType,
    status: "assigned",
    assignedAtMinute: clock.minute,
  };
  const preferredWorkfront = [...(procurement.workfrontAssessments ?? [])]
    .filter((entry) => entry.placementStatus !== "infeasible")
    .sort((a, b) => (a.placementStatus === "feasible" ? 0 : 1) - (b.placementStatus === "feasible" ? 0 : 1))[0];
  if (preferredWorkfront) Object.assign(assignment, {
    workfrontId: preferredWorkfront.workfrontId,
    placementStatus: preferredWorkfront.placementStatus,
    placementFailures: clone(preferredWorkfront.failures),
    placementConditions: clone(preferredWorkfront.conditions),
    placementAssessedAtMinute: preferredWorkfront.assessedAtMinute,
  });
  contractor.equipmentAssignments.push(assignment);
  procurement.contract = {
    schema: CONSTRUCTION_PACKAGE_CONTRACT_SCHEMA,
    contractVersion: 1,
    id: `construction-contract:${constructionSiteId}:${procurement.tenderRound}`,
    constructionSiteId,
    contractorId: contractor.id,
    contractModel: procurement.contractModel,
    originalPriceP50: bid.priceP50,
    currentPriceP50: bid.priceP50,
    priceP90: bid.priceP90,
    priceIndexBase: 100,
    lastSettledPriceIndex: 100,
    priceAdjustments: [],
    durationMonths: bid.durationMonths,
    terms: clone(procurement.terms),
    equipmentAssignments: [clone(assignment)],
    status: "awarded",
    awardedAtMinute: clock.minute,
    changeOrders: [],
    claims: [],
  };
  procurement.status = "awarded";
  schedule.contractorProcurementReady = schedule.constructionPackages.filter((entry) => PROCURED_KINDS.has(entry.kind)).every((entry) => entry.procurement?.status === "awarded");
  return clone(procurement.contract);
}

export function integrateConstructionPackageAwards(schedule, project) {
  assertSchedule(schedule);
  if (schedule.projectId !== project?.id) throw new Error("Construction schedule does not match its project");
  const packages = schedule.constructionPackages.filter((entry) => PROCURED_KINDS.has(entry.kind));
  if (!packages.length) return null;
  if (!packages.every((entry) => entry.procurement?.status === "awarded")) throw new Error("Every civil and systems package requires an awarded contractor");
  if (schedule.constructionContractReplacement) return clone(schedule.constructionContractReplacement);
  const legacyP50 = packages.reduce((sum, entry) => sum + entry.procurement.legacyAllowanceP50, 0);
  const legacyP90 = packages.reduce((sum, entry) => sum + entry.procurement.legacyAllowanceP90, 0);
  const awardedP50 = packages.reduce((sum, entry) => sum + entry.procurement.contract.currentPriceP50, 0);
  const awardedP90 = packages.reduce((sum, entry) => sum + entry.procurement.contract.priceP90, 0);
  project.estimate.totalP50 = round(project.estimate.totalP50 - legacyP50 + awardedP50);
  project.estimate.totalP90 = round(project.estimate.totalP90 - legacyP90 + awardedP90);
  const tasks = new Map(schedule.tasks.map((entry) => [entry.id, entry]));
  for (const deliveryPackage of packages) {
    const durationEach = Math.max(1, Math.ceil(deliveryPackage.procurement.contract.durationMonths / deliveryPackage.taskIds.length));
    for (const taskId of deliveryPackage.taskIds) {
      const task = tasks.get(taskId);
      if (task) task.contractDurationMonths = Math.max(task.baselineDurationMonths, task.contractDurationMonths ?? 0, durationEach);
    }
  }
  schedule.constructionContractReplacement = {
    legacyP50: round(legacyP50),
    legacyP90: round(legacyP90),
    awardedP50: round(awardedP50),
    awardedP90: round(awardedP90),
    deltaP50: round(awardedP50 - legacyP50),
    deltaP90: round(awardedP90 - legacyP90),
  };
  schedule.contractorProcurementReady = true;
  schedule.contractorProcurementIntegrated = true;
  return clone(schedule.constructionContractReplacement);
}

function deliveryPackageProgress(schedule, deliveryPackage, project) {
  const tasks = new Map(schedule.tasks.map((entry) => [entry.id, entry]));
  let totalWeight = 0;
  let completedWeight = 0;
  for (const taskId of deliveryPackage.taskIds ?? []) {
    const task = tasks.get(taskId);
    if (!task) continue;
    const weight = Math.max(1, task.baselineDurationMonths ?? task.contractDurationMonths ?? 1);
    totalWeight += weight;
    completedWeight += weight * clamp(Number(task.progress) || 0, 0, 1);
  }
  if (totalWeight > 0) return clamp(completedWeight / totalWeight, 0, 1);
  return clamp(Number(project?.progress) || 0, 0, 1);
}

export function settleConstructionPriceIndex(schedule, project, priceIndex, clock = { minute: 0 }, { sourceEventId = null } = {}) {
  assertSchedule(schedule);
  if (schedule.projectId !== project?.id) throw new Error("Construction schedule does not match its project");
  if (!schedule.contractorProcurementIntegrated) throw new Error("Construction package awards must be integrated before price adjustment");
  if (!Number.isFinite(priceIndex) || priceIndex < 100) throw new Error("Construction price index must be a finite value of at least 100");
  const packages = schedule.constructionPackages.filter((entry) => PROCURED_KINDS.has(entry.kind));
  const adjustments = [];
  let ownerAdjustmentJPY = 0;
  let contractorAbsorbedJPY = 0;

  for (const deliveryPackage of packages) {
    const contract = deliveryPackage.procurement?.contract;
    if (!contract || !["awarded", "active", "suspended"].includes(contract.status)) continue;
    contract.priceIndexBase ??= 100;
    contract.lastSettledPriceIndex ??= contract.priceIndexBase;
    contract.priceAdjustments ??= [];
    if (priceIndex < contract.lastSettledPriceIndex) throw new Error("Construction price index cannot move below its last settlement");
    if (priceIndex === contract.lastSettledPriceIndex) continue;

    const progress = deliveryPackageProgress(schedule, deliveryPackage, project);
    const remainingBaseJPY = round(contract.originalPriceP50 * (1 - progress));
    const indexChangeRate = (priceIndex - contract.lastSettledPriceIndex) / contract.priceIndexBase;
    const grossEscalationJPY = round(remainingBaseJPY * indexChangeRate);
    const ownerShare = clamp(Number(contract.terms?.priceAdjustmentShare) || 0, 0, 1);
    const ownerAmountJPY = round(grossEscalationJPY * ownerShare);
    const contractorAmountJPY = grossEscalationJPY - ownerAmountJPY;
    const adjustment = {
      id: `price-adjustment:${contract.id}:${contract.priceAdjustments.length + 1}`,
      sourceEventId,
      fromIndex: contract.lastSettledPriceIndex,
      toIndex: priceIndex,
      progress: round(progress, 6),
      remainingBaseJPY,
      grossEscalationJPY,
      ownerShare,
      ownerAmountJPY,
      contractorAmountJPY,
      settledAtMinute: clock.minute,
    };
    contract.currentPriceP50 = round(contract.currentPriceP50 + ownerAmountJPY);
    contract.priceP90 = round(contract.priceP90 + ownerAmountJPY);
    contract.lastSettledPriceIndex = priceIndex;
    contract.priceAdjustments.push(adjustment);
    ownerAdjustmentJPY += ownerAmountJPY;
    contractorAbsorbedJPY += contractorAmountJPY;
    adjustments.push({ constructionSiteId: deliveryPackage.constructionSiteId, contractId: contract.id, ...clone(adjustment) });
  }

  if (ownerAdjustmentJPY > 0) {
    project.estimate.totalP50 = round(project.estimate.totalP50 + ownerAdjustmentJPY);
    project.estimate.totalP90 = round(project.estimate.totalP90 + ownerAdjustmentJPY);
    const replacement = schedule.constructionContractReplacement;
    if (replacement) {
      replacement.awardedP50 = round(replacement.awardedP50 + ownerAdjustmentJPY);
      replacement.awardedP90 = round(replacement.awardedP90 + ownerAdjustmentJPY);
      replacement.deltaP50 = round(replacement.awardedP50 - replacement.legacyP50);
      replacement.deltaP90 = round(replacement.awardedP90 - replacement.legacyP90);
    }
  }
  schedule.lastSettledConstructionPriceIndex = priceIndex;
  const settlement = {
    priceIndex,
    sourceEventId,
    settledAtMinute: clock.minute,
    ownerAdjustmentJPY: round(ownerAdjustmentJPY),
    contractorAbsorbedJPY: round(contractorAbsorbedJPY),
    adjustments,
  };
  schedule.constructionPriceSettlements ??= [];
  if (adjustments.length) schedule.constructionPriceSettlements.push(clone(settlement));
  return settlement;
}

export function constructionContractorSummary(schedule) {
  assertSchedule(schedule);
  return (schedule.constructionPackages ?? []).map((deliveryPackage) => ({
    constructionSiteId: deliveryPackage.constructionSiteId,
    kind: deliveryPackage.kind,
    contractSource: deliveryPackage.contractSource ?? (deliveryPackage.procurement ? "package-tender" : null),
    procurementStatus: deliveryPackage.procurement?.status ?? null,
    contractorId: deliveryPackage.procurement?.contract?.contractorId ?? null,
    packageContractId: deliveryPackage.procurement?.contract?.id ?? null,
    equipmentAssignments: (deliveryPackage.procurement?.contract?.equipmentAssignments ?? []).map((assignment) => ({
      ...clone(assignment),
      contractorId: deliveryPackage.procurement.contract.contractorId,
      packageContractId: deliveryPackage.procurement.contract.id,
    })),
    workfrontAssessments: clone(deliveryPackage.procurement?.workfrontAssessments ?? []),
    originalPriceP50: deliveryPackage.procurement?.contract?.originalPriceP50 ?? null,
    currentPriceP50: deliveryPackage.procurement?.contract?.currentPriceP50 ?? null,
    lastSettledPriceIndex: deliveryPackage.procurement?.contract?.lastSettledPriceIndex ?? null,
    priceAdjustments: clone(deliveryPackage.procurement?.contract?.priceAdjustments ?? []),
    durationMonths: deliveryPackage.procurement?.contract?.durationMonths ?? null,
  }));
}

export function releaseConstructionPackageContract(deliveryPackage, contractors, status = "completed", clock = { minute: 0 }) {
  const contract = deliveryPackage?.procurement?.contract;
  if (!contract || !["awarded", "active", "suspended"].includes(contract.status)) return false;
  const contractor = contractors.find((entry) => entry.id === contract.contractorId);
  if (contractor) {
    contractor.backlog = Math.max(0, contractor.backlog - 1);
    for (const assignment of contractor.equipmentAssignments.filter((entry) => entry.constructionSiteId === deliveryPackage.constructionSiteId && entry.status === "assigned")) {
      assignment.status = "released";
      assignment.releasedAtMinute = clock.minute;
    }
    if (status === "completed") contractor.completedPackages++;
    if (status === "defaulted") contractor.defaultedPackages++;
  }
  contract.status = status;
  contract.closedAtMinute = clock.minute;
  return true;
}

export const CONSTRUCTION_PROCURED_KINDS = Object.freeze([...PROCURED_KINDS]);
