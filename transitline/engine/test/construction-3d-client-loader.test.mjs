import test from "node:test";
import assert from "node:assert/strict";
import { assessConstruction3dClientSpatialReview, construction3dClientEnvelope } from "../src/construction-3d-client-envelope.mjs";
import { construction3dIframeTransportFactory, createConstruction3dClientLoader, createConstruction3dIframeTransport, mountConstruction3dClientLoader } from "../src/construction-3d-client-loader.mjs";
import { buildConstruction3dPreflight } from "../src/construction-3d-preflight.mjs";
import { buildConstruction3dStageManifest } from "../src/construction-3d-stage-manifest.mjs";

const pack = { manifest: { id: "example-radial", version: "1" } };
const coordinates = { originLonLat: [0, 0], metersPerUnit: 1, axis: "east-up-north", verticalDatumMeters: 0 };
const client = { protocol: "transitline.construction-3d-adapter/1", contractVersion: 1, clientId: "unity-webgl", clientVersion: "0.1", capabilities: ["scene-manifest-v1", "change-set-v1"] };
const preflight = () => buildConstruction3dPreflight({ pack, coordinates, railGeometries: { designs: [{ railGeometryId: "rail:1", railGeometryRevision: "r1", sourcePackId: "example-radial", active: true, sections: [{ alignment: [[0, 0], [1, 1]] }] }] } });
const handshake = () => construction3dClientEnvelope({ sessionId: "session:1", kind: "handshake", payload: client });
const proposal = (revision = "r1") => construction3dClientEnvelope({ sessionId: "session:1", kind: "change-set", payload: { schema: "transitline.construction-3d-change-set/1", contractVersion: 1, packId: "example-radial", status: "proposed", coordinates, changes: [{ sourceType: "rail-geometry", sourceId: "rail:1", sourceRevision: revision }] } });
const review = (state = "clear", revision = "r1") => construction3dClientEnvelope({ sessionId: "session:1", kind: "spatial-review", payload: { schema: "transitline.construction-3d-spatial-review/1", contractVersion: 1, reviewId: "unity-review:1", packId: "example-radial", observations: [{ observationId: "obs:1", sourceType: "rail-geometry", sourceId: "rail:1", sourceRevision: revision, state, reason: null, geometry: null }] } });
const stageHandshake = () => construction3dClientEnvelope({ sessionId: "session:1", kind: "handshake", payload: { ...client, capabilities: [...client.capabilities, "stage-manifest-v1"] } });
const stage = (minute = 5) => buildConstruction3dStageManifest({ pack, simMinute: minute, packages: [{ id: "site:1", status: "awarded", location: [0, 0] }], workfronts: [{ id: "front:unknown", status: "open", location: null }], events: [] });
const freeze = (value) => { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const noTimer = { schedule: () => 1, cancel: () => {} };
function transport() { let listener = null; return { sent: [], closed: 0, send(value) { this.sent.push(value); }, subscribe(fn) { listener = fn; return () => { listener = null; }; }, close() { this.closed += 1; }, emit(message) { listener?.(message); } }; }
function scheduler() { let task = null; return { schedule(fn) { task = fn; return 1; }, cancel() { task = null; }, fire() { task?.(); } }; }
class Node { constructor(tag) { this.tag = tag; this.children = []; this.className = ""; this.textContent = ""; this.listeners = {}; } append(...nodes) { this.children.push(...nodes); } replaceChildren(...nodes) { this.children = []; this.append(...nodes); } addEventListener(kind, fn) { (this.listeners[kind] ??= []).push(fn); } fire(kind) { for (const fn of this.listeners[kind] ?? []) fn({}); } }
const dom = { createElement: (tag) => new Node(tag) }; const root = () => Object.assign(new Node("div"), { ownerDocument: dom }); const all = (node) => [node, ...node.children.flatMap(all)]; const find = (node, name) => all(node).find((item) => item.className === name);

test("loader has no transport side effect until an explicit open", () => {
  let opens = 0; const t = transport(); const loader = createConstruction3dClientLoader({ pack, getPreflight: preflight, sessionId: "session:1", expectedOrigin: "https://unity.example", transportFactory: () => { opens += 1; return t; }, ...noTimer });
  assert.equal(opens, 0); assert.equal(loader.output().status, "2d-only"); loader.open(); assert.equal(opens, 1); assert.equal(loader.output().status, "connecting");
});

test("valid exact-origin handshake sends only the deterministic scene envelope", () => {
  const input = freeze(preflight()); const t = transport(); const loader = createConstruction3dClientLoader({ pack, getPreflight: () => input, sessionId: "session:1", expectedOrigin: "https://unity.example", transportFactory: () => t, ...noTimer });
  loader.open(); t.emit({ origin: "https://unity.example", data: handshake() });
  assert.equal(loader.output().status, "connected"); assert.equal(t.sent.length, 1); assert.equal(t.sent[0].kind, "scene"); assert.deepEqual(t.sent[0].payload, input.scene); assert.equal(input.session.mode, "2d-only");
});

test("foreign origin, malformed handshake, or timeout closes the client and retains 2D-only", () => {
  for (const event of [{ origin: "https://foreign.example", data: handshake() }, { origin: "https://unity.example", data: { nope: true } }]) {
    const t = transport(); const loader = createConstruction3dClientLoader({ pack, getPreflight: preflight, sessionId: "session:1", expectedOrigin: "https://unity.example", transportFactory: () => t, ...noTimer }); loader.open(); t.emit(event); assert.equal(loader.output().status, "2d-only"); assert.equal(t.closed, 1);
  }
  const time = scheduler(); const t = transport(); const loader = createConstruction3dClientLoader({ pack, getPreflight: preflight, sessionId: "session:1", expectedOrigin: "https://unity.example", transportFactory: () => t, schedule: time.schedule, cancel: time.cancel }); loader.open(); time.fire(); assert.equal(loader.output().reason, "handshake-timeout"); assert.equal(t.closed, 1);
});

test("proposal transport is verified but never applied, and stale proposals fall back", () => {
  const t = transport(); const proposals = []; const loader = createConstruction3dClientLoader({ pack, getPreflight: preflight, sessionId: "session:1", expectedOrigin: "https://unity.example", transportFactory: () => t, onProposal: (value) => proposals.push(value), ...noTimer });
  loader.open(); t.emit({ origin: "https://unity.example", data: handshake() }); t.emit({ origin: "https://unity.example", data: proposal() });
  assert.equal(loader.output().status, "connected"); assert.equal(proposals.length, 1); assert.ok(proposals[0].notPerformed.includes("change-set-apply"));
  t.emit({ origin: "https://unity.example", data: proposal("old") }); assert.equal(loader.output().status, "2d-only"); assert.equal(loader.output().reason, "proposal-rejected");
});

test("the three spatial-review observations are verified but never stored or applied", () => {
  for (const state of ["clear", "conflict", "unknown"]) {
    const input = freeze(preflight()); const t = transport(); const observed = [];
    const loader = createConstruction3dClientLoader({ pack, getPreflight: () => input, sessionId: "session:1", expectedOrigin: "https://unity.example", transportFactory: () => t, onProposal: (value) => observed.push(value), ...noTimer });
    loader.open(); t.emit({ origin: "https://unity.example", data: handshake() }); t.emit({ origin: "https://unity.example", data: review(state) });
    assert.equal(loader.output().status, "connected"); assert.equal(observed.length, 1); assert.equal(observed[0].spatialReview.applicable, true);
    assert.equal(observed[0].review.payload.observations[0].state, state); assert.ok(observed[0].notPerformed.includes("review-store"));
    assert.deepEqual(input, preflight());
  }
});

test("foreign, stale, or inactive spatial review cannot reach the host", () => {
  const input = preflight(); const valid = assessConstruction3dClientSpatialReview({ pack, preflight: input, handshake: handshake(), review: review("clear", "old"), sessionId: "session:1" });
  assert.equal(valid.applicable, false); assert.ok(valid.blockers.includes("review:review-source-stale:rail-geometry:rail:1"));
  const t = transport(); const loader = createConstruction3dClientLoader({ pack, getPreflight: () => input, sessionId: "session:1", expectedOrigin: "https://unity.example", transportFactory: () => t, ...noTimer });
  loader.open(); t.emit({ origin: "https://unity.example", data: handshake() }); t.emit({ origin: "https://unity.example", data: review("clear", "old") });
  assert.equal(loader.output().status, "2d-only"); assert.equal(loader.output().reason, "review-rejected"); assert.equal(t.closed, 1);
});

test("a stage-capable client receives current supplied stage facts only after the scene", () => {
  let currentStage = stage(5); const t = transport();
  const loader = createConstruction3dClientLoader({ pack, getPreflight: preflight, getStage: () => currentStage, sessionId: "session:1", expectedOrigin: "https://unity.example", transportFactory: () => t, ...noTimer });
  loader.open(); t.emit({ origin: "https://unity.example", data: stageHandshake() });
  assert.equal(loader.output().stage.status, "sent"); assert.deepEqual(t.sent.map((entry) => entry.kind), ["scene", "stage"]);
  assert.equal(t.sent[1].payload.entries.find((entry) => entry.id === "front:unknown").location, null);
  currentStage = stage(6); loader.sendStage(); assert.equal(t.sent.length, 3); assert.equal(t.sent[2].payload.simMinute, 6);
});

test("an invalid or unsupported stage is refused without a game-side fallback mutation", () => {
  const t = transport(); const loader = createConstruction3dClientLoader({ pack, getPreflight: preflight, getStage: () => ({ nope: true }), sessionId: "session:1", expectedOrigin: "https://unity.example", transportFactory: () => t, ...noTimer });
  loader.open(); t.emit({ origin: "https://unity.example", data: stageHandshake() });
  assert.equal(loader.output().status, "connected"); assert.equal(loader.output().stage.reason, "stage-invalid"); assert.equal(t.sent.length, 1);
});

test("mount surface opens only from its button and exposes detached state", () => {
  const t = transport(); const r = root(); const panel = mountConstruction3dClientLoader({ container: r, pack, getPreflight: preflight, sessionId: "session:1", expectedOrigin: "https://unity.example", transportFactory: () => t, ...noTimer });
  assert.equal(panel.output().status, "2d-only"); find(r, "construction-3d-loader-open").fire("click"); assert.equal(panel.output().status, "connecting");
  const out = panel.output(); out.status = "changed"; assert.equal(panel.output().status, "connecting");
});

test("iframe transport pins the URL, message source, and target origin", () => {
  const handlers = new Set(); const hostWindow = { addEventListener: (_kind, fn) => handlers.add(fn), removeEventListener: (_kind, fn) => handlers.delete(fn), fire: (event) => handlers.forEach((fn) => fn(event)) };
  const r = root(); const frameWindow = { sent: [], postMessage(data, origin) { this.sent.push({ data, origin }); } };
  const frame = Object.assign(new Node("iframe"), { contentWindow: frameWindow, removed: false, remove() { this.removed = true; } });
  const iframeDom = { createElement: () => frame }; const received = [];
  const t = createConstruction3dIframeTransport({ url: "https://unity.example/build/", expectedOrigin: "https://unity.example", container: r, hostWindow, documentRef: iframeDom }); t.subscribe((message) => received.push(message));
  t.send(handshake()); assert.equal(frameWindow.sent[0].origin, "https://unity.example");
  hostWindow.fire({ source: {}, origin: "https://unity.example", data: handshake() }); assert.equal(received.length, 0);
  hostWindow.fire({ source: frameWindow, origin: "https://unity.example", data: handshake() }); assert.equal(received.length, 1);
  t.close(); assert.equal(frame.removed, true); assert.equal(handlers.size, 0);
  assert.throws(() => createConstruction3dIframeTransport({ url: "https://foreign.example/build", expectedOrigin: "https://unity.example", container: r, hostWindow, documentRef: iframeDom }), /origin-mismatch/);
  assert.equal(typeof construction3dIframeTransportFactory({ url: "https://unity.example/build", container: r, hostWindow, documentRef: iframeDom }), "function");
});

test("iframe transport passes only exact parent-origin and session configuration to Unity", () => {
  const hostWindow = { location: { origin: "https://game.example" }, addEventListener() {}, removeEventListener() {} };
  const r = root(); const frame = Object.assign(new Node("iframe"), { contentWindow: { postMessage() {} } });
  createConstruction3dIframeTransport({ url: "https://unity.example/build/", expectedOrigin: "https://unity.example", sessionId: "session: 1", container: r, hostWindow, documentRef: { createElement: () => frame } });
  const url = new URL(frame.src); assert.equal(url.searchParams.get("hostOrigin"), "https://game.example"); assert.equal(url.searchParams.get("sessionId"), "session: 1");
});
