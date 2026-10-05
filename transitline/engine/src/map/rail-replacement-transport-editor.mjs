// Editing and saving what the player drew and chose for a replacement of suspended railway service. Pure data: the map
// offers the partial suspension candidates (see railway-service-control.mjs) and measures what the player draws on
// them (see rail-replacement-transport.mjs); this document records the chosen suspension, the chosen turnback
// candidates and the routes, stops, turning places and constraints the player stated. Running a replacement service
// belongs to the management engine, which reads this document and decides for itself.
// A plan is keyed by `eventId` and the chosen suspension candidate id, so it keeps its id when the player renames or
// reorders anything, redraws a route in the other direction, saves and reopens. A plan is never deleted, only
// deactivated and restored; the player's own drawings can be removed one by one by their key.

export const RAIL_REPLACEMENT_DOC_VERSION = 1;
const LISTS = Object.freeze({ route: "routes", stop: "temporaryStops", area: "turnaroundAreas", constraint: "constraints" });

export const newRailReplacementDoc = (packId, packVersion = null) => ({ version: RAIL_REPLACEMENT_DOC_VERSION, packId, packVersion, plans: [] });

const clone = (v) => structuredClone(v);
const find = (doc, eventId, candidateId) => {
  const plan = doc.plans.find((p) => p.eventId === eventId && p.partialSuspensionCandidateId === candidateId);
  if (!plan) throw new Error(`Unknown replacement plan ${eventId} / ${candidateId}`);
  return plan;
};

// Starts the plan of a chosen suspension. The candidate must be one the control geometry offers; an existing plan is kept.
export function addPlan(doc, eventId, candidateId, control) {
  if (!eventId || !candidateId) throw new Error("A replacement plan needs an event id and a partial suspension candidate id");
  if (!(control?.partialSuspensionCandidates ?? []).some((c) => c.candidateId === candidateId)) throw new Error(`Unknown partialSuspension candidate ${candidateId}`);
  const existing = doc.plans.find((p) => p.eventId === eventId && p.partialSuspensionCandidateId === candidateId);
  if (existing) return existing;
  const plan = { eventId, partialSuspensionCandidateId: candidateId, active: true, selectedOnControlGeometryRevision: control.controlGeometryRevision, turnbackCandidateIds: [], routes: null, temporaryStops: null, turnaroundAreas: null, constraints: null, vehicleWidthMeters: null };
  doc.plans.push(plan);
  return plan;
}

export function selectTurnback(doc, eventId, candidateId, turnbackCandidateId, control) {
  const plan = find(doc, eventId, candidateId);
  if (!(control?.turnbackCandidates ?? []).some((c) => c.candidateId === turnbackCandidateId)) throw new Error(`Unknown turnback candidate ${turnbackCandidateId}`);
  plan.turnbackCandidateIds = [...new Set([...plan.turnbackCandidateIds, turnbackCandidateId])].sort();
  return plan;
}
export function deselectTurnback(doc, eventId, candidateId, turnbackCandidateId) {
  const plan = find(doc, eventId, candidateId);
  plan.turnbackCandidateIds = plan.turnbackCandidateIds.filter((id) => id !== turnbackCandidateId);
  return plan;
}

// The player's drawings. Each is stored as given (copied, never shared with the caller). `null` is "nothing stated" and
// is different from `[]` ("I stated that there are none"): the first list entry turns null into a list, `declareNone` into [].
function upsert(kind) {
  return (doc, eventId, candidateId, item) => {
    const plan = find(doc, eventId, candidateId);
    const list = LISTS[kind];
    const rest = (plan[list] ?? []).filter((x) => !(item.key !== undefined && x.key === item.key));
    plan[list] = [...rest, clone(item)];
    return plan;
  };
}
function remove(kind) {
  return (doc, eventId, candidateId, key) => {
    const plan = find(doc, eventId, candidateId);
    const list = LISTS[kind];
    if (plan[list] !== null) plan[list] = plan[list].filter((x) => x.key !== key);
    return plan;
  };
}
export const setRoute = upsert("route");
export const removeRoute = remove("route");
export const setTemporaryStop = upsert("stop");
export const removeTemporaryStop = remove("stop");
export const setTurnaroundArea = upsert("area");
export const removeTurnaroundArea = remove("area");
export const setConstraint = upsert("constraint");
export const removeConstraint = remove("constraint");
export function declareNone(doc, eventId, candidateId, kind) {
  if (!LISTS[kind]) throw new Error(`Unknown drawing kind ${kind}`);
  const plan = find(doc, eventId, candidateId);
  plan[LISTS[kind]] = [];
  return plan;
}
export function setVehicleWidth(doc, eventId, candidateId, meters) {
  const plan = find(doc, eventId, candidateId);
  plan.vehicleWidthMeters = Number.isFinite(meters) && meters > 0 ? meters : null;
  return plan;
}

// What the plan is now against a control geometry: still offered or not, and whether it was chosen on an older revision.
export function reconcilePlan(doc, eventId, candidateId, control) {
  const plan = find(doc, eventId, candidateId);
  const offered = (control?.partialSuspensionCandidates ?? []).some((c) => c.candidateId === candidateId);
  const stale = (plan.turnbackCandidateIds ?? []).filter((id) => !(control?.turnbackCandidates ?? []).some((c) => c.candidateId === id));
  return { offered, outdated: offered && plan.selectedOnControlGeometryRevision !== control.controlGeometryRevision, staleTurnbackCandidateIds: stale };
}

// A plan is switched off, never deleted: it keeps its id and drawings, and comes back as it was.
export function deactivatePlan(doc, eventId, candidateId) { const p = find(doc, eventId, candidateId); p.active = false; return p; }
export function restorePlan(doc, eventId, candidateId) { const p = find(doc, eventId, candidateId); p.active = true; return p; }
export const activePlans = (doc) => doc.plans.filter((p) => p.active !== false);

// The input of buildRailReplacementTransport.
export const toReplacementDocument = (plan) => clone(plan);

export const serializeRailReplacementDoc = (doc) => JSON.stringify({ version: doc.version, packId: doc.packId, packVersion: doc.packVersion, plans: doc.plans });

// Never applies a saved document to the wrong pack, and never hides a pack version change.
export function restoreRailReplacementDoc(text, pack) {
  const packId = pack.manifest?.id ?? "pack";
  const packVersion = pack.manifest?.version ?? null;
  const fresh = newRailReplacementDoc(packId, packVersion);
  if (text === null || text === undefined) return { doc: fresh, warnings: [] };
  let saved;
  try { saved = JSON.parse(text); } catch { return { doc: fresh, warnings: [{ code: "rail-replacement-doc-unreadable" }] }; }
  if (saved?.version !== RAIL_REPLACEMENT_DOC_VERSION || !Array.isArray(saved.plans)) return { doc: fresh, warnings: [{ code: "rail-replacement-doc-version", version: saved?.version ?? null }] };
  if (saved.packId !== packId) return { doc: fresh, warnings: [{ code: "rail-replacement-doc-other-pack", savedPackId: saved.packId }] };
  const warnings = saved.packVersion !== packVersion ? [{ code: "pack-version-mismatch", saved: saved.packVersion, current: packVersion }] : [];
  return { doc: { ...fresh, plans: saved.plans }, warnings };
}
