// Pure editor document for B20-M1. Persistence belongs to the host; this file
// has no browser storage and never allocates a key that was used by a tombstone.

export const REGIONAL_DEVELOPMENT_PROGRAM_DOC_VERSION = 1;
const clone = (value) => structuredClone(value);
const active = (doc) => doc.programs.filter((program) => !program.deleted);
const programOf = (doc, key) => {
  const program = doc.programs.find((entry) => entry.key === key && !entry.deleted);
  if (!program) throw new Error(`Unknown program ${key}`);
  return program;
};
const milestoneOf = (doc, key, milestoneKey) => {
  const program = programOf(doc, key);
  const milestone = program.milestones.find((entry) => entry.key === milestoneKey && !entry.deleted);
  if (!milestone) throw new Error(`Unknown milestone ${milestoneKey}`);
  return { program, milestone };
};
const keyFor = (items, prefix) => { let n = 1; while (items.some((item) => item.key === `${prefix}-${n}`)) n++; return `${prefix}-${n}`; };
const list = (value, field) => {
  if (value === null) return null;
  if (!Array.isArray(value)) throw new Error(`${field} must be null or an array`);
  return clone(value);
};

export const newRegionalDevelopmentProgramDoc = (packId, packVersion = null) => ({ version: REGIONAL_DEVELOPMENT_PROGRAM_DOC_VERSION, packId, packVersion, programs: [] });
export const activeRegionalDevelopmentPrograms = active;

export function addRegionalDevelopmentProgram(doc, { key, name = null } = {}) {
  const actualKey = key === undefined || key === null || key === "" ? keyFor(doc.programs, "program") : String(key);
  if (doc.programs.some((entry) => entry.key === actualKey)) throw new Error(`Program key ${actualKey} is already used`);
  const program = { key: actualKey, name, active: true, deleted: false, milestones: [], linkedDevelopmentIds: null, linkedPlanIds: null, linkedStationSiteIds: null, linkedServicePlanIds: null, playerStatedPolicy: null, playerStatedPriority: null };
  doc.programs.push(program); return program;
}
export function updateRegionalDevelopmentProgram(doc, key, patch = {}) {
  const program = programOf(doc, key);
  for (const field of ["name", "playerStatedPolicy", "playerStatedPriority"]) if (patch[field] !== undefined) program[field] = patch[field] === null ? null : clone(patch[field]);
  for (const field of ["linkedDevelopmentIds", "linkedPlanIds", "linkedStationSiteIds", "linkedServicePlanIds"]) if (patch[field] !== undefined) program[field] = list(patch[field], field);
  return program;
}
export const deactivateRegionalDevelopmentProgram = (doc, key) => { const program = programOf(doc, key); program.active = false; return program; };
export const restoreRegionalDevelopmentProgram = (doc, key) => { const program = programOf(doc, key); program.active = true; return program; };
export const removeRegionalDevelopmentProgram = (doc, key) => { const program = programOf(doc, key); program.deleted = true; program.active = false; return program; };

export function addRegionalDevelopmentMilestone(doc, key, value = {}) {
  const program = programOf(doc, key);
  const milestoneKey = value.key === undefined || value.key === null || value.key === "" ? keyFor(program.milestones, "milestone") : String(value.key);
  if (program.milestones.some((entry) => entry.key === milestoneKey)) throw new Error(`Milestone key ${milestoneKey} is already used`);
  const milestone = { key: milestoneKey, name: value.name ?? null, sequence: program.milestones.filter((entry) => !entry.deleted).length + 1, targetMonth: value.targetMonth ?? null, durationMonths: value.durationMonths ?? null, linkedDevelopmentIds: list(value.linkedDevelopmentIds ?? null, "linkedDevelopmentIds"), linkedPlanIds: list(value.linkedPlanIds ?? null, "linkedPlanIds"), linkedStationSiteIds: list(value.linkedStationSiteIds ?? null, "linkedStationSiteIds"), linkedServicePlanIds: list(value.linkedServicePlanIds ?? null, "linkedServicePlanIds"), deleted: false };
  program.milestones.push(milestone); return milestone;
}
export function updateRegionalDevelopmentMilestone(doc, key, milestoneKey, patch = {}) {
  const { milestone } = milestoneOf(doc, key, milestoneKey);
  for (const field of ["name", "targetMonth", "durationMonths"]) if (patch[field] !== undefined) milestone[field] = patch[field] === null ? null : clone(patch[field]);
  for (const field of ["linkedDevelopmentIds", "linkedPlanIds", "linkedStationSiteIds", "linkedServicePlanIds"]) if (patch[field] !== undefined) milestone[field] = list(patch[field], field);
  return milestone;
}
export function reorderRegionalDevelopmentMilestone(doc, key, milestoneKey, toIndex) {
  const { program, milestone } = milestoneOf(doc, key, milestoneKey);
  const live = program.milestones.filter((entry) => !entry.deleted);
  if (!Number.isInteger(toIndex) || toIndex < 0 || toIndex >= live.length) throw new Error("Milestone position is invalid");
  const from = live.indexOf(milestone); live.splice(from, 1); live.splice(toIndex, 0, milestone); live.forEach((entry, index) => { entry.sequence = index + 1; }); return milestone;
}
export const removeRegionalDevelopmentMilestone = (doc, key, milestoneKey) => { const { milestone } = milestoneOf(doc, key, milestoneKey); milestone.deleted = true; return milestone; };

export function drawnRegionalDevelopmentProgramsOf(doc) {
  return active(doc).map((program) => ({ ...clone(program), milestones: program.milestones.filter((milestone) => !milestone.deleted).map(clone) }));
}
export const serializeRegionalDevelopmentProgramDoc = (doc) => JSON.stringify(doc);
export function restoreRegionalDevelopmentProgramDoc(text, pack, { current = null } = {}) {
  try {
    const parsed = JSON.parse(text);
    if (!parsed || parsed.version !== REGIONAL_DEVELOPMENT_PROGRAM_DOC_VERSION || !Array.isArray(parsed.programs)) return { document: current, rejected: "program-document-invalid", warnings: [] };
    const packId = pack?.manifest?.id ?? pack?.id;
    if (parsed.packId !== packId) return { document: current, rejected: "program-document-other-pack", warnings: [] };
    return { document: clone(parsed), rejected: null, warnings: parsed.packVersion !== (pack?.manifest?.version ?? pack?.version ?? null) ? ["program-document-pack-version-changed"] : [] };
  } catch { return { document: current, rejected: "program-document-unreadable", warnings: [] }; }
}
