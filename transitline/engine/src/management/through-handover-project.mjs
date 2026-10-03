import { TECHNICAL_PROFILES } from "./construction.mjs";

export const THROUGH_HANDOVER_PROJECT_SCHEMA = "transitline.through-handover-project/1";
export const THROUGH_HANDOVER_SITE_SCHEMA = "transitline.through-handover-site-geometry/1";
export const THROUGH_HANDOVER_PRICE_BASE_YEAR = 2026;

const STRUCTURES = Object.freeze({
  "at-grade": { civilJPYPerMeter: 3_000_000, productivityMetersPerMonth: 35, contractorKind: "cutCover", equipmentType: "retaining-wall" },
  "cut-cover": { civilJPYPerMeter: 9_000_000, productivityMetersPerMonth: 18, contractorKind: "cutCover", equipmentType: "retaining-wall" },
  tunnel: { civilJPYPerMeter: 18_000_000, productivityMetersPerMonth: 12, contractorKind: "tunnel", equipmentType: "tunnel-boring" },
  viaduct: { civilJPYPerMeter: 11_000_000, productivityMetersPerMonth: 22, contractorKind: "viaduct", equipmentType: "heavy-lift" },
  bridge: { civilJPYPerMeter: 15_000_000, productivityMetersPerMonth: 14, contractorKind: "viaduct", equipmentType: "heavy-lift" },
});

const clone = (value) => structuredClone(value);
const money = (value) => Math.round(value);
const uniqueText = (values) => [...new Set(values.filter((value) => typeof value === "string" && value))].sort();
const finiteOrNull = (value) => Number.isFinite(Number(value)) ? Number(value) : null;
const countOrNull = (value) => Number.isInteger(Number(value)) && Number(value) >= 0 ? Number(value) : null;

function assertSite(site) {
  if (site?.schema !== THROUGH_HANDOVER_SITE_SCHEMA || site.contractVersion !== 1) {
    throw new Error("ThroughHandoverSiteGeometry v1 is required");
  }
  for (const field of ["throughRouteId", "routeGeometryRevision", "handoverId", "handoverSiteId"]) {
    if (!(typeof site[field] === "string" && site[field])) throw new Error(`Through handover site requires ${field}`);
  }
}

function normalizedFacts(site) {
  assertSite(site);
  const crossing = site.crossings ?? site.spatialFacts?.crossings ?? {};
  const lengthMeters = finiteOrNull(site.connectionLengthMeters ?? site.lengthMeters ?? site.connectionAlignment?.lengthMeters);
  const minimumCurveRadiusMeters = finiteOrNull(site.minimumCurveRadiusMeters ?? site.minCurveRadiusMeters);
  const maximumGradientPermille = finiteOrNull(site.maximumGradientPermille ?? site.maxGradientPermille);
  const intersectedBuildingCount = countOrNull(site.intersectedBuildingCount ?? site.spatialFacts?.intersectedBuildingCount);
  const waterCrossingCount = countOrNull(site.waterCrossingCount ?? crossing.water ?? crossing.waterCount);
  const roadCrossingCount = countOrNull(site.roadCrossingCount ?? crossing.road ?? crossing.roadCount);
  const existingRailwayCrossingCount = countOrNull(site.existingRailwayCrossingCount ?? crossing.existingRailway ?? crossing.railwayCount);
  const unknownReasons = clone(site.unknownReasons ?? {});
  const unknown = uniqueText([
    ...(site.unknown ?? []),
    ...(lengthMeters === null ? ["connectionLengthMeters"] : []),
    ...(minimumCurveRadiusMeters === null ? ["minimumCurveRadiusMeters"] : []),
    ...(maximumGradientPermille === null ? ["maximumGradientPermille"] : []),
    ...(intersectedBuildingCount === null ? ["intersectedBuildingCount"] : []),
    ...(waterCrossingCount === null ? ["waterCrossingCount"] : []),
    ...(roadCrossingCount === null ? ["roadCrossingCount"] : []),
    ...(existingRailwayCrossingCount === null ? ["existingRailwayCrossingCount"] : []),
  ]);
  for (const field of unknown) unknownReasons[field] ??= "not-verified";
  return {
    throughRouteId: site.throughRouteId,
    routeGeometryRevision: site.routeGeometryRevision,
    handoverId: site.handoverId,
    handoverSiteId: site.handoverSiteId,
    fromLegId: site.fromLegId ?? null,
    toLegId: site.toLegId ?? null,
    lengthMeters,
    minimumCurveRadiusMeters,
    maximumGradientPermille,
    intersectedBuildingCount,
    waterCrossingCount,
    roadCrossingCount,
    existingRailwayCrossingCount,
    workAreaCandidateId: site.selectedWorkAreaCandidateId ?? site.workAreaCandidateId ?? null,
    externalTopologyVerified: site.externalTopologyVerified === true ? true : site.externalTopologyVerified === false ? false : null,
    unknown,
    unknownReasons,
    dataQuality: site.dataQuality ?? "unknown",
  };
}

function technicalReview(facts, profile) {
  const violations = [];
  const conditions = [];
  if (!profile) violations.push("technical-profile-not-found");
  if (facts.lengthMeters === null) conditions.push("connectionLengthMeters:not-verified");
  if (facts.minimumCurveRadiusMeters === null) conditions.push("minimumCurveRadiusMeters:not-verified");
  else if (profile && facts.minimumCurveRadiusMeters < profile.minimumCurveRadiusMeters) violations.push("minimum-curve-radius-below-standard");
  if (facts.maximumGradientPermille === null) conditions.push("maximumGradientPermille:not-verified");
  else if (profile && facts.maximumGradientPermille > profile.maxGradientPermille) violations.push("maximum-gradient-above-standard");
  if (facts.externalTopologyVerified === false) violations.push("external-topology-conflict");
  if (facts.externalTopologyVerified === null) conditions.push("external-topology:not-verified");
  if (!facts.workAreaCandidateId) conditions.push("work-area:not-selected");
  return { violations: uniqueText(violations), conditions: uniqueText(conditions) };
}

export function estimateThroughHandoverProject({ site, technicalProfileId, structureType = "at-grade", turnoutCount = 2, countryProfile } = {}) {
  const facts = normalizedFacts(site);
  const structure = STRUCTURES[structureType];
  if (!structure) throw new Error(`Unknown through handover structure ${structureType}`);
  if (!Number.isInteger(turnoutCount) || turnoutCount < 1 || turnoutCount > 8) throw new Error("Through handover turnoutCount must be an integer from 1 to 8");
  if (!countryProfile?.id) throw new Error("Country profile is required");
  const profile = TECHNICAL_PROFILES[technicalProfileId];
  const review = technicalReview(facts, profile);
  const criticalMissing = facts.lengthMeters === null;
  if (criticalMissing) {
    return {
      currency: "JPY", priceBaseYear: THROUGH_HANDOVER_PRICE_BASE_YEAR, technicalProfileId, structureType, turnoutCount,
      spatialFacts: facts, review, estimateAssumptions: null, costBreakdownJPY: null, totalP50JPY: null, totalP90JPY: null,
      phasesMonths: null, durationMonths: null, riskProbability: null,
    };
  }
  const knownUnknowns = facts.unknown.length;
  const estimateAssumptions = {
    intersectedBuildingCount: facts.intersectedBuildingCount ?? 1,
    waterCrossingCount: facts.waterCrossingCount ?? 1,
    roadCrossingCount: facts.roadCrossingCount ?? 1,
    existingRailwayCrossingCount: facts.existingRailwayCrossingCount ?? 1,
  };
  const civilJPY = money(facts.lengthMeters * structure.civilJPYPerMeter);
  const turnoutJPY = turnoutCount * 600_000_000;
  const systemsJPY = 1_200_000_000 + turnoutCount * 180_000_000;
  const crossingsJPY = estimateAssumptions.waterCrossingCount * 750_000_000
    + estimateAssumptions.roadCrossingCount * 180_000_000
    + estimateAssumptions.existingRailwayCrossingCount * 900_000_000;
  const relocationJPY = estimateAssumptions.intersectedBuildingCount * 250_000_000;
  const externalInterfaceJPY = 700_000_000;
  const directJPY = civilJPY + turnoutJPY + systemsJPY + crossingsJPY + relocationJPY + externalInterfaceJPY;
  const designAndApprovalJPY = money(directJPY * 0.14);
  const countryAdjustedJPY = money((directJPY + designAndApprovalJPY) * countryProfile.constructionCostModifier);
  const contingencyRate = Math.min(0.45, 0.15 + knownUnknowns * 0.025);
  const contingencyJPY = money(countryAdjustedJPY * contingencyRate);
  const totalP50JPY = countryAdjustedJPY + contingencyJPY;
  const totalP90JPY = money(totalP50JPY * (1.18 + Math.min(0.22, knownUnknowns * 0.02)));
  const designMonths = 8;
  const permissionMonths = Math.max(6, Math.ceil(countryProfile.approvalMonths * 0.4));
  const constructionMonths = Math.max(6, Math.ceil(facts.lengthMeters / structure.productivityMetersPerMonth));
  const integrationTestingMonths = 3;
  const durationMonths = designMonths + permissionMonths + constructionMonths + integrationTestingMonths;
  const riskProbability = Math.min(0.35, 0.04 * countryProfile.disputeDelayModifier + knownUnknowns * 0.012 + (facts.intersectedBuildingCount ?? 0) * 0.008);
  return {
    currency: "JPY", priceBaseYear: THROUGH_HANDOVER_PRICE_BASE_YEAR, technicalProfileId, structureType, turnoutCount,
    spatialFacts: facts, review,
    estimateAssumptions,
    costBreakdownJPY: { civilJPY, turnoutJPY, systemsJPY, crossingsJPY, relocationJPY, externalInterfaceJPY, designAndApprovalJPY, contingencyJPY },
    totalP50JPY, totalP90JPY,
    phasesMonths: { designMonths, permissionMonths, constructionMonths, integrationTestingMonths }, durationMonths, riskProbability,
    contractorKind: structure.contractorKind, equipmentType: structure.equipmentType,
  };
}

function requiredOwners(site, supplied) {
  return uniqueText(supplied ?? site.requiredInfrastructureOwnerIds ?? site.infrastructureOwnerIds ?? []);
}

export function createThroughHandoverProject({ id, site, technicalProfileId, structureType, turnoutCount, requiredInfrastructureOwnerIds, countryProfile, atMinute = 0 } = {}) {
  if (!(typeof id === "string" && id)) throw new Error("Through handover project requires an id");
  const estimate = estimateThroughHandoverProject({ site, technicalProfileId, structureType, turnoutCount, countryProfile });
  return {
    schema: THROUGH_HANDOVER_PROJECT_SCHEMA,
    contractVersion: 1,
    id,
    throughRouteId: site.throughRouteId,
    routeGeometryRevision: site.routeGeometryRevision,
    handoverId: site.handoverId,
    handoverSiteId: site.handoverSiteId,
    countryId: countryProfile.id,
    ...estimate,
    requiredInfrastructureOwnerIds: requiredOwners(site, requiredInfrastructureOwnerIds),
    permissions: [],
    status: estimate.totalP50JPY === null ? "needs-information" : "proposed",
    createdAtMinute: atMinute,
    tender: null,
    contract: null,
    elapsedConstructionMonths: 0,
    inspectionElapsedMonths: 0,
    progress: 0,
    paidJPY: 0,
    delayMonths: 0,
    riskEvents: [],
  };
}

export function grantThroughHandoverPermission(project, ownerId, atMinute = 0) {
  if (!project.requiredInfrastructureOwnerIds.includes(ownerId)) throw new Error(`Infrastructure owner ${ownerId} is not required`);
  if (!project.permissions.some((entry) => entry.ownerId === ownerId)) project.permissions.push({ ownerId, grantedAtMinute: atMinute });
  project.permissions.sort((a, b) => a.ownerId.localeCompare(b.ownerId));
  if (project.status === "proposed" && project.permissions.length === project.requiredInfrastructureOwnerIds.length) project.status = "permitted";
  return clone(project);
}

function equipmentAvailable(contractor, equipmentType) {
  const total = contractor.equipmentUnits?.[equipmentType] ?? 0;
  const assigned = (contractor.equipmentAssignments ?? []).filter((entry) => entry.equipmentType === equipmentType && entry.status === "assigned").length;
  return total - assigned;
}

export function tenderThroughHandoverProject(project, contractors, rng, { evaluation = "best-value" } = {}, atMinute = 0) {
  if (!rng?.next) throw new Error("A deterministic RNG is required");
  if (project.status === "proposed" && project.requiredInfrastructureOwnerIds.length === 0) project.status = "permitted";
  if (project.status !== "permitted") throw new Error(`Through handover tender cannot start from ${project.status}`);
  if (project.review.violations.length) throw new Error(`Through handover has technical violations: ${project.review.violations.join(", ")}`);
  if (project.spatialFacts.externalTopologyVerified !== true) throw new Error("External topology must be verified before through handover tender");
  const eligible = contractors.filter((entry) => entry.packageKinds?.includes(project.contractorKind)
    && entry.backlog < entry.packageCapacity && equipmentAvailable(entry, project.equipmentType) > 0 && entry.financialStrength >= 65);
  const round = (project.tender?.round ?? 0) + 1;
  const bids = eligible.map((contractor) => {
    const uncertainty = 1 + Math.min(0.2, project.spatialFacts.unknown.length * 0.015);
    const priceP50 = money(project.totalP50JPY * contractor.priceFactor * (1 + contractor.backlog * 0.03) * uncertainty * (0.97 + rng.next() * 0.07));
    const durationMonths = Math.max(6, Math.ceil(project.phasesMonths.constructionMonths * 100 / contractor.technicalScore * (1 + contractor.backlog * 0.04)));
    return { id: `through-handover-bid:${project.id}:${round}:${contractor.id}`, contractorId: contractor.id, priceP50, priceP90: money(priceP50 * 1.25), durationMonths, technicalScore: contractor.technicalScore, safetyScore: contractor.safetyScore };
  });
  if (!bids.length) throw new Error("No qualified through handover contractor has capacity and equipment");
  const low = Math.min(...bids.map((entry) => entry.priceP50));
  const fast = Math.min(...bids.map((entry) => entry.durationMonths));
  const weights = evaluation === "lowest-price" ? [0.7, 0.15, 0.1, 0.05] : [0.4, 0.25, 0.2, 0.15];
  const ranking = bids.map((bid) => ({ ...bid, totalScore: Number((low / bid.priceP50 * 100 * weights[0] + bid.technicalScore * weights[1] + bid.safetyScore * weights[2] + fast / bid.durationMonths * 100 * weights[3]).toFixed(3)) }))
    .sort((a, b) => b.totalScore - a.totalScore || a.priceP50 - b.priceP50);
  project.tender = { round, evaluation, tenderedAtMinute: atMinute, bids, ranking };
  project.status = "tendered";
  return clone(project.tender);
}

export function awardThroughHandoverProject(project, contractors, bidId, { ledger, clock } = {}) {
  if (project.status !== "tendered") throw new Error("Through handover project has not been tendered");
  const bid = project.tender.ranking.find((entry) => entry.id === (bidId ?? project.tender.ranking[0]?.id));
  if (!bid) throw new Error(`Unknown through handover bid ${bidId}`);
  const contractor = contractors.find((entry) => entry.id === bid.contractorId);
  if (!contractor || contractor.backlog >= contractor.packageCapacity || equipmentAvailable(contractor, project.equipmentType) < 1) throw new Error("Selected contractor no longer has capacity or equipment");
  const commitmentId = `through-handover:${project.id}`;
  ledger.commit({ id: commitmentId, atMinute: clock.minute, amount: bid.priceP50, category: "through-handover-construction", reference: project.id });
  const mobilisationJPY = money(bid.priceP50 * 0.1);
  ledger.settle(commitmentId, mobilisationJPY, clock.minute, "Through handover mobilisation");
  contractor.backlog++;
  contractor.equipmentAssignments.push({ id: `equipment-assignment:${project.id}`, throughHandoverProjectId: project.id, equipmentType: project.equipmentType, status: "assigned", assignedAtMinute: clock.minute });
  project.contract = { id: `through-handover-contract:${project.id}:${project.tender.round}`, contractorId: contractor.id, priceP50: bid.priceP50, priceP90: bid.priceP90, constructionMonths: bid.durationMonths, commitmentId, awardedAtMinute: clock.minute, status: "awarded" };
  project.paidJPY = mobilisationJPY;
  project.status = "contracted";
  return clone(project.contract);
}

function releaseContractor(project, contractors, atMinute, completed) {
  const contractor = contractors.find((entry) => entry.id === project.contract?.contractorId);
  if (!contractor || project.contract?.capacityReleased) return;
  contractor.backlog = Math.max(0, contractor.backlog - 1);
  for (const assignment of contractor.equipmentAssignments.filter((entry) => entry.throughHandoverProjectId === project.id && entry.status === "assigned")) {
    assignment.status = "released";
    assignment.releasedAtMinute = atMinute;
  }
  if (completed) contractor.completedPackages++;
  project.contract.capacityReleased = true;
}

export function advanceThroughHandoverProjectMonth(project, { ledger, clock, rng, contractors } = {}) {
  if (!["contracted", "under-construction", "inspection"].includes(project.status)) return { status: project.status, paymentJPY: 0, completed: false };
  if (!rng?.next) throw new Error("Through handover advancement requires deterministic RNG");
  if (project.status === "contracted") {
    project.status = "under-construction";
    project.contract.status = "active";
  }
  if (project.status === "inspection") {
    project.inspectionElapsedMonths++;
    if (project.inspectionElapsedMonths < project.phasesMonths.integrationTestingMonths) return { status: project.status, paymentJPY: 0, completed: false };
    project.status = "available";
    project.availableAtMinute = clock.minute;
    project.contract.status = "completed";
    ledger.release(project.contract.commitmentId);
    releaseContractor(project, contractors, clock.minute, true);
    return { status: project.status, paymentJPY: 0, completed: true };
  }
  if (project.delayMonths > 0) {
    project.delayMonths--;
    return { status: project.status, paymentJPY: 0, completed: false, delayed: true };
  }
  const riskRoll = rng.next();
  if (riskRoll < project.riskProbability) {
    project.delayMonths = 1 + Math.floor(rng.next() * 2);
    project.riskEvents.push({ atMinute: clock.minute, type: "handover-construction-delay", delayMonths: project.delayMonths, roll: riskRoll });
    return { status: project.status, paymentJPY: 0, completed: false, delayed: true };
  }
  project.elapsedConstructionMonths++;
  project.progress = Math.min(1, project.elapsedConstructionMonths / project.contract.constructionMonths);
  const targetPaidJPY = project.progress >= 1 ? project.contract.priceP50 : money(project.contract.priceP50 * (0.1 + 0.9 * project.progress));
  const paymentJPY = Math.max(0, targetPaidJPY - project.paidJPY);
  if (paymentJPY > 0) ledger.settle(project.contract.commitmentId, paymentJPY, clock.minute, "Through handover progress");
  project.paidJPY += paymentJPY;
  if (project.progress >= 1) {
    project.status = "inspection";
    project.inspectionElapsedMonths = 0;
  }
  return { status: project.status, paymentJPY, progress: project.progress, completed: false, delayed: false };
}

export function cancelThroughHandoverProject(project, { ledger, clock, contractors } = {}) {
  if (["available", "cancelled"].includes(project.status)) throw new Error(`Through handover project cannot be cancelled from ${project.status}`);
  if (project.contract?.commitmentId) ledger.release(project.contract.commitmentId);
  if (project.contract) project.contract.status = "cancelled";
  releaseContractor(project, contractors, clock.minute, false);
  project.status = "cancelled";
  project.cancelledAtMinute = clock.minute;
  project.sunkCostJPY = project.paidJPY;
  return clone(project);
}

export function activeThroughHandoverConfirmations(projects) {
  return projects.filter((project) => project?.schema === THROUGH_HANDOVER_PROJECT_SCHEMA && project.status === "available").map((project) => ({
    throughHandoverProjectId: project.id,
    throughRouteId: project.throughRouteId,
    routeGeometryRevision: project.routeGeometryRevision,
    handoverId: project.handoverId,
    handoverSiteId: project.handoverSiteId,
    confirmedAtMinute: project.availableAtMinute,
  }));
}
