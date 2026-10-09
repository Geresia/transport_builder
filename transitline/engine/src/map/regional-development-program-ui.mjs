// B20-M2. A map-owned regional-program editor panel. It edits only the B20-M1
// document and regenerates its export from host-supplied map facts. It does
// not receive ScenarioRuntime, money, demand, a game clock, or a feasibility
// rule. Reference IDs are statements, never a claim that a connection exists.

import {
  addRegionalDevelopmentMilestone, addRegionalDevelopmentProgram, drawnRegionalDevelopmentProgramsOf,
  newRegionalDevelopmentProgramDoc, removeRegionalDevelopmentMilestone, removeRegionalDevelopmentProgram,
  restoreRegionalDevelopmentProgramDoc, serializeRegionalDevelopmentProgramDoc, updateRegionalDevelopmentMilestone,
  updateRegionalDevelopmentProgram,
} from "./regional-development-program-editor.mjs";
import { buildRegionalDevelopmentProgramExport } from "./regional-development-program.mjs";

export const REGIONAL_DEVELOPMENT_PROGRAM_UI_SCHEMA = "transitline.regional-development-program-ui/1";
export const REGIONAL_DEVELOPMENT_PROGRAM_UI_NOTICE = "This editor records map reference IDs and player statements only. It does not determine connection, cost, demand, service, or approval.";
const clone = (value) => structuredClone(value);
const cmp = (a, b) => String(a).localeCompare(String(b), "en", { numeric: true });
const referenceFields = Object.freeze(["linkedDevelopmentIds", "linkedPlanIds", "linkedStationSiteIds", "linkedServicePlanIds"]);
const asText = (value) => typeof value === "string" && value.trim() ? value.trim() : null;
const element = (doc, tag, properties = {}, ...children) => { const node = doc.createElement(tag); Object.assign(node, properties); node.append(...children); if ("value" in properties) node.value = properties.value; return node; };
const text = (doc, tag, className, value) => element(doc, tag, { className, textContent: value });
const listText = (value) => value === null || value === undefined ? "not stated" : value.length === 0 ? "declared empty" : value.join(", ");

// Blank means not stated. The literal [] means the player's explicit empty
// declaration, which must never be collapsed into blank.
export function parseReferenceList(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return null;
  if (raw === "[]") return [];
  const ids = raw.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (!ids.length || ids.length !== raw.split(",").length) throw new Error("Reference IDs must be comma-separated non-empty IDs, [] or blank");
  return [...new Set(ids)].sort(cmp);
}

export function mountRegionalDevelopmentProgramEditor({ container, pack, getNewTownDevelopmentExport = () => undefined, getMapExport = () => undefined, getStationSites = () => undefined, getServicePlans = () => undefined, onChange = null } = {}) {
  if (!container) throw new Error("A regional development program editor container is required");
  if (!pack?.manifest?.id) throw new Error("A pack with manifest.id is required");
  if (typeof onChange !== "function" && onChange !== null) throw new Error("onChange must be a function or null");
  const doc = container.ownerDocument ?? document;
  let documentValue = newRegionalDevelopmentProgramDoc(pack.manifest.id, pack.manifest.version ?? null);
  let selectedKey = null;
  let warning = null;
  let destroyed = false;
  const sources = () => ({
    newTownDevelopmentExport: getNewTownDevelopmentExport(), mapExport: getMapExport(),
    stationSites: getStationSites(), servicePlans: getServicePlans(),
  });
  const exportOf = () => buildRegionalDevelopmentProgramExport({ pack, programs: drawnRegionalDevelopmentProgramsOf(documentValue), ...sources() });
  const output = () => ({ schema: REGIONAL_DEVELOPMENT_PROGRAM_UI_SCHEMA, contractVersion: 1, document: clone(documentValue), export: exportOf(), selectedKey, warnings: warning === null ? [] : [warning] });
  const changed = () => { render(); onChange?.(output()); };
  const current = () => documentValue.programs.find((program) => program.key === selectedKey && !program.deleted) ?? null;
  const field = (label, className, value, onInput, hint = "") => {
    const input = element(doc, "input", { className, type: "text", value: value ?? "" });
    input.addEventListener("change", () => { try { onInput(input.value); warning = null; changed(); } catch (error) { warning = error instanceof Error ? error.message : String(error); render(); } });
    return element(doc, "label", { className: "regional-program-field" }, text(doc, "span", "", label), input, hint ? text(doc, "small", "regional-program-hint", hint) : text(doc, "small", "regional-program-hint", ""));
  };
  const links = (holder, update) => element(doc, "div", { className: "regional-program-links" }, ...referenceFields.map((name) => field(name, `regional-program-link-${name}`, holder[name] === null ? "" : holder[name]?.length === 0 ? "[]" : holder[name]?.join(", ") ?? "", (value) => update({ [name]: parseReferenceList(value) }), "blank = not stated; [] = declared empty")));
  function milestoneCard(program, milestone) {
    const card = element(doc, "div", { className: "regional-program-milestone" });
    card.append(text(doc, "b", "", `${milestone.sequence}. ${milestone.key}`));
    card.append(field("Name", "regional-program-milestone-name", milestone.name, (value) => updateRegionalDevelopmentMilestone(documentValue, program.key, milestone.key, { name: asText(value) })));
    card.append(field("Target campaign month", "regional-program-target-month", milestone.targetMonth, (value) => updateRegionalDevelopmentMilestone(documentValue, program.key, milestone.key, { targetMonth: value.trim() === "" ? null : Number(value) })));
    card.append(field("Duration months", "regional-program-duration-months", milestone.durationMonths, (value) => updateRegionalDevelopmentMilestone(documentValue, program.key, milestone.key, { durationMonths: value.trim() === "" ? null : Number(value) })));
    card.append(links(milestone, (patch) => updateRegionalDevelopmentMilestone(documentValue, program.key, milestone.key, patch)));
    const remove = element(doc, "button", { className: "regional-program-remove-milestone", type: "button", textContent: "Remove milestone" });
    remove.addEventListener("click", () => { removeRegionalDevelopmentMilestone(documentValue, program.key, milestone.key); changed(); });
    card.append(remove);
    return card;
  }
  function render() {
    if (destroyed) return;
    const root = [text(doc, "p", "regional-program-notice", REGIONAL_DEVELOPMENT_PROGRAM_UI_NOTICE)];
    const programs = documentValue.programs.filter((program) => !program.deleted).slice().sort((a, b) => cmp(a.key, b.key));
    const create = element(doc, "button", { className: "regional-program-add", type: "button", textContent: "Add regional program" });
    create.addEventListener("click", () => { const program = addRegionalDevelopmentProgram(documentValue); selectedKey = program.key; warning = null; changed(); });
    root.push(create, text(doc, "div", "regional-program-count", `Programs: ${programs.length}`));
    if (warning) root.push(text(doc, "div", "regional-program-warning", warning));
    if (!programs.length) root.push(text(doc, "p", "regional-program-empty", "No map program is recorded."));
    for (const program of programs) {
      const select = element(doc, "button", { className: "regional-program-select", type: "button", textContent: `${program.key}${program.key === selectedKey ? " (selected)" : ""}` });
      select.addEventListener("click", () => { selectedKey = program.key; warning = null; render(); });
      root.push(select);
    }
    const program = current();
    if (program) {
      const editor = element(doc, "section", { className: "regional-program-editor" }, text(doc, "h3", "", `Program ${program.key}`));
      editor.append(field("Name", "regional-program-name", program.name, (value) => updateRegionalDevelopmentProgram(documentValue, program.key, { name: asText(value) })));
      editor.append(field("Policy statement", "regional-program-policy", program.playerStatedPolicy, (value) => updateRegionalDevelopmentProgram(documentValue, program.key, { playerStatedPolicy: asText(value) })));
      editor.append(field("Priority", "regional-program-priority", program.playerStatedPriority, (value) => updateRegionalDevelopmentProgram(documentValue, program.key, { playerStatedPriority: value.trim() === "" ? null : Number(value) })));
      editor.append(links(program, (patch) => updateRegionalDevelopmentProgram(documentValue, program.key, patch)));
      const milestone = element(doc, "button", { className: "regional-program-add-milestone", type: "button", textContent: "Add milestone" });
      milestone.addEventListener("click", () => { addRegionalDevelopmentMilestone(documentValue, program.key); changed(); });
      const remove = element(doc, "button", { className: "regional-program-remove", type: "button", textContent: "Remove program" });
      remove.addEventListener("click", () => { removeRegionalDevelopmentProgram(documentValue, program.key); selectedKey = null; changed(); });
      editor.append(milestone, remove);
      for (const item of program.milestones.filter((entry) => !entry.deleted).slice().sort((a, b) => a.sequence - b.sequence || cmp(a.key, b.key))) editor.append(milestoneCard(program, item));
      root.push(editor);
    }
    const exported = exportOf();
    root.push(text(doc, "div", "regional-program-export-summary", `Export programs: ${exported.programs.length}; export warnings: ${exported.warnings.length}`));
    container.replaceChildren(...root);
  }
  const api = {
    output,
    addProgram(value = {}) { const program = addRegionalDevelopmentProgram(documentValue, value); selectedKey = program.key; warning = null; changed(); return clone(program); },
    addMilestone(key = selectedKey, value = {}) { const milestone = addRegionalDevelopmentMilestone(documentValue, key, value); warning = null; changed(); return clone(milestone); },
    select(key) { selectedKey = documentValue.programs.some((program) => !program.deleted && program.key === key) ? key : null; warning = null; render(); return output(); },
    serialize() { return serializeRegionalDevelopmentProgramDoc(documentValue); },
    loadDoc(saved) { const restored = restoreRegionalDevelopmentProgramDoc(saved, pack, { current: documentValue }); if (restored.rejected) { warning = restored.rejected; render(); return output(); } documentValue = restored.document; selectedKey = current()?.key ?? documentValue.programs.find((program) => !program.deleted)?.key ?? null; warning = restored.warnings[0] ?? null; changed(); return output(); },
    refresh() { render(); return output(); },
    destroy() { destroyed = true; container.replaceChildren(); },
  };
  render();
  return api;
}
