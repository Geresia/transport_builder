// node --test engine/test/router-raptor.test.mjs — timetable router on a hand-built cross of two lines.
import test from "node:test";
import assert from "node:assert/strict";
import { outAndBackPattern, buildTimetable, routeJourney } from "../src/router-raptor.mjs";
import { perceivedTransitTime } from "../src/mode-choice-pop.mjs";

const LON = 0.0125; // ~1.1 km of longitude at Tokyo's latitude
const LAT = 0.01; // ~1.1 km of latitude
const at = (x, y) => [139.7 + x * LON, 35.68 + y * LAT];
// Line A runs west-east through x = 0,1,2 (y = 0); line B runs south-north through y = -1,0,1 (x = 1) and shares station "c" with A.
const stations = new Map([["a0", at(0, 0)], ["c", at(1, 0)], ["a2", at(2, 0)], ["b0", at(1, -1)], ["b2", at(1, 1)]].map(([id, location]) => [id, { location }]));
const A = (headwayS = 600) => outAndBackPattern({ routeId: "A", stationIds: ["a0", "c", "a2"], legSeconds: [100, 100], dwellS: 20, headwayS });
const B = (headwayS = 600) => outAndBackPattern({ routeId: "B", stationIds: ["b0", "c", "b2"], legSeconds: [100, 100], dwellS: 20, headwayS });
const near = (id, dx = 0, dy = 0) => { const [lon, lat] = stations.get(id).location; return [lon + dx * 1e-4, lat + dy * 1e-4]; };

test("out-and-back pattern lists the turn-back stops with running time plus dwell", () => {
  const p = A();
  assert.deepEqual(p.stops, ["a0", "c", "a2", "c", "a0"]);
  assert.deepEqual(p.arr, [0, 120, 240, 360, 480]);
  assert.deepEqual(p.dep, [20, 140, 260, 380, 500]);
});

test("direct ride: walk, wait, ride, walk; times line up with the timetable", () => {
  const tt = buildTimetable({ stations, patterns: [A()] });
  const r = routeJourney(tt, near("a0", 0, 30), near("a2", 0, 30), 1000);
  assert.deepEqual(r.segments.map((s) => s.kind), ["walk", "transit", "walk"]);
  const ride = r.segments[1];
  assert.equal(ride.routeId, "A");
  assert.deepEqual([ride.fromStopId, ride.toStopId], ["a0", "a2"]);
  assert.equal(ride.departureTime, 1820); // trips stand at a0 from 0+600k for 20 s; the k=2 one (1200-1220) is missed by the ~240 s access walk
  assert.equal(ride.arrivalTime, 1800 + 240);
  assert.equal(r.rides, 1);
  // the leading walk is delayed so the traveller does not stand at the stop: wait ~0, the delay shows up as departure shift
  const p = perceivedTransitTime(r.segments, 1000);
  assert.ok(p.wait < 1e-6 && p.departureShift > 0);
});

test("transfer at a shared station, and the transfer limit is honoured", () => {
  const tt = buildTimetable({ stations, patterns: [A(), B()] });
  const r = routeJourney(tt, near("a0"), near("b2"), 0);
  const rides = r.segments.filter((s) => s.kind === "transit");
  assert.deepEqual(rides.map((s) => [s.routeId, s.fromStopId, s.toStopId]), [["A", "a0", "c"], ["B", "c", "b2"]]);
  assert.ok(rides[1].departureTime >= rides[0].arrivalTime + 30, "minimum transfer time");
  // with a short walking limit the only way to b2 is a second ride, which maxTransfers: 0 forbids
  const noTransfer = buildTimetable({ stations, patterns: [A(), B()] }, { maxTransfers: 0, maxWalkToStationS: 300 });
  assert.equal(routeJourney(noTransfer, near("a0"), near("b2"), 0), null);
});

test("walking transfer between two nearby stations of different lines", () => {
  const st = new Map(stations);
  st.set("b1", { location: at(1.1, 0.02) }); // ~150 m from "c"
  const bLine = outAndBackPattern({ routeId: "B", stationIds: ["b0", "b1", "b2"], legSeconds: [100, 100], dwellS: 20, headwayS: 600 });
  const tt = buildTimetable({ stations: st, patterns: [A(), bLine] });
  const r = routeJourney(tt, near("a0"), near("b2"), 0);
  assert.deepEqual(r.segments.map((s) => s.kind), ["walk", "transit", "walk", "transit"]); // no egress walk: destination is at b2
  assert.equal(r.segments[2].fromStopId, "c");
  assert.equal(r.segments[2].toStopId, "b1");
});

test("no station in walking range, or no service, gives null", () => {
  const tt = buildTimetable({ stations, patterns: [A()] });
  assert.equal(routeJourney(tt, at(30, 30), near("a2"), 0), null);
  assert.equal(routeJourney(buildTimetable({ stations, patterns: [A(0)] }), near("a0"), near("a2"), 0), null);
});

test("faster headway never arrives later; the return leg of an out-and-back line is rideable", () => {
  const slow = routeJourney(buildTimetable({ stations, patterns: [A(1200)] }), near("a0"), near("a2"), 5);
  const fast = routeJourney(buildTimetable({ stations, patterns: [A(300)] }), near("a0"), near("a2"), 5);
  assert.ok(fast.arrivalTime <= slow.arrivalTime);
  const back = routeJourney(buildTimetable({ stations, patterns: [A(600)] }), near("a2"), near("a0"), 0);
  assert.ok(back.segments.some((s) => s.kind === "transit" && s.fromStopId === "a2"));
});
