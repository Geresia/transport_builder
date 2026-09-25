import { ManagementGame } from "./management/game.mjs";

const $ = (id) => document.getElementById(id);
const countryId = new URLSearchParams(location.search).get("country") === "KR" ? "KR" : "JP";
const STORAGE_KEY = `transitline-management-${countryId}`;
let game = new ManagementGame({ countryId, seed: 20260925, openingCash: 1_000_000_000_000 });

const samplePlan = {
  planId: "metro-east",
  coordinateReference: "EPSG:4326",
  sourcePackId: "management-demo",
  sourcePackVersion: "1",
  stationCandidates: [
    { id: "east-1", location: [139.71, 35.68], platformType: "side", platformLengthM: 100, structure: "surface" },
    { id: "east-2", location: [139.73, 35.68], platformType: "island", platformLengthM: 100, structure: "elevated" },
    { id: "east-3", location: [139.75, 35.68], platformType: "side", platformLengthM: 100, structure: "elevated" },
  ],
  segments: [
    { from: "east-1", to: "east-2", lengthMeters: 2300, elevationStartMeters: 0, elevationEndMeters: 9, structureHint: "surface", constraintFlags: [], dataQuality: "high" },
    { from: "east-2", to: "east-3", lengthMeters: 2400, elevationStartMeters: 9, elevationEndMeters: 11, structureHint: "elevated", constraintFlags: ["road-median"], dataQuality: "medium" },
  ],
  accessLinks: [],
};

const yen = new Intl.NumberFormat("ko-KR", { style: "currency", currency: "JPY", maximumFractionDigits: 0 });
const shortYen = (value) => `${(value / 100_000_000).toFixed(1)}억 엔`;
const labels = {
  "opportunity-announced": "운영권 공고 확인",
  "opportunity-researched": "정밀조사 완료",
  "bid-submitted": "입찰 제안 제출",
  "tender-evaluated": "입찰 종합평가",
  "tender-negotiated": "우선협상 완료",
  "project-created": "노선 계획 견적",
  "construction-contracted": "건설 계약 체결",
  "depot-secured": "차량기지 확보",
  "vehicles-ordered": "차량 발주",
  "month-advanced": "공사 및 제작 1개월 진행",
  "service-created": "개통 판정",
  "service-day-operated": "영업운행 정산",
};

function currentPhase() {
  const opportunity = game.opportunities[0];
  const project = game.projects[0];
  const order = game.vehicleOrders[0];
  const service = game.services[0];
  if (service?.daysOperated >= 30) return 9;
  if (service) return 8;
  if (project?.status === "available" && order?.stage === "accepted") return 7;
  if (order) return 6;
  if (project) return 5;
  if (opportunity?.status === "awarded") return 4;
  if (opportunity?.bids?.some((bid) => bid.isPlayer)) return 3;
  if (opportunity?.researchLevel) return 2;
  if (opportunity) return 1;
  return 0;
}

function render() {
  const phase = currentPhase();
  const project = game.projects[0];
  const order = game.vehicleOrders[0];
  const service = game.services[0];
  $("country").textContent = game.country.id === "JP" ? "일본 규칙" : "한국 규칙";
  $("date").textContent = `${game.clock.day.toLocaleString("ko-KR")}일`;
  $("cash").textContent = shortYen(game.ledger.cash);
  $("committed").textContent = shortYen(game.ledger.committed);
  $("progress").textContent = project ? project.status === "available" ? "사용 가능" : `${Math.round(project.progress * 100)}%` : "미착수";
  $("fleet").textContent = `${order?.units?.length ?? 0}편성`;
  const profit = service?.totals ? service.totals.revenue - service.totals.cost : 0;
  $("profit").textContent = shortYen(profit);
  $("profit").className = profit < 0 ? "negative" : profit > 0 ? "positive" : "";
  $("phase").textContent = `단계 ${Math.min(phase + 1, 9)} / 9`;

  [...$("steps").children].forEach((item, index) => {
    item.classList.toggle("done", index < phase);
    item.classList.toggle("current", index === phase);
  });
  $("announce").disabled = phase !== 0;
  $("research").disabled = phase !== 1;
  $("bid").disabled = phase !== 2;
  $("award").disabled = phase !== 3;
  $("construct").disabled = phase !== 4;
  $("readiness").disabled = phase !== 5;
  $("month").disabled = phase !== 6;
  $("year").disabled = phase !== 6;
  $("open").disabled = phase !== 7;
  $("operate").disabled = phase !== 8;

  const rows = game.ledger.entries.slice(-8).reverse();
  $("ledger-empty").hidden = rows.length > 0;
  $("ledger-table").hidden = rows.length === 0;
  $("ledger").replaceChildren(...rows.map((entry) => {
    const row = document.createElement("tr");
    const day = document.createElement("td");
    day.textContent = `${Math.floor(entry.atMinute / 1440) + 1}일`;
    const category = document.createElement("td");
    category.textContent = entry.category;
    const amount = document.createElement("td");
    amount.textContent = yen.format(entry.amount);
    amount.className = entry.amount > 0 ? "positive" : "negative";
    row.append(day, category, amount);
    return row;
  }));
  const events = game.events.entries.slice(-10).reverse();
  $("event-count").textContent = `${game.events.entries.length}건`;
  if (!events.length) $("events").innerHTML = '<li class="empty">기록된 사건이 없습니다.</li>';
  else $("events").replaceChildren(...events.map((event) => {
    const item = document.createElement("li");
    item.textContent = `${Math.floor(event.atMinute / 1440) + 1}일 · ${labels[event.type] ?? event.type}`;
    return item;
  }));
}

function status(message, kind = "완료") {
  $("status").textContent = message;
  $("status-kind").textContent = kind;
}

function action(callback) {
  try {
    callback();
    render();
  } catch (error) {
    status(error.message, "오류");
    render();
  }
}

$("new-game").addEventListener("click", () => action(() => {
  game = new ManagementGame({ countryId, seed: 20260925, openingCash: 1_000_000_000_000 });
  status("새 경영 시나리오를 시작했습니다.");
}));
$("save-game").addEventListener("click", () => action(() => {
  localStorage.setItem(STORAGE_KEY, game.save());
  status("현재 회사, 계약, 공정, 난수 상태를 저장했습니다.");
}));
$("load-game").addEventListener("click", () => action(() => {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (!saved) throw new Error("불러올 저장본이 없습니다.");
  game = ManagementGame.load(saved);
  status("저장한 시점의 모든 상태를 복원했습니다.");
}));
$("announce").addEventListener("click", () => action(() => {
  game.announceOpportunity({ id: "om-east", title: "동부선 O&M", deadlineMinute: 14 * 1440, contractYears: 20, baselineAnnualCost: 5_000_000_000, minimumTechnical: 70 });
  status("20년 운영권 공고입니다. 조사 없이도 입찰할 수 있지만 원가 오차가 큽니다.");
}));
$("research").addEventListener("click", () => action(() => {
  const result = game.research("om-east", 2);
  status(`정밀조사를 마쳤습니다. 연간비용 범위는 ${shortYen(result.annualCostRange[0])}에서 ${shortYen(result.annualCostRange[1])}입니다.`);
}));
$("bid").addEventListener("click", () => action(() => {
  game.bid("om-east", { requestedAnnualPayment: 4_000_000_000, technicalScore: 100, staffingScore: 95 });
  status("입찰 준비비와 보증 한도를 반영하고 제안서를 제출했습니다.");
}));
$("award").addEventListener("click", () => action(() => {
  const result = game.closeTender("om-east");
  if (result.ranking[0]?.bidderId !== "player") throw new Error("이번 입찰에서 우선협상자로 선정되지 못했습니다. 새 게임에서 다시 도전할 수 있습니다.");
  game.award("om-east", "player");
  status(`경쟁 ${result.ranking.length}개 제안 중 1위로 운영권을 수주했습니다.`);
}));
$("construct").addEventListener("click", () => action(() => {
  const assessment = game.assess(samplePlan, "medium_steel");
  if (assessment.buildable !== true) throw new Error(assessment.violations.join("; "));
  const project = game.createProject(samplePlan, "medium_steel");
  game.contractProject(project.id);
  status(`총사업비 P50 ${shortYen(project.estimate.totalP50)}, 예정기간 ${project.estimate.durationMonths}개월로 계약했습니다.`);
}));
$("readiness").addEventListener("click", () => action(() => {
  game.addDepot({ id: "depot-east", name: "동부 차량기지", locationStrategy: "terminal", capacitySets: 4, inspectionSetsPerDay: 2 });
  const order = game.orderVehicles({ id: "fleet-east", modelId: "medium_4car", quantity: 4, manufacturerId: "maker-a" });
  status(`차량 4편성을 발주했습니다. 예상 제작기간은 ${order.productionMonths}개월입니다.`);
}));
$("month").addEventListener("click", () => action(() => {
  game.advanceMonth();
  const project = game.projects[0];
  const order = game.vehicleOrders[0];
  status(`공사 ${Math.round(project.progress * 100)}%, 차량 단계 ${order.stage}. 두 조건이 끝날 때까지 진행합니다.`);
}));
$("year").addEventListener("click", () => action(() => {
  let advanced = 0;
  while (advanced < 12 && currentPhase() === 6) {
    game.advanceMonth();
    advanced++;
  }
  const project = game.projects[0];
  const order = game.vehicleOrders[0];
  status(`${advanced}개월 진행했습니다. 공사 ${Math.round(project.progress * 100)}%, 차량 단계 ${order.stage}.`);
}));
$("open").addEventListener("click", () => action(() => {
  const project = game.projects[0];
  const order = game.vehicleOrders[0];
  if (project.status !== "available" || order.stage !== "accepted") throw new Error("공사와 차량 인수가 아직 끝나지 않았습니다.");
  const service = game.createService({ id: "east-service", projectId: project.id, vehicleOrderId: order.id, depotId: "depot-east", contractId: "contract:om-east", modelId: "medium_4car", routeKm: 4.7, stations: 3, commercialSpeedKph: 30, trainsPerHour: 4, staffReady: true, timetableReady: true, trialOperationPassed: true, approvalsValid: true, platformLengthM: 100 });
  status(service.status === "open" ? "모든 개통 조건을 통과해 영업운행을 시작합니다." : service.readiness.reasons.join("; "));
}));
$("operate").addEventListener("click", () => action(() => {
  let profit = 0;
  let boarded = 0;
  for (let day = 0; day < 30; day++) {
    const result = game.operateDay("east-service");
    profit += result.profit;
    boarded += result.boarded;
  }
  status(`30일 동안 ${boarded.toLocaleString("ko-KR")}명을 수송했고 영업손익은 ${shortYen(profit)}입니다.`);
}));

render();
