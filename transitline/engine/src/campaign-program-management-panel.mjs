// B20-C1 lifecycle command surface.  It is deliberately separate from the
// timeline: target dates remain display-only while each lifecycle transition is
// an explicit player click against the current B20 map document.

export const CAMPAIGN_PROGRAM_MANAGEMENT_PANEL_SCHEMA = "transitline.campaign-program-management-panel/1";

const clone = (value) => structuredClone(value);
const text = (value) => typeof value === "string" && value.trim() ? value.trim() : null;
const compare = (a, b) => String(a).localeCompare(String(b));
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const PROGRAM_SCHEMA = "transitline.regional-development-program/1";
const REQUIRED = Object.freeze([
  "campaignProgramReport", "assessCampaignProgram", "draftCampaignProgram",
  "adoptCampaignProgram", "monitorCampaignProgram", "completeCampaignProgram",
  "delayCampaignProgram", "resumeCampaignProgram", "cancelCampaignProgram",
]);
const STYLE_ID = "transitline-campaign-program-management-panel-style";
const CSS = ".cpm{font:12px/1.5 system-ui,sans-serif}.cpm-card{margin:6px 0;padding:7px;border:1px solid #2a2f3a;border-radius:6px}.cpm-map{border-left:3px solid #4cc9f0}.cpm-error{color:#ff6b6b;white-space:pre-wrap}.cpm-note{color:#aab1c0}.cpm-actions{display:flex;flex-wrap:wrap;gap:5px;margin:6px 0}.cpm-blocker{display:inline-block;margin:2px;padding:1px 4px;border:1px solid #f59e0b;color:#f59e0b;border-radius:3px}.cpm-reason{display:block;margin:5px 0}";

function assertRuntime(runtime) {
  for (const name of REQUIRED) if (typeof runtime?.[name] !== "function") throw new Error(`runtime.${name}() is required`);
}
function geometryList(value) {
  const programs = Array.isArray(value) ? value : Array.isArray(value?.programs) ? value.programs : [];
  const seen = new Set();
  return programs.filter((geometry) => geometry?.schema === PROGRAM_SCHEMA && typeof geometry?.programId === "string" && geometry.programId.trim())
    .filter((geometry) => !seen.has(geometry.programId) && seen.add(geometry.programId))
    .slice().sort((a, b) => compare(a.programId, b.programId));
}
function el(doc, tag, props = {}, ...children) { const node = doc.createElement(tag); Object.assign(node, props); node.append(...children); return node; }
function label(doc, name, value) { return el(doc, "div", { className: "cpm-fact" }, el(doc, "span", { className: "cpm-label", textContent: name }), el(doc, "span", { className: "cpm-value", textContent: value })); }
function show(value) { return value === null || value === undefined ? "unknown" : Array.isArray(value) ? (value.length ? value.join(", ") : "empty list") : String(value); }

export function mountCampaignProgramManagementPanel({ container, runtime, getProgramGeometry, onChange = () => {} } = {}) {
  if (!container) throw new Error("A campaign program management container is required");
  assertRuntime(runtime);
  if (typeof getProgramGeometry !== "function") throw new Error("getProgramGeometry() is required");
  if (typeof onChange !== "function") throw new Error("onChange must be a function");
  const doc = container.ownerDocument ?? document;
  if (doc.head && doc.getElementById && !doc.getElementById(STYLE_ID)) doc.head.append(Object.assign(doc.createElement("style"), { id: STYLE_ID, textContent: CSS }));
  let view = null;
  let notice = null;
  let reasons = {};
  let destroyed = false;

  const button = (name, className, action, disabled = false) => {
    const node = el(doc, "button", { type: "button", className, textContent: name, disabled });
    node.addEventListener("click", action); return node;
  };
  // Never use the last rendered geometry for a command.  The player can edit a
  // program while this panel is open; forward transitions must see that newer
  // revision and let the engine refuse it as stale.
  const currentGeometryOf = (programId) => geometryList(getProgramGeometry()).find((item) => item.programId === programId) ?? null;
  const recheck = (record, geometry) => runtime.assessCampaignProgram({ id: record.id, geometry });
  function collect() {
    let source = null; let sourceError = null;
    try { source = geometryList(getProgramGeometry()); } catch (error) { sourceError = error instanceof Error ? error.message : String(error); }
    const records = runtime.campaignProgramReport().slice().sort((a, b) => compare(a.id, b.id)).map((record) => {
      const geometry = source?.find((item) => item.programId === record.programId) ?? null;
      let assessment = null; let assessmentError = null;
      try { assessment = runtime.assessCampaignProgram({ id: record.id, geometry }); } catch (error) { assessmentError = error instanceof Error ? error.message : String(error); }
      return { record: clone(record), geometry: geometry === null ? null : clone(geometry), assessment: assessment === null ? null : clone(assessment), assessmentError };
    });
    return { schema: CAMPAIGN_PROGRAM_MANAGEMENT_PANEL_SCHEMA, contractVersion: 1, geometries: source === null ? null : clone(source), geometryError: sourceError, records, notice: notice === null ? null : clone(notice) };
  }
  function invoke(kind, record = null, mapProgramId = null) {
    if (destroyed) return;
    try {
      const geometry = mapProgramId !== null ? currentGeometryOf(mapProgramId) : (record === null ? null : currentGeometryOf(record.programId));
      let result;
      if (kind === "draft") {
        if (!geometry) throw new Error("program-geometry-not-found");
        const assessed = runtime.assessCampaignProgram({ geometry });
        if (assessed?.geometry?.status !== "current") throw new Error(["program-geometry-not-current", ...(assessed?.geometry?.reasons ?? [])].join(", "));
        result = runtime.draftCampaignProgram({ geometry });
      } else {
        const checked = recheck(record, geometry);
        const transition = checked?.transitions?.[kind] ?? null;
        if (!transition?.allowed) throw new Error((transition?.blockers ?? ["transition-not-allowed"]).join(", "));
        if (kind === "adopt") result = runtime.adoptCampaignProgram(record.id, { geometry });
        else if (kind === "monitor") result = runtime.monitorCampaignProgram(record.id, { geometry });
        else if (kind === "complete") result = runtime.completeCampaignProgram(record.id, { geometry });
        else if (kind === "resume") result = runtime.resumeCampaignProgram(record.id, { geometry });
        else if (kind === "delay") result = runtime.delayCampaignProgram(record.id, text(reasons[record.id]));
        else if (kind === "cancel") result = runtime.cancelCampaignProgram(record.id, text(reasons[record.id]));
        else throw new Error("campaign-program-command-unknown");
      }
      notice = { type: "done", kind, id: result?.id ?? null };
      refresh();
      onChange({ kind: "command", action: kind, id: notice.id, programId: result?.programId ?? record?.programId ?? geometry?.programId ?? null });
    } catch (error) {
      notice = { type: "error", kind, message: error instanceof Error ? error.message : String(error) };
      // A refused command is still a fresh read-only view: expose its error in
      // output() as well as in the DOM, without changing runtime state.
      view = collect();
      render();
    }
  }
  function mapCard(geometry) {
    const bound = view.records.filter((item) => item.record.programId === geometry.programId);
    const card = el(doc, "section", { className: "cpm-card cpm-map" }, label(doc, "Map program", geometry.programId), label(doc, "Map revision", show(geometry.programRevision)), label(doc, "Map active", show(geometry.active)), label(doc, "Lifecycle records", String(bound.length)));
    if (!bound.length) card.append(button("Create lifecycle draft", "cpm-draft", () => invoke("draft", null, geometry.programId)));
    else card.append(el(doc, "div", { className: "cpm-note", textContent: "A lifecycle record already exists for this map program. Existing records stay visible for audit; this panel does not infer or merge records." }));
    return card;
  }
  function recordCard(item) {
    const record = item.record; const assessment = item.assessment;
    const card = el(doc, "section", { className: "cpm-card" }, label(doc, "Campaign record", record.id), label(doc, "Map program", record.programId), label(doc, "Status", show(record.status)), label(doc, "Map geometry", show(assessment?.geometry?.status ?? item.assessmentError)), label(doc, "Map revision", show(record.programRevision)));
    if (item.geometry === null) card.append(el(doc, "div", { className: "cpm-error", textContent: "Current map program geometry was not supplied; forward transitions remain unavailable." }));
    for (const reason of assessment?.geometry?.reasons ?? []) card.append(el(doc, "span", { className: "cpm-blocker", textContent: reason }));
    const reason = el(doc, "input", { type: "text", className: "cpm-reason", value: reasons[record.id] ?? "", placeholder: "Delay/cancel reason (optional)" });
    reason.addEventListener("input", () => { reasons[record.id] = reason.value; });
    card.append(reason);
    const actions = el(doc, "div", { className: "cpm-actions" });
    for (const [kind, title] of [["adopt", "Adopt"], ["monitor", "Start monitoring"], ["complete", "Complete"], ["delay", "Delay"], ["resume", "Resume"], ["cancel", "Cancel"]]) {
      const transition = assessment?.transitions?.[kind] ?? null;
      actions.append(button(title, `cpm-${kind}`, () => invoke(kind, record), !transition?.allowed));
    }
    card.append(actions);
    for (const [kind, transition] of Object.entries(assessment?.transitions ?? {})) if (!transition.allowed) for (const blocker of transition.blockers ?? []) card.append(el(doc, "span", { className: "cpm-blocker", textContent: `${kind}: ${blocker}` }));
    return card;
  }
  function render() {
    if (destroyed) return;
    const children = [el(doc, "p", { className: "cpm-note", textContent: "Campaign lifecycle commands are explicit player actions. Map target dates do not adopt, monitor, complete, delay, resume, or cancel a program automatically." })];
    if (view.geometryError) children.push(el(doc, "div", { className: "cpm-error", textContent: `Map input error: ${view.geometryError}` }));
    else if (view.geometries === null) children.push(el(doc, "div", { className: "cpm-error", textContent: "Map program geometry is unknown." }));
    else children.push(...view.geometries.map(mapCard));
    children.push(...view.records.map(recordCard));
    if (!view.geometries?.length && !view.records.length) children.push(el(doc, "div", { className: "cpm-note", textContent: "No map programs or lifecycle records are available." }));
    if (notice) children.push(el(doc, "div", { className: notice.type === "error" ? "cpm-error" : "cpm-note", textContent: notice.type === "error" ? `Runtime error: ${notice.message}` : `${notice.kind} completed: ${notice.id ?? "recorded"}` }));
    container.replaceChildren(...children);
  }
  function refresh() { view = collect(); render(); return api.output(); }
  const api = { refresh, output() { return clone(view); }, destroy() { destroyed = true; container.replaceChildren(); } };
  refresh();
  return api;
}
