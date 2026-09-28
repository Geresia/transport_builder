// Construction-site candidate selection, core: picking one shaft / work area / material yard / construction-road
// access point / vehicle-delivery point from a ConstructionExport, and the plain output the UI hands on — the
// candidate's id and its own spatial facts, nothing else. Pure data and geometry over the export: it never changes
// the export, the packages or any management state, and computes nothing about cost, duration, score, method or
// compensation. Ids come from the export, so a selection survives a save and reopen as long as packages keep keys.
import { inRing } from "./spatial.mjs";

export const CONSTRUCTION_SELECTION_SCHEMA = "transitline.construction-selection/1";
export const CANDIDATE_KINDS = Object.freeze(["shaft", "workArea", "materialYard", "accessRoad", "vehicleAccess"]);
const ID_FIELD = { shaft: "shaftId", workArea: "workAreaId", materialYard: "materialYardId", accessRoad: "roadAccessId", vehicleAccess: "vehicleAccessId" };
const LIST_FIELD = { shaft: "shaftCandidates", workArea: "workAreaCandidates", materialYard: "materialYardCandidates", accessRoad: "accessRoadCandidates", vehicleAccess: "vehicleAccessCandidates" };

export const createConstructionSelection = () => ({ constructionSiteId: null, kind: null, candidateId: null });
export const cloneConstructionSelection = (sel) => structuredClone(sel);
export const isEmptyConstructionSelection = (sel) => sel.candidateId === null;

function findCandidate(exp, kind, id) {
  for (const site of exp?.sites ?? []) {
    const item = (site[LIST_FIELD[kind]] ?? []).find((c) => c[ID_FIELD[kind]] === id);
    if (item) return { site, item };
  }
  return null;
}

export function clearConstructionSelection(sel) {
  Object.assign(sel, createConstructionSelection());
  return sel;
}

// One candidate at a time: picking a new one replaces the old, picking the same one again clears it.
// Returns false, changing nothing, when the id is not in the export.
export function selectConstructionCandidate(sel, exp, kind, id) {
  if (!CANDIDATE_KINDS.includes(kind)) return false;
  const found = findCandidate(exp, kind, id);
  if (!found) return false;
  if (sel.kind === kind && sel.candidateId === id) { clearConstructionSelection(sel); return true; }
  Object.assign(sel, { constructionSiteId: found.site.constructionSiteId, kind, candidateId: id });
  return true;
}

// Drops the selection if the export no longer has it (a package deleted, a candidate regenerated). Returns why, if so.
export function pruneConstructionSelection(sel, exp) {
  if (sel.candidateId === null) return [];
  if (findCandidate(exp, sel.kind, sel.candidateId)) return [];
  const warning = { code: "selected-candidate-missing", kind: sel.kind, candidateId: sel.candidateId };
  clearConstructionSelection(sel);
  return [warning];
}

// The candidate's own fields, minus its id key (which is already the output's candidateId).
function facts(kind, item) {
  const { [ID_FIELD[kind]]: _id, ...rest } = item;
  return rest;
}

// The contract output: the candidate's id and its own spatial facts. Nothing derived from management state.
export function constructionSelectionOutput(sel, exp) {
  const found = sel.candidateId === null ? null : findCandidate(exp, sel.kind, sel.candidateId);
  return {
    schema: CONSTRUCTION_SELECTION_SCHEMA,
    contractVersion: 1,
    packId: exp?.packId ?? null,
    constructionSiteId: found ? sel.constructionSiteId : null,
    kind: found ? sel.kind : null,
    candidateId: found ? sel.candidateId : null,
    facts: found ? facts(sel.kind, found.item) : null,
  };
}

// Puts a saved output back, keeping it only if the export still has that candidate.
export function restoreConstructionSelection(output, exp) {
  const sel = createConstructionSelection();
  if (output?.schema !== CONSTRUCTION_SELECTION_SCHEMA || output.contractVersion !== 1) return { selection: sel, warnings: [{ code: "selection-unreadable" }] };
  if (output.candidateId === null) return { selection: sel, warnings: [] };
  Object.assign(sel, { constructionSiteId: output.constructionSiteId ?? null, kind: output.kind ?? null, candidateId: output.candidateId ?? null });
  return { selection: sel, warnings: pruneConstructionSelection(sel, exp) };
}

const HIT = Object.freeze({ pointPx: 12 });

// What is under the pointer. Priority: shaft, construction-road access, vehicle access (all points), then
// work area, material yard (polygons — the nearer centroid wins on overlap). `screen` maps [lon, lat] to pixels.
export function pickConstructionCandidate(exp, screen, x, y, px = HIT) {
  const p = [x, y];
  let point = null, area = null;
  for (const site of exp?.sites ?? []) {
    for (const kind of ["shaft", "accessRoad", "vehicleAccess"]) {
      for (const item of site[LIST_FIELD[kind]] ?? []) {
        const [ix, iy] = screen(item.location);
        const d = Math.hypot(ix - x, iy - y);
        if (d <= px.pointPx && (!point || d < point.d)) point = { d, kind, id: item[ID_FIELD[kind]], constructionSiteId: site.constructionSiteId };
      }
    }
    for (const kind of ["workArea", "materialYard"]) {
      for (const item of site[LIST_FIELD[kind]] ?? []) {
        if (!inRing(p, item.polygon.map(screen))) continue;
        const c = item.polygon.reduce((s, v) => [s[0] + v[0] / item.polygon.length, s[1] + v[1] / item.polygon.length], [0, 0]);
        const [cx, cy] = screen(c);
        const d = Math.hypot(cx - x, cy - y);
        if (!area || d < area.d) area = { d, kind, id: item[ID_FIELD[kind]], constructionSiteId: site.constructionSiteId };
      }
    }
  }
  const found = point ?? area;
  return found ? { kind: found.kind, id: found.id, constructionSiteId: found.constructionSiteId } : null;
}

export function applyConstructionPick(sel, exp, pick) {
  if (!pick) { clearConstructionSelection(sel); return; }
  selectConstructionCandidate(sel, exp, pick.kind, pick.id);
}
