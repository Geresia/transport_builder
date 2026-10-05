import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { buildMapExport } from "../src/map/plan-geometry.mjs";
import { stableId } from "../src/map/ids.mjs";
import { makeSpatialContext, polygonLayer, roadLayerFromGeojson } from "../src/map/spatial.mjs";
import { buildThroughRoute } from "../src/map/through-route.mjs";
import {
  RAIL_CAPACITY_EXPORT_SCHEMA, RAIL_CAPACITY_GEOMETRY_SCHEMA, buildRailGeometry, buildRailGeometryExport, keyedRailGeometryId, planRevisionOf,
} from "../src/map/rail-capacity-geometry.mjs";
import {
  addBlockBoundary, addDesign, addJunction, addPlatform, addTerminal, addTurnbackTrack, clearBlockBoundaries, clearSectionFact, connectJunction, declareBlockBoundaries,
  declareJunctions, declareTerminals, disconnectJunction, moveBlockBoundary, moveJunction, newRailCapacityDoc, rebindRevisions, removeBlockBoundary, removeDesign,
  removeJunction, removePlatform, removeTerminal, removeTurnbackTrack, restoreRailCapacityDoc, serializeRailCapacityDoc, setSectionFact, toDrawnDesign,
} from "../src/map/rail-capacity-editor.mjs";
import {
  STATE_STYLES, buildRailCapacityView, drawRailCapacityOverlay, renderRailCapacityLegend, renderRailCapacityPanel,
} from "../src/map/rail-capacity-view.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");

// --- fixtures: plans along lat 35. a: 139.00-139.02 (two sections), b continues east, x crosses a north-south at 139.01 ---
const pack = {
  manifest: { id: "t", version: "1", data: { license: "CC0-1.0", attribution: ["test"] } },
  demand: { points: ["d0", "d1", "d2", "d3", "d4"].map((id, i) => ({ id, name: id, location: [139 + i * 0.01, 35] })) },
  existingNetwork: { lines: [{ name: "E1", operator: "Operator X", osmRelationId: 42, stationIds: ["d1", "d2", "d3"] }] },
};
const line = (key, pts) => ({ key, name: key, vertices: pts.map((location) => ({ location, platformType: "side" })) });
const mapExport = buildMapExport({
  pack, mode: "existing",
  drawnLines: [line("a", [[139, 35], [139.01, 35], [139.02, 35]]), line("b", [[139.02, 35], [139.03, 35], [139.04, 35]]), line("x", [[139.01, 34.99], [139.01, 35], [139.01, 35.01]])],
});
const planOf = (key) => mapExport.plans.find((p) => p.planId === stableId("plan", "t", "key", key));
const A = planOf("a");
const B = planOf("b");
const X = planOf("x");
const ref = (plan, i) => ({ planId: plan.planId, segmentId: plan.segments[i].id });
const revisionsOf = (...plans) => ({ plans: Object.fromEntries(plans.map((p) => [p.planId, planRevisionOf(p)])), routes: {} });
const EXT = "ext-line:42";
const E = [139.02, 35]; // the end of a, the terminal
const ctxOf = (extra = {}) => ({ pack, plans: mapExport.plans, externalNetworks: [], routes: [], ...extra });
const design = (extra = {}) => ({ key: "d1", name: "design", planIds: [A.planId], designedRevisions: revisionsOf(A), ...extra });
const build = (drawn, extra = {}) => {
  const out = buildRailGeometry(drawn, ctxOf(extra));
  assert.ok(out.design, JSON.stringify(out.warnings));
  return out.design;
};
const rejected = (drawn, code, extra = {}) => {
  const out = buildRailGeometry(drawn, ctxOf(extra));
  assert.equal(out.design, null);
  assert.equal(out.warnings[0].code, code);
  return out.warnings[0];
};
const sectionOf = (d, plan, i) => d.sections.find((s) => s.planId === plan.planId && s.segmentId === plan.segments[i].id);
const player = (plan, i, fact) => ({ ref: ref(plan, i), basis: "player", ...fact });
const boundary = (key, plan, i, from, alongMeters, extra = {}) => ({ key, planId: plan.planId, segmentId: plan.segments[i].id, measuredFromStationId: from === "from" ? plan.segments[i].from : plan.segments[i].to, alongMeters, basis: "player", ...extra });
const turnout = (key, location, connections) => ({ key, kind: "turnout", location, connections });
const everywhere = () => true;
const src = (name) => ({ name, license: "CC0-1.0" });
const layersOf = (spec = {}) => makeSpatialContext({
  ...(spec.buildings ? { buildings: polygonLayer(spec.buildings.map((r) => ({ rings: [r], kind: "yes" })), { covers: everywhere, quality: "medium", source: src("test buildings") }) } : {}),
  ...(spec.water ? { water: polygonLayer(spec.water.map((r) => ({ rings: [r] })), { covers: everywhere, quality: "medium", source: src("test water") }) } : {}),
  ...(spec.roads ? { roads: roadLayerFromGeojson({ features: spec.roads.map((c) => ({ geometry: { coordinates: c }, properties: { roadClass: "minor" } })) }, { covers: everywhere, quality: "high", source: src("test roads") }) } : {}),
});
const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];
const keysDeep = (value, found = new Set()) => {
  if (Array.isArray(value)) value.forEach((v) => keysDeep(v, found));
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) { found.add(k); keysDeep(v, found); }
  return found;
};
// keys that carry an id (unknownReasons paths such as "section:rail-section:<hash>:field") are paths, not field names
const FORBIDDEN = /trainsPerHour|capacity|headway|timetable|verdict|possible|conditional|approval|probability|score|delay|cost|price|fee|cash|duration|cycleTime|turnaround|throughput/i;
const deepFreeze = (o) => { if (o && typeof o === "object") { Object.values(o).forEach(deepFreeze); Object.freeze(o); } return o; };
// every item carrying `unknown` lists exactly the fields in `unknownReasons`, and each of those fields holds null
function assertUnknownContract(value, where = "design") {
  if (Array.isArray(value)) return value.forEach((v, i) => assertUnknownContract(v, `${where}[${i}]`));
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value.unknown) && value.unknownReasons && typeof value.unknownReasons === "object") {
    assert.deepEqual([...value.unknown].sort(), Object.keys(value.unknownReasons).sort(), `${where}: unknown and unknownReasons are 1:1`);
    for (const f of value.unknown) {
      if (!f.includes(":")) assert.ok(value[f] === null || value[f] === undefined, `${where}.${f} is unknown so it must be null`);
      assert.equal(typeof value.unknownReasons[f], "string", `${where}.${f} has a reason`);
    }
  }
  for (const [k, v] of Object.entries(value)) if (k !== "unknown" && k !== "unknownReasons" && k !== "warnings") assertUnknownContract(v, `${where}.${k}`);
}

// --- identity ---
test("same input gives the same railGeometryId and byte-identical JSON", () => {
  const drawn = design({ sectionFacts: [player(A, 0, { directionMode: "double" })], blockBoundaries: [boundary("b1", A, 0, "from", 300)], junctions: [], terminals: [] });
  const d = build(drawn);
  assert.equal(JSON.stringify(d), JSON.stringify(build(structuredClone(drawn))));
  assert.equal(d.railGeometryId, keyedRailGeometryId("t", "d1"));
  assert.equal(d.schema, RAIL_CAPACITY_GEOMETRY_SCHEMA);
  assert.equal(d.contractVersion, 1);
  assert.deepEqual(d.planIds, [A.planId]);
  assert.deepEqual(d.planRevisions, [{ planId: A.planId, planRevision: planRevisionOf(A) }]);
});

test("names and the order of plans, facts, boundaries, junction connections and platforms change no id or output", () => {
  const sections = [ref(A, 0), ref(A, 1)];
  const make = (flip) => {
    const o = (list) => (flip ? [...list].reverse() : list);
    return design({
      name: flip ? "other name" : "name", planIds: o([A.planId, X.planId]), designedRevisions: revisionsOf(A, X),
      sectionFacts: o([player(A, 0, { directionMode: "double" }), player(A, 1, { directionMode: "single" })]),
      blockBoundaries: o([boundary("b1", A, 0, "from", 300), boundary("b2", A, 0, "from", 600)]),
      junctions: [{ key: "j1", kind: "crossing", location: [139.01, 35], connections: o([{ ...sections[0], role: "a1" }, { ...sections[1], role: "a2" }, { ...ref(X, 0), role: "b1" }, { ...ref(X, 1), role: "b2" }]) }],
      terminals: [{ key: "t1", stationId: A.segments[1].to,
        platforms: o([{ key: "p1", approach: ref(A, 1), polyline: [E, [139.0212, 35]], platformLengthMeters: 120 }, { key: "p2", approach: ref(A, 1), polyline: [[139.0212, 35.0001], E], platformLengthMeters: 100 }]),
        turnbackTracks: o([{ key: "s1", kind: "stabling", polyline: [[139.0185, 35], [139.0185, 34.9993]] }]) }],
    });
  };
  const one = build(make(false));
  const two = build(make(true));
  assert.equal(JSON.stringify({ ...two, name: one.name, warnings: [] }), JSON.stringify({ ...one, warnings: [] }));
  assert.equal(one.railGeometryRevision, build({ ...make(false), name: "renamed" }).railGeometryRevision, "a name is not a spatial fact");
  const ids = (list, f) => list.map((x) => x[f]);
  for (const [list, f] of [[one.sections, "sectionId"], [one.blocks, "blockId"], [one.signalCandidates, "signalCandidateId"], [one.junctions, "junctionResourceId"], [one.terminals, "terminalResourceId"]]) assert.deepEqual(ids(list, f), [...ids(list, f)].sort(), f);
});

test("a boundary measured from either end station is the same boundary; a reversed platform polyline is the same platform", () => {
  const s = A.segments[0];
  const fromStart = build(design({ blockBoundaries: [boundary("b1", A, 0, "from", 300)] }));
  const fromEnd = build(design({ blockBoundaries: [boundary("b1", A, 0, "to", s.lengthMeters - 300)] }));
  assert.equal(JSON.stringify(fromStart.blocks), JSON.stringify(fromEnd.blocks));
  assert.equal(JSON.stringify(fromStart.signalCandidates), JSON.stringify(fromEnd.signalCandidates));
  const terminal = (poly) => design({ terminals: [{ key: "t1", stationId: A.segments[1].to, platforms: [{ key: "p1", approach: ref(A, 1), polyline: poly, platformLengthMeters: 120 }] }] });
  assert.equal(JSON.stringify(build(terminal([E, [139.0212, 35]])).terminals), JSON.stringify(build(terminal([[139.0212, 35], E])).terminals));
});

test("a keyed design keeps its id when edited; a keyless one follows the plans (and route), never the drawing", () => {
  const before = build(design());
  const edited = build(design({ sectionFacts: [player(A, 0, { directionMode: "single" })], blockBoundaries: [] }));
  assert.equal(edited.railGeometryId, before.railGeometryId);
  assert.notEqual(edited.railGeometryRevision, before.railGeometryRevision);
  assert.notEqual(build(design({ key: "other" })).railGeometryId, before.railGeometryId);
  const keyless = (extra) => build({ planIds: [A.planId], designedRevisions: revisionsOf(A), ...extra });
  assert.equal(keyless({ name: "x" }).railGeometryId, keyless({ sectionFacts: [player(A, 0, { directionMode: "double" })] }).railGeometryId);
  assert.equal(keyless().railGeometryId, stableId("rail-geometry", "t", A.planId));
  const two = (planIds) => build({ planIds, designedRevisions: revisionsOf(A, B) }).railGeometryId;
  assert.equal(two([A.planId, B.planId]), two([B.planId, A.planId]));
});

test("plan, external line, through route, junction and terminal links are validated", () => {
  rejected({ key: "k" }, "plans-missing");
  rejected(design({ planIds: ["plan:nope"] }), "plan-missing");
  rejected(design({ planIds: [A.planId] }), "plan-other-pack", { pack: { manifest: { id: "other", version: "1" } } });
  rejected(design({ externalLineIds: ["ext-line:nope"] }), "external-line-missing");
  rejected(design({ throughRouteId: "through-route:nope" }), "through-route-missing");
  const w = (drawn, code) => { const d = build(drawn); assert.ok(d.warnings.some((x) => x.code === code), `${code} in ${JSON.stringify(d.warnings.map((x) => x.code))}`); return d; };
  w(design({ junctions: [turnout("j", E, [{ planId: "plan:nope", segmentId: "seg:nope", role: "stem" }])] }), "junction-section-missing");
  w(design({ junctions: [{ key: "j", kind: "wye", location: E, connections: [] }] }), "junction-kind-invalid");
  w(design({ junctions: [{ key: "j", kind: "turnout", location: ["x", 1], connections: [] }] }), "junction-location-invalid");
  w(design({ junctions: [turnout("j", E, [{ ...ref(A, 1), role: "bogus" }])] }), "junction-role-invalid");
  w(design({ junctions: [turnout("j", E, [{ ...ref(A, 0), role: "stem" }, { ...ref(A, 1), role: "stem" }])] }), "junction-role-duplicate");
  w(design({ junctions: [{ ...turnout("j", E, [{ ...ref(A, 1), role: "stem" }]), handoverId: "through-handover:nope" }] }), "junction-handover-missing");
  w(design({ terminals: [{ key: "t", stationId: "stn:nope" }] }), "terminal-station-missing");
  w(design({ terminals: [{ key: "t", stationId: A.segments[1].to, platforms: [{ key: "p", approach: { planId: "plan:nope", segmentId: "x" }, polyline: [E, [139.021, 35]] }] }] }), "platform-approach-missing");
  w(design({ terminals: [{ key: "t", stationId: A.segments[1].to, platforms: [{ key: "p", approach: ref(A, 1), polyline: [E] }] }] }), "platform-polyline-invalid");
  w(design({ terminals: [{ key: "t", stationId: A.segments[1].to, turnbackTracks: [{ key: "s", kind: "siding", polyline: [E, [139.021, 35]] }] }] }), "turnback-kind-invalid");
  w(design({ sectionFacts: [{ ref: { planId: "plan:nope", segmentId: "x" }, directionMode: "single", basis: "player" }] }), "section-fact-section-missing");
  const batch = buildRailGeometryExport({ pack, mapExport, designs: [design(), design(), design({ key: "bad", planIds: ["plan:nope"] })] });
  assert.equal(batch.schema, RAIL_CAPACITY_EXPORT_SCHEMA);
  assert.equal(batch.designs.length, 1);
  assert.deepEqual(batch.warnings.map((x) => x.code), ["duplicate-rail-geometry", "rail-geometry-rejected"]);
});

test("a through route and a station site link by id: legs of each section, the station site of a terminal", () => {
  const route = buildThroughRoute({ key: "r", legs: [{ sourceKind: "planned", planId: A.planId }, { sourceKind: "planned", planId: B.planId }] }, { pack, plans: mapExport.plans, externalNetworks: mapExport.externalNetworks }).route;
  const d = build(design({ planIds: [A.planId, B.planId], throughRouteId: route.throughRouteId, designedRevisions: { ...revisionsOf(A, B), routes: { [route.throughRouteId]: route.geometryRevision } } }), { routes: [route] });
  assert.equal(d.throughRouteId, route.throughRouteId);
  assert.equal(d.routeGeometryRevision, route.geometryRevision);
  assert.deepEqual(sectionOf(d, A, 0).throughLegIds, [route.legs[0].legId]);
  assert.deepEqual(sectionOf(d, B, 0).throughLegIds, [route.legs[1].legId]);
  assert.equal(build(design()).sections[0].throughLegIds, null, "without a route there is no leg to link");
  assert.equal(build(design()).sections[0].unknownReasons.throughLegIds, "no-through-route");
  const withSite = build(design({ terminals: [{ key: "t1", stationId: A.segments[1].to }] }), { stationSites: [{ stationSiteId: "stn-site:1", connectedStationId: A.segments[1].to }] });
  assert.equal(withSite.terminals[0].stationSiteId, "stn-site:1");
  assert.equal(build(design({ terminals: [{ key: "t1", stationId: A.segments[1].to }] })).terminals[0].stationSiteId, null);
  const stale = build(design({ planIds: [A.planId, B.planId], throughRouteId: route.throughRouteId, designedRevisions: { ...revisionsOf(A, B), routes: { [route.throughRouteId]: "through-route-revision:old" } }, blockBoundaries: [] }), { routes: [route] });
  assert.deepEqual(stale.revision.mismatches.map((m) => m.kind), ["through-route"]);
  assert.equal(stale.blocks, null);
});

// --- sections ---
test("every plan segment is a physical section with its ends, length and plan-stated constraints", () => {
  const d = build(design());
  assert.equal(d.sections.length, A.segments.length);
  const s = sectionOf(d, A, 0);
  assert.equal(s.sectionId, stableId("rail-section", "t", "plan", A.planId, ...[A.segments[0].from, A.segments[0].to].sort()));
  assert.equal(s.sourceKind, "plan");
  assert.deepEqual([s.fromStationId, s.toStationId], [A.segments[0].from, A.segments[0].to]);
  assert.equal(s.lengthMeters, A.segments[0].lengthMeters);
  assert.deepEqual(s.alignment, A.segments[0].alignment);
  assert.equal(s.minimumCurveRadiusMeters, A.segments[0].minCurveRadiusMeters);
  assert.equal(s.structureHint, A.segments[0].structureHint);
  assert.equal(s.structureHintBasis, A.segments[0].structureHintBasis);
  assert.deepEqual(d.closureTargets.map((t) => t.sectionId), d.sections.map((x) => x.sectionId));
});

test("a plan drawn the other way round keeps its section ids (the end stations, not the directional segment id, name a section)", () => {
  const lineAB = (pts) => ({ key: "a", name: "a", vertices: pts.map((location) => ({ location, platformType: "side" })) });
  const pts = [[139, 35], [139.01, 35], [139.02, 35]];
  const forward = buildMapExport({ pack, mode: "existing", drawnLines: [lineAB(pts)] }).plans[0];
  const reversed = buildMapExport({ pack, mode: "existing", drawnLines: [lineAB([...pts].reverse())] }).plans[0];
  assert.notDeepEqual(forward.segments.map((s) => s.id).sort(), reversed.segments.map((s) => s.id).sort(), "PlanGeometry segment ids do follow the drawn direction");
  const ids = (plan) => buildRailGeometry({ key: "k", planIds: [plan.planId], designedRevisions: revisionsOf(plan) }, ctxOf({ plans: [plan] })).design.sections.map((s) => s.sectionId);
  assert.deepEqual(ids(forward), ids(reversed));
  assert.equal(planRevisionOf(forward) === planRevisionOf(reversed), false, "the revision is conservative: a redrawn direction makes an earlier design stale");
});

test("sections of two plans are joined only where their measured alignments meet; near is unknown, a free end is false", () => {
  const d = build(design({ planIds: [A.planId, B.planId], designedRevisions: revisionsOf(A, B) }));
  const aEnd = sectionOf(d, A, 1).ends[1];
  assert.equal(aEnd.state, true);
  assert.deepEqual(aEnd.joinedSectionIds, [sectionOf(d, B, 0).sectionId]);
  const aStart = sectionOf(d, A, 0).ends[0];
  assert.equal(aStart.state, false, "no other section within 50 m of the free end");
  assert.deepEqual(aStart.joinedSectionIds, []);
  assert.ok(!aStart.unknown.length);
  // a plan that starts 36 m past the end of a is near, not joined: unknown with its reason
  const nearMap = buildMapExport({ pack, mode: "existing", drawnLines: [line("a", [[139, 35], [139.01, 35], [139.02, 35]]), line("n", [[139.0204, 35], [139.03, 35]])] });
  const plans = nearMap.plans;
  const near = buildRailGeometry({ key: "n", planIds: plans.map((p) => p.planId), designedRevisions: revisionsOf(...plans) }, { pack, plans, externalNetworks: [] }).design;
  const a = plans.find((p) => p.planId === A.planId);
  const end = near.sections.find((s) => s.planId === a.planId && s.segmentId === a.segments[1].id).ends[1];
  assert.equal(end.state, null);
  assert.equal(end.unknownReasons.state, "endpoints-near-not-joined");
  assert.equal(end.joinedSectionIds.length, 0);
  assert.equal(end.nearSectionIds.length, 1);
});

test("an existing line gives station-level sections with no alignment, length or owner: everything about them is unknown", () => {
  const d = build(design({ externalLineIds: [EXT] }), { externalNetworks: mapExport.externalNetworks });
  const ext = d.sections.filter((s) => s.sourceKind === "external");
  assert.equal(ext.length, 2);
  for (const s of ext) {
    assert.equal(s.alignment, null);
    assert.equal(s.lengthMeters, null);
    assert.equal(s.directionMode, null);
    assert.equal(s.minimumCurveRadiusMeters, null);
    assert.equal(s.blockIds, null);
    assert.equal(s.unknownReasons.lengthMeters, "external-alignment-not-in-source");
    assert.equal(s.unknownReasons.directionMode, "external-track-data-not-in-source");
    assert.deepEqual(s.ends.map((e) => e.state), [null, null]);
    assert.equal(s.externalLineId, EXT);
  }
  assert.ok(d.spatialFlags.includes("external-alignment-unknown"));
  assert.equal(JSON.stringify(d).includes("Operator X"), false, "an operator tag is never copied into the facts");
  assert.ok(d.sourceLayers.some((l) => l.layer === "existing-network" && /station level/.test(l.name)));
});

test("an external line that traverses the same station pair twice gets unique reversal-stable section ids", () => {
  const loopPack = {
    ...pack,
    existingNetwork: { lines: [{ name: "Loop", operator: "Operator X", osmRelationId: 99, stationIds: ["d1", "d2", "d1", "d3"] }] },
  };
  const loopMap = buildMapExport({ pack: loopPack, mode: "existing", drawnLines: [] });
  const network = loopMap.externalNetworks[0];
  const externalLineId = network.lines[0].id;
  const drawn = design({ externalLineIds: [externalLineId] });
  const forward = buildRailGeometry(drawn, { pack: loopPack, plans: mapExport.plans, externalNetworks: [network], routes: [] }).design;
  const reversedNetwork = structuredClone(network);
  reversedNetwork.lines[0].stationIds.reverse();
  const reverse = buildRailGeometry(drawn, { pack: loopPack, plans: mapExport.plans, externalNetworks: [reversedNetwork], routes: [] }).design;
  const forwardIds = forward.sections.filter((section) => section.externalLineId === externalLineId).map((section) => section.sectionId).sort();
  const reverseIds = reverse.sections.filter((section) => section.externalLineId === externalLineId).map((section) => section.sectionId).sort();
  assert.equal(forwardIds.length, 3);
  assert.equal(new Set(forwardIds).size, 3);
  assert.deepEqual(reverseIds, forwardIds);
});

test("single / double track is only what the player or a named source states; nothing is inferred", () => {
  const d = build(design({ sectionFacts: [player(A, 0, { directionMode: "double" }), { ref: ref(A, 1), basis: "source", sourceName: "line book", directionMode: "single" }] }));
  assert.deepEqual([sectionOf(d, A, 0).directionMode, sectionOf(d, A, 0).directionModeBasis], ["double", "player"]);
  assert.deepEqual([sectionOf(d, A, 1).directionMode, sectionOf(d, A, 1).directionModeBasis, sectionOf(d, A, 1).directionModeSource], ["single", "source", "line book"]);
  const none = build(design());
  for (const s of none.sections) { assert.equal(s.directionMode, null); assert.equal(s.unknownReasons.directionMode, "track-count-not-stated"); }
  const bad = buildRailGeometry(design({ sectionFacts: [{ ref: ref(A, 0), directionMode: "triple", basis: "player" }, { ref: ref(A, 1), directionMode: "single" }, player(A, 0, { designedGradientPermille: -4 })] }), ctxOf());
  assert.deepEqual(bad.warnings.map((w) => w.code), ["direction-mode-invalid", "direction-mode-invalid", "gradient-invalid"]);
  assert.equal(sectionOf(bad.design, A, 0).directionMode, null);
});

test("the ground gradient comes from the plan and is not the designed gradient; the designed one is only what the player states", () => {
  const d = build(design({ sectionFacts: [player(A, 0, { designedGradientPermille: 30.04 })] }));
  assert.equal(sectionOf(d, A, 0).designedGradientPermille, 30);
  assert.equal(sectionOf(d, A, 1).designedGradientPermille, null);
  assert.equal(sectionOf(d, A, 1).unknownReasons.designedGradientPermille, "track-profile-not-designed");
  assert.equal(sectionOf(d, A, 0).groundGradientPermille, A.segments[0].gradientPermille);
});

test("crossings are re-measured with the layers given: null without a layer, a real 0 with an empty layer, counts with features", () => {
  const bare = build(design());
  const s0 = sectionOf(bare, A, 0);
  for (const f of ["buildingIntersectionCount", "waterCrossingCount", "roadCrossingCount", "existingRailwayCrossingCount"]) { assert.equal(s0[f], null, f); assert.ok(s0.unknown.includes(f), f); }
  assert.equal(s0.unknownReasons.waterCrossingCount, "no-layer");
  const far = rect(139.5, 36, 139.6, 36.1);
  const empty = sectionOf(build(design(), { spatial: layersOf({ buildings: [far], water: [far], roads: [[[139.5, 36], [139.6, 36]]] }) }), A, 0);
  assert.deepEqual([empty.buildingIntersectionCount, empty.waterCrossingCount, empty.roadCrossingCount], [0, 0, 0]);
  assert.equal(empty.existingRailwayCrossingCount, null, "no rail layer: still unknown");
  const hit = build(design(), { spatial: layersOf({ buildings: [rect(139.004, 34.9999, 139.005, 35.0001)], water: [rect(139.006, 34.999, 139.007, 35.001)], roads: [[[139.003, 34.999], [139.003, 35.001]], [[139.0065, 34.999], [139.0065, 35.001]]] }) });
  const h = sectionOf(hit, A, 0);
  assert.deepEqual([h.buildingIntersectionCount, h.waterCrossingCount, h.roadCrossingCount], [1, 1, 2]);
  assert.deepEqual(h.roadCrossingsByClass, { highway: 0, major: 0, minor: 2 });
  assert.ok(hit.sourceLayers.some((l) => l.layer === "buildings") && hit.sourceLayers.some((l) => l.layer === "water"));
  const rail = build(design(), { externalNetworks: mapExport.externalNetworks });
  assert.equal(typeof sectionOf(rail, A, 0).existingRailwayCrossingCount, "number");
  assert.equal(rail.sourceLayers.find((l) => l.layer === "rail").quality, "low");
});

// --- blocks and signal candidates ---
test("no block data is null with a reason, never one invented block per section; declared none is one block per section", () => {
  const none = build(design());
  assert.equal(none.blocks, null);
  assert.equal(none.signalCandidates, null);
  assert.equal(none.unknownReasons.blocks, "no-block-data");
  assert.equal(none.unknownReasons.signalCandidates, "no-block-data");
  for (const s of none.sections) { assert.equal(s.blockIds, null); assert.equal(s.unknownReasons.blockIds, "no-block-data"); }
  assert.ok(none.spatialFlags.includes("block-data-missing"));
  const declared = build(design({ blockBoundaries: [] }));
  assert.equal(declared.blocks.length, A.segments.length);
  assert.deepEqual(declared.signalCandidates, []);
  for (const b of declared.blocks) { assert.equal(b.declaredWithoutIntermediateBoundary, true); assert.equal(b.startBoundary.kind, "section-end"); }
  assert.ok(!declared.unknown.includes("blocks"));
});

test("stated boundaries split one section into blocks that add up to its length, with a signal candidate each way", () => {
  const len = A.segments[0].lengthMeters;
  const d = build(design({ blockBoundaries: [boundary("b2", A, 0, "from", 600), boundary("b1", A, 0, "from", 250, { basis: "source", sourceName: "signal plan" })] }));
  const s = sectionOf(d, A, 0);
  assert.equal(s.blockIds.length, 3);
  const mine = d.blocks.filter((b) => b.sectionId === s.sectionId).sort((a, b) => a.startAlongMeters - b.startAlongMeters);
  assert.deepEqual(mine.map((b) => b.blockLengthMeters), [250, 350, Math.round((len - 600) * 10) / 10]);
  assert.ok(Math.abs(mine.reduce((n, b) => n + b.blockLengthMeters, 0) - len) < 0.2);
  assert.deepEqual([mine[0].startBoundary.kind, mine[0].endBoundary.kind, mine[0].endBoundary.basis, mine[0].endBoundary.sourceName], ["section-end", "boundary", "source", "signal plan"]);
  assert.deepEqual(mine[0].startLocation, s.startLocation);
  assert.deepEqual(mine[2].endLocation, s.endLocation);
  assert.equal(d.signalCandidates.length, 4, "two boundaries, each facing both end stations");
  const first = d.signalCandidates.filter((c) => c.alongMeters === 250);
  assert.deepEqual(first.map((c) => c.facingStationId).sort(), [s.fromStationId, s.toStationId].sort());
  assert.equal(first.find((c) => c.facingStationId === s.toStationId).protectsBlockId, mine[1].blockId);
  assert.equal(first.find((c) => c.facingStationId === s.fromStationId).protectsBlockId, mine[0].blockId);
  assert.equal(mine[1].signalCandidateIds.length, 2);
  assert.equal(d.signalSystem, null);
  assert.equal(d.unknownReasons.signalSystem, "signal-system-not-in-source", "a signalling system is never inferred");
  assert.equal(sectionOf(d, A, 1).blockIds.length, 1, "a section without boundaries is a single block");
});

test("invalid, duplicate and off-section boundaries are dropped with a warning; external sections cannot hold blocks", () => {
  const len = A.segments[0].lengthMeters;
  const out = buildRailGeometry(design({ externalLineIds: [EXT], blockBoundaries: [
    boundary("ok", A, 0, "from", 300), boundary("dup", A, 0, "from", 300.4), boundary("zero", A, 0, "from", 0), boundary("past", A, 0, "from", len),
    { ...boundary("basis", A, 0, "from", 100), basis: "guess" }, { ...boundary("st", A, 0, "from", 100), measuredFromStationId: "stn:nope" }, { key: "gone", planId: "plan:nope", segmentId: "x", measuredFromStationId: "y", alongMeters: 1, basis: "player" },
  ] }), ctxOf({ externalNetworks: mapExport.externalNetworks }));
  assert.deepEqual(out.warnings.map((w) => w.code), ["boundary-duplicate", "boundary-position-invalid", "boundary-position-invalid", "boundary-basis-invalid", "boundary-station-invalid", "boundary-section-missing"]);
  assert.equal(out.design.signalCandidates.length, 2);
  for (const s of out.design.sections.filter((x) => x.sourceKind === "external")) { assert.equal(s.blockIds, null); assert.equal(s.unknownReasons.blockIds, "external-alignment-not-in-source"); }
});

// --- junctions ---
const SHARED = () => turnout("j1", E, [{ ...ref(A, 0), role: "stem" }, { ...ref(B, 0), role: "main" }, { ...ref(B, 1), role: "branch" }]);

test("a turnout lists its route combinations and which of them share track; attachment is measured per section", () => {
  const d = build(design({ planIds: [A.planId, B.planId, X.planId], designedRevisions: revisionsOf(A, B, X), junctions: [turnout("j1", E, [{ ...ref(A, 1), role: "stem" }, { ...ref(B, 0), role: "main" }, { ...ref(X, 0), role: "branch" }])] }));
  const [j] = d.junctions;
  assert.equal(j.junctionResourceId, stableId("rail-junction", "t", "key", "j1"));
  assert.equal(j.kind, "turnout");
  assert.equal(j.turnoutId, stableId("rail-turnout", j.junctionResourceId));
  assert.equal(j.crossingId, null);
  assert.equal(j.routeCombinations.length, 2, "stem-main and stem-branch");
  for (const c of j.routeCombinations) { assert.deepEqual(c.passLocation, E); assert.deepEqual(c.conflictsWith.map((x) => x.basis), ["shared-section"]); }
  assert.equal(j.connections.find((c) => c.role === "stem").attached, true);
  assert.equal(j.connections.find((c) => c.role === "stem").remainingToFarEndMeters, 0);
  assert.equal(j.connections.find((c) => c.role === "branch").attached, false, "plan x is ~1 km from the junction: measured apart");
  assert.equal(j.attachedToAllSections, false);
  assert.ok(d.spatialFlags.includes("junction-separated"));
  assert.deepEqual(sectionOf(d, A, 1).junctionResourceIds, [j.junctionResourceId]);
  assert.deepEqual(sectionOf(d, A, 0).junctionResourceIds, [], "junction data was declared, so no junction here is a fact");
});

test("a flat crossing conflicts only where the two lines really cross; touching on one side is not a crossing", () => {
  const at = [139.01, 35];
  const crossing = (roles) => build(design({ planIds: [A.planId, X.planId], designedRevisions: revisionsOf(A, X), junctions: [{ key: "j1", kind: "crossing", location: at, connections: roles }] }));
  const real = crossing([{ ...ref(A, 0), role: "a1" }, { ...ref(A, 1), role: "a2" }, { ...ref(X, 0), role: "b1" }, { ...ref(X, 1), role: "b2" }]);
  const j = real.junctions[0];
  assert.equal(j.crossingId, stableId("rail-crossing", j.junctionResourceId));
  assert.equal(j.routeCombinations.length, 2);
  for (const c of j.routeCombinations) assert.deepEqual(c.conflictsWith.map((x) => x.basis), ["crossing-point"]);
  assert.equal(j.attachedToAllSections, true);
  assert.ok(!real.spatialFlags.includes("crossing-without-crossing-geometry"));
  const touching = crossing([{ ...ref(A, 0), role: "a1" }, { ...ref(X, 0), role: "a2" }, { ...ref(A, 1), role: "b1" }, { ...ref(X, 1), role: "b2" }]);
  for (const c of touching.junctions[0].routeCombinations) assert.deepEqual(c.conflictsWith, [], "a measured 'no conflict', not unknown");
  assert.ok(touching.spatialFlags.includes("crossing-without-crossing-geometry"));
});

test("junction attachment: on the section is true, 1-50 m is unknown (near, not joined), beyond 50 m is false", () => {
  const at = (dLat) => build(design({ junctions: [turnout("j", [139.015, 35 + dLat], [{ ...ref(A, 1), role: "stem" }])] })).junctions[0];
  assert.equal(at(0).attachedToAllSections, true);
  const near = at(0.0002);
  assert.equal(near.attachedToAllSections, null);
  assert.equal(near.unknownReasons.attachedToAllSections, "attachment-not-measured");
  assert.equal(near.connections[0].attached, null);
  assert.ok(near.connections[0].distanceToSectionMeters > 1 && near.connections[0].distanceToSectionMeters < 50, "the measured distance is kept");
  assert.equal(at(0.001).attachedToAllSections, false);
  const mid = at(0);
  assert.ok(mid.connections[0].alongMeters > 0 && mid.connections[0].remainingToFarEndMeters > 0, "a junction in the middle of a section is reported where it sits");
  assert.ok(mid.missingRoles.includes("main") && mid.missingRoles.includes("branch"));
  assert.ok(build(design({ junctions: [turnout("j", [139.015, 35], [{ ...ref(A, 1), role: "stem" }])] })).spatialFlags.includes("junction-sections-incomplete"));
});

test("junction ids follow the key, else the kind and its sections; never the connection order or the location", () => {
  const conns = [{ ...ref(A, 1), role: "stem" }, { ...ref(B, 0), role: "main" }, { ...ref(B, 1), role: "branch" }];
  const id = (extra, list = conns) => build(design({ planIds: [A.planId, B.planId], designedRevisions: revisionsOf(A, B), junctions: [{ kind: "turnout", location: E, connections: list, ...extra }] })).junctions[0].junctionResourceId;
  assert.equal(id({ key: "k" }), id({ key: "k", location: [139.0201, 35] }));
  assert.equal(id({}), id({}, [...conns].reverse()));
  assert.equal(id({}), id({ location: [139.0201, 35] }));
  assert.notEqual(id({}), id({}, conns.slice(0, 2)));
  assert.notEqual(id({ key: "k" }), id({ key: "k2" }));
});

test("no junction data is null; a declared empty list is a fact", () => {
  const none = build(design());
  assert.equal(none.junctions, null);
  assert.equal(none.unknownReasons.junctions, "no-junction-data");
  for (const s of none.sections) { assert.equal(s.junctionResourceIds, null); assert.equal(s.unknownReasons.junctionResourceIds, "no-junction-data"); }
  assert.deepEqual(build(design({ junctions: [] })).junctions, []);
});

// --- terminals ---
const TERMINAL = (extra = {}) => design({ terminals: [{ key: "t1", stationId: A.segments[1].to, ...extra }] });

test("platform candidates are connected, not connected or unverified by measurement; reversed polylines are the same", () => {
  const platform = (key, start) => ({ key, approach: ref(A, 1), polyline: [start, [start[0] + 0.0012, start[1]]], platformLengthMeters: 120 });
  const d = build(TERMINAL({ platforms: [platform("exact", E), platform("near", [139.02, 35.0002]), platform("apart", [139.02, 35.002])] }));
  const [t] = d.terminals;
  assert.equal(t.terminalResourceId, stableId("rail-terminal", "t", "key", "t1"));
  assert.deepEqual(t.approachSectionIds, [sectionOf(d, A, 1).sectionId]);
  const by = Object.fromEntries(t.platformCandidates.map((p) => [p.key, p]));
  assert.equal(by.exact.connected, true);
  assert.equal(by.exact.entryRoute.entryGapMeters, 0);
  assert.equal(by.near.connected, null);
  assert.equal(by.near.unknownReasons.connected, "endpoints-near-not-joined");
  assert.equal(by.apart.connected, false);
  assert.ok(!by.apart.unknown.includes("connected"));
  assert.ok(d.spatialFlags.includes("platform-not-connected") && d.spatialFlags.includes("platform-connection-unverified"));
  assert.equal(by.exact.platformCandidateId, stableId("rail-platform-candidate", t.terminalResourceId, "key", "exact"));
  assert.equal(by.exact.approachReachesTerminalStation, true);
  assert.ok(by.exact.trackLengthMeters > 100 && by.exact.trackLengthMeters < 120);
});

test("two platforms reach a terminal, one through a turnout; turnback, pull-out and stabling tracks attach by measurement", () => {
  const d = build(design({
    junctions: [turnout("sw", [139.0192, 35], [{ ...ref(A, 1), role: "stem" }])],
    terminals: [{ key: "t1", stationId: A.segments[1].to,
      platforms: [{ key: "p1", approach: ref(A, 1), polyline: [E, [139.0212, 35]], platformLengthMeters: 120 }, { key: "p2", approach: ref(A, 1), viaJunctionKeys: ["sw"], polyline: [[139.0192, 35], [139.0197, 34.9997], [139.0212, 34.9997]] }],
      turnbackTracks: [{ key: "stab", kind: "stabling", viaJunctionKey: "sw", polyline: [[139.0192, 35], [139.0192, 34.9993]] }, { key: "pull", kind: "pull-out", polyline: [[139.0195, 35.0003], [139.0212, 35.0003]] }, { key: "turn", kind: "turnback", polyline: [[139.0185, 35.005], [139.0185, 35.004]] }] }],
  }));
  const [t] = d.terminals;
  assert.equal(t.platformCandidates.length, 2);
  const p2 = t.platformCandidates.find((p) => p.key === "p2");
  assert.deepEqual(p2.entryRoute.viaJunctionResourceIds, [d.junctions[0].junctionResourceId]);
  assert.equal(p2.connected, true);
  assert.equal(p2.unknownReasons.platformLengthMeters, "platform-length-not-stated");
  assert.equal(p2.platformLengthMeters, null, "a platform length nobody stated is not guessed from the polyline");
  assert.equal(t.platformCandidates.find((p) => p.key === "p1").platformLengthMeters, 120);
  const tb = Object.fromEntries(t.turnbackCandidates.map((x) => [x.key, x]));
  assert.deepEqual([tb.stab.kind, tb.stab.attached, tb.stab.viaJunctionResourceId], ["stabling", true, d.junctions[0].junctionResourceId]);
  assert.equal(tb.pull.attached, null);
  assert.equal(tb.pull.unknownReasons.attached, "endpoints-near-not-joined");
  assert.equal(tb.turn.attached, false);
  assert.equal(tb.pull.attachSectionId, sectionOf(d, A, 1).sectionId);
  assert.ok(tb.stab.lengthMeters > 60 && tb.stab.lengthMeters < 90);
});

test("terminal data that was never given is null (not an empty list); an approach that misses the terminal station is flagged", () => {
  const bare = build(TERMINAL());
  assert.equal(bare.terminals[0].platformCandidates, null);
  assert.equal(bare.terminals[0].turnbackCandidates, null);
  assert.deepEqual([bare.terminals[0].unknownReasons.platformCandidates, bare.terminals[0].unknownReasons.turnbackCandidates], ["no-platform-data", "no-turnback-data"]);
  const declared = build(TERMINAL({ platforms: [], turnbackTracks: [] })).terminals[0];
  assert.deepEqual([declared.platformCandidates, declared.turnbackCandidates], [[], []]);
  assert.equal(build(design()).terminals, null);
  assert.equal(build(design()).unknownReasons.terminals, "no-terminal-data");
  const wrong = build(TERMINAL({ platforms: [{ key: "p", approach: ref(A, 0), polyline: [E, [139.0212, 35]], platformLengthMeters: 100 }] }));
  assert.equal(wrong.terminals[0].platformCandidates[0].approachReachesTerminalStation, false);
  assert.ok(wrong.spatialFlags.includes("approach-not-at-terminal"));
  assert.equal(wrong.terminals[0].platformCandidates[0].connected, null);
});

// --- revision ---
test("a design made on another plan revision is stale: positional design reads null with the reason, sections stay", () => {
  const drawn = design({ planIds: [A.planId, B.planId], designedRevisions: { plans: { [A.planId]: planRevisionOf(A), [B.planId]: stableId("plan-revision", B.planId, "before") } }, blockBoundaries: [boundary("b1", A, 0, "from", 200)], junctions: [SHARED()], terminals: [{ key: "t", stationId: A.segments[1].to }] });
  const out = buildRailGeometry(drawn, ctxOf());
  const d = out.design;
  assert.equal(d.revision.state, "stale");
  assert.deepEqual(d.revision.mismatches.map((m) => [m.kind, m.id]), [["plan", B.planId]]);
  for (const f of ["blocks", "signalCandidates", "junctions", "terminals"]) { assert.equal(d[f], null, f); assert.equal(d.unknownReasons[f], "design-revision-stale", f); }
  assert.equal(d.sections.length, A.segments.length + B.segments.length);
  assert.ok(d.spatialFlags.includes("revision-stale"));
  assert.equal(out.warnings[0].code, "revision-stale");
  const unrecorded = buildRailGeometry({ ...drawn, designedRevisions: undefined }, ctxOf()).design;
  assert.equal(unrecorded.revision.state, "not-recorded");
  assert.deepEqual(unrecorded.revision.missing, [A.planId, B.planId].sort());
  assert.equal(unrecorded.unknownReasons.blocks, "design-revision-not-recorded");
  assert.equal(build({ ...drawn, designedRevisions: revisionsOf(A, B) }).revision.state, "current");
  const absent = build(design({ designedRevisions: { plans: { [A.planId]: "x" } } }));
  assert.equal(absent.unknownReasons.blocks, "no-block-data", "nothing was designed, so nothing is blocked by the revision");
});

test("a plan revision follows its spatial facts only: moving a station changes it, renaming does not", () => {
  const moved = structuredClone(A);
  moved.stationCandidates[0].location = [139.0001, 35];
  assert.notEqual(planRevisionOf(moved), planRevisionOf(A));
  const renamed = structuredClone(A);
  renamed.name = "another name";
  renamed.stationCandidates[0].name = "elsewhere";
  assert.equal(planRevisionOf(renamed), planRevisionOf(A));
});

// --- the module is spatial only ---
const richInput = () => design({
  planIds: [A.planId, X.planId], designedRevisions: revisionsOf(A, X), externalLineIds: [EXT], sectionFacts: [player(A, 0, { directionMode: "double", designedGradientPermille: 20 })],
  blockBoundaries: [boundary("b1", A, 0, "from", 300)], junctions: [{ key: "j", kind: "crossing", location: [139.01, 35], connections: [{ ...ref(A, 0), role: "a1" }, { ...ref(A, 1), role: "a2" }, { ...ref(X, 0), role: "b1" }, { ...ref(X, 1), role: "b2" }] }],
  terminals: [{ key: "t", stationId: A.segments[1].to, platforms: [{ key: "p", approach: ref(A, 1), polyline: [E, [139.0212, 35]], platformLengthMeters: 120 }], turnbackTracks: [{ key: "s", kind: "stabling", polyline: [[139.0185, 35], [139.0185, 34.9993]] }] }],
});

test("no management import and no capacity / headway / timetable / verdict / cost / delay field anywhere", () => {
  for (const file of ["rail-capacity-geometry", "rail-capacity-facilities", "rail-capacity-editor", "rail-capacity-view"]) {
    const text = fs.readFileSync(path.join(here, "..", "src", "map", `${file}.mjs`), "utf8");
    assert.equal(/from\s+["'][^"']*management/.test(text), false, file);
    assert.equal(/scenario-runtime|game\.mjs|trains\.mjs/.test(text.replace(/\/\/.*$/gm, "")), false, file);
  }
  const rich = build(richInput(), { externalNetworks: mapExport.externalNetworks, spatial: layersOf({ buildings: [rect(139.004, 34.9999, 139.005, 35.0001)] }) });
  assert.deepEqual([...keysDeep(rich)].filter((k) => !k.includes(":") && FORBIDDEN.test(k)), []);
  const view = buildRailCapacityView({ exportData: { designs: [rich], warnings: [] } });
  assert.deepEqual([...keysDeep(view)].filter((k) => !k.includes(":") && FORBIDDEN.test(k)), []);
});

test("unknown[] and unknownReasons are 1:1 everywhere, and every unknown value is null", () => {
  const rich = build(design({
    planIds: [A.planId, B.planId, X.planId], designedRevisions: revisionsOf(A, B, X), externalLineIds: [EXT], sectionFacts: [player(A, 0, { directionMode: "single" })],
    blockBoundaries: [boundary("b1", A, 0, "from", 300)],
    junctions: [turnout("j1", [139.02, 35.0002], [{ ...ref(A, 1), role: "stem" }, { ...ref(B, 0), role: "main" }])],
    terminals: [{ key: "t", stationId: A.segments[1].to, platforms: [{ key: "p", approach: ref(A, 1), polyline: [[139.02, 35.0002], [139.0212, 35]] }] }, { key: "t2", stationId: B.segments[1].to }],
  }), { externalNetworks: mapExport.externalNetworks });
  assertUnknownContract(rich);
  assert.deepEqual([...rich.unknown], Object.keys(rich.unknownReasons).sort());
  assert.ok(rich.unknown.some((p) => p.startsWith("section:")) && rich.unknown.some((p) => p.startsWith("junction:")) && rich.unknown.some((p) => p.startsWith("terminal:")));
  assert.equal(rich.unknown.length, new Set(rich.unknown).size);
  const bare = build(design());
  assertUnknownContract(bare);
  for (const f of ["blocks", "signalCandidates", "junctions", "terminals", "signalSystem"]) assert.equal(bare[f], null, f);
});

test("the inputs are never mutated (frozen plans, pack and drawn design)", () => {
  const drawn = deepFreeze(design({ planIds: [A.planId, B.planId], designedRevisions: revisionsOf(A, B), sectionFacts: [player(A, 0, { directionMode: "single" })], blockBoundaries: [boundary("b1", A, 0, "from", 300)], junctions: [SHARED()], terminals: [{ key: "t", stationId: A.segments[1].to, platforms: [{ key: "p", approach: ref(A, 1), polyline: [E, [139.0212, 35]] }] }] }));
  const plans = deepFreeze(structuredClone(mapExport.plans));
  const frozenPack = deepFreeze(structuredClone(pack));
  const before = JSON.stringify([drawn, plans, frozenPack]);
  const out = buildRailGeometry(drawn, { pack: frozenPack, plans, externalNetworks: [], routes: [] });
  assert.ok(out.design);
  assert.equal(JSON.stringify([drawn, plans, frozenPack]), before);
  assert.equal(buildRailGeometryExport({ pack: frozenPack, mapExport: { plans, externalNetworks: [] }, designs: [drawn] }).designs.length, 1);
});

// --- editor ---
test("editor: create a design, state facts, boundaries, junctions, terminals; the key and id never change", () => {
  const doc = newRailCapacityDoc("t", "1");
  const d = addDesign(doc, { plans: [A, B], name: "n" });
  assert.equal(d.key, "rail-1");
  assert.deepEqual(d.designedRevisions.plans, { [A.planId]: planRevisionOf(A), [B.planId]: planRevisionOf(B) });
  const built = () => buildRailGeometry(toDrawnDesign(d), ctxOf()).design;
  const id = built().railGeometryId;
  assert.equal(id, keyedRailGeometryId("t", "rail-1"));
  setSectionFact(doc, d.key, ref(A, 0), { directionMode: "double", basis: "player" });
  setSectionFact(doc, d.key, ref(A, 0), { designedGradientPermille: 12 });
  assert.equal(d.sectionFacts.length, 1, "one entry per section");
  assert.deepEqual([sectionOf(built(), A, 0).directionMode, sectionOf(built(), A, 0).designedGradientPermille], ["double", 12]);
  clearSectionFact(doc, d.key, ref(A, 0));
  assert.equal(sectionOf(built(), A, 0).directionMode, null);
  assert.throws(() => addBlockBoundary(doc, d.key, boundary(undefined, A, 0, "from", 100)), /not declared/);
  declareBlockBoundaries(doc, d.key);
  const b1 = addBlockBoundary(doc, d.key, boundary(undefined, A, 0, "from", 100));
  assert.equal(b1.key, "boundary-1");
  moveBlockBoundary(doc, d.key, "boundary-1", 400);
  assert.equal(built().blocks.filter((b) => b.sectionId === sectionOf(built(), A, 0).sectionId).length, 2);
  assert.throws(() => moveBlockBoundary(doc, d.key, "boundary-9", 1), /Unknown boundary/);
  removeBlockBoundary(doc, d.key, "boundary-1");
  assert.deepEqual(built().signalCandidates, []);
  clearBlockBoundaries(doc, d.key);
  assert.equal(built().blocks, null);
  declareJunctions(doc, d.key);
  const j = addJunction(doc, d.key, { kind: "turnout", location: E });
  assert.equal(j.key, "junction-1");
  connectJunction(doc, d.key, "junction-1", { ...ref(A, 1), role: "stem" });
  connectJunction(doc, d.key, "junction-1", { ...ref(B, 0), role: "main" });
  connectJunction(doc, d.key, "junction-1", { ...ref(B, 1), role: "main" });
  assert.equal(j.connections.length, 2, "a role holds one connection");
  assert.equal(built().junctions[0].connections.length, 2);
  moveJunction(doc, d.key, "junction-1", [139.0201, 35]);
  disconnectJunction(doc, d.key, "junction-1", "main");
  assert.equal(built().junctions[0].connections.length, 1);
  declareTerminals(doc, d.key);
  const t = addTerminal(doc, d.key, { stationId: A.segments[1].to });
  assert.equal(t.key, "terminal-1");
  const p = addPlatform(doc, d.key, "terminal-1", { approach: ref(A, 1), polyline: [E, [139.0212, 35]], platformLengthMeters: 120 });
  const s = addTurnbackTrack(doc, d.key, "terminal-1", { kind: "stabling", polyline: [[139.0185, 35], [139.0185, 34.9993]] });
  assert.deepEqual([p.key, s.key], ["platform-1", "turnback-1"]);
  assert.equal(built().terminals[0].platformCandidates.length, 1);
  assert.equal(built().terminals[0].turnbackCandidates.length, 1);
  removePlatform(doc, d.key, "terminal-1", "platform-1");
  removeTurnbackTrack(doc, d.key, "terminal-1", "turnback-1");
  assert.deepEqual([built().terminals[0].platformCandidates, built().terminals[0].turnbackCandidates], [[], []]);
  removeTerminal(doc, d.key, "terminal-1");
  removeJunction(doc, d.key, "junction-1");
  assert.deepEqual([built().terminals, built().junctions], [[], []]);
  assert.equal(built().railGeometryId, id);
  assert.throws(() => addDesign(doc, { plans: [] }), /at least one plan/);
  assert.equal(addDesign(doc, { plans: [A] }).key, "rail-2");
  removeDesign(doc, "rail-1");
  assert.equal(addDesign(doc, { plans: [A] }).key, "rail-1", "the smallest unused key is reused");
  assert.throws(() => removeDesign(doc, "nope"), /Unknown rail design/);
});

test("editor: a plan that changed leaves the design stale until the player re-confirms it", () => {
  const doc = newRailCapacityDoc("t", "1");
  const d = addDesign(doc, { plans: [A] });
  declareBlockBoundaries(doc, d.key);
  addBlockBoundary(doc, d.key, boundary(undefined, A, 0, "from", 100));
  const changed = structuredClone(A);
  changed.stationCandidates[0].location = [139.0001, 35];
  const withChanged = (plan) => buildRailGeometry(toDrawnDesign(d), ctxOf({ plans: [plan] })).design;
  assert.equal(withChanged(A).revision.state, "current");
  assert.equal(withChanged(changed).revision.state, "stale");
  assert.equal(withChanged(changed).blocks, null);
  moveBlockBoundary(doc, d.key, "boundary-1", 200);
  assert.equal(withChanged(changed).revision.state, "stale", "editing does not confirm the design");
  rebindRevisions(doc, d.key, { plans: [changed] });
  assert.equal(withChanged(changed).revision.state, "current");
  assert.throws(() => rebindRevisions(doc, d.key, { plans: [B] }), /plans of the design changed/);
});

test("saving and restoring keeps every design and id; another pack's save is refused", () => {
  const doc = newRailCapacityDoc("t", "1");
  const d = addDesign(doc, { plans: [A], name: "n" });
  declareBlockBoundaries(doc, d.key);
  addBlockBoundary(doc, d.key, boundary(undefined, A, 0, "from", 100));
  declareTerminals(doc, d.key);
  addTerminal(doc, d.key, { stationId: A.segments[1].to });
  const text = serializeRailCapacityDoc(doc);
  const restored = restoreRailCapacityDoc(text, pack);
  assert.deepEqual(restored.warnings, []);
  assert.equal(serializeRailCapacityDoc(restored.doc), text);
  const siteOf = (x) => JSON.stringify(buildRailGeometry(toDrawnDesign(x), ctxOf()).design);
  assert.equal(siteOf(restored.doc.designs[0]), siteOf(d));
  const refused = restoreRailCapacityDoc(text, { manifest: { id: "other", version: "1" } });
  assert.deepEqual(refused.warnings, [{ code: "rail-capacity-doc-other-pack", savedPackId: "t" }]);
  assert.equal(refused.doc.designs.length, 0);
  assert.equal(refused.doc.packId, "other");
  assert.equal(restoreRailCapacityDoc(text, { manifest: { id: "t", version: "2" } }).warnings[0].code, "pack-version-mismatch");
  assert.equal(restoreRailCapacityDoc("{nope", pack).warnings[0].code, "rail-capacity-doc-unreadable");
  assert.equal(restoreRailCapacityDoc(JSON.stringify({ version: 9, designs: [] }), pack).warnings[0].code, "rail-capacity-doc-version");
  assert.deepEqual(restoreRailCapacityDoc(null, pack).doc.designs, []);
});

// --- view ---
function fakeCtx() {
  const calls = [];
  const ctx = new Proxy({}, {
    get: (target, name) => (name in target ? target[name] : (...args) => { calls.push([name, ...args]); }),
    set: (target, name, value) => { target[name] = value; calls.push(["set", name, value]); return true; },
  });
  return { ctx, calls };
}
function fakeDom() {
  const make = () => ({ className: "", textContent: "", hidden: false, children: [], ownerDocument: null, append(...kids) { this.children.push(...kids); }, replaceChildren(...kids) { this.children = kids; } });
  const doc = { createElement: () => { const e = make(); e.ownerDocument = doc; return e; } };
  const rootEl = make();
  rootEl.ownerDocument = doc;
  return rootEl;
}
const textsOf = (node) => [node.textContent, ...node.children.flatMap(textsOf)].filter(Boolean);
const richDesign = () => build({
  ...richInput(), name: "<img src=x onerror=alert(1)>", sectionFacts: [player(A, 0, { directionMode: "double" }), player(A, 1, { directionMode: "single" })],
  terminals: [{ key: "t", stationId: A.segments[1].to, platforms: [{ key: "p1", approach: ref(A, 1), polyline: [E, [139.0212, 35]], platformLengthMeters: 120 }, { key: "p2", approach: ref(A, 1), polyline: [[139.02, 35.002], [139.0212, 35.002]] }], turnbackTracks: [{ key: "s", kind: "stabling", polyline: [[139.0185, 35], [139.0185, 34.9993]] }] }],
}, { externalNetworks: mapExport.externalNetworks });

test("view: joined, apart and unknown look different, double and single track differ, a section without alignment is not drawn as a line", () => {
  const d = richDesign();
  const model = buildRailCapacityView({ exportData: { designs: [d], warnings: [] }, selectedId: d.railGeometryId });
  assert.equal(model.schema, "transitline.rail-capacity-map-view/1");
  assert.equal(new Set(Object.values(STATE_STYLES).map((s) => s.color)).size, 3);
  assert.equal(new Set(Object.values(STATE_STYLES).map((s) => s.glyph)).size, 3);
  assert.ok(STATE_STYLES.unknown.dash.length > 0 && STATE_STYLES.apart.dash.length === 0);
  const [v] = model.designs;
  assert.equal(v.selected, true);
  const styleOf = (section) => v.sections.find((s) => s.sectionId === section.sectionId).style.key;
  assert.equal(styleOf(sectionOf(d, A, 0)), "double");
  assert.equal(styleOf(sectionOf(d, A, 1)), "single");
  assert.equal(styleOf(sectionOf(d, X, 0)), "unknown-mode");
  assert.ok(v.sections.filter((s) => s.alignment === null).every((s) => s.style.key === "no-alignment" && s.style.width === 0));
  assert.deepEqual(v.terminals[0].platforms.map((p) => p.style.key).sort(), ["apart", "joined"]);
  assert.equal(v.junctions[0].conflictCount, 2);
  assert.equal(v.boundaries.length, 1);
  assert.equal(v.signalCandidates.length, 2);
});

test("view: draws sections, ends, boundaries, signal candidates, junctions, platforms and turnback tracks; no capacity or money text", () => {
  const d = richDesign();
  const model = buildRailCapacityView({ exportData: { designs: [d], warnings: [] } });
  const { ctx, calls } = fakeCtx();
  drawRailCapacityOverlay(ctx, model, ([lon, lat]) => [(lon - 139) * 20000, (35.02 - lat) * 20000]);
  assert.equal(calls[0][0], "save");
  assert.equal(calls.at(-1)[0], "restore");
  const texts = calls.filter((c) => c[0] === "fillText" || c[0] === "strokeText").map((c) => String(c[1]));
  assert.ok(texts.includes("✓") && texts.includes("?") && texts.includes("✕"), "joined, unknown and apart glyphs");
  assert.ok(texts.some((t) => t.includes("평면교차")));
  assert.ok(texts.some((t) => t.includes("종착")));
  assert.ok(texts.some((t) => t.includes("선형 자료 없음")));
  assert.equal(texts.some((t) => /원|비용|공기|승인|용량|시격|가능|불가/.test(t)), false);
  assert.ok(calls.some((c) => c[0] === "set" && c[1] === "strokeStyle" && c[2] === STATE_STYLES.joined.color));
  assert.ok(calls.some((c) => c[0] === "setLineDash" && c[1].length === 0));
});

test("view: the panel and legend use textContent only and never show capacity, cost or a verdict", () => {
  const model = buildRailCapacityView({ exportData: { designs: [richDesign()], warnings: [{ code: "rail-geometry-rejected" }] } });
  const panel = fakeDom();
  renderRailCapacityPanel(panel, model);
  const all = textsOf(panel);
  assert.ok(all.includes("<img src=x onerror=alert(1)>"), "the player's text is shown as text");
  assert.ok(all.some((t) => t.startsWith("구간 ")));
  assert.ok(all.some((t) => t.includes("평면교차")));
  assert.ok(all.some((t) => t.includes("rail-geometry-rejected")));
  assert.equal(all.some((t) => /원|비용|공기|승인|용량|시격|가능|불가/.test(t)), false);
  const stale = buildRailCapacityView({ exportData: { designs: [build(design({ designedRevisions: { plans: { [A.planId]: "old" } }, blockBoundaries: [] }))], warnings: [] } });
  const stalePanel = fakeDom();
  renderRailCapacityPanel(stalePanel, stale);
  assert.ok(textsOf(stalePanel).some((t) => t.includes("노선이 바뀜")));
  const empty = fakeDom();
  renderRailCapacityPanel(empty, buildRailCapacityView({ exportData: { designs: [], warnings: [] } }));
  assert.equal(empty.hidden, true);
  const legend = fakeDom();
  renderRailCapacityLegend(legend);
  assert.ok(textsOf(legend).length >= 8);
});

// --- shipped examples: regenerated byte for byte by the script, and checked against the contract ---
const examplePacks = ["tokyo", "example-radial", "example-corridor"];
const exampleDir = (id) => path.join(root, "packs", id, "rail-capacity-examples");
const readExamples = (id) => fs.readdirSync(exampleDir(id)).filter((f) => f.endsWith(".rail-capacity.json")).sort().map((f) => ({ file: f, design: JSON.parse(fs.readFileSync(path.join(exampleDir(id), f), "utf8")) }));

test("every shipped example satisfies the contract: links resolve to the pack's plans, unknowns are 1:1 and null", () => {
  for (const id of examplePacks) {
    const examples = readExamples(id);
    assert.ok(examples.length >= 1, id);
    const planFiles = fs.readdirSync(path.join(root, "packs", id, "plan-examples")).filter((f) => f.endsWith(".plan.json")).map((f) => JSON.parse(fs.readFileSync(path.join(root, "packs", id, "plan-examples", f), "utf8")));
    for (const { file, design: d } of examples) {
      assert.equal(d.schema, RAIL_CAPACITY_GEOMETRY_SCHEMA, `${id}/${file}`);
      assert.equal(d.sourcePackId, id);
      assert.equal(d.source.generatedBy, "scripts/build-rail-capacity-examples.mjs");
      assert.deepEqual([...keysDeep(d)].filter((k) => !k.includes(":") && FORBIDDEN.test(k)), [], file);
      const { source: _drop, ...body } = d;
      assertUnknownContract(body, `${id}/${file}`);
      for (const planId of d.planIds) {
        const plan = planFiles.find((p) => p.planId === planId);
        assert.ok(plan, `${file}: plan ${planId} exists in the pack`);
        assert.ok(d.planRevisions.some((r) => r.planId === planId && r.planRevision === planRevisionOf(plan)), `${file}: revision of ${planId}`);
        for (const s of d.sections.filter((x) => x.planId === planId)) assert.ok(plan.segments.some((seg) => seg.id === s.segmentId), `${file}: segment ${s.segmentId}`);
      }
      if (d.throughRouteId) {
        const route = JSON.parse(fs.readFileSync(path.join(root, "packs", id, "through-route-examples", `${d.source.throughRouteExample}.through-route.json`), "utf8"));
        assert.equal(route.throughRouteId, d.throughRouteId);
        assert.equal(route.geometryRevision, d.routeGeometryRevision);
      }
    }
  }
});

test("the example set covers every required case", () => {
  const all = examplePacks.flatMap((id) => readExamples(id).map((e) => e.design));
  const cases = new Set(all.flatMap((d) => d.source.case));
  for (const c of ["double-track", "single-track", "multiple-blocks", "shared-turnout", "flat-crossing", "terminal-two-platforms", "turnback-track", "no-signal-or-block-data", "some-layers-missing", "revision-stale"]) assert.ok(cases.has(c), c);
  const caseOf = (c) => all.filter((d) => d.source.case.includes(c));
  assert.ok(caseOf("double-track").every((d) => d.sections.some((s) => s.directionMode === "double")));
  assert.ok(caseOf("single-track").every((d) => d.sections.some((s) => s.directionMode === "single")));
  assert.ok(caseOf("multiple-blocks").every((d) => d.blocks.some((b) => b.startBoundary.kind === "boundary" || b.endBoundary.kind === "boundary")));
  assert.ok(caseOf("shared-turnout").every((d) => d.junctions.some((j) => j.kind === "turnout" && j.sectionIds.length === 3 && j.routeCombinations.every((c) => c.conflictsWith.length > 0))));
  assert.ok(caseOf("flat-crossing").every((d) => d.junctions.some((j) => j.kind === "crossing" && j.routeCombinations.every((c) => c.conflictsWith.some((x) => x.basis === "crossing-point")))));
  assert.ok(caseOf("terminal-two-platforms").every((d) => d.terminals.some((t) => t.platformCandidates.length === 2)));
  assert.ok(caseOf("turnback-track").every((d) => d.terminals.some((t) => t.turnbackCandidates.some((x) => ["pull-out", "stabling", "turnback"].includes(x.kind)))));
  assert.ok(caseOf("no-signal-or-block-data").every((d) => d.blocks === null && d.signalCandidates === null && d.signalSystem === null));
  assert.ok(caseOf("revision-stale").every((d) => d.revision.state === "stale" && d.blocks === null && d.junctions === null));
  assert.ok(caseOf("some-layers-missing").every((d) => d.sections.some((s) => s.waterCrossingCount === null && s.unknownReasons.waterCrossingCount === "no-layer")));
  assert.ok(all.some((d) => d.sections.some((s) => s.sourceKind === "external" && s.alignment === null)), "an existing line without alignment");
});

test("re-running the generator rewrites every example byte for byte", () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "rail-capacity-examples-"));
  const run = spawnSync(process.execPath, [path.join(root, "scripts", "build-rail-capacity-examples.mjs"), "--out", out], { cwd: root, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  for (const id of examplePacks) {
    const files = fs.readdirSync(exampleDir(id)).filter((f) => f.endsWith(".rail-capacity.json")).sort();
    assert.deepEqual(fs.readdirSync(path.join(out, id)).sort(), files, id);
    // the repository stores LF; a Windows checkout may hold CRLF, so compare the canonical (LF) content
    const canonical = (text) => text.replaceAll("\r\n", "\n");
    for (const f of files) assert.equal(canonical(fs.readFileSync(path.join(out, id, f), "utf8")), canonical(fs.readFileSync(path.join(exampleDir(id), f), "utf8")), `${id}/${f}`);
  }
  fs.rmSync(out, { recursive: true, force: true });
});
