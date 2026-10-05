export const RAIL_REPLACEMENT_TRANSPORT_GEOMETRY_SCHEMA = "transitline.rail-replacement-transport-geometry/1";

const key = (value) => String(value);

function sameSet(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) return false;
  const a = [...new Set(left.map(key))].sort();
  const b = [...new Set(right.map(key))].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function triStateAll(values, label) {
  if (!values.length || values.some((value) => ![true, false, null].includes(value))) {
    throw new Error(`${label} must contain only true, false or null`);
  }
  if (values.includes(false)) return false;
  return values.includes(null) ? null : true;
}

function requireSingle(list, predicate, label) {
  const matches = (list ?? []).filter(predicate);
  if (matches.length !== 1) throw new Error(`${label} is ${matches.length ? "ambiguous" : "not current"}`);
  return matches[0];
}

function stopConnectionOf(geometry, route, stationIds) {
  if (geometry.stopCandidates === null) return null;
  if (!Array.isArray(geometry.stopCandidates)) throw new Error("Replacement stop candidates must be an array or null");
  const nearIds = new Set((route.stopCandidateIdsNear ?? []).map(key));
  const stationFacts = new Map((geometry.stations ?? []).map((station) => [key(station.stationId), station]));
  const states = stationIds.map((stationId) => {
    const nearby = geometry.stopCandidates.filter((stop) => key(stop.stationId) === key(stationId) && nearIds.has(key(stop.stopCandidateId)));
    if (nearby.length) return triStateAll(nearby.map((stop) => stop.roadAdjacent), "Replacement stop road adjacency");
    const station = stationFacts.get(key(stationId));
    if (!station) return null;
    const sources = [station.derivedStopCandidateIds, station.playerStopCandidateIds];
    if (sources.some((value) => value === null)) return null;
    if (sources.every(Array.isArray)) return false;
    return null;
  });
  return triStateAll(states, "Replacement stop connection");
}

function legDistancesOf(route, stationIds) {
  if (!Array.isArray(route.stationApproaches)) throw new Error("Replacement route station approaches are required");
  const along = stationIds.map((stationId) => requireSingle(
    route.stationApproaches,
    (approach) => key(approach.stationId) === key(stationId),
    `Replacement route approach for station ${stationId}`,
  ));
  if (along.some((approach) => approach.passesNear !== true)) throw new Error("Replacement route must pass near every suspended station");
  const distances = along.slice(1).map((approach, index) => Math.abs(approach.alongMeters - along[index].alongMeters));
  if (distances.some((distance) => !(Number.isFinite(distance) && distance > 0))) {
    throw new Error("Replacement route must provide a positive measured distance for every station leg");
  }
  return distances;
}

export function candidateFromRailReplacementGeometry(input = {}) {
  const geometry = input.replacementGeometry;
  const order = input.controlOrder;
  if (geometry?.schema !== RAIL_REPLACEMENT_TRANSPORT_GEOMETRY_SCHEMA || geometry.contractVersion !== 1) {
    throw new Error("RailReplacementTransportGeometry v1 is required");
  }
  if (!order) throw new Error("An active railway control order is required");
  if (input.replacementGeometryRevision === undefined
    || key(input.replacementGeometryRevision) !== key(geometry.replacementGeometryRevision)) {
    throw new Error("Selected replacement-transport geometry revision is stale");
  }
  if (key(geometry.eventId) !== key(input.eventId) || key(geometry.eventId) !== key(order.eventId)) {
    throw new Error("Replacement-transport geometry belongs to another disruption");
  }
  if (key(geometry.controlGeometryId) !== key(order.controlGeometryId)
    || key(geometry.controlGeometryRevision) !== key(order.controlGeometryRevision)) {
    throw new Error("Replacement-transport geometry is stale against the active control order");
  }
  if (key(geometry.partialSuspensionCandidateId) !== key(order.candidateId)) {
    throw new Error("Replacement-transport geometry belongs to another partial suspension");
  }
  if (geometry.operationalLineId !== null && key(geometry.operationalLineId) !== key(order.lineId)) {
    throw new Error("Replacement-transport geometry belongs to another operational line");
  }
  if (!sameSet(geometry.suspendedTrackSegmentIds, order.suspendedTrackSegmentIds)) {
    throw new Error("Replacement-transport geometry has stale operational track mappings");
  }
  if (!sameSet(geometry.selectedTurnbackCandidateIds, order.turnbackCandidateIds)) {
    throw new Error("Replacement-transport geometry has stale turnback selections");
  }
  if (!Array.isArray(geometry.stationSequence) || geometry.stationSequence.length < 2) {
    throw new Error("Replacement-transport geometry requires an ordered suspended-station sequence");
  }
  if (!input.routeId) throw new Error("A current replacement route id is required");
  const route = requireSingle(geometry.routeCandidates, (candidate) => key(candidate.routeId) === key(input.routeId), `Replacement route ${input.routeId}`);
  const stationIds = geometry.stationSequence.map(key);
  const legDistancesMeters = legDistancesOf(route, stationIds);
  const routeConnection = triStateAll([
    route.reachesStartStation,
    route.reachesEndStation,
    route.orderMatchesRail,
    route.alongRoad?.fullyOnRoad,
    route.roadAttachment?.start?.attached,
    route.roadAttachment?.end?.attached,
  ], "Replacement route connection facts");
  const stopConnection = stopConnectionOf(geometry, route, stationIds);
  if (route.roadWidthMeters !== null && !(Number.isFinite(route.roadWidthMeters) && route.roadWidthMeters > 0)) {
    throw new Error("Replacement route road width must be positive or null");
  }
  return {
    candidateId: key(route.routeId),
    routeId: key(route.routeId),
    replacementTransportGeometryId: key(geometry.replacementGeometryId),
    replacementTransportGeometryRevision: key(geometry.replacementGeometryRevision),
    controlGeometryId: key(geometry.controlGeometryId),
    controlGeometryRevision: key(geometry.controlGeometryRevision),
    partialSuspensionCandidateId: key(geometry.partialSuspensionCandidateId),
    stationIds,
    legDistancesMeters,
    roadConnection: routeConnection,
    stopConnection,
    minimumRoadWidthMeters: route.roadWidthMeters,
    spatialConstraintIds: Array.isArray(route.constraintIdsNear) ? [...route.constraintIdsNear].map(key).sort() : null,
  };
}
