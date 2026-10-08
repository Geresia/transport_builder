// Service plan operational assumptions (B16-M4): what the PLAYER states about the track and the technical specification before a map
// service plan goes to the B13 timetable assessment — track count, the minimum headway of the track, closure windows, the day
// type, the minimum acceptance ratio and the technical profile / specification of the line. Nothing here is derived: a value is
// either stated by the player (and says so: `basis: "player-stated-assumption"`) or it is unknown (`null`, with a reason). No
// default is ever filled in. The module does not compute capacity from headway or headway from capacity, does not judge whether
// a plan can run, and does not build a timetable, a cost, a demand or a fare: B13 / E1 do that with what is handed over.
//
// Null / [] rules (the whole module): `null` = not stated (unknown); `[]` = the player states "none" (no closure, nothing not
// applicable); `0` = a stated zero (only a minimum acceptance ratio of 0 is a legal zero); `false` is never a value here.
import { stableId } from "./map/ids.mjs";

export const ASSUMPTIONS_SCHEMA = "transitline.service-plan-operational-assumptions/1";
export const ASSUMPTIONS_EXPORT_SCHEMA = "transitline.service-plan-operational-assumptions-export/1";
export const ASSUMPTION_BASIS = "player-stated-assumption";
export const DIRECTION_MODES = Object.freeze(["single", "double"]);
// kept equal to RAILWAY_TIMETABLE_DAY_TYPES of management/railway-timetable.mjs by a test (this module does not import management)
export const DAY_TYPES = Object.freeze(["weekday", "weekend", "holiday"]);
export const NOT_APPLICABLE_FIELDS = Object.freeze(["gaugeMm"]);
export const MINUTES_PER_DAY = 1440;
export const MAX_MINIMUM_HEADWAY_MINUTES = 1440;
// the fields of an explicit technical specification and what each must be (the same fields assessTechnicalCompatibility reads)
const TEXT_FIELDS = Object.freeze(["runningSystemId", "collectionSystemId", "currentSystem", "doorLayoutId", "maintenanceSystemId"]);
const NUMBER_FIELDS = Object.freeze(["gaugeMm", "carWidthM", "maxAxleLoadTonnes", "voltageV", "minimumCurveRadiusMeters", "maxGradientPermille", "platformHeightMm"]);
const COUNT_FIELDS = Object.freeze(["minCars", "maxCars"]);
const LIST_FIELDS = Object.freeze(["signalSystemIds"]);
export const SPECIFICATION_FIELDS = Object.freeze([...TEXT_FIELDS, ...NUMBER_FIELDS, ...COUNT_FIELDS, ...LIST_FIELDS]);
export const STATEMENT_FIELDS = Object.freeze(["technicalProfileId", "technicalSpecification", "notApplicable", "capacityTrainsPerHour", "directionMode", "minimumHeadwayMinutes", "closureWindowsBySectionId", "dayType", "minimumAcceptanceRatio"]);

const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const clone = (v) => structuredClone(v);
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const text = (v) => (typeof v === "string" && v.trim() !== "" ? v : null);
const finitePositive = (v) => typeof v === "number" && Number.isFinite(v) && v > 0;
const sortedObject = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => byText(a, b)));
const bad = (message) => { throw new Error(message); };

// --- validation: each returns the normalised value or throws; null always means "not stated" and is passed through ---
export function validateTechnicalProfileId(value, known = null) {
  if (value === null) return null;
  const id = text(value) ?? bad("A technical profile id must be a non-empty text");
  if (Array.isArray(known) && !known.includes(id)) bad(`Unknown technical profile ${id}`);
  return id;
}
export function validateTechnicalSpecification(value) {
  if (value === null) return null;
  if (!isObject(value)) bad("A technical specification must be an object (or null for not stated)");
  const out = {};
  for (const [field, v] of Object.entries(value)) {
    if (!SPECIFICATION_FIELDS.includes(field)) bad(`Unknown technical specification field ${field}`);
    if (TEXT_FIELDS.includes(field)) out[field] = text(v) ?? bad(`${field} must be a non-empty text`);
    else if (NUMBER_FIELDS.includes(field)) out[field] = finitePositive(v) ? v : bad(`${field} must be a positive number`);
    else if (COUNT_FIELDS.includes(field)) out[field] = Number.isInteger(v) && v > 0 ? v : bad(`${field} must be a positive whole number`);
    else if (!Array.isArray(v) || !v.length || v.some((s) => text(s) === null)) bad(`${field} must be a non-empty list of texts`);
    else out[field] = [...new Set(v)].sort(byText);
  }
  if (out.minCars !== undefined && out.maxCars !== undefined && out.minCars > out.maxCars) bad("minCars must not exceed maxCars");
  return sortedObject(out);
}
export function validateNotApplicable(value) {
  if (value === null) return null;
  if (!Array.isArray(value) || value.some((f) => !NOT_APPLICABLE_FIELDS.includes(f))) bad(`notApplicable may only list ${NOT_APPLICABLE_FIELDS.join(", ")}`);
  return [...new Set(value)].sort(byText);
}
export const validateCapacityTrainsPerHour = (value) => (value === null ? null : Number.isInteger(value) && value > 0 ? value : bad("capacityTrainsPerHour must be a positive whole number"));
export const validateDirectionMode = (value) => (value === null ? null : DIRECTION_MODES.includes(value) ? value : bad(`directionMode must be one of ${DIRECTION_MODES.join(", ")}`));
export const validateMinimumHeadwayMinutes = (value) => (value === null ? null : finitePositive(value) && value <= MAX_MINIMUM_HEADWAY_MINUTES ? value : bad(`minimumHeadwayMinutes must be a number above 0 and at most ${MAX_MINIMUM_HEADWAY_MINUTES}`));
export const validateDayType = (value) => (value === null ? null : DAY_TYPES.includes(value) ? value : bad(`dayType must be one of ${DAY_TYPES.join(", ")}`));
export const validateMinimumAcceptanceRatio = (value) => (value === null ? null : typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : bad("minimumAcceptanceRatio must be a number from 0 to 1"));

// one section's windows: [] = the player states there is none; whole-minute windows inside one day that do not overlap (touching is fine)
export function validateClosureWindows(windows) {
  if (!Array.isArray(windows)) bad("The closure windows of a section must be a list ([] states there is none)");
  const out = windows.map((w) => {
    if (!isObject(w)) bad("A closure window must be an object");
    const { startMinute, endMinute, reason } = w;
    if (!Number.isInteger(startMinute) || startMinute < 0 || startMinute >= MINUTES_PER_DAY) bad("A closure window starts at a whole minute from 0 to 1439");
    if (!Number.isInteger(endMinute) || endMinute <= startMinute || endMinute > MINUTES_PER_DAY) bad("A closure window ends at a whole minute after its start and at most 1440");
    if (reason !== undefined && reason !== null && text(reason) === null) bad("A closure reason must be a non-empty text");
    return { startMinute, endMinute, ...(text(reason) ? { reason } : {}) };
  }).sort((a, b) => a.startMinute - b.startMinute || a.endMinute - b.endMinute);
  for (let i = 1; i < out.length; i++) if (out[i].startMinute < out[i - 1].endMinute) bad("Closure windows of one section must not overlap");
  return out;
}
export function validateClosureWindowsBySectionId(value) {
  if (value === null) return null;
  if (!isObject(value)) bad("closureWindowsBySectionId must be an object (or null for not stated)");
  return sortedObject(Object.fromEntries(Object.entries(value).map(([sectionId, windows]) => [text(sectionId) ?? bad("A closure section id must be a non-empty text"), validateClosureWindows(windows)])));
}

// The whole statement set, every field checked; a missing field is "not stated" (null).
export function normalizeStatements(input = {}, { knownTechnicalProfileIds = null } = {}) {
  const get = (f) => (input[f] === undefined ? null : input[f]);
  return {
    technicalProfileId: validateTechnicalProfileId(get("technicalProfileId"), knownTechnicalProfileIds),
    technicalSpecification: validateTechnicalSpecification(get("technicalSpecification")),
    notApplicable: validateNotApplicable(get("notApplicable")),
    capacityTrainsPerHour: validateCapacityTrainsPerHour(get("capacityTrainsPerHour")),
    directionMode: validateDirectionMode(get("directionMode")),
    minimumHeadwayMinutes: validateMinimumHeadwayMinutes(get("minimumHeadwayMinutes")),
    closureWindowsBySectionId: validateClosureWindowsBySectionId(get("closureWindowsBySectionId")),
    dayType: validateDayType(get("dayType")),
    minimumAcceptanceRatio: validateMinimumAcceptanceRatio(get("minimumAcceptanceRatio")),
  };
}

export const assumptionSetIdOf = (packId, servicePlanId) => stableId("service-plan-assumptions", packId, servicePlanId);

const REASON = Object.freeze({
  technicalProfileId: "technical-profile-not-stated", technicalSpecification: "technical-specification-not-stated", notApplicable: "not-applicable-not-stated", capacityTrainsPerHour: "capacity-not-stated",
  directionMode: "direction-mode-not-stated", minimumHeadwayMinutes: "minimum-headway-not-stated", closureWindowsBySectionId: "closure-windows-not-stated", dayType: "day-type-not-stated", minimumAcceptanceRatio: "minimum-acceptance-ratio-not-stated",
});
// what B13 / the runtime do with an input that is left out: stated here so nobody mistakes them for the player's statement
export const DOWNSTREAM_DEFAULTS = Object.freeze({ dayType: "weekday-by-the-runtime", minimumAcceptanceRatio: "1-by-the-runtime", closureWindowsBySectionId: "no-closures-by-the-timetable-assessment" });

// entry: a stored entry { servicePlanId, boundServicePlanRevision, statements }; servicePlans: map service plans (transitline.service-plan-geometry/1 objects)
// -> one built assumption set. The set is `usable` only while its plan is still the revision it was written for.
export function buildAssumptionSet(entry, { pack, servicePlans = [], knownTechnicalProfileIds = null }) {
  const packId = pack.manifest?.id ?? "pack";
  const plan = servicePlans.find((p) => p?.servicePlanId === entry.servicePlanId) ?? null;
  const warnings = [];
  const state = !plan ? "plan-missing" : plan.servicePlanRevision === entry.boundServicePlanRevision ? "current" : "stale";
  if (state !== "current") warnings.push({ code: state === "stale" ? "service-plan-revision-changed" : "service-plan-missing", servicePlanId: entry.servicePlanId, boundServicePlanRevision: entry.boundServicePlanRevision, currentServicePlanRevision: plan?.servicePlanRevision ?? null });
  let statements;
  try { statements = normalizeStatements(entry.statements, { knownTechnicalProfileIds }); } catch (error) { statements = null; warnings.push({ code: "statements-invalid", message: String(error.message) }); }
  const s = statements ?? normalizeStatements({});
  const lineId = text(plan?.operationalLineId) ?? null;
  const stated = STATEMENT_FIELDS.filter((f) => s[f] !== null);
  const unknownReasons = Object.fromEntries(STATEMENT_FIELDS.filter((f) => s[f] === null).map((f) => [f, REASON[f]]));
  const technicalStated = ["technicalProfileId", "technicalSpecification", "notApplicable", "capacityTrainsPerHour"].filter((f) => s[f] !== null);
  if (technicalStated.length && lineId === null) warnings.push({ code: "operational-line-not-stated", fields: technicalStated });
  // closure sections the player has not addressed (B13 would read them as "no closure" — that is not a statement)
  const routeSections = Array.isArray(plan?.route?.sections) ? plan.route.sections.map((x) => (typeof x?.trackSegmentId === "string" ? x.trackSegmentId : null)) : null;
  const closureSectionsNotStated = routeSections === null || routeSections.includes(null) ? null : routeSections.filter((id) => !s.closureWindowsBySectionId || !(id in s.closureWindowsBySectionId)).sort(byText);
  if (s.closureWindowsBySectionId && routeSections && !routeSections.includes(null)) {
    const outside = Object.keys(s.closureWindowsBySectionId).filter((id) => !routeSections.includes(id));
    if (outside.length) warnings.push({ code: "closure-section-not-on-route", sectionIds: outside });
  }
  const usable = state === "current" && statements !== null;
  let assessInput = null;
  if (usable) {
    assessInput = {};
    const spec = {};
    if (s.technicalProfileId !== null) spec.technicalProfileId = s.technicalProfileId;
    if (s.technicalSpecification !== null) spec.technicalSpecification = clone(s.technicalSpecification);
    if (s.notApplicable !== null) spec.notApplicable = clone(s.notApplicable);
    if (s.capacityTrainsPerHour !== null) spec.capacityTrainsPerHour = s.capacityTrainsPerHour;
    assessInput.technicalSpecs = lineId !== null && Object.keys(spec).length ? { [lineId]: spec } : {};
    const infra = {};
    if (s.directionMode !== null) infra.directionMode = s.directionMode;
    if (s.minimumHeadwayMinutes !== null) infra.minimumHeadwayMinutes = s.minimumHeadwayMinutes;
    assessInput.infrastructureAssumptions = Object.keys(infra).length ? infra : null;
    if (s.closureWindowsBySectionId !== null) assessInput.closureWindowsBySectionId = clone(s.closureWindowsBySectionId);
    if (s.dayType !== null) assessInput.dayType = s.dayType;
    if (s.minimumAcceptanceRatio !== null) assessInput.minimumAcceptanceRatio = s.minimumAcceptanceRatio;
  }
  const defaultsApply = STATEMENT_FIELDS.filter((f) => DOWNSTREAM_DEFAULTS[f] && s[f] === null).map((f) => ({ field: f, downstream: DOWNSTREAM_DEFAULTS[f] }));
  const assumptionSetId = assumptionSetIdOf(packId, entry.servicePlanId);
  const body = {
    schema: ASSUMPTIONS_SCHEMA, contractVersion: 1, assumptionSetId, sourcePackId: packId, sourcePackVersion: pack.manifest?.version ?? null,
    servicePlanId: entry.servicePlanId, boundServicePlanRevision: entry.boundServicePlanRevision, currentServicePlanRevision: plan?.servicePlanRevision ?? null, operationalLineId: lineId,
    state, usable, basis: ASSUMPTION_BASIS, statements: s, statedFields: stated, unknown: Object.keys(unknownReasons).sort(byText), unknownReasons: sortedObject(unknownReasons),
    closureSectionsNotStated, defaultsApplyDownstream: defaultsApply, assessInput,
  };
  return { ...body, assumptionSetRevision: stableId("service-plan-assumptions-revision", assumptionSetId, JSON.stringify(body)), warnings };
}

// doc: { packId, packVersion, entries }, servicePlans: the map service plans (export.plans of the service plan editor)
export function buildAssumptionExport({ pack, doc, servicePlans = [], knownTechnicalProfileIds = null }) {
  const packId = pack.manifest?.id ?? "pack";
  const built = (doc?.entries ?? []).filter((e) => !e.deleted).map((e) => buildAssumptionSet(e, { pack, servicePlans, knownTechnicalProfileIds })).sort((a, b) => byText(a.assumptionSetId, b.assumptionSetId));
  return { schema: ASSUMPTIONS_EXPORT_SCHEMA, packId, packVersion: pack.manifest?.version ?? null, basis: ASSUMPTION_BASIS, sets: built, technical: technicalSpecsOf(built) };
}

// The technicalSpecs of every usable set, keyed by operational line, for getPrescreenContext().technicalSpecs. Two plans of one line that state
// different specifications conflict: that line is left out (and listed), never resolved by guessing which one is right.
export function technicalSpecsOf(sets) {
  const perLine = new Map();
  for (const set of sets) {
    if (!set.usable || !set.assessInput) continue;
    for (const [lineId, spec] of Object.entries(set.assessInput.technicalSpecs)) perLine.set(lineId, [...(perLine.get(lineId) ?? []), { assumptionSetId: set.assumptionSetId, spec }]);
  }
  const technicalSpecs = {};
  const conflicts = [];
  for (const [lineId, list] of [...perLine.entries()].sort(([a], [b]) => byText(a, b))) {
    if (list.every((x) => JSON.stringify(x.spec) === JSON.stringify(list[0].spec))) technicalSpecs[lineId] = clone(list[0].spec);
    else conflicts.push({ operationalLineId: lineId, assumptionSetIds: list.map((x) => x.assumptionSetId).sort(byText) });
  }
  return { technicalSpecs, conflicts };
}

// The `input` of ScenarioRuntime.assessServicePlanTimetable(servicePlan, binding, input) for one plan, or null when its set is missing / stale.
// Only what the player stated is in it: a field left out is left out (the runtime's own handling applies, see `defaultsApplyDownstream`).
export function assessmentInputFor(exportData, servicePlanId) {
  const set = (exportData?.sets ?? []).find((x) => x.servicePlanId === servicePlanId);
  return set?.usable ? clone(set.assessInput) : null;
}
