// Railway detour service geometry (see docs/railway-detour-service-contract.md): when the player has chosen a detour
// candidate of a railway service control geometry (see railway-service-control.mjs), the spatial and connection facts a
// management engine needs to judge, contract and settle a service over another company's track — the legs in order
// with the ids that tie them to the map, the plan, the existing line and the operational track, who the source says
// owns each, where one leg meets the next and how that was measured, the stations and their entrances, and the
// connection lines and transfer passages the player drew. Whether a train may run there, technical compatibility,
// capacity, headways, trains, access charges, compensation, revenue, demand, reputation, time, delay and contract
// state belong to the management engine; this module never imports it and never reads or writes its state.
//
// Missing data: a value that cannot be known is `null`, its name is in `unknown[]` and the reason is in `unknownReasons`
// (always 1:1) — never 0, false or []. `false` is a measured "does not meet"; `[]` is a measured or declared "none". An
// existing line has station-level data only, so its track is never reported as joined: that stays `null`.
import { stableId, roundTo } from "./ids.mjs";
import { frameAt, qualityOf, worse } from "./local-geometry.mjs";
import { RAIL_CAPACITY_GEOMETRY_SCHEMA } from "./rail-capacity-geometry.mjs";
import { RAILWAY_DISRUPTION_SITE_SCHEMA } from "./railway-disruption-site.mjs";
import { RAILWAY_SERVICE_CONTROL_SCHEMA } from "./railway-service-control.mjs";
import { THROUGH_ROUTE_SCHEMA } from "./through-route.mjs";
import { EXTERNAL_INFRASTRUCTURE_CATALOG_SCHEMA } from "./external-rail-technical-specification.mjs";
import { networkOf } from "./railway-service-control-candidates.mjs";
import { marks, uniqueSorted, orientPath, legFacts, connectionFacts, stationFacts, transferLinks, playerConnectionsOf, playerTransferPathsOf } from "./railway-detour-service-candidates.mjs";

export const RAILWAY_DETOUR_SERVICE_SCHEMA = "transitline.railway-detour-service-geometry/1";
export const RAILWAY_DETOUR_SERVICE_EXPORT_SCHEMA = "transitline.railway-detour-service-export/1";

// A detour geometry follows its event and the detour the player chose: the same choice on the same pack always has the
// same id, whatever anything is called, in whatever order it was given, in whichever direction a line was drawn.
export const detourGeometryIdOf = (packId, eventId, detourCandidateId) => stableId("railway-detour-service", packId, eventId, detourCandidateId);

const hasKey = (v) => v !== undefined && v !== null && v !== "";
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const text = (v) => (v === undefined || v === null ? null : String(v));
const sortedObject = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => byText(a, b)));

// document: { eventId, detourCandidateId, selectedOnControlGeometryRevision?,
//             connections?:   [{ key?, name?, polyline: [[lon,lat]...] }],      // lines the player drew between stations of the detour
//             transferPaths?: [{ key?, name?, polyline: [[lon,lat]...] }],      // passages the player drew for changing trains
//             active? }
// ctx: { pack, site: RailwayDisruptionSiteGeometry v1, control: RailwayServiceControlGeometry v1, railGeometry?: RailCapacityGeometry v1,
//        application?: rail-capacity-application/1, routes?: [ThroughRouteGeometry v1], externalCatalog?: ExternalInfrastructureCatalog,
//        externalNetworks?: [existing networks], stationSites?: [StationSiteGeometry] }
// -> { detour, warnings }; detour is null when the choice cannot be tied to the site, the control geometry and the rail geometry.
export function buildRailwayDetourService(document, ctx) {
  const packId = ctx.pack.manifest?.id ?? "pack";
  const reject = (code, extra = {}) => ({ detour: null, warnings: [{ code, eventId: document?.eventId ?? null, ...extra }] });
  const { site, control, railGeometry: geometry } = ctx;
  if (!hasKey(document?.eventId)) return reject("event-missing");
  if (!hasKey(document.detourCandidateId)) return reject("detour-candidate-missing");
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
  const candidate = (control.detourCandidates ?? []).find((c) => c.candidateId === document.detourCandidateId);
  if (!candidate) return reject("detour-not-offered", { candidateId: document.detourCandidateId });
  if (geometry !== undefined && geometry !== null) {
    if (geometry.schema !== RAIL_CAPACITY_GEOMETRY_SCHEMA || geometry.contractVersion !== 1) return reject("rail-geometry-schema-invalid", { schema: geometry.schema ?? null });
    if (geometry.sourcePackId !== packId) return reject("rail-geometry-other-pack", { geometryPackId: geometry.sourcePackId ?? null });
    if (geometry.railGeometryId !== control.railGeometryId) return reject("rail-geometry-mismatch", { controlGeometryId: control.railGeometryId ?? null });
    if (geometry.railGeometryRevision !== control.railGeometryRevision) return reject("rail-geometry-revision-mismatch", { controlRevision: control.railGeometryRevision, geometryRevision: geometry.railGeometryRevision });
  }
  const net = geometry ? networkOf(geometry) : null;
  if (net && [...candidate.sectionIds, ...control.affectedSectionIds].some((id) => !net.sections.has(id))) return reject("detour-section-missing", { sectionIds: candidate.sectionIds });
  const path = net ? orientPath({ candidate, net }) : null;
  if (net && !path) return reject("detour-path-inconsistent", { candidateId: candidate.candidateId });

  const warnings = [];
  const unknown = {};
  const mark = (field, reason) => { unknown[field] = reason; };
  const detourId = detourGeometryIdOf(packId, site.eventId, candidate.candidateId);
  const noGeometry = "rail-geometry-not-supplied";

  // --- the inputs that may be absent or old: the application, the through route, the existing-infrastructure catalog ---
  const app = ctx.application ?? null;
  const application = app && app.railGeometryId === control.railGeometryId && app.railGeometryRevision === control.railGeometryRevision ? app : null;
  if (app && !application) warnings.push({ code: "application-stale", applicationRevision: app.railGeometryRevision ?? null, controlRevision: control.railGeometryRevision });
  const found = (ctx.routes ?? []).find((r) => r?.schema === THROUGH_ROUTE_SCHEMA && r.throughRouteId === control.throughRouteId) ?? null;
  const route = found && (!geometry || found.geometryRevision === geometry.routeGeometryRevision) ? found : null;
  if (found && !route) warnings.push({ code: "through-route-stale", throughRouteId: found.throughRouteId });
  if (route && !geometry) warnings.push({ code: "through-route-revision-unchecked", throughRouteId: route.throughRouteId });
  const given = ctx.externalCatalog ?? null;
  const catalog = given?.schema === EXTERNAL_INFRASTRUCTURE_CATALOG_SCHEMA && given.packId === packId ? given : null;
  if (given && !catalog) warnings.push({ code: "catalog-ignored", schema: given.schema ?? null, catalogPackId: given.packId ?? null });

  // --- the legs, in the order the detour runs from the origin boundary station to the destination boundary station ---
  const legCtx = { detourId, application, route, catalog, externalNetworks: ctx.externalNetworks ?? [], geometry, warnings, noApplication: app ? "application-stale" : "no-application" };
  const legs = path ? path.map((item, i) => legFacts({ item, index: i, ctx: legCtx })) : candidate.sectionIds.map((sectionId, i) => {
    const m = marks();
    for (const f of ["sourceKind", "fromStationId", "toStationId", "alignment", "lengthMeters", "trackSegmentId", "trackSegmentIds", "infrastructureOwnerId"]) m.mark(f, noGeometry);
    return { legId: stableId("railway-detour-leg", detourId, sectionId), sequenceIndex: i, basis: "source", sectionId, sourceKind: null, planId: null, segmentId: null, throughLegId: null, trackSegmentId: null, trackSegmentIds: null, externalNetworkId: null, externalLineId: null, externalSpecificationId: null, externalSpecificationRevision: null, fromStationId: null, toStationId: null, alignment: null, lengthMeters: null, infrastructureOwnerId: null, infrastructureOwnerBasis: null, spatialConstraints: null, ...m.done() };
  });
  const startLocation = net?.stations.get(candidate.startStationId) ?? control.turnbackCandidates?.find((t) => t.stationId === candidate.startStationId)?.location ?? null;
  const frame = startLocation ? frameAt(startLocation) : null;
  const connections = candidate.connections.map((joint, i) => connectionFacts({ detourId, candidate, index: i, joint, net, path: path ?? [], route, frame }));
  if (!path) connections.forEach((c) => { c.location = null; c.viaLocations = null; });

  // --- the stations ---
  const ids = path ? [candidate.startStationId, ...path.flatMap((p) => [p.entry, p.exit]), candidate.endStationId] : [candidate.startStationId, ...candidate.viaStationIds, candidate.endStationId];
  const linkStations = new Set(connections.flatMap((c) => c.viaStationIds ?? []));
  const stationRows = [...new Set(ids)].map((stationId) => ({ stationId, role: stationId === candidate.startStationId ? "origin-boundary" : stationId === candidate.endStationId ? "destination-boundary" : "detour-via", handoverEndpoint: linkStations.has(stationId) }));
  const stations = stationFacts({ stations: stationRows, net, control, stationSites: ctx.stationSites ?? [], connections });
  const links = transferLinks({ detourId, connections, stations, frame });

  // --- what the player drew ---
  const playerConnections = playerConnectionsOf({ detourId, document, stations, connections, origin: startLocation, frame, warnings });
  const playerTransferPaths = playerTransferPathsOf({ detourId, document, stations, origin: startLocation, frame, warnings });
  if (playerConnections === null) mark("playerConnections", "no-player-connection-stated");
  if (playerTransferPaths === null) mark("playerTransferPaths", "no-player-transfer-path-stated");
  mark("walkNetwork", "walk-network-not-in-source");

  // --- totals, only from what is known ---
  const owners = legs.map((l) => l.infrastructureOwnerId);
  let infrastructureOwnerIds = null;
  if (owners.some((o) => o === null)) mark("infrastructureOwnerIds", "owner-not-in-source-data");
  else infrastructureOwnerIds = uniqueSorted(owners);
  let lengthMeters = null;
  if (legs.some((l) => l.lengthMeters === null)) mark("lengthMeters", path ? "external-alignment-not-in-source" : noGeometry);
  else lengthMeters = roundTo(legs.reduce((s, l) => s + l.lengthMeters, 0), 1);
  const alignment = candidate.alignment ?? null;
  if (alignment === null) mark("alignment", candidate.unknownReasons?.alignment ?? "external-alignment-not-in-source");
  if (candidate.physicalConnection === null) mark("physicalConnection", candidate.unknownReasons?.physicalConnection ?? "external-topology-not-in-source");
  if (candidate.handoverIds === null) mark("handoverIds", candidate.unknownReasons?.handoverIds ?? "no-through-route");
  const trackIds = legs.map((l) => l.trackSegmentId);

  // --- flags: facts about the place and the data, never a verdict ---
  const flags = new Set();
  if (legs.some((l) => l.sourceKind === "external" || (l.sourceKind === null && candidate.externalLineIds.length))) flags.add("existing-line-leg");
  if (legs.some((l) => l.alignment === null)) flags.add("external-alignment-unknown");
  if (connections.some((c) => c.physicalConnection === null)) flags.add("connection-unmeasured");
  if (connections.some((c) => c.physicalConnection === false)) flags.add("connection-measured-apart");
  if (connections.every((c) => c.physicalConnection === true)) flags.add("all-connections-measured-joined");
  if (connections.some((c) => c.kind === "handover-link")) flags.add("handover-between-different-stations");
  if (owners.some((o) => o === null)) flags.add("infrastructure-owner-unknown");
  if (!route) flags.add("through-route-not-supplied");
  if (legs.some((l) => l.sourceKind === "external" && l.externalSpecificationId === null)) flags.add("existing-line-not-in-catalog");
  if (stations.some((s) => s.entrances === null)) flags.add("entrance-data-missing");
  if (stations.some((s) => s.platformType === null)) flags.add("platform-detail-missing");
  if (playerConnections?.length) flags.add("player-connection-drawn");
  if (playerTransferPaths?.length) flags.add("player-transfer-path-drawn");
  if (playerConnections?.some((c) => c.joinedAtBothEnds === false)) flags.add("player-connection-not-at-stations");
  if (!trackIds.every(Boolean)) flags.add("operational-track-unmapped");
  if (candidate.sectionIds.length >= 6) flags.add("long-detour");

  // --- aggregate every unknown into one 1:1 list of paths ---
  const all = { ...unknown };
  const collect = (prefix, item) => { for (const f of item?.unknown ?? []) all[`${prefix}:${f}`] = item.unknownReasons[f]; };
  for (const l of legs) collect(`leg:${l.legId}`, l);
  for (const c of connections) collect(`connection:${c.connectionId}`, c);
  for (const s of stations) collect(`station:${s.stationId}`, s);
  for (const t of links) collect(`transfer:${t.transferLinkId}`, t);
  for (const p of playerConnections ?? []) { collect(`playerConnection:${p.playerConnectionId}`, p); p.ends.forEach((e, i) => collect(`playerConnection:${p.playerConnectionId}:end:${i}`, e)); }
  for (const p of playerTransferPaths ?? []) p.ends.forEach((e, i) => collect(`playerTransferPath:${p.transferPathId}:end:${i}`, e));
  const unknownPaths = Object.keys(all).sort(byText);
  const license = { pack: ctx.pack.manifest?.data?.license ?? null, attribution: ctx.pack.manifest?.data?.attribution ?? [] };
  const playerDrawn = Boolean(playerConnections?.length || playerTransferPaths?.length);
  const sourceLayers = [
    { layer: "railway-disruption-site-geometry", quality: site.dataQuality ?? null, name: `RailwayDisruptionSiteGeometry ${site.disruptionSiteId}`, license: site.license?.pack ?? null },
    { layer: "railway-service-control-geometry", quality: control.dataQuality ?? null, name: `RailwayServiceControlGeometry ${control.controlGeometryId}`, license: control.license?.pack ?? null },
    ...(geometry ? [{ layer: "rail-capacity-geometry", quality: geometry.dataQuality ?? null, name: `RailCapacityGeometry ${geometry.railGeometryId}`, license: geometry.license?.pack ?? null }] : []),
    ...(route ? [{ layer: "through-route-geometry", quality: route.dataQuality ?? null, name: `ThroughRouteGeometry ${route.throughRouteId}`, license: route.license?.pack ?? null }] : []),
    ...(catalog ? [{ layer: "external-infrastructure-catalog", quality: null, name: "ExternalInfrastructureCatalog (identification only)", license: license.pack }] : []),
    ...(stations.some((s) => s.stationSiteId) ? [{ layer: "station-site-geometry", quality: null, name: "StationSiteGeometry entrance candidates", license: license.pack }] : []),
    ...(playerDrawn ? [{ layer: "player-drawing", quality: null, name: "Connection lines and transfer passages the player drew", license: "player" }] : []),
  ];
  const dataQuality = [control.dataQuality ?? "low", site.dataQuality ?? "low"].reduce((q, v) => worse(q, v), qualityOf(unknownPaths.length));
  const facts = { eventId: site.eventId, siteRevision: site.siteRevision, controlRevision: control.controlGeometryRevision, candidate: candidate.candidateId, legs, connections, stations, links, playerConnections, playerTransferPaths };
  return {
    warnings,
    detour: {
      schema: RAILWAY_DETOUR_SERVICE_SCHEMA, contractVersion: 1,
      detourGeometryId: detourId, detourGeometryRevision: stableId("railway-detour-service-revision", detourId, JSON.stringify(facts)),
      sourcePackId: packId, sourcePackVersion: ctx.pack.manifest?.version ?? null,
      eventId: site.eventId, disruptionSiteId: site.disruptionSiteId, disruptionSiteRevision: site.siteRevision,
      controlGeometryId: control.controlGeometryId, controlGeometryRevision: control.controlGeometryRevision,
      railGeometryId: control.railGeometryId, railGeometryRevision: control.railGeometryRevision, throughRouteId: route?.throughRouteId ?? null, operationalLineId: control.operationalLineId ?? null,
      selectedDetourCandidateId: candidate.candidateId, scope: control.scope,
      originalBoundaryStationIds: [candidate.startStationId, candidate.endStationId], affectedSectionIds: [...control.affectedSectionIds], affectedTrackSegmentIds: control.affectedTrackSegmentIds ?? null, affectedBlockIds: control.affectedBlockIds ?? null,
      externalLineIds: [...candidate.externalLineIds], handoverIds: candidate.handoverIds ?? null, infrastructureOwnerIds, lengthMeters, alignment, physicalConnection: candidate.physicalConnection,
      legs, connections, stations, transferLinks: links, playerConnections, playerTransferPaths, walkNetwork: null,
      spatialFlags: [...flags].sort(byText), dataQuality, unknown: unknownPaths, unknownReasons: sortedObject(all),
      warnings, sourceLayers, license,
    },
  };
}

// documents: the player's detour plans, one per event and chosen detour (`active: false` switches one off without deleting it).
// sites / controls: M6 and M7 objects; railGeometries: RailCapacityGeometry v1 objects; applications: rail-capacity-application/1.
export function buildRailwayDetourServiceExport({ pack, sites = [], controls = [], railGeometries = [], applications = [], routes = [], externalCatalog = null, externalNetworks = [], stationSites = [], documents = [] }) {
  const packId = pack.manifest?.id ?? "pack";
  const built = new Map();
  const inactive = [];
  const warnings = [];
  const rejectedAs = (document, reasons) => warnings.push({ code: "railway-detour-service-rejected", eventId: document?.eventId ?? null, detourCandidateId: document?.detourCandidateId ?? null, reasons });
  for (const document of documents) {
    if (document?.active === false) { inactive.push({ eventId: document.eventId ?? null, detourCandidateId: document.detourCandidateId ?? null, detourGeometryId: hasKey(document.eventId) && hasKey(document.detourCandidateId) ? detourGeometryIdOf(packId, document.eventId, document.detourCandidateId) : null }); continue; }
    const site = sites.find((s) => s?.eventId === document?.eventId);
    if (!site) { rejectedAs(document, [{ code: "site-missing" }]); continue; }
    const control = controls.find((c) => c?.eventId === document.eventId);
    if (!control) { rejectedAs(document, [{ code: "control-missing" }]); continue; }
    const railGeometry = railGeometries.find((g) => g.railGeometryId === control.railGeometryId) ?? null;
    const application = applications.find((a) => a?.railGeometryId === control.railGeometryId && text(a.operationalLineId) === text(control.operationalLineId)) ?? null;
    const out = buildRailwayDetourService(document, { pack, site, control, railGeometry, application, routes, externalCatalog, externalNetworks, stationSites });
    if (!out.detour) rejectedAs(document, out.warnings);
    else {
      // one id, two documents: the one with the smaller revision is kept (never the first in the array)
      const kept = built.get(out.detour.detourGeometryId);
      if (kept) warnings.push({ code: "duplicate-railway-detour-service", detourGeometryId: out.detour.detourGeometryId });
      if (!kept || out.detour.detourGeometryRevision < kept.detourGeometryRevision) built.set(out.detour.detourGeometryId, out.detour);
    }
  }
  return {
    schema: RAILWAY_DETOUR_SERVICE_EXPORT_SCHEMA, packId, packVersion: pack.manifest?.version ?? null,
    detours: [...built.values()].sort((a, b) => byText(a.detourGeometryId, b.detourGeometryId)),
    inactive: inactive.sort((a, b) => byText(String(a.detourGeometryId), String(b.detourGeometryId))), warnings,
  };
}
