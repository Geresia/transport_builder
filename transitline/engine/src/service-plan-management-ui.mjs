// Management panel for map service plans (B16-M3).  It lists the service plans drawn on the map, lets the player tie each one to a
// commissioned management service, and shows two read-only answers about that pair:
//   B16-E1  prescreenServicePlan  — plan / line / technical / fleet / track: is each fact there, does it fit, or is it unknown
//   B16-C1  adaptServicePlanToOperationalTimetable — can this plan be turned into a B13 timetable request (ready / unknown / blocked / unsupported)
// Only a plan whose adaptation is `ready` (and that shares its service with no other plan) is shown as "ready for timetable assessment".
// The panel never calls assessOperationalRailwayTimetable / approve / activate: running B13 is the host's (Codex E2) job, and it can
// take the requests from `readyPlans()`.  It computes no demand, fare, cost, crowding or timetable capacity; every verdict on screen is
// E1's or C1's.  Nothing is persisted here — no localStorage.  The player's choices live in a small binding document the host saves
// (serialize / loadDoc); map plans, runtime reports and the engine results are only read.
import { adaptServicePlanToOperationalTimetable } from "./service-plan-timetable-adapter.mjs";

export const SERVICE_PLAN_BINDING_DOC_SCHEMA = "transitline.service-plan-binding-doc/1";

export const SCOPE_NOTICE = "이 패널은 지도 서비스 계획을 개통된 서비스에 연결하고, 엔진의 사전심사(E1)와 시간표 변환 가능 여부(C1)를 읽어 보여 줍니다. 시간표·배차 간격·선로 용량·수요·비용·혼잡은 계산하지 않으며, 시간표 심사·승인·활성화는 이 패널이 아니라 별도 단계에서 실행합니다.";
export const ID_KIND_NOTICE = "지도 계획 ID(servicePlanId)는 지도에서 만든 설계 문서의 식별자이고, 개통 서비스 ID(serviceId)는 경영에서 실제로 운행하는 서비스의 식별자입니다. 서로 다른 종류의 ID이며 같다고 보지 않습니다. 이름·번호·순서가 비슷해도 연결하지 않으니 연결할 서비스를 직접 고르세요.";
export const PRESCREEN_NOTICE = "사전심사의 '막힘 없음'은 검사한 사실에 막힘도 미상도 없다는 뜻이지 시간표 승인이 아닙니다. 최소 시격·시간당 용량·단선/분기기/회차 충돌·폐쇄 시간창은 시간표 심사(B13)에서 판정합니다.";

const READINESS_LABEL = Object.freeze({
  ready: "시간표 심사 준비 완료",
  unbound: "서비스 연결 필요 — 심사 준비 안 됨",
  "duplicate-binding": "같은 서비스에 여러 계획이 연결됨 — 심사에 넘길 수 없음",
  unknown: "미상 — 심사 준비 안 됨",
  blocked: "차단 — 심사에 넘길 수 없음",
  unsupported: "지원하지 않는 계획 — 심사에 넘길 수 없음",
});
const VERDICT_LABEL = Object.freeze({ possible: "막힘 없음", conditional: "조건부", impossible: "불가", unknown: "미상" });
const AREA_LABEL = Object.freeze({ plan: "계획", line: "운행선", technical: "기술사양", fleet: "차량", track: "선로·종착" });
const AREAS = Object.freeze(["plan", "line", "technical", "fleet", "track"]);
const PATTERN_LABEL = Object.freeze({ "short-turn": "단축 운행", "partial-section": "일부 구간만 운행" });

const ISSUE_TEXT = Object.freeze({
  "service-plan-invalid": "서비스 계획 문서가 올바른 형식이 아님",
  "service-plan-id-missing": "서비스 계획 ID가 없음",
  "explicit-management-service-binding-required": "개통 서비스에 아직 연결하지 않음",
  "binding-service-plan-mismatch": "연결 문서의 계획 ID가 이 계획과 다름",
  "service-plan-inactive": "플레이어가 꺼 둔(비활성) 계획",
  "map-revision-stale": "지도가 바뀐 뒤 확인하지 않은 낡은 계획(stale)",
  "map-revision-not-current": "지도 revision이 현재인지 확인되지 않음",
  "capacity-application-stale": "철도 용량 application이 지도보다 오래됨(stale)",
  "capacity-application-not-current": "철도 용량 application이 현재인지 확인되지 않음",
  "management-service-not-found": "연결한 서비스가 지금 경영에 없음",
  "through-service-prescreen-unsupported": "직통 서비스는 아직 지원하지 않음",
  "management-service-operational-line-missing": "연결한 서비스에 실제 운행선이 없음",
  "map-operational-line-mismatch": "지도 계획의 운영 노선과 서비스의 실제 운행선이 다름",
  "operational-line-route-unusable": "실제 운행선의 선로 구간을 읽을 수 없음",
  "service-plan-track-segment-mapping-missing": "지도 구간이 실제 선로 구간에 대응되지 않음",
  "route-does-not-match-operational-line": "지도 계획의 구간이 서비스의 실제 운행선 구간과 다름",
  "route-direction-does-not-match-operational-line": "지도 계획의 진행 방향이 실제 운행선과 다름",
  "partial-or-unstated-operating-pattern-unsupported": "전체 노선 운행이 아님",
  "directions-not-stated": "방향을 적지 않음",
  "bidirectional-full-line-directions-required": "노선 전체 양방향이 아님(편도이거나 일부 구간 방향)",
  "direction-physical-connection-false": "방향의 구간이 물리적으로 이어지지 않음",
  "direction-physical-connection-unknown": "방향의 구간이 이어지는지 알 수 없음",
  "service-bands-not-stated": "시간대를 적지 않음",
  "no-operating-service-band": "운행하는 시간대가 없음",
  "multiple-operating-service-bands-unsupported": "운행 시간대가 여러 개임(시간표 심사는 한 시간대만 받음)",
  "player-requested-headway-missing-or-invalid": "요청 배차 간격이 없거나 올바르지 않음",
  "service-band-time-invalid": "시간대의 시작·끝 시각이 올바르지 않음",
  "service-band-does-not-cover-both-directions": "시간대가 양방향을 모두 덮지 않음",
  "far-terminal-resource-not-selected": "끝 역의 종착 자원을 고르지 않음",
  "far-terminal-resource-ambiguous": "끝 역의 종착 자원이 둘 이상이라 하나로 정할 수 없음",
});

const listOf = (value) => (Array.isArray(value) ? value : []);
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isText = (value) => typeof value === "string" && value.trim() !== "";
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const clone = (value) => structuredClone(value);
const message = (error) => (error instanceof Error ? error.message : String(error));
const valueText = (value) => (value === null || value === undefined ? "미상" : String(value));

function issueText(issue) {
  const base = ISSUE_TEXT[issue.code] ?? issue.code;
  const facts = issue.facts ?? {};
  let detail = "";
  if (issue.code === "partial-or-unstated-operating-pattern-unsupported") detail = ` — ${PATTERN_LABEL[facts.operatingPattern] ?? "운행 방식 미기재"}`;
  else if (issue.code === "multiple-operating-service-bands-unsupported") detail = ` — ${listOf(facts.bandIds).join(", ")}`;
  else if (issue.code === "far-terminal-resource-not-selected") detail = ` — 역 ${valueText(facts.stationId)}`;
  else if (issue.code === "far-terminal-resource-ambiguous") detail = ` — 역 ${valueText(facts.stationId)}: ${listOf(facts.terminalResourceIds).join(", ")}`;
  else if (issue.code === "map-operational-line-mismatch") detail = ` — 지도 ${valueText(facts.mapOperationalLineId)} / 실제 ${valueText(facts.operationalLineId)}`;
  else if (issue.code === "route-does-not-match-operational-line") detail = ` — 지도 [${listOf(facts.mappedTrackSegmentIds).join(", ")}] / 실제 [${listOf(facts.operationalTrackSegmentIds).join(", ")}]`;
  else if (issue.code === "management-service-not-found") detail = ` — ${valueText(facts.serviceId)}`;
  else if (issue.code === "binding-service-plan-mismatch") detail = ` — 연결 ${valueText(facts.boundServicePlanId)} / 계획 ${valueText(facts.servicePlanId)}`;
  return `${base}${detail} (${issue.code})`;
}

// --- the binding document: which map plan the player tied to which commissioned service -----------------------------------------
export function newBindingDoc() {
  return { schema: SERVICE_PLAN_BINDING_DOC_SCHEMA, version: 1, bindings: [] };
}

// -> { doc | null, issues }. Any issue refuses the whole document: a binding document is never half loaded.
export function restoreBindingDoc(input) {
  let raw = input;
  if (typeof input === "string") { try { raw = JSON.parse(input); } catch { return { doc: null, issues: ["binding-doc-unreadable"] }; } }
  if (!isObject(raw) || raw.schema !== SERVICE_PLAN_BINDING_DOC_SCHEMA || raw.version !== 1) return { doc: null, issues: ["binding-doc-schema-invalid"] };
  if (!Array.isArray(raw.bindings)) return { doc: null, issues: ["binding-doc-bindings-invalid"] };
  const issues = [];
  const seen = new Set();
  const bindings = [];
  for (const [index, entry] of raw.bindings.entries()) {
    const where = isText(entry?.servicePlanId) ? entry.servicePlanId : String(index);
    if (!isObject(entry) || !isText(entry.servicePlanId) || !isText(entry.serviceId)) { issues.push(`binding-invalid:${where}`); continue; }
    if (entry.servicePlanRevision !== null && entry.servicePlanRevision !== undefined && !isText(entry.servicePlanRevision)) { issues.push(`binding-revision-invalid:${where}`); continue; }
    if (seen.has(entry.servicePlanId)) { issues.push(`binding-duplicate-plan:${where}`); continue; }
    seen.add(entry.servicePlanId);
    bindings.push({ servicePlanId: entry.servicePlanId, serviceId: entry.serviceId, servicePlanRevision: entry.servicePlanRevision ?? null });
  }
  if (issues.length) return { doc: null, issues };
  return { doc: { schema: SERVICE_PLAN_BINDING_DOC_SCHEMA, version: 1, bindings: bindings.sort((a, b) => cmp(a.servicePlanId, b.servicePlanId)) }, issues: [] };
}

export function serializeBindingDoc(doc) {
  const restored = restoreBindingDoc(doc);
  if (!restored.doc) throw new Error(`Binding document is invalid: ${restored.issues.join(", ")}`);
  return JSON.stringify(restored.doc, null, 2);
}

// --- the view: one row per map plan, built only from what E1 / C1 / the runtime reports say ------------------------------------
// context: { operationalState, services, throughServices, prescreenContext }
export function buildServicePlanPanelView({ servicePlans, doc, context = {} } = {}) {
  const plans = listOf(servicePlans).filter(isObject).sort((a, b) => cmp(String(a.servicePlanId), String(b.servicePlanId)));
  const bindings = listOf(doc?.bindings);
  const bindingOf = (servicePlanId) => bindings.find((entry) => entry.servicePlanId === servicePlanId) ?? null;
  const serviceKind = (serviceId) => (listOf(context.services).some((s) => String(s?.id) === serviceId) ? "standard"
    : listOf(context.throughServices).some((s) => String(s?.throughServiceId) === serviceId) ? "through" : "missing");
  const rows = plans.map((plan) => {
    const servicePlanId = isText(plan.servicePlanId) ? plan.servicePlanId : null;
    const binding = servicePlanId ? bindingOf(servicePlanId) : null;
    const serviceId = binding?.serviceId ?? null;
    let adaptation = null;
    let error = null;
    try {
      adaptation = adaptServicePlanToOperationalTimetable({
        servicePlan: plan, binding: serviceId ? { servicePlanId, serviceId } : {},
        operationalState: context.operationalState ?? null, services: listOf(context.services), throughServices: listOf(context.throughServices),
        prescreenContext: context.prescreenContext ?? {},
      });
    } catch (e) { error = message(e); }
    const sharers = serviceId ? plans.filter((other) => other !== plan && bindingOf(String(other.servicePlanId))?.serviceId === serviceId).map((other) => String(other.servicePlanId)).sort(cmp) : [];
    const readiness = !serviceId ? "unbound" : sharers.length ? "duplicate-binding" : (adaptation?.status ?? "unknown");
    return {
      servicePlanId, servicePlanRevision: isText(plan.servicePlanRevision) ? plan.servicePlanRevision : null, name: isText(plan.name) ? plan.name : null,
      active: plan.active ?? null, revisionState: plan.revision?.state ?? null, capacityApplicationState: plan.capacityApplicationState ?? null,
      operatingPattern: plan.playerInputs?.operatingPattern ?? null,
      bandCount: Array.isArray(plan.serviceBands) ? plan.serviceBands.length : null, directionCount: Array.isArray(plan.directions) ? plan.directions.length : null,
      serviceId, serviceKind: serviceId ? serviceKind(serviceId) : null, bindingRevisionChanged: Boolean(binding?.servicePlanRevision && binding.servicePlanRevision !== plan.servicePlanRevision),
      sharedWithServicePlanIds: sharers, readiness, adaptation, error,
    };
  });
  const present = new Set(rows.map((row) => row.servicePlanId));
  return {
    rows,
    orphanBindings: bindings.filter((entry) => !present.has(entry.servicePlanId)).map(clone),
    serviceOptions: [
      ...listOf(context.services).filter((s) => s?.id !== undefined && s?.id !== null).map((s) => ({ serviceId: String(s.id), kind: "standard", name: isText(s.name) ? s.name : null })),
      ...listOf(context.throughServices).filter((s) => s?.throughServiceId !== undefined && s?.throughServiceId !== null).map((s) => ({ serviceId: String(s.throughServiceId), kind: "through", name: isText(s.name) ? s.name : null })),
    ].sort((a, b) => cmp(a.serviceId, b.serviceId)),
    counts: Object.fromEntries(Object.keys(READINESS_LABEL).map((name) => [name, rows.filter((row) => row.readiness === name).length])),
  };
}

const el = (doc, tag, props = {}, ...kids) => { const node = doc.createElement(tag); Object.assign(node, props); node.append(...kids); if ("value" in props) node.value = props.value; return node; };
const text = (doc, tag, className, value) => el(doc, tag, { className, textContent: value });
const metric = (doc, label, value) => el(doc, "div", { className: "svcplan-metric" }, text(doc, "span", "", label), text(doc, "b", "", value));

export function mountServicePlanManagementPanel({ container, runtime, getServicePlans, getPrescreenContext = null, onChange = () => {} } = {}) {
  if (!container) throw new Error("A service plan management container is required");
  if (typeof getServicePlans !== "function") throw new Error("getServicePlans() returning the map service plans is required");
  if (!runtime || typeof runtime.report !== "function" || !("operationalState" in runtime)) throw new Error("A ScenarioRuntime with report() and operationalState is required");
  const doc = container.ownerDocument ?? document;
  let bindingDoc = newBindingDoc();
  let view = null;
  let error = null;
  let notice = null;

  // Everything below is read: the map plans from the host, services / pools from the runtime report, vehicle orders and the line
  // technical specifications from the host (what the host does not give is `undefined`, which E1 reads as unknown, not as none).
  function readContext() {
    const report = runtime.report();
    const given = typeof getPrescreenContext === "function" ? (getPrescreenContext() ?? {}) : {};
    return {
      operationalState: runtime.operationalState ?? null,
      services: listOf(report?.services),
      throughServices: listOf(report?.throughServices),
      prescreenContext: { operatingResourcePools: report?.operatingResourcePools, vehicleOrders: runtime.game?.vehicleOrders, ...given },
    };
  }

  function recompute() {
    error = null;
    try { view = buildServicePlanPanelView({ servicePlans: getServicePlans(), doc: bindingDoc, context: readContext() }); }
    catch (e) { view = null; error = message(e); }
  }

  function bindPlan(row, serviceId) {
    bindingDoc.bindings = bindingDoc.bindings.filter((entry) => entry.servicePlanId !== row.servicePlanId);
    if (serviceId) bindingDoc.bindings.push({ servicePlanId: row.servicePlanId, serviceId, servicePlanRevision: row.servicePlanRevision });
    bindingDoc.bindings.sort((a, b) => cmp(a.servicePlanId, b.servicePlanId));
    notice = serviceId ? `계획 ${row.servicePlanId} 를 서비스 ${serviceId} 에 연결함` : `계획 ${row.servicePlanId} 의 연결을 해제함`;
    refresh();
    onChange();
  }

  function dropOrphan(servicePlanId) {
    bindingDoc.bindings = bindingDoc.bindings.filter((entry) => entry.servicePlanId !== servicePlanId);
    notice = `지도에 없는 계획 ${servicePlanId} 의 연결을 지움`;
    refresh();
    onChange();
  }

  function refresh() {
    recompute();
    const children = [text(doc, "p", "svcplan-notice", SCOPE_NOTICE), text(doc, "p", "svcplan-notice svcplan-id-notice", ID_KIND_NOTICE)];
    if (error) children.push(text(doc, "div", "svcplan-error", error));
    if (notice) children.push(text(doc, "div", "svcplan-notice", notice));
    if (view) children.push(...viewSection(view));
    container.replaceChildren(...children);
  }

  function viewSection(v) {
    const nodes = [el(doc, "div", { className: "svcplan-metrics" }, metric(doc, "지도 계획", String(v.rows.length)),
      ...Object.entries(READINESS_LABEL).map(([name, label]) => metric(doc, label, String(v.counts[name]))))];
    if (!v.rows.length) nodes.push(text(doc, "p", "svcplan-empty", "지도에 서비스 계획이 없습니다. 지도에서 서비스 계획을 그리고 저장하세요."));
    for (const row of v.rows) nodes.push(card(row, v));
    if (v.orphanBindings.length) {
      nodes.push(text(doc, "strong", "svcplan-section", `지도에 없는 계획의 연결 ${v.orphanBindings.length}개 (저장 문서에는 그대로 남음)`));
      for (const orphan of v.orphanBindings) {
        const drop = el(doc, "button", { type: "button", textContent: "연결 지우기" });
        drop.addEventListener("click", () => dropOrphan(orphan.servicePlanId));
        nodes.push(el(doc, "div", { className: "svcplan-orphan" }, text(doc, "span", "", `계획 ${orphan.servicePlanId} → 서비스 ${orphan.serviceId}`), drop));
      }
    }
    return nodes;
  }

  function card(row, v) {
    const node = el(doc, "div", { className: `svcplan-card ${row.readiness}` });
    node.append(el(doc, "div", { className: "svcplan-head" }, text(doc, "b", "svcplan-title", row.name ?? row.servicePlanId ?? "(ID 없는 계획)"), text(doc, "span", "svcplan-name-note", row.name ? "(이름은 표시용입니다)" : "")));
    node.append(
      el(doc, "div", { className: "svcplan-id svcplan-id-plan" }, text(doc, "span", "svcplan-id-kind", "지도 계획 ID (설계 문서)"), text(doc, "code", "", valueText(row.servicePlanId))),
      el(doc, "div", { className: "svcplan-id svcplan-id-service" }, text(doc, "span", "svcplan-id-kind", "개통 서비스 ID (경영 서비스)"),
        text(doc, "code", "", row.serviceId ?? "연결 안 됨"), row.serviceKind === "through" ? text(doc, "span", "svcplan-note", "직통 서비스") : row.serviceKind === "missing" ? text(doc, "span", "svcplan-warning", "지금 경영에 없는 서비스") : text(doc, "span", "", "")),
    );
    node.append(text(doc, "div", "svcplan-facts", `활성 ${row.active === null ? "미상" : row.active ? "예" : "아니오"} · 지도 revision ${valueText(row.revisionState)} · 용량 application ${valueText(row.capacityApplicationState)} · 운행 방식 ${valueText(row.operatingPattern)} · 시간대 ${valueText(row.bandCount)}개 · 방향 ${valueText(row.directionCount)}개`));
    node.append(bindControl(row, v));
    if (row.bindingRevisionChanged) node.append(text(doc, "div", "svcplan-warning", "연결한 뒤 지도 계획이 바뀜 — 이 연결이 아직 맞는지 확인하세요 (연결은 그대로 유지됨)"));
    if (row.sharedWithServicePlanIds.length) node.append(text(doc, "div", "svcplan-warning", `같은 서비스에 다른 계획도 연결됨: ${row.sharedWithServicePlanIds.join(", ")}`));
    node.append(text(doc, "div", `svcplan-readiness ${row.readiness}`, READINESS_LABEL[row.readiness] ?? row.readiness));
    if (row.error) node.append(text(doc, "div", "svcplan-error", `확인 실패: ${row.error}`));
    if (row.adaptation) node.append(...adaptationSection(row.adaptation, row), ...prescreenSection(row.adaptation.prescreen));
    return node;
  }

  function bindControl(row, v) {
    const options = [["", "(연결 안 함)"], ...v.serviceOptions.map((o) => [o.serviceId, `${o.serviceId} · ${o.kind === "through" ? "직통 서비스" : "일반 서비스"}${o.name ? ` · ${o.name}` : ""}`])];
    if (row.serviceId && !options.some(([value]) => value === row.serviceId)) options.push([row.serviceId, `${row.serviceId} · 지금 경영에 없음`]);
    const select = el(doc, "select", { className: "svcplan-bind", value: row.serviceId ?? "" }, ...options.map(([value, label]) => el(doc, "option", { value, textContent: label })));
    select.addEventListener("change", () => bindPlan(row, select.value === "" ? null : select.value));
    return el(doc, "label", { className: "svcplan-field" }, text(doc, "span", "", "연결할 개통 서비스"), select);
  }

  // C1 — copied as given: its status and its reasons, nothing re-judged here
  function adaptationSection(adaptation, row) {
    const nodes = [text(doc, "div", `svcplan-adapter ${adaptation.status}`, `시간표 변환 확인(C1): ${adaptation.status} — ${READINESS_LABEL[adaptation.status] ?? adaptation.status}`)];
    if (row.serviceId && adaptation.operationalLineId !== null) nodes.push(text(doc, "div", "svcplan-fact", `서비스의 실제 운행선 ${adaptation.operationalLineId}`));
    for (const issue of listOf(adaptation.issues)) nodes.push(text(doc, "div", "svcplan-issue", issueText(issue)));
    if (adaptation.status === "ready" && row.readiness !== "ready") nodes.push(text(doc, "div", "svcplan-note", "변환은 가능하지만 위 연결 문제 때문에 심사에 넘기지 않습니다."));
    return nodes;
  }

  // E1 — one chip per area; every non-possible check is listed with its engine reason
  function prescreenSection(prescreen) {
    if (!prescreen) return [];
    const nodes = [text(doc, "div", "svcplan-section", "사전심사(E1) — 전체 " + (VERDICT_LABEL[prescreen.verdict] ?? prescreen.verdict) + ` (${prescreen.verdict})`)];
    nodes.push(el(doc, "div", { className: "svcplan-areas" }, ...AREAS.map((area) => {
      const verdict = prescreen.areas?.[area] ?? "unknown";
      return el(doc, "span", { className: `svcplan-area ${area} ${verdict}` }, text(doc, "span", "", AREA_LABEL[area]), text(doc, "b", "", `${VERDICT_LABEL[verdict] ?? verdict} (${verdict})`));
    })));
    for (const area of AREAS) {
      for (const check of listOf(prescreen.checks).filter((entry) => entry.area === area && entry.status !== "possible")) {
        nodes.push(text(doc, "div", `svcplan-check ${check.status} ${area}`, `${AREA_LABEL[area]} · ${check.checkId} · ${VERDICT_LABEL[check.status] ?? check.status} (${check.status})${check.reason ? ` · ${check.reason}` : ""}`));
      }
    }
    nodes.push(text(doc, "div", "svcplan-note", `${PRESCREEN_NOTICE} 시간표 심사로 미루는 항목: ${listOf(prescreen.deferredToB13).join(", ")}`));
    return nodes;
  }

  refresh();
  return {
    refresh,
    serialize: () => serializeBindingDoc(bindingDoc),
    // -> { ok, issues }. A refused document leaves the current bindings untouched. No engine call.
    loadDoc(input) {
      const { doc: loaded, issues } = restoreBindingDoc(input);
      if (!loaded) return { ok: false, issues };
      bindingDoc = loaded; notice = null;
      refresh();
      return { ok: true, issues: [] };
    },
    get document() { return clone(bindingDoc); },
    // copies of what is on screen, for the host (Codex E2) and tests
    results: () => (view ? clone(view.rows) : []),
    readyPlans: () => (view ? view.rows.filter((row) => row.readiness === "ready").map((row) => ({ servicePlanId: row.servicePlanId, serviceId: row.serviceId, operationalRequest: clone(row.adaptation.operationalRequest) })) : []),
  };
}
