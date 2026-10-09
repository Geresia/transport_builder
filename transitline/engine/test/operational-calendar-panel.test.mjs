import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  LIST_LIMIT, MAX_RANGE_DAYS, OPERATIONAL_CALENDAR_DRAFT_SCHEMA, SCOPE_NOTICE, WINDOW_DAYS, mountOperationalCalendarPanel, newDraftDoc, restoreDraftDoc,
} from "../src/operational-calendar-panel.mjs";
import { OPERATIONAL_CALENDAR_SCHEMA, calendarSupportsDayType, normalizeOperationalCalendar, operationalDayTypeAtDay, setOperationalCalendar } from "../src/operational-calendar.mjs";
import { snapshotOperationalState } from "../src/integrated-save.mjs";
import { createState } from "../src/state.mjs";

// --- a minimal DOM: elements, listeners, replaceChildren ---
class Node_ {
  constructor(tag) { Object.assign(this, { tag, children: [], className: "", textContent: "", value: "", disabled: false, placeholder: "", listeners: {} }); }
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
const button = (container, cls) => byClass(container, cls).find((n) => n.tag === "button");
const click = (container, cls) => { const b = button(container, cls); assert.ok(b, cls); if (!b.disabled) b.fire("click"); };
const rowOf = (container, day) => byClass(container, "opcal-row").find((r) => r.children[0].textContent.startsWith(`날 ${day} (`));
const stateText = (container, day) => rowOf(container, day).children[1].textContent;
const choose = (container, day, value) => { const s = byClass(rowOf(container, day), "opcal-select")[0]; s.value = value; s.fire("change"); };
const type = (container, cls, value) => { const i = byClass(container, cls)[0]; i.value = value; };
const metrics = (container) => Object.fromEntries(byClass(container, "opcal-metric").map((m) => [m.children[0].textContent, m.children[1].textContent]));
const deepFreeze = (o) => { if (o && typeof o === "object") { Object.values(o).forEach(deepFreeze); Object.freeze(o); } return o; };
const calendar = (days) => ({ schema: OPERATIONAL_CALENDAR_SCHEMA, contractVersion: 1, dayTypesByOperatingDay: days });
const IDENTITY = { packId: "calendar-panel", packVersion: "1" };

// The host: it owns the engine state and is the only thing that changes it, through the engine's own setter.
function host(over = {}) {
  const state = createState({ manifest: { id: "calendar-panel", version: "1", data: { license: "test", attribution: [] } }, demand: { model: "gravity", points: [], attractors: [] } });
  const calls = { apply: [], reads: 0 };
  const env = {
    state, calls, day: 9, identity: IDENTITY, failApply: null, ignoreApply: false, result: undefined, unreadable: false,
    getCalendar() { calls.reads += 1; if (env.unreadable) throw new Error("engine offline"); return state.operationalCalendar ?? null; },
    onApply(value) {
      calls.apply.push(value);
      if (env.failApply) throw new Error(env.failApply);
      if (!env.ignoreApply) setOperationalCalendar(state, value);
      return env.result;
    },
    ...over,
  };
  return env;
}
function mount(env = host(), container = newContainer()) {
  const panel = mountOperationalCalendarPanel({ container, getCalendar: () => env.getCalendar(), onApply: (v) => env.onApply(v), getCurrentDay: () => env.day, getSaveIdentity: () => env.identity });
  return { panel, container, env };
}

test("mounting needs a container, getCalendar and onApply; the panel never receives the engine", () => {
  const ok = { container: newContainer(), getCalendar: () => null, onApply: () => {} };
  assert.doesNotThrow(() => mountOperationalCalendarPanel(ok));
  assert.throws(() => mountOperationalCalendarPanel({ ...ok, container: null }), /container/);
  assert.throws(() => mountOperationalCalendarPanel({ ...ok, getCalendar: null }), /getCalendar/);
  assert.throws(() => mountOperationalCalendarPanel({ ...ok, onApply: null }), /onApply/);
});

test("with no calendar at all nothing is a holiday: every day is unspecified and follows the default rule, weekends are not holidays", () => {
  const { container, env, panel } = mount();
  assert.ok(shows(container, SCOPE_NOTICE));
  assert.ok(shows(container, "엔진의 달력: 없음 (null)"));
  assert.ok(shows(container, "초안: 달력 없음 (null)"));
  assert.equal(byClass(container, "opcal-row").length, WINDOW_DAYS);
  assert.equal(byClass(container, "opcal-row").filter((r) => classes(r).includes("holiday")).length, 0);
  assert.equal(byClass(container, "opcal-row").filter((r) => classes(r).includes("explicit")).length, 0);
  assert.equal(stateText(container, 9), "미지정 → 기본 규칙에 따라 평일", "day 9 is a Wednesday");
  assert.equal(stateText(container, 12), "미지정 → 기본 규칙에 따라 주말");
  assert.ok(shows(container, "휴일 지정이 있는가: 아니오"));
  assert.equal(panel.draft, null);
  assert.equal(panel.dirty, false);
  assert.equal(button(container, "opcal-apply").disabled, true);
  assert.deepEqual(env.calls.apply, []);
  assert.equal(env.state.operationalCalendar ?? null, null);
});

test("the window starts at the week of the current day, is marked, and moves by weeks, to today and to a typed day", () => {
  const { container, env } = mount();
  assert.ok(shows(container, `날짜 7~${7 + WINDOW_DAYS - 1}`));
  assert.ok(rowOf(container, 9).children[0].textContent.endsWith("현재"));
  assert.equal(rowOf(container, 0), undefined);
  click(container, "opcal-prev");
  assert.ok(shows(container, `날짜 0~${WINDOW_DAYS - 1}`));
  assert.equal(button(container, "opcal-prev").disabled, true, "there is no day before 0");
  click(container, "opcal-next"); click(container, "opcal-next");
  assert.ok(shows(container, `날짜 ${2 * WINDOW_DAYS}~`));
  click(container, "opcal-today");
  assert.ok(shows(container, "날짜 7~"));
  type(container, "opcal-goto-input", "100"); click(container, "opcal-goto");
  assert.ok(shows(container, "날짜 98~"));
  for (const bad of ["", "-3", "1.5", "abc", "10 days"]) { type(container, "opcal-goto-input", bad); click(container, "opcal-goto"); assert.ok(shows(container, "이동할 운영일 번호는 0 이상의 정수"), bad); }
  assert.ok(shows(container, "날짜 98~"), "a bad number leaves the window where it was");
  env.day = null;
  const unknownDay = mount(env).container;
  assert.ok(shows(unknownDay, "현재 알 수 없음"));
  assert.equal(button(unknownDay, "opcal-today").disabled, true);
  assert.ok(shows(unknownDay, "날짜 0~"));
});

test("the weekday names follow the engine's rule: day 0 is Monday, day 5 and 6 are the weekend", () => {
  const { container } = mount();
  const names = Object.fromEntries([7, 8, 9, 10, 11, 12, 13, 14].map((day) => [day, rowOf(container, day).children[0].textContent.match(/\((.)\)/)[1]]));
  assert.deepEqual(names, { 7: "월", 8: "화", 9: "수", 10: "목", 11: "금", 12: "토", 13: "일", 14: "월" });
  assert.equal(stateText(container, 12), "미지정 → 기본 규칙에 따라 주말");
  assert.equal(stateText(container, 14), "미지정 → 기본 규칙에 따라 평일");
});

test("unspecified, explicit weekday/weekend and holiday are different; an entry equal to the default is still an entry; clearing it makes the day unspecified again", () => {
  const { container, panel } = mount();
  choose(container, 10, "holiday");
  assert.equal(stateText(container, 10), "명시: 휴일");
  assert.ok(classes(rowOf(container, 10)).includes("holiday") && classes(rowOf(container, 10)).includes("explicit"));
  assert.equal(stateText(container, 11), "미지정 → 기본 규칙에 따라 평일", "the neighbour is untouched");
  choose(container, 8, "weekday");
  assert.equal(stateText(container, 8), "명시: 평일 (기본 규칙과 같음)", "explicitly the default is not the same as unspecified");
  assert.deepEqual(panel.draft.dayTypesByOperatingDay, { 8: "weekday", 10: "holiday" });
  choose(container, 12, "weekday");
  assert.equal(stateText(container, 12), "명시: 평일", "a Saturday can be named a weekday");
  assert.ok(classes(rowOf(container, 12)).includes("weekday"));
  choose(container, 10, "");
  assert.equal(stateText(container, 10), "미지정 → 기본 규칙에 따라 평일");
  assert.deepEqual(panel.draft.dayTypesByOperatingDay, { 8: "weekday", 12: "weekday" });
  assert.deepEqual(metrics(container), { "휴일 지정": "0", "평일 지정": "2", "주말 지정": "0", "엔진과 다른 날": "2", "새로 지정": "2", 바꿈: "0", "지정 해제": "0" });
  assert.ok(shows(container, "휴일 지정이 있는가: 아니오"));
  choose(container, 10, "holiday");
  assert.ok(shows(container, "휴일 지정이 있는가: 예"));
});

test("no calendar (null) and a calendar that names 0 days are different drafts, and different from the engine's", () => {
  const { container, panel } = mount();
  assert.equal(panel.draft, null);
  choose(container, 10, "holiday");
  choose(container, 10, "");
  assert.deepEqual(panel.draft, calendar({}), "an emptied calendar is still a calendar");
  assert.ok(shows(container, "초안: 달력 있음 — 명시한 날 0일"));
  assert.ok(shows(container, "달력은 있지만 직접 지정한 날은 0일입니다"));
  assert.equal(panel.dirty, true, "an empty calendar is not the same as none");
  click(container, "opcal-clear");
  assert.equal(panel.draft, null);
  assert.equal(panel.dirty, false);
  assert.ok(shows(container, "초안: 달력 없음 (null)"));
  assert.equal(button(container, "opcal-clear").disabled, true);
});

test("a range is set or cleared in one go; a bad range is refused with a reason and changes nothing", () => {
  const { container, panel } = mount();
  type(container, "opcal-range-from", "20"); type(container, "opcal-range-to", "23"); byClass(container, "opcal-range-type")[0].value = "holiday";
  click(container, "opcal-range-apply");
  assert.deepEqual(panel.draft.dayTypesByOperatingDay, { 20: "holiday", 21: "holiday", 22: "holiday", 23: "holiday" });
  assert.ok(shows(container, "날 20~23 을(를) 휴일(으)로 지정했습니다(초안)"));
  const before = JSON.stringify(panel.draft);
  for (const [from, to, part] of [["a", "5", "0 이상의 정수"], ["5", "-1", "0 이상의 정수"], ["9", "3", "처음이 끝보다 클 수 없습니다"], ["0", String(MAX_RANGE_DAYS), `${MAX_RANGE_DAYS}일까지`], ["", "4", "0 이상의 정수"]]) {
    type(container, "opcal-range-from", from); type(container, "opcal-range-to", to);
    click(container, "opcal-range-apply");
    assert.ok(shows(container, part), `${from}-${to}`);
    assert.equal(JSON.stringify(panel.draft), before);
  }
  type(container, "opcal-range-from", "21"); type(container, "opcal-range-to", "22"); byClass(container, "opcal-range-type")[0].value = "";
  click(container, "opcal-range-apply");
  assert.deepEqual(panel.draft.dayTypesByOperatingDay, { 20: "holiday", 23: "holiday" });
  type(container, "opcal-range-from", "0"); type(container, "opcal-range-to", String(MAX_RANGE_DAYS - 1)); byClass(container, "opcal-range-type")[0].value = "weekend";
  click(container, "opcal-range-apply");
  assert.equal(Object.keys(panel.draft.dayTypesByOperatingDay).length, MAX_RANGE_DAYS);
  assert.ok(shows(container, `외 ${MAX_RANGE_DAYS - LIST_LIMIT}일은 표시하지 않았습니다`));
});

test("editing changes only the draft: the engine's state is not touched until the player applies", () => {
  const { container, env, panel } = mount();
  const before = JSON.stringify(snapshotOperationalState(env.state));
  choose(container, 10, "holiday");
  type(container, "opcal-range-from", "30"); type(container, "opcal-range-to", "31"); click(container, "opcal-range-apply");
  panel.refresh();
  assert.equal(JSON.stringify(snapshotOperationalState(env.state)), before);
  assert.equal(env.state.operationalCalendar ?? null, null);
  assert.deepEqual(env.calls.apply, []);
  assert.equal(panel.dirty, true);
  assert.equal(button(container, "opcal-apply").disabled, false);
  assert.ok(shows(container, "엔진에 아직 적용하지 않은 변경이 있습니다"));
  assert.ok(shows(container, "엔진: 미지정 → 초안: 휴일"));
});

test("apply hands the host a canonical calendar once; the engine accepts it without warnings and then runs the named day type", () => {
  const { container, env, panel } = mount();
  choose(container, 10, "holiday");
  type(container, "opcal-goto-input", "100"); click(container, "opcal-goto");
  choose(container, 100, "weekday");
  choose(container, 102, "weekend");
  click(container, "opcal-apply");
  assert.equal(env.calls.apply.length, 1);
  assert.deepEqual(env.calls.apply[0], calendar({ 10: "holiday", 100: "weekday", 102: "weekend" }));
  assert.deepEqual(Object.keys(env.calls.apply[0].dayTypesByOperatingDay), ["10", "100", "102"], "keys in numeric order, not text order");
  assert.deepEqual(normalizeOperationalCalendar(env.calls.apply[0]).warnings, []);
  assert.deepEqual(env.state.operationalCalendar, env.calls.apply[0]);
  assert.equal(operationalDayTypeAtDay(10, env.state.operationalCalendar), "holiday");
  assert.equal(operationalDayTypeAtDay(11, env.state.operationalCalendar), "weekday");
  assert.equal(operationalDayTypeAtDay(100, env.state.operationalCalendar), "weekday");
  assert.equal(calendarSupportsDayType(env.state.operationalCalendar, "holiday"), true);
  assert.equal(panel.dirty, false);
  assert.ok(shows(container, "엔진에 전달했습니다(명시한 날 3일)"));
  assert.ok(shows(container, "초안이 엔진의 달력과 같습니다"));
  assert.ok(shows(container, "엔진의 달력: 있음 — 명시한 날 3일 (휴일 1일)"));
  assert.equal(button(container, "opcal-apply").disabled, true);
  click(container, "opcal-apply");
  assert.equal(env.calls.apply.length, 1, "nothing to apply twice");
  env.calls.apply[0].dayTypesByOperatingDay[999] = "holiday";
  assert.equal(panel.draft.dayTypesByOperatingDay[999], undefined, "the host got a copy");
});

test("applying 'no calendar' hands the host null, which removes the calendar; removing every entry hands an empty calendar instead", () => {
  const env = host();
  setOperationalCalendar(env.state, calendar({ 3: "holiday", 40: "weekday" }));
  const { container, panel } = mount(env);
  assert.deepEqual(panel.draft, calendar({ 3: "holiday", 40: "weekday" }), "the draft starts as the engine's calendar");
  assert.equal(panel.dirty, false);
  click(container, "opcal-clear");
  click(container, "opcal-apply");
  assert.deepEqual(env.calls.apply, [null]);
  assert.equal(env.state.operationalCalendar, null);
  assert.ok(shows(container, "엔진에 전달했습니다(달력 없음)"));
  assert.ok(shows(container, "엔진의 달력: 없음 (null)"));
  setOperationalCalendar(env.state, calendar({ 3: "holiday" }));
  panel.refresh();
  panel.showDay(3);
  choose(container, 3, "");
  click(container, "opcal-apply");
  assert.deepEqual(env.calls.apply[1], calendar({}));
  assert.deepEqual(env.state.operationalCalendar, calendar({}), "a calendar with no days, not none");
  assert.ok(shows(container, "엔진의 달력: 있음 — 명시한 날 0일"));
});

test("an engine that refuses is shown as it is, the draft stays, and the same apply can be tried again", () => {
  const { container, env, panel } = mount();
  choose(container, 10, "holiday");
  env.failApply = "state is frozen";
  click(container, "opcal-apply");
  assert.ok(shows(container, "엔진에 적용하지 못했습니다: state is frozen"));
  assert.equal(panel.dirty, true);
  assert.deepEqual(panel.draft, calendar({ 10: "holiday" }));
  assert.equal(env.state.operationalCalendar ?? null, null);
  env.failApply = null;
  click(container, "opcal-apply");
  assert.ok(!shows(container, "state is frozen"));
  assert.equal(panel.dirty, false);
  assert.equal(env.calls.apply.length, 2);
});

test("a host that does not change the engine leaves the draft marked as not applied; the engine's own warnings are shown", () => {
  const { container, env, panel } = mount();
  choose(container, 10, "holiday");
  env.ignoreApply = true;
  env.result = { warnings: ["operational-calendar-entry-invalid:abc"] };
  click(container, "opcal-apply");
  assert.equal(panel.dirty, true);
  assert.ok(shows(container, "엔진에 아직 적용하지 않은 변경이 있습니다"));
  assert.ok(shows(container, "엔진 경고: 올바르지 않은 항목은 무시됨: 날 abc"));
});

test("refresh: an untouched draft follows the engine; an edited draft is kept and the difference is shown", () => {
  const { container, env, panel } = mount();
  setOperationalCalendar(env.state, calendar({ 12: "holiday" }));
  panel.refresh();
  assert.deepEqual(panel.draft, calendar({ 12: "holiday" }));
  assert.equal(panel.dirty, false);
  assert.equal(stateText(container, 12), "명시: 휴일");
  choose(container, 10, "holiday");
  setOperationalCalendar(env.state, calendar({ 12: "holiday", 11: "weekend" }));
  panel.refresh();
  assert.deepEqual(panel.draft, calendar({ 10: "holiday", 12: "holiday" }), "the player's edit is kept as it was");
  assert.deepEqual(panel.applied, calendar({ 11: "weekend", 12: "holiday" }));
  assert.equal(panel.dirty, true);
  assert.ok(shows(rowOf(container, 11), "엔진: 주말 → 초안: 미지정"));
  assert.equal(metrics(container)["새로 지정"], "1");
  assert.equal(metrics(container)["지정 해제"], "1");
  click(container, "opcal-revert");
  assert.deepEqual(panel.draft, calendar({ 11: "weekend", 12: "holiday" }));
  assert.equal(panel.dirty, false);
});

test("a calendar the engine holds with bad entries is shown with warnings, and the draft takes only the usable days", () => {
  const env = host();
  env.state.operationalCalendar = calendar({ 5: "holiday", abc: "holiday", 6: "party", "-2": "weekend" });
  const { container, panel } = mount(env);
  assert.deepEqual(panel.draft, calendar({ 5: "holiday" }));
  assert.ok(shows(container, "엔진 달력 경고: 올바르지 않은 항목은 무시됨: 날 abc"));
  assert.ok(shows(container, "올바르지 않은 항목은 무시됨: 날 6"));
  assert.ok(shows(container, "올바르지 않은 항목은 무시됨: 날 -2"));
  env.state.operationalCalendar = { schema: "other/1" };
  panel.refresh();
  assert.ok(shows(container, "엔진의 달력 형식이 올바르지 않음"));
  assert.ok(shows(container, "엔진의 달력: 없음 (null)"));
});

test("when the engine's calendar cannot be read, the last one read stays and a warning says so: it is not turned into 'no calendar'", () => {
  const env = host();
  setOperationalCalendar(env.state, calendar({ 3: "holiday" }));
  const { container, panel } = mount(env);
  env.unreadable = true;
  panel.refresh();
  assert.deepEqual(panel.applied, calendar({ 3: "holiday" }));
  assert.deepEqual(panel.draft, calendar({ 3: "holiday" }));
  assert.ok(shows(container, "엔진의 달력을 읽지 못함(이전에 읽은 값을 그대로 둠)"));
  env.unreadable = false;
  panel.refresh();
  assert.ok(!shows(container, "읽지 못함"));
});

test("the draft is a document that round-trips byte for byte and carries the save it was written for", () => {
  const { container, panel } = mount();
  choose(container, 10, "holiday"); choose(container, 8, "weekday");
  const saved = panel.serialize();
  const parsed = JSON.parse(saved);
  assert.equal(parsed.schema, OPERATIONAL_CALENDAR_DRAFT_SCHEMA);
  assert.deepEqual(parsed.identity, IDENTITY);
  assert.deepEqual(parsed.calendar, calendar({ 8: "weekday", 10: "holiday" }));
  const fresh = mount();
  assert.equal(fresh.panel.draft, null);
  assert.deepEqual(fresh.panel.loadDoc(saved), { ok: true, issues: [] });
  assert.equal(fresh.panel.serialize(), saved);
  assert.deepEqual(fresh.panel.draft, calendar({ 8: "weekday", 10: "holiday" }));
  assert.equal(fresh.panel.dirty, true, "a loaded draft is not applied");
  assert.deepEqual(fresh.env.calls.apply, []);
  assert.equal(fresh.env.state.operationalCalendar ?? null, null);
  assert.ok(shows(fresh.container, "저장해 둔 초안을 불러왔습니다. 엔진에는 아직 적용하지 않았습니다"));
  const none = mount();
  assert.equal(JSON.parse(none.panel.serialize()).calendar, null, "no calendar is saved as null, not as an empty one");
});

test("a draft made for another save is refused, and so is one that cannot be told apart from this save; the current draft is kept", () => {
  const a = mount();
  choose(a.container, 10, "holiday");
  const saved = a.panel.serialize();
  const otherPack = host({ identity: { packId: "other-pack", packVersion: "1" } });
  const b = mount(otherPack);
  choose(b.container, 11, "weekend");
  const mine = b.panel.serialize();
  assert.deepEqual(b.panel.loadDoc(saved), { ok: false, issues: ["calendar-draft-other-save"] });
  assert.equal(b.panel.serialize(), mine);
  const otherVersion = mount(host({ identity: { packId: "calendar-panel", packVersion: "2" } }));
  assert.deepEqual(otherVersion.panel.loadDoc(saved).issues, ["calendar-draft-other-save"]);
  const noIdentity = mount(host({ identity: null }));
  assert.deepEqual(noIdentity.panel.loadDoc(saved).issues, ["calendar-draft-save-unverifiable"]);
  const anonymous = JSON.parse(noIdentity.panel.serialize());
  assert.equal(anonymous.identity, null);
  assert.deepEqual(a.panel.loadDoc(anonymous).issues, ["calendar-draft-save-unverifiable"], "and the other way round");
  assert.deepEqual(noIdentity.panel.loadDoc(anonymous), { ok: true, issues: [] }, "two documents that name no save agree only with each other");
  assert.ok(shows(a.container, "이 초안이 속한 저장본: {\"packId\":\"calendar-panel\",\"packVersion\":\"1\"}"));
  assert.ok(shows(noIdentity.container, "확인할 수 없음 (식별 정보 없음)"));
});

test("a draft with anything wrong in it is refused whole and changes nothing", () => {
  const { container, panel } = mount();
  choose(container, 10, "holiday");
  const keep = panel.serialize();
  const doc = (calendarValue, extra = {}) => ({ schema: OPERATIONAL_CALENDAR_DRAFT_SCHEMA, version: 1, identity: IDENTITY, calendar: calendarValue, ...extra });
  const cases = [
    ["{", "calendar-draft-unreadable"], ["null", "calendar-draft-schema-invalid"], [JSON.stringify({ schema: "x", version: 1 }), "calendar-draft-schema-invalid"],
    [JSON.stringify(doc(null, { version: 2 })), "calendar-draft-schema-invalid"], [JSON.stringify(doc(null, { identity: "pack" })), "calendar-draft-identity-invalid"],
    [JSON.stringify(doc("x")), "calendar-draft-calendar-invalid"], [JSON.stringify(doc({ schema: "other/1", contractVersion: 1, dayTypesByOperatingDay: {} })), "calendar-draft-calendar-invalid"],
    [JSON.stringify(doc({ schema: OPERATIONAL_CALENDAR_SCHEMA, contractVersion: 2, dayTypesByOperatingDay: {} })), "calendar-draft-calendar-invalid"],
    [JSON.stringify(doc({ schema: OPERATIONAL_CALENDAR_SCHEMA, contractVersion: 1, dayTypesByOperatingDay: [] })), "calendar-draft-calendar-invalid"],
    [JSON.stringify(doc(calendar({ 5: "holiday", 6: "party" }))), "calendar-draft-entry-invalid:6"], [JSON.stringify(doc(calendar({ "-1": "holiday" }))), "calendar-draft-entry-invalid:-1"],
    [JSON.stringify(doc(calendar({ "01": "holiday" }))), "calendar-draft-entry-invalid:01"], [JSON.stringify(doc(calendar({ "1.5": "holiday" }))), "calendar-draft-entry-invalid:1.5"],
    [JSON.stringify(doc(calendar({ 7: null }))), "calendar-draft-entry-invalid:7"],
  ];
  for (const [input, issue] of cases) {
    const result = panel.loadDoc(input);
    assert.equal(result.ok, false, input);
    assert.ok(result.issues.includes(issue), `${issue} in ${result.issues}`);
    assert.equal(panel.serialize(), keep, input);
  }
});

test("restoreDraftDoc and newDraftDoc: copies, canonical order, and 'none' agreeing with 'none'", () => {
  const input = newDraftDoc(IDENTITY, calendar({ 30: "holiday", 4: "weekday" }));
  const restored = restoreDraftDoc(JSON.stringify(input), IDENTITY).doc;
  assert.deepEqual(Object.keys(restored.calendar.dayTypesByOperatingDay), ["4", "30"]);
  assert.deepEqual(restoreDraftDoc(newDraftDoc(null, null), null), { doc: newDraftDoc(null, null), issues: [] });
  assert.equal(restoreDraftDoc(newDraftDoc(IDENTITY, null), IDENTITY).doc.calendar, null);
  const source = calendar({ 1: "holiday" });
  const doc = newDraftDoc(IDENTITY, source);
  source.dayTypesByOperatingDay[2] = "weekday";
  assert.deepEqual(doc.calendar.dayTypesByOperatingDay, { 1: "holiday" }, "the document does not share the caller's object");
});

test("frozen engine data works and is not changed; the panel hands out copies", () => {
  const frozen = deepFreeze(calendar({ 3: "holiday" }));
  const env = host({ getCalendar: () => frozen });
  const { container, panel } = mount(env);
  choose(container, 10, "weekend");
  panel.refresh();
  assert.deepEqual(frozen, calendar({ 3: "holiday" }));
  const draft = panel.draft;
  draft.dayTypesByOperatingDay[99] = "holiday";
  const applied = panel.applied;
  applied.dayTypesByOperatingDay[98] = "holiday";
  assert.deepEqual(panel.draft.dayTypesByOperatingDay, { 3: "holiday", 10: "weekend" });
  assert.deepEqual(panel.applied, calendar({ 3: "holiday" }));
  click(container, "opcal-apply");
  assert.deepEqual(frozen, calendar({ 3: "holiday" }));
  assert.deepEqual(env.calls.apply[0].dayTypesByOperatingDay, { 3: "holiday", 10: "weekend" });
});

test("the module keeps its promises: no engine, no storage, no timer, no clock or random number, and no holiday knowledge of its own", () => {
  const source = fs.readFileSync(fileURLToPath(new URL("../src/operational-calendar-panel.mjs", import.meta.url)), "utf8").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/localStorage|sessionStorage|indexedDB/.test(source));
  assert.ok(!/setInterval|setTimeout|requestAnimationFrame|queueMicrotask/.test(source));
  assert.ok(!/Math\.random|Date\.now|new Date|performance\.now|Intl\./.test(source));
  assert.ok(!/setOperationalCalendar|operationalCalendar\s*=|runtime|scenario-runtime|operationalState/.test(source), "the panel never writes the engine's calendar or touches the runtime");
  assert.ok(!/설날|추석|광복절|christmas|holidays?\s*=\s*\[/i.test(source), "no list of public holidays");
  assert.deepEqual([...source.matchAll(/^import \{([^}]*)\} from "(.*)";$/gm)].map((m) => m[2]), ["./operational-calendar.mjs"]);
});
