export const CONSTRUCTION_PRICE_STATE_SCHEMA = "transitline.construction-price-state/1";
export const CONSTRUCTION_FUNDING_CASE_SCHEMA = "transitline.construction-funding-case/1";
export const CONSTRUCTION_FINANCE_SCHEMA = "transitline.construction-finance/1";

const MONTH_MINUTES = 30 * 1440;
const round = (value, digits = 6) => Number(Number(value).toFixed(digits));
const clone = (value) => structuredClone(value);

const COUNTRY_TERMS = Object.freeze({
  JP: Object.freeze({ normalAnnualRate: 0.02, debtAnnualRate: 0.035 }),
  KR: Object.freeze({ normalAnnualRate: 0.023, debtAnnualRate: 0.042 }),
});

export function createConstructionPriceState(countryId = "JP") {
  const terms = COUNTRY_TERMS[countryId];
  if (!terms) throw new Error(`Unsupported construction price country ${countryId}`);
  return {
    schema: CONSTRUCTION_PRICE_STATE_SCHEMA,
    contractVersion: 1,
    baseYear: 2026,
    baseIndex: 100,
    currentIndex: 100,
    normalAnnualRate: terms.normalAnnualRate,
    lastAdvancedMonth: 0,
    history: [],
  };
}

export function advanceConstructionPriceMonth(state, atMinute, difficulty = "normal") {
  if (state?.schema !== CONSTRUCTION_PRICE_STATE_SCHEMA) throw new Error("Invalid construction price state");
  const month = Math.floor(atMinute / MONTH_MINUTES);
  if (month <= state.lastAdvancedMonth) return { changed: false, month, fromIndex: state.currentIndex, toIndex: state.currentIndex, normalRate: 0 };
  const factor = difficulty === "easy" ? 0.8 : difficulty === "hard" ? 1.25 : 1;
  const annualRate = state.normalAnnualRate * factor;
  const fromIndex = state.currentIndex;
  const monthlyRate = Math.pow(1 + annualRate, 1 / 12) - 1;
  state.currentIndex = round(state.currentIndex * Math.pow(1 + monthlyRate, month - state.lastAdvancedMonth));
  state.lastAdvancedMonth = month;
  const entry = {
    id: `construction-price:normal:${month}`,
    type: "normal",
    month,
    atMinute,
    fromIndex,
    toIndex: state.currentIndex,
    annualRate: round(annualRate),
    monthlyRate: round(monthlyRate, 8),
  };
  state.history.push(entry);
  return { changed: true, ...clone(entry) };
}

export function applyConstructionPriceShock(state, { points, sourceEventId, atMinute } = {}) {
  if (state?.schema !== CONSTRUCTION_PRICE_STATE_SCHEMA) throw new Error("Invalid construction price state");
  if (!Number.isFinite(points) || points <= 0) throw new Error("Construction price shock points must be positive");
  const fromIndex = state.currentIndex;
  state.currentIndex = round(state.currentIndex + points);
  const entry = {
    id: `construction-price:shock:${sourceEventId ?? state.history.length + 1}`,
    type: "shock",
    month: Math.floor((atMinute ?? 0) / MONTH_MINUTES),
    atMinute: atMinute ?? 0,
    sourceEventId: sourceEventId ?? null,
    points: round(points),
    fromIndex,
    toIndex: state.currentIndex,
  };
  state.history.push(entry);
  return clone(entry);
}

export function createOrUpdateConstructionFundingCase(existing, {
  id,
  scheduleId,
  projectId,
  planId,
  priceIndex,
  ownerAdjustmentJPY,
  availableCashJPY,
  atMinute,
} = {}) {
  if (!(ownerAdjustmentJPY > availableCashJPY)) throw new Error("A construction funding case requires an actual funding gap");
  const target = existing ?? {
    schema: CONSTRUCTION_FUNDING_CASE_SCHEMA,
    contractVersion: 1,
    id,
    scheduleId,
    projectId,
    planId,
    status: "open",
    createdAtMinute: atMinute,
    decisions: [],
  };
  target.priceIndex = priceIndex;
  target.ownerAdjustmentJPY = Math.round(ownerAdjustmentJPY);
  target.availableCashJPY = Math.max(0, Math.round(availableCashJPY));
  target.fundingGapJPY = Math.max(1, Math.ceil(ownerAdjustmentJPY - availableCashJPY));
  target.updatedAtMinute = atMinute;
  if (target.status === "auto-funded") target.status = "open";
  return target;
}

export function constructionFundingOptions(fundingCase, countryId = "JP") {
  if (fundingCase?.schema !== CONSTRUCTION_FUNDING_CASE_SCHEMA) throw new Error("Invalid construction funding case");
  const terms = COUNTRY_TERMS[countryId];
  if (!terms) throw new Error(`Unsupported construction finance country ${countryId}`);
  const gap = fundingCase.fundingGapJPY;
  const feeRate = 0.01;
  const debtPrincipalJPY = Math.ceil(gap / (1 - feeRate));
  const monthlyRate = terms.debtAnnualRate / 12;
  const termMonths = 240;
  const monthlyDebtServiceJPY = Math.ceil(debtPrincipalJPY * (monthlyRate * Math.pow(1 + monthlyRate, termMonths)) / (Math.pow(1 + monthlyRate, termMonths) - 1));
  return [
    { id: "supplementary-budget", label: "증액 예산 승인", fundingJPY: gap, delayMonths: 2, debtJPY: 0, futureMonthlyCostJPY: 0 },
    { id: "sponsor-equity", label: "추가 출자", fundingJPY: gap, delayMonths: 0, debtJPY: 0, futureMonthlyCostJPY: Math.ceil(gap * 0.08 / 12) },
    { id: "construction-loan", label: "건설자금 차입", fundingJPY: gap, delayMonths: 1, debtJPY: debtPrincipalJPY, feeJPY: debtPrincipalJPY - gap, annualRate: terms.debtAnnualRate, termMonths, futureMonthlyCostJPY: monthlyDebtServiceJPY },
    { id: "suspend", label: "공사 중단", fundingJPY: 0, delayMonths: null, debtJPY: 0, futureMonthlyCostJPY: 0 },
  ];
}

export function createConstructionFinanceRecord({ id, fundingCase, option, atMinute } = {}) {
  if (!option || option.id === "suspend") throw new Error("A financing record requires a funding option");
  return {
    schema: CONSTRUCTION_FINANCE_SCHEMA,
    contractVersion: 1,
    id,
    fundingCaseId: fundingCase.id,
    projectId: fundingCase.projectId,
    kind: option.id,
    raisedJPY: option.id === "construction-loan" ? option.debtJPY : option.fundingJPY,
    netConstructionFundingJPY: option.fundingJPY,
    feeJPY: option.feeJPY ?? 0,
    annualRate: option.annualRate ?? (option.id === "sponsor-equity" ? 0.08 : 0),
    termMonths: option.termMonths ?? null,
    futureMonthlyCostJPY: option.futureMonthlyCostJPY,
    balanceJPY: option.debtJPY ?? 0,
    status: option.id === "construction-loan" ? "committed" : "recorded",
    createdAtMinute: atMinute,
  };
}
