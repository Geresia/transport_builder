// Dev-time generator for the railway detour service examples in packs/<id>/railway-detour-service-examples/.
//   node scripts/build-railway-detour-service-examples.mjs [packId] [--out <dir>]   (npm run railway-detour-service-examples)
// With --out the files go to <dir>/<packId>/ instead of the pack (the tests use that to check byte-for-byte regeneration).
//
// An example is either built on a shipped railway service control example of the same pack (its disruption site and control
// geometry are rebuilt from that example's recorded input and checked against its ids and revision, so no id drifts) or on a
// small "custom" design written here over the pack's plan examples, with its own event. Then the "player" chooses one of the
// control geometry's detour candidates and may draw a connection line or a transfer passage. The events, applications, through
// routes, owners and everything the player draws are SYNTHETIC; the plans are real plan examples of the pack, the station
// sites are the pack's station examples and the catalog is the pack's external infrastructure catalog example. Nothing here
// reads a clock or a random number.
import fs from "node:fs";
import path from "node:path";
import { existingNetworkToExternal, buildMapExport } from "../engine/src/map/plan-geometry.mjs";
import { buildRailGeometry, planRevisionOf } from "../engine/src/map/rail-capacity-geometry.mjs";
import { buildThroughRoute } from "../engine/src/map/through-route.mjs";
import { buildRailwayDisruptionSite, RAILWAY_DISRUPTION_EVENT_SCHEMA } from "../engine/src/map/railway-disruption-site.mjs";
import { buildRailwayServiceControl } from "../engine/src/map/railway-service-control.mjs";
import { networkOf } from "../engine/src/map/railway-service-control-candidates.mjs";
import { buildRailwayDetourService } from "../engine/src/map/railway-detour-service.mjs";
import { addPlan, newRailwayDetourDoc, pick, serializeRailwayDetourDoc, setConnection, setTransferPath, toDetourDocument } from "../engine/src/map/railway-detour-service-editor.mjs";
import { makeSpatialContext } from "../engine/src/map/spatial.mjs";
import { round6 } from "../engine/src/map/ids.mjs";
import { root, readJson, loadPack } from "./lib/pack-spatial.mjs";
import { syntheticLayers } from "./lib/synthetic-layers.mjs";

const GENERATED_BY = "scripts/build-railway-detour-service-examples.mjs";
const NOTE = "Synthetic: the event, the application, the through route, the infrastructure owners, the player's choice and everything the player drew were written by hand for this example. The plans are real plan examples of this pack; station sites and the infrastructure catalog are the pack's own examples. Nothing was produced by the running engine.";
const args = process.argv.slice(2);
const outFlag = args.indexOf("--out");
const outRoot = outFlag >= 0 ? path.resolve(args[outFlag + 1]) : null;
const only = args.find((a, i) => !a.startsWith("--") && !(outFlag >= 0 && i === outFlag + 1));

const byName = (plans, suffix) => plans.find((p) => p.source.drawnLine.key.endsWith(suffix));
const ref = (plan, i) => ({ planId: plan.planId, segmentId: plan.segments[i].id });
const recorded = (...plans) => ({ plans: Object.fromEntries(plans.map((p) => [p.planId, planRevisionOf(p)])), routes: {} });
const stripSource = (o) => { const { source: _drop, ...rest } = o; return rest; };
const stationSiteOf = (pack, file) => stripSource(readJson(`${pack.dir}/station-examples/${file}.station.json`));
const sectionOf = (g, plan, i) => g.sections.find((s) => s.planId === plan.planId && s.segmentId === plan.segments[i].id);
const trackIdOf = (g, section) => `track-segment:${g.sections.findIndex((s) => s.sectionId === section.sectionId) + 1}`;
const applicationOf = (g) => ({
  schema: "transitline.rail-capacity-application/1", contractVersion: 1, operationalLineId: "line:1", railGeometryId: g.railGeometryId, railGeometryRevision: g.railGeometryRevision,
  sections: g.sections.map((s) => ({ trackSegmentId: trackIdOf(g, s), railCapacitySectionId: s.sectionId })),
});
const eventOf = (trackSegmentId) => ({
  schema: RAILWAY_DISRUPTION_EVENT_SCHEMA, contractVersion: 1, id: "railway-disruption:1", kind: "signal-failure", status: "active", lineId: "line:1", trackSegmentId, blockId: null, trainId: null,
  startedAtMinute: 600, expectedEndMinute: 660, resolvedAtMinute: null, resolutionReason: null, severity: "major", effect: { closed: true, speedLimitMps: 0 }, infrastructureOwnerId: null, operatorId: null, responsibility: "unknown", source: "example-fixture",
});
const shift = ([x, y], dx, dy) => [round6(x + dx), round6(y + dy)];

// each example: { file, case[], m7 | custom, stationSites?: [station example], catalog?: bool, networks?: bool, draw?(ctx, edit), choose?(detour) }
//   custom: { extraLines?: [drawn line], route?(plans) -> drawn route, design(plans, { route }) -> drawn rail design, target(geometry, plans) -> section }
// ctx: { geometry, net, control, candidate }
const line = (key, name, pts) => ({ key, name, vertices: pts.map((location) => ({ location, platformType: "side" })) });
const EXAMPLES = {
  "example-radial": () => [
    { file: "01-measured-joined-detour", case: ["measured-joined", "other-company-owner", "station-entrances", "picked-legs"], m7: "04-detour-over-another-companys-track", stationSites: ["04-deep-station", "03-shallow-cut-cover", "06-terminal-turnback"],
      choose: (d) => ({ leg: d.legs.map((l) => l.legId), connection: d.connections.map((c) => c.connectionId) }) },
    { file: "02-player-transfer-passage", case: ["player-transfer-path", "station-entrances", "measured-joined"], m7: "04-detour-over-another-companys-track", stationSites: ["04-deep-station", "03-shallow-cut-cover", "06-terminal-turnback"],
      draw: (c, e) => {
        const site = stationSiteOf(c.pack, "03-shallow-cut-cover");
        const at = site.entranceCandidates[0].location;
        e.transfer({ key: "passage-1", name: "Passage between the two lines", polyline: [at, shift(at, 0.0003, 0.0002)] });
      },
      choose: (d) => ({ transfer: d.playerTransferPaths.map((p) => p.transferPathId) }) },
    { file: "03-measured-apart-detour", case: ["measured-apart", "handover-between-different-stations", "owners-stated"], custom: "stub-loop" },
    { file: "04-player-connection-across-a-gap", case: ["player-connection", "measured-apart", "handover-between-different-stations"], custom: "stub-loop",
      draw: (c, e) => {
        const [a, b] = [c.net.stations.get(c.candidate.startStationId), c.net.stations.get(c.candidate.viaStationIds[0])];
        e.connection({ key: "link-1", name: "Walking connection drawn by the player", polyline: [b, a] });
      },
      choose: (d) => ({ connection: d.playerConnections.map((p) => p.playerConnectionId) }) },
  ],
  "example-corridor": () => [
    { file: "05-bypass-track-owner-unknown", case: ["measured-joined", "owner-unknown", "no-through-route", "single-track"], custom: "bypass" },
  ],
  tokyo: () => [
    { file: "06-existing-line-alignment-unknown", case: ["external-alignment-unknown", "connection-unmeasured", "no-station-detail"], m7: "01-existing-line-detour-connection-unknown" },
    { file: "07-existing-line-identified-by-catalog", case: ["external-alignment-unknown", "connection-unmeasured", "catalog-identification"], m7: "01-existing-line-detour-connection-unknown", catalog: true, networks: true },
    { file: "08-player-connection-on-an-unmeasured-link", case: ["player-connection", "connection-unmeasured", "external-alignment-unknown"], m7: "01-existing-line-detour-connection-unknown",
      draw: (c, e) => {
        const link = c.candidate.connections.find((x) => x.viaStationIds);
        e.connection({ key: "drawn-link", name: "Connection drawn by the player", polyline: link.viaStationIds.map((id) => c.net.stations.get(id)) });
      },
      choose: (d) => ({ connection: d.playerConnections.map((p) => p.playerConnectionId) }) },
  ],
};

// the two custom worlds: a loop over the pack's spoke and its transfer stub (every join is a handover between stations
// that are hundreds of metres apart) and a bypass plan drawn between two stations of the corridor trunk
const CUSTOM = {
  "stub-loop": {
    route: (p) => {
      const spoke = byName(p, "spoke");
      const stub = byName(p, "transfer-stub");
      const [s0, s1] = [spoke.segments[0].from, spoke.segments[0].to];
      return { key: "example:radial:detour-loop", legs: [
        { sourceKind: "planned", key: "spoke-back", planId: spoke.planId, fromStationId: s1, toStationId: s0, infrastructureOwnerId: "owner:synthetic-player" },
        { sourceKind: "planned", key: "stub", planId: stub.planId, infrastructureOwnerId: "owner:synthetic-other-company" },
        { sourceKind: "planned", key: "spoke-out", planId: spoke.planId, fromStationId: s1, infrastructureOwnerId: "owner:synthetic-player" },
      ] };
    },
    design: (p, { route }) => {
      const spoke = byName(p, "spoke");
      const stub = byName(p, "transfer-stub");
      return { key: "example:radial:detour-loop", name: "Spoke and a stub that is not joined to it", planIds: [spoke.planId, stub.planId], throughRouteId: route.throughRouteId,
        designedRevisions: { ...recorded(spoke, stub), routes: { [route.throughRouteId]: route.geometryRevision } }, sectionFacts: [{ ref: ref(spoke, 0), directionMode: "single", basis: "player" }] };
    },
    target: (g, p) => sectionOf(g, byName(p, "spoke"), 0),
  },
  bypass: {
    extraLines: (planList) => {
      const trunk = planList[0];
      const [a, b] = [trunk.segments[1].from, trunk.segments[1].to].map((id) => trunk.stationCandidates.find((s) => s.id === id).location);
      return [line("bypass", "Bypass track", [a, [round6((a[0] + b[0]) / 2), round6(a[1] + 0.003)], b])];
    },
    design: (p) => {
      const trunk = p[0];
      const bypass = p.at(-1);
      return { key: "example:corridor:detour-bypass", name: "Trunk with a bypass track drawn between two of its stations", planIds: [trunk.planId, bypass.planId], designedRevisions: recorded(trunk, bypass), sectionFacts: [{ ref: ref(trunk, 1), directionMode: "single", basis: "player" }] };
    },
    target: (g, p) => sectionOf(g, p[0], 1),
  },
};

for (const id of Object.keys(EXAMPLES).filter((k) => !only || k === only)) {
  const pack = loadPack(id);
  const basePlans = fs.readdirSync(path.join(root, pack.dir, "plan-examples")).filter((f) => f.endsWith(".plan.json")).sort().map((f) => readJson(`${pack.dir}/plan-examples/${f}`));
  const externals = pack.existingNetwork ? [existingNetworkToExternal(pack)] : [];
  const outDir = outRoot ? path.join(outRoot, id) : path.join(root, pack.dir, "railway-detour-service-examples");
  fs.mkdirSync(outDir, { recursive: true });
  for (const ex of EXAMPLES[id]()) {
    let geometry;
    let route = null;
    let event;
    let application;
    let siteDrawn;
    let control;
    let site;
    let externalNetworks = [];
    let m7Doc = { accessPoints: null, emergencyVehicleWidthMeters: null };
    let m7Spatial = makeSpatialContext({});
    let m7Shipped = null;
    let planList = basePlans;
    if (ex.m7) {
      // --- rebuilt from the recorded input of a shipped railway service control example ---
      m7Shipped = readJson(`${pack.dir}/railway-service-control-examples/${ex.m7}.service-control.json`);
      const input = m7Shipped.source.input;
      externalNetworks = m7Shipped.source.existingRail ? externals : [];
      if (input.drawnRoute) route = buildThroughRoute(input.drawnRoute, { pack, plans: planList, externalNetworks }).route;
      m7Spatial = makeSpatialContext(m7Shipped.source.layers.kind === "synthetic-fixture" ? syntheticLayers(m7Shipped.source.layers.center, m7Shipped.source.layers) : {});
      geometry = buildRailGeometry(input.drawnDesign, { pack, plans: planList, externalNetworks, routes: route ? [route] : [], spatial: m7Spatial }).design;
      event = input.event;
      application = input.application;
      siteDrawn = input.siteDrawn;
      const d = input.savedDocument.controls[0];
      m7Doc = { accessPoints: d.accessPoints, emergencyVehicleWidthMeters: d.emergencyVehicleWidthMeters };
    } else {
      // --- a small design written here ---
      const custom = CUSTOM[ex.custom];
      if (custom.extraLines) planList = [...basePlans, ...buildMapExport({ pack, mode: "scratch", drawnLines: custom.extraLines(basePlans) }).plans];
      if (custom.route) route = buildThroughRoute(custom.route(planList), { pack, plans: planList, externalNetworks }).route;
      geometry = buildRailGeometry(custom.design(planList, { route }), { pack, plans: planList, externalNetworks, routes: route ? [route] : [], spatial: makeSpatialContext({}) }).design;
      application = applicationOf(geometry);
      event = eventOf(trackIdOf(geometry, custom.target(geometry, planList)));
      siteDrawn = { eventId: event.id, designedRailGeometryRevision: geometry.railGeometryRevision };
    }
    site = buildRailwayDisruptionSite(siteDrawn, { pack: { manifest: pack.manifest }, events: [event], railGeometry: geometry, applications: [application] }).site;
    if (!site) throw new Error(`${id}/${ex.file}: site rejected`);
    const controlOut = buildRailwayServiceControl({ eventId: event.id, ...m7Doc }, { pack: { manifest: pack.manifest }, site, railGeometry: geometry, application, routes: route ? [route] : [], externalNetworks, stationSites: [], spatial: m7Spatial });
    control = controlOut.control;
    if (!control) throw new Error(`${id}/${ex.file}: control rejected ${JSON.stringify(controlOut.warnings)}`);
    if (m7Shipped && (control.controlGeometryId !== m7Shipped.controlGeometryId || control.controlGeometryRevision !== m7Shipped.controlGeometryRevision)) throw new Error(`${id}/${ex.file}: the control geometry no longer matches the shipped ${ex.m7} example`);

    // --- the player's choice and drawings ---
    const candidate = control.detourCandidates?.[0];
    if (!candidate) throw new Error(`${id}/${ex.file}: the control geometry offers no detour`);
    const net = networkOf(geometry);
    const doc = newRailwayDetourDoc(pack.manifest.id, pack.manifest.version ?? null);
    const plan = addPlan(doc, event.id, candidate.candidateId, control);
    const at = [doc, event.id, candidate.candidateId];
    if (ex.draw) ex.draw({ pack, geometry, net, control, candidate }, { connection: (c) => setConnection(...at, c), transfer: (t) => setTransferPath(...at, t) });
    const stationSites = (ex.stationSites ?? []).map((n) => stationSiteOf(pack, n));
    const catalog = ex.catalog ? stripSource(readJson(`${pack.dir}/external-rail-technical-examples/01-east-river-koto.catalog.json`)) : null;
    const buildCtx = { pack: { manifest: pack.manifest }, site, control, railGeometry: geometry, application, routes: route ? [route] : [], externalCatalog: catalog, externalNetworks: ex.networks ? externalNetworks : [], stationSites };
    let out = buildRailwayDetourService(toDetourDocument(plan), buildCtx);
    if (!out.detour) throw new Error(`${id}/${ex.file}: rejected ${JSON.stringify(out.warnings)}`);
    const chosen = ex.choose ? ex.choose(out.detour) : {};
    const picked = {};
    for (const [kind, list] of Object.entries(chosen)) { picked[kind] = [...list].sort(); for (const itemId of list) pick(...at, kind, itemId, out.detour); }
    out = buildRailwayDetourService(toDetourDocument(plan), buildCtx);
    const body = { ...out.detour, source: {
      case: ex.case, synthetic: true, note: NOTE, m7Example: ex.m7 ?? null, custom: ex.custom ?? null, stationSiteExamples: ex.stationSites ?? [], catalogExample: ex.catalog ? "01-east-river-koto" : null, externalNetworkOwners: Boolean(ex.networks),
      input: { savedDocument: JSON.parse(serializeRailwayDetourDoc(doc)) }, picked, generatedBy: GENERATED_BY,
    } };
    fs.writeFileSync(path.join(outDir, `${ex.file}.railway-detour-service.json`), `${JSON.stringify(body, null, 2)}\n`);
    const r = out.detour;
    console.log(`[${id}] ${ex.file}: legs=${r.legs.length} joints=${r.connections.length}[${r.connections.map((c) => c.physicalConnection)}] gaps=[${r.connections.map((c) => c.gapMeters)}] owners=${JSON.stringify(r.infrastructureOwnerIds)} player=${r.playerConnections?.length ?? null}/${r.playerTransferPaths?.length ?? null} picked=${Object.values(picked).flat().length} flags=[${r.spatialFlags}] unknown=${r.unknown.length} warn=${out.warnings.map((w) => w.code)}`);
  }
}
