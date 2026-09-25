import test from "node:test";
import assert from "node:assert/strict";
import { createState, addLine, deleteLine, setLineSuspended } from "../src/state.mjs";
import { stepTrains } from "../src/trains.mjs";
import { buildRouteGraph } from "../src/network.mjs";
import { findRoute } from "../src/routing.mjs";
import { expirePassengers, handleStop } from "../src/passengers.mjs";
import { chooseMode } from "../src/mode-choice.mjs";
import { currentDayTypeAndPeriod } from "../src/demand-engine.mjs";
import { advanceSimulation, createSimulationRuntime } from "../src/simulation.mjs";

function makePack(count = 5) {
  return {
    demand: {
      model: "gravity",
      points: Array.from({ length: count }, (_, i) => ({
        id: `s${i}`,
        name: `S${i}`,
        location: [139 + i * 0.001, 35],
        residents: i ? 1000 : 2000,
        jobs: i ? 2000 : 1000,
      })),
    },
  };
}

test("large and small train steps produce the same position", () => {
  const a = createState(makePack());
  const b = createState(makePack());
  const la = addLine(a, ["s0", "s1", "s2", "s3", "s4"]);
  const lb = addLine(b, ["s0", "s1", "s2", "s3", "s4"]);
  a.trains.push({ id: 1, lineId: la.id, segIndex: 0, t: 0, dir: 1, dwell: 20 });
  b.trains.push({ id: 1, lineId: lb.id, segIndex: 0, t: 0, dir: 1, dwell: 20 });
  stepTrains(a, 70);
  for (let i = 0; i < 70; i++) stepTrains(b, 1);
  assert.equal(a.trains[0].segIndex, b.trains[0].segIndex);
  assert.equal(a.trains[0].dir, b.trains[0].dir);
  assert.ok(Math.abs(a.trains[0].t - b.trains[0].t) < 1e-12);
  assert.ok(Math.abs(a.trains[0].dwell - b.trains[0].dwell) < 1e-12);
  assert.ok(a.trains[0].segIndex >= 2, "one update can cross several short segments");
});

test("calendar advances day types every 1440 minutes while matching after-midnight periods", () => {
  const state = {
    simMinutes: 1450,
    calendar: {
      dayTypes: [{ id: "weekday", name: "Weekday", weight: 1 }, { id: "holiday", name: "Holiday", weight: 1 }],
      periods: [{ id: "day", startMinute: 300, endMinute: 1200 }, { id: "night", startMinute: 1200, endMinute: 1500 }],
    },
  };
  const value = currentDayTypeAndPeriod(state);
  assert.equal(value.dayIndex, 1);
  assert.equal(value.dayType.id, "holiday");
  assert.equal(value.period.id, "night");
  assert.equal(value.serviceMinute, 1450);
});

test("suspended lines are excluded from routing", () => {
  const state = createState(makePack(3));
  const line = addLine(state, ["s0", "s1", "s2"]);
  assert.ok(findRoute(buildRouteGraph(state), "s0", "s2"));
  setLineSuspended(state, line.id, true);
  assert.equal(findRoute(buildRouteGraph(state), "s0", "s2"), null);
});

test("boarding respects train direction", () => {
  const state = createState(makePack(3));
  const line = addLine(state, ["s0", "s1", "s2"]);
  state.passengers.push(
    { id: 1, state: "waiting", currentStationId: "s1", route: [{ lineId: line.id, boardStationId: "s1", alightStationId: "s0" }], hopIndex: 0 },
    { id: 2, state: "waiting", currentStationId: "s1", route: [{ lineId: line.id, boardStationId: "s1", alightStationId: "s2" }], hopIndex: 0 },
  );
  handleStop(state, { id: 9, lineId: line.id, segIndex: 1, dir: 1 }, "s1");
  assert.equal(state.passengers.find((p) => p.id === 1).state, "waiting");
  assert.equal(state.passengers.find((p) => p.id === 2).state, "onboard");
});

test("commuters never give up on a crowded platform; only 12 h stranded passengers are swept", () => {
  const state = createState(makePack(3));
  state.simMinutes = 100;
  state.passengers = [{ id: 1, state: "waiting", spawnedAt: 0, waitingSince: 90 }];
  expirePassengers(state);
  state.simMinutes = 116; // the old 25-minute rule would have removed this one
  expirePassengers(state);
  state.simMinutes = 90 + 12 * 60; // exactly 12 h of waiting: still there
  expirePassengers(state);
  assert.equal(state.passengers.length, 1);
  state.simMinutes += 1; // transfer wait is measured from waitingSince, not the trip start
  expirePassengers(state);
  assert.equal(state.passengers.length, 0);
});

test("deleting a line unloads riders at the nearest endpoint", () => {
  const state = createState(makePack(3));
  const line = addLine(state, ["s0", "s1", "s2"]);
  state.trains.push({ id: 7, lineId: line.id, segIndex: 0, t: 0.8, dir: 1, dwell: 0 });
  state.passengers.push({ id: 3, state: "onboard", trainId: 7, originId: "s0", destinationId: "s2", route: [{ lineId: line.id, boardStationId: "s0", alightStationId: "s2" }], hopIndex: 0 });
  deleteLine(state, line.id);
  assert.equal(state.passengers[0].state, "waiting");
  assert.equal(state.passengers[0].currentStationId, "s1");
  assert.equal(state.passengers[0].route, null);
});

test("same-origin trips do not attempt to wait for a nonexistent transit hop", () => {
  const state = createState(makePack(1));
  const station = state.stations.get("s0");
  assert.equal(chooseMode(state, station, station, { hops: [], seconds: 0 }, () => 0.5), "walking");
});

test("fixed simulation steps are invariant to render-frame grouping", () => {
  const demand = { origins: [], rate: () => 0, pick: () => null };
  const a = createState(makePack(2), { seed: 42 });
  const b = createState(makePack(2), { seed: 42 });
  addLine(a, ["s0", "s1"]);
  addLine(b, ["s0", "s1"]);
  const ra = createSimulationRuntime(a);
  const rb = createSimulationRuntime(b);
  advanceSimulation(a, demand, ra, 120);
  for (let i = 0; i < 480; i++) advanceSimulation(b, demand, rb, 0.25);
  assert.equal(a.simMinutes, b.simMinutes);
  assert.deepEqual(a.trains, b.trains);
  assert.deepEqual(a.stats, b.stats);
});

test("route cache returns stable transfer paths", () => {
  const state = createState(makePack(5));
  addLine(state, ["s0", "s1", "s2"]);
  addLine(state, ["s2", "s3", "s4"]);
  const graph = buildRouteGraph(state);
  const first = findRoute(graph, "s0", "s4");
  const second = findRoute(graph, "s0", "s4");
  assert.strictEqual(first, second);
  assert.deepEqual(first.hops.map((h) => h.boardStationId), ["s0", "s2"]);
});
