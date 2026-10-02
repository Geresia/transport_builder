// Through-route geometry: pure spatial facts for the management engine (see docs/through-route-contract.md).
// Which legs a through service runs over, in what order, where one leg hands over to the next, and whether the
// drawn track physically meets there. Nothing else: money, charges, capacity, schedule and any possible /
// conditional / impossible verdict belong to the management engine. This module never imports it.
//
// Missing data: a value that cannot be known is `null`, its name is in `unknown[]` and the reason is in
// `unknownReasons` — never false, never 0, never a guess. In particular `physicalConnection: null` means
// "unknown", and an infrastructure owner is only ever a value the source data (or the caller, for built
// infrastructure) stated: it is never inferred from an operator tag, a name or the network a line belongs to.
import { haversineMetres } from "../projection.mjs";
import { stableId, round6, roundTo, coordKey } from "./ids.mjs";
import { qualityOf, worse } from "./local-geometry.mjs";

export const THROUGH_ROUTE_SCHEMA = "transitline.through-route-geometry/1";
export const THROUGH_ROUTE_EXPORT_SCHEMA = "transitline.through-route-export/1";
export const THROUGH_ROUTE_DOC_VERSION = 1;
export const SOURCE_KINDS = Object.freeze(["planned", "existing", "external"]);
// Endpoints of two drawn alignments closer than this but not the same point are "nearly joined": unknown, not false.
export const NEAR_ENDPOINT_METERS = 50;

const hasKey = (v) => v !== undefined && v !== null && v !== "";
const text = (v) => (typeof v === "string" && v.trim() !== "" ? v : null);
const refOf = (leg) => leg?.key ?? `${leg?.sourceKind ?? "?"}:${leg?.planId ?? leg?.externalLineId ?? "?"}`;
const layerKey = (l) => JSON.stringify(l);
const LEG_UNKNOWN_ORDER = ["infrastructureOwnerId", "segmentIds", "alignment", "lengthMeters"];

// A route the player saved has a key; its id follows the key, not the legs, so editing the legs keeps it.
export const keyedThroughRouteId = (packId, key) => stableId("through-route", packId, "key", key);

// Resolves one drawn leg against the map export. Returns { leg } or { error } — an unresolved leg is never guessed.
function resolveLeg(input, ctx) {
  const fail = (code, extra = {}) => ({ error: { code, leg: refOf(input), ...extra } });
  const kind = input?.sourceKind;
  if (!SOURCE_KINDS.includes(kind)) return fail("leg-source-kind-invalid", { value: kind ?? null });
  const ownerInput = text(input.infrastructureOwnerId);
  let stations; // the whole target's stations in their own order
  let target;
  let plan = null;
  let net = null;
  let line = null;
  if (kind === "external") {
    net = ctx.externalNetworks.find((n) => (!input.externalNetworkId || n.id === input.externalNetworkId) && n.lines.some((l) => l.id === input.externalLineId));
    line = net?.lines.find((l) => l.id === input.externalLineId);
    if (!line) return fail("leg-external-line-missing", { externalNetworkId: input.externalNetworkId ?? null, externalLineId: input.externalLineId ?? null });
    const located = new Map(net.stations.map((s) => [s.id, s.location]));
    stations = line.stationIds.map((id) => ({ id, location: located.get(id) ?? null }));
    if (stations.some((s) => s.location === null)) return fail("leg-station-missing", { externalLineId: line.id });
    target = `ext:${net.id}/${line.id}`;
  } else {
    plan = ctx.plans.find((p) => p.planId === input.planId);
    if (!plan) return fail("leg-plan-missing", { planId: input.planId ?? null });
    if (plan.sourcePackId !== ctx.packId) return fail("leg-plan-other-pack", { planId: plan.planId, planPackId: plan.sourcePackId ?? null });
    if (kind === "existing" && text(input.projectId) === null) return fail("leg-project-missing", { planId: plan.planId });
    stations = plan.stationCandidates.map((s) => ({ id: s.id, location: s.location }));
    target = `plan:${plan.planId}`;
  }

  const ids = stations.map((s) => s.id);
  const fromId = input.fromStationId ?? ids[0];
  const toId = input.toStationId ?? ids.at(-1);
  const i = ids.indexOf(fromId);
  const j = ids.indexOf(toId);
  if (i < 0 || j < 0) return fail("leg-station-missing", { fromStationId: fromId, toStationId: toId });
  if (i === j) return fail("leg-degenerate", { stationId: fromId });
  const step = j > i ? 1 : -1;
  const run = [];
  for (let k = i; k !== j + step; k += step) run.push(stations[k]);

  let segmentIds = [];
  let alignment = null;
  let lengthMeters = null;
  if (plan) {
    segmentIds = [];
    alignment = [];
    let total = 0;
    for (let k = 0; k + 1 < run.length; k++) {
      const forward = plan.segments.find((s) => s.from === run[k].id && s.to === run[k + 1].id);
      const backward = forward ? null : plan.segments.find((s) => s.from === run[k + 1].id && s.to === run[k].id);
      const seg = forward ?? backward;
      if (!seg) return fail("leg-segment-missing", { fromStationId: run[k].id, toStationId: run[k + 1].id });
      segmentIds.push(seg.id);
      total += seg.lengthMeters;
      const points = (backward ? [...seg.alignment].reverse() : seg.alignment).map(([lon, lat]) => [round6(lon), round6(lat)]);
      for (const p of points) if (!alignment.length || coordKey(alignment.at(-1)) !== coordKey(p)) alignment.push(p);
    }
    lengthMeters = roundTo(total, 1);
  }

  const warnings = [];
  // Owner: the source data's own statement wins; the caller's statement is used only when the source has none.
  const sourceOwner = line ? text(line.infrastructureOwnerId) ?? text(net.infrastructureOwnerId) : null;
  if (sourceOwner !== null && ownerInput !== null && ownerInput !== sourceOwner) warnings.push({ code: "owner-input-conflicts-source", leg: refOf(input), source: sourceOwner, input: ownerInput });
  const infrastructureOwnerId = sourceOwner ?? ownerInput;

  const unknownReasons = {};
  if (infrastructureOwnerId === null) unknownReasons.infrastructureOwnerId = "owner-not-in-source-data";
  if (!plan) {
    unknownReasons.segmentIds = "external-network-has-no-segment-ids";
    unknownReasons.alignment = `external-location-basis:${net.locationBasis ?? "unspecified"}`;
    unknownReasons.lengthMeters = unknownReasons.alignment;
  }
  // Only what the facts here come from: the plan's drawn alignment, or the existing network's station list.
  // The plan's own terrain / building / water layers fed other facts of that plan, not these, so they are not listed.
  const layers = plan
    ? [{ layer: "plan-geometry", quality: plan.dataQuality ?? null, name: `PlanGeometry ${plan.planId}`, license: ctx.license.pack }]
    : [{ layer: "existing-network", quality: net.dataQuality ?? null, name: `CityPack existing network (${net.id})`, license: ctx.license.pack }];
  return {
    warnings,
    leg: {
      key: hasKey(input.key) ? input.key : null,
      kind, target, fromId, toId, plan, net, line,
      projectId: plan ? text(input.projectId) : null,
      infrastructureOwnerId, stations: run, segmentIds, alignment, lengthMeters,
      unknownReasons,
      quality: (plan ? plan.dataQuality : net.dataQuality) ?? null,
      layers,
    },
  };
}

// drawn: { key?, name?, legs: [{ sourceKind: "planned"|"existing"|"external", sequence?, key?,
//            planId?, projectId?  (planned/existing; projectId is required for "existing" and is opaque to the map),
//            externalNetworkId?, externalLineId?  (external),
//            fromStationId?, toStationId?  (default: the whole target, first to last station),
//            infrastructureOwnerId?  (only what the caller knows from game state; never inferred here) }] }
// ctx:   { pack, plans, externalNetworks }   -> { route, warnings }; route is null when the route cannot be built.
export function buildThroughRoute(drawn, ctx) {
  const packId = ctx.pack.manifest?.id ?? "pack";
  const license = { pack: ctx.pack.manifest?.data?.license ?? null, attribution: ctx.pack.manifest?.data?.attribution ?? [] };
  const context = { packId, license, plans: ctx.plans ?? [], externalNetworks: ctx.externalNetworks ?? [] };
  const errors = [];
  const warnings = [];
  const given = drawn?.legs ?? [];
  if (given.length < 2) return { route: null, warnings: [{ code: "route-too-short", name: drawn?.name ?? null }] };

  // The order of the route is explicit: either every leg carries a `sequence`, or the array order is the order.
  const sequenced = given.filter((l) => l?.sequence !== undefined && l?.sequence !== null).length;
  let ordered = given;
  if (sequenced !== 0 && sequenced !== given.length) return { route: null, warnings: [{ code: "leg-sequence-mixed", name: drawn?.name ?? null }] };
  if (sequenced) {
    const seqs = given.map((l) => l.sequence);
    if (!seqs.every(Number.isInteger) || new Set(seqs).size !== seqs.length) return { route: null, warnings: [{ code: "leg-sequence-invalid", name: drawn?.name ?? null }] };
    ordered = [...given].sort((a, b) => a.sequence - b.sequence);
  }

  const resolved = [];
  for (const input of ordered) {
    const out = resolveLeg(input, context);
    if (out.error) errors.push(out.error);
    else { resolved.push(out.leg); warnings.push(...out.warnings); }
  }
  if (errors.length) return { route: null, warnings: errors };

  // Route id: the saved key, else the legs (target + stations) in route order, direction-independent.
  const forward = resolved.map((l) => `${l.target}|${l.fromId}|${l.toId}`);
  const backward = [...resolved].reverse().map((l) => `${l.target}|${l.toId}|${l.fromId}`);
  const shape = forward.join("\n") <= backward.join("\n") ? forward : backward;
  const throughRouteId = hasKey(drawn.key) ? keyedThroughRouteId(packId, drawn.key) : stableId("through-route", packId, "shape", ...shape);

  const legs = resolved.map((l, sequence) => ({
    legId: stableId("through-leg", throughRouteId, l.key ?? `${l.target}|${[l.fromId, l.toId].sort().join(",")}`),
    sequence,
    sourceKind: l.kind,
    connectedPlanId: l.plan?.planId ?? null,
    connectedProjectId: l.projectId,
    externalNetworkId: l.net?.id ?? null,
    externalLineId: l.line?.id ?? null,
    infrastructureOwnerId: l.infrastructureOwnerId,
    segmentIds: l.segmentIds,
    stationIds: l.stations.map((s) => s.id),
    alignment: l.alignment,
    lengthMeters: l.lengthMeters,
    unknown: LEG_UNKNOWN_ORDER.filter((f) => f in l.unknownReasons),
    unknownReasons: l.unknownReasons,
  }));
  if (new Set(legs.map((l) => l.legId)).size !== legs.length) return { route: null, warnings: [{ code: "duplicate-leg", name: drawn.name ?? null }] };

  const handovers = legs.slice(0, -1).map((a, sequence) => {
    const b = legs[sequence + 1];
    const last = resolved[sequence].stations.at(-1);
    const first = resolved[sequence + 1].stations[0];
    const unknownReasons = {};
    const same = last.id === first.id;
    if (!same) unknownReasons.stationId = unknownReasons.location = "legs-end-at-different-stations";
    let physicalConnection = null;
    let gapMeters = null;
    if (resolved[sequence].plan && resolved[sequence + 1].plan) {
      gapMeters = same ? 0 : roundTo(haversineMetres(last.location, first.location), 1);
      if (gapMeters === 0) physicalConnection = true;
      else if (gapMeters <= NEAR_ENDPOINT_METERS) unknownReasons.physicalConnection = "endpoints-near-not-joined";
      else physicalConnection = false;
    } else {
      // An external leg only has station-level data: where its track really runs and meets other track is not in the source.
      unknownReasons.physicalConnection = "external-topology-not-in-source";
    }
    if (gapMeters === null) unknownReasons.gapMeters = unknownReasons.physicalConnection;
    return {
      handoverId: stableId("through-handover", throughRouteId, ...[a.legId, b.legId].sort()),
      sequence,
      stationId: same ? last.id : null,
      location: same ? last.location.map(round6) : null,
      fromLegId: a.legId,
      toLegId: b.legId,
      fromStationId: last.id,
      toStationId: first.id,
      physicalConnection,
      gapMeters,
      unknown: ["stationId", "location", "physicalConnection", "gapMeters"].filter((f) => f in unknownReasons),
      unknownReasons,
    };
  });

  const unknown = [];
  const unknownReasons = {};
  const mark = (path, reason) => { unknown.push(path); unknownReasons[path] = reason; };
  for (const leg of legs) for (const f of leg.unknown) mark(`leg:${leg.legId}:${f}`, leg.unknownReasons[f]);
  for (const h of handovers) for (const f of h.unknown) mark(`handover:${h.handoverId}:${f}`, h.unknownReasons[f]);
  const lengths = legs.map((l) => l.lengthMeters);
  const totalLengthMeters = lengths.every((v) => v !== null) ? roundTo(lengths.reduce((s, v) => s + v, 0), 1) : null;
  if (totalLengthMeters === null) mark("totalLengthMeters", "leg-length-unknown");

  const layerMap = new Map();
  for (const l of resolved) for (const layer of l.layers) layerMap.set(layerKey(layer), layer);
  const sourceLayers = [...layerMap.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, layer]) => layer);

  return {
    route: {
      schema: THROUGH_ROUTE_SCHEMA,
      contractVersion: 1,
      throughRouteId,
      key: hasKey(drawn.key) ? drawn.key : null,
      sourcePackId: packId,
      sourcePackVersion: ctx.pack.manifest?.version ?? null,
      name: drawn.name ?? null,
      coordinateReference: "EPSG:4326",
      legs,
      handovers,
      totalLengthMeters,
      // a route with any unknown never reads "high"; the sources' own quality can only lower it further
      dataQuality: resolved.reduce((q, l) => (l.quality ? worse(q, l.quality) : q), qualityOf(unknown.length)),
      unknown,
      unknownReasons,
      warnings,
      sourceLayers,
      license,
    },
    warnings,
  };
}

// mapExport: the result of buildMapExport (plans + externalNetworks). Legs are checked against its ids.
export function buildThroughRouteExport({ pack, mapExport, routes = [] }) {
  const built = new Map();
  const warnings = [];
  for (const drawn of routes) {
    const { route, warnings: why } = buildThroughRoute(drawn, { pack, plans: mapExport.plans, externalNetworks: mapExport.externalNetworks });
    if (!route) warnings.push({ code: "through-route-rejected", name: drawn?.name ?? null, reasons: why });
    else if (built.has(route.throughRouteId)) warnings.push({ code: "duplicate-through-route", throughRouteId: route.throughRouteId });
    else built.set(route.throughRouteId, route);
  }
  return {
    schema: THROUGH_ROUTE_EXPORT_SCHEMA,
    packId: pack.manifest?.id ?? "pack",
    packVersion: pack.manifest?.version ?? null,
    routes: [...built.values()].sort((a, b) => (a.throughRouteId < b.throughRouteId ? -1 : 1)),
    warnings,
  };
}

// --- saved routes: a document of what the player drew; a route keeps its key for life ---
export const newThroughRouteDoc = (packId, packVersion = null) => ({ version: THROUGH_ROUTE_DOC_VERSION, packId, packVersion, routes: [] });

export const serializeThroughRouteDoc = (doc) => JSON.stringify({ version: doc.version, packId: doc.packId, packVersion: doc.packVersion, routes: doc.routes });

// Never applies a saved document to the wrong pack, and never hides a pack version change.
export function restoreThroughRouteDoc(text, pack) {
  const packId = pack.manifest?.id ?? "pack";
  const packVersion = pack.manifest?.version ?? null;
  const fresh = newThroughRouteDoc(packId, packVersion);
  if (text === null || text === undefined) return { doc: fresh, warnings: [] };
  let saved;
  try { saved = JSON.parse(text); } catch { return { doc: fresh, warnings: [{ code: "through-route-doc-unreadable" }] }; }
  if (saved?.version !== THROUGH_ROUTE_DOC_VERSION || !Array.isArray(saved.routes)) return { doc: fresh, warnings: [{ code: "through-route-doc-version", version: saved?.version ?? null }] };
  if (saved.packId !== packId) return { doc: fresh, warnings: [{ code: "through-route-doc-other-pack", savedPackId: saved.packId }] };
  const warnings = saved.packVersion !== packVersion ? [{ code: "pack-version-mismatch", saved: saved.packVersion, current: packVersion }] : [];
  return { doc: { ...fresh, routes: saved.routes }, warnings };
}
