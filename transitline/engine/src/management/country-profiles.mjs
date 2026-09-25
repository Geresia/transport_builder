const shared = {
  currency: "JPY",
  priceBaseYear: 2026,
  fareRules: { transferSettlement: true, publicServicePayment: true },
};

export const COUNTRY_PROFILES = Object.freeze({
  JP: Object.freeze({
    ...shared,
    id: "JP",
    name: "Japan",
    approvalStages: ["urban-plan", "railway-business-permit", "construction-approval", "safety-inspection", "opening-approval"],
    procurementTemplates: ["public-om", "design-build", "concession", "private-railway-development"],
    fundingTemplates: ["operator-equity", "public-grant", "availability-payment", "fare-revenue"],
    landAndUndergroundRights: { deepUndergroundAvailable: true, negotiationModifier: 0.9 },
    vehicleApprovalModel: "type-and-line-integration",
    laborIndex: 1,
    priceIndex: 1,
    disputeDelayModifier: 0.85,
    constructionCostModifier: 1,
    approvalMonths: 30,
  }),
  KR: Object.freeze({
    ...shared,
    id: "KR",
    name: "South Korea",
    approvalStages: ["pre-feasibility", "basic-plan", "urban-rail-plan", "project-approval", "safety-validation", "opening-approval"],
    procurementTemplates: ["public-works", "turnkey", "bto", "availability-payment"],
    fundingTemplates: ["national-budget", "local-budget", "private-capital", "fare-revenue"],
    landAndUndergroundRights: { deepUndergroundAvailable: true, negotiationModifier: 1.15 },
    vehicleApprovalModel: "type-approval-and-complete-inspection",
    laborIndex: 0.78,
    priceIndex: 0.88,
    disputeDelayModifier: 1.15,
    constructionCostModifier: 0.84,
    approvalMonths: 36,
  }),
});

export function getCountryProfile(countryId) {
  const profile = COUNTRY_PROFILES[countryId];
  if (!profile) throw new Error(`Unsupported country ${countryId}`);
  return profile;
}
