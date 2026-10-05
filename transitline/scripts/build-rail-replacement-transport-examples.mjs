// Dev-time generator for the rail replacement transport examples in packs/<id>/rail-replacement-transport-examples/.
//   node scripts/build-rail-replacement-transport-examples.mjs [packId] [--out <dir>]   (npm run rail-replacement-transport-examples)
// With --out the files go to <dir>/<packId>/ instead of the pack (the tests use that to check byte-for-byte regeneration).
//
// Each example takes a railway service control example of the same pack (packs/<id>/railway-service-control-examples/),
// rebuilds its disruption site and control geometry from that example's own recorded input, checks the ids and the
// revision against the shipped example (so no id drifts), and then lets the "player" choose one of its partial
// suspension candidates and draw a replacement. Everything the player draws, the road layers (written here, labelled
// synthetic) and the application are SYNTHETIC; the plans are real plan examples of the pack and the station sites are
// the pack's own station examples. The road layers are bags of lines, as the real road data is: nothing here searches
// a route over them. No clock or RNG is involved.
import fs from "node:fs";
import path from "node:path";
import { existingNetworkToExternal } from "../engine/src/map/plan-geometry.mjs";
import { buildRailGeometry } from "../engine/src/map/rail-capacity-geometry.mjs";
import { buildThroughRoute } from "../engine/src/map/through-route.mjs";
import { buildRailwayDisruptionSite } from "../engine/src/map/railway-disruption-site.mjs";
import { buildRailwayServiceControl } from "../engine/src/map/railway-service-control.mjs";
import { networkOf } from "../engine/src/map/railway-service-control-candidates.mjs";
import { railRange } from "../engine/src/map/rail-replacement-transport-candidates.mjs";
import { buildRailReplacementTransport } from "../engine/src/map/rail-replacement-transport.mjs";
import { addPlan, newRailReplacementDoc, selectTurnback, serializeRailReplacementDoc, setConstraint, setRoute, setTemporaryStop, setTurnaroundArea, setVehicleWidth, toReplacementDocument } from "../engine/src/map/rail-replacement-transport-editor.mjs";
import { makeSpatialContext, roadLayerFromGeojson } from "../engine/src/map/spatial.mjs";
import { round6 } from "../engine/src/map/ids.mjs";
import { root, readJson, loadPack } from "./lib/pack-spatial.mjs";
import { syntheticLayers } from "./lib/synthetic-layers.mjs";

const GENERATED_BY = "scripts/build-rail-replacement-transport-examples.mjs";
const NOTE = "Synthetic: the player's choice, routes, stops, turning places, constraints, vehicle width and the road lines were written by hand for this example. The plans are real plan examples of this pack; the disruption site and the control geometry are rebuilt from the recorded input of the named railway service control example. Nothing was produced by the running engine.";
const args = process.argv.slice(2);
const outFlag = args.indexOf("--out");
const outRoot = outFlag >= 0 ? path.resolve(args[outFlag + 1]) : null;
const only = args.find((a, i) => !a.startsWith("--") && !(outFlag >= 0 && i === outFlag + 1));

const stationSiteOf = (pack, file) => { const { source: _drop, ...site } = readJson(`${pack.dir}/station-examples/${file}.station.json`); return site; };
const NORTH = 0.0002; // the drawn road runs ~22 m beside the rail alignment

// the part of a polyline between two fractions of its planar length, shifted north by `dy`
function slice(poly, f0, f1, dy = 0) {
  const kx = Math.cos((poly[0][1] * Math.PI) / 180);
  const seg = poly.slice(1).map((p, i) => Math.hypot((p[0] - poly[i][0]) * kx, p[1] - poly[i][1]));
  const total = seg.reduce((s, v) => s + v, 0);
  const at = (d) => {
    let rest = d;
    for (let i = 0; i < seg.length; i++) {
      if (rest <= seg[i] || i === seg.length - 1) { const t = seg[i] === 0 ? 0 : Math.min(1, rest / seg[i]); return [poly[i][0] + (poly[i + 1][0] - poly[i][0]) * t, poly[i][1] + (poly[i + 1][1] - poly[i][1]) * t]; }
      rest -= seg[i];
    }
    return poly.at(-1);
  };
  const out = [at(total * f0)];
  let run = 0;
  for (let i = 1; i < poly.length - 1; i++) { run += seg[i - 1]; if (run > total * f0 && run < total * f1) out.push(poly[i]); }
  out.push(at(total * f1));
  return out.map(([x, y]) => [round6(x), round6(y + dy)]);
}
const roadLayer = (lines, extra = {}) => roadLayerFromGeojson({ features: lines.map((coordinates, i) => ({ geometry: { coordinates }, properties: { roadClass: i % 2 ? "minor" : "major" } })) },
  { quality: "medium", source: { name: "Synthetic road lines (written in scripts/build-rail-replacement-transport-examples.mjs)", license: "CC0-1.0" }, ...extra });
const box = ([lon, lat], h) => ([x, y]) => x >= lon - h && x <= lon + h && y >= lat - h && y <= lat + h;
const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

// each example: { file, case[], m7, retarget?, m7StationSites?, pick(control) -> candidate, turnbacks: "both"|"none",
//   layers(ctx) -> { description, layers }, stationSites?: [station example], draw(ctx, doc, edit) -> adds the player's drawings }
// ctx: { geometry, control, candidate, stations: [{ stationId, location }], spine: [[lon,lat]...] | null }
const withLength = (n) => (c) => c.partialSuspensionCandidates.find((s) => s.suspendedSectionIds.length === n);
const EXAMPLES = {
  "example-radial": () => [
    { file: "01-middle-section-bus-between-boundary-stations", case: ["middle-section", "boundary-stations", "player-route"], m7: "03-partial-suspension-around-the-event", pick: withLength(1), turnbacks: "both", stationSites: ["03-shallow-cut-cover"],
      layers: (c) => ({ description: "one road beside the whole rail section", layers: { roads: roadLayer([slice(c.spine, 0, 1, NORTH)]) } }),
      draw: (c, e) => e.route({ key: "bus-1", name: "Replacement bus", polyline: slice(c.spine, 0, 1, NORTH).reverse() }) },
    { file: "02-line-end-suspension-bus", case: ["line-end", "terminal-side-suspension", "player-route", "temporary-stop"], m7: "02-midway-turnback-candidate", pick: withLength(1), turnbacks: "both", stationSites: ["04-deep-station", "03-shallow-cut-cover"],
      layers: (c) => ({ description: "one road beside the whole rail section", layers: { roads: roadLayer([slice(c.spine, 0, 1, NORTH)]) } }),
      draw: (c, e) => {
        e.route({ key: "bus-1", polyline: slice(c.spine, 0, 1, NORTH) });
        e.stop({ key: "stop-west", stationId: c.stations[0].stationId, location: slice(c.spine, 0.02, 0.02, NORTH)[0], name: "West temporary stop", roadWidthMeters: 6 });
        e.width(2.5);
      } },
    { file: "03-several-stations-in-order", case: ["several-stations", "route-order", "player-route"], m7: "03-partial-suspension-around-the-event", pick: withLength(3), turnbacks: "none",
      layers: (c) => ({ description: "one road beside the whole suspended range", layers: { roads: roadLayer([slice(c.spine, 0, 1, NORTH)]) } }),
      draw: (c, e) => { e.route({ key: "bus-all", polyline: slice(c.spine, 0, 1, NORTH) }); e.route({ key: "bus-first-half", polyline: slice(c.spine, 0, 0.45, NORTH) }); } },
    { file: "04-entrances-and-temporary-stop", case: ["station-entrances", "temporary-stop", "walk-links"], m7: "05-evacuation-access-with-roads-and-entrances", m7StationSites: ["04-deep-station", "03-shallow-cut-cover"], pick: withLength(1), turnbacks: "both", stationSites: ["04-deep-station", "03-shallow-cut-cover"],
      layers: () => ({ description: "the synthetic road layer of the pack's station examples", layers: { roads: syntheticLayers([0, 0], { only: ["roads"] }).roads } }),
      draw: (c, e) => { e.stop({ key: "stop-east", stationId: c.stations[0].stationId, location: [0.0196, 0.0003], name: "East temporary stop", roadWidthMeters: 7 }); e.width(2.5); } },
    { file: "05-player-drawn-road-route-with-constraints", case: ["player-route", "road-width", "spatial-constraints", "outside-road-coverage"], m7: "02-midway-turnback-candidate", pick: withLength(2), turnbacks: "none",
      layers: () => ({ description: "the synthetic road, water and building layers around the origin (they stop at 2.2 km)", layers: syntheticLayers([0, 0], { only: ["roads", "water", "buildings"] }) }),
      draw: (c, e) => {
        e.route({ key: "bus-along-major-road", polyline: [[0, 0.0003], [0.0099, 0.0003], [0.02, 0.0003], c.stations[0].location], roadWidthMeters: 7 });
        e.constraint({ key: "weight-limit-1", kind: "weight-limit", location: [0.0099, 0.0003], value: 20, unit: "t" });
        e.constraint({ key: "bridge-1", kind: "bridge", location: [0.0185, 0.0003] });
        e.width(2.5);
      } },
    { file: "06-route-disconnected-from-the-road", case: ["road-disconnected", "player-route"], m7: "03-partial-suspension-around-the-event", pick: withLength(1), turnbacks: "both",
      layers: (c) => ({ description: "two road pieces beside the rail section with a gap between them", layers: { roads: roadLayer([slice(c.spine, 0, 0.35, NORTH), slice(c.spine, 0.65, 1, NORTH)]) } }),
      draw: (c, e) => { e.route({ key: "bus-across-the-gap", polyline: slice(c.spine, 0, 1, NORTH) }); e.route({ key: "bus-beside-no-road", polyline: slice(c.spine, 0, 1, 0.004) }); } },
    { file: "07-road-width-unknown-and-stated", case: ["road-width"], m7: "02-midway-turnback-candidate", pick: withLength(1), turnbacks: "none",
      layers: (c) => ({ description: "one road beside the whole rail section", layers: { roads: roadLayer([slice(c.spine, 0, 1, NORTH)]) } }),
      draw: (c, e) => {
        e.route({ key: "wide", polyline: slice(c.spine, 0, 1, NORTH), roadWidthMeters: 7 });
        e.route({ key: "narrow", polyline: slice(c.spine, 0, 1, NORTH + 0.00005), roadWidthMeters: 2 });
        e.route({ key: "unstated", polyline: slice(c.spine, 0, 1, NORTH - 0.00005) });
        e.width(2.5);
      } },
    { file: "10-turnaround-and-waiting-space", case: ["bus-turnaround", "waiting-space", "boarding-space"], m7: "02-midway-turnback-candidate", pick: withLength(1), turnbacks: "both", stationSites: ["04-deep-station", "03-shallow-cut-cover"],
      layers: () => ({ description: "the synthetic road, water, building and land-use layers around the origin", layers: syntheticLayers([0, 0], { only: ["roads", "water", "buildings", "landuse"] }) }),
      draw: (c, e) => {
        e.route({ key: "bus-1", polyline: [[0.0002, 0.0003], [0.0099, 0.0003], [0.0198, 0.0003]] });
        e.area({ key: "turnaround-east", kind: "turnaround", polygon: rect(0.0192, 0.0004, 0.0199, 0.0009), name: "East turning place" });
        e.area({ key: "waiting-west", kind: "waiting", polygon: rect(0.0016, 0.0006, 0.0024, 0.0011), name: "West waiting space" });
        e.area({ key: "boarding-west", kind: "boarding", location: [0.0004, 0.0004], name: "West temporary boarding point" });
      } },
    { file: "11-outside-the-road-data", case: ["outside-road-coverage"], m7: "01-terminal-turnback", pick: withLength(1), turnbacks: "both", stationSites: ["03-shallow-cut-cover"],
      layers: () => ({ description: "a road layer that covers a district 5 km west of the rail section", layers: { roads: roadLayer([[[-0.06, 0.0003], [-0.04, 0.0003]]], { covers: box([-0.05, 0], 0.02) }) } }),
      draw: (c, e) => e.route({ key: "bus-1", polyline: slice(c.spine, 0, 1, NORTH) }) },
  ],
  "example-corridor": () => [
    { file: "08-entrance-data-unknown", case: ["entrance-data-unknown", "player-route"], m7: "02-no-turnback-facility-data", pick: withLength(1), turnbacks: "none",
      layers: (c) => ({ description: "one road beside the whole rail section", layers: { roads: roadLayer([slice(c.spine, 0, 1, NORTH)]) } }),
      draw: (c, e) => { e.route({ key: "bus-1", polyline: slice(c.spine, 0, 1, NORTH) }); e.stop({ key: "stop-a", stationId: c.stations[0].stationId, location: slice(c.spine, 0.03, 0.03, NORTH)[0] }); } },
  ],
  tokyo: () => [
    { file: "09-no-road-layer", case: ["no-road-layer", "player-route", "temporary-stop"], m7: "02-no-evacuation-access-data", pick: withLength(1), turnbacks: "none",
      layers: () => ({ description: "no road layer is loaded", layers: {} }),
      draw: (c, e) => { e.route({ key: "bus-1", polyline: slice(c.spine, 0, 1, NORTH) }); e.stop({ key: "stop-a", stationId: c.stations[0].stationId, location: slice(c.spine, 0.03, 0.03, NORTH)[0] }); } },
    { file: "12-external-stations-without-detail", case: ["external-station", "no-detailed-spatial-data"], m7: "01-existing-line-detour-connection-unknown", retarget: (g) => g.sections.find((s) => s.sourceKind === "external" && (s.fromStationId === "ward-chuo" || s.toStationId === "ward-chuo")), pick: withLength(1), turnbacks: "none",
      layers: () => ({ description: "no road layer is loaded", layers: {} }),
      draw: (c, e) => e.route({ key: "bus-between-stations", polyline: c.stations.map((s) => s.location) }) },
  ],
};

for (const id of Object.keys(EXAMPLES).filter((k) => !only || k === only)) {
  const pack = loadPack(id);
  const planList = fs.readdirSync(path.join(root, pack.dir, "plan-examples")).filter((f) => f.endsWith(".plan.json")).sort().map((f) => readJson(`${pack.dir}/plan-examples/${f}`));
  const externals = pack.existingNetwork ? [existingNetworkToExternal(pack)] : [];
  const outDir = outRoot ? path.join(outRoot, id) : path.join(root, pack.dir, "rail-replacement-transport-examples");
  fs.mkdirSync(outDir, { recursive: true });
  for (const ex of EXAMPLES[id]()) {
    // --- the disruption site and the control geometry, rebuilt from the recorded input of the railway service control example ---
    const shipped = readJson(`${pack.dir}/railway-service-control-examples/${ex.m7}.service-control.json`);
    const input = shipped.source.input;
    const externalNetworks = shipped.source.existingRail ? externals : [];
    let route = null;
    if (input.drawnRoute) route = buildThroughRoute(input.drawnRoute, { pack, plans: planList, externalNetworks }).route;
    const m7Spatial = makeSpatialContext(shipped.source.layers.kind === "synthetic-fixture" ? syntheticLayers(shipped.source.layers.center, shipped.source.layers) : {});
    const geometry = buildRailGeometry(input.drawnDesign, { pack, plans: planList, externalNetworks, routes: route ? [route] : [], spatial: m7Spatial }).design;
    let event = input.event;
    let siteDrawn = input.siteDrawn;
    if (ex.retarget) {
      const section = ex.retarget(geometry);
      event = { ...event, trackSegmentId: input.application.sections.find((s) => s.railCapacitySectionId === section.sectionId).trackSegmentId };
      const { location: _l, locationBasis: _b, ...rest } = siteDrawn;
      siteDrawn = rest;
    }
    const site = buildRailwayDisruptionSite(siteDrawn, { pack: { manifest: pack.manifest }, events: [event], railGeometry: geometry, applications: [input.application] }).site;
    const m7Doc = input.savedDocument.controls[0];
    const controlOut = buildRailwayServiceControl({ eventId: m7Doc.eventId, accessPoints: m7Doc.accessPoints, emergencyVehicleWidthMeters: m7Doc.emergencyVehicleWidthMeters },
      { pack: { manifest: pack.manifest }, site, railGeometry: geometry, application: input.application, routes: route ? [route] : [], externalNetworks, stationSites: (ex.m7StationSites ?? []).map((n) => stationSiteOf(pack, n)), spatial: m7Spatial });
    const control = controlOut.control;
    if (!control) throw new Error(`${id}/${ex.file}: control rejected ${JSON.stringify(controlOut.warnings)}`);
    if (!ex.retarget && (control.controlGeometryId !== shipped.controlGeometryId || control.controlGeometryRevision !== shipped.controlGeometryRevision)) throw new Error(`${id}/${ex.file}: the control geometry no longer matches the shipped ${ex.m7} example`);

    // --- the player's choice and drawings ---
    const candidate = ex.pick(control);
    const net = networkOf(geometry);
    const range = railRange({ net, candidate });
    const stations = range.sequence.map((stationId) => ({ stationId, location: net.stations.get(stationId) }));
    const orient = (s) => (s.section.fromStationId === s.from ? s.section.alignment : s.section.alignment && [...s.section.alignment].reverse());
    const pieces = range.sections.map(orient);
    const spine = pieces.every(Boolean) ? pieces.reduce((acc, p) => [...acc, ...p.slice(acc.length ? 1 : 0)], []) : null;
    const ctx = { geometry, control, candidate, stations, spine };
    const drawing = ex.layers(ctx);
    const doc = newRailReplacementDoc(pack.manifest.id, pack.manifest.version ?? null);
    const plan = addPlan(doc, event.id, candidate.candidateId, control);
    if (ex.turnbacks === "both") for (const tid of [candidate.startTurnbackCandidateId, candidate.endTurnbackCandidateId]) selectTurnback(doc, event.id, candidate.candidateId, tid, control);
    const at = [doc, event.id, candidate.candidateId];
    ex.draw(ctx, {
      route: (r) => setRoute(...at, r), stop: (s) => setTemporaryStop(...at, s), area: (a) => setTurnaroundArea(...at, a), constraint: (k) => setConstraint(...at, k), width: (w) => setVehicleWidth(...at, w),
    });
    const out = buildRailReplacementTransport(toReplacementDocument(plan), {
      pack: { manifest: pack.manifest }, site, control, railGeometry: geometry, application: input.application,
      stationSites: (ex.stationSites ?? []).map((n) => stationSiteOf(pack, n)), spatial: makeSpatialContext(drawing.layers),
    });
    if (!out.replacement) throw new Error(`${id}/${ex.file}: rejected ${JSON.stringify(out.warnings)}`);
    const body = { ...out.replacement, source: {
      case: ex.case, synthetic: true, note: NOTE, m7Example: ex.m7, retargeted: Boolean(ex.retarget), roadLayers: drawing.description, stationSiteExamples: ex.stationSites ?? [],
      input: { savedDocument: JSON.parse(serializeRailReplacementDoc(doc)) }, generatedBy: GENERATED_BY,
    } };
    fs.writeFileSync(path.join(outDir, `${ex.file}.rail-replacement-transport.json`), `${JSON.stringify(body, null, 2)}\n`);
    const r = out.replacement;
    console.log(`[${id}] ${ex.file}: stations=${r.stationSequence?.length ?? null} routes=${r.routeCandidates?.length ?? null} stops=${r.stopCandidates?.length ?? null} areas=${r.turnaroundAreas?.length ?? null} joined=${r.boundaryStationsConnectedByRetainedRail} flags=[${r.spatialFlags}] unknown=${r.unknown.length} warn=${out.warnings.map((w) => w.code)}`);
  }
}
