const yen = new Intl.NumberFormat("ko-KR", { notation: "compact", style: "currency", currency: "JPY", maximumFractionDigits: 1 });

const KIND_LABELS = Object.freeze({ tunnel: "터널", cutCover: "개착", viaduct: "고가·교량", systems: "전력·신호·궤도", station: "역", depot: "차량기지" });
const STATUS_LABELS = Object.freeze({ planned: "입찰 전", tendered: "평가 완료", awarded: "낙찰", completed: "완료", cancelled: "취소" });
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

function button(label, action, disabled = false) {
  const node = el("button", "", label);
  node.type = "button";
  node.disabled = disabled;
  node.addEventListener("click", action);
  return node;
}

export function constructionContractorView(runtime, planId) {
  const schedule = planId ? runtime.constructionSchedule(planId) : null;
  const packages = schedule?.constructionPackages ?? [];
  const procured = packages.filter((entry) => entry.procurement);
  return {
    schedule,
    packages,
    prepared: Boolean(schedule?.contractorProcurementPrepared),
    ready: Boolean(schedule?.contractorProcurementReady),
    integrated: Boolean(schedule?.contractorProcurementIntegrated),
    canPrepare: Boolean(schedule && packages.length && !schedule.contractorProcurementPrepared),
    canIntegrate: Boolean(procured.length && procured.every((entry) => entry.procurement.status === "awarded") && !schedule.contractorProcurementIntegrated),
  };
}

export function mountConstructionContractorPanel({ container, runtime, getPlanId, onChange = () => {} }) {
  let notice = "공사 공구를 연결한 뒤 시공사 입찰을 준비하세요.";
  let noticeError = false;
  const run = (action) => {
    try {
      const result = action();
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

  function renderBidTable(box, deliveryPackage, planId) {
    const table = el("table", "construction-bids");
    const head = el("tr");
    for (const label of ["순위", "시공사", "P50", "공기", "기술", "안전", "종합", "선정"]) head.append(el("th", "", label));
    table.append(head);
    deliveryPackage.procurement.ranking.forEach((bid, index) => {
      const contractor = runtime.game.constructionContractors.find((entry) => entry.id === bid.contractorId);
      const row = el("tr", index === 0 ? "preferred" : "");
      for (const value of [index + 1, contractor?.name ?? bid.contractorId, yen.format(bid.priceP50), `${bid.durationMonths}개월`, bid.technicalScore, bid.safetyScore, bid.totalScore.toFixed(1)]) row.append(el("td", "", String(value)));
      const action = el("td");
      action.append(button("낙찰", () => run(() => {
        const contract = runtime.awardConstructionPackage(planId, deliveryPackage.constructionSiteId, bid.id);
        notice = `${contractor?.name ?? bid.contractorId}에 ${yen.format(contract.currentPriceP50)}로 낙찰했습니다.`;
        return contract;
      })));
      row.append(action);
      table.append(row);
    });
    box.append(table);
  }

  function renderPackage(deliveryPackage, planId) {
    const box = el("article", "construction-contract-card");
    const head = el("div", "construction-contract-head");
    head.append(
      el("strong", "", `${KIND_LABELS[deliveryPackage.kind] ?? deliveryPackage.kind} · ${deliveryPackage.name ?? deliveryPackage.constructionSiteId}`),
      el("span", "", deliveryPackage.procurement ? STATUS_LABELS[deliveryPackage.procurement.status] ?? deliveryPackage.procurement.status : "기존 전문계약"),
    );
    box.append(head);
    if (!deliveryPackage.procurement) {
      box.append(el("p", "construction-contract-note", "역·차량기지는 기존 상세설계·시공 계약을 사용하며 여기서 다시 입찰하지 않습니다."));
      return box;
    }
    const procurement = deliveryPackage.procurement;
    const contract = procurement.contract;
    const metrics = el("div", "construction-contract-metrics");
    for (const [label, value] of [["기존 배정", yen.format(procurement.legacyAllowanceP50)], ["필수 장비", procurement.equipmentType], ["계약 방식", procurement.contractModel ?? "미정"], ["낙찰가", contract ? yen.format(contract.currentPriceP50) : "-"]]) {
      const metric = el("div");
      metric.append(el("span", "", label), el("b", "", value));
      metrics.append(metric);
    }
    box.append(metrics);
    if (procurement.status === "planned") {
      const controls = el("div", "construction-tender-controls");
      const model = el("select");
      for (const [value, label] of [["fixed-price", "총액고정"], ["index-linked", "물가연동"], ["target-cost", "목표원가"]]) model.append(new Option(label, value));
      const evaluation = el("select");
      for (const [value, label] of [["best-value", "종합평가"], ["safety-first", "안전중심"], ["lowest-price", "가격중심"]]) evaluation.append(new Option(label, value));
      controls.append(model, evaluation, button("입찰 실시", () => run(() => {
        const result = runtime.tenderConstructionPackage(planId, deliveryPackage.constructionSiteId, { contractModel: model.value, evaluation: evaluation.value });
        notice = `${result.bidderCount}개사가 입찰했습니다. 가격·기술·안전·공기를 비교해 낙찰자를 정하세요.`;
        return result;
      })));
      box.append(controls);
    }
    if (procurement.status === "tendered") renderBidTable(box, deliveryPackage, planId);
    if (contract) {
      const contractor = runtime.game.constructionContractors.find((entry) => entry.id === contract.contractorId);
      box.append(el("p", "construction-contract-award", `${contractor?.name ?? contract.contractorId} · ${contract.durationMonths}개월 · ${contract.equipmentAssignments.map((entry) => entry.equipmentType).join(", ")}`));
    }
    return box;
  }

  function render() {
    container.replaceChildren();
    const planId = getPlanId();
    const view = constructionContractorView(runtime, planId);
    const head = el("div", "construction-contract-summary");
    const awarded = view.packages.filter((entry) => entry.procurement?.status === "awarded").length;
    const required = view.packages.filter((entry) => entry.procurement).length;
    head.append(el("strong", "", "공구별 시공사·장비"), el("span", "", `${awarded}/${required} 낙찰`));
    container.append(head, el("div", noticeError ? "construction-contract-error" : "construction-contract-notice", notice));
    if (!view.schedule) {
      container.append(el("div", "construction-contract-empty", "차량기지·차량 발주 후 통합 공정표를 먼저 만드세요."));
      return;
    }
    if (!view.packages.length) {
      container.append(el("div", "construction-contract-empty", "지도에서 공사 공구를 만들고 ‘공구 연동’을 누르세요."));
      return;
    }
    if (view.canPrepare) container.append(button("공구 입찰 준비", () => run(() => {
      const result = runtime.prepareConstructionProcurement(planId);
      notice = "토목·시스템 공사비를 공구별 예정금액으로 나눴습니다. 입찰 전에는 공사가 진행되지 않습니다.";
      return result;
    })));
    if (view.prepared) for (const deliveryPackage of view.packages) container.append(renderPackage(deliveryPackage, planId));
    if (view.canIntegrate) container.append(button("낙찰가·공기 통합", () => run(() => {
      const result = runtime.integrateConstructionPackageAwards(planId);
      notice = `기존 토목·시스템 예정액을 낙찰가로 대체했습니다. P50 증감 ${yen.format(result.replacement.deltaP50)}.`;
      return result;
    })));
    if (view.integrated) container.append(el("div", "construction-contract-ready", "모든 공구 계약이 총사업비와 통합 공정표에 반영되었습니다."));
  }

  render();
  return { refresh: render };
}
