export const CORPORATE_FINANCIAL_STATEMENT_SCHEMA = "transitline.corporate-financial-statement/1";
const MONTH_MINUTES = 30 * 1440;

const sum = (values) => values.reduce((total, value) => total + (Number(value) || 0), 0);
const round = (value) => Math.round(Number(value) || 0);

const financingCategories = new Set([
  "construction-finance", "construction-finance-fee", "construction-debt-service",
  "sponsor-equity", "sponsor-equity-return", "construction-loan", "supplementary-budget",
]);
const investingCategories = new Set([
  "construction", "vehicles", "depot-development", "infrastructure-maintenance", "construction-event-response",
]);

function cashFlowForMonth(ledger, month) {
  const start = month * MONTH_MINUTES;
  const end = (month + 1) * MONTH_MINUTES;
  const entries = ledger.entries.filter((entry) => entry.atMinute >= start && entry.atMinute < end);
  const result = { operatingJPY: 0, investingJPY: 0, financingJPY: 0, otherJPY: 0, netChangeJPY: 0 };
  for (const entry of entries) {
    if (financingCategories.has(entry.category) || entry.category.includes("equity")) result.financingJPY += entry.amount;
    else if (investingCategories.has(entry.category)) result.investingJPY += entry.amount;
    else if (entry.category.startsWith("operating") || entry.category.startsWith("integrated-operating") || entry.category.startsWith("through-") || entry.category.startsWith("vehicle-") || entry.category === "electricity-contract-change") result.operatingJPY += entry.amount;
    else result.otherJPY += entry.amount;
    result.netChangeJPY += entry.amount;
  }
  for (const key of Object.keys(result)) result[key] = round(result[key]);
  return result;
}

function assetValues(game) {
  const infrastructureGrossJPY = sum(game.projects.map((project) => project.paid ?? (project.status === "available" ? project.estimate?.totalP50 : 0)));
  const infrastructureConditions = game.projects.flatMap((project) => project.assets ?? []).map((asset) => asset.condition ?? 1);
  const infrastructureCondition = infrastructureConditions.length ? sum(infrastructureConditions) / infrastructureConditions.length : 1;
  const vehicleGrossJPY = sum(game.vehicleOrders.map((order) => order.paid ?? order.totalPrice ?? 0));
  const vehicleUnits = game.vehicleOrders.flatMap((order) => order.units ?? []);
  const vehicleCondition = vehicleUnits.length ? sum(vehicleUnits.map((unit) => unit.condition ?? 1)) / vehicleUnits.length : 1;
  const depotGrossJPY = sum(game.depots.map((depot) => depot.paid ?? depot.estimate?.totalP50 ?? depot.totalCost ?? 0));
  return {
    infrastructureGrossJPY: round(infrastructureGrossJPY),
    infrastructureBookJPY: round(infrastructureGrossJPY * infrastructureCondition),
    vehicleGrossJPY: round(vehicleGrossJPY),
    vehicleBookJPY: round(vehicleGrossJPY * vehicleCondition),
    depotGrossJPY: round(depotGrossJPY),
    depotBookJPY: round(depotGrossJPY),
  };
}

function monthlyDepreciation(game) {
  const values = assetValues(game);
  return round(values.infrastructureGrossJPY / (40 * 12) + values.vehicleGrossJPY / (30 * 12) + values.depotGrossJPY / (35 * 12));
}

export function corporateBalanceSheet(game) {
  const assets = assetValues(game);
  const constructionDebtJPY = round(sum(game.constructionFinancing.filter((entry) => entry.kind === "construction-loan").map((entry) => (entry.balanceJPY ?? 0) + (entry.arrearsJPY ?? 0))));
  const unpaidEquityReturnJPY = round(sum(game.constructionFinancing.filter((entry) => entry.kind === "sponsor-equity").map((entry) => entry.arrearsJPY ?? 0)));
  const cashJPY = round(game.ledger.cash);
  const fixedAssetsJPY = assets.infrastructureBookJPY + assets.vehicleBookJPY + assets.depotBookJPY;
  const totalAssetsJPY = cashJPY + fixedAssetsJPY;
  const totalLiabilitiesJPY = constructionDebtJPY + unpaidEquityReturnJPY;
  return {
    cashJPY,
    committedCashJPY: round(game.ledger.committed),
    availableCashJPY: round(game.ledger.availableCash),
    ...assets,
    fixedAssetsJPY,
    totalAssetsJPY,
    constructionDebtJPY,
    unpaidEquityReturnJPY,
    totalLiabilitiesJPY,
    equityJPY: totalAssetsJPY - totalLiabilitiesJPY,
    debtToAssets: totalAssetsJPY > 0 ? constructionDebtJPY / totalAssetsJPY : null,
  };
}

export function corporateMonthlyStatement(game, month) {
  const operating = game.operatingMonthReports.filter((entry) => entry.month === month);
  const throughOperating = (game.throughOperatingSettlements ?? []).filter((entry) => Math.floor((entry.settledAtMinute ?? 0) / MONTH_MINUTES) === month);
  const revenueJPY = round(sum(operating.map((entry) => entry.operatingIncomeJPY)) + sum(throughOperating.map((entry) => entry.money?.playerFareRevenueJPY)));
  const operatingCostJPY = round(sum(operating.map((entry) => entry.operatingCostJPY)) + sum(throughOperating.map((entry) => entry.money?.operatingCostJPY)));
  const ebitdaJPY = revenueJPY - operatingCostJPY;
  const depreciationJPY = monthlyDepreciation(game);
  const ebitJPY = ebitdaJPY - depreciationJPY;
  const financeCostJPY = round(sum(operating.map((entry) => entry.financeCostJPY)));
  const capitalInvestmentJPY = round(sum(operating.map((entry) => entry.capitalCostJPY ?? 0)));
  const pretaxProfitJPY = ebitJPY - financeCostJPY;
  const cashFlow = cashFlowForMonth(game.ledger, month);
  return {
    schema: CORPORATE_FINANCIAL_STATEMENT_SCHEMA,
    contractVersion: 1,
    month,
    revenueJPY,
    operatingCostJPY,
    ebitdaJPY,
    depreciationJPY,
    ebitJPY,
    financeCostJPY,
    pretaxProfitJPY,
    capitalInvestmentJPY,
    cashFlow,
  };
}

export function corporateFinancialStatements(game, { fromMonth = 0, throughMonth = Math.floor(game.clock.minute / MONTH_MINUTES) } = {}) {
  if (!Number.isInteger(fromMonth) || !Number.isInteger(throughMonth) || fromMonth < 0 || throughMonth < fromMonth) throw new Error("Invalid financial statement month range");
  const monthly = [];
  for (let month = fromMonth; month <= throughMonth; month++) monthly.push(corporateMonthlyStatement(game, month));
  return {
    schema: CORPORATE_FINANCIAL_STATEMENT_SCHEMA,
    contractVersion: 1,
    throughMonth,
    monthly,
    balanceSheet: corporateBalanceSheet(game),
  };
}
