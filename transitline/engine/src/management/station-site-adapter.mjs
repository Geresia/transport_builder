import { createStationAccessPlan } from "./station-flow.mjs";
import { createStationConstructionContext } from "./station-construction.mjs";
import { createStationPlan } from "./station-planning.mjs";

export const STATION_SITE_GEOMETRY_SCHEMA = "transitline.station-site-geometry/1";
export const STATION_SITE_ADAPTATION_SCHEMA = "transitline.station-site-adaptation/1";

const DEFAULT_LAYOUT_BY_HINT = Object.freeze({
  side: "side-2track",
  island: "island-2track",
});

const clone = (value) => structuredClone(value);
const finite = (value) => Number.isFinite(value) ? value : null;
const sum = (values) => values.reduce((total, value) => total + value, 0);

function assertStationSite(site) {
  if (!site || site.schema !== STATION_SITE_GEOMETRY_SCHEMA || site.contractVersion !== 1) {
    throw new Error("StationSiteGeometry v1 is required");
  }
  if (!site.stationSiteId) throw new Error("stationSiteId is required");
}

function findById(items, id, field, label) {
  const item = items.find((candidate) => candidate[field] === id);
  if (!item) throw new Error(`Unknown ${label} ${id}`);
  return item;
}

function isKnownClear(candidate) {
  return candidate
    && candidate.intersectedBuildingCount === 0
    && candidate.waterOverlapCount === 0
    && candidate.roadsThrough
    && Object.values(candidate.roadsThrough).every((count) => count === 0);
}

function chooseEntrances(site, options, assumptions, warnings) {
  const candidates = site.entranceCandidates ?? [];
  let selected;
  if (Array.isArray(options.selectedEntranceIds)) {
    selected = options.selectedEntranceIds.map((id) => findById(candidates, id, "entranceId", "entrance candidate"));
  } else {
    selected = candidates
      .filter((candidate) => !(candidate.collidingBuildingCount > 0) && !(candidate.waterOverlapCount > 0))
      .sort((a, b) => Number(b.roadside) - Number(a.roadside) || (a.distanceToBodyMeters ?? Infinity) - (b.distanceToBodyMeters ?? Infinity))
      .slice(0, 2);
    if (!selected.length && candidates.length) {
      selected = [candidates[0]];
      warnings.push({ code: "blocked-entrance-used", entranceId: candidates[0].entranceId });
    }
    assumptions.push({ field: "selectedEntranceIds", assumedValue: selected.map((entry) => entry.entranceId), basis: "automatic unblocked-candidate shortlist" });
  }

  if (!selected.length) {
    assumptions.push({ field: "entranceCandidates", assumedValue: "concept entrance", basis: "no mapped entrance candidate" });
    warnings.push({ code: "concept-entrance-created" });
    return [{
      id: `${site.stationSiteId}:concept-entrance`,
      sourceEntranceId: null,
      widthMeters: options.defaultEntranceWidthMeters ?? 3,
      walkDistanceMeters: 120,
      accessible: true,
      demandShare: 1,
      open: true,
      publicLand: null,
      publicLandEvidence: null,
      spatialEvidence: null,
    }];
  }

  const designs = new Map((options.entranceDesigns ?? []).map((entry) => [entry.entranceId, entry]));
  const demandCounts = new Map();
  const demandDistances = new Map();
  for (const access of site.demandAccess ?? []) {
    if (!access.entranceId) continue;
    demandCounts.set(access.entranceId, (demandCounts.get(access.entranceId) ?? 0) + 1);
    if (Number.isFinite(access.distanceMeters)) {
      const distances = demandDistances.get(access.entranceId) ?? [];
      distances.push(access.distanceMeters);
      demandDistances.set(access.entranceId, distances);
    }
  }
  const totalDemandLinks = sum(selected.map((candidate) => demandCounts.get(candidate.entranceId) ?? 0));
  const unassignedShare = 1 / selected.length;

  return selected.map((candidate, index) => {
    const design = designs.get(candidate.entranceId) ?? {};
    const distances = demandDistances.get(candidate.entranceId) ?? [];
    const widthMeters = finite(design.widthMeters) ?? options.defaultEntranceWidthMeters ?? 3;
    const walkDistanceMeters = finite(design.walkDistanceMeters)
      ?? (distances.length ? sum(distances) / distances.length : finite(candidate.distanceToBodyMeters))
      ?? 120;
    if (!Number.isFinite(design.widthMeters)) assumptions.push({ field: `entrances.${candidate.entranceId}.widthMeters`, assumedValue: widthMeters, unit: "m", basis: "concept entrance width" });
    if (!Number.isFinite(design.walkDistanceMeters) && !distances.length && !Number.isFinite(candidate.distanceToBodyMeters)) {
      assumptions.push({ field: `entrances.${candidate.entranceId}.walkDistanceMeters`, assumedValue: walkDistanceMeters, unit: "m", basis: "no mapped access distance" });
    }
    if (candidate.publicLand === null) warnings.push({ code: "entrance-land-ownership-unknown", entranceId: candidate.entranceId });
    return {
      id: design.id ?? `${site.stationSiteId}:entrance:${index + 1}`,
      sourceEntranceId: candidate.entranceId,
      name: candidate.name ?? null,
      location: clone(candidate.location),
      widthMeters,
      walkDistanceMeters,
      accessible: design.accessible ?? index === 0,
      demandShare: finite(design.demandShare) ?? (totalDemandLinks > 0 ? (demandCounts.get(candidate.entranceId) ?? 0) / totalDemandLinks : unassignedShare),
      open: design.open ?? true,
      publicLand: candidate.publicLand,
      publicLandEvidence: candidate.publicLandEvidence ?? null,
      spatialEvidence: {
        collidingBuildingCount: candidate.collidingBuildingCount,
        waterOverlapCount: candidate.waterOverlapCount,
        roadside: candidate.roadside,
        roadsideDistanceMeters: candidate.roadsideDistanceMeters,
        nearestRoad: clone(candidate.nearestRoad),
        landUses: clone(candidate.landUses),
        dataQuality: candidate.dataQuality,
        unknown: clone(candidate.unknown ?? []),
        unknownReasons: clone(candidate.unknownReasons ?? {}),
      },
    };
  });
}

function chooseTransfers(site, stationPlan, options, assumptions) {
  const ids = options.selectedTransferIds ?? [];
  const designs = new Map((options.transferDesigns ?? []).map((entry) => [entry.transferId, entry]));
  return ids.map((id, index) => {
    const candidate = findById(site.transferCandidates ?? [], id, "transferId", "transfer candidate");
    const design = designs.get(id) ?? {};
    const widthMeters = finite(design.widthMeters) ?? 4;
    const levelChanges = finite(design.levelChanges) ?? 1;
    if (!Number.isFinite(design.widthMeters)) assumptions.push({ field: `transfers.${id}.widthMeters`, assumedValue: widthMeters, unit: "m", basis: "concept transfer passage width" });
    if (!Number.isFinite(design.levelChanges)) assumptions.push({ field: `transfers.${id}.levelChanges`, assumedValue: levelChanges, basis: "concept vertical circulation allowance" });
    return {
      id: design.id ?? `${stationPlan.id}:transfer:${index + 1}`,
      sourceTransferId: id,
      fromPlatformId: design.fromPlatformId ?? stationPlan.platforms[0].id,
      toPlatformId: design.toPlatformId ?? null,
      targetStationId: candidate.targetStationId,
      targetKind: candidate.targetKind,
      targetNetworkId: candidate.targetNetworkId ?? null,
      distanceMeters: finite(design.distanceMeters) ?? finite(candidate.walkingDistanceMeters) ?? finite(candidate.passageLengthMeters) ?? finite(candidate.straightDistanceMeters) ?? 0,
      widthMeters,
      levelChanges,
      open: design.open ?? true,
      spatialEvidence: {
        basis: candidate.basis,
        alignmentBasis: candidate.alignmentBasis ?? null,
        crossings: clone(candidate.crossings),
        dataQuality: candidate.dataQuality,
        unknown: clone(candidate.unknown ?? []),
        unknownReasons: clone(candidate.unknownReasons ?? {}),
      },
    };
  });
}

function chooseWorkArea(site, options, assumptions) {
  const candidates = site.workAreaCandidates ?? [];
  if (options.selectedWorkAreaId) return findById(candidates, options.selectedWorkAreaId, "workAreaId", "work-area candidate");
  const selected = candidates
    .slice()
    .sort((a, b) => Number(isKnownClear(b)) - Number(isKnownClear(a)) || (b.areaSquareMeters ?? 0) - (a.areaSquareMeters ?? 0))[0] ?? null;
  if (selected) assumptions.push({ field: "selectedWorkAreaId", assumedValue: selected.workAreaId, basis: "automatic concept-stage candidate; not a secured right" });
  return selected;
}

function knownConflictTotal(site, entrances, workArea) {
  const values = [site.intersectedBuildingCount];
  for (const entrance of entrances) values.push(entrance.spatialEvidence?.collidingBuildingCount);
  if (workArea) values.push(workArea.intersectedBuildingCount);
  if (values.some((value) => !Number.isFinite(value))) return null;
  return sum(values);
}

function mergedUnknown(site, entrances, workArea) {
  const unknown = new Set(site.unknown ?? []);
  const reasons = { ...(site.unknownReasons ?? {}) };
  for (const constraint of site.constraintUnknown ?? []) {
    const field = constraint === "soft-ground" ? "softGroundRisk" : constraint === "groundwater" ? "groundwaterRisk" : constraint === "utilities" ? "utilityConflictLevel" : constraint;
    unknown.add(field);
    reasons[field] = "no-layer";
  }
  for (const entrance of entrances) {
    for (const field of entrance.spatialEvidence?.unknown ?? []) {
      const key = `entrance.${entrance.sourceEntranceId}.${field}`;
      unknown.add(key);
      reasons[key] = entrance.spatialEvidence.unknownReasons?.[field] ?? "missing-value";
    }
  }
  if (workArea) {
    for (const field of workArea.unknown ?? []) {
      const key = `workArea.${workArea.workAreaId}.${field}`;
      unknown.add(key);
      reasons[key] = workArea.unknownReasons?.[field] ?? "missing-value";
    }
  }
  if (!Number.isFinite(site.intersectedBuildingCount) || entrances.some((entry) => !Number.isFinite(entry.spatialEvidence?.collidingBuildingCount)) || (workArea && !Number.isFinite(workArea.intersectedBuildingCount))) {
    unknown.add("affectedBuildingCount");
    reasons.affectedBuildingCount = "one-or-more-selected-geometry-layers-unknown";
  }
  return { unknown: [...unknown].sort(), unknownReasons: reasons };
}

export function createStationDesignFromSite({ site, technicalProfileId, vehicleModelId, selections = {} } = {}) {
  assertStationSite(site);
  if (!technicalProfileId || !vehicleModelId) throw new Error("technicalProfileId and vehicleModelId are required");
  if (selections.connectedPlanId && selections.connectedPlanId !== site.connectedPlanId) throw new Error("Selected plan does not match StationSiteGeometry");
  if (selections.connectedStationId && selections.connectedStationId !== site.connectedStationId) throw new Error("Selected station does not match StationSiteGeometry");

  const assumptions = [];
  const warnings = [];
  const stationPlanId = selections.stationPlanId ?? site.connectedStationId ?? `station-plan:${site.stationSiteId}`;
  const structureId = selections.structureId ?? site.planHints?.structure ?? "surface";
  if (!selections.structureId) assumptions.push({ field: "structureId", assumedValue: structureId, basis: site.planHints?.structure ? "copied plan hint; management decision not supplied" : "concept default" });
  const layoutId = selections.layoutId ?? DEFAULT_LAYOUT_BY_HINT[site.planHints?.platformType] ?? "side-2track";
  if (!selections.layoutId) assumptions.push({ field: "layoutId", assumedValue: layoutId, basis: site.planHints?.platformType ? "mapped from plan platform hint" : "concept default" });
  const stationRole = selections.stationRole ?? (site.planTerminalEnd ? "terminal" : "intermediate");
  const turnbackFacility = selections.turnbackFacility ?? (stationRole === "terminal" ? "crossover" : undefined);
  if (stationRole === "terminal" && !selections.turnbackFacility) assumptions.push({ field: "turnbackFacility", assumedValue: turnbackFacility, basis: "concept terminal operational allowance" });

  const stationPlan = createStationPlan({
    id: stationPlanId,
    name: selections.name ?? site.name ?? stationPlanId,
    technicalProfileId,
    vehicleModelId,
    structureId,
    layoutId,
    stationRole,
    currentCars: selections.currentCars,
    futureCars: selections.futureCars,
    finishedPlatformLengthMeters: selections.finishedPlatformLengthMeters,
    structuralPlatformLengthMeters: selections.structuralPlatformLengthMeters,
    platformWidthMeters: selections.platformWidthMeters,
    platformWidthsMeters: selections.platformWidthsMeters,
    alignment: selections.alignment,
    curveRadiusMeters: selections.curveRadiusMeters,
    operationMode: selections.operationMode,
    stoppingAccuracyMm: selections.stoppingAccuracyMm,
    screenDoorType: selections.screenDoorType,
    screenDoorProfileId: selections.screenDoorProfileId,
    positioningSystem: selections.positioningSystem,
    doorInterlock: selections.doorInterlock,
    platformMonitoring: selections.platformMonitoring,
    emergencyResponsePlan: selections.emergencyResponsePlan,
    platformHeightMm: selections.platformHeightMm,
    turnbackFacility,
    minimumReversalSeconds: selections.minimumReversalSeconds,
  });

  const entrances = chooseEntrances(site, selections, assumptions, warnings);
  const transferLinks = chooseTransfers(site, stationPlan, selections, assumptions);
  const accessPlan = createStationAccessPlan(stationPlan, {
    entrances,
    transferLinks,
    circulation: selections.circulation,
    gates: selections.gates,
    evacuationTargetMinutes: selections.evacuationTargetMinutes,
    accessibilityRequired: selections.accessibilityRequired,
  });
  const selectedWorkArea = chooseWorkArea(site, selections, assumptions);
  const unknown = mergedUnknown(site, entrances, selectedWorkArea);
  const permanentEntranceArea = sum(entrances.map((entrance) => entrance.widthMeters * 12));
  const bodySurfaceArea = ["surface", "elevated"].includes(structureId) ? finite(site.bodyAreaSquareMeters) : 0;
  const workArea = finite(selectedWorkArea?.areaSquareMeters) ?? 0;
  const surfaceAcquisitionAreaSquareMeters = bodySurfaceArea === null ? null : bodySurfaceArea + permanentEntranceArea + workArea;
  const dimensionsConfirmed = site.bodyDimensionBasis?.length === "player" && site.bodyDimensionBasis?.width === "player";
  const constructionShaftAvailable = Boolean(selections.workAreaSecured && selectedWorkArea && isKnownClear(selectedWorkArea));
  if (selections.workAreaSecured && !constructionShaftAvailable) warnings.push({ code: "work-area-not-verifiably-clear", workAreaId: selectedWorkArea?.workAreaId ?? null });

  const constructionContext = createStationConstructionContext({
    stationPlanId: stationPlan.id,
    stationSiteId: site.stationSiteId,
    connectedPlanId: site.connectedPlanId,
    connectedStationId: site.connectedStationId,
    depthMeters: site.plannedDepthMeters,
    availableSurfaceWidthMeters: site.roadWidthMeters,
    surfaceAcquisitionAreaSquareMeters,
    affectedBuildingCount: knownConflictTotal(site, entrances, selectedWorkArea),
    utilityConflictLevel: selections.utilityConflictLevel ?? null,
    groundwaterRisk: selections.groundwaterRisk ?? null,
    softGroundRisk: selections.softGroundRisk ?? null,
    constructionShaftAvailable,
    existingRailwayProximity: selections.existingRailwayProximity ?? null,
    siteBodyLengthMeters: site.bodyLengthMeters,
    siteBodyWidthMeters: site.bodyWidthMeters,
    bodyDimensionsConfirmed: dimensionsConfirmed,
    selectedWorkArea: selectedWorkArea ? { ...clone(selectedWorkArea), secured: constructionShaftAvailable } : null,
    extensionSpace: site.extensionSpace ?? [],
    landUnitCostJpyPerSquareMeter: selections.landUnitCostJpyPerSquareMeter,
    dataQuality: site.dataQuality,
    unknown: unknown.unknown,
    unknownReasons: unknown.unknownReasons,
    sourceStationSite: site,
  });

  return {
    schema: STATION_SITE_ADAPTATION_SCHEMA,
    contractVersion: 1,
    stationSiteId: site.stationSiteId,
    connectedPlanId: site.connectedPlanId,
    connectedStationId: site.connectedStationId,
    stationPlan,
    accessPlan,
    constructionContext,
    adaptation: {
      selectedEntranceIds: entrances.map((entry) => entry.sourceEntranceId).filter(Boolean),
      selectedTransferIds: transferLinks.map((entry) => entry.sourceTransferId),
      selectedWorkAreaId: selectedWorkArea?.workAreaId ?? null,
      workAreaSecured: constructionShaftAvailable,
      assumptions,
      warnings,
    },
  };
}
