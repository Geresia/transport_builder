import test from "node:test";
import assert from "node:assert/strict";
import { buildRailwayServiceControlView, mountRailwayServiceControlManagementPanel, MAP_NOTICE, SCOPE_NOTICE } from "../src/railway-service-control-management-ui.mjs";
import { restoreOperationalState, snapshotOperationalState } from "../src/integrated-save.mjs";
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
const doc = { createElement: (tag) => new Node_(tag) };
const newContainer = () => Object.assign(new Node_("div"), { ownerDocument: doc });
const all = (node, pred = () => true) => [pred(node) ? node : null, ...node.children.flatMap((c) => all(c, pred))].filter(Boolean);
const texts = (node) => all(node).map((n) => n.textContent).filter(Boolean);
const shows = (node, part) => texts(node).some((t) => t.includes(part));
const button = (node, label) => { const b = all(node, (n) => n.tag === "button" && n.textContent === label)[0]; assert.ok(b, `button ${label}`); return b; };
const issueButton = (node) => button(node, "관제명령 발령");
const confirmBox = (node) => all(node, (n) => n.tag === "label" && n.className === "control-check")[0]?.children[0] ?? null;
const tick = (node, on = true) => { const box = confirmBox(node); box.checked = on; box.fire("change"); };
const deepFreeze = (o) => { if (o && typeof o === "object") { Object.values(o).forEach(deepFreeze); Object.freeze(o); } return o; };

const REV = "control-revision:1";
function controlGeometry(attachment = true, over = {}) {
  return {
    schema: "transitline.railway-service-control-geometry/1", contractVersion: 1,
    controlGeometryId: "control:1", controlGeometryRevision: REV, eventId: "event:1", operationalLineId: "1",
    railGeometryId: "geometry:1", railGeometryRevision: "revision:1",
    turnbackCandidates: [
      { candidateId: "turnback:B", stationId: "B", terminalResourceId: "terminal:B", physicalAttachment: attachment },
      { candidateId: "turnback:C", stationId: "C", terminalResourceId: "terminal:C", physicalAttachment: attachment },
    ],
    partialSuspensionCandidates: [{ candidateId: "suspension:bc", startStationId: "B", endStationId: "C", suspendedSectionIds: ["map:bc"], retainedSectionIds: ["map:ab", "map:cd"], suspendedLengthMeters: null }],
    detourCandidates: [], evacuationAccessCandidates: [],
    ...over,
  };
}
const SELECTION = { turnback: ["turnback:B", "turnback:C"], partialSuspension: ["suspension:bc"], detour: [], evacuation: [] };
function m7output(control = controlGeometry(), selection = SELECTION, designedOn = control.controlGeometryRevision) {
  const selected = Object.fromEntries(Object.entries(selection).map(([kind, list]) => [kind, list.map((candidateId) => ({ candidateId, designedControlGeometryRevision: designedOn }))]));
  return { document: { version: 1, controls: [{ eventId: control.eventId, active: true, selected }] }, export: { controls: [control] }, controls: [control], selections: { [control.eventId]: selection }, selected: control, selectedEventId: control.eventId, warnings: [] };
}
const eventRow = (extra = {}) => ({ id: "event:1", status: "active", lineId: "1", ...extra });
const orderRow = (extra = {}) => ({ schema: "transitline.railway-control-order/1", id: "railway-control-order:1", kind: "partial-suspension", status: "active", eventId: "event:1", lineId: "1", retainedServices: [{ serviceId: "s1", stationIds: ["A", "B"] }, { serviceId: "s2", stationIds: ["C", "D"] }], omittedStationIds: [], suspendedTrackSegmentIds: ["bc"], assumptions: [], issuedAtMinute: 10, endedAtMinute: null, endReason: null, ...extra });

// a runtime that only records what the panel asks of it
function spyRuntime({ events = [eventRow()], orders = [], order = { id: "railway-control-order:9" }, throwOn = null } = {}) {
  const calls = { issue: [], orderReport: 0, eventReport: 0 };
  const runtime = {
    issueRailwayControlSelection(input) { calls.issue.push(input); if (throwOn) throw new Error(throwOn); return order; },
    railwayControlOrderReport() { calls.orderReport += 1; return orders; },
    railwayDisruptionReport() { calls.eventReport += 1; return { schema: "transitline.railway-disruption-report/1", activeCount: events.length, events }; },
  };
  return { runtime, calls };
}
function mount(output = m7output(), spy = spyRuntime(), over = {}) {
  const container = newContainer();
  const changes = [];
  const panel = mountRailwayServiceControlManagementPanel({ container, runtime: spy.runtime, getServiceControlOutput: () => output, onChange: () => changes.push(1), ...over });
  return { container, panel, changes, ...spy };
}

test("mounting only reads: no engine mutation, frozen map output and reports stay untouched", () => {
  const output = deepFreeze(m7output());
  const spy = spyRuntime({ events: deepFreeze([eventRow()]), orders: deepFreeze([orderRow()]) });
  const env = mount(output, spy);
  env.panel.refresh();
  assert.equal(env.calls.issue.length, 0); assert.equal(env.changes.length, 0);
  assert.ok(env.calls.orderReport > 0 && env.calls.eventReport > 0);
  assert.ok(shows(env.container, MAP_NOTICE)); assert.ok(shows(env.container, SCOPE_NOTICE));
  assert.ok(shows(env.container, "control:1")); assert.ok(shows(env.container, REV));
  assert.ok(shows(env.container, "suspension:bc · B ~ C · 구간 1 · 운휴 길이 미상"));
  assert.ok(shows(env.container, "● 접속 확인(true)"));
  assert.equal(issueButton(env.container).disabled, false);
});

test("issuing sends exactly the engine payload, copies the inputs, then notifies the host once", () => {
  const output = deepFreeze(m7output());
  const env = mount(output);
  issueButton(env.container).fire("click");
  assert.equal(env.calls.issue.length, 1);
  assert.deepEqual(env.calls.issue[0], { eventId: "event:1", controlGeometry: controlGeometry(), controlGeometryRevision: REV, selection: SELECTION, confirmUnknownPhysicalAttachment: false });
  assert.deepEqual(Object.keys(env.calls.issue[0]).sort(), ["confirmUnknownPhysicalAttachment", "controlGeometry", "controlGeometryRevision", "eventId", "selection"]);
  assert.notEqual(env.calls.issue[0].controlGeometry, output.controls[0]);
  assert.notEqual(env.calls.issue[0].selection, output.selections["event:1"]);
  assert.equal(env.changes.length, 1);
  assert.ok(shows(env.container, "발령됨 · railway-control-order:9"));
});

test("an unknown (null) attachment needs its own acknowledgement and it reaches the payload", () => {
  const env = mount(m7output(controlGeometry(null)));
  assert.ok(shows(env.container, "? 접속 미확인(null)"));
  assert.equal(confirmBox(env.container).checked, false);
  issueButton(env.container).fire("click");
  assert.equal(env.calls.issue[0].confirmUnknownPhysicalAttachment, false);
  tick(env.container);
  issueButton(env.container).fire("click");
  assert.equal(env.calls.issue[1].confirmUnknownPhysicalAttachment, true);
  // a known attachment never shows the box and never sends the flag
  const known = mount(m7output(controlGeometry(true)));
  assert.equal(confirmBox(known.container), null);
  issueButton(known.container).fire("click");
  assert.equal(known.calls.issue[0].confirmUnknownPhysicalAttachment, false);
});

test("an acknowledgement is dropped when the player's choice changes", () => {
  let output = m7output(controlGeometry(null));
  const env = mount(output, spyRuntime(), { getServiceControlOutput: () => output });
  tick(env.container); assert.equal(confirmBox(env.container).checked, true);
  output = m7output(controlGeometry(null), { ...SELECTION, turnback: ["turnback:B"] });
  env.panel.refresh();
  assert.equal(confirmBox(env.container).checked, false);
});

test("a detached (false) attachment is shown as the map fact and never turned into permission", () => {
  const env = mount(m7output(controlGeometry(false)));
  assert.ok(shows(env.container, "✕ 물리적으로 분리(false)"));
  assert.equal(shows(env.container, "● 접속 확인(true)"), false);
  assert.equal(confirmBox(env.container), null);
  issueButton(env.container).fire("click"); // the engine decides; it is asked, not pre-empted
  assert.equal(env.calls.issue.length, 1);
  assert.equal(env.calls.issue[0].confirmUnknownPhysicalAttachment, false);
  assert.equal(env.calls.issue[0].controlGeometry.turnbackCandidates[0].physicalAttachment, false);
});

test("stale geometry, missing choice, outdated choice and ended events never reach the engine", () => {
  const cases = {
    "selection-missing": mount(m7output(controlGeometry(), { ...SELECTION, partialSuspension: [] })),
    "selection-stale": mount(m7output(controlGeometry(), { ...SELECTION, partialSuspension: ["suspension:gone"] })),
    "selection-outdated": mount(m7output(controlGeometry(), SELECTION, "control-revision:0")),
    "event-not-ongoing": mount(m7output(), spyRuntime({ events: [eventRow({ status: "resolved" })] })),
    "event-unknown": mount(m7output(), spyRuntime({ events: [] })),
    "control-geometry-invalid": mount(m7output(controlGeometry(true, { schema: "wrong" }))),
    "control-geometry-missing": mount({ controls: [], selections: { "event:1": SELECTION } }),
  };
  for (const [code, env] of Object.entries(cases)) {
    assert.ok(all(env.container, (n) => n.className === `control-warning ${code}`).length === 1, code);
    assert.equal(issueButton(env.container).disabled, true, code);
    issueButton(env.container).fire("click");
    assert.equal(env.calls.issue.length, 0, code);
    assert.equal(env.changes.length, 0, code);
  }
  assert.ok(shows(cases["event-not-ongoing"].container, "장애가 이미 끝났습니다"));
});

test("engine errors are shown verbatim and the host is not notified", () => {
  const env = mount(m7output(), spyRuntime({ throwOn: "Exactly one partial-suspension candidate must be selected" }));
  issueButton(env.container).fire("click");
  assert.ok(shows(env.container, "Exactly one partial-suspension candidate must be selected"));
  assert.equal(env.changes.length, 0);
  assert.equal(shows(env.container, "발령됨"), false);
});

test("active and ended control orders are shown read-only, exactly as reported", () => {
  const orders = deepFreeze([orderRow({ assumptions: ["turnback-attachment-unconfirmed:turnback:B"] }), orderRow({ id: "railway-control-order:2", kind: "short-turn", status: "ended", retainedServices: [], retainedStationIds: ["A", "B"], endedAtMinute: 70, endReason: "disruption-resolved" })]);
  const env = mount(m7output(), spyRuntime({ orders }));
  assert.ok(shows(env.container, "관제명령 2건"));
  assert.ok(shows(env.container, "발령 중 · 부분운휴 · railway-control-order:1"));
  assert.ok(shows(env.container, "종료 · 회차 · railway-control-order:2"));
  assert.ok(shows(env.container, "A→B / C→D"));
  assert.ok(shows(env.container, "70분 · disruption-resolved"));
  assert.ok(shows(env.container, "가정: turnback-attachment-unconfirmed:turnback:B"));
  assert.equal(all(env.container, (n) => n.tag === "button").length, 1); // only "issue": no edit or clear control on orders
});

test("an empty map output shows an honest empty state and no issue control", () => {
  for (const out of [null, {}, { controls: [], selections: {} }]) {
    const env = mount(out);
    assert.ok(shows(env.container, "관제 후보(M7)가 없습니다"));
    assert.equal(all(env.container, (n) => n.tag === "button").length, 0);
  }
  assert.deepEqual(buildRailwayServiceControlView(), []);
});

test("unsupported detour and evacuation choices are only reported as preserved", () => {
  const env = mount(m7output(controlGeometry(), { ...SELECTION, detour: ["detour:1"], evacuation: ["evac:1", "evac:2"] }));
  assert.ok(shows(env.container, "우회·대피 선택 3개는 보존만 되며"));
  assert.equal(issueButton(env.container).disabled, false);
});

test("the panel shows facts only: no money, time or verdict is computed or invented", () => {
  const env = mount(m7output(controlGeometry(true, { partialSuspensionCandidates: [{ candidateId: "suspension:bc", startStationId: "B", endStationId: "C", suspendedSectionIds: ["map:bc"], suspendedLengthMeters: 2500 }] })));
  assert.ok(shows(env.container, "운휴 길이 2.5 km"));
  const shown = texts(env.container).filter((t) => t !== MAP_NOTICE && t !== SCOPE_NOTICE).join("\n");
  assert.equal(/[￥¥]|JPY|소요|예상|가능합니다|불가능/.test(shown), false);
  const unknown = mount(m7output());
  assert.ok(shows(unknown.container, "운휴 길이 미상"));
});

test("the panel never persists anything itself", () => {
  const writes = [];
  const had = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const hadSession = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  const guard = { getItem: () => null, setItem: (k) => writes.push(k), removeItem: (k) => writes.push(k) };
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: guard });
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: guard });
  try { const env = mount(); issueButton(env.container).fire("click"); }
  finally {
    if (had) Object.defineProperty(globalThis, "localStorage", had); else delete globalThis.localStorage;
    if (hadSession) Object.defineProperty(globalThis, "sessionStorage", hadSession); else delete globalThis.sessionStorage;
  }
  assert.deepEqual(writes, []);
});

test("mount refuses a missing container or an incomplete runtime", () => {
  assert.throws(() => mountRailwayServiceControlManagementPanel({ runtime: spyRuntime().runtime }), /container/);
  assert.throws(() => mountRailwayServiceControlManagementPanel({ container: newContainer(), runtime: {} }), /issueRailwayControlSelection/);
});

// --- end to end against the real ScenarioRuntime ---
function sourcePack() { return { manifest: { id: "service-control-ui", version: "1", data: { license: "test", attribution: [] } }, demand: { model: "gravity", points: [], attractors: [] } }; }
function realWorld(attachment) {
  const state = createState(sourcePack());
  for (let index = 0; index < 4; index += 1) addPhysicalStation(state, { id: String.fromCharCode(65 + index), location: [139 + index * 0.01, 35] });
  addTrackSegment(state, { id: "ab", fromStationId: "A", toStationId: "B", directionMode: "double" });
  addTrackSegment(state, { id: "bc", fromStationId: "B", toStationId: "C", directionMode: "double" });
  addTrackSegment(state, { id: "cd", fromStationId: "C", toStationId: "D", directionMode: "double" });
  const line = addLine(state, ["A", "B", "C", "D"], { frequency: { high: 6, medium: 6, low: 6, veryLow: 6 } });
  line.trackSegmentIds = ["ab", "bc", "cd"];
  state.railwayDisruptions.events.push({ schema: "transitline.railway-disruption/1", contractVersion: 1, id: "event:1", kind: "signal-failure", status: "active", lineId: String(line.id), trackSegmentId: "bc", blockId: null, trainId: null, startedAtMinute: state.simMinutes, expectedEndMinute: state.simMinutes + 60, resolvedAtMinute: null, resolutionReason: null, effect: { closed: true, speedLimitMps: 0 } });
  state.railCapacityApplications = [{ schema: "transitline.rail-capacity-application/1", contractVersion: 1, operationalLineId: String(line.id), railGeometryId: "geometry:1", railGeometryRevision: "revision:1", sections: [{ trackSegmentId: "ab", railCapacitySectionId: "map:ab" }, { trackSegmentId: "bc", railCapacitySectionId: "map:bc" }, { trackSegmentId: "cd", railCapacitySectionId: "map:cd" }] }];
  const runtime = new ScenarioRuntime({ pack: sourcePack(), operationalState: state });
  return { state, runtime, control: controlGeometry(attachment, { operationalLineId: String(line.id) }) };
}

test("real runtime: an unknown attachment is refused until acknowledged, then issued, listed, ended and restored", () => {
  const { state, runtime, control } = realWorld(null);
  const output = deepFreeze(m7output(control));
  const env = mount(output, { runtime });
  const pristine = structuredClone(state.railwayControlOrders);

  issueButton(env.container).fire("click"); // not acknowledged: the engine refuses and says why
  assert.ok(shows(env.container, "has unconfirmed physical attachment"));
  assert.equal(env.changes.length, 0);
  assert.deepEqual(state.railwayControlOrders, pristine);

  tick(env.container);
  assert.deepEqual(state.railwayControlOrders, pristine); // ticking changes nothing in the engine
  issueButton(env.container).fire("click");
  assert.equal(env.changes.length, 1);
  const [order] = runtime.railwayControlOrderReport();
  assert.equal(order.status, "active"); assert.equal(order.candidateId, "suspension:bc");
  assert.deepEqual(order.assumptions, ["turnback-attachment-unconfirmed:turnback:B", "turnback-attachment-unconfirmed:turnback:C"]);
  assert.ok(shows(env.container, "발령됨 · railway-control-order:1"));
  assert.ok(shows(env.container, "발령 중 · 부분운휴 · railway-control-order:1"));
  assert.ok(shows(env.container, "A→B / C→D"));
  assert.ok(shows(env.container, "turnback-attachment-unconfirmed:turnback:B"));

  // a second attempt on the same line is the engine's to refuse
  issueButton(env.container).fire("click");
  assert.ok(shows(env.container, "already has an active control order"));
  assert.equal(env.changes.length, 1);

  // what a report hands out is a copy
  const report = runtime.railwayControlOrderReport(); report[0].status = "hacked"; report.length = 0;
  assert.equal(runtime.railwayControlOrderReport()[0].status, "active");

  runtime.clearRailwayControlOrder(order.id);
  env.panel.refresh();
  assert.ok(shows(env.container, "종료 · 부분운휴 · railway-control-order:1"));

  // the integrated save is the only truth: a restored state shows the same order in a fresh panel
  const restored = restoreOperationalState(JSON.parse(JSON.stringify(snapshotOperationalState(state))));
  assert.deepEqual(restored.railwayControlOrders, state.railwayControlOrders);
  const again = mount(output, { runtime: new ScenarioRuntime({ pack: sourcePack(), operationalState: restored }) });
  assert.ok(shows(again.container, "종료 · 부분운휴 · railway-control-order:1"));
});

test("real runtime: a detached turnback is refused by the engine and a resolved event stops the offer", () => {
  const detached = realWorld(false);
  const env = mount(deepFreeze(m7output(detached.control)), { runtime: detached.runtime });
  issueButton(env.container).fire("click");
  assert.ok(shows(env.container, "is physically detached"));
  assert.equal(detached.state.railwayControlOrders.orders.length, 0);
  assert.equal(env.changes.length, 0);

  const ended = realWorld(true);
  ended.state.railwayDisruptions.events[0].status = "resolved";
  const stopped = mount(deepFreeze(m7output(ended.control)), { runtime: ended.runtime });
  assert.equal(issueButton(stopped.container).disabled, true);
  assert.ok(shows(stopped.container, "장애가 이미 끝났습니다"));
});
