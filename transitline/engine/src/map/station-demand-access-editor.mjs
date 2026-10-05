// Editing and saving station demand / access drawings. Pure data: a document of what the player drew for each station —
// entrances, walking access points, the walking links between them, transfer passages, the access-boundary polygons
// (catchments) and the living-area zones. A station keeps its `key` for life, so its stationAccessId never changes;
// elements keep theirs too (a key is never handed out twice, even after the element was removed), so a walking link
// that names an entrance by key never attaches to another one. Removing a station only tombstones it. Nothing here
// measures anything: the facts come from buildStationDemandAccess.
import { frameAt } from "./local-geometry.mjs";

export const STATION_DEMAND_ACCESS_DOC_VERSION = 1;

export const newStationDemandAccessDoc = (packId, packVersion = null) => ({ version: STATION_DEMAND_ACCESS_DOC_VERSION, packId, packVersion, stations: [] });
export const activeStations = (doc) => doc.stations.filter((s) => !s.deleted);

const clone = (v) => structuredClone(v);
// element type -> the station's array and the prefix of its keys
const TYPES = Object.freeze({
  entrance: "entrances", "access-point": "accessPoints", "walk-link": "walkLinks", catchment: "catchments", "demand-zone": "demandZones",
});
export const ELEMENT_TYPES = Object.freeze(Object.keys(TYPES));
const POLYGONS = new Set(["catchment", "demand-zone"]);

// Smallest unused "access-N", counting removed stations too.
export function nextStationKey(doc) {
  const used = new Set(doc.stations.map((s) => s.key));
  let n = 1;
  while (used.has(`access-${n}`)) n++;
  return `access-${n}`;
}

// station: { key?, name?, location?, connect?: { planId, stationId } | { externalNetworkId, stationId } }
// A key the caller gives (e.g. "example:radial:station-x") must be unused; without one the next "access-N" is taken.
export function addStation(doc, station = {}) {
  const key = station.key === undefined || station.key === null || station.key === "" ? nextStationKey(doc) : String(station.key);
  if (doc.stations.some((s) => s.key === key)) throw new Error(`Station access key ${key} is already used`);
  const value = {
    name: null, location: null, connect: null, ...clone(station), key,
    entrances: [], accessPoints: [], walkLinks: [], transfers: [], catchments: [], demandZones: [], seq: {}, deleted: false,
  };
  doc.stations.push(value);
  return value;
}
const find = (doc, key) => {
  const station = doc.stations.find((s) => s.key === key);
  if (!station) throw new Error(`Unknown station access ${key}`);
  return station;
};
export function updateStation(doc, key, patch) {
  const { key: _k, ...rest } = clone(patch);
  return Object.assign(find(doc, key), rest);
}
export function removeStation(doc, key) { find(doc, key).deleted = true; }
export function restoreStation(doc, key) { find(doc, key).deleted = false; }

const item = (station, type, key) => {
  const found = station[TYPES[type]]?.find((x) => x.key === key);
  if (!found) throw new Error(`Unknown ${type} ${key}`);
  return found;
};

// Adds an element and gives it its key: "entrance-3", "walk-link-1", ... The counter only goes up.
export function addElement(doc, stationKey, type, value) {
  if (!TYPES[type]) throw new Error(`Unknown element type ${type}`);
  const station = find(doc, stationKey);
  station.seq[type] = (station.seq[type] ?? 0) + 1;
  const element = { ...clone(value), key: `${type}-${station.seq[type]}` };
  station[TYPES[type]].push(element);
  return element;
}
export const addEntrance = (doc, stationKey, value) => addElement(doc, stationKey, "entrance", value); // { name?, location }
export const addAccessPoint = (doc, stationKey, value) => addElement(doc, stationKey, "access-point", value); // { name?, location, kind? }
export const addWalkLink = (doc, stationKey, value) => addElement(doc, stationKey, "walk-link", value); // { name?, from: { kind, key? }, to, via?, widthMeters? }
export const addCatchment = (doc, stationKey, value) => addElement(doc, stationKey, "catchment", value); // { name?, polygon, entranceKey? }
export const addDemandZone = (doc, stationKey, value) => addElement(doc, stationKey, "demand-zone", value); // { name?, kind?, polygon }

export function updateElement(doc, stationKey, type, key, patch) {
  const { key: _k, ...rest } = clone(patch);
  return Object.assign(item(find(doc, stationKey), type, key), rest);
}
// What still names an element: walking links, transfers, catchments. Removing it leaves them in the document (the builder
// reports them as warnings) so nothing the player drew is lost silently; the editor can show this list before removing.
export function referencesTo(doc, stationKey, type, key) {
  const station = find(doc, stationKey);
  const refs = [];
  if (type === "entrance" || type === "access-point" || type === "demand-zone") {
    for (const l of station.walkLinks) if ((l.from?.kind === type && l.from.key === key) || (l.to?.kind === type && l.to.key === key)) refs.push({ type: "walk-link", key: l.key });
  }
  if (type === "entrance") {
    for (const t of station.transfers) if (t.fromEntranceKey === key) refs.push({ type: "transfer", targetStationId: t.targetStationId });
    for (const c of station.catchments) if (c.entranceKey === key) refs.push({ type: "catchment", key: c.key });
  }
  return refs;
}
export function removeElement(doc, stationKey, type, key) {
  const station = find(doc, stationKey);
  const removed = item(station, type, key);
  station[TYPES[type]] = station[TYPES[type]].filter((x) => x !== removed);
  return removed;
}

// Points: entrances and access points move by `location`.
export function moveElement(doc, stationKey, type, key, location) {
  const element = item(find(doc, stationKey), type, key);
  element.location = clone(location);
  return element;
}

// Polygons (catchments, zones): edit one vertex at a time; a polygon keeps at least three vertices.
const polygonOf = (doc, stationKey, type, key) => {
  if (!POLYGONS.has(type)) throw new Error(`${type} has no polygon`);
  return item(find(doc, stationKey), type, key);
};
export function moveVertex(doc, stationKey, type, key, index, location) {
  const e = polygonOf(doc, stationKey, type, key);
  if (!(index >= 0 && index < e.polygon.length)) throw new Error(`No vertex ${index}`);
  e.polygon[index] = clone(location);
  return e;
}
export function insertVertex(doc, stationKey, type, key, index, location) {
  const e = polygonOf(doc, stationKey, type, key);
  if (!(index >= 0 && index <= e.polygon.length)) throw new Error(`No vertex position ${index}`);
  e.polygon.splice(index, 0, clone(location));
  return e;
}
export function removeVertex(doc, stationKey, type, key, index) {
  const e = polygonOf(doc, stationKey, type, key);
  if (e.polygon.length <= 3) throw new Error("A polygon keeps at least three vertices");
  if (!(index >= 0 && index < e.polygon.length)) throw new Error(`No vertex ${index}`);
  e.polygon.splice(index, 1);
  return e;
}

// The waypoints of a walking link (the bends the player drew between its two ends), and its two ends.
export function setWalkLinkVia(doc, stationKey, key, via) { return updateElement(doc, stationKey, "walk-link", key, { via: via ?? [] }); }
export function setWalkLinkEnds(doc, stationKey, key, { from, to }) {
  const patch = {};
  if (from !== undefined) patch.from = from;
  if (to !== undefined) patch.to = to;
  return updateElement(doc, stationKey, "walk-link", key, patch);
}

// A transfer passage to another station, by that station's id (one per target; setting it again replaces it).
export function setTransfer(doc, stationKey, targetStationId, via = [], { fromEntranceKey = null, widthMeters = null } = {}) {
  const station = find(doc, stationKey);
  station.transfers = station.transfers.filter((t) => t.targetStationId !== targetStationId);
  const transfer = { targetStationId, via: clone(via), fromEntranceKey, widthMeters };
  station.transfers.push(transfer);
  return transfer;
}
export function clearTransfer(doc, stationKey, targetStationId) {
  const station = find(doc, stationKey);
  station.transfers = station.transfers.filter((t) => t.targetStationId !== targetStationId);
}

// Applies `fn` to every point the station holds, so a move or a turn takes the whole drawing along; keys (and ids) are unchanged.
function mapPoints(station, fn) {
  if (station.location) station.location = fn(station.location);
  for (const type of ["entrance", "access-point"]) station[TYPES[type]] = station[TYPES[type]].map((e) => ({ ...e, location: fn(e.location) }));
  station.walkLinks = station.walkLinks.map((l) => ({ ...l, via: (l.via ?? []).map(fn) }));
  station.transfers = station.transfers.map((t) => ({ ...t, via: (t.via ?? []).map(fn) }));
  for (const type of ["catchment", "demand-zone"]) station[TYPES[type]] = station[TYPES[type]].map((e) => ({ ...e, polygon: e.polygon.map(fn) }));
  return station;
}
export function moveStation(doc, key, dLon, dLat) {
  return mapPoints(find(doc, key), ([lon, lat]) => [lon + dLon, lat + dLat]);
}
// Turns the drawing by `deltaDegrees` (clockwise) about `centre`.
export function rotateStation(doc, key, deltaDegrees, centre) {
  const frame = frameAt(centre);
  const a = (deltaDegrees * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  return mapPoints(find(doc, key), (p) => { const [x, y] = frame.xy(p); return frame.ll([x * cos + y * sin, -x * sin + y * cos]); });
}

// The input of buildStationDemandAccess.
export const toDrawnStation = (station) => clone(station);

export const serializeStationDemandAccessDoc = (doc) => JSON.stringify({ version: doc.version, packId: doc.packId, packVersion: doc.packVersion, stations: doc.stations });

// Never applies a saved document to the wrong pack, and never hides a pack version change.
export function restoreStationDemandAccessDoc(text, pack) {
  const packId = pack.manifest?.id ?? "pack";
  const packVersion = pack.manifest?.version ?? null;
  const fresh = newStationDemandAccessDoc(packId, packVersion);
  if (text === null || text === undefined) return { doc: fresh, warnings: [] };
  let saved;
  try { saved = JSON.parse(text); } catch { return { doc: fresh, warnings: [{ code: "station-demand-access-doc-unreadable" }] }; }
  if (saved?.version !== STATION_DEMAND_ACCESS_DOC_VERSION || !Array.isArray(saved.stations) || !saved.stations.every((s) => s && typeof s === "object" && typeof s.key === "string")) {
    return { doc: fresh, warnings: [{ code: "station-demand-access-doc-version", version: saved?.version ?? null }] };
  }
  if (saved.packId !== packId) return { doc: fresh, warnings: [{ code: "station-demand-access-doc-other-pack", savedPackId: saved.packId }] };
  const warnings = saved.packVersion !== packVersion ? [{ code: "pack-version-mismatch", saved: saved.packVersion, current: packVersion }] : [];
  return { doc: { ...fresh, stations: saved.stations }, warnings };
}
