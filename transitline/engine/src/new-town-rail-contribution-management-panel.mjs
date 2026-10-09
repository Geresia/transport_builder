// Management panel for new-town rail contributions (B19-M4, on the B19-E3 engine).  It lists the contributions the engine keeps, shows each one's
// stated facts exactly as stored, shows the engine's own read-only answers (assessNewTownRailContribution: what blocks each step, and what a
// release would do to the ledger; newTownRailContributionHooks: stable ids), and lets the player drive the lifecycle with buttons:
// draft / propose / agree / fund / release / delay / resume / terminate.  Every engine command is called from a button click and nowhere else:
// mounting, refresh(), loadDoc() and changing a field call no command.
//
// The panel computes nothing about money.  An amount is a whole number the player typed (digits only); it is never taken or checked against
// area, land use, population, demand or occupancy, and nothing is added, split or defaulted.  Cash and the ledger are the engine's: the panel
// never writes them and only repeats the engine's `releaseEffect`.  A step the engine refuses (stale / other-pack / inactive / missing geometry,
// a cancelled or unknown-revision development, an unconfirmed condition, a link that is not current ...) stays refused: the engine's blockers are
// shown as they are and the panel never retries or works around them.
//
// null / 0 / [] are different statements and read differently on screen:  null = "not stated",  0 = "stated 0",  [] = "stated none".
// Nothing is persisted here (no localStorage / sessionStorage).  serialize() / loadDoc() carry only the selected contribution and the draft form.
export const PANEL_DOC_SCHEMA = "transitline.new-town-rail-contribution-panel-doc/1";

export const SCOPE_NOTICE = "이 패널은 신도시 개발과 철도 사업 사이의 분담금 협약(누가·어떤 조건에서·얼마를 부담하기로 했는가)을 기록하고 엔진의 판정을 그대로 보여 줍니다. 금액·부담자·수령자·조건·연결 대상은 모두 직접 입력한 값만 쓰며, 신도시의 면적·용도·인구·수요·입주 사실에서 금액을 계산하거나 추정하지 않습니다. 토지 가격·사업성·보조금 산정은 하지 않습니다.";
export const RELEASE_NOTICE = "release는 지급이 확정된 분담금을 플레이어의 원장(현금)에 한 번 반영할 수 있는 유일한 단계입니다. 합의(agree)와 지급 확정(fund)은 현금을 만들지 않습니다. 반영 여부와 금액은 엔진이 정하며(아래 '엔진 판정'), 이 화면은 금액·현금·원장을 계산하거나 직접 고치지 않습니다. release는 되돌릴 수 없고 두 번 반영되지 않습니다.";
export const TERMINAL_NOTICE = "종결 상태입니다. 더 이상 어떤 단계도 실행할 수 없습니다.";

export const STATUS_LABEL = Object.freeze({
  draft: "초안", proposed: "제안됨", agreed: "합의됨", funded: "지급 확정됨(현금 아님)", released: "release 완료 — 종결", delayed: "지연", terminated: "종료 — 종결",
});
const TERMINAL = new Set(["released", "terminated"]);
const PAYER_LABEL = Object.freeze({ municipality: "지자체", developer: "시행사", player: "플레이어", other: "기타" });
const PAYEE_LABEL = Object.freeze({ "player-railway": "플레이어 철도", project: "철도 프로젝트", other: "기타" });
const PURPOSE_LABEL = Object.freeze({ station: "역", "rail-extension": "노선 연장", access: "접근", depot: "차량기지", other: "기타" });
const STEP_LABEL = Object.freeze({ propose: "제안(propose)", agree: "합의(agree)", fund: "지급 확정 기록(fund)", release: "release", delay: "지연(delay)", resume: "재개(resume)", terminate: "종료(terminate)" });
const STEPS = Object.freeze(["propose", "agree", "fund", "release", "delay", "resume", "terminate"]);

// short Korean glosses for the engine's blocker codes; the code itself is always printed next to it
const BLOCKER_TEXT = Object.freeze({
  "status-not-allowed": "이 상태에서는 할 수 없음", "geometry-missing": "지도 geometry가 없음", "geometry-not-provided": "지도 geometry를 받지 못함", "geometry-stale": "지도 geometry가 낡음(stale)",
  "geometry-invalid": "지도 geometry를 쓸 수 없음", "geometry-inactive": "지도에서 꺼진(비활성) 개발", "geometry-revision-changed": "지도 revision이 바뀜",
  "geometry-source-pack-changed": "다른 팩의 geometry", "geometry-source-pack-version-changed": "팩 버전이 다른 geometry", "geometry-other-development": "다른 개발의 geometry",
  "geometry-source-pack-unknown": "geometry에 팩 정보가 없음", "geometry-active-unknown": "geometry의 활성 여부를 알 수 없음", "geometry-phases-changed": "지도의 단계 구성이 바뀜",
  "record-source-pack-unknown": "개발 기록에 팩 정보가 없음(구저장본)", "development-cancelled": "개발이 취소됨", "development-revision-unknown": "개발 revision을 알 수 없음", "source-pack-unknown": "팩 정보를 알 수 없음",
  "development-record-missing": "개발 기록이 없음", "development-record-mismatch": "개발 기록이 계약과 다름", "development-revision-mismatch": "개발 revision이 계약 작성 때와 다름", "source-pack-mismatch": "팩이 계약 작성 때와 다름",
  "amount-not-stated": "분담 금액이 명시되지 않음", "conditions-not-stated": "조건이 명시되지 않음(없으면 '없음'으로 명시)", "payee-project-needs-a-linked-project": "수령자가 프로젝트이면 연결 프로젝트가 필요함",
  "confirmation-not-provided": "지급 확정 정보를 입력하지 않음", "confirmation-invalid": "지급 확정 정보가 올바르지 않음", "confirmed-amount-differs-from-stated": "확정 금액이 합의 금액과 다름",
  "condition-not-confirmed": "확인하지 않은 조건", "condition-unknown": "계약에 없는 조건", "condition-confirmation-repeated": "같은 조건을 두 번 확인함",
  "linked-projects-not-verifiable": "연결 프로젝트가 있는지 확인할 수 없음", "linked-project-missing": "연결 프로젝트가 없음", "linked-project-cancelled": "연결 프로젝트가 취소됨",
  "linked-plans-not-verifiable": "연결 계획이 현재인지 확인할 수 없음", "linked-plan-not-current": "연결 계획이 현재 지도에 없음",
  "linked-station-sites-not-verifiable": "연결 역 부지가 현재인지 확인할 수 없음", "linked-station-site-not-current": "연결 역 부지가 현재 지도에 없음",
  "linked-phases-unverifiable": "연결 단계를 개발에서 확인할 수 없음", "phase-unknown": "개발에 없는 단계", "phase-cancelled": "취소된 단계",
});
export function blockerText(code) {
  const base = String(code).split(":")[0];
  const gloss = BLOCKER_TEXT[base] ?? BLOCKER_TEXT[String(code)] ?? null;
  return gloss ? `${gloss} (${code})` : String(code);
}

const listOf = (v) => (Array.isArray(v) ? v : []);
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isText = (v) => typeof v === "string" && v.trim() !== "";
const clone = (v) => structuredClone(v);
const message = (e) => (e instanceof Error ? e.message : String(e));
const grouped = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

// --- how a stated value reads: null / 0 / [] are three different statements ---------------------------------------------------------
export const amountText = (v) => (v === null || v === undefined ? "미명시(null) — 금액을 말하지 않음" : v === 0 ? "0엔 — 0으로 명시함" : `${grouped(v)}엔`);
export const idListText = (v, whenNull = "미명시(null)", whenEmpty = "없음으로 명시함([])") => (v === null || v === undefined ? whenNull : v.length === 0 ? whenEmpty : v.join(", "));
export const phaseText = (v) => idListText(v, "미지정(null) — 개발 전체", "연결 단계 없음으로 명시함([])");
export const conditionsText = (v) => (v === null || v === undefined ? "조건 미명시(null)" : v.length === 0 ? "조건 없음으로 명시함([])" : v.map((c) => `${c.conditionId}: ${c.text}`).join(" / "));
const valueText = (v) => (v === null || v === undefined ? "미상(null)" : String(v));

// --- reading what the player typed: only what was typed, never completed ---------------------------------------------------------------
// a blank field is "not stated": null for a stated field, or undefined (send nothing) when the field is optional
function parseAmount(raw, { optional = false } = {}) {
  const s = String(raw ?? "").trim();
  if (s === "") return optional ? undefined : null;
  if (!/^\d+$/.test(s)) throw new Error("금액은 0 이상의 정수(엔)만 입력할 수 있습니다 — 숫자만, 쉼표·소수점·계산식 없이");
  const n = Number(s);
  if (!Number.isSafeInteger(n)) throw new Error("금액이 너무 큽니다");
  return n;
}
function parseIds(mode, raw, label) {
  if (mode === "none") return [];
  if (mode !== "list") return null;
  const ids = String(raw ?? "").split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  if (!ids.length) throw new Error(`${label}: '목록 입력'을 골랐는데 비어 있습니다 — 없으면 '없음으로 명시'를 고르세요`);
  return ids;
}
function parseConditions(mode, raw) {
  if (mode === "none") return [];
  if (mode !== "list") return null;
  const lines = String(raw ?? "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (!lines.length) throw new Error("조건: '목록 입력'을 골랐는데 비어 있습니다 — 없으면 '없음으로 명시'를 고르세요");
  return lines.map((line) => {
    const at = line.indexOf(":");
    const conditionId = at < 0 ? "" : line.slice(0, at).trim();
    const text = at < 0 ? "" : line.slice(at + 1).trim();
    if (!conditionId || !text) throw new Error(`조건은 한 줄에 '조건ID: 내용' 형식으로 적습니다 — "${line}"`);
    return { conditionId, text };
  });
}
const required = (value, label) => { if (!isText(value)) throw new Error(`${label}을(를) 선택(입력)하세요 — 기본값이 없습니다`); return value.trim(); };

// --- the saved document: the selection and the draft form only ------------------------------------------------------------------------
const DRAFT_FIELDS = Object.freeze(["developmentRecordId", "payerKind", "payeeKind", "statedPurpose", "amount", "name", "phaseMode", "phaseText", "projectMode", "projectText", "planMode", "planText", "siteMode", "siteText", "conditionMode", "conditionText"]);
const MODE_FIELDS = Object.freeze(["phaseMode", "projectMode", "planMode", "siteMode", "conditionMode"]);
const blankDraft = () => Object.fromEntries(DRAFT_FIELDS.map((k) => [k, MODE_FIELDS.includes(k) ? "unstated" : ""]));

export function newPanelDoc() { return { schema: PANEL_DOC_SCHEMA, version: 1, selectedContributionId: null, draft: blankDraft() }; }
// -> { doc | null, issues }; any issue refuses the whole document
export function restorePanelDoc(input) {
  let raw = input;
  if (typeof input === "string") { try { raw = JSON.parse(input); } catch { return { doc: null, issues: ["panel-doc-unreadable"] }; } }
  if (!isObject(raw) || raw.schema !== PANEL_DOC_SCHEMA || raw.version !== 1) return { doc: null, issues: ["panel-doc-schema-invalid"] };
  const issues = [];
  if (raw.selectedContributionId !== null && raw.selectedContributionId !== undefined && !isText(raw.selectedContributionId)) issues.push("selected-contribution-invalid");
  const draft = blankDraft();
  if (raw.draft !== undefined && raw.draft !== null) {
    if (!isObject(raw.draft)) issues.push("draft-invalid");
    else for (const [key, value] of Object.entries(raw.draft)) {
      if (!DRAFT_FIELDS.includes(key)) issues.push(`draft-field-unknown:${key}`);
      else if (typeof value !== "string") issues.push(`draft-field-invalid:${key}`);
      else if (MODE_FIELDS.includes(key) && !["unstated", "none", "list"].includes(value)) issues.push(`draft-field-invalid:${key}`);
      else draft[key] = value;
    }
  }
  if (issues.length) return { doc: null, issues };
  return { doc: { schema: PANEL_DOC_SCHEMA, version: 1, selectedContributionId: raw.selectedContributionId ?? null, draft }, issues: [] };
}
export function serializePanelDoc(doc) {
  const { doc: restored, issues } = restorePanelDoc(doc);
  if (!restored) throw new Error(`Panel document is invalid: ${issues.join(", ")}`);
  return JSON.stringify(restored, null, 2);
}

// --- linking the contribution, the development record and the map's geometry (display only; the engine decides) ---------------------
function sameOrUnknown(a, b) { return a === null || a === undefined || b === null || b === undefined ? "unknown" : a === b ? "same" : "different"; }
const SAME_LABEL = Object.freeze({ same: "일치", different: "다름", unknown: "미상" });
export function linkFacts(contribution, geometryExport, developments) {
  const candidates = isObject(geometryExport) && Array.isArray(geometryExport.developments) ? geometryExport.developments.filter((d) => isObject(d) && d.developmentId === contribution.developmentId) : null;
  const geometry = candidates && candidates.length === 1 ? candidates[0] : null;
  const record = listOf(developments).find((d) => isObject(d) && d.id === contribution.developmentRecordId) ?? null;
  const pack = contribution.sourcePack ?? null;
  return {
    geometry: { exportReadable: candidates !== null, found: geometry !== null, ambiguous: Boolean(candidates && candidates.length > 1),
      developmentRevision: geometry ? sameOrUnknown(contribution.developmentRevision, geometry.developmentRevision) : "unknown",
      sourcePackId: geometry ? sameOrUnknown(pack?.packId, geometry.sourcePackId) : "unknown",
      sourcePackVersion: geometry ? sameOrUnknown(pack?.packVersion, geometry.sourcePackVersion) : "unknown",
      active: geometry ? (geometry.active === true ? true : geometry.active === false ? false : null) : null },
    record: { found: record !== null, status: record?.status ?? null,
      developmentId: record ? sameOrUnknown(contribution.developmentId, record.developmentId) : "unknown",
      developmentRevision: record ? sameOrUnknown(contribution.developmentRevision, record.developmentRevision) : "unknown",
      sourcePackId: record ? sameOrUnknown(pack?.packId, record.sourcePack?.packId) : "unknown",
      sourcePackVersion: record ? sameOrUnknown(pack?.packVersion, record.sourcePack?.packVersion) : "unknown" },
    geometryObject: geometry,
  };
}

const el = (doc, tag, props = {}, ...kids) => { const node = doc.createElement(tag); Object.assign(node, props); node.append(...kids); if ("value" in props) node.value = props.value; return node; };
const text = (doc, tag, className, value) => el(doc, tag, { className, textContent: value });

export function mountNewTownRailContributionManagementPanel({ container, runtime, getGeometryExport, getNewTownDevelopments, getCurrentLinks, onChange = () => {} } = {}) {
  if (!container) throw new Error("A new town rail contribution panel container is required");
  if (typeof getGeometryExport !== "function") throw new Error("getGeometryExport() returning the B19-M1 development export is required");
  if (typeof getNewTownDevelopments !== "function") throw new Error("getNewTownDevelopments() returning the B19-E1 development records is required");
  if (typeof getCurrentLinks !== "function") throw new Error("getCurrentLinks() returning { planIds, stationSiteIds } is required");
  for (const name of ["newTownRailContributionReport", "assessNewTownRailContribution", "newTownRailContributionHooks"]) {
    if (!runtime || typeof runtime[name] !== "function") throw new Error(`A ScenarioRuntime with ${name}() is required`);
  }
  const doc = container.ownerDocument ?? document;
  let saved = {};            // raw field values, kept across redraws
  let live = {};             // the field nodes on screen
  let selected = null;
  let notice = null;
  let error = null;
  let view = null;
  let readError = null;

  // --- fields: a control remembers what was typed when the panel is redrawn ---
  const remember = (key, node) => { live[key] = node; return node; };
  const savedOr = (key, fallback) => (key in saved ? saved[key] : fallback);
  const input = (key, props = {}) => { const node = el(doc, "input", { type: "text", className: "ntrc-input", ...props }); node.value = String(savedOr(key, props.value ?? "")); return remember(key, node); };
  const area = (key, props = {}) => { const node = el(doc, "textarea", { className: "ntrc-input", ...props }); node.value = String(savedOr(key, "")); return remember(key, node); };
  const check = (key) => { const node = el(doc, "input", { type: "checkbox", className: "ntrc-check" }); node.checked = savedOr(key, false) === true; return remember(key, node); };
  const select = (key, options, fallback = "") => {
    const node = el(doc, "select", { className: "ntrc-select" }, ...options.map(([value, label]) => el(doc, "option", { value, textContent: label })));
    node.value = String(savedOr(key, fallback));
    return remember(key, node);
  };
  const saveRaw = () => { for (const [key, node] of Object.entries(live)) saved[key] = node.type === "checkbox" ? node.checked === true : String(node.value ?? ""); };
  const raw = (key, fallback = "") => (key in live ? (live[key].type === "checkbox" ? live[key].checked === true : String(live[key].value ?? "")) : savedOr(key, fallback));
  // forget the draft form, both the saved text and the nodes on screen (so a redraw cannot bring it back)
  const dropDraft = () => { for (const key of Object.keys(saved)) if (key.startsWith("new:")) delete saved[key]; for (const key of Object.keys(live)) if (key.startsWith("new:")) delete live[key]; };
  const field = (label, node, hint = null) => el(doc, "label", { className: "ntrc-field" }, text(doc, "span", "ntrc-label", label), node, ...(hint ? [text(doc, "span", "ntrc-hint", hint)] : []));
  const MODES = [["unstated", "미명시 (null — 말하지 않음)"], ["none", "없음으로 명시 ([])"], ["list", "목록 입력"]];

  // --- reads: report / assess / hooks only ---
  const currentLinks = () => { try { const v = getCurrentLinks(); return isObject(v) ? clone(v) : null; } catch { return null; } };
  const geometryExport = () => { try { const v = getGeometryExport(); return isObject(v) ? v : null; } catch { return null; } };
  const developments = () => { try { return listOf(getNewTownDevelopments()); } catch { return []; } };

  // what a click on a step would send, read from the fields; a field that does not parse is left out of the assessment (the click reports it)
  function assessInput(c, link) {
    const input = { id: c.contributionId, geometry: link.geometryObject ? clone(link.geometryObject) : null, currentLinks: currentLinks() };
    const confirmations = listOf(c.conditions).filter((cond) => raw(`${c.contributionId}:confirm:${cond.conditionId}`, false) === true)
      .map((cond) => ({ conditionId: cond.conditionId, note: raw(`${c.contributionId}:note:${cond.conditionId}`, "").trim() || undefined }));
    if (confirmations.length) input.conditionConfirmations = confirmations;
    try {
      const amount = parseAmount(raw(`${c.contributionId}:fundAmount`), { optional: true });
      if (amount !== undefined) input.confirmation = { confirmedAmountYen: amount, confirmedBy: raw(`${c.contributionId}:fundBy`).trim(), reference: raw(`${c.contributionId}:fundRef`).trim() };
    } catch { /* the click reports it */ }
    return input;
  }

  function recompute() {
    readError = null; view = null;
    try {
      const report = listOf(runtime.newTownRailContributionReport());
      const devs = developments(); const exported = geometryExport();
      view = report.map((c) => {
        const link = linkFacts(c, exported, devs);
        let assessment = null; let hooks = null; let assessError = null;
        try { assessment = runtime.assessNewTownRailContribution(assessInput(c, link)); } catch (e) { assessError = message(e); }
        try { hooks = runtime.newTownRailContributionHooks(c.contributionId); } catch (e) { assessError = assessError ?? message(e); }
        return { contribution: c, link, assessment, hooks, assessError, terminal: TERMINAL.has(c.status) };
      });
    } catch (e) { readError = message(e); }
  }

  // --- commands: only ever called from a click ---
  function act(label, command, { onDone = null } = {}) {
    saveRaw(); error = null; notice = null;
    let done = false;
    try {
      const result = command();
      notice = `${label} 완료${result?.contributionId ? ` — ${result.contributionId} (${STATUS_LABEL[result.status] ?? result.status})` : ""}`;
      if (onDone) onDone(result);
      done = true;
    } catch (e) { error = `${label} 실패: ${message(e)}`; }
    refresh();
    if (done) onChange();
  }
  const contextFor = (c) => { const link = linkFacts(c, geometryExport(), developments()); return { geometry: link.geometryObject ? clone(link.geometryObject) : null, currentLinks: currentLinks() }; };

  function draftNow() {
    act("초안 만들기", () => {
      const r = (k) => raw(`new:${k}`);
      const draftInput = {
        developmentRecordId: required(r("developmentRecordId"), "개발 기록"), payerKind: required(r("payerKind"), "부담자 종류"), payeeKind: required(r("payeeKind"), "수령자 종류"), statedPurpose: required(r("statedPurpose"), "목적"),
        statedAmountYen: parseAmount(r("amount")), phaseIds: parseIds(r("phaseMode"), r("phaseText"), "연결 단계"),
        linkedProjectIds: parseIds(r("projectMode"), r("projectText"), "연결 프로젝트"), linkedPlanIds: parseIds(r("planMode"), r("planText"), "연결 계획"), linkedStationSiteIds: parseIds(r("siteMode"), r("siteText"), "연결 역 부지"),
        conditions: parseConditions(r("conditionMode"), r("conditionText")),
      };
      if (isText(r("name"))) draftInput.name = r("name").trim();
      return runtime.draftNewTownRailContribution(draftInput);
    }, { onDone: (result) => { dropDraft(); selected = result.contributionId; } });
  }
  const stepNow = (c, kind) => {
    const id = c.contributionId; const k = (name) => `${id}:${name}`;
    const label = STEP_LABEL[kind];
    if (kind === "propose") return act(label, () => runtime.proposeNewTownRailContribution(id, contextFor(c)));
    if (kind === "agree") {
      return act(label, () => {
        const terms = {};
        const amount = parseAmount(raw(k("agreeAmount")), { optional: true });
        if (amount !== undefined) terms.statedAmountYen = amount;
        const mode = raw(k("agreeConditionMode"), "keep");
        if (mode === "none" || mode === "list") terms.conditions = parseConditions(mode, raw(k("agreeConditionText")));
        return runtime.agreeNewTownRailContribution(id, terms, contextFor(c));
      });
    }
    if (kind === "fund") {
      return act(label, () => {
        const amount = parseAmount(raw(k("fundAmount")), { optional: true });
        if (amount === undefined) throw new Error("지급을 확정한 금액을 입력하세요 — 합의 금액을 대신 채우지 않습니다");
        return runtime.fundNewTownRailContribution(id, { confirmedAmountYen: amount, confirmedBy: raw(k("fundBy")).trim(), reference: raw(k("fundRef")).trim() }, contextFor(c));
      });
    }
    if (kind === "release") {
      return act(label, () => {
        const conditionConfirmations = listOf(c.conditions).filter((cond) => raw(k(`confirm:${cond.conditionId}`), false) === true)
          .map((cond) => { const note = raw(k(`note:${cond.conditionId}`)).trim(); return note ? { conditionId: cond.conditionId, note } : { conditionId: cond.conditionId }; });
        return runtime.releaseNewTownRailContribution(id, { ...contextFor(c), conditionConfirmations });
      });
    }
    if (kind === "delay") return act(label, () => runtime.delayNewTownRailContribution(id, required(raw(k("delayReason")), "지연 이유")));
    if (kind === "resume") return act(label, () => runtime.resumeNewTownRailContribution(id, contextFor(c)));
    if (kind === "terminate") return act(label, () => runtime.terminateNewTownRailContribution(id, required(raw(k("terminateReason")), "종료 이유")));
    return undefined;
  };

  // --- drawing ---
  function refresh() {
    saveRaw(); live = {};
    recompute();
    const children = [text(doc, "p", "ntrc-notice ntrc-scope", SCOPE_NOTICE)];
    if (notice) children.push(text(doc, "div", "ntrc-notice ntrc-done", notice));
    if (error) children.push(text(doc, "div", "ntrc-error", error));
    if (readError) children.push(text(doc, "div", "ntrc-error", `읽기 실패: ${readError}`));
    const reread = el(doc, "button", { type: "button", className: "ntrc-reread", textContent: "엔진 판정 다시 읽기 (명령 실행 없음)" });
    reread.addEventListener("click", () => { notice = null; error = null; refresh(); });
    children.push(reread, draftForm());
    if (view) {
      const counts = Object.keys(STATUS_LABEL).map((s) => `${STATUS_LABEL[s]} ${view.filter((v) => v.contribution.status === s).length}`).join(" · ");
      children.push(text(doc, "div", "ntrc-counts", `분담금 계약 ${view.length}건 — ${counts}`));
      if (!view.length) children.push(text(doc, "p", "ntrc-empty", "분담금 계약이 없습니다. 위에서 초안을 만드세요."));
      for (const row of view) children.push(card(row));
    }
    container.replaceChildren(...children);
  }

  function draftForm() {
    const devOptions = [["", "(개발 기록을 고르세요)"], ...developments().filter(isObject).map((d) => [d.id, `${d.id} · ${valueText(d.developmentId)} · ${d.status}${d.status === "cancelled" ? " (취소됨 — 엔진이 거절함)" : ""} · revision ${valueText(d.developmentRevision)}`])];
    const pick = (map) => [["", "(선택하세요)"], ...Object.entries(map)];
    const button = el(doc, "button", { type: "button", className: "ntrc-act ntrc-draft", textContent: "초안 만들기 (draft)" });
    button.addEventListener("click", draftNow);
    return el(doc, "div", { className: "ntrc-form ntrc-new" },
      text(doc, "strong", "ntrc-section", "새 분담금 계약 초안 — 모든 항목을 직접 입력합니다(기본값·자동 채움 없음)"),
      field("개발 기록 (E1)", select("new:developmentRecordId", devOptions, "")),
      field("부담자 종류", select("new:payerKind", pick(PAYER_LABEL), "")), field("수령자 종류", select("new:payeeKind", pick(PAYEE_LABEL), "")), field("목적", select("new:statedPurpose", pick(PURPOSE_LABEL), "")),
      field("분담 금액(엔)", input("new:amount", {}), "숫자만 입력 — 비우면 '미명시(null)', 0은 '0엔으로 명시'. 면적·인구·수요로 계산하지 않습니다"),
      field("이름(선택)", input("new:name", {})),
      ...[["phase", "연결 단계", "단계 ID를 쉼표로 구분 — 미명시는 개발 전체를 뜻합니다"], ["project", "연결 프로젝트", "프로젝트 ID를 쉼표로 구분"], ["plan", "연결 계획", "지도 계획 ID를 쉼표로 구분"], ["site", "연결 역 부지", "역 부지 ID를 쉼표로 구분"]]
        .map(([key, label, hint]) => el(doc, "div", { className: "ntrc-listfield" }, field(label, select(`new:${key}Mode`, MODES, "unstated")), field(`${label} 목록`, input(`new:${key}Text`, {}), hint))),
      el(doc, "div", { className: "ntrc-listfield" }, field("조건", select("new:conditionMode", MODES, "unstated")), field("조건 목록", area("new:conditionText", {}), "한 줄에 '조건ID: 내용'")),
      button);
  }

  const row = (label, value, className = "") => el(doc, "div", { className: `ntrc-fact ${className}`.trim() }, text(doc, "span", "ntrc-fact-label", label), text(doc, "span", "ntrc-fact-value", value));
  const yesNo = (v) => (v === null || v === undefined ? "미상" : v ? "예" : "아니오");

  function card(v) {
    const c = v.contribution;
    const node = el(doc, "div", { className: `ntrc-card ${c.status}${v.terminal ? " terminal" : ""}${selected === c.contributionId ? " selected" : ""}` });
    const pickButton = el(doc, "button", { type: "button", className: "ntrc-select-card", textContent: selected === c.contributionId ? "선택됨" : "자세히 보기" });
    pickButton.addEventListener("click", () => { saveRaw(); selected = selected === c.contributionId ? null : c.contributionId; refresh(); });
    node.append(el(doc, "div", { className: "ntrc-head" }, text(doc, "b", "ntrc-title", c.name ?? c.contributionId), text(doc, "span", `ntrc-status ${c.status}`, STATUS_LABEL[c.status] ?? c.status), pickButton));
    node.append(
      row("계약 ID", c.contributionId, "ntrc-id"), row("개발 기록 ID (E1)", c.developmentRecordId), row("개발 ID (지도)", valueText(c.developmentId)),
      row("개발 revision", valueText(c.developmentRevision)), row("팩", c.sourcePack ? `${c.sourcePack.packId} ${valueText(c.sourcePack.packVersion)}` : "미상(null)"),
      row("부담자 → 수령자", `${PAYER_LABEL[c.payerKind] ?? c.payerKind} → ${PAYEE_LABEL[c.payeeKind] ?? c.payeeKind}`), row("목적", PURPOSE_LABEL[c.statedPurpose] ?? c.statedPurpose),
      row("분담 금액", amountText(c.statedAmountYen), "ntrc-amount"), row("연결 단계", phaseText(c.phaseIds)),
      row("연결 프로젝트", idListText(c.linkedProjectIds)), row("연결 계획", idListText(c.linkedPlanIds)), row("연결 역 부지", idListText(c.linkedStationSiteIds)),
      row("조건", conditionsText(c.conditions), "ntrc-conditions"),
    );
    node.append(linkSection(v));
    node.append(...stageFacts(c));
    if (v.terminal) node.append(text(doc, "div", "ntrc-terminal", `${STATUS_LABEL[c.status]} — ${TERMINAL_NOTICE}`));
    if (v.assessError) node.append(text(doc, "div", "ntrc-error", `엔진 판정을 읽지 못함: ${v.assessError}`));
    if (v.assessment && !v.terminal) node.append(...assessmentSection(v));
    if (!v.terminal && v.assessment) node.append(...actionSection(v));
    if (selected === c.contributionId) node.append(...detailSection(v));
    return node;
  }

  function linkSection(v) {
    const g = v.link.geometry; const r = v.link.record;
    const lines = [];
    lines.push(!g.exportReadable ? "지도 export를 읽을 수 없음 — 엔진에 geometry 없음으로 전달됨"
      : g.ambiguous ? "지도 export에 같은 개발 ID가 여럿 있음 — 엔진에 geometry 없음으로 전달됨"
        : !g.found ? "지도 export에 이 개발 ID의 geometry가 없음 — 엔진에 geometry 없음으로 전달됨"
          : `지도 geometry: revision ${SAME_LABEL[g.developmentRevision]} · 팩 ID ${SAME_LABEL[g.sourcePackId]} · 팩 버전 ${SAME_LABEL[g.sourcePackVersion]} · 활성 ${yesNo(g.active)}`);
    lines.push(!r.found ? "E1 개발 기록 목록에 이 기록이 없음"
      : `E1 개발 기록: 상태 ${r.status} · 개발 ID ${SAME_LABEL[r.developmentId]} · revision ${SAME_LABEL[r.developmentRevision]} · 팩 ID ${SAME_LABEL[r.sourcePackId]} · 팩 버전 ${SAME_LABEL[r.sourcePackVersion]}`);
    return el(doc, "div", { className: "ntrc-link" }, text(doc, "span", "ntrc-section", "지도·개발 기록 연결 (표시만 — 통과 여부는 엔진이 정함)"), ...lines.map((line) => text(doc, "div", "ntrc-link-line", line)));
  }

  function stageFacts(c) {
    const out = [];
    if (c.agreement) out.push(row("합의", `${c.agreement.agreedAtMinute}분 · 금액 ${amountText(c.agreement.statedAmountYen)} · 조건 ${conditionsText(c.agreement.conditions)}`));
    if (c.funding) out.push(row("지급 확정(현금 아님)", `${c.funding.fundedAtMinute}분 · ${amountText(c.funding.confirmedAmountYen)} · ${c.funding.confirmedBy} · ${c.funding.reference}`));
    if (c.release) out.push(row("release", `${c.release.releasedAtMinute}분 · ${amountText(c.release.amountYen)} · 원장 ${c.release.ledgerEffect === "posted" ? `반영됨(원장 항목 ${c.release.ledgerEntryId})` : `반영 안 함(${valueText(c.release.ledgerEffectReason)})`} · 확인한 조건 ${c.release.conditionConfirmations.length === 0 ? "없음" : c.release.conditionConfirmations.map((x) => x.conditionId).join(", ")}`, "ntrc-release-fact"));
    if (c.delay) out.push(row("지연", `${c.delay.reason} · ${c.delay.delayedAtMinute}분 · 지연 전 ${STATUS_LABEL[c.delay.fromStatus] ?? c.delay.fromStatus} · ${c.delay.resumedAtMinute === null ? "아직 재개 안 함" : `${c.delay.resumedAtMinute}분에 재개`}`));
    if (c.termination) out.push(row("종료", `${c.termination.reason} · ${c.termination.terminatedAtMinute}분 · 종료 전 ${STATUS_LABEL[c.termination.fromStatus] ?? c.termination.fromStatus} · 지급 확정 후 미반영 ${yesNo(c.termination.fundedNotReleased)}`));
    return out;
  }

  const statusBlocked = (t) => listOf(t?.blockers).some((b) => String(b).startsWith("status-not-allowed"));
  const relevant = (v, kind) => Boolean(v.assessment?.transitions?.[kind]) && !statusBlocked(v.assessment.transitions[kind]);

  // the engine's own answers, copied as they are
  function assessmentSection(v) {
    const a = v.assessment;
    const nodes = [text(doc, "span", "ntrc-section", "엔진 판정 (읽기 전용)")];
    for (const kind of STEPS) {
      if (!relevant(v, kind)) continue;
      const t = a.transitions[kind];
      nodes.push(text(doc, "div", `ntrc-step ${kind} ${t.allowed ? "allowed" : "blocked"}`, `${STEP_LABEL[kind]}: ${t.allowed ? "지금 가능(엔진 판정)" : "막힘"}`));
      for (const code of listOf(t.blockers)) nodes.push(text(doc, "div", `ntrc-blocker ${kind}`, `· ${blockerText(code)}`));
    }
    const e = a.releaseEffect;
    if (e) nodes.push(text(doc, "div", `ntrc-effect ${e.kind}`, e.kind === "post" ? `release하면 원장에 ${amountText(e.amountYen)}이 한 번 반영됩니다 (엔진 판정)` : e.reason === "not-funded" ? "지급 확정 전이라 release 효과를 아직 알 수 없습니다 (엔진 판정: not-funded)" : `release해도 원장에는 반영되지 않습니다 — ${valueText(e.reason)} (엔진 판정)`));
    return nodes;
  }

  function actionSection(v) {
    const c = v.contribution; const id = c.contributionId; const k = (name) => `${id}:${name}`;
    const nodes = [text(doc, "span", "ntrc-section", "실행")];
    const go = (kind, labelText, extraClass = "") => {
      const b = el(doc, "button", { type: "button", className: `ntrc-act ntrc-${kind} ${extraClass} ${v.assessment.transitions[kind].allowed ? "" : "engine-blocked"}`.trim(), textContent: labelText });
      b.addEventListener("click", () => stepNow(c, kind));
      return b;
    };
    if (relevant(v, "propose")) nodes.push(go("propose", "제안 (propose)"));
    if (relevant(v, "agree")) {
      nodes.push(el(doc, "div", { className: "ntrc-form" },
        field("합의 금액(엔) — 비우면 초안의 값을 그대로", input(k("agreeAmount"), {}), "초안에 금액이 없으면 여기에 직접 입력해야 합의됩니다"),
        field("조건", select(k("agreeConditionMode"), [["keep", "초안의 조건 유지"], ["none", "없음으로 명시 ([])"], ["list", "목록 입력"]], "keep")), field("조건 목록", area(k("agreeConditionText"), {}), "한 줄에 '조건ID: 내용'"),
        go("agree", "합의 (agree) — 현금은 만들어지지 않습니다")));
    }
    if (relevant(v, "fund")) {
      nodes.push(el(doc, "div", { className: "ntrc-form" },
        text(doc, "div", "ntrc-note", "지급 확정은 부담자가 지급을 확정했다는 사실의 기록일 뿐 현금이 아닙니다. 합의 금액을 자동으로 채우지 않으니 확정된 금액을 직접 입력하세요."),
        field("확정 금액(엔)", input(k("fundAmount"), {})), field("확정한 주체", input(k("fundBy"), {})), field("근거(문서·결의 등)", input(k("fundRef"), {})),
        go("fund", "지급 확정 기록 (fund)")));
    }
    if (relevant(v, "release")) {
      const conds = listOf(c.conditions);
      nodes.push(el(doc, "div", { className: "ntrc-form ntrc-release-form" },
        text(doc, "div", "ntrc-release-notice", RELEASE_NOTICE),
        conds.length ? text(doc, "div", "ntrc-note", "계약에 명시된 조건을 하나씩 직접 확인해야 합니다. 확인한 조건만 보내며, 모든 조건을 정확히 한 번씩 확인해야 엔진이 받아들입니다.") : text(doc, "div", "ntrc-note", c.conditions === null ? "조건이 명시되지 않았습니다(null)." : "확인할 조건이 없습니다 — 조건 없음으로 명시됨([])."),
        ...conds.map((cond) => el(doc, "div", { className: "ntrc-confirm" }, el(doc, "label", { className: "ntrc-field" }, check(k(`confirm:${cond.conditionId}`)), text(doc, "span", "ntrc-label", `${cond.conditionId}: ${cond.text} — 충족을 확인함`)), field("확인 메모(선택)", input(k(`note:${cond.conditionId}`), {})))),
        go("release", "release (원장에 반영될 수 있음)", "ntrc-release-act")));
    }
    if (relevant(v, "resume")) nodes.push(go("resume", "재개 (resume)"));
    if (relevant(v, "delay")) nodes.push(el(doc, "div", { className: "ntrc-form" }, field("지연 이유", input(k("delayReason"), {})), go("delay", "지연 (delay)")));
    if (relevant(v, "terminate")) nodes.push(el(doc, "div", { className: "ntrc-form" }, field("종료 이유", input(k("terminateReason"), {})), go("terminate", "종료 (terminate) — 되돌릴 수 없음")));
    return nodes;
  }

  function detailSection(v) {
    const c = v.contribution; const h = v.hooks;
    const nodes = [text(doc, "span", "ntrc-section", "자세히 (엔진이 기록한 그대로)")];
    if (c.gate) nodes.push(row("마지막으로 받아들인 시점의 개발", `revision ${valueText(c.gate.developmentRevision)} · 개발 상태 ${c.gate.developmentStatus} · geometry ${c.gate.geometryStatus} · ${c.gate.checkedAtMinute}분`));
    if (h) {
      nodes.push(row("hook ID", h.hookId, "ntrc-hook"), row("단계 hook ID", h.phaseHookIds === null ? "미지정(null) — 개발 전체" : h.phaseHookIds.length === 0 ? "없음으로 명시함([])" : h.phaseHookIds.join(", ")));
      nodes.push(row("원장 연결", h.ledger ? `원장 항목 ${h.ledger.entryId} · ${amountText(h.ledger.amountYen)}` : "없음(원장에 반영되지 않음)"));
    }
    nodes.push(text(doc, "span", "ntrc-section", "이력"));
    for (const entry of listOf(c.history)) nodes.push(text(doc, "div", "ntrc-history", `${entry.transitionId} · ${entry.kind} · ${valueText(entry.from)} → ${entry.to} · ${entry.atMinute}분${entry.reason ? ` · ${entry.reason}` : ""}`));
    if (v.assessment) nodes.push(text(doc, "div", "ntrc-note", `계산하지 않는 것: ${listOf(v.assessment.notComputed).join(", ")}`));
    return nodes;
  }

  refresh();
  const api = {
    refresh() { notice = null; error = null; refresh(); },
    select(id) { saveRaw(); selected = isText(id) ? id : null; refresh(); },
    serialize() {
      saveRaw();
      return serializePanelDoc({ schema: PANEL_DOC_SCHEMA, version: 1, selectedContributionId: selected, draft: Object.fromEntries(DRAFT_FIELDS.map((key) => [key, String(saved[`new:${key}`] ?? (MODE_FIELDS.includes(key) ? "unstated" : ""))])) });
    },
    // -> { ok, issues }; a refused document leaves everything as it was.  No engine call.
    loadDoc(source) {
      const { doc: loaded, issues } = restorePanelDoc(source);
      if (!loaded) return { ok: false, issues };
      saveRaw(); dropDraft();
      for (const key of DRAFT_FIELDS) saved[`new:${key}`] = loaded.draft[key];
      selected = loaded.selectedContributionId; notice = null; error = null;
      refresh();
      return { ok: true, issues: [] };
    },
    get document() { return JSON.parse(api.serialize()); },
    get selected() { return selected; },
    // copies of what is on screen, for the host and tests
    results: () => (view ? view.map((v) => clone({ contributionId: v.contribution.contributionId, status: v.contribution.status, terminal: v.terminal, link: { geometry: v.link.geometry, record: v.link.record }, assessment: v.assessment, hooks: v.hooks })) : []),
  };
  return api;
}
