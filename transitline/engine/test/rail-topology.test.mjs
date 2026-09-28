// node --test engine/test/rail-topology.test.mjs — the graph helpers scripts/tokyo-station-network-mlit.mjs uses to
// turn MLIT N02's unordered station/segment records into one ordered path per line.
import test from "node:test";
import assert from "node:assert/strict";
import { clusterStations, longestPath } from "../../scripts/lib/rail-topology.mjs";

test("clusters same-named records within the distance threshold, keeps far-apart same-named ones apart", () => {
  const near = (dx, dy) => [139.7 + dx * 0.001, 35.69 + dy * 0.001]; // ~110 m per 0.001 deg here
  const records = [
    { name: "新宿", point: near(0, 0), operator: "A" },
    { name: "新宿", point: near(2, 3), operator: "B" }, // ~400 m away: same complex
    { name: "本町", point: [135.5, 34.7], operator: "C" }, // Osaka Honmachi
    { name: "本町", point: [140.9, 42.6], operator: "D" }, // Hakodate Honmachi, far away: different station
  ];
  const clusters = clusterStations(records, 700);
  const shinjuku = clusters.filter((c) => c.name === "新宿");
  assert.equal(shinjuku.length, 1);
  assert.equal(shinjuku[0].members.length, 2);
  const honmachi = clusters.filter((c) => c.name === "本町");
  assert.equal(honmachi.length, 2, "two different real stations sharing a name stay separate");
});

test("longest path walks a simple line end to end in order", () => {
  const segs = [
    { from: "a", to: "b", lengthM: 1000 },
    { from: "b", to: "c", lengthM: 1500 },
    { from: "c", to: "d", lengthM: 800 },
  ];
  const path = longestPath(segs);
  assert.ok(path[0] === "a" && path.at(-1) === "d" || path[0] === "d" && path.at(-1) === "a");
  assert.equal(path.length, 4);
});

test("a Y-junction keeps the trunk plus its longer arm, drops the shorter branch", () => {
  // trunk a-b-h (2500 m) forks at h into a long arm h-x1-x2 (2000 m) and a short branch h-y1 (500 m)
  const segs = [
    { from: "a", to: "b", lengthM: 1000 },
    { from: "b", to: "h", lengthM: 1500 },
    { from: "h", to: "x1", lengthM: 1000 },
    { from: "x1", to: "x2", lengthM: 1000 },
    { from: "h", to: "y1", lengthM: 500 },
  ];
  const path = longestPath(segs);
  assert.deepEqual(new Set(path), new Set(["a", "b", "h", "x1", "x2"]));
});

test("a loop line is walked as its longest chord, not left unresolved", () => {
  const segs = [
    { from: "a", to: "b", lengthM: 1000 },
    { from: "b", to: "c", lengthM: 1000 },
    { from: "c", to: "d", lengthM: 1000 },
    { from: "d", to: "a", lengthM: 1000 },
  ];
  const path = longestPath(segs);
  assert.equal(path.length, 3, "the diameter of a 4-node cycle is 3 nodes (2 hops)");
});

test("fewer than two connected stations gives no line", () => {
  assert.equal(longestPath([]), null);
  assert.equal(longestPath([{ from: "a", to: "a", lengthM: 0 }]), null);
});
