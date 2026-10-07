// B15-E4 operational boundary.  The policy and walking modules stay pure;
// this is the one place that turns their validated evidence into access links
// the passenger router can consume.
import { stableId } from "./map/ids.mjs";
import { allocateStationDemand } from "./station-demand-allocation-policy.mjs";
import { buildStationDemandWalkingAccess } from "./station-demand-walking-model.mjs";
import { replaceStationDemandAllocationLinks } from "./state.mjs";

export const STATION_DEMAND_ALLOCATION_APPLICATION_SCHEMA = "transitline.station-demand-allocation-application/1";

const clone = (value) => structuredClone(value);
const byText = (a, b) => String(a).localeCompare(String(b));
const round6 = (value) => Math.round(value * 1e6) / 1e6 + 0;
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const currentRevisions = (application) => Object.fromEntries((application?.assessment?.sites ?? []).map((site) => [site.stationAccessId, site.stationAccessRevision]).sort(([a], [b]) => byText(a, b)));

function requireAccessApplication(state) {
  const application = state?.stationDemandAccessApplication;
  if (!application?.access || !application?.assessment || !application?.applicationId) throw new Error("Apply station demand access facts before allocating demand");
  return application;
}

function walkingPolicyOf(input) {
  if (input?.walkingPolicy === undefined || input?.walkingPolicy === null) return null;
  if (!isObject(input.walkingPolicy)) throw new Error("Walking policy must be an object");
  return input.walkingPolicy;
}

function allocationPolicyOf(input) {
  if (input?.policy === undefined || input?.policy === null) return null;
  if (!isObject(input.policy)) throw new Error("Allocation policy must be an object");
  return input.policy;
}

function operationalStationMatches(state, sourceStationId) {
  return [...(state?.stations?.values?.() ?? [])]
    .filter((station) => station?.sourceStationId === sourceStationId)
    .map((station) => String(station.id))
    .sort(byText);
}

function bestWalkingRecord(walking, stationAccessId, demandNodeId) {
  const candidates = (walking.nodes ?? [])
    .filter((entry) => entry.stationAccessId === stationAccessId && entry.demandNodeId === demandNodeId && entry.usable === true && Number.isFinite(entry.walkMinutes) && entry.walkMinutes >= 1)
    .sort((a, b) => a.walkMinutes - b.walkMinutes || byText(a.nodeAccessId, b.nodeAccessId));
  return candidates[0] ?? null;
}

function linkPlan(state, allocation, walking) {
  const links = [];
  const blocked = [];
  for (const node of allocation.nodes ?? []) for (const assignment of node.assignments ?? []) {
    const base = { demandNodeId: node.demandNodeId, stationAccessId: assignment.stationAccessId, share: assignment.share };
    // B15-E5: a share below one is applied as a share.  The access model routes such a node by a deterministic schedule over the
    // links' shares (see access-demand.mjs), so a 60 / 40 split is neither dropped nor turned into "the nearest station wins".
    // A share that cannot become a link (no walk, no built station) stays out, and its trips are not given to the other station.
    const walk = bestWalkingRecord(walking, assignment.stationAccessId, node.demandNodeId);
    if (!walk) { blocked.push({ ...base, code: "walk-path-unavailable" }); continue; }
    const matches = operationalStationMatches(state, assignment.connectedStationId);
    if (matches.length !== 1) { blocked.push({ ...base, code: matches.length ? "station-operational-ambiguous" : "station-not-operational" }); continue; }
    links.push({
      allocationId: allocation.allocationId,
      demandNodeId: node.demandNodeId,
      stationId: matches[0],
      stationAccessId: assignment.stationAccessId,
      walkNodeAccessId: walk.nodeAccessId,
      walkMinutes: walk.walkMinutes,
      share: assignment.share,
      source: "station-demand-allocation",
    });
  }
  // Two access sites that resolve to the same operational station are one link: the shares add up, the shorter walk is kept.
  const unique = new Map();
  for (const link of links.sort((a, b) => byText(`${a.demandNodeId}|${a.stationId}|${a.walkNodeAccessId}`, `${b.demandNodeId}|${b.stationId}|${b.walkNodeAccessId}`))) {
    const key = `${link.demandNodeId}|${link.stationId}`;
    const old = unique.get(key);
    if (!old) { unique.set(key, link); continue; }
    const better = link.walkMinutes < old.walkMinutes || (link.walkMinutes === old.walkMinutes && byText(link.walkNodeAccessId, old.walkNodeAccessId) < 0);
    unique.set(key, { ...(better ? link : old), share: Math.min(1, round6(old.share + link.share)) });
  }
  const sorted = [...unique.values()].sort((a, b) => byText(`${a.demandNodeId}|${a.stationId}`, `${b.demandNodeId}|${b.stationId}`));
  // The nodes the passenger router will split: more than one link, or one link that is not the whole node.  What no link takes
  // (an unallocated remainder, a share that was blocked above) is `unroutedShare`: those trips get no station access.
  const byNode = new Map();
  for (const link of sorted) byNode.set(link.demandNodeId, [...(byNode.get(link.demandNodeId) ?? []), link]);
  const splitNodes = [...byNode.entries()]
    .filter(([, row]) => row.length > 1 || row[0].share < 1)
    .map(([demandNodeId, row]) => ({ demandNodeId, shares: row.map((link) => ({ stationId: link.stationId, share: link.share })), unroutedShare: Math.max(0, round6(1 - row.reduce((sum, link) => sum + link.share, 0))) }));
  return { links: sorted, blocked: blocked.sort((a, b) => byText(JSON.stringify(a), JSON.stringify(b))), splitNodes };
}

// Dry run only: it never changes operational state, cash, clock, RNG or the
// legacy map accessLinks.  It can show why a currently valid allocation still
// cannot create a passenger-routing link (no built station / no drawn walk).
export function assessStationDemandAllocation(state, { policy = null, walkingPolicy = null } = {}) {
  const accessApplication = requireAccessApplication(state);
  const allocation = allocateStationDemand({ application: accessApplication, policy, legacyAccessLinks: clone(state.accessLinks ?? []) });
  const walking = buildStationDemandWalkingAccess({
    stationDemandAccess: accessApplication.access,
    pack: { manifest: { id: accessApplication.sourcePackId, version: accessApplication.sourcePackVersion } },
    policy: walkingPolicy,
    expectedRevisions: currentRevisions(accessApplication),
  });
  const planned = linkPlan(state, allocation, walking);
  return {
    schema: STATION_DEMAND_ALLOCATION_APPLICATION_SCHEMA,
    contractVersion: 1,
    applicationId: stableId("station-demand-allocation-application", accessApplication.applicationId, allocation.allocationId, JSON.stringify(walking.policy)),
    accessApplicationId: accessApplication.applicationId,
    sourcePackId: accessApplication.sourcePackId,
    sourcePackVersion: accessApplication.sourcePackVersion,
    status: allocation.status,
    policyStatus: allocation.policyStatus,
    allocation,
    walking,
    links: planned.links,
    splitNodes: planned.splitNodes,
    blockedLinks: planned.blocked,
  };
}

export function applyStationDemandAllocation(state, input = {}) {
  if (!state) throw new Error("Operational state is required");
  const preview = assessStationDemandAllocation(state, { policy: allocationPolicyOf(input), walkingPolicy: walkingPolicyOf(input) });
  if (preview.policyStatus !== "valid") throw new Error("A valid explicit allocation policy is required");
  if (preview.status !== "current") throw new Error(`Station demand allocation is ${preview.status}`);
  replaceStationDemandAllocationLinks(state, preview.links);
  state.stationDemandAllocationApplication = {
    ...clone(preview),
    allocationPolicy: clone(allocationPolicyOf(input)),
    walkingPolicy: clone(preview.walking.policy),
    appliedAtSimMinute: Number.isFinite(state.simMinutes) ? state.simMinutes : null,
    status: "current",
  };
  return stationDemandAllocationApplicationReport(state);
}

// Applying a changed map export must never silently reroute passengers.  The
// existing links and decision stay for audit, but the stored application is
// visibly stale until the player explicitly re-applies a policy.
export function markStationDemandAllocationStale(state) {
  const stored = state?.stationDemandAllocationApplication;
  const current = state?.stationDemandAccessApplication;
  if (!stored || !current || stored.accessApplicationId === current.applicationId) return false;
  stored.status = "stale";
  stored.staleReasons = ["station-demand-access-revision-changed"];
  return true;
}

export function stationDemandAllocationApplicationReport(state) {
  const application = state?.stationDemandAllocationApplication ?? null;
  return application === null ? null : clone(application);
}
