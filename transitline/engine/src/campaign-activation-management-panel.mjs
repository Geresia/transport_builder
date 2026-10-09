// B20-C1 activation surface.  A B19 explicit demand source becomes only a
// recorded campaign reference here; it never changes B15 demand state.

export const CAMPAIGN_ACTIVATION_MANAGEMENT_PANEL_SCHEMA = "transitline.campaign-activation-management-panel/1";
const PROGRAM_SCHEMA = "transitline.regional-development-program/1";
const STYLE_ID = "transitline-campaign-activation-management-panel-style";
const CSS = ".cam{font:12px/1.5 system-ui,sans-serif}.cam-card{margin:6px 0;padding:7px;border:1px solid #2a2f3a;border-radius:6px}.cam-error{color:#ff6b6b;white-space:pre-wrap}.cam-note{color:#aab1c0}.cam-actions{display:flex;flex-wrap:wrap;gap:5px;margin:6px 0}.cam-blocker{display:inline-block;margin:2px;padding:1px 4px;border:1px solid #f59e0b;color:#f59e0b;border-radius:3px}.cam-field{display:block;margin:4px 0}";
const clone = (value) => structuredClone(value);
const compare = (a, b) => String(a).localeCompare(String(b));
const text = (value) => typeof value === "string" && value.trim() ? value.trim() : null;

function assertRuntime(runtime) {
  for (const name of ["campaignProgramReport", "campaignActivationReport", "newTownExplicitDemandSourceReport", "recordCampaignActivation", "withdrawCampaignActivation"]) if (typeof runtime?.[name] !== "function") throw new Error(`runtime.${name}() is required`);
}
function isObject(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function geometries(value) {
  const list = Array.isArray(value) ? value : Array.isArray(value?.programs) ? value.programs : [];
  const seen = new Set();
  return list.filter((entry) => entry?.schema === PROGRAM_SCHEMA && text(entry.programId)).filter((entry) => !seen.has(entry.programId) && seen.add(entry.programId)).slice().sort((a, b) => compare(a.programId, b.programId));
}
function el(doc, tag, properties = {}, ...children) { const node = doc.createElement(tag); Object.assign(node, properties); node.append(...children); return node; }
function fact(doc, name, value) { return el(doc, "div", { className: "cam-fact" }, el(doc, "span", { textContent: name }), el(doc, "span", { textContent: value })); }
function show(value) { return value === null || value === undefined ? "unknown" : Array.isArray(value) ? (value.length ? value.join(", ") : "empty list") : String(value); }

export function mountCampaignActivationManagementPanel({ container, runtime, getProgramGeometry, getDevelopmentGeometry, onChange = () => {} } = {}) {
  if (!container) throw new Error("A campaign activation management container is required");
  assertRuntime(runtime);
  if (typeof getProgramGeometry !== "function") throw new Error("getProgramGeometry() is required");
  if (typeof getDevelopmentGeometry !== "function") throw new Error("getDevelopmentGeometry() is required");
  if (typeof onChange !== "function") throw new Error("onChange must be a function");
  const doc = container.ownerDocument ?? document;
  if (doc.head && doc.getElementById && !doc.getElementById(STYLE_ID)) doc.head.append(Object.assign(doc.createElement("style"), { id: STYLE_ID, textContent: CSS }));
  let view = null; let notice = null; let selectedSources = {}; let withdrawalReasons = {}; let destroyed = false;
  const button = (name, className, action, disabled = false) => { const node = el(doc, "button", { type: "button", className, textContent: name, disabled }); node.addEventListener("click", action); return node; };
  const sourceKey = (recordId, milestoneId) => `${recordId}|${milestoneId}`;
  function inputsNow() {
    const programList = geometries(getProgramGeometry());
    const developmentGeometry = getDevelopmentGeometry() ?? null;
    const sources = runtime.newTownExplicitDemandSourceReport({ geometry: developmentGeometry });
    return { programList, developmentGeometry, sources: Array.isArray(sources) ? sources : [] };
  }
  function collect() {
    let input = null; let error = null;
    try { input = inputsNow(); } catch (reason) { error = reason instanceof Error ? reason.message : String(reason); }
    const records = runtime.campaignProgramReport().slice().sort((a, b) => compare(a.id, b.id)).map((record) => {
      const geometry = input?.programList.find((entry) => entry.programId === record.programId) ?? null;
      let activations = []; let activationError = null;
      try { activations = runtime.campaignActivationReport({ geometry, developmentGeometry: input?.developmentGeometry ?? null }).filter((entry) => entry.programId === record.programId).sort((a, b) => compare(a.activationId, b.activationId)); }
      catch (reason) { activationError = reason instanceof Error ? reason.message : String(reason); }
      return { record: clone(record), geometry: geometry === null ? null : clone(geometry), activations: clone(activations), activationError };
    });
    return { schema: CAMPAIGN_ACTIVATION_MANAGEMENT_PANEL_SCHEMA, contractVersion: 1, developmentGeometryProvided: input?.developmentGeometry !== null, sourceCount: input?.sources.length ?? null, sources: clone(input?.sources ?? []), records, inputError: error, notice: notice === null ? null : clone(notice) };
  }
  function freshGeometry(programId) { return geometries(getProgramGeometry()).find((entry) => entry.programId === programId) ?? null; }
  function freshSource(sourceId, developmentGeometry) { return runtime.newTownExplicitDemandSourceReport({ geometry: developmentGeometry }).find((source) => source?.sourceId === sourceId) ?? null; }
  function recordActivation(programRecord, milestoneId) {
    if (destroyed) return;
    try {
      const key = sourceKey(programRecord.id, milestoneId); const sourceId = selectedSources[key] ?? null;
      const developmentGeometry = getDevelopmentGeometry() ?? null;
      const geometry = freshGeometry(programRecord.programId);
      const source = freshSource(sourceId, developmentGeometry);
      if (!sourceId) throw new Error("demand-source-not-selected");
      if (!source) throw new Error("demand-source-not-found");
      const result = runtime.recordCampaignActivation({ campaignProgramId: programRecord.id, milestoneId, intakeId: source.intakeId, demandSourceId: source.sourceId, geometry, developmentGeometry });
      notice = { type: "done", kind: "record", id: result?.activationId ?? null }; refresh(); onChange({ kind: "command", action: "record", id: notice.id, campaignProgramId: programRecord.id, milestoneId });
    } catch (reason) { notice = { type: "error", kind: "record", message: reason instanceof Error ? reason.message : String(reason) }; view = collect(); render(); }
  }
  function withdraw(activationId) {
    if (destroyed) return;
    try {
      const result = runtime.withdrawCampaignActivation(activationId, withdrawalReasons[activationId] ?? "");
      notice = { type: "done", kind: "withdraw", id: result?.activationId ?? activationId }; refresh(); onChange({ kind: "command", action: "withdraw", id: notice.id });
    } catch (reason) { notice = { type: "error", kind: "withdraw", message: reason instanceof Error ? reason.message : String(reason) }; view = collect(); render(); }
  }
  function sourcePicker(record, milestoneId) {
    const key = sourceKey(record.id, milestoneId); const select = el(doc, "select", { className: "cam-source", value: selectedSources[key] ?? "" });
    select.append(el(doc, "option", { value: "", textContent: "Select explicit B19 source" }));
    for (const source of view.sources.slice().sort((a, b) => compare(a.sourceId, b.sourceId))) select.append(el(doc, "option", { value: source.sourceId, textContent: `${source.sourceId} (${source.status}; ${source.standing?.status ?? "unknown"})` }));
    select.addEventListener("change", () => { selectedSources[key] = select.value; });
    return select;
  }
  function activationCard(activation) {
    const input = el(doc, "input", { type: "text", className: "cam-withdraw-reason", value: withdrawalReasons[activation.activationId] ?? "", placeholder: "Withdrawal reason" });
    input.addEventListener("input", () => { withdrawalReasons[activation.activationId] = input.value; });
    const card = el(doc, "div", { className: "cam-card" }, fact(doc, "Activation", activation.activationId), fact(doc, "Milestone", activation.milestoneId), fact(doc, "Recorded status", show(activation.status)), fact(doc, "Standing", show(activation.standing?.status)), input);
    for (const blocker of activation.standing?.blockers ?? []) card.append(el(doc, "span", { className: "cam-blocker", textContent: blocker }));
    card.append(button("Withdraw activation", "cam-withdraw", () => withdraw(activation.activationId), activation.status !== "recorded"));
    return card;
  }
  function programCard(item) {
    const record = item.record; const card = el(doc, "section", { className: "cam-card" }, fact(doc, "Campaign record", record.id), fact(doc, "Map program", record.programId), fact(doc, "Current geometry", item.geometry ? item.geometry.programRevision : "unknown"));
    if (item.activationError) card.append(el(doc, "div", { className: "cam-error", textContent: item.activationError }));
    for (const milestone of record.milestones ?? []) {
      const row = el(doc, "div", { className: "cam-card" }, fact(doc, "Milestone", `${milestone.sequence}: ${milestone.milestoneId}`), fact(doc, "Milestone status", show(milestone.status)), sourcePicker(record, milestone.milestoneId));
      row.append(button("Record selected source", "cam-record", () => recordActivation(record, milestone.milestoneId), !view.developmentGeometryProvided));
      card.append(row);
    }
    card.append(...item.activations.map(activationCard));
    return card;
  }
  function render() {
    if (destroyed) return;
    const children = [el(doc, "p", { className: "cam-note", textContent: "A campaign activation is an explicit reference from one B19 source to one B20 milestone. It does not apply demand to B15 or change passengers, fares, money, clock, or RNG." })];
    if (view.inputError) children.push(el(doc, "div", { className: "cam-error", textContent: `Input error: ${view.inputError}` }));
    children.push(fact(doc, "Current explicit sources", show(view.sourceCount)), ...view.records.map(programCard));
    if (!view.records.length) children.push(el(doc, "div", { className: "cam-note", textContent: "No campaign lifecycle records are available." }));
    if (notice) children.push(el(doc, "div", { className: notice.type === "error" ? "cam-error" : "cam-note", textContent: notice.type === "error" ? `Runtime error: ${notice.message}` : `${notice.kind} completed: ${notice.id ?? "recorded"}` }));
    container.replaceChildren(...children);
  }
  function refresh() { view = collect(); render(); return api.output(); }
  const api = { refresh, output() { return clone(view); }, destroy() { destroyed = true; container.replaceChildren(); } };
  refresh(); return api;
}
