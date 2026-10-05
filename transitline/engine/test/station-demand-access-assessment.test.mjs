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

test("a drawn empty catchment is distinct from a catchment the player has not drawn", () => {
  const result = assessStationDemandAccess({ stationDemandAccess: access([site("empty", []), site("none", [], localSource, false)]), pack });
  assert.equal(result.sites.find((entry) => entry.stationAccessId === "empty").catchmentStatus, "empty");
  assert.equal(result.sites.find((entry) => entry.stationAccessId === "none").catchmentStatus, "not-drawn");
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
  assert.deepEqual(result.sites[0].totals.exclusive, { residents: 0, jobs: 0 });
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
