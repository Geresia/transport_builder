// B20-M3 read-only view model. The host may render it in a panel, map, or 3D
// shell. It uses only the existing management clock supplied by the caller.

import { campaignTargetStatus, campaignTimeAtMinute } from "./campaign-time.mjs";
export const CAMPAIGN_TIMELINE_VIEW_SCHEMA = "transitline.campaign-timeline-view/1";
const clone = (value) => structuredClone(value);
const compare = (a, b) => String(a).localeCompare(String(b));

export function buildCampaignTimelineView({ clockMinute = null, factReport = null } = {}) {
  const now = campaignTimeAtMinute(clockMinute);
  if (!factReport || factReport.schema !== "transitline.campaign-fact-report/1" || !Array.isArray(factReport.programs)) return { schema: CAMPAIGN_TIMELINE_VIEW_SCHEMA, contractVersion: 1, now, programs: null, warnings: ["campaign-fact-report-not-provided"] };
  const programs = factReport.programs.map((program) => ({
    campaignProgramId: program.campaignProgramId, programId: program.programId, status: program.status, geometryStatus: program.geometry?.status ?? null,
    milestones: (program.milestones ?? []).map((milestone) => ({
      milestoneId: milestone.milestoneId, sequence: milestone.sequence, status: milestone.status, targetMonth: milestone.targetMonth,
      durationMonths: milestone.durationMonths, target: campaignTargetStatus(milestone.targetMonth, clockMinute), declaredAtMinute: milestone.declaredAtMinute,
      activations: clone(milestone.activations ?? []),
    })).sort((a, b) => a.sequence - b.sequence || compare(a.milestoneId, b.milestoneId)),
  })).sort((a, b) => compare(a.campaignProgramId, b.campaignProgramId));
  return { schema: CAMPAIGN_TIMELINE_VIEW_SCHEMA, contractVersion: 1, now, programs, warnings: [] };
}
