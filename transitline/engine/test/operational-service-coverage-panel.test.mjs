import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  DISPATCH_SOURCES, HOLIDAY_FALLBACK_NOTICE, LIST_LIMIT, OPERATIONAL_SERVICE_COVERAGE_REPORT_SCHEMA, SCOPE_NOTICE, checkCoverageReport, mountOperationalServiceCoveragePanel,
} from "../src/operational-service-coverage-panel.mjs";
import { buildOperationalServiceCoverageReport } from "../src/operational-service-coverage-report.mjs";

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
  const row = all(card, (n) => classes(n).includes("cov-fact")).find((n) => n.children[0]?.textContent === label);
  assert.ok(row, `fact ${label}`);
  return row.children[1].textContent;
};
const hasFact = (card, label) => all(card, (n) => classes(n).includes("cov-fact")).some((n) => n.children[0]?.textContent === label);
const lineCard = (container, id) => byClass(container, "cov-line").find((c) => c.children[0].textContent.startsWith(`노선 ${id} `));
const metrics = (container) => Object.fromEntries(byClass(container, "cov-metric").map((m) => [m.children[0].textContent, m.children[1].textContent]));
const pick = (select, value) => { select.value = value; select.fire("change"); };
const select = (container, name) => byClass(container, name)[0];
const deepFreeze = (o) => { if (o && typeof o === "object") { Object.values(o).forEach(deepFreeze); Object.freeze(o); } return o; };

const SCHEMA = OPERATIONAL_SERVICE_COVERAGE_REPORT_SCHEMA;
const row = (id, over = {}) => ({
  operationalLineId: id, name: `Line ${id}`, managementServiceId: `service:${id}`, dispatchSource: "timetable", timetableId: `railway-timetable:${id}`, timetableDayType: "weekday",
  serviceStatus: "active", lineSuspended: false, ...over,
});
const report = (lines, over = {}) => ({ schema: SCHEMA, contractVersion: 1, currentDay: 9, currentDayType: "weekday", lines, ...over });
// one line for each dispatch source
const everySource = (over = {}) => report([
  row("1"),
  row("2", { dispatchSource: "legacy-frequency", timetableId: null, timetableDayType: null, serviceStatus: undefined, legacyFrequency: { high: 6, medium: 4 } }),
  row("3", { dispatchSource: "suspended", lineSuspended: true }),
  row("4", { dispatchSource: "no-operational-line", managementServiceId: null, timetableId: null, timetableDayType: null, lineSuspended: null }),
  row("5", { dispatchSource: "unknown", timetableId: null, timetableDayType: null, lineSuspended: null }),
], over);
function mount(getReport) {
  const container = newContainer();
  const panel = mountOperationalServiceCoveragePanel({ container, getReport });
  return { panel, container };
}
const lineIds = (container) => byClass(container, "cov-line").map((c) => c.children[0].textContent.split(" · ")[0].replace("노선 ", ""));

test("mounting needs a container and a getReport function", () => {
  assert.throws(() => mountOperationalServiceCoveragePanel({ getReport: () => ({}) }), /container/);
  assert.throws(() => mountOperationalServiceCoveragePanel({ container: newContainer() }), /getReport/);
  assert.throws(() => mountOperationalServiceCoveragePanel({ container: newContainer(), getReport: {} }), /getReport/);
});

test("the panel accepts the committed B18-E4 report without a field-name adapter", () => {
  const coverage = buildOperationalServiceCoverageReport({ operationalState: { simMinutes: 4320, lines: [] }, services: [] });
  assert.equal(coverage.currentDay, 3);
  assert.equal(coverage.currentDayType, "weekday");
  assert.equal("operatingDay" in coverage, false);
  assert.equal("dayType" in coverage, false);
  const { container, panel } = mount(() => coverage);
  assert.equal(checkCoverageReport(coverage).ok, true);
  assert.equal(factValue(container, "현재 운영일 번호"), "3");
  assert.equal(factValue(container, "오늘의 요일 유형"), "평일 (weekday)");
  assert.equal(panel.report.currentDayTypeSource, "default-rule");
});

test("the report is read when mounted and refreshed, never when the filter changes; the panel is given no runtime to command", () => {
  let reads = 0;
  const { panel } = mount(() => { reads += 1; return everySource(); });
  assert.equal(reads, 1);
  panel.refresh(); panel.refresh();
  assert.equal(reads, 3);
  panel.setFilter({ dispatchSource: "timetable" });
  panel.setFilter({ timetableId: null });
  panel.setFilter({});
  assert.equal(reads, 3);
});

test("a report that is not what the panel reads is refused whole: nothing is drawn but the reason", () => {
  const bad = [
    [null, "보고서가 없습니다"], [undefined, "보고서가 없습니다"], [[], "보고서가 없습니다"], ["text", "보고서가 없습니다"], [{ schema: "other/1", lines: [] }, "알 수 없는 보고서 형식"],
    [{ lines: [] }, "알 수 없는 보고서 형식"], [{ schema: SCHEMA, lines: {} }, "lines가 목록도 null도 아닙니다"], [{ schema: SCHEMA, lines: "x" }, "lines가 목록도 null도 아닙니다"],
    [{ schema: SCHEMA }, "lines가 목록도 null도 아닙니다"], [report([], { currentDay: -1 }), "currentDay가 올바르지 않습니다"], [report([], { currentDay: 1.5 }), "currentDay가 올바르지 않습니다"],
    [report([], { currentDay: "3" }), "currentDay가 올바르지 않습니다"],
  ];
  for (const [value, part] of bad) {
    const { container } = mount(() => value);
    assert.ok(shows(container, part), `${JSON.stringify(value)} -> ${part}`);
    assert.equal(byClass(container, "cov-card").length, 0);
    assert.equal(all(container, (n) => n.tag === "select").length, 0);
    assert.equal(checkCoverageReport(value).ok, false);
  }
  const { container } = mount(() => { throw new Error("runtime offline"); });
  assert.ok(shows(container, "보고서를 읽지 못했습니다: runtime offline"));
  let value = { nope: true };
  const { panel, container: again } = mount(() => value);
  assert.ok(shows(again, "알 수 없는 보고서 형식"));
  value = everySource();
  panel.refresh();
  assert.equal(byClass(again, "cov-line").length, 5, "a good report after a bad one is drawn");
  assert.equal(panel.report.schema, SCHEMA);
  assert.equal(mountOperationalServiceCoveragePanel({ container: newContainer(), getReport: () => null }).report, null);
});

test("every dispatch source is shown with its own word and code, and counted", () => {
  const { container } = mount(() => everySource());
  const expected = { 1: ["시간표", "timetable"], 2: ["기존 빈도 운행", "legacy-frequency"], 3: ["운휴", "suspended"], 4: ["운행선 아님", "no-operational-line"], 5: ["미상", "unknown"] };
  assert.deepEqual(DISPATCH_SOURCES, ["timetable", "legacy-frequency", "suspended", "no-operational-line", "unknown"]);
  for (const [id, [word, code]] of Object.entries(expected)) {
    const card = lineCard(container, id);
    assert.equal(factValue(card, "현재 배차 원천"), `${word} (${code})`, id);
    assert.ok(classes(card).includes(code), id);
  }
  const m = metrics(container);
  assert.deepEqual([m["표시한 노선"], m["시간표"], m["기존 빈도 운행"], m["운휴"], m["운행선 아님"], m["미상"], m["원천 코드를 알 수 없음"]], ["5", "1", "1", "1", "1", "1", "0"]);
  assert.equal(hasFact(lineCard(container, "5"), "원천의 이유"), false, "the report's reasons are not invented as a different field");
});

test("a source code the panel does not know, or a missing one, is shown as it is and is never taken for one of the five", () => {
  const { container, panel } = mount(() => report([row("1", { dispatchSource: "bus-bridge" }), row("2", { dispatchSource: null }), row("3", { dispatchSource: undefined })]));
  assert.equal(factValue(lineCard(container, "1"), "현재 배차 원천"), "알 수 없는 원천 코드: bus-bridge");
  assert.ok(classes(lineCard(container, "1")).includes("unrecognized"));
  assert.equal(factValue(lineCard(container, "2"), "현재 배차 원천"), "미상");
  assert.equal(factValue(lineCard(container, "3"), "현재 배차 원천"), "미상");
  assert.equal(metrics(container)["원천 코드를 알 수 없음"], "3");
  assert.equal(metrics(container)["시간표"], "0", "a zero count is a zero");
  assert.deepEqual(select(container, "cov-filter-source").children.map((o) => o.value), ["", ...DISPATCH_SOURCES, "bus-bridge"]);
  panel.setFilter({ dispatchSource: "bus-bridge" });
  assert.deepEqual(lineIds(container), ["1"]);
});

test("the current operating day and its day type are shown as reported: weekday, weekend, holiday, unknown and a type the panel does not know", () => {
  for (const [currentDayType, text] of [["weekday", "평일 (weekday)"], ["weekend", "주말 (weekend)"], ["holiday", "휴일 (holiday)"], [null, "미상"], ["carnival", "carnival (carnival)"]]) {
    const { container } = mount(() => report([], { currentDayType, currentDay: 12 }));
    assert.equal(factValue(container, "현재 운영일 번호"), "12");
    assert.equal(factValue(container, "오늘의 요일 유형"), text, String(currentDayType));
  }
  assert.equal(factValue(mount(() => report([], { currentDay: 0 })).container, "현재 운영일 번호"), "0", "day 0 is a day");
  assert.equal(factValue(mount(() => report([], { currentDay: null })).container, "현재 운영일 번호"), "미상", "null is unknown");
  assert.equal(factValue(mount(() => report([], { currentDay: undefined })).container, "현재 운영일 번호"), "미상");
  assert.equal(byClass(mount(() => report([])).container, "cov-daytype-source").length, 0, "no source is shown when the report gives none");
  assert.equal(factValue(mount(() => report([], { currentDayTypeSource: "calendar" })).container, "요일 유형의 출처"), "calendar");
  assert.equal(factValue(mount(() => report([], { currentDayTypeSource: null })).container, "요일 유형의 출처"), "미상");
});

test("the timetable id, its day type and its status are shown as facts, and a missing id keeps its reason", () => {
  const { container } = mount(() => everySource());
  const timetable = lineCard(container, "1");
  assert.equal(factValue(timetable, "시간표 ID"), "railway-timetable:1");
  assert.equal(factValue(timetable, "시간표의 요일 유형"), "평일 (weekday)");
  assert.equal(factValue(timetable, "서비스 상태"), "active");
  const frequency = lineCard(container, "2");
  assert.equal(factValue(frequency, "시간표 ID"), "미상");
  assert.equal(factValue(frequency, "시간표의 요일 유형"), "미상");
  assert.equal(hasFact(frequency, "서비스 상태"), false, "a status the report did not give is not shown");
  assert.equal(factValue(frequency, "노선에 설정된 기존 빈도"), "{\"high\":6,\"medium\":4}");
  assert.equal(factValue(lineCard(container, "4"), "경영 서비스"), "미상");
  const odd = mount(() => report([row("7", { timetableDayType: "holiday" })], { currentDayType: "weekday" })).container;
  assert.equal(factValue(lineCard(odd, "7"), "시간표의 요일 유형"), "휴일 (holiday)");
  assert.ok(shows(lineCard(odd, "7"), "시간표의 요일 유형(holiday)과 오늘의 요일 유형(weekday)이 다르게 보고되었습니다 — 보고서 값 그대로입니다"));
  assert.equal(byClass(lineCard(container, "1"), "cov-daytype-differs").length, 0);
});

test("on a holiday with no timetable the fact 'old frequency' and its limit are shown, and nothing about quality, capacity, cost or crowding is claimed", () => {
  const holiday = report([
    row("1", { dispatchSource: "legacy-frequency", timetableId: null, timetableDayType: null }),
    row("2"),
    row("3", { dispatchSource: "suspended", timetableId: null }),
    row("4", { dispatchSource: "legacy-frequency", timetableId: "railway-timetable:9" }),
  ], { currentDayType: "holiday" });
  const { container } = mount(() => holiday);
  assert.ok(shows(lineCard(container, "1"), HOLIDAY_FALLBACK_NOTICE));
  assert.equal(byClass(lineCard(container, "1"), "cov-holiday-fallback").length, 1);
  assert.equal(factValue(lineCard(container, "1"), "현재 배차 원천"), "기존 빈도 운행 (legacy-frequency)");
  for (const id of ["2", "3", "4"]) assert.equal(byClass(lineCard(container, id), "cov-holiday-fallback").length, 0, `line ${id}`);
  assert.equal(metrics(container)["휴일인데 시간표 없이 기존 빈도로 운행"], "1");
  assert.match(HOLIDAY_FALLBACK_NOTICE, /추정하지 않습니다/);
  assert.ok(!/부족|나쁘|좋|낮|높|문제|위험|안전|정상|비정상/.test(HOLIDAY_FALLBACK_NOTICE), "the notice states the fact and the limit, nothing else");
  const weekday = mount(() => report(holiday.lines, { currentDayType: "weekday" })).container;
  assert.equal(byClass(weekday, "cov-holiday-fallback").length, 0, "the same line on a weekday has no such notice");
  assert.equal(metrics(weekday)["휴일인데 시간표 없이 기존 빈도로 운행"], "0");
  const unknownDay = mount(() => report(holiday.lines, { currentDayType: null })).container;
  assert.equal(byClass(unknownDay, "cov-holiday-fallback").length, 0, "an unknown day type is not assumed to be a holiday");
});

test("null, false, 0 and an empty list are four different things on screen", () => {
  const { container } = mount(() => report([
    row("1", { lineSuspended: false, legacyFrequency: 0 }),
    row("2", { lineSuspended: null, legacyFrequency: [] }),
    row("3", { lineSuspended: true, legacyFrequency: {} }),
    row("4", { lineSuspended: undefined, legacyFrequency: null, name: null }),
  ]));
  const field = (id, label) => factValue(lineCard(container, id), label);
  assert.equal(field("1", "노선 정지"), "아니오");
  assert.equal(field("1", "노선에 설정된 기존 빈도"), "0");
  assert.equal(field("2", "노선 정지"), "미상");
  assert.equal(field("2", "노선에 설정된 기존 빈도"), "빈 목록");
  assert.equal(field("3", "노선 정지"), "예");
  assert.equal(field("3", "노선에 설정된 기존 빈도"), "{}");
  assert.equal(field("4", "노선 정지"), "미상");
  assert.equal(field("4", "노선에 설정된 기존 빈도"), "미상");
  assert.ok(lineCard(container, "4").children[0].textContent.endsWith("· 미상"));
  const lists = [mount(() => report([])).container, mount(() => report(null)).container];
  assert.ok(shows(lists[0], "보고서에 노선이 없습니다(빈 목록)"));
  assert.ok(!shows(lists[0], "포함되지 않"));
  assert.ok(shows(lists[1], "노선 목록이 보고서에 포함되지 않았습니다 (lines: null)"));
  assert.ok(shows(lists[1], "노선 (보고서에 포함되지 않음)"));
  assert.equal(all(lists[1], (n) => n.tag === "select").length, 2, "filters exist but have nothing to choose from");
});

test("filters: by dispatch source, by timetable (including 'no timetable'), together; clearing; and the filter is only a view", () => {
  const frozen = deepFreeze(everySource());
  const { container, panel } = mount(() => frozen);
  assert.deepEqual(lineIds(container), ["1", "2", "3", "4", "5"]);
  pick(select(container, "cov-filter-source"), "timetable");
  assert.deepEqual(lineIds(container), ["1"]);
  assert.deepEqual(panel.filter, { dispatchSource: "timetable" });
  pick(select(container, "cov-filter-source"), "");
  pick(select(container, "cov-filter-timetable"), "__none__");
  assert.deepEqual(lineIds(container), ["2", "4", "5"], "the lines that have no timetable");
  assert.deepEqual(panel.filter, { dispatchSource: null, timetableId: null });
  pick(select(container, "cov-filter-source"), "unknown");
  assert.deepEqual(lineIds(container), ["5"]);
  pick(select(container, "cov-filter-timetable"), "railway-timetable:1");
  assert.deepEqual(lineIds(container), []);
  assert.ok(shows(container, "필터에 맞는 노선이 없습니다"));
  assert.ok(shows(container, "(전체 5개 중 필터)"));
  pick(select(container, "cov-filter-source"), "timetable");
  assert.deepEqual(lineIds(container), ["1"]);
  panel.setFilter({});
  assert.deepEqual(lineIds(container), ["1", "2", "3", "4", "5"]);
  assert.ok(shows(container, "필터 없음"));
  assert.deepEqual(panel.filter, { dispatchSource: null });
  assert.deepEqual(select(container, "cov-filter-timetable").children.map((o) => o.value), ["", "__none__", "railway-timetable:1", "railway-timetable:3"]);
  assert.deepEqual(frozen, everySource(), "the report is untouched by filtering");
});

test("a filter survives a refresh while the report changes under it", () => {
  let value = everySource();
  const { panel, container } = mount(() => value);
  panel.setFilter({ dispatchSource: "suspended" });
  value = report([row("3", { dispatchSource: "suspended" }), row("8", { dispatchSource: "suspended" }), row("9")]);
  panel.refresh();
  assert.deepEqual(lineIds(container), ["3", "8"]);
  assert.deepEqual(panel.filter, { dispatchSource: "suspended" });
});

test("issues and limits are shown word for word; absent means not shown, null means not included, [] means none", () => {
  const withBoth = everySource({ issues: [{ code: "line-has-two-timetables", operationalLineId: "1", count: 0, detail: null, list: [], flag: false }, "plain text"], limits: [{ id: "frequency-not-assessed", text: "The old frequency is not assessed here." }] });
  const { container } = mount(() => withBoth);
  assert.ok(shows(container, "issues 2개"));
  assert.ok(byClass(container, "cov-issue").some((n) => n.textContent === "line-has-two-timetables · operationalLineId: 1 · count: 0 · detail: 미상 · list: 빈 목록 · flag: 아니오"));
  assert.ok(byClass(container, "cov-issue").some((n) => n.textContent === "plain text"));
  assert.ok(byClass(container, "cov-limit-text").some((n) => n.textContent === "The old frequency is not assessed here."));
  assert.ok(shows(container, "issues는 보고서 안의 사실들이 어긋나는 곳을 적은 목록이며 판정이 아닙니다"));
  const none = mount(() => everySource()).container;
  assert.ok(!shows(none, "issues") && !shows(none, "limits"));
  const nulls = mount(() => everySource({ issues: null, limits: null })).container;
  assert.ok(shows(nulls, "issues (보고서에 포함되지 않음)") && shows(nulls, "limits (보고서에 포함되지 않음)"));
  const empty = mount(() => everySource({ issues: [], limits: [] })).container;
  assert.ok(shows(empty, "issues 0개") && shows(empty, "표시할 issue가 없습니다(빈 목록)") && shows(empty, "(limits)"));
  const body = byClass(container, "cov-issue").map((n) => n.textContent).join("\n");
  assert.ok(!/해결|실패|불가능|가능합니다|정상|비정상/.test(body));
});

test("a long list is cut at the limit and says so; entries that cannot be read are skipped and counted", () => {
  const lines = Array.from({ length: LIST_LIMIT + 7 }, (_, i) => row(String(i + 1)));
  lines.push(null, "x", 5);
  const { container, panel } = mount(() => report(lines));
  assert.equal(byClass(container, "cov-line").length, LIST_LIMIT);
  assert.ok(shows(container, `노선 ${LIST_LIMIT + 7}개`));
  assert.ok(shows(container, "외 7개는 표시하지 않았습니다"));
  assert.ok(shows(container, "읽을 수 없는 항목 3개는 건너뛰었습니다"));
  panel.setFilter({ dispatchSource: "suspended" });
  assert.ok(!shows(container, "표시하지 않았습니다"));
});

test("the report is not changed by showing it: a frozen report works; the panel hands out copies; the same report shows the same text", () => {
  const original = everySource({ issues: [{ code: "x" }], limits: [{ id: "y", text: "z" }] });
  const frozen = deepFreeze(structuredClone(original));
  const { container, panel } = mount(() => frozen);
  panel.setFilter({ dispatchSource: "timetable" }); panel.refresh(); panel.setFilter({});
  assert.deepEqual(frozen, original);
  const copy = panel.report;
  copy.lines.length = 0; copy.currentDayType = "tampered";
  assert.equal(panel.report.lines.length, 5);
  assert.equal(panel.report.currentDayType, "weekday");
  const first = texts(container);
  assert.deepEqual(texts(mount(() => structuredClone(original)).container), first);
  const shuffled = structuredClone(original);
  shuffled.lines.reverse();
  assert.deepEqual(texts(mount(() => shuffled).container), first, "lines are shown in line-id order whatever order they arrive in");
});

test("nothing is estimated: no quality, capacity, cost, demand or crowding wording or figure appears besides the two fixed notices", () => {
  const { container } = mount(() => report([
    row("1", { dispatchSource: "legacy-frequency", timetableId: null, timetableDayType: null, legacyFrequency: { high: 6 } }), row("2", { dispatchSource: "suspended" }),
  ], { currentDayType: "holiday" }));
  const body = texts(container).join("\n").replace(SCOPE_NOTICE, "").replace(HOLIDAY_FALLBACK_NOTICE, "");
  assert.ok(!/품질|수송력|비용|수요|혼잡|승객|운임|지연|가능|불가/.test(body), body);
  assert.ok(!/[0-9]+[ \t]*(원|엔|명|%)/.test(body), "no money, head-count or percentage figure on one line");
});

test("the module keeps its promises: no engine, no storage, no timer, no clock or random number, no import, no report recomputation", () => {
  const source = fs.readFileSync(fileURLToPath(new URL("../src/operational-service-coverage-panel.mjs", import.meta.url)), "utf8").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/localStorage|sessionStorage|indexedDB/.test(source));
  assert.ok(!/setInterval|setTimeout|requestAnimationFrame|queueMicrotask/.test(source));
  assert.ok(!/Math\.random|Date\.now|new Date|performance\.now/.test(source));
  assert.ok(!/runtime|scenario-runtime|operationalState|railwayTimetableReport|railwayTimetableOperationReport|timetableDispatches|state\.trains/.test(source), "it reads only the report it is given");
  assert.deepEqual([...source.matchAll(/^import .* from "(.*)";$/gm)].map((m) => m[1]), []);
  const hostile = { createElement: dom.createElement, defaultView: { localStorage: new Proxy({}, { get() { throw new Error("storage must not be touched"); } }) } };
  const container = Object.assign(new Node_("div"), { ownerDocument: hostile });
  const panel = mountOperationalServiceCoveragePanel({ container, getReport: () => everySource() });
  pick(select(container, "cov-filter-source"), "suspended");
  panel.refresh();
  assert.equal(byClass(container, "cov-line").length, 1);
});
