import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildNewTownDevelopment } from "../src/map/new-town-development.mjs";
import {
  NEW_TOWN_DOC_VERSION, activeDevelopments, activePhases, addDevelopment, addPhase, deactivateDevelopment, deactivatePhase, drawnDevelopmentsOf, insertVertex, moveDevelopment, movePhase, moveVertex,
  newNewTownDoc, nextDevelopmentKey, removeDevelopment, removePhase, removeVertex, reorderPhase, restoreDevelopment, restoreNewTownDoc, restorePhase, serializeNewTownDoc, setPolygon, setRailRefs,
  setStationRefs, toDrawnDevelopment, updateDevelopment, updatePhase,
} from "../src/map/new-town-development-editor.mjs";
import { makeSpatialContext } from "../src/map/spatial.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const json = (value) => JSON.stringify(value);
const rect = (x, y, w, h) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
const pack = (id = "nt-test", version = "1") => ({ manifest: { id, version, bbox: [-1, -1, 1, 1], data: { license: "CC0-1.0", attribution: [] } }, demand: { points: [] } });
const build = (doc, key = "town-1") => buildNewTownDevelopment(drawnDevelopmentsOf(doc).find((d) => d.key === key), { pack: pack(), spatial: makeSpatialContext(), plans: [], externalNetworks: [] });

const fresh = () => {
  const doc = newNewTownDoc("nt-test", "1");
  addDevelopment(doc, { name: "Test town" });
  addPhase(doc, "town-1", { name: "One", polygon: rect(0, 0, 0.01, 0.01), playerDeclaredLandUse: "housing", playerDeclaredDeliveryOrder: 1 });
  addPhase(doc, "town-1", { name: "Two", polygon: rect(0.02, 0, 0.01, 0.01), playerDeclaredLandUse: "employment" });
  addPhase(doc, "town-1", { name: "Three" });
  return doc;
};

test("developments and phases get keys that only count up; an explicit key is checked; a removed key is never given out again", () => {
  const doc = newNewTownDoc("nt-test", "1");
  assert.deepEqual([doc.version, doc.packId, doc.packVersion, doc.developments], [NEW_TOWN_DOC_VERSION, "nt-test", "1", []]);
  assert.equal(nextDevelopmentKey(doc), "town-1");
  const a = addDevelopment(doc, { name: "A" });
  const b = addDevelopment(doc);
  assert.deepEqual([a.key, b.key, b.name, a.active, a.deleted], ["town-1", "town-2", null, true, false]);
  assert.throws(() => addDevelopment(doc, { key: "town-2" }), /already used/);
  addDevelopment(doc, { key: "example:mine" });
  // removing a development leaves a tombstone: its key is not reused, by the counter or by hand
  removeDevelopment(doc, "town-2");
  assert.equal(nextDevelopmentKey(doc), "town-3");
  assert.equal(addDevelopment(doc).key, "town-3");
  assert.throws(() => addDevelopment(doc, { key: "town-2" }), /already used/);
  assert.deepEqual(activeDevelopments(doc).map((d) => d.key), ["town-1", "example:mine", "town-3"]);
  assert.throws(() => addPhase(doc, "town-2"), /Unknown development/, "a removed development cannot be edited");
  // phases
  const p1 = addPhase(doc, "town-1", { name: "P1" });
  const p2 = addPhase(doc, "town-1");
  assert.deepEqual([p1.key, p2.key], ["phase-1", "phase-2"]);
  removePhase(doc, "town-1", "phase-2");
  assert.equal(addPhase(doc, "town-1").key, "phase-3", "the key of a removed phase is not handed out again");
  assert.throws(() => addPhase(doc, "town-1", { key: "phase-2" }), /already used/);
  assert.equal(addPhase(doc, "town-1", { key: "phase-9" }).key, "phase-9");
  assert.equal(addPhase(doc, "town-1").key, "phase-10", "a stated key moves the counter past itself");
  assert.deepEqual(activePhases(doc.developments[0]).map((p) => p.key), ["phase-1", "phase-3", "phase-9", "phase-10"]);
  assert.deepEqual(doc.developments[0].phases.filter((p) => p.deleted).map((p) => p.key), ["phase-2"]);
  assert.throws(() => removePhase(doc, "town-1", "phase-2"), /Unknown phase/);
});

test("the keys are not reused after a save and load either, even when the saved counter was edited down or the tombstone is all that is left", () => {
  const doc = fresh();
  removePhase(doc, "town-1", "phase-3");
  removeDevelopment(doc, addDevelopment(doc).key);
  const restored = restoreNewTownDoc(serializeNewTownDoc(doc), pack()).doc;
  assert.equal(addPhase(restored, "town-1").key, "phase-4");
  assert.equal(addDevelopment(restored).key, "town-3");
  const saved = JSON.parse(serializeNewTownDoc(doc));
  delete saved.developments[0].phaseSeq; // a hand-edited counter
  const edited = restoreNewTownDoc(JSON.stringify(saved), pack()).doc;
  assert.equal(addPhase(edited, "town-1").key, "phase-4", "the counter is rebuilt from the keys that are there, tombstones included");
});

test("editing the polygon: set, insert, move and remove a vertex, shift a phase or the whole development; ids never change, revisions do", () => {
  const doc = fresh();
  const before = build(doc);
  const ids = before.phases.map((p) => p.phaseId);
  insertVertex(doc, "town-1", "phase-1", 2, [0.012, 0.006]);
  assert.equal(doc.developments[0].phases[0].polygon.length, 5);
  moveVertex(doc, "town-1", "phase-1", 2, [0.0125, 0.0065]);
  assert.deepEqual(doc.developments[0].phases[0].polygon[2], [0.0125, 0.0065]);
  removeVertex(doc, "town-1", "phase-1", 2);
  assert.deepEqual(doc.developments[0].phases[0].polygon, rect(0, 0, 0.01, 0.01));
  assert.throws(() => { removeVertex(doc, "town-1", "phase-1", 0); removeVertex(doc, "town-1", "phase-1", 0); }, /at least three/);
  assert.equal(doc.developments[0].phases[0].polygon.length, 3);
  setPolygon(doc, "town-1", "phase-1", rect(0, 0, 0.01, 0.01));
  assert.throws(() => setPolygon(doc, "town-1", "phase-1", [[0, 0], [1, 1]]), /at least three/);
  assert.throws(() => setPolygon(doc, "town-1", "phase-1", [[0, 0], [1, 1], [NaN, 2]]), /finite/);
  assert.throws(() => insertVertex(doc, "town-1", "phase-1", 9, [0, 0]), /No such position/);
  assert.throws(() => moveVertex(doc, "town-1", "phase-1", -1, [0, 0]), /No such vertex/);
  assert.throws(() => insertVertex(doc, "town-1", "phase-3", 0, [0, 0]), /no polygon yet/);
  assert.equal(doc.developments[0].phases[0].polygon.length, 4, "a refused edit changes nothing");
  assert.equal(json(build(doc)), json(before));
  movePhase(doc, "town-1", "phase-1", 0.001, 0.002);
  assert.deepEqual(doc.developments[0].phases[0].polygon[0], [0.001, 0.002]);
  const moved = build(doc);
  assert.deepEqual(moved.phases.map((p) => p.phaseId), ids);
  assert.notEqual(moved.phases[0].phaseRevision, before.phases[0].phaseRevision);
  assert.equal(moved.phases[1].phaseRevision, before.phases[1].phaseRevision, "the other phases are as they were");
  assert.equal(moved.developmentId, before.developmentId);
  assert.notEqual(moved.developmentRevision, before.developmentRevision);
  moveDevelopment(doc, "town-1", 0.5, 0.5);
  assert.deepEqual(doc.developments[0].phases[1].polygon[0], [0.52, 0.5]);
  assert.equal(doc.developments[0].phases[2].polygon, null, "a phase with no polygon stays without one");
  assert.deepEqual(build(doc).phases.map((p) => p.phaseId), ids);
  // a polygon that was never drawn: setPolygon draws it
  setPolygon(doc, "town-1", "phase-3", rect(0.7, 0.7, 0.01, 0.01));
  assert.ok(build(doc).phases[2].areaSquareMeters > 0);
  setPolygon(doc, "town-1", "phase-3", null);
  assert.equal(build(doc).phases[2].areaSquareMeters, null);
});

test("reordering moves a phase's place and sequence, never its key or id; the removed ones stay at the end", () => {
  const doc = fresh();
  removePhase(doc, "town-1", "phase-2");
  addPhase(doc, "town-1", { name: "Four" });
  const ids = Object.fromEntries(build(doc).phases.map((p) => [p.key, p.phaseId]));
  assert.deepEqual(build(doc).phases.map((p) => [p.key, p.sequence]), [["phase-1", 1], ["phase-3", 2], ["phase-4", 3]]);
  reorderPhase(doc, "town-1", "phase-4", 0);
  const after = build(doc);
  assert.deepEqual(after.phases.map((p) => [p.key, p.sequence]), [["phase-4", 1], ["phase-1", 2], ["phase-3", 3]]);
  assert.deepEqual(Object.fromEntries(after.phases.map((p) => [p.key, p.phaseId])), ids);
  assert.deepEqual(doc.developments[0].phases.map((p) => [p.key, p.deleted]), [["phase-4", false], ["phase-1", false], ["phase-3", false], ["phase-2", true]]);
  reorderPhase(doc, "town-1", "phase-4", 2);
  assert.deepEqual(build(doc).phases.map((p) => p.key), ["phase-1", "phase-3", "phase-4"]);
  assert.throws(() => reorderPhase(doc, "town-1", "phase-4", 3), /No such position/);
  assert.throws(() => reorderPhase(doc, "town-1", "phase-4", -1), /No such position/);
  assert.throws(() => reorderPhase(doc, "town-1", "phase-2", 0), /Unknown phase/);
  // the same order again is no change, not even in the revision
  const same = build(doc).developmentRevision;
  reorderPhase(doc, "town-1", "phase-1", 0);
  assert.equal(build(doc).developmentRevision, same);
});

test("switching off and back on loses nothing: a phase or a development keeps its id, polygon, declarations and place", () => {
  const doc = fresh();
  setStationRefs(doc, "town-1", "phase-1", [{ stationId: "s1" }]);
  const before = build(doc);
  deactivatePhase(doc, "town-1", "phase-2");
  const off = build(doc);
  assert.deepEqual([off.phases[1].active, off.activePhaseCount, off.phaseCount], [false, 2, 3]);
  assert.equal(off.phases[1].areaSquareMeters, before.phases[1].areaSquareMeters, "its polygon and facts are still there");
  assert.notEqual(off.developmentRevision, before.developmentRevision);
  restorePhase(doc, "town-1", "phase-2");
  assert.equal(json(build(doc)), json(before), "restored: exactly as it was");
  deactivateDevelopment(doc, "town-1");
  const dev = drawnDevelopmentsOf(doc);
  assert.deepEqual([dev.length, dev[0].active], [1, false], "a switched-off development is still drawn, flagged inactive");
  assert.equal(build(doc).active, false);
  restoreDevelopment(doc, "town-1");
  assert.equal(json(build(doc)), json(before));
  // removed ones are not drawn at all
  removePhase(doc, "town-1", "phase-3");
  assert.deepEqual(drawnDevelopmentsOf(doc)[0].phases.map((p) => p.key), ["phase-1", "phase-2"]);
  removeDevelopment(doc, "town-1");
  assert.deepEqual(drawnDevelopmentsOf(doc), []);
  assert.throws(() => deactivateDevelopment(doc, "town-1"), /Unknown development/);
  assert.throws(() => restorePhase(doc, "town-1", "phase-1"), /Unknown development/);
});

test("renaming and updating declarations changes no id and no revision (names) or only the revision (declarations)", () => {
  const doc = fresh();
  const before = build(doc);
  updateDevelopment(doc, "town-1", { name: "Renamed town" });
  updatePhase(doc, "town-1", "phase-1", { name: "Renamed phase" });
  const renamed = build(doc);
  assert.equal(renamed.name, "Renamed town");
  assert.deepEqual([renamed.developmentId, renamed.developmentRevision], [before.developmentId, before.developmentRevision]);
  assert.deepEqual(renamed.phases.map((p) => [p.phaseId, p.phaseRevision]), before.phases.map((p) => [p.phaseId, p.phaseRevision]));
  updatePhase(doc, "town-1", "phase-1", { playerDeclaredLandUse: "mixed", playerDeclaredDeliveryOrder: 4 });
  const declared = build(doc);
  assert.deepEqual([declared.phases[0].playerDeclaredLandUse, declared.phases[0].playerDeclaredDeliveryOrder, declared.phases[0].phaseId], ["mixed", 4, before.phases[0].phaseId]);
  assert.notEqual(declared.phases[0].phaseRevision, before.phases[0].phaseRevision);
  updatePhase(doc, "town-1", "phase-1", { playerDeclaredLandUse: null, playerDeclaredDeliveryOrder: null });
  assert.deepEqual([doc.developments[0].phases[0].playerDeclaredLandUse, doc.developments[0].phases[0].playerDeclaredDeliveryOrder], [null, null], "the player can take a declaration back");
  assert.throws(() => updatePhase(doc, "town-1", "phase-1", { playerDeclaredLandUse: "" }), /short text/);
  assert.throws(() => updatePhase(doc, "town-1", "phase-1", { playerDeclaredLandUse: "x".repeat(65) }), /short text/);
  assert.throws(() => updatePhase(doc, "town-1", "phase-1", { playerDeclaredDeliveryOrder: 0 }), /whole number/);
  assert.throws(() => updatePhase(doc, "town-1", "phase-1", { playerDeclaredDeliveryOrder: 2.5 }), /whole number/);
  assert.throws(() => addPhase(doc, "town-1", { playerDeclaredDeliveryOrder: "1" }), /whole number/);
  assert.equal(doc.developments[0].phases.length, 3, "a refused phase is not added");
  assert.equal(addPhase(doc, "town-1").key, "phase-4", "and it did not use up a key");
  assert.equal(updatePhase(doc, "town-1", "phase-1", { name: undefined, unknownField: 5 }).unknownField, undefined, "only the known fields are taken");
});

test("the player's station sites and rail lines: not stated (null), states there are none ([]), or a list, and the document keeps its own copy", () => {
  const doc = fresh();
  const phase = doc.developments[0].phases[0];
  assert.deepEqual([phase.stationRefs, phase.railRefs], [null, null]);
  const refs = [{ stationId: "s1" }];
  setStationRefs(doc, "town-1", "phase-1", refs);
  refs[0].stationId = "tampered";
  refs.push({ stationId: "s2" });
  assert.deepEqual(phase.stationRefs, [{ stationId: "s1" }]);
  setRailRefs(doc, "town-1", "phase-1", []);
  assert.deepEqual(phase.railRefs, []);
  const drawn = drawnDevelopmentsOf(doc)[0].phases[0];
  assert.deepEqual(drawn.access, { stationRefs: [{ stationId: "s1" }], railRefs: [] });
  drawn.access.stationRefs.push({ stationId: "x" });
  drawn.polygon.length = 0;
  assert.equal(phase.stationRefs.length, 1);
  assert.equal(phase.polygon.length, 4, "the drawn copy shares nothing with the document");
  setStationRefs(doc, "town-1", "phase-1", null);
  assert.equal(phase.stationRefs, null);
  assert.equal(build(doc).phases[0].unknownReasons.stationSiteRefs, "not-stated");
  setStationRefs(doc, "town-1", "phase-1", []);
  assert.deepEqual(build(doc).phases[0].stationSiteRefs, []);
  // what goes in is copied too
  const polygon = rect(0, 0, 0.01, 0.01);
  const added = addPhase(doc, "town-1", { polygon });
  polygon[0][0] = 99;
  assert.equal(added.polygon[0][0], 0);
});

test("serialize and restore: the document comes back as it was, with the same ids and revisions", () => {
  const doc = fresh();
  setStationRefs(doc, "town-1", "phase-1", []);
  deactivatePhase(doc, "town-1", "phase-2");
  removePhase(doc, "town-1", "phase-3");
  addDevelopment(doc, { name: "Second" });
  const text = serializeNewTownDoc(doc);
  assert.equal(typeof text, "string");
  const { doc: back, rejected, warnings } = restoreNewTownDoc(text, pack());
  assert.deepEqual([rejected, warnings], [false, []]);
  assert.equal(serializeNewTownDoc(back), text);
  assert.equal(json(build(back)), json(build(doc)));
  assert.equal(json(drawnDevelopmentsOf(back)), json(drawnDevelopmentsOf(doc)));
  // the restored document is its own copy
  back.developments[0].phases[0].polygon[0][0] = 5;
  assert.equal(JSON.parse(text).developments[0].phases[0].polygon[0][0], 0);
  // nothing saved: the current document (or a fresh one) is what you have
  assert.deepEqual(restoreNewTownDoc(null, pack()).doc, newNewTownDoc("nt-test", "1"));
  assert.equal(restoreNewTownDoc(undefined, pack(), { current: doc }).doc, doc);
});

test("a saved document is never applied to another pack, nor to a version it does not know; the document being edited stays as it is", () => {
  const doc = fresh();
  const text = serializeNewTownDoc(doc);
  const current = fresh();
  const other = restoreNewTownDoc(text, pack("another-pack"), { current });
  assert.deepEqual([other.rejected, other.warnings, other.doc === current], [true, [{ code: "new-town-doc-other-pack", savedPackId: "nt-test" }], true]);
  assert.equal(serializeNewTownDoc(current), serializeNewTownDoc(fresh()), "the current document was not touched");
  const noCurrent = restoreNewTownDoc(text, pack("another-pack"));
  assert.deepEqual([noCurrent.rejected, noCurrent.doc.packId, noCurrent.doc.developments], [true, "another-pack", []]);
  const refused = (value, code, extra = {}) => {
    const r = restoreNewTownDoc(typeof value === "string" ? value : JSON.stringify(value), pack(), { current });
    assert.deepEqual([r.rejected, r.warnings, r.doc === current], [true, [{ code, ...extra }], true], String(code));
  };
  refused("{ not json", "new-town-doc-unreadable");
  refused("", "new-town-doc-unreadable");
  refused({ ...JSON.parse(text), version: 2 }, "new-town-doc-version", { version: 2 });
  refused({ ...JSON.parse(text), version: undefined }, "new-town-doc-version", { version: null });
  refused({ ...JSON.parse(text), developments: "none" }, "new-town-doc-version", { version: 1 });
  refused({ ...JSON.parse(text), developments: [{ key: "town-1" }] }, "new-town-doc-version", { version: 1 });
  refused({ ...JSON.parse(text), developments: [{ key: "town-1", phases: [{ polygon: null }] }] }, "new-town-doc-version", { version: 1 });
  refused({ ...JSON.parse(text), developments: [null] }, "new-town-doc-version", { version: 1 });
  refused({ ...JSON.parse(text), packId: undefined }, "new-town-doc-other-pack", { savedPackId: null });
  // the same pack at another version is accepted, and said
  const newer = restoreNewTownDoc(text, pack("nt-test", "2"));
  assert.deepEqual([newer.rejected, newer.warnings, newer.doc.packVersion], [false, [{ code: "pack-version-mismatch", saved: "1", current: "2" }], "2"]);
  assert.equal(newer.doc.developments.length, 1);
});

test("the editor holds no storage and no clock, imports nothing, and a development drawn by hand can be edited like any other", () => {
  const src = fs.readFileSync(path.join(here, "..", "src", "map", "new-town-development-editor.mjs"), "utf8");
  const code = src.replace(/\/\/.*$/gm, "");
  assert.equal(/localStorage|sessionStorage|indexedDB|Date\.now|new Date|Math\.random|node:fs|fetch\(|window\.|document\./.test(code), false);
  assert.deepEqual([...src.matchAll(/from "([^"]+)"/g)], [], "the editor imports nothing");
  const doc = newNewTownDoc("nt-test");
  assert.equal(doc.packVersion, null);
  addDevelopment(doc, { key: "mine", name: "By hand" });
  addPhase(doc, "mine", { key: "north", polygon: rect(0, 0, 0.01, 0.01) });
  addPhase(doc, "mine");
  assert.deepEqual(doc.developments[0].phases.map((p) => p.key), ["north", "phase-1"]);
  assert.deepEqual(toDrawnDevelopment(doc.developments[0]).phases.map((p) => [p.key, p.sequence]), [["north", 1], ["phase-1", 2]]);
  assert.equal(build(doc, "mine").phases[0].areaSquareMeters > 0, true);
});
