// Rail replacement transport geometry (see docs/rail-replacement-transport-contract.md): when the player has chosen to
// suspend a range of railway sections (a railway service control partial suspension candidate), the spatial facts a
// replacement bus or other road service would be planned from — the stations of the range in rail order, their
// entrances and roadside stops, the routes, stops and turning places the player drew and how each meets the roads and
// the stations, and what separates the two ends. Cost, running time, fleet, capacity, demand, score, ranking,
// contracts, cash, reputation and whether any service can actually run belong to the management engine; this module
// never imports it and never reads or writes its state.
//
// The road layer is a bag of lines, not a connected graph: no bus route is searched or derived from it, and a straight
// line is never presented as a road. A route is here only because the player drew it (`basis: "player"`).
//
// Missing data: a value that cannot be known is `null`, its name is in `unknown[]` and the reason is in `unknownReasons`
// (always 1:1) — never 0, false or []. `false` is a measured "does not meet"; `[]` is a measured or declared "none".
import { stableId, round6, roundTo } from "./ids.mjs";
import { frameAt, qualityOf, worse } from "./local-geometry.mjs";
import { RAIL_CAPACITY_GEOMETRY_SCHEMA } from "./rail-capacity-geometry.mjs";
import { RAILWAY_DISRUPTION_SITE_SCHEMA } from "./railway-disruption-site.mjs";
import { RAILWAY_SERVICE_CONTROL_SCHEMA } from "./railway-service-control.mjs";
import { networkOf, reach } from "./railway-service-control-candidates.mjs";
import { roadTools, railRange, stationFacts, playerStopsOf, constraintsOf, routesOf, turnaroundAreasOf, marks, uniqueSorted } from "./rail-replacement-transport-candidates.mjs";

export const RAIL_REPLACEMENT_TRANSPORT_SCHEMA = "transitline.rail-replacement-transport-geometry/1";
export const RAIL_REPLACEMENT_TRANSPORT_EXPORT_SCHEMA = "transitline.rail-replacement-transport-export/1";

// A replacement geometry follows its event and the suspension the player chose: the same choice on the same pack always
// has the same id, whatever anything is called, in whatever order it was given, in whichever direction it was drawn.
export const replacementGeometryIdOf = (packId, eventId, partialSuspensionCandidateId) => stableId("rail-replacement-transport", packId, eventId, partialSuspensionCandidateId);

const hasKey = (v) => v !== undefined && v !== null && v !== "";
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const text = (v) => (v === undefined || v === null ? null : String(v));
const sortedObject = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => byText(a, b)));

// document: { eventId, partialSuspensionCandidateId, turnbackCandidateIds?, selectedOnControlGeometryRevision?,
//             routes?: [{ key?, name?, polyline: [[lon,lat]...], roadWidthMeters? }],
//             temporaryStops?: [{ key?, stationId, location, name?, roadWidthMeters? }],
//             turnaroundAreas?: [{ key?, kind?: "turnaround"|"waiting"|"boarding", location?, polygon?, name? }],
//             constraints?: [{ key?, kind, location, value?, unit?, basis? }], vehicleWidthMeters?, active? }
// ctx: { pack, site: RailwayDisruptionSiteGeometry v1, control: RailwayServiceControlGeometry v1, railGeometry?: RailCapacityGeometry v1,
//        application?: rail-capacity-application/1, stationSites?: [StationSiteGeometry], spatial?: spatial context }
// -> { replacement, warnings }; replacement is null when the choice cannot be tied to the site and the control geometry.
export function buildRailReplacementTransport(document, ctx) {
  const packId = ctx.pack.manifest?.id ?? "pack";
  const reject = (code, extra = {}) => ({ replacement: null, warnings: [{ code, eventId: document?.eventId ?? null, ...extra }] });
  const { site, control, railGeometry: geometry } = ctx;
  if (!hasKey(document?.eventId)) return reject("event-missing");
  if (!hasKey(document.partialSuspensionCandidateId)) return reject("partial-suspension-missing");
  if (site?.schema !== RAILWAY_DISRUPTION_SITE_SCHEMA || site.contractVersion !== 1) return reject("site-schema-invalid", { schema: site?.schema ?? null });
  if (control?.schema !== RAILWAY_SERVICE_CONTROL_SCHEMA || control.contractVersion !== 1) return reject("control-schema-invalid", { schema: control?.schema ?? null });
  if (site.sourcePackId !== packId) return reject("site-other-pack", { sitePackId: site.sourcePackId ?? null });
  if (control.sourcePackId !== packId) return reject("control-other-pack", { controlPackId: control.sourcePackId ?? null });
  if (site.eventId !== document.eventId) return reject("document-event-mismatch", { siteEventId: site.eventId ?? null });
  if (control.eventId !== site.eventId || control.disruptionSiteId !== site.disruptionSiteId) return reject("control-site-mismatch", { controlSiteId: control.disruptionSiteId ?? null });
  // the control geometry and the choice are only meaningful on the revisions they were made on
  if (control.disruptionSiteRevision !== site.siteRevision) return reject("control-site-revision-mismatch", { controlSiteRevision: control.disruptionSiteRevision ?? null, siteRevision: site.siteRevision ?? null });
  if (control.railGeometryRevision !== site.railGeometryRevision) return reject("control-rail-geometry-revision-mismatch", { controlRevision: control.railGeometryRevision ?? null, siteRevision: site.railGeometryRevision ?? null });
  if (hasKey(document.selectedOnControlGeometryRevision) && document.selectedOnControlGeometryRevision !== control.controlGeometryRevision) return reject("selection-revision-mismatch", { selectedOn: document.selectedOnControlGeometryRevision, current: control.controlGeometryRevision });
  const candidate = (control.partialSuspensionCandidates ?? []).find((c) => c.candidateId === document.partialSuspensionCandidateId);
  if (!candidate) return reject("partial-suspension-not-offered", { candidateId: document.partialSuspensionCandidateId });
  const turnbackIds = uniqueSorted(document.turnbackCandidateIds ?? []);
  const missingTurnback = turnbackIds.find((id) => !(control.turnbackCandidates ?? []).some((c) => c.candidateId === id));
  if (missingTurnback) return reject("turnback-not-offered", { candidateId: missingTurnback });
  if (geometry !== undefined && geometry !== null) {
    if (geometry.schema !== RAIL_CAPACITY_GEOMETRY_SCHEMA || geometry.contractVersion !== 1) return reject("rail-geometry-schema-invalid", { schema: geometry.schema ?? null });
    if (geometry.sourcePackId !== packId) return reject("rail-geometry-other-pack", { geometryPackId: geometry.sourcePackId ?? null });
    if (geometry.railGeometryId !== control.railGeometryId) return reject("rail-geometry-mismatch", { controlGeometryId: control.railGeometryId ?? null });
    if (geometry.railGeometryRevision !== control.railGeometryRevision) return reject("rail-geometry-revision-mismatch", { controlRevision: control.railGeometryRevision, geometryRevision: geometry.railGeometryRevision });
  }
  const net = geometry ? networkOf(geometry) : null;
  if (net && candidate.suspendedSectionIds.some((id) => !net.sections.has(id))) return reject("suspended-section-missing", { suspendedSectionIds: candidate.suspendedSectionIds });

  const warnings = [];
  const unknown = {};
  const mark = (field, reason) => { unknown[field] = reason; };
  const replId = replacementGeometryIdOf(packId, site.eventId, candidate.candidateId);
  const noGeometry = "rail-geometry-not-supplied";

  // --- the stations of the range, in rail order, from the start station to the end station ---
  const range = net ? railRange({ net, candidate }) : null;
  const locationOf = (id) => (net ? net.stations.get(id) : id === candidate.startStationId ? candidate.geometry.boundaryLocations[0] : candidate.geometry.boundaryLocations[1]);
  const sequence = range ? range.sequence : [candidate.startStationId, candidate.endStationId];
  if (!net) { mark("stationSequence", noGeometry); mark("railSections", noGeometry); mark("railLengthMeters", noGeometry); mark("boundaryStationsConnectedByRetainedRail", noGeometry); }
  else if (!range) { mark("stationSequence", "suspended-range-not-a-path"); mark("railSections", "suspended-range-not-a-path"); mark("railLengthMeters", "suspended-range-not-a-path"); }
  const frame = frameAt(locationOf(candidate.startStationId));
  const roads = roadTools(ctx.spatial, frame);
  const vehicleWidth = Number.isFinite(document.vehicleWidthMeters) && document.vehicleWidthMeters > 0 ? roundTo(document.vehicleWidthMeters, 1) : null;
  if (vehicleWidth === null) mark("vehicleWidthMeters", "vehicle-width-not-stated");
  const externalOf = (id) => (net ? (net.incident.get(id) ?? []).every((sid) => net.sections.get(sid).sourceKind === "external") : null);
  const stationList = sequence.map((stationId, index) => ({
    stationId, index, role: index === 0 ? "start-boundary" : index === sequence.length - 1 ? "end-boundary" : "interior", location: locationOf(stationId),
    external: externalOf(stationId), isolated: candidate.isolatedStationIds.includes(stationId),
    turnbackCandidateId: (control.turnbackCandidates ?? []).find((c) => c.stationId === stationId)?.candidateId ?? null, turnbackSelected: turnbackIds.includes((control.turnbackCandidates ?? []).find((c) => c.stationId === stationId)?.candidateId ?? ""),
  }));
  const start = stationList[0];
  const end = stationList.at(-1);

  // --- what the player stated, measured; the road layer decides nothing it does not carry ---
  const stationIds = stationList.map((s) => s.stationId);
  const playerStops = playerStopsOf({ replId, document, stationIds, roads, vehicleWidth, warnings });
  const built = stationList.map((s) => stationFacts({ replId, s, stationSites: ctx.stationSites ?? [], roads, playerStops }));
  const stops = [...built.flatMap((b) => b.derivedStops), ...(playerStops ?? [])].sort((a, b) => byText(a.stopCandidateId, b.stopCandidateId));
  const stations = built.map((b) => b.station);
  const constraints = constraintsOf({ replId, document, warnings });
  const routes = routesOf({ replId, document, frame, roads, spatial: ctx.spatial ?? null, stations: stationList, startStation: start, endStation: end, stops, constraints, vehicleWidth, warnings });
  const turnaround = turnaroundAreasOf({ replId, document, frame, roads, spatial: ctx.spatial ?? null, stations: stationList, routes, warnings });
  let stopCandidates = stops;
  if (!stops.length && stations.every((s) => s.derivedStopCandidateIds === null) && playerStops === null) { stopCandidates = null; mark("stopCandidates", "no-stop-candidate-data"); }
  if (routes === null) mark("routeCandidates", "no-route-stated");
  mark("derivedRouteCandidates", "road-graph-not-in-source");
  if (constraints === null) mark("spatialConstraints", "no-constraint-data");
  if (turnaround === null) mark("turnaroundAreas", "no-turnaround-area-stated");
  mark("walkNetwork", "walk-network-not-in-source");

  // --- the rail sections between them, and whether the retained rail still joins the two ends ---
  let railSections = null;
  let railLengthMeters = null;
  if (range) {
    railSections = range.sections.map(({ section, from, to }) => {
      const m = marks();
      const forward = section.fromStationId === from;
      if (!section.alignment) { m.mark("alignment", "external-alignment-not-in-source"); m.mark("lengthMeters", "external-alignment-not-in-source"); }
      return { sectionId: section.sectionId, fromStationId: from, toStationId: to, sourceKind: section.sourceKind, lengthMeters: section.lengthMeters ?? null, alignment: section.alignment ? (forward ? section.alignment : [...section.alignment].reverse()) : null, blockIds: section.blockIds ?? null, ...m.done() };
    });
    if (railSections.every((s) => s.lengthMeters !== null)) railLengthMeters = roundTo(railSections.reduce((a, s) => a + s.lengthMeters, 0), 1);
    else mark("railLengthMeters", "external-alignment-not-in-source");
  }
  let connected = null;
  if (net) connected = reach(net, new Set(candidate.suspendedSectionIds), [candidate.startStationId]).has(candidate.endStationId);
  const boundaryConnections = [["start", start], ["end", end]].map(([side, st]) => {
    const m = marks();
    const retained = net ? (net.incident.get(st.stationId) ?? []).filter((sid) => !candidate.suspendedSectionIds.includes(sid)).sort(byText) : null;
    if (retained === null) m.mark("retainedSectionIds", noGeometry);
    const reaching = routes === null ? null : routes.filter((r) => (side === "start" ? r.reachesStartStation : r.reachesEndStation)).map((r) => r.routeId).sort(byText);
    if (reaching === null) m.mark("routeIdsReaching", "no-route-stated");
    const facts = stations.find((s) => s.stationId === st.stationId);
    return { stationId: st.stationId, side, retainedSectionIds: retained, turnbackCandidateId: st.turnbackCandidateId, turnbackSelected: st.turnbackSelected, routeIdsReaching: reaching, stopCandidateIds: [...(facts.derivedStopCandidateIds ?? []), ...(facts.playerStopCandidateIds ?? [])].sort(byText), ...m.done() };
  });

  // --- the operational track segments of the suspended sections, only through an application made on this geometry ---
  const app = ctx.application ?? null;
  const appUsable = app && geometry && app.railGeometryId === geometry.railGeometryId && app.railGeometryRevision === geometry.railGeometryRevision;
  if (app && !appUsable) warnings.push({ code: "application-stale", applicationRevision: app.railGeometryRevision ?? null, controlRevision: control.railGeometryRevision });
  let suspendedTrackSegmentIds = null;
  if (!appUsable) mark("suspendedTrackSegmentIds", app ? "application-stale" : "no-application");
  else {
    const rows = candidate.suspendedSectionIds.map((sid) => (app.sections ?? []).filter((s) => s.railCapacitySectionId === sid).map((s) => text(s.trackSegmentId)));
    if (rows.some((r) => !r.length)) mark("suspendedTrackSegmentIds", "section-not-in-application");
    else suspendedTrackSegmentIds = uniqueSorted(rows.flat());
  }

  // --- flags: facts about the place, never a verdict ---
  const flags = new Set(["no-road-graph"]);
  if (!roads.present) flags.add("road-layer-missing");
  if (stations.some((s) => s.entrances === null)) flags.add("entrance-data-missing");
  if (stations.some((s) => s.external === true)) flags.add("external-station-detail-missing");
  if (stations.some((s) => s.isolated)) flags.add("stations-left-without-rail");
  if (connected === true) flags.add("boundary-stations-joined-by-retained-rail");
  if (connected === false) flags.add("boundary-stations-separated");
  if (routes?.length) flags.add("player-route-drawn");
  if (routes?.some((r) => r.alongRoad?.fullyOnRoad === false)) flags.add("player-route-off-road");
  if (routes?.some((r) => r.alongRoad !== null && r.alongRoad.fullyOnRoad === null)) flags.add("player-route-road-contact-unmeasured");
  if (routes?.some((r) => r.orderMatchesRail === false)) flags.add("route-order-differs-from-rail");
  if (turnaround === null) flags.add("turnaround-not-stated");
  if (turnbackIds.some((id) => (control.turnbackCandidates ?? []).find((c) => c.candidateId === id).stationId !== candidate.startStationId && (control.turnbackCandidates ?? []).find((c) => c.candidateId === id).stationId !== candidate.endStationId)) flags.add("selected-turnback-not-at-boundary");

  // --- aggregate every unknown into one 1:1 list of paths ---
  const all = { ...unknown };
  const collect = (prefix, item) => { for (const f of item?.unknown ?? []) all[`${prefix}:${f}`] = item.unknownReasons[f]; };
  for (const s of stations) { collect(`station:${s.stationId}`, s); for (const e of s.entrances ?? []) collect(`station:${s.stationId}:entrance:${e.entranceId}`, e); }
  for (const s of stops) collect(`stop:${s.stopCandidateId}`, s);
  for (const r of routes ?? []) { collect(`route:${r.routeId}`, r); collect(`route:${r.routeId}:alongRoad`, r.alongRoad); collect(`route:${r.routeId}:start`, r.roadAttachment?.start); collect(`route:${r.routeId}:end`, r.roadAttachment?.end); }
  for (const a of turnaround ?? []) collect(`turnaround:${a.turnaroundAreaId}`, a);
  for (const c of constraints ?? []) collect(`constraint:${c.constraintId}`, c);
  for (const s of railSections ?? []) collect(`railSection:${s.sectionId}`, s);
  for (const b of boundaryConnections) collect(`boundary:${b.side}`, b);
  const unknownPaths = Object.keys(all).sort(byText);
  const license = { pack: ctx.pack.manifest?.data?.license ?? null, attribution: ctx.pack.manifest?.data?.attribution ?? [] };
  const playerDrawn = Boolean(routes?.length || playerStops?.length || turnaround?.length || constraints?.length);
  const sourceLayers = [
    { layer: "railway-disruption-site-geometry", quality: site.dataQuality ?? null, name: `RailwayDisruptionSiteGeometry ${site.disruptionSiteId}`, license: site.license?.pack ?? null },
    { layer: "railway-service-control-geometry", quality: control.dataQuality ?? null, name: `RailwayServiceControlGeometry ${control.controlGeometryId}`, license: control.license?.pack ?? null },
    ...(geometry ? [{ layer: "rail-capacity-geometry", quality: geometry.dataQuality ?? null, name: `RailCapacityGeometry ${geometry.railGeometryId}`, license: geometry.license?.pack ?? null }] : []),
    ...(stations.some((s) => s.stationSiteId) ? [{ layer: "station-site-geometry", quality: null, name: "StationSiteGeometry entrance candidates", license: license.pack }] : []),
    ...(roads.present && roads.layer.source ? [{ layer: "roads", quality: roads.layer.quality ?? null, ...roads.layer.source }] : []),
    ...(playerDrawn ? [{ layer: "player-drawing", quality: null, name: "Routes, stops, turning places and constraints the player stated", license: "player" }] : []),
  ];
  const dataQuality = [control.dataQuality ?? "low", site.dataQuality ?? "low", ...(roads.layer?.quality ? [roads.layer.quality] : [])].reduce((q, v) => worse(q, v), qualityOf(unknownPaths.length));
  const facts = { eventId: site.eventId, siteRevision: site.siteRevision, controlRevision: control.controlGeometryRevision, candidate: candidate.candidateId, turnbackIds, stations, stopCandidates, routes, turnaround, constraints, railSections, connected, vehicleWidth };
  return {
    warnings,
    replacement: {
      schema: RAIL_REPLACEMENT_TRANSPORT_SCHEMA, contractVersion: 1,
      replacementGeometryId: replId, replacementGeometryRevision: stableId("rail-replacement-transport-revision", replId, JSON.stringify(facts)),
      sourcePackId: packId, sourcePackVersion: ctx.pack.manifest?.version ?? null,
      eventId: site.eventId, disruptionSiteId: site.disruptionSiteId, disruptionSiteRevision: site.siteRevision,
      controlGeometryId: control.controlGeometryId, controlGeometryRevision: control.controlGeometryRevision,
      railGeometryId: control.railGeometryId, railGeometryRevision: control.railGeometryRevision, operationalLineId: control.operationalLineId ?? null,
      partialSuspensionCandidateId: candidate.candidateId, selectedTurnbackCandidateIds: turnbackIds,
      startStationId: candidate.startStationId, endStationId: candidate.endStationId,
      suspendedSectionIds: [...candidate.suspendedSectionIds], suspendedTrackSegmentIds, suspendedBlockIds: candidate.suspendedBlockIds ?? null, retainedSectionIds: [...candidate.retainedSectionIds],
      stationSequence: range ? range.sequence : null, railSections, railLengthMeters, boundaryStationsConnectedByRetainedRail: connected, boundaryConnections,
      stations, stopCandidates, routeCandidates: routes, derivedRouteCandidates: null, turnaroundAreas: turnaround, spatialConstraints: constraints, walkNetwork: null, vehicleWidthMeters: vehicleWidth,
      spatialFlags: [...flags].sort(byText), dataQuality, unknown: unknownPaths, unknownReasons: sortedObject(all),
      warnings, sourceLayers, license,
    },
  };
}

// documents: the player's replacement plans, one per event and chosen suspension (`active: false` switches one off without deleting it).
// sites / controls: M6 and M7 objects; railGeometries: RailCapacityGeometry v1 objects; applications: rail-capacity-application/1.
export function buildRailReplacementTransportExport({ pack, sites = [], controls = [], railGeometries = [], applications = [], stationSites = [], spatial = null, documents = [] }) {
  const packId = pack.manifest?.id ?? "pack";
  const built = new Map();
  const inactive = [];
  const warnings = [];
  const rejectedAs = (document, reasons) => warnings.push({ code: "rail-replacement-transport-rejected", eventId: document?.eventId ?? null, partialSuspensionCandidateId: document?.partialSuspensionCandidateId ?? null, reasons });
  for (const document of documents) {
    if (document?.active === false) { inactive.push({ eventId: document.eventId ?? null, partialSuspensionCandidateId: document.partialSuspensionCandidateId ?? null, replacementGeometryId: hasKey(document.eventId) && hasKey(document.partialSuspensionCandidateId) ? replacementGeometryIdOf(packId, document.eventId, document.partialSuspensionCandidateId) : null }); continue; }
    const site = sites.find((s) => s?.eventId === document?.eventId);
    if (!site) { rejectedAs(document, [{ code: "site-missing" }]); continue; }
    const control = controls.find((c) => c?.eventId === document.eventId);
    if (!control) { rejectedAs(document, [{ code: "control-missing" }]); continue; }
    const railGeometry = railGeometries.find((g) => g.railGeometryId === control.railGeometryId) ?? null;
    const application = applications.find((a) => a?.railGeometryId === control.railGeometryId && text(a.operationalLineId) === text(control.operationalLineId)) ?? null;
    const out = buildRailReplacementTransport(document, { pack, site, control, railGeometry, application, stationSites, spatial });
    if (!out.replacement) rejectedAs(document, out.warnings);
    else if (built.has(out.replacement.replacementGeometryId)) warnings.push({ code: "duplicate-rail-replacement-transport", replacementGeometryId: out.replacement.replacementGeometryId });
    else built.set(out.replacement.replacementGeometryId, out.replacement);
  }
  return {
    schema: RAIL_REPLACEMENT_TRANSPORT_EXPORT_SCHEMA, packId, packVersion: pack.manifest?.version ?? null,
    replacements: [...built.values()].sort((a, b) => byText(a.replacementGeometryId, b.replacementGeometryId)),
    inactive: inactive.sort((a, b) => byText(String(a.replacementGeometryId), String(b.replacementGeometryId))), warnings,
  };
}
