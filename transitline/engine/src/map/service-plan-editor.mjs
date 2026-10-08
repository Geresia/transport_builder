// Editing and saving service plans. Pure data: a document of what the player STATED — the sections to run, the
// directions, the time bands with the headway / trainsets / cars they asked for, where trains may turn back, the vehicle
// they have in mind, their own operating assumptions. Nothing here measures anything or says that a wish can be run: the
// spatial facts come from buildServicePlan, the verdict from the management engine.
// A plan keeps its `key` for life, so its servicePlanId never changes; the items inside (directions, bands, turnbacks,
// assumptions, depot references) keep theirs. A key is never handed out twice, even after the plan or item was removed
// (counters only go up, a removed plan stays as a tombstone). Editing never confirms a plan against the geometry: only
// addPlan / rebindRevision record the geometry revision, so a plan made on an older geometry stays stale until the
// player confirms it again.

export const SERVICE_PLAN_DOC_VERSION = 1;

export const newServicePlanDoc = (packId, packVersion = null) => ({ version: SERVICE_PLAN_DOC_VERSION, packId, packVersion, plans: [] });
export const activePlans = (doc) => doc.plans.filter((p) => !p.deleted);

const clone = (v) => structuredClone(v);
// item type -> the plan's list and the fields the player may change
const ITEMS = Object.freeze({
  direction: { list: "directions", fields: ["label", "fromStationId", "toStationId"] },
  band: { list: "serviceBands", fields: ["label", "startMinute", "endMinute", "periodId", "directionKeys", "headwayMinutes", "trainsets", "formationCars", "note"] },
  turnback: { list: "turnbacks", fields: ["stationId", "intent", "terminalResourceId", "turnbackCandidateId"] },
  assumption: { list: "assumptions", fields: ["text"] },
  depot: { list: "depotRefs", fields: ["depotSiteId", "stationId", "role"] },
});
export const ITEM_TYPES = Object.freeze(Object.keys(ITEMS));
const PLAN_FIELDS = Object.freeze(["name", "planKind", "operatingPattern", "operationalLineId"]);
const VEHICLE_FIELDS = Object.freeze(["vehicleModelId", "requestedCars", "requestedTrainsets"]);

const find = (doc, key) => {
  const plan = doc.plans.find((p) => p.key === key && !p.deleted);
  if (!plan) throw new Error(`Unknown service plan ${key}`);
  return plan;
};
// Smallest unused "plan-N", counting removed plans too.
export function nextPlanKey(doc) {
  const used = new Set(doc.plans.map((p) => p.key));
  let n = 1;
  while (used.has(`plan-${n}`)) n++;
  return `plan-${n}`;
}
const pick = (source, fields) => Object.fromEntries(fields.filter((f) => source?.[f] !== undefined).map((f) => [f, clone(source[f])]));

// railGeometry: the RailCapacityGeometry v1 the plan is made on (its revision is recorded).
export function addPlan(doc, { key, name = null, railGeometry, planKind = null, operatingPattern = null, operationalLineId = null }) {
  if (!railGeometry?.railGeometryId) throw new Error("A service plan needs the rail geometry it is made on");
  const value = key === undefined || key === null || key === "" ? nextPlanKey(doc) : String(key);
  if (doc.plans.some((p) => p.key === value)) throw new Error(`Service plan key ${value} is already used`);
  const plan = {
    key: value, name, active: true, deleted: false, planKind, operatingPattern, operationalLineId,
    railGeometryId: railGeometry.railGeometryId, designedRailGeometryRevision: railGeometry.railGeometryRevision ?? null,
    route: null, directions: null, serviceBands: null, turnbacks: null, depotRefs: null, assumptions: [],
    vehicleIntent: { vehicleModelId: null, requestedCars: null, requestedTrainsets: null }, seq: {},
  };
  doc.plans.push(plan);
  return plan;
}
export const updatePlan = (doc, key, patch) => Object.assign(find(doc, key), pick(patch, PLAN_FIELDS));
export function setVehicleIntent(doc, key, patch) {
  const plan = find(doc, key);
  Object.assign(plan.vehicleIntent, pick(patch, VEHICLE_FIELDS));
  return plan;
}
// The player looked at the current geometry again and keeps the plan: records its revision, changes nothing else.
export function rebindRevision(doc, key, railGeometry) {
  const plan = find(doc, key);
  if (railGeometry?.railGeometryId !== plan.railGeometryId) throw new Error("The rail geometry of the plan changed: create a new plan");
  plan.designedRailGeometryRevision = railGeometry.railGeometryRevision ?? null;
  return plan;
}
// A plan is switched off, never lost: it keeps its id, its bands and everything else, and comes back as it was.
export function deactivatePlan(doc, key) { const p = find(doc, key); p.active = false; return p; }
export function restorePlan(doc, key) { const p = find(doc, key); p.active = true; return p; }
// A removed plan stays in the document as a tombstone so its key is never given to another plan.
export function removePlan(doc, key) {
  const plan = find(doc, key);
  Object.assign(plan, { deleted: true, active: false });
  return plan;
}

// --- the route: sections in the order the player picks them (ids must be sections of the geometry, when it is given) ---
const checkSections = (ids, railGeometry) => {
  if (!railGeometry) return;
  const known = new Set(railGeometry.sections.map((s) => s.sectionId));
  const bad = ids.filter((id) => !known.has(id));
  if (bad.length) throw new Error(`Unknown section ${bad[0]}`);
};
export function setRoute(doc, key, { sectionIds, fromStationId = null, toStationId = null }, railGeometry = null) {
  const plan = find(doc, key);
  const ids = sectionIds.map(String);
  if (new Set(ids).size !== ids.length) throw new Error("A section can be on the route once");
  checkSections(ids, railGeometry);
  plan.route = { sectionIds: ids, fromStationId, toStationId };
  return plan;
}
export function clearRoute(doc, key) { const p = find(doc, key); p.route = null; return p; }
const routeOf = (plan) => {
  if (!plan.route) throw new Error("Choose the route first");
  return plan.route;
};
export function appendSection(doc, key, sectionId, railGeometry = null) {
  const plan = find(doc, key);
  const route = plan.route ?? (plan.route = { sectionIds: [], fromStationId: null, toStationId: null });
  checkSections([sectionId], railGeometry);
  if (route.sectionIds.includes(sectionId)) throw new Error("A section can be on the route once");
  route.sectionIds.push(String(sectionId));
  return plan;
}
export function removeSection(doc, key, sectionId) {
  const plan = find(doc, key);
  routeOf(plan).sectionIds = plan.route.sectionIds.filter((id) => id !== sectionId);
  return plan;
}
export function moveSection(doc, key, fromIndex, toIndex) {
  const plan = find(doc, key);
  const ids = routeOf(plan).sectionIds;
  if (!(fromIndex >= 0 && fromIndex < ids.length && toIndex >= 0 && toIndex < ids.length)) throw new Error("No such position on the route");
  ids.splice(toIndex, 0, ...ids.splice(fromIndex, 1));
  return plan;
}
// The same sections the other way round (and the stated end stations swapped). The plan's id does not change.
export function reverseRoute(doc, key) {
  const route = routeOf(find(doc, key));
  route.sectionIds.reverse();
  [route.fromStationId, route.toStationId] = [route.toStationId, route.fromStationId];
  return find(doc, key);
}

// --- items: directions, bands, turnbacks, assumptions, depot references. Keys are "direction-1", "band-2", ... and only count up ---
const itemOf = (plan, type, key) => {
  if (!ITEMS[type]) throw new Error(`Unknown item type ${type}`);
  const item = plan[ITEMS[type].list]?.find((x) => x.key === key);
  if (!item) throw new Error(`Unknown ${type} ${key}`);
  return item;
};
export function addItem(doc, key, type, value = {}) {
  const spec = ITEMS[type];
  if (!spec) throw new Error(`Unknown item type ${type}`);
  const plan = find(doc, key);
  plan.seq[type] = (plan.seq[type] ?? 0) + 1;
  const item = { ...pick(value, spec.fields), key: `${type}-${plan.seq[type]}` };
  // a band starts on every direction the plan has now, unless the player names them
  if (type === "band" && item.directionKeys === undefined && Array.isArray(plan.directions)) item.directionKeys = plan.directions.map((d) => d.key).sort();
  (plan[spec.list] ??= []).push(item);
  return item;
}
export function updateItem(doc, key, type, itemKey, patch) {
  return Object.assign(itemOf(find(doc, key), type, itemKey), pick(patch, ITEMS[type].fields));
}
export function removeItem(doc, key, type, itemKey) {
  const plan = find(doc, key);
  const item = itemOf(plan, type, itemKey);
  plan[ITEMS[type].list] = plan[ITEMS[type].list].filter((x) => x !== item);
  return item;
}
export const addDirection = (doc, key, value) => addItem(doc, key, "direction", value); // { label?, fromStationId, toStationId }
export const updateDirection = (doc, key, itemKey, patch) => updateItem(doc, key, "direction", itemKey, patch);
export const removeDirection = (doc, key, itemKey) => removeItem(doc, key, "direction", itemKey);
// Both directions between two stations (two items; the second is the first turned round).
export const addBothDirections = (doc, key, fromStationId, toStationId, labels = []) => [
  addDirection(doc, key, { fromStationId, toStationId, label: labels[0] }), addDirection(doc, key, { fromStationId: toStationId, toStationId: fromStationId, label: labels[1] }),
];
export const addBand = (doc, key, value) => addItem(doc, key, "band", value); // { startMinute, endMinute, headwayMinutes?, trainsets?, formationCars?, periodId?, directionKeys?, label?, note? }
export const updateBand = (doc, key, itemKey, patch) => updateItem(doc, key, "band", itemKey, patch);
export const removeBand = (doc, key, itemKey) => removeItem(doc, key, "band", itemKey);
// A band is switched off, not lost: it keeps its id and its numbers.
export function deactivateBand(doc, key, itemKey) { const b = itemOf(find(doc, key), "band", itemKey); b.active = false; return b; }
export function restoreBand(doc, key, itemKey) { const b = itemOf(find(doc, key), "band", itemKey); b.active = true; return b; }
export const addTurnback = (doc, key, value) => addItem(doc, key, "turnback", value); // { stationId, intent?, terminalResourceId?, turnbackCandidateId? }
export const updateTurnback = (doc, key, itemKey, patch) => updateItem(doc, key, "turnback", itemKey, patch);
export const removeTurnback = (doc, key, itemKey) => removeItem(doc, key, "turnback", itemKey);
export const addAssumption = (doc, key, text) => addItem(doc, key, "assumption", { text });
export const removeAssumption = (doc, key, itemKey) => removeItem(doc, key, "assumption", itemKey);
export const addDepotRef = (doc, key, value) => addItem(doc, key, "depot", value); // { depotSiteId?, stationId?, role? }
export const removeDepotRef = (doc, key, itemKey) => removeItem(doc, key, "depot", itemKey);
// "The player states there are none" ([]) versus "not stated" (null): the lists a plan may leave out.
export function declareNone(doc, key, type) { const p = find(doc, key); p[ITEMS[type].list] = []; return p; }
export function clearList(doc, key, type) { const p = find(doc, key); p[ITEMS[type].list] = type === "assumption" ? [] : null; return p; }

// The input of buildServicePlan (the counters and the tombstone flag are the editor's own).
export function toDrawnPlan(plan) {
  const { seq: _seq, deleted: _deleted, ...rest } = clone(plan);
  return rest;
}
// Every plan that is not removed, switched-off ones included (they carry `active: false`).
export const drawnPlansOf = (doc) => activePlans(doc).map(toDrawnPlan);

export const serializeServicePlanDoc = (doc) => JSON.stringify({ version: doc.version, packId: doc.packId, packVersion: doc.packVersion, plans: doc.plans });

// Never applies a saved document to the wrong pack, and never hides a pack version change. A saved document that is refused
// leaves `current` (the document the player is editing) as it is: the result then holds that same object and `rejected: true`.
export function restoreServicePlanDoc(text, pack, { current = null } = {}) {
  const packId = pack.manifest?.id ?? "pack";
  const packVersion = pack.manifest?.version ?? null;
  const fresh = newServicePlanDoc(packId, packVersion);
  const refuse = (code, extra = {}) => ({ doc: current ?? fresh, rejected: true, warnings: [{ code, ...extra }] });
  if (text === null || text === undefined) return { doc: current ?? fresh, rejected: false, warnings: [] };
  let saved;
  try { saved = JSON.parse(text); } catch { return refuse("service-plan-doc-unreadable"); }
  if (saved?.version !== SERVICE_PLAN_DOC_VERSION || !Array.isArray(saved.plans) || !saved.plans.every((p) => p && typeof p === "object" && typeof p.key === "string")) return refuse("service-plan-doc-version", { version: saved?.version ?? null });
  if (saved.packId !== packId) return refuse("service-plan-doc-other-pack", { savedPackId: saved.packId ?? null });
  const warnings = saved.packVersion !== packVersion ? [{ code: "pack-version-mismatch", saved: saved.packVersion ?? null, current: packVersion }] : [];
  return { doc: { ...fresh, plans: saved.plans }, rejected: false, warnings };
}
