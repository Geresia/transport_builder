// Editing and saving the operational assumptions of service plans. Pure data: one entry per map service plan (keyed by its
// servicePlanId), bound to the servicePlanRevision it was written for, holding only what the player stated. Editing never
// confirms an entry against a newer plan revision: only `rebindAssumptions` does, so a plan that changed since the player last
// looked leaves its assumptions stale until they say they still hold. Nothing is defaulted: a field the player did not state is null.
import {
  STATEMENT_FIELDS, normalizeStatements, validateCapacityTrainsPerHour, validateClosureWindows, validateClosureWindowsBySectionId, validateDayType, validateDirectionMode, validateMinimumAcceptanceRatio,
  validateMinimumHeadwayMinutes, validateNotApplicable, validateTechnicalProfileId, validateTechnicalSpecification,
} from "./service-plan-assumptions.mjs";

export const ASSUMPTIONS_DOC_VERSION = 1;

export const newAssumptionsDoc = (packId, packVersion = null) => ({ version: ASSUMPTIONS_DOC_VERSION, packId, packVersion, entries: [] });

const clone = (v) => structuredClone(v);
const emptyStatements = () => Object.fromEntries(STATEMENT_FIELDS.map((f) => [f, null]));
const planKey = (plan) => {
  if (typeof plan?.servicePlanId !== "string" || !plan.servicePlanId || typeof plan?.servicePlanRevision !== "string" || !plan.servicePlanRevision) throw new Error("A service plan with a servicePlanId and a servicePlanRevision is required");
  return plan.servicePlanId;
};
const find = (doc, servicePlanId) => {
  const entry = doc.entries.find((e) => e.servicePlanId === servicePlanId);
  if (!entry) throw new Error(`No assumptions for service plan ${servicePlanId}`);
  return entry;
};
export const entryOf = (doc, servicePlanId) => doc.entries.find((e) => e.servicePlanId === servicePlanId) ?? null;

// the checks of one field (a profile id is checked against `known` only when the host gives the catalog)
const CHECK = {
  technicalProfileId: (v, known) => validateTechnicalProfileId(v, known), technicalSpecification: (v) => validateTechnicalSpecification(v), notApplicable: (v) => validateNotApplicable(v),
  capacityTrainsPerHour: (v) => validateCapacityTrainsPerHour(v), directionMode: (v) => validateDirectionMode(v), minimumHeadwayMinutes: (v) => validateMinimumHeadwayMinutes(v),
  closureWindowsBySectionId: (v) => validateClosureWindowsBySectionId(v), dayType: (v) => validateDayType(v), minimumAcceptanceRatio: (v) => validateMinimumAcceptanceRatio(v),
};

// patch: { field: value | null } — null clears the field back to "not stated". Every value is checked before anything is written.
export function setAssumptions(doc, servicePlan, patch, { knownTechnicalProfileIds = null } = {}) {
  const id = planKey(servicePlan);
  const checked = {};
  for (const [field, value] of Object.entries(patch ?? {})) {
    if (!CHECK[field]) throw new Error(`Not an assumption field: ${field}`);
    checked[field] = CHECK[field](value === undefined ? null : clone(value), knownTechnicalProfileIds);
  }
  let entry = entryOf(doc, id);
  if (!entry) { entry = { servicePlanId: id, boundServicePlanRevision: servicePlan.servicePlanRevision, statements: emptyStatements() }; doc.entries.push(entry); doc.entries.sort((a, b) => (a.servicePlanId < b.servicePlanId ? -1 : 1)); }
  Object.assign(entry.statements, checked);
  return entry;
}
export const clearAssumption = (doc, servicePlanId, field) => {
  if (!CHECK[field]) throw new Error(`Not an assumption field: ${field}`);
  find(doc, servicePlanId).statements[field] = null;
  return find(doc, servicePlanId);
};

// One section's closure windows: a list ([] = the player states there is none on this section) or null (the section is not stated).
export function setClosureWindows(doc, servicePlan, sectionId, windows) {
  const id = planKey(servicePlan);
  if (typeof sectionId !== "string" || !sectionId) throw new Error("A closure section id must be a non-empty text");
  const checked = windows === null ? null : validateClosureWindows(clone(windows));
  const entry = entryOf(doc, id) ?? setAssumptions(doc, servicePlan, {});
  const map = { ...(entry.statements.closureWindowsBySectionId ?? {}) };
  if (checked === null) delete map[sectionId]; else map[sectionId] = checked;
  entry.statements.closureWindowsBySectionId = Object.keys(map).length ? Object.fromEntries(Object.entries(map).sort(([a], [b]) => (a < b ? -1 : 1))) : null;
  return entry;
}
// "No closure on any section of this plan's route": [] for every mapped track segment. Refused when the route's track segments are not all known.
export function declareNoClosures(doc, servicePlan) {
  const ids = Array.isArray(servicePlan?.route?.sections) ? servicePlan.route.sections.map((s) => s?.trackSegmentId) : null;
  if (!ids || !ids.length || ids.some((x) => typeof x !== "string" || !x)) throw new Error("The track segments of the route are not all known: state each section's closures by hand");
  return setAssumptions(doc, servicePlan, { closureWindowsBySectionId: Object.fromEntries(ids.map((x) => [x, []])) });
}

// The player looked at the current plan again and keeps the assumptions: records its revision, changes nothing else.
export function rebindAssumptions(doc, servicePlan) {
  const entry = find(doc, planKey(servicePlan));
  entry.boundServicePlanRevision = servicePlan.servicePlanRevision;
  return entry;
}
export function removeAssumptions(doc, servicePlanId) {
  find(doc, servicePlanId);
  doc.entries = doc.entries.filter((e) => e.servicePlanId !== servicePlanId);
}

export const serializeAssumptionsDoc = (doc) => JSON.stringify({ version: doc.version, packId: doc.packId, packVersion: doc.packVersion, entries: doc.entries });

// Never applies a saved document to the wrong pack and never hides a pack version change. A refused document leaves `current` (the one being
// edited) as it is: the result then holds that same object and `rejected: true`.
export function restoreAssumptionsDoc(text, pack, { current = null } = {}) {
  const packId = pack.manifest?.id ?? "pack";
  const packVersion = pack.manifest?.version ?? null;
  const fresh = newAssumptionsDoc(packId, packVersion);
  const refuse = (code, extra = {}) => ({ doc: current ?? fresh, rejected: true, warnings: [{ code, ...extra }] });
  if (text === null || text === undefined) return { doc: current ?? fresh, rejected: false, warnings: [] };
  let saved;
  try { saved = JSON.parse(text); } catch { return refuse("service-plan-assumptions-doc-unreadable"); }
  const entryOk = (e) => e && typeof e === "object" && typeof e.servicePlanId === "string" && typeof e.boundServicePlanRevision === "string" && e.statements && typeof e.statements === "object" && !Array.isArray(e.statements);
  if (saved?.version !== ASSUMPTIONS_DOC_VERSION || !Array.isArray(saved.entries) || !saved.entries.every(entryOk)) return refuse("service-plan-assumptions-doc-version", { version: saved?.version ?? null });
  if (saved.packId !== packId) return refuse("service-plan-assumptions-doc-other-pack", { savedPackId: saved.packId ?? null });
  const warnings = saved.packVersion !== packVersion ? [{ code: "pack-version-mismatch", saved: saved.packVersion ?? null, current: packVersion }] : [];
  // a saved statement set is read through the same checks; an entry that no longer passes is kept as it is and reported by the builder (never repaired)
  const entries = saved.entries.map((e) => { try { return { ...e, statements: { ...emptyStatements(), ...normalizeStatements(e.statements) } }; } catch { return e; } });
  return { doc: { ...fresh, entries }, rejected: false, warnings };
}
