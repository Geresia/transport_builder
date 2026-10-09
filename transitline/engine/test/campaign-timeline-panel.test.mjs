import test from "node:test";
import assert from "node:assert/strict";
import { CAMPAIGN_TIMELINE_PANEL_NOTICE, CAMPAIGN_TIMELINE_PANEL_SCHEMA, checkCampaignTimelineView, mountCampaignTimelinePanel } from "../src/campaign-timeline-panel.mjs";

class Node_ {
  constructor(tag) { Object.assign(this, { tag, children: [], className: "", textContent: "", listeners: {}, type: "", disabled: false }); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  addEventListener(kind, listener) { (this.listeners[kind] ??= []).push(listener); }
  fire(kind) { for (const listener of this.listeners[kind] ?? []) listener({ type: kind }); }
}
const dom = { createElement: (tag) => new Node_(tag) };
const container = () => Object.assign(new Node_("div"), { ownerDocument: dom });
const walk = (node) => [node, ...node.children.flatMap(walk)];
const byClass = (node, name) => walk(node).filter((entry) => String(entry.className).split(" ").includes(name));
const messages = (node) => walk(node).map((entry) => entry.textContent).filter(Boolean);
const click = (node, name) => { const target = byClass(node, name)[0]; assert.ok(target, name); target.fire("click"); };
const freeze = (value) => { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const factReport = () => ({ schema: "transitline.campaign-fact-report/1", programs: [{ campaignProgramId: "campaign-program:2", programId: "program:beta", status: "monitoring", geometry: { status: "current" }, milestones: [{ milestoneId: "m2", sequence: 2, status: "reached", targetMonth: 1, durationMonths: 3, declaredAtMinute: 30, activations: [] }, { milestoneId: "m1", sequence: 1, status: "planned", targetMonth: 0, durationMonths: null, declaredAtMinute: null, activations: [] }] }] });

test("requires host fact and clock getters, and validates only the timeline view shape", () => {
  assert.throws(() => mountCampaignTimelinePanel({}), /container/);
  assert.throws(() => mountCampaignTimelinePanel({ container: container() }), /getFactReport/);
  assert.throws(() => mountCampaignTimelinePanel({ container: container(), getFactReport: factReport }), /getClockMinute/);
  assert.equal(checkCampaignTimelineView(null).ok, false);
  assert.equal(checkCampaignTimelineView({ schema: "wrong", programs: [] }).ok, false);
  assert.equal(checkCampaignTimelineView({ schema: "transitline.campaign-timeline-view/1", programs: null }).ok, true);
});

test("due is displayed but never turns a planned milestone into reached", () => {
  const root = container(); const report = freeze(factReport()); let clock = 90 * 24 * 60;
  const panel = mountCampaignTimelinePanel({ container: root, getFactReport: () => report, getClockMinute: () => clock });
  assert.ok(messages(root).includes(CAMPAIGN_TIMELINE_PANEL_NOTICE));
  assert.ok(messages(root).some((value) => value === "due" || value === "past due"));
  assert.equal(panel.output().view.programs[0].milestones.find((entry) => entry.milestoneId === "m1").status, "planned");
  assert.equal(byClass(root, "campaign-timeline-reach").length, 0, "no host callback means no command surface");
  clock += 30 * 24 * 60; panel.refresh();
  assert.equal(panel.output().view.programs[0].milestones.find((entry) => entry.milestoneId === "m1").status, "planned");
});

test("only an explicit selected click emits a minimal reach intent", () => {
  const root = container(); const calls = [];
  const panel = mountCampaignTimelinePanel({ container: root, getFactReport: factReport, getClockMinute: () => 0, onReachMilestone: (intent) => calls.push(intent) });
  assert.deepEqual(calls, []);
  click(root, "campaign-timeline-select-program");
  assert.deepEqual(calls, []);
  const picks = byClass(root, "campaign-timeline-select-milestone");
  picks.find((node) => node.textContent.includes("m1")).fire("click");
  assert.deepEqual(calls, []);
  click(root, "campaign-timeline-reach");
  assert.deepEqual(calls, [{ campaignProgramId: "campaign-program:2", programId: "program:beta", milestoneId: "m1" }]);
  assert.equal(panel.output().selectedMilestoneId, "m1");
});

test("a configured milestone declaration requires explicit evidence or an explicit empty declaration and supplies current geometry", () => {
  const root = container(); const calls = [];
  const geometry = { schema: "transitline.regional-development-program/1", programId: "program:beta", programRevision: "r1" };
  const panel = mountCampaignTimelinePanel({
    container: root, getFactReport: factReport, getClockMinute: () => 0,
    getGeometryForProgram: (programId) => programId === "program:beta" ? geometry : null,
    onReachMilestone: (intent) => calls.push(intent),
  });
  byClass(root, "campaign-timeline-select-milestone").find((node) => node.textContent.includes("m1")).fire("click");
  click(root, "campaign-timeline-reach");
  assert.match(panel.output().commandError, /Declare no observed references/);
  assert.deepEqual(calls, []);
  click(root, "campaign-timeline-add-reference");
  const kinds = byClass(root, "campaign-timeline-reference-refKind"); const ids = byClass(root, "campaign-timeline-reference-refId"); const states = byClass(root, "campaign-timeline-reference-state");
  kinds[0].value = "development"; kinds[0].fire("change");
  ids[0].value = "town-a"; ids[0].fire("change");
  states[0].value = "servicing"; states[0].fire("change");
  click(root, "campaign-timeline-reach");
  assert.deepEqual(calls, [{ campaignProgramId: "campaign-program:2", programId: "program:beta", milestoneId: "m1", observedRefs: [{ refKind: "development", refId: "town-a", state: "servicing" }], geometry }]);
  assert.equal(panel.output().commandError, null);
});

test("a configured milestone declaration can explicitly declare an empty observed reference list", () => {
  const root = container(); const calls = [];
  const panel = mountCampaignTimelinePanel({
    container: root, getFactReport: factReport, getClockMinute: () => 0,
    getGeometryForProgram: () => ({ programId: "program:beta" }), onReachMilestone: (intent) => calls.push(intent),
  });
  byClass(root, "campaign-timeline-select-milestone").find((node) => node.textContent.includes("m1")).fire("click");
  click(root, "campaign-timeline-declare-no-references");
  click(root, "campaign-timeline-reach");
  assert.deepEqual(calls[0].observedRefs, []);
});

test("reached milestone stays read-only and a host command error is shown without changing view facts", () => {
  const root = container();
  const panel = mountCampaignTimelinePanel({ container: root, getFactReport: factReport, getClockMinute: () => 0, onReachMilestone: () => { throw new Error("geometry-stale"); } });
  click(root, "campaign-timeline-select-program");
  byClass(root, "campaign-timeline-select-milestone").find((node) => node.textContent.includes("m2")).fire("click");
  assert.equal(byClass(root, "campaign-timeline-reach").length, 0);
  byClass(root, "campaign-timeline-select-milestone").find((node) => node.textContent.includes("m1")).fire("click");
  click(root, "campaign-timeline-reach");
  assert.equal(panel.output().commandError, "geometry-stale");
  assert.ok(messages(root).includes("geometry-stale"));
  assert.equal(panel.output().view.programs[0].milestones.find((entry) => entry.milestoneId === "m2").status, "reached");
});

test("missing campaign facts are unknown rather than an empty record, and refresh clears a vanished selection", () => {
  let report = null; const root = container();
  const panel = mountCampaignTimelinePanel({ container: root, getFactReport: () => report, getClockMinute: () => 0 });
  assert.equal(panel.output().view.programs, null);
  assert.ok(messages(root).some((value) => value.includes("not provided")));
  report = factReport(); panel.refresh(); panel.select("campaign-program:2", "m1");
  report = { schema: "transitline.campaign-fact-report/1", programs: [] }; panel.refresh();
  assert.equal(panel.output().selectedProgramId, null);
  assert.equal(panel.output().selectedMilestoneId, null);
});

test("output is detached, host input is unchanged, and destroy leaves no mounted DOM", () => {
  const report = freeze(factReport()); const root = container();
  const panel = mountCampaignTimelinePanel({ container: root, getFactReport: () => report, getClockMinute: () => 0 });
  const first = panel.output(); first.view.programs[0].status = "mutated";
  assert.equal(panel.output().view.programs[0].status, "monitoring");
  assert.equal(report.programs[0].status, "monitoring");
  assert.equal(panel.output().schema, CAMPAIGN_TIMELINE_PANEL_SCHEMA);
  panel.destroy();
  assert.equal(root.children.length, 0);
  panel.refresh();
  assert.equal(root.children.length, 0);
});
