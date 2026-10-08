import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  RAILWAY_TIMETABLE_LIFECYCLE_DOC_SCHEMA, SCOPE_NOTICE, STALE_NOTICE, digestOf, mountRailwayTimetableLifecyclePanel, newLifecycleDoc, restoreLifecycleDoc, serializeLifecycleDoc,
} from "../src/railway-timetable-lifecycle-ui.mjs";
import { snapshotOperationalState } from "../src/integrated-save.mjs";
import { ScenarioRuntime } from "../src/scenario-runtime.mjs";
import { addLine, addPhysicalStation, addTrackSegment, createState } from "../src/state.mjs";

// --- a minimal DOM: elements, listeners, replaceChildren ---
class Node_ {
  constructor(tag) { Object.assign(this, { tag, children: [], className: "", textContent: "", value: "", checked: false, disabled: false, listeners: {} }); }
  append(...kids) { this.children.push(...kids); }
  replaceChildren(...kids) { this.children = []; this.append(...kids); }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  fire(type) { for (const fn of this.listeners[type] ?? []) fn({ type }); }
}
const dom = { createElement: (tag) => new Node_(tag) };
const newContainer = () => Object.assign(new Node_("div"), { ownerDocument: dom });
const all = (node, pred = () => true) => [pred(node) ? node : null, ...node.children.flatMap((c) => all(c, pred))].filter(Boolean);
const texts = (node) => all(node).map((n) => n.textContent).filter(Boolean);
const shows = (node, part) => texts(node).some((t) => t.includes(part));
const classes = (node) => String(node.className).split(" ");
const cardOf = (container, id = "map-plan:1") => all(container, (n) => classes(n).includes("ttlife-card")).find((card) => all(card, (n) => classes(n).includes("ttlife-id-plan"))[0].children[1].textContent === id);
const btn = (container, kind, id = "map-plan:1") => all(cardOf(container, id), (n) => n.tag === "button" && classes(n).includes(`ttlife-${kind}`))[0];
// a click as the browser would deliver it: a disabled button gets nothing
const click = (container, kind, id) => { const b = btn(container, kind, id); if (!b.disabled) b.fire("click"); };
// a click that gets through even though the button was disabled (what a stale page could do): the panel must refuse by itself
const forceClick = (container, kind, id) => btn(container, kind, id).fire("click");
const deepFreeze = (o) => { if (o && typeof o === "object") { Object.values(o).forEach(deepFreeze); Object.freeze(o); } return o; };

// --- the world: the same real engine setup the E2 integration test uses ---
const SPEC = { runningSystemId: "steel-wheel", gaugeMm: 1435, carWidthM: 2.9, maxAxleLoadTonnes: 16, collectionSystemId: "overhead", currentSystem: "dc", voltageV: 1500, minimumCurveRadiusMeters: 200, maxGradientPermille: 30, signalSystemIds: ["ats-p"], platformHeightMm: 1100, doorLayoutId: "4-door-20m", minCars: 4, maxCars: 10, maintenanceSystemId: "medium_steel" };
const PACK = { manifest: { id: "timetable-lifecycle", version: "1", data: { license: "test", attribution: [] } }, demand: { model: "gravity", points: [], attractors: [] } };
function world() {
  const state = createState(PACK);
  addPhysicalStation(state, { id: "A", location: [139, 35], status: "available" });
  addPhysicalStation(state, { id: "B", location: [139.01, 35], status: "available" });
  addTrackSegment(state, { id: "ab", fromStationId: "A", toStationId: "B", lengthMeters: 1000, status: "available", directionMode: "double", minimumHeadwayMinutes: 3, capacityTrainsPerHour: 20 });
  const line = addLine(state, ["A", "B"]); line.trackSegmentIds = ["ab"]; line.managementServiceId = "service:actual"; line.suspended = false;
  state.railCapacityApplications = [{ operationalLineId: line.id, railGeometryId: "geometry:1", railGeometryRevision: "revision:1", sections: [{ trackSegmentId: "ab", railCapacitySectionId: "section:ab", directionMode: "double", blockIds: [], junctionResourceIds: [] }], junctions: [], terminals: [{ terminalResourceId: "terminal:B", stationId: "B", platformCandidates: [], turnbackCandidates: [{ turnbackCandidateId: "turnback:B", attached: true }] }] }];
  const runtime = new ScenarioRuntime({ pack: PACK, operationalState: state });
  runtime.game.services.push({ id: "service:actual", operationalLineId: line.id, commercialSpeedKph: 30, operatorId: "player", status: "open" });
  const plan = {
    schema: "transitline.service-plan-geometry/1", contractVersion: 1, servicePlanId: "map-plan:1", servicePlanRevision: "map-revision:1", name: "Morning plan", active: true,
    revision: { state: "current" }, capacityApplicationState: "current", capacityApplicationRevision: "revision:1", operationalLineId: String(line.id), playerInputs: { operatingPattern: "full" },
    route: { sections: [{ trackSegmentId: "ab", traversal: "forward" }] }, spatialFacts: { sections: [{ junctionResourceIds: [] }] },
    directions: [{ key: "out", fromStationId: "A", toStationId: "B", physicalConnection: true }, { key: "back", fromStationId: "B", toStationId: "A", physicalConnection: true }],
    serviceBands: [{ bandId: "band:1", operating: true, startMinute: 360, endMinute: 420, playerRequestedHeadwayMinutes: 10, playerRequestedTrainsets: 2, directionKeys: ["out", "back"] }],
    turnbacks: [{ stationId: "B", terminalResourceId: "terminal:B", turnbackCandidateId: "turnback:B" }], vehicleIntent: { vehicleModelId: "medium_4car", requestedTrainsets: 2 },
  };
  const input = { technicalSpecs: { [line.id]: { technicalSpecification: SPEC, capacityTrainsPerHour: 20 } }, vehicleOrders: [{ modelId: "medium_4car", stage: "accepted", quantity: 2, units: [{ id: "set:1", status: "available" }, { id: "set:2", status: "available" }] }], operatingResourcePools: [], infrastructureAssumptions: { directionMode: "double", minimumHeadwayMinutes: 3 } };
  return { state, line, runtime, plan, input };
}
const withBand = (plan, over) => ({ ...plan, serviceBands: [{ ...plan.serviceBands[0], ...over }] });

// The panel gets the real runtime through a wrapper that counts every call and can be told to fail.
function mount(w = world(), over = {}) {
  const calls = { assess: 0, approve: 0, activate: 0, report: 0, assessArgs: [] };
  const fail = {};
  const rt = w.runtime;
  const wrapped = {
    assessServicePlanTimetable: (...args) => { calls.assess += 1; calls.assessArgs.push(args); hold.duringEngine?.(); if (fail.assess) throw new Error(fail.assess); return rt.assessServicePlanTimetable(...args); },
    approveRailwayTimetable: (id) => { calls.approve += 1; hold.duringEngine?.(); if (fail.approve) throw new Error(fail.approve); return rt.approveRailwayTimetable(id); },
    activateRailwayTimetable: (id) => { calls.activate += 1; if (fail.activate) throw new Error(fail.activate); return rt.activateRailwayTimetable(id); },
    railwayTimetableReport: (id) => { calls.report += 1; return rt.railwayTimetableReport(id); },
  };
  const hold = { plans: [w.plan], bindings: [{ servicePlanId: "map-plan:1", serviceId: "service:actual" }], input: w.input, inputCalls: [] };
  const container = newContainer();
  const changes = [];
  const panel = mountRailwayTimetableLifecyclePanel({
    container, runtime: wrapped, getServicePlans: () => hold.plans, getBindings: () => hold.bindings,
    getAssessmentInput: (plan, binding) => { hold.inputCalls.push([plan, binding]); if (hold.inputError) throw new Error(hold.inputError); return hold.input; },
    onChange: () => { changes.push(1); hold.onChange?.(); }, ...over,
  });
  return { w, container, panel, calls, fail, hold, changes, wrapped };
}
const timetables = (env) => env.w.runtime.railwayTimetableReport();
const engineState = (w) => JSON.stringify({ game: w.runtime.game.snapshot(), op: snapshotOperationalState(w.state) });
function assessed(env) { click(env.container, "assess"); return env; }
function approved(env) { assessed(env); click(env.container, "approve"); return env; }

test("mounting needs a container, the three getters and a runtime that has the four timetable methods", () => {
  const w = world();
  const ok = { container: newContainer(), runtime: w.runtime, getServicePlans: () => [], getBindings: () => [], getAssessmentInput: () => ({}) };
  assert.doesNotThrow(() => mountRailwayTimetableLifecyclePanel(ok));
  assert.throws(() => mountRailwayTimetableLifecyclePanel({ ...ok, container: null }), /container/);
  for (const name of ["getServicePlans", "getBindings", "getAssessmentInput"]) assert.throws(() => mountRailwayTimetableLifecyclePanel({ ...ok, [name]: null }), new RegExp(name));
  for (const method of ["assessServicePlanTimetable", "approveRailwayTimetable", "activateRailwayTimetable", "railwayTimetableReport"]) {
    const runtime = { assessServicePlanTimetable() {}, approveRailwayTimetable() {}, activateRailwayTimetable() {}, railwayTimetableReport: () => [], [method]: undefined };
    assert.throws(() => mountRailwayTimetableLifecyclePanel({ ...ok, runtime }), new RegExp(method));
  }
});

test("mounting, refreshing and loading a document run no engine command: only the report is read, and nothing changes", () => {
  const w = world();
  const before = engineState(w);
  const env = mount(w);
  env.panel.refresh(); env.panel.refresh();
  env.panel.loadDoc(env.panel.serialize());
  assert.deepEqual([env.calls.assess, env.calls.approve, env.calls.activate], [0, 0, 0]);
  assert.deepEqual(env.changes, []);
  assert.equal(engineState(w), before);
  assert.ok(shows(env.container, SCOPE_NOTICE));
});

test("a plan with no connected service cannot be assessed; a click that gets through anyway reaches no engine call", () => {
  const env = mount();
  env.hold.bindings = [];
  env.panel.refresh();
  assert.equal(btn(env.container, "assess").disabled, true);
  assert.ok(shows(env.container, "개통 서비스에 연결되지 않았습니다"));
  assert.ok(shows(env.container, "연결 안 됨"));
  forceClick(env.container, "assess");
  assert.equal(env.calls.assess, 0);
  assert.equal(timetables(env).length, 0);
});

test("the two ids are shown as different kinds of id", () => {
  const env = mount();
  const card = cardOf(env.container);
  assert.deepEqual(texts(all(card, (n) => classes(n).includes("ttlife-id-plan"))[0]), ["지도 계획 ID (설계 문서)", "map-plan:1"]);
  assert.deepEqual(texts(all(card, (n) => classes(n).includes("ttlife-id-service"))[0]), ["개통 서비스 ID (경영 서비스)", "service:actual"]);
});

test("assess -> approve -> activate against the real runtime: one engine call per click, in order, each step shown from the engine's own record", () => {
  const env = mount();
  const row = () => env.panel.results()[0];
  assert.deepEqual([row().canAssess, row().canApprove, row().canActivate], [true, false, false]);
  assert.deepEqual([btn(env.container, "approve").disabled, btn(env.container, "activate").disabled], [true, true]);

  click(env.container, "assess");
  assert.equal(env.calls.assess, 1);
  const stored = timetables(env);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].status, "assessed");
  assert.equal(row().timetableId, stored[0].id);
  assert.equal(row().verdict, stored[0].assessment.verdict);
  assert.equal(row().acceptedPaths, stored[0].acceptedPaths.length);
  assert.equal(row().rejectedPaths, stored[0].rejectedPaths.length);
  assert.ok(stored[0].acceptedPaths.length > 0);
  assert.ok(shows(env.container, "엔진 상태: 심사됨 (assessed)"));
  assert.ok(shows(env.container, `(${stored[0].assessment.verdict})`));
  for (const path of stored[0].acceptedPaths.slice(0, 3)) assert.ok(shows(env.container, path.pathId));
  assert.deepEqual([row().canAssess, row().canApprove, row().canActivate], [false, true, false]);
  assert.equal(env.calls.approve + env.calls.activate, 0, "assessing does not approve");

  click(env.container, "approve");
  assert.equal(env.calls.approve, 1);
  assert.equal(timetables(env)[0].status, "approved");
  assert.ok(shows(env.container, "엔진 상태: 승인됨 (approved)"));
  assert.deepEqual([row().canApprove, row().canActivate], [false, true]);
  assert.equal(env.calls.activate, 0, "approving does not activate");
  assert.equal(env.w.runtime.game.services[0].activeTimetableId, undefined);

  click(env.container, "activate");
  assert.equal(env.calls.activate, 1);
  assert.equal(timetables(env)[0].status, "active");
  assert.equal(env.w.runtime.game.services[0].activeTimetableId, stored[0].id);
  assert.ok(shows(env.container, "엔진 상태: 개통됨(활성) (active)"));
  assert.deepEqual([row().canAssess, row().canApprove, row().canActivate], [false, false, false]);
  assert.equal(env.changes.length, 3);
  assert.deepEqual([env.calls.assess, env.calls.approve, env.calls.activate], [1, 1, 1]);
});

test("the assess call gets the plan, the binding and the host's input exactly as the host gave them; the panel adds nothing to the input", () => {
  const env = mount();
  click(env.container, "assess");
  const [plan, binding, input] = env.calls.assessArgs[0];
  assert.deepEqual(plan, env.w.plan);
  assert.deepEqual(binding, { servicePlanId: "map-plan:1", serviceId: "service:actual" });
  assert.deepEqual(input, env.w.input);
  assert.notEqual(input, env.w.input, "the engine gets a copy, never the host's object");
  assert.deepEqual(env.hold.inputCalls[0][1], { servicePlanId: "map-plan:1", serviceId: "service:actual" });
  env.hold.input = "not an object";
  env.panel.refresh();
  assert.ok(shows(env.container, "getAssessmentInput() must return an object"));
  assert.equal(btn(env.container, "assess").disabled, true);
});

test("steps cannot be skipped: approve before assess and activate before approve reach no engine call", () => {
  const env = mount();
  forceClick(env.container, "approve");
  forceClick(env.container, "activate");
  assert.deepEqual([env.calls.approve, env.calls.activate], [0, 0]);
  click(env.container, "assess");
  forceClick(env.container, "activate");
  assert.equal(env.calls.activate, 0);
  assert.equal(timetables(env)[0].status, "assessed");
  assert.ok(shows(env.container, "이 단계는 지금 실행할 수 없습니다"));
});

test("an assessment the engine does not rate possible is shown with its rejected paths, and the engine refuses to approve it", () => {
  const w = world();
  w.plan = withBand(w.plan, { playerRequestedHeadwayMinutes: 1 });
  const env = mount(w);
  click(env.container, "assess");
  const stored = timetables(env)[0];
  assert.notEqual(stored.assessment.verdict, "possible");
  assert.ok(stored.rejectedPaths.length > 0);
  for (const rejected of stored.rejectedPaths.slice(0, 3)) {
    assert.ok(shows(env.container, `${rejected.pathId} · ${rejected.reason}`), rejected.pathId);
    if (rejected.conflictPathId) assert.ok(shows(env.container, `충돌 경로 ${rejected.conflictPathId}`));
  }
  for (const violation of stored.assessment.violations.slice(0, 3)) assert.ok(shows(env.container, `위반: ${violation}`));
  assert.ok(shows(env.container, `(${stored.assessment.verdict})`));
  const before = engineState(w);
  assert.equal(btn(env.container, "approve").disabled, false, "the panel does not pre-judge: the engine decides");
  click(env.container, "approve");
  assert.equal(env.calls.approve, 1);
  assert.ok(shows(env.container, `Railway timetable assessment is ${stored.assessment.verdict}`));
  assert.equal(timetables(env)[0].status, "assessed");
  assert.equal(engineState(w), before, "a refused approval changes nothing");
  assert.equal(env.calls.activate, 0);
  assert.equal(btn(env.container, "activate").disabled, true);
});

test("when the engine makes no timetable (C1 refuses), its reasons are shown and no timetable record appears", () => {
  const w = world();
  w.plan = { ...w.plan, revision: { state: "stale" }, playerInputs: { operatingPattern: "short-turn" } };
  const env = mount(w);
  const before = engineState(w);
  click(env.container, "assess");
  assert.equal(env.calls.assess, 1);
  assert.equal(timetables(env).length, 0);
  assert.equal(engineState(w), before);
  assert.equal(env.panel.results()[0].timetableId, null);
  assert.ok(shows(env.container, "엔진이 시간표를 만들지 않았습니다"));
  assert.ok(shows(env.container, "map-revision-stale"));
  assert.ok(shows(env.container, "전체 노선 운행이 아님 — 단축 운행"));
  assert.ok(shows(env.container, "시간표 변환 확인(C1): blocked"));
  assert.deepEqual(env.changes, []);
  assert.equal(btn(env.container, "assess").disabled, false, "it can be tried again once the cause is fixed");
});

test("an assessment goes stale when the map plan, the binding or the input changes: details are hidden, approve and activate are blocked", () => {
  for (const [name, change, reason] of [
    ["plan", (env) => { env.hold.plans = [withBand(env.w.plan, { playerRequestedHeadwayMinutes: 12 })]; }, "plan-changed"],
    ["map revision", (env) => { env.hold.plans = [{ ...env.w.plan, revision: { state: "stale" } }]; }, "plan-changed"],
    ["capacity application", (env) => { env.hold.plans = [{ ...env.w.plan, capacityApplicationState: "stale" }]; }, "plan-changed"],
    ["binding changed", (env) => { env.hold.bindings = [{ servicePlanId: "map-plan:1", serviceId: "service:other" }]; }, "binding-changed"],
    ["binding removed", (env) => { env.hold.bindings = []; }, "binding-missing"],
    ["input", (env) => { env.hold.input = { ...env.w.input, vehicleOrders: [] }; }, "input-changed"],
  ]) {
    const env = assessed(mount());
    assert.equal(env.panel.results()[0].stale, false, name);
    change(env);
    env.panel.refresh();
    const stale = env.panel.results()[0];
    assert.equal(stale.stale, true, name);
    assert.ok(stale.staleReasons.includes(reason), `${name}: ${stale.staleReasons}`);
    assert.equal(stale.acceptedPaths, null, "the old paths are not reported");
    assert.equal(stale.verdict, null);
    const card = cardOf(env.container);
    assert.ok(shows(card, "낡은 심사 — 승인·개통 불가"), name);
    assert.ok(shows(card, STALE_NOTICE), name);
    assert.ok(!shows(card, "수용된 경로"), `${name}: old paths hidden`);
    assert.ok(!shows(card, "엔진 판정"), `${name}: old verdict hidden`);
    assert.equal(btn(env.container, "approve").disabled, true, name);
    assert.equal(btn(env.container, "activate").disabled, true, name);
    forceClick(env.container, "approve");
    forceClick(env.container, "activate");
    assert.deepEqual([env.calls.approve, env.calls.activate], [0, 0], name);
    assert.equal(timetables(env)[0].status, "assessed", name);
  }
});

test("a plan that disappears from the map leaves a stale record that is kept and listed", () => {
  const env = assessed(mount());
  const id = timetables(env)[0].id;
  env.hold.plans = [];
  env.panel.refresh();
  assert.ok(shows(env.container, "지도에 없는 계획의 심사 기록 1개"));
  assert.deepEqual(env.panel.document.entries.map((e) => e.timetableId), [id]);
  assert.deepEqual(env.panel.results(), []);
});

test("an approved timetable whose premises then change cannot be activated, and a new assessment replaces the stale record", () => {
  const env = approved(mount());
  assert.equal(timetables(env)[0].status, "approved");
  env.hold.plans = [withBand(env.w.plan, { playerRequestedHeadwayMinutes: 15 })];
  env.panel.refresh();
  assert.equal(env.panel.results()[0].canActivate, false);
  forceClick(env.container, "activate");
  assert.equal(env.calls.activate, 0);
  assert.equal(timetables(env)[0].status, "approved");
  assert.equal(btn(env.container, "assess").disabled, false);
  click(env.container, "assess");
  assert.equal(env.calls.assess, 2);
  assert.equal(timetables(env).length, 2);
  const row = env.panel.results()[0];
  assert.equal(row.stale, false);
  assert.equal(row.timetableId, timetables(env)[1].id);
  assert.equal(row.engineStatus, "assessed");
  assert.deepEqual(env.panel.document.entries.map((e) => e.timetableId), [timetables(env)[1].id]);
});

test("an input the host cannot give makes the assessment stale and blocks a new one; getting it back restores the assessment", () => {
  const env = assessed(mount());
  env.hold.inputError = "technical specs offline";
  env.panel.refresh();
  const row = env.panel.results()[0];
  assert.ok(row.staleReasons.includes("input-unavailable"));
  assert.deepEqual([row.canAssess, row.canApprove], [false, false]);
  assert.ok(shows(env.container, "심사 전제 입력을 읽을 수 없음: technical specs offline"));
  forceClick(env.container, "assess");
  assert.equal(env.calls.assess, 1);
  delete env.hold.inputError;
  env.panel.refresh();
  assert.equal(env.panel.results()[0].stale, false);
  assert.equal(env.panel.results()[0].canApprove, true);
});

test("a double click or a click made from inside the engine call runs the step once", () => {
  const env = mount();
  const button = btn(env.container, "assess");
  button.fire("click"); button.fire("click");
  assert.equal(env.calls.assess, 1);
  assert.equal(timetables(env).length, 1);
  const approve = btn(env.container, "approve");
  approve.fire("click"); approve.fire("click");
  assert.equal(env.calls.approve, 1);
  const activate = btn(env.container, "activate");
  activate.fire("click"); activate.fire("click");
  assert.equal(env.calls.activate, 1);
  assert.equal(env.changes.length, 3);

  // a second click that arrives while the engine is still working on the first (before any record exists) is ignored
  const again = mount();
  again.hold.duringEngine = () => { again.hold.duringEngine = null; forceClick(again.container, "assess"); };
  click(again.container, "assess");
  assert.equal(again.calls.assess, 1);
  assert.equal(timetables(again).length, 1);
  const second = assessed(mount());
  second.hold.duringEngine = () => { second.hold.duringEngine = null; forceClick(second.container, "approve"); };
  click(second.container, "approve");
  assert.equal(second.calls.approve, 1, "approve clicked again from inside the approve call runs once");
});

test("an engine error is shown as it is, changes nothing, and the step can be tried again", () => {
  const env = mount();
  env.fail.assess = "engine exploded";
  const before = engineState(env.w);
  click(env.container, "assess");
  assert.ok(shows(env.container, "엔진/패널 오류: engine exploded"));
  assert.equal(engineState(env.w), before);
  assert.equal(env.panel.results()[0].timetableId, null);
  assert.deepEqual(env.changes, []);
  delete env.fail.assess;
  click(env.container, "assess");
  assert.equal(env.panel.results()[0].engineStatus, "assessed");
  assert.ok(!shows(env.container, "engine exploded"), "the error goes away with the next result");

  env.fail.approve = "approval refused";
  click(env.container, "approve");
  assert.ok(shows(env.container, "엔진/패널 오류: approval refused"));
  assert.equal(timetables(env)[0].status, "assessed");
  delete env.fail.approve;
  env.fail.activate = "not open";
  click(env.container, "approve");
  click(env.container, "activate");
  assert.ok(shows(env.container, "엔진/패널 오류: not open"));
  assert.equal(timetables(env)[0].status, "approved");
  assert.equal(btn(env.container, "activate").disabled, false);
});

test("the real engine's own refusal to activate is shown and rolled back: a service that is not open", () => {
  const w = world();
  w.runtime.game.services[0].status = "planned";
  const env = approved(mount(w));
  const before = engineState(w);
  click(env.container, "activate");
  assert.equal(env.calls.activate, 1);
  assert.ok(shows(env.container, "is not available for operation"));
  assert.equal(engineState(w), before);
  assert.equal(timetables(env)[0].status, "approved");
});

test("an error or a notice from an earlier click is dropped when the premises change", () => {
  const env = mount();
  env.fail.assess = "engine exploded";
  click(env.container, "assess");
  assert.ok(shows(env.container, "engine exploded"));
  env.hold.plans = [withBand(env.w.plan, { playerRequestedHeadwayMinutes: 20 })];
  env.panel.refresh();
  assert.ok(!shows(env.container, "engine exploded"));
  delete env.fail.assess;
  click(env.container, "assess");
  assert.ok(shows(env.container, "를 심사했습니다"));
  env.hold.input = { ...env.w.input, operatingResourcePools: [{ id: "pool", assignments: [] }] };
  env.panel.refresh();
  assert.ok(!shows(env.container, "를 심사했습니다"));
  assert.ok(!shows(env.container, "시간표 변환 확인(C1)"));
});

test("when the engine no longer has the timetable (another save was loaded) the record is stale, not trusted", () => {
  const env = mount();
  const checkpoint = env.w.runtime.save();
  approved(env);
  assert.equal(env.panel.results()[0].canActivate, true);
  env.w.runtime.load(checkpoint);
  env.panel.refresh();
  const row = env.panel.results()[0];
  assert.equal(timetables(env).length, 0);
  assert.deepEqual(row.staleReasons, ["timetable-missing"]);
  assert.deepEqual([row.canApprove, row.canActivate], [false, false]);
  forceClick(env.container, "activate");
  assert.equal(env.calls.activate, 0);
  assert.equal(row.canAssess, true);
});

test("a record whose id now names a different timetable in the engine is not trusted", () => {
  const env = approved(mount());
  const doc = env.panel.document;
  doc.entries[0].createdAtMinute = 99999;
  assert.deepEqual(env.panel.loadDoc(doc), { ok: true, issues: [] });
  assert.deepEqual(env.panel.results()[0].staleReasons, ["timetable-mismatch"]);
  assert.equal(env.panel.results()[0].canActivate, false);
  const other = approved(mount());
  const wrongService = other.panel.document;
  wrongService.entries[0].serviceId = "service:other";
  other.panel.loadDoc(wrongService);
  assert.ok(other.panel.results()[0].staleReasons.includes("binding-changed"));
  assert.ok(other.panel.results()[0].staleReasons.includes("timetable-mismatch"));
});

test("the lifecycle document round-trips byte for byte and a loaded record is current again when nothing changed", () => {
  const env = approved(mount());
  const saved = env.panel.serialize();
  const parsed = JSON.parse(saved);
  assert.equal(parsed.schema, RAILWAY_TIMETABLE_LIFECYCLE_DOC_SCHEMA);
  assert.deepEqual(Object.keys(parsed.entries[0]), ["servicePlanId", "serviceId", "timetableId", "createdAtMinute", "planDigest", "inputDigest"]);
  const fresh = mount(env.w);
  assert.equal(fresh.panel.results()[0].timetableId, null);
  assert.deepEqual(fresh.panel.loadDoc(saved), { ok: true, issues: [] });
  assert.equal(fresh.panel.serialize(), saved);
  const row = fresh.panel.results()[0];
  assert.equal(row.stale, false);
  assert.equal(row.engineStatus, "approved");
  assert.equal(row.canActivate, true);
  assert.deepEqual([fresh.calls.assess, fresh.calls.approve, fresh.calls.activate], [0, 0, 0], "loading calls no engine command");
  assert.deepEqual(fresh.changes, []);
  click(fresh.container, "activate");
  assert.equal(timetables(fresh)[0].status, "active");
});

test("a refused document leaves the current records alone", () => {
  const env = assessed(mount());
  const saved = env.panel.serialize();
  for (const bad of ["{", "null", JSON.stringify({ schema: "x", version: 1, entries: [] }), JSON.stringify({ schema: RAILWAY_TIMETABLE_LIFECYCLE_DOC_SCHEMA, version: 2, entries: [] }),
    JSON.stringify({ schema: RAILWAY_TIMETABLE_LIFECYCLE_DOC_SCHEMA, version: 1, entries: "x" })]) {
    const result = env.panel.loadDoc(bad);
    assert.equal(result.ok, false);
    assert.ok(result.issues.length > 0);
    assert.equal(env.panel.serialize(), saved);
  }
});

test("restoreLifecycleDoc refuses the whole document for any bad entry", () => {
  const entry = (over = {}) => ({ servicePlanId: "p", serviceId: "s", timetableId: "t", createdAtMinute: 5, planDigest: "d", inputDigest: "i", ...over });
  const doc = (entries) => ({ schema: RAILWAY_TIMETABLE_LIFECYCLE_DOC_SCHEMA, version: 1, entries });
  assert.deepEqual(restoreLifecycleDoc(newLifecycleDoc()), { doc: newLifecycleDoc(), issues: [] });
  for (const [input, issue] of [
    [doc([entry({ servicePlanId: "" })]), "entry-invalid:0"],
    [doc([entry({ timetableId: 4 })]), "entry-invalid:p"],
    [doc([entry({ createdAtMinute: "5" })]), "entry-invalid:p"],
    [doc([entry({ planDigest: null })]), "entry-invalid:p"],
    [doc([entry(), entry({ timetableId: "u" })]), "entry-duplicate-plan:p"],
    [doc([entry(), null]), "entry-invalid:1"],
  ]) {
    const out = restoreLifecycleDoc(input);
    assert.equal(out.doc, null);
    assert.ok(out.issues.includes(issue), `${issue} in ${out.issues}`);
  }
  assert.throws(() => serializeLifecycleDoc({ schema: "x" }), /invalid/);
  assert.deepEqual(restoreLifecycleDoc(doc([entry({ servicePlanId: "b" }), entry({ servicePlanId: "a", createdAtMinute: undefined })])).doc.entries.map((e) => [e.servicePlanId, e.createdAtMinute]), [["a", null], ["b", 5]]);
});

test("a record of a plan that is not on the map is kept, listed as stale, and can be cleared", () => {
  const env = mount();
  env.panel.loadDoc({ schema: RAILWAY_TIMETABLE_LIFECYCLE_DOC_SCHEMA, version: 1, entries: [{ servicePlanId: "map-plan:old", serviceId: "service:actual", timetableId: "railway-timetable:9", createdAtMinute: null, planDigest: "d", inputDigest: "i" }] });
  assert.ok(shows(env.container, "지도에 없는 계획의 심사 기록 1개"));
  assert.equal(JSON.parse(env.panel.serialize()).entries.length, 1);
  all(env.container, (n) => n.tag === "button" && n.textContent === "기록 지우기")[0].fire("click");
  assert.equal(env.panel.document.entries.length, 0);
  assert.equal(env.changes.length, 1);
});

test("frozen host data works, the callback gets copies, and results() hands out copies", () => {
  const w = world();
  const env = mount(w);
  env.hold.plans = deepFreeze([structuredClone(w.plan)]);
  env.hold.bindings = deepFreeze([{ servicePlanId: "map-plan:1", serviceId: "service:actual" }]);
  env.hold.input = deepFreeze(structuredClone(w.input));
  env.panel.refresh();
  click(env.container, "assess");
  assert.equal(env.panel.results()[0].engineStatus, "assessed");
  env.hold.inputCalls[0][0].name = "tampered";
  env.panel.results()[0].timetableId = "tampered";
  env.panel.document.entries.length = 0;
  assert.equal(env.hold.plans[0].name, "Morning plan");
  assert.notEqual(env.panel.results()[0].timetableId, "tampered");
  assert.equal(env.panel.document.entries.length, 1);
  env.hold.plans = { plans: env.hold.plans };
  env.hold.bindings = { bindings: env.hold.bindings };
  env.panel.refresh();
  assert.equal(env.panel.results()[0].stale, false, "the export object and the binding document are accepted as they come from M2 and M3");
});

test("the digest changes with any change of the data and not with key order", () => {
  assert.equal(digestOf({ a: 1, b: [1, 2], c: new Map([["x", 1]]) }), digestOf({ c: new Map([["x", 1]]), b: [1, 2], a: 1 }));
  for (const other of [{ a: 2, b: [1, 2] }, { a: 1, b: [2, 1] }, { a: 1, b: [1, 2], z: null }, { a: 1, b: [1, 2], z: undefined }]) assert.notEqual(digestOf({ a: 1, b: [1, 2] }), digestOf(other));
  assert.notEqual(digestOf(null), digestOf(undefined));
});

test("the module keeps its promises: no localStorage, no clock or random number, no timetable rule, the only import is the M3 issue text", () => {
  const source = fs.readFileSync(fileURLToPath(new URL("../src/railway-timetable-lifecycle-ui.mjs", import.meta.url)), "utf8").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/localStorage|sessionStorage|indexedDB/.test(source));
  assert.ok(!/Math\.random|Date\.now|new Date|performance\.now/.test(source));
  assert.ok(!/minimumHeadway|capacityTrainsPerHour|headwayMinutes/.test(source), "no B13 rule is restated");
  assert.deepEqual([...source.matchAll(/^import .* from "(.*)";$/gm)].map((m) => m[1]), ["./service-plan-management-ui.mjs"]);
  const calls = [...source.matchAll(/runtime\.(assessServicePlanTimetable)\(/g)].length + [...source.matchAll(/runtime\[name\]\(/g)].length;
  assert.equal(calls, 2, "the three commands are called from exactly two places, both inside the click handler");
  const hostile = { createElement: dom.createElement, defaultView: { localStorage: new Proxy({}, { get() { throw new Error("storage must not be touched"); } }) } };
  const w = world();
  const container = Object.assign(new Node_("div"), { ownerDocument: hostile });
  mountRailwayTimetableLifecyclePanel({ container, runtime: w.runtime, getServicePlans: () => [w.plan], getBindings: () => [{ servicePlanId: "map-plan:1", serviceId: "service:actual" }], getAssessmentInput: () => w.input });
  assert.ok(shows(container, "map-plan:1"));
});
