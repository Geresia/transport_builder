import test from "node:test";
import assert from "node:assert/strict";
import { ManagementGame } from "../src/management/index.mjs";
import { ScenarioRuntime } from "../src/scenario-runtime.mjs";
import { createState } from "../src/state.mjs";
import {
  buildThroughRouteFromSelection,
  buildThroughRouteSourceCatalog,
  removeThroughRouteSelection,
  saveThroughRouteSelection,
  throughRoutePlanningReport,
} from "../src/through-route-planning-integration.mjs";

const pack = {
  manifest: { id: "route-planning", version: "1", data: { license: "CC0", attribution: [] } },
  demand: { model: "gravity", points: [
    { id: "d1", name: "D1", location: [139, 35], residents: 100, jobs: 100 },
    { id: "d2", name: "D2", location: [139.03, 35], residents: 100, jobs: 100 },
  ], attractors: [] },
};

function plan(id, start, end, startId = `${id}:a`, endId = `${id}:b`) {
  return {
    schema: "transitline.plan-geometry/1", contractVersion: 1,
    planId: id, sourcePackId: pack.manifest.id, sourcePackVersion: pack.manifest.version,
    name: id, dataQuality: "high",
    stationCandidates: [
      { id: startId, name: `${id} A`, location: start },
      { id: endId, name: `${id} B`, location: end },
    ],
    segments: [{ id: `${id}:segment`, from: startId, to: endId, lengthMeters: 1000, alignment: [start, end] }],
    accessLinks: [],
  };
}

const planA = plan("plan:a", [139, 35], [139.01, 35]);
const planB = plan("plan:b", [139.01, 35], [139.02, 35]);
const draftPlan = plan("plan:draft", [139.02, 35], [139.03, 35]);

function project(id, geometry, extra = {}) {
  return {
    id, planId: geometry.planId, planGeometry: geometry,
    status: "available", technicalProfileId: "medium_steel", commissionedLineId: id.endsWith("a") ? 10 : 11,
    assets: geometry.stationCandidates.map((station) => ({ id: `asset:${id}:${station.id}`, kind: "station", sourceId: station.id })),
    ...extra,
  };
}

const projects = [project("project:a", planA), project("project:b", planB)];
const externalNetwork = {
  id: "external:route-planning", locationBasis: "demand-node", dataQuality: "low",
  lines: [{ id: "ext-line:1", name: "External One", operator: "operator-is-not-owner", stationIds: ["e1", "e2"] }],
  stations: [
    { id: "e1", name: "E1", location: [139.02, 35], lineIds: ["ext-line:1"] },
    { id: "e2", name: "E2", location: [139.04, 35], lineIds: ["ext-line:1"] },
  ],
};
const mapExport = {
  schema: "transitline.map-export/1", packId: pack.manifest.id, packVersion: pack.manifest.version,
  plans: [draftPlan], externalNetworks: [externalNetwork], demandNodes: [], warnings: [],
};

const options = (extra = {}) => ({ pack, mapExport, projects, playerOperatorId: "player", ...extra });
const selection = {
  key: "route-one", name: "Route One",
  legs: [
    { sourceId: "project:project:a", direction: "forward" },
    { sourceId: "project:project:b", direction: "forward" },
  ],
};

test("source catalog exposes commissioned, planned and external lines without guessing ownership", () => {
  const catalog = buildThroughRouteSourceCatalog(options());
  assert.equal(catalog.schema, "transitline.through-route-source-catalog/1");
  assert.deepEqual(catalog.sources.map((source) => source.sourceKind).sort(), ["existing", "existing", "external", "planned"]);
  const built = catalog.sources.find((source) => source.sourceId === "project:project:a");
  assert.equal(built.infrastructureOwnerId, "player");
  assert.equal(built.operationReady, true);
  assert.equal(built.stations[0].operationalStationId, `asset:project:a:${planA.stationCandidates[0].id}`);
  const external = catalog.sources.find((source) => source.sourceKind === "external");
  assert.equal(external.infrastructureOwnerId, null, "an operator tag is not an ownership fact");
});

test("seeded external line ids link map sources to their real operational line", () => {
  const operationalState = { lines: [{ id: 7, external: true, externalNetworkId: externalNetwork.id, externalLineId: "ext-line:1", stationIds: ["e1", "e2"] }] };
  const external = buildThroughRouteSourceCatalog(options({ operationalState })).sources.find((source) => source.sourceKind === "external");
  assert.equal(external.operationalLineId, "7");
  assert.equal(external.operationReady, true);
  assert.deepEqual(external.stations.map((station) => station.operationalStationId), ["e1", "e2"]);
});

test("old saves recover an external operational line by its exact station path, never its name", () => {
  const operationalState = { lines: [{ id: 8, external: true, name: "Renamed", stationIds: ["e1", "e2"] }] };
  const external = buildThroughRouteSourceCatalog(options({ operationalState })).sources.find((source) => source.sourceKind === "external");
  assert.equal(external.operationalLineId, "8");
  assert.equal(external.operationReady, true);
});

test("an ambiguous legacy station path remains unlinked", () => {
  const operationalState = { lines: [8, 9].map((id) => ({ id, external: true, stationIds: ["e1", "e2"] })) };
  const external = buildThroughRouteSourceCatalog(options({ operationalState })).sources.find((source) => source.sourceKind === "external");
  assert.equal(external.operationalLineId, null);
  assert.equal(external.operationReady, false);
});

test("constructed project geometry wins over a live draft with the same plan id", () => {
  const conflicting = structuredClone(mapExport);
  conflicting.plans.push({ ...planA, stationCandidates: [{ id: "wrong:a", location: [0, 0] }, { id: "wrong:b", location: [1, 1] }] });
  const built = buildThroughRouteFromSelection(selection, options({ mapExport: conflicting }));
  assert.deepEqual(built.route.legs[0].stationIds, planA.stationCandidates.map((station) => station.id));
});

test("ordered source selection builds a deterministic route and preserves direction", () => {
  const first = buildThroughRouteFromSelection(selection, options());
  const again = buildThroughRouteFromSelection(structuredClone(selection), options({ projects: [...projects].reverse() }));
  assert.equal(JSON.stringify(first.route), JSON.stringify(again.route));
  assert.equal(first.route.handovers[0].physicalConnection, true);
  assert.equal(first.route.legs[0].infrastructureOwnerId, "player");
  const reversed = buildThroughRouteFromSelection({ ...selection, legs: [{ sourceId: "project:project:a", direction: "reverse" }, selection.legs[1]] }, options());
  assert.deepEqual(reversed.route.legs[0].stationIds, [...first.route.legs[0].stationIds].reverse());
});

test("unknown sources, invalid direction and another pack are rejected", () => {
  assert.throws(() => buildThroughRouteFromSelection({ ...selection, legs: [{ sourceId: "missing" }, selection.legs[1]] }, options()), /Unknown through-route source/);
  assert.throws(() => buildThroughRouteFromSelection({ ...selection, legs: [{ ...selection.legs[0], direction: "sideways" }, selection.legs[1]] }, options()), /Invalid through-route direction/);
  assert.throws(() => buildThroughRouteSourceCatalog(options({ mapExport: { ...mapExport, packId: "other" } })), /belongs to pack/);
});

test("route selections save by stable key and linked routes cannot be removed", () => {
  const state = {};
  const saved = saveThroughRouteSelection(state, selection, options());
  assert.equal(state.throughRoutePlans.length, 1);
  const edited = saveThroughRouteSelection(state, { ...selection, name: "Renamed" }, options());
  assert.equal(state.throughRoutePlans.length, 1);
  assert.equal(edited.route.throughRouteId, saved.route.throughRouteId);
  assert.throws(() => removeThroughRouteSelection(state, selection.key, [{ throughRouteId: saved.route.throughRouteId }]), /cannot be removed/);
  assert.equal(removeThroughRouteSelection(state, selection.key, []), true);
  assert.equal(removeThroughRouteSelection(state, selection.key, []), false);
});

test("planning reports are detached read-only values", () => {
  const state = {};
  saveThroughRouteSelection(state, selection, options());
  const report = throughRoutePlanningReport(state, options());
  report.routes[0].route.name = "tampered";
  report.catalog.sources[0].name = "tampered";
  assert.equal(state.throughRoutePlans[0].route.name, "Route One");
  assert.notEqual(throughRoutePlanningReport(state, options()).catalog.sources[0].name, "tampered");
});

test("ScenarioRuntime creates an assessed service from a selection and saves its route plan", () => {
  const game = new ManagementGame({ seed: 12 });
  game.projects.push(...structuredClone(projects));
  const operationalState = createState(pack);
  const runtime = Object.assign(Object.create(ScenarioRuntime.prototype), { pack, game, operationalState });
  const result = runtime.createThroughServiceFromSelection(selection, mapExport, {
    operatorId: "player", guestModelId: "medium_4car", trainsPerHour: 4,
  }, resultCatalog());
  assert.equal(result.service.status, "assessed");
  assert.equal(result.service.throughRouteId, result.route.throughRouteId);
  assert.equal(runtime.report().throughRoutes.length, 1);
  const saved = runtime.save();
  runtime.load(saved);
  assert.equal(runtime.report().throughRoutes[0].route.throughRouteId, result.route.throughRouteId);
  assert.equal(runtime.throughRoutePlanningReport(mapExport).routes.length, 1);
});

function resultCatalog() {
  const route = buildThroughRouteFromSelection(selection, options()).route;
  return route.legs.map((leg) => ({ legId: leg.legId, capacityTrainsPerHour: 12 }));
}

test("failed service creation does not leave a saved route behind", () => {
  const game = new ManagementGame({ seed: 13 });
  game.projects.push(...structuredClone(projects));
  const operationalState = createState(pack);
  const runtime = Object.assign(Object.create(ScenarioRuntime.prototype), { pack, game, operationalState });
  assert.throws(() => runtime.createThroughServiceFromSelection(selection, mapExport, { operatorId: "player", guestModelId: "medium_4car", trainsPerHour: 4 }, {}), /Infrastructure catalog/);
  assert.deepEqual(operationalState.throughRoutePlans ?? [], []);
});
