import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildMapExport, existingNetworkToExternal } from "../src/map/plan-geometry.mjs";
import { stableId } from "../src/map/ids.mjs";
import { buildThroughRouteExport, keyedThroughRouteId } from "../src/map/through-route.mjs";
import {
  EXTERNAL_INFRASTRUCTURE_CATALOG_SCHEMA,
  EXTERNAL_RAIL_SPEC_SCHEMA,
  IDENTITY_FIELDS,
  TECHNICAL_FACT_FIELDS,
  buildExternalInfrastructureCatalog,
  buildExternalRailSpecification,
  buildExternalRailSpecificationExport,
  externalRailSpecificationId,
  newExternalRailSpecificationDoc,
  restoreExternalRailSpecificationDoc,
  serializeExternalRailSpecificationDoc,
} from "../src/map/external-rail-technical-specification.mjs";

// --- fixtures: a pack with two external lines (E1: d0-d2, E2: d2-d4) and a planned line "a" next to them ---
const pack = {
  manifest: { id: "t", version: "1", data: { license: "CC0-1.0", attribution: ["test"] } },
  demand: { points: ["d0", "d1", "d2", "d3", "d4"].map((id, i) => ({ id, name: id, location: [139 + i * 0.01, 35] })) },
  existingNetwork: { lines: [
    { name: "E1", operator: "Operator X", osmRelationId: 11, stationIds: ["d0", "d1", "d2"] },
    { name: "E2", operator: "Operator Y", osmRelationId: 12, stationIds: ["d2", "d3", "d4"] },
  ] },
};
const network = existingNetworkToExternal(pack);
const NET = network.id;
const L1 = "ext-line:11";
const L2 = "ext-line:12";
const src = (sourceId, facts, extra = {}) => ({ sourceId, kind: "survey", name: `Survey ${sourceId}`, license: "CC0-1.0", quality: "high", facts, ...extra });
const FULL = { runningSystemId: "steel-wheel", gaugeMm: 1067, carWidthM: 2.9, maxAxleLoadTonnes: 16, collectionSystemId: "overhead", currentSystem: "dc", voltageV: 1500,
  minimumCurveRadiusMeters: 160, maxGradientPermille: 35, signalSystemIds: ["b-system", "a-system"], platformHeightMm: 1100, doorLayoutId: "4-door-20m", minCars: 4, maxCars: 10,
  maintenanceSystemId: "m1", infrastructureOwnerId: "owner:x" };
const entry = (sources, extra = {}) => ({ externalNetworkId: NET, externalLineId: L1, name: "E1 spec", sources, ...extra });
const build = (e, networks = [network], p = pack) => buildExternalRailSpecification(e, { pack: p, externalNetworks: networks });
const spec = (e, networks, p) => {
  const out = build(e, networks, p);
  assert.ok(out.specification, JSON.stringify(out.warnings));
  return out.specification;
};
const rejected = (e, code, networks) => {
  const out = build(e, networks);
  assert.equal(out.specification, null);
  assert.equal(out.warnings[0].code, code);
  return out.warnings[0];
};
const keysDeep = (value, found = new Set()) => {
  if (Array.isArray(value)) value.forEach((v) => keysDeep(v, found));
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) { found.add(k); keysDeep(v, found); }
  return found;
};
// no judgement, score, money, approval, retrofit or contract fields (contractVersion is the schema version, not a contract)
const FORBIDDEN = /cost|fee|cash|score|verdict|possible|conditional|impossible|compatib|approv|retrofit|conversion|agreement|trackaccess|price|payment/i;
const assertPaired = (s, label = "") => {
  assert.deepEqual([...s.unknown].sort(), Object.keys(s.unknownReasons).sort(), `${label} unknown[] and unknownReasons correspond`);
  for (const f of s.unknown) assert.ok(typeof s.unknownReasons[f] === "string" && s.unknownReasons[f], `${label} reason for ${f}`);
};
const deepFreeze = (o) => { if (o && typeof o === "object") { Object.values(o).forEach(deepFreeze); Object.freeze(o); } return o; };
const ALL = [...TECHNICAL_FACT_FIELDS, ...IDENTITY_FIELDS];

// --- identity and revision ---
test("same input gives the same specificationId and byte-identical JSON", () => {
  const e = entry([src("s1", FULL)]);
  assert.equal(JSON.stringify(spec(e)), JSON.stringify(spec(structuredClone(e))));
  assert.equal(spec(e).specificationId, externalRailSpecificationId("t", NET, L1));
  assert.equal(spec(e).schema, EXTERNAL_RAIL_SPEC_SCHEMA);
  assert.equal(spec(e).contractVersion, 1);
  assert.equal(spec(e).externalNetworkId, NET);
  assert.equal(spec(e).externalLineId, L1);
  assert.equal(spec(e).sourcePackId, "t");
  assert.equal(spec(e).sourcePackVersion, "1");
});

test("source order, fact order, list order and entry order do not change the output", () => {
  const a = src("a-src", { gaugeMm: 1067, signalSystemIds: ["x", "y"], infrastructureOwnerId: "owner:x" });
  const b = src("b-src", { carWidthM: 2.9, signalSystemIds: ["y", "x"], gaugeMm: 1067 });
  const reversedFacts = (s) => ({ ...s, facts: Object.fromEntries(Object.entries(s.facts).reverse()) });
  const one = spec(entry([a, b]));
  assert.equal(JSON.stringify(spec(entry([reversedFacts(b), reversedFacts(a)]))), JSON.stringify(one));
  assert.deepEqual(one.technicalSpecification.signalSystemIds, ["x", "y"], "a stated list is kept as a sorted set");
  assert.deepEqual(one.fieldSources.gaugeMm, ["a-src", "b-src"], "agreeing sources are both recorded");
  const e1 = entry([a]);
  const e2 = { ...entry([b]), externalLineId: L2 };
  const forward = buildExternalRailSpecificationExport({ pack, externalNetworks: [network], specifications: [e1, e2] });
  const backward = buildExternalRailSpecificationExport({ pack, externalNetworks: [network], specifications: [e2, e1] });
  assert.equal(JSON.stringify(forward), JSON.stringify(backward));
  assert.equal(forward.specifications.length, 2);
});

test("renaming the specification keeps the id and the revision; changing a stated value changes only the revision", () => {
  const base = spec(entry([src("s1", FULL)]));
  const renamed = spec(entry([src("s1", FULL)], { name: "a completely different name" }));
  assert.equal(renamed.specificationId, base.specificationId);
  assert.equal(renamed.specificationRevision, base.specificationRevision);
  assert.equal(JSON.stringify({ ...renamed, name: base.name }), JSON.stringify(base), "only the display name differs");
  const relabelled = spec(entry([src("s1", FULL, { name: "Another survey name", reference: "doc 9", note: "n" })]));
  assert.equal(relabelled.specificationRevision, base.specificationRevision, "source wording is not a technical change");
  const changed = spec(entry([src("s1", { ...FULL, gaugeMm: 1435 })]));
  assert.equal(changed.specificationId, base.specificationId);
  assert.notEqual(changed.specificationRevision, base.specificationRevision);
  assert.notEqual(spec(entry([src("s1", { ...FULL, signalSystemIds: ["a-system"] })])).specificationRevision, base.specificationRevision);
  assert.notEqual(spec(entry([src("s1", { ...FULL, infrastructureOwnerId: "owner:y" })])).specificationRevision, base.specificationRevision);
  assert.notEqual(spec(entry([src("s1", { ...FULL, status: "available" })])).specificationRevision, base.specificationRevision);
  assert.notEqual(spec({ ...entry([src("s1", FULL)]), externalLineId: L2 }).specificationId, base.specificationId);
});

// --- missing data ---
test("no source: every value stays null (never 0, false, [] or a default) with a reason", () => {
  const s = spec(entry([]));
  for (const field of TECHNICAL_FACT_FIELDS) assert.equal(s.technicalSpecification[field], null, field);
  assert.equal(s.technicalSpecification.signalSystemIds, null, "unknown signalling is null, not []");
  for (const field of ["infrastructureOwnerId", "technicalProfileId", "status", "capacityTrainsPerHour"]) assert.equal(s[field], null, field);
  assert.deepEqual([...s.unknown].sort(), [...ALL].sort());
  for (const field of ALL) assert.equal(s.unknownReasons[field], "no-source", field);
  assert.deepEqual(s.sources, []);
  assert.deepEqual(s.notApplicable, []);
  assert.equal(s.dataQuality, "low");
  assertPaired(s);
});

test("a source that states only some facts leaves the rest null with no-attribute, and nothing is defaulted", () => {
  const s = spec(entry([src("s1", { gaugeMm: 1067, voltageV: null, platformHeightMm: undefined })]));
  assert.equal(s.technicalSpecification.gaugeMm, 1067);
  assert.equal(s.technicalSpecification.voltageV, null, "an explicit null states nothing");
  assert.equal(s.technicalSpecification.platformHeightMm, null);
  assert.equal(s.technicalSpecification.signalSystemIds, null);
  assert.equal(s.unknownReasons.voltageV, "no-attribute");
  assert.equal(s.unknownReasons.signalSystemIds, "no-attribute");
  assert.ok(!s.unknown.includes("gaugeMm"));
  assert.deepEqual(s.fieldSources, { gaugeMm: ["s1"] });
  assertPaired(s);
});

test("unknown[] and unknownReasons always correspond, whatever the input", () => {
  const cases = [
    entry([]),
    entry([src("s1", FULL)]),
    entry([src("s1", { gaugeMm: 1067 }), src("s2", { gaugeMm: 1435 })]),
    entry([src("s1", { gaugeMm: "1067", signalSystemIds: [], minCars: 9, maxCars: 2 })]),
    entry([src("s1", { cost: 1, gaugeMm: 1067 }, { notApplicable: ["gaugeMm", "voltageV"] })]),
    entry([src("s1", FULL, { license: "" }), src("s2", { carWidthM: 2.8 })]),
  ];
  for (const [i, c] of cases.entries()) assertPaired(spec(c), `case ${i}`);
});

test("values that are not what the contract says are not coerced: they stay null with invalid-value", () => {
  const s = spec(entry([src("s1", { gaugeMm: "1067", voltageV: 0, carWidthM: -2.8, maxAxleLoadTonnes: Number.NaN, signalSystemIds: [], collectionSystemId: "  ", minCars: 1.5, maxGradientPermille: -1 })]));
  for (const field of ["gaugeMm", "voltageV", "carWidthM", "maxAxleLoadTonnes", "collectionSystemId", "minCars", "maxGradientPermille"]) {
    assert.equal(s.technicalSpecification[field], null, field);
    assert.equal(s.unknownReasons[field], "invalid-value", field);
  }
  assert.equal(s.technicalSpecification.signalSystemIds, null, "an empty list is not 'no signalling', it is unknown");
  assert.equal(s.unknownReasons.signalSystemIds, "invalid-value");
  assert.equal(s.warnings.filter((w) => w.code === "invalid-value").length, 8);
  assert.equal(spec(entry([src("s1", { maxGradientPermille: 0 })])).technicalSpecification.maxGradientPermille, 0, "0 is a valid stated gradient");
  const cars = spec(entry([src("s1", { minCars: 9, maxCars: 2 })]));
  assert.equal(cars.technicalSpecification.minCars, null);
  assert.equal(cars.technicalSpecification.maxCars, null);
  assert.ok(cars.warnings.some((w) => w.code === "cars-range-invalid"));
  const split = spec(entry([src("s1", { minCars: 9 }), src("s2", { maxCars: 2 })]));
  assert.equal(split.technicalSpecification.minCars, null, "a range that only appears after merging is refused too");
  assert.ok(split.warnings.some((w) => w.code === "cars-range-invalid"));
});

// --- conflicts and not-applicable ---
test("sources that disagree give null and a conflict, never a pick", () => {
  const s = spec(entry([src("b-src", { gaugeMm: 1435, signalSystemIds: ["s2"], voltageV: 1500 }), src("a-src", { gaugeMm: 1067, signalSystemIds: ["s1"], voltageV: 1500 })]));
  assert.equal(s.technicalSpecification.gaugeMm, null);
  assert.equal(s.technicalSpecification.signalSystemIds, null);
  assert.equal(s.technicalSpecification.voltageV, 1500, "agreement is not a conflict");
  assert.equal(s.unknownReasons.gaugeMm, "conflicting-sources");
  assert.equal(s.unknownReasons.signalSystemIds, "conflicting-sources");
  assert.deepEqual(s.conflicts.map((c) => c.field), ["gaugeMm", "signalSystemIds"]);
  assert.deepEqual(s.conflicts[0].values, [{ sourceId: "a-src", value: 1067 }, { sourceId: "b-src", value: 1435 }]);
  assert.equal(s.warnings.filter((w) => w.code === "source-values-conflict").length, 2);
  assert.ok(!("gaugeMm" in s.fieldSources));
  assertPaired(s);
  assert.notEqual(s.specificationRevision, spec(entry([src("a-src", { gaugeMm: 1067, voltageV: 1500 })])).specificationRevision);
});

test("a gauge declared not applicable is a statement, not a gap; a value alongside it is a conflict", () => {
  const agt = spec(entry([src("s1", { runningSystemId: "rubber-tire-guideway" }, { notApplicable: ["gaugeMm"] })]));
  assert.equal(agt.technicalSpecification.gaugeMm, null);
  assert.deepEqual(agt.notApplicable, ["gaugeMm"]);
  assert.ok(!agt.unknown.includes("gaugeMm"), "not applicable is not unknown");
  assert.deepEqual(agt.fieldSources.gaugeMm, ["s1"]);
  assert.notEqual(agt.specificationRevision, spec(entry([src("s1", { runningSystemId: "rubber-tire-guideway" })])).specificationRevision, "not applicable differs from unknown");
  const clash = spec(entry([src("s1", {}, { notApplicable: ["gaugeMm"] }), src("s2", { gaugeMm: 1435 })]));
  assert.equal(clash.technicalSpecification.gaugeMm, null);
  assert.equal(clash.unknownReasons.gaugeMm, "conflicting-sources");
  assert.deepEqual(clash.notApplicable, []);
  assert.deepEqual(clash.conflicts[0].values, [{ sourceId: "s1", value: "not-applicable" }, { sourceId: "s2", value: 1435 }]);
  const wrong = spec(entry([src("s1", { gaugeMm: 1067 }, { notApplicable: ["voltageV"] })]));
  assert.ok(wrong.warnings.some((w) => w.code === "not-applicable-field-invalid" && w.field === "voltageV"));
  assert.deepEqual(wrong.notApplicable, []);
});

test("an invalid source contributes nothing and is reported; a reused source id refuses the entry", () => {
  const s = spec(entry([src("bad-license", { gaugeMm: 1067 }, { license: "" }), src("bad-kind", { carWidthM: 2.8 }, { kind: "guess" }), src("ok", { voltageV: 1500 })]));
  assert.equal(s.technicalSpecification.gaugeMm, null);
  assert.equal(s.technicalSpecification.carWidthM, null);
  assert.equal(s.technicalSpecification.voltageV, 1500);
  assert.deepEqual(s.warnings.filter((w) => w.code === "source-invalid").map((w) => [w.sourceId, w.problems]), [["bad-kind", ["kind"]], ["bad-license", ["license"]]]);
  assert.deepEqual(s.sources.map((x) => x.sourceId), ["ok"]);
  const unknownField = spec(entry([src("s1", { gaugeMm: 1067, cost: 5, retrofitRequired: true, score: 3 })]));
  assert.deepEqual(unknownField.warnings.filter((w) => w.code === "unknown-fact-field").map((w) => w.field), ["cost", "retrofitRequired", "score"]);
  assert.ok(!JSON.stringify(unknownField.technicalSpecification).includes("cost"));
  assert.deepEqual(rejected(entry([src("dup", { gaugeMm: 1067 }), src("dup", { gaugeMm: 1435 })]), "duplicate-source-id").sourceIds, ["dup"]);
});

// --- linking to the external network and to through routes ---
test("an entry must name a line of the pack's external network", () => {
  assert.equal(rejected({ ...entry([]), externalLineId: "ext-line:nope" }, "external-line-unresolved").externalLineId, "ext-line:nope");
  assert.equal(rejected({ ...entry([]), externalNetworkId: "external:other" }, "external-network-unresolved").externalNetworkId, "external:other");
  rejected(entry([]), "external-network-unresolved", []);
  rejected({ sources: [] }, "spec-entry-invalid");
  rejected({ externalNetworkId: NET, externalLineId: L1, sources: "none" }, "spec-entry-invalid");
  const out = buildExternalRailSpecificationExport({ pack, externalNetworks: [network], specifications: [entry([]), { ...entry([]), externalLineId: "ext-line:nope" }] });
  assert.equal(out.specifications.length, 1);
  assert.equal(out.warnings[0].code, "external-rail-specification-rejected");
  assert.equal(out.warnings[0].reasons[0].code, "external-line-unresolved");
});

test("the operator tag is never an owner; an owner stated by the network data is used and can conflict", () => {
  const plain = spec(entry([src("s1", { gaugeMm: 1067 })]));
  assert.equal(plain.infrastructureOwnerId, null);
  assert.equal(plain.unknownReasons.infrastructureOwnerId, "no-attribute");
  assert.ok(!JSON.stringify(plain).includes("Operator X"));
  const owned = structuredClone(network);
  owned.lines[0].infrastructureOwnerId = "owner:network";
  const fromNetwork = spec(entry([src("s1", { gaugeMm: 1067 })]), [owned]);
  assert.equal(fromNetwork.infrastructureOwnerId, "owner:network");
  assert.ok(fromNetwork.sources.some((x) => x.sourceId === `external-network:${NET}` && x.facts.includes("infrastructureOwnerId")));
  assert.equal(spec(entry([src("s1", { infrastructureOwnerId: "owner:network" })]), [owned]).infrastructureOwnerId, "owner:network");
  const clash = spec(entry([src("s1", { infrastructureOwnerId: "owner:other" })]), [owned]);
  assert.equal(clash.infrastructureOwnerId, null);
  assert.equal(clash.unknownReasons.infrastructureOwnerId, "conflicting-sources");
  assert.equal(clash.conflicts[0].field, "infrastructureOwnerId");
});

test("two entries for one external line are both refused, in any order", () => {
  const a = entry([src("s1", { gaugeMm: 1067 })], { name: "second" });
  const b = entry([src("s2", { gaugeMm: 1435 })], { name: "first" });
  const forward = buildExternalRailSpecificationExport({ pack, externalNetworks: [network], specifications: [a, b] });
  const backward = buildExternalRailSpecificationExport({ pack, externalNetworks: [network], specifications: [b, a] });
  assert.equal(forward.specifications.length, 0);
  assert.equal(forward.warnings[0].code, "duplicate-external-line-specification");
  assert.deepEqual(forward.warnings[0].names, ["first", "second"]);
  assert.equal(JSON.stringify(forward), JSON.stringify(backward));
});

const plansExport = buildMapExport({ pack, mode: "existing", drawnLines: [{ key: "a", name: "a", vertices: [[139, 35.0], [139.01, 35.0], [139.02, 35.0]].map((location) => ({ location, platformType: "side" })) }] });
const planId = stableId("plan", "t", "key", "a");
const routes = (drawn) => buildThroughRouteExport({ pack, mapExport: plansExport, routes: drawn });
const planned = { sourceKind: "planned", planId };
const ext = (line, extra = {}) => ({ sourceKind: "external", externalLineId: line, ...extra });

test("the catalog joins external legs to specifications by legId, externalNetworkId and externalLineId", () => {
  const routeExport = routes([{ key: "r1", legs: [planned, ext(L1)] }, { key: "r2", legs: [planned, ext(L2)] }]);
  const specs = buildExternalRailSpecificationExport({ pack, externalNetworks: [network], specifications: [entry([src("s1", { gaugeMm: 1067, voltageV: 1500 })])] });
  const catalog = buildExternalInfrastructureCatalog({ specificationExport: specs, routeExport });
  assert.equal(catalog.schema, EXTERNAL_INFRASTRUCTURE_CATALOG_SCHEMA);
  assert.equal(catalog.entries.length, 1);
  const routeL1 = routeExport.routes.find((r) => r.legs.some((l) => l.externalLineId === L1));
  const routeL2 = routeExport.routes.find((r) => r.legs.some((l) => l.externalLineId === L2));
  const leg = routeL1.legs.find((l) => l.sourceKind === "external");
  const [item] = catalog.entries;
  assert.equal(item.legId, leg.legId);
  assert.equal(item.externalNetworkId, NET);
  assert.equal(item.externalLineId, L1);
  assert.equal(item.throughRouteId, routeL1.throughRouteId);
  assert.equal(item.routeGeometryRevision, routeL1.geometryRevision);
  assert.equal(item.specificationId, specs.specifications[0].specificationId);
  assert.equal(item.specificationRevision, specs.specifications[0].specificationRevision);
  for (const key of ["legId", "externalNetworkId", "externalLineId", "infrastructureOwnerId", "technicalProfileId", "technicalSpecification", "status", "capacityTrainsPerHour"]) assert.ok(key in item, key);
  assert.equal(item.technicalProfileId, null, "no profile is guessed");
  assert.equal(item.status, null);
  assert.equal(item.capacityTrainsPerHour, null);
  assert.equal(item.infrastructureOwnerId, null);
  assert.deepEqual(Object.keys(item.technicalSpecification), [...TECHNICAL_FACT_FIELDS]);
  assert.equal(item.technicalSpecification.gaugeMm, 1067);
  assert.equal(item.technicalSpecification.signalSystemIds, null);
  assert.deepEqual(item.unknown.slice().sort(), specs.specifications[0].unknown.slice().sort());
  assert.deepEqual(catalog.unmatchedLegIds, [routeL2.legs.find((l) => l.sourceKind === "external").legId], "a leg with no specification is listed, never filled in");
  assert.equal(JSON.stringify(catalog), JSON.stringify(buildExternalInfrastructureCatalog({ specificationExport: structuredClone(specs), routeExport: structuredClone(routeExport) })));
});

test("the catalog states technicalProfileId, status and capacity only when a source did, and refuses another pack's routes", () => {
  const stated = buildExternalRailSpecificationExport({ pack, externalNetworks: [network], specifications: [entry([src("s1", { technicalProfileId: "medium_steel", status: "available", capacityTrainsPerHour: 20, infrastructureOwnerId: "owner:x" })])] });
  const routeExport = routes([{ key: "r1", legs: [planned, ext(L1)] }]);
  const [item] = buildExternalInfrastructureCatalog({ specificationExport: stated, routeExport }).entries;
  assert.equal(item.technicalProfileId, "medium_steel");
  assert.equal(item.status, "available");
  assert.equal(item.capacityTrainsPerHour, 20);
  assert.equal(item.infrastructureOwnerId, "owner:x");
  const foreign = buildExternalInfrastructureCatalog({ specificationExport: { ...stated, packId: "other" }, routeExport });
  assert.equal(foreign.entries.length, 0);
  assert.equal(foreign.warnings[0].code, "route-other-pack");
});

test("a leg owner that disagrees with the specification owner is reported and not guessed", () => {
  const specs = buildExternalRailSpecificationExport({ pack, externalNetworks: [network], specifications: [entry([src("s1", { infrastructureOwnerId: "owner:x" })])] });
  const legOwner = routes([{ key: "r1", legs: [planned, ext(L1, { infrastructureOwnerId: "owner:y" })] }]);
  const out = buildExternalInfrastructureCatalog({ specificationExport: specs, routeExport: legOwner });
  assert.equal(out.entries[0].infrastructureOwnerId, null);
  assert.equal(out.warnings[0].code, "leg-owner-conflicts-specification");
  const onlyLeg = buildExternalInfrastructureCatalog({
    specificationExport: buildExternalRailSpecificationExport({ pack, externalNetworks: [network], specifications: [entry([src("s1", { gaugeMm: 1067 })])] }),
    routeExport: legOwner,
  });
  assert.equal(onlyLeg.entries[0].infrastructureOwnerId, "owner:y", "a stated leg owner fills a missing specification owner");
});

// --- purity and shape ---
test("building never changes the pack, the networks or the entries it was given", () => {
  const frozenNetwork = deepFreeze(structuredClone(network));
  const out = buildExternalRailSpecificationExport({ pack: deepFreeze(structuredClone(pack)), externalNetworks: [frozenNetwork], specifications: [deepFreeze(entry([src("s1", FULL)]))] });
  assert.equal(out.specifications.length, 1);
  const s = out.specifications[0];
  s.technicalSpecification.signalSystemIds.push("mutated");
  assert.deepEqual(spec(entry([src("s1", FULL)])).technicalSpecification.signalSystemIds, ["a-system", "b-system"]);
});

test("the output has every required field and no judgement, money, approval or retrofit fields", () => {
  const s = spec(entry([src("s1", FULL)]));
  for (const f of ["schema", "contractVersion", "specificationId", "specificationRevision", "externalNetworkId", "externalLineId", "sourcePackId", "sourcePackVersion", "infrastructureOwnerId",
    "technicalSpecification", "dataQuality", "unknown", "unknownReasons", "sources", "license", "warnings"]) assert.ok(f in s, f);
  assert.deepEqual(Object.keys(s.technicalSpecification), ["runningSystemId", "gaugeMm", "carWidthM", "maxAxleLoadTonnes", "collectionSystemId", "currentSystem", "voltageV",
    "minimumCurveRadiusMeters", "maxGradientPermille", "signalSystemIds", "platformHeightMm", "doorLayoutId", "minCars", "maxCars", "maintenanceSystemId"]);
  assert.equal(s.license.pack, "CC0-1.0");
  assert.deepEqual(s.license.attribution, ["test"]);
  assert.ok(s.sources.every((x) => x.sourceId && x.kind && x.name && x.license));
  const routeExport = routes([{ key: "r1", legs: [planned, ext(L1)] }]);
  const specs = buildExternalRailSpecificationExport({ pack, externalNetworks: [network], specifications: [entry([src("s1", FULL)]), entry([src("s2", { gaugeMm: 1, cost: 4 })], { externalLineId: L2 })] });
  const found = new Set([...keysDeep(specs), ...keysDeep(buildExternalInfrastructureCatalog({ specificationExport: specs, routeExport }))]);
  for (const key of found) assert.ok(!FORBIDDEN.test(key), `unexpected management field ${key}`);
  const source = fs.readFileSync(new URL("../src/map/external-rail-technical-specification.mjs", import.meta.url), "utf8");
  assert.ok(!/from\s+["'][^"']*management/.test(source), "the map layer imports nothing from management");
});

test("dataQuality follows the unknown count and the sources, and a synthetic fixture is never better than low", () => {
  assert.equal(spec(entry([src("s1", FULL)])).dataQuality, "high");
  assert.equal(spec(entry([src("s1", FULL, { quality: "medium" })])).dataQuality, "medium");
  assert.equal(spec(entry([src("s1", FULL, { quality: undefined })])).dataQuality, "low", "a source that does not say how good it is counts as low");
  assert.equal(spec(entry([src("s1", FULL, { kind: "synthetic-fixture" })])).dataQuality, "low");
  const { voltageV, ...missingOne } = FULL;
  assert.equal(spec(entry([src("s1", missingOne)])).dataQuality, "medium");
  assert.equal(spec(entry([])).dataQuality, "low");
  assert.equal(spec(entry([src("s1", FULL)])).unknown.length, 3, "the optional profile, status and capacity are unknown but do not lower quality");
});

// --- saved documents ---
test("a saved document is never applied to the wrong pack, and pack changes are reported", () => {
  const doc = newExternalRailSpecificationDoc("t", "1");
  doc.specifications.push(entry([src("s1", FULL)]));
  const text = serializeExternalRailSpecificationDoc(doc);
  const exportOf = (d) => JSON.stringify(buildExternalRailSpecificationExport({ pack, externalNetworks: [network], specifications: d.specifications }));
  const same = restoreExternalRailSpecificationDoc(text, pack);
  assert.deepEqual(same.warnings, []);
  assert.equal(exportOf(same.doc), exportOf(doc), "save and restore keeps every id, revision and value");
  const other = restoreExternalRailSpecificationDoc(text, { manifest: { id: "other", version: "1" } });
  assert.equal(other.warnings[0].code, "external-rail-spec-doc-other-pack");
  assert.equal(other.warnings[0].savedPackId, "t");
  assert.equal(other.doc.specifications.length, 0);
  assert.equal(other.doc.packId, "other");
  const newer = restoreExternalRailSpecificationDoc(text, { manifest: { id: "t", version: "2" } });
  assert.equal(newer.warnings[0].code, "pack-version-mismatch");
  assert.equal(newer.doc.specifications.length, 1);
  assert.equal(restoreExternalRailSpecificationDoc("{not json", pack).warnings[0].code, "external-rail-spec-doc-unreadable");
  assert.equal(restoreExternalRailSpecificationDoc(JSON.stringify({ version: 99, specifications: [] }), pack).warnings[0].code, "external-rail-spec-doc-version");
  assert.deepEqual(restoreExternalRailSpecificationDoc(null, pack).warnings, []);
});

// --- shipped examples (packs/<id>/external-rail-technical-examples) ---
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const readJson = (p) => JSON.parse(fs.readFileSync(path.join(root, p), "utf8"));
const listFiles = (id, dir, suffix) => fs.readdirSync(path.join(root, "packs", id, dir)).filter((f) => f.endsWith(suffix)).sort();
const PACKS = ["tokyo", "example-radial", "example-corridor"];
const loadExamples = (id) => {
  const manifest = readJson(`packs/${id}/manifest.json`);
  const demand = readJson(`packs/${id}/${manifest.files.demand}`);
  const existingNetwork = manifest.files.existingNetwork ? readJson(`packs/${id}/${manifest.files.existingNetwork}`) : null;
  const dir = "external-rail-technical-examples";
  return {
    manifest, demand, existingNetwork,
    specs: listFiles(id, dir, ".spec.json").map((f) => ({ file: f, spec: readJson(`packs/${id}/${dir}/${f}`) })),
    catalogs: listFiles(id, dir, ".catalog.json").map((f) => ({ file: f, catalog: readJson(`packs/${id}/${dir}/${f}`) })),
  };
};
const networkOf = (ex, example) => existingNetworkToExternal({ manifest: ex.manifest, demand: ex.demand, existingNetwork: example.source.fixtureExistingNetwork ?? ex.existingNetwork });

test("every pack ships specification examples", () => {
  assert.ok(loadExamples("tokyo").specs.length >= 2);
  assert.ok(loadExamples("example-radial").specs.length >= 6);
  assert.ok(loadExamples("example-corridor").specs.length >= 2);
  assert.equal(loadExamples("tokyo").catalogs.length, 1);
});

test("examples link to a real line of their network, pair unknown with reasons, and carry source and license", () => {
  for (const id of PACKS) {
    const ex = loadExamples(id);
    for (const { file, spec: s } of ex.specs) {
      const net = networkOf(ex, s);
      assert.equal(s.schema, EXTERNAL_RAIL_SPEC_SCHEMA, file);
      assert.equal(s.sourcePackId, id);
      assert.equal(s.specificationId, externalRailSpecificationId(id, s.externalNetworkId, s.externalLineId), file);
      assert.ok(net.id === s.externalNetworkId && net.lines.some((l) => l.id === s.externalLineId), `${file}: line exists in the network`);
      assertPaired(s, file);
      for (const f of s.unknown) {
        const value = TECHNICAL_FACT_FIELDS.includes(f) ? s.technicalSpecification[f] : s[f];
        assert.equal(value, null, `${file}: ${f} is null`);
      }
      assert.equal(s.license.pack, ex.manifest.data.license);
      assert.ok(s.sources.every((x) => x.sourceId && x.kind && x.name && x.license), `${file}: every source has an id, kind, name and license`);
      for (const key of keysDeep(s)) assert.ok(!FORBIDDEN.test(key), `${file}: ${key}`);
      if (id !== "tokyo") assert.ok(s.sources.every((x) => x.kind === "synthetic-fixture"), `${file}: synthetic packs use labelled fixtures only`);
    }
  }
});

test("the examples cover every required case", () => {
  const all = PACKS.flatMap((id) => loadExamples(id).specs.map((e) => ({ id, file: e.file, s: e.spec })));
  const find = (pred, label) => { const hit = all.find(pred); assert.ok(hit, label); return hit.s; };
  const full = find(({ s }) => s.unknown.length === 3 && s.notApplicable.length === 0 && s.conflicts.length === 0, "a fully stated steel-wheel line");
  assert.ok(Object.values(full.technicalSpecification).every((v) => v !== null));
  const gaugeOnly = find(({ s }) => s.technicalSpecification.gaugeMm !== null && s.technicalSpecification.signalSystemIds === null && s.technicalSpecification.platformHeightMm === null && s.technicalSpecification.voltageV === null, "only the gauge is stated");
  assert.equal(gaugeOnly.unknownReasons.signalSystemIds, "no-attribute");
  assert.ok(find(({ s }) => (s.technicalSpecification.signalSystemIds ?? []).length >= 2, "several signalling systems"));
  assert.ok(find(({ s }) => s.technicalSpecification.collectionSystemId === "third-rail", "third rail"));
  const agt = find(({ s }) => s.notApplicable.includes("gaugeMm"), "gauge not applicable");
  assert.equal(agt.technicalSpecification.gaugeMm, null);
  assert.ok(!agt.unknown.includes("gaugeMm"));
  const conflicting = find(({ s }) => s.conflicts.length > 0, "conflicting sources");
  assert.equal(conflicting.unknownReasons.gaugeMm, "conflicting-sources");
  assert.ok(conflicting.warnings.some((w) => w.code === "source-values-conflict"));
  const none = find(({ s }) => s.sources.length === 0, "no technical data");
  assert.ok(ALL.every((f) => none.unknown.includes(f) && none.unknownReasons[f] === "no-source"));
  assert.equal(none.technicalSpecification.signalSystemIds, null);
});

test("the real Tokyo example states only what its cited source states, with source and license", () => {
  const toei = loadExamples("tokyo").specs.find((e) => e.file.startsWith("01-toei-shinjuku")).spec;
  assert.equal(toei.externalLineId, "ext-line:443259");
  const stated = Object.entries(toei.technicalSpecification).filter(([, v]) => v !== null).map(([k]) => k).sort();
  assert.deepEqual(stated, ["collectionSystemId", "currentSystem", "gaugeMm", "voltageV"]);
  assert.equal(toei.technicalSpecification.gaugeMm, 1372);
  assert.equal(toei.technicalSpecification.voltageV, 1500);
  assert.equal(toei.technicalSpecification.runningSystemId, null, "not inferred from 'subway'");
  assert.equal(toei.infrastructureOwnerId, null, "the operator tag is not an owner");
  assert.ok(!JSON.stringify(toei.technicalSpecification).includes("東京都"));
  assert.equal(toei.sources.length, 1);
  const [source] = toei.sources;
  assert.equal(source.license, "CC0-1.0");
  assert.match(source.reference, /Q1374502/);
  assert.match(source.attribution, /ODbL-1.0/);
  assert.equal(source.quality, "low");
  assert.equal(toei.dataQuality, "low");
  const minatomirai = loadExamples("tokyo").specs.find((e) => e.file.startsWith("02-minatomirai")).spec;
  assert.equal(minatomirai.sources.length, 0);
});

test("examples regenerate byte-for-byte from their drawn specifications", () => {
  for (const id of PACKS) {
    const ex = loadExamples(id);
    for (const { file, spec: stored } of ex.specs) {
      const { source, ...body } = stored;
      const out = buildExternalRailSpecificationExport({ pack: { manifest: ex.manifest }, externalNetworks: [networkOf(ex, stored)], specifications: [source.drawnSpecification] });
      assert.equal(JSON.stringify(out.specifications[0]), JSON.stringify(body), `${id}/${file} is stale: run npm run external-rail-technical-examples`);
    }
  }
});

test("the Tokyo catalog is the join of the shipped through-route examples and specifications, and the route examples keep their ids", () => {
  const ex = loadExamples("tokyo");
  const [{ file, catalog: stored }] = ex.catalogs;
  const { source, ...body } = stored;
  const routeFiles = source.throughRouteExamples.map((f) => ({ f, route: readJson(`packs/tokyo/through-route-examples/${f}.through-route.json`) }));
  const specs = source.specificationExamples.map((f) => { const { source: _drop, ...rest } = ex.specs.find((e) => e.file === `${f}.spec.json`).spec; return rest; });
  const rebuilt = buildExternalInfrastructureCatalog({
    specificationExport: { packId: "tokyo", packVersion: ex.manifest.version, specifications: specs },
    routeExport: { routes: routeFiles.map((r) => r.route) },
  });
  assert.equal(JSON.stringify(rebuilt), JSON.stringify(body), `${file} is stale: run npm run external-rail-technical-examples`);
  assert.equal(body.entries.length, 2);
  for (const entryItem of body.entries) {
    const route = routeFiles.find((r) => r.route.throughRouteId === entryItem.throughRouteId).route;
    assert.ok(route.legs.some((l) => l.legId === entryItem.legId && l.externalLineId === entryItem.externalLineId && l.externalNetworkId === entryItem.externalNetworkId));
    assert.equal(entryItem.routeGeometryRevision, route.geometryRevision);
    assert.equal(entryItem.technicalSpecification.gaugeMm, 1372);
  }
  // the through-route examples this contract links to must still be exactly what the through-route generator makes
  for (const id of PACKS) {
    for (const f of listFiles(id, "through-route-examples", ".through-route.json")) {
      const route = readJson(`packs/${id}/through-route-examples/${f}`);
      assert.equal(route.throughRouteId, keyedThroughRouteId(id, route.key), `${id}/${f}`);
    }
  }
});
