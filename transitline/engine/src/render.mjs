// Canvas-only drawing: the network as a transit diagram (0/45/90-degree lines,
// station markers, letter badges, station names), attractors, trains, and the
// line being dragged. Counters and the clock are plain HTML, updated by loop.mjs.
import { buildGeometry, octilinear, pointAlong, SPREAD_PX } from "./geometry.mjs";
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
    for (const { angle: a } of angles ?? []) {
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

const LABEL_ALL_BELOW = 40;
const TRACK_WIDTH = 6;
const PLATFORM_LEN = 34;

// One platform per direction the lines run through a station (mod 180
// degrees). A line that bends at the station appears in two directions, so
// keep only as many platforms as it takes to cover every line — largest first.
function platformsAt(entries) {
  const groups = [];
  for (const { angle, lineId } of entries) {
    const axis = ((angle % Math.PI) + Math.PI) % Math.PI;
    let hit = groups.find((p) => {
      const d = Math.abs(p.axis - axis);
      return Math.min(d, Math.PI - d) < 0.2;
    });
    if (!hit) groups.push((hit = { axis, lines: new Set() }));
    hit.lines.add(lineId);
  }
  groups.sort((p, q) => q.lines.size - p.lines.size);
  const covered = new Set();
  const chosen = [];
  for (const g of groups) {
    if ([...g.lines].every((id) => covered.has(id))) continue;
    chosen.push(g);
    g.lines.forEach((id) => covered.add(id));
  }
  return chosen;
}
