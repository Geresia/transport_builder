export const CONSTRUCTION_CONTRACTOR_SCHEMA = "transitline.construction-contractor/1";
export const CONSTRUCTION_PACKAGE_CONTRACT_SCHEMA = "transitline.construction-package-contract/1";

const PROCURED_KINDS = new Set(["tunnel", "cutCover", "viaduct", "systems"]);
const EQUIPMENT_BY_KIND = Object.freeze({
  tunnel: "tunnel-boring",
  cutCover: "retaining-wall",
  viaduct: "heavy-lift",
  systems: "rail-systems",
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

export function constructionContractorSummary(schedule) {
  assertSchedule(schedule);
  return (schedule.constructionPackages ?? []).map((deliveryPackage) => ({
    constructionSiteId: deliveryPackage.constructionSiteId,
    kind: deliveryPackage.kind,
    contractSource: deliveryPackage.contractSource ?? (deliveryPackage.procurement ? "package-tender" : null),
    procurementStatus: deliveryPackage.procurement?.status ?? null,
    contractorId: deliveryPackage.procurement?.contract?.contractorId ?? null,
    packageContractId: deliveryPackage.procurement?.contract?.id ?? null,
    equipmentAssignments: clone(deliveryPackage.procurement?.contract?.equipmentAssignments ?? []),
    originalPriceP50: deliveryPackage.procurement?.contract?.originalPriceP50 ?? null,
    currentPriceP50: deliveryPackage.procurement?.contract?.currentPriceP50 ?? null,
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
