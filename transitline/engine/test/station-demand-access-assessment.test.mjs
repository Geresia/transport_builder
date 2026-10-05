import test from "node:test";
import assert from "node:assert/strict";
import { assessStationDemandAccess, STATION_DEMAND_ACCESS_INPUT_SCHEMA } from "../src/station-demand-access-assessment.mjs";

const pack = Object.freeze({ manifest: { id: "pack-a", version: "1" }, demand: { model: "gravity", points: [
  { id: "local", residents: 100, jobs: 40 }, { id: "other", residents: 50, jobs: 80 }, { id: "partial", residents: 10 },
] } });
const localSource = Object.freeze({ sourceId: "source:demand", kind: "demand-points", quality: "medium", spatialResolution: "individual-demand-node" });
const coarseSource = Object.freeze({ ...localSource, spatialResolution: "municipality-centroid", quality: "low" });
const site = (id, nodes = ["local"], source = localSource, catchments = true) => ({
  stationAccessId: id, stationAccessRevision: `${id}:r1`, connectedPlanId: "plan:1", connectedStationId: `station:${id}`,
  demandSourceRefs: source === null ? null : [source], catchments: catchments ? [{ catchmentId: `catch:${id}`, demandNodeIdsInside: nodes }] : [],
});
const access = (sites, catchmentOverlaps = []) => ({ schema: "transitline.station-demand-access-export/1", contractVersion: 1, packId: "pack-a", packVersion: "1", sites, catchmentOverlaps });

test("a confirmed local source exposes raw demand values only to the engine", () => {
  const result = assessStationDemandAccess({ stationDemandAccess: access([site("a", ["local", "other"])]), pack });
  assert.equal(result.schema, STATION_DEMAND_ACCESS_INPUT_SCHEMA);
  assert.equal(result.sites[0].catchmentStatus, "available");
  assert.deepEqual(result.sites[0].totals.exclusive, { residents: 150, jobs: 120 });
  assert.deepEqual(result.sites[0].demandNodeInputs.map((node) => node.status), ["available", "available"]);
});

test("coarse or unassessed source data is never allocated to a small station catchment", () => {
  for (const source of [coarseSource, null, { ...localSource, quality: null }, { ...localSource, spatialResolution: "unknown-grid" }]) {
    const result = assessStationDemandAccess({ stationDemandAccess: access([site("a", ["local"], source)]), pack });
    const entry = result.sites[0].demandNodeInputs[0];
    assert.equal(result.sites[0].catchmentStatus, "unknown");
    assert.equal(entry.status, "unknown");
    assert.equal(entry.residents, null);
    assert.equal(entry.jobs, null);
  }
});

test("confirmed empty, unseen empty and an un-drawn boundary preserve distinct null/zero meanings", () => {
  const result = assessStationDemandAccess({ stationDemandAccess: access([
    site("empty", []), site("unseen", [], coarseSource), site("none", [], localSource, false),
  ]), pack });
  const empty = result.sites.find((entry) => entry.stationAccessId === "empty");
  const unseen = result.sites.find((entry) => entry.stationAccessId === "unseen");
  const none = result.sites.find((entry) => entry.stationAccessId === "none");
  assert.equal(empty.catchmentStatus, "empty-confirmed");
  assert.deepEqual(empty.totals.exclusive, { residents: 0, jobs: 0 });
  assert.equal(unseen.catchmentStatus, "empty-unseen");
  assert.equal(unseen.totals.exclusive, null);
  assert.equal(none.catchmentStatus, "not-drawn");
  assert.equal(none.totals.exclusive, null);
});

test("overlapping catchments keep candidate values separate and demand an allocation policy", () => {
  const result = assessStationDemandAccess({ stationDemandAccess: access([site("a"), site("b")], [{ stationAccessIds: ["a", "b"], catchmentIds: ["catch:a", "catch:b"] }]), pack });
  for (const item of result.sites) {
    assert.equal(item.catchmentStatus, "shared");
    assert.equal(item.allocationStatus, "policy-required");
    assert.equal(item.totals.allocated, null);
    assert.equal(item.demandNodeInputs[0].status, "shared");
    assert.deepEqual(item.demandNodeInputs[0].sharedWithStationAccessIds, [item.stationAccessId === "a" ? "b" : "a"]);
  }
});

test("missing node values and ids remain unknown rather than becoming zero", () => {
  const result = assessStationDemandAccess({ stationDemandAccess: access([site("a", ["partial", "missing"])]), pack });
  const inputs = result.sites[0].demandNodeInputs;
  assert.deepEqual(inputs.map((entry) => [entry.demandNodeId, entry.reason, entry.residents, entry.jobs]), [
    ["missing", "demand-node-missing-from-pack", null, null], ["partial", "demand-node-values-missing", null, null],
  ]);
  assert.equal(result.sites[0].totals.exclusive, null);
  assert.equal(result.sites[0].totalsComplete, false);
});

test("cross-site node claims prevent duplicate exclusivity even if the map omitted its overlap record", () => {
  const result = assessStationDemandAccess({ stationDemandAccess: access([site("a"), site("b")]) , pack });
  for (const item of result.sites) {
    assert.equal(item.catchmentStatus, "shared");
    assert.equal(item.demandNodeInputs[0].status, "shared");
    assert.deepEqual(item.demandNodeInputs[0].claimedByStationAccessIds, ["a", "b"]);
  }
});

test("a polygon overlap without a shared node does not turn either node into a shared demand claim", () => {
  const result = assessStationDemandAccess({ stationDemandAccess: access([
    site("a", ["local"]), site("b", ["other"]),
  ], [{ stationAccessIds: ["a", "b"], catchmentIds: ["catch:a", "catch:b"] }]), pack });
  assert.deepEqual(result.sites.map((item) => item.demandNodeInputs[0].status), ["available", "available"]);
});

test("pack identity and contract version are strict, and inputs are not modified", () => {
  const geometry = access([site("a")]);
  const frozen = Object.freeze(structuredClone(geometry));
  const before = JSON.stringify(frozen);
  assert.deepEqual(assessStationDemandAccess({ stationDemandAccess: frozen, pack }), assessStationDemandAccess({ stationDemandAccess: structuredClone(frozen), pack }));
  assert.equal(JSON.stringify(frozen), before);
  assert.throws(() => assessStationDemandAccess({ stationDemandAccess: { ...geometry, packId: "other" }, pack }), /another pack/);
  assert.throws(() => assessStationDemandAccess({ stationDemandAccess: { ...geometry, contractVersion: 2 }, pack }), /v1/);
});
