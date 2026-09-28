import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildMapExport, existingNetworkToExternal } from "../src/map/plan-geometry.mjs";
import { makeSpatialContext, polygonLayer, roadLayerFromGeojson, waterLayerFromBarriers } from "../src/map/spatial.mjs";
import { buildDepotExport, buildDepotSite, canonicalRing, DEPOT_SITE_SCHEMA } from "../src/map/depot-site.mjs";
import { addSite, moveSite, newDepotDoc, redrawSite, removeSite, restoreDepotDoc, serializeDepotDoc, updateSite } from "../src/map/depot-editor.mjs";
import { buildDepotView, comparisonRows, drawDepotOverlay, FLAG_LABELS } from "../src/map/depot-view.mjs";

// --- fixtures: a mainline along lat 35, and a parcel just south of its west terminal, ~365 m x ~334 m ---
const pack = {
  manifest: { id: "t", version: "1", data: { license: "CC0-1.0", attribution: [] } },
  demand: { points: [{ id: "d0", name: "d0", location: [139, 35] }, { id: "d1", name: "d1", location: [139.01, 35] }, { id: "d2", name: "d2", location: [139.02, 35] }] },
  existingNetwork: { lines: [{ name: "E1", osmRelationId: 42, stationIds: ["d0", "d1"] }] },
};
const line = { key: "main", name: "Main", vertices: [[139, 35], [139.01, 35], [139.02, 35]].map((location) => ({ location, platformType: "side" })) };
const mapExport = buildMapExport({ pack, mode: "existing", drawnLines: [line] });
const plan = mapExport.plans[0];
const RING = [[139.019, 34.995], [139.023, 34.995], [139.023, 34.998], [139.019, 34.998]];
const sq = (lon, lat, d = 0.0002) => [[lon, lat], [lon + d, lat], [lon + d, lat + d], [lon, lat + d]];
const site = (extra = {}) => ({ key: "s1", name: "Site 1", polygon: RING, connect: { planId: plan.planId, segmentId: plan.segments[1].id }, ...extra });
const near = (actual, expected, tolerance, label) => assert.ok(Math.abs(actual - expected) <= tolerance, `${label ?? ""} expected ${expected} +/- ${tolerance}, got ${actual}`);
const ctxWith = (layers) => ({ pack, spatial: makeSpatialContext(layers), plans: mapExport.plans, externalNetworks: mapExport.externalNetworks });
const build = (drawn, layers = {}) => buildDepotSite(drawn, ctxWith(layers));

const dem = { elevationAt: () => 10, slopeAt: () => 2, quality: "medium", source: { name: "test dem", license: "CC0-1.0" } };
const buildings = polygonLayer([
  { rings: [sq(139.021, 34.9965)], kind: "yes" }, // inside the parcel
  { rings: [sq(139.0245, 34.996)], kind: "house" }, // ~137 m east of the parcel, residential
  { rings: [sq(139.0215, 34.9925)], kind: "yes" }, // ~278 m south
  { rings: [sq(139.03, 34.996)], kind: "house" }, // ~640 m east
], { quality: "high", source: { name: "test buildings", license: "ODbL-1.0" } });

// --- identity ---
test("same input gives the same depotSiteId and byte-identical output", () => {
  assert.equal(JSON.stringify(build(site(), { dem, buildings })), JSON.stringify(build(structuredClone(site()), { dem, buildings })));
});

test("drawing order, start vertex, direction, a closing vertex and float noise do not change a parcel's id or numbers", () => {
  const variants = [
    RING,
    [...RING.slice(2), ...RING.slice(0, 2)],
    [...RING].reverse(),
    [...RING, RING[0]],
    RING.map(([lon, lat]) => [lon + 1e-9, lat - 1e-9]),
  ];
  const first = build({ polygon: variants[0] }, { dem, buildings });
  for (const polygon of variants.slice(1)) {
    const other = build({ polygon }, { dem, buildings });
    assert.equal(other.depotSiteId, first.depotSiteId);
    assert.equal(JSON.stringify(other), JSON.stringify(first));
  }
  assert.notEqual(build({ polygon: sq(139.05, 34.99) }).depotSiteId, first.depotSiteId);
  assert.deepEqual(canonicalRing(variants[2]), canonicalRing(variants[0]));
});

test("a keyed site keeps its id when moved or redrawn; a keyless one follows its shape", () => {
  const doc = newDepotDoc("t", "1");
  const a = addSite(doc, { name: "A", polygon: RING });
  const before = build(a).depotSiteId;
  moveSite(doc, a.key, 0.001, 0.001);
  assert.equal(build(a).depotSiteId, before);
  redrawSite(doc, a.key, { polygon: sq(139.05, 34.99) });
  assert.equal(build(a).depotSiteId, before);
  const keyless = (polygon) => build({ polygon }).depotSiteId;
  assert.notEqual(keyless(RING), keyless(RING.map(([x, y]) => [x + 0.001, y])));
  assert.equal(build({ location: [139.03, 35] }).depotSiteId, build({ location: [139.03, 35] }).depotSiteId);
});

test("editing: move shifts the parcel and its waypoints, delete removes, keys are the smallest unused", () => {
  const doc = newDepotDoc("t", "1");
  const a = addSite(doc, { polygon: RING, connect: { planId: "p", via: [[139.017, 34.998]] } });
  const b = addSite(doc, { location: [139.03, 35] });
  assert.deepEqual([a.key, b.key], ["depot-1", "depot-2"]);
  moveSite(doc, a.key, 0.01, 0);
  near(a.polygon[0][0], 139.029, 1e-9);
  near(a.connect.via[0][0], 139.027, 1e-9);
  removeSite(doc, a.key);
  assert.equal(addSite(doc, { location: [1, 1] }).key, "depot-1");
  assert.throws(() => moveSite(doc, "depot-9", 0, 0));
  updateSite(doc, "depot-2", { name: "renamed" });
  assert.equal(doc.sites.find((s) => s.key === "depot-2").name, "renamed");
});

test("save and restore keeps every id and every computed value", () => {
  const doc = newDepotDoc("t", "1");
  addSite(doc, site());
  addSite(doc, { name: "B", location: [139.03, 35], connect: { externalLineId: "ext-line:42" } });
  const exportOf = (d) => JSON.stringify(buildDepotExport({ pack, mapExport, depots: d.sites, spatial: makeSpatialContext({ dem, buildings }) }));
  const { doc: restored, warnings } = restoreDepotDoc(serializeDepotDoc(doc), pack);
  assert.deepEqual(warnings, []);
  assert.equal(exportOf(restored), exportOf(doc));
});

test("a saved document is never applied to the wrong pack, and pack changes are reported", () => {
  const text = serializeDepotDoc(Object.assign(newDepotDoc("t", "1"), { sites: [{ key: "depot-1", location: [1, 1] }] }));
  assert.equal(restoreDepotDoc(text, { manifest: { id: "other", version: "1" } }).warnings[0].code, "depot-doc-other-pack");
  assert.equal(restoreDepotDoc(text, { manifest: { id: "other", version: "1" } }).doc.sites.length, 0);
  const newer = restoreDepotDoc(text, { manifest: { id: "t", version: "2" } });
  assert.equal(newer.warnings[0].code, "pack-version-mismatch");
  assert.equal(newer.doc.sites.length, 1);
  assert.equal(restoreDepotDoc("{not json", pack).warnings[0].code, "depot-doc-unreadable");
  assert.equal(restoreDepotDoc(JSON.stringify({ version: 99, sites: [] }), pack).warnings[0].code, "depot-doc-version");
  assert.deepEqual(restoreDepotDoc(null, pack).warnings, []);
});

// --- the contract ---
test("a site carries every field the management engine is promised", () => {
  const s = build(site(), { dem, buildings });
  for (const key of ["contractVersion", "schema", "depotSiteId", "sourcePackId", "sourcePackVersion", "name", "location", "polygon", "areaSquareMeters", "connectedPlanId",
    "connectedSegmentId", "connectionTrackLengthMeters", "distanceToTerminalMeters", "distanceToNearestStationMeters", "averageSlopePercent", "maximumSlopePercent",
    "intersectedBuildingCount", "roadCrossingCount", "waterCrossingCount", "distanceToResidentialMeters", "surroundingBuildingDensity", "existingFacilityReuse",
    "dataQuality", "unknown", "sourceLayers"]) assert.ok(key in s, key);
  assert.equal(s.schema, DEPOT_SITE_SCHEMA);
  assert.equal(s.contractVersion, 1);
  assert.equal(s.sourcePackVersion, "1");
  assert.deepEqual(s.sourceLayers.map((l) => l.layer), ["dem", "buildings"]);
});

test("the map hands over spatial facts only: no cost, price, opposition, schedule or score", () => {
  const s = build(site(), { dem, buildings });
  const banned = /cost|price|score|opposition|conflict|negotiat|schedule|duration|deadhead|budget|cash/i;
  const walk = (o, path = "") => {
    for (const [k, v] of Object.entries(o ?? {})) {
      assert.doesNotMatch(k, banned, `${path}${k}`);
      if (v && typeof v === "object" && !Array.isArray(v)) walk(v, `${path}${k}.`);
    }
  };
  walk(s);
});

test("building a site never changes the plans, layers or pack it was given", () => {
  const deepFreeze = (o) => { if (o && typeof o === "object") { Object.values(o).forEach(deepFreeze); Object.freeze(o); } return o; };
  const out = buildDepotExport({
    pack: deepFreeze(structuredClone(pack)), mapExport: deepFreeze(JSON.parse(JSON.stringify(mapExport))),
    depots: [deepFreeze(structuredClone(site()))], spatial: makeSpatialContext({ dem, buildings }),
  });
  assert.equal(out.sites.length, 1);
});

// --- geometry and distances ---
test("parcel area, location and connection track are measured on the ground", () => {
  const s = build(site());
  near(s.areaSquareMeters, 121_830, 1_500, "area");
  assert.deepEqual(s.location.map((v) => Math.round(v * 1e4) / 1e4), [139.021, 34.9965]);
  assert.equal(s.connectedPlanId, plan.planId);
  assert.equal(s.connectedSegmentId, plan.segments[1].id);
  assert.equal(s.connectionBasis, "plan-segment");
  near(s.distanceToMainlineMeters, 222.6, 1.5, "straight distance to the mainline");
  near(s.connectionTrackLengthMeters, s.distanceToMainlineMeters, 0.2);
  near(s.distanceToTerminalMeters, 400, 3, "distance to the nearer terminal");
  assert.equal(s.terminalStationId, plan.stationCandidates.at(-1).id);
  assert.equal(s.nearestStationId, plan.stationCandidates.at(-1).id);
  assert.equal(s.nearestStationKind, "plan");
  near(s.distanceToNearestStationMeters, 222.6, 1.5);
});

test("drawn waypoints make the connection track longer than the straight distance", () => {
  const s = build(site({ connect: { planId: plan.planId, segmentId: plan.segments[1].id, via: [[139.017, 34.998]] } }));
  assert.equal(s.connectionAlignment.length, 3);
  assert.ok(s.connectionTrackLengthMeters > s.distanceToMainlineMeters * 1.2, "the detour through the waypoint is longer than gate-to-mainline in a straight line");
  assert.deepEqual(s.connectionAlignment[1], [139.017, 34.998]);
});

test("without a chosen segment the nearest segment of the chosen plan is used, and says so", () => {
  const s = build(site({ connect: { planId: plan.planId } }));
  assert.equal(s.connectedSegmentId, plan.segments[1].id);
  assert.equal(s.connectionBasis, "nearest-segment");
});

test("a site can connect to an existing (external) line", () => {
  const s = build(site({ connect: { externalLineId: "ext-line:42" } }));
  assert.equal(s.connectedExternalLineId, "ext-line:42");
  assert.equal(s.connectedPlanId, null);
  assert.equal(s.connectionBasis, "external-line");
  assert.ok(s.connectionTrackLengthMeters > 0);
});

test("connections are checked against the plan ids the map exported", () => {
  const badPlan = build(site({ connect: { planId: "plan:nope" } }));
  assert.equal(badPlan.warnings[0].code, "connection-plan-missing");
  const badSegment = build(site({ connect: { planId: plan.planId, segmentId: "seg:nope" } }));
  assert.equal(badSegment.warnings[0].code, "connection-segment-missing");
  for (const s of [badPlan, badSegment]) {
    assert.equal(s.connectedPlanId, null);
    assert.equal(s.connectionTrackLengthMeters, null);
    assert.ok(s.unknown.includes("connectionTrackLengthMeters"));
    assert.equal(s.unknownReasons.connectionTrackLengthMeters, "connection-unresolved");
  }
  const none = build(site({ connect: null }));
  assert.equal(none.unknownReasons.distanceToMainlineMeters, "no-connection");
  assert.equal(none.warnings.length, 0, "an unconnected candidate is fine, just incomplete");
  assert.equal(build(site({ connect: { externalLineId: "ext-line:none" } })).warnings[0].code, "connection-line-missing");
});

// --- unknown is null, never 0 ---
test("with no spatial data every layer-dependent value is null, listed, and explained", () => {
  const s = build(site());
  for (const field of ["averageSlopePercent", "maximumSlopePercent", "groundElevationMeters", "intersectedBuildingCount", "waterOverlapCount", "roadsThroughSite", "waterCrossingCount",
    "roadCrossingCount", "distanceToResidentialMeters", "surroundingBuildingCount", "surroundingBuildingDensity", "existingFacilityReuse"]) {
    assert.equal(s[field], null, field);
    assert.ok(s.unknown.includes(field), field);
    assert.equal(s.unknownReasons[field], "no-layer", field);
  }
  assert.notEqual(s.dataQuality, "high");
  assert.ok(s.areaSquareMeters > 0, "what can be measured still is");
});

test("a layer that does not cover the parcel gives null with an outside-coverage reason", () => {
  const s = build(site(), { buildings: { ...buildings, covers: () => false } });
  assert.equal(s.intersectedBuildingCount, null);
  assert.equal(s.unknownReasons.intersectedBuildingCount, "outside-coverage");
  assert.equal(s.surroundingBuildingDensity, null);
});

test("a point candidate has no area or overlaps, but keeps its distances", () => {
  const s = build({ key: "p", name: "Point", location: [139.03, 35], connect: { planId: plan.planId } }, { dem, buildings });
  assert.equal(s.geometryKind, "point");
  assert.equal(s.polygon, null);
  assert.equal(s.areaSquareMeters, null);
  assert.equal(s.intersectedBuildingCount, null);
  assert.equal(s.unknownReasons.areaSquareMeters, "no-polygon");
  assert.ok(s.connectionTrackLengthMeters > 0);
  assert.ok(s.averageSlopePercent > 0, "slope is sampled at the point");
});

test("a self-intersecting or degenerate polygon is refused visibly", () => {
  const bow = build({ key: "b", polygon: [[139.019, 34.995], [139.023, 34.998], [139.023, 34.995], [139.0205, 34.9985]], location: [139.021, 34.9965] });
  assert.equal(bow.warnings[0].code, "polygon-self-intersecting");
  assert.equal(bow.geometryKind, "point");
  assert.equal(bow.areaSquareMeters, null);
  assert.equal(build({ key: "l", polygon: [[139, 35], [139.001, 35], [139.002, 35]], location: [139.001, 35] }).warnings[0].code, "polygon-degenerate");
});

// --- what the layers say ---
test("slope is reported in percent from the DEM, and a steep parcel is flagged", () => {
  const s = build(site(), { dem });
  near(s.averageSlopePercent, Math.tan((2 * Math.PI) / 180) * 100, 0.01);
  assert.equal(s.maximumSlopePercent, s.averageSlopePercent);
  assert.equal(s.groundElevationMeters, 10);
  assert.equal(s.elevationRangeMeters, 0);
  assert.ok(s.spatialFlags.includes("steep-site"));
  assert.equal(build(site(), { dem: { ...dem, slopeAt: () => 0.5 } }).spatialFlags.includes("steep-site"), false);
  assert.equal(build(site(), { dem: { ...dem, slopeAt: () => null } }).averageSlopePercent, null, "a cell with no value is unknown, not flat");
});

test("buildings overlapped, residential distance and surrounding density come from the footprints", () => {
  const s = build(site(), { buildings });
  assert.equal(s.intersectedBuildingCount, 1);
  assert.ok(s.spatialFlags.includes("building-overlap"));
  near(s.distanceToResidentialMeters, 137, 4, "distance to the nearest house");
  assert.equal(s.residentialBasis, "building-tag");
  assert.equal(s.surroundingBuildingCount, 2);
  near(s.surroundingBuildingDensity, 2.4, 0.15, "buildings per km2");
  assert.equal(s.densityRadiusMeters, 300);
  assert.equal(s.spatialFlags.includes("near-residential"), false);
});

test("residential land use counts as residential, and land within 100 m raises the flag", () => {
  const landuse = polygonLayer([{ rings: [sq(139.0235, 34.996, 0.001)], kind: "residential" }], { quality: "high" });
  const s = build(site(), { residential: landuse });
  near(s.distanceToResidentialMeters, 45.6, 3);
  assert.equal(s.residentialBasis, "landuse-residential");
  assert.ok(s.spatialFlags.includes("near-residential"));
  const none = build(site(), { residential: polygonLayer([{ rings: [sq(139.2, 35.2)], kind: "residential" }], {}) });
  assert.equal(none.distanceToResidentialMeters, null);
  assert.equal(none.unknown.includes("distanceToResidentialMeters"), false, "known: nothing residential within the search radius");
});

test("water overlap, roads through the parcel and the connection's crossings are counted", () => {
  const water = waterLayerFromBarriers({ barriers: [{ kind: "water", polygon: [[[139.0225, 34.9975], [139.025, 34.9975], [139.025, 35.0], [139.0225, 35.0]]] }] });
  const roads = roadLayerFromGeojson({ features: [
    { geometry: { coordinates: [[139.018, 34.994], [139.024, 34.999]] }, properties: { roadClass: "major" } },
    { geometry: { coordinates: [[139.0, 34.9965], [139.0195, 34.9965], [139.0195, 34.9995]] }, properties: { roadClass: "minor" } },
    { geometry: { coordinates: [[139.0192, 34.9985], [139.0192, 34.9995]] }, properties: { roadClass: "highway" } },
  ] });
  const s = build(site(), { water, roads });
  assert.equal(s.waterOverlapCount, 1);
  assert.ok(s.spatialFlags.includes("water-overlap"));
  assert.deepEqual(s.roadsThroughSite, { highway: 0, major: 1, minor: 1 });
  assert.equal(s.waterCrossingCount, 0, "the short connection straight to the mainline crosses no water");
  assert.equal(s.roadCrossingCount, 0);
  // a river strip across the whole width between the parcel and the mainline
  const wet = build(site(), { water: waterLayerFromBarriers({ barriers: [{ kind: "water", polygon: [[[139.018, 34.9985], [139.0205, 34.9985], [139.0205, 34.9995], [139.018, 34.9995]]] }] }) });
  assert.equal(wet.waterCrossingCount, 1);
  assert.ok(wet.spatialFlags.includes("connection-crosses-water"));
});

test("existing rail land: within, overlapping, adjacent or none", () => {
  const facility = (ring) => ({ railFacilities: polygonLayer([{ rings: [ring], kind: "railway-land", id: "yard-1" }], { quality: "high" }) });
  const within = build(site(), facility([[139.018, 34.994], [139.024, 34.994], [139.024, 34.999], [139.018, 34.999]]));
  assert.equal(within.existingFacilityReuse.status, "within");
  assert.equal(within.existingFacilityReuse.facilities[0].id, "yard-1");
  assert.equal(build(site(), facility([[139.022, 34.996], [139.03, 34.996], [139.03, 34.999], [139.022, 34.999]])).existingFacilityReuse.status, "overlaps");
  const adjacent = build(site(), facility([[139.024, 34.995], [139.026, 34.995], [139.026, 34.998], [139.024, 34.998]]));
  assert.equal(adjacent.existingFacilityReuse.status, "adjacent");
  assert.equal(build(site(), facility([[139.1, 35.1], [139.11, 35.1], [139.11, 35.11], [139.1, 35.11]])).existingFacilityReuse.status, "none");
});

test("two identical parcels are reported once, and a site with no geometry is refused visibly", () => {
  const out = buildDepotExport({ pack, mapExport, depots: [{ polygon: RING }, { polygon: [...RING].reverse() }, { name: "no geometry" }], spatial: makeSpatialContext() });
  assert.equal(out.sites.length, 1);
  assert.deepEqual(out.warnings.map((w) => w.code), ["duplicate-depot-site", "depot-no-geometry"]);
});

// --- display ---
test("the comparison table shows unknowns as 미상 with the reason, and never as 0", () => {
  const out = buildDepotExport({ pack, mapExport, depots: [site(), site({ key: "s2", name: "Site 2", polygon: sq(139.05, 34.99, 0.003) })], spatial: makeSpatialContext({ dem, buildings }) });
  const rows = comparisonRows(out.sites);
  assert.equal(rows.length, 2);
  const roads = rows[0].cells.find((c) => c.label === "도로 횡단");
  assert.deepEqual([roads.text, roads.missing, roads.reason], ["미상", true, "no-layer"]);
  assert.ok(rows.every((r) => r.cells.every((c) => c.missing === (c.text === "미상"))));
  const view = buildDepotView(out, out.sites[0].depotSiteId);
  assert.equal(view.sites.filter((s) => s.selected).length, 1);
  assert.ok(view.sites[0].missing.some((m) => m.field === "roadCrossingCount"));
  assert.ok(Object.keys(FLAG_LABELS).length >= 6);
});

test("the depot overlay draws parcel, connection track, and risk markers", () => {
  const out = buildDepotExport({ pack, mapExport, depots: [site()], spatial: makeSpatialContext({ dem, buildings }) });
  const view = buildDepotView(out);
  assert.ok(view.sites[0].flags.some((f) => f.flag === "building-overlap"));
  const calls = [];
  const ctx = new Proxy({}, { get: (t, k) => (k in t ? t[k] : (...args) => calls.push([k, ...args])), set: (t, k, v) => { t[k] = v; calls.push(["set", k, v]); return true; } });
  drawDepotOverlay(ctx, view, ([lon, lat]) => [(lon - 139) * 1e4, -(lat - 35) * 1e4]);
  assert.ok(calls.some((c) => c[0] === "set" && c[1] === "fillStyle" && c[2].startsWith("rgba(45, 212, 191")), "parcel fill");
  assert.ok(calls.some((c) => c[0] === "set" && c[1] === "strokeStyle" && c[2] === "#ff9f1c"), "connection track");
  assert.ok(calls.some((c) => c[0] === "fillText" && c[1] === FLAG_LABELS["building-overlap"]), "risk marker label");
  assert.ok(calls.some((c) => c[0] === "fillText" && String(c[1]).includes("Site 1")));
});

// --- shipped examples (packs/<id>/depot-examples), tied to that pack's plan-examples ---
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const readJson = (p) => JSON.parse(fs.readFileSync(path.join(root, p), "utf8"));
const files = (id, kind) => fs.readdirSync(path.join(root, "packs", id, kind)).filter((f) => f.endsWith(kind === "depot-examples" ? ".depot.json" : ".plan.json")).sort();
const loadExamples = (id) => ({
  manifest: readJson(`packs/${id}/manifest.json`),
  plans: files(id, "plan-examples").map((f) => readJson(`packs/${id}/plan-examples/${f}`)),
  sites: files(id, "depot-examples").map((f) => ({ file: f, site: readJson(`packs/${id}/depot-examples/${f}`) })),
});
const isPlain = (v) => v === null || ["number", "string", "boolean"].includes(typeof v) || Array.isArray(v) || typeof v === "object";

test("the Tokyo pack and the synthetic pack each ship at least three depot site examples", () => {
  assert.ok(loadExamples("tokyo").sites.length >= 3);
  assert.ok(loadExamples("example-radial").sites.length >= 3);
  assert.ok(loadExamples("example-corridor").sites.length >= 1);
});

test("every example connects to a plan id and segment id that exists in the same pack's PlanGeometry examples", () => {
  for (const id of ["tokyo", "example-radial", "example-corridor"]) {
    const { manifest, plans, sites } = loadExamples(id);
    const external = readJsonMaybeNetwork(id, manifest);
    for (const { file, site } of sites) {
      assert.equal(site.sourcePackId, id);
      assert.equal(site.contractVersion, 1);
      if (site.connectedPlanId) {
        const plan = plans.find((p) => p.planId === site.connectedPlanId);
        assert.ok(plan, `${file}: plan ${site.connectedPlanId}`);
        assert.ok(plan.segments.some((s) => s.id === site.connectedSegmentId), `${file}: segment ${site.connectedSegmentId}`);
        assert.equal(plan.sourcePackId, site.sourcePackId);
        assert.equal(site.warnings.length, 0, file);
      } else {
        assert.ok(external.lines.some((l) => l.id === site.connectedExternalLineId), `${file}: external line ${site.connectedExternalLineId}`);
      }
    }
  }
});
function readJsonMaybeNetwork(id, manifest) {
  if (!manifest.files.existingNetwork) return { lines: [] };
  return existingNetworkToExternal({ manifest, demand: readJson(`packs/${id}/${manifest.files.demand}`), existingNetwork: readJson(`packs/${id}/${manifest.files.existingNetwork}`) });
}

test("every example keeps unknowns null with a reason, carries its pack license, and has a reproducible id", () => {
  for (const id of ["tokyo", "example-radial", "example-corridor"]) {
    const { manifest, sites } = loadExamples(id);
    for (const { file, site } of sites) {
      for (const field of site.unknown) {
        if (field === "polygon") assert.equal(site.polygon, null);
        else assert.equal(site[field], null, `${file}: ${field}`);
        assert.ok(site.unknownReasons[field], `${file}: reason for ${field}`);
      }
      assert.equal(site.license.pack, manifest.data.license);
      assert.ok(["high", "medium", "low"].includes(site.dataQuality));
      const again = buildDepotExport({ pack: { manifest }, mapExport: { plans: [], externalNetworks: [] }, depots: [site.source.drawnSite], spatial: makeSpatialContext() });
      assert.equal(again.sites[0].depotSiteId, site.depotSiteId, `${file}: id follows the key`);
      assert.ok(Object.values(site).every(isPlain));
    }
  }
});

test("the Tokyo examples use real layers with their licenses, and show what is unknown outside them", () => {
  const { sites } = loadExamples("tokyo");
  const all = sites.map((s) => s.site);
  assert.ok(all.some((s) => s.geometryKind === "point") && all.some((s) => s.geometryKind === "polygon"));
  assert.ok(all.some((s) => s.existingFacilityReuse && s.existingFacilityReuse.status !== "none"), "one candidate sits on real railway land");
  assert.ok(all.some((s) => s.intersectedBuildingCount > 0) && all.some((s) => s.surroundingBuildingDensity > 0));
  assert.ok(all.some((s) => s.distanceToResidentialMeters !== null));
  assert.ok(all.some((s) => s.spatialFlags.includes("steep-site")));
  const outside = all.filter((s) => s.unknownReasons.intersectedBuildingCount === "outside-coverage");
  assert.ok(outside.length >= 1, "a candidate outside the 23-ward building data is unknown, not empty");
  for (const s of all) for (const layer of s.sourceLayers) assert.ok(layer.name && layer.license, `${layer.layer} needs a name and a license`);
  assert.ok(all.flatMap((s) => s.sourceLayers).some((l) => l.license === "ODbL-1.0"));
  assert.ok(all.every((s) => s.license.pack === "ODbL-1.0"));
});

test("synthetic-pack depot examples regenerate byte-for-byte from their drawn sites", () => {
  for (const id of ["example-radial", "example-corridor"]) {
    const { manifest, plans, sites } = loadExamples(id);
    const pack = { manifest, demand: readJson(`packs/${id}/${manifest.files.demand}`) };
    for (const { file, site } of sites) {
      const { source, ...body } = site;
      const out = buildDepotExport({ pack, mapExport: { plans, externalNetworks: [] }, depots: [source.drawnSite], spatial: makeSpatialContext() });
      assert.equal(JSON.stringify(out.sites[0]), JSON.stringify(body), `${id}/${file} is stale: run scripts/build-depot-examples.mjs`);
    }
  }
});
