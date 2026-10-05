import { REPLACEMENT_BUS_CLASSES, REPLACEMENT_BUS_PROCUREMENT } from "./rail-replacement-operations.mjs";

const GEOMETRY_SCHEMA = "transitline.rail-replacement-transport-geometry/1";
const key = (value) => String(value);
const yen = new Intl.NumberFormat("ja-JP", { style: "currency", currency: "JPY", maximumFractionDigits: 0 });

function isCurrentGeometry(geometry) {
  return geometry?.schema === GEOMETRY_SCHEMA && geometry.contractVersion === 1
    && typeof geometry.replacementGeometryId === "string"
    && typeof geometry.replacementGeometryRevision === "string"
    && typeof geometry.eventId === "string"
    && Array.isArray(geometry.routeCandidates) && geometry.routeCandidates.length > 0;
}

function geometryView(geometry) {
  return {
    id: key(geometry.replacementGeometryId), revision: key(geometry.replacementGeometryRevision), eventId: key(geometry.eventId),
    controlOrderHint: geometry.controlOrderId === null || geometry.controlOrderId === undefined ? null : key(geometry.controlOrderId),
    routeCount: geometry.routeCandidates.length,
    routes: geometry.routeCandidates.filter((route) => route?.routeId !== undefined && route?.routeId !== null)
      .map((route) => ({ id: key(route.routeId), lengthMeters: Number.isFinite(route.lengthMeters) ? route.lengthMeters : null })),
  };
}

function operationView(operation) {
  return {
    id: key(operation.id), status: operation.status, eventId: key(operation.eventId), controlOrderId: key(operation.controlOrderId),
    routeId: operation.routeId === null || operation.routeId === undefined ? null : key(operation.routeId),
    vehicleClassId: operation.vehicleClassId, procurementStrategyId: operation.procurementStrategyId, vehicleCount: operation.vehicleCount,
    headwaySeconds: operation.headwaySeconds, passengersCarried: operation.passengersCarried, vehicleKilometres: operation.vehicleKilometres,
    mobilisationCostJPY: operation.mobilisationCostJPY, settledOperatingCostJPY: operation.settledOperatingCostJPY,
    assumptions: [...(operation.assumptions ?? [])],
  };
}

// Pure presentation state. M8 geometry remains map-owned; the engine re-assesses it at start.
export function buildRailReplacementManagementView({ geometries = [], operations = [] } = {}) {
  return {
    geometryOptions: geometries.filter(isCurrentGeometry).map(geometryView),
    hasGeometryInput: geometries.some(isCurrentGeometry),
    busClasses: Object.values(REPLACEMENT_BUS_CLASSES).map(({ id, label, passengerCapacity, widthMeters }) => ({ id, label, passengerCapacity, widthMeters })),
    procurementStrategies: Object.values(REPLACEMENT_BUS_PROCUREMENT).map(({ id, label, mobilizationMinutes }) => ({ id, label, mobilizationMinutes })),
    operations: operations.map(operationView),
  };
}

const statusText = (status) => ({ mobilising: "차량 동원 중", active: "운행 중", ending: "철수 중", ended: "종료" })[status] ?? status;
const verdictText = (verdict) => ({ feasible: "운행 가능", conditional: "확인 후 가능", infeasible: "운행 불가" })[verdict] ?? "사전 검토 필요";

function option(value, label) { const node = document.createElement("option"); node.value = value; node.textContent = label; return node; }
function row(label, control) { const node = document.createElement("label"); const name = document.createElement("span"); name.textContent = label; node.append(name, control); return node; }
function metric(label, value) { const node = document.createElement("div"); const name = document.createElement("span"); const number = document.createElement("b"); name.textContent = label; number.textContent = value; node.append(name, number); return node; }

export function mountRailReplacementManagementPanel({ container, runtime, getReplacementGeometries = () => [], onChange = () => {} } = {}) {
  if (!container) throw new Error("A rail replacement management container is required");
  if (!runtime?.assessRailReplacementOperation || !runtime?.startRailReplacementOperation || !runtime?.railReplacementOperationReport) throw new Error("A ScenarioRuntime with rail replacement operations is required");
  let geometryId = null;
  let routeId = null;
  let assessment = null;
  let assessmentError = null;
  const selectedGeometry = () => (getReplacementGeometries() ?? []).find((geometry) => isCurrentGeometry(geometry) && key(geometry.replacementGeometryId) === key(geometryId)) ?? null;
  const request = () => {
    const geometry = selectedGeometry();
    if (!geometry || !routeId) return null;
    return {
      eventId: geometry.eventId,
      controlOrderId: container.querySelector("[data-replacement-control-order]")?.value.trim() || geometry.controlOrderId || null,
      replacementGeometry: geometry, replacementGeometryRevision: geometry.replacementGeometryRevision, routeId,
      vehicleClassId: container.querySelector("[data-replacement-bus-class]")?.value,
      procurementStrategyId: container.querySelector("[data-replacement-procurement]")?.value,
      vehicleCount: Number(container.querySelector("[data-replacement-vehicle-count]")?.value),
      confirmUnknownRoadFacts: container.querySelector("[data-replacement-confirm-road]")?.checked === true,
      confirmSpatialConstraints: container.querySelector("[data-replacement-confirm-spatial]")?.checked === true,
    };
  };
  const assess = () => {
    assessment = null; assessmentError = null;
    const input = request();
    if (!input) return;
    try { assessment = runtime.assessRailReplacementOperation(input); }
    catch (error) { assessmentError = error instanceof Error ? error.message : String(error); }
  };
  const refresh = () => {
    const model = buildRailReplacementManagementView({ geometries: getReplacementGeometries() ?? [], operations: runtime.railReplacementOperationReport() });
    if (!model.geometryOptions.some((entry) => entry.id === geometryId)) geometryId = model.geometryOptions[0]?.id ?? null;
    const selected = model.geometryOptions.find((entry) => entry.id === geometryId);
    if (!selected?.routes.some((entry) => entry.id === routeId)) routeId = selected?.routes[0]?.id ?? null;
    container.replaceChildren();
    const intro = document.createElement("p"); intro.className = "rail-replacement-intro";
    intro.textContent = model.hasGeometryInput ? "지도 경로의 도로·정류장 사실을 엔진이 다시 검사합니다. 미확인 사실은 명시적으로 확인해야 출발할 수 있습니다." : "아직 지도에서 확정된 대체수송 경로(M8)가 없습니다. 부분 운휴·회차를 선택한 뒤 대체버스 경로를 작성해야 합니다.";
    container.append(intro);
    if (model.hasGeometryInput) {
      const form = document.createElement("div"); form.className = "rail-replacement-form";
      const geometry = document.createElement("select");
      for (const entry of model.geometryOptions) geometry.append(option(entry.id, `${entry.id} · 경로 ${entry.routeCount}개`));
      geometry.value = geometryId; geometry.addEventListener("change", () => { geometryId = geometry.value; routeId = null; assessment = null; assessmentError = null; refresh(); });
      form.append(row("지도 계획", geometry));
      const order = document.createElement("input"); order.type = "text"; order.dataset.replacementControlOrder = "true"; order.placeholder = "활성 관제명령 ID"; order.value = selected?.controlOrderHint ?? "";
      form.append(row("관제명령", order));
      const route = document.createElement("select");
      for (const entry of selected?.routes ?? []) route.append(option(entry.id, `${entry.id}${entry.lengthMeters === null ? "" : ` · ${(entry.lengthMeters / 1000).toFixed(1)} km`}`));
      route.value = routeId ?? ""; route.addEventListener("change", () => { routeId = route.value; assessment = null; assessmentError = null; }); form.append(row("대체 경로", route));
      const bus = document.createElement("select"); bus.dataset.replacementBusClass = "true";
      for (const entry of model.busClasses) bus.append(option(entry.id, `${entry.label} · ${entry.passengerCapacity}명 · 폭 ${entry.widthMeters}m`)); form.append(row("차량", bus));
      const procurement = document.createElement("select"); procurement.dataset.replacementProcurement = "true";
      for (const entry of model.procurementStrategies) procurement.append(option(entry.id, `${entry.label} · ${entry.mobilizationMinutes}분`)); form.append(row("조달", procurement));
      const count = document.createElement("input"); count.type = "number"; count.min = "1"; count.max = "100"; count.value = "2"; count.dataset.replacementVehicleCount = "true"; form.append(row("투입 대수", count));
      for (const [attribute, label] of [["replacementConfirmRoad", "도로·정류장 결측을 확인함"], ["replacementConfirmSpatial", "공간 제약 후보를 확인함"]]) {
        const check = document.createElement("label"); check.className = "rail-replacement-check"; const input = document.createElement("input"); input.type = "checkbox";
        input.dataset[attribute] = "true"; const text = document.createElement("span"); text.textContent = label; check.append(input, text); form.append(check);
      }
      const actions = document.createElement("div"); actions.className = "rail-replacement-actions";
      const assessButton = document.createElement("button"); assessButton.type = "button"; assessButton.textContent = "운행 사전검토"; assessButton.addEventListener("click", () => { assess(); refresh(); });
      const startButton = document.createElement("button"); startButton.type = "button"; startButton.textContent = "대체수송 시작"; startButton.disabled = assessment?.verdict !== "feasible";
      startButton.addEventListener("click", () => { const input = request(); if (!input) return; try { runtime.startRailReplacementOperation(input); assessment = null; assessmentError = null; onChange(); refresh(); } catch (error) { assessmentError = error instanceof Error ? error.message : String(error); refresh(); } });
      actions.append(assessButton, startButton); form.append(actions); container.append(form);
      if (assessment || assessmentError) {
        const result = document.createElement("div"); result.className = `rail-replacement-assessment ${assessment?.verdict ?? "error"}`;
        if (assessmentError) result.textContent = assessmentError;
        else { const title = document.createElement("strong"); title.textContent = verdictText(assessment.verdict); const facts = document.createElement("div"); facts.className = "rail-replacement-metrics"; facts.append(metric("배차", `${Math.ceil(assessment.headwaySeconds / 60)}분`), metric("편도 수송력", `${Math.floor(assessment.passengerCapacityPerHourPerDirection)}명/시간`), metric("동원비", yen.format(assessment.mobilisationCostJPY)), metric("시간당", yen.format(assessment.operatingCostJPYPerHour))); result.append(title, facts); const notes = [...assessment.failures, ...assessment.confirmations]; if (notes.length) { const note = document.createElement("small"); note.textContent = notes.join(", "); result.append(note); } }
        container.append(result);
      }
    }
    const title = document.createElement("strong"); title.className = "rail-replacement-operations-title"; title.textContent = `대체수송 ${model.operations.length}건`; container.append(title);
    for (const operation of model.operations) { const card = document.createElement("article"); card.className = `rail-replacement-operation ${operation.status}`; const name = document.createElement("b"); name.textContent = `${statusText(operation.status)} · ${operation.routeId ?? operation.id}`; const facts = document.createElement("div"); facts.className = "rail-replacement-metrics"; facts.append(metric("차량", `${operation.vehicleClassId} ${operation.vehicleCount}대`), metric("수송", `${operation.passengersCarried}명`), metric("주행", `${operation.vehicleKilometres.toFixed(1)}km`), metric("정산", yen.format(operation.settledOperatingCostJPY))); card.append(name, facts); container.append(card); }
    const settle = document.createElement("button"); settle.type = "button"; settle.className = "rail-replacement-settle"; settle.textContent = "누적 운행비 정산"; settle.disabled = !model.operations.some((operation) => ["mobilising", "active", "ending"].includes(operation.status));
    settle.addEventListener("click", () => { try { runtime.settleRailReplacementOperations(); onChange(); refresh(); } catch (error) { assessmentError = error instanceof Error ? error.message : String(error); refresh(); } }); container.append(settle);
  };
  refresh();
  return { refresh };
}
