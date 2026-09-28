import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SITE_DESIGN_SESSION_SCHEMA, SITE_DESIGN_EDIT_SCHEMA, SITE_DESIGN_COLLISION_RESULT_SCHEMA,
  parseSiteDesignSession, createDraft, resetDraft,
  moveBodyTo, moveBodyBy, rotateBodyTo, rotateBodyBy, resizeBody, setBodyDepth, moveEntrance,
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

test("createDraft never mutates the session's stationSite", () => {
  const { session } = parseSiteDesignSession(rawSession(groundSite));
  const before = clone(session.stationSite);
  const draft = createDraft(session);
  moveBodyTo(draft, [139.7, 35.7]);
  rotateBodyBy(draft, 45);
  resizeBody(draft, { lengthMeters: 200, widthMeters: 30 });
  setBodyDepth(draft, 20);
  moveEntrance(draft, groundSite.entranceCandidates[0].entranceId, [139.71, 35.71]);
  assert.deepEqual(session.stationSite, before);
});

test("draft move/rotate/resize/depth apply and are reflected in draftIsEdited", () => {
  const { session } = parseSiteDesignSession(rawSession(groundSite));
  const draft = createDraft(session);
  assert.equal(draftIsEdited(draft), false);

  moveBodyTo(draft, [139.7, 35.7]);
  assert.deepEqual(draft.body.location, [139.7, 35.7]);
  assert.ok(draftIsEdited(draft));

  const fresh = createDraft(session);
  rotateBodyBy(fresh, 30);
  assert.equal(fresh.body.headingDegrees, ((groundSite.bodyHeadingDegrees + 30) % 360 + 360) % 360);

  const fresh2 = createDraft(session);
  resizeBody(fresh2, { lengthMeters: 220, widthMeters: 28 });
  assert.equal(fresh2.body.lengthMeters, 220);
  assert.equal(fresh2.body.widthMeters, 28);

  const fresh3 = createDraft(session);
  setBodyDepth(fresh3, 15);
  assert.equal(fresh3.body.depthMeters, 15);
  assert.ok(draftIsEdited(fresh3));
});

test("moveBodyBy moves the body by an approximate metre offset (round-trip via frameAt)", () => {
  const { session } = parseSiteDesignSession(rawSession(groundSite));
  const draft = createDraft(session);
  const before = [...draft.body.location];
  moveBodyBy(draft, 50, 0); // 50 m east
  const dLon = (draft.body.location[0] - before[0]) * 111320 * Math.cos((before[1] * Math.PI) / 180);
  assert.ok(Math.abs(dLon - 50) < 0.5);
  assert.ok(Math.abs(draft.body.location[1] - before[1]) < 1e-4); // negligible north drift
});

test("moving an unknown entrance throws", () => {
  const { session } = parseSiteDesignSession(rawSession(groundSite));
  const draft = createDraft(session);
  assert.throws(() => moveEntrance(draft, "ent:does-not-exist", [139.7, 35.7]));
});

test("cancel (resetDraft) fully restores the original shape after edits", () => {
  const { session } = parseSiteDesignSession(rawSession(groundSite));
  const draft = createDraft(session);
  moveBodyTo(draft, [139.9, 35.9]);
  rotateBodyBy(draft, 90);
  resizeBody(draft, { lengthMeters: 999, widthMeters: 99 });
  setBodyDepth(draft, 50);
  moveEntrance(draft, groundSite.entranceCandidates[0].entranceId, [139.9, 35.9]);
  assert.ok(draftIsEdited(draft));

  const restored = resetDraft(session);
  assert.deepEqual(restored.body, draft.original.body);
  assert.equal(restored.entranceChanges.length, 0);
  assert.equal(draftIsEdited(restored), false);
});

test("buildSiteDesignEdit produces the transitline.site-design-edit/1 schema and keeps baseRevision", () => {
  const { session } = parseSiteDesignSession(rawSession(groundSite, { baseRevision: "rev-42" }));
  const draft = createDraft(session);
  moveBodyTo(draft, [139.7, 35.7]);
  rotateBodyTo(draft, 15);
  resizeBody(draft, { lengthMeters: 180 });
  setBodyDepth(draft, 12);
  const entId = groundSite.entranceCandidates[0].entranceId;
  moveEntrance(draft, entId, [139.71, 35.71]);

  const edit = buildSiteDesignEdit(draft, "submitted");
  assert.equal(edit.schema, SITE_DESIGN_EDIT_SCHEMA);
  assert.equal(edit.sessionId, "sess-1");
  assert.equal(edit.stationSiteId, groundSite.stationSiteId);
  assert.equal(edit.baseRevision, "rev-42");
  assert.deepEqual(edit.body, { location: [139.7, 35.7], headingDegrees: 15, lengthMeters: 180, widthMeters: draft.body.widthMeters, depthMeters: 12 });
  assert.deepEqual(edit.entranceChanges, [{ entranceId: entId, location: [139.71, 35.71] }]);
  assert.equal(edit.status, "submitted");

  assert.throws(() => buildSiteDesignEdit(draft, "bogus"));
  assert.equal(buildSiteDesignEdit(draft, "cancelled").status, "cancelled");
});

test("collision feedback only ever echoes the parent's verdict, keyed by requestId, never computed locally", () => {
  const { session } = parseSiteDesignSession(rawSession(groundSite));
  const draft = createDraft(session);
  moveBodyTo(draft, [139.7, 35.7]);
  const req = buildCollisionRequest(draft, "req-1");
  assert.equal(req.schema, "transitline.site-design-collision-request/1");
  assert.equal(req.sessionId, "sess-1");
  assert.equal(req.requestId, "req-1");

  // a stale reply (wrong requestId) is ignored
  applyCollisionResult(draft, { schema: SITE_DESIGN_COLLISION_RESULT_SCHEMA, sessionId: "sess-1", requestId: "req-0", bodyCollision: true }, "req-1");
  assert.equal(draft.collisionFeedback, null);

  // a reply for a different session is ignored
  applyCollisionResult(draft, { schema: SITE_DESIGN_COLLISION_RESULT_SCHEMA, sessionId: "other", requestId: "req-1", bodyCollision: true }, "req-1");
  assert.equal(draft.collisionFeedback, null);

  const entId = groundSite.entranceCandidates[0].entranceId;
  applyCollisionResult(draft, {
    schema: SITE_DESIGN_COLLISION_RESULT_SCHEMA, sessionId: "sess-1", requestId: "req-1",
    bodyCollision: true, entranceCollisions: [{ entranceId: entId, collides: false }],
  }, "req-1");
  assert.equal(draft.collisionFeedback.bodyCollision, true);
  assert.equal(draft.collisionFeedback.entranceCollisions[entId], false);
});

test("bodyElevationInfo: underground/elevated derivation is display-only geometry", () => {
  const { session } = parseSiteDesignSession(rawSession(deepSite));
  const draft = createDraft(session);
  assert.equal(draft.body.depthMeters, 38);
  const info = bodyElevationInfo(draft, deepSite.groundElevationMeters);
  assert.equal(info.isUnderground, true);
  assert.equal(info.isElevated, false);
  assert.equal(info.trackElevationMeters, Math.round((deepSite.groundElevationMeters - 38) * 10) / 10);

  const surfaceDraft = createDraft(parseSiteDesignSession(rawSession(groundSite)).session);
  const surfaceInfo = bodyElevationInfo(surfaceDraft, groundSite.groundElevationMeters);
  assert.equal(surfaceInfo.isUnderground, false);
  assert.equal(surfaceInfo.isElevated, false);
});

test("sceneFromDraft re-derives body/entrance geometry from the draft without touching workAreas/facts", () => {
  const { session } = parseSiteDesignSession(rawSession(groundSite));
  const baseScene = buildStationSiteScene(groundSite);
  const draft = createDraft(session);
  const entId = groundSite.entranceCandidates[0].entranceId;
  moveBodyTo(draft, [139.7, 35.7]);
  rotateBodyBy(draft, 20);
  moveEntrance(draft, entId, [139.71, 35.71]);

  const scene = sceneFromDraft(draft, baseScene);
  assert.equal(scene.body.edited, true);
  assert.equal(scene.body.collision, null); // never computed here
  assert.equal(scene.body.polygonXY.length, baseScene.body.polygonXY.length);
  assert.deepEqual(scene.workAreas, baseScene.workAreas); // untouched — no local collision/geometry recompute
  assert.deepEqual(scene.facts, baseScene.facts); // still the ORIGINAL station-site facts, not fabricated

  const movedEntrance = scene.entrances.find((e) => e.id === entId);
  assert.equal(movedEntrance.moved, true);
  assert.equal(movedEntrance.blocked, null); // unknown until the parent's collision result arrives
  const untouchedEntrance = scene.entrances.find((e) => e.id !== entId);
  assert.equal(untouchedEntrance.moved, false);
});

test("never carries a cost, duration, risk or cash figure anywhere in the session/draft/edit/collision objects", () => {
  const { session } = parseSiteDesignSession(rawSession(groundSite));
  const draft = createDraft(session);
  moveBodyTo(draft, [139.7, 35.7]);
  moveEntrance(draft, groundSite.entranceCandidates[0].entranceId, [139.71, 35.71]);
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
  // draft.original/body/entranceChanges/edit/request only — the merged `scene` still legitimately carries
  // the ORIGINAL site's own `facts`/`unknownReasons` text (inherited read-only from station-site.mjs,
  // already guarded by site-design-scene.test.mjs), so this check targets the new session/draft/edit/
  // request surfaces plus the parts of `scene` this module itself derives (body, entrances).
  walk(draft.body); walk(draft.entranceChanges); walk(edit); walk(req);
  walk(scene.body); for (const e of scene.entrances) walk(e);
});
