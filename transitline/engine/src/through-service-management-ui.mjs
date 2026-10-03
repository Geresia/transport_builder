import { VEHICLE_MODELS, vehicleRetrofitRequirements } from "./management/index.mjs";

const yen = new Intl.NumberFormat("ko-KR", { notation: "compact", style: "currency", currency: "JPY", maximumFractionDigits: 1 });
const STATUS = Object.freeze({ draft: "초안", assessed: "심사 완료", approved: "승인·운행 가능", suspended: "운행 중단", terminated: "종료" });
const VERDICT = Object.freeze({ possible: "가능", conditional: "조건부", unknown: "자료 미상", impossible: "불가능" });

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

function latestBy(values, field) {
  return [...values].sort((a, b) => Number(b[field] ?? -1) - Number(a[field] ?? -1))[0] ?? null;
}

export function buildThroughServiceManagementView(report = {}) {
  const fares = report.throughFareAgreements ?? [];
  const retrofits = report.vehicleRetrofits ?? [];
  const bindings = report.throughOperationBindings ?? [];
  const settlements = report.throughOperatingSettlements ?? [];
  return (report.throughServices ?? []).map((service) => {
    const serviceFares = fares.filter((entry) => entry.throughServiceId === service.throughServiceId);
    const fare = serviceFares.find((entry) => entry.status !== "terminated") ?? latestBy(serviceFares, "terminatedAtMinute");
    const serviceRetrofits = retrofits.filter((entry) => entry.throughServiceId === service.throughServiceId);
    const retrofit = serviceRetrofits.find((entry) => !["approved", "cancelled"].includes(entry.status)) ?? latestBy(serviceRetrofits, "completedAtMinute");
    const binding = bindings.find((entry) => entry.throughServiceId === service.throughServiceId) ?? null;
    const latestSettlement = latestBy(settlements.filter((entry) => entry.throughServiceId === service.throughServiceId), "operatingDay");
    const requirements = vehicleRetrofitRequirements(service);
    const activeFare = fare?.status === "active";
    const operationBlockers = [];
    if (service.status !== "approved") operationBlockers.push("직통 서비스 승인 필요");
    if (!activeFare) operationBlockers.push("활성 연락운임 협정 필요");
    if (!binding) operationBlockers.push("지도 직통 운행선 연결 필요");
    return {
      service,
      fare,
      retrofit,
      binding,
      latestSettlement,
      requirements,
      operationBlockers,
      actions: {
        approve: service.status === "assessed" && service.assessment?.verdict === "possible",
        suspend: service.status === "approved",
        resume: service.status === "suspended",
        terminate: ["approved", "suspended"].includes(service.status),
        proposeFare: service.status !== "terminated" && !serviceFares.some((entry) => entry.status !== "terminated"),
        proposeRetrofit: service.operatorId === "player" && requirements.eligible === true && !serviceRetrofits.some((entry) => !["approved", "cancelled"].includes(entry.status)),
        commission: operationBlockers.length === 1 && operationBlockers[0] === "지도 직통 운행선 연결 필요",
      },
    };
  });
}

function button(label, action, disabled = false, className = "") {
  const node = el("button", className, label);
  node.type = "button";
  node.disabled = disabled;
  node.addEventListener("click", action);
  return node;
}

function metricGrid(rows) {
  const grid = el("div", "through-metrics");
  for (const [label, value] of rows) {
    const cell = el("div");
    cell.append(el("span", "", label), el("b", "", value));
    grid.append(cell);
  }
  return grid;
}

function fareParticipantGroups(service) {
  const groups = new Map();
  for (const leg of service.legs ?? []) {
    const operatorId = leg.infrastructureOwnerId ?? leg.operatorId ?? service.operatorId;
    const group = groups.get(operatorId) ?? { operatorId, legIds: [] };
    group.legIds.push(leg.legId);
    groups.set(operatorId, group);
  }
  return [...groups.values()].sort((a, b) => a.operatorId.localeCompare(b.operatorId));
}

export function mountThroughServiceManagementPanel({ container, runtime, getMapExport = () => null, getOperationDraft = () => null, onChange = () => {} }) {
  let notice = "지도 직통 경로와 경영 계약을 연결하면 실제 운행정산이 시작됩니다.";
  let noticeError = false;

  const run = (action, success) => {
    try {
      const result = action();
      notice = success?.(result) ?? success ?? "처리했습니다.";
      noticeError = false;
      onChange(result);
      render();
      return result;
    } catch (error) {
      notice = error.message;
      noticeError = true;
      render();
      return null;
    }
  };

  function renderRoutePlanner() {
    const section = el("section", "through-route-planner");
    section.append(el("strong", "", "직통 경로 계획"));
    let planning;
    try { planning = runtime.throughRoutePlanningReport(getMapExport()); }
    catch (error) {
      section.append(el("div", "through-error", error.message));
      return section;
    }
    const sources = planning.catalog.sources;
    const routes = planning.routes;
    if (routes.length) {
      const saved = el("div", "through-route-saved");
      for (const entry of routes) {
        const linked = (runtime.report().throughServices ?? []).some((service) => service.throughRouteId === entry.route.throughRouteId);
        const row = el("div");
        row.append(el("span", "", `${entry.route.name ?? entry.key} · ${entry.route.legs.length}구간 · ${entry.route.dataQuality}`));
        if (!linked) row.append(button("삭제", () => run(() => runtime.removeThroughRouteSelection(entry.key), "직통 경로 초안을 삭제했습니다."), false, "danger"));
        else row.append(el("small", "", "서비스 연결됨"));
        saved.append(row);
      }
      section.append(saved);
    }
    if (sources.length < 2) {
      section.append(el("div", "through-note", "선택할 노선이 2개 이상 필요합니다. 계획선을 그리거나 노선을 개통하세요."));
      return section;
    }
    const name = el("input"); name.placeholder = "경로 이름";
    const key = el("input");
    let sequence = routes.length + 1;
    while (routes.some((entry) => entry.key === `through-route-${sequence}`)) sequence += 1;
    key.value = `through-route-${sequence}`;
    const model = el("select");
    for (const vehicle of Object.values(VEHICLE_MODELS)) model.append(new Option(`${vehicle.id} · ${vehicle.cars}량`, vehicle.id));
    const frequency = el("input"); frequency.type = "number"; frequency.min = "0.1"; frequency.step = "0.5"; frequency.value = "4";
    const head = el("div", "through-route-fields");
    for (const [label, control] of [["이름", name], ["저장 키", key], ["차량", model], ["시간당 편성", frequency]]) {
      const wrap = el("label"); wrap.append(el("span", "", label), control); head.append(wrap);
    }
    section.append(head);
    const legsBox = el("div", "through-route-legs");
    const sourceLabel = (source) => {
      const kind = source.sourceKind === "existing" ? "개통" : source.sourceKind === "external" ? "외부" : "계획";
      const readiness = source.operationReady ? "운행연결" : source.sourceKind === "planned" ? "미건설" : "연결미완";
      return `[${kind}/${readiness}] ${source.name}`;
    };
    const addLeg = (preferred = null) => {
      const row = el("div", "through-route-leg-row");
      const sourceSelect = el("select");
      for (const source of sources) sourceSelect.append(new Option(sourceLabel(source), source.sourceId));
      if (preferred) sourceSelect.value = preferred;
      const direction = el("select");
      direction.append(new Option("정방향", "forward"), new Option("역방향", "reverse"));
      const remove = button("빼기", () => row.remove(), false, "danger");
      row.append(sourceSelect, direction, remove);
      legsBox.append(row);
    };
    addLeg(sources[0].sourceId);
    addLeg(sources[1].sourceId);
    const controls = el("div", "through-actions");
    controls.append(
      button("구간 추가", () => addLeg()),
      button("경로 심사 생성", () => {
        const legs = [...legsBox.children].map((row) => ({ sourceId: row.children[0].value, direction: row.children[1].value }));
        return run(() => runtime.createThroughServiceFromSelection({ key: key.value, name: name.value || key.value, legs }, getMapExport(), {
          operatorId: runtime.game.player.id,
          guestModelId: model.value,
          trainsPerHour: Number(frequency.value),
        }), (result) => `직통 경로 ${result.route.throughRouteId}의 기술·권리 심사를 생성했습니다.`);
      }),
    );
    section.append(legsBox, controls, el("div", "through-note", "외부선의 선로 접속·소유자·기술자료가 없으면 안전으로 가정하지 않고 자료 미상으로 심사됩니다."));
    return section;
  }

  function renderFare(card, row) {
    const { service, fare } = row;
    const section = el("section", "through-subcard");
    section.append(el("strong", "", "연락운임 협정"));
    if ((!fare || fare.status === "terminated") && row.actions.proposeFare) {
      if (fare?.status === "terminated") section.append(el("div", "through-note", `이전 협정 ${fare.id} 종료 · 새 협정 협상 가능`));
      const groups = fareParticipantGroups(service);
      const inputs = groups.map((group) => {
        const wrap = el("label", "through-fare-row");
        wrap.append(el("span", "", `${group.operatorId} · ${group.legIds.length}구간`));
        const input = el("input");
        input.type = "number";
        input.min = "0";
        input.step = "10";
        input.value = "180";
        wrap.append(input);
        section.append(wrap);
        return { group, input };
      });
      const discount = el("input");
      discount.type = "number";
      discount.min = "0";
      discount.step = "10";
      discount.value = "70";
      const discountRow = el("label", "through-fare-row");
      discountRow.append(el("span", "", "연락 할인 JPY"), discount);
      section.append(discountRow, button("협정안 제안", () => run(() => runtime.proposeThroughFareAgreement(service.throughServiceId, {
        collectingOperatorId: service.operatorId,
        participantTerms: inputs.map(({ group, input }) => ({ ...group, sectionFareJPY: Number(input.value) })),
        jointDiscountJPY: Number(discount.value),
      }), "연락운임 협정안을 만들었습니다. 각 참여사의 수락이 필요합니다.")));
    } else if (!fare) section.append(el("div", "through-note", "협정을 만들 수 없는 서비스 상태입니다."));
    else {
      section.append(metricGrid([
        ["상태", fare.status], ["승객 운임", yen.format(fare.passengerFareJPY)],
        ["구간운임 합", yen.format(fare.grossFareJPY)], ["공동 할인", yen.format(fare.jointDiscountJPY)],
      ]));
      const actions = el("div", "through-actions");
      if (["draft", "accepted"].includes(fare.status)) {
        for (const participant of fare.participants.filter((entry) => !fare.acceptedOperatorIds.includes(entry.operatorId))) actions.append(button(
          `${participant.operatorId} 수락 반영`,
          () => run(() => runtime.acceptThroughFareAgreement(fare.id, participant.operatorId), `${participant.operatorId}의 협정 수락을 반영했습니다.`),
        ));
      }
      if (fare.status === "accepted") actions.append(button("당국 신고", () => run(() => runtime.fileThroughFareAgreement(fare.id), "연락운임 협정을 당국에 신고했습니다.")));
      if (["filed", "suspended"].includes(fare.status) && service.status === "approved") actions.append(button("협정 발효", () => run(() => runtime.activateThroughFareAgreement(fare.id), "연락운임 협정이 발효됐습니다.")));
      if (fare.status === "active") actions.append(button("운임협정 중단", () => run(() => runtime.setThroughFareAgreementStatus(fare.id, "suspended"), "운임협정을 중단해 실제 직통열차도 정지했습니다.")));
      if (fare.status !== "terminated") actions.append(button("협정 종료", () => run(() => runtime.setThroughFareAgreementStatus(fare.id, "terminated"), "연락운임 협정을 종료했습니다."), false, "danger"));
      section.append(actions);
    }
    card.append(section);
  }

  function renderRetrofit(card, row) {
    const { service, retrofit, requirements } = row;
    const section = el("section", "through-subcard");
    section.append(el("strong", "", "직통 차량 개조"));
    if (retrofit) {
      section.append(metricGrid([
        ["상태", retrofit.status], ["전략", retrofit.strategyId], ["수량", `${retrofit.quantity}편성`],
        ["총사업비", yen.format(retrofit.totalCostJPY)], ["진행", `${retrofit.elapsedMonths}/${retrofit.durationMonths}개월`], ["시험", `${retrofit.testAttempts}회`],
      ]));
      if (retrofit.status === "proposed") section.append(button("개조 착수", () => run(() => runtime.startVehicleRetrofit(retrofit.id), "차량 개조 설계와 설치에 착수했습니다.")));
      if (retrofit.status === "failed-testing") section.append(button("재시험 발주", () => run(() => runtime.authorizeVehicleRetrofitRetest(retrofit.id), "보완 작업과 재시험을 발주했습니다.")));
    } else if (row.actions.proposeRetrofit) {
      const quantity = el("input"); quantity.type = "number"; quantity.min = "1"; quantity.value = "4";
      const strategy = el("select");
      for (const [value, label] of [["standard", "표준"], ["accelerated", "급행"], ["conservative", "보수적"]]) strategy.append(new Option(label, value));
      const controls = el("div", "through-inline-controls");
      controls.append(quantity, strategy, button("개조 견적", () => run(() => runtime.proposeVehicleRetrofit(service.throughServiceId, {
        quantity: Number(quantity.value),
        strategyId: strategy.value,
        selectedSignalSystemIds: requirements.signalAlternatives.map((entry) => entry.alternatives[0]),
      }), "개조비·기간·승인시험 계획을 만들었습니다.")));
      section.append(controls);
    } else {
      const text = requirements.blockers.length
        ? `차량 개조로 해결 불가: ${requirements.blockers.map((entry) => entry.checkId).join(", ")}`
        : requirements.missingInputs.length ? `기술자료 부족: ${requirements.missingInputs.join(", ")}` : "필요한 차량 개조가 없습니다.";
      section.append(el("div", "through-note", text));
    }
    card.append(section);
  }

  function renderOperation(card, row) {
    const section = el("section", "through-subcard");
    section.append(el("strong", "", "실제 직통운행"));
    if (row.binding) {
      const pendingDays = Object.keys(row.binding.actualsByDay ?? {}).length;
      section.append(metricGrid([
        ["운행선", row.binding.operationalLineId], ["승객 집계", row.binding.passengerMode], ["미정산 일", `${pendingDays}일`],
        ["누적 승객", `${Math.round(row.service.throughOperatingTotals?.passengers ?? 0).toLocaleString("ko-KR")}명`],
        ["누적 열차-km", `${Math.round(row.service.throughOperatingTotals?.trainKm ?? 0).toLocaleString("ko-KR")}km`],
        ["누적 영업이익", yen.format(row.service.throughOperatingTotals?.operatingProfitJPY ?? 0)],
      ]));
      if (row.latestSettlement) section.append(el("div", "through-note", `최근 ${row.latestSettlement.operatingDay}일 · 승객 ${row.latestSettlement.passengers.toLocaleString("ko-KR")}명 · ${yen.format(row.latestSettlement.money.operatingProfitJPY)}`));
    } else {
      const draft = getOperationDraft(row.service);
      if (draft && row.actions.commission) section.append(button("직통 운행 개시", () => run(() => runtime.commissionThroughServiceOperation(row.service.throughServiceId, draft), "직통열차가 실제 지도 운행을 시작했습니다.")));
      else section.append(el("div", "through-note", row.operationBlockers.join(" · ")));
    }
    card.append(section);
  }

  function renderService(row) {
    const { service } = row;
    const card = el("article", "through-service-card");
    const head = el("div", "through-head");
    head.append(el("strong", "", service.throughServiceId), el("span", `through-status ${service.status}`, STATUS[service.status] ?? service.status));
    card.append(head, metricGrid([
      ["경로", service.throughRouteId], ["판정", VERDICT[service.assessment?.verdict] ?? service.assessment?.verdict ?? "-"],
      ["운행사", service.operatorId ?? "미상"], ["차량", service.guestModelId ?? "미상"],
      ["빈도", `${service.trainsPerHour ?? "-"}회/h`], ["구간", `${service.legs?.length ?? 0}개`],
    ]));
    for (const [kind, values] of [["불가", service.assessment?.violations], ["조건", service.assessment?.conditions], ["미상", service.assessment?.missingInputs]]) {
      if (values?.length) card.append(el("div", kind === "불가" ? "through-error" : "through-warning", `${kind} · ${values.join(", ")}`));
    }
    const actions = el("div", "through-actions");
    if (row.actions.approve) actions.append(button("직통운행 승인", () => run(() => runtime.approveThroughService(service.throughServiceId), "직통 서비스를 승인했습니다.")));
    if (row.actions.suspend) actions.append(button("운행 중단", () => run(() => runtime.setThroughServiceStatus(service.throughServiceId, "suspended"), "직통 서비스와 실제 운행선을 중단했습니다.")));
    if (row.actions.resume) actions.append(button("운행 재개", () => run(() => runtime.setThroughServiceStatus(service.throughServiceId, "approved"), "계약과 실제 직통운행을 재개했습니다.")));
    if (row.actions.terminate) actions.append(button("서비스 종료", () => run(() => runtime.setThroughServiceStatus(service.throughServiceId, "terminated"), "직통 서비스와 연결 계약을 종료했습니다."), false, "danger"));
    card.append(actions);
    renderRetrofit(card, row);
    renderFare(card, row);
    renderOperation(card, row);
    return card;
  }

  function render() {
    container.replaceChildren();
    const view = buildThroughServiceManagementView(runtime.report());
    container.append(el("div", noticeError ? "through-error" : "through-notice", notice));
    container.append(renderRoutePlanner());
    if (!view.length) {
      container.append(el("div", "through-empty", "아직 직통 경로에서 생성된 경영 서비스가 없습니다."));
      return;
    }
    for (const row of view) container.append(renderService(row));
  }

  render();
  return { refresh: render };
}
