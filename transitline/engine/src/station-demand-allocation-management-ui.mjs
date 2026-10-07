// Management panel for the station-access demand allocation policy (B15-M3): the player writes a policy, previews what the
// engine would do with it, and applies it. It sits between the map's access drawing (M2, stored by the runtime as the access
// application) and the runtime's allocation commands (E4), and calls only these ScenarioRuntime methods:
//   stationDemandAccessReport / stationDemandAllocationReport / stationDemandAllocationDiagnostics (read)
//   assessStationDemandAllocation                               (preview: changes nothing)
//   applyStationDemandAllocation                                (the only call that changes the engine)
// It never computes demand, money, fares, crowding or time: every number on screen is one the engine returned (or a share the
// player typed). Whether a rule is valid, stale, walkable or operational is the engine's call and its errors are shown as given.
// Nothing is persisted here — no localStorage; the draft is a document the host stores (serialize / loadDoc), and what has been
// applied lives in the runtime's integrated save.
import { STATION_DEMAND_ALLOCATION_POLICY_SCHEMA, bindStationDemandAllocationRule } from "./station-demand-allocation-policy.mjs";

export const STATION_DEMAND_ALLOCATION_DRAFT_SCHEMA = "transitline.station-demand-allocation-draft/1";
const RULE_KINDS = ["station-exclusive", "node-assign", "node-shares"];

export const SCOPE_NOTICE = "이 패널은 정책을 쓰고 엔진의 미리보기를 읽습니다. 수요·비용·운임·혼잡·시간은 계산하지 않으며, 유효성·낡음·보행·운행역 판정은 엔진이 합니다. 미리보기와 입력 변경은 엔진 상태를 바꾸지 않고, '적용'만 바꿉니다.";
export const FRACTIONAL_NOTICE = "분수 배정은 각 승객을 정해진 비율에 가깝게 역별로 나눠 연결합니다. 배정되지 않은 비율은 기존 접근 경로로 보내지지 않고 경로 없음으로 남습니다.";

const TEXT = Object.freeze({
  "no-access-application": "역 접근권 사실이 아직 엔진에 없습니다. 지도(M2)에서 접근권을 그린 뒤 '역 접근권 적용'을 먼저 누르세요.",
  "no-station-sites": "적용된 접근권에 역이 없습니다. 지도에서 역과 접근권을 그리고 다시 적용하세요.",
  "exclusive-needs-policy": "단독 접근권이지만 배정하지 않기로 함(보류)",
  "shared-needs-policy": "겹친 노드 — 규칙이 없어 미배정",
  "rule-stale": "규칙이 오래됨 — 현재 revision에 다시 묶어야 함",
  "rule-claimants-changed": "규칙을 쓴 뒤 이 노드를 주장하는 역이 바뀜",
  "policy-rejected": "정책이 거절되어 배정 없음",
  "demand-source-coarse": "수요 자료가 시구 단위로 거침",
  "demand-source-quality-insufficient": "수요 자료 품질이 부족함",
  "demand-points-source-missing": "수요 점 자료의 출처가 없음",
  "demand-node-values-missing": "노드의 거주·종사 값이 비어 있음",
  "area-footprint-unavailable": "면적형 자료(격자·필지·블록)라 중심점 가정이 필요함",
  "assessment-revision-mismatch": "평가와 지도 revision이 다름",
  "walk-path-unavailable": "보행 경로를 쓸 수 없음(없음·차단·미확인)",
  "station-not-operational": "아직 운행역이 없음(미연결)",
  "station-operational-ambiguous": "운행역이 둘 이상이라 하나로 정할 수 없음",
  "policy-rule-bound-to-invalid": "규칙이 현재 revision에 묶이지 않음",
  "policy-rule-shares-invalid": "비율이 올바르지 않음(0 초과 100 이하, 비어 있으면 안 됨)",
  "policy-shares-exceed-one": "비율의 합이 100%를 넘음",
  "policy-rule-station-unbound": "배정할 역을 고르지 않음",
  "rule-station-not-claimant": "규칙이 이 노드를 주장하지 않는 역을 가리킴",
  "crosses-river": "강을 가로지름", "crosses-railway": "철도를 가로지름", "crosses-building": "건물을 가로지름",
  "length-unmeasured": "길이를 알 수 없음", "no-walk-link-drawn": "그린 보행선이 없음", "stale-map-revision": "지도 revision이 낡음",
  "station-demand-access-revision-changed": "역 접근권 export가 바뀜",
});
const WALK_STATUS = Object.freeze({ usable: "쓸 수 있음", estimated: "추정", blocked: "차단", unknown: "미확인", "not-drawn": "안 그림", broken: "끊김", stale: "낡음" });
const BINDING_TEXT = Object.freeze({ unbound: "묶이지 않음", current: "현재 revision에 묶임", outdated: "오래됨 — 다시 묶어야 함", missing: "대상이 지금 접근권에 없음" });
const RULE_STATUS = Object.freeze({ applied: "적용됨", unmatched: "해당 노드 없음", stale: "오래됨", rejected: "거절됨" });
const DIAGNOSTIC_REASON = Object.freeze({ noStationShare: "역 없는 몫", partnerNobody: "반대편 역 없는 몫", partnerNoAccess: "반대편 접근 없음", sameStation: "같은 역", noRoute: "역 사이 경로 없음" });
const say = (code) => (TEXT[code] ? `${TEXT[code]} (${code})` : code);

const listOf = (value) => (Array.isArray(value) ? value : []);
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isText = (value) => typeof value === "string" && value !== "";
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const canonical = (v) => (Array.isArray(v) ? `[${v.map(canonical).join(",")}]` : isObject(v) ? `{${Object.keys(v).sort(cmp).map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}` : JSON.stringify(v ?? null));
const message = (error) => (error instanceof Error ? error.message : String(error));
const clone = (value) => structuredClone(value);
const valueText = (value) => (value === null || value === undefined ? "미상" : String(value));
const percent = (share) => `${Math.round(share * 10000) / 100}%`;

// --- the draft: what the player has written so far (a document the host saves; the engine never sees it as is) ---------------
export function newAllocationDraft(policyId = "policy:player") {
  return { schema: STATION_DEMAND_ALLOCATION_DRAFT_SCHEMA, version: 1, policyId, areaNodeInclusion: "reject", rules: [], walking: { walkEstimate: "none", acknowledgedWalkLinkIds: [] } };
}

// -> { draft | null, issues }. Any issue refuses the whole document: a draft is never half loaded.
export function restoreAllocationDraft(input) {
  let raw = input;
  if (typeof input === "string") { try { raw = JSON.parse(input); } catch { return { draft: null, issues: ["draft-unreadable"] }; } }
  if (!isObject(raw) || raw.schema !== STATION_DEMAND_ALLOCATION_DRAFT_SCHEMA || raw.version !== 1) return { draft: null, issues: ["draft-schema-invalid"] };
  const issues = [];
  if (!isText(raw.policyId)) issues.push("draft-policy-id-invalid");
  if (!["reject", "centroid"].includes(raw.areaNodeInclusion)) issues.push("draft-area-inclusion-invalid");
  const walking = raw.walking;
  if (!isObject(walking) || !["none", "straight-line"].includes(walking.walkEstimate) || !Array.isArray(walking.acknowledgedWalkLinkIds) || !walking.acknowledgedWalkLinkIds.every(isText)) issues.push("draft-walking-invalid");
  const rules = [];
  const seen = new Set();
  for (const [index, r] of listOf(raw.rules).entries()) {
    const where = isText(r?.ruleId) ? r.ruleId : String(index);
    const boundOk = r?.boundTo === null || (isObject(r?.boundTo) && Object.values(r.boundTo).every(isText));
    const stationOk = r?.stationAccessId === null || isText(r?.stationAccessId);
    const ok = isObject(r) && isText(r.ruleId) && RULE_KINDS.includes(r.kind) && boundOk && (
      r.kind === "station-exclusive" ? isText(r.stationAccessId)
        : r.kind === "node-assign" ? isText(r.demandNodeId) && stationOk
          : isText(r.demandNodeId) && isObject(r.shares) && Object.entries(r.shares).every(([id, v]) => isText(id) && (typeof v === "string" || typeof v === "number")));
    if (!ok) { issues.push(`draft-rule-invalid:${where}`); continue; }
    if (seen.has(r.ruleId)) { issues.push(`draft-rule-id-duplicate:${r.ruleId}`); continue; }
    seen.add(r.ruleId);
    const boundTo = r.boundTo ? clone(r.boundTo) : null;
    rules.push(r.kind === "station-exclusive" ? { ruleId: r.ruleId, kind: r.kind, stationAccessId: r.stationAccessId, boundTo }
      : r.kind === "node-assign" ? { ruleId: r.ruleId, kind: r.kind, demandNodeId: r.demandNodeId, stationAccessId: r.stationAccessId ?? null, boundTo }
        : { ruleId: r.ruleId, kind: r.kind, demandNodeId: r.demandNodeId, shares: Object.fromEntries(Object.entries(r.shares).map(([id, v]) => [id, String(v)])), boundTo });
  }
  if (issues.length) return { draft: null, issues };
  return { draft: { schema: STATION_DEMAND_ALLOCATION_DRAFT_SCHEMA, version: 1, policyId: raw.policyId, areaNodeInclusion: raw.areaNodeInclusion, rules: rules.sort((a, b) => cmp(a.ruleId, b.ruleId)), walking: { walkEstimate: walking.walkEstimate, acknowledgedWalkLinkIds: [...new Set(walking.acknowledgedWalkLinkIds)].sort(cmp) } }, issues: [] };
}

// key order and rule order do not matter: the same draft is always the same text
export function serializeAllocationDraft(draft) {
  const { draft: normal, issues } = restoreAllocationDraft(draft);
  if (issues.length) throw new Error(`Draft is not valid: ${issues.join(", ")}`);
  return canonical(normal);
}

// one draft rule -> one policy rule. A share the player typed is only divided by 100; anything that is not a number is passed on
// as it is (NaN), so the engine — not this panel — says it is wrong. An empty box means "no share for that station".
function policyRuleOf(rule) {
  const out = { ruleId: rule.ruleId };
  if (rule.kind === "station-exclusive") Object.assign(out, { scope: { stationAccessIds: [rule.stationAccessId] }, mode: "assign-all", stationAccessId: rule.stationAccessId });
  else if (rule.kind === "node-assign") Object.assign(out, { scope: { demandNodeIds: [rule.demandNodeId] }, mode: "assign-all", stationAccessId: rule.stationAccessId });
  else {
    const shares = {};
    for (const [id, typed] of Object.entries(rule.shares)) if (String(typed).trim() !== "") shares[id] = Number(String(typed).trim()) / 100;
    Object.assign(out, { scope: { demandNodeIds: [rule.demandNodeId] }, mode: "fixed-shares", shares });
  }
  if (rule.boundTo) out.boundTo = clone(rule.boundTo);
  return out;
}

export function buildStationDemandPolicy(draft) {
  return {
    schema: STATION_DEMAND_ALLOCATION_POLICY_SCHEMA, contractVersion: 1, policyId: draft.policyId,
    defaults: { exclusive: "hold", shared: "hold", areaNodeInclusion: draft.areaNodeInclusion },
    rules: draft.rules.map(policyRuleOf),
  };
}
export const buildStationDemandWalkingPolicy = (draft) => ({ walkEstimate: draft.walking.walkEstimate, acknowledgedWalkLinkIds: [...draft.walking.acknowledgedWalkLinkIds] });

// --- what the access application says, arranged for authoring (E1's own statuses; nothing is judged here) ----------------------
export function buildAllocationAuthoringView(application) {
  const empty = (reason) => ({ available: false, reason, stations: [], sharedNodes: [], unknownNodes: [], revisions: {}, claimantsOf: {} });
  if (!application?.assessment || !application?.access) return empty("no-access-application");
  const sites = listOf(application.assessment.sites);
  if (!sites.length) return empty("no-station-sites");
  const names = new Map(listOf(application.access.sites).map((s) => [s.stationAccessId, s.name ?? null]));
  const claims = new Map();
  for (const site of sites) for (const input of listOf(site.demandNodeInputs)) {
    const list = claims.get(input.demandNodeId) ?? [];
    list.push({ stationAccessId: site.stationAccessId, status: input.status, reason: input.reason ?? null, residents: input.residents ?? null, jobs: input.jobs ?? null });
    claims.set(input.demandNodeId, list);
  }
  const nodeIds = [...claims.keys()].sort(cmp);
  const claimantsOf = Object.fromEntries(nodeIds.map((id) => [id, claims.get(id).map((c) => c.stationAccessId).sort(cmp)]));
  const knownNode = (id) => claims.get(id).every((c) => c.status !== "unknown");
  return {
    available: true, reason: null,
    revisions: Object.fromEntries(sites.map((s) => [s.stationAccessId, s.stationAccessRevision])), claimantsOf,
    stations: sites.map((s) => ({
      stationAccessId: s.stationAccessId, label: names.get(s.stationAccessId) ?? s.connectedStationId ?? s.stationAccessId, revision: s.stationAccessRevision, coverage: s.catchmentStatus,
      exclusiveNodeCount: nodeIds.filter((id) => claims.get(id).length === 1 && claims.get(id)[0].stationAccessId === s.stationAccessId && knownNode(id)).length,
      unknownNodeCount: nodeIds.filter((id) => claims.get(id).some((c) => c.stationAccessId === s.stationAccessId) && !knownNode(id)).length,
      unknownReasons: listOf(s.unknownReasons),
    })).sort((a, b) => cmp(a.stationAccessId, b.stationAccessId)),
    sharedNodes: nodeIds.filter((id) => claims.get(id).length > 1 && knownNode(id)).map((id) => ({ demandNodeId: id, claimants: claimantsOf[id], residents: claims.get(id)[0].residents, jobs: claims.get(id)[0].jobs })),
    unknownNodes: nodeIds.filter((id) => !knownNode(id)).map((id) => ({ demandNodeId: id, claimants: claimantsOf[id], reasons: [...new Set(claims.get(id).filter((c) => c.status === "unknown").map((c) => c.reason ?? "demand-node-unknown"))].sort(cmp) })),
  };
}

// "is this rule tied to the access drawing as it is now": a fact comparison of revisions, not a judgement about demand
function bindingOf(rule, view) {
  const target = rule.kind === "station-exclusive" ? view.revisions[rule.stationAccessId] !== undefined : view.claimantsOf[rule.demandNodeId] !== undefined;
  if (!target) return "missing";
  if (!rule.boundTo) return "unbound";
  if (Object.entries(rule.boundTo).some(([id, revision]) => view.revisions[id] !== revision)) return "outdated";
  if (rule.kind !== "station-exclusive" && view.claimantsOf[rule.demandNodeId].some((id) => !(id in rule.boundTo))) return "outdated";
  return "current";
}

const el = (doc, tag, props = {}, ...kids) => { const node = doc.createElement(tag); Object.assign(node, props); node.append(...kids); if ("value" in props) node.value = props.value; return node; };
const text = (doc, tag, className, value) => el(doc, tag, { className, textContent: value });
const metric = (doc, label, value) => el(doc, "div", { className: "alloc-metric" }, text(doc, "span", "", label), text(doc, "b", "", value));
const choose = (doc, options, value, onChange, className = "") => {
  const select = el(doc, "select", { className, value }, ...options.map(([v, label]) => el(doc, "option", { value: v, textContent: label })));
  select.addEventListener("change", () => onChange(select.value));
  return select;
};

export function mountStationDemandAllocationManagementPanel({ container, runtime, onChange = () => {} } = {}) {
  if (!container) throw new Error("A station demand allocation management container is required");
  for (const method of ["stationDemandAccessReport", "assessStationDemandAllocation", "applyStationDemandAllocation", "stationDemandAllocationReport", "stationDemandAllocationDiagnostics"]) {
    if (typeof runtime?.[method] !== "function") throw new Error(`A ScenarioRuntime with ${method} is required`);
  }
  const doc = container.ownerDocument ?? document;
  let draft = newAllocationDraft();
  let preview = null; // { input, result, accessApplicationId } — only ever the result of the draft as it is now
  let walkingSeen = { accessApplicationId: null, links: [] };
  let error = null;
  let notice = null;
  let applyButton = null;
  const result = el(doc, "div", { className: "alloc-result" });

  const application = () => runtime.stationDemandAccessReport();
  const ruleOf = (id) => draft.rules.find((r) => r.ruleId === id) ?? null;
  const upsert = (rule) => { draft.rules = [...draft.rules.filter((r) => r.ruleId !== rule.ruleId), rule].sort((a, b) => cmp(a.ruleId, b.ruleId)); };
  const drop = (id) => { draft.rules = draft.rules.filter((r) => r.ruleId !== id); };

  // any change to the draft throws the preview away; typing only re-renders the result area (no focus loss)
  const edited = () => { preview = null; error = null; notice = null; renderResult(); };
  const structural = () => { edited(); refresh(); };

  function previewNow() {
    error = null; notice = null; preview = null;
    try {
      const input = { policy: buildStationDemandPolicy(draft), walkingPolicy: buildStationDemandWalkingPolicy(draft) };
      const accessApplicationId = application()?.applicationId ?? null;
      const out = runtime.assessStationDemandAllocation(clone(input));
      preview = { input, result: out, accessApplicationId };
      walkingSeen = { accessApplicationId, links: listOf(out?.walking?.links).filter((l) => (l.acknowledgeable && !l.usable) || l.acknowledged).map((l) => ({ walkLinkId: l.walkLinkId, stationAccessId: l.stationAccessId, status: l.status, reasons: listOf(l.reasons) })) };
    } catch (e) { error = message(e); }
    refresh();
  }

  function bind(ruleIds) {
    let failure = null;
    try {
      const assessment = application()?.assessment;
      for (const id of ruleIds) {
        const rule = ruleOf(id);
        if (rule) rule.boundTo = bindStationDemandAllocationRule(policyRuleOf({ ...rule, boundTo: null }), { assessment }).boundTo;
      }
    } catch (e) { failure = message(e); }
    edited();
    error = failure;
    refresh();
  }

  function applyBlock() {
    if (!preview) return "미리보기를 먼저 실행하세요.";
    const out = preview.result;
    if (out.policyStatus !== "valid") return `정책을 적용할 수 없음 (${out.policyStatus})`;
    if (out.status !== "current") return out.status === "stale" ? "정책이 오래됨 — 규칙을 현재 revision에 다시 묶으세요" : `정책 상태: ${out.status}`;
    return null;
  }

  function applyNow() {
    if (applyBlock() !== null) return;
    try {
      // exactly what was previewed, not a rebuilt copy
      const report = runtime.applyStationDemandAllocation(clone(preview.input));
      preview = null; error = null; notice = `적용됨 · 엔진이 만든 링크 ${listOf(report?.links).length}개`;
      refresh();
      onChange();
    } catch (e) { notice = null; error = message(e); refresh(); }
  }

  function refresh() {
    const current = application();
    // a preview made against another access drawing is not a preview of what would happen now
    if (preview && preview.accessApplicationId !== (current?.applicationId ?? null)) { preview = null; notice = null; }
    applyButton = null;
    const view = buildAllocationAuthoringView(current);
    const children = [text(doc, "p", "alloc-notice", SCOPE_NOTICE)];
    if (!view.available) children.push(text(doc, "p", "alloc-empty", say(view.reason)));
    else children.push(...authoringSection(view, current));
    children.push(result);
    renderResult();
    container.replaceChildren(...children);
  }

  // --- authoring ---
  function authoringSection(view, current) {
    const nodes = [];
    const assumption = el(doc, "input", { type: "checkbox", checked: draft.areaNodeInclusion === "centroid" });
    assumption.addEventListener("change", () => { draft.areaNodeInclusion = assumption.checked ? "centroid" : "reject"; structural(); });
    nodes.push(el(doc, "label", { className: "alloc-check" }, assumption, text(doc, "span", "", "면적형 수요 자료(격자·필지·블록)의 노드를 중심점으로 본다고 가정함")));

    nodes.push(text(doc, "strong", "alloc-section", `역 접근권 ${view.stations.length}곳`));
    for (const s of view.stations) {
      const rule = ruleOf(`exclusive:${s.stationAccessId}`);
      const row = el(doc, "div", { className: "alloc-station" }, text(doc, "b", "", s.label),
        text(doc, "span", "alloc-coverage", `접근권 ${s.coverage} · 단독 노드 ${s.exclusiveNodeCount}개 · 미상 노드 ${s.unknownNodeCount}개`));
      if (s.unknownReasons.length) row.append(text(doc, "div", "alloc-note", `미상 사유: ${s.unknownReasons.map(say).join(", ")}`));
      const mode = choose(doc, [["hold", "보류(배정 안 함)"], ["assign", "단독 노드 100% 배정"]], rule ? "assign" : "hold", (value) => {
        if (value === "assign") upsert({ ruleId: `exclusive:${s.stationAccessId}`, kind: "station-exclusive", stationAccessId: s.stationAccessId, boundTo: null }); else drop(`exclusive:${s.stationAccessId}`);
        structural();
      }, "alloc-exclusive");
      mode.disabled = s.exclusiveNodeCount === 0 && !rule;
      row.append(mode);
      if (rule) row.append(...bindingControls(rule, view));
      nodes.push(row);
    }

    nodes.push(text(doc, "strong", "alloc-section", `겹친 수요 노드 ${view.sharedNodes.length}개`));
    if (!view.sharedNodes.length) nodes.push(text(doc, "p", "alloc-empty", "여러 역 접근권에 걸친 노드가 없습니다."));
    for (const n of view.sharedNodes) nodes.push(sharedNodeRow(n, view));
    if (view.unknownNodes.length) {
      nodes.push(text(doc, "strong", "alloc-section", `미상 노드 ${view.unknownNodes.length}개 (배분 불가 — 어떤 규칙으로도 풀 수 없음)`));
      for (const n of view.unknownNodes) nodes.push(text(doc, "div", "alloc-unknown", `${n.demandNodeId} · ${n.reasons.map(say).join(", ")}`));
    }

    nodes.push(text(doc, "strong", "alloc-section", "보행 정책"));
    nodes.push(el(doc, "label", { className: "alloc-field" }, text(doc, "span", "", "그린 보행선이 없을 때"),
      choose(doc, [["none", "추정하지 않음(기본)"], ["straight-line", "직선거리 × 1.3 추정을 허용"]], draft.walking.walkEstimate, (value) => { draft.walking.walkEstimate = value; structural(); }, "alloc-walk-estimate")));
    const seen = walkingSeen.accessApplicationId === (current?.applicationId ?? null) ? walkingSeen.links : [];
    if (!seen.length) nodes.push(text(doc, "p", "alloc-empty", "확인이 필요한 보행 링크는 미리보기를 실행하면 여기에 나옵니다."));
    for (const link of seen) {
      const box = el(doc, "input", { type: "checkbox", checked: draft.walking.acknowledgedWalkLinkIds.includes(link.walkLinkId) });
      box.addEventListener("change", () => {
        const set = new Set(draft.walking.acknowledgedWalkLinkIds);
        if (box.checked) set.add(link.walkLinkId); else set.delete(link.walkLinkId);
        draft.walking.acknowledgedWalkLinkIds = [...set].sort(cmp);
        structural();
      });
      nodes.push(el(doc, "label", { className: "alloc-check alloc-walk-link" }, box,
        text(doc, "span", "", `${link.walkLinkId} · ${WALK_STATUS[link.status] ?? link.status}${link.reasons.length ? ` · ${link.reasons.map(say).join(", ")}` : ""} — 다리·통로가 있음을 확인함`)));
    }

    const previewButton = el(doc, "button", { type: "button", textContent: "미리보기" });
    previewButton.addEventListener("click", previewNow);
    applyButton = el(doc, "button", { type: "button", textContent: "정책 적용" });
    applyButton.addEventListener("click", applyNow);
    const all = el(doc, "button", { type: "button", textContent: "모든 규칙을 현재 revision에 묶기", disabled: !draft.rules.length });
    all.addEventListener("click", () => bind(draft.rules.map((r) => r.ruleId)));
    nodes.push(el(doc, "div", { className: "alloc-actions" }, all, previewButton, applyButton));
    return nodes;
  }

  function bindingControls(rule, view) {
    const state = bindingOf(rule, view);
    const button = el(doc, "button", { type: "button", textContent: "현재 revision에 묶기", disabled: state === "missing" });
    button.addEventListener("click", () => bind([rule.ruleId]));
    return [text(doc, "span", `alloc-binding ${state}`, BINDING_TEXT[state]), button];
  }

  function sharedNodeRow(n, view) {
    const id = `node:${n.demandNodeId}`;
    const rule = ruleOf(id);
    const labels = Object.fromEntries(view.stations.map((s) => [s.stationAccessId, s.label]));
    const row = el(doc, "div", { className: "alloc-node" }, text(doc, "b", "", n.demandNodeId),
      text(doc, "span", "alloc-coverage", `주장하는 역: ${n.claimants.map((c) => labels[c] ?? c).join(", ")} · 거주 ${valueText(n.residents)} · 종사 ${valueText(n.jobs)}`));
    const mode = choose(doc, [["none", "규칙 없음(미배정)"], ["assign", "한 역에 100%"], ["shares", "역별 명시 비율"]], !rule ? "none" : rule.kind === "node-assign" ? "assign" : "shares", (value) => {
      if (value === "none") drop(id);
      else if (value === "assign") upsert({ ruleId: id, kind: "node-assign", demandNodeId: n.demandNodeId, stationAccessId: null, boundTo: rule?.boundTo ?? null });
      else upsert({ ruleId: id, kind: "node-shares", demandNodeId: n.demandNodeId, shares: Object.fromEntries(n.claimants.map((c) => [c, ""])), boundTo: rule?.boundTo ?? null });
      structural();
    }, "alloc-node-mode");
    row.append(mode);
    if (rule?.kind === "node-assign") {
      row.append(choose(doc, [["", "역 선택…"], ...n.claimants.map((c) => [c, labels[c] ?? c])], rule.stationAccessId ?? "", (value) => { rule.stationAccessId = value === "" ? null : value; edited(); }, "alloc-node-station"));
    }
    if (rule?.kind === "node-shares") {
      for (const c of n.claimants) {
        const input = el(doc, "input", { type: "text", placeholder: "%", value: rule.shares[c] ?? "" });
        input.addEventListener("input", () => { rule.shares[c] = input.value; edited(); });
        row.append(el(doc, "label", { className: "alloc-field alloc-share" }, text(doc, "span", "", `${labels[c] ?? c} (%)`), input));
      }
      row.append(text(doc, "div", "alloc-note", FRACTIONAL_NOTICE));
    }
    if (rule) row.append(...bindingControls(rule, view));
    return row;
  }

  // --- result: the engine's preview and the applied state, read only ---
  function renderResult() {
    const nodes = [];
    if (error) nodes.push(text(doc, "div", "alloc-error", error));
    if (notice) nodes.push(text(doc, "div", "alloc-notice", notice));
    if (preview) nodes.push(...previewSection(preview.result));
    nodes.push(...appliedSection(runtime.stationDemandAllocationReport(), runtime.stationDemandAllocationDiagnostics()));
    const why = applyButton ? applyBlock() : null;
    if (why) nodes.push(text(doc, "div", "alloc-note alloc-apply-blocked", why));
    result.replaceChildren(...nodes);
    if (applyButton) applyButton.disabled = applyBlock() !== null;
  }

  function previewSection(out) {
    const nodes = [text(doc, "strong", "alloc-section", "미리보기 (엔진 판정 · 아직 적용되지 않음)")];
    const totals = out.allocation?.totals ?? {};
    nodes.push(el(doc, "div", { className: "alloc-metrics" }, metric(doc, "정책", out.policyStatus), metric(doc, "상태", out.status), metric(doc, "노드", valueText(totals.nodes)),
      metric(doc, "배정", valueText(totals.assigned)), metric(doc, "일부 배정", valueText(totals.partlyAssigned)), metric(doc, "보류", valueText(totals.held)), metric(doc, "미상", valueText(totals.unknown)),
      metric(doc, "만들어질 링크", String(listOf(out.links).length))));
    for (const issue of listOf(out.allocation?.policyIssues)) nodes.push(text(doc, "div", "alloc-issue", `정책 이슈: ${say(issue.code)}${issue.rule || issue.ruleId ? ` · 규칙 ${issue.rule ?? issue.ruleId}` : ""}`));
    for (const rule of listOf(out.allocation?.rules)) nodes.push(text(doc, "div", `alloc-rule-status ${rule.status}`, `규칙 ${rule.ruleId}: ${RULE_STATUS[rule.status] ?? rule.status}${listOf(rule.staleStationAccessIds).length ? ` · 오래된 역 ${rule.staleStationAccessIds.join(", ")}` : ""}${listOf(rule.reasons).length ? ` · ${rule.reasons.map(say).join(", ")}` : ""}`));
    const allocNodes = listOf(out.allocation?.nodes);
    const group = (title, className, rows) => { nodes.push(text(doc, "div", `alloc-group-title ${className}`, `${title} ${rows.length}`)); for (const row of rows) nodes.push(text(doc, "div", `alloc-line ${className}`, row)); };
    group("배정", "assigned", allocNodes.filter((n) => n.decision === "assigned" || n.decision === "shares").map((n) => `${n.demandNodeId} → ${n.assignments.map((a) => `${a.stationAccessId} ${percent(a.share)}`).join(", ")}${n.unallocatedShare > 0 ? ` · 미배정 ${percent(n.unallocatedShare)}` : ""}`));
    group("미배정(보류)", "held", allocNodes.filter((n) => n.decision === "held").map((n) => `${n.demandNodeId} · ${listOf(n.reasons).map(say).join(", ")}`));
    group("미상(배분 불가)", "unknown", allocNodes.filter((n) => n.decision === "unknown").map((n) => `${n.demandNodeId} · ${listOf(n.reasons).map(say).join(", ")}`));
    const walking = listOf(out.walking?.nodes);
    const blocked = listOf(out.blockedLinks);
    group("보행 차단·미확인", "walk-blocked", blocked.filter((b) => b.code === "walk-path-unavailable").map((b) => {
      const records = walking.filter((w) => w.stationAccessId === b.stationAccessId && w.demandNodeId === b.demandNodeId);
      return `${b.demandNodeId} → ${b.stationAccessId} · ${records.length ? records.map((w) => `${WALK_STATUS[w.status] ?? w.status}${listOf(w.reasons).length ? ` (${w.reasons.map(say).join(", ")})` : ""}`).join(" / ") : say(b.code)}`;
    }));
    group("운행역 미연결", "not-operational", blocked.filter((b) => b.code === "station-not-operational" || b.code === "station-operational-ambiguous").map((b) => `${b.demandNodeId} → ${b.stationAccessId} · ${say(b.code)}`));
    group("오래된 규칙", "stale", listOf(out.allocation?.rules).filter((r) => r.status === "stale").map((r) => `${r.ruleId} · ${listOf(r.staleStationAccessIds).join(", ") || "주장 역이 바뀜"}`));
    group("적용하면 생기는 링크", "links", listOf(out.links).map((l) => `${l.demandNodeId} → ${l.stationId} · 도보 ${l.walkMinutes}분`));
    const overrides = listOf(out.allocation?.legacy?.overrideRequiredNodeIds);
    if (overrides.length) nodes.push(text(doc, "div", "alloc-note", `기존 접근 링크를 대체하는 노드 ${overrides.length}개: ${overrides.join(", ")}`));
    return nodes;
  }

  function appliedSection(report, diagnostics) {
    const nodes = [text(doc, "strong", "alloc-section", "엔진에 적용된 배분")];
    if (!report) { nodes.push(text(doc, "p", "alloc-empty", "아직 적용된 배분이 없습니다.")); return nodes; }
    nodes.push(el(doc, "div", { className: `alloc-metrics alloc-applied ${report.status}` }, metric(doc, "상태", report.status === "current" ? "현재" : report.status === "stale" ? "오래됨" : String(report.status)),
      metric(doc, "정책", report.allocationPolicy?.policyId ?? "—"), metric(doc, "생성된 링크", String(listOf(report.links).length)), metric(doc, "막힌 링크", String(listOf(report.blockedLinks).length)),
      metric(doc, "적용 시각", report.appliedAtSimMinute === null || report.appliedAtSimMinute === undefined ? "미상" : `${report.appliedAtSimMinute}분`)));
    if (report.status === "stale") nodes.push(text(doc, "div", "alloc-warning", `역 접근권 export가 바뀌어 오래됨 — 기존 링크는 그대로이고, 다시 적용해야 갱신됩니다.${listOf(report.staleReasons).length ? ` (${report.staleReasons.map(say).join(", ")})` : ""}`));
    for (const link of listOf(report.links)) nodes.push(text(doc, "div", "alloc-line alloc-link", `${link.demandNodeId} → ${link.stationId} · 도보 ${link.walkMinutes}분`));
    nodes.push(...diagnosticsSection(diagnostics));
    return nodes;
  }

  // E6 already counted the choices while routing. This panel only copies those facts; it does not infer riders or demand.
  function diagnosticsSection(diagnostics) {
    if (!diagnostics || diagnostics.status === "no-allocation") return [];
    const totals = diagnostics.totals ?? {};
    const splitNodes = Number.isSafeInteger(totals.splitNodes) ? totals.splitNodes : 0;
    const nodes = [text(doc, "strong", "alloc-section", "분할 배정 운행 진단 (엔진 선택 기록)")];
    if (!splitNodes) {
      nodes.push(text(doc, "p", "alloc-empty", "분할 배정 선택 기록이 없습니다. 단일 역 배정 또는 기존 접근 경로입니다."));
      return nodes;
    }
    const role = (id, label) => {
      const value = totals.byRole?.[id] ?? {};
      return metric(doc, label, `선택 ${valueText(value.picks)}회 · 경로 없음 ${valueText(value.unrouted)}회`);
    };
    nodes.push(el(doc, "div", { className: "alloc-metrics" }, metric(doc, "분할 노드", String(splitNodes)), role("origin", "출발"), role("destination", "도착")));
    for (const node of listOf(diagnostics.nodes).filter((entry) => entry.routing === "split")) {
      const card = text(doc, "div", "alloc-line alloc-routing", `노드 ${node.demandNodeId}`);
      for (const roleEntry of [node.roles?.origin, node.roles?.destination]) {
        if (!roleEntry) continue;
        const slots = listOf(roleEntry.slots).map((slot) => `${slot.stationId ?? "역 없음"}: 설정 ${percent(slot.configuredShare)} · 선택 ${valueText(slot.picks)}회 · 엔진 기준 ${valueText(slot.expectedPicks)}회`).join(" / ");
        const reasons = Object.entries(roleEntry.trips?.unroutedByReason ?? {}).filter(([, count]) => count !== null && count > 0).map(([code, count]) => `${DIAGNOSTIC_REASON[code] ?? code} ${count}회`).join(", ");
        card.append(text(doc, "div", "alloc-fact", `${roleEntry.role === "origin" ? "출발" : "도착"} · ${slots}${reasons ? ` · 경로 없음: ${reasons}` : ""}`));
      }
      nodes.push(card);
    }
    for (const entry of listOf(diagnostics.limits).filter((limit) => !["none", "info"].includes(limit.status))) {
      nodes.push(text(doc, "div", entry.status === "observed" || entry.status === "active" ? "alloc-warning" : "alloc-note", `${entry.status} · ${entry.text}`));
    }
    return nodes;
  }

  refresh();
  return {
    refresh,
    serialize: () => serializeAllocationDraft(draft),
    // -> { ok, issues }. A refused document leaves the current draft untouched; a loaded one discards any preview. No engine call.
    loadDoc(input) {
      const { draft: loaded, issues } = restoreAllocationDraft(input);
      if (!loaded) return { ok: false, issues };
      draft = loaded; preview = null; error = null; notice = null;
      refresh();
      return { ok: true, issues: [] };
    },
    get document() { return clone(draft); },
  };
}
