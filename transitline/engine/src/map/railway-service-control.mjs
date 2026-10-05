// Railway service control geometry (see docs/railway-service-control-contract.md): after a disruption, the places the
// player could choose to turn trains back, the station pairs service could be suspended between, the other tracks that
// join the two ends of the affected section and the places people could leave the track — as pure spatial facts about a
// railway disruption site and the rail capacity geometry it sits on. Which candidate is better, whether trains can run,
// what it costs, how long recovery takes, who is compensated and any executed control order belong to the management
// engine; this module never imports it and never reads or writes its state.
//
// Missing data: a value that cannot be known is `null`, its name is in `unknown[]` and the reason is in `unknownReasons`
// (always 1:1) — never 0, false or []. `[]` is a measured or declared "none".
import { stableId } from "./ids.mjs";
import { qualityOf, worse } from "./local-geometry.mjs";
import { RAIL_CAPACITY_GEOMETRY_SCHEMA } from "./rail-capacity-geometry.mjs";
import { RAILWAY_DISRUPTION_SITE_SCHEMA } from "./railway-disruption-site.mjs";
import { THROUGH_ROUTE_SCHEMA } from "./through-route.mjs";
import { networkOf, reach, turnbackCandidates, partialSuspensionCandidates, detourCandidates, evacuationCandidates, MAX_SUSPENSION_EXTENSION_SECTIONS, MAX_DETOUR_SECTIONS } from "./railway-service-control-candidates.mjs";

export const RAILWAY_SERVICE_CONTROL_SCHEMA = "transitline.railway-service-control-geometry/1";
export const RAILWAY_SERVICE_CONTROL_EXPORT_SCHEMA = "transitline.railway-service-control-export/1";
export { MAX_SUSPENSION_EXTENSION_SECTIONS, MAX_DETOUR_SECTIONS };

// A control geometry follows its event: the same event on the same pack always has the same id.
export const controlGeometryIdOf = (packId, eventId) => stableId("railway-service-control", packId, eventId);

const hasKey = (v) => v !== undefined && v !== null && v !== "";
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const text = (v) => (v === undefined || v === null ? null : String(v));
const sortedObject = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => byText(a, b)));
const uniqueSorted = (list) => [...new Set(list)].sort(byText);

// document: { eventId, accessPoints?: [{ key?, kind: "entrance"|"road-access", location, stationId?, roadWidthMeters?, basis: "player"|"source", name? }],
//             emergencyVehicleWidthMeters? }  — what the player stated about the event's control candidates
// ctx:      { pack, site: RailwayDisruptionSiteGeometry v1, railGeometry: RailCapacityGeometry v1, application?: rail-capacity-application/1,
//             routes?: [ThroughRouteGeometry v1], externalNetworks?: [...], stationSites?: [StationSiteGeometry], spatial?: spatial context }
// -> { control, warnings }; control is null when the site and the geometry cannot be tied together.
export function buildRailwayServiceControl(document, ctx) {
  const packId = ctx.pack.manifest?.id ?? "pack";
  const reject = (code, extra = {}) => ({ control: null, warnings: [{ code, eventId: document?.eventId ?? null, ...extra }] });
  const site = ctx.site;
  const geometry = ctx.railGeometry;
  if (!hasKey(document?.eventId)) return reject("event-missing");
  if (site?.schema !== RAILWAY_DISRUPTION_SITE_SCHEMA || site.contractVersion !== 1) return reject("site-schema-invalid", { schema: site?.schema ?? null });
  if (site.sourcePackId !== packId) return reject("site-other-pack", { sitePackId: site.sourcePackId ?? null });
  if (site.eventId !== document.eventId) return reject("document-event-mismatch", { siteEventId: site.eventId ?? null });
  if (geometry?.schema !== RAIL_CAPACITY_GEOMETRY_SCHEMA || geometry.contractVersion !== 1) return reject("rail-geometry-schema-invalid", { schema: geometry?.schema ?? null });
  if (geometry.sourcePackId !== packId) return reject("rail-geometry-other-pack", { geometryPackId: geometry.sourcePackId ?? null });
  if (site.railGeometryId !== geometry.railGeometryId) return reject("site-geometry-mismatch", { siteGeometryId: site.railGeometryId ?? null });
  // the site's ids are only meaningful on the geometry revision it was built on
  if (site.railGeometryRevision !== geometry.railGeometryRevision) return reject("site-geometry-revision-mismatch", { siteRevision: site.railGeometryRevision ?? null, geometryRevision: geometry.railGeometryRevision });

  const warnings = [];
  const unknown = {};
  const mark = (field, reason) => { unknown[field] = reason; };
  const net = networkOf(geometry);
  const controlId = controlGeometryIdOf(packId, site.eventId);
  // two sections of the geometry with one id (a line that runs between the same two stations twice) cannot both be told apart here
  const duplicateSectionIds = uniqueSorted(geometry.sections.map((s) => s.sectionId).filter((id, i, all) => all.indexOf(id) !== i));
  if (duplicateSectionIds.length) warnings.push({ code: "duplicate-section-id", sectionIds: duplicateSectionIds });
  const affectedSectionIds = site.affectedSectionIds === null || site.affectedSectionIds === undefined ? null : [...site.affectedSectionIds].sort(byText);
  if (affectedSectionIds?.some((id) => !net.sections.has(id))) return reject("affected-section-missing", { affectedSectionIds });
  if ((affectedSectionIds?.length ?? 0) > 1) return reject("several-affected-sections", { affectedSectionIds });
  const noSection = site.unknownReasons?.affectedSectionIds ?? (site.scope === "train" ? "train-position-not-in-map" : "no-section-link");

  // --- which operational tracks these are: through the application (map section -> track segment), else only what the event itself names ---
  const app = ctx.application ?? null;
  const appUsable = app && app.railGeometryId === geometry.railGeometryId && app.railGeometryRevision === geometry.railGeometryRevision;
  if (app && !appUsable) warnings.push({ code: "application-stale", eventId: site.eventId, applicationRevision: app.railGeometryRevision ?? null, geometryRevision: geometry.railGeometryRevision });
  if (appUsable && text(app.operationalLineId) !== text(site.lineId)) warnings.push({ code: "application-other-line", eventId: site.eventId, applicationLineId: text(app.operationalLineId), siteLineId: text(site.lineId) });
  let affectedTrackSegmentIds = null;
  if (affectedSectionIds === null) mark("affectedTrackSegmentIds", noSection);
  else affectedTrackSegmentIds = uniqueSorted([text(site.trackSegmentId), ...(appUsable ? (app.sections ?? []).filter((s) => affectedSectionIds.includes(s.railCapacitySectionId)).map((s) => text(s.trackSegmentId)) : [])].filter(Boolean));
  if (!hasKey(site.lineId)) mark("operationalLineId", "event-line-not-stated");

  // --- the through route, only when it is the one the geometry was made with ---
  const route = (ctx.routes ?? []).find((r) => r?.schema === THROUGH_ROUTE_SCHEMA && r.throughRouteId === geometry.throughRouteId) ?? null;
  const routeCurrent = route !== null && route.geometryRevision === geometry.routeGeometryRevision ? route : null;
  if (route && !routeCurrent) warnings.push({ code: "through-route-stale", throughRouteId: route.throughRouteId });
  const lineOwner = (s) => {
    for (const network of ctx.externalNetworks ?? []) {
      const line = network.lines.find((l) => l.id === s.externalLineId);
      if (line) return text(line.infrastructureOwnerId) ?? text(network.infrastructureOwnerId);
    }
    return null;
  };
  const ownerOf = (s) => {
    const leg = routeCurrent?.legs.find((l) => (s.sourceKind === "plan" ? (l.segmentIds ?? []).includes(s.segmentId) : l.externalLineId === s.externalLineId));
    return text(leg?.infrastructureOwnerId) ?? (s.sourceKind === "external" ? lineOwner(s) : null);
  };

  // --- the candidate lists ---
  let turnbacks = null;
  let suspensions = null;
  let detours = null;
  let evacuation = null;
  const flags = new Set();
  if (site.scope === "section") flags.add("whole-section-affected");
  if (site.scope === "block") flags.add("single-block-affected");
  if (site.scope === "train") flags.add("train-position-not-in-map");
  if (site.location === null) flags.add("location-unknown");
  if (affectedSectionIds === null) for (const f of ["affectedSectionIds", "affectedBlockIds", "turnbackCandidates", "partialSuspensionCandidates", "detourCandidates", "evacuationAccessCandidates"]) mark(f, noSection);
  else {
    const affected = new Set(affectedSectionIds);
    const [affectedId] = affectedSectionIds;
    const ends = [net.sections.get(affectedId).fromStationId, net.sections.get(affectedId).toStationId];
    turnbacks = turnbackCandidates({ controlId, net, geometry, affected, hops: reach(net, affected, ends) });
    const sus = partialSuspensionCandidates({ controlId, net, geometry, affectedId });
    suspensions = sus.list;
    if (sus.truncated) flags.add("partial-suspension-enumeration-limited");
    const det = detourCandidates({ controlId, net, geometry, affectedId, route: routeCurrent, ownerOf });
    detours = det.list;
    if (det.truncated) flags.add("detour-enumeration-limited");
    if (!detours.length) flags.add("no-detour-in-geometry");
    const roads = ctx.spatial?.layers?.roads ?? null;
    evacuation = evacuationCandidates({
      controlId, net, adjacentStationIds: ends, reference: { location: site.location ?? null, alignment: site.alignment ?? null }, document, stationSites: ctx.stationSites ?? [], roads,
      noReference: site.scope === "train" ? "train-position-not-in-map" : "disruption-position-not-in-source",
    });
    if (!roads) flags.add("road-data-missing");
    if (!(ctx.stationSites ?? []).some((x) => ends.includes(x.connectedStationId))) flags.add("entrance-data-missing");
    if (geometry.terminals === null) flags.add("terminal-data-missing");
    if (turnbacks.some((t) => t.physicalAttachment === true)) flags.add("turnback-attachment-confirmed");
    if (turnbacks.every((t) => t.terminalResourceId === null)) flags.add("no-turnback-facility-stated");
    if (turnbacks.some((t) => t.facilityAttachments?.some((f) => f.attached === false))) flags.add("turnback-not-attached");
    if (!routeCurrent) flags.add("through-route-not-supplied");
    if (net.sections.get(affectedId).sourceKind === "external") flags.add("external-alignment-unknown");
    // what the player stated about the affected section's track count (nothing is guessed from the rest of the line)
    const mode = net.sections.get(affectedId).directionMode;
    flags.add(mode === "single" ? "single-track-section-affected" : mode === "double" ? "double-track-section-affected" : "track-count-unknown");
  }
  if (duplicateSectionIds.length) flags.add("duplicate-section-id");
  const affectedBlockIds = site.affectedBlockIds ?? null;
  if (affectedSectionIds !== null && affectedBlockIds === null) mark("affectedBlockIds", site.unknownReasons?.affectedBlockIds ?? "no-block-data");

  // --- aggregate every unknown into one 1:1 list of paths ---
  const all = { ...unknown };
  const collect = (prefix, item) => { for (const f of item.unknown ?? []) all[`${prefix}:${f}`] = item.unknownReasons[f]; };
  for (const t of turnbacks ?? []) collect(`turnback:${t.candidateId}`, t);
  for (const s of suspensions ?? []) { collect(`suspension:${s.candidateId}`, s); collect(`suspension:${s.candidateId}:geometry`, s.geometry); }
  for (const d of detours ?? []) { collect(`detour:${d.candidateId}`, d); d.connections.forEach((c, i) => collect(`detour:${d.candidateId}:connection:${i}:${c.fromSectionId}`, c)); }
  for (const e of evacuation ?? []) collect(`evacuation:${e.candidateId}`, e);
  const unknownPaths = Object.keys(all).sort(byText);
  const license = { pack: ctx.pack.manifest?.data?.license ?? null, attribution: ctx.pack.manifest?.data?.attribution ?? [] };
  const sourceLayers = [
    { layer: "railway-disruption-site-geometry", quality: site.dataQuality ?? null, name: `RailwayDisruptionSiteGeometry ${site.disruptionSiteId}`, license: site.license?.pack ?? null },
    { layer: "rail-capacity-geometry", quality: geometry.dataQuality ?? null, name: `RailCapacityGeometry ${geometry.railGeometryId}`, license: geometry.license?.pack ?? null },
    ...(routeCurrent ? [{ layer: "through-route-geometry", quality: routeCurrent.dataQuality ?? null, name: `ThroughRouteGeometry ${routeCurrent.throughRouteId}`, license: routeCurrent.license?.pack ?? null }] : []),
    ...(ctx.spatial?.layers?.roads?.source && evacuation ? [{ layer: "roads", quality: ctx.spatial.layers.roads.quality ?? null, ...ctx.spatial.layers.roads.source }] : []),
    ...((ctx.stationSites ?? []).some((x) => (evacuation ?? []).some((e) => e.kind === "entrance" && e.stationId === x.connectedStationId)) ? [{ layer: "station-site-geometry", quality: null, name: "StationSiteGeometry entrance candidates", license: license.pack }] : []),
  ];
  const dataQuality = worse(worse(qualityOf(unknownPaths.length), geometry.dataQuality ?? "low"), site.dataQuality ?? "low");
  const facts = { eventId: site.eventId, disruptionSiteRevision: site.siteRevision, railGeometryRevision: geometry.railGeometryRevision, affectedTrackSegmentIds, affectedSectionIds, affectedBlockIds, turnbacks, suspensions, detours, evacuation };
  return {
    warnings,
    control: {
      schema: RAILWAY_SERVICE_CONTROL_SCHEMA, contractVersion: 1,
      controlGeometryId: controlId, controlGeometryRevision: stableId("railway-service-control-revision", controlId, JSON.stringify(facts)),
      sourcePackId: packId, sourcePackVersion: ctx.pack.manifest?.version ?? null,
      eventId: site.eventId, disruptionSiteId: site.disruptionSiteId, disruptionSiteRevision: site.siteRevision,
      railGeometryId: geometry.railGeometryId, railGeometryRevision: geometry.railGeometryRevision, throughRouteId: routeCurrent?.throughRouteId ?? null,
      operationalLineId: text(site.lineId), affectedTrackSegmentIds, affectedSectionIds, affectedBlockIds, scope: site.scope,
      affectedAlignment: site.alignment ?? null, disruptionLocation: site.location ?? null,
      turnbackCandidates: turnbacks, partialSuspensionCandidates: suspensions, detourCandidates: detours, evacuationAccessCandidates: evacuation,
      spatialFlags: [...flags].sort(byText), dataQuality, unknown: unknownPaths, unknownReasons: sortedObject(all),
      warnings, sourceLayers, license,
    },
  };
}

// documents: the player's control candidate documents, one per event (`active: false` switches one off without deleting it).
// sites: RailwayDisruptionSiteGeometry v1 objects; railGeometries: RailCapacityGeometry v1 objects; applications: rail-capacity-application/1.
export function buildRailwayServiceControlExport({ pack, sites = [], railGeometries = [], applications = [], routes = [], externalNetworks = [], stationSites = [], spatial = null, documents = [] }) {
  const packId = pack.manifest?.id ?? "pack";
  const built = new Map();
  const inactive = [];
  const warnings = [];
  for (const document of documents) {
    if (document?.active === false) { inactive.push({ eventId: document.eventId ?? null, controlGeometryId: hasKey(document.eventId) ? controlGeometryIdOf(packId, document.eventId) : null }); continue; }
    const site = sites.find((s) => s?.eventId === document?.eventId);
    if (!site) { warnings.push({ code: "railway-service-control-rejected", eventId: document?.eventId ?? null, reasons: [{ code: "site-missing", eventId: document?.eventId ?? null }] }); continue; }
    const railGeometry = railGeometries.find((g) => g.railGeometryId === site.railGeometryId);
    if (!railGeometry) { warnings.push({ code: "railway-service-control-rejected", eventId: document.eventId, reasons: [{ code: "rail-geometry-missing", railGeometryId: site.railGeometryId ?? null }] }); continue; }
    const application = applications.find((a) => a?.railGeometryId === railGeometry.railGeometryId && text(a.operationalLineId) === text(site.lineId)) ?? null;
    const out = buildRailwayServiceControl(document, { pack, site, railGeometry, application, routes, externalNetworks, stationSites, spatial });
    if (!out.control) warnings.push({ code: "railway-service-control-rejected", eventId: document.eventId, reasons: out.warnings });
    else if (built.has(out.control.controlGeometryId)) warnings.push({ code: "duplicate-railway-service-control", controlGeometryId: out.control.controlGeometryId });
    else built.set(out.control.controlGeometryId, out.control);
  }
  return {
    schema: RAILWAY_SERVICE_CONTROL_EXPORT_SCHEMA, packId, packVersion: pack.manifest?.version ?? null,
    controls: [...built.values()].sort((a, b) => byText(a.controlGeometryId, b.controlGeometryId)),
    inactive: inactive.sort((a, b) => byText(String(a.controlGeometryId), String(b.controlGeometryId))), warnings,
  };
}
