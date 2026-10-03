// Dev-time generator for the external rail technical specification examples in
// packs/<id>/external-rail-technical-examples/.
//   node scripts/build-external-rail-technical-examples.mjs [packId]   (npm run external-rail-technical-examples)
//
// Tokyo: real lines of the pack's existing network. Only values a cited source states are entered — today that is the
// Toei Shinjuku Line's gauge and electrification from Wikidata (CC0). Everything else stays null; nothing is guessed.
// example-radial / example-corridor: these packs have no existing network, so each example carries its own small
// FIXTURE network and uses kind "synthetic-fixture" sources. Their values are invented to exercise the contract and are
// labelled as such in every source record; they are not rail facts.
// No clock or RNG is involved: re-running the script rewrites every file byte for byte.
import fs from "node:fs";
import path from "node:path";
import { existingNetworkToExternal } from "../engine/src/map/plan-geometry.mjs";
import { buildExternalInfrastructureCatalog, buildExternalRailSpecificationExport } from "../engine/src/map/external-rail-technical-specification.mjs";
import { root, readJson, loadPack } from "./lib/pack-spatial.mjs";

const GENERATED_BY = "scripts/build-external-rail-technical-examples.mjs";

const fixtureSource = (sourceId, facts, extra = {}) => ({
  sourceId, kind: "synthetic-fixture", name: "Synthetic fixture for contract examples (not real rail data)", license: "CC0-1.0",
  reference: GENERATED_BY, note: "Invented values that exercise the contract. Do not use them as facts about any real railway.", facts, ...extra,
});

// A fixture network over a synthetic pack's own demand points (the pack has no existing network of its own).
const fixtureNetwork = (lines) => ({ formatVersion: 1, note: "Synthetic fixture network for external-rail-technical-examples; not real data.", lines });

const STEEL_WHEEL = { runningSystemId: "steel-wheel", gaugeMm: 1435, carWidthM: 2.8, maxAxleLoadTonnes: 16, collectionSystemId: "overhead", currentSystem: "dc", voltageV: 1500,
  minimumCurveRadiusMeters: 160, maxGradientPermille: 35, signalSystemIds: ["ats-p"], platformHeightMm: 1100, doorLayoutId: "4-door-20m", minCars: 4, maxCars: 10, maintenanceSystemId: "medium_steel" };

// Real source for the Tokyo example: statements read from Wikidata on 2026-10-03 (see the note for exactly what was and was not stated).
const WIKIDATA_TOEI_SHINJUKU = {
  sourceId: "wikidata:Q1374502@2526575441",
  kind: "community-dataset",
  name: "Wikidata, Toei Shinjuku Line (Q1374502)",
  license: "CC0-1.0",
  attribution: "Wikidata contributors, CC0 1.0 Universal. The line is matched to the pack through the OSM relation 443259 tag wikidata=Q1374502 (OpenStreetMap contributors, ODbL-1.0).",
  reference: "https://www.wikidata.org/wiki/Special:EntityData/Q1374502.json (revision 2526575441); P1064 -> Q5365683 Scotch gauge (revision 1924438618) P2049 = 1372 millimetre; P930 -> Q21253457 (revision 2537140511) P2436 = 1500 volt, P2283 -> Q110701 overhead contact line",
  note: "Retrieved 2026-10-03. The P1064 and P930 statements carry no references on Wikidata, so the source quality is low. currentSystem dc is read from the electrification item's English label \"1500 V DC railway electrification\". Every attribute not listed in facts is not stated by this source and stays null; the operator tag is not an owner.",
  quality: "low",
  facts: { gaugeMm: 1372, voltageV: 1500, collectionSystemId: "overhead", currentSystem: "dc" },
};

// Builds { network, specs } for a synthetic pack from a list of fixture lines; `entry` resolves a fixture line to its generated id.
function syntheticPack(pack, lines) {
  const fixture = fixtureNetwork(lines);
  const network = existingNetworkToExternal({ ...pack, existingNetwork: fixture });
  const entry = (file, lineName, name, sources) => ({
    file, fixture,
    drawn: { externalNetworkId: network.id, externalLineId: network.lines.find((l) => l.name === lineName).id, name, sources },
  });
  return { network, entry };
}

const EXAMPLES = {
  tokyo: (pack) => {
    const network = existingNetworkToExternal(pack);
    const lineOf = (osm) => network.lines.find((l) => l.osmRelationId === osm).id;
    return {
      network,
      specs: [
        { file: "01-toei-shinjuku-wikidata-partial", drawn: { externalNetworkId: network.id, externalLineId: lineOf(443259), name: "Toei Shinjuku Line: gauge and electrification from Wikidata only", sources: [WIKIDATA_TOEI_SHINJUKU] } },
        { file: "02-minatomirai-no-technical-data", drawn: { externalNetworkId: network.id, externalLineId: lineOf(1905260), name: "Minatomirai Line: no technical source", sources: [] } },
      ],
    };
  },
  "example-radial": (pack) => {
    const lines = [
      { name: "Fixture R1 fully verified steel wheel", stationIds: ["cbd", "inner-1", "mid-1"] },
      { name: "Fixture R2 gauge only", stationIds: ["cbd", "inner-2", "mid-2"] },
      { name: "Fixture R3 multiple signalling systems", stationIds: ["cbd", "inner-3", "mid-3"] },
      { name: "Fixture R4 third rail", stationIds: ["cbd", "inner-4", "mid-4"] },
      { name: "Fixture R5 conflicting sources", stationIds: ["cbd", "inner-5", "mid-5"] },
      { name: "Fixture R6 AGT, gauge not applicable", stationIds: ["cbd", "inner-6", "mid-6"] },
    ];
    const { network, entry } = syntheticPack(pack, lines);
    return {
      network,
      specs: [
        entry("01-fully-verified-steel-wheel", lines[0].name, "Every technical fact stated by one source", [fixtureSource("fixture:radial-r1", { ...STEEL_WHEEL, infrastructureOwnerId: "owner:fixture-railway-a" })]),
        entry("02-gauge-only", lines[1].name, "Only the gauge is stated: signalling and platform data are missing", [fixtureSource("fixture:radial-r2", { gaugeMm: 1435 })]),
        entry("03-multiple-signal-systems", lines[2].name, "Two signalling systems stated for the line", [fixtureSource("fixture:radial-r3", { ...STEEL_WHEEL, signalSystemIds: ["atc-10", "ats-p"], infrastructureOwnerId: "owner:fixture-railway-b" })]),
        entry("04-third-rail", lines[3].name, "Third-rail electrification", [fixtureSource("fixture:radial-r4", { runningSystemId: "steel-wheel", gaugeMm: 1435, collectionSystemId: "third-rail", currentSystem: "dc", voltageV: 750, carWidthM: 2.5, maxAxleLoadTonnes: 14, signalSystemIds: ["small-cbtc"] })]),
        entry("05-conflicting-sources", lines[4].name, "Two sources disagree on gauge and signalling", [
          fixtureSource("fixture:radial-r5-a", { gaugeMm: 1067, signalSystemIds: ["ats-p"], collectionSystemId: "overhead" }),
          fixtureSource("fixture:radial-r5-b", { gaugeMm: 1435, signalSystemIds: ["small-cbtc"], collectionSystemId: "overhead" }),
        ]),
        entry("06-agt-gauge-not-applicable", lines[5].name, "Rubber-tyre guideway: a source declares the gauge not applicable", [fixtureSource("fixture:radial-r6", {
          runningSystemId: "rubber-tire-guideway", collectionSystemId: "guideway-rail", currentSystem: "dc", voltageV: 750, carWidthM: 2.5, maxAxleLoadTonnes: 12, minimumCurveRadiusMeters: 60,
          maxGradientPermille: 60, signalSystemIds: ["agt-atc"], platformHeightMm: 1000, doorLayoutId: "2-door-9m", minCars: 3, maxCars: 8, maintenanceSystemId: "agt",
        }, { notApplicable: ["gaugeMm"] })]),
      ],
    };
  },
  "example-corridor": (pack) => {
    const lines = [
      { name: "Fixture C1 no technical data", stationIds: ["s1", "s2", "s3"] },
      { name: "Fixture C2 monorail, gauge not applicable", stationIds: ["s3", "s4", "s5"] },
    ];
    const { network, entry } = syntheticPack(pack, lines);
    return {
      network,
      specs: [
        entry("01-no-technical-data", lines[0].name, "No source states anything", []),
        entry("02-monorail-gauge-not-applicable", lines[1].name, "Straddle monorail: gauge not applicable, owner not stated", [fixtureSource("fixture:corridor-c2", {
          runningSystemId: "straddle-monorail", collectionSystemId: "beam-contact", currentSystem: "dc", voltageV: 1500, carWidthM: 3, maxAxleLoadTonnes: 13, minimumCurveRadiusMeters: 70,
          maxGradientPermille: 60, signalSystemIds: ["monorail-atc"], platformHeightMm: 1000, doorLayoutId: "2-door-15m", minCars: 4, maxCars: 8, maintenanceSystemId: "monorail",
        }, { notApplicable: ["gaugeMm"] })]),
      ],
    };
  },
};

const only = process.argv[2];
for (const id of Object.keys(EXAMPLES).filter((k) => !only || k === only)) {
  const pack = loadPack(id);
  const { network, specs } = EXAMPLES[id](pack);
  const outDir = path.join(root, pack.dir, "external-rail-technical-examples");
  fs.mkdirSync(outDir, { recursive: true });
  const written = [];
  for (const ex of specs) {
    const out = buildExternalRailSpecificationExport({ pack, externalNetworks: [network], specifications: [ex.drawn] });
    if (out.specifications.length !== 1) throw new Error(`${id}/${ex.file} was rejected: ${JSON.stringify(out.warnings)}`);
    const spec = out.specifications[0];
    const body = { ...spec, source: { drawnSpecification: ex.drawn, ...(ex.fixture ? { fixtureExistingNetwork: ex.fixture } : {}), generatedBy: GENERATED_BY } };
    fs.writeFileSync(path.join(outDir, `${ex.file}.spec.json`), `${JSON.stringify(body, null, 2)}\n`);
    written.push(spec);
    console.log(`[${id}] ${ex.file}: ${spec.specificationId} rev=${spec.specificationRevision} q=${spec.dataQuality} unknown=${spec.unknown.length} conflicts=${spec.conflicts.length} notApplicable=[${spec.notApplicable}]`);
  }
  if (id === "tokyo") {
    // The catalog joins the real external legs of the shipped through-route examples to the specifications above.
    const routeFiles = ["02-east-river-koto-line-external", "03-east-river-koto-shinjuku-three-legs"];
    const routes = routeFiles.map((f) => readJson(`${pack.dir}/through-route-examples/${f}.through-route.json`));
    const catalog = buildExternalInfrastructureCatalog({
      specificationExport: { packId: pack.manifest.id, packVersion: pack.manifest.version, specifications: written },
      routeExport: { routes },
    });
    const body = { ...catalog, source: { throughRouteExamples: routeFiles, specificationExamples: specs.map((s) => s.file), generatedBy: GENERATED_BY } };
    fs.writeFileSync(path.join(outDir, "01-east-river-koto.catalog.json"), `${JSON.stringify(body, null, 2)}\n`);
    console.log(`[${id}] catalog: entries=${catalog.entries.length} unmatched=${catalog.unmatchedLegIds.length}`);
  }
}
