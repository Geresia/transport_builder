// B15-E3 P2: the walking facts of a station's access drawing, normalised for the engine.
//
// Input is the validated StationDemandAccessExport (B15-M1). Output says, for every walking link the player drew, for
// every access point / living-area zone / demand node they join, and for every transfer passage: whether it can be
// used, how long it measured, how many minutes that is, and what still has to be confirmed. It never prices, scores or
// counts anything: no demand, fare, crowding, passenger, probability, money or random value is read or produced. It
// does not touch management state, the clock or an RNG, and it never writes to its inputs.
//
// Rules that matter (each has a test):
//  - the drawn polyline length is the only measured length; minutes = max(1, round(meters / 80));
//  - a straight-line x 1.3 estimate exists only when the policy says `walkEstimate: "straight-line"` (default "none"),
//    only for a subject with no drawn link at all, and it never replaces a blocked or unconfirmed drawn path;
//  - a link that crosses a river / railway / building is `blocked`, one whose layer cannot say is `unknown`; neither is
//    assumed safe. The player can acknowledge a link id (or the policy can accept unmeasured layers) — a known crossing
//    is never accepted by a layer setting, only by naming the link;
//  - width never changes a time; transfer passages are separate facts and never feed demand allocation;
//  - a broken endpoint, a deleted target or a stale map revision is never usable;
//  - null (not measured), not-drawn (no link drawn) and 0 (a measured zero) are three different things.
import { haversineMetres } from "./projection.mjs";
import { stableId } from "./map/ids.mjs";
import { STATION_DEMAND_ACCESS_EXPORT_SCHEMA } from "./station-demand-access-assessment.mjs";

export const STATION_DEMAND_WALKING_ACCESS_SCHEMA = "transitline.station-demand-walking-access/1";
const SITE_SCHEMA = "transitline.station-demand-access-geometry/1";

export const WALKING_MODEL = Object.freeze({
  metersPerMinute: 80,
  minMinutes: 1,
  estimateDetourFactor: 1.3,
  rounding: "nearest-integer-minute",
  barrierKinds: Object.freeze(["river", "railway", "building"]),
});
const BARRIERS = WALKING_MODEL.barrierKinds;

const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const byField = (field) => (a, b) => byText(a[field], b[field]);
const listOf = (value) => (Array.isArray(value) ? value : []);
const text = (value) => (typeof value === "string" && value !== "" ? value : null);
const isMeasure = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
const isCoord = (p) => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]);
const tenth = (value) => Math.round(value * 10) / 10 + 0;
const unique = (list) => [...new Set(list)].sort(byText);
const positiveWidth = (value) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null);

// meters -> whole minutes. Only a measured, non-negative length has a time; 0 m is a measured zero (the 1-minute floor).
export function walkMinutesOf(meters) {
  return isMeasure(meters) ? Math.max(WALKING_MODEL.minMinutes, Math.round(meters / WALKING_MODEL.metersPerMinute)) : null;
}

export function normalizeWalkingPolicy(policy = null) {
  const out = { walkEstimate: "none", acknowledgedWalkLinkIds: [], acknowledgedTransferIds: [], acceptUnmeasuredLayers: false };
  if (policy === null || policy === undefined) return out;
  if (typeof policy !== "object" || Array.isArray(policy)) throw new Error("Walking policy must be an object");
  if (policy.walkEstimate !== undefined) {
    if (!["none", "straight-line"].includes(policy.walkEstimate)) throw new Error("walkEstimate must be none or straight-line");
    out.walkEstimate = policy.walkEstimate;
  }
  if (policy.acceptUnmeasuredLayers !== undefined) {
    if (typeof policy.acceptUnmeasuredLayers !== "boolean") throw new Error("acceptUnmeasuredLayers must be a boolean");
    out.acceptUnmeasuredLayers = policy.acceptUnmeasuredLayers;
  }
  for (const field of ["acknowledgedWalkLinkIds", "acknowledgedTransferIds"]) {
    if (policy[field] === undefined) continue;
    if (!Array.isArray(policy[field]) || !policy[field].every((id) => typeof id === "string" && id !== "")) throw new Error(`${field} must be a list of ids`);
    out[field] = unique(policy[field]);
  }
  return out;
}

function packIdentity(pack) {
  return { id: pack?.manifest?.id ?? pack?.id ?? null, version: pack?.manifest?.version ?? pack?.version ?? null };
}

function requireExport(access, pack) {
  // buildStationDemandAccessExport stamps the version in the schema string only (no `contractVersion` field), so an
  // absent field is the real export; any other stated version is not v1.
  if (!access || access.schema !== STATION_DEMAND_ACCESS_EXPORT_SCHEMA || (access.contractVersion !== undefined && access.contractVersion !== 1)) throw new Error("StationDemandAccessExport v1 is required");
  const identity = packIdentity(pack);
  if (!identity.id) throw new Error("A CityPack id is required");
  if (access.packId !== identity.id) throw new Error("Station demand access belongs to another pack");
  if (identity.version !== null && access.packVersion !== identity.version) throw new Error("Station demand access pack version does not match");
  if (!Array.isArray(access.sites)) throw new Error("Station demand access export is incomplete");
  return identity;
}

// What the layers said about one barrier kind along a drawn line: crossed / clear / unmeasured (never merged into one).
function barrierOf(record, kind) {
  const value = record?.crossings?.[kind];
  if (isMeasure(value)) return { count: value, state: value > 0 ? "crossed" : "clear", reason: null };
  const stated = record?.unknownReasons?.[`crossings.${kind}`];
  return { count: null, state: "unmeasured", reason: text(stated) ?? (value === undefined || value === null ? "not-in-export" : "invalid-value") };
}
const barrierView = (barrier) => Object.fromEntries(BARRIERS.map((kind) => [kind, { state: barrier[kind].state, count: barrier[kind].count, reason: barrier[kind].reason }]));

// Dijkstra over link records. Station and entrances are one node ("S"), as the map joins them.
const nodeOf = (end) => (end.kind === "station" || end.kind === "entrance" ? "S" : end.id);
function reachFrom(links) {
  const adjacency = new Map();
  for (const link of links) {
    const a = nodeOf(link.from);
    const b = nodeOf(link.to);
    if (a === b) continue;
    for (const [x, y] of [[a, b], [b, a]]) adjacency.set(x, [...(adjacency.get(x) ?? []), [y, link]]);
  }
  const reach = new Map([["S", { d: 0, linkIds: [] }]]);
  const open = new Set(["S"]);
  const done = new Set();
  while (open.size) {
    const current = [...open].sort((x, y) => reach.get(x).d - reach.get(y).d || byText(x, y))[0];
    open.delete(current);
    done.add(current);
    for (const [next, link] of [...(adjacency.get(current) ?? [])].sort((p, q) => byText(p[1].walkLinkId, q[1].walkLinkId))) {
      if (done.has(next)) continue;
      const d = reach.get(current).d + (link.meters ?? 0);
      if (!reach.has(next) || d < reach.get(next).d - 1e-9) { reach.set(next, { d, linkIds: [...reach.get(current).linkIds, link.walkLinkId] }); open.add(next); }
    }
  }
  return reach;
}

function assessSite(site, access, policy, expectedRevisions, knownTargets, warnings) {
  const stationAccessId = site.stationAccessId;
  const revision = text(site.stationAccessRevision);
  let block = null;
  if (site.schema !== SITE_SCHEMA || site.contractVersion !== 1) block = { status: "broken", reasons: ["site-schema-invalid"] };
  else if (site.sourcePackId !== access.packId || (site.sourcePackVersion ?? null) !== (access.packVersion ?? null)) block = { status: "stale", reasons: ["site-pack-mismatch"] };
  else if (expectedRevisions && Object.hasOwn(expectedRevisions, stationAccessId) && expectedRevisions[stationAccessId] !== revision) block = { status: "stale", reasons: ["stale-map-revision"] };

  const entrances = new Map(listOf(site.entrances).filter((e) => text(e?.entranceId)).map((e) => [e.entranceId, e]));
  const accessPoints = new Map(listOf(site.accessPoints).filter((p) => text(p?.accessPointId)).map((p) => [p.accessPointId, p]));
  const zones = new Map(listOf(site.demandZones).filter((z) => text(z?.demandZoneId)).map((z) => [z.demandZoneId, z]));
  const resolves = (end) => {
    if (!end || typeof end.id !== "string") return false;
    if (end.kind === "station") return end.id === stationAccessId;
    if (end.kind === "entrance") return entrances.has(end.id);
    if (end.kind === "access-point") return accessPoints.has(end.id);
    if (end.kind === "demand-zone") return zones.has(end.id);
    return false;
  };
  const factAt = (end, field) => (end?.kind === "entrance" ? entrances.get(end.id)?.[field] : end?.kind === "access-point" ? accessPoints.get(end.id)?.[field] : null);

  // --- walking links ---
  const seen = new Set();
  const links = [];
  for (const raw of listOf(site.walkLinks)) {
    const walkLinkId = text(raw?.walkLinkId);
    if (!walkLinkId) { warnings.push({ code: "walk-link-without-id", stationAccessId }); continue; }
    if (seen.has(walkLinkId)) { warnings.push({ code: "duplicate-walk-link-id", stationAccessId, walkLinkId }); continue; }
    seen.add(walkLinkId);
    const from = { kind: text(raw.from?.kind), id: text(raw.from?.id) };
    const to = { kind: text(raw.to?.kind), id: text(raw.to?.id) };
    const broken = [];
    if (!resolves(raw.from)) broken.push("endpoint-missing:from");
    if (!resolves(raw.to)) broken.push("endpoint-missing:to");
    if (from.id !== null && from.id === to.id) broken.push("endpoints-identical");
    if (!(listOf(raw.alignment).length >= 2 && raw.alignment.every(isCoord))) broken.push("alignment-invalid");
    const meters = isMeasure(raw.lengthMeters) ? raw.lengthMeters : null;
    const barrier = Object.fromEntries(BARRIERS.map((kind) => [kind, barrierOf(raw, kind)]));
    const acknowledged = policy.acknowledgedWalkLinkIds.includes(walkLinkId);
    const crossed = BARRIERS.filter((kind) => barrier[kind].state === "crossed").map((kind) => `crosses-${kind}`);
    const unmeasured = BARRIERS.filter((kind) => barrier[kind].state === "unmeasured").map((kind) => `barrier-unmeasured:${kind}:${barrier[kind].reason}`);
    const inWater = [raw.from, raw.to].filter((end) => factAt(end, "insideWaterCount") > 0).map((end) => `endpoint-in-water:${end.id}`);
    const flags = [raw.from, raw.to].filter((end) => factAt(end, "insideBuildingCount") > 0).map((end) => `endpoint-inside-building:${end.id}`);
    if (meters === 0) flags.push("zero-length-drawn");
    if (raw.widthMeters !== null && raw.widthMeters !== undefined && positiveWidth(raw.widthMeters) === null) flags.push("width-invalid");

    const reasons = [];
    let status = "usable";
    let acknowledgeable = false;
    if (block) { status = block.status; reasons.push(...block.reasons); }
    else if (broken.length) { status = "broken"; reasons.push(...broken); }
    else {
      const needsConfirm = [...crossed, ...unmeasured];
      if (acknowledged) flags.push(...needsConfirm.map((r) => `acknowledged:${r}`));
      else if (policy.acceptUnmeasuredLayers) flags.push(...unmeasured.map((r) => `accepted:${r}`));
      const pendingBlocked = acknowledged ? [] : crossed;
      const pendingUnknown = acknowledged || policy.acceptUnmeasuredLayers ? [] : unmeasured;
      const lengthUnknown = meters === null ? ["length-unmeasured"] : [];
      reasons.push(...pendingBlocked, ...inWater, ...pendingUnknown, ...lengthUnknown);
      if (pendingBlocked.length || inWater.length) status = "blocked";
      else if (pendingUnknown.length || lengthUnknown.length) status = "unknown";
      acknowledgeable = status !== "usable" && !inWater.length && !lengthUnknown.length;
    }
    links.push({
      walkLinkId, stationAccessId, from, to, status, usable: status === "usable", meters, walkMinutes: walkMinutesOf(meters),
      straightMeters: isMeasure(raw.straightDistanceMeters) ? raw.straightDistanceMeters : null, widthMeters: positiveWidth(raw.widthMeters),
      barrier: barrierView(barrier), acknowledged, acknowledgeable, reasons: unique(reasons), flags: unique(flags),
    });
  }
  links.sort(byField("walkLinkId"));

  // --- paths: access points and zones to the station ---
  const usableReach = reachFrom(links.filter((l) => l.status === "usable"));
  const softReach = reachFrom(links.filter((l) => l.status === "usable" || l.status === "unknown"));
  const fullReach = reachFrom(links.filter((l) => l.status === "usable" || l.status === "unknown" || l.status === "blocked"));
  const linkById = new Map(links.map((l) => [l.walkLinkId, l]));
  const anchors = [...(isCoord(site.location) ? [site.location] : []), ...[...entrances.values()].map((e) => e.location).filter(isCoord)];
  const estimateOf = (location) => {
    if (!isCoord(location) || !anchors.length) return null;
    const straight = tenth(Math.min(...anchors.map((a) => haversineMetres(location, a))));
    const meters = tenth(straight * WALKING_MODEL.estimateDetourFactor);
    return { meters, components: [{ kind: "straight-line-estimate", straightMeters: straight, detourFactor: WALKING_MODEL.estimateDetourFactor, meters }] };
  };
  const none = (status, reasons) => ({ status, usable: false, meters: null, linkIds: [], reasons, acknowledgeLinkIds: [], estimated: false, components: [], flags: [] });

  // the best drawn path for one subject; the estimate is only ever a fallback for "no drawn link at all"
  const pathStatus = (subjectId, mapConnected, location) => {
    if (block) return none(block.status, [...block.reasons]);
    const take = (reach, status) => {
      const found = reach.get(subjectId);
      const pathLinks = found.linkIds.map((id) => linkById.get(id));
      const meters = pathLinks.some((l) => l.meters === null) ? null : tenth(pathLinks.reduce((sum, l) => sum + l.meters, 0));
      const bad = pathLinks.filter((l) => l.status !== "usable");
      const resolved = bad.length ? (bad.some((l) => l.status === "blocked") ? "blocked" : "unknown") : status;
      return {
        status: resolved, usable: resolved === "usable", meters, linkIds: found.linkIds, reasons: unique(bad.flatMap((l) => l.reasons)),
        acknowledgeLinkIds: bad.filter((l) => l.acknowledgeable).map((l) => l.walkLinkId).sort(byText), estimated: false,
        components: meters === null ? [] : [{ kind: "drawn-path", meters, linkIds: found.linkIds }], flags: unique(pathLinks.flatMap((l) => l.flags)),
      };
    };
    if (usableReach.has(subjectId)) return take(usableReach, "usable");
    if (softReach.has(subjectId)) return take(softReach, "unknown");
    if (fullReach.has(subjectId)) return take(fullReach, "blocked");
    if (mapConnected === true) return none("broken", ["drawn-path-has-broken-link"]);
    // no drawn link joins it: a fact about the drawing, not proof that the place cannot be reached
    if (policy.walkEstimate === "straight-line") {
      const estimate = estimateOf(location);
      if (estimate) return { ...none("estimated", []), usable: true, meters: estimate.meters, estimated: true, components: estimate.components, flags: ["barriers-not-checked"] };
      return none("not-drawn", ["no-walk-link-drawn", "estimate-anchor-missing"]);
    }
    return none("not-drawn", ["no-walk-link-drawn"]);
  };

  const paths = [];
  const nodes = [];
  const subjects = [
    ...[...accessPoints.values()].map((p) => ({ kind: "access-point", id: p.accessPointId, location: p.location, connected: p.drawnConnection?.connected, record: p })),
    ...[...zones.values()].map((z) => ({ kind: "demand-zone", id: z.demandZoneId, location: z.centroid, connected: z.drawnConnection?.connected, record: z })),
  ];
  for (const subject of subjects) {
    const result = pathStatus(subject.id, subject.connected, subject.location);
    const pathId = stableId("walk-path", stationAccessId, subject.kind, subject.id);
    paths.push({
      pathId, stationAccessId, subject: { kind: subject.kind, id: subject.id }, status: result.status, usable: result.usable,
      meters: result.meters, walkMinutes: result.usable ? walkMinutesOf(result.meters) : null, estimated: result.estimated,
      linkIds: result.linkIds, acknowledgeLinkIds: result.acknowledgeLinkIds, mapReportedConnection: typeof subject.connected === "boolean" ? subject.connected : null,
      reasons: unique(result.reasons), flags: unique(result.flags),
    });
    if (subject.kind !== "demand-zone") continue;
    if (!Array.isArray(subject.record.demandNodeRefs)) { warnings.push({ code: "zone-demand-nodes-not-supplied", stationAccessId, demandZoneId: subject.id }); continue; }
    for (const ref of subject.record.demandNodeRefs) {
      const demandNodeId = text(ref?.demandNodeId);
      if (!demandNodeId) continue;
      const nodeLocation = isCoord(ref.location) ? ref.location : null;
      let record = result;
      let meters = result.meters;
      let components = result.components;
      if (result.estimated) {
        // an estimate is measured from the node itself, not from the zone centre
        const own = nodeLocation ? estimateOf(nodeLocation) : null;
        if (own) { meters = own.meters; components = own.components; }
        else { record = none("not-drawn", ["no-walk-link-drawn", "node-location-missing"]); meters = null; components = []; }
      } else if (result.meters !== null && isCoord(subject.location)) {
        if (nodeLocation) {
          // the drawn path ends at the zone centre; the rest of the way inside the zone is a measured straight distance, unscaled
          const residual = tenth(haversineMetres(subject.location, nodeLocation));
          meters = tenth(result.meters + residual);
          components = [...result.components, { kind: "zone-residual-straight", meters: residual }];
        } else { record = none("unknown", unique([...result.reasons, "node-location-missing"])); meters = null; components = []; }
      }
      nodes.push({
        nodeAccessId: stableId("walk-node", stationAccessId, subject.id, demandNodeId), stationAccessId, demandNodeId,
        via: { kind: "demand-zone", id: subject.id }, pathId, status: record.status, usable: record.usable, meters,
        walkMinutes: record.usable ? walkMinutesOf(meters) : null, estimated: record.estimated, components,
        acknowledgeLinkIds: result.acknowledgeLinkIds, reasons: unique(record.reasons), flags: unique(result.flags),
      });
    }
  }

  // --- transfer passages: a separate fact, never an access to a demand node ---
  const transfers = [];
  for (const raw of listOf(site.transfers)) {
    const transferId = text(raw?.transferId);
    if (!transferId) { warnings.push({ code: "transfer-without-id", stationAccessId }); continue; }
    const targetStationId = text(raw.targetStationId);
    const basis = raw.basis === "player-passage" || raw.basis === "nearby" ? raw.basis : null;
    const drawn = basis === "player-passage";
    const broken = [];
    if (!targetStationId || (knownTargets && !knownTargets.has(targetStationId))) broken.push("transfer-target-missing");
    if (basis === null) broken.push("transfer-basis-invalid");
    if (raw.from?.kind === "entrance" && !entrances.has(raw.from.id)) broken.push("transfer-entrance-missing");
    if (!(listOf(raw.alignment).length >= 2 && raw.alignment.every(isCoord))) broken.push("alignment-invalid");
    const straight = isMeasure(raw.straightDistanceMeters) ? raw.straightDistanceMeters : null;
    const passage = drawn && isMeasure(raw.passageLengthMeters) ? raw.passageLengthMeters : null;
    const barrier = Object.fromEntries(BARRIERS.map((kind) => [kind, barrierOf(raw, kind)]));
    const acknowledged = policy.acknowledgedTransferIds.includes(transferId);
    const crossed = BARRIERS.filter((kind) => barrier[kind].state === "crossed").map((kind) => `crosses-${kind}`);
    const unmeasured = BARRIERS.filter((kind) => barrier[kind].state === "unmeasured").map((kind) => `barrier-unmeasured:${kind}:${barrier[kind].reason}`);
    const coarse = raw.targetLocationBasis === "demand-node";
    const estimating = !drawn && policy.walkEstimate === "straight-line" && straight !== null;
    const reasons = [];
    const flags = [];
    let meters = drawn ? passage : null;
    let status;
    let acknowledgeable = false;
    if (block) { status = block.status; reasons.push(...block.reasons); }
    else if (broken.length) { status = "broken"; reasons.push(...broken); }
    else {
      if (acknowledged) flags.push(...[...crossed, ...unmeasured].map((r) => `acknowledged:${r}`));
      else if (policy.acceptUnmeasuredLayers) flags.push(...unmeasured.map((r) => `accepted:${r}`));
      const pendingBlocked = acknowledged ? [] : crossed;
      const pendingUnknown = acknowledged || policy.acceptUnmeasuredLayers ? [] : unmeasured;
      const lengthUnknown = drawn && passage === null;
      if (coarse) reasons.push("target-location-coarse");
      reasons.push(...pendingBlocked, ...pendingUnknown);
      if (lengthUnknown) reasons.push("length-unmeasured");
      if (estimating) { meters = tenth(straight * WALKING_MODEL.estimateDetourFactor); flags.push("straight-line-estimate"); }
      if (pendingBlocked.length) status = "blocked";
      else if (coarse || pendingUnknown.length || lengthUnknown) status = "unknown";
      else if (estimating) status = "estimated";
      else if (!drawn) { status = "not-drawn"; reasons.push("no-passage-drawn"); }
      else status = "usable";
      acknowledgeable = (status === "blocked" || status === "unknown") && (pendingBlocked.length > 0 || pendingUnknown.length > 0) && !lengthUnknown;
    }
    const usable = status === "usable" || status === "estimated";
    transfers.push({
      transferId, stationAccessId, targetStationId, targetKind: text(raw.targetKind), targetNetworkId: text(raw.targetNetworkId), basis,
      from: { kind: text(raw.from?.kind), id: text(raw.from?.id) }, status, usable, estimated: status === "estimated",
      meters: ["usable", "estimated", "blocked", "unknown"].includes(status) ? meters : null, straightMeters: straight,
      passageWalkMinutes: usable ? walkMinutesOf(meters) : null, widthMeters: positiveWidth(raw.widthMeters),
      barrier: barrierView(barrier), acknowledged, acknowledgeable, usedForDemandAllocation: false, reasons: unique(reasons), flags: unique(flags),
    });
  }
  transfers.sort(byField("transferId"));
  paths.sort(byField("pathId"));
  nodes.sort(byField("nodeAccessId"));
  return {
    summary: { stationAccessId, stationAccessRevision: revision, status: block ? block.status : "current", reasons: block ? block.reasons : [], connectedPlanId: text(site.connectedPlanId), connectedStationId: text(site.connectedStationId) },
    links, paths, nodes, transfers,
  };
}

// stationDemandAccess: the validated StationDemandAccessExport; pack: the CityPack (identity only); policy: see
// normalizeWalkingPolicy; expectedRevisions: { [stationAccessId]: stationAccessRevision } the caller built its decision on
// (a different revision is stale); knownTargetStationIds: ids of the plan / external stations that still exist (a transfer
// to any other is broken).
export function buildStationDemandWalkingAccess({ stationDemandAccess, pack, policy = null, expectedRevisions = null, knownTargetStationIds = null } = {}) {
  const identity = requireExport(stationDemandAccess, pack);
  const normalized = normalizeWalkingPolicy(policy);
  if (expectedRevisions !== null && (typeof expectedRevisions !== "object" || Array.isArray(expectedRevisions))) throw new Error("expectedRevisions must be an object");
  const knownTargets = knownTargetStationIds === null || knownTargetStationIds === undefined ? null : new Set(knownTargetStationIds);
  const warnings = [];
  const sites = [];
  const out = { links: [], paths: [], nodes: [], transfers: [] };
  const present = new Set();
  const validSites = stationDemandAccess.sites.filter((site) => {
    if (text(site?.stationAccessId)) return true;
    warnings.push({ code: "site-without-id" });
    return false;
  }).sort(byField("stationAccessId"));
  for (const site of validSites) {
    if (present.has(site.stationAccessId)) { warnings.push({ code: "duplicate-station-access", stationAccessId: site.stationAccessId }); continue; }
    present.add(site.stationAccessId);
    const built = assessSite(site, stationDemandAccess, normalized, expectedRevisions, knownTargets, warnings);
    sites.push(built.summary);
    for (const key of Object.keys(out)) out[key].push(...built[key]);
  }
  for (const id of Object.keys(expectedRevisions ?? {}).sort(byText)) if (!present.has(id)) warnings.push({ code: "expected-station-missing", stationAccessId: id });
  const linkIds = new Set(out.links.map((l) => l.walkLinkId));
  for (const id of normalized.acknowledgedWalkLinkIds) if (!linkIds.has(id)) warnings.push({ code: "acknowledged-link-not-in-map", walkLinkId: id });
  const transferIds = new Set(out.transfers.map((t) => t.transferId));
  for (const id of normalized.acknowledgedTransferIds) if (!transferIds.has(id)) warnings.push({ code: "acknowledged-transfer-not-in-map", transferId: id });
  return {
    schema: STATION_DEMAND_WALKING_ACCESS_SCHEMA, contractVersion: 1,
    sourcePackId: identity.id, sourcePackVersion: identity.version,
    policy: normalized, model: { ...WALKING_MODEL, barrierKinds: [...WALKING_MODEL.barrierKinds] },
    sites, links: out.links, paths: out.paths, nodes: out.nodes, transfers: out.transfers,
    warnings: warnings.sort((a, b) => byText(JSON.stringify(a), JSON.stringify(b))),
  };
}
