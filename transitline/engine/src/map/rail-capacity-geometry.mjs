// Rail capacity geometry (see docs/rail-capacity-geometry-contract.md): the spatial facts a rail operation model needs
// from the map — physical sections and how they join, block boundaries inside a section, junctions, terminals and the
// spatial constraints of the track. Nothing else: how many trains fit, headways, timetables, release times, cost,
// time and any possible / impossible verdict belong to the management engine. This module never imports it.
//
// Missing data: a value that cannot be known is `null`, its name is in `unknown[]` and the reason is in
// `unknownReasons` (always 1:1) — never 0, false or []. No pack states single / double track, signals, block
// boundaries, junctions or terminals: those exist here only as what the player (or a named source) states, and are
// never inferred from a station, an operator tag or a line name.
import { stableId, round6, roundTo } from "./ids.mjs";
import { THROUGH_ROUTE_SCHEMA } from "./through-route.mjs";
import { makeSpatialContext } from "./spatial.mjs";
import { withRailLayer } from "./plan-geometry.mjs";
import { frameAt, sub, len, qualityOf, worse } from "./local-geometry.mjs";
import { polylineMetres, buildJunctions, buildTerminals, JOIN_TOLERANCE_METERS, NEAR_DISTANCE_METERS } from "./rail-capacity-facilities.mjs";

export const RAIL_CAPACITY_GEOMETRY_SCHEMA = "transitline.rail-capacity-geometry/1";
export const RAIL_CAPACITY_EXPORT_SCHEMA = "transitline.rail-capacity-export/1";
export const DIRECTION_MODES = Object.freeze(["single", "double"]);
export const FACT_BASES = Object.freeze(["player", "source"]);
export { JOIN_TOLERANCE_METERS, NEAR_DISTANCE_METERS };

// A design the player saved has a key; its id follows the key, not the plans, so editing keeps it.
export const keyedRailGeometryId = (packId, key) => stableId("rail-geometry", packId, "key", key);
// A hash of the plan's spatial facts only (no names): a design made against another revision is stale.
export const planRevisionOf = (plan) => stableId("plan-revision", plan.planId, JSON.stringify({
  stations: [...plan.stationCandidates].sort((a, b) => (a.id < b.id ? -1 : 1)).map((s) => [s.id, s.location]),
  segments: [...plan.segments].sort((a, b) => (a.id < b.id ? -1 : 1)).map((s) => [s.id, s.from, s.to, s.lengthMeters, s.alignment]),
}));

const hasKey = (v) => v !== undefined && v !== null && v !== "";
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sortedObject = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => byText(a, b)));
const refKey = (ref) => (ref?.planId ? `plan|${ref.planId}|${ref.segmentId}` : ref?.externalLineId ? `ext|${ref.externalLineId}|${[ref.fromStationId, ref.toStationId].sort().join("|")}` : null);
const pointAt = (poly, d) => {
  let rest = d;
  for (let i = 1; i < poly.length; i++) {
    const l = len(sub(poly[i], poly[i - 1]));
    if (rest <= l || i === poly.length - 1) { const t = l === 0 ? 0 : Math.max(0, Math.min(1, rest / l)); return [poly[i - 1][0] + (poly[i][0] - poly[i - 1][0]) * t, poly[i - 1][1] + (poly[i][1] - poly[i - 1][1]) * t]; }
    rest -= l;
  }
  return poly[0];
};
const NO_ALIGNMENT = "external-alignment-not-in-source";

// drawn: { key?, name?, planIds: [planId...], externalLineIds?: [id...], throughRouteId?,
//          designedRevisions?: { plans: { [planId]: planRevision }, routes: { [throughRouteId]: geometryRevision } },
//          sectionFacts?: [{ ref, directionMode?, basis?, sourceName?, designedGradientPermille? }],
//            ref: { planId, segmentId } or { externalLineId, fromStationId, toStationId }
//          blockBoundaries?: null | [{ key?, planId, segmentId, measuredFromStationId, alongMeters, basis, sourceName? }],
//            absent/null = no block data; [] = the player declares no boundary inside any section
//          junctions?: null | [{ key?, kind, location, connections: [{ planId, segmentId, role }], handoverId? }],
//          terminals?: null | [{ key?, stationId, platforms?, turnbackTracks? }] }
// ctx:   { pack, plans, externalNetworks?, routes?, stationSites?, spatial? } -> { design, warnings }; design is null when it cannot be tied to the maps.
export function buildRailGeometry(drawn, ctx) {
  const packId = ctx.pack.manifest?.id ?? "pack";
  const reject = (code, extra = {}) => ({ design: null, warnings: [{ code, key: drawn?.key ?? null, ...extra }] });
  const planIds = [...new Set(Array.isArray(drawn?.planIds) ? drawn.planIds : [])].sort(byText);
  if (!planIds.length) return reject("plans-missing");
  const plans = [];
  for (const id of planIds) {
    const plan = (ctx.plans ?? []).find((p) => p.planId === id);
    if (!plan) return reject("plan-missing", { planId: id });
    if (plan.sourcePackId !== packId) return reject("plan-other-pack", { planId: id, planPackId: plan.sourcePackId ?? null });
    plans.push(plan);
  }
  const externalLines = [];
  for (const id of [...new Set(drawn.externalLineIds ?? [])].sort(byText)) {
    const net = (ctx.externalNetworks ?? []).find((n) => n.lines.some((l) => l.id === id));
    if (!net) return reject("external-line-missing", { externalLineId: id });
    externalLines.push({ net, line: net.lines.find((l) => l.id === id) });
  }
  let route = null;
  if (hasKey(drawn.throughRouteId)) {
    route = (ctx.routes ?? []).find((r) => r?.schema === THROUGH_ROUTE_SCHEMA && r.throughRouteId === drawn.throughRouteId) ?? null;
    if (!route) return reject("through-route-missing", { throughRouteId: drawn.throughRouteId });
  }
  const railGeometryId = hasKey(drawn.key) ? keyedRailGeometryId(packId, drawn.key) : stableId("rail-geometry", packId, ...planIds, ...(route ? [route.throughRouteId] : []));

  const warnings = [];
  const unknown = {};
  const mark = (path, reason) => { unknown[path] = reason; };
  const stations = new Map(plans.flatMap((p) => p.stationCandidates.map((s) => [s.id, { id: s.id, planId: p.planId, location: s.location, platformType: s.platformType ?? null }])));

  // --- frame: one local metre frame, anchored at the first plan point in id order ---
  const firstSegment = plans.flatMap((p) => p.segments).sort((a, b) => byText(a.id, b.id))[0];
  const frame = frameAt(firstSegment?.alignment?.[0] ?? plans[0].stationCandidates[0]?.location ?? [0, 0]);
  const xy = (p) => frame.xy(p);

  // --- physical sections: plan segments, and station-level sections of existing lines (no alignment in the source) ---
  const spatial = ctx.externalNetworks?.length ? withRailLayer(ctx.spatial, ctx.externalNetworks) : ctx.spatial ?? makeSpatialContext();
  const used = new Set();
  const sections = [];
  const sectionByRef = new Map();
  const legsOf = (segmentId) => (route ? route.legs.filter((l) => (l.segmentIds ?? []).includes(segmentId)).map((l) => l.legId).sort() : null);
  for (const plan of plans) {
    const at = new Map(plan.stationCandidates.map((s) => [s.id, s.location]));
    for (const seg of plan.segments) {
      const alignment = seg.alignment.map((p) => [round6(p[0]), round6(p[1])]);
      const section = {
        // the two end stations, sorted: a plan drawn the other way round keeps its section ids (its segment ids would not)
        sectionId: stableId("rail-section", packId, "plan", plan.planId, ...[seg.from, seg.to].sort()), sourceKind: "plan", planId: plan.planId, segmentId: seg.id,
        externalNetworkId: null, externalLineId: null, fromStationId: seg.from, toStationId: seg.to,
        startLocation: at.get(seg.from).map(round6), endLocation: at.get(seg.to).map(round6),
        alignment, alignmentXY: alignment.map(xy), lengthMeters: seg.lengthMeters, seg, throughLegIds: legsOf(seg.id),
      };
      sections.push(section);
      sectionByRef.set(refKey({ planId: plan.planId, segmentId: seg.id }), section);
    }
  }
  for (const { net, line } of externalLines) {
    const at = new Map(net.stations.map((s) => [s.id, s.location]));
    line.stationIds.slice(1).forEach((to, i) => {
      const from = line.stationIds[i];
      if (!at.has(from) || !at.has(to)) { warnings.push({ code: "external-station-missing", externalLineId: line.id, stationId: at.has(from) ? to : from }); return; }
      const section = {
        sectionId: stableId("rail-section", packId, "ext", net.id, line.id, ...[from, to].sort()), sourceKind: "external", planId: null, segmentId: null,
        externalNetworkId: net.id, externalLineId: line.id, fromStationId: from, toStationId: to,
        startLocation: at.get(from).map(round6), endLocation: at.get(to).map(round6), alignment: null, alignmentXY: null, lengthMeters: null, seg: null, throughLegIds: null,
      };
      sections.push(section);
      sectionByRef.set(refKey({ externalLineId: line.id, fromStationId: from, toStationId: to }), section);
    });
  }
  sections.sort((a, b) => byText(a.sectionId, b.sectionId));
  const sectionOf = (ref) => sectionByRef.get(refKey(ref)) ?? null;

  // --- what the player states about a section ---
  const stated = new Map();
  for (const [i, f] of (drawn.sectionFacts ?? []).entries()) {
    const s = sectionOf(f?.ref);
    if (!s) { warnings.push({ code: "section-fact-section-missing", index: i }); continue; }
    const entry = stated.get(s.sectionId) ?? {};
    if (f.directionMode !== undefined && f.directionMode !== null) {
      if (DIRECTION_MODES.includes(f.directionMode) && FACT_BASES.includes(f.basis)) Object.assign(entry, { directionMode: f.directionMode, directionModeBasis: f.basis, directionModeSource: hasKey(f.sourceName) ? f.sourceName : null });
      else warnings.push({ code: "direction-mode-invalid", index: i, directionMode: String(f.directionMode), basis: f.basis ?? null });
    }
    if (f.designedGradientPermille !== undefined && f.designedGradientPermille !== null) {
      if (typeof f.designedGradientPermille === "number" && Number.isFinite(f.designedGradientPermille) && f.designedGradientPermille >= 0) entry.designedGradientPermille = roundTo(f.designedGradientPermille, 1);
      else warnings.push({ code: "gradient-invalid", index: i, value: String(f.designedGradientPermille) });
    }
    stated.set(s.sectionId, entry);
  }

  // --- revision: positional design (blocks, junctions, terminals) only counts against the plans / route it was made on ---
  const planRevisions = plans.map((p) => ({ planId: p.planId, planRevision: planRevisionOf(p) }));
  const designed = drawn.designedRevisions ?? null;
  const mismatches = [];
  const missing = [];
  for (const r of planRevisions) {
    const was = designed?.plans?.[r.planId];
    if (was === undefined || was === null) missing.push(r.planId);
    else if (was !== r.planRevision) mismatches.push({ kind: "plan", id: r.planId, designed: was, current: r.planRevision });
  }
  if (route) {
    const was = designed?.routes?.[route.throughRouteId];
    if (was === undefined || was === null) missing.push(route.throughRouteId);
    else if (was !== route.geometryRevision) mismatches.push({ kind: "through-route", id: route.throughRouteId, designed: was, current: route.geometryRevision });
  }
  missing.sort(byText);
  const revisionState = mismatches.length ? "stale" : missing.length ? "not-recorded" : "current";
  const blockedReason = revisionState === "stale" ? "design-revision-stale" : revisionState === "not-recorded" ? "design-revision-not-recorded" : null;
  if (blockedReason) warnings.push({ code: revisionState === "stale" ? "revision-stale" : "revision-not-recorded", key: drawn.key ?? null, mismatches, missing });
  // a design is only read when it was stated and was made on the current plans / route
  const designOf = (input, noData) => { if (!Array.isArray(input)) { return { rows: null, reason: noData }; } return blockedReason ? { rows: null, reason: blockedReason } : { rows: input, reason: null }; };
  const blockDesign = designOf(drawn.blockBoundaries, "no-block-data");
  const junctionDesign = designOf(drawn.junctions, "no-junction-data");
  const terminalDesign = designOf(drawn.terminals, "no-terminal-data");

  // --- blocks and signal candidates ---
  let blocks = null;
  let signalCandidates = null;
  const blockIdsOf = new Map();
  if (!blockDesign.rows) { mark("blocks", blockDesign.reason); mark("signalCandidates", blockDesign.reason); }
  else {
    blocks = [];
    signalCandidates = [];
    const boundariesBySection = new Map();
    for (const [i, b] of blockDesign.rows.entries()) {
      const s = sectionOf({ planId: b?.planId, segmentId: b?.segmentId });
      if (!s) { warnings.push({ code: "boundary-section-missing", index: i }); continue; }
      const toEnd = b.measuredFromStationId === s.toStationId;
      if (!toEnd && b.measuredFromStationId !== s.fromStationId) { warnings.push({ code: "boundary-station-invalid", index: i }); continue; }
      const along = typeof b.alongMeters === "number" && Number.isFinite(b.alongMeters) ? roundTo(toEnd ? s.lengthMeters - b.alongMeters : b.alongMeters, 1) : null;
      if (along === null || along <= 0 || along >= s.lengthMeters) { warnings.push({ code: "boundary-position-invalid", index: i, alongMeters: b.alongMeters ?? null }); continue; }
      if (!FACT_BASES.includes(b.basis)) { warnings.push({ code: "boundary-basis-invalid", index: i, basis: b.basis ?? null }); continue; }
      const ref = hasKey(b.key) ? `key:${b.key}` : `at:${along}`;
      const list = boundariesBySection.get(s.sectionId) ?? [];
      if (list.some((x) => x.ref === ref || Math.abs(x.along - along) < 1)) { warnings.push({ code: "boundary-duplicate", index: i }); continue; }
      list.push({ ref, along, basis: b.basis, source: hasKey(b.sourceName) ? b.sourceName : null, boundaryId: stableId("rail-block-boundary", s.sectionId, ref) });
      boundariesBySection.set(s.sectionId, list);
    }
    for (const s of sections) {
      if (s.sourceKind === "external") { blockIdsOf.set(s.sectionId, null); continue; }
      const cuts = (boundariesBySection.get(s.sectionId) ?? []).sort((a, b) => a.along - b.along);
      const ends = [{ ref: `station:${s.fromStationId}`, along: 0, kind: "section-end", basis: null, source: null, boundaryId: null }, ...cuts.map((c) => ({ ...c, kind: "boundary" })), { ref: `station:${s.toStationId}`, along: s.lengthMeters, kind: "section-end", basis: null, source: null, boundaryId: null }];
      const planar = polylineMetres(s.alignmentXY);
      const place = (along) => frame.ll(pointAt(s.alignmentXY, (along / s.lengthMeters) * planar)).map(round6);
      const mine = [];
      for (let i = 0; i + 1 < ends.length; i++) {
        const a = ends[i];
        const b = ends[i + 1];
        mine.push({
          blockId: stableId("rail-block", s.sectionId, ...[a.ref, b.ref].sort()), sectionId: s.sectionId,
          startAlongMeters: a.along, endAlongMeters: b.along, blockLengthMeters: roundTo(b.along - a.along, 1),
          startLocation: i === 0 ? s.startLocation : place(a.along), endLocation: i + 2 === ends.length ? s.endLocation : place(b.along),
          startBoundary: { kind: a.kind, boundaryId: a.boundaryId, basis: a.basis, sourceName: a.source },
          endBoundary: { kind: b.kind, boundaryId: b.boundaryId, basis: b.basis, sourceName: b.source },
          declaredWithoutIntermediateBoundary: cuts.length === 0, signalCandidateIds: [],
        });
      }
      // a signal position candidate at each stated boundary, facing each end station; it protects the block ahead of it
      cuts.forEach((c, i) => {
        for (const [facing, ahead] of [[s.toStationId, mine[i + 1]], [s.fromStationId, mine[i]]]) {
          const candidate = {
            signalCandidateId: stableId("rail-signal-candidate", c.boundaryId, facing), sectionId: s.sectionId, boundaryId: c.boundaryId,
            alongMeters: c.along, location: place(c.along), facingStationId: facing, protectsBlockId: ahead.blockId, basis: c.basis, sourceName: c.source,
          };
          signalCandidates.push(candidate);
          ahead.signalCandidateIds.push(candidate.signalCandidateId);
        }
      });
      mine.forEach((b) => b.signalCandidateIds.sort(byText));
      blocks.push(...mine);
      blockIdsOf.set(s.sectionId, mine.map((b) => b.blockId).sort(byText));
    }
    blocks.sort((a, b) => byText(a.blockId, b.blockId));
    signalCandidates.sort((a, b) => byText(a.signalCandidateId, b.signalCandidateId));
  }
  mark("signalSystem", "signal-system-not-in-source");

  // --- junctions and terminals ---
  const sectionView = (s) => ({ sectionId: s.sectionId, alignmentXY: s.alignmentXY, fromStationId: s.fromStationId, toStationId: s.toStationId });
  const facilityContext = {
    packId, xy, ll: frame.ll, sections: sections.map(sectionView), station: (id) => stations.get(id) ?? null,
    sectionOf: (ref) => { const s = sectionOf(ref); return s ? sectionView(s) : null; },
    handoverIds: route ? new Set(route.handovers.map((h) => h.handoverId)) : null,
  };
  let junctions = null;
  let terminals = null;
  const junctionIdsOf = new Map();
  if (!junctionDesign.rows) mark("junctions", junctionDesign.reason);
  else {
    const out = buildJunctions(junctionDesign.rows, facilityContext);
    junctions = out.junctions;
    warnings.push(...out.warnings);
    for (const j of junctions) for (const id of j.sectionIds) junctionIdsOf.set(id, [...(junctionIdsOf.get(id) ?? []), j.junctionResourceId]);
  }
  if (!terminalDesign.rows) mark("terminals", terminalDesign.reason);
  else {
    const out = buildTerminals(terminalDesign.rows, facilityContext, new Map((junctions ?? []).filter((j) => j.key !== null).map((j) => [j.key, j])), ctx.stationSites ?? []);
    terminals = out.terminals;
    warnings.push(...out.warnings);
  }

  // --- per-section facts ---
  const sectionFacts = sections.map((s) => {
    const unk = {};
    const st = stated.get(s.sectionId) ?? {};
    const seg = s.seg;
    const external = s.sourceKind === "external";
    let counts = { building: null, river: null, road: null, railway: null };
    if (s.alignment) {
      counts = spatial.crossings(s.alignment);
      for (const [value, field, layer] of [[counts.building, "buildingIntersectionCount", "buildings"], [counts.river, "waterCrossingCount", "water"], [counts.road, "roadCrossingCount", "roads"], [counts.railway, "existingRailwayCrossingCount", "rail"]]) {
        if (value === null) unk[field] = spatial.whyUnknown(layer, s.alignment); else used.add(layer);
      }
    } else for (const f of ["buildingIntersectionCount", "waterCrossingCount", "roadCrossingCount", "existingRailwayCrossingCount"]) unk[f] = NO_ALIGNMENT;
    if (external) for (const f of ["lengthMeters", "alignment", "minimumCurveRadiusMeters", "groundGradientPermille", "structureHint"]) unk[f] = NO_ALIGNMENT;
    else {
      if (!Number.isFinite(seg.minCurveRadiusMeters)) unk.minimumCurveRadiusMeters = "not-in-plan";
      if (!Number.isFinite(seg.gradientPermille)) unk.groundGradientPermille = seg.unknownReasons?.elevationStartMeters ?? "not-in-plan";
      if (!seg.structureHint) unk.structureHint = "not-in-plan";
    }
    if (st.directionMode === undefined) unk.directionMode = external ? "external-track-data-not-in-source" : "track-count-not-stated";
    if (st.designedGradientPermille === undefined) unk.designedGradientPermille = "track-profile-not-designed";
    const blockIds = blockIdsOf.has(s.sectionId) ? blockIdsOf.get(s.sectionId) : null;
    if (blockIds === null) unk.blockIds = external ? NO_ALIGNMENT : unknown.blocks;
    const junctionResourceIds = junctions ? [...new Set(junctionIdsOf.get(s.sectionId) ?? [])].sort(byText) : null;
    if (junctionResourceIds === null) unk.junctionResourceIds = unknown.junctions;
    if (s.throughLegIds === null) unk.throughLegIds = "no-through-route";
    return {
      sectionId: s.sectionId, sourceKind: s.sourceKind, planId: s.planId, segmentId: s.segmentId, externalNetworkId: s.externalNetworkId, externalLineId: s.externalLineId,
      throughLegIds: s.throughLegIds, fromStationId: s.fromStationId, toStationId: s.toStationId, startLocation: s.startLocation, endLocation: s.endLocation,
      alignment: s.alignment, lengthMeters: s.lengthMeters,
      directionMode: st.directionMode ?? null, directionModeBasis: st.directionModeBasis ?? null, directionModeSource: st.directionModeSource ?? null,
      minimumCurveRadiusMeters: !external && Number.isFinite(seg.minCurveRadiusMeters) ? seg.minCurveRadiusMeters : null,
      groundGradientPermille: !external && Number.isFinite(seg.gradientPermille) ? seg.gradientPermille : null,
      designedGradientPermille: st.designedGradientPermille ?? null,
      structureHint: external ? null : seg.structureHint ?? null, structureHintBasis: external ? null : seg.structureHintBasis ?? null,
      buildingIntersectionCount: counts.building, waterCrossingCount: counts.river,
      roadCrossingCount: counts.road === null ? null : Object.values(counts.road).reduce((a, n) => a + n, 0), roadCrossingsByClass: counts.road,
      existingRailwayCrossingCount: counts.railway,
      blockIds, junctionResourceIds,
      ends: null, unknown: Object.keys(unk).sort(), unknownReasons: sortedObject(unk),
    };
  });

  // --- how the sections join: only measured alignments prove a join; the same station id on an external line does not ---
  const measured = sections.filter((s) => s.alignmentXY);
  sectionFacts.forEach((f, i) => {
    const s = sections[i];
    f.ends = ["start", "end"].map((endpoint) => {
      const stationId = endpoint === "start" ? s.fromStationId : s.toStationId;
      const externalHere = sections.filter((o) => o.sourceKind === "external" && o !== s && (o.fromStationId === stationId || o.toStationId === stationId)).map((o) => o.sectionId).sort(byText);
      const location = endpoint === "start" ? s.startLocation : s.endLocation;
      if (!s.alignmentXY) return { endpoint, stationId, location, joinedSectionIds: null, nearSectionIds: null, externalSectionIdsAtStation: externalHere, state: null, unknown: ["state"], unknownReasons: { state: NO_ALIGNMENT } };
      const here = endpoint === "start" ? s.alignmentXY[0] : s.alignmentXY.at(-1);
      const joined = new Set();
      const near = new Set();
      for (const o of measured) {
        if (o === s) continue;
        for (const p of [o.alignmentXY[0], o.alignmentXY.at(-1)]) {
          const d = len(sub(p, here));
          if (d <= JOIN_TOLERANCE_METERS) joined.add(o.sectionId); else if (d <= NEAR_DISTANCE_METERS) near.add(o.sectionId);
        }
      }
      const joinedIds = [...joined].sort(byText);
      const nearIds = [...near].filter((id) => !joined.has(id)).sort(byText);
      let state = null;
      let reason = null;
      if (joinedIds.length) state = true;
      else if (nearIds.length) reason = "endpoints-near-not-joined";
      else if (externalHere.length) reason = NO_ALIGNMENT;
      else state = false;
      return { endpoint, stationId, location, joinedSectionIds: joinedIds, nearSectionIds: nearIds, externalSectionIdsAtStation: externalHere, state, unknown: reason ? ["state"] : [], unknownReasons: reason ? { state: reason } : {} };
    });
  });

  // --- aggregate every unknown into one 1:1 list of paths ---
  const all = { ...unknown };
  const collect = (prefix, item) => { for (const f of item.unknown ?? []) all[`${prefix}:${f}`] = item.unknownReasons[f]; };
  for (const f of sectionFacts) { collect(`section:${f.sectionId}`, f); for (const e of f.ends) collect(`section:${f.sectionId}:end:${e.endpoint}`, e); }
  for (const j of junctions ?? []) {
    collect(`junction:${j.junctionResourceId}`, j);
    for (const c of j.connections) collect(`junction:${j.junctionResourceId}:connection:${c.role}`, c);
    for (const c of j.routeCombinations) collect(`junction:${j.junctionResourceId}:combination:${c.comboId}`, c);
  }
  for (const t of terminals ?? []) {
    collect(`terminal:${t.terminalResourceId}`, t);
    for (const p of t.platformCandidates ?? []) collect(`terminal:${t.terminalResourceId}:platform:${p.platformCandidateId}`, p);
    for (const p of t.turnbackCandidates ?? []) collect(`terminal:${t.terminalResourceId}:turnback:${p.turnbackCandidateId}`, p);
  }

  // --- spatial flags: facts about the geometry, not scores ---
  const flags = new Set();
  if (sectionFacts.some((f) => f.sourceKind === "plan" && f.directionMode === null)) flags.add("section-direction-unknown");
  if (sections.some((s) => s.sourceKind === "external")) flags.add("external-alignment-unknown");
  if (blocks === null) flags.add("block-data-missing");
  if (junctions === null) flags.add("junction-data-missing");
  if (terminals === null) flags.add("terminal-data-missing");
  if (revisionState === "stale") flags.add("revision-stale");
  if (revisionState === "not-recorded") flags.add("revision-not-recorded");
  for (const j of junctions ?? []) {
    if (j.attachedToAllSections === false) flags.add("junction-separated"); else if (j.attachedToAllSections === null) flags.add("junction-attachment-unverified");
    if (j.missingRoles.length) flags.add("junction-sections-incomplete");
    if (j.kind === "crossing" && j.routeCombinations.length && j.routeCombinations.every((c) => c.conflictsWith !== null && c.conflictsWith.length === 0)) flags.add("crossing-without-crossing-geometry");
  }
  for (const t of terminals ?? []) {
    for (const p of t.platformCandidates ?? []) {
      if (p.connected === false) flags.add("platform-not-connected"); else if (p.connected === null) flags.add("platform-connection-unverified");
      if (!p.approachReachesTerminalStation) flags.add("approach-not-at-terminal");
    }
    for (const p of t.turnbackCandidates ?? []) { if (p.attached === false) flags.add("turnback-not-connected"); else if (p.attached === null) flags.add("turnback-connection-unverified"); }
  }

  const license = { pack: ctx.pack.manifest?.data?.license ?? null, attribution: ctx.pack.manifest?.data?.attribution ?? [] };
  const sourceLayers = [
    ...plans.map((p) => ({ layer: "plan-geometry", quality: p.dataQuality ?? null, name: `PlanGeometry ${p.planId}`, license: license.pack })),
    ...(externalLines.length ? [{ layer: "existing-network", quality: null, name: `CityPack existing network (${[...new Set(externalLines.map((x) => x.net.id))].sort(byText).join(", ")}), station level`, license: license.pack }] : []),
    ...(route ? [{ layer: "through-route-geometry", quality: route.dataQuality ?? null, name: `ThroughRouteGeometry ${route.throughRouteId}`, license: route.license?.pack ?? null }] : []),
    ...[...used].sort(byText).map((k) => spatial.sources.find((s) => s.layer === k)).filter(Boolean),
  ];
  const unknownPaths = Object.keys(all).sort(byText);
  const dataQuality = sourceLayers.filter((l) => !["plan-geometry", "through-route-geometry", "existing-network"].includes(l.layer)).map((l) => l.quality).filter(Boolean).reduce((q, v) => worse(q, v), qualityOf(unknownPaths.length));
  const closureTargets = sectionFacts.map((f) => ({ sectionId: f.sectionId, blockIds: f.blockIds, lengthMeters: f.lengthMeters }));
  const facts = { planRevisions, sections: sectionFacts, blocks, signalCandidates, junctions, terminals };
  return {
    warnings,
    design: {
      schema: RAIL_CAPACITY_GEOMETRY_SCHEMA, contractVersion: 1,
      railGeometryId, railGeometryRevision: stableId("rail-geometry-revision", railGeometryId, JSON.stringify(facts)),
      key: hasKey(drawn.key) ? drawn.key : null, sourcePackId: packId, sourcePackVersion: ctx.pack.manifest?.version ?? null, name: drawn.name ?? null,
      coordinateReference: "EPSG:4326",
      planIds, planRevisions, externalLineIds: externalLines.map((x) => x.line.id),
      throughRouteId: route?.throughRouteId ?? null, routeGeometryRevision: route?.geometryRevision ?? null,
      revision: { state: revisionState, mismatches, missing },
      sections: sectionFacts, blocks, signalCandidates, signalSystem: null, junctions, terminals, closureTargets,
      spatialFlags: [...flags].sort(byText), dataQuality,
      unknown: unknownPaths, unknownReasons: sortedObject(all),
      warnings, sourceLayers, license,
    },
  };
}

// mapExport: the result of buildMapExport (plans + externalNetworks). routes: ThroughRouteGeometry v1 objects.
export function buildRailGeometryExport({ pack, mapExport, routes = [], stationSites = [], designs = [], spatial }) {
  const built = new Map();
  const warnings = [];
  for (const drawn of designs) {
    const out = buildRailGeometry(drawn, { pack, plans: mapExport.plans, externalNetworks: mapExport.externalNetworks, routes, stationSites, spatial });
    if (!out.design) warnings.push({ code: "rail-geometry-rejected", key: drawn?.key ?? null, reasons: out.warnings });
    else if (built.has(out.design.railGeometryId)) warnings.push({ code: "duplicate-rail-geometry", railGeometryId: out.design.railGeometryId });
    else built.set(out.design.railGeometryId, out.design);
  }
  return {
    schema: RAIL_CAPACITY_EXPORT_SCHEMA, packId: pack.manifest?.id ?? "pack", packVersion: pack.manifest?.version ?? null,
    designs: [...built.values()].sort((a, b) => byText(a.railGeometryId, b.railGeometryId)), warnings,
  };
}
