import { npv } from "./finance.mjs";

export function createConsortium({ id, name, members }) {
  if (!id || !name || !Array.isArray(members) || members.length < 2) throw new Error("A consortium requires an id, name and at least two members");
  const totalShare = members.reduce((sum, member) => sum + member.share, 0);
  if (Math.abs(totalShare - 1) > 1e-9) throw new Error("Consortium shares must total 1");
  if (members.some((member) => member.share <= 0 || !member.companyId)) throw new Error("Each consortium member requires a positive share and company id");
  return {
    id,
    name,
    members: structuredClone(members),
    leadCompanyId: [...members].sort((a, b) => b.share - a.share)[0].companyId,
    status: "formed",
  };
}

export function createSpv({ id, consortium, equity, debt, projectId }) {
  if (!(equity > 0) || !(debt >= 0)) throw new Error("SPV capital must be valid");
  return {
    id,
    projectId,
    shareholders: consortium.members.map((member) => ({ companyId: member.companyId, share: member.share, committedEquity: equity * member.share })),
    paidInEquity: 0,
    debt,
    cash: 0,
    status: "pre-financial-close",
  };
}

export function fundSpv(spv, companies) {
  if (spv.status !== "pre-financial-close") throw new Error("SPV cannot be funded in its current state");
  for (const shareholder of spv.shareholders) {
    const company = companies.find((item) => item.id === shareholder.companyId);
    if (!company || company.cash < shareholder.committedEquity) throw new Error(`Shareholder ${shareholder.companyId} cannot fund its equity`);
  }
  for (const shareholder of spv.shareholders) {
    const company = companies.find((item) => item.id === shareholder.companyId);
    company.cash -= shareholder.committedEquity;
    spv.paidInEquity += shareholder.committedEquity;
    spv.cash += shareholder.committedEquity;
  }
  spv.status = "equity-funded";
  return spv;
}

const CONTRACT_TEMPLATES = {
  bto: { ownershipDuringTerm: "private", revenueRisk: "operator", publicPayment: false },
  availability: { ownershipDuringTerm: "public", revenueRisk: "authority", publicPayment: true },
  second_type_om: { ownershipDuringTerm: "infrastructure-owner", revenueRisk: "shared", publicPayment: true },
  public_works: { ownershipDuringTerm: "public", revenueRisk: "authority", publicPayment: false },
};

export function createAdvancedContract({ id, template, termYears, value, parties, riskAllocation = {} }) {
  const base = CONTRACT_TEMPLATES[template];
  if (!base) throw new Error(`Unknown contract template ${template}`);
  if (!(termYears > 0) || !(value > 0) || !Array.isArray(parties) || parties.length < 2) throw new Error("Invalid contract terms");
  return {
    id,
    template,
    termYears,
    value,
    parties: structuredClone(parties),
    ...base,
    riskAllocation: {
      demand: base.revenueRisk,
      construction: "operator",
      land: "authority",
      forceMajeure: "shared",
      inflation: "shared",
      ...structuredClone(riskAllocation),
    },
    status: "effective",
    amendments: [],
  };
}

export function requestRenegotiation(contract, trigger) {
  if (contract.status !== "effective") throw new Error("Only effective contracts can be renegotiated");
  const allowed = ["force-majeure", "authority-delay", "law-change", "extreme-inflation"];
  if (!allowed.includes(trigger.type)) return { accepted: false, reason: "Trigger is retained by the requesting party" };
  const amendment = {
    number: contract.amendments.length + 1,
    trigger: trigger.type,
    valueAdjustment: trigger.verifiedCost * (trigger.sharedRatio ?? 0.5),
    termExtensionMonths: Math.max(0, trigger.delayMonths ?? 0),
  };
  contract.value += amendment.valueAdjustment;
  contract.termYears += amendment.termExtensionMonths / 12;
  contract.amendments.push(amendment);
  return { accepted: true, amendment };
}

export function closeProjectFinance(spv, finance) {
  if (spv.status !== "equity-funded") throw new Error("Equity must be funded before financial close");
  if (Math.abs(finance.debt - spv.debt) > 1e-6) throw new Error("Finance debt does not match SPV debt commitment");
  spv.cash += finance.debt;
  spv.finance = structuredClone(finance);
  spv.status = "financial-close";
  return spv;
}

export function serviceDebtYear(spv, cashAvailableForDebtService) {
  if (spv.status !== "financial-close" && spv.status !== "operating") throw new Error("SPV has no active financing");
  const due = Math.min(spv.finance.annualDebtService, spv.finance.balance * (1 + spv.finance.annualRate));
  const paid = Math.min(due, cashAvailableForDebtService, spv.cash);
  const interest = Math.min(paid, spv.finance.balance * spv.finance.annualRate);
  const principal = Math.max(0, paid - interest);
  spv.cash -= paid;
  spv.finance.balance = Math.max(0, spv.finance.balance - principal);
  const dscr = due > 0 ? cashAvailableForDebtService / due : Infinity;
  if (paid + 1e-6 < due) spv.status = "default";
  else if (spv.finance.balance <= 1e-6) spv.status = "debt-repaid";
  else spv.status = "operating";
  return { due, paid, interest, principal, dscr, defaulted: spv.status === "default" };
}

export function resolveDefault(spv, { replacementOperatorAvailable, projectEssential = true }) {
  if (spv.status !== "default") throw new Error("SPV is not in default");
  if (projectEssential && replacementOperatorAvailable) {
    spv.status = "lender-step-in";
    return "lender-step-in";
  }
  spv.status = projectEssential ? "retender" : "terminated";
  return spv.status;
}

export function mergeCompanies(acquirer, target, price) {
  if (!(price > 0) || acquirer.cash < price) throw new Error("Acquirer cannot fund the transaction");
  acquirer.cash -= price;
  acquirer.cash += target.cash;
  acquirer.reputation = (acquirer.reputation + target.reputation) / 2;
  acquirer.operatingScore = Math.max(acquirer.operatingScore, target.operatingScore);
  acquirer.bidCapacity += Math.max(1, Math.floor(target.bidCapacity / 2));
  acquirer.backlog += target.backlog;
  target.status = "acquired";
  target.cash = 0;
  return acquirer;
}

export function createMarketEntrant({ id, name, capital, role, countryId }) {
  if (!(capital > 0) || !["operator", "constructor", "manufacturer", "financier"].includes(role)) throw new Error("Invalid market entrant");
  return { id, name, cash: capital, role, homeCountry: countryId, reputation: 50, operatingScore: 60, bidCapacity: 1, activeBids: 0, backlog: 0, status: "active" };
}

export function detailedEngineeringAssessment(plan, profile) {
  const findings = [];
  let costMultiplier = 1;
  let durationMultiplier = 1;
  for (const [index, segment] of (plan.segments ?? []).entries()) {
    const rise = Math.abs((segment.elevationEndMeters ?? 0) - (segment.elevationStartMeters ?? 0));
    const gradientPermille = segment.lengthMeters > 0 ? rise / segment.lengthMeters * 1000 : Infinity;
    if (gradientPermille > (profile.maxGradientPermille ?? 35)) findings.push({ segment: index, severity: "violation", type: "gradient", value: gradientPermille });
    if (segment.curveRadiusMeters !== undefined && segment.curveRadiusMeters < (profile.minimumCurveRadiusMeters ?? 160)) findings.push({ segment: index, severity: "violation", type: "curve-radius", value: segment.curveRadiusMeters });
    if (segment.groundwater === "high" && ["cut-cover", "shield", "deep"].includes(segment.structureHint)) {
      findings.push({ segment: index, severity: "risk", type: "groundwater" });
      costMultiplier += 0.12;
      durationMultiplier += 0.08;
    }
    if ((segment.utilityCrossings ?? 0) > 0) {
      findings.push({ segment: index, severity: "risk", type: "utilities", count: segment.utilityCrossings });
      costMultiplier += Math.min(0.2, segment.utilityCrossings * 0.015);
      durationMultiplier += Math.min(0.15, segment.utilityCrossings * 0.01);
    }
    if (segment.seismicClass === "high") {
      costMultiplier += 0.08;
      findings.push({ segment: index, severity: "requirement", type: "seismic-reinforcement" });
    }
  }
  return { feasible: !findings.some((item) => item.severity === "violation"), findings, costMultiplier, durationMultiplier };
}

export function constructionRiskDistribution({ countryProfile, undergroundShare, lowQualityShare, communityExposure }) {
  const normalize = (value) => Math.max(0, Math.min(0.95, value));
  return {
    geology: normalize(0.03 + undergroundShare * 0.16 + lowQualityShare * 0.12),
    inflation: normalize(0.08 * countryProfile.priceIndex),
    procurement: normalize(0.05 + lowQualityShare * 0.08),
    accident: normalize(0.018 + undergroundShare * 0.025),
    community: normalize(0.04 * countryProfile.disputeDelayModifier + communityExposure * 0.14),
  };
}

export function createD2Depot(input) {
  if (!(input.capacitySets > 0) || !(input.heavyInspectionBays > 0)) throw new Error("D2 depot requires storage and heavy inspection bays");
  return {
    id: input.id,
    type: "D2",
    capacitySets: input.capacitySets,
    dailyInspectionSets: input.dailyInspectionSets ?? 3,
    heavyInspectionBays: input.heavyInspectionBays,
    wheelLathe: input.wheelLathe ?? true,
    liftingCapacityCars: input.liftingCapacityCars ?? 4,
    annualFixedCost: input.annualFixedCost ?? input.capacitySets * 180_000_000,
    status: "secured",
  };
}

export function ageVehicleFleet(units, annualKm, years, reliability) {
  for (const unit of units) {
    unit.ageYears = (unit.ageYears ?? 0) + years;
    unit.mileageKm += annualKm * years;
    unit.condition = Math.max(0.35, (unit.condition ?? 1) - years * (0.012 + annualKm / 20_000_000));
    unit.failureProbability = Math.min(0.4, (1 - reliability) * (1 + unit.ageYears / 18) / unit.condition);
    if (unit.mileageKm >= unit.nextInspectionKm) unit.status = "inspection-due";
  }
  return units;
}

export function evaluateLease({ annualLease, years, residualRisk, purchasePrice, discountRate = 0.06 }) {
  const leaseCashflows = [0, ...Array(years).fill(-annualLease), -residualRisk];
  const purchaseCashflows = [-purchasePrice, ...Array(years).fill(0)];
  const leaseNpv = npv(discountRate, leaseCashflows);
  const purchaseNpv = npv(discountRate, purchaseCashflows);
  return { leaseNpv, purchaseNpv, preferred: leaseNpv > purchaseNpv ? "lease" : "purchase" };
}
