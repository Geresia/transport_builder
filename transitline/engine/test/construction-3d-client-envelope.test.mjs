import test from "node:test";
import assert from "node:assert/strict";
import { assessConstruction3dClientProposal, construction3dClientEnvelope, parseConstruction3dClientEnvelope, prepareConstruction3dClientLaunch } from "../src/construction-3d-client-envelope.mjs";
import { buildConstruction3dPreflight } from "../src/construction-3d-preflight.mjs";

const pack = { manifest: { id: "example-radial", version: "1" } };
const coordinates = { originLonLat: [0, 0], metersPerUnit: 1, axis: "east-up-north", verticalDatumMeters: 0 };
const client = { protocol: "transitline.construction-3d-adapter/1", contractVersion: 1, clientId: "unity-webgl", clientVersion: "0.1", capabilities: ["scene-manifest-v1", "change-set-v1"] };
const preflight = () => buildConstruction3dPreflight({ pack, coordinates, client: null, railGeometries: { designs: [{ railGeometryId: "rail:1", railGeometryRevision: "r1", sourcePackId: "example-radial", active: true, sections: [{ alignment: [[0, 0], [1, 1]] }] }] } });
const handshake = (sessionId = "session:1", payload = client) => construction3dClientEnvelope({ sessionId, kind: "handshake", payload });
const proposal = (sessionId = "session:1", revision = "r1") => construction3dClientEnvelope({ sessionId, kind: "change-set", payload: { schema: "transitline.construction-3d-change-set/1", contractVersion: 1, packId: "example-radial", status: "proposed", coordinates, changes: [{ sourceType: "rail-geometry", sourceId: "rail:1", sourceRevision: revision }] } });
const freeze = (value) => { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };

test("envelopes require an explicit session, supported kind, and exact session match", () => {
  assert.throws(() => construction3dClientEnvelope({ kind: "handshake" }), /session-id/);
  assert.throws(() => construction3dClientEnvelope({ sessionId: "s", kind: "unknown" }), /kind-invalid/);
  assert.equal(parseConstruction3dClientEnvelope(handshake(), { sessionId: "session:1" }).accepted, true);
  assert.deepEqual(parseConstruction3dClientEnvelope(handshake(), { sessionId: "other" }), { accepted: false, envelope: null, reason: "envelope-session-mismatch" });
});

test("a ready handshake receives only the exact preflight scene envelope and changes no preflight fact", () => {
  const input = freeze(preflight()); const launch = prepareConstruction3dClientLaunch({ pack, preflight: input, handshake: handshake(), sessionId: "session:1" });
  assert.equal(launch.ready, true); assert.equal(launch.fallback, null);
  assert.deepEqual(launch.sceneEnvelope, construction3dClientEnvelope({ sessionId: "session:1", kind: "scene", payload: input.scene }));
  assert.equal(input.session.mode, "2d-only", "base preflight remains the no-client fact");
  assert.ok(launch.notPerformed.includes("client-load"));
});

test("bad handshake, unknown provenance, or an invalid preflight retains a 2D-only launch plan", () => {
  const unavailable = prepareConstruction3dClientLaunch({ pack, preflight: preflight(), handshake: handshake("session:1", null), sessionId: "session:1" });
  assert.equal(unavailable.ready, false); assert.equal(unavailable.fallback, "2d-only");
  const unknown = preflight(); unknown.sources.sources[0].sourcePackId = null;
  const blocked = prepareConstruction3dClientLaunch({ pack, preflight: unknown, handshake: handshake(), sessionId: "session:1" });
  assert.equal(blocked.ready, false); assert.ok(blocked.blockers.includes("session:scene-source-pack-unknown:rail-geometry:rail:1"));
  assert.equal(prepareConstruction3dClientLaunch({ pack, preflight: null, handshake: handshake(), sessionId: "session:1" }).fallback, "2d-only");
});

test("a client proposal is assessed as a 2D proposal and never applied by the envelope boundary", () => {
  const current = assessConstruction3dClientProposal({ pack, preflight: preflight(), handshake: handshake(), proposal: proposal(), sessionId: "session:1" });
  assert.equal(current.applicable, true); assert.equal(current.changeSet.applicable, true); assert.ok(current.notPerformed.includes("change-set-apply"));
  const stale = assessConstruction3dClientProposal({ pack, preflight: preflight(), handshake: handshake(), proposal: proposal("session:1", "old"), sessionId: "session:1" });
  assert.equal(stale.applicable, false); assert.ok(stale.blockers.includes("change-set:change-target-stale:rail-geometry:rail:1"));
  const foreign = assessConstruction3dClientProposal({ pack, preflight: preflight(), handshake: handshake(), proposal: proposal("other"), sessionId: "session:1" });
  assert.equal(foreign.applicable, false); assert.ok(foreign.blockers.includes("proposal:envelope-session-mismatch"));
});
