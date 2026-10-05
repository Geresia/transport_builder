// The spatial facts behind a rail replacement transport geometry (see docs/rail-replacement-transport-contract.md):
// the stations along a suspended range in rail order, their entrances, the roadside stops the entrances imply, the
// stops / routes / places the player drew, and how each of those measures against the road layer. Nothing here prices,
// times, sizes, ranks or approves anything; which bus runs where, how often and whether it can is the management
// engine's decision, and this module never imports it.
//
// The road layer is a bag of lines, not a connected graph, so NO route is ever searched or derived from it: a route
// exists here only because the player drew it, and what is measured is how that drawing meets the roads around it.
// A straight line is never passed off as a road. Missing data: a value that cannot be known is `null`, its name is in
// the item's `unknown[]` and the reason in `unknownReasons` (always 1:1) — never 0, false or []. `false` is a
// measured "does not meet"; `[]` is a measured or declared "none".
import { stableId, round6, roundTo, coordKey } from "./ids.mjs";
import { frameAt, sub, len, areaAndCentroid } from "./local-geometry.mjs";
import { locate, coord, polylineMetres, pointAlong, NEAR_DISTANCE_METERS } from "./rail-capacity-facilities.mjs";
import { canonicalRing, selfIntersects } from "./depot-site.mjs";
import { inRing, ringsOverlap, bboxOf, overlaps } from "./spatial.mjs";

// A hand-drawn point this close to a road is on it; farther than NEAR is measurably off it; between is not said.
export const ROAD_ON_METERS = 15;
export const ROAD_NEAR_METERS = NEAR_DISTANCE_METERS;
export const ROUTE_SAMPLE_METERS = 20;
export const STATION_NEAR_METERS = NEAR_DISTANCE_METERS;
export const CONSTRAINT_NEAR_METERS = 30;
const ROAD_SEARCH_DEGREES = 0.004;
export const CONSTRAINT_KINDS = Object.freeze(["bridge", "tunnel", "height-limit", "weight-limit", "width-limit"]);
export const TURNAROUND_KINDS = Object.freeze(["turnaround", "waiting", "boarding"]);
export const BASES = Object.freeze(["player", "source"]);

const hasKey = (v) => v !== undefined && v !== null && v !== "";
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
export const uniqueSorted = (list) => [...new Set(list)].sort(byText);
const sortedObject = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => byText(a, b)));
export function marks() {
  const unknownReasons = {};
  return { mark: (field, reason) => { unknownReasons[field] = reason; }, done: () => ({ unknown: Object.keys(unknownReasons).sort(byText), unknownReasons: sortedObject(unknownReasons) }) };
}
const finite = (v) => typeof v === "number" && Number.isFinite(v);
const positive = (v) => (finite(v) && v > 0 ? roundTo(v, 1) : null);

// --- the road layer: the nearest road to a point, or why that cannot be said ---
export function roadTools(spatial, frame) {
  const layer = spatial?.layers?.roads ?? null;
  const near = (point) => {
    if (!layer) return { state: null, reason: "no-road-layer", nearest: null };
    if (layer.covers && !layer.covers(point)) return { state: null, reason: "outside-road-coverage", nearest: null };
    const here = frame.xy(point);
    let best = null;
    for (const item of layer.items) {
      const b = item.bbox;
      if (b && (point[0] < b[0] - ROAD_SEARCH_DEGREES || point[0] > b[2] + ROAD_SEARCH_DEGREES || point[1] < b[1] - ROAD_SEARCH_DEGREES || point[1] > b[3] + ROAD_SEARCH_DEGREES)) continue;
      const hit = locate(here, item.line.map(frame.xy));
      if (!best || hit.d < best.d) best = { d: hit.d, cls: item.cls, point: frame.ll(hit.point) };
    }
    // no road within the search margin: measurably not beside one, but no distance is known
    if (!best) return { state: false, reason: null, nearest: null };
    return { state: best.d <= ROAD_NEAR_METERS, reason: null, nearest: { roadClass: best.cls, distanceMeters: roundTo(best.d, 1), location: best.point.map(round6) } };
  };
  return { present: layer !== null, layer, frame, near };
}

// --- the rail range: the suspended sections as one path from the start station to the end station ---
export function railRange({ net, candidate }) {
  const suspended = new Set(candidate.suspendedSectionIds);
  const used = new Set();
  const sequence = [candidate.startStationId];
  const sections = [];
  let at = candidate.startStationId;
  while (at !== candidate.endStationId) {
    const sid = (net.incident.get(at) ?? []).find((id) => suspended.has(id) && !used.has(id));
    if (!sid || sequence.length > suspended.size) return null;
    const section = net.sections.get(sid);
    const next = net.far(section, at);
    used.add(sid);
    sections.push({ section, from: at, to: next });
    sequence.push(next);
    at = next;
  }
  return used.size === suspended.size ? { sequence, sections } : null;
}

// --- station facts: entrances, the roadside stops they imply, the player's stops, entrance-to-stop distances ---
// s: { stationId, index, role, location, external, isolated, turnbackCandidateId, turnbackSelected }
export function stationFacts({ replId, s, stationSites, roads, playerStops }) {
  const m = marks();
  const site = stationSites.find((x) => x.connectedStationId === s.stationId) ?? null;
  let entrances = null;
  if (!site) m.mark("entrances", s.external ? "external-station-detail-not-in-source" : "no-station-site");
  else {
    entrances = (site.entranceCandidates ?? []).filter((e) => coord(e?.location)).map((e) => {
      const em = marks();
      const r = roads.near(e.location);
      if (r.state === null) { em.mark("roadside", r.reason); em.mark("nearestRoad", r.reason); em.mark("roadsideDistanceMeters", r.reason); }
      else if (r.nearest === null) em.mark("roadsideDistanceMeters", "no-road-within-search-margin");
      return { entranceId: e.entranceId, name: e.name ?? null, location: coord(e.location), roadside: r.state, roadsideDistanceMeters: r.nearest?.distanceMeters ?? null, nearestRoad: r.nearest, ...em.done() };
    }).sort((a, b) => byText(a.entranceId, b.entranceId));
  }
  // roadside stops: only where an entrance is measurably beside a road; a station centre is never a stop
  let derived = null;
  if (entrances === null) m.mark("derivedStopCandidateIds", m.done().unknownReasons.entrances);
  else if (entrances.some((e) => e.roadside === null)) m.mark("derivedStopCandidateIds", entrances.find((e) => e.roadside === null).unknownReasons.roadside);
  else {
    derived = entrances.filter((e) => e.roadside === true).map((e) => {
      const sm = marks();
      sm.mark("roadWidthMeters", "road-width-not-in-source");
      sm.mark("roadWidthAtLeastVehicleWidth", "road-width-not-in-source");
      return {
        stopCandidateId: stableId("rail-replacement-stop", replId, "entrance", s.stationId, e.entranceId), kind: "entrance-roadside", stationId: s.stationId, entranceId: e.entranceId,
        key: null, name: null, location: e.nearestRoad.location, basis: "source", roadAdjacent: true, nearestRoad: e.nearestRoad, roadWidthMeters: null, roadWidthAtLeastVehicleWidth: null, ...sm.done(),
      };
    }).sort((a, b) => byText(a.stopCandidateId, b.stopCandidateId));
  }
  const mine = playerStops === null ? null : playerStops.filter((p) => p.stationId === s.stationId);
  if (mine === null) m.mark("playerStopCandidateIds", "no-temporary-stop-stated");
  let walkLinks = null;
  if (entrances === null) m.mark("walkLinks", "no-entrance-data");
  else if (derived === null && mine === null) m.mark("walkLinks", "no-stop-candidates");
  else {
    walkLinks = [];
    for (const e of entrances) {
      for (const stop of [...(derived ?? []), ...(mine ?? [])]) {
        const d = len(sub(roads.frame.xy(stop.location), roads.frame.xy(e.location)));
        walkLinks.push({ walkLinkId: stableId("rail-replacement-walk", replId, e.entranceId, stop.stopCandidateId), entranceId: e.entranceId, stopCandidateId: stop.stopCandidateId, straightDistanceMeters: roundTo(d, 1), withinNearDistance: d <= STATION_NEAR_METERS });
      }
    }
    walkLinks.sort((a, b) => byText(a.walkLinkId, b.walkLinkId));
  }
  return {
    derivedStops: derived ?? [],
    station: {
      stationId: s.stationId, sequenceIndex: s.index, role: s.role, location: s.location.map(round6), external: s.external, isolated: s.isolated,
      turnbackCandidateId: s.turnbackCandidateId, turnbackSelected: s.turnbackSelected, stationSiteId: site?.stationSiteId ?? null,
      entrances, derivedStopCandidateIds: derived === null ? null : derived.map((d) => d.stopCandidateId), playerStopCandidateIds: mine === null ? null : mine.map((p) => p.stopCandidateId).sort(byText), walkLinks, ...m.done(),
    },
  };
}

// --- the player's own stops ---
// document.temporaryStops: [{ key?, stationId, location, name?, roadWidthMeters? }]; the stop must serve a station of the range
export function playerStopsOf({ replId, document, stationIds, roads, vehicleWidth, warnings }) {
  if (!Array.isArray(document?.temporaryStops)) return null;
  const out = [];
  document.temporaryStops.forEach((p, index) => {
    const location = coord(p?.location);
    if (!location) { warnings.push({ code: "temporary-stop-location-invalid", index }); return; }
    if (!stationIds.includes(p.stationId)) { warnings.push({ code: "temporary-stop-station-not-in-range", index, stationId: p.stationId ?? null }); return; }
    const m = marks();
    const r = roads.near(location);
    if (r.state === null) { m.mark("roadAdjacent", r.reason); m.mark("nearestRoad", r.reason); }
    const stated = positive(p.roadWidthMeters);
    let fits = null;
    if (stated === null) { m.mark("roadWidthMeters", "road-width-not-in-source"); m.mark("roadWidthAtLeastVehicleWidth", "road-width-not-in-source"); }
    else if (vehicleWidth === null) m.mark("roadWidthAtLeastVehicleWidth", "vehicle-width-not-stated");
    else fits = stated >= vehicleWidth;
    out.push({
      stopCandidateId: hasKey(p.key) ? stableId("rail-replacement-stop", replId, "player-key", p.key) : stableId("rail-replacement-stop", replId, "player-at", p.stationId, coordKey(location)),
      kind: "player-temporary", stationId: p.stationId, entranceId: null, key: hasKey(p.key) ? String(p.key) : null, name: p.name ?? null, location, basis: "player",
      roadAdjacent: r.state, nearestRoad: r.nearest, roadWidthMeters: stated, roadWidthAtLeastVehicleWidth: fits, ...m.done(),
    });
  });
  return dedupe(out, "stopCandidateId", "duplicate-temporary-stop", warnings);
}

// two inputs with one id: the smallest JSON is kept (never the first one in the array), the rest are reported
export function dedupe(list, idField, code, warnings) {
  const kept = new Map();
  for (const item of [...list].sort((a, b) => byText(a[idField], b[idField]) || byText(JSON.stringify(a), JSON.stringify(b)))) {
    if (kept.has(item[idField])) warnings.push({ code, id: item[idField] });
    else kept.set(item[idField], item);
  }
  return [...kept.values()];
}

// --- the player's constraints (bridge, tunnel, height limit...): only what was stated, never inferred from the roads ---
export function constraintsOf({ replId, document, warnings }) {
  if (!Array.isArray(document?.constraints)) return null;
  const out = [];
  document.constraints.forEach((c, index) => {
    const location = coord(c?.location);
    if (!CONSTRAINT_KINDS.includes(c?.kind) || !location) { warnings.push({ code: "constraint-invalid", index, kind: c?.kind ?? null }); return; }
    const m = marks();
    const value = positive(c.value);
    if (value === null) { m.mark("value", "value-not-stated"); m.mark("unit", "value-not-stated"); }
    out.push({
      constraintId: hasKey(c.key) ? stableId("rail-replacement-constraint", replId, "key", c.key) : stableId("rail-replacement-constraint", replId, c.kind, coordKey(location)),
      kind: c.kind, key: hasKey(c.key) ? String(c.key) : null, location, value, unit: value === null ? null : ["m", "t"].includes(c.unit) ? c.unit : "m", basis: BASES.includes(c.basis) ? c.basis : "player", ...m.done(),
    });
  });
  return dedupe(out, "constraintId", "duplicate-constraint", warnings);
}

// --- a route the player drew: kept as drawn (turned to run from the start station), measured against the roads and the stations ---
export function canonicalPolyline(points, startLocation, frame) {
  if (!Array.isArray(points)) return null;
  const line = [];
  for (const p of points) {
    const c = coord(p);
    if (!c) return null;
    if (!line.length || coordKey(line.at(-1)) !== coordKey(c)) line.push(c);
  }
  if (line.length < 2) return null;
  const d = (p) => len(sub(frame.xy(p), frame.xy(startLocation)));
  const [first, last] = [d(line[0]), d(line.at(-1))];
  const reverse = last < first || (last === first && coordKey(line.at(-1)) < coordKey(line[0]));
  return reverse ? [...line].reverse() : line;
}

export function routesOf({ replId, document, frame, roads, spatial, stations, startStation, endStation, stops, constraints, vehicleWidth, warnings }) {
  if (!Array.isArray(document?.routes)) return null;
  const out = [];
  document.routes.forEach((r, index) => {
    const line = canonicalPolyline(r?.polyline, startStation.location, frame);
    if (!line) { warnings.push({ code: "route-polyline-invalid", index }); return; }
    const xy = line.map(frame.xy);
    const total = polylineMetres(xy);
    const m = marks();
    // how the drawing meets the roads: sampled along it, never routed over them
    let alongRoad = null;
    let roadAttachment = null;
    let roadClassesNear = null;
    if (!roads.present) for (const f of ["alongRoad", "roadAttachment", "roadClassesNear"]) m.mark(f, "no-road-layer");
    else {
      const count = Math.max(1, Math.ceil(total / ROUTE_SAMPLE_METERS));
      const samples = Array.from({ length: count + 1 }, (_, i) => {
        const along = (total * i) / count;
        const p = frame.ll(pointAlong(xy, along)).map(round6);
        const hit = roads.near(p);
        return { along, state: hit.state, reason: hit.reason, d: hit.state === null ? null : hit.nearest?.distanceMeters ?? Infinity, cls: hit.nearest?.roadClass ?? null };
      });
      const kind = (x) => (x.d === null ? "unmeasured" : x.d <= ROAD_ON_METERS ? "on" : x.d > ROAD_NEAR_METERS ? "off" : "near");
      const runs = [];
      let open = null;
      for (const x of samples) {
        if (kind(x) === "off") { if (!open) { open = { fromAlongMeters: roundTo(x.along, 1), toAlongMeters: roundTo(x.along, 1) }; runs.push(open); } else open.toAlongMeters = roundTo(x.along, 1); } else open = null;
      }
      const tally = (k) => samples.filter((x) => kind(x) === k).length;
      const am = marks();
      let fully = null;
      if (tally("unmeasured") > 0) am.mark("fullyOnRoad", samples.find((x) => x.state === null).reason);
      else if (tally("off") > 0) fully = false;
      else if (tally("on") === samples.length) fully = true;
      else am.mark("fullyOnRoad", "near-a-road-not-on-it");
      alongRoad = { sampleSpacingMeters: ROUTE_SAMPLE_METERS, sampleCount: samples.length, onRoadCount: tally("on"), nearRoadCount: tally("near"), offRoadCount: tally("off"), unmeasuredCount: tally("unmeasured"), offRoadRuns: runs, fullyOnRoad: fully, ...am.done() };
      const end = (x) => {
        const em = marks();
        let gap = null;
        let state = null;
        if (x.d === null) { em.mark("gapMeters", x.reason); em.mark("attached", x.reason); }
        else if (x.d === Infinity) { state = false; em.mark("gapMeters", "no-road-within-search-margin"); }
        else { gap = x.d; state = x.d <= ROAD_ON_METERS ? true : x.d > ROAD_NEAR_METERS ? false : null; if (state === null) em.mark("attached", "endpoint-near-road-not-joined"); }
        return { gapMeters: gap, attached: state, ...em.done() };
      };
      roadAttachment = { start: end(samples[0]), end: end(samples.at(-1)) };
      roadClassesNear = uniqueSorted(samples.filter((x) => kind(x) === "on").map((x) => x.cls));
    }
    // layers the spatial context holds: how many rivers and building footprints the drawing crosses
    let waterCrossingCount = null;
    let buildingIntersectionCount = null;
    if (!spatial) { m.mark("waterCrossingCount", "no-layer"); m.mark("buildingIntersectionCount", "no-layer"); }
    else {
      const c = spatial.crossings(line);
      waterCrossingCount = c.river;
      buildingIntersectionCount = c.building;
      if (c.river === null) m.mark("waterCrossingCount", spatial.whyUnknown("water", line));
      if (c.building === null) m.mark("buildingIntersectionCount", spatial.whyUnknown("buildings", line));
    }
    // the stations of the range it passes, in the order it passes them
    const approaches = stations.map((st) => {
      const hit = locate(frame.xy(st.location), xy);
      return { stationId: st.stationId, distanceMeters: roundTo(hit.d, 1), alongMeters: roundTo(hit.along, 1), passesNear: hit.d <= STATION_NEAR_METERS };
    });
    const visited = approaches.filter((a) => a.passesNear).sort((a, b) => a.alongMeters - b.alongMeters || byText(a.stationId, b.stationId)).map((a) => a.stationId);
    const indexOf = new Map(stations.map((st, i) => [st.stationId, i]));
    let orderMatchesRail = null;
    if (visited.length < 2) m.mark("orderMatchesRail", "fewer-than-two-stations-passed");
    else orderMatchesRail = visited.every((id, i) => i === 0 || indexOf.get(id) > indexOf.get(visited[i - 1]));
    const stated = positive(r.roadWidthMeters);
    let fits = null;
    if (stated === null) { m.mark("roadWidthMeters", "road-width-not-in-source"); m.mark("roadWidthAtLeastVehicleWidth", "road-width-not-in-source"); }
    else if (vehicleWidth === null) m.mark("roadWidthAtLeastVehicleWidth", "vehicle-width-not-stated");
    else fits = stated >= vehicleWidth;
    let constraintIdsNear = null;
    if (constraints === null) m.mark("constraintIdsNear", "no-constraint-data");
    else constraintIdsNear = constraints.filter((c) => locate(frame.xy(c.location), xy).d <= CONSTRAINT_NEAR_METERS).map((c) => c.constraintId).sort(byText);
    const key = hasKey(r.key) ? String(r.key) : null;
    out.push({
      routeId: key ? stableId("rail-replacement-route", replId, "key", key) : stableId("rail-replacement-route", replId, "line", ...line.map(coordKey)),
      key, name: r.name ?? null, basis: "player", polyline: line, lengthMeters: roundTo(total, 1),
      stationApproaches: approaches, visitedStationIds: visited, orderMatchesRail,
      reachesStartStation: approaches.find((a) => a.stationId === startStation.stationId).passesNear, reachesEndStation: approaches.find((a) => a.stationId === endStation.stationId).passesNear,
      alongRoad, roadAttachment, roadClassesNear, roadWidthMeters: stated, roadWidthAtLeastVehicleWidth: fits, waterCrossingCount, buildingIntersectionCount, constraintIdsNear,
      stopCandidateIdsNear: stops.filter((s) => locate(frame.xy(s.location), xy).d <= STATION_NEAR_METERS).map((s) => s.stopCandidateId).sort(byText),
      ...m.done(),
    });
  });
  return dedupe(out, "routeId", "duplicate-route", warnings);
}

// --- places the player marked for a bus to turn round, wait or let people on and off ---
export function turnaroundAreasOf({ replId, document, frame, roads, spatial, stations, routes, warnings }) {
  if (!Array.isArray(document?.turnaroundAreas)) return null;
  const layerItems = (name) => spatial?.layers?.[name] ?? null;
  const out = [];
  document.turnaroundAreas.forEach((a, index) => {
    const kind = a?.kind ?? "turnaround";
    let ring = null;
    if (a?.polygon !== undefined && a?.polygon !== null) {
      ring = Array.isArray(a.polygon) && a.polygon.every((p) => coord(p)) ? canonicalRing(a.polygon) : null;
      if (ring && selfIntersects(ring)) ring = null;
      if (!ring) { warnings.push({ code: "turnaround-polygon-degenerate", index }); return; }
    }
    const stated = coord(a?.location);
    if (!TURNAROUND_KINDS.includes(kind) || (!stated && !ring)) { warnings.push({ code: "turnaround-area-invalid", index, kind }); return; }
    const m = marks();
    const xyRing = ring ? ring.map(frame.xy) : null;
    const location = stated ?? frame.ll(areaAndCentroid(xyRing).centroid).map(round6);
    const here = frame.xy(location);
    let areaSquareMeters = null;
    if (!ring) m.mark("areaSquareMeters", "no-polygon-drawn");
    else areaSquareMeters = roundTo(areaAndCentroid(xyRing).area, 1);
    const r = roads.near(location);
    if (r.state === null) { m.mark("roadAdjacent", r.reason); m.mark("nearestRoad", r.reason); }
    // building footprints and water the place overlaps (a point counts as inside what contains it)
    const overlapCount = (name, field) => {
      const layer = layerItems(name);
      if (!layer) { m.mark(field, "no-layer"); return null; }
      if (layer.covers && !layer.covers(location)) { m.mark(field, "outside-coverage"); return null; }
      const box = ring ? bboxOf(ring) : [...location, ...location];
      return layer.items.filter((it) => overlaps(box, it.bbox) && (ring ? ringsOverlap(ring, it.rings[0]) : inRing(location, it.rings[0]))).length;
    };
    const key = hasKey(a.key) ? String(a.key) : null;
    if (routes === null) m.mark("routeIdsNear", "no-route-stated");
    out.push({
      turnaroundAreaId: key ? stableId("rail-replacement-turnaround", replId, "key", key) : stableId("rail-replacement-turnaround", replId, kind, ...(ring ?? [location]).map(coordKey)),
      key, name: a.name ?? null, kind, basis: "player", location, polygon: ring, areaSquareMeters,
      roadAdjacent: r.state, nearestRoad: r.nearest,
      buildingOverlapCount: overlapCount("buildings", "buildingOverlapCount"), waterOverlapCount: overlapCount("water", "waterOverlapCount"),
      distancesToStationsMeters: stations.map((st) => ({ stationId: st.stationId, distanceMeters: roundTo(len(sub(frame.xy(st.location), here)), 1) })),
      routeIdsNear: routes === null ? null : routes.filter((rt) => locate(here, rt.polyline.map(frame.xy)).d <= STATION_NEAR_METERS).map((rt) => rt.routeId).sort(byText),
      ...m.done(),
    });
  });
  return dedupe(out, "turnaroundAreaId", "duplicate-turnaround-area", warnings);
}

export { frameAt };
