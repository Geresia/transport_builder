import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildMapExport, buildPlanGeometry, drawnLinesFromState, STRUCTURE_HINTS } from "../src/map/plan-geometry.mjs";
import { makeSpatialContext, waterLayerFromBarriers, buildingLayerFromObstacles, roadLayerFromGeojson } from "../src/map/spatial.mjs";
import { buildOverlayModel, drawPlanOverlay, PHASES } from "../src/map/overlay.mjs";
import { ManagementGame, validatePlanGeometry, addAccessLink, cityPackToDomain } from "../src/management/index.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");

// --- fixtures ---
const pt = (id, lon, lat, extra = {}) => ({ id, name: id, location: [lon, lat], residents: 100, jobs: 50, ...extra });
const packOf = (points, extra = {}) => ({ manifest: { id: "t", version: "1", data: { license: "CC0-1.0", attribution: [] } }, demand: { points }, ...extra });
const line = (key, coords, extra = {}) => ({ key, name: key, vertices: coords.map((c) => ({ location: c, platformType: "side" })), ...extra });
const deepFreeze = (o) => { if (o && typeof o === "object") { Object.values(o).forEach(deepFreeze); Object.freeze(o); } return o; };
const pack = packOf([pt("d0", 139, 35), pt("d1", 139.01, 35), pt("d2", 139.02, 35.005)]);
const drawn = [line("a", [[139, 35], [139.01, 35], [139.02, 35.005]]), line("b", [[139, 35.01], [139.02, 35.01]])];

// --- determinism, identity ---
test("same map input gives the same ids and byte-identical output", () => {
  const first = buildMapExport({ pack, drawnLines: drawn });
  const again = buildMapExport({ pack, drawnLines: structuredClone(drawn) });
  assert.equal(JSON.stringify(first), JSON.stringify(again));
  const ids = first.plans.flatMap((p) => [p.planId, ...p.stationCandidates.map((s) => s.id), ...p.segments.map((s) => s.id)]);
  assert.equal(new Set(ids).size, ids.length, "ids never collide within a map");
});

test("plan ids survive a reopen: saved JSON, different order, renames, no draw counter", () => {
  const first = buildMapExport({ pack, drawnLines: drawn });
  const reopened = buildMapExport({ pack, drawnLines: JSON.parse(JSON.stringify(drawn)).reverse().map((l) => ({ ...l, name: `renamed ${l.name}` })) });
  assert.deepEqual(reopened.plans.map((p) => p.planId), first.plans.map((p) => p.planId));
  // with a key the id survives geometry edits; without one the id follows the geometry
  const edited = buildMapExport({ pack, drawnLines: [line("a", [[139, 35], [139.011, 35]])] });
  assert.ok(first.plans.some((p) => p.planId === edited.plans[0].planId));
  const keyless = (coords) => buildMapExport({ pack, drawnLines: [{ vertices: coords.map((c) => ({ location: c })) }] }).plans[0].planId;
  assert.equal(keyless([[139, 35], [139.01, 35]]), keyless([[139, 35], [139.01, 35]]));
  assert.notEqual(keyless([[139, 35], [139.01, 35]]), keyless([[139, 35], [139.02, 35]]));
});

test("editor state adapter skips lines seeded from the real network", () => {
  const stations = new Map(["d0", "d1"].map((id, i) => [id, { id, name: id, named: true, location: [139 + i / 100, 35] }]));
  const state = { stations, lines: [{ name: "mine", key: null, external: false, stationIds: ["d0", "d1"] }, { name: "real", external: true, stationIds: ["d0", "d1"] }] };
  const lines = drawnLinesFromState(state);
  assert.deepEqual(lines.map((l) => l.name), ["mine"]);
  assert.equal(lines[0].vertices[0].demandNodeId, "d0");
});

// --- unknown is never zero ---
const unknownPath = (item, name) => (name.startsWith("crossings.") ? item.crossings[name.slice(10)] : item[name]);
function assertUnknownsAreNull(plan) {
  for (const item of [...plan.segments, ...plan.stationCandidates]) {
    for (const name of item.unknown) {
      if (name === "platformLengthM") assert.equal("platformLengthM" in item, false, "engine reads null as 0, so the key is omitted");
      else assert.equal(unknownPath(item, name), null, `${name} must be null, not a made-up number`);
    }
  }
}

test("with no spatial data every unknown is null and listed, never 0", () => {
  const plan = buildMapExport({ pack, drawnLines: [{ key: "k", vertices: [{ location: [139, 35] }, { location: [139.01, 35] }] }] }).plans[0];
  const seg = plan.segments[0];
  assert.deepEqual([seg.elevationStartMeters, seg.elevationEndMeters, seg.maxSlopeDegrees, seg.crossings.river, seg.crossings.road, seg.crossings.building, seg.crossings.utility], Array(7).fill(null));
  assert.ok(seg.unknown.includes("elevationStartMeters") && seg.unknown.includes("crossings.road"));
  assert.equal(plan.stationCandidates[0].platformType, null);
  assertUnknownsAreNull(plan);
  assert.equal(validatePlanGeometry(plan).buildable, "conditional");
  assert.notEqual(plan.dataQuality, "high");
});

test("a value the player gave passes through; a depth that cannot be derived stays unknown", () => {
  const plan = buildPlanGeometry({ key: "k", legs: [{ structureHint: "shield" }], vertices: [{ location: [139, 35], platformType: "island", platformLengthM: 140, depthMeters: 20, structure: "shield" }, { location: [139.01, 35] }] },
    { pack, demandNodes: [], externalNetworks: [], mode: "scratch" });
  assert.equal(plan.stationCandidates[0].platformLengthM, 140);
  assert.equal(plan.stationCandidates[0].depthMeters, 20);
  assert.equal(plan.stationCandidates[1].structure, "shield");
  assert.equal(plan.stationCandidates[1].depthMeters, null, "an underground station's depth is not derivable");
  assert.ok(plan.stationCandidates[1].unknown.includes("depthMeters"));
  assertUnknownsAreNull(plan);
});

test("a shallow station's depth is derived and marked inferred, not reported as unknown", () => {
  const plan = buildMapExport({ pack, drawnLines: [line("k", [[139, 35], [139.01, 35]], { legs: [{ structureHint: "elevated" }] })] }).plans[0];
  assert.equal(plan.stationCandidates[0].depthMeters, 0);
  assert.ok(plan.stationCandidates[0].inferred.includes("depthMeters"));
  assert.equal(plan.stationCandidates[0].unknown.includes("depthMeters"), false);
});

test("an invalid structure hint is refused visibly, not silently accepted", () => {
  const exp = buildMapExport({ pack, drawnLines: [line("k", [[139, 35], [139.01, 35]], { legs: [{ structureHint: "teleporter" }] })] });
  assert.equal(exp.plans[0].warnings[0].code, "invalid-structure-hint");
  assert.ok(STRUCTURE_HINTS.includes(exp.plans[0].segments[0].structureHint));
  assert.equal(exp.plans[0].segments[0].structureHintBasis.startsWith("inferred") || exp.plans[0].segments[0].structureHintBasis.startsWith("default"), true);
});

test("structure hints the map may send are exactly the ones the engine accepts", () => {
  for (const hint of STRUCTURE_HINTS) {
    const plan = buildMapExport({ pack, drawnLines: [line("k", [[139, 35], [139.01, 35]], { legs: [{ structureHint: hint }] })] }).plans[0];
    assert.equal(validatePlanGeometry(plan).violations.length, 0, hint);
  }
});

// --- demand nodes, stations and access links ---
test("demand nodes without any station are handled; missing residents stay unknown", () => {
  const p = packOf([pt("far", 140, 36), pt("near", 139.0005, 35, { residents: undefined, jobs: undefined })]);
  const exp = buildMapExport({ pack: p, drawnLines: [line("k", [[139, 35], [139.01, 35]])] });
  assert.equal(exp.demandNodes.find((n) => n.id === "near").residents, null);
  assert.equal(exp.plans[0].accessLinks.some((l) => l.demandNodeId === "far"), false);
  assert.deepEqual(exp.demandCoverage, { demandNodes: 2, withStationLinks: 1, withoutStations: 1 });
  const none = buildMapExport({ pack: p, drawnLines: [] });
  assert.deepEqual([none.plans.length, none.demandCoverage.withoutStations], [0, 2]);
  const tooShort = buildMapExport({ pack: p, drawnLines: [{ name: "x", vertices: [{ location: [139, 35] }] }, { name: "y", vertices: [{ location: [139, 35] }, { location: [139, 35] }] }] });
  assert.deepEqual(tooShort.warnings.map((w) => w.code), ["drawn-line-too-short", "drawn-line-too-short"]);
});

test("one demand node links to several stations with different walking times the engine accepts", () => {
  const p = packOf([pt("mid", 139.004, 35), pt("onstation", 139, 35)]);
  const plan = buildMapExport({ pack: p, drawnLines: [line("k", [[139, 35], [139.006, 35], [139.02, 35]])] }).plans[0];
  const links = plan.accessLinks.filter((l) => l.demandNodeId === "mid");
  assert.equal(links.length, 2, "the third station is beyond the walking radius");
  assert.notEqual(links[0].walkMinutes, links[1].walkMinutes);
  const onStation = plan.accessLinks.find((l) => l.demandNodeId === "onstation" && l.distanceMeters === 0);
  assert.equal(onStation.walkMinutes, 1, "engine rejects 0 minutes");
  const domain = cityPackToDomain(p);
  domain.stations = plan.stationCandidates.map((s) => ({ id: s.id, location: s.location }));
  for (const link of plan.accessLinks) addAccessLink(domain, link);
  assert.equal(domain.accessLinks.length, plan.accessLinks.length);
});

// --- both start modes share one contract ---
const withNetwork = packOf([pt("d0", 139, 35), pt("d1", 139.01, 35), pt("d2", 139.02, 35)], {
  existingNetwork: { lines: [{ name: "E1", osmRelationId: 42, kind: "subway", stationIds: ["d0", "d1", "zzz", "d2"] }, { name: "E2", stationIds: ["d1", "d1", "d2"] }] },
});

test("existing network becomes a stable ExternalNetwork and unknown references are reported", () => {
  const a = buildMapExport({ pack: withNetwork, mode: "existing" }).externalNetworks[0];
  const b = buildMapExport({ pack: withNetwork, mode: "existing" }).externalNetworks[0];
  assert.deepEqual(a, b);
  assert.equal(a.id, "external:t");
  assert.equal(a.owner, "external");
  assert.ok(a.lines.some((l) => l.id === "ext-line:42"));
  assert.deepEqual(a.lines.find((l) => l.name === "E2").stationIds, ["d1", "d2"], "consecutive repeats collapse");
  assert.equal(a.warnings[0].code, "unknown-station-ref");
  assert.equal(a.stations.find((s) => s.id === "d1").lineIds.length, 2);
  assert.equal(a.dataQuality, "low");
});

test("existing and scratch modes produce the same contract; only the world differs", () => {
  const cross = line("k", [[139.005, 34.99], [139.005, 35.01]]);
  const existing = buildMapExport({ pack: withNetwork, mode: "existing", drawnLines: [cross] });
  const scratch = buildMapExport({ pack: withNetwork, mode: "scratch", drawnLines: [cross] });
  assert.deepEqual(Object.keys(existing), Object.keys(scratch));
  assert.deepEqual(Object.keys(existing.plans[0]), Object.keys(scratch.plans[0]));
  assert.equal(existing.plans[0].planId, scratch.plans[0].planId);
  assert.equal(scratch.externalNetworks.length, 0);
  assert.equal(scratch.plans[0].segments[0].crossings.railway, 0, "a blank map has no railway to cross");
  assert.equal(existing.plans[0].segments[0].crossings.railway, 1, "E1 runs east-west through the drawn line; E2 does not reach it");
  assert.ok(existing.plans[0].segments[0].constraintFlags.includes("railway-crossing"));
  const atD1 = buildMapExport({ pack: withNetwork, mode: "existing", drawnLines: [line("t", [[139.01, 35], [139.03, 35.02]])] }).plans[0].stationCandidates[0];
  assert.equal(atD1.transferTargets[0].stationId, "d1");
  assert.equal(scratch.plans[0].stationCandidates[0].transferTargets.length, 0);
  for (const plan of [existing.plans[0], scratch.plans[0]]) assert.notEqual(validatePlanGeometry(plan).buildable, false);
});

test("existing mode on a pack with no network falls back to scratch, visibly", () => {
  const exp = buildMapExport({ pack, mode: "existing", drawnLines: [] });
  assert.equal(exp.mode, "scratch");
  assert.equal(exp.warnings[0].code, "no-existing-network");
});

test("lines that only touch at a shared station do not count as crossing", () => {
  const exp = buildMapExport({ pack: withNetwork, mode: "existing", drawnLines: [line("k", [[139, 35], [139.0, 35.02]])] });
  assert.equal(exp.plans[0].segments[0].crossings.railway, 0);
});

// --- spatial layers ---
test("layers report crossings, and null where the layer does not cover the alignment", () => {
  const water = waterLayerFromBarriers({ barriers: [{ kind: "water", polygon: [[[139.002, 34.99], [139.003, 34.99], [139.003, 35.01], [139.002, 35.01], [139.002, 34.99]]] }] });
  const roads = roadLayerFromGeojson({ features: [
    { geometry: { coordinates: [[139.004, 34.99], [139.004, 35.01]] }, properties: { roadClass: "major" } },
    { geometry: { coordinates: [[139.005, 34.99], [139.005, 35.01]] }, properties: { roadClass: "minor" } },
  ] });
  const buildings = buildingLayerFromObstacles({ obstacles: [
    { kind: "building", district: "x", polygon: [[139.0055, 34.9995], [139.0056, 34.9995], [139.0056, 35.0005], [139.0055, 35.0005], [139.0055, 34.9995]] },
    { kind: "building", district: "x", polygon: [[139.0, 35.05], [139.01, 35.05], [139.01, 35.1], [139.0, 35.1], [139.0, 35.05]] },
  ] });
  const spatial = makeSpatialContext({ water, roads, buildings });
  const inside = spatial.crossings([[139.001, 35], [139.006, 35]]);
  assert.equal(inside.river, 1);
  assert.deepEqual(inside.road, { highway: 0, major: 1, minor: 1 });
  assert.equal(inside.building, 1);
  assert.equal(inside.utility, null);
  assert.equal(spatial.crossings([[139.001, 35], [139.5, 35]]).building, null, "outside the footprint districts nothing is known");
});

test("elevation and slope come from the injected DEM, null when it has no value", () => {
  const dem = { elevationAt: ([lon]) => (lon < 139.01 ? 12 : null), slopeAt: ([lon]) => (lon < 139.005 ? 5 : 1), quality: "medium" };
  const spatial = makeSpatialContext({ dem });
  assert.equal(spatial.elevationAt([139, 35]), 12);
  assert.equal(spatial.elevationAt([139.02, 35]), null);
  const seg = buildMapExport({ pack, spatial, drawnLines: [line("k", [[139, 35], [139.008, 35]])] }).plans[0].segments[0];
  assert.equal(seg.elevationStartMeters, 12);
  assert.equal(seg.maxSlopeDegrees, 5);
  assert.ok(seg.steepShare > 0 && seg.steepShare < 1);
  assert.equal(seg.constraintFlags.includes("steep-slope"), seg.steepShare >= 0.25);
});

test("thin steep cells on flat ground do not flag steep terrain", () => {
  const dem = { elevationAt: () => 3, slopeAt: ([lon]) => (Math.abs(lon - 139.004) < 0.0004 ? 15 : 0.2), quality: "medium" };
  const seg = buildMapExport({ pack, spatial: makeSpatialContext({ dem }), drawnLines: [line("k", [[139, 35], [139.01, 35]])] }).plans[0].segments[0];
  assert.equal(seg.maxSlopeDegrees, 15);
  assert.equal(seg.constraintFlags.includes("steep-slope"), false);
});

test("station on a cell with no DEM value keeps a null elevation instead of 0", () => {
  const spatial = makeSpatialContext({ dem: { elevationAt: () => null, slopeAt: () => null } });
  const plan = buildMapExport({ pack, spatial, drawnLines: [line("k", [[139, 35], [139.01, 35]])] }).plans[0];
  assert.equal(plan.stationCandidates[0].groundElevationMeters, null);
  assert.equal(plan.segments[0].gradientPermille, null);
});

test("minimum curve radius follows the drawn bend and is capped for a straight run", () => {
  const straight = buildMapExport({ pack, drawnLines: [line("s", [[139, 35], [139.01, 35], [139.02, 35]])] }).plans[0].segments[0];
  assert.equal(straight.minCurveRadiusMeters, 100000);
  const bent = buildMapExport({ pack, drawnLines: [line("b", [[139, 35], [139.01, 35], [139.01, 35.01]])] }).plans[0].segments[0];
  assert.ok(bent.minCurveRadiusMeters < 1000 && bent.minCurveRadiusMeters > 100, `90 degree bend, got ${bent.minCurveRadiusMeters}`);
  const game = new ManagementGame({ countryId: "JP" });
  const tight = buildMapExport({ pack, drawnLines: [line("t", [[139, 35], [139.001, 35], [139.001, 35.001]])] }).plans[0];
  assert.ok(game.assess(tight, "medium_steel").violations.length >= 0);
});

// --- engine feedback shown on the map ---
const plan3 = () => buildMapExport({ pack, drawnLines: [drawn[0]] }).plans[0];
const exportOf = (plan) => ({ plans: [plan] });

test("every construction phase maps from the engine's status, and unknown statuses are not guessed", () => {
  const plan = plan3();
  const project = { estimated: "underReview", approved: "underReview", contracted: "underConstruction", underConstruction: "underConstruction", inspection: "inspection", available: "available", cancelled: "cancelled", suspended: "halted", halted: "halted" };
  for (const [status, phase] of Object.entries(project)) {
    assert.equal(buildOverlayModel(exportOf(plan), { projects: [{ planId: plan.planId, status }] }).plans[0].phase, phase, status);
  }
  const record = { "needs-information": "planned", rejected: "planned", assessed: "underReview", approved: "underReview", "in-project": "underReview", "assets-available": "available", commissioned: "available" };
  for (const [status, phase] of Object.entries(record)) {
    assert.equal(buildOverlayModel(exportOf(plan), { plans: { [plan.planId]: { status } } }).plans[0].phase, phase, status);
  }
  assert.equal(buildOverlayModel(exportOf(plan), {}).plans[0].phase, "planned");
  const odd = buildOverlayModel(exportOf(plan), { projects: [{ planId: plan.planId, status: "teleported" }] });
  assert.equal(odd.plans[0].phase, null);
  assert.equal(odd.diagnostics.some((d) => d.code === "unknown-status"), true);
  assert.deepEqual(Object.values(PHASES).map((p) => p.label), ["계획", "심사 중", "공사 중", "공사 중단", "✕ 사업 취소", "검사 중", "사용 가능"]);
  const delayed = buildOverlayModel(exportOf(plan), { projects: [{ planId: plan.planId, status: "underConstruction", delayMonths: 2, progress: 0.4 }] }).plans[0];
  assert.deepEqual([delayed.phase, delayed.delayed, delayed.progress], ["underConstruction", true, 0.4]);
});

test("engine violations land on the station or segment they are about", () => {
  const plan = plan3();
  plan.segments[1].lengthMeters = 0;
  plan.stationCandidates[0].platformLengthM = 10;
  const assessment = new ManagementGame({ countryId: "JP" }).assess(plan, "medium_steel");
  const model = buildOverlayModel(exportOf(plan), { assessments: { [plan.planId]: assessment } });
  const engine = model.diagnostics.filter((d) => d.source === "engine");
  assert.ok(engine.some((d) => d.severity === "error" && d.target.type === "segment" && d.target.id === plan.segments[1].id));
  assert.ok(engine.some((d) => d.severity === "error" && d.target.type === "station" && d.target.id === plan.stationCandidates[0].id));
  assert.equal(model.plans[0].segments[1].severity, "error");
  assert.equal(model.plans[0].stations[0].severity, "error");
});

test("a conditional verdict and missing inputs are shown, together with the map's own unknowns", () => {
  const plan = buildMapExport({ pack, drawnLines: [{ key: "u", vertices: [{ location: [139, 35] }, { location: [139.01, 35] }] }] }).plans[0];
  const assessment = new ManagementGame({ countryId: "JP" }).assess(plan, "medium_steel");
  assert.equal(assessment.buildable, "conditional");
  const { diagnostics } = buildOverlayModel(exportOf(plan), { assessments: { [plan.planId]: assessment } });
  assert.ok(diagnostics.some((d) => d.code === "engine-conditional"));
  assert.ok(diagnostics.some((d) => d.code === "engine-missing-input" && d.target.type === "station"));
  assert.ok(diagnostics.some((d) => d.source === "map" && d.code === "map-unknown-data"));
  assert.notEqual(diagnostics[0].severity, "info", "worst first");
});

test("the overlay never changes what the engine gave it, or the engine's own state", () => {
  const plan = plan3();
  const game = new ManagementGame({ countryId: "JP" });
  const record = game.submitPlan(plan, "medium_steel");
  const report = { plans: game.plans, projects: game.projects, assessments: { [plan.planId]: record.assessment } };
  const before = JSON.stringify([game.plans, game.projects, game.ledger.cash, report]);
  const model = buildOverlayModel(deepFreeze(structuredClone(exportOf(plan))), deepFreeze(structuredClone(report)));
  assert.equal(JSON.stringify(buildOverlayModel(exportOf(plan), report)), JSON.stringify(model), "deterministic");
  assert.equal(JSON.stringify([game.plans, game.projects, game.ledger.cash, report]), before);
});

test("drawing uses the phase colour and dash, and marks errors", () => {
  const plan = plan3();
  plan.segments[0].lengthMeters = 0;
  const assessment = new ManagementGame({ countryId: "JP" }).assess(plan, "medium_steel");
  const model = buildOverlayModel(exportOf(plan), { projects: [{ planId: plan.planId, status: "underConstruction", progress: 0.5 }], assessments: { [plan.planId]: assessment } });
  const calls = [];
  const ctx = new Proxy({}, { get: (t, k) => (k in t ? t[k] : (...args) => calls.push([k, ...args])), set: (t, k, v) => { t[k] = v; calls.push(["set", k, v]); return true; } });
  drawPlanOverlay(ctx, model, ([lon, lat]) => [(lon - 139) * 1e4, -(lat - 35) * 1e4]);
  assert.ok(calls.some((c) => c[0] === "set" && c[1] === "strokeStyle" && c[2] === PHASES.underConstruction.color));
  assert.ok(calls.some((c) => c[0] === "setLineDash" && JSON.stringify(c[1]) === JSON.stringify(PHASES.underConstruction.dash)));
  assert.ok(calls.some((c) => c[0] === "fillText" && c[1].includes("공사 중 50%")));
  assert.ok(calls.some((c) => c[0] === "set" && c[1] === "fillStyle" && c[2] === "#e5484d"), "error marker");
});

// --- boundaries: engine untouched, no geometry in the engine layer ---
test("map layer only produces data: it does not import the management engine or touch money", () => {
  const dir = path.join(root, "engine/src/map");
  for (const file of fs.readdirSync(dir)) {
    const src = fs.readFileSync(path.join(dir, file), "utf8");
    for (const m of src.matchAll(/from "([^"]+)"/g)) assert.match(m[1], /^\.\/[a-z-]+\.mjs$|^\.\.\/(projection|geometry)\.mjs$/, `${file} imports ${m[1]}`);
    assert.doesNotMatch(src, /ledger|\.commit\(|\.settle\(|\.post\(|node:fs/, `${file} must not reach engine state or the file system`);
    assert.ok(src.length < 40_000, `${file} holds code, not data`);
  }
});

// --- shipped examples ---
const exampleFiles = (id) => fs.readdirSync(path.join(root, "packs", id, "plan-examples")).filter((f) => f.endsWith(".plan.json"));
const readExample = (id, f) => JSON.parse(fs.readFileSync(path.join(root, "packs", id, "plan-examples", f), "utf8"));

test("the Tokyo pack and the synthetic packs each ship at least three PlanGeometry examples", () => {
  assert.ok(exampleFiles("tokyo").length >= 3);
  assert.ok(exampleFiles("example-radial").length >= 3);
  assert.ok(exampleFiles("example-corridor").length >= 1);
});

test("every example is accepted by the engine, keeps unknowns null, and carries its pack license", () => {
  const expected = {
    "tokyo/01-bay-ward-spine-existing.plan.json": true, "tokyo/02-east-river-crossing-existing.plan.json": true,
    "tokyo/03-tama-hills-scratch.plan.json": "conditional", "tokyo/04-shinjuku-free-placed-scratch.plan.json": "conditional",
    "example-radial/01-radial-spoke-annotated.plan.json": true, "example-radial/02-ring-arc-unannotated.plan.json": "conditional",
    "example-radial/03-cross-city-with-bend.plan.json": true, "example-corridor/01-corridor-trunk.plan.json": true,
    "tokyo/05-station-variants-scratch.plan.json": true, "example-radial/04-station-variants.plan.json": true, "example-radial/05-transfer-stub.plan.json": true,
  };
  for (const id of ["tokyo", "example-radial", "example-corridor"]) {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "packs", id, "manifest.json"), "utf8"));
    for (const f of exampleFiles(id)) {
      const plan = readExample(id, f);
      assert.equal(validatePlanGeometry(plan).buildable, expected[`${id}/${f}`], `${id}/${f}`);
      assertUnknownsAreNull(plan);
      assert.equal(plan.sourcePackId, id);
      assert.equal(plan.sources.pack.license, manifest.data.license, "the plan carries the pack's license, not a made-up one");
      assert.ok(["high", "medium", "low"].includes(plan.dataQuality));
      const again = buildMapExport({ pack: { manifest, demand: { points: [] } }, drawnLines: [plan.source.drawnLine] }).plans[0];
      assert.equal(again.planId, plan.planId, "plan id is reproducible from the drawn line alone");
    }
  }
});

test("the Tokyo examples cover both modes, and each real-data layer they used says where it came from", () => {
  const plans = exampleFiles("tokyo").map((f) => readExample("tokyo", f));
  assert.deepEqual([...new Set(plans.map((p) => p.mode))].sort(), ["existing", "scratch"]);
  assert.ok(plans.some((p) => p.stationCandidates.some((s) => s.transferTargets.length > 0)));
  assert.ok(plans.some((p) => p.segments.some((s) => s.constraintFlags.includes("water-crossing"))));
  assert.ok(plans.some((p) => p.segments.some((s) => s.constraintFlags.includes("steep-slope"))));
  assert.ok(plans.some((p) => p.segments.some((s) => s.crossings.building > 0)));
  for (const p of plans) for (const layer of p.sources.layers) assert.ok(layer.license && layer.name, `${layer.layer} needs a name and a license`);
  assert.ok(plans.flatMap((p) => p.sources.layers).some((l) => l.license === "ODbL-1.0"));
  assert.ok(plans.every((p) => p.sources.pack.license === "ODbL-1.0"), "OSM-derived data only ships under the pack's ODbL");
});

test("synthetic-pack examples regenerate byte-for-byte from their drawn lines", () => {
  for (const id of ["example-radial", "example-corridor"]) {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "packs", id, "manifest.json"), "utf8"));
    const demand = JSON.parse(fs.readFileSync(path.join(root, "packs", id, manifest.files.demand), "utf8"));
    for (const f of exampleFiles(id)) {
      const { source, ...body } = readExample(id, f);
      const fresh = buildMapExport({ pack: { manifest, demand }, mode: source.requestedMode, drawnLines: [source.drawnLine] }).plans[0];
      assert.equal(JSON.stringify(fresh), JSON.stringify(body), `${id}/${f} is stale: run scripts/build-plan-examples.mjs`);
    }
  }
});
