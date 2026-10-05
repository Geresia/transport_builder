// B14-M12: the explicit boundary between a player-drawn RailCapacityGeometry and an
// operational line. This panel intentionally does not match lines itself: the player chooses
// both sides and ScenarioRuntime.applyRailCapacityGeometry validates the station/track mapping.

const GEOMETRY_SCHEMA = "transitline.rail-capacity-geometry/1";
const clone = (value) => structuredClone(value);
const key = (value) => String(value);

const currentGeometry = (value) => value?.schema === GEOMETRY_SCHEMA
  && value.contractVersion === 1 && value?.revision?.state === "current"
  && typeof value.railGeometryId === "string" && typeof value.railGeometryRevision === "string";

export function buildRailCapacityApplicationView({ geometries = [], operationalLines = [], applications = [] } = {}) {
  return {
    geometries: geometries.filter(currentGeometry).map((geometry) => ({
      id: geometry.railGeometryId,
      revision: geometry.railGeometryRevision,
      sectionCount: Array.isArray(geometry.sections) ? geometry.sections.length : 0,
    })),
    operationalLines: operationalLines.filter((line) => typeof line?.id === "string" && Array.isArray(line.trackSegmentIds)).map((line) => ({
      id: line.id,
      name: typeof line.name === "string" && line.name ? line.name : line.id,
      trackSegmentCount: line.trackSegmentIds.length,
      stationCount: Array.isArray(line.stationIds) ? line.stationIds.length : 0,
      suspended: line.suspended === true,
    })),
    applications: applications.map((application) => ({
      operationalLineId: application.operationalLineId,
      railGeometryId: application.railGeometryId,
      railGeometryRevision: application.railGeometryRevision,
      sectionCount: Array.isArray(application.sections) ? application.sections.length : 0,
    })),
  };
}

const node = (doc, tag, props = {}, ...children) => {
  const element = doc.createElement(tag);
  Object.assign(element, props);
  element.append(...children);
  if ("value" in props) element.value = props.value;
  return element;
};
const label = (doc, title, control) => node(doc, "label", { className: "rail-capacity-apply-field" }, node(doc, "span", { textContent: title }), control);
const notice = (doc, className, text) => node(doc, "p", { className, textContent: text });
const describe = (line) => `${line.name} · ${line.trackSegmentCount} track sections · ${line.stationCount} stations${line.suspended ? " · suspended" : ""}`;

export function mountRailCapacityApplicationPanel({ container, runtime, getRailGeometries = () => [], onChange = () => {} } = {}) {
  if (!container) throw new Error("A rail-capacity application container is required");
  for (const method of ["applyRailCapacityGeometry", "railCapacityApplicationReport", "operationalLineReport"]) {
    if (typeof runtime?.[method] !== "function") throw new Error(`A ScenarioRuntime with ${method} is required`);
  }
  const doc = container.ownerDocument ?? document;
  const form = { geometryId: null, lineId: null };
  let error = null;
  let applied = null;

  function viewNow() {
    return buildRailCapacityApplicationView({
      geometries: getRailGeometries() ?? [],
      operationalLines: runtime.operationalLineReport(),
      applications: runtime.railCapacityApplicationReport(),
    });
  }

  function refresh() {
    const view = viewNow();
    if (!view.geometries.some((entry) => entry.id === form.geometryId)) form.geometryId = view.geometries[0]?.id ?? null;
    if (!view.operationalLines.some((entry) => entry.id === form.lineId)) form.lineId = view.operationalLines[0]?.id ?? null;
    const children = [notice(doc, "rail-capacity-apply-notice", "Map rail design is applied only after you choose the operating line. The engine checks station and track correspondence; this panel never guesses it.")];
    if (!view.geometries.length) children.push(notice(doc, "rail-capacity-apply-empty", "No current rail-capacity design exists on the map."));
    if (!view.operationalLines.length) children.push(notice(doc, "rail-capacity-apply-empty", "No operational line with track sections is available."));
    if (view.geometries.length && view.operationalLines.length) {
      const geometrySelect = node(doc, "select", { value: form.geometryId }, ...view.geometries.map((entry) => node(doc, "option", { value: entry.id, textContent: `${entry.id} · ${entry.sectionCount} sections` })));
      geometrySelect.addEventListener("change", () => { form.geometryId = geometrySelect.value; error = null; applied = null; refresh(); });
      const lineSelect = node(doc, "select", { value: form.lineId }, ...view.operationalLines.map((entry) => node(doc, "option", { value: entry.id, textContent: describe(entry) })));
      lineSelect.addEventListener("change", () => { form.lineId = lineSelect.value; error = null; applied = null; refresh(); });
      const apply = node(doc, "button", { type: "button", textContent: "Apply rail design to line" });
      apply.addEventListener("click", () => {
        const geometry = (getRailGeometries() ?? []).find((entry) => currentGeometry(entry) && entry.railGeometryId === form.geometryId);
        if (!geometry || !form.lineId) return;
        try {
          applied = runtime.applyRailCapacityGeometry(form.lineId, clone(geometry));
          error = null;
          onChange(clone(applied));
        } catch (cause) {
          applied = null;
          error = cause instanceof Error ? cause.message : String(cause);
        }
        refresh();
      });
      children.push(label(doc, "Map design", geometrySelect), label(doc, "Operating line", lineSelect), apply);
    }
    if (error) children.push(notice(doc, "rail-capacity-apply-error", error));
    if (applied) children.push(notice(doc, "rail-capacity-apply-ok", `Applied ${applied.railGeometryId} revision ${applied.railGeometryRevision} to ${applied.operationalLineId}.`));
    if (view.applications.length) {
      children.push(node(doc, "strong", { className: "rail-capacity-apply-heading", textContent: "Applied rail designs" }));
      for (const application of view.applications) children.push(node(doc, "div", { className: "rail-capacity-apply-row", textContent: `${application.operationalLineId} · ${application.railGeometryId} · ${application.sectionCount} sections` }));
    }
    container.replaceChildren(...children);
  }

  refresh();
  return { refresh };
}
