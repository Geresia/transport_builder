// Map side of the contract with the management engine (see docs/map-plan-contract.md).
// Turns what the player drew on the map into PlanGeometry, existing rail into ExternalNetwork,
// and demand nodes into walking AccessLinks. It only PRODUCES input data — it never reads or
// changes cash, contracts or construction state, and imports nothing from ./management.
//
// Missing data rule: a value we could not find is `null` and its name is listed in `unknown[]`.
// It is never filled with 0. (Fields the current engine misreads when null are omitted instead.)
import { haversineMetres } from "../projection.mjs";
import { stableId, round6, roundTo, coordKey } from "./ids.mjs";
import { makeSpatialContext, polylineLength, railLayerFromExternal } from "./spatial.mjs";

export const PLAN_SCHEMA = "transitline.plan-geometry/1";
export const EXPORT_SCHEMA = "transitline.map-export/1";
export const STRUCTURE_HINTS = Object.freeze(["surface", "elevated", "cut-cover", "shield", "deep", "bridge", "embankment", "cutting"]);
export const PLATFORM_TYPES = Object.freeze(["island", "side"]);

const CURVE_CAP_M = 100_000; // a "straight" alignment reports this radius (JSON has no Infinity)
const STEEP_SLOPE_DEG = 3; // ~52 permille, above every metro technical profile's max gradient
const STEEP_SHARE = 0.25; // "steep-slope" flag: at least this share of the alignment sits on >= STEEP_SLOPE_DEG terrain
const GROUND_UNKNOWN = Object.freeze(["groundwater", "soft-ground"]); // no dataset in any pack yet
const ACCESS = Object.freeze({ radiusMeters: 800, maxLinks: 3, detourFactor: 1.3, walkMetersPerMinute: 80, minMinutes: 1 });
const TRANSFER_RADIUS_M = 500;
const STATION_STRUCTURE = { bridge: "elevated", embankment: "surface", cutting: "surface" };
const STRUCTURE_RANK = { surface: 0, embankment: 0, cutting: 0, elevated: 1, bridge: 1, "cut-cover": 2, shield: 3, deep: 4 };
const QUALITY_ORDER = ["high", "medium", "low"];

const uniqSorted = (list) => [...new Set(list)].sort();
const byId = (a, b) => (a.id < b.id ? -1 : 1);
const worstQuality = (list) => list.reduce((w, q) => (QUALITY_ORDER.indexOf(q) > QUALITY_ORDER.indexOf(w) ? q : w), "high");
const qualityFor = (unknown, coarse) => {
  const n = unknown.length + coarse.length;
  return n === 0 ? "high" : n <= 2 ? "medium" : "low";
};

// --- demand nodes (kept separate from stations: a node need not have any station) ---
export function demandNodesFromPack(pack) {
  return (pack.demand?.points ?? []).map((p) => ({
    id: p.id,
    name: p.name ?? p.id,
    location: [...p.location],
    residents: p.residents ?? null, // matrix packs carry flows, not residents/jobs: unknown, not 0
    jobs: p.jobs ?? null,
    kind: p.kind ?? "mixed",
  }));
}

// --- ExternalNetwork: the player does not own it ---
export function existingNetworkToExternal(pack) {
  const packId = pack.manifest?.id ?? "pack";
  const nodes = new Map(demandNodesFromPack(pack).map((n) => [n.id, n]));
  const warnings = [];
  const lineIdsAt = new Map();
  const lines = pack.existingNetwork.lines.map((line) => {
    const stationIds = [];
    for (const id of line.stationIds) {
      if (!nodes.has(id)) warnings.push({ code: "unknown-station-ref", stationId: id, line: line.name });
      else if (id !== stationIds.at(-1)) stationIds.push(id);
    }
    const id = line.osmRelationId !== undefined ? `ext-line:${line.osmRelationId}` : stableId("ext-line", packId, line.name, ...stationIds);
    for (const s of stationIds) lineIdsAt.set(s, [...(lineIdsAt.get(s) ?? []), id]);
    return {
      id, name: line.name, nameEn: line.name_en ?? null, operator: line.operator ?? null, network: line.network ?? null,
      kind: line.kind ?? null, color: line.color ?? null, stationIds, osmRelationId: line.osmRelationId ?? null,
    };
  }).sort(byId);
  const stations = [...lineIdsAt]
    .map(([id, lineIds]) => ({ id, name: nodes.get(id).name, location: nodes.get(id).location, lineIds: uniqSorted(lineIds) }))
    .sort(byId);
  return {
    id: `external:${packId}`, owner: "external", lines, stations,
    // the pack collapses stations onto demand points (municipality centroids), not real station positions
    locationBasis: "demand-node", dataQuality: "low", warnings,
  };
}

// --- AccessLinks: one demand node -> several stations, each with its own walking time ---
export function accessLinksFor(demandNodes, stations) {
  const links = [];
  for (const node of demandNodes) {
    const near = stations
      .map((s) => ({ s, d: haversineMetres(node.location, s.location) }))
      .filter((x) => x.d <= ACCESS.radiusMeters)
      .sort((a, b) => a.d - b.d || (a.s.id < b.s.id ? -1 : 1))
      .slice(0, ACCESS.maxLinks);
    for (const { s, d } of near) {
      links.push({
        id: stableId("acc", node.id, s.id), demandNodeId: node.id, stationId: s.id,
        // > 0 always (the engine rejects 0): a station entrance is never zero minutes away
        walkMinutes: Math.max(ACCESS.minMinutes, roundTo((d * ACCESS.detourFactor) / ACCESS.walkMetersPerMinute, 1)),
        distanceMeters: roundTo(d, 1),
      });
    }
  }
  return links.sort(byId);
}

// Largest curve radius the drawn alignment allows at each interior vertex: a tangent length of at most
// half of the shorter neighbouring edge (each edge is shared with the next curve). Ends are null.
function curveRadii(path) {
  const kx = 111320 * Math.cos((path[0][1] * Math.PI) / 180);
  const xy = path.map(([lon, lat]) => [lon * kx, lat * 111320]);
  return path.map((_, i) => {
    if (i === 0 || i === path.length - 1) return null;
    const a = [xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]];
    const b = [xy[i + 1][0] - xy[i][0], xy[i + 1][1] - xy[i][1]];
    const la = Math.hypot(...a);
    const lb = Math.hypot(...b);
    if (la * lb === 0) return CURVE_CAP_M;
    const theta = Math.acos(Math.max(-1, Math.min(1, (a[0] * b[0] + a[1] * b[1]) / (la * lb)))); // deflection angle
    return theta < 1e-3 ? CURVE_CAP_M : Math.min(CURVE_CAP_M, Math.min(la, lb) / 2 / Math.tan(theta / 2));
  });
}

function inferStructure(hint, crossings, warnings, legIndex) {
  if (hint !== undefined && hint !== null) {
    if (STRUCTURE_HINTS.includes(hint)) return [hint, "player"];
    warnings.push({ code: "invalid-structure-hint", leg: legIndex, value: String(hint) });
  }
  if (crossings.river > 0) return ["bridge", "inferred:water-crossing"];
  if (crossings.building > 0) return ["shield", "inferred:buildings-on-alignment"];
  return ["elevated", crossings.building === 0 ? "inferred:open-alignment" : "default:no-building-data"];
}

// drawn: { key?, name?, vertices: [{ location:[lon,lat], name?, demandNodeId?, structure?, depthMeters?, platformType?, platformLengthM? }],
//          legs?: [{ via?: [[lon,lat]...], structureHint? }]  // legs[i] runs vertices[i] -> vertices[i+1] }
// ctx:   { pack, spatial, demandNodes, externalNetworks, mode }
export function buildPlanGeometry(drawn, ctx) {
  const packId = ctx.pack.manifest?.id ?? "pack";
  const spatial = ctx.spatial ?? makeSpatialContext();
  const warnings = [];

  // collapse consecutive duplicates (the same place twice in a row is not a segment)
  const verts = [];
  const legsIn = [];
  drawn.vertices.forEach((v, i) => {
    if (verts.length && coordKey(v.location) === coordKey(verts.at(-1).location)) return;
    if (verts.length) legsIn.push(drawn.legs?.[i - 1] ?? {});
    verts.push(v);
  });
  if (verts.length < 2) return null;

  const stationIds = verts.map((v) => stableId("stn", packId, coordKey(v.location)));
  const planId = drawn.key !== undefined && drawn.key !== null
    ? stableId("plan", packId, "key", drawn.key)
    : stableId("plan", packId, "shape", ...verts.map((v, i) => coordKey(v.location) + (legsIn[i]?.via ?? []).map(coordKey).join(";")));

  // full alignment: vertices plus each leg's waypoints, so curvature sees them too
  const full = [];
  const span = [];
  verts.forEach((v, i) => {
    if (i > 0) for (const via of legsIn[i - 1].via ?? []) full.push(via);
    span.push(full.length);
    full.push(v.location);
  });
  const radii = curveRadii(full);

  const segments = legsIn.map((leg, i) => {
    const alignment = full.slice(span[i], span[i + 1] + 1).map(([lon, lat]) => [round6(lon), round6(lat)]);
    const from = verts[i].location;
    const to = verts[i + 1].location;
    const lengthMeters = roundTo(polylineLength(alignment), 1);
    const z0 = spatial.elevationAt(from);
    const z1 = spatial.elevationAt(to);
    // spatial contract: maxSlopeAlong(poly) -> degrees|null (required); steepShareAlong(poly, deg) -> 0..1|null (optional)
    const maxSlope = spatial.maxSlopeAlong(alignment) ?? null;
    const steepShare = maxSlope === null ? null : spatial.steepShareAlong?.(alignment, STEEP_SLOPE_DEG) ?? (maxSlope >= STEEP_SLOPE_DEG ? 1 : 0);
    const crossings = spatial.crossings(alignment);
    const [structureHint, structureHintBasis] = inferStructure(leg.structureHint, crossings, warnings, i);

    const constraintFlags = [];
    if (crossings.river > 0) constraintFlags.push("water-crossing");
    if (steepShare !== null && steepShare >= STEEP_SHARE) constraintFlags.push("steep-slope");
    if (crossings.railway > 0) constraintFlags.push("railway-crossing");

    const between = radii.slice(span[i], span[i + 1] + 1).filter((r) => r !== null);
    const unknown = [];
    if (z0 === null) unknown.push("elevationStartMeters");
    if (z1 === null) unknown.push("elevationEndMeters");
    if (maxSlope === null) unknown.push("maxSlopeDegrees", "steepShare");
    for (const k of ["river", "road", "railway", "building"]) if (crossings[k] === null) unknown.push(`crossings.${k}`);
    const inferred = structureHintBasis === "player" ? [] : ["structureHint"];
    const coarse = ["river", "road", "railway", "building"].filter((k) => crossings[k] !== null && spatial.quality[k] === "low");
    if (z0 !== null && spatial.quality.elevation === "low") coarse.push("elevation");

    return {
      id: stableId("seg", stationIds[i], stationIds[i + 1]),
      from: stationIds[i], to: stationIds[i + 1],
      lengthMeters, lengthBasis: "geodesic along the drawn alignment (station-to-station unless waypoints were drawn)",
      elevationStartMeters: z0, elevationEndMeters: z1,
      gradientPermille: z0 !== null && z1 !== null ? roundTo((Math.abs(z1 - z0) / lengthMeters) * 1000, 1) : null,
      maxSlopeDegrees: maxSlope === null ? null : roundTo(maxSlope, 1),
      steepShare: steepShare === null ? null : roundTo(steepShare, 2), // share of samples on >= 3 degree terrain
      minCurveRadiusMeters: between.length ? roundTo(Math.min(...between), 0) : CURVE_CAP_M,
      structureHint, structureHintBasis,
      constraintFlags, constraintUnknown: [...GROUND_UNKNOWN],
      crossings,
      alignment,
      // ground data (constraintUnknown) is absent everywhere today, so quality never reads "high"
      dataQuality: worstQuality([qualityFor([...unknown, ...inferred], coarse), "medium"]),
      unknown, inferred,
    };
  });

  const externalStations = (ctx.externalNetworks ?? []).flatMap((net) => net.stations.map((s) => ({ ...s, networkId: net.id })));
  const stationCandidates = verts.map((v, i) => {
    const adjacent = [segments[i - 1], segments[i]].filter(Boolean).map((s) => s.structureHint);
    const worst = adjacent.reduce((a, b) => (STRUCTURE_RANK[b] > STRUCTURE_RANK[a] ? b : a));
    const playerStructure = STRUCTURE_HINTS.includes(v.structure);
    const structure = playerStructure ? v.structure : STATION_STRUCTURE[worst] ?? worst;
    const shallow = ["surface", "elevated"].includes(structure);
    const node = ctx.demandNodes?.find((n) => n.id === v.demandNodeId);
    const name = v.name ?? (node && v.demandNodeNamed !== false ? node.name : null);
    const givenDepth = v.depthMeters ?? null;
    const depth = givenDepth ?? (shallow ? 0 : null);
    const platformOk = PLATFORM_TYPES.includes(v.platformType);
    const z = spatial.elevationAt(v.location);

    const unknown = [];
    const inferred = [];
    if (name === null) unknown.push("name");
    if (depth === null) unknown.push("depthMeters");
    else if (givenDepth === null) inferred.push("depthMeters");
    if (!platformOk) unknown.push("platformType");
    if ((v.platformLengthM ?? null) === null) unknown.push("platformLengthM");
    if (z === null) unknown.push("groundElevationMeters");
    if (!playerStructure) inferred.push("structure");

    const station = {
      id: stationIds[i],
      location: [round6(v.location[0]), round6(v.location[1])],
      name, nameSource: v.name ? "player" : name !== null ? "demand-node" : null,
      structure, structureBasis: playerStructure ? "player" : "inferred:adjacent-segment",
      depthMeters: depth,
      platformType: platformOk ? v.platformType : null,
      groundElevationMeters: z,
      transferTargets: externalStations
        .map((s) => ({ networkId: s.networkId, stationId: s.id, lineIds: s.lineIds, distanceMeters: roundTo(haversineMetres(v.location, s.location), 1) }))
        .filter((t) => t.distanceMeters <= TRANSFER_RADIUS_M)
        .sort((a, b) => a.distanceMeters - b.distanceMeters || (a.stationId < b.stationId ? -1 : 1)),
      // name is cosmetic and platformLengthM is always derived by the engine from the train; neither lowers quality
      dataQuality: qualityFor(unknown.filter((k) => k !== "name" && k !== "platformLengthM"), []),
      unknown, inferred,
    };
    // Omitted when unknown: the engine compares `platformLengthM < required`, and null would read as 0 (a false violation).
    if ((v.platformLengthM ?? null) !== null) station.platformLengthM = v.platformLengthM;
    return station;
  });

  const accessLinks = accessLinksFor(ctx.demandNodes ?? [], stationCandidates);
  return {
    schema: PLAN_SCHEMA,
    planId,
    name: drawn.name ?? null,
    coordinateReference: "EPSG:4326",
    sourcePackId: packId,
    sourcePackVersion: ctx.pack.manifest?.version ?? null,
    mode: ctx.mode,
    stationCandidates,
    segments,
    accessLinks,
    accessModel: { ...ACCESS, basis: "straight-line distance x detour factor / walking speed, at least minMinutes" },
    dataQuality: worstQuality([...segments.map((s) => s.dataQuality), ...stationCandidates.map((s) => s.dataQuality)]),
    unknownSummary: uniqSorted([...segments.flatMap((s) => s.unknown), ...stationCandidates.flatMap((s) => s.unknown)]),
    warnings,
    sources: {
      pack: { license: ctx.pack.manifest?.data?.license ?? null, attribution: ctx.pack.manifest?.data?.attribution ?? [] },
      layers: spatial.sources,
    },
  };
}

// Adapter for the existing editor state (state.mjs): stations are still demand points there.
// Lines seeded from the real network (`external: true`) are not player plans.
export function drawnLinesFromState(state) {
  return state.lines.filter((l) => !l.external && !l.owned && (l.planOnly !== false || !("planOnly" in l))).map((line) => ({
    key: line.key ?? null,
    name: line.name,
    vertices: line.stationIds.map((id) => {
      const s = state.stations.get(id);
      const options = line.planningOptions ?? {};
      return {
        location: s.location,
        demandNodeId: s.id,
        ...(s.named ? {} : { demandNodeNamed: false }),
        ...(options.structure ? { structure: options.structure } : {}),
        ...(options.depthMeters !== undefined ? { depthMeters: options.depthMeters } : {}),
        ...(options.platformType ? { platformType: options.platformType } : {}),
        ...(options.platformLengthM !== undefined ? { platformLengthM: options.platformLengthM } : {}),
      };
    }),
    legs: line.stationIds.slice(1).map(() => line.planningOptions?.structure ? { structureHint: line.planningOptions.structure } : {}),
  }));
}

// One entry point for both start modes: "existing" (real network kept) and "scratch" (blank map)
// give the same output shape; scratch just has no external networks and no transfer targets.
export function buildMapExport({ pack, mode = "auto", drawnLines = [], spatial }) {
  const warnings = [];
  const hasExisting = Boolean(pack.existingNetwork);
  const effective = mode === "scratch" || !hasExisting ? "scratch" : "existing";
  if (mode === "existing" && !hasExisting) warnings.push({ code: "no-existing-network", message: "pack has no existing network; using scratch mode" });

  const demandNodes = demandNodesFromPack(pack);
  const externalNetworks = effective === "existing" ? [existingNetworkToExternal(pack)] : [];
  // Railway crossings come from this mode's external network. Scratch has none: a world without rail, so 0 is a fact there.
  const base = spatial ?? makeSpatialContext();
  const context = base.layers.rail ? base : makeSpatialContext({ ...base.layers, rail: railLayerFromExternal(externalNetworks) });

  const plans = new Map();
  for (const drawn of drawnLines) {
    const plan = buildPlanGeometry(drawn, { pack, spatial: context, demandNodes, externalNetworks, mode: effective });
    if (!plan) warnings.push({ code: "drawn-line-too-short", name: drawn.name ?? null });
    else if (plans.has(plan.planId)) warnings.push({ code: "duplicate-plan", planId: plan.planId });
    else plans.set(plan.planId, plan);
  }
  const linked = new Set([...plans.values()].flatMap((p) => p.accessLinks.map((l) => l.demandNodeId)));
  return {
    schema: EXPORT_SCHEMA,
    packId: pack.manifest?.id ?? "pack",
    packVersion: pack.manifest?.version ?? null,
    mode: effective,
    coordinateReference: "EPSG:4326",
    demandNodes,
    externalNetworks,
    plans: [...plans.values()].sort((a, b) => (a.planId < b.planId ? -1 : 1)),
    demandCoverage: { demandNodes: demandNodes.length, withStationLinks: linked.size, withoutStations: demandNodes.length - linked.size },
    warnings,
  };
}
