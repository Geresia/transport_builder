import test from "node:test";
import assert from "node:assert/strict";
import { withStationAccess } from "../src/access-demand.mjs";
import { buildDemandModel } from "../src/demand-engine.mjs";
import { buildRouteGraph } from "../src/network.mjs";
import { createState, replaceStationDemandAllocationLinks } from "../src/state.mjs";

function pack() {
  return { demand: { model: "gravity", points: [
    { id: "node:a", location: [139, 35], residents: 100, jobs: 20 },
    { id: "node:b", location: [139.03, 35], residents: 80, jobs: 40 },
  ], attractors: [] } };
}

function operationalState() {
  const state = createState(pack());
  state.stations.set("station:a", { id: "station:a", location: [139.01, 35], status: "available" });
  state.stations.set("station:b", { id: "station:b", location: [139.02, 35], status: "available" });
  state.lines = [{ id: 1, stationIds: ["node:a", "station:a", "station:b", "node:b"], suspended: false }];
  state.accessLinks = [
    { id: "legacy:a", demandNodeId: "node:a", stationId: "station:a", walkMinutes: 9 },
    { id: "legacy:b", demandNodeId: "node:b", stationId: "station:b", walkMinutes: 7 },
  ];
  return state;
}

test("an applied B15 allocation takes precedence only for its own demand node", () => {
  const state = operationalState();
  state.stationDemandAllocationLinks = [{
    allocationId: "allocation:1", demandNodeId: "node:a", stationId: "station:a", walkMinutes: 4,
  }];
  const model = withStationAccess(buildDemandModel(state, pack().demand), state);
  const route = model.resolveTrip(state, buildRouteGraph(state), "node:a", "node:b");
  assert.equal(route.originStationId, "station:a", "the zero-minute legacy node station is suppressed");
  assert.equal(route.destinationStationId, "node:b", "an unallocated node keeps its old adapter");
  assert.equal(route.accessSeconds, 4 * 60);
  assert.equal(state.accessLinks[0].walkMinutes, 9, "the plan-generated link stays untouched");
});

test("invalid allocation links neither become access nor suppress an existing node path", () => {
  const state = operationalState();
  state.stationDemandAllocationLinks = [{ demandNodeId: "node:a", stationId: "missing", walkMinutes: 4 }];
  const model = withStationAccess(buildDemandModel(state, pack().demand), state);
  const route = model.resolveTrip(state, buildRouteGraph(state), "node:a", "node:b");
  assert.equal(route.originStationId, "node:a");
  assert.equal(route.destinationStationId, "node:b");
  assert.equal(route.accessSeconds, 0);
});

test("an old operational save without B15 allocation links preserves the legacy path", () => {
  const state = operationalState();
  delete state.stationDemandAllocationLinks;
  const model = withStationAccess(buildDemandModel(state, pack().demand), state);
  const route = model.resolveTrip(state, buildRouteGraph(state), "node:a", "node:b");
  assert.equal(route.originStationId, "node:a");
  assert.equal(route.destinationStationId, "node:b");
  assert.equal(route.accessSeconds, 0);
});

test("replacing B15 allocation links invalidates the access cache without touching geometry links", () => {
  const state = operationalState();
  const model = withStationAccess(buildDemandModel(state, pack().demand), state);
  const graph = buildRouteGraph(state);
  assert.equal(model.resolveTrip(state, graph, "node:a", "node:b").originStationId, "node:a");
  replaceStationDemandAllocationLinks(state, [{ demandNodeId: "node:a", stationId: "station:a", walkMinutes: 4 }]);
  assert.equal(model.resolveTrip(state, graph, "node:a", "node:b").originStationId, "station:a");
  assert.equal(state.accessLinks[0].id, "legacy:a");
});
