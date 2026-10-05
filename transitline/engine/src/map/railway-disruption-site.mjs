// Railway disruption sites (see docs/railway-disruption-site-contract.md): where a disruption event sits on a rail
// capacity geometry and what it touches — the section, the block, the signal position candidates, the junctions and
// the stations — as pure spatial facts. How long the disruption lasts, what it costs, how likely it is, whether trains
// can still run and any recovery plan belong to the management engine and the running simulation; this module never
// imports them and never reads or writes their state.
//
// Missing data: a value that cannot be known is `null`, its name is in `unknown[]` and the reason is in
// `unknownReasons` (always 1:1) — never 0, false or []. A place nobody stated is never guessed: an event without a
// location has `location: null` and covers its whole section (or block), it is not placed at the section's middle.
import { stableId, round6, roundTo } from "./ids.mjs";
import { inRing, polylineHitsPolygon } from "./spatial.mjs";
import { frameAt, qualityOf, worse } from "./local-geometry.mjs";
import { canonicalRing, selfIntersects } from "./depot-site.mjs";
import { RAIL_CAPACITY_GEOMETRY_SCHEMA } from "./rail-capacity-geometry.mjs";
import { coord, locate, meetState, pointAlong, polylineMetres, JOIN_TOLERANCE_METERS } from "./rail-capacity-facilities.mjs";

export const RAILWAY_DISRUPTION_SITE_SCHEMA = "transitline.railway-disruption-site-geometry/1";
export const RAILWAY_DISRUPTION_SITE_EXPORT_SCHEMA = "transitline.railway-disruption-site-export/1";
export const RAILWAY_DISRUPTION_EVENT_SCHEMA = "transitline.railway-disruption/1";
export const DISRUPTION_KINDS = Object.freeze(["vehicle-failure", "signal-failure", "track-obstruction", "severe-weather", "construction-incident"]);
export const DISRUPTION_STATUSES = Object.freeze(["active", "responding", "resolved"]);
export const LOCATION_BASES = Object.freeze(["player", "source"]);
const NO_ALIGNMENT = "external-alignment-not-in-source";

// A site follows its event: the same event on the same pack always has the same id, whatever its name or drawing.
export const disruptionSiteIdOf = (packId, eventId) => stableId("railway-disruption-site", packId, eventId);

const hasKey = (v) => v !== undefined && v !== null && v !== "";
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const text = (v) => (v === undefined || v === null ? null : String(v));
const sortedObject = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => byText(a, b)));
const uniqueSorted = (list) => [...new Set(list)].sort(byText);

// the part of a polyline (degrees) between two distances measured along the section's own length
function slicePolyline(alignment, fromMeters, toMeters, lengthMeters) {
  const frame = frameAt(alignment[0]);
  const xy = alignment.map(frame.xy);
  const k = polylineMetres(xy) / lengthMeters;
  const a = fromMeters * k;
  const b = toMeters * k;
  const out = [pointAlong(xy, a)];
  let run = 0;
  for (let i = 1; i < xy.length - 1; i++) {
    run += Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]);
    if (run > a + 1e-6 && run < b - 1e-6) out.push(xy[i]);
  }
  out.push(pointAlong(xy, b));
  return out.map((p) => frame.ll(p).map(round6));
}

// drawn: { eventId, location?: [lon,lat], locationBasis?: "player"|"source", affectedPolygon?: [[lon,lat]...],
//          railCapacitySectionId?, designedRailGeometryRevision? }
// ctx:   { pack, events: [transitline.railway-disruption/1], railGeometry: RailCapacityGeometry v1, applications?: [rail-capacity-application/1] }
// -> { site, warnings }; site is null when the event cannot be tied to the geometry's ids.
export function buildRailwayDisruptionSite(drawn, ctx) {
  const packId = ctx.pack.manifest?.id ?? "pack";
  const reject = (code, extra = {}) => ({ site: null, warnings: [{ code, eventId: drawn?.eventId ?? null, ...extra }] });

  // --- identity: the event, the geometry and every id that links them ---
  const event = hasKey(drawn?.eventId) ? (ctx.events ?? []).find((e) => e?.id === drawn.eventId) : null;
  if (!event) return reject("event-missing");
  if (event.schema !== RAILWAY_DISRUPTION_EVENT_SCHEMA || event.contractVersion !== 1) return reject("event-schema-invalid", { schema: event.schema ?? null });
  if (!hasKey(event.kind) || typeof event.kind !== "string") return reject("event-kind-invalid");
  const geometry = ctx.railGeometry;
  if (geometry?.schema !== RAIL_CAPACITY_GEOMETRY_SCHEMA || geometry.contractVersion !== 1) return reject("rail-geometry-schema-invalid", { schema: geometry?.schema ?? null });
  if (geometry.sourcePackId !== packId) return reject("rail-geometry-other-pack", { geometryPackId: geometry.sourcePackId ?? null });
  const segmentId = text(event.trackSegmentId);
  const blockId = text(event.blockId);
  const trainId = text(event.trainId);
  const scope = segmentId !== null ? (blockId !== null ? "block" : "section") : trainId !== null ? "train" : null;
  if (scope === null) return reject("event-target-missing");

  const warnings = [];
  const unknown = {};
  const mark = (field, reason) => { unknown[field] = reason; };
  if (!DISRUPTION_KINDS.includes(event.kind)) warnings.push({ code: "kind-not-known", eventId: event.id, kind: event.kind });
  const status = DISRUPTION_STATUSES.includes(event.status) ? event.status : null;
  if (status === null) { warnings.push({ code: "status-not-recognized", eventId: event.id, status: event.status ?? null }); mark("status", "status-not-recognized"); }
  // the event's own stated effect, passed through as it is: closed or a speed limit. Nothing is derived from it here.
  const e = event.effect;
  const effect = typeof e?.closed === "boolean" && (e.speedLimitMps === null || e.speedLimitMps === undefined || (Number.isFinite(e.speedLimitMps) && e.speedLimitMps >= 0))
    ? { closed: e.closed, speedLimitMps: e.speedLimitMps ?? null } : null;
  if (effect === null) mark("effect", "effect-not-stated");

  // --- the section: through the rail capacity application (operational track -> map section), the block, or an explicit id ---
  const apps = (ctx.applications ?? []).filter((a) => a?.railGeometryId === geometry.railGeometryId && text(a.operationalLineId) === text(event.lineId));
  const linkStale = apps.length > 0 && apps.every((a) => a.railGeometryRevision !== geometry.railGeometryRevision);
  const mapped = linkStale || segmentId === null ? undefined : apps.map((a) => a.sections?.find((s) => text(s.trackSegmentId) === segmentId)?.railCapacitySectionId).find((id) => hasKey(id));
  const explicit = hasKey(drawn.railCapacitySectionId) ? drawn.railCapacitySectionId : undefined;
  let blockRow = null;
  if (scope === "block") {
    if (geometry.blocks === null) return reject("block-data-missing", { blockId });
    blockRow = geometry.blocks.find((b) => b.blockId === blockId) ?? null;
    if (!blockRow) return reject("block-missing", { blockId });
    if ((mapped !== undefined && mapped !== blockRow.sectionId) || (explicit !== undefined && explicit !== blockRow.sectionId)) return reject("block-section-mismatch", { blockId, blockSectionId: blockRow.sectionId, mapped: mapped ?? null, explicit: explicit ?? null });
  }
  if (mapped !== undefined && explicit !== undefined && mapped !== explicit) return reject("section-link-conflict", { mapped, explicit });
  const sectionId = blockRow?.sectionId ?? mapped ?? explicit ?? null;
  const section = sectionId === null ? null : geometry.sections.find((s) => s.sectionId === sectionId) ?? null;
  if (sectionId !== null && !section) return reject("section-missing", { railCapacitySectionId: sectionId });
  const noSection = scope === "train" ? "train-position-not-in-map" : linkStale ? "rail-capacity-link-stale" : "no-section-link";
  const sectionLinkBasis = section === null ? null : blockRow ? "block" : mapped !== undefined ? "application" : "explicit";
  if (section === null) mark("railCapacitySectionId", noSection);

  // --- the player's drawing (location, influence polygon) counts only against the geometry it was made on ---
  const rawLocation = drawn.location;
  const location = rawLocation === undefined || rawLocation === null ? null : coord(rawLocation);
  if (rawLocation !== undefined && rawLocation !== null && !location) return reject("location-invalid");
  if (drawn.locationBasis !== undefined && drawn.locationBasis !== null && !LOCATION_BASES.includes(drawn.locationBasis)) return reject("location-basis-invalid", { locationBasis: String(drawn.locationBasis) });
  const locationBasis = location ? drawn.locationBasis ?? "player" : null;
  if (!location) mark("location", "location-not-stated");
  let ring = null;
  if (drawn.affectedPolygon !== undefined && drawn.affectedPolygon !== null) {
    ring = Array.isArray(drawn.affectedPolygon) && drawn.affectedPolygon.every((p) => coord(p)) ? canonicalRing(drawn.affectedPolygon) : null;
    if (ring && selfIntersects(ring)) ring = null;
    if (!ring) { warnings.push({ code: "polygon-degenerate", eventId: event.id }); mark("affectedPolygon", "polygon-degenerate"); }
  } else mark("affectedPolygon", "no-polygon-drawn");
  const designState = typeof drawn.designedRailGeometryRevision !== "string" ? "not-recorded" : drawn.designedRailGeometryRevision === geometry.railGeometryRevision ? "current" : "stale";
  const designReason = designState === "current" ? null : designState === "stale" ? "design-revision-stale" : "design-revision-not-recorded";
  if ((location || ring) && designReason) warnings.push({ code: designState === "stale" ? "revision-stale" : "revision-not-recorded", eventId: event.id, designed: drawn.designedRailGeometryRevision ?? null, current: geometry.railGeometryRevision });

  // --- the affected extent: the whole section, or exactly the stated block ---
  const frame = frameAt(section?.alignment?.[0] ?? section?.startLocation ?? location ?? ring?.[0] ?? [0, 0]);
  const xy = (p) => frame.xy(p);
  const sectionXY = section?.alignment ? section.alignment.map(xy) : null;
  const wholeLength = section?.lengthMeters ?? null;
  const from = blockRow ? blockRow.startAlongMeters : 0;
  const to = blockRow ? blockRow.endAlongMeters : wholeLength;
  let affectedSectionIds = null;
  let affectedBlockIds = null;
  let affectedSignalCandidateIds = null;
  let affectedJunctionResourceIds = null;
  let affectedStationIds = null;
  let affectedTerminalResourceIds = null;
  let alignment = null;
  let affectedExtent = null;
  if (!section) for (const f of ["alignment", "affectedExtent", "affectedSectionIds", "affectedBlockIds", "affectedSignalCandidateIds", "affectedJunctionResourceIds", "affectedStationIds", "affectedTerminalResourceIds"]) mark(f, noSection);
  else {
    affectedSectionIds = [section.sectionId];
    affectedExtent = { startLocation: blockRow ? blockRow.startLocation : section.startLocation, endLocation: blockRow ? blockRow.endLocation : section.endLocation, lengthMeters: blockRow ? blockRow.blockLengthMeters : wholeLength };
    if (!section.alignment) mark("alignment", NO_ALIGNMENT);
    else alignment = blockRow ? slicePolyline(section.alignment, from, to, wholeLength) : section.alignment;
    // blocks: the stated one, or every block of the section (null when the section has no block data)
    if (blockRow) affectedBlockIds = [blockRow.blockId];
    else if (section.blockIds === null) mark("affectedBlockIds", section.unknownReasons.blockIds ?? geometry.unknownReasons.blocks ?? "no-block-data");
    else affectedBlockIds = [...section.blockIds];
    // stations at the ends of the affected extent: a block in the middle of a section touches none, which is a fact
    affectedStationIds = uniqueSorted(blockRow
      ? [blockRow.startBoundary.kind === "section-end" ? section.fromStationId : null, blockRow.endBoundary.kind === "section-end" ? section.toStationId : null].filter(Boolean)
      : [section.fromStationId, section.toStationId]);
    // terminals whose approach is this section; for a block, only when the block reaches the terminal's station
    if (geometry.terminals === null) mark("affectedTerminalResourceIds", geometry.unknownReasons.terminals ?? "no-terminal-data");
    else affectedTerminalResourceIds = geometry.terminals.filter((t) => t.approachSectionIds.includes(section.sectionId) && (!blockRow || affectedStationIds.includes(t.stationId))).map((t) => t.terminalResourceId).sort(byText);
    // signal position candidates: those standing at the block's boundaries, or every one of the section
    if (geometry.signalCandidates === null) mark("affectedSignalCandidateIds", geometry.unknownReasons.signalCandidates ?? "no-block-data");
    else {
      const edges = blockRow ? new Set([blockRow.startBoundary.boundaryId, blockRow.endBoundary.boundaryId].filter(Boolean)) : null;
      affectedSignalCandidateIds = geometry.signalCandidates.filter((c) => c.sectionId === section.sectionId && (!edges || edges.has(c.boundaryId) || c.protectsBlockId === blockId)).map((c) => c.signalCandidateId).sort(byText);
    }
    // junctions: every one touching the section, or those whose position along it falls inside the block
    if (blockRow) {
      if (geometry.junctions === null) mark("affectedJunctionResourceIds", geometry.unknownReasons.junctions ?? "no-junction-data");
      else {
        const touching = geometry.junctions.map((j) => ({ j, c: j.connections.find((x) => x.sectionId === section.sectionId) })).filter((x) => x.c);
        if (touching.some((x) => x.c.alongMeters === null)) mark("affectedJunctionResourceIds", "junction-position-unknown");
        else affectedJunctionResourceIds = touching.filter((x) => x.c.alongMeters >= from - JOIN_TOLERANCE_METERS && x.c.alongMeters <= to + JOIN_TOLERANCE_METERS).map((x) => x.j.junctionResourceId).sort(byText);
      }
    } else if (section.junctionResourceIds === null) mark("affectedJunctionResourceIds", section.unknownReasons.junctionResourceIds ?? geometry.unknownReasons.junctions ?? "no-junction-data");
    else affectedJunctionResourceIds = [...section.junctionResourceIds];
  }
  // the extent of an external section is known only at station level: its length is not
  const extentUnknown = {};
  if (affectedExtent && affectedExtent.lengthMeters === null) extentUnknown.lengthMeters = NO_ALIGNMENT;
  if (affectedExtent) Object.assign(affectedExtent, { unknown: Object.keys(extentUnknown), unknownReasons: extentUnknown });

  // --- where the event is on the section: only measured, only against the geometry it was drawn on ---
  let locationAttach = null;
  if (!location) mark("locationAttach", "location-not-stated");
  else if (!section) mark("locationAttach", noSection);
  else if (!sectionXY) mark("locationAttach", NO_ALIGNMENT);
  else if (designReason) mark("locationAttach", designReason);
  else {
    const hit = locate(xy(location), sectionXY);
    const distance = roundTo(hit.d, 1);
    const onSection = meetState(distance);
    const along = roundTo(hit.along * (wholeLength / hit.total), 1);
    const m = {};
    if (onSection === false) m.withinAffectedExtent = "location-not-on-section";
    locationAttach = {
      sectionId: section.sectionId, alongMeters: along, distanceToSectionMeters: distance, onSection,
      withinAffectedExtent: onSection === false ? null : along >= from - JOIN_TOLERANCE_METERS && along <= to + JOIN_TOLERANCE_METERS,
      unknown: Object.keys(m).sort(), unknownReasons: sortedObject(m),
    };
  }

  // --- the influence polygon the player drew, and what it spatially contains ---
  let polygonFacts = null;
  if (!ring) mark("polygonFacts", unknown.affectedPolygon);
  else if (designReason) mark("polygonFacts", designReason);
  else {
    const m = {};
    const ends = geometry.sections.flatMap((s) => [[s.fromStationId, s.startLocation], [s.toStationId, s.endLocation]]);
    const inside = (p) => inRing(p, ring);
    let junctionsInside = null;
    if (geometry.junctions === null) m.junctionResourceIdsInside = geometry.unknownReasons.junctions ?? "no-junction-data";
    else junctionsInside = geometry.junctions.filter((j) => inside(j.location)).map((j) => j.junctionResourceId).sort(byText);
    let signalsInside = null;
    if (geometry.signalCandidates === null) m.signalCandidateIdsInside = geometry.unknownReasons.signalCandidates ?? "no-block-data";
    else signalsInside = geometry.signalCandidates.filter((c) => inside(c.location)).map((c) => c.signalCandidateId).sort(byText);
    if (!location) m.coversLocation = "location-not-stated";
    polygonFacts = {
      sectionIdsCrossed: geometry.sections.filter((s) => s.alignment && polylineHitsPolygon(s.alignment, [ring])).map((s) => s.sectionId).sort(byText),
      sectionIdsNotMeasured: geometry.sections.filter((s) => !s.alignment).map((s) => s.sectionId).sort(byText),
      stationIdsInside: uniqueSorted(ends.filter(([, p]) => inside(p)).map(([id]) => id)),
      junctionResourceIdsInside: junctionsInside, signalCandidateIdsInside: signalsInside,
      coversLocation: location ? inside(location) : null,
      unknown: Object.keys(m).sort(), unknownReasons: sortedObject(m),
    };
  }

  // --- other ways to reach the affected extent: the stations at the section's ends and the sections joined there ---
  const siteId = disruptionSiteIdOf(packId, event.id);
  let alternativeAccessCandidates = null;
  if (!section) mark("alternativeAccessCandidates", noSection);
  else if (!section.alignment) mark("alternativeAccessCandidates", NO_ALIGNMENT);
  else {
    const along = locationAttach?.alongMeters ?? null;
    const distanceReason = !location ? "location-not-stated" : unknown.locationAttach ?? "location-not-measured";
    const item = (kind, refId, relation, endAlong) => ({
      candidateId: stableId("railway-disruption-access", siteId, kind, refId, relation), kind, refId, relation,
      distanceMeters: along === null ? null : roundTo(Math.abs(along - endAlong), 1),
      unknown: along === null ? ["distanceMeters"] : [], unknownReasons: along === null ? { distanceMeters: distanceReason } : {},
    });
    alternativeAccessCandidates = [
      item("station", section.fromStationId, "section-start", 0), item("station", section.toStationId, "section-end", wholeLength),
      ...section.ends.flatMap((end) => (end.joinedSectionIds ?? []).map((id) => item("joined-section", id, `joined-at-${end.endpoint}`, end.endpoint === "start" ? 0 : wholeLength))),
    ].sort((a, b) => byText(a.candidateId, b.candidateId));
  }

  // --- spatial flags: facts about the place, never a verdict ---
  const flags = new Set();
  if (scope === "section") flags.add("whole-section-affected");
  if (scope === "block") flags.add("single-block-affected");
  if (scope === "train") flags.add("train-position-not-in-map");
  if (!location) flags.add("location-unknown");
  if (locationAttach?.onSection === false) flags.add("location-not-on-section");
  if (locationAttach?.withinAffectedExtent === false) flags.add("location-outside-affected-extent");
  if (!ring) flags.add("polygon-not-drawn");
  if (polygonFacts?.coversLocation === false) flags.add("polygon-not-covering-location");
  if (section && !section.alignment) flags.add("external-alignment-unknown");
  if (scope === "section" && section && section.blockIds === null) flags.add("block-data-missing");
  if (!section && scope !== "train") flags.add("no-section-link");
  if (geometry.revision?.state !== "current") flags.add("rail-geometry-not-current");
  if (designReason && (location || ring)) flags.add(designState === "stale" ? "design-revision-stale" : "design-revision-not-recorded");
  if (affectedJunctionResourceIds?.length) flags.add("junction-affected");
  if (affectedSignalCandidateIds?.length) flags.add("signal-candidate-affected");
  if (affectedStationIds?.length) flags.add("station-affected");
  if (affectedTerminalResourceIds?.length) flags.add("terminal-approach-affected");

  // --- aggregate every unknown into one 1:1 list of paths ---
  const all = { ...unknown };
  const collect = (prefix, o) => { for (const f of o?.unknown ?? []) all[`${prefix}:${f}`] = o.unknownReasons[f]; };
  collect("affectedExtent", affectedExtent);
  collect("locationAttach", locationAttach);
  collect("polygonFacts", polygonFacts);
  for (const c of alternativeAccessCandidates ?? []) collect(`alternativeAccessCandidates:${c.candidateId}`, c);
  const unknownPaths = Object.keys(all).sort(byText);
  const license = { pack: ctx.pack.manifest?.data?.license ?? null, attribution: ctx.pack.manifest?.data?.attribution ?? [] };
  const dataQuality = worse(qualityOf(unknownPaths.length), geometry.dataQuality ?? "low");
  const facts = { eventId: event.id, scope, status, effect, railGeometryRevision: geometry.railGeometryRevision, sectionId, blockId, location, alignment, affectedExtent, affectedPolygon: ring, affectedSectionIds, affectedBlockIds, affectedSignalCandidateIds, affectedJunctionResourceIds, affectedStationIds, affectedTerminalResourceIds, locationAttach, polygonFacts, alternativeAccessCandidates };
  return {
    warnings,
    site: {
      schema: RAILWAY_DISRUPTION_SITE_SCHEMA, contractVersion: 1,
      disruptionSiteId: siteId, siteRevision: stableId("railway-disruption-site-revision", siteId, JSON.stringify(facts)),
      sourcePackId: packId, sourcePackVersion: ctx.pack.manifest?.version ?? null,
      eventId: event.id, railGeometryId: geometry.railGeometryId, railGeometryRevision: geometry.railGeometryRevision,
      designedRailGeometryRevision: drawn.designedRailGeometryRevision ?? null,
      lineId: text(event.lineId), trackSegmentId: segmentId, railCapacitySectionId: sectionId, sectionLinkBasis, blockId, trainId,
      kind: event.kind, status, scope, effect,
      location, locationBasis, locationAttach, alignment, affectedExtent, affectedPolygon: ring, polygonFacts,
      affectedSectionIds, affectedBlockIds, affectedSignalCandidateIds, affectedJunctionResourceIds, affectedStationIds, affectedTerminalResourceIds,
      alternativeAccessCandidates,
      spatialFlags: [...flags].sort(byText), dataQuality,
      unknown: unknownPaths, unknownReasons: sortedObject(all),
      warnings, sourceLayers: [{ layer: "rail-capacity-geometry", quality: geometry.dataQuality ?? null, name: `RailCapacityGeometry ${geometry.railGeometryId}`, license: geometry.license?.pack ?? null }], license,
    },
  };
}

// events: transitline.railway-disruption/1 objects; railGeometries: RailCapacityGeometry v1 objects; applications: rail-capacity-application/1.
// A site names its geometry (`railGeometryId`), else the geometry the line's application was made on, else the only one.
// `active: false` marks a site the player switched off: it keeps its id but is not built.
export function buildRailwayDisruptionSiteExport({ pack, events = [], railGeometries = [], applications = [], sites = [] }) {
  const packId = pack.manifest?.id ?? "pack";
  const built = new Map();
  const inactive = [];
  const warnings = [];
  for (const drawn of sites) {
    if (drawn?.active === false) { inactive.push({ eventId: drawn.eventId ?? null, disruptionSiteId: hasKey(drawn.eventId) ? disruptionSiteIdOf(packId, drawn.eventId) : null }); continue; }
    const event = (events ?? []).find((x) => x?.id === drawn?.eventId);
    if (!event) { warnings.push({ code: "railway-disruption-site-rejected", eventId: drawn?.eventId ?? null, reasons: [{ code: "event-missing", eventId: drawn?.eventId ?? null }] }); continue; }
    const wanted = drawn?.railGeometryId ?? applications.find((a) => text(a.operationalLineId) === text(event.lineId))?.railGeometryId ?? (railGeometries.length === 1 ? railGeometries[0].railGeometryId : null);
    const geometry = railGeometries.find((g) => g.railGeometryId === wanted);
    if (!geometry) { warnings.push({ code: "railway-disruption-site-rejected", eventId: drawn?.eventId ?? null, reasons: [{ code: "rail-geometry-missing", railGeometryId: wanted ?? null }] }); continue; }
    const out = buildRailwayDisruptionSite(drawn, { pack, events, railGeometry: geometry, applications });
    if (!out.site) warnings.push({ code: "railway-disruption-site-rejected", eventId: drawn?.eventId ?? null, reasons: out.warnings });
    else if (built.has(out.site.disruptionSiteId)) warnings.push({ code: "duplicate-railway-disruption-site", disruptionSiteId: out.site.disruptionSiteId });
    else built.set(out.site.disruptionSiteId, out.site);
  }
  return {
    schema: RAILWAY_DISRUPTION_SITE_EXPORT_SCHEMA, packId, packVersion: pack.manifest?.version ?? null,
    sites: [...built.values()].sort((a, b) => byText(a.disruptionSiteId, b.disruptionSiteId)),
    inactive: inactive.sort((a, b) => byText(String(a.disruptionSiteId), String(b.disruptionSiteId))), warnings,
  };
}

// A point snapped onto the section's alignment (what the editor stores), or null when the section has no alignment
// or the point is farther than maxMeters from it.
export function snapToSection(railGeometry, sectionId, location, { maxMeters = 50 } = {}) {
  const section = railGeometry?.sections?.find((s) => s.sectionId === sectionId);
  const at = coord(location);
  if (!section?.alignment || !at) return null;
  const frame = frameAt(at);
  const hit = locate([0, 0], section.alignment.map(frame.xy));
  if (hit.d > maxMeters) return null;
  return { location: frame.ll(hit.point).map(round6), distanceMeters: roundTo(hit.d, 1) };
}
