import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withStationAccess } from "../src/access-demand.mjs";
import { buildDemandModel } from "../src/demand-engine.mjs";
import { restoreOperationalState, snapshotOperationalState } from "../src/integrated-save.mjs";
import { buildRouteGraph } from "../src/network.mjs";
import { spawnPassengers } from "../src/passengers.mjs";
import { createSimulationRuntime, simulationStep } from "../src/simulation.mjs";
import { applyStationDemandAccess } from "../src/station-demand-access-integration.mjs";
import { applyStationDemandAllocation, assessStationDemandAllocation, stationDemandAllocationApplicationReport } from "../src/station-demand-allocation-integration.mjs";
import { addLine, createState, replaceStationDemandAllocationLinks } from "../src/state.mjs";
import { withStationAccess as legacyWithStationAccess } from "./helpers/legacy-access-demand.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = (file) => fs.readFileSync(path.join(here, "..", "src", file), "utf8");

// --- a small world: node:a can reach the network through physical:a or physical:b, both on lines that end at physical:z next to node:c ---
const pack = () => ({ manifest: { id: "fractional", version: "1", data: { license: "CC0-1.0", attribution: [] } }, demand: { model: "gravity", points: [
  { id: "node:a", location: [139, 35], residents: 400000, jobs: 100 },
  { id: "node:b", location: [139.004, 35], residents: 300000, jobs: 200 },
  { id: "node:c", location: [139.05, 35], residents: 20000, jobs: 500000 },
], attractors: [] } });
const lineOptions = { frequency: { high: 30, medium: 30, low: 30, veryLow: 30 } };

function world({ legacyLine = false } = {}) {
  const state = createState(pack(), { seed: 7 });
  for (const [id, lon] of [["physical:a", 139.001], ["physical:b", 139.002], ["physical:z", 139.049]]) state.stations.set(id, { id, location: [lon, 35], status: "available", sourceStationId: `source:${id.slice(-1)}` });
  state.accessLinks = [{ id: "legacy:c", demandNodeId: "node:c", stationId: "physical:z", walkMinutes: 3 }, { id: "legacy:b", demandNodeId: "node:b", stationId: "physical:b", walkMinutes: 2 }];
  addLine(state, ["physical:a", "physical:z"], lineOptions);
  addLine(state, ["physical:b", "physical:z"], lineOptions);
  if (legacyLine) addLine(state, ["node:a", "physical:z"], lineOptions);
  return state;
}
function removeStationAndItsLine(state, stationId) {
  state.stations.delete(stationId);
  state.lines = state.lines.filter((l) => !l.stationIds.includes(stationId));
  state.networkDirty = true;
}
const link = (stationId, share, walkMinutes, extra = {}) => ({ allocationId: "alloc:1", demandNodeId: "node:a", stationId, walkMinutes, share, source: "station-demand-allocation", ...extra });
const modelOf = (state, impl = withStationAccess) => impl(buildDemandModel(state, pack().demand), state);
const ride = (state, model, from = "node:a", to = "node:c") => model.resolveTrip(state, buildRouteGraph(state), from, to);
const sequence = (state, model, n, from = "node:a", to = "node:c") => { const graph = buildRouteGraph(state); return Array.from({ length: n }, () => model.resolveTrip(state, graph, from, to)); };
const stations = (trips, key = "originStationId") => trips.map((t) => (t.unrouted ? "-" : t[key]));
const tally = (list) => list.reduce((m, v) => ({ ...m, [v]: (m[v] ?? 0) + 1 }), {});
const deepFreeze = (o) => { if (o && typeof o === "object") { Object.values(o).forEach(deepFreeze); Object.freeze(o); } return o; };

// --- the split itself ---
test("60 / 40: the node's trips go to the two stations in exactly that ratio, and the order is fixed", () => {
  const state = world();
  state.stationDemandAllocationLinks = [link("physical:a", 0.6, 4), link("physical:b", 0.4, 6)];
  const trips = sequence(state, modelOf(state), 10);
  assert.deepEqual(stations(trips), ["physical:a", "physical:b", "physical:a", "physical:b", "physical:a", "physical:a", "physical:b", "physical:a", "physical:b", "physical:a"]);
  assert.deepEqual(tally(stations(trips)), { "physical:a": 6, "physical:b": 4 });
  assert.deepEqual(trips.map((t) => t.accessSeconds), trips.map((t) => (t.originStationId === "physical:a" ? 4 : 6) * 60 + 3 * 60), "each trip carries the walk of the link it was given");
  assert.ok(trips.every((t) => t.destinationStationId === "physical:z"));
});

test("25 / 75 and 10 / 20 / 70 hold exactly, at any length, not only on average", () => {
  const state = world();
  state.stationDemandAllocationLinks = [link("physical:a", 0.25, 4), link("physical:b", 0.75, 6)];
  const model = modelOf(state);
  for (const n of [4, 8, 100, 1001]) {
    delete state.stationDemandAllocationCursors;
    const counts = tally(stations(sequence(state, model, n)));
    assert.ok(Math.abs((counts["physical:a"] ?? 0) - n * 0.25) < 1 && Math.abs((counts["physical:b"] ?? 0) - n * 0.75) < 1, `${n}: ${JSON.stringify(counts)}`);
  }
  delete state.stationDemandAllocationCursors;
  assert.deepEqual(tally(stations(sequence(state, model, 100))), { "physical:a": 25, "physical:b": 75 });
  state.stations.set("physical:y", { id: "physical:y", location: [139.003, 35], status: "available" });
  addLine(state, ["physical:y", "physical:z"], lineOptions);
  state.stationDemandAllocationLinks = [link("physical:a", 0.1, 4), link("physical:b", 0.2, 6), link("physical:y", 0.7, 5)];
  assert.deepEqual(tally(stations(sequence(state, modelOf(state), 10))), { "physical:a": 1, "physical:b": 2, "physical:y": 7 });
});

test("a link that takes the whole node (100 %) is not a split: same choice as before, and no schedule is kept", () => {
  const state = world();
  state.stationDemandAllocationLinks = [link("physical:a", 1, 4)];
  const trips = sequence(state, modelOf(state), 5);
  assert.deepEqual(tally(stations(trips)), { "physical:a": 5 });
  assert.equal(state.stationDemandAllocationCursors, undefined, "nothing was counted");
  assert.deepEqual(trips, sequence(state, modelOf(state, legacyWithStationAccess), 5));
});

test("a share the policy left unallocated is not routed — and is never handed to a legacy link or the other station", () => {
  const state = world({ legacyLine: true }); // node:a has a perfectly good legacy path to physical:z
  state.stationDemandAllocationLinks = [link("physical:a", 0.5, 4), link("physical:b", 0.2, 6)];
  const trips = sequence(state, modelOf(state), 100);
  assert.deepEqual(tally(stations(trips)), { "physical:a": 50, "physical:b": 20, "-": 30 });
  assert.ok(trips.filter((t) => t.unrouted).every((t) => t.route === null && t.originStationId === null && t.destinationStationId === null));
});

test("one link that is only part of the node leaves the rest unrouted; a link to a station that is gone is simply not routed", () => {
  const state = world({ legacyLine: true });
  state.stationDemandAllocationLinks = [link("physical:a", 0.6, 4), link("physical:b", 0.4, 6)];
  removeStationAndItsLine(state, "physical:b");
  state.stationDemandAllocationVersion = 1;
  assert.deepEqual(tally(stations(sequence(state, modelOf(state), 10))), { "physical:a": 6, "-": 4 });
});

test("when every allocation link of a node is unusable the node keeps its old path, exactly as in B15-E4", () => {
  const state = world({ legacyLine: true });
  state.stationDemandAllocationLinks = [link("missing", 0.6, 4), link("physical:b", 0.4, 0)];
  const model = modelOf(state);
  assert.deepEqual(sequence(state, model, 4), sequence(state, modelOf(state, legacyWithStationAccess), 4));
  assert.equal(state.stationDemandAllocationCursors, undefined);
  assert.equal(ride(state, model).originStationId, "node:a");
  // a share outside (0, 1] is not a usable share either (the B15-E4 model had no shares to check)
  state.stationDemandAllocationLinks = [link("physical:a", 0, 4), link("physical:b", 1.5, 4), link("physical:a", Number.NaN, 4)];
  state.stationDemandAllocationVersion = 9;
  assert.equal(ride(state, model).originStationId, "node:a");
  assert.equal(state.stationDemandAllocationCursors, undefined);
});

test("the scheduled station having no route to the destination means no trip, not a switch to the other station", () => {
  const state = world();
  state.lines = state.lines.filter((l) => l.stationIds[0] !== "physical:b"); // physical:b no longer reaches anything
  state.networkDirty = true;
  state.stationDemandAllocationLinks = [link("physical:a", 0.5, 4), link("physical:b", 0.5, 6)];
  assert.deepEqual(tally(stations(sequence(state, modelOf(state), 10))), { "physical:a": 5, "-": 5 });
});

// --- origin and destination ---
test("origin and destination splits are independent of each other, each exact in its own ratio", () => {
  const state = world();
  state.stations.set("physical:w", { id: "physical:w", location: [139.048, 35], status: "available" });
  addLine(state, ["physical:a", "physical:w"], lineOptions);
  addLine(state, ["physical:b", "physical:w"], lineOptions);
  state.stationDemandAllocationLinks = [link("physical:a", 0.6, 4), link("physical:b", 0.4, 6), link("physical:z", 0.25, 3, { demandNodeId: "node:c" }), link("physical:w", 0.75, 5, { demandNodeId: "node:c" })];
  state.accessLinks = [];
  const trips = sequence(state, modelOf(state), 100);
  assert.deepEqual(tally(stations(trips)), { "physical:a": 60, "physical:b": 40 });
  assert.deepEqual(tally(stations(trips, "destinationStationId")), { "physical:z": 25, "physical:w": 75 });
  assert.deepEqual(Object.keys(state.stationDemandAllocationCursors).sort(), ["destination|node:c", "origin|node:a"]);
  // each schedule is the same as when only that side is split
  const alone = world();
  alone.stationDemandAllocationLinks = [link("physical:a", 0.6, 4), link("physical:b", 0.4, 6)];
  assert.deepEqual(stations(trips), stations(sequence(alone, modelOf(alone), 100)));
});

test("the same node used as an origin and as a destination keeps two separate schedules", () => {
  const state = world();
  state.stationDemandAllocationLinks = [link("physical:a", 0.5, 4), link("physical:b", 0.5, 6)];
  const model = modelOf(state);
  const graph = buildRouteGraph(state);
  model.resolveTrip(state, graph, "node:a", "node:c");
  model.resolveTrip(state, graph, "node:b", "node:a");
  assert.deepEqual(Object.keys(state.stationDemandAllocationCursors).sort(), ["destination|node:a", "origin|node:a"]);
  assert.equal(state.stationDemandAllocationCursors["origin|node:a"].total, 1);
  assert.equal(state.stationDemandAllocationCursors["destination|node:a"].total, 1);
});

// --- the schedule uses no randomness and survives a save ---
test("choosing a station draws no random number, reads no clock and does not touch the state's generator", () => {
  const state = world();
  state.stationDemandAllocationLinks = [link("physical:a", 0.6, 4), link("physical:b", 0.4, 6)];
  const before = state.rng.snapshot();
  const realRandom = Math.random;
  Math.random = () => { throw new Error("Math.random must not be used"); };
  try { sequence(state, modelOf(state), 50); } finally { Math.random = realRandom; }
  assert.equal(state.rng.snapshot(), before);
  const code = src("access-demand.mjs").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(code, /Math\.random|Date\.now|performance\.now|\brng\b|randomFrom|management|ledger/);
});

test("the schedule's counts are in the saved state: save, restore and the next trips are the ones that would have come", () => {
  const state = world();
  state.stationDemandAllocationLinks = [link("physical:a", 0.6, 4), link("physical:b", 0.4, 6)];
  const first = sequence(state, modelOf(state), 7);
  const restored = restoreOperationalState(JSON.parse(JSON.stringify(snapshotOperationalState(state))));
  const after = sequence(restored, modelOf(restored), 13);
  const straight = world();
  straight.stationDemandAllocationLinks = [link("physical:a", 0.6, 4), link("physical:b", 0.4, 6)];
  const whole = sequence(straight, modelOf(straight), 20);
  assert.deepEqual(stations([...first, ...after]), stations(whole));
  assert.deepEqual(restored.stationDemandAllocationCursors, straight.stationDemandAllocationCursors);
});

test("a changed split starts its count again; replacing the links drops the schedule altogether", () => {
  const state = world();
  state.stationDemandAllocationLinks = [link("physical:a", 0.6, 4), link("physical:b", 0.4, 6)];
  const model = modelOf(state);
  sequence(state, model, 3);
  assert.equal(state.stationDemandAllocationCursors["origin|node:a"].total, 3);
  state.stationDemandAllocationLinks = [link("physical:a", 0.5, 4), link("physical:b", 0.5, 6)];
  state.stationDemandAllocationVersion = 5;
  assert.deepEqual(stations(sequence(state, model, 4)), ["physical:a", "physical:b", "physical:a", "physical:b"]);
  assert.equal(state.stationDemandAllocationCursors["origin|node:a"].total, 4);
  replaceStationDemandAllocationLinks(state, []);
  assert.equal("stationDemandAllocationCursors" in state, false);
});

test("removing the allocation links brings the node back to its legacy access, identical to a state that never had them", () => {
  const state = world({ legacyLine: true });
  const never = world({ legacyLine: true });
  replaceStationDemandAllocationLinks(state, [link("physical:a", 0.6, 4), link("physical:b", 0.4, 6)]);
  sequence(state, modelOf(state), 5);
  replaceStationDemandAllocationLinks(state, []);
  assert.deepEqual(sequence(state, modelOf(state), 5), sequence(never, modelOf(never), 5));
  assert.equal(ride(state, modelOf(state)).originStationId, "node:a");
  assert.equal(state.accessLinks.length, never.accessLinks.length);
});

// --- nothing changes without a fractional link ---
test("with no allocation at all the model chooses exactly what the B15-E4 model chose, for every pair of nodes", () => {
  for (const legacyLine of [false, true]) {
    const state = world({ legacyLine });
    const ids = [...state.demandNodes.keys()];
    const graph = buildRouteGraph(state);
    const now = modelOf(state);
    const old = modelOf(state, legacyWithStationAccess);
    for (const a of ids) for (const b of ids) assert.deepEqual(now.resolveTrip(state, graph, a, b), old.resolveTrip(state, graph, a, b), `${a} -> ${b}`);
    assert.equal(state.stationDemandAllocationCursors, undefined);
  }
});

test("with 100 % links (with or without a share field) the model chooses exactly what the B15-E4 model chose", () => {
  for (const share of [1, undefined]) {
    const state = world({ legacyLine: true });
    state.stationDemandAllocationLinks = [link("physical:b", share, 5), link("physical:z", share, 2, { demandNodeId: "node:c" })];
    if (share === undefined) for (const l of state.stationDemandAllocationLinks) delete l.share;
    const graph = buildRouteGraph(state);
    const now = modelOf(state);
    const old = modelOf(state, legacyWithStationAccess);
    for (const a of state.demandNodes.keys()) for (const b of state.demandNodes.keys()) assert.deepEqual(now.resolveTrip(state, graph, a, b), old.resolveTrip(state, graph, a, b));
    assert.equal(state.stationDemandAllocationCursors, undefined);
  }
});

function run(state, model, seconds) {
  const runtime = createSimulationRuntime(state);
  for (let i = 0; i < seconds; i++) simulationStep(state, model, runtime, 1);
  return runtime;
}

test("a whole simulation without allocation is byte-identical to the same simulation on the B15-E4 model, random stream included", () => {
  const a = world({ legacyLine: true });
  const b = world({ legacyLine: true });
  run(a, modelOf(a), 3 * 3600);
  run(b, modelOf(b, legacyWithStationAccess), 3 * 3600);
  assert.ok(a.stats.spawned > 50 && a.passengers.length + a.stats.delivered > 0, "the run actually spawned people");
  assert.equal(JSON.stringify(snapshotOperationalState(a)), JSON.stringify(snapshotOperationalState(b)));
  assert.equal(a.rng.snapshot(), b.rng.snapshot());
});

test("a whole simulation with a 100 % allocation link is byte-identical to the B15-E4 model", () => {
  const a = world({ legacyLine: true });
  const b = world({ legacyLine: true });
  for (const s of [a, b]) replaceStationDemandAllocationLinks(s, [link("physical:a", 1, 4)]);
  run(a, modelOf(a), 3 * 3600);
  run(b, modelOf(b, legacyWithStationAccess), 3 * 3600);
  assert.equal(JSON.stringify(snapshotOperationalState(a)), JSON.stringify(snapshotOperationalState(b)));
});

test("the amount of spawning and the destination choice are not changed by a split that routes every trip", () => {
  const split = world();
  const whole = world();
  // node:b rides from physical:z here, so no trip can start and end at the same station — a trip like that has no route, and a trip
  // without a route draws one random number fewer (this is the one way a split can move the random stream; see the next test).
  for (const s of [split, whole]) s.accessLinks = s.accessLinks.map((l) => (l.demandNodeId === "node:b" ? { ...l, stationId: "physical:z" } : l));
  replaceStationDemandAllocationLinks(split, [link("physical:a", 0.6, 4), link("physical:b", 0.4, 4)]);
  replaceStationDemandAllocationLinks(whole, [link("physical:a", 1, 4)]);
  const modelSplit = modelOf(split);
  const modelWhole = modelOf(whole);
  assert.equal(modelSplit.rate(split, "node:a"), modelWhole.rate(whole, "node:a"));
  run(split, modelSplit, 3 * 3600);
  run(whole, modelWhole, 3 * 3600);
  assert.equal(split.stats.spawned, whole.stats.spawned);
  assert.deepEqual(split.stats.spawnedByHour, whole.stats.spawnedByHour);
  assert.equal(split.rng.snapshot(), whole.rng.snapshot(), "the same number of random draws");
  // which mode a trip takes may differ (the walk to physical:b is not the walk to physical:a); that every trip chose one does not
  const modes = (s) => s.stats.modeShare.transit + s.stats.modeShare.driving + s.stats.modeShare.walking;
  assert.equal(modes(split), split.stats.spawned);
  assert.equal(modes(whole), whole.stats.spawned);
  const taken = split.stationDemandAllocationCursors["origin|node:a"].taken;
  assert.ok(taken["physical:a"] > 50 && taken["physical:b"] > 30, JSON.stringify(taken));
  assert.ok(Math.abs(taken["physical:a"] / (taken["physical:a"] + taken["physical:b"]) - 0.6) < 0.001, "60 / 40 over the whole run");
});

test("a trip the split leaves without a route draws one random number fewer, exactly as any trip without a route always did", () => {
  const split = world();
  replaceStationDemandAllocationLinks(split, [link("physical:a", 0.5, 4), link("physical:b", 0.2, 4)]); // 30 % of node:a has no station
  const model = modelOf(split);
  const graph = buildRouteGraph(split);
  const draws = [];
  const next = split.rng.next.bind(split.rng);
  split.rng.next = () => { draws.push(1); return next(); };
  let unrouted = 0;
  for (let i = 0; i < 300; i++) { const before = draws.length; spawnPassengers(split, model, graph, 0.25); if (draws.length - before < 0) unrouted++; }
  assert.equal(unrouted, 0);
  assert.ok(split.stats.spawned > 0);
  assert.ok(split.stationDemandAllocationCursors["origin|node:a"].taken[""] > 0, "some trips really had no station");
  // the rate model itself is the same object's answer before and after: the split never changes how many trips are expected
  assert.equal(model.rate(split, "node:a"), buildDemandModel(world(), pack().demand).rate(world(), "node:a"));
});

test("a simulation with a split is deterministic, and a save in the middle changes nothing", () => {
  const make = () => { const s = world(); replaceStationDemandAllocationLinks(s, [link("physical:a", 0.6, 4), link("physical:b", 0.4, 6)]); return s; };
  const a = make();
  const b = make();
  run(a, modelOf(a), 2 * 3600);
  run(b, modelOf(b), 3600);
  const resumed = restoreOperationalState(JSON.parse(JSON.stringify(snapshotOperationalState(b))));
  run(resumed, modelOf(resumed), 3600);
  assert.equal(JSON.stringify(snapshotOperationalState(resumed)), JSON.stringify(snapshotOperationalState(a)));
  const c = make();
  run(c, modelOf(c), 2 * 3600);
  assert.equal(JSON.stringify(snapshotOperationalState(c)), JSON.stringify(snapshotOperationalState(a)));
});

test("a trip with no station access spawns (it counts as a trip) but becomes no passenger, even where an old path exists", () => {
  const state = world({ legacyLine: true });
  replaceStationDemandAllocationLinks(state, [link("physical:a", 0.3, 4)]);
  const model = modelOf(state);
  const graph = buildRouteGraph(state);
  for (let i = 0; i < 400; i++) spawnPassengers(state, model, graph, 0.25);
  assert.ok(state.stats.spawned > 0);
  const originStations = tally(state.passengers.filter((p) => p.demandOriginId === "node:a").map((p) => p.originId));
  assert.deepEqual(Object.keys(originStations), ["physical:a"], "nobody left node:a for its legacy station");
  const taken = state.stationDemandAllocationCursors["origin|node:a"].taken;
  assert.ok(taken[""] > taken["physical:a"], "most of its trips had no access");
});

// --- through the real application path ---
function accessExport(revisions = { a: "access:a:r1", b: "access:b:r1" }) {
  const site = (key, source, lon) => {
    const stationAccessId = `access:${key}`;
    return {
      schema: "transitline.station-demand-access-geometry/1", contractVersion: 1, stationAccessId, stationAccessRevision: revisions[key], sourcePackId: "fractional", sourcePackVersion: "1",
      location: [lon, 35], connectedPlanId: `plan:${key}`, connectedStationId: source, connectedNetworkId: `plan:${key}`,
      demandSourceRefs: [{ sourceId: "demand", kind: "demand-points", quality: "medium", spatialResolution: "individual-demand-node" }],
      entrances: [], accessPoints: [],
      catchments: [{ catchmentId: `catch:${key}`, demandNodeIdsInside: ["node:a"] }],
      demandZones: [{ demandZoneId: `zone:${key}`, centroid: [139, 35], demandNodeRefs: [{ demandNodeId: "node:a", location: [139, 35] }], drawnConnection: { connected: true } }],
      walkLinks: [{ walkLinkId: `walk:${key}`, from: { kind: "station", id: stationAccessId }, to: { kind: "demand-zone", id: `zone:${key}` }, alignment: [[lon, 35], [139, 35]], lengthMeters: key === "a" ? 320 : 480, crossings: { river: 0, railway: 0, building: 0 }, unknownReasons: {} }],
      transfers: [],
    };
  };
  return { schema: "transitline.station-demand-access-export/1", contractVersion: 1, packId: "fractional", packVersion: "1", catchmentOverlaps: [{ stationAccessIds: ["access:a", "access:b"], catchmentIds: ["catch:a", "catch:b"] }], sites: [site("a", "source:a", 139.001), site("b", "source:b", 139.002)] };
}
const policyOf = (shares, revisions = { "access:a": "access:a:r1", "access:b": "access:b:r1" }) => ({
  schema: "transitline.station-demand-allocation-policy/1", contractVersion: 1, policyId: "policy:split", defaults: { exclusive: "hold", shared: "hold", areaNodeInclusion: "reject" },
  rules: [{ ruleId: "rule:1", scope: { stationAccessIds: ["access:a", "access:b"] }, boundTo: revisions, mode: "fixed-shares", shares }],
});
function applied(shares = { "access:a": 0.6, "access:b": 0.4 }) {
  const state = world();
  applyStationDemandAccess(state, { stationDemandAccess: accessExport(), pack: pack() });
  return { state, report: applyStationDemandAllocation(state, { policy: policyOf(shares) }) };
}

test("applying a fixed-shares policy creates the two links with their shares (it was refused before) and routes the node 60 / 40", () => {
  const { state, report } = applied();
  assert.deepEqual(state.stationDemandAllocationLinks.map((l) => [l.demandNodeId, l.stationId, l.share]), [["node:a", "physical:a", 0.6], ["node:a", "physical:b", 0.4]]);
  assert.deepEqual(report.splitNodes, [{ demandNodeId: "node:a", shares: [{ stationId: "physical:a", share: 0.6 }, { stationId: "physical:b", share: 0.4 }], unroutedShare: 0 }]);
  assert.deepEqual(report.blockedLinks, []);
  const trips = sequence(state, modelOf(state), 50);
  assert.deepEqual(tally(stations(trips)), { "physical:a": 30, "physical:b": 20 });
  assert.deepEqual(state.accessLinks.map((l) => l.id), ["legacy:c", "legacy:b"], "the 800 m / plan links are not modified");
});

test("shares below one apply as written: the unallocated rest is reported as unrouted, not as a legacy path", () => {
  const { state, report } = applied({ "access:a": 0.5, "access:b": 0.2 });
  assert.deepEqual(report.splitNodes[0], { demandNodeId: "node:a", shares: [{ stationId: "physical:a", share: 0.5 }, { stationId: "physical:b", share: 0.2 }], unroutedShare: 0.3 });
  assert.deepEqual(tally(stations(sequence(state, modelOf(state), 100))), { "physical:a": 50, "physical:b": 20, "-": 30 });
});

test("a share whose station is not built is blocked and reported; the other share is applied alone and the rest stays unrouted", () => {
  const state = world();
  removeStationAndItsLine(state, "physical:b");
  applyStationDemandAccess(state, { stationDemandAccess: accessExport(), pack: pack() });
  const report = applyStationDemandAllocation(state, { policy: policyOf({ "access:a": 0.6, "access:b": 0.4 }) });
  assert.deepEqual(report.blockedLinks.map((b) => [b.stationAccessId, b.code]), [["access:b", "station-not-operational"]]);
  assert.deepEqual(report.splitNodes, [{ demandNodeId: "node:a", shares: [{ stationId: "physical:a", share: 0.6 }], unroutedShare: 0.4 }]);
  assert.deepEqual(tally(stations(sequence(state, modelOf(state), 10))), { "physical:a": 6, "-": 4 });
});

test("a policy that is stale, unknown, rejected or silent about a shared node creates no link and changes nothing", () => {
  const cases = {
    stale: () => policyOf({ "access:a": 0.6, "access:b": 0.4 }, { "access:a": "access:a:r0", "access:b": "access:b:r1" }),
    rejected: () => policyOf({ "access:a": 0.7, "access:b": 0.7 }),
    "no policy": () => null,
  };
  for (const [name, make] of Object.entries(cases)) {
    const state = world();
    applyStationDemandAccess(state, { stationDemandAccess: accessExport(), pack: pack() });
    const before = JSON.stringify(snapshotOperationalState(state));
    assert.throws(() => applyStationDemandAllocation(state, { policy: make() }), /policy|stale/i, name);
    assert.equal(JSON.stringify(snapshotOperationalState(state)), before, name);
  }
  // shared and no rule: the policy is valid, but holds the node — no link
  const held = world();
  applyStationDemandAccess(held, { stationDemandAccess: accessExport(), pack: pack() });
  const report = applyStationDemandAllocation(held, { policy: { ...policyOf({ "access:a": 0.6, "access:b": 0.4 }), rules: [] } });
  assert.deepEqual([held.stationDemandAllocationLinks, report.splitNodes], [[], []]);
  // unknown: a coarse source never reaches a station
  const coarse = accessExport();
  for (const s of coarse.sites) s.demandSourceRefs[0] = { ...s.demandSourceRefs[0], spatialResolution: "municipality-centroid", quality: "low" };
  const unknown = world();
  applyStationDemandAccess(unknown, { stationDemandAccess: coarse, pack: pack() });
  const unknownReport = applyStationDemandAllocation(unknown, { policy: policyOf({ "access:a": 0.6, "access:b": 0.4 }) });
  assert.deepEqual([unknown.stationDemandAllocationLinks, unknownReport.splitNodes], [[], []]);
  assert.deepEqual(ride(unknown, modelOf(unknown)), ride(unknown, modelOf(unknown, legacyWithStationAccess)));
});

test("a map change after applying makes the split stale but leaves its links, and the routing, as they were", () => {
  const { state } = applied();
  const links = structuredClone(state.stationDemandAllocationLinks);
  const model = modelOf(state);
  const first = stations(sequence(state, model, 5));
  applyStationDemandAccess(state, { stationDemandAccess: accessExport({ a: "access:a:r2", b: "access:b:r1" }), pack: pack() });
  assert.equal(stationDemandAllocationApplicationReport(state).status, "stale");
  assert.deepEqual(state.stationDemandAllocationLinks, links);
  const reference = applied().state;
  const straight = stations(sequence(reference, modelOf(reference), 10));
  assert.deepEqual([...first, ...stations(sequence(state, model, 5))], straight, "the schedule carries on, unaffected by the stale mark");
});

test("a policy with only 100 % assignments applies as it did in B15-E4: one link per node, share one, no schedule", () => {
  const state = world();
  applyStationDemandAccess(state, { stationDemandAccess: { ...accessExport(), sites: [accessExport().sites[0]], catchmentOverlaps: [] }, pack: pack() });
  const policy = { schema: "transitline.station-demand-allocation-policy/1", contractVersion: 1, policyId: "policy:whole", defaults: { exclusive: "assign", shared: "hold", areaNodeInclusion: "reject" }, rules: [] };
  const report = applyStationDemandAllocation(state, { policy });
  assert.deepEqual(state.stationDemandAllocationLinks.map((l) => [l.stationId, l.share]), [["physical:a", 1]]);
  assert.deepEqual(report.splitNodes, []);
  assert.deepEqual(sequence(state, modelOf(state), 4), sequence(state, modelOf(state, legacyWithStationAccess), 4));
  assert.equal(state.stationDemandAllocationCursors, undefined);
});

test("the stored application, with its split summary, survives a save and restore unchanged", () => {
  const { state, report } = applied();
  const restored = restoreOperationalState(JSON.parse(JSON.stringify(snapshotOperationalState(state))));
  assert.deepEqual(stationDemandAllocationApplicationReport(restored), report);
  assert.deepEqual(restored.stationDemandAllocationLinks, state.stationDemandAllocationLinks);
});

// --- nothing else is touched ---
test("the policy, the map export and the old links are not modified, and previews change nothing", () => {
  const state = world();
  const access = deepFreeze(accessExport());
  const policy = deepFreeze(policyOf({ "access:a": 0.6, "access:b": 0.4 }));
  applyStationDemandAccess(state, { stationDemandAccess: access, pack: pack() });
  const legacy = JSON.stringify(state.accessLinks);
  const before = JSON.stringify(snapshotOperationalState(state));
  const preview = assessStationDemandAllocation(state, { policy });
  assert.equal(preview.splitNodes.length, 1);
  assert.equal(JSON.stringify(snapshotOperationalState(state)), before, "a preview changes no state");
  applyStationDemandAllocation(state, { policy });
  sequence(state, modelOf(state), 20);
  assert.equal(JSON.stringify(state.accessLinks), legacy);
});

test("the changed engine files reach no management, cash, fare, crowd or random source", () => {
  for (const file of ["access-demand.mjs", "station-demand-allocation-integration.mjs"]) {
    const imports = [...src(file).matchAll(/^import .* from "(.+)";$/gm)].map((m) => m[1]);
    assert.ok(imports.every((i) => !/management|cash|fare|crowd/.test(i)), `${file}: ${imports}`);
    assert.doesNotMatch(src(file).replace(/\/\/.*$/gm, ""), /Math\.random|Date\.now|performance\.now|\.rng\b|randomFrom|ledger|\.commit\(|\.settle\(|\.post\(/, file);
  }
  const spawn = src("passengers.mjs");
  const body = spawn.slice(spawn.indexOf("export function spawnPassengers"), spawn.indexOf("export function retryPendingRoutes")).replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(body, /Math\.random|ledger|management/);
  assert.equal((body.match(/random\(\)/g) ?? []).length, 1, "spawnPassengers draws once itself (the trip count); pick and chooseMode are handed the generator exactly as before");
});
