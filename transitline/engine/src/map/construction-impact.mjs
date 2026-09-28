// Construction incidents and responses, spatial side (see docs/construction-impact-contract.md). The management
// engine (engine/src/management/**) decides an event's probability, severity, cost, delay, reputation loss and
// the player's response outcome; this module never imports it and never touches cash or construction state. It
// only answers: where did this event happen, what does that place overlap, and which of the construction site's
// own candidates (shaft / work area / material yard / road access / vehicle access) are near it or could replace
// the one it affects.
//
// Missing data: a value that cannot be computed is `null`, its name is in `unknown[]` and the reason is in
// `unknownReasons` — never 0. This module never decides that an incident or complaint happened; it only describes
// the place an event the engine already reported occurred at.
import { round6, roundTo } from "./ids.mjs";
import { makeSpatialContext } from "./spatial.mjs";
import { ringFacts, nearestRoadAt } from "./construction-site.mjs";
import { frameAt, areaAndCentroid, qualityOf, worse } from "./local-geometry.mjs";

export const CONSTRUCTION_IMPACT_SCHEMA = "transitline.construction-impact-geometry/1";
export const CONSTRUCTION_IMPACT_EXPORT_SCHEMA = "transitline.construction-impact-export/1";

export const EVENT_KINDS = Object.freeze(["incident", "complaint", "material-shortage", "permit-delay", "utility-conflict", "unexpected-ground", "access-blocked"]);
// Which of a ConstructionSiteGeometry's five candidate lists a response for this event kind is drawn from.
// permit-delay has no physical response candidate (it is a paperwork hold on the whole package).
const RESPONSE_KINDS = Object.freeze({
  incident: ["accessRoad", "vehicleAccess", "workArea"],
  complaint: ["workArea", "materialYard"],
  "material-shortage": ["materialYard", "accessRoad", "vehicleAccess"],
  "permit-delay": [],
  "utility-conflict": ["workArea", "shaft"],
  "unexpected-ground": ["shaft", "workArea"],
  "access-blocked": ["accessRoad", "vehicleAccess"],
});
// The circle an event's own footprint is drawn as when it has no natural polygon (a shaft/access point is a
// point, not an area). Not a severity or damage radius — just "how much ground this kind of event touches".
export const IMPACT_MODEL = Object.freeze({
  affectedRadiusMeters: { incident: 60, complaint: 120, "material-shortage": 40, "permit-delay": 0, "utility-conflict": 30, "unexpected-ground": 80, "access-blocked": 40 },
  linkRadiusMeters: 60, // a site's own candidate counts as "linked" to the event within this distance
  alternativeSearchRadiusMeters: 1500,
  maxAlternatives: 5,
  circleSides: 16,
});
const IM = IMPACT_MODEL;
const GROUND_UNKNOWN = Object.freeze(["groundwater", "soft-ground", "utilities"]);

const ll6 = ([lon, lat]) => [round6(lon), round6(lat)];
function makeMarks() {
  const unknown = [];
  const reasons = {};
  return { unknown, reasons, mark: (field, reason) => { if (!unknown.includes(field)) unknown.push(field); reasons[field] = reason; } };
}

// candidateId field name -> the site's array field it lives in, for every response-eligible kind.
const ID_FIELD = { shaft: "shaftId", workArea: "workAreaId", materialYard: "materialYardId", accessRoad: "roadAccessId", vehicleAccess: "vehicleAccessId" };
const LIST_FIELD = { shaft: "shaftCandidates", workArea: "workAreaCandidates", materialYard: "materialYardCandidates", accessRoad: "accessRoadCandidates", vehicleAccess: "vehicleAccessCandidates" };

function centroidOf(polygonLL) {
  const frame = frameAt(polygonLL[0]);
  return ll6(frame.ll(areaAndCentroid(polygonLL.map(frame.xy)).centroid));
}
function candidateLocationLL(c) {
  return c.location ?? (c.polygon ? centroidOf(c.polygon) : null);
}

// A circle approximated as a polygon, `sides` vertices, `radius` metres, around `centreLL`.
function circlePolygon(centreLL, radiusM, sides = IM.circleSides) {
  const frame = frameAt(centreLL);
  const ring = Array.from({ length: sides }, (_, i) => {
    const a = (2 * Math.PI * i) / sides;
    return frame.ll([radiusM * Math.cos(a), radiusM * Math.sin(a)]);
  });
  return ring.map(ll6);
}

// Every candidate of the given kinds across the whole export, each tagged with its owning site.
function allCandidatesOf(exp, kinds) {
  const out = [];
  for (const site of exp?.sites ?? []) {
    for (const kind of kinds) {
      for (const c of site[LIST_FIELD[kind]] ?? []) out.push({ kind, id: c[ID_FIELD[kind]], constructionSiteId: site.constructionSiteId, location: candidateLocationLL(c) });
    }
  }
  return out;
}

const R = 6371000;
function haversine([lon1, lat1], [lon2, lat2]) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// drawn: { eventId, eventKind, constructionSiteId, location?: [lon,lat], candidateRef?: { kind, id },
//          selectedResponseCandidateId?: string|null, customAffectedPolygon?: [[lon,lat]...] }
// ctx:   { pack, spatial, constructionExport }  — constructionExport is buildConstructionExport()'s result
export function buildConstructionImpact(drawn, ctx) {
  const warnings = [];
  if (!drawn.eventId) return { impact: null, warnings: [{ code: "impact-no-event-id" }] };
  if (!EVENT_KINDS.includes(drawn.eventKind)) return { impact: null, warnings: [{ code: "event-kind-invalid", eventKind: drawn.eventKind ?? null }] };
  const exp = ctx.constructionExport;
  const site = exp?.sites?.find((s) => s.constructionSiteId === drawn.constructionSiteId);
  if (!site) return { impact: null, warnings: [{ code: "connection-construction-site-missing", constructionSiteId: drawn.constructionSiteId ?? null }] };

  const m = makeMarks();
  const responseKinds = RESPONSE_KINDS[drawn.eventKind] ?? [];

  // --- event location: the engine's own point, or a referenced candidate's location/centroid, or unknown ---
  let eventLocation = null;
  let linkedFromCandidate = null;
  if (Array.isArray(drawn.location) && drawn.location.length === 2) eventLocation = ll6(drawn.location);
  else if (drawn.candidateRef) {
    const found = site[LIST_FIELD[drawn.candidateRef.kind] ?? ""]?.find((c) => c[ID_FIELD[drawn.candidateRef.kind]] === drawn.candidateRef.id);
    if (!found) warnings.push({ code: "linked-candidate-missing", kind: drawn.candidateRef.kind, id: drawn.candidateRef.id });
    else { eventLocation = candidateLocationLL(found); linkedFromCandidate = { kind: drawn.candidateRef.kind, id: drawn.candidateRef.id }; }
  }
  if (!eventLocation) m.mark("eventLocation", "no-event-location");

  // --- affected polygon: a custom edit, the linked candidate's own polygon, the whole site (permit-delay), or a circle ---
  let affectedPolygon = null;
  if (Array.isArray(drawn.customAffectedPolygon) && drawn.customAffectedPolygon.length >= 3) {
    affectedPolygon = drawn.customAffectedPolygon.map(ll6);
  } else if (drawn.eventKind === "permit-delay") {
    affectedPolygon = site.polygon;
  } else if (linkedFromCandidate && ["workArea", "materialYard"].includes(linkedFromCandidate.kind)) {
    affectedPolygon = site[LIST_FIELD[linkedFromCandidate.kind]].find((c) => c[ID_FIELD[linkedFromCandidate.kind]] === linkedFromCandidate.id).polygon;
  } else if (eventLocation) {
    affectedPolygon = circlePolygon(eventLocation, IM.affectedRadiusMeters[drawn.eventKind] || 40);
  }
  if (!affectedPolygon) m.mark("affectedPolygon", "no-event-location");

  // --- spatial facts over the affected polygon: reuse the same overlap logic ConstructionSiteGeometry uses ---
  const spatial = ctx.spatial ?? makeSpatialContext();
  const layers = spatial.layers;
  const frame = frameAt(affectedPolygon ? affectedPolygon[0] : eventLocation ?? site.polygon?.[0] ?? [0, 0]);
  const overlap = ringFacts(affectedPolygon, layers, frame, (field, reason) => m.mark(field === "existingFacilityCrossingCount" ? "existingRailwayOverlapCount" : field, reason));
  let nearestMajorRoad = null, majorRoadAccessible = null;
  if (eventLocation) {
    const near = nearestRoadAt(eventLocation, layers, frame, IM.alternativeSearchRadiusMeters);
    if (near.unknown) m.mark("nearestMajorRoad", near.unknown);
    else {
      nearestMajorRoad = near.nearestRoad && ["major", "highway"].includes(near.nearestRoad.roadClass) ? near.nearestRoad : null;
      // a nearer minor road does not disqualify access; re-search restricted to major/highway if the nearest overall was minor
      if (!nearestMajorRoad) {
        let best = null;
        for (const it of layers.roads?.items ?? []) {
          if (!["major", "highway"].includes(it.cls)) continue;
          const d = nearestRoadAt(eventLocation, { roads: { items: [it], covers: layers.roads.covers } }, frame, IM.alternativeSearchRadiusMeters).nearestRoad;
          if (d && (!best || d.distanceMeters < best.distanceMeters)) best = d;
        }
        nearestMajorRoad = best;
      }
      majorRoadAccessible = nearestMajorRoad ? nearestMajorRoad.distanceMeters <= IM.alternativeSearchRadiusMeters : (layers.roads ? false : null);
      if (majorRoadAccessible === null && layers.roads) m.mark("majorRoadAccessible", "outside-coverage");
    }
  } else { m.mark("nearestMajorRoad", "no-event-location"); m.mark("majorRoadAccessible", "no-event-location"); }

  // --- linked candidates: the one referenced, plus any of the site's own within link radius of the event ---
  const linked = new Map();
  if (linkedFromCandidate) linked.set(`${linkedFromCandidate.kind}:${linkedFromCandidate.id}`, linkedFromCandidate);
  if (eventLocation) {
    for (const kind of responseKinds.length ? responseKinds : Object.keys(LIST_FIELD)) {
      for (const c of site[LIST_FIELD[kind]] ?? []) {
        const loc = candidateLocationLL(c);
        if (!loc) continue;
        const d = haversine(eventLocation, loc);
        if (d <= IM.linkRadiusMeters) linked.set(`${kind}:${c[ID_FIELD[kind]]}`, { kind, id: c[ID_FIELD[kind]] });
      }
    }
  }
  const linkedCandidateIds = [...linked.values()].sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.id < b.id ? -1 : 1));

  // --- alternative candidates: same kinds, same site first, then sibling sites, excluding what is already linked ---
  let alternativeCandidates = [];
  if (eventLocation && responseKinds.length) {
    const linkedIds = new Set(linkedCandidateIds.map((l) => `${l.kind}:${l.id}`));
    const pool = allCandidatesOf(exp, responseKinds).filter((c) => c.location && !linkedIds.has(`${c.kind}:${c.id}`));
    alternativeCandidates = pool
      .map((c) => ({ ...c, distanceMeters: roundTo(haversine(eventLocation, c.location), 1) }))
      .filter((c) => c.distanceMeters <= IM.alternativeSearchRadiusMeters)
      .sort((a, b) => a.distanceMeters - b.distanceMeters || (a.constructionSiteId < b.constructionSiteId ? -1 : 1) || (a.id < b.id ? -1 : 1))
      .slice(0, IM.maxAlternatives)
      .map(({ kind, id, constructionSiteId, distanceMeters, location }) => ({ kind, id, constructionSiteId, distanceMeters, location }));
  } else if (eventLocation === null && responseKinds.length) {
    m.mark("alternativeCandidates", "no-event-location");
  }

  // --- the player's chosen response, validated against what this event can actually link to ---
  let selectedResponseCandidateId = null;
  if (drawn.selectedResponseCandidateId) {
    const allOffered = [...linkedCandidateIds, ...alternativeCandidates];
    const found = allOffered.find((c) => c.id === drawn.selectedResponseCandidateId);
    if (!found) warnings.push({ code: "selected-response-candidate-missing", candidateId: drawn.selectedResponseCandidateId });
    else selectedResponseCandidateId = found.id;
  }

  return {
    impact: {
      schema: CONSTRUCTION_IMPACT_SCHEMA,
      contractVersion: 1,
      eventId: drawn.eventId,
      constructionSiteId: site.constructionSiteId,
      eventKind: drawn.eventKind,
      eventLocation,
      affectedPolygon,
      spatialFacts: {
        connected: { planId: site.connectedPlanId, segmentIds: site.connectedSegmentIds, stationId: site.connectedStationId, depotSiteId: site.connectedDepotSiteId },
        intersectedBuildingCount: overlap.intersectedBuildingCount,
        waterOverlapCount: overlap.waterOverlapCount,
        roadsOccupied: overlap.roadsOccupied,
        existingRailwayOverlapCount: overlap.existingFacilityCrossingCount,
        distanceToResidentialMeters: overlap.distanceToResidentialMeters,
        residentialBasis: overlap.residentialBasis,
        nearestMajorRoad,
        majorRoadAccessible,
      },
      linkedCandidateIds,
      alternativeCandidates,
      selectedResponseCandidateId,
      dataQuality: worse(qualityOf(m.unknown.length), "medium"),
      unknown: m.unknown,
      unknownReasons: m.reasons,
      constraintUnknown: [...GROUND_UNKNOWN],
      sourceLayers: spatial.sources ?? [],
      license: { pack: ctx.pack.manifest?.data?.license ?? null, attribution: ctx.pack.manifest?.data?.attribution ?? [] },
    },
    warnings,
  };
}

// events: [{ eventId, eventKind, constructionSiteId, location?, candidateRef?, selectedResponseCandidateId?, customAffectedPolygon? }]
export function buildConstructionImpactExport({ pack, constructionExport, events = [], spatial }) {
  const seen = new Map();
  const warnings = [];
  for (const drawn of events) {
    const { impact, warnings: w } = buildConstructionImpact(drawn, { pack, spatial: spatial ?? makeSpatialContext(), constructionExport });
    if (!impact) warnings.push({ code: "impact-no-geometry", eventId: drawn.eventId ?? null }, ...w);
    else if (seen.has(impact.eventId)) warnings.push({ code: "duplicate-construction-impact", eventId: impact.eventId });
    else { seen.set(impact.eventId, impact); warnings.push(...w); }
  }
  return {
    schema: CONSTRUCTION_IMPACT_EXPORT_SCHEMA,
    packId: pack.manifest?.id ?? "pack",
    packVersion: pack.manifest?.version ?? null,
    impacts: [...seen.values()].sort((a, b) => (a.eventId < b.eventId ? -1 : 1)),
    warnings,
  };
}
