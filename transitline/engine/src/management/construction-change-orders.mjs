import { recordIntegratedTaskDelay } from "./integrated-schedule.mjs";

export const CONSTRUCTION_CHANGE_ORDER_SCHEMA = "transitline.construction-change-order/1";
export const CONSTRUCTION_CHANGE_REASONS = Object.freeze([
  "owner-design-change",
  "contractor-proposal",
  "utility-conflict",
  "unexpected-ground",
  "safety-requirement",
  "community-agreement",
  "value-engineering",
]);
export const CONSTRUCTION_CHANGE_RESPONSIBILITIES = Object.freeze(["owner", "contractor", "shared", "force-majeure", "disputed"]);

const REASON_TERMS = Object.freeze({
  "owner-design-change": { costFactor: 1.08, uncertainty: 1.15, durationFactor: 1 },
  "contractor-proposal": { costFactor: 0.98, uncertainty: 1.12, durationFactor: 0.8 },
  "utility-conflict": { costFactor: 1.18, uncertainty: 1.3, durationFactor: 1.2 },
  "unexpected-ground": { costFactor: 1.25, uncertainty: 1.4, durationFactor: 1.4 },
  "safety-requirement": { costFactor: 1.15, uncertainty: 1.2, durationFactor: 1.1 },
  "community-agreement": { costFactor: 1.1, uncertainty: 1.18, durationFactor: 1 },
  "value-engineering": { costFactor: 0.9, uncertainty: 0.7, durationFactor: 0.6 },
});

const clone = (value) => structuredClone(value);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const roundMoney = (value) => Math.round(value / 1_000_000) * 1_000_000;

function assertSchedule(schedule) {
  if (schedule?.schema !== "transitline.integrated-construction-schedule/1") throw new Error("A valid integrated construction schedule is required");
}

function requirePackage(schedule, constructionSiteId) {
  const deliveryPackage = schedule.constructionPackages?.find((entry) => entry.constructionSiteId === constructionSiteId);
  if (!deliveryPackage) throw new Error(`Unknown construction site ${constructionSiteId}`);
  if (!deliveryPackage.procurement?.contract) throw new Error(`Construction site ${constructionSiteId} has no awarded package contract`);
  return deliveryPackage;
}

function packageProgress(schedule, deliveryPackage) {
  const tasks = new Map(schedule.tasks.map((entry) => [entry.id, entry]));
  let weight = 0;
  let completed = 0;
  for (const taskId of deliveryPackage.taskIds ?? []) {
    const task = tasks.get(taskId);
    if (!task) continue;
    const taskWeight = Math.max(1, task.currentDurationMonths ?? task.baselineDurationMonths ?? 1);
    weight += taskWeight;
    completed += taskWeight * clamp(Number(task.progress) || 0, 0, 1);
  }
  return weight ? completed / weight : 0;
}

function ownerShareFor(responsibility, reason, contract) {
  if (responsibility === "disputed") return null;
  if (responsibility === "owner") return 1;
  if (responsibility === "contractor") return 0;
  if (responsibility === "force-majeure") return 0.5;
  if (reason === "unexpected-ground") return clamp(Number(contract.terms?.ownerGroundRiskShare) || 0.5, 0, 1);
  return 0.5;
}

function splitImpact(grossP50, grossP90, responsibility, reason, contract) {
  const ownerShare = ownerShareFor(responsibility, reason, contract);
  if (ownerShare === null) return { ownerShare: null, ownerCostDeltaP50: null, ownerCostDeltaP90: null, contractorCostDeltaP50: null, contractorCostDeltaP90: null };
  const ownerCostDeltaP50 = roundMoney(grossP50 * ownerShare);
  const ownerCostDeltaP90 = roundMoney(grossP90 * ownerShare);
  return {
    ownerShare,
    ownerCostDeltaP50,
    ownerCostDeltaP90,
    contractorCostDeltaP50: grossP50 - ownerCostDeltaP50,
    contractorCostDeltaP90: grossP90 - ownerCostDeltaP90,
  };
}

function validateProposalInput(input) {
  if (!CONSTRUCTION_CHANGE_REASONS.includes(input?.reason)) throw new Error(`Unknown construction change reason ${input?.reason}`);
  if (!CONSTRUCTION_CHANGE_RESPONSIBILITIES.includes(input?.responsibility)) throw new Error(`Unknown construction change responsibility ${input?.responsibility}`);
  if (!["owner", "contractor", "authority"].includes(input?.requestedBy)) throw new Error(`Unknown construction change requester ${input?.requestedBy}`);
  if (typeof input.geometryRevisionBefore !== "string" || !input.geometryRevisionBefore) throw new Error("A base geometry revision is required");
  if (typeof input.geometryRevisionAfter !== "string" || !input.geometryRevisionAfter || input.geometryRevisionAfter === input.geometryRevisionBefore) throw new Error("A distinct proposed geometry revision is required");
  if (!Number.isFinite(input.scopeDeltaRate) || input.scopeDeltaRate === 0 || input.scopeDeltaRate < -0.25 || input.scopeDeltaRate > 0.5) throw new Error("Scope delta rate must be between -0.25 and 0.5 and cannot be zero");
  if (input.reason === "value-engineering" && input.scopeDeltaRate >= 0) throw new Error("Value engineering must reduce the priced scope");
  if (input.reason !== "value-engineering" && input.scopeDeltaRate < 0) throw new Error("Only value engineering may propose a negative scope delta");
  if (input.durationDeltaMonths !== undefined && (!Number.isInteger(input.durationDeltaMonths) || input.durationDeltaMonths < 0 || input.durationDeltaMonths > 24)) throw new Error("Duration delta must be a whole number from 0 to 24 months");
  if (input.designEdit !== undefined && input.designEdit !== null) {
    if (input.designEdit.schema !== "transitline.site-design-edit/1") throw new Error("Invalid SiteDesignEdit schema");
    if (input.designEdit.status !== "submitted") throw new Error("Only a submitted SiteDesignEdit can request a contract change");
    if (input.designEdit.baseRevision !== input.geometryRevisionBefore) throw new Error("SiteDesignEdit base revision does not match the construction change");
  }
}

export function proposeConstructionChangeOrder({ id, schedule, project, contractors = [], input, clock = { minute: 0 } } = {}) {
  assertSchedule(schedule);
  if (typeof id !== "string" || !id) throw new Error("A construction change order id is required");
  if (schedule.projectId !== project?.id) throw new Error("Construction schedule does not match its project");
  validateProposalInput(input);
  const deliveryPackage = requirePackage(schedule, input.constructionSiteId);
  const contract = deliveryPackage.procurement.contract;
  if (!["awarded", "active", "suspended"].includes(contract.status)) throw new Error(`Package contract cannot change from ${contract.status}`);
  if (deliveryPackage.approvedGeometryRevision && deliveryPackage.approvedGeometryRevision !== input.geometryRevisionBefore) throw new Error(`Stale geometry revision ${input.geometryRevisionBefore}; current revision is ${deliveryPackage.approvedGeometryRevision}`);
  schedule.constructionChangeOrders ??= [];
  const duplicate = schedule.constructionChangeOrders.find((entry) => entry.constructionSiteId === input.constructionSiteId
    && entry.geometryRevisionBefore === input.geometryRevisionBefore && entry.geometryRevisionAfter === input.geometryRevisionAfter);
  if (duplicate) throw new Error(`Geometry revision change already exists as ${duplicate.id}`);
  const progress = packageProgress(schedule, deliveryPackage);
  if (progress >= 1) throw new Error("A completed construction package cannot receive a design change");
  const terms = REASON_TERMS[input.reason];
  const remainingContractExposureJPY = roundMoney(contract.currentPriceP50 * (1 - progress));
  const grossCostDeltaP50 = roundMoney(remainingContractExposureJPY * input.scopeDeltaRate * terms.costFactor);
  const grossCostDeltaP90 = grossCostDeltaP50 >= 0
    ? roundMoney(grossCostDeltaP50 * terms.uncertainty)
    : roundMoney(grossCostDeltaP50 * terms.uncertainty);
  const durationDeltaMonths = input.durationDeltaMonths ?? Math.max(0, Math.ceil(Math.abs(input.scopeDeltaRate) * contract.durationMonths * terms.durationFactor));
  const split = splitImpact(grossCostDeltaP50, grossCostDeltaP90, input.responsibility, input.reason, contract);
  const contractor = contractors.find((entry) => entry.id === contract.contractorId) ?? null;
  const order = {
    schema: CONSTRUCTION_CHANGE_ORDER_SCHEMA,
    contractVersion: 1,
    id,
    scheduleId: schedule.id,
    projectId: project.id,
    constructionSiteId: deliveryPackage.constructionSiteId,
    packageContractId: contract.id,
    contractorId: contract.contractorId,
    geometryRevisionBefore: input.geometryRevisionBefore,
    geometryRevisionAfter: input.geometryRevisionAfter,
    reason: input.reason,
    requestedBy: input.requestedBy,
    responsibility: input.responsibility,
    status: input.responsibility === "disputed" ? "disputed" : "proposed",
    scopeDeltaRate: input.scopeDeltaRate,
    packageProgress: Number(progress.toFixed(6)),
    remainingContractExposureJPY,
    grossCostDeltaP50,
    grossCostDeltaP90,
    ...split,
    durationDeltaMonths,
    affectedTaskIds: clone(deliveryPackage.taskIds),
    sourceEventId: input.sourceEventId ?? null,
    designEdit: input.designEdit ? clone(input.designEdit) : null,
    description: String(input.description ?? ""),
    contractorFinancialStrengthAtProposal: contractor?.financialStrength ?? null,
    proposedAtMinute: clock.minute,
  };
  schedule.constructionChangeOrders.push(order);
  return clone(order);
}

function requireOrder(schedule, changeOrderId) {
  const order = schedule.constructionChangeOrders?.find((entry) => entry.id === changeOrderId);
  if (!order) throw new Error(`Unknown construction change order ${changeOrderId}`);
  return order;
}

export function resolveConstructionChangeResponsibility(schedule, changeOrderId, responsibility, clock = { minute: 0 }) {
  assertSchedule(schedule);
  if (!CONSTRUCTION_CHANGE_RESPONSIBILITIES.includes(responsibility) || responsibility === "disputed") throw new Error("A resolved responsibility must identify owner, contractor, shared or force-majeure");
  const order = requireOrder(schedule, changeOrderId);
  if (order.status !== "disputed") throw new Error("Only a disputed change order needs responsibility resolution");
  const deliveryPackage = requirePackage(schedule, order.constructionSiteId);
  Object.assign(order, splitImpact(order.grossCostDeltaP50, order.grossCostDeltaP90, responsibility, order.reason, deliveryPackage.procurement.contract));
  order.responsibility = responsibility;
  order.status = "proposed";
  order.responsibilityResolvedAtMinute = clock.minute;
  return clone(order);
}

export function approveConstructionChangeOrder(schedule, project, changeOrderId, clock = { minute: 0 }) {
  assertSchedule(schedule);
  if (schedule.projectId !== project?.id) throw new Error("Construction schedule does not match its project");
  const order = requireOrder(schedule, changeOrderId);
  if (order.status !== "proposed") throw new Error(`Construction change order cannot be approved from ${order.status}`);
  const deliveryPackage = requirePackage(schedule, order.constructionSiteId);
  const contract = deliveryPackage.procurement.contract;
  if (contract.id !== order.packageContractId) throw new Error("Construction package contract changed after the proposal");
  if (deliveryPackage.approvedGeometryRevision && deliveryPackage.approvedGeometryRevision !== order.geometryRevisionBefore) throw new Error(`Stale geometry revision ${order.geometryRevisionBefore}; current revision is ${deliveryPackage.approvedGeometryRevision}`);
  const nextP50 = project.estimate.totalP50 + order.ownerCostDeltaP50;
  const nextP90 = project.estimate.totalP90 + order.ownerCostDeltaP90;
  if (nextP50 < project.paid) throw new Error("Approved savings cannot reduce the project estimate below paid construction cost");
  if (nextP50 < 0 || nextP90 < 0) throw new Error("Approved change would make the project estimate negative");
  contract.currentPriceP50 += order.ownerCostDeltaP50;
  contract.priceP90 += order.ownerCostDeltaP90;
  contract.durationMonths += order.durationDeltaMonths;
  contract.changeOrders ??= [];
  contract.changeOrders.push({ id: order.id, status: "approved", costDeltaP50: order.ownerCostDeltaP50, costDeltaP90: order.ownerCostDeltaP90, durationDeltaMonths: order.durationDeltaMonths });
  project.estimate.totalP50 = nextP50;
  project.estimate.totalP90 = nextP90;
  const replacement = schedule.constructionContractReplacement;
  if (replacement) {
    replacement.awardedP50 += order.ownerCostDeltaP50;
    replacement.awardedP90 += order.ownerCostDeltaP90;
    replacement.deltaP50 = replacement.awardedP50 - replacement.legacyP50;
    replacement.deltaP90 = replacement.awardedP90 - replacement.legacyP90;
  }
  let delayEvent = null;
  if (order.durationDeltaMonths > 0) {
    const affected = order.affectedTaskIds.map((taskId) => schedule.tasks.find((entry) => entry.id === taskId)).filter(Boolean);
    const task = affected.find((entry) => !["complete", "cancelled"].includes(entry.status));
    if (!task) throw new Error("No unfinished schedule task remains for the approved change");
    delayEvent = recordIntegratedTaskDelay(schedule, task.id, {
      months: order.durationDeltaMonths,
      reason: `설계변경 ${order.id}: ${order.reason}`,
      source: `construction-change-order:${order.id}`,
    }, clock);
  }
  order.status = "approved";
  order.approvedAtMinute = clock.minute;
  order.delayEventId = delayEvent?.id ?? null;
  deliveryPackage.approvedGeometryRevision = order.geometryRevisionAfter;
  return clone(order);
}

export function rejectConstructionChangeOrder(schedule, changeOrderId, reason = "Not approved", clock = { minute: 0 }) {
  assertSchedule(schedule);
  const order = requireOrder(schedule, changeOrderId);
  if (!["proposed", "disputed"].includes(order.status)) throw new Error(`Construction change order cannot be rejected from ${order.status}`);
  order.status = "rejected";
  order.rejectedAtMinute = clock.minute;
  order.rejectionReason = String(reason || "Not approved");
  return clone(order);
}

export function constructionChangeOrderSummary(schedule) {
  assertSchedule(schedule);
  return clone(schedule.constructionChangeOrders ?? []);
}

