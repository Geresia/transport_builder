import { TECHNICAL_PROFILES } from "./construction.mjs";

export const VEHICLE_MODELS = Object.freeze({
  medium_4car: { id: "medium_4car", profileId: "medium_steel", cars: 4, capacity: 560, pricePerSet: 1_450_000_000, productionMonths: 20, reliability: 0.985, energyKwhPerCarKm: 3.2 },
  small_4car: { id: "small_4car", profileId: "small_steel", cars: 4, capacity: 400, pricePerSet: 1_150_000_000, productionMonths: 18, reliability: 0.98, energyKwhPerCarKm: 2.5 },
  large_8car: { id: "large_8car", profileId: "large_steel", cars: 8, capacity: 1280, pricePerSet: 2_900_000_000, productionMonths: 26, reliability: 0.987, energyKwhPerCarKm: 3.6 },
  agt_3car: { id: "agt_3car", profileId: "agt", cars: 3, capacity: 240, pricePerSet: 950_000_000, productionMonths: 20, reliability: 0.982, energyKwhPerCarKm: 2.1 },
  agt_6car: { id: "agt_6car", profileId: "agt", cars: 6, capacity: 420, pricePerSet: 1_600_000_000, productionMonths: 22, reliability: 0.982, energyKwhPerCarKm: 2.1 },
  monorail_6car: { id: "monorail_6car", profileId: "monorail", cars: 6, capacity: 600, pricePerSet: 2_250_000_000, productionMonths: 28, reliability: 0.983, energyKwhPerCarKm: 3.8 },
  linear_6car: { id: "linear_6car", profileId: "linear_metro", cars: 6, capacity: 650, pricePerSet: 2_050_000_000, productionMonths: 25, reliability: 0.984, energyKwhPerCarKm: 3.4 },
});

export function createManufacturers() {
  return [
    { id: "maker-a", name: "Aster Rail", priceFactor: 1.04, quality: 94, warrantyYears: 5, backlogMonths: 5, monthlyCapacitySets: 2 },
    { id: "maker-b", name: "Nippon Mobility Works", priceFactor: 1, quality: 88, warrantyYears: 4, backlogMonths: 9, monthlyCapacitySets: 3 },
    { id: "maker-c", name: "Hanbit Rolling Stock", priceFactor: 0.92, quality: 82, warrantyYears: 3, backlogMonths: 4, monthlyCapacitySets: 2 },
  ];
}

export function createDepot(input) {
  if (!(input.capacitySets > 0) || !(input.inspectionSetsPerDay > 0)) throw new Error("Depot requires positive storage and inspection capacity");
  const strategies = {
    terminal: { landCostFactor: 1.25, deadheadKm: 1.5, communityRisk: 0.75, firstTrainPenaltyMinutes: 4 },
    suburban: { landCostFactor: 0.7, deadheadKm: 9, communityRisk: 1, firstTrainPenaltyMinutes: 18 },
    remote: { landCostFactor: 0.45, deadheadKm: 24, communityRisk: 0.65, firstTrainPenaltyMinutes: 42 },
    shared: { landCostFactor: 0.15, deadheadKm: 12, communityRisk: 0.2, firstTrainPenaltyMinutes: 24 },
  };
  const strategy = strategies[input.locationStrategy];
  if (!strategy) throw new Error(`Unknown depot strategy ${input.locationStrategy}`);
  return {
    id: input.id,
    name: input.name,
    type: input.type ?? "D1",
    capacitySets: input.capacitySets,
    inspectionSetsPerDay: input.inspectionSetsPerDay,
    entryRouteAvailable: input.entryRouteAvailable ?? true,
    heavyMaintenanceExternal: input.heavyMaintenanceExternal ?? true,
    status: input.status ?? "secured",
    locationStrategy: input.locationStrategy,
    ...strategy,
    annualLeaseCost: input.annualLeaseCost ?? input.capacitySets * 95_000_000 * strategy.landCostFactor,
  };
}

export function placeVehicleOrder({ id, modelId, quantity, manufacturer, ledger, clock }) {
  const model = VEHICLE_MODELS[modelId];
  if (!model) throw new Error(`Unknown vehicle model ${modelId}`);
  if (!Number.isInteger(quantity) || quantity <= 0) throw new Error("Vehicle quantity must be a positive integer");
  const totalPrice = model.pricePerSet * quantity * manufacturer.priceFactor;
  ledger.commit({ id: `vehicles:${id}`, atMinute: clock.minute, amount: totalPrice, category: "vehicles", reference: id });
  const deposit = totalPrice * 0.15;
  ledger.settle(`vehicles:${id}`, deposit, clock.minute, "Vehicle order deposit");
  const productionMonths = model.productionMonths + manufacturer.backlogMonths + Math.ceil(quantity / manufacturer.monthlyCapacitySets);
  manufacturer.backlogMonths += Math.ceil(quantity / manufacturer.monthlyCapacitySets);
  return { id, modelId, manufacturerId: manufacturer.id, quantity, totalPrice, paid: deposit, elapsedMonths: 0, productionMonths, stage: "design", units: [] };
}

export function advanceVehicleOrderMonth(order, manufacturer, ledger, clock, rng) {
  if (["accepted", "cancelled"].includes(order.stage)) return { stage: order.stage, payment: 0 };
  order.elapsedMonths++;
  const ratio = order.elapsedMonths / order.productionMonths;
  order.stage = ratio < 0.2 ? "design" : ratio < 0.7 ? "production" : ratio < 0.82 ? "factory-test" : ratio < 0.92 ? "transport" : "line-test";
  if (rng.next() > manufacturer.quality / 100 && !order.qualityDelayApplied) {
    order.productionMonths += 2;
    order.qualityDelayApplied = true;
    return { stage: order.stage, delayed: true, payment: 0 };
  }
  const targetPaid = Math.min(order.totalPrice, order.totalPrice * (0.15 + 0.75 * Math.min(1, ratio)));
  let payment = Math.max(0, targetPaid - order.paid);
  if (payment > 0) ledger.settle(`vehicles:${order.id}`, payment, clock.minute, "Vehicle production milestone");
  order.paid += payment;
  if (order.elapsedMonths >= order.productionMonths) {
    const finalPayment = order.totalPrice - order.paid;
    if (finalPayment > 0) ledger.settle(`vehicles:${order.id}`, finalPayment, clock.minute, "Vehicle acceptance");
    payment += Math.max(0, finalPayment);
    order.paid = order.totalPrice;
    order.stage = "accepted";
    order.units = Array.from({ length: order.quantity }, (_, index) => ({
      id: `${order.id}:set-${index + 1}`,
      modelId: order.modelId,
      status: "available",
      mileageKm: 0,
      nextInspectionKm: 30_000,
      acceptedAt: clock.minute,
    }));
  }
  return { stage: order.stage, delayed: false, payment };
}

export function checkVehicleCompatibility(modelId, project, platformLengthM) {
  const model = VEHICLE_MODELS[modelId];
  const profile = TECHNICAL_PROFILES[project.technicalProfileId];
  if (!model || !profile) return { compatible: false, reasons: ["Unknown vehicle or infrastructure profile"] };
  const reasons = [];
  if (model.profileId !== project.technicalProfileId) reasons.push("Vehicle running system does not match infrastructure");
  if (model.cars < profile.minCars || model.cars > profile.maxCars) reasons.push("Formation length is outside profile range");
  if (platformLengthM !== undefined && model.cars * profile.platformLengthPerCarM > platformLengthM) reasons.push("Formation is longer than platform");
  return { compatible: reasons.length === 0, reasons };
}

export function depotWarnings(depot, units) {
  const warnings = [];
  if (units.length > depot.capacitySets) warnings.push(`Depot is over capacity by ${units.length - depot.capacitySets} sets`);
  const inspectionsDue = units.filter((unit) => unit.mileageKm >= unit.nextInspectionKm).length;
  if (inspectionsDue > depot.inspectionSetsPerDay) warnings.push("Inspection workload exceeds daily depot throughput");
  if (!depot.entryRouteAvailable) warnings.push("Depot entry route is unavailable");
  return warnings;
}
