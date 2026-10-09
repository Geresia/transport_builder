import test from "node:test";
import assert from "node:assert/strict";
import { construction3dClientEnvelope } from "../src/construction-3d-client-envelope.mjs";
import { createConstruction3dClientLoader, mountConstruction3dClientLoader } from "../src/construction-3d-client-loader.mjs";
import { buildConstruction3dPreflight } from "../src/construction-3d-preflight.mjs";

const pack = { manifest: { id: "example-radial", version: "1" } };
const coordinates = { originLonLat: [0, 0], metersPerUnit: 1, axis: "east-up-north", verticalDatumMeters: 0 };
const client = { protocol: "transitline.construction-3d-adapter/1", contractVersion: 1, clientId: "unity-webgl", clientVersion: "0.1", capabilities: ["scene-manifest-v1", "change-set-v1"] };
const preflight = () => buildConstruction3dPreflight({ pack, coordinates, railGeometries: { designs: [{ railGeometryId: "rail:1", railGeometryRevision: "r1", sourcePackId: "example-radial", active: true, sections: [{ alignment: [[0, 0], [1, 1]] }] }] } });
const handshake = () => construction3dClientEnvelope({ sessionId: "session:1", kind: "handshake", payload: client });
const proposal = (revision = "r1") => construction3dClientEnvelope({ sessionId: "session:1", kind: "change-set", payload: { schema: "transitline.construction-3d-change-set/1", contractVersion: 1, packId: "example-radial", status: "proposed", coordinates, changes: [{ sourceType: "rail-geometry", sourceId: "rail:1", sourceRevision: revision }] } });
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

test("mount surface opens only from its button and exposes detached state", () => {
  const t = transport(); const r = root(); const panel = mountConstruction3dClientLoader({ container: r, pack, getPreflight: preflight, sessionId: "session:1", expectedOrigin: "https://unity.example", transportFactory: () => t, ...noTimer });
  assert.equal(panel.output().status, "2d-only"); find(r, "construction-3d-loader-open").fire("click"); assert.equal(panel.output().status, "connecting");
  const out = panel.output(); out.status = "changed"; assert.equal(panel.output().status, "connecting");
});
