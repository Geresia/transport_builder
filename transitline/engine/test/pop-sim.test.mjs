// node --test engine/test/pop-sim.test.mjs — the pop-based simulation on example-radial (the old engine's own pack).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createState, addLine, setLineSuspended } from "../src/state.mjs";
import { buildDemandModel } from "../src/demand-engine.mjs";
import { buildRouteGraph } from "../src/network.mjs";
import { findRoute } from "../src/routing.mjs";
import { patternsFromState, popTrains } from "../src/pop-adapter.mjs";
import { buildTimetable, routeJourney } from "../src/router-raptor.mjs";
import { createPopSim, advancePopSim, popSummary, takeBond } from "../src/pop-sim.mjs";
import { RULES } from "../src/rules.mjs";

const demand = JSON.parse(readFileSync(new URL("../../packs/example-radial/demand.json", import.meta.url), "utf8"));
const LINE = ["outer-1", "mid-1", "inner-1", "cbd", "inner-4", "mid-7", "outer-7"];
const LINE_B = ["outer-4", "mid-4", "inner-2", "cbd", "inner-5", "mid-10", "outer-10"];

function makeSim(lines = [LINE], opts = {}) {
  const state = createState({ demand });
  for (const ids of lines) addLine(state, ids);
  const model = buildDemandModel(state, demand);
  return { state, sim: createPopSim(state, model, opts) };
}

test("a morning of commuting: pops board, ride, pay on arrival, and the books balance", () => {
  const { state, sim } = makeSim([LINE, LINE_B]);
  assert.ok(sim.pops.size > 1000);
  advancePopSim(sim, state, 6 * 3600); // 06:00 -> 12:00
  const s = popSummary(sim);
  assert.equal(state.passengers.length, 0, "the old passenger engine is not running");
  assert.ok(sim.stats.released.transit > 1000, `${sim.stats.released.transit} transit riders released`);
  assert.ok(sim.stats.completed > 100 && sim.stats.revenue > 0, `${sim.stats.completed} journeys completed`);
  assert.equal(sim.stats.dropped, 0);
  assert.ok(sim.stats.maintenanceCost > 0, "built track and stations are billed maintenance");
  assert.ok(Math.abs(sim.money - (RULES.economy.startingMoney + sim.stats.revenue - sim.stats.operatingCost - sim.stats.maintenanceCost)) < 1, "money = start + revenue - operating cost - maintenance");
  assert.ok(s.waiting + s.onboard + s.walking > 0, "people are still travelling");
});

test("same seed, same day", () => {
  const run = () => { const { state, sim } = makeSim(); advancePopSim(sim, state, 3 * 3600); return [sim.stats.completed, sim.stats.revenue, sim.stats.released.transit]; };
  assert.deepEqual(run(), run());
});

test("commuters never give up: a suspended line strands them, they stay in the queue for 12 h", () => {
  const { state, sim } = makeSim();
  advancePopSim(sim, state, 90 * 60); // 06:00 -> 07:30, the rush is on
  const before = popSummary(sim);
  assert.ok(before.waiting > 0);
  setLineSuspended(state, state.lines[0].id, true);
  advancePopSim(sim, state, 3 * 3600);
  assert.equal(sim.stats.dropped, 0, "nobody is dropped for waiting");
  assert.ok(popSummary(sim).waiting > 0);
});

test("router agrees with the old Dijkstra on which stations connect, and on transfers within one", () => {
  const state = createState({ demand });
  addLine(state, LINE);
  addLine(state, LINE_B);
  const graph = buildRouteGraph(state);
  const tt = buildTimetable({ stations: state.stations, patterns: patternsFromState(state, 0) }, { maxWalkToStationS: 60, maxTransferWalkS: 0 });
  const ids = [...new Set([...LINE, ...LINE_B])];
  let compared = 0;
  for (const a of ids) for (const b of ids) {
    if (a === b) continue;
    const old = findRoute(graph, a, b);
    const now = routeJourney(tt, state.stations.get(a).location, state.stations.get(b).location, 0);
    assert.equal(Boolean(now), Boolean(old), `${a} -> ${b}`);
    if (old) { assert.ok(Math.abs(now.rides - old.hops.length) <= 1, `${a} -> ${b}: ${now.rides} rides vs ${old.hops.length} hops`); compared++; }
  }
  assert.ok(compared > 30);
});

test("adapter: a dispatched train is stopped at its first station and only boards toward its first leg", () => {
  const { state, sim } = makeSim();
  advancePopSim(sim, state, 5);
  const [t] = popTrains(state);
  assert.equal(t.stationId, "outer-1");
  assert.equal(t.stopped, true);
  assert.deepEqual(t.stationsAhead, [...LINE, ...LINE.slice(0, -1).reverse()]);
  assert.equal(t.maxCapacity, 5 * 240);
});

test("bonds need yesterday's revenue; once taken they cost interest every hour", () => {
  const { state, sim } = makeSim();
  assert.equal(takeBond(sim, "SMALL"), null);
  sim.yesterdayRevenue = 2e7;
  const before = sim.money;
  assert.ok(takeBond(sim, "SMALL"));
  assert.equal(sim.money, before + 1e8);
  advancePopSim(sim, state, 3600);
  assert.ok(sim.stats.interest > 0 && sim.bonds[0].remaining < 1e8);
});
