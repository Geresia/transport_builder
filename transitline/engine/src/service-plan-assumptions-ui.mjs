// Operational assumptions panel for map service plans (B16-M4): an independent panel (a container element, no map canvas) where the
// player states what B13 needs and the map does not know — the technical profile or an explicit technical specification of the line,
// the track count, the minimum headway, closure windows per track segment, the day type and the minimum acceptance ratio. Every value is
// the player's own statement and is shown as such; a field left empty stays unknown ("미상") and no default is ever filled in. The panel
// computes nothing: it does not derive capacity from headway or headway from capacity, does not build or judge a timetable and does
// not touch the engine. What it hands on is `technicalSpecs()` (for getPrescreenContext) and `assessInput(servicePlanId)` (for
// ScenarioRuntime.assessServicePlanTimetable). The player's document is kept by the host's `storage` ({ getItem, setItem }, optional).
//
//   const panel = mountServicePlanAssumptionsPanel({ container, pack, getServicePlans, getTechnicalProfiles, storage: localStorage, onChange });
import { buildAssumptionExport, DAY_TYPES, DIRECTION_MODES, STATEMENT_FIELDS } from "./service-plan-assumptions.mjs";
import {
  clearAssumption, declareNoClosures, entryOf, newAssumptionsDoc, rebindAssumptions, removeAssumptions, restoreAssumptionsDoc, serializeAssumptionsDoc, setAssumptions, setClosureWindows,
} from "./service-plan-assumptions-editor.mjs";
import { clone, createStore } from "./map/map-mount-kit.mjs";
import { parseNumber } from "./map/service-plan-tools.mjs";

export const ASSUMPTIONS_UI_EVENT = "transitline:service-plan-assumptions";
export const ASSUMPTIONS_STORAGE_PREFIX = "transitline.service-plan-assumptions.v1:";
export const SCOPE_NOTICE = "이 패널의 값은 플레이어가 적은 가정입니다. 비워 두면 미상으로 남고 기본값을 넣지 않습니다. 시격과 선로 수송 설정은 서로 계산하지 않으며, 시간표를 만들거나 심사하지도 않습니다. 계획이 바뀌면 적어 둔 가정은 낡은 것이 되고, 다시 확인하기 전에는 넘기지 않습니다.";
export const TRACK_COUNT_NOTICE = "사전심사의 방향 모드 항목은 지도에 적힌 단·복선을 읽습니다. 여기서 적은 단·복선은 시간표 심사 입력으로만 넘어가며, 지도에 단·복선이 없으면 그 항목은 계속 미상입니다.";
const LABELS = Object.freeze({
  technicalProfileId: "기술 프로필", technicalSpecification: "명시적 기술사양", notApplicable: "해당 없는 항목", capacityTrainsPerHour: "시간당 열차 수(직접 적은 값)", directionMode: "단·복선",
  minimumHeadwayMinutes: "최소 시격(분)", closureWindowsBySectionId: "폐쇄 시간창", dayType: "요일 유형", minimumAcceptanceRatio: "수용 비율(0~1)",
});
const STYLE_ID = "transitline-service-plan-assumptions-style";
const CSS = ".svcassume-field{display:inline-flex;gap:4px;margin:2px 8px 2px 0}.svcassume-closure{margin:3px 0}.svcassume-closure-state{margin:0 8px}.svcassume-section{display:block;margin-top:8px;color:#ffe66d}.svcassume-warning{color:#ffb703}.svcassume-note,.svcassume-unknown,.svcassume-default{color:#aab1c0;font-size:11px}.svcassume-row.picked{background:rgba(255,255,255,.08)}.svcassume-preview{background:#1b1e26;padding:6px;overflow:auto}";
const STATE_TEXT = Object.freeze({ "plan-missing": "지도에 없는 계획", stale: "계획이 바뀜 (낡음)", current: "현재" });
const DIRECTION_LABEL = Object.freeze({ single: "단선", double: "복선" });
const DAY_LABEL = Object.freeze({ weekday: "평일", weekend: "주말", holiday: "공휴일" });
const stateWord = (set) => (set ? STATE_TEXT[set.state] : "전제 없음");
const el = (doc, tag, props = {}, ...kids) => { const node = doc.createElement(tag); Object.assign(node, props); node.append(...kids); if ("value" in props) node.value = props.value; return node; };
const txt = (doc, tag, className, value) => el(doc, tag, { className, textContent: value });
const listOf = (v) => (Array.isArray(v) ? v : v && Array.isArray(v.plans) ? v.plans : []);
const catalogOf = (v) => (Array.isArray(v) ? v.map((x) => (typeof x === "string" ? { id: x, name: x } : { id: String(x.id), name: x.name ?? String(x.id) })) : null);

export function mountServicePlanAssumptionsPanel({ container, pack, getServicePlans, getTechnicalProfiles = null, storage = null, onChange = () => {} } = {}) {
  if (!container) throw new Error("An assumptions container is required");
  if (!pack?.manifest) throw new Error("A pack is required");
  if (typeof getServicePlans !== "function") throw new Error("getServicePlans() returning the map service plans is required");
  const doc = container.ownerDocument ?? document;
  if (doc.head && doc.getElementById && !doc.getElementById(STYLE_ID)) doc.head.append(el(doc, "style", { id: STYLE_ID, textContent: CSS })); // its own style, so the host page needs none
  const packId = pack.manifest.id ?? "pack";
  const notes = [];
  const store = storage ? createStore({ win: { localStorage: storage }, key: `${ASSUMPTIONS_STORAGE_PREFIX}${packId}`, pack, restore: restoreAssumptionsDoc, serialize: serializeAssumptionsDoc, notes }) : null;
  let assumptions = store ? store.doc : newAssumptionsDoc(packId, pack.manifest.version ?? null);
  let saved = null;
  let selectedId = null;
  let drafts = { spec: "", closure: {} };
  let built = null;

  const plans = () => listOf(getServicePlans()).filter((p) => p && typeof p.servicePlanId === "string");
  const planOf = (id) => plans().find((p) => p.servicePlanId === id) ?? null;
  const profiles = () => (typeof getTechnicalProfiles === "function" ? catalogOf(getTechnicalProfiles()) : null);
  const knownIds = () => profiles()?.map((p) => p.id) ?? null;
  const setOf = (id) => built?.sets.find((s) => s.servicePlanId === id) ?? null;
  const recompute = () => { built = buildAssumptionExport({ pack, doc: assumptions, servicePlans: plans(), knownTechnicalProfileIds: knownIds() }); };
  const note = (code, message) => { const last = notes.at(-1); if (!last || last.code !== code || last.message !== message) notes.push({ code, message }); };
  const outputNow = () => ({
    document: clone(assumptions), export: clone(built), selectedServicePlanId: selectedId, technicalSpecs: clone(built.technical.technicalSpecs), technicalConflicts: clone(built.technical.conflicts),
    assessInputs: Object.fromEntries(built.sets.filter((s) => s.usable).map((s) => [s.servicePlanId, clone(s.assessInput)])), warnings: [...clone(notes), ...built.sets.flatMap((s) => clone(s.warnings))],
  });
  function emit() {
    const out = outputNow();
    onChange(out);
    container.dispatchEvent?.(new CustomEvent(ASSUMPTIONS_UI_EVENT, { detail: out }));
  }
  // the one place an edit goes through: the editor checks it, a refusal is a note and changes nothing, an accepted one is saved
  function edit(fn) {
    let ok = true;
    try { fn(); if (store) saved = store.save(assumptions, "service-plan-assumptions-doc-not-saved"); } catch (error) { ok = false; note("service-plan-assumptions-refused", String(error.message)); }
    refresh();
    return ok;
  }
  const planFor = (id) => planOf(id) ?? (() => { throw new Error("The service plan is not on the map any more"); })();
  const stateField = (id, field, value) => edit(() => setAssumptions(assumptions, planFor(id), { [field]: value }, { knownTechnicalProfileIds: knownIds() }));
  const numberField = (id, field, textValue) => {
    const n = parseNumber(textValue);
    if (Number.isNaN(n)) { note("service-plan-assumptions-refused", `${LABELS[field]}: 숫자가 아닙니다`); refresh(); return false; }
    return stateField(id, field, n === undefined ? null : n);
  };
  function specField(id, source) {
    drafts.spec = source;
    if (String(source).trim() === "") return stateField(id, "technicalSpecification", null);
    let parsed;
    try { parsed = JSON.parse(source); } catch { note("service-plan-assumptions-refused", "기술사양: JSON으로 읽을 수 없습니다"); refresh(); return false; }
    return stateField(id, "technicalSpecification", parsed);
  }
  function addWindow(id, sectionId) {
    const d = drafts.closure[sectionId] ?? {};
    const start = parseNumber(d.start);
    const end = parseNumber(d.end);
    if (start === undefined || end === undefined || Number.isNaN(start) || Number.isNaN(end)) { note("service-plan-assumptions-refused", "폐쇄 시간창: 시작과 끝을 분(숫자)으로 적으세요"); refresh(); return false; }
    const windows = entryOf(assumptions, id)?.statements.closureWindowsBySectionId?.[sectionId] ?? [];
    const ok = edit(() => setClosureWindows(assumptions, planFor(id), sectionId, [...windows, { startMinute: start, endMinute: end, ...(d.reason ? { reason: d.reason } : {}) }]));
    if (ok) { delete drafts.closure[sectionId]; refresh(); }
    return ok;
  }
  function select(id) {
    selectedId = id;
    const spec = entryOf(assumptions, id)?.statements.technicalSpecification;
    drafts = { spec: spec === null || spec === undefined ? "" : JSON.stringify(spec), closure: {} };
    refresh();
    return true;
  }

  const field = (label, control) => el(doc, "label", { className: "svcassume-field" }, txt(doc, "span", "", label), control);
  function selectControl(options, value, onPick) {
    const s = el(doc, "select", { value: value ?? "" }, ...options.map(([v, l]) => el(doc, "option", { value: v, textContent: l })));
    s.addEventListener("change", () => onPick(s.value === "" ? null : s.value));
    return s;
  }
  function inputControl(value, onCommit, cls = "") { const i = el(doc, "input", { className: cls, type: "text", value: value === null || value === undefined ? "" : String(value) }); i.addEventListener("change", () => onCommit(i.value)); return i; }
  function button(label, fn) { const b = el(doc, "button", { type: "button", textContent: label }); b.addEventListener("click", fn); return b; }

  function planRows() {
    const rows = [];
    for (const p of plans()) {
      const set = setOf(p.servicePlanId);
      rows.push(el(doc, "div", { className: `svcassume-row ${set?.state ?? "none"}${p.servicePlanId === selectedId ? " picked" : ""}` }, txt(doc, "span", "", `${p.name ?? p.servicePlanId} · ${stateWord(set)}`), button("선택", () => select(p.servicePlanId))));
    }
    for (const set of built.sets.filter((s) => s.state === "plan-missing")) rows.push(el(doc, "div", { className: "svcassume-row plan-missing" }, txt(doc, "span", "", `${set.servicePlanId} · 지도에 없는 계획의 전제 (문서에는 그대로 남음)`), button("선택", () => select(set.servicePlanId))));
    return rows;
  }

  function closureSection(id, statements, plan) {
    const nodes = [txt(doc, "strong", "svcassume-section", LABELS.closureWindowsBySectionId)];
    const stated = statements.closureWindowsBySectionId;
    const routeIds = Array.isArray(plan?.route?.sections) ? plan.route.sections.map((s) => s?.trackSegmentId).filter((x) => typeof x === "string") : [];
    const ids = [...new Set([...routeIds, ...Object.keys(stated ?? {})])].sort();
    nodes.push(txt(doc, "div", "svcassume-note", stated === null ? "폐쇄 시간창: 미상 (적지 않음). 적지 않은 구간은 시간표 심사가 '폐쇄 없음'으로 읽지만 이는 플레이어의 진술이 아닙니다." : "구간마다 시간창을 적거나 '없음으로 선언'하세요. 적지 않은 구간은 미기재입니다."));
    if (!routeIds.length) nodes.push(txt(doc, "div", "svcassume-note", "이 계획의 트랙 구간을 알 수 없어 구간 ID를 직접 적어야 합니다."));
    for (const sectionId of ids) {
      const windows = stated?.[sectionId];
      const d = (drafts.closure[sectionId] ??= { start: "", end: "", reason: "" });
      const status = windows === undefined ? " · 미기재" : windows.length ? ` · ${windows.map((w) => `${w.startMinute}–${w.endMinute}분${w.reason ? `(${w.reason})` : ""}`).join(", ")}` : " · 없음(선언됨)";
      nodes.push(el(doc, "div", { className: "svcassume-closure" },
        txt(doc, "b", "", sectionId), txt(doc, "span", "svcassume-closure-state", status),
        field("시작(분)", inputControl(d.start, (v) => { d.start = v; })), field("끝(분)", inputControl(d.end, (v) => { d.end = v; })), field("사유", inputControl(d.reason, (v) => { d.reason = v; })),
        button("시간창 추가", () => addWindow(id, sectionId)), button("없음으로 선언", () => edit(() => setClosureWindows(assumptions, planFor(id), sectionId, []))), button("미기재로", () => edit(() => setClosureWindows(assumptions, planFor(id), sectionId, null)))));
    }
    nodes.push(el(doc, "div", { className: "svcassume-closure" }, field("구간 ID 추가", inputControl("", (v) => { if (v.trim()) edit(() => setClosureWindows(assumptions, planFor(id), v.trim(), [])); }))), button("모든 구간 없음으로 선언", () => edit(() => declareNoClosures(assumptions, planFor(id)))));
    if (stated !== null) nodes.push(button("폐쇄 시간창을 적지 않은 상태로", () => edit(() => clearAssumption(assumptions, id, "closureWindowsBySectionId"))));
    return nodes;
  }

  function card(id) {
    const set = setOf(id);
    const plan = planOf(id);
    const s = set?.statements ?? Object.fromEntries(STATEMENT_FIELDS.map((f) => [f, null]));
    const node = el(doc, "div", { className: `svcassume-card ${set?.state ?? "none"}` });
    node.append(el(doc, "div", { className: "svcassume-id" }, txt(doc, "span", "", "지도 계획 ID"), txt(doc, "code", "", id)),
      txt(doc, "div", "svcassume-facts", `운영 노선 ${plan?.operationalLineId ?? set?.operationalLineId ?? "미상"} · 전제가 묶인 계획 개정 ${set ? set.boundServicePlanRevision : "아직 없음"} · 현재 계획 개정 ${plan?.servicePlanRevision ?? "미상"} · 상태 ${stateWord(set)}`),
      txt(doc, "div", "svcassume-basis", "모든 값은 플레이어가 적은 가정입니다 (basis: player-stated-assumption)"));
    if (set && set.state === "stale") node.append(txt(doc, "div", "svcassume-warning", "계획이 바뀌어 이 전제는 낡았습니다. 아래 값은 그대로 보존되지만 다시 확인하기 전에는 시간표 심사에 넘기지 않습니다."), button("계획이 바뀐 것을 확인했고 이 전제를 계속 씁니다", () => edit(() => rebindAssumptions(assumptions, planFor(id)))));
    if (!plan) {
      node.append(txt(doc, "div", "svcassume-warning", "이 계획은 지금 지도에 없습니다. 전제는 보존되며 편집할 수 없습니다."), button("전제 삭제", () => { edit(() => removeAssumptions(assumptions, id)); selectedId = null; refresh(); }));
      return node;
    }
    node.append(txt(doc, "strong", "svcassume-section", "기술사양"));
    const catalog = profiles();
    node.append(field(LABELS.technicalProfileId, catalog ? selectControl([["", "(고르지 않음 · 미상)"], ...catalog.map((p) => [p.id, p.name])], s.technicalProfileId, (v) => stateField(id, "technicalProfileId", v)) : inputControl(s.technicalProfileId, (v) => stateField(id, "technicalProfileId", v.trim() === "" ? null : v.trim()))));
    node.append(field(`${LABELS.technicalSpecification} (JSON)`, inputControl(drafts.spec, (v) => specField(id, v), "svcassume-spec")), txt(doc, "div", "svcassume-note", "예: {\"minCars\":4,\"signalSystemIds\":[\"ats-p\"]} — 비우면 미상입니다. 아는 항목만 적으세요."));
    node.append(field(LABELS.notApplicable, selectControl([["", "(적지 않음 · 미상)"], ["none", "없음으로 선언"], ["gaugeMm", "게이지는 해당 없음"]], s.notApplicable === null ? "" : s.notApplicable.length ? s.notApplicable[0] : "none", (v) => stateField(id, "notApplicable", v === null ? null : v === "none" ? [] : [v]))));
    node.append(field(LABELS.capacityTrainsPerHour, inputControl(s.capacityTrainsPerHour, (v) => numberField(id, "capacityTrainsPerHour", v), "svcassume-capacity")));
    node.append(txt(doc, "strong", "svcassume-section", "선로 전제"), txt(doc, "div", "svcassume-note", TRACK_COUNT_NOTICE));
    node.append(field(LABELS.directionMode, selectControl([["", "(적지 않음 · 미상)"], ...DIRECTION_MODES.map((m) => [m, DIRECTION_LABEL[m]])], s.directionMode, (v) => stateField(id, "directionMode", v))));
    node.append(field(LABELS.minimumHeadwayMinutes, inputControl(s.minimumHeadwayMinutes, (v) => numberField(id, "minimumHeadwayMinutes", v), "svcassume-headway")));
    node.append(...closureSection(id, s, plan));
    node.append(txt(doc, "strong", "svcassume-section", "시간표 심사 조건"));
    node.append(field(LABELS.dayType, selectControl([["", "(적지 않음 · 미상)"], ...DAY_TYPES.map((d) => [d, DAY_LABEL[d]])], s.dayType, (v) => stateField(id, "dayType", v))));
    node.append(field(LABELS.minimumAcceptanceRatio, inputControl(s.minimumAcceptanceRatio, (v) => numberField(id, "minimumAcceptanceRatio", v), "svcassume-ratio")));
    if (set) {
      node.append(txt(doc, "strong", "svcassume-section", "정리"));
      node.append(txt(doc, "div", "svcassume-stated", `적은 항목: ${set.statedFields.length ? set.statedFields.map((f) => LABELS[f]).join(", ") : "없음"}`));
      for (const f of set.unknown) node.append(txt(doc, "div", "svcassume-unknown", `${LABELS[f]}: 미상 (${set.unknownReasons[f]})`));
      for (const d of set.defaultsApplyDownstream) node.append(txt(doc, "div", "svcassume-default", `${LABELS[d.field]}: 적지 않아서 시간표 심사 쪽 처리(${d.downstream})가 적용됩니다 — 플레이어가 정한 값이 아닙니다`));
      if (set.closureSectionsNotStated?.length) node.append(txt(doc, "div", "svcassume-default", `폐쇄 시간창을 적지 않은 구간: ${set.closureSectionsNotStated.join(", ")}`));
      for (const w of set.warnings) node.append(txt(doc, "div", "svcassume-warning", `⚠ ${w.code}${w.message ? ` — ${w.message}` : ""}`));
      node.append(txt(doc, "div", "svcassume-preview-title", set.usable ? "시간표 심사 입력 (적은 값만)" : "시간표 심사 입력: 넘기지 않음"), txt(doc, "pre", "svcassume-preview", set.usable ? JSON.stringify(set.assessInput, null, 2) : "—"));
    }
    node.append(button("전제를 적지 않은 상태로 되돌리기(삭제)", () => { if (entryOf(assumptions, id)) edit(() => removeAssumptions(assumptions, id)); }));
    return node;
  }

  function refresh() {
    recompute();
    if (selectedId && !planOf(selectedId) && !setOf(selectedId)) selectedId = null;
    const children = [txt(doc, "p", "svcassume-notice", SCOPE_NOTICE), txt(doc, "strong", "svcassume-section", `서비스 계획 ${plans().length}건 · 전제 ${built.sets.length}건`)];
    if (!plans().length) children.push(txt(doc, "p", "svcassume-empty", "지도에 서비스 계획이 없습니다."));
    children.push(...planRows());
    if (selectedId) children.push(card(selectedId));
    if (built.technical.conflicts.length) children.push(txt(doc, "div", "svcassume-warning", `같은 노선에 서로 다른 기술사양을 적은 계획이 있어 그 노선은 넘기지 않습니다: ${built.technical.conflicts.map((c) => c.operationalLineId).join(", ")}`));
    children.push(txt(doc, "div", "svcassume-saved", !store ? "저장소 없음 (호스트가 serialize()로 저장)" : saved === null ? "저장 전" : saved ? "저장됨" : "저장하지 못함"));
    for (const n of notes.slice(-5)) children.push(txt(doc, "div", "svcassume-warning", `⚠ ${n.code}${n.message ? ` — ${n.message}` : ""}`));
    container.replaceChildren(...children);
    emit();
  }
  refresh();

  return {
    output: () => outputNow(),
    technicalSpecs: () => clone(built.technical.technicalSpecs),
    assessInput: (servicePlanId) => { const set = setOf(servicePlanId); return set?.usable ? clone(set.assessInput) : null; },
    select, deselect() { selectedId = null; refresh(); },
    set: (servicePlanId, patch) => edit(() => setAssumptions(assumptions, planFor(servicePlanId), patch, { knownTechnicalProfileIds: knownIds() })),
    setClosureWindows: (servicePlanId, sectionId, windows) => edit(() => setClosureWindows(assumptions, planFor(servicePlanId), sectionId, windows)),
    declareNoClosures: (servicePlanId) => edit(() => declareNoClosures(assumptions, planFor(servicePlanId))),
    clear: (servicePlanId, field) => edit(() => clearAssumption(assumptions, servicePlanId, field)),
    rebind: (servicePlanId) => edit(() => rebindAssumptions(assumptions, planFor(servicePlanId))),
    remove: (servicePlanId) => edit(() => removeAssumptions(assumptions, servicePlanId)),
    serialize: () => serializeAssumptionsDoc(assumptions),
    // Replaces the whole document (the host's own save). A refused document (other pack, unreadable, other version) leaves the current one untouched.
    loadDoc(source) {
      if (source === null || source === undefined) return [];
      const before = notes.length;
      const incoming = restoreAssumptionsDoc(typeof source === "string" ? source : JSON.stringify(source), pack, { current: assumptions });
      notes.push(...incoming.warnings);
      if (!incoming.rejected) { assumptions = incoming.doc; selectedId = null; if (store) saved = store.save(assumptions, "service-plan-assumptions-doc-not-saved"); }
      refresh();
      return notes.slice(before);
    },
    refresh, get selectedServicePlanId() { return selectedId; }, get document() { return clone(assumptions); }, get storageKey() { return store?.key ?? null; },
    destroy() { container.replaceChildren(); },
  };
}
