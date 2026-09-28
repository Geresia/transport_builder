const STRATEGIES = [
  { id: "reliable", priceBias: 1.05, technical: 90, riskTolerance: 0.55 },
  { id: "value", priceBias: 0.96, technical: 78, riskTolerance: 0.72 },
  { id: "premium", priceBias: 1.12, technical: 94, riskTolerance: 0.45 },
  { id: "aggressive", priceBias: 0.9, technical: 69, riskTolerance: 0.86 },
  { id: "regional", priceBias: 1, technical: 81, riskTolerance: 0.63 },
];

export function createCompetitors() {
  return STRATEGIES.map((strategy, index) => ({
    id: `competitor-${index + 1}`,
    name: `Transit Group ${index + 1}`,
    cash: 35_000_000_000 + index * 7_000_000_000,
    reputation: 62 + index * 6,
    operatingScore: strategy.technical,
    bidCapacity: 2 + (index % 3),
    activeBids: 0,
    backlog: index % 3,
    homeCountry: index === 4 ? "KR" : "JP",
    strategy,
  }));
}

export function createOpportunity(input) {
  const required = ["id", "title", "deadlineMinute", "contractYears", "baselineAnnualCost", "minimumTechnical"];
  for (const key of required) if (input[key] === undefined) throw new Error(`Opportunity requires ${key}`);
  return {
    type: "public-om",
    fixedAnnualPayment: input.baselineAnnualCost * 1.08,
    demandP50: 20_000_000,
    demandP90: 16_000_000,
    qualification: { minimumCash: 5_000_000_000, minimumReputation: 55, ...input.qualification },
    preparationCost: 120_000_000,
    bidBond: 500_000_000,
    status: "announced",
    researchLevel: 0,
    retenderCount: 0,
    singleBidReview: null,
    bids: [],
    ...structuredClone(input),
  };
}

export function researchOpportunity(opportunity, ledger, clock, level = 1) {
  if (opportunity.status !== "announced") throw new Error("Research is only available before tender close");
  if (![1, 2].includes(level) || level <= opportunity.researchLevel) throw new Error("Research level must increase to 1 or 2");
  const cost = opportunity.researchCosts?.[level] ?? (level === 1 ? 35_000_000 : 90_000_000);
  ledger.post({ atMinute: clock.minute, amount: -cost, category: "bid-research", reference: opportunity.id });
  opportunity.researchLevel = level;
  const spread = level === 2 ? 0.05 : 0.12;
  const annualCost = opportunity.type === "design-build-operate" ? opportunity.baselineOperatingCost : opportunity.baselineAnnualCost;
  const report = {
    level,
    cost,
    annualCostRange: [annualCost * (1 - spread), annualCost * (1 + spread)],
    demandRange: [opportunity.demandP90, opportunity.demandP50 * (1 + spread)],
    knownRiskCount: level === 2 ? 8 : 4,
  };
  if (opportunity.type === "design-build-operate") {
    const capital = opportunity.estimatedCapitalCost ?? opportunity.scope?.maximumPublicCost ?? 0;
    const capitalSpread = level === 2 ? 0.08 : 0.18;
    report.capitalCostRange = [capital * (1 - capitalSpread), capital * (1 + capitalSpread)];
    report.knownRisks = level === 2
      ? ["ground", "groundwater", "utilities", "property-rights", "community", "inflation", "interfaces", "ridership"]
      : ["alignment", "major-structures", "ridership", "procurement"];
    report.confidence = level === 2 ? "detailed-due-diligence" : "desktop-and-preliminary";
  }
  opportunity.researchReport = structuredClone(report);
  return report;
}

export function investmentMemo(opportunity, bid) {
  const revenue = bid.requestedAnnualPayment * opportunity.contractYears;
  const operatingCost = (opportunity.baselineOperatingCost ?? opportunity.baselineAnnualCost) * opportunity.contractYears;
  const capitalCost = opportunity.type === "design-build-operate" ? opportunity.estimatedCapitalCost ?? 0 : 0;
  const p50Cost = operatingCost + capitalCost;
  const p90Factor = opportunity.researchLevel === 2 ? 1.08 : opportunity.researchLevel === 1 ? 1.16 : 1.25;
  const p90Cost = operatingCost * (opportunity.researchLevel ? 1.12 : 1.25) + capitalCost * p90Factor;
  return {
    p50Profit: revenue - p50Cost,
    p90Profit: revenue - p90Cost,
    bidCost: opportunity.preparationCost,
    priceToCost: revenue / p50Cost,
    recommendation: revenue >= p90Cost ? "bid" : revenue >= p50Cost ? "conditional" : "no-bid",
  };
}

function qualifies(company, opportunity) {
  return company.cash >= opportunity.qualification.minimumCash &&
    company.reputation >= opportunity.qualification.minimumReputation &&
    company.activeBids < company.bidCapacity;
}

export function submitPlayerBid(opportunity, company, ledger, clock, proposal) {
  if (clock.minute > opportunity.deadlineMinute || opportunity.status !== "announced") throw new Error("Tender is closed");
  if (!qualifies(company, opportunity)) throw new Error("Player does not meet tender qualification");
  if (!(proposal.requestedAnnualPayment > 0) || !(proposal.technicalScore >= 0 && proposal.technicalScore <= 100)) throw new Error("Invalid proposal");
  ledger.post({ atMinute: clock.minute, amount: -opportunity.preparationCost, category: "bid-preparation", reference: opportunity.id });
  ledger.commit({ id: `bond:${opportunity.id}`, atMinute: clock.minute, amount: opportunity.bidBond, category: "bid-bond", reference: opportunity.id });
  const bid = { id: `bid:${opportunity.id}:player`, bidderId: company.id, isPlayer: true, submittedAt: clock.minute, ...structuredClone(proposal) };
  opportunity.bids.push(bid);
  company.activeBids++;
  return bid;
}

export function generateCompetitorBids(opportunity, competitors, rng) {
  const bids = [];
  for (const company of competitors) {
    if (!qualifies(company, opportunity)) continue;
    const attractiveness = 0.35 + company.strategy.riskTolerance * 0.45 - company.backlog * 0.08;
    if (rng.next() > attractiveness) continue;
    const noise = 0.94 + rng.next() * 0.12;
    const bid = {
      id: `bid:${opportunity.id}:${company.id}`,
      bidderId: company.id,
      isPlayer: false,
      requestedAnnualPayment: opportunity.baselineAnnualCost * company.strategy.priceBias * noise,
      technicalScore: Math.max(0, Math.min(100, company.operatingScore + (rng.next() - 0.5) * 8)),
      staffingScore: Math.max(50, company.operatingScore - 4 + rng.next() * 8),
      submittedAt: opportunity.deadlineMinute,
    };
    bids.push(bid);
    company.activeBids++;
  }
  opportunity.bids.push(...bids);
  return bids;
}

export function evaluateTender(opportunity) {
  if (opportunity.bids.length === 0) {
    opportunity.status = "failed-no-bids";
    return { status: opportunity.status, ranking: [] };
  }
  const eligible = opportunity.bids.filter((bid) => bid.technicalScore >= opportunity.minimumTechnical);
  if (!eligible.length) {
    opportunity.status = "failed-technical";
    return { status: opportunity.status, ranking: [] };
  }
  const lowest = Math.min(...eligible.map((bid) => bid.requestedAnnualPayment));
  const ranking = eligible.map((bid) => ({
    ...bid,
    priceScore: Math.min(100, (lowest / bid.requestedAnnualPayment) * 100),
    totalScore: bid.technicalScore * 0.55 + Math.min(100, (lowest / bid.requestedAnnualPayment) * 100) * 0.45,
  })).sort((a, b) => b.totalScore - a.totalScore || a.requestedAnnualPayment - b.requestedAnnualPayment);
  opportunity.ranking = ranking;
  opportunity.preferredBidderId = ranking[0].bidderId;
  if (eligible.length === 1) {
    opportunity.status = "single-bid-review";
    opportunity.singleBidReview = { required: true, status: "pending", bidderId: ranking[0].bidderId };
    return { status: opportunity.status, ranking, singleBidReview: structuredClone(opportunity.singleBidReview) };
  }
  opportunity.status = "preferred-bidder";
  opportunity.singleBidReview = null;
  return { status: opportunity.status, ranking };
}

export function reviewSingleBid(opportunity, accepted = true) {
  if (opportunity.status !== "single-bid-review" || opportunity.singleBidReview?.status !== "pending") {
    throw new Error("No single-bid review is pending");
  }
  opportunity.singleBidReview.status = accepted ? "approved" : "rejected";
  if (!accepted) {
    opportunity.status = "retender";
    delete opportunity.preferredBidderId;
    return { accepted: false, status: opportunity.status };
  }
  opportunity.status = "preferred-bidder";
  return { accepted: true, status: opportunity.status, preferredBidderId: opportunity.preferredBidderId };
}

export function reannounceOpportunity(opportunity, clock, { deadlineDays = 90, paymentAdjustment = 1.05 } = {}) {
  const allowed = ["failed-no-bids", "failed-technical", "retender"];
  if (!allowed.includes(opportunity.status)) throw new Error(`Opportunity cannot be reannounced from ${opportunity.status}`);
  if (!Number.isInteger(deadlineDays) || deadlineDays < 1) throw new Error("Retender deadline days must be a positive integer");
  if (!(paymentAdjustment > 0)) throw new Error("Retender payment adjustment must be positive");
  opportunity.retenderCount = (opportunity.retenderCount ?? 0) + 1;
  opportunity.status = "announced";
  opportunity.deadlineMinute = clock.minute + deadlineDays * 1440;
  opportunity.baselineAnnualCost *= paymentAdjustment;
  opportunity.fixedAnnualPayment *= paymentAdjustment;
  opportunity.bids = [];
  opportunity.ranking = [];
  opportunity.singleBidReview = null;
  opportunity.viewedAt = null;
  delete opportunity.preferredBidderId;
  delete opportunity.awardedBidderId;
  delete opportunity.investmentDecision;
  return opportunity;
}

export function negotiateAward(opportunity, bidderId, accepted = true) {
  if (opportunity.status !== "preferred-bidder") throw new Error("No preferred bidder to negotiate with");
  const index = opportunity.ranking.findIndex((bid) => bid.bidderId === bidderId);
  if (index < 0) throw new Error(`Bidder ${bidderId} is not ranked`);
  if (!accepted) {
    opportunity.ranking.splice(index, 1);
    if (!opportunity.ranking.length) {
      opportunity.status = "retender";
      delete opportunity.preferredBidderId;
      return null;
    }
    opportunity.preferredBidderId = opportunity.ranking[0].bidderId;
    return null;
  }
  const bid = opportunity.ranking[index];
  opportunity.status = "awarded";
  opportunity.awardedBidderId = bidderId;
  return {
    id: `contract:${opportunity.id}`,
    type: opportunity.type,
    opportunityId: opportunity.id,
    operatorId: bidderId,
    startMinute: opportunity.deadlineMinute + 30 * 1440,
    endMinute: opportunity.deadlineMinute + (30 + opportunity.contractYears * 365) * 1440,
    annualPayment: bid.requestedAnnualPayment,
    kpi: { punctualityTarget: 0.97, availabilityTarget: 0.985, maxDeductionRate: 0.12, bonusRate: 0.03 },
    status: "signed",
  };
}
