// Station demand allocation overlay, browser side: an independent, READ-ONLY mount.  The host hands it getters for what the engine
// already applied — runtime.stationDemandAllocationReport(), the station access report and the places of the demand nodes and
// operational stations — and it draws them: which access sites each node was given to and at what expected share, the links the
// engine made, what stayed unallocated, without a route, blocked or unknown, and that an allocation is stale.  It has no edit, no
// storage, no timer-driven change and no say in any number: it counts no passenger and computes no demand, crowding, fare, cost,
// score or walking time.  It makes its own overlay, panel and <style>; the only thing it takes from the map is a click that lands on
// a node (to show that node's details).
//
//   const bridge = mountStationDemandAllocationOverlay({ canvas, projection, pack, getAllocationReport, getAccessReport, getDemandNodes, getStations, onChange });
//   bridge.output()  ->  { view, status, selectedNodeId, warnings }
import { buildAllocationOverlayView, drawAllocationOverlay, hitAllocationNode, renderAllocationLegend, renderAllocationPanel } from "./station-demand-allocation-view.mjs";
import { clone, createShell } from "./map-mount-kit.mjs";

export const ALLOCATION_UI_EVENT = "transitline:station-demand-allocation-overlay";
export const SCOPE_NOTICE = "이 화면은 이미 적용된 배정 결과를 보여 줄 뿐입니다. 비율은 정책이 정한 예상 몫이며, 실제 승객을 만들거나 세지 않고 수요·혼잡·운임·걸음 계산도 하지 않습니다. 모르는 값은 미상으로 둡니다.";
const STYLE_ID = "transitline-station-demand-allocation-style";
const CSS = `
.tl-alloc-panel{position:fixed;left:12px;bottom:64px;z-index:7;width:340px;max-height:44vh;overflow:auto;padding:8px 10px;border:1px solid #2a2f3a;border-radius:8px;background:rgba(17,19,24,.94);color:#f1f2f5;font:12px/1.4 system-ui,'Malgun Gothic',sans-serif}
.tl-alloc-panel .section-label{margin:6px 0 3px;color:#ffe66d;font-weight:600}
.tl-alloc-panel .diag{margin:3px 0;padding:3px 6px;border-left:3px solid #4cc9f0;border-radius:3px;font-size:11px;overflow-wrap:anywhere}
.tl-alloc-panel .diag.warning{border-left-color:#ffb703}.tl-alloc-panel .diag.info{color:#aab1c0}
.tl-alloc-panel .alloc-fact{margin:2px 0;font-size:11px}.tl-alloc-panel .alloc-row{margin:1px 0;font-size:11px;color:#c7ccd6}.tl-alloc-panel .alloc-row.picked{background:rgba(255,255,255,.1)}
.tl-alloc-panel button{margin:2px 3px 2px 0;padding:2px 7px}
`;
const asList = (v) => (v === undefined || v === null ? [] : v);

export function mountStationDemandAllocationOverlay({ canvas, projection, pack, getAllocationReport, getAccessReport, getDemandNodes, getStations, onChange = () => {}, enabled = true, autoRefreshMs = 250 }) {
  const shell = createShell({ canvas, projection, pack, styleId: STYLE_ID, css: CSS, panelClass: "tl-alloc-panel" });
  const { box, screen, el, pointer, button } = shell;
  let enabledNow = enabled;
  let selectedId = null;
  let version = 0;
  let drawVersion = -1;
  let panelVersion = -1;
  let outputVersion = -1;
  let lastRect = "";
  let lastFingerprint = null;
  let model = buildAllocationOverlayView({});

  // The demand nodes' places default to the pack's own points; the host's getter wins when it gives one.
  const inputs = () => ({
    report: getAllocationReport?.() ?? null,
    access: getAccessReport?.() ?? null,
    demandNodes: getDemandNodes ? asList(getDemandNodes()) : (pack?.demand?.points ?? []),
    stations: asList(getStations?.()),
  });
  const sizeOf = (v) => (v instanceof Map ? v.size : Array.isArray(v) ? v.length : Object.keys(v ?? {}).length);
  // What decides whether the picture changed: the report's identity and size, the places it needs.  A host that mutates a report in
  // place without changing any of these calls refresh({ force: true }).
  const fingerprint = (i) => JSON.stringify([
    i.report?.applicationId ?? null, i.report?.status ?? null, i.report?.allocation?.allocationId ?? null, i.report?.appliedAtSimMinute ?? null, i.report?.staleReasons ?? null,
    (i.report?.links ?? []).length, (i.report?.blockedLinks ?? []).length, (i.report?.splitNodes ?? []).length, (i.report?.allocation?.nodes ?? []).length,
    i.access?.applicationId ?? i.access?.access?.packVersion ?? null, sizeOf(i.demandNodes), sizeOf(i.stations), selectedId,
  ]);
  const bump = () => { version += 1; };

  function recompute(i) {
    model = buildAllocationOverlayView({ report: i.report, access: i.access, demandNodes: i.demandNodes, stations: i.stations, selectedNodeId: selectedId });
    selectedId = model.selectedNodeId;
    bump();
  }
  const outputNow = () => ({
    view: clone(model), status: model.status, selectedNodeId: selectedId,
    warnings: [...model.staleReasons.map((code) => ({ code })), ...Object.entries(model.missing).filter(([, ids]) => ids.length).map(([what, ids]) => ({ code: `position-unknown-${what}`, ids }))],
  });
  function emit() {
    if (outputVersion === version) return;
    outputVersion = version;
    const out = outputNow();
    onChange(out);
    canvas.dispatchEvent(new CustomEvent(ALLOCATION_UI_EVENT, { detail: out }));
  }

  function drawLayer() {
    const rectKey = shell.fit(enabledNow);
    if (drawVersion === version && rectKey === lastRect) return;
    drawVersion = version;
    lastRect = rectKey;
    const ctx = shell.layer.getContext("2d");
    ctx.clearRect(0, 0, shell.layer.width, shell.layer.height);
    if (enabledNow) drawAllocationOverlay(ctx, model, screen);
  }
  function renderPanel() {
    box.replaceChildren();
    box.hidden = !enabledNow;
    if (!enabledNow) return;
    box.append(el("div", "section-label", "수요 배정 (지도 표시)"));
    box.append(el("div", "diag info", SCOPE_NOTICE));
    const body = el("div");
    box.append(body);
    renderAllocationPanel(body, model);
    if (selectedId !== null) button(box, "선택 해제", () => select(null));
    const legend = el("div");
    box.append(legend);
    renderAllocationLegend(legend);
  }

  function refresh({ force = false } = {}) {
    const i = inputs();
    const fp = fingerprint(i);
    if (force || fp !== lastFingerprint) { lastFingerprint = fp; recompute(i); }
    drawLayer();
    if (panelVersion !== version) { panelVersion = version; renderPanel(); }
    emit();
  }
  function select(nodeId) {
    const ok = nodeId === null || model.nodes.some((n) => n.demandNodeId === nodeId);
    selectedId = ok ? nodeId : null;
    refresh({ force: true });
    return ok;
  }

  // A click is taken from the map only when it lands on a node; any other click goes on to the map untouched.
  const onPointerDown = (ev) => {
    if (!enabledNow) return;
    const hit = hitAllocationNode(model, screen, pointer(ev));
    if (hit === null) return;
    ev.stopImmediatePropagation?.();
    select(hit);
  };
  const onKey = (ev) => { if (enabledNow && ev.key === "Escape" && selectedId !== null && !shell.typing()) select(null); };
  const detach = shell.attach({ onPointerDown, onDblClick: () => {}, onKey, refresh: () => refresh(), autoRefreshMs });
  refresh({ force: true });

  return {
    output: outputNow, refresh, select, deselect: () => select(null),
    setEnabled(value) { enabledNow = Boolean(value); bump(); refresh(); },
    get selectedNodeId() { return selectedId; },
    destroy: detach,
  };
}
