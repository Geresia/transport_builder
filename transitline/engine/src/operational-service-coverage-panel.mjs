// Operating-day / timetable coverage panel (B18-M3).  It reads ONE thing: the B18-E4 coverage report the host hands it
// (`getReport()`), and shows, for the current operating day, where each line's departures come from: a timetable, the line's old
// frequency, a suspension, "not a service line", or unknown.  It never sees the runtime, so it can run no engine command; it saves
// nothing, uses no storage and no timer, and recomputes nothing from the B17 timetable report.  It estimates no service quality,
// capacity, cost, demand or crowding and turns no fact into a verdict.  null (unknown), false, 0 and [] are shown as four different things.
//
// THE REPORT CONTRACT THIS PANEL READS (B18-E4 had no committed report when this was written; every field name is here, in one place):
//   schema            "transitline.operational-service-coverage-report/1"
//   operatingDay      integer | null              the current operating-day number
//   dayType           "weekday"|"weekend"|"holiday"|null     what the engine runs on that day
//   dayTypeSource     string | null | (absent)    where that day type comes from, shown as given
//   lines             array | null                one row per line (null = the report does not include lines)
//     operationalLineId, name, managementServiceId (+managementServiceIdReason),
//     dispatchSource  "timetable"|"legacy-frequency"|"suspended"|"not-service-line"|"unknown"   (+dispatchSourceReason)
//     timetableId (+timetableIdReason), timetableDayType, timetableStatus, suspended (boolean|null), legacyFrequency (any|absent)
//   issues, limits    optional arrays, shown word for word

export const OPERATIONAL_SERVICE_COVERAGE_REPORT_SCHEMA = "transitline.operational-service-coverage-report/1";
export const DISPATCH_SOURCES = Object.freeze(["timetable", "legacy-frequency", "suspended", "not-service-line", "unknown"]);
export const LIST_LIMIT = 100;

export const SCOPE_NOTICE = "이 패널은 엔진이 만든 운영일·시간표 커버리지 보고서(B18-E4)를 읽어서 보여 줍니다. 엔진 명령을 실행하지 않고, 서비스 품질·수송력·비용·수요·혼잡을 추정하지 않으며, 가능/불가를 판정하지 않고, 아무것도 저장하지 않습니다. 모르는 값은 '미상', 0·아니오·빈 목록은 각각 그대로 구분해 표시합니다.";
export const HOLIDAY_FALLBACK_NOTICE = "오늘은 휴일인데 이 노선에는 시간표가 없어, 엔진이 기존 노선 빈도(frequency)로 열차를 내고 있다는 것이 보고서의 사실입니다. 이 화면은 그 운행이 얼마나 충분한지(서비스 품질·수송력·비용·혼잡)를 추정하지 않습니다.";

const SOURCE_TEXT = Object.freeze({
  timetable: "시간표", "legacy-frequency": "기존 빈도 운행", suspended: "운휴", "not-service-line": "운행선 아님", unknown: "미상",
});
const DAY_TYPE_TEXT = Object.freeze({ weekday: "평일", weekend: "주말", holiday: "휴일" });
const REASON_TEXT = Object.freeze({
  "no-timetable-for-this-day-type": "오늘의 요일 유형에 맞는 시간표가 없음",
  "the-line-carries-no-management-service-id": "노선에 경영 서비스 ID가 없음",
  "not-recorded": "기록되지 않음",
});

const listOf = (value) => (Array.isArray(value) ? value : []);
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const message = (error) => (error instanceof Error ? error.message : String(error));
const cmp = (a, b) => String(a).localeCompare(String(b), "en", { numeric: true });

// null (unknown), 0, false and [] stay four different things on screen.
function show(value, { reason = null, none = null } = {}) {
  if (value === null || value === undefined) return none !== null ? none : reason ? `미상 (${reason})` : "미상";
  if (typeof value === "boolean") return value ? "예" : "아니오";
  if (Array.isArray(value)) return value.length ? value.map((entry) => show(entry)).join(", ") : "빈 목록";
  if (typeof value === "number") return String(value);
  if (isObject(value)) return JSON.stringify(value);
  return String(value);
}
function reasonText(reason) {
  if (typeof reason !== "string" || reason === "") return null;
  const code = reason.split(":")[0].split(" (")[0];
  return REASON_TEXT[code] ? `${reason} — ${REASON_TEXT[code]}` : reason;
}
const withReason = (value, reason, options = {}) => show(value, { ...options, reason: reasonText(reason) });
const dayTypeText = (type) => (type === null || type === undefined ? show(type) : `${DAY_TYPE_TEXT[type] ?? type} (${type})`);

// -> { ok, problem }.  A report that is not an object, has another schema, or whose lines are neither a list nor null is refused whole.
export function checkCoverageReport(value) {
  if (!isObject(value)) return { ok: false, problem: "보고서가 없습니다(getReport()가 객체를 주지 않음)." };
  if (value.schema !== OPERATIONAL_SERVICE_COVERAGE_REPORT_SCHEMA) return { ok: false, problem: `알 수 없는 보고서 형식입니다: ${show(value.schema)} (필요: ${OPERATIONAL_SERVICE_COVERAGE_REPORT_SCHEMA})` };
  if (value.lines !== null && !Array.isArray(value.lines)) return { ok: false, problem: "보고서의 lines가 목록도 null도 아닙니다." };
  if (value.operatingDay !== null && value.operatingDay !== undefined && !(Number.isInteger(value.operatingDay) && value.operatingDay >= 0)) return { ok: false, problem: `보고서의 operatingDay가 올바르지 않습니다: ${show(value.operatingDay)}` };
  return { ok: true, problem: null };
}

const el = (doc, tag, props = {}, ...kids) => { const node = doc.createElement(tag); Object.assign(node, props); node.append(...kids); if ("value" in props) node.value = props.value; return node; };
const text = (doc, tag, className, value) => el(doc, tag, { className, textContent: value });
const metric = (doc, label, value) => el(doc, "div", { className: "cov-metric" }, text(doc, "span", "", label), text(doc, "b", "", value));
const fact = (doc, label, value, className = "cov-fact") => el(doc, "div", { className }, text(doc, "span", "cov-label", label), text(doc, "span", "cov-value", value));

const NO_TIMETABLE = "__none__";

export function mountOperationalServiceCoveragePanel({ container, getReport } = {}) {
  if (!container) throw new Error("An operational service coverage container is required");
  if (typeof getReport !== "function") throw new Error("getReport() returning the B18-E4 operational service coverage report is required");
  const doc = container.ownerDocument ?? document;
  let report = null;
  let problem = null;
  let filter = { dispatchSource: null, timetableId: undefined };   // timetableId: undefined = all, null = rows with no timetable

  function load() {
    problem = null;
    try {
      const value = getReport();
      const checked = checkCoverageReport(value);
      if (!checked.ok) { report = null; problem = checked.problem; return; }
      report = value;
    } catch (error) { report = null; problem = `보고서를 읽지 못했습니다: ${message(error)}`; }
  }

  const rowsOf = () => (report.lines === null ? null : report.lines.filter(isObject).slice().sort((a, b) => cmp(a.operationalLineId ?? "", b.operationalLineId ?? "")));
  const matches = (row) => (filter.dispatchSource === null || row.dispatchSource === filter.dispatchSource)
    && (filter.timetableId === undefined || (filter.timetableId === null ? (row.timetableId ?? null) === null : row.timetableId === filter.timetableId));
  const isHolidayFallback = (row) => report.dayType === "holiday" && row.dispatchSource === "legacy-frequency" && (row.timetableId ?? null) === null;

  function render() {
    const children = [text(doc, "p", "cov-notice", SCOPE_NOTICE)];
    if (problem) { children.push(text(doc, "div", "cov-error", problem)); container.replaceChildren(...children); return; }
    const rows = rowsOf();
    children.push(...header(), ...summary(rows), filterControls(rows));
    children.push(...lineSection(rows), ...issueSection(), ...limitSection());
    container.replaceChildren(...children);
  }

  function header() {
    const today = el(doc, "div", { className: "cov-today" },
      fact(doc, "현재 운영일 번호", show(report.operatingDay ?? null), "cov-fact cov-day"),
      fact(doc, "오늘의 요일 유형", dayTypeText(report.dayType ?? null), "cov-fact cov-daytype"));
    if (report.dayTypeSource !== undefined) today.append(fact(doc, "요일 유형의 출처", show(report.dayTypeSource), "cov-fact cov-daytype-source"));
    return [today, text(doc, "div", "cov-fact", `보고서: ${report.schema}`)];
  }

  function summary(rows) {
    if (rows === null) return [text(doc, "div", "cov-warning", "노선 목록이 보고서에 포함되지 않았습니다 (lines: null)")];
    const count = (source) => rows.filter((r) => r.dispatchSource === source).length;
    const other = rows.filter((r) => !DISPATCH_SOURCES.includes(r.dispatchSource)).length;
    return [el(doc, "div", { className: "cov-metrics" },
      metric(doc, "표시한 노선", String(rows.length)),
      ...DISPATCH_SOURCES.map((source) => metric(doc, SOURCE_TEXT[source], String(count(source)))),
      metric(doc, "원천 코드를 알 수 없음", String(other)),
      metric(doc, "휴일인데 시간표 없이 기존 빈도로 운행", String(rows.filter(isHolidayFallback).length)))];
  }

  function filterControls(rows) {
    const sources = [...DISPATCH_SOURCES, ...[...new Set(listOf(rows).map((r) => r.dispatchSource).filter((s) => typeof s === "string" && !DISPATCH_SOURCES.includes(s)))].sort(cmp)];
    const ids = [...new Set(listOf(rows).map((r) => r.timetableId).filter((id) => typeof id === "string" && id))].sort(cmp);
    const select = (className, label, options, value, onPick) => {
      const node = el(doc, "select", { className, value }, el(doc, "option", { value: "", textContent: "(전체)" }), ...options.map(([v, caption]) => el(doc, "option", { value: v, textContent: caption })));
      node.addEventListener("change", () => onPick(node.value));
      return el(doc, "label", { className: "cov-field" }, text(doc, "span", "", label), node);
    };
    return el(doc, "div", { className: "cov-filters" },
      select("cov-filter-source", "배차 원천", sources.map((s) => [s, `${SOURCE_TEXT[s] ?? s} (${s})`]), filter.dispatchSource ?? "", (v) => api.setFilter({ dispatchSource: v === "" ? null : v, timetableId: filter.timetableId })),
      select("cov-filter-timetable", "시간표", [[NO_TIMETABLE, "(시간표 없음)"], ...ids.map((id) => [id, id])], filter.timetableId === undefined ? "" : filter.timetableId === null ? NO_TIMETABLE : filter.timetableId,
        (v) => api.setFilter({ dispatchSource: filter.dispatchSource, timetableId: v === "" ? undefined : v === NO_TIMETABLE ? null : v })),
      text(doc, "span", "cov-note", filter.dispatchSource === null && filter.timetableId === undefined ? "필터 없음 — 전체를 표시합니다." : "필터 사용 중 (읽기 전용 — 보고서와 엔진은 바뀌지 않음, 저장하지 않음)"));
  }

  function lineSection(rows) {
    if (rows === null) return [text(doc, "strong", "cov-section", "노선 (보고서에 포함되지 않음)")];
    const shown = rows.filter(matches);
    const nodes = [text(doc, "strong", "cov-section", `노선 ${shown.length}개${shown.length === rows.length ? "" : ` (전체 ${rows.length}개 중 필터)`}`)];
    if (!rows.length) nodes.push(text(doc, "p", "cov-empty", "보고서에 노선이 없습니다(빈 목록)."));
    else if (!shown.length) nodes.push(text(doc, "p", "cov-empty", "필터에 맞는 노선이 없습니다."));
    const unreadable = report.lines.length - report.lines.filter(isObject).length;
    if (unreadable) nodes.push(text(doc, "div", "cov-warning", `읽을 수 없는 항목 ${unreadable}개는 건너뛰었습니다.`));
    for (const row of shown.slice(0, LIST_LIMIT)) nodes.push(lineCard(row));
    if (shown.length > LIST_LIMIT) nodes.push(text(doc, "div", "cov-note", `외 ${shown.length - LIST_LIMIT}개는 표시하지 않았습니다. 필터로 좁혀 보세요.`));
    return nodes;
  }

  function lineCard(row) {
    const source = row.dispatchSource;
    const recognized = DISPATCH_SOURCES.includes(source);
    const card = el(doc, "div", { className: `cov-card cov-line ${recognized ? source : "unrecognized"}` });
    card.append(text(doc, "b", "cov-title", `노선 ${show(row.operationalLineId ?? null)} · ${show(row.name ?? null)}`));
    card.append(fact(doc, "현재 배차 원천", recognized ? `${SOURCE_TEXT[source]} (${source})` : source === null || source === undefined ? show(null) : `알 수 없는 원천 코드: ${show(source)}`, "cov-fact cov-source"));
    if (row.dispatchSourceReason !== undefined) card.append(fact(doc, "원천의 이유", show(row.dispatchSourceReason === null ? null : reasonText(row.dispatchSourceReason) ?? row.dispatchSourceReason)));
    card.append(fact(doc, "시간표 ID", withReason(row.timetableId ?? null, row.timetableIdReason), "cov-fact cov-timetable-id"));
    card.append(fact(doc, "시간표의 요일 유형", dayTypeText(row.timetableDayType ?? null), "cov-fact cov-timetable-daytype"));
    if (row.timetableStatus !== undefined) card.append(fact(doc, "시간표 상태", show(row.timetableStatus), "cov-fact cov-timetable-status"));
    card.append(fact(doc, "경영 서비스", withReason(row.managementServiceId ?? null, row.managementServiceIdReason)));
    card.append(fact(doc, "노선 정지", show(row.suspended ?? null), "cov-fact cov-suspended"));
    if (row.legacyFrequency !== undefined) card.append(fact(doc, "노선에 설정된 기존 빈도", show(row.legacyFrequency), "cov-fact cov-frequency"));
    if (source === "timetable" && report.dayType && row.timetableDayType && report.dayType !== row.timetableDayType) {
      card.append(text(doc, "div", "cov-note cov-daytype-differs", `시간표의 요일 유형(${row.timetableDayType})과 오늘의 요일 유형(${report.dayType})이 다르게 보고되었습니다 — 보고서 값 그대로입니다.`));
    }
    if (isHolidayFallback(row)) card.append(text(doc, "div", "cov-holiday-fallback", HOLIDAY_FALLBACK_NOTICE));
    return card;
  }

  function issueSection() {
    if (report.issues === undefined) return [];
    if (report.issues === null) return [text(doc, "strong", "cov-section", "issues (보고서에 포함되지 않음)")];
    const nodes = [text(doc, "strong", "cov-section", `issues ${report.issues.length}개`), text(doc, "p", "cov-note", "issues는 보고서 안의 사실들이 어긋나는 곳을 적은 목록이며 판정이 아닙니다.")];
    if (!report.issues.length) nodes.push(text(doc, "p", "cov-empty", "표시할 issue가 없습니다(빈 목록)."));
    for (const issue of report.issues.slice(0, LIST_LIMIT)) {
      if (!isObject(issue)) { nodes.push(text(doc, "div", "cov-issue", show(issue))); continue; }
      const rest = Object.entries(issue).filter(([name]) => name !== "code").map(([name, value]) => `${name}: ${show(value)}`).join(" · ");
      nodes.push(text(doc, "div", "cov-issue", `${show(issue.code ?? null)}${rest ? ` · ${rest}` : ""}`));
    }
    return nodes;
  }

  function limitSection() {
    if (report.limits === undefined) return [];
    if (report.limits === null) return [text(doc, "strong", "cov-section", "limits (보고서에 포함되지 않음)")];
    const nodes = [text(doc, "strong", "cov-section", `보고서가 말할 수 없는 것 ${report.limits.length}개 (limits)`)];
    for (const limit of report.limits) nodes.push(el(doc, "div", { className: "cov-limit" }, text(doc, "b", "", show(isObject(limit) ? limit.id ?? null : null)), text(doc, "div", "cov-limit-text", show(isObject(limit) ? limit.text ?? null : limit))));
    return nodes;
  }

  const api = {
    // Read the report again from the host; the host decides when.  Nothing here polls or schedules.
    refresh() { load(); render(); },
    // { dispatchSource?: string | null, timetableId?: string | null }.  dispatchSource null/absent = every source; timetableId absent = every row,
    // timetableId null = the rows that have no timetable.  Only the view changes.
    setFilter(next = {}) {
      filter = {
        dispatchSource: typeof next?.dispatchSource === "string" && next.dispatchSource ? next.dispatchSource : null,
        timetableId: next && "timetableId" in next ? (next.timetableId === null ? null : typeof next.timetableId === "string" && next.timetableId ? next.timetableId : undefined) : undefined,
      };
      render();
    },
    get filter() { return { dispatchSource: filter.dispatchSource, ...(filter.timetableId === undefined ? {} : { timetableId: filter.timetableId }) }; },
    get report() { return report === null ? null : structuredClone(report); },
  };
  load();
  render();
  return api;
}
