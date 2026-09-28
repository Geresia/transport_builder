// Session/draft contract for the 3D site-design editor's edit mode (stage 2+3 of the MVP): turns a
// parent-supplied StationSite into an editable draft, and the draft into the SiteDesignEdit message sent
// back. Pure: no DOM, no postMessage, no Three.js, no import from engine/src/management/**, and no local
// collision recomputation — this module only carries geometry and echoes back whatever collision verdict
// the parent sends (buildCollisionRequest/applyCollisionResult). It never writes into the session's
// stationSite; every edit lives in a separate draft object. See docs/site-design-mvp-2026-09-28.md §7/§8
// for the full message contract and module boundary this keeps.
import { STATION_SITE_SCHEMA } from "./station-site.mjs";
import { frameAt } from "./local-geometry.mjs";
import { canonicalRing } from "./depot-site.mjs";
import { round6, roundTo, stableId } from "./ids.mjs";
import { SITE_DESIGN_MODEL } from "./site-design-scene.mjs";

export const SITE_DESIGN_SESSION_SCHEMA = "transitline.site-design-session/1";
export const SITE_DESIGN_EDIT_SCHEMA = "transitline.site-design-edit/1";
export const SITE_DESIGN_COLLISION_REQUEST_SCHEMA = "transitline.site-design-collision-request/1";
export const SITE_DESIGN_COLLISION_RESULT_SCHEMA = "transitline.site-design-collision-result/1";
export const SITE_DESIGN_READY_SCHEMA = "transitline.site-design-ready/1";

// Same placeholder the station-site contract itself falls back to (STATION_MODEL.defaultBody) — only used
// when the incoming site never got a heading/size (bodyPolygon: null), so there is something to edit at all.
const DEFAULT_BODY = Object.freeze({ lengthMeters: 160, widthMeters: 24 });
// Sanity bound for requirement 5 ("지상·지하 전환 시 깊이와 고도 값이 모순되지 않도록 검증"): no real
// station is 200 m deep or 200 m elevated — this only catches fat-finger/contradictory values, not real designs.
const MAX_ABS_DEPTH_METERS = 200;
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

// ---- draft: a working copy of the body/entrance/work-area edits. session.stationSite is read from, never written to ----
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
    original: {
      body: { ...body, location: [...body.location] },
      entrances: site.entranceCandidates.map((e) => ({ entranceId: e.entranceId, location: [...e.location] })),
      workAreas: site.workAreaCandidates.map((w) => ({ workAreaId: w.workAreaId, polygon: w.polygon.map((p) => [...p]) })),
    },
    body,
    entranceChanges: [], // { entranceId, action: "move"|"add"|"remove", location? } — see moveEntrance/addEntrance/removeEntrance
    entranceSeq: 0, // counts entrances added within this draft, for stable synthetic ids
    workAreaChanges: [], // { workAreaId, polygon } — full replacement polygon (lon/lat), see moveWorkAreaBy/resizeWorkAreaBy
    collisionFeedback: null, // set only by applyCollisionResult() — this module never computes it itself
    status: "draft",
  };
}

// Cancel = a fresh draft with the exact original shape. "복원" is re-deriving from the session, never
// patching a mutated draft back — so there is no way for a half-reverted state to leak through.
export const resetDraft = (session) => createDraft(session);

// ---- draft body edits: pure, mutate the draft object in place (never session.stationSite) and return it ----
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
// The checkbox and the number in the UI are never two independent pieces of state — the surface/underground
// toggle is always *derived from* depthMeters (0 = surface), so there is nothing separate for it to
// contradict; validateBodyDepth instead guards the one way this value itself can be nonsensical.
export function validateBodyDepth(depthMeters) {
  if (!finite(depthMeters)) return { valid: false, reason: "not-finite" };
  if (Math.abs(depthMeters) > MAX_ABS_DEPTH_METERS) return { valid: false, reason: "extreme-depth" };
  return { valid: true, reason: null };
}
export function setBodyDepth(draft, depthMeters) {
  const v = validateBodyDepth(depthMeters);
  if (!v.valid) throw new Error(`setBodyDepth: ${v.reason}`);
  draft.body.depthMeters = roundTo(depthMeters, 1);
  return draft;
}

// ---- entrance edits: move an existing one, add a new one, or remove one (existing or just-added) ----
// entranceChanges carries the *net* effect only: adding then removing the same draft-only entrance cancels
// out to nothing; moving then removing an original one collapses to a plain "remove".
function upsertEntranceChange(draft, entranceId, action, location) {
  const existing = draft.entranceChanges.find((c) => c.entranceId === entranceId);
  const entry = location ? { entranceId, action, location } : { entranceId, action };
  if (existing) { for (const k of Object.keys(existing)) delete existing[k]; Object.assign(existing, entry); } else draft.entranceChanges.push(entry);
}
export function moveEntrance(draft, entranceId, location) {
  if (!isLonLat(location)) throw new Error("moveEntrance: invalid location");
  const existing = draft.entranceChanges.find((c) => c.entranceId === entranceId);
  if (existing?.action === "remove") throw new Error(`moveEntrance: ${entranceId} was removed`);
  const isOriginal = draft.original.entrances.some((e) => e.entranceId === entranceId);
  if (!isOriginal && existing?.action !== "add") throw new Error(`moveEntrance: unknown entrance ${entranceId}`);
  const rounded = location.map(round6);
  upsertEntranceChange(draft, entranceId, existing?.action === "add" ? "add" : "move", rounded);
  return draft;
}
export function addEntrance(draft, location) {
  if (!isLonLat(location)) throw new Error("addEntrance: invalid location");
  draft.entranceSeq += 1;
  const entranceId = stableId("ent-draft", draft.stationSiteId, "seq", draft.entranceSeq);
  draft.entranceChanges.push({ entranceId, action: "add", location: location.map(round6) });
  return entranceId;
}
export function removeEntrance(draft, entranceId) {
  const addIndex = draft.entranceChanges.findIndex((c) => c.entranceId === entranceId && c.action === "add");
  if (addIndex >= 0) { draft.entranceChanges.splice(addIndex, 1); return draft; } // undo the add entirely — it never existed
  if (!draft.original.entrances.some((e) => e.entranceId === entranceId)) throw new Error(`removeEntrance: unknown entrance ${entranceId}`);
  upsertEntranceChange(draft, entranceId, "remove", null);
  return draft;
}

// ---- work-area edits: move or resize an existing candidate polygon. No add/remove — work areas are the
// station-site contract's own candidates, this editor only repositions/resizes them. ----
function currentWorkAreaPolygon(draft, workAreaId) {
  const pending = draft.workAreaChanges.find((c) => c.workAreaId === workAreaId);
  if (pending) return pending.polygon;
  const orig = draft.original.workAreas.find((w) => w.workAreaId === workAreaId);
  return orig ? orig.polygon : null;
}
function upsertWorkAreaChange(draft, workAreaId, polygon) {
  const existing = draft.workAreaChanges.find((c) => c.workAreaId === workAreaId);
  if (existing) existing.polygon = polygon; else draft.workAreaChanges.push({ workAreaId, polygon });
}
const polygonCentroidXY = (xy) => [xy.reduce((s, p) => s + p[0], 0) / xy.length, xy.reduce((s, p) => s + p[1], 0) / xy.length];
export function moveWorkAreaBy(draft, workAreaId, dEastMeters, dNorthMeters) {
  const polygon = currentWorkAreaPolygon(draft, workAreaId);
  if (!polygon) throw new Error(`moveWorkAreaBy: unknown work area ${workAreaId}`);
  const frame = frameAt(polygon[0]);
  const moved = polygon.map((p) => { const [x, y] = frame.xy(p); return frame.ll([x + dEastMeters, y + dNorthMeters]).map(round6); });
  upsertWorkAreaChange(draft, workAreaId, moved);
  return draft;
}
export function resizeWorkAreaBy(draft, workAreaId, scaleFactor) {
  if (!finite(scaleFactor) || scaleFactor <= 0) throw new Error("resizeWorkAreaBy: invalid scaleFactor");
  const polygon = currentWorkAreaPolygon(draft, workAreaId);
  if (!polygon) throw new Error(`resizeWorkAreaBy: unknown work area ${workAreaId}`);
  const frame = frameAt(polygon[0]);
  const xy = polygon.map((p) => frame.xy(p));
  const [cx, cy] = polygonCentroidXY(xy);
  const scaled = xy.map(([x, y]) => [cx + (x - cx) * scaleFactor, cy + (y - cy) * scaleFactor]);
  const resized = scaled.map((p) => frame.ll(p).map(round6));
  upsertWorkAreaChange(draft, workAreaId, resized);
  return draft;
}

// True once the draft differs from the original in any way — used to decide when a fresh collision-check
// request is worth sending, and to tell an "edited, not yet re-checked" object from an untouched one.
export function draftIsEdited(draft) {
  const b = draft.body, o = draft.original.body;
  return b.location[0] !== o.location[0] || b.location[1] !== o.location[1] || b.headingDegrees !== o.headingDegrees
    || b.lengthMeters !== o.lengthMeters || b.widthMeters !== o.widthMeters || b.depthMeters !== o.depthMeters
    || draft.entranceChanges.length > 0 || draft.workAreaChanges.length > 0;
}

// ---- outbound: the message sent to the parent. Apply -> "submitted", Cancel -> "cancelled" ----
const outEntranceChange = (c) => (c.location ? { entranceId: c.entranceId, action: c.action, location: [...c.location] } : { entranceId: c.entranceId, action: c.action });
const outWorkAreaChange = (c) => ({ workAreaId: c.workAreaId, polygon: c.polygon.map((p) => [...p]) });
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
    entranceChanges: draft.entranceChanges.map(outEntranceChange),
    workAreaChanges: draft.workAreaChanges.map(outWorkAreaChange),
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
    entranceChanges: draft.entranceChanges.map(outEntranceChange),
    workAreaChanges: draft.workAreaChanges.map(outWorkAreaChange),
  };
}
// A field's collision status is `true`/`false` only once the parent has actually said so; anything else
// (missing, non-boolean, or simply never having answered) stays `null` — "자료 미상" (unknown), never "안전".
const toTriState = (v) => (typeof v === "boolean" ? v : null);
export function applyCollisionResult(draft, message, expectedRequestId) {
  if (!message || message.schema !== SITE_DESIGN_COLLISION_RESULT_SCHEMA) return draft;
  if (message.sessionId !== draft.sessionId) return draft;
  if (expectedRequestId !== undefined && message.requestId !== expectedRequestId) return draft;
  draft.collisionFeedback = {
    bodyCollision: toTriState(message.bodyCollision),
    entranceCollisions: Array.isArray(message.entranceCollisions)
      ? Object.fromEntries(message.entranceCollisions.filter((e) => e && typeof e.entranceId === "string").map((e) => [e.entranceId, toTriState(e.collides)]))
      : {},
    workAreaCollisions: Array.isArray(message.workAreaCollisions)
      ? Object.fromEntries(message.workAreaCollisions.filter((w) => w && typeof w.workAreaId === "string").map((w) => [w.workAreaId, toTriState(w.collides)]))
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
// baseScene: buildStationSiteScene(session.stationSite) from site-design-scene.mjs — its facts describe the
// ORIGINAL geometry and are shown as-is; body/entrances/workAreas are re-derived from the draft here.
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
    heightMeters: baseScene.body?.heightMeters ?? SITE_DESIGN_MODEL.bodyHeightMeters,
    lengthMeters: draft.body.lengthMeters,
    widthMeters: draft.body.widthMeters,
    headingDegrees: draft.body.headingDegrees,
    depthMeters: draft.body.depthMeters,
    edited,
    collision: draft.collisionFeedback?.bodyCollision ?? null, // null = not re-checked by the parent yet
  };

  const entranceFeedback = draft.collisionFeedback?.entranceCollisions ?? {};
  const changeById = new Map(draft.entranceChanges.map((c) => [c.entranceId, c]));
  const keptEntrances = baseScene.entrances
    .filter((e) => changeById.get(e.id)?.action !== "remove")
    .map((e) => {
      const change = changeById.get(e.id);
      const moved = change?.action === "move";
      const location = moved ? change.location : frame.ll(e.xy);
      return {
        ...e,
        xy: frame.xy(location),
        moved,
        added: false,
        // a moved entrance's original `blocked` fact no longer describes where it is now
        blocked: moved ? (entranceFeedback[e.id] ?? null) : e.blocked,
      };
    });
  const addedEntrances = draft.entranceChanges
    .filter((c) => c.action === "add")
    .map((c) => ({
      id: c.entranceId,
      name: null,
      xy: frame.xy(c.location),
      footprintMeters: 6, // same default station-site.mjs itself uses (STATION_MODEL.entranceFootprintMeters)
      distanceToBodyMeters: null,
      baseZMeters: 0,
      heightMeters: SITE_DESIGN_MODEL.entranceHeightMeters,
      blocked: entranceFeedback[c.entranceId] ?? null,
      flags: [],
      moved: false,
      added: true,
    }));
  const entrances = [...keptEntrances, ...addedEntrances];

  const workAreaFeedback = draft.collisionFeedback?.workAreaCollisions ?? {};
  const workAreaOverride = new Map(draft.workAreaChanges.map((c) => [c.workAreaId, c.polygon]));
  const workAreas = baseScene.workAreas.map((w) => {
    const overrideLL = workAreaOverride.get(w.id);
    const wEdited = !!overrideLL;
    return {
      ...w,
      polygonXY: overrideLL ? overrideLL.map((p) => frame.xy(p)) : w.polygonXY,
      edited: wEdited,
      blocked: wEdited ? (workAreaFeedback[w.id] ?? null) : w.blocked,
    };
  });

  return { ...baseScene, body, entrances, workAreas };
}
