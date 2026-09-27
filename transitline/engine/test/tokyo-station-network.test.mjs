// node --test engine/test/tokyo-station-network.test.mjs — sanity of packs/tokyo/station-network.json (built by
// scripts/tokyo-station-network.mjs). Skipped when the file has not been generated.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { haversineMetres } from "../src/projection.mjs";

const file = new URL("../../packs/tokyo/station-network.json", import.meta.url);
const present = existsSync(file);
const net = present ? JSON.parse(readFileSync(file, "utf8")) : null;

test("every line references real stations and stays plausible", { skip: !present }, () => {
  const byId = new Map(net.stations.map((s) => [s.id, s]));
  assert.equal(byId.size, net.stations.length, "station ids are unique");
  for (const l of net.lines) {
    assert.ok(l.stationIds.length >= 2, `${l.name} has at least two stations`);
    for (const id of l.stationIds) assert.ok(byId.has(id), `${l.name}: unknown station ${id}`);
    for (let i = 1; i < l.stationIds.length; i++) {
      const d = haversineMetres(byId.get(l.stationIds[i - 1]).location, byId.get(l.stationIds[i]).location);
      assert.ok(d < 60000, `${l.name}: ${byId.get(l.stationIds[i - 1]).name} -> ${byId.get(l.stationIds[i]).name} is ${Math.round(d)} m apart`);
    }
  }
});

test("stations know their lines, and the network has the shape of greater Tokyo", { skip: !present }, () => {
  const lineIds = new Set(net.lines.map((l) => l.id));
  for (const s of net.stations) {
    assert.ok(s.name && s.lines.length > 0, `${s.id} is on at least one line`);
    for (const id of s.lines) assert.ok(lineIds.has(id));
  }
  assert.ok(net.stations.length > 1000, `${net.stations.length} stations`);
  assert.ok(net.lines.length > 100, `${net.lines.length} lines`);
  const named = (n) => net.stations.some((s) => s.name === n || s.name_en === n);
  for (const n of ["新宿", "東京", "渋谷"]) assert.ok(named(n), `${n} exists`);
  assert.ok(net.lines.some((l) => l.operators.length > 1), "through-running lines keep several operators");
});
