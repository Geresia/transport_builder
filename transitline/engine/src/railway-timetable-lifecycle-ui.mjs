// Management panel for the railway timetable lifecycle of a mapped service plan (B16-M5): assess -> approve -> activate, each step
// run by one player click and nothing else.  It sits on top of the B13 timetable engine and re-implements none of it:
//   assess    runtime.assessServicePlanTimetable(plan, binding, input)   (C1 adapter + E1 pre-screening + B13 assessment)
//   approve   runtime.approveRailwayTimetable(timetableId)
//   activate  runtime.activateRailwayTimetable(timetableId)
//   withdraw  runtime.withdrawRailwayTimetable(timetableId)   (B16-E3: an assessed / approved timetable the player will not use; the record stays)
// Mounting and refreshing call none of the three; they only read runtime.railwayTimetableReport().  Every verdict, accepted / rejected
// path, violation and error on screen is the engine's, copied as given; the panel computes no headway, capacity or "can it run".
// What the panel does decide is only whether an assessment is still about the same thing: it keeps a digest of the map plan, the
// binding and the assessment input the player assessed, and a later difference makes that assessment stale (details hidden, approve
// and activate blocked) until it is assessed again.  Nothing is persisted here — no localStorage; the player's lifecycle records are a
// small document the host saves (serialize / loadDoc).
import { issueText } from "./service-plan-management-ui.mjs";

export const RAILWAY_TIMETABLE_LIFECYCLE_DOC_SCHEMA = "transitline.railway-timetable-lifecycle-doc/1";

export const SCOPE_NOTICE = "이 패널은 서비스 계획의 시간표 심사·승인·개통을 플레이어가 한 단계씩 실행하는 곳입니다. 심사 결과·거절 경로·오류는 모두 엔진(B13)이 만든 값이며, 패널은 최소 시격·용량·운행 가능 여부를 계산하지 않습니다. 화면을 열거나 새로 고치는 것만으로는 엔진 명령이 실행되지 않습니다.";
export const STALE_NOTICE = "서비스 계획·연결·심사 전제가 심사한 뒤 바뀌었습니다. 이전 심사 결과는 더 이상 이 계획에 대한 것이 아니므로 숨기고, 승인·개통·철회를 막습니다. 다시 심사하세요.";

const ENGINE_STATUS = Object.freeze({ assessed: "심사됨", approved: "승인됨", active: "개통됨(활성)", superseded: "다른 시간표로 대체됨", withdrawn: "철회됨" });
const VERDICT = Object.freeze({ possible: "가능", conditional: "조건부", impossible: "불가", unknown: "미상" });
const STALE_TEXT = Object.freeze({
  "plan-missing": "서비스 계획이 지도에서 사라짐",
  "plan-changed": "서비스 계획 내용(지도 revision·용량 application 포함)이 바뀜",
  "binding-missing": "개통 서비스 연결이 해제됨",
  "binding-changed": "연결한 개통 서비스가 바뀜",
  "input-changed": "심사 전제 입력이 바뀜",
  "input-unavailable": "심사 전제 입력을 읽을 수 없음",
  "timetable-missing": "엔진에 이 시간표가 없음(다른 저장본이거나 삭제됨)",
  "timetable-mismatch": "엔진의 시간표가 이 심사 기록과 맞지 않음(다른 서비스이거나 다른 시각에 만들어짐)",
});
const LIST_LIMIT = 20;

const listOf = (value) => (Array.isArray(value) ? value : []);
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isText = (value) => typeof value === "string" && value.trim() !== "";
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const clone = (value) => structuredClone(value);
const message = (error) => (error instanceof Error ? error.message : String(error));
const valueText = (value) => (value === null || value === undefined ? "미상" : String(value));
const clock = (minute) => (Number.isFinite(minute) ? `${String(Math.floor(minute / 60) % 24).padStart(2, "0")}:${String(Math.round(minute % 60)).padStart(2, "0")}${minute >= 1440 ? "(+1일)" : ""}` : "미상");

// A stable fingerprint of "what was assessed": canonical JSON (keys sorted, Map / Set as lists) folded into two 32-bit hashes.
function canonical(value) {
  if (value === undefined) return "u";
  if (value === null) return "null";
  if (typeof value === "function") return "fn";
  if (value instanceof Map) return canonical([...value.entries()]);
  if (value instanceof Set) return canonical([...value]);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") return `{${Object.keys(value).sort(cmp).map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  return JSON.stringify(value);
}
export function digestOf(value) {
  const text = canonical(value);
  let a = 0x811c9dc5;
  let b = 0x9e3779b9;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b + c, 0x85ebca6b) >>> 0;
    b ^= b >>> 13;
  }
  return `${a.toString(16).padStart(8, "0")}${b.toString(16).padStart(8, "0")}:${text.length}`;
}

// --- the lifecycle document: which engine timetable the player made for which plan, and what it was made from ---------------------
export function newLifecycleDoc() {
  return { schema: RAILWAY_TIMETABLE_LIFECYCLE_DOC_SCHEMA, version: 1, entries: [] };
}

// -> { doc | null, issues }. Any issue refuses the whole document.
export function restoreLifecycleDoc(input) {
  let raw = input;
  if (typeof input === "string") { try { raw = JSON.parse(input); } catch { return { doc: null, issues: ["lifecycle-doc-unreadable"] }; } }
  if (!isObject(raw) || raw.schema !== RAILWAY_TIMETABLE_LIFECYCLE_DOC_SCHEMA || raw.version !== 1) return { doc: null, issues: ["lifecycle-doc-schema-invalid"] };
  if (!Array.isArray(raw.entries)) return { doc: null, issues: ["lifecycle-doc-entries-invalid"] };
  const issues = [];
  const seen = new Set();
  const entries = [];
  for (const [index, e] of raw.entries.entries()) {
    const where = isText(e?.servicePlanId) ? e.servicePlanId : String(index);
    const valid = isObject(e) && ["servicePlanId", "serviceId", "timetableId", "planDigest", "inputDigest"].every((name) => isText(e[name]))
      && (e.createdAtMinute === null || e.createdAtMinute === undefined || Number.isFinite(e.createdAtMinute));
    if (!valid) { issues.push(`entry-invalid:${where}`); continue; }
    if (seen.has(e.servicePlanId)) { issues.push(`entry-duplicate-plan:${where}`); continue; }
    seen.add(e.servicePlanId);
    entries.push({ servicePlanId: e.servicePlanId, serviceId: e.serviceId, timetableId: e.timetableId, createdAtMinute: e.createdAtMinute ?? null, planDigest: e.planDigest, inputDigest: e.inputDigest });
  }
  if (issues.length) return { doc: null, issues };
  return { doc: { schema: RAILWAY_TIMETABLE_LIFECYCLE_DOC_SCHEMA, version: 1, entries: entries.sort((a, b) => cmp(a.servicePlanId, b.servicePlanId)) }, issues: [] };
}

export function serializeLifecycleDoc(doc) {
  const restored = restoreLifecycleDoc(doc);
  if (!restored.doc) throw new Error(`Lifecycle document is invalid: ${restored.issues.join(", ")}`);
  return JSON.stringify(restored.doc, null, 2);
}

const el = (doc, tag, props = {}, ...kids) => { const node = doc.createElement(tag); Object.assign(node, props); node.append(...kids); return node; };
const text = (doc, tag, className, value) => el(doc, tag, { className, textContent: value });
const metric = (doc, label, value) => el(doc, "div", { className: "ttlife-metric" }, text(doc, "span", "", label), text(doc, "b", "", value));

export function mountRailwayTimetableLifecyclePanel({ container, runtime, getServicePlans, getBindings, getAssessmentInput, assessmentEnabled = true, onChange = () => {} } = {}) {
  if (!container) throw new Error("A railway timetable lifecycle container is required");
  for (const [name, fn] of [["getServicePlans", getServicePlans], ["getBindings", getBindings], ["getAssessmentInput", getAssessmentInput]]) {
    if (typeof fn !== "function") throw new Error(`${name}() is required`);
  }
  for (const method of ["assessServicePlanTimetable", "approveRailwayTimetable", "activateRailwayTimetable", "withdrawRailwayTimetable", "railwayTimetableReport"]) {
    if (typeof runtime?.[method] !== "function") throw new Error(`A ScenarioRuntime with ${method} is required`);
  }
  const doc = container.ownerDocument ?? document;
  let lifecycle = newLifecycleDoc();
  // what the last click on a plan produced (C1 result, engine error, notice); dropped as soon as the plan's premises differ
  let session = new Map();
  let rows = [];
  let busy = false;

  const plansNow = () => { const value = getServicePlans(); return listOf(isObject(value) ? value.plans : value).filter(isObject); };
  const bindingsNow = () => { const value = getBindings(); return listOf(isObject(value) ? value.bindings : value).filter(isObject); };

  // The assessment input is the host's: whatever it returns is handed to the engine as it is.
  function inputFor(plan, binding) {
    const value = getAssessmentInput(clone(plan), clone(binding));
    if (!isObject(value)) throw new Error("getAssessmentInput() must return an object (the assessment input; {} when there is nothing to add)");
    return value;
  }

  function engineTimetable(id) {
    try { return listOf(runtime.railwayTimetableReport(id))[0] ?? null; } catch { return null; }
  }

  // The premises as they are now.  `inputError` is set (and the digest is null) when the host cannot give the input.
  function premises(plan, binding) {
    const serviceId = isText(binding?.serviceId) ? binding.serviceId : null;
    const out = { serviceId, planDigest: plan ? digestOf(plan) : null, inputDigest: null, inputError: null };
    if (plan && serviceId) {
      try { out.inputDigest = digestOf(inputFor(plan, { servicePlanId: plan.servicePlanId, serviceId })); } catch (e) { out.inputError = message(e); }
    }
    return out;
  }

  function staleReasons(entry, plan, now, timetable) {
    const reasons = [];
    if (!plan) reasons.push("plan-missing");
    else if (entry.planDigest !== now.planDigest) reasons.push("plan-changed");
    if (!now.serviceId) reasons.push("binding-missing");
    else if (entry.serviceId !== now.serviceId) reasons.push("binding-changed");
    if (plan && now.serviceId && entry.serviceId === now.serviceId) {
      if (now.inputError) reasons.push("input-unavailable");
      else if (entry.inputDigest !== now.inputDigest) reasons.push("input-changed");
    }
    if (!timetable) reasons.push("timetable-missing");
    else {
      const services = listOf(timetable.operationalFacts?.serviceIds);
      const expectedServices = lifecycle.entries.filter((candidate) => candidate.timetableId === entry.timetableId).map((candidate) => candidate.serviceId).sort(cmp);
      if (JSON.stringify(services.sort(cmp)) !== JSON.stringify(expectedServices) || (entry.createdAtMinute !== null && timetable.createdAtMinute !== entry.createdAtMinute)) reasons.push("timetable-mismatch");
    }
    return reasons;
  }

  function compute() {
    const plans = plansNow().filter((plan) => isText(plan.servicePlanId)).sort((a, b) => cmp(a.servicePlanId, b.servicePlanId));
    const bindings = bindingsNow();
    const next = plans.map((plan) => {
      const servicePlanId = plan.servicePlanId;
      const binding = bindings.find((entry) => entry.servicePlanId === servicePlanId) ?? null;
      const now = premises(plan, binding);
      const entry = lifecycle.entries.find((e) => e.servicePlanId === servicePlanId) ?? null;
      const timetable = entry ? engineTimetable(entry.timetableId) : null;
      const stale = entry ? staleReasons(entry, plan, now, timetable) : [];
      // a result the player was shown for other premises is not shown any more
      const kept = session.get(servicePlanId);
      if (kept && (kept.planDigest !== now.planDigest || kept.serviceId !== now.serviceId || kept.inputDigest !== now.inputDigest)) session.delete(servicePlanId);
      return { servicePlanId, servicePlanRevision: isText(plan.servicePlanRevision) ? plan.servicePlanRevision : null, name: isText(plan.name) ? plan.name : null,
        serviceId: now.serviceId, now, entry: entry ? clone(entry) : null, timetable, staleReasons: stale, stale: stale.length > 0, session: session.get(servicePlanId) ?? null };
    });
    const present = new Set(plans.map((plan) => plan.servicePlanId));
    return { rows: next, orphans: lifecycle.entries.filter((e) => !present.has(e.servicePlanId)).map(clone) };
  }

  const canAssess = (row) => assessmentEnabled && row.serviceId !== null && !row.now.inputError && (!row.entry || row.stale || ["superseded", "withdrawn"].includes(row.timetable?.status));
  const canApprove = (row) => row.entry !== null && !row.stale && row.timetable?.status === "assessed";
  const canActivate = (row) => row.entry !== null && !row.stale && row.timetable?.status === "approved";
  // Only this plan's own record, and only while it is not stale.  Whether the engine accepts the withdrawal is the engine's call: the
  // button follows the engine's reported status, it does not decide a transition.
  const canWithdraw = (row) => row.entry !== null && !row.stale && ["assessed", "approved"].includes(row.timetable?.status);

  // --- the three steps; each one a click, each one re-checks the premises first and calls the engine at most once ---
  function act(servicePlanId, kind) {
    if (busy) return;
    busy = true;
    try {
      const { rows: now } = compute();
      const row = now.find((r) => r.servicePlanId === servicePlanId);
      if (!row) return;
      const remember = (extra) => session.set(servicePlanId, { planDigest: row.now.planDigest, serviceId: row.now.serviceId, inputDigest: row.now.inputDigest, adaptation: null, error: null, notice: null, ...extra });
      const allowed = { assess: canAssess, approve: canApprove, activate: canActivate, withdraw: canWithdraw }[kind](row);
      if (!allowed) {
        remember({ error: kind === "assess" ? "지금은 심사할 수 없습니다(연결·전제 입력을 확인하세요, 또는 이미 같은 전제로 심사됨)." : row.stale ? "낡은 심사라서 실행하지 않았습니다. 다시 심사하세요." : "이 단계는 지금 실행할 수 없습니다." });
        return;
      }
      try {
        if (kind === "assess") {
          const plan = plansNow().find((p) => p.servicePlanId === servicePlanId);
          const binding = { servicePlanId, serviceId: row.serviceId };
          const input = inputFor(plan, binding);
          const digests = { planDigest: digestOf(plan), inputDigest: digestOf(input) };
          const result = runtime.assessServicePlanTimetable(clone(plan), clone(binding), clone(input));
          const adaptation = result?.adaptation ? clone(result.adaptation) : null;
          if (result?.timetable?.id) {
            lifecycle.entries = [...lifecycle.entries.filter((e) => e.servicePlanId !== servicePlanId),
              { servicePlanId, serviceId: row.serviceId, timetableId: result.timetable.id, createdAtMinute: result.timetable.createdAtMinute ?? null, ...digests }].sort((a, b) => cmp(a.servicePlanId, b.servicePlanId));
            remember({ adaptation, notice: `시간표 ${result.timetable.id} 를 심사했습니다.` });
            onChange();
          } else {
            // the engine produced no timetable: an older record for this plan is superseded by this attempt, and the reasons are shown
            const had = lifecycle.entries.length;
            lifecycle.entries = lifecycle.entries.filter((e) => e.servicePlanId !== servicePlanId);
            remember({ adaptation, notice: "엔진이 시간표를 만들지 않았습니다. 아래 사유를 해결한 뒤 다시 심사하세요." });
            if (lifecycle.entries.length !== had) onChange();
          }
        } else {
          const name = { approve: "approveRailwayTimetable", activate: "activateRailwayTimetable", withdraw: "withdrawRailwayTimetable" }[kind];
          runtime[name](row.entry.timetableId);
          const done = { approve: "승인했습니다.", activate: "개통했습니다.", withdraw: "철회했습니다. 기록은 감사용으로 남습니다." }[kind];
          remember({ notice: `시간표 ${row.entry.timetableId} 를 ${done}` });
          onChange();
        }
      } catch (e) { remember({ error: message(e) }); }
    } finally { busy = false; refresh(); }
  }

  function dropOrphan(servicePlanId) {
    lifecycle.entries = lifecycle.entries.filter((e) => e.servicePlanId !== servicePlanId);
    refresh();
    onChange();
  }

  // The host may assess several map plans as one B13 timetable. Record every
  // participating plan against that shared engine timetable; later approval
  // and activation remain the engine's own one-click lifecycle commands.
  function recordBatchAssessment({ entries, result } = {}) {
    if (!Array.isArray(entries) || !result?.timetable?.id || !Array.isArray(result.adaptations)) return false;
    const plans = plansNow();
    const additions = [];
    for (const entry of entries) {
      const servicePlanId = entry?.servicePlan?.servicePlanId;
      const serviceId = entry?.binding?.serviceId;
      const plan = plans.find((candidate) => candidate.servicePlanId === servicePlanId);
      const adaptation = result.adaptations.find((candidate) => candidate.servicePlanId === servicePlanId && candidate.serviceId === serviceId);
      if (!plan || !isText(serviceId) || !adaptation || adaptation.status !== "ready") return false;
      const input = inputFor(plan, { servicePlanId, serviceId });
      additions.push({ servicePlanId, serviceId, timetableId: result.timetable.id, createdAtMinute: result.timetable.createdAtMinute ?? null,
        planDigest: digestOf(plan), inputDigest: digestOf(input), adaptation: clone(adaptation) });
    }
    if (new Set(additions.map((entry) => entry.servicePlanId)).size !== additions.length) return false;
    const ids = new Set(additions.map((entry) => entry.servicePlanId));
    lifecycle.entries = [...lifecycle.entries.filter((entry) => !ids.has(entry.servicePlanId)), ...additions.map(({ adaptation, ...entry }) => entry)]
      .sort((left, right) => cmp(left.servicePlanId, right.servicePlanId));
    for (const entry of additions) session.set(entry.servicePlanId, { planDigest: entry.planDigest, serviceId: entry.serviceId, inputDigest: entry.inputDigest, adaptation: entry.adaptation, error: null, notice: `Shared timetable ${entry.timetableId} assessed.` });
    refresh();
    onChange();
    return true;
  }

  // --- rendering ---
  function refresh() {
    let view;
    let failure = null;
    try { view = compute(); } catch (e) { view = { rows: [], orphans: [] }; failure = message(e); }
    rows = view.rows;
    const children = [text(doc, "p", "ttlife-notice", SCOPE_NOTICE)];
    if (failure) children.push(text(doc, "div", "ttlife-error", failure));
    children.push(el(doc, "div", { className: "ttlife-metrics" }, metric(doc, "서비스 계획", String(rows.length)), metric(doc, "심사 기록", String(rows.filter((r) => r.entry).length)),
      metric(doc, "낡은 심사", String(rows.filter((r) => r.stale).length)), metric(doc, "개통됨", String(rows.filter((r) => r.timetable?.status === "active" && !r.stale).length)), metric(doc, "철회됨", String(rows.filter((r) => r.timetable?.status === "withdrawn" && !r.stale).length))));
    if (!rows.length && !failure) children.push(text(doc, "p", "ttlife-empty", "서비스 계획이 없습니다. 지도에서 서비스 계획을 그리고 개통 서비스에 연결하세요."));
    for (const row of rows) children.push(card(row));
    if (view.orphans.length) {
      children.push(text(doc, "strong", "ttlife-section", `지도에 없는 계획의 심사 기록 ${view.orphans.length}개 (저장 문서에는 그대로 남음)`));
      for (const orphan of view.orphans) {
        const drop = el(doc, "button", { type: "button", textContent: "기록 지우기" });
        drop.addEventListener("click", () => dropOrphan(orphan.servicePlanId));
        children.push(el(doc, "div", { className: "ttlife-orphan" }, text(doc, "span", "", `계획 ${orphan.servicePlanId} → 서비스 ${orphan.serviceId} · 시간표 ${orphan.timetableId} (서비스 계획이 지도에 없음 — 낡음)`), drop));
      }
    }
    container.replaceChildren(...children);
  }

  function button(label, enabled, kind, servicePlanId) {
    const node = el(doc, "button", { type: "button", className: `ttlife-${kind}`, textContent: label, disabled: !enabled });
    node.addEventListener("click", () => act(servicePlanId, kind));
    return node;
  }

  function card(row) {
    const node = el(doc, "div", { className: `ttlife-card${row.stale ? " stale" : ""}` });
    node.append(el(doc, "div", { className: "ttlife-head" }, text(doc, "b", "ttlife-title", row.name ?? row.servicePlanId)));
    node.append(
      el(doc, "div", { className: "ttlife-id ttlife-id-plan" }, text(doc, "span", "ttlife-id-kind", "지도 계획 ID (설계 문서)"), text(doc, "code", "", row.servicePlanId)),
      el(doc, "div", { className: "ttlife-id ttlife-id-service" }, text(doc, "span", "ttlife-id-kind", "개통 서비스 ID (경영 서비스)"), text(doc, "code", "", row.serviceId ?? "연결 안 됨")),
    );
    if (!row.serviceId) node.append(text(doc, "div", "ttlife-note", "개통 서비스에 연결되지 않았습니다. 서비스 계획 관리 패널(M3)에서 연결하세요."));
    if (row.now.inputError) node.append(text(doc, "div", "ttlife-warning", `심사 전제 입력을 읽을 수 없음: ${row.now.inputError}`));

    node.append(el(doc, "div", { className: "ttlife-steps" }, stepText(row, "assess", "1 시간표 심사"), stepText(row, "approve", "2 승인"), stepText(row, "activate", "3 개통")));
    node.append(el(doc, "div", { className: "ttlife-actions" },
      button(row.entry && !row.stale ? "시간표 심사 (이미 심사됨)" : "시간표 심사", canAssess(row), "assess", row.servicePlanId),
      button("승인", canApprove(row), "approve", row.servicePlanId),
      button("개통", canActivate(row), "activate", row.servicePlanId),
      button("철회", canWithdraw(row), "withdraw", row.servicePlanId)));

    if (row.entry) {
      node.append(text(doc, "div", "ttlife-fact", `심사 기록: 시간표 ${row.entry.timetableId}`));
      const sharedWith = lifecycle.entries.filter((e) => e.timetableId === row.entry.timetableId && e.servicePlanId !== row.servicePlanId).map((e) => e.servicePlanId);
      if (sharedWith.length) node.append(text(doc, "div", "ttlife-note", `이 시간표는 다른 계획과 함께 심사됐습니다: ${sharedWith.join(", ")} — 철회하면 그 계획의 기록도 철회됨으로 보입니다.`));
      if (!row.stale && row.timetable?.status === "active") node.append(text(doc, "div", "ttlife-note", "개통된 시간표는 철회할 수 없습니다(엔진 규칙). 같은 요일 유형의 다른 시간표를 개통하면 이것이 대체됩니다."));
      if (row.stale) {
        node.append(text(doc, "div", "ttlife-stale", "낡은 심사 — 승인·개통 불가"));
        node.append(text(doc, "div", "ttlife-note", STALE_NOTICE));
        for (const reason of row.staleReasons) node.append(text(doc, "div", "ttlife-stale-reason", `${STALE_TEXT[reason] ?? reason} (${reason})`));
      } else if (row.timetable) node.append(...timetableSection(row.timetable));
    }
    const kept = row.session;
    if (kept?.notice) node.append(text(doc, "div", "ttlife-notice", kept.notice));
    if (kept?.error) node.append(text(doc, "div", "ttlife-error", `엔진/패널 오류: ${kept.error}`));
    if (kept?.adaptation) node.append(...adaptationSection(kept.adaptation));
    return node;
  }

  function stepText(row, kind, label) {
    const status = row.timetable?.status;
    const done = !row.stale && ((kind === "assess" && row.entry) || (kind === "approve" && ["approved", "active", "superseded"].includes(status)) || (kind === "activate" && ["active", "superseded"].includes(status)));
    return text(doc, "span", `ttlife-step ${kind}${done ? " done" : ""}`, `${label}${done ? " ✓" : ""}`);
  }

  // The engine's timetable record, shown as it is.
  function timetableSection(timetable) {
    const a = timetable.assessment ?? {};
    const nodes = [text(doc, "div", `ttlife-engine-status ${timetable.status}`, `엔진 상태: ${ENGINE_STATUS[timetable.status] ?? timetable.status} (${timetable.status})`),
      text(doc, "div", `ttlife-verdict ${a.verdict}`, `엔진 판정: ${VERDICT[a.verdict] ?? valueText(a.verdict)} (${valueText(a.verdict)}) · 요청 경로 ${valueText(timetable.requestedPaths)}개 · 수용된 경로 ${listOf(timetable.acceptedPaths).length}개 · 거절된 경로 ${listOf(timetable.rejectedPaths).length}개 · 수용률 ${valueText(a.acceptanceRatio)} (요구 ${valueText(timetable.minimumAcceptanceRatio)})`)];
    if (timetable.status === "withdrawn") {
      nodes.push(text(doc, "div", "ttlife-withdrawn", `철회 이력: ${valueText(timetable.withdrawnFromStatus)} 상태에서 ${valueText(timetable.withdrawnAtMinute)}분에 철회${timetable.withdrawalReason ? ` · 사유: ${timetable.withdrawalReason}` : ""}`));
      nodes.push(text(doc, "div", "ttlife-note", "철회된 시간표는 승인·개통할 수 없습니다. 아래는 철회 전 심사 결과(감사용 기록)입니다. 새로 심사하세요."));
    }
    for (const code of listOf(a.missingInputs)) nodes.push(text(doc, "div", "ttlife-missing", `부족한 입력: ${code}`));
    for (const code of listOf(a.violations)) nodes.push(text(doc, "div", "ttlife-violation", `위반: ${code}`));
    const accepted = listOf(timetable.acceptedPaths);
    nodes.push(text(doc, "div", "ttlife-group-title accepted", `수용된 경로 ${accepted.length}`));
    for (const path of accepted.slice(0, LIST_LIMIT)) nodes.push(text(doc, "div", "ttlife-line accepted", `${path.pathId} · 서비스 ${valueText(path.serviceId)} · ${valueText(path.direction)} · ${clock(path.departureMinute)} → ${clock(path.arrivalMinute)}`));
    if (accepted.length > LIST_LIMIT) nodes.push(text(doc, "div", "ttlife-note", `외 ${accepted.length - LIST_LIMIT}개`));
    const rejected = listOf(timetable.rejectedPaths);
    nodes.push(text(doc, "div", "ttlife-group-title rejected", `거절된 경로 ${rejected.length}`));
    for (const path of rejected.slice(0, LIST_LIMIT)) nodes.push(text(doc, "div", "ttlife-line rejected", `${path.pathId} · ${valueText(path.reason)}${path.detail ? ` · ${path.detail}` : ""}${path.sectionId ? ` · 구간 ${path.sectionId}` : ""}${path.conflictPathId ? ` · 충돌 경로 ${path.conflictPathId}` : ""}`));
    if (rejected.length > LIST_LIMIT) nodes.push(text(doc, "div", "ttlife-note", `외 ${rejected.length - LIST_LIMIT}개`));
    return nodes;
  }

  // C1's answer for the last assess click, as given
  function adaptationSection(adaptation) {
    const nodes = [text(doc, "div", `ttlife-adapter ${adaptation.status}`, `시간표 변환 확인(C1): ${adaptation.status}`)];
    for (const issue of listOf(adaptation.issues)) nodes.push(text(doc, "div", "ttlife-issue", issueText(issue)));
    const p = adaptation.prescreen;
    if (p) {
      nodes.push(text(doc, "div", "ttlife-fact", `사전심사(E1): ${valueText(p.verdict)}`));
      for (const [label, list] of [["막힘", p.blockers], ["미상", p.missingInputs], ["조건", p.conditions]]) if (listOf(list).length) nodes.push(text(doc, "div", "ttlife-fact", `사전심사 ${label}: ${listOf(list).join(", ")}`));
    }
    return nodes;
  }

  refresh();
  return {
    refresh,
    serialize: () => serializeLifecycleDoc(lifecycle),
    // -> { ok, issues }. A refused document leaves the current records untouched. No engine call.
    loadDoc(input) {
      const { doc: loaded, issues } = restoreLifecycleDoc(input);
      if (!loaded) return { ok: false, issues };
      lifecycle = loaded; session = new Map();
      refresh();
      return { ok: true, issues: [] };
    },
    get document() { return clone(lifecycle); },
    recordBatchAssessment,
    // copies of what is on screen, for the host and tests
    results: () => rows.map((row) => ({
      servicePlanId: row.servicePlanId, serviceId: row.serviceId, timetableId: row.entry?.timetableId ?? null, stale: row.stale, staleReasons: [...row.staleReasons],
      engineStatus: row.stale ? null : (row.timetable?.status ?? null), verdict: row.stale ? null : (row.timetable?.assessment?.verdict ?? null),
      acceptedPaths: row.stale ? null : listOf(row.timetable?.acceptedPaths).length, rejectedPaths: row.stale ? null : listOf(row.timetable?.rejectedPaths).length,
      canAssess: canAssess(row), canApprove: canApprove(row), canActivate: canActivate(row), canWithdraw: canWithdraw(row), error: row.session?.error ?? null,
    })),
  };
}
