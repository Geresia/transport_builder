// B20-M3.  A host-mounted, read-only campaign timeline.  The only optional
// write boundary is an explicit milestone declaration supplied by the host;
// this module has no runtime reference, clock mutation, storage, polling, or
// automatic "due means reached" rule.

import { buildCampaignTimelineView, CAMPAIGN_TIMELINE_VIEW_SCHEMA } from "./campaign-timeline-view.mjs";

export const CAMPAIGN_TIMELINE_PANEL_SCHEMA = "transitline.campaign-timeline-panel/1";
export const CAMPAIGN_TIMELINE_PANEL_NOTICE = "Campaign target dates are display facts. A target becoming due never reaches a milestone automatically.";
const clone = (value) => structuredClone(value);
const compare = (a, b) => String(a).localeCompare(String(b), "en", { numeric: true });
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

export function checkCampaignTimelineView(view) {
  if (!isObject(view)) return { ok: false, reason: "timeline-view-not-an-object" };
  if (view.schema !== CAMPAIGN_TIMELINE_VIEW_SCHEMA) return { ok: false, reason: "timeline-view-schema-invalid" };
  if (view.programs !== null && !Array.isArray(view.programs)) return { ok: false, reason: "timeline-programs-invalid" };
  return { ok: true, reason: null };
}

const element = (doc, tag, properties = {}, ...children) => {
  const node = doc.createElement(tag);
  Object.assign(node, properties);
  node.append(...children);
  return node;
};
const text = (doc, tag, className, value) => element(doc, tag, { className, textContent: value });
const label = (doc, name, value) => element(doc, "div", { className: "campaign-timeline-fact" }, text(doc, "span", "campaign-timeline-label", name), text(doc, "span", "campaign-timeline-value", value));
const show = (value) => value === null || value === undefined ? "unknown" : Array.isArray(value) ? (value.length ? value.join(", ") : "empty list") : String(value);
const dueText = (target) => target?.status === "past-due" ? "past due" : target?.status === "due" ? "due" : target?.status === "upcoming" ? "upcoming" : "target unknown";

export function mountCampaignTimelinePanel({ container, getFactReport, getClockMinute, getGeometryForProgram = null, onReachMilestone = null } = {}) {
  if (!container) throw new Error("A campaign timeline container is required");
  if (typeof getFactReport !== "function") throw new Error("getFactReport() is required");
  if (typeof getClockMinute !== "function") throw new Error("getClockMinute() is required");
  if (getGeometryForProgram !== null && typeof getGeometryForProgram !== "function") throw new Error("getGeometryForProgram must be a function or null");
  if (onReachMilestone !== null && typeof onReachMilestone !== "function") throw new Error("onReachMilestone must be a function or null");
  const doc = container.ownerDocument ?? document;
  let view = null;
  let problem = null;
  let selectedProgramId = null;
  let selectedMilestoneId = null;
  let commandError = null;
  let observedReferences = [];
  let declaredWithoutObservedReferences = false;
  let destroyed = false;

  const selected = () => {
    const program = view?.programs?.find((entry) => entry?.campaignProgramId === selectedProgramId) ?? null;
    const milestone = program?.milestones?.find((entry) => entry?.milestoneId === selectedMilestoneId) ?? null;
    return { program, milestone };
  };
  const choose = (programId, milestoneId = null) => {
    selectedProgramId = typeof programId === "string" && programId ? programId : null;
    selectedMilestoneId = typeof milestoneId === "string" && milestoneId ? milestoneId : null;
    observedReferences = [];
    declaredWithoutObservedReferences = false;
    commandError = null;
    render();
  };
  function load() {
    problem = null;
    try {
      const next = buildCampaignTimelineView({ clockMinute: getClockMinute(), factReport: getFactReport() });
      const checked = checkCampaignTimelineView(next);
      if (!checked.ok) { view = null; problem = checked.reason; return; }
      view = next;
      const current = selected();
      if (selectedProgramId !== null && current.program === null) {
        selectedProgramId = null;
        selectedMilestoneId = null;
      } else if (selectedMilestoneId !== null && current.milestone === null) selectedMilestoneId = null;
    } catch (error) {
      view = null;
      problem = error instanceof Error ? error.message : String(error);
    }
  }
  const referenceRows = () => observedReferences.map((entry) => ({ refKind: typeof entry.refKind === "string" ? entry.refKind : "", refId: typeof entry.refId === "string" ? entry.refId : "", state: typeof entry.state === "string" ? entry.state : "" }));
  const updateReference = (index, patch) => { observedReferences = referenceRows().map((entry, candidate) => candidate === index ? { ...entry, ...patch } : entry); commandError = null; render(); };
  const normalisedReferences = () => {
    const rows = referenceRows();
    if (!rows.length) {
      if (!declaredWithoutObservedReferences) throw new Error("Declare no observed references explicitly, or add at least one observed reference.");
      return [];
    }
    if (rows.some((entry) => !entry.refKind.trim() || !entry.refId.trim())) throw new Error("Each observed reference needs a kind and an ID.");
    return rows.map((entry) => ({ refKind: entry.refKind.trim(), refId: entry.refId.trim(), state: entry.state.trim() || null }));
  };
  function milestoneCard(program, milestone) {
    const chosen = selectedProgramId === program.campaignProgramId && selectedMilestoneId === milestone.milestoneId;
    const card = element(doc, "div", { className: `campaign-timeline-milestone ${chosen ? "selected" : ""}` });
    const pick = element(doc, "button", { className: "campaign-timeline-select-milestone", type: "button", textContent: `${milestone.sequence}. ${milestone.milestoneId}` });
    pick.addEventListener("click", () => choose(program.campaignProgramId, milestone.milestoneId));
    card.append(pick, label(doc, "Recorded status", show(milestone.status)), label(doc, "Target month", show(milestone.targetMonth)), label(doc, "Target display", dueText(milestone.target)), label(doc, "Duration months", show(milestone.durationMonths)), label(doc, "Declared minute", show(milestone.declaredAtMinute)), label(doc, "Activations", show(milestone.activations?.length ?? null)));
    if (chosen) {
      card.append(text(doc, "p", "campaign-timeline-selection-note", "Selection only. The host must provide all current geometry and observed references when it records a milestone."));
      if (typeof onReachMilestone === "function" && milestone.status === "planned") {
        if (typeof getGeometryForProgram === "function") {
          const evidence = element(doc, "section", { className: "campaign-timeline-observed-references" }, text(doc, "h4", "", "Player-observed references"), text(doc, "p", "campaign-timeline-evidence-notice", "These are player declarations. They do not calculate or prove milestone completion."));
          const none = element(doc, "button", { className: "campaign-timeline-declare-no-references", type: "button", textContent: declaredWithoutObservedReferences ? "No observed references declared" : "Declare no observed references" });
          none.addEventListener("click", () => { declaredWithoutObservedReferences = !declaredWithoutObservedReferences; commandError = null; render(); });
          const add = element(doc, "button", { className: "campaign-timeline-add-reference", type: "button", textContent: "Add observed reference" });
          add.addEventListener("click", () => { observedReferences = [...referenceRows(), { refKind: "", refId: "", state: "" }]; declaredWithoutObservedReferences = false; commandError = null; render(); });
          evidence.append(none, add);
          referenceRows().forEach((entry, index) => {
            const row = element(doc, "div", { className: "campaign-timeline-observed-reference" });
            for (const [field, labelText] of [["refKind", "Kind"], ["refId", "ID"], ["state", "Observed state (optional)"]]) {
              const input = element(doc, "input", { className: `campaign-timeline-reference-${field}`, type: "text", value: entry[field], placeholder: labelText });
              input.addEventListener("change", () => updateReference(index, { [field]: input.value }));
              row.append(input);
            }
            const remove = element(doc, "button", { className: "campaign-timeline-remove-reference", type: "button", textContent: "Remove reference" });
            remove.addEventListener("click", () => { observedReferences = referenceRows().filter((_, candidate) => candidate !== index); commandError = null; render(); });
            evidence.append(row, remove);
          });
          card.append(evidence);
        }
        const reach = element(doc, "button", { className: "campaign-timeline-reach", type: "button", textContent: "Record milestone reached" });
        reach.addEventListener("click", () => {
          try {
            const intent = { campaignProgramId: program.campaignProgramId, programId: program.programId, milestoneId: milestone.milestoneId };
            if (typeof getGeometryForProgram === "function") {
              intent.observedRefs = normalisedReferences();
              intent.geometry = getGeometryForProgram(program.programId);
              if (!intent.geometry) throw new Error("Current map program geometry was not provided.");
            }
            onReachMilestone(intent);
            commandError = null;
          } catch (error) { commandError = error instanceof Error ? error.message : String(error); }
          render();
        });
        card.append(reach);
      } else if (milestone.status !== "planned") card.append(text(doc, "p", "campaign-timeline-readonly", "This milestone is already recorded or is not available for a reach declaration."));
    }
    return card;
  }
  function programCard(program) {
    const chosen = selectedProgramId === program.campaignProgramId;
    const card = element(doc, "section", { className: `campaign-timeline-program ${chosen ? "selected" : ""}` });
    const pick = element(doc, "button", { className: "campaign-timeline-select-program", type: "button", textContent: `Program ${program.campaignProgramId}` });
    pick.addEventListener("click", () => choose(program.campaignProgramId));
    card.append(pick, label(doc, "Map program", show(program.programId)), label(doc, "Recorded status", show(program.status)), label(doc, "Geometry status", show(program.geometryStatus)));
    for (const milestone of (program.milestones ?? []).slice().sort((a, b) => a.sequence - b.sequence || compare(a.milestoneId, b.milestoneId))) card.append(milestoneCard(program, milestone));
    return card;
  }
  function render() {
    if (destroyed) return;
    const children = [text(doc, "p", "campaign-timeline-notice", CAMPAIGN_TIMELINE_PANEL_NOTICE)];
    if (problem) children.push(text(doc, "div", "campaign-timeline-error", problem));
    else if (view.programs === null) children.push(text(doc, "div", "campaign-timeline-unknown", "Campaign facts were not provided; an empty timeline is not assumed."));
    else {
      children.push(label(doc, "Current campaign month", show(view.now?.monthIndex)), label(doc, "Current campaign quarter", show(view.now?.quarterIndex)), label(doc, "Programs", String(view.programs.length)));
      if (!view.programs.length) children.push(text(doc, "div", "campaign-timeline-empty", "No program records are in this supplied report."));
      for (const program of view.programs.slice().sort((a, b) => compare(a.campaignProgramId, b.campaignProgramId))) children.push(programCard(program));
      for (const warning of view.warnings ?? []) children.push(text(doc, "div", "campaign-timeline-warning", warning));
      if (commandError) children.push(text(doc, "div", "campaign-timeline-command-error", commandError));
    }
    container.replaceChildren(...children);
  }
  const api = {
    refresh() { load(); render(); return api.output(); },
    select(programId, milestoneId = null) { choose(programId, milestoneId); return api.output(); },
    clearSelection() { choose(null, null); return api.output(); },
    output() { return { schema: CAMPAIGN_TIMELINE_PANEL_SCHEMA, contractVersion: 1, view: view === null ? null : clone(view), selectedProgramId, selectedMilestoneId, problem, commandError }; },
    destroy() { destroyed = true; container.replaceChildren(); },
  };
  load();
  render();
  return api;
}
