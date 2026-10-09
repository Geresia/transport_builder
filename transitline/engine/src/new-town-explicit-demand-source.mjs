// B19-E5: an ACCEPTED new-town demand intake (B19-E4) as an explicit demand SOURCE record that a later B15 step may read.  It is only a
// bridge boundary: it creates, deletes or merges no demand node, changes no access link, overwrites no existing demand source, approves no
// B15 policy, and computes no passengers, fare, crowding, cost, score or probability.  Residents / jobs figures are copied exactly as the
// player stated them (a stated 0 stays 0; nothing is summed, converted or turned into a ratio; null is "not stated").
//
// Only an intake whose status is `accepted` and whose standing is `current` (B19-E4 checked it against the map, pack, lifecycle and
// occupancy facts the player approved) can become a source.  pending / held / rejected / revoked intakes make no source at all; an accepted intake
// that has since gone stale, or cannot be checked without a map, is shown but never applied.  A source that was applied and later goes stale stays
// in the record, reported `stale` - it is not removed, repaired or re-applied; the player withdraws it explicitly.  One live source per
// candidate: a second one is refused, never written over the first.
//
// The application lives in the operational state under its own key (`newTownExplicitDemandSources`) and touches nothing else there.
// Imports nothing: the caller hands in the B19-E4 intake report (`newTownDemandIntakeReport(null, { geometry })`) and the scenario pack id.
export const NEW_TOWN_EXPLICIT_DEMAND_SOURCE_SCHEMA = "transitline.new-town-explicit-demand-source/1";
export const NEW_TOWN_EXPLICIT_DEMAND_SOURCES_SCHEMA = "transitline.new-town-explicit-demand-sources/1";
export const NEW_TOWN_EXPLICIT_DEMAND_SOURCE_APPLICATION_SCHEMA = "transitline.new-town-explicit-demand-source-application/1";
export const NEW_TOWN_EXPLICIT_DEMAND_NOT_COMPUTED = Object.freeze(["population", "demand", "quantity-sum", "residents-jobs-conversion", "ratio", "demand-node", "access-link", "passengers", "trips", "fare", "crowding", "cost", "score", "probability", "b15-policy-approval"]);

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const clone = (v) => structuredClone(v);
const unique = (list) => [...new Set(list)];
const canonical = (v) => (Array.isArray(v) ? `[${v.map(canonical).join(",")}]` : isObject(v) ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}` : JSON.stringify(v ?? null));
const text = (v) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
export const explicitDemandSourceIdOf = (intakeId) => `new-town-explicit-demand-source:${intakeId}`;

// the explicit source of one accepted intake: every figure copied from the approved facts, nothing derived
export function explicitDemandSourceOf(intake) {
  const a = intake.acceptance;
  return {
    schema: NEW_TOWN_EXPLICIT_DEMAND_SOURCE_SCHEMA, contractVersion: 1, sourceId: explicitDemandSourceIdOf(intake.id),
    intakeId: intake.id, candidateId: intake.candidateId, developmentRecordId: intake.developmentRecordId, developmentId: intake.developmentId, phaseId: intake.phaseId, lifecycleHookId: intake.lifecycleHookId,
    sourcePack: clone(a.sourcePack), developmentRevision: a.developmentRevision, phaseRevision: a.phaseRevision,
    lifecycle: clone(a.lifecycle),
    statedDemandFactIds: [...a.statedDemandFactIds],
    statedDemandFacts: a.statedDemandFacts.map((fact) => ({ ...clone(fact), unit: fact.kind })),
    basis: { derivation: "copied-as-stated", statedBy: "player", approvedBy: "new-town-demand-intake", intakeSchema: intake.schema },
  };
}
const contractPartOf = ({ status: _s, appliedAtSimMinute: _a, withdrawal: _w, standing: _t, ...source }) => source;
const storedOf = (state) => state?.newTownExplicitDemandSources?.sources ?? [];

// why an intake cannot become a source now; [] = it can.  scenarioPack: { packId, packVersion }.
function applyBlockers({ intakeId, intake, stored, scenarioPack }) {
  if (!intake) return ["intake-not-found"];
  if (intake.status !== "accepted") return [`intake-not-accepted:${intake.status}`];
  const blockers = [];
  const v = intake.standing.verification;
  if (v.status === "stale") blockers.push("intake-stale", ...v.reasons);
  else if (v.status === "unverified") blockers.push("intake-unverified", ...v.reasons);
  const pack = intake.acceptance.sourcePack;
  if (pack === null || pack.packId !== scenarioPack.packId) blockers.push(`source-pack-differs-from-scenario:${pack?.packId ?? null}`);
  else if (pack.packVersion !== null && scenarioPack.packVersion !== null && pack.packVersion !== scenarioPack.packVersion) blockers.push(`source-pack-version-differs-from-scenario:${pack.packVersion}`);
  const own = stored.find((s) => s.intakeId === intakeId);
  if (own) blockers.push(own.status === "withdrawn" ? `intake-source-withdrawn:${own.sourceId}` : `intake-already-applied:${own.sourceId}`);
  const other = stored.find((s) => s.status === "applied" && s.intakeId !== intakeId && s.developmentRecordId === intake.developmentRecordId && s.candidateId === intake.candidateId);
  if (other) blockers.push(`candidate-already-has-source:${other.sourceId}`);
  return unique(blockers);
}

// what an applied source is now, against the intake it came from
function standingOf(source, intake) {
  if (source.status === "withdrawn") return { status: "withdrawn", reasons: [] };
  if (!intake) return { status: "stale", reasons: ["intake-record-missing"] };
  if (intake.status !== "accepted") return { status: "stale", reasons: [`intake-${intake.status}`] };
  if (canonical(contractPartOf(source)) !== canonical(explicitDemandSourceOf(intake))) return { status: "stale", reasons: ["source-differs-from-intake"] };
  const v = intake.standing.verification;
  if (v.status === "stale") return { status: "stale", reasons: [...v.reasons] };
  if (v.status === "unverified") return { status: "unverified", reasons: [...v.reasons] };
  return { status: "current", reasons: [] };
}

// Read-only.  intakes: the B19-E4 report items (with `standing`).  One source per ACCEPTED intake, each with its standing and whether it can be applied
// now; every other intake appears only in `excluded` (a fact about the intake, never a source).
export function assessNewTownExplicitDemandSources({ state, intakes = [], scenarioPack } = {}) {
  const stored = storedOf(state);
  const sources = []; const excluded = [];
  for (const intake of intakes) {
    if (intake.status !== "accepted") { excluded.push({ intakeId: intake.id, candidateId: intake.candidateId, status: intake.status, reasons: [`intake-not-accepted:${intake.status}`] }); continue; }
    const blockers = applyBlockers({ intakeId: intake.id, intake, stored, scenarioPack });
    const v = intake.standing.verification;
    const applied = stored.find((s) => s.intakeId === intake.id) ?? null;
    sources.push({
      ...explicitDemandSourceOf(intake),
      standing: applied ? standingOf(applied, intake) : { status: v.status === "not-applicable" ? "unverified" : v.status, reasons: [...v.reasons] },
      applied: applied ? applied.status : null,
      apply: { allowed: blockers.length === 0, blockers },
    });
  }
  return {
    schema: NEW_TOWN_EXPLICIT_DEMAND_SOURCES_SCHEMA, contractVersion: 1, sourcePackId: scenarioPack.packId, sourcePackVersion: scenarioPack.packVersion,
    sources, excluded, notComputed: [...NEW_TOWN_EXPLICIT_DEMAND_NOT_COMPUTED],
  };
}

// Apply one accepted, current intake as a source.  Writes only `state.newTownExplicitDemandSources`; returns a copy of the stored source.
export function applyNewTownExplicitDemandSource(state, { intakes = [], intakeId, scenarioPack } = {}) {
  if (!state) throw new Error("Operational state is required");
  const intake = intakes.find((item) => item.id === intakeId);
  const blockers = applyBlockers({ intakeId, intake, stored: storedOf(state), scenarioPack });
  if (blockers.length) throw new Error(`New town explicit demand source for intake ${intakeId} cannot be applied: ${blockers.join(", ")}`);
  const source = { ...explicitDemandSourceOf(intake), status: "applied", appliedAtSimMinute: Number.isFinite(state.simMinutes) ? state.simMinutes : null, withdrawal: null };
  if (!state.newTownExplicitDemandSources) state.newTownExplicitDemandSources = { schema: NEW_TOWN_EXPLICIT_DEMAND_SOURCE_APPLICATION_SCHEMA, contractVersion: 1, sources: [] };
  state.newTownExplicitDemandSources.sources.push(source);
  return clone(source);
}

// The player takes an applied source back (the map is not needed).  The record stays, `withdrawn`; it can never be applied again.
export function withdrawNewTownExplicitDemandSource(state, { sourceId, reason } = {}) {
  const source = storedOf(state).find((s) => s.sourceId === sourceId);
  if (!source) throw new Error(`Unknown new town explicit demand source ${sourceId}`);
  if (source.status !== "applied") throw new Error(`New town explicit demand source ${sourceId} cannot be withdrawn: status-not-allowed:${source.status}`);
  const why = text(reason);
  if (why === null || why.length > 200) throw new Error("A withdrawal reason must be a non-empty text of at most 200 characters");
  source.status = "withdrawn";
  source.withdrawal = { reason: why, atSimMinute: Number.isFinite(state.simMinutes) ? state.simMinutes : null };
  return clone(source);
}

// Read-only copies of the applied sources, each with its standing now (current | stale | unverified | withdrawn).  Without a map in the
// intake report an applied source is at best "unverified": a downstream step must use only `current` ones.
export function newTownExplicitDemandSourceReport(state, { intakes = [] } = {}) {
  return storedOf(state).map((source) => ({ ...clone(source), standing: standingOf(source, intakes.find((i) => i.id === source.intakeId) ?? null) }));
}
