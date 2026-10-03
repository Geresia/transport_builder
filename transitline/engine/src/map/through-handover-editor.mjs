// Editing and saving through-running handover sites. Pure data: a document of what the player drew.
// A site keeps its `key` for life (retarget, redraw, move a waypoint, save, reopen), so its handoverSiteId never
// changes. Editing never confirms a design against the route: only addSite / selectHandover / rebindRoute record the
// route revision, so a route that changed since the player last looked stays stale until they re-confirm it.
import { THROUGH_ROUTE_SCHEMA } from "./through-route.mjs";
import { snapToLegAlignment } from "./through-handover-site.mjs";

export const THROUGH_HANDOVER_DOC_VERSION = 1;
const SIDES = ["from", "to"];

export const newThroughHandoverDoc = (packId, packVersion = null) => ({ version: THROUGH_HANDOVER_DOC_VERSION, packId, packVersion, sites: [] });

const smallestUnused = (prefix, used) => {
  const taken = new Set(used);
  let n = 1;
  while (taken.has(`${prefix}-${n}`)) n++;
  return `${prefix}-${n}`;
};
export const nextHandoverSiteKey = (doc) => smallestUnused("handover", doc.sites.map((s) => s.key));

const find = (doc, key) => {
  const site = doc.sites.find((s) => s.key === key);
  if (!site) throw new Error(`Unknown handover site ${key}`);
  return site;
};
const handoverOf = (route, handoverId) => {
  if (route?.schema !== THROUGH_ROUTE_SCHEMA) throw new Error("Not a ThroughRouteGeometry v1 route");
  const handover = route.handovers.find((h) => h.handoverId === handoverId);
  if (!handover) throw new Error(`Unknown handover ${handoverId}`);
  return handover;
};
const target = (route, handover) => ({ throughRouteId: route.throughRouteId, handoverId: handover.handoverId, fromLegId: handover.fromLegId, toLegId: handover.toLegId, routeGeometryRevision: route.geometryRevision });
const clone = (v) => structuredClone(v);

// Picks the handover to design a connection for. Records the route revision the player is looking at.
export function addSite(doc, route, handoverId, { name = null } = {}) {
  const handover = handoverOf(route, handoverId);
  const site = { key: nextHandoverSiteKey(doc), name, ...target(route, handover), fromConnectionPoint: null, toConnectionPoint: null, via: [], structureHint: null, turnoutCandidates: [], workAreas: [] };
  doc.sites.push(site);
  return site;
}

// Retargets the site to another handover: the drawing belonged to the old one, so it is cleared. Name and key stay.
export function selectHandover(doc, key, route, handoverId) {
  const site = find(doc, key);
  const handover = handoverOf(route, handoverId);
  Object.assign(site, target(route, handover), { fromConnectionPoint: null, toConnectionPoint: null, via: [], structureHint: null, turnoutCandidates: [], workAreas: [] });
  return site;
}

// The player has looked at the current route again and keeps the drawing: records its revision, changes nothing else.
export function rebindRoute(doc, key, route) {
  const site = find(doc, key);
  const handover = handoverOf(route, site.handoverId);
  if (handover.fromLegId !== site.fromLegId || handover.toLegId !== site.toLegId) throw new Error("The handover now joins other legs: select the handover again");
  site.routeGeometryRevision = route.geometryRevision;
  return site;
}

export const updateSite = (doc, key, patch) => Object.assign(find(doc, key), clone(patch));

export function removeSite(doc, key) {
  find(doc, key);
  doc.sites = doc.sites.filter((s) => s.key !== key);
}

// side: "from" | "to". With `route`, the point is snapped onto that leg's known alignment (within 50 m); an external
// leg without a known alignment keeps the clicked point as the player's selection, and no evidence follows from it.
export function setConnectionPoint(doc, key, side, location, { route = null } = {}) {
  if (!SIDES.includes(side)) throw new Error(`Unknown side ${side}`);
  const site = find(doc, key);
  const snapped = route ? snapToLegAlignment(route, site[`${side}LegId`], location) : null;
  site[`${side}ConnectionPoint`] = clone(snapped ? snapped.location : location);
  return site;
}
export function clearConnectionPoint(doc, key, side) {
  if (!SIDES.includes(side)) throw new Error(`Unknown side ${side}`);
  const site = find(doc, key);
  site[`${side}ConnectionPoint`] = null;
  return site;
}

// --- connection waypoints (between the two connection points) ---
const waypoint = (site, index) => {
  if (!Number.isInteger(index) || index < 0 || index >= site.via.length) throw new Error(`Unknown waypoint ${index}`);
};
export function addWaypoint(doc, key, location, index = null) {
  const site = find(doc, key);
  const at = index === null ? site.via.length : index;
  if (!Number.isInteger(at) || at < 0 || at > site.via.length) throw new Error(`Bad waypoint position ${index}`);
  site.via.splice(at, 0, clone(location));
  return site;
}
export function moveWaypoint(doc, key, index, location) {
  const site = find(doc, key);
  waypoint(site, index);
  site.via[index] = clone(location);
  return site;
}
export function removeWaypoint(doc, key, index) {
  const site = find(doc, key);
  waypoint(site, index);
  site.via.splice(index, 1);
  return site;
}
export function clearWaypoints(doc, key) {
  const site = find(doc, key);
  site.via = [];
  return site;
}

// The structure type of the connection, as the player states it (null clears it). Never inferred.
export function setStructureHint(doc, key, hint) {
  const site = find(doc, key);
  site.structureHint = hint ?? null;
  return site;
}

// --- turnouts: candidates the player marked, each selected or not ---
const findTurnout = (site, turnoutKey) => {
  const t = site.turnoutCandidates.find((c) => c.key === turnoutKey);
  if (!t) throw new Error(`Unknown turnout ${turnoutKey}`);
  return t;
};
export function addTurnout(doc, key, location, { selected = true } = {}) {
  const site = find(doc, key);
  const turnout = { key: smallestUnused("turnout", site.turnoutCandidates.map((t) => t.key)), location: clone(location), selected };
  site.turnoutCandidates.push(turnout);
  return turnout;
}
export function moveTurnout(doc, key, turnoutKey, location) {
  const turnout = findTurnout(find(doc, key), turnoutKey);
  turnout.location = clone(location);
  return turnout;
}
export function setTurnoutSelected(doc, key, turnoutKey, selected) {
  const turnout = findTurnout(find(doc, key), turnoutKey);
  turnout.selected = Boolean(selected);
  return turnout;
}
export function removeTurnout(doc, key, turnoutKey) {
  const site = find(doc, key);
  findTurnout(site, turnoutKey);
  site.turnoutCandidates = site.turnoutCandidates.filter((t) => t.key !== turnoutKey);
}

// --- work areas ---
const findArea = (site, areaKey) => {
  const a = site.workAreas.find((w) => w.key === areaKey);
  if (!a) throw new Error(`Unknown work area ${areaKey}`);
  return a;
};
export function addWorkArea(doc, key, polygon) {
  const site = find(doc, key);
  const area = { key: smallestUnused("work", site.workAreas.map((w) => w.key)), polygon: clone(polygon) };
  site.workAreas.push(area);
  return area;
}
export function redrawWorkArea(doc, key, areaKey, polygon) {
  const area = findArea(find(doc, key), areaKey);
  area.polygon = clone(polygon);
  return area;
}
export function removeWorkArea(doc, key, areaKey) {
  const site = find(doc, key);
  findArea(site, areaKey);
  site.workAreas = site.workAreas.filter((w) => w.key !== areaKey);
}

// The input of buildThroughHandoverSite: the drawn connection is the two points with the waypoints between them.
export function toDrawnSite(site) {
  const line = [site.fromConnectionPoint, ...site.via, site.toConnectionPoint].filter(Boolean);
  return {
    key: site.key, name: site.name,
    throughRouteId: site.throughRouteId, handoverId: site.handoverId, fromLegId: site.fromLegId, toLegId: site.toLegId,
    routeGeometryRevision: site.routeGeometryRevision,
    fromConnectionPoint: site.fromConnectionPoint, toConnectionPoint: site.toConnectionPoint,
    connectionAlignment: line.length ? line : null,
    structureHint: site.structureHint ?? null,
    turnoutCandidates: site.turnoutCandidates, workAreas: site.workAreas,
  };
}

export const serializeThroughHandoverDoc = (doc) => JSON.stringify({ version: doc.version, packId: doc.packId, packVersion: doc.packVersion, sites: doc.sites });

// Never applies a saved document to the wrong pack, and never hides a pack version change.
export function restoreThroughHandoverDoc(text, pack) {
  const packId = pack.manifest?.id ?? "pack";
  const packVersion = pack.manifest?.version ?? null;
  const fresh = newThroughHandoverDoc(packId, packVersion);
  if (text === null || text === undefined) return { doc: fresh, warnings: [] };
  let saved;
  try { saved = JSON.parse(text); } catch { return { doc: fresh, warnings: [{ code: "through-handover-doc-unreadable" }] }; }
  if (saved?.version !== THROUGH_HANDOVER_DOC_VERSION || !Array.isArray(saved.sites)) return { doc: fresh, warnings: [{ code: "through-handover-doc-version", version: saved?.version ?? null }] };
  if (saved.packId !== packId) return { doc: fresh, warnings: [{ code: "through-handover-doc-other-pack", savedPackId: saved.packId }] };
  const warnings = saved.packVersion !== packVersion ? [{ code: "pack-version-mismatch", saved: saved.packVersion, current: packVersion }] : [];
  return { doc: { ...fresh, sites: saved.sites }, warnings };
}
