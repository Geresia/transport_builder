// Depot candidate sites: pure spatial facts for the management engine (see docs/depot-site-contract.md).
// Area, distances, slope, crossings, building and residential context — nothing else. Land price, cost,
// resident opposition, negotiation, deadhead cost, schedule and any site score belong to the management
// engine; this module never imports it and never touches cash or construction state.
//
// Missing data: a value that cannot be computed is `null`, its name is in `unknown[]` and the reason is
// in `unknownReasons` — never 0.
import { haversineMetres } from "../projection.mjs";
import { stableId, round6, roundTo, coordKey } from "./ids.mjs";
import { bboxOf, overlaps, inRing, properCross, polylineHitsPolygon, polylineLength, ringsOverlap, makeSpatialContext } from "./spatial.mjs";
import { withRailLayer } from "./plan-geometry.mjs";
import { frameAt, sub, len, nearestOnPolyline, distPointRing, distRingRing, areaAndCentroid, gridSamples, boundarySamples, qualityOf, worse } from "./local-geometry.mjs";

export const DEPOT_SITE_SCHEMA = "transitline.depot-site-geometry/1";
export const DEPOT_EXPORT_SCHEMA = "transitline.depot-export/1";

const RESIDENTIAL_SEARCH_M = 2000;
const DENSITY_RADIUS_M = 300;
const ADJACENT_M = 200;
const STEEP_SITE_PERCENT = 3; // yard tracks want to be near-flat; a spatial flag, not a score
const NEAR_RESIDENTIAL_M = 100;
const GROUND_UNKNOWN = Object.freeze(["groundwater", "soft-ground"]);
// OSM building=* values that mean people live there
const RESIDENTIAL_KINDS = new Set(["apartments", "house", "residential", "detached", "dormitory", "terrace", "semidetached_house", "bungalow"]);

// A site the player drew and saved has a key; its id follows the key, not the shape, so moving or redrawing keeps it.
export const keyedDepotSiteId = (packId, key) => stableId("depot", packId, "key", key);

// Same parcel -> same ring: rounded, de-duplicated, counter-clockwise, starting at the lowest vertex.
export function canonicalRing(points) {
  const rounded = points.map(([lon, lat]) => [round6(lon), round6(lat)]);
  const r = rounded.filter((p, i) => i === 0 || coordKey(p) !== coordKey(rounded[i - 1]));
  if (r.length > 1 && coordKey(r[0]) === coordKey(r.at(-1))) r.pop();
  if (r.length < 3) return null;
  // signed area x2, relative to the first vertex so large absolute coordinates do not cancel each other out
  const rel = r.map((p) => [p[0] - r[0][0], p[1] - r[0][1]]);
  const twice = rel.reduce((s, p, i) => s + (p[0] * rel[(i + 1) % rel.length][1] - rel[(i + 1) % rel.length][0] * p[1]), 0);
  if (twice === 0) return null;
  if (twice < 0) r.reverse();
  let k = 0;
  r.forEach((p, i) => { if (p[0] < r[k][0] || (p[0] === r[k][0] && p[1] < r[k][1])) k = i; });
  return [...r.slice(k), ...r.slice(0, k)];
}
function selfIntersects(ring) {
  const n = ring.length;
  for (let i = 0; i < n; i++) for (let j = i + 2; j < n; j++) {
    if (i === 0 && j === n - 1) continue;
    if (properCross(ring[i], ring[(i + 1) % n], ring[j], ring[(j + 1) % n])) return true;
  }
  return false;
}

// drawn: { key?, name?, polygon?: [[lon,lat]...], location?: [lon,lat],
//          connect?: { planId?, segmentId?, externalNetworkId?, externalLineId?, via?: [[lon,lat]...] } }
// ctx:   { pack, spatial, plans, externalNetworks }
export function buildDepotSite(drawn, ctx) {
  const packId = ctx.pack.manifest?.id ?? "pack";
  const spatial = ctx.spatial ?? makeSpatialContext();
  const plans = ctx.plans ?? [];
  const externalNetworks = ctx.externalNetworks ?? [];
  const layers = spatial.layers;
  const warnings = [];
  const unknown = [];
  const reasons = {};
  const mark = (field, reason) => { if (!unknown.includes(field)) unknown.push(field); reasons[field] = reason; };

  // --- geometry ---
  let ring = drawn.polygon ? canonicalRing(drawn.polygon) : null;
  if (drawn.polygon && !ring) warnings.push({ code: "polygon-degenerate" });
  if (ring && selfIntersects(ring)) { warnings.push({ code: "polygon-self-intersecting" }); ring = null; }
  let locationIn = drawn.location;
  if (!ring && !locationIn && drawn.polygon?.length) locationIn = [drawn.polygon.reduce((s, p) => s + p[0], 0) / drawn.polygon.length, drawn.polygon.reduce((s, p) => s + p[1], 0) / drawn.polygon.length];
  if (!ring && !locationIn) return null;

  const frame = frameAt(ring ? [ring.reduce((s, p) => s + p[0], 0) / ring.length, ring.reduce((s, p) => s + p[1], 0) / ring.length] : locationIn);
  const xyRing = ring ? ring.map(frame.xy) : null;
  const ac = xyRing ? areaAndCentroid(xyRing) : null;
  const location = (ring ? frame.ll(ac.centroid) : locationIn).map(round6);
  const at = frame.xy(location);
  const areaSquareMeters = ac ? roundTo(ac.area, 1) : null;
  if (!ring) { mark("areaSquareMeters", "no-polygon"); mark("polygon", "no-polygon"); }

  const depotSiteId = drawn.key !== undefined && drawn.key !== null
    ? keyedDepotSiteId(packId, drawn.key)
    : ring ? stableId("depot", packId, "shape", ...ring.map(coordKey)) : stableId("depot", packId, "point", coordKey(location));

  const distToSite = (xy) => (xyRing ? distPointRing(xy, xyRing) : len(sub(xy, at)));
  const covered = (layer, pts) => !layer.covers || pts.every((p) => layer.covers(p));
  const siteBox = bboxOf(ring ?? [location]);
  // the parcel's bounding box grown by `m` metres on every side
  const boxWithin = (m) => {
    const [dLon, dLat] = frame.ll([m, m]).map((v, i) => v - frame.ll([0, 0])[i]);
    return [siteBox[0] - dLon, siteBox[1] - dLat, siteBox[2] + dLon, siteBox[3] + dLat];
  };
  const around = [...(ring ?? [location]), location, ...[[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dy]) => frame.ll([at[0] + dx * DENSITY_RADIUS_M, at[1] + dy * DENSITY_RADIUS_M]))];

  // --- mainline connection ---
  const c = drawn.connect ?? null;
  const conn = { planId: null, segmentId: null, externalNetworkId: null, externalLineId: null, basis: null };
  let mainline = null;
  let terminals = [];
  if (c?.planId) {
    const plan = plans.find((p) => p.planId === c.planId);
    if (!plan) warnings.push({ code: "connection-plan-missing", planId: c.planId });
    else {
      let seg = c.segmentId ? plan.segments.find((s) => s.id === c.segmentId) : null;
      if (c.segmentId && !seg) warnings.push({ code: "connection-segment-missing", planId: c.planId, segmentId: c.segmentId });
      if (!c.segmentId) seg = plan.segments.map((s) => ({ s, d: nearestOnPolyline(at, s.alignment.map(frame.xy)).d })).sort((a, b) => a.d - b.d || (a.s.id < b.s.id ? -1 : 1))[0]?.s;
      if (seg) {
        mainline = seg.alignment;
        Object.assign(conn, { planId: plan.planId, segmentId: seg.id, basis: c.segmentId ? "plan-segment" : "nearest-segment" });
        terminals = [plan.stationCandidates[0], plan.stationCandidates.at(-1)].map((s) => ({ id: s.id, location: s.location }));
      }
    }
  } else if (c?.externalLineId) {
    const net = externalNetworks.find((n) => (!c.externalNetworkId || n.id === c.externalNetworkId) && n.lines.some((l) => l.id === c.externalLineId));
    const line = net?.lines.find((l) => l.id === c.externalLineId);
    if (!line) warnings.push({ code: "connection-line-missing", externalLineId: c.externalLineId });
    else {
      const byId = new Map(net.stations.map((s) => [s.id, s.location]));
      mainline = line.stationIds.map((id) => byId.get(id)).filter(Boolean);
      terminals = [line.stationIds[0], line.stationIds.at(-1)].map((id) => ({ id, location: byId.get(id) })).filter((t) => t.location);
      Object.assign(conn, { externalNetworkId: net.id, externalLineId: line.id, basis: "external-line" });
    }
  } else if (c) warnings.push({ code: "connection-target-missing" });

  let alignment = null, attach = null, distanceToMainlineMeters = null, connectionTrackLengthMeters = null;
  let distanceToTerminalMeters = null, terminalStationId = null;
  if (mainline) {
    const main = mainline.map(frame.xy);
    const via = (c.via ?? []).map((p) => [round6(p[0]), round6(p[1])]);
    const gates = xyRing ? boundarySamples(xyRing) : [at];
    let gate, attachXY;
    if (via.length) {
      const target = frame.xy(via[0]);
      gate = gates.reduce((b, p) => (!b || len(sub(p, target)) < len(sub(b, target)) ? p : b), null);
      attachXY = nearestOnPolyline(frame.xy(via.at(-1)), main).point;
    } else {
      const best = gates.map((p) => ({ p, n: nearestOnPolyline(p, main) })).reduce((b, x) => (!b || x.n.d < b.n.d ? x : b), null);
      gate = best.p;
      attachXY = best.n.point;
    }
    alignment = [gate, ...via.map(frame.xy), attachXY].map((p, i, all) => (i > 0 && i < all.length - 1 && via.length ? via[i - 1] : frame.ll(p).map(round6)));
    attach = alignment.at(-1);
    distanceToMainlineMeters = roundTo(haversineMetres(alignment[0], attach), 1);
    connectionTrackLengthMeters = roundTo(polylineLength(alignment), 1);
    const t = terminals.map((s) => ({ s, d: haversineMetres(location, s.location) })).sort((a, b) => a.d - b.d || (a.s.id < b.s.id ? -1 : 1))[0];
    if (t) { distanceToTerminalMeters = roundTo(t.d, 1); terminalStationId = t.s.id; }
    else { mark("distanceToTerminalMeters", "no-terminal"); }
  } else {
    for (const f of ["connectionTrackLengthMeters", "distanceToMainlineMeters", "distanceToTerminalMeters"]) mark(f, c ? "connection-unresolved" : "no-connection");
  }

  // --- nearest station, planned or existing ---
  const stations = [
    ...plans.flatMap((p) => p.stationCandidates.map((s) => ({ id: s.id, kind: "plan", location: s.location }))),
    ...externalNetworks.flatMap((n) => n.stations.map((s) => ({ id: s.id, kind: "external", location: s.location }))),
  ].map((s) => ({ ...s, d: distToSite(frame.xy(s.location)) })).sort((a, b) => a.d - b.d || (a.id < b.id ? -1 : 1));
  const nearest = stations[0] ?? null;
  if (!nearest) { mark("distanceToNearestStationMeters", "no-stations"); mark("nearestStationId", "no-stations"); }

  // --- terrain ---
  const sampleLL = (xyRing ? gridSamples(xyRing) : [at]).map((p) => frame.ll(p));
  const slopes = sampleLL.map((p) => spatial.slopeAt(p));
  const elevs = sampleLL.map((p) => spatial.elevationAt(p));
  const demReason = layers.dem ? "no-dem-value" : "no-layer";
  const pct = layers.dem?.slopeAt && slopes.every((v) => v !== null) ? slopes.map((d) => Math.tan((d * Math.PI) / 180) * 100) : null;
  const elevOk = layers.dem && elevs.every((v) => v !== null);
  if (!pct) { mark("averageSlopePercent", demReason); mark("maximumSlopePercent", demReason); }
  if (!elevOk) { mark("groundElevationMeters", demReason); mark("elevationRangeMeters", demReason); }

  // --- what the parcel overlaps: needs a polygon and a layer that covers it ---
  const overlapCount = (layer, field, hit) => {
    if (!ring) { mark(field, "no-polygon"); return null; }
    if (!layer) { mark(field, "no-layer"); return null; }
    if (!covered(layer, [...ring, location])) { mark(field, "outside-coverage"); return null; }
    return layer.items.filter((it) => overlaps(siteBox, it.bbox) && hit(it)).length;
  };
  const intersectedBuildingCount = overlapCount(layers.buildings, "intersectedBuildingCount", (it) => ringsOverlap(ring, it.rings[0]));
  const waterOverlapCount = overlapCount(layers.water, "waterOverlapCount", (it) => ringsOverlap(ring, it.rings[0]));
  let roadsThroughSite = null;
  if (!ring) mark("roadsThroughSite", "no-polygon");
  else if (!layers.roads) mark("roadsThroughSite", "no-layer");
  else if (!covered(layers.roads, [...ring, location])) mark("roadsThroughSite", "outside-coverage");
  else {
    roadsThroughSite = { highway: 0, major: 0, minor: 0 };
    for (const it of layers.roads.items) if (overlaps(siteBox, it.bbox) && polylineHitsPolygon(it.line, [ring])) roadsThroughSite[it.cls] = (roadsThroughSite[it.cls] ?? 0) + 1;
  }

  // --- the connection track's crossings ---
  let connectionCrossings = null, roadCrossingCount = null, waterCrossingCount = null;
  if (alignment) {
    connectionCrossings = spatial.crossings(alignment);
    waterCrossingCount = connectionCrossings.river;
    roadCrossingCount = connectionCrossings.road === null ? null : Object.values(connectionCrossings.road).reduce((s, n) => s + n, 0);
    if (waterCrossingCount === null) mark("waterCrossingCount", layers.water ? "outside-coverage" : "no-layer");
    if (roadCrossingCount === null) mark("roadCrossingCount", layers.roads ? "outside-coverage" : "no-layer");
  } else {
    mark("waterCrossingCount", "no-connection");
    mark("roadCrossingCount", "no-connection");
  }

  // --- residential distance and surrounding building density ---
  const resBox = boxWithin(RESIDENTIAL_SEARCH_M);
  let distanceToResidentialMeters = null;
  let residentialBasis = null;
  const resSources = [
    layers.residential && covered(layers.residential, around) ? { basis: "landuse-residential", items: layers.residential.items } : null,
    layers.buildings && covered(layers.buildings, around) ? { basis: "building-tag", items: layers.buildings.items.filter((it) => RESIDENTIAL_KINDS.has(it.kind)) } : null,
  ].filter(Boolean);
  if (!resSources.length) mark("distanceToResidentialMeters", layers.residential || layers.buildings ? "outside-coverage" : "no-layer");
  for (const src of resSources) {
    for (const it of src.items) {
      if (!overlaps(resBox, it.bbox)) continue;
      const other = it.rings[0].map(frame.xy);
      const d = xyRing ? distRingRing(xyRing, other) : distPointRing(at, other);
      if (d <= RESIDENTIAL_SEARCH_M && (distanceToResidentialMeters === null || d < distanceToResidentialMeters)) { distanceToResidentialMeters = d; residentialBasis = src.basis; }
    }
  }
  if (distanceToResidentialMeters !== null) distanceToResidentialMeters = roundTo(distanceToResidentialMeters, 1);

  let surroundingBuildingCount = null, surroundingBuildingDensity = null;
  if (!layers.buildings) { mark("surroundingBuildingCount", "no-layer"); mark("surroundingBuildingDensity", "no-layer"); }
  else if (!covered(layers.buildings, around)) { mark("surroundingBuildingCount", "outside-coverage"); mark("surroundingBuildingDensity", "outside-coverage"); }
  else {
    const densBox = boxWithin(DENSITY_RADIUS_M);
    surroundingBuildingCount = 0;
    for (const it of layers.buildings.items) {
      if (!overlaps(densBox, it.bbox)) continue;
      const mid = frame.xy([(it.bbox[0] + it.bbox[2]) / 2, (it.bbox[1] + it.bbox[3]) / 2]);
      if (distToSite(mid) <= DENSITY_RADIUS_M && !(ring && ringsOverlap(ring, it.rings[0]))) surroundingBuildingCount++;
    }
    const perimeter = xyRing ? xyRing.reduce((s, p, i) => s + len(sub(xyRing[(i + 1) % xyRing.length], p)), 0) : 0;
    const bufferKm2 = ((ac?.area ?? 0) + perimeter * DENSITY_RADIUS_M + Math.PI * DENSITY_RADIUS_M ** 2) / 1e6; // Steiner: area + P*r + pi*r^2
    surroundingBuildingDensity = roundTo(surroundingBuildingCount / bufferKm2, 1);
  }

  // --- existing rail land ---
  let existingFacilityReuse = null;
  if (!layers.railFacilities) mark("existingFacilityReuse", "no-layer");
  else if (!covered(layers.railFacilities, around)) mark("existingFacilityReuse", "outside-coverage");
  else {
    const facilities = [];
    const adjBox = boxWithin(ADJACENT_M);
    for (const it of layers.railFacilities.items) {
      if (!overlaps(adjBox, it.bbox)) continue;
      const other = it.rings[0].map(frame.xy);
      const inside = xyRing ? xyRing.every((p) => inRing(p, other)) : inRing(at, other);
      const overlap = inside || (xyRing ? ringsOverlap(ring, it.rings[0]) : false);
      const d = overlap ? 0 : xyRing ? distRingRing(xyRing, other) : distPointRing(at, other);
      const relation = inside ? "within" : overlap ? "overlaps" : d <= ADJACENT_M ? "adjacent" : null;
      if (relation) facilities.push({ id: it.id ?? stableId("fac", ...it.rings[0].slice(0, 3).map(coordKey)), kind: it.kind ?? "railway-land", relation, distanceMeters: roundTo(d, 1) });
    }
    facilities.sort((a, b) => a.distanceMeters - b.distanceMeters || (a.id < b.id ? -1 : 1));
    existingFacilityReuse = { status: ["within", "overlaps", "adjacent"].find((r) => facilities.some((f) => f.relation === r)) ?? "none", facilities: facilities.slice(0, 5) };
  }

  // --- spatial flags: facts about the parcel, not scores ---
  const spatialFlags = [];
  if (intersectedBuildingCount > 0) spatialFlags.push("building-overlap");
  if (waterOverlapCount > 0) spatialFlags.push("water-overlap");
  if (pct && pct.reduce((s, v) => s + v, 0) / pct.length >= STEEP_SITE_PERCENT) spatialFlags.push("steep-site");
  if (distanceToResidentialMeters !== null && distanceToResidentialMeters <= NEAR_RESIDENTIAL_M) spatialFlags.push("near-residential");
  if (waterCrossingCount > 0) spatialFlags.push("connection-crosses-water");
  if (connectionCrossings?.building > 0) spatialFlags.push("connection-through-buildings");

  return {
    schema: DEPOT_SITE_SCHEMA,
    contractVersion: 1,
    depotSiteId,
    sourcePackId: packId,
    sourcePackVersion: ctx.pack.manifest?.version ?? null,
    name: drawn.name ?? null,
    geometryKind: ring ? "polygon" : "point",
    location,
    polygon: ring,
    areaSquareMeters,
    connectedPlanId: conn.planId,
    connectedSegmentId: conn.segmentId,
    connectedExternalNetworkId: conn.externalNetworkId,
    connectedExternalLineId: conn.externalLineId,
    connectionBasis: conn.basis,
    connectionAlignment: alignment,
    connectionAttachPoint: attach,
    connectionTrackLengthMeters,
    distanceToMainlineMeters,
    terminalStationId,
    distanceToTerminalMeters,
    nearestStationId: nearest?.id ?? null,
    nearestStationKind: nearest?.kind ?? null,
    distanceToNearestStationMeters: nearest ? roundTo(nearest.d, 1) : null,
    groundElevationMeters: elevOk ? roundTo(elevs.reduce((s, v) => s + v, 0) / elevs.length, 1) : null,
    elevationRangeMeters: elevOk ? roundTo(Math.max(...elevs) - Math.min(...elevs), 1) : null,
    averageSlopePercent: pct ? roundTo(pct.reduce((s, v) => s + v, 0) / pct.length, 2) : null,
    maximumSlopePercent: pct ? roundTo(Math.max(...pct), 2) : null,
    intersectedBuildingCount,
    waterOverlapCount,
    roadsThroughSite,
    connectionCrossings,
    roadCrossingCount,
    waterCrossingCount,
    distanceToResidentialMeters,
    residentialBasis,
    residentialSearchRadiusMeters: RESIDENTIAL_SEARCH_M,
    surroundingBuildingCount,
    surroundingBuildingDensity, // buildings per km2 within densityRadiusMeters of the parcel (Steiner buffer area)
    densityRadiusMeters: DENSITY_RADIUS_M,
    existingFacilityReuse,
    spatialFlags,
    // ground data does not exist in any pack yet (constraintUnknown), so quality never reads "high"
    dataQuality: worse(qualityOf(unknown.filter((f) => f !== "polygon").length), "medium"),
    unknown,
    unknownReasons: reasons,
    constraintUnknown: [...GROUND_UNKNOWN],
    warnings,
    sourceLayers: spatial.sources,
    license: { pack: ctx.pack.manifest?.data?.license ?? null, attribution: ctx.pack.manifest?.data?.attribution ?? [] },
  };
}

// mapExport: the result of buildMapExport (plans + externalNetworks). Connections are checked against its ids.
export function buildDepotExport({ pack, mapExport, depots = [], spatial }) {
  const context = withRailLayer(spatial, mapExport.externalNetworks);
  const sites = new Map();
  const warnings = [];
  for (const drawn of depots) {
    const site = buildDepotSite(drawn, { pack, spatial: context, plans: mapExport.plans, externalNetworks: mapExport.externalNetworks });
    if (!site) warnings.push({ code: "depot-no-geometry", name: drawn.name ?? null });
    else if (sites.has(site.depotSiteId)) warnings.push({ code: "duplicate-depot-site", depotSiteId: site.depotSiteId });
    else sites.set(site.depotSiteId, site);
  }
  return {
    schema: DEPOT_EXPORT_SCHEMA,
    packId: pack.manifest?.id ?? "pack",
    packVersion: pack.manifest?.version ?? null,
    sites: [...sites.values()].sort((a, b) => (a.depotSiteId < b.depotSiteId ? -1 : 1)),
    warnings,
  };
}
