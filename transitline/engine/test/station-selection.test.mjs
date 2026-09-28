import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildMapExport } from "../src/map/plan-geometry.mjs";
import { makeSpatialContext } from "../src/map/spatial.mjs";
import { buildStationExport } from "../src/map/station-site.mjs";
import { addEntrance, addSite, activeSites, newStationDoc, removeEntrance, removeSite, restoreStationDoc, serializeStationDoc, setTransfer } from "../src/map/station-editor.mjs";
import { buildOverlayModel } from "../src/map/overlay.mjs";
import {
  applyPick, clearSelection, cloneSelection, createStationSelection, pickStationItem, pruneSelection, restoreSelection, SELECTION_SCHEMA, selectionOutput, selectItem,
} from "../src/map/station-selection.mjs";
import { buildSelectionView, drawStationSelection, renderSelectionPanel } from "../src/map/station-selection-view.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// --- fixtures: three plan stations on lat 35; site A on the middle one (two entrances, a nearby and a drawn passage),
//     site B on the last one (no entrances) ---
const pack = {
  manifest: { id: "t", version: "1", data: { license: "CC0-1.0", attribution: [] } },
  demand: { points: [{ id: "d0", name: "d0", location: [139, 35] }, { id: "d1", name: "d1", location: [139.01, 35] }, { id: "d2", name: "d2", location: [139.02, 35] }] },
  existingNetwork: { lines: [{ name: "E1", osmRelationId: 42, stationIds: ["d0", "d1"] }] },
};
const line = {
  key: "main", name: "Main", legs: [{ structureHint: "surface" }, { structureHint: "surface" }],
  vertices: [139, 139.01, 139.02].map((lon) => ({ location: [lon, 35], platformType: "side", platformLengthM: 100 })),
};
const existing = buildMapExport({ pack, mode: "existing", drawnLines: [line] });
const plan = existing.plans[0];
const [s0, s1, s2] = plan.stationCandidates;

function buildDoc() {
  const doc = newStationDoc("t", "1");
  const a = addSite(doc, { name: "A", location: s1.location, connect: { planId: plan.planId, stationId: s1.id } });
  addEntrance(doc, a.key, [139.0104, 35]);
  addEntrance(doc, a.key, [139.0096, 35]);
  setTransfer(doc, a.key, "d0", [[139.005, 35.0004]]);
  addSite(doc, { name: "B", location: s2.location, connect: { planId: plan.planId, stationId: s2.id } });
  return doc;
}
const exportOf = (d) => buildStationExport({ pack, mapExport: existing, stations: activeSites(d), spatial: makeSpatialContext({}) });
const doc = buildDoc();
const exp = exportOf(doc);
const A = exp.sites.find((s) => s.name === "A");
const B = exp.sites.find((s) => s.name === "B");
const entranceIds = A.entranceCandidates.map((e) => e.entranceId);
const transferIds = A.transferCandidates.map((t) => t.transferId);
const workIds = A.workAreaCandidates.map((w) => w.workAreaId);
const fresh = () => createStationSelection();

test("fixture: site A has two entrances, two passages (one nearby, one drawn) and four work areas", () => {
  assert.equal(entranceIds.length, 2);
  assert.deepEqual(A.transferCandidates.map((t) => t.basis).sort(), ["nearby", "player-passage"]);
  assert.equal(workIds.length, 4);
  assert.equal(B.entranceCandidates.length, 0);
});

// --- output ---
test("an empty selection outputs the contract with nothing chosen", () => {
  assert.deepEqual(selectionOutput(fresh(), exp), {
    schema: SELECTION_SCHEMA, contractVersion: 1, packId: "t", stationSiteId: null, selectedEntranceIds: [], selectedTransferIds: [],
    selectedWorkAreaId: null, connectedPlanId: null, connectedStationId: null,
  });
});

test("the output carries stationSiteId, selectedEntranceIds[], selectedTransferIds[] and selectedWorkAreaId", () => {
  const sel = fresh();
  assert.ok(selectItem(sel, exp, "station", A.stationSiteId));
  selectItem(sel, exp, "entrance", entranceIds[1]);
  selectItem(sel, exp, "entrance", entranceIds[0], { additive: true });
  selectItem(sel, exp, "transfer", transferIds[0]);
  selectItem(sel, exp, "workArea", workIds[2]);
  const out = selectionOutput(sel, exp);
  assert.equal(out.stationSiteId, A.stationSiteId);
  assert.deepEqual(out.selectedEntranceIds, [...entranceIds].sort());
  assert.deepEqual(out.selectedTransferIds, [transferIds[0]]);
  assert.equal(out.selectedWorkAreaId, workIds[2]);
  assert.equal(out.connectedPlanId, plan.planId);
  assert.equal(out.connectedStationId, s1.id);
});

const forbidden = /cost|price|score|capacity|compensation|duration|opposition|negotiat|schedule|budget|fare|cash|ledger|profit|revenue|award|bid|method/i;
test("the output has no cost, duration, score, method, compensation or award fields", () => {
  const sel = fresh();
  selectItem(sel, exp, "entrance", entranceIds[0]);
  for (const k of Object.keys(selectionOutput(sel, exp))) assert.doesNotMatch(k, forbidden, k);
});

test("the output does not depend on the order things were picked in", () => {
  const a = fresh();
  for (const id of [entranceIds[0], entranceIds[1]]) selectItem(a, exp, "entrance", id, { additive: true });
  selectItem(a, exp, "transfer", transferIds[1]);
  selectItem(a, exp, "transfer", transferIds[0], { additive: true });
  const b = fresh();
  selectItem(b, exp, "transfer", transferIds[0]);
  selectItem(b, exp, "transfer", transferIds[1], { additive: true });
  for (const id of [entranceIds[1], entranceIds[0]]) selectItem(b, exp, "entrance", id, { additive: true });
  assert.equal(JSON.stringify(selectionOutput(a, exp)), JSON.stringify(selectionOutput(b, exp)));
});

// --- actions ---
test("a plain click replaces the entrance choice, an additive one toggles, and clicking the only one again clears it", () => {
  const sel = fresh();
  selectItem(sel, exp, "entrance", entranceIds[0]);
  selectItem(sel, exp, "entrance", entranceIds[1]);
  assert.deepEqual(sel.entranceIds, [entranceIds[1]]);
  selectItem(sel, exp, "entrance", entranceIds[0], { additive: true });
  assert.equal(sel.entranceIds.length, 2);
  selectItem(sel, exp, "entrance", entranceIds[1], { additive: true });
  assert.deepEqual(sel.entranceIds, [entranceIds[0]]);
  selectItem(sel, exp, "entrance", entranceIds[0]);
  assert.deepEqual(sel.entranceIds, []);
});

test("only one work area at a time; picking it again clears it", () => {
  const sel = fresh();
  selectItem(sel, exp, "workArea", workIds[0]);
  selectItem(sel, exp, "workArea", workIds[1]);
  assert.equal(sel.workAreaId, workIds[1]);
  selectItem(sel, exp, "workArea", workIds[1]);
  assert.equal(sel.workAreaId, null);
});

test("items belong to one station: another station's pick, or picking an item there, moves the whole selection", () => {
  const sel = fresh();
  selectItem(sel, exp, "entrance", entranceIds[0]);
  selectItem(sel, exp, "workArea", workIds[0]);
  selectItem(sel, exp, "station", B.stationSiteId);
  assert.deepEqual(cloneSelection(sel), { stationSiteId: B.stationSiteId, entranceIds: [], transferIds: [], workAreaId: null });
  selectItem(sel, exp, "transfer", transferIds[0]); // an item of A: its owner is selected first
  assert.equal(sel.stationSiteId, A.stationSiteId);
  assert.deepEqual(sel.transferIds, [transferIds[0]]);
});

test("clicking the selected station's body keeps the station and drops its items; additive keeps them", () => {
  const sel = fresh();
  selectItem(sel, exp, "entrance", entranceIds[0]);
  selectItem(sel, exp, "station", A.stationSiteId, { additive: true });
  assert.deepEqual(sel.entranceIds, [entranceIds[0]]);
  selectItem(sel, exp, "station", A.stationSiteId);
  assert.equal(sel.stationSiteId, A.stationSiteId);
  assert.deepEqual(sel.entranceIds, []);
});

test("an id the export does not have changes nothing", () => {
  const sel = fresh();
  selectItem(sel, exp, "entrance", entranceIds[0]);
  const before = JSON.stringify(sel);
  assert.equal(selectItem(sel, exp, "entrance", "ent:nope"), false);
  assert.equal(selectItem(sel, exp, "station", "stn-site:nope"), false);
  assert.equal(selectItem(sel, exp, "bogus", "x"), false);
  assert.equal(JSON.stringify(sel), before);
});

test("a click on nothing clears the selection unless it is additive", () => {
  const sel = fresh();
  selectItem(sel, exp, "station", A.stationSiteId);
  applyPick(sel, exp, null, { additive: true });
  assert.equal(sel.stationSiteId, A.stationSiteId);
  applyPick(sel, exp, null);
  assert.equal(sel.stationSiteId, null);
  selectItem(sel, exp, "station", A.stationSiteId);
  clearSelection(sel);
  assert.deepEqual(sel, createStationSelection());
});

// --- the export changes under a selection ---
test("what the export no longer has is dropped, with the reason", () => {
  const sel = fresh();
  selectItem(sel, exp, "entrance", entranceIds[0]);
  selectItem(sel, exp, "entrance", entranceIds[1], { additive: true });
  selectItem(sel, exp, "workArea", workIds[0]);
  const d = buildDoc();
  removeEntrance(d, "station-1", "entrance-1");
  const warnings = pruneSelection(sel, exportOf(d));
  assert.deepEqual(warnings.map((w) => w.code), ["selected-entrance-missing"]);
  assert.equal(sel.entranceIds.length, 1);
  assert.equal(sel.workAreaId, workIds[0], "what is still there stays selected");
  removeSite(d, "station-1");
  assert.deepEqual(pruneSelection(sel, exportOf(d)).map((w) => w.code), ["selected-station-missing"]);
  assert.equal(sel.stationSiteId, null);
  assert.equal(selectionOutput(sel, exportOf(d)).stationSiteId, null);
});

// --- ids persist: a selection survives a save and reopen of the station document ---
test("the same selection is restored after the station document is saved and reopened", () => {
  const sel = fresh();
  selectItem(sel, exp, "entrance", entranceIds[0]);
  selectItem(sel, exp, "transfer", transferIds[1]);
  selectItem(sel, exp, "workArea", workIds[3]);
  const saved = JSON.stringify(selectionOutput(sel, exp));
  const reopened = restoreStationDoc(serializeStationDoc(doc), pack).doc;
  const again = restoreSelection(JSON.parse(saved), exportOf(reopened));
  assert.deepEqual(again.warnings, []);
  assert.equal(JSON.stringify(selectionOutput(again.selection, exportOf(reopened))), saved);
  assert.equal(restoreSelection({ schema: "other/1" }, exp).warnings[0].code, "selection-unreadable");
});

// --- picking ---
const screen = ([lon, lat]) => [(lon - 139) * 1e5, -(lat - 35) * 1e5]; // 0.0001 degrees = 10 px
const at = (loc, dx = 0, dy = 0) => { const [x, y] = screen(loc); return [x + dx, y + dy]; };
test("the pointer picks the entrance first, then a passage, then a work area, then the station body", () => {
  const e0 = A.entranceCandidates[0];
  assert.deepEqual(pickStationItem(exp, screen, ...at(e0.location, 3, 2)), { kind: "entrance", id: e0.entranceId, stationSiteId: A.stationSiteId });
  const drawn = A.transferCandidates.find((t) => t.basis === "player-passage");
  assert.deepEqual(pickStationItem(exp, screen, ...at(drawn.alignment[1], 0, 3)), { kind: "transfer", id: drawn.transferId, stationSiteId: A.stationSiteId });
  const w = A.workAreaCandidates.find((x) => x.slot === "side-right");
  const inside = [w.polygon.reduce((s, p) => s + p[0], 0) / 4, w.polygon.reduce((s, p) => s + p[1], 0) / 4];
  assert.deepEqual(pickStationItem(exp, screen, ...at(inside)), { kind: "workArea", id: w.workAreaId, stationSiteId: A.stationSiteId });
  assert.deepEqual(pickStationItem(exp, screen, ...at(A.location)), { kind: "station", id: A.stationSiteId, stationSiteId: A.stationSiteId });
  assert.equal(pickStationItem(exp, screen, 5000, 5000), null);
  assert.equal(pickStationItem({ sites: [] }, screen, 0, 0), null);
  assert.equal(pickStationItem(null, screen, 0, 0), null);
});

test("pressing on the station's centre picks the station even where a passage ends or an entrance is close", () => {
  // the nearby passage to the station's own node ends at the centre; zoomed far out, the entrances sit within reach of it
  const tiny = ([lon, lat]) => [(lon - 139) * 1e3, -(lat - 35) * 1e3]; // a whole station is ~1 px
  const p = tiny(A.location);
  assert.equal(pickStationItem(exp, tiny, p[0], p[1]).kind, "station");
  assert.equal(pickStationItem(exp, screen, ...at(A.location)).kind, "station");
});

test("of two entrances in reach the nearer one is picked", () => {
  const [a, b] = A.entranceCandidates;
  assert.equal(pickStationItem(exp, screen, ...at(a.location, 1, 0)).id, a.entranceId);
  assert.equal(pickStationItem(exp, screen, ...at(b.location, -1, 0)).id, b.entranceId);
});

// --- display: highlight and the engine's read-only word ---
const report = (extra = {}) => ({ plans: [], projects: [], assessments: { [plan.planId]: { buildable: false, violations: [], missingInputs: [], ...extra } } });
const overlayOf = (r) => buildOverlayModel(existing, r);
const picked = () => { const s = fresh(); selectItem(s, exp, "entrance", entranceIds[0]); selectItem(s, exp, "transfer", transferIds[0]); selectItem(s, exp, "workArea", workIds[1]); return s; };

test("the highlight model holds just what is selected", () => {
  const v = buildSelectionView(exp, picked(), null);
  assert.equal(v.active, true);
  assert.equal(v.stationSiteId, A.stationSiteId);
  assert.deepEqual(v.entrances.map((e) => e.id), [entranceIds[0]]);
  assert.deepEqual(v.transfers.map((t) => t.id), [transferIds[0]]);
  assert.equal(v.workArea.id, workIds[1]);
  assert.deepEqual(v.body, A.bodyPolygon);
  assert.equal(buildSelectionView(exp, fresh(), null).active, false);
});

test("the engine's construction state, verdict and errors for the selected station are shown as reported, read-only", () => {
  const overlay = overlayOf(report({
    violations: [`Station ${s1.id} platform is too short`, "Segment 1 length is zero", `Station ${s0.id} is elsewhere`, "plan-wide rule broken"],
    missingInputs: [`stationCandidates.${s1.id}.platformType`],
  }));
  const e = buildSelectionView(exp, picked(), overlay).engine;
  assert.equal(e.readOnly, true);
  assert.equal(e.linked, true);
  assert.equal(e.status.label, "불가");
  assert.equal(e.construction.label, "계획");
  const scopes = e.errors.map((x) => `${x.severity}:${x.scope}`);
  for (const want of ["error:station", "error:segment", "error:plan", "warning:station"]) assert.ok(scopes.includes(want), `${want} in ${scopes.join()}`);
  assert.ok(!e.errors.some((x) => x.message.includes(s0.id)), "another station's error is not this station's");
  assert.ok(e.mapNotes.length > 0 && e.mapNotes.every((x) => x.severity === "info"), "map-side notes are kept apart from the engine's");

  const building = buildOverlayModel(existing, { ...report({ violations: [`Station ${s1.id} platform is too short`] }), projects: [{ planId: plan.planId, status: "underConstruction", progress: 0.4, delayMonths: 2 }] });
  const b = buildSelectionView(exp, picked(), building).engine;
  assert.equal(b.construction.label, "공사 중");
  assert.equal(b.construction.delayed, true);
  assert.equal(b.construction.progress, 0.4);
  assert.equal(b.status.label, "공사 중", "construction wins over the verdict once it is being built");
});

test("no report, or a station tied to no plan, means no engine word — not a guess", () => {
  const none = buildSelectionView(exp, picked(), null).engine;
  assert.deepEqual([none.linked, none.construction, none.status, none.errors], [false, null, null, []]);
  const free = buildStationExport({ pack, mapExport: existing, stations: [{ key: "free", name: "F", location: [139.5, 35.5], headingDegrees: 0 }], spatial: makeSpatialContext({}) });
  const sel = fresh();
  selectItem(sel, free, "station", free.sites[0].stationSiteId);
  const v = buildSelectionView(free, sel, overlayOf(report({ violations: ["Station x is bad"] })));
  assert.equal(v.engine.linked, false);
  assert.deepEqual(v.engine.errors, []);
});

function deepFreeze(o) { if (o && typeof o === "object" && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; }
const recorder = () => {
  const calls = [];
  const ctx = new Proxy({}, { get: (t, k) => (k in t ? t[k] : k === "measureText" ? () => ({ width: 60 }) : (...args) => calls.push([k, ...args])), set: (t, k, v) => { t[k] = v; calls.push(["set", k, v]); return true; } });
  return { calls, ctx };
};
const fakeBox = () => { const doc = { createElement: (tag) => ({ tag, children: [], className: "", textContent: "", hidden: false, ownerDocument: doc, append(...c) { this.children.push(...c); }, replaceChildren(...c) { this.children = c; } }) }; return doc.createElement("div"); };

test("the view, drawing and panel only read: frozen inputs are not touched and the selection is unchanged", () => {
  const overlay = deepFreeze(overlayOf(report({ violations: [`Station ${s1.id} platform is too short`] })));
  const frozen = deepFreeze(structuredClone(exp));
  const sel = picked();
  const before = JSON.stringify([sel, selectionOutput(sel, frozen)]);
  const view = buildSelectionView(frozen, sel, overlay);
  drawStationSelection(recorder().ctx, view, screen);
  renderSelectionPanel(fakeBox(), view);
  assert.equal(JSON.stringify([sel, selectionOutput(sel, frozen)]), before);
});

test("the highlight is drawn in its own colour on the selected items, with the engine's word in a chip", () => {
  const overlay = overlayOf(report({ violations: [`Station ${s1.id} platform is too short`] }));
  const r = recorder();
  drawStationSelection(r.ctx, buildSelectionView(exp, picked(), overlay), screen);
  assert.ok(r.calls.some((c) => c[0] === "set" && c[1] === "strokeStyle" && c[2] === "#ffe66d"), "highlight colour");
  assert.ok(r.calls.filter((c) => c[0] === "arc").length >= 2, "an entrance ring, halo + highlight");
  assert.ok(r.calls.some((c) => c[0] === "setLineDash" && c[1].length), "the work area is dashed");
  assert.ok(r.calls.some((c) => c[0] === "fillText" && String(c[1]).includes("엔진: 불가") && String(c[1]).includes("오류 있음")));
  const empty = recorder();
  drawStationSelection(empty.ctx, buildSelectionView(exp, fresh(), overlay), screen);
  assert.deepEqual(empty.calls, [], "nothing selected, nothing drawn");
});

test("the panel says it is read-only, lists the engine's errors, and shows names as text", () => {
  const view = buildSelectionView(exp, picked(), overlayOf(report({ violations: [`Station ${s1.id} platform is too short`] })));
  const box = fakeBox();
  renderSelectionPanel(box, view);
  const texts = box.children.map((c) => c.textContent);
  assert.ok(texts.some((t) => t.includes("읽기 전용")));
  assert.ok(texts.some((t) => t.includes("platform is too short")));
  assert.ok(texts.some((t) => t.includes("출입구 1") && t.includes("환승통로 1") && t.includes("작업장 1")));
  assert.equal(box.hidden, false);
  const notes = view.engine.mapNotes.length;
  assert.ok(notes > 3, "the fixture has more map-side notes than the panel shows");
  assert.equal(texts.filter((t) => t.startsWith("지도 입력")).length, 3, "the first few are listed");
  assert.ok(texts.some((t) => t.includes(`${notes - 3}건 더`)), "and the rest are counted");
  const box2 = fakeBox();
  renderSelectionPanel(box2, { ...view, name: "<img src=x onerror=alert(1)>" });
  assert.ok(box2.children[0].textContent.includes("<img"), "kept as text");
  renderSelectionPanel(box2, buildSelectionView(exp, fresh(), null));
  assert.equal(box2.hidden, true);
  assert.equal(box2.children.length, 0);
});

// --- boundary ---
test("the selection modules do not import the management engine or touch cash, construction state or files", () => {
  for (const f of ["station-selection.mjs", "station-selection-view.mjs", "station-selection-ui.mjs"]) {
    const src = fs.readFileSync(path.join(root, "engine/src/map", f), "utf8");
    for (const m of src.matchAll(/from "([^"]+)"/g)) assert.match(m[1], /^\.\/[a-z-]+\.mjs$|^\.\.\/(projection|geometry)\.mjs$/, `${f} imports ${m[1]}`);
    assert.doesNotMatch(src, /ledger|\.commit\(|\.settle\(|\.post\(|node:fs/, `${f} must not reach engine state or the file system`);
    assert.ok(src.length < 40_000);
  }
});
