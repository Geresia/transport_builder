import test from "node:test";
import assert from "node:assert/strict";
import { ManagementGame } from "../src/management/game.mjs";
import { ScenarioRuntime } from "../src/scenario-runtime.mjs";

const geometry = (revision = "r1") => ({
  schema: "transitline.regional-development-program/1", contractVersion: 1,
  programId: "regional-development-program:alpha", programRevision: revision,
  sourcePackId: "example-radial", sourcePackVersion: "1", active: true,
  milestones: [{ milestoneId: "regional-development-milestone:first", sequence: 1, targetMonth: 0, durationMonths: null }],
});

test("campaign lifecycle needs current geometry for forward transitions, while delay and cancel do not", () => {
  const game = new ManagementGame();
  const draft = game.draftCampaignProgram({ geometry: geometry() });
  assert.equal(draft.status, "draft");
  assert.throws(() => game.adoptCampaignProgram(draft.id), /geometry-missing/);
  const adopted = game.adoptCampaignProgram(draft.id, { geometry: geometry() });
  assert.equal(adopted.status, "adopted");
  const delayed = game.delayCampaignProgram(draft.id, "player-stated");
  assert.equal(delayed.status, "delayed");
  assert.throws(() => game.resumeCampaignProgram(draft.id, { geometry: geometry("changed") }), /geometry-stale/);
  assert.equal(game.cancelCampaignProgram(draft.id, "stop").status, "cancelled");
});

test("reaching a milestone is an explicit declaration, not an automatic response to target month", () => {
  const game = new ManagementGame();
  const record = game.draftCampaignProgram({ geometry: geometry() });
  game.adoptCampaignProgram(record.id, { geometry: geometry() });
  game.monitorCampaignProgram(record.id, { geometry: geometry() });
  assert.equal(game.campaignProgramReport(record.id)[0].milestones[0].status, "planned");
  game.reachCampaignMilestone(record.id, "regional-development-milestone:first", [{ refKind: "development", refId: "town-a", state: "servicing" }], { geometry: geometry() });
  const milestone = game.campaignProgramReport(record.id)[0].milestones[0];
  assert.equal(milestone.status, "reached");
  assert.deepEqual(milestone.observedRefs, [{ refKind: "development", refId: "town-a", state: "servicing", atMinute: 0 }]);
});

test("campaign records save, restore, preserve monotonic ids and do not change RNG or clock", () => {
  const game = new ManagementGame({ seed: 77 }); const before = { clock: game.clock.minute, rng: game.rng.snapshot() };
  const one = game.draftCampaignProgram({ geometry: geometry() });
  assert.equal(game.clock.minute, before.clock); assert.equal(game.rng.snapshot(), before.rng);
  const restored = ManagementGame.load(game.save());
  assert.deepEqual(restored.campaignProgramReport(), game.campaignProgramReport());
  assert.equal(restored.draftCampaignProgram({ geometry: { ...geometry(), programId: "regional-development-program:beta" } }).id, "campaign-program:2");
  assert.equal(one.id, "campaign-program:1");
});

test("refused forward transition rolls back state and the runtime reports copies", () => {
  const runtime = new ScenarioRuntime({ pack: { manifest: { id: "example-radial", version: "1" } } });
  const draft = runtime.draftCampaignProgram({ geometry: geometry() });
  const before = runtime.game.snapshot();
  assert.throws(() => runtime.adoptCampaignProgram(draft.id, { geometry: geometry("stale") }), /geometry-stale/);
  assert.deepEqual(runtime.game.snapshot(), before);
  const report = runtime.report().campaignPrograms; report[0].status = "mutated";
  assert.equal(runtime.campaignProgramReport(draft.id)[0].status, "draft");
});
