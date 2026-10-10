// B24 release gate: the optional client must be observational. These tests use
// the same virtual transport as an iframe would, while a real ScenarioRuntime
// proves that no simulation owner changes when the 3D path is exercised.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { construction3dClientEnvelope } from "../src/construction-3d-client-envelope.mjs";
import { createConstruction3dClientLoader } from "../src/construction-3d-client-loader.mjs";
import { buildConstruction3dPreflight } from "../src/construction-3d-preflight.mjs";
import { measureConstruction3dPreflight } from "../src/construction-3d-preflight-benchmark.mjs";
import { ScenarioRuntime } from "../src/scenario-runtime.mjs";
import { createState } from "../src/state.mjs";

const read = (rel) => JSON.parse(fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8"));
const coordinates = { originLonLat: [139, 35], metersPerUnit: 1, axis: "east-up-north", verticalDatumMeters: 0 };
const client = { protocol: "transitline.construction-3d-adapter/1", contractVersion: 1, clientId: "unity-webgl", clientVersion: "0.1", capabilities: ["scene-manifest-v1", "change-set-v1", "stage-manifest-v1"] };
const world = (pack) => ({ pack, coordinates, railGeometries: { designs: [{ railGeometryId: "rail:release", railGeometryRevision: "r1", sourcePackId: pack.manifest.id, active: true, sections: [{ alignment: [[139, 35], [139.01, 35.01]] }] }] } });
const openTransport = () => { let listener = null; return { sent: [], closed: 0, send(value) { this.sent.push(structuredClone(value)); }, subscribe(fn) { listener = fn; return () => { listener = null; }; }, close() { this.closed += 1; }, emit(data) { listener?.({ origin: "https://unity.example", data }); } }; };
const handshake = () => construction3dClientEnvelope({ sessionId: "release:1", kind: "handshake", payload: client });
const proposal = (payload) => construction3dClientEnvelope({ sessionId: "release:1", kind: "change-set", payload });
const releasePack = { manifest: { id: "release-synthetic", version: "1", data: { license: "test", attribution: [] } }, demand: { model: "gravity", points: [], attractors: [] } };

test("2D-only and connected WebGL paths receive byte-identical scene snapshots without mutating a real runtime", () => {
  const runtime = new ScenarioRuntime({ pack: releasePack, operationalState: createState(releasePack), networkMode: "scratch", seed: 71 });
  const before = runtime.game.snapshot(); const rng = runtime.game.rng.snapshot(); const clock = runtime.game.clock.minute; const cash = runtime.game.player.cash;
  const input = world(releasePack); const preflight = () => buildConstruction3dPreflight(input);
  const twoDimensional = preflight(); assert.equal(twoDimensional.fallback, "2d-only");
  const transport = openTransport(); const loader = createConstruction3dClientLoader({ pack: releasePack, getPreflight: preflight, sessionId: "release:1", expectedOrigin: "https://unity.example", transportFactory: () => transport, schedule: () => 1, cancel: () => {} });
  loader.open(); transport.emit(handshake());
  assert.equal(loader.output().status, "connected"); assert.deepEqual(transport.sent[0].payload, twoDimensional.scene);
  assert.deepEqual(runtime.game.snapshot(), before); assert.deepEqual(runtime.game.rng.snapshot(), rng); assert.equal(runtime.game.clock.minute, clock); assert.equal(runtime.game.player.cash, cash);
});

test("Tokyo and a synthetic pack retain deterministic scene bytes across a JSON save-load boundary", () => {
  for (const manifest of [read("../../packs/tokyo/manifest.json"), read("../../packs/example-radial/manifest.json")]) {
    const pack = { manifest }; const first = buildConstruction3dPreflight(world(pack)).scene;
    const restored = JSON.parse(JSON.stringify(first)); const next = buildConstruction3dPreflight(world(pack)).scene;
    assert.equal(JSON.stringify(restored), JSON.stringify(next), manifest.id);
    assert.equal(restored.packId, manifest.id); assert.equal(restored.sources[0].sourcePackId, manifest.id);
  }
});

test("the release gate rejects every non-current proposal and records only measured host preflight time", () => {
  const input = world(releasePack); const preflight = () => buildConstruction3dPreflight(input); const transport = openTransport();
  const loader = createConstruction3dClientLoader({ pack: releasePack, getPreflight: preflight, sessionId: "release:1", expectedOrigin: "https://unity.example", transportFactory: () => transport, schedule: () => 1, cancel: () => {} });
  loader.open(); transport.emit(handshake());
  for (const invalid of [
    { schema: "transitline.construction-3d-change-set/1", contractVersion: 1, packId: "foreign", status: "proposed", coordinates, changes: [{ sourceType: "rail-geometry", sourceId: "rail:release", sourceRevision: "r1" }] },
    { schema: "transitline.construction-3d-change-set/1", contractVersion: 1, packId: releasePack.manifest.id, status: "proposed", coordinates, changes: [{ sourceType: "rail-geometry", sourceId: "rail:release", sourceRevision: "old" }] },
    { schema: "transitline.construction-3d-change-set/1", contractVersion: 1, packId: releasePack.manifest.id, status: "proposed", coordinates: { ...coordinates, metersPerUnit: 2 }, changes: [{ sourceType: "rail-geometry", sourceId: "rail:release", sourceRevision: "r1" }] },
    { schema: "transitline.construction-3d-change-set/1", contractVersion: 1, packId: releasePack.manifest.id, status: "proposed", coordinates, changes: [{ sourceType: "rail-geometry", sourceId: "missing", sourceRevision: "r1" }] },
  ]) {
    transport.emit(proposal(invalid)); assert.equal(loader.output().status, "2d-only"); assert.equal(loader.output().reason, "proposal-rejected");
    loader.open(); transport.emit(handshake());
  }
  const time = [10, 17]; const benchmark = measureConstruction3dPreflight(input, { now: () => time.shift(), label: "B24 release gate" });
  assert.equal(benchmark.elapsedMilliseconds, 7); assert.ok(benchmark.notMeasured.includes("webgl")); assert.ok(!benchmark.measured.includes("unity-load"));
});
