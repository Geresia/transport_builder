// Junctions (turnouts, flat crossings) and terminals (platform candidates, turnback / pull-out / stabling tracks) of a
// rail capacity geometry. Pure spatial facts: where a junction sits, which sections meet there, which route
// combinations pass it and how those combinations relate in space (they share a section, or their paths cross),
// where a platform or a turnback track starts and whether it measurably meets the track it should. Release times,
// throughput, turnaround times and any verdict belong to the management engine; this module never imports it.
//
// Missing data: a value that cannot be known is `null`, its name is in the item's `unknown[]` and the reason is in
// `unknownReasons` (always 1:1) — never 0, false or []. A track that is measurably apart is `false`, one that
// measurably meets is `true`, one near-but-not-joined or without a known alignment is `null`.
import { stableId, round6, roundTo, coordKey } from "./ids.mjs";
import { sub, len } from "./local-geometry.mjs";

// Positions this close are the same place; closer than the near distance but not the same place is not joined.
export const JOIN_TOLERANCE_METERS = 1;
export const NEAR_DISTANCE_METERS = 50;
export const TURNBACK_KINDS = Object.freeze(["turnback", "pull-out", "stabling"]);
const ROLES = Object.freeze({ turnout: ["stem", "main", "branch"], crossing: ["a1", "a2", "b1", "b2"] });
const PAIRS = Object.freeze({ turnout: [["stem", "main"], ["stem", "branch"]], crossing: [["a1", "a2"], ["b1", "b2"]] });

const RAY_METERS = 30;
const MIN_ANGLE = (2 * Math.PI) / 180; // rays closer than 2 degrees are the same direction: touching, not crossing
// two combinations cross at a junction when the directions of one separate the directions of the other around the point
function interleaved([a1, a2], [b1, b2]) {
  const all = [[a1, "x"], [a2, "x"], [b1, "y"], [b2, "y"]].sort((p, q) => p[0] - q[0]);
  const gaps = all.map(([angle], i) => { const d = Math.abs(all[(i + 1) % 4][0] - angle); return Math.min(d, 2 * Math.PI - d); });
  return gaps.every((g) => g >= MIN_ANGLE) && all[0][1] !== all[1][1] && all[1][1] !== all[2][1] && all[2][1] !== all[3][1];
}

const hasKey = (v) => v !== undefined && v !== null && v !== "";
export const coord = (p) => (Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90 ? [round6(p[0]), round6(p[1])] : null);
export const asLine = (pts) => {
  if (!Array.isArray(pts)) return null;
  const out = [];
  for (const p of pts) {
    const c = coord(p);
    if (!c) return null;
    if (!out.length || coordKey(out.at(-1)) !== coordKey(c)) out.push(c);
  }
  return out;
};
const sortedObject = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// Nearest point of a polyline (metre frame): distance, arc length to it, the point itself and the polyline's length.
export function locate(p, poly) {
  let best = null;
  let run = 0;
  for (let i = 1; i < poly.length; i++) {
    const a = poly[i - 1];
    const ab = sub(poly[i], a);
    const l2 = ab[0] ** 2 + ab[1] ** 2;
    const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1]) / l2));
    const q = [a[0] + ab[0] * t, a[1] + ab[1] * t];
    const d = Math.hypot(p[0] - q[0], p[1] - q[1]);
    const seg = Math.sqrt(l2);
    if (!best || d < best.d) best = { d, along: run + seg * t, point: q };
    run += seg;
  }
  return { ...(best ?? { d: len(sub(p, poly[0])), along: 0, point: poly[0] }), total: run };
}
// the point `d` metres along a polyline (metre frame)
export function pointAlong(poly, d) {
  let rest = d;
  for (let i = 1; i < poly.length; i++) {
    const l = len(sub(poly[i], poly[i - 1]));
    if (rest <= l || i === poly.length - 1) { const t = l === 0 ? 0 : Math.max(0, Math.min(1, rest / l)); return [poly[i - 1][0] + (poly[i][0] - poly[i - 1][0]) * t, poly[i - 1][1] + (poly[i][1] - poly[i - 1][1]) * t]; }
    rest -= l;
  }
  return poly[0];
}
export const polylineMetres = (poly) => poly.slice(1).reduce((s, p, i) => s + len(sub(p, poly[i])), 0);

// true / false / null for "does this point meet that one": same place, measurably apart, or neither can be said.
export const meetState = (gapMeters) => (gapMeters === null ? null : gapMeters <= JOIN_TOLERANCE_METERS ? true : gapMeters > NEAR_DISTANCE_METERS ? false : null);

// Collects the reason of every unknown field; `done()` returns the 1:1 `unknown` / `unknownReasons` pair.
function marks() {
  const unknownReasons = {};
  return { unknownReasons, mark: (field, reason) => { unknownReasons[field] = reason; }, done: () => ({ unknown: Object.keys(unknownReasons).sort(), unknownReasons: sortedObject(unknownReasons) }) };
}

// c: { packId, xy, ll, sectionOf(ref) -> section | null, sections, station(id) -> { id, planId, location, platformType } | null, handoverIds: Set | null }
// A section: { sectionId, alignmentXY: [[x,y]...] | null, fromStationId, toStationId }

// inputs: [{ key?, kind: "turnout"|"crossing", location, connections: [{ planId, segmentId, role }], handoverId? }]
export function buildJunctions(inputs, c) {
  const warnings = [];
  const built = [];
  for (const [index, input] of inputs.entries()) {
    const kind = input?.kind;
    const location = coord(input?.location);
    if (!ROLES[kind]) { warnings.push({ code: "junction-kind-invalid", index, kind: kind ?? null }); continue; }
    if (!location) { warnings.push({ code: "junction-location-invalid", index }); continue; }
    const at = c.xy(location);
    const connections = [];
    for (const conn of input.connections ?? []) {
      const section = c.sectionOf(conn);
      if (!section) { warnings.push({ code: "junction-section-missing", index, planId: conn?.planId ?? null, segmentId: conn?.segmentId ?? null }); continue; }
      if (!ROLES[kind].includes(conn.role)) { warnings.push({ code: "junction-role-invalid", index, role: conn.role ?? null, kind }); continue; }
      if (connections.some((x) => x.role === conn.role)) { warnings.push({ code: "junction-role-duplicate", index, role: conn.role }); continue; }
      const m = marks();
      const hit = section.alignmentXY ? locate(at, section.alignmentXY) : null;
      if (!hit) for (const f of ["distanceToSectionMeters", "alongMeters", "remainingToFarEndMeters", "attached"]) m.mark(f, "section-alignment-not-in-source");
      const distance = hit ? roundTo(hit.d, 1) : null;
      connections.push({
        sectionId: section.sectionId, role: conn.role, section, hit,
        fact: {
          sectionId: section.sectionId, role: conn.role,
          distanceToSectionMeters: distance,
          alongMeters: hit ? roundTo(hit.along, 1) : null,
          remainingToFarEndMeters: hit ? roundTo(hit.total - hit.along, 1) : null,
          attached: meetState(distance),
          ...m.done(),
        },
      });
    }
    connections.sort((a, b) => byText(a.role, b.role));
    const junctionResourceId = hasKey(input.key)
      ? stableId("rail-junction", c.packId, "key", input.key)
      : stableId("rail-junction", c.packId, kind, ...connections.map((x) => `${x.role}=${x.sectionId}`));

    // route combinations: the pairs of sections a train can pass between at this junction
    const byRole = new Map(connections.map((x) => [x.role, x]));
    const combos = [];
    for (const [ra, rb] of PAIRS[kind]) {
      const a = byRole.get(ra);
      const b = byRole.get(rb);
      if (!a || !b || a.sectionId === b.sectionId) continue;
      const pa = a.hit?.point ?? null;
      const pb = b.hit?.point ?? null;
      // the two directions this route combination leaves the junction in (angles, metre frame), from the junction toward each section's far end
      const ray = (x) => {
        const near = x.hit.along <= x.hit.total / 2;
        const there = pointAlong(x.section.alignmentXY, near ? Math.min(x.hit.along + RAY_METERS, x.hit.total) : Math.max(x.hit.along - RAY_METERS, 0));
        return Math.atan2(there[1] - x.hit.point[1], there[0] - x.hit.point[0]);
      };
      const rays = a.hit && b.hit ? [ray(a), ray(b)] : null;
      const m = marks();
      if (!pa || !pb) m.mark("passDistanceMeters", "section-alignment-not-in-source");
      const [x, y] = [a.sectionId, b.sectionId].sort(byText);
      combos.push({ comboId: stableId("rail-route-combination", junctionResourceId, x, y), fromSectionId: a.sectionId, toSectionId: b.sectionId, fromRole: ra, toRole: rb, rays, m, passDistanceMeters: pa && pb ? roundTo(len(sub(pa, pb)), 1) : null });
    }
    for (const x of combos) {
      const conflicts = [];
      let measurable = true;
      for (const y of combos) {
        if (x === y) continue;
        if ([x.fromSectionId, x.toSectionId].some((id) => id === y.fromSectionId || id === y.toSectionId)) conflicts.push({ comboId: y.comboId, basis: "shared-section" });
        else if (x.rays && y.rays) { if (interleaved(x.rays, y.rays)) conflicts.push({ comboId: y.comboId, basis: "crossing-point" }); }
        else measurable = false;
      }
      if (!measurable) x.m.mark("conflictsWith", "section-alignment-not-in-source");
      x.conflictsWith = measurable ? conflicts.sort((p, q) => byText(p.comboId, q.comboId)) : null;
    }
    const m = marks();
    const states = connections.map((x) => x.fact.attached);
    const attachedToAll = !connections.length ? null : states.some((s) => s === false) ? false : states.every((s) => s === true) ? true : null;
    if (attachedToAll === null) m.mark("attachedToAllSections", connections.length ? "attachment-not-measured" : "no-section-connected");
    let handoverId = null;
    if (hasKey(input.handoverId)) {
      if (c.handoverIds?.has(input.handoverId)) handoverId = input.handoverId;
      else warnings.push({ code: "junction-handover-missing", index, handoverId: input.handoverId });
    }
    built.push({
      junctionResourceId, key: hasKey(input.key) ? input.key : null, kind,
      turnoutId: kind === "turnout" ? stableId("rail-turnout", junctionResourceId) : null,
      crossingId: kind === "crossing" ? stableId("rail-crossing", junctionResourceId) : null,
      location, handoverId,
      connections: connections.map((x) => x.fact),
      sectionIds: [...new Set(connections.map((x) => x.sectionId))].sort(),
      missingRoles: ROLES[kind].filter((r) => !byRole.has(r)),
      attachedToAllSections: attachedToAll,
      routeCombinations: combos.map((x) => ({ comboId: x.comboId, fromSectionId: x.fromSectionId, toSectionId: x.toSectionId, fromRole: x.fromRole, toRole: x.toRole, passLocation: location, passDistanceMeters: x.passDistanceMeters, conflictsWith: x.conflictsWith, ...x.m.done() })).sort((p, q) => byText(p.comboId, q.comboId)),
      ...m.done(),
    });
  }
  return { junctions: built.sort((a, b) => byText(a.junctionResourceId, b.junctionResourceId)), warnings };
}

// inputs: [{ key?, stationId, platforms?: [{ key?, approach: { planId, segmentId }, polyline, platformLengthMeters?, viaJunctionKeys? }],
//            turnbackTracks?: [{ key?, kind, polyline, viaJunctionKey? }] }]
// junctionByKey: Map(input key -> built junction). stationSites: [StationSiteGeometry], only linked by the station they connect to.
export function buildTerminals(inputs, c, junctionByKey, stationSites = []) {
  const warnings = [];
  const built = [];
  for (const [index, input] of inputs.entries()) {
    const station = c.station(input?.stationId);
    if (!station) { warnings.push({ code: "terminal-station-missing", index, stationId: input?.stationId ?? null }); continue; }
    const terminalResourceId = hasKey(input.key) ? stableId("rail-terminal", c.packId, "key", input.key) : stableId("rail-terminal", c.packId, station.planId, station.id);
    const stationXY = c.xy(station.location);
    const approachSections = c.sections.filter((s) => s.fromStationId === station.id || s.toStationId === station.id);
    const stationSite = stationSites.find((s) => s.connectedStationId === station.id) ?? null;
    const m = marks();

    let platformCandidates = null;
    if (Array.isArray(input.platforms)) {
      platformCandidates = [];
      for (const [pi, p] of input.platforms.entries()) {
        const line = asLine(p?.polyline);
        const approach = p?.approach ? c.sectionOf(p.approach) : null;
        if (!line || line.length < 2) { warnings.push({ code: "platform-polyline-invalid", index, platform: pi }); continue; }
        if (!approach) { warnings.push({ code: "platform-approach-missing", index, platform: pi }); continue; }
        const pm = marks();
        const via = (p.viaJunctionKeys ?? []).map((k) => junctionByKey.get(k)).filter(Boolean);
        if ((p.viaJunctionKeys ?? []).length !== via.length) warnings.push({ code: "platform-junction-missing", index, platform: pi });
        // where the platform track has to meet: the last junction of its entry, else the approach section's end at the station
        let target = via.length ? c.xy(via.at(-1).location) : null;
        const reachesStation = approach.fromStationId === station.id || approach.toStationId === station.id;
        if (!target && approach.alignmentXY && reachesStation) target = approach.fromStationId === station.id ? approach.alignmentXY[0] : approach.alignmentXY.at(-1);
        let xyLine = line.map(c.xy);
        if (target && len(sub(xyLine.at(-1), target)) < len(sub(xyLine[0], target))) { xyLine = [...xyLine].reverse(); line.reverse(); }
        const gap = target ? roundTo(len(sub(xyLine[0], target)), 1) : null;
        const state = meetState(gap);
        if (gap === null) { const why = reachesStation ? "section-alignment-not-in-source" : "approach-not-at-terminal"; pm.mark("entryGapMeters", why); pm.mark("connected", why); }
        else if (state === null) pm.mark("connected", "endpoints-near-not-joined");
        const length = Number.isFinite(p.platformLengthMeters) && p.platformLengthMeters > 0 ? roundTo(p.platformLengthMeters, 1) : null;
        if (length === null) pm.mark("platformLengthMeters", "platform-length-not-stated");
        const mid = locate(stationXY, xyLine);
        platformCandidates.push({
          platformCandidateId: hasKey(p.key) ? stableId("rail-platform-candidate", terminalResourceId, "key", p.key) : stableId("rail-platform-candidate", terminalResourceId, approach.sectionId, ...[coordKey(line[0]), coordKey(line.at(-1))].sort()),
          key: hasKey(p.key) ? p.key : null,
          approachSectionId: approach.sectionId,
          approachReachesTerminalStation: reachesStation,
          polyline: line, location: c.ll(mid.point).map(round6), trackLengthMeters: roundTo(polylineMetres(xyLine), 1), platformLengthMeters: length,
          distanceFromStationMeters: roundTo(mid.d, 1),
          entryRoute: { fromSectionId: approach.sectionId, viaJunctionResourceIds: via.map((j) => j.junctionResourceId), entryGapMeters: gap },
          connected: state,
          ...pm.done(),
        });
      }
      platformCandidates.sort((a, b) => byText(a.platformCandidateId, b.platformCandidateId));
    } else m.mark("platformCandidates", "no-platform-data");

    let turnbackCandidates = null;
    if (Array.isArray(input.turnbackTracks)) {
      turnbackCandidates = [];
      for (const [ti, t] of input.turnbackTracks.entries()) {
        const line = asLine(t?.polyline);
        if (!TURNBACK_KINDS.includes(t?.kind)) { warnings.push({ code: "turnback-kind-invalid", index, track: ti, kind: t?.kind ?? null }); continue; }
        if (!line || line.length < 2) { warnings.push({ code: "turnback-polyline-invalid", index, track: ti }); continue; }
        const tm = marks();
        const via = hasKey(t.viaJunctionKey) ? junctionByKey.get(t.viaJunctionKey) ?? null : null;
        if (hasKey(t.viaJunctionKey) && !via) warnings.push({ code: "turnback-junction-missing", index, track: ti });
        let xyLine = line.map(c.xy);
        let target = null;
        let attachSectionId = null;
        if (via) { target = c.xy(via.location); attachSectionId = via.sectionIds.find((id) => approachSections.some((s) => s.sectionId === id)) ?? null; }
        else {
          const near = approachSections.filter((s) => s.alignmentXY)
            .map((s) => ({ s, h: locate(xyLine[0], s.alignmentXY), h2: locate(xyLine.at(-1), s.alignmentXY) }))
            .sort((a, b) => Math.min(a.h.d, a.h2.d) - Math.min(b.h.d, b.h2.d) || byText(a.s.sectionId, b.s.sectionId))[0];
          if (near) { target = near.h2.d < near.h.d ? near.h2.point : near.h.point; attachSectionId = near.s.sectionId; }
        }
        if (target && len(sub(xyLine.at(-1), target)) < len(sub(xyLine[0], target))) { xyLine = [...xyLine].reverse(); line.reverse(); }
        const gap = target ? roundTo(len(sub(xyLine[0], target)), 1) : null;
        const state = meetState(gap);
        if (gap === null) for (const f of ["attachGapMeters", "attached", "attachSectionId"]) tm.mark(f, "no-approach-alignment");
        else if (state === null) tm.mark("attached", "endpoints-near-not-joined");
        turnbackCandidates.push({
          turnbackCandidateId: hasKey(t.key) ? stableId("rail-turnback-candidate", terminalResourceId, "key", t.key) : stableId("rail-turnback-candidate", terminalResourceId, t.kind, ...[coordKey(line[0]), coordKey(line.at(-1))].sort()),
          key: hasKey(t.key) ? t.key : null, kind: t.kind, polyline: line,
          lengthMeters: roundTo(polylineMetres(xyLine), 1),
          viaJunctionResourceId: via?.junctionResourceId ?? null,
          attachSectionId, attachGapMeters: gap, attached: state,
          distanceFromTerminalMeters: roundTo(locate(stationXY, xyLine).d, 1),
          ...tm.done(),
        });
      }
      turnbackCandidates.sort((a, b) => byText(a.turnbackCandidateId, b.turnbackCandidateId));
    } else m.mark("turnbackCandidates", "no-turnback-data");

    built.push({
      terminalResourceId, key: hasKey(input.key) ? input.key : null,
      stationId: station.id, planId: station.planId, location: station.location, platformType: station.platformType ?? null,
      stationSiteId: stationSite?.stationSiteId ?? null,
      approachSectionIds: approachSections.map((s) => s.sectionId).sort(),
      platformCandidates, turnbackCandidates,
      ...m.done(),
    });
  }
  return { terminals: built.sort((a, b) => byText(a.terminalResourceId, b.terminalResourceId)), warnings };
}
