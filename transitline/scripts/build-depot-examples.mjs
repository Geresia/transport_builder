// Dev-time generator for the DepotSiteGeometry examples in packs/<id>/depot-examples/.
//   node scripts/build-depot-examples.mjs [packId]
//
// Each example connects to a plan in packs/<id>/plan-examples/ (its real planId / segment id), so the
// two sets of examples stay consistent. Tokyo layers are decoded from the pack's own vector tiles
// (needs: npm i --no-save pmtiles @mapbox/vector-tile pbf) plus the local DEM / roads. A layer that
// cannot be loaded is skipped and its fields come out unknown (null); the layer summary is printed.
import fs from "node:fs";
import path from "node:path";
import { existingNetworkToExternal } from "../engine/src/map/plan-geometry.mjs";
import { buildDepotExport } from "../engine/src/map/depot-site.mjs";
import { makeSpatialContext } from "../engine/src/map/spatial.mjs";
import { root, readJson, loadPack, tokyoSpatial, tokyoDepotLayers } from "./lib/pack-spatial.mjs";

const planExamples = (pack) => {
  const dir = path.join(root, pack.dir, "plan-examples");
  return fs.readdirSync(dir).filter((f) => f.endsWith(".plan.json")).sort().map((f) => readJson(`${pack.dir}/plan-examples/${f}`));
};
const byName = (plans, suffix) => plans.find((p) => p.source.drawnLine.key.endsWith(suffix));
const lastSegment = (plan) => plan.segments.at(-1).id;
const pointOf = (pack, id) => pack.demand.points.find((p) => p.id === id).location;
const rect = ([lon, lat], dLon, dLat, w, h) => [[lon + dLon, lat + dLat], [lon + dLon + w, lat + dLat], [lon + dLon + w, lat + dLat + h], [lon + dLon, lat + dLat + h]];

// planar polygon area (m2) around its own latitude, to pick the biggest rail parcel
function areaM2(ring) {
  const kx = 111320 * Math.cos((ring[0][1] * Math.PI) / 180);
  const xy = ring.map(([lon, lat]) => [lon * kx, lat * 111320]);
  return Math.abs(xy.reduce((s, p, i) => s + (p[0] * xy[(i + 1) % xy.length][1] - xy[(i + 1) % xy.length][0] * p[1]), 0)) / 2;
}
const centroid = (ring) => [ring.reduce((s, p) => s + p[0], 0) / ring.length, ring.reduce((s, p) => s + p[1], 0) / ring.length];
const inset = (ring, k) => { const c = centroid(ring); return ring.map(([x, y]) => [c[0] + (x - c[0]) * k, c[1] + (y - c[1]) * k]); };
const bboxAround = (points, m) => {
  const d = m / 111320;
  return [Math.min(...points.map((p) => p[0])) - d * 1.25, Math.min(...points.map((p) => p[1])) - d, Math.max(...points.map((p) => p[0])) + d * 1.25, Math.max(...points.map((p) => p[1])) + d];
};

const SEARCH_M = 2600; // residential search 2000 m + margin

// each example: { file, mode, drawn, layers?: () => layers }
const EXAMPLES = {
  tokyo: async (pack, plans) => {
    const base = tokyoSpatial(pack).layers;
    // depots do not read land use: leave that layer out so it is not listed as a source of the depot facts
    const layersAt = async (points) => { const layers = await tokyoDepotLayers(pack, bboxAround(points, SEARCH_M), base); delete layers.landuse; return layers; };

    // A: the biggest real landuse=railway parcel near Ota, inset so the parcel lies inside that rail land
    const ota = pointOf(pack, "ward-ota");
    const around = await tokyoDepotLayers(pack, bboxAround([ota], 6000), {});
    const parcel = around.railFacilities.items
      .filter((it) => Math.hypot((centroid(it.rings[0])[0] - ota[0]) * 91000, (centroid(it.rings[0])[1] - ota[1]) * 111320) < 6000)
      .sort((a, b) => areaM2(b.rings[0]) - areaM2(a.rings[0]) || a.rings[0][0][0] - b.rings[0][0][0])[0];
    const parcelRing = inset(parcel.rings[0].slice(0, -1), 0.8);

    const p01 = byName(plans, "bay-ward-spine");
    const p02 = byName(plans, "east-river-crossing");
    const p03 = byName(plans, "tama-hills");
    const p04 = byName(plans, "shinjuku-free-placed");
    const edogawa = pointOf(pack, "ward-edogawa");
    const hachioji = pointOf(pack, "kanto-13201");
    const koto = pointOf(pack, "ward-koto");
    const shinjukuEnd = p04.stationCandidates.at(-1).location;
    const kotoLine = readJson(`${pack.dir}/existing-network.json`).lines.filter((l) => l.stationIds.includes("ward-koto") && l.osmRelationId !== undefined).sort((a, b) => a.osmRelationId - b.osmRelationId)[0];

    return [
      { file: "01-ota-railway-land-existing", mode: "existing", layers: () => layersAt(parcelRing), drawn: {
        key: "example:tokyo:depot-ota-rail-land", name: "Ota rail-land parcel (OSM landuse=railway, inset 80%)", polygon: parcelRing, connect: { planId: p01.planId } } },
      { file: "02-edogawa-waterfront-existing", mode: "existing", layers: () => layersAt(rect(edogawa, 0.005, -0.0055, 0.005, 0.0027)), drawn: {
        key: "example:tokyo:depot-edogawa-waterfront", name: "Edogawa waterfront candidate", polygon: rect(edogawa, 0.005, -0.0055, 0.005, 0.0027),
        connect: { planId: p02.planId, segmentId: lastSegment(p02), via: [[edogawa[0] + 0.004, edogawa[1] - 0.0025]] } } },
      { file: "03-hachioji-foothills-scratch", mode: "scratch", layers: () => layersAt(rect(hachioji, 0.004, -0.003, 0.0033, 0.0023)), drawn: {
        key: "example:tokyo:depot-hachioji-foothills", name: "Hachioji foothills candidate", polygon: rect(hachioji, 0.004, -0.003, 0.0033, 0.0023), connect: { planId: p03.planId } } },
      { file: "04-shinjuku-point-scratch", mode: "scratch", layers: () => layersAt([shinjukuEnd]), drawn: {
        key: "example:tokyo:depot-shinjuku-point", name: "Shinjuku point candidate", location: [shinjukuEnd[0] + 0.003, shinjukuEnd[1] - 0.002], connect: { planId: p04.planId } } },
      { file: "05-koto-existing-line-existing", mode: "existing", layers: () => layersAt(rect(koto, 0.004, -0.008, 0.005, 0.003)), drawn: {
        key: "example:tokyo:depot-koto-existing-line", name: "Koto candidate on an existing line", polygon: rect(koto, 0.004, -0.008, 0.005, 0.003),
        connect: { externalLineId: `ext-line:${kotoLine.osmRelationId}` } } },
    ];
  },
  "example-radial": async (pack, plans) => {
    const o1 = pointOf(pack, "outer-1");
    const m2 = pointOf(pack, "mid-2");
    const o7 = pointOf(pack, "outer-7");
    const p01 = byName(plans, "spoke");
    const p02 = byName(plans, "ring-arc");
    const p03 = byName(plans, "cross-city");
    return [
      { file: "01-outer-spoke-yard", mode: "scratch", drawn: { key: "example:radial:depot-outer-spoke", name: "Yard beside the outer spoke terminal", polygon: rect(o1, 0.004, -0.006, 0.006, 0.004), connect: { planId: p01.planId } } },
      { file: "02-ring-point", mode: "scratch", drawn: { key: "example:radial:depot-ring-point", name: "Point candidate off the ring arc", location: [m2[0] + 0.004, m2[1] + 0.003], connect: { planId: p02.planId } } },
      { file: "03-cross-city-with-waypoint", mode: "scratch", drawn: { key: "example:radial:depot-cross-city", name: "Cross-city yard with a routed connection", polygon: rect(o7, -0.012, 0.004, 0.006, 0.004),
        connect: { planId: p03.planId, segmentId: lastSegment(p03), via: [[o7[0] - 0.004, o7[1] + 0.001]] } } },
    ];
  },
  "example-corridor": async (pack, plans) => {
    const start = pack.demand.points[0].location;
    return [{ file: "01-corridor-yard", mode: "scratch", drawn: { key: "example:corridor:depot-yard", name: "Corridor yard", polygon: rect(start, 0.002, -0.006, 0.008, 0.004), connect: { planId: plans[0].planId } } }];
  },
};

const only = process.argv[2];
for (const id of Object.keys(EXAMPLES).filter((k) => !only || k === only)) {
  const pack = loadPack(id);
  const plans = planExamples(pack);
  const outDir = path.join(root, pack.dir, "depot-examples");
  fs.mkdirSync(outDir, { recursive: true });
  for (const ex of await EXAMPLES[id](pack, plans)) {
    const layers = ex.layers ? await ex.layers() : null;
    const spatial = makeSpatialContext(layers ?? {});
    const mapExport = { plans, externalNetworks: ex.mode === "existing" && pack.existingNetwork ? [existingNetworkToExternal(pack)] : [] };
    const out = buildDepotExport({ pack, mapExport, depots: [ex.drawn], spatial });
    const site = { ...out.sites[0], source: { drawnSite: ex.drawn, requestedMode: ex.mode, generatedBy: "scripts/build-depot-examples.mjs" } };
    fs.writeFileSync(path.join(outDir, `${ex.file}.depot.json`), `${JSON.stringify(site, null, 2)}\n`);
    console.log(`[${id}] ${ex.file}: ${site.depotSiteId} q=${site.dataQuality} area=${site.areaSquareMeters} conn=${site.connectionTrackLengthMeters}m slope=${site.averageSlopePercent}% bldg=${site.intersectedBuildingCount} res=${site.distanceToResidentialMeters} dens=${site.surroundingBuildingDensity} reuse=${site.existingFacilityReuse?.status ?? null} flags=[${site.spatialFlags}] unknown=[${site.unknown}]`);
  }
}
