import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appliedAllocationLinksByDemandNode, withStationAccess } from "../src/access-demand.mjs";
import { buildDemandModel } from "../src/demand-engine.mjs";
import { restoreOperationalState, snapshotOperationalState } from "../src/integrated-save.mjs";
import { buildRouteGraph } from "../src/network.mjs";
import { ScenarioRuntime } from "../src/scenario-runtime.mjs";
import { createSimulationRuntime, simulationStep } from "../src/simulation.mjs";
import { applyStationDemandAccess } from "../src/station-demand-access-integration.mjs";
import { applyStationDemandAllocation } from "../src/station-demand-allocation-integration.mjs";
import { STATION_DEMAND_ALLOCATION_DIAGNOSTICS_SCHEMA, allocationLinkIssue, buildStationDemandAllocationDiagnostics } from "../src/station-demand-allocation-diagnostics.mjs";
import { addLine, createState, replaceStationDemandAllocationLinks } from "../src/state.mjs";
import { withStationAccess as e5WithStationAccess } from "./helpers/e5-access-demand.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const diagnostics = (state) => buildStationDemandAllocationDiagnostics(state);

// --- the same small world as the B15-E5 tests: node:a reaches the network through physical:a or physical:b; both lines end at physical:z next to node:c ---
const pack = () => ({ manifest: { id: "fractional", version: "1", data: { license: "CC0-1.0", attribution: [] } }, demand: { model: "gravity", points: [
  { id: "node:a", location: [139, 35], residents: 400000, jobs: 100 },
  { id: "node:b", location: [139.004, 35], residents: 300000, jobs: 200 },
  { id: "node:c", location: [139.05, 35], residents: 20000, jobs: 500000 },
], attractors: [] } });
const lineOptions = { frequency: { high: 30, medium: 30, low: 30, veryLow: 30 } };
function world() {
  const state = createState(pack(), { seed: 7 });
  for (const [id, lon] of [["physical:a", 139.001], ["physical:b", 139.002], ["physical:z", 139.049]]) state.stations.set(id, { id, location: [lon, 35], status: "available", sourceStationId: `source:${id.slice(-1)}` });
  state.accessLinks = [{ id: "legacy:c", demandNodeId: "node:c", stationId: "physical:z", walkMinutes: 3 }, { id: "legacy:b", demandNodeId: "node:b", stationId: "physical:b", walkMinutes: 2 }];
  addLine(state, ["physical:a", "physical:z"], lineOptions);
  addLine(state, ["physical:b", "physical:z"], lineOptions);
  return state;
}
const link = (stationId, share, walkMinutes, extra = {}) => ({ allocationId: "alloc:1", demandNodeId: "node:a", stationId, walkMinutes, share, source: "station-demand-allocation", ...extra });
const modelOf = (state, impl = withStationAccess) => impl(buildDemandModel(state, pack().demand), state);
const sequence = (state, model, n, from = "node:a", to = "node:c") => { const graph = buildRouteGraph(state); return Array.from({ length: n }, () => model.resolveTrip(state, graph, from, to)); };
const deepFreeze = (o) => { if (o && typeof o === "object") { Object.values(o).forEach(deepFreeze); Object.freeze(o); } return o; };
const withSplit = (links, mutate = () => {}) => { const state = world(); mutate(state); replaceStationDemandAllocationLinks(state, links); return state; };
const role = (report, nodeId, which) => report.nodes.find((n) => n.demandNodeId === nodeId).roles[which];
const limitOf = (report, code) => report.limits.find((l) => l.code === code);
// the same state with the B15-E6 counters left out, to compare against a router that has none
const withoutOutcomes = (value) => JSON.stringify(value, (key, v) => (key === "outcomes" ? undefined : v));
function run(state, model, seconds) {
  const runtime = createSimulationRuntime(state);
  for (let i = 0; i < seconds; i++) simulationStep(state, model, runtime, 1);
  return runtime;
}
const SIXTY_FORTY = () => [link("physical:a", 0.6, 4), link("physical:b", 0.4, 6)];

// --- through the real application path (a map export, a policy, applyStationDemandAllocation) ---
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

// --- the counters change nothing about routing ---
test("with the outcome counters the router makes exactly the choices of the frozen B15-E5 router, trip by trip, in every situation", () => {
  const situations = {
    "60 / 40": () => withSplit(SIXTY_FORTY()),
    "an unallocated remainder": () => withSplit([link("physical:a", 0.5, 4), link("physical:b", 0.2, 6)]),
    "a scheduled station without a route": () => withSplit([link("physical:a", 0.5, 4), link("physical:b", 0.5, 6)], (s) => { s.lines = s.lines.filter((l) => l.stationIds[0] !== "physical:b"); s.networkDirty = true; }),
    "the same station at both ends": () => withSplit([link("physical:a", 0.5, 4), link("physical:b", 0.5, 6), link("physical:a", 1, 3, { demandNodeId: "node:c" })], (s) => { s.accessLinks = []; }),
    "a destination with no access": () => withSplit(SIXTY_FORTY(), (s) => { s.accessLinks = []; s.stations.delete("node:c"); }),
    "both ends split with remainders": () => withSplit([link("physical:a", 0.5, 4), link("physical:b", 0.2, 6), link("physical:z", 0.6, 3, { demandNodeId: "node:c" })], (s) => { s.accessLinks = []; }),
  };
  for (const [name, make] of Object.entries(situations)) {
    const now = make();
    const old = make();
    const a = sequence(now, modelOf(now), 60);
    const b = sequence(old, modelOf(old, e5WithStationAccess), 60);
    assert.deepEqual(a, b, name);
    assert.equal(withoutOutcomes(now.stationDemandAllocationCursors), JSON.stringify(old.stationDemandAllocationCursors), `${name}: same counts`);
    assert.equal(now.rng.snapshot(), old.rng.snapshot(), `${name}: same random stream`);
  }
});

test("a whole simulation with a split is identical to the frozen B15-E5 one — state, statistics and random stream — apart from the new counters", () => {
  const make = () => withSplit([link("physical:a", 0.5, 4), link("physical:b", 0.2, 6)]);
  const now = make();
  const old = make();
  run(now, modelOf(now), 3 * 3600);
  run(old, modelOf(old, e5WithStationAccess), 3 * 3600);
  assert.ok(now.stats.spawned > 50 && now.stationDemandAllocationCursors["origin|node:a"].taken[""] > 0, "the run really split and left a remainder");
  assert.equal(withoutOutcomes(snapshotOperationalState(now)), withoutOutcomes(snapshotOperationalState(old)));
  assert.equal(JSON.stringify(old).includes("outcomes"), false);
  assert.equal(now.rng.snapshot(), old.rng.snapshot());
  assert.deepEqual(now.stats, old.stats);
});

test("without a split nothing is counted and the saved bytes are the B15-E5 bytes exactly", () => {
  for (const links of [[], [link("physical:a", 1, 4)]]) {
    const now = world();
    const old = world();
    for (const s of [now, old]) replaceStationDemandAllocationLinks(s, links);
    run(now, modelOf(now), 3600);
    run(old, modelOf(old, e5WithStationAccess), 3600);
    assert.equal(now.stationDemandAllocationCursors, undefined);
    assert.equal(JSON.stringify(snapshotOperationalState(now)), JSON.stringify(snapshotOperationalState(old)));
  }
});

// --- what the counters record ---
test("each pick is followed to its outcome: routed trips are counted under the station that carried them", () => {
  const state = withSplit(SIXTY_FORTY());
  sequence(state, modelOf(state), 10);
  assert.deepEqual(state.stationDemandAllocationCursors["origin|node:a"].outcomes, {
    "physical:a": { routed: 6, partnerNobody: 0, partnerNoAccess: 0, sameStation: 0, noRoute: 0 },
    "physical:b": { routed: 4, partnerNobody: 0, partnerNoAccess: 0, sameStation: 0, noRoute: 0 },
  });
  assert.equal(state.stationDemandAllocationCursors["destination|node:c"], undefined, "a node that is not split keeps no schedule and no counters");
});

test("a trip that picked a station but ended without a route is counted under the reason, one reason each", () => {
  // the scheduled station has no route
  const noRoute = withSplit([link("physical:a", 0.5, 4), link("physical:b", 0.5, 6)], (s) => { s.lines = s.lines.filter((l) => l.stationIds[0] !== "physical:b"); s.networkDirty = true; });
  sequence(noRoute, modelOf(noRoute), 10);
  assert.deepEqual(noRoute.stationDemandAllocationCursors["origin|node:a"].outcomes, {
    "physical:a": { routed: 5, partnerNobody: 0, partnerNoAccess: 0, sameStation: 0, noRoute: 0 },
    "physical:b": { routed: 0, partnerNobody: 0, partnerNoAccess: 0, sameStation: 0, noRoute: 5 },
  });
  // origin and destination are the same station
  const same = withSplit([link("physical:a", 0.5, 4), link("physical:b", 0.5, 6), link("physical:a", 1, 3, { demandNodeId: "node:c" })], (s) => { s.accessLinks = []; });
  sequence(same, modelOf(same), 10);
  assert.deepEqual(same.stationDemandAllocationCursors["origin|node:a"].outcomes, {
    "physical:a": { routed: 0, partnerNobody: 0, partnerNoAccess: 0, sameStation: 5, noRoute: 0 },
    "physical:b": { routed: 5, partnerNobody: 0, partnerNoAccess: 0, sameStation: 0, noRoute: 0 },
  });
  // the other end has no station access at all
  const none = withSplit(SIXTY_FORTY(), (s) => { s.accessLinks = []; s.stations.delete("node:c"); });
  sequence(none, modelOf(none), 10);
  assert.deepEqual(none.stationDemandAllocationCursors["origin|node:a"].outcomes, {
    "physical:a": { routed: 0, partnerNobody: 0, partnerNoAccess: 6, sameStation: 0, noRoute: 0 },
    "physical:b": { routed: 0, partnerNobody: 0, partnerNoAccess: 4, sameStation: 0, noRoute: 0 },
  });
});

test("when the other end drew the no-station share, the trip is counted as such on the side that did pick a station; the nobody pick itself is only taken[\"\"]", () => {
  const state = withSplit([link("physical:a", 0.5, 4), link("physical:b", 0.2, 6), link("physical:z", 0.6, 3, { demandNodeId: "node:c" })], (s) => { s.accessLinks = []; });
  sequence(state, modelOf(state), 100);
  const origin = state.stationDemandAllocationCursors["origin|node:a"];
  const destination = state.stationDemandAllocationCursors["destination|node:c"];
  assert.ok(origin.outcomes["physical:a"].partnerNobody > 0 && destination.outcomes["physical:z"].partnerNobody > 0);
  assert.equal(origin.outcomes[""], undefined, "a nobody pick has no outcome of its own");
  for (const cursor of [origin, destination]) {
    for (const [id, counts] of Object.entries(cursor.outcomes)) assert.equal(Object.values(counts).reduce((s, v) => s + v, 0), cursor.taken[id], `every pick of ${id} has exactly one outcome`);
  }
});

test("a changed split restarts its counters with its count, and replacing the links drops them", () => {
  const state = withSplit(SIXTY_FORTY());
  const model = modelOf(state);
  sequence(state, model, 3);
  assert.ok(state.stationDemandAllocationCursors["origin|node:a"].outcomes);
  state.stationDemandAllocationLinks = [link("physical:a", 0.5, 4), link("physical:b", 0.5, 6)];
  state.stationDemandAllocationVersion = 5;
  sequence(state, model, 2);
  const cursor = state.stationDemandAllocationCursors["origin|node:a"];
  assert.equal(cursor.total, 2);
  assert.equal(Object.values(cursor.outcomes).flatMap((c) => Object.values(c)).reduce((s, v) => s + v, 0), 2, "only the trips since the change");
  replaceStationDemandAllocationLinks(state, []);
  assert.equal("stationDemandAllocationCursors" in state, false);
});

// --- the report ---
test("no allocation: an honest empty report, with every limit named and none claimed", () => {
  for (const state of [world(), null, undefined, {}]) {
    const report = diagnostics(state);
    assert.equal(report.schema, STATION_DEMAND_ALLOCATION_DIAGNOSTICS_SCHEMA);
    assert.equal(report.status, "no-allocation");
    assert.equal(report.application, null);
    assert.deepEqual([report.nodes, report.orphanCursors, report.totals.splitNodes], [[], [], 0]);
    assert.deepEqual(report.limits.map((l) => l.status), [...Array(9).fill("none"), "info"]);
    assert.equal(limitOf(report, "counts-selections-not-demand").status, "info");
  }
});

test("a 60 / 40 split: configured shares, real picks, the expectation and the deviation, per role", () => {
  const state = withSplit(SIXTY_FORTY());
  sequence(state, modelOf(state), 10);
  const report = diagnostics(state);
  const node = report.nodes[0];
  assert.deepEqual([node.demandNodeId, node.routing, node.configured.noStationShare, node.configured.noStationComposition], ["node:a", "split", 0, null]);
  assert.deepEqual(node.configured.stations.map((s) => [s.stationId, s.share, s.micro, s.walkMinutes]), [["physical:a", 0.6, 600000, 4], ["physical:b", 0.4, 400000, 6]]);
  const origin = role(report, "node:a", "origin");
  assert.deepEqual([origin.cursor, origin.total], ["present", 10]);
  assert.deepEqual(origin.slots.map((s) => [s.slotId, s.configuredShare, s.picks, s.expectedPicks, s.deviationPicks, s.withinOnePick]), [["physical:a", 0.6, 6, 6, 0, true], ["physical:b", 0.4, 4, 4, 0, true]]);
  assert.deepEqual(origin.trips, { picks: 10, coverage: "complete", exact: true, routed: 10, unrouted: 0, unroutedByReason: { noStationShare: 0, partnerNobody: 0, partnerNoAccess: 0, sameStation: 0, noRoute: 0 } });
  // the destination role of the same node has not been used: zeros that are facts, not unknowns
  const destination = role(report, "node:a", "destination");
  assert.deepEqual([destination.cursor, destination.total, destination.slots.map((s) => s.picks)], ["absent", 0, [0, 0]]);
  assert.equal(destination.trips.routed, 0);
  // odd lengths: within one pick of the share, as the router guarantees
  sequence(state, modelOf(state), 3);
  assert.ok(role(diagnostics(state), "node:a", "origin").slots.every((s) => s.withinOnePick));
});

test("origin and destination are counted apart and never added to each other", () => {
  const state = withSplit([link("physical:a", 0.6, 4), link("physical:b", 0.4, 6), link("physical:z", 0.25, 3, { demandNodeId: "node:c" }), link("physical:a", 0.75, 5, { demandNodeId: "node:c" })], (s) => { s.accessLinks = []; });
  sequence(state, modelOf(state), 40);
  const report = diagnostics(state);
  assert.deepEqual([role(report, "node:a", "origin").total, role(report, "node:a", "destination").total, role(report, "node:c", "origin").total, role(report, "node:c", "destination").total], [40, 0, 0, 40]);
  assert.equal(report.totals.byRole.origin.picks, 40);
  assert.equal(report.totals.byRole.destination.picks, 40);
  assert.deepEqual(role(report, "node:c", "destination").slots.map((s) => [s.slotId, s.picks]), [["physical:a", 30], ["physical:z", 10]]);
});

test("a count kept for other shares is shown as restarting, with what it was", () => {
  const state = withSplit(SIXTY_FORTY());
  sequence(state, modelOf(state), 5);
  state.stationDemandAllocationLinks = [link("physical:a", 0.5, 4), link("physical:b", 0.5, 6)]; // changed behind the router's back
  const origin = role(diagnostics(state), "node:a", "origin");
  assert.equal(origin.cursor, "restarts-on-next-trip");
  assert.equal(origin.total, 0);
  assert.equal(origin.previous.total, 5);
  assert.deepEqual(origin.slots.map((s) => [s.configuredShare, s.picks]), [[0.5, 0], [0.5, 0]]);
  const orphan = withSplit(SIXTY_FORTY());
  sequence(orphan, modelOf(orphan), 4);
  orphan.stationDemandAllocationLinks = [];
  assert.deepEqual(diagnostics(orphan).orphanCursors, [{ key: "origin|node:a", total: 4 }]);
});

test("a no-station share is told apart by cause: left unallocated by the policy, blocked when applied, or lost since", () => {
  // 1) the policy leaves 30 % unallocated
  let composition = diagnostics(applied({ "access:a": 0.5, "access:b": 0.2 }).state).nodes[0].configured.noStationComposition;
  assert.deepEqual([composition.remainderShare, composition.unallocatedByPolicy, composition.blockedAtApply, composition.droppedSinceApply, composition.unexplainedShare], [0.3, 0.3, [], [], 0]);
  // 2) a share whose station is not built is blocked at apply time
  const blocked = world();
  blocked.stations.delete("physical:b"); blocked.lines = blocked.lines.filter((l) => !l.stationIds.includes("physical:b")); blocked.networkDirty = true;
  applyStationDemandAccess(blocked, { stationDemandAccess: accessExport(), pack: pack() });
  applyStationDemandAllocation(blocked, { policy: policyOf({ "access:a": 0.6, "access:b": 0.4 }) });
  const blockedReport = diagnostics(blocked);
  composition = blockedReport.nodes[0].configured.noStationComposition;
  assert.deepEqual([composition.remainderShare, composition.unallocatedByPolicy, composition.unexplainedShare], [0.4, 0, 0]);
  assert.deepEqual(composition.blockedAtApply, [{ stationAccessId: "access:b", code: "station-not-operational", share: 0.4 }]);
  assert.equal(limitOf(blockedReport, "share-without-station-is-not-routed").status, "active");
  assert.deepEqual(limitOf(blockedReport, "share-without-station-is-not-routed").evidence.demandNodeIds, ["node:a"]);
  // 3) a station disappears after the policy was applied
  const lost = applied();
  lost.state.stations.delete("physical:b");
  const after = diagnostics(lost.state).nodes[0];
  assert.deepEqual(after.droppedLinks, [{ stationId: "physical:b", reason: "station-missing", share: 0.4 }]);
  assert.deepEqual([after.configured.noStationShare, after.configured.noStationComposition.droppedSinceApply, after.configured.noStationComposition.unexplainedShare], [0.4, [{ stationId: "physical:b", reason: "station-missing", share: 0.4 }], 0]);
});

test("a node whose every link is unusable is reported as falling back to its old access, with the reason of each link", () => {
  const state = withSplit([link("missing", 0.6, 4), link("physical:b", 0.4, 0), link("physical:a", 2, 4), link("physical:a", 0.5, 4, { demandNodeId: "node:nope" })]);
  const report = diagnostics(state);
  const node = report.nodes.find((n) => n.demandNodeId === "node:a");
  assert.deepEqual([node.routing, node.configured, node.roles], ["legacy-fallback", null, null]);
  assert.deepEqual(node.droppedLinks.map((l) => [l.stationId, l.reason]), [["missing", "station-missing"], ["physical:a", "share-invalid"], ["physical:b", "walk-minutes-invalid"]]);
  assert.equal(report.nodes.find((n) => n.demandNodeId === "node:nope").droppedLinks[0].reason, "demand-node-missing");
  const limit = limitOf(report, "all-links-unusable-falls-back-to-legacy");
  assert.equal(limit.status, "active");
  assert.deepEqual(limit.evidence.demandNodeIds, ["node:a", "node:nope"]);
  assert.equal(report.totals.splitNodes, 0);
});

test("a node taking one whole station is reported as single-station and is not split", () => {
  const state = withSplit([link("physical:a", 1, 4)]);
  sequence(state, modelOf(state), 5);
  const node = diagnostics(state).nodes[0];
  assert.deepEqual([node.routing, node.roles, node.configured.stations], ["single-station", null, [{ stationId: "physical:a", walkMinutes: 4, share: 1 }]]);
});

test("the report's picture of a link as usable or not is the router's own, for every kind of bad link", () => {
  const variants = [{}, { stationId: "missing" }, { demandNodeId: "node:zzz" }, { walkMinutes: 0 }, { walkMinutes: Number.NaN }, { walkMinutes: -1 }, { walkMinutes: "4" }, { share: 0 }, { share: 1.5 }, { share: Number.NaN }, { share: undefined }, { share: "0.5" }, { share: 0.5 }, { share: 1 }];
  for (const variant of variants) {
    const state = world();
    const l = link("physical:a", 0.6, 4, variant);
    if ("share" in variant && variant.share === undefined) delete l.share;
    state.stationDemandAllocationLinks = [l];
    const routerUsesIt = Boolean(appliedAllocationLinksByDemandNode(state).get(l.demandNodeId)?.length);
    assert.equal(allocationLinkIssue(state, l) === null, routerUsesIt, JSON.stringify(variant));
  }
});

// --- the outcomes, and what the report says about them ---
test("every picked trip is routed or unrouted for exactly one reason, and the totals add up", () => {
  const state = withSplit([link("physical:a", 0.5, 4), link("physical:b", 0.2, 6), link("physical:z", 0.6, 3, { demandNodeId: "node:c" })], (s) => { s.accessLinks = []; });
  sequence(state, modelOf(state), 200);
  const report = diagnostics(state);
  for (const which of ["origin", "destination"]) {
    for (const node of ["node:a", "node:c"]) {
      const r = role(report, node, which);
      if (r.total === 0) continue;
      const t = r.trips;
      assert.equal(t.exact, true);
      assert.equal(t.routed + t.unrouted, r.total, `${which}|${node}`);
      assert.equal(t.unrouted, Object.values(t.unroutedByReason).reduce((s, v) => s + v, 0));
    }
  }
  const origin = report.totals.byRole.origin;
  assert.equal(origin.routed + origin.unrouted, 200);
  assert.ok(origin.unroutedByReason.noStationShare > 0 && origin.unroutedByReason.partnerNobody > 0);
  assert.equal(origin.exact, true);
});

test("a save from before the counters has picks but no outcomes: the figures are given as unobserved, never invented", () => {
  const state = withSplit(SIXTY_FORTY());
  sequence(state, modelOf(state), 10);
  for (const cursor of Object.values(state.stationDemandAllocationCursors)) delete cursor.outcomes;
  const report = diagnostics(state);
  const origin = role(report, "node:a", "origin");
  assert.deepEqual([origin.trips.coverage, origin.trips.exact, origin.trips.routed, origin.trips.unrouted], ["none", false, null, null]);
  assert.deepEqual(origin.trips.unroutedByReason, { noStationShare: 0, partnerNobody: null, partnerNoAccess: null, sameStation: null, noRoute: null });
  assert.deepEqual(origin.slots.map((s) => [s.picks, s.outcomes]), [[6, null], [4, null]], "the picks are real, the outcomes are not known");
  assert.equal(limitOf(report, "outcome-counters-incomplete").status, "active");
  assert.deepEqual(limitOf(report, "outcome-counters-incomplete").evidence.roles, ["origin|node:a"]);
  assert.equal(report.totals.byRole.origin.routed, null);
  // a node with a remainder still knows its no-station picks exactly (they are the taken[""] count)
  const remainder = withSplit([link("physical:a", 0.5, 4)]);
  sequence(remainder, modelOf(remainder), 10);
  delete remainder.stationDemandAllocationCursors["origin|node:a"].outcomes;
  assert.equal(role(diagnostics(remainder), "node:a", "origin").trips.unroutedByReason.noStationShare, 5);
  // only some slots counted: lower bounds, said to be partial
  const partial = withSplit(SIXTY_FORTY());
  sequence(partial, modelOf(partial), 10);
  delete partial.stationDemandAllocationCursors["origin|node:a"].outcomes["physical:b"];
  const trips = role(diagnostics(partial), "node:a", "origin").trips;
  assert.deepEqual([trips.coverage, trips.exact, trips.routed], ["partial", false, 6]);
});

// --- the router's known limits, said about the state ---
test("the random-stream limit: latent while a remainder is configured, observed once trips really went unrouted, none for a clean split", () => {
  const clean = withSplit(SIXTY_FORTY());
  sequence(clean, modelOf(clean), 20);
  assert.equal(limitOf(diagnostics(clean), "unrouted-trips-shift-the-random-stream").status, "none");
  const remainder = withSplit([link("physical:a", 0.5, 4), link("physical:b", 0.2, 6)]);
  assert.equal(limitOf(diagnostics(remainder), "unrouted-trips-shift-the-random-stream").status, "latent");
  assert.deepEqual(limitOf(diagnostics(remainder), "unrouted-trips-shift-the-random-stream").evidence.nodesWithNoStationShare, ["node:a"]);
  sequence(remainder, modelOf(remainder), 100);
  const limit = limitOf(diagnostics(remainder), "unrouted-trips-shift-the-random-stream");
  assert.equal(limit.status, "observed");
  assert.deepEqual(limit.evidence.unroutedPicksSeen, { origin: 30, destination: 0 });
  assert.match(limit.text, /난수/);
  assert.match(limit.text, /기대 발생량/);
});

test("the same-station limit: latent when two nodes use one station, observed when trips ended there, none otherwise", () => {
  const apart = withSplit(SIXTY_FORTY());
  assert.equal(limitOf(diagnostics(apart), "same-station-trips").status, "none");
  const shared = withSplit([link("physical:a", 0.5, 4), link("physical:b", 0.5, 6), link("physical:a", 1, 3, { demandNodeId: "node:c" })], (s) => { s.accessLinks = []; });
  let limit = limitOf(diagnostics(shared), "same-station-trips");
  assert.equal(limit.status, "latent");
  assert.deepEqual(limit.evidence.stationsSharedByNodes, [{ stationId: "physical:a", demandNodeIds: ["node:a", "node:c"] }]);
  sequence(shared, modelOf(shared), 10);
  const report = diagnostics(shared);
  limit = limitOf(report, "same-station-trips");
  assert.deepEqual([limit.status, limit.evidence.observed], ["observed", { origin: 5, destination: 0 }]);
  assert.equal(role(report, "node:a", "origin").trips.unroutedByReason.sameStation, 5);
});

test("a map change after applying shows as stale, and the links and the schedule are exactly as they were", () => {
  const { state } = applied();
  sequence(state, modelOf(state), 5);
  const links = structuredClone(state.stationDemandAllocationLinks);
  const cursors = structuredClone(state.stationDemandAllocationCursors);
  assert.equal(diagnostics(state).status, "current");
  applyStationDemandAccess(state, { stationDemandAccess: accessExport({ a: "access:a:r2", b: "access:b:r1" }), pack: pack() });
  const report = diagnostics(state);
  assert.equal(report.status, "stale");
  assert.equal(report.application.status, "stale");
  assert.deepEqual(report.application.staleReasons, ["station-demand-access-revision-changed"]);
  assert.equal(limitOf(report, "application-is-stale").status, "active");
  assert.deepEqual(state.stationDemandAllocationLinks, links);
  assert.deepEqual(state.stationDemandAllocationCursors, cursors);
  assert.equal(role(report, "node:a", "origin").total, 5, "the schedule goes on counting under the old split");
  assert.equal(report.application.linksMatchApplication, true);
});

// --- read only, no randomness, save and restore ---
test("reading the report writes nothing: not even a counter that does not exist yet, and no random number or clock", () => {
  const state = withSplit(SIXTY_FORTY());
  assert.equal(state.stationDemandAllocationCursors, undefined);
  const before = JSON.stringify(snapshotOperationalState(state));
  const rng = state.rng.snapshot();
  const clock = state.simMinutes;
  Object.freeze(state); // a write to any property of the state would now throw
  deepFreeze(state.stationDemandAllocationLinks);
  const realRandom = Math.random;
  const realNow = Date.now;
  Math.random = () => { throw new Error("Math.random must not be used"); };
  Date.now = () => { throw new Error("Date.now must not be used"); };
  try { diagnostics(state); diagnostics(state); } finally { Math.random = realRandom; Date.now = realNow; }
  assert.equal(state.stationDemandAllocationCursors, undefined, "no counter was created by looking");
  assert.equal(JSON.stringify(snapshotOperationalState(state)), before);
  assert.deepEqual([state.rng.snapshot(), state.simMinutes], [rng, clock]);
  // and with schedules present: the counters are read, never advanced
  const running = withSplit(SIXTY_FORTY());
  sequence(running, modelOf(running), 7);
  deepFreeze(running.stationDemandAllocationCursors);
  const frozen = JSON.stringify(running.stationDemandAllocationCursors);
  diagnostics(running);
  assert.equal(JSON.stringify(running.stationDemandAllocationCursors), frozen);
  // what the report returns is a copy: changing it does not reach the state
  const report = diagnostics(running);
  report.nodes[0].roles.origin.slots[0].picks = 999;
  report.nodes[0].droppedLinks.push("x");
  assert.equal(role(diagnostics(running), "node:a", "origin").slots[0].picks, 4);
});

test("save and restore: the report is the same, the next picks are the ones that would have come, and the report after them is the same too", () => {
  const make = () => withSplit([link("physical:a", 0.5, 4), link("physical:b", 0.2, 6)]);
  const state = make();
  const first = sequence(state, modelOf(state), 7);
  const reportAtSave = diagnostics(state);
  const restored = restoreOperationalState(JSON.parse(JSON.stringify(snapshotOperationalState(state))));
  assert.deepEqual(diagnostics(restored), reportAtSave, "the report survives the round trip");
  const after = sequence(restored, modelOf(restored), 13);
  const straight = make();
  const whole = sequence(straight, modelOf(straight), 20);
  assert.deepEqual([...first, ...after], whole, "the same trips as a run that was never saved");
  assert.deepEqual(diagnostics(restored), diagnostics(straight), "and the same account of them, outcomes included");
  assert.equal(JSON.stringify(restored.stationDemandAllocationCursors), JSON.stringify(straight.stationDemandAllocationCursors));
  // a long run saved half way gives the same final report as a run that was not saved
  const a = make();
  const b = make();
  run(a, modelOf(a), 2 * 3600);
  run(b, modelOf(b), 3600);
  const resumed = restoreOperationalState(JSON.parse(JSON.stringify(snapshotOperationalState(b))));
  run(resumed, modelOf(resumed), 3600);
  assert.deepEqual(diagnostics(resumed), diagnostics(a));
  assert.ok(role(diagnostics(a), "node:a", "origin").trips.unrouted > 0);
});

test("the report is deterministic and does not depend on the order links or counters were stored in", () => {
  const forward = withSplit([link("physical:a", 0.6, 4), link("physical:b", 0.4, 6), link("physical:z", 0.5, 3, { demandNodeId: "node:c" })], (s) => { s.accessLinks = []; });
  sequence(forward, modelOf(forward), 30);
  const backward = restoreOperationalState(JSON.parse(JSON.stringify(snapshotOperationalState(forward))));
  backward.stationDemandAllocationLinks.reverse();
  backward.stationDemandAllocationCursors = Object.fromEntries(Object.entries(backward.stationDemandAllocationCursors).reverse());
  assert.equal(JSON.stringify(diagnostics(backward)), JSON.stringify(diagnostics(forward)));
  assert.equal(JSON.stringify(diagnostics(forward)), JSON.stringify(diagnostics(forward)));
});

test("the report carries no demand, money, crowding or random figure, and the module imports and calls nothing that could", () => {
  const state = withSplit([link("physical:a", 0.5, 4), link("physical:b", 0.2, 6)]);
  sequence(state, modelOf(state), 50);
  const keys = new Set();
  const walk = (value) => { if (Array.isArray(value)) value.forEach(walk); else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) { keys.add(k); walk(v); } };
  walk(diagnostics(state));
  assert.deepEqual([...keys].filter((k) => /(cost|price|fare|money|yen|jpy|budget|revenue|ridership|crowd|congest|score|random|rng|seed|capacity|resident|jobs|passenger)/i.test(k)), []);
  const source = fs.readFileSync(path.join(here, "..", "src", "station-demand-allocation-diagnostics.mjs"), "utf8").replace(/\/\/.*$/gm, "");
  assert.deepEqual([...source.matchAll(/^import .* from "(.+)";$/gm)].map((m) => m[1]), ["./access-demand.mjs"]);
  assert.doesNotMatch(source, /Math\.random|Date\.now|new Date|performance\.now|\brng\b|randomFrom|management|ledger|localStorage/);
  assert.doesNotMatch(source, /\bdelete\b|\bstate\.\w+(\.\w+)*\s*(=|\+=|\+\+)(?!=)|\?\?=|structuredClone/, "it only reads the state");
});

// --- through the real runtime and the real application path ---
test("a policy applied for real: the report shows its application, the configured shares and what the node's trips did", () => {
  const { state } = applied({ "access:a": 0.5, "access:b": 0.2 });
  const before = diagnostics(state);
  assert.equal(before.status, "current");
  assert.deepEqual([before.application.status, before.application.linksMatchApplication], ["current", true]);
  assert.deepEqual([role(before, "node:a", "origin").cursor, role(before, "node:a", "origin").total], ["absent", 0]);
  sequence(state, modelOf(state), 100);
  const origin = role(diagnostics(state), "node:a", "origin");
  assert.deepEqual(origin.slots.map((s) => [s.slotId, s.configuredShare, s.picks, s.deviationPicks]), [["physical:a", 0.5, 50, 0], ["physical:b", 0.2, 20, 0], ["", 0.3, 30, 0]]);
  assert.deepEqual(origin.trips, { picks: 100, coverage: "complete", exact: true, routed: 70, unrouted: 30, unroutedByReason: { noStationShare: 30, partnerNobody: 0, partnerNoAccess: 0, sameStation: 0, noRoute: 0 } });
  assert.equal(origin.slots[2].kind, "no-station-share");
  assert.equal(origin.slots[2].outcomes, null);
});

test("ScenarioRuntime offers the report as a method and inside report(), as the same read-only copy", () => {
  const state = world();
  const runtime = new ScenarioRuntime({ pack: pack(), operationalState: state, networkMode: "scratch", seed: 3 });
  assert.equal(runtime.stationDemandAllocationDiagnostics().status, "no-allocation");
  runtime.applyStationDemandAccess(accessExport());
  runtime.applyStationDemandAllocation({ policy: policyOf({ "access:a": 0.6, "access:b": 0.4 }) });
  sequence(runtime.operationalState, modelOf(runtime.operationalState), 10);
  const before = JSON.stringify(snapshotOperationalState(runtime.operationalState));
  const direct = runtime.stationDemandAllocationDiagnostics();
  assert.deepEqual(runtime.report().stationDemandAllocationDiagnostics, direct);
  assert.deepEqual(direct, diagnostics(runtime.operationalState));
  assert.deepEqual(role(direct, "node:a", "origin").slots.map((s) => s.picks), [6, 4]);
  direct.nodes.length = 0;
  runtime.report().stationDemandAllocationDiagnostics.totals.splitNodes = 99;
  assert.equal(runtime.stationDemandAllocationDiagnostics().totals.splitNodes, 1);
  assert.equal(JSON.stringify(snapshotOperationalState(runtime.operationalState)), before, "asking changed nothing in the saved state");
  // the real runtime's own save and load carry the account across
  const other = new ScenarioRuntime({ pack: pack(), operationalState: world(), networkMode: "scratch", seed: 3 });
  other.load(runtime.save());
  assert.deepEqual(other.stationDemandAllocationDiagnostics(), runtime.stationDemandAllocationDiagnostics());
});

test("a long run with an unallocated remainder: the limit about the random stream is observed and its numbers are the real unrouted picks", () => {
  const { state } = applied({ "access:a": 0.5, "access:b": 0.2 });
  run(state, modelOf(state), 3 * 3600);
  const report = diagnostics(state);
  const origin = role(report, "node:a", "origin");
  assert.ok(origin.total > 20, "the simulation really chose stations for this node");
  assert.equal(origin.trips.unroutedByReason.noStationShare, origin.slots[2].picks);
  assert.ok(origin.trips.unrouted > 0);
  const limit = limitOf(report, "unrouted-trips-shift-the-random-stream");
  assert.equal(limit.status, "observed");
  assert.equal(limit.evidence.unroutedPicksSeen.origin, report.totals.byRole.origin.unrouted);
  assert.ok(origin.slots.every((s) => s.withinOnePick));
  assert.equal(report.application.status, "current");
});
