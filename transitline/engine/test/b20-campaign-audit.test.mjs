// B20-R1: a 30-year campaign (360 months, 120 quarterly milestones) on a real ScenarioRuntime, audited for what a long campaign can break:
// the time axis, how the save and each command scale, byte determinism across save / load / resume, staleness half-way through, saves from
// before the campaign existed, input-order independence of the fact report, and the absence of any per-day or per-citizen work.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { ScenarioRuntime } from "../src/scenario-runtime.mjs";
import { createState } from "../src/state.mjs";
import { buildCampaignFactReport } from "../src/campaign-fact-report.mjs";
import {
  CAMPAIGN_DAYS_PER_YEAR, CAMPAIGN_MONTH_MINUTES, campaignTargetStatus, campaignTimeAtMinute,
} from "../src/campaign-time.mjs";

const read = (rel) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const EXAMPLE = JSON.parse(read("../../packs/example-radial/new-town-development-examples/01-two-phases-with-synthetic-pond-and-road.new-town.json"));
const [P1, P2] = EXAMPLE.phases.map((p) => p.phaseId);
const PACK = { manifest: { id: "b20-pack", version: "1", data: { license: "test", attribution: [] } }, demand: { model: "gravity", points: [], attractors: [] } };
const NT = { ...structuredClone(EXAMPLE), sourcePackId: "b20-pack", sourcePackVersion: "1" };
const MONTH = CAMPAIGN_MONTH_MINUTES;
const MILESTONES = 120; // one per quarter for 30 years
const mid = (n) => `m${String(n).padStart(3, "0")}`;
const programGeometry = (over = {}) => ({
  schema: "transitline.regional-development-program/1", contractVersion: 1, programId: "program-30y", programRevision: "r1", sourcePackId: "b20-pack", sourcePackVersion: "1", active: true,
  milestones: Array.from({ length: MILESTONES }, (_, i) => ({ milestoneId: mid(i + 1), sequence: i + 1, targetMonth: i * 3, durationMonths: null })), ...over,
});
const build = () => new ScenarioRuntime({ pack: PACK, operationalState: createState(PACK) });
const opsOf = (r) => JSON.parse(r.save()).operations;
const mgmtOf = (r) => JSON.parse(r.save()).management;
const SOURCE = "new-town-explicit-demand-source:new-town-demand-intake:1";
const INTAKE = "new-town-demand-intake:1";

// a B19 chain with one applied explicit demand source, a program in monitoring and one activation of its first milestone
function world({ geometry = programGeometry() } = {}) {
  const runtime = build();
  const { id } = runtime.proposeNewTownDevelopment({ geometry: NT, parties: { municipality: { name: "Example City" }, developer: { name: "Example Dev" } } });
  runtime.agreeNewTownDevelopment(id, { burdens: [{ itemId: "land", bearers: ["developer"] }] }, { geometry: NT });
  runtime.startNewTownServicing(id, { geometry: NT, phaseIds: [P1, P2] });
  runtime.recordNewTownOccupancy(id, P1, { statedOccupiedUnits: 120, unit: "residents", source: "player-stated" }, { geometry: NT });
  runtime.acceptNewTownDemandCandidate({ developmentRecordId: id, candidateId: `new-town-demand-candidate:${EXAMPLE.developmentId}:${P1}`, statedDemandFactIds: [`${id}:phase:${P1}:occupancy:1`], geometry: NT });
  runtime.applyNewTownExplicitDemandSource({ intakeId: INTAKE, geometry: NT });
  const program = runtime.draftCampaignProgram({ geometry });
  runtime.adoptCampaignProgram(program.id, { geometry });
  runtime.monitorCampaignProgram(program.id, { geometry });
  const activation = runtime.recordCampaignActivation({ campaignProgramId: program.id, milestoneId: mid(1), intakeId: INTAKE, demandSourceId: SOURCE, geometry, developmentGeometry: NT });
  return { runtime, programId: program.id, activationId: activation.activationId, geometry };
}
const ctx = (w) => ({ geometry: w.geometry, developmentGeometry: NT });
// the management clock moves a whole month at a time; every third month the next milestone is reached by the player's command
function runMonths(w, from, to, timings = null) {
  for (let m = from; m < to; m += 1) {
    w.runtime.game.clock.advance(MONTH);
    if (m % 3 === 0) {
      const started = performance.now();
      w.runtime.reachCampaignMilestone(w.programId, mid(m / 3 + 1), [], { geometry: w.geometry });
      timings?.push(performance.now() - started);
    }
  }
}
const average = (list) => list.reduce((a, b) => a + b, 0) / list.length;

test("the time axis: 30 years is 360 months of 30 days, every month boundary is exact, and a stated 0 or null target is not confused", () => {
  assert.equal(CAMPAIGN_DAYS_PER_YEAR, 360);
  assert.equal(360 * MONTH, 30 * CAMPAIGN_DAYS_PER_YEAR * 1440);
  assert.equal(360 * MONTH, 15_552_000);
  for (let month = 0; month <= 360; month += 1) {
    const at = campaignTimeAtMinute(month * MONTH);
    assert.deepEqual([at.monthIndex, at.yearIndex, at.monthInYearIndex, at.quarterIndex], [month, Math.floor(month / 12), month % 12, Math.floor((month % 12) / 3)], `month ${month}`);
    if (month > 0) assert.equal(campaignTimeAtMinute(month * MONTH - 1).monthIndex, month - 1, `the minute before month ${month}`);
  }
  assert.deepEqual([campaignTimeAtMinute(360 * MONTH).yearNumber, campaignTimeAtMinute(360 * MONTH - 1).yearNumber], [31, 30]);
  assert.equal(campaignTimeAtMinute(-1), null);
  assert.equal(campaignTimeAtMinute(Number.NaN), null);
  assert.deepEqual([campaignTargetStatus(0, 0).status, campaignTargetStatus(null, 0).status, campaignTargetStatus(1, 0).status, campaignTargetStatus(0, MONTH).status], ["due", "unstated", "future", "past-due"]);
  assert.throws(() => campaignTargetStatus(-1, 0), /non-negative integer or null/);
  assert.throws(() => campaignTargetStatus(1.5, 0), /non-negative integer or null/);
});

test("a 30-year campaign: no day is simulated, no random number or money is used, the whole program is reached, and the save and each command stay small", () => {
  const w = world();
  const before = { ops: opsOf(w.runtime), mgmt: mgmtOf(w.runtime), sim: w.runtime.operationalState.simMinutes };
  const timings = [];
  const started = performance.now();
  runMonths(w, 0, 360, timings);
  const elapsed = performance.now() - started;
  w.runtime.completeCampaignProgram(w.programId, { geometry: w.geometry });
  assert.equal(w.runtime.game.clock.minute, 360 * MONTH);
  // the operating side never moved: no simulated day, no train, no passenger, no random draw
  assert.equal(w.runtime.operationalState.simMinutes, before.sim);
  assert.deepEqual(opsOf(w.runtime), before.ops, "the operational state is byte-identical after 30 campaign years");
  const after = mgmtOf(w.runtime);
  for (const key of ["rngState", "constructionEventRngState", "ledger", "player"]) assert.deepEqual(after[key], before.mgmt[key], key);
  const [program] = w.runtime.campaignProgramReport();
  assert.deepEqual([program.status, program.milestones.filter((m) => m.status === "reached").length, program.history.length], ["completed", MILESTONES, 1 + 1 + 1 + MILESTONES + 1]);
  // the event log keeps a summary per campaign command, not the growing record
  const events = after.events.filter((e) => e.type.startsWith("campaign-"));
  assert.equal(events.length, 1 + 1 + 1 + 1 + MILESTONES + 1);
  for (const e of events) {
    assert.ok(JSON.stringify(e.data).length < 700, `${e.type} #${e.id} is ${JSON.stringify(e.data).length} bytes`);
    assert.equal("milestones" in e.data, false, `${e.type}: no embedded milestone list`);
  }
  // size: far below the megabytes that embedding the record gave, and linear in the number of commands
  const text = w.runtime.save();
  assert.ok(text.length < 600_000, `save is ${text.length} bytes`);
  const half = world();
  runMonths(half, 0, 180);
  const halfBytes = half.runtime.save().length;
  const ratio = (text.length - halfBytes) / halfBytes;
  assert.ok(ratio < 1.6, `the second 15 years add ${(ratio * 100).toFixed(0)}% of the first 15 (linear would be about 100%)`);
  // cost: the last commands cost about what the first did, and the whole run is quick
  assert.ok(average(timings.slice(-10)) < Math.max(average(timings.slice(0, 10)) * 8, 150), `first ${average(timings.slice(0, 10)).toFixed(1)} ms, last ${average(timings.slice(-10)).toFixed(1)} ms`);
  assert.ok(elapsed < 20_000, `the 30-year run took ${Math.round(elapsed)} ms`);
  const t = performance.now();
  const loaded = build();
  loaded.load(text);
  loaded.report();
  loaded.campaignFactReport(ctx(w));
  assert.ok(performance.now() - t < 5000, "load + report + fact report");
  assert.equal(loaded.campaignProgramReport()[0].milestones.filter((m) => m.status === "reached").length, MILESTONES);
});

test("save, load and resume are byte-deterministic: a campaign interrupted at year 10 and 20 ends in the same bytes as one that never stopped", () => {
  const straight = world();
  runMonths(straight, 0, 360);
  const normal = (r) => { const again = build(); again.load(r.save()); return again.save(); };
  const finalStraight = normal(straight.runtime);
  // the same history gives the same raw bytes, and a load/save settles after one round
  const twin = world();
  runMonths(twin, 0, 360);
  assert.equal(twin.runtime.save(), straight.runtime.save());
  const loadedOnce = build();
  loadedOnce.load(straight.runtime.save());
  const loadedTwice = build();
  loadedTwice.load(loadedOnce.save());
  assert.equal(loadedTwice.save(), loadedOnce.save(), "load then save is a fixed point");
  // interrupted
  const resumed = world();
  let carried = resumed.runtime;
  for (const [from, to] of [[0, 120], [120, 240], [240, 360]]) {
    runMonths({ ...resumed, runtime: carried }, from, to);
    const next = build();
    next.load(carried.save());
    carried = next;
  }
  assert.equal(carried.save(), finalStraight, "interrupted twice = uninterrupted, byte for byte");
});

test("a record that first appears after a load lands where it would have without the load: equal states give equal bytes whatever the order the keys were added in", () => {
  const chain = (r) => {
    const { id } = r.proposeNewTownDevelopment({ geometry: NT, parties: { municipality: { name: "Example City" }, developer: { name: "Example Dev" } } });
    r.agreeNewTownDevelopment(id, { burdens: [{ itemId: "land", bearers: ["developer"] }] }, { geometry: NT });
    r.startNewTownServicing(id, { geometry: NT, phaseIds: [P1, P2] });
    r.recordNewTownOccupancy(id, P1, { statedOccupiedUnits: 120, unit: "residents", source: "player-stated" }, { geometry: NT });
    r.acceptNewTownDemandCandidate({ developmentRecordId: id, candidateId: `new-town-demand-candidate:${EXAMPLE.developmentId}:${P1}`, statedDemandFactIds: [`${id}:phase:${P1}:occupancy:1`], geometry: NT });
  };
  const apply = (r) => r.applyNewTownExplicitDemandSource({ intakeId: INTAKE, geometry: NT });
  const direct = build();
  chain(direct); apply(direct);
  const viaLoad = build();
  chain(viaLoad);
  const reloaded = build();
  reloaded.load(viaLoad.save());
  apply(reloaded); // the source key is added to a state object that was just restored
  const settle = (r) => { const again = build(); again.load(r.save()); return again.save(); };
  assert.equal(reloaded.save(), settle(direct), "same content, same bytes");
  const keys = Object.keys(opsOf(reloaded));
  assert.deepEqual(keys.slice(-3), ["stations", "demandNodes", "rngState"]);
  assert.deepEqual(keys.slice(0, -3), keys.slice(0, -3).sort(), "the plain keys are in sorted order");
});

test("halfway through, a changed program map is stale: nothing goes forward, what was reached stays reached, and the player can still delay or cancel", () => {
  const w = world();
  runMonths(w, 0, 180); // 60 milestones reached
  const saved = w.runtime.save();
  const changed = programGeometry({ programRevision: "r2" });
  const other = programGeometry({ sourcePackId: "other-pack" });
  const off = programGeometry({ active: false });
  for (const [label, geometry, reason] of [["revision", changed, "geometry-stale"], ["another pack's map", other, "geometry-stale"], ["switched off", off, "geometry-inactive"]]) {
    assert.throws(() => w.runtime.reachCampaignMilestone(w.programId, mid(61), [], { geometry }), new RegExp(`cannot reachMilestone: .*${reason}`), label);
    assert.throws(() => w.runtime.completeCampaignProgram(w.programId, { geometry }), /cannot complete/, label);
    assert.equal(w.runtime.save(), saved, `${label}: a refused command changes nothing`);
    const fact = w.runtime.campaignFactReport({ geometry, developmentGeometry: NT });
    assert.equal(fact.programs[0].milestones.length, MILESTONES, `${label}: the report still lists every milestone`);
    assert.equal(w.runtime.campaignActivationReport({ geometry, developmentGeometry: NT })[0].standing.status, "stale", `${label}: the activation is stale`);
  }
  assert.equal(w.runtime.campaignProgramReport()[0].milestones.filter((m) => m.status === "reached").length, 60);
  assert.equal(w.runtime.campaignActivationReport(ctx(w))[0].standing.status, "recorded", "with the map it was made against, it is still fine");
  // stopping or pausing never needs the map
  assert.equal(w.runtime.delayCampaignProgram(w.programId, "the regional plan is under review").status, "delayed");
  assert.throws(() => w.runtime.resumeCampaignProgram(w.programId, { geometry: changed }), /cannot resume/);
  assert.equal(w.runtime.resumeCampaignProgram(w.programId, { geometry: w.geometry }).status, "monitoring");
  assert.equal(w.runtime.cancelCampaignProgram(w.programId, "dropped").status, "cancelled");
});

test("the activation of a B19 demand source works through the real runtime only when the program map and the development map are both handed in", () => {
  const w = world();
  assert.equal(w.runtime.campaignActivationReport(ctx(w))[0].standing.status, "recorded");
  // the old single-geometry call can only say the B19 side is unverified; it cannot silently pass
  const single = w.runtime.campaignActivationReport({ geometry: w.geometry })[0].standing;
  assert.equal(single.status, "stale");
  assert.ok(single.blockers.some((b) => /intake-verification-unverified/.test(b)), single.blockers.join());
  assert.throws(() => w.runtime.recordCampaignActivation({ campaignProgramId: w.programId, milestoneId: mid(2), intakeId: INTAKE, demandSourceId: SOURCE, geometry: w.geometry }), /intake-verification-unverified/);
  // a development map that went stale makes the recorded activation stale, without touching the record
  const stale = { ...structuredClone(NT), developmentRevision: "new-town-revision:changed" };
  const row = w.runtime.campaignActivationReport({ geometry: w.geometry, developmentGeometry: stale })[0];
  assert.deepEqual([row.status, row.standing.status], ["recorded", "stale"]);
});

test("saves from before the campaign existed load with no programs, and ids carry on", () => {
  const w = world();
  runMonths(w, 0, 12);
  const save = JSON.parse(w.runtime.save());
  for (const key of ["campaignPrograms", "campaignActivations", "nextCampaignProgramSequence", "nextCampaignActivationSequence"]) delete save.management[key];
  const r = build();
  r.load(JSON.stringify(save));
  assert.deepEqual([r.campaignProgramReport(), r.campaignActivationReport(), r.report().campaignPrograms], [[], [], []]);
  assert.doesNotThrow(() => r.campaignFactReport({ geometry: programGeometry(), developmentGeometry: NT }));
  assert.equal(r.draftCampaignProgram({ geometry: programGeometry() }).id, "campaign-program:1");
  // a counter that outlived its records never hands out a used id
  const damaged = JSON.parse(w.runtime.save());
  delete damaged.management.campaignPrograms;
  const d = build();
  d.load(JSON.stringify(damaged));
  assert.equal(d.draftCampaignProgram({ geometry: programGeometry({ programId: "another" }) }).id, "campaign-program:2");
});

test("the fact report does not depend on the order of its inputs, and the stored program does not depend on the order of its references", () => {
  const w = world();
  const second = w.runtime.draftCampaignProgram({ geometry: programGeometry({ programId: "program-b" }) });
  w.runtime.adoptCampaignProgram(second.id, { geometry: programGeometry({ programId: "program-b" }) });
  runMonths(w, 0, 30);
  const inputs = () => ({
    programs: w.runtime.campaignProgramReport(), activations: w.runtime.campaignActivationReport(ctx(w)), developments: w.runtime.newTownDevelopmentReport(), contributions: w.runtime.newTownRailContributionReport(),
    demandSources: w.runtime.newTownExplicitDemandSourceReport({ geometry: NT }), projects: w.runtime.game.projects, services: w.runtime.game.services, timetables: w.runtime.railwayTimetableReport(),
  });
  const base = JSON.stringify(buildCampaignFactReport(inputs()));
  const reversed = Object.fromEntries(Object.entries(inputs()).map(([k, v]) => [k, Array.isArray(v) ? [...v].reverse() : v]));
  const rotated = Object.fromEntries(Object.entries(inputs()).map(([k, v]) => [k, Array.isArray(v) && v.length > 1 ? [...v.slice(1), v[0]] : v]));
  assert.equal(JSON.stringify(buildCampaignFactReport(reversed)), base, "reversed inputs");
  assert.equal(JSON.stringify(buildCampaignFactReport(rotated)), base, "rotated inputs");
  assert.equal(JSON.stringify(w.runtime.campaignFactReport(ctx(w))), JSON.stringify(w.runtime.campaignFactReport(ctx(w))), "and the runtime's own report is repeatable");
  // references given in any order are stored sorted and de-duplicated, so the record is the same
  const a = build(); const b = build();
  const refs = ["new-town-development:3", "new-town-development:1", "new-town-development:2"];
  const ra = a.draftCampaignProgram({ geometry: programGeometry(), linkedDevelopmentRecordIds: refs });
  const rb = b.draftCampaignProgram({ geometry: programGeometry(), linkedDevelopmentRecordIds: [...refs].reverse().concat(refs[0]) });
  assert.deepEqual(ra.managementRefs, rb.managementRefs);
  assert.deepEqual(ra.managementRefs.linkedDevelopmentRecordIds, ["new-town-development:1", "new-town-development:2", "new-town-development:3"]);
  assert.equal(ra.managementRefs.linkedContributionIds, null, "an unstated list stays null");
  // the program map's own milestone order does not matter either
  const forward = a.adoptCampaignProgram(ra.id, { geometry: programGeometry() });
  const shuffled = programGeometry(); shuffled.milestones.reverse();
  assert.equal(a.assessCampaignProgram({ id: ra.id, geometry: shuffled }).geometry.status, "current");
  assert.deepEqual(forward.milestones.map((m) => m.milestoneId), Array.from({ length: MILESTONES }, (_, i) => mid(i + 1)));
});

test("a map export with several current B20 programs verifies each activation against its own program geometry", () => {
  const w = world();
  const secondGeometry = programGeometry({ programId: "program-second", programRevision: "r-second" });
  const second = w.runtime.draftCampaignProgram({ geometry: secondGeometry });
  w.runtime.adoptCampaignProgram(second.id, { geometry: secondGeometry });
  w.runtime.monitorCampaignProgram(second.id, { geometry: secondGeometry });
  w.runtime.recordCampaignActivation({ campaignProgramId: second.id, milestoneId: mid(1), intakeId: INTAKE, demandSourceId: SOURCE, geometry: secondGeometry, developmentGeometry: NT });
  const context = { programGeometries: { programs: [w.geometry, secondGeometry] }, developmentGeometry: NT };
  const activations = w.runtime.campaignActivationReport(context);
  assert.deepEqual(activations.map((entry) => [entry.programId, entry.standing.status]).sort((a, b) => a[0].localeCompare(b[0])), [["program-30y", "recorded"], ["program-second", "recorded"]]);
  const facts = w.runtime.campaignFactReport(context);
  const all = facts.programs.flatMap((program) => program.milestones.flatMap((milestone) => milestone.activations));
  assert.deepEqual(all.map((entry) => entry.status).sort(), ["recorded", "recorded"]);
  const incomplete = w.runtime.campaignActivationReport({ programGeometries: { programs: [w.geometry] }, developmentGeometry: NT });
  assert.equal(incomplete.find((entry) => entry.programId === "program-second").standing.status, "stale", "a missing second geometry never borrows the first program geometry");
});

test("a campaign needs no per-day and no per-citizen work: the campaign modules have no loop over days and name no simulation, agent or random source", () => {
  const files = ["campaign-time.mjs", "campaign-fact-report.mjs", "campaign-timeline-panel.mjs", "campaign-timeline-view.mjs", "management/campaign-program.mjs", "management/campaign-activation.mjs", "map/regional-development-program.mjs", "map/regional-development-program-ui.mjs"];
  for (const name of files) {
    const code = read(`../src/${name}`).replace(/\/\/.*$/gm, "");
    assert.equal(/advanceSimulation|passenger|citizen|agent|Math\.random|Date\.now|new Date|setInterval|setTimeout|requestAnimationFrame/i.test(code), false, name);
    for (const header of code.matchAll(/\b(?:for|while)\s*\(([^)]*)\)/g)) assert.equal(/DAY|1440|MONTH_MINUTES|simMinutes/.test(header[1]), false, `${name}: loop ${header[0]}`);
  }
  // and thirty years of management clock is 360 advances, not 10,800 days: the operating clock never ran (see the 30-year test)
  const w = world();
  let advances = 0;
  const original = w.runtime.game.clock.advance.bind(w.runtime.game.clock);
  w.runtime.game.clock.advance = (...args) => { advances += 1; return original(...args); };
  runMonths(w, 0, 360);
  assert.equal(advances, 360);
});
