// Canvas-only drawing: stations, attractors, lines, trains, and the line
// currently being dragged. The HUD (counters, clock) is plain HTML, updated
// by loop.mjs — no text is drawn on the canvas.
import { trainScreenPosition } from "./trains.mjs";

const BG = "#0c1114";
const STATION_STROKE = "#e7eef0";
const KIND_FILL = { commercial: "#f4a261", residential: "#457b9d", mixed: "#2a9d8f" };
const DEFAULT_FILL = "#6b7d85";
const ATTRACTOR_FILL = "#e08a4c";

function stationRadius(s) {
  return Math.min(22, Math.max(5, 4 + Math.sqrt(s.residents + s.jobs) / 40));
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

export function draw(ctx, state, projection, width, height, input) {
  ctx.save();
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, width, height);

  const screen = (loc) => projection.toScreen(loc, width, height);

  // Lines
  for (const [lineIndex, line] of state.lines.entries()) {
    ctx.strokeStyle = line.color;
    ctx.lineWidth = 5;
    ctx.lineCap = "round";
    ctx.beginPath();
    const pts = line.stationIds.map((id) => screen(state.stations.get(id).location));
    for (let i = 0; i < pts.length; i++) {
      const n = perpendicular(pts[Math.max(0, i - 1)], pts[Math.min(pts.length - 1, i + 1)]);
      const [x, y] = offsetPoint(pts[i], n, lineIndex, state.lines.length);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
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
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    const waiting = waitingByStation.get(s.id);
    if (waiting) {
      ctx.fillStyle = "#e63946";
      ctx.beginPath();
      ctx.arc(x + r * 0.7, y - r * 0.7, 8, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.font = "10px system-ui, sans-serif";
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
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(x, y, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }

  ctx.restore();
}
