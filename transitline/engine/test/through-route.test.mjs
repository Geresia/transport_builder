import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildMapExport, existingNetworkToExternal } from "../src/map/plan-geometry.mjs";
import { stableId } from "../src/map/ids.mjs";
import {
  NEAR_ENDPOINT_METERS,
  THROUGH_ROUTE_SCHEMA,
  buildThroughRoute,
  buildThroughRouteExport,
  keyedThroughRouteId,
  newThroughRouteDoc,
  restoreThroughRouteDoc,
  serializeThroughRouteDoc,
} from "../src/map/through-route.mjs";

// --- fixtures: plans along lat 35. a: 139.00-139.02, b continues from a's end, c is far away, n starts ~36 m past a's end ---
const pack = {
  manifest: { id: "t", version: "1", data: { license: "CC0-1.0", attribution: ["test"] } },
  demand: { points: ["d0", "d1", "d2", "d3", "d4"].map((id, i) => ({ id, name: id, location: [139 + i * 0.01, 35] })) },
  existingNetwork: { lines: [{ name: "E1", operator: "Operator X", osmRelationId: 42, stationIds: ["d1", "d2", "d3"] }] },
};
const line = (key, lons, lat = 35) => ({ key, name: key, vertices: lons.map((lon) => ({ location: [lon, lat], platformType: "side" })) });
const mapExport = buildMapExport({
  pack, mode: "existing",
  drawnLines: [line("a", [139, 139.01, 139.02]), line("b", [139.02, 139.03, 139.04]), line("c", [139.1, 139.11], 35.1), line("n", [139.0204, 139.03])],
});
const planId = (key) => stableId("plan", "t", "key", key);
const stations = (key) => mapExport.plans.find((p) => p.planId === planId(key)).stationCandidates.map((s) => s.id);
const leg = (key, extra = {}) => ({ sourceKind: "planned", planId: planId(key), ...extra });
const EXT = { sourceKind: "external", externalLineId: "ext-line:42" };
const build = (drawn, m = mapExport, p = pack) => buildThroughRoute(drawn, { pack: p, plans: m.plans, externalNetworks: m.externalNetworks });
const route = (drawn, m, p) => {
  const out = build(drawn, m, p);
  assert.ok(out.route, JSON.stringify(out.warnings));
  return out.route;
};
const rejected = (drawn, code) => {
  const out = build(drawn);
  assert.equal(out.route, null);
  assert.equal(out.warnings[0].code, code);
  return out.warnings[0];
};
const keysDeep = (value, found = new Set()) => {
  if (Array.isArray(value)) value.forEach((v) => keysDeep(v, found));
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) { found.add(k); keysDeep(v, found); }
  return found;
};
const FORBIDDEN = /cost|fee|cash|score|verdict|possible|conditional|impossible/i;
const deepFreeze = (o) => { if (o && typeof o === "object") { Object.values(o).forEach(deepFreeze); Object.freeze(o); } return o; };

// --- identity ---
test("same input gives the same throughRouteId and byte-identical JSON", () => {
  const drawn = { key: "r1", name: "A to B", legs: [leg("a"), leg("b")] };
  assert.equal(JSON.stringify(route(drawn)), JSON.stringify(route(structuredClone(drawn))));
  assert.equal(route(drawn).throughRouteId, keyedThroughRouteId("t", "r1"));
  assert.equal(route(drawn).schema, THROUGH_ROUTE_SCHEMA);
  assert.equal(route(drawn).contractVersion, 1);
});

test("renaming the route or reordering the input array keeps every id (and the order stays explicit)", () => {
  const ordered = [leg("a", { sequence: 0 }), leg("b", { sequence: 1 }), leg("c", { sequence: 2 })];
  const base = route({ key: "r", name: "first", legs: ordered });
  const shuffled = route({ key: "r", name: "first", legs: [ordered[2], ordered[0], ordered[1]] });
  assert.equal(JSON.stringify(shuffled), JSON.stringify(base), "same sequences give the same output whatever the array order");
  const renamed = route({ key: "r", name: "something else", legs: ordered });
  assert.equal(renamed.throughRouteId, base.throughRouteId);
  assert.deepEqual(renamed.legs, base.legs);
  assert.deepEqual(renamed.handovers, base.handovers);
  assert.deepEqual(base.legs.map((l) => l.sequence), [0, 1, 2]);
  assert.deepEqual(base.handovers.map((h) => h.sequence), [0, 1]);
  assert.deepEqual(base.legs.map((l) => l.connectedPlanId), [planId("a"), planId("b"), planId("c")]);
  const keyless = route({ legs: ordered });
  assert.equal(route({ name: "other", legs: [ordered[1], ordered[2], ordered[0]] }).throughRouteId, keyless.throughRouteId);
});

test("a keyless route keeps its id when drawn in the opposite direction, and differs for a different target", () => {
  const [a1, a2] = [stations("a")[0], stations("a").at(-1)];
  const [b1, b2] = [stations("b")[0], stations("b").at(-1)];
  const forward = route({ legs: [leg("a"), leg("b")] });
  const reverse = route({ legs: [leg("b", { fromStationId: b2, toStationId: b1 }), leg("a", { fromStationId: a2, toStationId: a1 })] });
  assert.equal(reverse.throughRouteId, forward.throughRouteId);
  assert.deepEqual(reverse.legs.map((l) => l.legId).reverse(), forward.legs.map((l) => l.legId));
  assert.deepEqual(reverse.legs.map((l) => l.stationIds), [stations("b").slice().reverse(), stations("a").slice().reverse()], "the drawn direction is kept in the output");
  assert.notEqual(route({ legs: [leg("a"), leg("c")] }).throughRouteId, forward.throughRouteId);
});

test("a keyed route keeps its id after its legs are edited", () => {
  const before = route({ key: "keep", legs: [leg("a"), leg("b")] });
  const edited = route({ key: "keep", legs: [leg("a", { toStationId: stations("a")[1] }), leg("c")] });
  assert.equal(edited.throughRouteId, before.throughRouteId);
  assert.notDeepEqual(edited.legs.map((l) => l.legId), before.legs.map((l) => l.legId));
  assert.notEqual(route({ key: "other", legs: [leg("a"), leg("b")] }).throughRouteId, before.throughRouteId);
});

// --- legs and handovers ---
test("a leg can run a sub-range or a plan backwards; ids, segments and the alignment follow that order", () => {
  const all = stations("a");
  const full = route({ legs: [leg("a"), leg("b")] }).legs[0];
  assert.deepEqual(full.stationIds, all);
  assert.equal(full.segmentIds.length, 2);
  const back = route({ legs: [leg("a", { fromStationId: all.at(-1), toStationId: all[0] }), leg("b")] }).legs[0];
  assert.deepEqual(back.stationIds, [...all].reverse());
  assert.deepEqual(back.segmentIds, [...full.segmentIds].reverse());
  assert.deepEqual(back.alignment, [...full.alignment].reverse());
  assert.equal(back.lengthMeters, full.lengthMeters);
  const part = route({ legs: [leg("a", { fromStationId: all[1], toStationId: all[2] }), leg("b")] }).legs[0];
  assert.deepEqual(part.stationIds, [all[1], all[2]]);
  assert.equal(part.segmentIds.length, 1);
  assert.ok(part.lengthMeters < full.lengthMeters && part.lengthMeters > 0);
  assert.equal(full.alignment[0].length, 2);
});

test("physicalConnection keeps true, false and null apart, each with the facts it rests on", () => {
  const shared = route({ legs: [leg("a"), leg("b")] }).handovers[0];
  assert.equal(shared.physicalConnection, true);
  assert.equal(shared.gapMeters, 0);
  assert.equal(shared.stationId, stations("a").at(-1));
  assert.equal(shared.stationId, stations("b")[0]);
  assert.deepEqual(shared.unknown, []);

  const apart = route({ legs: [leg("a"), leg("c")] });
  const h = apart.handovers[0];
  assert.equal(h.physicalConnection, false, "a boundary 10+ km apart is not connected");
  assert.ok(h.gapMeters > NEAR_ENDPOINT_METERS);
  assert.equal(h.stationId, null);
  assert.equal(h.location, null);
  assert.equal(h.fromStationId, stations("a").at(-1));
  assert.equal(h.toStationId, stations("c")[0]);
  assert.deepEqual(h.unknown, ["stationId", "location"], "false is a fact, so physicalConnection is not unknown");
  assert.equal(h.unknownReasons.stationId, "legs-end-at-different-stations");
  assert.ok(!apart.unknown.some((p) => p.endsWith(":physicalConnection")));

  const nearly = route({ legs: [leg("a"), leg("n")] });
  const n = nearly.handovers[0];
  assert.equal(n.physicalConnection, null, "a ~36 m gap is neither joined nor clearly apart");
  assert.ok(n.gapMeters > 0 && n.gapMeters <= NEAR_ENDPOINT_METERS);
  assert.equal(n.unknownReasons.physicalConnection, "endpoints-near-not-joined");
  assert.ok(nearly.unknown.some((p) => p.endsWith(":physicalConnection")));
  assert.equal(nearly.unknownReasons[nearly.unknown.find((p) => p.endsWith(":physicalConnection"))], "endpoints-near-not-joined");

  const toExternal = route({ legs: [leg("a"), EXT] }).handovers[0];
  assert.equal(toExternal.physicalConnection, null);
  assert.equal(toExternal.gapMeters, null);
  assert.equal(toExternal.unknownReasons.physicalConnection, "external-topology-not-in-source");
  assert.ok(toExternal.unknown.includes("physicalConnection") && toExternal.unknown.includes("gapMeters"));
});

test("an unconnected boundary is reported as a fact and the route is still built", () => {
  const out = route({ key: "gap", legs: [leg("a"), leg("c")] });
  assert.equal(out.handovers.length, 1);
  assert.equal(out.handovers[0].physicalConnection, false);
  assert.equal(out.legs.length, 2);
  assert.ok(out.totalLengthMeters > 0);
});

// --- owners and external networks ---
test("a missing owner stays null with a reason; an operator tag is never taken for an owner", () => {
  const planned = route({ legs: [leg("a"), leg("b")] });
  for (const l of planned.legs) {
    assert.equal(l.infrastructureOwnerId, null);
    assert.ok(l.unknown.includes("infrastructureOwnerId"));
    assert.equal(l.unknownReasons.infrastructureOwnerId, "owner-not-in-source-data");
  }
  const withExternal = route({ legs: [leg("a"), EXT] });
  assert.equal(withExternal.legs[1].infrastructureOwnerId, null, "line.operator is Operator X, which is an operator, not an owner");
  assert.ok(!JSON.stringify(withExternal).includes("Operator X"));
  const supplied = route({ legs: [leg("a", { infrastructureOwnerId: "player" }), leg("b", { infrastructureOwnerId: "player" })] });
  assert.equal(supplied.legs[0].infrastructureOwnerId, "player");
  assert.ok(!supplied.legs[0].unknown.includes("infrastructureOwnerId"));
});

test("an owner stated by the source data wins over the caller, and the conflict is reported", () => {
  const network = structuredClone(mapExport.externalNetworks[0]);
  network.lines[0].infrastructureOwnerId = "owner-from-source";
  const m = { plans: mapExport.plans, externalNetworks: [network] };
  const agreeing = route({ legs: [leg("a"), { ...EXT, infrastructureOwnerId: "owner-from-source" }] }, m);
  assert.equal(agreeing.legs[1].infrastructureOwnerId, "owner-from-source");
  assert.deepEqual(agreeing.warnings, []);
  const conflicting = route({ legs: [leg("a"), { ...EXT, infrastructureOwnerId: "someone-else" }] }, m);
  assert.equal(conflicting.legs[1].infrastructureOwnerId, "owner-from-source");
  assert.equal(conflicting.warnings[0].code, "owner-input-conflicts-source");
  assert.ok(!conflicting.legs[1].unknown.includes("infrastructureOwnerId"));
});

test("planned and external legs mix: the external leg keeps what the network data does not say as null", () => {
  const out = route({ key: "mix", legs: [leg("a"), EXT, leg("b")] });
  assert.deepEqual(out.legs.map((l) => l.sourceKind), ["planned", "external", "planned"]);
  const external = out.legs[1];
  assert.equal(external.externalNetworkId, "external:t");
  assert.equal(external.externalLineId, "ext-line:42");
  assert.equal(external.connectedPlanId, null);
  assert.equal(external.connectedProjectId, null);
  assert.deepEqual(external.stationIds, ["d1", "d2", "d3"]);
  assert.deepEqual(external.segmentIds, []);
  assert.equal(external.alignment, null);
  assert.equal(external.lengthMeters, null);
  assert.equal(external.unknownReasons.alignment, "external-location-basis:demand-node");
  assert.equal(external.unknownReasons.segmentIds, "external-network-has-no-segment-ids");
  assert.equal(out.totalLengthMeters, null);
  assert.equal(out.unknownReasons.totalLengthMeters, "leg-length-unknown");
  assert.equal(out.legs[0].externalNetworkId, null, "a planned leg has no external network");
  assert.equal(out.dataQuality, "low");
  assert.deepEqual(out.handovers.map((h) => h.physicalConnection), [null, null]);
  assert.ok(out.sourceLayers.some((l) => l.layer === "existing-network" && l.license === "CC0-1.0"));
  assert.deepEqual(out.sourceLayers.map((l) => l.layer).sort(), ["existing-network", "plan-geometry", "plan-geometry"], "only the sources these facts come from, not the plans' terrain or building layers");
  assert.equal(out.license.pack, "CC0-1.0");
  assert.deepEqual(out.license.attribution, ["test"]);
  for (const p of out.unknown) assert.ok(out.unknownReasons[p], p);
});

test("an existing (built) leg needs the opaque project id from the caller", () => {
  assert.equal(rejected({ legs: [leg("a", { sourceKind: "existing" }), leg("b")] }, "leg-project-missing").planId, planId("a"));
  const built = route({ legs: [leg("a", { sourceKind: "existing", projectId: "project:1", infrastructureOwnerId: "player" }), leg("b")] });
  assert.equal(built.legs[0].sourceKind, "existing");
  assert.equal(built.legs[0].connectedProjectId, "project:1");
  assert.equal(built.legs[0].connectedPlanId, planId("a"));
  assert.equal(built.legs[1].connectedProjectId, null);
  assert.equal(route({ legs: [leg("a", { projectId: "project:1" }), leg("b")] }).legs[0].connectedProjectId, "project:1");
});

// --- rejected input ---
test("input that cannot be resolved is rejected with a reason, never guessed", () => {
  assert.equal(rejected({ legs: [leg("a")] }, "route-too-short").name, null);
  rejected({ legs: [leg("a", { sequence: 0 }), leg("b")] }, "leg-sequence-mixed");
  rejected({ legs: [leg("a", { sequence: 0 }), leg("b", { sequence: 0 })] }, "leg-sequence-invalid");
  rejected({ legs: [leg("a", { sequence: 0.5 }), leg("b", { sequence: 1 })] }, "leg-sequence-invalid");
  rejected({ legs: [leg("a"), leg("a")] }, "duplicate-leg");
  rejected({ legs: [leg("a"), { sourceKind: "planned", planId: "plan:nope" }] }, "leg-plan-missing");
  rejected({ legs: [leg("a"), { sourceKind: "external", externalLineId: "ext-line:nope" }] }, "leg-external-line-missing");
  rejected({ legs: [leg("a", { fromStationId: "stn:nope" }), leg("b")] }, "leg-station-missing");
  rejected({ legs: [leg("a", { fromStationId: stations("a")[1], toStationId: stations("a")[1] }), leg("b")] }, "leg-degenerate");
  rejected({ legs: [leg("a"), { sourceKind: "bus", planId: planId("b") }] }, "leg-source-kind-invalid");
});

test("a plan exported for another pack is refused", () => {
  const otherPack = { manifest: { id: "other", version: "1" }, demand: pack.demand, existingNetwork: pack.existingNetwork };
  const otherExport = buildMapExport({ pack: otherPack, mode: "existing", drawnLines: [line("a", [139, 139.01, 139.02]), line("b", [139.02, 139.03])] });
  const otherPlan = (key) => stableId("plan", "other", "key", key);
  const out = build({ legs: [{ sourceKind: "planned", planId: otherPlan("a") }, { sourceKind: "planned", planId: otherPlan("b") }] }, otherExport);
  assert.equal(out.route, null);
  assert.equal(out.warnings[0].code, "leg-plan-other-pack");
  assert.equal(out.warnings[0].planPackId, "other");
});

// --- purity ---
test("building a route never changes the plans, networks, pack or drawn route it was given", () => {
  const frozenExport = deepFreeze(JSON.parse(JSON.stringify(mapExport)));
  const drawn = deepFreeze({ key: "frozen", name: "no mutation", legs: [leg("a", { sequence: 0 }), { ...EXT, sequence: 1 }, leg("b", { sequence: 2 })] });
  const out = buildThroughRouteExport({ pack: deepFreeze(structuredClone(pack)), mapExport: frozenExport, routes: [drawn] });
  assert.equal(out.routes.length, 1);
  const before = JSON.stringify(frozenExport);
  out.routes[0].legs[0].alignment[0][0] = 999;
  assert.equal(JSON.stringify(frozenExport), before, "the output does not alias the input");
});

test("the output has no management fields, and the module never imports the management engine", () => {
  const found = keysDeep(buildThroughRouteExport({
    pack, mapExport,
    routes: [{ key: "x", legs: [leg("a"), EXT, leg("b"), leg("c")] }, { legs: [leg("a"), leg("n")] }],
  }));
  for (const key of found) assert.ok(!FORBIDDEN.test(key), `unexpected management field ${key}`);
  assert.ok(found.has("physicalConnection") && found.has("unknownReasons") && found.has("sourceLayers") && found.has("license"));
  const source = fs.readFileSync(new URL("../src/map/through-route.mjs", import.meta.url), "utf8");
  assert.ok(!/from\s+["'][^"']*management/.test(source), "map layer imports nothing from management");
});

test("every required contract field is present on the route, its legs and its handovers", () => {
  const out = route({ key: "fields", name: "n", legs: [leg("a"), leg("b")] });
  for (const f of ["schema", "contractVersion", "throughRouteId", "key", "sourcePackId", "sourcePackVersion", "name", "legs", "handovers", "totalLengthMeters", "dataQuality", "unknown", "unknownReasons", "sourceLayers", "license"]) assert.ok(f in out, f);
  for (const f of ["legId", "sequence", "sourceKind", "connectedPlanId", "connectedProjectId", "externalNetworkId", "infrastructureOwnerId", "segmentIds", "stationIds", "alignment", "lengthMeters", "unknown", "unknownReasons"]) assert.ok(f in out.legs[0], f);
  for (const f of ["handoverId", "sequence", "stationId", "location", "fromLegId", "toLegId", "physicalConnection", "unknown", "unknownReasons"]) assert.ok(f in out.handovers[0], f);
  assert.equal(out.key, "fields");
  assert.equal(out.sourcePackId, "t");
  assert.equal(out.sourcePackVersion, "1");
  assert.ok(["high", "medium", "low"].includes(out.dataQuality));
  assert.notEqual(out.dataQuality, "high", "a route made of plans with unknown ground data is never high");
  assert.equal(out.handovers[0].fromLegId, out.legs[0].legId);
  assert.equal(out.handovers[0].toLegId, out.legs[1].legId);
});

// --- export and saved documents ---
test("the export sorts by id, reports rejected and duplicate routes, and is deterministic", () => {
  const routes = [{ key: "z", legs: [leg("a"), leg("b")] }, { key: "m", legs: [leg("a"), leg("c")] }, { key: "z", legs: [leg("a"), leg("b")] }, { key: "bad", legs: [leg("a")] }];
  const out = buildThroughRouteExport({ pack, mapExport, routes });
  assert.equal(out.schema, "transitline.through-route-export/1");
  assert.equal(out.routes.length, 2);
  assert.ok(out.routes[0].throughRouteId < out.routes[1].throughRouteId);
  assert.deepEqual(out.warnings.map((w) => w.code).sort(), ["duplicate-through-route", "through-route-rejected"]);
  assert.equal(JSON.stringify(out), JSON.stringify(buildThroughRouteExport({ pack, mapExport, routes: structuredClone(routes) })));
});

test("a saved document is never applied to the wrong pack, and pack changes are reported", () => {
  const doc = newThroughRouteDoc("t", "1");
  doc.routes.push({ key: "r1", name: "A to B", legs: [leg("a"), leg("b")] });
  const text = serializeThroughRouteDoc(doc);
  const exportOf = (d) => JSON.stringify(buildThroughRouteExport({ pack, mapExport, routes: d.routes }));
  const same = restoreThroughRouteDoc(text, pack);
  assert.deepEqual(same.warnings, []);
  assert.equal(exportOf(same.doc), exportOf(doc), "save and restore keeps every id and every computed value");
  const other = restoreThroughRouteDoc(text, { manifest: { id: "other", version: "1" } });
  assert.equal(other.warnings[0].code, "through-route-doc-other-pack");
  assert.equal(other.doc.routes.length, 0);
  assert.equal(other.doc.packId, "other");
  const newer = restoreThroughRouteDoc(text, { manifest: { id: "t", version: "2" } });
  assert.equal(newer.warnings[0].code, "pack-version-mismatch");
  assert.equal(newer.doc.routes.length, 1);
  assert.equal(restoreThroughRouteDoc("{not json", pack).warnings[0].code, "through-route-doc-unreadable");
  assert.equal(restoreThroughRouteDoc(JSON.stringify({ version: 99, routes: [] }), pack).warnings[0].code, "through-route-doc-version");
  assert.deepEqual(restoreThroughRouteDoc(null, pack).warnings, []);
});

// --- shipped examples (packs/<id>/through-route-examples), tied to that pack's plan-examples ---
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const readJson = (p) => JSON.parse(fs.readFileSync(path.join(root, p), "utf8"));
const listFiles = (id, kind, suffix) => fs.readdirSync(path.join(root, "packs", id, kind)).filter((f) => f.endsWith(suffix)).sort();
const loadExamples = (id) => {
  const manifest = readJson(`packs/${id}/manifest.json`);
  const demand = readJson(`packs/${id}/${manifest.files.demand}`);
  const existingNetwork = manifest.files.existingNetwork ? readJson(`packs/${id}/${manifest.files.existingNetwork}`) : null;
  return {
    manifest,
    pack: { manifest, demand, existingNetwork },
    plans: listFiles(id, "plan-examples", ".plan.json").map((f) => readJson(`packs/${id}/plan-examples/${f}`)),
    external: existingNetwork ? [existingNetworkToExternal({ manifest, demand, existingNetwork })] : [],
    routes: listFiles(id, "through-route-examples", ".through-route.json").map((f) => ({ file: f, route: readJson(`packs/${id}/through-route-examples/${f}`) })),
  };
};
const PACKS = ["tokyo", "example-radial", "example-corridor"];

test("the Tokyo pack and the synthetic packs ship through-route examples", () => {
  assert.ok(loadExamples("tokyo").routes.length >= 3);
  assert.ok(loadExamples("example-radial").routes.length >= 3);
  assert.ok(loadExamples("example-corridor").routes.length >= 1);
});

test("every example points at plans and lines that exist in the same pack, and keeps unknowns null with a reason", () => {
  for (const id of PACKS) {
    const { manifest, plans, external, routes } = loadExamples(id);
    for (const { file, route: r } of routes) {
      assert.equal(r.schema, THROUGH_ROUTE_SCHEMA, file);
      assert.equal(r.contractVersion, 1);
      assert.equal(r.sourcePackId, id);
      assert.equal(r.license.pack, manifest.data.license);
      assert.deepEqual(r.license.attribution, manifest.data.attribution ?? []);
      for (const layer of r.sourceLayers) assert.ok(["plan-geometry", "existing-network"].includes(layer.layer) && layer.name && layer.license, `${file}: ${layer.layer} needs a name and a license`);
      assert.ok(r.key, `${file}: examples are keyed`);
      assert.equal(r.throughRouteId, keyedThroughRouteId(id, r.key));
      assert.deepEqual(r.legs.map((l) => l.sequence), r.legs.map((_, i) => i));
      assert.equal(r.handovers.length, r.legs.length - 1);
      for (const l of r.legs) {
        if (l.sourceKind === "external") assert.ok(external.some((n) => n.id === l.externalNetworkId && n.lines.some((x) => x.id === l.externalLineId)), `${file}: external line`);
        else assert.ok(plans.some((p) => p.planId === l.connectedPlanId && l.segmentIds.every((s) => p.segments.some((x) => x.id === s))), `${file}: plan ${l.connectedPlanId}`);
        for (const f of l.unknown) {
          assert.ok(l[f] === null || (Array.isArray(l[f]) && l[f].length === 0), `${file}: ${f}`);
          assert.ok(l.unknownReasons[f], `${file}: reason for ${f}`);
        }
      }
      for (const h of r.handovers) {
        assert.ok([true, false, null].includes(h.physicalConnection));
        for (const f of h.unknown) {
          assert.equal(h[f], null, `${file}: ${f}`);
          assert.ok(h.unknownReasons[f], `${file}: reason for ${f}`);
        }
        if (h.physicalConnection === null) assert.ok(h.unknownReasons.physicalConnection, `${file}: null needs a reason`);
      }
      for (const p of r.unknown) assert.ok(r.unknownReasons[p], `${file}: ${p}`);
      for (const key of keysDeep(r)) assert.ok(!FORBIDDEN.test(key), `${file}: ${key}`);
    }
  }
});

test("the examples cover joined, separated and unknown boundaries, and planned/external mixes", () => {
  const all = PACKS.flatMap((id) => loadExamples(id).routes.map((e) => e.route));
  const connections = new Set(all.flatMap((r) => r.handovers.map((h) => h.physicalConnection)));
  assert.deepEqual([...connections].sort(), [false, null, true]);
  assert.ok(all.some((r) => r.legs.some((l) => l.sourceKind === "external") && r.legs.some((l) => l.sourceKind === "planned")));
  assert.ok(all.some((r) => r.legs.every((l) => l.infrastructureOwnerId === null)), "owner stays null when the source does not say");
});

test("examples regenerate byte-for-byte from their drawn routes", () => {
  for (const id of PACKS) {
    const { pack: examplePack, plans, external, routes } = loadExamples(id);
    for (const { file, route: stored } of routes) {
      const { source, ...body } = stored;
      const out = buildThroughRouteExport({ pack: examplePack, mapExport: { plans, externalNetworks: external }, routes: [source.drawnRoute] });
      assert.equal(JSON.stringify(out.routes[0]), JSON.stringify(body), `${id}/${file} is stale: run npm run through-route-examples`);
    }
  }
});
