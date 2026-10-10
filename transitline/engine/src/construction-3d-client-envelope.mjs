// B21-P2 serialisable transport boundary for an optional Unity/WebGL or
// desktop construction client.  It deliberately has no browser, iframe,
// message-port, renderer, or game-state dependency: a future loader owns
// transport/origin checks and passes decoded envelopes through this module.

import { assessConstruction3dClient } from "./construction-3d-adapter.mjs";
import { assessConstruction3dChangeSet } from "./construction-3d-exchange.mjs";
import { assessConstruction3dSpatialReview } from "./construction-3d-spatial-review.mjs";
import { assessConstruction3dSession } from "./construction-3d-session-coordinator.mjs";
import { CONSTRUCTION_3D_PREFLIGHT_SCHEMA } from "./construction-3d-preflight.mjs";

export const CONSTRUCTION_3D_CLIENT_ENVELOPE_SCHEMA = "transitline.construction-3d-client-envelope/1";
export const CONSTRUCTION_3D_CLIENT_ENVELOPE_KINDS = Object.freeze(["handshake", "scene", "stage", "change-set", "spatial-review", "close"]);
const clone = (value) => structuredClone(value);
const text = (value) => typeof value === "string" && value.trim() ? value.trim() : null;
const compare = (a, b) => String(a).localeCompare(String(b));
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

export function construction3dClientEnvelope({ sessionId, kind, payload = null } = {}) {
  const id = text(sessionId);
  if (!id) throw new Error("construction-3d-client-envelope-session-id-required");
  if (!CONSTRUCTION_3D_CLIENT_ENVELOPE_KINDS.includes(kind)) throw new Error("construction-3d-client-envelope-kind-invalid");
  return { schema: CONSTRUCTION_3D_CLIENT_ENVELOPE_SCHEMA, contractVersion: 1, sessionId: id, kind, payload: clone(payload) };
}

export function parseConstruction3dClientEnvelope(value, { sessionId = null, kinds = CONSTRUCTION_3D_CLIENT_ENVELOPE_KINDS } = {}) {
  try {
    if (!isObject(value) || value.schema !== CONSTRUCTION_3D_CLIENT_ENVELOPE_SCHEMA || value.contractVersion !== 1) throw new Error("envelope-schema-invalid");
    const parsed = construction3dClientEnvelope(value);
    const expected = sessionId === null || sessionId === undefined ? null : text(sessionId);
    if (sessionId !== null && sessionId !== undefined && !expected) throw new Error("expected-session-id-invalid");
    if (expected !== null && parsed.sessionId !== expected) throw new Error("envelope-session-mismatch");
    if (!Array.isArray(kinds) || !kinds.includes(parsed.kind)) throw new Error("envelope-kind-not-accepted");
    return { accepted: true, envelope: parsed, reason: null };
  } catch (error) {
    return { accepted: false, envelope: null, reason: error instanceof Error ? error.message : String(error) };
  }
}

function preflightFacts(preflight) {
  if (!isObject(preflight) || preflight.schema !== CONSTRUCTION_3D_PREFLIGHT_SCHEMA || preflight.contractVersion !== 1) return null;
  if (!isObject(preflight.sources) || !Array.isArray(preflight.sources.sources)) return null;
  if (!isObject(preflight.audit)) return null;
  return { scene: preflight.scene ?? null, sources: preflight.sources.sources, audit: preflight.audit };
}

// This is called after a loader has obtained a *decoded* handshake envelope.
// It only decides whether that client may receive this immutable scene snapshot.
export function prepareConstruction3dClientLaunch({ pack, preflight, handshake, sessionId = null, selectedSourceIds = null } = {}) {
  const facts = preflightFacts(preflight);
  const parsed = parseConstruction3dClientEnvelope(handshake, { sessionId, kinds: ["handshake"] });
  const blockers = [];
  if (!facts) blockers.push("preflight-invalid");
  if (!parsed.accepted) blockers.push(`handshake:${parsed.reason}`);
  const client = parsed.accepted ? parsed.envelope.payload : null;
  const clientAssessment = assessConstruction3dClient(client);
  let session = null;
  if (facts) session = assessConstruction3dSession({ pack, client, scene: facts.scene, currentSources: facts.sources, selectedSourceIds });
  if (session?.mode !== "3d-available") {
    const sessionBlockers = session?.blockers?.length ? session.blockers : [`client-${session?.client?.status ?? "not-available"}`];
    blockers.push(...sessionBlockers.map((entry) => `session:${entry}`));
  }
  if (facts && facts.audit.applicable !== true) blockers.push(...(facts.audit.blockers ?? ["audit-not-applicable"]).map((entry) => `audit:${entry}`));
  const unique = [...new Set(blockers)].sort(compare);
  const id = parsed.accepted ? parsed.envelope.sessionId : text(sessionId);
  const ready = unique.length === 0;
  return {
    schema: "transitline.construction-3d-client-launch-plan/1", contractVersion: 1,
    sessionId: id ?? null, client: clone(clientAssessment), session: session === null ? null : clone(session),
    ready, fallback: ready ? null : "2d-only", blockers: unique,
    // The loader must send this exact envelope as one message only after ready.
    sceneEnvelope: ready ? construction3dClientEnvelope({ sessionId: id, kind: "scene", payload: facts.scene }) : null,
    notPerformed: ["client-load", "transport-origin-check", "render", "change-set-apply", "construction-approval", "cash", "clock"],
  };
}

// A proposed change set is transport data only.  The caller still must route a
// successful proposal to its existing 2D owner/approval flow; this function
// never applies it, writes state, or treats a spatial review as approval.
export function assessConstruction3dClientProposal({ pack, preflight, handshake, proposal, sessionId = null, selectedSourceIds = null } = {}) {
  const launch = prepareConstruction3dClientLaunch({ pack, preflight, handshake, sessionId, selectedSourceIds });
  const parsed = parseConstruction3dClientEnvelope(proposal, { sessionId: launch.sessionId, kinds: ["change-set"] });
  const facts = preflightFacts(preflight);
  const blockers = [...launch.blockers];
  let assessment = null;
  if (!parsed.accepted) blockers.push(`proposal:${parsed.reason}`);
  else if (facts) assessment = assessConstruction3dChangeSet(parsed.envelope.payload, { pack, coordinates: facts.scene?.coordinates, currentSources: facts.sources });
  else blockers.push("preflight-invalid");
  if (assessment && !assessment.applicable) blockers.push(...assessment.blockers.map((entry) => `change-set:${entry}`));
  const unique = [...new Set(blockers)].sort(compare);
  return { schema: "transitline.construction-3d-client-proposal-assessment/1", contractVersion: 1, sessionId: launch.sessionId, launch, proposal: parsed.accepted ? clone(parsed.envelope) : null, changeSet: assessment, applicable: unique.length === 0, blockers: unique, notPerformed: ["change-set-apply", "construction-approval", "cash", "ledger", "demand", "clock"] };
}

// Spatial observations travel through the same versioned session but are
// deliberately distinct from geometry proposals.  A valid observation remains
// a fact for a later 2D owner to decide about; this boundary never stores or
// applies it.
export function assessConstruction3dClientSpatialReview({ pack, preflight, handshake, review, sessionId = null, selectedSourceIds = null } = {}) {
  const launch = prepareConstruction3dClientLaunch({ pack, preflight, handshake, sessionId, selectedSourceIds });
  const parsed = parseConstruction3dClientEnvelope(review, { sessionId: launch.sessionId, kinds: ["spatial-review"] });
  const facts = preflightFacts(preflight);
  const blockers = [...launch.blockers];
  let assessment = null;
  if (!parsed.accepted) blockers.push(`review:${parsed.reason}`);
  else if (facts) assessment = assessConstruction3dSpatialReview(parsed.envelope.payload, { pack, currentSources: facts.sources });
  else blockers.push("preflight-invalid");
  if (assessment && !assessment.applicable) blockers.push(...assessment.blockers.map((entry) => `review:${entry}`));
  const unique = [...new Set(blockers)].sort(compare);
  return { schema: "transitline.construction-3d-client-spatial-review-assessment/1", contractVersion: 1, sessionId: launch.sessionId, launch, review: parsed.accepted ? clone(parsed.envelope) : null, spatialReview: assessment, applicable: unique.length === 0, blockers: unique, notPerformed: ["review-store", "change-set-apply", "construction-approval", "cash", "ledger", "demand", "clock"] };
}
