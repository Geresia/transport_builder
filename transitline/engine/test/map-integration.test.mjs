import test from "node:test";
import assert from "node:assert/strict";
import { buildMapExport, buildPlanGeometry, drawnLinesFromState } from "../src/map/plan-geometry.mjs";
import { makeSpatialContext, polygonLayer } from "../src/map/spatial.mjs";
import { buildOverlayModel, defineViewSlots, PHASES, renderPhaseLegend } from "../src/map/overlay.mjs";
import { planIdForKey, planningDefaults, ScenarioRuntime, stablePlanKey } from "../src/scenario-runtime.mjs";
import { addLine, createState } from "../src/state.mjs";
import { restoreOperationalState, snapshotOperationalState } from "../src/integrated-save.mjs";

// The map screen's hand-off to and from the rest of the game: what is kept across a save, and what the engine's
// report looks like once it comes back to the map.
function pack() {
  const points = Array.from({ length: 7 }, (_, index) => ({ id: `point-${index + 1}`, name: `Point ${index + 1}`, location: [139 + index * 0.075, 35], residents: 7_000 + index * 500, jobs: 9_000 - index * 400 }));
  return { manifest: { id: "runtime", version: "1", data: { license: "test", attribution: [] } }, demand: { model: "gravity", points, attractors: [] } };
}
const options = planningDefaults("medium_steel", "elevated", "island");
const drawn = (source) => ({
  key: stablePlanKey(source.manifest.id, source.demand.points.map((p) => p.id)), name: "Runtime Line",
  vertices: source.demand.points.map((p) => ({ location: p.location, demandNodeId: p.id, structure: options.structure, depthMeters: options.depthMeters, platformType: options.platformType, platformLengthM: options.platformLengthM })),
  legs: source.demand.points.slice(1).map(() => ({ structureHint: options.structure })),
});
const geometryOf = (source) => buildMapExport({ pack: source, mode: "scratch", drawnLines: [drawn(source)] }).plans[0];

// --- C0.1: keys survive a save and reopen ---
test("a drawn line's key is saved with the game and gives the same plan id after reopening", () => {
  const source = pack();
  const state = createState(source);
  const ids = source.demand.points.map((p) => p.id);
  const key = stablePlanKey(source.manifest.id, ids);
  addLine(state, ids, { name: "L", key, planOnly: true, suspended: true, planningOptions: options });
  const before = buildMapExport({ pack: source, mode: "scratch", drawnLines: drawnLinesFromState(state) }).plans[0].planId;
  assert.equal(before, planIdForKey("runtime", key));

  const reopened = restoreOperationalState(JSON.parse(JSON.stringify(snapshotOperationalState(state))));
  assert.equal(reopened.lines[0].key, key);
  assert.equal(buildMapExport({ pack: source, mode: "scratch", drawnLines: drawnLinesFromState(reopened) }).plans[0].planId, before);
  assert.equal(stablePlanKey("runtime", [...ids].reverse()), key, "drawn in the other direction is the same plan");
});

test("display models on the state are never written into a save", () => {
  const source = pack();
  const state = defineViewSlots(createState(source));
  const runtime = new ScenarioRuntime({ pack: source, operationalState: state, networkMode: "scratch", seed: 5 });
  state.mapOverlay = { plans: [{ marker: "overlay-only" }] };
  state.depotView = { marker: "depot-only" };
  state.stationView = { marker: "station-only" };
  state.constructionView = { marker: "construction-only" };
  state.throughHandoverView = { marker: "handover-only" };
  const saved = runtime.save();
  assert.doesNotMatch(saved, /overlay-only|depot-only|station-only|construction-only|handover-only/);
  assert.equal(Object.keys(JSON.parse(saved).operations).some((k) => ["mapOverlay", "depotView", "stationView", "constructionView", "throughHandoverView"].includes(k)), false);
  runtime.load(saved);
  for (const name of ["mapOverlay", "depotView", "stationView", "constructionView", "throughHandoverView"]) {
    const d = Object.getOwnPropertyDescriptor(state, name);
    assert.ok(d && d.enumerable === false && d.writable, `${name} is still a hidden, writable slot after a load`);
  }
  state.mapOverlay = null; // the renderer can keep writing to it
});

// --- C0.2: missing data is null with a reason, on plans too ---
test("every unknown value in a PlanGeometry carries a reason; player-supplied gaps say so", () => {
  const source = pack();
  const bare = buildMapExport({ pack: source, mode: "scratch", drawnLines: [{ key: "bare", vertices: source.demand.points.slice(0, 3).map((p) => ({ location: p.location })) }] }).plans[0];
  for (const item of [...bare.segments, ...bare.stationCandidates]) {
    for (const f of item.unknown) assert.ok(item.unknownReasons[f], `${f} needs a reason`);
    assert.deepEqual(Object.keys(item.unknownReasons).sort(), [...item.unknown].sort());
  }
  assert.equal(bare.segments[0].unknownReasons.elevationStartMeters, "no-layer");
  assert.equal(bare.segments[0].unknownReasons["crossings.building"], "no-layer");
  assert.equal(bare.stationCandidates[0].unknownReasons.platformType, "not-provided");
  assert.equal(bare.stationCandidates[0].unknownReasons.groundElevationMeters, "no-layer");
});

test("a layer that does not cover the place is 'outside-coverage', a DEM without a slope grid says so, and a covered empty layer is a real 0", () => {
  const source = pack();
  const line = { key: "cov", vertices: source.demand.points.slice(0, 2).map((p) => ({ location: p.location, platformType: "side" })) };
  const layer = (extra = {}) => polygonLayer([], { quality: "high", source: { name: "l", license: "CC0-1.0" }, ...extra });
  const dem = { elevationAt: () => 10, covers: () => false, quality: "medium", source: { name: "d", license: "CC0-1.0" } };
  const outside = buildMapExport({ pack: source, mode: "scratch", drawnLines: [line], spatial: makeSpatialContext({ dem, buildings: layer({ covers: () => false }) }) }).plans[0];
  assert.equal(outside.segments[0].unknownReasons["crossings.building"], "outside-coverage");
  assert.equal(outside.segments[0].unknownReasons.elevationStartMeters, "outside-coverage");
  assert.equal(outside.segments[0].crossings.building, null);
  const noGrid = buildMapExport({ pack: source, mode: "scratch", drawnLines: [line], spatial: makeSpatialContext({ dem: { ...dem, covers: undefined } }) }).plans[0];
  assert.equal(noGrid.segments[0].unknownReasons.maxSlopeDegrees, "no-slope-grid");
  assert.equal(noGrid.segments[0].elevationStartMeters, 10);
  const known = buildMapExport({ pack: source, mode: "scratch", drawnLines: [line], spatial: makeSpatialContext({ buildings: layer() }) }).plans[0];
  assert.equal(known.segments[0].crossings.building, 0);
  assert.ok(!known.segments[0].unknown.includes("crossings.building"));
  // an adapter that cannot say why still gets a reason, and the value stays null
  const mock = { elevationAt: () => null, maxSlopeAlong: () => null, crossings: () => ({ river: null, road: null, railway: null, building: null, utility: null }), quality: {}, sources: [] };
  const seg = buildPlanGeometry(line, { pack: source, spatial: mock, demandNodes: [], externalNetworks: [], mode: "scratch" }).segments[0];
  assert.equal(seg.unknownReasons["crossings.river"], "unspecified");
  assert.equal(seg.crossings.river, null);
});

// --- C0.3: the engine's real report reaches the map ---
test("the report the scenario runtime returns drives the phases, diagnostics and suspension note on the map", () => {
  const source = pack();
  const state = defineViewSlots(createState(source));
  const runtime = new ScenarioRuntime({ pack: source, operationalState: state, networkMode: "scratch", seed: 901 });
  const geometry = geometryOf(source);
  const map = { plans: [geometry], externalNetworks: [] };
  const phaseOf = () => buildOverlayModel(map, runtime.report()).plans[0];

  assert.equal(phaseOf().phase, "planned", "drawn, nothing reported yet");
  runtime.viewOpportunity();
  runtime.researchOpportunity(2);
  runtime.decideBid("bid", runtime.scenarioOpportunity().baselineAnnualCost * 0.9);
  assert.equal(runtime.submit(geometry, "medium_steel").status, "assessed");
  assert.equal(phaseOf().phase, "underReview");
  runtime.submitTenderProposal(geometry.planId);
  if (runtime.evaluateTender().status === "single-bid-review") runtime.reviewSingleBid(true);
  runtime.concludeAward();
  runtime.approveAndCreate(geometry.planId);
  assert.equal(phaseOf().phase, "underReview", "estimated is not construction yet");
  runtime.contract(geometry.planId);
  runtime.advanceMonths(1);
  assert.equal(phaseOf().phase, "underConstruction");

  runtime.suspend(geometry.planId, "resident consultation");
  const suspended = buildOverlayModel(map, runtime.report());
  assert.equal(suspended.plans[0].phase, "halted");
  const note = suspended.diagnostics.find((d) => d.code === "engine-suspended");
  assert.match(note.message, /resident consultation/);
  assert.equal(note.severity, "info");
  runtime.resume(geometry.planId);
  assert.equal(phaseOf().phase, "underConstruction");
});

test("the engine's own assessment shows up on the plan, station and segment it names", () => {
  const source = pack();
  const state = createState(source);
  const runtime = new ScenarioRuntime({ pack: source, operationalState: state, networkMode: "scratch", seed: 7 });
  runtime.viewOpportunity();
  runtime.researchOpportunity(2);
  runtime.decideBid("bid", runtime.scenarioOpportunity().baselineAnnualCost * 0.9);
  const short = structuredClone(geometryOf(source));
  short.stationCandidates[2].platformLengthM = 20; // shorter than a train: the engine says so, naming the station
  delete short.stationCandidates[3].platformType; // and one station lacks a platform type
  const result = runtime.submit(short, "medium_steel");
  assert.notEqual(result.status, "assessed");
  const model = buildOverlayModel({ plans: [short] }, runtime.report());
  const errors = model.diagnostics.filter((d) => d.source === "engine" && d.severity === "error");
  assert.ok(errors.some((d) => d.target.type === "station" && d.target.id === short.stationCandidates[2].id), "the violation lands on its station");
  assert.equal(model.plans[0].stations[2].severity, "error");
  assert.ok(model.diagnostics.some((d) => d.code === "engine-missing-input" && d.target.id === short.stationCandidates[3].id), "the missing input lands on its station");
});

// --- C0.4: a pause and an end are different things on the map ---
test("suspended and cancelled projects have their own colour, dash, label and legend row", () => {
  assert.notEqual(PHASES.halted.color, PHASES.cancelled.color);
  assert.notEqual(PHASES.halted.label, PHASES.cancelled.label);
  assert.notDeepEqual(PHASES.halted.dash, PHASES.cancelled.dash);
  assert.equal(new Set(Object.values(PHASES).map((p) => p.color)).size, Object.keys(PHASES).length, "no two phases share a colour");
  const map = { plans: [geometryOf(pack())] };
  const planId = map.plans[0].planId;
  const model = (status) => buildOverlayModel(map, { plans: [], projects: [{ planId, status, suspensionReason: "why" }], assessments: {} });
  assert.equal(model("suspended").plans[0].phase, "halted");
  assert.equal(model("cancelled").plans[0].phase, "cancelled");
  assert.ok(model("cancelled").diagnostics.some((d) => d.code === "engine-cancelled"));
  assert.ok(!model("cancelled").diagnostics.some((d) => d.code === "engine-suspended"));
  assert.equal(model("mystery").plans[0].phase, null, "an unknown status is shown as unknown, never guessed");
});

test("the legend lists every phase the map can draw, with its colour", () => {
  const doc = { createElement: (tag) => ({ tag, children: [], style: {}, className: "", textContent: "", ownerDocument: doc, append(...c) { this.children.push(...c); }, replaceChildren(...c) { this.children = c; } }) };
  const box = doc.createElement("div");
  renderPhaseLegend(box);
  const rows = box.children.filter((c) => c.className === "phase-legend-row");
  assert.equal(rows.length, Object.keys(PHASES).length);
  assert.deepEqual(rows.map((r) => r.children[1].textContent), Object.values(PHASES).map((p) => p.label));
  assert.deepEqual(rows.map((r) => r.children[0].style.borderTopColor), Object.values(PHASES).map((p) => p.color));
  assert.ok(rows.some((r) => r.children[1].textContent.includes("취소")) && rows.some((r) => r.children[1].textContent.includes("중단")));
  renderPhaseLegend(box);
  assert.equal(box.children.filter((c) => c.className === "phase-legend-row").length, Object.keys(PHASES).length, "rendering again replaces, not appends");
});
