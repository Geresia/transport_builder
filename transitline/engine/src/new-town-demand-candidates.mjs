// B19-E2: a pure bridge from what the player STATED about a new town's occupancy (B19-E1 lifecycle hooks) and what the map drew
// (B19-M1 development geometry) to "demand candidates" that the B15 demand model can read later.  A candidate says: this phase has
// occupancy facts the player stated, here is where it is, here is every number the player stated in a demand kind, copied as it was
// stated.  It converts nothing: no residents or jobs from floor area, land use or stated supply, no occupancy rate, demand, trips,
// passengers, fare, crowding, cost, score or probability.  It never touches B15 state or demand nodes and replaces or merges none.
//
// Statuses are facts, not rules: `inputCompleteness` says whether the inputs a reader needs are all there; `eligibleForB15` is only
// that status spelled true / false / null (complete / blocked / incomplete).  Unknown is never turned into "fine".
//
// Reads (never writes): `hooks` = ManagementGame.newTownDevelopmentHooks(id) of B19-E1 and `geometry` = one development of the
// B19-M1 export (or the export itself, from which the hooks' developmentId is picked).  Imports nothing.
export const NEW_TOWN_DEMAND_CANDIDATES_SCHEMA = "transitline.new-town-demand-candidates/1";
const HOOKS_SCHEMA = "transitline.new-town-development-hooks/1";
const GEOMETRY_SCHEMA = "transitline.new-town-development-geometry/1";
const GEOMETRY_EXPORT_SCHEMA = "transitline.new-town-development-export/1";
// The grammar of a stated demand fact: an occupancy fact whose `unit` is exactly one of these words states that many of them.
export const STATED_DEMAND_KINDS = Object.freeze(["residents", "jobs"]);
export const NEW_TOWN_DEMAND_NOT_COMPUTED = Object.freeze(["residents-from-area", "jobs-from-area", "demand-from-supply", "occupancy-rate", "trips", "passengers", "fare", "crowding", "cost", "score", "probability", "demand-allocation"]);

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const text = (v) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const clone = (v) => structuredClone(v);
const isPoint = (p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite);

// which development of the geometry input, or why none
function pickDevelopment(geometry, developmentId) {
  if (geometry === null || geometry === undefined) return { development: null, status: "missing", reasons: ["geometry-not-provided"] };
  if (!isObject(geometry)) return { development: null, status: "invalid", reasons: ["geometry-not-an-object"] };
  if (geometry.schema === GEOMETRY_EXPORT_SCHEMA) {
    const found = Array.isArray(geometry.developments) ? geometry.developments.find((d) => isObject(d) && d.developmentId === developmentId) : undefined;
    return found ? { development: found, status: null, reasons: [] } : { development: null, status: "missing", reasons: ["geometry-development-not-in-export"] };
  }
  if (geometry.schema !== GEOMETRY_SCHEMA || geometry.contractVersion !== 1) return { development: null, status: "invalid", reasons: ["geometry-schema-invalid"] };
  return { development: geometry, status: null, reasons: [] };
}

// development level: the geometry must be the very one the lifecycle was linked to
function developmentGeometryStatus(hooks, picked) {
  if (picked.development === null) return { status: picked.status, reasons: picked.reasons };
  const dev = picked.development;
  if (dev.developmentId !== hooks.developmentId) return { status: "stale", reasons: ["geometry-other-development"] };
  const pack = hooks.sourcePack ?? null;
  if (pack === null) return { status: "pack-unknown", reasons: ["lifecycle-source-pack-unknown"] };
  if (text(dev.sourcePackId) === null) return { status: "invalid", reasons: ["geometry-source-pack-unknown"] };
  if (pack.packId !== dev.sourcePackId.trim()) return { status: "other-pack", reasons: ["geometry-source-pack-changed"] };
  if (pack.packVersion !== null && text(dev.sourcePackVersion) !== null && pack.packVersion !== dev.sourcePackVersion.trim()) return { status: "stale", reasons: ["geometry-source-pack-version-changed"] };
  if (hooks.developmentRevision !== null && hooks.developmentRevision !== dev.developmentRevision) return { status: "stale", reasons: ["geometry-revision-changed"] };
  if (dev.active === false) return { status: "inactive", reasons: ["geometry-inactive"] };
  if (dev.active !== true) return { status: "invalid", reasons: ["geometry-active-unknown"] };
  if (!Array.isArray(dev.phases)) return { status: "invalid", reasons: ["geometry-phases-unknown"] };
  return { status: "current", reasons: [] };
}

function phaseGeometryStatus(devStatus, geometryPhase, hookPhase) {
  if (devStatus.status !== "current") return devStatus;
  if (!isObject(geometryPhase)) return { status: "stale", reasons: ["phase-not-in-geometry"] };
  if (geometryPhase.active === false) return { status: "inactive", reasons: ["phase-inactive"] };
  if (geometryPhase.active !== true) return { status: "invalid", reasons: ["phase-active-unknown"] };
  if ((geometryPhase.playerDeclaredLandUse ?? null) !== (hookPhase.playerDeclaredLandUse ?? null)) return { status: "stale", reasons: ["phase-land-use-changed"] };
  return { status: "current", reasons: [] };
}

// the player's stated numbers in a demand kind, as stated; everything else is named and left out
function statedDemandFacts(occupancyFacts) {
  const used = []; const ignored = [];
  for (const fact of [...occupancyFacts].sort((a, b) => a.sequence - b.sequence)) {
    const unit = text(fact.unit);
    let reason = null;
    if (unit === null) reason = "occupancy-unit-not-stated";
    else if (!STATED_DEMAND_KINDS.includes(unit)) reason = `occupancy-unit-not-a-demand-kind:${unit}`;
    else if (fact.statedOccupiedUnits === null || fact.statedOccupiedUnits === undefined) reason = "occupancy-fact-states-no-occupied-quantity";
    else if (!Number.isInteger(fact.statedOccupiedUnits) || fact.statedOccupiedUnits < 0) reason = "occupancy-quantity-invalid";
    if (reason) ignored.push({ factId: fact.factId, reason });
    else used.push({ factId: fact.factId, sequence: fact.sequence, recordedAtMinute: fact.recordedAtMinute, kind: unit, quantity: fact.statedOccupiedUnits, source: fact.source ?? null, note: fact.note ?? null });
  }
  return { used, ignored };
}

function candidateOf(hooks, hookPhase, geometryPhase, devStatus, geometryRevision) {
  const status = phaseGeometryStatus(devStatus, geometryPhase, hookPhase);
  const unknown = []; const unknownReasons = {};
  const mark = (field, reason) => { unknown.push(field); unknownReasons[field] = reason; };
  const facts = statedDemandFacts(hookPhase.occupancyFacts);
  let demandFacts = null;
  if (facts.used.length) demandFacts = facts.used;
  else mark("statedDemandFacts", facts.ignored.length ? "no-occupancy-fact-states-a-demand-kind" : "no-occupancy-fact");
  const current = status.status === "current";
  let location = null;
  if (!current) mark("location", `geometry-${status.status}`);
  else if (isPoint(geometryPhase.location)) location = [...geometryPhase.location];
  else mark("location", text(geometryPhase.unknownReasons?.location) ?? "no-location");
  let demandNodeRefsInside = null;
  if (!current) mark("demandNodeRefsInside", `geometry-${status.status}`);
  else if (Array.isArray(geometryPhase.spatialFacts?.demandNodeRefsInside)) demandNodeRefsInside = geometryPhase.spatialFacts.demandNodeRefsInside.map(String);
  else mark("demandNodeRefsInside", text(geometryPhase.spatialFacts?.unknownReasons?.demandNodeRefsInside) ?? text(geometryPhase.unknownReasons?.demandNodeRefsInside) ?? "not-provided");
  if (hookPhase.playerDeclaredLandUse === null || hookPhase.playerDeclaredLandUse === undefined) mark("playerDeclaredLandUse", "not-stated");

  const cancelled = hooks.status === "cancelled" || hookPhase.status === "cancelled";
  const blockers = [];
  if (cancelled) blockers.push(hooks.status === "cancelled" ? "lifecycle-cancelled" : "phase-cancelled");
  if (["stale", "other-pack", "inactive"].includes(status.status)) blockers.push(`geometry-${status.status}`);
  const missing = [];
  if (["missing", "invalid", "pack-unknown"].includes(status.status)) missing.push(`geometry-${status.status}`);
  if (demandFacts === null) missing.push("statedDemandFacts");
  if (location === null && current) missing.push("location");
  const completeness = blockers.length ? "blocked" : missing.length ? "incomplete" : "complete";
  const warnings = [];
  const kinds = demandFacts ? demandFacts.map((f) => f.kind) : [];
  if (new Set(kinds).size < kinds.length) warnings.push({ code: "several-stated-facts-for-one-kind-not-merged" });
  if (facts.ignored.length) warnings.push({ code: "occupancy-facts-without-a-demand-kind", factIds: facts.ignored.map((f) => f.factId), reasons: facts.ignored.map((f) => f.reason) });
  if (hooks.status === "delayed") warnings.push({ code: "development-delayed" });

  return {
    candidateId: `new-town-demand-candidate:${hooks.developmentId}:${hookPhase.phaseId}`,
    developmentId: hooks.developmentId, phaseId: hookPhase.phaseId, phaseRevision: isObject(geometryPhase) ? text(geometryPhase.phaseRevision) : null,
    lifecycleHookId: hookPhase.hookId, sequence: hookPhase.sequence,
    geometryStatus: { status: status.status, reasons: [...status.reasons] },
    recordedGeometryStatus: hooks.geometryStatus ?? null,
    lifecycleStatus: hooks.status, phaseLifecycleStatus: hookPhase.status,
    state: { stale: status.status === "stale", inactive: status.status === "inactive", otherPack: status.status === "other-pack", cancelled, delayed: hooks.status === "delayed" },
    playerDeclaredLandUse: hookPhase.playerDeclaredLandUse ?? null,
    location, statedDemandFacts: demandFacts, occupancyFactIds: [...hookPhase.occupancyFacts].sort((a, b) => a.sequence - b.sequence).map((f) => f.factId),
    demandNodeRefsInside,
    inputCompleteness: { status: completeness, blockers, missing },
    eligibleForB15: completeness === "complete" ? true : completeness === "blocked" ? false : null,
    unknown: unknown.sort(cmp), unknownReasons, warnings,
    basis: { derivation: "copied-as-stated", statedBy: "player", lifecycleSchema: hooks.schema, geometryDevelopmentRevision: geometryRevision },
  };
}

// -> the candidate contract.  Throws only for a hooks input that is not E1's; a geometry that is missing or wrong is reported, not thrown.
export function buildNewTownDemandCandidates({ hooks, geometry = null } = {}) {
  if (!isObject(hooks) || hooks.schema !== HOOKS_SCHEMA || !Array.isArray(hooks.phases) || !Array.isArray(hooks.transitions) || text(hooks.developmentId) === null) {
    throw new Error("hooks must be the B19-E1 newTownDevelopmentHooks output");
  }
  for (const phase of hooks.phases) if (!isObject(phase) || text(phase.phaseId) === null || !Array.isArray(phase.occupancyFacts)) throw new Error("hooks has a phase without occupancyFacts");
  const picked = pickDevelopment(geometry, hooks.developmentId);
  const devStatus = developmentGeometryStatus(hooks, picked);
  const dev = picked.development;
  const geometryPhases = Array.isArray(dev?.phases) ? dev.phases : [];
  const geometryRevision = devStatus.status === "current" ? text(dev.developmentRevision) : null;
  const withFacts = hooks.phases.filter((phase) => phase.occupancyFacts.length > 0).sort((a, b) => a.sequence - b.sequence || cmp(a.phaseId, b.phaseId));
  const candidates = withFacts.map((phase) => candidateOf(hooks, phase, geometryPhases.find((g) => isObject(g) && g.phaseId === phase.phaseId), devStatus, geometryRevision));
  const unknown = []; const unknownReasons = {};
  const pack = hooks.sourcePack ?? null;
  if (pack === null) { unknown.push("sourcePackId", "sourcePackVersion"); unknownReasons.sourcePackId = "lifecycle-source-pack-unknown"; unknownReasons.sourcePackVersion = "lifecycle-source-pack-unknown"; }
  else if (pack.packVersion === null) { unknown.push("sourcePackVersion"); unknownReasons.sourcePackVersion = "not-stated"; }
  if (hooks.developmentRevision === null || hooks.developmentRevision === undefined) { unknown.push("developmentRevision"); unknownReasons.developmentRevision = "lifecycle-not-linked-to-a-geometry"; }
  if (devStatus.status !== "current") { unknown.push("geometry"); unknownReasons.geometry = devStatus.reasons[0]; }
  const warnings = [];
  if (hooks.status === "delayed") warnings.push({ code: "development-delayed" });
  if (hooks.status === "cancelled") warnings.push({ code: "development-cancelled" });
  return {
    schema: NEW_TOWN_DEMAND_CANDIDATES_SCHEMA, contractVersion: 1,
    developmentId: hooks.developmentId, developmentRevision: hooks.developmentRevision ?? null,
    sourcePackId: pack?.packId ?? null, sourcePackVersion: pack?.packVersion ?? null,
    lifecycleStatus: hooks.status, geometryStatus: { status: devStatus.status, reasons: [...devStatus.reasons] },
    candidates,
    phasesWithoutCandidate: hooks.phases.filter((phase) => phase.occupancyFacts.length === 0).map((phase) => ({ phaseId: phase.phaseId, phaseLifecycleStatus: phase.status, reason: "no-occupancy-fact" })),
    unknown: unknown.sort(cmp), unknownReasons, warnings,
    sourceReferences: {
      lifecycle: { schema: hooks.schema, developmentHookId: hooks.developmentHookId ?? null, transitionIds: hooks.transitions.map((t) => t.transitionId) },
      geometry: dev === null ? null : clone({ schema: dev.schema ?? null, developmentId: dev.developmentId ?? null, developmentRevision: dev.developmentRevision ?? null, sourcePackId: dev.sourcePackId ?? null, sourcePackVersion: dev.sourcePackVersion ?? null }),
    },
    notComputed: [...NEW_TOWN_DEMAND_NOT_COMPUTED],
  };
}
