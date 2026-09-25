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
    bids: [],
    ...structuredClone(input),
  };
}

export function researchOpportunity(opportunity, ledger, clock, level = 1) {
  if (opportunity.status !== "announced") throw new Error("Research is only available before tender close");
  if (![1, 2].includes(level) || level <= opportunity.researchLevel) throw new Error("Research level must increase to 1 or 2");
  const cost = level === 1 ? 35_000_000 : 90_000_000;
  ledger.post({ atMinute: clock.minute, amount: -cost, category: "bid-research", reference: opportunity.id });
  opportunity.researchLevel = level;
  const spread = level === 2 ? 0.05 : 0.12;
  return {
    annualCostRange: [opportunity.baselineAnnualCost * (1 - spread), opportunity.baselineAnnualCost * (1 + spread)],
    demandRange: [opportunity.demandP90, opportunity.demandP50 * (1 + spread)],
    knownRiskCount: level === 2 ? 6 : 3,
  };
}

export function investmentMemo(opportunity, bid) {
  const revenue = bid.requestedAnnualPayment * opportunity.contractYears;
  const p50Cost = opportunity.baselineAnnualCost * opportunity.contractYears;
  const p90Cost = p50Cost * (opportunity.researchLevel ? 1.12 : 1.25);
  return {
    p50Profit: revenue - p50Cost,
    p90Profit: revenue - p90Cost,
    bidCost: opportunity.preparationCost,
    priceToCost: bid.requestedAnnualPayment / opportunity.baselineAnnualCost,
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
  opportunity.status = "preferred-bidder";
  opportunity.ranking = ranking;
  opportunity.preferredBidderId = ranking[0].bidderId;
  return { status: opportunity.status, ranking };
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
