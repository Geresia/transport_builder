import test from "node:test";
import assert from "node:assert/strict";
import { buildRailReplacementManagementView } from "../src/rail-replacement-management-ui.mjs";

function geometry(overrides = {}) {
  return { schema: "transitline.rail-replacement-transport-geometry/1", contractVersion: 1, replacementGeometryId: "replacement:1", replacementGeometryRevision: "rev:1", eventId: "event:1", controlGeometryId: "control:1", routeCandidates: [{ routeId: "route:1", lengthMeters: 3200 }], ...overrides };
}

test("replacement management view exposes only current M8 geometry and never mutates map facts", () => {
  const input = geometry(); const before = structuredClone(input);
  const view = buildRailReplacementManagementView({ geometries: [input, { ...input, schema: "wrong" }] });
  assert.equal(view.hasGeometryInput, true);
  assert.deepEqual(view.geometryOptions, [{ id: "replacement:1", revision: "rev:1", eventId: "event:1", controlOrderHint: null, routeCount: 1, routes: [{ id: "route:1", lengthMeters: 3200 }] }]);
  assert.equal(view.busClasses.length, 3); assert.equal(view.procurementStrategies.length, 3); assert.deepEqual(input, before);
});

test("replacement management view keeps an honest empty state and displays operating actuals", () => {
  const view = buildRailReplacementManagementView({ operations: [{ id: "operation:1", status: "active", eventId: "event:1", controlOrderId: "order:1", routeId: "route:1", vehicleClassId: "standard", procurementStrategyId: "emergency-charter", vehicleCount: 2, headwaySeconds: 900, passengersCarried: 42, vehicleKilometres: 18.5, mobilisationCostJPY: 360000, settledOperatingCostJPY: 18000, assumptions: ["road-unknown"] }] });
  assert.equal(view.hasGeometryInput, false); assert.equal(view.operations[0].passengersCarried, 42); assert.deepEqual(view.operations[0].assumptions, ["road-unknown"]);
});
