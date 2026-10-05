// Editing and saving what the player chose among the control candidates of a railway disruption. Pure data: the map
// only offers candidates (see railway-service-control.mjs); this document records which ones the player picked and the
// access points they stated. Carrying a choice out — running a turnback, suspending service, sending trains over
// another company's track — belongs to the management engine, which reads this document and decides for itself.
// The document is keyed by `eventId` (the id the engine gave the event) and stores candidate ids, so a choice keeps
// pointing at the same candidate when the player renames things, reorders them, saves and reopens. A control entry is
// never deleted, only deactivated and restored.

export const RAILWAY_SERVICE_CONTROL_DOC_VERSION = 1;
export const SELECTION_KINDS = Object.freeze(["turnback", "partialSuspension", "detour", "evacuation"]);
// the list of the control geometry each kind of choice is made from
const LIST_OF = Object.freeze({ turnback: "turnbackCandidates", partialSuspension: "partialSuspensionCandidates", detour: "detourCandidates", evacuation: "evacuationAccessCandidates" });
// a service can only be suspended between one pair of stations at a time; the other kinds may hold several choices
const SINGLE = Object.freeze({ turnback: false, partialSuspension: true, detour: false, evacuation: false });

export const newRailwayServiceControlDoc = (packId, packVersion = null) => ({ version: RAILWAY_SERVICE_CONTROL_DOC_VERSION, packId, packVersion, controls: [] });

const clone = (v) => structuredClone(v);
const emptySelected = () => Object.fromEntries(SELECTION_KINDS.map((k) => [k, []]));
const find = (doc, eventId) => {
  const entry = doc.controls.find((c) => c.eventId === eventId);
  if (!entry) throw new Error(`Unknown service control ${eventId}`);
  return entry;
};
const kindOf = (kind) => {
  if (!SELECTION_KINDS.includes(kind)) throw new Error(`Unknown selection kind ${kind}`);
  return kind;
};

// Starts the control entry of an event. An event that already has one keeps it.
export function addControl(doc, eventId) {
  if (!eventId) throw new Error("A service control needs an event id");
  const existing = doc.controls.find((c) => c.eventId === eventId);
  if (existing) return existing;
  const entry = { eventId, active: true, accessPoints: null, emergencyVehicleWidthMeters: null, selected: emptySelected() };
  doc.controls.push(entry);
  return entry;
}

// Records a choice. The candidate must be one the control geometry actually offers (the map never lets a made-up id in);
// the geometry revision it was chosen on is stored so a later change to the geometry can be seen.
export function selectCandidate(doc, eventId, kind, candidateId, control) {
  const entry = find(doc, eventId);
  const list = control?.[LIST_OF[kindOf(kind)]];
  if (!Array.isArray(list)) throw new Error(`The control geometry has no ${LIST_OF[kind]} to choose from`);
  if (!list.some((c) => c.candidateId === candidateId)) throw new Error(`Unknown ${kind} candidate ${candidateId}`);
  const chosen = entry.selected[kind].filter((s) => s.candidateId !== candidateId && !SINGLE[kind]);
  chosen.push({ candidateId, designedControlGeometryRevision: control.controlGeometryRevision });
  entry.selected[kind] = chosen.sort((a, b) => (a.candidateId < b.candidateId ? -1 : 1));
  return entry;
}
export function deselectCandidate(doc, eventId, kind, candidateId) {
  const entry = find(doc, eventId);
  entry.selected[kindOf(kind)] = entry.selected[kind].filter((s) => s.candidateId !== candidateId);
  return entry;
}
// clears the choices of one kind, or of all kinds
export function clearSelection(doc, eventId, kind = null) {
  const entry = find(doc, eventId);
  if (kind === null) entry.selected = emptySelected();
  else entry.selected[kindOf(kind)] = [];
  return entry;
}

// What the player's choices are now: still offered (and on which revision), or no longer offered by the geometry.
export function reconcileSelections(doc, eventId, control) {
  const entry = find(doc, eventId);
  const current = [];
  const stale = [];
  for (const kind of SELECTION_KINDS) {
    for (const s of entry.selected[kind]) {
      const offered = control?.[LIST_OF[kind]]?.some((c) => c.candidateId === s.candidateId) ?? false;
      if (!offered) stale.push({ kind, candidateId: s.candidateId, reason: "candidate-no-longer-offered" });
      else current.push({ kind, candidateId: s.candidateId, outdated: s.designedControlGeometryRevision !== control.controlGeometryRevision });
    }
  }
  return { current, stale };
}

// The access points the player states (an entrance, a road access), with a road width only if they know one.
export function addAccessPoint(doc, eventId, point) {
  const entry = find(doc, eventId);
  entry.accessPoints = [...(entry.accessPoints ?? []), clone({ basis: "player", ...point })];
  return entry;
}
export function removeAccessPoint(doc, eventId, key) {
  const entry = find(doc, eventId);
  if (entry.accessPoints === null) return entry;
  entry.accessPoints = entry.accessPoints.filter((p) => p.key !== key);
  return entry;
}
export function setEmergencyVehicleWidth(doc, eventId, meters) {
  const entry = find(doc, eventId);
  entry.emergencyVehicleWidthMeters = Number.isFinite(meters) && meters > 0 ? meters : null;
  return entry;
}

// An entry is switched off, never deleted: it keeps its id, its choices and its access points, and comes back as it was.
export function deactivateControl(doc, eventId) { const c = find(doc, eventId); c.active = false; return c; }
export function restoreControl(doc, eventId) { const c = find(doc, eventId); c.active = true; return c; }
export const activeControls = (doc) => doc.controls.filter((c) => c.active !== false);

// The input of buildRailwayServiceControl (the choices are for the management engine and the view, not for the geometry).
export const toControlDocument = ({ eventId, active, accessPoints, emergencyVehicleWidthMeters }) => clone({ eventId, active, accessPoints, emergencyVehicleWidthMeters });
// The choices of every active entry: { [eventId]: { turnback: [candidateId], ... } }
export const selectionsOf = (doc) => Object.fromEntries(activeControls(doc).map((c) => [c.eventId, Object.fromEntries(SELECTION_KINDS.map((k) => [k, c.selected[k].map((s) => s.candidateId)]))]));

export const serializeRailwayServiceControlDoc = (doc) => JSON.stringify({ version: doc.version, packId: doc.packId, packVersion: doc.packVersion, controls: doc.controls });

// Never applies a saved document to the wrong pack, and never hides a pack version change.
export function restoreRailwayServiceControlDoc(text, pack) {
  const packId = pack.manifest?.id ?? "pack";
  const packVersion = pack.manifest?.version ?? null;
  const fresh = newRailwayServiceControlDoc(packId, packVersion);
  if (text === null || text === undefined) return { doc: fresh, warnings: [] };
  let saved;
  try { saved = JSON.parse(text); } catch { return { doc: fresh, warnings: [{ code: "railway-service-control-doc-unreadable" }] }; }
  if (saved?.version !== RAILWAY_SERVICE_CONTROL_DOC_VERSION || !Array.isArray(saved.controls)) return { doc: fresh, warnings: [{ code: "railway-service-control-doc-version", version: saved?.version ?? null }] };
  if (saved.packId !== packId) return { doc: fresh, warnings: [{ code: "railway-service-control-doc-other-pack", savedPackId: saved.packId }] };
  const warnings = saved.packVersion !== packVersion ? [{ code: "pack-version-mismatch", saved: saved.packVersion, current: packVersion }] : [];
  return { doc: { ...fresh, controls: saved.controls }, warnings };
}
