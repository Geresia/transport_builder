// Equipment work fronts, spatial side (see docs/construction-workfront-contract.md). A work front is one of a
// ConstructionSiteGeometry's own shaft or work-area candidates, read as the ground a contractor's equipment
// actually stands on: its usable area, slope, nearest major road, building/water/rail overlap, which of the
// site's own shaft/work-area/material-yard candidates sit nearby, and — once the player hand-draws them — its
// assembly and storage sub-areas. The management engine (engine/src/management/**) decides bid cost, contract
// duration, contractor assignment and placement feasibility; this module never imports it and never touches cash
// or construction state.
//
// Missing data: a value that cannot be computed is `null`, its name is in `unknown[]` and the reason is in
// `unknownReasons` — never 0.
import { stableId, round6, roundTo } from "./ids.mjs";
import { makeSpatialContext } from "./spatial.mjs";
import { ringFacts, nearestRoadAt, terrainFacts } from "./construction-site.mjs";
import { frameAt, sub, len, nearestOnSegment, areaAndCentroid, gridSamples, qualityOf, worse } from "./local-geometry.mjs";

export const CONSTRUCTION_WORKFRONT_SCHEMA = "transitline.construction-workfront-geometry/1";
export const CONSTRUCTION_WORKFRONT_EXPORT_SCHEMA = "transitline.construction-workfront-export/1";

// A work front IS one of the site's own physical work spaces (not a route or an access point — those are
// linkedMaterialYardId / the equipment access candidate below).
export const WORKFRONT_CANDIDATE_KINDS = Object.freeze(["shaft", "workArea"]);
const ACCESS_CANDIDATE_KINDS = Object.freeze(["accessRoad", "vehicleAccess"]);

export const WORKFRONT_MODEL = Object.freeze({
  linkRadiusMeters: 60, // a site's own shaft/work-area/material-yard candidate counts as "linked" within this
  accessSearchRadiusMeters: 200, // how far an equipment access point may sit from the work front and still serve it
  majorRoadSearchRadiusMeters: 1500,
  deliveryRoadSearchRadiusMeters: 300, // any-class road: close enough for a delivery truck, not just a major road
  defaultShaftFootprintMeters: 14, // matches construction-site.mjs's nominal shaft-head footprint when a shaft carries none
  steepWorkfrontPercent: 3,
  nearResidentialMeters: 100,
});
const WM = WORKFRONT_MODEL;

const ll6 = ([lon, lat]) => [round6(lon), round6(lat)];
function makeMarks() {
  const unknown = [];
  const reasons = {};
  return { unknown, reasons, mark: (field, reason) => { if (!unknown.includes(field)) unknown.push(field); reasons[field] = reason; } };
}

const ID_FIELD = { shaft: "shaftId", workArea: "workAreaId", materialYard: "materialYardId", accessRoad: "roadAccessId", vehicleAccess: "vehicleAccessId" };
const LIST_FIELD = { shaft: "shaftCandidates", workArea: "workAreaCandidates", materialYard: "materialYardCandidates", accessRoad: "accessRoadCandidates", vehicleAccess: "vehicleAccessCandidates" };

export const workfrontIdFor = (constructionSiteId, candidateRef) => stableId("workfront", constructionSiteId, candidateRef.kind, candidateRef.id);

function findCandidate(site, ref) {
  return ref ? site[LIST_FIELD[ref.kind] ?? ""]?.find((c) => c[ID_FIELD[ref.kind]] === ref.id) ?? null : null;
}
function centroidOf(polygonLL) {
  const frame = frameAt(polygonLL[0]);
  return ll6(frame.ll(areaAndCentroid(polygonLL.map(frame.xy)).centroid));
}
const candidateLocationLL = (c) => c.location ?? (c.polygon ? centroidOf(c.polygon) : null);

// A square polygon around a point candidate that carries no polygon of its own (a shaft).
function squarePolygon(centreLL, sideM) {
  const frame = frameAt(centreLL);
  const h = sideM / 2;
  return [[-h, -h], [h, -h], [h, h], [-h, h]].map(([x, y]) => ll6(frame.ll([x, y])));
}

// Two adjacent edge lengths of a (near-)rectangular ring — exact for the rectangles this module always builds
// (a candidate's own polygon, or squarePolygon above). ponytail: not a true minimum-bounding-rectangle solver;
// would need one if a work front's own outer polygon is ever allowed to be hand-edited into an odd shape.
function rectDims(ring, frame) {
  const xy = ring.map(frame.xy);
  const e0 = len(sub(xy[1], xy[0]));
  const e1 = len(sub(xy[2], xy[1]));
  const [w, l] = e0 <= e1 ? [e0, e1] : [e1, e0];
  return [roundTo(w, 1), roundTo(l, 1)];
}
// The length of the ring edge nearest a point — the "opening" a vehicle at that point would enter through.
function nearestEdgeLength(ring, frame, ptLL) {
  const xy = ring.map(frame.xy);
  const p = frame.xy(ptLL);
  let best = null;
  for (let i = 0; i < xy.length; i++) {
    const a = xy[i], b = xy[(i + 1) % xy.length];
    const d = nearestOnSegment(p, a, b).d;
    if (!best || d < best.d) best = { d, edgeLen: len(sub(b, a)) };
  }
  return best ? roundTo(best.edgeLen, 1) : null;
}
function polygonArea(polygonLL) {
  const frame = frameAt(polygonLL[0]);
  return roundTo(areaAndCentroid(polygonLL.map(frame.xy)).area, 1);
}

// Nearest candidate of `kind` on `site` to `atLL`, within `radiusM` — real absence (no candidate that close) is
// a fact (null), not a missing-data unknown, since the candidate list itself is never missing here.
function nearestOfKind(site, kind, atLL, frame, radiusM) {
  let best = null;
  for (const c of site[LIST_FIELD[kind]] ?? []) {
    const loc = candidateLocationLL(c);
    if (!loc) continue;
    const d = len(sub(frame.xy(loc), frame.xy(atLL)));
    if (d <= radiusM && (!best || d < best.d)) best = { id: c[ID_FIELD[kind]], d };
  }
  return best?.id ?? null;
}

const R = 6371000;
function haversine([lon1, lat1], [lon2, lat2]) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
// Nearest access-road/vehicle-access candidate on `site` to `atLL` (any distance) — used both to resolve a
// player-chosen accessCandidateRef and, absent one, to pick a sensible default.
function nearestAccessCandidate(site, atLL) {
  let best = null;
  for (const kind of ACCESS_CANDIDATE_KINDS) {
    for (const c of site[LIST_FIELD[kind]] ?? []) {
      if (!c.location) continue;
      const d = haversine(atLL, c.location);
      if (!best || d < best.d) best = { kind, id: c[ID_FIELD[kind]], location: c.location, d };
    }
  }
  return best;
}

// drawn: { workfrontId?, constructionSiteId, candidateRef: {kind: "shaft"|"workArea", id},
//          accessCandidateRef?: {kind: "accessRoad"|"vehicleAccess", id},
//          assemblyPolygon?: [[lon,lat]...], storagePolygon?: [[lon,lat]...] }
// ctx:   { pack, spatial, constructionExport }
export function buildConstructionWorkfront(drawn, ctx) {
  const warnings = [];
  if (!drawn.candidateRef || !WORKFRONT_CANDIDATE_KINDS.includes(drawn.candidateRef.kind)) {
    return { workfront: null, warnings: [{ code: "workfront-candidate-kind-invalid", kind: drawn.candidateRef?.kind ?? null }] };
  }
  const exp = ctx.constructionExport;
  const site = exp?.sites?.find((s) => s.constructionSiteId === drawn.constructionSiteId);
  if (!site) return { workfront: null, warnings: [{ code: "connection-construction-site-missing", constructionSiteId: drawn.constructionSiteId ?? null }] };
  const candidate = findCandidate(site, drawn.candidateRef);
  if (!candidate) return { workfront: null, warnings: [{ code: "linked-candidate-missing", kind: drawn.candidateRef.kind, id: drawn.candidateRef.id }] };

  const m = makeMarks();
  const workfrontId = drawn.workfrontId ?? workfrontIdFor(site.constructionSiteId, drawn.candidateRef);

  const polygon = candidate.polygon
    ? candidate.polygon.map(ll6)
    : squarePolygon(candidate.location, candidate.footprintMeters || WM.defaultShaftFootprintMeters);
  const location = candidateLocationLL(candidate);
  const frame = frameAt(polygon[0]);
  const usableAreaSquareMeters = polygonArea(polygon);
  const [minimumWidthMeters, minimumLengthMeters] = rectDims(polygon, frame);

  const spatial = ctx.spatial ?? makeSpatialContext();
  const terrain = terrainFacts(gridSamples(polygon.map(frame.xy)).map(frame.ll), spatial, m.mark);

  const layers = spatial.layers;
  const overlap = ringFacts(polygon, layers, frame, (field, reason) => {
    if (field === "roadsOccupied") return; // not part of this contract
    m.mark(field === "existingFacilityCrossingCount" ? "existingRailwayOverlapCount" : field, reason);
  });

  // --- nearest major road (equipment/spoil-truck reachability) ---
  let nearestMajorRoad = null, majorRoadAccessible = null;
  const nearRoad = nearestRoadAt(location, layers, frame, WM.majorRoadSearchRadiusMeters);
  if (nearRoad.unknown) { m.mark("nearestMajorRoad", nearRoad.unknown); m.mark("majorRoadAccessible", nearRoad.unknown); }
  else {
    nearestMajorRoad = nearRoad.nearestRoad && ["major", "highway"].includes(nearRoad.nearestRoad.roadClass) ? nearRoad.nearestRoad : null;
    if (!nearestMajorRoad) {
      let best = null;
      for (const it of layers.roads?.items ?? []) {
        if (!["major", "highway"].includes(it.cls)) continue;
        const d = nearestRoadAt(location, { roads: { items: [it], covers: layers.roads.covers } }, frame, WM.majorRoadSearchRadiusMeters).nearestRoad;
        if (d && (!best || d.distanceMeters < best.distanceMeters)) best = d;
      }
      nearestMajorRoad = best;
    }
    majorRoadAccessible = nearestMajorRoad ? nearestMajorRoad.distanceMeters <= WM.majorRoadSearchRadiusMeters : false;
  }

  // --- linked candidates: the site's own nearby shaft / work area / material yard (self-links to candidateRef) ---
  const linkedShaftId = nearestOfKind(site, "shaft", location, frame, WM.linkRadiusMeters);
  const linkedWorkAreaId = nearestOfKind(site, "workArea", location, frame, WM.linkRadiusMeters);
  const linkedMaterialYardId = nearestOfKind(site, "materialYard", location, frame, WM.linkRadiusMeters);

  // --- equipment access: a player-chosen access candidate, or the nearest one on this site ---
  let accessCandidate = null;
  if (drawn.accessCandidateRef) {
    const found = findCandidate(site, drawn.accessCandidateRef);
    if (!found) warnings.push({ code: "linked-candidate-missing", kind: drawn.accessCandidateRef.kind, id: drawn.accessCandidateRef.id });
    else accessCandidate = { kind: drawn.accessCandidateRef.kind, id: drawn.accessCandidateRef.id, location: found.location };
  }
  if (!accessCandidate) {
    const near = nearestAccessCandidate(site, location);
    if (near && near.d <= WM.accessSearchRadiusMeters) accessCandidate = near;
  }
  const linkedAccessCandidateRef = accessCandidate ? { kind: accessCandidate.kind, id: accessCandidate.id } : null;

  const entryWidthMeters = accessCandidate ? nearestEdgeLength(polygon, frame, accessCandidate.location) : null;
  if (entryWidthMeters === null) m.mark("entryWidthMeters", "no-connection");
  const turningSpaceSquareMeters = roundTo(Math.PI * (Math.min(minimumWidthMeters, minimumLengthMeters) / 2) ** 2, 1);
  m.mark("roadWidthMeters", layers.roads ? "no-attribute" : "no-layer"); // no pack's road layer carries a width attribute
  m.mark("overheadClearanceMeters", "no-layer"); // no pack has a clearance/canopy-height layer

  // --- staging: assembly/storage are hand-drawn only (never guessed by splitting the work front's own polygon) ---
  let assemblyAreaSquareMeters = null;
  if (Array.isArray(drawn.assemblyPolygon) && drawn.assemblyPolygon.length >= 3) assemblyAreaSquareMeters = polygonArea(drawn.assemblyPolygon.map(ll6));
  else m.mark("assemblyAreaSquareMeters", "not-provided");
  let storageAreaSquareMeters = null;
  if (Array.isArray(drawn.storagePolygon) && drawn.storagePolygon.length >= 3) storageAreaSquareMeters = polygonArea(drawn.storagePolygon.map(ll6));
  else m.mark("storageAreaSquareMeters", "not-provided");

  const spoilRemovalAccess = m.reasons.majorRoadAccessible ? null : majorRoadAccessible;
  if (m.reasons.majorRoadAccessible) m.mark("spoilRemovalAccess", m.reasons.majorRoadAccessible);
  let deliveryAccess = null;
  const nearAny = nearestRoadAt(location, layers, frame, WM.deliveryRoadSearchRadiusMeters);
  if (nearAny.unknown) m.mark("deliveryAccess", nearAny.unknown);
  else deliveryAccess = Boolean(nearAny.nearestRoad);

  const spatialFlags = [];
  if (overlap.intersectedBuildingCount > 0) spatialFlags.push("building-collision");
  if (overlap.waterOverlapCount > 0) spatialFlags.push("water-overlap");
  if (overlap.distanceToResidentialMeters !== null && overlap.distanceToResidentialMeters <= WM.nearResidentialMeters) spatialFlags.push("near-residential");
  if ((terrain.averageSlopePercent ?? -1) >= WM.steepWorkfrontPercent) spatialFlags.push("steep-workfront");
  if (majorRoadAccessible === false) spatialFlags.push("no-major-road-access");

  return {
    workfront: {
      schema: CONSTRUCTION_WORKFRONT_SCHEMA,
      contractVersion: 1,
      workfrontId,
      constructionSiteId: site.constructionSiteId,
      connectedPlanId: site.connectedPlanId ?? null,
      candidateRef: drawn.candidateRef,
      polygon,
      location,
      usableAreaSquareMeters,
      minimumWidthMeters,
      minimumLengthMeters,
      averageSlopePercent: terrain.averageSlopePercent,
      maximumSlopePercent: terrain.maximumSlopePercent,
      nearestMajorRoad,
      majorRoadAccessible,
      intersectedBuildingCount: overlap.intersectedBuildingCount,
      waterOverlapCount: overlap.waterOverlapCount,
      existingRailwayOverlapCount: overlap.existingFacilityCrossingCount,
      distanceToResidentialMeters: overlap.distanceToResidentialMeters,
      residentialBasis: overlap.residentialBasis,
      linkedShaftId,
      linkedWorkAreaId,
      linkedMaterialYardId,
      linkedAccessCandidateRef,
      equipmentAccessFacts: { entryWidthMeters, turningSpaceSquareMeters, overheadClearanceMeters: null, roadWidthMeters: null },
      stagingFacts: { assemblyAreaSquareMeters, storageAreaSquareMeters, spoilRemovalAccess, deliveryAccess },
      spatialFlags,
      dataQuality: worse(qualityOf(m.unknown.length), "medium"),
      unknown: m.unknown,
      unknownReasons: m.reasons,
      sourceLayers: spatial.sources ?? [],
      license: { pack: ctx.pack.manifest?.data?.license ?? null, attribution: ctx.pack.manifest?.data?.attribution ?? [] },
      model: WM,
    },
    warnings,
  };
}

// workfronts: [{ workfrontId?, constructionSiteId, candidateRef, accessCandidateRef?, assemblyPolygon?, storagePolygon? }]
export function buildConstructionWorkfrontExport({ pack, constructionExport, workfronts = [], spatial }) {
  const seen = new Map();
  const warnings = [];
  for (const drawn of workfronts) {
    const { workfront, warnings: w } = buildConstructionWorkfront(drawn, { pack, spatial: spatial ?? makeSpatialContext(), constructionExport });
    if (!workfront) warnings.push({ code: "workfront-no-geometry", workfrontId: drawn.workfrontId ?? null }, ...w);
    else if (seen.has(workfront.workfrontId)) warnings.push({ code: "duplicate-construction-workfront", workfrontId: workfront.workfrontId });
    else { seen.set(workfront.workfrontId, workfront); warnings.push(...w); }
  }
  return {
    schema: CONSTRUCTION_WORKFRONT_EXPORT_SCHEMA,
    packId: pack.manifest?.id ?? "pack",
    packVersion: pack.manifest?.version ?? null,
    workfronts: [...seen.values()].sort((a, b) => (a.workfrontId < b.workfrontId ? -1 : 1)),
    warnings,
  };
}
