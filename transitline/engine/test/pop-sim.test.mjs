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
import { createPopSim, advancePopSim, popSimStep, popSummary, takeBond } from "../src/pop-sim.mjs";
import { RULES } from "../src/rules.mjs";
import { trackCost, stationCost } from "../src/construction-cost.mjs";
import { haversineMetres } from "../src/projection.mjs";

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
  assert.ok(sim.stats.constructionCost > 0, "the two drawn lines are billed once for track and stations");
  const spent = sim.stats.operatingCost + sim.stats.maintenanceCost + sim.stats.constructionCost;
  assert.ok(Math.abs(sim.money - (RULES.economy.startingMoney + sim.stats.revenue - spent)) < 1, "money = start + revenue - operating - maintenance - construction");
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

test("construction is billed once per line and once per station shared between lines; external lines are free", () => {
  const { state, sim } = makeSim([LINE, LINE_B]);
  popSimStep(sim, state, 1);
  const lengthOf = (ids) => { let m = 0; for (let i = 0; i < ids.length - 1; i++) m += haversineMetres(state.stations.get(ids[i]).location, state.stations.get(ids[i + 1]).location); return m; };
  const track = trackCost({ lengthM: lengthOf(LINE), trainType: sim.trainType, elevation: -1, waterPct: 0 }) + trackCost({ lengthM: lengthOf(LINE_B), trainType: sim.trainType, elevation: -1, waterPct: 0 });
  const stations = [...new Set([...LINE, ...LINE_B])].length; // "cbd" is shared: billed once, not twice
  const want = track + stations * stationCost({ trainType: sim.trainType, elevation: -1, waterPct: 0 });
  assert.ok(Math.abs(sim.stats.constructionCost - want) < 1);
  const before = sim.stats.constructionCost;
  advancePopSim(sim, state, 3600); // no new lines: the bill does not grow
  assert.equal(sim.stats.constructionCost, before);

  const { state: s2, sim: sim2 } = makeSim([]);
  addLine(s2, LINE, { external: true });
  popSimStep(sim2, s2, 1);
  assert.equal(sim2.stats.constructionCost, 0, "a pre-existing real line was not built by the player");
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
