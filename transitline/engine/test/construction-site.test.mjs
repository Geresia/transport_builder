import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildMapExport } from "../src/map/plan-geometry.mjs";
import { makeSpatialContext, polygonLayer, roadLayerFromGeojson } from "../src/map/spatial.mjs";
import { buildDepotExport } from "../src/map/depot-site.mjs";
import {
  buildConstructionExport, buildConstructionSite, CONSTRUCTION_EXPORT_SCHEMA, CONSTRUCTION_SITE_SCHEMA, keyedConstructionSiteId, PACKAGE_KINDS,
} from "../src/map/construction-site.mjs";
import {
  activePackages, addPackage, mergePackages, newConstructionDoc, nextPackageKey, reassignSegment, removePackage,
  restoreConstructionDoc, restorePackage, serializeConstructionDoc, splitPackage,
} from "../src/map/construction-editor.mjs";
import { buildConstructionView, drawConstructionOverlay, PACKAGE_PHASES, renderConstructionLegend, renderConstructionPanel } from "../src/map/construction-view.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const readJson = (p) => JSON.parse(fs.readFileSync(path.join(root, p), "utf8"));

// --- fixtures: a four-station line along lat 35, three legs (shield / cut-cover / elevated), plus an existing network ---
const pack = {
  manifest: { id: "t", version: "1", data: { license: "CC0-1.0", attribution: [] } },
  demand: { points: [{ id: "d0", name: "d0", location: [139, 35] }, { id: "d1", name: "d1", location: [139.01, 35] }, { id: "d2", name: "d2", location: [139.02, 35] }, { id: "d3", name: "d3", location: [139.03, 35] }] },
  existingNetwork: { lines: [{ name: "E1", osmRelationId: 42, stationIds: ["d0", "d1"] }] },
};
const line = {
  key: "main", name: "Main",
  legs: [{ structureHint: "shield" }, { structureHint: "cut-cover" }, { structureHint: "elevated" }],
  vertices: [139, 139.01, 139.02, 139.03].map((lon) => ({ location: [lon, 35], platformType: "side" })),
};
const dem = { elevationAt: () => 12, slopeAt: () => 1, quality: "medium", source: { name: "test dem", license: "CC0-1.0" } };
const mapExport = buildMapExport({ pack, mode: "existing", drawnLines: [line], spatial: makeSpatialContext({ dem }) });
const plan = mapExport.plans[0];
const [seg0, seg1, seg2] = plan.segments;
const RING = [[139.019, 34.995], [139.023, 34.995], [139.023, 34.998], [139.019, 34.998]];
const depotExport = buildDepotExport({ pack, mapExport, depots: [{ key: "dep1", name: "Depot", polygon: RING, connect: { planId: plan.planId, segmentId: seg2.id } }] });
const depot = depotExport.sites[0];

const ctxWith = (layers = {}, dExp = null) => ({ pack, spatial: makeSpatialContext(layers), plans: mapExport.plans, externalNetworks: mapExport.externalNetworks, depotExport: dExp });
const build = (drawn, layers = {}, dExp = null) => buildConstructionSite(drawn, ctxWith(layers, dExp));
const near = (actual, expected, tolerance, label = "") => assert.ok(Math.abs(actual - expected) <= tolerance, `${label} expected ${expected} +/- ${tolerance}, got ${actual}`);
const sq = (lon, lat, d = 0.0006) => [[[lon, lat], [lon + d, lat], [lon + d, lat + d], [lon, lat + d], [lon, lat]]];
const source = (name) => ({ name, license: "CC0-1.0" });
const tunnel = (extra = {}) => ({ key: "p1", kind: "tunnel", planId: plan.planId, segmentIds: [seg0.id], ...extra });

// --- identity ---
test("same input gives the same constructionSiteId and byte-identical output", () => {
  const layers = { dem };
  assert.equal(JSON.stringify(build(tunnel(), layers).site), JSON.stringify(build(structuredClone(tunnel()), layers).site));
  assert.equal(build(tunnel()).site.schema, CONSTRUCTION_SITE_SCHEMA);
});

test("a keyed id follows the key; a keyless id follows the kind, plan and segment set, not the order given", () => {
  assert.equal(build(tunnel()).site.constructionSiteId, keyedConstructionSiteId("t", "p1"));
  const keyless = (segmentIds) => build({ kind: "tunnel", planId: plan.planId, segmentIds }).site.constructionSiteId;
  assert.equal(keyless([seg0.id]), keyless([seg0.id]));
  assert.equal(build({ kind: "tunnel", planId: plan.planId, segmentIds: [seg0.id, seg1.id] }).site.constructionSiteId, build({ kind: "tunnel", planId: plan.planId, segmentIds: [seg1.id, seg0.id] }).site.constructionSiteId, "the id does not depend on the order segments were given in");
  assert.notEqual(keyless([seg0.id]), keyless([seg1.id]));
  assert.notEqual(build({ kind: "cutCover", planId: plan.planId, segmentIds: [seg0.id] }).site.constructionSiteId, keyless([seg0.id]), "kind is part of the identity");
  assert.equal(build(tunnel({ name: "A" })).site.constructionSiteId, build(tunnel({ name: "B" })).site.constructionSiteId, "the id does not depend on the name");
});

test("station and depot packages get their own id scheme, keyed or from what they connect to", () => {
  const st = build({ key: "s1", kind: "station", planId: plan.planId, stationId: plan.stationCandidates[1].id }).site;
  assert.equal(st.constructionSiteId, keyedConstructionSiteId("t", "s1"));
  const stKeyless = build({ kind: "station", planId: plan.planId, stationId: plan.stationCandidates[1].id }).site;
  assert.equal(stKeyless.constructionSiteId, build({ kind: "station", planId: plan.planId, stationId: plan.stationCandidates[1].id }).site.constructionSiteId);
  const dp = build({ kind: "depot", depotSiteId: depot.depotSiteId }, {}, depotExport).site;
  assert.notEqual(dp.constructionSiteId, st.constructionSiteId);
});

// --- editor: reassign, split, merge, delete/restore, keys never reused ---
test("a keyed package keeps its id through a segment reassignment, split-then-untouched, delete and restore", () => {
  const doc = newConstructionDoc("t", "1");
  addPackage(doc, { key: "a", kind: "tunnel", planId: plan.planId, segmentIds: [seg0.id, seg1.id] });
  const idOf = (key) => buildConstructionExport({ pack, mapExport, packages: activePackages(doc) }).sites.find((s) => s.constructionSiteId === keyedConstructionSiteId("t", key))?.constructionSiteId;
  const before = idOf("a");
  assert.ok(before);
  removePackage(doc, "a");
  assert.equal(idOf("a"), undefined, "a deleted package is not exported");
  restorePackage(doc, "a");
  assert.equal(idOf("a"), before);
});

test("nextPackageKey never reuses a deleted key", () => {
  const doc = newConstructionDoc("t", "1");
  const a = addPackage(doc, { kind: "tunnel", planId: plan.planId, segmentIds: [seg0.id] });
  assert.equal(a.key, "package-1");
  removePackage(doc, a.key);
  assert.equal(nextPackageKey(doc), "package-2");
});

test("reassignSegment moves a segment across a boundary between two packages on the same plan", () => {
  const doc = newConstructionDoc("t", "1");
  addPackage(doc, { key: "a", kind: "tunnel", planId: plan.planId, segmentIds: [seg0.id] });
  addPackage(doc, { key: "b", kind: "cutCover", planId: plan.planId, segmentIds: [seg1.id, seg2.id] });
  reassignSegment(doc, "b", "a", seg1.id);
  assert.deepEqual(doc.packages.find((p) => p.key === "a").segmentIds, [seg0.id, seg1.id]);
  assert.deepEqual(doc.packages.find((p) => p.key === "b").segmentIds, [seg2.id]);
  assert.throws(() => reassignSegment(doc, "a", "b", "seg:nope"), /not in package/);
  const c = addPackage(doc, { kind: "tunnel", planId: "plan:other", segmentIds: [] });
  assert.throws(() => reassignSegment(doc, "a", c.key, seg0.id), /different plans/);
});

test("splitPackage divides a run at an interior segment, following the plan's order, not array order", () => {
  const doc = newConstructionDoc("t", "1");
  addPackage(doc, { key: "a", kind: "tunnel", planId: plan.planId, segmentIds: [seg2.id, seg0.id, seg1.id] }); // given out of order
  const order = plan.segments.map((s) => s.id);
  const { first, second } = splitPackage(doc, "a", seg1.id, order);
  assert.deepEqual(first.segmentIds, [seg0.id]);
  assert.deepEqual(second.segmentIds, [seg1.id, seg2.id]);
  assert.equal(second.kind, "tunnel");
  assert.equal(second.planId, plan.planId);
  assert.throws(() => splitPackage(doc, "a", seg0.id, order), /interior segment/, "splitting at the first segment leaves nothing before it");
});

test("mergePackages combines two packages of the same kind and plan, and removes the second outright (not restorable)", () => {
  const doc = newConstructionDoc("t", "1");
  addPackage(doc, { key: "a", kind: "tunnel", planId: plan.planId, segmentIds: [seg0.id] });
  addPackage(doc, { key: "b", kind: "tunnel", planId: plan.planId, segmentIds: [seg1.id] });
  const order = plan.segments.map((s) => s.id);
  mergePackages(doc, "a", "b", order);
  assert.deepEqual(doc.packages.find((p) => p.key === "a").segmentIds, [seg0.id, seg1.id]);
  assert.equal(doc.packages.some((p) => p.key === "b"), false, "b is gone entirely, not tombstoned");
  const doc2 = newConstructionDoc("t", "1");
  addPackage(doc2, { key: "a", kind: "tunnel", planId: plan.planId, segmentIds: [seg0.id] });
  addPackage(doc2, { key: "b", kind: "cutCover", planId: plan.planId, segmentIds: [seg1.id] });
  assert.throws(() => mergePackages(doc2, "a", "b", order), /same kind and plan/);
});

// --- save and reopen ---
test("save then reopen gives the same ids and byte-identical facts", () => {
  const doc = newConstructionDoc("t", "1");
  addPackage(doc, { key: "a", kind: "tunnel", planId: plan.planId, segmentIds: [seg0.id] });
  addPackage(doc, { key: "b", kind: "station", planId: plan.planId, stationId: plan.stationCandidates[1].id });
  const c = addPackage(doc, { key: "c", kind: "viaduct", planId: plan.planId, segmentIds: [seg2.id] });
  removePackage(doc, c.key);
  const layers = { dem };
  const first = JSON.stringify(buildConstructionExport({ pack, mapExport, packages: activePackages(doc), spatial: makeSpatialContext(layers) }));
  const restored = restoreConstructionDoc(serializeConstructionDoc(doc), pack);
  assert.deepEqual(restored.warnings, []);
  assert.equal(JSON.stringify(buildConstructionExport({ pack, mapExport, packages: activePackages(restored.doc), spatial: makeSpatialContext(layers) })), first);
  assert.equal(restored.doc.packages.length, 3, "the deleted package is kept as a tombstone");
  assert.equal(restored.doc.packages[2].deleted, true);
});

test("a saved document is not applied to another pack, and a pack version change is reported", () => {
  const doc = newConstructionDoc("t", "1");
  addPackage(doc, { kind: "tunnel", planId: plan.planId, segmentIds: [seg0.id] });
  const text = serializeConstructionDoc(doc);
  const other = restoreConstructionDoc(text, { manifest: { id: "elsewhere", version: "1" } });
  assert.equal(other.doc.packages.length, 0);
  assert.equal(other.warnings[0].code, "construction-doc-other-pack");
  assert.equal(restoreConstructionDoc(text, { manifest: { id: "t", version: "2" } }).warnings[0].code, "pack-version-mismatch");
  assert.equal(restoreConstructionDoc("{not json", pack).warnings[0].code, "construction-doc-unreadable");
  assert.equal(restoreConstructionDoc(null, pack).doc.packages.length, 0);
});

// --- contract ---
test("a site carries every documented field, its pack license and its data sources", () => {
  const s = build(tunnel(), { dem }).site;
  for (const k of [
    "schema", "contractVersion", "constructionSiteId", "sourcePackId", "sourcePackVersion", "kind", "name", "coordinateReference",
    "connectedPlanId", "connectedSegmentIds", "connectedStationId", "connectedDepotSiteId", "polygon", "areaSquareMeters", "lengthMeters",
    "groundElevationMeters", "elevationRangeMeters", "averageSlopePercent", "maximumSlopePercent", "intersectedBuildingCount", "waterOverlapCount",
    "roadsOccupied", "existingFacilityCrossingCount", "distanceToResidentialMeters", "waterCrossingCount", "waterCrossings", "roadCrossingCount",
    "roadCrossings", "existingRailwayCrossingCount", "existingRailwayCrossings", "shaftCandidates", "workAreaCandidates", "materialYardCandidates",
    "accessRoadCandidates", "vehicleAccessCandidates", "spatialFlags", "dataQuality", "unknown", "unknownReasons", "constraintUnknown", "warnings",
    "sourceLayers", "license",
  ]) assert.ok(k in s, `missing ${k}`);
  assert.equal(s.contractVersion, 1);
  assert.equal(s.connectedPlanId, plan.planId);
  assert.deepEqual(s.connectedSegmentIds, [seg0.id]);
  assert.equal(s.license.pack, "CC0-1.0");
  assert.equal(s.sourceLayers[0].name, "test dem");
  assert.notEqual(s.dataQuality, "high", "ground data does not exist, so quality is capped");
  assert.ok(s.constraintUnknown.includes("groundwater") && s.constraintUnknown.includes("utilities"));
  assert.equal(PACKAGE_KINDS.length, 6);
});

const forbidden = /cost|price|score|capacity|compensation|duration|opposition|negotiat|schedule|budget|fare|cash|ledger|profit|revenue|probability|method|award|bid/i;
function keysOf(value, out = new Set()) {
  if (Array.isArray(value)) value.forEach((v) => keysOf(v, out));
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) { out.add(k); keysOf(v, out); }
  return out;
}
test("the contract has no cost, duration, incident-probability, complaint-score or construction-method fields", () => {
  const s = build(tunnel(), { dem }).site;
  for (const k of keysOf(s)) assert.doesNotMatch(k, forbidden, `field ${k}`);
});

// --- missing data: null + unknown[] + a reason, never 0 ---
test("with no spatial layers everything spatial is null with a reason, and nothing is filled with 0", () => {
  const s = build(tunnel()).site;
  for (const f of ["intersectedBuildingCount", "waterOverlapCount", "roadsOccupied", "existingFacilityCrossingCount", "averageSlopePercent", "groundElevationMeters", "waterCrossingCount", "roadCrossingCount", "waterCrossings", "roadCrossings"]) {
    assert.equal(s[f], null, f);
    assert.ok(s.unknown.includes(f), `${f} listed as unknown`);
  }
  assert.equal(s.unknownReasons.intersectedBuildingCount, "no-layer");
  assert.equal(s.unknownReasons.waterCrossingCount, "no-layer");
  for (const sh of s.shaftCandidates) { assert.equal(sh.groundElevationMeters, null); assert.ok(sh.unknown.includes("groundElevationMeters")); }
  assert.ok(s.areaSquareMeters > 0, "the corridor is still geometry, so it is still there");
});

test("a layer that does not cover the corridor is 'outside-coverage', not 0; a covering layer that finds nothing is a real 0", () => {
  const empty = polygonLayer([], { quality: "high", source: source("empty buildings") });
  const covering = build(tunnel(), { buildings: empty }).site;
  assert.equal(covering.intersectedBuildingCount, 0);
  assert.ok(!covering.unknown.includes("intersectedBuildingCount"));
  const elsewhere = build(tunnel(), { buildings: { ...empty, covers: () => false } }).site;
  assert.equal(elsewhere.intersectedBuildingCount, null);
  assert.equal(elsewhere.unknownReasons.intersectedBuildingCount, "outside-coverage");
  const noWater = build(tunnel(), { water: { ...empty, covers: () => false } }).site;
  assert.equal(noWater.waterCrossingCount, null);
  assert.equal(noWater.unknownReasons.waterCrossings, "outside-coverage");
});

// --- geometry per kind ---
test("a tunnel package is a corridor around its segments' alignment, with shaft candidates at both portals", () => {
  const s = build(tunnel({ segmentIds: [seg0.id, seg1.id] })).site;
  near(s.lengthMeters, seg0.lengthMeters + seg1.lengthMeters, 1);
  assert.ok(s.areaSquareMeters > 0);
  assert.equal(s.shaftCandidates.length, 2);
  assert.deepEqual(s.shaftCandidates.map((c) => c.end).sort(), ["end", "start"]);
  assert.equal(s.shaftCandidates[0].footprintMeters, 14);
});

test("cut-and-cover and viaduct packages get a corridor but no shafts; systems packages take any structure", () => {
  const cc = build({ kind: "cutCover", planId: plan.planId, segmentIds: [seg1.id] }).site;
  assert.equal(cc.shaftCandidates.length, 0);
  assert.ok(cc.areaSquareMeters > 0);
  const vi = build({ kind: "viaduct", planId: plan.planId, segmentIds: [seg2.id] }).site;
  assert.equal(vi.shaftCandidates.length, 0);
  const sysAll = build({ kind: "systems", planId: plan.planId, segmentIds: [seg0.id, seg1.id, seg2.id] }).site;
  assert.equal(sysAll.connectedSegmentIds.length, 3);
});

test("a station package is a pad around the station; a depot package reuses the depot's own polygon", () => {
  const st = build({ kind: "station", planId: plan.planId, stationId: plan.stationCandidates[1].id }).site;
  assert.equal(st.lengthMeters, null);
  assert.ok(st.areaSquareMeters > 0);
  assert.equal(st.connectedStationId, plan.stationCandidates[1].id);
  const dp = build({ kind: "depot", depotSiteId: depot.depotSiteId }, {}, depotExport).site;
  assert.equal(JSON.stringify(dp.polygon), JSON.stringify(depot.polygon));
  assert.equal(dp.connectedDepotSiteId, depot.depotSiteId);
  assert.equal(dp.connectedPlanId, depot.connectedPlanId);
});

// --- crossings, overlaps, candidates ---
test("buildings, water and roads overlapping the corridor are counted; crossing locations are reported for line kinds", () => {
  const buildings = polygonLayer([{ rings: sq(139.0021, 34.9995), kind: "yes" }], { quality: "high", source: source("b") });
  const water = polygonLayer([{ rings: [[[139.005, 34.997], [139.005, 35.003], [139.0055, 35.003], [139.0055, 34.997], [139.005, 34.997]]] }], { quality: "medium", source: source("w") });
  const roads = roadLayerFromGeojson({ features: [{ geometry: { coordinates: [[139, 34.9993], [139.02, 34.9993]] }, properties: { roadClass: "major" } }] }, { quality: "high", source: source("r") });
  const s = build(tunnel({ segmentIds: [seg0.id, seg1.id] }), { buildings, water, roads }).site;
  assert.equal(s.intersectedBuildingCount, 1);
  assert.equal(s.waterCrossingCount, 1);
  assert.equal(s.waterCrossings.length, 2, "entry and exit points are both reported");
  assert.equal(s.waterCrossings[0].location.length, 2);
  assert.ok(s.spatialFlags.includes("crosses-water"));
  assert.ok(s.spatialFlags.includes("building-collision"));
});

test("work areas sit at both corridor ends, material yards are spaced along it, and road/vehicle access candidates come from the boundary", () => {
  const roads = roadLayerFromGeojson({ features: [{ geometry: { coordinates: [[139, 34.9993], [139.02, 34.9993]] }, properties: { roadClass: "major" } }, { geometry: { coordinates: [[139, 35.0006], [139.02, 35.0006]] }, properties: { roadClass: "minor" } }] }, { quality: "high", source: source("r") });
  const s = build(tunnel({ segmentIds: [seg0.id, seg1.id] }), { roads }).site;
  assert.deepEqual(s.workAreaCandidates.map((w) => w.slot).sort(), ["end", "start"]);
  assert.ok(s.materialYardCandidates.length >= 1);
  assert.ok(s.accessRoadCandidates.length > 0);
  assert.ok(s.vehicleAccessCandidates.every((c) => c.nearestRoad.roadClass === "major"), "vehicle access only offers a real (major/highway) road");
  assert.ok(s.accessRoadCandidates.some((c) => c.nearestRoad.roadClass === "minor"), "construction-road access allows a minor road too");
});

test("existing railway crossings use the pack's existing network (withRailLayer), not a hand-supplied layer", () => {
  const acrossExisting = { kind: "tunnel", planId: plan.planId, segmentIds: [seg0.id] }; // seg0 runs d0->d1, exactly the existing E1 line
  const s = buildConstructionExport({ pack, mapExport, packages: [acrossExisting] }).sites[0];
  assert.equal(s.existingRailwayCrossingCount, 0, "running along the same stations is not a crossing (endpoints only touch)");
});

// --- connection validation ---
test("the connection is checked against the plan / station / depot the map exported", () => {
  const missingPlan = build(tunnel({ planId: "plan:nope" }));
  assert.equal(missingPlan.site, null);
  assert.ok(missingPlan.warnings.some((w) => w.code === "connection-plan-missing"));
  const missingSeg = build(tunnel({ segmentIds: ["seg:nope"] }));
  assert.equal(missingSeg.site, null);
  assert.ok(missingSeg.warnings.some((w) => w.code === "connection-segment-missing"));
  const missingStation = build({ kind: "station", planId: plan.planId, stationId: "stn:nope" });
  assert.equal(missingStation.site, null);
  assert.ok(missingStation.warnings.some((w) => w.code === "connection-station-missing"));
  const missingDepot = build({ kind: "depot", depotSiteId: "depot:nope" }, {}, depotExport);
  assert.equal(missingDepot.site, null);
  assert.ok(missingDepot.warnings.some((w) => w.code === "connection-depot-missing"));
  const badKind = build({ kind: "bogus", planId: plan.planId, segmentIds: [seg0.id] });
  assert.equal(badKind.site, null);
  assert.equal(badKind.warnings[0].code, "package-kind-invalid");
});

test("non-contiguous segments still produce a corridor (from the ones given), with a warning", () => {
  const s = build(tunnel({ segmentIds: [seg0.id, seg2.id] }));
  assert.ok(s.site !== null);
  assert.ok(s.warnings.some((w) => w.code === "package-not-contiguous"));
});

test("an export never repeats a site, and reports a package with no resolvable geometry", () => {
  const out = buildConstructionExport({ pack, mapExport, packages: [tunnel(), tunnel({ name: "again" }), { key: "nowhere", kind: "station", planId: plan.planId, stationId: "stn:nope" }] });
  assert.equal(out.schema, CONSTRUCTION_EXPORT_SCHEMA);
  assert.equal(out.sites.length, 1);
  assert.deepEqual(out.warnings.map((w) => w.code), ["duplicate-construction-site", "construction-no-geometry", "connection-station-missing"], "the underlying cause follows the summary warning");
});

// --- display: phase, progress split, markers, read-only ---
test("a package's phase falls back to its plan's project status when the engine has no package-level detail", () => {
  const exp = buildConstructionExport({ pack, mapExport, packages: [tunnel()] });
  const report = (status, extra = {}) => ({ projects: [{ planId: plan.planId, status, ...extra }] });
  assert.equal(buildConstructionView(exp, {}).sites[0].phase, null, "no report, no phase");
  assert.equal(buildConstructionView(exp, report("estimated")).sites[0].phase, "beforeStart");
  assert.equal(buildConstructionView(exp, report("underConstruction")).sites[0].phase, "underConstruction");
  assert.equal(buildConstructionView(exp, report("underConstruction", { delayMonths: 2 })).sites[0].phase, "delayed");
  assert.equal(buildConstructionView(exp, report("suspended")).sites[0].phase, "suspended");
  assert.equal(buildConstructionView(exp, report("inspection")).sites[0].phase, "testing");
  assert.equal(buildConstructionView(exp, report("available")).sites[0].phase, "complete");
  assert.equal(buildConstructionView(exp, report("cancelled")).sites[0].phase, "cancelled");
  assert.notEqual(PACKAGE_PHASES.suspended.color, PACKAGE_PHASES.cancelled.color, "a pause and an end are not the same colour");
});

test("package-level detail from the engine (report.constructionPackages) overrides the plan fallback", () => {
  const exp = buildConstructionExport({ pack, mapExport, packages: [tunnel()] });
  const report = { projects: [{ planId: plan.planId, status: "estimated" }], constructionPackages: { [exp.sites[0].constructionSiteId]: { status: "underConstruction", progress: 0.5 } } };
  const v = buildConstructionView(exp, report).sites[0];
  assert.equal(v.phase, "underConstruction");
  assert.equal(v.progress, 0.5);
});

test("progress under construction splits the corridor into a finished and an unfinished ring", () => {
  const exp = buildConstructionExport({ pack, mapExport, packages: [tunnel({ segmentIds: [seg0.id, seg1.id] })] });
  const v = buildConstructionView(exp, { projects: [{ planId: plan.planId, status: "underConstruction", progress: 0.5 }] }).sites[0];
  assert.ok(v.doneRing?.length >= 4 && v.remainingRing?.length >= 4, "both halves are still valid polygons");
  const beforeStart = buildConstructionView(exp, { projects: [{ planId: plan.planId, status: "estimated" }] }).sites[0];
  assert.equal(beforeStart.doneRing, null, "no split before construction starts");
});

test("incident / complaint / material-shortage markers are shown exactly as the engine reported them", () => {
  const exp = buildConstructionExport({ pack, mapExport, packages: [tunnel()] });
  const id = exp.sites[0].constructionSiteId;
  const report = { constructionMarkers: [{ constructionSiteId: id, kind: "incident", message: "화재" }, { constructionSiteId: id, kind: "complaint", location: [139.001, 35.0001] }] };
  const v = buildConstructionView(exp, report).sites[0];
  assert.equal(v.markers.length, 2);
  assert.equal(v.markers[0].kind, "incident");
  assert.equal(v.markers[0].message, "화재");
  assert.deepEqual(v.markers[1].at, [139.001, 35.0001]);
});

function deepFreeze(o) { if (o && typeof o === "object" && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; }
const recorder = () => {
  const calls = [];
  const ctx = new Proxy({}, { get: (t, k) => (k in t ? t[k] : k === "measureText" ? () => ({ width: 40 }) : (...args) => calls.push([k, ...args])), set: (t, k, v) => { t[k] = v; calls.push(["set", k, v]); return true; } });
  return { calls, ctx };
};
const fakeBox = () => { const doc = { createElement: (tag) => ({ tag, children: [], style: {}, className: "", textContent: "", hidden: false, ownerDocument: doc, append(...c) { this.children.push(...c); }, replaceChildren(...c) { this.children = c; } }) }; return doc.createElement("div"); };

test("the view and drawing only read a frozen export and report", () => {
  const exp = deepFreeze(buildConstructionExport({ pack, mapExport, packages: [tunnel()], spatial: makeSpatialContext({ dem }) }));
  const report = deepFreeze({ projects: [{ planId: plan.planId, status: "underConstruction", progress: 0.3 }] });
  const before = JSON.stringify(exp);
  const model = buildConstructionView(exp, report);
  const screen = ([lon, lat]) => [(lon - 139) * 1e5, -(lat - 35) * 1e5];
  drawConstructionOverlay(recorder().ctx, model, screen);
  renderConstructionPanel(fakeBox(), model);
  renderConstructionLegend(fakeBox());
  assert.equal(JSON.stringify(exp), before);
});

test("the overlay draws a phase colour and legend rows for every phase", () => {
  const exp = buildConstructionExport({ pack, mapExport, packages: [tunnel()] });
  const model = buildConstructionView(exp, { projects: [{ planId: plan.planId, status: "underConstruction" }] });
  const r = recorder();
  const screen = ([lon, lat]) => [(lon - 139) * 1e5, -(lat - 35) * 1e5];
  drawConstructionOverlay(r.ctx, model, screen);
  assert.ok(r.calls.some((c) => c[0] === "set" && c[1] === "fillStyle" && c[2] === PACKAGE_PHASES.underConstruction.color));
  const box = fakeBox();
  renderConstructionLegend(box, PACKAGE_PHASES);
  assert.equal(box.children.filter((c) => c.className === "phase-legend-row").length, Object.keys(PACKAGE_PHASES).length);
});

// --- boundary: never touches the management engine or the file system ---
test("construction modules do not import the management engine or touch cash, construction state or files", () => {
  for (const f of ["construction-site.mjs", "construction-editor.mjs", "construction-view.mjs", "construction-ui.mjs"]) {
    const src = fs.readFileSync(path.join(root, "engine/src/map", f), "utf8");
    for (const m of src.matchAll(/from "([^"]+)"/g)) assert.match(m[1], /^\.\/[a-z-]+\.mjs$|^\.\.\/(projection|geometry)\.mjs$/, `${f} imports ${m[1]}`);
    assert.doesNotMatch(src, /ledger|\.commit\(|\.settle\(|\.post\(|node:fs/, `${f} must not reach engine state or the file system`);
    assert.ok(src.length < 40_000, `${f} holds code, not data`);
  }
});

// --- shipped examples (packs/<id>/construction-examples), tied to plan / station / depot examples ---
const files = (id, kind, ext) => fs.readdirSync(path.join(root, "packs", id, kind)).filter((f) => f.endsWith(ext)).sort();
const loadExamples = (id) => ({
  manifest: readJson(`packs/${id}/manifest.json`),
  plans: files(id, "plan-examples", ".plan.json").map((f) => readJson(`packs/${id}/plan-examples/${f}`)),
  depots: fs.existsSync(path.join(root, "packs", id, "depot-examples")) ? files(id, "depot-examples", ".depot.json").map((f) => readJson(`packs/${id}/depot-examples/${f}`)) : [],
  sites: files(id, "construction-examples", ".construction.json").map((f) => ({ file: f, site: readJson(`packs/${id}/construction-examples/${f}`) })),
});
const IDS = ["tokyo", "example-radial", "example-corridor"];

test("Tokyo and the synthetic pack each ship the construction-package kinds asked for", () => {
  for (const id of ["tokyo", "example-radial"]) {
    const { sites } = loadExamples(id);
    assert.ok(sites.length >= 7, `${id}: ${sites.length}`);
    const kinds = new Set(sites.map((x) => x.site.kind));
    for (const k of ["tunnel", "cutCover", "viaduct", "station", "depot"]) assert.ok(kinds.has(k), `${id}: ${k}`);
    assert.ok(sites.some((x) => x.site.waterCrossingCount > 0), `${id}: a river crossing`);
    assert.ok(sites.some((x) => x.site.distanceToResidentialMeters !== null && x.site.distanceToResidentialMeters <= 100), `${id}: near residential`);
    assert.ok(sites.some((x) => x.site.shaftCandidates.length > 0), `${id}: a deep tunnel with shafts`);
    assert.ok(sites.some((x) => x.site.unknown.length > 0 && x.site.unknownReasons[x.site.unknown[0]]), `${id}: a site with missing layers`);
  }
});

test("every example connects to a plan / station / depot that exist in the same pack's other examples", () => {
  for (const id of IDS) {
    const { plans, depots, sites } = loadExamples(id);
    for (const { file, site: s } of sites) {
      if (s.connectedPlanId) {
        const p = plans.find((x) => x.planId === s.connectedPlanId);
        assert.ok(p, `${id}/${file}: plan ${s.connectedPlanId}`);
        for (const sid of s.connectedSegmentIds) assert.ok(p.segments.some((x) => x.id === sid), `${id}/${file}: segment ${sid}`);
        if (s.connectedStationId) assert.ok(p.stationCandidates.some((x) => x.id === s.connectedStationId), `${id}/${file}: station ${s.connectedStationId}`);
      }
      if (s.connectedDepotSiteId) assert.ok(depots.some((x) => x.depotSiteId === s.connectedDepotSiteId), `${id}/${file}: depot ${s.connectedDepotSiteId}`);
      assert.equal(s.constructionSiteId, keyedConstructionSiteId(id, s.source.drawnPackage.key), "the id follows the saved key");
    }
  }
});

test("examples keep unknowns null with a reason, carry the pack license, and have no cost or score fields", () => {
  for (const id of IDS) {
    const { manifest, sites } = loadExamples(id);
    for (const { file, site: s } of sites) {
      assert.equal(s.schema, CONSTRUCTION_SITE_SCHEMA);
      assert.equal(s.license.pack, manifest.data.license, `${id}/${file}`);
      for (const f of s.unknown) assert.ok(s.unknownReasons[f], `${id}/${file}: ${f} needs a reason`);
      assert.notEqual(s.dataQuality, "high");
      for (const k of keysOf(s)) assert.doesNotMatch(k, forbidden, `${id}/${file}: field ${k}`);
    }
  }
  const tokyo = loadExamples("tokyo").sites.map((x) => x.site);
  assert.ok(tokyo.flatMap((s) => s.sourceLayers).some((l) => l.license === "ODbL-1.0"));
  assert.ok(tokyo.every((s) => s.license.pack === "ODbL-1.0"), "OSM-derived facts only ship under the pack's ODbL");
});

test("synthetic-pack examples regenerate byte-for-byte from their saved packages", async () => {
  for (const id of ["example-radial", "example-corridor"]) {
    const { manifest, plans, sites } = loadExamples(id);
    const demand = readJson(`packs/${id}/${manifest.files.demand}`);
    const p = { manifest, demand };
    const mExp = { plans, externalNetworks: [] };
    const depotDir = path.join(root, "packs", id, "depot-examples");
    const dExp = fs.existsSync(depotDir) ? { schema: "transitline.depot-export/1", packId: id, packVersion: manifest.version, sites: loadExamples(id).depots, warnings: [] } : null;
    const { syntheticLayers } = await import("../../scripts/lib/synthetic-layers.mjs");
    for (const { file, site: s } of sites) {
      const { source: src, ...body } = s;
      const layers = src.layers.kind === "synthetic-layers" ? syntheticLayers(src.layers.centre, src.layers.options) : {};
      const fresh = buildConstructionExport({ pack: p, mapExport: mExp, depotExport: dExp, packages: [src.drawnPackage], spatial: makeSpatialContext(layers) }).sites[0];
      assert.equal(JSON.stringify(fresh), JSON.stringify(body), `${id}/${file} is stale: run npm run construction-examples`);
    }
  }
});
