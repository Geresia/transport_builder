import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MANAGEMENT_PANEL_SCHEMA, SCOPE_NOTICE, mountNewTownDevelopmentManagementPanel } from "../src/new-town-development-management-ui.mjs";
import { MAP_STATE_TEXT, buildNewTownManagementView } from "../src/new-town-development-management-view.mjs";
import { buildNewTownDevelopmentExport, keyedDevelopmentId } from "../src/map/new-town-development.mjs";
import { makeSpatialContext } from "../src/map/spatial.mjs";
import { ManagementGame } from "../src/management/index.mjs";
import { ScenarioRuntime } from "../src/scenario-runtime.mjs";
import { createState } from "../src/state.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(here, "..", "src");

// --- a minimal DOM: elements, form values, listeners, replaceChildren ---
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
const hasClass = (n, cls) => String(n.className).split(" ").includes(cls);
const byClass = (node, cls) => all(node, (n) => hasClass(n, cls));
const field = (node, cls, nth = 0) => { const found = byClass(node, cls)[nth]; assert.ok(found, `field ${cls}`); return found; };
const button = (node, label, nth = 0) => all(node, (n) => n.tag === "button" && n.textContent === label)[nth];
const press = (node, label, nth = 0) => { const b = button(node, label, nth); assert.ok(b, `button ${label}`); assert.equal(b.disabled, false, `${label} is disabled`); b.fire("click"); };
// a real browser sends no click to a disabled button; the handler must hold even if one arrives
const pressDisabled = (node, label, nth = 0) => { const b = button(node, label, nth); assert.ok(b, `button ${label}`); assert.equal(b.disabled, true, `${label} should be disabled`); b.fire("click"); };
const type = (node, cls, value, nth = 0) => { const n = field(node, cls, nth); n.value = value; n.fire("input"); };
const choose = (node, cls, value, nth = 0) => { const n = field(node, cls, nth); n.value = value; n.fire("change"); };
const tick = (node, cls, on = true, nth = 0) => { const n = field(node, cls, nth); n.checked = on; n.fire("change"); };
const deepFreeze = (o) => { if (o && typeof o === "object") { Object.values(o).forEach(deepFreeze); Object.freeze(o); } return o; };
const BANNED = /인구|수요|승객|운임|혼잡|사업성|비용|수익|점수|확률|입주율|교통량|판정|가능/;

// --- a real map export (B19-M1) and a real ScenarioRuntime ---
const PACK = { manifest: { id: "nt-test", version: "1", bbox: [-0.1, -0.1, 0.1, 0.1], data: { license: "CC0-1.0", attribution: ["t"] } }, demand: { points: [] } };
const rect = (x, y, w, h) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
const phasesOf = (firstWidth = 0.01) => [{ key: "p1", name: "First", sequence: 1, polygon: rect(0, 0, firstWidth, 0.01), playerDeclaredLandUse: "housing" }, { key: "p2", name: "Second", sequence: 2, polygon: rect(0.02, 0, 0.01, 0.01), playerDeclaredLandUse: "employment" }];
const drawnTown = (key, over = {}) => ({ key, name: `Town ${key}`, phases: phasesOf(), ...over });
const makeExport = (list, pack = PACK) => buildNewTownDevelopmentExport({ pack, mapExport: { plans: [], externalNetworks: [] }, developments: list, spatial: makeSpatialContext({}) });
const devId = (key, packId = "nt-test") => keyedDevelopmentId(packId, key);
const geoOf = (exp, key) => exp.developments.find((d) => d.developmentId === devId(key));
const RUNTIME_PACK = { manifest: { id: "new-town-ui", version: "1", data: { license: "test", attribution: [] } }, demand: { model: "gravity", points: [], attractors: [] } };
const newRuntime = () => new ScenarioRuntime({ pack: RUNTIME_PACK, operationalState: createState(RUNTIME_PACK) });
const READ_ONLY = new Set(["newTownDevelopmentReport", "assessNewTownDevelopment", "newTownDevelopmentHooks"]);
// a runtime that remembers every method the panel calls on it
function spy(runtime) {
  const calls = [];
  const proxy = new Proxy(runtime, { get(target, name) { const v = target[name]; return typeof v === "function" ? (...args) => { calls.push(name); return v.apply(target, args); } : v; } });
  return { rt: proxy, calls };
}
const PARTIES = { municipality: { name: "Hanamaki City" }, developer: { partyId: "dev-co", name: "Dev Co" } };

function world({ keys = ["a"], overs = {}, runtime = newRuntime(), frozen = false } = {}) {
  const state = { exp: makeExport(keys.map((k) => drawnTown(k, overs[k] ?? {}))) };
  const give = () => (frozen ? deepFreeze(structuredClone(state.exp)) : state.exp);
  const { rt, calls } = spy(runtime);
  const container = newContainer();
  const events = [];
  const panel = mountNewTownDevelopmentManagementPanel({ container, runtime: rt, getGeometryExport: give, onChange: (e) => events.push(e) });
  return { runtime, rt, calls, state, container, panel, events, remount: () => mountNewTownDevelopmentManagementPanel({ container: newContainer(), runtime: rt, getGeometryExport: give }) };
}
const mapGeo = (w, key) => geoOf(w.state.exp, key);
// bring a development to a status straight through the runtime (not through the panel)
function bring(w, key, status = "proposed", { geo = mapGeo(w, key) } = {}) {
  const rec = w.runtime.draftNewTownDevelopment({ geometry: geo, name: `Town ${key}`, parties: PARTIES });
  if (status !== "draft") w.runtime.proposeNewTownDevelopment({ id: rec.id, geometry: geo });
  w.panel.refresh(); // the host redraws after it changes the runtime
  return rec.id;
}
const rowOf = (w, key, nth = 0) => w.panel.view().rows.filter((r) => r.developmentId === devId(key))[nth];
const stateJson = (w) => JSON.stringify(w.runtime.save());

test("mounting sends no command: only the read-only report / assess / hooks calls happen, and the runtime state is untouched", () => {
  const runtime = newRuntime();
  const before = JSON.stringify(runtime.save());
  const cash = runtime.game.player.cash;
  const w = world({ keys: ["a", "b"], runtime });
  bring(w, "a");
  const mid = JSON.stringify(runtime.save());
  w.calls.length = 0;
  const m = w.remount();
  m.refresh(); m.select(m.view().rows[0].rowKey); m.deselect(); m.serialize(); m.view(); m.output();
  assert.ok(w.calls.length > 0 && w.calls.every((c) => READ_ONLY.has(c)), `calls: ${[...new Set(w.calls)]}`);
  assert.equal(JSON.stringify(runtime.save()), mid);
  assert.notEqual(before, mid, "bring() did change the runtime, so the equality above is meaningful");
  assert.equal(runtime.game.player.cash, cash);
  assert.ok(shows(w.container, SCOPE_NOTICE));
  assert.deepEqual(w.events, [], "mounting tells the host nothing");
});

test("mount arguments are checked: a container, a runtime with the lifecycle methods, and the export getter", () => {
  const ok = { container: newContainer(), runtime: newRuntime(), getGeometryExport: () => null };
  assert.throws(() => mountNewTownDevelopmentManagementPanel({ ...ok, container: null }), /container/);
  assert.throws(() => mountNewTownDevelopmentManagementPanel({ ...ok, runtime: {} }), /runtime\.newTownDevelopmentReport/);
  assert.throws(() => mountNewTownDevelopmentManagementPanel({ ...ok, getGeometryExport: null }), /getGeometryExport/);
  assert.throws(() => mountNewTownDevelopmentManagementPanel(), /container/);
});

test("no record / current / stale / inactive / other-pack / not on the map are told apart, each from the runtime's own check", () => {
  const w = world({ keys: ["none", "cur", "stale", "off", "gone", "otherpack"] });
  const ids = Object.fromEntries(["cur", "stale", "off", "gone"].map((k) => [k, bring(w, k)]));
  // a record made from a geometry of another pack that shares the id; the current map says the same id comes from this pack
  ids.otherpack = bring(w, "otherpack", "proposed", { geo: { ...structuredClone(mapGeo(w, "otherpack")), sourcePackId: "pack:old" } });
  // a record whose development is in another pack's map and nowhere in this one
  const foreignExport = makeExport([drawnTown("elsewhere")], { manifest: { ...PACK.manifest, id: "pack:other" } });
  ids.elsewhere = bring(w, "elsewhere", "draft", { geo: geoOf(foreignExport, "elsewhere") ?? foreignExport.developments[0] });
  // the map changes after the records were made
  w.state.exp = makeExport([drawnTown("none"), drawnTown("cur"), drawnTown("stale", { phases: phasesOf(0.012) }), drawnTown("off", { active: false }), drawnTown("otherpack")]);
  assert.equal(geoOf(w.state.exp, "off").active, false, "the fixture really switches the development off");
  w.panel.refresh();
  const states = Object.fromEntries(w.panel.view().rows.map((r) => [r.recordId ?? r.developmentId, r.mapState]));
  assert.deepEqual(states, {
    [devId("none")]: "no-record", [ids.cur]: "current", [ids.stale]: "stale", [ids.off]: "inactive", [ids.gone]: "map-missing", [ids.otherpack]: "other-pack", [ids.elsewhere]: "other-pack",
  });
  for (const state of Object.values(states)) assert.ok(shows(w.container, MAP_STATE_TEXT[state]), state);
  // the runtime's own word is shown next to ours
  w.panel.select(`record:${ids.stale}`);
  assert.ok(shows(w.container, "런타임 대조(E1): stale — geometry-revision-changed"));
  w.panel.select(`record:${ids.otherpack}`);
  assert.ok(shows(w.container, "geometry-source-pack-changed"));
});

test("a development with no record gets a draft button; a record replaces the map-only row; a cancelled record frees the map row again", () => {
  const w = world();
  assert.deepEqual(w.panel.view().rows.map((r) => [r.recordId, r.lifecycleStatus, r.mapState]), [[null, null, "no-record"]]);
  const id = bring(w, "a", "draft");
  w.panel.refresh();
  assert.deepEqual(w.panel.view().rows.map((r) => [r.recordId, r.lifecycleStatus]), [[id, "draft"]]);
  w.runtime.cancelNewTownDevelopment(id, "player stopped it");
  w.panel.refresh();
  assert.deepEqual(w.panel.view().rows.map((r) => [r.recordId, r.lifecycleStatus, r.mapState]), [[id, "cancelled", "current"], [null, null, "no-record"]]);
});

test("the full flow by clicks only: draft, propose, agree, servicing, occupancy, delay, resume, cancel give exactly the records the direct API gives", () => {
  const w = world();
  const key = devId("a");
  const direct = new ManagementGame({ seed: 1 });
  const geo = mapGeo(w, "a");
  const before = JSON.stringify(w.runtime.save());
  press(w.container, "자세히");
  assert.equal(w.panel.selectedRowKey, `map:${key}`);
  type(w.container, "nt-f-name", "Hanamaki New Town");
  choose(w.container, "nt-f-muni-mode", "named"); type(w.container, "nt-f-muni-name", "Hanamaki City");
  choose(w.container, "nt-f-dev-mode", "named"); type(w.container, "nt-f-dev-name", "Dev Co"); type(w.container, "nt-f-dev-id", "dev-co");
  assert.equal(JSON.stringify(w.runtime.save()), before, "selecting and typing send nothing");
  press(w.container, "초안 만들기");
  const draft = direct.draftNewTownDevelopment({ geometry: geo, name: "Hanamaki New Town", parties: { municipality: { name: "Hanamaki City" }, developer: { partyId: "dev-co", name: "Dev Co" } } });
  const id = draft.id;
  assert.equal(w.panel.selectedRowKey, `record:${id}`, "the new record is the selected row");
  assert.deepEqual(w.runtime.newTownDevelopmentReport(), direct.newTownDevelopmentReport());
  assert.ok(shows(w.container, `초안 만들기 완료 — ${id} · draft`));
  // the agree step is shut while the record is a draft, and says why in the runtime's words
  assert.equal(button(w.container, "합의(agree)").disabled, true);
  assert.deepEqual(byClass(byClass(w.container, "nt-step-agree")[0], "nt-blocker").map((n) => n.textContent), ["status-not-allowed:draft"]);
  press(w.container, "제안(propose)");
  direct.proposeNewTownDevelopment({ id, geometry: geo });
  assert.deepEqual(w.runtime.newTownDevelopmentReport(), direct.newTownDevelopmentReport());
  // agree: burdens typed in; a second burden row; a mode change must not lose what was typed
  type(w.container, "nt-f-item", "rail-construction");
  tick(w.container, "nt-f-bear-municipality"); tick(w.container, "nt-f-bear-player");
  type(w.container, "nt-f-amount", "1000000");
  press(w.container, "부담 항목 추가");
  type(w.container, "nt-f-item", "land-assembly", 1);
  tick(w.container, "nt-f-bear-developer", true, 1);
  choose(w.container, "nt-f-cmode", "stated");
  assert.equal(field(w.container, "nt-f-item").value, "rail-construction", "typed text survives a redraw");
  assert.equal(field(w.container, "nt-f-bear-player").checked, true);
  type(w.container, "nt-f-cid", "c1"); type(w.container, "nt-f-ctext", "The station opens before phase 2 is serviced"); type(w.container, "nt-f-csite", "site:1");
  press(w.container, "합의(agree)");
  direct.agreeNewTownDevelopment(id, {
    burdens: [{ itemId: "rail-construction", bearers: ["player", "municipality"], statedAmountJPY: 1_000_000 }, { itemId: "land-assembly", bearers: ["developer"], statedAmountJPY: null }],
    connectionConditions: [{ conditionId: "c1", text: "The station opens before phase 2 is serviced", linkedStationSiteId: "site:1" }],
  }, { geometry: geo });
  assert.deepEqual(w.runtime.newTownDevelopmentReport(), direct.newTownDevelopmentReport());
  press(w.container, "서비스 시작");
  direct.startNewTownServicing(id, { geometry: geo });
  assert.deepEqual(w.runtime.newTownDevelopmentReport(), direct.newTownDevelopmentReport());
  const p1 = w.runtime.newTownDevelopmentReport()[0].phases[0].phaseId;
  choose(w.container, "nt-f-ophase", p1);
  type(w.container, "nt-f-occupied", "120"); type(w.container, "nt-f-planned", "500"); type(w.container, "nt-f-unit", "residents"); type(w.container, "nt-f-source", "player-stated");
  press(w.container, "입주 사실 기록");
  direct.recordNewTownOccupancy(id, p1, { statedOccupiedUnits: 120, statedPlannedUnits: 500, unit: "residents", source: "player-stated" }, { geometry: geo });
  assert.deepEqual(w.runtime.newTownDevelopmentReport(), direct.newTownDevelopmentReport());
  type(w.container, "nt-f-delay", "land permit is late");
  press(w.container, "지연(delay)");
  direct.delayNewTownDevelopment(id, "land permit is late");
  assert.equal(w.runtime.newTownDevelopmentReport()[0].status, "delayed");
  assert.deepEqual(w.runtime.newTownDevelopmentReport(), direct.newTownDevelopmentReport());
  press(w.container, "재개(resume)");
  direct.resumeNewTownDevelopment(id, { geometry: geo });
  assert.deepEqual(w.runtime.newTownDevelopmentReport(), direct.newTownDevelopmentReport());
  type(w.container, "nt-f-cancel", "player stopped it");
  press(w.container, "취소(cancel)");
  direct.cancelNewTownDevelopment(id, "player stopped it");
  assert.deepEqual(w.runtime.newTownDevelopmentReport(), direct.newTownDevelopmentReport());
  assert.equal(w.runtime.newTownDevelopmentReport()[0].status, "cancelled");
  assert.deepEqual(w.events.filter((e) => e.kind === "command").map((e) => [e.action, e.status]), [["draft", "draft"], ["propose", "proposed"], ["agree", "agreed"], ["startServicing", "servicing"], ["recordOccupancy", "occupied"], ["delay", "delayed"], ["resume", "occupied"], ["cancel", "cancelled"]]);
  assert.deepEqual(w.runtime.newTownDevelopmentHooks(id), direct.newTownDevelopmentHooks(id));
  assert.equal(w.runtime.game.player.cash, new ScenarioRuntime({ pack: RUNTIME_PACK, operationalState: createState(RUNTIME_PACK) }).game.player.cash, "no lifecycle step moved money");
});

test("the blockers shown are the runtime's assess blockers, word for word, for every step of every row", () => {
  const w = world({ keys: ["a", "b", "c"] });
  bring(w, "a", "draft");
  const b = bring(w, "b", "proposed");
  w.runtime.agreeNewTownDevelopment(b, { burdens: [{ itemId: "x", bearers: ["player"] }] }, { geometry: mapGeo(w, "b") });
  w.state.exp = makeExport([drawnTown("a"), drawnTown("b", { active: false }), drawnTown("c")]);
  w.panel.refresh();
  const keyOf = (developmentId) => ["a", "b", "c"].find((k) => devId(k) === developmentId);
  assert.equal(w.panel.view().rows.length, 3);
  for (const row of w.panel.view().rows) {
    w.panel.select(row.rowKey);
    const geometry = geoOf(w.state.exp, keyOf(row.developmentId));
    const assess = w.runtime.assessNewTownDevelopment(row.recordId === null ? { geometry } : { id: row.recordId, geometry });
    const steps = row.recordId === null ? [["draft", assess.create.draft]] : Object.entries(assess.transitions);
    for (const [kind, gate] of steps) {
      const line = byClass(w.container, `nt-step-${kind}`)[0];
      assert.ok(line, `${row.rowKey} ${kind}`);
      assert.deepEqual(byClass(line, "nt-blocker").map((n) => n.textContent), gate.blockers, `${row.rowKey} ${kind}`);
      assert.equal(all(line, (n) => n.tag === "button")[0].disabled, !gate.allowed, `${row.rowKey} ${kind}`);
    }
  }
});

test("a stale geometry never goes forward: closed buttons, a click that gets through anyway sends nothing, and the map is read again at the click", () => {
  const w = world();
  const id = bring(w, "a", "proposed");
  w.panel.select(`record:${id}`);
  assert.equal(button(w.container, "합의(agree)").disabled, false);
  type(w.container, "nt-f-item", "x"); tick(w.container, "nt-f-bear-player");
  // the map changes AFTER the panel was drawn; nothing refreshed it
  w.state.exp = makeExport([drawnTown("a", { phases: phasesOf(0.02) })]);
  const before = stateJson(w);
  w.calls.length = 0;
  press(w.container, "합의(agree)");
  assert.equal(stateJson(w), before, "no command was sent");
  assert.ok(w.calls.every((c) => READ_ONLY.has(c)), `calls: ${[...new Set(w.calls)]}`);
  assert.ok(shows(w.container, "막힘 — 합의(agree): 명령을 보내지 않았습니다."));
  const blocked = texts(byClass(w.container, "nt-notice-blocked")[0]);
  assert.ok(blocked.includes("geometry-stale") && blocked.includes("geometry-revision-changed"), blocked.join("|"));
  // after the re-read every forward step is shut, with the runtime's reasons
  for (const label of ["합의(agree)", "서비스 시작", "입주 사실 기록", "재개(resume)"]) pressDisabled(w.container, label);
  assert.equal(stateJson(w), before);
  assert.equal(rowOf(w, "a").mapState, "stale");
  // stopping a development never needs the map
  assert.equal(button(w.container, "취소(cancel)").disabled, false);
  // the map comes back to the recorded revision: the panel re-reads it and the step opens again
  w.state.exp = makeExport([drawnTown("a")]);
  press(w.container, "지도 다시 읽기");
  assert.equal(rowOf(w, "a").mapState, "current");
  assert.equal(button(w.container, "합의(agree)").disabled, false);
});

test("a runtime error is shown as the runtime wrote it, and nothing in the records or the typed form changes", () => {
  const w = world();
  const id = bring(w, "a", "proposed");
  w.panel.select(`record:${id}`);
  const before = stateJson(w);
  // an agreement with no bearer: the runtime refuses
  type(w.container, "nt-f-item", "rail-construction");
  let expected;
  try { w.runtime.agreeNewTownDevelopment(id, { burdens: [{ itemId: "rail-construction", bearers: [], statedAmountJPY: null }] }, { geometry: mapGeo(w, "a") }); } catch (error) { expected = error.message; }
  assert.ok(expected);
  assert.equal(stateJson(w), before, "the probe above was refused and rolled back");
  press(w.container, "합의(agree)");
  assert.equal(texts(byClass(w.container, "nt-notice-error")[0])[0], `런타임 오류(원문): ${expected}`);
  assert.equal(stateJson(w), before);
  assert.equal(field(w.container, "nt-f-item").value, "rail-construction", "the typed form is still there");
  assert.equal(w.events.filter((e) => e.kind === "command").length, 0, "a refused command is not announced as done");
  // an amount that is not a whole non-negative number
  tick(w.container, "nt-f-bear-player"); type(w.container, "nt-f-amount", "-5");
  press(w.container, "합의(agree)");
  assert.ok(shows(w.container, "런타임 오류(원문): Burden rail-construction statedAmountJPY must be a non-negative integer or null"));
  type(w.container, "nt-f-amount", "12.5");
  press(w.container, "합의(agree)");
  assert.ok(shows(w.container, "statedAmountJPY must be a non-negative integer or null"));
  assert.equal(stateJson(w), before);
  assert.equal(w.runtime.newTownDevelopmentReport()[0].status, "proposed");
  // a map development that cannot start a record: the draft is refused by the runtime and its words are shown
  const x = world({ overs: { a: { active: false } } });
  x.panel.select(`map:${devId("a")}`);
  const sx = stateJson(x);
  press(x.container, "초안 만들기");
  assert.ok(shows(x.container, "런타임 오류(원문): The geometry cannot start a development: inactive (geometry-inactive)"));
  assert.equal(stateJson(x), sx);
});

test("blank is null, 0 is 0, and [] is only what the player declared: occupancy numbers, burden amounts and connection conditions", () => {
  const w = world({ keys: ["a", "b"] });
  const a = bring(w, "a"); const b = bring(w, "b");
  for (const [id, key, mode] of [[a, "a", "declared-none"], [b, "b", "unstated"]]) {
    w.panel.select(`record:${id}`);
    type(w.container, "nt-f-item", "rail"); tick(w.container, "nt-f-bear-player");
    type(w.container, "nt-f-amount", key === "a" ? "0" : "");
    choose(w.container, "nt-f-cmode", mode);
    press(w.container, "합의(agree)");
    press(w.container, "서비스 시작");
  }
  const rec = (id) => w.runtime.newTownDevelopmentReport(id)[0];
  assert.deepEqual(rec(a).agreement.burdens.map((x) => x.statedAmountJPY), [0]);
  assert.deepEqual(rec(b).agreement.burdens.map((x) => x.statedAmountJPY), [null]);
  assert.deepEqual(rec(a).agreement.connectionConditions, [], "declared none");
  assert.equal(rec(b).agreement.connectionConditions, null, "not stated");
  // occupancy: occupied 0, planned blank
  w.panel.select(`record:${a}`);
  choose(w.container, "nt-f-ophase", rec(a).phases[0].phaseId);
  type(w.container, "nt-f-occupied", "0"); type(w.container, "nt-f-source", "player-stated");
  press(w.container, "입주 사실 기록");
  const fact = rec(a).phases[0].occupancyFacts[0];
  assert.deepEqual([fact.statedOccupiedUnits, fact.statedPlannedUnits, fact.unit], [0, null, null]);
  assert.ok(shows(w.container, "statedOccupiedUnits 0 · statedPlannedUnits null(적지 않음) · unit null(적지 않음) · source player-stated"));
  assert.ok(shows(w.container, "연결 조건: [] (없음으로 선언)"));
  assert.ok(shows(w.container, "금액 0 JPY"));
  w.panel.select(`record:${b}`);
  assert.ok(shows(w.container, "연결 조건: null(적지 않음)"));
  assert.ok(shows(w.container, "금액 null(적지 않음)"));
  // both blank: the runtime says the fact states nothing
  w.panel.select(`record:${a}`);
  choose(w.container, "nt-f-ophase", rec(a).phases[0].phaseId);
  type(w.container, "nt-f-occupied", ""); type(w.container, "nt-f-planned", "");
  press(w.container, "입주 사실 기록");
  assert.ok(shows(w.container, "런타임 오류(원문): Occupancy facts state at least one number"));
  assert.equal(rec(a).phases[0].occupancyFacts.length, 1);
});

test("the demand candidates show completeness and eligibleForB15 only, change nothing, and follow the geometry", () => {
  const w = world();
  const id = bring(w, "a");
  w.panel.select(`record:${id}`);
  assert.ok(shows(w.container, "후보 읽기 (E2"));
  assert.ok(shows(w.container, "후보 없음: 입주 사실이 적힌 단계가 없습니다."));
  type(w.container, "nt-f-item", "rail"); tick(w.container, "nt-f-bear-player"); press(w.container, "합의(agree)"); press(w.container, "서비스 시작");
  const [p1, p2] = w.runtime.newTownDevelopmentReport()[0].phases.map((p) => p.phaseId);
  choose(w.container, "nt-f-ophase", p1);
  type(w.container, "nt-f-occupied", "123"); type(w.container, "nt-f-unit", "residents"); type(w.container, "nt-f-source", "player-stated");
  press(w.container, "입주 사실 기록");
  const lines = () => byClass(w.container, "nt-candidate").map((n) => n.textContent);
  assert.deepEqual(lines(), [`${p1} · complete · eligibleForB15=true`]);
  assert.ok(shows(w.container, "후보 대조(E2): current"));
  assert.ok(!lines().join().includes("123") && !lines().join().includes("residents"), "only the status is shown, not the stated number");
  // a stated unit that is not a demand kind: incomplete, eligible unknown
  press(w.container, "서비스 시작");
  choose(w.container, "nt-f-ophase", p2);
  type(w.container, "nt-f-occupied", "7"); type(w.container, "nt-f-unit", "housing-units"); type(w.container, "nt-f-source", "player-stated");
  press(w.container, "입주 사실 기록");
  assert.deepEqual(lines(), [`${p1} · complete · eligibleForB15=true`, `${p2} · incomplete · eligibleForB15=null(미상)`]);
  // the map goes stale: blocked and not eligible
  w.state.exp = makeExport([drawnTown("a", { phases: phasesOf(0.03) })]);
  press(w.container, "지도 다시 읽기");
  assert.ok(shows(w.container, "후보 대조(E2): stale — geometry-revision-changed"));
  assert.deepEqual(lines(), [`${p1} · blocked · eligibleForB15=false`, `${p2} · blocked · eligibleForB15=false`]);
  // the panel never called anything that is not a lifecycle command or a read
  assert.ok(w.calls.every((c) => READ_ONLY.has(c) || /NewTown/.test(c)), [...new Set(w.calls)].join());
});

test("serialize / loadDoc carry only the selection and the unsent forms; a different document is refused and changes nothing", () => {
  const w = world();
  const id = bring(w, "a");
  w.panel.select(`record:${id}`);
  type(w.container, "nt-f-item", "rail-construction"); tick(w.container, "nt-f-bear-player"); type(w.container, "nt-f-amount", "0");
  choose(w.container, "nt-f-cmode", "declared-none");
  const doc = w.panel.serialize();
  assert.equal(doc.schema, MANAGEMENT_PANEL_SCHEMA);
  assert.deepEqual(Object.keys(doc).sort(), ["contractVersion", "forms", "packId", "schema", "selectedRowKey"]);
  assert.equal(doc.packId, "nt-test");
  assert.equal(doc.selectedRowKey, `record:${id}`);
  assert.ok(!/history|sourcePack|agreement/.test(JSON.stringify(doc)), "no lifecycle record is in the document");
  const w2 = world();
  bring(w2, "a");
  w2.panel.loadDoc(JSON.parse(JSON.stringify(doc)));
  assert.equal(w2.panel.selectedRowKey, `record:${id}`);
  assert.equal(field(w2.container, "nt-f-item").value, "rail-construction");
  assert.equal(field(w2.container, "nt-f-bear-player").checked, true);
  assert.equal(field(w2.container, "nt-f-amount").value, "0");
  assert.equal(field(w2.container, "nt-f-cmode").value, "declared-none");
  assert.deepEqual(w2.panel.serialize(), doc);
  assert.deepEqual(w2.events.at(-1), { kind: "ui", selectedRowKey: `record:${id}` });
  const keep = JSON.stringify(w2.panel.serialize());
  const stateBefore = stateJson(w2);
  const form = (over) => ({ ...doc, forms: { [`record:${id}`]: over } });
  const bads = [
    null, "x", [], {}, { ...doc, schema: "other/1" }, { ...doc, contractVersion: 2 }, { ...doc, packId: "another-pack" }, { ...doc, packId: 5 }, { ...doc, selectedRowKey: 3 }, { ...doc, forms: [] }, { ...doc, forms: null },
    form({ name: 5 }), form({ unknownField: "x" }), form({ agree: { conditionsMode: "maybe" } }), form({ municipality: { mode: "invented" } }), form({ agree: { burdens: [{ itemId: "x", player: "yes" }] } }),
    { schema: "transitline.new-town-development-export/1", contractVersion: 1, packId: "nt-test", developments: [] },
  ];
  for (const bad of bads) {
    assert.throws(() => w2.panel.loadDoc(bad), /Not a new-town management panel document|belongs to pack/, JSON.stringify(bad)?.slice(0, 80));
    assert.equal(JSON.stringify(w2.panel.serialize()), keep, "a refused document changes nothing");
    assert.equal(stateJson(w2), stateBefore);
  }
});

test("no storage and no clock: the panel modules use no localStorage / sessionStorage / timer / random, import only their own siblings, and never name the engine's management", () => {
  const files = ["new-town-development-management-ui.mjs", "new-town-development-management-view.mjs"];
  for (const name of files) {
    const source = fs.readFileSync(path.join(SRC, name), "utf8");
    const code = source.replace(/\/\/.*$/gm, "");
    assert.ok(Buffer.byteLength(source) < 40_000, `${name} size`);
    assert.equal(/localStorage|sessionStorage|indexedDB|document\.cookie/.test(code), false, name);
    assert.equal(/Math\.random|Date\.now|new Date|setTimeout|setInterval|requestAnimationFrame|performance\.now/.test(code), false, name);
    assert.equal(/fetch\(|XMLHttpRequest|WebSocket/.test(code), false, name);
    assert.equal(/management\/|scenario-runtime|main\.mjs/.test(code), false, name);
    for (const m of source.matchAll(/from "([^"]+)"/g)) assert.match(m[1], /^\.\/[a-z-]+\.mjs$/, `${name} imports ${m[1]}`);
  }
});

test("frozen inputs are never changed, the same inputs give the same view and the same text, and outputs share nothing with the inputs", () => {
  const w = world({ keys: ["a", "b"], frozen: true });
  bring(w, "a");
  w.panel.refresh();
  const exportBefore = JSON.stringify(w.state.exp);
  const mk = () => { const m = w.remount(); m.select(m.view().rows[0].rowKey); return m; };
  const m1 = mk(); const m2 = mk();
  assert.equal(JSON.stringify(m1.view()), JSON.stringify(m2.view()));
  assert.equal(JSON.stringify(m1.serialize()), JSON.stringify(m2.serialize()));
  assert.equal(JSON.stringify(w.state.exp), exportBefore);
  const v = m1.view();
  v.rows.find((r) => r.record).record.name = "tampered";
  v.rows[0].assessment.geometry.status = "tampered";
  assert.notEqual(JSON.stringify(m1.view()), JSON.stringify(v));
  const out = m1.output();
  out.view.rows.length = 0;
  assert.ok(m1.view().rows.length > 0);
  const input = () => ({ exportData: deepFreeze(structuredClone(w.state.exp)), records: deepFreeze(w.runtime.newTownDevelopmentReport()), assessments: deepFreeze(Object.fromEntries(w.panel.view().rows.map((r) => [r.rowKey, r.assessment]))), hooks: {} });
  const view1 = buildNewTownManagementView(input());
  const view2 = buildNewTownManagementView(input());
  assert.deepEqual(view1, view2);
  view1.rows[0].assessment.geometry.status = "tampered";
  assert.notEqual(view2.rows[0].assessment.geometry.status, "tampered");
});

test("a map export that is missing, wrong or throwing is reported as it is: every record is 'not on the map' and nothing is invented", () => {
  const runtime = newRuntime();
  const exp = makeExport([drawnTown("a")]);
  const state = { value: exp };
  const container = newContainer();
  const rec = runtime.draftNewTownDevelopment({ geometry: exp.developments[0], parties: PARTIES });
  const panel = mountNewTownDevelopmentManagementPanel({ container, runtime, getGeometryExport: () => { if (state.value instanceof Error) throw state.value; return state.value; } });
  assert.equal(panel.view().rows[0].mapState, "current");
  for (const [value, text] of [[null, "geometry-export-not-provided"], [{ schema: "x/1" }, "geometry-export-schema-invalid"], [{ schema: exp.schema, developments: null }, "geometry-export-developments-unknown"], [new Error("boom: the editor is gone"), "geometry-export-threw: boom: the editor is gone"]]) {
    state.value = value;
    panel.refresh();
    assert.ok(shows(container, `지도 geometry 없음: ${text}`), text);
    assert.deepEqual(panel.view().rows.map((r) => [r.recordId, r.mapState]), [[rec.id, "map-missing"]]);
    assert.equal(panel.view().packId, null);
  }
});

test("the text of the panel names no demand, population, cost, occupancy-rate, passenger, fare or crowding figure, in any state", () => {
  const w = world({ keys: ["a", "b", "c"] });
  const b = bring(w, "b"); bring(w, "c", "draft");
  w.panel.select(`record:${b}`);
  type(w.container, "nt-f-item", "rail"); tick(w.container, "nt-f-bear-player"); choose(w.container, "nt-f-cmode", "stated");
  type(w.container, "nt-f-cid", "c1"); type(w.container, "nt-f-ctext", "The station opens first");
  const seen = new Set();
  const collect = () => texts(w.container).forEach((t) => seen.add(t));
  collect();
  press(w.container, "합의(agree)"); collect();
  press(w.container, "서비스 시작"); collect();
  choose(w.container, "nt-f-ophase", w.runtime.newTownDevelopmentReport(b)[0].phases[0].phaseId); type(w.container, "nt-f-occupied", "5"); type(w.container, "nt-f-source", "s"); press(w.container, "입주 사실 기록"); collect();
  for (const r of w.panel.view().rows) { w.panel.select(r.rowKey); collect(); }
  w.state.exp = makeExport([drawnTown("a", { active: false })]); w.panel.refresh(); collect();
  for (const t of seen) assert.equal(BANNED.test(t), false, t);
  assert.ok(seen.size > 40, `${seen.size} texts`);
});

test("destroy empties the container and the panel stops: a late click sends nothing", () => {
  const w = world();
  const id = bring(w, "a", "draft");
  w.panel.select(`record:${id}`);
  const proposeButton = button(w.container, "제안(propose)");
  const before = stateJson(w);
  w.panel.destroy();
  assert.deepEqual(w.container.children, []);
  proposeButton.fire("click");
  w.panel.refresh();
  assert.equal(stateJson(w), before);
  assert.deepEqual(w.container.children, []);
});

test("servicing can name the phases to start; the runtime's own refusal of a later phase is shown as written", () => {
  const w = world();
  const id = bring(w, "a");
  w.panel.select(`record:${id}`);
  type(w.container, "nt-f-item", "rail"); tick(w.container, "nt-f-bear-player"); press(w.container, "합의(agree)");
  const [p1, p2] = w.runtime.newTownDevelopmentReport()[0].phases.map((p) => p.phaseId);
  tick(w.container, "nt-f-phase", true, 1);
  let expected;
  try { w.runtime.startNewTownServicing(id, { geometry: mapGeo(w, "a"), phaseIds: [p2] }); } catch (error) { expected = error.message; }
  assert.match(expected, new RegExp(`cannot start before the earlier phase ${p1}`));
  assert.equal(w.runtime.newTownDevelopmentReport()[0].status, "agreed", "the probe call above was refused and rolled back");
  press(w.container, "서비스 시작");
  assert.ok(shows(w.container, `런타임 오류(원문): ${expected}`));
  tick(w.container, "nt-f-phase", false, 1); tick(w.container, "nt-f-phase", true, 0);
  press(w.container, "서비스 시작");
  assert.deepEqual(w.runtime.newTownDevelopmentReport()[0].phases.map((p) => p.status), ["servicing", "planned"]);
});

test("the runtime's own save and load bring the records back; the panel then shows them against the same map", () => {
  const w = world();
  const id = bring(w, "a");
  const other = newRuntime();
  other.load(JSON.parse(JSON.stringify(w.runtime.save())));
  const panel = mountNewTownDevelopmentManagementPanel({ container: newContainer(), runtime: other, getGeometryExport: () => w.state.exp });
  assert.deepEqual(panel.view().rows.map((r) => [r.recordId, r.lifecycleStatus, r.mapState]), [[id, "proposed", "current"]]);
});
