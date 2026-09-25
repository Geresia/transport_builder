export function npv(rate, cashflows) {
  return cashflows.reduce((sum, value, year) => sum + value / Math.pow(1 + rate, year), 0);
}

export function irr(cashflows, low = -0.99, high = 10, iterations = 200) {
  let a = low;
  let b = high;
  let fa = npv(a, cashflows);
  let fb = npv(b, cashflows);
  if (fa * fb > 0) return null;
  for (let i = 0; i < iterations; i++) {
    const mid = (a + b) / 2;
    const fm = npv(mid, cashflows);
    if (Math.abs(fm) < 1e-6) return mid;
    if (fa * fm <= 0) {
      b = mid;
      fb = fm;
    } else {
      a = mid;
      fa = fm;
    }
  }
  return (a + b) / 2;
}

export function economicAssessment({ socialBenefits, socialCosts, companyCashflows, debtService = [] }) {
  const benefitCostRatio = socialCosts > 0 ? socialBenefits / socialCosts : null;
  const companyNpv = npv(0.06, companyCashflows);
  const companyIrr = irr(companyCashflows);
  const operatingCash = companyCashflows.slice(1);
  const dscr = debtService.map((debt, index) => debt > 0 ? operatingCash[index] / debt : null);
  return {
    benefitCostRatio,
    sociallyViable: benefitCostRatio !== null && benefitCostRatio >= 1,
    companyNpv,
    companyIrr,
    commerciallyViable: companyNpv >= 0,
    dscr,
    minimumDscr: dscr.filter((value) => value !== null).reduce((min, value) => Math.min(min, value), Infinity),
  };
}

export function createProjectFinance({ id, equity, debt, annualRate, termYears }) {
  if (equity < 0 || debt < 0 || equity + debt <= 0 || annualRate < 0 || termYears <= 0) throw new Error("Invalid project finance terms");
  const annualDebtService = annualRate === 0 ? debt / termYears : debt * (annualRate * Math.pow(1 + annualRate, termYears)) / (Math.pow(1 + annualRate, termYears) - 1);
  return { id, equity, debt, annualRate, termYears, annualDebtService, balance: debt, status: "financial-close" };
}
