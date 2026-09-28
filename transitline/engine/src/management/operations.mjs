import { VEHICLE_MODELS, depotWarnings } from "./rolling-stock.mjs";
import { TECHNICAL_PROFILES } from "./construction.mjs";
import { stationDeliveryReadiness } from "./station-delivery.mjs";

export function calculateFleetRequirement({ routeKm, stations, commercialSpeedKph, trainsPerHour, reserveRatio = 0.15 }) {
  const oneWayMinutes = (routeKm / commercialSpeedKph) * 60 + Math.max(0, stations - 1) * 0.5;
  const roundTripMinutes = oneWayMinutes * 2 + 8;
  const serviceSets = Math.ceil((roundTripMinutes * trainsPerHour) / 60);
  const reserveSets = Math.max(1, Math.ceil(serviceSets * reserveRatio));
  return { oneWayMinutes, roundTripMinutes, serviceSets, reserveSets, minimumFleet: serviceSets + reserveSets };
}

export function checkOpenReady({ project, units, depot, fleetRequirement, staffReady, timetableReady, trialOperationPassed, approvalsValid, platformLengthM }) {
  const reasons = [];
  if (project.status !== "available") reasons.push("Track and stations are not available");
  reasons.push(...stationDeliveryReadiness(project).reasons);
  const accepted = units.filter((unit) => unit.status === "available");
  if (accepted.length < fleetRequirement.minimumFleet) reasons.push("Minimum accepted fleet is not secured");
  if (!depot || depot.status !== "secured" || depot.capacitySets < accepted.length) reasons.push("Depot capacity is not secured");
  if (!depot?.entryRouteAvailable) reasons.push("Depot entry route is unavailable");
  if (!project.assets?.some((asset) => asset.kind === "power-signal" && asset.status === "available")) reasons.push("Power and signalling are not integrated");
  if (!staffReady || !timetableReady) reasons.push("Staff or timetable is not ready");
  if (!trialOperationPassed) reasons.push("Trial operation has not passed");
  if (!approvalsValid) reasons.push("Approvals or contracts are invalid");
  if (accepted[0] && platformLengthM !== undefined) {
    const model = VEHICLE_MODELS[accepted[0].modelId];
    const profile = model ? TECHNICAL_PROFILES[model.profileId] : null;
    if (model && profile && model.cars * profile.platformLengthPerCarM > platformLengthM) reasons.push("Platform is too short for the fleet");
  }
  return { ready: reasons.length === 0, reasons };
}

export function operateServiceDay(input, ledger, clock, rng) {
  const { service, units, depot, contract } = input;
  if (service.status !== "open") throw new Error("Service is not open");
  const available = units.filter((unit) => unit.status === "available");
  const scheduledSets = Math.min(service.fleetRequirement.serviceSets, available.length);
  const supplyRatio = scheduledSets / Math.max(1, service.fleetRequirement.serviceSets);
  const effectiveFrequency = service.trainsPerHour * supplyRatio;
  const waitMinutes = effectiveFrequency > 0 ? 30 / effectiveFrequency : 120;
  const demandNoise = 0.96 + rng.next() * 0.08;
  const demand = Math.round(service.dailyDemand * demandNoise);
  const capacity = scheduledSets * service.tripsPerSetDay * VEHICLE_MODELS[service.modelId].capacity;
  const boarded = Math.min(demand, capacity);
  const denied = Math.max(0, demand - capacity);
  const punctuality = Math.max(0.75, Math.min(0.999, 0.985 - denied / Math.max(1, demand) * 0.08 - depot.deadheadKm * 0.0003));
  const fareRevenue = boarded * service.averageFare;
  const trainKm = scheduledSets * service.tripsPerSetDay * service.routeKm * 2;
  const carKm = trainKm * VEHICLE_MODELS[service.modelId].cars;
  const energyCost = carKm * VEHICLE_MODELS[service.modelId].energyKwhPerCarKm * service.electricityYenPerKwh;
  const staffCost = scheduledSets * service.staffPerSet * service.dailyStaffCost;
  const maintenanceCost = carKm * service.maintenanceYenPerCarKm;
  const deadheadCost = depot.assessment?.economics?.deadhead
    ? depot.assessment.economics.deadhead.totalAnnualCost / 365
    : scheduledSets * depot.deadheadKm * 2 * service.deadheadYenPerSetKm;
  const infrastructureCost = service.dailyInfrastructureCost;
  const publicPayment = contract ? contract.annualPayment / 365 : service.dailyPublicPayment;
  const target = contract?.kpi?.punctualityTarget ?? 0.97;
  const maxDeductionRate = contract?.kpi?.maxDeductionRate ?? 0.1;
  const kpiAdjustment = punctuality >= target
    ? publicPayment * (contract?.kpi?.bonusRate ?? 0.01)
    : -publicPayment * Math.min(maxDeductionRate, (target - punctuality) * 2);
  const depotAncillaryRevenue = (depot.annualAncillaryRevenue ?? 0) / 365;
  const income = fareRevenue + publicPayment + kpiAdjustment + service.dailyAdvertisingRevenue + depotAncillaryRevenue;
  const cost = energyCost + staffCost + maintenanceCost + deadheadCost + infrastructureCost + depot.annualLeaseCost / 365;
  if (income > 0) ledger.post({ atMinute: clock.minute, amount: income, category: "operating-income", reference: service.id });
  if (cost > 0) ledger.post({ atMinute: clock.minute, amount: -cost, category: "operating-cost", reference: service.id });
  for (const unit of available.slice(0, scheduledSets)) unit.mileageKm += trainKm / Math.max(1, scheduledSets);
  service.daysOperated = (service.daysOperated ?? 0) + 1;
  service.totals = service.totals ?? { demand: 0, boarded: 0, denied: 0, revenue: 0, cost: 0, trainKm: 0 };
  service.totals.demand += demand;
  service.totals.boarded += boarded;
  service.totals.denied += denied;
  service.totals.revenue += income;
  service.totals.cost += cost;
  service.totals.trainKm += trainKm;
  return { demand, boarded, denied, waitMinutes, punctuality, income, cost, profit: income - cost, trainKm, depotWarnings: depotWarnings(depot, units) };
}

export function operatingReport(service) {
  const totals = service.totals ?? { demand: 0, boarded: 0, denied: 0, revenue: 0, cost: 0, trainKm: 0 };
  return {
    ...totals,
    profit: totals.revenue - totals.cost,
    fareboxAndServiceRecovery: totals.cost ? totals.revenue / totals.cost : null,
    servedRate: totals.demand ? totals.boarded / totals.demand : 0,
  };
}
