import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildMapExport } from "../src/map/plan-geometry.mjs";
import { makeSpatialContext, roadLayerFromGeojson } from "../src/map/spatial.mjs";
import { buildConstructionExport } from "../src/map/construction-site.mjs";
import {
  applyConstructionPick, CANDIDATE_KINDS, clearConstructionSelection, cloneConstructionSelection, constructionSelectionOutput,
  CONSTRUCTION_SELECTION_SCHEMA, createConstructionSelection, pickConstructionCandidate, pruneConstructionSelection,
  restoreConstructionSelection, selectConstructionCandidate,
} from "../src/map/construction-selection.mjs";
import { buildConstructionSelectionView, drawConstructionSelection, renderConstructionSelectionPanel } from "../src/map/construction-selection-view.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// --- fixtures: a two-segment tunnel package with real roads, so every candidate kind has something to offer ---
const pack = { manifest: { id: "t", version: "1", data: { license: "CC0-1.0", attribution: [] } }, demand: { points: [{ id: "d0", name: "d0", location: [139, 35] }, { id: "d1", name: "d1", location: [139.01, 35] }, { id: "d2", name: "d2", location: [139.02, 35] }] } };
const line = { key: "main", name: "Main", legs: [{ structureHint: "shield" }, { structureHint: "shield" }], vertices: [139, 139.01, 139.02].map((lon) => ({ location: [lon, 35], platformType: "side" })) };
const dem = { elevationAt: () => 12, slopeAt: () => 1, quality: "medium", source: { name: "test dem", license: "CC0-1.0" } };
const mapExport = buildMapExport({ pack, mode: "scratch", drawnLines: [line], spatial: makeSpatialContext({ dem }) });
const plan = mapExport.plans[0];
const roads = roadLayerFromGeojson({ features: [
  { geometry: { coordinates: [[139, 34.9993], [139.02, 34.9993]] }, properties: { roadClass: "major" } },
  { geometry: { coordinates: [[139, 35.0006], [139.02, 35.0006]] }, properties: { roadClass: "minor" } },
] }, { quality: "high", source: { name: "test roads", license: "CC0-1.0" } });
const exp = buildConstructionExport({ pack, mapExport, packages: [{ key: "p1", kind: "tunnel", planId: plan.planId, segmentIds: plan.segments.map((s) => s.id) }], spatial: makeSpatialContext({ dem, roads }) });
const site = exp.sites[0];
const shaft = site.shaftCandidates[0];
const work = site.workAreaCandidates[0];
const yard = site.materialYardCandidates[0];
const roadAccess = site.accessRoadCandidates[0];
const vehicleAccess = site.vehicleAccessCandidates[0];
const fresh = () => createConstructionSelection();

test("fixture: the tunnel package offers every candidate kind", () => {
  assert.ok(shaft && work && yard && roadAccess && vehicleAccess);
  assert.equal(CANDIDATE_KINDS.length, 5);
});

// --- output ---
test("an empty selection outputs the contract with nothing chosen", () => {
  assert.deepEqual(constructionSelectionOutput(fresh(), exp), {
    schema: CONSTRUCTION_SELECTION_SCHEMA, contractVersion: 1, packId: "t", constructionSiteId: null, kind: null, candidateId: null, facts: null,
  });
});

test("the output carries constructionSiteId, kind, candidateId and the candidate's own spatial facts", () => {
  const sel = fresh();
  assert.ok(selectConstructionCandidate(sel, exp, "shaft", shaft.shaftId));
  const out = constructionSelectionOutput(sel, exp);
  assert.equal(out.constructionSiteId, site.constructionSiteId);
  assert.equal(out.kind, "shaft");
  assert.equal(out.candidateId, shaft.shaftId);
  assert.equal(out.facts.groundElevationMeters, shaft.groundElevationMeters);
  assert.equal(out.facts.shaftDepthMeters, shaft.shaftDepthMeters);
  assert.ok(!("shaftId" in out.facts), "the id itself is not repeated inside facts");
});

test("a work area's facts include its polygon and area; an access point's include its nearest road", () => {
  const sel = fresh();
  selectConstructionCandidate(sel, exp, "workArea", work.workAreaId);
  assert.deepEqual(constructionSelectionOutput(sel, exp).facts.polygon, work.polygon);
  const sel2 = fresh();
  selectConstructionCandidate(sel2, exp, "vehicleAccess", vehicleAccess.vehicleAccessId);
  assert.deepEqual(constructionSelectionOutput(sel2, exp).facts.nearestRoad, vehicleAccess.nearestRoad);
});

const forbidden = /cost|price|score|capacity|compensation|duration|opposition|negotiat|schedule|budget|fare|cash|ledger|profit|revenue|probability|method|award|bid/i;
function keysOf(value, out = new Set()) {
  if (Array.isArray(value)) value.forEach((v) => keysOf(v, out));
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) { out.add(k); keysOf(v, out); }
  return out;
}
test("the output has no cost, duration, score, method, compensation or award fields", () => {
  const sel = fresh();
  selectConstructionCandidate(sel, exp, "shaft", shaft.shaftId);
  for (const k of keysOf(constructionSelectionOutput(sel, exp))) assert.doesNotMatch(k, forbidden, k);
});

// --- selection rules: one candidate at a time ---
test("picking a candidate replaces any previous one, even of a different kind; picking it again clears it", () => {
  const sel = fresh();
  selectConstructionCandidate(sel, exp, "shaft", shaft.shaftId);
  selectConstructionCandidate(sel, exp, "materialYard", yard.materialYardId);
  assert.deepEqual(cloneConstructionSelection(sel), { constructionSiteId: site.constructionSiteId, kind: "materialYard", candidateId: yard.materialYardId });
  selectConstructionCandidate(sel, exp, "materialYard", yard.materialYardId);
  assert.deepEqual(sel, createConstructionSelection());
});

test("an id the export does not have changes nothing", () => {
  const sel = fresh();
  selectConstructionCandidate(sel, exp, "shaft", shaft.shaftId);
  const before = JSON.stringify(sel);
  assert.equal(selectConstructionCandidate(sel, exp, "shaft", "shaft:nope"), false);
  assert.equal(selectConstructionCandidate(sel, exp, "bogus", "x"), false);
  assert.equal(JSON.stringify(sel), before);
});

test("a click on nothing clears the selection", () => {
  const sel = fresh();
  selectConstructionCandidate(sel, exp, "shaft", shaft.shaftId);
  applyConstructionPick(sel, exp, null);
  assert.equal(sel.candidateId, null);
  selectConstructionCandidate(sel, exp, "shaft", shaft.shaftId);
  clearConstructionSelection(sel);
  assert.deepEqual(sel, createConstructionSelection());
});

test("what the export no longer has is dropped, with the reason", () => {
  const sel = fresh();
  selectConstructionCandidate(sel, exp, "shaft", shaft.shaftId);
  const withoutShaft = { ...exp, sites: [{ ...site, shaftCandidates: [] }] };
  const warnings = pruneConstructionSelection(sel, withoutShaft);
  assert.deepEqual(warnings.map((w) => w.code), ["selected-candidate-missing"]);
  assert.equal(sel.candidateId, null);
});

// --- save and reopen ---
test("the same selection is restored after the export is regenerated (same keyed package)", () => {
  const sel = fresh();
  selectConstructionCandidate(sel, exp, "accessRoad", roadAccess.roadAccessId);
  const saved = JSON.stringify(constructionSelectionOutput(sel, exp));
  const again = restoreConstructionSelection(JSON.parse(saved), exp);
  assert.deepEqual(again.warnings, []);
  assert.equal(JSON.stringify(constructionSelectionOutput(again.selection, exp)), saved);
  assert.equal(restoreConstructionSelection({ schema: "other/1" }, exp).warnings[0].code, "selection-unreadable");
  assert.deepEqual(restoreConstructionSelection({ schema: CONSTRUCTION_SELECTION_SCHEMA, contractVersion: 1, candidateId: null }, exp).selection, createConstructionSelection());
});

// --- picking ---
const screen = ([lon, lat]) => [(lon - 139) * 1e5, -(lat - 35) * 1e5];
const at = (loc, dx = 0, dy = 0) => { const [x, y] = screen(loc); return [x + dx, y + dy]; };
test("the pointer picks a point candidate over an overlapping area candidate", () => {
  assert.deepEqual(pickConstructionCandidate(exp, screen, ...at(shaft.location, 2, 1)), { kind: "shaft", id: shaft.shaftId, constructionSiteId: site.constructionSiteId });
  const inside = [work.polygon.reduce((s, p) => s + p[0], 0) / work.polygon.length, work.polygon.reduce((s, p) => s + p[1], 0) / work.polygon.length];
  assert.deepEqual(pickConstructionCandidate(exp, screen, ...at(inside)), { kind: "workArea", id: work.workAreaId, constructionSiteId: site.constructionSiteId });
  assert.equal(pickConstructionCandidate(exp, screen, 50000, 50000), null);
  assert.equal(pickConstructionCandidate({ sites: [] }, screen, 0, 0), null);
  assert.equal(pickConstructionCandidate(null, screen, 0, 0), null);
});

// --- display: highlight, read-only ---
test("the view holds the picked candidate's location or polygon and label", () => {
  const sel = fresh();
  selectConstructionCandidate(sel, exp, "shaft", shaft.shaftId);
  const v = buildConstructionSelectionView(exp, sel);
  assert.equal(v.active, true);
  assert.equal(v.isArea, false);
  assert.deepEqual(v.location, shaft.location);
  assert.equal(v.label, "수직구");
  const sel2 = fresh();
  selectConstructionCandidate(sel2, exp, "materialYard", yard.materialYardId);
  const v2 = buildConstructionSelectionView(exp, sel2);
  assert.equal(v2.isArea, true);
  assert.deepEqual(v2.polygon, yard.polygon);
  assert.equal(buildConstructionSelectionView(exp, fresh()).active, false);
});

function deepFreeze(o) { if (o && typeof o === "object" && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; }
const recorder = () => {
  const calls = [];
  const ctx = new Proxy({}, { get: (t, k) => (k in t ? t[k] : k === "measureText" ? () => ({ width: 50 }) : (...args) => calls.push([k, ...args])), set: (t, k, v) => { t[k] = v; calls.push(["set", k, v]); return true; } });
  return { calls, ctx };
};
const fakeBox = () => { const doc = { createElement: (tag) => ({ tag, children: [], style: {}, className: "", textContent: "", hidden: false, ownerDocument: doc, append(...c) { this.children.push(...c); }, replaceChildren(...c) { this.children = c; } }) }; return doc.createElement("div"); };

test("the view, drawing and panel only read: a frozen export is not touched and the selection is unchanged", () => {
  const frozen = deepFreeze(structuredClone(exp));
  const sel = fresh();
  selectConstructionCandidate(sel, frozen, "shaft", shaft.shaftId);
  const before = JSON.stringify([sel, constructionSelectionOutput(sel, frozen)]);
  const view = buildConstructionSelectionView(frozen, sel);
  drawConstructionSelection(recorder().ctx, view, screen);
  renderConstructionSelectionPanel(fakeBox(), view);
  assert.equal(JSON.stringify([sel, constructionSelectionOutput(sel, frozen)]), before);
});

test("the highlight is drawn in its own colour, and the panel shows the candidate's facts as text with 미상 for unknowns", () => {
  const sel = fresh();
  selectConstructionCandidate(sel, exp, "shaft", shaft.shaftId);
  const view = buildConstructionSelectionView(exp, sel);
  const r = recorder();
  drawConstructionSelection(r.ctx, view, screen);
  assert.ok(r.calls.some((c) => c[0] === "set" && c[1] === "strokeStyle" && c[2] === "#ffe66d"));
  const box = fakeBox();
  renderConstructionSelectionPanel(box, view);
  const texts = box.children.map((c) => c.textContent);
  assert.ok(texts.some((t) => t.includes("선택: 수직구")));
  assert.ok(texts.some((t) => t.includes("깊이")));
  const empty = recorder();
  drawConstructionSelection(empty.ctx, buildConstructionSelectionView(exp, fresh()), screen);
  assert.deepEqual(empty.calls, []);
});

// --- boundary ---
test("the construction-selection modules do not import the management engine or touch cash, construction state or files", () => {
  for (const f of ["construction-selection.mjs", "construction-selection-view.mjs", "construction-selection-ui.mjs"]) {
    const src = fs.readFileSync(path.join(root, "engine/src/map", f), "utf8");
    for (const m of src.matchAll(/from "([^"]+)"/g)) assert.match(m[1], /^\.\/[a-z-]+\.mjs$|^\.\.\/(projection|geometry)\.mjs$/, `${f} imports ${m[1]}`);
    assert.doesNotMatch(src, /ledger|\.commit\(|\.settle\(|\.post\(|node:fs/, `${f} must not reach engine state or the file system`);
    assert.ok(src.length < 40_000);
  }
});
