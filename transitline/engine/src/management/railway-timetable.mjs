export const RAILWAY_TIMETABLE_SCHEMA = "transitline.railway-timetable/1";
export const RAILWAY_TIMETABLE_DAY_TYPES = Object.freeze(["weekday", "weekend", "holiday"]);

const clone = (value) => structuredClone(value);
const uniqueText = (values) => [...new Set(values.filter((value) => typeof value === "string" && value))].sort();
const minute = (value, label) => {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number >= 1440) throw new Error(`${label} must be within one operating day`);
  return number;
};
const positive = (value, label) => {
  const number = Number(value);
  if (!(number > 0) || !Number.isFinite(number)) throw new Error(`${label} must be positive`);
  return number;
};
const intervalStart = (value) => value.startMinute ?? value.entryMinute;
const intervalEnd = (value) => value.endMinute ?? value.exitMinute;
const overlaps = (a, b) => intervalStart(a) < intervalEnd(b) && intervalStart(b) < intervalEnd(a);

function normalizeSection(section) {
  if (!(typeof section?.sectionId === "string" && section.sectionId)) throw new Error("Timetable section requires sectionId");
  if (!(typeof section.fromNodeId === "string" && section.fromNodeId) || !(typeof section.toNodeId === "string" && section.toNodeId)) throw new Error(`Timetable section ${section.sectionId} requires endpoints`);
  if (!["double", "single"].includes(section.directionMode)) throw new Error(`Timetable section ${section.sectionId} has invalid directionMode`);
  const runMinutes = positive(section.runMinutes, `${section.sectionId}.runMinutes`);
  const minimumHeadwayMinutes = positive(section.minimumHeadwayMinutes, `${section.sectionId}.minimumHeadwayMinutes`);
  let capacityTrainsPerHour = null;
  if (section.capacityTrainsPerHour !== null && section.capacityTrainsPerHour !== undefined) {
    capacityTrainsPerHour = Number(section.capacityTrainsPerHour);
    if (!Number.isInteger(capacityTrainsPerHour) || capacityTrainsPerHour < 1) throw new Error(`${section.sectionId}.capacityTrainsPerHour must be a positive integer`);
  }
  const closureWindows = (section.closureWindows ?? []).map((window, index) => {
    const startMinute = minute(window.startMinute, `${section.sectionId}.closureWindows[${index}].startMinute`);
    const endMinute = Number(window.endMinute);
    if (!Number.isFinite(endMinute) || endMinute <= startMinute || endMinute > 1440) throw new Error(`Invalid closure window on ${section.sectionId}`);
    return { startMinute, endMinute, reason: String(window.reason ?? "infrastructure-closed") };
  }).sort((a, b) => a.startMinute - b.startMinute || a.endMinute - b.endMinute);
  return {
    sectionId: section.sectionId,
    fromNodeId: section.fromNodeId,
    toNodeId: section.toNodeId,
    directionMode: section.directionMode,
    runMinutes,
    minimumHeadwayMinutes,
    capacityTrainsPerHour,
    junctionResourceIds: uniqueText(section.junctionResourceIds ?? []),
    junctionClearanceMinutes: Number.isFinite(Number(section.junctionClearanceMinutes)) ? Math.max(0, Number(section.junctionClearanceMinutes)) : 1,
    closureWindows,
  };
}

function normalizePath(path) {
  if (!(typeof path?.pathId === "string" && path.pathId)) throw new Error("Timetable path requires pathId");
  if (!(typeof path.serviceId === "string" && path.serviceId)) throw new Error(`Timetable path ${path.pathId} requires serviceId`);
  if (!["forward", "reverse"].includes(path.direction)) throw new Error(`Timetable path ${path.pathId} has invalid direction`);
  if (!Array.isArray(path.sectionIds) || !path.sectionIds.length) throw new Error(`Timetable path ${path.pathId} requires sections`);
  const dwellMinutesAfterSection = (path.dwellMinutesAfterSection ?? []).map((value, index) => {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) throw new Error(`Timetable path ${path.pathId} has invalid dwell at ${index}`);
    return number;
  });
  const terminalTurnback = path.terminalTurnback === null || path.terminalTurnback === undefined ? null : {
    resourceId: String(path.terminalTurnback.resourceId ?? ""),
    durationMinutes: positive(path.terminalTurnback.durationMinutes, `${path.pathId}.terminalTurnback.durationMinutes`),
  };
  if (terminalTurnback && !terminalTurnback.resourceId) throw new Error(`Timetable path ${path.pathId} requires a turnback resource`);
  return {
    pathId: path.pathId,
    serviceId: path.serviceId,
    operatorId: path.operatorId ?? null,
    priority: Number.isFinite(Number(path.priority)) ? Number(path.priority) : 0,
    departureMinute: minute(path.departureMinute, `${path.pathId}.departureMinute`),
    direction: path.direction,
    sectionIds: path.sectionIds.map(String),
    dwellMinutesAfterSection,
    terminalTurnback,
  };
}

export function expandPeriodicService({ pathKey, serviceId, operatorId = null, priority = 0, direction = "forward", sectionIds, firstDepartureMinute, lastDepartureMinute, headwayMinutes, dwellMinutesAfterSection = [], terminalTurnback = null } = {}) {
  if (!(typeof pathKey === "string" && pathKey)) throw new Error("Periodic service requires pathKey");
  const first = minute(firstDepartureMinute, "firstDepartureMinute");
  const last = minute(lastDepartureMinute, "lastDepartureMinute");
  const headway = positive(headwayMinutes, "headwayMinutes");
  if (last < first) throw new Error("Periodic service cannot wrap past the operating-day boundary");
  const paths = [];
  let sequence = 1;
  for (let departureMinute = first; departureMinute <= last + 1e-9; departureMinute += headway) {
    paths.push(normalizePath({ pathId: `${pathKey}:${sequence++}`, serviceId, operatorId, priority, departureMinute, direction, sectionIds, dwellMinutesAfterSection, terminalTurnback }));
  }
  return paths;
}

function pathTimings(path, sectionsById) {
  const timings = [];
  let cursor = path.departureMinute;
  let previousNode = null;
  for (let index = 0; index < path.sectionIds.length; index++) {
    const section = sectionsById.get(path.sectionIds[index]);
    if (!section) return { timings: [], violations: [`section:${path.sectionIds[index]}:not-found`] };
    const fromNodeId = path.direction === "forward" ? section.fromNodeId : section.toNodeId;
    const toNodeId = path.direction === "forward" ? section.toNodeId : section.fromNodeId;
    if (previousNode !== null && fromNodeId !== previousNode) return { timings: [], violations: [`section:${section.sectionId}:route-disconnected`] };
    const entryMinute = cursor;
    const exitMinute = cursor + section.runMinutes;
    if (exitMinute > 1440) return { timings: [], violations: [`section:${section.sectionId}:outside-operating-day`] };
    timings.push({ sectionId: section.sectionId, fromNodeId, toNodeId, entryMinute, exitMinute, direction: path.direction });
    cursor = exitMinute + (path.dwellMinutesAfterSection[index] ?? 0);
    previousNode = toNodeId;
  }
  return { timings, arrivalMinute: cursor, violations: [] };
}

function sectionResource(section, direction) {
  return section.directionMode === "single" ? `section:${section.sectionId}:shared` : `section:${section.sectionId}:${direction}`;
}

function conflictFor(path, schedule, sectionsById, reservations) {
  for (const timing of schedule.timings) {
    const section = sectionsById.get(timing.sectionId);
    const closure = section.closureWindows.find((window) => overlaps(timing, window));
    if (closure) return { reason: "section-closed", sectionId: section.sectionId, detail: closure.reason, conflictPathId: null };
    const resourceId = sectionResource(section, timing.direction);
    const resourceReservations = reservations.sections.get(resourceId) ?? [];
    for (const reserved of resourceReservations) {
      const entryTooClose = Math.abs(timing.entryMinute - reserved.entryMinute) < section.minimumHeadwayMinutes;
      const singleTrackOverlap = section.directionMode === "single" && overlaps(timing, reserved);
      if (entryTooClose || singleTrackOverlap) return { reason: singleTrackOverlap ? "single-track-conflict" : "minimum-headway", sectionId: section.sectionId, detail: resourceId, conflictPathId: reserved.pathId };
    }
    if (section.capacityTrainsPerHour !== null) {
      const hour = Math.floor(timing.entryMinute / 60);
      const count = resourceReservations.filter((entry) => Math.floor(entry.entryMinute / 60) === hour).length;
      if (count >= section.capacityTrainsPerHour) return { reason: "hourly-capacity", sectionId: section.sectionId, detail: `hour:${hour}`, conflictPathId: null };
    }
    for (const junctionId of section.junctionResourceIds) {
      const interval = { startMinute: timing.exitMinute - section.junctionClearanceMinutes, endMinute: timing.exitMinute + section.junctionClearanceMinutes };
      const conflict = (reservations.junctions.get(junctionId) ?? []).find((reserved) => overlaps(interval, reserved));
      if (conflict) return { reason: "junction-conflict", sectionId: section.sectionId, detail: junctionId, conflictPathId: conflict.pathId };
    }
  }
  if (path.terminalTurnback) {
    const interval = { startMinute: schedule.arrivalMinute, endMinute: schedule.arrivalMinute + path.terminalTurnback.durationMinutes };
    if (interval.endMinute > 1440) return { reason: "turnback-outside-operating-day", sectionId: null, detail: path.terminalTurnback.resourceId, conflictPathId: null };
    const conflict = (reservations.turnbacks.get(path.terminalTurnback.resourceId) ?? []).find((reserved) => overlaps(interval, reserved));
    if (conflict) return { reason: "turnback-conflict", sectionId: null, detail: path.terminalTurnback.resourceId, conflictPathId: conflict.pathId };
  }
  return null;
}

function reserve(path, schedule, sectionsById, reservations) {
  for (const timing of schedule.timings) {
    const section = sectionsById.get(timing.sectionId);
    const resourceId = sectionResource(section, timing.direction);
    const sectionRows = reservations.sections.get(resourceId) ?? [];
    sectionRows.push({ ...timing, pathId: path.pathId, serviceId: path.serviceId });
    reservations.sections.set(resourceId, sectionRows);
    for (const junctionId of section.junctionResourceIds) {
      const rows = reservations.junctions.get(junctionId) ?? [];
      rows.push({ pathId: path.pathId, serviceId: path.serviceId, startMinute: timing.exitMinute - section.junctionClearanceMinutes, endMinute: timing.exitMinute + section.junctionClearanceMinutes });
      reservations.junctions.set(junctionId, rows);
    }
  }
  if (path.terminalTurnback) {
    const rows = reservations.turnbacks.get(path.terminalTurnback.resourceId) ?? [];
    rows.push({ pathId: path.pathId, serviceId: path.serviceId, startMinute: schedule.arrivalMinute, endMinute: schedule.arrivalMinute + path.terminalTurnback.durationMinutes });
    reservations.turnbacks.set(path.terminalTurnback.resourceId, rows);
  }
}

function serviceSummary(paths, accepted, rejected) {
  const serviceIds = uniqueText(paths.map((entry) => entry.serviceId));
  return serviceIds.map((serviceId) => {
    const requestedPaths = paths.filter((entry) => entry.serviceId === serviceId).length;
    const acceptedPaths = accepted.filter((entry) => entry.serviceId === serviceId).length;
    return { serviceId, requestedPaths, acceptedPaths, rejectedPaths: rejected.filter((entry) => entry.serviceId === serviceId).length, acceptanceRatio: requestedPaths ? acceptedPaths / requestedPaths : 0 };
  });
}

export function buildRailwayTimetable({ id, infrastructureRevision, dayType = "weekday", sections = [], paths = [], minimumAcceptanceRatio = 1, atMinute = 0 } = {}) {
  if (!(typeof id === "string" && id)) throw new Error("Railway timetable requires an id");
  if (!(typeof infrastructureRevision === "string" && infrastructureRevision)) throw new Error("Railway timetable requires infrastructureRevision");
  if (!RAILWAY_TIMETABLE_DAY_TYPES.includes(dayType)) throw new Error(`Invalid railway timetable day type ${dayType}`);
  minimumAcceptanceRatio = Number(minimumAcceptanceRatio);
  if (!Number.isFinite(minimumAcceptanceRatio) || !(minimumAcceptanceRatio >= 0 && minimumAcceptanceRatio <= 1)) throw new Error("minimumAcceptanceRatio must be between zero and one");
  const normalizedSections = sections.map(normalizeSection).sort((a, b) => a.sectionId.localeCompare(b.sectionId));
  if (new Set(normalizedSections.map((entry) => entry.sectionId)).size !== normalizedSections.length) throw new Error("Duplicate timetable section id");
  const normalizedPaths = paths.map(normalizePath);
  if (new Set(normalizedPaths.map((entry) => entry.pathId)).size !== normalizedPaths.length) throw new Error("Duplicate timetable path id");
  const sectionsById = new Map(normalizedSections.map((entry) => [entry.sectionId, entry]));
  const allocationOrder = [...normalizedPaths].sort((a, b) => b.priority - a.priority || a.departureMinute - b.departureMinute || a.pathId.localeCompare(b.pathId));
  const reservations = { sections: new Map(), junctions: new Map(), turnbacks: new Map() };
  const accepted = [];
  const rejected = [];
  for (const path of allocationOrder) {
    const schedule = pathTimings(path, sectionsById);
    if (schedule.violations.length) {
      rejected.push({ pathId: path.pathId, serviceId: path.serviceId, reason: "invalid-path", sectionId: null, detail: schedule.violations[0], conflictPathId: null });
      continue;
    }
    const conflict = conflictFor(path, schedule, sectionsById, reservations);
    if (conflict) {
      rejected.push({ pathId: path.pathId, serviceId: path.serviceId, ...conflict });
      continue;
    }
    reserve(path, schedule, sectionsById, reservations);
    accepted.push({ pathId: path.pathId, serviceId: path.serviceId, operatorId: path.operatorId, priority: path.priority, departureMinute: path.departureMinute, arrivalMinute: schedule.arrivalMinute, direction: path.direction, timings: schedule.timings, terminalTurnback: clone(path.terminalTurnback) });
  }
  accepted.sort((a, b) => a.departureMinute - b.departureMinute || a.pathId.localeCompare(b.pathId));
  rejected.sort((a, b) => a.pathId.localeCompare(b.pathId));
  const acceptanceRatio = normalizedPaths.length ? accepted.length / normalizedPaths.length : 0;
  const verdict = normalizedPaths.length === 0 ? "unknown" : acceptanceRatio >= minimumAcceptanceRatio ? "possible" : accepted.length ? "conditional" : "impossible";
  return {
    schema: RAILWAY_TIMETABLE_SCHEMA,
    contractVersion: 1,
    id,
    infrastructureRevision,
    dayType,
    status: "assessed",
    minimumAcceptanceRatio,
    requestedPaths: normalizedPaths.length,
    acceptedPaths: accepted,
    rejectedPaths: rejected,
    serviceSummary: serviceSummary(normalizedPaths, accepted, rejected),
    assessment: { verdict, acceptanceRatio, violations: rejected.map((entry) => `${entry.pathId}:${entry.reason}`), missingInputs: normalizedPaths.length ? [] : ["paths"] },
    sections: normalizedSections,
    createdAtMinute: atMinute,
  };
}

export function approveRailwayTimetable(timetable, atMinute = 0) {
  if (timetable?.schema !== RAILWAY_TIMETABLE_SCHEMA || timetable.contractVersion !== 1) throw new Error("RailwayTimetable v1 is required");
  if (timetable.status !== "assessed") throw new Error(`Railway timetable cannot be approved from ${timetable.status}`);
  if (timetable.assessment.verdict !== "possible") throw new Error(`Railway timetable assessment is ${timetable.assessment.verdict}`);
  timetable.status = "approved";
  timetable.approvedAtMinute = atMinute;
  return clone(timetable);
}

export function activateRailwayTimetable(timetable, services, throughServices, timetables, atMinute = 0) {
  if (timetable.status !== "approved") throw new Error(`Railway timetable cannot be activated from ${timetable.status}`);
  const allServiceIds = uniqueText(timetable.acceptedPaths.map((entry) => entry.serviceId));
  for (const serviceId of allServiceIds) {
    const service = services.find((entry) => entry.id === serviceId) ?? throughServices.find((entry) => entry.throughServiceId === serviceId);
    if (!service) throw new Error(`Unknown timetable service ${serviceId}`);
    if (!["open", "approved"].includes(service.status)) throw new Error(`Timetable service ${serviceId} is not available for operation`);
  }
  for (const current of timetables.filter((entry) => entry.id !== timetable.id && entry.dayType === timetable.dayType && entry.status === "active")) {
    current.status = "superseded";
    current.supersededAtMinute = atMinute;
  }
  timetable.status = "active";
  timetable.activatedAtMinute = atMinute;
  for (const serviceId of allServiceIds) {
    const service = services.find((entry) => entry.id === serviceId) ?? throughServices.find((entry) => entry.throughServiceId === serviceId);
    service.activeTimetableId = timetable.id;
  }
  return clone(timetable);
}
