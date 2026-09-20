// Canvas-only drawing: the network as a transit diagram (0/45/90-degree lines,
// station markers, letter badges, station names), attractors, trains, and the
// line being dragged. Counters and the clock are plain HTML, updated by loop.mjs.
import { buildGeometry, octilinear, pointAlong } from "./geometry.mjs";
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

// Station name with a dark halo so it stays readable over the block texture.
function drawLabel(ctx, text, x, y, align, muted) {
  ctx.font = "11px Inter, system-ui, 'Malgun Gothic', sans-serif";
  ctx.textAlign = align;
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  ctx.lineWidth = 3;
  ctx.strokeStyle = "#111318";
  ctx.strokeText(text, x, y);
  ctx.fillStyle = muted ? "#8c93a4" : "#f1f2f5";
  ctx.fillText(text, x, y);
}

// Puts the label on whichever side (E/W/N/S) is farthest from every line
// leaving the station and from a terminus badge.
function labelSpot(angles, x, y, m) {
  const sides = [
    [0, x + m + 4, y + 1, "left"],
    [Math.PI, x - m - 4, y + 1, "right"],
    [-Math.PI / 2, x, y - m - 9, "center"],
    [Math.PI / 2, x, y + m + 10, "center"],
  ];
  let best = sides[0];
  let bestScore = -1;
  for (const side of sides) {
    let score = Math.PI;
    for (const a of angles ?? []) {
      let d = Math.abs(a - side[0]) % (2 * Math.PI);
      d = Math.min(d, 2 * Math.PI - d);
      score = Math.min(score, d);
    }
    if (score > bestScore + 1e-6) {
      bestScore = score;
      best = side;
    }
  }
  return best;
}

const LABEL_ALL_BELOW = 40; // label unserved stations too only on small packs

export function draw(ctx, state, projection, width, height, input) {
  ctx.save();
  ctx.drawImage(backgroundFor(width, height), 0, 0);

  const screen = (loc) => projection.toScreen(loc, width, height);
  const geo = buildGeometry(state, screen);

  // Directions in which lines (and terminus badges) leave each station.
  const dirs = new Map();
  const addDir = (id, dx, dy) => {
    if (!dirs.has(id)) dirs.set(id, []);
    dirs.get(id).push(Math.atan2(dy, dx));
  };
  for (const line of state.lines) {
    const legs = geo.edges.get(line.id);
    legs.forEach((leg, i) => {
      const n = leg.length;
      const out = [leg[1][0] - leg[0][0], leg[1][1] - leg[0][1]];
      const back = [leg[n - 2][0] - leg[n - 1][0], leg[n - 2][1] - leg[n - 1][1]];
      addDir(line.stationIds[i], out[0], out[1]);
      addDir(line.stationIds[i + 1], back[0], back[1]);
      if (i === 0) addDir(line.stationIds[0], -out[0], -out[1]);
      if (i === legs.length - 1) addDir(line.stationIds[i + 1], -back[0], -back[1]);
    });
  }

  // Lines: 0/45/90-degree legs, shared legs fanned side by side.
  for (const line of state.lines) {
    const legs = geo.edges.get(line.id);
    ctx.strokeStyle = line.color;
    ctx.lineWidth = 4;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    legs.forEach((leg, i) =>
      leg.forEach(([x, y], j) => (i === 0 && j === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)))
    );
    ctx.stroke();
    const first = legs[0];
    const last = legs[legs.length - 1];
    drawBadge(ctx, first[0], first[1], line);
    drawBadge(ctx, last[last.length - 1], last[last.length - 2], line);
  }

  // Draft line being drawn, previewed with the same 45-degree legs.
  if (input?.draft) {
    ctx.strokeStyle = "rgba(255,255,255,0.6)";
    ctx.lineWidth = 3;
    ctx.setLineDash([6, 6]);
    const pts = input.draft.stationIds.map((id) => screen(state.stations.get(id).location));
    ctx.beginPath();
    ctx.moveTo(...pts[0]);
    for (let i = 1; i < pts.length; i++) octilinear(pts[i - 1], pts[i]).slice(1).forEach(([x, y]) => ctx.lineTo(x, y));
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
  const linesAt = new Map();
  for (const line of state.lines) for (const id of line.stationIds) linesAt.set(id, (linesAt.get(id) ?? 0) + 1);

  // Stations: demand disc underneath, then the diagram marker where a line
  // stops (white circle; larger where lines interchange).
  const labelUnserved = state.stations.size <= LABEL_ALL_BELOW;
  for (const s of state.stations.values()) {
    const [x, y] = screen(s.location);
    const r = stationRadius(s);
    const served = linesAt.get(s.id) ?? 0;

    ctx.globalAlpha = served ? 0.35 : 1;
    ctx.fillStyle = KIND_FILL[s.kind] ?? DEFAULT_FILL;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    if (!served) {
      ctx.strokeStyle = STATION_STROKE;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    let markerR = 0;
    if (served) {
      markerR = served >= 2 ? 7 : 5;
      ctx.fillStyle = "#fff";
      ctx.strokeStyle = "#111318";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(x, y, markerR, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    if (s.named && (served || labelUnserved)) {
      const [, lx, ly, align] = labelSpot(dirs.get(s.id), x, y, Math.max(r, markerR));
      drawLabel(ctx, s.name, lx, ly, align, !served);
    }

    const waiting = waitingByStation.get(s.id);
    if (waiting) {
      const bx = x + Math.max(r, markerR) * 0.7;
      const by = y - Math.max(r, markerR) * 0.7;
      ctx.fillStyle = "#e5484d";
      ctx.beginPath();
      ctx.arc(bx, by, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.font = "9px Inter, system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(Math.min(waiting, 99)), bx, by + 0.5);
    }
  }

  // Trains ride the same drawn legs as the lines.
  for (const train of state.trains) {
    const line = state.lines.find((l) => l.id === train.lineId);
    const leg = geo.edges.get(train.lineId)?.[train.dir === 1 ? train.segIndex : train.segIndex - 1];
    if (!line || !leg) continue;
    const [x, y] = pointAlong(leg, train.dir === 1 ? train.t : 1 - train.t);
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
