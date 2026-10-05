// The candidate lists of a railway service control geometry (see docs/railway-service-control-contract.md): where trains
// could turn back, between which stations service could be suspended, which other tracks join the two ends of the
// affected section, and where people could leave the track. Each is a list of spatial facts about the geometry and
// nothing else — no cost, no time, no ranking, no verdict that anything is possible, compatible or sufficient. Which
// candidate is used is the player's choice and the management engine's execution; this module never imports them.
//
// Missing data: a value that cannot be known is `null`, its name is in the item's `unknown[]` and the reason is in
// `unknownReasons` (always 1:1) — never 0, false or []. `[]` is a measured or declared "none".
import { stableId, round6, roundTo, coordKey } from "./ids.mjs";
import { frameAt, sub, len } from "./local-geometry.mjs";
import { locate, coord, NEAR_DISTANCE_METERS } from "./rail-capacity-facilities.mjs";

// How far service suspension may be extended beyond the affected section, and how long a detour may be, are listing
// limits of this module: a longer one exists in the network but is not listed, and the control geometry says so.
export const MAX_SUSPENSION_EXTENSION_SECTIONS = 3;
export const MAX_DETOUR_SECTIONS = 6;
export const EVACUATION_KINDS = Object.freeze(["station", "entrance", "player-access-point", "road-point"]);
export const ACCESS_POINT_KINDS = Object.freeze(["entrance", "road-access"]);
const NO_ALIGNMENT = "external-alignment-not-in-source";

const hasKey = (v) => v !== undefined && v !== null && v !== "";
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const uniqueSorted = (list) => [...new Set(list)].sort(byText);
const sortedObject = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => byText(a, b)));
function marks() {
  const unknownReasons = {};
  return { mark: (field, reason) => { unknownReasons[field] = reason; }, done: () => ({ unknown: Object.keys(unknownReasons).sort(byText), unknownReasons: sortedObject(unknownReasons) }) };
}

// The stations and sections of a rail capacity geometry as a graph.
export function networkOf(geometry) {
  const stations = new Map();
  const sections = new Map();
  const incident = new Map();
  for (const s of geometry.sections) {
    sections.set(s.sectionId, s);
    stations.set(s.fromStationId, s.startLocation);
    stations.set(s.toStationId, s.endLocation);
    for (const id of [s.fromStationId, s.toStationId]) incident.set(id, [...(incident.get(id) ?? []), s.sectionId]);
  }
  for (const list of incident.values()) list.sort(byText);
  return { stations, sections, incident, far: (section, stationId) => (section.fromStationId === stationId ? section.toStationId : section.fromStationId) };
}

// stations reachable from `starts` without using a blocked section, with the number of sections walked
export function reach(net, blocked, starts) {
  const hops = new Map(uniqueSorted(starts).map((id) => [id, 0]));
  const queue = [...hops.keys()];
  for (let i = 0; i < queue.length; i++) {
    for (const sid of net.incident.get(queue[i]) ?? []) {
      if (blocked.has(sid)) continue;
      const next = net.far(net.sections.get(sid), queue[i]);
      if (!hops.has(next)) { hops.set(next, hops.get(queue[i]) + 1); queue.push(next); }
    }
  }
  return hops;
}

// --- turnback candidates: the stations service could turn back at, with the track facilities the geometry states there ---
export function turnbackCandidates({ controlId, net, geometry, affected, hops }) {
  const frame = frameAt([...net.stations.values()].sort((a, b) => byText(coordKey(a), coordKey(b)))[0] ?? [0, 0]);
  const adjacent = new Set([...affected].flatMap((sid) => [net.sections.get(sid).fromStationId, net.sections.get(sid).toStationId]));
  const out = [];
  for (const stationId of [...hops.keys()].sort(byText)) {
    const location = net.stations.get(stationId);
    const terminal = geometry.terminals?.find((t) => t.stationId === stationId) ?? null;
    const m = marks();
    const noTerminal = geometry.terminals === null ? geometry.unknownReasons.terminals ?? "no-terminal-data" : "terminal-not-stated";
    let platformCandidateIds = null;
    let turnbackTrackCandidateIds = null;
    let terminalResourceId = null;
    let facilityAttachments = null;
    let physicalAttachment = null;
    if (!terminal) for (const f of ["terminalResourceId", "platformCandidateIds", "turnbackTrackCandidateIds", "facilityAttachments", "physicalAttachment"]) m.mark(f, noTerminal);
    else {
      terminalResourceId = terminal.terminalResourceId;
      if (terminal.platformCandidates === null) m.mark("platformCandidateIds", terminal.unknownReasons.platformCandidates ?? "no-platform-data");
      else platformCandidateIds = terminal.platformCandidates.map((p) => p.platformCandidateId).sort(byText);
      if (terminal.turnbackCandidates === null) m.mark("turnbackTrackCandidateIds", terminal.unknownReasons.turnbackCandidates ?? "no-turnback-data");
      else turnbackTrackCandidateIds = terminal.turnbackCandidates.map((t) => t.turnbackCandidateId).sort(byText);
      // physicalAttachment says a facility's track measurably meets the approach track — nothing about whether a train can turn there
      facilityAttachments = [
        ...(terminal.turnbackCandidates ?? []).map((t) => ({ kind: "turnback-track", facilityId: t.turnbackCandidateId, attached: t.attached })),
        ...(terminal.platformCandidates ?? []).map((p) => ({ kind: "platform", facilityId: p.platformCandidateId, attached: p.connected })),
      ].sort((a, b) => byText(a.facilityId, b.facilityId));
      if (facilityAttachments.some((f) => f.attached === true)) physicalAttachment = true;
      else if (platformCandidateIds === null) m.mark("physicalAttachment", terminal.unknownReasons.platformCandidates ?? "no-platform-data");
      else if (turnbackTrackCandidateIds === null) m.mark("physicalAttachment", terminal.unknownReasons.turnbackCandidates ?? "no-turnback-data");
      else if (facilityAttachments.every((f) => f.attached === false)) physicalAttachment = false;
      else m.mark("physicalAttachment", "attachment-not-measured");
    }
    let junctionResourceIds = null;
    if (geometry.junctions === null) m.mark("junctionResourceIds", geometry.unknownReasons.junctions ?? "no-junction-data");
    else {
      const here = frame.xy(location);
      const via = terminal ? [...(terminal.platformCandidates ?? []).flatMap((p) => p.entryRoute.viaJunctionResourceIds), ...(terminal.turnbackCandidates ?? []).map((t) => t.viaJunctionResourceId).filter(Boolean)] : [];
      junctionResourceIds = uniqueSorted([...via, ...geometry.junctions.filter((j) => len(sub(frame.xy(j.location), here)) <= NEAR_DISTANCE_METERS).map((j) => j.junctionResourceId)]);
    }
    out.push({
      candidateId: stableId("railway-control-turnback", controlId, stationId), stationId, terminalResourceId, junctionResourceIds,
      approachSectionIds: (net.incident.get(stationId) ?? []).filter((sid) => !affected.has(sid)),
      platformCandidateIds, turnbackTrackCandidateIds, location: location.map(round6), physicalAttachment, facilityAttachments,
      adjacentToDisruption: adjacent.has(stationId), sectionsFromDisruption: hops.get(stationId),
      ...m.done(),
    });
  }
  return out.sort((a, b) => byText(a.candidateId, b.candidateId));
}

// --- partial suspension candidates: the pairs of stations that bound a range of sections containing the affected one ---
export function partialSuspensionCandidates({ controlId, net, geometry, affectedId }) {
  const section = net.sections.get(affectedId);
  const [x0, x1] = [section.fromStationId, section.toStationId].sort(byText);
  let truncated = false;
  // every way to walk outward from one end of the affected section without coming back to its other end
  const walk = (start, forbidden) => {
    const found = [];
    const dfs = (node, stations, sectionIds) => {
      found.push({ boundary: node, stations, sectionIds });
      const next = (net.incident.get(node) ?? []).filter((sid) => sid !== affectedId && !sectionIds.includes(sid) && !stations.includes(net.far(net.sections.get(sid), node)) && net.far(net.sections.get(sid), node) !== forbidden);
      if (sectionIds.length >= MAX_SUSPENSION_EXTENSION_SECTIONS) { if (next.length) truncated = true; return; }
      for (const sid of next) { const f = net.far(net.sections.get(sid), node); dfs(f, [...stations, f], [...sectionIds, sid]); }
    };
    dfs(start, [start], []);
    return found;
  };
  const sideA = walk(x0, x1);
  const sideB = walk(x1, x0);
  const out = [];
  for (const a of sideA) {
    for (const b of sideB) {
      if (a.stations.some((s) => b.stations.includes(s))) continue;
      const suspended = new Set([affectedId, ...a.sectionIds, ...b.sectionIds]);
      const suspendedSectionIds = [...suspended].sort(byText);
      const m = marks();
      // blocks: only when every suspended section states its blocks
      const blockLists = suspendedSectionIds.map((sid) => net.sections.get(sid).blockIds);
      const missingAt = blockLists.findIndex((l) => l === null);
      let suspendedBlockIds = null;
      if (missingAt >= 0) m.mark("suspendedBlockIds", net.sections.get(suspendedSectionIds[missingAt]).unknownReasons.blockIds ?? "no-block-data");
      else suspendedBlockIds = uniqueSorted(blockLists.flat());
      let boundaryJunctionResourceIds = null;
      if (geometry.junctions === null) m.mark("boundaryJunctionResourceIds", geometry.unknownReasons.junctions ?? "no-junction-data");
      else boundaryJunctionResourceIds = geometry.junctions.filter((j) => j.sectionIds.some((id) => suspended.has(id)) && j.sectionIds.some((id) => !suspended.has(id))).map((j) => j.junctionResourceId).sort(byText);
      const touched = uniqueSorted(suspendedSectionIds.flatMap((sid) => [net.sections.get(sid).fromStationId, net.sections.get(sid).toStationId]));
      // stations left with no track in service
      const isolatedStationIds = touched.filter((st) => (net.incident.get(st) ?? []).every((sid) => suspended.has(sid)));
      // where a track of an existing line (not suspended) meets the range: only said when the geometry includes any existing line at all
      let replacementConnectionStationIds = null;
      if (geometry.externalLineIds.length === 0) m.mark("replacementConnectionStationIds", "no-existing-line-in-geometry");
      else replacementConnectionStationIds = touched.filter((st) => (net.incident.get(st) ?? []).some((sid) => !suspended.has(sid) && net.sections.get(sid).sourceKind === "external"));
      const g = marks();
      const lengths = suspendedSectionIds.map((sid) => net.sections.get(sid).lengthMeters);
      const lengthMeters = lengths.every((v) => v !== null) ? roundTo(lengths.reduce((s, v) => s + v, 0), 1) : null;
      if (lengthMeters === null) g.mark("suspendedLengthMeters", NO_ALIGNMENT);
      out.push({
        candidateId: stableId("railway-control-suspension", controlId, a.boundary, b.boundary, ...suspendedSectionIds),
        startStationId: a.boundary, endStationId: b.boundary,
        suspendedSectionIds, suspendedBlockIds,
        retainedSectionIds: [...net.sections.keys()].filter((sid) => !suspended.has(sid)).sort(byText),
        boundaryJunctionResourceIds, isolatedStationIds, replacementConnectionStationIds,
        startTurnbackCandidateId: stableId("railway-control-turnback", controlId, a.boundary),
        endTurnbackCandidateId: stableId("railway-control-turnback", controlId, b.boundary),
        geometry: {
          boundaryLocations: [net.stations.get(a.boundary).map(round6), net.stations.get(b.boundary).map(round6)],
          sectionAlignments: suspendedSectionIds.map((sid) => ({ sectionId: sid, alignment: net.sections.get(sid).alignment })),
          suspendedLengthMeters: lengthMeters, ...g.done(),
        },
        ...m.done(),
      });
    }
  }
  return { list: out.sort((a, b) => byText(a.candidateId, b.candidateId)), truncated };
}

// --- detour candidates: other paths between the two ends of the affected section, over the geometry's own sections ---
// A path runs over sections and, where the through route says two legs meet at different stations, over that handover.
// route: the through route the geometry was made with (or null); ownerOf: (section) -> infrastructure owner id | null
export function detourCandidates({ controlId, net, geometry, affectedId, route, ownerOf }) {
  const [x0, x1] = [net.sections.get(affectedId).fromStationId, net.sections.get(affectedId).toStationId].sort(byText);
  const legOf = (s) => route?.legs.find((l) => (s.sourceKind === "plan" ? (l.segmentIds ?? []).includes(s.segmentId) : l.externalLineId === s.externalLineId)) ?? null;
  // handovers between legs that end at different stations: the route itself says these two stations are one connection
  const links = new Map();
  for (const h of route?.handovers ?? []) {
    if (h.fromStationId === h.toStationId) continue;
    links.set(h.fromStationId, [...(links.get(h.fromStationId) ?? []), { handover: h, to: h.toStationId }]);
    links.set(h.toStationId, [...(links.get(h.toStationId) ?? []), { handover: h, to: h.fromStationId }]);
  }
  for (const list of links.values()) list.sort((a, b) => byText(a.handover.handoverId, b.handover.handoverId));
  let truncated = false;
  const paths = [];
  const dfs = (node, stations, steps) => {
    const used = steps.filter((s) => s.kind === "section").map((s) => s.id);
    if (node === x1 && used.length) { paths.push({ stations, steps }); return; }
    const sections = (net.incident.get(node) ?? []).filter((sid) => sid !== affectedId && !used.includes(sid) && !stations.includes(net.far(net.sections.get(sid), node)))
      .map((sid) => ({ kind: "section", id: sid, to: net.far(net.sections.get(sid), node) }));
    const crossings = steps.at(-1)?.kind === "link" ? [] : (links.get(node) ?? []).filter((l) => !stations.includes(l.to)).map((l) => ({ kind: "link", id: l.handover.handoverId, to: l.to, handover: l.handover }));
    const options = [...sections, ...crossings];
    // at the listing limit only a handover straight onto the far end of the affected section may still be crossed
    const allowed = used.length >= MAX_DETOUR_SECTIONS ? options.filter((o) => o.kind === "link" && o.to === x1) : options;
    if (allowed.length < options.length) truncated = true;
    for (const o of allowed) dfs(o.to, [...stations, o.to], [...steps, o]);
  };
  dfs(x0, [x0], []);

  // how two sections meet: at a shared station (a measured join, or the route's statement), or across a handover between stations
  const joint = (aId, bId, stationId, link) => {
    const a = net.sections.get(aId);
    const b = net.sections.get(bId);
    const [la, lb] = [legOf(a), legOf(b)];
    const handover = link ? link.handover : route && la && lb && la.legId !== lb.legId
      ? route.handovers.find((h) => h.stationId === stationId && ((h.fromLegId === la.legId && h.toLegId === lb.legId) || (h.fromLegId === lb.legId && h.toLegId === la.legId))) ?? null : null;
    const m = marks();
    let physicalConnection = null;
    if (!link && a.alignment && b.alignment) {
      const end = a.ends.find((e) => e.stationId === stationId);
      if (end.joinedSectionIds?.includes(bId)) physicalConnection = true;
      else if (end.nearSectionIds?.includes(bId)) m.mark("physicalConnection", "endpoints-near-not-joined");
      else physicalConnection = false;
    } else if (handover && handover.physicalConnection !== null) physicalConnection = handover.physicalConnection;
    else m.mark("physicalConnection", handover?.unknownReasons?.physicalConnection ?? "external-topology-not-in-source");
    const junctionResourceIds = geometry.junctions === null ? null : geometry.junctions.filter((j) => j.sectionIds.includes(aId) && j.sectionIds.includes(bId)).map((j) => j.junctionResourceId).sort(byText);
    if (junctionResourceIds === null) m.mark("junctionResourceIds", geometry.unknownReasons.junctions ?? "no-junction-data");
    return { stationId: link ? null : stationId, viaStationIds: link ? [link.handover.fromStationId, link.handover.toStationId] : null, fromSectionId: aId, toSectionId: bId, physicalConnection, handoverId: handover?.handoverId ?? null, junctionResourceIds, ...m.done() };
  };

  const list = paths.map((p) => {
    // the joints run from the affected section onto the detour, along it, and back onto the affected section
    const connections = [];
    let prev = affectedId;
    let crossing = null;
    p.steps.forEach((st, i) => {
      if (st.kind === "link") { crossing = st; return; }
      connections.push(joint(prev, st.id, p.stations[i], crossing));
      crossing = null;
      prev = st.id;
    });
    connections.push(joint(prev, affectedId, x1, crossing));
    const sectionIds = p.steps.filter((s) => s.kind === "section").map((s) => s.id);
    const sections = sectionIds.map((sid) => net.sections.get(sid));
    const m = marks();
    const states = connections.map((c) => c.physicalConnection);
    const physicalConnection = states.some((s) => s === false) ? false : states.every((s) => s === true) ? true : null;
    if (physicalConnection === null) m.mark("physicalConnection", connections.find((c) => c.physicalConnection === null).unknownReasons.physicalConnection);
    let handoverIds = null;
    if (!route) m.mark("handoverIds", geometry.throughRouteId === null ? "no-through-route" : "through-route-not-current");
    else handoverIds = uniqueSorted(connections.map((c) => c.handoverId).filter(Boolean));
    let junctionResourceIds = null;
    if (connections.some((c) => c.junctionResourceIds === null)) m.mark("junctionResourceIds", geometry.unknownReasons.junctions ?? "no-junction-data");
    else junctionResourceIds = uniqueSorted(connections.flatMap((c) => c.junctionResourceIds));
    const owners = sections.map(ownerOf);
    let infrastructureOwnerIds = null;
    if (owners.some((o) => o === null)) m.mark("infrastructureOwnerIds", "owner-not-in-source-data");
    else infrastructureOwnerIds = uniqueSorted(owners);
    // the sections joined end to end, each turned to run away from the station before it; a handover gap is not drawn over
    let alignment = null;
    if (sections.some((s) => !s.alignment)) m.mark("alignment", NO_ALIGNMENT);
    else if (p.steps.some((s) => s.kind === "link")) m.mark("alignment", "handover-between-different-stations");
    else {
      alignment = [];
      sections.forEach((s, i) => {
        for (const pt of s.fromStationId === p.stations[i] ? s.alignment : [...s.alignment].reverse()) if (!alignment.length || coordKey(alignment.at(-1)) !== coordKey(pt)) alignment.push(pt);
      });
    }
    return {
      candidateId: stableId("railway-control-detour", controlId, ...[...sectionIds].sort(byText), "via", ...p.steps.filter((s) => s.kind === "link").map((s) => s.id).sort(byText)),
      startStationId: x0, endStationId: x1, viaStationIds: p.stations.slice(1, -1),
      sectionIds, externalLineIds: uniqueSorted(sections.map((s) => s.externalLineId).filter(Boolean)),
      handoverIds, junctionResourceIds, infrastructureOwnerIds, alignment, physicalConnection, connections,
      ...m.done(),
    };
  });
  return { list: list.sort((a, b) => byText(a.candidateId, b.candidateId)), truncated };
}

// --- evacuation access candidates: confirmed places to leave the track near the disruption ---
// reference: { location | null, alignment | null } (where the disruption is); roads: the injected road layer or null;
// stationSites: StationSiteGeometry[], linked only through the station they connect to.
export function evacuationCandidates({ controlId, net, adjacentStationIds, reference, document, stationSites = [], roads = null, noReference }) {
  const anchor = reference.location ?? reference.alignment?.[0] ?? net.stations.get(adjacentStationIds[0]) ?? [0, 0];
  const frame = frameAt(anchor);
  const distanceTo = (point) => {
    if (reference.location) return { meters: roundTo(len(sub(frame.xy(point), frame.xy(reference.location))), 1), basis: "location" };
    if (reference.alignment) return { meters: roundTo(locate(frame.xy(point), reference.alignment.map(frame.xy)).d, 1), basis: "affected-extent" };
    return { meters: null, basis: null };
  };
  // the nearest road of the injected layer to a point; `state` is null where the layer says nothing about the place
  const roadNear = (point) => {
    if (!roads) return { state: null, reason: "no-road-layer", nearest: null };
    if (roads.covers && !roads.covers(point)) return { state: null, reason: "outside-road-coverage", nearest: null };
    const here = frame.xy(point);
    let best = null;
    for (const item of roads.items) {
      const hit = locate(here, item.line.map(frame.xy));
      if (!best || hit.d < best.d) best = { d: hit.d, cls: item.cls, point: frame.ll(hit.point) };
    }
    if (!best) return { state: false, reason: null, nearest: null };
    return { state: best.d <= NEAR_DISTANCE_METERS, reason: null, nearest: { roadClass: best.cls, distanceMeters: roundTo(best.d, 1), location: best.point.map(round6) } };
  };
  const make = (kind, refId, stationId, location, extra = {}) => {
    const m = marks();
    const d = distanceTo(location);
    if (d.meters === null) m.mark("distanceMeters", noReference);
    const road = roadNear(location);
    if (road.state === null) { m.mark("roadAdjacent", road.reason); m.mark("nearestRoad", road.reason); }
    // the road layer carries no width: a width exists only where the player stated one, and fitting a vehicle only against a stated vehicle width
    const stated = Number.isFinite(extra.roadWidthMeters) && extra.roadWidthMeters > 0 ? roundTo(extra.roadWidthMeters, 1) : null;
    const vehicle = Number.isFinite(document?.emergencyVehicleWidthMeters) && document.emergencyVehicleWidthMeters > 0 ? document.emergencyVehicleWidthMeters : null;
    let widthFits = null;
    if (stated === null) { m.mark("roadWidthMeters", "road-width-not-in-source"); m.mark("roadWidthAtLeastVehicleWidth", "road-width-not-in-source"); }
    else if (vehicle === null) m.mark("roadWidthAtLeastVehicleWidth", "emergency-vehicle-width-not-stated");
    else widthFits = stated >= vehicle;
    return {
      candidateId: stableId("railway-control-evacuation", controlId, kind, refId), kind, refId, stationId, name: extra.name ?? null,
      location: location.map(round6), basis: extra.basis ?? "source",
      distanceMeters: d.meters, distanceBasis: d.basis,
      roadAdjacent: road.state, nearestRoad: road.nearest, roadWidthMeters: stated, roadWidthAtLeastVehicleWidth: widthFits,
      nearestOfKind: null, ...m.done(),
    };
  };
  const out = [];
  for (const st of uniqueSorted(adjacentStationIds)) {
    out.push(make("station", st, st, net.stations.get(st)));
    for (const site of stationSites.filter((x) => x.connectedStationId === st)) {
      for (const e of site.entranceCandidates ?? []) out.push(make("entrance", e.entranceId, st, e.location, { name: e.name ?? null }));
    }
  }
  for (const a of document?.accessPoints ?? []) {
    const location = coord(a?.location);
    if (!location || !ACCESS_POINT_KINDS.includes(a?.kind) || !["player", "source"].includes(a?.basis)) continue;
    out.push(make("player-access-point", hasKey(a.key) ? `key:${a.key}` : `at:${coordKey(location)}`, hasKey(a.stationId) ? String(a.stationId) : null, location, { name: a.name ?? null, basis: a.basis, roadWidthMeters: a.roadWidthMeters }));
  }
  // the road point nearest to where the disruption is
  const onRoad = reference.location ? roadNear(reference.location).nearest : null;
  if (onRoad) out.push(make("road-point", coordKey(onRoad.location), null, onRoad.location));
  // nearest of each kind: the smallest measured distance (all of them on a tie)
  for (const kind of EVACUATION_KINDS) {
    const same = out.filter((c) => c.kind === kind);
    const min = Math.min(...same.map((c) => c.distanceMeters).filter((v) => v !== null));
    for (const c of same) {
      if (c.distanceMeters === null) { c.unknown = [...c.unknown, "nearestOfKind"].sort(byText); c.unknownReasons = sortedObject({ ...c.unknownReasons, nearestOfKind: noReference }); }
      else c.nearestOfKind = c.distanceMeters === min;
    }
  }
  return out.sort((a, b) => byText(a.candidateId, b.candidateId));
}
