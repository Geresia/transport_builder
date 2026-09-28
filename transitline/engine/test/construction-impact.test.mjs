import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildMapExport } from "../src/map/plan-geometry.mjs";
import { makeSpatialContext, polygonLayer, roadLayerFromGeojson } from "../src/map/spatial.mjs";
import { buildConstructionExport } from "../src/map/construction-site.mjs";
import { activePackages, addPackage, newConstructionDoc } from "../src/map/construction-editor.mjs";
import {
  buildConstructionImpact, buildConstructionImpactExport, CONSTRUCTION_IMPACT_EXPORT_SCHEMA, CONSTRUCTION_IMPACT_SCHEMA, EVENT_KINDS,
} from "../src/map/construction-impact.mjs";
import {
  clearResponse, newImpactResponseDoc, responseFor, restoreImpactResponseDoc, serializeImpactResponseDoc, setCustomAffectedPolygon, setResponseCandidate,
} from "../src/map/construction-impact-editor.mjs";
import { buildImpactDetailView, buildImpactMarkerViews, drawImpactDetail, drawImpactMarkers, renderImpactPanel, STATUS_STYLE } from "../src/map/construction-impact-view.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const readJson = (p) => JSON.parse(fs.readFileSync(path.join(root, p), "utf8"));

// --- fixtures: a four-station line (shield / cut-cover / elevated), a real building near it, roads, no water ---
const pack = {
  manifest: { id: "t", version: "1", data: { license: "CC0-1.0", attribution: [] } },
  demand: { points: [{ id: "d0", name: "d0", location: [139, 35] }, { id: "d1", name: "d1", location: [139.01, 35] }, { id: "d2", name: "d2", location: [139.02, 35] }, { id: "d3", name: "d3", location: [139.03, 35] }] },
};
const line = {
  key: "main", name: "Main", legs: [{ structureHint: "shield" }, { structureHint: "cut-cover" }, { structureHint: "elevated" }],
  vertices: [139, 139.01, 139.02, 139.03].map((lon) => ({ location: [lon, 35], platformType: "side" })),
};
const dem = { elevationAt: () => 12, slopeAt: () => 1, quality: "medium", source: { name: "test dem", license: "CC0-1.0" } };
const mapExport = buildMapExport({ pack, mode: "scratch", drawnLines: [line], spatial: makeSpatialContext({ dem }) });
const plan = mapExport.plans[0];
const [seg0, seg1, seg2] = plan.segments;
const roads = roadLayerFromGeojson({ features: [
  { geometry: { coordinates: [[139, 34.9993], [139.03, 34.9993]] }, properties: { roadClass: "major" } },
  { geometry: { coordinates: [[139, 35.0006], [139.03, 35.0006]] }, properties: { roadClass: "minor" } },
] }, { quality: "high", source: { name: "test roads", license: "CC0-1.0" } });
const sq = (lon, lat, d = 0.0005) => [[[lon, lat], [lon + d, lat], [lon + d, lat + d], [lon, lat + d], [lon, lat]]];
const buildings = polygonLayer([{ rings: sq(139.0098, 34.9998), kind: "house" }], { quality: "high", source: { name: "b", license: "CC0-1.0" } });
const spatial = makeSpatialContext({ dem, roads, buildings });

const doc = newConstructionDoc("t", "1");
addPackage(doc, { key: "tun", kind: "tunnel", planId: plan.planId, segmentIds: [seg0.id] });
addPackage(doc, { key: "cc", kind: "cutCover", planId: plan.planId, segmentIds: [seg1.id] });
addPackage(doc, { key: "vi", kind: "viaduct", planId: plan.planId, segmentIds: [seg2.id] });
const exp = buildConstructionExport({ pack, mapExport, packages: activePackages(doc), spatial });
const tunnel = exp.sites.find((s) => s.kind === "tunnel");
const cutCover = exp.sites.find((s) => s.kind === "cutCover");
const viaduct = exp.sites.find((s) => s.kind === "viaduct");

const ctxWith = (constructionExport = exp, sp = spatial) => ({ pack, spatial: sp, constructionExport });
const build = (drawn, constructionExport = exp, sp = spatial) => buildConstructionImpact(drawn, ctxWith(constructionExport, sp));
const incident = (extra = {}) => ({ eventId: "ev-incident-1", eventKind: "incident", constructionSiteId: tunnel.constructionSiteId, candidateRef: { kind: "shaft", id: tunnel.shaftCandidates[0].shaftId }, ...extra });

// --- identity ---
test("same input gives byte-identical output, keyed only by the engine's own eventId", () => {
  assert.equal(JSON.stringify(build(incident()).impact), JSON.stringify(build(structuredClone(incident())).impact));
  assert.equal(build(incident()).impact.schema, CONSTRUCTION_IMPACT_SCHEMA);
  assert.equal(build(incident()).impact.eventId, "ev-incident-1");
  assert.equal(build(incident({ eventId: "different" })).impact.eventId, "different", "the id is exactly the engine's eventId — nothing derived");
});

// --- contract ---
test("the output has exactly the fields the contract names", () => {
  const out = build(incident()).impact;
  const expected = ["schema", "contractVersion", "eventId", "constructionSiteId", "eventKind", "eventLocation", "affectedPolygon", "spatialFacts", "linkedCandidateIds", "alternativeCandidates", "selectedResponseCandidateId", "dataQuality", "unknown", "unknownReasons"];
  for (const k of expected) assert.ok(k in out, `missing ${k}`);
  assert.equal(out.contractVersion, 1);
  assert.equal(out.constructionSiteId, tunnel.constructionSiteId);
  assert.equal(EVENT_KINDS.length, 7);
});

const forbidden = /probability|severity|cost|price|delay|duration|reputation|score|liab|compensat|competitiv|bid|award|budget|fare|cash|ledger|profit|revenue/i;
function keysOf(value, out = new Set()) {
  if (Array.isArray(value)) value.forEach((v) => keysOf(v, out));
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) { out.add(k); keysOf(v, out); }
  return out;
}
test("the contract has no probability, severity, cost, delay or reputation fields", () => {
  const out = build(incident()).impact;
  for (const k of keysOf(out)) assert.doesNotMatch(k, forbidden, `field ${k}`);
});

test("the map never decides that an incident or complaint occurred: it only describes an event the engine already named", () => {
  const missingKind = buildConstructionImpact({ eventId: "x", constructionSiteId: tunnel.constructionSiteId }, ctxWith());
  assert.equal(missingKind.impact, null);
  assert.equal(missingKind.warnings[0].code, "event-kind-invalid");
  const missingId = buildConstructionImpact({ eventKind: "incident", constructionSiteId: tunnel.constructionSiteId }, ctxWith());
  assert.equal(missingId.impact, null);
  assert.equal(missingId.warnings[0].code, "impact-no-event-id");
  const missingSite = buildConstructionImpact({ eventId: "x", eventKind: "incident", constructionSiteId: "cons:nope" }, ctxWith());
  assert.equal(missingSite.impact, null);
  assert.equal(missingSite.warnings[0].code, "connection-construction-site-missing");
});

// --- missing data: null + unknown[] + reason, never 0 ---
test("with no location and no candidate reference, eventLocation and everything derived from it are null with a reason", () => {
  const out = build({ eventId: "ev", eventKind: "material-shortage", constructionSiteId: tunnel.constructionSiteId }).impact;
  for (const f of ["eventLocation", "affectedPolygon"]) { assert.equal(out[f], null, f); assert.ok(out.unknown.includes(f)); }
  assert.equal(out.unknownReasons.eventLocation, "no-event-location");
  assert.deepEqual(out.linkedCandidateIds, []);
  assert.deepEqual(out.alternativeCandidates, []);
  assert.ok(out.unknown.includes("alternativeCandidates"));
});

test("with no spatial layers the affected-area facts are null with a reason, and nothing is filled with 0", () => {
  const out = build(incident(), exp, makeSpatialContext()).impact;
  for (const f of ["intersectedBuildingCount", "waterOverlapCount", "roadsOccupied", "existingRailwayOverlapCount"]) {
    assert.equal(out.spatialFacts[f], null, f);
    assert.ok(out.unknown.includes(f), `${f} listed as unknown`);
  }
  assert.equal(out.unknownReasons.intersectedBuildingCount, "no-layer");
});

test("a layer that covers the area and finds nothing gives a real 0, not an unknown", () => {
  const empty = polygonLayer([], { quality: "high", source: { name: "empty", license: "CC0-1.0" } });
  const out = build(incident(), exp, makeSpatialContext({ dem, roads, buildings: empty })).impact;
  assert.equal(out.spatialFacts.intersectedBuildingCount, 0);
  assert.ok(!out.unknown.includes("intersectedBuildingCount"));
});

test("permit-delay has no physical response candidate and uses the whole package as its affected area", () => {
  const out = build({ eventId: "ev-permit", eventKind: "permit-delay", constructionSiteId: cutCover.constructionSiteId }).impact;
  assert.equal(out.eventLocation, null, "an administrative hold has no point location");
  assert.deepEqual(out.affectedPolygon, cutCover.polygon);
  assert.deepEqual(out.alternativeCandidates, [], "nothing to swap for a paperwork hold");
});

// --- the 8 required scenarios ---
test("scenario: a tunnel incident linked to a shaft, with access-point alternatives", () => {
  const out = build(incident()).impact;
  assert.deepEqual(out.eventLocation, tunnel.shaftCandidates[0].location);
  assert.ok(out.linkedCandidateIds.some((c) => c.kind === "shaft" && c.id === tunnel.shaftCandidates[0].shaftId));
  assert.ok(out.alternativeCandidates.some((c) => ["accessRoad", "vehicleAccess", "workArea"].includes(c.kind)));
});

test("scenario: an elevated-viaduct complaint reports residential distance and building overlap", () => {
  const near1 = viaduct.workAreaCandidates[0].polygon[0];
  const out = build({ eventId: "ev-complaint", eventKind: "complaint", constructionSiteId: viaduct.constructionSiteId, location: near1 }).impact;
  assert.equal(out.eventKind, "complaint");
  assert.ok(out.spatialFacts.distanceToResidentialMeters !== undefined);
  assert.ok(out.affectedPolygon.length >= 3);
});

test("scenario: a cut-and-cover access-blocked event reports whether a major road is reachable", () => {
  const ra = cutCover.accessRoadCandidates[0];
  assert.ok(ra, "fixture needs at least one road-access candidate");
  const out = build({ eventId: "ev-access", eventKind: "access-blocked", constructionSiteId: cutCover.constructionSiteId, candidateRef: { kind: "accessRoad", id: ra.roadAccessId } }).impact;
  assert.equal(out.spatialFacts.majorRoadAccessible, true);
  assert.ok(out.linkedCandidateIds.some((c) => c.kind === "accessRoad" && c.id === ra.roadAccessId));
});

test("scenario: a material yard becomes unusable and the player switches to an alternative", () => {
  const yard = tunnel.materialYardCandidates[0];
  const out = build({ eventId: "ev-shortage", eventKind: "material-shortage", constructionSiteId: tunnel.constructionSiteId, candidateRef: { kind: "materialYard", id: yard.materialYardId } }).impact;
  assert.deepEqual(out.affectedPolygon, yard.polygon, "the affected area is the yard's own footprint");
  const alt = out.alternativeCandidates.find((c) => c.kind === "materialYard");
  assert.ok(alt, "another material yard is offered as an alternative");
  const withResponse = build({ eventId: "ev-shortage", eventKind: "material-shortage", constructionSiteId: tunnel.constructionSiteId, candidateRef: { kind: "materialYard", id: yard.materialYardId }, selectedResponseCandidateId: alt.id }).impact;
  assert.equal(withResponse.selectedResponseCandidateId, alt.id);
});

test("scenario: a utility conflict at a work area", () => {
  const wa = cutCover.workAreaCandidates[0];
  const out = build({ eventId: "ev-utility", eventKind: "utility-conflict", constructionSiteId: cutCover.constructionSiteId, candidateRef: { kind: "workArea", id: wa.workAreaId } }).impact;
  assert.deepEqual(out.affectedPolygon, wa.polygon);
  assert.ok(out.linkedCandidateIds.some((c) => c.kind === "workArea" && c.id === wa.workAreaId));
});

test("scenario: unexpected ground conditions at a tunnel shaft", () => {
  const shaft = tunnel.shaftCandidates[1];
  const out = build({ eventId: "ev-ground", eventKind: "unexpected-ground", constructionSiteId: tunnel.constructionSiteId, candidateRef: { kind: "shaft", id: shaft.shaftId } }).impact;
  assert.deepEqual(out.eventLocation, shaft.location);
  assert.ok(out.affectedPolygon.length >= 3, "a circle around the shaft, since a point candidate has no polygon of its own");
});

test("scenario: a material shortage with an unknown location still names the site and kind", () => {
  const out = build({ eventId: "ev-unknown-loc", eventKind: "material-shortage", constructionSiteId: tunnel.constructionSiteId }).impact;
  assert.equal(out.eventLocation, null);
  assert.equal(out.constructionSiteId, tunnel.constructionSiteId);
  assert.equal(out.eventKind, "material-shortage");
  assert.ok(out.unknown.includes("eventLocation"));
});

test("scenario: some spatial layers are missing entirely (no roads, no buildings)", () => {
  const out = build(incident(), exp, makeSpatialContext({ dem })).impact;
  assert.equal(out.spatialFacts.intersectedBuildingCount, null);
  assert.equal(out.unknownReasons.intersectedBuildingCount, "no-layer");
  assert.equal(out.spatialFacts.nearestMajorRoad, null);
  assert.equal(out.unknownReasons.nearestMajorRoad, "no-layer");
});

// --- response editor: save and reopen keeps the same id (the event's own id) and the same choice ---
test("a response is kept under the event's own id and survives save and reopen", () => {
  const rdoc = newImpactResponseDoc("t", "1");
  const yard = tunnel.materialYardCandidates[1];
  setResponseCandidate(rdoc, "ev-shortage", yard.materialYardId);
  setCustomAffectedPolygon(rdoc, "ev-other", [[139, 35], [139.001, 35], [139.001, 35.001]]);
  assert.equal(responseFor(rdoc, "ev-shortage").selectedResponseCandidateId, yard.materialYardId);
  const restored = restoreImpactResponseDoc(serializeImpactResponseDoc(rdoc), pack);
  assert.deepEqual(restored.warnings, []);
  assert.equal(responseFor(restored.doc, "ev-shortage").selectedResponseCandidateId, yard.materialYardId);
  assert.equal(responseFor(restored.doc, "ev-other").customAffectedPolygon.length, 3);
  const built = build({ eventId: "ev-shortage", eventKind: "material-shortage", constructionSiteId: tunnel.constructionSiteId, candidateRef: { kind: "materialYard", id: tunnel.materialYardCandidates[0].materialYardId }, selectedResponseCandidateId: responseFor(restored.doc, "ev-shortage").selectedResponseCandidateId }).impact;
  assert.equal(built.selectedResponseCandidateId, yard.materialYardId);
  clearResponse(rdoc, "ev-shortage");
  assert.equal(responseFor(rdoc, "ev-shortage"), null);
});

test("a saved response document is not applied to another pack, and a pack version change is reported", () => {
  const rdoc = newImpactResponseDoc("t", "1");
  setResponseCandidate(rdoc, "ev-x", "shaft:whatever");
  const text = serializeImpactResponseDoc(rdoc);
  assert.equal(restoreImpactResponseDoc(text, { manifest: { id: "elsewhere", version: "1" } }).warnings[0].code, "impact-response-doc-other-pack");
  assert.equal(restoreImpactResponseDoc(text, { manifest: { id: "t", version: "2" } }).warnings[0].code, "pack-version-mismatch");
  assert.equal(restoreImpactResponseDoc("{not json", pack).warnings[0].code, "impact-response-doc-unreadable");
  assert.equal(restoreImpactResponseDoc(null, pack).doc.entries.length, 0);
});

test("an unresolvable selected response is dropped with a warning, not silently accepted", () => {
  const r = build({ ...incident(), selectedResponseCandidateId: "shaft:not-a-real-candidate" });
  assert.equal(r.impact.selectedResponseCandidateId, null);
  assert.ok(r.warnings.some((w) => w.code === "selected-response-candidate-missing"));
});

test("a custom affected polygon overrides the computed one", () => {
  const custom = [[139, 34.999], [139.001, 34.999], [139.001, 35], [139, 35]];
  const out = build({ ...incident(), customAffectedPolygon: custom }).impact;
  assert.deepEqual(out.affectedPolygon, custom.map(([lon, lat]) => [Math.round(lon * 1e6) / 1e6, Math.round(lat * 1e6) / 1e6]));
});

// --- batch export ---
test("an export never repeats an event id, and reports one with no resolvable geometry", () => {
  const batch = buildConstructionImpactExport({ pack, constructionExport: exp, spatial, events: [incident(), incident(), { eventId: "bad", eventKind: "incident", constructionSiteId: "cons:nope" }] });
  assert.equal(batch.schema, CONSTRUCTION_IMPACT_EXPORT_SCHEMA);
  assert.equal(batch.impacts.length, 1);
  assert.deepEqual(batch.warnings.map((w) => w.code), ["duplicate-construction-impact", "impact-no-geometry", "connection-construction-site-missing"]);
});

test("the batch export regenerates byte-for-byte from the same events", () => {
  const events = [incident(), { eventId: "ev-complaint", eventKind: "complaint", constructionSiteId: viaduct.constructionSiteId, location: [139.021, 35.0002] }];
  const a = buildConstructionImpactExport({ pack, constructionExport: exp, spatial, events });
  const b = buildConstructionImpactExport({ pack, constructionExport: exp, spatial, events: structuredClone(events) });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

// --- display: markers, status, locationUnknown, selection, read-only ---
test("markers are shown per event kind and status; a location-less event falls back to its package centre with locationUnknown", () => {
  const report = { constructionMarkers: [
    { eventId: "m1", kind: "incident", constructionSiteId: tunnel.constructionSiteId, status: "unresolved", location: [139.002, 35] },
    { eventId: "m2", kind: "material-shortage", constructionSiteId: cutCover.constructionSiteId, status: "responding" },
    { eventId: "m3", kind: "complaint", constructionSiteId: viaduct.constructionSiteId },
  ] };
  const views = buildImpactMarkerViews(report, exp);
  assert.equal(views.length, 3);
  assert.equal(views[0].locationUnknown, false);
  assert.deepEqual(views[0].location, [139.002, 35]);
  assert.equal(views[1].locationUnknown, true, "no location on the marker");
  assert.ok(views[1].location, "falls back to the package's own centre");
  assert.equal(views[1].statusStyle.label, STATUS_STYLE.responding.label);
  assert.equal(views[2].status, null, "an unreported status is not guessed");
  assert.notEqual(views[0].style.color, views[1].style.color, "different kinds get different markers");
});

test("the detail view distinguishes linked from alternative candidates and marks the selected response", () => {
  const yard = tunnel.materialYardCandidates[0];
  const alt = tunnel.materialYardCandidates[1];
  const impact = build({ eventId: "ev-shortage", eventKind: "material-shortage", constructionSiteId: tunnel.constructionSiteId, candidateRef: { kind: "materialYard", id: yard.materialYardId }, selectedResponseCandidateId: alt.materialYardId }).impact;
  const view = buildImpactDetailView(impact, exp);
  assert.equal(view.active, true);
  assert.deepEqual(view.linkedPackagePolygon, tunnel.polygon);
  assert.ok(view.linkedCandidates.some((c) => c.id === yard.materialYardId && !c.selected));
  assert.ok(view.alternativeCandidates.some((c) => c.id === alt.materialYardId && c.selected));
  assert.equal(buildImpactDetailView(null, exp).active, false);
});

function deepFreeze(o) { if (o && typeof o === "object" && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; }
const recorder = () => {
  const calls = [];
  const ctx = new Proxy({}, { get: (t, k) => (k in t ? t[k] : k === "measureText" ? () => ({ width: 50 }) : (...args) => calls.push([k, ...args])), set: (t, k, v) => { t[k] = v; calls.push(["set", k, v]); return true; } });
  return { calls, ctx };
};
const fakeBox = () => { const d = { createElement: (tag) => ({ tag, children: [], style: {}, className: "", textContent: "", hidden: false, ownerDocument: d, append(...c) { this.children.push(...c); }, replaceChildren(...c) { this.children = c; } }) }; return d.createElement("div"); };

test("the view and drawing only read a frozen report, export and impact", () => {
  const frozenExp = deepFreeze(structuredClone(exp));
  const report = deepFreeze({ constructionMarkers: [{ eventId: "m1", kind: "incident", constructionSiteId: tunnel.constructionSiteId, status: "unresolved", location: [139.002, 35] }] });
  const beforeExp = JSON.stringify(frozenExp);
  const beforeReport = JSON.stringify(report);
  const views = buildImpactMarkerViews(report, frozenExp);
  const impact = deepFreeze(build(incident(), exp, spatial).impact);
  const detail = buildImpactDetailView(impact, frozenExp);
  const screen = ([lon, lat]) => [(lon - 139) * 1e5, -(lat - 35) * 1e5];
  drawImpactMarkers(recorder().ctx, views, screen, "m1");
  drawImpactDetail(recorder().ctx, detail, screen);
  renderImpactPanel(fakeBox(), views, detail);
  assert.equal(JSON.stringify(frozenExp), beforeExp);
  assert.equal(JSON.stringify(report), beforeReport);
});

test("markers draw nothing when the report has none, and the selected marker draws larger", () => {
  const r1 = recorder();
  drawImpactMarkers(r1.ctx, [], () => [0, 0]);
  assert.deepEqual(r1.calls, [["save"], ["restore"]], "no marker is drawn, but the canvas state is still balanced");
  const mv = buildImpactMarkerViews({ constructionMarkers: [{ eventId: "m1", kind: "incident", constructionSiteId: tunnel.constructionSiteId, location: [139.002, 35] }] }, exp);
  const r2 = recorder();
  drawImpactMarkers(r2.ctx, mv, ([lon, lat]) => [(lon - 139) * 1e5, -(lat - 35) * 1e5], "m1");
  assert.ok(r2.calls.some((c) => c[0] === "scale"), "the selected marker is drawn scaled up");
});

// --- shipped examples (packs/<id>/construction-impact-examples), tied to construction-site examples ---
const impactFiles = (id) => fs.readdirSync(path.join(root, "packs", id, "construction-impact-examples")).filter((f) => f.endsWith(".construction-impact.json")).sort();
const loadImpactExamples = (id) => ({
  manifest: readJson(`packs/${id}/manifest.json`),
  sites: fs.readdirSync(path.join(root, "packs", id, "construction-examples")).filter((f) => f.endsWith(".construction.json")).sort().map((f) => readJson(`packs/${id}/construction-examples/${f}`)),
  impacts: impactFiles(id).map((f) => ({ file: f, impact: readJson(`packs/${id}/construction-impact-examples/${f}`) })),
});
const IDS = ["tokyo", "example-radial", "example-corridor"];

test("each pack ships at least the 8 required named event scenarios", () => {
  for (const id of IDS) {
    const { impacts } = loadImpactExamples(id);
    assert.ok(impacts.length >= 8, `${id}: only ${impacts.length}`);
    const kinds = new Set(impacts.map((x) => x.impact.eventKind));
    for (const k of ["incident", "complaint", "access-blocked", "material-shortage", "utility-conflict", "unexpected-ground"]) assert.ok(kinds.has(k), `${id}: missing ${k}`);
    assert.ok(impacts.some((x) => x.impact.eventLocation === null), `${id}: a location-unknown scenario`);
    assert.ok(impacts.some((x) => x.impact.unknown.length >= 4), `${id}: a missing-layers scenario`);
    assert.ok(impacts.some((x) => x.impact.alternativeCandidates.length >= 2), `${id}: an alternative-candidate scenario`);
  }
});

test("every shipped event connects to a real construction site from the same pack", () => {
  for (const id of IDS) {
    const { sites, impacts } = loadImpactExamples(id);
    for (const { file, impact } of impacts) assert.ok(sites.some((s) => s.constructionSiteId === impact.constructionSiteId), `${id}/${file}: site ${impact.constructionSiteId}`);
  }
});

test("shipped events keep unknowns null with a reason, carry the pack license, and have no cost or score fields", () => {
  for (const id of IDS) {
    const { manifest, impacts } = loadImpactExamples(id);
    for (const { file, impact } of impacts) {
      assert.equal(impact.schema, CONSTRUCTION_IMPACT_SCHEMA);
      assert.equal(impact.license.pack, manifest.data.license, `${id}/${file}`);
      for (const f of impact.unknown) assert.ok(impact.unknownReasons[f], `${id}/${file}: ${f} needs a reason`);
      for (const k of keysOf(impact)) assert.doesNotMatch(k, forbidden, `${id}/${file}: field ${k}`);
    }
  }
});

test("shipped events regenerate byte-for-byte from their saved event and layers", async () => {
  const { syntheticLayers } = await import("../../scripts/lib/synthetic-layers.mjs");
  for (const id of ["example-radial", "example-corridor"]) {
    const { manifest, sites, impacts } = loadImpactExamples(id);
    const p = { manifest };
    const constructionExport = { sites };
    for (const { file, impact: saved } of impacts) {
      const { source: src, ...body } = saved;
      const layers = src.layers.kind === "synthetic-layers" ? syntheticLayers(src.layers.centre, src.layers.options) : {};
      const fresh = buildConstructionImpact(src.drawnEvent, { pack: p, spatial: makeSpatialContext(layers), constructionExport }).impact;
      assert.equal(JSON.stringify(fresh), JSON.stringify(body), `${id}/${file} is stale: run npm run construction-impact-examples`);
    }
  }
});

// --- boundary: never touches the management engine, cash, or the file system ---
test("construction-impact modules do not import the management engine or touch cash, construction state or files", () => {
  for (const f of ["construction-impact.mjs", "construction-impact-editor.mjs", "construction-impact-view.mjs", "construction-impact-ui.mjs"]) {
    const src = fs.readFileSync(path.join(root, "engine/src/map", f), "utf8");
    for (const m of src.matchAll(/from "([^"]+)"/g)) assert.match(m[1], /^\.\/[a-z-]+\.mjs$|^\.\.\/(projection|geometry)\.mjs$/, `${f} imports ${m[1]}`);
    assert.doesNotMatch(src, /ledger|\.commit\(|\.settle\(|\.post\(|node:fs/, `${f} must not reach engine state or the file system`);
    assert.ok(src.length < 40_000, `${f} holds code, not data`);
  }
});
