// Browser side of the depot candidate editor: draw a parcel or a point, choose the mainline it connects to,
// route the connection track, move / redraw / delete, and keep everything in localStorage so the sites (and
// their ids) survive a reload. It edits only its own document; the map's plans and the management engine's
// state are read, never written. Not imported by node tests (needs the DOM); the logic lives in
// depot-editor.mjs, depot-site.mjs and depot-view.mjs.
import { addSite, moveSite, redrawSite, removeSite, restoreDepotDoc, serializeDepotDoc, updateSite } from "./depot-editor.mjs";
import { buildDepotExport, keyedDepotSiteId } from "./depot-site.mjs";
import { buildDepotView, renderDepotCompare } from "./depot-view.mjs";
import { inRing } from "./spatial.mjs";

const HIT_PX = 14;

// state: read-only for the depot editor except `state.depotView` (what render.mjs draws)
export function attachDepotEditor({ canvas, projection, pack, state, getMapExport, panel, compare, button }) {
  const packId = pack.manifest?.id ?? "pack";
  const storageKey = `transitline.depots.v1:${packId}`;
  let stored = null;
  try { stored = localStorage.getItem(storageKey); } catch { /* storage may be blocked: start empty */ }
  const restored = restoreDepotDoc(stored, pack);
  const doc = restored.doc;
  const notes = [...restored.warnings];

  let active = false;
  let draft = null; // { kind: "polygon" | "point" | "via", points: [lon, lat][], redrawKey?: string }
  let selectedKey = null;
  let drag = null; // { last: [lon, lat] }
  let depotExport = null;

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
  const save = () => { try { localStorage.setItem(storageKey, serializeDepotDoc(doc)); } catch { notes.push({ code: "depot-doc-not-saved" }); } };

  function siteAt(x, y) {
    for (const s of [...doc.sites].reverse()) {
      if (s.polygon && inRing([x, y], s.polygon.map(screen))) return s;
      if (!s.polygon && s.location) { const [sx, sy] = screen(s.location); if (Math.hypot(sx - x, sy - y) <= HIT_PX) return s; }
    }
    return null;
  }

  function refresh() {
    const mapExport = getMapExport() ?? { plans: [], externalNetworks: [] };
    depotExport = buildDepotExport({ pack, mapExport, depots: doc.sites });
    const selectedId = selectedKey ? keyedDepotSiteId(packId, selectedKey) : null;
    state.depotView = { ...buildDepotView(depotExport, selectedId), draft: draft && draft.kind !== "via" ? draft.points : null };
    renderDepotCompare(compare, state.depotView);
    for (const n of notes) { compare.append(el("div", "diag warning", `⚠ ${n.code}`)); compare.hidden = false; }
    renderPanel(mapExport);
  }

  function finishDraft() {
    if (!draft) return;
    const { kind, points, redrawKey } = draft;
    if (kind === "via") { draft = null; refresh(); return; } // waypoints were already added one by one; nothing to replace
    if (kind === "polygon" && points.length < 3) { notes.push({ code: "polygon-needs-three-points" }); refresh(); return; }
    const geometry = kind === "polygon" ? { polygon: points } : { location: points[0] };
    if (redrawKey) redrawSite(doc, redrawKey, geometry);
    else selectedKey = addSite(doc, { name: `후보 ${doc.sites.length + 1}`, ...geometry }).key;
    draft = null;
    save();
    refresh();
  }

  function setConnect(site, value, segmentId) {
    const via = site.connect?.via ?? [];
    let connect = null;
    if (value.startsWith("plan:")) connect = { planId: value.slice(5), ...(segmentId ? { segmentId } : {}), via };
    else if (value.startsWith("ext:")) connect = { externalLineId: value.slice(4), via };
    updateSite(doc, site.key, { connect });
    save();
    refresh();
  }

  function renderPanel(mapExport) {
    panel.replaceChildren();
    panel.hidden = !active;
    if (!active) return;
    panel.append(el("div", "section-label", "차량기지 후보지"));
    const bar = el("div", "depot-bar");
    const btn = (label, fn) => { const b = el("button", "", label); b.type = "button"; b.addEventListener("click", fn); bar.append(b); };
    if (draft) {
      btn("완료", finishDraft);
      btn("취소", () => { draft = null; refresh(); });
      panel.append(bar, el("div", "diag info", draft.kind === "via" ? "지도를 눌러 입출고선 경유점을 추가하세요." : draft.kind === "point" ? "지도를 눌러 위치를 지정하세요." : "지도를 눌러 부지 꼭짓점을 찍고 '완료'를 누르세요 (Enter)."));
    } else {
      btn("＋ 부지(폴리곤)", () => { draft = { kind: "polygon", points: [] }; refresh(); });
      btn("＋ 위치(점)", () => { draft = { kind: "point", points: [] }; refresh(); });
      panel.append(bar, el("div", "diag info", "후보지를 끌어 옮기고, Delete로 지웁니다."));
    }
    for (const site of doc.sites) {
      const row = el("div", `depot-row${site.key === selectedKey ? " selected" : ""}`);
      row.addEventListener("click", () => { if (selectedKey !== site.key) { selectedKey = site.key; refresh(); } });
      const name = el("input");
      name.value = site.name ?? "";
      name.addEventListener("change", () => { updateSite(doc, site.key, { name: name.value.trim() || null }); save(); refresh(); });
      const target = el("select");
      target.append(new Option("본선 선택 안 함", ""));
      const plansGroup = el("optgroup");
      plansGroup.label = "계획 노선";
      for (const p of mapExport.plans) plansGroup.append(new Option(p.name ?? p.planId, `plan:${p.planId}`));
      const extGroup = el("optgroup");
      extGroup.label = "기존 노선";
      for (const n of mapExport.externalNetworks) for (const l of n.lines) extGroup.append(new Option(l.name ?? l.id, `ext:${l.id}`));
      target.append(plansGroup, extGroup);
      const current = site.connect?.planId ? `plan:${site.connect.planId}` : site.connect?.externalLineId ? `ext:${site.connect.externalLineId}` : "";
      target.value = current;
      target.addEventListener("change", () => setConnect(site, target.value, null));
      row.append(name, target);
      const plan = site.connect?.planId ? mapExport.plans.find((p) => p.planId === site.connect.planId) : null;
      if (plan) {
        const seg = el("select");
        seg.append(new Option("구간: 가장 가까운 곳", ""));
        plan.segments.forEach((s, i) => seg.append(new Option(`구간 ${i + 1}`, s.id)));
        seg.value = site.connect.segmentId ?? "";
        seg.addEventListener("change", () => setConnect(site, current, seg.value));
        row.append(seg);
      }
      const actions = el("div", "depot-bar");
      const act = (label, fn) => { const b = el("button", "", label); b.type = "button"; b.addEventListener("click", (e) => { e.stopPropagation(); fn(); }); actions.append(b); };
      act("다시 그리기", () => { selectedKey = site.key; draft = { kind: site.polygon ? "polygon" : "point", points: [], redrawKey: site.key }; refresh(); });
      if (site.connect) {
        act("경유점 추가", () => { selectedKey = site.key; draft = { kind: "via", points: [], redrawKey: site.key }; refresh(); });
        act("경로 지우기", () => { updateSite(doc, site.key, { connect: { ...site.connect, via: [] } }); save(); refresh(); });
      }
      act("삭제", () => { removeSite(doc, site.key); if (selectedKey === site.key) selectedKey = null; save(); refresh(); });
      row.append(actions);
      panel.append(row);
    }
  }

  // while the depot editor is on it owns the pointer: the line-drawing input must not see these events
  canvas.addEventListener("pointerdown", (ev) => {
    if (!active) return;
    ev.stopImmediatePropagation();
    const [x, y] = pointer(ev);
    const at = lonLat(x, y);
    if (draft?.kind === "via") {
      const site = doc.sites.find((s) => s.key === draft.redrawKey);
      updateSite(doc, site.key, { connect: { ...site.connect, via: [...(site.connect.via ?? []), at] } });
      save(); refresh();
      return;
    }
    if (draft) {
      draft.points.push(at);
      if (draft.kind === "point") finishDraft(); else refresh();
      return;
    }
    const hit = siteAt(x, y);
    selectedKey = hit?.key ?? null;
    if (hit) {
      drag = { last: at };
      try { canvas.setPointerCapture(ev.pointerId); } catch { /* not an active pointer (e.g. a synthetic event): dragging still works without capture */ }
    }
    refresh();
  }, true);
  canvas.addEventListener("pointermove", (ev) => {
    if (!active || !drag) return;
    ev.stopImmediatePropagation();
    const at = lonLat(...pointer(ev));
    moveSite(doc, selectedKey, at[0] - drag.last[0], at[1] - drag.last[1]);
    drag.last = at;
    refresh();
  }, true);
  const endDrag = () => { if (drag) { drag = null; save(); } };
  canvas.addEventListener("pointerup", endDrag, true);
  canvas.addEventListener("pointercancel", endDrag, true);
  canvas.addEventListener("dblclick", () => { if (active && draft?.kind === "polygon") finishDraft(); });
  window.addEventListener("keydown", (ev) => {
    if (!active || ["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement?.tagName)) return;
    if (ev.key === "Enter" && draft) finishDraft();
    else if (ev.key === "Escape" && draft) { draft = null; refresh(); }
    else if ((ev.key === "Delete" || ev.key === "Backspace") && selectedKey && !draft) { removeSite(doc, selectedKey); selectedKey = null; save(); refresh(); }
  });
  button.addEventListener("click", (ev) => {
    active = !active;
    draft = null;
    button.classList.toggle("active", active);
    ev.currentTarget.blur();
    refresh();
  });

  refresh();
  return {
    refresh,
    get doc() { return doc; },
    get selectedSite() {
      if (!selectedKey || !depotExport) return null;
      const id = keyedDepotSiteId(packId, selectedKey);
      const selected = depotExport.sites.find((site) => site.depotSiteId === id);
      return selected ? structuredClone(selected) : null;
    },
    get depotExport() { return depotExport ? structuredClone(depotExport) : null; },
  };
}
