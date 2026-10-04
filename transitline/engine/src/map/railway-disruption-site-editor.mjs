// Editing and saving railway disruption sites. Pure data: a document of what the player stated about each event — where
// it is, the influence polygon they drew, the section they linked it to. The document is keyed by `eventId` (the id the
// engine gave the event), so a site keeps its disruptionSiteId for life: moving the location, redrawing the polygon,
// switching the site off and back on, saving and reopening never change it. A site is never deleted, only deactivated
// and restored; the engine's events are read, never written. Editing never confirms a design against the geometry:
// only addSite / rebindRailGeometry record the geometry revision, so a geometry that changed since the player last
// looked stays stale until they re-confirm it.
import { snapToSection } from "./railway-disruption-site.mjs";

export const RAILWAY_DISRUPTION_DOC_VERSION = 1;

export const newRailwayDisruptionDoc = (packId, packVersion = null) => ({ version: RAILWAY_DISRUPTION_DOC_VERSION, packId, packVersion, sites: [] });

const clone = (v) => structuredClone(v);
const find = (doc, eventId) => {
  const site = doc.sites.find((s) => s.eventId === eventId);
  if (!site) throw new Error(`Unknown disruption site ${eventId}`);
  return site;
};

// Starts a site for an event, recording the geometry it is looked at on. An event that already has one keeps it.
export function addSite(doc, eventId, { railGeometry }) {
  if (!eventId) throw new Error("A disruption site needs an event id");
  const existing = doc.sites.find((s) => s.eventId === eventId);
  if (existing) return existing;
  const site = { eventId, active: true, railGeometryId: railGeometry?.railGeometryId ?? null, designedRailGeometryRevision: railGeometry?.railGeometryRevision ?? null, railCapacitySectionId: null, location: null, locationBasis: null, affectedPolygon: null };
  doc.sites.push(site);
  return site;
}

// The player looked at the current geometry again and keeps the site: records its revision, changes nothing else.
export function rebindRailGeometry(doc, eventId, railGeometry) {
  const site = find(doc, eventId);
  site.railGeometryId = railGeometry.railGeometryId;
  site.designedRailGeometryRevision = railGeometry.railGeometryRevision;
  return site;
}

// Where the event is. With the geometry and the section (stored link or `sectionId`), the point is snapped onto the
// section's alignment (within 50 m); a section without alignment keeps the clicked point as the player's statement.
export function setLocation(doc, eventId, location, { railGeometry = null, sectionId = null, basis = "player" } = {}) {
  const site = find(doc, eventId);
  const snapped = railGeometry ? snapToSection(railGeometry, sectionId ?? site.railCapacitySectionId, location) : null;
  site.location = clone(snapped ? snapped.location : location);
  site.locationBasis = basis;
  return site;
}
export function clearLocation(doc, eventId) {
  const site = find(doc, eventId);
  site.location = null;
  site.locationBasis = null;
  return site;
}

export function setAffectedPolygon(doc, eventId, polygon) {
  const site = find(doc, eventId);
  site.affectedPolygon = clone(polygon);
  return site;
}
export function clearAffectedPolygon(doc, eventId) {
  const site = find(doc, eventId);
  site.affectedPolygon = null;
  return site;
}

// The map section the event belongs to, when the application has not linked it already (null clears the link).
export function setSectionLink(doc, eventId, sectionId) {
  const site = find(doc, eventId);
  site.railCapacitySectionId = sectionId ?? null;
  return site;
}

// A site is switched off, never deleted: it keeps its id, its location and its polygon, and comes back as it was.
export function deactivateSite(doc, eventId) { const s = find(doc, eventId); s.active = false; return s; }
export function restoreSite(doc, eventId) { const s = find(doc, eventId); s.active = true; return s; }
export const activeSites = (doc) => doc.sites.filter((s) => s.active !== false);

// The input of buildRailwayDisruptionSite.
export const toDrawnSite = (site) => clone(site);

export const serializeRailwayDisruptionDoc = (doc) => JSON.stringify({ version: doc.version, packId: doc.packId, packVersion: doc.packVersion, sites: doc.sites });

// Never applies a saved document to the wrong pack, and never hides a pack version change.
export function restoreRailwayDisruptionDoc(text, pack) {
  const packId = pack.manifest?.id ?? "pack";
  const packVersion = pack.manifest?.version ?? null;
  const fresh = newRailwayDisruptionDoc(packId, packVersion);
  if (text === null || text === undefined) return { doc: fresh, warnings: [] };
  let saved;
  try { saved = JSON.parse(text); } catch { return { doc: fresh, warnings: [{ code: "railway-disruption-doc-unreadable" }] }; }
  if (saved?.version !== RAILWAY_DISRUPTION_DOC_VERSION || !Array.isArray(saved.sites)) return { doc: fresh, warnings: [{ code: "railway-disruption-doc-version", version: saved?.version ?? null }] };
  if (saved.packId !== packId) return { doc: fresh, warnings: [{ code: "railway-disruption-doc-other-pack", savedPackId: saved.packId }] };
  const warnings = saved.packVersion !== packVersion ? [{ code: "pack-version-mismatch", saved: saved.packVersion, current: packVersion }] : [];
  return { doc: { ...fresh, sites: saved.sites }, warnings };
}
