import test from "node:test";
import assert from "node:assert/strict";
import { buildConstruction3dIntegrationAudit } from "../src/construction-3d-integration-audit.mjs";
const pack = { manifest: { id: "tokyo" } }; const coordinates = { originLonLat: [139, 35], metersPerUnit: 1, axis: "east-up-north", verticalDatumMeters: 0 };
const source = { sourceType: "rail-geometry", sourceId: "a", sourceRevision: "r", active: true, sourcePackId: "tokyo" };
const client = { protocol: "transitline.construction-3d-adapter/1", contractVersion: 1, clientId: "unity", capabilities: ["scene-manifest-v1", "change-set-v1"] };
const scene = { schema: "transitline.construction-3d-scene/1", packId: "tokyo", coordinates, sources: [source] };
test("B24 audit joins current artifacts without applying them", () => {
  const out = buildConstruction3dIntegrationAudit({ pack, client, campaignPrograms: [{ id: "campaign-program:1", programId: "p", status: "monitoring", geometry: { status: "current" } }], scene, currentSources: [source] });
  assert.equal(out.applicable, true); assert.equal(out.fallback, null); assert.equal(out.programs.length, 1); assert.ok(out.notComputed.includes("ledger"));
});
test("unavailable client remains a valid 2D fallback while stale 3D proposals are blocked", () => {
  const changeSet = { schema: "transitline.construction-3d-change-set/1", contractVersion: 1, packId: "tokyo", status: "proposed", coordinates, changes: [{ sourceType: "rail-geometry", sourceId: "a", sourceRevision: "old" }] };
  const out = buildConstruction3dIntegrationAudit({ pack, scene, changeSet, currentSources: [source] });
  assert.equal(out.fallback, "2d-only"); assert.equal(out.applicable, false); assert.ok(out.blockers.includes("change-set:change-target-stale:rail-geometry:a"));
});
