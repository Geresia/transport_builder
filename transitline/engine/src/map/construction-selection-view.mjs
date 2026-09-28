// Construction-site candidate selection, display: highlights the chosen shaft / work area / material yard /
// access point and shows the same facts the output carries, read-only. Nothing here writes to the export, the
// packages or any state, and nothing here says anything about cost, duration, score, method or compensation.
import { constructionSelectionOutput } from "./construction-selection.mjs";

const HIGHLIGHT = "#ffe66d";
const KIND_LABEL = { shaft: "수직구", workArea: "작업장", materialYard: "자재 적치장", accessRoad: "공사용 도로 진입점", vehicleAccess: "차량 반입 지점" };

// exp: a ConstructionExport; sel: the selection.
export function buildConstructionSelectionView(exp, sel) {
  const output = constructionSelectionOutput(sel, exp);
  if (output.candidateId === null) return { active: false, output };
  const isArea = Array.isArray(output.facts.polygon);
  return {
    active: true,
    kind: output.kind,
    label: KIND_LABEL[output.kind],
    constructionSiteId: output.constructionSiteId,
    isArea,
    location: isArea ? null : output.facts.location,
    polygon: isArea ? output.facts.polygon : null,
    output,
  };
}

const trace = (ctx, pts, screen, close = false) => {
  ctx.beginPath();
  pts.map(screen).forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  if (close) ctx.closePath();
};
const halo = (ctx, draw) => { // a dark under-stroke, then the highlight, so it reads on any layer
  ctx.strokeStyle = "#111318";
  ctx.lineWidth = 7;
  draw();
  ctx.strokeStyle = HIGHLIGHT;
  ctx.lineWidth = 3.5;
  draw();
};

// `screen` maps [lon, lat] to canvas pixels. Drawn above the construction layers; never blocks input.
export function drawConstructionSelection(ctx, view, screen) {
  if (!view.active) return;
  ctx.save();
  ctx.lineJoin = "round";
  if (view.isArea) halo(ctx, () => { trace(ctx, view.polygon, screen, true); ctx.stroke(); });
  else { const [x, y] = screen(view.location); halo(ctx, () => { ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2); ctx.stroke(); }); }
  const at = view.isArea ? view.polygon.reduce((s, p) => [s[0] + p[0] / view.polygon.length, s[1] + p[1] / view.polygon.length], [0, 0]) : view.location;
  const [x, y] = screen(at);
  const text = `선택 · ${view.label}`;
  ctx.font = "bold 11px Inter, system-ui, 'Malgun Gothic', sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const w = ctx.measureText(text).width + 12;
  ctx.fillStyle = "#111318";
  ctx.strokeStyle = HIGHLIGHT;
  ctx.lineWidth = 2;
  ctx.fillRect(x - w / 2, y + 14, w, 18);
  ctx.strokeRect(x - w / 2, y + 14, w, 18);
  ctx.fillStyle = HIGHLIGHT;
  ctx.fillText(text, x, y + 23);
  ctx.restore();
}

const num = (v, digits = 0) => v.toLocaleString("en-US", { maximumFractionDigits: digits });

// Player-controlled text is never present in this contract (candidate facts are all numbers/coordinates/codes),
// but this still only ever writes through textContent.
export function renderConstructionSelectionPanel(container, view) {
  container.replaceChildren();
  container.hidden = !view.active;
  if (!view.active) return;
  const doc = container.ownerDocument;
  const el = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  container.append(el("div", "section-label", `선택: ${view.label}`));
  const f = view.output.facts;
  const rows = [
    f.location ? ["위치", `${num(f.location[0], 6)}, ${num(f.location[1], 6)}`] : null,
    f.areaSquareMeters !== undefined ? ["면적", f.areaSquareMeters === null ? "미상" : `${num(f.areaSquareMeters)} m²`] : null,
    f.groundElevationMeters !== undefined ? ["지표고", f.groundElevationMeters === null ? "미상" : `${num(f.groundElevationMeters, 1)} m`] : null,
    f.shaftDepthMeters !== undefined ? ["수직구 깊이", f.shaftDepthMeters === null ? "미상" : `${num(f.shaftDepthMeters, 1)} m`] : null,
    f.nearestRoad !== undefined ? ["가장 가까운 도로", f.nearestRoad ? `${f.nearestRoad.roadClass} ${num(f.nearestRoad.distanceMeters)} m` : "미상"] : null,
  ].filter(Boolean);
  for (const [label, text] of rows) container.append(el("div", "diag info", `${label}: ${text}`));
  if (f.unknown?.length) container.append(el("div", "diag warning", `⚠ 미상: ${f.unknown.map((k) => `${k}(${f.unknownReasons[k]})`).join(", ")}`));
}
