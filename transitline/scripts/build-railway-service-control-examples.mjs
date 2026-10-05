// Dev-time generator for the railway service control examples in packs/<id>/railway-service-control-examples/.
//   node scripts/build-railway-service-control-examples.mjs [packId] [--out <dir>]   (npm run railway-service-control-examples)
// With --out the files go to <dir>/<packId>/ instead of the pack (the tests use that to check byte-for-byte regeneration).
//
// Each example is a rail design over real plan examples of the same pack (packs/<id>/plan-examples/), with a disruption
// event on one of its sections and the control candidates the map offers for it. The events, the applications that link
// an operational track to a map section, the through routes joined into a loop and every track fact (terminals,
// blocks, junctions, owners) are SYNTHETIC: written by hand here, not produced by the running engine, and each example
// file says so in `source`. Roads and station entrances come from the synthetic stand-in layers and the pack's own
// station examples; Tokyo uses no road layer at all, so its evacuation access is unknown. No clock or RNG is involved.
import fs from "node:fs";
import path from "node:path";
import { existingNetworkToExternal } from "../engine/src/map/plan-geometry.mjs";
import { buildRailGeometry, planRevisionOf } from "../engine/src/map/rail-capacity-geometry.mjs";
import { buildThroughRoute } from "../engine/src/map/through-route.mjs";
import { buildRailwayDisruptionSite, RAILWAY_DISRUPTION_EVENT_SCHEMA } from "../engine/src/map/railway-disruption-site.mjs";
import { buildRailwayServiceControl } from "../engine/src/map/railway-service-control.mjs";
import { addAccessPoint, addControl, newRailwayServiceControlDoc, selectCandidate, serializeRailwayServiceControlDoc, setEmergencyVehicleWidth, toControlDocument } from "../engine/src/map/railway-service-control-editor.mjs";
import { makeSpatialContext } from "../engine/src/map/spatial.mjs";
import { round6 } from "../engine/src/map/ids.mjs";
import { root, readJson, loadPack } from "./lib/pack-spatial.mjs";
import { syntheticLayers } from "./lib/synthetic-layers.mjs";

const GENERATED_BY = "scripts/build-railway-service-control-examples.mjs";
const NOTE = "Synthetic event, application, through route and track facts written by hand for this example in the shape of transitline.railway-disruption/1, transitline.rail-capacity-application/1 and the player's statements. They were not produced by the running engine; the plans are real plan examples of this pack.";
const args = process.argv.slice(2);
const outFlag = args.indexOf("--out");
const outRoot = outFlag >= 0 ? path.resolve(args[outFlag + 1]) : null;
const only = args.find((a, i) => !a.startsWith("--") && !(outFlag >= 0 && i === outFlag + 1));

const byName = (plans, suffix) => plans.find((p) => p.source.drawnLine.key.endsWith(suffix));
const ref = (plan, i) => ({ planId: plan.planId, segmentId: plan.segments[i].id });
const recorded = (...plans) => ({ plans: Object.fromEntries(plans.map((p) => [p.planId, planRevisionOf(p)])), routes: {} });
const player = (plan, i, fact) => ({ ref: ref(plan, i), basis: "player", ...fact });
const boundary = (key, plan, i, from, alongMeters) => ({ key, planId: plan.planId, segmentId: plan.segments[i].id, measuredFromStationId: from === "from" ? plan.segments[i].from : plan.segments[i].to, alongMeters, basis: "player" });
const syn = (center, options = {}) => ({ spec: { kind: "synthetic-fixture", generator: "scripts/lib/synthetic-layers.mjs", center, ...options }, layers: () => syntheticLayers(center, options) });
const noLayers = { spec: { kind: "none" }, layers: () => ({}) };
const shift = ([x, y], dx, dy) => [round6(x + dx), round6(y + dy)];

// the point `fraction` of the way along a section's alignment (planar, around its own latitude)
function pointOn(section, fraction) {
  const poly = section.alignment;
  const kx = Math.cos((poly[0][1] * Math.PI) / 180);
  const seg = poly.slice(1).map((p, i) => Math.hypot((p[0] - poly[i][0]) * kx, p[1] - poly[i][1]));
  let rest = seg.reduce((s, v) => s + v, 0) * fraction;
  for (let i = 0; i < seg.length; i++) {
    if (rest <= seg[i] || i === seg.length - 1) { const t = seg[i] === 0 ? 0 : Math.min(1, rest / seg[i]); return [round6(poly[i][0] + (poly[i + 1][0] - poly[i][0]) * t), round6(poly[i][1] + (poly[i + 1][1] - poly[i][1]) * t)]; }
    rest -= seg[i];
  }
  return poly.at(-1);
}
const EFFECT = { closed: true, speedLimitMps: 0 };
const trackIdOf = (g, section) => `track-segment:${g.sections.findIndex((s) => s.sectionId === section.sectionId) + 1}`;
const applicationOf = (g) => ({
  schema: "transitline.rail-capacity-application/1", contractVersion: 1, operationalLineId: "line:1", railGeometryId: g.railGeometryId, railGeometryRevision: g.railGeometryRevision,
  sections: g.sections.map((s) => ({ trackSegmentId: trackIdOf(g, s), railCapacitySectionId: s.sectionId })),
});
const eventOf = (n, kind, target) => ({
  schema: RAILWAY_DISRUPTION_EVENT_SCHEMA, contractVersion: 1, id: `railway-disruption:${n}`, kind, status: "active", lineId: "line:1",
  trackSegmentId: target.trackSegmentId ?? null, blockId: target.blockId ?? null, trainId: target.trainId ?? null,
  startedAtMinute: 600, expectedEndMinute: 660, resolvedAtMinute: null, resolutionReason: null, severity: "major", effect: EFFECT,
  infrastructureOwnerId: null, operatorId: null, responsibility: "unknown", source: "example-fixture",
});
const sec = (g, plan, i) => g.sections.find((s) => s.planId === plan.planId && s.segmentId === plan.segments[i].id);
const blocksOf = (g, section) => g.blocks.filter((b) => b.sectionId === section.sectionId).sort((a, b) => a.startAlongMeters - b.startAlongMeters);
const stationSiteOf = (pack, file) => { const { source: _drop, ...site } = readJson(`${pack.dir}/station-examples/${file}.station.json`); return site; };

// the west and east ends of the radial spoke each get a platform and a turnback track that start where the approach ends
const spokeTerminals = (sp) => {
  const west = sp.stationCandidates.find((s) => s.id === sp.segments[0].from).location;
  const east = sp.stationCandidates.find((s) => s.id === sp.segments[2].to).location;
  return [
    { key: "terminal-west", stationId: sp.segments[0].from, platforms: [{ key: "platform-west", approach: ref(sp, 0), polyline: [west, shift(west, -0.0016, 0)], platformLengthMeters: 120 }], turnbackTracks: [{ key: "turnback-west", kind: "turnback", polyline: [west, shift(west, -0.0014, 0.0004)] }] },
    { key: "terminal-east", stationId: sp.segments[2].to, platforms: [{ key: "platform-east", approach: ref(sp, 2), polyline: [east, shift(east, 0.0016, 0)], platformLengthMeters: 120 }], turnbackTracks: [{ key: "pull-out-east", kind: "pull-out", polyline: [east, shift(east, 0.0013, 0.0004)] }] },
  ];
};

// each example: { file, case[], layers, externalNetworks?, route?: (plans, externals) => drawn route,
//   design: (plans, { route, externals }) => drawn rail design, target: (g, plans) => { section, blockId?, trainId?, kind }, location?: fraction,
//   accessPoints?, vehicleWidth?, stationSites?: (pack) => [...], choose?: (control) => { kind: candidateId[] } }
const EXAMPLES = {
  "example-radial": () => {
    const H = [0.04347, 0.01165];
    const spoke = (p) => byName(p, "spoke");
    const terminalDesign = (key, name) => (p) => ({ key, name, planIds: [spoke(p).planId], designedRevisions: recorded(spoke(p)), sectionFacts: [player(spoke(p), 1, { directionMode: "double" })], blockBoundaries: [], terminals: spokeTerminals(spoke(p)) });
    return [
      { file: "01-terminal-turnback", case: ["terminal-turnback"], layers: syn(H),
        design: terminalDesign("example:radial:control-terminal", "Spoke with a platform and a turnback track stated at both terminals"),
        target: (g, p) => ({ section: sec(g, spoke(p), 1), kind: "track-obstruction" }), location: 0.5 },
      { file: "02-midway-turnback-candidate", case: ["midway-turnback-candidate"], layers: syn(H),
        design: terminalDesign("example:radial:control-midway", "Spoke with terminals stated only at its ends: the stations between have no turnback data"),
        target: (g, p) => ({ section: sec(g, spoke(p), 0), kind: "signal-failure" }), location: 0.4 },
      { file: "03-partial-suspension-around-the-event", case: ["partial-suspension"], layers: syn(H),
        design: (p) => ({ key: "example:radial:control-suspension", name: "Spoke with a block boundary in each section", planIds: [spoke(p).planId], designedRevisions: recorded(spoke(p)),
          sectionFacts: [player(spoke(p), 1, { directionMode: "double" })], blockBoundaries: [boundary("boundary-1", spoke(p), 1, "from", 1200), boundary("boundary-2", spoke(p), 2, "from", 1500)] }),
        target: (g, p) => ({ section: sec(g, spoke(p), 1), kind: "signal-failure" }), location: 0.3,
        choose: (c) => {
          const around = c.partialSuspensionCandidates.find((s) => s.suspendedSectionIds.length === 1);
          return { partialSuspension: [around.candidateId], turnback: [around.startTurnbackCandidateId, around.endTurnbackCandidateId] };
        } },
      { file: "04-detour-over-another-companys-track", case: ["other-company-detour"], layers: syn([0, 0]),
        route: (p) => ({ key: "example:radial:control-route", legs: [
          { sourceKind: "planned", key: "cross-city", planId: byName(p, "cross-city").planId, infrastructureOwnerId: "owner:synthetic-player" },
          { sourceKind: "planned", key: "station-variants", planId: byName(p, "station-variants").planId, infrastructureOwnerId: "owner:synthetic-other-company" },
        ] }),
        design: (p, { route }) => {
          const cross = byName(p, "cross-city");
          const variants = byName(p, "station-variants");
          return { key: "example:radial:control-detour", name: "Cross-city line beside the east-west line, which another company owns", planIds: [cross.planId, variants.planId], throughRouteId: route.throughRouteId,
            designedRevisions: { ...recorded(cross, variants), routes: { [route.throughRouteId]: route.geometryRevision } },
            junctions: [{ key: "crossing-1", kind: "crossing", location: [0, 0], connections: [{ ...ref(cross, 0), role: "a1" }, { ...ref(cross, 1), role: "a2" }, { ...ref(variants, 1), role: "b1" }, { ...ref(variants, 2), role: "b2" }] }] };
        },
        target: (g, p) => ({ section: g.sections.find((s) => s.planId === byName(p, "cross-city").planId && s.lengthMeters < 9000), kind: "signal-failure" }), location: 0.5,
        choose: (c) => ({ detour: [c.detourCandidates[0].candidateId] }) },
      { file: "05-evacuation-access-with-roads-and-entrances", case: ["evacuation-access"], layers: syn([0, 0]),
        design: (p) => ({ key: "example:radial:control-evacuation", name: "Spoke measured with the synthetic road layer", planIds: [spoke(p).planId], designedRevisions: recorded(spoke(p)) }),
        target: (g, p) => ({ section: sec(g, spoke(p), 0), kind: "track-obstruction" }), location: 0.5,
        accessPoints: [{ key: "service-road", kind: "road-access", location: [0.0092, 0.0008], basis: "player", roadWidthMeters: 6, name: "Service road" }, { key: "field-gate", kind: "entrance", location: [0.0108, -0.0006], basis: "player", name: "Field gate" }],
        vehicleWidth: 2.5,
        stationSites: (pack) => [stationSiteOf(pack, "04-deep-station"), stationSiteOf(pack, "03-shallow-cut-cover")] },
    ];
  },
  "example-corridor": () => {
    const trunk = (p) => p[0];
    return [
      { file: "01-terminal-turnback-with-facilities", case: ["terminal-turnback"], layers: syn([0, 0]),
        design: (p) => {
          const t = trunk(p);
          return { key: "example:corridor:control-terminal", name: "East terminal with two platform tracks, a stabling track and a pull-out track", planIds: [t.planId], designedRevisions: recorded(t),
            sectionFacts: [player(t, 2, { directionMode: "double" })],
            junctions: [{ key: "turnout-1", kind: "turnout", location: [0.0092, 0], connections: [{ ...ref(t, 2), role: "stem" }] }],
            terminals: [{ key: "terminal-1", stationId: t.segments[2].to,
              platforms: [
                { key: "platform-1", approach: ref(t, 2), polyline: [[0.01, 0], [0.0112, 0]], platformLengthMeters: 120 },
                { key: "platform-2", approach: ref(t, 2), viaJunctionKeys: ["turnout-1"], polyline: [[0.0092, 0], [0.0097, -0.0003], [0.0112, -0.0003]], platformLengthMeters: 120 },
              ],
              turnbackTracks: [
                { key: "stabling-1", kind: "stabling", viaJunctionKey: "turnout-1", polyline: [[0.0092, 0], [0.0092, -0.0007], [0.0106, -0.0011]] },
                { key: "pull-out-1", kind: "pull-out", polyline: [[0.0095, 0.0003], [0.0112, 0.0003]] },
              ] }] };
        },
        target: (g, p) => ({ section: sec(g, trunk(p), 1), kind: "signal-failure" }), location: 0.5 },
      { file: "02-no-turnback-facility-data", case: ["no-turnback-facility-data", "midway-turnback-candidate"], layers: syn([0, 0]),
        design: (p) => ({ key: "example:corridor:control-bare", name: "Trunk with no terminal, block, junction or track count data", planIds: [trunk(p).planId], designedRevisions: recorded(trunk(p)) }),
        target: (g, p) => ({ section: sec(g, trunk(p), 1), kind: "track-obstruction" }), location: 0.5 },
      { file: "03-single-track-one-block", case: ["single-track", "single-block"], layers: syn([0, 0]),
        design: (p) => ({ key: "example:corridor:control-single-blocks", name: "Single-track middle section split into three blocks", planIds: [trunk(p).planId], designedRevisions: recorded(trunk(p)),
          sectionFacts: [player(trunk(p), 1, { directionMode: "single" })], blockBoundaries: [boundary("boundary-1", trunk(p), 1, "from", 800), boundary("boundary-2", trunk(p), 1, "from", 1500)] }),
        target: (g, p) => { const section = g.sections.find((s) => s.planId === trunk(p).planId && s.directionMode === "single"); return { section, blockId: blocksOf(g, section)[1].blockId, kind: "signal-failure" }; }, location: 0.5 },
    ];
  },
  tokyo: (pack) => {
    const koto = readJson(`${pack.dir}/existing-network.json`).lines.filter((l) => l.stationIds.includes("ward-koto") && l.osmRelationId !== undefined).sort((a, b) => a.osmRelationId - b.osmRelationId)[0];
    const extId = `ext-line:${koto.osmRelationId}`;
    return [
      { file: "01-existing-line-detour-connection-unknown", case: ["other-company-detour", "external-connection-unknown"], layers: noLayers, externalNetworks: true,
        // the plan, the existing line, and the plan again: a loop whose two handovers join differing stations, so each is an explicit link
        route: (p, ext) => {
          const line = ext[0].lines.find((l) => l.id === extId);
          return { key: "example:tokyo:control-loop", legs: [
            { sourceKind: "planned", key: "plan-out", planId: byName(p, "east-river-crossing").planId, infrastructureOwnerId: "owner:synthetic-player" },
            { sourceKind: "external", key: "existing-line", externalLineId: extId, fromStationId: line.stationIds[0], toStationId: line.stationIds.at(-1), infrastructureOwnerId: "owner:synthetic-existing-line-owner" },
            { sourceKind: "planned", key: "plan-back", planId: byName(p, "east-river-crossing").planId, infrastructureOwnerId: "owner:synthetic-player" },
          ] };
        },
        design: (p, { route }) => {
          const plan = byName(p, "east-river-crossing");
          return { key: "example:tokyo:control-loop", name: "East river crossing and an existing line joined at both ends (station level only)", planIds: [plan.planId], externalLineIds: [extId], throughRouteId: route.throughRouteId,
            designedRevisions: { ...recorded(plan), routes: { [route.throughRouteId]: route.geometryRevision } }, sectionFacts: [player(plan, 1, { directionMode: "double" })] };
        },
        target: (g, p) => ({ section: sec(g, byName(p, "east-river-crossing"), 1), kind: "track-obstruction" }), location: 0.5,
        choose: (c) => ({ detour: [c.detourCandidates[0].candidateId] }) },
      { file: "02-no-evacuation-access-data", case: ["no-evacuation-access-data"], layers: noLayers,
        design: (p) => { const plan = byName(p, "station-variants"); return { key: "example:tokyo:control-no-evacuation", name: "Station variants line with no road or entrance data", planIds: [plan.planId], designedRevisions: recorded(plan), sectionFacts: [player(plan, 2, { directionMode: "double" })] }; },
        target: (g, p) => ({ section: sec(g, byName(p, "station-variants"), 2), kind: "signal-failure" }) },
      { file: "03-vehicle-failure-train-position-unknown", case: ["train-scope"], layers: noLayers,
        design: (p) => { const plan = byName(p, "bay-ward-spine"); return { key: "example:tokyo:control-train", name: "Bay ward spine, an event on a train", planIds: [plan.planId], designedRevisions: recorded(plan) }; },
        target: () => ({ trainId: "train:7", kind: "vehicle-failure" }) },
    ];
  },
};

for (const id of Object.keys(EXAMPLES).filter((k) => !only || k === only)) {
  const pack = loadPack(id);
  const planList = fs.readdirSync(path.join(root, pack.dir, "plan-examples")).filter((f) => f.endsWith(".plan.json")).sort().map((f) => readJson(`${pack.dir}/plan-examples/${f}`));
  const externals = pack.existingNetwork ? [existingNetworkToExternal(pack)] : [];
  const outDir = outRoot ? path.join(outRoot, id) : path.join(root, pack.dir, "railway-service-control-examples");
  fs.mkdirSync(outDir, { recursive: true });
  for (const ex of EXAMPLES[id](pack)) {
    const externalNetworks = ex.externalNetworks ? externals : [];
    let route = null;
    let drawnRoute = null;
    if (ex.route) {
      drawnRoute = ex.route(planList, externals);
      const built = buildThroughRoute(drawnRoute, { pack, plans: planList, externalNetworks });
      if (!built.route) throw new Error(`${id}/${ex.file}: route rejected ${JSON.stringify(built.warnings)}`);
      route = built.route;
    }
    const spatial = makeSpatialContext(ex.layers.layers());
    const drawnDesign = ex.design(planList, { route, externals });
    const geometry = buildRailGeometry(drawnDesign, { pack, plans: planList, externalNetworks, routes: route ? [route] : [], spatial });
    if (!geometry.design) throw new Error(`${id}/${ex.file}: geometry rejected ${JSON.stringify(geometry.warnings)}`);
    const g = geometry.design;
    const application = applicationOf(g);
    const target = ex.target(g, planList);
    const event = eventOf(1, target.kind, { trackSegmentId: target.section ? trackIdOf(g, target.section) : null, blockId: target.blockId, trainId: target.trainId });
    const siteDrawn = { eventId: event.id, designedRailGeometryRevision: g.railGeometryRevision, ...(ex.location !== undefined ? { location: pointOn(target.section, ex.location), locationBasis: "player" } : {}) };
    const site = buildRailwayDisruptionSite(siteDrawn, { pack: { manifest: pack.manifest }, events: [event], railGeometry: g, applications: [application] });
    if (!site.site) throw new Error(`${id}/${ex.file}: site rejected ${JSON.stringify(site.warnings)}`);

    // what the player states: access points and the width of the vehicle they care about, kept in the editor's own document
    const doc = newRailwayServiceControlDoc(pack.manifest.id, pack.manifest.version ?? null);
    const entry = addControl(doc, event.id);
    for (const a of ex.accessPoints ?? []) addAccessPoint(doc, event.id, a);
    if (ex.vehicleWidth) setEmergencyVehicleWidth(doc, event.id, ex.vehicleWidth);
    const stationSites = ex.stationSites ? ex.stationSites(pack) : [];
    const out = buildRailwayServiceControl(toControlDocument(entry), { pack: { manifest: pack.manifest }, site: site.site, railGeometry: g, application, routes: route ? [route] : [], externalNetworks, stationSites, spatial });
    if (!out.control) throw new Error(`${id}/${ex.file}: control rejected ${JSON.stringify(out.warnings)}`);
    const chosen = ex.choose ? ex.choose(out.control) : {};
    const selection = {};
    for (const [kind, list] of Object.entries(chosen)) { selection[kind] = [...list].sort(); for (const cid of list) selectCandidate(doc, event.id, kind, cid, out.control); }

    const body = { ...out.control, source: {
      case: ex.case, synthetic: true, note: NOTE, layers: ex.layers.spec, existingRail: Boolean(ex.externalNetworks),
      input: { drawnDesign, drawnRoute, event, application, siteDrawn, savedDocument: JSON.parse(serializeRailwayServiceControlDoc(doc)) }, selection, generatedBy: GENERATED_BY,
    } };
    fs.writeFileSync(path.join(outDir, `${ex.file}.service-control.json`), `${JSON.stringify(body, null, 2)}\n`);
    const c = out.control;
    console.log(`[${id}] ${ex.file}: scope=${c.scope} turnbacks=${c.turnbackCandidates?.length ?? null}(attached ${c.turnbackCandidates?.filter((t) => t.physicalAttachment === true).length ?? null}) suspensions=${c.partialSuspensionCandidates?.length ?? null} detours=${c.detourCandidates?.length ?? null} evacuation=${c.evacuationAccessCandidates?.length ?? null} flags=[${c.spatialFlags}] unknown=${c.unknown.length} warn=${out.warnings.map((w) => w.code)} chosen=${Object.values(selection).flat().length}`);
  }
}
