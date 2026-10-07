// B15-E3 P1: which demand node may reach which station access site — a pure decision, nothing else.
//
// Inputs: the map's StationDemandAccessExport (spatial evidence), the engine's E1 assessment of it, and a policy document the
// player wrote.  Output: for every demand node, whether it is unknown, held (unallocated) or assigned, and with which shares.
// Nothing here creates passengers, moves money, advances time, draws a random number or touches management state; it never
// writes to its inputs, and the legacy 800 m access links are only *reported on*, never changed.
//
// The rules, in one place:
//   * a node that is unknown (coarse / low-quality / missing source, missing values, area footprint, stale assessment) gets no
//     value and no assignment, and no policy can unlock it;
//   * an exclusive node (exactly one claiming station) is assigned only when the policy says so;
//   * a shared node (two or more claiming stations) is unallocated unless a rule gives explicit shares: no equal split, no
//     nearest station, no tie break, never the same node in full to two stations;
//   * a rule is bound to the station revisions it was written for; when one changed the rule is stale and the node it targets
//     is unallocated — it is never silently re-bound;
//   * null (unknown) is never turned into 0, false or [] — only a confirmed-empty catchment is an exact 0.
import { stableId } from "./map/ids.mjs";
import { STATION_DEMAND_ACCESS_EXPORT_SCHEMA, STATION_DEMAND_ACCESS_INPUT_SCHEMA } from "./station-demand-access-assessment.mjs";

export const STATION_DEMAND_ALLOCATION_POLICY_SCHEMA = "transitline.station-demand-allocation-policy/1";
export const STATION_DEMAND_ALLOCATION_SCHEMA = "transitline.station-demand-allocation/1";
export const ALLOCATION_RULE_MODES = Object.freeze(["assign-all", "fixed-shares"]);
export const SHARE_EPSILON = 1e-9;

// A source resolution the map can place a node in: points, and areas (which need the policy's explicit centroid rule).
const POINT_RESOLUTIONS = new Set(["individual-demand-node", "point", "node", "building"]);
const AREA_RESOLUTIONS = new Set(["parcel", "block", "mesh-250m", "mesh-500m"]);
const COARSE_RESOLUTION = /(municipality|ward|city|prefecture|district|centroid)/i;
const COVERAGES = new Set(["not-drawn", "empty-confirmed", "empty-unseen", "unknown", "shared", "available"]);

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const uniqSorted = (list) => [...new Set(list)].sort(cmp);
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isText = (v) => typeof v === "string" && v !== "";
const finiteNonNegative = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;
const round6 = (v) => Math.round(v * 1e6) / 1e6 + 0; // + 0 turns -0 into 0
const sortedObject = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => cmp(a, b)));
const canonical = (v) => (Array.isArray(v) ? `[${v.map(canonical).join(",")}]` : isObject(v) ? `{${Object.keys(v).sort(cmp).map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}` : JSON.stringify(v ?? null));
const clone = (v) => structuredClone(v);

// --- the policy document --------------------------------------------------------------------------------------------
// raw: a policy document or null (no policy).  -> { policy: canonical copy | null, issues }.  Any issue means the whole
// document is refused: a policy is never half applied.
export function normalizeStationDemandAllocationPolicy(raw) {
  if (raw === null || raw === undefined) return { policy: null, issues: [] };
  const issues = [];
  const bad = (code, extra = {}) => issues.push({ code, ...extra });
  if (!isObject(raw) || raw.schema !== STATION_DEMAND_ALLOCATION_POLICY_SCHEMA || raw.contractVersion !== 1) return { policy: null, issues: [{ code: "policy-schema-invalid" }] };
  if (!isText(raw.policyId)) bad("policy-id-missing");
  const d = raw.defaults ?? {};
  if (!isObject(d)) bad("policy-defaults-invalid");
  const defaults = { exclusive: d?.exclusive ?? "hold", shared: d?.shared ?? "hold", areaNodeInclusion: d?.areaNodeInclusion ?? "reject" };
  if (!["hold", "assign"].includes(defaults.exclusive)) bad("policy-default-invalid", { field: "exclusive" });
  if (defaults.shared !== "hold") bad("policy-default-invalid", { field: "shared" }); // sharing is only ever by an explicit rule
  if (!["reject", "centroid"].includes(defaults.areaNodeInclusion)) bad("policy-default-invalid", { field: "areaNodeInclusion" });
  const rawRules = raw.rules ?? [];
  if (!Array.isArray(rawRules)) bad("policy-rules-invalid");
  const rules = [];
  const seenIds = new Set();
  for (const [index, r] of (Array.isArray(rawRules) ? rawRules : []).entries()) {
    const where = { rule: isText(r?.ruleId) ? r.ruleId : index };
    if (!isObject(r) || !isText(r.ruleId)) { bad("policy-rule-id-missing", { index }); continue; }
    if (seenIds.has(r.ruleId)) bad("policy-rule-id-duplicate", where);
    seenIds.add(r.ruleId);
    const s = r.scope;
    const nodeScope = isObject(s) && Array.isArray(s.demandNodeIds);
    const setScope = isObject(s) && Array.isArray(s.stationAccessIds);
    const ids = nodeScope ? s.demandNodeIds : setScope ? s.stationAccessIds : null;
    if (nodeScope === setScope || Object.keys(s).length !== 1 || !ids.length || !ids.every(isText)) { bad("policy-rule-scope-invalid", where); continue; }
    const scope = nodeScope ? { demandNodeIds: uniqSorted(ids) } : { stationAccessIds: uniqSorted(ids) };
    if (!isObject(r.boundTo) || !Object.keys(r.boundTo).length || !Object.values(r.boundTo).every(isText)) { bad("policy-rule-bound-to-invalid", where); continue; }
    const boundTo = sortedObject(r.boundTo);
    if (!ALLOCATION_RULE_MODES.includes(r.mode)) { bad("policy-rule-mode-unsupported", { ...where, mode: r.mode ?? null }); continue; }
    const rule = { ruleId: r.ruleId, scope, boundTo, mode: r.mode };
    if (r.mode === "assign-all") {
      if (!isText(r.stationAccessId) || !(r.stationAccessId in boundTo)) { bad("policy-rule-station-unbound", where); continue; }
      rule.stationAccessId = r.stationAccessId;
    } else {
      if (!isObject(r.shares) || !Object.keys(r.shares).length) { bad("policy-rule-shares-invalid", where); continue; }
      const entries = Object.entries(r.shares);
      if (!entries.every(([id, v]) => typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 1 && id in boundTo)) { bad("policy-rule-shares-invalid", where); continue; }
      if (entries.reduce((sum, [, v]) => sum + v, 0) > 1 + SHARE_EPSILON) { bad("policy-shares-exceed-one", where); continue; }
      rule.shares = sortedObject(r.shares);
    }
    if (setScope && (!scope.stationAccessIds.every((id) => id in boundTo) || (rule.shares && !Object.keys(rule.shares).every((id) => scope.stationAccessIds.includes(id))) || (rule.stationAccessId && !scope.stationAccessIds.includes(rule.stationAccessId)))) { bad("policy-rule-station-outside-scope", where); continue; }
    rules.push(rule);
  }
  // two rules that could decide the same node are refused, never "the later one wins"
  const nodeOwner = new Map();
  const setOwner = new Map();
  for (const rule of rules) {
    for (const id of rule.scope.demandNodeIds ?? []) { if (nodeOwner.has(id)) bad("policy-rule-conflict", { demandNodeId: id, rules: [nodeOwner.get(id), rule.ruleId].sort(cmp) }); nodeOwner.set(id, rule.ruleId); }
    if (rule.scope.stationAccessIds) { const key = rule.scope.stationAccessIds.join("|"); if (setOwner.has(key)) bad("policy-rule-conflict", { stationAccessIds: rule.scope.stationAccessIds, rules: [setOwner.get(key), rule.ruleId].sort(cmp) }); setOwner.set(key, rule.ruleId); }
  }
  if (issues.length) return { policy: null, issues };
  return { policy: { schema: STATION_DEMAND_ALLOCATION_POLICY_SCHEMA, contractVersion: 1, policyId: raw.policyId, defaults, rules: rules.sort((a, b) => cmp(a.ruleId, b.ruleId)) }, issues: [] };
}

export const stationDemandAllocationPolicyRevision = (policy) => stableId("station-demand-allocation-policy-revision", canonical(policy));

// An empty policy: nothing is assigned until the player says so.
export const newStationDemandAllocationPolicy = (policyId) => normalizeStationDemandAllocationPolicy({ schema: STATION_DEMAND_ALLOCATION_POLICY_SCHEMA, contractVersion: 1, policyId, defaults: {}, rules: [] }).policy;

// Saving writes the canonical text (key order and rule order do not matter); restoring validates it again and never throws.
export function serializeStationDemandAllocationPolicy(policy) {
  const { policy: normal, issues } = normalizeStationDemandAllocationPolicy(policy);
  if (issues.length) throw new Error(`Policy is not valid: ${issues.map((i) => i.code).join(", ")}`);
  return canonical(normal);
}
export function restoreStationDemandAllocationPolicy(text) {
  if (text === null || text === undefined) return { policy: null, policyRevision: null, issues: [] };
  let raw;
  try { raw = JSON.parse(text); } catch { return { policy: null, policyRevision: null, issues: [{ code: "policy-unreadable" }] }; }
  const { policy, issues } = normalizeStationDemandAllocationPolicy(raw);
  return { policy, policyRevision: policy ? stationDemandAllocationPolicyRevision(policy) : null, issues };
}

// The player confirming a rule against the access sites as they are now: the rule's `boundTo` is filled from the current
// revisions of every station it names (and every station claiming a node it targets).  This is the only way a stale rule
// becomes current again — an explicit act, never done by the allocation itself.
export function bindStationDemandAllocationRule(rule, { assessment }) {
  const revisions = new Map((assessment?.sites ?? []).map((s) => [s.stationAccessId, s.stationAccessRevision]));
  const named = new Set([...(rule.scope?.stationAccessIds ?? []), ...(rule.stationAccessId ? [rule.stationAccessId] : []), ...Object.keys(rule.shares ?? {})]);
  for (const id of rule.scope?.demandNodeIds ?? []) for (const s of assessment?.sites ?? []) if ((s.demandNodeInputs ?? []).some((n) => n.demandNodeId === id)) named.add(s.stationAccessId);
  const boundTo = {};
  for (const id of [...named].sort(cmp)) {
    if (!revisions.has(id)) throw new Error(`Station access ${id} is not in the assessment`);
    boundTo[id] = revisions.get(id);
  }
  return { ...clone(rule), boundTo };
}

// --- the allocation ------------------------------------------------------------------------------------------------
// Why a source cannot give a node to a hand-drawn catchment (the same tests as the assessment, repeated on the map export so
// an assessment that was edited or is out of date cannot let a coarse source through).
function sourceBlock(site, areaNodeInclusion) {
  const sources = Array.isArray(site?.demandSourceRefs) ? site.demandSourceRefs.filter((s) => s?.kind === "demand-points") : [];
  if (!sources.length) return { reason: "demand-points-source-missing" };
  let area = false;
  for (const s of sources) {
    if (!s.sourceId) return { reason: "demand-points-source-id-missing" };
    if (!["high", "medium"].includes(s.quality)) return { reason: "demand-source-quality-insufficient" };
    if (typeof s.spatialResolution !== "string") return { reason: "demand-source-resolution-unknown" };
    if (COARSE_RESOLUTION.test(s.spatialResolution)) return { reason: "demand-source-coarse" };
    if (AREA_RESOLUTIONS.has(s.spatialResolution)) area = true;
    else if (!POINT_RESOLUTIONS.has(s.spatialResolution)) return { reason: "demand-source-resolution-unapproved" };
  }
  if (area && areaNodeInclusion !== "centroid") return { reason: "area-footprint-unavailable" };
  return { reason: null, area };
}

function requireInputs(access, assessment) {
  if (!isObject(access) || access.schema !== STATION_DEMAND_ACCESS_EXPORT_SCHEMA || access.contractVersion !== 1 || !Array.isArray(access.sites)) throw new Error("StationDemandAccessExport v1 is required");
  if (!isObject(assessment) || assessment.schema !== STATION_DEMAND_ACCESS_INPUT_SCHEMA || assessment.contractVersion !== 1 || !Array.isArray(assessment.sites)) throw new Error("A station demand access assessment v1 is required");
  if (assessment.sourcePackId !== access.packId || assessment.sourcePackVersion !== access.packVersion) throw new Error("The assessment does not belong to this station demand access export");
}

// -> StationDemandAllocation.  `application` is the runtime's stored application ({ access, assessment }), or pass both.
// legacyAccessLinks: the engine's existing node -> station links (read only), or null when not supplied.
export function allocateStationDemand({ application = null, access = application?.access, assessment = application?.assessment, policy = null, legacyAccessLinks = null } = {}) {
  requireInputs(access, assessment);
  const { policy: pol, issues: policyIssues } = normalizeStationDemandAllocationPolicy(policy);
  const policyStatus = policy === null || policy === undefined ? "none" : policyIssues.length ? "rejected" : "valid";
  const areaNodeInclusion = pol?.defaults.areaNodeInclusion ?? "reject";
  const accessSites = new Map(access.sites.map((s) => [s.stationAccessId, s]));
  const sites = [...assessment.sites].sort((a, b) => cmp(a.stationAccessId, b.stationAccessId));
  const revisions = new Map(sites.map((s) => [s.stationAccessId, s.stationAccessRevision]));
  const assumptions = [];

  // 1. every node, with the stations that claim it (counted here, not trusted from a polygon-overlap record)
  const table = new Map();
  for (const site of sites) {
    const mapSite = accessSites.get(site.stationAccessId);
    const siteBlock = !mapSite ? "access-site-missing" : mapSite.stationAccessRevision !== site.stationAccessRevision ? "assessment-revision-mismatch" : sourceBlock(mapSite, areaNodeInclusion).reason;
    const area = Boolean(mapSite) && sourceBlock(mapSite, "centroid").area === true;
    for (const input of site.demandNodeInputs ?? []) {
      const entry = table.get(input.demandNodeId) ?? { demandNodeId: input.demandNodeId, claimants: new Set(), reasons: new Set(), values: [], sharedByAssessment: false };
      entry.claimants.add(site.stationAccessId);
      if (input.status === "unknown") entry.reasons.add(input.reason ?? "demand-node-unknown");
      else if (siteBlock) entry.reasons.add(siteBlock);
      else if (!finiteNonNegative(input.residents) || !finiteNonNegative(input.jobs)) entry.reasons.add("demand-node-values-missing");
      else entry.values.push([input.residents, input.jobs]);
      if (input.status === "shared") entry.sharedByAssessment = true;
      if (area && areaNodeInclusion === "centroid" && !assumptions.some((a) => a.stationAccessId === site.stationAccessId)) assumptions.push({ code: "area-node-centroid-inclusion", stationAccessId: site.stationAccessId });
      table.set(input.demandNodeId, entry);
    }
  }
  const nodes = [...table.values()].sort((a, b) => cmp(a.demandNodeId, b.demandNodeId)).map((e) => {
    const claimants = [...e.claimants].sort(cmp);
    if (new Set(e.values.map((v) => v.join("/"))).size > 1) e.reasons.add("demand-node-values-conflict");
    const known = e.reasons.size === 0 && e.values.length > 0;
    return {
      demandNodeId: e.demandNodeId, claimants, state: !known ? "unknown" : claimants.length > 1 || e.sharedByAssessment ? "shared" : "exclusive",
      reasons: [...e.reasons].sort(cmp), residents: known ? e.values[0][0] : null, jobs: known ? e.values[0][1] : null,
    };
  });

  // 2. which rule decides which node
  const rules = pol?.rules ?? [];
  const nodeRule = new Map(rules.flatMap((r) => (r.scope.demandNodeIds ?? []).map((id) => [id, r])));
  const setRule = new Map(rules.filter((r) => r.scope.stationAccessIds).map((r) => [r.scope.stationAccessIds.join("|"), r]));
  const staleOf = (rule) => Object.keys(rule.boundTo).filter((id) => revisions.get(id) !== rule.boundTo[id]).sort(cmp);
  const evalIssues = [];
  const warnings = [];
  const ruleLog = new Map(rules.map((r) => [r.ruleId, { ruleId: r.ruleId, scope: r.scope.demandNodeIds ? "demand-nodes" : "station-set", status: null, matchedNodeIds: [], appliedNodeIds: [], staleStationAccessIds: staleOf(r), reasons: [] }]));
  for (const rule of rules) for (const id of rule.scope.demandNodeIds ?? []) if (!table.has(id)) warnings.push({ code: "rule-node-not-claimed", ruleId: rule.ruleId, demandNodeId: id });

  const assigned = (base, ruleId, ruleBasis, shares) => {
    const sum = Object.values(shares).reduce((s, v) => s + v, 0);
    return { ...base, ruleId, ruleBasis, decision: sum >= 1 - SHARE_EPSILON ? "assigned" : "shares", assignments: Object.keys(shares).sort(cmp).map((id) => ({ stationAccessId: id, share: shares[id] })), unallocatedShare: sum >= 1 - SHARE_EPSILON ? 0 : round6(1 - sum), heldReasons: [] };
  };
  const decide = (node) => {
    const base = { ruleId: null, ruleBasis: null, assignments: [], unallocatedShare: 1 };
    if (node.state === "unknown") {
      const rule = nodeRule.get(node.demandNodeId);
      if (rule) warnings.push({ code: "policy-cannot-unlock-unknown", ruleId: rule.ruleId, demandNodeId: node.demandNodeId });
      return { ...base, decision: "unknown", unallocatedShare: null, heldReasons: [] };
    }
    if (policyStatus === "rejected") return { ...base, decision: "held", heldReasons: ["policy-rejected"] };
    const byNode = nodeRule.get(node.demandNodeId);
    const rule = byNode ?? setRule.get(node.claimants.join("|")) ?? null;
    if (rule) {
      const log = ruleLog.get(rule.ruleId);
      log.matchedNodeIds.push(node.demandNodeId);
      const changed = node.claimants.some((id) => !(id in rule.boundTo));
      if (log.staleStationAccessIds.length || changed) {
        const reason = log.staleStationAccessIds.length ? "rule-stale" : "rule-claimants-changed";
        if (!log.reasons.includes(reason)) log.reasons.push(reason);
        return { ...base, ruleId: rule.ruleId, ruleBasis: byNode ? "node-rule" : "set-rule", decision: "held", heldReasons: [reason] };
      }
      const shares = rule.mode === "assign-all" ? { [rule.stationAccessId]: 1 } : rule.shares;
      const outsider = Object.keys(shares).find((id) => !node.claimants.includes(id));
      if (outsider) { evalIssues.push({ code: "rule-station-not-claimant", ruleId: rule.ruleId, demandNodeId: node.demandNodeId, stationAccessId: outsider }); return { ...base, decision: "held", heldReasons: ["policy-rejected"] }; }
      log.appliedNodeIds.push(node.demandNodeId);
      return assigned(base, rule.ruleId, byNode ? "node-rule" : "set-rule", shares);
    }
    if (node.state === "exclusive" && pol?.defaults.exclusive === "assign") return assigned(base, null, "default", { [node.claimants[0]]: 1 });
    return { ...base, decision: "held", heldReasons: [node.state === "exclusive" ? "exclusive-needs-policy" : "shared-needs-policy"] };
  };
  let decisions = nodes.map(decide);
  let finalStatus = policyStatus;
  if (evalIssues.length) { // a rule names a station that does not claim the node: the whole policy is refused, nothing is half applied
    for (const log of ruleLog.values()) Object.assign(log, { matchedNodeIds: [], appliedNodeIds: [], reasons: [] });
    finalStatus = "rejected";
    decisions = nodes.map((n) => (n.state === "unknown" ? { ruleId: null, ruleBasis: null, assignments: [], unallocatedShare: null, decision: "unknown", heldReasons: [] } : { ruleId: null, ruleBasis: null, assignments: [], unallocatedShare: 1, decision: "held", heldReasons: ["policy-rejected"] }));
  }
  const sitesById = new Map(sites.map((s) => [s.stationAccessId, s]));
  const legacy = legacyAccessLinks === null || legacyAccessLinks === undefined ? null : (Array.isArray(legacyAccessLinks) ? legacyAccessLinks : []);
  const nodeOut = nodes.map((n, i) => {
    const d = decisions[i];
    const known = n.state !== "unknown";
    const assignments = d.assignments.map((a) => {
      const site = sitesById.get(a.stationAccessId);
      return { stationAccessId: a.stationAccessId, share: a.share, residents: round6(n.residents * a.share), jobs: round6(n.jobs * a.share), connectedPlanId: site.connectedPlanId ?? null, connectedStationId: site.connectedStationId ?? null };
    });
    // legacy links are facts about the old 800 m / zero-minute links; this module only says whether they would collide
    const links = legacy === null ? null : legacy.filter((l) => l?.demandNodeId === n.demandNodeId);
    const assignedStations = assignments.map((a) => a.connectedStationId);
    const comparable = assignments.length > 0 && assignedStations.every((s) => s !== null);
    return {
      demandNodeId: n.demandNodeId, claimants: n.claimants, state: n.state, decision: d.decision, ruleId: d.ruleId, ruleBasis: d.ruleBasis,
      reasons: known ? d.heldReasons : n.reasons, residents: n.residents, jobs: n.jobs, assignments, unallocatedShare: d.unallocatedShare,
      unallocated: known ? { residents: round6(n.residents * d.unallocatedShare), jobs: round6(n.jobs * d.unallocatedShare) } : null,
      legacy: links === null ? { supplied: false, linkCount: null, stationIds: null, conflictsWithAllocation: null, overrideRequired: null, activeWhileUnallocated: null } : {
        supplied: true, linkCount: links.length, stationIds: uniqSorted(links.map((l) => l.stationId)),
        conflictsWithAllocation: assignments.length === 0 ? false : comparable ? links.some((l) => !assignedStations.includes(l.stationId)) : null,
        overrideRequired: assignments.length > 0 && links.length > 0,
        activeWhileUnallocated: known ? d.unallocatedShare > 0 && links.length > 0 : null,
      },
    };
  });

  // 3. per station.  A total is null where nothing could be seen (not drawn, or a source that cannot see nodes), an exact 0 only
  // where the catchment is confirmed empty, and a class with no known member stays null while some node is still unknown.
  const stationOut = sites.map((site) => {
    const mine = nodeOut.filter((n) => n.claimants.includes(site.stationAccessId));
    const coverage = COVERAGES.has(site.catchmentStatus) ? site.catchmentStatus : "unknown";
    const knownNodes = mine.filter((n) => n.state !== "unknown");
    const unknownNodeCount = mine.length - knownNodes.length;
    const total = (rows, pick) => ({ residents: round6(rows.reduce((s, r) => s + pick(r).residents, 0)), jobs: round6(rows.reduce((s, r) => s + pick(r).jobs, 0)) });
    const share = (n) => n.assignments.find((a) => a.stationAccessId === site.stationAccessId);
    const cls = (rows, pick) => (rows.length || unknownNodeCount === 0 ? total(rows, pick) : null);
    const nothingSeen = coverage === "not-drawn" || coverage === "empty-unseen";
    const zero = { residents: 0, jobs: 0 };
    const out = coverage === "empty-confirmed" ? { allocated: { ...zero }, heldExclusive: { ...zero }, sharedUnallocated: { ...zero } } : nothingSeen ? { allocated: null, heldExclusive: null, sharedUnallocated: null } : {
      allocated: cls(knownNodes.filter((n) => share(n)), (n) => share(n)),
      heldExclusive: cls(knownNodes.filter((n) => n.state === "exclusive" && n.unallocatedShare > 0), (n) => n.unallocated),
      sharedUnallocated: cls(knownNodes.filter((n) => n.state === "shared" && n.unallocatedShare > 0), (n) => n.unallocated),
    };
    return { stationAccessId: site.stationAccessId, stationAccessRevision: site.stationAccessRevision, coverage, ...out, unknownNodeCount, complete: !nothingSeen && unknownNodeCount === 0, reasons: uniqSorted(mine.flatMap((n) => n.reasons)) };
  });

  const rulesOut = [...ruleLog.values()].sort((a, b) => cmp(a.ruleId, b.ruleId)).map((log) => {
    const stale = log.staleStationAccessIds.length > 0 || log.reasons.includes("rule-claimants-changed");
    return { ...log, matchedNodeIds: uniqSorted(log.matchedNodeIds), appliedNodeIds: uniqSorted(log.appliedNodeIds), status: finalStatus === "rejected" ? "rejected" : stale ? "stale" : log.appliedNodeIds.length ? "applied" : "unmatched" };
  });
  const count = (f) => nodeOut.filter(f).length;
  const ids = (f) => (legacy === null ? null : nodeOut.filter(f).map((n) => n.demandNodeId));
  const policyRevision = pol ? stationDemandAllocationPolicyRevision(pol) : null;
  return {
    schema: STATION_DEMAND_ALLOCATION_SCHEMA, contractVersion: 1,
    allocationId: stableId("station-demand-allocation", access.packId, access.packVersion ?? "", policyRevision ?? "none", ...sites.map((s) => `${s.stationAccessId}@${s.stationAccessRevision}`)),
    sourcePackId: access.packId, sourcePackVersion: access.packVersion ?? null,
    policyId: pol?.policyId ?? null, policyRevision, policyStatus: finalStatus, policyIssues: [...policyIssues, ...evalIssues],
    status: finalStatus === "rejected" ? "policy-rejected" : rulesOut.some((r) => r.status === "stale") ? "stale" : "current",
    nodes: nodeOut, stations: stationOut, rules: rulesOut,
    totals: { nodes: nodeOut.length, exclusive: count((n) => n.state === "exclusive"), shared: count((n) => n.state === "shared"), unknown: count((n) => n.state === "unknown"), assigned: count((n) => n.decision === "assigned"), partlyAssigned: count((n) => n.decision === "shares"), held: count((n) => n.decision === "held") },
    legacy: { supplied: legacy !== null, nodesWithLegacyLinks: ids((n) => n.legacy.linkCount > 0), overrideRequiredNodeIds: ids((n) => n.legacy.overrideRequired), conflictNodeIds: ids((n) => n.legacy.conflictsWithAllocation === true) },
    assumptions: assumptions.sort((a, b) => cmp(a.stationAccessId, b.stationAccessId)),
    warnings: warnings.sort((a, b) => cmp(canonical(a), canonical(b))),
  };
}
