import { VEHICLE_MODELS } from "./rolling-stock.mjs";

export const VEHICLE_FAILURE_SCHEMA = "transitline.vehicle-failure/1";

const severityProfile = Object.freeze({
  minor: { repairDays: 1, priceFactor: 0.0002, delayMinutes: 8 },
  major: { repairDays: 3, priceFactor: 0.0008, delayMinutes: 24 },
  critical: { repairDays: 7, priceFactor: 0.0025, delayMinutes: 55 },
});

function severityFromRoll(value) {
  if (value < 0.75) return "minor";
  if (value < 0.95) return "major";
  return "critical";
}

export function advanceVehicleRepairs(units, days = 1, atMinute = 0) {
  const restoredUnitIds = [];
  for (const unit of units.filter((entry) => entry.status === "repairing")) {
    unit.repairDaysRemaining = Math.max(0, (unit.repairDaysRemaining ?? 1) - days);
    if (unit.repairDaysRemaining > 0) continue;
    unit.status = "available";
    unit.repairDaysRemaining = 0;
    unit.lastRepairedAtMinute = atMinute;
    unit.condition = Math.min(1, (unit.condition ?? 1) + 0.025);
    if (Number.isFinite(unit.failureProbability)) unit.failureProbability = Math.max(0, unit.failureProbability * 0.45);
    restoredUnitIds.push(unit.id);
  }
  return restoredUnitIds;
}

export function dispatchVehicleFleet({ units = [], modelId, requiredSets, days = 1, rng, ledger, clock, serviceId = null } = {}) {
  const model = VEHICLE_MODELS[modelId];
  if (!model) throw new Error(`Unknown vehicle model ${modelId}`);
  if (!rng?.next) throw new Error("Vehicle dispatch requires a deterministic RNG");
  const restoredUnitIds = advanceVehicleRepairs(units, days, clock?.minute ?? 0);
  const requestedSets = Math.max(0, Math.floor(requiredSets ?? 0));
  const available = units.filter((unit) => unit.status === "available")
    .sort((a, b) => (b.condition ?? 1) - (a.condition ?? 1) || a.id.localeCompare(b.id));
  const primary = available.slice(0, requestedSets);
  const reserves = available.slice(requestedSets);
  const operatingUnitIds = [];
  const reserveSubstitutionUnitIds = [];
  const incidents = [];
  let repairCostJPY = 0;
  let delayMinutes = 0;

  for (const unit of primary) {
    // failureProbability is a condition-derived monthly indicator. Convert it
    // to a bounded operating-day probability before rolling an event.
    const monthlyIndicator = Math.max(0, unit.failureProbability ?? (1 - model.reliability));
    const dailyProbability = Math.min(0.25, monthlyIndicator / 30);
    if (rng.next() >= dailyProbability) {
      operatingUnitIds.push(unit.id);
      continue;
    }
    const severity = severityFromRoll(rng.next());
    const profile = severityProfile[severity];
    const replacement = reserves.shift() ?? null;
    const costJPY = Math.round(model.pricePerSet * profile.priceFactor);
    unit.status = "repairing";
    unit.repairDaysRemaining = profile.repairDays;
    unit.failureCount = (unit.failureCount ?? 0) + 1;
    unit.lastFailureAtMinute = clock?.minute ?? 0;
    unit.condition = Math.max(0.35, (unit.condition ?? 1) - (severity === "critical" ? 0.04 : severity === "major" ? 0.02 : 0.008));
    if (replacement) {
      operatingUnitIds.push(replacement.id);
      reserveSubstitutionUnitIds.push(replacement.id);
      delayMinutes += Math.max(3, Math.round(profile.delayMinutes * 0.35));
    } else {
      delayMinutes += profile.delayMinutes;
    }
    repairCostJPY += costJPY;
    incidents.push({
      schema: VEHICLE_FAILURE_SCHEMA,
      contractVersion: 1,
      id: `vehicle-failure:${unit.id}:${clock?.minute ?? 0}:${unit.failureCount}`,
      atMinute: clock?.minute ?? 0,
      serviceId,
      unitId: unit.id,
      severity,
      dailyProbability,
      repairDays: profile.repairDays,
      repairCostJPY: costJPY,
      replacementUnitId: replacement?.id ?? null,
      serviceImpact: replacement ? "reserve-substitution" : "cancelled-diagram",
    });
  }

  if (repairCostJPY > 0) {
    ledger.post({
      atMinute: clock?.minute ?? 0,
      amount: -repairCostJPY,
      category: "vehicle-failure-repair",
      reference: serviceId ?? modelId,
      memo: `${incidents.length} vehicle failure repair(s)`,
    });
  }
  const lostServiceSets = Math.max(0, requestedSets - operatingUnitIds.length);
  return {
    requestedSets,
    operatingSets: operatingUnitIds.length,
    operatingUnitIds,
    reserveSubstitutionUnitIds,
    restoredUnitIds,
    incidents,
    failures: incidents.length,
    lostServiceSets,
    delayMinutes,
    repairCostJPY,
    unavailableUnitIds: units.filter((unit) => ["repairing", "inspection-due"].includes(unit.status)).map((unit) => unit.id),
  };
}

export function reliabilityPunctualityPenalty(dispatch) {
  if (!dispatch) return 0;
  return Math.min(0.2, dispatch.delayMinutes * 0.0008 + dispatch.lostServiceSets * 0.035);
}
