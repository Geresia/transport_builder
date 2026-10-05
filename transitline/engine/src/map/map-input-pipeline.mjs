// The B14 map input pipeline, assembled: rail capacity design (M5) -> disruption site (M6) -> service control (M7) -> detour
// service (M10), each an independent browser mount with its own overlay and panel. This module only wires them: the output of
// one stage is the input getter of the next, so the host passes the live engine facts once and reads one combined result.
// It adds no fact of its own and decides nothing: costs, times, whether a train may run, approvals and agreements belong to
// the management engine; the map hands over geometry, the player's spatial choices, and null where nothing was measured.
//
//   const pipeline = mountMapInputPipeline({ canvas, projection, pack, getPlans, getRoutes, getExternalNetworks, getExternalCatalog,
//     getStationSites, getSpatial, getRailCapacityApplication, getDisruptionEvents, onChange });
//   pipeline.output()  ->  { railGeometry, railGeometries, applications, disruptionSites, serviceControls, detour, documents, warnings, ... }
//   pipeline.serialize() / pipeline.loadDoc(text)   one integrated save envelope for the four documents
//
// The rail capacity application (which engine track segment is which map section) is the engine's to build: the host supplies
// it through getRailCapacityApplication; output().applications.needed lists the geometries it has to cover.
import { mountRailCapacityDesign } from "./rail-capacity-ui.mjs";
import { mountRailwayDisruptionSite } from "./railway-disruption-site-ui.mjs";
import { mountRailwayServiceControl } from "./railway-service-control-ui.mjs";
import { mountRailwayDetourService } from "./railway-detour-service-ui.mjs";

export const PIPELINE_UI_EVENT = "transitline:map-input-pipeline";
export const PIPELINE_DOC_SCHEMA = "transitline.map-input-pipeline-doc/1";
export const PIPELINE_DOC_VERSION = 1;
// the four documents of the envelope, in the order they depend on each other
export const PIPELINE_STAGES = Object.freeze(["railCapacity", "disruptionSite", "serviceControl", "detour"]);

// The four panels each default to their own corner; together they would overlap on a short window, so the assembled
// pipeline stacks them: rail design and disruption site on the left, service control and detour on the right.
const STYLE_ID = "transitline-map-input-pipeline-style";
const LAYOUT_CSS = `
.tl-rail-panel,.tl-disruption-panel,.tl-control-panel,.tl-detour-panel{max-height:36vh!important;overflow:auto!important}
.tl-rail-panel,.tl-control-panel{top:64px!important;bottom:auto!important}
.tl-disruption-panel,.tl-detour-panel{bottom:64px!important;top:auto!important}
`;

const clone = (v) => structuredClone(v);
const list = (v, key) => (Array.isArray(v) ? v : v && Array.isArray(v[key]) ? v[key] : v ? [v] : []);
const tagged = (stage, items) => (items ?? []).map((w) => ({ ...w, stage }));
const note = (code, detail) => ({ code, stage: "pipeline", detail });

export function mountMapInputPipeline({
  canvas, projection, pack, getPlans, getRoutes, getExternalNetworks, getExternalCatalog, getStationSites, getSpatial = () => null,
  getRailCapacityApplication, getDisruptionEvents, onChange = () => {}, enabled = true, autoRefreshMs = 250,
}) {
  const packId = pack.manifest?.id ?? "pack";
  const latest = { railCapacity: null, disruptionSite: null, serviceControl: null, detour: null };
  const stages = {};
  const notes = [];
  let depth = 0;
  let ready = false;

  function applicationsNow() {
    const supplied = list(getRailCapacityApplication?.(), "applications");
    const geometries = latest.railCapacity?.railGeometries ?? [];
    const covered = (g) => supplied.some((a) => a.railGeometryId === g.railGeometryId && a.railGeometryRevision === g.railGeometryRevision);
    return {
      supplied,
      needed: geometries.map((g) => ({ railGeometryId: g.railGeometryId, railGeometryRevision: g.railGeometryRevision, sectionIds: (g.sections ?? []).map((s) => s.sectionId) })),
      missing: geometries.filter((g) => !covered(g)).map((g) => g.railGeometryId),
    };
  }

  function outputNow() {
    const [m5, m6, m7, m10] = PIPELINE_STAGES.map((s) => latest[s]);
    return {
      railGeometry: m5?.export ?? null,
      railGeometries: m5?.railGeometries ?? [],
      applications: applicationsNow(),
      disruptionSites: m6?.export ?? null,
      serviceControls: m7?.export ?? null,
      detour: m10?.export ?? null,
      documents: { railCapacity: m5?.document ?? null, disruptionSite: m6?.document ?? null, serviceControl: m7?.document ?? null, detour: m10?.document ?? null },
      selected: { railCapacity: m5?.selectedKey ?? null, disruptionSite: m6?.selectedEventId ?? null, serviceControl: m7?.selectedEventId ?? null, detour: m10?.selectedPlan ?? null },
      warnings: [...notes, ...tagged("railCapacity", m5?.warnings), ...tagged("disruptionSite", m6?.warnings), ...tagged("serviceControl", m7?.warnings), ...tagged("detour", m10?.warnings)],
    };
  }

  // One burst of changes (a stage changed and the stages after it followed) reaches the host as a single onChange.
  function publish() {
    if (!ready) return;
    const out = outputNow();
    onChange(out);
    canvas.dispatchEvent(new CustomEvent(PIPELINE_UI_EVENT, { detail: out }));
  }
  const heard = (name, next) => (out) => {
    latest[name] = out;
    depth += 1;
    try { next?.(); } finally { depth -= 1; if (depth === 0) publish(); }
  };

  const doc = canvas.ownerDocument;
  if (!doc.getElementById(STYLE_ID)) { const s = doc.createElement("style"); s.id = STYLE_ID; s.textContent = LAYOUT_CSS; doc.head.append(s); }
  const common = { canvas, projection, pack, getSpatial, enabled, autoRefreshMs };
  stages.railCapacity = mountRailCapacityDesign({
    ...common, getPlans, getRoutes, getExternalNetworks, getStationSites, onChange: heard("railCapacity", () => stages.disruptionSite?.refresh()),
  });
  stages.disruptionSite = mountRailwayDisruptionSite({
    ...common, getRailGeometry: () => latest.railCapacity?.railGeometries ?? [], getRailCapacityApplication, getDisruptionEvents, onChange: heard("disruptionSite", () => stages.serviceControl?.refresh()),
  });
  stages.serviceControl = mountRailwayServiceControl({
    ...common, getRailGeometry: () => latest.railCapacity?.railGeometries ?? [], getRailCapacityApplication, getDisruptionSites: () => latest.disruptionSite?.sites ?? [],
    getThroughRoutes: getRoutes, getExternalNetworks, getStationSites, onChange: heard("serviceControl", () => stages.detour?.refresh()),
  });
  stages.detour = mountRailwayDetourService({
    ...common, getRailGeometry: () => latest.railCapacity?.railGeometries ?? [], getRailCapacityApplication, getDisruptionSites: () => latest.disruptionSite?.sites ?? [],
    getServiceControls: () => latest.serviceControl?.controls ?? [], getThroughRoutes: getRoutes, getExternalCatalog, getExternalNetworks, getStationSites, onChange: heard("detour"),
  });
  ready = true;
  publish();

  // The integrated save: the four stage documents (each stage's own serialize() text) in one envelope.
  const serialize = () => JSON.stringify({
    schema: PIPELINE_DOC_SCHEMA, version: PIPELINE_DOC_VERSION, packId, packVersion: pack.manifest?.version ?? null,
    stages: Object.fromEntries(PIPELINE_STAGES.map((s) => [s, JSON.parse(stages[s].serialize())])),
  });

  // Replaces the stage documents the envelope carries. An unreadable envelope, another version or another pack's envelope is
  // refused whole and leaves every stage untouched; a stage the envelope lacks is left as it is.
  function loadDoc(source) {
    if (source === null || source === undefined) return [];
    let parsed;
    try { parsed = typeof source === "string" ? JSON.parse(source) : clone(source); } catch { parsed = null; }
    const refuse = (code) => { const n = [note(code)]; notes.push(...n); return n; };
    if (!parsed || typeof parsed !== "object" || parsed.schema !== PIPELINE_DOC_SCHEMA) return refuse("map-input-pipeline-doc-unreadable");
    if (parsed.version !== PIPELINE_DOC_VERSION) return refuse("map-input-pipeline-doc-version");
    if (parsed.packId !== packId) return refuse("map-input-pipeline-doc-other-pack");
    const result = [];
    if (parsed.packVersion !== (pack.manifest?.version ?? null)) result.push(note("pack-version-mismatch", { saved: parsed.packVersion ?? null, current: pack.manifest?.version ?? null }));
    depth += 1;
    try {
      for (const s of PIPELINE_STAGES) {
        const part = parsed.stages?.[s];
        if (part === undefined || part === null) continue;
        result.push(...tagged(s, stages[s].loadDoc(part)));
      }
    } finally { depth -= 1; }
    refresh();
    notes.push(...result);
    return result;
  }

  function refresh() {
    depth += 1;
    try { for (const s of PIPELINE_STAGES) stages[s].refresh(); } finally { depth -= 1; if (depth === 0) publish(); }
  }

  return {
    output: outputNow, stages, serialize, loadDoc, refresh,
    save() { for (const s of PIPELINE_STAGES) stages[s].save(); },
    setEnabled(value) { for (const s of PIPELINE_STAGES) stages[s].setEnabled(value); },
    destroy() { doc.getElementById(STYLE_ID)?.remove(); for (const s of [...PIPELINE_STAGES].reverse()) stages[s].destroy(); },
  };
}
