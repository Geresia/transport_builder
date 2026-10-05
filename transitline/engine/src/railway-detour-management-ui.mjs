// Management panel for a railway detour over another company's track (B14-M11): review -> authorise -> start a temporary
// operation. It consumes the M10 output (RailwayDetourServiceGeometry + the player's picks) and talks to the engine only
// through five ScenarioRuntime methods. It never judges, prices or times anything: verdicts, costs and accruals are shown
// exactly as the engine returned them, and no approval, operation or money is stored here (the integrated save is the only truth).
import { VEHICLE_MODELS } from "./management/rolling-stock.mjs";

const DETOUR_SCHEMA = "transitline.railway-detour-service-geometry/1";
const key = (value) => String(value);
const planKey = (eventId, candidateId) => `${eventId}|${candidateId}`;
const yen = new Intl.NumberFormat("ja-JP", { style: "currency", currency: "JPY", maximumFractionDigits: 0 });

export const MAP_NOTICE = "지도에서 그린 선은 접속 사실(true/false/null)을 바꾸지 않습니다. 접속·소유·호환성은 원자료 그대로 엔진이 판정합니다.";
export const OPERATION_NOTICE = "실제 시간표·열차 경로는 M5~M7 연결 뒤에 확장됩니다. 지금의 임시 운행은 승인된 우회의 누적 운행거리·운행비·선로사용료만 엔진이 기록합니다.";
export const CONNECTION_LABELS = Object.freeze({ true: "● 접속 확인(true)", false: "✕ 물리적으로 분리(false)", null: "? 접속 미확인(null)" });
const VERDICT_LABELS = Object.freeze({ possible: "승인 가능", conditional: "조건부", unknown: "정보 부족", impossible: "불가" });
const OPERATION_STATUS = Object.freeze({ active: "운행 중", ended: "종료" });
const AUTHORIZATION_STATUS = Object.freeze({ authorized: "승인됨", ended: "종료" });
const END_REASONS = Object.freeze({ "disruption-or-control-ended": "장애 또는 관제명령 종료", "disruption-ended": "장애 종료", "control-order-ended": "관제명령 종료" });

const isCurrentDetour = (g) => g?.schema === DETOUR_SCHEMA && g.contractVersion === 1
  && typeof g.eventId === "string" && typeof g.detourGeometryId === "string" && typeof g.detourGeometryRevision === "string";
const known = (v) => Number.isFinite(v) ? v : null;
const km = (m) => (known(m) === null ? "미상" : `${(m / 1000).toFixed(1)} km`);
const count = (list) => (Array.isArray(list) ? list.length : 0);
const connectionState = (value) => (value === true ? "true" : value === false ? "false" : "null");

function detourView(geometry, picks) {
  const pick = picks?.[planKey(geometry.eventId, geometry.selectedDetourCandidateId ?? "")] ?? null;
  return {
    id: key(geometry.detourGeometryId), revision: key(geometry.detourGeometryRevision), eventId: key(geometry.eventId),
    candidateId: geometry.selectedDetourCandidateId ?? null,
    // The M9 geometry carries no control order; a hint is shown only if a future producer adds one.
    controlOrderHint: geometry.controlOrderId === null || geometry.controlOrderId === undefined ? null : key(geometry.controlOrderId),
    lengthMeters: known(geometry.lengthMeters),
    legCount: count(geometry.legs), pickedLegCount: count(pick?.legIds),
    connections: (geometry.connections ?? []).map((c) => ({ id: key(c.connectionId), state: connectionState(c.physicalConnection), gapMeters: known(c.gapMeters) })),
    pickedConnectionCount: count(pick?.connectionIds),
  };
}

// Pure presentation state. Nothing is derived beyond picking the fields to show.
export function buildRailwayDetourManagementView({ detours = [], picks = {}, authorizations = [], operations = [] } = {}) {
  return {
    detourOptions: detours.filter(isCurrentDetour).map((g) => detourView(g, picks)),
    hasDetourInput: detours.some(isCurrentDetour),
    vehicleModels: Object.values(VEHICLE_MODELS).map(({ id, cars, capacity }) => ({ id, cars, capacity })),
    authorizations: authorizations.map((a) => ({
      id: key(a.id), status: a.status, eventId: key(a.eventId), controlOrderId: key(a.controlOrderId), detourGeometryRevision: key(a.detourGeometryRevision),
      vehicleModelId: a.vehicleModelId, trainsPerHour: a.trainsPerHour, detourLengthMeters: known(a.detourLengthMeters), endReason: a.endReason ?? null,
    })),
    operations: operations.map((o) => ({
      id: key(o.id), status: o.status, authorizationId: key(o.authorizationId), detourLengthMeters: known(o.detourLengthMeters), endReason: o.endReason ?? null,
      accruedTrainKilometres: o.accruedTrainKilometres, accruedTrainMinutes: o.accruedTrainMinutes,
      settledOperatingCostJPY: o.settledOperatingCostJPY, settledAccessCostJPY: o.settledAccessCostJPY,
    })),
  };
}

const message = (error) => (error instanceof Error ? error.message : String(error));
// value is applied after the children: a <select> ignores a value whose <option> does not exist yet
function el(doc, tag, props = {}, ...kids) { const node = doc.createElement(tag); Object.assign(node, props); node.append(...kids); if ("value" in props) node.value = props.value; return node; }
const text = (doc, tag, className, value) => el(doc, tag, { className, textContent: value });
const labelled = (doc, label, control) => el(doc, "label", { className: "detour-field" }, text(doc, "span", "", label), control);
const metric = (doc, label, value) => el(doc, "div", { className: "detour-metric" }, text(doc, "span", "", label), text(doc, "b", "", value));

export function mountRailwayDetourManagementPanel({ container, runtime, getDetourOutput = () => null, getExternalInfrastructureCatalog = () => null, getTrackAccessAgreements, onChange = () => {} } = {}) {
  if (!container) throw new Error("A railway detour management container is required");
  for (const method of ["assessRailwayDetourAuthorization", "authorizeRailwayDetour", "railwayDetourAuthorizationReport", "startRailwayDetourOperation", "railwayDetourOperationReport"]) {
    if (typeof runtime?.[method] !== "function") throw new Error(`A ScenarioRuntime with ${method} is required`);
  }
  const doc = container.ownerDocument ?? document;
  // Form state lives only in this closure; engine facts are re-read on every refresh.
  const form = { selected: null, controlOrderId: "", vehicleModelId: null, trainsPerHour: "6", agreementIds: new Set(), confirmUnknownConnections: false, confirmConditionalTechnical: false, startAuthorizationId: null };
  let assessment = null;
  let error = null;
  let notice = null;

  const output = () => getDetourOutput() ?? {};
  const detours = () => output().export?.detours ?? [];
  const selectedGeometry = () => detours().find((g) => isCurrentDetour(g) && key(g.detourGeometryId) === form.selected) ?? null;
  const agreements = () => (typeof getTrackAccessAgreements === "function" ? getTrackAccessAgreements() ?? [] : []);
  const request = () => {
    const geometry = selectedGeometry();
    if (!geometry) return null;
    const input = {
      eventId: geometry.eventId, controlOrderId: form.controlOrderId.trim(), detourGeometry: structuredClone(geometry), detourGeometryRevision: geometry.detourGeometryRevision,
      picks: structuredClone(output().picks?.[planKey(geometry.eventId, geometry.selectedDetourCandidateId ?? "")] ?? {}),
      vehicleModelId: form.vehicleModelId, trainsPerHour: Number(form.trainsPerHour), trackAccessAgreementIds: [...form.agreementIds],
      confirmUnknownConnections: form.confirmUnknownConnections, confirmConditionalTechnical: form.confirmConditionalTechnical,
      externalInfrastructureCatalog: getExternalInfrastructureCatalog() ?? null,
    };
    // Omitted when no getter is wired, so the runtime falls back to its own agreements.
    if (typeof getTrackAccessAgreements === "function") input.trackAccessAgreements = structuredClone(agreements());
    return input;
  };
  const invalidate = () => { assessment = null; error = null; notice = null; };
  const act = (fn) => { try { fn(); } catch (e) { notice = null; error = message(e); } refresh(); };
  // Typing must not rebuild the form (focus), so an edit only clears the result area and disables approval.
  let approveButton = null;
  const result = el(doc, "div", { className: "detour-result" });
  const renderResult = () => {
    result.replaceChildren(...[error && text(doc, "div", "detour-error", error), notice && text(doc, "div", "detour-notice", notice), assessment && assessmentNode(assessment)].filter(Boolean));
    if (approveButton) approveButton.disabled = assessment?.verdict !== "possible";
  };
  const edited = () => { invalidate(); renderResult(); };

  function refresh() {
    const out = output();
    const view = buildRailwayDetourManagementView({ detours: detours(), picks: out.picks ?? {}, authorizations: runtime.railwayDetourAuthorizationReport(), operations: runtime.railwayDetourOperationReport() });
    if (!view.detourOptions.some((d) => d.id === form.selected)) { form.selected = view.detourOptions[0]?.id ?? null; form.controlOrderId = view.detourOptions[0]?.controlOrderHint ?? ""; invalidate(); }
    const selected = view.detourOptions.find((d) => d.id === form.selected) ?? null;
    if (assessment && selected && assessment.detourGeometryRevision !== selected.revision) invalidate();
    if (!view.vehicleModels.some((m) => m.id === form.vehicleModelId)) form.vehicleModelId = view.vehicleModels[0]?.id ?? null;
    const authorized = view.authorizations.filter((a) => a.status === "authorized");
    if (!authorized.some((a) => a.id === form.startAuthorizationId)) form.startAuthorizationId = authorized[0]?.id ?? null;

    const children = [text(doc, "p", "detour-notice", MAP_NOTICE)];
    if (!view.hasDetourInput) children.push(text(doc, "p", "detour-empty", "지도에서 확정된 우회 경로(M10)가 없습니다. 우회 후보를 선택하고 구간·접속을 고르면 여기서 검토할 수 있습니다."));
    else children.push(...detourSection(view, selected));
    children.push(...authorizationSection(view, authorized), ...operationSection(view));
    container.replaceChildren(...children);
  }

  function detourSection(view, selected) {
    const nodes = [];
    const pickDetour = el(doc, "select", { value: form.selected }, ...view.detourOptions.map((d) => el(doc, "option", { value: d.id, textContent: `${d.eventId} · ${d.id}` })));
    pickDetour.addEventListener("change", () => { form.selected = pickDetour.value; form.controlOrderId = view.detourOptions.find((d) => d.id === form.selected)?.controlOrderHint ?? ""; invalidate(); refresh(); });
    nodes.push(labelled(doc, "우회 계획", pickDetour));
    const facts = el(doc, "div", { className: "detour-metrics" }, metric(doc, "이벤트", selected.eventId), metric(doc, "관제명령", form.controlOrderId || "미입력"), metric(doc, "geometry revision", selected.revision),
      metric(doc, "우회 거리", km(selected.lengthMeters)), metric(doc, "선택 구간", `${selected.pickedLegCount}/${selected.legCount}`), metric(doc, "선택 접속", `${selected.pickedConnectionCount}/${selected.connections.length}`));
    nodes.push(facts);
    if (!selected.connections.length) nodes.push(text(doc, "p", "detour-empty", "이 우회에는 접속 기록이 없습니다."));
    for (const c of selected.connections) nodes.push(text(doc, "div", `detour-connection state-${c.state}`, `${c.id} · ${CONNECTION_LABELS[c.state]} · 간격 ${c.gapMeters === null ? "미상" : `${c.gapMeters} m`}`));

    const order = el(doc, "input", { type: "text", placeholder: "활성 관제명령 ID", value: form.controlOrderId });
    order.addEventListener("input", () => { form.controlOrderId = order.value; edited(); });
    const model = el(doc, "select", { value: form.vehicleModelId }, ...view.vehicleModels.map((m) => el(doc, "option", { value: m.id, textContent: `${m.id} · ${m.cars}량 · ${m.capacity}명` })));
    model.addEventListener("change", () => { form.vehicleModelId = model.value; invalidate(); refresh(); });
    const trains = el(doc, "input", { type: "number", min: "1", value: form.trainsPerHour });
    trains.addEventListener("input", () => { form.trainsPerHour = trains.value; edited(); });
    nodes.push(labelled(doc, "관제명령", order), labelled(doc, "차량 모델", model), labelled(doc, "시간당 운행횟수", trains));

    const list = agreements();
    if (list.length) {
      nodes.push(text(doc, "div", "detour-label", "선로사용 계약"));
      for (const a of list) {
        const box = el(doc, "input", { type: "checkbox", checked: form.agreementIds.has(key(a.id)) });
        box.addEventListener("change", () => { box.checked ? form.agreementIds.add(key(a.id)) : form.agreementIds.delete(key(a.id)); invalidate(); refresh(); });
        nodes.push(el(doc, "label", { className: "detour-check" }, box, text(doc, "span", "", `${a.id} · ${a.infrastructureOwnerId} → ${a.guestOperatorId} · ${a.status}`)));
      }
    } else nodes.push(text(doc, "p", "detour-empty", "표시할 선로사용 계약이 없습니다. 필요한 계약이 하나뿐이면 엔진이 자동으로 맞춥니다."));
    for (const [field, label] of [["confirmUnknownConnections", "접속이 확인되지 않은 곳이 있음을 알고 진행함"], ["confirmConditionalTechnical", "조건부 기술호환 조건을 확인함"]]) {
      const box = el(doc, "input", { type: "checkbox", checked: form[field] });
      box.addEventListener("change", () => { form[field] = box.checked; invalidate(); refresh(); });
      nodes.push(el(doc, "label", { className: "detour-check" }, box, text(doc, "span", "", label)));
    }

    const assessButton = el(doc, "button", { type: "button", textContent: "사전 검토" });
    assessButton.addEventListener("click", () => act(() => { invalidate(); assessment = runtime.assessRailwayDetourAuthorization(request()); }));
    approveButton = el(doc, "button", { type: "button", textContent: "우회 승인" });
    approveButton.addEventListener("click", () => act(() => {
      if (assessment?.verdict !== "possible") return;
      const authorization = runtime.authorizeRailwayDetour(request());
      assessment = null; error = null; notice = `승인됨 · ${authorization.id} · geometry revision ${authorization.detourGeometryRevision}`;
      onChange();
    }));
    nodes.push(el(doc, "div", { className: "detour-actions" }, assessButton, approveButton));
    renderResult();
    nodes.push(result);
    return nodes;
  }

  function assessmentNode(result) {
    const box = el(doc, "div", { className: `detour-assessment ${result.verdict}` }, text(doc, "strong", "", VERDICT_LABELS[result.verdict] ?? result.verdict));
    box.append(el(doc, "div", { className: "detour-metrics" }, metric(doc, "geometry revision", key(result.detourGeometryRevision)), metric(doc, "우회 거리", km(result.detourLengthMeters)), metric(doc, "운행횟수", `${result.trainsPerHour}/시간`)));
    for (const [field, label] of [["violations", "위반"], ["missingInputs", "누락 정보"], ["conditions", "조건"]]) {
      const entries = result[field] ?? [];
      box.append(text(doc, "div", `detour-label detour-${field}`, `${label} ${entries.length}건`));
      for (const entry of entries) box.append(text(doc, "div", `detour-diag detour-${field}`, entry));
    }
    return box;
  }

  function authorizationSection(view, authorized) {
    const nodes = [text(doc, "strong", "detour-section", `우회 승인 ${view.authorizations.length}건`)];
    for (const a of view.authorizations) nodes.push(text(doc, "div", `detour-authorization ${a.status}`, `${AUTHORIZATION_STATUS[a.status] ?? a.status} · ${a.id} · ${a.controlOrderId} · ${a.vehicleModelId} ${a.trainsPerHour}/시간 · ${km(a.detourLengthMeters)} · revision ${a.detourGeometryRevision}${a.endReason ? ` · ${END_REASONS[a.endReason] ?? a.endReason}` : ""}`));
    const choice = el(doc, "select", { value: form.startAuthorizationId ?? "", disabled: !authorized.length }, ...authorized.map((a) => el(doc, "option", { value: a.id, textContent: a.id })));
    choice.addEventListener("change", () => { form.startAuthorizationId = choice.value; });
    const start = el(doc, "button", { type: "button", textContent: "임시 운행 시작", disabled: !authorized.length });
    start.addEventListener("click", () => act(() => {
      if (!form.startAuthorizationId) return;
      const operation = runtime.startRailwayDetourOperation({ authorizationId: form.startAuthorizationId });
      error = null; notice = `임시 운행 시작 · ${operation.id}`;
      onChange();
    }));
    nodes.push(labelled(doc, "승인된 우회", choice), start);
    return nodes;
  }

  function operationSection(view) {
    const nodes = [text(doc, "strong", "detour-section", `임시 운행 ${view.operations.length}건`), text(doc, "p", "detour-notice", OPERATION_NOTICE)];
    for (const o of view.operations) {
      nodes.push(el(doc, "article", { className: `detour-operation ${o.status}` },
        text(doc, "b", "", `${OPERATION_STATUS[o.status] ?? o.status} · ${o.id}${o.endReason ? ` · ${END_REASONS[o.endReason] ?? o.endReason}` : ""}`),
        el(doc, "div", { className: "detour-metrics" }, metric(doc, "승인", o.authorizationId), metric(doc, "우회 거리", km(o.detourLengthMeters)), metric(doc, "누적 열차-km", Number(o.accruedTrainKilometres).toFixed(1)),
          metric(doc, "정산된 운행비", yen.format(o.settledOperatingCostJPY)), metric(doc, "정산된 선로사용료", yen.format(o.settledAccessCostJPY)))));
    }
    return nodes;
  }

  refresh();
  return { refresh };
}
