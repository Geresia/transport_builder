import test from "node:test";
import assert from "node:assert/strict";
import { CAMPAIGN_MONTH_MINUTES } from "../src/campaign-time.mjs";
import { buildCampaignTimelineView } from "../src/campaign-timeline-view.mjs";
const report = { schema: "transitline.campaign-fact-report/1", programs: [{ campaignProgramId: "campaign-program:1", programId: "p", status: "monitoring", geometry: { status: "current" }, milestones: [{ milestoneId: "m", sequence: 1, status: "planned", targetMonth: 2, durationMonths: null, declaredAtMinute: null, activations: [] }] }] };
test("timeline labels the existing clock without changing a milestone state", () => {
  const view = buildCampaignTimelineView({ clockMinute: 2 * CAMPAIGN_MONTH_MINUTES, factReport: report });
  assert.equal(view.now.monthIndex, 2); assert.equal(view.programs[0].milestones[0].target.status, "due"); assert.equal(view.programs[0].milestones[0].status, "planned");
});
test("missing fact report stays unknown rather than pretending a blank campaign", () => {
  assert.equal(buildCampaignTimelineView({ clockMinute: 0 }).programs, null);
});
