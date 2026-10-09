import test from "node:test";
import assert from "node:assert/strict";
import { CAMPAIGN_PROGRAM_MANAGEMENT_PANEL_SCHEMA, mountCampaignProgramManagementPanel } from "../src/campaign-program-management-panel.mjs";
import { ScenarioRuntime } from "../src/scenario-runtime.mjs";
import { createState } from "../src/state.mjs";

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
const find = (node, className) => walk(node).filter((entry) => String(entry.className).split(" ").includes(className));
const click = (node, className) => { const target = find(node, className)[0]; assert.ok(target, className); target.fire("click"); };
const freeze = (value) => { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };

const geometry = (revision = "r1") => ({ schema: "transitline.regional-development-program/1", contractVersion: 1, programId: "program-a", programRevision: revision, sourcePackId: "pack", sourcePackVersion: "1", active: true, milestones: [{ milestoneId: "m1", sequence: 1, targetMonth: 0, durationMonths: null }] });

function fakeRuntime() {
  let next = 1; const records = []; const calls = [];
  const require = (id) => { const record = records.find((item) => item.id === id); if (!record) throw new Error("missing-record"); return record; };
  const check = (record, map) => {
    const current = map?.programRevision === "r1" && map?.active === true && map?.programId === record?.programId;
    const allowed = (kind) => {
      if (kind === "adopt") return record?.status === "draft" && current;
      if (kind === "monitor") return record?.status === "adopted" && current;
      if (kind === "complete") return record?.status === "monitoring" && current;
      if (kind === "delay") return ["adopted", "monitoring"].includes(record?.status);
      if (kind === "resume") return record?.status === "delayed" && current;
      if (kind === "cancel") return ["draft", "adopted", "monitoring", "delayed"].includes(record?.status);
      return false;
    };
    const transition = (kind) => ({ allowed: allowed(kind), blockers: allowed(kind) ? [] : [current ? `status-not-allowed:${record?.status ?? "missing"}` : "geometry-stale"] });
    return { geometry: { status: current ? "current" : "stale", reasons: current ? [] : ["geometry-revision-changed"] }, transitions: Object.fromEntries(["adopt", "monitor", "complete", "delay", "resume", "cancel"].map((kind) => [kind, transition(kind)])) };
  };
  const mutate = (method, id, status) => { const record = require(id); calls.push(method); record.status = status; return structuredClone(record); };
  return {
    calls,
    campaignProgramReport: () => structuredClone(records),
    assessCampaignProgram: ({ id, geometry: map }) => id ? check(require(id), map) : { geometry: { status: map?.programRevision === "r1" ? "current" : "stale", reasons: map?.programRevision === "r1" ? [] : ["geometry-revision-changed"] } },
    draftCampaignProgram: ({ geometry: map }) => { calls.push("draft"); const record = { id: `campaign-program:${next++}`, programId: map.programId, programRevision: map.programRevision, status: "draft" }; records.push(record); return structuredClone(record); },
    adoptCampaignProgram: (id) => mutate("adopt", id, "adopted"),
    monitorCampaignProgram: (id) => mutate("monitor", id, "monitoring"),
    completeCampaignProgram: (id) => mutate("complete", id, "completed"),
    delayCampaignProgram: (id, reason) => { const value = mutate("delay", id, "delayed"); value.reason = reason; return value; },
    resumeCampaignProgram: (id) => mutate("resume", id, "adopted"),
    cancelCampaignProgram: (id, reason) => { const value = mutate("cancel", id, "cancelled"); value.reason = reason; return value; },
  };
}

test("requires an explicit runtime and current map getter", () => {
  assert.throws(() => mountCampaignProgramManagementPanel({}), /container/);
  assert.throws(() => mountCampaignProgramManagementPanel({ container: container() }), /runtime/);
  assert.throws(() => mountCampaignProgramManagementPanel({ container: container(), runtime: fakeRuntime() }), /getProgramGeometry/);
});

test("mount and refresh are read-only, and an explicit draft begins the lifecycle", () => {
  const runtime = fakeRuntime(); const root = container(); const changes = [];
  const map = freeze({ programs: [geometry()] });
  const panel = mountCampaignProgramManagementPanel({ container: root, runtime, getProgramGeometry: () => map, onChange: (event) => changes.push(event) });
  assert.deepEqual(runtime.calls, []);
  assert.equal(panel.output().schema, CAMPAIGN_PROGRAM_MANAGEMENT_PANEL_SCHEMA);
  assert.equal(panel.output().geometries[0].programId, "program-a");
  click(root, "cpm-draft");
  assert.deepEqual(runtime.calls, ["draft"]);
  assert.deepEqual(changes, [{ kind: "command", action: "draft", id: "campaign-program:1", programId: "program-a" }]);
  assert.equal(panel.output().records[0].record.status, "draft");
});

test("each forward lifecycle command is a click and delay preserves its stated reason", () => {
  const runtime = fakeRuntime(); const root = container(); const map = { programs: [geometry()] };
  mountCampaignProgramManagementPanel({ container: root, runtime, getProgramGeometry: () => map });
  click(root, "cpm-draft"); click(root, "cpm-adopt"); click(root, "cpm-monitor");
  const reason = find(root, "cpm-reason")[0]; reason.value = "player-stated-weather"; reason.fire("input"); click(root, "cpm-delay");
  click(root, "cpm-resume"); click(root, "cpm-monitor"); click(root, "cpm-complete");
  assert.deepEqual(runtime.calls, ["draft", "adopt", "monitor", "delay", "resume", "monitor", "complete"]);
  assert.equal(runtime.campaignProgramReport()[0].status, "completed");
});

test("a map revision changed after render is re-read at click time and cannot be adopted", () => {
  const runtime = fakeRuntime(); const root = container(); let map = { programs: [geometry()] };
  const panel = mountCampaignProgramManagementPanel({ container: root, runtime, getProgramGeometry: () => map });
  click(root, "cpm-draft");
  map = { programs: [geometry("r2")] };
  click(root, "cpm-adopt");
  assert.deepEqual(runtime.calls, ["draft"], "stale map does not issue a lifecycle command");
  assert.match(panel.output().notice.message, /geometry-stale/);
  assert.equal(runtime.campaignProgramReport()[0].status, "draft");
});

test("cancel remains an explicit lifecycle command even when a current geometry is missing", () => {
  const runtime = fakeRuntime(); const root = container(); let map = { programs: [geometry()] };
  mountCampaignProgramManagementPanel({ container: root, runtime, getProgramGeometry: () => map });
  click(root, "cpm-draft");
  map = { programs: [] };
  const reason = find(root, "cpm-reason")[0]; reason.value = "player-choice"; reason.fire("input"); click(root, "cpm-cancel");
  assert.deepEqual(runtime.calls, ["draft", "cancel"]);
  assert.equal(runtime.campaignProgramReport()[0].status, "cancelled");
});

test("the panel drives the real ScenarioRuntime lifecycle without moving its clock or operational simulation", () => {
  const pack = { manifest: { id: "pack", version: "1", data: { license: "test", attribution: [] } }, demand: { model: "gravity", points: [], attractors: [] } };
  const runtime = new ScenarioRuntime({ pack, operationalState: createState(pack) });
  const root = container(); const map = { programs: [geometry()] };
  const before = { clock: runtime.game.clock.minute, sim: runtime.operationalState.simMinutes, rng: runtime.game.rng.snapshot() };
  mountCampaignProgramManagementPanel({ container: root, runtime, getProgramGeometry: () => map });
  click(root, "cpm-draft"); click(root, "cpm-adopt"); click(root, "cpm-monitor"); click(root, "cpm-complete");
  assert.equal(runtime.campaignProgramReport()[0].status, "completed");
  assert.deepEqual({ clock: runtime.game.clock.minute, sim: runtime.operationalState.simMinutes, rng: runtime.game.rng.snapshot() }, before);
});

test("output is detached and destroy removes the panel", () => {
  const runtime = fakeRuntime(); const root = container(); const map = freeze({ programs: [geometry()] });
  const panel = mountCampaignProgramManagementPanel({ container: root, runtime, getProgramGeometry: () => map });
  const output = panel.output(); output.geometries[0].programId = "mutated";
  assert.equal(panel.output().geometries[0].programId, "program-a");
  assert.equal(map.programs[0].programId, "program-a");
  panel.destroy(); assert.equal(root.children.length, 0);
  panel.refresh(); assert.equal(root.children.length, 0);
});
