// Canvas-only drawing: stations, attractors, lines, trains, and the line
// currently being dragged. The HUD (counters, clock) is plain HTML, updated
// by loop.mjs — no text is drawn on the canvas.
import { trainScreenPosition } from "./trains.mjs";
import { lineLetter, badgeTextColor } from "./state.mjs";

const BG = "#1b2131";
const STATION_STROKE = "#f1f2f5";
const KIND_FILL = { commercial: "#f4a261", residential: "#6f86c9", mixed: "#38b59c" };
const DEFAULT_FILL = "#7d8494";
const ATTRACTOR_FILL = "#e08a4c";

function stationRadius(s) {
  return Math.min(16, Math.max(4, 3 + Math.sqrt(s.residents + s.jobs) / 55));
}

// Decorative city-block texture in the reference's navy/teal palette. It is
// not geography — packs without a basemap have none to draw — so it is a
// deterministic grid, cached per canvas size.
const BLOCK_SHADES = ["#2b3450", "#303a58", "#283049", "#333d5c", "#2d3653"];
let bgCache = null;

function backgroundFor(width, height) {
  if (bgCache && bgCache.width === width && bgCache.height === height) return bgCache;
  const layer = document.createElement("canvas");
  layer.width = width;
  layer.height = height;
  const g = layer.getContext("2d");
  g.fillStyle = BG;
  g.fillRect(0, 0, width, height);
  const cell = 30;
  const gap = 3;
  for (let j = 0; j * cell < height; j++) {
    for (let i = 0; i * cell < width; i++) {
      const park = (i * 31 + j * 17) % 19 === 0;
      g.fillStyle = park ? "#2a5a57" : BLOCK_SHADES[(i * 7 + j * 13) % BLOCK_SHADES.length];
      g.fillRect(i * cell + gap / 2, j * cell + gap / 2, cell - gap, cell - gap);
    }
  }
  bgCache = layer;
  return layer;
}

// Multiple lines sharing an edge get a small perpendicular offset per line
// index so they don't render as one indistinguishable stroke. Approximate
// (offset is per-line, not per-shared-edge) — good enough for Phase 1.
function offsetPoint([x, y], [nx, ny], lineIndex, totalLines) {
  const spread = 6;
  const offset = (lineIndex - (totalLines - 1) / 2) * spread;
  return [x + nx * offset, y + ny * offset];
}

function perpendicular([ax, ay], [bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy) || 1;
  return [-dy / len, dx / len];
}

// Letter badge just beyond a line's terminus, pushed outward along the line.
function drawBadge(ctx, end, neighbor, line) {
  const dx = end[0] - neighbor[0];
  const dy = end[1] - neighbor[1];
  const len = Math.hypot(dx, dy) || 1;
  const x = end[0] + (dx / len) * 18;
  const y = end[1] + (dy / len) * 18;
  ctx.fillStyle = line.color;
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(x, y, 9, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = badgeTextColor(line.color);
  ctx.font = "bold 11px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(lineLetter(line.id), x, y + 0.5);
}

export function draw(ctx, state, projection, width, height, input) {
  ctx.save();
  ctx.drawImage(backgroundFor(width, height), 0, 0);

  const screen = (loc) => projection.toScreen(loc, width, height);

  // Lines
  for (const [lineIndex, line] of state.lines.entries()) {
    const base = line.stationIds.map((id) => screen(state.stations.get(id).location));
    const pts = base.map((p, i) =>
      offsetPoint(p, perpendicular(base[Math.max(0, i - 1)], base[Math.min(base.length - 1, i + 1)]), lineIndex, state.lines.length)
    );
    ctx.strokeStyle = line.color;
    ctx.lineWidth = 4;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    ctx.stroke();
    drawBadge(ctx, pts[0], pts[1], line);
    drawBadge(ctx, pts[pts.length - 1], pts[pts.length - 2], line);
  }

  // Draft line being drawn
  if (input?.draft) {
    ctx.strokeStyle = "rgba(255,255,255,0.6)";
    ctx.lineWidth = 3;
    ctx.setLineDash([6, 6]);
    ctx.beginPath();
    const pts = input.draft.stationIds.map((id) => screen(state.stations.get(id).location));
    pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    ctx.lineTo(...input.draft.cursor);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Attractors (not boardable — see demand-engine.mjs's nearest-station fold-in)
  ctx.fillStyle = ATTRACTOR_FILL;
  for (const a of state.attractors) {
    const [x, y] = screen(a.location);
    ctx.beginPath();
    ctx.moveTo(x, y - 7);
    ctx.lineTo(x + 7, y + 6);
    ctx.lineTo(x - 7, y + 6);
    ctx.closePath();
    ctx.fill();
  }

  // Waiting passengers per station, for the badge below
  const waitingByStation = new Map();
  for (const p of state.passengers) {
    if (p.state !== "waiting") continue;
    waitingByStation.set(p.currentStationId, (waitingByStation.get(p.currentStationId) ?? 0) + 1);
  }

  // Stations
  for (const s of state.stations.values()) {
    const [x, y] = screen(s.location);
    const r = stationRadius(s);
    ctx.fillStyle = KIND_FILL[s.kind] ?? DEFAULT_FILL;
    ctx.strokeStyle = STATION_STROKE;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    const waiting = waitingByStation.get(s.id);
    if (waiting) {
      ctx.fillStyle = "#e5484d";
      ctx.beginPath();
      ctx.arc(x + r * 0.7, y - r * 0.7, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.font = "9px Inter, system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(Math.min(waiting, 99)), x + r * 0.7, y - r * 0.7 + 0.5);
    }
  }

  // Trains
  for (const train of state.trains) {
    const line = state.lines.find((l) => l.id === train.lineId);
    if (!line) continue;
    const [x, y] = trainScreenPosition(state, train, projection, width, height);
    ctx.fillStyle = line.color;
    ctx.strokeStyle = "#111318";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, 5.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  ctx.restore();
}
