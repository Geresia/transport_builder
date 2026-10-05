// The spatial facts behind a railway detour service geometry (see docs/railway-detour-service-contract.md): the legs of
// a chosen detour in order, who the source says owns each, where one leg meets the next and how that was measured,
// the stations and their entrances, and the connection lines / transfer passages the player drew. Nothing here prices,
// times, sizes, ranks or approves anything; whether a train may run there, under which agreement and at what charge is
// the management engine's decision, and this module never imports it.
//
// Missing data: a value that cannot be known is `null`, its name is in the item's `unknown[]` and the reason in
// `unknownReasons` (always 1:1) — never 0, false or []. `false` is a measured "does not meet"; `[]` is a measured or
// declared "none". An existing line has station-level data only, so its track is never reported as joined.
import { stableId, round6, roundTo, coordKey } from "./ids.mjs";
import { frameAt, len, sub } from "./local-geometry.mjs";
import { coord, polylineMetres } from "./rail-capacity-facilities.mjs";

// A hand-drawn end this close to a station is on it; farther than NEAR is measurably off it; between is not said.
export const ATTACH_ON_METERS = 15;
export const ATTACH_NEAR_METERS = 50;

const hasKey = (v) => v !== undefined && v !== null && v !== "";
const text = (v) => (v === undefined || v === null || v === "" ? null : String(v));
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
export const uniqueSorted = (list) => [...new Set(list)].sort(byText);
const sortedObject = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => byText(a, b)));
export function marks() {
  const unknownReasons = {};
  return { mark: (field, reason) => { unknownReasons[field] = reason; }, done: () => ({ unknown: Object.keys(unknownReasons).sort(byText), unknownReasons: sortedObject(unknownReasons) }) };
}
const attachState = (d) => (d === null ? null : d <= ATTACH_ON_METERS ? true : d > ATTACH_NEAR_METERS ? false : null);

// two inputs with one id: the smallest JSON is kept (never the first one in the array), the rest are reported
export function dedupe(list, idField, code, warnings) {
  const kept = new Map();
  for (const item of [...list].sort((a, b) => byText(a[idField], b[idField]) || byText(JSON.stringify(a), JSON.stringify(b)))) {
    if (kept.has(item[idField])) warnings.push({ code, id: item[idField] });
    else kept.set(item[idField], item);
  }
  return [...kept.values()];
}

// --- the path: which station each detour section is entered from, walked along the control geometry's own joints ---
// candidate.connections[i] is the joint before section i (the first one joins the affected section); a joint is either a
// shared station or a handover link between two stations.
export function orientPath({ candidate, net }) {
  const out = [];
  const entryOf = (joint, behind) => (joint.stationId !== null ? joint.stationId : (joint.viaStationIds ?? []).find((id) => id !== behind) ?? null);
  let entry = entryOf(candidate.connections[0], candidate.startStationId);
  for (let i = 0; i < candidate.sectionIds.length; i++) {
    const section = net.sections.get(candidate.sectionIds[i]);
    if (!section || (section.fromStationId !== entry && section.toStationId !== entry)) return null;
    const exit = net.far(section, entry);
    out.push({ section, entry, exit });
    entry = entryOf(candidate.connections[i + 1], exit);
  }
  return out;
}

// --- legs ---
// ctx: { detourId, application (usable or null), route (usable or null), catalog (usable or null), externalNetworks, geometry, warnings }
export function legFacts({ item, index, ctx }) {
  const { section, entry, exit } = item;
  const m = marks();
  const forward = section.fromStationId === entry;
  const alignment = section.alignment ? (forward ? section.alignment : [...section.alignment].reverse()) : null;
  if (!alignment) { m.mark("alignment", "external-alignment-not-in-source"); m.mark("lengthMeters", "external-alignment-not-in-source"); }
  const rows = ctx.application ? (ctx.application.sections ?? []).filter((s) => s.railCapacitySectionId === section.sectionId).map((s) => text(s.trackSegmentId)).filter(Boolean) : null;
  if (rows === null) { m.mark("trackSegmentId", ctx.noApplication); m.mark("trackSegmentIds", ctx.noApplication); }
  else if (rows.length !== 1) m.mark("trackSegmentId", rows.length ? "several-track-segments-for-section" : "section-not-in-application");
  // the owner is only ever a value a source or the caller stated: the through route's leg, the existing-infrastructure catalog, the network's own line data
  const routeLeg = ctx.route?.legs.find((l) => (section.sourceKind === "plan" ? (l.segmentIds ?? []).includes(section.segmentId) : l.externalLineId === section.externalLineId && l.externalNetworkId === section.externalNetworkId)) ?? null;
  const entries = section.sourceKind === "external" ? (ctx.catalog?.entries ?? []).filter((e) => e.externalNetworkId === section.externalNetworkId && e.externalLineId === section.externalLineId) : [];
  const catalogOwners = uniqueSorted(entries.map((e) => text(e.infrastructureOwnerId)).filter(Boolean));
  let network = null;
  for (const n of ctx.externalNetworks ?? []) { const l = n.lines.find((x) => x.id === section.externalLineId && n.id === section.externalNetworkId); if (l) network = text(l.infrastructureOwnerId) ?? text(n.infrastructureOwnerId); }
  const stated = [["through-route", text(routeLeg?.infrastructureOwnerId)], ["external-catalog", catalogOwners.length === 1 ? catalogOwners[0] : null], ["external-network", network]].filter(([, v]) => v !== null);
  let owner = null;
  let ownerBasis = null;
  if (new Set(stated.map(([, v]) => v)).size > 1 || catalogOwners.length > 1) { ctx.warnings.push({ code: "leg-owner-sources-disagree", sectionId: section.sectionId, statedInfrastructureOwnerIds: uniqueSorted([...stated.map(([, v]) => v), ...catalogOwners]) }); m.mark("infrastructureOwnerId", "owner-sources-disagree"); }
  else if (stated.length) [ownerBasis, owner] = stated[0];
  else m.mark("infrastructureOwnerId", "owner-not-in-source-data");
  // identification only: which specification describes the existing line; none of its technical facts are carried
  const spec = entries.find((e) => e.specificationId) ?? null;
  if (section.sourceKind === "external" && !spec) { m.mark("externalSpecificationId", ctx.catalog ? "line-not-in-catalog" : "no-catalog"); m.mark("externalSpecificationRevision", ctx.catalog ? "line-not-in-catalog" : "no-catalog"); }
  const g = ctx.geometry;
  return {
    legId: stableId("railway-detour-leg", ctx.detourId, section.sectionId), sequenceIndex: index, basis: "source", sectionId: section.sectionId,
    sourceKind: section.sourceKind, planId: section.planId, segmentId: section.segmentId, throughLegId: routeLeg?.legId ?? null,
    trackSegmentId: rows?.length === 1 ? rows[0] : null, trackSegmentIds: rows,
    externalNetworkId: section.externalNetworkId, externalLineId: section.externalLineId,
    externalSpecificationId: section.sourceKind === "external" ? spec?.specificationId ?? null : null, externalSpecificationRevision: section.sourceKind === "external" ? spec?.specificationRevision ?? null : null,
    fromStationId: entry, toStationId: exit, alignment, lengthMeters: alignment ? section.lengthMeters ?? null : null,
    infrastructureOwnerId: owner, infrastructureOwnerBasis: ownerBasis,
    spatialConstraints: g ? {
      minimumCurveRadiusMeters: section.minimumCurveRadiusMeters ?? null, groundGradientPermille: section.groundGradientPermille ?? null, designedGradientPermille: section.designedGradientPermille ?? null,
      structureHint: section.structureHint ?? null, directionMode: section.directionMode ?? null, directionModeBasis: section.directionModeBasis ?? null,
      buildingIntersectionCount: section.buildingIntersectionCount ?? null, waterCrossingCount: section.waterCrossingCount ?? null, roadCrossingCount: section.roadCrossingCount ?? null, existingRailwayCrossingCount: section.existingRailwayCrossingCount ?? null,
    } : null,
    ...m.done(),
  };
}

// --- joints between the sections: what the control geometry says, plus the gap measured where an alignment exists ---
export function connectionFacts({ detourId, candidate, index, joint, net, path, route, frame }) {
  const m = marks();
  const link = joint.stationId === null;
  const before = index === 0 ? null : path[index - 1]?.section ?? null;
  const after = index === path.length ? null : path[index]?.section ?? null;
  const a = before ?? net?.sections.get(joint.fromSectionId) ?? null;
  const b = after ?? net?.sections.get(joint.toSectionId) ?? null;
  const handover = route && joint.handoverId ? route.handovers.find((h) => h.handoverId === joint.handoverId) ?? null : null;
  let gapMeters = null;
  let evidence = "no-measurement";
  if (!link && a?.alignment && b?.alignment && frame) {
    const end = (s) => (s.fromStationId === joint.stationId ? s.alignment[0] : s.alignment.at(-1));
    gapMeters = roundTo(len(sub(frame.xy(end(a)), frame.xy(end(b)))), 1);
    evidence = "measured-alignments";
  } else if (handover && handover.gapMeters !== null && handover.gapMeters !== undefined) { gapMeters = handover.gapMeters; evidence = "through-route-handover"; }
  if (gapMeters === null) m.mark("gapMeters", !net ? "rail-geometry-not-supplied" : link ? handover?.unknownReasons?.gapMeters ?? "external-topology-not-in-source" : "external-alignment-not-in-source");
  if (joint.physicalConnection === null) m.mark("physicalConnection", joint.unknownReasons?.physicalConnection ?? "external-topology-not-in-source");
  if (joint.handoverId === null && link) m.mark("handoverId", "no-through-route");
  const locations = (joint.stationId !== null ? [joint.stationId] : joint.viaStationIds).map((id) => net?.stations.get(id)?.map(round6) ?? null);
  return {
    connectionId: stableId("railway-detour-connection", detourId, index, joint.fromSectionId, joint.toSectionId), sequenceIndex: index, kind: link ? "handover-link" : "shared-station", basis: "source",
    stationId: joint.stationId, viaStationIds: joint.viaStationIds ?? null, location: link ? null : locations[0], viaLocations: link ? locations : null,
    fromSectionId: joint.fromSectionId, toSectionId: joint.toSectionId, handoverId: joint.handoverId, junctionResourceIds: joint.junctionResourceIds,
    physicalConnection: joint.physicalConnection, gapMeters, evidence, ...m.done(),
  };
}

// --- stations: where, whether existing-line, entrances and platform detail from a station site when there is one ---
export function stationFacts({ stations, net, control, stationSites, connections }) {
  // an interchange: a station where two sections of different plans or existing lines meet
  const interchange = new Set();
  const identity = (s) => (s.sourceKind === "plan" ? `plan:${s.planId}` : `ext:${s.externalNetworkId}:${s.externalLineId}`);
  for (const c of connections) {
    const [p, q] = [net?.sections.get(c.fromSectionId), net?.sections.get(c.toSectionId)];
    if (c.stationId !== null && p && q && identity(p) !== identity(q)) interchange.add(c.stationId);
  }
  return stations.map((s) => {
    const m = marks();
    const location = net?.stations.get(s.stationId) ?? control.turnbackCandidates?.find((t) => t.stationId === s.stationId)?.location ?? null;
    if (!location) m.mark("location", "rail-geometry-not-supplied");
    const external = net ? (net.incident.get(s.stationId) ?? []).every((sid) => net.sections.get(sid).sourceKind === "external") : null;
    const site = stationSites.find((x) => x.connectedStationId === s.stationId) ?? null;
    let entrances = null;
    if (!site) m.mark("entrances", external ? "external-station-detail-not-in-source" : "no-station-site");
    else entrances = (site.entranceCandidates ?? []).filter((e) => coord(e?.location)).map((e) => ({ entranceId: e.entranceId, name: e.name ?? null, location: coord(e.location) })).sort((a, b) => byText(a.entranceId, b.entranceId));
    let platformType = null;
    if (!site) m.mark("platformType", external ? "external-station-detail-not-in-source" : "no-station-site");
    else if (!site.planHints?.platformType) m.mark("platformType", "platform-detail-not-in-source");
    else platformType = site.planHints.platformType;
    return {
      stationId: s.stationId, role: s.role, location: location ? location.map(round6) : null, external, handoverEndpoint: s.handoverEndpoint, isInterchange: interchange.has(s.stationId),
      stationSiteId: site?.stationSiteId ?? null, entrances, platformType, ...m.done(),
    };
  });
}

// --- transfer links: where the through route says two different stations are one connection, only as a straight distance ---
export function transferLinks({ detourId, connections, stations, frame }) {
  const dist = (a, b) => roundTo(len(sub(frame.xy(b), frame.xy(a))), 1);
  return connections.filter((c) => c.kind === "handover-link").map((c) => {
    const m = marks();
    const [a, b] = c.viaStationIds.map((id) => stations.find((s) => s.stationId === id));
    const straight = frame && a?.location && b?.location ? dist(a.location, b.location) : null;
    if (straight === null) m.mark("straightDistanceMeters", "station-location-not-in-source");
    let pairs = null;
    if (!a?.entrances || !b?.entrances) m.mark("entrancePairs", "entrance-data-missing");
    else pairs = a.entrances.flatMap((x) => b.entrances.map((y) => ({ fromEntranceId: x.entranceId, toEntranceId: y.entranceId, straightDistanceMeters: dist(x.location, y.location) })));
    return {
      transferLinkId: stableId("railway-detour-transfer", detourId, ...[...c.viaStationIds].sort(byText)), basis: "source", connectionId: c.connectionId, handoverId: c.handoverId,
      fromStationId: c.viaStationIds[0], toStationId: c.viaStationIds[1], straightDistanceMeters: straight, entrancePairs: pairs, ...m.done(),
    };
  });
}

// --- what the player drew: kept as the player's, measured only against the stations and entrances ---
function endsOf(line, stations, frame, withEntrances) {
  return [line[0], line.at(-1)].map((p) => {
    const m = marks();
    const known = stations.filter((s) => s.location);
    if (!frame || !known.length) { m.mark("nearestStationId", "station-location-not-in-source"); m.mark("distanceMeters", "station-location-not-in-source"); m.mark("attached", "station-location-not-in-source"); return { location: p, nearestStationId: null, distanceMeters: null, attached: null, ...m.done() }; }
    const best = known.map((s) => ({ s, d: len(sub(frame.xy(s.location), frame.xy(p))) })).sort((x, y) => x.d - y.d || byText(x.s.stationId, y.s.stationId))[0];
    // the end is measured against the station's recorded position: for an existing line that is not where its track runs
    const row = { location: p, nearestStationId: best.s.stationId, distanceMeters: roundTo(best.d, 1), attached: attachState(best.d) };
    if (row.attached === null) m.mark("attached", "end-near-station-not-on-it");
    if (withEntrances) {
      const es = known.flatMap((s) => (s.entrances ?? []).map((e) => ({ s, e, d: len(sub(frame.xy(e.location), frame.xy(p))) }))).sort((x, y) => x.d - y.d || byText(x.e.entranceId, y.e.entranceId));
      if (!es.length) { row.nearestEntranceId = null; row.entranceDistanceMeters = null; m.mark("nearestEntranceId", "entrance-data-missing"); m.mark("entranceDistanceMeters", "entrance-data-missing"); }
      else { row.nearestEntranceId = es[0].e.entranceId; row.entranceDistanceMeters = roundTo(es[0].d, 1); }
    }
    return { ...row, ...m.done() };
  });
}
function oriented(points, origin, frame) {
  if (!Array.isArray(points)) return null;
  const line = [];
  for (const p of points) { const c = coord(p); if (!c) return null; if (!line.length || coordKey(line.at(-1)) !== coordKey(c)) line.push(c); }
  if (line.length < 2) return null;
  if (!origin || !frame) return coordKey(line.at(-1)) < coordKey(line[0]) ? [...line].reverse() : line;
  const d = (p) => len(sub(frame.xy(p), frame.xy(origin)));
  const [first, last] = [d(line[0]), d(line.at(-1))];
  return last < first || (last === first && coordKey(line.at(-1)) < coordKey(line[0])) ? [...line].reverse() : line;
}

// document.connections: [{ key?, name?, polyline }] — a line the player drew between two stations of the detour. It never
// changes a joint's physicalConnection: only the source's own measurement can; it is recorded next to it.
export function playerConnectionsOf({ detourId, document, stations, connections, origin, frame, warnings }) {
  if (!Array.isArray(document?.connections)) return null;
  const out = [];
  document.connections.forEach((c, index) => {
    const line = oriented(c?.polyline, origin, frame);
    if (!line) { warnings.push({ code: "player-connection-polyline-invalid", index }); return; }
    const ends = endsOf(line, stations, frame, false);
    const m = marks();
    const states = ends.map((e) => e.attached);
    let joinedAtBothEnds = null;
    if (states.some((s) => s === false)) joinedAtBothEnds = false;
    else if (states.every((s) => s === true) && ends[0].nearestStationId !== ends[1].nearestStationId) joinedAtBothEnds = true;
    else m.mark("joinedAtBothEnds", states.every((s) => s === true) ? "both-ends-at-one-station" : "end-near-station-not-on-it");
    const [p, q] = ends.map((e) => e.nearestStationId);
    const bridges = connections.filter((j) => j.kind === "handover-link" && p !== null && q !== null && p !== q && [p, q].every((id) => j.viaStationIds.includes(id))).map((j) => j.connectionId).sort(byText);
    const key = hasKey(c.key) ? String(c.key) : null;
    out.push({
      playerConnectionId: key ? stableId("railway-detour-player-connection", detourId, "key", key) : stableId("railway-detour-player-connection", detourId, "line", ...line.map(coordKey)),
      basis: "player", key, name: c.name ?? null, polyline: line, lengthMeters: roundTo(polylineMetres(line.map(frameAt(line[0]).xy)), 1), ends, measuredAgainst: "station-location", joinedAtBothEnds, bridgesConnectionIds: bridges, ...m.done(),
    });
  });
  return dedupe(out, "playerConnectionId", "duplicate-player-connection", warnings);
}

// document.transferPaths: [{ key?, name?, polyline }] — a passage the player drew for changing trains. Only its ends are measured.
export function playerTransferPathsOf({ detourId, document, stations, origin, frame, warnings }) {
  if (!Array.isArray(document?.transferPaths)) return null;
  const out = [];
  document.transferPaths.forEach((c, index) => {
    const line = oriented(c?.polyline, origin, frame);
    if (!line) { warnings.push({ code: "player-transfer-path-polyline-invalid", index }); return; }
    const ends = endsOf(line, stations, frame, true);
    const key = hasKey(c.key) ? String(c.key) : null;
    const stationIds = uniqueSorted(ends.filter((e) => e.attached === true).map((e) => e.nearestStationId));
    out.push({
      transferPathId: key ? stableId("railway-detour-transfer-path", detourId, "key", key) : stableId("railway-detour-transfer-path", detourId, "line", ...line.map(coordKey)),
      basis: "player", key, name: c.name ?? null, polyline: line, lengthMeters: roundTo(polylineMetres(line.map(frameAt(line[0]).xy)), 1), ends, stationIdsAtEnds: stationIds,
      unknown: [], unknownReasons: {},
    });
  });
  return dedupe(out, "transferPathId", "duplicate-player-transfer-path", warnings);
}

