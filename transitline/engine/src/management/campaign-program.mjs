// B20-E1 lifecycle.  A campaign program is management state around a B20-M1
// map statement. It owns only status, short history, and references. It never
// advances the clock or synthesizes money, demand, ridership, or a verdict.

export const CAMPAIGN_PROGRAM_SCHEMA = "transitline.campaign-program/1";
export const REGIONAL_PROGRAM_SCHEMA = "transitline.regional-development-program/1";
export const CAMPAIGN_PROGRAM_STATUSES = Object.freeze(["draft", "adopted", "monitoring", "completed", "delayed", "cancelled"]);
export const CAMPAIGN_MILESTONE_STATUSES = Object.freeze(["planned", "reached", "delayed", "cancelled"]);
export const CAMPAIGN_NOT_COMPUTED = Object.freeze(["cost", "demand", "ridership", "fare", "capacity", "roi", "success-probability", "money-movement"]);

const clone = (value) => structuredClone(value);
const text = (value) => typeof value === "string" && value.trim() ? value.trim() : null;
const integer = (value) => Number.isInteger(value) && value >= 0;
const cmp = (a, b) => String(a).localeCompare(String(b));
const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(",")}]` : value && typeof value === "object" ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}` : JSON.stringify(value ?? null);
const sourcePackOf = (geometry) => ({ packId: geometry.sourcePackId.trim(), packVersion: text(geometry.sourcePackVersion) });

export function checkCampaignProgramGeometry(geometry, record = null) {
  if (geometry === null || geometry === undefined) return { status: "missing", reasons: ["geometry-not-provided"] };
  if (!geometry || typeof geometry !== "object" || Array.isArray(geometry)) return { status: "invalid", reasons: ["geometry-not-an-object"] };
  const reasons = [];
  if (geometry.schema !== REGIONAL_PROGRAM_SCHEMA || geometry.contractVersion !== 1) reasons.push("geometry-schema-invalid");
  if (!text(geometry.programId)) reasons.push("geometry-program-id-missing");
  if (!text(geometry.programRevision)) reasons.push("geometry-revision-unknown");
  if (!text(geometry.sourcePackId)) reasons.push("geometry-source-pack-unknown");
  if (!Array.isArray(geometry.milestones)) reasons.push("geometry-milestones-unknown");
  else {
    const ids = new Set();
    geometry.milestones.forEach((milestone, index) => {
      if (!text(milestone?.milestoneId) || ids.has(milestone?.milestoneId) || !integer(milestone?.sequence)) reasons.push(`geometry-milestone-invalid:${index}`);
      ids.add(milestone?.milestoneId);
    });
  }
  if (reasons.length) return { status: "invalid", reasons };
  if (geometry.active !== true) return { status: geometry.active === false ? "inactive" : "invalid", reasons: [geometry.active === false ? "geometry-inactive" : "geometry-active-unknown"] };
  if (record) {
    const stale = [];
    if (record.programId !== geometry.programId) stale.push("geometry-other-program");
    // A geometry-less draft deliberately has no revision, source pack, or
    // milestones yet. Its first adoption binds those facts. Older records
    // which already claim map facts but lack pack identity remain unsafe.
    if (!record.sourcePack) {
      if (record.programRevision !== null || Array.isArray(record.milestones)) stale.push("record-source-pack-unknown");
    } else if (record.sourcePack.packId !== geometry.sourcePackId.trim()) stale.push("geometry-source-pack-changed");
    else if (record.sourcePack.packVersion !== null && text(geometry.sourcePackVersion) !== null && record.sourcePack.packVersion !== geometry.sourcePackVersion.trim()) stale.push("geometry-source-pack-version-changed");
    if (record.programRevision !== null && record.programRevision !== geometry.programRevision) stale.push("geometry-revision-changed");
    const facts = (geometry.milestones ?? []).map((m) => [m.milestoneId, m.sequence, m.targetMonth ?? null, m.durationMonths ?? null]).sort((a, b) => cmp(a[0], b[0]));
    if (Array.isArray(record.milestones) && canonical(record.milestones.map((m) => [m.milestoneId, m.sequence, m.targetMonth, m.durationMonths]).sort((a, b) => cmp(a[0], b[0]))) !== canonical(facts)) stale.push("geometry-milestones-changed");
    if (stale.length) return { status: "stale", reasons: stale };
  }
  return { status: "current", reasons: [] };
}

const stateOf = (check, record, atMinute) => ({ programRevision: record?.programRevision ?? null, status: check.status, reasons: [...check.reasons], checkedAtMinute: atMinute });
const log = (record, kind, from, to, atMinute, reason = null) => record.history.push({ transitionId: `${record.id}:transition:${record.history.length + 1}`, kind, from, to, atMinute, reason });
const linkLists = (source) => Object.fromEntries(["linkedDevelopmentIds", "linkedPlanIds", "linkedStationSiteIds", "linkedServicePlanIds"].map((key) => [key, source?.[key] === undefined ? null : clone(source[key])]));
const milestonesOf = (record, geometry) => geometry.milestones.slice().sort((a, b) => a.sequence - b.sequence || cmp(a.milestoneId, b.milestoneId)).map((milestone) => ({ milestoneId: milestone.milestoneId, sequence: milestone.sequence, targetMonth: milestone.targetMonth ?? null, durationMonths: milestone.durationMonths ?? null, ...linkLists(milestone), status: "planned", declaredAtMinute: null, reason: null, observedRefs: [] }));
const forward = new Set(["adopt", "monitor", "complete", "reachMilestone", "resume"]);
const allowed = {
  adopt: ["draft"], monitor: ["adopted"], complete: ["monitoring"], delay: ["adopted", "monitoring"], resume: ["delayed"], cancel: ["draft", "adopted", "monitoring", "delayed"], reachMilestone: ["adopted", "monitoring"],
};
export function campaignProgramBlockers(record, kind, check, milestoneId = null) {
  const blockers = [];
  if (!allowed[kind]) return [`unknown-transition:${kind}`];
  if (!record) { if (kind !== "adopt") blockers.push("no-program"); }
  else if (!allowed[kind].includes(record.status)) blockers.push(`status-not-allowed:${record.status}`);
  if (forward.has(kind) && check.status !== "current") blockers.push(`geometry-${check.status}`, ...check.reasons);
  if (kind === "reachMilestone") {
    const milestone = record?.milestones?.find((entry) => entry.milestoneId === milestoneId);
    if (!milestone) blockers.push("milestone-not-found"); else if (milestone.status !== "planned") blockers.push(`milestone-status-not-allowed:${milestone.status}`);
  }
  return blockers;
}
const enter = (record, kind, check, milestoneId) => { const blockers = campaignProgramBlockers(record, kind, check, milestoneId); if (blockers.length) throw new Error(`Campaign program ${record?.id ?? "new"} cannot ${kind}: ${blockers.join(", ")}`); };

export function assessCampaignProgram({ geometry = null, record = null } = {}) {
  const check = checkCampaignProgramGeometry(geometry, record);
  const transitions = Object.fromEntries(Object.keys(allowed).filter((kind) => kind !== "reachMilestone").map((kind) => [kind, { allowed: !campaignProgramBlockers(record, kind, check).length, blockers: campaignProgramBlockers(record, kind, check) }]));
  return { schema: "transitline.campaign-program-assessment/1", contractVersion: 1, programRecordId: record?.id ?? null, status: record?.status ?? null, geometry: { status: check.status, reasons: [...check.reasons] }, transitions, milestones: (record?.milestones ?? []).map((milestone) => ({ milestoneId: milestone.milestoneId, status: milestone.status, reach: { allowed: !campaignProgramBlockers(record, "reachMilestone", check, milestone.milestoneId).length, blockers: campaignProgramBlockers(record, "reachMilestone", check, milestone.milestoneId) } })), notComputed: [...CAMPAIGN_NOT_COMPUTED] };
}

export function createCampaignProgramDraft({ id, input = {}, atMinute = 0 } = {}) {
  const geometry = input.geometry ?? null; const check = checkCampaignProgramGeometry(geometry);
  if (geometry !== null && check.status !== "current") throw new Error(`Campaign geometry cannot start a draft: ${check.status}`);
  const programId = geometry ? geometry.programId : text(input.programId);
  if (!programId) throw new Error("A campaign program needs a programId");
  const record = { schema: CAMPAIGN_PROGRAM_SCHEMA, contractVersion: 1, id, programId, programRevision: geometry?.programRevision ?? null, sourcePack: geometry ? sourcePackOf(geometry) : null, status: "draft", links: geometry ? linkLists(geometry) : null, milestones: geometry ? milestonesOf(null, geometry) : null, geometry: null, delay: null, cancellation: null, history: [], createdAtMinute: atMinute, updatedAtMinute: atMinute };
  record.geometry = stateOf(check, record, atMinute); log(record, "draft", null, "draft", atMinute); return clone(record);
}
export function adoptCampaignProgram(record, { geometry = null, atMinute = 0 } = {}) { const check = checkCampaignProgramGeometry(geometry, record); enter(record, "adopt", check); if (record.milestones === null) { record.milestones = milestonesOf(record, geometry); record.links = linkLists(geometry); record.programRevision = geometry.programRevision; record.sourcePack = sourcePackOf(geometry); } record.geometry = stateOf(check, record, atMinute); record.status = "adopted"; log(record, "adopt", "draft", "adopted", atMinute); return clone(record); }
export function monitorCampaignProgram(record, { geometry = null, atMinute = 0 } = {}) { const check = checkCampaignProgramGeometry(geometry, record); enter(record, "monitor", check); record.geometry = stateOf(check, record, atMinute); record.status = "monitoring"; log(record, "monitor", "adopted", "monitoring", atMinute); return clone(record); }
export function completeCampaignProgram(record, { geometry = null, atMinute = 0 } = {}) { const check = checkCampaignProgramGeometry(geometry, record); enter(record, "complete", check); record.geometry = stateOf(check, record, atMinute); record.status = "completed"; log(record, "complete", "monitoring", "completed", atMinute); return clone(record); }
export function delayCampaignProgram(record, reason, { atMinute = 0 } = {}) { const check = checkCampaignProgramGeometry(null, record); enter(record, "delay", check); const from = record.status; record.delay = { fromStatus: from, reason: text(reason), delayedAtMinute: atMinute }; record.status = "delayed"; log(record, "delay", from, "delayed", atMinute, text(reason)); return clone(record); }
export function resumeCampaignProgram(record, { geometry = null, atMinute = 0 } = {}) { const check = checkCampaignProgramGeometry(geometry, record); enter(record, "resume", check); const to = record.delay?.fromStatus; if (!allowed.resume.includes(record.status) || !["adopted", "monitoring"].includes(to)) throw new Error("Campaign delay has no resumable prior status"); record.geometry = stateOf(check, record, atMinute); record.status = to; log(record, "resume", "delayed", to, atMinute); return clone(record); }
export function cancelCampaignProgram(record, reason, { atMinute = 0 } = {}) { const check = checkCampaignProgramGeometry(null, record); enter(record, "cancel", check); const from = record.status; record.cancellation = { fromStatus: from, reason: text(reason), cancelledAtMinute: atMinute }; record.status = "cancelled"; log(record, "cancel", from, "cancelled", atMinute, text(reason)); return clone(record); }
export function reachCampaignMilestone(record, milestoneId, observedRefs = [], { geometry = null, atMinute = 0 } = {}) { const check = checkCampaignProgramGeometry(geometry, record); enter(record, "reachMilestone", check, milestoneId); if (!Array.isArray(observedRefs)) throw new Error("observedRefs must be an array"); const refs = observedRefs.map((ref) => ({ refKind: text(ref?.refKind), refId: text(ref?.refId), state: text(ref?.state), atMinute })).filter((ref) => ref.refKind && ref.refId); if (refs.length !== observedRefs.length) throw new Error("observedRefs entries need refKind and refId"); const milestone = record.milestones.find((entry) => entry.milestoneId === milestoneId); milestone.status = "reached"; milestone.declaredAtMinute = atMinute; milestone.observedRefs = refs.sort((a, b) => cmp(a.refKind, b.refKind) || cmp(a.refId, b.refId)); record.geometry = stateOf(check, record, atMinute); log(record, "reachMilestone", record.status, record.status, atMinute); return clone(record); }
export const campaignProgramHooks = (record) => ({ schema: "transitline.campaign-program-hooks/1", contractVersion: 1, campaignProgramId: record.id, programId: record.programId, programRevision: record.programRevision, status: record.status, sourcePack: clone(record.sourcePack), milestones: clone(record.milestones), transitions: clone(record.history), notComputed: [...CAMPAIGN_NOT_COMPUTED] });
