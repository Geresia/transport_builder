// B20-E3. Read-only composition of facts owned by the existing records. No
// totals, scoring, money, forecast, or lifecycle transition is calculated.

export const CAMPAIGN_FACT_REPORT_SCHEMA = "transitline.campaign-fact-report/1";
const clone = (value) => structuredClone(value);
const cmp = (a, b) => String(a).localeCompare(String(b));
const list = (value) => Array.isArray(value) ? value : null;
const byId = (values, fields) => {
  const out = new Map();
  for (const value of values ?? []) for (const field of fields) if (typeof value?.[field] === "string" && !out.has(value[field])) out.set(value[field], value);
  return out;
};
const statusOf = (value) => value ? (value.status ?? null) : null;
const refs = (ids, index, fields, absentReason) => ids === null ? { items: null, reason: "not-stated" } : { items: ids.map((id) => {
  const item = index.get(id) ?? null;
  return item ? { id, status: statusOf(item), revision: fields.map((field) => item[field]).find((value) => typeof value === "string") ?? null } : { id, status: null, revision: null, reason: absentReason };
}).sort((a, b) => cmp(a.id, b.id)), reason: null };

export function buildCampaignFactReport({ programs = [], activations = [], developments = [], contributions = [], demandSources = [], services = [], timetables = [] } = {}) {
  const developmentIndex = byId(developments, ["id", "developmentId"]);
  const contributionIndex = byId(contributions, ["contributionId", "id"]);
  const sourceIndex = byId(demandSources, ["sourceId"]);
  const serviceIndex = byId(services, ["id", "serviceId"]);
  const timetableIndex = byId(timetables, ["id", "timetableId"]);
  const activationByProgram = new Map();
  for (const activation of activations ?? []) {
    const bucket = activationByProgram.get(activation.programId) ?? []; bucket.push(activation); activationByProgram.set(activation.programId, bucket);
  }
  const rows = (programs ?? []).map((program) => {
    const links = program.links ?? {};
    const activationsFor = (activationByProgram.get(program.programId) ?? []).sort((a, b) => cmp(a.activationId, b.activationId)).map((activation) => ({
      activationId: activation.activationId, milestoneId: activation.milestoneId, status: activation.standing?.status ?? activation.status ?? null,
      applicable: activation.standing?.applicable ?? null, blockers: clone(activation.standing?.blockers ?? []),
      intakeId: activation.refs?.intakeId ?? null, demandSource: activation.refs?.demandSourceId ? { sourceId: activation.refs.demandSourceId, standing: sourceIndex.get(activation.refs.demandSourceId)?.standing?.status ?? null } : null,
    }));
    return {
      campaignProgramId: program.id, programId: program.programId, programRevision: program.programRevision, status: program.status,
      geometry: clone(program.geometry ?? null), milestones: (program.milestones ?? []).slice().sort((a, b) => a.sequence - b.sequence || cmp(a.milestoneId, b.milestoneId)).map((milestone) => ({
        milestoneId: milestone.milestoneId, sequence: milestone.sequence, targetMonth: milestone.targetMonth, durationMonths: milestone.durationMonths, status: milestone.status,
        declaredAtMinute: milestone.declaredAtMinute, observedRefs: clone(milestone.observedRefs), activations: activationsFor.filter((activation) => activation.milestoneId === milestone.milestoneId),
        linkedDevelopments: refs(milestone.linkedDevelopmentIds, developmentIndex, ["developmentRevision"], "development-not-found"),
        linkedServicePlans: milestone.linkedServicePlanIds === null ? { items: null, reason: "not-stated" } : { items: milestone.linkedServicePlanIds.map((id) => ({ id, status: null, revision: null, reason: "service-plan-report-not-provided" })), reason: null },
      })),
      linkedDevelopments: refs(links.linkedDevelopmentIds ?? null, developmentIndex, ["developmentRevision"], "development-not-found"),
      linkedContributions: refs(links.linkedContributionIds ?? null, contributionIndex, ["contributionRevision"], "contribution-not-found"),
      linkedDemandSources: refs(links.linkedDemandSourceIds ?? null, sourceIndex, ["developmentRevision"], "demand-source-not-found"),
      linkedServices: refs(links.linkedServiceIds ?? null, serviceIndex, ["revision"], "service-not-found"),
      linkedTimetables: refs(links.linkedTimetableIds ?? null, timetableIndex, ["assessmentRevision"], "timetable-not-found"),
      history: clone(program.history ?? []),
    };
  }).sort((a, b) => cmp(a.campaignProgramId, b.campaignProgramId));
  return { schema: CAMPAIGN_FACT_REPORT_SCHEMA, contractVersion: 1, programs: rows, notComputed: ["totals", "roi", "cost", "demand", "ridership", "fare", "score", "success-verdict"] };
}
