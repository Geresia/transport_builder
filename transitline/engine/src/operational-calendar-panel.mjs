// Operating-calendar editing panel (B18-M2).  The player states, day by day, which timetable day type the simulator runs: weekday,
// weekend or holiday.  The engine's calendar (`transitline.operational-calendar/1`, B18-C1) holds only the days the player named; every
// other day follows the engine's fixed rule (Monday-Friday weekday, Saturday-Sunday weekend).
//
//   - Nothing is guessed.  No public holiday is ever suggested or filled in: a holiday exists only on a day the player set to "holiday".
//   - "Unspecified" (no entry) and "holiday" are different things, and so are "no calendar at all" (null) and "a calendar that names 0 days".
//     An entry that equals the default rule ("weekday" on a Monday) is still an explicit entry, shown as such.
//   - The panel edits a DRAFT.  It never changes the engine: "apply" hands the finished calendar to the host's `onApply`, which is the one
//     place that talks to the engine.  The panel has no runtime, saves nothing itself and uses no localStorage; the draft is a document the
//     host may keep (serialize / loadDoc), and a document made for another save is refused.
import { OPERATIONAL_CALENDAR_SCHEMA, OPERATIONAL_DAY_TYPES, calendarSupportsDayType, defaultOperationalDayType, normalizeOperationalCalendar, operationalDayTypeAtDay } from "./operational-calendar.mjs";

export const OPERATIONAL_CALENDAR_DRAFT_SCHEMA = "transitline.operational-calendar-draft/1";
export const WINDOW_DAYS = 28;
export const MAX_RANGE_DAYS = 366;
export const LIST_LIMIT = 100;

export const SCOPE_NOTICE = "시뮬레이션의 각 날(운영일 번호)이 평일·주말·휴일 중 무엇인지 직접 정하는 패널입니다. 공휴일은 추정하거나 미리 채우지 않습니다 — 휴일은 직접 '휴일'로 지정한 날만 생깁니다. 지정하지 않은 날은 엔진의 기본 규칙(월~금 평일, 토·일 주말)을 따릅니다. 이 패널은 초안을 편집할 뿐이며, '엔진에 적용'을 눌러야 호스트가 엔진에 전달합니다.";

const TYPE_TEXT = Object.freeze({ weekday: "평일", weekend: "주말", holiday: "휴일" });
const WEEKDAY_NAME = Object.freeze(["월", "화", "수", "목", "금", "토", "일"]);
const WARNING_TEXT = Object.freeze({
  "operational-calendar-schema-invalid": "엔진의 달력 형식이 올바르지 않음",
  "operational-calendar-days-invalid": "엔진 달력의 날짜 목록이 올바르지 않음",
  "operational-calendar-unreadable": "엔진의 달력을 읽지 못함(이전에 읽은 값을 그대로 둠)",
});

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isDay = (value) => Number.isInteger(value) && value >= 0;
const clone = (value) => structuredClone(value);
const message = (error) => (error instanceof Error ? error.message : String(error));
const weekdayName = (day) => WEEKDAY_NAME[((day % 7) + 7) % 7];
const canonical = (v) => (Array.isArray(v) ? `[${v.map(canonical).join(",")}]` : isObject(v) ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}` : JSON.stringify(v ?? null));
const byNumber = (a, b) => Number(a) - Number(b);

function warningText(code) {
  const base = code.split(":")[0];
  if (WARNING_TEXT[base]) return `${WARNING_TEXT[base]} (${code})`;
  return code.startsWith("operational-calendar-entry-invalid") ? `올바르지 않은 항목은 무시됨: 날 ${code.split(":")[1]} (${code})` : code;
}

function sortedDays(days) {
  return Object.fromEntries(Object.keys(days).sort(byNumber).map((day) => [day, days[day]]));
}
const calendarOf = (days) => ({ schema: OPERATIONAL_CALENDAR_SCHEMA, contractVersion: 1, dayTypesByOperatingDay: sortedDays(days) });

// --- the draft document: the calendar the player is writing, and which save it was written for ---------------------------------------
// calendar: null (no calendar at all) | { schema, contractVersion: 1, dayTypesByOperatingDay }
export function newDraftDoc(identity = null, calendar = null) {
  return { schema: OPERATIONAL_CALENDAR_DRAFT_SCHEMA, version: 1, identity: identity === null ? null : clone(identity), calendar: calendar === null ? null : clone(calendar) };
}

// -> { doc | null, issues }. Any issue refuses the whole document.  `identity` is what the current save says it is; a document made for
// a different save (or for none, or this save having none) is refused: the panel cannot tell it is the same game.
export function restoreDraftDoc(input, identity = null) {
  let raw = input;
  if (typeof input === "string") { try { raw = JSON.parse(input); } catch { return { doc: null, issues: ["calendar-draft-unreadable"] }; } }
  if (!isObject(raw) || raw.schema !== OPERATIONAL_CALENDAR_DRAFT_SCHEMA || raw.version !== 1) return { doc: null, issues: ["calendar-draft-schema-invalid"] };
  const mine = identity === null ? null : canonical(identity);
  const theirs = raw.identity === null || raw.identity === undefined ? null : isObject(raw.identity) ? canonical(raw.identity) : undefined;
  if (theirs === undefined) return { doc: null, issues: ["calendar-draft-identity-invalid"] };
  if (theirs !== mine) return { doc: null, issues: [mine === null || theirs === null ? "calendar-draft-save-unverifiable" : "calendar-draft-other-save"] };
  if (raw.calendar === null) return { doc: newDraftDoc(identity, null), issues: [] };
  if (!isObject(raw.calendar) || raw.calendar.schema !== OPERATIONAL_CALENDAR_SCHEMA || raw.calendar.contractVersion !== 1 || !isObject(raw.calendar.dayTypesByOperatingDay)) return { doc: null, issues: ["calendar-draft-calendar-invalid"] };
  const issues = [];
  const days = {};
  for (const [rawDay, type] of Object.entries(raw.calendar.dayTypesByOperatingDay)) {
    const day = Number(rawDay);
    if (!isDay(day) || String(day) !== rawDay || !OPERATIONAL_DAY_TYPES.includes(type)) { issues.push(`calendar-draft-entry-invalid:${rawDay}`); continue; }
    days[rawDay] = type;
  }
  if (issues.length) return { doc: null, issues: issues.sort() };
  return { doc: newDraftDoc(identity, calendarOf(days)), issues: [] };
}

const el = (doc, tag, props = {}, ...kids) => { const node = doc.createElement(tag); Object.assign(node, props); node.append(...kids); if ("value" in props) node.value = props.value; return node; };
const text = (doc, tag, className, value) => el(doc, tag, { className, textContent: value });
const metric = (doc, label, value) => el(doc, "div", { className: "opcal-metric" }, text(doc, "span", "", label), text(doc, "b", "", value));

export function mountOperationalCalendarPanel({ container, getCalendar, onApply, getCurrentDay = () => null, getSaveIdentity = () => null } = {}) {
  if (!container) throw new Error("An operating calendar container is required");
  if (typeof getCalendar !== "function") throw new Error("getCalendar() returning the engine's operating calendar (or null) is required");
  if (typeof onApply !== "function") throw new Error("onApply(calendar) is required: the host applies the calendar to the engine");
  const doc = container.ownerDocument ?? document;
  // draft: { present, days }. present=false means "no calendar at all" (null); present=true with no days is a calendar that names 0 days.
  let draft = { present: false, days: {} };
  let syncedKey = "null";            // what the engine's calendar looked like when the draft last followed it
  let applied = { calendar: null, warnings: [] };
  let windowStart = 0;
  let windowChosen = false;
  let notice = null;
  let error = null;

  const identity = () => { const value = getSaveIdentity(); return isObject(value) ? value : null; };
  const draftCalendar = () => (draft.present ? calendarOf(draft.days) : null);
  const key = (calendar) => (calendar === null ? "null" : canonical(calendar.dayTypesByOperatingDay));
  const dirty = () => key(draftCalendar()) !== key(applied.calendar);
  const adopt = (calendar) => { draft = calendar === null ? { present: false, days: {} } : { present: true, days: { ...calendar.dayTypesByOperatingDay } }; };

  // An untouched draft follows the engine's calendar; a draft the player has edited is kept.  If the engine's calendar cannot be read the
  // last one read stays (it is not turned into "no calendar") and a warning says so.
  function sync() {
    let next;
    try { next = normalizeOperationalCalendar(getCalendar() ?? null); } catch (e) { applied = { calendar: applied.calendar, warnings: [`operational-calendar-unreadable:${message(e)}`] }; return; }
    const pristine = key(draftCalendar()) === syncedKey;
    applied = next;
    syncedKey = key(applied.calendar);
    if (pristine) adopt(applied.calendar);
  }

  function currentDay() { const day = getCurrentDay(); return isDay(day) ? day : null; }

  function edit(change) {
    notice = null; error = null;
    change();
    render();
  }
  const setDay = (day, type) => edit(() => {
    draft.present = true;
    if (type === null) delete draft.days[String(day)]; else draft.days[String(day)] = type;
    draft.days = sortedDays(draft.days);
  });
  function fail(text_) { error = text_; notice = null; render(); }
  function setRange(fromText, toText, type) {
    const from = Number(fromText); const to = Number(toText);
    if (!isDay(from) || !isDay(to) || String(fromText).trim() !== String(from) || String(toText).trim() !== String(to)) return fail("범위의 처음과 끝은 0 이상의 정수(운영일 번호)여야 합니다.");
    if (from > to) return fail("범위의 처음이 끝보다 클 수 없습니다.");
    if (to - from + 1 > MAX_RANGE_DAYS) return fail(`한 번에 ${MAX_RANGE_DAYS}일까지만 지정할 수 있습니다.`);
    return edit(() => {
      draft.present = true;
      for (let day = from; day <= to; day += 1) { if (type === null) delete draft.days[String(day)]; else draft.days[String(day)] = type; }
      draft.days = sortedDays(draft.days);
      notice = type === null ? `날 ${from}~${to} 의 지정을 해제했습니다(초안).` : `날 ${from}~${to} 을(를) ${TYPE_TEXT[type]}(으)로 지정했습니다(초안).`;
    });
  }
  function goto(dayText) {
    const day = Number(dayText);
    if (!isDay(day) || String(dayText).trim() !== String(day)) return fail("이동할 운영일 번호는 0 이상의 정수여야 합니다.");
    windowStart = Math.floor(day / 7) * 7; windowChosen = true; error = null; notice = null;
    return render();
  }

  function applyNow() {
    if (!dirty()) return;
    const calendar = draftCalendar();
    try {
      const result = onApply(calendar === null ? null : clone(calendar));
      error = null;
      notice = `엔진에 전달했습니다${calendar === null ? "(달력 없음)" : `(명시한 날 ${Object.keys(calendar.dayTypesByOperatingDay).length}일)`}.`;
      if (isObject(result) && Array.isArray(result.warnings) && result.warnings.length) notice += ` 엔진 경고: ${result.warnings.map(warningText).join(", ")}`;
    } catch (e) { notice = null; error = `엔진에 적용하지 못했습니다: ${message(e)}`; }
    sync();
    render();
  }

  function render() {
    const children = [text(doc, "p", "opcal-notice", SCOPE_NOTICE)];
    if (error) children.push(text(doc, "div", "opcal-error", error));
    if (notice) children.push(text(doc, "div", "opcal-notice", notice));
    const id = identity();
    children.push(text(doc, "div", "opcal-fact opcal-identity", `이 초안이 속한 저장본: ${id === null ? "확인할 수 없음 (식별 정보 없음)" : JSON.stringify(id)}`));
    children.push(...appliedSection(), ...summarySection(), ...toolbar(), ...windowSection(), ...explicitList());
    container.replaceChildren(...children);
  }

  function appliedSection() {
    const calendar = applied.calendar;
    const nodes = [text(doc, "div", "opcal-fact opcal-applied", calendar === null
      ? "엔진의 달력: 없음 (null) — 모든 날이 기본 규칙을 따릅니다. 달력이 없는 것과 '명시한 날이 0일인 달력'은 다릅니다."
      : `엔진의 달력: 있음 — 명시한 날 ${Object.keys(calendar.dayTypesByOperatingDay).length}일 (휴일 ${Object.values(calendar.dayTypesByOperatingDay).filter((t) => t === "holiday").length}일)`)];
    for (const code of applied.warnings) nodes.push(text(doc, "div", "opcal-warning", `엔진 달력 경고: ${warningText(code)}`));
    return nodes;
  }

  function summarySection() {
    const calendar = draftCalendar();
    const days = calendar === null ? {} : calendar.dayTypesByOperatingDay;
    const count = (type) => Object.values(days).filter((t) => t === type).length;
    const appliedDays = applied.calendar?.dayTypesByOperatingDay ?? {};
    let added = 0; let changed = 0; let removed = 0;
    for (const day of new Set([...Object.keys(days), ...Object.keys(appliedDays)])) {
      if (days[day] !== undefined && appliedDays[day] === undefined) added += 1;
      else if (days[day] === undefined && appliedDays[day] !== undefined) removed += 1;
      else if (days[day] !== appliedDays[day]) changed += 1;
    }
    const nodes = [text(doc, "div", "opcal-fact opcal-draft", calendar === null ? "초안: 달력 없음 (null)" : `초안: 달력 있음 — 명시한 날 ${Object.keys(days).length}일`)];
    nodes.push(el(doc, "div", { className: "opcal-metrics" }, metric(doc, "휴일 지정", String(count("holiday"))), metric(doc, "평일 지정", String(count("weekday"))), metric(doc, "주말 지정", String(count("weekend"))),
      metric(doc, "엔진과 다른 날", String(added + changed + removed)), metric(doc, "새로 지정", String(added)), metric(doc, "바꿈", String(changed)), metric(doc, "지정 해제", String(removed))));
    nodes.push(text(doc, "div", "opcal-fact opcal-holiday-support", `휴일 지정이 있는가: ${calendarSupportsDayType(calendar, "holiday") ? "예" : "아니오"} (휴일 시간표를 개통할 수 있는지는 엔진이 판단합니다)`));
    nodes.push(text(doc, "div", dirty() ? "opcal-dirty" : "opcal-clean", dirty() ? "엔진에 아직 적용하지 않은 변경이 있습니다." : "초안이 엔진의 달력과 같습니다."));
    return nodes;
  }

  function toolbar() {
    const apply = el(doc, "button", { type: "button", className: "opcal-apply", textContent: "엔진에 적용", disabled: !dirty() });
    apply.addEventListener("click", applyNow);
    const revert = el(doc, "button", { type: "button", className: "opcal-revert", textContent: "초안 되돌리기 (엔진 달력으로)", disabled: !dirty() });
    revert.addEventListener("click", () => edit(() => { adopt(applied.calendar); notice = "초안을 엔진의 달력으로 되돌렸습니다."; }));
    const none = el(doc, "button", { type: "button", className: "opcal-clear", textContent: "달력 없음으로 (모든 지정 지우기)", disabled: !draft.present });
    none.addEventListener("click", () => edit(() => { draft = { present: false, days: {} }; notice = "초안을 '달력 없음'으로 바꿨습니다."; }));
    return [el(doc, "div", { className: "opcal-actions" }, apply, revert, none)];
  }

  function windowSection() {
    const today = currentDay();
    if (!windowChosen) windowStart = today === null ? 0 : Math.floor(today / 7) * 7;
    const calendar = draftCalendar();
    const appliedDays = applied.calendar?.dayTypesByOperatingDay ?? {};
    const nodes = [text(doc, "strong", "opcal-section", `날짜 ${windowStart}~${windowStart + WINDOW_DAYS - 1} (운영일 번호 · 현재 ${today === null ? "알 수 없음" : `${today}일`})`)];
    const nav = (label, className, onClick, disabled = false) => { const b = el(doc, "button", { type: "button", className, textContent: label, disabled }); b.addEventListener("click", onClick); return b; };
    const jump = el(doc, "input", { type: "text", className: "opcal-goto-input", placeholder: "운영일 번호", value: "" });
    nodes.push(el(doc, "div", { className: "opcal-nav" },
      nav("이전 4주", "opcal-prev", () => { windowStart = Math.max(0, windowStart - WINDOW_DAYS); windowChosen = true; render(); }, windowStart === 0),
      nav("다음 4주", "opcal-next", () => { windowStart += WINDOW_DAYS; windowChosen = true; render(); }),
      nav("현재 날로", "opcal-today", () => { windowChosen = false; render(); }, today === null),
      jump, nav("이동", "opcal-goto", () => goto(jump.value))));
    for (let day = windowStart; day < windowStart + WINDOW_DAYS; day += 1) {
      const explicit = draft.days[String(day)] ?? null;
      const defaultType = defaultOperationalDayType(day);
      const effective = operationalDayTypeAtDay(day, calendar);
      const was = appliedDays[String(day)] ?? null;
      const row = el(doc, "div", { className: `opcal-row ${explicit === null ? "unspecified" : "explicit"} ${effective}${explicit !== was ? " changed" : ""}${day === today ? " today" : ""}` });
      row.append(text(doc, "span", "opcal-day", `날 ${day} (${weekdayName(day)})${day === today ? " · 현재" : ""}`));
      row.append(text(doc, "span", "opcal-state", explicit === null
        ? `미지정 → 기본 규칙에 따라 ${TYPE_TEXT[defaultType]}`
        : `명시: ${TYPE_TEXT[explicit]}${explicit === defaultType ? " (기본 규칙과 같음)" : ""}`));
      const select = el(doc, "select", { className: "opcal-select", value: explicit ?? "" },
        el(doc, "option", { value: "", textContent: "미지정 (기본 규칙)" }), ...OPERATIONAL_DAY_TYPES.map((type) => el(doc, "option", { value: type, textContent: `${TYPE_TEXT[type]} (${type})` })));
      select.addEventListener("change", () => setDay(day, select.value === "" ? null : select.value));
      row.append(select);
      if (explicit !== was) row.append(text(doc, "span", "opcal-diff", `엔진: ${was === null ? "미지정" : TYPE_TEXT[was]} → 초안: ${explicit === null ? "미지정" : TYPE_TEXT[explicit]}`));
      nodes.push(row);
    }
    nodes.push(rangeControls());
    return nodes;
  }

  function rangeControls() {
    const from = el(doc, "input", { type: "text", className: "opcal-range-from", placeholder: "처음 날", value: "" });
    const to = el(doc, "input", { type: "text", className: "opcal-range-to", placeholder: "끝 날", value: "" });
    const select = el(doc, "select", { className: "opcal-range-type", value: "holiday" }, ...OPERATIONAL_DAY_TYPES.map((type) => el(doc, "option", { value: type, textContent: `${TYPE_TEXT[type]} (${type})` })),
      el(doc, "option", { value: "", textContent: "미지정 (지정 해제)" }));
    const button = el(doc, "button", { type: "button", className: "opcal-range-apply", textContent: "범위에 지정" });
    button.addEventListener("click", () => setRange(from.value, to.value, select.value === "" ? null : select.value));
    return el(doc, "div", { className: "opcal-range" }, text(doc, "span", "", "여러 날을 한 번에"), from, to, select, button);
  }

  function explicitList() {
    const days = draft.present ? Object.entries(draft.days) : [];
    const nodes = [text(doc, "strong", "opcal-section", draft.present ? `초안에서 직접 지정한 날 ${days.length}일` : "초안: 달력 없음 — 직접 지정한 날이 없습니다.")];
    if (draft.present && !days.length) nodes.push(text(doc, "p", "opcal-empty", "달력은 있지만 직접 지정한 날은 0일입니다."));
    for (const [day, type] of days.slice(0, LIST_LIMIT)) {
      const drop = el(doc, "button", { type: "button", className: "opcal-drop", textContent: "지정 해제" });
      drop.addEventListener("click", () => setDay(Number(day), null));
      nodes.push(el(doc, "div", { className: `opcal-entry ${type}` }, text(doc, "span", "", `날 ${day} (${weekdayName(Number(day))}) → ${TYPE_TEXT[type]} (${type})`), drop));
    }
    if (days.length > LIST_LIMIT) nodes.push(text(doc, "div", "opcal-note", `외 ${days.length - LIST_LIMIT}일은 표시하지 않았습니다.`));
    return nodes;
  }

  const api = {
    // Read the engine's calendar again (the host calls this when the engine's calendar or the current day may have changed).
    refresh() { sync(); render(); },
    // The draft as a document the host may keep.  Nothing is written anywhere.
    serialize() { return JSON.stringify(newDraftDoc(identity(), draftCalendar()), null, 2); },
    // -> { ok, issues }.  A refused document (unreadable, wrong shape, another save, a bad entry) leaves the draft as it is.
    loadDoc(input) {
      const { doc: loaded, issues } = restoreDraftDoc(input, identity());
      if (!loaded) return { ok: false, issues };
      adopt(loaded.calendar);
      error = null; notice = "저장해 둔 초안을 불러왔습니다. 엔진에는 아직 적용하지 않았습니다.";
      render();
      return { ok: true, issues: [] };
    },
    get draft() { const calendar = draftCalendar(); return calendar === null ? null : clone(calendar); },
    get applied() { return applied.calendar === null ? null : clone(applied.calendar); },
    get dirty() { return dirty(); },
    // show the week containing this operating day
    showDay(day) { goto(String(day)); },
  };
  sync();
  render();
  return api;
}
