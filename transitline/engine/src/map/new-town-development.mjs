// New-town development areas: what the player drew on the map, as pure spatial facts for the management engine
// (see docs/b19-m1-new-town-development-geometry-2026-10-09.md).  Polygons, areas, distances, what lies inside or
// beside them, and the player's own declarations (land use, delivery order, station sites) - nothing else.  Population,
// housing units, demand, occupancy, land price, cost, feasibility, schedule and any score belong to the management
// engine; this module never imports it and never touches cash, contracts or construction state.
//
// Missing data: a value that cannot be known is `null`, its name is in `unknown[]` and the reason is in `unknownReasons`
// - never 0, false or [].  A recorded 0 / false / [] is a measurement ("a covered layer holds none").  Being near an
// existing line, station or road is a distance, not a statement that anything can be connected.
import { stableId, round6, roundTo, coordKey } from "./ids.mjs";
import { bboxOf, overlaps, inRing, ringsOverlap, polylineHitsPolygon, makeSpatialContext } from "./spatial.mjs";
import { canonicalRing, selfIntersects } from "./depot-site.mjs";
import { frameAt, sub, len, nearestOnPolyline, distPointRing, areaAndCentroid, gridSamples, qualityOf, worse } from "./local-geometry.mjs";

export const NEW_TOWN_SCHEMA = "transitline.new-town-development-geometry/1";
export const NEW_TOWN_EXPORT_SCHEMA = "transitline.new-town-development-export/1";
// A suggestion, not a rule: the player's own word is kept as it is (trimmed).  A word outside this list is only reported.
export const LAND_USE_SUGGESTIONS = Object.freeze(["housing", "employment", "mixed", "public-space", "commercial", "education", "civic", "transport-facility", "utility", "reserved"]);
export const LAND_USE_MAX_LENGTH = 64;
// What no pack holds: stated so that nobody reads their absence as "fine".
export const NOT_MODELLED = Object.freeze(["land-ownership", "underground-conditions", "zoning-and-permits", "occupancy-rate"]);
export const SPATIAL_FLAGS = Object.freeze(["building-overlap", "outside-pack-bbox", "overlaps-other-phase", "roads-through-area", "station-inside-area", "water-overlap"]);

const RAIL_SEARCH_M = 2000;
const ROAD_SEARCH_M = 300;
const CANDIDATE_CAP = 8;

export const keyedDevelopmentId = (packId, key) => stableId("new-town", packId, "key", key);
export const keyedPhaseId = (developmentId, key) => stableId("new-town-phase", developmentId, "key", key);
export const roadRefIdOf = (item) => stableId("road", item.cls ?? "unclassed", item.line.length, ...[item.line[0], item.line.at(-1)].map(coordKey));

const hasText = (v) => typeof v === "string" && v.trim() !== "";
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sortedUnique = (list) => [...new Set(list)].sort(byText);
const finitePoint = (p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite);
const sortedObject = (obj) => Object.fromEntries(Object.keys(obj).sort(byText).map((k) => [k, obj[k]]));
const covered = (layer, pts) => !layer.covers || pts.every((p) => layer.covers(p));

// one phase: its polygon (canonical) and why it has none
function ringOf(polygon, warnings) {
  if (polygon === undefined || polygon === null) return { ring: null, reason: "no-polygon" };
  if (!Array.isArray(polygon) || !polygon.every(finitePoint)) { warnings.push({ code: "polygon-invalid-coordinates" }); return { ring: null, reason: "polygon-invalid-coordinates" }; }
  const ring = canonicalRing(polygon);
  if (!ring) { warnings.push({ code: "polygon-degenerate" }); return { ring: null, reason: "polygon-degenerate" }; }
  if (selfIntersects(ring)) { warnings.push({ code: "polygon-self-intersecting" }); return { ring: null, reason: "polygon-self-intersecting" }; }
  return { ring, reason: null };
}

// The shortest distance between two piecewise-linear shapes is reached at a vertex of one of them.
const distRingLine = (xyRing, xyLine) => Math.min(...xyLine.map((p) => distPointRing(p, xyRing)), ...xyRing.map((p) => nearestOnPolyline(p, xyLine).d));

// ctx: { pack, spatial, plans, externalNetworks }.  `given`: the phase's canonical ring (or why it has none) and the warnings that came with it.
function buildPhase(declared, { phaseId, sequence, overlapIds, ctx, given }) {
  const { pack, spatial, plans, externalNetworks: externals } = ctx;
  const layers = spatial.layers;
  const warnings = [...given.warnings];
  const unknown = [];
  const reasons = {};
  const mark = (field, reason) => { if (!unknown.includes(field)) unknown.push(field); reasons[field] = reason; };
  const { ring, reason: ringReason } = given;
  const used = new Set();

  // --- what the player declared ---
  let playerDeclaredLandUse = null;
  if (declared.playerDeclaredLandUse === undefined || declared.playerDeclaredLandUse === null) mark("playerDeclaredLandUse", "not-stated");
  else {
    const landUse = typeof declared.playerDeclaredLandUse === "string" ? declared.playerDeclaredLandUse.trim() : "";
    if (!landUse || landUse.length > LAND_USE_MAX_LENGTH) { warnings.push({ code: "land-use-invalid" }); mark("playerDeclaredLandUse", "invalid"); }
    else {
      playerDeclaredLandUse = landUse;
      if (!LAND_USE_SUGGESTIONS.includes(landUse)) warnings.push({ code: "land-use-not-in-suggested-vocabulary", value: landUse });
    }
  }
  let playerDeclaredDeliveryOrder = null;
  if (declared.playerDeclaredDeliveryOrder === undefined || declared.playerDeclaredDeliveryOrder === null) mark("playerDeclaredDeliveryOrder", "not-stated");
  else if (!Number.isInteger(declared.playerDeclaredDeliveryOrder) || declared.playerDeclaredDeliveryOrder < 1) { warnings.push({ code: "delivery-order-not-a-positive-integer" }); mark("playerDeclaredDeliveryOrder", "invalid"); }
  else playerDeclaredDeliveryOrder = declared.playerDeclaredDeliveryOrder;

  // --- geometry ---
  const frame = ring ? frameAt([ring.reduce((s, p) => s + p[0], 0) / ring.length, ring.reduce((s, p) => s + p[1], 0) / ring.length]) : null;
  const xyRing = ring ? ring.map(frame.xy) : null;
  const ac = ring ? areaAndCentroid(xyRing) : null;
  const location = ring ? frame.ll(ac.centroid).map(round6) : null;
  const areaSquareMeters = ring ? roundTo(ac.area, 1) : null;
  const perimeterMeters = ring ? roundTo(xyRing.reduce((s, p, i) => s + len(sub(xyRing[(i + 1) % xyRing.length], p)), 0), 1) : null;
  if (!ring) for (const f of ["polygon", "location", "areaSquareMeters", "perimeterMeters"]) mark(f, ringReason);
  const siteBox = ring ? bboxOf(ring) : null;
  // the polygon's bounding box grown by `m` metres on every side
  const boxWithin = (m) => {
    const [dLon, dLat] = frame.ll([m, m]).map((v, i) => v - frame.ll([0, 0])[i]);
    return [siteBox[0] - dLon, siteBox[1] - dLat, siteBox[2] + dLon, siteBox[3] + dLat];
  };
  const probe = ring ? [...ring, location] : null;
  // a fact that needs the polygon and a layer that covers it
  const layerFact = (field, layer, name, compute) => {
    if (!ring) { mark(field, ringReason); return null; }
    if (!layer) { mark(field, "no-layer"); return null; }
    if (!covered(layer, probe)) { mark(field, "outside-coverage"); return null; }
    used.add(name);
    return compute(layer);
  };

  // --- pack extent ---
  const bbox = pack.manifest?.bbox;
  let withinPackBoundingBox = null;
  if (!ring) mark("withinPackBoundingBox", ringReason);
  else if (!Array.isArray(bbox) || bbox.length !== 4) mark("withinPackBoundingBox", "no-pack-bbox");
  else withinPackBoundingBox = ring.every(([x, y]) => x >= bbox[0] && x <= bbox[2] && y >= bbox[1] && y <= bbox[3]);

  // --- stations: planned and existing ---
  const stations = [
    ...plans.flatMap((p) => (p.stationCandidates ?? []).filter((s) => finitePoint(s.location)).map((s) => ({ id: String(s.id), kind: "plan", location: s.location }))),
    ...externals.flatMap((n) => (n.stations ?? []).filter((s) => finitePoint(s.location)).map((s) => ({ id: String(s.id), kind: "external", location: s.location }))),
  ];
  let stationsInside = null;
  let nearestPlannedStation = null;
  let nearestExistingStation = null;
  if (!ring) for (const f of ["stationsInside", "nearestPlannedStation", "nearestExistingStation"]) mark(f, ringReason);
  else if (!stations.length) for (const f of ["stationsInside", "nearestPlannedStation", "nearestExistingStation"]) mark(f, "no-station-data");
  else {
    used.add("stations");
    const ranked = stations.map((s) => ({ ...s, inside: inRing(frame.xy(s.location), xyRing), d: distPointRing(frame.xy(s.location), xyRing) })).sort((a, b) => a.d - b.d || byText(a.id, b.id));
    stationsInside = ranked.filter((s) => s.inside).map((s) => ({ stationId: s.id, stationKind: s.kind }));
    const nearest = (kind, field, why) => {
      const s = ranked.find((x) => x.kind === kind);
      if (!s) { mark(field, why); return null; }
      return { stationId: s.id, distanceMeters: roundTo(s.d, 1) };
    };
    nearestPlannedStation = nearest("plan", "nearestPlannedStation", "no-planned-stations");
    nearestExistingStation = nearest("external", "nearestExistingStation", "no-existing-stations");
  }

  // --- the player's station sites (null = not stated, [] = states there are none) ---
  let stationSiteRefs = null;
  if (declared.access?.stationRefs === undefined || declared.access?.stationRefs === null) mark("stationSiteRefs", "not-stated");
  else if (!Array.isArray(declared.access.stationRefs)) { warnings.push({ code: "station-refs-invalid" }); mark("stationSiteRefs", "invalid"); }
  else {
    stationSiteRefs = [];
    for (const ref of declared.access.stationRefs) {
      const id = hasText(ref?.stationId) ? ref.stationId : null;
      const matches = id === null ? [] : stations.filter((s) => s.id === id && (ref.stationKind === undefined || ref.stationKind === null || s.kind === ref.stationKind));
      if (matches.length !== 1) { warnings.push({ code: matches.length > 1 ? "station-ref-ambiguous" : "station-ref-missing", stationId: id }); continue; }
      const s = matches[0];
      if (stationSiteRefs.some((x) => x.stationId === s.id && x.stationKind === s.kind)) continue;
      stationSiteRefs.push({ stationId: s.id, stationKind: s.kind, location: s.location.map(round6), insideArea: ring ? inRing(frame.xy(s.location), xyRing) : null, distanceMeters: ring ? roundTo(distPointRing(frame.xy(s.location), xyRing), 1) : null });
    }
    stationSiteRefs.sort((a, b) => byText(a.stationKind, b.stationKind) || byText(a.stationId, b.stationId));
    if (stationSiteRefs.length) used.add("stations");
  }

  // --- rail through or beside the area: plan segments and existing lines, as distances only ---
  const lines = [
    ...plans.flatMap((p) => (p.segments ?? []).filter((s) => Array.isArray(s.alignment) && s.alignment.length >= 2 && s.alignment.every(finitePoint)).map((s) => ({ refKind: "plan-segment", planId: String(p.planId), segmentId: String(s.id), externalNetworkId: null, externalLineId: null, line: s.alignment }))),
    ...externals.flatMap((n) => {
      const at = new Map((n.stations ?? []).map((s) => [s.id, s.location]));
      return (n.lines ?? []).map((l) => ({ refKind: "external-line", planId: null, segmentId: null, externalNetworkId: String(n.id), externalLineId: String(l.id), line: (l.stationIds ?? []).map((id) => at.get(id)).filter(finitePoint) })).filter((l) => l.line.length >= 2);
    }),
  ];
  const refKey = (l) => [l.refKind, l.planId, l.segmentId, l.externalNetworkId, l.externalLineId].join("|");
  const declaredRail = new Set();
  const railRefs = declared.access?.railRefs;
  if (railRefs !== undefined && railRefs !== null && !Array.isArray(railRefs)) warnings.push({ code: "rail-refs-invalid" });
  for (const ref of Array.isArray(railRefs) ? railRefs : []) {
    const found = lines.find((l) => (ref?.planId ? l.refKind === "plan-segment" && l.planId === ref.planId && (!ref.segmentId || l.segmentId === ref.segmentId) : ref?.externalLineId ? l.refKind === "external-line" && l.externalLineId === ref.externalLineId && (!ref.externalNetworkId || l.externalNetworkId === ref.externalNetworkId) : false));
    if (found) declaredRail.add(refKey(found));
    else warnings.push({ code: "rail-ref-missing", planId: ref?.planId ?? null, segmentId: ref?.segmentId ?? null, externalLineId: ref?.externalLineId ?? null });
  }
  let railAccessCandidates = null;
  if (!ring) mark("railAccessCandidates", ringReason);
  else if (!lines.length) mark("railAccessCandidates", "no-rail-data");
  else {
    used.add("rail");
    const near = boxWithin(RAIL_SEARCH_M);
    const found = [];
    for (const l of lines) {
      const declaredByPlayer = declaredRail.has(refKey(l));
      if (!declaredByPlayer && !overlaps(near, bboxOf(l.line))) continue;
      const hit = polylineHitsPolygon(l.line, [ring]);
      const d = hit ? 0 : distRingLine(xyRing, l.line.map(frame.xy));
      const relation = hit ? (l.line.every((p) => inRing(p, ring)) ? "within" : "crosses") : d <= RAIL_SEARCH_M ? "near" : declaredByPlayer ? "beyond-search-radius" : null;
      if (relation) found.push({ refKind: l.refKind, planId: l.planId, segmentId: l.segmentId, externalNetworkId: l.externalNetworkId, externalLineId: l.externalLineId, declaredByPlayer, relation, distanceMeters: roundTo(d, 1) });
    }
    const order = (a, b) => a.distanceMeters - b.distanceMeters || byText(refKey(a), refKey(b));
    found.sort(order);
    railAccessCandidates = [...found.filter((c) => c.declaredByPlayer), ...found.filter((c) => !c.declaredByPlayer).slice(0, CANDIDATE_CAP)].sort(order);
  }

  // --- roads: through the area and beside it ---
  let roadsThroughArea = null;
  const roadAccessCandidates = layerFact("roadAccessCandidates", layers.roads, "roads", (layer) => {
    const through = { highway: 0, major: 0, minor: 0 };
    const near = boxWithin(ROAD_SEARCH_M);
    const found = [];
    for (const it of layer.items) {
      if (!overlaps(near, it.bbox)) continue;
      const hit = polylineHitsPolygon(it.line, [ring]);
      const d = hit ? 0 : distRingLine(xyRing, it.line.map(frame.xy));
      if (hit) through[it.cls] = (through[it.cls] ?? 0) + 1;
      if (d <= ROAD_SEARCH_M) found.push({ roadRefId: roadRefIdOf(it), roadClass: it.cls ?? null, relation: hit ? "through-area" : "near", distanceMeters: roundTo(d, 1) });
    }
    found.sort((a, b) => a.distanceMeters - b.distanceMeters || byText(a.roadRefId, b.roadRefId));
    roadsThroughArea = through;
    return found.slice(0, CANDIDATE_CAP);
  });
  if (roadsThroughArea === null) mark("roadsThroughArea", reasons.roadAccessCandidates);

  // --- water and buildings the area overlaps ---
  const countOverlap = (layer) => layer.items.filter((it) => overlaps(siteBox, it.bbox) && ringsOverlap(ring, it.rings[0])).length;
  const waterOverlapCount = layerFact("waterOverlapCount", layers.water, "water", countOverlap);
  const intersectedBuildingCount = layerFact("intersectedBuildingCount", layers.buildings, "buildings", countOverlap);

  // --- ground, when a DEM covers the area ---
  const samples = ring ? gridSamples(xyRing).map((p) => frame.ll(p)) : null;
  const slopes = samples ? samples.map((p) => spatial.slopeAt(p)) : null;
  const elevs = samples ? samples.map((p) => spatial.elevationAt(p)) : null;
  const demReason = !ring ? ringReason : layers.dem ? "no-dem-value" : "no-layer";
  const pct = layers.dem?.slopeAt && slopes && slopes.every((v) => v !== null) ? slopes.map((d) => Math.tan((d * Math.PI) / 180) * 100) : null;
  const elevOk = Boolean(layers.dem) && elevs !== null && elevs.every((v) => v !== null);
  if (!pct) { mark("averageSlopePercent", demReason); mark("maximumSlopePercent", demReason); } else used.add("dem");
  if (!elevOk) { mark("groundElevationMeters", demReason); mark("elevationRangeMeters", demReason); } else used.add("dem");

  // --- recorded demand nodes: where they are, never what is in them; an empty list is "no node lies inside", not "no demand" ---
  const nodes = (pack.demand?.points ?? []).filter((p) => finitePoint(p.location));
  let demandNodeRefsInside = null;
  let nearestDemandNode = null;
  if (!ring) { mark("demandNodeRefsInside", ringReason); mark("nearestDemandNode", ringReason); }
  else if (!nodes.length) { mark("demandNodeRefsInside", "no-demand-nodes-in-pack"); mark("nearestDemandNode", "no-demand-nodes-in-pack"); }
  else {
    used.add("demand-nodes");
    const ranked = nodes.map((n) => ({ id: String(n.id), inside: inRing(frame.xy(n.location), xyRing), d: distPointRing(frame.xy(n.location), xyRing) })).sort((a, b) => a.d - b.d || byText(a.id, b.id));
    demandNodeRefsInside = ranked.filter((n) => n.inside).map((n) => n.id).sort(byText);
    nearestDemandNode = { nodeId: ranked[0].id, distanceMeters: roundTo(ranked[0].d, 1) };
  }

  // --- the other phases of the same development ---
  let overlapsPhaseIds = null;
  if (!ring) mark("overlapsPhaseIds", ringReason);
  else overlapsPhaseIds = [...overlapIds].sort(byText);

  const spatialFlags = [];
  if (intersectedBuildingCount > 0) spatialFlags.push("building-overlap");
  if (waterOverlapCount > 0) spatialFlags.push("water-overlap");
  if (withinPackBoundingBox === false) spatialFlags.push("outside-pack-bbox");
  if (overlapsPhaseIds?.length) spatialFlags.push("overlaps-other-phase");
  if (roadsThroughArea && Object.values(roadsThroughArea).some((n) => n > 0)) spatialFlags.push("roads-through-area");
  if (stationsInside?.length) spatialFlags.push("station-inside-area");

  const license = pack.manifest?.data?.license ?? null;
  const own = {
    rail: { layer: "rail", quality: "low", name: "map export: plan segments and ExternalNetwork lines (station-level, coarse)", license },
    stations: { layer: "stations", quality: null, name: "map export: plan station candidates and ExternalNetwork stations", license },
    "demand-nodes": { layer: "demand-nodes", quality: null, name: "CityPack demand points (locations only)", license },
  };
  const sourceLayers = [...spatial.sources.filter((s) => used.has(s.layer)), ...["rail", "stations", "demand-nodes"].filter((k) => used.has(k)).map((k) => own[k])].map((s) => ({ ...s })).sort((a, b) => byText(a.layer, b.layer));

  const body = {
    phaseId, key: String(declared.key), sequence, active: declared.active !== false,
    polygon: ring, location, areaSquareMeters, perimeterMeters,
    playerDeclaredLandUse, playerDeclaredDeliveryOrder,
    railAccessCandidates, roadAccessCandidates, stationSiteRefs,
    spatialFacts: {
      withinPackBoundingBox, stationsInside, nearestPlannedStation, nearestExistingStation,
      demandNodeRefsInside, nearestDemandNode, roadsThroughArea, waterOverlapCount, intersectedBuildingCount, overlapsPhaseIds,
      groundElevationMeters: elevOk ? roundTo(elevs.reduce((s, v) => s + v, 0) / elevs.length, 1) : null,
      elevationRangeMeters: elevOk ? roundTo(Math.max(...elevs) - Math.min(...elevs), 1) : null,
      averageSlopePercent: pct ? roundTo(pct.reduce((s, v) => s + v, 0) / pct.length, 2) : null,
      maximumSlopePercent: pct ? roundTo(Math.max(...pct), 2) : null,
      railSearchRadiusMeters: RAIL_SEARCH_M, roadSearchRadiusMeters: ROAD_SEARCH_M,
    },
    spatialFlags: sortedUnique(spatialFlags),
    sourceLayers,
    // what the player did not state is not a weakness of the map data, so only map-driven unknowns count; the unmodelled facts cap it
    dataQuality: worse(qualityOf(unknown.filter((f) => !["not-stated", "invalid"].includes(reasons[f])).length), "medium"),
    unknown: [...unknown].sort(byText),
    unknownReasons: sortedObject(reasons),
    warnings: warnings.sort((a, b) => byText(JSON.stringify(a), JSON.stringify(b))),
  };
  return { body, name: hasText(declared.name) ? declared.name : null };
}

// A phase's revision follows its drawing and its declarations, never its name.
const phaseRevisionOf = (body) => stableId("new-town-phase-revision", body.phaseId, JSON.stringify(body));

// drawn: { key, name?, active?, phases?: [{ key, name?, sequence?, active?, polygon?, playerDeclaredLandUse?, playerDeclaredDeliveryOrder?,
//          access?: { stationRefs?: [{ stationId, stationKind? }] | null, railRefs?: [{ planId, segmentId? } | { externalNetworkId?, externalLineId }] } }] }
// ctx:   { pack, spatial, plans, externalNetworks }
export function buildNewTownDevelopment(drawn, ctx) {
  if (!hasText(drawn?.key)) return null;
  const pack = ctx.pack;
  const packId = pack.manifest?.id ?? "pack";
  const full = { pack, spatial: ctx.spatial ?? makeSpatialContext(), plans: ctx.plans ?? [], externalNetworks: ctx.externalNetworks ?? [] };
  const developmentId = keyedDevelopmentId(packId, drawn.key);
  const warnings = [];
  const unknown = [];
  const reasons = {};
  const mark = (field, reason) => { if (!unknown.includes(field)) unknown.push(field); reasons[field] = reason; };

  // phases: keyed, unique, ordered by the sequence the player gave (else the order they came in), then by key
  const seen = new Set();
  const kept = [];
  (Array.isArray(drawn.phases) ? drawn.phases : []).forEach((phase, index) => {
    if (!hasText(phase?.key)) { warnings.push({ code: "phase-no-key", index }); return; }
    if (seen.has(String(phase.key))) { warnings.push({ code: "phase-duplicate-key", phaseKey: String(phase.key) }); return; }
    seen.add(String(phase.key));
    kept.push({ phase, order: Number.isFinite(phase.sequence) ? phase.sequence : index + 1 });
  });
  kept.sort((a, b) => a.order - b.order || byText(String(a.phase.key), String(b.phase.key)));
  const entries = kept.map(({ phase }, i) => {
    const phaseWarnings = [];
    return { phase, sequence: i + 1, phaseId: keyedPhaseId(developmentId, String(phase.key)), ...ringOf(phase.polygon, phaseWarnings), warnings: phaseWarnings };
  });
  const boxes = new Map(entries.filter((e) => e.ring).map((e) => [e.phaseId, bboxOf(e.ring)]));
  const overlapsOf = (e) => entries.filter((o) => o !== e && o.ring && overlaps(boxes.get(e.phaseId), boxes.get(o.phaseId)) && ringsOverlap(e.ring, o.ring)).map((o) => o.phaseId);

  const phases = entries.map((e) => {
    const { body, name } = buildPhase(e.phase, { phaseId: e.phaseId, sequence: e.sequence, overlapIds: e.ring ? overlapsOf(e) : [], ctx: full, given: { ring: e.ring, reason: e.reason, warnings: e.warnings } });
    return { ...body, phaseRevision: phaseRevisionOf(body), name };
  });

  // --- the whole development: only what follows from its phases ---
  const active = phases.filter((p) => p.active);
  if (!phases.length) warnings.push({ code: "development-has-no-phase" });
  const withRing = active.filter((p) => p.polygon);
  const whyNone = active.length ? "active-phase-without-polygon" : "no-active-phase";
  // location and boundingBox cover the active phases that HAVE a polygon: say so when some active phase has none
  if (withRing.length && withRing.length < active.length) warnings.push({ code: "location-covers-only-phases-with-polygon", phaseIds: active.filter((p) => !p.polygon).map((p) => p.phaseId).sort(byText) });
  let phaseAreaSumSquareMeters = null;
  if (active.length && withRing.length === active.length) phaseAreaSumSquareMeters = roundTo(active.reduce((s, p) => s + p.areaSquareMeters, 0), 1);
  else mark("phaseAreaSumSquareMeters", whyNone);
  let boundingBox = null;
  let location = null;
  if (!withRing.length) { mark("boundingBox", whyNone); mark("location", whyNone); }
  else {
    boundingBox = bboxOf(withRing.flatMap((p) => p.polygon)).map(round6);
    const total = withRing.reduce((s, p) => s + p.areaSquareMeters, 0);
    location = [0, 1].map((axis) => round6(withRing.reduce((s, p) => s + p.location[axis] * p.areaSquareMeters, 0) / total));
  }
  const body = {
    schema: NEW_TOWN_SCHEMA,
    contractVersion: 1,
    developmentId,
    sourcePackId: packId,
    sourcePackVersion: pack.manifest?.version ?? null,
    key: String(drawn.key),
    active: drawn.active !== false,
    phaseCount: phases.length,
    activePhaseCount: active.length,
    location,
    boundingBox,
    phaseAreaSumSquareMeters, // the sum of the active phases' own areas: overlapping phases are counted twice (see spatialFlags)
    phases,
    spatialFlags: sortedUnique(phases.flatMap((p) => p.spatialFlags)),
    sourceLayers: [...new Map(phases.flatMap((p) => p.sourceLayers).map((s) => [`${s.layer}|${s.name}`, { ...s }])).values()].sort((a, b) => byText(a.layer, b.layer) || byText(a.name, b.name)),
    dataQuality: phases.length ? phases.reduce((w, p) => worse(w, p.dataQuality), "high") : worse(qualityOf(unknown.length), "medium"),
    unknown: [...unknown].sort(byText),
    unknownReasons: sortedObject(reasons),
    constraintUnknown: [...NOT_MODELLED],
    warnings: warnings.sort((a, b) => byText(JSON.stringify(a), JSON.stringify(b))),
    license: { pack: pack.manifest?.data?.license ?? null, attribution: [...(pack.manifest?.data?.attribution ?? [])] },
  };
  // the revision follows the geometry and the declarations: no name, of the development or of a phase, is part of it
  const revisionBody = { ...body, phases: phases.map(({ name: _name, ...rest }) => rest) };
  return { ...body, developmentRevision: stableId("new-town-revision", developmentId, JSON.stringify(revisionBody)), name: hasText(drawn.name) ? drawn.name : null };
}

// mapExport: { plans, externalNetworks } (buildMapExport's result).  Developments come out sorted by id, whatever order they were drawn in.
export function buildNewTownDevelopmentExport({ pack, mapExport = {}, developments = [], spatial }) {
  const built = new Map();
  const warnings = [];
  for (const drawn of developments) {
    const development = buildNewTownDevelopment(drawn, { pack, spatial, plans: mapExport.plans ?? [], externalNetworks: mapExport.externalNetworks ?? [] });
    if (!development) warnings.push({ code: "development-no-key", name: hasText(drawn?.name) ? drawn.name : null });
    else if (built.has(development.developmentId)) warnings.push({ code: "duplicate-development", developmentId: development.developmentId });
    else built.set(development.developmentId, development);
  }
  return {
    schema: NEW_TOWN_EXPORT_SCHEMA,
    packId: pack.manifest?.id ?? "pack",
    packVersion: pack.manifest?.version ?? null,
    developments: [...built.values()].sort((a, b) => byText(a.developmentId, b.developmentId)),
    warnings,
  };
}
