import { estimateStationConstruction } from "./station-construction.mjs";
import { createStationPlan } from "./station-planning.mjs";

export const STATION_DESIGN_CHANGE_SCHEMA = "transitline.station-design-change/1";
export const SITE_DESIGN_EDIT_SCHEMA = "transitline.site-design-edit/1";
export const SITE_DESIGN_COLLISION_RESULT_SCHEMA = "transitline.site-design-collision-result/1";

const clone = (value) => structuredClone(value);
const round = (value, digits = 0) => Number(Number(value).toFixed(digits));

function currentRevision(deliveryPackage) {
  return deliveryPackage.geometryRevision ?? `station-design:${deliveryPackage.id}:0`;
}

function assertPackage(deliveryPackage) {
  if (!deliveryPackage?.id || !deliveryPackage.design || !deliveryPackage.estimate || !deliveryPackage.awardedBid) {
    throw new Error("An awarded station delivery package is required");
  }
  if (!["awarded", "underConstruction", "suspended", "testing"].includes(deliveryPackage.status)) {
    throw new Error(`Station design cannot change from ${deliveryPackage.status}`);
  }
}

function assertEdit(deliveryPackage, designEdit) {
  if (designEdit?.schema !== SITE_DESIGN_EDIT_SCHEMA) throw new Error("Invalid SiteDesignEdit schema");
  if (designEdit.status !== "submitted") throw new Error("Only a submitted SiteDesignEdit can request a station design change");
  if (!designEdit.sessionId) throw new Error("SiteDesignEdit sessionId is required");
  if (designEdit.stationSiteId !== deliveryPackage.stationSiteId) throw new Error("SiteDesignEdit station site does not match the delivery package");
  if (designEdit.baseRevision !== currentRevision(deliveryPackage)) throw new Error("SiteDesignEdit base revision does not match the station design");
  const body = designEdit.body;
  if (!body || !Array.isArray(body.location) || body.location.length < 2 || !body.location.every(Number.isFinite)) throw new Error("SiteDesignEdit body location is invalid");
  for (const field of ["headingDegrees", "lengthMeters", "widthMeters", "depthMeters"]) {
    if (!Number.isFinite(body[field])) throw new Error(`SiteDesignEdit body ${field} is invalid`);
  }
  if (body.lengthMeters <= 0 || body.widthMeters <= 0) throw new Error("SiteDesignEdit body dimensions must be positive");
  if (!Array.isArray(designEdit.entranceChanges)) throw new Error("SiteDesignEdit entranceChanges must be an array");
  if (designEdit.workAreaChanges !== undefined && !Array.isArray(designEdit.workAreaChanges)) throw new Error("SiteDesignEdit workAreaChanges must be an array");
}

function collisionAssessment(designEdit, collisionResult) {
  if (collisionResult == null) return { status: "unknown", blocking: false, reasons: ["collision-result-missing"] };
  if (collisionResult.schema !== SITE_DESIGN_COLLISION_RESULT_SCHEMA) throw new Error("Invalid SiteDesignCollisionResult schema");
  if (collisionResult.sessionId !== designEdit.sessionId) throw new Error("Collision result session does not match SiteDesignEdit");
  const entranceResults = new Map((collisionResult.entranceCollisions ?? []).map((entry) => [entry.entranceId, entry.collides]));
  const workAreaResults = new Map((collisionResult.workAreaCollisions ?? []).map((entry) => [entry.workAreaId, entry.collides]));
  const collisionCheckedEntrances = designEdit.entranceChanges.filter((entry) => (entry.action ?? "move") !== "remove");
  const values = [
    collisionResult.bodyCollision,
    ...collisionCheckedEntrances.map((entry) => entranceResults.get(entry.entranceId)),
    ...(designEdit.workAreaChanges ?? []).map((entry) => workAreaResults.get(entry.workAreaId)),
  ];
  const blocking = values.some((value) => value === true);
  const unknown = values.length === 0 || values.some((value) => value === null || value === undefined);
  return {
    status: blocking ? "collision" : unknown ? "unknown" : "clear",
    blocking,
    reasons: blocking ? ["confirmed-spatial-collision"] : unknown ? ["collision-result-partly-unknown"] : [],
  };
}

function normalizedDepth(structureId, depthMeters) {
  if (structureId === "elevated") {
    if (depthMeters > 0) throw new Error("An elevated station cannot have positive underground depth");
    return { depthMeters: 0, trackElevationMeters: Math.abs(depthMeters) };
  }
  if (structureId === "surface") {
    if (Math.abs(depthMeters) > 1e-9) throw new Error("A surface station depth must be zero");
    return { depthMeters: 0, trackElevationMeters: 0 };
  }
  if (depthMeters < 0) throw new Error("An underground station cannot have negative depth");
  return { depthMeters, trackElevationMeters: null };
}

function rebuildStationPlan(deliveryPackage, body) {
  const previous = deliveryPackage.design.stationPlan;
  const previousBodyWidth = deliveryPackage.estimate.quantities.bodyWidthMeters;
  const previousPlatformWidth = previous.platforms.reduce((total, platform) => total + platform.widthMeters, 0);
  const trackEnvelopeWidth = previousBodyWidth - previousPlatformWidth;
  const targetPlatformWidth = body.widthMeters - trackEnvelopeWidth;
  if (!(targetPlatformWidth > 0)) throw new Error("Edited station body is too narrow for the track envelope");
  const platformWidthsMeters = previous.platforms.map((platform) => targetPlatformWidth * platform.widthMeters / previousPlatformWidth);
  if (platformWidthsMeters.some((width, index) => width + 1e-9 < previous.platforms[index].minimumWidthMeters)) {
    throw new Error("Edited station body is too narrow for minimum platform widths");
  }
  const structuralPlatformLengthMeters = body.lengthMeters - 20;
  if (structuralPlatformLengthMeters + 1e-9 < previous.finishedPlatformLengthMeters) {
    throw new Error("Edited station body is too short for the finished platform");
  }
  return createStationPlan({
    id: previous.id,
    name: previous.name,
    stationRole: previous.stationRole,
    technicalProfileId: previous.technicalProfileId,
    vehicleModelId: previous.designVehicleModelId,
    structureId: previous.structureId,
    layoutId: previous.layoutId,
    currentCars: previous.currentCars,
    futureCars: previous.futureCars,
    finishedPlatformLengthMeters: previous.finishedPlatformLengthMeters,
    structuralPlatformLengthMeters,
    platformWidthsMeters,
    alignment: previous.alignment,
    curveRadiusMeters: previous.curveRadiusMeters,
    operationMode: previous.operationMode,
    stoppingAccuracyMm: previous.stoppingAccuracyMm,
    screenDoorType: previous.screenDoor.id,
    screenDoorProfileId: previous.screenDoor.profileId,
    positioningSystem: previous.positioningSystem,
    doorInterlock: previous.doorInterlock,
    platformMonitoring: previous.platformMonitoring,
    emergencyResponsePlan: previous.emergencyResponsePlan,
    platformHeightMm: previous.platformHeightMm,
    turnbackFacility: previous.turnback.facility,
    minimumReversalSeconds: previous.turnback.minimumReversalSeconds,
    state: previous.state,
  });
}

function revisedDesign(deliveryPackage, designEdit) {
  const result = clone(deliveryPackage.design);
  const body = designEdit.body;
  const elevation = normalizedDepth(result.stationPlan.structureId, body.depthMeters);
  result.stationPlan = rebuildStationPlan(deliveryPackage, body);
  const context = result.constructionContext;
  context.depthMeters = elevation.depthMeters;
  context.siteBodyLengthMeters = body.lengthMeters;
  context.siteBodyWidthMeters = body.widthMeters;
  context.bodyDimensionsConfirmed = true;
  if (context.sourceStationSite) {
    context.sourceStationSite.bodyLocation = clone(body.location);
    context.sourceStationSite.bodyHeadingDegrees = body.headingDegrees;
    context.sourceStationSite.bodyLengthMeters = body.lengthMeters;
    context.sourceStationSite.bodyWidthMeters = body.widthMeters;
    context.sourceStationSite.bodyAreaSquareMeters = round(body.lengthMeters * body.widthMeters, 3);
    context.sourceStationSite.plannedDepthMeters = elevation.depthMeters;
    context.sourceStationSite.plannedTrackElevationMeters = elevation.trackElevationMeters;
    context.sourceStationSite.bodyDimensionBasis = { length: "player", width: "player" };
  }
  const entrances = new Map(result.accessPlan.entrances.map((entry) => [entry.sourceEntranceId ?? entry.id, entry]));
  let entranceSetChanged = false;
  for (const change of designEdit.entranceChanges) {
    const action = change?.action ?? "move";
    if (!change?.entranceId || !["move", "add", "remove"].includes(action)) throw new Error("SiteDesignEdit entrance change is invalid");
    if (action !== "remove" && (!Array.isArray(change.location) || change.location.length < 2 || !change.location.every(Number.isFinite))) throw new Error("SiteDesignEdit entrance change is invalid");
    const entrance = entrances.get(change.entranceId);
    if (action === "add") {
      if (entrance) throw new Error(`Duplicate station entrance ${change.entranceId}`);
      const added = {
        id: change.entranceId,
        sourceEntranceId: change.entranceId,
        name: null,
        location: clone(change.location),
        widthMeters: 3,
        walkDistanceMeters: 120,
        accessible: false,
        demandShare: 0,
        open: true,
        publicLand: null,
        publicLandEvidence: null,
        spatialEvidence: { dataQuality: "low", unknown: ["spatial-collision", "publicLand"], unknownReasons: { "spatial-collision": "pending-parent-map-result", publicLand: "no-parcel-data" } },
      };
      result.accessPlan.entrances.push(added);
      entrances.set(change.entranceId, added);
      entranceSetChanged = true;
    } else if (action === "remove") {
      if (!entrance) throw new Error(`Unknown station entrance ${change.entranceId}`);
      result.accessPlan.entrances = result.accessPlan.entrances.filter((entry) => entry !== entrance);
      entrances.delete(change.entranceId);
      entranceSetChanged = true;
    } else {
      if (!entrance) throw new Error(`Unknown station entrance ${change.entranceId}`);
      entrance.location = clone(change.location);
    }
  }
  if (!result.accessPlan.entrances.length) throw new Error("A station design must retain at least one entrance");
  if (entranceSetChanged) {
    const added = new Set(designEdit.entranceChanges.filter((entry) => entry.action === "add").map((entry) => entry.entranceId));
    const addedCount = result.accessPlan.entrances.filter((entry) => added.has(entry.sourceEntranceId ?? entry.id)).length;
    const existing = result.accessPlan.entrances.filter((entry) => !added.has(entry.sourceEntranceId ?? entry.id));
    const existingTotal = existing.reduce((total, entry) => total + Math.max(0, entry.demandShare ?? 0), 0);
    const newShare = addedCount ? 1 / result.accessPlan.entrances.length : 0;
    const existingBudget = 1 - newShare * addedCount;
    for (const entrance of result.accessPlan.entrances) {
      if (added.has(entrance.sourceEntranceId ?? entrance.id)) entrance.demandShare = newShare;
      else entrance.demandShare = existingTotal > 0 ? Math.max(0, entrance.demandShare ?? 0) / existingTotal * existingBudget : existingBudget / existing.length;
    }
  }

  const siteWorkAreas = new Map((context.sourceStationSite?.workAreaCandidates ?? []).map((entry) => [entry.workAreaId, entry]));
  for (const change of designEdit.workAreaChanges ?? []) {
    if (!change?.workAreaId || !Array.isArray(change.polygon) || change.polygon.length < 3 || !change.polygon.every((point) => Array.isArray(point) && point.length >= 2 && point.every(Number.isFinite))) {
      throw new Error("SiteDesignEdit work-area change is invalid");
    }
    const workArea = siteWorkAreas.get(change.workAreaId);
    if (!workArea) throw new Error(`Unknown station work area ${change.workAreaId}`);
    const oldArea = Number.isFinite(workArea.areaSquareMeters) ? workArea.areaSquareMeters : null;
    const newArea = polygonAreaSquareMeters(change.polygon);
    workArea.polygon = clone(change.polygon);
    workArea.areaSquareMeters = round(newArea, 1);
    if (context.selectedWorkArea?.workAreaId === change.workAreaId) {
      context.selectedWorkArea.polygon = clone(change.polygon);
      context.selectedWorkArea.areaSquareMeters = round(newArea, 1);
      if (oldArea !== null && Number.isFinite(context.surfaceAcquisitionAreaSquareMeters)) {
        context.surfaceAcquisitionAreaSquareMeters = Math.max(0, context.surfaceAcquisitionAreaSquareMeters - oldArea + newArea);
      }
    }
  }
  return result;
}

function polygonAreaSquareMeters(polygon) {
  const latitude = polygon.reduce((total, point) => total + point[1], 0) / polygon.length;
  const xFactor = 111_320 * Math.cos(latitude * Math.PI / 180);
  const yFactor = 110_540;
  const origin = polygon[0];
  let twiceArea = 0;
  for (let index = 0; index < polygon.length; index++) {
    const sourceA = polygon[index];
    const sourceB = polygon[(index + 1) % polygon.length];
    const a = [(sourceA[0] - origin[0]) * xFactor, (sourceA[1] - origin[1]) * yFactor];
    const b = [(sourceB[0] - origin[0]) * xFactor, (sourceB[1] - origin[1]) * yFactor];
    twiceArea += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(twiceArea) / 2;
}

function contractReprice(deliveryPackage, revisedEstimate) {
  const p50Factor = deliveryPackage.awardedBid.priceP50 / deliveryPackage.estimate.costs.totalP50;
  const p90Factor = deliveryPackage.awardedBid.priceP90 / deliveryPackage.estimate.costs.totalP90;
  const durationFactor = deliveryPackage.awardedBid.durationMonths / deliveryPackage.estimate.schedule.durationP90Months;
  const priceP50 = round(revisedEstimate.costs.totalP50 * p50Factor);
  const priceP90 = round(revisedEstimate.costs.totalP90 * p90Factor);
  const durationMonths = Math.max(1, Math.ceil(revisedEstimate.schedule.durationP90Months * durationFactor));
  return {
    priceP50,
    priceP90,
    durationMonths,
    deltaP50: priceP50 - deliveryPackage.awardedBid.priceP50,
    deltaP90: priceP90 - deliveryPackage.awardedBid.priceP90,
    deltaMonths: durationMonths - deliveryPackage.awardedBid.durationMonths,
  };
}

export function proposeStationDesignChange({ id, deliveryPackage, project, designEdit, collisionResult = null, countryProfile, clock = { minute: 0 } } = {}) {
  if (!id) throw new Error("Station design change id is required");
  assertPackage(deliveryPackage);
  assertEdit(deliveryPackage, designEdit);
  if (!project?.stationDeliveryPackages?.some((entry) => entry.id === deliveryPackage.id)) throw new Error("Station package is not integrated into the project");
  if (!countryProfile) throw new Error("Country profile is required");
  if ((deliveryPackage.designChanges ?? []).some((entry) => entry.id === id || (entry.sessionId === designEdit.sessionId && entry.status !== "rejected"))) throw new Error("Duplicate station design change");
  if ((deliveryPackage.designChanges ?? []).some((entry) => entry.status === "proposed")) throw new Error("A station design change is already awaiting approval");

  const design = revisedDesign(deliveryPackage, designEdit);
  const estimate = estimateStationConstruction({
    stationPlan: design.stationPlan,
    accessPlan: design.accessPlan,
    context: design.constructionContext,
    countryProfile,
    methodId: deliveryPackage.methodId,
  });
  const repricedContract = contractReprice(deliveryPackage, estimate);
  const collision = collisionAssessment(designEdit, collisionResult);
  const nextRevisionNumber = (deliveryPackage.designRevision ?? 0) + 1;
  const proposal = {
    schema: STATION_DESIGN_CHANGE_SCHEMA,
    contractVersion: 1,
    id,
    packageId: deliveryPackage.id,
    projectId: project.id,
    stationSiteId: deliveryPackage.stationSiteId,
    sessionId: designEdit.sessionId,
    baseRevision: currentRevision(deliveryPackage),
    proposedRevision: `station-design:${deliveryPackage.id}:${nextRevisionNumber}`,
    status: "proposed",
    submittedAtMinute: clock.minute,
    decidedAtMinute: null,
    designEdit: clone(designEdit),
    collision,
    estimateBefore: clone(deliveryPackage.estimate),
    estimateAfter: clone(estimate),
    contractBefore: clone(deliveryPackage.awardedBid),
    contractAfter: { ...clone(deliveryPackage.awardedBid), priceP50: repricedContract.priceP50, priceP90: repricedContract.priceP90, durationMonths: repricedContract.durationMonths },
    costDeltaP50: repricedContract.deltaP50,
    costDeltaP90: repricedContract.deltaP90,
    durationDeltaMonths: repricedContract.deltaMonths,
    revisedDesign: design,
    violations: clone(estimate.violations ?? []),
    conditions: clone(estimate.conditions ?? []),
  };
  deliveryPackage.geometryRevision ??= currentRevision(deliveryPackage);
  deliveryPackage.designRevision ??= 0;
  deliveryPackage.designChanges ??= [];
  deliveryPackage.designChanges.push(proposal);
  return clone(proposal);
}

function requireProposal(deliveryPackage, changeId) {
  const proposal = deliveryPackage.designChanges?.find((entry) => entry.id === changeId);
  if (!proposal) throw new Error(`Unknown station design change ${changeId}`);
  return proposal;
}

export function approveStationDesignChange({ deliveryPackage, project, changeId, clock = { minute: 0 } } = {}) {
  assertPackage(deliveryPackage);
  const proposal = requireProposal(deliveryPackage, changeId);
  if (proposal.status !== "proposed") throw new Error(`Station design change cannot be approved from ${proposal.status}`);
  if (proposal.baseRevision !== currentRevision(deliveryPackage)) throw new Error("Station design changed after this proposal was created");
  if (proposal.collision.blocking) throw new Error("Station design change has a confirmed spatial collision");
  if (proposal.collision.status !== "clear") throw new Error("Station design change collision review is incomplete");
  if (proposal.violations.length) throw new Error("Station design change has unresolved design violations");
  const nextP50 = project.estimate.totalP50 + proposal.costDeltaP50;
  const nextP90 = project.estimate.totalP90 + proposal.costDeltaP90;
  if (nextP50 < project.paid) throw new Error("Station design savings cannot reduce the project estimate below paid construction cost");
  if (nextP50 < 0 || nextP90 < 0) throw new Error("Station design change would make the project estimate negative");

  deliveryPackage.design = clone(proposal.revisedDesign);
  deliveryPackage.estimate = clone(proposal.estimateAfter);
  deliveryPackage.awardedBid = clone(proposal.contractAfter);
  deliveryPackage.unresolvedViolations = clone(proposal.violations);
  deliveryPackage.unresolvedConditions = clone(proposal.conditions);
  deliveryPackage.designRevision = (deliveryPackage.designRevision ?? 0) + 1;
  deliveryPackage.geometryRevision = proposal.proposedRevision;
  deliveryPackage.statusHistory.push({ status: deliveryPackage.status, atMinute: clock.minute, reason: `design-change:${proposal.id}` });
  proposal.status = "approved";
  proposal.decidedAtMinute = clock.minute;

  project.estimate.totalP50 = nextP50;
  project.estimate.totalP90 = nextP90;
  project.estimate.durationMonths = Math.max(project.estimate.durationMonths, proposal.contractAfter.durationMonths);
  const replacement = project.estimate.stationDetailReplacement;
  if (replacement) {
    replacement.awardedP50 += proposal.costDeltaP50;
    replacement.awardedP90 += proposal.costDeltaP90;
    replacement.deltaP50 = replacement.awardedP50 - replacement.legacyP50;
    replacement.deltaP90 = replacement.awardedP90 - replacement.legacyP90;
  }
  return clone(proposal);
}

export function rejectStationDesignChange(deliveryPackage, changeId, reason = "Not approved", clock = { minute: 0 }) {
  assertPackage(deliveryPackage);
  const proposal = requireProposal(deliveryPackage, changeId);
  if (proposal.status !== "proposed") throw new Error(`Station design change cannot be rejected from ${proposal.status}`);
  proposal.status = "rejected";
  proposal.decidedAtMinute = clock.minute;
  proposal.rejectionReason = String(reason || "Not approved");
  return clone(proposal);
}

export function stationDesignChangeSummary(deliveryPackage) {
  return clone(deliveryPackage.designChanges ?? []);
}
