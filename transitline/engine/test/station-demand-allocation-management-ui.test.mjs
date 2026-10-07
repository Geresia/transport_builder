import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  FRACTIONAL_NOTICE, SCOPE_NOTICE, STATION_DEMAND_ALLOCATION_DRAFT_SCHEMA, buildAllocationAuthoringView, buildStationDemandPolicy, buildStationDemandWalkingPolicy,
  mountStationDemandAllocationManagementPanel, newAllocationDraft, restoreAllocationDraft, serializeAllocationDraft,
} from "../src/station-demand-allocation-management-ui.mjs";
import { snapshotOperationalState } from "../src/integrated-save.mjs";
import { ScenarioRuntime } from "../src/scenario-runtime.mjs";
import { createState } from "../src/state.mjs";

// --- a minimal DOM: elements, listeners, replaceChildren ---
class Node_ {
  constructor(tag) { Object.assign(this, { tag, children: [], className: "", textContent: "", value: "", checked: false, disabled: false, placeholder: "", listeners: {} }); }
  append(...kids) { this.children.push(...kids); }
  replaceChildren(...kids) { this.children = []; this.append(...kids); }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  fire(type) { for (const fn of this.listeners[type] ?? []) fn({ type }); }
}
const doc = { createElement: (tag) => new Node_(tag) };
const newContainer = () => Object.assign(new Node_("div"), { ownerDocument: doc });
const all = (node, pred = () => true) => [pred(node) ? node : null, ...node.children.flatMap((c) => all(c, pred))].filter(Boolean);
const texts = (node) => all(node).map((n) => n.textContent).filter(Boolean);
const shows = (node, part) => texts(node).some((t) => t.includes(part));
const buttons = (node) => all(node, (n) => n.tag === "button");
const button = (node, label) => { const b = buttons(node).find((n) => n.textContent === label); assert.ok(b, `button ${label}`); return b; };
const click = (node, label) => button(node, label).fire("click");
const stationRow = (c, label) => all(c, (n) => n.className === "alloc-station" && n.children[0].textContent === label)[0];
const nodeRow = (c, id) => all(c, (n) => n.className === "alloc-node" && n.children[0].textContent === id)[0];
const selectIn = (row, className) => all(row, (n) => n.tag === "select" && n.className === className)[0];
const pick = (select, value) => { select.value = value; select.fire("change"); };
const typeInto = (input, value) => { input.value = value; input.fire("input"); };
const deepFreeze = (o) => { if (o && typeof o === "object") { Object.values(o).forEach(deepFreeze); Object.freeze(o); } return o; };
const sharesInputs = (row) => all(row, (n) => n.tag === "input" && n.placeholder === "%");
const walkEstimate = (c) => all(c, (n) => n.tag === "select" && n.className === "alloc-walk-estimate")[0];
const areaBox = (c) => all(c, (n) => n.tag === "label" && n.className === "alloc-check")[0].children[0];
const PREVIEW_TITLE = "미리보기 (엔진 판정";

// --- a spy runtime: it only records what the panel asks and returns what the test hands it ---
const REV = { A: "rev:A1", B: "rev:B1" };
const input = (demandNodeId, status, over = {}) => ({ demandNodeId, status, reason: null, residents: 100, jobs: 20, ...over });
function application(over = {}) {
  return {
    applicationId: "access-app:1", sourcePackId: "t", sourcePackVersion: "1",
    access: { sites: [{ stationAccessId: "A", name: "Alpha" }, { stationAccessId: "B", name: "Beta" }] },
    assessment: { sites: [
      { stationAccessId: "A", stationAccessRevision: REV.A, connectedStationId: "src:A", catchmentStatus: "shared", unknownReasons: [], demandNodeInputs: [input("n:own", "available"), input("n:both", "shared", { residents: 50, jobs: 0 })] },
      { stationAccessId: "B", stationAccessRevision: REV.B, connectedStationId: "src:B", catchmentStatus: "unknown", unknownReasons: ["demand-source-coarse"], demandNodeInputs: [input("n:both", "shared", { residents: 50, jobs: 0 }), input("n:coarse", "unknown", { reason: "demand-source-coarse", residents: null, jobs: null })] },
    ] },
    ...over,
  };
}
const previewOf = (over = {}) => ({
  schema: "transitline.station-demand-allocation-application/1", status: "current", policyStatus: "valid", links: [], blockedLinks: [],
  allocation: { totals: { nodes: 3, assigned: 0, partlyAssigned: 0, held: 2, unknown: 1 }, policyIssues: [], rules: [], nodes: [], legacy: { supplied: true, overrideRequiredNodeIds: [] } },
  walking: { nodes: [], links: [] }, ...over,
});
function spy({ app = application(), report = null, preview = previewOf(), applied = { links: [{ demandNodeId: "n:own", stationId: "phys:A", walkMinutes: 7 }], blockedLinks: [], status: "current" }, throwOn = {} } = {}) {
  const calls = { assess: [], apply: [], accessReads: 0, reportReads: 0 };
  let currentApp = app;
  let currentReport = report;
  const runtime = {
    stationDemandAccessReport() { calls.accessReads += 1; return currentApp; },
    stationDemandAllocationReport() { calls.reportReads += 1; return currentReport; },
    assessStationDemandAllocation(i) { calls.assess.push(i); if (throwOn.assess) throw new Error(throwOn.assess); return preview; },
    applyStationDemandAllocation(i) { calls.apply.push(i); if (throwOn.apply) throw new Error(throwOn.apply); currentReport = applied; return applied; },
  };
  return { runtime, calls, setApp: (a) => { currentApp = a; }, setReport: (r) => { currentReport = r; } };
}
function mount(env = spy(), over = {}) {
  const container = newContainer();
  const changes = [];
  const panel = mountStationDemandAllocationManagementPanel({ container, runtime: env.runtime, onChange: () => changes.push(1), ...over });
  return { container, panel, changes, ...env };
}
const bindAll = (env) => click(env.container, "모든 규칙을 현재 revision에 묶기");

test("mounting only reads: no preview, no apply, frozen engine reports stay untouched", () => {
  const env = mount(spy({ app: deepFreeze(application()), report: deepFreeze({ status: "current", links: [], blockedLinks: [], allocationPolicy: { policyId: "p" }, appliedAtSimMinute: 4 }) }));
  env.panel.refresh();
  assert.deepEqual([env.calls.assess.length, env.calls.apply.length, env.changes.length], [0, 0, 0]);
  assert.ok(env.calls.accessReads > 0 && env.calls.reportReads > 0);
  assert.ok(shows(env.container, SCOPE_NOTICE));
  assert.ok(shows(env.container, "Alpha") && shows(env.container, "Beta"));
});

test("with no access facts the panel says why and offers nothing to apply", () => {
  const none = mount(spy({ app: null }));
  assert.ok(shows(none.container, "역 접근권 사실이 아직 엔진에 없습니다"));
  assert.equal(buttons(none.container).length, 0);
  const noSites = mount(spy({ app: application({ assessment: { sites: [] } }) }));
  assert.ok(shows(noSites.container, "적용된 접근권에 역이 없습니다"));
  assert.equal(buttons(noSites.container).length, 0);
  assert.deepEqual([none.calls.assess.length, none.calls.apply.length], [0, 0]);
});

test("the authoring view reads E1's facts: stations, nodes claimed by several stations, and unknown nodes that no rule can open; 0 stays 0 and null stays unknown", () => {
  const view = buildAllocationAuthoringView(application());
  assert.deepEqual(view.stations.map((s) => [s.stationAccessId, s.label, s.exclusiveNodeCount, s.unknownNodeCount]), [["A", "Alpha", 1, 0], ["B", "Beta", 0, 1]]);
  assert.deepEqual(view.sharedNodes, [{ demandNodeId: "n:both", claimants: ["A", "B"], residents: 50, jobs: 0 }]);
  assert.deepEqual(view.unknownNodes, [{ demandNodeId: "n:coarse", claimants: ["B"], reasons: ["demand-source-coarse"] }]);
  assert.deepEqual(view.revisions, REV);
  assert.equal(view.sharedNodes[0].jobs, 0, "a measured zero is not unknown");
  assert.equal(buildAllocationAuthoringView(null).reason, "no-access-application");
  assert.equal(buildAllocationAuthoringView({ access: {}, assessment: { sites: [] } }).reason, "no-station-sites");
  const env = mount(spy());
  assert.ok(shows(nodeRow(env.container, "n:both"), "거주 50 · 종사 0"));
  const unseen = application();
  unseen.assessment.sites[0].demandNodeInputs[1] = input("n:both", "shared", { residents: null, jobs: null });
  unseen.assessment.sites[1].demandNodeInputs[0] = input("n:both", "shared", { residents: null, jobs: null });
  assert.ok(shows(nodeRow(mount(spy({ app: unseen })).container, "n:both"), "거주 미상 · 종사 미상"));
  assert.ok(shows(env.container, "n:coarse") && shows(env.container, "어떤 규칙으로도 풀 수 없음"));
  assert.equal(nodeRow(env.container, "n:coarse"), undefined, "an unknown node is listed but never offered a rule");
});

test("a single-station catchment is held or fully assigned; a rule is created unbound, and only an explicit click binds it to the current revision", () => {
  const env = mount();
  const alpha = () => stationRow(env.container, "Alpha");
  assert.equal(selectIn(alpha(), "alloc-exclusive").value, "hold");
  assert.equal(selectIn(stationRow(env.container, "Beta"), "alloc-exclusive").disabled, true, "Beta has no exclusive node");
  pick(selectIn(alpha(), "alloc-exclusive"), "assign");
  assert.ok(shows(alpha(), "묶이지 않음"));
  click(env.container, "미리보기");
  assert.deepEqual(env.calls.assess[0].policy.rules, [{ ruleId: "exclusive:A", scope: { stationAccessIds: ["A"] }, mode: "assign-all", stationAccessId: "A" }], "no boundTo until the player binds");
  click(alpha(), "현재 revision에 묶기");
  assert.ok(shows(alpha(), "현재 revision에 묶임"));
  click(env.container, "미리보기");
  assert.deepEqual(env.calls.assess[1].policy.rules[0].boundTo, { A: REV.A });
  pick(selectIn(alpha(), "alloc-exclusive"), "hold");
  click(env.container, "미리보기");
  assert.deepEqual(env.calls.assess[2].policy.rules, []);
  assert.equal(env.calls.apply.length, 0);
});

test("the policy sent to the engine has the engine's own schema and explicit defaults; the area-source assumption is opt-in", () => {
  const env = mount();
  click(env.container, "미리보기");
  assert.deepEqual(env.calls.assess[0], {
    policy: { schema: "transitline.station-demand-allocation-policy/1", contractVersion: 1, policyId: "policy:player", defaults: { exclusive: "hold", shared: "hold", areaNodeInclusion: "reject" }, rules: [] },
    walkingPolicy: { walkEstimate: "none", acknowledgedWalkLinkIds: [] },
  });
  const box = areaBox(env.container);
  box.checked = true; box.fire("change");
  click(env.container, "미리보기");
  assert.equal(env.calls.assess[1].policy.defaults.areaNodeInclusion, "centroid");
});

test("an overlapped node takes a 100% station or typed shares; a share is only divided by 100, and a bad one is the engine's to refuse", () => {
  const env = mount();
  const row = () => nodeRow(env.container, "n:both");
  pick(selectIn(row(), "alloc-node-mode"), "assign");
  bindAll(env);
  click(env.container, "미리보기");
  assert.equal(env.calls.assess[0].policy.rules[0].stationAccessId, null, "no station is chosen for the player");
  assert.deepEqual(env.calls.assess[0].policy.rules[0].boundTo, REV, "binding names every claiming station");
  pick(selectIn(row(), "alloc-node-station"), "B");
  click(env.container, "미리보기");
  assert.equal(env.calls.assess[1].policy.rules[0].stationAccessId, "B");
  pick(selectIn(row(), "alloc-node-mode"), "shares");
  assert.equal(sharesInputs(row()).length, 2);
  assert.ok(shows(row(), FRACTIONAL_NOTICE));
  const [a, b] = sharesInputs(row());
  typeInto(a, "60"); typeInto(b, "40");
  click(env.container, "미리보기");
  assert.deepEqual(env.calls.assess[2].policy.rules[0], { ruleId: "node:n:both", scope: { demandNodeIds: ["n:both"] }, mode: "fixed-shares", shares: { A: 0.6, B: 0.4 }, boundTo: REV });
  typeInto(b, "");
  click(env.container, "미리보기");
  assert.deepEqual(env.calls.assess[3].policy.rules[0].shares, { A: 0.6 }, "an empty box is no share, not 0");
  typeInto(b, "abc");
  click(env.container, "미리보기");
  assert.ok(Number.isNaN(env.calls.assess[4].policy.rules[0].shares.B), "passed on as is for the engine to refuse");
  pick(selectIn(row(), "alloc-node-mode"), "none");
  click(env.container, "미리보기");
  assert.deepEqual(env.calls.assess[5].policy.rules, []);
});

test("the engine's policy issues are shown, not re-derived", () => {
  const rejected = previewOf({ policyStatus: "rejected", status: "policy-rejected", allocation: { totals: {}, policyIssues: [{ code: "policy-rule-bound-to-invalid", rule: "node:n:both" }, { code: "policy-shares-exceed-one", rule: "node:n:both" }], rules: [], nodes: [], legacy: {} } });
  const env = mount(spy({ preview: rejected }));
  pick(selectIn(nodeRow(env.container, "n:both"), "alloc-node-mode"), "shares");
  click(env.container, "미리보기");
  assert.ok(shows(env.container, "규칙이 현재 revision에 묶이지 않음"));
  assert.ok(shows(env.container, "비율의 합이 100%를 넘음"));
  assert.ok(shows(env.container, "node:n:both"));
  assert.equal(button(env.container, "정책 적용").disabled, true);
  assert.ok(shows(env.container, "정책을 적용할 수 없음 (rejected)"));
});

test("walking policy: estimate is opt-in, and barrier links come from the engine's preview and are confirmed by id", () => {
  const walking = { nodes: [], links: [
    { walkLinkId: "walk:river", stationAccessId: "A", status: "blocked", usable: false, acknowledgeable: true, acknowledged: false, reasons: ["crosses-river"] },
    { walkLinkId: "walk:fine", stationAccessId: "A", status: "usable", usable: true, acknowledgeable: false, acknowledged: false, reasons: [] },
    { walkLinkId: "walk:gone", stationAccessId: "A", status: "broken", usable: false, acknowledgeable: false, acknowledged: false, reasons: ["endpoint-missing:from"] },
  ] };
  const env = mount(spy({ preview: previewOf({ walking }) }));
  assert.ok(shows(env.container, "미리보기를 실행하면 여기에 나옵니다"));
  pick(walkEstimate(env.container), "straight-line");
  click(env.container, "미리보기");
  assert.equal(env.calls.assess[0].walkingPolicy.walkEstimate, "straight-line");
  const links = () => all(env.container, (n) => n.className === "alloc-check alloc-walk-link");
  assert.equal(links().length, 1, "only a link the player could confirm is offered");
  assert.ok(shows(links()[0], "walk:river") && shows(links()[0], "강을 가로지름"));
  const box = links()[0].children[0];
  box.checked = true; box.fire("change");
  assert.equal(env.calls.assess.length, 1, "ticking does not call the engine");
  assert.equal(links().length, 1, "the list survives the discarded preview");
  click(env.container, "미리보기");
  assert.deepEqual(env.calls.assess[1].walkingPolicy, { walkEstimate: "straight-line", acknowledgedWalkLinkIds: ["walk:river"] });
});

test("any change to the draft discards the preview and disables apply", () => {
  const edits = [
    (env) => pick(selectIn(stationRow(env.container, "Alpha"), "alloc-exclusive"), "assign"),
    (env) => { const box = areaBox(env.container); box.checked = true; box.fire("change"); },
    (env) => pick(walkEstimate(env.container), "straight-line"),
    (env) => pick(selectIn(nodeRow(env.container, "n:both"), "alloc-node-mode"), "shares"),
  ];
  for (const edit of edits) {
    const env = mount();
    click(env.container, "미리보기");
    assert.ok(shows(env.container, PREVIEW_TITLE));
    assert.equal(button(env.container, "정책 적용").disabled, false);
    edit(env);
    assert.equal(shows(env.container, PREVIEW_TITLE), false);
    assert.equal(button(env.container, "정책 적용").disabled, true);
    assert.ok(shows(env.container, "미리보기를 먼저 실행하세요."));
  }
  // typing into a share box (no re-render) and binding do the same
  const env = mount();
  pick(selectIn(nodeRow(env.container, "n:both"), "alloc-node-mode"), "shares");
  click(env.container, "미리보기");
  typeInto(sharesInputs(nodeRow(env.container, "n:both"))[0], "10");
  assert.equal(shows(env.container, PREVIEW_TITLE), false);
  assert.equal(button(env.container, "정책 적용").disabled, true);
  click(env.container, "미리보기");
  bindAll(env);
  assert.equal(shows(env.container, PREVIEW_TITLE), false);
  assert.equal(env.calls.apply.length, 0);
});

test("apply calls only runtime.applyStationDemandAllocation, with exactly the previewed input, then tells the host once", () => {
  const env = mount();
  pick(selectIn(stationRow(env.container, "Alpha"), "alloc-exclusive"), "assign");
  bindAll(env);
  click(env.container, "미리보기");
  assert.deepEqual(env.calls.apply, []);
  click(env.container, "정책 적용");
  assert.equal(env.calls.apply.length, 1);
  assert.deepEqual(env.calls.apply[0], env.calls.assess[0]);
  assert.deepEqual(Object.keys(env.calls.apply[0]).sort(), ["policy", "walkingPolicy"]);
  assert.equal(env.changes.length, 1);
  assert.ok(shows(env.container, "적용됨 · 엔진이 만든 링크 1개"));
  assert.ok(shows(env.container, "n:own → phys:A · 도보 7분"), "the minutes are the engine's own");
  assert.equal(shows(env.container, PREVIEW_TITLE), false);
  assert.equal(env.calls.assess.length, 1);
});

test("fixed shares are preview-only: shown as such, apply stays off, and even a forced click never reaches the engine", () => {
  const fractional = previewOf({
    allocation: { totals: { nodes: 1, assigned: 0, partlyAssigned: 1, held: 0, unknown: 0 }, policyIssues: [], rules: [{ ruleId: "node:n:both", status: "applied", staleStationAccessIds: [], reasons: [] }], legacy: {},
      nodes: [{ demandNodeId: "n:both", decision: "shares", assignments: [{ stationAccessId: "A", share: 0.6 }, { stationAccessId: "B", share: 0.4 }], unallocatedShare: 0, reasons: [] }] },
    blockedLinks: [{ demandNodeId: "n:both", stationAccessId: "A", share: 0.6, code: "fractional-share-not-operational" }, { demandNodeId: "n:both", stationAccessId: "B", share: 0.4, code: "fractional-share-not-operational" }],
  });
  const env = mount(spy({ preview: fractional }));
  pick(selectIn(nodeRow(env.container, "n:both"), "alloc-node-mode"), "shares");
  click(env.container, "미리보기");
  assert.ok(shows(env.container, "분수 배정(미리보기만 가능) 2"));
  assert.ok(shows(env.container, "n:both → A · 60%") && shows(env.container, "n:both → B · 40%"));
  assert.ok(shows(env.container, "n:both → A 60%, B 40%"));
  assert.equal(button(env.container, "정책 적용").disabled, true);
  assert.ok(all(env.container, (n) => n.className === "alloc-note alloc-apply-blocked").some((n) => n.textContent === FRACTIONAL_NOTICE));
  button(env.container, "정책 적용").fire("click");
  assert.equal(env.calls.apply.length, 0);
  assert.equal(env.changes.length, 0);
});

test("a stale preview or an unready one cannot be applied, and the reason is shown", () => {
  for (const [over, reason] of [[{ status: "stale" }, "정책이 오래됨"], [{ policyStatus: "none" }, "정책을 적용할 수 없음 (none)"]]) {
    const env = mount(spy({ preview: previewOf(over) }));
    assert.equal(button(env.container, "정책 적용").disabled, true);
    click(env.container, "미리보기");
    assert.equal(button(env.container, "정책 적용").disabled, true, JSON.stringify(over));
    assert.ok(shows(env.container, reason));
    button(env.container, "정책 적용").fire("click");
    assert.equal(env.calls.apply.length, 0);
  }
});

test("engine errors are shown as given: a failed preview leaves nothing to apply, a failed apply keeps the preview and does not notify the host", () => {
  const bad = mount(spy({ throwOn: { assess: "Apply station demand access facts before allocating demand" } }));
  click(bad.container, "미리보기");
  assert.ok(shows(bad.container, "Apply station demand access facts before allocating demand"));
  assert.equal(button(bad.container, "정책 적용").disabled, true);
  const env = mount(spy({ throwOn: { apply: "Station demand allocation is stale" } }));
  click(env.container, "미리보기");
  click(env.container, "정책 적용");
  assert.ok(shows(env.container, "Station demand allocation is stale"));
  assert.equal(env.changes.length, 0);
  assert.ok(shows(env.container, PREVIEW_TITLE), "the preview stays so the player can see what was asked");
  assert.equal(shows(env.container, "적용됨 ·"), false);
});

test("the preview tells assigned, unallocated, unknown, walk-blocked, no-operating-station and stale apart, each with the engine's reason", () => {
  const out = previewOf({
    links: [{ demandNodeId: "n:a", stationId: "phys:A", walkMinutes: 3 }],
    blockedLinks: [{ demandNodeId: "n:walk", stationAccessId: "A", share: 1, code: "walk-path-unavailable" }, { demandNodeId: "n:nostation", stationAccessId: "B", share: 1, code: "station-not-operational" }, { demandNodeId: "n:two", stationAccessId: "B", share: 1, code: "station-operational-ambiguous" }],
    walking: { links: [], nodes: [{ stationAccessId: "A", demandNodeId: "n:walk", status: "blocked", reasons: ["crosses-building"] }] },
    allocation: { totals: { nodes: 6, assigned: 3, partlyAssigned: 0, held: 2, unknown: 1 }, policyIssues: [], legacy: { overrideRequiredNodeIds: ["n:a"] },
      rules: [{ ruleId: "node:n:held", status: "stale", staleStationAccessIds: ["B"], reasons: ["rule-stale"] }],
      nodes: [
        { demandNodeId: "n:a", decision: "assigned", assignments: [{ stationAccessId: "A", share: 1 }], unallocatedShare: 0, reasons: [] },
        { demandNodeId: "n:walk", decision: "assigned", assignments: [{ stationAccessId: "A", share: 1 }], unallocatedShare: 0, reasons: [] },
        { demandNodeId: "n:held", decision: "held", assignments: [], unallocatedShare: 1, reasons: ["rule-stale"] },
        { demandNodeId: "n:excl", decision: "held", assignments: [], unallocatedShare: 1, reasons: ["exclusive-needs-policy"] },
        { demandNodeId: "n:coarse", decision: "unknown", assignments: [], unallocatedShare: null, reasons: ["demand-source-coarse"] },
      ] },
    status: "stale",
  });
  const env = mount(spy({ preview: out }));
  click(env.container, "미리보기");
  const c = env.container;
  assert.ok(shows(c, "배정 2") && shows(c, "n:a → A 100%"));
  assert.ok(shows(c, "미배정(보류) 2") && shows(c, "n:held · 규칙이 오래됨"));
  assert.ok(shows(c, "단독 접근권이지만 배정하지 않기로 함"));
  assert.ok(shows(c, "미상(배분 불가) 1") && shows(c, "n:coarse · 수요 자료가 시구 단위로 거침"));
  assert.ok(shows(c, "보행 차단·미확인 1") && shows(c, "n:walk → A · 차단 (건물을 가로지름"));
  assert.ok(shows(c, "운행역 미연결 2") && shows(c, "아직 운행역이 없음") && shows(c, "운행역이 둘 이상"));
  assert.ok(shows(c, "오래된 규칙 1") && shows(c, "node:n:held · B"));
  assert.ok(shows(c, "적용하면 생기는 링크 1") && shows(c, "n:a → phys:A · 도보 3분"));
  assert.ok(shows(c, "기존 접근 링크를 대체하는 노드 1개: n:a"));
});

test("an applied allocation is read back: current/stale, the links the engine made, and a changed access drawing both stales it and drops an old preview", () => {
  const report = { status: "current", allocationPolicy: { policyId: "policy:1" }, links: [{ demandNodeId: "n:own", stationId: "phys:A", walkMinutes: 2 }, { demandNodeId: "n:x", stationId: "phys:B", walkMinutes: 5 }], blockedLinks: [{ code: "walk-path-unavailable" }], appliedAtSimMinute: 0 };
  const env = mount(spy({ report }));
  assert.ok(shows(env.container, "생성된 링크") && shows(env.container, "n:x → phys:B · 도보 5분"));
  const metric = (label) => all(env.container, (n) => n.className === "alloc-metric" && n.children[0].textContent === label)[0].children[1].textContent;
  assert.equal(metric("생성된 링크"), "2");
  assert.equal(metric("막힌 링크"), "1");
  assert.equal(metric("적용 시각"), "0분", "a real 0 is shown as 0, not unknown");
  click(env.container, "미리보기");
  assert.ok(shows(env.container, PREVIEW_TITLE));
  env.setApp({ ...application(), applicationId: "access-app:2" });
  env.setReport({ ...report, status: "stale", staleReasons: ["station-demand-access-revision-changed"] });
  env.panel.refresh();
  assert.equal(shows(env.container, PREVIEW_TITLE), false, "a preview of the old drawing is dropped");
  assert.ok(shows(env.container, "오래됨 — 기존 링크는 그대로"));
  assert.ok(shows(env.container, "역 접근권 export가 바뀜"));
  assert.equal(metric("적용 시각"), "0분");
  env.setReport({ ...report, appliedAtSimMinute: null });
  env.panel.refresh();
  assert.equal(metric("적용 시각"), "미상");
  env.setReport(null);
  env.panel.refresh();
  assert.ok(shows(env.container, "아직 적용된 배분이 없습니다"));
});

test("a rule written for an older revision shows as outdated and is not silently re-bound", () => {
  const env = mount();
  pick(selectIn(stationRow(env.container, "Alpha"), "alloc-exclusive"), "assign");
  bindAll(env);
  assert.ok(shows(stationRow(env.container, "Alpha"), "현재 revision에 묶임"));
  const next = application();
  next.assessment.sites[0].stationAccessRevision = "rev:A2";
  env.setApp(next);
  env.panel.refresh();
  assert.ok(shows(stationRow(env.container, "Alpha"), "오래됨 — 다시 묶어야 함"));
  click(env.container, "미리보기");
  assert.deepEqual(env.calls.assess[0].policy.rules[0].boundTo, { A: REV.A }, "the old revision is still what is sent; the engine calls it stale");
  click(stationRow(env.container, "Alpha"), "현재 revision에 묶기");
  assert.ok(shows(stationRow(env.container, "Alpha"), "현재 revision에 묶임"));
  next.assessment.sites = next.assessment.sites.filter((s) => s.stationAccessId !== "A");
  env.panel.refresh();
  assert.equal(stationRow(env.container, "Alpha"), undefined, "a station that left the drawing is no longer offered");
});

test("the draft saves as a canonical document and loads back exactly; a refused document changes nothing and calls nothing", () => {
  const env = mount();
  pick(selectIn(stationRow(env.container, "Alpha"), "alloc-exclusive"), "assign");
  pick(selectIn(nodeRow(env.container, "n:both"), "alloc-node-mode"), "shares");
  const [a, b] = sharesInputs(nodeRow(env.container, "n:both"));
  typeInto(a, "25"); typeInto(b, "75");
  pick(walkEstimate(env.container), "straight-line");
  bindAll(env);
  const saved = env.panel.serialize();
  assert.equal(JSON.parse(saved).schema, STATION_DEMAND_ALLOCATION_DRAFT_SCHEMA);
  assert.equal(env.panel.serialize(), saved, "stable");
  const shuffled = JSON.parse(saved);
  shuffled.rules.reverse();
  assert.equal(serializeAllocationDraft(shuffled), saved, "rule order does not matter");

  const fresh = mount();
  click(fresh.container, "미리보기");
  const assessedBefore = fresh.calls.assess.length;
  assert.deepEqual(fresh.panel.loadDoc(saved), { ok: true, issues: [] });
  assert.equal(shows(fresh.container, PREVIEW_TITLE), false, "loading discards a preview");
  assert.equal(fresh.panel.serialize(), saved);
  assert.equal(selectIn(stationRow(fresh.container, "Alpha"), "alloc-exclusive").value, "assign");
  assert.deepEqual(sharesInputs(nodeRow(fresh.container, "n:both")).map((i) => i.value), ["25", "75"]);
  assert.equal(walkEstimate(fresh.container).value, "straight-line");
  for (const bad of ["{not json", JSON.stringify({ ...shuffled, schema: "x" }), { ...shuffled, rules: [...shuffled.rules, shuffled.rules[0]] }, { ...shuffled, walking: { walkEstimate: "fast", acknowledgedWalkLinkIds: [] } }]) {
    const out = fresh.panel.loadDoc(bad);
    assert.equal(out.ok, false);
    assert.ok(out.issues.length > 0);
    assert.equal(fresh.panel.serialize(), saved, "the current draft is untouched");
  }
  assert.equal(fresh.calls.assess.length, assessedBefore, "loading never asks the engine");
  assert.equal(fresh.calls.apply.length, 0);
  const copy = fresh.panel.document;
  copy.rules.length = 0;
  assert.equal(fresh.panel.serialize(), saved, "the returned document is a copy");
});

test("draft documents are validated whole: any issue refuses it", () => {
  const good = newAllocationDraft("policy:1");
  assert.deepEqual(restoreAllocationDraft(good).issues, []);
  assert.deepEqual(restoreAllocationDraft("nope").issues, ["draft-unreadable"]);
  assert.deepEqual(restoreAllocationDraft({ ...good, version: 2 }).issues, ["draft-schema-invalid"]);
  assert.deepEqual(restoreAllocationDraft({ ...good, policyId: "" }).issues, ["draft-policy-id-invalid"]);
  assert.deepEqual(restoreAllocationDraft({ ...good, areaNodeInclusion: "maybe" }).issues, ["draft-area-inclusion-invalid"]);
  assert.deepEqual(restoreAllocationDraft({ ...good, rules: [{ ruleId: "r", kind: "mystery", boundTo: null }] }).issues, ["draft-rule-invalid:r"]);
  assert.deepEqual(restoreAllocationDraft({ ...good, rules: [{ ruleId: "r", kind: "node-shares", demandNodeId: "n", shares: { A: {} }, boundTo: null }] }).issues, ["draft-rule-invalid:r"]);
  assert.deepEqual(restoreAllocationDraft({ ...good, rules: [{ ruleId: "r", kind: "station-exclusive", stationAccessId: "A", boundTo: { A: 3 } }] }).issues, ["draft-rule-invalid:r"]);
  const twice = { ruleId: "r", kind: "station-exclusive", stationAccessId: "A", boundTo: null };
  assert.deepEqual(restoreAllocationDraft({ ...good, rules: [twice, twice] }).issues, ["draft-rule-id-duplicate:r"]);
  assert.throws(() => serializeAllocationDraft({ ...good, version: 2 }), /not valid/);
  const policy = buildStationDemandPolicy({ ...good, rules: [{ ruleId: "node:n", kind: "node-shares", demandNodeId: "n", shares: { A: "0.5", B: " 50 " }, boundTo: { A: "x" } }] });
  assert.deepEqual(policy.rules[0].shares, { A: 0.005, B: 0.5 }, "the box is a percent: 0.5 is half a percent");
  assert.deepEqual(buildStationDemandWalkingPolicy(good), { walkEstimate: "none", acknowledgedWalkLinkIds: [] });
});

test("nothing is stored by the panel and the screen carries no money, time or demand it computed itself", () => {
  const writes = [];
  const had = ["localStorage", "sessionStorage"].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  const guard = { getItem: () => null, setItem: (k) => writes.push(k), removeItem: (k) => writes.push(k) };
  for (const [name] of had) Object.defineProperty(globalThis, name, { configurable: true, value: guard });
  let shown;
  try {
    const env = mount(spy({ preview: previewOf({ links: [{ demandNodeId: "n:own", stationId: "phys:A", walkMinutes: 11 }] }) }));
    pick(selectIn(stationRow(env.container, "Alpha"), "alloc-exclusive"), "assign");
    bindAll(env);
    click(env.container, "미리보기");
    click(env.container, "정책 적용");
    shown = texts(env.container).join("\n");
  } finally {
    for (const [name, descriptor] of had) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; }
  }
  assert.deepEqual(writes, []);
  assert.equal(/[￥¥]|JPY|운임|혼잡|소요|예상|승객 수/.test(shown.replace(SCOPE_NOTICE, "")), false);
  const source = fs.readFileSync(fileURLToPath(new URL("../src/station-demand-allocation-management-ui.mjs", import.meta.url)), "utf8").replace(/\/\/.*$/gm, "");
  assert.equal(/localStorage|sessionStorage|Math\.random|Date\.now|new Date|innerHTML|insertAdjacentHTML/.test(source), false);
  assert.deepEqual([...source.matchAll(/^import .* from "(.+)";$/gm)].map((m) => m[1]), ["./station-demand-allocation-policy.mjs"]);
  assert.deepEqual([...new Set([...source.matchAll(/runtime\??\.(\w+)/g)].map((m) => m[1]))].sort(), ["applyStationDemandAllocation", "assessStationDemandAllocation", "stationDemandAccessReport", "stationDemandAllocationReport"]);
});

test("mount refuses a missing container or an incomplete runtime", () => {
  assert.throws(() => mountStationDemandAllocationManagementPanel({ runtime: spy().runtime }), /container/);
  assert.throws(() => mountStationDemandAllocationManagementPanel({ container: newContainer(), runtime: {} }), /stationDemandAccessReport/);
  const { runtime } = spy();
  delete runtime.applyStationDemandAllocation;
  assert.throws(() => mountStationDemandAllocationManagementPanel({ container: newContainer(), runtime }), /applyStationDemandAllocation/);
});

// --- end to end against the real ScenarioRuntime ---
const PACK_ID = "allocation-ui";
const pack = () => ({ manifest: { id: PACK_ID, version: "1", data: { license: "CC0-1.0", attribution: [] } }, demand: { model: "gravity", points: [
  { id: "node:a", location: [139, 35], residents: 100, jobs: 20 },
  { id: "node:b", location: [139.03, 35], residents: 70, jobs: 40 },
  { id: "node:c", location: [139.06, 35], residents: 30, jobs: 10 },
], attractors: [] } });
function site(letter, revision, nodeIds, nodeAt) {
  const stationAccessId = `access:${letter}`;
  const base = letter === "a" ? 139.01 : 139.04;
  return {
    schema: "transitline.station-demand-access-geometry/1", contractVersion: 1, stationAccessId, stationAccessRevision: revision, sourcePackId: PACK_ID, sourcePackVersion: "1", name: `Station ${letter.toUpperCase()}`,
    location: [base, 35], connectedPlanId: `plan:${letter}`, connectedStationId: `source:${letter}`, connectedNetworkId: `plan:${letter}`,
    demandSourceRefs: [{ sourceId: "demand", kind: "demand-points", quality: "medium", spatialResolution: "individual-demand-node" }],
    entrances: [], accessPoints: [], catchments: [{ catchmentId: `catch:${letter}`, demandNodeIdsInside: nodeIds }],
    demandZones: [{ demandZoneId: `zone:${letter}`, centroid: [base + 0.01, 35], demandNodeRefs: nodeIds.map((id) => ({ demandNodeId: id, location: nodeAt[id] })), drawnConnection: { connected: true } }],
    walkLinks: [{ walkLinkId: `walk:${letter}`, from: { kind: "station", id: stationAccessId }, to: { kind: "demand-zone", id: `zone:${letter}` }, alignment: [[base, 35], [base + 0.01, 35]], lengthMeters: 80, crossings: { river: 0, railway: 0, building: 0 }, unknownReasons: {} }],
    transfers: [],
  };
}
const at = { "node:a": [139.02, 35], "node:b": [139.05, 35], "node:c": [139.011, 35] };
// node:a is claimed by both stations, node:c only by A, node:b only by B
const accessExport = (revA = "access:a:r1") => ({ schema: "transitline.station-demand-access-export/1", contractVersion: 1, packId: PACK_ID, packVersion: "1", catchmentOverlaps: [], inactive: [], warnings: [],
  sites: [site("a", revA, ["node:a", "node:c"], at), site("b", "access:b:r1", ["node:a", "node:b"], at)] });
function world() {
  const state = createState(pack());
  state.stations.set("physical:a", { id: "physical:a", sourceStationId: "source:a", location: [139.01, 35], status: "available" });
  state.stations.set("physical:b", { id: "physical:b", sourceStationId: "source:b", location: [139.04, 35], status: "available" });
  const runtime = new ScenarioRuntime({ pack: pack(), operationalState: state, networkMode: "scratch", seed: 3 });
  const calls = { assess: 0, apply: 0 };
  const watched = {
    stationDemandAccessReport: () => runtime.stationDemandAccessReport(),
    stationDemandAllocationReport: () => runtime.stationDemandAllocationReport(),
    assessStationDemandAllocation: (i) => { calls.assess += 1; return runtime.assessStationDemandAllocation(i); },
    applyStationDemandAllocation: (i) => { calls.apply += 1; return runtime.applyStationDemandAllocation(i); },
  };
  return { state, runtime, calls, watched };
}

test("real runtime: no access facts, then facts; write, bind, preview and apply a policy; the engine makes the links and the panel reads them back", () => {
  const w = world();
  const env = mount({ runtime: w.watched, calls: {} });
  assert.ok(shows(env.container, "역 접근권 사실이 아직 엔진에 없습니다"));
  assert.equal(buttons(env.container).length, 0);
  assert.deepEqual([w.calls.assess, w.calls.apply], [0, 0]);

  w.runtime.applyStationDemandAccess(accessExport());
  env.panel.refresh();
  assert.ok(shows(env.container, "Station A") && shows(env.container, "Station B"));
  assert.ok(nodeRow(env.container, "node:a"), "the node both stations claim is offered");
  assert.equal(nodeRow(env.container, "node:c"), undefined);
  const before = snapshotOperationalState(w.state);

  pick(selectIn(stationRow(env.container, "Station A"), "alloc-exclusive"), "assign");
  pick(selectIn(nodeRow(env.container, "node:a"), "alloc-node-mode"), "assign");
  pick(selectIn(nodeRow(env.container, "node:a"), "alloc-node-station"), "access:a");
  click(env.container, "미리보기"); // unbound: the engine refuses the policy, and the panel shows why
  assert.ok(shows(env.container, "규칙이 현재 revision에 묶이지 않음"));
  assert.equal(button(env.container, "정책 적용").disabled, true);
  bindAll(env);
  click(env.container, "미리보기");
  assert.ok(shows(env.container, PREVIEW_TITLE));
  assert.ok(shows(env.container, "node:a → access:a 100%") && shows(env.container, "node:c → access:a 100%"));
  assert.ok(shows(env.container, "미배정(보류) 1") && shows(env.container, "node:b"), "Station B was left on hold");
  assert.deepEqual(snapshotOperationalState(w.state), before, "previews and edits changed nothing in the engine");
  assert.equal(w.calls.apply, 0);

  click(env.container, "정책 적용");
  assert.equal(w.calls.apply, 1);
  assert.equal(env.changes.length, 1);
  assert.equal(w.state.stationDemandAllocationLinks.length, 2);
  assert.ok(shows(env.container, "적용됨 · 엔진이 만든 링크 2개"));
  for (const link of w.runtime.stationDemandAllocationReport().links) assert.ok(shows(env.container, `${link.demandNodeId} → ${link.stationId} · 도보 ${link.walkMinutes}분`));
  const metric = (label) => all(env.container, (n) => n.className === "alloc-metric" && n.children[0].textContent === label)[0].children[1].textContent;
  assert.equal(metric("상태"), "현재");
  assert.equal(metric("생성된 링크"), "2");

  // the map's drawing changes: the stored allocation is stale, its links stay, and the rule shows as outdated until re-bound
  w.runtime.applyStationDemandAccess(accessExport("access:a:r2"));
  env.panel.refresh();
  assert.equal(metric("상태"), "오래됨");
  assert.ok(shows(env.container, "기존 링크는 그대로"));
  assert.equal(w.state.stationDemandAllocationLinks.length, 2);
  assert.ok(shows(stationRow(env.container, "Station A"), "오래됨 — 다시 묶어야 함"));
  click(env.container, "미리보기");
  assert.ok(shows(env.container, "오래된 규칙") && shows(env.container, "node:a"));
  assert.equal(button(env.container, "정책 적용").disabled, true);
  assert.ok(shows(env.container, "정책이 오래됨"));
  bindAll(env);
  click(env.container, "미리보기");
  assert.equal(button(env.container, "정책 적용").disabled, false, "re-binding is an explicit act and makes the policy current again");
  assert.equal(w.calls.apply, 1);
});

test("real runtime: fixed shares preview but cannot be applied, and the engine is never asked to", () => {
  const w = world();
  w.runtime.applyStationDemandAccess(accessExport());
  const env = mount({ runtime: w.watched, calls: {} });
  pick(selectIn(nodeRow(env.container, "node:a"), "alloc-node-mode"), "shares");
  const [a, b] = sharesInputs(nodeRow(env.container, "node:a"));
  typeInto(a, "60"); typeInto(b, "40");
  bindAll(env);
  const before = snapshotOperationalState(w.state);
  click(env.container, "미리보기");
  assert.ok(shows(env.container, "node:a → access:a 60%, access:b 40%"));
  assert.ok(shows(env.container, "분수 배정(미리보기만 가능)"));
  assert.equal(button(env.container, "정책 적용").disabled, true);
  button(env.container, "정책 적용").fire("click");
  assert.equal(w.calls.apply, 0);
  assert.deepEqual(snapshotOperationalState(w.state), before);
  // 80 + 80 is the engine's rejection to report, not the panel's
  typeInto(a, "80"); typeInto(b, "80");
  click(env.container, "미리보기");
  assert.ok(shows(env.container, "비율의 합이 100%를 넘음"));
  assert.equal(button(env.container, "정책 적용").disabled, true);
});

test("real runtime: a saved draft restores into a new panel and previews the same policy", () => {
  const w = world();
  w.runtime.applyStationDemandAccess(accessExport());
  const first = mount({ runtime: w.watched, calls: {} });
  pick(selectIn(stationRow(first.container, "Station A"), "alloc-exclusive"), "assign");
  bindAll(first);
  click(first.container, "미리보기");
  const hostSaved = JSON.parse(JSON.stringify(first.panel.serialize())); // what a host's integrated save would hand back
  const second = mount({ runtime: w.watched, calls: {} });
  assert.equal(second.panel.loadDoc(hostSaved).ok, true);
  assert.ok(shows(stationRow(second.container, "Station A"), "현재 revision에 묶임"));
  click(second.container, "미리보기");
  assert.ok(shows(second.container, "node:c → access:a 100%"));
  assert.equal(button(second.container, "정책 적용").disabled, false);
  assert.equal(w.calls.apply, 0);
});
