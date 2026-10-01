import { VEHICLE_MODELS } from "./rolling-stock.mjs";

export const OPERATING_MONTH_REPORT_SCHEMA = "transitline.operating-month-report/1";
const MONTH_MINUTES = 30 * 1440;
const DAY_MINUTES = 1440;
const clone = (value) => structuredClone(value);
const roundMoney = (value) => Math.round(Number(value) || 0);

function emptyMoney() {
  return {
    fareRevenueJPY: 0,
    publicPaymentJPY: 0,
    advertisingJPY: 0,
    ancillaryRevenueJPY: 0,
    energyJPY: 0,
    staffJPY: 0,
    vehicleMaintenanceJPY: 0,
    vehicleInspectionJPY: 0,
    vehicleRepairJPY: 0,
    deadheadJPY: 0,
    infrastructureJPY: 0,
    depotJPY: 0,
    debtServiceJPY: 0,
    equityReturnJPY: 0,
    infrastructureRenewalJPY: 0,
  };
}

export function applyVehicleOperatingWear({ units, modelId, trainKm, days, depot, ledger, clock, maxUsedSets = null, usedUnitIds = null } = {}) {
  const model = VEHICLE_MODELS[modelId];
  if (!model) throw new Error(`Unknown vehicle model ${modelId}`);
  const usedIdSet = usedUnitIds === null ? null : new Set(usedUnitIds);
  const running = units.filter((unit) => unit.status === "available" && (usedIdSet === null || usedIdSet.has(unit.id)));
  const requested = maxUsedSets === null ? running.length : Math.max(0, Math.floor(maxUsedSets));
  const used = running.slice(0, Math.min(requested, running.length, depot?.capacitySets ?? running.length));
  const mileageEach = used.length ? trainKm / used.length : 0;
  for (const unit of used) {
    unit.mileageKm += mileageEach;
    unit.ageYears = (unit.ageYears ?? 0) + days / 365;
    unit.condition = Math.max(0.35, (unit.condition ?? 1) - days * 0.000025 - mileageEach / 20_000_000);
    unit.failureProbability = Math.min(0.4, (1 - model.reliability) * (1 + unit.ageYears / 18) / unit.condition);
    if (unit.mileageKm >= unit.nextInspectionKm) unit.status = "inspection-due";
  }

  const due = units.filter((unit) => unit.status === "inspection-due")
    .sort((a, b) => b.mileageKm - a.mileageKm || a.id.localeCompare(b.id));
  const capacity = Math.max(0, Math.floor((depot?.inspectionSetsPerDay ?? 0) * days));
  const inspected = due.slice(0, capacity);
  const inspectionCostPerSetJPY = Math.round(model.pricePerSet * 0.0015);
  const inspectionCostJPY = inspectionCostPerSetJPY * inspected.length;
  if (inspectionCostJPY > 0) ledger.post({ atMinute: clock.minute, amount: -inspectionCostJPY, category: "vehicle-inspection", reference: depot?.id ?? modelId, memo: "Mileage inspection" });
  for (const unit of inspected) {
    while (unit.nextInspectionKm <= unit.mileageKm) unit.nextInspectionKm += 30_000;
    unit.condition = Math.min(1, unit.condition + 0.015);
    unit.lastInspectedAtMinute = clock.minute;
    unit.status = "available";
  }
  return {
    mileageEachKm: mileageEach,
    inspectedUnitIds: inspected.map((unit) => unit.id),
    inspectionCostJPY,
    inspectionDueUnitIds: units.filter((unit) => unit.status === "inspection-due").map((unit) => unit.id),
    averageCondition: units.length ? units.reduce((sum, unit) => sum + (unit.condition ?? 1), 0) / units.length : null,
  };
}

export function activateProjectOperatingFinance(financing, projectId, currentMonth) {
  for (const entry of financing.filter((item) => item.projectId === projectId && ["construction-loan", "sponsor-equity"].includes(item.kind))) {
    if (entry.firstDueMonth !== undefined) continue;
    entry.activatedMonth = currentMonth;
    entry.firstDueMonth = currentMonth + 1;
    entry.lastServicedMonth = currentMonth;
    entry.arrearsJPY = entry.arrearsJPY ?? 0;
    entry.missedPayments = entry.missedPayments ?? 0;
  }
  return financing;
}

export function applyInfrastructureOperatingWear({ project, trainKm, days } = {}) {
  const assets = (project?.assets ?? []).filter((asset) => asset.status === "available");
  for (const asset of assets) {
    const annualRate = asset.kind === "power-signal" ? 0.015 : asset.kind === "track-segment" ? 0.012 : 0.008;
    const usageRate = asset.kind === "track-segment" || asset.kind === "power-signal" ? trainKm / 50_000_000 : 0;
    asset.ageYears = (asset.ageYears ?? 0) + days / 365;
    asset.condition = Math.max(0.35, (asset.condition ?? 1) - annualRate * days / 365 - usageRate);
    asset.maintenanceState = asset.condition < 0.55 ? "renewal-due" : asset.condition < 0.75 ? "attention" : "normal";
  }
  const averageCondition = assets.length ? assets.reduce((sum, asset) => sum + asset.condition, 0) / assets.length : null;
  return {
    averageCondition,
    attentionAssetIds: assets.filter((asset) => asset.maintenanceState === "attention").map((asset) => asset.id),
    renewalDueAssetIds: assets.filter((asset) => asset.maintenanceState === "renewal-due").map((asset) => asset.id),
  };
}

export function settleProjectOperatingFinance({ financing, projectId, throughMonth, ledger, clock } = {}) {
  const settlements = [];
  for (const entry of financing.filter((item) => item.projectId === projectId && ["construction-loan", "sponsor-equity"].includes(item.kind))) {
    if (entry.firstDueMonth === undefined || throughMonth < entry.firstDueMonth || ["repaid", "closed"].includes(entry.status)) continue;
    for (let month = Math.max(entry.firstDueMonth, (entry.lastServicedMonth ?? entry.firstDueMonth - 1) + 1); month <= throughMonth; month++) {
      const interestJPY = entry.kind === "construction-loan" ? roundMoney(entry.balanceJPY * entry.annualRate / 12) : 0;
      const scheduledJPY = entry.kind === "construction-loan"
        ? Math.min(roundMoney(entry.futureMonthlyCostJPY), roundMoney(entry.balanceJPY + interestJPY))
        : roundMoney(entry.futureMonthlyCostJPY);
      const dueJPY = scheduledJPY + roundMoney(entry.arrearsJPY);
      const paidJPY = Math.min(dueJPY, Math.max(0, roundMoney(ledger.cash)));
      if (paidJPY > 0) ledger.post({ atMinute: clock.minute, amount: -paidJPY, category: entry.kind === "construction-loan" ? "construction-debt-service" : "sponsor-equity-return", reference: entry.id, memo: `Operating month ${month}` });
      const principalPaidJPY = entry.kind === "construction-loan" ? Math.max(0, Math.min(entry.balanceJPY, paidJPY - interestJPY)) : 0;
      if (entry.kind === "construction-loan") entry.balanceJPY = Math.max(0, roundMoney(entry.balanceJPY - principalPaidJPY));
      entry.arrearsJPY = Math.max(0, dueJPY - paidJPY);
      entry.missedPayments = entry.arrearsJPY > 0 ? (entry.missedPayments ?? 0) + 1 : 0;
      entry.status = entry.kind === "construction-loan" && entry.balanceJPY <= 0 && entry.arrearsJPY <= 0
        ? "repaid"
        : entry.missedPayments >= 3 ? "default" : entry.arrearsJPY > 0 ? "delinquent" : "servicing";
      entry.lastServicedMonth = month;
      settlements.push({
        financeId: entry.id,
        projectId,
        month,
        kind: entry.kind,
        scheduledJPY,
        interestJPY,
        principalPaidJPY,
        paidJPY,
        arrearsJPY: entry.arrearsJPY,
        balanceJPY: entry.balanceJPY,
        status: entry.status,
      });
    }
  }
  return settlements;
}

function reportFor(reports, month, service) {
  let report = reports.find((entry) => entry.month === month && entry.serviceId === service.id);
  if (report) {
    report.money = { ...emptyMoney(), ...(report.money ?? {}) };
    report.reliability ??= { failures: 0, reserveSubstitutions: 0, cancelledSetDays: 0, repairCostJPY: 0, delayMinutes: 0, averagePunctuality: null, punctualitySamples: 0, incidents: [], unavailableUnitIds: [] };
    return report;
  }
  report = {
    schema: OPERATING_MONTH_REPORT_SCHEMA,
    contractVersion: 1,
    id: `operating-month:${service.id}:${month}`,
    month,
    serviceId: service.id,
    projectId: service.projectId,
    days: 0,
    passengers: 0,
    denied: 0,
    trainKm: 0,
    money: emptyMoney(),
    operatingIncomeJPY: 0,
    operatingCostJPY: 0,
    operatingProfitJPY: 0,
    financeCostJPY: 0,
    capitalCostJPY: 0,
    netCashJPY: 0,
    vehicle: { inspectedUnitIds: [], inspectionDueUnitIds: [], averageCondition: null },
    reliability: { failures: 0, reserveSubstitutions: 0, cancelledSetDays: 0, repairCostJPY: 0, delayMinutes: 0, averagePunctuality: null, punctualitySamples: 0, incidents: [], unavailableUnitIds: [] },
    market: { addressableDemand: 0, playerDemand: 0, averagePlayerShare: null, samples: 0, competitors: {} },
    infrastructure: { averageCondition: null, attentionAssetIds: [], renewalDueAssetIds: [] },
    financeSettlements: [],
  };
  reports.push(report);
  return report;
}

export function recordOperatingPeriod(reports, { service, atMinute, days, passengers = 0, denied = 0, trainKm = 0, money = {}, vehicle = null, infrastructure = null, reliability = null, punctuality = null, market = null } = {}) {
  if (!(days > 0)) throw new Error("Operating period days must be positive");
  const month = Math.floor(atMinute / MONTH_MINUTES);
  const report = reportFor(reports, month, service);
  report.days += days;
  report.passengers += passengers;
  report.denied += denied;
  report.trainKm += trainKm;
  for (const key of Object.keys(report.money)) report.money[key] += roundMoney(money[key]);
  report.operatingIncomeJPY = report.money.fareRevenueJPY + report.money.publicPaymentJPY + report.money.advertisingJPY + report.money.ancillaryRevenueJPY;
  report.operatingCostJPY = report.money.energyJPY + report.money.staffJPY + report.money.vehicleMaintenanceJPY + report.money.vehicleInspectionJPY + report.money.vehicleRepairJPY + report.money.deadheadJPY + report.money.infrastructureJPY + report.money.depotJPY;
  report.operatingProfitJPY = report.operatingIncomeJPY - report.operatingCostJPY;
  report.financeCostJPY = report.money.debtServiceJPY + report.money.equityReturnJPY;
  report.capitalCostJPY = report.money.infrastructureRenewalJPY;
  report.netCashJPY = report.operatingProfitJPY - report.financeCostJPY - report.capitalCostJPY;
  if (vehicle) {
    report.vehicle.inspectedUnitIds = [...new Set([...report.vehicle.inspectedUnitIds, ...vehicle.inspectedUnitIds])];
    report.vehicle.inspectionDueUnitIds = clone(vehicle.inspectionDueUnitIds);
    report.vehicle.averageCondition = vehicle.averageCondition;
  }
  if (infrastructure) report.infrastructure = clone(infrastructure);
  if (reliability) {
    report.reliability.failures += reliability.failures ?? reliability.incidents?.length ?? 0;
    report.reliability.reserveSubstitutions += reliability.reserveSubstitutionUnitIds?.length ?? 0;
    report.reliability.cancelledSetDays += (reliability.lostServiceSets ?? 0) * days;
    report.reliability.repairCostJPY += roundMoney(reliability.repairCostJPY);
    report.reliability.delayMinutes += reliability.delayMinutes ?? 0;
    report.reliability.incidents.push(...clone(reliability.incidents ?? []));
    report.reliability.unavailableUnitIds = clone(reliability.unavailableUnitIds ?? []);
  }
  if (Number.isFinite(punctuality)) {
    const previousSamples = report.reliability.punctualitySamples;
    report.reliability.averagePunctuality = ((report.reliability.averagePunctuality ?? 0) * previousSamples + punctuality) / (previousSamples + 1);
    report.reliability.punctualitySamples = previousSamples + 1;
  }
  if (market) {
    report.market ??= { addressableDemand: 0, playerDemand: 0, averagePlayerShare: null, samples: 0, competitors: {} };
    report.market.addressableDemand += market.addressableDemand ?? 0;
    report.market.playerDemand += Math.round((market.addressableDemand ?? 0) * (market.playerShare ?? 1));
    const previousSamples = report.market.samples;
    report.market.averagePlayerShare = ((report.market.averagePlayerShare ?? 0) * previousSamples + (market.playerShare ?? 1)) / (previousSamples + 1);
    report.market.samples++;
    for (const entry of market.competitors ?? []) {
      const total = report.market.competitors[entry.competitorId] ?? { passengers: 0, revenueJPY: 0, costJPY: 0, profitJPY: 0 };
      total.passengers += entry.passengers;
      total.revenueJPY += entry.revenueJPY;
      total.costJPY += entry.costJPY;
      total.profitJPY += entry.profitJPY;
      report.market.competitors[entry.competitorId] = total;
    }
  }
  return report;
}

export function recordOperatingFinanceSettlements(reports, service, settlements) {
  for (const settlement of settlements) {
    const report = reportFor(reports, settlement.month, service);
    const key = settlement.kind === "construction-loan" ? "debtServiceJPY" : "equityReturnJPY";
    report.money[key] += settlement.paidJPY;
    report.financeSettlements.push(clone(settlement));
    report.financeCostJPY = report.money.debtServiceJPY + report.money.equityReturnJPY;
    report.capitalCostJPY = report.money.infrastructureRenewalJPY;
    report.netCashJPY = report.operatingProfitJPY - report.financeCostJPY - report.capitalCostJPY;
  }
  return reports;
}

export function recordInfrastructureMaintenancePayments(reports, service, payments) {
  for (const payment of payments) {
    const month = Math.floor(payment.atMinute / MONTH_MINUTES);
    const report = reportFor(reports, month, service);
    report.money.infrastructureRenewalJPY += roundMoney(payment.paymentJPY);
    report.capitalCostJPY = report.money.infrastructureRenewalJPY;
    report.netCashJPY = report.operatingProfitJPY - report.financeCostJPY - report.capitalCostJPY;
  }
  return reports;
}

export function operatingMonthReport(reports, serviceId = null, limit = null) {
  const selected = reports.filter((entry) => serviceId === null || entry.serviceId === serviceId)
    .sort((a, b) => a.month - b.month || a.serviceId.localeCompare(b.serviceId));
  return clone(limit === null ? selected : selected.slice(-Math.max(0, limit)));
}

export function operatingMonthFromMinute(minute) {
  return Math.floor(minute / MONTH_MINUTES);
}

export { DAY_MINUTES, MONTH_MINUTES };
