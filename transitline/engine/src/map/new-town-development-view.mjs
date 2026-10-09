// What the new-town development overlay shows, and how it is drawn: the polygons the player drew, in the order they stated, with the
// land use they declared and the order of the phase - and nothing the map cannot know.  A switched-off development or phase is drawn
// faint and dashed, never hidden.  Read-only over the editor document and the NewTownDevelopmentExport: no count of people, homes,
// jobs, demand, traffic, cost or schedule is made or shown, and no colour says that anything is good or bad.
import { keyedDevelopmentId, keyedPhaseId } from "./new-town-development.mjs";
import { activePhases } from "./new-town-development-editor.mjs";

export const NEW_TOWN_VIEW_SCHEMA = "transitline.new-town-development-view/1";
export const PALETTE = Object.freeze(["#2dd4bf", "#f59e0b", "#a78bfa", "#f472b6", "#84cc16", "#60a5fa"]);
const HANDLE_PX = 5;

export const rgba = (hex, alpha) => {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
};
const meanOf = (ring) => (ring?.length ? [ring.reduce((s, p) => s + p[0], 0) / ring.length, ring.reduce((s, p) => s + p[1], 0) / ring.length] : null);

// doc: the editor document; exportData: the NewTownDevelopmentExport built from it (may be null before the first build)
// selection: { developmentKey, phaseKey, vertexIndex }; draft: { points, target } | null; pick: { kind, stations?, lines? } | null
export function buildNewTownDevelopmentView({ doc, exportData = null, selection = {}, mode = null, draft = null, pick = null }) {
  const packId = doc.packId;
  const developments = doc.developments.filter((d) => !d.deleted).map((d, index) => {
    const id = keyedDevelopmentId(packId, d.key);
    const out = exportData?.developments?.find((x) => x.developmentId === id) ?? null;
    const phases = activePhases(d).map((p, i) => {
      const phaseOut = out?.phases.find((x) => x.phaseId === keyedPhaseId(id, p.key)) ?? null;
      return {
        key: p.key, id: keyedPhaseId(id, p.key), name: p.name, active: p.active !== false, sequence: i + 1,
        polygon: p.polygon ? p.polygon.map((pt) => [...pt]) : null, labelAt: meanOf(p.polygon),
        landUse: p.playerDeclaredLandUse, deliveryOrder: p.playerDeclaredDeliveryOrder,
        selected: d.key === selection.developmentKey && p.key === selection.phaseKey, flags: phaseOut ? [...phaseOut.spatialFlags] : [],
      };
    });
    return { key: d.key, id, name: d.name, active: d.active !== false, selected: d.key === selection.developmentKey, color: PALETTE[index % PALETTE.length], phases };
  });
  return {
    schema: NEW_TOWN_VIEW_SCHEMA, mode, developments, vertexIndex: selection.vertexIndex ?? null,
    draft: draft ? { points: draft.points.map((p) => [...p]), target: { ...draft.target } } : null,
    pick: pick ? { kind: pick.kind, stations: (pick.stations ?? []).map((s) => ({ location: [...s.location], picked: Boolean(s.picked) })), lines: (pick.lines ?? []).map((l) => ({ line: l.line.map((p) => [...p]), picked: Boolean(l.picked) })) } : null,
  };
}

function path(ctx, pts, close = false) {
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  if (close) ctx.closePath();
}

// `screen` maps [lon, lat] to canvas pixels.
export function drawNewTownDevelopmentOverlay(ctx, model, screen) {
  ctx.save();
  ctx.lineJoin = "round";
  if (model.pick) {
    // the references the player may pick: thin lines and small stations, only while picking
    ctx.setLineDash([]);
    for (const l of model.pick.lines) { ctx.strokeStyle = l.picked ? "#ffe66d" : "rgba(170, 177, 192, 0.7)"; ctx.lineWidth = l.picked ? 3 : 1.5; path(ctx, l.line.map(screen)); ctx.stroke(); }
    for (const s of model.pick.stations) { const [x, y] = screen(s.location); ctx.fillStyle = s.picked ? "#ffe66d" : "rgba(241, 242, 245, 0.85)"; ctx.beginPath(); ctx.arc(x, y, s.picked ? 5 : 3.5, 0, Math.PI * 2); ctx.fill(); }
  }
  for (const dev of model.developments) {
    for (const phase of dev.phases) {
      if (!phase.polygon) continue;
      const dim = !dev.active || !phase.active;
      ctx.fillStyle = rgba(dev.color, dim ? 0.08 : phase.selected ? 0.4 : 0.22);
      ctx.strokeStyle = rgba(dev.color, dim ? 0.4 : 1);
      ctx.lineWidth = phase.selected ? 3 : 2;
      ctx.setLineDash(dim ? [3, 4] : []);
      path(ctx, phase.polygon.map(screen), true);
      ctx.fill();
      ctx.stroke();
      ctx.setLineDash([]);
      const [lx, ly] = screen(phase.labelAt);
      const label = `${phase.sequence}. ${phase.name ?? "단계"}${phase.landUse ? ` · ${phase.landUse}` : ""}${phase.deliveryOrder ? ` · 인도 ${phase.deliveryOrder}` : ""}${dim ? " (비활성)" : ""}`;
      ctx.font = "bold 11px Inter, system-ui, 'Malgun Gothic', sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.lineWidth = 3;
      ctx.strokeStyle = "#111318";
      ctx.strokeText(label, lx, ly);
      ctx.fillStyle = dim ? "rgba(241, 242, 245, 0.55)" : "#f1f2f5"; // light text over the area's own colour
      ctx.fillText(label, lx, ly);
    }
  }
  // the vertices of the selected phase: handles to pick and drag
  const selected = model.developments.flatMap((d) => d.phases).find((p) => p.selected && p.polygon);
  if (selected) {
    selected.polygon.map(screen).forEach(([x, y], i) => {
      const on = i === model.vertexIndex;
      ctx.fillStyle = on ? "#ffe66d" : "#f1f2f5";
      ctx.strokeStyle = "#111318";
      ctx.lineWidth = 1.5;
      const r = on ? HANDLE_PX + 2 : HANDLE_PX;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
      ctx.strokeRect(x - r, y - r, r * 2, r * 2);
    });
  }
  // the polygon being drawn right now
  if (model.draft?.points.length) {
    const pts = model.draft.points.map(screen);
    ctx.strokeStyle = "#f1f2f5";
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 5]);
    path(ctx, pts);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#f1f2f5";
    for (const [x, y] of pts) { ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2); ctx.fill(); }
  }
  ctx.restore();
}
