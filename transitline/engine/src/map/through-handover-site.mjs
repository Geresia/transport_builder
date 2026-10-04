// Through-running handover sites: pure spatial facts for the management engine (see docs/through-handover-site-contract.md).
// Where the player joined two legs of a ThroughRouteGeometry — the two connection points they picked, the connection
// track they drew, the turnouts they chose, the work areas they outlined — and what that drawing physically touches
// (buildings, water, roads, existing rail, slope). Nothing else: cost, duration, approval, probability and any
// possible / conditional / impossible verdict belong to the management engine. This module never imports it.
//
// Missing data: a value that cannot be known is `null`, its name is in `unknown[]` and the reason is in
// `unknownReasons` — never false, never 0, never a guess. `physicalConnectionEvidence.connected` keeps the three
// answers apart: true (the drawn track measurably meets both legs), false (it measurably does not), null (the data
// to say either is missing). Selecting a connection point on an external line, an external station's centre or a
// line name is never evidence: only a real alignment of that external line can be.
import { stableId, round6, roundTo, coordKey } from "./ids.mjs";
import { THROUGH_ROUTE_SCHEMA, NEAR_ENDPOINT_METERS } from "./through-route.mjs";
import { sampleAlong, overlaps, bboxOf, ringsOverlap, inRing, makeSpatialContext } from "./spatial.mjs";
import { withRailLayer } from "./plan-geometry.mjs";
import { frameAt, sub, len, areaAndCentroid, qualityOf, worse } from "./local-geometry.mjs";
import { canonicalRing, selfIntersects } from "./depot-site.mjs";

export const THROUGH_HANDOVER_SITE_SCHEMA = "transitline.through-handover-site-geometry/1";
export const THROUGH_HANDOVER_EXPORT_SCHEMA = "transitline.through-handover-site-export/1";
// Positions this close are the same place (plan alignments are rounded to ~0.1 m, a player's click is snapped to them).
export const JOIN_TOLERANCE_METERS = 1;
export { NEAR_ENDPOINT_METERS };
// The structure types a drawn connection can be built as (the management engine prices exactly these). Player-stated only.
export const CONNECTION_STRUCTURE_TYPES = Object.freeze(["at-grade", "cut-cover", "tunnel", "viaduct", "bridge"]);
const SLOPE_STEP_METERS = 25;
const CURVE_CAP_METERS = 100_000; // a straight connection reports this radius, as PlanGeometry does (JSON has no Infinity)

// A site the player saved has a key; its id follows the key, not the drawing, so editing keeps it.
export const keyedHandoverSiteId = (packId, key) => stableId("through-handover-site", packId, "key", key);

const hasKey = (v) => v !== undefined && v !== null && v !== "";
const coord = (p) => (Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90 ? [round6(p[0]), round6(p[1])] : null);
const asLine = (pts) => {
  if (pts === undefined || pts === null) return { line: null };
  if (!Array.isArray(pts)) return { error: true };
  const out = [];
  for (const p of pts) {
    const c = coord(p);
    if (!c) return { error: true };
    if (!out.length || coordKey(out.at(-1)) !== coordKey(c)) out.push(c);
  }
  return { line: out.length ? out : null };
};

// Nearest point of a polyline in the local metre frame: distance, arc length to it and the segment it lies on.
function locate(p, poly) {
  let best = null;
  let run = 0;
  for (let i = 1; i < poly.length; i++) {
    const a = poly[i - 1];
    const b = poly[i];
    const ab = sub(b, a);
    const l2 = ab[0] ** 2 + ab[1] ** 2;
    const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1]) / l2));
    const d = Math.hypot(p[0] - (a[0] + ab[0] * t), p[1] - (a[1] + ab[1] * t));
    const seg = Math.sqrt(l2);
    if (!best || d < best.d) best = { d, along: run + seg * t, segment: i - 1, t };
    run += seg;
  }
  return { ...(best ?? { d: len(sub(p, poly[0])), along: 0, segment: 0, t: 0 }), total: run };
}
const nearestOfParts = (p, parts) => parts.map((poly) => locate(p, poly)).reduce((b, x) => (!b || x.d < b.d ? x : b), null);

// The external line's real alignment, only when the caller supplies one. Station-level data is not an alignment.
function externalAlignmentOf(leg, supplied) {
  const entry = (supplied ?? []).find((a) => a?.externalLineId === leg.externalLineId && (!a.externalNetworkId || a.externalNetworkId === leg.externalNetworkId));
  const parts = (entry?.alignments ?? []).map((a) => asLine(a).line).filter((l) => l && l.length >= 2);
  return parts.length ? { parts, entry } : null;
}

function legGeometry(leg, ctx) {
  if (leg.sourceKind === "external") {
    const ext = externalAlignmentOf(leg, ctx.externalAlignments);
    return ext
      ? { known: true, kind: "external-alignment", parts: ext.parts, ordered: false, source: { layer: "external-rail-alignment", quality: ext.entry.quality ?? null, name: ext.entry.source?.name ?? null, license: ext.entry.source?.license ?? null } }
      : { known: false, kind: null, parts: null, ordered: false, reason: "external-alignment-not-in-source" };
  }
  return Array.isArray(leg.alignment) && leg.alignment.length >= 2
    ? { known: true, kind: "plan-alignment", parts: [leg.alignment], ordered: true, source: null }
    : { known: false, kind: null, parts: null, ordered: false, reason: "leg-alignment-not-in-route" };
}

const sortedReasons = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));

// drawn: { key?, name?, throughRouteId, handoverId, fromLegId, toLegId,
//          routeGeometryRevision  (the route revision the player designed this against),
//          fromConnectionPoint?, toConnectionPoint?  ([lon,lat], on the leg the player picked),
//          connectionAlignment?  ([[lon,lat]...] the track the player drew, either direction),
//          structureType?  (one of CONNECTION_STRUCTURE_TYPES), maximumGradientPermille?  (the designed track gradient):
//            both only what the player states, never inferred or derived from the ground here,
//          selectedWorkAreaKey?  (the key of the work area the player chose among workAreas),
//          turnoutCandidates?: [{ key?, location, selected? }],
//          workAreas?: [{ key?, polygon }] }
// ctx:   { pack, route (ThroughRouteGeometry v1), plans?, externalNetworks?, externalAlignments?, spatial? }
// -> { site, warnings }; site is null when the input cannot be tied to the route or is not geometry at all.
export function buildThroughHandoverSite(drawn, ctx) {
  const packId = ctx.pack.manifest?.id ?? "pack";
  const route = ctx.route;
  const reject = (code, extra = {}) => ({ site: null, warnings: [{ code, key: drawn?.key ?? null, ...extra }] });

  // --- identity: the site must belong to this route, this handover and these two legs ---
  if (route?.schema !== THROUGH_ROUTE_SCHEMA) return reject("route-schema-invalid", { schema: route?.schema ?? null });
  if (drawn?.throughRouteId !== route.throughRouteId) return reject("through-route-id-mismatch", { drawn: drawn?.throughRouteId ?? null, route: route.throughRouteId });
  const handover = route.handovers.find((h) => h.handoverId === drawn.handoverId);
  if (!handover) return reject("handover-missing", { handoverId: drawn.handoverId ?? null });
  if (drawn.fromLegId !== handover.fromLegId || drawn.toLegId !== handover.toLegId) {
    return reject("handover-legs-mismatch", { handoverId: handover.handoverId, drawn: [drawn.fromLegId ?? null, drawn.toLegId ?? null], handover: [handover.fromLegId, handover.toLegId] });
  }
  const legs = { from: route.legs.find((l) => l.legId === handover.fromLegId), to: route.legs.find((l) => l.legId === handover.toLegId) };
  if (!legs.from || !legs.to) return reject("leg-missing", { handoverId: handover.handoverId });

  // --- the player's drawing: validated, rounded, never reordered by draw order ---
  const given = {};
  for (const side of ["from", "to"]) {
    const raw = drawn[`${side}ConnectionPoint`];
    given[side] = raw === undefined || raw === null ? null : coord(raw);
    if (raw !== undefined && raw !== null && !given[side]) return reject("connection-point-invalid", { side });
  }
  const drawnLine = asLine(drawn.connectionAlignment);
  if (drawnLine.error) return reject("connection-alignment-invalid");
  let alignment = drawnLine.line;

  const warnings = [];
  let structureType = null;
  if (hasKey(drawn.structureType)) {
    if (CONNECTION_STRUCTURE_TYPES.includes(drawn.structureType)) structureType = drawn.structureType;
    else warnings.push({ code: "invalid-structure-type", key: drawn.key ?? null, value: String(drawn.structureType) });
  }
  let maximumGradientPermille = null;
  if (drawn.maximumGradientPermille !== undefined && drawn.maximumGradientPermille !== null) {
    if (typeof drawn.maximumGradientPermille === "number" && Number.isFinite(drawn.maximumGradientPermille) && drawn.maximumGradientPermille >= 0) maximumGradientPermille = roundTo(drawn.maximumGradientPermille, 1);
    else warnings.push({ code: "invalid-gradient", key: drawn.key ?? null, value: String(drawn.maximumGradientPermille) });
  }
  const turnouts = [];
  for (const [i, t] of (drawn.turnoutCandidates ?? []).entries()) {
    const location = coord(t?.location);
    if (!location) { warnings.push({ code: "turnout-location-invalid", index: i }); continue; }
    turnouts.push({ key: hasKey(t.key) ? t.key : null, location, selected: t.selected !== false });
  }
  const areas = [];
  for (const [i, a] of (drawn.workAreas ?? []).entries()) {
    const ring = Array.isArray(a?.polygon) && a.polygon.every((p) => coord(p)) ? canonicalRing(a.polygon) : null;
    if (!ring) { warnings.push({ code: "work-area-degenerate", index: i }); continue; }
    if (selfIntersects(ring)) { warnings.push({ code: "work-area-self-intersecting", index: i }); continue; }
    areas.push({ key: hasKey(a.key) ? a.key : null, ring });
  }

  const handoverSiteId = hasKey(drawn.key)
    ? keyedHandoverSiteId(packId, drawn.key)
    : stableId("through-handover-site", packId, route.throughRouteId, handover.handoverId);

  // --- frame: one local metre frame for every distance of this site ---
  const originLL = given.from ?? given.to ?? alignment?.[0] ?? areas[0]?.ring[0] ?? turnouts[0]?.location ?? legs.from.alignment?.at(-1) ?? legs.to.alignment?.[0] ?? null;
  const frame = frameAt(originLL ?? [0, 0]);
  const xy = (p) => frame.xy(p);
  const toXY = (poly) => poly.map(xy);
  // the drawn track runs from the from-side to the to-side whichever way the player drew it
  if (alignment && given.from && alignment.length > 1 && len(sub(xy(alignment.at(-1)), xy(given.from))) < len(sub(xy(alignment[0]), xy(given.from)))) alignment = [...alignment].reverse();
  const alignXY = alignment ? toXY(alignment) : null;

  const unknown = [];
  const reasons = {};
  const mark = (field, reason) => { if (!unknown.includes(field)) unknown.push(field); reasons[field] = reason; };

  // --- the legs the drawing has to meet ---
  const geometry = { from: legGeometry(legs.from, ctx), to: legGeometry(legs.to, ctx) };
  const partsXY = (side) => geometry[side].parts.map(toXY);
  const planOf = (leg) => (ctx.plans ?? []).find((p) => p.planId === leg.connectedPlanId) ?? null;

  const points = {};
  for (const side of ["from", "to"]) {
    const leg = legs[side];
    const g = geometry[side];
    const loc = given[side];
    const pointUnknown = {};
    const fact = {
      legId: leg.legId, sourceKind: leg.sourceKind, location: loc,
      legAlignmentKnown: g.known, legAlignmentKind: g.kind,
      onLegAlignment: null, distanceToLegAlignmentMeters: null, planSegmentId: null,
      alongLegMeters: null, distanceToHandoverEndMeters: null,
    };
    if (!loc || !g.known) {
      for (const f of ["onLegAlignment", "distanceToLegAlignmentMeters", "planSegmentId", "alongLegMeters", "distanceToHandoverEndMeters"]) pointUnknown[f] = loc ? g.reason : "point-not-selected";
    } else {
      const hit = nearestOfParts(xy(loc), partsXY(side));
      fact.distanceToLegAlignmentMeters = roundTo(hit.d, 1);
      fact.onLegAlignment = hit.d <= JOIN_TOLERANCE_METERS;
      if (g.ordered) {
        fact.alongLegMeters = roundTo(hit.along, 1);
        // the end of the leg that meets the handover: the last point of the from-leg, the first of the to-leg
        fact.distanceToHandoverEndMeters = roundTo(side === "from" ? hit.total - hit.along : hit.along, 1);
        const plan = planOf(leg);
        const segs = plan ? (leg.segmentIds ?? []).map((id) => plan.segments.find((s) => s.id === id)).filter(Boolean) : [];
        if (!segs.length) pointUnknown.planSegmentId = "plan-missing";
        else if (fact.onLegAlignment) {
          const near = segs.map((s) => ({ s, d: nearestOfParts(xy(loc), [toXY(s.alignment)]).d })).reduce((b, x) => (!b || x.d < b.d || (x.d === b.d && x.s.id < b.s.id) ? x : b), null);
          fact.planSegmentId = near.s.id;
        }
      } else {
        pointUnknown.alongLegMeters = pointUnknown.distanceToHandoverEndMeters = "external-leg-end-not-in-source";
      }
    }
    points[side] = { ...fact, unknown: Object.keys(pointUnknown).sort(), unknownReasons: sortedReasons(pointUnknown) };
    if (!loc) mark(`${side}ConnectionPoint`, "not-selected");
  }

  // --- the connection track ---
  let connectionLengthMeters = null;
  if (alignXY) connectionLengthMeters = roundTo(alignXY.slice(1).reduce((s, p, i) => s + len(sub(p, alignXY[i])), 0), 1);
  else { mark("connectionAlignment", "no-connection-drawn"); mark("connectionLengthMeters", "no-connection-drawn"); }

  // minimum radius of the drawn polyline's bends (same vertex-fillet rule as PlanGeometry); a straight run reports the cap
  let minimumCurveRadiusMeters = null;
  if (alignXY && alignXY.length >= 2) {
    const radii = alignXY.slice(1, -1).map((p, i) => {
      const a = sub(p, alignXY[i]);
      const b = sub(alignXY[i + 2], p);
      const la = len(a);
      const lb = len(b);
      const theta = Math.acos(Math.max(-1, Math.min(1, (a[0] * b[0] + a[1] * b[1]) / (la * lb))));
      return theta < 1e-3 ? CURVE_CAP_METERS : Math.min(CURVE_CAP_METERS, Math.min(la, lb) / 2 / Math.tan(theta / 2));
    });
    minimumCurveRadiusMeters = roundTo(radii.length ? Math.min(...radii) : CURVE_CAP_METERS, 0);
  } else mark("minimumCurveRadiusMeters", alignXY ? "zero-length-connection" : "no-connection-drawn");
  if (!structureType) mark("structureType", "structure-not-stated");
  // the ground's slope (averageSlopePercent) is not a track gradient: only a designed value the player states fills this
  if (maximumGradientPermille === null) mark("maximumGradientPermille", "track-profile-not-designed");

  // --- evidence: does the drawn track measurably meet both legs? ---
  const staleReason = drawn.routeGeometryRevision === undefined || drawn.routeGeometryRevision === null ? "design-revision-not-recorded"
    : drawn.routeGeometryRevision !== route.geometryRevision ? "route-revision-stale" : null;
  if (staleReason) warnings.push({ code: staleReason, key: drawn.key ?? null, designed: drawn.routeGeometryRevision ?? null, current: route.geometryRevision });

  const sides = ["from", "to"].map((side) => {
    const loc = given[side];
    const end = alignXY ? (side === "from" ? alignXY[0] : alignXY.at(-1)) : null;
    const endToPoint = end && loc ? roundTo(len(sub(end, xy(loc))), 1) : null;
    const pointToLeg = points[side].distanceToLegAlignmentMeters;
    const missing = !loc ? "point-not-selected" : !alignXY ? "no-connection-drawn" : !geometry[side].known ? geometry[side].reason : null;
    const measured = [endToPoint, pointToLeg].filter((v) => v !== null);
    const worst = measured.length ? Math.max(...measured) : null;
    let joined = null;
    let reason = missing;
    if (worst !== null && worst > NEAR_ENDPOINT_METERS) { joined = false; reason = null; } // measured apart, whatever else is unknown
    else if (!missing) {
      if (worst <= JOIN_TOLERANCE_METERS) { joined = true; reason = null; } else reason = "endpoints-near-not-joined";
    }
    return {
      side, legId: legs[side].legId, legAlignmentKind: geometry[side].kind,
      connectionEndToPointMeters: endToPoint, pointToLegAlignmentMeters: pointToLeg,
      gapMeters: missing ? null : roundTo(worst, 1), joined, reason,
    };
  });
  let connected = null;
  let evidenceReason = null;
  if (staleReason) evidenceReason = staleReason; // a design never confirmed against this route proves nothing
  else if (sides.some((s) => s.joined === false)) connected = false;
  else if (sides.every((s) => s.joined === true)) connected = true;
  else evidenceReason = sides.find((s) => s.joined === null).reason;
  const physicalConnectionEvidence = {
    connected,
    basis: connected === null ? null : "drawn-connection-vs-leg-alignments",
    reason: evidenceReason,
    toleranceMeters: JOIN_TOLERANCE_METERS,
    nearDistanceMeters: NEAR_ENDPOINT_METERS,
    designedAgainstCurrentRoute: staleReason === "route-revision-stale" ? false : staleReason ? null : true,
    sides,
  };
  if (connected === null) mark("physicalConnectionEvidence", evidenceReason);
  const sideGaps = sides.map((s) => s.gapMeters);
  const endpointGapMeters = sideGaps.every((g) => g !== null) ? Math.max(...sideGaps) : null;
  if (endpointGapMeters === null) mark("endpointGapMeters", sides.find((s) => s.gapMeters === null).reason);

  // plan segments the two connection points sit on; exactly the planned sides, never a guess for an external one
  let connectedPlanSegmentIds = [];
  for (const side of ["from", "to"]) {
    if (legs[side].sourceKind === "external") continue;
    const p = points[side];
    const why = !given[side] ? "point-not-selected" : p.unknownReasons.planSegmentId ?? null;
    if (why) { connectedPlanSegmentIds = null; mark("connectedPlanSegmentIds", why); break; }
    if (p.planSegmentId) connectedPlanSegmentIds.push(p.planSegmentId);
  }
  if (connectedPlanSegmentIds) connectedPlanSegmentIds = [...new Set(connectedPlanSegmentIds)].sort();

  // --- what the connection track crosses ---
  // existing rail is only known where external networks are supplied (and then only station to station, coarsely)
  const spatial = ctx.externalNetworks?.length ? withRailLayer(ctx.spatial, ctx.externalNetworks) : ctx.spatial ?? makeSpatialContext();
  const used = new Set();
  let buildingIntersectionCount = null, waterCrossingCount = null, roadCrossingCount = null, existingRailwayCrossingCount = null, roadCrossingsByClass = null;
  if (alignment) {
    const crossings = spatial.crossings(alignment);
    const field = (value, name, layer) => {
      if (value === null) mark(name, spatial.whyUnknown(layer, alignment));
      else used.add(layer);
      return value;
    };
    buildingIntersectionCount = field(crossings.building, "buildingIntersectionCount", "buildings");
    waterCrossingCount = field(crossings.river, "waterCrossingCount", "water");
    roadCrossingsByClass = field(crossings.road, "roadCrossingCount", "roads");
    roadCrossingCount = roadCrossingsByClass === null ? null : Object.values(roadCrossingsByClass).reduce((s, n) => s + n, 0);
    existingRailwayCrossingCount = field(crossings.railway, "existingRailwayCrossingCount", "rail");
  } else for (const f of ["buildingIntersectionCount", "waterCrossingCount", "roadCrossingCount", "existingRailwayCrossingCount"]) mark(f, "no-connection-drawn");

  // --- terrain slope along the connection track (the ground's slope, not a track gradient) ---
  let averageSlopePercent = null, maximumSlopePercent = null;
  if (alignment) {
    const slopes = sampleAlong(alignment, SLOPE_STEP_METERS).map((p) => spatial.slopeAt(p));
    if (spatial.layers.dem?.slopeAt && slopes.every((v) => v !== null)) {
      const pct = slopes.map((d) => Math.tan((d * Math.PI) / 180) * 100);
      averageSlopePercent = roundTo(pct.reduce((s, v) => s + v, 0) / pct.length, 2);
      maximumSlopePercent = roundTo(Math.max(...pct), 2);
      used.add("dem");
    } else for (const f of ["averageSlopePercent", "maximumSlopePercent"]) mark(f, spatial.whyUnknown("dem", alignment));
  } else for (const f of ["averageSlopePercent", "maximumSlopePercent"]) mark(f, "no-connection-drawn");

  // --- selected turnouts ---
  const turnoutIdOf = (t) => stableId("through-turnout", handoverSiteId, t.key ?? coordKey(t.location));
  const turnoutCandidates = turnouts.map((t) => ({ turnoutId: turnoutIdOf(t), key: t.key, location: t.location, selected: t.selected })).sort((a, b) => (a.turnoutId < b.turnoutId ? -1 : 1));
  const selectedTurnoutPoints = turnouts.filter((t) => t.selected).map((t) => {
    const turnoutId = turnoutIdOf(t);
    const p = xy(t.location);
    const dLeg = (side) => (geometry[side].known ? roundTo(nearestOfParts(p, partsXY(side)).d, 1) : null);
    const dFrom = dLeg("from");
    const dTo = dLeg("to");
    const dConn = alignXY ? roundTo(locate(p, alignXY.length > 1 ? alignXY : [alignXY[0], alignXY[0]]).d, 1) : null;
    const dists = [dFrom, dTo, dConn];
    const onTrack = dists.some((d) => d !== null && d <= JOIN_TOLERANCE_METERS) ? true : dists.every((d) => d !== null) ? false : null;
    return {
      turnoutId, key: t.key, location: t.location,
      nearestLegId: [[dFrom, legs.from.legId], [dTo, legs.to.legId]].filter(([d]) => d !== null && d <= JOIN_TOLERANCE_METERS).sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : 1))[0]?.[1] ?? null,
      distanceToFromLegMeters: dFrom, distanceToToLegMeters: dTo, distanceToConnectionAlignmentMeters: dConn,
      distanceToFromPointMeters: given.from ? roundTo(len(sub(p, xy(given.from))), 1) : null,
      distanceToToPointMeters: given.to ? roundTo(len(sub(p, xy(given.to))), 1) : null,
      onTrack,
    };
  }).sort((a, b) => (a.turnoutId < b.turnoutId ? -1 : 1));
  if (new Set(selectedTurnoutPoints.map((t) => t.turnoutId)).size !== turnouts.filter((t) => t.selected).length) warnings.push({ code: "duplicate-turnout", key: drawn.key ?? null });

  // --- work areas ---
  const layers = spatial.layers;
  const workAreaCandidates = areas.map(({ key, ring }) => {
    const ringXY = toXY(ring);
    const { area, centroid } = areaAndCentroid(ringXY);
    const box = bboxOf(ring);
    const aUnknown = {};
    const count = (name, field, hit) => {
      const layer = layers[name];
      if (!layer) { aUnknown[field] = "no-layer"; return null; }
      if (layer.covers && !ring.every((p) => layer.covers(p))) { aUnknown[field] = "outside-coverage"; return null; }
      used.add(name);
      return layer.items.filter((it) => overlaps(box, it.bbox) && hit(it)).length;
    };
    const inside = (loc) => (loc ? inRing(xy(loc), ringXY) : null);
    const workAreaId = stableId("through-work-area", handoverSiteId, key ?? ring.map(coordKey).join("|"));
    return {
      workAreaId, key, polygon: ring, location: frame.ll(centroid).map(round6), areaSquareMeters: roundTo(area, 1),
      buildingIntersectionCount: count("buildings", "buildingIntersectionCount", (it) => ringsOverlap(ring, it.rings[0])),
      waterOverlapCount: count("water", "waterOverlapCount", (it) => ringsOverlap(ring, it.rings[0])),
      containsFromConnectionPoint: inside(given.from),
      containsToConnectionPoint: inside(given.to),
      coversConnectionAlignment: alignXY ? alignXY.every((p) => inRing(p, ringXY)) : null,
      containedTurnoutIds: selectedTurnoutPoints.filter((t) => inRing(xy(t.location), ringXY)).map((t) => t.turnoutId),
      unknown: Object.keys(aUnknown).sort(), unknownReasons: sortedReasons(aUnknown),
    };
  }).sort((a, b) => (a.workAreaId < b.workAreaId ? -1 : 1));

  // the work area the player chose among the ones they drew
  let selectedWorkAreaCandidateId = null;
  if (hasKey(drawn.selectedWorkAreaKey)) {
    const chosen = workAreaCandidates.find((w) => w.key === drawn.selectedWorkAreaKey);
    if (chosen) selectedWorkAreaCandidateId = chosen.workAreaId;
    else warnings.push({ code: "selected-work-area-missing", key: drawn.key ?? null, selectedWorkAreaKey: drawn.selectedWorkAreaKey });
  }
  if (selectedWorkAreaCandidateId === null) mark("selectedWorkAreaCandidateId", workAreaCandidates.length ? "work-area-not-selected" : "no-work-area-drawn");

  // --- spatial flags: facts about the drawing, not scores ---
  const flags = [];
  if (!alignment) flags.push("no-connection-drawn");
  if (connected === false) flags.push("connection-separated");
  else if (connected === null && sides.every((s) => s.joined !== false) && sides.some((s) => s.reason === "endpoints-near-not-joined")) flags.push("connection-gap-within-near-distance");
  if (sides.some((s) => !s.legAlignmentKind)) flags.push("leg-alignment-unknown");
  if (staleReason === "route-revision-stale") flags.push("route-revision-stale");
  if (buildingIntersectionCount > 0) flags.push("connection-through-buildings");
  if (waterCrossingCount > 0) flags.push("connection-crosses-water");
  if (roadCrossingCount > 0) flags.push("connection-crosses-road");
  if (existingRailwayCrossingCount > 0) flags.push("connection-crosses-existing-railway");
  if (["from", "to"].some((s) => points[s].distanceToHandoverEndMeters > NEAR_ENDPOINT_METERS)) flags.push("connection-point-away-from-leg-end");
  if (!selectedTurnoutPoints.length) flags.push("no-turnout-selected");
  if (selectedTurnoutPoints.some((t) => t.onTrack === false)) flags.push("turnout-not-on-track");
  if (workAreaCandidates.some((a) => a.buildingIntersectionCount > 0)) flags.push("work-area-building-overlap");
  if (workAreaCandidates.some((a) => a.waterOverlapCount > 0)) flags.push("work-area-water-overlap");

  // --- external side(s): ids the route itself states ---
  const externalLegs = ["from", "to"].map((s) => ({ side: s, leg: legs[s] })).filter(({ leg }) => leg.sourceKind === "external");
  const networkIds = [...new Set(externalLegs.map(({ leg }) => leg.externalNetworkId))];
  const lineIds = [...new Set(externalLegs.map(({ leg }) => leg.externalLineId))];

  const sourceLayers = [
    { layer: "through-route-geometry", quality: route.dataQuality ?? null, name: `ThroughRouteGeometry ${route.throughRouteId}`, license: route.license?.pack ?? null },
    ...[...used].sort().map((k) => spatial.sources.find((s) => s.layer === k)).filter(Boolean),
    ...["from", "to"].map((s) => geometry[s].source).filter(Boolean),
  ];
  const dataQuality = sourceLayers.slice(1).map((l) => l.quality).filter(Boolean).reduce((q, v) => worse(q, v), qualityOf(unknown.length));

  const facts = {
    routeGeometryRevision: route.geometryRevision,
    fromConnectionPoint: points.from, toConnectionPoint: points.to, connectionAlignment: alignment, connectionLengthMeters, minimumCurveRadiusMeters, structureType, maximumGradientPermille, endpointGapMeters,
    turnoutCandidates, selectedTurnoutPoints, connectedPlanSegmentIds, selectedWorkAreaCandidateId, buildingIntersectionCount, waterCrossingCount, roadCrossingCount, existingRailwayCrossingCount,
    averageSlopePercent, maximumSlopePercent, workAreaCandidates, physicalConnectionEvidence,
  };
  return {
    warnings,
    site: {
      schema: THROUGH_HANDOVER_SITE_SCHEMA,
      contractVersion: 1,
      handoverSiteId,
      siteRevision: stableId("through-handover-site-revision", handoverSiteId, JSON.stringify(facts)),
      key: hasKey(drawn.key) ? drawn.key : null,
      sourcePackId: packId,
      sourcePackVersion: ctx.pack.manifest?.version ?? null,
      name: drawn.name ?? null,
      throughRouteId: route.throughRouteId,
      routeGeometryRevision: route.geometryRevision,
      designedRouteGeometryRevision: drawn.routeGeometryRevision ?? null,
      handoverId: handover.handoverId,
      fromLegId: handover.fromLegId,
      toLegId: handover.toLegId,
      fromConnectionPoint: points.from,
      toConnectionPoint: points.to,
      connectionAlignment: alignment,
      connectionLengthMeters,
      minimumCurveRadiusMeters,
      // only what the player stated; no source or inference supplies these for a drawn connection
      structureType,
      structureTypeBasis: structureType ? "player" : null,
      maximumGradientPermille,
      maximumGradientBasis: maximumGradientPermille === null ? null : "player",
      endpointGapMeters,
      turnoutCandidates,
      selectedTurnoutPoints,
      connectedPlanSegmentIds,
      // ids the route states for its external leg(s); null with no external leg, or when the two external legs differ
      externalNetworkId: networkIds.length === 1 ? networkIds[0] : null,
      externalLineId: lineIds.length === 1 ? lineIds[0] : null,
      externalSides: externalLegs.map(({ side, leg }) => ({ side, legId: leg.legId, externalNetworkId: leg.externalNetworkId, externalLineId: leg.externalLineId, infrastructureOwnerId: leg.infrastructureOwnerId })),
      buildingIntersectionCount,
      waterCrossingCount,
      roadCrossingCount,
      roadCrossingsByClass,
      existingRailwayCrossingCount,
      averageSlopePercent,
      maximumSlopePercent,
      workAreaCandidates,
      selectedWorkAreaCandidateId,
      spatialFlags: flags,
      physicalConnectionEvidence,
      dataQuality,
      unknown,
      unknownReasons: reasons,
      warnings,
      sourceLayers,
      license: { pack: ctx.pack.manifest?.data?.license ?? null, attribution: ctx.pack.manifest?.data?.attribution ?? [] },
    },
  };
}

// routes: ThroughRouteGeometry v1 objects the sites may refer to. A site naming no route in the list is rejected.
export function buildThroughHandoverExport({ pack, routes = [], mapExport = { plans: [], externalNetworks: [] }, sites = [], spatial, externalAlignments = [] }) {
  const built = new Map();
  const warnings = [];
  for (const drawn of sites) {
    const route = routes.find((r) => r.throughRouteId === drawn?.throughRouteId);
    if (!route) { warnings.push({ code: "through-handover-site-rejected", key: drawn?.key ?? null, reasons: [{ code: "through-route-missing", throughRouteId: drawn?.throughRouteId ?? null }] }); continue; }
    const out = buildThroughHandoverSite(drawn, { pack, route, plans: mapExport.plans, externalNetworks: mapExport.externalNetworks, externalAlignments, spatial });
    if (!out.site) warnings.push({ code: "through-handover-site-rejected", key: drawn?.key ?? null, reasons: out.warnings });
    else if (built.has(out.site.handoverSiteId)) warnings.push({ code: "duplicate-through-handover-site", handoverSiteId: out.site.handoverSiteId });
    else built.set(out.site.handoverSiteId, out.site);
  }
  return {
    schema: THROUGH_HANDOVER_EXPORT_SCHEMA,
    packId: pack.manifest?.id ?? "pack",
    packVersion: pack.manifest?.version ?? null,
    sites: [...built.values()].sort((a, b) => (a.handoverSiteId < b.handoverSiteId ? -1 : 1)),
    warnings,
  };
}

// A point snapped onto the leg's alignment (what the editor stores), or null when the leg has no known alignment
// or the point is farther than maxMeters from it.
export function snapToLegAlignment(route, legId, location, { maxMeters = NEAR_ENDPOINT_METERS } = {}) {
  const leg = route.legs.find((l) => l.legId === legId);
  const at = coord(location);
  if (!leg || !at || !Array.isArray(leg.alignment) || leg.alignment.length < 2) return null;
  const frame = frameAt(at);
  const poly = leg.alignment.map(frame.xy);
  const hit = locate([0, 0], poly);
  if (hit.d > maxMeters) return null;
  const a = poly[hit.segment];
  const b = poly[hit.segment + 1];
  return { location: frame.ll([a[0] + (b[0] - a[0]) * hit.t, a[1] + (b[1] - a[1]) * hit.t]).map(round6), distanceMeters: roundTo(hit.d, 1) };
}

// Vertices of the leg's alignment within `radiusMeters` of a point: places a turnout could sit on the existing track.
export function turnoutCandidatesNear(route, legId, location, radiusMeters = 200) {
  const leg = route.legs.find((l) => l.legId === legId);
  const at = coord(location);
  if (!leg || !at || !Array.isArray(leg.alignment)) return [];
  const frame = frameAt(at);
  return leg.alignment
    .map((p) => ({ location: p, d: len(frame.xy(p)) }))
    .filter((c) => c.d <= radiusMeters)
    .sort((a, b) => a.d - b.d || (coordKey(a.location) < coordKey(b.location) ? -1 : 1))
    .map((c) => ({ location: c.location, distanceMeters: roundTo(c.d, 1), basis: "leg-alignment-vertex" }));
}
