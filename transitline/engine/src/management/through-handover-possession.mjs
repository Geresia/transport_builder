export const THROUGH_HANDOVER_POSSESSION_SCHEMA = "transitline.through-handover-possession-plan/1";

export const THROUGH_HANDOVER_POSSESSION_STRATEGIES = Object.freeze({
  "night-only": Object.freeze({
    id: "night-only", label: "Night-only possessions", capacityFactor: 0.92, punctualityPenalty: 0.01,
    disruptedDaysEquivalentPerMonth: 2, replacementTransportJPYPerMonth: 60_000_000,
    coordinationJPYPerMonth: 20_000_000, contractCostFactor: 1.04, constructionDurationFactor: 1.2,
  }),
  "weekend-blockade": Object.freeze({
    id: "weekend-blockade", label: "Weekend blockades", capacityFactor: 0.78, punctualityPenalty: 0.025,
    disruptedDaysEquivalentPerMonth: 5, replacementTransportJPYPerMonth: 140_000_000,
    coordinationJPYPerMonth: 45_000_000, contractCostFactor: 1.08, constructionDurationFactor: 0.92,
  }),
  "intensive-closure": Object.freeze({
    id: "intensive-closure", label: "Intensive closure", capacityFactor: 0.45, punctualityPenalty: 0.06,
    disruptedDaysEquivalentPerMonth: 12, replacementTransportJPYPerMonth: 320_000_000,
    coordinationJPYPerMonth: 90_000_000, contractCostFactor: 1.18, constructionDurationFactor: 0.7,
  }),
});

const clone = (value) => structuredClone(value);
const money = (value) => Math.round(value);

function assertProject(project) {
  if (project?.schema !== "transitline.through-handover-project/1" || project.contractVersion !== 1) throw new Error("ThroughHandoverProject v1 is required");
}

function baselineRows(affectedServiceIds, baselineDailyRevenueJPYByService) {
  const ids = [...new Set((affectedServiceIds ?? []).map(String))].sort();
  if (!ids.length) throw new Error("At least one affected service is required for a possession plan");
  return ids.map((serviceId) => {
    const baselineDailyRevenueJPY = Number(baselineDailyRevenueJPYByService?.[serviceId]);
    if (!(baselineDailyRevenueJPY >= 0) || !Number.isFinite(baselineDailyRevenueJPY)) throw new Error(`A known non-negative daily revenue baseline is required for ${serviceId}`);
    return { serviceId, baselineDailyRevenueJPY: money(baselineDailyRevenueJPY) };
  });
}

export function createThroughHandoverPossessionPlan({ id, project, strategyId = "night-only", affectedServiceIds, baselineDailyRevenueJPYByService, atMinute = 0 } = {}) {
  assertProject(project);
  if (!id) throw new Error("Through handover possession plan requires an id");
  if (!["proposed", "permitted"].includes(project.status)) throw new Error(`Possession planning cannot start from ${project.status}`);
  const strategy = THROUGH_HANDOVER_POSSESSION_STRATEGIES[strategyId];
  if (!strategy) throw new Error(`Unknown through handover possession strategy ${strategyId}`);
  const affectedServices = baselineRows(affectedServiceIds, baselineDailyRevenueJPYByService);
  const constructionMonths = project.phasesMonths?.constructionMonths;
  if (!(constructionMonths > 0)) throw new Error("A priced through handover project is required for possession planning");
  const expectedConstructionMonths = Math.max(1, Math.ceil(constructionMonths * strategy.constructionDurationFactor));
  const expectedLostRevenueJPYPerMonth = money(affectedServices.reduce((sum, entry) => sum + entry.baselineDailyRevenueJPY, 0) * strategy.disruptedDaysEquivalentPerMonth);
  const directCashCostJPYPerMonth = strategy.replacementTransportJPYPerMonth + strategy.coordinationJPYPerMonth;
  return {
    schema: THROUGH_HANDOVER_POSSESSION_SCHEMA,
    contractVersion: 1,
    id,
    throughHandoverProjectId: project.id,
    throughRouteId: project.throughRouteId,
    routeGeometryRevision: project.routeGeometryRevision,
    handoverId: project.handoverId,
    strategyId,
    strategy: clone(strategy),
    affectedServices,
    forecast: {
      expectedConstructionMonths,
      expectedLostRevenueJPYPerMonth,
      replacementTransportJPYPerMonth: strategy.replacementTransportJPYPerMonth,
      coordinationJPYPerMonth: strategy.coordinationJPYPerMonth,
      directCashCostJPYPerMonth,
      expectedLostRevenueJPY: expectedLostRevenueJPYPerMonth * expectedConstructionMonths,
      expectedDirectCashCostJPY: directCashCostJPYPerMonth * expectedConstructionMonths,
    },
    status: "planned",
    createdAtMinute: atMinute,
    lastSettledMonth: null,
    settlements: [],
    totals: { months: 0, lostRevenueExposureJPY: 0, replacementTransportJPY: 0, coordinationJPY: 0, directCashCostJPY: 0 },
  };
}

export function possessionTenderFactors(plan) {
  if (!plan) return { contractCostFactor: 1, constructionDurationFactor: 1 };
  if (plan.schema !== THROUGH_HANDOVER_POSSESSION_SCHEMA || plan.contractVersion !== 1) throw new Error("ThroughHandoverPossessionPlan v1 is required");
  return {
    contractCostFactor: plan.strategy.contractCostFactor,
    constructionDurationFactor: plan.strategy.constructionDurationFactor,
  };
}

export function settleThroughHandoverPossessionMonth(plan, project, { ledger, clock } = {}) {
  assertProject(project);
  if (plan?.schema !== THROUGH_HANDOVER_POSSESSION_SCHEMA || plan.contractVersion !== 1) throw new Error("ThroughHandoverPossessionPlan v1 is required");
  if (plan.throughHandoverProjectId !== project.id) throw new Error("Possession plan belongs to another project");
  if (!["contracted", "under-construction"].includes(project.status)) return null;
  const month = Math.floor(clock.minute / (30 * 1440));
  if (plan.lastSettledMonth !== null && month <= plan.lastSettledMonth) return null;
  const replacementTransportJPY = plan.strategy.replacementTransportJPYPerMonth;
  const coordinationJPY = plan.strategy.coordinationJPYPerMonth;
  const directCashCostJPY = replacementTransportJPY + coordinationJPY;
  if (directCashCostJPY > 0) ledger.post({ atMinute: clock.minute, amount: -directCashCostJPY, category: "through-handover-possession", reference: project.id, memo: plan.strategy.label });
  const lostRevenueExposureJPY = plan.forecast.expectedLostRevenueJPYPerMonth;
  const settlement = {
    id: `through-handover-possession-settlement:${plan.id}:${month}`,
    month,
    atMinute: clock.minute,
    strategyId: plan.strategyId,
    lostRevenueExposureJPY,
    replacementTransportJPY,
    coordinationJPY,
    directCashCostJPY,
  };
  plan.status = "active";
  plan.lastSettledMonth = month;
  plan.settlements.push(settlement);
  plan.totals.months++;
  plan.totals.lostRevenueExposureJPY += lostRevenueExposureJPY;
  plan.totals.replacementTransportJPY += replacementTransportJPY;
  plan.totals.coordinationJPY += coordinationJPY;
  plan.totals.directCashCostJPY += directCashCostJPY;
  return clone(settlement);
}

export function closeThroughHandoverPossessionPlan(plan, project, atMinute = 0) {
  if (!plan) return null;
  plan.status = project.status === "available" ? "completed" : project.status === "cancelled" ? "cancelled" : plan.status;
  if (["completed", "cancelled"].includes(plan.status)) plan.closedAtMinute ??= atMinute;
  return clone(plan);
}

export function throughHandoverPossessionImpact(projects, serviceId) {
  const active = projects.filter((project) => ["contracted", "under-construction"].includes(project.status)
    && project.possessionPlan?.affectedServices?.some((entry) => entry.serviceId === serviceId));
  if (!active.length) return { capacityFactor: 1, punctualityPenalty: 0, activePlanIds: [] };
  return {
    capacityFactor: active.reduce((factor, project) => factor * project.possessionPlan.strategy.capacityFactor, 1),
    punctualityPenalty: active.reduce((sum, project) => sum + project.possessionPlan.strategy.punctualityPenalty, 0),
    activePlanIds: active.map((project) => project.possessionPlan.id).sort(),
  };
}
