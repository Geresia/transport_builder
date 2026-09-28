// The player's work-front choices: which shaft/work-area candidate on a construction site is being used as a
// work front, which access candidate serves as its equipment entry point, and any hand-drawn assembly/storage
// polygons. Pure data — no cost, duration, bid or contractor judgement; the management engine decides those.
// A site may hold several work fronts at once (one per candidate); each entry doubles as the `drawn` input
// buildConstructionWorkfront() expects, since workfrontId is derived the same deterministic way in both places.
import { workfrontIdFor } from "./construction-workfront.mjs";

export const WORKFRONT_DOC_VERSION = 1;
export const newWorkfrontDoc = (packId, packVersion = null) => ({ version: WORKFRONT_DOC_VERSION, packId, packVersion, entries: [] });

const find = (doc, workfrontId) => doc.entries.find((e) => e.workfrontId === workfrontId) ?? null;
export const workfrontFor = (doc, workfrontId) => find(doc, workfrontId);
export const workfrontsForSite = (doc, constructionSiteId) => doc.entries.filter((e) => e.constructionSiteId === constructionSiteId);

// Adding the same (constructionSiteId, candidateRef) twice is a no-op — the id is deterministic, so it returns
// the existing entry rather than creating a duplicate.
export function addWorkfront(doc, { constructionSiteId, candidateRef }) {
  const workfrontId = workfrontIdFor(constructionSiteId, candidateRef);
  const existing = find(doc, workfrontId);
  if (existing) return existing;
  const entry = { workfrontId, constructionSiteId, candidateRef, accessCandidateRef: null, assemblyPolygon: null, storagePolygon: null };
  doc.entries.push(entry);
  return entry;
}
export function removeWorkfront(doc, workfrontId) {
  doc.entries = doc.entries.filter((e) => e.workfrontId !== workfrontId);
}
// candidateRef: null clears the choice (falls back to the nearest access candidate on the site).
export function setAccessCandidate(doc, workfrontId, candidateRef) {
  const e = find(doc, workfrontId);
  if (!e) return null;
  e.accessCandidateRef = candidateRef ?? null;
  return e;
}
export function setAssemblyPolygon(doc, workfrontId, polygon) {
  const e = find(doc, workfrontId);
  if (!e) return null;
  e.assemblyPolygon = polygon ? polygon.map((p) => [...p]) : null;
  return e;
}
export function setStoragePolygon(doc, workfrontId, polygon) {
  const e = find(doc, workfrontId);
  if (!e) return null;
  e.storagePolygon = polygon ? polygon.map((p) => [...p]) : null;
  return e;
}

export const serializeWorkfrontDoc = (doc) => JSON.stringify({ version: doc.version, packId: doc.packId, packVersion: doc.packVersion, entries: doc.entries });

// Never applies a saved document to the wrong pack, and never hides a pack version change.
export function restoreWorkfrontDoc(text, pack) {
  const packId = pack.manifest?.id ?? "pack";
  const packVersion = pack.manifest?.version ?? null;
  const fresh = newWorkfrontDoc(packId, packVersion);
  if (text === null || text === undefined) return { doc: fresh, warnings: [] };
  let saved;
  try { saved = JSON.parse(text); } catch { return { doc: fresh, warnings: [{ code: "workfront-doc-unreadable" }] }; }
  if (saved?.version !== WORKFRONT_DOC_VERSION || !Array.isArray(saved.entries)) return { doc: fresh, warnings: [{ code: "workfront-doc-version", version: saved?.version ?? null }] };
  if (saved.packId !== packId) return { doc: fresh, warnings: [{ code: "workfront-doc-other-pack", savedPackId: saved.packId }] };
  const warnings = saved.packVersion !== packVersion ? [{ code: "pack-version-mismatch", saved: saved.packVersion, current: packVersion }] : [];
  return { doc: { ...fresh, entries: saved.entries }, warnings };
}
