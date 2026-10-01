// Browser side of the station candidate editor: place a station body (on a planned station or anywhere), move /
// rotate / resize it, delete and restore it, add / move / delete entrance candidates and transfer passages, and
// keep everything in localStorage so the sites (and their ids) survive a reload. It edits only its own document;
// the map's plans, the engine report and every cash / construction state are read, never written. Not imported
// by node tests (needs the DOM); the logic lives in station-editor.mjs, station-site.mjs and station-view.mjs.
import {
  activeSites, addEntrance, addSite, moveEntrance, moveSite, removeEntrance, removeSite, removeTransfer, resizeSite, restoreSite,
  restoreStationDoc, rotateSite, serializeStationDoc, setTransfer, suggestEntrancePoints, updateSite,
} from "./station-editor.mjs";
import { buildStationExport, keyedStationSiteId } from "./station-site.mjs";
import { buildStationView, LAYERS, LAYER_LABELS, renderStationDetail } from "./station-view.mjs";
import { inRing, makeSpatialContext } from "./spatial.mjs";

const HIT_PX = 12;

// state: read-only for the station editor except `state.stationView` (what render.mjs draws)
export function attachStationEditor({ canvas, projection, pack, state, getMapExport, getSpatial = () => makeSpatialContext(), getOverlay = () => null, panel, button }) {
  const packId = pack.manifest?.id ?? "pack";
  const storageKey = `transitline.stations.v1:${packId}`;
  let stored = null;
  try { stored = localStorage.getItem(storageKey); } catch { /* storage may be blocked: start empty */ }
  const restored = restoreStationDoc(stored, pack);
  const doc = restored.doc;
  const notes = [...restored.warnings];

  let active = false;
  let mode = null; // "place" | "entrance" | "via"
  let viaTarget = null; // targetStationId while adding passage waypoints
  let selectedKey = null;
  let drag = null; // { kind: "site" | "entrance", entranceKey?, last: [lon, lat] }
  let stationExport = null;
  let view = null;
  const layers = new Set(LAYERS);

  const screen = (loc) => projection.toScreen(loc, canvas.width, canvas.height);
  const origin = pack.manifest.origin;
  const lonLat = (x, y) => { // toScreen is affine in lon/lat, so its inverse follows from two sample points
    const o = screen(origin);
    const u = screen([origin[0] + 1, origin[1] + 1]);
    return [origin[0] + (x - o[0]) / (u[0] - o[0]), origin[1] + (y - o[1]) / (u[1] - o[1])];
  };
  const pointer = (ev) => { const r = canvas.getBoundingClientRect(); return [ev.clientX - r.left, ev.clientY - r.top]; };
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const save = () => { try { localStorage.setItem(storageKey, serializeStationDoc(doc)); } catch { notes.push({ code: "station-doc-not-saved" }); } };
  const exported = (key) => stationExport?.sites.find((s) => s.stationSiteId === keyedStationSiteId(packId, key)) ?? null;

  // The topmost site under the pointer. An entrance wins only when it is nearer than the body's centre: zoomed out,
  // a whole station is a few pixels wide and the entrances sit within reach of its centre.
  function hit(x, y) {
    for (const site of [...activeSites(doc)].reverse()) {
      const [sx, sy] = screen(site.location);
      const toCentre = Math.hypot(sx - x, sy - y);
      const body = exported(site.key)?.bodyPolygon;
      const onBody = body ? inRing([x, y], body.map(screen)) || toCentre <= 6 : toCentre <= HIT_PX;
      let near = null;
      let nearest = Infinity;
      for (const e of site.entrances) {
        const [ex, ey] = screen(e.location);
        const d = Math.hypot(ex - x, ey - y);
        if (d <= HIT_PX && d < nearest) { near = e; nearest = d; }
      }
      if (near && (!onBody || nearest < toCentre)) return { site, entrance: near };
      if (onBody) return { site, entrance: null };
    }
    return null;
  }

  function planStationAt(x, y, mapExport) {
    let best = null;
    for (const plan of mapExport.plans) for (const st of plan.stationCandidates) {
      const [sx, sy] = screen(st.location);
      const d = Math.hypot(sx - x, sy - y);
      if (d <= HIT_PX + 4 && (!best || d < best.d)) best = { d, planId: plan.planId, stationId: st.id, location: st.location, name: st.name };
    }
    return best;
  }

  function refresh() {
    const mapExport = getMapExport() ?? { plans: [], externalNetworks: [], demandNodes: [] };
    stationExport = buildStationExport({ pack, mapExport, stations: activeSites(doc), spatial: getSpatial() });
    const selectedId = selectedKey ? keyedStationSiteId(packId, selectedKey) : null;
    view = { ...buildStationView(stationExport, getOverlay(), selectedId), layers, draft: null };
    state.stationView = view;
    renderPanel(mapExport);
  }

  function renderPanel(mapExport) {
    panel.replaceChildren();
    panel.hidden = !active;
    if (!active) return;
    panel.append(el("div", "section-label", "역 후보지"));
    const bar = el("div", "depot-bar");
    const btn = (label, fn, parent = bar) => { const b = el("button", "", label); b.type = "button"; b.addEventListener("click", (e) => { e.stopPropagation(); fn(); }); parent.append(b); return b; };
    btn("＋ 역 배치", () => { mode = "place"; refresh(); });
    if (mode) btn("취소", () => { mode = null; viaTarget = null; refresh(); });
    panel.append(bar);
    const hints = { place: "지도를 눌러 배치하세요. 계획 역 위를 누르면 그 역에 연결됩니다.", entrance: "지도를 눌러 출입구 후보를 추가하세요.", via: "지도를 눌러 환승통로 경유점을 추가하세요." };
    panel.append(el("div", "diag info", mode ? hints[mode] : "본체·출입구를 끌어 옮기고, Delete로 지웁니다."));

    const layerBar = el("div", "depot-bar");
    for (const name of LAYERS) {
      const label = el("label", "");
      const box = el("input");
      box.type = "checkbox";
      box.checked = layers.has(name);
      box.addEventListener("change", () => { if (box.checked) layers.add(name); else layers.delete(name); refresh(); });
      label.append(box, document.createTextNode(` ${LAYER_LABELS[name]}`));
      layerBar.append(label);
    }
    panel.append(layerBar);

    for (const site of doc.sites) {
      const row = el("div", `depot-row${site.key === selectedKey ? " selected" : ""}${site.deleted ? " deleted" : ""}`);
      row.addEventListener("click", () => { if (selectedKey !== site.key && !site.deleted) { selectedKey = site.key; refresh(); } });
      if (site.deleted) {
        row.append(el("span", "", `삭제됨 · ${site.name ?? site.key}`));
        btn("복원", () => { restoreSite(doc, site.key); save(); refresh(); }, row);
        panel.append(row);
        continue;
      }
      const out = exported(site.key);
      const name = el("input");
      name.value = site.name ?? "";
      name.addEventListener("change", () => { updateSite(doc, site.key, { name: name.value.trim() || null }); save(); refresh(); });
      row.append(name);

      const target = el("select");
      target.append(new Option("연결 계획 역 없음", ""));
      for (const p of mapExport.plans) {
        const group = el("optgroup");
        group.label = p.name ?? p.planId;
        p.stationCandidates.forEach((s, i) => group.append(new Option(s.name ?? `역 ${i + 1}`, `${p.planId}|${s.id}`)));
        target.append(group);
      }
      target.value = site.connect ? `${site.connect.planId}|${site.connect.stationId}` : "";
      target.addEventListener("change", () => {
        const [planId, stationId] = target.value.split("|");
        updateSite(doc, site.key, { connect: planId ? { planId, stationId } : null });
        save(); refresh();
      });
      row.append(target);

      const dims = el("div", "depot-bar");
      const num = (label, value, placeholder, apply) => {
        const wrap = el("label", "", `${label} `);
        const input = el("input");
        input.type = "number";
        input.style.width = "64px";
        input.value = value ?? "";
        input.placeholder = placeholder ?? "";
        input.addEventListener("change", () => { const v = input.value === "" ? null : Number(input.value); if (v === null || Number.isFinite(v)) { apply(v); save(); refresh(); } });
        wrap.append(input);
        dims.append(wrap);
      };
      num("방향°", site.headingDegrees, out?.bodyHeadingDegrees ?? "", (v) => updateSite(doc, site.key, { headingDegrees: v }));
      num("길이", site.lengthMeters, out?.bodyLengthMeters ?? "", (v) => resizeSite(doc, site.key, { lengthMeters: v }));
      num("폭", site.widthMeters, out?.bodyWidthMeters ?? "", (v) => resizeSite(doc, site.key, { widthMeters: v }));
      row.append(dims);

      const actions = el("div", "depot-bar");
      for (const d of [-15, -5, 5, 15]) btn(`${d > 0 ? "↻" : "↺"}${Math.abs(d)}°`, () => { rotateSite(doc, site.key, d, out?.bodyHeadingDegrees ?? null); save(); refresh(); }, actions);
      btn("출입구 추가", () => { selectedKey = site.key; mode = "entrance"; refresh(); }, actions);
      btn("출입구 자동 배치", () => {
        const points = suggestEntrancePoints({ location: site.location, headingDegrees: out?.bodyHeadingDegrees, lengthMeters: out?.bodyLengthMeters, widthMeters: out?.bodyWidthMeters });
        if (!points.length) { notes.push({ code: "entrance-suggestion-needs-heading" }); refresh(); return; }
        for (const p of points) addEntrance(doc, site.key, p);
        save(); refresh();
      }, actions);
      btn("삭제", () => { removeSite(doc, site.key); if (selectedKey === site.key) selectedKey = null; mode = null; save(); refresh(); }, actions);
      row.append(actions);

      for (const e of site.entrances) {
        const er = el("div", "depot-bar");
        er.append(el("span", "", `출입구 ${e.key}`));
        btn("삭제", () => { removeEntrance(doc, site.key, e.key); save(); refresh(); }, er);
        row.append(er);
      }

      // transfer passages: pick a target station within reach, then route it with waypoints
      const targets = new Map();
      for (const t of out?.transferCandidates ?? []) targets.set(t.targetStationId, `${t.targetName ?? t.targetStationId} · ${Math.round(t.straightDistanceMeters)} m${t.basis === "player-passage" ? " · 그림" : ""}`);
      const tsel = el("select");
      tsel.append(new Option("환승통로 대상 선택", ""));
      for (const [id, label] of targets) tsel.append(new Option(label, id));
      tsel.addEventListener("change", () => { if (tsel.value) { setTransfer(doc, site.key, tsel.value, site.transfers.find((t) => t.targetStationId === tsel.value)?.via ?? []); save(); refresh(); } });
      row.append(tsel);
      for (const t of site.transfers) {
        const tr = el("div", "depot-bar");
        tr.append(el("span", "", `환승통로 ${targets.get(t.targetStationId) ?? t.targetStationId}`));
        btn("경유점", () => { selectedKey = site.key; viaTarget = t.targetStationId; mode = "via"; refresh(); }, tr);
        btn("삭제", () => { removeTransfer(doc, site.key, t.targetStationId); save(); refresh(); }, tr);
        row.append(tr);
      }
      panel.append(row);
    }
    const detail = el("div", "station-detail");
    renderStationDetail(detail, view?.sites.find((s) => s.selected) ?? null);
    for (const n of notes) detail.append(el("div", "diag warning", `⚠ ${n.code}`));
    panel.append(detail);
  }

  // while the station editor is on it owns the pointer: the line-drawing input must not see these events
  canvas.addEventListener("pointerdown", (ev) => {
    if (!active) return;
    ev.stopImmediatePropagation();
    const [x, y] = pointer(ev);
    const at = lonLat(x, y);
    if (mode === "place") {
      const snap = planStationAt(x, y, getMapExport() ?? { plans: [] });
      const site = addSite(doc, { name: snap?.name ?? `역 후보 ${activeSites(doc).length + 1}`, location: snap ? snap.location : at, connect: snap ? { planId: snap.planId, stationId: snap.stationId } : null });
      selectedKey = site.key;
      mode = null;
      save(); refresh();
      return;
    }
    if (mode === "entrance" && selectedKey) { addEntrance(doc, selectedKey, at); save(); refresh(); return; }
    if (mode === "via" && selectedKey && viaTarget) {
      const site = doc.sites.find((s) => s.key === selectedKey);
      const cur = site.transfers.find((t) => t.targetStationId === viaTarget);
      setTransfer(doc, selectedKey, viaTarget, [...(cur?.via ?? []), at]);
      save(); refresh();
      return;
    }
    const found = hit(x, y);
    selectedKey = found?.site.key ?? null;
    if (found) {
      drag = { kind: found.entrance ? "entrance" : "site", entranceKey: found.entrance?.key, last: at };
      try { canvas.setPointerCapture(ev.pointerId); } catch { /* not an active pointer (e.g. a synthetic event): dragging still works without capture */ }
    }
    refresh();
  }, true);
  canvas.addEventListener("pointermove", (ev) => {
    if (!active || !drag) return;
    ev.stopImmediatePropagation();
    const at = lonLat(...pointer(ev));
    if (drag.kind === "entrance") moveEntrance(doc, selectedKey, drag.entranceKey, at);
    else moveSite(doc, selectedKey, at[0] - drag.last[0], at[1] - drag.last[1]);
    drag.last = at;
    refresh();
  }, true);
  const endDrag = () => { if (drag) { drag = null; save(); } };
  canvas.addEventListener("pointerup", endDrag, true);
  canvas.addEventListener("pointercancel", endDrag, true);
  window.addEventListener("keydown", (ev) => {
    if (!active || ["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement?.tagName)) return;
    if (ev.key === "Escape" && mode) { mode = null; viaTarget = null; refresh(); }
    else if ((ev.key === "Delete" || ev.key === "Backspace") && selectedKey && !mode) { removeSite(doc, selectedKey); selectedKey = null; save(); refresh(); }
  });
  button.addEventListener("click", (ev) => {
    active = !active;
    mode = null;
    viaTarget = null;
    button.classList.toggle("active", active);
    ev.currentTarget.blur();
    refresh();
  });

  refresh();
  return {
    refresh,
    get doc() { return doc; },
    get selectedSite() {
      const selected = selectedKey ? exported(selectedKey) : null;
      return selected ? structuredClone(selected) : null;
    },
    get stationExport() { return stationExport ? structuredClone(stationExport) : null; },
  };
}
