// External rail technical specification: pure, sourced technical facts about one line of an existing (external)
// network, for the management engine (see docs/external-rail-technical-specification-contract.md).
// It states what a named source says — gauge, electrification, loading gauge, signalling, platform, formation,
// maintenance system, infrastructure owner — and nothing else. Whether a vehicle can run there, what a change would
// cost, approvals, contracts and every possible / conditional / impossible verdict belong to the management engine
// (technical-compatibility.mjs). This module never imports it.
//
// Missing data: a value no source states is `null`, its name is in `unknown[]` and the reason is in
// `unknownReasons` — never 0, never false, never [] and never a "typical Japanese railway" default. Two sources that
// disagree give `null` plus a conflict, not a pick. An owner is only ever a value a source (or the network data)
// states; it is never inferred from an operator tag.
import { stableId } from "./ids.mjs";
import { qualityOf, worse } from "./local-geometry.mjs";

export const EXTERNAL_RAIL_SPEC_SCHEMA = "transitline.external-rail-technical-specification/1";
export const EXTERNAL_RAIL_SPEC_EXPORT_SCHEMA = "transitline.external-rail-technical-specification-export/1";
export const EXTERNAL_INFRASTRUCTURE_CATALOG_SCHEMA = "transitline.external-infrastructure-catalog/1";
export const EXTERNAL_RAIL_SPEC_DOC_VERSION = 1;

// The technical facts, in the order the management engine's technicalSpecification reads them.
export const TECHNICAL_FACT_FIELDS = Object.freeze([
  "runningSystemId", "gaugeMm", "carWidthM", "maxAxleLoadTonnes", "collectionSystemId", "currentSystem", "voltageV",
  "minimumCurveRadiusMeters", "maxGradientPermille", "signalSystemIds", "platformHeightMm", "doorLayoutId", "minCars", "maxCars", "maintenanceSystemId",
]);
// Stated only when a source says so; never derived by the map.
export const IDENTITY_FIELDS = Object.freeze(["infrastructureOwnerId", "technicalProfileId", "status", "capacityTrainsPerHour"]);
const ALL_FIELDS = Object.freeze([...TECHNICAL_FACT_FIELDS, ...IDENTITY_FIELDS]);
// Fields that count towards dataQuality: the optional trio (profile, status, capacity) are often simply not published.
const QUALITY_FIELDS = Object.freeze([...TECHNICAL_FACT_FIELDS, "infrastructureOwnerId"]);
// A source may declare a field "does not apply" (a rubber-tyre guideway has no track gauge). That is a statement, not a gap.
export const NOT_APPLICABLE_FIELDS = Object.freeze(["gaugeMm"]);
export const SOURCE_KINDS = Object.freeze(["survey", "operator-publication", "government-dataset", "community-dataset", "synthetic-fixture"]);
const QUALITIES = Object.freeze(["high", "medium", "low"]);

const isText = (v) => typeof v === "string" && v.trim() !== "";
const FIELD_CHECKS = {
  string: (v) => (isText(v) ? { value: v } : null),
  positive: (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? { value: v } : null),
  nonNegative: (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? { value: v } : null),
  count: (v) => (Number.isInteger(v) && v >= 1 ? { value: v } : null),
  // an empty list is "no signalling system stated", which is unknown, not "none": it is rejected, not kept as []
  list: (v) => (Array.isArray(v) && v.length > 0 && v.every(isText) ? { value: [...new Set(v)].sort() } : null),
};
const FIELD_KIND = Object.freeze({
  runningSystemId: "string", gaugeMm: "positive", carWidthM: "positive", maxAxleLoadTonnes: "positive", collectionSystemId: "string", currentSystem: "string",
  voltageV: "positive", minimumCurveRadiusMeters: "positive", maxGradientPermille: "nonNegative", signalSystemIds: "list", platformHeightMm: "positive",
  doorLayoutId: "string", minCars: "count", maxCars: "count", maintenanceSystemId: "string",
  infrastructureOwnerId: "string", technicalProfileId: "string", status: "string", capacityTrainsPerHour: "positive",
});

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const byCode = (a, b) => { const x = JSON.stringify([a.code, a]); const y = JSON.stringify([b.code, b]); return x < y ? -1 : x > y ? 1 : 0; };
export const externalLineKey = (externalNetworkId, externalLineId) => `${externalNetworkId}\u001f${externalLineId}`;
// One specification per external line of a pack: the id follows the line, so renaming or reordering changes nothing.
export const externalRailSpecificationId = (packId, externalNetworkId, externalLineId) => stableId("external-rail-spec", packId, externalNetworkId, externalLineId);

// Validates one drawn source. Returns the normalised source, or null — an invalid source contributes no facts.
function normaliseSource(raw, warnings) {
  const problems = [];
  const sourceId = isText(raw?.sourceId) ? raw.sourceId : null;
  if (!sourceId) problems.push("sourceId");
  if (!SOURCE_KINDS.includes(raw?.kind)) problems.push("kind");
  if (!isText(raw?.name)) problems.push("name");
  if (!isText(raw?.license)) problems.push("license");
  if (raw?.quality !== undefined && raw?.quality !== null && !QUALITIES.includes(raw.quality)) problems.push("quality");
  if (problems.length) { warnings.push({ code: "source-invalid", sourceId, problems }); return null; }

  const facts = new Map();
  const invalid = new Set();
  const stated = raw.facts && typeof raw.facts === "object" ? raw.facts : {};
  for (const field of Object.keys(stated).sort()) {
    if (!ALL_FIELDS.includes(field)) { warnings.push({ code: "unknown-fact-field", sourceId, field }); continue; }
    if (stated[field] === null || stated[field] === undefined) continue; // an explicit null states nothing
    const checked = FIELD_CHECKS[FIELD_KIND[field]](stated[field]);
    if (!checked) { invalid.add(field); warnings.push({ code: "invalid-value", sourceId, field }); } else facts.set(field, checked.value);
  }
  if (facts.has("minCars") && facts.has("maxCars") && facts.get("minCars") > facts.get("maxCars")) {
    for (const field of ["minCars", "maxCars"]) { facts.delete(field); invalid.add(field); }
    warnings.push({ code: "cars-range-invalid", sourceId });
  }
  const notApplicable = new Set();
  for (const field of Array.isArray(raw.notApplicable) ? raw.notApplicable : []) {
    if (NOT_APPLICABLE_FIELDS.includes(field)) notApplicable.add(field);
    else warnings.push({ code: "not-applicable-field-invalid", sourceId, field: String(field) });
  }
  return {
    sourceId, kind: raw.kind, name: raw.name, license: raw.license,
    attribution: isText(raw.attribution) ? raw.attribution : null,
    reference: isText(raw.reference) ? raw.reference : null,
    note: isText(raw.note) ? raw.note : null,
    // a synthetic fixture is never better than "low"; a source that does not say how good it is counts as "low"
    quality: raw.kind === "synthetic-fixture" ? "low" : raw.quality ?? "low",
    facts, invalid, notApplicable,
  };
}

// entry: { externalNetworkId, externalLineId, name?, sources: [{ sourceId, kind, name, license, attribution?, reference?, note?, quality?,
//          facts: { <technical fact fields>, infrastructureOwnerId?, technicalProfileId?, status?, capacityTrainsPerHour? }, notApplicable?: ["gaugeMm"] }] }
// ctx:   { pack, externalNetworks }  -> { specification, warnings }; specification is null when the entry cannot be built.
export function buildExternalRailSpecification(entry, ctx) {
  const packId = ctx.pack.manifest?.id ?? "pack";
  const license = { pack: ctx.pack.manifest?.data?.license ?? null, attribution: ctx.pack.manifest?.data?.attribution ?? [] };
  const reject = (code, extra = {}) => ({ specification: null, warnings: [{ code, externalNetworkId: entry?.externalNetworkId ?? null, externalLineId: entry?.externalLineId ?? null, ...extra }] });
  if (!isText(entry?.externalNetworkId) || !isText(entry?.externalLineId)) return reject("spec-entry-invalid", { problem: "externalNetworkId and externalLineId are required" });
  if (!Array.isArray(entry.sources)) return reject("spec-entry-invalid", { problem: "sources must be a list" });
  const net = (ctx.externalNetworks ?? []).find((n) => n.id === entry.externalNetworkId);
  if (!net) return reject("external-network-unresolved");
  const line = net.lines.find((l) => l.id === entry.externalLineId);
  if (!line) return reject("external-line-unresolved");

  const warnings = [];
  const ids = entry.sources.map((s) => s?.sourceId).filter(isText);
  if (new Set(ids).size !== ids.length) return reject("duplicate-source-id", { sourceIds: [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))].sort() });
  const sources = entry.sources.map((raw) => normaliseSource(raw, warnings)).filter(Boolean);
  // The network data may itself state an owner; the operator tag never counts as one.
  const networkOwner = isText(line.infrastructureOwnerId) ? line.infrastructureOwnerId : isText(net.infrastructureOwnerId) ? net.infrastructureOwnerId : null;
  if (networkOwner !== null) {
    sources.push({ sourceId: `external-network:${net.id}`, kind: "government-dataset", name: `CityPack existing network (${net.id})`, license: license.pack ?? "unspecified",
      attribution: null, reference: null, note: "owner stated by the pack's own network data", quality: net.dataQuality ?? "low", facts: new Map([["infrastructureOwnerId", networkOwner]]), invalid: new Set(), notApplicable: new Set() });
  }
  sources.sort((a, b) => (a.sourceId < b.sourceId ? -1 : 1));

  const values = {};
  const unknownReasons = {};
  const fieldSources = {};
  const conflicts = [];
  const notApplicable = [];
  for (const field of ALL_FIELDS) {
    const stating = sources.filter((s) => s.facts.has(field));
    const declaring = sources.filter((s) => s.notApplicable.has(field));
    const distinct = [];
    for (const s of stating) if (!distinct.some((v) => same(v, s.facts.get(field)))) distinct.push(s.facts.get(field));
    values[field] = null;
    if (declaring.length && !stating.length) {
      notApplicable.push(field);
      fieldSources[field] = declaring.map((s) => s.sourceId);
    } else if (declaring.length || distinct.length > 1) {
      const rows = [...stating.map((s) => ({ sourceId: s.sourceId, value: s.facts.get(field) })), ...declaring.map((s) => ({ sourceId: s.sourceId, value: "not-applicable" }))]
        .sort((a, b) => (a.sourceId < b.sourceId ? -1 : 1));
      conflicts.push({ field, values: rows });
      warnings.push({ code: "source-values-conflict", field, sourceIds: rows.map((r) => r.sourceId) });
      unknownReasons[field] = "conflicting-sources";
    } else if (distinct.length === 1) {
      values[field] = distinct[0];
      fieldSources[field] = stating.map((s) => s.sourceId);
    } else if (sources.some((s) => s.invalid.has(field))) unknownReasons[field] = "invalid-value";
    else unknownReasons[field] = sources.length === 0 ? "no-source" : "no-attribute";
  }
  if (values.minCars !== null && values.maxCars !== null && values.minCars > values.maxCars) {
    warnings.push({ code: "cars-range-invalid", sourceId: null });
    for (const field of ["minCars", "maxCars"]) { values[field] = null; unknownReasons[field] = "conflicting-sources"; delete fieldSources[field]; }
  }

  const unknown = ALL_FIELDS.filter((f) => f in unknownReasons);
  const technicalSpecification = Object.fromEntries(TECHNICAL_FACT_FIELDS.map((f) => [f, values[f]]));
  const specificationId = externalRailSpecificationId(packId, net.id, line.id);
  // The revision follows the facts only: a rename, a re-ordering or a changed source name leaves it alone.
  const specificationRevision = stableId("external-rail-spec-revision", specificationId, JSON.stringify({
    technicalSpecification, infrastructureOwnerId: values.infrastructureOwnerId, technicalProfileId: values.technicalProfileId,
    status: values.status, capacityTrainsPerHour: values.capacityTrainsPerHour, notApplicable, conflicts,
  }));
  const contributing = sources.filter((s) => s.facts.size || s.notApplicable.size);
  return {
    specification: {
      schema: EXTERNAL_RAIL_SPEC_SCHEMA,
      contractVersion: 1,
      specificationId,
      specificationRevision,
      externalNetworkId: net.id,
      externalLineId: line.id,
      sourcePackId: packId,
      sourcePackVersion: ctx.pack.manifest?.version ?? null,
      name: entry.name ?? null,
      infrastructureOwnerId: values.infrastructureOwnerId,
      technicalProfileId: values.technicalProfileId,
      technicalSpecification,
      status: values.status,
      capacityTrainsPerHour: values.capacityTrainsPerHour,
      notApplicable,
      fieldSources,
      conflicts,
      // a specification with any unknown never reads "high"; its sources' own quality can only lower it further
      dataQuality: contributing.reduce((q, s) => worse(q, s.quality), qualityOf(QUALITY_FIELDS.filter((f) => f in unknownReasons).length)),
      unknown,
      unknownReasons,
      warnings: warnings.sort(byCode),
      sources: sources.map((s) => ({
        sourceId: s.sourceId, kind: s.kind, name: s.name, license: s.license, attribution: s.attribution, reference: s.reference, note: s.note, quality: s.quality,
        facts: ALL_FIELDS.filter((f) => s.facts.has(f)), notApplicable: [...s.notApplicable].sort(),
      })),
      license,
    },
    warnings,
  };
}

// externalNetworks: the ExternalNetwork list of buildMapExport. Entries are checked against its ids.
// Two entries for one line are not merged or picked between: both are refused (which one "wins" would depend on order).
export function buildExternalRailSpecificationExport({ pack, externalNetworks = [], specifications = [] }) {
  const warnings = [];
  const groups = new Map();
  for (const entry of specifications) {
    const key = externalLineKey(entry?.externalNetworkId, entry?.externalLineId);
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  const built = new Map();
  for (const entries of groups.values()) {
    if (entries.length > 1) {
      warnings.push({ code: "duplicate-external-line-specification", externalNetworkId: entries[0]?.externalNetworkId ?? null, externalLineId: entries[0]?.externalLineId ?? null, names: entries.map((e) => e?.name ?? null).sort() });
      continue;
    }
    const { specification, warnings: why } = buildExternalRailSpecification(entries[0], { pack, externalNetworks });
    if (!specification) warnings.push({ code: "external-rail-specification-rejected", reasons: why });
    else built.set(specification.specificationId, specification);
  }
  return {
    schema: EXTERNAL_RAIL_SPEC_EXPORT_SCHEMA,
    packId: pack.manifest?.id ?? "pack",
    packVersion: pack.manifest?.version ?? null,
    specifications: [...built.values()].sort((a, b) => (a.specificationId < b.specificationId ? -1 : 1)),
    warnings: warnings.sort(byCode),
  };
}

// Joins the external legs of ThroughRouteGeometry routes to their specifications by externalNetworkId + externalLineId.
// An entry carries only sourced facts and the keys to link on; a leg without a specification is listed, never filled in.
// routeExport: the result of buildThroughRouteExport (or { routes: [...] }).
export function buildExternalInfrastructureCatalog({ specificationExport, routeExport }) {
  const warnings = [];
  const entries = [];
  const unmatchedLegIds = [];
  const byLine = new Map(specificationExport.specifications.map((s) => [externalLineKey(s.externalNetworkId, s.externalLineId), s]));
  for (const route of routeExport.routes ?? []) {
    if (route.sourcePackId !== specificationExport.packId) { warnings.push({ code: "route-other-pack", throughRouteId: route.throughRouteId, routePackId: route.sourcePackId ?? null }); continue; }
    for (const leg of route.legs.filter((l) => l.sourceKind === "external")) {
      const spec = byLine.get(externalLineKey(leg.externalNetworkId, leg.externalLineId));
      if (!spec) { unmatchedLegIds.push(leg.legId); continue; }
      let owner = spec.infrastructureOwnerId ?? leg.infrastructureOwnerId ?? null;
      if (spec.infrastructureOwnerId !== null && leg.infrastructureOwnerId !== null && spec.infrastructureOwnerId !== leg.infrastructureOwnerId) {
        owner = null;
        warnings.push({ code: "leg-owner-conflicts-specification", legId: leg.legId, leg: leg.infrastructureOwnerId, specification: spec.infrastructureOwnerId });
      }
      entries.push({
        legId: leg.legId,
        throughRouteId: route.throughRouteId,
        routeGeometryRevision: route.geometryRevision ?? null,
        externalNetworkId: leg.externalNetworkId,
        externalLineId: leg.externalLineId,
        specificationId: spec.specificationId,
        specificationRevision: spec.specificationRevision,
        infrastructureOwnerId: owner,
        technicalProfileId: spec.technicalProfileId,
        technicalSpecification: structuredClone(spec.technicalSpecification),
        notApplicable: [...spec.notApplicable],
        status: spec.status,
        capacityTrainsPerHour: spec.capacityTrainsPerHour,
        unknown: [...spec.unknown],
        unknownReasons: { ...spec.unknownReasons },
      });
    }
  }
  return {
    schema: EXTERNAL_INFRASTRUCTURE_CATALOG_SCHEMA,
    packId: specificationExport.packId,
    packVersion: specificationExport.packVersion,
    entries: entries.sort((a, b) => (a.legId < b.legId ? -1 : 1)),
    unmatchedLegIds: unmatchedLegIds.sort(),
    warnings: warnings.sort(byCode),
  };
}

// --- saved specifications: a document of what was entered; an entry keeps its line for life ---
export const newExternalRailSpecificationDoc = (packId, packVersion = null) => ({ version: EXTERNAL_RAIL_SPEC_DOC_VERSION, packId, packVersion, specifications: [] });

export const serializeExternalRailSpecificationDoc = (doc) => JSON.stringify({ version: doc.version, packId: doc.packId, packVersion: doc.packVersion, specifications: doc.specifications });

// Never applies a saved document to the wrong pack, and never hides a pack version change.
export function restoreExternalRailSpecificationDoc(text, pack) {
  const packId = pack.manifest?.id ?? "pack";
  const packVersion = pack.manifest?.version ?? null;
  const fresh = newExternalRailSpecificationDoc(packId, packVersion);
  if (text === null || text === undefined) return { doc: fresh, warnings: [] };
  let saved;
  try { saved = JSON.parse(text); } catch { return { doc: fresh, warnings: [{ code: "external-rail-spec-doc-unreadable" }] }; }
  if (saved?.version !== EXTERNAL_RAIL_SPEC_DOC_VERSION || !Array.isArray(saved.specifications)) return { doc: fresh, warnings: [{ code: "external-rail-spec-doc-version", version: saved?.version ?? null }] };
  if (saved.packId !== packId) return { doc: fresh, warnings: [{ code: "external-rail-spec-doc-other-pack", savedPackId: saved.packId }] };
  const warnings = saved.packVersion !== packVersion ? [{ code: "pack-version-mismatch", saved: saved.packVersion, current: packVersion }] : [];
  return { doc: { ...fresh, specifications: saved.specifications }, warnings };
}
