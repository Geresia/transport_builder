// Browser side of the construction-package editor: split a drawn plan into tunnel / cut-and-cover / viaduct /
// systems packages by picking its segments, add station and depot packages, move a boundary (push/pull one
// segment between two adjacent packages), split, merge, delete, restore, and keep everything in localStorage so
// packages (and their ids) survive a reload. It also builds the engine's read-only construction-phase view for the
// resulting export (rendered by render.mjs / a host panel via construction-view.mjs). It edits only its own
// document; the map's plans, the depot export, the engine report and every cash / construction state are read,
// never written. Not imported by node tests (needs the DOM); the logic lives in construction-editor.mjs,
// construction-site.mjs and construction-view.mjs.
import {
  activePackages, addPackage, mergePackages, nextPackageKey, reassignSegment, removePackage, restoreConstructionDoc,
  restorePackage, serializeConstructionDoc, splitPackage, updatePackage,
} from "./construction-editor.mjs";
import { buildConstructionExport, PACKAGE_KINDS } from "./construction-site.mjs";
import { buildConstructionView, renderConstructionLegend, renderConstructionPanel } from "./construction-view.mjs";
import { nearestOnPolyline } from "./local-geometry.mjs";
import { makeSpatialContext } from "./spatial.mjs";

const LINE_KIND_LABEL = { tunnel: "터널 공구", cutCover: "개착 공구", viaduct: "고가·교량 공구", systems: "전력·신호·궤도 공구" };
const PICK_PX = 14;

// state: read-only for this editor except `state.constructionView` (what render.mjs draws)
export function attachConstructionEditor({ canvas, projection, pack, state, getMapExport, getDepotExport = () => null, getSpatial = () => makeSpatialContext(), getReport = () => ({}), panel, phasePanel = null, legend, button }) {
  const packId = pack.manifest?.id ?? "pack";
  const storageKey = `transitline.construction.v1:${packId}`;
  let stored = null;
  try { stored = localStorage.getItem(storageKey); } catch { /* storage may be blocked: start empty */ }
  const restored = restoreConstructionDoc(stored, pack);
  const doc = restored.doc;
  const notes = [...restored.warnings];

  let active = false;
  let mode = null; // { kind: "line-draft", lineKind, planId, segmentIds } | { kind: "station-pick" } | { kind: "split-pick", key }
  let selectedKey = null;
  let exp = null;

  const screen = (loc) => projection.toScreen(loc, canvas.width, canvas.height);
  const origin = pack.manifest.origin;
  const lonLat = (x, y) => { // toScreen is affine in lon/lat, so its inverse follows from two sample points
    const o = screen(origin);
    const u = screen([origin[0] + 1, origin[1] + 1]);
    return [origin[0] + (x - o[0]) / (u[0] - o[0]), origin[1] + (y - o[1]) / (u[1] - o[1])];
  };
  void lonLat; // kept for parity with the other editors; this one only needs segment/station hit-testing, not free placement
  const pointer = (ev) => { const r = canvas.getBoundingClientRect(); return [ev.clientX - r.left, ev.clientY - r.top]; };
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const save = () => { try { localStorage.setItem(storageKey, serializeConstructionDoc(doc)); } catch { notes.push({ code: "construction-doc-not-saved" }); } };

  function segmentAt(x, y, mapExport) {
    let best = null;
    for (const plan of mapExport.plans) for (const seg of plan.segments) {
      const d = nearestOnPolyline([x, y], seg.alignment.map(screen)).d;
      if (d <= PICK_PX && (!best || d < best.d)) best = { d, planId: plan.planId, segmentId: seg.id };
    }
    return best;
  }
  function planStationAt(x, y, mapExport) {
    let best = null;
    for (const plan of mapExport.plans) for (const st of plan.stationCandidates) {
      const [sx, sy] = screen(st.location);
      const d = Math.hypot(sx - x, sy - y);
      if (d <= PICK_PX + 4 && (!best || d < best.d)) best = { d, planId: plan.planId, stationId: st.id };
    }
    return best;
  }
  const order = (planId) => getMapExport()?.plans.find((p) => p.planId === planId)?.segments.map((s) => s.id) ?? [];
  // move works across any two line-kind packages of the same plan (a segment can cross from a tunnel run into an
  // adjacent cut-and-cover run); merge only between two packages of the same kind (mergePackages enforces that).
  const linePackages = (planId) => activePackages(doc).filter((p) => p.planId === planId && PACKAGE_KINDS.includes(p.kind) && Array.isArray(p.segmentIds));

  function refresh() {
    const mapExport = getMapExport() ?? { plans: [], externalNetworks: [] };
    exp = buildConstructionExport({ pack, mapExport, depotExport: getDepotExport(), packages: activePackages(doc), spatial: getSpatial() });
    state.constructionView = buildConstructionView(exp, getReport());
    if (legend) renderConstructionLegend(legend);
    if (phasePanel) renderConstructionPanel(phasePanel, state.constructionView);
    renderPanel(mapExport);
  }

  function renderPanel(mapExport) {
    panel.replaceChildren();
    panel.hidden = !active;
    if (!active) return;
    panel.append(el("div", "section-label", "공사 구역 공구"));
    const bar = el("div", "depot-bar");
    const btn = (label, fn, parent = bar) => { const b = el("button", "", label); b.type = "button"; b.addEventListener("click", (e) => { e.stopPropagation(); fn(); }); parent.append(b); return b; };
    for (const [kind, label] of Object.entries(LINE_KIND_LABEL)) {
      btn(`+ ${label}`, () => { mode = { kind: "line-draft", lineKind: kind, planId: null, segmentIds: [] }; refresh(); });
    }
    btn("+ 역 공구", () => { mode = { kind: "station-pick" }; refresh(); });
    if (mode) btn("취소", () => { mode = null; refresh(); });
    panel.append(bar);

    if (mode?.kind === "line-draft") {
      panel.append(el("div", "diag info", `${LINE_KIND_LABEL[mode.lineKind]}: 지도에서 구간을 눌러 넣고 빼세요 (${mode.segmentIds.length}개 선택). 완료를 누르면 만들어집니다.`));
      const b2 = el("div", "depot-bar");
      btn("완료", () => {
        if (!mode.planId || !mode.segmentIds.length) { notes.push({ code: "construction-package-empty" }); refresh(); return; }
        const p = addPackage(doc, { name: `${LINE_KIND_LABEL[mode.lineKind]} ${linePackages(mode.planId, mode.lineKind).length + 1}`, kind: mode.lineKind, planId: mode.planId, segmentIds: mode.segmentIds });
        selectedKey = p.key;
        mode = null;
        save(); refresh();
      }, b2);
      panel.append(b2);
    } else if (mode?.kind === "station-pick") {
      panel.append(el("div", "diag info", "지도에서 계획 역을 누르세요."));
    } else if (mode?.kind === "split-pick") {
      panel.append(el("div", "diag info", "분할할 지점의 구간을 누르세요."));
    } else {
      panel.append(el("div", "diag info", "차량기지 공구는 아래에서 후보지를 골라 추가하세요."));
      const depotExp = getDepotExport();
      if (depotExp?.sites?.length) {
        const row = el("div", "depot-bar");
        const sel = el("select");
        for (const s of depotExp.sites) sel.append(new Option(s.name ?? s.depotSiteId, s.depotSiteId));
        row.append(sel);
        btn("+ 차량기지 공구 추가", () => {
          const p = addPackage(doc, { name: "차량기지 공구", kind: "depot", depotSiteId: sel.value });
          selectedKey = p.key;
          save(); refresh();
        }, row);
        panel.append(row);
      }
    }

    for (const pkg of doc.packages) {
      const row = el("div", `depot-row${pkg.key === selectedKey ? " selected" : ""}${pkg.deleted ? " deleted" : ""}`);
      row.addEventListener("click", () => { if (selectedKey !== pkg.key && !pkg.deleted) { selectedKey = pkg.key; refresh(); } });
      if (pkg.deleted) {
        row.append(el("span", "", `삭제됨 · ${pkg.name ?? pkg.key}`));
        btn("복원", () => { restorePackage(doc, pkg.key); save(); refresh(); }, row);
        panel.append(row);
        continue;
      }
      const name = el("input");
      name.value = pkg.name ?? "";
      name.addEventListener("change", () => { updatePackage(doc, pkg.key, { name: name.value.trim() || null }); save(); refresh(); });
      row.append(name, el("span", "", `${pkg.kind}${pkg.segmentIds?.length ? ` · 구간 ${pkg.segmentIds.length}개` : ""}`));

      const actions = el("div", "depot-bar");
      if (pkg.planId && pkg.segmentIds?.length) {
        const ord = order(pkg.planId);
        const ids = ord.filter((id) => pkg.segmentIds.includes(id));
        const neighbours = linePackages(pkg.planId).filter((p) => p.key !== pkg.key && p.segmentIds.length);
        if (ids.length > 1) btn("분할", () => { mode = { kind: "split-pick", key: pkg.key }; refresh(); }, actions);
        for (const nb of neighbours) {
          const nbIds = ord.filter((id) => nb.segmentIds.includes(id));
          if (!nbIds.length) continue;
          if (ord.indexOf(ids.at(-1)) + 1 === ord.indexOf(nbIds[0])) btn(`마지막 구간 → ${nb.name ?? nb.key}`, () => { reassignSegment(doc, pkg.key, nb.key, ids.at(-1)); save(); refresh(); }, actions);
          if (ord.indexOf(nbIds.at(-1)) + 1 === ord.indexOf(ids[0])) btn(`← ${nb.name ?? nb.key}의 마지막 구간`, () => { reassignSegment(doc, nb.key, pkg.key, nbIds.at(-1)); save(); refresh(); }, actions);
          if (nb.kind === pkg.kind) btn(`${nb.name ?? nb.key}와 병합`, () => { mergePackages(doc, pkg.key, nb.key, ord); if (selectedKey === nb.key) selectedKey = pkg.key; save(); refresh(); }, actions);
        }
      }
      btn("삭제", () => { removePackage(doc, pkg.key); if (selectedKey === pkg.key) selectedKey = null; save(); refresh(); }, actions);
      row.append(actions);
      panel.append(row);
    }
    for (const n of notes) panel.append(el("div", "diag warning", `⚠ ${n.code}`));
  }

  canvas.addEventListener("pointerdown", (ev) => {
    if (!active || !mode) return;
    ev.stopImmediatePropagation();
    const [x, y] = pointer(ev);
    const mapExport = getMapExport() ?? { plans: [] };
    if (mode.kind === "line-draft") {
      const hit = segmentAt(x, y, mapExport);
      if (!hit || (mode.planId && hit.planId !== mode.planId)) return;
      mode.planId = hit.planId;
      mode.segmentIds = mode.segmentIds.includes(hit.segmentId) ? mode.segmentIds.filter((id) => id !== hit.segmentId) : [...mode.segmentIds, hit.segmentId];
      refresh();
      return;
    }
    if (mode.kind === "station-pick") {
      const hit = planStationAt(x, y, mapExport);
      if (!hit) return;
      const plan = mapExport.plans.find((p) => p.planId === hit.planId);
      const station = plan.stationCandidates.find((s) => s.id === hit.stationId);
      const p = addPackage(doc, { name: station.name ?? "역 공구", kind: "station", planId: hit.planId, stationId: hit.stationId });
      selectedKey = p.key;
      mode = null;
      save(); refresh();
      return;
    }
    if (mode.kind === "split-pick") {
      const hit = segmentAt(x, y, mapExport);
      const pkg = doc.packages.find((p) => p.key === mode.key);
      if (!hit || hit.planId !== pkg.planId || !pkg.segmentIds.includes(hit.segmentId)) return;
      try {
        const { second } = splitPackage(doc, mode.key, hit.segmentId, order(pkg.planId));
        selectedKey = second.key;
      } catch { notes.push({ code: "construction-split-failed" }); }
      mode = null;
      save(); refresh();
    }
  }, true);
  window.addEventListener("keydown", (ev) => {
    if (!active || ["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement?.tagName)) return;
    if (ev.key === "Escape" && mode) { mode = null; refresh(); }
    else if ((ev.key === "Delete" || ev.key === "Backspace") && selectedKey && !mode) { removePackage(doc, selectedKey); selectedKey = null; save(); refresh(); }
  });
  button.addEventListener("click", (ev) => {
    active = !active;
    mode = null;
    button.classList.toggle("active", active);
    ev.currentTarget.blur();
    refresh();
  });

  refresh();
  return {
    refresh,
    get doc() { return doc; },
    get nextKey() { return nextPackageKey(doc); },
    get constructionExport() { return exp ? structuredClone(exp) : null; },
  };
}
