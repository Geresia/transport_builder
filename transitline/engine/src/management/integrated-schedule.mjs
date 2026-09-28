export const INTEGRATED_SCHEDULE_SCHEMA = "transitline.integrated-construction-schedule/1";
export const SCHEDULE_MONTH_MINUTES = 30 * 1440;

const round = (value, digits = 3) => Number(Number(value).toFixed(digits));
const clone = (value) => structuredClone(value);

function positiveDuration(value, fallback = 1) {
  return Number.isFinite(value) && value >= 0 ? Math.max(0, Math.ceil(value)) : fallback;
}

function segmentDurationMonths(segment) {
  const productivity = ["shield", "deep"].includes(segment.structureHint) ? 0.15
    : segment.structureHint === "cut-cover" ? 0.12
      : 0.42;
  return Math.max(1, Math.ceil((segment.lengthMeters ?? 0) / 1000 / productivity));
}

function task(id, name, kind, durationMonths, dependencies, source, extra = {}) {
  return {
    id,
    name,
    kind,
    dependencies: [...new Set(dependencies)],
    source: clone(source),
    baselineDurationMonths: positiveDuration(durationMonths, 1),
    currentDurationMonths: positiveDuration(durationMonths, 1),
    extraDelayMonths: 0,
    progress: 0,
    status: "pending",
    actualStartMonth: null,
    actualFinishMonth: null,
    ...clone(extra),
  };
}

function topologicalOrder(tasks) {
  const byId = new Map(tasks.map((entry) => [entry.id, entry]));
  if (byId.size !== tasks.length) throw new Error("Integrated schedule task ids must be unique");
  for (const entry of tasks) {
    for (const dependency of entry.dependencies) {
      if (!byId.has(dependency)) throw new Error(`Schedule task ${entry.id} has unknown dependency ${dependency}`);
      if (dependency === entry.id) throw new Error(`Schedule task ${entry.id} cannot depend on itself`);
    }
  }
  const ordered = [];
  const remaining = new Set(byId.keys());
  while (remaining.size) {
    const ready = tasks.filter((entry) => remaining.has(entry.id) && entry.dependencies.every((id) => !remaining.has(id)));
    if (!ready.length) throw new Error("Integrated schedule dependencies contain a cycle");
    for (const entry of ready) {
      ordered.push(entry);
      remaining.delete(entry.id);
    }
  }
  return ordered;
}

function applyBaseline(tasks) {
  const finish = new Map();
  for (const entry of topologicalOrder(tasks)) {
    entry.baselineStartMonth = Math.max(0, ...entry.dependencies.map((id) => finish.get(id) ?? 0));
    entry.baselineFinishMonth = entry.baselineStartMonth + entry.baselineDurationMonths;
    finish.set(entry.id, entry.baselineFinishMonth);
  }
}

function projectPhaseState(project, phaseId) {
  const phase = project?.tasks?.find((entry) => entry.id === phaseId);
  const progress = Math.max(0, Math.min(1, phase?.progress ?? (project?.status === "available" ? 1 : 0)));
  const status = project?.status === "cancelled" ? "cancelled"
    : project?.status === "suspended" && progress < 1 ? "suspended"
      : progress >= 1 ? "complete"
        : progress > 0 ? "active" : "pending";
  return { progress, status, durationMonths: null };
}

function sourceState(entry, entities) {
  const source = entry.source;
  if (source.type === "project-phase") return projectPhaseState(entities.project, source.phaseId);
  if (source.type === "station-package") {
    const item = entities.stationPackages.find((candidate) => candidate.id === source.entityId);
    if (!item) return { progress: 0, status: "missing", durationMonths: null };
    const progress = Math.max(0, Math.min(1, item.progress ?? (item.status === "available" ? 1 : 0)));
    const status = item.status === "available" ? "complete"
      : item.status === "cancelled" ? "cancelled"
        : item.status === "suspended" ? "suspended"
          : ["underConstruction", "testing"].includes(item.status) ? "active" : "pending";
    return { progress, status, durationMonths: item.awardedBid?.durationMonths ?? item.estimate?.schedule?.durationP90Months ?? null };
  }
  if (source.type === "depot") {
    const item = entities.depots.find((candidate) => candidate.id === source.entityId);
    if (!item) return { progress: 0, status: "missing", durationMonths: null };
    const progress = Math.max(0, Math.min(1, item.progress ?? (item.status === "secured" ? 1 : 0)));
    const status = item.status === "secured" ? "complete"
      : item.status === "cancelled" ? "cancelled"
        : item.status === "suspended" ? "suspended"
          : item.status === "underConstruction" ? "active" : "pending";
    return { progress, status, durationMonths: item.assessment?.schedule?.durationMonths ?? null };
  }
  if (source.type === "vehicle-order") {
    const item = entities.vehicleOrders.find((candidate) => candidate.id === source.entityId);
    if (!item) return { progress: 0, status: "missing", durationMonths: null };
    const progress = item.stage === "accepted" ? 1 : Math.max(0, Math.min(1, (item.elapsedMonths ?? 0) / Math.max(1, item.productionMonths ?? 1)));
    const status = item.stage === "accepted" ? "complete" : item.stage === "cancelled" ? "cancelled" : progress > 0 ? "active" : "pending";
    return { progress, status, durationMonths: item.productionMonths ?? null };
  }
  return { progress: 0, status: "pending", durationMonths: null };
}

function markCriticalChain(tasks, terminalId) {
  for (const entry of tasks) entry.critical = false;
  const byId = new Map(tasks.map((entry) => [entry.id, entry]));
  const visit = (id) => {
    const entry = byId.get(id);
    if (!entry || entry.critical) return;
    entry.critical = true;
    const latest = Math.max(-Infinity, ...entry.dependencies.map((dependency) => byId.get(dependency)?.forecastFinishMonth ?? -Infinity));
    for (const dependency of entry.dependencies) {
      if ((byId.get(dependency)?.forecastFinishMonth ?? -Infinity) === latest) visit(dependency);
    }
  };
  visit(terminalId);
}

function refreshForecast(schedule, entities, clock) {
  const currentMonth = Math.max(0, Math.floor((clock.minute - schedule.createdAtMinute) / SCHEDULE_MONTH_MINUTES));
  schedule.currentMonth = currentMonth;
  schedule.sourceProjectStatus = entities.project.status;
  const finish = new Map();
  const byId = new Map(schedule.tasks.map((entry) => [entry.id, entry]));
  for (const entry of topologicalOrder(schedule.tasks)) {
    const dependencyEntries = entry.dependencies.map((id) => byId.get(id));
    const dependenciesComplete = dependencyEntries.every((dependency) => dependency.status === "complete");
    if (entry.kind === "opening-readiness") {
      entry.progress = dependenciesComplete ? 1 : 0;
      entry.status = entry.progress === 1 ? "complete" : dependencyEntries.some((dependency) => dependency.status === "cancelled") ? "cancelled" : "pending";
      entry.currentDurationMonths = 0;
    } else {
      const state = sourceState(entry, entities);
      entry.progress = round(state.progress);
      entry.status = state.status;
      entry.currentDurationMonths = Math.max(entry.baselineDurationMonths, entry.contractDurationMonths ?? 0, positiveDuration(state.durationMonths, entry.baselineDurationMonths));
      if (entry.dependencies.length && !dependenciesComplete && ["active", "complete"].includes(entry.status)) {
        entry.progress = 0;
        entry.status = "blocked";
      }
      if (!["cancelled", "missing"].includes(entry.status) && Number.isFinite(entry.notBeforeFinishMonth) && currentMonth < entry.notBeforeFinishMonth) {
        entry.progress = Math.min(entry.progress, 0.999);
        entry.status = "delayed";
      }
    }
    if (entry.progress > 0 && entry.actualStartMonth === null) {
      const inferredElapsed = Math.floor(entry.currentDurationMonths * entry.progress);
      entry.actualStartMonth = Math.max(0, currentMonth - inferredElapsed);
    }
    if (entry.status === "complete" && entry.actualFinishMonth === null) entry.actualFinishMonth = currentMonth;
    const dependencyFinish = Math.max(0, ...entry.dependencies.map((id) => finish.get(id) ?? 0));
    entry.forecastStartMonth = entry.actualStartMonth ?? Math.max(entry.baselineStartMonth, dependencyFinish);
    if (entry.status === "complete") {
      entry.forecastFinishMonth = entry.actualFinishMonth;
    } else if (["cancelled", "missing"].includes(entry.status)) {
      entry.forecastFinishMonth = null;
    } else if (entry.progress > 0) {
      const remaining = Math.max(1, Math.ceil(entry.currentDurationMonths * (1 - entry.progress))) + entry.extraDelayMonths;
      entry.forecastFinishMonth = Math.max(dependencyFinish, currentMonth + remaining);
    } else {
      entry.forecastStartMonth = Math.max(entry.baselineStartMonth, dependencyFinish);
      entry.forecastFinishMonth = entry.forecastStartMonth + entry.currentDurationMonths + entry.extraDelayMonths;
    }
    if (Number.isFinite(entry.forecastFinishMonth) && Number.isFinite(entry.notBeforeFinishMonth)) entry.forecastFinishMonth = Math.max(entry.forecastFinishMonth, entry.notBeforeFinishMonth);
    entry.delayMonths = entry.forecastFinishMonth === null ? null : Math.max(0, entry.forecastFinishMonth - entry.baselineFinishMonth);
    finish.set(entry.id, entry.forecastFinishMonth ?? Number.POSITIVE_INFINITY);
  }
  const opening = byId.get(schedule.openingTaskId);
  markCriticalChain(schedule.tasks, schedule.openingTaskId);
  schedule.baselineOpeningMonth = opening.baselineFinishMonth;
  schedule.forecastOpeningMonth = Number.isFinite(opening.forecastFinishMonth) ? opening.forecastFinishMonth : null;
  schedule.forecastOpeningMinute = schedule.forecastOpeningMonth === null ? null : schedule.createdAtMinute + schedule.forecastOpeningMonth * SCHEDULE_MONTH_MINUTES;
  schedule.delayMonths = schedule.forecastOpeningMonth === null ? null : Math.max(0, schedule.forecastOpeningMonth - schedule.baselineOpeningMonth);
  schedule.ready = opening.status === "complete";
  schedule.status = entities.project.status === "cancelled" ? "cancelled"
    : schedule.ready ? "ready"
      : entities.project.status === "suspended" ? "suspended" : "active";
  schedule.blockers = schedule.tasks
    .filter((entry) => entry.id !== schedule.openingTaskId && entry.status !== "complete")
    .map((entry) => ({ taskId: entry.id, name: entry.name, kind: entry.kind, status: entry.status, critical: entry.critical, forecastFinishMonth: Number.isFinite(entry.forecastFinishMonth) ? entry.forecastFinishMonth : null }));
  schedule.updatedAtMinute = clock.minute;
  return schedule;
}

export function createIntegratedConstructionSchedule({ id, project, stationPackages = [], depots = [], vehicleOrders = [], clock = { minute: 0 }, approvalMonths = 12 } = {}) {
  if (!project?.id || !project?.planGeometry) throw new Error("Construction project is required for an integrated schedule");
  if (["available", "cancelled"].includes(project.status)) throw new Error(`Cannot create an integrated schedule for a ${project.status} project`);
  if (!depots.length) throw new Error("An integrated schedule requires at least one depot");
  if (!vehicleOrders.length) throw new Error("An integrated schedule requires at least one vehicle order");
  const scheduleId = id ?? `schedule:${project.id}`;
  const designId = `design:${project.id}`;
  const tasks = [task(designId, "설계·인허가", "design-approval", approvalMonths, [], { type: "project-phase", entityId: project.id, phaseId: "design" })];

  const fronts = Math.max(1, project.estimate?.parallelCivilFronts ?? 1);
  const priorByFront = new Map();
  const civilIds = [];
  for (const [index, segment] of (project.planGeometry.segments ?? []).entries()) {
    const front = index % fronts;
    const segmentKey = segment.id ?? `${segment.from}-${segment.to}-${index + 1}`;
    const id = `civil:${project.id}:${segmentKey}`;
    const dependencies = [designId];
    if (priorByFront.has(front)) dependencies.push(priorByFront.get(front));
    tasks.push(task(id, `${segment.from}–${segment.to} 토목`, "segment-civil", segmentDurationMonths(segment), dependencies, { type: "project-phase", entityId: project.id, phaseId: "civil" }, { segmentId: segment.id ?? null, front }));
    priorByFront.set(front, id);
    civilIds.push(id);
  }

  const packageByStation = new Map(stationPackages.map((entry) => [entry.connectedStationId, entry]));
  const stationIds = [];
  for (const station of project.planGeometry.stationCandidates ?? []) {
    const deliveryPackage = packageByStation.get(station.id);
    const id = deliveryPackage ? `station:${deliveryPackage.id}` : `station:${project.id}:${station.id}`;
    const duration = deliveryPackage?.awardedBid?.durationMonths ?? deliveryPackage?.estimate?.schedule?.durationP90Months ?? 4;
    const source = deliveryPackage
      ? { type: "station-package", entityId: deliveryPackage.id }
      : { type: "project-phase", entityId: project.id, phaseId: "civil" };
    tasks.push(task(id, `${station.name ?? station.id} 역`, "station-civil", duration, [designId], source, { stationId: station.id, packageId: deliveryPackage?.id ?? null }));
    stationIds.push(id);
  }

  const depotIds = depots.map((depot) => {
    const id = `depot:${depot.id}`;
    tasks.push(task(id, depot.name ?? depot.id, "depot-construction", depot.assessment?.schedule?.durationMonths ?? 1, [designId], { type: "depot", entityId: depot.id }));
    return id;
  });
  const vehicleIds = vehicleOrders.map((order) => {
    const id = `vehicle:${order.id}`;
    tasks.push(task(id, `차량 제작 ${order.id}`, "vehicle-production", order.productionMonths, [designId], { type: "vehicle-order", entityId: order.id }));
    return id;
  });

  const systemsId = `systems:${project.id}`;
  tasks.push(task(systemsId, "궤도·전력·신호 통합", "railway-systems", 6, [...civilIds, ...stationIds], { type: "project-phase", entityId: project.id, phaseId: "systems" }));
  const testingId = `testing:${project.id}`;
  tasks.push(task(testingId, "종합시험·안전검사", "integrated-testing", 3, [systemsId, ...stationIds, ...depotIds, ...vehicleIds], { type: "project-phase", entityId: project.id, phaseId: "testing" }));
  const openingId = `opening:${project.id}`;
  tasks.push(task(openingId, "개통 준비 완료", "opening-readiness", 0, [testingId], { type: "milestone", entityId: project.id }));
  applyBaseline(tasks);

  const schedule = {
    schema: INTEGRATED_SCHEDULE_SCHEMA,
    contractVersion: 1,
    id: scheduleId,
    projectId: project.id,
    planId: project.planId,
    createdAtMinute: clock.minute,
    updatedAtMinute: clock.minute,
    currentMonth: 0,
    openingTaskId: openingId,
    linkedDepotIds: depots.map((entry) => entry.id),
    linkedVehicleOrderIds: vehicleOrders.map((entry) => entry.id),
    linkedStationPackageIds: stationPackages.map((entry) => entry.id),
    tasks,
    delayEvents: [],
    blockers: [],
    status: "active",
    ready: false,
  };
  return refreshForecast(schedule, { project, stationPackages, depots, vehicleOrders }, clock);
}

export function refreshIntegratedConstructionSchedule(schedule, { project, stationPackages = [], depots = [], vehicleOrders = [] } = {}, clock = { minute: 0 }) {
  if (schedule?.schema !== INTEGRATED_SCHEDULE_SCHEMA) throw new Error("Invalid integrated construction schedule");
  if (project?.id !== schedule.projectId) throw new Error("Schedule project does not match");
  return refreshForecast(schedule, { project, stationPackages, depots, vehicleOrders }, clock);
}

export function recordIntegratedTaskDelay(schedule, taskId, { months, reason, source = "management-event" } = {}, clock = { minute: 0 }) {
  if (schedule?.schema !== INTEGRATED_SCHEDULE_SCHEMA) throw new Error("Invalid integrated construction schedule");
  if (!Number.isInteger(months) || months < 1) throw new Error("Schedule delay must be a positive whole number of months");
  const entry = schedule.tasks.find((candidate) => candidate.id === taskId);
  if (!entry) throw new Error(`Unknown schedule task ${taskId}`);
  if (["complete", "cancelled"].includes(entry.status)) throw new Error(`Cannot delay a ${entry.status} schedule task`);
  const event = { id: `${schedule.id}:delay-${schedule.delayEvents.length + 1}`, taskId, atMinute: clock.minute, months, reason: String(reason || "Unspecified delay"), source };
  const priorForecastFinish = Number.isFinite(entry.forecastFinishMonth) ? entry.forecastFinishMonth : schedule.currentMonth;
  entry.extraDelayMonths += months;
  entry.notBeforeFinishMonth = Math.max(entry.notBeforeFinishMonth ?? 0, priorForecastFinish + months);
  schedule.delayEvents.push(event);
  return clone(event);
}

export function integratedScheduleSummary(schedule) {
  if (schedule?.schema !== INTEGRATED_SCHEDULE_SCHEMA) throw new Error("Invalid integrated construction schedule");
  return {
    id: schedule.id,
    projectId: schedule.projectId,
    status: schedule.status,
    currentMonth: schedule.currentMonth,
    baselineOpeningMonth: schedule.baselineOpeningMonth,
    forecastOpeningMonth: schedule.forecastOpeningMonth,
    delayMonths: schedule.delayMonths,
    ready: schedule.ready,
    progress: round(schedule.tasks.filter((entry) => entry.kind !== "opening-readiness").reduce((sum, entry) => sum + entry.progress, 0) / Math.max(1, schedule.tasks.filter((entry) => entry.kind !== "opening-readiness").length)),
    criticalTaskIds: schedule.tasks.filter((entry) => entry.critical).map((entry) => entry.id),
    blockers: clone(schedule.blockers),
  };
}
