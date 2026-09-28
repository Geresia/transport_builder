// Editing and saving construction work packages. Pure data: a document of how the player split a plan's segments
// into tunnel / cut-and-cover / viaduct / systems packages, plus station and depot packages. A package keeps its
// `key` for life (reassign a segment, split, merge, delete, restore, save, reopen), so its constructionSiteId never
// changes; deleting only tombstones it, so restoring brings back the same id and nothing else can take its key.
export const CONSTRUCTION_DOC_VERSION = 1;

export const newConstructionDoc = (packId, packVersion = null) => ({ version: CONSTRUCTION_DOC_VERSION, packId, packVersion, packages: [] });

// Packages that take part in the export (deleted ones stay in the document, not in the output).
export const activePackages = (doc) => doc.packages.filter((p) => !p.deleted);

// Smallest unused "package-N", counting deleted packages too: a key is never handed out twice.
export function nextPackageKey(doc) {
  const used = new Set(doc.packages.map((p) => p.key));
  let n = 1;
  while (used.has(`package-${n}`)) n++;
  return `package-${n}`;
}

// pkg: { name?, kind, planId?, segmentIds?: string[], stationId?, depotSiteId? }
export function addPackage(doc, pkg) {
  const value = { key: nextPackageKey(doc), name: null, kind: null, planId: null, segmentIds: [], stationId: null, depotSiteId: null, deleted: false, ...structuredClone(pkg) };
  doc.packages.push(value);
  return value;
}

const find = (doc, key) => {
  const pkg = doc.packages.find((p) => p.key === key);
  if (!pkg) throw new Error(`Unknown construction package ${key}`);
  return pkg;
};

export function updatePackage(doc, key, patch) {
  return Object.assign(find(doc, key), structuredClone(patch));
}

export function removePackage(doc, key) { find(doc, key).deleted = true; }
export function restorePackage(doc, key) { find(doc, key).deleted = false; }

// Moves one segment across a boundary between two line-kind packages of the same plan ("이동"): it leaves `fromKey`
// and joins `toKey`. Whether the result stays a contiguous run is for the caller (buildConstructionSite warns if not).
export function reassignSegment(doc, fromKey, toKey, segmentId) {
  const from = find(doc, fromKey);
  const to = find(doc, toKey);
  if (from.planId !== to.planId) throw new Error("Packages are on different plans");
  if (!from.segmentIds.includes(segmentId)) throw new Error(`Segment ${segmentId} is not in package ${fromKey}`);
  from.segmentIds = from.segmentIds.filter((id) => id !== segmentId);
  if (!to.segmentIds.includes(segmentId)) to.segmentIds = [...to.segmentIds, segmentId];
  return { from, to };
}

// Splits a package's segment run into two at `atSegmentId`, which becomes the first segment of the new package
// ("분할"). `order` is the plan's segment ids end to end (plan.segments.map(s => s.id)) so the split follows the
// drawn direction, not array order; the new package gets a fresh key and so a fresh id.
export function splitPackage(doc, key, atSegmentId, order) {
  const p = find(doc, key);
  const ids = order.filter((id) => p.segmentIds.includes(id));
  const i = ids.indexOf(atSegmentId);
  if (i <= 0) throw new Error("Split point must be an interior segment of the package");
  p.segmentIds = ids.slice(0, i);
  const created = addPackage(doc, { name: p.name ? `${p.name} (2)` : null, kind: p.kind, planId: p.planId, segmentIds: ids.slice(i) });
  return { first: p, second: created };
}

// Merges b's segments into a and removes b outright ("병합"): b's identity does not persist through a merge, so
// unlike delete there is nothing to restore it from. Both must be the same kind, on the same plan.
export function mergePackages(doc, keyA, keyB, order) {
  const a = find(doc, keyA);
  const b = find(doc, keyB);
  if (a.planId !== b.planId || a.kind !== b.kind) throw new Error("Only two packages of the same kind and plan can merge");
  const merged = new Set([...a.segmentIds, ...b.segmentIds]);
  a.segmentIds = order.filter((id) => merged.has(id));
  doc.packages = doc.packages.filter((p) => p.key !== keyB);
  return a;
}

export const serializeConstructionDoc = (doc) => JSON.stringify({ version: doc.version, packId: doc.packId, packVersion: doc.packVersion, packages: doc.packages });

// Never applies a saved document to the wrong pack, and never hides a pack version change.
export function restoreConstructionDoc(text, pack) {
  const packId = pack.manifest?.id ?? "pack";
  const packVersion = pack.manifest?.version ?? null;
  const fresh = newConstructionDoc(packId, packVersion);
  if (text === null || text === undefined) return { doc: fresh, warnings: [] };
  let saved;
  try { saved = JSON.parse(text); } catch { return { doc: fresh, warnings: [{ code: "construction-doc-unreadable" }] }; }
  if (saved?.version !== CONSTRUCTION_DOC_VERSION || !Array.isArray(saved.packages)) return { doc: fresh, warnings: [{ code: "construction-doc-version", version: saved?.version ?? null }] };
  if (saved.packId !== packId) return { doc: fresh, warnings: [{ code: "construction-doc-other-pack", savedPackId: saved.packId }] };
  const warnings = saved.packVersion !== packVersion ? [{ code: "pack-version-mismatch", saved: saved.packVersion, current: packVersion }] : [];
  return { doc: { ...fresh, packages: saved.packages }, warnings };
}
