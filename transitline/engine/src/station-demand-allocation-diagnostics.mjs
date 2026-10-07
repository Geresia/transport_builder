// B15-E6: a read-only account of what the fractional demand routing (B15-E5) is actually doing.
//
// It reads the applied allocation links, the stored application and the schedule's counters, and says, for every node whose trips
// are split between stations: the shares that were configured, how many picks each station really got (for the origin role and
// for the destination role, which are counted separately), what share no station takes and why, and what became of the trips that
// picked a station.  It also says, plainly, what the router's known limits mean for the state it is looking at.
//
// What it is not: it computes no demand, ridership, fare, cost, crowding or number of people; it counts selections.  It draws no
// random number, reads no clock, touches no management state, and writes nothing — not even the lazily created counters the router
// keeps.  Every figure comes from the state as it is; what the state cannot say is reported as unobserved, never guessed.
import { ALLOCATION_SCHEDULE, appliedAllocationLinksByDemandNode, splitOf } from "./access-demand.mjs";

export const STATION_DEMAND_ALLOCATION_DIAGNOSTICS_SCHEMA = "transitline.station-demand-allocation-diagnostics/1";

const { micro: MICRO, nobodySlotId: NOBODY } = ALLOCATION_SCHEDULE;
const OUTCOMES = Object.freeze(["routed", "partnerNobody", "partnerNoAccess", "sameStation", "noRoute"]);
const ROLES = Object.freeze(["origin", "destination"]);
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const round6 = (value) => Math.round(value * 1e6) / 1e6 + 0; // + 0 turns -0 into 0
const isCount = (value) => Number.isSafeInteger(value) && value >= 0;
const sum = (list) => list.reduce((total, value) => total + value, 0);

// Why a stored allocation link is not used by the router (the same checks, in the same order, as the router's own filter).
// A link with no reason is a usable one; the tests hold this to the router's answer.
export function allocationLinkIssue(state, link) {
  if (!state.demandNodes?.has?.(link?.demandNodeId)) return "demand-node-missing";
  if (!state.stations?.has?.(link?.stationId)) return "station-missing";
  if (!(link.walkMinutes > 0) || !Number.isFinite(link.walkMinutes)) return "walk-minutes-invalid";
  const share = link.share === undefined ? 1 : link.share;
  if (!Number.isFinite(share) || !(share > 0) || share > 1) return "share-invalid";
  return null;
}

function compositionOf(application, nodeId, remainderMicro, dropped) {
  const remainder = round6(remainderMicro / MICRO);
  if (!application) return { source: null, reason: "no-application", remainderShare: remainder, unallocatedByPolicy: null, blockedAtApply: [], droppedSinceApply: dropped, unexplainedShare: null };
  const allocationNode = (application.allocation?.nodes ?? []).find((node) => node?.demandNodeId === nodeId);
  const policyShare = Number.isFinite(allocationNode?.unallocatedShare) ? allocationNode.unallocatedShare : null;
  const blocked = (application.blockedLinks ?? []).filter((entry) => entry?.demandNodeId === nodeId)
    .map((entry) => ({ stationAccessId: entry.stationAccessId ?? null, code: entry.code ?? null, share: Number.isFinite(entry.share) ? entry.share : null }))
    .sort((a, b) => cmp(`${a.stationAccessId}|${a.code}`, `${b.stationAccessId}|${b.code}`));
  const known = policyShare !== null && blocked.every((entry) => entry.share !== null) && dropped.every((entry) => entry.share !== null);
  const explained = known ? round6(policyShare + sum(blocked.map((entry) => entry.share)) + sum(dropped.map((entry) => entry.share))) : null;
  return {
    source: "application", reason: null, remainderShare: remainder, unallocatedByPolicy: policyShare, blockedAtApply: blocked, droppedSinceApply: dropped,
    // a remainder the parts do not add up to (rounding, or links edited after the application) shows here instead of being absorbed
    unexplainedShare: explained === null ? null : round6(remainder - explained),
  };
}

function roleReport(role, split, cursor) {
  const base = { role, signature: split.signature };
  const stationSlots = split.slots.filter((slot) => slot.id !== NOBODY);
  const slotRow = (slot, total, taken, outcomes) => {
    const picks = taken[slot.id] ?? 0;
    const expected = round6((total * slot.micro) / MICRO);
    const deviation = round6(picks - expected);
    return {
      slotId: slot.id, kind: slot.id === NOBODY ? "no-station-share" : "station", stationId: slot.stationId, walkMinutes: slot.walkMinutes,
      configuredMicro: slot.micro, configuredShare: round6(slot.micro / MICRO), picks, expectedPicks: expected, deviationPicks: deviation,
      // the router's guarantee: after n trips every slot is within one pick of n x share
      withinOnePick: Math.abs(deviation) < 1 + 1e-6,
      outcomes: slot.id === NOBODY ? null : outcomes?.[slot.id] ? Object.fromEntries(OUTCOMES.map((name) => [name, outcomes[slot.id][name] ?? 0])) : null,
    };
  };
  if (!cursor) {
    // no trip has used this role yet: the zeros are a fact, not an unknown
    return { ...base, cursor: "absent", total: 0, previous: null, slots: split.slots.map((slot) => slotRow(slot, 0, {}, null)), trips: tripsOf(stationSlots, {}, null, 0) };
  }
  if (cursor.signature !== split.signature) {
    // the shares changed after these were counted: the router starts this node's count again on its next trip
    return { ...base, cursor: "restarts-on-next-trip", total: 0, previous: { signature: cursor.signature ?? null, total: isCount(cursor.total) ? cursor.total : null }, slots: split.slots.map((slot) => slotRow(slot, 0, {}, null)), trips: tripsOf(stationSlots, {}, null, 0) };
  }
  const taken = cursor.taken ?? {};
  const total = isCount(cursor.total) ? cursor.total : 0;
  const slots = split.slots.map((slot) => slotRow(slot, total, taken, cursor.outcomes));
  const picked = sum(split.slots.map((slot) => taken[slot.id] ?? 0));
  return { ...base, cursor: picked === total ? "present" : "inconsistent", total, previous: null, slots, trips: tripsOf(stationSlots, taken, cursor.outcomes, total) };
}

// What the picks of one role turned into.  `exact` only when every station pick has its outcome counted (a save made before the
// counters existed has picks without outcomes: then the figures are lower bounds, or null when nothing was counted at all).
function tripsOf(stationSlots, taken, outcomes, total) {
  const nobody = taken[NOBODY] ?? 0;
  const counted = Object.fromEntries(OUTCOMES.map((name) => [name, sum(stationSlots.map((slot) => outcomes?.[slot.id]?.[name] ?? 0))]));
  const stationPicks = sum(stationSlots.map((slot) => taken[slot.id] ?? 0));
  const countedPicks = sum(Object.values(counted));
  const exact = countedPicks === stationPicks;
  const coverage = exact ? "complete" : countedPicks === 0 ? "none" : "partial";
  const none = coverage === "none";
  return {
    picks: total, coverage, exact,
    routed: none ? null : counted.routed,
    unrouted: none ? null : nobody + counted.partnerNobody + counted.partnerNoAccess + counted.sameStation + counted.noRoute,
    // every unrouted trip appears under exactly one reason
    unroutedByReason: {
      noStationShare: nobody,
      partnerNobody: none ? null : counted.partnerNobody,
      partnerNoAccess: none ? null : counted.partnerNoAccess,
      sameStation: none ? null : counted.sameStation,
      noRoute: none ? null : counted.noRoute,
    },
  };
}

const limit = (code, status, text, evidence = null) => ({ code, status, text, evidence });

export function buildStationDemandAllocationDiagnostics(operationalState) {
  const state = operationalState ?? {}; // a runtime without an operational state simply has no allocation to describe
  const links = Array.isArray(state?.stationDemandAllocationLinks) ? state.stationDemandAllocationLinks : [];
  const application = state?.stationDemandAllocationApplication ?? null;
  const cursors = state?.stationDemandAllocationCursors ?? null;
  const currentAccessId = state?.stationDemandAccessApplication?.applicationId ?? null;
  const stale = Boolean(application) && (application.status === "stale" || (currentAccessId !== null && application.accessApplicationId !== currentAccessId));
  const status = !application && !links.length ? "no-allocation" : !application ? "links-without-application" : stale ? "stale" : "current";

  // every stored link, by node, with the reason the router would not use it (if any)
  const byNode = new Map();
  for (const link of links) {
    const nodeId = link?.demandNodeId;
    if (typeof nodeId !== "string") continue;
    const row = byNode.get(nodeId) ?? { issues: [] };
    const issue = allocationLinkIssue(state, link);
    if (issue) row.issues.push({ stationId: typeof link.stationId === "string" ? link.stationId : null, reason: issue, share: Number.isFinite(link.share) ? link.share : link.share === undefined ? 1 : null });
    byNode.set(nodeId, row);
  }
  const usable = appliedAllocationLinksByDemandNode(state);

  const nodes = [];
  const usedKeys = new Set();
  for (const nodeId of [...byNode.keys()].sort(cmp)) {
    const issues = byNode.get(nodeId).issues.sort((a, b) => cmp(`${a.stationId}|${a.reason}`, `${b.stationId}|${b.reason}`));
    const row = usable.get(nodeId);
    if (!row?.length) {
      // every link of the node is unusable: the router treats it as having none, and the node keeps its old (legacy) access
      nodes.push({ demandNodeId: nodeId, routing: "legacy-fallback", droppedLinks: issues, configured: null, roles: null });
      continue;
    }
    const split = splitOf(row);
    if (!split) {
      nodes.push({ demandNodeId: nodeId, routing: "single-station", droppedLinks: issues, configured: { stations: row.map((link) => ({ stationId: link.stationId, walkMinutes: link.walkMinutes, share: link.share })).sort((a, b) => cmp(a.stationId, b.stationId)) }, roles: null });
      continue;
    }
    const remainder = split.slots.find((slot) => slot.id === NOBODY)?.micro ?? 0;
    const roles = {};
    for (const role of ROLES) { usedKeys.add(`${role}|${nodeId}`); roles[role] = roleReport(role, split, cursors?.[`${role}|${nodeId}`]); }
    nodes.push({
      demandNodeId: nodeId, routing: "split", droppedLinks: issues,
      configured: {
        signature: split.signature, stations: split.slots.filter((slot) => slot.id !== NOBODY).map((slot) => ({ stationId: slot.stationId, walkMinutes: slot.walkMinutes, share: round6(slot.micro / MICRO), micro: slot.micro })),
        noStationShare: round6(remainder / MICRO), noStationComposition: remainder > 0 || issues.length ? compositionOf(application, nodeId, remainder, issues.map((entry) => ({ stationId: entry.stationId, reason: entry.reason, share: entry.share }))) : null,
      },
      roles,
    });
  }
  const orphanCursors = Object.keys(cursors ?? {}).filter((key) => !usedKeys.has(key)).sort(cmp).map((key) => ({ key, total: isCount(cursors[key]?.total) ? cursors[key].total : null }));

  const splitNodes = nodes.filter((node) => node.routing === "split");
  const roleTrips = (role) => {
    const reports = splitNodes.map((node) => node.roles[role].trips);
    const exact = reports.every((trips) => trips.exact);
    const partsKnown = reports.every((trips) => trips.coverage !== "none");
    const add = (pick) => (partsKnown ? sum(reports.map(pick)) : null);
    return {
      picks: sum(reports.map((trips) => trips.picks)), exact, routed: add((t) => t.routed), unrouted: add((t) => t.unrouted),
      unroutedByReason: {
        noStationShare: sum(reports.map((t) => t.unroutedByReason.noStationShare)), partnerNobody: add((t) => t.unroutedByReason.partnerNobody), partnerNoAccess: add((t) => t.unroutedByReason.partnerNoAccess),
        sameStation: add((t) => t.unroutedByReason.sameStation), noRoute: add((t) => t.unroutedByReason.noRoute),
      },
    };
  };
  const totals = {
    splitNodes: splitNodes.length, singleStationNodes: nodes.filter((n) => n.routing === "single-station").length, legacyFallbackNodes: nodes.filter((n) => n.routing === "legacy-fallback").length,
    // a trip has one origin and one destination: figures are given per role and never added across roles
    byRole: { origin: roleTrips("origin"), destination: roleTrips("destination") },
  };

  // --- the router's known limits, said about this very state ---
  const unroutedSeen = (role) => totals.byRole[role].unrouted ?? totals.byRole[role].unroutedByReason.noStationShare;
  const sameSeen = (role) => totals.byRole[role].unroutedByReason.sameStation ?? 0;
  const anyUnrouted = unroutedSeen("origin") + unroutedSeen("destination");
  const remainderNodes = splitNodes.filter((node) => node.configured.noStationShare > 0).map((node) => node.demandNodeId);
  const stationUse = new Map();
  for (const node of nodes) for (const station of node.configured?.stations ?? []) stationUse.set(station.stationId, [...(stationUse.get(station.stationId) ?? []), node.demandNodeId]);
  const sharedStations = [...stationUse.entries()].filter(([, users]) => new Set(users).size > 1 && users.some((id) => splitNodes.some((node) => node.demandNodeId === id))).map(([stationId, users]) => ({ stationId, demandNodeIds: [...new Set(users)].sort(cmp) })).sort((a, b) => cmp(a.stationId, b.stationId));
  const partlyBlocked = splitNodes.filter((node) => (node.configured.noStationComposition?.blockedAtApply.length ?? 0) + node.droppedLinks.length > 0).map((node) => node.demandNodeId);
  const rolesIncomplete = splitNodes.flatMap((node) => ROLES.filter((role) => !node.roles[role].trips.exact).map((role) => `${role}|${node.demandNodeId}`));
  const legacy = nodes.filter((node) => node.routing === "legacy-fallback");
  const hasSplit = splitNodes.length > 0;
  const limits = [
    limit("unrouted-trips-shift-the-random-stream", anyUnrouted > 0 ? "observed" : remainderNodes.length || sharedStations.length ? "latent" : "none",
      "경로 없음으로 끝난 승객은 교통수단 선택에서 난수를 1개 덜 씁니다. 그래서 배분되지 않은 몫이나 같은 역 선택이 있으면 이후 난수 흐름이 달라져, 실현된 발생 수가 100% 배정 실행과 달라질 수 있습니다. 기대 발생량(rate)과 목적지 선택 규칙은 그대로입니다.",
      { unroutedPicksSeen: { origin: unroutedSeen("origin"), destination: unroutedSeen("destination") }, nodesWithNoStationShare: remainderNodes, stationsSharedByNodes: sharedStations }),
    limit("same-station-trips", sameSeen("origin") + sameSeen("destination") > 0 ? "observed" : sharedStations.length ? "latent" : "none",
      "출발 노드와 도착 노드가 뽑은 역이 같으면 대중교통 경로가 없어 그 승객은 경로 없음입니다. 비율을 지키려고 다른 역으로 바꾸지 않습니다.",
      { observed: { origin: sameSeen("origin"), destination: sameSeen("destination") }, stationsSharedByNodes: sharedStations }),
    limit("share-without-station-is-not-routed", partlyBlocked.length ? "active" : "none",
      "쓸 수 있는 링크가 없는 몫(막힌 역·사라진 역·무효 링크)은 다른 역이나 기존 접근으로 가지 않고 경로 없음이 됩니다.", { demandNodeIds: partlyBlocked }),
    limit("all-links-unusable-falls-back-to-legacy", legacy.length ? "active" : "none",
      "노드의 배분 링크가 전부 쓸 수 없으면 라우터는 정책이 없는 것으로 보고 기존 접근(0분 레거시·800 m 링크)으로 돌아갑니다. 이때는 경로 없음이 아니라 정책 밖의 경로가 쓰입니다.",
      { demandNodeIds: legacy.map((node) => node.demandNodeId), reasons: Object.fromEntries(legacy.map((node) => [node.demandNodeId, node.droppedLinks])) }),
    limit("outcome-counters-incomplete", rolesIncomplete.length ? "active" : "none",
      "경로 없음 사유 집계는 카운터가 생긴 뒤의 선택만 셉니다. 그 전에 저장된 선택은 선택 수만 있고 결과가 없어 사유를 알 수 없습니다(값은 하한 또는 null).", { roles: rolesIncomplete }),
    limit("counts-restart-with-the-links", hasSplit ? "info" : "none",
      "선택 수는 링크를 다시 적용하거나 비율이 바뀐 시점부터 셉니다. 게임 시작부터의 누적이 아닙니다.", null),
    limit("schedule-follows-call-order", hasSplit ? "info" : "none",
      "일정은 노드·역할별로 승객 경로를 정하는 호출 순서에 묶입니다. 같은 시드와 같은 호출 순서면 같은 선택입니다.", null),
    limit("application-is-stale", stale ? "active" : "none",
      "지도 접근권이 바뀐 뒤에도 링크와 일정은 그대로 쓰이고, 다시 적용해야 갱신됩니다.", application ? { accessApplicationId: application.accessApplicationId ?? null, currentAccessApplicationId: currentAccessId } : null),
    limit("mode-choice-is-not-observed", hasSplit ? "info" : "none",
      "역을 얻은 승객도 교통수단 선택에서 걷기·자동차를 고를 수 있습니다. 이 보고서는 역 선택과 경로 유무까지만 봅니다.", null),
    limit("counts-selections-not-demand", "info",
      "이 보고서의 숫자는 선택 횟수입니다. 수요량·승객 수·운임·비용·혼잡을 계산하거나 바꾸지 않습니다.", null),
  ];

  return {
    schema: STATION_DEMAND_ALLOCATION_DIAGNOSTICS_SCHEMA, contractVersion: 1, status,
    application: application ? {
      applicationId: application.applicationId ?? null, status: stale ? "stale" : application.status ?? null, staleReasons: Array.isArray(application.staleReasons) ? [...application.staleReasons] : [],
      appliedAtSimMinute: Number.isFinite(application.appliedAtSimMinute) ? application.appliedAtSimMinute : null, accessApplicationId: application.accessApplicationId ?? null, currentAccessApplicationId: currentAccessId,
      linksMatchApplication: JSON.stringify(links) === JSON.stringify(application.links ?? []),
    } : null,
    totals, nodes, orphanCursors, limits,
  };
}
