import { recordIntegratedTaskDelay } from "./integrated-schedule.mjs";

export const CONSTRUCTION_EVENT_SCHEMA = "transitline.construction-event/1";
export const CONSTRUCTION_EVENT_KINDS = Object.freeze([
  "cost-inflation",
  "material-shortage",
  "incident",
  "complaint",
  "permit-delay",
  "utility-conflict",
  "unexpected-ground",
  "access-blocked",
]);
export const CONSTRUCTION_EVENT_SEVERITIES = Object.freeze(["minor", "moderate", "major"]);

const MONTH_MINUTES = 30 * 1440;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const round = (value, digits = 4) => Number(Number(value).toFixed(digits));
const roundMoney = (value) => Math.max(0, Math.round(value / 1_000_000) * 1_000_000);
const clone = (value) => structuredClone(value);

const EVENT_LABELS = Object.freeze({
  "cost-inflation": "공사비 물가 상승",
  "material-shortage": "자재 조달 부족",
  incident: "공사 사고",
  complaint: "주민 민원",
  "permit-delay": "인허가 지연",
  "utility-conflict": "지장물 충돌",
  "unexpected-ground": "예상 외 지반",
  "access-blocked": "공사 접근로 차단",
});

const RESPONSE_BLUEPRINTS = Object.freeze({
  "cost-inflation": [
    { id: "lock-price", label: "잔여 물량 가격 고정", costRate: 0.012, delayMonths: 0, safetyDelta: 0, qualityDelta: 0, reputationDelta: 0, contractorDelta: -2 },
    { id: "absorb-overrun", label: "상승분 즉시 부담", costRate: 0.018, delayMonths: 0, safetyDelta: 0, qualityDelta: 0, reputationDelta: 1, contractorDelta: 2 },
    { id: "value-engineering", label: "설계·사양 재조정", costRate: 0.004, delayMonths: 1, safetyDelta: 0, qualityDelta: -4, reputationDelta: -1, contractorDelta: 0, default: true },
  ],
  "material-shortage": [
    { id: "premium-procurement", label: "긴급 프리미엄 조달", costRate: 0.014, delayMonths: 0, safetyDelta: 0, qualityDelta: 0, reputationDelta: 1, contractorDelta: 2 },
    { id: "approved-substitute", label: "승인된 대체 자재", costRate: 0.006, delayMonths: 1, safetyDelta: 0, qualityDelta: -2, reputationDelta: 0, contractorDelta: 0 },
    { id: "wait-supply", label: "기존 공급 회복 대기", costRate: 0, delayMonths: 2, safetyDelta: 0, qualityDelta: 0, reputationDelta: -1, contractorDelta: -2, default: true },
  ],
  incident: [
    { id: "full-investigation", label: "전면 중지·원인 조사", costRate: 0.01, delayMonths: 2, safetyDelta: 8, qualityDelta: 3, reputationDelta: 3, contractorDelta: -2, default: true },
    { id: "accelerated-recovery", label: "추가 인력·장비 긴급 복구", costRate: 0.02, delayMonths: 0, safetyDelta: 2, qualityDelta: 0, reputationDelta: 0, contractorDelta: 1 },
    { id: "minimum-compliance", label: "최소 법정조치 후 재개", costRate: 0.004, delayMonths: 0, safetyDelta: -7, qualityDelta: -3, reputationDelta: -6, contractorDelta: 0 },
  ],
  complaint: [
    { id: "community-mitigation", label: "방음·진동 저감과 주민지원", costRate: 0.008, delayMonths: 1, safetyDelta: 1, qualityDelta: 1, reputationDelta: 6, contractorDelta: 0, default: true },
    { id: "restrict-hours", label: "야간·휴일 공사 제한", costRate: 0.002, delayMonths: 2, safetyDelta: 2, qualityDelta: 0, reputationDelta: 4, contractorDelta: -1 },
    { id: "continue-work", label: "현 공정 유지", costRate: 0, delayMonths: 0, safetyDelta: -1, qualityDelta: 0, reputationDelta: -8, contractorDelta: 1 },
  ],
  "permit-delay": [
    { id: "compliance-team", label: "전담 인허가팀 투입", costRate: 0.007, delayMonths: 1, safetyDelta: 0, qualityDelta: 1, reputationDelta: 2, contractorDelta: 0, default: true },
    { id: "redesign", label: "허가 조건에 맞춰 재설계", costRate: 0.015, delayMonths: 2, safetyDelta: 2, qualityDelta: 3, reputationDelta: 1, contractorDelta: -1 },
    { id: "wait-authority", label: "행정 처리 대기", costRate: 0, delayMonths: 3, safetyDelta: 0, qualityDelta: 0, reputationDelta: -2, contractorDelta: -1 },
  ],
  "utility-conflict": [
    { id: "relocate-utility", label: "지장물 이설", costRate: 0.02, delayMonths: 1, safetyDelta: 3, qualityDelta: 2, reputationDelta: 1, contractorDelta: 0, default: true },
    { id: "local-redesign", label: "구조물 국부 재설계", costRate: 0.013, delayMonths: 2, safetyDelta: 1, qualityDelta: 0, reputationDelta: 0, contractorDelta: -1 },
    { id: "hold-work", label: "관계기관 협의까지 중지", costRate: 0.003, delayMonths: 4, safetyDelta: 2, qualityDelta: 1, reputationDelta: -1, contractorDelta: -2 },
  ],
  "unexpected-ground": [
    { id: "ground-improvement", label: "지반 보강", costRate: 0.028, delayMonths: 2, safetyDelta: 7, qualityDelta: 4, reputationDelta: 2, contractorDelta: 0, default: true },
    { id: "change-method", label: "시공법 변경", costRate: 0.038, delayMonths: 1, safetyDelta: 5, qualityDelta: 3, reputationDelta: 1, contractorDelta: -1 },
    { id: "extended-investigation", label: "추가 지반조사", costRate: 0.009, delayMonths: 4, safetyDelta: 4, qualityDelta: 2, reputationDelta: -1, contractorDelta: -2 },
  ],
  "access-blocked": [
    { id: "alternate-access", label: "대체 반입로 개설", costRate: 0.01, delayMonths: 1, safetyDelta: 1, qualityDelta: 0, reputationDelta: 0, contractorDelta: 1, default: true },
    { id: "negotiate-access", label: "도로·토지 관리자와 협의", costRate: 0.004, delayMonths: 2, safetyDelta: 1, qualityDelta: 0, reputationDelta: 3, contractorDelta: 0 },
    { id: "pause-logistics", label: "접근 회복까지 반입 중지", costRate: 0, delayMonths: 3, safetyDelta: 0, qualityDelta: 0, reputationDelta: -2, contractorDelta: -2 },
  ],
});

const SEVERITY = Object.freeze({
  minor: { cost: 0.6, delay: 0, unavoidable: 0 },
  moderate: { cost: 1, delay: 0, unavoidable: 1 },
  major: { cost: 1.8, delay: 1, unavoidable: 2 },
});

function assertSchedule(schedule) {
  if (schedule?.schema !== "transitline.integrated-construction-schedule/1") throw new Error("A valid integrated construction schedule is required");
}

function requirePackage(schedule, constructionSiteId) {
  const deliveryPackage = schedule.constructionPackages?.find((entry) => entry.constructionSiteId === constructionSiteId);
  if (!deliveryPackage) throw new Error(`Unknown construction site ${constructionSiteId}`);
  return deliveryPackage;
}

function affectedTask(schedule, deliveryPackage) {
  const tasks = deliveryPackage.taskIds.map((id) => schedule.tasks.find((entry) => entry.id === id)).filter(Boolean);
  const available = tasks.filter((entry) => !["complete", "cancelled", "missing"].includes(entry.status));
  return available.find((entry) => entry.critical && ["active", "delayed"].includes(entry.status))
    ?? available.find((entry) => ["active", "delayed"].includes(entry.status))
    ?? available.find((entry) => entry.critical)
    ?? available[0]
    ?? null;
}

function packageExposure(schedule, deliveryPackage, project) {
  const taskById = new Map(schedule.tasks.map((entry) => [entry.id, entry]));
  const packageWeight = deliveryPackage.taskIds.reduce((sum, id) => sum + Math.max(1, taskById.get(id)?.baselineDurationMonths ?? 1), 0);
  const totalWeight = schedule.tasks.filter((entry) => !["opening-readiness", "design-approval"].includes(entry.kind))
    .reduce((sum, entry) => sum + Math.max(1, entry.baselineDurationMonths), 0);
  const share = clamp(packageWeight / Math.max(1, totalWeight), 0.01, 0.35);
  return roundMoney((project?.estimate?.totalP50 ?? 10_000_000_000) * share);
}

function eventLocation(deliveryPackage) {
  const facts = deliveryPackage.selectedCandidate?.facts;
  if (Array.isArray(facts?.location) && facts.location.length === 2 && facts.location.every(Number.isFinite)) {
    return { location: clone(facts.location), source: "selected-candidate" };
  }
  return { location: null, source: "unknown" };
}

function buildResponses(kind, severity, exposure) {
  const scale = SEVERITY[severity];
  return RESPONSE_BLUEPRINTS[kind].map((item) => ({
    id: item.id,
    label: item.label,
    baseUpfrontCostJPY: roundMoney(exposure * item.costRate * scale.cost),
    baseDelayMonths: item.delayMonths + scale.delay,
    upfrontCostJPY: roundMoney(exposure * item.costRate * scale.cost),
    delayMonths: item.delayMonths + scale.delay,
    safetyDelta: item.safetyDelta,
    qualityDelta: item.qualityDelta,
    reputationDelta: item.reputationDelta,
    contractorRelationshipDelta: item.contractorDelta,
    default: item.default === true,
  }));
}

function severityFromRng(rng) {
  const value = rng.next();
  return value < 0.6 ? "minor" : value < 0.92 ? "moderate" : "major";
}

function weightedKind(deliveryPackage, rng) {
  const site = deliveryPackage.spatialFacts ?? {};
  const flags = new Set(site.spatialFlags ?? []);
  const weights = {
    "cost-inflation": 1.1,
    "material-shortage": 1.3,
    incident: 1.1 + (flags.has("steep-corridor") ? 0.8 : 0) + (flags.has("crosses-water") ? 0.5 : 0),
    complaint: 0.9 + (flags.has("near-residential") ? 1.8 : 0) + (Number.isFinite(site.intersectedBuildingCount) ? Math.min(1, site.intersectedBuildingCount * 0.08) : 0),
    "permit-delay": 0.8 + (flags.has("existing-facility-overlap") ? 0.6 : 0),
    "utility-conflict": 0.8 + (deliveryPackage.kind === "cutCover" ? 1.4 : 0) + (site.constraintUnknown?.includes("utilities") ? 0.4 : 0),
    "unexpected-ground": 0.8 + (["tunnel", "cutCover"].includes(deliveryPackage.kind) ? 1.2 : 0) + ((site.constraintUnknown?.length ?? 0) > 0 ? 0.4 : 0),
    "access-blocked": 0.6 + ((site.vehicleAccessCandidates?.length ?? 0) === 0 ? 1.4 : 0),
  };
  const total = Object.values(weights).reduce((sum, value) => sum + value, 0);
  let cursor = rng.next() * total;
  for (const kind of CONSTRUCTION_EVENT_KINDS) {
    cursor -= weights[kind];
    if (cursor <= 0) return kind;
  }
  return CONSTRUCTION_EVENT_KINDS.at(-1);
}

export function constructionEventRisk(deliveryPackage, countryProfile, difficultyFactor = 1) {
  const site = deliveryPackage?.spatialFacts ?? {};
  const flags = new Set(site.spatialFlags ?? []);
  let multiplier = 1;
  multiplier += flags.size * 0.08;
  if (site.dataQuality === "low") multiplier += 0.15;
  if ((site.unknown?.length ?? 0) >= 5) multiplier += 0.1;
  if (["tunnel", "cutCover"].includes(deliveryPackage?.kind)) multiplier += 0.15;
  const monthlyProbability = clamp(0.006 * (countryProfile?.disputeDelayModifier ?? 1) * difficultyFactor * multiplier, 0, 0.08);
  return { monthlyProbability: round(monthlyProbability, 6), multiplier: round(multiplier), spatialFlags: clone(site.spatialFlags ?? []), dataQuality: site.dataQuality ?? null };
}

export function createConstructionEvent({ id, schedule, project, constructionSiteId, kind, severity = "moderate", clock = { minute: 0 }, risk = null } = {}) {
  assertSchedule(schedule);
  if (!id) throw new Error("Construction event id is required");
  if (!CONSTRUCTION_EVENT_KINDS.includes(kind)) throw new Error(`Unknown construction event kind ${kind}`);
  if (!CONSTRUCTION_EVENT_SEVERITIES.includes(severity)) throw new Error(`Unknown construction event severity ${severity}`);
  const deliveryPackage = requirePackage(schedule, constructionSiteId);
  const task = affectedTask(schedule, deliveryPackage);
  if (!task) throw new Error(`Construction site ${constructionSiteId} has no unfinished schedule task`);
  const exposure = packageExposure(schedule, deliveryPackage, project);
  const located = eventLocation(deliveryPackage);
  return {
    schema: CONSTRUCTION_EVENT_SCHEMA,
    contractVersion: 1,
    id,
    scheduleId: schedule.id,
    projectId: schedule.projectId,
    planId: schedule.planId,
    constructionSiteId,
    affectedTaskId: task.id,
    kind,
    title: EVENT_LABELS[kind],
    severity,
    status: "unresolved",
    occurredAtMinute: clock.minute,
    responseDueMinute: clock.minute + MONTH_MINUTES,
    resolvedAtMinute: null,
    eventLocation: located.location,
    locationSource: located.source,
    unavoidableDelayMonths: kind === "cost-inflation" ? 0 : SEVERITY[severity].unavoidable,
    packageExposureJPY: exposure,
    risk: risk ? clone(risk) : null,
    responses: buildResponses(kind, severity, exposure),
    selectedResponseId: null,
    outcome: null,
  };
}

export function applyConstructionEventOccurrence(event, schedule, clock = { minute: 0 }) {
  if (event?.schema !== CONSTRUCTION_EVENT_SCHEMA) throw new Error("Invalid construction event");
  if (event.scheduleId !== schedule?.id) throw new Error("Construction event belongs to another schedule");
  if (event.unavoidableDelayMonths > 0) {
    event.occurrenceDelay = recordIntegratedTaskDelay(schedule, event.affectedTaskId, {
      months: event.unavoidableDelayMonths,
      reason: event.title,
      source: `construction-event:${event.id}`,
    }, clock);
  }
  return event;
}

export function rollConstructionEvent({ id, schedule, project, countryProfile, difficultyFactor = 1, rng, clock = { minute: 0 }, existingEvents = [] } = {}) {
  assertSchedule(schedule);
  if (!rng?.next) throw new Error("A deterministic RNG is required");
  const taskById = new Map(schedule.tasks.map((entry) => [entry.id, entry]));
  const recentCutoff = clock.minute - 2 * MONTH_MINUTES;
  const candidates = (schedule.constructionPackages ?? [])
    .filter((deliveryPackage) => deliveryPackage.taskIds.some((taskId) => ["active", "delayed"].includes(taskById.get(taskId)?.status)))
    .filter((deliveryPackage) => !existingEvents.some((event) => event.constructionSiteId === deliveryPackage.constructionSiteId
      && (["unresolved", "responding"].includes(event.status) || event.occurredAtMinute > recentCutoff)))
    .sort((a, b) => a.constructionSiteId.localeCompare(b.constructionSiteId));
  for (const deliveryPackage of candidates) {
    const risk = constructionEventRisk(deliveryPackage, countryProfile, difficultyFactor);
    if (rng.next() >= risk.monthlyProbability) continue;
    return createConstructionEvent({
      id,
      schedule,
      project,
      constructionSiteId: deliveryPackage.constructionSiteId,
      kind: weightedKind(deliveryPackage, rng),
      severity: severityFromRng(rng),
      clock,
      risk,
    });
  }
  return null;
}

function ensureMetrics(project) {
  project.constructionMetrics ??= { safety: 70, quality: 70, communityTrust: 70, contractorRelationship: 70 };
  return project.constructionMetrics;
}

export function applyConstructionImpactGeometry(event, impact) {
  if (event?.schema !== CONSTRUCTION_EVENT_SCHEMA) throw new Error("Invalid construction event");
  if (!["unresolved", "responding"].includes(event.status)) throw new Error(`Construction event ${event.id} is already ${event.status}`);
  if (impact?.schema !== "transitline.construction-impact-geometry/1" || impact.contractVersion !== 1) throw new Error("Invalid ConstructionImpactGeometry");
  if (impact.eventId !== event.id || impact.constructionSiteId !== event.constructionSiteId || impact.eventKind !== event.kind) throw new Error("Construction impact does not match its event");
  const candidates = [...(impact.linkedCandidateIds ?? []), ...(impact.alternativeCandidates ?? [])];
  const selected = impact.selectedResponseCandidateId
    ? candidates.find((candidate) => candidate.id === impact.selectedResponseCandidateId)
    : null;
  if (impact.selectedResponseCandidateId && !selected) throw new Error("Selected construction response candidate is not offered by the impact geometry");

  let costMultiplier = 1;
  let delayDelta = 0;
  let relocationSurchargeJPY = 0;
  const accessible = impact.spatialFacts?.majorRoadAccessible;
  if (accessible === true) costMultiplier -= 0.05;
  else if (accessible === false) { costMultiplier += 0.12; delayDelta += 1; }
  if (event.kind === "complaint" && Number.isFinite(impact.spatialFacts?.distanceToResidentialMeters) && impact.spatialFacts.distanceToResidentialMeters <= 100) costMultiplier += 0.1;
  if (selected) {
    delayDelta -= 1;
    const distance = Number.isFinite(selected.distanceMeters) ? selected.distanceMeters : 0;
    relocationSurchargeJPY = roundMoney(event.packageExposureJPY * Math.min(0.1, distance / 15_000));
  }
  costMultiplier = round(clamp(costMultiplier, 0.75, 1.35));
  for (const response of event.responses) {
    response.baseUpfrontCostJPY ??= response.upfrontCostJPY;
    response.baseDelayMonths ??= response.delayMonths;
    response.upfrontCostJPY = roundMoney(response.baseUpfrontCostJPY * costMultiplier + (response.baseUpfrontCostJPY > 0 ? relocationSurchargeJPY : 0));
    response.delayMonths = Math.max(0, response.baseDelayMonths + delayDelta);
  }
  event.spatialImpact = clone(impact);
  event.spatialResponseAdjustment = {
    selectedResponseCandidateId: selected?.id ?? null,
    selectedCandidateKind: selected?.kind ?? null,
    selectedCandidateDistanceMeters: Number.isFinite(selected?.distanceMeters) ? selected.distanceMeters : null,
    majorRoadAccessible: accessible ?? null,
    costMultiplier,
    relocationSurchargeJPY,
    delayDelta,
  };
  if (Array.isArray(impact.eventLocation)) {
    event.eventLocation = clone(impact.eventLocation);
    event.locationSource = "construction-impact";
  }
  event.status = selected ? "responding" : "unresolved";
  return clone(event.spatialResponseAdjustment);
}

export function resolveConstructionEvent(event, responseId, { schedule, project, player, ledger, clock = { minute: 0 }, automatic = false } = {}) {
  if (event?.schema !== CONSTRUCTION_EVENT_SCHEMA) throw new Error("Invalid construction event");
  if (!["unresolved", "responding"].includes(event.status)) throw new Error(`Construction event ${event.id} is already ${event.status}`);
  if (event.scheduleId !== schedule?.id || event.projectId !== project?.id) throw new Error("Construction event context does not match");
  const response = event.responses.find((entry) => entry.id === responseId);
  if (!response) throw new Error(`Unknown construction response ${responseId}`);
  if (response.upfrontCostJPY > 0) {
    ledger.post({
      atMinute: clock.minute,
      amount: -response.upfrontCostJPY,
      category: "construction-event-response",
      reference: event.id,
      memo: response.label,
    });
  }
  let responseDelay = null;
  const task = schedule.tasks.find((entry) => entry.id === event.affectedTaskId);
  if (response.delayMonths > 0 && task && !["complete", "cancelled"].includes(task.status)) {
    responseDelay = recordIntegratedTaskDelay(schedule, event.affectedTaskId, {
      months: response.delayMonths,
      reason: `${event.title}: ${response.label}`,
      source: `construction-response:${event.id}`,
    }, clock);
  }
  const metrics = ensureMetrics(project);
  metrics.safety = clamp(metrics.safety + response.safetyDelta, 0, 100);
  metrics.quality = clamp(metrics.quality + response.qualityDelta, 0, 100);
  metrics.communityTrust = clamp(metrics.communityTrust + response.reputationDelta, 0, 100);
  metrics.contractorRelationship = clamp(metrics.contractorRelationship + response.contractorRelationshipDelta, 0, 100);
  player.reputation = clamp(player.reputation + response.reputationDelta, 0, 100);
  event.status = "resolved";
  event.resolvedAtMinute = clock.minute;
  event.selectedResponseId = response.id;
  event.outcome = {
    automatic,
    upfrontCostJPY: response.upfrontCostJPY,
    unavoidableDelayMonths: event.unavoidableDelayMonths,
    responseDelayMonths: response.delayMonths,
    safetyDelta: response.safetyDelta,
    qualityDelta: response.qualityDelta,
    reputationDelta: response.reputationDelta,
    contractorRelationshipDelta: response.contractorRelationshipDelta,
    responseDelayEventId: responseDelay?.id ?? null,
  };
  return clone(event.outcome);
}

export function ignoreConstructionEvent(event, { schedule, project, player, clock = { minute: 0 } } = {}) {
  if (event?.schema !== CONSTRUCTION_EVENT_SCHEMA) throw new Error("Invalid construction event");
  if (!["unresolved", "responding"].includes(event.status)) throw new Error(`Construction event ${event.id} is already ${event.status}`);
  if (event.scheduleId !== schedule?.id || event.projectId !== project?.id) throw new Error("Construction event context does not match");
  const severityDelay = event.severity === "major" ? 3 : event.severity === "moderate" ? 2 : 1;
  const task = schedule.tasks.find((entry) => entry.id === event.affectedTaskId);
  let delayEvent = null;
  if (task && !["complete", "cancelled"].includes(task.status)) {
    delayEvent = recordIntegratedTaskDelay(schedule, event.affectedTaskId, {
      months: severityDelay,
      reason: `${event.title}: 대응하지 않음`,
      source: `construction-ignored:${event.id}`,
    }, clock);
  }
  const metrics = ensureMetrics(project);
  metrics.safety = clamp(metrics.safety - 5, 0, 100);
  metrics.quality = clamp(metrics.quality - 2, 0, 100);
  metrics.communityTrust = clamp(metrics.communityTrust - 8, 0, 100);
  metrics.contractorRelationship = clamp(metrics.contractorRelationship - 2, 0, 100);
  player.reputation = clamp(player.reputation - 8, 0, 100);
  event.status = "ignored";
  event.resolvedAtMinute = clock.minute;
  event.selectedResponseId = null;
  event.outcome = {
    automatic: false,
    ignored: true,
    upfrontCostJPY: 0,
    unavoidableDelayMonths: event.unavoidableDelayMonths,
    responseDelayMonths: severityDelay,
    safetyDelta: -5,
    qualityDelta: -2,
    reputationDelta: -8,
    contractorRelationshipDelta: -2,
    responseDelayEventId: delayEvent?.id ?? null,
  };
  return clone(event.outcome);
}

export function defaultConstructionResponse(event) {
  if (event?.schema !== CONSTRUCTION_EVENT_SCHEMA) throw new Error("Invalid construction event");
  return event.responses.find((entry) => entry.default)?.id ?? event.responses.at(-1)?.id ?? null;
}

