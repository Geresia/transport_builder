// B19-E3: who has agreed to contribute how much to a railway project for a new-town development, under which conditions - as an auditable
// management contract.  Every amount, payer, payee, condition and link is a value the player or the scenario STATED; nothing is derived from
// a development's area, land use, population, demand or occupancy, and no amount is estimated, split or defaulted.  `null` is "not stated",
// `0` is a stated zero, `[]` is a stated "none".
//
// Money: an agreement or a payer's confirmed payment creates no cash.  Only `release` can reach the ledger, once, and only when the
// payer is not the player and the payee is the player's side (the caller posts it through `post`, inside ManagementGame.transact).
// Conditions are never met or paid automatically: release needs each stated condition confirmed by the caller.  Nothing here draws a random
// number, reads a clock, or applies a B15 demand candidate or fires a B14 event: it only keeps stable hook ids.
//
// The map's geometry is read-only input (see new-town-development.mjs).  A forward step (propose / agree / fund / release / resume) needs
// the development to be known, not cancelled, still the revision and pack this contribution was made for, and a CURRENT geometry.
// Unknown (null / missing) is never turned into "fine".  Delaying and terminating never need the map.
//
// contribution: draft -> proposed -> agreed -> funded -> released;  proposed|agreed|funded -> delayed -> (back);  anything not released -> terminated.
import { checkNewTownGeometry } from "./new-town-development.mjs";

export const NEW_TOWN_RAIL_CONTRIBUTION_SCHEMA = "transitline.new-town-rail-contribution/1";
export const NEW_TOWN_RAIL_CONTRIBUTION_STATUSES = Object.freeze(["draft", "proposed", "agreed", "funded", "released", "delayed", "terminated"]);
export const NEW_TOWN_RAIL_PAYER_KINDS = Object.freeze(["municipality", "developer", "player", "other"]);
export const NEW_TOWN_RAIL_PAYEE_KINDS = Object.freeze(["player-railway", "project", "other"]);
export const NEW_TOWN_RAIL_PURPOSES = Object.freeze(["station", "rail-extension", "access", "depot", "other"]);
export const NEW_TOWN_RAIL_CONTRIBUTION_LEDGER_CATEGORY = "new-town-rail-contribution";
export const NEW_TOWN_RAIL_CONTRIBUTION_NOT_COMPUTED = Object.freeze(["amount-from-area", "amount-from-population", "amount-from-demand", "amount-from-occupancy", "subsidy-estimate", "land-price", "feasibility", "condition-satisfaction", "automatic-payment"]);

// kind -> where it can start from, and whether it needs the development to be current (known, not cancelled, current geometry)
export const NEW_TOWN_RAIL_CONTRIBUTION_TRANSITIONS = Object.freeze({
  propose: Object.freeze({ from: Object.freeze(["draft"]), gate: true }),
  agree: Object.freeze({ from: Object.freeze(["proposed"]), gate: true }),
  fund: Object.freeze({ from: Object.freeze(["agreed"]), gate: true }),
  release: Object.freeze({ from: Object.freeze(["funded"]), gate: true }),
  delay: Object.freeze({ from: Object.freeze(["proposed", "agreed", "funded"]), gate: false }),
  resume: Object.freeze({ from: Object.freeze(["delayed"]), gate: true }),
  terminate: Object.freeze({ from: Object.freeze(["draft", "proposed", "agreed", "funded", "delayed"]), gate: false }),
});

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const text = (v) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
const clone = (v) => structuredClone(v);
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const yen = (v) => Number.isSafeInteger(v) && v >= 0;
const reasonOf = (value, label) => {
  const reason = text(value);
  if (reason === null || reason.length > 200) throw new Error(`${label} must be a non-empty text of at most 200 characters`);
  return reason;
};
const oneOf = (value, list, label) => {
  if (!list.includes(value)) throw new Error(`${label} must be one of ${list.join(", ")}`);
  return value;
};

// --- input normalisation ------------------------------------------------------------------------------------------------------------
function normalizeAmount(value) {
  if (value === undefined || value === null) return null;
  if (!yen(value)) throw new Error("statedAmountYen must be a non-negative integer or null");
  return value;
}
function normalizeIdList(value, label) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.some((entry) => text(entry) === null)) throw new Error(`${label} must be a list of non-empty texts`);
  const unique = [...new Set(value.map((entry) => entry.trim()))];
  if (unique.length !== value.length) throw new Error(`${label} must not repeat an id`);
  return unique.sort(cmp);
}
function normalizeConditions(value) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) throw new Error("conditions must be a list");
  const ids = new Set();
  return value.map((condition) => {
    const conditionId = text(condition?.conditionId);
    if (conditionId === null || ids.has(conditionId) || text(condition.text) === null) throw new Error(`Condition is invalid or repeated: ${conditionId}`);
    ids.add(conditionId);
    return { conditionId, text: condition.text.trim() };
  }).sort((a, b) => cmp(a.conditionId, b.conditionId));
}
function normalizeConfirmation(value) {
  if (!isObject(value)) return { problem: "confirmation-not-provided" };
  if (!yen(value.confirmedAmountYen) || text(value.confirmedBy) === null || text(value.reference) === null) return { problem: "confirmation-invalid" };
  return { confirmation: { confirmedAmountYen: value.confirmedAmountYen, confirmedBy: value.confirmedBy.trim(), reference: value.reference.trim() } };
}

// --- the development gate ------------------------------------------------------------------------------------------------------------
// ctx: { development (the B19-E1 record, or null), geometry (read-only, or null) }.  Every reason a forward step is not allowed.
function gateBlockers(record, { development = null, geometry = null } = {}) {
  const blockers = [];
  if (record.developmentRevision === null) blockers.push("development-revision-unknown");
  if ((record.sourcePack ?? null) === null) blockers.push("source-pack-unknown");
  if (!isObject(development)) return [...blockers, "development-record-missing"];
  if (development.id !== record.developmentRecordId || development.developmentId !== record.developmentId) blockers.push("development-record-mismatch");
  if (development.status === "cancelled") blockers.push("development-cancelled");
  if (record.developmentRevision !== null && development.developmentRevision !== record.developmentRevision) blockers.push("development-revision-mismatch");
  const pack = development.sourcePack ?? null;
  if (record.sourcePack && (pack === null || pack.packId !== record.sourcePack.packId || pack.packVersion !== record.sourcePack.packVersion)) blockers.push("source-pack-mismatch");
  const check = checkNewTownGeometry(geometry, development);
  if (check.status !== "current") blockers.push(`geometry-${check.status}`, ...check.reasons);
  if (Array.isArray(record.phaseIds) && record.phaseIds.length) {
    if (!Array.isArray(development.phases)) blockers.push("linked-phases-unverifiable");
    else for (const phaseId of record.phaseIds) {
      const phase = development.phases.find((entry) => entry.phaseId === phaseId);
      if (!phase) blockers.push(`phase-unknown:${phaseId}`);
      else if (phase.status === "cancelled") blockers.push(`phase-cancelled:${phaseId}`);
    }
  }
  return blockers;
}

// the links release must find current: projects in the game, plans and station sites in what the host says exists
function linkBlockers(record, { projects = null, currentLinks = null } = {}) {
  const blockers = [];
  if (Array.isArray(record.linkedProjectIds) && record.linkedProjectIds.length) {
    if (!Array.isArray(projects)) blockers.push("linked-projects-not-verifiable");
    else for (const id of record.linkedProjectIds) {
      const project = projects.find((entry) => entry.id === id);
      if (!project) blockers.push(`linked-project-missing:${id}`);
      else if (project.status === "cancelled") blockers.push(`linked-project-cancelled:${id}`);
    }
  }
  for (const [field, key, name] of [["linkedPlanIds", "planIds", "plan"], ["linkedStationSiteIds", "stationSiteIds", "station-site"]]) {
    if (!Array.isArray(record[field]) || !record[field].length) continue;
    const current = isObject(currentLinks) ? currentLinks[key] : undefined;
    if (!Array.isArray(current)) blockers.push(`linked-${name}s-not-verifiable`);
    else for (const id of record[field]) if (!current.includes(id)) blockers.push(`linked-${name}-not-current:${id}`);
  }
  return blockers;
}

function conditionBlockers(record, confirmations) {
  const blockers = [];
  const stated = Array.isArray(record.conditions) ? record.conditions : [];
  const given = Array.isArray(confirmations) ? confirmations : [];
  const seen = new Set();
  for (const entry of given) {
    const id = text(entry?.conditionId);
    if (id === null || !stated.some((c) => c.conditionId === id)) blockers.push(`condition-unknown:${id}`);
    else if (seen.has(id)) blockers.push(`condition-confirmation-repeated:${id}`);
    seen.add(id);
  }
  for (const condition of stated) if (!seen.has(condition.conditionId)) blockers.push(`condition-not-confirmed:${condition.conditionId}`);
  return blockers;
}

// agreement terms: the stated ones win over the draft's
function effectiveTerms(record, terms) {
  const t = isObject(terms) ? terms : {};
  return {
    statedAmountYen: t.statedAmountYen !== undefined ? normalizeAmount(t.statedAmountYen) : record.statedAmountYen,
    conditions: t.conditions !== undefined ? normalizeConditions(t.conditions) : record.conditions,
  };
}
function agreeBlockers(record, terms) {
  const blockers = [];
  if (terms.statedAmountYen === null) blockers.push("amount-not-stated");
  if (terms.conditions === null) blockers.push("conditions-not-stated");
  if (record.payeeKind === "project" && !(Array.isArray(record.linkedProjectIds) && record.linkedProjectIds.length)) blockers.push("payee-project-needs-a-linked-project");
  return blockers;
}
function fundBlockers(record, confirmationInput) {
  const parsed = normalizeConfirmation(confirmationInput);
  if (parsed.problem) return [parsed.problem];
  return record.statedAmountYen !== null && parsed.confirmation.confirmedAmountYen !== record.statedAmountYen ? ["confirmed-amount-differs-from-stated"] : [];
}

// What release would do to the ledger: only a payer outside the player paying the player's side moves money, and only a stated amount above zero.
export function contributionReleaseEffect(record) {
  const amount = record.funding?.confirmedAmountYen ?? null;
  if (amount === null) return { kind: "none", amountYen: null, reason: "not-funded" };
  if (record.payerKind === "player") return { kind: "none", amountYen: amount, reason: "payer-is-the-player-no-cash-created" };
  if (record.payeeKind === "other") return { kind: "none", amountYen: amount, reason: "payee-is-not-the-player-side" };
  if (amount === 0) return { kind: "none", amountYen: 0, reason: "stated-zero" };
  return { kind: "post", amountYen: amount, reason: null };
}

// Why a step is not possible now: [] means it is.  ctx: { development, geometry, projects, currentLinks, terms, confirmation, conditionConfirmations }.
export function contributionTransitionBlockers(record, kind, ctx = {}) {
  const rule = NEW_TOWN_RAIL_CONTRIBUTION_TRANSITIONS[kind];
  if (!rule) return [`unknown-transition:${kind}`];
  if (!record) return ["no-contribution"];
  const blockers = [];
  if (!rule.from.includes(record.status)) blockers.push(`status-not-allowed:${record.status}`);
  if (rule.gate) blockers.push(...gateBlockers(record, ctx));
  if (kind === "agree") blockers.push(...agreeBlockers(record, effectiveTerms(record, ctx.terms)));
  if (kind === "fund") blockers.push(...fundBlockers(record, ctx.confirmation));
  if (kind === "release") blockers.push(...conditionBlockers(record, ctx.conditionConfirmations), ...linkBlockers(record, ctx));
  return blockers;
}
function enter(record, kind, ctx) {
  const blockers = contributionTransitionBlockers(record, kind, ctx);
  if (blockers.length) throw new Error(`Contribution ${record.contributionId} cannot ${kind}: ${blockers.join(", ")}`);
}

// Read-only: what blocks each step and what a release would do to the ledger.  Changes nothing.
export function assessContribution(record, ctx = {}) {
  return {
    schema: "transitline.new-town-rail-contribution-assessment/1", contractVersion: 1,
    contributionId: record.contributionId, status: record.status,
    transitions: Object.fromEntries(Object.keys(NEW_TOWN_RAIL_CONTRIBUTION_TRANSITIONS).map((kind) => {
      const blockers = contributionTransitionBlockers(record, kind, ctx);
      return [kind, { allowed: blockers.length === 0, blockers }];
    })),
    releaseEffect: contributionReleaseEffect(record),
    notComputed: [...NEW_TOWN_RAIL_CONTRIBUTION_NOT_COMPUTED],
  };
}

// --- the record ----------------------------------------------------------------------------------------------------------------------
function logTransition(record, kind, from, to, atMinute, extra = {}) {
  const sequence = record.history.length + 1;
  record.history.push({ transitionId: `${record.contributionId}:transition:${sequence}`, sequence, kind, from, to, atMinute, reason: extra.reason ?? null });
  record.updatedAtMinute = atMinute;
}
const lastTransitionId = (development) => (Array.isArray(development?.history) && development.history.length ? development.history.at(-1).transitionId : null);
// what the development looked like when a forward step was last accepted
function noteGate(record, { development, geometry }, atMinute) {
  record.gate = { developmentRevision: development.developmentRevision ?? null, sourcePack: clone(development.sourcePack ?? null), developmentStatus: development.status, developmentLastTransitionId: lastTransitionId(development), geometryStatus: checkNewTownGeometry(geometry, development).status, checkedAtMinute: atMinute };
}

export function createContributionDraft({ id, input = {}, development, atMinute = 0 } = {}) {
  if (!isObject(development) || text(development.id) === null) throw new Error("A contribution needs an existing new town development record (developmentRecordId)");
  if (development.status === "cancelled") throw new Error(`Development ${development.id} is cancelled`);
  const record = {
    schema: NEW_TOWN_RAIL_CONTRIBUTION_SCHEMA, contractVersion: 1, contributionId: id, name: text(input.name),
    developmentRecordId: development.id, developmentId: development.developmentId, developmentRevision: development.developmentRevision ?? null,
    sourcePack: clone(development.sourcePack ?? null),
    phaseIds: normalizeIdList(input.phaseIds, "phaseIds"),
    payerKind: oneOf(input.payerKind, NEW_TOWN_RAIL_PAYER_KINDS, "payerKind"), payeeKind: oneOf(input.payeeKind, NEW_TOWN_RAIL_PAYEE_KINDS, "payeeKind"),
    statedPurpose: oneOf(input.statedPurpose, NEW_TOWN_RAIL_PURPOSES, "statedPurpose"),
    linkedProjectIds: normalizeIdList(input.linkedProjectIds, "linkedProjectIds"), linkedPlanIds: normalizeIdList(input.linkedPlanIds, "linkedPlanIds"), linkedStationSiteIds: normalizeIdList(input.linkedStationSiteIds, "linkedStationSiteIds"),
    statedAmountYen: normalizeAmount(input.statedAmountYen), conditions: normalizeConditions(input.conditions),
    status: "draft", gate: null, agreement: null, funding: null, release: null, delay: null, termination: null,
    history: [], createdAtMinute: atMinute, updatedAtMinute: atMinute,
  };
  logTransition(record, "draft", null, "draft", atMinute);
  return clone(record);
}

export function proposeContributionRecord(record, ctx, atMinute = 0) {
  enter(record, "propose", ctx);
  noteGate(record, ctx, atMinute);
  record.status = "proposed";
  logTransition(record, "propose", "draft", "proposed", atMinute);
  return clone(record);
}

export function agreeContributionRecord(record, terms, ctx, atMinute = 0) {
  const effective = effectiveTerms(record, terms);
  enter(record, "agree", { ...ctx, terms });
  noteGate(record, ctx, atMinute);
  record.statedAmountYen = effective.statedAmountYen;
  record.conditions = effective.conditions;
  record.agreement = { agreedAtMinute: atMinute, statedAmountYen: effective.statedAmountYen, conditions: clone(effective.conditions) };
  record.status = "agreed";
  logTransition(record, "agree", "proposed", "agreed", atMinute);
  return clone(record);
}

// the payer's confirmed payment, as a fact; it creates no cash
export function fundContributionRecord(record, confirmationInput, ctx, atMinute = 0) {
  enter(record, "fund", { ...ctx, confirmation: confirmationInput });
  noteGate(record, ctx, atMinute);
  const { confirmation } = normalizeConfirmation(confirmationInput);
  record.funding = { fundedAtMinute: atMinute, ...confirmation };
  record.status = "funded";
  logTransition(record, "fund", "agreed", "funded", atMinute);
  return clone(record);
}

// `post(amountYen, memo)` is the caller's ledger posting (inside ManagementGame.transact); it is called only after everything else is checked.
export function releaseContributionRecord(record, ctx, { atMinute = 0, post } = {}) {
  enter(record, "release", ctx);
  noteGate(record, ctx, atMinute);
  const effect = contributionReleaseEffect(record);
  let ledgerEntryId = null;
  if (effect.kind === "post") {
    if (typeof post !== "function") throw new Error("release needs a ledger post");
    ledgerEntryId = post(effect.amountYen, `New-town rail contribution ${record.contributionId}`);
  }
  record.release = {
    releasedAtMinute: atMinute, amountYen: effect.amountYen, ledgerEffect: effect.kind === "post" ? "posted" : "none", ledgerEffectReason: effect.reason, ledgerEntryId,
    conditionConfirmations: (ctx.conditionConfirmations ?? []).map((entry) => ({ conditionId: entry.conditionId.trim(), note: text(entry.note) })).sort((a, b) => cmp(a.conditionId, b.conditionId)),
  };
  record.status = "released";
  logTransition(record, "release", "funded", "released", atMinute);
  return clone(record);
}

export function delayContributionRecord(record, reason, atMinute = 0) {
  const why = reasonOf(reason, "A delay reason");
  enter(record, "delay", {});
  const from = record.status;
  record.delay = { reason: why, delayedAtMinute: atMinute, fromStatus: from, resumedAtMinute: null };
  record.status = "delayed";
  logTransition(record, "delay", from, "delayed", atMinute, { reason: why });
  return clone(record);
}

export function resumeContributionRecord(record, ctx, atMinute = 0) {
  enter(record, "resume", ctx);
  noteGate(record, ctx, atMinute);
  const back = record.delay.fromStatus;
  record.delay = { ...record.delay, resumedAtMinute: atMinute };
  record.status = back;
  logTransition(record, "resume", "delayed", back, atMinute);
  return clone(record);
}

// A funded contribution that was never released moved no cash on the ledger, so terminating it has nothing to reverse.
export function terminateContributionRecord(record, reason, atMinute = 0) {
  const why = reasonOf(reason, "A termination reason");
  enter(record, "terminate", {});
  const from = record.status;
  const fundedNotReleased = record.funding !== null;
  record.termination = { reason: why, terminatedAtMinute: atMinute, fromStatus: from, fundedNotReleased };
  record.status = "terminated";
  logTransition(record, "terminate", from, "terminated", atMinute, { reason: why });
  return clone(record);
}

// What the UI, a B15 bridge or a B14 bridge reads: stable ids and the stated facts as they are.  Nothing is applied or fired from here.
export function newTownRailContributionHooks(record) {
  return {
    schema: "transitline.new-town-rail-contribution-hooks/1", contractVersion: 1,
    hookId: record.contributionId, contributionId: record.contributionId, developmentRecordId: record.developmentRecordId, developmentId: record.developmentId,
    developmentRevision: record.developmentRevision, sourcePack: clone(record.sourcePack ?? null), status: record.status,
    phaseHookIds: Array.isArray(record.phaseIds) ? record.phaseIds.map((phaseId) => `${record.developmentRecordId}:phase:${phaseId}`) : null,
    payerKind: record.payerKind, payeeKind: record.payeeKind, statedPurpose: record.statedPurpose, statedAmountYen: record.statedAmountYen,
    links: { linkedProjectIds: clone(record.linkedProjectIds), linkedPlanIds: clone(record.linkedPlanIds), linkedStationSiteIds: clone(record.linkedStationSiteIds) },
    funded: record.funding !== null, released: record.release !== null,
    ledger: record.release && record.release.ledgerEntryId !== null ? { entryId: record.release.ledgerEntryId, amountYen: record.release.amountYen } : null,
    transitions: record.history.map((entry) => ({ transitionId: entry.transitionId, kind: entry.kind, from: entry.from, to: entry.to, atMinute: entry.atMinute })),
    notComputed: [...NEW_TOWN_RAIL_CONTRIBUTION_NOT_COMPUTED],
  };
}
