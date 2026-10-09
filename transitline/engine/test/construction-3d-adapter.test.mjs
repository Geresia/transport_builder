import test from "node:test";
import assert from "node:assert/strict";
import { assessConstruction3dClient, construction3dSessionDocument, CONSTRUCTION_3D_ADAPTER_PROTOCOL } from "../src/construction-3d-adapter.mjs";

const client = { protocol: CONSTRUCTION_3D_ADAPTER_PROTOCOL, contractVersion: 1, clientId: "unity-webgl", clientVersion: "0.1", capabilities: ["change-set-v1", "scene-manifest-v1"] };
test("optional 3D client has a deterministic capability handshake", () => {
  const result = assessConstruction3dClient(client);
  assert.equal(result.status, "ready"); assert.equal(result.usable, true); assert.deepEqual(result.missingCapabilities, []);
});
test("unavailable or incomplete client explicitly falls back to 2D", () => {
  assert.equal(assessConstruction3dClient(null).fallback, "2d-only");
  const partial = assessConstruction3dClient({ ...client, capabilities: ["scene-manifest-v1"] });
  assert.equal(partial.status, "limited"); assert.equal(partial.usable, false);
});
test("serialized session stores only references, not a client runtime blob", () => {
  const doc = construction3dSessionDocument({ client, selectedSourceIds: ["b", "a", "a"], selectedChangeSetId: "change:1" });
  assert.deepEqual(doc.selectedSourceIds, ["a", "b"]); assert.equal("binary" in doc, false); assert.equal(doc.client.clientId, "unity-webgl");
});
