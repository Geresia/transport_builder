export const CONSTRUCTION_CYCLE_REPORT_SCHEMA = "transitline.construction-cycle-report/1";

const clone = (value) => structuredClone(value);
const round = (value, digits = 6) => Number(Number(value).toFixed(digits));
const PHASE_EPSILON = 1e-6;

function phaseBounds(project) {
  let cursor = 0;
  return new Map((project?.tasks ?? []).map((phase) => {
    const start = cursor;
    cursor += Math.max(0, Number(phase.weight) || 0);
    return [phase.id, { start: round(start), end: round(cursor) }];
  }));
}

// Converts detailed critical-path constraints into a cap for the legacy weighted project progress.
// Work may continue inside a phase, but that phase cannot finish before its critical delayed task.
// Integrated testing cannot start until civil/station/depot/vehicle dependencies are complete.
export function integratedConstructionProgressGate(schedule, project) {
  if (!schedule || schedule.projectId !== project?.id) return { cap: 1, blocked: false, reasons: [] };
  const bounds = phaseBounds(project);
  let cap = 1;
  const reasons = [];
  for (const task of schedule.tasks ?? []) {
    const phaseId = task.source?.type === "project-phase" ? task.source.phaseId : null;
    const phase = bounds.get(phaseId);
    if (!phase) continue;
    if (task.critical && Number.isFinite(task.notBeforeFinishMonth) && schedule.currentMonth < task.notBeforeFinishMonth) {
      cap = Math.min(cap, Math.max(phase.start, phase.end - PHASE_EPSILON));
      reasons.push({
        code: "critical-task-delay",
        taskId: task.id,
        phaseId,
        releaseMonth: task.notBeforeFinishMonth,
      });
    }
  }

  const testing = (schedule.tasks ?? []).find((task) => task.kind === "integrated-testing");
  if (testing) {
    const byId = new Map(schedule.tasks.map((task) => [task.id, task]));
    const unfinished = testing.dependencies.map((id) => byId.get(id)).filter((task) => task?.status !== "complete");
    if (unfinished.length) {
      const phase = bounds.get("testing");
      if (phase) cap = Math.min(cap, phase.start);
      reasons.push({ code: "testing-dependencies", taskId: testing.id, dependencyTaskIds: unfinished.map((task) => task.id) });
    }
  }

  cap = Math.max(0, Math.min(1, round(cap)));
  return { cap, blocked: (project.progress ?? 0) >= cap - PHASE_EPSILON && cap < 1, reasons };
}

export function createConstructionCycleReport({
  atMinute,
  cashBeforeJPY,
  cashAfterJPY,
  construction = [],
  vehicles = [],
  depots = [],
  schedules = [],
  generatedEvents = [],
  autoResolvedEvents = [],
  priceState = null,
  normalPriceChange = null,
  priceShocks = [],
  priceSettlements = [],
  fundingCases = [],
  operatingFinanceSettlements = [],
} = {}) {
  const sumPayments = (items) => items.reduce((sum, item) => sum + Math.max(0, Number(item.payment) || 0), 0);
  const constructionPaymentJPY = sumPayments(construction);
  const vehiclePaymentJPY = sumPayments(vehicles);
  const depotPaymentJPY = sumPayments(depots);
  return {
    schema: CONSTRUCTION_CYCLE_REPORT_SCHEMA,
    contractVersion: 1,
    id: `construction-cycle:${atMinute}`,
    atMinute,
    month: Math.floor(atMinute / (30 * 1440)),
    cashBeforeJPY: Math.round(cashBeforeJPY),
    cashAfterJPY: Math.round(cashAfterJPY),
    cashChangeJPY: Math.round(cashAfterJPY - cashBeforeJPY),
    payments: {
      constructionJPY: Math.round(constructionPaymentJPY),
      vehiclesJPY: Math.round(vehiclePaymentJPY),
      depotsJPY: Math.round(depotPaymentJPY),
      knownTotalJPY: Math.round(constructionPaymentJPY + vehiclePaymentJPY + depotPaymentJPY),
    },
    projects: construction.map((item) => ({
      projectId: item.projectId,
      status: item.status ?? null,
      progress: Number.isFinite(item.progress) ? round(item.progress) : null,
      progressDelta: Number.isFinite(item.progressDelta) ? round(item.progressDelta) : null,
      paymentJPY: Math.round(Number(item.payment) || 0),
      blocked: item.blocked === true,
      reason: item.reason ?? null,
      fundingCaseId: item.fundingCaseId ?? null,
      gateReasons: clone(item.gate?.reasons ?? []),
    })),
    schedules: clone(schedules),
    constructionPrice: priceState ? {
      baseYear: priceState.baseYear,
      currentIndex: priceState.currentIndex,
      normalAnnualRate: priceState.normalAnnualRate,
      normalChange: clone(normalPriceChange),
      shocks: clone(priceShocks),
      settlements: clone(priceSettlements),
    } : null,
    fundingCases: clone(fundingCases),
    operatingFinanceSettlements: clone(operatingFinanceSettlements),
    generatedEventIds: generatedEvents.map((event) => event.id),
    autoResolvedEventIds: autoResolvedEvents.map((entry) => entry.eventId),
  };
}
