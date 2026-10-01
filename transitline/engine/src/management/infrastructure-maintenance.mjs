export const INFRASTRUCTURE_MAINTENANCE_SCHEMA = "transitline.infrastructure-maintenance/1";

export const INFRASTRUCTURE_MAINTENANCE_STRATEGIES = Object.freeze({
  night: { id: "night", durationDays: 7, costFactor: 0.003, conditionRecovery: 0.025, capacityFactor: 0.9, punctualityPenalty: 0.003 },
  intensive: { id: "intensive", durationDays: 45, costFactor: 0.025, conditionRecovery: 0.18, capacityFactor: 0.6, punctualityPenalty: 0.03 },
  renewal: { id: "renewal", durationDays: 240, costFactor: 0.28, conditionRecovery: 1, capacityFactor: 0.15, punctualityPenalty: 0.12 },
});

const roundMoney = (value) => Math.round(Number(value) || 0);

function routeKm(project) {
  return (project.assets ?? []).filter((asset) => asset.kind === "track-segment")
    .reduce((sum, asset) => sum + (asset.lengthMeters ?? 0) / 1000, 0);
}

export function infrastructureAssetReplacementValue(asset, project) {
  if (asset.kind === "station") {
    const factor = asset.structure === "deep" ? 2.5 : asset.structure === "underground" ? 1.8 : asset.structure === "elevated" ? 1.25 : 1;
    return roundMoney(12_000_000_000 * factor);
  }
  if (asset.kind === "platform") return roundMoney(1_800_000_000 + (asset.lengthMeters ?? 100) * 8_000_000);
  if (asset.kind === "track-segment") {
    const perKm = asset.structure === "tunnel" || asset.structure === "underground" ? 7_000_000_000
      : asset.structure === "viaduct" || asset.structure === "elevated" ? 4_000_000_000 : 1_500_000_000;
    return roundMoney(Math.max(0.1, (asset.lengthMeters ?? 100) / 1000) * perKm);
  }
  if (asset.kind === "power-signal") return roundMoney(12_000_000_000 + routeKm(project) * 800_000_000);
  return 1_000_000_000;
}

export function estimateInfrastructureMaintenance({ project, assetIds, strategyId } = {}) {
  const strategy = INFRASTRUCTURE_MAINTENANCE_STRATEGIES[strategyId];
  if (!strategy) throw new Error(`Unknown infrastructure maintenance strategy ${strategyId}`);
  const uniqueIds = [...new Set(assetIds ?? [])];
  if (!uniqueIds.length) throw new Error("Infrastructure maintenance requires at least one asset");
  const assets = uniqueIds.map((id) => {
    const asset = project?.assets?.find((entry) => entry.id === id);
    if (!asset) throw new Error(`Unknown infrastructure asset ${id}`);
    if (asset.status !== "available") throw new Error(`Infrastructure asset ${id} is not available`);
    if (asset.maintenanceProgramId) throw new Error(`Infrastructure asset ${id} already has active maintenance`);
    return asset;
  });
  const replacementValueJPY = assets.reduce((sum, asset) => sum + infrastructureAssetReplacementValue(asset, project), 0);
  return {
    strategyId,
    assetIds: uniqueIds,
    replacementValueJPY,
    totalCostJPY: roundMoney(replacementValueJPY * strategy.costFactor),
    durationDays: strategy.durationDays,
    conditionRecovery: strategy.conditionRecovery,
    capacityFactor: strategy.capacityFactor,
    punctualityPenalty: strategy.punctualityPenalty,
  };
}

export function startInfrastructureMaintenance({ id, project, assetIds, strategyId, ledger, clock } = {}) {
  const estimate = estimateInfrastructureMaintenance({ project, assetIds, strategyId });
  const commitmentId = `infrastructure-maintenance:${id}`;
  ledger.commit({ id: commitmentId, atMinute: clock.minute, amount: estimate.totalCostJPY, category: "infrastructure-maintenance", reference: id });
  const initialPaymentJPY = Math.max(1, roundMoney(estimate.totalCostJPY * 0.15));
  ledger.settle(commitmentId, initialPaymentJPY, clock.minute, "Infrastructure maintenance mobilisation");
  const startDay = Math.floor(clock.minute / 1440);
  const program = {
    schema: INFRASTRUCTURE_MAINTENANCE_SCHEMA,
    contractVersion: 1,
    id,
    projectId: project.id,
    ...estimate,
    status: "active",
    startDay,
    lastAdvancedDay: startDay,
    elapsedDays: 0,
    paidJPY: initialPaymentJPY,
    completedAtMinute: null,
  };
  for (const asset of project.assets.filter((entry) => estimate.assetIds.includes(entry.id))) asset.maintenanceProgramId = id;
  return program;
}

export function advanceInfrastructureMaintenancePrograms({ programs, projects, throughDay, ledger, clock } = {}) {
  const completed = [];
  const payments = [];
  for (const program of programs.filter((entry) => entry.status === "active")) {
    const elapsed = Math.max(0, throughDay - (program.lastAdvancedDay ?? program.startDay));
    if (!elapsed) continue;
    program.elapsedDays = Math.min(program.durationDays, program.elapsedDays + elapsed);
    program.lastAdvancedDay = throughDay;
    const targetPaidJPY = program.elapsedDays >= program.durationDays
      ? program.totalCostJPY
      : Math.max(program.paidJPY, roundMoney(program.totalCostJPY * (0.15 + 0.85 * program.elapsedDays / program.durationDays)));
    const paymentJPY = Math.max(0, targetPaidJPY - program.paidJPY);
    if (paymentJPY > 0) {
      ledger.settle(`infrastructure-maintenance:${program.id}`, paymentJPY, clock.minute, "Infrastructure maintenance progress");
      payments.push({ programId: program.id, projectId: program.projectId, paymentJPY, atMinute: clock.minute });
    }
    program.paidJPY += paymentJPY;
    if (program.elapsedDays < program.durationDays) continue;
    const project = projects.find((entry) => entry.id === program.projectId);
    if (!project) throw new Error(`Unknown maintenance project ${program.projectId}`);
    for (const asset of project.assets.filter((entry) => program.assetIds.includes(entry.id))) {
      asset.condition = program.strategyId === "renewal" ? 1 : Math.round(Math.min(1, (asset.condition ?? 1) + program.conditionRecovery) * 1_000_000) / 1_000_000;
      if (program.strategyId === "renewal") asset.ageYears = 0;
      asset.maintenanceState = asset.condition < 0.55 ? "renewal-due" : asset.condition < 0.75 ? "attention" : "normal";
      delete asset.maintenanceProgramId;
    }
    program.status = "complete";
    program.completedAtMinute = clock.minute;
    completed.push(program.id);
  }
  return { completedProgramIds: completed, payments };
}

export function infrastructureMaintenanceImpact(programs, projectId) {
  const active = programs.filter((entry) => entry.projectId === projectId && entry.status === "active");
  return {
    activeProgramIds: active.map((entry) => entry.id),
    capacityFactor: active.length ? Math.min(...active.map((entry) => entry.capacityFactor)) : 1,
    punctualityPenalty: active.reduce((sum, entry) => sum + entry.punctualityPenalty, 0),
  };
}
