// Dev-time generator for the rail capacity geometry examples in packs/<id>/rail-capacity-examples/.
//   node scripts/build-rail-capacity-examples.mjs [packId] [--out <dir>]   (npm run rail-capacity-examples)
// With --out the files go to <dir>/<packId>/ instead of the pack (the tests use that to check byte-for-byte regeneration).
//
// Each example is a rail design over real plan examples of the same pack (packs/<id>/plan-examples/). No pack states
// single / double track, signals, block boundaries, junctions or terminals, so every such fact here is what the example's
// "player" states and is labelled so (basis "player"). The synthetic packs use generated stand-in layers
// (scripts/lib/synthetic-layers.mjs, labelled synthetic-fixture); Tokyo uses only the pack's own tracked files
// (barriers.json water, obstacles.json building footprints, and the coarse station-level existing rail), so the output
// does not depend on any local, git-ignored data. No clock or RNG is involved.
import fs from "node:fs";
import path from "node:path";
import { existingNetworkToExternal } from "../engine/src/map/plan-geometry.mjs";
import { buildRailGeometry, planRevisionOf } from "../engine/src/map/rail-capacity-geometry.mjs";
import { makeSpatialContext, waterLayerFromBarriers, buildingLayerFromObstacles } from "../engine/src/map/spatial.mjs";
import { stableId } from "../engine/src/map/ids.mjs";
import { root, readJson, loadPack } from "./lib/pack-spatial.mjs";
import { syntheticLayers } from "./lib/synthetic-layers.mjs";

const GENERATED_BY = "scripts/build-rail-capacity-examples.mjs";
const args = process.argv.slice(2);
const outFlag = args.indexOf("--out");
const outRoot = outFlag >= 0 ? path.resolve(args[outFlag + 1]) : null;
const only = args.find((a, i) => !a.startsWith("--") && i !== outFlag + 1);

const byName = (plans, suffix) => plans.find((p) => p.source.drawnLine.key.endsWith(suffix));
const ref = (plan, i) => ({ planId: plan.planId, segmentId: plan.segments[i].id });
const recorded = (...plans) => ({ plans: Object.fromEntries(plans.map((p) => [p.planId, planRevisionOf(p)])), routes: {} });
const player = (plan, i, fact) => ({ ref: ref(plan, i), basis: "player", ...fact });
const boundary = (key, plan, i, from, alongMeters) => ({ key, planId: plan.planId, segmentId: plan.segments[i].id, measuredFromStationId: from === "from" ? plan.segments[i].from : plan.segments[i].to, alongMeters, basis: "player" });
const syn = (center, options = {}) => ({ spec: { kind: "synthetic-fixture", generator: "scripts/lib/synthetic-layers.mjs", center, ...options }, layers: () => syntheticLayers(center, options) });

// each example: { file, case[], layers, externalNetworks?, routeExample?, drawn: (plans, { route }) => design }
const EXAMPLES = {
  "example-radial": () => {
    const H = [0.04347, 0.01165];
    const layers = syn(H);
    const spoke = (p) => byName(p, "spoke");
    return [
      { file: "01-double-track-section", case: ["double-track"], layers,
        drawn: (p) => ({ key: "example:radial:rail-double", name: "Spoke with its middle section stated double track", planIds: [spoke(p).planId], designedRevisions: recorded(spoke(p)),
          sectionFacts: [player(spoke(p), 1, { directionMode: "double", designedGradientPermille: 25 })] }) },
      { file: "02-single-track-section", case: ["single-track"], layers,
        drawn: (p) => ({ key: "example:radial:rail-single", name: "Spoke with its last section stated single track", planIds: [spoke(p).planId], designedRevisions: recorded(spoke(p)),
          sectionFacts: [player(spoke(p), 2, { directionMode: "single" })] }) },
      { file: "03-multiple-blocks-in-one-section", case: ["multiple-blocks"], layers,
        drawn: (p) => ({ key: "example:radial:rail-blocks", name: "One 3.7 km section split into three blocks", planIds: [spoke(p).planId], designedRevisions: recorded(spoke(p)),
          sectionFacts: [player(spoke(p), 2, { directionMode: "double" })],
          blockBoundaries: [boundary("boundary-1", spoke(p), 2, "from", 1200), boundary("boundary-2", spoke(p), 2, "to", 900)] }) },
      { file: "04-shared-turnout", case: ["shared-turnout"], layers,
        drawn: (p) => {
          const sp = spoke(p);
          const ring = byName(p, "ring-arc");
          return { key: "example:radial:rail-turnout", name: "Spoke and ring arc share a turnout at the third station", planIds: [sp.planId, ring.planId], designedRevisions: recorded(sp, ring),
            sectionFacts: [player(sp, 1, { directionMode: "double" }), player(sp, 2, { directionMode: "double" }), player(ring, 0, { directionMode: "single" })],
            blockBoundaries: [],
            junctions: [{ key: "turnout-1", kind: "turnout", location: H, connections: [{ ...ref(sp, 1), role: "stem" }, { ...ref(sp, 2), role: "main" }, { ...ref(ring, 0), role: "branch" }] }] };
        } },
      { file: "05-flat-crossing", case: ["flat-crossing"], layers: syn([0, 0]),
        drawn: (p) => {
          const cross = byName(p, "cross-city");
          const variants = byName(p, "station-variants");
          return { key: "example:radial:rail-crossing", name: "Cross-city line crossing the east-west line at the centre station", planIds: [cross.planId, variants.planId], designedRevisions: recorded(cross, variants),
            junctions: [{ key: "crossing-1", kind: "crossing", location: [0, 0], connections: [{ ...ref(cross, 0), role: "a1" }, { ...ref(cross, 1), role: "a2" }, { ...ref(variants, 1), role: "b1" }, { ...ref(variants, 2), role: "b2" }] }] };
        } },
      { file: "06-no-signal-or-block-data", case: ["no-signal-or-block-data"], layers,
        drawn: (p) => ({ key: "example:radial:rail-bare", name: "Spoke with no track count, block, junction or terminal data", planIds: [spoke(p).planId], designedRevisions: recorded(spoke(p)) }) },
      { file: "07-some-layers-missing", case: ["some-layers-missing"], layers: syn(H, { only: ["buildings", "dem"] }),
        drawn: (p) => ({ key: "example:radial:rail-partial-layers", name: "Spoke measured with only building and terrain layers", planIds: [spoke(p).planId], designedRevisions: recorded(spoke(p)),
          blockBoundaries: [boundary("boundary-1", spoke(p), 1, "from", 1400)] }) },
      { file: "08-revision-stale", case: ["revision-stale"], layers,
        drawn: (p) => {
          const sp = spoke(p);
          const ring = byName(p, "ring-arc");
          return { key: "example:radial:rail-stale", name: "Turnout designed before the ring arc was edited", planIds: [sp.planId, ring.planId],
            designedRevisions: { plans: { [sp.planId]: planRevisionOf(sp), [ring.planId]: stableId("plan-revision", ring.planId, "before-the-arc-was-edited") }, routes: {} },
            blockBoundaries: [boundary("boundary-1", sp, 1, "from", 1400)],
            junctions: [{ key: "turnout-1", kind: "turnout", location: H, connections: [{ ...ref(sp, 1), role: "stem" }, { ...ref(sp, 2), role: "main" }, { ...ref(ring, 0), role: "branch" }] }] };
        } },
    ];
  },
  "example-corridor": () => {
    const layers = syn([0, 0]);
    const trunk = (p) => p[0];
    return [
      { file: "01-terminal-two-platforms-with-turnback", case: ["terminal-two-platforms", "turnback-track"], layers,
        drawn: (p) => {
          const t = trunk(p);
          return { key: "example:corridor:rail-terminal", name: "East terminal with two platform tracks, a stabling track and a pull-out track", planIds: [t.planId], designedRevisions: recorded(t),
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
        } },
      { file: "02-bare-sections", case: ["no-signal-or-block-data"], layers,
        drawn: (p) => ({ key: "example:corridor:rail-bare", name: "Trunk with no track count, block, junction or terminal data", planIds: [trunk(p).planId], designedRevisions: recorded(trunk(p)) }) },
      { file: "03-single-track-with-blocks", case: ["single-track", "multiple-blocks"], layers,
        drawn: (p) => ({ key: "example:corridor:rail-single-blocks", name: "Single-track middle section split into three blocks", planIds: [trunk(p).planId], designedRevisions: recorded(trunk(p)),
          sectionFacts: [player(trunk(p), 1, { directionMode: "single" })],
          blockBoundaries: [boundary("boundary-1", trunk(p), 1, "from", 800), boundary("boundary-2", trunk(p), 1, "from", 1500)] }) },
    ];
  },
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
    const kotoLine = readJson(`${pack.dir}/existing-network.json`).lines.filter((l) => l.stationIds.includes("ward-koto") && l.osmRelationId !== undefined).sort((a, b) => a.osmRelationId - b.osmRelationId)[0];
    return [
      { file: "01-existing-line-through-route", case: ["no-signal-or-block-data", "external-alignment-unknown"], layers: tracked, externalNetworks: true, routeExample: "02-east-river-koto-line-external",
        drawn: (p, { route }) => {
          const plan = byName(p, "east-river-crossing");
          return { key: "example:tokyo:rail-existing-line", name: "East river crossing joined to an existing Koto line (station level only)", planIds: [plan.planId], externalLineIds: [`ext-line:${kotoLine.osmRelationId}`],
            throughRouteId: route.throughRouteId, designedRevisions: { ...recorded(plan), routes: { [route.throughRouteId]: route.geometryRevision } },
            sectionFacts: [player(plan, 1, { directionMode: "double" })] };
        } },
      { file: "02-station-variants-blocks", case: ["multiple-blocks", "double-track"], layers: tracked, externalNetworks: true,
        drawn: (p) => {
          const plan = byName(p, "station-variants");
          return { key: "example:tokyo:rail-station-variants", name: "Station variants line, double track with a block boundary", planIds: [plan.planId], designedRevisions: recorded(plan),
            sectionFacts: [player(plan, 2, { directionMode: "double" }), player(plan, 3, { directionMode: "double" })],
            blockBoundaries: [boundary("boundary-1", plan, 3, "from", 2000)] };
        } },
      { file: "03-bay-spine-single", case: ["single-track", "some-layers-missing"], layers: { spec: { kind: "none" }, layers: () => ({}) },
        drawn: (p) => {
          const plan = byName(p, "bay-ward-spine");
          return { key: "example:tokyo:rail-bay-spine", name: "Bay ward spine, single track, no spatial layers loaded", planIds: [plan.planId], designedRevisions: recorded(plan), sectionFacts: [player(plan, 0, { directionMode: "single" })] };
        } },
    ];
  },
};

for (const id of Object.keys(EXAMPLES).filter((k) => !only || k === only)) {
  const pack = loadPack(id);
  const plans = fs.readdirSync(path.join(root, pack.dir, "plan-examples")).filter((f) => f.endsWith(".plan.json")).sort().map((f) => readJson(`${pack.dir}/plan-examples/${f}`));
  const externalNetworks = pack.existingNetwork ? [existingNetworkToExternal(pack)] : [];
  const outDir = outRoot ? path.join(outRoot, id) : path.join(root, pack.dir, "rail-capacity-examples");
  fs.mkdirSync(outDir, { recursive: true });
  for (const ex of EXAMPLES[id](pack)) {
    let route = null;
    if (ex.routeExample) { const { source: _drop, ...r } = readJson(`${pack.dir}/through-route-examples/${ex.routeExample}.through-route.json`); route = r; }
    const drawn = ex.drawn(plans, { route });
    const out = buildRailGeometry(drawn, { pack, plans, externalNetworks: ex.externalNetworks ? externalNetworks : [], routes: route ? [route] : [], spatial: makeSpatialContext(ex.layers.layers()) });
    if (!out.design) throw new Error(`${id}/${ex.file} was rejected: ${JSON.stringify(out.warnings)}`);
    const body = { ...out.design, source: { case: ex.case, layers: ex.layers.spec, existingRail: Boolean(ex.externalNetworks), throughRouteExample: ex.routeExample ?? null, drawnDesign: drawn, generatedBy: GENERATED_BY } };
    fs.writeFileSync(path.join(outDir, `${ex.file}.rail-capacity.json`), `${JSON.stringify(body, null, 2)}\n`);
    const d = out.design;
    console.log(`[${id}] ${ex.file}: sections=${d.sections.length} modes=[${d.sections.map((s) => s.directionMode ?? "-")}] blocks=${d.blocks?.length ?? null} signals=${d.signalCandidates?.length ?? null} junctions=${d.junctions?.map((j) => `${j.kind}:${j.attachedToAllSections}:${j.routeCombinations.map((c) => c.conflictsWith?.length ?? null)}`) ?? null} terminals=${d.terminals?.map((t) => `p${t.platformCandidates?.map((q) => q.connected)}/t${t.turnbackCandidates?.map((q) => q.attached)}`) ?? null} rev=${d.revision.state} flags=[${d.spatialFlags}] unknown=${d.unknown.length} warn=${out.warnings.map((w) => w.code)}`);
  }
}
