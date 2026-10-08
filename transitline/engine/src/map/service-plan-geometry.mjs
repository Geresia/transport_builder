// Service plan geometry (see docs/b16-m1-service-plan-geometry-2026-10-08.md): what the player WANTS to run on a rail
// geometry — which sections, in which direction, in which time bands, how often, with how many cars, turning back where —
// kept apart from the spatial FACTS the map can read about those sections (track count, blocks, junctions, terminals and
// whether they join). Whether the wish can be run, how often trains really fit, demand, fares, cost, crowding, punctuality
// and timetables belong to the management engine; this module never imports it and never reads or writes its state.
//
// Names that start with `player` and the `playerInputs` block are statements; `route.sections`, `route.links`,
// `terminals`, `turnbacks[].facilityFacts` and `spatialFacts` are read from the rail capacity geometry. Missing data: a
// value that cannot be known is `null`, its name is in `unknown[]` and the reason in `unknownReasons` (always 1:1) — never
// 0, false or []. `[]` is a declared or measured "none"; `0` is a stated or counted zero.
import { stableId, roundTo } from "./ids.mjs";
import { qualityOf, worse } from "./local-geometry.mjs";
import { RAIL_CAPACITY_GEOMETRY_SCHEMA } from "./rail-capacity-geometry.mjs";

export const SERVICE_PLAN_SCHEMA = "transitline.service-plan-geometry/1";
export const SERVICE_PLAN_EXPORT_SCHEMA = "transitline.service-plan-export/1";
export const PLAN_KINDS = Object.freeze(["regular", "disruption-response"]);
export const OPERATING_PATTERNS = Object.freeze(["full", "short-turn", "partial-section"]);
export const TURNBACK_INTENTS = Object.freeze(["route-end", "intermediate"]);
export const DEPOT_ROLES = Object.freeze(["pull-in", "pull-out", "both"]);
export const MINUTES_PER_DAY = 1440;

function byText(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
// A plan the player saved has a key; its id follows the key, so editing, reopening and restoring keep it. Without a key the
// id comes from the pack, the geometry, the plan kind and the SET of sections (sorted): drawing the route the other way
// round, or listing the sections in another order, keeps the id; changing the sections or the kind makes another plan.
export const keyedServicePlanId = (packId, key) => stableId("service-plan", packId, "key", key);
export const keylessServicePlanId = (packId, railGeometryId, planKind, sectionIds) => stableId("service-plan", packId, railGeometryId, planKind ?? "kind-not-stated", ...[...new Set(sectionIds)].sort(byText));

const hasKey = (v) => v !== undefined && v !== null && v !== "";
const sortedObject = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => byText(a, b)));
const text = (v) => (v === undefined || v === null ? null : String(v));
const uniqueSorted = (list) => [...new Set(list)].sort(byText);
const isInt = (v, min) => Number.isInteger(v) && v >= min;
const triState = (values) => (values.includes(false) ? false : values.every((v) => v === true) ? true : null);
const marks = () => {
  const unknown = {};
  return { mark: (field, reason) => { unknown[field] = reason; }, done: () => ({ unknown: Object.keys(unknown).sort(byText), unknownReasons: sortedObject(unknown) }) };
};
const NO_ALIGNMENT = "external-alignment-not-in-source";
const SECTION_FACT_FIELDS = ["directionMode", "blockIds", "junctionResourceIds", "lengthMeters", "minimumCurveRadiusMeters", "groundGradientPermille"];

// How the sections the player listed follow one another: consecutive sections share a station (or do not), and the
// stations in the order the player's section order runs through them (null when that order cannot be read).
function chainOf(sections, preferredStart) {
  const links = [];
  for (let i = 1; i < sections.length; i++) {
    const [a, b] = [sections[i - 1], sections[i]];
    links.push({ a, b, shared: uniqueSorted([a.fromStationId, a.toStationId].filter((id) => id === b.fromStationId || id === b.toStationId)) });
  }
  let start = null;
  if (sections.length === 1) start = preferredStart === sections[0].toStationId ? sections[0].toStationId : sections[0].fromStationId; // a lone section runs from its own first station unless the player started it at the other end
  else if (sections.length > 1 && links[0].shared.length === 1) start = links[0].a.fromStationId === links[0].shared[0] ? links[0].a.toStationId : links[0].a.fromStationId;
  let stationIds = null;
  if (start !== null && links.every((l) => l.shared.length === 1)) {
    stationIds = [start];
    for (const s of sections) {
      const here = stationIds.at(-1);
      if (s.fromStationId === here) stationIds.push(s.toStationId);
      else if (s.toStationId === here) stationIds.push(s.fromStationId);
      else { stationIds = null; break; }
    }
  }
  return { links, stationIds };
}

// drawn: { key?, name?, active?, planKind?, operatingPattern?, railGeometryId, designedRailGeometryRevision?, operationalLineId?,
//          route?: null | { sectionIds: [ordered], fromStationId?, toStationId? },
//          directions?: null | [{ key?, label?, fromStationId, toStationId }],
//          serviceBands?: null | [{ key?, label?, startMinute, endMinute, periodId?, directionKeys?, active?, headwayMinutes?, trainsets?, formationCars?, note? }],
//          turnbacks?: null | [{ key?, stationId, intent?, terminalResourceId?, turnbackCandidateId? }],
//          vehicleIntent?: { vehicleModelId?, requestedCars?, requestedTrainsets? }, assumptions?: [{ key?, text }],
//          depotRefs?: null | [{ key?, depotSiteId?, stationId?, role? }] }
//   absent / null = not stated (unknown); [] = the player states "none".
// ctx:   { pack, railGeometry: RailCapacityGeometry v1, application?: rail-capacity-application/1 }
// -> { plan, warnings }; plan is null when the statement cannot be tied to the geometry.
export function buildServicePlan(drawn, ctx) {
  const packId = ctx.pack.manifest?.id ?? "pack";
  const geometry = ctx.railGeometry;
  const reject = (code, extra = {}) => ({ plan: null, warnings: [{ code, key: drawn?.key ?? null, ...extra }] });
  if (geometry?.schema !== RAIL_CAPACITY_GEOMETRY_SCHEMA || geometry.contractVersion !== 1) return reject("rail-geometry-schema-invalid", { schema: geometry?.schema ?? null });
  if (geometry.sourcePackId !== packId) return reject("rail-geometry-other-pack", { geometryPackId: geometry.sourcePackId ?? null });
  if (!hasKey(drawn?.railGeometryId) || drawn.railGeometryId !== geometry.railGeometryId) return reject("rail-geometry-mismatch", { drawnRailGeometryId: drawn?.railGeometryId ?? null, railGeometryId: geometry.railGeometryId });
  const route = drawn.route ?? null;
  if (route !== null && !Array.isArray(route.sectionIds)) return reject("route-sections-invalid");
  const routeIds = route ? route.sectionIds.map(String) : null;
  if (routeIds && new Set(routeIds).size !== routeIds.length) return reject("route-section-duplicate", { sectionIds: uniqueSorted(routeIds.filter((id, i) => routeIds.indexOf(id) !== i)) });
  if (!hasKey(drawn.key) && !routeIds?.length) return reject("key-or-sections-required");
  const planKind = PLAN_KINDS.includes(drawn.planKind) ? drawn.planKind : null;
  const servicePlanId = hasKey(drawn.key) ? keyedServicePlanId(packId, drawn.key) : keylessServicePlanId(packId, geometry.railGeometryId, planKind, routeIds);

  const warnings = [];
  const warn = (code, extra = {}) => warnings.push({ code, key: hasKey(drawn.key) ? drawn.key : null, ...extra });
  const top = marks();
  const oneOf = (field, allowed) => {
    const value = allowed.includes(drawn[field]) ? drawn[field] : null;
    if (value === null && drawn[field] !== undefined && drawn[field] !== null) warn(`${field}-invalid`, { value: String(drawn[field]) });
    if (value === null) top.mark(field, `${field}-not-stated`);
    return value;
  };
  const planKindStated = oneOf("planKind", PLAN_KINDS);
  const operatingPattern = oneOf("operatingPattern", OPERATING_PATTERNS);
  if (geometry.sourcePackVersion !== (ctx.pack.manifest?.version ?? null)) warn("pack-version-mismatch", { geometryPackVersion: geometry.sourcePackVersion ?? null, packVersion: ctx.pack.manifest?.version ?? null });

  // --- revision: the player's statement only counts against the geometry revision it was made on ---
  const designed = drawn.designedRailGeometryRevision ?? null;
  const revisionState = designed === null ? "not-recorded" : designed === geometry.railGeometryRevision ? "current" : "stale";
  if (revisionState !== "current") warn(revisionState === "stale" ? "revision-stale" : "revision-not-recorded", { designedRailGeometryRevision: designed, railGeometryRevision: geometry.railGeometryRevision });

  // --- the capacity application: only the one made for this geometry and the line the plan names ---
  const operationalLineId = text(drawn.operationalLineId);
  const supplied = operationalLineId === null ? null : ctx.application ?? null;
  const application = supplied && supplied.railGeometryId === geometry.railGeometryId && text(supplied.operationalLineId) === operationalLineId ? supplied : null;
  if (supplied && !application) warn("application-other-line-or-geometry", { applicationLineId: text(supplied.operationalLineId) });
  const applicationState = application ? (application.railGeometryRevision === geometry.railGeometryRevision ? "current" : "stale") : null;
  if (applicationState === "stale") warn("application-stale", { applicationRailGeometryRevision: application.railGeometryRevision ?? null, railGeometryRevision: geometry.railGeometryRevision });
  const applicationWhy = operationalLineId === null ? "operational-line-not-stated" : applicationState === null ? "capacity-application-not-supplied" : applicationState === "stale" ? "capacity-application-stale" : null;
  if (operationalLineId === null) top.mark("operationalLineId", "operational-line-not-stated");
  if (applicationState === null) for (const f of ["capacityApplicationId", "capacityApplicationRevision"]) top.mark(f, applicationWhy); // a stale application still names the revision it was made for
  const trackOf = new Map(applicationState === "current" ? (application.sections ?? []).map((s) => [s.railCapacitySectionId, text(s.trackSegmentId)]) : []);

  // --- route: the sections the player chose, in the order they chose them ---
  const bySection = new Map();
  for (const s of geometry.sections) bySection.set(s.sectionId, bySection.has(s.sectionId) ? null : s);
  const found = routeIds ? routeIds.map((id) => bySection.get(id) ?? null) : null;
  const missingSectionIds = routeIds ? routeIds.filter((id, i) => found[i] === null) : null;
  if (missingSectionIds?.length) warn("route-section-missing", { sectionIds: uniqueSorted(missingSectionIds) });
  const complete = found !== null && missingSectionIds.length === 0;
  const sections = complete ? found : [];
  const chain = complete ? chainOf(sections, text(route?.fromStationId)) : { links: [], stationIds: null };
  const stationIds = chain.stationIds;
  const knownEnds = stationIds ? [stationIds[0], stationIds.at(-1)] : null;
  const orderWhy = routeIds === null ? "route-not-selected" : !complete ? "route-section-missing" : chain.links.some((l) => l.shared.length === 0) ? "route-sections-share-no-station" : "route-station-order-ambiguous";
  const rm = marks();
  if (routeIds === null) rm.mark("sectionIds", "route-not-selected");
  if (!knownEnds) for (const f of ["stationIds", "fromStationId", "toStationId"]) rm.mark(f, orderWhy);
  for (const [field, given, end] of [["fromStationId", route?.fromStationId, knownEnds?.[0]], ["toStationId", route?.toStationId, knownEnds?.[1]]]) {
    if (hasKey(given) && knownEnds && given !== end) warn("route-endpoint-differs", { field, stated: String(given), fromRoute: end });
  }
  const links = chain.links.map(({ a, b, shared }) => {
    const lm = marks();
    const via = shared.length === 1 ? shared[0] : null;
    let physicalJoin = null;
    if (shared.length !== 1) lm.mark("viaStationId", shared.length === 0 ? "sections-share-no-station" : "several-shared-stations");
    if (!a.alignment || !b.alignment) lm.mark("physicalJoin", NO_ALIGNMENT); // a section without an alignment cannot be shown to meet anything
    else if (shared.length === 0) {
      // no common station: the alignments alone can still show that the two ends meet
      const ends = a.ends ?? [];
      if (ends.some((e) => e.joinedSectionIds?.includes(b.sectionId))) physicalJoin = true;
      else if (ends.length && ends.every((e) => e.state !== null)) physicalJoin = false;
      else lm.mark("physicalJoin", ends.find((e) => e.state === null)?.unknownReasons?.state ?? "join-state-not-in-geometry");
    }
    else if (via === null) lm.mark("physicalJoin", "several-shared-stations");
    else {
      const end = a.ends?.find((e) => e.stationId === via) ?? null;
      if (!end || end.state === null) lm.mark("physicalJoin", end?.unknownReasons?.state ?? "join-state-not-in-geometry");
      else physicalJoin = end.state === true ? end.joinedSectionIds.includes(b.sectionId) : false;
    }
    return { fromSectionId: a.sectionId, toSectionId: b.sectionId, viaStationId: via, sharedStation: shared.length > 0, physicalJoin, ...lm.done() };
  });
  const stationsShared = complete ? triState(chain.links.map((l) => l.shared.length > 0)) : null;
  const physicallyJoined = complete ? triState(links.map((l) => l.physicalJoin)) : null;
  const externalSectionIds = complete ? sections.filter((s) => s.sourceKind === "external").map((s) => s.sectionId).sort(byText) : null;
  const omittedSectionIds = routeIds ? geometry.sections.map((s) => s.sectionId).filter((id) => !routeIds.includes(id)).sort(byText) : null;
  if (stationsShared === null) rm.mark("stationsShared", orderWhy);
  if (physicallyJoined === null) rm.mark("physicallyJoined", complete ? "join-state-not-in-geometry" : orderWhy);
  if (externalSectionIds === null) rm.mark("includesExternal", orderWhy);
  if (omittedSectionIds === null) rm.mark("coversWholeGeometry", "route-not-selected");
  const routeSections = complete ? sections.map((s, i) => {
    const sm = marks();
    const enter = stationIds ? stationIds[i] : null;
    const trackSegmentId = applicationState === "current" ? trackOf.get(s.sectionId) ?? null : null;
    if (!stationIds) for (const f of ["traversal", "enterStationId", "exitStationId"]) sm.mark(f, orderWhy);
    if (trackSegmentId === null) sm.mark("trackSegmentId", applicationWhy ?? "section-not-in-application");
    return { order: i + 1, sectionId: s.sectionId, enterStationId: enter, exitStationId: stationIds ? stationIds[i + 1] : null, traversal: stationIds ? (enter === s.fromStationId ? "forward" : "reverse") : null, trackSegmentId, ...sm.done() };
  }) : null;

  // --- directions: the player names where a direction starts and ends; the map reads which sections that runs through ---
  const stationsOnRoute = complete ? new Set(sections.flatMap((s) => [s.fromStationId, s.toStationId])) : null;
  const turnbackInputs = Array.isArray(drawn.turnbacks) ? drawn.turnbacks : null;
  const turnbackId = (t) => (hasKey(t?.key) ? stableId("service-turnback", servicePlanId, "key", t.key) : stableId("service-turnback", servicePlanId, text(t?.stationId), text(t?.terminalResourceId) ?? "no-terminal"));
  const directionId = (d) => (hasKey(d?.key) ? stableId("service-direction", servicePlanId, "key", d.key) : stableId("service-direction", servicePlanId, text(d?.fromStationId), text(d?.toStationId)));
  let directions = null;
  if (!Array.isArray(drawn.directions)) top.mark("directions", "directions-not-stated");
  else {
    directions = [];
    const seen = new Set();
    for (const d of drawn.directions) {
      const id = directionId(d);
      const pair = `${text(d?.fromStationId)}>${text(d?.toStationId)}`;
      if (!hasKey(d?.fromStationId) || !hasKey(d?.toStationId) || d.fromStationId === d.toStationId) { warn("direction-stations-invalid", { directionId: id }); continue; }
      if (seen.has(id) || seen.has(pair)) { warn("direction-duplicate", { directionId: id }); continue; }
      seen.add(id); seen.add(pair);
      const dm = marks();
      let orderedSectionIds = null;
      let orderedStationIds = null;
      let physicalConnection = null;
      const i = stationIds ? stationIds.indexOf(d.fromStationId) : -1;
      const j = stationIds ? stationIds.indexOf(d.toStationId) : -1;
      const why = !stationIds ? orderWhy : i < 0 || j < 0 ? "direction-station-not-on-route" : null;
      if (why) { if (stationIds) warn("direction-station-not-on-route", { directionId: id }); for (const f of ["orderedSectionIds", "orderedStationIds", "physicalConnection"]) dm.mark(f, why); }
      else {
        const [lo, hi] = [Math.min(i, j), Math.max(i, j)];
        const ids = routeIds.slice(lo, hi);
        orderedSectionIds = i < j ? ids : [...ids].reverse();
        orderedStationIds = i < j ? stationIds.slice(lo, hi + 1) : stationIds.slice(lo, hi + 1).reverse();
        physicalConnection = triState(links.filter((l) => ids.includes(l.fromSectionId) && ids.includes(l.toSectionId)).map((l) => l.physicalJoin));
        if (physicalConnection === null) dm.mark("physicalConnection", "join-state-not-in-geometry");
      }
      const reversalTurnbackIds = turnbackInputs ? turnbackInputs.filter((t) => text(t?.stationId) === d.toStationId).map(turnbackId).sort(byText) : null;
      if (reversalTurnbackIds === null) dm.mark("reversalTurnbackIds", "turnbacks-not-stated");
      directions.push({ directionId: id, key: hasKey(d.key) ? d.key : null, label: text(d.label), fromStationId: d.fromStationId, toStationId: d.toStationId, orderedSectionIds, orderedStationIds, physicalConnection, reversalTurnbackIds, ...dm.done() });
    }
    directions.sort((a, b) => byText(a.directionId, b.directionId));
  }
  const directionKeys = new Set((directions ?? []).filter((d) => d.key !== null).map((d) => d.key));

  // --- service bands: times, headway, trainsets and cars exactly as the player asked for them ---
  let serviceBands = null;
  if (!Array.isArray(drawn.serviceBands)) top.mark("serviceBands", "service-bands-not-stated");
  else {
    serviceBands = [];
    const seen = new Set();
    for (const b of drawn.serviceBands) {
      const { startMinute: start, endMinute: end } = b ?? {};
      const bandId = hasKey(b?.key) ? stableId("service-band", servicePlanId, "key", b.key) : stableId("service-band", servicePlanId, "span", start, end, text(b?.periodId) ?? "no-period");
      if (!isInt(start, 0) || !isInt(end, 1) || end > MINUTES_PER_DAY || start >= end) { warn("band-time-invalid", { bandId, startMinute: start ?? null, endMinute: end ?? null }); continue; }
      if (seen.has(bandId)) { warn("band-duplicate", { bandId }); continue; }
      seen.add(bandId);
      const bm = marks();
      const stated = (field, value, name, reason) => {
        if (value === null && b[field] !== undefined && b[field] !== null) warn(`${field}-invalid`, { bandId, value: String(b[field]) });
        if (value === null) bm.mark(name, reason);
        return value;
      };
      const headway = stated("headwayMinutes", typeof b.headwayMinutes === "number" && Number.isFinite(b.headwayMinutes) && b.headwayMinutes > 0 ? roundTo(b.headwayMinutes, 3) : null, "playerRequestedHeadwayMinutes", "headway-not-stated");
      const trainsets = stated("trainsets", isInt(b.trainsets, 0) ? b.trainsets : null, "playerRequestedTrainsets", "trainsets-not-stated");
      const cars = stated("formationCars", isInt(b.formationCars, 1) ? b.formationCars : null, "playerRequestedFormationCars", "formation-cars-not-stated");
      let keys = null;
      if (Array.isArray(b.directionKeys)) {
        keys = uniqueSorted(b.directionKeys.map(String));
        const missing = keys.filter((k) => !directionKeys.has(k));
        if (missing.length) warn("band-direction-unknown", { bandId, directionKeys: missing });
      } else bm.mark("directionKeys", "band-direction-not-stated");
      serviceBands.push({
        bandId, key: hasKey(b.key) ? b.key : null, label: text(b.label), periodId: text(b.periodId), startMinute: start, endMinute: end, directionKeys: keys,
        operating: b.active !== false, playerRequestedHeadwayMinutes: headway, playerRequestedTrainsets: trainsets, playerRequestedFormationCars: cars, basis: "player", note: text(b.note), ...bm.done(),
      });
    }
    serviceBands.sort((a, b) => byText(a.bandId, b.bandId));
    // two operating bands the player asked for at the same time in the same direction: a stated overlap, not a verdict
    for (let i = 0; i < serviceBands.length; i++) for (let k = i + 1; k < serviceBands.length; k++) {
      const [x, y] = [serviceBands[i], serviceBands[k]];
      const shared = x.directionKeys && y.directionKeys ? x.directionKeys.filter((d) => y.directionKeys.includes(d)) : [];
      if (x.operating && y.operating && x.periodId === y.periodId && shared.length && x.startMinute < y.endMinute && y.startMinute < x.endMinute) warn("bands-overlap", { bandIds: [x.bandId, y.bandId], directionKeys: shared });
    }
  }

  // --- turnbacks: where the player wants trains to reverse; terminals: the facility facts at the stations the plan cares about ---
  const planStations = new Set(geometry.sections.filter((s) => s.sourceKind === "plan").flatMap((s) => [s.fromStationId, s.toStationId]));
  const careStations = new Map();
  const care = (stationId, role) => careStations.set(stationId, uniqueSorted([...(careStations.get(stationId) ?? []), role]));
  if (knownEnds) { care(knownEnds[0], "route-start"); care(knownEnds[1], "route-end"); }
  const selectedAt = new Map();
  const turnbacks = [];
  const turnbackSeen = new Set();
  if (turnbackInputs === null) top.mark("turnbacks", "turnbacks-not-stated");
  for (const t of turnbackInputs ?? []) {
    const id = turnbackId(t);
    if (!hasKey(t?.stationId)) { warn("turnback-station-invalid", { turnbackId: id }); continue; }
    if (turnbackSeen.has(id)) { warn("turnback-duplicate", { turnbackId: id }); continue; }
    turnbackSeen.add(id);
    const intent = TURNBACK_INTENTS.includes(t.intent) ? t.intent : null;
    if (intent === null && t.intent !== undefined && t.intent !== null) warn("turnback-intent-invalid", { turnbackId: id, intent: String(t.intent) });
    const tm = marks();
    if (intent === null) tm.mark("intent", "turnback-intent-not-stated");
    const onRoute = stationsOnRoute ? stationsOnRoute.has(t.stationId) : null;
    if (onRoute === null) tm.mark("onRoute", orderWhy);
    else if (!onRoute) warn("turnback-station-off-route", { turnbackId: id, stationId: t.stationId });
    const position = stationIds ? (stationIds[0] === t.stationId ? "start" : stationIds.at(-1) === t.stationId ? "end" : stationIds.includes(t.stationId) ? "middle" : null) : null;
    if (position === null) tm.mark("position", stationIds ? "station-not-on-route" : orderWhy);
    care(t.stationId, "turnback");
    if (hasKey(t.terminalResourceId)) selectedAt.set(t.stationId, uniqueSorted([...(selectedAt.get(t.stationId) ?? []), String(t.terminalResourceId)]));
    turnbacks.push({ turnbackId: id, key: hasKey(t.key) ? t.key : null, stationId: t.stationId, intent, playerSelected: true, terminalResourceId: text(t.terminalResourceId), turnbackCandidateId: text(t.turnbackCandidateId), onRoute, position, facilityFacts: null, ...tm.done() });
  }
  turnbacks.sort((a, b) => byText(a.turnbackId, b.turnbackId));
  const terminals = [...careStations.keys()].sort(byText).map((stationId) => {
    const xm = marks();
    const picked = selectedAt.get(stationId) ?? [];
    let facilities = null;
    if (geometry.terminals === null || geometry.terminals === undefined) xm.mark("facilities", geometry.unknownReasons?.terminals ?? "no-terminal-data");
    else if (!planStations.has(stationId)) xm.mark("facilities", "external-station-terminal-not-in-source");
    else {
      facilities = geometry.terminals.filter((t) => t.stationId === stationId).map((t) => {
        const fm = marks();
        if (t.platformCandidates === null) fm.mark("platformCandidates", t.unknownReasons?.platformCandidates ?? "no-platform-data");
        if (t.turnbackCandidates === null) fm.mark("turnbackCandidates", t.unknownReasons?.turnbackCandidates ?? "no-turnback-data");
        return {
          terminalResourceId: t.terminalResourceId, playerSelected: picked.includes(t.terminalResourceId),
          platformCandidates: t.platformCandidates === null ? null : t.platformCandidates.map((p) => ({ platformCandidateId: p.platformCandidateId, connected: p.connected, approachReachesTerminalStation: p.approachReachesTerminalStation, unknown: p.unknown, unknownReasons: p.unknownReasons })),
          turnbackCandidates: t.turnbackCandidates === null ? null : t.turnbackCandidates.map((p) => ({ turnbackCandidateId: p.turnbackCandidateId, kind: p.kind, attached: p.attached, viaJunctionResourceId: p.viaJunctionResourceId, unknown: p.unknown, unknownReasons: p.unknownReasons })),
          ...fm.done(),
        };
      }).sort((a, b) => byText(a.terminalResourceId, b.terminalResourceId));
    }
    return { stationId, roles: careStations.get(stationId), playerSelectedTerminalResourceIds: picked, facilities, ...xm.done() };
  });
  for (const t of turnbacks) {
    const entry = terminals.find((x) => x.stationId === t.stationId);
    const fm = marks();
    let terminalResourceKnown = null;
    if (entry.facilities === null) fm.mark("terminalResourceIdsAtStation", entry.unknownReasons.facilities);
    if (t.terminalResourceId === null) fm.mark("terminalResourceKnown", "no-terminal-selected");
    else if (entry.facilities === null) fm.mark("terminalResourceKnown", entry.unknownReasons.facilities);
    else {
      terminalResourceKnown = entry.facilities.some((f) => f.terminalResourceId === t.terminalResourceId);
      if (!terminalResourceKnown) warn("terminal-resource-not-at-station", { turnbackId: t.turnbackId, terminalResourceId: t.terminalResourceId });
    }
    t.facilityFacts = { terminalResourceIdsAtStation: entry.facilities === null ? null : entry.facilities.map((f) => f.terminalResourceId), terminalResourceKnown, ...fm.done() };
  }

  // --- vehicle intent and the rest of what the player stated ---
  const vi = drawn.vehicleIntent ?? {};
  const vm = marks();
  const intentValue = (field, value) => {
    if (value === null && vi[field] !== undefined && vi[field] !== null) warn(`${field}-invalid`, { value: String(vi[field]) });
    if (value === null) vm.mark(field, `${field}-not-stated`);
    return value;
  };
  const vehicleModelId = intentValue("vehicleModelId", hasKey(vi.vehicleModelId) ? String(vi.vehicleModelId) : null);
  const requestedCars = intentValue("requestedCars", isInt(vi.requestedCars, 1) ? vi.requestedCars : null);
  const requestedTrainsets = intentValue("requestedTrainsets", isInt(vi.requestedTrainsets, 0) ? vi.requestedTrainsets : null);
  const vehicleIntent = { vehicleModelId, requestedCars, requestedTrainsets, playerSelected: vehicleModelId !== null || requestedCars !== null || requestedTrainsets !== null, ...vm.done() };
  const assumptions = (Array.isArray(drawn.assumptions) ? drawn.assumptions : []).filter((a) => hasKey(a?.text))
    .map((a) => ({ assumptionId: stableId("service-assumption", servicePlanId, hasKey(a.key) ? `key:${a.key}` : `text:${a.text}`), key: hasKey(a.key) ? a.key : null, text: String(a.text), basis: "player" }))
    .sort((a, b) => byText(a.assumptionId, b.assumptionId));
  const depotRefs = !Array.isArray(drawn.depotRefs) ? null : drawn.depotRefs.filter((d) => hasKey(d?.depotSiteId) || hasKey(d?.stationId)).map((d) => {
    const dm = marks();
    const stationId = text(d.stationId);
    const role = DEPOT_ROLES.includes(d.role) ? d.role : null;
    if (role === null) dm.mark("role", "depot-role-not-stated");
    const stationOnRoute = stationId !== null && stationsOnRoute ? stationsOnRoute.has(stationId) : null;
    if (stationOnRoute === null) dm.mark("stationOnRoute", stationId === null ? "depot-station-not-stated" : orderWhy);
    const depotRefId = hasKey(d.key) ? stableId("service-depot-ref", servicePlanId, "key", d.key) : stableId("service-depot-ref", servicePlanId, text(d.depotSiteId) ?? "no-depot", stationId ?? "no-station");
    return { depotRefId, key: hasKey(d.key) ? d.key : null, depotSiteId: text(d.depotSiteId), stationId, role, stationOnRoute, ...dm.done() };
  }).sort((a, b) => byText(a.depotRefId, b.depotRefId));

  // --- the facts of the chosen sections, read from the geometry (in the player's order) ---
  const closure = new Set((geometry.closureTargets ?? []).map((c) => c.sectionId));
  const sectionFacts = sections.map((s) => {
    const sm = marks();
    for (const f of SECTION_FACT_FIELDS) if (s[f] === null || s[f] === undefined) sm.mark(f, s.unknownReasons?.[f] ?? (s.sourceKind === "external" ? NO_ALIGNMENT : "not-in-geometry"));
    return {
      sectionId: s.sectionId, sourceKind: s.sourceKind, planId: s.planId, externalLineId: s.externalLineId, fromStationId: s.fromStationId, toStationId: s.toStationId,
      lengthMeters: s.lengthMeters ?? null, minimumCurveRadiusMeters: s.minimumCurveRadiusMeters ?? null, groundGradientPermille: s.groundGradientPermille ?? null,
      directionMode: s.directionMode ?? null, directionModeBasis: s.directionModeBasis ?? null, blockIds: s.blockIds ?? null, junctionResourceIds: s.junctionResourceIds ?? null,
      closureTarget: closure.has(s.sectionId), ...sm.done(),
    };
  });

  // --- assemble ---
  const routeBlock = {
    sectionIds: routeIds, playerFromStationId: text(route?.fromStationId), playerToStationId: text(route?.toStationId), fromStationId: knownEnds?.[0] ?? null, toStationId: knownEnds?.[1] ?? null,
    stationIds, sections: routeSections, links, stationsShared, physicallyJoined, includesExternal: externalSectionIds === null ? null : externalSectionIds.length > 0, externalSectionIds,
    coversWholeGeometry: omittedSectionIds === null ? null : omittedSectionIds.length === 0, omittedSectionIds, missingSectionIds: missingSectionIds === null ? null : uniqueSorted(missingSectionIds), ...rm.done(),
  };
  const all = { ...top.done().unknownReasons };
  const collect = (prefix, item) => { for (const f of item.unknown ?? []) all[`${prefix}:${f}`] = item.unknownReasons[f]; };
  collect("route", routeBlock);
  for (const s of routeSections ?? []) collect(`route:section:${s.sectionId}`, s);
  for (const l of links) collect(`route:link:${l.fromSectionId}:${l.toSectionId}`, l);
  for (const d of directions ?? []) collect(`direction:${d.directionId}`, d);
  for (const b of serviceBands ?? []) collect(`band:${b.bandId}`, b);
  for (const t of terminals) { collect(`terminal:${t.stationId}`, t); for (const f of t.facilities ?? []) collect(`terminal:${t.stationId}:${f.terminalResourceId}`, f); }
  for (const t of turnbacks) { collect(`turnback:${t.turnbackId}`, t); collect(`turnback:${t.turnbackId}:facility`, t.facilityFacts); }
  collect("vehicleIntent", vehicleIntent);
  for (const d of depotRefs ?? []) collect(`depot:${d.depotRefId}`, d);
  for (const f of sectionFacts) collect(`section:${f.sectionId}`, f);
  const unknownPaths = Object.keys(all).sort(byText);
  const flags = new Set();
  if (revisionState !== "current") flags.add(revisionState === "stale" ? "revision-stale" : "revision-not-recorded");
  if (applicationState === "stale") flags.add("capacity-application-stale");
  if (complete && sectionFacts.some((f) => f.directionMode === null)) flags.add("track-count-unknown");
  if (complete && sectionFacts.some((f) => f.directionMode === "single")) flags.add("single-track-section-on-route");
  if (complete && sectionFacts.some((f) => f.blockIds === null)) flags.add("block-data-missing");
  if (externalSectionIds?.length) flags.add("external-section-on-route");
  if (geometry.terminals === null || geometry.terminals === undefined) flags.add("terminal-data-missing");
  if (missingSectionIds?.length) flags.add("route-section-missing");
  if (stationsShared === false) flags.add("route-sections-share-no-station");
  const license = { pack: ctx.pack.manifest?.data?.license ?? null, attribution: ctx.pack.manifest?.data?.attribution ?? [] };
  const body = {
    schema: SERVICE_PLAN_SCHEMA, contractVersion: 1, servicePlanId,
    sourcePackId: packId, sourcePackVersion: ctx.pack.manifest?.version ?? null, key: hasKey(drawn.key) ? drawn.key : null, name: text(drawn.name),
    railGeometryId: geometry.railGeometryId, railGeometryRevision: geometry.railGeometryRevision,
    revision: { state: revisionState, designedRailGeometryRevision: designed, currentRailGeometryRevision: geometry.railGeometryRevision },
    operationalLineId, capacityApplicationId: applicationState === null ? null : text(application.applicationId), capacityApplicationRevision: applicationState === null ? null : text(application.railGeometryRevision), capacityApplicationState: applicationState,
    active: drawn.active !== false, planKind: planKindStated,
    playerInputs: { planKind: planKindStated, operatingPattern, operationalLineId, assumptions, depotRefs, basis: "player" },
    route: routeBlock, directions, serviceBands, terminals, turnbacks: turnbackInputs === null ? null : turnbacks, vehicleIntent,
    spatialFacts: { sections: sectionFacts, spatialFlags: [...flags].sort(byText), dataQuality: worse(qualityOf(unknownPaths.length), geometry.dataQuality ?? "low") },
    unknown: unknownPaths, unknownReasons: sortedObject(all),
  };
  // the revision follows what was stated and what was read; names, labels and warnings do not change it
  const servicePlanRevision = stableId("service-plan-revision", servicePlanId, JSON.stringify(body, (k, v) => (k === "name" || k === "label" ? undefined : v)));
  const sourceLayers = [{ layer: "rail-capacity-geometry", quality: geometry.dataQuality ?? null, name: `RailCapacityGeometry ${geometry.railGeometryId}`, license: geometry.license?.pack ?? null }];
  return { warnings, plan: { ...body, servicePlanRevision, warnings, sourceLayers, license } };
}

// plans: the player's service plan documents (`active: false` keeps a plan in the export, switched off).
// railGeometries: RailCapacityGeometry v1 objects; applications: rail-capacity-application/1 objects.
export function buildServicePlanExport({ pack, railGeometries = [], applications = [], plans = [] }) {
  const packId = pack.manifest?.id ?? "pack";
  const built = new Map();
  const warnings = [];
  for (const drawn of plans) {
    const geometry = railGeometries.find((g) => g?.railGeometryId === drawn?.railGeometryId);
    if (!geometry) { warnings.push({ code: "service-plan-rejected", key: drawn?.key ?? null, reasons: [{ code: "rail-geometry-missing", railGeometryId: drawn?.railGeometryId ?? null }] }); continue; }
    const application = applications.find((a) => a?.railGeometryId === geometry.railGeometryId && text(a.operationalLineId) === text(drawn.operationalLineId)) ?? null;
    const out = buildServicePlan(drawn, { pack, railGeometry: geometry, application });
    if (!out.plan) warnings.push({ code: "service-plan-rejected", key: drawn?.key ?? null, reasons: out.warnings });
    else if (built.has(out.plan.servicePlanId)) warnings.push({ code: "duplicate-service-plan", servicePlanId: out.plan.servicePlanId });
    else built.set(out.plan.servicePlanId, out.plan);
  }
  return { schema: SERVICE_PLAN_EXPORT_SCHEMA, packId, packVersion: pack.manifest?.version ?? null, plans: [...built.values()].sort((a, b) => byText(a.servicePlanId, b.servicePlanId)), warnings };
}
