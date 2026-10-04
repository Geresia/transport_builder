// Editing and saving rail capacity designs. Pure data: a document of what the player stated and drew. A design keeps
// its `key` for life, so its railGeometryId never changes; the items inside (boundaries, junctions, terminals,
// platforms, turnback tracks) keep their own keys. Editing never confirms a design against the plans or route: only
// addDesign / rebindRevisions record their revisions, so a plan that changed since the player last looked stays stale
// until they re-confirm it.
import { planRevisionOf } from "./rail-capacity-geometry.mjs";

export const RAIL_CAPACITY_DOC_VERSION = 1;

export const newRailCapacityDoc = (packId, packVersion = null) => ({ version: RAIL_CAPACITY_DOC_VERSION, packId, packVersion, designs: [] });

const smallestUnused = (prefix, used) => {
  const taken = new Set(used);
  let n = 1;
  while (taken.has(`${prefix}-${n}`)) n++;
  return `${prefix}-${n}`;
};
const clone = (v) => structuredClone(v);
const find = (doc, key) => {
  const design = doc.designs.find((d) => d.key === key);
  if (!design) throw new Error(`Unknown rail design ${key}`);
  return design;
};
const refId = (ref) => (ref?.planId ? `plan|${ref.planId}|${ref.segmentId}` : `ext|${ref?.externalLineId}|${[ref?.fromStationId, ref?.toStationId].sort().join("|")}`);
// an item of a keyed list: the list must exist (declared) before items are added to it
const listOf = (design, field) => {
  if (!Array.isArray(design[field])) throw new Error(`${field} is not declared: declare it first`);
  return design[field];
};
const keyedItem = (list, key, what) => {
  const item = list.find((x) => x.key === key);
  if (!item) throw new Error(`Unknown ${what} ${key}`);
  return item;
};
const recordRevisions = (design, plans, route) => {
  design.designedRevisions = { plans: Object.fromEntries(plans.map((p) => [p.planId, planRevisionOf(p)])), routes: route ? { [route.throughRouteId]: route.geometryRevision } : {} };
};

// plans: the PlanGeometry plans the design covers (their revisions are recorded). route: an optional ThroughRouteGeometry.
export function addDesign(doc, { plans, externalLineIds = [], route = null, name = null }) {
  if (!plans?.length) throw new Error("A rail design needs at least one plan");
  const design = {
    key: smallestUnused("rail", doc.designs.map((d) => d.key)), name, planIds: plans.map((p) => p.planId).sort(), externalLineIds: [...externalLineIds].sort(),
    throughRouteId: route?.throughRouteId ?? null, designedRevisions: null, sectionFacts: [], blockBoundaries: null, junctions: null, terminals: null,
  };
  recordRevisions(design, plans, route);
  doc.designs.push(design);
  return design;
}
// The player looked at the current plans / route again and keeps the design: records their revisions, changes nothing else.
export function rebindRevisions(doc, key, { plans, route = null }) {
  const design = find(doc, key);
  if (plans.map((p) => p.planId).sort().join() !== design.planIds.join()) throw new Error("The plans of the design changed: create a new design");
  recordRevisions(design, plans, route);
  return design;
}
export const updateDesign = (doc, key, patch) => Object.assign(find(doc, key), clone(patch));
export function removeDesign(doc, key) {
  find(doc, key);
  doc.designs = doc.designs.filter((d) => d.key !== key);
}

// --- what the player states about one section: track count, designed gradient ---
export function setSectionFact(doc, key, ref, fact) {
  const design = find(doc, key);
  const id = refId(ref);
  let entry = design.sectionFacts.find((f) => refId(f.ref) === id);
  if (!entry) { entry = { ref: clone(ref) }; design.sectionFacts.push(entry); }
  Object.assign(entry, clone(fact));
  return entry;
}
export function clearSectionFact(doc, key, ref) {
  const design = find(doc, key);
  design.sectionFacts = design.sectionFacts.filter((f) => refId(f.ref) !== refId(ref));
}

// --- block boundaries: null = no block data, [] = declared "none inside any section" ---
export function declareBlockBoundaries(doc, key) { const d = find(doc, key); d.blockBoundaries ??= []; return d; }
export function clearBlockBoundaries(doc, key) { const d = find(doc, key); d.blockBoundaries = null; return d; }
export function addBlockBoundary(doc, key, boundary) {
  const list = listOf(find(doc, key), "blockBoundaries");
  const item = { ...clone(boundary), key: boundary.key ?? smallestUnused("boundary", list.map((b) => b.key)) };
  list.push(item);
  return item;
}
export function moveBlockBoundary(doc, key, boundaryKey, alongMeters) {
  const item = keyedItem(listOf(find(doc, key), "blockBoundaries"), boundaryKey, "boundary");
  item.alongMeters = alongMeters;
  return item;
}
export function removeBlockBoundary(doc, key, boundaryKey) {
  const d = find(doc, key);
  keyedItem(listOf(d, "blockBoundaries"), boundaryKey, "boundary");
  d.blockBoundaries = d.blockBoundaries.filter((b) => b.key !== boundaryKey);
}

// --- junctions ---
export function declareJunctions(doc, key) { const d = find(doc, key); d.junctions ??= []; return d; }
export function clearJunctions(doc, key) { const d = find(doc, key); d.junctions = null; return d; }
export function addJunction(doc, key, junction) {
  const list = listOf(find(doc, key), "junctions");
  const item = { connections: [], ...clone(junction), key: junction.key ?? smallestUnused("junction", list.map((j) => j.key)) };
  list.push(item);
  return item;
}
export function moveJunction(doc, key, junctionKey, location) {
  const item = keyedItem(listOf(find(doc, key), "junctions"), junctionKey, "junction");
  item.location = clone(location);
  return item;
}
export function connectJunction(doc, key, junctionKey, connection) {
  const item = keyedItem(listOf(find(doc, key), "junctions"), junctionKey, "junction");
  item.connections = [...item.connections.filter((c) => c.role !== connection.role), clone(connection)];
  return item;
}
export function disconnectJunction(doc, key, junctionKey, role) {
  const item = keyedItem(listOf(find(doc, key), "junctions"), junctionKey, "junction");
  item.connections = item.connections.filter((c) => c.role !== role);
  return item;
}
export function removeJunction(doc, key, junctionKey) {
  const d = find(doc, key);
  keyedItem(listOf(d, "junctions"), junctionKey, "junction");
  d.junctions = d.junctions.filter((j) => j.key !== junctionKey);
}

// --- terminals, their platform candidates and turnback / pull-out / stabling tracks ---
export function declareTerminals(doc, key) { const d = find(doc, key); d.terminals ??= []; return d; }
export function clearTerminals(doc, key) { const d = find(doc, key); d.terminals = null; return d; }
export function addTerminal(doc, key, terminal) {
  const list = listOf(find(doc, key), "terminals");
  const item = { platforms: null, turnbackTracks: null, ...clone(terminal), key: terminal.key ?? smallestUnused("terminal", list.map((t) => t.key)) };
  list.push(item);
  return item;
}
export function removeTerminal(doc, key, terminalKey) {
  const d = find(doc, key);
  keyedItem(listOf(d, "terminals"), terminalKey, "terminal");
  d.terminals = d.terminals.filter((t) => t.key !== terminalKey);
}
const childList = (doc, key, terminalKey, field) => {
  const terminal = keyedItem(listOf(find(doc, key), "terminals"), terminalKey, "terminal");
  terminal[field] ??= [];
  return terminal;
};
export function addPlatform(doc, key, terminalKey, platform) {
  const terminal = childList(doc, key, terminalKey, "platforms");
  const item = { ...clone(platform), key: platform.key ?? smallestUnused("platform", terminal.platforms.map((p) => p.key)) };
  terminal.platforms.push(item);
  return item;
}
export function removePlatform(doc, key, terminalKey, platformKey) {
  const terminal = childList(doc, key, terminalKey, "platforms");
  keyedItem(terminal.platforms, platformKey, "platform");
  terminal.platforms = terminal.platforms.filter((p) => p.key !== platformKey);
}
export function addTurnbackTrack(doc, key, terminalKey, track) {
  const terminal = childList(doc, key, terminalKey, "turnbackTracks");
  const item = { ...clone(track), key: track.key ?? smallestUnused("turnback", terminal.turnbackTracks.map((t) => t.key)) };
  terminal.turnbackTracks.push(item);
  return item;
}
export function removeTurnbackTrack(doc, key, terminalKey, trackKey) {
  const terminal = childList(doc, key, terminalKey, "turnbackTracks");
  keyedItem(terminal.turnbackTracks, trackKey, "turnback track");
  terminal.turnbackTracks = terminal.turnbackTracks.filter((t) => t.key !== trackKey);
}

export const toDrawnDesign = (design) => clone(design);

export const serializeRailCapacityDoc = (doc) => JSON.stringify({ version: doc.version, packId: doc.packId, packVersion: doc.packVersion, designs: doc.designs });

// Never applies a saved document to the wrong pack, and never hides a pack version change.
export function restoreRailCapacityDoc(text, pack) {
  const packId = pack.manifest?.id ?? "pack";
  const packVersion = pack.manifest?.version ?? null;
  const fresh = newRailCapacityDoc(packId, packVersion);
  if (text === null || text === undefined) return { doc: fresh, warnings: [] };
  let saved;
  try { saved = JSON.parse(text); } catch { return { doc: fresh, warnings: [{ code: "rail-capacity-doc-unreadable" }] }; }
  if (saved?.version !== RAIL_CAPACITY_DOC_VERSION || !Array.isArray(saved.designs)) return { doc: fresh, warnings: [{ code: "rail-capacity-doc-version", version: saved?.version ?? null }] };
  if (saved.packId !== packId) return { doc: fresh, warnings: [{ code: "rail-capacity-doc-other-pack", savedPackId: saved.packId }] };
  const warnings = saved.packVersion !== packVersion ? [{ code: "pack-version-mismatch", saved: saved.packVersion, current: packVersion }] : [];
  return { doc: { ...fresh, designs: saved.designs }, warnings };
}
