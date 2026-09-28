// Bridges the main game screen to the standalone 3D station-site editor (packs/tokyo/site-design.html),
// which runs in an iframe and talks back only through window.postMessage (see
// docs/site-design-mvp-2026-09-28.md §7 for the full message contract). This module owns that side of the
// conversation: opening/closing the modal, validating every inbound message (schema, sessionId,
// stationSiteId, event.origin) before trusting it, and recomputing building/water collision against the
// real StationSiteGeometry + spatial layers when the editor asks (transitline.site-design-collision-request/1)
// — the editor never computes that itself. It never imports engine/src/management/** and never decides cost,
// duration or bid eligibility; accept/reject of a submitted edit is entirely the caller's business logic
// (supplied as `onSubmit`), reached through whatever management API the caller wires up.
import { buildStationSite } from "./station-site.mjs";
import { stableId } from "./ids.mjs";
import { makeSpatialContext } from "./spatial.mjs";
import {
  SITE_DESIGN_COLLISION_REQUEST_SCHEMA, SITE_DESIGN_COLLISION_RESULT_SCHEMA,
  SITE_DESIGN_EDIT_SCHEMA, SITE_DESIGN_READY_SCHEMA, SITE_DESIGN_SESSION_SCHEMA,
} from "./site-design-session.mjs";

export const SITE_DESIGN_IFRAME_PATH = "../packs/tokyo/site-design.html";
const RECHECK_KEY = "site-design-collision-check";

// null/undefined counts stay null (never coerced to false) unless a real collision was already confirmed by a
// non-null positive count — a confirmed hit is certain even if the other layer is unknown.
function collisionOf(buildingCount, waterCount) {
  if ((buildingCount ?? 0) > 0 || (waterCount ?? 0) > 0) return true;
  if (buildingCount === null || waterCount === null) return null;
  return false;
}

// Re-derives building/water collision for a draft body + entrance set against the pack's own spatial layers,
// reusing buildStationSite() wholesale (same code the original StationSiteGeometry was built with) rather than
// re-implementing overlap math here. `originalEntrances`: session.stationSite.entranceCandidates — an entrance
// the editor never moved keeps its original location; a moved one uses the request's new location.
export function recomputeCollision(requestMessage, originalEntrances, { pack, spatial } = {}) {
  const changeById = new Map((requestMessage.entranceChanges ?? []).map((c) => [c.entranceId, c.location]));
  const entrances = (originalEntrances ?? []).map((e) => ({ key: e.entranceId, location: changeById.get(e.entranceId) ?? e.location }));
  const drawn = {
    key: RECHECK_KEY,
    location: requestMessage.body.location,
    headingDegrees: requestMessage.body.headingDegrees,
    lengthMeters: requestMessage.body.lengthMeters,
    widthMeters: requestMessage.body.widthMeters,
    entrances,
  };
  const site = buildStationSite(drawn, { pack, spatial: spatial ?? makeSpatialContext() });
  const bodyCollision = collisionOf(site.intersectedBuildingCount, site.waterOverlapCount);
  const entranceCollisions = (originalEntrances ?? []).map((e) => {
    const expectedId = stableId("ent", site.stationSiteId, "key", e.entranceId);
    const found = site.entranceCandidates.find((c) => c.entranceId === expectedId);
    return { entranceId: e.entranceId, collides: found ? collisionOf(found.collidingBuildingCount, found.waterOverlapCount) : null };
  });
  return { bodyCollision, entranceCollisions };
}

// Checks the fields every inbound message needs validated before anything in it is trusted: schema, the
// sender's origin, and — when the message carries them — sessionId and stationSiteId matching the session
// this bridge actually opened. Returns null when the message is fine, or a short reason code otherwise.
export function validateInboundMessage(data, eventOrigin, expected) {
  if (!data || typeof data !== "object") return "empty-message";
  if (expected.origin !== "*" && eventOrigin !== expected.origin) return "origin-mismatch";
  if (typeof data.schema !== "string" || !data.schema.startsWith("transitline.site-design-")) return "unknown-schema";
  if (expected.sessionId !== undefined && data.sessionId !== undefined && data.sessionId !== expected.sessionId) return "session-mismatch";
  if (expected.stationSiteId !== undefined && data.stationSiteId !== undefined && data.stationSiteId !== expected.stationSiteId) return "station-mismatch";
  return null;
}

const STYLE_ID = "transitline-site-design-bridge-style";
const CSS = `
.tl-sitedesign-backdrop{position:fixed;inset:0;z-index:20;background:rgba(8,10,14,.72);display:flex;align-items:center;justify-content:center}
.tl-sitedesign-modal{position:relative;width:min(1200px,94vw);height:min(820px,90vh);background:#14161d;border:1px solid #2a2f3a;border-radius:10px;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.5)}
.tl-sitedesign-head{display:flex;align-items:center;gap:10px;padding:8px 12px;background:#1b1e27;border-bottom:1px solid #2a2f3a;font:13px Inter,system-ui,'Malgun Gothic',sans-serif;color:#f1f2f5}
.tl-sitedesign-head b{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tl-sitedesign-status{padding:2px 8px;border-radius:10px;font-size:11px;background:#2a2f3a;color:#aab1c0}
.tl-sitedesign-status.ready{background:#2fbf71;color:#0c1114}
.tl-sitedesign-status.waiting{background:#6b7d85;color:#0c1114}
.tl-sitedesign-close{background:none;border:none;color:#aab1c0;font-size:16px;cursor:pointer;padding:2px 8px}
.tl-sitedesign-close:hover{color:#f1f2f5}
.tl-sitedesign-body{flex:1;position:relative}
.tl-sitedesign-body iframe{width:100%;height:100%;border:0;display:block}
.tl-sitedesign-banner{padding:6px 12px;font:12px Inter,system-ui,'Malgun Gothic',sans-serif;border-top:1px solid #2a2f3a}
.tl-sitedesign-banner.ok{background:#123024;color:#5fe3a1}
.tl-sitedesign-banner.error{background:#3a1418;color:#ff8a93}
.tl-sitedesign-banner.info{background:#1b1e27;color:#aab1c0}
`;

// pack: the current CityPack (for buildStationSite's context). getSpatial: () => spatial context for collision
// recompute, defaults to no layers (spatial data not wired into the main game yet — matches every other map
// tool's current state; see the contract docs). onSubmit(edit, { originalStationSite }) is called only for
// status:"submitted" and must return { accepted: boolean, reason?: string } (a rejection reason to show, or
// nothing on acceptance) — it decides nothing about geometry itself, only whatever the caller's management call
// decided. onCancel(edit) is called only for status:"cancelled" and its return value is ignored — nothing about
// game state may change in response to a cancel; that is the caller's responsibility to uphold.
export function mountSiteDesignBridge({ hostDoc = document, pack, getSpatial = () => makeSpatialContext(), onSubmit, onCancel = () => {} }) {
  if (!hostDoc.getElementById(STYLE_ID)) { const s = hostDoc.createElement("style"); s.id = STYLE_ID; s.textContent = CSS; hostDoc.head.append(s); }
  const win = hostDoc.defaultView;
  const iframeOrigin = new URL(SITE_DESIGN_IFRAME_PATH, win.location.href).origin;

  let backdrop = null, iframeEl = null, statusEl = null, bannerEl = null, titleEl = null;
  let current = null; // { sessionId, stationSite, baseRevision, lastCollisionResult }
  let onMessage = null;
  let sessionCounter = 0;

  function el(tag, cls, text) { const e = hostDoc.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }

  function banner(text, kind = "info") {
    if (!bannerEl) return;
    bannerEl.textContent = text;
    bannerEl.className = `tl-sitedesign-banner ${kind}`;
    bannerEl.hidden = !text;
  }

  function buildDom() {
    backdrop = el("div", "tl-sitedesign-backdrop");
    const modal = el("div", "tl-sitedesign-modal");
    const head = el("div", "tl-sitedesign-head");
    titleEl = el("b", "", "");
    statusEl = el("span", "tl-sitedesign-status waiting", "연결 대기");
    const close = el("button", "tl-sitedesign-close", "×");
    close.type = "button";
    close.title = "취소하고 닫기";
    close.addEventListener("click", () => close_());
    head.append(titleEl, statusEl, close);
    const body = el("div", "tl-sitedesign-body");
    iframeEl = hostDoc.createElement("iframe");
    body.append(iframeEl);
    bannerEl = el("div", "tl-sitedesign-banner info");
    bannerEl.hidden = true;
    modal.append(head, body, bannerEl);
    backdrop.append(modal);
    backdrop.addEventListener("click", (ev) => { if (ev.target === backdrop) close_(); });
    hostDoc.body.append(backdrop);
  }

  function teardownDom() {
    if (onMessage) { win.removeEventListener("message", onMessage); onMessage = null; }
    backdrop?.remove();
    backdrop = iframeEl = statusEl = bannerEl = titleEl = null;
  }

  function close_() {
    // Closing via the × / backdrop with an edit still pending is the same as the editor's own "취소": nothing
    // about game state changes. The editor's own SiteDesignEdit(status:"cancelled") message (if it arrives first)
    // already goes through onCancel(); this just guarantees the modal never leaves a half-open session behind.
    current = null;
    teardownDom();
  }

  function send(msg) {
    try { iframeEl.contentWindow?.postMessage(msg, iframeOrigin === "null" ? "*" : iframeOrigin); } catch { /* iframe gone */ }
  }

  function handleMessage(event) {
    if (!current) return;
    const data = event.data;
    if (!data || typeof data !== "object" || !data.schema?.startsWith?.("transitline.site-design-")) return; // not for us
    const err = validateInboundMessage(data, event.origin, { origin: iframeOrigin, sessionId: current.sessionId, stationSiteId: current.stationSite.stationSiteId });
    if (err && data.schema !== SITE_DESIGN_READY_SCHEMA) { banner(`편집기 메시지를 거부했습니다 (${err}).`, "error"); return; }

    if (data.schema === SITE_DESIGN_READY_SCHEMA) {
      statusEl.textContent = "연결됨";
      statusEl.className = "tl-sitedesign-status ready";
      send({
        schema: SITE_DESIGN_SESSION_SCHEMA,
        sessionId: current.sessionId,
        stationSite: current.stationSite,
        baseRevision: current.baseRevision,
        surroundingSpatialData: null,
        initialView: null,
      });
      return;
    }

    if (data.schema === SITE_DESIGN_COLLISION_REQUEST_SCHEMA) {
      const result = recomputeCollision(data, current.stationSite.entranceCandidates ?? [], { pack, spatial: getSpatial() });
      const resultMsg = { schema: SITE_DESIGN_COLLISION_RESULT_SCHEMA, sessionId: current.sessionId, requestId: data.requestId, ...result };
      current.lastCollisionResult = resultMsg;
      send(resultMsg);
      return;
    }

    if (data.schema === SITE_DESIGN_EDIT_SCHEMA) {
      if (data.status === "cancelled") {
        onCancel(data);
        banner("취소되었습니다. 원본 역은 바뀌지 않았습니다.", "info");
        close_();
        return;
      }
      if (data.status === "submitted") {
        const stationSite = current.stationSite;
        Promise.resolve(onSubmit(data, { originalStationSite: stationSite, collisionResult: current.lastCollisionResult ?? null }))
          .then((outcome) => {
            if (!current) return; // closed meanwhile
            if (outcome?.accepted) banner("경영 엔진에 적용되었습니다.", "ok");
            else banner(`경영 엔진이 거절했습니다: ${outcome?.reason ?? "사유 없음"}`, "error");
          })
          .catch((error) => { if (current) banner(`경영 엔진 전달 중 오류: ${error.message}`, "error"); });
        return;
      }
    }
  }

  return {
    // stationSite: a StationSiteGeometry (transitline.station-site-geometry/1). baseRevision: the geometry
    // revision the caller's management state considers current for this station (opaque string, echoed back).
    open(stationSite, { baseRevision } = {}) {
      if (!stationSite || stationSite.schema !== "transitline.station-site-geometry/1") throw new Error("open() requires a StationSiteGeometry");
      if (backdrop) teardownDom();
      sessionCounter++;
      current = { sessionId: `site-design:${stationSite.stationSiteId}:${Date.now()}:${sessionCounter}`, stationSite, baseRevision: baseRevision ?? null, lastCollisionResult: null };
      buildDom();
      titleEl.textContent = stationSite.name ?? stationSite.stationSiteId;
      onMessage = (event) => handleMessage(event);
      win.addEventListener("message", onMessage);
      iframeEl.src = `${SITE_DESIGN_IFRAME_PATH}?targetOrigin=${encodeURIComponent(iframeOrigin === "null" ? "*" : iframeOrigin)}`;
    },
    close: close_,
    get isOpen() { return backdrop !== null; },
    destroy() { close_(); },
  };
}
