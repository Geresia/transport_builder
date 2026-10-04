import { expandPeriodicService } from "./management/railway-timetable.mjs";
import { stableId } from "./map/ids.mjs";

export const OPERATIONAL_TIMETABLE_APPLICATION_SCHEMA = "transitline.operational-timetable-application/1";

const clone = (value) => structuredClone(value);
const key = (value) => String(value);

export function operationalInfrastructureRevision(segments = []) {
  const facts = segments.map((segment) => ({
    sectionId: key(segment.id),
    fromNodeId: key(segment.fromStationId),
    toNodeId: key(segment.toStationId),
    lengthMeters: segment.lengthMeters ?? null,
    runMinutes: segment.runMinutes ?? null,
    directionMode: segment.directionMode ?? null,
    minimumHeadwayMinutes: segment.minimumHeadwayMinutes ?? null,
    capacityTrainsPerHour: segment.capacityTrainsPerHour ?? null,
    junctionResourceIds: [...(segment.junctionResourceIds ?? [])].map(key).sort(),
    junctionClearanceMinutes: segment.junctionClearanceMinutes ?? null,
    railCapacityGeometryRevision: segment.railCapacityGeometryRevision ?? null,
    railCapacitySectionId: segment.railCapacitySectionId ?? null,
    railwayBlocks: segment.railwayBlocks === null || segment.railwayBlocks === undefined
      ? null
      : segment.railwayBlocks.map((block) => ({
        blockId: key(block.blockId),
        startAlongMeters: block.startAlongMeters,
        endAlongMeters: block.endAlongMeters,
      })).sort((a, b) => a.startAlongMeters - b.startAlongMeters || a.blockId.localeCompare(b.blockId)),
  })).sort((a, b) => a.sectionId.localeCompare(b.sectionId));
  return stableId("operational-infrastructure", JSON.stringify(facts));
}

export function operationalDayType(simMinutes) {
  const day = Math.floor(Number(simMinutes) / 1440);
  const weekday = ((day % 7) + 7) % 7;
  return weekday >= 5 ? "weekend" : "weekday";
}

function lineForService(operationalState, services, throughServices, serviceId) {
  const standard = services.find((entry) => entry.id === serviceId);
  if (standard) {
    if (standard.operationalLineId === undefined) throw new Error(`Service ${serviceId} is not commissioned`);
    const line = operationalState.lines.find((entry) => key(entry.id) === key(standard.operationalLineId));
    if (!line) throw new Error(`Service ${serviceId} operational line is missing`);
    return { service: standard, line, kind: "standard" };
  }
  const through = throughServices.find((entry) => entry.throughServiceId === serviceId);
  if (!through) throw new Error(`Unknown operational timetable service ${serviceId}`);
  const binding = (operationalState.throughServiceBindings ?? []).find((entry) => entry.throughServiceId === serviceId);
  if (!binding) throw new Error(`Through service ${serviceId} has no operational binding`);
  const line = operationalState.lines.find((entry) => key(entry.id) === key(binding.operationalLineId));
  if (!line) throw new Error(`Through service ${serviceId} operational line is missing`);
  return { service: through, line, kind: "through" };
}

function segmentBetween(operationalState, fromStationId, toStationId, allowedIds) {
  const matches = operationalState.trackSegments.filter((segment) => allowedIds.has(key(segment.id))
    && ((key(segment.fromStationId) === key(fromStationId) && key(segment.toStationId) === key(toStationId))
      || (key(segment.fromStationId) === key(toStationId) && key(segment.toStationId) === key(fromStationId))));
  if (matches.length !== 1) {
    throw new Error(matches.length ? `Ambiguous track between ${fromStationId} and ${toStationId}` : `Missing track between ${fromStationId} and ${toStationId}`);
  }
  return matches[0];
}

export function resolveOperationalLinePath(operationalState, line) {
  if (!Array.isArray(line?.stationIds) || line.stationIds.length < 2) throw new Error("Operational line requires at least two stations");
  const allowedIds = new Set((line.trackSegmentIds ?? []).map(key));
  if (!allowedIds.size) throw new Error(`Operational line ${line.id} has no track segment mapping`);
  const segments = [];
  const sectionDirections = [];
  for (let index = 0; index < line.stationIds.length - 1; index += 1) {
    const from = line.stationIds[index];
    const to = line.stationIds[index + 1];
    const segment = segmentBetween(operationalState, from, to, allowedIds);
    segments.push(segment);
    sectionDirections.push(key(segment.fromStationId) === key(from) ? "forward" : "reverse");
  }
  if (new Set(segments.map((entry) => key(entry.id))).size !== segments.length) throw new Error(`Operational line ${line.id} reuses a track segment`);
  return { segments, sectionIds: segments.map((entry) => key(entry.id)), sectionDirections };
}

function positive(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || !(number > 0)) throw new Error(`${label} must be positive`);
  return number;
}

function sectionFromSegment(segment, speeds, closureWindowsBySectionId, assumptions, infrastructureAssumptions) {
  const sectionId = key(segment.id);
  const explicitRunMinutes = Number(segment.runMinutes);
  let runMinutes = explicitRunMinutes;
  if (!(runMinutes > 0)) {
    const lengthMeters = positive(segment.lengthMeters, `${sectionId}.lengthMeters`);
    const speedKph = Math.min(...speeds);
    runMinutes = (lengthMeters / 1000) / speedKph * 60;
    assumptions.push(`${sectionId}:runMinutes:derived-from-length-and-slowest-service-speed`);
  }
  let minimumHeadwayMinutes = Number(segment.minimumHeadwayMinutes);
  if (!(minimumHeadwayMinutes > 0)) {
    minimumHeadwayMinutes = Number(infrastructureAssumptions?.minimumHeadwayMinutes);
    if (!(minimumHeadwayMinutes > 0)) throw new Error(`${sectionId}.minimumHeadwayMinutes is unknown; provide an explicit infrastructure assumption`);
    assumptions.push(`${sectionId}:minimumHeadwayMinutes:explicit-assumption-${minimumHeadwayMinutes}`);
  }
  const explicitCapacity = Number(segment.capacityTrainsPerHour);
  const capacityTrainsPerHour = Number.isSafeInteger(explicitCapacity) && explicitCapacity > 0
    ? explicitCapacity
    : Math.max(1, Math.floor(60 / minimumHeadwayMinutes));
  if (!(Number.isSafeInteger(explicitCapacity) && explicitCapacity > 0)) assumptions.push(`${sectionId}:capacityTrainsPerHour:derived-from-headway`);
  const directionMode = ["double", "single"].includes(segment.directionMode) ? segment.directionMode : infrastructureAssumptions?.directionMode;
  if (!["double", "single"].includes(directionMode)) throw new Error(`${sectionId}.directionMode is unknown; provide an explicit infrastructure assumption`);
  if (!segment.directionMode) assumptions.push(`${sectionId}:directionMode:explicit-assumption-${directionMode}`);
  return {
    sectionId,
    fromNodeId: key(segment.fromStationId),
    toNodeId: key(segment.toStationId),
    directionMode,
    runMinutes,
    minimumHeadwayMinutes,
    capacityTrainsPerHour,
    junctionResourceIds: (segment.junctionResourceIds ?? []).map(key),
    junctionClearanceMinutes: segment.junctionClearanceMinutes ?? 1,
    closureWindows: clone(closureWindowsBySectionId?.[sectionId] ?? []),
  };
}

function periodicPaths(plan, route, operatorId, service, sectionsById) {
  const headwayMinutes = plan.headwayMinutes !== undefined
    ? positive(plan.headwayMinutes, `${plan.serviceId}.headwayMinutes`)
    : 60 / positive(plan.trainsPerHour ?? service.trainsPerHour, `${plan.serviceId}.trainsPerHour`);
  const dwellMinutes = Number.isFinite(Number(plan.dwellMinutes)) && Number(plan.dwellMinutes) >= 0 ? Number(plan.dwellMinutes) : 0.5;
  const dwell = route.sectionIds.map((_, index) => index === route.sectionIds.length - 1 ? 0 : dwellMinutes);
  const common = {
    serviceId: plan.serviceId,
    operatorId,
    priority: plan.priority ?? 0,
    firstDepartureMinute: plan.firstDepartureMinute ?? 300,
    lastDepartureMinute: plan.lastDepartureMinute ?? 1380,
    headwayMinutes,
  };
  const forward = expandPeriodicService({
    ...common,
    pathKey: `${plan.serviceId}:outbound`,
    direction: "forward",
    sectionIds: route.sectionIds,
    sectionDirections: route.sectionDirections,
    dwellMinutesAfterSection: dwell,
    terminalTurnback: plan.terminalResourceId ? { resourceId: plan.terminalResourceId, durationMinutes: plan.turnbackMinutes ?? 8 } : null,
  });
  if (plan.includeReturnPaths === false) return forward;
  const reverseSectionIds = [...route.sectionIds].reverse();
  const reverseDirections = [...route.sectionDirections].reverse().map((value) => value === "forward" ? "reverse" : "forward");
  const reverseDwell = reverseSectionIds.map((_, index) => index === reverseSectionIds.length - 1 ? 0 : dwellMinutes);
  const oneWayMinutes = route.sectionIds.reduce((sum, sectionId) => sum + sectionsById.get(sectionId).runMinutes, 0)
    + dwellMinutes * Math.max(0, route.sectionIds.length - 1);
  const returnOffset = oneWayMinutes + positive(plan.turnbackMinutes ?? 8, `${plan.serviceId}.turnbackMinutes`);
  const reverseFirst = common.firstDepartureMinute + returnOffset;
  const reverseLast = Math.min(1439, common.lastDepartureMinute + returnOffset);
  const reverse = reverseFirst <= reverseLast ? expandPeriodicService({
    ...common,
    pathKey: `${plan.serviceId}:inbound`,
    direction: "reverse",
    sectionIds: reverseSectionIds,
    sectionDirections: reverseDirections,
    firstDepartureMinute: reverseFirst,
    lastDepartureMinute: reverseLast,
    dwellMinutesAfterSection: reverseDwell,
  }) : [];
  for (let index = 0; index < forward.length; index += 1) {
    const dutyId = `${plan.serviceId}:duty:${index + 1}`;
    forward[index].dutyId = dutyId;
    if (reverse[index]) reverse[index].dutyId = dutyId;
  }
  return [...forward, ...reverse];
}

export function buildOperationalRailwayTimetableInput({ operationalState, services = [], throughServices = [], servicePlans = [], infrastructureRevision = null, dayType = "weekday", closureWindowsBySectionId = {}, infrastructureAssumptions = null, minimumAcceptanceRatio = 1 } = {}) {
  if (!operationalState) throw new Error("Operational state is required");
  if (!Array.isArray(servicePlans) || !servicePlans.length) throw new Error("Operational timetable requires service plans");
  const assumptions = [];
  const routes = [];
  const speedsBySection = new Map();
  for (const plan of servicePlans) {
    if (!(typeof plan?.serviceId === "string" && plan.serviceId)) throw new Error("Operational service plan requires serviceId");
    const resolved = lineForService(operationalState, services, throughServices, plan.serviceId);
    const route = resolveOperationalLinePath(operationalState, resolved.line);
    const speed = positive(plan.commercialSpeedKph ?? resolved.service.commercialSpeedKph, `${plan.serviceId}.commercialSpeedKph`);
    for (const sectionId of route.sectionIds) {
      const speeds = speedsBySection.get(sectionId) ?? [];
      speeds.push(speed);
      speedsBySection.set(sectionId, speeds);
    }
    routes.push({ plan, ...resolved, route });
  }
  const segments = new Map(routes.flatMap((entry) => entry.route.segments.map((segment) => [key(segment.id), segment])));
  const liveInfrastructureRevision = operationalInfrastructureRevision([...segments.values()]);
  const sections = [...segments.values()].map((segment) => sectionFromSegment(segment, speedsBySection.get(key(segment.id)), closureWindowsBySectionId, assumptions, infrastructureAssumptions));
  const sectionsById = new Map(sections.map((entry) => [entry.sectionId, entry]));
  const paths = routes.flatMap(({ plan, route, service }) => periodicPaths(plan, route, plan.operatorId ?? service.operatorId ?? null, service, sectionsById));
  return {
    infrastructureRevision: liveInfrastructureRevision,
    dayType,
    minimumAcceptanceRatio,
    sections,
    paths,
    operationalFacts: {
      lineIds: routes.map((entry) => key(entry.line.id)).sort(),
      serviceIds: routes.map((entry) => entry.plan.serviceId).sort(),
      assumptions: [...new Set(assumptions)].sort(),
      sourceInfrastructureRevision: infrastructureRevision,
    },
  };
}

function validatePathAgainstLine(path, route, line) {
  if (path.timings.length !== route.sectionIds.length) throw new Error(`Timetable path ${path.pathId} does not cover operational line ${line.id}`);
  const expectedStations = path.direction === "forward" ? line.stationIds : [...line.stationIds].reverse();
  const expectedSections = path.direction === "forward" ? route.sectionIds : [...route.sectionIds].reverse();
  for (let index = 0; index < path.timings.length; index += 1) {
    const timing = path.timings[index];
    if (key(timing.sectionId) !== key(expectedSections[index])) throw new Error(`Timetable path ${path.pathId} uses the wrong track section for operational line ${line.id}`);
    if (key(timing.fromNodeId) !== key(expectedStations[index]) || key(timing.toNodeId) !== key(expectedStations[index + 1])) {
      throw new Error(`Timetable path ${path.pathId} does not match operational line ${line.id}`);
    }
  }
}

export function applyActiveRailwayTimetable({ operationalState, timetable, services = [], throughServices = [] } = {}) {
  if (timetable?.schema !== "transitline.railway-timetable/1" || timetable.status !== "active") throw new Error("An active RailwayTimetable v1 is required");
  if (timetable.dayType === "holiday") throw new Error("Holiday timetable operation requires a calendar mapping");
  const pending = [];
  const mappedLineIds = new Set();
  const liveSegments = new Map();
  for (const summary of timetable.serviceSummary) {
    if (!summary.acceptedPaths) continue;
    const resolved = lineForService(operationalState, services, throughServices, summary.serviceId);
    const route = resolveOperationalLinePath(operationalState, resolved.line);
    const operationalLineId = key(resolved.line.id);
    if (mappedLineIds.has(operationalLineId)) throw new Error(`Multiple timetable services map to operational line ${operationalLineId}`);
    mappedLineIds.add(operationalLineId);
    for (const segment of route.segments) liveSegments.set(key(segment.id), segment);
    const accepted = timetable.acceptedPaths.filter((entry) => entry.serviceId === summary.serviceId);
    for (const path of accepted) validatePathAgainstLine(path, route, resolved.line);
    const outbound = accepted.filter((entry) => entry.direction === "forward").sort((a, b) => a.departureMinute - b.departureMinute || a.pathId.localeCompare(b.pathId));
    const inboundByDuty = new Map(accepted.filter((entry) => entry.direction === "reverse" && entry.dutyId).map((entry) => [entry.dutyId, entry]));
    if (!outbound.length) throw new Error(`Timetable service ${summary.serviceId} has no outbound departures`);
    const roundTrips = outbound.map((path) => {
      if (!path.dutyId) throw new Error(`Timetable outbound ${path.pathId} requires a duty id`);
      const returnPath = inboundByDuty.get(path.dutyId);
      if (!returnPath) throw new Error(`Timetable duty ${path.dutyId} requires its accepted inbound path`);
      inboundByDuty.delete(path.dutyId);
      if (returnPath.departureMinute + 1e-9 < path.arrivalMinute) throw new Error(`Timetable return ${returnPath.pathId} departs before outbound ${path.pathId} arrives`);
      return {
        outboundPathId: path.pathId,
        inboundPathId: returnPath.pathId,
        departureMinute: path.departureMinute,
        returnDepartureMinute: returnPath.departureMinute,
        completionMinute: returnPath.arrivalMinute,
        terminalResourceId: path.terminalTurnback?.resourceId ?? null,
      };
    });
    if (inboundByDuty.size) throw new Error(`Timetable service ${summary.serviceId} has an inbound path without its accepted outbound duty`);
    pending.push({ summary, resolved, departureMinutes: roundTrips.map((entry) => entry.departureMinute), roundTrips });
  }
  const liveRevision = operationalInfrastructureRevision([...liveSegments.values()]);
  if (timetable.infrastructureRevision !== liveRevision) throw new Error(`Timetable infrastructure revision ${timetable.infrastructureRevision} is stale; live revision is ${liveRevision}`);
  for (const line of operationalState.lines) {
    if (!line.timetableDispatches?.[timetable.dayType]) continue;
    delete line.timetableDispatches[timetable.dayType];
    if (!Object.keys(line.timetableDispatches).length) delete line.timetableDispatches;
  }
  const applications = [];
  for (const { summary, resolved, departureMinutes, roundTrips } of pending) {
    resolved.line.railwayTrafficControl = {
      infrastructureRevision: timetable.infrastructureRevision,
      sectionDirectionModes: Object.fromEntries((timetable.sections ?? []).map((section) => [section.sectionId, section.directionMode])),
      sectionJunctionResourceIds: Object.fromEntries((timetable.sections ?? []).map((section) => [section.sectionId, [...(section.junctionResourceIds ?? [])]])),
      sectionJunctionClearanceMinutes: Object.fromEntries((timetable.sections ?? []).map((section) => [section.sectionId, section.junctionClearanceMinutes ?? 0])),
    };
    resolved.line.timetableDispatches ??= {};
    resolved.line.timetableDispatches[timetable.dayType] = {
      schema: OPERATIONAL_TIMETABLE_APPLICATION_SCHEMA,
      contractVersion: 1,
      timetableId: timetable.id,
      infrastructureRevision: timetable.infrastructureRevision,
      serviceId: summary.serviceId,
      dayType: timetable.dayType,
      departureMinutes,
      roundTrips,
      lastCheckedSimMinute: operationalState.simMinutes,
    };
    applications.push({ serviceId: summary.serviceId, operationalLineId: key(resolved.line.id), dayType: timetable.dayType, departureMinutes: clone(departureMinutes) });
  }
  return { timetableId: timetable.id, applications };
}

export function operationalTimetableApplicationReport(operationalState) {
  return (operationalState?.lines ?? []).flatMap((line) => Object.values(line.timetableDispatches ?? {}).map((entry) => ({
    ...clone(entry),
    operationalLineId: key(line.id),
  }))).sort((a, b) => a.dayType.localeCompare(b.dayType) || a.operationalLineId.localeCompare(b.operationalLineId));
}

export function blockUnmappedRailwayTimetable({ operationalState, timetable, services = [], throughServices = [], reason } = {}) {
  for (const summary of timetable?.serviceSummary ?? []) {
    let resolved;
    try {
      resolved = lineForService(operationalState, services, throughServices, summary.serviceId);
    } catch {
      continue;
    }
    resolved.line.timetableDispatches ??= {};
    resolved.line.timetableDispatches[timetable.dayType] = {
      schema: OPERATIONAL_TIMETABLE_APPLICATION_SCHEMA,
      contractVersion: 1,
      timetableId: timetable.id,
      infrastructureRevision: timetable.infrastructureRevision,
      serviceId: summary.serviceId,
      dayType: timetable.dayType,
      departureMinutes: [],
      roundTrips: [],
      blockedReason: String(reason),
      lastCheckedSimMinute: operationalState.simMinutes,
    };
  }
}
