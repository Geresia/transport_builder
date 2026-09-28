import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SITE_DESIGN_SESSION_SCHEMA, SITE_DESIGN_EDIT_SCHEMA, SITE_DESIGN_COLLISION_RESULT_SCHEMA,
  parseSiteDesignSession, createDraft, resetDraft,
  moveBodyTo, moveBodyBy, rotateBodyTo, rotateBodyBy, resizeBody, setBodyDepth, validateBodyDepth,
  moveEntrance, addEntrance, removeEntrance, moveWorkAreaBy, resizeWorkAreaBy,
  draftIsEdited, buildSiteDesignEdit, buildCollisionRequest, applyCollisionResult,
  bodyElevationInfo, sceneFromDraft,
} from "../src/map/site-design-session.mjs";
import { buildStationSiteScene } from "../src/map/site-design-scene.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const readJson = (p) => JSON.parse(fs.readFileSync(path.join(root, p), "utf8"));
const clone = (v) => JSON.parse(JSON.stringify(v));

const groundSite = readJson("packs/tokyo/station-examples/01-ground-side-general.station.json");
const deepSite = readJson("packs/tokyo/station-examples/04-deep-station.station.json");

const rawSession = (site, extra = {}) => ({
  schema: SITE_DESIGN_SESSION_SCHEMA, sessionId: "sess-1", stationSite: site, baseRevision: "rev-7", ...extra,
});
const draftFor = (site, extra = {}) => createDraft(parseSiteDesignSession(rawSession(site, extra)).session);

test("rejects a message with the wrong or missing schema", () => {
  assert.equal(parseSiteDesignSession(null).error, "empty-message");
  assert.equal(parseSiteDesignSession({}).error, "unknown-schema");
  assert.equal(parseSiteDesignSession({ schema: "something-else" }).error, "unknown-schema");
  assert.equal(parseSiteDesignSession({ schema: SITE_DESIGN_SESSION_SCHEMA }).error, "missing-sessionId");
  assert.equal(parseSiteDesignSession({ schema: SITE_DESIGN_SESSION_SCHEMA, sessionId: "s" }).error, "missing-or-invalid-stationSite");
  assert.equal(parseSiteDesignSession({ schema: SITE_DESIGN_SESSION_SCHEMA, sessionId: "s", stationSite: { schema: "wrong" } }).error, "missing-or-invalid-stationSite");
  assert.equal(parseSiteDesignSession({ schema: SITE_DESIGN_SESSION_SCHEMA, sessionId: "s", stationSite: groundSite }).error, "missing-baseRevision");
});

test("accepts a well-formed session and carries surroundingSpatialData/initialView through unchanged", () => {
  const { session, error } = parseSiteDesignSession(rawSession(groundSite, { surroundingSpatialData: { buildings: [1] }, initialView: { zoom: 18 } }));
  assert.equal(error, null);
  assert.deepEqual(session.surroundingSpatialData, { buildings: [1] });
  assert.deepEqual(session.initialView, { zoom: 18 });
  assert.equal(session.baseRevision, "rev-7");
});

test("createDraft never mutates the session's stationSite (body, entrance, work-area edits combined)", () => {
  const { session } = parseSiteDesignSession(rawSession(groundSite));
  const before = clone(session.stationSite);
  const draft = createDraft(session);
  moveBodyTo(draft, [139.7, 35.7]);
  rotateBodyBy(draft, 45);
  resizeBody(draft, { lengthMeters: 200, widthMeters: 30 });
  setBodyDepth(draft, 20);
  moveEntrance(draft, groundSite.entranceCandidates[0].entranceId, [139.71, 35.71]);
  addEntrance(draft, [139.72, 35.72]);
  removeEntrance(draft, groundSite.entranceCandidates[1].entranceId);
  moveWorkAreaBy(draft, groundSite.workAreaCandidates[0].workAreaId, 5, 5);
  resizeWorkAreaBy(draft, groundSite.workAreaCandidates[1].workAreaId, 1.5);
  assert.deepEqual(session.stationSite, before);
});

test("draft move/rotate/resize/depth apply and are reflected in draftIsEdited", () => {
  const draft = draftFor(groundSite);
  assert.equal(draftIsEdited(draft), false);

  moveBodyTo(draft, [139.7, 35.7]);
  assert.deepEqual(draft.body.location, [139.7, 35.7]);
  assert.ok(draftIsEdited(draft));

  const fresh = draftFor(groundSite);
  rotateBodyBy(fresh, 30);
  assert.equal(fresh.body.headingDegrees, ((groundSite.bodyHeadingDegrees + 30) % 360 + 360) % 360);

  const fresh2 = draftFor(groundSite);
  resizeBody(fresh2, { lengthMeters: 220, widthMeters: 28 });
  assert.equal(fresh2.body.lengthMeters, 220);
  assert.equal(fresh2.body.widthMeters, 28);

  const fresh3 = draftFor(groundSite);
  setBodyDepth(fresh3, 15);
  assert.equal(fresh3.body.depthMeters, 15);
  assert.ok(draftIsEdited(fresh3));
});

test("moveBodyBy moves the body by an approximate metre offset (round-trip via frameAt)", () => {
  const draft = draftFor(groundSite);
  const before = [...draft.body.location];
  moveBodyBy(draft, 50, 0); // 50 m east
  const dLon = (draft.body.location[0] - before[0]) * 111320 * Math.cos((before[1] * Math.PI) / 180);
  assert.ok(Math.abs(dLon - 50) < 0.5);
  assert.ok(Math.abs(draft.body.location[1] - before[1]) < 1e-4); // negligible north drift
});

test("moving/removing an unknown entrance throws; moving a removed entrance throws", () => {
  const draft = draftFor(groundSite);
  assert.throws(() => moveEntrance(draft, "ent:does-not-exist", [139.7, 35.7]));
  assert.throws(() => removeEntrance(draft, "ent:does-not-exist"));
  const entId = groundSite.entranceCandidates[0].entranceId;
  removeEntrance(draft, entId);
  assert.throws(() => moveEntrance(draft, entId, [139.7, 35.7]));
});

test("requirement 5: setBodyDepth/validateBodyDepth reject non-finite or extreme (contradictory) depth", () => {
  assert.deepEqual(validateBodyDepth(NaN), { valid: false, reason: "not-finite" });
  assert.deepEqual(validateBodyDepth(500), { valid: false, reason: "extreme-depth" });
  assert.deepEqual(validateBodyDepth(-500), { valid: false, reason: "extreme-depth" });
  assert.deepEqual(validateBodyDepth(0), { valid: true, reason: null });
  assert.deepEqual(validateBodyDepth(-20), { valid: true, reason: null }); // elevated is valid
  const draft = draftFor(groundSite);
  assert.throws(() => setBodyDepth(draft, NaN));
  assert.throws(() => setBodyDepth(draft, 1000));
  setBodyDepth(draft, -20); // elevated
  assert.equal(draft.body.depthMeters, -20);
});

test("requirement 2: entrance add — new entrance gets a stable id, kept across further moves, distinct from originals", () => {
  const draft = draftFor(groundSite);
  const id1 = addEntrance(draft, [139.72, 35.72]);
  assert.ok(!groundSite.entranceCandidates.some((e) => e.entranceId === id1));
  moveEntrance(draft, id1, [139.73, 35.73]); // still an "add" with updated location, not a separate entry
  assert.equal(draft.entranceChanges.filter((c) => c.entranceId === id1).length, 1);
  assert.equal(draft.entranceChanges.find((c) => c.entranceId === id1).action, "add");
  assert.deepEqual(draft.entranceChanges.find((c) => c.entranceId === id1).location, [139.73, 35.73]);

  const id2 = addEntrance(draft, [139.74, 35.74]);
  assert.notEqual(id1, id2);
});

test("requirement 2: entrance remove — original entrance keeps its id as a tombstoned 'remove' entry; added-then-removed cancels out", () => {
  const draft = draftFor(groundSite);
  const origId = groundSite.entranceCandidates[0].entranceId;
  removeEntrance(draft, origId);
  assert.deepEqual(draft.entranceChanges, [{ entranceId: origId, action: "remove" }]);

  const addedId = addEntrance(draft, [139.72, 35.72]);
  removeEntrance(draft, addedId);
  assert.equal(draft.entranceChanges.some((c) => c.entranceId === addedId), false); // undone entirely
});

test("requirement 2/ID preservation: sceneFromDraft drops removed entrances, includes added ones, keeps original ids for moved ones", () => {
  const baseScene = buildStationSiteScene(groundSite);
  const draft = draftFor(groundSite);
  const keepMovedId = groundSite.entranceCandidates[0].entranceId;
  const removeId = groundSite.entranceCandidates[1].entranceId;
  moveEntrance(draft, keepMovedId, [139.71, 35.71]);
  removeEntrance(draft, removeId);
  const addedId = addEntrance(draft, [139.72, 35.72]);

  const scene = sceneFromDraft(draft, baseScene);
  assert.equal(scene.entrances.some((e) => e.id === removeId), false);
  const moved = scene.entrances.find((e) => e.id === keepMovedId);
  assert.equal(moved.moved, true);
  assert.equal(moved.added, false);
  const added = scene.entrances.find((e) => e.id === addedId);
  assert.ok(added);
  assert.equal(added.added, true);
  assert.equal(added.blocked, null); // unknown until the parent checks it
  // every other original entrance neither moved nor removed keeps its id and original blocked fact untouched
  const untouched = baseScene.entrances.find((e) => e.id !== keepMovedId && e.id !== removeId);
  const untouchedInScene = scene.entrances.find((e) => e.id === untouched.id);
  assert.equal(untouchedInScene.moved, false);
  assert.equal(untouchedInScene.blocked, untouched.blocked);
});

test("requirement 3/ID preservation: work-area move/resize keep the workAreaId and only replace the polygon", () => {
  const baseScene = buildStationSiteScene(groundSite);
  const draft = draftFor(groundSite);
  const moveId = groundSite.workAreaCandidates[0].workAreaId;
  const resizeId = groundSite.workAreaCandidates[1].workAreaId;
  moveWorkAreaBy(draft, moveId, 10, -5);
  resizeWorkAreaBy(draft, resizeId, 2);
  assert.throws(() => moveWorkAreaBy(draft, "work:does-not-exist", 1, 1));
  assert.throws(() => resizeWorkAreaBy(draft, resizeId, 0));
  assert.throws(() => resizeWorkAreaBy(draft, resizeId, -1));

  const scene = sceneFromDraft(draft, baseScene);
  assert.equal(scene.workAreas.length, baseScene.workAreas.length); // no work areas added or removed
  const moved = scene.workAreas.find((w) => w.id === moveId);
  assert.equal(moved.edited, true);
  assert.equal(moved.blocked, null); // unknown until the parent checks it, never "safe"
  assert.notDeepEqual(moved.polygonXY, baseScene.workAreas.find((w) => w.id === moveId).polygonXY);

  const resized = scene.workAreas.find((w) => w.id === resizeId);
  assert.equal(resized.edited, true);
  const origArea = baseScene.workAreas.find((w) => w.id === resizeId).areaSquareMeters;
  assert.ok(resized.areaSquareMeters === origArea); // the *fact* field is untouched (still original) — only geometry (polygonXY) reflects the resize

  const untouchedId = groundSite.workAreaCandidates[2].workAreaId;
  const untouched = scene.workAreas.find((w) => w.id === untouchedId);
  assert.equal(untouched.edited, false);
  assert.deepEqual(untouched.polygonXY, baseScene.workAreas.find((w) => w.id === untouchedId).polygonXY);
});

test("cancel (resetDraft) fully restores the original shape after body, entrance and work-area edits", () => {
  const { session } = parseSiteDesignSession(rawSession(groundSite));
  const draft = createDraft(session);
  moveBodyTo(draft, [139.9, 35.9]);
  rotateBodyBy(draft, 90);
  resizeBody(draft, { lengthMeters: 999, widthMeters: 99 });
  setBodyDepth(draft, 50);
  moveEntrance(draft, groundSite.entranceCandidates[0].entranceId, [139.9, 35.9]);
  addEntrance(draft, [139.95, 35.95]);
  removeEntrance(draft, groundSite.entranceCandidates[1].entranceId);
  moveWorkAreaBy(draft, groundSite.workAreaCandidates[0].workAreaId, 20, 20);
  assert.ok(draftIsEdited(draft));

  const restored = resetDraft(session);
  assert.deepEqual(restored.body, draft.original.body);
  assert.equal(restored.entranceChanges.length, 0);
  assert.equal(restored.workAreaChanges.length, 0);
  assert.equal(draftIsEdited(restored), false);
  // and the restored draft can be re-edited from scratch (a fresh cancel doesn't leave the session unusable)
  moveBodyTo(restored, [139.8, 35.8]);
  assert.ok(draftIsEdited(restored));
});

test("re-edit after cancel produces an edit message with fresh, correct values (apply -> cancel -> re-edit -> apply)", () => {
  const { session } = parseSiteDesignSession(rawSession(groundSite, { baseRevision: "rev-x" }));
  let draft = createDraft(session);
  rotateBodyTo(draft, 200);
  const firstEdit = buildSiteDesignEdit(draft, "submitted");
  assert.equal(firstEdit.body.headingDegrees, 200);

  draft = resetDraft(session); // cancel
  assert.equal(draft.body.headingDegrees, groundSite.bodyHeadingDegrees);

  rotateBodyTo(draft, 77);
  const secondEdit = buildSiteDesignEdit(draft, "submitted");
  assert.equal(secondEdit.body.headingDegrees, 77);
  assert.equal(secondEdit.baseRevision, "rev-x"); // baseRevision survives the whole apply/cancel/re-edit cycle
});

test("buildSiteDesignEdit produces the transitline.site-design-edit/1 schema, action-tagged entrance/work-area changes, and keeps baseRevision", () => {
  const { session } = parseSiteDesignSession(rawSession(groundSite, { baseRevision: "rev-42" }));
  const draft = createDraft(session);
  moveBodyTo(draft, [139.7, 35.7]);
  rotateBodyTo(draft, 15);
  resizeBody(draft, { lengthMeters: 180 });
  setBodyDepth(draft, 12);
  const movedEntId = groundSite.entranceCandidates[0].entranceId;
  moveEntrance(draft, movedEntId, [139.71, 35.71]);
  const addedEntId = addEntrance(draft, [139.72, 35.72]);
  const removedEntId = groundSite.entranceCandidates[1].entranceId;
  removeEntrance(draft, removedEntId);
  const workId = groundSite.workAreaCandidates[0].workAreaId;
  moveWorkAreaBy(draft, workId, 5, 5);

  const edit = buildSiteDesignEdit(draft, "submitted");
  assert.equal(edit.schema, SITE_DESIGN_EDIT_SCHEMA);
  assert.equal(edit.sessionId, "sess-1");
  assert.equal(edit.stationSiteId, groundSite.stationSiteId);
  assert.equal(edit.baseRevision, "rev-42");
  assert.deepEqual(edit.body, { location: [139.7, 35.7], headingDegrees: 15, lengthMeters: 180, widthMeters: draft.body.widthMeters, depthMeters: 12 });
  assert.deepEqual(new Set(edit.entranceChanges.map((c) => c.entranceId)), new Set([movedEntId, addedEntId, removedEntId]));
  assert.deepEqual(edit.entranceChanges.find((c) => c.entranceId === movedEntId), { entranceId: movedEntId, action: "move", location: [139.71, 35.71] });
  assert.deepEqual(edit.entranceChanges.find((c) => c.entranceId === addedEntId), { entranceId: addedEntId, action: "add", location: [139.72, 35.72] });
  assert.deepEqual(edit.entranceChanges.find((c) => c.entranceId === removedEntId), { entranceId: removedEntId, action: "remove" });
  assert.equal(edit.workAreaChanges.length, 1);
  assert.equal(edit.workAreaChanges[0].workAreaId, workId);
  assert.equal(edit.status, "submitted");

  assert.throws(() => buildSiteDesignEdit(draft, "bogus"));
  assert.equal(buildSiteDesignEdit(draft, "cancelled").status, "cancelled");
});

test("requirement 6/7: collision feedback only ever echoes the parent's verdict, keyed by requestId, and null is never shown as safe", () => {
  const draft = draftFor(groundSite);
  moveBodyTo(draft, [139.7, 35.7]);
  const req = buildCollisionRequest(draft, "req-1");
  assert.equal(req.schema, "transitline.site-design-collision-request/1");
  assert.equal(req.sessionId, "sess-1");
  assert.equal(req.requestId, "req-1");

  // before any reply: unknown, not "no collision"
  assert.equal(draft.collisionFeedback, null);

  // a stale reply (wrong requestId) is ignored
  applyCollisionResult(draft, { schema: SITE_DESIGN_COLLISION_RESULT_SCHEMA, sessionId: "sess-1", requestId: "req-0", bodyCollision: true }, "req-1");
  assert.equal(draft.collisionFeedback, null);

  // a reply for a different session is ignored
  applyCollisionResult(draft, { schema: SITE_DESIGN_COLLISION_RESULT_SCHEMA, sessionId: "other", requestId: "req-1", bodyCollision: true }, "req-1");
  assert.equal(draft.collisionFeedback, null);

  const entId = groundSite.entranceCandidates[0].entranceId;
  const workId = groundSite.workAreaCandidates[0].workAreaId;
  applyCollisionResult(draft, {
    schema: SITE_DESIGN_COLLISION_RESULT_SCHEMA, sessionId: "sess-1", requestId: "req-1",
    bodyCollision: true,
    entranceCollisions: [{ entranceId: entId, collides: false }, { entranceId: "ent:missing", collides: "yes" }], // non-boolean must become null, not truthy/falsy
    workAreaCollisions: [{ workAreaId: workId, collides: null }], // explicit null from the parent must stay null
  }, "req-1");
  assert.equal(draft.collisionFeedback.bodyCollision, true);
  assert.equal(draft.collisionFeedback.entranceCollisions[entId], false);
  assert.equal(draft.collisionFeedback.entranceCollisions["ent:missing"], null);
  assert.equal(draft.collisionFeedback.workAreaCollisions[workId], null);
});

test("bodyElevationInfo: underground/elevated derivation is display-only geometry", () => {
  const draft = draftFor(deepSite);
  assert.equal(draft.body.depthMeters, 38);
  const info = bodyElevationInfo(draft, deepSite.groundElevationMeters);
  assert.equal(info.isUnderground, true);
  assert.equal(info.isElevated, false);
  assert.equal(info.trackElevationMeters, Math.round((deepSite.groundElevationMeters - 38) * 10) / 10);

  const surfaceDraft = draftFor(groundSite);
  const surfaceInfo = bodyElevationInfo(surfaceDraft, groundSite.groundElevationMeters);
  assert.equal(surfaceInfo.isUnderground, false);
  assert.equal(surfaceInfo.isElevated, false);
});

test("sceneFromDraft re-derives body/entrance/work-area geometry from the draft without touching facts", () => {
  const baseScene = buildStationSiteScene(groundSite);
  const draft = draftFor(groundSite);
  const entId = groundSite.entranceCandidates[0].entranceId;
  moveBodyTo(draft, [139.7, 35.7]);
  rotateBodyBy(draft, 20);
  moveEntrance(draft, entId, [139.71, 35.71]);

  const scene = sceneFromDraft(draft, baseScene);
  assert.equal(scene.body.edited, true);
  assert.equal(scene.body.collision, null); // never computed here
  assert.equal(scene.body.polygonXY.length, baseScene.body.polygonXY.length);
  assert.deepEqual(scene.facts, baseScene.facts); // still the ORIGINAL station-site facts, not fabricated

  const movedEntrance = scene.entrances.find((e) => e.id === entId);
  assert.equal(movedEntrance.moved, true);
  assert.equal(movedEntrance.blocked, null); // unknown until the parent's collision result arrives
  const untouchedEntrance = scene.entrances.find((e) => e.id !== entId);
  assert.equal(untouchedEntrance.moved, false);
});

test("never carries a cost, duration, risk or cash figure anywhere in the session/draft/edit/collision objects", () => {
  const draft = draftFor(groundSite);
  moveBodyTo(draft, [139.7, 35.7]);
  moveEntrance(draft, groundSite.entranceCandidates[0].entranceId, [139.71, 35.71]);
  addEntrance(draft, [139.72, 35.72]);
  moveWorkAreaBy(draft, groundSite.workAreaCandidates[0].workAreaId, 3, 3);
  const edit = buildSiteDesignEdit(draft, "submitted");
  const req = buildCollisionRequest(draft, "req-1");
  const baseScene = buildStationSiteScene(groundSite);
  const scene = sceneFromDraft(draft, baseScene);

  const forbidden = /cost|budget|price|cash|duration|schedule|days|months|risk|probability|score/i;
  const walk = (v, prefix = "") => {
    if (v && typeof v === "object") {
      for (const [k, child] of Object.entries(v)) {
        assert.doesNotMatch(k, forbidden, `unexpected key "${prefix}${k}"`);
        walk(child, `${prefix}${k}.`);
      }
    }
  };
  // draft.original/body/entranceChanges/workAreaChanges/edit/request only — the merged `scene` still
  // legitimately carries the ORIGINAL site's own `facts`/`unknownReasons` text (inherited read-only from
  // station-site.mjs, already guarded by site-design-scene.test.mjs), so this check targets the new
  // session/draft/edit/request surfaces plus the parts of `scene` this module itself derives.
  walk(draft.body); walk(draft.entranceChanges); walk(draft.workAreaChanges); walk(edit); walk(req);
  walk(scene.body); for (const e of scene.entrances) walk(e); for (const w of scene.workAreas) walk(w);
});
