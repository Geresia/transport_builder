// Station demand / access geometry (see docs/station-demand-access-contract.md): where a station's entrances, walking
// access points, transfer passages, the player's access-boundary polygons and living-area zones are, and how the
// walking links the player drew join them — spatial facts only. How many people come, what they pay, how crowded it is,
// which route they take, how long a walk lasts and any score belong to the management engine and the simulation; this
// module never imports them. The pack's demand and OD files are linked by id, source and data quality only: no value of
// theirs is read, summed or turned into a passenger figure here.
//
// Missing data: a value that cannot be known is `null`, its name is in `unknown[]` and the reason in `unknownReasons`
// (always 1:1) — never 0, false or []. A layer that covers the place and finds nothing is a fact (0 / empty).
import { haversineMetres } from "../projection.mjs";
import { stableId, round6, roundTo, coordKey } from "./ids.mjs";
import { bboxOf, overlaps, inRing, polylineLength, ringsOverlap, makeSpatialContext } from "./spatial.mjs";
import { TRANSFER_RADIUS_M, withRailLayer } from "./plan-geometry.mjs";
import { canonicalRing, selfIntersects } from "./depot-site.mjs";
import { frameAt, nearestOnPolyline, areaAndCentroid, distPointRing, QUALITY, qualityOf, worse } from "./local-geometry.mjs";
import { coord } from "./rail-capacity-facilities.mjs";

export const STATION_DEMAND_ACCESS_SCHEMA = "transitline.station-demand-access-geometry/1";
export const STATION_DEMAND_ACCESS_EXPORT_SCHEMA = "transitline.station-demand-access-export/1";
export const ACCESS_POINT_KINDS = Object.freeze(["street", "crossing", "plaza", "bus-stop", "other"]);
export const DEMAND_ZONE_KINDS = Object.freeze(["residential", "employment", "mixed", "school", "visitor", "other"]);
export const WALK_ENDPOINT_KINDS = Object.freeze(["station", "entrance", "access-point", "demand-zone"]);
export const DEMAND_SOURCE_KINDS = Object.freeze(["demand-points", "od-commute", "od-school", "special-demand", "other"]);

// Everything the facts below are measured with, echoed in every site as `model`.
export const STATION_DEMAND_ACCESS_MODEL = Object.freeze({ transferRadiusMeters: TRANSFER_RADIUS_M, roadSearchRadiusMeters: 60, crossingProbe: "walk alignment as a polyline" });
const M = STATION_DEMAND_ACCESS_MODEL;
const LAYER_OF = { river: "water", road: "roads", railway: "rail", building: "buildings" };
// null fields that never lower the quality: a label, a width the player did not state, and utilities (no dataset exists anywhere)
const COSMETIC = new Set(["name", "widthMeters", "crossings.utility"]);

export const stationAccessIdOf = (packId, key) => stableId("stn-access", packId, "key", key);

const hasKey = (v) => v !== undefined && v !== null && v !== "";
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const byId = (field) => (a, b) => byText(a[field], b[field]);
const sortedObject = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => byText(a, b)));
const finite = (v) => typeof v === "number" && Number.isFinite(v);
const ll6 = ([lon, lat]) => [round6(lon), round6(lat)];
const textOf = (v) => (v === undefined || v === null ? null : String(v));

function makeMarks() {
  const unknown = [];
  const reasons = {};
  return { unknown, reasons, mark: (field, reason) => { if (!unknown.includes(field)) unknown.push(field); reasons[field] = reason; } };
}
const finish = (m) => ({ unknown: [...m.unknown].sort(byText), unknownReasons: sortedObject(m.reasons) });
const qualityFrom = (m) => qualityOf(m.unknown.filter((f) => !COSMETIC.has(f)).length);

// --- links to the pack's demand / OD files: source and quality only -------------------------------------------------
// documents: [{ file, kind, document, attribution?, spatialResolution?, quality?, license? }] — `document` is the parsed file;
// only its stated `source`, `unit`, `model`, `formatVersion` are copied. Nothing inside it is read or summed.
export function demandSourceRefsOf(documents, packId = "pack") {
  const refs = [];
  for (const d of documents ?? []) {
    if (!hasKey(d?.file)) continue;
    const m = makeMarks();
    const kind = DEMAND_SOURCE_KINDS.includes(d.kind) ? d.kind : "other";
    const doc = d.document ?? {};
    const pick = (field, value, reason = "not-stated-in-file") => { if (value === undefined || value === null || value === "") { m.mark(field, reason); return null; } return value; };
    const quality = QUALITY.includes(d.quality) ? d.quality : null;
    if (quality === null) m.mark("quality", "not-assessed");
    refs.push({
      sourceId: stableId("demand-source", packId, d.file), kind, file: String(d.file),
      formatVersion: pick("formatVersion", doc.formatVersion), model: pick("model", doc.model),
      source: pick("source", doc.source), unit: pick("unit", doc.unit),
      attribution: Array.isArray(d.attribution) ? [...d.attribution] : [], license: textOf(d.license),
      spatialResolution: pick("spatialResolution", d.spatialResolution ?? null, "not-stated"), quality,
      ...finish(m),
    });
  }
  return refs.sort(byId("sourceId"));
}

// drawn: { key?, name?, connect?: { planId, stationId } | { externalNetworkId, stationId }, location?: [lon,lat],
//          entrances?: [{ key?, name?, location }], accessPoints?: [{ key?, name?, location, kind? }],
//          walkLinks?: [{ key?, name?, from: { kind, key? }, to: { kind, key? }, via?: [[lon,lat]...], widthMeters? }],
//          transfers?: [{ targetStationId, via?: [[lon,lat]...], fromEntranceKey?, widthMeters? }],
//          catchments?: [{ key?, name?, polygon, entranceKey? }], demandZones?: [{ key?, name?, polygon, kind? }] }
// ctx:   { pack, spatial, plans, externalNetworks, demandNodes?, demandSources? }
export function buildStationDemandAccess(drawn, ctx) {
  const packId = ctx.pack.manifest?.id ?? "pack";
  const spatial = ctx.spatial ?? makeSpatialContext();
  const layers = spatial.layers ?? {};
  const plans = ctx.plans ?? [];
  const externalNetworks = ctx.externalNetworks ?? [];
  const demandNodes = Array.isArray(ctx.demandNodes) ? ctx.demandNodes : null;
  const sources = Array.isArray(ctx.demandSources) ? ctx.demandSources : null;
  const warnings = [];
  const site = makeMarks();

  // --- which station this belongs to ---
  const c = drawn.connect ?? null;
  const conn = { kind: null, plan: null, station: null, networkId: null };
  if (c?.planId) {
    conn.plan = plans.find((p) => p.planId === c.planId) ?? null;
    conn.station = conn.plan?.stationCandidates.find((s) => s.id === c.stationId) ?? null;
    if (!conn.plan) warnings.push({ code: "connection-plan-missing", planId: c.planId });
    else if (!conn.station) { warnings.push({ code: "connection-station-missing", planId: c.planId, stationId: c.stationId ?? null }); conn.plan = null; }
    else conn.kind = "plan";
  } else if (c?.externalNetworkId) {
    const net = externalNetworks.find((n) => n.id === c.externalNetworkId) ?? null;
    conn.station = net?.stations.find((s) => s.id === c.stationId) ?? null;
    if (!net) warnings.push({ code: "connection-network-missing", externalNetworkId: c.externalNetworkId });
    else if (!conn.station) warnings.push({ code: "connection-station-missing", externalNetworkId: c.externalNetworkId, stationId: c.stationId ?? null });
    else { conn.kind = "external"; conn.networkId = net.id; }
  } else if (c) warnings.push({ code: "connection-target-missing" });
  const noLink = c ? "connection-unresolved" : "no-connection";

  const given = drawn.location === undefined || drawn.location === null ? null : coord(drawn.location);
  if (drawn.location !== undefined && drawn.location !== null && !given) warnings.push({ code: "station-location-invalid" });
  const centerIn = given ?? conn.station?.location ?? null;
  if (!centerIn) return null;
  const center = ll6(centerIn);
  const frame = frameAt(center);
  const xy = (p) => frame.xy(p);
  const stationAccessId = hasKey(drawn.key) ? stationAccessIdOf(packId, drawn.key) : stableId("stn-access", packId, "at", coordKey(center));
  const idOf = (prefix, key, location) => (hasKey(key) ? stableId(prefix, stationAccessId, "key", key) : stableId(prefix, stationAccessId, coordKey(location)));
  const polyId = (prefix, key, ring) => (hasKey(key) ? stableId(prefix, stationAccessId, "key", key) : stableId(prefix, stationAccessId, ...ring.map(coordKey)));

  const covered = (layer, pts) => !layer.covers || pts.every((p) => layer.covers(p));
  const growBox = (box, m) => { const o = frame.ll([0, 0]); const [dx, dy] = frame.ll([m, m]).map((v, i) => v - o[i]); return [box[0] - dx, box[1] - dy, box[2] + dx, box[3] + dy]; };

  // facts about a point (entrance, access point): what stands on it and which roads are near it
  function pointFacts(p) {
    const m = makeMarks();
    const inside = (layer, field) => {
      if (!layer) { m.mark(field, "no-layer"); return null; }
      if (!covered(layer, [p])) { m.mark(field, "outside-coverage"); return null; }
      return layer.items.filter((it) => overlaps([...p, ...p], it.bbox) && inRing(p, it.rings[0])).length;
    };
    const out = { insideBuildingCount: inside(layers.buildings, "insideBuildingCount"), insideWaterCount: inside(layers.water, "insideWaterCount"), roadsNearby: null };
    if (!layers.roads) m.mark("roadsNearby", "no-layer");
    else if (!covered(layers.roads, [p])) m.mark("roadsNearby", "outside-coverage");
    else {
      out.roadsNearby = { highway: 0, major: 0, minor: 0 };
      const near = growBox([...p, ...p], M.roadSearchRadiusMeters);
      for (const it of layers.roads.items) if (overlaps(near, it.bbox) && nearestOnPolyline(xy(p), it.line.map(xy)).d <= M.roadSearchRadiusMeters) out.roadsNearby[it.cls] = (out.roadsNearby[it.cls] ?? 0) + 1;
    }
    return { ...out, marks: m };
  }
  // facts about a polygon (catchment, zone): the buildings and water it overlaps
  function areaFacts(ring) {
    const m = makeMarks();
    const box = bboxOf(ring);
    const count = (layer, field) => {
      if (!layer) { m.mark(field, "no-layer"); return null; }
      if (!covered(layer, ring)) { m.mark(field, "outside-coverage"); return null; }
      return layer.items.filter((it) => overlaps(box, it.bbox) && ringsOverlap(ring, it.rings[0])).length;
    };
    return { buildingCount: count(layers.buildings, "buildingCount"), waterOverlapCount: count(layers.water, "waterOverlapCount"), marks: m };
  }
  const ringOf = (polygon) => {
    if (!Array.isArray(polygon) || !polygon.every((p) => coord(p))) return null;
    const ring = canonicalRing(polygon);
    return ring && !selfIntersects(ring) ? ring : null;
  };

  // --- entrances and walking access points ---
  const entrances = new Map();
  const accessPoints = new Map();
  const placed = (collection, list, prefix, warnCode, dupCode, extra) => {
    for (const e of list ?? []) {
      const location = coord(e?.location);
      if (!location) { warnings.push({ code: warnCode, key: e?.key ?? null }); continue; }
      const id = idOf(prefix, e.key, location);
      if (collection.has(id)) { warnings.push({ code: dupCode, id }); continue; }
      const f = pointFacts(location);
      const m = makeMarks();
      for (const [k, r] of Object.entries(f.marks.reasons)) m.mark(k, r);
      const flags = [];
      if (f.insideBuildingCount > 0) flags.push("inside-building");
      if (f.insideWaterCount > 0) flags.push("in-water");
      const rec = { key: hasKey(e.key) ? String(e.key) : null, name: textOf(e.name), location, distanceToStationMeters: roundTo(haversineMetres(location, center), 1), insideBuildingCount: f.insideBuildingCount, insideWaterCount: f.insideWaterCount, roadsNearby: f.roadsNearby, spatialFlags: flags, ...extra(e, m) };
      collection.set(id, { id, rec, m });
    }
  };
  placed(entrances, drawn.entrances, "acc-ent", "entrance-no-location", "duplicate-entrance", () => ({}));
  placed(accessPoints, drawn.accessPoints, "acc-pt", "access-point-no-location", "duplicate-access-point", (e, m) => {
    const ok = e.kind !== undefined && e.kind !== null && ACCESS_POINT_KINDS.includes(e.kind);
    if (e.kind !== undefined && e.kind !== null && !ok) warnings.push({ code: "access-point-kind-invalid", key: e.key ?? null, kind: String(e.kind) });
    if (!ok) m.mark("kind", "not-provided");
    return { kind: ok ? e.kind : null };
  });
  const byKey = (collection) => new Map([...collection.values()].filter((x) => x.rec.key !== null).map((x) => [x.rec.key, x]));
  const entranceByKey = byKey(entrances);
  const pointByKey = byKey(accessPoints);

  // --- living-area zones ---
  const zones = new Map();
  for (const z of drawn.demandZones ?? []) {
    const ring = ringOf(z?.polygon);
    if (!ring) { warnings.push({ code: "demand-zone-degenerate", key: z?.key ?? null }); continue; }
    const id = polyId("acc-zone", z.key, ring);
    if (zones.has(id)) { warnings.push({ code: "duplicate-demand-zone", id }); continue; }
    const ok = z.kind !== undefined && z.kind !== null && DEMAND_ZONE_KINDS.includes(z.kind);
    if (z.kind !== undefined && z.kind !== null && !ok) warnings.push({ code: "demand-zone-kind-invalid", key: z.key ?? null, kind: String(z.kind) });
    zones.set(id, { id, key: hasKey(z.key) ? String(z.key) : null, name: textOf(z.name), kind: ok ? z.kind : null, ring, area: areaAndCentroid(ring.map(xy)), kindMissing: !ok });
  }
  const zoneByKey = new Map([...zones.values()].filter((z) => z.key !== null).map((z) => [z.key, z]));

  // --- walking links the player drew: station / entrance / access point / zone, joined by a polyline ---
  const anchorOf = (ref) => {
    if (ref?.kind === "station") return { kind: "station", id: stationAccessId, location: center };
    const key = ref?.key;
    if (!hasKey(key)) return null;
    if (ref.kind === "entrance") { const e = entranceByKey.get(String(key)); return e && { kind: "entrance", id: e.id, location: e.rec.location }; }
    if (ref.kind === "access-point") { const p = pointByKey.get(String(key)); return p && { kind: "access-point", id: p.id, location: p.rec.location }; }
    if (ref.kind === "demand-zone") { const z = zoneByKey.get(String(key)); return z && { kind: "demand-zone", id: z.id, location: ll6(frame.ll(z.area.centroid)) }; }
    return null;
  };
  const crossingsOf = (alignment, m) => {
    const cross = spatial.crossings(alignment);
    for (const k of ["river", "road", "railway", "building"]) if (cross[k] === null) m.mark(`crossings.${k}`, spatial.whyUnknown?.(LAYER_OF[k], alignment) ?? "unspecified");
    if (cross.utility === null) m.mark("crossings.utility", "no-dataset");
    return cross;
  };
  const widthOf = (v, m, where) => {
    if (v === undefined || v === null) { m.mark("widthMeters", "not-provided"); return null; }
    if (finite(v) && v > 0) return v;
    warnings.push({ code: "width-invalid", where }); m.mark("widthMeters", "width-invalid"); return null;
  };
  const viaOf = (list) => (list === undefined || list === null ? [] : Array.isArray(list) && list.every((p) => coord(p)) ? list.map(ll6) : null);
  const walkLinks = new Map();
  for (const l of drawn.walkLinks ?? []) {
    const from = anchorOf(l?.from);
    const to = anchorOf(l?.to);
    const via = viaOf(l?.via);
    if (!from || !to) { warnings.push({ code: "walk-link-endpoint-missing", key: l?.key ?? null }); continue; }
    if (from.id === to.id) { warnings.push({ code: "walk-link-same-endpoints", key: l?.key ?? null }); continue; }
    if (via === null) { warnings.push({ code: "walk-link-via-invalid", key: l?.key ?? null }); continue; }
    const id = hasKey(l.key) ? stableId("acc-walk", stationAccessId, "key", l.key) : stableId("acc-walk", stationAccessId, ...[from.id, to.id].sort(byText), ...via.map(coordKey));
    if (walkLinks.has(id)) { warnings.push({ code: "duplicate-walk-link", id }); continue; }
    const m = makeMarks();
    const alignment = [from.location, ...via, to.location];
    walkLinks.set(id, {
      walkLinkId: id, key: hasKey(l.key) ? String(l.key) : null, name: textOf(l.name),
      from: { kind: from.kind, id: from.id }, to: { kind: to.kind, id: to.id },
      alignment, alignmentBasis: "player", lengthMeters: roundTo(polylineLength(alignment), 1), straightDistanceMeters: roundTo(haversineMetres(from.location, to.location), 1),
      widthMeters: widthOf(l.widthMeters, m, id), crossings: crossingsOf(alignment, m), dataQuality: worse(qualityFrom(m), "medium"), ...finish(m),
    });
  }
  const linkList = [...walkLinks.values()].sort(byId("walkLinkId"));

  // how far a zone / access point is joined to the station by the links drawn (shortest drawn length); no link drawn is `connected: false`
  const nodeOf = (end) => (end.kind === "station" || end.kind === "entrance" ? "S" : end.id);
  const adjacency = new Map();
  for (const l of linkList) {
    const a = nodeOf(l.from);
    const b = nodeOf(l.to);
    if (a === b) continue;
    for (const [x, y] of [[a, b], [b, a]]) adjacency.set(x, [...(adjacency.get(x) ?? []), [y, l]]);
  }
  const reach = new Map([["S", { d: 0, linkIds: [] }]]);
  const open = new Set(["S"]);
  const done = new Set();
  while (open.size) {
    const cur = [...open].sort((x, y) => reach.get(x).d - reach.get(y).d || byText(x, y))[0];
    open.delete(cur);
    done.add(cur);
    for (const [next, l] of adjacency.get(cur) ?? []) {
      if (done.has(next)) continue;
      const d = reach.get(cur).d + l.lengthMeters;
      if (!reach.has(next) || d < reach.get(next).d - 1e-9) { reach.set(next, { d, linkIds: [...reach.get(cur).linkIds, l.walkLinkId] }); open.add(next); }
    }
  }
  const drawnConnection = (id) => { const r = reach.get(id); return r ? { connected: true, lengthMeters: roundTo(r.d, 1), linkIds: r.linkIds } : { connected: false }; };
  const linksAt = (id) => linkList.filter((l) => l.from.id === id || l.to.id === id).map((l) => l.walkLinkId);

  // --- records ---
  const entranceList = [...entrances.values()].map(({ id, rec, m }) => ({ entranceId: id, ...rec, linkedWalkLinkIds: linksAt(id), dataQuality: worse(qualityFrom(m), "medium"), ...finish(m) })).sort(byId("entranceId"));
  const pointList = [...accessPoints.values()].map(({ id, rec, m }) => ({ accessPointId: id, ...rec, linkedWalkLinkIds: linksAt(id), drawnConnection: drawnConnection(id), dataQuality: worse(qualityFrom(m), "medium"), ...finish(m) })).sort(byId("accessPointId"));

  const demandSourceIds = sources ? sources.filter((s) => s.kind === "demand-points").map((s) => s.sourceId).sort(byText) : null;
  const zoneList = [...zones.values()].map((z) => {
    const m = makeMarks();
    const f = areaFacts(z.ring);
    for (const [k, r] of Object.entries(f.marks.reasons)) m.mark(k, r);
    if (z.kindMissing) m.mark("kind", "not-provided");
    let demandNodeRefs = null;
    let nearestDemandNode = null;
    if (demandNodes === null) { m.mark("demandNodeRefs", "no-demand-nodes-supplied"); m.mark("nearestDemandNode", "no-demand-nodes-supplied"); }
    else {
      const ring = z.ring.map(xy);
      const measured = demandNodes.map((n) => ({ n, d: distPointRing(xy(n.location), ring), inside: inRing(n.location, z.ring) })).sort((a, b) => a.d - b.d || byText(a.n.id, b.n.id));
      // only that a node lies inside / nearest and which of its fields exist: the values stay in the pack's file
      demandNodeRefs = measured.filter((x) => x.inside).map((x) => ({ demandNodeId: x.n.id, name: x.n.name ?? null, location: ll6(x.n.location), nodeKind: x.n.kind ?? null, fieldsPresent: ["residents", "jobs"].filter((k) => x.n[k] !== null && x.n[k] !== undefined) })).sort(byId("demandNodeId"));
      if (measured.length) nearestDemandNode = { demandNodeId: measured[0].n.id, distanceMeters: roundTo(measured[0].d, 1) };
      else m.mark("nearestDemandNode", "pack-has-no-demand-nodes");
    }
    let nearestEntrance = null;
    if (!entranceList.length) m.mark("nearestEntrance", "no-entrance");
    else {
      const ring = z.ring.map(xy);
      const best = entranceList.map((e) => ({ id: e.entranceId, d: distPointRing(xy(e.location), ring) })).sort((a, b) => a.d - b.d || byText(a.id, b.id))[0];
      nearestEntrance = { entranceId: best.id, distanceMeters: roundTo(best.d, 1) };
    }
    if (demandSourceIds === null) m.mark("demandSourceRefIds", "no-source-supplied");
    const flags = [];
    if (demandNodeRefs && !demandNodeRefs.length) flags.push("no-demand-node-inside");
    const drawnPath = drawnConnection(z.id);
    if (!drawnPath.connected) flags.push("no-walk-link-drawn");
    return {
      demandZoneId: z.id, key: z.key, name: z.name, kind: z.kind, polygon: z.ring, areaSquareMeters: roundTo(z.area.area, 1), centroid: ll6(frame.ll(z.area.centroid)),
      buildingCount: f.buildingCount, waterOverlapCount: f.waterOverlapCount, demandNodeRefs, nearestDemandNode, nearestEntrance, demandSourceRefIds: demandSourceIds,
      linkedWalkLinkIds: linksAt(z.id), drawnConnection: drawnPath, spatialFlags: flags, dataQuality: worse(qualityFrom(m), "medium"), ...finish(m),
    };
  }).sort(byId("demandZoneId"));

  // --- catchments: the access boundary the player drew, for the station or for one entrance ---
  const catchments = new Map();
  for (const k of drawn.catchments ?? []) {
    const ring = ringOf(k?.polygon);
    if (!ring) { warnings.push({ code: "catchment-degenerate", key: k?.key ?? null }); continue; }
    let entrance = null;
    if (hasKey(k.entranceKey)) {
      entrance = entranceByKey.get(String(k.entranceKey)) ?? null;
      if (!entrance) { warnings.push({ code: "catchment-entrance-missing", key: k.key ?? null, entranceKey: String(k.entranceKey) }); continue; }
    }
    const id = polyId("acc-catch", k.key, ring);
    if (catchments.has(id)) { warnings.push({ code: "duplicate-catchment", id }); continue; }
    const m = makeMarks();
    const f = areaFacts(ring);
    for (const [fk, r] of Object.entries(f.marks.reasons)) m.mark(fk, r);
    let demandNodeIds = null;
    if (demandNodes === null) m.mark("demandNodeIdsInside", "no-demand-nodes-supplied");
    else demandNodeIds = demandNodes.filter((n) => inRing(n.location, ring)).map((n) => n.id).sort(byText);
    const inside = (p) => inRing(p, ring);
    const flags = [];
    const containsStation = inside(center);
    if (!containsStation) flags.push("excludes-station");
    if (entrance && !inside(entrance.rec.location)) flags.push("excludes-own-entrance");
    catchments.set(id, {
      catchmentId: id, key: hasKey(k.key) ? String(k.key) : null, name: textOf(k.name), scope: entrance ? "entrance" : "station", ...(entrance ? { entranceId: entrance.id } : {}),
      polygon: ring, polygonBasis: "player", areaSquareMeters: roundTo(areaAndCentroid(ring.map(xy)).area, 1), containsStation,
      containsEntranceIds: entranceList.filter((e) => inside(e.location)).map((e) => e.entranceId),
      containsAccessPointIds: pointList.filter((p) => inside(p.location)).map((p) => p.accessPointId),
      demandZoneIds: zoneList.filter((z) => ringsOverlap(ring, z.polygon)).map((z) => z.demandZoneId),
      demandNodeIdsInside: demandNodeIds, buildingCount: f.buildingCount, waterOverlapCount: f.waterOverlapCount,
      spatialFlags: flags, dataQuality: worse(qualityFrom(m), "medium"), ...finish(m),
    });
  }
  const catchmentList = [...catchments.values()].sort(byId("catchmentId"));

  // --- transfers: other stations nearby, and the passages the player drew to them ---
  const own = conn.station?.id ?? null;
  const targets = [
    ...externalNetworks.flatMap((n) => n.stations.map((s) => ({ id: s.id, name: s.name ?? null, kind: "external", networkId: n.id, lineIds: s.lineIds ?? [], location: s.location, locationBasis: n.locationBasis ?? null }))),
    // stations of other plans only: a neighbour on this station's own line is not a transfer
    ...plans.filter((p) => p !== conn.plan).flatMap((p) => p.stationCandidates.map((s) => ({ id: s.id, name: s.name ?? null, kind: "plan", networkId: p.planId, lineIds: [], location: s.location, locationBasis: "player-placed" }))),
  ].filter((t) => t.id !== own).map((t) => ({ ...t, d: haversineMetres(center, t.location) })).sort((a, b) => a.d - b.d || byText(a.id, b.id));
  const transfers = new Map();
  const transferOf = (t, passage) => {
    const m = makeMarks();
    let from = { kind: "station", id: stationAccessId, location: center };
    if (passage && hasKey(passage.fromEntranceKey)) {
      const e = entranceByKey.get(String(passage.fromEntranceKey));
      if (e) from = { kind: "entrance", id: e.id, location: e.rec.location };
      else warnings.push({ code: "transfer-entrance-missing", targetStationId: t.id, entranceKey: String(passage.fromEntranceKey) });
    }
    const alignment = [from.location, ...(passage ? passage.via : []), ll6(t.location)];
    return {
      transferId: stableId("acc-xfer", stationAccessId, t.id), basis: passage ? "player-passage" : "nearby",
      targetStationId: t.id, targetKind: t.kind, targetName: t.name, targetNetworkId: t.networkId, targetLineIds: t.lineIds, targetLocation: ll6(t.location), targetLocationBasis: t.locationBasis,
      from: { kind: from.kind, id: from.id },
      alignment, alignmentBasis: passage ? "player" : "straight",
      straightDistanceMeters: roundTo(haversineMetres(from.location, t.location), 1), passageLengthMeters: roundTo(polylineLength(alignment), 1),
      widthMeters: widthOf(passage?.widthMeters, m, t.id), crossings: crossingsOf(alignment, m),
      dataQuality: t.locationBasis === "demand-node" ? "low" : worse(qualityFrom(m), "medium"), ...finish(m),
    };
  };
  for (const t of targets) if (t.d <= M.transferRadiusMeters) transfers.set(t.id, transferOf(t, null));
  for (const p of drawn.transfers ?? []) {
    const t = targets.find((x) => x.id === p?.targetStationId);
    if (!t) { warnings.push({ code: "transfer-target-missing", targetStationId: p?.targetStationId ?? null }); continue; }
    const via = viaOf(p.via);
    if (via === null) { warnings.push({ code: "transfer-via-invalid", targetStationId: t.id }); continue; }
    transfers.set(t.id, transferOf(t, { ...p, via }));
  }
  const transferList = [...transfers.values()].sort((a, b) => a.straightDistanceMeters - b.straightDistanceMeters || byText(a.transferId, b.transferId));
  if (transferList.some((t) => t.targetLocationBasis === "demand-node")) warnings.push({ code: "external-station-locations-coarse" });

  // --- demand source links (source and quality only) ---
  let sourceRefs = null;
  if (sources === null) site.mark("demandSourceRefs", "no-source-supplied");
  else sourceRefs = sources.map((s) => structuredClone(s)).sort(byId("sourceId"));
  if (conn.station === null) site.mark("offsetFromConnectedStationMeters", noLink);

  // --- spatial flags: facts, not scores ---
  const flags = new Set();
  const walked = [...linkList, ...transferList];
  if (!entranceList.length) flags.add("no-entrance-drawn");
  if (entranceList.some((e) => e.insideBuildingCount > 0)) flags.add("entrance-inside-building");
  if (!catchmentList.length) flags.add("no-catchment-drawn");
  if (catchmentList.some((k) => !k.containsStation)) flags.add("catchment-excludes-station");
  if (!zoneList.length) flags.add("no-demand-zone-drawn");
  if (zoneList.some((z) => !z.drawnConnection.connected)) flags.add("demand-zone-without-walk-link");
  if (pointList.some((p) => !p.drawnConnection.connected)) flags.add("access-point-without-walk-link");
  if (walked.some((l) => l.crossings.building > 0)) flags.add("walk-through-buildings");
  if (walked.some((l) => l.crossings.river > 0)) flags.add("walk-crosses-river");
  if (walked.some((l) => l.crossings.railway > 0)) flags.add("walk-crosses-railway");
  if (transferList.some((t) => t.targetLocationBasis === "demand-node")) flags.add("external-station-locations-coarse");

  // --- every unknown into one 1:1 list of paths ---
  const all = { ...site.reasons };
  const collect = (collection, idField, list) => { for (const rec of list) for (const f of rec.unknown) all[`${collection}:${rec[idField]}:${f}`] = rec.unknownReasons[f]; };
  collect("entrances", "entranceId", entranceList);
  collect("accessPoints", "accessPointId", pointList);
  collect("walkLinks", "walkLinkId", linkList);
  collect("transfers", "transferId", transferList);
  collect("catchments", "catchmentId", catchmentList);
  collect("demandZones", "demandZoneId", zoneList);
  collect("demandSourceRefs", "sourceId", sourceRefs ?? []);
  const unknownPaths = Object.keys(all).sort(byText);
  const sourceQuality = (sourceRefs ?? []).reduce((w, s) => worse(w, s.quality ?? "medium"), "high");
  // geometry quality counts the unknowns of the drawing; what a demand file leaves unstated is carried by that source's own quality
  const geometryUnknown = unknownPaths.filter((p) => !p.startsWith("demandSourceRefs:") && !COSMETIC.has(p.split(":").at(-1)));
  const dataQuality = worse(qualityOf(geometryUnknown.length), sourceQuality);

  const facts = { location: center, stationKind: conn.kind, connectedStationId: conn.station?.id ?? null, entrances: entranceList, accessPoints: pointList, walkLinks: linkList, transfers: transferList, catchments: catchmentList, demandZones: zoneList, demandSourceRefs: sourceRefs };
  return {
    schema: STATION_DEMAND_ACCESS_SCHEMA, contractVersion: 1,
    stationAccessId, stationAccessRevision: stableId("stn-access-revision", stationAccessId, JSON.stringify(facts)),
    sourcePackId: packId, sourcePackVersion: ctx.pack.manifest?.version ?? null,
    name: textOf(drawn.name), coordinateReference: "EPSG:4326", location: center, locationBasis: given ? "player" : conn.kind === "plan" ? "plan-station" : "external-station",
    stationKind: conn.kind ?? "free", connectedPlanId: conn.plan?.planId ?? null, connectedStationId: conn.station?.id ?? null, connectedNetworkId: conn.networkId ?? conn.plan?.planId ?? null,
    offsetFromConnectedStationMeters: conn.station ? roundTo(haversineMetres(center, conn.station.location), 1) : null,
    entrances: entranceList, accessPoints: pointList, walkLinks: linkList, transfers: transferList, catchments: catchmentList, demandZones: zoneList,
    demandSourceRefs: sourceRefs,
    spatialFlags: [...flags].sort(byText), model: M, dataQuality,
    unknown: unknownPaths, unknownReasons: sortedObject(all),
    warnings, sourceLayers: spatial.sources ?? [],
    license: { pack: ctx.pack.manifest?.data?.license ?? null, attribution: ctx.pack.manifest?.data?.attribution ?? [] },
  };
}

// mapExport: the result of buildMapExport (plans + externalNetworks + demandNodes). demandSources: demandSourceRefsOf(...) output.
// `deleted: true` marks a station the player removed: it keeps its id but is not built.
export function buildStationDemandAccessExport({ pack, mapExport, stations = [], spatial, demandSources = null }) {
  const packId = pack.manifest?.id ?? "pack";
  const context = withRailLayer(spatial, mapExport.externalNetworks);
  const sites = new Map();
  const inactive = [];
  const warnings = [];
  for (const drawn of stations) {
    if (drawn?.deleted === true) { inactive.push({ key: drawn.key ?? null, stationAccessId: hasKey(drawn.key) ? stationAccessIdOf(packId, drawn.key) : null }); continue; }
    const built = buildStationDemandAccess(drawn, { pack, spatial: context, plans: mapExport.plans, externalNetworks: mapExport.externalNetworks, demandNodes: mapExport.demandNodes ?? null, demandSources });
    if (!built) warnings.push({ code: "station-no-location", name: drawn?.name ?? null, key: drawn?.key ?? null, connect: drawn?.connect ?? null });
    else if (sites.has(built.stationAccessId)) warnings.push({ code: "duplicate-station-access", stationAccessId: built.stationAccessId });
    else sites.set(built.stationAccessId, built);
  }
  const list = [...sites.values()].sort(byId("stationAccessId"));
  // access boundaries of different stations that share ground: a spatial fact, not a split of anyone's demand
  const catchmentOverlaps = [];
  for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) for (const a of list[i].catchments) for (const b of list[j].catchments) {
    if (ringsOverlap(a.polygon, b.polygon)) catchmentOverlaps.push({ stationAccessIds: [list[i].stationAccessId, list[j].stationAccessId], catchmentIds: [a.catchmentId, b.catchmentId] });
  }
  return {
    schema: STATION_DEMAND_ACCESS_EXPORT_SCHEMA, packId, packVersion: pack.manifest?.version ?? null,
    sites: list, catchmentOverlaps: catchmentOverlaps.sort((a, b) => byText(a.catchmentIds.join(), b.catchmentIds.join())),
    inactive: inactive.sort((a, b) => byText(String(a.stationAccessId), String(b.stationAccessId))), warnings,
  };
}
