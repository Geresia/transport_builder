// Management panel that turns the player's M7 service-control choice into a real railway control order (B14-M13).
// It reads the M7 output (RailwayServiceControlGeometry + the player's selection) and calls only three ScenarioRuntime
// methods. It never judges, prices or times anything: whether a suspension maps to operating track, whether a turnback
// can serve a boundary and whether an unknown physical attachment may be accepted are the engine's call, and an engine
// error is shown verbatim. Nothing is saved here; the control orders in the integrated save are the only truth.
const CONTROL_SCHEMA = "transitline.railway-service-control-geometry/1";
const key = (value) => String(value);
const ONGOING = ["active", "responding"];

export const MAP_NOTICE = "지도는 후보와 접속 사실(true/false/null)만 보여 줍니다. 비용·시간·운행 가능 여부·우회 효과는 계산하지 않으며, 최종 판정은 엔진이 합니다.";
export const SCOPE_NOTICE = "이 패널이 발령하는 것은 부분운휴와 회차입니다. 우회·대피 선택은 보존만 되며 여기서 실행하지 않습니다.";
export const ATTACHMENT_LABELS = Object.freeze({ true: "● 접속 확인(true)", false: "✕ 물리적으로 분리(false)", null: "? 접속 미확인(null)" });
const ORDER_STATUS = Object.freeze({ active: "발령 중", ended: "종료" });
const KIND_LABELS = Object.freeze({ "partial-suspension": "부분운휴", "short-turn": "회차" });
const WARNING_TEXT = Object.freeze({
  "control-geometry-missing": "이 장애의 관제 후보(M7)가 없습니다.",
  "control-geometry-invalid": "관제 후보가 현재 형식(v1)이 아닙니다.",
  "event-unknown": "엔진에 없는 장애 이벤트입니다.",
  "event-not-ongoing": "장애가 이미 끝났습니다. 발령할 수 없습니다.",
  "selection-missing": "부분운휴 후보를 선택하지 않았습니다.",
  "selection-stale": "선택한 후보가 현재 관제 후보에 더는 없습니다.",
  "selection-outdated": "선택이 이전 revision의 관제 후보 위에서 이루어졌습니다. 지도에서 다시 확인해야 합니다.",
});

const known = (v) => (Number.isFinite(v) ? v : null);
const state = (value) => (value === true ? "true" : value === false ? "false" : "null");
const listOf = (value) => (Array.isArray(value) ? value : []);
const ids = (value) => listOf(value).map((entry) => key(entry?.candidateId ?? entry));

const isCurrentControl = (c) => c?.schema === CONTROL_SCHEMA && c.contractVersion === 1
  && typeof c.eventId === "string" && typeof c.controlGeometryId === "string" && typeof c.controlGeometryRevision === "string";

function candidateView(kind, candidate) {
  if (kind === "partialSuspension") {
    return { id: key(candidate.candidateId), startStationId: key(candidate.startStationId), endStationId: key(candidate.endStationId), suspendedSections: listOf(candidate.suspendedSectionIds).length, suspendedLengthMeters: known(candidate.suspendedLengthMeters) };
  }
  return { id: key(candidate.candidateId), stationId: key(candidate.stationId), attachment: state(candidate.physicalAttachment), hasTerminal: Boolean(candidate.terminalResourceId) };
}

// Pure presentation state of the controls the map offers, each with the player's current choice resolved against the
// current geometry. Candidates the geometry no longer offers (or chose on an older revision) become warnings, never guesses.
export function buildRailwayServiceControlView({ controls = [], selections = {}, document = null, events = [] } = {}) {
  const docEntries = new Map(listOf(document?.controls).map((entry) => [key(entry.eventId), entry]));
  const eventById = new Map(events.map((event) => [key(event.id), event]));
  const eventIds = [...new Set([...controls.map((c) => key(c?.eventId)), ...Object.keys(selections ?? {})])].filter((id) => id !== "undefined");
  return eventIds.map((eventId) => {
    const control = controls.find((c) => key(c?.eventId) === eventId) ?? null;
    const chosen = selections?.[eventId] ?? {};
    const event = eventById.get(eventId) ?? null;
    const warnings = [];
    if (!control) warnings.push("control-geometry-missing");
    else if (!isCurrentControl(control)) warnings.push("control-geometry-invalid");
    if (!event) warnings.push("event-unknown");
    else if (!ONGOING.includes(event.status)) warnings.push("event-not-ongoing");
    const usable = control && isCurrentControl(control);
    const resolve = (kind, list) => ids(chosen[kind]).map((id) => {
      const candidate = usable ? listOf(control[list]).find((c) => key(c.candidateId) === id) : null;
      if (!candidate) { if (usable) warnings.push("selection-stale"); return null; }
      const designedOn = listOf(docEntries.get(eventId)?.selected?.[kind]).find((s) => key(s.candidateId) === id)?.designedControlGeometryRevision;
      if (designedOn !== undefined && key(designedOn) !== key(control.controlGeometryRevision)) warnings.push("selection-outdated");
      return candidateView(kind, candidate);
    }).filter(Boolean);
    const suspensions = resolve("partialSuspension", "partialSuspensionCandidates");
    const turnbacks = resolve("turnback", "turnbackCandidates");
    if (usable && !ids(chosen.partialSuspension).length) warnings.push("selection-missing");
    return {
      eventId, controlGeometryId: usable ? key(control.controlGeometryId) : null, controlGeometryRevision: usable ? key(control.controlGeometryRevision) : null,
      lineId: control?.operationalLineId ?? event?.lineId ?? null, eventStatus: event?.status ?? null,
      suspensions, turnbacks, unsupportedCount: ids(chosen.detour).length + ids(chosen.evacuation).length,
      warnings: [...new Set(warnings)], hasUnknownAttachment: turnbacks.some((t) => t.attachment === "null"),
      issuable: Boolean(usable) && !warnings.length,
    };
  });
}

const message = (error) => (error instanceof Error ? error.message : String(error));
// value is applied after the children: a <select> ignores a value whose <option> does not exist yet
function el(doc, tag, props = {}, ...kids) { const node = doc.createElement(tag); Object.assign(node, props); node.append(...kids); if ("value" in props) node.value = props.value; return node; }
const text = (doc, tag, className, value) => el(doc, tag, { className, textContent: value });
const metric = (doc, label, value) => el(doc, "div", { className: "control-metric" }, text(doc, "span", "", label), text(doc, "b", "", value));
const list = (values) => (values.length ? values.join(", ") : "없음");

export function mountRailwayServiceControlManagementPanel({ container, runtime, getServiceControlOutput = () => null, onChange = () => {} } = {}) {
  if (!container) throw new Error("A railway service-control management container is required");
  for (const method of ["issueRailwayControlSelection", "railwayControlOrderReport", "railwayDisruptionReport"]) {
    if (typeof runtime?.[method] !== "function") throw new Error(`A ScenarioRuntime with ${method} is required`);
  }
  const doc = container.ownerDocument ?? document;
  // Form state lives only in this closure; engine facts and the map output are re-read on every refresh.
  const form = { eventId: null, confirmKey: null, confirmUnknown: false };
  let error = null;
  let notice = null;

  const output = () => getServiceControlOutput() ?? {};
  const controls = () => listOf(output().controls ?? output().export?.controls);
  const selections = () => output().selections ?? {};
  const viewNow = () => buildRailwayServiceControlView({ controls: controls(), selections: selections(), document: output().document ?? null, events: listOf(runtime.railwayDisruptionReport()?.events) });
  const request = (view) => {
    const control = controls().find((c) => key(c?.eventId) === view.eventId);
    return {
      eventId: view.eventId, controlGeometry: structuredClone(control), controlGeometryRevision: control.controlGeometryRevision,
      selection: structuredClone(selections()[view.eventId] ?? {}),
      // Only an unknown attachment can be acknowledged, and only for the choice the box was ticked on.
      confirmUnknownPhysicalAttachment: view.hasUnknownAttachment && form.confirmUnknown,
    };
  };

  function refresh() {
    const views = viewNow();
    const orders = runtime.railwayControlOrderReport();
    if (!views.some((v) => v.eventId === form.eventId)) { form.eventId = views[0]?.eventId ?? null; error = null; notice = null; }
    const selected = views.find((v) => v.eventId === form.eventId) ?? null;
    // An acknowledgement belongs to one exact choice; any other choice starts unacknowledged.
    const confirmKey = selected ? JSON.stringify([selected.eventId, selected.controlGeometryRevision, selected.suspensions.map((s) => s.id), selected.turnbacks.map((t) => t.id)]) : null;
    if (confirmKey !== form.confirmKey) { form.confirmKey = confirmKey; form.confirmUnknown = false; }

    const children = [text(doc, "p", "control-notice", MAP_NOTICE), text(doc, "p", "control-notice", SCOPE_NOTICE)];
    if (!views.length) children.push(text(doc, "p", "control-empty", "지도에서 확정된 관제 후보(M7)가 없습니다. 진행 중인 장애를 고르고 부분운휴·회차 후보를 선택하면 여기서 발령할 수 있습니다."));
    else children.push(...controlSection(views, selected));
    children.push(...orderSection(orders));
    container.replaceChildren(...children);
  }

  function controlSection(views, selected) {
    const nodes = [];
    const pick = el(doc, "select", { value: form.eventId }, ...views.map((v) => el(doc, "option", { value: v.eventId, textContent: `${v.eventId}${v.lineId === null ? "" : ` · 노선 ${v.lineId}`}` })));
    pick.addEventListener("change", () => { form.eventId = pick.value; error = null; notice = null; refresh(); });
    nodes.push(el(doc, "label", { className: "control-field" }, text(doc, "span", "", "장애 이벤트"), pick));
    nodes.push(el(doc, "div", { className: "control-metrics" }, metric(doc, "이벤트 상태", selected.eventStatus ?? "미상"), metric(doc, "관제 geometry", selected.controlGeometryId ?? "없음"), metric(doc, "revision", selected.controlGeometryRevision ?? "없음")));
    for (const code of selected.warnings) nodes.push(text(doc, "div", `control-warning ${code}`, WARNING_TEXT[code] ?? code));

    nodes.push(text(doc, "div", "control-label", `부분운휴 선택 ${selected.suspensions.length}개 (정확히 1개여야 합니다 · 엔진이 최종 검증)`));
    for (const s of selected.suspensions) nodes.push(text(doc, "div", "control-selected", `${s.id} · ${s.startStationId} ~ ${s.endStationId} · 구간 ${s.suspendedSections} · 운휴 길이 ${s.suspendedLengthMeters === null ? "미상" : `${(s.suspendedLengthMeters / 1000).toFixed(1)} km`}`));
    nodes.push(text(doc, "div", "control-label", `회차 선택 ${selected.turnbacks.length}개`));
    for (const t of selected.turnbacks) nodes.push(text(doc, "div", `control-selected attachment-${t.attachment}`, `${t.id} · ${t.stationId} · ${ATTACHMENT_LABELS[t.attachment]}${t.hasTerminal ? "" : " · 종착 자료 없음"}`));
    if (selected.unsupportedCount) nodes.push(text(doc, "div", "control-note", `우회·대피 선택 ${selected.unsupportedCount}개는 보존만 되며 발령에 쓰이지 않습니다.`));

    if (selected.hasUnknownAttachment) {
      const box = el(doc, "input", { type: "checkbox", checked: form.confirmUnknown });
      box.addEventListener("change", () => { form.confirmUnknown = box.checked; error = null; notice = null; refresh(); });
      nodes.push(el(doc, "label", { className: "control-check" }, box, text(doc, "span", "", "접속이 확인되지 않은 회차 후보(null)를 선택했음을 인지함")));
    }
    const issue = el(doc, "button", { type: "button", textContent: "관제명령 발령", disabled: !selected.issuable });
    issue.addEventListener("click", () => {
      if (!selected.issuable) return;
      try {
        const order = runtime.issueRailwayControlSelection(request(selected));
        error = null; notice = `발령됨 · ${order.id}`;
        refresh();
        onChange();
      } catch (e) { notice = null; error = message(e); refresh(); }
    });
    nodes.push(el(doc, "div", { className: "control-actions" }, issue));
    if (error) nodes.push(text(doc, "div", "control-error", error));
    if (notice) nodes.push(text(doc, "div", "control-notice", notice));
    return nodes;
  }

  function orderSection(orders) {
    const nodes = [text(doc, "strong", "control-section", `관제명령 ${orders.length}건`)];
    for (const o of orders) {
      const services = listOf(o.retainedServices).length ? o.retainedServices.map((s) => listOf(s.stationIds).join("→")) : [listOf(o.retainedStationIds).join("→")];
      nodes.push(el(doc, "article", { className: `control-order ${o.status}` },
        text(doc, "b", "", `${ORDER_STATUS[o.status] ?? o.status} · ${KIND_LABELS[o.kind] ?? o.kind} · ${o.id}`),
        el(doc, "div", { className: "control-metrics" }, metric(doc, "이벤트", key(o.eventId)), metric(doc, "노선", key(o.lineId)), metric(doc, "잔존 운행", services.join(" / ")),
          metric(doc, "운휴 선로", list(listOf(o.suspendedTrackSegmentIds))), metric(doc, "제외 역", list(listOf(o.omittedStationIds))),
          metric(doc, "발령", `${o.issuedAtMinute}분`), metric(doc, "종료", o.endedAtMinute === null || o.endedAtMinute === undefined ? "—" : `${o.endedAtMinute}분 · ${o.endReason ?? ""}`)),
        ...(listOf(o.assumptions).length ? [text(doc, "div", "control-assumptions", `가정: ${o.assumptions.join(", ")}`)] : [])));
    }
    return nodes;
  }

  refresh();
  return { refresh };
}
