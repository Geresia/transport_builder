import { TECHNICAL_PROFILES } from "./management/index.mjs";

const STRUCTURES = [
  ["surface", "지상"], ["elevated", "고가"], ["cut-cover", "개착 지하"], ["shield", "실드·터널"], ["deep", "대심도"],
];
const LAYOUTS = [
  ["side-2track", "상대식 2선"], ["island-2track", "섬식 2선"], ["two-platform-3-track", "2면 3선"],
  ["two-platform-4-track", "2면 4선"], ["double-island-4-track", "쌍섬식 4선"], ["terminal-bay", "두단식 종착"],
];
const SCREENS = [["none", "없음"], ["half-height", "반밀폐형"], ["full-height", "완전밀폐형"], ["wide-opening", "광폭형"]];
const OPERATIONS = [["manual", "수동"], ["ato", "ATO"], ["goa4", "GoA4 무인"]];
const yen = new Intl.NumberFormat("ko-KR", { notation: "compact", style: "currency", currency: "JPY", maximumFractionDigits: 1 });

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

export function stationManagementView(runtime, planId, selectedSite = null) {
  const project = planId ? runtime.projectForPlan(planId) : null;
  const summary = planId ? runtime.stationDeliverySummary(planId) : { expected: 0, designed: 0, awarded: 0, integrated: false, ready: false, reasons: [] };
  const selectedPackage = selectedSite
    ? runtime.game.stationPackages.find((item) => item.stationSiteId === selectedSite.stationSiteId) ?? null
    : null;
  return {
    project,
    summary,
    selectedSite,
    selectedPackage,
    canDesign: Boolean(project && selectedSite && ["estimated", "approved"].includes(project.status) && !selectedPackage),
    canResolve: selectedPackage?.status === "designed" && selectedPackage.unresolvedConditions.length > 0 && selectedPackage.unresolvedViolations.length === 0,
    canTender: selectedPackage?.status === "designed" && selectedPackage.unresolvedConditions.length === 0 && selectedPackage.unresolvedViolations.length === 0,
    canAward: selectedPackage?.status === "tendered" && selectedPackage.ranking.length > 0,
    canIntegrate: Boolean(project && summary.designed === summary.expected && summary.awarded === summary.expected && !summary.integrated),
  };
}

function select(label, values, initial, onChange) {
  const wrap = el("label", "station-control");
  wrap.append(el("span", "", label));
  const input = el("select");
  for (const [value, text] of values) input.append(new Option(text, value));
  input.value = initial;
  input.addEventListener("change", () => onChange(input.value));
  wrap.append(input);
  return wrap;
}

function numberInput(label, value, min, max, onChange) {
  const wrap = el("label", "station-control");
  wrap.append(el("span", "", label));
  const input = el("input");
  input.type = "number";
  input.min = String(min);
  input.max = String(max);
  input.value = String(value);
  input.addEventListener("change", () => onChange(Number(input.value)));
  wrap.append(input);
  return wrap;
}

function check(label, checked, onChange) {
  const wrap = el("label", "station-check");
  const input = el("input");
  input.type = "checkbox";
  input.checked = checked;
  input.addEventListener("change", () => onChange(input.checked));
  wrap.append(input, document.createTextNode(label));
  return wrap;
}

function button(label, action, disabled = false) {
  const node = el("button", "", label);
  node.type = "button";
  node.disabled = disabled;
  node.addEventListener("click", action);
  return node;
}

function selectedIds(set) {
  return [...set];
}

export function mountStationManagementPanel({ container, runtime, getPlanId, getSelectedSite, getSelection = () => null, onChange = () => {} }) {
  const drafts = new Map();
  let notice = "지도에서 역 후보를 선택해 상세설계를 시작하세요.";
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

  function draftFor(site, project) {
    let draft = drafts.get(site.stationSiteId);
    if (draft) return draft;
    const profile = TECHNICAL_PROFILES[project.technicalProfileId];
    const clearEntrances = (site.entranceCandidates ?? []).filter((entry) => !(entry.collidingBuildingCount > 0) && !(entry.waterOverlapCount > 0)).slice(0, 2);
    draft = {
      structureId: site.planHints?.structure ?? "surface",
      layoutId: site.planHints?.platformType === "island" ? "island-2track" : "side-2track",
      currentCars: profile.minCars,
      futureCars: profile.minCars,
      operationMode: "ato",
      screenDoorType: "full-height",
      selectedEntranceIds: new Set(clearEntrances.map((entry) => entry.entranceId)),
      selectedTransferIds: new Set(),
      selectedWorkAreaId: null,
      workAreaSecured: false,
    };
    drafts.set(site.stationSiteId, draft);
    return draft;
  }

  function renderPackage(box, deliveryPackage, view) {
    const estimate = deliveryPackage.estimate;
    const headline = el("div", "station-package-head");
    headline.append(el("strong", "", deliveryPackage.design.stationPlan.name), el("span", `station-state ${deliveryPackage.status}`, deliveryPackage.status));
    box.append(headline);
    const metrics = el("div", "station-metrics");
    for (const [name, value] of [
      ["P50", yen.format(deliveryPackage.awardedBid?.priceP50 ?? estimate.costs.totalP50)],
      ["P90", yen.format(deliveryPackage.awardedBid?.priceP90 ?? estimate.costs.totalP90)],
      ["기간", `${deliveryPackage.awardedBid?.durationMonths ?? estimate.schedule.durationP90Months}개월`],
      ["공법", estimate.methodId],
    ]) {
      const metric = el("div");
      metric.append(el("span", "", name), el("b", "", value));
      metrics.append(metric);
    }
    box.append(metrics);
    if (estimate.uncertainty.imputedInputs.length) box.append(el("div", "station-warning", `미상값 추정 ${estimate.uncertainty.imputedInputs.length}건 · P90에 불확실성 반영`));
    for (const violation of deliveryPackage.unresolvedViolations) box.append(el("div", "station-error", `불가 · ${violation.code}`));

    if (deliveryPackage.unresolvedConditions.length) {
      const resolutionRows = [];
      for (const condition of deliveryPackage.unresolvedConditions) {
        const row = el("div", "station-resolution");
        row.append(el("span", "", condition.code));
        const cost = el("input");
        cost.type = "number";
        cost.min = "0";
        cost.step = "10000000";
        cost.value = "0";
        cost.title = "추가비용 JPY";
        const months = el("input");
        months.type = "number";
        months.min = "0";
        months.value = "0";
        months.title = "추가 개월";
        row.append(cost, months);
        resolutionRows.push({ condition, cost, months });
        box.append(row);
      }
      box.append(button("조건 반영", () => run(() => {
        const result = runtime.resolveStationDesign(deliveryPackage.id, resolutionRows.map(({ condition, cost, months }) => ({
          code: condition.code,
          action: `플레이어 상세설계 조치: ${condition.code}`,
          addedCostJpy: Number(cost.value),
          addedMonths: Number(months.value),
        })));
        notice = "조건을 상세설계에 반영했습니다. 입찰공고를 낼 수 있습니다.";
        return result;
      }), !view.canResolve));
    }

    if (view.canTender) box.append(button("시공사 입찰공고", () => run(() => {
      const result = runtime.tenderStation(deliveryPackage.id);
      notice = `${result.bidderCount}개사가 응찰했습니다.`;
      return result;
    })));

    if (deliveryPackage.ranking.length) {
      const table = el("table", "station-bids");
      const head = el("tr");
      for (const label of ["순위", "시공사", "P50", "기술", "안전", "종합"]) head.append(el("th", "", label));
      table.append(head);
      deliveryPackage.ranking.forEach((bid, index) => {
        const contractor = runtime.game.stationContractors.find((entry) => entry.id === bid.contractorId);
        const row = el("tr", index === 0 ? "preferred" : "");
        for (const value of [index + 1, contractor?.name ?? bid.contractorId, yen.format(bid.priceP50), bid.technicalScore, bid.safetyScore, bid.totalScore.toFixed(1)]) row.append(el("td", "", String(value)));
        table.append(row);
      });
      box.append(table);
      if (view.canAward) box.append(button("1순위 낙찰", () => run(() => {
        const result = runtime.awardStation(deliveryPackage.id, deliveryPackage.ranking[0].id);
        notice = `${runtime.game.stationContractors.find((entry) => entry.id === result.contractorId)?.name ?? result.contractorId}와 역 공사계약을 체결했습니다.`;
        return result;
      })));
    }
  }

  function render() {
    container.replaceChildren();
    const planId = getPlanId();
    const site = getSelectedSite();
    const view = stationManagementView(runtime, planId, site);
    const heading = el("div", "station-management-head");
    heading.append(el("strong", "", "역 상세설계·시공"), el("span", "", `${view.summary.awarded}/${view.summary.expected}역 낙찰`));
    container.append(heading);
    const noticeNode = el("div", noticeError ? "station-error" : "station-notice", notice);
    container.append(noticeNode);

    if (!view.project) {
      container.append(el("div", "station-empty", "계획 승인과 사업화를 먼저 완료하세요."));
      return;
    }

    if (site) {
      const selected = el("section", "station-design-card");
      selected.append(el("div", "station-selection", `${site.name ?? site.connectedStationId ?? site.stationSiteId} · ${site.dataQuality ?? "품질 미상"}`));
      if (view.selectedPackage) renderPackage(selected, view.selectedPackage, view);
      else {
        const draft = draftFor(site, view.project);
        const mapSelection = getSelection();
        if (mapSelection?.stationSiteId === site.stationSiteId) {
          draft.selectedEntranceIds = new Set(mapSelection.selectedEntranceIds ?? []);
          draft.selectedTransferIds = new Set(mapSelection.selectedTransferIds ?? []);
          draft.selectedWorkAreaId = mapSelection.selectedWorkAreaId ?? null;
        }
        const profile = TECHNICAL_PROFILES[view.project.technicalProfileId];
        const grid = el("div", "station-form-grid");
        grid.append(
          select("구조", STRUCTURES, draft.structureId, (value) => { draft.structureId = value; }),
          select("배선", LAYOUTS, draft.layoutId, (value) => { draft.layoutId = value; }),
          numberInput("현재 편성", draft.currentCars, profile.minCars, profile.maxCars, (value) => { draft.currentCars = value; if (draft.futureCars < value) draft.futureCars = value; }),
          numberInput("미래 편성", draft.futureCars, profile.minCars, profile.maxCars, (value) => { draft.futureCars = value; }),
          select("운전", OPERATIONS, draft.operationMode, (value) => { draft.operationMode = value; }),
          select("안전문", SCREENS, draft.screenDoorType, (value) => { draft.screenDoorType = value; }),
        );
        selected.append(grid);

        const entrances = el("div", "station-choice-list");
        entrances.append(el("b", "", `출입구 후보 ${(site.entranceCandidates ?? []).length}개`));
        for (const candidate of site.entranceCandidates ?? []) entrances.append(check(
          `${candidate.entranceId} · 건물 ${candidate.collidingBuildingCount ?? "미상"} · 공공용지 ${candidate.publicLand === true ? "근거 있음" : "미상"}`,
          draft.selectedEntranceIds.has(candidate.entranceId),
          (checked) => checked ? draft.selectedEntranceIds.add(candidate.entranceId) : draft.selectedEntranceIds.delete(candidate.entranceId),
        ));
        selected.append(entrances);

        if (site.transferCandidates?.length) {
          const transfers = el("div", "station-choice-list");
          transfers.append(el("b", "", `환승 후보 ${site.transferCandidates.length}개`));
          for (const candidate of site.transferCandidates) transfers.append(check(
            `${candidate.targetName ?? candidate.targetStationId} · ${Math.round(candidate.walkingDistanceMeters ?? candidate.straightDistanceMeters)}m`,
            draft.selectedTransferIds.has(candidate.transferId),
            (checked) => checked ? draft.selectedTransferIds.add(candidate.transferId) : draft.selectedTransferIds.delete(candidate.transferId),
          ));
          selected.append(transfers);
        }

        const works = [["", "작업장 미선택"], ...(site.workAreaCandidates ?? []).map((entry) => [entry.workAreaId, `${entry.slot} · ${Math.round(entry.areaSquareMeters ?? 0)}㎡ · 건물 ${entry.intersectedBuildingCount ?? "미상"}`])];
        selected.append(select("공사 작업장", works, draft.selectedWorkAreaId ?? "", (value) => { draft.selectedWorkAreaId = value || null; }));
        selected.append(check("작업장 사용권 확보", draft.workAreaSecured, (checked) => { draft.workAreaSecured = checked; }));
        selected.append(button("설계·상세견적 생성", () => run(() => {
          if (!draft.selectedEntranceIds.size) throw new Error("출입구 후보를 하나 이상 선택하세요.");
          const result = runtime.designStation(planId, site, {
            structureId: draft.structureId,
            layoutId: draft.layoutId,
            currentCars: draft.currentCars,
            futureCars: draft.futureCars,
            operationMode: draft.operationMode,
            screenDoorType: draft.screenDoorType,
            selectedEntranceIds: selectedIds(draft.selectedEntranceIds),
            selectedTransferIds: selectedIds(draft.selectedTransferIds),
            selectedWorkAreaId: draft.selectedWorkAreaId,
            workAreaSecured: draft.workAreaSecured,
          });
          notice = `P50 ${yen.format(result.estimate.costs.totalP50)}, P90 ${yen.format(result.estimate.costs.totalP90)} 상세견적을 만들었습니다.`;
          return result;
        }), !view.canDesign));
      }
      container.append(selected);
    } else container.append(el("div", "station-empty", "역 후보 도구에서 현재 노선의 역을 선택하세요."));

    const packages = view.summary.packages ?? [];
    if (packages.length) {
      const list = el("div", "station-package-list");
      list.append(el("b", "", "노선 역 패키지"));
      for (const item of packages) list.append(el("div", "station-package-row", `${item.design.stationPlan.name} · ${item.status} · ${Math.round((item.progress ?? 0) * 100)}% · 기성 ${yen.format(item.paidAllocation ?? 0)} · ${yen.format(item.awardedBid?.priceP50 ?? item.estimate.costs.totalP50)}`));
      container.append(list);
    }
    const replacement = view.project.estimate.stationDetailReplacement;
    if (replacement) container.append(el("div", "station-cost-replacement", `개략비 ${yen.format(replacement.legacyP50)} → 낙찰가 ${yen.format(replacement.awardedP50)} · P50 증감 ${yen.format(replacement.deltaP50)}`));
    container.append(button("전체 역 본사업비 편입", () => run(() => {
      const result = runtime.integrateStations(planId);
      notice = `개략 역 공사비를 낙찰가로 교체했습니다. P50 증감 ${yen.format(result.deltaP50)}.`;
      return result;
    }), !view.canIntegrate));
  }

  render();
  return { refresh: render };
}
