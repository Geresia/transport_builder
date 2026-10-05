// Editing and saving what the player chose and drew for a detour over another company's track. Pure data: the map
// offers detour candidates (see railway-service-control.mjs) and the legs, connections and transfers of a chosen one
// (see railway-detour-service.mjs); this document records the chosen detour, which of its legs / connections /
// transfers the player picked, and the connection lines and transfer passages the player drew. Judging, contracting
// and running the detour belong to the management engine, which reads this document and decides for itself.
// A plan is keyed by `eventId` and the chosen detour candidate id, so it keeps its id when the player renames or
// reorders anything, redraws a line in the other direction, saves and reopens. A plan is never deleted, only
// deactivated and restored; the player's own drawings can be removed one by one by their key.

export const RAILWAY_DETOUR_DOC_VERSION = 1;
export const PICK_KINDS = Object.freeze(["leg", "connection", "transfer"]);
const PICKED = Object.freeze({ leg: "legIds", connection: "connectionIds", transfer: "transferIds" });
const LISTS = Object.freeze({ connection: "connections", transferPath: "transferPaths" });

export const newRailwayDetourDoc = (packId, packVersion = null) => ({ version: RAILWAY_DETOUR_DOC_VERSION, packId, packVersion, plans: [] });

const clone = (v) => structuredClone(v);
const find = (doc, eventId, candidateId) => {
  const plan = doc.plans.find((p) => p.eventId === eventId && p.detourCandidateId === candidateId);
  if (!plan) throw new Error(`Unknown detour plan ${eventId} / ${candidateId}`);
  return plan;
};
// the ids of a detour geometry that can be picked, per kind (source facts and the player's own drawings together)
export const offered = (detour, kind) => (kind === "leg" ? (detour?.legs ?? []).map((l) => l.legId)
  : kind === "connection" ? [...(detour?.connections ?? []).map((c) => c.connectionId), ...(detour?.playerConnections ?? []).map((c) => c.playerConnectionId)]
    : kind === "transfer" ? [...(detour?.transferLinks ?? []).map((t) => t.transferLinkId), ...(detour?.playerTransferPaths ?? []).map((t) => t.transferPathId)] : []);

// Starts the plan of a chosen detour. The candidate must be one the control geometry offers; an existing plan is kept.
export function addPlan(doc, eventId, candidateId, control) {
  if (!eventId || !candidateId) throw new Error("A detour plan needs an event id and a detour candidate id");
  if (!(control?.detourCandidates ?? []).some((c) => c.candidateId === candidateId)) throw new Error(`Unknown detour candidate ${candidateId}`);
  const existing = doc.plans.find((p) => p.eventId === eventId && p.detourCandidateId === candidateId);
  if (existing) return existing;
  const plan = { eventId, detourCandidateId: candidateId, active: true, selectedOnControlGeometryRevision: control.controlGeometryRevision, selectedOnDetourGeometryRevision: null, picked: { legIds: [], connectionIds: [], transferIds: [] }, connections: null, transferPaths: null };
  doc.plans.push(plan);
  return plan;
}

// Picks a leg, connection or transfer of the built detour geometry (never an id the map did not offer).
export function pick(doc, eventId, candidateId, kind, itemId, detour) {
  const plan = find(doc, eventId, candidateId);
  if (!PICKED[kind]) throw new Error(`Unknown pick kind ${kind}`);
  if (detour?.selectedDetourCandidateId !== candidateId) throw new Error("The detour geometry is not the one of this plan");
  if (!offered(detour, kind).includes(itemId)) throw new Error(`Unknown ${kind} ${itemId}`);
  plan.picked[PICKED[kind]] = [...new Set([...plan.picked[PICKED[kind]], itemId])].sort();
  plan.selectedOnDetourGeometryRevision = detour.detourGeometryRevision;
  return plan;
}
export function unpick(doc, eventId, candidateId, kind, itemId) {
  const plan = find(doc, eventId, candidateId);
  if (!PICKED[kind]) throw new Error(`Unknown pick kind ${kind}`);
  plan.picked[PICKED[kind]] = plan.picked[PICKED[kind]].filter((id) => id !== itemId);
  return plan;
}
// clears the picks of one kind, or of all kinds
export function clearPicks(doc, eventId, candidateId, kind = null) {
  const plan = find(doc, eventId, candidateId);
  for (const k of kind === null ? PICK_KINDS : [kind]) { if (!PICKED[k]) throw new Error(`Unknown pick kind ${k}`); plan.picked[PICKED[k]] = []; }
  return plan;
}

// The player's drawings. Each is stored as given (copied). `null` is "nothing stated" and is different from `[]`
// ("I stated that there are none"): the first entry turns null into a list, `declareNone` into [].
function upsert(kind) {
  return (doc, eventId, candidateId, item) => {
    const plan = find(doc, eventId, candidateId);
    const rest = (plan[LISTS[kind]] ?? []).filter((x) => !(item.key !== undefined && x.key === item.key));
    plan[LISTS[kind]] = [...rest, clone(item)];
    return plan;
  };
}
function remove(kind) {
  return (doc, eventId, candidateId, key) => {
    const plan = find(doc, eventId, candidateId);
    if (plan[LISTS[kind]] !== null) plan[LISTS[kind]] = plan[LISTS[kind]].filter((x) => x.key !== key);
    return plan;
  };
}
export const setConnection = upsert("connection");
export const removeConnection = remove("connection");
export const setTransferPath = upsert("transferPath");
export const removeTransferPath = remove("transferPath");
export function declareNone(doc, eventId, candidateId, kind) {
  if (!LISTS[kind]) throw new Error(`Unknown drawing kind ${kind}`);
  find(doc, eventId, candidateId)[LISTS[kind]] = [];
  return find(doc, eventId, candidateId);
}

// What the plan is now: whether the control geometry still offers the detour, whether it was chosen on an older
// revision, and which picks the current detour geometry no longer offers.
export function reconcilePlan(doc, eventId, candidateId, control, detour = null) {
  const plan = find(doc, eventId, candidateId);
  const isOffered = (control?.detourCandidates ?? []).some((c) => c.candidateId === candidateId);
  const stale = [];
  if (detour) for (const kind of PICK_KINDS) for (const id of plan.picked[PICKED[kind]]) if (!offered(detour, kind).includes(id)) stale.push({ kind, id, reason: "no-longer-offered" });
  return { offered: isOffered, outdated: isOffered && plan.selectedOnControlGeometryRevision !== control.controlGeometryRevision, stale };
}

// A plan is switched off, never deleted: it keeps its id, picks and drawings, and comes back as it was.
export function deactivatePlan(doc, eventId, candidateId) { const p = find(doc, eventId, candidateId); p.active = false; return p; }
export function restorePlan(doc, eventId, candidateId) { const p = find(doc, eventId, candidateId); p.active = true; return p; }
export const activePlans = (doc) => doc.plans.filter((p) => p.active !== false);

// The input of buildRailwayDetourService (the picks are for the management engine and the view, not for the geometry).
export const toDetourDocument = (plan) => clone({ eventId: plan.eventId, detourCandidateId: plan.detourCandidateId, selectedOnControlGeometryRevision: plan.selectedOnControlGeometryRevision, connections: plan.connections, transferPaths: plan.transferPaths, active: plan.active });
// The picks of every active plan: { [eventId]: { legIds, connectionIds, transferIds } }
export const picksOf = (doc) => Object.fromEntries(activePlans(doc).map((p) => [`${p.eventId}|${p.detourCandidateId}`, clone(p.picked)]));

export const serializeRailwayDetourDoc = (doc) => JSON.stringify({ version: doc.version, packId: doc.packId, packVersion: doc.packVersion, plans: doc.plans });

// Never applies a saved document to the wrong pack, and never hides a pack version change.
export function restoreRailwayDetourDoc(text, pack) {
  const packId = pack.manifest?.id ?? "pack";
  const packVersion = pack.manifest?.version ?? null;
  const fresh = newRailwayDetourDoc(packId, packVersion);
  if (text === null || text === undefined) return { doc: fresh, warnings: [] };
  let saved;
  try { saved = JSON.parse(text); } catch { return { doc: fresh, warnings: [{ code: "railway-detour-doc-unreadable" }] }; }
  if (saved?.version !== RAILWAY_DETOUR_DOC_VERSION || !Array.isArray(saved.plans)) return { doc: fresh, warnings: [{ code: "railway-detour-doc-version", version: saved?.version ?? null }] };
  if (saved.packId !== packId) return { doc: fresh, warnings: [{ code: "railway-detour-doc-other-pack", savedPackId: saved.packId }] };
  const warnings = saved.packVersion !== packVersion ? [{ code: "pack-version-mismatch", saved: saved.packVersion, current: packVersion }] : [];
  return { doc: { ...fresh, plans: saved.plans }, warnings };
}
