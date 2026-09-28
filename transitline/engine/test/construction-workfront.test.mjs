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
  buildConstructionWorkfront, buildConstructionWorkfrontExport, CONSTRUCTION_WORKFRONT_EXPORT_SCHEMA, CONSTRUCTION_WORKFRONT_SCHEMA, WORKFRONT_CANDIDATE_KINDS, workfrontIdFor,
} from "../src/map/construction-workfront.mjs";
import {
  addWorkfront, newWorkfrontDoc, removeWorkfront, restoreWorkfrontDoc, serializeWorkfrontDoc, setAccessCandidate, setAssemblyPolygon, setStoragePolygon, workfrontFor, workfrontsForSite,
} from "../src/map/construction-workfront-editor.mjs";
import {
  buildEquipmentReportView, buildWorkfrontDetailView, buildWorkfrontMarkerViews, drawWorkfrontDetail, drawWorkfrontMarkers, KIND_STYLE, renderWorkfrontPanel,
} from "../src/map/construction-workfront-view.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const readJson = (p) => JSON.parse(fs.readFileSync(path.join(root, p), "utf8"));

// --- fixtures: a three-station line (shield tunnel, cut-cover, elevated), a nearby building, a road ---
const pack = {
  manifest: { id: "t", version: "1", data: { license: "CC0-1.0", attribution: [] } },
  demand: { points: [{ id: "d0", name: "d0", location: [139, 35] }, { id: "d1", name: "d1", location: [139.01, 35] }, { id: "d2", name: "d2", location: [139.02, 35] }] },
};
const line = {
  key: "main", name: "Main", legs: [{ structureHint: "shield" }, { structureHint: "cut-cover" }],
  vertices: [139, 139.01, 139.02].map((lon) => ({ location: [lon, 35], platformType: "side" })),
};
const dem = { elevationAt: () => 12, slopeAt: () => 1, quality: "medium", source: { name: "test dem", license: "CC0-1.0" } };
const mapExport = buildMapExport({ pack, mode: "scratch", drawnLines: [line], spatial: makeSpatialContext({ dem }) });
const plan = mapExport.plans[0];
const [seg0, seg1] = plan.segments;
const roads = roadLayerFromGeojson({ features: [
  { geometry: { coordinates: [[139, 34.9993], [139.02, 34.9993]] }, properties: { roadClass: "major" } },
] }, { quality: "high", source: { name: "test roads", license: "CC0-1.0" } });
const sq = (lon, lat, d = 0.0005) => [[[lon, lat], [lon + d, lat], [lon + d, lat + d], [lon, lat + d], [lon, lat]]];
const buildings = polygonLayer([{ rings: sq(139.0048, 34.9998), kind: "house" }], { quality: "high", source: { name: "b", license: "CC0-1.0" } });
const spatial = makeSpatialContext({ dem, roads, buildings });

const doc = newConstructionDoc("t", "1");
addPackage(doc, { key: "tun", kind: "tunnel", planId: plan.planId, segmentIds: [seg0.id] });
addPackage(doc, { key: "cc", kind: "cutCover", planId: plan.planId, segmentIds: [seg1.id] });
const exp = buildConstructionExport({ pack, mapExport, packages: activePackages(doc), spatial });
const tunnel = exp.sites.find((s) => s.kind === "tunnel");
const cutCover = exp.sites.find((s) => s.kind === "cutCover");

const ctxWith = (constructionExport = exp, sp = spatial) => ({ pack, spatial: sp, constructionExport });
const build = (drawn, constructionExport = exp, sp = spatial) => buildConstructionWorkfront(drawn, ctxWith(constructionExport, sp));
const shaftDrawn = (extra = {}) => ({ constructionSiteId: tunnel.constructionSiteId, candidateRef: { kind: "shaft", id: tunnel.shaftCandidates[0].shaftId }, ...extra });
const workAreaDrawn = (extra = {}) => ({ constructionSiteId: cutCover.constructionSiteId, candidateRef: { kind: "workArea", id: cutCover.workAreaCandidates[0].workAreaId }, ...extra });

// --- identity ---
test("the same input gives byte-identical output, and the id is deterministic from (site, candidate)", () => {
  assert.equal(JSON.stringify(build(shaftDrawn()).workfront), JSON.stringify(build(structuredClone(shaftDrawn())).workfront));
  const w = build(shaftDrawn()).workfront;
  assert.equal(w.workfrontId, workfrontIdFor(tunnel.constructionSiteId, { kind: "shaft", id: tunnel.shaftCandidates[0].shaftId }));
  assert.equal(w.schema, CONSTRUCTION_WORKFRONT_SCHEMA);
  assert.equal(WORKFRONT_CANDIDATE_KINDS.length, 2);
});

// --- contract ---
test("the output has exactly the fields the contract names", () => {
  const w = build(shaftDrawn()).workfront;
  const expected = [
    "workfrontId", "constructionSiteId", "connectedPlanId", "candidateRef", "polygon", "location",
    "usableAreaSquareMeters", "minimumWidthMeters", "minimumLengthMeters", "averageSlopePercent", "maximumSlopePercent",
    "nearestMajorRoad", "majorRoadAccessible", "intersectedBuildingCount", "waterOverlapCount", "existingRailwayOverlapCount",
    "distanceToResidentialMeters", "linkedShaftId", "linkedWorkAreaId", "linkedMaterialYardId",
    "equipmentAccessFacts", "stagingFacts", "spatialFlags", "dataQuality", "unknown", "unknownReasons",
  ];
  for (const k of expected) assert.ok(k in w, `missing ${k}`);
  for (const k of ["entryWidthMeters", "turningSpaceSquareMeters", "overheadClearanceMeters", "roadWidthMeters"]) assert.ok(k in w.equipmentAccessFacts, k);
  for (const k of ["assemblyAreaSquareMeters", "storageAreaSquareMeters", "spoilRemovalAccess", "deliveryAccess"]) assert.ok(k in w.stagingFacts, k);
  assert.equal(w.contractVersion, 1);
  assert.equal(w.connectedPlanId, plan.planId);
});

const forbidden = /probability|severity|\bcost\b|price|delay|duration|reputation|score|liab|compensat|competitiv|\bbid\b|award|budget|fare|cash|ledger|profit|revenue|contractor|feasib/i;
function keysOf(value, out = new Set()) {
  if (Array.isArray(value)) value.forEach((v) => keysOf(v, out));
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) { out.add(k); keysOf(v, out); }
  return out;
}
test("the contract has no cost, bid, duration, contractor or feasibility-verdict fields", () => {
  const w = build(shaftDrawn()).workfront;
  for (const k of keysOf(w)) assert.doesNotMatch(k, forbidden, `field ${k}`);
});

test("only shaft and work-area candidates can be a work front; other candidate kinds are rejected", () => {
  const bad = build({ constructionSiteId: tunnel.constructionSiteId, candidateRef: { kind: "materialYard", id: "x" } });
  assert.equal(bad.workfront, null);
  assert.equal(bad.warnings[0].code, "workfront-candidate-kind-invalid");
  const missingSite = build({ constructionSiteId: "cons:nope", candidateRef: { kind: "shaft", id: "x" } });
  assert.equal(missingSite.workfront, null);
  assert.equal(missingSite.warnings[0].code, "connection-construction-site-missing");
  const missingCandidate = build({ constructionSiteId: tunnel.constructionSiteId, candidateRef: { kind: "shaft", id: "nope" } });
  assert.equal(missingCandidate.workfront, null);
  assert.equal(missingCandidate.warnings[0].code, "linked-candidate-missing");
});

// --- missing data: null + unknown[] + reason, never 0 ---
test("with no spatial layers every layer-dependent fact is null with a reason, never 0", () => {
  const w = build(shaftDrawn(), exp, makeSpatialContext()).workfront;
  for (const f of ["averageSlopePercent", "maximumSlopePercent", "intersectedBuildingCount", "waterOverlapCount", "nearestMajorRoad", "majorRoadAccessible"]) {
    assert.equal(w[f], null, f);
    assert.ok(w.unknown.includes(f), `${f} listed as unknown`);
  }
  assert.equal(w.equipmentAccessFacts.roadWidthMeters, null);
  assert.equal(w.unknownReasons.roadWidthMeters, "no-layer");
  assert.equal(w.equipmentAccessFacts.overheadClearanceMeters, null);
  assert.equal(w.unknownReasons.overheadClearanceMeters, "no-layer");
});

test("a layer that covers the area and finds nothing gives a real 0, not an unknown", () => {
  const empty = polygonLayer([], { quality: "high", source: { name: "empty", license: "CC0-1.0" } });
  const w = build(shaftDrawn(), exp, makeSpatialContext({ dem, roads, buildings: empty })).workfront;
  assert.equal(w.intersectedBuildingCount, 0);
  assert.ok(!w.unknown.includes("intersectedBuildingCount"));
});

test("roadWidthMeters is always unknown, with a different reason when the layer exists but lacks the attribute", () => {
  const withRoads = build(shaftDrawn(), exp, spatial).workfront;
  assert.equal(withRoads.equipmentAccessFacts.roadWidthMeters, null);
  assert.equal(withRoads.unknownReasons.roadWidthMeters, "no-attribute");
  const withoutRoads = build(shaftDrawn(), exp, makeSpatialContext({ dem })).workfront;
  assert.equal(withoutRoads.unknownReasons.roadWidthMeters, "no-layer");
});

const near = (actual, expected, tolerance) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} not within ${tolerance} of ${expected}`);

test("staging areas are only ever hand-drawn, never guessed by splitting the work front's own polygon", () => {
  const bare = build(workAreaDrawn()).workfront;
  assert.equal(bare.stagingFacts.assemblyAreaSquareMeters, null);
  assert.equal(bare.unknownReasons.assemblyAreaSquareMeters, "not-provided");
  // the assembly polygon here IS the work front's own polygon, so its area must match usableAreaSquareMeters exactly
  const withAssembly = build(workAreaDrawn({ assemblyPolygon: cutCover.workAreaCandidates[0].polygon })).workfront;
  assert.equal(withAssembly.stagingFacts.assemblyAreaSquareMeters, withAssembly.usableAreaSquareMeters);
  assert.ok(!withAssembly.unknown.includes("assemblyAreaSquareMeters"));
});

// --- geometry facts --- (small tolerances: the candidate's own polygon is nominally 40x30 m, but real edge
// lengths through the equirectangular local frame differ from that nominal figure by a fraction of a metre)
test("usable area, width/length and turning space are computed from the work front's own real polygon", () => {
  const w = build(workAreaDrawn()).workfront;
  near(w.minimumWidthMeters, 30, 0.5);
  near(w.minimumLengthMeters, 40, 0.5);
  near(w.usableAreaSquareMeters, 1200, 20);
  const expectedTurning = Math.round(Math.PI * (w.minimumWidthMeters / 2) ** 2 * 10) / 10;
  assert.equal(w.equipmentAccessFacts.turningSpaceSquareMeters, expectedTurning);
});

test("a shaft candidate with no polygon of its own gets a square work front sized to its footprint", () => {
  const w = build(shaftDrawn()).workfront;
  assert.equal(w.polygon.length, 4);
  const footprint = tunnel.shaftCandidates[0].footprintMeters || 14;
  near(w.usableAreaSquareMeters, footprint * footprint, 5);
});

test("linked candidates self-link, and a genuinely absent nearby candidate is a real null, not unknown", () => {
  const w = build(shaftDrawn()).workfront;
  assert.equal(w.linkedShaftId, tunnel.shaftCandidates[0].shaftId, "the work front links to its own candidate");
  assert.ok(!w.unknown.includes("linkedMaterialYardId"), "absence of a nearby yard is a fact, not a missing value");
});

test("an access candidate is auto-picked when none is chosen, and entryWidthMeters reads the nearest edge to it", () => {
  const auto = build(workAreaDrawn()).workfront;
  assert.ok(auto.linkedAccessCandidateRef, "a nearby access candidate was found automatically");
  near(auto.equipmentAccessFacts.entryWidthMeters, auto.minimumWidthMeters, 0.1);
  const chosen = { kind: "accessRoad", id: cutCover.accessRoadCandidates[0].roadAccessId };
  const picked = build(workAreaDrawn({ accessCandidateRef: chosen })).workfront;
  assert.deepEqual(picked.linkedAccessCandidateRef, chosen);
});

test("an invalid access candidate reference is dropped with a warning, not silently accepted", () => {
  const r = build(workAreaDrawn({ accessCandidateRef: { kind: "accessRoad", id: "nope" } }));
  assert.ok(r.warnings.some((w) => w.code === "linked-candidate-missing"));
});

// --- editor: multiple work fronts per site, deletion, save/restore keeps ids ---
test("a site can hold several work fronts at once, each with its own id", () => {
  const wdoc = newWorkfrontDoc("t", "1");
  const e1 = addWorkfront(wdoc, { constructionSiteId: tunnel.constructionSiteId, candidateRef: { kind: "shaft", id: tunnel.shaftCandidates[0].shaftId } });
  const e2 = addWorkfront(wdoc, { constructionSiteId: tunnel.constructionSiteId, candidateRef: { kind: "shaft", id: tunnel.shaftCandidates[1].shaftId } });
  assert.notEqual(e1.workfrontId, e2.workfrontId);
  assert.equal(workfrontsForSite(wdoc, tunnel.constructionSiteId).length, 2);
});

test("adding the same candidate twice is idempotent (same deterministic id, no duplicate entry)", () => {
  const wdoc = newWorkfrontDoc("t", "1");
  const e1 = addWorkfront(wdoc, { constructionSiteId: tunnel.constructionSiteId, candidateRef: { kind: "shaft", id: tunnel.shaftCandidates[0].shaftId } });
  const e2 = addWorkfront(wdoc, { constructionSiteId: tunnel.constructionSiteId, candidateRef: { kind: "shaft", id: tunnel.shaftCandidates[0].shaftId } });
  assert.equal(e1.workfrontId, e2.workfrontId);
  assert.equal(wdoc.entries.length, 1);
});

test("removing a work-front candidate drops it from the document and from exports", () => {
  const wdoc = newWorkfrontDoc("t", "1");
  const e = addWorkfront(wdoc, { constructionSiteId: tunnel.constructionSiteId, candidateRef: { kind: "shaft", id: tunnel.shaftCandidates[0].shaftId } });
  removeWorkfront(wdoc, e.workfrontId);
  assert.equal(workfrontFor(wdoc, e.workfrontId), null);
  assert.equal(wdoc.entries.length, 0);
  removeWorkfront(wdoc, "workfront:does-not-exist"); // no-op, does not throw
});

test("access candidate and assembly/storage polygons are saved and restored under the same work-front id", () => {
  const wdoc = newWorkfrontDoc("t", "1");
  const e = addWorkfront(wdoc, { constructionSiteId: cutCover.constructionSiteId, candidateRef: { kind: "workArea", id: cutCover.workAreaCandidates[0].workAreaId } });
  setAccessCandidate(wdoc, e.workfrontId, { kind: "accessRoad", id: cutCover.accessRoadCandidates[0].roadAccessId });
  setAssemblyPolygon(wdoc, e.workfrontId, [[139, 35], [139.001, 35], [139.001, 35.001]]);
  setStoragePolygon(wdoc, e.workfrontId, [[139, 35], [139.002, 35], [139.002, 35.002]]);
  const restored = restoreWorkfrontDoc(serializeWorkfrontDoc(wdoc), pack);
  assert.deepEqual(restored.warnings, []);
  const re = workfrontFor(restored.doc, e.workfrontId);
  assert.deepEqual(re.accessCandidateRef, { kind: "accessRoad", id: cutCover.accessRoadCandidates[0].roadAccessId });
  assert.equal(re.assemblyPolygon.length, 3);
  assert.equal(re.storagePolygon.length, 3);
  const rebuilt = build(re).workfront;
  assert.ok(rebuilt.stagingFacts.assemblyAreaSquareMeters > 0);
});

test("a saved work-front document is not applied to another pack, and a pack-version change is reported", () => {
  const wdoc = newWorkfrontDoc("t", "1");
  addWorkfront(wdoc, { constructionSiteId: tunnel.constructionSiteId, candidateRef: { kind: "shaft", id: tunnel.shaftCandidates[0].shaftId } });
  const text = serializeWorkfrontDoc(wdoc);
  assert.equal(restoreWorkfrontDoc(text, { manifest: { id: "elsewhere", version: "1" } }).warnings[0].code, "workfront-doc-other-pack");
  assert.equal(restoreWorkfrontDoc(text, { manifest: { id: "t", version: "2" } }).warnings[0].code, "pack-version-mismatch");
  assert.equal(restoreWorkfrontDoc("{not json", pack).warnings[0].code, "workfront-doc-unreadable");
  assert.equal(restoreWorkfrontDoc(null, pack).doc.entries.length, 0);
});

// --- batch export ---
test("an export never repeats a work-front id, and reports one with invalid geometry", () => {
  const batch = buildConstructionWorkfrontExport({ pack, constructionExport: exp, spatial, workfronts: [shaftDrawn(), shaftDrawn(), { constructionSiteId: "cons:nope", candidateRef: { kind: "shaft", id: "x" } }] });
  assert.equal(batch.schema, CONSTRUCTION_WORKFRONT_EXPORT_SCHEMA);
  assert.equal(batch.workfronts.length, 1);
  assert.deepEqual(batch.warnings.map((w) => w.code), ["duplicate-construction-workfront", "workfront-no-geometry", "connection-construction-site-missing"]);
});

test("the batch export regenerates byte-for-byte from the same drawn work fronts", () => {
  const workfronts = [shaftDrawn(), workAreaDrawn({ assemblyPolygon: cutCover.workAreaCandidates[0].polygon })];
  const a = buildConstructionWorkfrontExport({ pack, constructionExport: exp, spatial, workfronts });
  const b = buildConstructionWorkfrontExport({ pack, constructionExport: exp, spatial, workfronts: structuredClone(workfronts) });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

// --- display: distinguishes site/work-front/assembly/storage/access, reads engine state read-only ---
test("marker views carry one row per placed work front, styled by kind", () => {
  const views = buildWorkfrontMarkerViews([build(shaftDrawn()).workfront, build(workAreaDrawn()).workfront]);
  assert.equal(views.length, 2);
  assert.equal(views[0].kind, "shaft");
  assert.equal(views[1].kind, "workArea");
});

test("the detail view distinguishes the site outline, the work front, assembly, storage and the access point", () => {
  const entry = { assemblyPolygon: [[139, 35], [139.001, 35], [139.001, 35.001]], storagePolygon: [[139, 35], [139.002, 35], [139.002, 35.002]] };
  const w = build(workAreaDrawn()).workfront;
  const view = buildWorkfrontDetailView(w, entry, exp);
  assert.equal(view.active, true);
  assert.deepEqual(view.sitePolygon, cutCover.polygon);
  assert.deepEqual(view.workfrontPolygon, w.polygon);
  assert.equal(view.assemblyPolygon.length, 3);
  assert.equal(view.storagePolygon.length, 3);
  assert.ok(view.accessLocation, "the linked access candidate's location is resolved for drawing");
  assert.equal(buildWorkfrontDetailView(null, null, exp).active, false);
  assert.equal(Object.keys(KIND_STYLE).length, 5);
});

test("the equipment report view reads contractor/contract/placement verbatim from the engine, and never guesses a verdict", () => {
  const w = build(workAreaDrawn()).workfront;
  const report = { equipmentAssignments: [{ workfrontId: w.workfrontId, contractorId: "co-1", packageContractId: "pkg-1", placementStatus: "conditional" }] };
  const found = buildEquipmentReportView(report, w);
  assert.equal(found.found, true);
  assert.equal(found.contractorId, "co-1");
  assert.equal(found.placementLabel, "조건부");
  const missing = buildEquipmentReportView({}, w);
  assert.equal(missing.found, false);
  const unrecognisedStatus = buildEquipmentReportView({ equipmentAssignments: [{ workfrontId: w.workfrontId, placementStatus: "pending-survey" }] }, w);
  assert.equal(unrecognisedStatus.placementLabel, "pending-survey", "an unrecognised engine value is shown verbatim, not invented");
});

test("workfrontId is the primary match key (falling back to constructionSiteId), and equipmentType/failures/conditions pass through verbatim", () => {
  const w = build(workAreaDrawn()).workfront;
  const failures = [{ field: "usableAreaSquareMeters", actual: 400, required: 1000, reason: "below-minimum" }];
  const conditions = [{ field: "equipmentAccessFacts.roadWidthMeters", reason: "no-attribute", required: 5.5 }];
  const byWorkfrontId = buildEquipmentReportView({ equipmentAssignments: [
    { workfrontId: w.workfrontId, constructionSiteId: "cons:other", equipmentType: "tunnel-boring", placementStatus: "infeasible", placementFailures: failures, placementConditions: conditions, status: "assigned" },
    { workfrontId: "workfront:unrelated", constructionSiteId: w.constructionSiteId, placementStatus: "feasible" },
  ] }, w);
  assert.equal(byWorkfrontId.placementStatus, "infeasible", "matched by workfrontId, not the constructionSiteId-only entry");
  assert.equal(byWorkfrontId.equipmentType, "tunnel-boring");
  assert.deepEqual(byWorkfrontId.placementFailures, failures);
  assert.deepEqual(byWorkfrontId.placementConditions, conditions);
  assert.notEqual(byWorkfrontId.placementStatus, "assigned", "the lifecycle `status` field must never be read as the placement verdict");

  const byConstructionSiteIdFallback = buildEquipmentReportView({ equipmentAssignments: [{ constructionSiteId: w.constructionSiteId, placementStatus: "conditional" }] }, w);
  assert.equal(byConstructionSiteIdFallback.placementStatus, "conditional", "falls back to constructionSiteId when no workfrontId matches");
});

function deepFreeze(o) { if (o && typeof o === "object" && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; }
const recorder = () => {
  const calls = [];
  const ctx = new Proxy({}, { get: (t, k) => (k in t ? t[k] : k === "measureText" ? () => ({ width: 50 }) : (...args) => calls.push([k, ...args])), set: (t, k, v) => { t[k] = v; calls.push(["set", k, v]); return true; } });
  return { calls, ctx };
};
const fakeBox = () => { const d = { createElement: (tag) => ({ tag, children: [], style: {}, className: "", textContent: "", hidden: false, ownerDocument: d, append(...c) { this.children.push(...c); }, replaceChildren(...c) { this.children = c; } }) }; return d.createElement("div"); };

test("the view and drawing only read a frozen export and report; nothing here changes engine state", () => {
  const frozenExp = deepFreeze(structuredClone(exp));
  const report = deepFreeze({ equipmentAssignments: [{ constructionSiteId: cutCover.constructionSiteId, contractorId: "co-1", placementStatus: "feasible", status: "assigned" }] });
  const beforeExp = JSON.stringify(frozenExp);
  const beforeReport = JSON.stringify(report);
  const w = deepFreeze(build(workAreaDrawn(), exp, spatial).workfront);
  const views = buildWorkfrontMarkerViews([w]);
  const detail = buildWorkfrontDetailView(w, {}, frozenExp);
  const eq = buildEquipmentReportView(report, w);
  assert.equal(eq.placementLabel, "배치 가능");
  const screen = ([lon, lat]) => [(lon - 139) * 1e5, -(lat - 35) * 1e5];
  drawWorkfrontMarkers(recorder().ctx, views, screen, w.workfrontId);
  drawWorkfrontDetail(recorder().ctx, detail, screen);
  renderWorkfrontPanel(fakeBox(), views, detail, eq);
  assert.equal(JSON.stringify(frozenExp), beforeExp);
  assert.equal(JSON.stringify(report), beforeReport);
});

test("markers draw nothing when none are placed, and drawing an inactive detail view is a no-op", () => {
  const r1 = recorder();
  drawWorkfrontMarkers(r1.ctx, [], () => [0, 0]);
  assert.deepEqual(r1.calls, [["save"], ["restore"]], "no marker is drawn, but the canvas state is still balanced");
  const r2 = recorder();
  drawWorkfrontDetail(r2.ctx, { active: false }, () => [0, 0]);
  assert.deepEqual(r2.calls, []);
});

// --- shipped examples (packs/<id>/construction-workfront-examples), tied to construction-site examples ---
const workfrontFiles = (id) => fs.readdirSync(path.join(root, "packs", id, "construction-workfront-examples")).filter((f) => f.endsWith(".construction-workfront.json")).sort();
const loadWorkfrontExamples = (id) => ({
  manifest: readJson(`packs/${id}/manifest.json`),
  sites: fs.readdirSync(path.join(root, "packs", id, "construction-examples")).filter((f) => f.endsWith(".construction.json")).sort().map((f) => readJson(`packs/${id}/construction-examples/${f}`)),
  workfronts: workfrontFiles(id).map((f) => ({ file: f, workfront: readJson(`packs/${id}/construction-workfront-examples/${f}`) })),
});
const IDS = ["tokyo", "example-radial", "example-corridor"];

test("each pack ships at least 7 named work-front scenarios covering both candidate kinds and both road outcomes", () => {
  for (const id of IDS) {
    const { workfronts } = loadWorkfrontExamples(id);
    assert.ok(workfronts.length >= 7, `${id}: only ${workfronts.length}`);
    const kinds = new Set(workfronts.map((x) => x.workfront.candidateRef.kind));
    assert.ok(kinds.has("workArea"), `${id}: missing a workArea work front`);
    assert.ok(workfronts.some((x) => x.workfront.majorRoadAccessible === true), `${id}: a major-road-accessible scenario`);
    assert.ok(workfronts.some((x) => x.workfront.majorRoadAccessible === false), `${id}: a major-road-inaccessible scenario`);
    assert.ok(workfronts.some((x) => x.workfront.spatialFlags.includes("near-residential")), `${id}: a near-residential scenario`);
    assert.ok(workfronts.some((x) => x.workfront.unknown.length >= 4), `${id}: a missing-layers scenario`);
    assert.ok(workfronts.some((x) => x.workfront.stagingFacts.assemblyAreaSquareMeters !== null && x.workfront.stagingFacts.assemblyAreaSquareMeters < 100), `${id}: an undersized-assembly scenario`);
  }
});

test("every shipped work front connects to a real construction site from the same pack", () => {
  for (const id of IDS) {
    const { sites, workfronts } = loadWorkfrontExamples(id);
    for (const { file, workfront } of workfronts) assert.ok(sites.some((s) => s.constructionSiteId === workfront.constructionSiteId), `${id}/${file}: site ${workfront.constructionSiteId}`);
  }
});

test("shipped work fronts keep unknowns null with a reason, carry the pack license, and have no forbidden fields", () => {
  for (const id of IDS) {
    const { manifest, workfronts } = loadWorkfrontExamples(id);
    for (const { file, workfront } of workfronts) {
      assert.equal(workfront.schema, CONSTRUCTION_WORKFRONT_SCHEMA);
      assert.equal(workfront.license.pack, manifest.data.license, `${id}/${file}`);
      for (const f of workfront.unknown) assert.ok(workfront.unknownReasons[f], `${id}/${file}: ${f} needs a reason`);
      for (const k of keysOf(workfront)) assert.doesNotMatch(k, forbidden, `${id}/${file}: field ${k}`);
    }
  }
});

test("shipped work fronts regenerate byte-for-byte from their saved input and layers", async () => {
  const { syntheticLayers } = await import("../../scripts/lib/synthetic-layers.mjs");
  const { roadLayerFromGeojson: roadsFrom } = await import("../src/map/spatial.mjs");
  const minorOnlyRoads = (centre) => roadsFrom({ features: [{ geometry: { coordinates: [[centre[0] - 0.02, centre[1] + 0.0007], [centre[0] + 0.02, centre[1] + 0.0007]] }, properties: { roadClass: "minor" } }] }, { quality: "high", source: { name: "minor-only roads (example: no major road nearby)", license: "CC0-1.0" } });
  for (const id of ["example-radial", "example-corridor"]) {
    const { manifest, sites, workfronts } = loadWorkfrontExamples(id);
    const p = { manifest };
    const constructionExport = { sites };
    for (const { file, workfront: saved } of workfronts) {
      const { source: src, ...body } = saved;
      let layers;
      if (src.layers.kind === "synthetic-layers") layers = syntheticLayers(src.layers.centre, src.layers.options);
      else if (src.layers.kind === "minor-only-roads") layers = { ...syntheticLayers(src.layers.centre, src.layers.options ?? {}), roads: minorOnlyRoads(src.layers.centre) };
      else layers = {};
      const fresh = buildConstructionWorkfront(src.drawnWorkfront, { pack: p, spatial: makeSpatialContext(layers), constructionExport }).workfront;
      assert.equal(JSON.stringify(fresh), JSON.stringify(body), `${id}/${file} is stale: run npm run construction-workfront-examples`);
    }
  }
});

// --- boundary: never touches the management engine, cash, or the file system ---
test("construction-workfront modules do not import the management engine or touch cash, construction state or files", () => {
  for (const f of ["construction-workfront.mjs", "construction-workfront-editor.mjs", "construction-workfront-view.mjs", "construction-workfront-ui.mjs"]) {
    const src = fs.readFileSync(path.join(root, "engine/src/map", f), "utf8");
    for (const m of src.matchAll(/from "([^"]+)"/g)) assert.match(m[1], /^\.\/[a-z-]+\.mjs$/, `${f} imports ${m[1]}`);
    assert.doesNotMatch(src, /ledger|\.commit\(|\.settle\(|\.post\(|node:fs/, `${f} must not reach engine state or the file system`);
    assert.ok(src.length < 40_000, `${f} holds code, not data`);
  }
});
