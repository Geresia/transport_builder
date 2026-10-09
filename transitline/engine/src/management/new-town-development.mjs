// B19-E1: the management state and lifecycle of a new-town development.  It is separate from any railway project and can be linked to
// one: plans, station sites and service plans are kept as plain references and are not looked up.  It records WHO is party to a
// development, WHO bears which item, WHICH phase is in which state and WHAT occupancy facts the player has stated.  It computes no
// population, demand, occupancy rate, land price, cost or feasibility, draws no random number, and moves no money: converting stated
// facts into demand (B19-E2/E3) or into events (B14) is later work that reads the hooks this record keeps.
//
// The map's development geometry (`transitline.new-town-development-geometry/1`) is read-only input.  A transition that moves a
// development forward needs a CURRENT geometry handed to it; no geometry, an unusable one, an inactive one or one whose revision or
// phases differ from the record (stale) blocks it.  Unknown (null) is never turned into "fine".  Delaying and cancelling never need the
// map: the player must always be able to stop a development.
//
// development: draft -> proposed -> agreed -> servicing -> occupied;  agreed|servicing|occupied -> delayed -> (back);  anything not
// finished -> cancelled.  "occupied" means the player has recorded occupancy facts for at least one phase — not that occupancy is high.
export const NEW_TOWN_DEVELOPMENT_SCHEMA = "transitline.new-town-development/1";
export const NEW_TOWN_GEOMETRY_SCHEMA = "transitline.new-town-development-geometry/1";
export const NEW_TOWN_STATUSES = Object.freeze(["draft", "proposed", "agreed", "servicing", "occupied", "delayed", "cancelled"]);
export const NEW_TOWN_PHASE_STATUSES = Object.freeze(["planned", "servicing", "occupied", "cancelled"]);
export const NEW_TOWN_ROLES = Object.freeze(["player", "municipality", "developer"]);
export const NEW_TOWN_NOT_COMPUTED = Object.freeze(["population", "demand", "occupancy-rate", "land-price", "cost-estimate", "feasibility", "money-movement"]);

// kind -> where it can start from, and whether it needs a current map geometry
export const NEW_TOWN_TRANSITIONS = Object.freeze({
  propose: Object.freeze({ from: Object.freeze(["draft"]), geometry: true }),
  agree: Object.freeze({ from: Object.freeze(["proposed"]), geometry: true }),
  startServicing: Object.freeze({ from: Object.freeze(["agreed", "servicing", "occupied"]), geometry: true }),
  recordOccupancy: Object.freeze({ from: Object.freeze(["servicing", "occupied"]), geometry: true }),
  delay: Object.freeze({ from: Object.freeze(["agreed", "servicing", "occupied"]), geometry: false }),
  resume: Object.freeze({ from: Object.freeze(["delayed"]), geometry: true }),
  cancel: Object.freeze({ from: Object.freeze(["draft", "proposed", "agreed", "servicing", "occupied", "delayed"]), geometry: false }),
});

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value) => (typeof value === "string" && value.trim() !== "" ? value.trim() : null);
const clone = (value) => structuredClone(value);
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const nonNegativeInteger = (value) => Number.isInteger(value) && value >= 0;
const canonical = (v) => (Array.isArray(v) ? `[${v.map(canonical).join(",")}]` : isObject(v) ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}` : JSON.stringify(v ?? null));
const reasonOf = (value, label) => {
  const reason = text(value);
  if (reason === null || reason.length > 200) throw new Error(`${label} must be a non-empty text of at most 200 characters`);
  return reason;
};

// --- the map geometry: read-only, plain object --------------------------------------------------------------------------------------
function phaseProblems(phases) {
  if (phases === null || phases === undefined || !Array.isArray(phases)) return ["geometry-phases-unknown"];
  if (!phases.length) return ["geometry-has-no-phases"];
  const problems = [];
  const ids = new Set(); const sequences = new Set();
  phases.forEach((phase, index) => {
    if (!isObject(phase) || text(phase.phaseId) === null || !nonNegativeInteger(phase.sequence) || !(phase.playerDeclaredLandUse === null || phase.playerDeclaredLandUse === undefined || text(phase.playerDeclaredLandUse) !== null)) { problems.push(`geometry-phase-invalid:${index}`); return; }
    if (ids.has(phase.phaseId)) problems.push(`geometry-phase-duplicate:${phase.phaseId}`);
    if (sequences.has(phase.sequence)) problems.push(`geometry-phase-sequence-duplicate:${phase.sequence}`);
    ids.add(phase.phaseId); sequences.add(phase.sequence);
  });
  return problems;
}
const phaseFacts = (phases) => phases.map((phase) => [phase.phaseId, phase.sequence, phase.playerDeclaredLandUse ?? null]).sort((a, b) => cmp(a[0], b[0]));

// -> { status: "current" | "stale" | "missing" | "invalid" | "inactive", reasons }.  With a record, "current" also means "still the
// geometry the record was made from".  Anything unknown is not current.
export function checkNewTownGeometry(geometry, record = null) {
  if (geometry === null || geometry === undefined) return { status: "missing", reasons: ["geometry-not-provided"] };
  if (!isObject(geometry)) return { status: "invalid", reasons: ["geometry-not-an-object"] };
  const reasons = [];
  if (geometry.schema !== NEW_TOWN_GEOMETRY_SCHEMA || geometry.contractVersion !== 1) reasons.push("geometry-schema-invalid");
  if (text(geometry.developmentId) === null) reasons.push("geometry-development-id-missing");
  if (text(geometry.developmentRevision) === null) reasons.push("geometry-revision-unknown");
  // which pack the map came from: a development id alone does not say, and another pack may reuse it
  if (text(geometry.sourcePackId) === null) reasons.push("geometry-source-pack-unknown");
  if (geometry.sourcePackVersion !== undefined && geometry.sourcePackVersion !== null && text(geometry.sourcePackVersion) === null) reasons.push("geometry-source-pack-version-invalid");
  reasons.push(...phaseProblems(geometry.phases));
  if (reasons.length) return { status: "invalid", reasons };
  if (geometry.active === false) return { status: "inactive", reasons: ["geometry-inactive"] };
  if (geometry.active !== true) return { status: "invalid", reasons: ["geometry-active-unknown"] };
  if (record) {
    const stale = [];
    const pack = record.sourcePack ?? null;
    if (record.developmentId !== geometry.developmentId) stale.push("geometry-other-development");
    else if (pack === null && (record.developmentRevision !== null || Array.isArray(record.phases))) {
      // made from a geometry before pack identity was recorded: never assume it is the current pack
      stale.push("record-source-pack-unknown");
    } else {
      if (pack !== null && pack.packId !== geometry.sourcePackId.trim()) stale.push("geometry-source-pack-changed");
      else if (pack !== null && pack.packVersion !== null && text(geometry.sourcePackVersion) !== null && pack.packVersion !== geometry.sourcePackVersion.trim()) stale.push("geometry-source-pack-version-changed");
      if (record.developmentRevision !== null && record.developmentRevision !== geometry.developmentRevision) stale.push("geometry-revision-changed");
      if (Array.isArray(record.phases) && canonical(phaseFacts(record.phases)) !== canonical(phaseFacts(geometry.phases))) stale.push("geometry-phases-changed");
    }
    if (stale.length) return { status: "stale", reasons: stale };
  }
  return { status: "current", reasons: [] };
}

// --- input normalisation -------------------------------------------------------------------------------------------------------------
function normalizeParties(input) {
  const parties = {};
  for (const role of NEW_TOWN_ROLES) {
    const given = input?.[role];
    if (given !== undefined && !isObject(given)) throw new Error(`Party ${role} must be an object`);
    const party = { role, partyId: role === "player" ? "player" : text(given?.partyId), name: text(given?.name), absent: role === "player" ? false : given?.absent === true };
    if (party.absent && (party.partyId !== null || party.name !== null)) throw new Error(`Party ${role} cannot be both absent and named`);
    parties[role] = party;
  }
  return parties;
}
function normalizeReferences(value, label) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.some((entry) => text(entry) === null)) throw new Error(`${label} must be a list of non-empty texts`);
  return [...new Set(value.map((entry) => entry.trim()))].sort(cmp);
}
function normalizeLinks(input) {
  return {
    linkedPlanIds: normalizeReferences(input?.linkedPlanIds, "linkedPlanIds"),
    linkedStationSiteIds: normalizeReferences(input?.linkedStationSiteIds, "linkedStationSiteIds"),
    linkedServicePlanIds: normalizeReferences(input?.linkedServicePlanIds, "linkedServicePlanIds"),
  };
}
function normalizeSupply(value, phases) {
  if (value === undefined || value === null) return new Map();
  if (!Array.isArray(value)) throw new Error("phaseSupply must be a list");
  const known = new Set(phases.map((phase) => phase.phaseId));
  const out = new Map();
  for (const entry of value) {
    if (!isObject(entry) || !known.has(entry.phaseId) || out.has(entry.phaseId) || text(entry.unit) === null || !nonNegativeInteger(entry.quantity)) throw new Error(`phaseSupply entry is invalid: ${isObject(entry) ? entry.phaseId : entry}`);
    out.set(entry.phaseId, { unit: entry.unit.trim(), quantity: entry.quantity });
  }
  return out;
}
function normalizeAgreement(agreement, parties) {
  if (!isObject(agreement)) throw new Error("An agreement is required");
  if (!Array.isArray(agreement.burdens) || !agreement.burdens.length) throw new Error("An agreement states at least one burden");
  const items = new Set();
  const burdens = agreement.burdens.map((burden) => {
    const itemId = text(burden?.itemId);
    if (itemId === null || items.has(itemId)) throw new Error(`Burden itemId is missing or repeated: ${itemId}`);
    items.add(itemId);
    if (!Array.isArray(burden.bearers) || !burden.bearers.length || new Set(burden.bearers).size !== burden.bearers.length || burden.bearers.some((role) => !NEW_TOWN_ROLES.includes(role))) throw new Error(`Burden ${itemId} must name its bearers among ${NEW_TOWN_ROLES.join(", ")}`);
    for (const role of burden.bearers) if (parties[role].absent) throw new Error(`Burden ${itemId} is borne by ${role}, which is stated absent`);
    const amount = burden.statedAmountJPY === undefined ? null : burden.statedAmountJPY;
    if (amount !== null && !nonNegativeInteger(amount)) throw new Error(`Burden ${itemId} statedAmountJPY must be a non-negative integer or null`);
    return { itemId, bearers: [...burden.bearers].sort(cmp), statedAmountJPY: amount, note: text(burden.note) };
  }).sort((a, b) => cmp(a.itemId, b.itemId));
  let conditions = null;
  if (agreement.connectionConditions !== undefined && agreement.connectionConditions !== null) {
    if (!Array.isArray(agreement.connectionConditions)) throw new Error("connectionConditions must be a list");
    const ids = new Set();
    conditions = agreement.connectionConditions.map((condition) => {
      const conditionId = text(condition?.conditionId);
      if (conditionId === null || ids.has(conditionId) || text(condition.text) === null) throw new Error(`Connection condition is invalid: ${conditionId}`);
      ids.add(conditionId);
      return { conditionId, text: condition.text.trim(), linkedStationSiteId: text(condition.linkedStationSiteId), linkedServicePlanId: text(condition.linkedServicePlanId) };
    }).sort((a, b) => cmp(a.conditionId, b.conditionId));
  }
  return { burdens, connectionConditions: conditions };
}
function normalizeOccupancyFacts(facts) {
  if (!isObject(facts)) throw new Error("Occupancy facts are required");
  const read = (name) => {
    const value = facts[name] === undefined ? null : facts[name];
    if (value !== null && !nonNegativeInteger(value)) throw new Error(`${name} must be a non-negative integer or null`);
    return value;
  };
  const statedOccupiedUnits = read("statedOccupiedUnits");
  const statedPlannedUnits = read("statedPlannedUnits");
  if (statedOccupiedUnits === null && statedPlannedUnits === null) throw new Error("Occupancy facts state at least one number");
  const source = text(facts.source);
  if (source === null) throw new Error("Occupancy facts name their source");
  return { statedOccupiedUnits, statedPlannedUnits, unit: text(facts.unit), source, note: text(facts.note) };
}

// --- the record ---------------------------------------------------------------------------------------------------------------------
function logTransition(record, kind, from, to, atMinute, extra = {}) {
  const sequence = record.history.length + 1;
  record.history.push({ transitionId: `${record.id}:transition:${sequence}`, sequence, kind, from, to, atMinute, reason: extra.reason ?? null, phaseIds: extra.phaseIds ?? null });
  record.updatedAtMinute = atMinute;
}
const packOf = (geometry) => ({ packId: geometry.sourcePackId.trim(), packVersion: text(geometry.sourcePackVersion) });
const geometryState = (check, record, atMinute) => ({ developmentRevision: record.developmentRevision, status: check.status, reasons: [...check.reasons], checkedAtMinute: atMinute });

// Why a transition is not possible now: [] means it is.  The same list is what `assess` shows and what a refused transition says.
export function newTownTransitionBlockers(record, kind, geometryCheck) {
  const rule = NEW_TOWN_TRANSITIONS[kind];
  if (!rule) return [`unknown-transition:${kind}`];
  const blockers = [];
  if (!record) {
    if (kind !== "propose") return ["no-development"];
  } else if (!rule.from.includes(record.status)) blockers.push(`status-not-allowed:${record.status}`);
  if (rule.geometry && geometryCheck.status !== "current") blockers.push(`geometry-${geometryCheck.status}`, ...geometryCheck.reasons);
  if (record && kind === "agree") for (const role of ["municipality", "developer"]) { const p = record.parties[role]; if (!p.absent && p.partyId === null && p.name === null) blockers.push(`party-unknown:${role}`); }
  if (record && kind === "startServicing" && Array.isArray(record.phases) && !record.phases.some((phase) => phase.status === "planned")) blockers.push("no-planned-phase");
  return blockers;
}
function enter(record, kind, geometryCheck) {
  const blockers = newTownTransitionBlockers(record, kind, geometryCheck);
  if (blockers.length) throw new Error(`New town development ${record.id} cannot ${kind}: ${blockers.join(", ")}`);
}

// Read-only: what is blocking each step, for one development (or for creating one).  Changes nothing.
export function assessNewTownDevelopment({ geometry = null, record = null, others = [] } = {}) {
  const check = checkNewTownGeometry(geometry, record);
  const transitions = Object.fromEntries(Object.keys(NEW_TOWN_TRANSITIONS).map((kind) => {
    const blockers = newTownTransitionBlockers(record, kind, check);
    return [kind, { allowed: blockers.length === 0, blockers }];
  }));
  const duplicates = !record && isObject(geometry) ? others.filter((other) => other.developmentId === geometry.developmentId && other.status !== "cancelled").map((other) => other.id) : [];
  return {
    schema: "transitline.new-town-development-assessment/1", contractVersion: 1,
    developmentId: record?.id ?? null, status: record?.status ?? null,
    geometry: { status: check.status, reasons: [...check.reasons] },
    transitions,
    create: record ? null : {
      draft: { allowed: duplicates.length === 0, blockers: duplicates.map((id) => `development-already-has-an-active-record:${id}`) },
      propose: { allowed: transitions.propose.blockers.length === 0 && duplicates.length === 0, blockers: [...transitions.propose.blockers, ...duplicates.map((id) => `development-already-has-an-active-record:${id}`)] },
    },
    notComputed: [...NEW_TOWN_NOT_COMPUTED],
  };
}

function newPhases(id, geometry, supply) {
  return geometry.phases.slice().sort((a, b) => a.sequence - b.sequence).map((phase) => ({
    phaseId: phase.phaseId, sequence: phase.sequence, playerDeclaredLandUse: phase.playerDeclaredLandUse ?? null, status: "planned",
    statedSupply: supply.get(phase.phaseId) ?? null, occupancyFacts: [], hookId: `${id}:phase:${phase.phaseId}`,
  }));
}

// A draft may be made without a map geometry (phases unknown, null); with one it must be usable.
export function createNewTownDevelopmentDraft({ id, input = {}, atMinute = 0, others = [] } = {}) {
  const geometry = input.geometry ?? null;
  const check = checkNewTownGeometry(geometry);
  if (geometry !== null && check.status !== "current") throw new Error(`The geometry cannot start a development: ${check.status} (${check.reasons.join(", ")})`);
  const developmentId = geometry !== null ? geometry.developmentId : text(input.developmentId);
  if (developmentId === null) throw new Error("A development needs a developmentId (from the geometry or given)");
  const duplicate = others.find((other) => other.developmentId === developmentId && other.status !== "cancelled");
  if (duplicate) throw new Error(`Development ${developmentId} already has an active record ${duplicate.id}`);
  if (geometry === null && input.phaseSupply !== undefined && input.phaseSupply !== null) throw new Error("phaseSupply needs a geometry that names the phases");
  const record = {
    schema: NEW_TOWN_DEVELOPMENT_SCHEMA, contractVersion: 1, id, developmentId, name: text(input.name), status: "draft",
    developmentRevision: geometry === null ? null : geometry.developmentRevision,
    sourcePack: geometry === null ? null : packOf(geometry),
    geometry: null, parties: normalizeParties(input.parties), links: normalizeLinks(input.links),
    phases: geometry === null ? null : newPhases(id, geometry, normalizeSupply(input.phaseSupply, geometry.phases)),
    agreement: null, delay: null, cancellation: null, history: [], createdAtMinute: atMinute, updatedAtMinute: atMinute,
  };
  record.geometry = geometryState(check, record, atMinute);
  logTransition(record, "draft", null, "draft", atMinute);
  return clone(record);
}

export function proposeNewTownDevelopmentRecord(record, { geometry = null, atMinute = 0 } = {}) {
  const check = checkNewTownGeometry(geometry, record);
  enter(record, "propose", check);
  if (record.phases === null) {
    record.phases = newPhases(record.id, geometry, new Map());
    record.developmentRevision = geometry.developmentRevision;
    record.sourcePack = packOf(geometry);
  }
  record.geometry = geometryState(check, record, atMinute);
  record.status = "proposed";
  logTransition(record, "propose", "draft", "proposed", atMinute);
  return clone(record);
}

export function agreeNewTownDevelopmentRecord(record, agreement, { geometry = null, atMinute = 0 } = {}) {
  const check = checkNewTownGeometry(geometry, record);
  // the counterparties may be named when the agreement is made; a party nobody named stays unknown and blocks the agreement
  const parties = isObject(agreement) && agreement.parties !== undefined ? normalizeParties({ ...record.parties, ...agreement.parties }) : record.parties;
  enter({ ...record, parties }, "agree", check);
  const terms = normalizeAgreement(agreement, parties);
  record.parties = parties;
  record.agreement = { agreedAtMinute: atMinute, burdens: terms.burdens, connectionConditions: terms.connectionConditions };
  record.geometry = geometryState(check, record, atMinute);
  record.status = "agreed";
  logTransition(record, "agree", "proposed", "agreed", atMinute);
  return clone(record);
}

export function startNewTownServicingRecord(record, { geometry = null, phaseIds = null, atMinute = 0 } = {}) {
  const check = checkNewTownGeometry(geometry, record);
  enter(record, "startServicing", check);
  const planned = record.phases.filter((phase) => phase.status === "planned").sort((a, b) => a.sequence - b.sequence);
  let targets;
  if (phaseIds === null || phaseIds === undefined) targets = [planned[0]];
  else {
    if (!Array.isArray(phaseIds) || !phaseIds.length || new Set(phaseIds).size !== phaseIds.length) throw new Error("phaseIds must be a non-empty list of distinct phases");
    targets = phaseIds.map((id) => {
      const phase = record.phases.find((entry) => entry.phaseId === id);
      if (!phase) throw new Error(`Unknown phase ${id} of ${record.id}`);
      if (phase.status !== "planned") throw new Error(`Phase ${id} is ${phase.status}, not planned`);
      return phase;
    });
  }
  for (const target of targets) {
    const earlier = record.phases.find((phase) => phase.sequence < target.sequence && phase.status === "planned" && !targets.includes(phase));
    if (earlier) throw new Error(`Phase ${target.phaseId} cannot start before the earlier phase ${earlier.phaseId}`);
  }
  for (const target of targets) target.status = "servicing";
  const from = record.status;
  record.geometry = geometryState(check, record, atMinute);
  if (record.status === "agreed") record.status = "servicing";
  logTransition(record, "startServicing", from, record.status, atMinute, { phaseIds: targets.map((phase) => phase.phaseId).sort(cmp) });
  return clone(record);
}

export function recordNewTownOccupancyRecord(record, phaseId, facts, { geometry = null, atMinute = 0 } = {}) {
  const check = checkNewTownGeometry(geometry, record);
  enter(record, "recordOccupancy", check);
  const phase = record.phases.find((entry) => entry.phaseId === phaseId);
  if (!phase) throw new Error(`Unknown phase ${phaseId} of ${record.id}`);
  if (!["servicing", "occupied"].includes(phase.status)) throw new Error(`Phase ${phaseId} is ${phase.status}: occupancy can be recorded for a phase that is being serviced`);
  const stated = normalizeOccupancyFacts(facts);
  const sequence = phase.occupancyFacts.length + 1;
  phase.occupancyFacts.push({ factId: `${phase.hookId}:occupancy:${sequence}`, sequence, recordedAtMinute: atMinute, ...stated });
  phase.status = "occupied";
  const from = record.status;
  record.status = "occupied";
  record.geometry = geometryState(check, record, atMinute);
  logTransition(record, "recordOccupancy", from, "occupied", atMinute, { phaseIds: [phaseId] });
  return clone(record);
}

export function delayNewTownDevelopmentRecord(record, reason, atMinute = 0) {
  const why = reasonOf(reason, "A delay reason");
  enter(record, "delay", { status: "current", reasons: [] });
  const from = record.status;
  record.delay = { reason: why, delayedAtMinute: atMinute, fromStatus: from, resumedAtMinute: null };
  record.status = "delayed";
  logTransition(record, "delay", from, "delayed", atMinute, { reason: why });
  return clone(record);
}

export function resumeNewTownDevelopmentRecord(record, { geometry = null, atMinute = 0 } = {}) {
  const check = checkNewTownGeometry(geometry, record);
  enter(record, "resume", check);
  const back = record.delay.fromStatus;
  record.delay = { ...record.delay, resumedAtMinute: atMinute };
  record.status = back;
  record.geometry = geometryState(check, record, atMinute);
  logTransition(record, "resume", "delayed", back, atMinute);
  return clone(record);
}

export function cancelNewTownDevelopmentRecord(record, reason, atMinute = 0) {
  const why = reasonOf(reason, "A cancellation reason");
  enter(record, "cancel", { status: "current", reasons: [] });
  const from = record.status;
  for (const phase of record.phases ?? []) if (["planned", "servicing"].includes(phase.status)) phase.status = "cancelled";
  record.cancellation = { reason: why, cancelledAtMinute: atMinute, fromStatus: from };
  record.status = "cancelled";
  logTransition(record, "cancel", from, "cancelled", atMinute, { reason: why });
  return clone(record);
}

// What a later bridge reads: stable ids and the player's stated facts, copied as they are.  B15 demand reads `phases` (land use, stated
// supply, stated occupancy facts); B14 events read `transitions`.  Nothing is converted here.
export function newTownDevelopmentHooks(record) {
  return {
    schema: "transitline.new-town-development-hooks/1", contractVersion: 1,
    developmentHookId: record.id, developmentId: record.developmentId, developmentRevision: record.developmentRevision, status: record.status,
    sourcePack: clone(record.sourcePack ?? null),
    geometryStatus: record.geometry?.status ?? null,
    phases: (record.phases ?? []).map((phase) => ({ hookId: phase.hookId, phaseId: phase.phaseId, sequence: phase.sequence, status: phase.status, playerDeclaredLandUse: phase.playerDeclaredLandUse, statedSupply: clone(phase.statedSupply), occupancyFacts: clone(phase.occupancyFacts) })),
    transitions: record.history.map((entry) => ({ transitionId: entry.transitionId, kind: entry.kind, from: entry.from, to: entry.to, atMinute: entry.atMinute, phaseIds: entry.phaseIds ? [...entry.phaseIds] : null })),
    links: clone(record.links),
    notComputed: [...NEW_TOWN_NOT_COMPUTED],
  };
}
