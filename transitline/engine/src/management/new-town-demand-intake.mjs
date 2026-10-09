// B19-E4: the player's own, explicit decision about a new-town demand CANDIDATE (B19-E2) - accept, hold, reject or revoke - kept as an
// auditable management record.  This is only the safety boundary in front of a later demand step: an accepted record says "the player
// chose these stated demand facts of this phase of this development, as they stood against this map revision, pack and lifecycle".
// It applies nothing: it never reads or changes B15 state, access links or demand nodes, creates no demand node, and computes or
// converts no population, demand, passengers, trips, fare, crowding, cost, score or probability.  The stated quantities are copied as
// they were stated: never summed, never converted between residents and jobs.  `null` is "not stated", `0` a stated zero, `[]` a stated "none".
//
// Nothing is approved on the player's behalf.  A candidate can be accepted only when B19-E2 says `eligibleForB15 === true` (complete input,
// current geometry, lifecycle not cancelled) AND the player names the stated demand facts to use.  After an acceptance, a changed map
// revision / pack / phase, a changed lifecycle, or changed occupancy facts is REPORTED (`standing.currentStatus === "stale"`) and never
// repaired or re-approved; the player revokes and decides again, which makes a new record.  Without a geometry in hand the acceptance cannot be
// confirmed either way and is reported "unverified" - unknown is never turned into "still valid".
//
// record statuses: accepted | held | rejected | revoked;  derived from the current inputs (never stored): pending (no live record) and stale
// (an accepted record whose basis no longer matches).  none -> accept|hold|reject;  held -> accept|reject;  rejected -> accept|hold;
// accepted -> revoke;  revoked is final (a later decision on the same candidate is a new record with a new id).
import { newTownDevelopmentHooks } from "./new-town-development.mjs";
import { buildNewTownDemandCandidates } from "../new-town-demand-candidates.mjs";

export const NEW_TOWN_DEMAND_INTAKE_SCHEMA = "transitline.new-town-demand-intake/1";
export const NEW_TOWN_DEMAND_INTAKE_ASSESSMENT_SCHEMA = "transitline.new-town-demand-intake-assessment/1";
export const NEW_TOWN_DEMAND_INTAKE_STATUSES = Object.freeze(["pending", "accepted", "held", "rejected", "stale", "revoked"]);
export const NEW_TOWN_DEMAND_INTAKE_NOT_COMPUTED = Object.freeze(["population", "demand", "residents-from-area", "jobs-from-area", "quantity-sum", "residents-jobs-conversion", "trips", "passengers", "fare", "crowding", "cost", "score", "probability", "b15-application"]);
// kind -> which live state it can start from ("none" = no live record for the candidate)
export const NEW_TOWN_DEMAND_INTAKE_TRANSITIONS = Object.freeze({
  accept: Object.freeze({ from: Object.freeze(["none", "held", "rejected"]) }),
  hold: Object.freeze({ from: Object.freeze(["none", "rejected"]) }),
  reject: Object.freeze({ from: Object.freeze(["none", "held"]) }),
  revoke: Object.freeze({ from: Object.freeze(["accepted"]) }),
});

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const text = (v) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
const clone = (v) => structuredClone(v);
const canonical = (v) => (Array.isArray(v) ? `[${v.map(canonical).join(",")}]` : isObject(v) ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}` : JSON.stringify(v ?? null));
const sameValue = (a, b) => canonical(a) === canonical(b);
const unique = (list) => [...new Set(list)];
const reasonOf = (value, label) => {
  const reason = text(value);
  if (reason === null || reason.length > 200) throw new Error(`${label} must be a non-empty text of at most 200 characters`);
  return reason;
};

// the lifecycle hooks and the E2 candidates of one lifecycle record, read-only
function readCandidates(development, geometry) {
  const hooks = newTownDevelopmentHooks(development);
  return { hooks, output: buildNewTownDemandCandidates({ hooks, geometry: geometry ?? null }) };
}
const liveRecord = (intakes, developmentRecordId, candidateId) => intakes.find((r) => r.developmentRecordId === developmentRecordId && r.candidateId === candidateId && r.status !== "revoked") ?? null;

// the player's chosen fact ids against the candidate's own stated facts
function factIdProblems(candidate, ids) {
  if (!Array.isArray(ids) || ids.length === 0) return ["stated-demand-fact-ids-not-chosen"];
  const facts = candidate.statedDemandFacts ?? [];
  const problems = []; const seen = new Set(); const kinds = new Map();
  ids.forEach((id, index) => {
    if (typeof id !== "string" || id === "") { problems.push(`stated-demand-fact-id-invalid:${index}`); return; }
    if (seen.has(id)) { problems.push(`stated-demand-fact-id-duplicate:${id}`); return; }
    seen.add(id);
    const fact = facts.find((f) => f.factId === id);
    if (!fact) { problems.push(`stated-demand-fact-not-in-candidate:${id}`); return; }
    kinds.set(fact.kind, (kinds.get(fact.kind) ?? 0) + 1);
  });
  for (const [kind, count] of kinds) if (count > 1) problems.push(`stated-demand-fact-kind-repeated:${kind}`);
  return problems;
}

// -> the blockers of one decision on one candidate (or of revoking one record); [] means the step is open
function blockersOf(kind, { candidate, live, statedDemandFactIds }) {
  if (kind === "revoke") return live && live.status === "accepted" ? [] : [`status-not-allowed:${live ? live.status : "none"}`];
  if (!candidate) return ["candidate-not-found"];
  const blockers = [];
  const state = live ? live.status : "none";
  if (!NEW_TOWN_DEMAND_INTAKE_TRANSITIONS[kind].from.includes(state)) blockers.push(`status-not-allowed:${state}`);
  if (kind === "accept") {
    if (candidate.eligibleForB15 !== true) blockers.push(`candidate-not-eligible:${candidate.eligibleForB15}`);
    for (const b of candidate.inputCompleteness.blockers) blockers.push(`candidate-blocker:${b}`);
    for (const m of candidate.inputCompleteness.missing) blockers.push(`candidate-missing:${m}`);
    if (candidate.geometryStatus.status !== "current") blockers.push(`geometry-${candidate.geometryStatus.status}`, ...candidate.geometryStatus.reasons);
    if (statedDemandFactIds !== undefined) blockers.push(...factIdProblems(candidate, statedDemandFactIds));
  }
  return unique(blockers);
}

// An accepted record against the candidate as it stands now.  stale = something the player approved has changed; unverified = it cannot be
// told (no usable geometry); current = every part of the basis is still the same.
function verifyAcceptance(record, candidate, hooks) {
  const a = record.acceptance;
  if (!candidate) return { status: "stale", reasons: ["candidate-not-found"] };
  const stale = []; const unverified = [];
  if (hooks.status === "cancelled") stale.push("lifecycle-cancelled");
  if (candidate.phaseLifecycleStatus === "cancelled") stale.push("phase-cancelled");
  if (!sameValue(hooks.sourcePack ?? null, a.sourcePack)) stale.push("source-pack-changed");
  if (hooks.developmentRevision !== a.developmentRevision) stale.push("development-revision-changed");
  if (hooks.status !== a.lifecycle.status) stale.push("lifecycle-status-changed");
  if (candidate.phaseLifecycleStatus !== a.lifecycle.phaseStatus) stale.push("phase-lifecycle-status-changed");
  if (!sameValue(hooks.transitions.map((t) => t.transitionId), a.lifecycle.transitionIds)) stale.push("lifecycle-transitions-changed");
  if (!sameValue(candidate.occupancyFactIds, a.occupancyFactIds)) stale.push("occupancy-facts-changed");
  for (const copy of a.statedDemandFacts) {
    const now = (candidate.statedDemandFacts ?? []).find((f) => f.factId === copy.factId);
    if (!now) stale.push(`stated-demand-fact-missing:${copy.factId}`);
    else if (!sameValue(now, copy)) stale.push(`stated-demand-fact-changed:${copy.factId}`);
  }
  const g = candidate.geometryStatus;
  if (g.status === "current") {
    if (candidate.basis.geometryDevelopmentRevision !== a.developmentRevision) stale.push("geometry-revision-changed");
    if ((candidate.phaseRevision ?? null) !== a.phaseRevision) stale.push("phase-revision-changed");
  } else if (["stale", "inactive", "other-pack"].includes(g.status) || g.reasons.includes("geometry-development-not-in-export")) stale.push(`geometry-${g.status}`, ...g.reasons);
  else unverified.push(`geometry-${g.status}`, ...g.reasons);
  if (candidate.eligibleForB15 === false) stale.push("candidate-no-longer-eligible:false");
  else if (candidate.eligibleForB15 === null) unverified.push("candidate-eligibility-unknown");
  if (stale.length) return { status: "stale", reasons: unique(stale) };
  if (unverified.length) return { status: "unverified", reasons: unique(unverified) };
  return { status: "current", reasons: [] };
}

// what the record is now: the stored status, except an accepted record that no longer matches is "stale"
function standingOf(record, candidate, hooks) {
  if (record.status !== "accepted") return { currentStatus: record.status, verification: { status: "not-applicable", reasons: [] } };
  const verification = verifyAcceptance(record, candidate, hooks);
  return { currentStatus: verification.status === "stale" ? "stale" : "accepted", verification };
}

const gateOf = (blockers) => ({ allowed: blockers.length === 0, blockers });

// Read-only.  input: { development (the E1 record), geometry?, intakes, candidateId?, statedDemandFactIds? }.  Every candidate of the development with
// its decision state and what blocks each decision.  With a candidateId (and fact ids), `selected` is that candidate's gates, fact ids included.
export function assessNewTownDemandIntake({ development, geometry = null, intakes = [], candidateId = null, statedDemandFactIds } = {}) {
  const { hooks, output } = readCandidates(development, geometry);
  const entryOf = (candidate, facts) => {
    const live = liveRecord(intakes, development.id, candidate.candidateId);
    const standing = live ? standingOf(live, candidate, hooks) : { currentStatus: "pending", verification: { status: "not-applicable", reasons: [] } };
    return {
      candidateId: candidate.candidateId, phaseId: candidate.phaseId, lifecycleHookId: candidate.lifecycleHookId,
      completeness: candidate.inputCompleteness.status, eligibleForB15: candidate.eligibleForB15,
      geometryStatus: clone(candidate.geometryStatus), statedDemandFacts: clone(candidate.statedDemandFacts),
      intakeId: live?.id ?? null, currentStatus: standing.currentStatus, verification: standing.verification,
      accept: gateOf(blockersOf("accept", { candidate, live, statedDemandFactIds: facts })), hold: gateOf(blockersOf("hold", { candidate, live })),
      reject: gateOf(blockersOf("reject", { candidate, live })), revoke: gateOf(blockersOf("revoke", { live })),
    };
  };
  const candidates = output.candidates.map((c) => entryOf(c, undefined));
  let selected = null;
  if (candidateId !== null && candidateId !== undefined) {
    const candidate = output.candidates.find((c) => c.candidateId === candidateId);
    selected = candidate ? entryOf(candidate, statedDemandFactIds) : { candidateId, intakeId: null, currentStatus: null, accept: gateOf(["candidate-not-found"]), hold: gateOf(["candidate-not-found"]), reject: gateOf(["candidate-not-found"]), revoke: gateOf(["status-not-allowed:none"]) };
  }
  return {
    schema: NEW_TOWN_DEMAND_INTAKE_ASSESSMENT_SCHEMA, contractVersion: 1,
    developmentRecordId: development.id, developmentId: development.developmentId, lifecycleStatus: development.status,
    geometry: clone(output.geometryStatus), candidates, selected, notComputed: [...NEW_TOWN_DEMAND_INTAKE_NOT_COMPUTED],
  };
}

const logDecision = (record, kind, from, to, atMinute, reason) => {
  const sequence = record.history.length + 1;
  record.history.push({ decisionId: `${record.id}:decision:${sequence}`, sequence, kind, from, to, atMinute, reason });
  record.updatedAtMinute = atMinute;
};

function acceptanceOf(candidate, hooks, ids, note, atMinute) {
  return {
    acceptedAtMinute: atMinute, note,
    statedDemandFactIds: [...ids],
    statedDemandFacts: ids.map((id) => clone(candidate.statedDemandFacts.find((f) => f.factId === id))),
    occupancyFactIds: [...candidate.occupancyFactIds],
    developmentRevision: candidate.basis.geometryDevelopmentRevision,
    phaseRevision: candidate.phaseRevision ?? null,
    sourcePack: clone(hooks.sourcePack),
    lifecycle: { status: hooks.status, phaseStatus: candidate.phaseLifecycleStatus, transitionIds: hooks.transitions.map((t) => t.transitionId) },
  };
}

// accept | hold | reject.  Changes `intakes` (push or in place) and returns a copy of the record; throws when a gate blocks it.
// input: { development, geometry?, intakes, candidateId, statedDemandFactIds? (accept), reason? (hold/reject), note? (accept), allocateId, atMinute }
export function decideNewTownDemandCandidate(kind, { development, geometry = null, intakes, candidateId, statedDemandFactIds, reason, note, allocateId, atMinute = 0 } = {}) {
  if (!NEW_TOWN_DEMAND_INTAKE_TRANSITIONS[kind] || kind === "revoke") throw new Error(`Unknown new town demand decision ${kind}`);
  const { hooks, output } = readCandidates(development, geometry);
  const candidate = output.candidates.find((c) => c.candidateId === candidateId) ?? null;
  const live = candidate ? liveRecord(intakes, development.id, candidateId) : null;
  const blockers = blockersOf(kind, { candidate, live, statedDemandFactIds: kind === "accept" ? (statedDemandFactIds ?? null) : undefined });
  if (blockers.length) throw new Error(`New town demand candidate ${candidateId} cannot ${kind}: ${blockers.join(", ")}`);
  const why = kind === "accept" ? null : reasonOf(reason, `A ${kind} reason`);
  const memo = kind === "accept" && note !== undefined && note !== null ? reasonOf(note, "An acceptance note") : null;
  const to = { accept: "accepted", hold: "held", reject: "rejected" }[kind];
  let record = live;
  const from = live ? live.status : "pending";
  if (!record) {
    record = {
      schema: NEW_TOWN_DEMAND_INTAKE_SCHEMA, contractVersion: 1, id: allocateId(), developmentRecordId: development.id, developmentId: hooks.developmentId,
      candidateId: candidate.candidateId, phaseId: candidate.phaseId, lifecycleHookId: candidate.lifecycleHookId,
      status: to, acceptance: null, revocation: null, history: [], createdAtMinute: atMinute, updatedAtMinute: atMinute,
    };
    intakes.push(record);
  }
  record.status = to;
  if (kind === "accept") record.acceptance = acceptanceOf(candidate, hooks, statedDemandFactIds, memo, atMinute);
  logDecision(record, kind, from, to, atMinute, why);
  return clone(record);
}

export function revokeNewTownDemandIntakeRecord(record, reason, atMinute = 0) {
  const blockers = blockersOf("revoke", { live: record });
  if (blockers.length) throw new Error(`New town demand intake ${record.id} cannot revoke: ${blockers.join(", ")}`);
  const why = reasonOf(reason, "A revocation reason");
  record.revocation = { reason: why, revokedAtMinute: atMinute, fromStatus: record.status };
  record.status = "revoked";
  logDecision(record, "revoke", "accepted", "revoked", atMinute, why);
  return clone(record);
}

// Read-only copies of the records, each with its `standing` now: { currentStatus, verification: { status, reasons } }.  With a geometry the
// map checks are made; without one an accepted record can be at best "unverified".  A development that cannot be read is "stale".
export function newTownDemandIntakeReport({ intakes = [], developments = [], geometry = null, id = null } = {}) {
  const cache = new Map();
  const read = (development) => {
    if (!cache.has(development.id)) cache.set(development.id, readCandidates(development, geometry));
    return cache.get(development.id);
  };
  return intakes.filter((r) => id === null || r.id === id).map((record) => {
    const development = developments.find((d) => d.id === record.developmentRecordId);
    let standing;
    if (!development) standing = { currentStatus: record.status === "accepted" ? "stale" : record.status, verification: record.status === "accepted" ? { status: "stale", reasons: ["development-record-missing"] } : { status: "not-applicable", reasons: [] } };
    else {
      const { hooks, output } = read(development);
      standing = standingOf(record, output.candidates.find((c) => c.candidateId === record.candidateId) ?? null, hooks);
    }
    return { ...clone(record), standing };
  });
}
