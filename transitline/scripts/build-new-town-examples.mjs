// Dev-time generator for the new-town development examples in packs/<id>/new-town-development-examples/.
//   node scripts/build-new-town-examples.mjs [packId] [--out <dir>]   (npm run new-town-examples)
// With --out the files go to <dir>/<packId>/ instead of the pack (the tests use that to check byte-for-byte regeneration).
//
// Each example is a development the player drew with the editor (engine/src/map/new-town-development-editor.mjs), saved and
// restored, over the real plan examples of the same pack (packs/<id>/plan-examples/).  Layers: Tokyo reads only the water
// polygons of its committed barriers.json (no local DEM, roads or tiles, so every machine gets the same bytes); the synthetic
// packs read none, except the first radial example, whose pond and road are written by hand and say so in `sourceLayers`.
// Where a layer is missing the fact is null with its reason.  Nothing here counts people, homes, jobs or demand, and no
// land use, delivery order or station site says that anything can be built, filled or served.  No clock or RNG is involved.
import fs from "node:fs";
import path from "node:path";
import { existingNetworkToExternal } from "../engine/src/map/plan-geometry.mjs";
import { buildNewTownDevelopmentExport } from "../engine/src/map/new-town-development.mjs";
import {
  addDevelopment, addPhase, deactivatePhase, drawnDevelopmentsOf, newNewTownDoc, removePhase, reorderPhase, restoreNewTownDoc, serializeNewTownDoc, setRailRefs, setStationRefs, updatePhase,
} from "../engine/src/map/new-town-development-editor.mjs";
import { makeSpatialContext, roadLayerFromGeojson, waterLayerFromBarriers } from "../engine/src/map/spatial.mjs";
import { root, readJson, exists, loadPack } from "./lib/pack-spatial.mjs";

const GENERATED_BY = "scripts/build-new-town-examples.mjs";
const NOTE = "The development is what a player might draw with the editor over the real plan examples of this pack. A land use, a delivery order or a station site is what the player declared, not a statement that anything can be built, filled or served. A distance to a line, station or road is a distance, not a connection.";
const args = process.argv.slice(2);
const outFlag = args.indexOf("--out");
const outRoot = outFlag >= 0 ? path.resolve(args[outFlag + 1]) : null;
const only = args.find((a, i) => !a.startsWith("--") && !(outFlag >= 0 && i === outFlag + 1));

const planExamples = (pack) => {
  const dir = path.join(root, pack.dir, "plan-examples");
  return fs.readdirSync(dir).filter((f) => f.endsWith(".plan.json")).sort().map((f) => readJson(`${pack.dir}/plan-examples/${f}`));
};
const byName = (plans, suffix) => plans.find((p) => p.source.drawnLine.key.endsWith(suffix));
const pointOf = (pack, id) => pack.demand.points.find((p) => p.id === id).location;
const rect = ([lon, lat], dLon, dLat, w, h) => [[lon + dLon, lat + dLat], [lon + dLon + w, lat + dLat], [lon + dLon + w, lat + dLat + h], [lon + dLon, lat + dLat + h]];
const around = ([lon, lat], w, h) => rect([lon - w / 2, lat - h / 2], 0, 0, w, h);
const lastStation = (plan) => plan.stationCandidates.at(-1);
const segmentRef = (plan, i = -1) => ({ planId: plan.planId, segmentId: plan.segments.at(i).id });

// hand-written layers of the first radial example (synthetic: they say so)
const SYNTHETIC = { license: "CC0-1.0" };
const syntheticLayers = (o) => ({
  water: waterLayerFromBarriers({ barriers: [{ kind: "water", polygon: [rect(o, 0.0125, -0.0065, 0.004, 0.0035)] }] }, { quality: "low", source: { name: "Synthetic example pond (hand-written for this example)", ...SYNTHETIC } }),
  roads: roadLayerFromGeojson({ features: [{ geometry: { coordinates: [[o[0] + 0.006, o[1] - 0.008], [o[0] + 0.007, o[1] + 0.001]] }, properties: { roadClass: "major" } }] }, { quality: "low", source: { name: "Synthetic example road (hand-written for this example)", ...SYNTHETIC } }),
});

// Tokyo: only the water polygons of the committed barriers.json (the same layer the plan examples read), nothing local
function tokyoWater(pack) {
  if (!exists(`${pack.dir}/barriers.json`)) return {};
  const [w, s, e, n] = pack.manifest.bbox;
  return { water: waterLayerFromBarriers(readJson(`${pack.dir}/barriers.json`), {
    covers: ([x, y]) => x >= w && x <= e && y >= s && y <= n, quality: "medium",
    source: { name: "国土交通省 国土数値情報 water polygons (via smartnews-smri/japan-topography), packs/tokyo/barriers.json", license: "MLIT-KSJ-terms" },
  }) };
}

// each example: { file, mode, layers?: layers, author: (doc) => the development key }
const EXAMPLES = {
  tokyo: (pack, plans) => {
    const edogawa = pointOf(pack, "ward-edogawa");
    const hachioji = pointOf(pack, "kanto-13201");
    const koto = pointOf(pack, "ward-koto");
    const p02 = byName(plans, "east-river-crossing");
    const p03 = byName(plans, "tama-hills");
    const kotoLine = readJson(`${pack.dir}/existing-network.json`).lines.filter((l) => l.stationIds.includes("ward-koto") && l.osmRelationId !== undefined).sort((a, b) => a.osmRelationId - b.osmRelationId)[0];
    const layers = tokyoWater(pack);
    return [
      { file: "01-edogawa-bayside-two-phases", mode: "existing", layers, author: (doc) => {
        const key = "example:tokyo:new-town-edogawa-bayside";
        addDevelopment(doc, { key, name: "Edogawa bayside district (example drawing)" });
        addPhase(doc, key, { name: "Housing first", polygon: rect(edogawa, 0.004, -0.0065, 0.008, 0.0045), playerDeclaredLandUse: "housing", playerDeclaredDeliveryOrder: 1, stationRefs: [], railRefs: [segmentRef(p02)] });
        addPhase(doc, key, { name: "Waterfront open space", polygon: rect(edogawa, 0.004, -0.0105, 0.008, 0.0038), playerDeclaredLandUse: "public-space", playerDeclaredDeliveryOrder: 2 });
        return key;
      } },
      { file: "02-hachioji-foothills-mixed", mode: "existing", layers, author: (doc) => {
        const key = "example:tokyo:new-town-hachioji-foothills";
        addDevelopment(doc, { key, name: "Hachioji foothills district (example drawing)" });
        addPhase(doc, key, { name: "Core", polygon: rect(hachioji, 0.004, -0.003, 0.006, 0.004), playerDeclaredLandUse: "mixed", playerDeclaredDeliveryOrder: 1, stationRefs: [{ stationId: lastStation(p03).id, stationKind: "plan" }] });
        addPhase(doc, key, { name: "Later extension", polygon: rect(hachioji, 0.011, -0.003, 0.006, 0.004), playerDeclaredLandUse: "housing", playerDeclaredDeliveryOrder: 3 });
        return key;
      } },
      { file: "03-koto-reclaimed-land-beside-an-existing-line", mode: "existing", layers, author: (doc) => {
        const key = "example:tokyo:new-town-koto-reclaimed";
        addDevelopment(doc, { key, name: "Koto reclaimed-land district (example drawing)" });
        addPhase(doc, key, { polygon: rect(koto, 0.004, -0.008, 0.007, 0.004), playerDeclaredLandUse: "employment", railRefs: [{ externalLineId: `ext-line:${kotoLine.osmRelationId}` }] });
        addPhase(doc, key, { name: "Held back", polygon: rect(koto, 0.012, -0.008, 0.005, 0.004), playerDeclaredLandUse: "reserved" });
        deactivatePhase(doc, key, "phase-2");
        return key;
      } },
    ];
  },
  "example-radial": (pack, plans) => {
    const spoke = byName(plans, "spoke");
    const o1 = pointOf(pack, "outer-1");
    const end = lastStation(spoke).location;
    return [
      { file: "01-two-phases-with-synthetic-pond-and-road", mode: "scratch", layers: syntheticLayers(o1), author: (doc) => {
        const key = "example:radial:new-town-outer-spoke";
        addDevelopment(doc, { key, name: "Outer spoke district (example drawing)" });
        addPhase(doc, key, { name: "Housing first", polygon: rect(o1, 0.004, -0.006, 0.006, 0.004), playerDeclaredLandUse: "housing", playerDeclaredDeliveryOrder: 1, stationRefs: [{ stationId: lastStation(spoke).id }], railRefs: [segmentRef(spoke)] });
        addPhase(doc, key, { name: "Employment beside the pond", polygon: rect(o1, 0.0115, -0.006, 0.006, 0.004), playerDeclaredLandUse: "employment", playerDeclaredDeliveryOrder: 2 });
        return key;
      } },
      { file: "02-unstated-reordered-and-switched-off", mode: "scratch", author: (doc) => {
        const key = "example:radial:new-town-unstated";
        addDevelopment(doc, { key, name: "Nothing stated yet (example drawing)" });
        addPhase(doc, key, { polygon: rect(o1, -0.012, 0.004, 0.005, 0.003) }); // a polygon and nothing declared
        addPhase(doc, key, { playerDeclaredLandUse: "mixed" }); // a declaration and no polygon
        addPhase(doc, key, { polygon: rect(o1, -0.012, 0.009, 0.005, 0.003) });
        removePhase(doc, key, "phase-3"); // its key is never given out again
        addPhase(doc, key, { name: "Drawn after the removal", polygon: rect(o1, -0.006, 0.009, 0.004, 0.003), playerDeclaredLandUse: "education", playerDeclaredDeliveryOrder: 2 });
        setStationRefs(doc, key, "phase-1", []); // the player states there are no station sites
        deactivatePhase(doc, key, "phase-4");
        reorderPhase(doc, key, "phase-4", 0);
        updatePhase(doc, key, "phase-2", { playerDeclaredDeliveryOrder: 1 });
        return key;
      } },
      { file: "03-overlapping-phases-around-a-planned-station", mode: "scratch", author: (doc) => {
        const key = "example:radial:new-town-around-station";
        addDevelopment(doc, { key, name: "District around the spoke end (example drawing)" });
        addPhase(doc, key, { name: "Station district", polygon: around(end, 0.006, 0.004), playerDeclaredLandUse: "mixed", playerDeclaredDeliveryOrder: 1, stationRefs: [{ stationId: lastStation(spoke).id, stationKind: "plan" }] });
        addPhase(doc, key, { name: "Overlapping second drawing", polygon: rect(end, 0.001, -0.001, 0.006, 0.004), playerDeclaredLandUse: "housing", playerDeclaredDeliveryOrder: 2 });
        setRailRefs(doc, key, "phase-1", [segmentRef(spoke)]);
        return key;
      } },
    ];
  },
  "example-corridor": (pack, plans) => {
    const trunk = plans[0];
    const mid = trunk.stationCandidates[Math.floor(trunk.stationCandidates.length / 2)].location;
    return [
      { file: "01-corridor-district", mode: "scratch", author: (doc) => {
        const key = "example:corridor:new-town-trunk";
        addDevelopment(doc, { key, name: "Corridor district (example drawing)" });
        addPhase(doc, key, { name: "Station side", polygon: rect(mid, 0.002, 0.0006, 0.007, 0.0035), playerDeclaredLandUse: "housing", playerDeclaredDeliveryOrder: 1, railRefs: [segmentRef(trunk, 0)] });
        return key;
      } },
    ];
  },
};

for (const id of Object.keys(EXAMPLES).filter((k) => !only || k === only)) {
  const pack = loadPack(id);
  const plans = planExamples(pack);
  const outDir = outRoot ? path.join(outRoot, id) : path.join(root, pack.dir, "new-town-development-examples");
  fs.mkdirSync(outDir, { recursive: true });
  for (const ex of EXAMPLES[id](pack, plans)) {
    // the player's editing, saved and restored: what is built is what came back
    const authored = newNewTownDoc(pack.manifest.id, pack.manifest.version);
    const key = ex.author(authored);
    const restored = restoreNewTownDoc(serializeNewTownDoc(authored), pack);
    if (restored.rejected || restored.warnings.length) throw new Error(`${ex.file}: the saved document was not restored cleanly`);
    const drawn = drawnDevelopmentsOf(restored.doc).find((d) => d.key === key);
    const mapExport = { plans, externalNetworks: ex.mode === "existing" && pack.existingNetwork ? [existingNetworkToExternal(pack)] : [] };
    const out = buildNewTownDevelopmentExport({ pack, mapExport, developments: [drawn], spatial: makeSpatialContext(ex.layers ?? {}) });
    if (out.warnings.length || out.developments.length !== 1) throw new Error(`${ex.file}: ${JSON.stringify(out.warnings)}`);
    const development = { ...out.developments[0], source: { editorDocument: restored.doc.developments.find((d) => d.key === key), drawnDevelopment: drawn, requestedMode: ex.mode, layers: ex.layers ? Object.keys(ex.layers).sort() : [], note: NOTE, generatedBy: GENERATED_BY } };
    fs.writeFileSync(path.join(outDir, `${ex.file}.new-town.json`), `${JSON.stringify(development, null, 2)}\n`);
    console.log(`[${id}] ${ex.file}: ${development.developmentId} phases=${development.phaseCount} q=${development.dataQuality} area=${development.phaseAreaSumSquareMeters} flags=[${development.spatialFlags}] unknown=[${development.unknown}]`);
  }
}
