// B24 measurement harness. It records only caller-measured preflight elapsed
// time; it does not claim Unity, GPU, FPS, memory, or rendering performance.
import { buildConstruction3dPreflight } from "./construction-3d-preflight.mjs";
export const CONSTRUCTION_3D_PREFLIGHT_BENCHMARK_SCHEMA = "transitline.construction-3d-preflight-benchmark/1";
const clone = (value) => structuredClone(value);
export function measureConstruction3dPreflight(input, { now = () => performance.now(), label = null } = {}) {
  if (typeof now !== "function") throw new Error("benchmark now() is required");
  const started = now(); if (!Number.isFinite(started)) throw new Error("benchmark now() must return a finite number");
  const preflight = buildConstruction3dPreflight(input);
  const ended = now(); if (!Number.isFinite(ended) || ended < started) throw new Error("benchmark clock moved backwards or is invalid");
  return { schema: CONSTRUCTION_3D_PREFLIGHT_BENCHMARK_SCHEMA, contractVersion: 1, label: typeof label === "string" && label.trim() ? label.trim() : null, elapsedMilliseconds: ended - started, preflight: clone(preflight), measured: ["2d-source-normalization", "scene-manifest", "session-gate", "integration-audit"], notMeasured: ["unity-load", "webgl", "desktop-render", "gpu", "fps", "memory", "network"] };
}
