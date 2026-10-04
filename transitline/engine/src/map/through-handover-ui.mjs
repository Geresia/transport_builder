// Browser side of the through-running handover editor: pick a handover of a through route, pick the connection point
// on each leg, draw / move / delete connection waypoints, choose turnouts, outline work areas, and keep everything in
// localStorage so the sites (and their ids) survive a reload. It edits only its own document; the routes, the map
// and the management engine's state are read, never written. Not imported by node tests (needs the DOM); the logic
// lives in through-handover-editor.mjs, through-handover-site.mjs and through-handover-view.mjs.
import {
  addSite, addTurnout, selectWorkArea, setMaximumGradient, setStructureType, addWaypoint, addWorkArea, clearWaypoints, moveTurnout, moveWaypoint, rebindRoute, removeSite, removeTurnout,
  removeWaypoint, removeWorkArea, restoreThroughHandoverDoc, selectHandover, serializeThroughHandoverDoc, setConnectionPoint, toDrawnSite, updateSite,
} from "./through-handover-editor.mjs";
import { CONNECTION_STRUCTURE_TYPES, buildThroughHandoverExport, keyedHandoverSiteId } from "./through-handover-site.mjs";
import { buildThroughHandoverView, renderThroughHandoverLegend, renderThroughHandoverPanel } from "./through-handover-view.mjs";
import { makeSpatialContext } from "./spatial.mjs";

const HIT_PX = 12;

// state: read-only for the handover editor except `state.throughHandoverView` (what the renderer draws)
// getRoutes() -> ThroughRouteGeometry v1[]; getMapExport() -> { plans, externalNetworks }; getSpatial() / getExternalAlignments() optional
export function attachThroughHandoverEditor({ canvas, projection, pack, state, getRoutes, getMapExport = () => ({ plans: [], externalNetworks: [] }), getSpatial = () => makeSpatialContext(), getExternalAlignments = () => [], panel, summary, legend, button }) {
  const packId = pack.manifest?.id ?? "pack";
  const storageKey = `transitline.through-handovers.v1:${packId}`;
  let stored = null;
  try { stored = localStorage.getItem(storageKey); } catch { /* storage may be blocked: start empty */ }
  const restored = restoreThroughHandoverDoc(stored, pack);
  const doc = restored.doc;
  const notes = [...restored.warnings];

  let active = false;
  let tool = null; // { kind: "from" | "to" | "via" | "turnout" | "work-area", points?: [lon, lat][] }
  let selectedKey = null;
  let drag = null; // { kind: "via", index } | { kind: "turnout", turnoutKey }
  let siteExport = null;

  const screen = (loc) => projection.toScreen(loc, canvas.width, canvas.height);
  // toScreen is affine in lon/lat, so its inverse follows from two sample points
  const origin = pack.manifest.origin;
  const lonLat = (x, y) => {
    const o = screen(origin);
    const u = screen([origin[0] + 1, origin[1] + 1]);
    return [origin[0] + (x - o[0]) / (u[0] - o[0]), origin[1] + (y - o[1]) / (u[1] - o[1])];
  };
  const pointer = (ev) => { const r = canvas.getBoundingClientRect(); return [ev.clientX - r.left, ev.clientY - r.top]; };
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const save = () => { try { localStorage.setItem(storageKey, serializeThroughHandoverDoc(doc)); } catch { notes.push({ code: "through-handover-doc-not-saved" }); } };
  const routeOf = (site) => (getRoutes() ?? []).find((r) => r.throughRouteId === site.throughRouteId) ?? null;
  const near = (loc, xy) => { const [x, y] = screen(loc); return Math.hypot(x - xy[0], y - xy[1]) <= HIT_PX; };

  function refresh() {
    const routes = getRoutes() ?? [];
    const mapExport = getMapExport() ?? { plans: [], externalNetworks: [] };
    siteExport = buildThroughHandoverExport({ pack, routes, mapExport, sites: doc.sites.map(toDrawnSite), spatial: getSpatial(), externalAlignments: getExternalAlignments() });
    const selectedId = selectedKey ? keyedHandoverSiteId(packId, selectedKey) : null;
    const draft = tool?.points?.length ? { kind: "work-area", points: tool.points } : null;
    state.throughHandoverView = buildThroughHandoverView({ routes, exportData: siteExport, selectedId, draft });
    renderThroughHandoverPanel(summary, state.throughHandoverView);
    for (const n of notes) { summary.append(el("div", "diag warning", `⚠ ${n.code}`)); summary.hidden = false; }
    if (legend) { renderThroughHandoverLegend(legend); legend.hidden = !active; }
    renderPanel(routes);
  }

  function finishWorkArea() {
    if (tool?.kind !== "work-area") return;
    if (tool.points.length < 3) notes.push({ code: "work-area-needs-three-points" });
    else addWorkArea(doc, selectedKey, tool.points);
    tool = null;
    save();
    refresh();
  }

  function renderPanel(routes) {
    panel.replaceChildren();
    panel.hidden = !active;
    if (!active) return;
    panel.append(el("div", "section-label", "직통 접속부 설계"));
    const hint = { from: "앞 구간 위에서 접속점을 누르세요.", to: "뒤 구간 위에서 접속점을 누르세요.", via: "연락선 경유점을 누르세요. 끌어서 옮기고 Delete로 지웁니다.", turnout: "분기기 위치를 누르세요.", "work-area": "작업구역 꼭짓점을 찍고 '완료'(Enter)를 누르세요." }[tool?.kind];
    if (tool) {
      const bar = el("div", "handover-bar");
      const btn = (label, fn) => { const b = el("button", "", label); b.type = "button"; b.addEventListener("click", fn); bar.append(b); };
      btn("완료", () => { if (tool.kind === "work-area") finishWorkArea(); else { tool = null; refresh(); } });
      btn("취소", () => { tool = null; refresh(); });
      panel.append(bar, el("div", "diag info", hint));
    }
    // add a site for a handover of any route
    const add = el("select");
    add.append(new Option("＋ 접속부 추가 (직통 경로·접속 지점 선택)", ""));
    for (const r of routes) r.handovers.forEach((h, i) => add.append(new Option(`${r.name ?? r.key ?? r.throughRouteId} · 접속 ${i + 1}`, `${r.throughRouteId}|${h.handoverId}`)));
    add.addEventListener("change", () => {
      if (!add.value) return;
      const [routeId, handoverId] = add.value.split("|");
      selectedKey = addSite(doc, routes.find((r) => r.throughRouteId === routeId), handoverId, { name: `접속부 ${doc.sites.length + 1}` }).key;
      save();
      refresh();
    });
    panel.append(add);
    for (const site of doc.sites) {
      const route = routeOf(site);
      const row = el("div", `handover-row${site.key === selectedKey ? " selected" : ""}`);
      row.addEventListener("click", () => { if (selectedKey !== site.key) { selectedKey = site.key; refresh(); } });
      const name = el("input");
      name.value = site.name ?? "";
      name.addEventListener("change", () => { updateSite(doc, site.key, { name: name.value.trim() || null }); save(); refresh(); });
      row.append(name);
      if (route) {
        const target = el("select");
        route.handovers.forEach((h, i) => target.append(new Option(`접속 ${i + 1}`, h.handoverId)));
        target.value = site.handoverId;
        target.addEventListener("change", () => { selectHandover(doc, site.key, route, target.value); save(); refresh(); });
        row.append(target);
        if (route.geometryRevision !== site.routeGeometryRevision) {
          const stale = el("button", "", "경로가 바뀜 — 설계를 다시 확인");
          stale.type = "button";
          stale.addEventListener("click", (e) => {
            e.stopPropagation();
            try { rebindRoute(doc, site.key, route); } catch (err) { notes.push({ code: "rebind-refused", message: err.message }); }
            save();
            refresh();
          });
          row.append(stale);
        }
      } else row.append(el("div", "diag warning", "⚠ 직통 경로를 찾을 수 없음"));
      const structure = el("select");
      structure.append(new Option("구조형식 미지정", ""), ...CONNECTION_STRUCTURE_TYPES.map((t) => new Option(t, t)));
      structure.value = site.structureType ?? "";
      structure.addEventListener("change", () => { setStructureType(doc, site.key, structure.value || null); save(); refresh(); });
      const gradient = el("input");
      gradient.type = "number";
      gradient.min = "0";
      gradient.placeholder = "최대 구배 ‰ (설계값)";
      gradient.value = site.maximumGradientPermille ?? "";
      gradient.addEventListener("change", () => { setMaximumGradient(doc, site.key, gradient.value === "" ? null : Number(gradient.value)); save(); refresh(); });
      const workArea = el("select");
      workArea.append(new Option("작업구역 선택 안 함", ""), ...site.workAreas.map((w) => new Option(w.key, w.key)));
      workArea.value = site.selectedWorkAreaKey ?? "";
      workArea.addEventListener("change", () => { selectWorkArea(doc, site.key, workArea.value || null); save(); refresh(); });
      row.append(structure, gradient, workArea);
      const actions = el("div", "handover-bar");
      const act = (label, fn) => { const b = el("button", "", label); b.type = "button"; b.addEventListener("click", (e) => { e.stopPropagation(); selectedKey = site.key; fn(); }); actions.append(b); };
      act("앞 접속점", () => { tool = { kind: "from" }; refresh(); });
      act("뒤 접속점", () => { tool = { kind: "to" }; refresh(); });
      act("경유점 추가", () => { tool = { kind: "via" }; refresh(); });
      act("경유점 지우기", () => { clearWaypoints(doc, site.key); save(); refresh(); });
      act("분기기", () => { tool = { kind: "turnout" }; refresh(); });
      act("작업구역", () => { tool = { kind: "work-area", points: [] }; refresh(); });
      act("삭제", () => { removeSite(doc, site.key); if (selectedKey === site.key) selectedKey = null; save(); refresh(); });
      row.append(actions);
      panel.append(row);
    }
  }

  // while the handover editor is on it owns the pointer: the other drawing inputs must not see these events
  canvas.addEventListener("pointerdown", (ev) => {
    if (!active) return;
    ev.stopImmediatePropagation();
    const xy = pointer(ev);
    const at = lonLat(...xy);
    const site = doc.sites.find((s) => s.key === selectedKey) ?? null;
    if (tool && site) {
      if (tool.kind === "from" || tool.kind === "to") { setConnectionPoint(doc, site.key, tool.kind, at, { route: routeOf(site) }); tool = null; }
      else if (tool.kind === "via") addWaypoint(doc, site.key, at);
      else if (tool.kind === "turnout") { addTurnout(doc, site.key, at); tool = null; }
      else tool.points.push(at);
      save();
      refresh();
      return;
    }
    // no tool: drag a waypoint or a turnout of the selected site, else select the site whose marker was hit
    if (site) {
      const via = site.via.findIndex((p) => near(p, xy));
      const turnout = site.turnoutCandidates.find((t) => near(t.location, xy));
      if (via >= 0 || turnout) {
        drag = via >= 0 ? { kind: "via", index: via } : { kind: "turnout", turnoutKey: turnout.key };
        try { canvas.setPointerCapture(ev.pointerId); } catch { /* a synthetic event has no active pointer: dragging still works */ }
        return;
      }
    }
    const hit = [...doc.sites].reverse().find((s) => [s.fromConnectionPoint, s.toConnectionPoint, ...s.via].some((p) => p && near(p, xy)));
    selectedKey = hit?.key ?? selectedKey;
    refresh();
  }, true);
  canvas.addEventListener("pointermove", (ev) => {
    if (!active || !drag) return;
    ev.stopImmediatePropagation();
    const at = lonLat(...pointer(ev));
    if (drag.kind === "via") moveWaypoint(doc, selectedKey, drag.index, at);
    else moveTurnout(doc, selectedKey, drag.turnoutKey, at);
    refresh();
  }, true);
  const endDrag = () => { if (drag) { drag = null; save(); } };
  canvas.addEventListener("pointerup", endDrag, true);
  canvas.addEventListener("pointercancel", endDrag, true);
  canvas.addEventListener("dblclick", () => { if (active && tool?.kind === "work-area") finishWorkArea(); });
  window.addEventListener("keydown", (ev) => {
    if (!active || ["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement?.tagName)) return;
    if (ev.key === "Enter" && tool?.kind === "work-area") finishWorkArea();
    else if (ev.key === "Escape" && tool) { tool = null; refresh(); }
    else if ((ev.key === "Delete" || ev.key === "Backspace") && selectedKey && !tool) {
      const site = doc.sites.find((s) => s.key === selectedKey);
      if (site?.via.length) removeWaypoint(doc, site.key, site.via.length - 1);
      else if (site?.turnoutCandidates.length) removeTurnout(doc, site.key, site.turnoutCandidates.at(-1).key);
      else if (site?.workAreas.length) removeWorkArea(doc, site.key, site.workAreas.at(-1).key);
      else return;
      save();
      refresh();
    }
  });
  button.addEventListener("click", (ev) => {
    active = !active;
    tool = null;
    button.classList.toggle("active", active);
    ev.currentTarget.blur();
    refresh();
  });

  refresh();
  return {
    refresh,
    get doc() { return doc; },
    get selectedSite() {
      if (!selectedKey || !siteExport) return null;
      const id = keyedHandoverSiteId(packId, selectedKey);
      const selected = siteExport.sites.find((s) => s.handoverSiteId === id);
      return selected ? structuredClone(selected) : null;
    },
    get handoverSiteExport() { return siteExport ? structuredClone(siteExport) : null; },
  };
}
