export const VEHICLE_RETROFIT_SCHEMA = "transitline.vehicle-retrofit-program/1";
export const VEHICLE_RETROFIT_PRICE_BASE_YEAR = 2026;

export const VEHICLE_RETROFIT_STRATEGIES = Object.freeze({
  standard: { id: "standard", costFactor: 1, durationFactor: 1, failureAdjustment: 0 },
  accelerated: { id: "accelerated", costFactor: 1.25, durationFactor: 0.75, failureAdjustment: 0.04 },
  conservative: { id: "conservative", costFactor: 1.12, durationFactor: 1.15, failureAdjustment: -0.04 },
});

const RETROFITTABLE_CHECKS = new Set(["power-system", "signal-system"]);
const roundMoney = (value) => Math.round(Number(value) || 0);
const uniqueObjects = (values) => {
  const byJson = new Map(values.map((value) => [JSON.stringify(value), structuredClone(value)]));
  return [...byJson.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value);
};
const uniqueText = (values) => [...new Set(values.filter((value) => typeof value === "string" && value))].sort();

function technicalAssessments(throughService) {
  return (throughService?.legs ?? []).map((leg) => ({ legId: leg.legId, assessment: leg.technicalCompatibility }))
    .filter((entry) => entry.assessment);
}

export function vehicleRetrofitRequirements(throughService) {
  const assessments = technicalAssessments(throughService);
  const blockers = [];
  const missingInputs = [];
  const powerSystems = [];
  const signalAlternatives = [];
  if (!assessments.length) missingInputs.push("technical-compatibility-assessment");
  for (const { legId, assessment } of assessments) {
    for (const item of assessment.checks ?? []) {
      if (item.status === "unknown") missingInputs.push(`leg:${legId}:${item.checkId}`);
      if (item.status !== "incompatible") continue;
      if (!RETROFITTABLE_CHECKS.has(item.checkId)) {
        blockers.push({ legId, checkId: item.checkId, reason: item.reason });
      } else if (item.checkId === "power-system") {
        if (item.infrastructureValue && Object.values(item.infrastructureValue).every((value) => value !== null)) powerSystems.push(item.infrastructureValue);
        else missingInputs.push(`leg:${legId}:power-system`);
      } else {
        const alternatives = uniqueText(item.infrastructureValue ?? []);
        if (alternatives.length) signalAlternatives.push({ legId, alternatives });
        else missingInputs.push(`leg:${legId}:signal-system`);
      }
    }
  }
  return {
    eligible: blockers.length ? false : missingInputs.length ? "unknown" : powerSystems.length || signalAlternatives.length ? true : false,
    powerSystems: uniqueObjects(powerSystems),
    signalAlternatives: signalAlternatives.sort((a, b) => a.legId.localeCompare(b.legId)),
    blockers,
    missingInputs: uniqueText(missingInputs),
  };
}

function selectedSignals(requirements, requested = []) {
  const selected = uniqueText(requested);
  for (const requirement of requirements.signalAlternatives) {
    if (!requirement.alternatives.some((signal) => selected.includes(signal))) {
      throw new Error(`A supported signal system must be selected for ${requirement.legId}`);
    }
  }
  const relevant = new Set(requirements.signalAlternatives.flatMap((entry) => entry.alternatives));
  if (selected.some((signal) => !relevant.has(signal))) throw new Error("Selected signal system is not required by the route");
  return selected;
}

export function estimateVehicleRetrofit({ throughService, quantity, selectedSignalSystemIds = [], strategyId = "standard" } = {}) {
  const strategy = VEHICLE_RETROFIT_STRATEGIES[strategyId];
  if (!strategy) throw new Error(`Unknown vehicle retrofit strategy ${strategyId}`);
  if (!Number.isInteger(quantity) || quantity <= 0) throw new Error("Vehicle retrofit quantity must be a positive integer");
  const requirements = vehicleRetrofitRequirements(throughService);
  if (requirements.eligible === "unknown") throw new Error(`Vehicle retrofit requires more technical data: ${requirements.missingInputs.join(", ")}`);
  if (requirements.blockers.length) throw new Error(`Vehicle retrofit cannot solve: ${requirements.blockers.map((entry) => `${entry.legId}:${entry.checkId}`).join(", ")}`);
  if (requirements.eligible !== true) throw new Error("Through service has no vehicle-retrofittable incompatibility");
  const signals = selectedSignals(requirements, selectedSignalSystemIds);
  const powerEngineeringJPY = requirements.powerSystems.length * 900_000_000;
  const powerEquipmentJPY = requirements.powerSystems.length * quantity * 220_000_000;
  const signalEngineeringJPY = signals.length * 500_000_000;
  const signalEquipmentJPY = signals.length * quantity * 140_000_000;
  const integrationJPY = requirements.powerSystems.length && signals.length ? 350_000_000 : 0;
  const approvalTestingJPY = 300_000_000 + quantity * 20_000_000;
  const directCostJPY = powerEngineeringJPY + powerEquipmentJPY + signalEngineeringJPY + signalEquipmentJPY + integrationJPY + approvalTestingJPY;
  const contingencyJPY = roundMoney(directCostJPY * 0.2);
  const totalCostJPY = roundMoney((directCostJPY + contingencyJPY) * strategy.costFactor);
  const engineeringMonths = Math.max(requirements.powerSystems.length ? 10 : 0, signals.length ? 8 : 0);
  const installationMonths = Math.max(2, Math.ceil(quantity / 2));
  const integrationMonths = integrationJPY ? 3 : 0;
  const approvalTestingMonths = 4;
  const durationMonths = Math.max(1, Math.ceil((engineeringMonths + installationMonths + integrationMonths + approvalTestingMonths) * strategy.durationFactor));
  const complexity = requirements.powerSystems.length + signals.length + (integrationJPY ? 1 : 0);
  const approvalFailureProbability = Math.max(0.02, Math.min(0.35, 0.04 + complexity * 0.035 + strategy.failureAdjustment));
  return {
    currency: "JPY",
    priceBaseYear: VEHICLE_RETROFIT_PRICE_BASE_YEAR,
    strategyId,
    quantity,
    requirements,
    selectedSignalSystemIds: signals,
    capabilityAdditions: {
      supportedPowerSystems: structuredClone(requirements.powerSystems),
      supportedSignalSystemIds: signals,
    },
    costBreakdownJPY: {
      powerEngineeringJPY,
      powerEquipmentJPY,
      signalEngineeringJPY,
      signalEquipmentJPY,
      integrationJPY,
      approvalTestingJPY,
      contingencyJPY,
    },
    directCostJPY,
    totalCostJPY,
    phases: { engineeringMonths, installationMonths, integrationMonths, approvalTestingMonths },
    durationMonths,
    approvalFailureProbability,
  };
}

export function createVehicleRetrofitProgram({ id, throughService, quantity, selectedSignalSystemIds, strategyId, atMinute = 0 } = {}) {
  if (!id) throw new Error("Vehicle retrofit program requires an id");
  if (!throughService?.throughServiceId) throw new Error("Vehicle retrofit program requires a through service");
  const estimate = estimateVehicleRetrofit({ throughService, quantity, selectedSignalSystemIds, strategyId });
  return {
    schema: VEHICLE_RETROFIT_SCHEMA,
    contractVersion: 1,
    id,
    throughServiceId: throughService.throughServiceId,
    vehicleModelId: throughService.guestModelId,
    operatorId: throughService.operatorId,
    ...estimate,
    status: "proposed",
    createdAtMinute: atMinute,
    startedAtMinute: null,
    completedAtMinute: null,
    elapsedMonths: 0,
    paidJPY: 0,
    testAttempts: 0,
    currentCommitmentId: null,
    lastTestRoll: null,
  };
}

export function startVehicleRetrofitProgram(program, { ledger, clock } = {}) {
  if (program?.schema !== VEHICLE_RETROFIT_SCHEMA || program.contractVersion !== 1) throw new Error("VehicleRetrofitProgram v1 is required");
  if (program.status !== "proposed") throw new Error(`Vehicle retrofit cannot start from ${program.status}`);
  const commitmentId = `vehicle-retrofit:${program.id}`;
  ledger.commit({ id: commitmentId, atMinute: clock.minute, amount: program.totalCostJPY, category: "vehicle-retrofit", reference: program.id });
  const mobilisationJPY = roundMoney(program.totalCostJPY * 0.2);
  ledger.settle(commitmentId, mobilisationJPY, clock.minute, "Vehicle retrofit engineering mobilisation");
  program.status = "engineering";
  program.startedAtMinute = clock.minute;
  program.paidJPY = mobilisationJPY;
  program.currentCommitmentId = commitmentId;
  return structuredClone(program);
}

function stageFor(program) {
  const scaled = program.elapsedMonths / program.durationMonths;
  if (scaled < 0.45) return "engineering";
  if (scaled < 0.8) return "installation";
  return "approval-testing";
}

function settleTarget(program, targetPaidJPY, ledger, clock, memo) {
  const paymentJPY = Math.max(0, Math.min(program.totalCostJPY, targetPaidJPY) - program.paidJPY);
  if (paymentJPY > 0) ledger.settle(program.currentCommitmentId, paymentJPY, clock.minute, memo);
  program.paidJPY += paymentJPY;
  return paymentJPY;
}

export function advanceVehicleRetrofitMonth(program, { ledger, clock, rng } = {}) {
  if (!["engineering", "installation", "approval-testing", "retesting"].includes(program.status)) return { status: program.status, paymentJPY: 0, completed: false };
  if (!rng?.next) throw new Error("Vehicle retrofit advancement requires deterministic RNG");
  if (program.status === "retesting") {
    program.retestElapsedMonths += 1;
    const target = program.retestElapsedMonths >= program.retestDurationMonths
      ? program.retestCostJPY
      : roundMoney(program.retestCostJPY * (0.3 + 0.7 * program.retestElapsedMonths / program.retestDurationMonths));
    const paymentJPY = Math.max(0, target - program.retestPaidJPY);
    if (paymentJPY > 0) ledger.settle(program.currentCommitmentId, paymentJPY, clock.minute, "Vehicle retrofit retest progress");
    program.retestPaidJPY += paymentJPY;
    program.paidJPY += paymentJPY;
    if (program.retestElapsedMonths < program.retestDurationMonths) return { status: program.status, paymentJPY, completed: false };
    program.testAttempts += 1;
    const roll = rng.next();
    program.lastTestRoll = roll;
    const failureProbability = Math.max(0.01, program.approvalFailureProbability * (0.55 ** program.testAttempts));
    if (roll < failureProbability) {
      program.status = "failed-testing";
      program.failedAtMinute = clock.minute;
      program.currentCommitmentId = null;
      return { status: program.status, paymentJPY, completed: false, failed: true, failureProbability, roll };
    }
    program.status = "approved";
    program.completedAtMinute = clock.minute;
    program.currentCommitmentId = null;
    return { status: program.status, paymentJPY, completed: true, failureProbability, roll };
  }

  program.elapsedMonths = Math.min(program.durationMonths, program.elapsedMonths + 1);
  program.status = stageFor(program);
  const targetPaidJPY = program.elapsedMonths >= program.durationMonths
    ? program.totalCostJPY
    : roundMoney(program.totalCostJPY * (0.2 + 0.8 * program.elapsedMonths / program.durationMonths));
  const paymentJPY = settleTarget(program, targetPaidJPY, ledger, clock, "Vehicle retrofit progress");
  if (program.elapsedMonths < program.durationMonths) return { status: program.status, paymentJPY, completed: false };
  program.testAttempts += 1;
  const roll = rng.next();
  program.lastTestRoll = roll;
  if (roll < program.approvalFailureProbability) {
    program.status = "failed-testing";
    program.failedAtMinute = clock.minute;
    program.currentCommitmentId = null;
    return { status: program.status, paymentJPY, completed: false, failed: true, failureProbability: program.approvalFailureProbability, roll };
  }
  program.status = "approved";
  program.completedAtMinute = clock.minute;
  program.currentCommitmentId = null;
  return { status: program.status, paymentJPY, completed: true, failureProbability: program.approvalFailureProbability, roll };
}

export function authorizeVehicleRetrofitRetest(program, { ledger, clock } = {}) {
  if (program.status !== "failed-testing") throw new Error(`Vehicle retrofit cannot retest from ${program.status}`);
  if (program.testAttempts >= 3) throw new Error("Vehicle retrofit has exhausted approval test attempts");
  const attempt = program.testAttempts + 1;
  const costJPY = Math.max(150_000_000, roundMoney(program.totalCostJPY * 0.12));
  const commitmentId = `vehicle-retrofit-retest:${program.id}:${attempt}`;
  ledger.commit({ id: commitmentId, atMinute: clock.minute, amount: costJPY, category: "vehicle-retrofit-retest", reference: program.id });
  const initialJPY = roundMoney(costJPY * 0.3);
  ledger.settle(commitmentId, initialJPY, clock.minute, "Vehicle retrofit retest preparation");
  program.status = "retesting";
  program.currentCommitmentId = commitmentId;
  program.retestCostJPY = costJPY;
  program.retestPaidJPY = initialJPY;
  program.retestElapsedMonths = 0;
  program.retestDurationMonths = 3;
  program.totalCostJPY += costJPY;
  program.paidJPY += initialJPY;
  return structuredClone(program);
}

export function mergeVehicleTechnicalOverrides(current = {}, additions = {}) {
  return {
    ...structuredClone(current),
    supportedPowerSystems: uniqueObjects([...(current.supportedPowerSystems ?? []), ...(additions.supportedPowerSystems ?? [])]),
    supportedSignalSystemIds: uniqueText([...(current.supportedSignalSystemIds ?? []), ...(additions.supportedSignalSystemIds ?? [])]),
  };
}
