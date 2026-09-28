// Construction work packages: pure spatial facts for the management engine (see docs/construction-site-contract.md).
// A package is a player-defined slice of a plan — a run of segments built as one tunnel / cut-and-cover / viaduct /
// systems package — or a station or depot package. Each carries its corridor (or site) polygon, candidate shafts,
// work areas, material yards, construction-road and vehicle-delivery access points, crossings, building/water
// overlap and DEM terrain. Cost, duration, incident probability, complaint score and construction-method choice
// belong to the management engine; this module never imports it and never touches cash or construction state.
//
// Missing data: a value that cannot be computed is `null`, its name is in `unknown[]` and the reason is in
// `unknownReasons` — never 0. A layer that covers the place and finds nothing is a fact (0 / [] / null without an
// `unknown` entry).
import { haversineMetres } from "../projection.mjs";
import { stableId, round6, roundTo, coordKey } from "./ids.mjs";
import { bboxOf, closed, overlaps, polylineHitsPolygon, polylineLength, properCross, ringsOverlap, makeSpatialContext } from "./spatial.mjs";
import { withRailLayer } from "./plan-geometry.mjs";
import { canonicalRing } from "./depot-site.mjs";
import { frameAt, sub, len, nearestOnPolyline, distRingRing, areaAndCentroid, gridSamples, boundarySamples, qualityOf, worse } from "./local-geometry.mjs";

export const CONSTRUCTION_SITE_SCHEMA = "transitline.construction-site-geometry/1";
export const CONSTRUCTION_EXPORT_SCHEMA = "transitline.construction-export/1";

export const PACKAGE_KINDS = Object.freeze(["tunnel", "cutCover", "viaduct", "systems", "station", "depot"]);
const LINE_KINDS = new Set(["tunnel", "cutCover", "viaduct", "systems"]);

// Every number below is echoed in each site as `model`, so a reader can reproduce it. A corridor is a rough
// ribbon buffer around the alignment (see ribbonPolygon), not a real excavation outline — the width is a
// stand-in for "how much ground this kind of work needs", not an engineering design.
export const CONSTRUCTION_MODEL = Object.freeze({
  corridorHalfWidthMeters: { tunnel: 9, cutCover: 12, viaduct: 10, systems: 6 },
  stationPadMeters: 60, // a construction footprint placeholder around a station package with no body of its own
  depotPadMeters: 40,
  workAreaMeters: { alongMeters: 40, acrossMeters: 30 },
  materialYardMeters: { alongMeters: 60, acrossMeters: 40 },
  materialYardSpacingMeters: 300,
  maxMaterialYards: 3,
  roadSearchRadiusMeters: 80,
  maxAccessCandidates: 3,
  candidateMinSpacingMeters: 30,
  residentialSearchRadiusMeters: 300,
  adjacentFacilityMeters: 100,
  steepCorridorPercent: 3,
  nearResidentialMeters: 100,
  maxCrossingLocations: 10,
});
const CM = CONSTRUCTION_MODEL;
const GROUND_UNKNOWN = Object.freeze(["groundwater", "soft-ground", "utilities"]);
const RESIDENTIAL_KINDS = new Set(["apartments", "house", "residential", "detached", "dormitory", "terrace", "semidetached_house", "bungalow"]);

const ll6 = ([lon, lat]) => [round6(lon), round6(lat)];
const finite = (v) => typeof v === "number" && Number.isFinite(v);

export const keyedConstructionSiteId = (packId, key) => stableId("cons", packId, "key", key);

function makeMarks() {
  const unknown = [];
  const reasons = {};
  return { unknown, reasons, mark: (field, reason) => { if (!unknown.includes(field)) unknown.push(field); reasons[field] = reason; } };
}

// --- small planar helpers kept local to this module (see local-geometry.mjs for the shared ones) ---
const rectXY = (c, u, v, along, across, offAlong = 0, offAcross = 0) => {
  const cx = c[0] + u[0] * offAlong + v[0] * offAcross;
  const cy = c[1] + u[1] * offAlong + v[1] * offAcross;
  const a = along / 2, b = across / 2;
  return [[-a, -b], [a, -b], [a, b], [-a, b]].map(([s, t]) => [cx + u[0] * s + v[0] * t, cy + u[1] * s + v[1] * t]);
};
// A buffered "corridor" around a centerline: left offset forward, right offset backward, halfWidth metres, with
// mitred normals at interior vertices. Not a proper polygon buffer — a sharp bend can pinch or cross the ribbon,
// which shows up as a smaller or odd corridor area, never a larger one. Good enough for near-straight alignments.
function ribbonPolygon(xyPts, halfWidth) {
  if (xyPts.length < 2) {
    const [cx, cy] = xyPts[0] ?? [0, 0];
    return [[cx - halfWidth, cy - halfWidth], [cx + halfWidth, cy - halfWidth], [cx + halfWidth, cy + halfWidth], [cx - halfWidth, cy + halfWidth]];
  }
  const edgeNormals = [];
  for (let i = 0; i < xyPts.length - 1; i++) {
    const d = sub(xyPts[i + 1], xyPts[i]);
    const l = len(d) || 1;
    edgeNormals.push([-d[1] / l, d[0] / l]);
  }
  const normalAt = (i) => {
    if (i === 0) return edgeNormals[0];
    if (i === xyPts.length - 1) return edgeNormals.at(-1);
    const a = edgeNormals[i - 1], b = edgeNormals[i];
    const sum = [a[0] + b[0], a[1] + b[1]];
    const l = len(sum) || 1;
    return [sum[0] / l, sum[1] / l];
  };
  const side = (sign) => xyPts.map((p, i) => { const n = normalAt(i); return [p[0] + n[0] * halfWidth * sign, p[1] + n[1] * halfWidth * sign]; });
  return [...side(1), ...side(-1).reverse()];
}
// Where segments p->q and r->s cross (call only when properCross(p,q,r,s) is true).
function crossPoint(p, q, r, s) {
  const d1 = sub(q, p), d2 = sub(s, r);
  const denom = d1[0] * d2[1] - d1[1] * d2[0];
  const t = ((r[0] - p[0]) * d2[1] - (r[1] - p[1]) * d2[0]) / denom;
  return [p[0] + d1[0] * t, p[1] + d1[1] * t];
}
function pointAtDistance(xyPts, dist) {
  let acc = 0;
  for (let i = 1; i < xyPts.length; i++) {
    const seg = sub(xyPts[i], xyPts[i - 1]);
    const segLen = len(seg) || 1e-9;
    if (acc + segLen >= dist || i === xyPts.length - 1) {
      const t = Math.max(0, Math.min(1, (dist - acc) / segLen));
      return { point: [xyPts[i - 1][0] + seg[0] * t, xyPts[i - 1][1] + seg[1] * t], u: [seg[0] / segLen, seg[1] / segLen] };
    }
    acc += segLen;
  }
  return null;
}
const growBox = (box, m, frame) => { const [dx, dy] = frame.ll([m, m]).map((v, i) => v - frame.ll([0, 0])[i]); return [box[0] - dx, box[1] - dy, box[2] + dx, box[3] + dy]; };

// --- shared facts over a ring (any package kind that has a polygon) --- (exported: construction-impact.mjs reuses
// this for the same overlap facts over an event's affected polygon, so the two contracts stay consistent)
export function ringFacts(ring, layers, frame, mark) {
  const covered = (layer, pts) => !layer.covers || pts.every((p) => layer.covers(p));
  const overlapCount = (layer, field, hit) => {
    if (!ring) { mark(field, "no-polygon"); return null; }
    if (!layer) { mark(field, "no-layer"); return null; }
    if (!covered(layer, ring)) { mark(field, "outside-coverage"); return null; }
    return layer.items.filter((it) => overlaps(bboxOf(ring), it.bbox) && hit(it)).length;
  };
  const intersectedBuildingCount = overlapCount(layers.buildings, "intersectedBuildingCount", (it) => ringsOverlap(ring, it.rings[0]));
  const waterOverlapCount = overlapCount(layers.water, "waterOverlapCount", (it) => ringsOverlap(ring, it.rings[0]));
  const existingFacilityCrossingCount = overlapCount(layers.railFacilities, "existingFacilityCrossingCount", (it) => ringsOverlap(ring, it.rings[0]));

  let roadsOccupied = null;
  if (!ring) mark("roadsOccupied", "no-polygon");
  else if (!layers.roads) mark("roadsOccupied", "no-layer");
  else if (!covered(layers.roads, ring)) mark("roadsOccupied", "outside-coverage");
  else {
    roadsOccupied = { highway: 0, major: 0, minor: 0 };
    const box = bboxOf(ring);
    for (const it of layers.roads.items) if (overlaps(box, it.bbox) && polylineHitsPolygon(it.line, [ring])) roadsOccupied[it.cls] = (roadsOccupied[it.cls] ?? 0) + 1;
  }

  let distanceToResidentialMeters = null, residentialBasis = null;
  if (!ring) mark("distanceToResidentialMeters", "no-polygon");
  else {
    const xyRing = ring.map(frame.xy);
    const resBox = growBox(bboxOf(ring), CM.residentialSearchRadiusMeters, frame);
    const sources = [
      layers.residential && covered(layers.residential, ring) ? { basis: "landuse-residential", items: layers.residential.items } : null,
      layers.buildings && covered(layers.buildings, ring) ? { basis: "building-tag", items: layers.buildings.items.filter((it) => RESIDENTIAL_KINDS.has(it.kind)) } : null,
    ].filter(Boolean);
    if (!sources.length) mark("distanceToResidentialMeters", layers.residential || layers.buildings ? "outside-coverage" : "no-layer");
    for (const src of sources) {
      for (const it of src.items) {
        if (!overlaps(resBox, it.bbox)) continue;
        const d = distRingRing(xyRing, it.rings[0].map(frame.xy));
        if (d <= CM.residentialSearchRadiusMeters && (distanceToResidentialMeters === null || d < distanceToResidentialMeters)) { distanceToResidentialMeters = d; residentialBasis = src.basis; }
      }
    }
    if (distanceToResidentialMeters !== null) distanceToResidentialMeters = roundTo(distanceToResidentialMeters, 1);
  }
  return { intersectedBuildingCount, waterOverlapCount, existingFacilityCrossingCount, roadsOccupied, distanceToResidentialMeters, residentialBasis };
}

// --- terrain over a sample of points (a ring's grid, or points along a centerline) --- (exported:
// construction-workfront.mjs reuses this for a work front's own slope/elevation facts)
export function terrainFacts(samplePointsLL, spatial, mark) {
  const dem = spatial.layers.dem;
  const reason = dem ? "no-dem-value" : "no-layer";
  const slopes = samplePointsLL.map((p) => spatial.slopeAt(p));
  const elevs = samplePointsLL.map((p) => spatial.elevationAt(p));
  const pct = dem?.slopeAt && slopes.every((v) => v !== null) ? slopes.map((d) => Math.tan((d * Math.PI) / 180) * 100) : null;
  const elevOk = dem && elevs.every((v) => v !== null);
  if (!pct) { mark("averageSlopePercent", reason); mark("maximumSlopePercent", reason); }
  if (!elevOk) { mark("groundElevationMeters", reason); mark("elevationRangeMeters", reason); }
  return {
    groundElevationMeters: elevOk ? roundTo(elevs.reduce((s, v) => s + v, 0) / elevs.length, 1) : null,
    elevationRangeMeters: elevOk ? roundTo(Math.max(...elevs) - Math.min(...elevs), 1) : null,
    averageSlopePercent: pct ? roundTo(pct.reduce((s, v) => s + v, 0) / pct.length, 2) : null,
    maximumSlopePercent: pct ? roundTo(Math.max(...pct), 2) : null,
  };
}

// --- crossings along a centerline (line-kind packages only): count of distinct items, plus their crossing points ---
// `count` is how many distinct items the centerline crosses (an item crossed twice, entering and leaving, counts
// once — the same convention spatial.mjs's crossings() uses); `locations` lists every crossing point found, capped.
// `reason` is set (and count/locations are null) when the layer is missing or does not cover the centerline.
function centerlineCrossings(layer, itemGeom, itemClass, centerlineLL, frame) {
  if (!layer) return { count: null, locations: null, reason: "no-layer" };
  if (!(!layer.covers || centerlineLL.every(layer.covers))) return { count: null, locations: null, reason: "outside-coverage" };
  const cl = centerlineLL.map(frame.xy);
  let count = 0;
  const locations = [];
  for (const it of layer.items) {
    const other = itemGeom(it).map(frame.xy);
    let hit = false;
    for (let i = 1; i < cl.length; i++) {
      for (let j = 1; j < other.length; j++) {
        if (properCross(cl[i - 1], cl[i], other[j - 1], other[j])) {
          hit = true;
          if (locations.length < CM.maxCrossingLocations) locations.push({ location: ll6(frame.ll(crossPoint(cl[i - 1], cl[i], other[j - 1], other[j]))), class: itemClass(it) });
        }
      }
    }
    if (hit) count++;
  }
  return { count, locations, reason: null };
}

// --- candidate sites: work areas, material yards, construction-road access, vehicle delivery access ---
// (nearestRoadAt is exported too: construction-impact.mjs uses it for "가장 가까운 주요 도로")
export function nearestRoadAt(pt, layers, frame, searchM) {
  if (!layers.roads) return { nearestRoad: null, unknown: "no-layer" };
  if (!(!layers.roads.covers || layers.roads.covers(pt))) return { nearestRoad: null, unknown: "outside-coverage" };
  const px = frame.xy(pt);
  let best = null;
  for (const it of layers.roads.items) {
    const d = nearestOnPolyline(px, it.line.map(frame.xy)).d;
    if (d <= searchM && (!best || d < best.d)) best = { d, cls: it.cls };
  }
  return { nearestRoad: best ? { roadClass: best.cls, distanceMeters: roundTo(best.d, 1) } : null, unknown: null };
}
// Boundary points nearest a road, spaced apart; `wantMajor` restricts to major/highway (a vehicle needs a real road).
function accessCandidates(ring, frame, layers, prefix, siteId, wantMajor) {
  if (!ring) return { list: [], unknown: "no-polygon" };
  if (!layers.roads) return { list: [], unknown: "no-layer" };
  const samples = boundarySamples(ring.map(frame.xy)).map(frame.ll);
  const scored = samples
    .map((pt) => ({ pt, ...nearestRoadAt(pt, layers, frame, CM.roadSearchRadiusMeters) }))
    .filter((x) => x.nearestRoad && (!wantMajor || ["major", "highway"].includes(x.nearestRoad.roadClass)));
  scored.sort((a, b) => a.nearestRoad.distanceMeters - b.nearestRoad.distanceMeters || (coordKey(a.pt) < coordKey(b.pt) ? -1 : 1));
  const picked = [];
  for (const s of scored) {
    if (picked.length >= CM.maxAccessCandidates) break;
    if (picked.some((p) => haversineMetres(p.pt, s.pt) < CM.candidateMinSpacingMeters)) continue;
    picked.push(s);
  }
  return {
    list: picked.map((s) => ({ [`${prefix}Id`]: stableId(prefix, siteId, coordKey(s.pt)), location: ll6(s.pt), nearestRoad: s.nearestRoad })),
    unknown: null,
  };
}
function outwardAt(xyPts, end) {
  const [a, b] = end === "start" ? [xyPts[1], xyPts[0]] : [xyPts.at(-2), xyPts.at(-1)];
  const d = sub(b, a);
  const l = len(d) || 1;
  return { p: end === "start" ? xyPts[0] : xyPts.at(-1), u: [d[0] / l, d[1] / l] };
}
function lineWorkAreas(centerlineLL, frame, siteId) {
  const cl = centerlineLL.map(frame.xy);
  if (cl.length < 2) return [];
  const { alongMeters, acrossMeters } = CM.workAreaMeters;
  return ["start", "end"].map((end) => {
    const { p, u } = outwardAt(cl, end);
    const v = [u[1], -u[0]];
    const c = [p[0] + (u[0] * alongMeters) / 2, p[1] + (u[1] * alongMeters) / 2];
    const ring = canonicalRing(rectXY(c, u, v, alongMeters, acrossMeters).map(frame.ll));
    return ring && { workAreaId: stableId("work", siteId, end), slot: end, polygon: ring, areaSquareMeters: roundTo(alongMeters * acrossMeters, 1) };
  }).filter(Boolean);
}
function lineMaterialYards(centerlineLL, halfWidth, frame, siteId) {
  const cl = centerlineLL.map(frame.xy);
  if (cl.length < 2) return [];
  const total = cl.slice(1).reduce((s, p, i) => s + len(sub(p, cl[i])), 0);
  const { alongMeters, acrossMeters } = CM.materialYardMeters;
  const n = Math.max(1, Math.min(CM.maxMaterialYards, Math.floor(total / CM.materialYardSpacingMeters) + 1));
  const out = [];
  for (let k = 0; k < n; k++) {
    const at = pointAtDistance(cl, n === 1 ? total / 2 : (k * total) / (n - 1));
    if (!at) continue;
    const v = [at.u[1], -at.u[0]];
    const c = [at.point[0] + v[0] * (halfWidth + acrossMeters / 2), at.point[1] + v[1] * (halfWidth + acrossMeters / 2)];
    const ring = canonicalRing(rectXY(c, at.u, v, alongMeters, acrossMeters).map(frame.ll));
    if (ring) out.push({ materialYardId: stableId("yard", siteId, k), polygon: ring, areaSquareMeters: roundTo(alongMeters * acrossMeters, 1) });
  }
  return out;
}
// Four cardinal-direction candidates around a pad (station / depot packages have no natural track heading to align to).
function cardinalWorkAreas(centre, frame, siteId, { alongMeters, acrossMeters }, prefix = "work") {
  return [["N", [0, 1]], ["E", [1, 0]], ["S", [0, -1]], ["W", [-1, 0]]].map(([label, u]) => {
    const v = [u[1], -u[0]];
    const c = [centre[0] + u[0] * alongMeters, centre[1] + u[1] * alongMeters];
    const ring = canonicalRing(rectXY(c, u, v, alongMeters, acrossMeters).map(frame.ll));
    return ring && { [`${prefix}Id`]: stableId(prefix, siteId, label), slot: label, polygon: ring, areaSquareMeters: roundTo(alongMeters * acrossMeters, 1) };
  }).filter(Boolean);
}
function shaftCandidates(segments, centerlineLL, frame, spatial, siteId) {
  if (!segments.length) return [];
  const ends = [
    { key: "start", location: centerlineLL[0], trackElevation: segments[0].elevationStartMeters },
    { key: "end", location: centerlineLL.at(-1), trackElevation: segments.at(-1).elevationEndMeters },
  ];
  return ends.map(({ key, location, trackElevation }) => {
    const ground = spatial.elevationAt(location);
    const m = makeMarks();
    if (ground === null) m.mark("groundElevationMeters", spatial.layers.dem ? "no-dem-value" : "no-layer");
    if (!finite(trackElevation)) m.mark("plannedTrackElevationMeters", "no-depth");
    const depth = ground !== null && finite(trackElevation) ? roundTo(ground - trackElevation, 1) : null;
    if (depth === null) m.mark("shaftDepthMeters", m.reasons.groundElevationMeters ?? "no-depth");
    return {
      shaftId: stableId("shaft", siteId, key), end: key, location: ll6(location),
      groundElevationMeters: ground === null ? null : roundTo(ground, 1),
      plannedTrackElevationMeters: finite(trackElevation) ? trackElevation : null,
      shaftDepthMeters: depth,
      footprintMeters: 14, // a nominal shaft-head footprint, not a design
      unknown: m.unknown, unknownReasons: m.reasons,
    };
  });
}

// --- kind-specific builders, sharing the facts/candidates helpers above ---
function assemble({ constructionSiteId, packId, ctx, kind, name, ring, centerlineLL, segments, connected, m, warnings }) {
  const spatial = ctx.spatial;
  const layers = spatial.layers;
  const frame = frameAt(ring ? ring[0] : centerlineLL ? centerlineLL[0] : connected.location);
  const facts = ringFacts(ring, layers, frame, m.mark);
  const samplePoints = centerlineLL ?? (ring ? gridSamples(ring.map(frame.xy)).map(frame.ll) : [connected.location]);
  const terrain = terrainFacts(samplePoints, spatial, m.mark);

  const markBoth = (countField, listField, reason) => { if (reason) { m.mark(countField, reason); m.mark(listField, reason); } };
  let waterCrossings = null, roadCrossings = null, existingRailwayCrossings = null;
  if (centerlineLL) {
    waterCrossings = centerlineCrossings(layers.water, (it) => closed(it.rings[0]), () => undefined, centerlineLL, frame);
    roadCrossings = centerlineCrossings(layers.roads, (it) => it.line, (it) => it.cls, centerlineLL, frame);
    existingRailwayCrossings = centerlineCrossings(layers.rail, (it) => it.line, () => undefined, centerlineLL, frame);
    markBoth("waterCrossingCount", "waterCrossings", waterCrossings.reason);
    markBoth("roadCrossingCount", "roadCrossings", roadCrossings.reason);
    markBoth("existingRailwayCrossingCount", "existingRailwayCrossings", existingRailwayCrossings.reason);
  }

  const halfWidth = kind in CM.corridorHalfWidthMeters ? CM.corridorHalfWidthMeters[kind] : null;
  let workAreaCandidates, materialYardCandidates;
  if (centerlineLL) {
    workAreaCandidates = lineWorkAreas(centerlineLL, frame, constructionSiteId);
    materialYardCandidates = lineMaterialYards(centerlineLL, halfWidth ?? 8, frame, constructionSiteId);
  } else {
    const centre = ring ? areaAndCentroid(ring.map(frame.xy)).centroid : [0, 0];
    workAreaCandidates = cardinalWorkAreas(centre, frame, constructionSiteId, CM.workAreaMeters, "work");
    materialYardCandidates = cardinalWorkAreas(centre, frame, constructionSiteId, CM.materialYardMeters, "yard").slice(0, 1);
  }
  if (!ring) { m.mark("workAreaCandidates", "no-polygon"); m.mark("materialYardCandidates", "no-polygon"); }
  const roadAccess = accessCandidates(ring, frame, layers, "roadAccess", constructionSiteId, false);
  const vehicleAccess = accessCandidates(ring, frame, layers, "vehicleAccess", constructionSiteId, true);
  if (roadAccess.unknown) m.mark("accessRoadCandidates", roadAccess.unknown);
  if (vehicleAccess.unknown) m.mark("vehicleAccessCandidates", vehicleAccess.unknown);
  const shafts = kind === "tunnel" && segments ? shaftCandidates(segments, centerlineLL, frame, spatial, constructionSiteId) : [];

  const spatialFlags = [];
  if (facts.intersectedBuildingCount > 0) spatialFlags.push("building-collision");
  if (facts.waterOverlapCount > 0) spatialFlags.push("water-overlap");
  if (facts.existingFacilityCrossingCount > 0) spatialFlags.push("existing-facility-overlap");
  if (facts.distanceToResidentialMeters !== null && facts.distanceToResidentialMeters <= CM.nearResidentialMeters) spatialFlags.push("near-residential");
  if ((terrain.averageSlopePercent ?? -1) >= CM.steepCorridorPercent) spatialFlags.push("steep-corridor");
  if ((waterCrossings?.count ?? 0) > 0) spatialFlags.push("crosses-water");
  if ((existingRailwayCrossings?.count ?? 0) > 0) spatialFlags.push("crosses-existing-railway");

  const areaSquareMeters = ring ? roundTo(areaAndCentroid(ring.map(frame.xy)).area, 1) : null;
  const lengthMeters = centerlineLL ? roundTo(polylineLength(centerlineLL), 1) : null;
  if (!ring) m.mark("areaSquareMeters", "no-polygon");
  if (LINE_KINDS.has(kind) && !centerlineLL) m.mark("lengthMeters", "no-connection");

  return {
    schema: CONSTRUCTION_SITE_SCHEMA,
    contractVersion: 1,
    constructionSiteId,
    sourcePackId: packId,
    sourcePackVersion: ctx.pack.manifest?.version ?? null,
    kind,
    name: name ?? null,
    coordinateReference: "EPSG:4326",
    connectedPlanId: connected.planId,
    connectedSegmentIds: connected.segmentIds,
    connectedStationId: connected.stationId,
    connectedDepotSiteId: connected.depotSiteId,
    polygon: ring,
    areaSquareMeters,
    lengthMeters,
    ...terrain,
    intersectedBuildingCount: facts.intersectedBuildingCount,
    waterOverlapCount: facts.waterOverlapCount,
    roadsOccupied: facts.roadsOccupied,
    existingFacilityCrossingCount: facts.existingFacilityCrossingCount,
    distanceToResidentialMeters: facts.distanceToResidentialMeters,
    residentialBasis: facts.residentialBasis,
    residentialSearchRadiusMeters: CM.residentialSearchRadiusMeters,
    waterCrossingCount: waterCrossings?.count ?? null,
    waterCrossings: waterCrossings?.locations ?? null,
    roadCrossingCount: roadCrossings?.count ?? null,
    roadCrossings: roadCrossings?.locations ?? null,
    existingRailwayCrossingCount: existingRailwayCrossings?.count ?? null,
    existingRailwayCrossings: existingRailwayCrossings?.locations ?? null,
    shaftCandidates: shafts,
    workAreaCandidates,
    materialYardCandidates,
    accessRoadCandidates: roadAccess.list,
    vehicleAccessCandidates: vehicleAccess.list,
    spatialFlags,
    model: CM,
    // ground data does not exist in any pack yet (constraintUnknown), so quality never reads "high"
    dataQuality: worse(qualityOf(m.unknown.length), "medium"),
    unknown: m.unknown,
    unknownReasons: m.reasons,
    constraintUnknown: [...GROUND_UNKNOWN],
    warnings,
    sourceLayers: spatial.sources ?? [],
    license: { pack: ctx.pack.manifest?.data?.license ?? null, attribution: ctx.pack.manifest?.data?.attribution ?? [] },
  };
}

function buildLinePackage(drawn, ctx, packId, kind) {
  const warnings = [];
  const plans = ctx.plans ?? [];
  const plan = plans.find((p) => p.planId === drawn.planId);
  if (!plan) { warnings.push({ code: "connection-plan-missing", planId: drawn.planId ?? null }); return { site: null, warnings }; }
  const order = plan.segments.map((s) => s.id);
  const wanted = [...new Set(drawn.segmentIds ?? [])];
  for (const id of wanted) if (!order.includes(id)) warnings.push({ code: "connection-segment-missing", planId: plan.planId, segmentId: id });
  const ids = order.filter((id) => wanted.includes(id));
  if (!ids.length) { warnings.push({ code: "construction-no-segments" }); return { site: null, warnings }; }
  const idxs = ids.map((id) => order.indexOf(id));
  if (!idxs.every((v, i) => i === 0 || v === idxs[i - 1] + 1)) warnings.push({ code: "package-not-contiguous", planId: plan.planId });
  const segments = ids.map((id) => plan.segments.find((s) => s.id === id));

  const centerlineLL = [];
  for (const s of segments) for (const p of s.alignment) { if (centerlineLL.length && coordKey(p) === coordKey(centerlineLL.at(-1))) continue; centerlineLL.push(p); }

  const constructionSiteId = drawn.key != null ? keyedConstructionSiteId(packId, drawn.key) : stableId("cons", packId, "shape", kind, plan.planId, ...ids);
  const frame = frameAt(centerlineLL[0]);
  const halfWidth = CM.corridorHalfWidthMeters[kind];
  const ring = canonicalRing(ribbonPolygon(centerlineLL.map(frame.xy), halfWidth).map(frame.ll));
  if (!ring) warnings.push({ code: "corridor-degenerate" });
  const m = makeMarks();
  const site = assemble({
    constructionSiteId, packId, ctx, kind, name: drawn.name, ring, centerlineLL, segments,
    connected: { planId: plan.planId, segmentIds: ids, stationId: null, depotSiteId: null }, m, warnings,
  });
  return { site, warnings };
}

function buildStationPackage(drawn, ctx, packId) {
  const warnings = [];
  const plans = ctx.plans ?? [];
  const plan = plans.find((p) => p.planId === drawn.planId);
  if (!plan) { warnings.push({ code: "connection-plan-missing", planId: drawn.planId ?? null }); return { site: null, warnings }; }
  const station = plan.stationCandidates.find((s) => s.id === drawn.stationId);
  if (!station) { warnings.push({ code: "connection-station-missing", planId: plan.planId, stationId: drawn.stationId ?? null }); return { site: null, warnings }; }
  const constructionSiteId = drawn.key != null ? keyedConstructionSiteId(packId, drawn.key) : stableId("cons", packId, "shape", "station", plan.planId, station.id);
  const frame = frameAt(station.location);
  const half = CM.stationPadMeters / 2;
  const ring = canonicalRing([[-half, -half], [half, -half], [half, half], [-half, half]].map(([x, y]) => frame.ll([x, y])));
  const m = makeMarks();
  const site = assemble({
    constructionSiteId, packId, ctx, kind: "station", name: drawn.name, ring, centerlineLL: null, segments: null,
    connected: { planId: plan.planId, segmentIds: [], stationId: station.id, depotSiteId: null, location: station.location }, m, warnings,
  });
  return { site, warnings };
}

function buildDepotPackage(drawn, ctx, packId) {
  const warnings = [];
  const depot = ctx.depotExport?.sites?.find((s) => s.depotSiteId === drawn.depotSiteId);
  if (!depot) { warnings.push({ code: "connection-depot-missing", depotSiteId: drawn.depotSiteId ?? null }); return { site: null, warnings }; }
  const constructionSiteId = drawn.key != null ? keyedConstructionSiteId(packId, drawn.key) : stableId("cons", packId, "shape", "depot", depot.depotSiteId);
  const frame = frameAt(depot.location);
  let ring = depot.polygon;
  if (!ring) {
    const half = CM.depotPadMeters / 2;
    ring = canonicalRing([[-half, -half], [half, -half], [half, half], [-half, half]].map(([x, y]) => frame.ll([x, y])));
  }
  const m = makeMarks();
  const site = assemble({
    constructionSiteId, packId, ctx, kind: "depot", name: drawn.name, ring, centerlineLL: null, segments: null,
    connected: { planId: depot.connectedPlanId, segmentIds: depot.connectedSegmentId ? [depot.connectedSegmentId] : [], stationId: null, depotSiteId: depot.depotSiteId, location: depot.location }, m, warnings,
  });
  return { site, warnings };
}

// drawn: { key?, name?, kind, planId?, segmentIds?: string[], stationId?, depotSiteId? }
// ctx:   { pack, spatial, plans, externalNetworks, depotExport? }
export function buildConstructionSite(drawn, ctx) {
  const packId = ctx.pack.manifest?.id ?? "pack";
  const spatial = ctx.spatial ?? makeSpatialContext();
  const kind = PACKAGE_KINDS.includes(drawn.kind) ? drawn.kind : null;
  if (!kind) return { site: null, warnings: [{ code: "package-kind-invalid", kind: drawn.kind ?? null }] };
  const withSpatial = { ...ctx, spatial };
  if (kind === "depot") return buildDepotPackage(drawn, withSpatial, packId);
  if (kind === "station") return buildStationPackage(drawn, withSpatial, packId);
  return buildLinePackage(drawn, withSpatial, packId, kind);
}

// mapExport: the result of buildMapExport (plans + externalNetworks). depotExport: buildDepotExport's result, if
// depot packages are used. Connections are checked against both.
export function buildConstructionExport({ pack, mapExport, depotExport = null, packages = [], spatial }) {
  const context = withRailLayer(spatial, mapExport.externalNetworks);
  const sites = new Map();
  const warnings = [];
  for (const drawn of packages) {
    const { site, warnings: siteWarnings } = buildConstructionSite(drawn, { pack, spatial: context, plans: mapExport.plans, externalNetworks: mapExport.externalNetworks, depotExport });
    if (!site) warnings.push({ code: "construction-no-geometry", name: drawn.name ?? null, kind: drawn.kind ?? null }, ...siteWarnings);
    else if (sites.has(site.constructionSiteId)) warnings.push({ code: "duplicate-construction-site", constructionSiteId: site.constructionSiteId });
    else { sites.set(site.constructionSiteId, site); warnings.push(...siteWarnings); }
  }
  return {
    schema: CONSTRUCTION_EXPORT_SCHEMA,
    packId: pack.manifest?.id ?? "pack",
    packVersion: pack.manifest?.version ?? null,
    sites: [...sites.values()].sort((a, b) => (a.constructionSiteId < b.constructionSiteId ? -1 : 1)),
    warnings,
  };
}
