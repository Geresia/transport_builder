// B20-E2: stores a player's explicit choice to associate a B19 explicit demand
// source with a B20 milestone. It never applies that source to B15.

import { checkCampaignProgramGeometry } from "./campaign-program.mjs";

export const CAMPAIGN_ACTIVATION_SCHEMA = "transitline.campaign-activation/1";
const clone = (v) => structuredClone(v);
const text = (v) => typeof v === "string" && v.trim() ? v.trim() : null;
const canonical = (v) => Array.isArray(v) ? `[${v.map(canonical).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}` : JSON.stringify(v ?? null);

function currentInput({ program, geometry, intake, source, milestoneId }) {
  const blockers = [];
  const programCheck = checkCampaignProgramGeometry(geometry, program);
  if (programCheck.status !== "current") blockers.push(`program-geometry-${programCheck.status}`, ...programCheck.reasons);
  const milestone = program?.milestones?.find((entry) => entry.milestoneId === milestoneId);
  if (!milestone) blockers.push("milestone-not-found");
  if (!intake) blockers.push("intake-not-found");
  else if (intake.status !== "accepted") blockers.push(`intake-not-accepted:${intake.status}`);
  else if (intake.standing?.verification?.status !== "current") blockers.push(`intake-verification-${intake.standing?.verification?.status ?? "unknown"}`, ...(intake.standing?.verification?.reasons ?? []));
  if (!source) blockers.push("demand-source-not-found");
  else if (source.status !== "applied") blockers.push(`demand-source-${source.status}`);
  else if (source.standing?.status !== "current") blockers.push(`demand-source-standing-${source.standing?.status ?? "unknown"}`, ...(source.standing?.reasons ?? []));
  if (intake && source && source.intakeId !== intake.id) blockers.push("source-intake-mismatch");
  return blockers;
}

function tuple(program, intake, source) {
  return {
    programRevision: program.programRevision, developmentRevision: intake.acceptance?.developmentRevision ?? null,
    sourcePack: clone(intake.acceptance?.sourcePack ?? null), intakeRevision: canonical(intake.acceptance ?? null),
    lifecycleRevision: canonical(intake.acceptance?.lifecycle ?? null), demandSource: canonical({ sourceId: source.sourceId, intakeId: source.intakeId, developmentRevision: source.developmentRevision, phaseRevision: source.phaseRevision, lifecycle: source.lifecycle }),
  };
}

export function assessCampaignActivation({ activation = null, program = null, geometry = null, intakes = [], sources = [] } = {}) {
  if (!activation) return { schema: "transitline.campaign-activation-assessment/1", contractVersion: 1, status: "missing", applicable: null, blockers: ["activation-not-found"] };
  if (activation.status === "withdrawn") return { schema: "transitline.campaign-activation-assessment/1", contractVersion: 1, status: "withdrawn", applicable: false, blockers: [] };
  const intake = intakes.find((entry) => entry.id === activation.refs.intakeId) ?? null;
  const source = sources.find((entry) => entry.sourceId === activation.refs.demandSourceId) ?? null;
  const blockers = currentInput({ program, geometry, intake, source, milestoneId: activation.milestoneId });
  if (!blockers.length && canonical(tuple(program, intake, source)) !== canonical(activation.revisionTuple)) blockers.push("revision-tuple-changed");
  return { schema: "transitline.campaign-activation-assessment/1", contractVersion: 1, status: blockers.length ? "stale" : "recorded", applicable: blockers.length ? false : true, blockers };
}

export function createCampaignActivation({ id, program, milestoneId, intakeId, demandSourceId, geometry = null, intakes = [], sources = [], atMinute = 0 } = {}) {
  const intake = intakes.find((entry) => entry.id === intakeId) ?? null;
  const source = sources.find((entry) => entry.sourceId === demandSourceId) ?? null;
  const blockers = currentInput({ program, geometry, intake, source, milestoneId });
  if (blockers.length) throw new Error(`Campaign activation cannot be recorded: ${blockers.join(", ")}`);
  return { schema: CAMPAIGN_ACTIVATION_SCHEMA, contractVersion: 1, activationId: id, programId: program.programId, milestoneId,
    refs: { intakeId, demandSourceId, contributionId: null, developmentRecordId: intake.developmentRecordId }, revisionTuple: tuple(program, intake, source),
    activatedAtMinute: atMinute, status: "recorded", withdrawal: null };
}

export function withdrawCampaignActivation(record, reason, atMinute = 0) {
  if (record.status !== "recorded") throw new Error(`Campaign activation ${record.activationId} cannot be withdrawn: status-not-allowed:${record.status}`);
  const why = text(reason); if (!why || why.length > 200) throw new Error("A withdrawal reason must be a non-empty text of at most 200 characters");
  record.status = "withdrawn"; record.withdrawal = { reason: why, atMinute }; return clone(record);
}
