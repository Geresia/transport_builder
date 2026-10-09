import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { ISSUES_NOTICE, LIST_LIMIT, SCOPE_NOTICE, mountRailwayTimetableOperationPanel } from "../src/railway-timetable-operation-panel.mjs";
import { RAILWAY_TIMETABLE_OPERATION_REPORT_SCHEMA, buildRailwayTimetableOperationReport } from "../src/railway-timetable-operation-report.mjs";
import { ScenarioRuntime } from "../src/scenario-runtime.mjs";
import { addLine, addPhysicalStation, addTrackSegment, createState } from "../src/state.mjs";
import { dispatchTrains } from "../src/trains.mjs";

// --- a minimal DOM: elements, listeners, replaceChildren ---
class Node_ {
  constructor(tag) { Object.assign(this, { tag, children: [], className: "", textContent: "", value: "", disabled: false, listeners: {} }); }
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
const byClass = (node, name) => all(node, (n) => classes(n).includes(name));
const factValue = (card, label) => {
  const row = all(card, (n) => classes(n).includes("ttop-fact")).find((n) => n.children[0]?.textContent === label);
  assert.ok(row, `fact ${label}`);
  return row.children[1].textContent;
};
const timetableCard = (container, id) => byClass(container, "ttop-timetable").find((c) => c.children[0].textContent === id);
const pick = (select, value) => { select.value = value; select.fire("change"); };
const deepFreeze = (o) => { if (o && typeof o === "object") { Object.values(o).forEach(deepFreeze); Object.freeze(o); } return o; };

// --- reports: real ones from a real runtime, and synthetic ones built by the real E1 builder ---
function sourcePack() { return { manifest: { id: "timetable-operation-panel", version: "1", data: { license: "test", attribution: [] } }, demand: { model: "gravity", points: [], attractors: [] } }; }
function world() {
  const state = createState(sourcePack());
  addPhysicalStation(state, { id: "A", location: [139, 35] });
  addPhysicalStation(state, { id: "B", location: [139.01, 35] });
  addPhysicalStation(state, { id: "C", location: [139.02, 35] });
  addTrackSegment(state, { id: "ab", fromStationId: "A", toStationId: "B", lengthMeters: 1_000 });
  addTrackSegment(state, { id: "bc", fromStationId: "C", toStationId: "B", lengthMeters: 1_200 });
  const line = addLine(state, ["A", "B", "C"], { frequency: { high: 60, medium: 60, low: 60, veryLow: 60 } });
  line.trackSegmentIds = ["bc", "ab"];
  line.managementServiceId = "service:a";
  const runtime = new ScenarioRuntime({ pack: sourcePack(), operationalState: state });
  runtime.game.services.push({ id: "service:a", status: "open", operationalLineId: line.id, commercialSpeedKph: 30, trainsPerHour: 4, operatorId: "player" });
  return { state, line, runtime };
}
const plan = (first, last) => ({ serviceId: "service:a", firstDepartureMinute: first, lastDepartureMinute: last, headwayMinutes: 10, terminalResourceId: "terminal:C:1" });
const assess = (w, first, last) => w.runtime.assessOperationalRailwayTimetable({ infrastructureRevision: "assets:1", servicePlans: [plan(first, last)], infrastructureAssumptions: { directionMode: "double", minimumHeadwayMinutes: 3 } });
const activate = (w, first, last) => { const t = assess(w, first, last); w.runtime.approveRailwayTimetable(t.id); w.runtime.activateRailwayTimetable(t.id); return t; };
const dispatchAt = (state, minute) => { state.simMinutes = minute; dispatchTrains(state); };
function activeWorld() {
  const w = world();
  const timetable = activate(w, 361, 371);
  return { ...w, timetable };
}

// A runtime stand-in: the host's getReport reads the report; every command is recorded and must stay at zero.
function spyHost(w) {
  const calls = { report: 0, commands: [] };
  const record = (name) => () => { calls.commands.push(name); throw new Error(`${name} must not be called`); };
  const runtime = {
    railwayTimetableOperationReport: () => { calls.report += 1; return w.runtime.railwayTimetableOperationReport(); },
    assessServicePlanTimetable: record("assessServicePlanTimetable"), assessOperationalRailwayTimetable: record("assessOperationalRailwayTimetable"),
    approveRailwayTimetable: record("approveRailwayTimetable"), activateRailwayTimetable: record("activateRailwayTimetable"), withdrawRailwayTimetable: record("withdrawRailwayTimetable"),
    save: record("save"), load: record("load"),
  };
  return { runtime, calls };
}
function mount(getReport, container = newContainer()) {
  const panel = mountRailwayTimetableOperationPanel({ container, getReport });
  return { panel, container };
}

// Two lines, two timetables, three trains: enough to filter on.
function syntheticState() {
  const dispatch = (timetableId, serviceId, extra = {}) => ({ dayType: "weekday", timetableId, serviceId, departureMinutes: [360, 370], roundTrips: [{ departureMinute: 360 }, { departureMinute: 370 }], lastCheckedSimMinute: 500, ...extra });
  const train = (id, lineId, extra = {}) => ({ id, lineId, segIndex: 0, dir: 1, t: 0.5, serviceStationIds: ["A", "B"], ...extra });
  return {
    simMinutes: 500, stations: new Map([["A", {}], ["B", {}]]),
    lines: [
      { id: 1, name: "L1", suspended: false, managementServiceId: "s1", timetableDispatches: { weekday: dispatch("railway-timetable:1", "s1", { missedDepartures: 2 }) } },
      { id: 2, name: "L2", suspended: true, managementServiceId: "s2", timetableDispatches: { weekday: dispatch("railway-timetable:2", "s2", { blockedReason: "unmapped service" }) } },
    ],
    trains: [
      train(10, 1, { timetableId: "railway-timetable:1", managementServiceId: "s1", scheduledDepartureMinute: 360 }),
      train(11, 2, { timetableId: "railway-timetable:2", managementServiceId: "s2", scheduledDepartureMinute: 360, t: Number.NaN }),
      train(12, 2),
    ],
    stats: { railwayTrafficByLine: { 1: { dispatchedTrains: 3, completedTrains: 0, scheduledDispatchedTrains: 3, unscheduledDispatchedTrains: 0, scheduledCompletedTrains: 0, onTimeTrains: 0, missedDepartures: 2, lateCompletedTrains: 0 } } },
  };
}
const syntheticTimetables = () => [
  { id: "railway-timetable:1", status: "active", dayType: "weekday", infrastructureRevision: "r", requestedPaths: 4, acceptedPaths: [1, 2, 3], rejectedPaths: [1], assessment: { verdict: "conditional" }, createdAtMinute: 10, approvedAtMinute: 20, activatedAtMinute: 30, operationalFacts: { serviceIds: ["s1"] } },
  { id: "railway-timetable:2", status: "approved", dayType: "weekday", infrastructureRevision: "r", requestedPaths: 2, acceptedPaths: [1, 2], rejectedPaths: [], assessment: { verdict: "possible" }, createdAtMinute: 11, approvedAtMinute: 21 },
];
const syntheticReport = () => buildRailwayTimetableOperationReport({ operationalState: syntheticState(), timetables: syntheticTimetables() });

test("mounting needs a container and a getReport function", () => {
  assert.throws(() => mountRailwayTimetableOperationPanel({ getReport: () => ({}) }), /container/);
  assert.throws(() => mountRailwayTimetableOperationPanel({ container: newContainer() }), /getReport/);
  assert.throws(() => mountRailwayTimetableOperationPanel({ container: newContainer(), getReport: "x" }), /getReport/);
});

test("mounting, refreshing and filtering run no engine command, read the report only when mounted or refreshed, and use no timer", () => {
  const w = world();
  const host = spyHost(w);
  const { panel, container } = mount(() => host.runtime.railwayTimetableOperationReport());
  assert.equal(host.calls.report, 1);
  panel.refresh(); panel.refresh();
  assert.equal(host.calls.report, 3);
  panel.setFilter({ lineId: String(w.line.id) });
  panel.setFilter({ timetableId: "railway-timetable:1" });
  panel.setFilter(null);
  assert.equal(host.calls.report, 3, "changing the filter does not fetch");
  assert.deepEqual(host.calls.commands, []);
  assert.ok(shows(container, SCOPE_NOTICE));
});

test("no report, a report of another shape, or a failing getReport: the reason is shown and nothing else", () => {
  for (const [getReport, part] of [[() => null, "보고서가 없습니다"], [() => undefined, "보고서가 없습니다"], [() => ({ schema: "other/1" }), "알 수 없는 보고서 형식"], [() => [], "보고서가 없습니다"], [() => { throw new Error("runtime offline"); }, "runtime offline"]]) {
    const { container } = mount(getReport);
    assert.ok(shows(container, part), part);
    assert.equal(byClass(container, "ttop-card").length, 0);
    assert.equal(all(container, (n) => n.tag === "select").length, 0);
  }
  let fail = true;
  const { panel, container } = mount(() => { if (fail) throw new Error("later"); return syntheticReport(); });
  assert.ok(shows(container, "later"));
  fail = false;
  panel.refresh();
  assert.equal(byClass(container, "ttop-timetable").length, 2);
  assert.equal(panel.report.schema, RAILWAY_TIMETABLE_OPERATION_REPORT_SCHEMA);
});

test("a report built without its inputs says so: not provided is not the same as an empty list", () => {
  const none = mount(() => buildRailwayTimetableOperationReport()).container;
  assert.ok(shows(none, "시간표 보고서 없음: the-timetable-report-was-not-provided"));
  assert.ok(shows(none, "운영 상태 없음: the-operational-state-was-not-provided"));
  assert.ok(shows(none, "시간표 (보고서에 포함되지 않음)"));
  assert.ok(shows(none, "dispatch (보고서에 포함되지 않음)"));
  assert.ok(!shows(none, "표시할 시간표가 없습니다(빈 목록)"));
  const w = world();
  const empty = mount(() => buildRailwayTimetableOperationReport({ operationalState: w.state, timetables: [] })).container;
  assert.ok(shows(empty, "시간표 0개"));
  assert.ok(shows(empty, "표시할 시간표가 없습니다(빈 목록)"));
  assert.ok(!shows(empty, "보고서에 포함되지 않음"));
});

test("active, approved, assessed, withdrawn and superseded timetables are all shown with their own state, counts and lifecycle minutes", () => {
  const w = world();
  const superseded = activate(w, 361, 371);
  const active = activate(w, 381, 391);
  const approved = assess(w, 401, 411); w.runtime.approveRailwayTimetable(approved.id);
  const assessed = assess(w, 421, 431);
  const withdrawn = assess(w, 441, 451); w.runtime.approveRailwayTimetable(withdrawn.id); w.runtime.withdrawRailwayTimetable(withdrawn.id);
  const { container } = mount(() => w.runtime.railwayTimetableOperationReport());
  const expected = { [active.id]: "active", [approved.id]: "approved", [assessed.id]: "assessed", [withdrawn.id]: "withdrawn", [superseded.id]: "superseded" };
  for (const [id, status] of Object.entries(expected)) {
    const card = timetableCard(container, id);
    assert.ok(card, id);
    assert.ok(classes(card).includes(status));
    assert.ok(factValue(card, "생애주기 상태").endsWith(`(${status})`), `${id}: ${factValue(card, "생애주기 상태")}`);
    const engine = w.runtime.railwayTimetableReport(id)[0];
    assert.equal(factValue(card, "운행경로"), `요청 ${engine.requestedPaths} · 수락 ${engine.acceptedPaths.length} · 거절 ${engine.rejectedPaths.length}`);
  }
  assert.ok(factValue(timetableCard(container, withdrawn.id), "철회 직전 상태").includes("approved"));
  assert.match(factValue(timetableCard(container, assessed.id), "생애주기 시각"), /승인 없음 \(아직 일어나지 않았거나 기록되지 않음\)/);
  assert.match(factValue(timetableCard(container, active.id), "생애주기 시각"), /활성 \d+분/);
  assert.ok(shows(container, "시간표 5개"));
  const metrics = Object.fromEntries(byClass(container, "ttop-metric").map((m) => [m.children[0].textContent, m.children[1].textContent]));
  assert.deepEqual([metrics["활성"], metrics["승인됨"], metrics["심사됨"], metrics["철회됨"], metrics["다른"], metrics["기타 상태"]], ["1", "1", "1", "1", "1", "0"]);
});

test("null, 0, false and an empty list are four different things on screen", () => {
  const report = syntheticReport();
  const t = report.timetables[0];
  t.paths.rejected = 0;
  t.serviceIds = [];
  t.completedTrains = 0;
  t.completedTrainsReason = null;
  t.lifecycle.withdrawnAtMinute = 0;
  const d = report.dispatches[0];
  d.missedDepartures = 0;
  d.lineSuspended = false;
  d.departureMinutes = [];
  d.scheduledDeparturesPerDay = 0;
  const u = report.dispatches[1];
  u.missedDepartures = null;
  delete u.missedDeparturesReason;
  u.lineSuspended = null;
  const { container } = mount(() => report);
  const card = timetableCard(container, t.timetableId);
  assert.match(factValue(card, "운행경로"), /거절 0$/, "a zero is a zero");
  assert.equal(factValue(card, "대상 서비스"), "빈 목록", "an empty list is an empty list");
  assert.equal(factValue(card, "완료한 열차 수"), "0", "a recorded zero is not unknown");
  assert.match(factValue(card, "생애주기 시각"), /철회 0분/);
  const dispatchCards = byClass(container, "ttop-dispatch");
  assert.equal(factValue(dispatchCards[0], "놓친 출발"), "0");
  assert.equal(factValue(dispatchCards[0], "노선 정지"), "아니오", "false is no");
  assert.equal(factValue(dispatchCards[0], "예정 출발"), "하루 0회 · 출발 분 빈 목록");
  assert.equal(factValue(dispatchCards[1], "놓친 출발"), "미상");
  assert.equal(factValue(dispatchCards[1], "노선 정지"), "미상", "null is unknown, not no");
});

test("a timetable's why-not facts are shown as given: no dispatch, a blocked dispatch, a suspended line, missed departures, and what is unknown", () => {
  const w = activeWorld();
  dispatchAt(w.state, 380);
  const approved = assess(w, 600, 610); w.runtime.approveRailwayTimetable(approved.id);
  const { container } = mount(() => w.runtime.railwayTimetableOperationReport());
  const idle = timetableCard(container, approved.id);
  assert.match(factValue(idle, "실제 운행 연결"), /dispatch 0개 · 노선 빈 목록 · 놓친 출발 미상 \(no-dispatch-entry-for-this-timetable — 이 시간표를 가리키는 dispatch가 없음\)/);
  const running = timetableCard(container, w.timetable.id);
  assert.match(factValue(running, "실제 운행 연결"), /dispatch 1개 · 노선 1 · 놓친 출발 2$/);
  const dispatchCard = byClass(container, "ttop-dispatch")[0];
  assert.equal(factValue(dispatchCard, "놓친 출발"), "2");
  assert.equal(factValue(dispatchCard, "막힘 사유"), "엔진에 기록된 막힘 사유 없음");
  const synthetic = mount(() => syntheticReport()).container;
  const blocked = byClass(synthetic, "ttop-dispatch").find((c) => shows(c, "노선 2"));
  assert.equal(factValue(blocked, "막힘 사유"), "unmapped service");
  assert.equal(factValue(blocked, "노선 정지"), "예");
  assert.match(factValue(blocked, "놓친 출발"), /^미상 \(counter-not-created/);
});

test("completed trains: null with the report's reason and its plain-language note; the explanation is also in limits", () => {
  const w = activeWorld();
  const { container } = mount(() => w.runtime.railwayTimetableOperationReport());
  const card = timetableCard(container, w.timetable.id);
  const value = factValue(card, "완료한 열차 수");
  assert.match(value, /^미상 \(finished-trains-are-removed-and-traffic-counters-are-per-line — 끝난 열차는 목록에서 지워지고/);
  assert.ok(shows(container, "completed-trains-not-attributable"));
});

test("train provenance: timetable, scheduled-provenance-unrecorded and legacy-frequency are three different things and are never mixed up", () => {
  const w = activeWorld();
  dispatchAt(w.state, 361);
  dispatchAt(w.state, 371);
  delete w.state.trains[1].timetableId;
  delete w.state.trains[1].managementServiceId;
  w.state.trains.push({ id: 99, lineId: w.line.id, segIndex: 0, dir: 1, t: 0.2, serviceStationIds: ["A", "B", "C"] });
  const { container } = mount(() => w.runtime.railwayTimetableOperationReport());
  const trains = byClass(container, "ttop-train");
  assert.equal(trains.length, 3);
  const byProvenance = Object.fromEntries(trains.map((card) => [classes(card).find((c) => ["timetable", "scheduled-provenance-unrecorded", "legacy-frequency"].includes(c)), card]));
  assert.deepEqual(Object.keys(byProvenance).sort(), ["legacy-frequency", "scheduled-provenance-unrecorded", "timetable"]);
  assert.match(factValue(byProvenance.timetable, "출처(provenance)"), /^시간표 열차 \(timetableId 기록됨\) \(timetable\)$/);
  assert.equal(factValue(byProvenance.timetable, "시간표 ID"), w.timetable.id);
  assert.equal(factValue(byProvenance.timetable, "경영 서비스 ID"), "service:a");
  assert.match(factValue(byProvenance["scheduled-provenance-unrecorded"], "출처(provenance)"), /출처 미기록 \(B17-E0 이전 저장본\) \(scheduled-provenance-unrecorded\)/);
  assert.match(factValue(byProvenance["scheduled-provenance-unrecorded"], "시간표 ID"), /^미상 \(dispatched-against-a-schedule-but-the-provenance-was-not-recorded/);
  assert.match(factValue(byProvenance["legacy-frequency"], "출처(provenance)"), /레거시 빈도 열차 \(시간표 없이 노선 빈도로 운행\) \(legacy-frequency\)/);
  assert.match(factValue(byProvenance["legacy-frequency"], "시간표 ID"), /^미상 \(dispatched-by-line-frequency-not-by-a-timetable — 노선 빈도로 출발시킨 열차라 시간표가 없음\)$/);
  assert.equal(factValue(byProvenance["legacy-frequency"], "예정 출발 · 예정 완료"), "미상 · 미상");
  assert.ok(!shows(byProvenance["legacy-frequency"], "출처 미기록"), "a legacy train is never described as provenance-missing");
  assert.ok(!shows(byProvenance["scheduled-provenance-unrecorded"], "레거시"), "a provenance-missing train is never described as legacy");
  const metrics = Object.fromEntries(byClass(container, "ttop-metric").map((m) => [m.children[0].textContent, m.children[1].textContent]));
  assert.deepEqual([metrics["시간표 열차"], metrics["출처 미기록 예정 열차"], metrics["레거시 빈도 열차"]], ["1", "1", "1"]);
});

test("position-unknown trains show every reason; progress 0 is not unknown; waiting and hold times are the report's; done is its own state", () => {
  const w = activeWorld();
  dispatchAt(w.state, 361);
  dispatchAt(w.state, 371);
  w.state.trains[0].t = 0;
  w.state.trains[0].waitingForSignal = { reason: "junction-occupied" };
  w.state.trains[0].holdUntilSimMinute = 400;
  w.state.trains[1].t = Number.NaN;
  w.state.trains[1].dir = 0;
  w.state.trains.push({ id: 77, lineId: w.line.id, done: true, scheduledDepartureMinute: 361, timetableId: w.timetable.id, serviceStationIds: ["A", "B", "C"], segIndex: 0, dir: 1, t: 1 });
  const { container } = mount(() => w.runtime.railwayTimetableOperationReport());
  const [first, second, done] = byClass(container, "ttop-train");
  assert.equal(factValue(first, "구간 번호 · 방향 · 진행도"), "0 · 1 · 0", "a progress of 0 is shown as 0");
  assert.equal(factValue(first, "신호 대기 이유 · 보류 해제 시각"), "junction-occupied · 400분");
  assert.ok(factValue(first, "상태").endsWith("(running)"));
  assert.ok(factValue(second, "상태").endsWith("(position-unknown)"));
  assert.ok(shows(second, "위치 미상 이유: direction-invalid — 방향 값이 올바르지 않음"));
  assert.ok(shows(second, "위치 미상 이유: progress-invalid — 구간 진행도가 올바르지 않음"));
  assert.equal(factValue(second, "구간 번호 · 방향 · 진행도"), "0 · 미상 · 미상");
  assert.equal(factValue(second, "신호 대기 이유 · 보류 해제 시각"), "기록 없음 · 기록 없음");
  assert.ok(factValue(done, "상태").endsWith("(done)"));
  assert.ok(!shows(done, "위치 미상 이유"));
});

test("issues are shown as the report wrote them, with their own fields, and the panel says they are not verdicts; a code it does not know is shown raw", () => {
  const report = syntheticReport();
  report.issues.push({ code: "some-future-issue", trainId: "10", detail: null, list: [], flag: false, count: 0 });
  const { container } = mount(() => report);
  assert.ok(shows(container, ISSUES_NOTICE));
  assert.ok(shows(container, `issues ${report.issues.length}개`));
  for (const issue of report.issues) assert.ok(byClass(container, "ttop-issue").some((n) => n.textContent.startsWith(issue.code)), issue.code);
  const blocked = byClass(container, "ttop-issue").find((n) => n.textContent.startsWith("dispatch-blocked"));
  assert.match(blocked.textContent, /blockedReason: unmapped service/);
  assert.match(blocked.textContent, /— dispatch에 막힘 사유가 기록됨/);
  const future = byClass(container, "ttop-issue").find((n) => n.textContent.startsWith("some-future-issue"));
  assert.equal(future.textContent, "some-future-issue · trainId: 10 · detail: 미상 · list: 빈 목록 · flag: 아니오 · count: 0");
  const body = byClass(container, "ttop-issue").map((n) => n.textContent).join("\n");
  assert.ok(!/해결|실패|오류입니다|불가능|가능합니다|정상|비정상/.test(body), "no verdict words are added to issues");
});

test("limits are shown word for word, with a short note for the ones the panel knows", () => {
  const report = syntheticReport();
  const { container } = mount(() => report);
  assert.ok(shows(container, `보고서가 말할 수 없는 것 ${report.limits.length}개 (limits)`));
  for (const limit of report.limits) {
    assert.ok(byClass(container, "ttop-limit-text").some((n) => n.textContent === limit.text), limit.id);
    assert.ok(byClass(container, "ttop-limit").some((n) => n.children[0].textContent.startsWith(limit.id)), limit.id);
  }
  report.limits.push({ id: "new-limit", text: "a limit this panel has never heard of" });
  const again = mount(() => report).container;
  assert.ok(byClass(again, "ttop-limit").some((n) => n.children[0].textContent === "new-limit" && n.children[1].textContent === "a limit this panel has never heard of"));
});

test("filter by timetable: only that timetable's card, dispatches, trains, lines and issues are shown; clearing shows everything", () => {
  const report = syntheticReport();
  const { panel, container } = mount(() => report);
  assert.equal(byClass(container, "ttop-timetable").length, 2);
  assert.equal(byClass(container, "ttop-train").length, 3);
  panel.setFilter({ timetableId: "railway-timetable:1" });
  assert.deepEqual(panel.filter, { timetableId: "railway-timetable:1" });
  assert.deepEqual(byClass(container, "ttop-timetable").map((c) => c.children[0].textContent), ["railway-timetable:1"]);
  assert.equal(byClass(container, "ttop-dispatch").length, 1);
  assert.ok(shows(byClass(container, "ttop-dispatch")[0], "railway-timetable:1"));
  assert.deepEqual(byClass(container, "ttop-train").map((c) => c.children[0].textContent), ["열차 10 · 노선 1"]);
  assert.deepEqual(byClass(container, "ttop-line").map((c) => c.children[0].textContent.split(" · ")[0]), ["노선 1"]);
  assert.ok(byClass(container, "ttop-issue").every((n) => !n.textContent.includes("trainId: 12") && !n.textContent.includes("trainId: 11")));
  assert.ok(shows(container, "필터: 시간표 railway-timetable:1"));
  pick(all(container, (n) => n.tag === "select" && classes(n).includes("ttop-filter-timetable"))[0], "");
  assert.equal(panel.filter, null);
  assert.equal(byClass(container, "ttop-timetable").length, 2);
  assert.equal(byClass(container, "ttop-train").length, 3);
});

test("filter by line: that line's dispatches, trains and counters, and the timetables behind them; choosing one filter replaces the other", () => {
  const report = syntheticReport();
  const { panel, container } = mount(() => report);
  const timetableSelect = () => all(container, (n) => n.tag === "select" && classes(n).includes("ttop-filter-timetable"))[0];
  const lineSelect = () => all(container, (n) => n.tag === "select" && classes(n).includes("ttop-filter-line"))[0];
  assert.deepEqual(lineSelect().children.map((o) => o.value), ["", "1", "2"]);
  pick(lineSelect(), "2");
  assert.deepEqual(panel.filter, { lineId: "2" });
  assert.deepEqual(byClass(container, "ttop-train").map((c) => c.children[0].textContent), ["열차 11 · 노선 2", "열차 12 · 노선 2"]);
  assert.deepEqual(byClass(container, "ttop-timetable").map((c) => c.children[0].textContent), ["railway-timetable:2"]);
  assert.equal(byClass(container, "ttop-dispatch").length, 1);
  assert.equal(lineSelect().value, "2");
  pick(timetableSelect(), "railway-timetable:1");
  assert.deepEqual(panel.filter, { timetableId: "railway-timetable:1" });
  assert.equal(lineSelect().value, "", "the other select shows no choice");
  assert.equal(timetableSelect().value, "railway-timetable:1");
});

test("a selected timetable or line that is not in the report is said to be missing, and nothing is shown in its place; the filter survives a refresh", () => {
  let report = syntheticReport();
  const { panel, container } = mount(() => report);
  panel.setFilter({ timetableId: "railway-timetable:42" });
  assert.ok(shows(container, "선택한 시간표 railway-timetable:42 는 이 보고서에 없습니다"));
  assert.equal(byClass(container, "ttop-card").length, 0);
  panel.setFilter({ lineId: "9" });
  assert.ok(shows(container, "선택한 노선 9 는 이 보고서에 없습니다"));
  panel.setFilter({ timetableId: "railway-timetable:2" });
  assert.equal(byClass(container, "ttop-timetable").length, 1);
  report = buildRailwayTimetableOperationReport({ operationalState: syntheticState(), timetables: [syntheticTimetables()[0]] });
  panel.refresh();
  assert.deepEqual(panel.filter, { timetableId: "railway-timetable:2" });
  assert.ok(shows(container, "선택한 시간표 railway-timetable:2 는 이 보고서에 없습니다"));
  panel.setFilter({});
  assert.equal(panel.filter, null);
  panel.setFilter({ timetableId: 5 });
  assert.equal(panel.filter, null);
});

test("a long train list is cut at the limit and says how many were left out", () => {
  const state = syntheticState();
  for (let id = 100; id < 100 + LIST_LIMIT + 10; id += 1) state.trains.push({ id, lineId: 1, segIndex: 0, dir: 1, t: 0.1, serviceStationIds: ["A", "B"] });
  const report = buildRailwayTimetableOperationReport({ operationalState: state, timetables: syntheticTimetables() });
  const { panel, container } = mount(() => report);
  assert.equal(byClass(container, "ttop-train").length, LIST_LIMIT);
  assert.ok(shows(container, `지금 선로 위의 열차 ${report.trains.length}대`));
  assert.ok(shows(container, `외 ${report.trains.length - LIST_LIMIT}대는 표시하지 않았습니다`));
  panel.setFilter({ timetableId: "railway-timetable:2" });
  assert.ok(!shows(container, "표시하지 않았습니다"));
});

test("the report is not changed by showing it: a frozen report works and stays equal to a copy; the panel hands out copies", () => {
  const w = activeWorld();
  dispatchAt(w.state, 361);
  const original = w.runtime.railwayTimetableOperationReport();
  const frozen = deepFreeze(structuredClone(original));
  const { panel, container } = mount(() => frozen);
  panel.setFilter({ lineId: String(w.line.id) });
  panel.setFilter({ timetableId: w.timetable.id });
  panel.refresh();
  assert.deepEqual(frozen, original);
  assert.ok(byClass(container, "ttop-timetable").length >= 1);
  const copy = panel.report;
  copy.trains[0].status = "tampered";
  copy.timetables.length = 0;
  assert.equal(panel.report.trains[0].status, "running");
  assert.equal(panel.report.timetables.length, original.timetables.length);
  assert.equal(mountRailwayTimetableOperationPanel({ container: newContainer(), getReport: () => null }).report, null);
});

test("the same report shows the same text every time, whatever order the lists arrive in", () => {
  const report = syntheticReport();
  const first = texts(mount(() => report).container);
  assert.deepEqual(texts(mount(() => report).container), first);
  const copied = structuredClone(report);
  assert.deepEqual(texts(mount(() => copied).container), first);
});

test("the numbers on screen are the report's: nothing is added up, averaged or turned into a delay, cost, demand or crowding figure", () => {
  const w = activeWorld();
  dispatchAt(w.state, 361);
  const { container } = mount(() => w.runtime.railwayTimetableOperationReport());
  const body = texts(container).join("\n").replace(SCOPE_NOTICE, "");
  assert.ok(!/지연 [0-9]|비용 [0-9]|수요 [0-9]|혼잡 [0-9]|운임|승객 [0-9]|원\b|엔\b/.test(body), body.slice(0, 200));
  assert.ok(!byClass(container, "ttop-traffic").some((n) => /delay/i.test(n.textContent)));
});

test("the module keeps its promises: no storage, timer, clock or random number, no engine command, and the only import is the E1 schema name", () => {
  const source = fs.readFileSync(fileURLToPath(new URL("../src/railway-timetable-operation-panel.mjs", import.meta.url)), "utf8").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/localStorage|sessionStorage|indexedDB/.test(source));
  assert.ok(!/setInterval|setTimeout|requestAnimationFrame|queueMicrotask/.test(source));
  assert.ok(!/Math\.random|Date\.now|new Date|performance\.now/.test(source));
  assert.ok(!/runtime|assessServicePlanTimetable|approveRailwayTimetable|activateRailwayTimetable|withdrawRailwayTimetable|\.save\(|\.load\(/.test(source), "the panel never receives or names a runtime command");
  assert.deepEqual([...source.matchAll(/^import \{([^}]*)\} from "(.*)";$/gm)].map((m) => [m[1].trim(), m[2]]), [["RAILWAY_TIMETABLE_OPERATION_REPORT_SCHEMA", "./railway-timetable-operation-report.mjs"]]);
});
