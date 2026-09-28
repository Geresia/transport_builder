// Station site candidates: pure spatial facts for the management engine (see docs/station-site-contract.md).
// Track direction and heights, a candidate body footprint, roads / buildings / water / slope around it, entrance
// candidate points, transfer candidates, walking distances to demand points and construction-access space —
// nothing else. Station type, platform layout, construction method, cost, duration, capacity, transfer score
// and compensation belong to the management engine; this module never imports it and never touches cash or
// construction state.
//
// Missing data: a value that cannot be computed is `null`, its name is in `unknown[]` and the reason in
// `unknownReasons` — never 0. A layer that covers the place and finds nothing is a fact (0 / empty / null
// without an `unknown` entry).
import { haversineMetres } from "../projection.mjs";
import { stableId, round6, roundTo, coordKey } from "./ids.mjs";
import { bboxOf, overlaps, inRing, polylineHitsPolygon, polylineLength, ringsOverlap, makeSpatialContext } from "./spatial.mjs";
import { ACCESS, TRANSFER_RADIUS_M, withRailLayer } from "./plan-geometry.mjs";
import { canonicalRing } from "./depot-site.mjs";
import { frameAt, sub, len, nearestOnPolyline, distPointRing, areaAndCentroid, gridSamples, qualityOf, worse } from "./local-geometry.mjs";

export const STATION_SITE_SCHEMA = "transitline.station-site-geometry/1";
export const STATION_EXPORT_SCHEMA = "transitline.station-export/1";

// Everything the numbers below are measured with, echoed in every site as `model` so a reader can reproduce them.
export const STATION_MODEL = Object.freeze({
  defaultBody: { lengthMeters: 160, widthMeters: 24 }, // placeholder footprint for collision tests, marked in bodyDimensionBasis
  entranceFootprintMeters: 6,
  roadsideThresholdMeters: 15,
  roadEdgeMeters: 5,
  roadSearchRadiusMeters: 60,
  transferRadiusMeters: TRANSFER_RADIUS_M,
  access: { radiusMeters: ACCESS.radiusMeters, maxNodes: 8, detourFactor: ACCESS.detourFactor, walkMetersPerMinute: ACCESS.walkMetersPerMinute, minMinutes: ACCESS.minMinutes },
  workArea: { alongMeters: 40, acrossMeters: 30 },
  extensionProbe: { lengthMeters: 400, stepMeters: 10 },
  steepSitePercent: 3,
});
const M = STATION_MODEL;
const GROUND_UNKNOWN = Object.freeze(["groundwater", "soft-ground", "utilities"]);
const OPEN_SPACE = new Set(["park", "playground", "recreation_ground", "common", "village_green", "dog_park"]);
const ELEVATED_STRUCTURES = new Set(["elevated", "bridge"]);
const LAYER_OF = { river: "water", road: "roads", railway: "rail", building: "buildings" };

export const keyedStationSiteId = (packId, key) => stableId("stn-site", packId, "key", key);

const uniqSorted = (list) => [...new Set(list)].sort();
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const finite = (v) => typeof v === "number" && Number.isFinite(v);
const ll6 = ([lon, lat]) => [round6(lon), round6(lat)];
const bearingOf = ([x, y]) => (((Math.atan2(x, y) * 180) / Math.PI) % 360 + 360) % 360; // clockwise from north

function makeMarks() {
  const unknown = [];
  const reasons = {};
  return { unknown, reasons, mark: (field, reason) => { if (!unknown.includes(field)) unknown.push(field); reasons[field] = reason; } };
}

// rectangle centred at `c` (+ offsets along the axis u / across it v), corners in metres
const rectXY = (c, u, v, along, across, offAlong = 0, offAcross = 0) => {
  const cx = c[0] + u[0] * offAlong + v[0] * offAcross;
  const cy = c[1] + u[1] * offAlong + v[1] * offAcross;
  const a = along / 2;
  const b = across / 2;
  return [[-a, -b], [a, -b], [a, b], [-a, b]].map(([s, t]) => [cx + u[0] * s + v[0] * t, cy + u[1] * s + v[1] * t]);
};

const distRingLine = (ring, line) => (polylineHitsPolygon(line, [ring]) ? 0
  : Math.min(...line.map((p) => distPointRing(p, ring)), ...ring.map((p) => nearestOnPolyline(p, line).d)));

// drawn: { key?, name?, connect?: { planId, stationId }, location?: [lon,lat], headingDegrees?, lengthMeters?, widthMeters?,
//          entrances?: [{ key?, name?, location }], transfers?: [{ targetStationId, via?: [[lon,lat]...] }],
//          workAreas?: [{ key?, polygon }] }
// ctx:   { pack, spatial, plans, externalNetworks, demandNodes }
export function buildStationSite(drawn, ctx) {
  const packId = ctx.pack.manifest?.id ?? "pack";
  const spatial = ctx.spatial ?? makeSpatialContext();
  const layers = spatial.layers ?? {};
  const plans = ctx.plans ?? [];
  const externalNetworks = ctx.externalNetworks ?? [];
  const warnings = [];
  const site = makeMarks();

  // --- which plan station this site belongs to ---
  const c = drawn.connect ?? null;
  const conn = { plan: null, station: null, index: null };
  if (c?.planId) {
    conn.plan = plans.find((p) => p.planId === c.planId) ?? null;
    if (!conn.plan) warnings.push({ code: "connection-plan-missing", planId: c.planId });
    else if (c.stationId) {
      conn.index = conn.plan.stationCandidates.findIndex((s) => s.id === c.stationId);
      conn.station = conn.plan.stationCandidates[conn.index] ?? null;
      if (!conn.station) { warnings.push({ code: "connection-station-missing", planId: c.planId, stationId: c.stationId }); conn.plan = null; }
    } else warnings.push({ code: "connection-station-missing", planId: c.planId, stationId: null });
  } else if (c) warnings.push({ code: "connection-target-missing" });
  const noLink = c ? "connection-unresolved" : "no-connection";

  const centerIn = drawn.location ?? conn.station?.location ?? null;
  if (!centerIn) return null;
  const center = ll6(centerIn);
  const frame = frameAt(center);
  const at = [0, 0]; // the frame is centred on the site
  const stationSiteId = drawn.key !== undefined && drawn.key !== null ? keyedStationSiteId(packId, drawn.key) : stableId("stn-site", packId, "at", coordKey(center));

  const covered = (layer, pts) => !layer.covers || pts.every((p) => layer.covers(p));
  const growBox = (box, m) => { const [dx, dy] = frame.ll([m, m]).map((x, i) => x - frame.ll([0, 0])[i]); return [box[0] - dx, box[1] - dy, box[2] + dx, box[3] + dy]; };
  const demReason = layers.dem ? "no-dem-value" : "no-layer";

  // --- track direction at the station, from the plan's alignment ---
  let trackHeadingDegrees = null;
  let segmentIds = [];
  if (conn.station) {
    const id = conn.station.id;
    const segs = conn.plan.segments.filter((s) => s.from === id || s.to === id).sort(byId);
    segmentIds = segs.map((s) => s.id);
    const dirs = [];
    for (const s of segs) {
      const a = s.alignment.map((p) => frame.xy(p));
      const d = s.from === id ? sub(a[1], a[0]) : sub(a.at(-1), a.at(-2));
      if (len(d) > 0) dirs.push([d[0] / len(d), d[1] / len(d)]);
    }
    if (dirs.length) {
      const sum = dirs.reduce((s, d) => [s[0] + d[0], s[1] + d[1]], [0, 0]);
      trackHeadingDegrees = roundTo(bearingOf(len(sum) > 1e-9 ? sum : dirs[0]), 1);
    }
  }
  let headingDegrees = null;
  let axisBasis = null;
  if (finite(drawn.headingDegrees)) { headingDegrees = roundTo(((drawn.headingDegrees % 360) + 360) % 360, 1); axisBasis = "player"; }
  else if (trackHeadingDegrees !== null) { headingDegrees = trackHeadingDegrees; axisBasis = "alignment"; }
  else site.mark("bodyHeadingDegrees", conn.station ? "no-alignment" : noLink);
  if (trackHeadingDegrees === null) site.mark("trackHeadingDegrees", conn.station ? "no-alignment" : noLink);

  // --- candidate body footprint ---
  const planPlatform = conn.station?.platformLengthM;
  const sized = (x) => (finite(x) && x >= 5 ? x : null);
  if (drawn.lengthMeters != null && sized(drawn.lengthMeters) === null) warnings.push({ code: "invalid-body-size", field: "lengthMeters" }); // null / undefined = not set
  if (drawn.widthMeters != null && sized(drawn.widthMeters) === null) warnings.push({ code: "invalid-body-size", field: "widthMeters" });
  const lengthMeters = sized(drawn.lengthMeters) ?? sized(planPlatform) ?? M.defaultBody.lengthMeters;
  const widthMeters = sized(drawn.widthMeters) ?? M.defaultBody.widthMeters;
  const bodyDimensionBasis = {
    length: sized(drawn.lengthMeters) !== null ? "player" : sized(planPlatform) !== null ? "plan-platform-length" : "default",
    width: sized(drawn.widthMeters) !== null ? "player" : "default",
  };
  const u = headingDegrees === null ? null : [Math.sin((headingDegrees * Math.PI) / 180), Math.cos((headingDegrees * Math.PI) / 180)];
  const v = u && [u[1], -u[0]]; // to the right of the direction of travel
  const bodyRing = u ? canonicalRing(rectXY(at, u, v, lengthMeters, widthMeters).map(frame.ll)) : null;
  const bodyXY = bodyRing?.map(frame.xy) ?? null;
  const bodyAreaSquareMeters = bodyXY ? roundTo(areaAndCentroid(bodyXY).area, 1) : null;
  if (!bodyRing) { site.mark("bodyPolygon", "no-heading"); site.mark("bodyAreaSquareMeters", "no-heading"); }

  // Facts about any footprint (body, work area, entrance): overlaps, roads, slope. `ring` is lon/lat.
  function footprint(ring, { terrain = true } = {}) {
    const m = makeMarks();
    const xy = ring.map(frame.xy);
    const box = bboxOf(ring);
    const near = growBox(box, M.roadSearchRadiusMeters);
    const overlapCount = (layer, field) => {
      if (!layer) { m.mark(field, "no-layer"); return null; }
      if (!covered(layer, ring)) { m.mark(field, "outside-coverage"); return null; }
      return layer.items.filter((it) => overlaps(box, it.bbox) && ringsOverlap(ring, it.rings[0])).length;
    };
    const out = { buildingCount: overlapCount(layers.buildings, "intersectedBuildingCount"), waterCount: overlapCount(layers.water, "waterOverlapCount"), roadsThrough: null, roadsNearby: null, nearestRoad: null, nearestMajorRoad: null };
    if (!layers.roads) { for (const f of ["roadsThrough", "nearestRoad"]) m.mark(f, "no-layer"); }
    else if (!covered(layers.roads, ring)) { for (const f of ["roadsThrough", "nearestRoad"]) m.mark(f, "outside-coverage"); }
    else {
      out.roadsThrough = { highway: 0, major: 0, minor: 0 };
      out.roadsNearby = { highway: 0, major: 0, minor: 0 };
      for (const it of layers.roads.items) {
        if (!overlaps(near, it.bbox)) continue;
        const d = distRingLine(xy, it.line.map(frame.xy));
        if (d === 0) out.roadsThrough[it.cls] = (out.roadsThrough[it.cls] ?? 0) + 1;
        if (d <= M.roadSearchRadiusMeters) {
          out.roadsNearby[it.cls] = (out.roadsNearby[it.cls] ?? 0) + 1;
          if (!out.nearestRoad || d < out.nearestRoad.distanceMeters) out.nearestRoad = { roadClass: it.cls, distanceMeters: d };
        }
        if ((it.cls === "highway" || it.cls === "major") && d <= 300 && (!out.nearestMajorRoad || d < out.nearestMajorRoad.distanceMeters)) out.nearestMajorRoad = { roadClass: it.cls, distanceMeters: d };
      }
      if (out.nearestRoad) out.nearestRoad.distanceMeters = roundTo(out.nearestRoad.distanceMeters, 1);
      if (out.nearestMajorRoad) out.nearestMajorRoad.distanceMeters = roundTo(out.nearestMajorRoad.distanceMeters, 1);
    }
    if (terrain) {
      const pts = gridSamples(xy, 20).map(frame.ll);
      const slopes = pts.map((p) => spatial.slopeAt?.(p) ?? null);
      const elevs = pts.map((p) => spatial.elevationAt(p));
      const pct = layers.dem?.slopeAt && slopes.every((s) => s !== null) ? slopes.map((d) => Math.tan((d * Math.PI) / 180) * 100) : null;
      const elevOk = layers.dem && elevs.every((e) => e !== null);
      if (!pct) { m.mark("averageSlopePercent", demReason); m.mark("maximumSlopePercent", demReason); }
      if (!elevOk) { m.mark("groundElevationMeters", demReason); m.mark("elevationRangeMeters", demReason); }
      Object.assign(out, {
        averageSlopePercent: pct ? roundTo(pct.reduce((s, x) => s + x, 0) / pct.length, 2) : null,
        maximumSlopePercent: pct ? roundTo(Math.max(...pct), 2) : null,
        groundElevationMeters: elevOk ? roundTo(elevs.reduce((s, x) => s + x, 0) / elevs.length, 1) : null,
        elevationRangeMeters: elevOk ? roundTo(Math.max(...elevs) - Math.min(...elevs), 1) : null,
      });
    }
    return { ...out, unknown: m.unknown, unknownReasons: m.reasons };
  }

  // --- body ---
  let body = null;
  if (bodyRing) {
    body = footprint(bodyRing);
    for (const [f, r] of Object.entries(body.unknownReasons)) site.mark(f === "roadsThrough" ? "roadsThroughBody" : f, r);
  } else {
    for (const f of ["intersectedBuildingCount", "waterOverlapCount", "roadsThroughBody", "nearestRoad", "averageSlopePercent", "maximumSlopePercent", "groundElevationMeters", "elevationRangeMeters"]) site.mark(f, "no-heading");
  }
  site.mark("roadWidthMeters", layers.roads ? "no-attribute" : "no-layer"); // the road layer carries a class, not a width

  // ground elevation at the centre is enough for the planned track height when the body could not be sampled
  const groundAtCenter = body?.groundElevationMeters ?? spatial.elevationAt(center);
  const structure = conn.station?.structure ?? null;
  const depth = conn.station?.depthMeters ?? null;
  let plannedTrackElevationMeters = null;
  if (!conn.station) { site.mark("plannedDepthMeters", noLink); site.mark("plannedTrackElevationMeters", noLink); }
  else {
    if (!finite(depth)) site.mark("plannedDepthMeters", "no-depth");
    if (ELEVATED_STRUCTURES.has(structure)) site.mark("plannedTrackElevationMeters", "no-structure-height"); // the plan carries no viaduct height
    else if (!finite(depth)) site.mark("plannedTrackElevationMeters", "no-depth");
    else if (groundAtCenter === null) site.mark("plannedTrackElevationMeters", demReason);
    else plannedTrackElevationMeters = roundTo(groundAtCenter - depth, 1);
  }

  // --- stations around: transfer candidates and nearest existing / planned station ---
  const own = conn.station?.id ?? null;
  const targets = [
    ...externalNetworks.flatMap((n) => n.stations.map((s) => ({ id: s.id, name: s.name ?? null, kind: "external", networkId: n.id, lineIds: s.lineIds ?? [], location: s.location, locationBasis: n.locationBasis ?? null }))),
    // stations of other plans only: a neighbour on the site's own line is not a transfer
    ...plans.filter((p) => p !== conn.plan).flatMap((p) => p.stationCandidates.map((s) => ({ id: s.id, name: s.name ?? null, kind: "plan", networkId: p.planId, lineIds: [], location: s.location, locationBasis: "player-placed" }))),
  ].filter((t) => t.id !== own); // ...and a station another plan shares with this one is this one
  const distTo = (pt) => (bodyXY ? distPointRing(frame.xy(pt), bodyXY) : len(frame.xy(pt)));
  const measured = targets.map((t) => ({ ...t, d: distTo(t.location) })).sort((a, b) => a.d - b.d || (a.id < b.id ? -1 : 1));
  const pick = (kind) => { const t = measured.find((x) => x.kind === kind); return t ? { stationId: t.id, name: t.name, networkId: t.networkId, lineIds: t.lineIds, distanceMeters: roundTo(t.d, 1), locationBasis: t.locationBasis } : null; };
  const nearestExistingStation = pick("external"); // null in a blank-map start: there is no existing network, that is a fact
  const nearestPlannedStation = pick("plan");

  const routeFor = (target, via = []) => {
    const t = frame.xy(target);
    const gate = bodyXY ? nearestOnPolyline(via.length ? frame.xy(via[0]) : t, [...bodyXY, bodyXY[0]]).point : at;
    return [gate, ...via.map(frame.xy), t].map((p, i, all) => (i > 0 && i < all.length - 1 ? ll6(via[i - 1]) : ll6(frame.ll(p))));
  };
  const transferFacts = (t, playerVia) => {
    const m = makeMarks();
    const alignment = routeFor(t.location, playerVia ?? []);
    const cross = spatial.crossings(alignment);
    for (const k of ["river", "road", "railway", "building"]) if (cross[k] === null) m.mark(`crossings.${k}`, spatial.whyUnknown?.(LAYER_OF[k], alignment) ?? "unspecified");
    const straight = roundTo(t.d, 1);
    const passage = roundTo(polylineLength(alignment), 1);
    return {
      transferId: stableId("xfer", stationSiteId, t.id),
      basis: playerVia ? "player-passage" : "nearby",
      targetStationId: t.id, targetKind: t.kind, targetName: t.name, targetNetworkId: t.networkId, targetLineIds: t.lineIds, targetLocationBasis: t.locationBasis,
      straightDistanceMeters: straight,
      alignmentBasis: playerVia ? "player" : "straight",
      alignment, passageLengthMeters: passage,
      walkingDistanceMeters: playerVia ? passage : roundTo(straight * ACCESS.detourFactor, 1),
      walkingDistanceBasis: playerVia ? "drawn passage length" : `straight-line x ${ACCESS.detourFactor}`,
      crossings: cross,
      dataQuality: t.locationBasis === "demand-node" ? "low" : worse(qualityOf(m.unknown.length), "medium"),
      unknown: m.unknown, unknownReasons: m.reasons,
    };
  };
  const transfers = new Map();
  for (const t of measured) if (t.d <= M.transferRadiusMeters) transfers.set(t.id, transferFacts(t, null));
  for (const p of drawn.transfers ?? []) {
    const t = measured.find((x) => x.id === p.targetStationId);
    if (!t) { warnings.push({ code: "transfer-target-missing", targetStationId: p.targetStationId ?? null }); continue; }
    transfers.set(t.id, transferFacts(t, (p.via ?? []).map(ll6)));
  }
  const transferCandidates = [...transfers.values()].sort((a, b) => a.straightDistanceMeters - b.straightDistanceMeters || (a.transferId < b.transferId ? -1 : 1));
  if (transferCandidates.some((t) => t.targetLocationBasis === "demand-node")) warnings.push({ code: "external-station-locations-coarse" });

  // --- entrance candidates ---
  const entrances = new Map();
  for (const e of drawn.entrances ?? []) {
    if (!Array.isArray(e?.location) || e.location.length !== 2 || !e.location.every(finite)) { warnings.push({ code: "entrance-no-location", key: e?.key ?? null }); continue; }
    const location = ll6(e.location);
    const id = e.key !== undefined && e.key !== null ? stableId("ent", stationSiteId, "key", e.key) : stableId("ent", stationSiteId, coordKey(location));
    if (entrances.has(id)) { warnings.push({ code: "duplicate-entrance", entranceId: id }); continue; }
    const ex = frame.xy(location);
    const half = M.entranceFootprintMeters / 2;
    const f = footprint([[-half, -half], [half, -half], [half, half], [-half, half]].map(([dx, dy]) => frame.ll([ex[0] + dx, ex[1] + dy])), { terrain: false });
    const m = makeMarks();
    for (const [k, r] of Object.entries(f.unknownReasons)) if (k !== "roadsThrough") m.mark(k === "intersectedBuildingCount" ? "collidingBuildingCount" : k, r);
    // Land use at the point. Open space and the road edge are evidence of public land; nothing else can be said without parcel data.
    let landUses = null;
    if (!layers.landuse) m.mark("landUses", "no-layer");
    else if (!covered(layers.landuse, [location])) m.mark("landUses", "outside-coverage");
    else landUses = uniqSorted(layers.landuse.items.filter((it) => it.kind && overlaps([...location, ...location], it.bbox) && inRing(location, it.rings[0])).map((it) => it.kind));
    let publicLand = null;
    let publicLandEvidence = null;
    if (landUses?.some((k) => OPEN_SPACE.has(k))) { publicLand = true; publicLandEvidence = "osm-open-space"; }
    else if (f.nearestRoad && f.nearestRoad.distanceMeters <= M.roadEdgeMeters) { publicLand = true; publicLandEvidence = "road-edge"; }
    else m.mark("publicLand", "no-parcel-data"); // OSM has no ownership: absence of evidence is not "private"
    const distanceToBodyMeters = bodyXY ? roundTo(distPointRing(ex, bodyXY), 1) : null;
    if (distanceToBodyMeters === null) m.mark("distanceToBodyMeters", "no-heading");
    const roadsideDistance = f.nearestRoad?.distanceMeters ?? null;
    const flags = [];
    if (f.buildingCount > 0) flags.push("building-collision");
    if (f.waterCount > 0) flags.push("in-water");
    if (roadsideDistance !== null && roadsideDistance > M.roadsideThresholdMeters) flags.push("not-roadside");
    entrances.set(id, {
      entranceId: id, name: e.name ?? null, location,
      collidingBuildingCount: f.buildingCount, waterOverlapCount: f.waterCount,
      nearestRoad: f.nearestRoad, roadsideDistanceMeters: roadsideDistance,
      roadside: layers.roads && !f.unknown.includes("nearestRoad") ? roadsideDistance !== null && roadsideDistance <= M.roadsideThresholdMeters : null,
      landUses, publicLand, publicLandEvidence,
      distanceToBodyMeters,
      spatialFlags: flags,
      dataQuality: worse(qualityOf(m.unknown.filter((k) => k !== "publicLand").length), "medium"),
      unknown: m.unknown, unknownReasons: m.reasons,
    });
  }
  const entranceCandidates = [...entrances.values()].sort((a, b) => (a.entranceId < b.entranceId ? -1 : 1));

  // --- demand points within walking range, measured from the nearest entrance (or the body without entrances) ---
  const origins = entranceCandidates.length ? entranceCandidates.map((e) => ({ xy: frame.xy(e.location), id: e.entranceId })) : [{ xy: null, id: null }];
  const demandAccess = (ctx.demandNodes ?? [])
    .map((n) => {
      const nx = frame.xy(n.location);
      const best = origins.map((o) => ({ o, d: o.xy ? len(sub(nx, o.xy)) : bodyXY ? distPointRing(nx, bodyXY) : len(nx) })).sort((a, b) => a.d - b.d || (String(a.o.id) < String(b.o.id) ? -1 : 1))[0];
      return { n, d: best.d, from: best.o.id };
    })
    .filter((x) => x.d <= ACCESS.radiusMeters)
    .sort((a, b) => a.d - b.d || (a.n.id < b.n.id ? -1 : 1))
    .slice(0, M.access.maxNodes)
    .map((x) => ({
      demandNodeId: x.n.id, name: x.n.name ?? null,
      distanceMeters: roundTo(x.d, 1),
      walkMinutes: Math.max(ACCESS.minMinutes, roundTo((x.d * ACCESS.detourFactor) / ACCESS.walkMetersPerMinute, 1)),
      measuredFrom: x.from ? "entrance" : "body", entranceId: x.from,
    }));

  // --- construction access: work-area candidates around the body, and any the player drew ---
  const workAreas = new Map();
  const addWork = (slot, ring, key) => {
    const canon = canonicalRing(ring);
    if (!canon) { warnings.push({ code: "work-area-degenerate", slot }); return; }
    const id = key !== undefined && key !== null ? stableId("work", stationSiteId, "key", key) : stableId("work", stationSiteId, slot, ...(slot === "player" ? canon.map(coordKey) : []));
    if (workAreas.has(id)) { warnings.push({ code: "duplicate-work-area", workAreaId: id }); return; }
    const f = footprint(canon);
    const flags = [];
    if (f.buildingCount > 0) flags.push("building-overlap");
    if (f.waterCount > 0) flags.push("water-overlap");
    workAreas.set(id, {
      workAreaId: id, slot, polygon: canon, areaSquareMeters: roundTo(areaAndCentroid(canon.map(frame.xy)).area, 1),
      intersectedBuildingCount: f.buildingCount, waterOverlapCount: f.waterCount, roadsThrough: f.roadsThrough,
      nearestRoad: f.nearestRoad, nearestMajorRoad: f.nearestMajorRoad,
      averageSlopePercent: f.averageSlopePercent, maximumSlopePercent: f.maximumSlopePercent,
      spatialFlags: flags,
      dataQuality: worse(qualityOf(f.unknown.length), "medium"),
      unknown: f.unknown, unknownReasons: f.unknownReasons,
    });
  };
  if (u) {
    const { alongMeters, acrossMeters } = M.workArea;
    addWork("end-forward", rectXY(at, u, v, alongMeters, acrossMeters, lengthMeters / 2 + alongMeters / 2).map(frame.ll));
    addWork("end-backward", rectXY(at, u, v, alongMeters, acrossMeters, -(lengthMeters / 2 + alongMeters / 2)).map(frame.ll));
    addWork("side-right", rectXY(at, u, v, alongMeters, acrossMeters, 0, widthMeters / 2 + acrossMeters / 2).map(frame.ll));
    addWork("side-left", rectXY(at, u, v, alongMeters, acrossMeters, 0, -(widthMeters / 2 + acrossMeters / 2)).map(frame.ll));
  } else site.mark("workAreaCandidates", "no-heading");
  for (const w of drawn.workAreas ?? []) if (Array.isArray(w?.polygon)) addWork("player", w.polygon, w.key);
  const workAreaCandidates = [...workAreas.values()].sort((a, b) => (a.workAreaId < b.workAreaId ? -1 : 1));

  // --- free straight space beyond each end of the body (the turn-back / extension question, as geometry only) ---
  const extensionSpace = [];
  if (u) {
    const { lengthMeters: probe, stepMeters: step } = M.extensionProbe;
    for (const [end, sign] of [["forward", 1], ["backward", -1]]) {
      const m = makeMarks();
      const slice = (k) => rectXY(at, u, v, step, widthMeters, sign * (lengthMeters / 2 + k * step + step / 2)).map(frame.ll);
      const corridor = rectXY(at, u, v, probe, widthMeters, sign * (lengthMeters / 2 + probe / 2)).map(frame.ll);
      const box = bboxOf(corridor);
      let free = probe;
      let blockedBy = null;
      for (const [name, label] of [["buildings", "building"], ["water", "water"]]) {
        const layer = layers[name];
        if (!layer) { m.mark("freeLengthMeters", "no-layer"); continue; }
        if (!covered(layer, corridor)) { m.mark("freeLengthMeters", "outside-coverage"); continue; }
        for (const it of layer.items) {
          if (!overlaps(box, it.bbox)) continue;
          for (let k = 0; k * step < free; k++) if (ringsOverlap(slice(k), it.rings[0])) { free = k * step; blockedBy = label; break; }
        }
      }
      const unknownFree = m.unknown.includes("freeLengthMeters"); // a missing layer could hide a blocker: no answer beats a wrong one
      extensionSpace.push({ end, probeLengthMeters: probe, freeLengthMeters: unknownFree ? null : free, blockedBy: unknownFree ? null : blockedBy, unknown: m.unknown, unknownReasons: m.reasons });
    }
  } else site.mark("extensionSpace", "no-heading");

  // --- spatial flags: facts, not scores ---
  const spatialFlags = [];
  if (body?.buildingCount > 0) spatialFlags.push("body-building-overlap");
  if (body?.waterCount > 0) spatialFlags.push("body-water-overlap");
  if ((body?.averageSlopePercent ?? -1) >= M.steepSitePercent) spatialFlags.push("steep-site");
  if (!entranceCandidates.length) spatialFlags.push("no-entrance-candidate");
  else {
    const known = entranceCandidates.filter((e) => e.collidingBuildingCount !== null);
    if (known.length === entranceCandidates.length && known.every((e) => e.collidingBuildingCount > 0 || e.waterOverlapCount > 0)) spatialFlags.push("all-entrances-blocked");
    if (entranceCandidates.every((e) => e.roadside === false)) spatialFlags.push("no-roadside-entrance");
  }
  if (workAreaCandidates.length && workAreaCandidates.every((w) => w.intersectedBuildingCount > 0 || w.waterOverlapCount > 0)) spatialFlags.push("no-clear-work-area");
  if (transferCandidates.some((t) => t.crossings.building > 0)) spatialFlags.push("transfer-through-buildings");

  const childUnknown = [
    ...entranceCandidates.flatMap((e) => e.unknown.map((k) => `entranceCandidates[].${k}`)),
    ...workAreaCandidates.flatMap((w) => w.unknown.map((k) => `workAreaCandidates[].${k}`)),
    ...transferCandidates.flatMap((t) => t.unknown.map((k) => `transferCandidates[].${k}`)),
    ...extensionSpace.flatMap((x) => x.unknown.map((k) => `extensionSpace[].${k}`)),
  ];
  return {
    schema: STATION_SITE_SCHEMA,
    contractVersion: 1,
    stationSiteId,
    sourcePackId: packId,
    sourcePackVersion: ctx.pack.manifest?.version ?? null,
    name: drawn.name ?? null,
    coordinateReference: "EPSG:4326",
    location: center,
    connectedPlanId: conn.plan?.planId ?? null,
    connectedStationId: conn.station?.id ?? null,
    connectedSegmentIds: segmentIds,
    connectionBasis: conn.station ? "plan-station" : null,
    planStationIndex: conn.station ? conn.index : null,
    planTerminalEnd: conn.station ? (conn.index === 0 ? "start" : conn.index === conn.plan.stationCandidates.length - 1 ? "end" : null) : null,
    offsetFromPlanStationMeters: conn.station ? roundTo(haversineMetres(center, conn.station.location), 1) : null,
    planHints: conn.station ? { structure, structureBasis: conn.station.structureBasis ?? null, depthMeters: finite(depth) ? depth : null, platformType: conn.station.platformType ?? null } : null,
    trackHeadingDegrees,
    bodyHeadingDegrees: headingDegrees,
    bodyHeadingBasis: axisBasis,
    bodyPolygon: bodyRing,
    bodyLengthMeters: bodyRing ? lengthMeters : null,
    bodyWidthMeters: bodyRing ? widthMeters : null,
    bodyDimensionBasis: bodyRing ? bodyDimensionBasis : null,
    bodyAreaSquareMeters,
    groundElevationMeters: body?.groundElevationMeters ?? groundAtCenter ?? null,
    elevationRangeMeters: body?.elevationRangeMeters ?? null,
    averageSlopePercent: body?.averageSlopePercent ?? null,
    maximumSlopePercent: body?.maximumSlopePercent ?? null,
    plannedDepthMeters: finite(depth) ? depth : null,
    plannedTrackElevationMeters,
    intersectedBuildingCount: body?.buildingCount ?? null,
    waterOverlapCount: body?.waterCount ?? null,
    roadsThroughBody: body?.roadsThrough ?? null,
    roadsNearby: body?.roadsNearby ?? null,
    nearestRoad: body?.nearestRoad ?? null,
    roadWidthMeters: null,
    nearestExistingStation,
    nearestPlannedStation,
    transferCandidates,
    entranceCandidates,
    demandAccess,
    workAreaCandidates,
    extensionSpace,
    spatialFlags,
    model: M,
    // ground data does not exist in any pack yet (constraintUnknown), so quality never reads "high"
    dataQuality: worse(qualityOf(site.unknown.length), "medium"),
    unknown: site.unknown,
    unknownReasons: site.reasons,
    unknownSummary: uniqSorted([...site.unknown, ...childUnknown]),
    constraintUnknown: [...GROUND_UNKNOWN],
    warnings,
    sourceLayers: spatial.sources ?? [],
    license: { pack: ctx.pack.manifest?.data?.license ?? null, attribution: ctx.pack.manifest?.data?.attribution ?? [] },
  };
}

// mapExport: the result of buildMapExport (plans + externalNetworks + demandNodes). Connections are checked against its ids.
export function buildStationExport({ pack, mapExport, stations = [], spatial }) {
  const context = withRailLayer(spatial, mapExport.externalNetworks);
  const sites = new Map();
  const warnings = [];
  for (const drawn of stations) {
    const site = buildStationSite(drawn, { pack, spatial: context, plans: mapExport.plans, externalNetworks: mapExport.externalNetworks, demandNodes: mapExport.demandNodes ?? [] });
    if (!site) warnings.push({ code: "station-no-location", name: drawn.name ?? null, key: drawn.key ?? null, connect: drawn.connect ?? null }); // no place of its own and no resolvable plan station to take one from
    else if (sites.has(site.stationSiteId)) warnings.push({ code: "duplicate-station-site", stationSiteId: site.stationSiteId });
    else sites.set(site.stationSiteId, site);
  }
  return {
    schema: STATION_EXPORT_SCHEMA,
    packId: pack.manifest?.id ?? "pack",
    packVersion: pack.manifest?.version ?? null,
    sites: [...sites.values()].sort((a, b) => (a.stationSiteId < b.stationSiteId ? -1 : 1)),
    warnings,
  };
}
