// Selection bridge, core: which station candidate, entrances, transfer passages and work area the player picked in
// a StationExport, and the plain output the station UI hands on. Pure data and geometry over the export: it never
// changes the export, the plans or any management state, and it computes nothing about cost, duration, score,
// construction method, compensation or awards. Ids come from the export, so a selection survives a save and
// reopen as long as the sites keep their keys.
import { inRing } from "./spatial.mjs";
import { nearestOnPolyline } from "./local-geometry.mjs";

export const SELECTION_SCHEMA = "transitline.station-selection/1";
export const KINDS = Object.freeze(["station", "entrance", "transfer", "workArea"]);

export const createStationSelection = () => ({ stationSiteId: null, entranceIds: [], transferIds: [], workAreaId: null });
export const cloneSelection = (sel) => structuredClone(sel);
export const isEmptySelection = (sel) => sel.stationSiteId === null;

const sorted = (list) => [...new Set(list)].sort();
const siteOf = (exp, id) => exp?.sites?.find((s) => s.stationSiteId === id) ?? null;
const ITEMS = {
  entrance: (s) => s.entranceCandidates.map((e) => e.entranceId),
  transfer: (s) => s.transferCandidates.map((t) => t.transferId),
  workArea: (s) => s.workAreaCandidates.map((w) => w.workAreaId),
};
// The site that owns an item id (ids are hashes that include the site id, so they do not collide across sites).
const ownerOf = (exp, kind, id) => exp?.sites?.find((s) => ITEMS[kind](s).includes(id)) ?? null;

export function clearSelection(sel) {
  Object.assign(sel, createStationSelection());
  return sel;
}

function switchSite(sel, siteId) {
  if (sel.stationSiteId !== siteId) Object.assign(sel, createStationSelection(), { stationSiteId: siteId }); // items belong to one site
}

// Applies one pick. `additive` (shift / ctrl) toggles an entrance or passage instead of replacing the choice.
// Returns false, changing nothing, when the id is not in the export.
export function selectItem(sel, exp, kind, id, { additive = false } = {}) {
  if (kind === "station") {
    if (!siteOf(exp, id)) return false;
    if (sel.stationSiteId === id) { if (!additive) Object.assign(sel, { entranceIds: [], transferIds: [], workAreaId: null }); }
    else switchSite(sel, id);
    return true;
  }
  if (!ITEMS[kind]) return false;
  const owner = ownerOf(exp, kind, id);
  if (!owner) return false;
  switchSite(sel, owner.stationSiteId);
  if (kind === "workArea") sel.workAreaId = sel.workAreaId === id ? null : id;
  else {
    const key = kind === "entrance" ? "entranceIds" : "transferIds";
    const has = sel[key].includes(id);
    sel[key] = additive ? sorted(has ? sel[key].filter((x) => x !== id) : [...sel[key], id]) : has && sel[key].length === 1 ? [] : [id];
  }
  return true;
}

// Drops whatever the export no longer has (a site deleted, an entrance removed). Returns the reasons, if any.
export function pruneSelection(sel, exp) {
  const warnings = [];
  if (sel.stationSiteId === null) return warnings;
  const site = siteOf(exp, sel.stationSiteId);
  if (!site) {
    warnings.push({ code: "selected-station-missing", stationSiteId: sel.stationSiteId });
    clearSelection(sel);
    return warnings;
  }
  const keep = (list, kind) => list.filter((id) => {
    if (ITEMS[kind](site).includes(id)) return true;
    warnings.push({ code: `selected-${kind}-missing`, id });
    return false;
  });
  sel.entranceIds = keep(sel.entranceIds, "entrance");
  sel.transferIds = keep(sel.transferIds, "transfer");
  if (sel.workAreaId !== null && !ITEMS.workArea(site).includes(sel.workAreaId)) { warnings.push({ code: "selected-workArea-missing", id: sel.workAreaId }); sel.workAreaId = null; }
  return warnings;
}

// The contract output. Only what the player chose, in a stable order; nothing derived from management state.
export function selectionOutput(sel, exp) {
  const site = sel.stationSiteId === null ? null : siteOf(exp, sel.stationSiteId);
  return {
    schema: SELECTION_SCHEMA,
    contractVersion: 1,
    packId: exp?.packId ?? null,
    stationSiteId: site ? sel.stationSiteId : null,
    selectedEntranceIds: site ? sorted(sel.entranceIds) : [],
    selectedTransferIds: site ? sorted(sel.transferIds) : [],
    selectedWorkAreaId: site ? sel.workAreaId : null,
    connectedPlanId: site?.connectedPlanId ?? null,
    connectedStationId: site?.connectedStationId ?? null,
  };
}

// Puts a saved output back, keeping only the parts the export still has.
export function restoreSelection(output, exp) {
  const sel = createStationSelection();
  if (output?.schema !== SELECTION_SCHEMA || output.contractVersion !== 1) return { selection: sel, warnings: [{ code: "selection-unreadable" }] };
  Object.assign(sel, { stationSiteId: output.stationSiteId ?? null, entranceIds: sorted(output.selectedEntranceIds ?? []), transferIds: sorted(output.selectedTransferIds ?? []), workAreaId: output.selectedWorkAreaId ?? null });
  return { selection: sel, warnings: pruneSelection(sel, exp) };
}

const HIT = Object.freeze({ entrancePx: 12, transferPx: 8, centrePx: 12 });

// What is under the pointer at screen point (x, y). Priority: entrance, transfer passage, work area, station body.
// `screen` maps [lon, lat] to canvas pixels. Returns { kind, id, stationSiteId } or null.
export function pickStationItem(exp, screen, x, y, px = HIT) {
  const p = [x, y];
  const nearer = (found, d, item) => (!found || d < found.d ? { d, ...item } : found);
  let entrance = null, transfer = null, work = null, body = null;
  for (const s of exp?.sites ?? []) {
    const [lx, ly] = screen(s.location);
    const dc = Math.hypot(lx - x, ly - y);
    const onBody = s.bodyPolygon ? inRing(p, s.bodyPolygon.map(screen)) || dc <= 6 : dc <= px.centrePx;
    // Zoomed out, a whole station is a few pixels wide: on the body, an entrance or passage must be nearer than the centre to win.
    for (const e of s.entranceCandidates) {
      const [ex, ey] = screen(e.location);
      const d = Math.hypot(ex - x, ey - y);
      if (d <= px.entrancePx && (!onBody || d < dc)) entrance = nearer(entrance, d, { kind: "entrance", id: e.entranceId, stationSiteId: s.stationSiteId });
    }
    for (const t of s.transferCandidates) {
      if (t.alignment.length < 2) continue;
      const d = nearestOnPolyline(p, t.alignment.map(screen)).d;
      if (d <= px.transferPx && (!onBody || d < dc)) transfer = nearer(transfer, d, { kind: "transfer", id: t.transferId, stationSiteId: s.stationSiteId });
    }
    for (const w of s.workAreaCandidates) {
      if (!inRing(p, w.polygon.map(screen))) continue;
      const [cx, cy] = screen(w.polygon[0]);
      work = nearer(work, Math.hypot(cx - x, cy - y), { kind: "workArea", id: w.workAreaId, stationSiteId: s.stationSiteId });
    }
    if (onBody) body = nearer(body, dc, { kind: "station", id: s.stationSiteId, stationSiteId: s.stationSiteId });
  }
  const found = entrance ?? transfer ?? work ?? body;
  return found ? { kind: found.kind, id: found.id, stationSiteId: found.stationSiteId } : null;
}

// A click: pick, apply, and clear the selection when the click lands on nothing (unless additive).
export function applyPick(sel, exp, pick, { additive = false } = {}) {
  if (!pick) { if (!additive) clearSelection(sel); return; }
  selectItem(sel, exp, pick.kind, pick.id, { additive });
}
