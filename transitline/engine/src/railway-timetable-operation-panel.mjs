// Detail panel for how railway timetables are actually operated (B17-M2).  It reads ONE thing: the B17-E1 report that the host hands it
// (`getReport()`, normally `() => runtime.railwayTimetableOperationReport()`).  It never sees the runtime, so it can call no engine
// command; it saves nothing, uses no localStorage and has no timer — the host decides when to `refresh()`.  It computes no timetable,
// dispatch, delay, cost, demand or crowding figure and turns no fact into a verdict: every number, null and reason on screen is the
// report's, shown as given.  null (unknown), 0, false and [] are shown as four different things.
//
// The only thing it keeps is the read-only filter the player chose (a timetable or a line); the filter is not persisted.
import { RAILWAY_TIMETABLE_OPERATION_REPORT_SCHEMA } from "./railway-timetable-operation-report.mjs";

export const SCOPE_NOTICE = "이 패널은 엔진이 이미 만든 시간표 운행 보고서(B17-E1)를 읽어서 보여 줍니다. 엔진 명령을 실행하지 않고, 시간표·배차·지연·비용·수요·혼잡을 계산하지 않으며, 아무것도 저장하지 않습니다. 모르는 값은 '미상'으로, 0·아니오·빈 목록은 각각 그대로 구분해 표시합니다.";
export const ISSUES_NOTICE = "issues는 보고서 안의 사실들이 서로 어긋나는 곳을 적은 목록이며 판정이 아닙니다. 어느 쪽이 맞는지는 이 패널도 보고서도 정하지 않습니다.";
export const LIST_LIMIT = 50;

const STATUS_TEXT = Object.freeze({ active: "활성 (운행에 적용된 시간표)", approved: "승인됨", assessed: "심사됨", withdrawn: "철회됨", superseded: "다른 시간표로 대체됨" });
const STATUS_ORDER = Object.freeze(["active", "approved", "assessed", "withdrawn", "superseded"]);
const VERDICT_TEXT = Object.freeze({ possible: "가능", conditional: "조건부", impossible: "불가", unknown: "미상" });
const PROVENANCE_TEXT = Object.freeze({
  timetable: "시간표 열차 (timetableId 기록됨)",
  "scheduled-provenance-unrecorded": "예정 열차이나 출처 미기록 (B17-E0 이전 저장본)",
  "legacy-frequency": "레거시 빈도 열차 (시간표 없이 노선 빈도로 운행)",
});
const TRAIN_STATUS_TEXT = Object.freeze({ running: "운행 중", done: "완료 표시(done)", "position-unknown": "위치 미상" });
const POSITION_REASON_TEXT = Object.freeze({
  "line-missing": "열차가 속한 노선을 찾을 수 없음", "service-stations-missing": "열차의 운행 역 목록이 없음", "segment-index-invalid": "구간 번호가 올바르지 않음",
  "direction-invalid": "방향 값이 올바르지 않음", "progress-invalid": "구간 진행도가 올바르지 않음", "station-missing": "역 표에 없는 역",
});
const REASON_TEXT = Object.freeze({
  "finished-trains-are-removed-and-traffic-counters-are-per-line": "끝난 열차는 목록에서 지워지고 엔진의 통계는 노선 단위라 시간표별로 셀 수 없음",
  "counter-not-created": "엔진은 첫 번째로 놓친 출발이 생길 때 카운터를 만듦 — 없다는 것을 0으로 기록하지 않음",
  "no-dispatch-entry-for-this-timetable": "이 시간표를 가리키는 dispatch가 없음",
  "the-timetable-carries-no-operational-facts": "시간표에 운행 사실(operationalFacts)이 없음",
  "the-engine-has-recorded-no-traffic-for-this-line": "엔진이 이 노선의 운행 통계를 아직 기록하지 않음",
  "the-line-carries-no-management-service-id": "노선에 경영 서비스 ID가 없음",
  "dispatched-by-line-frequency-not-by-a-timetable": "노선 빈도로 출발시킨 열차라 시간표가 없음",
  "dispatch-entry-carries-no-timetable-id": "dispatch 항목에 시간표 ID가 없음",
  "no-departure-list-in-the-applied-schedule": "적용된 일정에 출발 목록이 없음",
  "the-timetable-report-was-not-provided": "시간표 보고서가 전달되지 않음",
  "the-operational-state-was-not-provided": "운영 상태가 전달되지 않음",
  "dispatched-against-a-schedule-but-the-provenance-was-not-recorded": "일정에 따라 출발했으나 출처가 기록되지 않음",
  "not-recorded": "기록되지 않음",
});
const ISSUE_TEXT = Object.freeze({
  "dispatch-timetable-unknown": "dispatch가 가리키는 시간표가 보고서에 없음",
  "dispatch-timetable-not-active": "dispatch가 가리키는 시간표의 상태가 active가 아님",
  "dispatch-blocked": "dispatch에 막힘 사유가 기록됨",
  "suspended-line-with-dispatch": "정지된 노선에 dispatch가 있음",
  "active-timetable-without-dispatch": "active 시간표를 가리키는 dispatch가 없음",
  "scheduled-train-without-provenance": "예정 출발이 있는데 시간표 출처가 기록되지 않은 열차",
  "train-position-unknown": "위치를 알 수 없는 열차",
  "train-timetable-unknown": "열차가 가진 시간표 ID가 보고서에 없음",
  "train-timetable-differs-from-line-dispatch": "열차의 시간표가 그 노선의 현재 dispatch 시간표와 다름",
});
const LIMIT_TEXT = Object.freeze({
  "completed-trains-not-attributable": "완료한 열차 수는 시간표별로 알 수 없음",
  "missed-departures-counted-per-dispatch-entry": "놓친 출발 카운터는 dispatch가 다시 적용될 때(저장본 불러오기 포함) 다시 시작함",
  "live-trains-only": "지금 선로에 있는 열차만 나옴",
  "no-delay-cost-demand-crowding": "지연·비용·수요·혼잡 수치는 계산하지 않음",
});

const listOf = (value) => (Array.isArray(value) ? value : []);
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const cmp = (a, b) => String(a).localeCompare(String(b), "en", { numeric: true });
const message = (error) => (error instanceof Error ? error.message : String(error));

// null (unknown), 0, false and [] stay four different things on screen.
function show(value, { reason = null, none = null } = {}) {
  if (value === null || value === undefined) return none !== null ? none : reason ? `미상 (${reason})` : "미상";
  if (typeof value === "boolean") return value ? "예" : "아니오";
  if (Array.isArray(value)) return value.length ? value.map((entry) => show(entry)).join(", ") : "빈 목록";
  if (typeof value === "number") return String(value);
  if (isObject(value)) return JSON.stringify(value);
  return String(value);
}
// a reason string is shown as the report wrote it, with a plain-language note when the code is known
function reasonText(reason) {
  if (typeof reason !== "string" || reason === "") return null;
  const code = reason.split(":")[0].split(" (")[0];
  return REASON_TEXT[code] ? `${reason} — ${REASON_TEXT[code]}` : reason;
}
const withReason = (value, reason, options = {}) => show(value, { ...options, reason: reasonText(reason) });
// display only: the engine's minute, written without floating-point noise (398.79999999999995 -> 398.8)
const clock = (minute) => (Number.isFinite(minute) ? `${Number(minute.toFixed(2))}분` : null);

function filterReport(report, filter) {
  const all = { timetables: report.timetables, dispatches: report.dispatches, lines: report.lines, trains: report.trains, issues: report.issues };
  if (!filter) return { ...all, missing: false };
  const only = (rows, test) => (Array.isArray(rows) ? rows.filter(test) : rows);
  if (filter.kind === "timetable") {
    const timetables = only(report.timetables, (t) => t.timetableId === filter.id);
    const dispatches = only(report.dispatches, (d) => d.timetableId === filter.id);
    const trains = only(report.trains, (t) => t.timetableId === filter.id);
    const lineIds = new Set([...listOf(dispatches).map((d) => d.operationalLineId), ...listOf(trains).map((t) => t.operationalLineId), ...listOf(timetables).flatMap((t) => listOf(t.dispatchLineIds))]);
    const trainIds = new Set(listOf(trains).map((t) => t.trainId));
    const lines = only(report.lines, (l) => lineIds.has(l.operationalLineId));
    const issues = only(report.issues, (i) => i.timetableId === filter.id || trainIds.has(i.trainId) || listOf(i.lineDispatchTimetableIds).includes(filter.id));
    return { timetables, dispatches, lines, trains, issues, missing: !listOf(report.timetables).some((t) => t.timetableId === filter.id) };
  }
  const dispatches = only(report.dispatches, (d) => d.operationalLineId === filter.id);
  const trains = only(report.trains, (t) => t.operationalLineId === filter.id);
  const tableIds = new Set([...listOf(dispatches).map((d) => d.timetableId), ...listOf(trains).map((t) => t.timetableId)].filter(Boolean));
  const trainIds = new Set(listOf(trains).map((t) => t.trainId));
  const timetables = only(report.timetables, (t) => tableIds.has(t.timetableId) || listOf(t.dispatchLineIds).includes(filter.id));
  const lines = only(report.lines, (l) => l.operationalLineId === filter.id);
  const issues = only(report.issues, (i) => i.operationalLineId === filter.id || trainIds.has(i.trainId));
  const known = listOf(report.lines).some((l) => l.operationalLineId === filter.id) || listOf(report.dispatches).some((d) => d.operationalLineId === filter.id) || listOf(report.trains).some((t) => t.operationalLineId === filter.id);
  return { timetables, dispatches, lines, trains, issues, missing: !known };
}

const el = (doc, tag, props = {}, ...kids) => { const node = doc.createElement(tag); Object.assign(node, props); node.append(...kids); if ("value" in props) node.value = props.value; return node; };
const text = (doc, tag, className, value) => el(doc, tag, { className, textContent: value });
const metric = (doc, label, value) => el(doc, "div", { className: "ttop-metric" }, text(doc, "span", "", label), text(doc, "b", "", value));
const fact = (doc, label, value, className = "ttop-fact") => el(doc, "div", { className }, text(doc, "span", "ttop-label", label), text(doc, "span", "ttop-value", value));

export function mountRailwayTimetableOperationPanel({ container, getReport } = {}) {
  if (!container) throw new Error("A railway timetable operation container is required");
  if (typeof getReport !== "function") throw new Error("getReport() returning the B17-E1 railway timetable operation report is required");
  const doc = container.ownerDocument ?? document;
  let report = null;
  let problem = null;
  let filter = null;

  function load() {
    problem = null;
    try {
      const value = getReport();
      if (!isObject(value)) { report = null; problem = "보고서가 없습니다(getReport()가 객체를 주지 않음)."; return; }
      if (value.schema !== RAILWAY_TIMETABLE_OPERATION_REPORT_SCHEMA) { report = null; problem = `알 수 없는 보고서 형식입니다: ${show(value.schema)} (필요: ${RAILWAY_TIMETABLE_OPERATION_REPORT_SCHEMA})`; return; }
      report = value;
    } catch (error) { report = null; problem = `보고서를 읽지 못했습니다: ${message(error)}`; }
  }

  function render() {
    const children = [text(doc, "p", "ttop-notice", SCOPE_NOTICE)];
    if (problem) { children.push(text(doc, "div", "ttop-error", problem)); container.replaceChildren(...children); return; }
    children.push(...summary(), filterControls());
    const view = filterReport(report, filter);
    if (filter && view.missing) children.push(text(doc, "div", "ttop-warning", `선택한 ${filter.kind === "timetable" ? "시간표" : "노선"} ${filter.id} 는 이 보고서에 없습니다.`));
    else {
      children.push(...timetableSection(view.timetables), ...dispatchSection(view.dispatches), ...lineSection(view.lines), ...trainSection(view.trains), ...issueSection(view.issues));
    }
    children.push(...limitSection());
    container.replaceChildren(...children);
  }

  function summary() {
    const nodes = [fact(doc, "보고서", `${report.schema} · 엔진 시각 ${show(clock(report.simMinutes))} · 상태 ${show(report.status)}`)];
    for (const [name, reason] of Object.entries(report.unavailable ?? {})) if (reason) nodes.push(text(doc, "div", "ttop-warning", `${name === "timetables" ? "시간표 보고서" : "운영 상태"} 없음: ${reasonText(reason)}`));
    const totals = report.totals ?? {};
    const byStatus = totals.timetablesByStatus;
    const live = totals.liveTrains;
    nodes.push(el(doc, "div", { className: "ttop-metrics" },
      ...(byStatus ? [...STATUS_ORDER, "other"].map((name) => metric(doc, name === "other" ? "기타 상태" : STATUS_TEXT[name].split(" ")[0], show(byStatus[name]))) : [metric(doc, "시간표", show(null))]),
      metric(doc, "dispatch", show(totals.dispatches)),
      ...(live ? [metric(doc, "운행 열차", show(live.total)), metric(doc, "시간표 열차", show(live.withTimetable)), metric(doc, "출처 미기록 예정 열차", show(live.scheduledProvenanceUnrecorded)), metric(doc, "레거시 빈도 열차", show(live.legacyFrequency)),
        metric(doc, "운행 중", show(live.running)), metric(doc, "위치 미상", show(live.positionUnknown)), metric(doc, "done 표시", show(live.done))] : [metric(doc, "운행 열차", show(null))])));
    return nodes;
  }

  function filterControls() {
    const tables = listOf(report.timetables);
    const lines = [...new Set([...listOf(report.lines).map((l) => l.operationalLineId), ...listOf(report.dispatches).map((d) => d.operationalLineId), ...listOf(report.trains).map((t) => t.operationalLineId)])].sort(cmp);
    const pick = (kind, label, options, onPick) => {
      const select = el(doc, "select", { className: `ttop-filter-${kind}`, value: filter?.kind === kind ? filter.id : "" },
        el(doc, "option", { value: "", textContent: "(전체)" }), ...options.map(([value, caption]) => el(doc, "option", { value, textContent: caption })));
      select.addEventListener("change", () => onPick(select.value));
      return el(doc, "label", { className: "ttop-field" }, text(doc, "span", "", label), select);
    };
    return el(doc, "div", { className: "ttop-filters" },
      pick("timetable", "시간표 보기", tables.map((t) => [t.timetableId, `${t.timetableId} · ${t.status ?? "상태 미상"}`]), (id) => api.setFilter(id ? { timetableId: id } : null)),
      pick("line", "노선 보기", lines.map((id) => [id, `노선 ${id}`]), (id) => api.setFilter(id ? { lineId: id } : null)),
      text(doc, "span", "ttop-note", filter ? `필터: ${filter.kind === "timetable" ? "시간표" : "노선"} ${filter.id} (읽기 전용 — 보고서 내용은 바뀌지 않음)` : "필터 없음 — 전체를 표시합니다."));
  }

  function timetableSection(rows) {
    const nodes = [text(doc, "strong", "ttop-section", rows === null ? "시간표 (보고서에 포함되지 않음)" : `시간표 ${rows.length}개`)];
    if (rows === null) { nodes.push(text(doc, "p", "ttop-empty", `시간표 목록이 없습니다: ${reasonText(report.unavailable?.timetables) ?? "이유가 보고서에 없음"}`)); return nodes; }
    if (!rows.length) nodes.push(text(doc, "p", "ttop-empty", "표시할 시간표가 없습니다(빈 목록)."));
    for (const t of rows) nodes.push(timetableCard(t));
    return nodes;
  }

  function timetableCard(t) {
    const card = el(doc, "div", { className: `ttop-card ttop-timetable ${t.status ?? "unknown"}` });
    card.append(text(doc, "b", "ttop-title", show(t.timetableId)));
    card.append(fact(doc, "생애주기 상태", t.status ? `${STATUS_TEXT[t.status] ?? t.status} (${t.status})` : show(null), "ttop-fact ttop-status"));
    card.append(fact(doc, "요일 유형 · 엔진 판정", `${show(t.dayType)} · ${t.verdict ? `${VERDICT_TEXT[t.verdict] ?? t.verdict} (${t.verdict})` : show(null)}`));
    const p = t.paths ?? {};
    card.append(fact(doc, "운행경로", `요청 ${show(p.requested)} · 수락 ${show(p.accepted)} · 거절 ${show(p.rejected)}`, "ttop-fact ttop-paths"));
    card.append(fact(doc, "대상 서비스", withReason(t.serviceIds, t.serviceIdsReason)));
    const life = t.lifecycle ?? {};
    const none = "없음 (아직 일어나지 않았거나 기록되지 않음)";
    card.append(fact(doc, "생애주기 시각", [["심사", life.createdAtMinute], ["승인", life.approvedAtMinute], ["활성", life.activatedAtMinute], ["대체", life.supersededAtMinute], ["철회", life.withdrawnAtMinute]]
      .map(([label, minute]) => `${label} ${show(clock(minute), { none })}`).join(" · "), "ttop-fact ttop-lifecycle"));
    if (t.status === "withdrawn" || life.withdrawnFromStatus) card.append(fact(doc, "철회 직전 상태", show(life.withdrawnFromStatus, { none })));
    card.append(fact(doc, "실제 운행 연결", `dispatch ${show(t.dispatchCount)}개 · 노선 ${show(t.dispatchLineIds)} · 놓친 출발 ${withReason(t.missedDepartures, t.missedDeparturesReason)}`, "ttop-fact ttop-link"));
    const tr = t.trains ?? {};
    card.append(fact(doc, "이 시간표의 지금 열차", `${show(tr.live)}대 (운행 중 ${show(tr.running)} · 위치 미상 ${show(tr.positionUnknown)} · done ${show(tr.done)}) · 서비스 ${show(tr.managementServiceIds)}`, "ttop-fact ttop-trains"));
    card.append(fact(doc, "완료한 열차 수", withReason(t.completedTrains, t.completedTrainsReason), "ttop-fact ttop-completed"));
    return card;
  }

  function dispatchSection(rows) {
    const nodes = [text(doc, "strong", "ttop-section", rows === null ? "dispatch (보고서에 포함되지 않음)" : `실제 운행선 dispatch ${rows.length}개`)];
    if (rows === null) { nodes.push(text(doc, "p", "ttop-empty", `운영 상태가 없어 dispatch를 알 수 없습니다: ${reasonText(report.unavailable?.operationalState) ?? "이유가 보고서에 없음"}`)); return nodes; }
    if (!rows.length) nodes.push(text(doc, "p", "ttop-empty", "표시할 dispatch가 없습니다(빈 목록)."));
    for (const d of rows) {
      const card = el(doc, "div", { className: "ttop-card ttop-dispatch" });
      card.append(text(doc, "b", "ttop-title", `노선 ${show(d.operationalLineId)} · ${show(d.dayType)} · 시간표 ${withReason(d.timetableId, d.timetableIdReason)}`));
      card.append(fact(doc, "서비스", show(d.serviceId)));
      const minutes = Array.isArray(d.departureMinutes) ? d.departureMinutes : null;
      card.append(fact(doc, "예정 출발", `하루 ${withReason(d.scheduledDeparturesPerDay, d.scheduledDeparturesReason)}회 · 출발 분 ${minutes === null ? show(null) : minutes.length > 12 ? `${minutes.slice(0, 12).join(", ")} 외 ${minutes.length - 12}개` : show(minutes)}`, "ttop-fact ttop-scheduled"));
      card.append(fact(doc, "놓친 출발", withReason(d.missedDepartures, d.missedDeparturesReason), "ttop-fact ttop-missed"));
      card.append(fact(doc, "막힘 사유", show(d.blockedReason, { none: "엔진에 기록된 막힘 사유 없음" }), "ttop-fact ttop-blocked"));
      card.append(fact(doc, "노선 정지", show(d.lineSuspended), "ttop-fact ttop-suspended"));
      card.append(fact(doc, "마지막 확인 시각", show(clock(d.lastCheckedSimMinute))));
      nodes.push(card);
    }
    return nodes;
  }

  function lineSection(rows) {
    const nodes = [text(doc, "strong", "ttop-section", rows === null ? "노선 (보고서에 포함되지 않음)" : `노선 ${rows.length}개`)];
    if (rows === null) return nodes;
    if (!rows.length) nodes.push(text(doc, "p", "ttop-empty", "표시할 노선 행이 없습니다(빈 목록)."));
    for (const l of rows) {
      const card = el(doc, "div", { className: "ttop-card ttop-line" });
      card.append(text(doc, "b", "ttop-title", `노선 ${show(l.operationalLineId)} · ${show(l.name)}`));
      card.append(fact(doc, "경영 서비스", withReason(l.managementServiceId, l.managementServiceIdReason)));
      card.append(fact(doc, "정지", show(l.suspended)));
      card.append(fact(doc, "dispatch 요일 유형", show(l.dispatchDayTypes)));
      card.append(fact(doc, "엔진이 기록한 운행 통계", l.traffic === null ? withReason(null, l.trafficReason)
        : Object.entries(l.traffic ?? {}).map(([name, value]) => `${name} ${show(value)}`).join(" · "), "ttop-fact ttop-traffic"));
      const t = l.trains ?? {};
      card.append(fact(doc, "지금 열차", `${show(t.live)}대 (시간표 ${show(t.withTimetable)} · 출처 미기록 예정 ${show(t.scheduledProvenanceUnrecorded)} · 레거시 빈도 ${show(t.legacyFrequency)})`));
      nodes.push(card);
    }
    return nodes;
  }

  function trainSection(rows) {
    const nodes = [text(doc, "strong", "ttop-section", rows === null ? "열차 (보고서에 포함되지 않음)" : `지금 선로 위의 열차 ${rows.length}대`)];
    if (rows === null) return nodes;
    if (!rows.length) nodes.push(text(doc, "p", "ttop-empty", "표시할 열차가 없습니다(빈 목록)."));
    for (const train of rows.slice(0, LIST_LIMIT)) {
      const card = el(doc, "div", { className: `ttop-card ttop-train ${train.provenance ?? "unknown"}` });
      card.append(text(doc, "b", "ttop-title", `열차 ${show(train.trainId)} · 노선 ${show(train.operationalLineId)}`));
      card.append(fact(doc, "출처(provenance)", train.provenance ? `${PROVENANCE_TEXT[train.provenance] ?? train.provenance} (${train.provenance})` : show(null), "ttop-fact ttop-provenance"));
      card.append(fact(doc, "시간표 ID", withReason(train.timetableId, train.timetableIdReason)));
      card.append(fact(doc, "경영 서비스 ID", withReason(train.managementServiceId, train.managementServiceIdReason)));
      card.append(fact(doc, "예정 출발 · 예정 완료", `${show(clock(train.scheduledDepartureMinute))} · ${show(clock(train.scheduledCompletionMinute))}`));
      card.append(fact(doc, "상태", train.status ? `${TRAIN_STATUS_TEXT[train.status] ?? train.status} (${train.status})` : show(null), "ttop-fact ttop-train-status"));
      if (train.positionUnknownReasons !== null && train.positionUnknownReasons !== undefined) {
        for (const code of listOf(train.positionUnknownReasons)) card.append(text(doc, "div", "ttop-reason", `위치 미상 이유: ${code}${POSITION_REASON_TEXT[code] ? ` — ${POSITION_REASON_TEXT[code]}` : ""}`));
      }
      card.append(fact(doc, "구간 번호 · 방향 · 진행도", `${show(train.segIndex)} · ${show(train.direction)} · ${show(train.progress)}`));
      card.append(fact(doc, "신호 대기 이유 · 보류 해제 시각", `${show(train.waitingForSignalReason, { none: "기록 없음" })} · ${show(clock(train.holdUntilSimMinute), { none: "기록 없음" })}`));
      nodes.push(card);
    }
    if (rows.length > LIST_LIMIT) nodes.push(text(doc, "div", "ttop-note", `외 ${rows.length - LIST_LIMIT}대는 표시하지 않았습니다. 시간표나 노선 필터로 좁혀 보세요.`));
    return nodes;
  }

  function issueSection(rows) {
    const nodes = [text(doc, "strong", "ttop-section", rows === null ? "issues (보고서에 포함되지 않음)" : `issues ${rows.length}개`), text(doc, "p", "ttop-note", ISSUES_NOTICE)];
    if (rows === null) return nodes;
    if (!rows.length) nodes.push(text(doc, "p", "ttop-empty", "표시할 issue가 없습니다(빈 목록)."));
    for (const issue of rows.slice(0, LIST_LIMIT * 2)) {
      const facts = Object.entries(issue).filter(([name]) => name !== "code").map(([name, value]) => `${name}: ${show(value)}`).join(" · ");
      nodes.push(text(doc, "div", "ttop-issue", `${show(issue.code)}${ISSUE_TEXT[issue.code] ? ` — ${ISSUE_TEXT[issue.code]}` : ""}${facts ? ` · ${facts}` : ""}`));
    }
    if (rows.length > LIST_LIMIT * 2) nodes.push(text(doc, "div", "ttop-note", `외 ${rows.length - LIST_LIMIT * 2}개`));
    return nodes;
  }

  function limitSection() {
    const rows = report.limits;
    const nodes = [text(doc, "strong", "ttop-section", Array.isArray(rows) ? `보고서가 말할 수 없는 것 ${rows.length}개 (limits)` : "limits (보고서에 포함되지 않음)")];
    for (const limit of listOf(rows)) nodes.push(el(doc, "div", { className: "ttop-limit" }, text(doc, "b", "", `${show(limit.id)}${LIMIT_TEXT[limit.id] ? ` — ${LIMIT_TEXT[limit.id]}` : ""}`), text(doc, "div", "ttop-limit-text", show(limit.text))));
    return nodes;
  }

  const api = {
    // Read the report again from the host. The host decides when; nothing here polls or schedules.
    refresh() { load(); render(); },
    // { timetableId } | { lineId } | null. Only the view changes; the report and the engine are untouched.
    setFilter(next) {
      if (next && typeof next.timetableId === "string" && next.timetableId) filter = { kind: "timetable", id: next.timetableId };
      else if (next && typeof next.lineId === "string" && next.lineId) filter = { kind: "line", id: next.lineId };
      else filter = null;
      render();
    },
    get filter() { return filter ? { ...(filter.kind === "timetable" ? { timetableId: filter.id } : { lineId: filter.id }) } : null; },
    // a copy of the report the panel is showing (null when there is none)
    get report() { return report === null ? null : structuredClone(report); },
  };
  load();
  render();
  return api;
}
