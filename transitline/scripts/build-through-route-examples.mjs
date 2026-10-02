// Dev-time generator for the ThroughRouteGeometry examples in packs/<id>/through-route-examples/.
//   node scripts/build-through-route-examples.mjs [packId]      (npm run through-route-examples)
//
// Each example runs over plans in packs/<id>/plan-examples/ (their real planId / station ids) and, for Tokyo,
// over a real line of the pack's existing network, so the example sets stay consistent. No spatial layers,
// clock or RNG are involved: re-running the script rewrites every file byte for byte.
import fs from "node:fs";
import path from "node:path";
import { existingNetworkToExternal } from "../engine/src/map/plan-geometry.mjs";
import { buildThroughRouteExport } from "../engine/src/map/through-route.mjs";
import { root, readJson, loadPack } from "./lib/pack-spatial.mjs";

const planExamples = (pack) => {
  const dir = path.join(root, pack.dir, "plan-examples");
  return fs.readdirSync(dir).filter((f) => f.endsWith(".plan.json")).sort().map((f) => readJson(`${pack.dir}/plan-examples/${f}`));
};
const byName = (plans, suffix) => plans.find((p) => p.source.drawnLine.key.endsWith(suffix));
const ids = (plan) => plan.stationCandidates.map((s) => s.id);
const planned = (plan, extra = {}) => ({ sourceKind: "planned", planId: plan.planId, ...extra });
const external = (lineId, extra = {}) => ({ sourceKind: "external", externalLineId: lineId, ...extra });

// each example: { file, drawn }. Owners are left out on purpose: no source in these packs states who owns the track.
const EXAMPLES = {
  tokyo: (pack, plans) => {
    const p01 = byName(plans, "bay-ward-spine");
    const p02 = byName(plans, "east-river-crossing");
    const p04 = byName(plans, "shinjuku-free-placed");
    const p05 = byName(plans, "station-variants");
    const kotoLine = readJson(`${pack.dir}/existing-network.json`).lines
      .filter((l) => l.stationIds.includes("ward-koto") && l.osmRelationId !== undefined)
      .sort((a, b) => a.osmRelationId - b.osmRelationId)[0];
    const koto = `ext-line:${kotoLine.osmRelationId}`;
    const s05 = ids(p05);
    return [
      { file: "01-bay-spine-east-river-separated", drawn: { key: "example:tokyo:through-bay-spine-east-river", name: "Bay ward spine, then East river crossing (ends far apart)", legs: [planned(p01), planned(p02)] } },
      { file: "02-east-river-koto-line-external", drawn: { key: "example:tokyo:through-east-river-koto", name: "East river crossing onto an existing Koto line", legs: [planned(p02), external(koto)] } },
      { file: "03-east-river-koto-shinjuku-three-legs", drawn: { key: "example:tokyo:through-east-river-koto-shinjuku", name: "Planned, existing, planned (legs listed out of order, sequence is explicit)", legs: [planned(p04, { sequence: 2 }), planned(p02, { sequence: 0 }), external(koto, { sequence: 1 })] } },
      { file: "04-station-variants-split-joined", drawn: { key: "example:tokyo:through-station-variants-split", name: "One plan run as two legs that meet at a shared station", legs: [planned(p05, { fromStationId: s05[0], toStationId: s05[3] }), planned(p05, { fromStationId: s05[3], toStationId: s05[5] })] } },
    ];
  },
  "example-radial": (pack, plans) => {
    const spoke = byName(plans, "spoke");
    const ring = byName(plans, "ring-arc");
    const cross = byName(plans, "cross-city");
    const stub = byName(plans, "transfer-stub");
    return [
      { file: "01-spoke-to-ring-joined", drawn: { key: "example:radial:through-spoke-ring", name: "Spoke to its third station, then the ring arc from that station", legs: [planned(spoke, { fromStationId: ids(spoke)[0], toStationId: ids(spoke)[2] }), planned(ring)] } },
      { file: "02-spoke-to-cross-city-joined", drawn: { key: "example:radial:through-spoke-cross-city", name: "Spoke end to cross-city start (legs listed out of order)", legs: [planned(cross, { sequence: 1 }), planned(spoke, { sequence: 0 })] } },
      { file: "03-ring-arc-to-transfer-stub-separated", drawn: { key: "example:radial:through-ring-stub", name: "Ring arc end and transfer stub start do not meet", legs: [planned(ring), planned(stub)] } },
    ];
  },
  "example-corridor": (pack, plans) => {
    const trunk = plans[0];
    const s = ids(trunk);
    return [{ file: "01-corridor-trunk-split", drawn: { key: "example:corridor:through-trunk-split", name: "Corridor trunk run as two legs", legs: [planned(trunk, { fromStationId: s[0], toStationId: s[2] }), planned(trunk, { fromStationId: s[2], toStationId: s[3] })] } }];
  },
};

const only = process.argv[2];
for (const id of Object.keys(EXAMPLES).filter((k) => !only || k === only)) {
  const pack = loadPack(id);
  const plans = planExamples(pack);
  const externalNetworks = pack.existingNetwork ? [existingNetworkToExternal(pack)] : [];
  const outDir = path.join(root, pack.dir, "through-route-examples");
  fs.mkdirSync(outDir, { recursive: true });
  for (const ex of EXAMPLES[id](pack, plans)) {
    const out = buildThroughRouteExport({ pack, mapExport: { plans, externalNetworks }, routes: [ex.drawn] });
    if (out.routes.length !== 1) throw new Error(`${id}/${ex.file} was rejected: ${JSON.stringify(out.warnings)}`);
    const route = { ...out.routes[0], source: { drawnRoute: ex.drawn, generatedBy: "scripts/build-through-route-examples.mjs" } };
    fs.writeFileSync(path.join(outDir, `${ex.file}.through-route.json`), `${JSON.stringify(route, null, 2)}\n`);
    console.log(`[${id}] ${ex.file}: ${route.throughRouteId} q=${route.dataQuality} legs=${route.legs.map((l) => l.sourceKind).join(">")} connection=[${route.handovers.map((h) => h.physicalConnection)}] length=${route.totalLengthMeters} unknown=${route.unknown.length}`);
  }
}
