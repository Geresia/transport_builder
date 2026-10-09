import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  LAND_USE_SUGGESTIONS, NEW_TOWN_EXPORT_SCHEMA, NEW_TOWN_SCHEMA, NOT_MODELLED, SPATIAL_FLAGS, buildNewTownDevelopment, buildNewTownDevelopmentExport, keyedDevelopmentId, keyedPhaseId,
} from "../src/map/new-town-development.mjs";
import { makeSpatialContext, polygonLayer, roadLayerFromGeojson, waterLayerFromBarriers } from "../src/map/spatial.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..", "..");
const json = (value) => JSON.stringify(value);
const rect = (x, y, w, h) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
const deepFreeze = (value) => { if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); for (const inner of Object.values(value)) deepFreeze(inner); } return value; };

const pack = () => ({
  manifest: { id: "nt-test", version: "1", bbox: [-0.1, -0.1, 0.1, 0.1], data: { license: "CC0-1.0", attribution: ["© test"] } },
  demand: { points: [{ id: "n-far", location: [0.05, 0.05], residents: 900, jobs: 40 }, { id: "n-near", location: [-0.001, 0.005], residents: 10, jobs: 5 }] },
});
// ~1113 m per 0.01 degree at the equator: every distance below is checked against that
const A = rect(0, 0, 0.01, 0.01);
const mapExport = () => ({
  plans: [{ planId: "plan:1", stationCandidates: [{ id: "stn:in", location: [0.005, 0.005] }, { id: "stn:out", location: [0.02, 0.005] }], segments: [{ id: "seg:1", alignment: [[0.02, 0.005], [0.03, 0.005]] }] }],
  externalNetworks: [{
    id: "ext:1",
    stations: [{ id: "e1", location: [-0.0045, 0.005] }, { id: "e2", location: [-0.0045, 0.02] }, { id: "c1", location: [-0.005, 0.005] }, { id: "c2", location: [0.015, 0.005] }, { id: "f1", location: [0.2, 0.2] }, { id: "f2", location: [0.21, 0.2] }],
    lines: [{ id: "L-near", stationIds: ["e1", "e2"] }, { id: "L-cross", stationIds: ["c1", "c2"] }, { id: "L-far", stationIds: ["f1", "f2"] }],
  }],
});
const layers = (over = {}) => ({
  water: waterLayerFromBarriers({ barriers: [{ kind: "water", polygon: [rect(0.008, 0.008, 0.004, 0.004)] }, { kind: "water", polygon: [rect(0.05, 0.05, 0.01, 0.01)] }] }, { quality: "medium", source: { name: "stub water", license: "x" } }),
  roads: roadLayerFromGeojson({ features: [{ geometry: { coordinates: [[0.005, -0.01], [0.005, 0.02]] }, properties: { roadClass: "major" } }, { geometry: { coordinates: [[0.0125, 0], [0.0125, 0.01]] }, properties: { roadClass: "minor" } }] }, { quality: "high", source: { name: "stub roads", license: "x" } }),
  buildings: polygonLayer([{ rings: [rect(0.002, 0.002, 0.001, 0.001)], kind: "house" }], { quality: "high", source: { name: "stub buildings", license: "x" } }),
  dem: { elevationAt: () => 10, slopeAt: () => 2, quality: "medium", source: { name: "stub dem", license: "x" } },
  ...over,
});
const drawn = (over = {}) => ({
  key: "town-1", name: "Test town",
  phases: [
    { key: "phase-1", name: "First", sequence: 1, polygon: A, playerDeclaredLandUse: "housing", playerDeclaredDeliveryOrder: 1, access: { stationRefs: [{ stationId: "stn:in" }], railRefs: [{ externalLineId: "L-near" }] } },
    { key: "phase-2", name: "Second", sequence: 2, polygon: rect(0.02, 0.0, 0.006, 0.006), playerDeclaredLandUse: "employment" },
  ],
  ...over,
});
const one = (d, { spatial = makeSpatialContext(layers()), map = mapExport(), p = pack() } = {}) => buildNewTownDevelopment(d, { pack: p, spatial, plans: map.plans, externalNetworks: map.externalNetworks });
const phaseOf = (dev, key) => dev.phases.find((p) => p.key === key);

test("the contract: schema, ids, the development and phase fields, and what each field's absence means", () => {
  const dev = one(drawn());
  assert.deepEqual([dev.schema, dev.contractVersion, dev.sourcePackId, dev.sourcePackVersion, dev.key, dev.active, dev.name], [NEW_TOWN_SCHEMA, 1, "nt-test", "1", "town-1", true, "Test town"]);
  assert.equal(dev.developmentId, keyedDevelopmentId("nt-test", "town-1"));
  assert.match(dev.developmentId, /^new-town:[0-9a-f]{16}$/);
  assert.match(dev.developmentRevision, /^new-town-revision:[0-9a-f]{16}$/);
  for (const field of ["phases", "spatialFlags", "sourceLayers", "dataQuality", "unknown", "unknownReasons", "constraintUnknown", "warnings", "license", "phaseCount", "activePhaseCount", "location", "boundingBox", "phaseAreaSumSquareMeters"]) assert.ok(field in dev, field);
  assert.deepEqual(dev.constraintUnknown, NOT_MODELLED);
  const p = phaseOf(dev, "phase-1");
  assert.equal(p.phaseId, keyedPhaseId(dev.developmentId, "phase-1"));
  assert.match(p.phaseRevision, /^new-town-phase-revision:[0-9a-f]{16}$/);
  for (const field of ["phaseId", "key", "sequence", "active", "polygon", "location", "areaSquareMeters", "perimeterMeters", "playerDeclaredLandUse", "playerDeclaredDeliveryOrder", "railAccessCandidates", "roadAccessCandidates", "stationSiteRefs", "spatialFacts", "sourceLayers", "dataQuality", "unknown", "unknownReasons", "warnings", "spatialFlags"]) assert.ok(field in p, field);
  assert.deepEqual([dev.phases.map((x) => x.sequence), dev.phaseCount, dev.activePhaseCount], [[1, 2], 2, 2]);
  assert.ok(Math.abs(p.areaSquareMeters - 1_239_246) < 1_239_246 * 0.005, `area ${p.areaSquareMeters}`);
  assert.deepEqual([p.playerDeclaredLandUse, p.playerDeclaredDeliveryOrder], ["housing", 1]);
  assert.ok(LAND_USE_SUGGESTIONS.includes("mixed") && SPATIAL_FLAGS.includes("water-overlap"));
  assert.deepEqual(dev.license, { pack: "CC0-1.0", attribution: ["© test"] });
  const out = buildNewTownDevelopmentExport({ pack: pack(), mapExport: mapExport(), developments: [drawn()], spatial: makeSpatialContext(layers()) });
  assert.deepEqual([out.schema, out.packId, out.packVersion, out.warnings, out.developments.length], [NEW_TOWN_EXPORT_SCHEMA, "nt-test", "1", [], 1]);
});

test("ids and JSON are deterministic: the same drawing gives the same bytes, and order, names and storage do not move an id", () => {
  const first = json(one(drawn()));
  for (let i = 0; i < 3; i++) assert.equal(json(one(drawn())), first);
  const dev = one(drawn());
  // phases handed over in another order keep their ids and sequences (the sequence is stated, not the array position)
  const shuffled = drawn();
  shuffled.phases.reverse();
  assert.equal(json(one(shuffled)), first);
  // the map export in another order, layers in another order, the same polygon written another way round and from another vertex
  const map = mapExport();
  map.plans.reverse(); map.externalNetworks[0].stations.reverse(); map.externalNetworks[0].lines.reverse();
  const reversedLayers = layers();
  reversedLayers.roads.items.reverse(); reversedLayers.water.items.reverse();
  const rotated = drawn();
  rotated.phases[0].polygon = [...A].reverse().slice(2).concat([...A].reverse().slice(0, 2));
  assert.equal(json(one(rotated, { map, spatial: makeSpatialContext(reversedLayers) })), first);
  // names are not part of an id or a revision
  const renamed = drawn({ name: "Another name" });
  renamed.phases[0].name = null; renamed.phases[1].name = "Renamed";
  const renamedDev = one(renamed);
  assert.equal(renamedDev.developmentId, dev.developmentId);
  assert.equal(renamedDev.developmentRevision, dev.developmentRevision);
  assert.deepEqual(renamedDev.phases.map((p) => [p.phaseId, p.phaseRevision]), dev.phases.map((p) => [p.phaseId, p.phaseRevision]));
  // redrawing keeps the ids and changes the revision of that phase and of the development
  const moved = drawn();
  moved.phases[1].polygon = rect(0.021, 0.0, 0.006, 0.006);
  const movedDev = one(moved);
  assert.deepEqual(movedDev.phases.map((p) => p.phaseId), dev.phases.map((p) => p.phaseId));
  assert.equal(phaseOf(movedDev, "phase-1").phaseRevision, phaseOf(dev, "phase-1").phaseRevision);
  assert.notEqual(phaseOf(movedDev, "phase-2").phaseRevision, phaseOf(dev, "phase-2").phaseRevision);
  assert.notEqual(movedDev.developmentRevision, dev.developmentRevision);
  // reordering moves the sequences and the revision, never the ids
  const reordered = drawn();
  [reordered.phases[0].sequence, reordered.phases[1].sequence] = [2, 1];
  const reorderedDev = one(reordered);
  assert.deepEqual(reorderedDev.phases.map((p) => [p.key, p.sequence]), [["phase-2", 1], ["phase-1", 2]]);
  assert.deepEqual(reorderedDev.phases.map((p) => p.phaseId).sort(), dev.phases.map((p) => p.phaseId).sort());
  assert.notEqual(reorderedDev.developmentRevision, dev.developmentRevision);
  // developments come out sorted by id whatever order they were drawn in; a duplicate key is reported, not merged
  const a = drawn({ key: "town-a" });
  const b = drawn({ key: "town-b" });
  const forward = buildNewTownDevelopmentExport({ pack: pack(), mapExport: mapExport(), developments: [a, b, drawn({ key: "town-a" })], spatial: makeSpatialContext(layers()) });
  const backward = buildNewTownDevelopmentExport({ pack: pack(), mapExport: mapExport(), developments: [b, a], spatial: makeSpatialContext(layers()) });
  assert.deepEqual(forward.warnings, [{ code: "duplicate-development", developmentId: keyedDevelopmentId("nt-test", "town-a") }]);
  assert.equal(json(forward.developments), json(backward.developments));
  assert.deepEqual(forward.developments.map((d) => d.developmentId), [...forward.developments.map((d) => d.developmentId)].sort());
  // another pack gives other ids
  assert.notEqual(one(drawn(), { p: { ...pack(), manifest: { ...pack().manifest, id: "other" } } }).developmentId, dev.developmentId);
});

test("what lies inside and beside a phase is reported as measurements: stations, rail, roads, water, buildings, ground, pack extent, overlaps", () => {
  const dev = one(drawn({ phases: [drawn().phases[0], { key: "phase-2", sequence: 2, polygon: rect(0.008, 0.0, 0.006, 0.006) }, { key: "phase-3", sequence: 3, polygon: rect(0.05, 0.05, 0.002, 0.002) }, { key: "phase-4", sequence: 4, polygon: rect(0.099, 0.0, 0.004, 0.004) }] }));
  const p1 = phaseOf(dev, "phase-1");
  const f = p1.spatialFacts;
  assert.deepEqual(f.stationsInside, [{ stationId: "stn:in", stationKind: "plan" }]);
  assert.deepEqual(f.nearestPlannedStation, { stationId: "stn:in", distanceMeters: 0 });
  assert.equal(f.nearestExistingStation.stationId, "e1");
  assert.ok(Math.abs(f.nearestExistingStation.distanceMeters - 500.9) < 1, `${f.nearestExistingStation.distanceMeters}`);
  assert.equal(f.waterOverlapCount, 1);
  assert.equal(f.intersectedBuildingCount, 1);
  assert.deepEqual(f.roadsThroughArea, { highway: 0, major: 1, minor: 0 });
  assert.equal(f.withinPackBoundingBox, true);
  assert.equal(f.overlapsPhaseIds.length, 1);
  assert.equal(f.groundElevationMeters, 10);
  assert.equal(f.elevationRangeMeters, 0);
  assert.ok(Math.abs(f.averageSlopePercent - 3.49) < 0.01 && f.maximumSlopePercent === f.averageSlopePercent);
  assert.deepEqual(f.demandNodeRefsInside, [], "no recorded node lies inside: that says nothing about demand");
  assert.equal(f.nearestDemandNode.nodeId, "n-near");
  assert.deepEqual(p1.spatialFlags, ["building-overlap", "overlaps-other-phase", "roads-through-area", "station-inside-area", "water-overlap"]);
  assert.deepEqual(dev.spatialFlags, ["building-overlap", "outside-pack-bbox", "overlaps-other-phase", "roads-through-area", "station-inside-area", "water-overlap"]);
  // rail: relations are distances; the declared line is marked, the far line is not a candidate at all
  const rail = Object.fromEntries(p1.railAccessCandidates.map((c) => [c.externalLineId ?? c.segmentId, c]));
  assert.deepEqual(Object.keys(rail).sort(), ["L-cross", "L-near", "seg:1"]);
  assert.deepEqual([rail["L-cross"].relation, rail["L-cross"].distanceMeters, rail["L-cross"].declaredByPlayer], ["crosses", 0, false]);
  assert.deepEqual([rail["L-near"].relation, rail["L-near"].declaredByPlayer], ["near", true]);
  assert.ok(Math.abs(rail["L-near"].distanceMeters - 500.9) < 1, `${rail["L-near"].distanceMeters}`);
  assert.deepEqual([rail["seg:1"].relation, rail["seg:1"].planId], ["near", "plan:1"]);
  assert.ok(Math.abs(rail["seg:1"].distanceMeters - 1113.2) < 2);
  assert.deepEqual(p1.railAccessCandidates.map((c) => c.distanceMeters), [...p1.railAccessCandidates.map((c) => c.distanceMeters)].sort((x, y) => x - y));
  // roads: through the area first, then the minor road 278 m away
  assert.deepEqual(p1.roadAccessCandidates.map((c) => [c.roadClass, c.relation]), [["major", "through-area"], ["minor", "near"]]);
  assert.ok(Math.abs(p1.roadAccessCandidates[1].distanceMeters - 278.3) < 1);
  assert.match(p1.roadAccessCandidates[0].roadRefId, /^road:[0-9a-f]{16}$/);
  // station sites: what the player named, resolved
  assert.deepEqual(p1.stationSiteRefs, [{ stationId: "stn:in", stationKind: "plan", location: [0.005, 0.005], insideArea: true, distanceMeters: 0 }]);
  // a far phase and one outside the pack extent
  const p3 = phaseOf(dev, "phase-3");
  assert.equal(p3.spatialFacts.waterOverlapCount, 1);
  assert.deepEqual(p3.railAccessCandidates, [], "data present, nothing within the search radius: a declared empty list");
  assert.equal(phaseOf(dev, "phase-4").spatialFacts.withinPackBoundingBox, false);
  assert.equal(phaseOf(dev, "phase-4").spatialFlags.includes("outside-pack-bbox"), true);
  // the development: its area is the sum of the active phases' own areas (overlaps are counted twice, and the field says "sum")
  assert.equal(dev.phaseAreaSumSquareMeters, Math.round(dev.phases.filter((p) => p.active).reduce((s, p) => s + p.areaSquareMeters, 0) * 10) / 10);
  assert.equal(dev.boundingBox.length, 4);
  assert.deepEqual(dev.sourceLayers.map((s) => s.layer), ["buildings", "dem", "demand-nodes", "rail", "roads", "stations", "water"]);
});

test("a missing layer, an uncovered place and an empty answer are three different things: null + reason, null + reason, and a recorded 0 or []", () => {
  const none = one(drawn(), { spatial: makeSpatialContext() });
  const first = phaseOf(none, "phase-1");
  const f = first.spatialFacts;
  assert.deepEqual([f.waterOverlapCount, f.intersectedBuildingCount, f.roadsThroughArea, f.groundElevationMeters, f.averageSlopePercent], [null, null, null, null, null]);
  assert.equal(first.roadAccessCandidates, null);
  for (const field of ["waterOverlapCount", "intersectedBuildingCount", "roadsThroughArea", "roadAccessCandidates", "groundElevationMeters", "elevationRangeMeters", "averageSlopePercent", "maximumSlopePercent"]) assert.equal(first.unknownReasons[field], "no-layer", field);
  assert.deepEqual(first.unknown, [...first.unknown].sort());
  assert.deepEqual(first.spatialFlags, ["station-inside-area"], "only measured flags: no layer means no flag, not a clean bill");
  // a layer that does not cover the area
  const elsewhere = layers({ water: waterLayerFromBarriers({ barriers: [{ kind: "water", polygon: [rect(0.05, 0.05, 0.01, 0.01)] }] }, { covers: ([x, y]) => x > 0.04 && y > 0.04, quality: "medium", source: { name: "far water", license: "x" } }) });
  const outside = phaseOf(one(drawn(), { spatial: makeSpatialContext(elsewhere) }), "phase-1");
  assert.equal(outside.spatialFacts.waterOverlapCount, null);
  assert.equal(outside.unknownReasons.waterOverlapCount, "outside-coverage");
  // a covering layer that holds nothing here: real zeros and an empty list
  const empty = layers({
    water: waterLayerFromBarriers({ barriers: [{ kind: "water", polygon: [rect(0.05, 0.05, 0.01, 0.01)] }] }, { quality: "medium", source: { name: "far water", license: "x" } }),
    roads: roadLayerFromGeojson({ features: [{ geometry: { coordinates: [[0.08, 0.08], [0.09, 0.09]] }, properties: { roadClass: "major" } }] }, { quality: "high", source: { name: "far road", license: "x" } }),
    buildings: polygonLayer([{ rings: [rect(0.06, 0.06, 0.001, 0.001)] }], { quality: "high", source: { name: "far buildings", license: "x" } }),
  });
  const zero = phaseOf(one(drawn(), { spatial: makeSpatialContext(empty) }), "phase-1");
  assert.deepEqual([zero.spatialFacts.waterOverlapCount, zero.spatialFacts.intersectedBuildingCount, zero.spatialFacts.roadsThroughArea, zero.roadAccessCandidates], [0, 0, { highway: 0, major: 0, minor: 0 }, []]);
  assert.equal(zero.spatialFlags.includes("water-overlap") || zero.spatialFlags.includes("building-overlap") || zero.spatialFlags.includes("roads-through-area"), false);
  assert.equal("waterOverlapCount" in zero.unknownReasons, false);
  // the building layer of a few districts (coverage = their bounding boxes) does not cover this area
  const partial = layers({ buildings: polygonLayer([{ rings: [rect(0.002, 0.002, 0.001, 0.001)] }], { covers: ([x, y]) => x < 0.003 && y < 0.003, quality: "high", source: { name: "district buildings", license: "x" } }) });
  assert.equal(phaseOf(one(drawn(), { spatial: makeSpatialContext(partial) }), "phase-1").unknownReasons.intersectedBuildingCount, "outside-coverage");
});

test("data a pack may not have stays unknown: no stations, no rail, no demand points, no pack extent, no existing stations", () => {
  const bare = one(drawn({ phases: [{ key: "phase-1", polygon: A }] }), { map: { plans: [], externalNetworks: [] }, p: { manifest: { id: "nt-test", version: "1" }, demand: { points: [] } } });
  const f = phaseOf(bare, "phase-1").spatialFacts;
  assert.deepEqual([f.stationsInside, f.nearestPlannedStation, f.nearestExistingStation, f.demandNodeRefsInside, f.nearestDemandNode, f.withinPackBoundingBox], [null, null, null, null, null, null]);
  const r = phaseOf(bare, "phase-1");
  assert.deepEqual([r.railAccessCandidates, r.unknownReasons.railAccessCandidates, r.unknownReasons.stationsInside, r.unknownReasons.demandNodeRefsInside, r.unknownReasons.withinPackBoundingBox], [null, "no-rail-data", "no-station-data", "no-demand-nodes-in-pack", "no-pack-bbox"]);
  // only planned stations: the existing ones are unknown, not "none at distance 0"
  const plansOnly = one(drawn({ phases: [{ key: "phase-1", polygon: A }] }), { map: { plans: mapExport().plans, externalNetworks: [] } });
  const g = phaseOf(plansOnly, "phase-1");
  assert.equal(g.spatialFacts.nearestExistingStation, null);
  assert.equal(g.unknownReasons.nearestExistingStation, "no-existing-stations");
  assert.ok(g.spatialFacts.nearestPlannedStation);
  // the pack's demand numbers are never copied: only where the nodes are
  assert.equal(/residents|"jobs"|population/.test(json(one(drawn()))), false);
});

test("what the player declares is kept as stated: unstated is null with a reason, an empty list is a statement, an odd word is reported", () => {
  const dev = one(drawn({ phases: [
    { key: "phase-1", polygon: A },
    { key: "phase-2", polygon: A, playerDeclaredLandUse: "  Housing-ish  ", playerDeclaredDeliveryOrder: 3, access: { stationRefs: [] } },
    { key: "phase-3", polygon: A, playerDeclaredLandUse: "   ", playerDeclaredDeliveryOrder: 0, access: { stationRefs: [{ stationId: "nowhere" }, { stationId: "stn:in" }, { stationId: "stn:in" }, {}] } },
    { key: "phase-4", polygon: A, playerDeclaredLandUse: "x".repeat(65), playerDeclaredDeliveryOrder: 1.5, access: { stationRefs: "stn:in", railRefs: [{ planId: "plan:missing" }, { externalLineId: "L-far" }] } },
  ] }));
  const [p1, p2, p3, p4] = ["phase-1", "phase-2", "phase-3", "phase-4"].map((k) => phaseOf(dev, k));
  assert.deepEqual([p1.playerDeclaredLandUse, p1.playerDeclaredDeliveryOrder, p1.stationSiteRefs], [null, null, null]);
  assert.deepEqual([p1.unknownReasons.playerDeclaredLandUse, p1.unknownReasons.playerDeclaredDeliveryOrder, p1.unknownReasons.stationSiteRefs], ["not-stated", "not-stated", "not-stated"]);
  assert.deepEqual([p2.playerDeclaredLandUse, p2.playerDeclaredDeliveryOrder, p2.stationSiteRefs], ["Housing-ish", 3, []], "an odd word is kept; [] says the player named no station site");
  assert.deepEqual(p2.warnings, [{ code: "land-use-not-in-suggested-vocabulary", value: "Housing-ish" }]);
  assert.equal("stationSiteRefs" in p2.unknownReasons, false);
  assert.deepEqual([p3.playerDeclaredLandUse, p3.playerDeclaredDeliveryOrder, p3.unknownReasons.playerDeclaredLandUse, p3.unknownReasons.playerDeclaredDeliveryOrder], [null, null, "invalid", "invalid"]);
  assert.deepEqual(p3.stationSiteRefs.map((s) => s.stationId), ["stn:in"], "an unknown station is dropped with a warning, a repeated one counted once");
  assert.deepEqual(p3.warnings.map((w) => w.code).sort(), ["delivery-order-not-a-positive-integer", "land-use-invalid", "station-ref-missing", "station-ref-missing"]);
  assert.equal(p4.stationSiteRefs, null);
  assert.equal(p4.unknownReasons.stationSiteRefs, "invalid");
  assert.deepEqual(p4.warnings.map((w) => w.code).sort(), ["delivery-order-not-a-positive-integer", "land-use-invalid", "rail-ref-missing", "station-refs-invalid"]);
  assert.deepEqual(p4.railAccessCandidates.filter((c) => c.declaredByPlayer).map((c) => [c.externalLineId, c.relation]), [["L-far", "beyond-search-radius"]], "a line the player named is shown even where it is far");
  // quality counts only what the map could not tell, never what the player did not say
  assert.equal(p1.dataQuality, "medium");
  assert.equal(phaseOf(one(drawn({ phases: [{ key: "phase-1", polygon: A }] }), { spatial: makeSpatialContext() }), "phase-1").dataQuality, "low");
});

test("a phase with no usable polygon is named for why, and nothing about it becomes 0, false or []", () => {
  const bad = { degenerate: [[0, 0], [0.01, 0], [0.02, 0]], twisted: [[0, 0], [0.01, 0.01], [0.01, 0], [0, 0.02]], text: [["a", 0], [1, 1], [2, 2]], nan: [[0, 0], [NaN, 1], [1, 1]], two: [[0, 0], [1, 1]] };
  const dev = one(drawn({ phases: [
    { key: "phase-1", polygon: A },
    { key: "phase-2" },
    { key: "phase-3", polygon: bad.degenerate },
    { key: "phase-4", polygon: bad.twisted },
    { key: "phase-5", polygon: bad.nan },
    { key: "phase-6", polygon: bad.text },
    { key: "phase-7", polygon: bad.two },
  ] }));
  const reasons = Object.fromEntries(dev.phases.map((p) => [p.key, p.unknownReasons.polygon ?? null]));
  assert.deepEqual(reasons, { "phase-1": null, "phase-2": "no-polygon", "phase-3": "polygon-degenerate", "phase-4": "polygon-self-intersecting", "phase-5": "polygon-invalid-coordinates", "phase-6": "polygon-invalid-coordinates", "phase-7": "polygon-degenerate" });
  for (const key of ["phase-2", "phase-3", "phase-4", "phase-5", "phase-6", "phase-7"]) {
    const p = phaseOf(dev, key);
    assert.deepEqual([p.polygon, p.location, p.areaSquareMeters, p.perimeterMeters, p.railAccessCandidates, p.roadAccessCandidates, p.spatialFacts.waterOverlapCount, p.spatialFacts.overlapsPhaseIds, p.spatialFacts.stationsInside, p.spatialFacts.demandNodeRefsInside], Array(10).fill(null), key);
    assert.deepEqual(p.spatialFlags, [], "no polygon, no flag");
  }
  assert.equal(dev.phaseAreaSumSquareMeters, null);
  assert.equal(dev.unknownReasons.phaseAreaSumSquareMeters, "active-phase-without-polygon");
  assert.equal(dev.dataQuality, "low");
  const partial = dev.warnings.find((w) => w.code === "location-covers-only-phases-with-polygon");
  assert.equal(partial.phaseIds.length, 6, "the development location and box cover only the phase that has a polygon");
  assert.deepEqual(dev.location, phaseOf(dev, "phase-1").location);
});

test("a development with no phase, only switched-off phases, or bad phase keys: unknown with a reason, never 0", () => {
  const empty = one({ key: "town-1" });
  assert.deepEqual([empty.phaseCount, empty.activePhaseCount, empty.phases, empty.location, empty.boundingBox, empty.phaseAreaSumSquareMeters], [0, 0, [], null, null, null]);
  assert.deepEqual([empty.unknownReasons.phaseAreaSumSquareMeters, empty.unknownReasons.location, empty.unknownReasons.boundingBox], ["no-active-phase", "no-active-phase", "no-active-phase"]);
  assert.deepEqual(empty.warnings, [{ code: "development-has-no-phase" }]);
  const off = drawn();
  off.phases.forEach((p) => { p.active = false; });
  const switchedOff = one(off);
  assert.deepEqual([switchedOff.phaseCount, switchedOff.activePhaseCount, switchedOff.phaseAreaSumSquareMeters], [2, 0, null]);
  assert.ok(switchedOff.phases.every((p) => p.active === false && p.areaSquareMeters > 0), "switched-off phases keep their polygon and facts");
  assert.equal(switchedOff.unknownReasons.phaseAreaSumSquareMeters, "no-active-phase");
  // one phase on: only that one counts
  const mixed = drawn();
  mixed.phases[1].active = false;
  const mixedDev = one(mixed);
  assert.equal(mixedDev.phaseAreaSumSquareMeters, phaseOf(mixedDev, "phase-1").areaSquareMeters);
  // phases without a key, with a repeated key, and a development without a key
  const keys = one(drawn({ phases: [{ polygon: A }, { key: "phase-1", polygon: A }, { key: "phase-1", polygon: A }, { key: "  " }] }));
  assert.deepEqual(keys.phases.map((p) => p.key), ["phase-1"]);
  assert.deepEqual(keys.warnings.map((w) => w.code), ["phase-duplicate-key", "phase-no-key", "phase-no-key"]);
  assert.equal(one({ name: "no key" }), null);
  const out = buildNewTownDevelopmentExport({ pack: pack(), developments: [{ name: "no key" }, { key: "" }] });
  assert.deepEqual(out.warnings, [{ code: "development-no-key", name: "no key" }, { code: "development-no-key", name: null }]);
  assert.deepEqual(out.developments, []);
});

test("the inputs are only read: frozen inputs work, nothing is changed and the output shares nothing with them", () => {
  const d = deepFreeze(drawn());
  const map = deepFreeze(mapExport());
  const p = deepFreeze(pack());
  const l = layers();
  const spatial = makeSpatialContext(l);
  const before = json([d, map, p, l.roads.items, l.water.items, l.buildings.items]);
  const dev = one(d, { map, p, spatial });
  assert.equal(json([d, map, p, l.roads.items, l.water.items, l.buildings.items]), before);
  dev.phases[0].polygon.length = 0;
  dev.phases[0].spatialFacts.stationsInside.push("tampered");
  dev.phases[0].railAccessCandidates.length = 0;
  dev.phases[0].sourceLayers[0].name = "tampered";
  dev.sourceLayers.length = 0;
  dev.license.attribution.push("x");
  assert.equal(json(one(d, { map, p, spatial: makeSpatialContext(layers()) })), json(one(drawn())), "a second build is unaffected by changes to the first");
  assert.equal(json([d, map, p]), json([drawn(), mapExport(), pack()]));
  assert.equal(spatial.sources.some((s) => s.name === "tampered"), false, "nor does the spatial context see them");
});

test("no cost, demand, population, price or score is computed or named, no management is imported, and the output holds no clock or random value", () => {
  const dev = one(drawn());
  const keys = [];
  const walk = (value) => { if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) { keys.push(k); walk(v); } };
  walk(dev);
  const banned = new Set(["population", "residents", "jobs", "demand", "cost", "price", "score", "rank", "feasibility", "occupancy", "revenue", "duration", "schedule", "homes", "dwellings", "households", "yield"]);
  const hits = keys.filter((k) => !/^(demandNodeRefsInside|nearestDemandNode)$/.test(k) && k.split(/(?=[A-Z])|-/).some((w) => banned.has(w.toLowerCase())));
  assert.deepEqual(hits, []);
  for (const file of ["new-town-development.mjs", "new-town-development-editor.mjs"]) {
    const src = fs.readFileSync(path.join(here, "..", "src", "map", file), "utf8");
    assert.ok(src.length < 40_000, `${file} holds code, not data`);
    for (const m of src.matchAll(/from "([^"]+)"/g)) assert.match(m[1], /^\.\/[a-z-]+\.mjs$/, `${file} imports ${m[1]}`);
    assert.equal(/management|scenario-runtime|main\.mjs/.test(src.replace(/\/\/.*$/gm, "")), false, file);
    assert.equal(/Math\.random|Date\.now|new Date|performance\.now|localStorage|sessionStorage|indexedDB|node:fs|fetch\(/.test(src.replace(/\/\/.*$/gm, "")), false, file);
  }
  assert.equal(/"(?:time|date|createdAt|updatedAt)"/.test(json(dev)), false);
});

// --- shipped examples ---
const examplesOf = (id) => {
  const dir = path.join(root, "packs", id, "new-town-development-examples");
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".new-town.json")).sort().map((f) => ({ file: f, value: JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) })) : [];
};

test("every pack ships examples (tokyo, radial, corridor) that are valid contracts with their own provenance", () => {
  const all = ["tokyo", "example-radial", "example-corridor"].flatMap((id) => examplesOf(id).map((e) => ({ ...e, id })));
  assert.deepEqual([...new Set(all.map((e) => e.id))].sort(), ["example-corridor", "example-radial", "tokyo"]);
  assert.ok(all.length >= 7, `${all.length} examples`);
  assert.equal(new Set(all.map((e) => e.value.developmentId)).size, all.length, "one id per example");
  for (const { id, file, value } of all) {
    assert.equal(value.schema, NEW_TOWN_SCHEMA, file);
    assert.equal(value.sourcePackId, id, file);
    assert.equal(value.source.generatedBy, "scripts/build-new-town-examples.mjs", file);
    assert.match(value.source.note, /declared, not a statement that anything can be built/, file);
    assert.equal(value.developmentId, keyedDevelopmentId(id, value.key), file);
    assert.ok(value.phases.length >= 1 && value.phases.every((p) => p.phaseId === keyedPhaseId(value.developmentId, p.key)), file);
    assert.deepEqual(value.constraintUnknown, NOT_MODELLED, file);
    assert.deepEqual(value.phases.map((p) => p.sequence), value.phases.map((_, i) => i + 1), file);
    // the editor document it came from names the same keys
    assert.deepEqual(value.source.editorDocument.phases.filter((p) => !p.deleted).map((p) => p.key).sort(), value.phases.map((p) => p.key).sort(), file);
    assert.equal(/"residents"|"jobs"/.test(json(value)), false, file);
  }
  const radial = Object.fromEntries(examplesOf("example-radial").map((e) => [e.file.slice(0, 2), e.value]));
  // synthetic layers say so; examples without layers hold nulls with their reasons; one has measured flags
  assert.ok(radial["01"].sourceLayers.some((s) => /Synthetic/.test(s.name)));
  assert.deepEqual(radial["01"].spatialFlags, ["roads-through-area", "water-overlap"]);
  assert.equal(radial["02"].phases[0].unknownReasons.waterOverlapCount, "no-layer");
  assert.deepEqual(radial["02"].phases.map((p) => [p.key, p.sequence, p.active]), [["phase-4", 1, false], ["phase-1", 2, true], ["phase-2", 3, true]], "a removed phase key is not given out again");
  assert.deepEqual(radial["02"].source.editorDocument.phases.map((p) => [p.key, p.deleted]), [["phase-4", false], ["phase-1", false], ["phase-2", false], ["phase-3", true]]);
  assert.deepEqual([radial["02"].phases[2].polygon, radial["02"].phases[2].areaSquareMeters], [null, null]);
  assert.deepEqual(radial["03"].spatialFlags, ["overlaps-other-phase", "station-inside-area"]);
  const tokyo = examplesOf("tokyo");
  assert.ok(tokyo.every((e) => e.value.source.layers.join() === "water" && e.value.sourceLayers.some((s) => s.layer === "water")));
  assert.ok(tokyo.some((e) => e.value.spatialFlags.includes("water-overlap")));
  assert.ok(tokyo.some((e) => e.value.phases.some((p) => p.railAccessCandidates.some((c) => c.declaredByPlayer && c.externalLineId))), "an example names an existing line");
});

test("the shipped examples regenerate byte for byte from the generator", () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "new-town-examples-"));
  try {
    const run = spawnSync(process.execPath, [path.join(root, "scripts", "build-new-town-examples.mjs"), "--out", out], { cwd: root, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    let count = 0;
    for (const id of ["tokyo", "example-radial", "example-corridor"]) {
      const shipped = examplesOf(id);
      const regenerated = fs.readdirSync(path.join(out, id)).sort();
      assert.deepEqual(regenerated, shipped.map((e) => e.file), id);
      for (const e of shipped) { assert.equal(fs.readFileSync(path.join(out, id, e.file), "utf8"), fs.readFileSync(path.join(root, "packs", id, "new-town-development-examples", e.file), "utf8"), e.file); count++; }
    }
    assert.ok(count >= 7);
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
});
