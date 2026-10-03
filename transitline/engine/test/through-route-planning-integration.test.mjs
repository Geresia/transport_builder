import test from "node:test";
import assert from "node:assert/strict";
import { ManagementGame } from "../src/management/index.mjs";
import { ScenarioRuntime } from "../src/scenario-runtime.mjs";
import { createState } from "../src/state.mjs";
import {
  buildThroughOperationDraft,
  buildThroughRouteFromSelection,
  buildThroughRouteSourceCatalog,
  externalInfrastructureCatalogForRoute,
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

function projectOperationalState() {
  const stations = new Map(projects.flatMap((entry) => entry.assets.map((asset) => [asset.id, { id: asset.id }])));
  return {
    stations,
    lines: projects.map((entry) => ({
      id: entry.commissionedLineId, projectId: entry.id,
      stationIds: entry.planGeometry.stationCandidates.map((station) => entry.assets.find((asset) => asset.sourceId === station.id).id),
    })),
  };
}

const options = (extra = {}) => ({ pack, mapExport, projects, playerOperatorId: "player", operationalState: projectOperationalState(), ...extra });
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

function serviceForRoute(route, agreementByLeg = {}) {
  return {
    schema: "transitline.through-service/1", contractVersion: 1,
    throughServiceId: "through-service:draft", throughRouteId: route.throughRouteId,
    routeGeometryRevision: route.geometryRevision, status: "approved",
    legs: route.legs.map((leg) => ({ legId: leg.legId, trackAccessAgreementId: agreementByLeg[leg.legId] ?? null })),
  };
}

test("a confirmed handover becomes one canonical simulator stop with exact access mappings", () => {
  const operationalState = projectOperationalState();
  const built = buildThroughRouteFromSelection(selection, options({ operationalState }));
  const secondLegId = built.route.legs[1].legId;
  const draft = buildThroughOperationDraft({
    route: built.route,
    throughService: serviceForRoute(built.route, { [secondLegId]: "access:b" }),
    sourceCatalog: built.catalog,
    operationalState,
  });
  assert.equal(draft.schema, "transitline.through-operation-draft/1");
  assert.deepEqual(draft.stationIds, [
    `asset:project:a:${planA.stationCandidates[0].id}`,
    `asset:project:a:${planA.stationCandidates[1].id}`,
    `asset:project:b:${planB.stationCandidates[1].id}`,
  ]);
  assert.deepEqual(draft.segmentAccessAgreementIds, [null, "access:b"]);
  assert.deepEqual(draft.stationAccessAgreementIds, [[], ["access:b"], ["access:b"]]);
  assert.deepEqual(draft.legRanges.map((range) => [range.fromStationIndex, range.toStationIndex]), [[0, 1], [1, 2]]);
});

test("unknown external topology and unresolved operational assets fail closed", () => {
  const externalSelection = {
    key: "external-route", legs: [
      { sourceId: "project:project:b", direction: "forward" },
      { sourceId: `external:${externalNetwork.id}/ext-line:1`, direction: "forward" },
    ],
  };
  const operationalState = projectOperationalState();
  operationalState.stations.set("e1", { id: "e1" });
  operationalState.stations.set("e2", { id: "e2" });
  operationalState.lines.push({ id: 20, external: true, externalNetworkId: externalNetwork.id, externalLineId: "ext-line:1", stationIds: ["e1", "e2"] });
  const built = buildThroughRouteFromSelection(externalSelection, options({ operationalState }));
  assert.throws(() => buildThroughOperationDraft({ route: built.route, throughService: serviceForRoute(built.route), sourceCatalog: built.catalog, operationalState }), /not physically confirmed/);
  const missingState = projectOperationalState();
  missingState.stations.delete(`asset:project:a:${planA.stationCandidates[0].id}`);
  const local = buildThroughRouteFromSelection(selection, options({ operationalState: missingState }));
  assert.throws(() => buildThroughOperationDraft({ route: local.route, throughService: serviceForRoute(local.route), sourceCatalog: local.catalog, operationalState: missingState }), /no commissioned operational source|unresolved operational station/);
});

function externalSpecification(overrides = {}) {
  return {
    schema: "transitline.external-rail-technical-specification/1", contractVersion: 1,
    specificationId: "spec:external:1", specificationRevision: "spec-revision:1",
    externalNetworkId: externalNetwork.id, externalLineId: "ext-line:1",
    sourcePackId: pack.manifest.id, sourcePackVersion: pack.manifest.version,
    infrastructureOwnerId: null, technicalProfileId: null,
    technicalSpecification: { gaugeMm: 1067 }, notApplicable: [], status: null, capacityTrainsPerHour: null,
    unknown: [], unknownReasons: {},
    ...overrides,
  };
}

test("sourced pack specifications join any newly drawn external route by stable line ids", () => {
  const route = buildThroughRouteFromSelection({
    key: "external-spec-route", legs: [selection.legs[1], { sourceId: `external:${externalNetwork.id}/ext-line:1` }],
  }, options()).route;
  const sourcedPack = { ...pack, externalRailTechnicalSpecifications: [externalSpecification()] };
  const catalog = externalInfrastructureCatalogForRoute(sourcedPack, route);
  assert.equal(catalog.entries.length, 1);
  assert.equal(catalog.entries[0].legId, route.legs[1].legId);
  assert.equal(catalog.entries[0].technicalSpecification.gaugeMm, 1067);
  const wrongVersion = externalInfrastructureCatalogForRoute({ ...sourcedPack, externalRailTechnicalSpecifications: [externalSpecification({ sourcePackVersion: "old" })] }, route);
  assert.deepEqual(wrongVersion.entries, []);
  assert.deepEqual(wrongVersion.unmatchedLegIds, [route.legs[1].legId]);
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

test("ScenarioRuntime derives a commission input from its saved route and live assets", () => {
  const game = new ManagementGame({ seed: 14 });
  game.projects.push(...structuredClone(projects));
  const operationalState = projectOperationalState();
  const runtime = Object.assign(Object.create(ScenarioRuntime.prototype), { pack, game, operationalState });
  const created = runtime.createThroughServiceFromSelection(selection, mapExport, {
    operatorId: "player", guestModelId: "medium_4car", trainsPerHour: 4,
  }, resultCatalog());
  const draft = runtime.throughOperationDraft(created.service.throughServiceId, mapExport);
  assert.equal(draft.throughServiceId, created.service.throughServiceId);
  assert.equal(draft.stationIds.length, 3);
  assert.deepEqual(draft.segmentAccessAgreementIds, [null, null]);
});

test("ScenarioRuntime automatically feeds sourced external specifications into assessment", () => {
  const sourcedPack = { ...pack, externalRailTechnicalSpecifications: [externalSpecification()] };
  const game = new ManagementGame({ seed: 15 });
  game.projects.push(...structuredClone(projects));
  const operationalState = projectOperationalState();
  const runtime = Object.assign(Object.create(ScenarioRuntime.prototype), { pack: sourcedPack, game, operationalState });
  const externalSelection = {
    key: "runtime-external", legs: [selection.legs[1], { sourceId: `external:${externalNetwork.id}/ext-line:1` }],
  };
  const created = runtime.createThroughServiceFromSelection(externalSelection, mapExport, {
    operatorId: "player", guestModelId: "medium_4car", trainsPerHour: 4,
  });
  const externalLeg = created.service.legs.find((leg) => leg.sourceKind === "external");
  assert.equal(externalLeg.externalSpecificationId, "spec:external:1");
  assert.equal(externalLeg.technicalCompatibility.checks.find((check) => check.checkId === "gauge").status, "incompatible");
  assert.equal(created.service.assessment.verdict, "impossible");
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
