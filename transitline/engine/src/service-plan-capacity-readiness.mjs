// Rail capacity readiness of map service plans (B16-M6): for each B16 service plan, WHICH FACTS of the rail capacity map the
// pre-screening (E1) reads are stated and which are not — the capacity application (current / stale / none), whether each
// section of the plan maps onto an application track segment, the track count, the block ids, the junction resource ids, the
// terminal resource and the turnback candidate — and, for every one that is missing, which map input to fill. It states FACTS only
// ("stated", "unknown", "declared none", "not in the application"): it never says a plan can or cannot run, computes no headway or
// capacity, builds no timetable and prices nothing. What the player assumed (B16-M4) is kept in a separate block and never counted as
// a map fact. Nothing is changed: every input is only read; an "open the capacity editor" request is a descriptor for the host.
//
// null / false / 0 / [] are kept apart everywhere: `null` = unknown, `[]` = the map states "none", a count is only given for a stated list.
export const CAPACITY_READINESS_SCHEMA = "transitline.service-plan-capacity-readiness/1";
export const MAP_FACT_BASIS = "map-fact";
export const ASSUMPTION_BASIS = "player-stated-assumption";

const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const text = (v) => (typeof v === "string" && v.trim() !== "" ? v : null);
const listOf = (v, key) => (Array.isArray(v) ? v : v && Array.isArray(v[key]) ? v[key] : null);
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// the three states of a list the map may or may not have stated
export function listState(value) {
  if (!Array.isArray(value)) return { state: "unknown", count: null, ids: null };
  return { state: value.length ? "listed" : "declared-none", count: value.length, ids: value.map(String).sort(byText) };
}
export const modeState = (value) => (value === "single" || value === "double" ? { state: "stated", value } : { state: "unknown", value: null });

// which of the plan's inputs the application is read from
function applicationOf(plan, applications) {
  const lineId = text(plan.operationalLineId);
  if (applications === null) return { state: plan.capacityApplicationState === "current" || plan.capacityApplicationState === "stale" ? plan.capacityApplicationState : "unknown", application: null, detailsAvailable: false, lineId };
  if (lineId === null) return { state: "line-not-stated", application: null, detailsAvailable: true, lineId };
  const ofLine = applications.filter((a) => isObject(a) && text(a.operationalLineId) === lineId).sort((a, b) => byText(String(a.railGeometryId), String(b.railGeometryId)));
  const same = ofLine.find((a) => a.railGeometryId === plan.railGeometryId) ?? null;
  if (same) return { state: same.railGeometryRevision === plan.railGeometryRevision ? "current" : "stale", application: same, detailsAvailable: true, lineId };
  if (ofLine.length) return { state: "other-geometry", application: ofLine[0], detailsAvailable: true, lineId };
  return { state: "none", application: null, detailsAvailable: true, lineId };
}

function sectionRows(plan, application) {
  const geometrySections = new Map((plan.spatialFacts?.sections ?? []).map((s) => [s.sectionId, s]));
  const appSections = Array.isArray(application?.sections) ? application.sections : null;
  return (plan.route?.sections ?? []).map((r) => {
    const geo = geometrySections.get(r.sectionId) ?? null;
    const app = appSections ? appSections.find((s) => s.railCapacitySectionId === r.sectionId) ?? null : null;
    const mapping = appSections === null ? "application-unavailable" : app ? "mapped" : "not-in-application";
    const trackSegmentId = app ? text(app.trackSegmentId) : null;
    const planTrack = text(r.trackSegmentId);
    return {
      order: r.order, sectionId: r.sectionId, mapping, trackSegmentId, planTrackSegmentId: planTrack, trackSegmentIdDiffers: app && planTrack !== null ? planTrack !== trackSegmentId : null,
      directionMode: { application: app ? modeState(app.directionMode) : null, geometry: geo ? modeState(geo.directionMode) : null },
      blockIds: { application: app ? listState(app.blockIds) : null, geometry: geo ? listState(geo.blockIds) : null },
      junctionResourceIds: { application: app ? listState(app.junctionResourceIds) : null, geometry: geo ? listState(geo.junctionResourceIds) : null },
    };
  });
}

// the facts about the terminal and turnback the plan chose, read from the application's terminals
function turnbackRows(plan, application) {
  if (!Array.isArray(plan.turnbacks)) return { state: "not-stated", items: [] };
  const terminals = Array.isArray(application?.terminals) ? application.terminals : null;
  const items = plan.turnbacks.map((t) => {
    const terminalId = text(t.terminalResourceId);
    const candidateId = text(t.turnbackCandidateId);
    const terminal = terminals && terminalId ? terminals.find((x) => x.terminalResourceId === terminalId) ?? null : null;
    let terminalState;
    if (!terminalId) terminalState = "not-selected";
    else if (application === null) terminalState = "application-unavailable";
    else if (terminals === null) terminalState = "terminal-data-unknown";
    else terminalState = terminal ? "in-application" : "not-in-application";
    const candidates = terminal ? (Array.isArray(terminal.turnbackCandidates) ? terminal.turnbackCandidates : null) : null;
    let turnbackState;
    let attached = null;
    if (!terminal) turnbackState = terminalState === "not-in-application" ? "terminal-not-in-application" : terminalState === "not-selected" ? "terminal-not-selected" : "terminal-not-readable";
    else if (candidates === null) turnbackState = "turnback-data-unknown";
    else if (candidateId) {
      const c = candidates.find((x) => x.turnbackCandidateId === candidateId) ?? null;
      attached = c ? (typeof c.attached === "boolean" ? c.attached : null) : null;
      turnbackState = !c ? "candidate-not-in-application" : attached === true ? "attached" : attached === false ? "not-attached" : "unverified";
    } else turnbackState = candidates.length ? "not-selected" : "no-candidate-stated";
    return {
      key: t.key ?? null, turnbackId: t.turnbackId ?? null, stationId: t.stationId ?? null, terminalResourceId: terminalId, turnbackCandidateId: candidateId, terminalState, turnbackState, attached,
      candidateCount: candidates ? candidates.length : null, attachedCandidateCount: candidates ? candidates.filter((c) => c.attached === true).length : null,
    };
  });
  return { state: items.length ? "listed" : "declared-none", items };
}

const where = (kind, label) => ({ kind, label });
// every missing fact and where the player fills it (no verdict: only "this is not stated, here is where it is stated")
function gapsOf(plan, app, sections, turnbacks) {
  const gaps = [];
  const add = (checkId, field, place, extra = {}) => gaps.push({ checkId, field, ...place, ...extra });
  if (app.state !== "current") {
    const label = { none: "이 노선에 적용된 철도 용량 결과가 없음", stale: "적용된 철도 용량 결과가 현재 지도보다 낡음", "line-not-stated": "서비스 계획에 운영 노선이 연결되지 않음", "other-geometry": "적용된 철도 용량 결과가 다른 지도의 것임", unknown: "철도 용량 결과를 확인할 수 없음" }[app.state] ?? "철도 용량 결과를 확인할 수 없음";
    add("rail-capacity-application", "application", app.state === "line-not-stated" ? where("service-plan", "서비스 계획 편집 > 용량 적용 결과 연결") : where("capacity-map", "철도 용량 지도에서 현재 지도를 노선에 적용"), { reason: app.state, message: label });
  }
  if (!app.application) return gaps;
  const ids = (pick) => sections.filter(pick).map((s) => s.sectionId);
  const notIn = ids((s) => s.mapping === "not-in-application");
  if (notIn.length) add("section-not-in-application", "route", where("service-plan", "서비스 계획 편집 > 노선 구간 또는 철도 용량 적용 범위"), { reason: "section-not-in-application", sectionIds: notIn, message: "계획의 구간이 적용 결과의 트랙 구간에 매핑되지 않음" });
  const mapped = sections.filter((s) => s.mapping === "mapped");
  const missing = (field) => mapped.filter((s) => s[field].application.state === "unknown").map((s) => s.sectionId);
  const dir = missing("directionMode");
  if (dir.length) add("direction-mode", "directionMode", where("capacity-map", "철도 용량 지도 > 단·복선 지정"), { reason: "direction-mode-not-stated", sectionIds: dir, message: "구간의 단·복선이 지도에 적혀 있지 않음" });
  const blocks = missing("blockIds");
  if (blocks.length) add("block-data", "blockIds", where("capacity-map", "철도 용량 지도 > 폐색 경계 놓기 또는 '경계 없음으로 선언'"), { reason: "block-data-missing", sectionIds: blocks, message: "구간의 폐색 자료가 지도에 없음" });
  const junctions = missing("junctionResourceIds");
  if (junctions.length) add("junction-resource", "junctionResourceIds", where("capacity-map", "철도 용량 지도 > 분기기·평면교차 놓기"), { reason: "junction-data-missing", sectionIds: junctions, message: "구간의 분기기 자료가 지도에 없음" });
  if (turnbacks.state === "not-stated") add("terminal-resource", "turnbacks", where("service-plan", "서비스 계획 편집 > 회차 고르기"), { reason: "terminal-resource-not-selected", message: "계획에 회차(종착 설비)를 적지 않음" });
  for (const t of turnbacks.items) {
    if (t.terminalState === "not-selected") add("terminal-resource", "terminalResourceId", where("service-plan", "서비스 계획 편집 > 회차의 종착 설비 고르기"), { reason: "terminal-resource-not-selected", turnbackKey: t.key, message: "회차에 종착 설비를 고르지 않음" });
    else if (t.terminalState === "terminal-data-unknown") add("terminal-resource", "terminals", where("capacity-map", "철도 용량 지도 > 종착 시설 지정"), { reason: "terminal-data-missing", turnbackKey: t.key, message: "종착 자료가 지도에 없음" });
    else if (t.terminalState === "not-in-application") add("terminal-resource", "terminals", where("capacity-map", "철도 용량 지도 > 종착 시설 지정(또는 다른 설비 고르기)"), { reason: "terminal-resource-absent", turnbackKey: t.key, message: "고른 종착 설비가 적용 결과에 없음" });
    else if (["turnback-data-unknown", "unverified", "no-candidate-stated", "not-selected"].includes(t.turnbackState)) add("turnback-connection", "turnbackCandidateId", where("capacity-map", "철도 용량 지도 > 회차선·인상선 그리기와 접속"), { reason: t.turnbackState, turnbackKey: t.key, message: "회차선 접속 사실이 지도에 없거나 확인되지 않음" });
    else if (t.turnbackState === "candidate-not-in-application") add("turnback-connection", "turnbackCandidateId", where("service-plan", "서비스 계획 편집 > 회차 후보 고르기"), { reason: t.turnbackState, turnbackKey: t.key, message: "고른 회차 후보가 적용 결과에 없음" });
  }
  return gaps;
}

// The player's own assumptions (B16-M4), side by side with the map's facts and never merged with them.
function assumptionBlock(plan, sections, assumptions) {
  if (!assumptions) return { supplied: false, basis: ASSUMPTION_BASIS };
  const set = (assumptions.sets ?? []).find((s) => s.servicePlanId === plan.servicePlanId) ?? null;
  if (!set) return { supplied: true, basis: ASSUMPTION_BASIS, present: false };
  const mapModes = [...new Set(sections.map((s) => s.directionMode.application?.value).filter(Boolean))].sort(byText);
  const mapKnown = sections.length > 0 && sections.every((s) => s.directionMode.application?.state === "stated");
  const assumed = set.statements?.directionMode ?? null;
  const compare = [{
    field: "directionMode", mapFact: { basis: MAP_FACT_BASIS, values: mapModes, allSectionsStated: mapKnown }, assumption: { basis: ASSUMPTION_BASIS, value: assumed },
    differs: assumed !== null && mapModes.length ? mapModes.some((m) => m !== assumed) : null,
  }];
  return {
    supplied: true, present: true, basis: ASSUMPTION_BASIS, assumptionSetId: set.assumptionSetId, state: set.state, usable: set.usable === true, statedFields: [...(set.statedFields ?? [])],
    capacityTrainsPerHour: set.statements?.capacityTrainsPerHour ?? null, minimumHeadwayMinutes: set.statements?.minimumHeadwayMinutes ?? null, compare,
    note: "플레이어 가정은 지도 사실을 채우지 않습니다. 사전심사의 선로 항목은 위의 지도 사실을 읽습니다.",
  };
}

// servicePlans: B16-M1 plans (export.plans); railGeometries / applications: arrays or null when the host does not supply them; assumptions: the M4 export or null
export function buildCapacityReadinessView({ servicePlans = [], railGeometries = null, applications = null, assumptions = null } = {}) {
  const apps = listOf(applications, "applications");
  const geometries = listOf(railGeometries, "railGeometries") ?? listOf(railGeometries, "designs");
  const plans = (Array.isArray(servicePlans) ? servicePlans : []).filter((p) => isObject(p) && text(p.servicePlanId)).sort((a, b) => byText(a.servicePlanId, b.servicePlanId)).map((plan) => {
    const app = applicationOf(plan, apps);
    const sections = sectionRows(plan, app.application);
    const turnbacks = turnbackRows(plan, app.application);
    const geometry = geometries ? geometries.find((g) => g?.railGeometryId === plan.railGeometryId) ?? null : null;
    const warnings = [];
    const planState = plan.capacityApplicationState ?? null;
    const expected = { current: "current", stale: "stale" }[planState] ?? null;
    if (app.detailsAvailable && expected !== null && expected !== app.state) warnings.push({ code: "plan-application-state-differs", planState, applicationState: app.state });
    if (geometries && !geometry) warnings.push({ code: "rail-geometry-not-supplied", railGeometryId: plan.railGeometryId ?? null });
    const mapped = sections.filter((s) => s.mapping === "mapped");
    const stated = (field) => mapped.filter((s) => s[field].application.state !== "unknown").length;
    const gaps = gapsOf(plan, app, sections, turnbacks);
    return {
      servicePlanId: plan.servicePlanId, name: plan.name ?? null, active: plan.active === false ? false : plan.active === true ? true : null, operationalLineId: app.lineId, railGeometryId: plan.railGeometryId ?? null,
      railGeometryRevision: plan.railGeometryRevision ?? null,
      application: { state: app.state, detailsAvailable: app.detailsAvailable, applicationId: app.application ? text(app.application.applicationId) : null, applicationRailGeometryRevision: app.application ? text(app.application.railGeometryRevision) : null, basis: MAP_FACT_BASIS },
      geometry: geometry ? { railGeometryRevision: geometry.railGeometryRevision ?? null, terminals: listState(Array.isArray(geometry.terminals) ? geometry.terminals : null), blocks: listState(Array.isArray(geometry.blocks) ? geometry.blocks : null), junctions: listState(Array.isArray(geometry.junctions) ? geometry.junctions : null) } : null,
      sections, turnbacks, gaps, assumptions: assumptionBlock(plan, sections, assumptions), warnings,
      counts: { sections: sections.length, mapped: mapped.length, notInApplication: sections.filter((s) => s.mapping === "not-in-application").length, directionModeStated: stated("directionMode"), blockDataStated: stated("blockIds"), junctionDataStated: stated("junctionResourceIds"), gaps: gaps.length },
    };
  });
  const countApp = (state) => plans.filter((p) => p.application.state === state).length;
  return {
    schema: CAPACITY_READINESS_SCHEMA, contractVersion: 1, basis: MAP_FACT_BASIS, plans,
    counts: { plans: plans.length, applicationCurrent: countApp("current"), applicationStale: countApp("stale"), applicationNone: plans.filter((p) => ["none", "line-not-stated", "other-geometry", "unknown"].includes(p.application.state)).length, gaps: plans.reduce((n, p) => n + p.gaps.length, 0) },
  };
}

// The descriptor handed to the host's "open the capacity editor" callback (the panel never opens or changes anything itself).
export const editorRequestOf = (plan, gap) => ({ action: gap.kind === "capacity-map" ? "open-capacity-editor" : "open-service-plan-editor", servicePlanId: plan.servicePlanId, operationalLineId: plan.operationalLineId, railGeometryId: plan.railGeometryId, field: gap.field, checkId: gap.checkId, sectionIds: gap.sectionIds ?? null });
