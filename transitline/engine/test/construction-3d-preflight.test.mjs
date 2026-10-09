import test from "node:test";
import assert from "node:assert/strict";
import { buildConstruction3dPreflight } from "../src/construction-3d-preflight.mjs";
const pack = { manifest: { id: "example-radial", version: "1" } };
const coordinates = { originLonLat: [139, 35], metersPerUnit: 1, axis: "east-up-north", verticalDatumMeters: 0 };
const client = { protocol: "transitline.construction-3d-adapter/1", contractVersion: 1, clientId: "optional", capabilities: ["scene-manifest-v1", "change-set-v1"] };
const input = { pack, coordinates, client, railGeometries: { designs: [{ railGeometryId: "rail:1", railGeometryRevision: "r1", sourcePackId: "example-radial", sections: [] }] } };
test("preflight composes current 2D facts into scene, session and audit without a renderer", () => { const out = buildConstruction3dPreflight(input); assert.equal(out.scene.sources.length, 1); assert.equal(out.session.mode, "3d-available"); assert.equal(out.audit.applicable, true); assert.equal(out.readyForOptional3d, true); });
test("invalid coordinates keep the optional path at 2D fallback", () => { const out = buildConstruction3dPreflight({ ...input, coordinates: null }); assert.equal(out.scene, null); assert.equal(out.session.mode, "2d-only"); assert.equal(out.readyForOptional3d, false); assert.ok(out.sceneError); });
