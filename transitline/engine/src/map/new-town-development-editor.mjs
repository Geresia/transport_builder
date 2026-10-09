// Editing and saving new-town developments.  Pure data: a document of what the player DREW and STATED - the development
// areas, their phases (polygon, the land use and delivery order the player declares, the station sites and rail lines the
// player names).  Nothing here measures anything or says that a plan can be built, filled or served: the spatial facts come
// from buildNewTownDevelopment, every verdict from the management engine.  No storage is used here: the document is a
// plain object, and saving it is serializeNewTownDoc(doc) (a string) for whoever owns persistence.
//
// A development keeps its `key` for life (move, redraw, rename, reorder, save, reopen), so its developmentId never changes;
// a phase keeps its key inside its development, so its phaseId never changes either.  A key is never handed out twice, even
// after the development or phase was removed: counters only go up and a removed one stays in the document as a tombstone.
export const NEW_TOWN_DOC_VERSION = 1;

export const newNewTownDoc = (packId, packVersion = null) => ({ version: NEW_TOWN_DOC_VERSION, packId, packVersion, developments: [] });
export const activeDevelopments = (doc) => doc.developments.filter((d) => !d.deleted);
export const activePhases = (development) => development.phases.filter((p) => !p.deleted);

const clone = (v) => structuredClone(v);
const finitePoint = (p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite);
const checkPoint = (p) => { if (!finitePoint(p)) throw new Error("A point needs a finite [lon, lat]"); return [p[0], p[1]]; };
const checkPolygon = (ring) => {
  if (ring === null) return null;
  if (!Array.isArray(ring) || ring.length < 3) throw new Error("A polygon needs at least three vertices");
  return ring.map(checkPoint);
};
const checkLandUse = (v) => {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string" || !v.trim() || v.trim().length > 64) throw new Error("Land use is a short text of at most 64 characters");
  return v.trim();
};
const checkOrder = (v) => {
  if (v === null || v === undefined) return null;
  if (!Number.isInteger(v) || v < 1) throw new Error("A delivery order is a whole number from 1");
  return v;
};
const checkName = (v) => (v === null || v === undefined ? null : String(v));

const find = (doc, key) => {
  const development = doc.developments.find((d) => d.key === key && !d.deleted);
  if (!development) throw new Error(`Unknown development ${key}`);
  return development;
};
const findPhase = (doc, key, phaseKey) => {
  const development = find(doc, key);
  const phase = development.phases.find((p) => p.key === phaseKey && !p.deleted);
  if (!phase) throw new Error(`Unknown phase ${phaseKey}`);
  return { development, phase };
};

// Smallest unused "town-N", counting removed developments too.
export function nextDevelopmentKey(doc) {
  const used = new Set(doc.developments.map((d) => d.key));
  let n = 1;
  while (used.has(`town-${n}`)) n++;
  return `town-${n}`;
}
const phaseKeyNumber = (key) => { const m = /^phase-(\d+)$/.exec(key); return m ? Number(m[1]) : 0; };

// --- developments ---
export function addDevelopment(doc, { key, name = null } = {}) {
  const value = key === undefined || key === null || key === "" ? nextDevelopmentKey(doc) : String(key);
  if (doc.developments.some((d) => d.key === value)) throw new Error(`Development key ${value} is already used`);
  const development = { key: value, name: checkName(name), active: true, deleted: false, phaseSeq: 0, phases: [] };
  doc.developments.push(development);
  return development;
}
export function updateDevelopment(doc, key, patch) {
  const development = find(doc, key);
  if (patch?.name !== undefined) development.name = checkName(patch.name);
  return development;
}
// A development is switched off, never lost: it keeps its id, its phases and everything else, and comes back as it was.
export function deactivateDevelopment(doc, key) { const d = find(doc, key); d.active = false; return d; }
export function restoreDevelopment(doc, key) { const d = find(doc, key); d.active = true; return d; }
// A removed development stays as a tombstone so its key is never given to another development.
export function removeDevelopment(doc, key) {
  const development = find(doc, key);
  Object.assign(development, { deleted: true, active: false });
  return development;
}
// Shifts every phase polygon of the development; keys (and so ids) are unchanged.
export function moveDevelopment(doc, key, dLon, dLat) {
  const development = find(doc, key);
  for (const phase of activePhases(development)) if (phase.polygon) phase.polygon = phase.polygon.map(([lon, lat]) => [lon + dLon, lat + dLat]);
  return development;
}

// --- phases: keys are "phase-1", "phase-2", ... and only count up ---
// value: { key?, name?, polygon?, playerDeclaredLandUse?, playerDeclaredDeliveryOrder?, stationRefs?, railRefs? }
export function addPhase(doc, key, value = {}) {
  const development = find(doc, key);
  // what the player gives is checked first, so a refused phase does not use up a key
  const fields = {
    name: checkName(value.name), polygon: value.polygon === undefined ? null : checkPolygon(value.polygon),
    playerDeclaredLandUse: checkLandUse(value.playerDeclaredLandUse), playerDeclaredDeliveryOrder: checkOrder(value.playerDeclaredDeliveryOrder),
    stationRefs: value.stationRefs === undefined ? null : clone(value.stationRefs), railRefs: value.railRefs === undefined ? null : clone(value.railRefs),
  };
  const used = new Set(development.phases.map((p) => p.key));
  let phaseKey;
  if (value.key === undefined || value.key === null || value.key === "") {
    development.phaseSeq = Math.max(development.phaseSeq ?? 0, ...development.phases.map((p) => phaseKeyNumber(p.key))) + 1;
    phaseKey = `phase-${development.phaseSeq}`;
  } else {
    phaseKey = String(value.key);
    if (used.has(phaseKey)) throw new Error(`Phase key ${phaseKey} is already used`);
    development.phaseSeq = Math.max(development.phaseSeq ?? 0, phaseKeyNumber(phaseKey));
  }
  const phase = { key: phaseKey, active: true, deleted: false, ...fields };
  development.phases.push(phase);
  return phase;
}
export function updatePhase(doc, key, phaseKey, patch = {}) {
  const { phase } = findPhase(doc, key, phaseKey);
  if (patch.name !== undefined) phase.name = checkName(patch.name);
  if (patch.playerDeclaredLandUse !== undefined) phase.playerDeclaredLandUse = checkLandUse(patch.playerDeclaredLandUse);
  if (patch.playerDeclaredDeliveryOrder !== undefined) phase.playerDeclaredDeliveryOrder = checkOrder(patch.playerDeclaredDeliveryOrder);
  return phase;
}
// The player's station sites and rail lines: null = not stated, [] = states there are none, a list = those references.
export function setStationRefs(doc, key, phaseKey, refs) { const { phase } = findPhase(doc, key, phaseKey); phase.stationRefs = refs === null ? null : clone(refs); return phase; }
export function setRailRefs(doc, key, phaseKey, refs) { const { phase } = findPhase(doc, key, phaseKey); phase.railRefs = refs === null ? null : clone(refs); return phase; }

// --- the polygon ---
export function setPolygon(doc, key, phaseKey, polygon) { const { phase } = findPhase(doc, key, phaseKey); phase.polygon = checkPolygon(polygon); return phase; }
const polygonOf = (phase) => {
  if (!phase.polygon) throw new Error("The phase has no polygon yet");
  return phase.polygon;
};
export function insertVertex(doc, key, phaseKey, index, point) {
  const { phase } = findPhase(doc, key, phaseKey);
  const ring = polygonOf(phase);
  if (!Number.isInteger(index) || index < 0 || index > ring.length) throw new Error("No such position on the polygon");
  ring.splice(index, 0, checkPoint(point));
  return phase;
}
export function moveVertex(doc, key, phaseKey, index, point) {
  const { phase } = findPhase(doc, key, phaseKey);
  const ring = polygonOf(phase);
  if (!Number.isInteger(index) || index < 0 || index >= ring.length) throw new Error("No such vertex");
  ring[index] = checkPoint(point);
  return phase;
}
export function removeVertex(doc, key, phaseKey, index) {
  const { phase } = findPhase(doc, key, phaseKey);
  const ring = polygonOf(phase);
  if (!Number.isInteger(index) || index < 0 || index >= ring.length) throw new Error("No such vertex");
  if (ring.length <= 3) throw new Error("A polygon needs at least three vertices");
  ring.splice(index, 1);
  return phase;
}
// Shifts the polygon; the key (and so the phase id) is unchanged.
export function movePhase(doc, key, phaseKey, dLon, dLat) {
  const { phase } = findPhase(doc, key, phaseKey);
  if (phase.polygon) phase.polygon = phase.polygon.map(([lon, lat]) => [lon + dLon, lat + dLat]);
  return phase;
}

// --- order, switching off, removal ---
// The phase moves to position `toIndex` (0-based) among the phases that are not removed; its key and id stay, its sequence changes.
export function reorderPhase(doc, key, phaseKey, toIndex) {
  const { development, phase } = findPhase(doc, key, phaseKey);
  const live = activePhases(development);
  if (!Number.isInteger(toIndex) || toIndex < 0 || toIndex >= live.length) throw new Error("No such position among the phases");
  live.splice(live.indexOf(phase), 1);
  live.splice(toIndex, 0, phase);
  development.phases = [...live, ...development.phases.filter((p) => p.deleted)];
  return development;
}
// A phase is switched off, never lost: it keeps its id, its polygon and its declarations, and its place in the order.
export function deactivatePhase(doc, key, phaseKey) { const { phase } = findPhase(doc, key, phaseKey); phase.active = false; return phase; }
export function restorePhase(doc, key, phaseKey) { const { phase } = findPhase(doc, key, phaseKey); phase.active = true; return phase; }
export function removePhase(doc, key, phaseKey) {
  const { phase } = findPhase(doc, key, phaseKey);
  Object.assign(phase, { deleted: true, active: false });
  return phase;
}

// The input of buildNewTownDevelopment.  Sequences are the phases' places in the player's order, written out so that the
// builder does not depend on how the list is stored.  Removed phases are left out; switched-off ones carry `active: false`.
export function toDrawnDevelopment(development) {
  return {
    key: development.key, name: development.name, active: development.active,
    phases: activePhases(development).map((p, i) => ({
      key: p.key, name: p.name, sequence: i + 1, active: p.active, polygon: clone(p.polygon),
      playerDeclaredLandUse: p.playerDeclaredLandUse, playerDeclaredDeliveryOrder: p.playerDeclaredDeliveryOrder,
      access: { stationRefs: clone(p.stationRefs), railRefs: clone(p.railRefs) },
    })),
  };
}
// Every development that is not removed, switched-off ones included (they carry `active: false`).
export const drawnDevelopmentsOf = (doc) => activeDevelopments(doc).map(toDrawnDevelopment);

export const serializeNewTownDoc = (doc) => JSON.stringify({ version: doc.version, packId: doc.packId, packVersion: doc.packVersion, developments: doc.developments });

const validDevelopment = (d) => d && typeof d === "object" && typeof d.key === "string" && Array.isArray(d.phases)
  && d.phases.every((p) => p && typeof p === "object" && typeof p.key === "string");

// Never applies a saved document to the wrong pack, and never hides a pack version change.  A saved document that is refused leaves
// `current` (the document the player is editing) as it is: the result then holds that same object and `rejected: true`.
export function restoreNewTownDoc(text, pack, { current = null } = {}) {
  const packId = pack.manifest?.id ?? "pack";
  const packVersion = pack.manifest?.version ?? null;
  const fresh = newNewTownDoc(packId, packVersion);
  const refuse = (code, extra = {}) => ({ doc: current ?? fresh, rejected: true, warnings: [{ code, ...extra }] });
  if (text === null || text === undefined) return { doc: current ?? fresh, rejected: false, warnings: [] };
  let saved;
  try { saved = JSON.parse(text); } catch { return refuse("new-town-doc-unreadable"); }
  if (saved?.version !== NEW_TOWN_DOC_VERSION || !Array.isArray(saved.developments) || !saved.developments.every(validDevelopment)) return refuse("new-town-doc-version", { version: saved?.version ?? null });
  if (saved.packId !== packId) return refuse("new-town-doc-other-pack", { savedPackId: saved.packId ?? null });
  const warnings = saved.packVersion !== packVersion ? [{ code: "pack-version-mismatch", saved: saved.packVersion ?? null, current: packVersion }] : [];
  // a counter that was edited down must not hand out a key that a phase (or a tombstone) already holds
  const developments = saved.developments.map((d) => ({ ...d, phaseSeq: Math.max(Number.isInteger(d.phaseSeq) ? d.phaseSeq : 0, ...d.phases.map((p) => phaseKeyNumber(p.key))) }));
  return { doc: { ...fresh, developments }, rejected: false, warnings };
}
