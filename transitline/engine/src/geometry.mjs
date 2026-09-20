// Transit-diagram geometry: every leg between two stations is drawn with at
// most one 45-degree bend (0/45/90-degree segments only), and legs shared by
// several lines are fanned out side by side. Stations keep their projected
// positions; only the line shapes are schematic.

// Track band 6px + casing: parallel lines sit 10px apart so casings don't overlap.
export const SPREAD_PX = 10;

// A -> B as one diagonal run followed by one axis-aligned run.
export function octilinear(a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const m = Math.min(Math.abs(dx), Math.abs(dy));
  if (m < 0.5 || Math.abs(Math.abs(dx) - Math.abs(dy)) < 0.5) return [a, b];
  const bend = [a[0] + Math.sign(dx) * m, a[1] + Math.sign(dy) * m];
  return [a, bend, b];
}

function normal(p, q) {
  const dx = q[0] - p[0];
  const dy = q[1] - p[1];
  const len = Math.hypot(dx, dy) || 1;
  return [-dy / len, dx / len];
}

// Shifts a polyline sideways by `d` pixels, mitring the interior vertices.
function offsetPolyline(pts, d) {
  if (d === 0) return pts;
  return pts.map((p, i) => {
    if (i === 0) {
      const n = normal(pts[0], pts[1]);
      return [p[0] + n[0] * d, p[1] + n[1] * d];
    }
    if (i === pts.length - 1) {
      const n = normal(pts[i - 1], pts[i]);
      return [p[0] + n[0] * d, p[1] + n[1] * d];
    }
    const n1 = normal(pts[i - 1], p);
    const n2 = normal(p, pts[i + 1]);
    const k = Math.max(1 + n1[0] * n2[0] + n1[1] * n2[1], 0.2);
    return [p[0] + ((n1[0] + n2[0]) / k) * d, p[1] + ((n1[1] + n2[1]) / k) * d];
  });
}

const edgeKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

// Returns { edges: Map(lineId -> Point[][]) } where edges[i] is the drawn
// polyline from stationIds[i] to stationIds[i+1] (always in that direction).
export function buildGeometry(state, screen) {
  const users = new Map(); // edgeKey -> lineIds in draw order
  for (const line of state.lines) {
    for (let i = 0; i < line.stationIds.length - 1; i++) {
      const key = edgeKey(line.stationIds[i], line.stationIds[i + 1]);
      if (!users.has(key)) users.set(key, []);
      users.get(key).push(line.id);
    }
  }

  const edges = new Map();
  for (const line of state.lines) {
    const legs = [];
    for (let i = 0; i < line.stationIds.length - 1; i++) {
      const a = line.stationIds[i];
      const b = line.stationIds[i + 1];
      // Canonical direction so every line sharing the leg gets identical
      // geometry before its own offset is applied.
      const forward = a < b;
      const [lo, hi] = forward ? [a, b] : [b, a];
      const canon = octilinear(screen(state.stations.get(lo).location), screen(state.stations.get(hi).location));
      const sharing = users.get(edgeKey(a, b));
      const rank = sharing.indexOf(line.id);
      const shifted = offsetPolyline(canon, (rank - (sharing.length - 1) / 2) * SPREAD_PX);
      legs.push(forward ? shifted : [...shifted].reverse());
    }
    edges.set(line.id, legs);
  }
  return { edges };
}

// Point at fraction t (0..1) of a polyline's length.
export function pointAlong(pts, t) {
  let total = 0;
  const lens = [];
  for (let i = 1; i < pts.length; i++) {
    const l = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    lens.push(l);
    total += l;
  }
  let target = Math.max(0, Math.min(1, t)) * total;
  for (let i = 0; i < lens.length; i++) {
    if (target <= lens[i] || i === lens.length - 1) {
      const f = lens[i] === 0 ? 0 : target / lens[i];
      return [pts[i][0] + (pts[i + 1][0] - pts[i][0]) * f, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * f];
    }
    target -= lens[i];
  }
  return pts[pts.length - 1];
}
