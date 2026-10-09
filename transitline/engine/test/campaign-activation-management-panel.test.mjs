import test from "node:test";
import assert from "node:assert/strict";
import { CAMPAIGN_ACTIVATION_MANAGEMENT_PANEL_SCHEMA, mountCampaignActivationManagementPanel } from "../src/campaign-activation-management-panel.mjs";

class Node_ {
  constructor(tag) { Object.assign(this, { tag, children: [], className: "", textContent: "", listeners: {}, value: "", disabled: false }); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  addEventListener(kind, listener) { (this.listeners[kind] ??= []).push(listener); }
  fire(kind) { for (const listener of this.listeners[kind] ?? []) listener({ type: kind }); }
}
const dom = { createElement: (tag) => new Node_(tag) };
const container = () => Object.assign(new Node_("div"), { ownerDocument: dom });
const walk = (node) => [node, ...node.children.flatMap(walk)];
const all = (node, className) => walk(node).filter((entry) => String(entry.className).split(" ").includes(className));
const click = (node, className) => { const target = all(node, className)[0]; assert.ok(target, className); target.fire("click"); };
const freeze = (value) => { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const programGeometry = (revision = "r1") => ({ schema: "transitline.regional-development-program/1", contractVersion: 1, programId: "program-a", programRevision: revision, sourcePackId: "pack", sourcePackVersion: "1", active: true, milestones: [{ milestoneId: "m1", sequence: 1 }] });
const developmentGeometry = () => ({ schema: "transitline.new-town-development-export/1", packId: "pack", packVersion: "1", developments: [] });
const source = () => ({ sourceId: "new-town-explicit-demand-source:1", intakeId: "new-town-demand-intake:1", status: "applied", standing: { status: "current", reasons: [] } });

function fakeRuntime() {
  const calls = []; const activations = [];
  const program = { id: "campaign-program:1", programId: "program-a", status: "monitoring", milestones: [{ milestoneId: "m1", sequence: 1, status: "planned" }] };
  return {
    calls,
    campaignProgramReport: () => [structuredClone(program)],
    newTownExplicitDemandSourceReport: () => [source()],
    campaignActivationReport: ({ geometry, developmentGeometry: development }) => activations.map((item) => ({ ...structuredClone(item), standing: { status: geometry?.programRevision === "r1" && development?.packId === "pack" ? "recorded" : "stale", blockers: [] } })),
    recordCampaignActivation: (input) => {
      calls.push({ type: "record", input: structuredClone(input) });
      if (input.geometry?.programRevision !== "r1") throw new Error("program-geometry-stale");
      if (input.developmentGeometry?.packId !== "pack") throw new Error("development-geometry-invalid");
      if (input.intakeId !== source().intakeId || input.demandSourceId !== source().sourceId) throw new Error("source-identity-invalid");
      const record = { activationId: `campaign-activation:${activations.length + 1}`, programId: "program-a", milestoneId: input.milestoneId, status: "recorded" };
      activations.push(record); return structuredClone(record);
    },
    withdrawCampaignActivation: (id, reason) => { calls.push({ type: "withdraw", id, reason }); if (!reason) throw new Error("reason-required"); const found = activations.find((item) => item.activationId === id); found.status = "withdrawn"; return structuredClone(found); },
  };
}

test("requires every runtime boundary and both current geometry getters", () => {
  assert.throws(() => mountCampaignActivationManagementPanel({}), /container/);
  assert.throws(() => mountCampaignActivationManagementPanel({ container: container() }), /runtime/);
  assert.throws(() => mountCampaignActivationManagementPanel({ container: container(), runtime: fakeRuntime() }), /getProgramGeometry/);
  assert.throws(() => mountCampaignActivationManagementPanel({ container: container(), runtime: fakeRuntime(), getProgramGeometry: () => [] }), /getDevelopmentGeometry/);
});

test("mount and refresh only read current records and sources", () => {
  const runtime = fakeRuntime(); const root = container();
  const panel = mountCampaignActivationManagementPanel({ container: root, runtime, getProgramGeometry: () => freeze({ programs: [programGeometry()] }), getDevelopmentGeometry: () => freeze(developmentGeometry()) });
  assert.deepEqual(runtime.calls, []);
  assert.equal(panel.output().schema, CAMPAIGN_ACTIVATION_MANAGEMENT_PANEL_SCHEMA);
  assert.equal(panel.output().sourceCount, 1);
  panel.refresh(); assert.deepEqual(runtime.calls, []);
});

test("an explicit source selection records exactly the selected B19 source against the current B20 program geometry", () => {
  const runtime = fakeRuntime(); const root = container(); const changes = [];
  const panel = mountCampaignActivationManagementPanel({ container: root, runtime, getProgramGeometry: () => ({ programs: [programGeometry()] }), getDevelopmentGeometry: developmentGeometry, onChange: (event) => changes.push(event) });
  const picker = all(root, "cam-source")[0]; picker.value = source().sourceId; picker.fire("change"); click(root, "cam-record");
  assert.equal(runtime.calls.length, 1); assert.equal(runtime.calls[0].type, "record");
  assert.deepEqual(runtime.calls[0].input, { campaignProgramId: "campaign-program:1", milestoneId: "m1", intakeId: "new-town-demand-intake:1", demandSourceId: "new-town-explicit-demand-source:1", geometry: programGeometry(), developmentGeometry: developmentGeometry() });
  assert.deepEqual(changes, [{ kind: "command", action: "record", id: "campaign-activation:1", campaignProgramId: "campaign-program:1", milestoneId: "m1" }]);
  assert.equal(panel.output().records[0].activations[0].status, "recorded");
});

test("the panel re-reads map geometry at the click boundary and does not hide a stale runtime refusal", () => {
  const runtime = fakeRuntime(); const root = container(); let map = { programs: [programGeometry()] };
  const panel = mountCampaignActivationManagementPanel({ container: root, runtime, getProgramGeometry: () => map, getDevelopmentGeometry: developmentGeometry });
  const picker = all(root, "cam-source")[0]; picker.value = source().sourceId; picker.fire("change"); map = { programs: [programGeometry("r2")] }; click(root, "cam-record");
  assert.equal(runtime.calls.length, 1); assert.equal(runtime.calls[0].input.geometry.programRevision, "r2");
  assert.match(panel.output().notice.message, /program-geometry-stale/);
});

test("withdrawal is click-only and retains the player-stated reason", () => {
  const runtime = fakeRuntime(); const root = container();
  const panel = mountCampaignActivationManagementPanel({ container: root, runtime, getProgramGeometry: () => ({ programs: [programGeometry()] }), getDevelopmentGeometry: developmentGeometry });
  let picker = all(root, "cam-source")[0]; picker.value = source().sourceId; picker.fire("change"); click(root, "cam-record");
  const reason = all(root, "cam-withdraw-reason")[0]; reason.value = "player-choice"; reason.fire("input"); click(root, "cam-withdraw");
  assert.deepEqual(runtime.calls.map((call) => call.type), ["record", "withdraw"]);
  assert.deepEqual(runtime.calls[1], { type: "withdraw", id: "campaign-activation:1", reason: "player-choice" });
  assert.equal(panel.output().records[0].activations[0].status, "withdrawn");
});

test("output is detached and destroy leaves no mounted DOM", () => {
  const runtime = fakeRuntime(); const root = container(); const programs = freeze({ programs: [programGeometry()] }); const development = freeze(developmentGeometry());
  const panel = mountCampaignActivationManagementPanel({ container: root, runtime, getProgramGeometry: () => programs, getDevelopmentGeometry: () => development });
  const output = panel.output(); output.sources[0].sourceId = "mutated";
  assert.equal(panel.output().sources[0].sourceId, source().sourceId);
  panel.destroy(); assert.equal(root.children.length, 0); panel.refresh(); assert.equal(root.children.length, 0);
});
