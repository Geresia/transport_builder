export const CONSTRUCTION_SITE_GEOMETRY_SCHEMA = "transitline.construction-site-geometry/1";
export const CONSTRUCTION_EXPORT_SCHEMA = "transitline.construction-export/1";
export const CONSTRUCTION_SELECTION_SCHEMA = "transitline.construction-selection/1";

const CIVIL_KINDS = new Set(["tunnel", "cutCover", "viaduct"]);
const MARKER_KINDS = new Set(["incident", "complaint", "material-shortage", "permit-delay", "utility-conflict", "unexpected-ground", "access-blocked"]);
const clone = (value) => structuredClone(value);
const round = (value, digits = 4) => Number(Number(value).toFixed(digits));

function assertSchedule(schedule) {
  if (schedule?.schema !== "transitline.integrated-construction-schedule/1") throw new Error("A valid integrated construction schedule is required");
}

function assertSite(site, planId) {
  if (site?.schema !== CONSTRUCTION_SITE_GEOMETRY_SCHEMA || site.contractVersion !== 1 || !site.constructionSiteId) throw new Error("Invalid ConstructionSiteGeometry");
  if (site.connectedPlanId !== planId) throw new Error(`Construction site ${site.constructionSiteId} belongs to another plan`);
}

function packageTaskIds(schedule, site, depots) {
  if (CIVIL_KINDS.has(site.kind)) {
    const wanted = new Set(site.connectedSegmentIds ?? []);
    const tasks = schedule.tasks.filter((entry) => entry.kind === "segment-civil" && wanted.has(entry.segmentId));
    if (!wanted.size || tasks.length !== wanted.size) throw new Error(`Construction site ${site.constructionSiteId} has an unknown segment connection`);
    return tasks.map((entry) => entry.id);
  }
  if (site.kind === "systems") {
    const entry = schedule.tasks.find((task) => task.kind === "railway-systems");
    if (!entry) throw new Error(`Construction site ${site.constructionSiteId} has no systems task`);
    const scheduleSegments = new Set(schedule.tasks.filter((task) => task.kind === "segment-civil").map((task) => task.segmentId));
    if (!(site.connectedSegmentIds ?? []).length || site.connectedSegmentIds.some((id) => !scheduleSegments.has(id))) throw new Error(`Construction site ${site.constructionSiteId} has an unknown systems segment`);
    return [entry.id];
  }
  if (site.kind === "station") {
    const entry = schedule.tasks.find((task) => task.kind === "station-civil" && task.stationId === site.connectedStationId);
    if (!entry) throw new Error(`Construction site ${site.constructionSiteId} has an unknown station connection`);
    return [entry.id];
  }
  if (site.kind === "depot") {
    const depot = depots.find((entry) => entry.siteId === site.connectedDepotSiteId || entry.assessment?.siteId === site.connectedDepotSiteId);
    const entry = depot && schedule.tasks.find((task) => task.kind === "depot-construction" && task.source.entityId === depot.id);
    if (!entry) throw new Error(`Construction site ${site.constructionSiteId} has an unknown depot connection`);
    return [entry.id];
  }
  throw new Error(`Unsupported construction package kind ${site.kind}`);
}

export function attachConstructionSitePackages(schedule, sites, { depots = [] } = {}) {
  assertSchedule(schedule);
  if (!Array.isArray(sites) || !sites.length) throw new Error("At least one ConstructionSiteGeometry is required");
  const ids = new Set();
  const previous = new Map((schedule.constructionPackages ?? []).map((entry) => [entry.constructionSiteId, entry]));
  const packages = sites.map((site) => {
    assertSite(site, schedule.planId);
    if (ids.has(site.constructionSiteId)) throw new Error(`Duplicate construction site ${site.constructionSiteId}`);
    ids.add(site.constructionSiteId);
    const old = previous.get(site.constructionSiteId);
    return {
      constructionSiteId: site.constructionSiteId,
      kind: site.kind,
      name: site.name ?? null,
      connectedPlanId: site.connectedPlanId,
      connectedSegmentIds: clone(site.connectedSegmentIds ?? []),
      connectedStationId: site.connectedStationId ?? null,
      connectedDepotSiteId: site.connectedDepotSiteId ?? null,
      taskIds: packageTaskIds(schedule, site, depots),
      selectedCandidate: old?.selectedCandidate ? clone(old.selectedCandidate) : null,
      spatialFacts: clone(site),
    };
  });
  schedule.constructionPackages = packages.sort((a, b) => a.constructionSiteId.localeCompare(b.constructionSiteId));
  return schedule.constructionPackages;
}

export function applyConstructionCandidateSelection(schedule, selection) {
  assertSchedule(schedule);
  if (selection?.schema !== CONSTRUCTION_SELECTION_SCHEMA || selection.contractVersion !== 1) throw new Error("Invalid construction candidate selection");
  if (selection.constructionSiteId === null) return null;
  const deliveryPackage = schedule.constructionPackages?.find((entry) => entry.constructionSiteId === selection.constructionSiteId);
  if (!deliveryPackage) throw new Error(`Unknown construction site ${selection.constructionSiteId}`);
  if (!selection.kind || !selection.candidateId || !selection.facts) throw new Error("Construction candidate selection is incomplete");
  deliveryPackage.selectedCandidate = clone({ kind: selection.kind, candidateId: selection.candidateId, facts: selection.facts });
  return clone(deliveryPackage.selectedCandidate);
}

function reportStatus(tasks, schedule) {
  if (tasks.some((entry) => entry.status === "cancelled")) return "cancelled";
  if (tasks.some((entry) => entry.status === "suspended")) return "suspended";
  if (tasks.every((entry) => entry.status === "complete")) return "available";
  if (schedule.sourceProjectStatus === "inspection" && tasks.some((entry) => ["active", "delayed"].includes(entry.status))) return "inspection";
  if (tasks.some((entry) => ["active", "delayed"].includes(entry.status))) return "underConstruction";
  return "estimated";
}

export function constructionPackageReports(schedule) {
  assertSchedule(schedule);
  const taskById = new Map(schedule.tasks.map((entry) => [entry.id, entry]));
  const reports = {};
  for (const deliveryPackage of schedule.constructionPackages ?? []) {
    const tasks = deliveryPackage.taskIds.map((id) => taskById.get(id)).filter(Boolean);
    const totalWeight = tasks.reduce((sum, entry) => sum + Math.max(1, entry.currentDurationMonths ?? entry.baselineDurationMonths ?? 1), 0);
    const progress = totalWeight ? tasks.reduce((sum, entry) => sum + entry.progress * Math.max(1, entry.currentDurationMonths ?? entry.baselineDurationMonths ?? 1), 0) / totalWeight : 0;
    const delayMonths = Math.max(0, ...tasks.map((entry) => entry.delayMonths ?? entry.extraDelayMonths ?? 0));
    reports[deliveryPackage.constructionSiteId] = {
      constructionSiteId: deliveryPackage.constructionSiteId,
      kind: deliveryPackage.kind,
      status: reportStatus(tasks, schedule),
      progress: round(progress),
      delayMonths,
      critical: tasks.some((entry) => entry.critical),
      taskIds: clone(deliveryPackage.taskIds),
      procurementStatus: deliveryPackage.procurement?.status ?? null,
      contractorContractStatus: deliveryPackage.procurement?.contract?.status ?? null,
      packageContractId: deliveryPackage.procurement?.contract?.id ?? null,
      contractorId: deliveryPackage.procurement?.contract?.contractorId ?? null,
      equipmentAssignments: clone(deliveryPackage.procurement?.contract?.equipmentAssignments ?? []),
    };
  }
  return reports;
}

export function mergeConstructionPackageReports(schedules) {
  const reports = {};
  for (const schedule of schedules ?? []) {
    for (const [id, report] of Object.entries(constructionPackageReports(schedule))) {
      if (reports[id]) throw new Error(`Construction site ${id} is linked to more than one schedule`);
      reports[id] = report;
    }
  }
  return reports;
}

export function validateConstructionMarker(input, schedules) {
  if (!MARKER_KINDS.has(input?.kind)) throw new Error(`Unknown construction marker kind ${input?.kind}`);
  if (!(schedules ?? []).some((schedule) => schedule.constructionPackages?.some((entry) => entry.constructionSiteId === input.constructionSiteId))) {
    throw new Error(`Unknown construction site ${input?.constructionSiteId}`);
  }
  if (input.location !== undefined && input.location !== null && (!Array.isArray(input.location) || input.location.length !== 2 || !input.location.every(Number.isFinite))) {
    throw new Error("Construction marker location must be [longitude, latitude]");
  }
  return true;
}
