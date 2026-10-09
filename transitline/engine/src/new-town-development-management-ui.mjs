// B19-M3: the new-town development lifecycle panel.  An independent panel that lives in a host container.  It joins the map's development
// export (B19-M2) and the lifecycle records of B19-E1 by `developmentId`, shows the state of each development, and sends a lifecycle
// command to the runtime ONLY when its button is clicked.  Mounting, refreshing, selecting and typing send no command and change no engine
// state; the only runtime calls outside a click are the read-only ones (report, assess, hooks).
//
// It decides nothing and estimates nothing: the blockers shown are the ones `runtime.assessNewTownDevelopment` returned, word for word;
// a runtime error is shown as the runtime wrote it and changes nothing in the panel's records; no field has a default value that
// the player did not choose; a blank number is `null` (not stated) and "0" is 0; the B19-E2 candidates are shown as their completeness
// and `eligibleForB15` only and are applied to nothing.  Before any step that moves a development forward the panel reads the map again
// and asks the runtime again, so a geometry that went stale since the last draw is never sent on.
// The panel keeps no storage of its own: `serialize()` / `loadDoc()` carry only the selection and the forms the player is typing in.
//
//   const panel = mountNewTownDevelopmentManagementPanel({ container, runtime, getGeometryExport, onChange });
//   // runtime: a ScenarioRuntime (or ManagementGame);  getGeometryExport(): the B19-M2 `output().export`;  onChange(event)
import { buildNewTownManagementView, geometryOf, MAP_STATE_TEXT, planManagementRows, readGeometryExport } from "./new-town-development-management-view.mjs";

export const MANAGEMENT_PANEL_SCHEMA = "transitline.new-town-development-management-panel/1";
export const SCOPE_NOTICE = "이 패널은 신도시 개발의 생애주기 기록을 지도의 개발과 맞춰 보여 주고, 버튼을 누를 때만 런타임에 명령을 보냅니다. 막힘 사유는 런타임이 돌려준 그대로이며, 값이나 수량을 계산하거나 추정하지 않습니다.";
const STYLE_ID = "transitline-new-town-management-style";
const CSS = ".nt-mgmt{font:12px/1.5 system-ui,'Malgun Gothic',sans-serif}.nt-row{display:flex;gap:6px;align-items:center;margin:4px 0;padding:4px 6px;border:1px solid #2a2f3a;border-radius:6px}.nt-row.picked{border-color:#4cc9f0}.nt-row span{flex:1}.nt-map-current{border-left:3px solid #2dd4bf}.nt-map-stale,.nt-map-other-pack{border-left:3px solid #f59e0b}.nt-map-inactive,.nt-map-map-missing,.nt-map-invalid{border-left:3px solid #8b93a5}.nt-map-no-record{border-left:3px solid #a78bfa}.nt-card{margin:6px 0 10px;padding:8px;border:1px solid #2a2f3a;border-radius:6px}.nt-card h4{margin:8px 0 2px;font-size:12px}.nt-step{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:4px 0}.nt-blocker{display:inline-block;margin:0 4px 2px 0;padding:0 5px;border:1px solid #f59e0b;border-radius:4px;color:#f59e0b}.nt-open{color:#2dd4bf}.nt-error{color:#ff6b6b;white-space:pre-wrap}.nt-form{margin:2px 0 8px 12px;padding:4px 6px;border-left:2px solid #2a2f3a}.nt-field{display:inline-flex;gap:4px;align-items:center;margin:2px 8px 2px 0}.nt-note,.nt-fact{color:#aab1c0}.nt-fact{margin:1px 0}";
const REQUIRED = ["newTownDevelopmentReport", "assessNewTownDevelopment", "newTownDevelopmentHooks", "draftNewTownDevelopment", "proposeNewTownDevelopment", "agreeNewTownDevelopment", "startNewTownServicing", "recordNewTownOccupancy", "delayNewTownDevelopment", "resumeNewTownDevelopment", "cancelNewTownDevelopment"];
const STEPS = Object.freeze([["propose", "제안(propose)"], ["agree", "합의(agree)"], ["startServicing", "서비스 시작"], ["recordOccupancy", "입주 사실 기록"], ["delay", "지연(delay)"], ["resume", "재개(resume)"], ["cancel", "취소(cancel)"]]);
const ACTION_LABEL = Object.freeze({ draft: "초안 만들기", ...Object.fromEntries(STEPS) });
const LIFECYCLE_TEXT = Object.freeze({ draft: "초안", proposed: "제안됨", agreed: "합의됨", servicing: "서비스 중", occupied: "입주 사실 기록됨", delayed: "지연", cancelled: "취소됨" });
const PARTY_MODES = Object.freeze([["", "적지 않음(미상)"], ["named", "이름 명시"], ["absent", "없음 명시"]]);
const KEEP_MODES = Object.freeze([["", "기록대로 둠"], ["named", "이름 명시"], ["absent", "없음 명시"]]);
const CONDITION_MODES = Object.freeze([["unstated", "적지 않음(미상)"], ["declared-none", "없음으로 선언"], ["stated", "조건을 적음"]]);
const ROLES = Object.freeze([["player", "플레이어"], ["municipality", "지자체"], ["developer", "개발자"]]);

// --- the player's unsent input: strings and booleans, exactly as typed ---
const blankParty = () => ({ mode: "", name: "", partyId: "" });
const blankBurden = () => ({ itemId: "", player: false, municipality: false, developer: false, amount: "", note: "" });
const blankCondition = () => ({ conditionId: "", text: "", linkedStationSiteId: "", linkedServicePlanId: "" });
const blankForm = () => ({
  name: "", municipality: blankParty(), developer: blankParty(),
  agree: { municipality: blankParty(), developer: blankParty(), burdens: [blankBurden()], conditionsMode: "unstated", conditions: [blankCondition()] },
  servicingPhaseIds: [], occupancy: { phaseId: "", occupied: "", planned: "", unit: "", source: "", note: "" }, delayReason: "", cancelReason: "",
});
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const bad = (path) => new Error(`Not a new-town management panel document: ${path}`);
function fit(template, raw, path) {
  if (raw === undefined) return structuredClone(template);
  if (Array.isArray(template)) {
    if (!Array.isArray(raw)) throw bad(path);
    return raw.map((item, i) => fit(template.length ? template[0] : "", item, `${path}[${i}]`));
  }
  if (isObject(template)) {
    if (!isObject(raw)) throw bad(path);
    for (const key of Object.keys(raw)) if (!(key in template)) throw bad(`${path}.${key}`);
    return Object.fromEntries(Object.keys(template).map((key) => [key, fit(template[key], raw[key], `${path}.${key}`)]));
  }
  if (typeof raw !== typeof template) throw bad(path);
  return raw;
}
function normalizeForm(raw, path) {
  const form = fit(blankForm(), raw, path);
  for (const [where, party] of [["municipality", form.municipality], ["developer", form.developer], ["agree.municipality", form.agree.municipality], ["agree.developer", form.agree.developer]]) {
    if (!PARTY_MODES.some(([mode]) => mode === party.mode)) throw bad(`${path}.${where}.mode`);
  }
  if (!CONDITION_MODES.some(([mode]) => mode === form.agree.conditionsMode)) throw bad(`${path}.agree.conditionsMode`);
  return form;
}

// --- what is sent: blank is "not stated" (null / omitted), never a made-up value; "0" stays 0 ---
const filled = (s) => s.trim() !== "";
const numberOrNull = (s) => (filled(s) ? Number(s) : null);
const partyInput = (p) => (p.mode === "absent" ? { absent: true } : p.mode === "named" ? { ...(filled(p.partyId) ? { partyId: p.partyId } : {}), ...(filled(p.name) ? { name: p.name } : {}) } : undefined);
const partiesInput = (municipality, developer) => {
  const parties = { municipality: partyInput(municipality), developer: partyInput(developer) };
  for (const role of Object.keys(parties)) if (parties[role] === undefined) delete parties[role];
  return Object.keys(parties).length ? parties : undefined;
};
function agreementInput(form) {
  const agree = form.agree;
  const out = {
    burdens: agree.burdens.map((b) => ({ itemId: b.itemId, bearers: ROLES.map(([role]) => role).filter((role) => b[role]), statedAmountJPY: numberOrNull(b.amount), ...(filled(b.note) ? { note: b.note } : {}) })),
  };
  if (agree.conditionsMode === "declared-none") out.connectionConditions = [];
  else if (agree.conditionsMode === "stated") out.connectionConditions = agree.conditions.map((c) => ({ conditionId: c.conditionId, text: c.text, ...(filled(c.linkedStationSiteId) ? { linkedStationSiteId: c.linkedStationSiteId } : {}), ...(filled(c.linkedServicePlanId) ? { linkedServicePlanId: c.linkedServicePlanId } : {}) }));
  const parties = partiesInput(agree.municipality, agree.developer);
  if (parties) out.parties = parties;
  return out;
}
const occupancyInput = (o) => ({ statedOccupiedUnits: numberOrNull(o.occupied), statedPlannedUnits: numberOrNull(o.planned), unit: filled(o.unit) ? o.unit : null, source: o.source, ...(filled(o.note) ? { note: o.note } : {}) });

// --- how stated values are written ---
const stated = (v) => (v === null || v === undefined ? "null(적지 않음)" : String(v));
const partyText = (p) => (p.absent ? "없음(명시)" : p.name === null && p.partyId === null ? "미상" : `${p.name ?? "-"} (${p.partyId ?? "-"})`);
const hasText = (s) => typeof s === "string";

export function mountNewTownDevelopmentManagementPanel({ container, runtime, getGeometryExport, onChange = () => {} } = {}) {
  if (!container) throw new Error("A management container is required");
  for (const name of REQUIRED) if (typeof runtime?.[name] !== "function") throw new Error(`runtime.${name}() is required`);
  if (typeof getGeometryExport !== "function") throw new Error("getGeometryExport() returning the B19-M2 development export is required");
  const doc = container.ownerDocument ?? document;
  if (doc.head && doc.getElementById && !doc.getElementById(STYLE_ID)) doc.head.append(Object.assign(doc.createElement("style"), { id: STYLE_ID, textContent: CSS }));

  let selectedRowKey = null;
  let forms = {};
  let notice = null;
  let view = null;
  let destroyed = false;

  const el = (tag, props = {}, ...kids) => { const node = doc.createElement(tag); Object.assign(node, props); node.append(...kids); return node; };
  const txt = (tag, className, value) => el(tag, { className, textContent: value });
  const button = (label, fn, disabled = false) => { const b = el("button", { type: "button", textContent: label, disabled }); b.addEventListener("click", fn); return b; };
  const field = (label, control) => el("label", { className: "nt-field" }, txt("span", "nt-lab", label), control);
  const input = (cls, value, set) => { const n = el("input", { type: "text", className: `nt-in ${cls}`, value }); n.addEventListener("input", () => set(n.value)); return n; };
  const select = (cls, options, value, set) => { const n = el("select", { className: `nt-in ${cls}` }, ...options.map(([v, label]) => el("option", { value: v, textContent: label }))); n.value = value; n.addEventListener("change", () => set(n.value)); return n; };
  const check = (cls, checked, set) => { const n = el("input", { type: "checkbox", className: `nt-in ${cls}`, checked }); n.addEventListener("change", () => set(n.checked)); return n; };
  const formOf = (rowKey) => (forms[rowKey] ??= blankForm());

  function readExport() {
    try { return readGeometryExport(getGeometryExport()); } catch (error) { return { exportData: null, problem: `geometry-export-threw: ${error?.message ?? error}` }; }
  }
  // read-only runtime calls only
  function collect() {
    const { exportData, problem } = readExport();
    const records = runtime.newTownDevelopmentReport();
    const assessments = {}; const hooks = {};
    for (const row of planManagementRows(exportData, records)) {
      assessments[row.rowKey] = runtime.assessNewTownDevelopment(row.record ? { id: row.record.id, geometry: row.geometry } : { geometry: row.geometry });
      if (row.record) hooks[row.record.id] = runtime.newTownDevelopmentHooks(row.record.id);
    }
    return { exportData, problem, records, assessments, hooks };
  }

  // --- the one place a command leaves the panel: a click, after the runtime was asked again about this very step ---
  function act(kind, rowKey) {
    if (destroyed) return;
    const row = view.rows.find((r) => r.rowKey === rowKey);
    if (!row) return;
    const geometry = geometryOf(readExport().exportData, row.developmentId);
    const assess = runtime.assessNewTownDevelopment(row.recordId === null ? { geometry } : { id: row.recordId, geometry });
    const gate = kind === "draft" ? assess.create?.draft : assess.transitions[kind];
    if (!gate || !gate.allowed) { notice = { type: "blocked", kind, blockers: gate ? [...gate.blockers] : [`${kind}-not-available`] }; render(); return; }
    const form = formOf(rowKey);
    const id = row.recordId;
    let record;
    try {
      if (kind === "draft") record = runtime.draftNewTownDevelopment({ geometry, ...(filled(form.name) ? { name: form.name } : {}), ...(partiesInput(form.municipality, form.developer) ? { parties: partiesInput(form.municipality, form.developer) } : {}) });
      else if (kind === "propose") record = runtime.proposeNewTownDevelopment({ id, geometry });
      else if (kind === "agree") record = runtime.agreeNewTownDevelopment(id, agreementInput(form), { geometry });
      else if (kind === "startServicing") record = runtime.startNewTownServicing(id, { geometry, ...(form.servicingPhaseIds.length ? { phaseIds: [...form.servicingPhaseIds] } : {}) });
      else if (kind === "recordOccupancy") record = runtime.recordNewTownOccupancy(id, form.occupancy.phaseId, occupancyInput(form.occupancy), { geometry });
      else if (kind === "delay") record = runtime.delayNewTownDevelopment(id, form.delayReason);
      else if (kind === "resume") record = runtime.resumeNewTownDevelopment(id, { geometry });
      else record = runtime.cancelNewTownDevelopment(id, form.cancelReason);
    } catch (error) {
      notice = { type: "error", kind, message: String(error?.message ?? error) };
      render();
      return;
    }
    if (kind === "draft") { delete forms[rowKey]; selectedRowKey = `record:${record.id}`; }
    notice = { type: "done", kind, recordId: record.id, status: record.status };
    render();
    onChange({ kind: "command", action: kind, recordId: record.id, developmentId: record.developmentId, status: record.status });
  }

  // --- drawing ---
  function mapBlock(row) {
    const g = row.assessment.geometry;
    const pack = row.record?.sourcePack ?? null;
    return [
      txt("h4", "", "지도 대조"),
      txt("div", "nt-fact nt-map-state", `${MAP_STATE_TEXT[row.mapState]} · 개발 ${row.developmentId}`),
      txt("div", "nt-fact nt-e1-geometry", `런타임 대조(E1): ${g.status}${g.reasons.length ? ` — ${g.reasons.join(", ")}` : ""}`),
      txt("div", "nt-fact", `기록된 지도 revision: ${stated(row.recordedRevision)} · 현재 지도 revision: ${row.mapRevision ?? "없음"}`),
      ...(row.record ? [txt("div", "nt-fact", `기록된 팩: ${pack ? `${pack.packId}@${stated(pack.packVersion)}` : "null(적지 않음)"}`)] : []),
      txt("div", "nt-fact", row.mapPhases ? `지도 단계 ${row.mapPhases.length}개: ${row.mapPhases.map((p) => `${p.phaseId}(${p.sequence}${p.playerDeclaredLandUse ? ` · ${p.playerDeclaredLandUse}` : ""})`).join(", ")}` : "지도 단계: 현재 지도에 없음"),
    ];
  }
  function recordBlock(row) {
    const r = row.record;
    if (!r) return [];
    const out = [txt("h4", "", "생애주기 기록"), txt("div", "nt-fact", `${r.id} · 상태 ${r.status}${r.name ? ` · ${r.name}` : ""}`),
      txt("div", "nt-fact", `지자체: ${partyText(r.parties.municipality)} · 개발자: ${partyText(r.parties.developer)}`)];
    if (r.phases === null) out.push(txt("div", "nt-fact", "단계: null(지도와 연결되기 전의 초안)"));
    for (const p of r.phases ?? []) {
      out.push(txt("div", "nt-fact nt-phase", `${p.sequence}. ${p.phaseId} · 상태 ${p.status} · 용도 선언 ${stated(p.playerDeclaredLandUse)} · 적어 둔 공급 ${p.statedSupply ? `${p.statedSupply.quantity} ${p.statedSupply.unit}` : "null(적지 않음)"}`));
      for (const f of p.occupancyFacts) out.push(txt("div", "nt-fact nt-occupancy-fact", `입주 사실 #${f.sequence}: statedOccupiedUnits ${stated(f.statedOccupiedUnits)} · statedPlannedUnits ${stated(f.statedPlannedUnits)} · unit ${stated(f.unit)} · source ${stated(f.source)}${f.note ? ` · ${f.note}` : ""}`));
    }
    if (r.agreement) {
      for (const b of r.agreement.burdens) out.push(txt("div", "nt-fact nt-burden", `부담 항목 ${b.itemId}: ${b.bearers.join("/")} · 금액 ${b.statedAmountJPY === null ? "null(적지 않음)" : `${b.statedAmountJPY} JPY`}${b.note ? ` · ${b.note}` : ""}`));
      const c = r.agreement.connectionConditions;
      out.push(txt("div", "nt-fact nt-conditions", c === null ? "연결 조건: null(적지 않음)" : c.length === 0 ? "연결 조건: [] (없음으로 선언)" : `연결 조건: ${c.map((x) => `${x.conditionId} ${x.text}`).join(" / ")}`));
    }
    if (r.delay) out.push(txt("div", "nt-fact", `지연 사유: ${r.delay.reason}${r.delay.resumedAtMinute === null ? "" : " (재개됨)"}`));
    if (r.cancellation) out.push(txt("div", "nt-fact", `취소 사유: ${r.cancellation.reason}`));
    out.push(txt("div", "nt-fact", `이력: ${r.history.map((h) => `${h.kind} ${h.from ?? "-"}→${h.to}`).join(", ")}`));
    return out;
  }

  function partyFields(party, label, modes, cls) {
    return el("div", { className: "nt-fieldrow" }, field(label, select(`${cls}-mode`, modes, party.mode, (v) => { party.mode = v; })), field("이름", input(`${cls}-name`, party.name, (v) => { party.name = v; })), field("partyId", input(`${cls}-id`, party.partyId, (v) => { party.partyId = v; })));
  }
  function draftForm(form) {
    return el("div", { className: "nt-form nt-form-draft" }, field("이름", input("nt-f-name", form.name, (v) => { form.name = v; })), partyFields(form.municipality, "지자체", PARTY_MODES, "nt-f-muni"), partyFields(form.developer, "개발자", PARTY_MODES, "nt-f-dev"));
  }
  function agreeForm(form) {
    const a = form.agree;
    const node = el("div", { className: "nt-form nt-form-agree" }, partyFields(a.municipality, "지자체", KEEP_MODES, "nt-f-amuni"), partyFields(a.developer, "개발자", KEEP_MODES, "nt-f-adev"));
    a.burdens.forEach((b, i) => {
      node.append(el("div", { className: "nt-fieldrow nt-burden-row" }, field("항목 ID", input("nt-f-item", b.itemId, (v) => { b.itemId = v; })),
        ...ROLES.map(([role, label]) => field(label, check(`nt-f-bear-${role}`, b[role], (v) => { b[role] = v; }))),
        field("금액(JPY)", input("nt-f-amount", b.amount, (v) => { b.amount = v; })), field("메모", input("nt-f-bnote", b.note, (v) => { b.note = v; })),
        button("항목 삭제", () => { a.burdens.splice(i, 1); render(); })));
    });
    node.append(button("부담 항목 추가", () => { a.burdens.push(blankBurden()); render(); }));
    node.append(el("div", { className: "nt-fieldrow" }, field("연결 조건", select("nt-f-cmode", CONDITION_MODES, a.conditionsMode, (v) => { a.conditionsMode = v; render(); }))));
    if (a.conditionsMode === "stated") {
      a.conditions.forEach((c, i) => {
        node.append(el("div", { className: "nt-fieldrow nt-condition-row" }, field("조건 ID", input("nt-f-cid", c.conditionId, (v) => { c.conditionId = v; })), field("내용", input("nt-f-ctext", c.text, (v) => { c.text = v; })),
          field("역 부지 ID", input("nt-f-csite", c.linkedStationSiteId, (v) => { c.linkedStationSiteId = v; })), field("서비스 계획 ID", input("nt-f-cplan", c.linkedServicePlanId, (v) => { c.linkedServicePlanId = v; })),
          button("조건 삭제", () => { a.conditions.splice(i, 1); render(); })));
      });
      node.append(button("조건 추가", () => { a.conditions.push(blankCondition()); render(); }));
    }
    return node;
  }
  function servicingForm(form, row) {
    const planned = (row.record.phases ?? []).filter((p) => p.status === "planned");
    return el("div", { className: "nt-form nt-form-servicing" }, txt("div", "nt-note", "단계를 고르지 않으면 런타임 규칙에 따릅니다."),
      ...planned.map((p) => field(`단계 ${p.phaseId}`, check("nt-f-phase", form.servicingPhaseIds.includes(p.phaseId), (v) => { form.servicingPhaseIds = v ? [...form.servicingPhaseIds, p.phaseId] : form.servicingPhaseIds.filter((x) => x !== p.phaseId); }))));
  }
  function occupancyForm(form, row) {
    const o = form.occupancy;
    return el("div", { className: "nt-form nt-form-occupancy" },
      field("단계", select("nt-f-ophase", [["", "단계 고르기"], ...(row.record.phases ?? []).map((p) => [p.phaseId, `${p.phaseId} (${p.status})`])], o.phaseId, (v) => { o.phaseId = v; })),
      field("statedOccupiedUnits", input("nt-f-occupied", o.occupied, (v) => { o.occupied = v; })), field("statedPlannedUnits", input("nt-f-planned", o.planned, (v) => { o.planned = v; })),
      field("unit", input("nt-f-unit", o.unit, (v) => { o.unit = v; })), field("source", input("nt-f-source", o.source, (v) => { o.source = v; })), field("메모", input("nt-f-onote", o.note, (v) => { o.note = v; })),
      txt("div", "nt-note", "빈 칸은 null(적지 않음), 0은 0입니다. 후보 읽기(E2)는 unit이 residents 또는 jobs로 적힌 값만 읽습니다."));
  }
  const reasonForm = (cls, value, set) => el("div", { className: "nt-form" }, field("사유", input(cls, value, set)));

  function stepsBlock(row) {
    const node = [txt("h4", "", "단계 전환 (막힘 사유는 런타임이 돌려준 그대로)")];
    const form = formOf(row.rowKey);
    const line = (kind, gate) => {
      node.push(el("div", { className: `nt-step nt-step-${kind}` }, button(ACTION_LABEL[kind], () => act(kind, row.rowKey), !gate.allowed),
        ...(gate.allowed ? [txt("span", "nt-open", "막힘 없음")] : gate.blockers.map((b) => txt("span", "nt-blocker", b)))));
    };
    if (row.recordId === null) {
      const gate = row.assessment.create.draft;
      line("draft", gate);
      if (gate.allowed) node.push(draftForm(form));
      return node;
    }
    for (const [kind] of STEPS) {
      const gate = row.assessment.transitions[kind];
      line(kind, gate);
      if (!gate.allowed) continue;
      if (kind === "agree") node.push(agreeForm(form));
      else if (kind === "startServicing") node.push(servicingForm(form, row));
      else if (kind === "recordOccupancy") node.push(occupancyForm(form, row));
      else if (kind === "delay") node.push(reasonForm("nt-f-delay", form.delayReason, (v) => { form.delayReason = v; }));
      else if (kind === "cancel") node.push(reasonForm("nt-f-cancel", form.cancelReason, (v) => { form.cancelReason = v; }));
    }
    return node;
  }
  function candidatesBlock(row) {
    const c = row.candidates;
    if (!c) return [];
    const out = [txt("h4", "", "후보 읽기 (E2 · 읽기 전용, 어디에도 적용하지 않음)")];
    if (c.error) return [...out, txt("div", "nt-error", `E2 오류(원문): ${c.error}`)];
    out.push(txt("div", "nt-fact nt-e2-geometry", `후보 대조(E2): ${c.geometryStatus.status}${c.geometryStatus.reasons.length ? ` — ${c.geometryStatus.reasons.join(", ")}` : ""}`));
    for (const x of c.candidates) out.push(txt("div", "nt-fact nt-candidate", `${x.phaseId} · ${x.status} · eligibleForB15=${x.eligibleForB15 === null ? "null(미상)" : x.eligibleForB15}`));
    if (!c.candidates.length) out.push(txt("div", "nt-fact", "후보 없음: 입주 사실이 적힌 단계가 없습니다."));
    if (c.phasesWithoutCandidate.length) out.push(txt("div", "nt-fact", `후보 없는 단계: ${c.phasesWithoutCandidate.join(", ")}`));
    if (c.notComputed.length) out.push(txt("div", "nt-note", `계산하지 않음: ${c.notComputed.join(", ")}`));
    return out;
  }
  function noticeNode() {
    if (!notice) return [];
    if (notice.type === "blocked") return [el("div", { className: "nt-notice-blocked" }, txt("span", "", `막힘 — ${ACTION_LABEL[notice.kind]}: 명령을 보내지 않았습니다. `), ...notice.blockers.map((b) => txt("span", "nt-blocker", b)))];
    if (notice.type === "error") return [txt("div", "nt-error nt-notice-error", `런타임 오류(원문): ${notice.message}`)];
    return [txt("div", "nt-fact nt-notice-done", `${ACTION_LABEL[notice.kind]} 완료 — ${notice.recordId} · ${notice.status}`)];
  }

  function render() {
    if (destroyed) return;
    const data = collect();
    view = buildNewTownManagementView({ ...data, selectedRowKey });
    const mapLine = view.mapProblem ? `지도 geometry 없음: ${view.mapProblem}` : `지도 ${view.packId}${view.packVersion ? ` v${view.packVersion}` : ""} · 개발 ${view.counts.mapDevelopments}건 · 생애주기 기록 ${view.counts.records}건`;
    const children = [txt("p", "nt-scope", SCOPE_NOTICE), txt("div", "nt-map", mapLine), el("div", { className: "nt-toolbar" }, button("지도 다시 읽기", () => { notice = null; render(); })), ...noticeNode()];
    if (!view.rows.length) children.push(txt("p", "nt-empty", "표시할 개발이 없습니다."));
    for (const row of view.rows) {
      const life = row.lifecycleStatus === null ? "기록 없음" : `${LIFECYCLE_TEXT[row.lifecycleStatus] ?? row.lifecycleStatus}(${row.lifecycleStatus})`;
      children.push(el("div", { className: `nt-row nt-map-${row.mapState}${row.selected ? " picked" : ""}` },
        txt("span", "", `${row.name ?? row.developmentId} · ${life} · ${MAP_STATE_TEXT[row.mapState]}`),
        button(row.selected ? "접기" : "자세히", () => { notice = null; selectedRowKey = row.selected ? null : row.rowKey; render(); onChange({ kind: "ui", selectedRowKey }); })));
      if (row.selected) children.push(el("div", { className: "nt-card" }, ...mapBlock(row), ...recordBlock(row), ...stepsBlock(row), ...candidatesBlock(row)));
    }
    container.replaceChildren(el("div", { className: "nt-mgmt" }, ...children));
  }
  render();

  return {
    output: () => ({ view: structuredClone(view), selectedRowKey }),
    view: () => structuredClone(view),
    refresh() { render(); },
    select(rowKey) { if (!view.rows.some((r) => r.rowKey === rowKey)) return false; notice = null; selectedRowKey = rowKey; render(); onChange({ kind: "ui", selectedRowKey }); return true; },
    deselect() { notice = null; selectedRowKey = null; render(); onChange({ kind: "ui", selectedRowKey }); },
    get selectedRowKey() { return selectedRowKey; },
    // the selection and the forms being typed in; the runtime's own save carries the lifecycle records
    serialize: () => ({ schema: MANAGEMENT_PANEL_SCHEMA, contractVersion: 1, packId: view.packId, selectedRowKey, forms: structuredClone(forms) }),
    loadDoc(docIn) {
      if (!isObject(docIn) || docIn.schema !== MANAGEMENT_PANEL_SCHEMA || docIn.contractVersion !== 1) throw bad("schema");
      if (docIn.packId !== null && !hasText(docIn.packId)) throw bad("packId");
      if (docIn.packId !== null && view.packId !== null && docIn.packId !== view.packId) throw new Error(`The saved panel belongs to pack ${docIn.packId}, not ${view.packId}`);
      if (docIn.selectedRowKey !== null && !hasText(docIn.selectedRowKey)) throw bad("selectedRowKey");
      if (!isObject(docIn.forms)) throw bad("forms");
      const next = Object.fromEntries(Object.keys(docIn.forms).map((key) => [key, normalizeForm(docIn.forms[key], `forms.${key}`)]));
      forms = next; selectedRowKey = docIn.selectedRowKey; notice = null;
      render();
      onChange({ kind: "ui", selectedRowKey });
    },
    destroy() { destroyed = true; container.replaceChildren(); },
  };
}
