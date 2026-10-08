import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  ID_KIND_NOTICE, PRESCREEN_NOTICE, SCOPE_NOTICE, SERVICE_PLAN_BINDING_DOC_SCHEMA, buildServicePlanPanelView, mountServicePlanManagementPanel,
  newBindingDoc, restoreBindingDoc, serializeBindingDoc,
} from "../src/service-plan-management-ui.mjs";
import { adaptServicePlanToOperationalTimetable } from "../src/service-plan-timetable-adapter.mjs";
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
const newContainer = (ownerDocument = dom) => Object.assign(new Node_("div"), { ownerDocument });
const all = (node, pred = () => true) => [pred(node) ? node : null, ...node.children.flatMap((c) => all(c, pred))].filter(Boolean);
const texts = (node) => all(node).map((n) => n.textContent).filter(Boolean);
const shows = (node, part) => texts(node).some((t) => t.includes(part));
const classes = (node) => String(node.className).split(" ");
const cardOf = (container, servicePlanId) => all(container, (n) => classes(n).includes("svcplan-card")).find((card) => all(card, (n) => classes(n).includes("svcplan-id-plan"))[0].children[1].textContent === servicePlanId);
const selectOf = (card) => all(card, (n) => n.tag === "select")[0];
const pick = (select, value) => { select.value = value; select.fire("change"); };
const readinessOf = (card) => all(card, (n) => classes(n).includes("svcplan-readiness"))[0].textContent;
const areaChip = (card, area) => all(card, (n) => classes(n).includes("svcplan-area") && classes(n).includes(area))[0];
const deepFreeze = (o) => { if (o && typeof o === "object") { Object.values(o).forEach(deepFreeze); Object.freeze(o); } return o; };
const READY = "시간표 심사 준비 완료";

// --- fixtures: the same world the C1 adapter tests use ---
const PACK = { manifest: { id: "svcplan-ui", version: "1", data: { license: "test", attribution: [] } }, demand: { model: "gravity", points: [{ id: "n:a", location: [139, 35], residents: 10, jobs: 5 }], attractors: [] } };
function world() {
  const state = createState(PACK);
  addPhysicalStation(state, { id: "A", location: [139, 35], status: "available" });
  addPhysicalStation(state, { id: "B", location: [139.01, 35], status: "available" });
  addTrackSegment(state, { id: "ab", fromStationId: "A", toStationId: "B", lengthMeters: 1000, status: "available", directionMode: "double", minimumHeadwayMinutes: 3 });
  const line = addLine(state, ["A", "B"], { frequency: { high: 10 } });
  line.trackSegmentIds = ["ab"]; line.managementServiceId = "service:actual"; line.suspended = false;
  state.railCapacityApplications = [{
    operationalLineId: line.id, railGeometryId: "geometry:1", railGeometryRevision: "revision:1",
    sections: [{ trackSegmentId: "ab", railCapacitySectionId: "section:ab", directionMode: "double", blockIds: [], junctionResourceIds: [] }],
    junctions: [], terminals: [{ terminalResourceId: "terminal:B", stationId: "B", platformCandidates: [], turnbackCandidates: [{ turnbackCandidateId: "turnback:B", attached: true }] }],
  }];
  return {
    state, line,
    services: [{ id: "service:actual", operationalLineId: line.id, commercialSpeedKph: 30, operatorId: "player", name: "Actual Line" }],
    throughServices: [],
    prescreen: {
      technicalSpecs: { [line.id]: { technicalProfileId: "medium_steel", capacityTrainsPerHour: 20 } },
      vehicleOrders: [{ modelId: "medium_4car", stage: "accepted", quantity: 2, units: [{ id: "set:1", status: "available" }, { id: "set:2", status: "available" }] }],
      operatingResourcePools: [],
    },
  };
}
function plan(w, overrides = {}) {
  return {
    schema: "transitline.service-plan-geometry/1", contractVersion: 1, servicePlanId: "map-plan:1", servicePlanRevision: "rev:1", name: "Morning plan", active: true,
    revision: { state: "current" }, capacityApplicationState: "current", capacityApplicationRevision: "capacity:1", operationalLineId: String(w.line.id),
    playerInputs: { operatingPattern: "full" }, vehicleIntent: { vehicleModelId: "medium_4car", requestedTrainsets: 2 },
    route: { sections: [{ trackSegmentId: "ab", traversal: "forward" }] }, spatialFacts: { sections: [{ junctionResourceIds: [] }] },
    directions: [
      { key: "out", fromStationId: "A", toStationId: "B", physicalConnection: true },
      { key: "back", fromStationId: "B", toStationId: "A", physicalConnection: true },
    ],
    serviceBands: [{ bandId: "band:1", operating: true, startMinute: 360, endMinute: 600, playerRequestedHeadwayMinutes: 10, playerRequestedTrainsets: 2, directionKeys: ["out", "back"] }],
    turnbacks: [{ stationId: "B", terminalResourceId: "terminal:B", turnbackCandidateId: "turnback:B" }], ...overrides,
  };
}

// A runtime stand-in that only answers reads and fails the test if the panel ever tries to run, approve or activate a timetable.
function spy(w) {
  const calls = { reports: 0, forbidden: [] };
  const forbid = (name) => () => { calls.forbidden.push(name); throw new Error(`${name} must not be called`); };
  const runtime = {
    operationalState: w.state,
    report() { calls.reports += 1; return { services: w.services, throughServices: w.throughServices, operatingResourcePools: w.prescreen.operatingResourcePools }; },
    game: { vehicleOrders: undefined },
    assessOperationalRailwayTimetable: forbid("assessOperationalRailwayTimetable"),
    approveRailwayTimetable: forbid("approveRailwayTimetable"),
    activateRailwayTimetable: forbid("activateRailwayTimetable"),
  };
  return { runtime, calls };
}
function mount(w = world(), plans = null, over = {}) {
  const env = spy(w);
  const holder = { plans: plans ?? [plan(w)] };
  const container = over.container ?? newContainer();
  const changes = [];
  const panel = mountServicePlanManagementPanel({ getServicePlans: () => holder.plans, getPrescreenContext: () => w.prescreen, onChange: () => changes.push(1), runtime: env.runtime, ...over, container });
  return { w, container, panel, changes, holder, ...env };
}
const bound = (over = {}, w = world()) => { const env = mount(w, [plan(w, over)]); pick(selectOf(cardOf(env.container, "map-plan:1")), "service:actual"); return env; };

test("mounting needs a container, the map plans getter and a runtime that can be read", () => {
  const w = world();
  const { runtime } = spy(w);
  assert.throws(() => mountServicePlanManagementPanel({ runtime, getServicePlans: () => [] }), /container/);
  assert.throws(() => mountServicePlanManagementPanel({ container: newContainer(), runtime }), /getServicePlans/);
  assert.throws(() => mountServicePlanManagementPanel({ container: newContainer(), getServicePlans: () => [] }), /ScenarioRuntime/);
  assert.throws(() => mountServicePlanManagementPanel({ container: newContainer(), runtime: { report() {} }, getServicePlans: () => [] }), /operationalState/);
});

test("it only reads: frozen inputs stay untouched and no timetable assess / approve / activate is ever called", () => {
  const w = world();
  deepFreeze(w.services); deepFreeze(w.prescreen);
  const plans = deepFreeze([plan(w), plan(w, { servicePlanId: "map-plan:2" })]);
  const before = JSON.stringify(snapshotOperationalState(w.state));
  const env = mount(w, plans);
  pick(selectOf(cardOf(env.container, "map-plan:1")), "service:actual");
  env.panel.refresh();
  assert.deepEqual(env.calls.forbidden, []);
  assert.ok(env.calls.reports > 0);
  assert.equal(JSON.stringify(snapshotOperationalState(w.state)), before);
  assert.ok(shows(env.container, SCOPE_NOTICE));
});

test("with no map plans the panel says so and offers nothing to connect", () => {
  const env = mount(world(), []);
  assert.ok(shows(env.container, "지도에 서비스 계획이 없습니다"));
  assert.equal(all(env.container, (n) => n.tag === "select").length, 0);
  assert.deepEqual(env.panel.results(), []);
  assert.deepEqual(env.panel.readyPlans(), []);
});

test("map plans are listed in servicePlanId order with their drawn facts, whatever order the map returned them in", () => {
  const w = world();
  const env = mount(w, [plan(w, { servicePlanId: "map-plan:b", name: null }), plan(w, { servicePlanId: "map-plan:a", active: false })]);
  assert.deepEqual(env.panel.results().map((row) => row.servicePlanId), ["map-plan:a", "map-plan:b"]);
  assert.ok(shows(cardOf(env.container, "map-plan:a"), "활성 아니오"));
  assert.ok(shows(cardOf(env.container, "map-plan:b"), "활성 예"));
  assert.ok(shows(cardOf(env.container, "map-plan:b"), "운행 방식 full · 시간대 1개 · 방향 2개"));
});

test("servicePlanId and serviceId are shown as two different kinds of ID, and the panel explains it", () => {
  const env = mount();
  assert.ok(shows(env.container, ID_KIND_NOTICE));
  const card = cardOf(env.container, "map-plan:1");
  const planId = all(card, (n) => classes(n).includes("svcplan-id-plan"))[0];
  const serviceId = all(card, (n) => classes(n).includes("svcplan-id-service"))[0];
  assert.deepEqual(texts(planId), ["지도 계획 ID (설계 문서)", "map-plan:1"]);
  assert.deepEqual(texts(serviceId), ["개통 서비스 ID (경영 서비스)", "연결 안 됨"]);
  pick(selectOf(card), "service:actual");
  const after = cardOf(env.container, "map-plan:1");
  assert.deepEqual(texts(all(after, (n) => classes(n).includes("svcplan-id-service"))[0]).slice(0, 2), ["개통 서비스 ID (경영 서비스)", "service:actual"]);
});

test("a plan is never tied to a service by its id, its name or its position: the connection starts empty and only the player's choice sets it", () => {
  const w = world();
  w.services = [{ id: "map-plan:1", operationalLineId: w.line.id, name: "Morning plan" }, { id: "service:actual", operationalLineId: w.line.id }];
  const env = mount(w);
  const row = env.panel.results()[0];
  assert.equal(row.serviceId, null);
  assert.equal(row.readiness, "unbound");
  assert.equal(env.panel.document.bindings.length, 0);
  assert.equal(env.panel.readyPlans().length, 0);
  assert.ok(shows(cardOf(env.container, "map-plan:1"), "서비스 연결 필요"));
  assert.ok(shows(cardOf(env.container, "map-plan:1"), "explicit-management-service-binding-required"));
});

test("choosing a service writes the binding and shows the C1 result; only a ready adaptation is called ready for timetable assessment", () => {
  const env = mount();
  assert.notEqual(readinessOf(cardOf(env.container, "map-plan:1")), READY);
  pick(selectOf(cardOf(env.container, "map-plan:1")), "service:actual");
  assert.deepEqual(env.panel.document.bindings, [{ servicePlanId: "map-plan:1", serviceId: "service:actual", servicePlanRevision: "rev:1" }]);
  assert.equal(env.changes.length, 1);
  assert.equal(readinessOf(cardOf(env.container, "map-plan:1")), READY);
  assert.ok(shows(cardOf(env.container, "map-plan:1"), "시간표 변환 확인(C1): ready"));
  const direct = adaptServicePlanToOperationalTimetable({ servicePlan: env.holder.plans[0], binding: { servicePlanId: "map-plan:1", serviceId: "service:actual" }, operationalState: env.w.state, services: env.w.services, prescreenContext: env.w.prescreen });
  assert.equal(direct.status, "ready");
  assert.deepEqual(env.panel.readyPlans(), [{ servicePlanId: "map-plan:1", serviceId: "service:actual", operationalRequest: direct.operationalRequest }]);
  assert.deepEqual(env.calls.forbidden, []);
});

test("clearing the choice removes the binding and the plan is no longer ready", () => {
  const env = bound();
  pick(selectOf(cardOf(env.container, "map-plan:1")), "");
  assert.deepEqual(env.panel.document.bindings, []);
  assert.equal(env.changes.length, 2);
  assert.equal(env.panel.readyPlans().length, 0);
  assert.notEqual(readinessOf(cardOf(env.container, "map-plan:1")), READY);
});

test("E1's verdicts are shown for plan / line / technical / fleet / track, each with its engine code", () => {
  const env = bound();
  const card = cardOf(env.container, "map-plan:1");
  for (const [area, label] of [["plan", "계획"], ["line", "운행선"], ["technical", "기술사양"], ["fleet", "차량"], ["track", "선로·종착"]]) {
    assert.deepEqual(texts(areaChip(card, area)), [label, "막힘 없음 (possible)"], area);
  }
  assert.ok(shows(card, "사전심사(E1) — 전체 막힘 없음 (possible)"));
  assert.ok(shows(card, PRESCREEN_NOTICE));
  assert.ok(shows(card, "minimum-headway"));
});

test("an unknown fact stays unknown on screen: missing fleet data is not turned into 'no problem' and the plan is not ready", () => {
  const w = world();
  w.prescreen = { ...w.prescreen, vehicleOrders: undefined };
  const env = bound({}, w);
  const card = cardOf(env.container, "map-plan:1");
  assert.deepEqual(texts(areaChip(card, "fleet")), ["차량", "미상 (unknown)"]);
  assert.ok(shows(card, "fleet-data-missing"));
  assert.notEqual(readinessOf(card), READY);
  assert.equal(env.panel.readyPlans().length, 0);
  assert.ok(shows(card, "사전심사(E1) — 전체 미상 (unknown)"));
});

test("an impossible technical fit is shown as impossible and blocks the plan", () => {
  const w = world();
  w.prescreen.technicalSpecs[w.line.id] = { technicalSpecification: { runningSystemId: "steel-wheel", gaugeMm: 1067 }, capacityTrainsPerHour: 20 };
  const env = bound({}, w);
  const card = cardOf(env.container, "map-plan:1");
  assert.deepEqual(texts(areaChip(card, "technical")), ["기술사양", "불가 (impossible)"]);
  assert.ok(shows(card, "technical:gauge"));
  assert.ok(readinessOf(card).startsWith("차단"));
  assert.equal(env.panel.readyPlans().length, 0);
});

test("stale map and stale capacity application block the plan with their reasons", () => {
  const stale = bound({ revision: { state: "stale" } });
  const card = cardOf(stale.container, "map-plan:1");
  assert.ok(readinessOf(card).startsWith("차단"));
  assert.ok(shows(card, "지도가 바뀐 뒤 확인하지 않은 낡은 계획(stale) (map-revision-stale)"));
  const application = bound({ capacityApplicationState: "stale" });
  assert.ok(shows(cardOf(application.container, "map-plan:1"), "capacity-application-stale"));
  assert.ok(readinessOf(cardOf(application.container, "map-plan:1")).startsWith("차단"));
  const unrecorded = bound({ revision: { state: "not-recorded" } });
  assert.ok(shows(cardOf(unrecorded.container, "map-plan:1"), "map-revision-not-current"));
  assert.notEqual(readinessOf(cardOf(unrecorded.container, "map-plan:1")), READY);
});

test("a plan on another operating line or other track segments is blocked and both sides are shown", () => {
  const w = world();
  const line = bound({ operationalLineId: "line:other" }, w);
  assert.ok(shows(cardOf(line.container, "map-plan:1"), "지도 line:other / 실제 " + w.line.id));
  assert.notEqual(readinessOf(cardOf(line.container, "map-plan:1")), READY);
  const route = bound({ route: { sections: [{ trackSegmentId: "other", traversal: "forward" }] } });
  const card = cardOf(route.container, "map-plan:1");
  assert.ok(shows(card, "지도 [other] / 실제 [ab]"));
  assert.ok(readinessOf(card).startsWith("차단"));
});

test("short-turn and partial-section plans are unsupported and say which kind", () => {
  for (const [pattern, label] of [["short-turn", "단축 운행"], ["partial-section", "일부 구간만 운행"]]) {
    const env = bound({ playerInputs: { operatingPattern: pattern } });
    const card = cardOf(env.container, "map-plan:1");
    assert.ok(readinessOf(card).startsWith("지원하지 않는 계획"), pattern);
    assert.ok(shows(card, `전체 노선 운행이 아님 — ${label}`), pattern);
    assert.equal(env.panel.readyPlans().length, 0);
  }
  assert.ok(shows(cardOf(bound({ playerInputs: {} }).container, "map-plan:1"), "운행 방식 미기재"));
});

test("a one-way plan, several operating bands and a missing terminal resource each show their reason and are not ready", () => {
  const oneWay = bound({ directions: [{ key: "out", fromStationId: "A", toStationId: "B", physicalConnection: true }] });
  assert.ok(shows(cardOf(oneWay.container, "map-plan:1"), "노선 전체 양방향이 아님(편도이거나 일부 구간 방향)"));
  const bands = [
    { bandId: "band:1", operating: true, startMinute: 360, endMinute: 600, playerRequestedHeadwayMinutes: 10, directionKeys: ["out", "back"] },
    { bandId: "band:2", operating: true, startMinute: 900, endMinute: 1080, playerRequestedHeadwayMinutes: 8, directionKeys: ["out", "back"] },
  ];
  const several = bound({ serviceBands: bands });
  const severalCard = cardOf(several.container, "map-plan:1");
  assert.ok(shows(severalCard, "운행 시간대가 여러 개임(시간표 심사는 한 시간대만 받음) — band:1, band:2"));
  assert.ok(readinessOf(severalCard).startsWith("지원하지 않는 계획"));
  const noTerminal = bound({ turnbacks: [] });
  assert.ok(shows(cardOf(noTerminal.container, "map-plan:1"), "끝 역의 종착 자원을 고르지 않음 — 역 B"));
  assert.notEqual(readinessOf(cardOf(noTerminal.container, "map-plan:1")), READY);
  for (const env of [oneWay, several, noTerminal]) assert.equal(env.panel.readyPlans().length, 0);
});

test("an inactive plan is blocked; an unknown physical connection stays unknown", () => {
  assert.ok(readinessOf(cardOf(bound({ active: false }).container, "map-plan:1")).startsWith("차단"));
  const unknown = bound({ directions: [{ key: "out", fromStationId: "A", toStationId: "B", physicalConnection: null }, { key: "back", fromStationId: "B", toStationId: "A", physicalConnection: true }] });
  assert.ok(shows(cardOf(unknown.container, "map-plan:1"), "direction-physical-connection-unknown"));
  assert.notEqual(readinessOf(cardOf(unknown.container, "map-plan:1")), READY);
});

test("a through service can be chosen but is unsupported; a service the runtime lacks is shown as missing", () => {
  const w = world();
  w.throughServices = [{ throughServiceId: "through-service:1" }];
  w.state.throughServiceBindings = [{ throughServiceId: "through-service:1", operationalLineId: w.line.id }];
  w.line.managementServiceId = "through-service:1";
  const env = mount(w);
  assert.ok(shows(cardOf(env.container, "map-plan:1"), "through-service:1 · 직통 서비스"));
  pick(selectOf(cardOf(env.container, "map-plan:1")), "through-service:1");
  const card = cardOf(env.container, "map-plan:1");
  assert.ok(shows(card, "직통 서비스는 아직 지원하지 않음"));
  assert.ok(readinessOf(card).startsWith("지원하지 않는 계획"));
  const missing = mount(world());
  assert.deepEqual(missing.panel.loadDoc({ schema: SERVICE_PLAN_BINDING_DOC_SCHEMA, version: 1, bindings: [{ servicePlanId: "map-plan:1", serviceId: "service:gone", servicePlanRevision: "rev:1" }] }), { ok: true, issues: [] });
  const gone = cardOf(missing.container, "map-plan:1");
  assert.ok(shows(gone, "지금 경영에 없는 서비스"));
  assert.ok(shows(gone, "연결한 서비스가 지금 경영에 없음 — service:gone"));
  assert.ok(shows(gone, "service:gone · 지금 경영에 없음"));
  assert.notEqual(readinessOf(gone), READY);
});

test("two plans on one service are both held back, and each says who else is connected", () => {
  const w = world();
  const env = mount(w, [plan(w), plan(w, { servicePlanId: "map-plan:2" })]);
  pick(selectOf(cardOf(env.container, "map-plan:1")), "service:actual");
  assert.equal(readinessOf(cardOf(env.container, "map-plan:1")), READY);
  pick(selectOf(cardOf(env.container, "map-plan:2")), "service:actual");
  for (const [id, other] of [["map-plan:1", "map-plan:2"], ["map-plan:2", "map-plan:1"]]) {
    const card = cardOf(env.container, id);
    assert.ok(readinessOf(card).startsWith("같은 서비스에 여러 계획이 연결됨"), id);
    assert.ok(shows(card, `같은 서비스에 다른 계획도 연결됨: ${other}`), id);
    assert.ok(shows(card, "연결 문제 때문에 심사에 넘기지 않습니다"), id);
  }
  assert.deepEqual(env.panel.readyPlans(), []);
  pick(selectOf(cardOf(env.container, "map-plan:2")), "");
  assert.equal(readinessOf(cardOf(env.container, "map-plan:1")), READY);
});

test("when the map plan changes after it was connected the connection stays, with a warning to re-check it", () => {
  const w = world();
  const env = mount(w);
  pick(selectOf(cardOf(env.container, "map-plan:1")), "service:actual");
  assert.ok(!shows(env.container, "연결한 뒤 지도 계획이 바뀜"));
  env.holder.plans = [plan(w, { servicePlanRevision: "rev:2" })];
  env.panel.refresh();
  assert.ok(shows(cardOf(env.container, "map-plan:1"), "연결한 뒤 지도 계획이 바뀜"));
  assert.equal(env.panel.results()[0].serviceId, "service:actual");
  assert.equal(env.panel.document.bindings[0].servicePlanRevision, "rev:1", "the stored revision is not silently updated");
});

test("a connection to a plan that is not on the map is kept in the document, listed, and removable", () => {
  const env = mount();
  env.panel.loadDoc({ schema: SERVICE_PLAN_BINDING_DOC_SCHEMA, version: 1, bindings: [{ servicePlanId: "map-plan:old", serviceId: "service:actual", servicePlanRevision: null }] });
  assert.ok(shows(env.container, "지도에 없는 계획의 연결 1개"));
  assert.ok(shows(env.container, "계획 map-plan:old → 서비스 service:actual"));
  assert.equal(JSON.parse(env.panel.serialize()).bindings.length, 1, "saving keeps it");
  pick(selectOf(cardOf(env.container, "map-plan:1")), "service:actual");
  assert.equal(env.panel.results().find((row) => row.servicePlanId === "map-plan:1").readiness, "ready", "an orphan binding does not count as a second plan");
  const before = env.changes.length;
  all(env.container, (n) => n.tag === "button" && n.textContent === "연결 지우기")[0].fire("click");
  assert.deepEqual(env.panel.document.bindings.map((b) => b.servicePlanId), ["map-plan:1"]);
  assert.equal(env.changes.length, before + 1);
});

test("the binding document round-trips byte for byte, sorted by plan id; a refused document leaves the current one alone and calls nothing", () => {
  const w = world();
  const env = mount(w, [plan(w), plan(w, { servicePlanId: "map-plan:2" })]);
  pick(selectOf(cardOf(env.container, "map-plan:2")), "service:actual");
  pick(selectOf(cardOf(env.container, "map-plan:1")), "service:actual");
  const saved = env.panel.serialize();
  assert.deepEqual(JSON.parse(saved).bindings.map((b) => b.servicePlanId), ["map-plan:1", "map-plan:2"]);
  const other = mount(w, [plan(w), plan(w, { servicePlanId: "map-plan:2" })]);
  const changes = other.changes.length;
  assert.deepEqual(other.panel.loadDoc(saved), { ok: true, issues: [] });
  assert.equal(other.panel.serialize(), saved);
  assert.equal(other.changes.length, changes, "loading is not a player change");
  for (const bad of ["{", "null", JSON.stringify({ schema: "x", version: 1, bindings: [] }), JSON.stringify({ schema: SERVICE_PLAN_BINDING_DOC_SCHEMA, version: 2, bindings: [] }),
    JSON.stringify({ schema: SERVICE_PLAN_BINDING_DOC_SCHEMA, version: 1, bindings: [{ servicePlanId: "a", serviceId: "s" }, { servicePlanId: "a", serviceId: "t" }] })]) {
    const result = other.panel.loadDoc(bad);
    assert.equal(result.ok, false);
    assert.ok(result.issues.length > 0);
    assert.equal(other.panel.serialize(), saved);
  }
  assert.deepEqual(env.calls.forbidden, []);
});

test("restoreBindingDoc refuses the whole document for any bad entry and never half loads", () => {
  const doc = (bindings) => ({ schema: SERVICE_PLAN_BINDING_DOC_SCHEMA, version: 1, bindings });
  assert.deepEqual(restoreBindingDoc(newBindingDoc()), { doc: newBindingDoc(), issues: [] });
  const cases = [
    [doc("x"), "binding-doc-bindings-invalid"],
    [doc([{ servicePlanId: "", serviceId: "s" }]), "binding-invalid:0"],
    [doc([{ servicePlanId: "a", serviceId: 1 }]), "binding-invalid:a"],
    [doc([{ servicePlanId: "a", serviceId: "s", servicePlanRevision: 5 }]), "binding-revision-invalid:a"],
    [doc([{ servicePlanId: "a", serviceId: "s" }, { servicePlanId: "a", serviceId: "t" }]), "binding-duplicate-plan:a"],
    [doc([{ servicePlanId: "ok", serviceId: "s" }, null]), "binding-invalid:1"],
  ];
  for (const [input, issue] of cases) {
    const out = restoreBindingDoc(input);
    assert.equal(out.doc, null);
    assert.ok(out.issues.includes(issue), `${issue} in ${out.issues}`);
  }
  assert.throws(() => serializeBindingDoc({ schema: "x" }), /invalid/);
  const sorted = restoreBindingDoc(doc([{ servicePlanId: "b", serviceId: "s" }, { servicePlanId: "a", serviceId: "s", servicePlanRevision: "r" }])).doc;
  assert.deepEqual(sorted.bindings, [{ servicePlanId: "a", serviceId: "s", servicePlanRevision: "r" }, { servicePlanId: "b", serviceId: "s", servicePlanRevision: null }]);
});

test("refresh reads the engine again: a new vehicle order turns an unknown plan ready, and a new map plan appears", () => {
  const w = world();
  w.prescreen = { ...w.prescreen, vehicleOrders: undefined };
  const env = bound({}, w);
  assert.equal(env.panel.readyPlans().length, 0);
  w.prescreen = { ...w.prescreen, vehicleOrders: [{ modelId: "medium_4car", stage: "accepted", quantity: 2, units: [{ id: "set:1", status: "available" }, { id: "set:2", status: "available" }] }] };
  env.panel.refresh();
  assert.equal(env.panel.readyPlans().length, 1);
  assert.equal(readinessOf(cardOf(env.container, "map-plan:1")), READY);
  env.holder.plans = [...env.holder.plans, plan(w, { servicePlanId: "map-plan:3" })];
  env.panel.refresh();
  assert.ok(cardOf(env.container, "map-plan:3"));
  assert.equal(env.panel.document.bindings.length, 1, "the binding survives a refresh");
});

test("a failing getter shows the error and keeps the panel alive; results() and readyPlans() hand out copies", () => {
  const w = world();
  const env = mount(w);
  pick(selectOf(cardOf(env.container, "map-plan:1")), "service:actual");
  env.panel.results()[0].serviceId = "tampered";
  env.panel.readyPlans()[0].operationalRequest.servicePlans.length = 0;
  env.panel.document.bindings.length = 0;
  assert.equal(env.panel.results()[0].serviceId, "service:actual");
  assert.equal(env.panel.readyPlans()[0].operationalRequest.servicePlans.length, 1);
  assert.equal(env.panel.document.bindings.length, 1);
  env.holder.plans = null;
  env.panel.refresh();
  assert.equal(env.panel.results().length, 0);
  const throwing = mount(world(), [], { getServicePlans: () => { throw new Error("map offline"); } });
  assert.ok(shows(throwing.container, "map offline"));
  assert.deepEqual(throwing.panel.readyPlans(), []);
});

test("the view builder is pure: the same inputs give the same rows and the inputs are not modified", () => {
  const w = world();
  const input = deepFreeze({ servicePlans: [plan(w)], doc: { bindings: [{ servicePlanId: "map-plan:1", serviceId: "service:actual", servicePlanRevision: "rev:1" }] }, context: { operationalState: null, services: w.services, throughServices: [], prescreenContext: {} } });
  const a = buildServicePlanPanelView(input);
  assert.deepEqual(buildServicePlanPanelView(input), a);
  assert.equal(a.rows[0].readiness, "unknown", "without an operational state nothing is ready");
  assert.equal(buildServicePlanPanelView().rows.length, 0);
});

test("the module keeps its promises: no localStorage, no timetable run/approve/activate call, no clock or random number", () => {
  const source = fs.readFileSync(fileURLToPath(new URL("../src/service-plan-management-ui.mjs", import.meta.url)), "utf8").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/localStorage|sessionStorage|indexedDB/.test(source));
  assert.ok(!/(assessOperationalRailwayTimetable|approveRailwayTimetable|activateRailwayTimetable)\s*\(/.test(source.replace(/\/\/.*$/gm, "")));
  assert.ok(!/Math\.random|Date\.now|new Date|performance\.now/.test(source));
  assert.ok(!/from "\.\/(management|map)\//.test(source));
  assert.deepEqual([...source.matchAll(/^import .* from "(.*)";$/gm)].map((m) => m[1]), ["./service-plan-timetable-adapter.mjs"]);
  // a document whose window would throw on any storage access: the panel works and never touches it
  const hostileDoc = { createElement: dom.createElement, defaultView: { localStorage: new Proxy({}, { get() { throw new Error("storage must not be touched"); } }) } };
  const env = mount(world(), null, { container: newContainer(hostileDoc) });
  pick(selectOf(cardOf(env.container, "map-plan:1")), "service:actual");
  assert.equal(readinessOf(cardOf(env.container, "map-plan:1")), READY);
});

test("it computes no demand, money, crowding or timetable figure of its own: nothing on screen is a figure other than a count or a value the plan carries", () => {
  const env = bound();
  const body = texts(env.container).join("\n");
  const stripped = [SCOPE_NOTICE, PRESCREEN_NOTICE, ID_KIND_NOTICE].reduce((rest, notice) => rest.replace(notice, ""), body);
  assert.ok(!/수요|승객|운임|비용|혼잡|수익|엔\b|원\b|승\/시|분 간격/.test(stripped), stripped);
});

// --- end to end against the real ScenarioRuntime ---
test("against a real ScenarioRuntime the panel reads services and pools, changes nothing, and reaches the same answer as the adapter", () => {
  const w = world();
  const runtime = new ScenarioRuntime({ pack: PACK, operationalState: w.state, networkMode: "scratch", seed: 3 });
  runtime.game.services.push(...w.services);
  runtime.game.vehicleOrders.push({ id: "order:1", modelId: "medium_4car", stage: "accepted", quantity: 2, units: [{ id: "set:1", status: "available" }, { id: "set:2", status: "available" }] });
  const forbidden = [];
  const watched = { operationalState: runtime.operationalState, report: () => runtime.report(), game: runtime.game };
  for (const name of ["assessOperationalRailwayTimetable", "approveRailwayTimetable", "activateRailwayTimetable"]) watched[name] = (...args) => { forbidden.push(name); return runtime[name](...args); };
  const snapshot = () => ({ state: JSON.stringify(snapshotOperationalState(runtime.operationalState)), report: JSON.stringify(runtime.report()), orders: JSON.stringify(runtime.game.vehicleOrders) });
  const before = snapshot();
  const container = newContainer();
  const given = { technicalSpecs: w.prescreen.technicalSpecs };
  const panel = mountServicePlanManagementPanel({ container, runtime: watched, getServicePlans: () => [plan(w)], getPrescreenContext: () => given });
  pick(selectOf(cardOf(container, "map-plan:1")), "service:actual");
  assert.ok(shows(container, "service:actual · 일반 서비스 · Actual Line"));
  assert.equal(readinessOf(cardOf(container, "map-plan:1")), READY, JSON.stringify(panel.results()[0].adaptation.issues));
  const report = runtime.report();
  const direct = adaptServicePlanToOperationalTimetable({
    servicePlan: plan(w), binding: { servicePlanId: "map-plan:1", serviceId: "service:actual" }, operationalState: runtime.operationalState,
    services: report.services, throughServices: report.throughServices,
    prescreenContext: { technicalSpecs: given.technicalSpecs, vehicleOrders: runtime.game.vehicleOrders, operatingResourcePools: report.operatingResourcePools },
  });
  assert.deepEqual(panel.readyPlans()[0].operationalRequest, direct.operationalRequest);
  assert.deepEqual(forbidden, []);
  assert.deepEqual(snapshot(), before);
  runtime.game.vehicleOrders.length = 0;
  panel.refresh();
  assert.equal(panel.readyPlans().length, 0, "no vehicles on record: impossible, never ready");
  assert.deepEqual(texts(areaChip(cardOf(container, "map-plan:1"), "fleet")), ["차량", "불가 (impossible)"]);
});
