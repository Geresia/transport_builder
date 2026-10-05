import test from "node:test";
import assert from "node:assert/strict";
import { buildRailwayDetourManagementView, mountRailwayDetourManagementPanel, MAP_NOTICE, OPERATION_NOTICE } from "../src/railway-detour-management-ui.mjs";
import { ScenarioRuntime } from "../src/scenario-runtime.mjs";
import { createState } from "../src/state.mjs";
import { advanceRailwayDetourOperations } from "../src/railway-detour-operations.mjs";

// --- a minimal DOM: elements, listeners, replaceChildren ---
class Node_ {
  constructor(tag) { Object.assign(this, { tag, children: [], className: "", textContent: "", value: "", checked: false, disabled: false, listeners: {} }); }
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
const button = (node, label) => { const b = all(node, (n) => n.tag === "button" && n.textContent === label)[0]; assert.ok(b, `button ${label}`); return b; };
const click = (node, label) => button(node, label).fire("click");
const control = (node, label) => all(node, (n) => n.tag === "label" && n.className === "detour-field" && n.children[0].textContent === label)[0].children[1];
const check = (node, part, on = true) => { const box = all(node, (n) => n.tag === "label" && n.className === "detour-check" && n.children[1].textContent.includes(part))[0].children[0]; box.checked = on; box.fire("change"); };
const type = (input, value) => { input.value = value; input.fire("input"); };
const deepFreeze = (o) => { if (o && typeof o === "object") { Object.values(o).forEach(deepFreeze); Object.freeze(o); } return o; };

function geometry(overrides = {}) {
  return { schema: "transitline.railway-detour-service-geometry/1", contractVersion: 1, detourGeometryId: "detour:1", detourGeometryRevision: "detour-rev:1", eventId: "event:1", selectedDetourCandidateId: "cand:1", controlGeometryId: "control:1", controlGeometryRevision: "rev:1", affectedTrackSegmentIds: ["track:closed"], lengthMeters: 12_000, connections: [{ connectionId: "connection:1", physicalConnection: true, gapMeters: 0 }], legs: [{ legId: "leg:1", sourceKind: "external", externalNetworkId: "net:1", externalLineId: "line:1", externalSpecificationId: "spec:1", externalSpecificationRevision: "spec-rev:1", infrastructureOwnerId: "owner:1", trackSegmentId: null }], ...overrides };
}
const picksFor = (g = geometry()) => ({ [`${g.eventId}|${g.selectedDetourCandidateId}`]: { legIds: g.legs.map((l) => l.legId), connectionIds: g.connections.map((c) => c.connectionId), transferIds: [] } });
const outputOf = (g = geometry()) => ({ export: { detours: [g] }, picks: picksFor(g) });
function catalog() {
  return { schema: "transitline.external-infrastructure-catalog/1", entries: [{ externalNetworkId: "net:1", externalLineId: "line:1", specificationId: "spec:1", specificationRevision: "spec-rev:1", infrastructureOwnerId: "owner:1", technicalProfileId: "medium_steel", technicalSpecification: { runningSystemId: "steel-wheel", gaugeMm: 1435, carWidthM: 3, maxAxleLoadTonnes: 16, collectionSystemId: "overhead", currentSystem: "dc", voltageV: 1500, minimumCurveRadiusMeters: 160, maxGradientPermille: 35, signalSystemIds: ["ats-p"], platformHeightMm: 1100, doorLayoutId: "4-door-20m", minCars: 4, maxCars: 8, maintenanceSystemId: "medium_steel" }, notApplicable: [], capacityTrainsPerHour: 12 }] };
}
const AGREEMENT = deepFreeze({ id: "access:1", status: "active", infrastructureOwnerId: "owner:1", guestOperatorId: "player" });

// a runtime that only records what the panel asks of it
function spyRuntime({ assessment = null, authorization = null, operation = null, authorizations = [], operations = [], throwOn = {} } = {}) {
  const calls = { assess: [], authorize: [], start: [], authorizationReport: 0, operationReport: 0 };
  const runtime = {
    assessRailwayDetourAuthorization(input) { calls.assess.push(input); if (throwOn.assess) throw new Error(throwOn.assess); return assessment; },
    authorizeRailwayDetour(input) { calls.authorize.push(input); if (throwOn.authorize) throw new Error(throwOn.authorize); return authorization; },
    startRailwayDetourOperation(input) { calls.start.push(input); if (throwOn.start) throw new Error(throwOn.start); return operation; },
    railwayDetourAuthorizationReport() { calls.authorizationReport += 1; return authorizations; },
    railwayDetourOperationReport() { calls.operationReport += 1; return operations; },
  };
  return { runtime, calls };
}
const assessmentOf = (verdict, extra = {}) => ({ schema: "transitline.railway-detour-assessment/1", eventId: "event:1", controlOrderId: "order:1", detourGeometryId: "detour:1", detourGeometryRevision: "detour-rev:1", detourLengthMeters: 12_000, trainsPerHour: 6, verdict, violations: [], missingInputs: [], conditions: [], ...extra });
const authorizationRow = (extra = {}) => ({ id: "authorization:1", status: "authorized", eventId: "event:1", controlOrderId: "order:1", detourGeometryRevision: "detour-rev:1", vehicleModelId: "medium_4car", trainsPerHour: 6, detourLengthMeters: 12_000, endReason: null, ...extra });

function mount(over = {}, spy = spyRuntime()) {
  const container = newContainer();
  const changes = [];
  const panel = mountRailwayDetourManagementPanel({ container, runtime: spy.runtime, getDetourOutput: () => outputOf(), getExternalInfrastructureCatalog: () => catalog(), getTrackAccessAgreements: () => [AGREEMENT], onChange: () => changes.push(1), ...over });
  return { container, panel, changes, ...spy };
}

test("mounting only reads: no engine mutation before the player acts, inputs stay untouched", () => {
  const output = deepFreeze(outputOf()); const frozenCatalog = deepFreeze(catalog());
  const env = mount({ getDetourOutput: () => output, getExternalInfrastructureCatalog: () => frozenCatalog });
  env.panel.refresh();
  assert.deepEqual([env.calls.assess.length, env.calls.authorize.length, env.calls.start.length, env.changes.length], [0, 0, 0, 0]);
  assert.ok(env.calls.authorizationReport > 0 && env.calls.operationReport > 0);
  assert.ok(shows(env.container, MAP_NOTICE)); assert.ok(shows(env.container, OPERATION_NOTICE));
  assert.ok(shows(env.container, "geometry revision")); assert.ok(shows(env.container, "detour-rev:1")); assert.ok(shows(env.container, "12.0 km"));
  assert.ok(shows(env.container, "1/1"));
});

test("an empty geometry shows an honest empty state with no review controls", () => {
  for (const out of [null, { export: { detours: [] }, picks: {} }, { export: { detours: [{ schema: "wrong" }] } }]) {
    const env = mount({ getDetourOutput: () => out });
    assert.ok(shows(env.container, "확정된 우회 경로(M10)가 없습니다"));
    assert.equal(all(env.container, (n) => n.tag === "button" && n.textContent === "사전 검토").length, 0);
    assert.ok(shows(env.container, MAP_NOTICE));
  }
  assert.deepEqual(buildRailwayDetourManagementView().detourOptions, []);
});

test("unknown distance and connection facts are shown as unknown, never filled in", () => {
  const g = geometry({ lengthMeters: null, connections: [{ connectionId: "c:true", physicalConnection: true, gapMeters: 3 }, { connectionId: "c:false", physicalConnection: false, gapMeters: 250 }, { connectionId: "c:null", physicalConnection: null, gapMeters: null }] });
  const env = mount({ getDetourOutput: () => outputOf(g) });
  const lengthMetric = all(env.container, (n) => n.className === "detour-metric" && n.children[0].textContent === "우회 거리")[0];
  assert.equal(lengthMetric.children[1].textContent, "미상");
  assert.ok(shows(env.container, "c:true · ● 접속 확인(true) · 간격 3 m"));
  assert.ok(shows(env.container, "c:false · ✕ 물리적으로 분리(false) · 간격 250 m"));
  assert.ok(shows(env.container, "c:null · ? 접속 미확인(null) · 간격 미상"));
  const classes = all(env.container, (n) => n.className.startsWith("detour-connection")).map((n) => n.className);
  assert.deepEqual(classes, ["detour-connection state-true", "detour-connection state-false", "detour-connection state-null"]);
});

test("review sends the exact request, copies instead of aliasing inputs, and shows the engine assessment as given", () => {
  const output = deepFreeze(outputOf()); const frozenCatalog = deepFreeze(catalog());
  const spy = spyRuntime({ assessment: assessmentOf("conditional", { violations: ["leg:leg:1:capacity-exceeded"], missingInputs: ["connection:connection:1:physicalConnection"], conditions: ["leg:leg:1:trackAccessAgreementRequired"], detourLengthMeters: null }) });
  let catalogGeometry = null;
  const env = mount({ getDetourOutput: () => output, getExternalInfrastructureCatalog: (current) => { catalogGeometry = current; return frozenCatalog; } }, spy);
  type(control(env.container, "관제명령"), " order:1 ");
  type(control(env.container, "시간당 운행횟수"), "9");
  const model = control(env.container, "차량 모델"); model.value = "large_8car"; model.fire("change");
  check(env.container, "access:1"); check(env.container, "접속이 확인되지 않은"); check(env.container, "조건부 기술호환");
  assert.equal(spy.calls.assess.length, 0);
  click(env.container, "사전 검토");
  assert.equal(spy.calls.assess.length, 1);
  assert.equal(catalogGeometry?.detourGeometryId, "detour:1");
  assert.deepEqual(spy.calls.assess[0], {
    eventId: "event:1", controlOrderId: "order:1", detourGeometry: geometry(), detourGeometryRevision: "detour-rev:1",
    picks: { legIds: ["leg:1"], connectionIds: ["connection:1"], transferIds: [] },
    vehicleModelId: "large_8car", trainsPerHour: 9, trackAccessAgreementIds: ["access:1"], confirmUnknownConnections: true, confirmConditionalTechnical: true,
    externalInfrastructureCatalog: catalog(), trackAccessAgreements: [AGREEMENT],
  });
  assert.notEqual(spy.calls.assess[0].detourGeometry, output.export.detours[0]);
  assert.ok(shows(env.container, "조건부"));
  assert.ok(shows(env.container, "위반 1건") && shows(env.container, "leg:leg:1:capacity-exceeded"));
  assert.ok(shows(env.container, "누락 정보 1건") && shows(env.container, "connection:connection:1:physicalConnection"));
  assert.ok(shows(env.container, "조건 1건") && shows(env.container, "leg:leg:1:trackAccessAgreementRequired"));
  const groups = ["violations", "missingInputs", "conditions"].map((f) => all(env.container, (n) => n.className === `detour-diag detour-${f}`).length);
  assert.deepEqual(groups, [1, 1, 1]);
  assert.equal(button(env.container, "우회 승인").disabled, true);
  assert.equal(spy.calls.authorize.length, 0);
});

test("without an agreement getter the request leaves agreements to the runtime", () => {
  const spy = spyRuntime({ assessment: assessmentOf("possible") });
  const env = mount({ getTrackAccessAgreements: undefined }, spy);
  type(control(env.container, "관제명령"), "order:1");
  click(env.container, "사전 검토");
  assert.equal("trackAccessAgreements" in spy.calls.assess[0], false);
  assert.ok(shows(env.container, "표시할 선로사용 계약이 없습니다"));
});

test("engine errors from review are shown verbatim and leave nothing approvable", () => {
  const spy = spyRuntime({ throwOn: { assess: "Every detour leg must be explicitly selected" } });
  const env = mount({}, spy);
  click(env.container, "사전 검토");
  assert.ok(shows(env.container, "Every detour leg must be explicitly selected"));
  assert.equal(button(env.container, "우회 승인").disabled, true);
});

test("only a possible verdict can be approved, with the same payload, and the result is shown with its revision", () => {
  for (const verdict of ["conditional", "unknown", "impossible"]) {
    const spy = spyRuntime({ assessment: assessmentOf(verdict, { violations: ["v"] }) });
    const env = mount({}, spy);
    click(env.container, "사전 검토");
    assert.ok(shows(env.container, { conditional: "조건부", unknown: "정보 부족", impossible: "불가" }[verdict]));
    assert.equal(button(env.container, "우회 승인").disabled, true);
    button(env.container, "우회 승인").fire("click");
    assert.equal(spy.calls.authorize.length, 0);
  }
  const spy = spyRuntime({ assessment: assessmentOf("possible"), authorization: authorizationRow({ detourGeometryRevision: "detour-rev:1" }) });
  const env = mount({}, spy);
  type(control(env.container, "관제명령"), "order:1");
  click(env.container, "사전 검토");
  assert.equal(button(env.container, "우회 승인").disabled, false);
  button(env.container, "우회 승인").fire("click");
  assert.equal(spy.calls.authorize.length, 1);
  assert.deepEqual(spy.calls.authorize[0], spy.calls.assess[0]);
  assert.equal(env.changes.length, 1);
  assert.ok(shows(env.container, "승인됨 · authorization:1 · geometry revision detour-rev:1"));
});

test("changing an input or the geometry revision after review discards the stale assessment", () => {
  const spy = spyRuntime({ assessment: assessmentOf("possible") });
  const env = mount({}, spy);
  click(env.container, "사전 검토");
  assert.equal(button(env.container, "우회 승인").disabled, false);
  type(control(env.container, "시간당 운행횟수"), "7");
  assert.equal(all(env.container, (n) => n.className.startsWith("detour-assessment")).length, 0);
  assert.equal(button(env.container, "우회 승인").disabled, true);
  let current = outputOf();
  const moving = mount({ getDetourOutput: () => current }, spyRuntime({ assessment: assessmentOf("possible") }));
  click(moving.container, "사전 검토");
  assert.equal(all(moving.container, (n) => n.className.startsWith("detour-assessment")).length, 1);
  current = outputOf(geometry({ detourGeometryRevision: "detour-rev:2" }));
  moving.panel.refresh();
  assert.equal(all(moving.container, (n) => n.className.startsWith("detour-assessment")).length, 0);
});

test("a duplicate approval surfaces the engine error honestly and does not notify the host", () => {
  const spy = spyRuntime({ assessment: assessmentOf("possible"), throwOn: { authorize: "Control order order:1 already has an authorized detour" } });
  const env = mount({}, spy);
  click(env.container, "사전 검토"); button(env.container, "우회 승인").fire("click");
  assert.ok(shows(env.container, "already has an authorized detour"));
  assert.equal(env.changes.length, 0);
});

test("start sends only the authorizationId, and only approved authorizations are selectable", () => {
  const authorizations = [authorizationRow({ id: "authorization:old", status: "ended", endReason: "disruption-ended" }), authorizationRow()];
  const spy = spyRuntime({ authorizations, operation: { id: "operation:1" } });
  const env = mount({}, spy);
  const options = all(control(env.container, "승인된 우회"), (n) => n.tag === "option").map((o) => o.value);
  assert.deepEqual(options, ["authorization:1"]);
  assert.ok(shows(env.container, "장애 종료"));
  click(env.container, "임시 운행 시작");
  assert.deepEqual(spy.calls.start, [{ authorizationId: "authorization:1" }]);
  assert.equal(env.changes.length, 1);
  const none = mount({}, spyRuntime({ authorizations: [authorizationRow({ status: "ended" })] }));
  assert.equal(button(none.container, "임시 운행 시작").disabled, true);
});

test("operation figures are the engine's report verbatim; the panel computes no money, time or verdict", () => {
  const operations = deepFreeze([{ id: "operation:1", status: "active", authorizationId: "authorization:1", detourLengthMeters: 12_000, endReason: null, accruedTrainKilometres: 72, accruedTrainMinutes: 96, settledOperatingCostJPY: 777, settledAccessCostJPY: 31 }, { id: "operation:2", status: "ended", authorizationId: "authorization:2", detourLengthMeters: null, endReason: "disruption-or-control-ended", accruedTrainKilometres: 0, accruedTrainMinutes: 0, settledOperatingCostJPY: 0, settledAccessCostJPY: 0 }]);
  const env = mount({}, spyRuntime({ operations, authorizations: deepFreeze([authorizationRow()]) }));
  assert.ok(shows(env.container, "운행 중 · operation:1"));
  assert.ok(shows(env.container, "종료 · operation:2 · 장애 또는 관제명령 종료"));
  const metricOf = (label, n = 0) => all(env.container, (m) => m.className === "detour-metric" && m.children[0].textContent === label)[n].children[1].textContent;
  assert.equal(metricOf("누적 열차-km"), "72.0");
  assert.match(metricOf("정산된 운행비"), /777/);
  assert.match(metricOf("정산된 선로사용료"), /31/);
  assert.equal(metricOf("우회 거리", 2), "미상"); // operation:2 has no measured length; it is not estimated
  // the only yen figures on screen are the report's four settled values: nothing is derived from train-km
  const money = texts(env.container).filter((t) => /[￥¥]/.test(t));
  assert.equal(money.length, 4);
  assert.equal(money.filter((t) => /[￥¥]777$|[￥¥]31$/.test(t)).length, 2);
  assert.equal(money.filter((t) => /[￥¥]0$/.test(t)).length, 2);
});

// --- end to end against the real ScenarioRuntime ---
function realWorld() {
  const pack = { manifest: { id: "detour-management-ui", version: "1", data: { license: "test", attribution: [] } }, demand: { model: "gravity", points: [], attractors: [] } };
  const operational = createState(pack);
  Object.assign(operational, {
    simMinutes: 10,
    railwayDisruptions: { events: [{ id: "event:1", status: "active" }] },
    railwayControlOrders: { orders: [{ id: "order:1", status: "active", eventId: "event:1", controlGeometryId: "control:1", controlGeometryRevision: "rev:1", suspendedTrackSegmentIds: ["track:closed"] }] },
  });
  return { operational, runtime: new ScenarioRuntime({ pack, operationalState: operational }) };
}

test("full flow on the real runtime: review, approve, duplicate rejected, start, accrue; report copies cannot change the engine", () => {
  const { operational, runtime } = realWorld();
  const agreements = [{ id: "access:1", status: "active", infrastructureOwnerId: "owner:1", guestOperatorId: runtime.game.player.id }];
  const output = deepFreeze(outputOf()); const frozenCatalog = deepFreeze(catalog());
  const env = mount({ runtime, getDetourOutput: () => output, getExternalInfrastructureCatalog: () => frozenCatalog, getTrackAccessAgreements: () => agreements }, { runtime });
  const snapshot = () => structuredClone({ a: operational.railwayDetourAuthorizations, o: operational.railwayDetourOperations, cash: runtime.game.ledger.cash });
  const pristine = snapshot();

  click(env.container, "사전 검토"); // no control order typed -> the engine says so
  assert.ok(shows(env.container, "Railway control order"));
  assert.deepEqual(snapshot(), pristine);

  type(control(env.container, "관제명령"), "order:1");
  click(env.container, "사전 검토");
  assert.ok(shows(env.container, "승인 가능")); assert.deepEqual(snapshot(), pristine);
  assert.equal(button(env.container, "임시 운행 시작").disabled, true);

  button(env.container, "우회 승인").fire("click");
  assert.equal(runtime.railwayDetourAuthorizationReport().length, 1);
  assert.equal(env.changes.length, 1);
  assert.ok(shows(env.container, "승인됨 · railway-detour-authorization:1 · geometry revision detour-rev:1"));

  click(env.container, "사전 검토"); button(env.container, "우회 승인").fire("click"); // same control order again
  assert.ok(shows(env.container, "already has an authorized detour"));
  assert.equal(runtime.railwayDetourAuthorizationReport().length, 1);

  click(env.container, "임시 운행 시작");
  const [operation] = runtime.railwayDetourOperationReport();
  assert.equal(operation.status, "active"); assert.equal(operation.authorizationId, "railway-detour-authorization:1");
  assert.ok(shows(env.container, "운행 중 · railway-detour-operation:1"));

  operational.simMinutes += 60;
  advanceRailwayDetourOperations(operational, 3600);
  runtime.settleRailwayDetourOperations();
  env.panel.refresh();
  const settled = runtime.railwayDetourOperationReport()[0];
  assert.equal(settled.accruedTrainKilometres, 72);
  assert.ok(shows(env.container, "72.0"));
  assert.ok(shows(env.container, new Intl.NumberFormat("ja-JP", { style: "currency", currency: "JPY", maximumFractionDigits: 0 }).format(settled.settledOperatingCostJPY)));

  // mutating what a report hands out never reaches the engine
  const before = snapshot();
  const report = runtime.railwayDetourOperationReport(); report[0].status = "hacked"; report[0].settledOperatingCostJPY = 1;
  const authReport = runtime.railwayDetourAuthorizationReport(); authReport[0].status = "hacked"; authReport.length = 0;
  assert.deepEqual(snapshot(), before);
  assert.equal(runtime.railwayDetourOperationReport()[0].status, "active");
});

test("the panel never persists detour state itself", () => {
  const writes = [];
  const had = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null, setItem: (k) => writes.push(k), removeItem: (k) => writes.push(k) } });
  try {
    const spy = spyRuntime({ assessment: assessmentOf("possible"), authorization: authorizationRow(), operation: { id: "operation:1" }, authorizations: [authorizationRow()] });
    const env = mount({}, spy);
    click(env.container, "사전 검토"); button(env.container, "우회 승인").fire("click"); click(env.container, "임시 운행 시작");
  } finally { if (had) Object.defineProperty(globalThis, "localStorage", had); else delete globalThis.localStorage; }
  assert.deepEqual(writes, []);
});

test("mount refuses a missing container or an incomplete runtime", () => {
  assert.throws(() => mountRailwayDetourManagementPanel({ runtime: spyRuntime().runtime }), /container/);
  assert.throws(() => mountRailwayDetourManagementPanel({ container: newContainer(), runtime: {} }), /assessRailwayDetourAuthorization/);
});
