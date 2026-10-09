// B19-M5. This panel records only player choices around B19-E4/E5 facts.
// It never turns a stated residents/jobs fact into a demand, passenger, fare,
// score, cost, or B15 link. Runtime commands leave this panel only on clicks.

export const NEW_TOWN_DEMAND_INTAKE_PANEL_SCHEMA = "transitline.new-town-demand-intake-panel/1";
export const NEW_TOWN_DEMAND_INTAKE_PANEL_DOC_SCHEMA = "transitline.new-town-demand-intake-panel-doc/1";
const EXPORT_SCHEMA = "transitline.new-town-development-export/1";
const STYLE_ID = "transitline-new-town-demand-intake-panel-style";
const CSS = ".ntdi{font:12px/1.5 system-ui,sans-serif}.ntdi-row,.ntdi-card{margin:5px 0;padding:7px;border:1px solid #2a2f3a;border-radius:6px}.ntdi-row.selected{border-color:#4cc9f0}.ntdi-fact,.ntdi-note{margin:3px 0;color:#aab1c0}.ntdi-blocker{display:inline-block;margin:2px;padding:1px 4px;border:1px solid #f59e0b;color:#f59e0b;border-radius:3px}.ntdi-error{color:#ff6b6b;white-space:pre-wrap}.ntdi-actions{display:flex;flex-wrap:wrap;gap:5px;margin:6px 0}.ntdi-field{display:block;margin:5px 0}.ntdi-field input{margin-left:5px}.ntdi-source{border-left:3px solid #2dd4bf}.ntdi-source.stale,.ntdi-source.unverified{border-left-color:#f59e0b}.ntdi-source.withdrawn{border-left-color:#8b93a5}";
const COMMANDS = Object.freeze(["acceptNewTownDemandCandidate", "holdNewTownDemandCandidate", "rejectNewTownDemandCandidate", "revokeNewTownDemandCandidate", "applyNewTownExplicitDemandSource", "withdrawNewTownExplicitDemandSource"]);
const READS = Object.freeze(["newTownDevelopmentReport", "assessNewTownDemandIntake", "newTownDemandIntakeReport", "assessNewTownExplicitDemandSources", "newTownExplicitDemandSourceReport"]);
const clone = (value) => structuredClone(value);
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const keyOf = (recordId, candidateId) => `${recordId}|${candidateId}`;
const list = (value) => Array.isArray(value) ? value : [];
const text = (value) => typeof value === "string" ? value.trim() : "";
const show = (value) => value === null || value === undefined ? "unknown" : Array.isArray(value) ? (value.length ? value.join(", ") : "empty list") : String(value);
const blankForm = () => ({ factIds: [], note: "", decisionReason: "", withdrawalReason: "" });
const formOf = (forms, key) => (forms[key] ??= blankForm());

function readExport(value) {
  if (!isObject(value) || value.schema !== EXPORT_SCHEMA || !Array.isArray(value.developments)) return null;
  return value;
}
function geometryOf(exportData, developmentId) {
  return exportData?.developments.find((development) => development?.developmentId === developmentId) ?? null;
}
function ensureRuntime(runtime) {
  for (const name of [...COMMANDS, ...READS]) if (typeof runtime?.[name] !== "function") throw new Error(`runtime.${name}() is required`);
}
function cleanForm(value) {
  if (!isObject(value) || !Array.isArray(value.factIds) || !value.factIds.every((id) => typeof id === "string") || !["note", "decisionReason", "withdrawalReason"].every((key) => typeof value[key] === "string")) throw new Error("new-town-demand-intake-panel-document-invalid-form");
  return { factIds: [...new Set(value.factIds)].sort(), note: value.note, decisionReason: value.decisionReason, withdrawalReason: value.withdrawalReason };
}
export function newTownDemandIntakePanelDocument({ packId = null, packVersion = null, selectedCandidateKey = null, forms = {} } = {}) {
  if ((packId !== null && typeof packId !== "string") || (packVersion !== null && typeof packVersion !== "string") || (selectedCandidateKey !== null && typeof selectedCandidateKey !== "string") || !isObject(forms)) throw new Error("new-town-demand-intake-panel-document-invalid");
  return { schema: NEW_TOWN_DEMAND_INTAKE_PANEL_DOC_SCHEMA, version: 1, packId, packVersion, selectedCandidateKey, forms: Object.fromEntries(Object.keys(forms).sort().map((key) => [key, cleanForm(forms[key])])) };
}
export const serializeNewTownDemandIntakePanelDocument = (value) => JSON.stringify(newTownDemandIntakePanelDocument(value));
export function restoreNewTownDemandIntakePanelDocument(source, { packId = null, packVersion = null, current = null } = {}) {
  let parsed;
  try { parsed = typeof source === "string" ? JSON.parse(source) : clone(source); } catch { return { document: current, rejected: true, warnings: ["new-town-demand-intake-panel-document-unreadable"] }; }
  try {
    if (!isObject(parsed) || parsed.schema !== NEW_TOWN_DEMAND_INTAKE_PANEL_DOC_SCHEMA || parsed.version !== 1) throw new Error("schema");
    if (parsed.packId !== packId) return { document: current, rejected: true, warnings: ["new-town-demand-intake-panel-document-other-pack"] };
    const document = newTownDemandIntakePanelDocument(parsed);
    return { document, rejected: false, warnings: document.packVersion !== packVersion ? ["new-town-demand-intake-panel-pack-version-changed"] : [] };
  } catch { return { document: current, rejected: true, warnings: ["new-town-demand-intake-panel-document-invalid"] }; }
}

export function mountNewTownDemandIntakePanel({ container, runtime, getGeometryExport, onChange = () => {} } = {}) {
  if (!container) throw new Error("A new-town demand intake container is required");
  ensureRuntime(runtime);
  if (typeof getGeometryExport !== "function") throw new Error("getGeometryExport() is required");
  const doc = container.ownerDocument ?? document;
  if (doc.head && doc.getElementById && !doc.getElementById(STYLE_ID)) doc.head.append(Object.assign(doc.createElement("style"), { id: STYLE_ID, textContent: CSS }));
  let selectedCandidateKey = null; let forms = {}; let view = null; let notice = null; let destroyed = false;
  const el = (tag, props = {}, ...children) => { const node = doc.createElement(tag); Object.assign(node, props); node.append(...children); return node; };
  const txt = (tag, className, value) => el(tag, { className, textContent: value });
  const button = (label, className, fn, disabled = false) => { const node = el("button", { type: "button", className, textContent: label, disabled }); node.addEventListener("click", fn); return node; };

  function collect() {
    let exportData = null; let exportError = null;
    try { exportData = readExport(getGeometryExport()); if (!exportData) exportError = "new-town-development-export-invalid"; } catch (error) { exportError = `new-town-development-export-threw:${error?.message ?? error}`; }
    const candidates = [];
    for (const record of list(runtime.newTownDevelopmentReport())) {
      const geometry = geometryOf(exportData, record.developmentId);
      const assessment = runtime.assessNewTownDemandIntake({ developmentRecordId: record.id, geometry });
      const intakes = runtime.newTownDemandIntakeReport(null, { geometry }).filter((item) => item.developmentRecordId === record.id);
      const sources = runtime.assessNewTownExplicitDemandSources({ geometry });
      const storedSources = runtime.newTownExplicitDemandSourceReport({ geometry });
      for (const candidate of list(assessment?.candidates)) {
        const intake = intakes.find((item) => item.candidateId === candidate.candidateId && item.status !== "revoked") ?? null;
        const source = list(sources?.sources).find((item) => item.intakeId === candidate.intakeId) ?? null;
        const storedSource = list(storedSources).find((item) => item.intakeId === candidate.intakeId) ?? null;
        candidates.push({ key: keyOf(record.id, candidate.candidateId), recordId: record.id, developmentId: record.developmentId, geometry, candidate: clone(candidate), intake, source, storedSource });
      }
    }
    candidates.sort((a, b) => a.developmentId.localeCompare(b.developmentId) || a.candidate.phaseId.localeCompare(b.candidate.phaseId));
    return { schema: NEW_TOWN_DEMAND_INTAKE_PANEL_SCHEMA, packId: exportData?.packId ?? null, packVersion: exportData?.packVersion ?? null, exportError, candidates, selectedCandidateKey, notice: notice === null ? null : clone(notice) };
  }
  function selectedNow() { return view?.candidates.find((item) => item.key === selectedCandidateKey) ?? null; }
  function select(key) { selectedCandidateKey = key === null ? null : view?.candidates.some((item) => item.key === key) ? key : null; render(); return api.output(); }
  function recheck(item, factIds) { return runtime.assessNewTownDemandIntake({ developmentRecordId: item.recordId, candidateId: item.candidate.candidateId, statedDemandFactIds: factIds, geometry: geometryOf(readExport(getGeometryExport()), item.developmentId) }); }
  function command(kind) {
    if (destroyed) return;
    const item = selectedNow(); if (!item) return;
    const form = formOf(forms, item.key); const facts = [...new Set(form.factIds)].sort(); let result;
    try {
      if (kind === "accept") { const checked = recheck(item, facts); if (!checked.selected.accept.allowed) throw new Error(checked.selected.accept.blockers.join(", ")); result = runtime.acceptNewTownDemandCandidate({ developmentRecordId: item.recordId, candidateId: item.candidate.candidateId, statedDemandFactIds: facts, ...(text(form.note) ? { note: text(form.note) } : {}), geometry: geometryOf(readExport(getGeometryExport()), item.developmentId) }); }
      else if (kind === "hold") result = runtime.holdNewTownDemandCandidate({ developmentRecordId: item.recordId, candidateId: item.candidate.candidateId, reason: form.decisionReason, geometry: geometryOf(readExport(getGeometryExport()), item.developmentId) });
      else if (kind === "reject") result = runtime.rejectNewTownDemandCandidate({ developmentRecordId: item.recordId, candidateId: item.candidate.candidateId, reason: form.decisionReason, geometry: geometryOf(readExport(getGeometryExport()), item.developmentId) });
      else if (kind === "revoke") result = runtime.revokeNewTownDemandCandidate(item.candidate.intakeId, form.decisionReason);
      else if (kind === "apply-source") { const checked = runtime.assessNewTownExplicitDemandSources({ geometry: geometryOf(readExport(getGeometryExport()), item.developmentId) }); const source = list(checked.sources).find((entry) => entry.intakeId === item.candidate.intakeId); if (!source?.apply?.allowed) throw new Error(show(source?.apply?.blockers)); result = runtime.applyNewTownExplicitDemandSource({ intakeId: item.candidate.intakeId, geometry: geometryOf(readExport(getGeometryExport()), item.developmentId) }); }
      else result = runtime.withdrawNewTownExplicitDemandSource(item.storedSource?.sourceId, form.withdrawalReason);
    } catch (error) { notice = { type: "error", kind, message: String(error?.message ?? error) }; render(); return; }
    notice = { type: "done", kind, id: result?.id ?? result?.sourceId ?? null }; render(); onChange({ kind: "command", action: kind, id: notice.id, developmentId: item.developmentId, candidateId: item.candidate.candidateId });
  }
  function input(label, className, value, set) { const node = el("input", { type: "text", className, value }); node.addEventListener("input", () => set(node.value)); return el("label", { className: "ntdi-field" }, txt("span", "", label), node); }
  function candidateRow(item) { const c = item.candidate; return el("div", { className: `ntdi-row${item.key === selectedCandidateKey ? " selected" : ""}` }, txt("span", "", `${item.developmentId} / ${c.phaseId}: ${c.currentStatus}, eligible ${show(c.eligibleForB15)}`), button("inspect", "ntdi-select", () => select(item.key))); }
  function detail(item) {
    const c = item.candidate; const form = formOf(forms, item.key); const children = [txt("h4", "", `${item.developmentId} / ${c.phaseId}`), txt("div", "ntdi-fact", `Intake: ${c.currentStatus}; verification: ${c.verification?.status ?? "not-applicable"}`), txt("div", "ntdi-fact", `Geometry: ${c.geometryStatus?.status ?? "unknown"}; completeness: ${c.completeness}; eligible: ${show(c.eligibleForB15)}`)];
    if (list(c.statedDemandFacts).length) {
      children.push(txt("div", "ntdi-note", "Choose the stated facts to record. Values stay stated facts; this panel does not aggregate or apply them."));
      for (const fact of c.statedDemandFacts) { const checked = form.factIds.includes(fact.factId); const box = el("input", { type: "checkbox", className: "ntdi-fact-choice", checked }); box.addEventListener("change", () => { form.factIds = box.checked ? [...new Set([...form.factIds, fact.factId])].sort() : form.factIds.filter((id) => id !== fact.factId); }); children.push(el("label", { className: "ntdi-fact" }, box, txt("span", "", `${fact.factId}: ${fact.kind} = ${show(fact.quantity)}`))); }
    } else children.push(txt("div", "ntdi-note", "No stated residents/jobs fact is available for this candidate."));
    children.push(input("Acceptance note (optional)", "ntdi-note-input", form.note, (value) => { form.note = value; }), input("Hold/reject/revoke reason", "ntdi-reason-input", form.decisionReason, (value) => { form.decisionReason = value; }), el("div", { className: "ntdi-actions" }, button("accept", "ntdi-accept", () => command("accept"), !c.accept?.allowed && c.currentStatus !== "pending"), button("hold", "ntdi-hold", () => command("hold"), !c.hold?.allowed), button("reject", "ntdi-reject", () => command("reject"), !c.reject?.allowed), button("revoke", "ntdi-revoke", () => command("revoke"), !c.revoke?.allowed)));
    const source = item.source; const stored = item.storedSource;
    children.push(txt("h4", "", "Explicit source (B19-E5)"), txt("div", `ntdi-fact ntdi-source ${stored?.standing?.status ?? source?.standing?.status ?? "unknown"}`, stored ? `${stored.sourceId}: ${stored.status}; standing ${stored.standing?.status ?? "unknown"}` : source ? `not applied; source standing ${source.standing?.status ?? "unknown"}` : "no accepted intake source"));
    if (source?.apply?.blockers?.length) children.push(...source.apply.blockers.map((blocker) => txt("span", "ntdi-blocker", blocker)));
    children.push(input("Source withdrawal reason", "ntdi-withdrawal-input", form.withdrawalReason, (value) => { form.withdrawalReason = value; }), el("div", { className: "ntdi-actions" }, button("apply explicit source", "ntdi-apply-source", () => command("apply-source"), !source?.apply?.allowed), button("withdraw explicit source", "ntdi-withdraw-source", () => command("withdraw-source"), stored?.status !== "applied")));
    return el("div", { className: "ntdi-card" }, ...children);
  }
  function render() {
    view = collect(); const children = [txt("p", "ntdi-notice", "B19 demand intake: this records explicit choices only. It does not create or alter B15 nodes, links, or allocations.")];
    if (view.exportError) children.push(txt("div", "ntdi-error", view.exportError));
    children.push(txt("div", "ntdi-count", `Candidates: ${view.candidates.length}`), ...view.candidates.map(candidateRow));
    const item = selectedNow(); if (item) children.push(detail(item)); else children.push(txt("div", "ntdi-note", "Select a candidate to inspect its stated facts and available actions."));
    if (notice) children.push(txt("div", notice.type === "error" ? "ntdi-error" : "ntdi-note", notice.type === "error" ? `Runtime error: ${notice.message}` : `${notice.kind} completed: ${notice.id ?? "recorded"}`));
    container.replaceChildren(...children);
  }
  const api = {
    refresh() { if (!destroyed) render(); return api.output(); }, select,
    serialize() { const current = readExport(getGeometryExport()); return serializeNewTownDemandIntakePanelDocument({ packId: current?.packId ?? null, packVersion: current?.packVersion ?? null, selectedCandidateKey, forms }); },
    loadDoc(source) { const current = readExport(getGeometryExport()); const restored = restoreNewTownDemandIntakePanelDocument(source, { packId: current?.packId ?? null, packVersion: current?.packVersion ?? null, current: { selectedCandidateKey, forms } }); if (!restored.rejected && restored.document) { selectedCandidateKey = restored.document.selectedCandidateKey; forms = restored.document.forms; } notice = restored.rejected ? { type: "error", kind: "load", message: restored.warnings.join(", ") } : restored.warnings.length ? { type: "error", kind: "load", message: restored.warnings.join(", ") } : null; render(); return clone(restored); },
    output() { return clone({ view, selectedCandidateKey, forms, notice }); },
    destroy() { destroyed = true; container.replaceChildren(); },
  };
  render(); return api;
}
