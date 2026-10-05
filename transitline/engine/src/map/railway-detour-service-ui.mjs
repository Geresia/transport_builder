// Detour service over another company's track, browser side: an independent mount that needs nothing from the host page
// beyond a canvas, its projection, a pack and getters for the live map facts (rail capacity geometry and application,
// disruption sites, service control geometries, through routes, the existing-infrastructure catalog and networks, station
// sites). The player picks one of the active control geometries' detour candidates, sees the M9 geometry on the map,
// picks legs / connections / transfers, and draws connection lines and transfer passages by hand. It makes its own
// overlay canvas, panel and <style>, so main.mjs / index.html / style.css stay untouched. It edits only its own plan
// document (saved in localStorage); every input is read, never written, and nothing here estimates, judges, prices or
// times anything: whether a train may run, compatibility, agreements, charges and timetables belong to the management
// engine. A line the player draws is the player's: it never changes a source connection's true / false / null.
//
//   const bridge = mountRailwayDetourService({ canvas, projection, pack, getRailGeometry, getRailCapacityApplication,
//     getDisruptionSites, getServiceControls, getThroughRoutes, getExternalCatalog, getExternalNetworks, getStationSites, getSpatial, onChange });
//   bridge.output()  ->  { document, export, picks, selected, selectedPlan, warnings }
import { buildRailwayDetourServiceExport } from "./railway-detour-service.mjs";
import {
  activePlans, addPlan, clearPicks, deactivatePlan, newRailwayDetourDoc, offered, pick, picksOf, reconcilePlan, removeConnection, removeTransferPath, restorePlan,
  restoreRailwayDetourDoc, serializeRailwayDetourDoc, setConnection, setTransferPath, toDetourDocument, unpick,
} from "./railway-detour-service-editor.mjs";
import { CONNECTION_STYLES, buildRailwayDetourView, drawRailwayDetourOverlay } from "./railway-detour-service-view.mjs";

export const DETOUR_UI_EVENT = "transitline:railway-detour-service";
export const DETOUR_STORAGE_PREFIX = "transitline.railway-detour.v1:";
export const SCOPE_NOTICE = "이 화면은 지도의 접속·위치 사실과 플레이어의 선택만 다룹니다. 운행·협정·요금·배차는 경영 엔진이 정합니다.";
export const PLAYER_LINE_NOTICE = "플레이어가 그린 연결선은 접속 사실(true/false/null)을 바꾸지 않습니다.";
export const STATE_LABELS = Object.freeze({ true: "측정상 연결(true)", false: "실제로 끊김(false)", null: "측정 못 함·미상(null)" });
export const STATE_COLORS = Object.freeze({ true: "#22c55e", false: "#ef4444", null: "#9ca3af" });
const SNAP_PX = 12;
const HIT_PX = 9;
const STYLE_ID = "transitline-railway-detour-style";
const CSS = `
.tl-detour-panel{position:fixed;right:12px;bottom:64px;z-index:7;width:340px;max-height:60vh;overflow:auto;padding:8px 10px;border:1px solid #2a2f3a;border-radius:8px;background:rgba(17,19,24,.94);color:#f1f2f5;font:12px/1.4 system-ui,'Malgun Gothic',sans-serif}
.tl-detour-panel .section-label{margin:6px 0 3px;color:#ffe66d;font-weight:600}
.tl-detour-panel .diag{margin:3px 0;padding:3px 6px;border-left:3px solid #4cc9f0;border-radius:3px;font-size:11px;overflow-wrap:anywhere}
.tl-detour-panel .diag.warning{border-left-color:#ffb703}
.tl-detour-panel .diag.info{color:#aab1c0}
.tl-detour-panel .state-true{border-left-color:#22c55e}.tl-detour-panel .state-false{border-left-color:#ef4444}.tl-detour-panel .state-null{border-left-color:#9ca3af}
.tl-detour-panel .row{display:flex;align-items:center;gap:6px;margin:2px 0}.tl-detour-panel .row.picked{background:rgba(255,255,255,.08)}
.tl-detour-panel button{margin:2px 3px 2px 0;padding:2px 7px}.tl-detour-panel button.on{outline:2px solid #f1f2f5}
`;

const clone = (v) => structuredClone(v);
const arr = (v, key) => (Array.isArray(v) ? v : v && Array.isArray(v[key]) ? v[key] : v ? [v] : []);
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const planKey = (eventId, candidateId) => `${eventId}|${candidateId}`;

// The inputs as lists, whatever shape the host hands them in (a single object, a list, or the builder's own export).
export function readDetourInputs(get) {
  return {
    geometries: arr(get.getRailGeometry?.(), "designs"), applications: arr(get.getRailCapacityApplication?.(), "applications"), sites: arr(get.getDisruptionSites?.(), "sites"),
    controls: arr(get.getServiceControls?.(), "controls"), routes: arr(get.getThroughRoutes?.(), "routes"), catalog: get.getExternalCatalog?.() ?? null,
    networks: arr(get.getExternalNetworks?.(), "networks"), stationSites: arr(get.getStationSites?.(), "sites"),
  };
}
// a cheap fingerprint of the inputs: revisions are content hashes, so a change anywhere shows up here
const fingerprint = (i) => JSON.stringify([
  i.geometries.map((g) => [g.railGeometryId, g.railGeometryRevision]), i.applications.map((a) => [a.railGeometryId, a.railGeometryRevision, (a.sections ?? []).length]), i.sites.map((s) => [s.eventId, s.siteRevision]),
  i.controls.map((c) => [c.eventId, c.controlGeometryRevision, (c.detourCandidates ?? []).map((d) => d.candidateId)]), i.routes.map((r) => [r.throughRouteId, r.geometryRevision]),
  i.catalog ? [i.catalog.packId, (i.catalog.entries ?? []).map((e) => [e.legId, e.specificationId, e.specificationRevision, e.infrastructureOwnerId])] : null,
  i.networks.map((n) => [n.id, n.infrastructureOwnerId ?? null, (n.lines ?? []).map((l) => [l.id, l.infrastructureOwnerId ?? null])]), i.stationSites.map((s) => [s.stationSiteId, s.connectedStationId, (s.entranceCandidates ?? []).map((e) => e.entranceId)]),
]);

// the detour candidates the active control geometries offer (and nothing else)
export const candidatesOf = (controls) => controls.flatMap((c) => (c.detourCandidates ?? []).map((d) => ({ eventId: c.eventId, candidateId: d.candidateId, sections: d.sectionIds.length, externalLines: d.externalLineIds.length, physicalConnection: d.physicalConnection, alignment: d.alignment, controlGeometryRevision: c.controlGeometryRevision })))
  .sort((a, b) => byText(planKey(a.eventId, a.candidateId), planKey(b.eventId, b.candidateId)));

// The player looked at the current control geometry again and keeps the plan: its revision is recorded and the picks the
// detour no longer offers are dropped. The drawings are the player's and stay.
export function rebindDetourPlan(doc, eventId, candidateId, control, detour = null) {
  const plan = doc.plans.find((p) => p.eventId === eventId && p.detourCandidateId === candidateId);
  if (!plan) throw new Error(`Unknown detour plan ${eventId} / ${candidateId}`);
  if (!(control?.detourCandidates ?? []).some((c) => c.candidateId === candidateId)) throw new Error(`Unknown detour candidate ${candidateId}`);
  plan.selectedOnControlGeometryRevision = control.controlGeometryRevision;
  if (detour) {
    for (const [kind, list] of [["leg", "legIds"], ["connection", "connectionIds"], ["transfer", "transferIds"]]) plan.picked[list] = plan.picked[list].filter((id) => offered(detour, kind).includes(id));
    plan.selectedOnDetourGeometryRevision = detour.detourGeometryRevision;
  }
  return plan;
}

// --- hit testing in screen space (pure: the tests use it without a DOM) ---
const dist2 = (p, a, b) => {
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
  const l2 = dx * dx + dy * dy;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2));
  return Math.hypot(p[0] - (a[0] + dx * t), p[1] - (a[1] + dy * t));
};
const nearLine = (p, pts) => (pts.length < 2 ? Infinity : Math.min(...pts.slice(1).map((q, i) => dist2(p, pts[i], q))));
// The item of a detour view model nearest to a click: connection markers first, then the player's lines, transfer links and legs.
export function pickDetourItem(model, screen, point, radius = HIT_PX) {
  let best = null;
  const offer = (kind, id, d, rank) => { if (d <= radius && (!best || d < best.d - 1e-9 || (Math.abs(d - best.d) <= 1e-9 && rank < best.rank))) best = { kind, id, d, rank }; };
  for (const d of model?.detours ?? []) {
    for (const c of d.connections) for (const loc of c.location ? [c.location] : c.viaLocations ?? []) if (loc) offer("connection", c.connectionId, Math.hypot(...screen(loc).map((v, i) => v - point[i])), 0);
    for (const p of d.playerConnections) offer("connection", p.playerConnectionId, nearLine(point, p.polyline.map(screen)), 1);
    for (const p of d.transferPaths) offer("transfer", p.transferPathId, nearLine(point, p.polyline.map(screen)), 1);
    for (const t of d.transferLinks) if (t.from && t.to) offer("transfer", t.transferLinkId, dist2(point, screen(t.from), screen(t.to)), 2);
    for (const l of d.legs) {
      if (l.alignment) offer("leg", l.legId, nearLine(point, l.alignment.map(screen)), 3);
      else if (l.fromLocation) offer("leg", l.legId, Math.hypot(...screen(l.fromLocation).map((v, i) => v - point[i])), 3);
    }
  }
  return best ? { kind: best.kind, id: best.id } : null;
}
// the stations (and, for a transfer passage, entrances) of a detour view model within a few pixels of a click
export function snapDetourPoint(model, screen, point, { entrances = false, radius = SNAP_PX } = {}) {
  let best = null;
  for (const d of model?.detours ?? []) {
    for (const s of d.stations) {
      if (s.location) { const dd = Math.hypot(...screen(s.location).map((v, i) => v - point[i])); if (dd <= radius && (!best || dd < best.d)) best = { d: dd, location: s.location }; }
      if (entrances) for (const e of s.entrances) { const dd = Math.hypot(...screen(e.location).map((v, i) => v - point[i])); if (dd <= radius && (!best || dd < best.d)) best = { d: dd, location: e.location }; }
    }
  }
  return best ? clone(best.location) : null;
}

export function mountRailwayDetourService({
  canvas, projection, pack, getRailGeometry, getRailCapacityApplication, getDisruptionSites, getServiceControls, getThroughRoutes, getExternalCatalog, getExternalNetworks, getStationSites,
  getSpatial = () => null, onChange = () => {}, enabled = true, autoRefreshMs = 250,
}) {
  void getSpatial; // the detour geometry reads no spatial layer: accepted so the host can pass the same getters as the other map UIs
  const doc = canvas.ownerDocument;
  const win = doc.defaultView;
  if (!doc.getElementById(STYLE_ID)) { const s = doc.createElement("style"); s.id = STYLE_ID; s.textContent = CSS; doc.head.append(s); }
  const layer = doc.createElement("canvas");
  layer.style.cssText = "position:fixed;pointer-events:none;z-index:6";
  (canvas.parentNode ?? doc.body).append(layer);
  const box = doc.createElement("div");
  box.className = "tl-detour-panel";
  box.hidden = true;
  doc.body.append(box);

  const packId = pack.manifest?.id ?? "pack";
  const storageKey = `${DETOUR_STORAGE_PREFIX}${packId}`;
  const notes = [];
  let plans = newRailwayDetourDoc(packId, pack.manifest?.version ?? null);
  const open = (text) => { const r = restoreRailwayDetourDoc(text, pack); plans = r.doc; notes.push(...r.warnings); };
  let stored = null;
  try { stored = win.localStorage.getItem(storageKey); } catch { /* storage may be blocked: start empty */ }
  open(stored);
  const save = () => { try { win.localStorage.setItem(storageKey, serializeRailwayDetourDoc(plans)); } catch { notes.push({ code: "railway-detour-doc-not-saved" }); } };

  let enabledNow = enabled;
  let selected = null; // { eventId, candidateId }
  let mode = null; // null | "draw-connection" | "draw-transfer"
  let draft = { points: [], key: null, name: null };
  let dirty = true;
  let lastFingerprint = null;
  // a counter that moves whenever anything the panel, the map layer or the output shows may have changed
  let version = 0;
  let panelVersion = -1;
  let drawVersion = -1;
  let outputVersion = -1;
  let lastRect = "";
  let inputs = readDetourInputs({});
  let built = { exportData: { detours: [], warnings: [] }, detour: null, model: { detours: [], warnings: [] }, issues: [], candidates: [] };

  const screen = (loc) => projection.toScreen(loc, canvas.width, canvas.height);
  const origin = pack.manifest.origin;
  const lonLat = (x, y) => { // toScreen is affine in lon/lat, so its inverse follows from two sample points
    const o = screen(origin);
    const u = screen([origin[0] + 1, origin[1] + 1]);
    return [origin[0] + (x - o[0]) / (u[0] - o[0]), origin[1] + (y - o[1]) / (u[1] - o[1])];
  };
  const el = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const pointer = (ev) => { const r = canvas.getBoundingClientRect(); return [ev.clientX - r.left, ev.clientY - r.top]; };
  const planOf = (sel = selected) => (sel ? plans.plans.find((p) => p.eventId === sel.eventId && p.detourCandidateId === sel.candidateId) ?? null : null);
  const controlOf = (eventId) => inputs.controls.find((c) => c?.eventId === eventId) ?? null;
  const bump = () => { version += 1; };
  const note = (code, extra = {}) => { notes.push({ code, ...extra }); bump(); };

  function recompute() {
    inputs = readDetourInputs({ getRailGeometry, getRailCapacityApplication, getDisruptionSites, getServiceControls, getThroughRoutes, getExternalCatalog, getExternalNetworks, getStationSites });
    const documents = activePlans(plans).map(toDetourDocument);
    const exportData = buildRailwayDetourServiceExport({
      pack, sites: inputs.sites, controls: inputs.controls, railGeometries: inputs.geometries, applications: inputs.applications, routes: inputs.routes,
      externalCatalog: inputs.catalog, externalNetworks: inputs.networks, stationSites: inputs.stationSites, documents,
    });
    const detour = selected ? exportData.detours.find((d) => d.eventId === selected.eventId && d.selectedDetourCandidateId === selected.candidateId) ?? null : null;
    // what the player's plans are now against the control geometries: none of this is estimated, only compared
    const issues = [];
    for (const p of activePlans(plans)) {
      const control = controlOf(p.eventId);
      const d = exportData.detours.find((x) => x.eventId === p.eventId && x.selectedDetourCandidateId === p.detourCandidateId) ?? null;
      if (!control) { issues.push({ code: "railway-detour-control-missing", eventId: p.eventId, detourCandidateId: p.detourCandidateId }); continue; }
      const r = reconcilePlan(plans, p.eventId, p.detourCandidateId, control, d);
      if (!r.offered) issues.push({ code: "railway-detour-plan-not-offered", eventId: p.eventId, detourCandidateId: p.detourCandidateId });
      else if (r.outdated) issues.push({ code: "railway-detour-plan-outdated", eventId: p.eventId, detourCandidateId: p.detourCandidateId });
      for (const s of r.stale) issues.push({ code: "railway-detour-pick-stale", eventId: p.eventId, detourCandidateId: p.detourCandidateId, kind: s.kind, id: s.id });
    }
    const model = buildRailwayDetourView({ exportData: { ...exportData, detours: detour ? [detour] : [] }, picks: picksOf(plans), selectedId: detour?.detourGeometryId ?? null });
    built = { exportData, detour, model, issues, candidates: candidatesOf(inputs.controls) };
    bump();
  }

  const warningsNow = () => [...notes, ...built.exportData.warnings, ...built.issues];
  const outputNow = () => ({
    document: clone(plans), export: built.exportData, picks: picksOf(plans), selected: built.detour, selectedPlan: selected ? { ...selected } : null, warnings: warningsNow(),
  });
  function emit() {
    if (outputVersion === version) return;
    outputVersion = version;
    const out = outputNow();
    onChange(out);
    canvas.dispatchEvent(new CustomEvent(DETOUR_UI_EVENT, { detail: out }));
  }

  // --- drawing on the map ---
  function drawLayer() {
    const rect = canvas.getBoundingClientRect();
    Object.assign(layer.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px`, display: enabledNow ? "" : "none" });
    const rectKey = `${canvas.width}|${canvas.height}|${rect.left}|${rect.top}`;
    if (drawVersion === version && rectKey === lastRect) return;
    drawVersion = version;
    lastRect = rectKey;
    if (layer.width !== canvas.width || layer.height !== canvas.height) { layer.width = canvas.width; layer.height = canvas.height; }
    const ctx = layer.getContext("2d");
    ctx.clearRect(0, 0, layer.width, layer.height);
    if (!enabledNow) return;
    // the candidates that have no plan yet: their alignment, faint, only where the control geometry has one
    ctx.save();
    ctx.strokeStyle = "#6b7280";
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 6]);
    for (const c of built.candidates) {
      if (!c.alignment || (selected && selected.eventId === c.eventId && selected.candidateId === c.candidateId && built.detour)) continue;
      ctx.beginPath();
      c.alignment.map(screen).forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.stroke();
    }
    ctx.restore();
    drawRailwayDetourOverlay(ctx, built.model, screen);
    // the state of every source connection, in a colour that cannot be mistaken: green true, red false, grey null
    for (const d of built.model.detours) {
      for (const c of d.connections) {
        const state = c.style.key === "joined" ? "true" : c.style.key === "apart" ? "false" : "null";
        for (const loc of c.location ? [c.location] : c.viaLocations ?? []) {
          if (!loc) continue;
          const [x, y] = screen(loc);
          ctx.save();
          ctx.strokeStyle = STATE_COLORS[state];
          ctx.lineWidth = 3;
          ctx.setLineDash(state === "null" ? [3, 3] : []);
          ctx.beginPath();
          ctx.arc(x, y, 10, 0, Math.PI * 2);
          ctx.stroke();
          ctx.restore();
        }
      }
    }
    if (mode && draft.points.length) {
      ctx.save();
      ctx.strokeStyle = mode === "draw-connection" ? "#fbbf24" : "#f472b6";
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 5]);
      ctx.beginPath();
      draft.points.map(screen).forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "#f1f2f5";
      for (const [x, y] of draft.points.map(screen)) { ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2); ctx.fill(); }
      ctx.restore();
    }
  }

  // --- the panel ---
  function renderPanel() {
    box.replaceChildren();
    box.hidden = !enabledNow;
    if (!enabledNow) return;
    const button = (parent, label, fn, cls = "") => { const b = el("button", cls, label); b.type = "button"; b.addEventListener("click", (e) => { e.stopPropagation?.(); fn(); }); parent.append(b); return b; };
    box.append(el("div", "section-label", "타사 선로 우회 (지도 편집)"));
    box.append(el("div", "diag info", SCOPE_NOTICE));
    box.append(el("div", "diag info", PLAYER_LINE_NOTICE));
    box.append(el("div", "section-label", "우회 후보"));
    if (!built.candidates.length) box.append(el("div", "diag warning", "선택할 수 있는 우회 후보가 없습니다 (관제 후보 자료가 없거나 우회가 없음)."));
    for (const c of built.candidates) {
      const row = el("div", `row${selected && selected.eventId === c.eventId && selected.candidateId === c.candidateId ? " picked" : ""}`);
      const mine = plans.plans.find((p) => p.eventId === c.eventId && p.detourCandidateId === c.candidateId);
      row.append(el("span", `state-${c.physicalConnection}`, `${c.eventId} · 구간 ${c.sections} · 기존선 ${c.externalLines}${mine ? (mine.active === false ? " · 꺼짐" : " · 계획 있음") : ""}`));
      button(row, mine ? "선택" : "계획 만들기", () => choose(c.eventId, c.candidateId));
      box.append(row);
    }
    const plan = planOf();
    if (plan) {
      box.append(el("div", "section-label", "선택한 우회 계획"));
      const bar = el("div");
      if (mode) {
        box.append(el("div", "diag info", "지도에서 점을 클릭해 선을 그리고 완료(또는 더블클릭/Enter)를 누르세요. 역 가까이 클릭하면 역에 붙습니다."));
        button(bar, "완료", () => finishDrawing());
        button(bar, "취소", () => cancelDrawing());
      } else {
        button(bar, "연결선 그리기", () => startDrawing("connection"));
        button(bar, "환승 동선 그리기", () => startDrawing("transfer"));
        button(bar, "선택 해제", () => clearAllPicks());
        button(bar, plan.active === false ? "계획 켜기" : "계획 끄기", () => setPlanActive(plan.active === false));
        button(bar, "계획 선택 해제", () => deselect());
      }
      box.append(bar);
      const d = built.detour;
      if (!d) box.append(el("div", "diag warning", "이 계획의 우회 geometry를 만들 수 없습니다: 아래 경고를 확인하세요. 값을 추정하지 않습니다."));
      if (built.issues.some((i) => i.eventId === plan.eventId && i.detourCandidateId === plan.detourCandidateId && ["railway-detour-plan-outdated", "railway-detour-pick-stale"].includes(i.code))) button(box, "현재 관제 후보로 다시 확인", () => rebind());
      if (d) {
        const m = built.model.detours[0];
        const picked = plan.picked;
        const rowFor = (parent, text, kindName, id, isPicked, cls = "") => {
          const row = el("div", `row ${cls}${isPicked ? " picked" : ""}`);
          row.append(el("span", cls, `${isPicked ? "✔ " : ""}${text}`));
          button(row, isPicked ? "해제" : "선택", () => togglePick(kindName, id), isPicked ? "on" : "");
          parent.append(row);
        };
        box.append(el("div", "section-label", `구간 ${d.legs.length}`));
        d.legs.forEach((l, i) => rowFor(box, `${i + 1}. ${l.sourceKind === "external" ? "기존선 (선형 자료 없음, 역 위치만)" : "계획선"} · ${l.lengthMeters === null ? "길이 미상" : `${Math.round(l.lengthMeters)} m`} · ${l.infrastructureOwnerId === null ? "소유자 자료 없음" : `소유자 ${l.infrastructureOwnerId}`}`, "leg", l.legId, picked.legIds.includes(l.legId)));
        box.append(el("div", "section-label", `접속 ${d.connections.length}`));
        for (const c of d.connections) {
          const s = String(c.physicalConnection);
          rowFor(box, `${CONNECTION_STYLES[s].glyph} ${c.kind === "handover-link" ? "두 역을 잇는 연결" : "같은 역에서 만남"} · ${STATE_LABELS[s]}${c.gapMeters === null ? " · 간격 미상" : ` · 간격 ${c.gapMeters} m`}`, "connection", c.connectionId, picked.connectionIds.includes(c.connectionId), `state-${s}`);
        }
        if (d.transferLinks.length) box.append(el("div", "section-label", "환승 연결 (직선 거리만)"));
        for (const t of d.transferLinks) rowFor(box, `환승 연결 · ${t.straightDistanceMeters === null ? "직선 거리 미상" : `직선 ${t.straightDistanceMeters} m`} (보행 경로 아님)`, "transfer", t.transferLinkId, picked.transferIds.includes(t.transferLinkId));
        box.append(el("div", "section-label", "플레이어가 그린 연결선"));
        if (d.playerConnections === null || !d.playerConnections.length) box.append(el("div", "diag info", "그린 연결선 없음"));
        for (const p of d.playerConnections ?? []) {
          const row = el("div", `row${picked.connectionIds.includes(p.playerConnectionId) ? " picked" : ""}`);
          row.append(el("span", "", `${picked.connectionIds.includes(p.playerConnectionId) ? "✔ " : ""}${p.name ?? p.key} · 플레이어가 그림 · ${Math.round(p.lengthMeters)} m · 역에 닿음 ${p.joinedAtBothEnds === null ? "미상" : p.joinedAtBothEnds ? "예" : "아니오"}`));
          button(row, picked.connectionIds.includes(p.playerConnectionId) ? "해제" : "선택", () => togglePick("connection", p.playerConnectionId));
          button(row, "다시 그리기", () => redraw("connection", p.key));
          button(row, "삭제", () => removeDrawing("connection", p.key));
          box.append(row);
        }
        box.append(el("div", "section-label", "플레이어가 그린 환승 동선"));
        if (d.playerTransferPaths === null || !d.playerTransferPaths.length) box.append(el("div", "diag info", "그린 환승 동선 없음"));
        for (const p of d.playerTransferPaths ?? []) {
          const row = el("div", `row${picked.transferIds.includes(p.transferPathId) ? " picked" : ""}`);
          row.append(el("span", "", `${picked.transferIds.includes(p.transferPathId) ? "✔ " : ""}${p.name ?? p.key} · 플레이어가 그림 · ${Math.round(p.lengthMeters)} m`));
          button(row, picked.transferIds.includes(p.transferPathId) ? "해제" : "선택", () => togglePick("transfer", p.transferPathId));
          button(row, "다시 그리기", () => redraw("transfer", p.key));
          button(row, "삭제", () => removeDrawing("transfer", p.key));
          box.append(row);
        }
        for (const f of m.flags) box.append(el("div", "diag warning", `⚠ ${f.label}`));
      }
    }
    box.append(el("div", "section-label", "접속 표시"));
    for (const s of ["true", "false", "null"]) box.append(el("div", `diag state-${s}`, `${CONNECTION_STYLES[s].glyph} ${STATE_LABELS[s]}`));
    for (const w of warningsNow()) box.append(el("div", "diag warning", `⚠ ${w.code}${w.reasons?.[0]?.code ? ` (${w.reasons[0].code})` : ""}`));
  }

  function refresh() {
    const fp = fingerprint(readDetourInputs({ getRailGeometry, getRailCapacityApplication, getDisruptionSites, getServiceControls, getThroughRoutes, getExternalCatalog, getExternalNetworks, getStationSites }));
    if (dirty || fp !== lastFingerprint) { lastFingerprint = fp; dirty = false; recompute(); }
    drawLayer();
    if (panelVersion !== version) { panelVersion = version; renderPanel(); }
    emit();
  }
  const touch = () => { dirty = true; };

  // --- operations (each one is also on the returned API) ---
  function choose(eventId, candidateId) {
    const control = controlOf(eventId);
    try { addPlan(plans, eventId, candidateId, control); } catch (error) { note("railway-detour-candidate-not-offered", { eventId, detourCandidateId: candidateId, message: error.message }); touch(); refresh(); return false; }
    const plan = planOf({ eventId, candidateId });
    if (plan.active === false) restorePlan(plans, eventId, candidateId);
    selected = { eventId, candidateId };
    bump();
    save();
    touch();
    refresh();
    return true;
  }
  function deselect() { selected = null; mode = null; draft = { points: [], key: null, name: null }; bump(); refresh(); }
  function togglePick(kind, id) {
    const plan = planOf();
    if (!plan || !built.detour) { note("railway-detour-no-plan-selected"); touch(); refresh(); return false; }
    const list = { leg: "legIds", connection: "connectionIds", transfer: "transferIds" }[kind];
    try {
      if (list && plan.picked[list].includes(id)) unpick(plans, plan.eventId, plan.detourCandidateId, kind, id);
      else pick(plans, plan.eventId, plan.detourCandidateId, kind, id, built.detour);
    } catch (error) { note("railway-detour-pick-refused", { kind, id, message: error.message }); touch(); refresh(); return false; }
    save();
    touch();
    refresh();
    return true;
  }
  function pickItem(kind, id) { const plan = planOf(); if (plan && plan.picked[{ leg: "legIds", connection: "connectionIds", transfer: "transferIds" }[kind]]?.includes(id)) return true; return togglePick(kind, id); }
  function unpickItem(kind, id) { const plan = planOf(); if (!plan) return false; unpick(plans, plan.eventId, plan.detourCandidateId, kind, id); save(); touch(); refresh(); return true; }
  function clearAllPicks() { const plan = planOf(); if (plan) { clearPicks(plans, plan.eventId, plan.detourCandidateId); save(); touch(); } refresh(); }
  function setPlanActive(active) { const plan = planOf(); if (plan) { (active ? restorePlan : deactivatePlan)(plans, plan.eventId, plan.detourCandidateId); save(); touch(); } refresh(); }
  function rebind() {
    const plan = planOf();
    if (!plan) return false;
    try { rebindDetourPlan(plans, plan.eventId, plan.detourCandidateId, controlOf(plan.eventId), built.detour); } catch (error) { note("railway-detour-rebind-refused", { message: error.message }); touch(); refresh(); return false; }
    save();
    touch();
    refresh();
    return true;
  }
  const keysOf = (plan, kind) => (kind === "connection" ? plan.connections : plan.transferPaths) ?? [];
  const nextKey = (plan, kind) => { const used = new Set(keysOf(plan, kind).map((x) => x.key)); let n = 1; while (used.has(`${kind}-${n}`)) n += 1; return `${kind}-${n}`; };
  function startDrawing(kind, { key = null, name = null } = {}) {
    if (!planOf() || !["connection", "transfer"].includes(kind)) return false;
    mode = kind === "connection" ? "draw-connection" : "draw-transfer";
    draft = { points: [], key, name };
    bump();
    refresh();
    return true;
  }
  function cancelDrawing() { mode = null; draft = { points: [], key: null, name: null }; bump(); refresh(); }
  function addDraftPoint(location) { if (mode) { draft.points.push(clone(location)); bump(); refresh(); } }
  function finishDrawing() {
    const plan = planOf();
    if (!plan || !mode) return false;
    if (draft.points.length < 2) { note("railway-detour-line-needs-two-points"); refresh(); return false; }
    const kind = mode === "draw-connection" ? "connection" : "transfer";
    const key = draft.key ?? nextKey(plan, kind);
    const item = { key, name: draft.name ?? `${kind === "connection" ? "연결선" : "환승 동선"} ${keysOf(plan, kind).length + (draft.key ? 0 : 1)}`, polyline: draft.points };
    (kind === "connection" ? setConnection : setTransferPath)(plans, plan.eventId, plan.detourCandidateId, item);
    mode = null;
    draft = { points: [], key: null, name: null };
    bump();
    save();
    touch();
    refresh();
    return key;
  }
  // a finished line replaces the one with the same key, so its id stays; the old drawing is kept until the new one is finished
  function redraw(kind, key) {
    const plan = planOf();
    const old = plan ? keysOf(plan, kind).find((x) => x.key === key) : null;
    return old ? startDrawing(kind, { key, name: old.name ?? null }) : false;
  }
  function removeDrawing(kind, key) {
    const plan = planOf();
    if (!plan) return false;
    const drawn = built.detour ? (kind === "connection" ? built.detour.playerConnections : built.detour.playerTransferPaths)?.find((p) => p.key === key) : null;
    const id = drawn ? (kind === "connection" ? drawn.playerConnectionId : drawn.transferPathId) : null;
    if (id) { const list = { connection: "connectionIds", transfer: "transferIds" }[kind]; plan.picked[list] = plan.picked[list].filter((x) => x !== id); }
    (kind === "connection" ? removeConnection : removeTransferPath)(plans, plan.eventId, plan.detourCandidateId, key);
    save();
    touch();
    refresh();
    return true;
  }
  // Replaces the whole document (e.g. from the host's own save). A document that is refused (another pack, unreadable, another
  // version) leaves the current plans exactly as they are and is only reported; a pack version change is flagged but accepted.
  function loadDoc(source) {
    if (source === null || source === undefined) return [];
    const before = notes.length;
    const incoming = restoreRailwayDetourDoc(typeof source === "string" ? source : JSON.stringify(source), pack);
    if (incoming.warnings.some((w) => ["railway-detour-doc-other-pack", "railway-detour-doc-unreadable", "railway-detour-doc-version"].includes(w.code))) {
      notes.push(...incoming.warnings);
      bump();
      refresh();
      return notes.slice(before);
    }
    plans = incoming.doc;
    notes.push(...incoming.warnings);
    selected = null;
    mode = null;
    draft = { points: [], key: null, name: null };
    bump();
    save();
    touch();
    refresh();
    return notes.slice(before);
  }

  // --- pointer, keyboard ---
  const onPointerDown = (ev) => {
    if (!enabledNow) return;
    ev.stopImmediatePropagation?.();
    const p = pointer(ev);
    if (mode && planOf()) {
      const snapped = snapDetourPoint(built.model, screen, p, { entrances: mode === "draw-transfer" });
      addDraftPoint(snapped ?? lonLat(p[0], p[1]));
      return;
    }
    const hit = planOf() && built.detour ? pickDetourItem(built.model, screen, p) : null;
    if (hit) { togglePick(hit.kind, hit.id); return; }
    // a faint candidate on the map starts (or selects) its plan
    const near = built.candidates.map((c) => ({ c, d: c.alignment ? nearLine(p, c.alignment.map(screen)) : Infinity })).filter((x) => x.d <= HIT_PX).sort((a, b) => a.d - b.d)[0];
    if (near) choose(near.c.eventId, near.c.candidateId);
  };
  canvas.addEventListener("pointerdown", onPointerDown, true);
  const onDblClick = () => { if (enabledNow && mode) finishDrawing(); };
  canvas.addEventListener("dblclick", onDblClick);
  const onKey = (ev) => {
    if (!enabledNow || ["INPUT", "SELECT", "TEXTAREA"].includes(doc.activeElement?.tagName)) return;
    if (ev.key === "Enter" && mode) finishDrawing();
    else if (ev.key === "Escape") { if (mode) cancelDrawing(); else deselect(); }
  };
  win.addEventListener("keydown", onKey);
  win.addEventListener("resize", refresh);
  const timer = autoRefreshMs > 0 ? win.setInterval(refresh, autoRefreshMs) : null;
  refresh();

  return {
    output: outputNow,
    choose, select: choose, deselect, pick: pickItem, unpick: unpickItem, togglePick, clearPicks: clearAllPicks, setPlanActive, rebind,
    startDrawing, cancelDrawing, addDraftPoint, finishDrawing, redraw, removeDrawing,
    addPlayerConnection(polyline, { key = null, name = null } = {}) { if (!startDrawing("connection", { key, name })) return false; for (const p of polyline) draft.points.push(clone(p)); return finishDrawing(); },
    addPlayerTransferPath(polyline, { key = null, name = null } = {}) { if (!startDrawing("transfer", { key, name })) return false; for (const p of polyline) draft.points.push(clone(p)); return finishDrawing(); },
    save() { save(); },
    serialize: () => serializeRailwayDetourDoc(plans),
    loadDoc,
    refresh,
    setEnabled(value) { enabledNow = Boolean(value); bump(); refresh(); },
    get selectedPlan() { return selected ? { ...selected } : null; },
    get mode() { return mode; },
    get document() { return clone(plans); },
    get storageKey() { return storageKey; },
    destroy() {
      canvas.removeEventListener("pointerdown", onPointerDown, true);
      canvas.removeEventListener("dblclick", onDblClick);
      win.removeEventListener("keydown", onKey);
      win.removeEventListener("resize", refresh);
      if (timer !== null) win.clearInterval(timer);
      layer.remove();
      box.remove();
    },
  };
}
