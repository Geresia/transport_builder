import test from "node:test";
import assert from "node:assert/strict";
import { buildRouteGraph } from "../src/network.mjs";
import { findRoute } from "../src/routing.mjs";

test("large fixed graph route benchmark", () => {
  const stations = new Map();
  for (let i = 0; i < 250; i++) stations.set(`s${i}`, { id: `s${i}`, location: [139 + (i % 25) * 0.002, 35 + Math.floor(i / 25) * 0.002] });
  const lines = [];
  let id = 1;
  for (let row = 0; row < 10; row++) lines.push({ id: id++, stationIds: Array.from({ length: 25 }, (_, col) => `s${row * 25 + col}`) });
  for (let col = 0; col < 25; col++) lines.push({ id: id++, stationIds: Array.from({ length: 10 }, (_, row) => `s${row * 25 + col}`) });
  const graph = buildRouteGraph({ stations, lines });
  const started = performance.now();
  let totalHops = 0;
  for (let repeat = 0; repeat < 40; repeat++) {
    for (let i = 0; i < 250; i++) totalHops += findRoute(graph, `s${i}`, `s${249 - i}`)?.hops.length ?? 0;
  }
  const elapsedMs = performance.now() - started;
  assert.ok(totalHops > 0);
  assert.ok(elapsedMs < 5000, `10,000 cached queries took ${elapsedMs.toFixed(1)} ms`);
  console.log({ graphStations: 250, queries: 10000, elapsedMs: +elapsedMs.toFixed(1) });
});
