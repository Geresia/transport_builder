import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assessStationDemandAccess } from "../src/station-demand-access-assessment.mjs";
import {
  STATION_DEMAND_ALLOCATION_POLICY_SCHEMA, STATION_DEMAND_ALLOCATION_SCHEMA, allocateStationDemand, bindStationDemandAllocationRule, newStationDemandAllocationPolicy,
  normalizeStationDemandAllocationPolicy, restoreStationDemandAllocationPolicy, serializeStationDemandAllocationPolicy, stationDemandAllocationPolicyRevision,
} from "../src/station-demand-allocation-policy.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");

// --- fixtures ---
const pack = Object.freeze({ manifest: { id: "pack-a", version: "1" }, demand: { model: "gravity", points: [
  { id: "n1", residents: 100, jobs: 40 }, { id: "n2", residents: 50, jobs: 80 }, { id: "n3", residents: 10, jobs: 0 }, { id: "zero", residents: 0, jobs: 0 }, { id: "partial", residents: 10 }, { id: "n4", residents: 200, jobs: 20 },
] } });
const local = Object.freeze({ sourceId: "source:demand", kind: "demand-points", quality: "medium", spatialResolution: "individual-demand-node" });
const coarse = Object.freeze({ ...local, spatialResolution: "municipality-centroid", quality: "low" });
const site = (id, nodes = ["n1"], source = local, { catchments = true, revision = `${id}:r1`, extraCatchments = [] } = {}) => ({
  stationAccessId: id, stationAccessRevision: revision, connectedPlanId: "plan:1", connectedStationId: `station:${id}`,
  demandSourceRefs: source === null ? null : [source], catchments: catchments ? [{ catchmentId: `catch:${id}`, demandNodeIdsInside: nodes }, ...extraCatchments] : [],
});
const accessOf = (sites, catchmentOverlaps = []) => ({ schema: "transitline.station-demand-access-export/1", contractVersion: 1, packId: "pack-a", packVersion: "1", sites, catchmentOverlaps });
const POLICY = (rules = [], defaults = {}, policyId = "policy:1") => ({ schema: STATION_DEMAND_ALLOCATION_POLICY_SCHEMA, contractVersion: 1, policyId, defaults, rules });
const bound = (...ids) => Object.fromEntries(ids.map((id) => [id, `${id}:r1`]));
const setRule = (ruleId, ids, extra) => ({ ruleId, scope: { stationAccessIds: ids }, boundTo: bound(...ids), ...extra });
const nodeRule = (ruleId, nodeIds, boundIds, extra) => ({ ruleId, scope: { demandNodeIds: nodeIds }, boundTo: bound(...boundIds), ...extra });
const shares = (s) => ({ mode: "fixed-shares", shares: s });
const run = (sites, policy = null, extra = {}) => {
  const access = accessOf(sites, extra.overlaps ?? []);
  const assessment = assessStationDemandAccess({ stationDemandAccess: access, pack });
  return { access, assessment, out: allocateStationDemand({ access, assessment, policy, legacyAccessLinks: extra.legacy ?? null }) };
};
const node = (out, id) => out.nodes.find((n) => n.demandNodeId === id);
const station = (out, id) => out.stations.find((s) => s.stationAccessId === id);
const deepFreeze = (o) => { if (o && typeof o === "object") { Object.values(o).forEach(deepFreeze); Object.freeze(o); } return o; };

// --- A. nothing is assigned without a policy ---
test("with no policy an exclusive node is held, not assigned; its values are still reported as facts", () => {
  const { out } = run([site("A", ["n1"])]);
  const n = node(out, "n1");
  assert.equal(out.schema, STATION_DEMAND_ALLOCATION_SCHEMA);
  assert.equal(out.policyStatus, "none");
  assert.equal(out.status, "current");
  assert.deepEqual([n.state, n.decision, n.reasons, n.assignments, n.unallocatedShare], ["exclusive", "held", ["exclusive-needs-policy"], [], 1]);
  assert.deepEqual([n.residents, n.jobs], [100, 40]);
  assert.deepEqual(station(out, "A").allocated, { residents: 0, jobs: 0 }, "nothing was allocated: an exact zero about allocation");
  assert.deepEqual(station(out, "A").heldExclusive, { residents: 100, jobs: 40 });
});

test("an explicit exclusive: assign default gives a sole-access node entirely to its station", () => {
  const { out } = run([site("A", ["n1"])], POLICY([], { exclusive: "assign" }));
  const n = node(out, "n1");
  assert.deepEqual([n.decision, n.ruleBasis, n.unallocatedShare], ["assigned", "default", 0]);
  assert.deepEqual(n.assignments, [{ stationAccessId: "A", share: 1, residents: 100, jobs: 40, connectedPlanId: "plan:1", connectedStationId: "station:A" }]);
  assert.deepEqual(station(out, "A").allocated, { residents: 100, jobs: 40 });
  assert.deepEqual(station(out, "A").heldExclusive, { residents: 0, jobs: 0 });
});

test("a shared node with no policy is unallocated: no equal split, no nearest, no assignment to either station", () => {
  const { out } = run([site("A"), site("B")], POLICY([], { exclusive: "assign" })); // even the permissive exclusive default does not touch a shared node
  const n = node(out, "n1");
  assert.deepEqual([n.state, n.decision, n.reasons, n.assignments, n.unallocatedShare], ["shared", "held", ["shared-needs-policy"], [], 1]);
  for (const id of ["A", "B"]) {
    assert.deepEqual(station(out, id).allocated, { residents: 0, jobs: 0 });
    assert.deepEqual(station(out, id).sharedUnallocated, { residents: 100, jobs: 40 }, "a candidate pool, not an allocation");
  }
  assert.equal(out.totals.assigned + out.totals.partlyAssigned, 0);
});

test("a shared node needs a rule that states the ratios; fixed shares split it exactly as written", () => {
  const rule = setRule("r1", ["A", "B"], shares({ A: 0.6, B: 0.4 }));
  const { out } = run([site("A"), site("B")], POLICY([rule]));
  const n = node(out, "n1");
  assert.deepEqual([n.decision, n.ruleBasis, n.unallocatedShare], ["assigned", "set-rule", 0]);
  assert.deepEqual(n.assignments.map((a) => [a.stationAccessId, a.share, a.residents, a.jobs]), [["A", 0.6, 60, 24], ["B", 0.4, 40, 16]]);
  assert.deepEqual(station(out, "A").allocated, { residents: 60, jobs: 24 });
  assert.deepEqual(station(out, "B").allocated, { residents: 40, jobs: 16 });
  assert.deepEqual(out.rules[0].appliedNodeIds, ["n1"]);
});

test("shares that total less than one leave the rest unallocated", () => {
  const { out } = run([site("A"), site("B")], POLICY([setRule("r1", ["A", "B"], shares({ A: 0.5, B: 0.2 }))]));
  const n = node(out, "n1");
  assert.deepEqual([n.decision, n.unallocatedShare, n.unallocated], ["shares", 0.3, { residents: 30, jobs: 12 }]);
  assert.deepEqual(station(out, "A").sharedUnallocated, { residents: 30, jobs: 12 });
});

test("a total above one is refused and the whole policy applies to nothing", () => {
  const good = setRule("r-good", ["A", "B"], shares({ A: 0.5, B: 0.5 }));
  const bad = nodeRule("r-bad", ["n2"], ["A", "B"], shares({ A: 0.7, B: 0.4 }));
  const { out } = run([site("A", ["n1", "n2"]), site("B", ["n1", "n2"])], POLICY([good, bad], { exclusive: "assign" }));
  assert.deepEqual([out.policyStatus, out.status], ["rejected", "policy-rejected"]);
  assert.deepEqual(out.policyIssues.map((i) => i.code), ["policy-shares-exceed-one"]);
  assert.ok(out.nodes.every((n) => n.assignments.length === 0 && n.decision === "held" && n.reasons.includes("policy-rejected")), "the valid rule is not applied either");
  assert.equal(out.policyRevision, null);
});

test("floating point sums such as 0.1 + 0.2 + 0.7 are accepted as one", () => {
  const { out } = run([site("A"), site("B"), site("C")], POLICY([setRule("r1", ["A", "B", "C"], shares({ A: 0.1, B: 0.2, C: 0.7 }))]));
  const n = node(out, "n1");
  assert.deepEqual([n.decision, n.unallocatedShare], ["assigned", 0]);
  assert.deepEqual(n.assignments.map((a) => a.residents), [10, 20, 70]);
});

test("zero, negative, non-finite, non-numeric, oversize and empty shares are all refused", () => {
  for (const bad of [{ A: 0 }, { A: -0.1 }, { A: Number.NaN }, { A: Infinity }, { A: "0.5" }, { A: 1.5 }, {}, { A: 0.5, B: null }, { Z: 0.5 }]) {
    const issues = normalizeStationDemandAllocationPolicy(POLICY([setRule("r1", ["A", "B"], shares(bad))])).issues;
    assert.equal(issues.length, 1, JSON.stringify(bad));
    assert.match(issues[0].code, /policy-rule-shares-invalid|policy-shares-exceed-one/);
  }
});

test("a rule that names a station which does not claim the node refuses the whole policy", () => {
  const { out } = run([site("A"), site("B"), site("C", ["n2"])], POLICY([nodeRule("r1", ["n1"], ["A", "B", "C"], { mode: "assign-all", stationAccessId: "C" })], { exclusive: "assign" }));
  assert.equal(out.policyStatus, "rejected");
  assert.deepEqual(out.policyIssues.map((i) => [i.code, i.stationAccessId]), [["rule-station-not-claimant", "C"]]);
  assert.ok(out.nodes.every((n) => n.assignments.length === 0), "n2 is exclusive to C and the default says assign — but a refused policy assigns nothing");
});

test("two rules that could decide the same node, the same station set twice or a repeated rule id are refused", () => {
  const a = nodeRule("r1", ["n1"], ["A", "B"], { mode: "assign-all", stationAccessId: "A" });
  const b = nodeRule("r2", ["n1", "n2"], ["A", "B"], { mode: "assign-all", stationAccessId: "B" });
  assert.deepEqual(normalizeStationDemandAllocationPolicy(POLICY([a, b])).issues.map((i) => [i.code, i.demandNodeId]), [["policy-rule-conflict", "n1"]]);
  const s1 = setRule("s1", ["A", "B"], { mode: "assign-all", stationAccessId: "A" });
  const s2 = setRule("s2", ["B", "A"], shares({ A: 0.5, B: 0.5 }));
  assert.equal(normalizeStationDemandAllocationPolicy(POLICY([s1, s2])).issues[0].code, "policy-rule-conflict");
  assert.equal(normalizeStationDemandAllocationPolicy(POLICY([a, { ...a }])).issues.some((i) => i.code === "policy-rule-id-duplicate"), true);
});

test("a node rule outranks a station-set rule, which outranks the defaults", () => {
  const set = setRule("set", ["A", "B"], { mode: "assign-all", stationAccessId: "A" });
  const one = nodeRule("one", ["n2"], ["A", "B"], { mode: "assign-all", stationAccessId: "B" });
  const { out } = run([site("A", ["n1", "n2", "n3"]), site("B", ["n1", "n2"])], POLICY([set, one], { exclusive: "assign" }));
  assert.deepEqual([node(out, "n1").ruleBasis, node(out, "n1").assignments[0].stationAccessId], ["set-rule", "A"]);
  assert.deepEqual([node(out, "n2").ruleBasis, node(out, "n2").assignments[0].stationAccessId], ["node-rule", "B"]);
  assert.deepEqual([node(out, "n3").ruleBasis, node(out, "n3").assignments[0].stationAccessId], ["default", "A"]);
});

test("a rule for a pair does not decide a node that three stations claim; the exact set does", () => {
  const pair = setRule("pair", ["A", "B"], { mode: "assign-all", stationAccessId: "A" });
  const sites = [site("A"), site("B"), site("C")];
  const withPair = run(sites, POLICY([pair])).out;
  assert.deepEqual([node(withPair, "n1").decision, node(withPair, "n1").assignments], ["held", []]);
  assert.equal(withPair.rules[0].status, "unmatched");
  const triple = setRule("triple", ["A", "B", "C"], shares({ A: 0.5, B: 0.25, C: 0.25 }));
  assert.deepEqual(node(run(sites, POLICY([pair, triple])).out, "n1").assignments.map((a) => a.share), [0.5, 0.25, 0.25]);
});

test("one station with two catchments over a node is not a shared claim", () => {
  const { out } = run([site("A", ["n1"], local, { extraCatchments: [{ catchmentId: "catch:A2", demandNodeIdsInside: ["n1"] }] })], POLICY([], { exclusive: "assign" }));
  assert.deepEqual([node(out, "n1").state, node(out, "n1").assignments.length], ["exclusive", 1]);
});

test("a node claimed by two stations is shared even when the map recorded no overlap", () => {
  const { out } = run([site("A"), site("B")], null, { overlaps: [] });
  assert.deepEqual([node(out, "n1").state, node(out, "n1").claimants], ["shared", ["A", "B"]]);
});

test("an exclusive node can also be given a partial share by an explicit rule", () => {
  const { out } = run([site("A", ["n1"])], POLICY([nodeRule("half", ["n1"], ["A"], shares({ A: 0.5 }))]));
  assert.deepEqual([node(out, "n1").decision, node(out, "n1").unallocatedShare], ["shares", 0.5]);
  assert.deepEqual(station(out, "A").allocated, { residents: 50, jobs: 20 });
  assert.deepEqual(station(out, "A").heldExclusive, { residents: 50, jobs: 20 });
});

// --- B. stale rules ---
test("a rule written for an older revision is stale: the node is unallocated and nothing is re-bound silently", () => {
  const rule = setRule("r1", ["A", "B"], { mode: "assign-all", stationAccessId: "A" });
  const { out, assessment } = run([site("A", ["n1"], local, { revision: "A:r2" }), site("B")], POLICY([rule], { exclusive: "assign" }));
  const n = node(out, "n1");
  assert.deepEqual([out.status, n.decision, n.reasons, n.assignments], ["stale", "held", ["rule-stale"], []]);
  assert.deepEqual([out.rules[0].status, out.rules[0].staleStationAccessIds], ["stale", ["A"]]);
  // only an explicit re-bind by the player makes it current again
  const rebound = bindStationDemandAllocationRule(rule, { assessment });
  assert.deepEqual(rebound.boundTo, { A: "A:r2", B: "B:r1" });
  const again = run([site("A", ["n1"], local, { revision: "A:r2" }), site("B")], POLICY([rebound])).out;
  assert.deepEqual([again.status, node(again, "n1").decision], ["current", "assigned"]);
});

test("a node rule goes stale when another station starts claiming the node", () => {
  const rule = nodeRule("r1", ["n1"], ["A", "B"], { mode: "assign-all", stationAccessId: "A" });
  assert.equal(node(run([site("A"), site("B")], POLICY([rule])).out, "n1").decision, "assigned");
  const { out } = run([site("A"), site("B"), site("C")], POLICY([rule]));
  assert.deepEqual([node(out, "n1").decision, node(out, "n1").reasons, out.status], ["held", ["rule-claimants-changed"], "stale"]);
});

test("a stale rule holds its node even when the exclusive default says assign", () => {
  const rule = nodeRule("r1", ["n1"], ["A"], { mode: "assign-all", stationAccessId: "A" });
  const { out } = run([site("A", ["n1"], local, { revision: "A:r9" })], POLICY([rule], { exclusive: "assign" }));
  assert.deepEqual([node(out, "n1").decision, node(out, "n1").reasons], ["held", ["rule-stale"]]);
});

// --- C. low-quality and coarse data ---
test("a municipality-centroid, low-quality or missing source is never given to a station, whatever the policy says", () => {
  const sources = [coarse, { ...local, spatialResolution: "municipality-centroid" }, { ...local, spatialResolution: "Ward" }, { ...local, spatialResolution: "city" }, { ...local, quality: "low" }, { ...local, quality: null }, { ...local, spatialResolution: "unknown-grid" }, { ...local, spatialResolution: undefined }, null];
  const loud = POLICY([nodeRule("r1", ["n1"], ["A"], { mode: "assign-all", stationAccessId: "A" })], { exclusive: "assign" });
  for (const source of sources) {
    const { out } = run([site("A", ["n1"], source)], loud);
    const n = node(out, "n1");
    assert.deepEqual([n.state, n.decision, n.residents, n.jobs, n.assignments, n.unallocatedShare, n.unallocated], ["unknown", "unknown", null, null, [], null, null], JSON.stringify(source));
    assert.ok(n.reasons.length > 0);
    assert.equal(station(out, "A").allocated, null, "no known node: the total is unknown, not zero");
    assert.ok(out.warnings.some((w) => w.code === "policy-cannot-unlock-unknown"));
  }
});

test("an assessment that was altered to say 'available' cannot let a coarse source through", () => {
  const access = accessOf([site("A", ["n1"], { ...local, spatialResolution: "municipality-centroid" })]);
  const assessment = assessStationDemandAccess({ stationDemandAccess: access, pack });
  const forged = structuredClone(assessment);
  Object.assign(forged.sites[0].demandNodeInputs[0], { status: "available", reason: null, residents: 100, jobs: 40 });
  const out = allocateStationDemand({ access, assessment: forged, policy: POLICY([], { exclusive: "assign" }) });
  assert.deepEqual([node(out, "n1").state, node(out, "n1").reasons, node(out, "n1").residents], ["unknown", ["demand-source-coarse"], null]);
});

test("an assessment made for another revision of the access site is unknown, never matched by id alone", () => {
  const access = accessOf([site("A")]);
  const assessment = assessStationDemandAccess({ stationDemandAccess: access, pack });
  const newer = accessOf([site("A", ["n1"], local, { revision: "A:r2" })]);
  const out = allocateStationDemand({ access: newer, assessment, policy: POLICY([], { exclusive: "assign" }) });
  assert.deepEqual([node(out, "n1").state, node(out, "n1").reasons], ["unknown", ["assessment-revision-mismatch"]]);
  const missing = allocateStationDemand({ access: accessOf([]), assessment, policy: POLICY([], { exclusive: "assign" }) });
  assert.deepEqual(node(missing, "n1").reasons, ["access-site-missing"]);
});

test("area resolutions are refused unless the policy says nodes stand for their centroid, and the assumption is recorded", () => {
  const parcel = { ...local, spatialResolution: "parcel", quality: "high" };
  const refused = run([site("A", ["n1"], parcel)], POLICY([], { exclusive: "assign" })).out;
  assert.deepEqual([node(refused, "n1").state, node(refused, "n1").reasons, refused.assumptions], ["unknown", ["area-footprint-unavailable"], []]);
  const allowed = run([site("A", ["n1"], parcel)], POLICY([], { exclusive: "assign", areaNodeInclusion: "centroid" })).out;
  assert.deepEqual([node(allowed, "n1").decision, allowed.assumptions], ["assigned", [{ code: "area-node-centroid-inclusion", stationAccessId: "A" }]]);
});

test("a rule aimed at an unknown node is ignored with a warning; it never unlocks the node", () => {
  const rule = nodeRule("r1", ["partial"], ["A"], { mode: "assign-all", stationAccessId: "A" });
  const { out } = run([site("A", ["partial", "n1"])], POLICY([rule], { exclusive: "assign" }));
  assert.deepEqual([node(out, "partial").decision, node(out, "partial").residents, node(out, "partial").reasons], ["unknown", null, ["demand-node-values-missing"]]);
  assert.deepEqual(out.warnings, [{ code: "policy-cannot-unlock-unknown", ruleId: "r1", demandNodeId: "partial" }]);
  assert.equal(node(out, "n1").decision, "assigned", "the known node beside it is unaffected");
  assert.equal(station(out, "A").complete, false);
  assert.deepEqual(station(out, "A").allocated, { residents: 100, jobs: 40 }, "the known part, flagged incomplete");
});

test("two stations disagreeing about a node's values leave the node unknown", () => {
  const access = accessOf([site("A"), site("B")]);
  const assessment = structuredClone(assessStationDemandAccess({ stationDemandAccess: access, pack }));
  assessment.sites[1].demandNodeInputs[0].residents = 99;
  const out = allocateStationDemand({ access, assessment, policy: null });
  assert.deepEqual([node(out, "n1").state, node(out, "n1").reasons], ["unknown", ["demand-node-values-conflict"]]);
});

// --- D. null versus zero ---
test("null stays null and zero stays zero: a real 0/0 node, a confirmed-empty catchment, an unseen one and an undrawn one", () => {
  const empty = site("E", []);
  const unseen = site("U", [], coarse);
  const undrawn = site("N", [], local, { catchments: false });
  const { out } = run([site("Z", ["zero", "partial"]), empty, unseen, undrawn], POLICY([], { exclusive: "assign" }));
  assert.deepEqual([node(out, "zero").residents, node(out, "zero").jobs, node(out, "zero").decision], [0, 0, "assigned"]);
  assert.deepEqual([node(out, "partial").residents, node(out, "partial").jobs], [null, null]);
  assert.deepEqual(station(out, "Z").allocated, { residents: 0, jobs: 0 }, "a real zero from a known 0/0 node");
  assert.equal(station(out, "Z").complete, false);
  assert.deepEqual([station(out, "E").coverage, station(out, "E").allocated, station(out, "E").heldExclusive, station(out, "E").sharedUnallocated, station(out, "E").complete], ["empty-confirmed", { residents: 0, jobs: 0 }, { residents: 0, jobs: 0 }, { residents: 0, jobs: 0 }, true]);
  for (const id of ["U", "N"]) assert.deepEqual([station(out, id).allocated, station(out, id).heldExclusive, station(out, id).sharedUnallocated, station(out, id).complete], [null, null, null, false], id);
  assert.deepEqual([station(out, "U").coverage, station(out, "N").coverage], ["empty-unseen", "not-drawn"]);
});

test("a class with no known member stays null while a node of the station is unknown", () => {
  const { out } = run([site("A", ["partial"])]);
  assert.deepEqual([station(out, "A").allocated, station(out, "A").heldExclusive, station(out, "A").sharedUnallocated, station(out, "A").unknownNodeCount], [null, null, null, 1]);
});

// --- E. legacy links, reported and never changed ---
test("legacy access links are only reported on: whether the new allocation collides with them", () => {
  const legacy = deepFreeze([{ demandNodeId: "n1", stationId: "station:B", walkMinutes: 5 }, { demandNodeId: "n2", stationId: "station:A", walkMinutes: 3 }]);
  const policy = POLICY([nodeRule("r1", ["n1"], ["A"], { mode: "assign-all", stationAccessId: "A" })]);
  const before = JSON.stringify(legacy);
  const { out } = run([site("A", ["n1", "n2", "n3"])], policy, { legacy });
  assert.equal(JSON.stringify(legacy), before);
  assert.deepEqual(node(out, "n1").legacy, { supplied: true, linkCount: 1, stationIds: ["station:B"], conflictsWithAllocation: true, overrideRequired: true, activeWhileUnallocated: false });
  assert.deepEqual([node(out, "n2").decision, node(out, "n2").legacy.activeWhileUnallocated, node(out, "n2").legacy.overrideRequired], ["held", true, false], "a legacy link still reaches a node the policy holds");
  assert.deepEqual([node(out, "n3").legacy.linkCount, node(out, "n3").legacy.activeWhileUnallocated], [0, false]);
  assert.deepEqual([out.legacy.supplied, out.legacy.nodesWithLegacyLinks, out.legacy.overrideRequiredNodeIds, out.legacy.conflictNodeIds], [true, ["n1", "n2"], ["n1"], ["n1"]]);
});

test("without legacy links supplied the legacy facts are unknown, not 'no conflict'", () => {
  const { out } = run([site("A")], POLICY([], { exclusive: "assign" }));
  assert.deepEqual(node(out, "n1").legacy, { supplied: false, linkCount: null, stationIds: null, conflictsWithAllocation: null, overrideRequired: null, activeWhileUnallocated: null });
  assert.deepEqual(out.legacy, { supplied: false, nodesWithLegacyLinks: null, overrideRequiredNodeIds: null, conflictNodeIds: null });
  const none = run([site("A")], POLICY([], { exclusive: "assign" }), { legacy: [] }).out;
  assert.deepEqual([node(none, "n1").legacy.linkCount, node(none, "n1").legacy.conflictsWithAllocation, none.legacy.nodesWithLegacyLinks], [0, false, []], "an empty list is a fact");
});

// --- F. invariants over many random cases ---
function lcg(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; }; }

test("property: shares never exceed one, a node is never given twice, unknown nodes get nothing, and only explicit policy assigns", () => {
  const rnd = lcg(20261007);
  const pick = (list) => list[Math.floor(rnd() * list.length)];
  const ids = ["A", "B", "C", "D"];
  const nodeIds = ["n1", "n2", "n3", "n4", "zero", "partial"];
  const sources = [local, local, local, coarse, { ...local, quality: "low" }, { ...local, spatialResolution: "parcel", quality: "high" }];
  let assignedCases = 0;
  for (let i = 0; i < 400; i++) {
    const sites = ids.filter(() => rnd() < 0.7).map((id) => site(id, nodeIds.filter(() => rnd() < 0.5), pick(sources), { revision: rnd() < 0.1 ? `${id}:r2` : `${id}:r1` }));
    const rules = [];
    for (let r = 0; r < Math.floor(rnd() * 4); r++) {
      const stations = ids.filter(() => rnd() < 0.6);
      if (!stations.length) continue;
      const mode = rnd() < 0.5 ? { mode: "assign-all", stationAccessId: pick(stations) } : shares(Object.fromEntries(stations.map((s) => [s, Math.round((rnd() * 0.5 + 0.05) * 100) / 100])));
      rules.push(rnd() < 0.5 ? setRule(`r${r}`, stations, mode) : nodeRule(`r${r}`, [pick(nodeIds), pick(nodeIds)], ids, mode));
    }
    const policy = rnd() < 0.15 ? null : POLICY(rules, { exclusive: pick(["hold", "assign"]), areaNodeInclusion: pick(["reject", "centroid"]) });
    const { out } = run(sites, policy);
    const again = run(sites, policy).out;
    assert.equal(JSON.stringify(out), JSON.stringify(again), "deterministic");
    for (const n of out.nodes) {
      const sum = n.assignments.reduce((s, a) => s + a.share, 0);
      assert.ok(sum <= 1 + 1e-9, `node ${n.demandNodeId}: shares ${sum}`);
      assert.equal(new Set(n.assignments.map((a) => a.stationAccessId)).size, n.assignments.length, "no station twice for one node");
      assert.ok(n.assignments.every((a) => n.claimants.includes(a.stationAccessId)), "only a claiming station");
      if (n.state === "unknown") assert.deepEqual([n.assignments, n.residents, n.jobs, n.unallocatedShare], [[], null, null, null]);
      if (n.assignments.length) {
        assignedCases += 1;
        assert.ok(out.policyStatus === "valid", "no policy, no assignment");
        assert.ok(["node-rule", "set-rule", "default"].includes(n.ruleBasis));
        if (n.ruleBasis === "default") assert.deepEqual([n.state, n.assignments.length, n.assignments[0].share, policy.defaults.exclusive], ["exclusive", 1, 1, "assign"]);
        if (n.state === "shared") assert.ok(n.ruleId !== null, "a shared node is only ever assigned by a rule");
        assert.ok(n.assignments.every((a) => a.residents <= n.residents + 1e-6 && a.jobs <= n.jobs + 1e-6));
      }
    }
    if (policy === null) assert.ok(out.nodes.every((n) => n.assignments.length === 0));
    assert.ok(out.stations.every((s) => s.allocated === null || (s.allocated.residents >= 0 && s.allocated.jobs >= 0)));
  }
  assert.ok(assignedCases > 100, "the property run really exercised assignments");
});

// --- G. determinism and untouched inputs ---
test("shuffling sites, catchment nodes, rules and key order gives byte-identical output and the same allocation id", () => {
  const rules = [setRule("b", ["A", "B"], shares({ A: 0.3, B: 0.3 })), nodeRule("a", ["n2"], ["A", "B"], { mode: "assign-all", stationAccessId: "B" })];
  const first = run([site("A", ["n1", "n2", "n3"]), site("B", ["n2", "n1"])], POLICY(rules, { exclusive: "assign" })).out;
  const shuffledRules = [{ ...rules[1], boundTo: Object.fromEntries(Object.entries(rules[1].boundTo).reverse()) }, { ...rules[0], shares: { B: 0.3, A: 0.3 }, scope: { stationAccessIds: ["B", "A"] } }];
  const second = run([site("B", ["n1", "n2"]), site("A", ["n3", "n2", "n1"])], POLICY(shuffledRules, { exclusive: "assign" })).out;
  assert.equal(JSON.stringify(second), JSON.stringify(first));
  assert.equal(second.allocationId, first.allocationId);
  const other = run([site("A", ["n1", "n2", "n3"]), site("B", ["n2", "n1"])], POLICY(rules, { exclusive: "hold" })).out;
  assert.notEqual(other.allocationId, first.allocationId);
  assert.notEqual(other.policyRevision, first.policyRevision);
});

test("the access export, assessment, policy and legacy links are never modified", () => {
  const access = deepFreeze(accessOf([site("A"), site("B")], [{ stationAccessIds: ["A", "B"], catchmentIds: ["catch:A", "catch:B"] }]));
  const assessment = deepFreeze(assessStationDemandAccess({ stationDemandAccess: access, pack }));
  const policy = deepFreeze(POLICY([setRule("r1", ["A", "B"], shares({ A: 0.5, B: 0.5 }))]));
  const legacy = deepFreeze([{ demandNodeId: "n1", stationId: "station:A", walkMinutes: 4 }]);
  const snapshot = JSON.stringify([access, assessment, policy, legacy]);
  const out = allocateStationDemand({ access, assessment, policy, legacyAccessLinks: legacy });
  assert.equal(JSON.stringify([access, assessment, policy, legacy]), snapshot);
  out.nodes[0].assignments.push("scribble");
  assert.equal(JSON.stringify([access, assessment, policy, legacy]), snapshot, "the result shares no object with the inputs");
});

test("the stored application can be passed instead of the two documents", () => {
  const access = accessOf([site("A")]);
  const assessment = assessStationDemandAccess({ stationDemandAccess: access, pack });
  const a = allocateStationDemand({ application: { access, assessment }, policy: POLICY([], { exclusive: "assign" }) });
  const b = allocateStationDemand({ access, assessment, policy: POLICY([], { exclusive: "assign" }) });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test("wrong or mismatched documents are errors, not silent empty results", () => {
  const access = accessOf([site("A")]);
  const assessment = assessStationDemandAccess({ stationDemandAccess: access, pack });
  assert.throws(() => allocateStationDemand({ access: { ...access, contractVersion: 2 }, assessment }), /v1 is required/);
  assert.throws(() => allocateStationDemand({ access, assessment: { ...assessment, schema: "x" } }), /assessment v1/);
  assert.throws(() => allocateStationDemand({ access, assessment: { ...assessment, sourcePackId: "other" } }), /does not belong/);
  assert.throws(() => allocateStationDemand({ access, assessment: { ...assessment, sourcePackVersion: "2" } }), /does not belong/);
  assert.throws(() => allocateStationDemand({ access }), /assessment v1/);
  assert.throws(() => allocateStationDemand({}), /v1 is required/);
});

// --- H. the policy document: schema, saving, restoring ---
test("a policy document must carry its schema and version; defaults are explicit and only sharing by rule exists", () => {
  assert.deepEqual(normalizeStationDemandAllocationPolicy({ ...POLICY(), schema: "x" }).issues, [{ code: "policy-schema-invalid" }]);
  assert.deepEqual(normalizeStationDemandAllocationPolicy({ ...POLICY(), contractVersion: 2 }).issues, [{ code: "policy-schema-invalid" }]);
  assert.deepEqual(normalizeStationDemandAllocationPolicy(POLICY([], {}, "")).issues.map((i) => i.code), ["policy-id-missing"]);
  assert.deepEqual(normalizeStationDemandAllocationPolicy(POLICY([], { shared: "assign" })).issues, [{ code: "policy-default-invalid", field: "shared" }]);
  assert.deepEqual(normalizeStationDemandAllocationPolicy(POLICY([], { exclusive: "everyone" })).issues, [{ code: "policy-default-invalid", field: "exclusive" }]);
  assert.deepEqual(normalizeStationDemandAllocationPolicy(POLICY([], { areaNodeInclusion: "mesh" })).issues, [{ code: "policy-default-invalid", field: "areaNodeInclusion" }]);
  assert.deepEqual(normalizeStationDemandAllocationPolicy(null), { policy: null, issues: [] });
  assert.deepEqual(newStationDemandAllocationPolicy("p").defaults, { exclusive: "hold", shared: "hold", areaNodeInclusion: "reject" });
});

test("modes that need a walking time or a route choice are not part of P1 and are refused, not guessed", () => {
  for (const mode of ["route-choice", "nearest-by-walk", "equal-split", undefined]) {
    assert.deepEqual(normalizeStationDemandAllocationPolicy(POLICY([setRule("r1", ["A", "B"], { mode })])).issues.map((i) => i.code), ["policy-rule-mode-unsupported"], String(mode));
  }
  assert.equal(normalizeStationDemandAllocationPolicy(POLICY([setRule("r1", ["A"], { mode: "assign-all", stationAccessId: "B" })])).issues[0].code, "policy-rule-station-unbound");
  assert.equal(normalizeStationDemandAllocationPolicy(POLICY([{ ruleId: "r1", scope: { demandNodeIds: [], stationAccessIds: ["A"] }, boundTo: bound("A"), mode: "assign-all", stationAccessId: "A" }])).issues[0].code, "policy-rule-scope-invalid");
  assert.equal(normalizeStationDemandAllocationPolicy(POLICY([{ ...setRule("r2", ["A"], { mode: "assign-all", stationAccessId: "A" }), boundTo: {} }])).issues[0].code, "policy-rule-bound-to-invalid");
});

test("saving writes canonical text and restoring gives the same policy, revision and allocation", () => {
  const rules = [setRule("r2", ["A", "B"], shares({ B: 0.25, A: 0.5 })), nodeRule("r1", ["n2", "n1"], ["B", "A"], { mode: "assign-all", stationAccessId: "A" })];
  const policy = POLICY(rules, { areaNodeInclusion: "centroid", exclusive: "assign" });
  const text = serializeStationDemandAllocationPolicy(policy);
  const reordered = serializeStationDemandAllocationPolicy({ rules: [...rules].reverse(), defaults: { exclusive: "assign", areaNodeInclusion: "centroid" }, policyId: "policy:1", contractVersion: 1, schema: STATION_DEMAND_ALLOCATION_POLICY_SCHEMA });
  assert.equal(reordered, text, "key and rule order do not change what is saved");
  const restored = restoreStationDemandAllocationPolicy(text);
  assert.deepEqual(restored.issues, []);
  assert.equal(serializeStationDemandAllocationPolicy(restored.policy), text);
  assert.equal(restored.policyRevision, stationDemandAllocationPolicyRevision(normalizeStationDemandAllocationPolicy(policy).policy));
  const sites = [site("A", ["n1", "n2"]), site("B", ["n1", "n2"])];
  assert.equal(JSON.stringify(run(sites, restored.policy).out), JSON.stringify(run(sites, policy).out));
});

test("restoring never throws: unreadable text, a wrong schema and an invalid rule come back as issues with no policy", () => {
  assert.deepEqual(restoreStationDemandAllocationPolicy("{nope"), { policy: null, policyRevision: null, issues: [{ code: "policy-unreadable" }] });
  assert.deepEqual(restoreStationDemandAllocationPolicy(JSON.stringify({ schema: "other/1" })).issues, [{ code: "policy-schema-invalid" }]);
  assert.deepEqual(restoreStationDemandAllocationPolicy(JSON.stringify(POLICY([setRule("r1", ["A"], shares({ A: 2 }))]))).policy, null);
  assert.deepEqual(restoreStationDemandAllocationPolicy(null), { policy: null, policyRevision: null, issues: [] });
  assert.throws(() => serializeStationDemandAllocationPolicy(POLICY([setRule("r1", ["A"], shares({ A: 2 }))])), /not valid/);
});

// --- I. it decides access and nothing else ---
test("the module imports no management, state, clock or random source, and the result carries no money, passenger, crowd or time field", () => {
  const src = fs.readFileSync(path.join(root, "engine", "src", "station-demand-allocation-policy.mjs"), "utf8");
  const imports = [...src.matchAll(/^import .* from "(.+)";$/gm)].map((m) => m[1]);
  assert.deepEqual(imports.sort(), ["./map/ids.mjs", "./station-demand-access-assessment.mjs"]);
  assert.doesNotMatch(src.replace(/\/\/.*$/gm, ""), /management|ledger|\.commit\(|\.settle\(|\.post\(|Date\.now|Math\.random|performance\.now|randomUUID|node:fs|simMinutes|clock/);
  const { out } = run([site("A", ["n1", "n2"]), site("B", ["n1"])], POLICY([setRule("r1", ["A", "B"], shares({ A: 0.5, B: 0.5 }))], { exclusive: "assign" }), { legacy: [{ demandNodeId: "n2", stationId: "station:A", walkMinutes: 5 }] });
  const keys = new Set();
  const walk = (v) => { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { keys.add(k); walk(x); } };
  walk(out);
  const banned = /fare|cost|cash|price|revenue|passenger|ridership|crowd|congest|probab|minute|second|time|seed|rng|random|score/i;
  assert.deepEqual([...keys].filter((k) => banned.test(k)), [], "the legacy link's walkMinutes is not copied into the result");
});

// --- J. the real Tokyo examples ---
test("the real Tokyo access examples (municipality-centroid demand, low quality) give no assignment under the most permissive policy", () => {
  const dir = path.join(root, "packs", "tokyo", "station-demand-access-examples");
  const sites = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => { const { source: _drop, ...s } = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); return s; });
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "packs", "tokyo", "manifest.json"), "utf8"));
  const tokyo = { manifest, demand: JSON.parse(fs.readFileSync(path.join(root, "packs", "tokyo", "demand.json"), "utf8")) };
  const access = { schema: "transitline.station-demand-access-export/1", contractVersion: 1, packId: manifest.id, packVersion: manifest.version, sites, catchmentOverlaps: [] };
  const assessment = assessStationDemandAccess({ stationDemandAccess: access, pack: tokyo });
  const rules = sites.map((s, i) => ({ ruleId: `r${i}`, scope: { stationAccessIds: [s.stationAccessId] }, boundTo: { [s.stationAccessId]: s.stationAccessRevision }, mode: "assign-all", stationAccessId: s.stationAccessId }));
  const out = allocateStationDemand({ access, assessment, policy: { ...POLICY(rules, { exclusive: "assign", areaNodeInclusion: "centroid" }) } });
  assert.equal(sites.length >= 3, true);
  assert.equal(out.policyStatus, "valid");
  assert.deepEqual([out.totals.assigned, out.totals.partlyAssigned], [0, 0]);
  for (const n of out.nodes) assert.deepEqual([n.state, n.residents, n.jobs, n.assignments], ["unknown", null, null, []], n.demandNodeId);
  for (const s of out.stations) assert.ok(s.allocated === null || (s.coverage === "empty-confirmed"), `${s.stationAccessId}: ${s.coverage}`);
  assert.ok(out.nodes.some((n) => n.reasons.includes("demand-source-quality-insufficient")), "the coarse, low-quality source is named as the reason");
});
