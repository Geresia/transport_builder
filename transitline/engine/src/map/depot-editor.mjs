// Editing and saving depot candidate sites. Pure data: a document of what the player drew.
// A site keeps its `key` for life (move, redraw, reconnect, save, reopen), so its depotSiteId never changes;
// a site drawn without a key gets its id from its shape instead (see depot-site.mjs).
export const DEPOT_DOC_VERSION = 1;

export const newDepotDoc = (packId, packVersion = null) => ({ version: DEPOT_DOC_VERSION, packId, packVersion, sites: [] });

// Smallest unused "depot-N": stable across reloads because the saved sites carry their keys.
export function nextDepotKey(doc) {
  const used = new Set(doc.sites.map((s) => s.key));
  let n = 1;
  while (used.has(`depot-${n}`)) n++;
  return `depot-${n}`;
}

// site: { name?, polygon?: [[lon,lat]...], location?: [lon,lat], connect? }
export function addSite(doc, site) {
  const value = { key: nextDepotKey(doc), name: null, polygon: null, location: null, connect: null, ...structuredClone(site) };
  doc.sites.push(value);
  return value;
}

const find = (doc, key) => {
  const site = doc.sites.find((s) => s.key === key);
  if (!site) throw new Error(`Unknown depot site ${key}`);
  return site;
};

export function updateSite(doc, key, patch) {
  return Object.assign(find(doc, key), structuredClone(patch));
}

// Shifts the parcel and its connection waypoints; the key (and so the id) is unchanged.
export function moveSite(doc, key, dLon, dLat) {
  const site = find(doc, key);
  const shift = ([lon, lat]) => [lon + dLon, lat + dLat];
  if (site.polygon) site.polygon = site.polygon.map(shift);
  if (site.location) site.location = shift(site.location);
  if (site.connect?.via) site.connect = { ...site.connect, via: site.connect.via.map(shift) };
  return site;
}

// Redrawing replaces the geometry only: name, key and connection target stay (old waypoints no longer fit).
export function redrawSite(doc, key, { polygon = null, location = null }) {
  const site = find(doc, key);
  site.polygon = polygon;
  site.location = location;
  if (site.connect?.via) site.connect = { ...site.connect, via: [] };
  return site;
}

export function removeSite(doc, key) {
  find(doc, key);
  doc.sites = doc.sites.filter((s) => s.key !== key);
}

export const serializeDepotDoc = (doc) => JSON.stringify({ version: doc.version, packId: doc.packId, packVersion: doc.packVersion, sites: doc.sites });

// Never applies a saved document to the wrong pack, and never hides a pack version change.
export function restoreDepotDoc(text, pack) {
  const packId = pack.manifest?.id ?? "pack";
  const packVersion = pack.manifest?.version ?? null;
  const fresh = newDepotDoc(packId, packVersion);
  if (text === null || text === undefined) return { doc: fresh, warnings: [] };
  let saved;
  try { saved = JSON.parse(text); } catch { return { doc: fresh, warnings: [{ code: "depot-doc-unreadable" }] }; }
  if (saved?.version !== DEPOT_DOC_VERSION || !Array.isArray(saved.sites)) return { doc: fresh, warnings: [{ code: "depot-doc-version", version: saved?.version ?? null }] };
  if (saved.packId !== packId) return { doc: fresh, warnings: [{ code: "depot-doc-other-pack", savedPackId: saved.packId }] };
  const warnings = saved.packVersion !== packVersion ? [{ code: "pack-version-mismatch", saved: saved.packVersion, current: packVersion }] : [];
  return { doc: { ...fresh, sites: saved.sites }, warnings };
}
