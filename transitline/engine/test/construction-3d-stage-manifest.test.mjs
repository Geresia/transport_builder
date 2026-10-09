import test from "node:test";
import assert from "node:assert/strict";
import { buildConstruction3dStageManifest } from "../src/construction-3d-stage-manifest.mjs";
const pack = { manifest: { id: "radial", version: "1" } };
test("stage manifest is a deterministic display of supplied construction facts", () => {
  const out = buildConstruction3dStageManifest({ pack, simMinute: 12.9, packages: [{ id: "p", status: "awarded", location: [1, 2] }], workfronts: [{ id: "w", status: "open", location: null }], events: [] });
  assert.equal(out.simMinute, 12); assert.equal(out.entries.length, 2); assert.equal(out.entries.find((entry) => entry.id === "w").locationReason, "location-unknown");
  assert.ok(out.notComputed.includes("progress"));
});
test("missing collections and locations remain unknown, not fake zero facts", () => {
  const out = buildConstruction3dStageManifest({ pack, packages: null });
  assert.equal(out.simMinute, null); assert.ok(out.warnings.some((entry) => entry.code === "stage-collection-not-provided" && entry.kind === "package"));
});
