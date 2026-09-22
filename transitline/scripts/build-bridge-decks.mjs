// Builds bridges-3d.pmtiles: thin fill-extrusion "deck" polygons for elevated roads (陸橋/高架, OSM bridge=*),
// so the "3D 보기" toggle shows overpasses actually lifted above the ground instead of flat like every other road.
// Not measured — bridge height is a rough estimate by road class (real clearances vary), same disclosure as the
// building extrusion heights. Reads the already-built <area>-roads.pmtiles (road layer already carries `bridge`
// and `kind`), buffers each bridge-tagged line segment into a rectangle sized by road class, and gives it a
// thin extrusion (base = deck height - 2m, top = deck height) rather than a solid pillar from the ground.
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

const Z = 14;
const tile2lon = (x, z) => x / 2 ** z * 360 - 180;
const tile2lat = (y, z) => { const n = Math.PI - 2 * Math.PI * y / 2 ** z; return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))); };
const KLAT = 111320;

const wfd = fs.openSync(out, "w");
let buf = [], pieces = 0, bridges = 0;
const byKind = {};
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
  let areaBridges = 0;
  for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) {
    const r = await pm.getZxy(Z, tx, ty); if (!r) continue;
    const vt = new VectorTile(new Pbf(new Uint8Array(r.data))); const L = vt.layers.road; if (!L) continue;
    const lonW = tile2lon(tx, Z), lonE = tile2lon(tx + 1, Z), latN = tile2lat(ty, Z), latS = tile2lat(ty + 1, Z);
    const EXT = L.extent, mPerLon = KLAT * Math.cos((latN + latS) / 2 * Math.PI / 180);
    for (let fi = 0; fi < L.length; fi++) {
      const f = L.feature(fi); if (f.type !== 2) continue;
      const p = f.properties;
      if (!p.bridge || p.bridge === "no" || p.bridge === "null") continue;
      const [widthM, topM] = classOf(p.kind);
      const baseM = Math.max(0, topM - 2);
      // width in tile units (EXT covers the tile's lon/lat span)
      const wx = widthM / mPerLon * EXT / (lonE - lonW), wy = widthM / KLAT * EXT / (latN - latS);
      for (const part of f.loadGeometry()) {
        if (part.length < 2) continue;
        for (let i = 0; i < part.length - 1; i++) {
          const a = part[i], b = part[i + 1];
          const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy); if (len === 0) continue;
          // perpendicular offset, scaled independently in x/y tile-unit space (tile is roughly square in meters locally)
          const nx = -dy / len, ny = dx / len;
          const quad = [
            [a.x + nx * wx / 2, a.y + ny * wy / 2], [b.x + nx * wx / 2, b.y + ny * wy / 2],
            [b.x - nx * wx / 2, b.y - ny * wy / 2], [a.x - nx * wx / 2, a.y - ny * wy / 2],
          ];
          const coords = quad.map(([x, y]) => [+(lonW + x / EXT * (lonE - lonW)).toFixed(7), +(latN - y / EXT * (latN - latS)).toFixed(7)]);
          coords.push(coords[0]);
          buf.push(JSON.stringify({ type: "Feature", properties: { kind: p.kind ?? "unclassified", base: baseM, top: topM }, geometry: { type: "Polygon", coordinates: [coords] } }));
          pieces++;
        }
      }
      bridges++; areaBridges++;
      byKind[p.kind] = (byKind[p.kind] || 0) + 1;
    }
    if (buf.length > 20000) { fs.writeSync(wfd, buf.join("\n") + "\n"); buf = []; }
  }
  console.log(area, "bridge features", areaBridges);
}
if (buf.length) fs.writeSync(wfd, buf.join("\n") + "\n");
fs.closeSync(wfd);
const rep = { pieces, bridgeFeatures: bridges, byKind };
if (reportPath) fs.writeFileSync(reportPath, JSON.stringify(rep, null, 1));
console.log(rep);
