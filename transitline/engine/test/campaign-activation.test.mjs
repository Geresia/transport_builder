import test from "node:test";
import assert from "node:assert/strict";
import { ManagementGame } from "../src/management/game.mjs";

const geometry = () => ({ schema: "transitline.regional-development-program/1", contractVersion: 1, programId: "program-a", programRevision: "r1", sourcePackId: "pack", sourcePackVersion: "1", active: true, milestones: [{ milestoneId: "m1", sequence: 1, targetMonth: 0, durationMonths: null }] });
const intake = () => ({ id: "new-town-demand-intake:1", status: "accepted", developmentRecordId: "new-town-development:1", acceptance: { developmentRevision: "d1", sourcePack: { packId: "pack", packVersion: "1" }, lifecycle: { status: "occupied" } }, standing: { verification: { status: "current", reasons: [] } } });
const source = () => ({ sourceId: "new-town-explicit-demand-source:new-town-demand-intake:1", intakeId: "new-town-demand-intake:1", status: "applied", developmentRevision: "d1", phaseRevision: "p1", lifecycle: { status: "occupied" }, standing: { status: "current", reasons: [] } });

function monitoringGame() {
  const game = new ManagementGame(); const record = game.draftCampaignProgram({ geometry: geometry() });
  game.adoptCampaignProgram(record.id, { geometry: geometry() }); game.monitorCampaignProgram(record.id, { geometry: geometry() });
  return { game, record };
}

test("activation records only a current accepted intake and applied source, without moving time or RNG", () => {
  const { game, record } = monitoringGame(); const before = { minute: game.clock.minute, rng: game.rng.snapshot() };
  const activation = game.recordCampaignActivation({ campaignProgramId: record.id, milestoneId: "m1", intakeId: intake().id, demandSourceId: source().sourceId, geometry: geometry(), intakes: [intake()], sources: [source()] });
  assert.equal(activation.status, "recorded"); assert.equal(game.clock.minute, before.minute); assert.equal(game.rng.snapshot(), before.rng);
  assert.equal(game.campaignActivationReport({ geometry: geometry(), intakes: [intake()], sources: [source()] })[0].standing.applicable, true);
});

test("changed source facts become stale and never silently repair the recorded tuple", () => {
  const { game, record } = monitoringGame(); const activation = game.recordCampaignActivation({ campaignProgramId: record.id, milestoneId: "m1", intakeId: intake().id, demandSourceId: source().sourceId, geometry: geometry(), intakes: [intake()], sources: [source()] });
  const changed = source(); changed.developmentRevision = "d2";
  const report = game.campaignActivationReport({ geometry: geometry(), intakes: [intake()], sources: [changed] });
  assert.equal(report[0].standing.status, "stale"); assert.ok(report[0].standing.blockers.includes("revision-tuple-changed"));
  assert.equal(game.withdrawCampaignActivation(activation.activationId, "player-choice").status, "withdrawn");
});

test("refused activation rolls back id allocation and does not pretend missing inputs are safe", () => {
  const { game, record } = monitoringGame(); const before = game.snapshot();
  assert.throws(() => game.recordCampaignActivation({ campaignProgramId: record.id, milestoneId: "m1", intakeId: "missing", demandSourceId: "missing", geometry: geometry(), intakes: [], sources: [] }), /intake-not-found/);
  assert.deepEqual(game.snapshot(), before);
});
