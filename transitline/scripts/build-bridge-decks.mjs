// Builds bridges-3d.pmtiles: thin fill-extrusion "deck" polygons for elevated roads (陸橋/高架, OSM bridge=*),
// so the "3D 보기" toggle shows overpasses actually lifted above the ground instead of flat like every other road.
// Not measured — bridge height is a rough estimate by road class (real clearances vary), same disclosure as the
// building extrusion heights. Reads the already-built <area>-roads.pmtiles (road layer already carries `bridge`
// and `kind`), buffers each bridge-tagged line into a rectangle sized by road class, and gives it a thin
// extrusion (base = deck height - 2m, top = deck height) rather than a solid pillar from the ground.
//
// A real bridge corridor (e.g. an expressway viaduct) is usually chopped into many separate OSM ways (split at
// every interchange/curve) *and* further split by the tiler at every tile edge. Tapering each of those pieces
// independently at both ends produced a "sawtooth"/dashed look — the deck kept dropping to the ground and
// popping back up at every way boundary, not just at the corridor's real ends. Fixed with two passes: (1) collect
// every bridge line fragment (real-world lon/lat, already stitched back to whole OSM ways where a single way was
// only split by tile edges — MapLibre-style vector tiles don't carry a way id, so this uses shared endpoint
// coordinates as the join key, snapped to ~1m) and (2) only taper an endpoint that is not shared with any other
// bridge fragment, i.e. only where the bridge corridor actually meets a non-bridge road.
// Usage: DEPS=<dir with node_modules of pmtiles,@mapbox/vector-tile,pbf> node scripts/build-bridge-decks.mjs \
//          <out.geojsonl> [report.json]
import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { fileURLToPath } from "url";
const T = fileURLToPath(new URL("../packs/tokyo/", import.meta.url));
const req = createRequire(path.resolve(process.env.DEPS || ".", "x.js"));
const { PMTiles } = req("pmtiles");
const { VectorTile } = req("@mapbox/vector-tile");
const { PbfReader: Pbf } = req("pbf");
const [out, reportPath] = process.argv.slice(2);
if (!out) throw new Error("usage: <out.geojsonl> [report.json]");

const AREAS = ["tokyo", "saitama", "chiba", "kanagawa"];
// road class -> [deck width m, deck top height m above ground]
// link/ramp roads are usually a single lane, so keep them narrower than the mainline they connect to — this also
// leaves more margin before a tight loop ramp's curve radius gets smaller than the deck's half-width, which is
// what actually causes an offset polygon to fold over itself on the inside of the curve (see MITER_LIMIT below).
const CLASS = {
  motorway: [12, 10], motorway_link: [5, 9], trunk: [11, 9], trunk_link: [5, 8],
  primary: [9, 7], primary_link: [4.5, 6.5], secondary: [8, 6.5], secondary_link: [4.5, 6],
  tertiary: [6.5, 5.5], tertiary_link: [4, 5], residential: [5.5, 5], unclassified: [5.5, 5], living_street: [5, 5],
};
const classOf = (kind) => CLASS[kind] ?? [5.5, 5];
const RAMP_LEN = 25; // meters over which a genuine bridge end fades from full height down to ground level
const KLAT = 111320;

// ---- pass 1: collect every bridge line fragment, in real-world lon/lat, across all 4 areas ----
const Z = 14;
const tile2lon = (x, z) => x / 2 ** z * 360 - 180;
const tile2lat = (y, z) => { const n = Math.PI - 2 * Math.PI * y / 2 ** z; return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))); };
const frags = []; // { pts: [[lon,lat],...], kind }
// Kanto's per-prefecture OSM extracts overlap slightly at their shared borders (Tamagawa etc.), so the same real
// bridge way can show up once in e.g. tokyo-roads.pmtiles and again in kanagawa-roads.pmtiles — since both use
// the exact same Z14 tile grid, a way fully inside one tile clips to identical coordinates in both files. Two
// literally-identical decks at the same spot don't add up visually, they z-fight (flicker between the two
// almost-but-not-quite-coplanar surfaces), which looked exactly like the jagged/faceted look this was chasing —
// and no amount of fixing the *geometry* of either copy fixes a problem that's really about there being two of
// them. Dedup by (kind, first point, last point, point count): legitimate distinct bridges essentially never
// share all three by coincidence, so this only ever collapses genuine duplicates.
const seenFrag = new Set();
let dupSkipped = 0;
for (const area of AREAS) {
  const tilesPath = T + `${area}-roads.pmtiles`;
  if (!fs.existsSync(tilesPath)) { console.warn("missing", tilesPath, "- skipped"); continue; }
  const fd = fs.openSync(tilesPath, "r");
  const source = { getKey: () => tilesPath, getBytes: async (o, l) => { const b = Buffer.alloc(l); fs.readSync(fd, b, 0, l, o); return { data: b.buffer.slice(b.byteOffset, b.byteOffset + l) }; } };
  const pm = new PMTiles(source);
  const header = await pm.getHeader();
  const x0 = Math.floor((header.minLon + 180) / 360 * 2 ** Z), x1 = Math.floor((header.maxLon + 180) / 360 * 2 ** Z);
  const lat2tile = (lat) => Math.floor((1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * 2 ** Z);
  const y0 = lat2tile(header.maxLat), y1 = lat2tile(header.minLat);
  console.log(area, "tile range", x1 - x0 + 1, "x", y1 - y0 + 1);
  const before = frags.length;
  for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) {
    const r = await pm.getZxy(Z, tx, ty); if (!r) continue;
    const vt = new VectorTile(new Pbf(new Uint8Array(r.data))); const L = vt.layers.road; if (!L) continue;
    const lonW = tile2lon(tx, Z), lonE = tile2lon(tx + 1, Z), latN = tile2lat(ty, Z), latS = tile2lat(ty + 1, Z);
    const EXT = L.extent;
    for (let fi = 0; fi < L.length; fi++) {
      const f = L.feature(fi); if (f.type !== 2) continue;
      const p = f.properties;
      if (!p.bridge || p.bridge === "no" || p.bridge === "null") continue;
      for (const part of f.loadGeometry()) {
        if (part.length < 2) continue;
        const pts = part.map((v) => [+(lonW + v.x / EXT * (lonE - lonW)).toFixed(7), +(latN - v.y / EXT * (latN - latS)).toFixed(7)]);
        const kind = p.kind ?? "unclassified";
        const sig = `${kind}|${pts.length}|${pts[0].join(",")}|${pts[pts.length - 1].join(",")}`;
        if (seenFrag.has(sig)) { dupSkipped++; continue; }
        seenFrag.add(sig);
        frags.push({ pts, kind });
      }
    }
  }
  console.log(area, "bridge fragments", frags.length - before);
}
console.log("total fragments (pre-merge)", frags.length, "cross-border duplicates skipped", dupSkipped);

// ---- pass 2: join fragments that share an endpoint into full corridors ----
// key = endpoint snapped to ~1m; two fragments whose ends land in the same cell are treated as one continuous
// bridge for tapering purposes, even though they stay separate output features (avoids a full linestring merge).
// A diverging/merging ramp joins the mainline at a vertex in the *middle* of the mainline way, not at one of its two
// ends, so matching endpoint-to-endpoint alone calls every such ramp end a "genuine" end and tapers it down to the
// ground over 25m — at a big interchange (Hakozaki/Edobashi JCT etc.) that piles up dozens of half-tapered slabs
// at different heights, which is the shingled/staircase look. So index EVERY vertex of EVERY fragment and call an
// endpoint joined if any *other* fragment has a vertex near it. Neighbouring grid cells are checked too: a snap-
// to-grid key alone splits two points 0.3m apart whenever they straddle a cell edge.
const SNAP = 0.00001; // ~1.1m at this latitude; endpoint matching radius is effectively 1 cell in each direction
const cellOf = (v, s) => Math.round(v / s);
const vertexOwners = new Map(); // "cx,cy" -> frag indexes having a vertex in that cell
frags.forEach((fr, fi) => {
  for (const [lon, lat] of fr.pts) {
    const k = `${cellOf(lon, SNAP)},${cellOf(lat, SNAP)}`;
    const a = vertexOwners.get(k);
    if (!a) vertexOwners.set(k, [fi]); else if (a[a.length - 1] !== fi) a.push(fi);
  }
});
const isJoined = (pt, selfIdx) => {
  const cx = cellOf(pt[0], SNAP), cy = cellOf(pt[1], SNAP);
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
    const a = vertexOwners.get(`${cx + dx},${cy + dy}`);
    if (a) for (const o of a) if (o !== selfIdx) return true;
  }
  return false;
};

// ---- pass 3: buffer + taper each fragment, emit quads ----
const wfd = fs.openSync(out, "w");
let buf = [], pieces = 0;
const byKind = {};
for (let fragIdx = 0; fragIdx < frags.length; fragIdx++) {
  const fr = frags[fragIdx];
  const [widthM, topM] = classOf(fr.kind);
  const baseM = Math.max(0, topM - 2);
  byKind[fr.kind] = (byKind[fr.kind] || 0) + 1;
  const pts = fr.pts;
  const mPerLonAt = (lat) => KLAT * Math.cos(lat * Math.PI / 180);
  // cumulative real-world distance along the fragment
  const dist = [0];
  for (let i = 1; i < pts.length; i++) {
    const midLat = (pts[i][1] + pts[i - 1][1]) / 2, mLon = mPerLonAt(midLat);
    const dx = (pts[i][0] - pts[i - 1][0]) * mLon, dy = (pts[i][1] - pts[i - 1][1]) * KLAT;
    dist.push(dist[i - 1] + Math.hypot(dx, dy));
  }
  const total = dist[dist.length - 1];
  const clippedStart = isJoined(pts[0], fragIdx), clippedEnd = isJoined(pts[pts.length - 1], fragIdx);
  const fracAt = (d) => {
    const fs = clippedStart ? 1 : Math.min(1, d / RAMP_LEN);
    const fe = clippedEnd ? 1 : Math.min(1, (total - d) / RAMP_LEN);
    return Math.max(0, Math.min(fs, fe));
  };
  // Subdivide near a genuine (non-joined) end so the taper reads as a smooth ramp rather than one big segment
  // jumping straight from ground level to full height. Each sub-segment is its own flat-topped quad (a fill-
  // extrusion feature can't have a sloped top), so the taper is really a staircase, not a ramp — RAMP_STEP has to
  // be short enough that individual risers (a few tens of cm each here) blend together at normal viewing distance
  // instead of reading as visible steps the way ~1m-tall risers on 3m treads did.
  const RAMP_STEP = 0.8;
  const nodes = pts.map((v, i) => ({ lon: v[0], lat: v[1], d: dist[i] }));
  const dense = [nodes[0]];
  for (let i = 0; i < nodes.length - 1; i++) {
    const a = nodes[i], b = nodes[i + 1], segLen = b.d - a.d;
    const nearRamp = (!clippedStart && a.d < RAMP_LEN + 5) || (!clippedEnd && total - b.d < RAMP_LEN + 5);
    if (nearRamp && segLen > RAMP_STEP) {
      const steps = Math.min(40, Math.ceil(segLen / RAMP_STEP));
      for (let s = 1; s < steps; s++) {
        const t = s / steps;
        dense.push({ lon: a.lon + (b.lon - a.lon) * t, lat: a.lat + (b.lat - a.lat) * t, d: a.d + segLen * t });
      }
    }
    dense.push(b);
  }
  // Local meters-ish plane (lon scaled by a shared reference mLon so x/y are locally isotropic) — needed to get a
  // single normal per point instead of one per segment, which is what actually closes the curve-boundary gaps.
  const refLat = (dense[0].lat + dense[dense.length - 1].lat) / 2, mLon = mPerLonAt(refLat);
  const P = dense.map((v) => ({ x: v.lon * mLon, y: v.lat * KLAT, d: v.d }));
  const segNormal = (p, q) => { const dx = q.x - p.x, dy = q.y - p.y, len = Math.hypot(dx, dy) || 1; return [-dy / len, dx / len]; };
  // Each straight sub-segment becomes its own flat quad, so a curve is really a chain of flat facets — and
  // fill-extrusion side walls are each lit by their own facing direction, so a curve built out of a few *large*
  // facets doesn't just have geometric seams, it visibly strobes light/dark facet to facet (the "staircase" look
  // even after the seams themselves were closed). The fix is a ROUND JOIN at every bend: instead of one offset
  // point going straight from the incoming segment's normal to the outgoing one, fan out several points around
  // the turn, each still at *exactly* half-width (so, unlike a miter, it can never overshoot into a self-
  // intersection on a tight inside curve) and each only ROUND_STEP_DEG apart (so neighboring facets are similar
  // enough in facing direction that the lighting strobe disappears). A near-straight vertex needs zero extra
  // points; a sharp one gets a small fan; nothing is added along straight runs at all.
  const ROUND_STEP_DEG = 5;
  function roundFan(n1, n2) {
    const dot = Math.max(-1, Math.min(1, n1[0] * n2[0] + n1[1] * n2[1]));
    const ang = Math.acos(dot); // radians, unsigned
    if (ang < 1e-4) return [];
    const steps = Math.min(24, Math.max(1, Math.round((ang * 180 / Math.PI) / ROUND_STEP_DEG)));
    if (steps <= 1) return [];
    const sign = n1[0] * n2[1] - n1[1] * n2[0] >= 0 ? 1 : -1;
    const a1 = Math.atan2(n1[1], n1[0]);
    const out = [];
    for (let s = 1; s < steps; s++) { const a = a1 + sign * ang * (s / steps); out.push([Math.cos(a), Math.sin(a)]); }
    return out;
  }
  const stations = [{ x: P[0].x, y: P[0].y, d: P[0].d, n: segNormal(P[0], P[1]) }];
  for (let i = 1; i < P.length - 1; i++) {
    const n1 = segNormal(P[i - 1], P[i]), n2 = segNormal(P[i], P[i + 1]);
    stations.push({ x: P[i].x, y: P[i].y, d: P[i].d, n: n1 });
    for (const n of roundFan(n1, n2)) stations.push({ x: P[i].x, y: P[i].y, d: P[i].d, n });
    stations.push({ x: P[i].x, y: P[i].y, d: P[i].d, n: n2 });
  }
  stations.push({ x: P[P.length - 1].x, y: P[P.length - 1].y, d: P[P.length - 1].d, n: segNormal(P[P.length - 2], P[P.length - 1]) });

  for (let i = 0; i < stations.length - 1; i++) {
    const a = stations[i], b = stations[i + 1];
    if (a.x === b.x && a.y === b.y && a.n[0] === b.n[0] && a.n[1] === b.n[1]) continue; // exact duplicate
    const frac = fracAt((a.d + b.d) / 2);
    const top = +(topM * frac).toFixed(2);
    if (top < 0.1) continue; // tapered down to ~ground level here: nothing worth extruding
    const base = +(baseM * frac).toFixed(2);
    const half = widthM / 2;
    const quadM = [[a.x + a.n[0] * half, a.y + a.n[1] * half], [b.x + b.n[0] * half, b.y + b.n[1] * half], [b.x - b.n[0] * half, b.y - b.n[1] * half], [a.x - a.n[0] * half, a.y - a.n[1] * half]];
    const coords = quadM.map(([x, y]) => [+(x / mLon).toFixed(7), +(y / KLAT).toFixed(7)]);
    coords.push(coords[0]);
    buf.push(JSON.stringify({ type: "Feature", properties: { kind: fr.kind, base, top }, geometry: { type: "Polygon", coordinates: [coords] } }));
    pieces++;
  }
  if (buf.length > 20000) { fs.writeSync(wfd, buf.join("\n") + "\n"); buf = []; }
}
if (buf.length) fs.writeSync(wfd, buf.join("\n") + "\n");
fs.closeSync(wfd);
const rep = { pieces, bridgeFragments: frags.length, byKind };
if (reportPath) fs.writeFileSync(reportPath, JSON.stringify(rep, null, 1));
console.log(rep);
