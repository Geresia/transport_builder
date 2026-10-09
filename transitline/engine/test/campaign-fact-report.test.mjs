import test from "node:test";
import assert from "node:assert/strict";
import { buildCampaignFactReport } from "../src/campaign-fact-report.mjs";

test("campaign fact report joins only supplied facts and preserves null link lists", () => {
  const report = buildCampaignFactReport({
    programs: [{ id: "campaign-program:1", programId: "p", programRevision: "r", status: "monitoring", geometry: { status: "current" }, links: { linkedDevelopmentIds: ["d"] }, managementRefs: { linkedDevelopmentRecordIds: ["d"], linkedContributionIds: null, linkedDemandSourceIds: null, linkedServiceIds: [], linkedTimetableIds: null }, milestones: [{ milestoneId: "m", sequence: 1, targetMonth: 0, durationMonths: null, status: "planned", declaredAtMinute: null, observedRefs: [], linkedDevelopmentIds: ["d"], linkedServicePlanIds: null }], history: [] }],
    activations: [{ activationId: "campaign-activation:1", programId: "p", milestoneId: "m", refs: { intakeId: "i", demandSourceId: "s" }, standing: { status: "recorded", applicable: true, blockers: [] } }],
    developments: [{ id: "d", status: "servicing", developmentRevision: "d-r" }], demandSources: [{ sourceId: "s", standing: { status: "current" } }],
  });
  const row = report.programs[0];
  assert.equal(report.schema, "transitline.campaign-fact-report/1");
  assert.equal(row.linkedDevelopments.items[0].status, "servicing");
  assert.equal(row.linkedContributions.items, null);
  assert.deepEqual(row.linkedServices.items, []);
  assert.equal(row.milestones[0].activations[0].demandSource.standing, "current");
  assert.ok(report.notComputed.includes("roi"));
});

test("missing facts are marked missing and report does not mutate frozen input", () => {
  const programs = Object.freeze([Object.freeze({ id: "campaign-program:1", programId: "p", programRevision: "r", status: "draft", geometry: null, links: {}, managementRefs: { linkedDevelopmentRecordIds: ["gone"] }, milestones: [], history: [] })]);
  const report = buildCampaignFactReport({ programs });
  assert.equal(report.programs[0].linkedDevelopments.items[0].reason, "development-not-found");
  report.programs[0].status = "changed";
  assert.equal(programs[0].status, "draft");
});
