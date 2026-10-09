import test from "node:test";
import assert from "node:assert/strict";
import { measureConstruction3dPreflight } from "../src/construction-3d-preflight-benchmark.mjs";
const input = { pack: { manifest: { id: "p" } }, coordinates: { originLonLat: [0, 0], metersPerUnit: 1, axis: "east-up-north", verticalDatumMeters: 0 } };
test("benchmark records injected elapsed time but does not claim renderer measurements", () => { let n = 10; const out = measureConstruction3dPreflight(input, { now: () => (n += 7), label: "synthetic" }); assert.equal(out.elapsedMilliseconds, 7); assert.equal(out.label, "synthetic"); assert.ok(out.notMeasured.includes("gpu")); assert.equal(out.preflight.fallback, "2d-only"); });
test("invalid clocks are refused instead of inventing timing", () => { assert.throws(() => measureConstruction3dPreflight(input, { now: () => NaN }), /finite/); let n = 3; assert.throws(() => measureConstruction3dPreflight(input, { now: () => (n--), }), /backwards/); });
