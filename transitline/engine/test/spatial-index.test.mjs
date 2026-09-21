// node engine/test/spatial-index.test.mjs — GridIndex vs brute force on random Tokyo-area points.
import { GridIndex } from "../src/spatial-index.mjs";
import { haversineMetres } from "../src/projection.mjs";
let seed = 12345;
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const pt = () => [139.4 + rand() * 0.6, 35.4 + rand() * 0.5];
const pts = Array.from({ length: 50000 }, (_, i) => ({ id: i, location: pt() }));
const idx = new GridIndex(35.68);
for (const p of pts) idx.insert(p.id, p.location);
const queries = Array.from({ length: 300 }, pt);
const brute = (q) => pts.reduce((b, p) => { const d = haversineMetres(q, p.location); return !b || d < b.distance ? { id: p.id, distance: d } : b; }, null);
let t = performance.now();
const got = queries.map((q) => idx.nearest(q));
const tIdx = performance.now() - t;
t = performance.now();
const want = queries.map(brute);
const tBrute = performance.now() - t;
let bad = 0;
queries.forEach((_, i) => { if (Math.abs(got[i].distance - want[i].distance) > 1e-6) bad++; });
let badWithin = 0;
for (const q of queries.slice(0, 50)) {
  const a = idx.within(q, 500).map((e) => e.id).sort((x, y) => x - y).join();
  const b = pts.filter((p) => haversineMetres(q, p.location) <= 500).map((p) => p.id).sort((x, y) => x - y).join();
  if (a !== b) badWithin++;
}
const sparse = new GridIndex(35.68); sparse.insert("far", [139.9, 35.9]);
const farOk = sparse.nearest([139.4, 35.4])?.id === "far" && sparse.nearest([139.4, 35.4], 1000) === null && new GridIndex(35).nearest([139, 35]) === null;
console.log({ points: pts.length, queries: queries.length, nearestMismatch: bad, withinMismatch: badWithin, sparseAndEmptyOk: farOk, gridMs: +tIdx.toFixed(1), bruteMs: +tBrute.toFixed(1) });
if (bad || badWithin || !farOk) process.exit(1);
