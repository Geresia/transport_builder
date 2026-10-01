export const STATION_DELIVERY_SCHEMA = "transitline.station-delivery-package/1";

const round = (value, digits = 0) => Number(value.toFixed(digits));

const CONTRACTOR_TEMPLATES = Object.freeze([
  { key: "civil-a", name: "Kanto Civil Engineering", methods: ["surface", "elevated", "cut-cover"], technical: 86, safety: 91, priceFactor: 1.02, capacity: 3 },
  { key: "underground-a", name: "Metropolitan Underground Works", methods: ["cut-cover", "mined-cavern", "deep-mined"], technical: 94, safety: 94, priceFactor: 1.1, capacity: 2 },
  { key: "value-a", name: "Regional Transit Construction", methods: ["surface", "elevated", "cut-cover"], technical: 78, safety: 82, priceFactor: 0.94, capacity: 3 },
  { key: "systems-a", name: "Urban Rail Integration", methods: ["elevated", "cut-cover", "mined-cavern"], technical: 90, safety: 88, priceFactor: 1.05, capacity: 2 },
  { key: "deep-a", name: "Deep Structure Partners", methods: ["mined-cavern", "deep-mined"], technical: 97, safety: 96, priceFactor: 1.16, capacity: 2 },
  { key: "general-a", name: "East Asia Infrastructure", methods: ["surface", "elevated", "cut-cover", "mined-cavern", "deep-mined"], technical: 83, safety: 86, priceFactor: 0.99, capacity: 4 },
]);

function assertPackage(deliveryPackage) {
  if (!deliveryPackage || deliveryPackage.schema !== STATION_DELIVERY_SCHEMA || deliveryPackage.contractVersion !== 1) throw new Error("StationDeliveryPackage v1 is required");
}

export function createStationContractors(countryId = "JP") {
  return CONTRACTOR_TEMPLATES.map((template, index) => ({
    id: `station-contractor:${countryId}:${index + 1}`,
    countryId,
    name: template.name,
    methodSpecialties: [...template.methods],
    technicalScore: template.technical,
    safetyScore: template.safety,
    priceFactor: template.priceFactor,
    packageCapacity: template.capacity,
    backlog: index % 2,
    completedPackages: 0,
  }));
}

export function createStationDeliveryPackage({ id, adaptation, constructionEstimate } = {}) {
  if (!id) throw new Error("Station delivery package id is required");
  if (!adaptation?.stationPlan || !adaptation?.accessPlan || !adaptation?.constructionContext) throw new Error("Station site adaptation is required");
  if (!constructionEstimate?.costs?.totalP50 || !constructionEstimate?.schedule?.durationMonths) throw new Error("Station construction estimate is required");
  if (constructionEstimate.stationPlanId !== adaptation.stationPlan.id) throw new Error("Construction estimate does not match station plan");
  return {
    schema: STATION_DELIVERY_SCHEMA,
    contractVersion: 1,
    id,
    stationPlanId: adaptation.stationPlan.id,
    stationSiteId: adaptation.stationSiteId,
    connectedPlanId: adaptation.connectedPlanId,
    connectedStationId: adaptation.connectedStationId,
    methodId: constructionEstimate.methodId,
    status: "designed",
    design: structuredClone(adaptation),
    estimate: structuredClone(constructionEstimate),
    unresolvedViolations: structuredClone(constructionEstimate.violations ?? []),
    unresolvedConditions: structuredClone(constructionEstimate.conditions ?? []),
    conditionResolutions: [],
    bids: [],
    ranking: [],
    awardedBid: null,
    designRevision: 0,
    geometryRevision: `station-design:${id}:0`,
    designChanges: [],
    progress: 0,
    paidAllocation: 0,
    statusHistory: [{ status: "designed", atMinute: 0 }],
  };
}

export function resolveStationDeliveryConditions(deliveryPackage, resolutions = []) {
  assertPackage(deliveryPackage);
  if (deliveryPackage.status !== "designed") throw new Error("Conditions can only be resolved during station design");
  const byCode = new Map(resolutions.map((entry) => [entry.code, entry]));
  for (const condition of deliveryPackage.unresolvedConditions) {
    const resolution = byCode.get(condition.code);
    if (!resolution?.action) continue;
    deliveryPackage.conditionResolutions.push({
      code: condition.code,
      action: String(resolution.action),
      addedCostJpy: Number.isFinite(resolution.addedCostJpy) ? Math.max(0, resolution.addedCostJpy) : 0,
      addedMonths: Number.isFinite(resolution.addedMonths) ? Math.max(0, resolution.addedMonths) : 0,
    });
  }
  const resolved = new Set(deliveryPackage.conditionResolutions.map((entry) => entry.code));
  deliveryPackage.unresolvedConditions = deliveryPackage.unresolvedConditions.filter((entry) => !resolved.has(entry.code));
  return deliveryPackage;
}

export function tenderStationDelivery(deliveryPackage, contractors, rng, clock = { minute: 0 }) {
  assertPackage(deliveryPackage);
  if (deliveryPackage.status !== "designed") throw new Error("Station package is not ready for tender");
  if (deliveryPackage.unresolvedViolations.length) throw new Error("Station design has unresolved violations");
  if (deliveryPackage.unresolvedConditions.length) throw new Error("Station design has unresolved conditions");
  const addedCost = deliveryPackage.conditionResolutions.reduce((total, entry) => total + entry.addedCostJpy, 0);
  const addedMonths = deliveryPackage.conditionResolutions.reduce((total, entry) => total + entry.addedMonths, 0);
  const baseCost = deliveryPackage.estimate.costs.totalP50 + addedCost;
  const baseDuration = deliveryPackage.estimate.schedule.durationP90Months + addedMonths;
  const eligible = contractors.filter((contractor) => contractor.methodSpecialties.includes(deliveryPackage.methodId) && contractor.backlog < contractor.packageCapacity);
  deliveryPackage.bids = eligible.map((contractor) => {
    const noise = 0.97 + rng.next() * 0.08;
    const workload = 1 + contractor.backlog * 0.025;
    const priceP50 = round(baseCost * contractor.priceFactor * workload * noise);
    const uncertaintyRatio = deliveryPackage.estimate.costs.totalP90 / deliveryPackage.estimate.costs.totalP50;
    return {
      id: `station-bid:${deliveryPackage.id}:${contractor.id}`,
      contractorId: contractor.id,
      priceP50,
      priceP90: round(priceP50 * uncertaintyRatio * (1 + Math.max(0, 90 - contractor.safetyScore) / 500)),
      durationMonths: Math.ceil(baseDuration * (1 + contractor.backlog * 0.04) * (100 / contractor.technicalScore)),
      technicalScore: contractor.technicalScore,
      safetyScore: contractor.safetyScore,
      submittedAt: clock.minute,
    };
  });
  if (!deliveryPackage.bids.length) throw new Error("No qualified station contractor has capacity");
  const lowest = Math.min(...deliveryPackage.bids.map((bid) => bid.priceP50));
  deliveryPackage.ranking = deliveryPackage.bids.map((bid) => ({
    ...bid,
    priceScore: round(lowest / bid.priceP50 * 100, 3),
    totalScore: round(lowest / bid.priceP50 * 50 + bid.technicalScore * 0.3 + bid.safetyScore * 0.2, 3),
  })).sort((a, b) => b.totalScore - a.totalScore || a.priceP50 - b.priceP50);
  deliveryPackage.status = "tendered";
  deliveryPackage.statusHistory.push({ status: "tendered", atMinute: clock.minute });
  return { bidderCount: deliveryPackage.bids.length, ranking: structuredClone(deliveryPackage.ranking) };
}

export function awardStationDelivery(deliveryPackage, contractors, bidId = deliveryPackage?.ranking?.[0]?.id, clock = { minute: 0 }) {
  assertPackage(deliveryPackage);
  if (deliveryPackage.status !== "tendered") throw new Error("Station package tender has not been evaluated");
  const bid = deliveryPackage.ranking.find((entry) => entry.id === bidId);
  if (!bid) throw new Error(`Unknown station bid ${bidId}`);
  const contractor = contractors.find((entry) => entry.id === bid.contractorId);
  if (!contractor || contractor.backlog >= contractor.packageCapacity) throw new Error("Selected contractor no longer has capacity");
  contractor.backlog++;
  deliveryPackage.awardedBid = structuredClone(bid);
  deliveryPackage.status = "awarded";
  deliveryPackage.statusHistory.push({ status: "awarded", atMinute: clock.minute });
  return deliveryPackage.awardedBid;
}

function legacyAllInP50(directCost, systemsCostFactor) {
  const withSystems = directCost * (1 + systemsCostFactor);
  return withSystems * 1.09 * 1.2;
}

export function integrateStationDeliveryPackages(project, deliveryPackages, { allowPartial = false } = {}) {
  if (!project || !["estimated", "approved"].includes(project.status)) throw new Error("Station packages must be integrated before construction contract");
  const expectedIds = new Set(project.planGeometry.stationCandidates.map((station) => station.id));
  const packageIds = new Set(deliveryPackages.map((entry) => entry.connectedStationId));
  const coverageComplete = packageIds.size === expectedIds.size && [...expectedIds].every((id) => packageIds.has(id));
  if (!allowPartial && !coverageComplete) throw new Error("Every planned station requires one awarded delivery package");
  if (packageIds.size !== deliveryPackages.length) throw new Error("Duplicate station delivery package");
  for (const deliveryPackage of deliveryPackages) {
    assertPackage(deliveryPackage);
    if (deliveryPackage.status !== "awarded") throw new Error(`Station package ${deliveryPackage.id} has not been awarded`);
    if (!expectedIds.has(deliveryPackage.connectedStationId)) throw new Error(`Station package ${deliveryPackage.id} does not belong to this project`);
    if (deliveryPackage.connectedPlanId && deliveryPackage.connectedPlanId !== project.planId) throw new Error(`Station package ${deliveryPackage.id} is connected to a different plan`);
  }
  const systemsFactor = project.planGeometry.stationCandidates.length
    ? (project.estimate.systems / Math.max(1, project.estimate.guideway + project.estimate.stations))
    : 0.18;
  let legacyP50 = 0;
  let legacyP90 = 0;
  let awardedP50 = 0;
  let awardedP90 = 0;
  for (const deliveryPackage of deliveryPackages) {
    const item = project.estimate.stationItems.find((entry) => entry.stationId === deliveryPackage.connectedStationId);
    if (!item) throw new Error(`No legacy station allowance for ${deliveryPackage.connectedStationId}`);
    const oldP50 = legacyAllInP50(item.directCost, systemsFactor);
    legacyP50 += oldP50;
    legacyP90 += oldP50 * 1.25;
    awardedP50 += deliveryPackage.awardedBid.priceP50;
    awardedP90 += deliveryPackage.awardedBid.priceP90;
  }
  project.estimate.totalP50 = round(project.estimate.totalP50 - legacyP50 + awardedP50);
  project.estimate.totalP90 = round(project.estimate.totalP90 - legacyP90 + awardedP90);
  project.estimate.durationMonths = Math.max(project.estimate.durationMonths, ...deliveryPackages.map((entry) => entry.awardedBid.durationMonths));
  project.estimate.stationDetailReplacement = { legacyP50: round(legacyP50), legacyP90: round(legacyP90), awardedP50: round(awardedP50), awardedP90: round(awardedP90), deltaP50: round(awardedP50 - legacyP50), deltaP90: round(awardedP90 - legacyP90) };
  project.stationDeliveryPackages = structuredClone(deliveryPackages);
  project.stationPackageCoverageComplete = coverageComplete;
  project.stationDeliveryReady = false;
  return project.estimate.stationDetailReplacement;
}

export function synchronizeStationDeliveryPackages(project, clock = { minute: 0 }) {
  if (!project?.stationDeliveryPackages?.length) return [];
  const target = project.status === "cancelled" ? "cancelled"
    : project.status === "suspended" ? "suspended"
      : project.status === "available" ? "available"
        : project.status === "inspection" ? "testing"
          : ["contracted", "underConstruction"].includes(project.status) ? "underConstruction"
            : "awarded";
  for (const deliveryPackage of project.stationDeliveryPackages) {
    if (deliveryPackage.status !== target) {
      deliveryPackage.status = target;
      deliveryPackage.statusHistory.push({ status: target, atMinute: clock.minute });
    }
    deliveryPackage.progress = target === "available" ? 1 : target === "testing" ? Math.max(0.9, project.progress) : target === "underConstruction" ? project.progress : deliveryPackage.progress;
    deliveryPackage.paidAllocation = round(project.paid * deliveryPackage.awardedBid.priceP50 / project.estimate.totalP50);
  }
  project.stationDeliveryReady = project.stationDeliveryPackages.every((entry) => entry.status === "available");
  return project.stationDeliveryPackages;
}

export function stationDeliveryReadiness(project) {
  if (!project?.stationDeliveryPackages?.length) return { ready: true, reasons: [], packages: [] };
  const reasons = project.stationPackageCoverageComplete ? [] : ["Not every planned station has a delivery package"];
  reasons.push(...project.stationDeliveryPackages.filter((entry) => entry.status !== "available").map((entry) => `Station package ${entry.id} is ${entry.status}`));
  return { ready: reasons.length === 0, reasons, packages: project.stationDeliveryPackages.map((entry) => ({ id: entry.id, stationPlanId: entry.stationPlanId, status: entry.status, progress: entry.progress })) };
}
