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
const CLASS = {
  motorway: [12, 10], motorway_link: [9, 9], trunk: [11, 9], trunk_link: [8, 8],
  primary: [9, 7], primary_link: [7, 6.5], secondary: [8, 6.5], secondary_link: [6.5, 6],
  tertiary: [6.5, 5.5], tertiary_link: [5.5, 5], residential: [5.5, 5], unclassified: [5.5, 5], living_street: [5, 5],
};
const classOf = (kind) => CLASS[kind] ?? [5.5, 5];
const RAMP_LEN = 25; // meters over which a genuine bridge end fades from full height down to ground level
const KLAT = 111320;

// ---- pass 1: collect every bridge line fragment, in real-world lon/lat, across all 4 areas ----
const Z = 14;
const tile2lon = (x, z) => x / 2 ** z * 360 - 180;
const tile2lat = (y, z) => { const n = Math.PI - 2 * Math.PI * y / 2 ** z; return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))); };
const frags = []; // { pts: [[lon,lat],...], kind }
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
        frags.push({ pts, kind: p.kind ?? "unclassified" });
      }
    }
  }
  console.log(area, "bridge fragments", frags.length - before);
}
console.log("total fragments (pre-merge)", frags.length);

// ---- pass 2: join fragments that share an endpoint into full corridors ----
// key = endpoint snapped to ~1m; two fragments whose ends land in the same cell are treated as one continuous
// bridge for tapering purposes, even though they stay separate output features (avoids a full linestring merge).
const SNAP = 0.00001; // ~1.1m of longitude at this latitude, safely above the tile-quantization rounding error
const snapKey = ([lon, lat]) => `${Math.round(lon / SNAP)},${Math.round(lat / SNAP)}`;
const endpointCount = new Map();
for (const fr of frags) {
  for (const end of [fr.pts[0], fr.pts[fr.pts.length - 1]]) {
    const k = snapKey(end);
    endpointCount.set(k, (endpointCount.get(k) || 0) + 1);
  }
}
// an endpoint used by >1 fragment-end is a real junction/continuation -> don't taper there
const isJoined = (pt) => (endpointCount.get(snapKey(pt)) || 0) > 1;

// ---- pass 3: buffer + taper each fragment, emit quads ----
const wfd = fs.openSync(out, "w");
let buf = [], pieces = 0;
const byKind = {};
for (const fr of frags) {
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
  const clippedStart = isJoined(pts[0]), clippedEnd = isJoined(pts[pts.length - 1]);
  const fracAt = (d) => {
    const fs = clippedStart ? 1 : Math.min(1, d / RAMP_LEN);
    const fe = clippedEnd ? 1 : Math.min(1, (total - d) / RAMP_LEN);
    return Math.max(0, Math.min(fs, fe));
  };
  // subdivide only near a genuine (non-joined) end, so the taper reads as a smooth ramp rather than one big
  // segment jumping straight from ground level to full height
  const nodes = pts.map((v, i) => ({ lon: v[0], lat: v[1], d: dist[i] }));
  const dense = [nodes[0]];
  for (let i = 0; i < nodes.length - 1; i++) {
    const a = nodes[i], b = nodes[i + 1], segLen = b.d - a.d;
    const nearRamp = (!clippedStart && a.d < RAMP_LEN + 5) || (!clippedEnd && total - b.d < RAMP_LEN + 5);
    if (nearRamp && segLen > 3) {
      const steps = Math.min(8, Math.ceil(segLen / 3));
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
  // per-point offset direction: the plain segment normal at the two open ends, and a clamped MITER of the two
  // adjacent segment normals at every interior point — this is what makes quad_i and quad_{i+1} share the exact
  // same edge on a curve (both use pointNormal[i+1]) instead of each independently offsetting by its own segment's
  // normal, which used to leave a sliver gap/overlap at every bend and rendered as a jagged step once extruded.
  const pointNormal = new Array(P.length);
  pointNormal[0] = segNormal(P[0], P[1]);
  pointNormal[P.length - 1] = segNormal(P[P.length - 2], P[P.length - 1]);
  for (let i = 1; i < P.length - 1; i++) {
    const n1 = segNormal(P[i - 1], P[i]), n2 = segNormal(P[i], P[i + 1]);
    let mx = n1[0] + n2[0], my = n1[1] + n2[1];
    const mlen = Math.hypot(mx, my);
    if (mlen < 1e-6) { pointNormal[i] = n1; continue; } // near-180° reversal: fall back to one side's normal
    mx /= mlen; my /= mlen;
    const cosHalf = mx * n1[0] + my * n1[1];
    const scale = Math.min(cosHalf > 1e-3 ? 1 / cosHalf : 4, 4); // clamp so a sharp switchback doesn't spike out
    pointNormal[i] = [mx * scale, my * scale];
  }
  for (let i = 0; i < P.length - 1; i++) {
    const a = P[i], b = P[i + 1];
    if (a.x === b.x && a.y === b.y) continue; // duplicate point (zero-length sub-segment)
    const frac = fracAt((a.d + b.d) / 2);
    const top = +(topM * frac).toFixed(2);
    if (top < 0.1) continue; // tapered down to ~ground level here: nothing worth extruding
    const base = +(baseM * frac).toFixed(2);
    const half = widthM / 2, [nax, nay] = pointNormal[i], [nbx, nby] = pointNormal[i + 1];
    const quadM = [[a.x + nax * half, a.y + nay * half], [b.x + nbx * half, b.y + nby * half], [b.x - nbx * half, b.y - nby * half], [a.x - nax * half, a.y - nay * half]];
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
