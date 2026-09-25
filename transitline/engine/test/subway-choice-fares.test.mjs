// node --test engine/test/subway-choice-fares.test.mjs — income-based mode choice and fare groups (see
// docs/subway-builder-mechanics-study.md "수단 선택" / "운임"). Synthetic inputs, hand-computed expectations.
import test from "node:test";
import assert from "node:assert/strict";
import { inverseNormalCDF, incomeForPerson, drivingTimeMultiplier, perceivedDrivingTime, perceivedTransitTime, modeSplit } from "../src/mode-choice-pop.mjs";
import { computeJourneyFareBreakdown, distanceFare, roundToIncrement } from "../src/fares.mjs";
import { haversineMetres } from "../src/projection.mjs";

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);

test("inverse normal CDF matches known quantiles", () => {
  close(inverseNormalCDF(0.5), 0, 1e-9);
  close(inverseNormalCDF(0.975), 1.959964, 1e-4);
  close(inverseNormalCDF(0.8413447), 1, 1e-4);
  close(inverseNormalCDF(0.1), -1.281552, 1e-4);
});

test("income is deterministic, bounded and centred near the mean", () => {
  assert.equal(incomeForPerson(7, 100), incomeForPerson(7, 100));
  close(incomeForPerson(0, 100), 6e4 + inverseNormalCDF(0.1) * 25e3, 1e-6); // poorest draw is re-drawn from the 10% quantile
  let sum = 0;
  for (let i = 0; i < 1000; i++) sum += incomeForPerson(i, 1000);
  const mean = sum / 1000;
  assert.ok(mean > 58000 && mean < 74000, `${mean}`);
  assert.ok(incomeForPerson(500, 1000, 1.5) > incomeForPerson(500, 1000, 0.6), "airport pops earn more than college pops");
});

test("traffic multiplier by hour and perceived driving time", () => {
  assert.deepEqual([2, 5, 8, 10, 12, 15, 17].map(drivingTimeMultiplier), [0.8, 0.9, 1.5, 1.25, 1, 1.25, 1.5]);
  // 600 s at rush hour: 600 x 1.5 x (1 + 0.5 x 0.33) + 2 x 180 x 1.6
  close(perceivedDrivingTime(600, 1.5), 900 * 1.165 + 576);
  close(perceivedDrivingTime(600, 1), 600 + 576); // free flow: no congestion premium
});

test("perceived transit time weighs walk, wait and late departure", () => {
  const segs = [
    { kind: "walk", departureTime: 0, arrivalTime: 300 },
    { kind: "transit", departureTime: 420, arrivalTime: 1200 },
    { kind: "walk", departureTime: 1200, arrivalTime: 1500 },
  ];
  const p = perceivedTransitTime(segs, 0);
  assert.equal(p.wait, 120);
  close(p.perceivedTime, 780 + 600 * 1.39 + 120 * 1.37);
  close(perceivedTransitTime(segs, -100).perceivedTime, p.perceivedTime + 100 * 0.4);
});

test("mode split: long trip -> transit, short trip -> walking, tiny transit groups fall back to driving", () => {
  const long = modeSplit({ population: 100, drivingTime: 2400, drivingDistance: 20000, transitTime: 1500, walkTime: 20000, drivingTimeMultiplier: 1.5 });
  assert.deepEqual(long, { driving: 0, transit: 100, walking: 0 });
  const short = modeSplit({ population: 100, drivingTime: 120, drivingDistance: 500, transitTime: 900, walkTime: 400 });
  assert.equal(short.walking, 100);
  const tiny = modeSplit({ population: 9, drivingTime: 2400, drivingDistance: 20000, transitTime: 1500, walkTime: 20000, drivingTimeMultiplier: 1.5 });
  assert.deepEqual(tiny, { driving: 9, transit: 0, walking: 0 }, "fewer than 10 transit choosers are moved to driving");
  const a = modeSplit({ population: 200, drivingTime: 900, drivingDistance: 8000, transitTime: 1300, walkTime: 6000 });
  assert.deepEqual(a, modeSplit({ population: 200, drivingTime: 900, drivingDistance: 8000, transitTime: 1300, walkTime: 6000 }));
});

// ---- fares --------------------------------------------------------------------------------------------------------
const flat = (id, fare, extra = {}) => ({ groupId: id, fareSystem: "flat", fare, transferPolicy: "count-within-group", boardingCharge: 0, perKmRate: 0, fareCap: 0, zoneBaseFare: 0, zonePerZoneFare: 0, ...extra });
const tr = (routeId, from, to, fromStopCoords, toStopCoords) => ({ routeId, fromStopId: from, toStopId: to, fromStopCoords, toStopCoords });

test("rounding to 0.05 and fare caps", () => {
  assert.equal(roundToIncrement(1.03), 1.05);
  assert.equal(roundToIncrement(1.02), 1);
  const g = { boardingCharge: 1, perKmRate: 0.5, fareCap: 8 };
  assert.equal(distanceFare(30, g), 8);
  assert.equal(distanceFare(2, g), 2);
});

test("flat fares: unknown routes use the default fare once; walking is free; all-paid charges every ride", () => {
  const segs = [{ kind: "walk", routeId: "walking" }, tr("X", "a", "b"), tr("Y", "b", "c")];
  const r = computeJourneyFareBreakdown(segs, {}, 3);
  assert.equal(r.total, 3);
  assert.deepEqual(r.items.map((i) => i.kind), ["paid", "included"]);
  const idx = { X: flat("A", 2, { transferPolicy: "all-paid" }), Y: flat("B", 2, { transferPolicy: "all-paid" }) };
  assert.equal(computeJourneyFareBreakdown(segs, idx, 3).total, 4);
});

test("count-all-groups: arriving from another group waives this group's entry charge", () => {
  const idx = { X: flat("A", 2), Y: flat("B", 3, { transferPolicy: "count-all-groups" }) };
  const r = computeJourneyFareBreakdown([tr("X", "a", "b"), tr("Y", "b", "c")], idx, 3);
  assert.equal(r.total, 2);
  assert.equal(r.items[1].kind, "credited");
  const noCredit = { X: flat("A", 2), Y: flat("B", 3) };
  assert.equal(computeJourneyFareBreakdown([tr("X", "a", "b"), tr("Y", "b", "c")], noCredit, 3).total, 5);
});

test("route fares: one fare per distinct route within a group", () => {
  const g = (routeFare) => ({ ...flat("R", 0), fareSystem: "route", routeFare });
  const idx = { r1: g(2.5), r2: g(2.5) };
  assert.equal(computeJourneyFareBreakdown([tr("r1", "a", "b"), tr("r1", "b", "c")], idx, 3).total, 2.5);
  assert.equal(computeJourneyFareBreakdown([tr("r1", "a", "b"), tr("r2", "b", "c")], idx, 3).total, 5);
});

test("distance fares accumulate straight-line km within a group", () => {
  const p = [[139.7, 35.68], [139.81, 35.68], [139.92, 35.68]];
  const g = { ...flat("D", 0), fareSystem: "distance", boardingCharge: 1, perKmRate: 0.5 };
  const idx = { d: g };
  const r = computeJourneyFareBreakdown([tr("d", "a", "b", p[0], p[1]), tr("d", "b", "c", p[1], p[2])], idx, 3);
  const km = (haversineMetres(p[0], p[1]) + haversineMetres(p[1], p[2])) / 1000;
  assert.equal(r.total, distanceFare(km, g));
  assert.ok(r.items[0].amount > 0 && r.items[1].amount > 0);
  const allPaid = { d: { ...g, transferPolicy: "all-paid" } };
  const r2 = computeJourneyFareBreakdown([tr("d", "a", "b", p[0], p[1]), tr("d", "b", "c", p[1], p[2])], allPaid, 3);
  assert.ok(r2.total > r.total, "all-paid charges the boarding fee on every leg");
});

test("zone fares count the distinct zones touched across the group", () => {
  const g = { ...flat("Z", 0), fareSystem: "zone", zoneBaseFare: 2, zonePerZoneFare: 1, zoneIndexByStation: { a: 0, b: 1, c: 2 }, zonePricingMode: "count", zoneTotal: 3 };
  const r = computeJourneyFareBreakdown([tr("z", "a", "b"), tr("z", "b", "c")], { z: g }, 3);
  assert.equal(r.items[0].amount, 3); // zones 1-2: 2 + 1
  assert.equal(r.items[1].amount, 1); // now zones 1-3: 4 total, 1 more
  assert.equal(r.total, 4);
});
