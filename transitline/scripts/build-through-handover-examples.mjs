// Dev-time generator for the handover-site examples in packs/<id>/through-handover-examples/.
//   node scripts/build-through-handover-examples.mjs [packId] [--out <dir>]   (npm run through-handover-examples)
// With --out the files go to <dir>/<packId>/ instead of the pack (the tests use that to check byte-for-byte regeneration).
//
// Each example designs a connection over a real through-route example of the same pack (packs/<id>/through-route-examples/).
// The synthetic packs use generated stand-in layers (scripts/lib/synthetic-layers.mjs, labelled synthetic-fixture); Tokyo
// uses only the pack's own tracked files (barriers.json water, obstacles.json building footprints, and the coarse
// station-level existing rail), so the output does not depend on any local, git-ignored data. No clock or RNG is involved.
import fs from "node:fs";
import path from "node:path";
import { existingNetworkToExternal } from "../engine/src/map/plan-geometry.mjs";
import { buildThroughHandoverSite } from "../engine/src/map/through-handover-site.mjs";
import { makeSpatialContext, waterLayerFromBarriers, buildingLayerFromObstacles } from "../engine/src/map/spatial.mjs";
import { stableId, round6 } from "../engine/src/map/ids.mjs";
import { root, readJson, loadPack } from "./lib/pack-spatial.mjs";
import { syntheticLayers } from "./lib/synthetic-layers.mjs";

const GENERATED_BY = "scripts/build-through-handover-examples.mjs";
const args = process.argv.slice(2);
const outFlag = args.indexOf("--out");
const outRoot = outFlag >= 0 ? path.resolve(args[outFlag + 1]) : null;
const only = args.find((a, i) => !a.startsWith("--") && i !== outFlag + 1);

const M_LAT = 111320;
// a point `meters` along a leg's alignment, counted from its start (negative: from its end)
function alongLeg(route, legIndex, meters) {
  const poly = route.legs[legIndex].alignment;
  const kx = M_LAT * Math.cos((poly[0][1] * Math.PI) / 180);
  const seg = poly.slice(1).map((p, i) => Math.hypot((p[0] - poly[i][0]) * kx, (p[1] - poly[i][1]) * M_LAT));
  const total = seg.reduce((s, v) => s + v, 0);
  let at = meters < 0 ? total + meters : meters;
  for (let i = 0; i < seg.length; i++) {
    if (at <= seg[i] || i === seg.length - 1) {
      const t = Math.max(0, Math.min(1, at / seg[i]));
      return [round6(poly[i][0] + (poly[i + 1][0] - poly[i][0]) * t), round6(poly[i][1] + (poly[i + 1][1] - poly[i][1]) * t)];
    }
    at -= seg[i];
  }
  return poly.at(-1);
}
const endOf = (route, legIndex) => route.legs[legIndex].alignment.at(-1);
const startOf = (route, legIndex) => route.legs[legIndex].alignment[0];
const shift = ([lon, lat], dLon, dLat) => [round6(lon + dLon), round6(lat + dLat)];
const rect = ([lon, lat], dLon, dLat) => [[lon - dLon, lat - dLat], [lon + dLon, lat - dLat], [lon + dLon, lat + dLat], [lon - dLon, lat + dLat]];

// the common drawing: a site over handover 0 of the route, designed against the route's current revision
const site = (route, key, name, extra = {}) => ({
  key, name, throughRouteId: route.throughRouteId, handoverId: route.handovers[0].handoverId,
  fromLegId: route.handovers[0].fromLegId, toLegId: route.handovers[0].toLegId, routeGeometryRevision: route.geometryRevision, ...extra,
});
// both legs end at the same station: the points sit there and the connection is that one place
const joinedAtStation = (route, key, name, extra = {}) => {
  const h = endOf(route, 0);
  return site(route, key, name, { fromConnectionPoint: h, toConnectionPoint: h, connectionAlignment: [h], ...extra });
};
// a bypass track from 120 m before the end of the first leg to 120 m after the start of the second, through `via`
const bypass = (route, key, name, via, extra = {}) => {
  const from = alongLeg(route, 0, -120);
  const to = alongLeg(route, 1, 120);
  return site(route, key, name, { fromConnectionPoint: from, toConnectionPoint: to, connectionAlignment: [from, ...via, to], ...extra });
};

const syn = (center, options = {}) => ({ spec: { kind: "synthetic-fixture", generator: "scripts/lib/synthetic-layers.mjs", center, ...options }, layers: () => syntheticLayers(center, options) });

// each example: { file, case[], route (example file name), layers, externalNetworks?, drawn: (route) => drawnSite }
const EXAMPLES = {
  tokyo: (pack) => {
    const [west, south, east, north] = pack.manifest.bbox;
    const inPack = ([x, y]) => x >= west && x <= east && y >= south && y <= north;
    const tracked = {
      spec: { kind: "pack-files", files: ["barriers.json", "obstacles.json"], existingRail: "station-level (external networks)" },
      layers: () => ({
        water: waterLayerFromBarriers(readJson(`${pack.dir}/barriers.json`), { covers: inPack, quality: "medium", source: { name: "国土交通省 国土数値情報 water polygons, packs/tokyo/barriers.json", license: "MLIT-KSJ-terms" } }),
        buildings: buildingLayerFromObstacles(readJson(`${pack.dir}/obstacles.json`), { quality: "high", source: { name: "OpenStreetMap building footprints, packs/tokyo/obstacles.json", license: "ODbL-1.0" } }),
      }),
    };
    return [
      { file: "01-east-river-koto-points-picked-nothing-drawn", case: ["external-connection-unknown"], route: "02-east-river-koto-line-external", layers: tracked, externalNetworks: true,
        drawn: (r) => site(r, "example:tokyo:handover-east-river-koto-picked", "East river end to Koto line: points picked, connection not drawn yet", { fromConnectionPoint: endOf(r, 0), toConnectionPoint: shift(endOf(r, 0), 0.0012, 0) }) },
      { file: "02-east-river-koto-drawn-no-external-alignment", case: ["external-alignment-unknown"], route: "02-east-river-koto-line-external", layers: tracked, externalNetworks: true,
        drawn: (r) => {
          const from = endOf(r, 0);
          // the player's own pick beside their line: no source says where the external track really runs
          const to = shift(from, 0.0012, 0);
          return site(r, "example:tokyo:handover-east-river-koto-drawn", "East river end to Koto line: connection drawn, external track alignment not in the data", {
            fromConnectionPoint: from, toConnectionPoint: to, connectionAlignment: [from, shift(from, 0.0006, -0.0003), to],
            turnoutCandidates: [{ key: "turnout-1", location: from }], workAreas: [{ key: "work-1", polygon: rect(shift(from, 0.0006, 0), 0.0009, 0.0005) }],
          });
        } },
      { file: "03-station-variants-joined", case: ["player-legs-joined"], route: "04-station-variants-split-joined", layers: tracked, externalNetworks: true,
        drawn: (r) => joinedAtStation(r, "example:tokyo:handover-station-variants", "Two legs of one plan meeting at a shared station", { turnoutCandidates: [{ key: "turnout-1", location: endOf(r, 0) }] }) },
    ];
  },
  "example-radial": () => {
    const h = [0.04347, 0.01165];
    const layers = syn(h);
    return [
      { file: "01-spoke-ring-joined-exact", case: ["player-legs-joined"], route: "01-spoke-to-ring-joined", layers,
        drawn: (r) => joinedAtStation(r, "example:radial:handover-joined", "Spoke and ring meet at the third station", {
          turnoutCandidates: [{ key: "turnout-1", location: endOf(r, 0) }], workAreas: [{ key: "work-1", polygon: rect(endOf(r, 0), 0.0004, 0.0003) }] }) },
      { file: "02-spoke-ring-near-not-joined", case: ["near-not-joined"], route: "01-spoke-to-ring-joined", layers,
        drawn: (r) => { const p = endOf(r, 0); return site(r, "example:radial:handover-near", "Connection stops about 22 m short of the ring", { fromConnectionPoint: p, toConnectionPoint: p, connectionAlignment: [p, shift(p, 0.0002, 0)] }); } },
      { file: "03-bypass-through-buildings", case: ["through-buildings"], route: "01-spoke-to-ring-joined", layers: syn(h, { blockedAt: [shift(h, -0.0012, 0.0001)] }),
        drawn: (r) => bypass(r, "example:radial:handover-buildings", "Bypass track through a building", [shift(h, -0.0012, 0.0001)], { turnoutCandidates: [{ key: "turnout-1", location: alongLeg(r, 0, -120) }] }) },
      { file: "04-bypass-crosses-road", case: ["road-crossing"], route: "01-spoke-to-ring-joined", layers,
        drawn: (r) => bypass(r, "example:radial:handover-road", "Bypass track crossing a major road", [], { structureHint: "elevated", workAreas: [{ key: "work-1", polygon: rect(h, 0.0008, 0.0006) }] }) },
      { file: "05-some-layers-missing", case: ["some-layers-missing"], route: "01-spoke-to-ring-joined", layers: syn(h, { only: ["buildings", "dem"] }),
        drawn: (r) => bypass(r, "example:radial:handover-partial-layers", "Bypass with only building and terrain layers available", []) },
      { file: "06-route-revision-stale", case: ["route-revision-stale"], route: "01-spoke-to-ring-joined", layers,
        drawn: (r) => joinedAtStation(r, "example:radial:handover-stale", "Designed before the route was edited", { routeGeometryRevision: stableId("through-route-revision", r.throughRouteId, "before-the-spoke-was-edited") }) },
      { file: "07-ring-stub-separated", case: ["connection-separated"], route: "03-ring-arc-to-transfer-stub-separated", layers: syn([-0.01165, 0.04347]),
        drawn: (r) => { const from = endOf(r, 0); return site(r, "example:radial:handover-separated", "Connection drawn toward a stub that is 5 km away", { fromConnectionPoint: from, toConnectionPoint: startOf(r, 1), connectionAlignment: [from, shift(from, 0.002, -0.001)] }); } },
    ];
  },
  "example-corridor": () => {
    const h = [-0.01, 0];
    return [
      { file: "01-trunk-joined-with-turnout", case: ["player-legs-joined"], route: "01-corridor-trunk-split", layers: syn(h),
        drawn: (r) => joinedAtStation(r, "example:corridor:handover-joined", "Trunk split at its middle station", { turnoutCandidates: [{ key: "turnout-1", location: endOf(r, 0) }] }) },
      { file: "02-bypass-crosses-river", case: ["water-crossing"], route: "01-corridor-trunk-split", layers: syn(h),
        drawn: (r) => bypass(r, "example:corridor:handover-river", "Passing loop that dips across the river", [shift(h, -0.0027, -0.005), shift(h, 0.0027, -0.005)], { structureHint: "bridge" }) },
    ];
  },
};

for (const id of Object.keys(EXAMPLES).filter((k) => !only || k === only)) {
  const pack = loadPack(id);
  const plans = fs.readdirSync(path.join(root, pack.dir, "plan-examples")).filter((f) => f.endsWith(".plan.json")).sort().map((f) => readJson(`${pack.dir}/plan-examples/${f}`));
  const externalNetworks = pack.existingNetwork ? [existingNetworkToExternal(pack)] : [];
  const outDir = outRoot ? path.join(outRoot, id) : path.join(root, pack.dir, "through-handover-examples");
  fs.mkdirSync(outDir, { recursive: true });
  for (const ex of EXAMPLES[id](pack)) {
    const { source: _drop, ...route } = readJson(`${pack.dir}/through-route-examples/${ex.route}.through-route.json`);
    const drawn = ex.drawn(route);
    const out = buildThroughHandoverSite(drawn, { pack, route, plans, externalNetworks: ex.externalNetworks ? externalNetworks : [], spatial: makeSpatialContext(ex.layers.layers()) });
    if (!out.site) throw new Error(`${id}/${ex.file} was rejected: ${JSON.stringify(out.warnings)}`);
    const body = { ...out.site, source: { case: ex.case, routeExample: ex.route, layers: ex.layers.spec, existingRail: Boolean(ex.externalNetworks), drawnSite: drawn, generatedBy: GENERATED_BY } };
    fs.writeFileSync(path.join(outDir, `${ex.file}.handover-site.json`), `${JSON.stringify(body, null, 2)}\n`);
    const s = out.site;
    console.log(`[${id}] ${ex.file}: connected=${s.physicalConnectionEvidence.connected} reason=${s.physicalConnectionEvidence.reason} gap=${s.endpointGapMeters} len=${s.connectionLengthMeters} bldg=${s.buildingIntersectionCount} water=${s.waterCrossingCount} road=${s.roadCrossingCount} rail=${s.existingRailwayCrossingCount} slope=${s.averageSlopePercent} q=${s.dataQuality} radius=${s.minimumCurveRadiusMeters} structure=${s.structureHint} flags=[${s.spatialFlags}] unknown=${s.unknown.length} warn=${out.warnings.map((w) => w.code)}`);
  }
}
