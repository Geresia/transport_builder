// B20-M1.  A regional development program is a map-owned statement of what the
// player wants to coordinate.  It deliberately does not turn a link into a
// feasibility verdict, a demand forecast, a cost, or a command to another
// subsystem.  Management records get their own ids in B20-E1.

import { stableId } from "./ids.mjs";

export const REGIONAL_DEVELOPMENT_PROGRAM_SCHEMA = "transitline.regional-development-program/1";
export const REGIONAL_DEVELOPMENT_PROGRAM_EXPORT_SCHEMA = "transitline.regional-development-program-export/1";

const text = (value) => typeof value === "string" && value.trim() ? value.trim() : null;
const clone = (value) => structuredClone(value);
const compare = (a, b) => String(a).localeCompare(String(b));
const uniqueTextList = (value, field, warnings) => {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) { warnings.push({ code: "link-list-invalid", field }); return null; }
  const valid = value.map(text).filter(Boolean);
  if (valid.length !== value.length) warnings.push({ code: "link-id-invalid", field });
  return [...new Set(valid)].sort(compare);
};
const declaredText = (value, field, warnings) => {
  if (value === null || value === undefined) return null;
  const result = text(value);
  if (!result || result.length > 500) { warnings.push({ code: "player-statement-invalid", field }); return null; }
  return result;
};
// Map files may only depend on map-local code.  The campaign-time module has
// the same scalar rule for runtime display, but M1 validates this player
// statement locally instead of depending on a parent engine module.
const campaignMonth = (value) => {
  if (value === null || value === undefined) return null;
  if (!Number.isInteger(value) || value < 0) throw new Error("campaign month must be a non-negative integer or null");
  return value;
};
const number = (value, field, warnings, normalizer) => {
  try { return normalizer(value); }
  catch { warnings.push({ code: "campaign-month-invalid", field }); return null; }
};
const idOf = (item, names) => names.map((name) => item?.[name]).find((value) => text(value)) ?? null;
const revisionOf = (item) => idOf(item, ["developmentRevision", "planRevision", "stationSiteRevision", "servicePlanRevision", "revision"]);
const activeOf = (item) => item?.active !== false;

export const regionalDevelopmentProgramId = (packId, key) => stableId("regional-development-program", String(packId), String(key));
export const regionalDevelopmentMilestoneId = (programId, key) => stableId("regional-development-milestone", programId, String(key));

function referenceIndex(values, names) {
  if (!Array.isArray(values)) return null;
  const map = new Map();
  for (const value of values) {
    const id = idOf(value, names);
    if (id && !map.has(id)) map.set(id, value);
  }
  return map;
}

function statusFor({ id, index, sourcePackId, expectedPackId }) {
  if (index === null) return { found: null, geometryStatus: "missing", referencedRevision: null };
  const item = index.get(id);
  if (!item) return { found: false, geometryStatus: "missing", referencedRevision: null };
  const itemPack = text(item.sourcePackId ?? item.packId);
  if (itemPack && expectedPackId && itemPack !== expectedPackId) return { found: true, geometryStatus: "other-pack", referencedRevision: revisionOf(item) };
  if (!activeOf(item)) return { found: true, geometryStatus: "inactive", referencedRevision: revisionOf(item) };
  return { found: true, geometryStatus: "current", referencedRevision: revisionOf(item) };
}

function milestonesOf(drawn, programId, warnings) {
  if (drawn?.milestones === null || drawn?.milestones === undefined) return null;
  if (!Array.isArray(drawn.milestones)) { warnings.push({ code: "milestones-invalid" }); return null; }
  const seen = new Set();
  const values = [];
  drawn.milestones.forEach((raw, index) => {
    const key = text(raw?.key);
    if (!key || seen.has(key)) { warnings.push({ code: !key ? "milestone-key-missing" : "milestone-key-duplicate", index, key }); return; }
    seen.add(key);
    const localWarnings = [];
    const targetMonth = number(raw.targetMonth, "targetMonth", localWarnings, campaignMonth);
    const durationMonths = number(raw.durationMonths, "durationMonths", localWarnings, campaignMonth);
    const sequence = Number.isInteger(raw.sequence) && raw.sequence >= 1 ? raw.sequence : index + 1;
    if (!Number.isInteger(raw.sequence) && raw.sequence !== null && raw.sequence !== undefined) localWarnings.push({ code: "milestone-sequence-invalid" });
    values.push({
      milestoneId: regionalDevelopmentMilestoneId(programId, key), key, sequence,
      name: text(raw.name), targetMonth, durationMonths,
      linkedDevelopmentIds: uniqueTextList(raw.linkedDevelopmentIds, "linkedDevelopmentIds", localWarnings),
      linkedPlanIds: uniqueTextList(raw.linkedPlanIds, "linkedPlanIds", localWarnings),
      linkedStationSiteIds: uniqueTextList(raw.linkedStationSiteIds, "linkedStationSiteIds", localWarnings),
      linkedServicePlanIds: uniqueTextList(raw.linkedServicePlanIds, "linkedServicePlanIds", localWarnings),
      warnings: localWarnings.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    });
  });
  return values.sort((a, b) => a.sequence - b.sequence || compare(a.key, b.key)).map((value, index) => ({ ...value, sequence: index + 1 }));
}

function factsFor({ program, milestones, expectedPackId, developmentIndex, planIndex, stationIndex, servicePlanIndex }) {
  const facts = [];
  const add = (refKind, refId, milestoneId, index) => {
    const status = statusFor({ id: refId, index, expectedPackId });
    facts.push({ refKind, refId, milestoneId, ...status });
  };
  const lists = [
    ["development", "linkedDevelopmentIds", developmentIndex], ["plan", "linkedPlanIds", planIndex],
    ["station-site", "linkedStationSiteIds", stationIndex], ["service-plan", "linkedServicePlanIds", servicePlanIndex],
  ];
  const visit = (holder, milestoneId) => lists.forEach(([kind, field, index]) => (holder[field] ?? []).forEach((refId) => add(kind, refId, milestoneId, index)));
  visit(program, null);
  (milestones ?? []).forEach((milestone) => visit(milestone, milestone.milestoneId));
  const seen = new Set();
  return facts.filter((fact) => {
    const key = [fact.refKind, fact.refId, fact.milestoneId ?? ""].join("|");
    if (seen.has(key)) return false;
    seen.add(key); return true;
  }).sort((a, b) => compare(a.refKind, b.refKind) || compare(a.refId, b.refId) || compare(a.milestoneId ?? "", b.milestoneId ?? ""));
}

// drawn is an editor document element. ctx accepts the B19 export and other
// optional map exports; omitting a collection is deliberately reported as
// unknown, not as an empty collection of existing objects.
export function buildRegionalDevelopmentProgram(drawn, ctx = {}) {
  const key = text(drawn?.key);
  const pack = ctx.pack ?? {};
  const packId = text(pack.manifest?.id) ?? text(ctx.packId) ?? "pack";
  if (!key) return null;
  const warnings = [];
  const programId = regionalDevelopmentProgramId(packId, key);
  const program = {
    schema: REGIONAL_DEVELOPMENT_PROGRAM_SCHEMA, contractVersion: 1,
    programId, sourcePackId: packId, sourcePackVersion: pack.manifest?.version ?? ctx.packVersion ?? null,
    key, name: text(drawn.name), active: drawn.active !== false,
    linkedDevelopmentIds: uniqueTextList(drawn.linkedDevelopmentIds, "linkedDevelopmentIds", warnings),
    linkedPlanIds: uniqueTextList(drawn.linkedPlanIds, "linkedPlanIds", warnings),
    linkedStationSiteIds: uniqueTextList(drawn.linkedStationSiteIds, "linkedStationSiteIds", warnings),
    linkedServicePlanIds: uniqueTextList(drawn.linkedServicePlanIds, "linkedServicePlanIds", warnings),
    playerStatedPolicy: declaredText(drawn.playerStatedPolicy, "playerStatedPolicy", warnings),
    playerStatedPriority: (() => {
      if (drawn.playerStatedPriority === null || drawn.playerStatedPriority === undefined) return null;
      if (!Number.isInteger(drawn.playerStatedPriority) || drawn.playerStatedPriority < 1) { warnings.push({ code: "priority-invalid" }); return null; }
      return drawn.playerStatedPriority;
    })(),
  };
  const milestones = milestonesOf(drawn, programId, warnings);
  const developmentIndex = referenceIndex(ctx.newTownDevelopmentExport?.developments, ["developmentId"]);
  const planIndex = referenceIndex(ctx.mapExport?.plans ?? ctx.plans, ["planId", "id"]);
  const stationIndex = referenceIndex(ctx.stationSites, ["stationSiteId", "id"]);
  const servicePlanIndex = referenceIndex(ctx.servicePlans, ["servicePlanId", "id"]);
  const linkFacts = factsFor({ program, milestones, expectedPackId: packId, developmentIndex, planIndex, stationIndex, servicePlanIndex });
  const unknown = [];
  const unknownReasons = {};
  for (const fact of linkFacts) if (fact.found === null) {
    const field = `linkFacts:${fact.refKind}`;
    if (!unknown.includes(field)) unknown.push(field);
    unknownReasons[field] = "reference-collection-not-provided";
  }
  if (milestones === null) { unknown.push("milestones"); unknownReasons.milestones = "not-stated"; }
  const revisionBody = { ...program, name: undefined, milestones: (milestones ?? []).map(({ name: _name, warnings: _warnings, ...rest }) => rest) };
  return {
    ...program,
    milestones, linkFacts,
    programRevision: stableId("regional-development-program-revision", programId, JSON.stringify(revisionBody)),
    unknown: [...new Set(unknown)].sort(compare), unknownReasons,
    warnings: warnings.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    license: { pack: pack.manifest?.data?.license ?? null, attribution: clone(pack.manifest?.data?.attribution ?? []) },
  };
}

export function buildRegionalDevelopmentProgramExport({ pack, programs = [], ...ctx } = {}) {
  const built = new Map();
  const warnings = [];
  for (const drawn of programs ?? []) {
    const program = buildRegionalDevelopmentProgram(drawn, { pack, ...ctx });
    if (!program) warnings.push({ code: "program-key-missing" });
    else if (built.has(program.programId)) warnings.push({ code: "program-duplicate", programId: program.programId });
    else built.set(program.programId, program);
  }
  return {
    schema: REGIONAL_DEVELOPMENT_PROGRAM_EXPORT_SCHEMA, contractVersion: 1,
    packId: pack?.manifest?.id ?? "pack", packVersion: pack?.manifest?.version ?? null,
    programs: [...built.values()].sort((a, b) => compare(a.programId, b.programId)),
    warnings: warnings.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  };
}
