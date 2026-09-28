// The player's spatial response choices per construction event: which candidate (work area / material yard /
// road access / vehicle access / shaft) they picked to replace the affected one, or a hand-edited affected
// polygon. Pure data — no cost, delay, safety or reputation judgement; the management engine decides what a
// response is worth. Keyed by `eventId` itself (the engine's own stable id — no synthetic key is needed, since
// the event already has one), so a response survives a save and reopen as long as the event id is unchanged.
export const IMPACT_RESPONSE_DOC_VERSION = 1;

export const newImpactResponseDoc = (packId, packVersion = null) => ({ version: IMPACT_RESPONSE_DOC_VERSION, packId, packVersion, entries: [] });

const find = (doc, eventId) => doc.entries.find((e) => e.eventId === eventId) ?? null;
function entryFor(doc, eventId) {
  let e = find(doc, eventId);
  if (!e) { e = { eventId, selectedResponseCandidateId: null, customAffectedPolygon: null }; doc.entries.push(e); }
  return e;
}
export const responseFor = (doc, eventId) => find(doc, eventId);

// candidateId: null clears the choice (the event goes back to whatever it was already linked to).
export function setResponseCandidate(doc, eventId, candidateId) {
  const e = entryFor(doc, eventId);
  e.selectedResponseCandidateId = candidateId ?? null;
  return e;
}

// polygon: null clears the hand edit (the event's affected area goes back to its computed default).
export function setCustomAffectedPolygon(doc, eventId, polygon) {
  const e = entryFor(doc, eventId);
  e.customAffectedPolygon = polygon ? polygon.map((p) => [...p]) : null;
  return e;
}

// Drops an event's stored response entirely (both fields at once — there is nothing partial to keep).
export function clearResponse(doc, eventId) {
  doc.entries = doc.entries.filter((e) => e.eventId !== eventId);
}

export const serializeImpactResponseDoc = (doc) => JSON.stringify({ version: doc.version, packId: doc.packId, packVersion: doc.packVersion, entries: doc.entries });

// Never applies a saved document to the wrong pack, and never hides a pack version change.
export function restoreImpactResponseDoc(text, pack) {
  const packId = pack.manifest?.id ?? "pack";
  const packVersion = pack.manifest?.version ?? null;
  const fresh = newImpactResponseDoc(packId, packVersion);
  if (text === null || text === undefined) return { doc: fresh, warnings: [] };
  let saved;
  try { saved = JSON.parse(text); } catch { return { doc: fresh, warnings: [{ code: "impact-response-doc-unreadable" }] }; }
  if (saved?.version !== IMPACT_RESPONSE_DOC_VERSION || !Array.isArray(saved.entries)) return { doc: fresh, warnings: [{ code: "impact-response-doc-version", version: saved?.version ?? null }] };
  if (saved.packId !== packId) return { doc: fresh, warnings: [{ code: "impact-response-doc-other-pack", savedPackId: saved.packId }] };
  const warnings = saved.packVersion !== packVersion ? [{ code: "pack-version-mismatch", saved: saved.packVersion, current: packVersion }] : [];
  return { doc: { ...fresh, entries: saved.entries }, warnings };
}
