import { stableId } from "./map/ids.mjs";
import { RAIL_CAPACITY_GEOMETRY_SCHEMA } from "./map/rail-capacity-geometry.mjs";

export const RAIL_CAPACITY_APPLICATION_SCHEMA = "transitline.rail-capacity-application/1";

const clone = (value) => structuredClone(value);
const key = (value) => String(value);
const pairKey = (left, right) => [key(left), key(right)].sort().join("|");

function sourceStationId(state, stationId) {
  const station = state.stations?.get(stationId) ?? state.stations?.get(key(stationId));
  return key(station?.sourceStationId ?? stationId);
}

function blocksForSection(geometry, section) {
  if (geometry.blocks === null || section.blockIds === null) return null;
  const declared = new Set(section.blockIds.map(key));
  const matches = geometry.blocks.filter((block) => block.sectionId === section.sectionId && declared.has(key(block.blockId)));
  if (matches.length !== declared.size) throw new Error(`Rail capacity section ${section.sectionId} has unresolved block references`);
  return matches.map((block) => ({
    blockId: block.blockId,
    startAlongMeters: block.startAlongMeters,
    endAlongMeters: block.endAlongMeters,
    blockLengthMeters: block.blockLengthMeters,
    startBoundary: clone(block.startBoundary),
    endBoundary: clone(block.endBoundary),
  })).sort((a, b) => a.startAlongMeters - b.startAlongMeters || a.blockId.localeCompare(b.blockId));
}

function terminalFacts(geometry, sectionToTrack) {
  if (geometry.terminals === null) return null;
  return geometry.terminals.map((terminal) => ({
    terminalResourceId: terminal.terminalResourceId,
    stationId: terminal.stationId,
    approachTrackSegmentIds: terminal.approachSectionIds.map((id) => sectionToTrack.get(id)).filter(Boolean).sort(),
    platformCandidates: clone(terminal.platformCandidates),
    turnbackCandidates: clone(terminal.turnbackCandidates),
  })).sort((a, b) => a.terminalResourceId.localeCompare(b.terminalResourceId));
}

export function applyRailCapacityGeometry(state, { lineId, geometry } = {}) {
  if (!state) throw new Error("Operational state is required");
  if (geometry?.schema !== RAIL_CAPACITY_GEOMETRY_SCHEMA || geometry.contractVersion !== 1) throw new Error("RailCapacityGeometry v1 is required");
  if (geometry.revision?.state !== "current") throw new Error(`Rail capacity geometry is ${geometry.revision?.state ?? "invalid"}`);
  const line = state.lines?.find((entry) => key(entry.id) === key(lineId));
  if (!line) throw new Error(`Unknown operational line ${lineId}`);
  const allowed = new Set((line.trackSegmentIds ?? []).map(key));
  if (!allowed.size) throw new Error(`Operational line ${line.id} has no physical track mapping`);
  const geometryByPair = new Map();
  for (const section of geometry.sections) {
    const pair = pairKey(section.fromStationId, section.toStationId);
    const rows = geometryByPair.get(pair) ?? [];
    rows.push(section);
    geometryByPair.set(pair, rows);
  }
  const pending = [];
  const usedSectionIds = new Set();
  for (const segment of state.trackSegments.filter((entry) => allowed.has(key(entry.id)))) {
    const fromSource = sourceStationId(state, segment.fromStationId);
    const toSource = sourceStationId(state, segment.toStationId);
    const matches = geometryByPair.get(pairKey(fromSource, toSource)) ?? [];
    if (matches.length !== 1) throw new Error(matches.length
      ? `Ambiguous rail capacity section for track ${segment.id}`
      : `No rail capacity section matches track ${segment.id}`);
    if (usedSectionIds.has(matches[0].sectionId)) throw new Error(`Rail capacity section ${matches[0].sectionId} maps to multiple operational tracks`);
    usedSectionIds.add(matches[0].sectionId);
    pending.push({ segment, section: matches[0], blocks: blocksForSection(geometry, matches[0]) });
  }
  const changes = [];
  const sectionToTrack = new Map();
  for (const { segment, section, blocks } of pending) {
    sectionToTrack.set(section.sectionId, key(segment.id));
    changes.push({
      trackSegmentId: key(segment.id),
      railCapacitySectionId: section.sectionId,
      directionMode: section.directionMode,
      blockIds: blocks === null ? null : blocks.map((block) => block.blockId),
      junctionResourceIds: section.junctionResourceIds === null ? null : [...section.junctionResourceIds],
    });
  }
  const application = {
    schema: RAIL_CAPACITY_APPLICATION_SCHEMA,
    contractVersion: 1,
    applicationId: stableId("rail-capacity-application", key(line.id), geometry.railGeometryId, geometry.railGeometryRevision),
    operationalLineId: key(line.id),
    railGeometryId: geometry.railGeometryId,
    railGeometryRevision: geometry.railGeometryRevision,
    appliedAtSimMinute: state.simMinutes,
    sections: changes.sort((a, b) => a.trackSegmentId.localeCompare(b.trackSegmentId)),
    junctions: clone(geometry.junctions),
    terminals: terminalFacts(geometry, sectionToTrack),
    closureTargets: geometry.closureTargets.map((target) => ({
      railCapacitySectionId: target.sectionId,
      trackSegmentId: sectionToTrack.get(target.sectionId) ?? null,
      blockIds: clone(target.blockIds),
      lengthMeters: target.lengthMeters,
    })),
  };
  for (const { segment, section, blocks } of pending) {
    segment.railCapacityGeometryId = geometry.railGeometryId;
    segment.railCapacityGeometryRevision = geometry.railGeometryRevision;
    segment.railCapacitySectionId = section.sectionId;
    segment.railwayBlocks = blocks;
    if (section.directionMode !== null) segment.directionMode = section.directionMode;
    if (section.junctionResourceIds !== null) segment.junctionResourceIds = [...section.junctionResourceIds];
  }
  state.railCapacityApplications ??= [];
  const existing = state.railCapacityApplications.findIndex((entry) => entry.operationalLineId === key(line.id));
  if (existing >= 0) state.railCapacityApplications[existing] = application;
  else state.railCapacityApplications.push(application);
  state.railCapacityApplications.sort((a, b) => a.operationalLineId.localeCompare(b.operationalLineId));
  line.railCapacityGeometryId = geometry.railGeometryId;
  line.railCapacityGeometryRevision = geometry.railGeometryRevision;
  return clone(application);
}

export function railCapacityApplicationReport(state, lineId = null) {
  const values = state?.railCapacityApplications ?? [];
  return clone(lineId === null ? values : values.filter((entry) => entry.operationalLineId === key(lineId)));
}
