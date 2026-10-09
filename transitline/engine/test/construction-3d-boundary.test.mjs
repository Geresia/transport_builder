import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { buildConstruction3dPreflight } from "../src/construction-3d-preflight.mjs";

const root = fileURLToPath(new URL("../src/", import.meta.url));
const modules = ["construction-3d-exchange.mjs", "construction-3d-adapter.mjs", "construction-3d-client-envelope.mjs", "construction-3d-session-coordinator.mjs", "construction-3d-source-adapters.mjs", "construction-3d-spatial-review.mjs", "construction-3d-stage-manifest.mjs", "construction-3d-integration-audit.mjs", "construction-3d-preflight.mjs", "construction-3d-preflight-panel.mjs", "construction-3d-preflight-benchmark.mjs", "construction-3d-coordinate-profile.mjs"];
test("B21-B24 contracts do not import a management/runtime owner or write host storage", () => {
  for (const name of modules) {
    const source = fs.readFileSync(`${root}${name}`, "utf8");
    assert.doesNotMatch(source, /from\s+["'][^"']*(management|scenario-runtime)[^"']*["']/i, name);
    assert.doesNotMatch(source, /\b(localStorage|sessionStorage|Math\.random|Date\.now)\b/, name);
  }
});
test("B24 preflight retains explicit 2D fallback and declares unperformed renderer work", () => {
  const out = buildConstruction3dPreflight({ pack: { manifest: { id: "p" } }, coordinates: null });
  assert.equal(out.fallback, "2d-only");
  assert.equal(out.readyForOptional3d, false);
  assert.deepEqual(out.notPerformed, ["unity-load", "render", "change-set-apply", "construction-approval", "clock-advance"]);
});
