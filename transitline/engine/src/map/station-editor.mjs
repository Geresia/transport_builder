// Editing and saving station candidate sites. Pure data: a document of what the player drew.
// A site keeps its `key` for life (move, rotate, resize, delete, restore, save, reopen), so its stationSiteId never
// changes; entrances keep their keys the same way. Deleting a site only tombstones it, so restoring brings back the
// same id and nothing else can take its key.
import { frameAt } from "./local-geometry.mjs";

export const STATION_DOC_VERSION = 1;

export const newStationDoc = (packId, packVersion = null) => ({ version: STATION_DOC_VERSION, packId, packVersion, sites: [] });

// Sites that take part in the export (deleted ones stay in the document, not in the output).
export const activeSites = (doc) => doc.sites.filter((s) => !s.deleted);

// Smallest unused "station-N", counting deleted sites too: a key is never handed out twice.
export function nextStationKey(doc) {
  const used = new Set(doc.sites.map((s) => s.key));
  let n = 1;
  while (used.has(`station-${n}`)) n++;
  return `station-${n}`;
}

// site: { name?, location, connect?: { planId, stationId }, headingDegrees?, lengthMeters?, widthMeters? }
export function addSite(doc, site) {
  const value = {
    key: nextStationKey(doc), name: null, location: null, connect: null, headingDegrees: null, lengthMeters: null, widthMeters: null,
    entrances: [], transfers: [], workAreas: [], entranceSeq: 0, deleted: false, ...structuredClone(site),
  };
  doc.sites.push(value);
  return value;
}

const find = (doc, key) => {
  const site = doc.sites.find((s) => s.key === key);
  if (!site) throw new Error(`Unknown station site ${key}`);
  return site;
};

export function updateSite(doc, key, patch) {
  return Object.assign(find(doc, key), structuredClone(patch));
}

const eachPoint = (site, fn) => {
  site.location = fn(site.location);
  site.entrances = site.entrances.map((e) => ({ ...e, location: fn(e.location) }));
  site.transfers = site.transfers.map((t) => ({ ...t, via: (t.via ?? []).map(fn) }));
  site.workAreas = site.workAreas.map((w) => ({ ...w, polygon: w.polygon.map(fn) }));
};

// The body and everything placed relative to it move together; keys (and so ids) are unchanged.
export function moveSite(doc, key, dLon, dLat) {
  const site = find(doc, key);
  eachPoint(site, ([lon, lat]) => [lon + dLon, lat + dLat]);
  return site;
}

// Turns the body by `deltaDegrees` (clockwise) about its centre, entrances and passages with it.
// `currentHeadingDegrees` is the heading the map is showing now (from the export); the result is the player's own heading.
export function rotateSite(doc, key, deltaDegrees, currentHeadingDegrees = null) {
  const site = find(doc, key);
  const base = site.headingDegrees ?? currentHeadingDegrees ?? 0;
  const centre = [...site.location];
  const frame = frameAt(centre);
  const a = (deltaDegrees * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  // clockwise on a north-up map: (x east, y north) -> (x cos + y sin, -x sin + y cos)
  eachPoint(site, (p) => { const [x, y] = frame.xy(p); return frame.ll([x * cos + y * sin, -x * sin + y * cos]); });
  site.location = centre; // the centre is the fixed point: keep it exact, not re-derived
  site.headingDegrees = ((base + deltaDegrees) % 360 + 360) % 360;
  return site;
}

export function resizeSite(doc, key, { lengthMeters, widthMeters }) {
  const site = find(doc, key);
  if (lengthMeters !== undefined) site.lengthMeters = lengthMeters;
  if (widthMeters !== undefined) site.widthMeters = widthMeters;
  return site;
}

export function removeSite(doc, key) { find(doc, key).deleted = true; }
export function restoreSite(doc, key) { find(doc, key).deleted = false; }

export function addEntrance(doc, key, location, name = null) {
  const site = find(doc, key);
  site.entranceSeq += 1;
  const entrance = { key: `entrance-${site.entranceSeq}`, name, location: [...location] };
  site.entrances.push(entrance);
  return entrance;
}
export function moveEntrance(doc, key, entranceKey, location) {
  const e = find(doc, key).entrances.find((x) => x.key === entranceKey);
  if (!e) throw new Error(`Unknown entrance ${entranceKey}`);
  e.location = [...location];
  return e;
}
export function removeEntrance(doc, key, entranceKey) {
  const site = find(doc, key);
  site.entrances = site.entrances.filter((e) => e.key !== entranceKey);
}

// A transfer passage is identified by its target station: one passage per target.
export function setTransfer(doc, key, targetStationId, via = []) {
  const site = find(doc, key);
  const t = { targetStationId, via: via.map((p) => [...p]) };
  const i = site.transfers.findIndex((x) => x.targetStationId === targetStationId);
  if (i >= 0) site.transfers[i] = t; else site.transfers.push(t);
  return t;
}
export function removeTransfer(doc, key, targetStationId) {
  const site = find(doc, key);
  site.transfers = site.transfers.filter((t) => t.targetStationId !== targetStationId);
}

// Four deterministic starting points around a body (both ends, both sides), `offsetMeters` outside it.
// The player edits or deletes them; they are ordinary keyed entrances once added.
export function suggestEntrancePoints({ location, headingDegrees, lengthMeters, widthMeters }, offsetMeters = 10) {
  if (!Array.isArray(location) || ![headingDegrees, lengthMeters, widthMeters].every(Number.isFinite)) return [];
  const frame = frameAt(location);
  const h = (headingDegrees * Math.PI) / 180;
  const u = [Math.sin(h), Math.cos(h)];
  const v = [u[1], -u[0]];
  const a = lengthMeters / 2 + offsetMeters;
  const b = widthMeters / 2 + offsetMeters;
  return [[a, 0], [-a, 0], [0, b], [0, -b]].map(([s, t]) => frame.ll([u[0] * s + v[0] * t, u[1] * s + v[1] * t]));
}

export const serializeStationDoc = (doc) => JSON.stringify({ version: doc.version, packId: doc.packId, packVersion: doc.packVersion, sites: doc.sites });

// Never applies a saved document to the wrong pack, and never hides a pack version change.
export function restoreStationDoc(text, pack) {
  const packId = pack.manifest?.id ?? "pack";
  const packVersion = pack.manifest?.version ?? null;
  const fresh = newStationDoc(packId, packVersion);
  if (text === null || text === undefined) return { doc: fresh, warnings: [] };
  let saved;
  try { saved = JSON.parse(text); } catch { return { doc: fresh, warnings: [{ code: "station-doc-unreadable" }] }; }
  if (saved?.version !== STATION_DOC_VERSION || !Array.isArray(saved.sites)) return { doc: fresh, warnings: [{ code: "station-doc-version", version: saved?.version ?? null }] };
  if (saved.packId !== packId) return { doc: fresh, warnings: [{ code: "station-doc-other-pack", savedPackId: saved.packId }] };
  const warnings = saved.packVersion !== packVersion ? [{ code: "pack-version-mismatch", saved: saved.packVersion, current: packVersion }] : [];
  return { doc: { ...fresh, sites: saved.sites }, warnings };
}
