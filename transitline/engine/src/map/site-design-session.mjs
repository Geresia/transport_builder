// Session/draft contract for the 3D site-design editor's edit mode (stage 2 of the MVP): turns a
// parent-supplied StationSite into an editable draft, and the draft into the SiteDesignEdit message sent
// back. Pure: no DOM, no postMessage, no Three.js, no import from engine/src/management/**, and no local
// collision recomputation — this module only carries geometry and echoes back whatever collision verdict
// the parent sends (buildCollisionRequest/applyCollisionResult). It never writes into the session's
// stationSite; every edit lives in a separate draft object. See docs/site-design-mvp-2026-09-28.md §7 for
// the full message contract and module boundary this keeps.
import { STATION_SITE_SCHEMA } from "./station-site.mjs";
import { frameAt } from "./local-geometry.mjs";
import { canonicalRing } from "./depot-site.mjs";
import { round6, roundTo } from "./ids.mjs";

export const SITE_DESIGN_SESSION_SCHEMA = "transitline.site-design-session/1";
export const SITE_DESIGN_EDIT_SCHEMA = "transitline.site-design-edit/1";
export const SITE_DESIGN_COLLISION_REQUEST_SCHEMA = "transitline.site-design-collision-request/1";
export const SITE_DESIGN_COLLISION_RESULT_SCHEMA = "transitline.site-design-collision-result/1";
export const SITE_DESIGN_READY_SCHEMA = "transitline.site-design-ready/1";

// Same placeholder the station-site contract itself falls back to (STATION_MODEL.defaultBody) — only used
// when the incoming site never got a heading/size (bodyPolygon: null), so there is something to edit at all.
const DEFAULT_BODY = Object.freeze({ lengthMeters: 160, widthMeters: 24 });
const finite = (v) => typeof v === "number" && Number.isFinite(v);
const isLonLat = (p) => Array.isArray(p) && p.length === 2 && p.every(finite);

// ---- inbound: validate a raw postMessage payload before trusting anything in it ----
export function parseSiteDesignSession(raw) {
  if (!raw || typeof raw !== "object") return { session: null, error: "empty-message" };
  if (raw.schema !== SITE_DESIGN_SESSION_SCHEMA) return { session: null, error: "unknown-schema" };
  if (typeof raw.sessionId !== "string" || !raw.sessionId) return { session: null, error: "missing-sessionId" };
  if (!raw.stationSite || raw.stationSite.schema !== STATION_SITE_SCHEMA) return { session: null, error: "missing-or-invalid-stationSite" };
  if (raw.baseRevision === undefined || raw.baseRevision === null) return { session: null, error: "missing-baseRevision" };
  if (!isLonLat(raw.stationSite.location)) return { session: null, error: "invalid-stationSite-location" };
  return {
    session: {
      schema: SITE_DESIGN_SESSION_SCHEMA,
      sessionId: raw.sessionId,
      stationSite: raw.stationSite,
      baseRevision: raw.baseRevision,
      surroundingSpatialData: raw.surroundingSpatialData ?? null,
      initialView: raw.initialView ?? null,
    },
    error: null,
  };
}

// ---- draft: a working copy of the body transform + entrance moves. session.stationSite is read from, never written to ----
export function createDraft(session) {
  const site = session.stationSite;
  const hasBody = !!site.bodyPolygon;
  const body = {
    location: [...site.location],
    headingDegrees: hasBody && finite(site.bodyHeadingDegrees) ? site.bodyHeadingDegrees : 0,
    lengthMeters: hasBody && finite(site.bodyLengthMeters) ? site.bodyLengthMeters : DEFAULT_BODY.lengthMeters,
    widthMeters: hasBody && finite(site.bodyWidthMeters) ? site.bodyWidthMeters : DEFAULT_BODY.widthMeters,
    depthMeters: finite(site.plannedDepthMeters) ? site.plannedDepthMeters : 0,
  };
  return {
    sessionId: session.sessionId,
    stationSiteId: site.stationSiteId,
    baseRevision: session.baseRevision,
    original: { body: { ...body, location: [...body.location] }, entrances: site.entranceCandidates.map((e) => ({ entranceId: e.entranceId, location: [...e.location] })) },
    body,
    entranceChanges: [],
    collisionFeedback: null, // set only by applyCollisionResult() — this module never computes it itself
    status: "draft",
  };
}

// Cancel = a fresh draft with the exact original shape. "복원" is re-deriving from the session, never
// patching a mutated draft back — so there is no way for a half-reverted state to leak through.
export const resetDraft = (session) => createDraft(session);

// ---- draft edits: pure, mutate the draft object in place (never session.stationSite) and return it ----
export function moveBodyTo(draft, location) {
  if (!isLonLat(location)) throw new Error("moveBodyTo: invalid location");
  draft.body.location = location.map(round6);
  return draft;
}
export function moveBodyBy(draft, dEastMeters, dNorthMeters) {
  const frame = frameAt(draft.body.location);
  const [x, y] = frame.xy(draft.body.location);
  return moveBodyTo(draft, frame.ll([x + dEastMeters, y + dNorthMeters]));
}
export function rotateBodyTo(draft, headingDegrees) {
  if (!finite(headingDegrees)) throw new Error("rotateBodyTo: invalid headingDegrees");
  draft.body.headingDegrees = roundTo(((headingDegrees % 360) + 360) % 360, 1);
  return draft;
}
export const rotateBodyBy = (draft, deltaDegrees) => rotateBodyTo(draft, draft.body.headingDegrees + deltaDegrees);
export function resizeBody(draft, { lengthMeters, widthMeters } = {}) {
  if (lengthMeters !== undefined) {
    if (!finite(lengthMeters) || lengthMeters <= 0) throw new Error("resizeBody: invalid lengthMeters");
    draft.body.lengthMeters = lengthMeters;
  }
  if (widthMeters !== undefined) {
    if (!finite(widthMeters) || widthMeters <= 0) throw new Error("resizeBody: invalid widthMeters");
    draft.body.widthMeters = widthMeters;
  }
  return draft;
}
// depthMeters: positive = below ground (underground/cut-cover), negative = elevated above it, 0 = surface.
export function setBodyDepth(draft, depthMeters) {
  if (!finite(depthMeters)) throw new Error("setBodyDepth: invalid depthMeters");
  draft.body.depthMeters = roundTo(depthMeters, 1);
  return draft;
}
export function moveEntrance(draft, entranceId, location) {
  if (!isLonLat(location)) throw new Error("moveEntrance: invalid location");
  if (!draft.original.entrances.some((e) => e.entranceId === entranceId)) throw new Error(`moveEntrance: unknown entrance ${entranceId}`);
  const rounded = location.map(round6);
  const existing = draft.entranceChanges.find((c) => c.entranceId === entranceId);
  if (existing) existing.location = rounded; else draft.entranceChanges.push({ entranceId, location: rounded });
  return draft;
}

// True once the draft differs from the original in any way — used to decide when a fresh collision-check
// request is worth sending, and to tell an "edited, not yet re-checked" body from an untouched one.
export function draftIsEdited(draft) {
  const b = draft.body, o = draft.original.body;
  return b.location[0] !== o.location[0] || b.location[1] !== o.location[1] || b.headingDegrees !== o.headingDegrees
    || b.lengthMeters !== o.lengthMeters || b.widthMeters !== o.widthMeters || b.depthMeters !== o.depthMeters
    || draft.entranceChanges.length > 0;
}

// ---- outbound: the message sent to the parent. Apply -> "submitted", Cancel -> "cancelled" ----
export function buildSiteDesignEdit(draft, status) {
  if (!["draft", "submitted", "cancelled"].includes(status)) throw new Error(`buildSiteDesignEdit: invalid status ${status}`);
  return {
    schema: SITE_DESIGN_EDIT_SCHEMA,
    sessionId: draft.sessionId,
    stationSiteId: draft.stationSiteId,
    baseRevision: draft.baseRevision,
    body: {
      location: [...draft.body.location],
      headingDegrees: draft.body.headingDegrees,
      lengthMeters: draft.body.lengthMeters,
      widthMeters: draft.body.widthMeters,
      depthMeters: draft.body.depthMeters,
    },
    entranceChanges: draft.entranceChanges.map((c) => ({ entranceId: c.entranceId, location: [...c.location] })),
    status,
  };
}

// ---- collision feedback: the parent's recalculated verdict only — this module never runs its own overlap
// math against buildings/roads. buildCollisionRequest is sent after each committed edit; applyCollisionResult
// stores whatever comes back, keyed by requestId so a late reply to an earlier drag position is ignored. ----
export function buildCollisionRequest(draft, requestId) {
  return {
    schema: SITE_DESIGN_COLLISION_REQUEST_SCHEMA,
    sessionId: draft.sessionId,
    requestId,
    baseRevision: draft.baseRevision,
    body: { ...draft.body, location: [...draft.body.location] },
    entranceChanges: draft.entranceChanges.map((c) => ({ ...c, location: [...c.location] })),
  };
}
export function applyCollisionResult(draft, message, expectedRequestId) {
  if (!message || message.schema !== SITE_DESIGN_COLLISION_RESULT_SCHEMA) return draft;
  if (message.sessionId !== draft.sessionId) return draft;
  if (expectedRequestId !== undefined && message.requestId !== expectedRequestId) return draft;
  draft.collisionFeedback = {
    bodyCollision: typeof message.bodyCollision === "boolean" ? message.bodyCollision : null,
    entranceCollisions: Array.isArray(message.entranceCollisions)
      ? Object.fromEntries(
          message.entranceCollisions
            .filter((e) => e && typeof e.entranceId === "string")
            .map((e) => [e.entranceId, typeof e.collides === "boolean" ? e.collides : null]),
        )
      : {},
  };
  return draft;
}

// ---- depth / X-ray display: read-only geometry, not a new engineering figure ----
export function bodyElevationInfo(draft, groundElevationMeters) {
  const depthMeters = draft.body.depthMeters;
  const ground = finite(groundElevationMeters) ? groundElevationMeters : null;
  return {
    depthMeters,
    isUnderground: depthMeters > 0,
    isElevated: depthMeters < 0,
    groundElevationMeters: ground,
    trackElevationMeters: ground !== null ? roundTo(ground - depthMeters, 1) : null,
  };
}

// ---- draft -> renderable local-metre geometry, anchored on the base scene's origin/frame ----
// baseScene: buildStationSiteScene(session.stationSite) from site-design-scene.mjs — its facts/workAreas
// describe the ORIGINAL geometry and are shown as-is; only body/entrances are re-derived from the draft.
const rectXY = (c, u, v, along, across) => {
  const a = along / 2, b = across / 2;
  return [[-a, -b], [a, -b], [a, b], [-a, b]].map(([s, t]) => [c[0] + u[0] * s + v[0] * t, c[1] + u[1] * s + v[1] * t]);
};
export function draftBodyPolygonXY(draft, frame) {
  const c = frame.xy(draft.body.location);
  const h = (draft.body.headingDegrees * Math.PI) / 180;
  const u = [Math.sin(h), Math.cos(h)];
  const v = [u[1], -u[0]];
  return canonicalRing(rectXY(c, u, v, draft.body.lengthMeters, draft.body.widthMeters).map(frame.ll));
}
export function sceneFromDraft(draft, baseScene) {
  const frame = frameAt(baseScene.origin);
  const edited = draftIsEdited(draft);
  const body = {
    location: [...draft.body.location],
    polygonXY: draftBodyPolygonXY(draft, frame),
    baseZMeters: -draft.body.depthMeters,
    heightMeters: baseScene.body?.heightMeters ?? 6,
    lengthMeters: draft.body.lengthMeters,
    widthMeters: draft.body.widthMeters,
    headingDegrees: draft.body.headingDegrees,
    depthMeters: draft.body.depthMeters,
    edited,
    collision: draft.collisionFeedback?.bodyCollision ?? null, // null = not re-checked by the parent yet
  };
  const changeById = new Map(draft.entranceChanges.map((c) => [c.entranceId, c.location]));
  const entrances = baseScene.entrances.map((e) => {
    const movedTo = changeById.get(e.id);
    const moved = movedTo !== undefined;
    const location = moved ? movedTo : frame.ll(e.xy);
    const feedback = draft.collisionFeedback?.entranceCollisions?.[e.id];
    return {
      ...e,
      xy: frame.xy(location),
      moved,
      // a moved entrance's original `blocked` fact no longer describes where it is now
      blocked: moved ? (feedback ?? null) : e.blocked,
    };
  });
  return { ...baseScene, body, entrances };
}
