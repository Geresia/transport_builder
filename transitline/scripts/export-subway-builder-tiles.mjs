// Builds the basemap tile file Subway Builder v1.7.1 wants for a city: cities/data/<CODE>/tiles.pmtiles.
// The game's own Tokyo file (read-only look, nothing copied) has layers: water, parks(area), commercial(type),
// airports, buildings(height,id), city_labels / suburb_labels / neighborhood_labels (name), z5-15. Our roads are drawn
// from roads.geojson, so no road layer is needed. This maps OUR data onto those layers:
//   water, parks, commercial, airports, place labels  <- packs/tokyo/basemap.pmtiles (Protomaps/OSM, only z0-12,
//        so its z12 geometry is what gets re-tiled up to z15: good enough for a background, ~2 m vertex spacing)
//   buildings <- packs/tokyo/{tokyo-survey,saitama,chiba,kanagawa}-buildings.pmtiles z14 (`height`, else levels*3.3 m, else 9 m)
// Only lon/lat GeoJSON lines are written by this script; planetiler (Java 21 + planetiler.jar, `generate-custom` with a
// YAML schema, like the pack's other tile files) does the actual tiling.
//
// Caveats: pieces of a feature that cross a source tile are separate polygons (invisible seams); building pieces are
// de-duplicated by exact geometry. Labels use name:en only (the game's map font has no Japanese glyphs), so places
// without an English name get no label.
//
// Usage: node --max-old-space-size=8192 scripts/export-subway-builder-tiles.mjs [--no-build]
//   env PLANETILER_JAR = path to planetiler.jar (default: data-raw/planetiler.jar)
//   out: subway-builder-export/city-work/*.geojsonl (+ schema.yml), then subway-builder-export/city-TYOTL/tiles.pmtiles
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tileIdToZxy } from "pmtiles";
import { VectorTile } from "@mapbox/vector-tile";
import { PbfReader as Pbf } from "pbf";
import { gunzipSync } from "fflate";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const PACK = path.join(ROOT, "packs/tokyo");
const WORK = path.join(ROOT, "subway-builder-export/city-work");
const OUT = path.join(ROOT, "subway-builder-export/city-TYOTL");
fs.mkdirSync(WORK, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });

// ---- minimal PMTiles v3 reader (the npm package only reads one tile by z/x/y; we need to walk a whole zoom) ----
function openPm(file) {
  const fd = fs.openSync(file, "r");
  const read = (off, len) => { const b = Buffer.alloc(len); fs.readSync(fd, b, 0, len, off); return b; };
  const h = read(0, 127), u64 = (o) => Number(h.readBigUInt64LE(o));
  const hd = { rootOff: u64(8), rootLen: u64(16), leafOff: u64(40), dataOff: u64(56), internalComp: h[97], tileComp: h[98] };
  const unz = (b, comp) => (comp === 2 ? Buffer.from(gunzipSync(new Uint8Array(b))) : b);
  function dir(buf) { // -> [{tileId, run, length, offset}]
    let pos = 0; const rd = () => { let v = 0n, s = 0n, c; do { c = buf[pos++]; v |= BigInt(c & 127) << s; s += 7n; } while (c & 128); return Number(v); };
    const n = rd(), e = new Array(n); let id = 0;
    for (let i = 0; i < n; i++) { id += rd(); e[i] = { tileId: id, run: 0, length: 0, offset: 0 }; }
    for (let i = 0; i < n; i++) e[i].run = rd();
    for (let i = 0; i < n; i++) e[i].length = rd();
    for (let i = 0; i < n; i++) { const o = rd(); e[i].offset = o === 0 && i > 0 ? e[i - 1].offset + e[i - 1].length : o - 1; }
    return e;
  }
  function* tiles(zoom) { // yields {z,x,y,data}
    const stack = [[hd.rootOff, hd.rootLen]];
    while (stack.length) {
      const [off, len] = stack.pop();
      for (const e of dir(unz(read(off, len), hd.internalComp))) {
        if (e.run === 0) { stack.push([hd.leafOff + e.offset, e.length]); continue; }
        for (let k = 0; k < e.run; k++) {
          const [z, x, y] = tileIdToZxy(e.tileId + k);
          if (z !== zoom) continue;
          yield { z, x, y, data: unz(read(hd.dataOff + e.offset, e.length), hd.tileComp) };
        }
      }
    }
  }
  return { tiles };
}

// ---- helpers ----
const areaM2 = (geom) => { // planar area in m2 on a local equirectangular projection (fine for park/commercial sizes)
  const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.type === "MultiPolygon" ? geom.coordinates : [];
  let total = 0;
  for (const rings of polys) rings.forEach((ring, i) => {
    const lat0 = ring[0][1], kx = 111320 * Math.cos((lat0 * Math.PI) / 180), ky = 110540; let s = 0;
    for (let k = 0; k < ring.length - 1; k++) s += ring[k][0] * kx * ring[k + 1][1] * ky - ring[k + 1][0] * kx * ring[k][1] * ky;
    total += (i === 0 ? 1 : -1) * Math.abs(s / 2);
  });
  return Math.round(total);
};
// synchronous 1 MB-batched writes: no unbounded stream buffering (the old createWriteStream version held GBs in memory)
const writer = (name) => { const fd = fs.openSync(path.join(WORK, `${name}.geojsonl`), "w"); let buf = "", n = 0; const flush = () => { if (buf) { fs.writeSync(fd, buf); buf = ""; } }; return { put(f) { buf += JSON.stringify(f) + "\n"; n++; if (buf.length > 1 << 20) flush(); }, end: async () => { flush(); fs.closeSync(fd); }, get n() { return n; } }; };
// 7 decimals = ~1 cm; toGeoJSON returns 15-digit doubles, which made the buildings file >4 GB (and corrupted it)
const roundCoords = (c) => (typeof c[0] === "number" ? [Math.round(c[0] * 1e7) / 1e7, Math.round(c[1] * 1e7) / 1e7] : c.map(roundCoords));
const feat = (geometry, properties) => ({ type: "Feature", geometry: { type: geometry.type, coordinates: roundCoords(geometry.coordinates) }, properties });
const isPoly = (g) => g && (g.type === "Polygon" || g.type === "MultiPolygon");

const PARK_KINDS = new Set(["park", "garden", "forest", "wood", "grass", "grassland", "playground", "recreation_ground", "cemetery", "zoo", "scrub", "wetland", "nature_reserve", "golf_course"]);
const COMMERCIAL_KINDS = new Set(["commercial", "retail", "industrial"]);
const COLLEGE_KINDS = new Set(["university", "college"]);

// ---- 1) basemap z12 -> water / parks / commercial / airports / place labels ----
const W = { water: writer("water"), parks: writer("parks"), commercial: writer("commercial"), airports: writer("airports"), city: writer("city_labels"), suburb: writer("suburb_labels"), hood: writer("neighborhood_labels") };
const seenLabel = new Set();
let tilesRead = 0;
console.log("basemap z12 ...");
for (const t of openPm(path.join(PACK, "basemap.pmtiles")).tiles(12)) {
  tilesRead++;
  const vt = new VectorTile(new Pbf(new Uint8Array(t.data)));
  for (const name of ["water", "landuse", "places"]) {
    const layer = vt.layers[name]; if (!layer) continue;
    for (let i = 0; i < layer.length; i++) {
      const f = layer.feature(i).toGeoJSON(t.x, t.y, t.z), p = f.properties, g = f.geometry;
      if (name === "water" && isPoly(g)) W.water.put(feat(g, {}));
      else if (name === "landuse" && isPoly(g)) {
        if (PARK_KINDS.has(p.kind)) W.parks.put(feat(g, { area: areaM2(g) }));
        else if (COMMERCIAL_KINDS.has(p.kind)) W.commercial.put(feat(g, { type: "commercial", area: areaM2(g) }));
        else if (COLLEGE_KINDS.has(p.kind)) W.commercial.put(feat(g, { type: "college", area: areaM2(g) }));
        else if (p.kind === "aerodrome") W.airports.put(feat(g, {}));
      } else if (name === "places" && g.type === "Point") {
        const nm = p["name:en"]; if (!nm) continue;
        const key = `${nm}|${g.coordinates[0].toFixed(4)}|${g.coordinates[1].toFixed(4)}`; if (seenLabel.has(key)) continue; seenLabel.add(key);
        const props = { name: nm, label_type: p.kind_detail ?? p.kind, place: p.kind };
        if (p.kind === "locality" && ["city", "town", "village"].includes(p.kind_detail)) W.city.put(feat(g, props));
        else if (p.kind === "macrohood" || p.kind === "borough" || p.kind === "locality") W.suburb.put(feat(g, props));
        else if (p.kind === "neighbourhood") W.hood.put(feat(g, props));
      }
    }
  }
}
console.log(`  ${tilesRead} z12 tiles`, Object.fromEntries(Object.entries(W).map(([k, v]) => [k, v.n])));

// ---- 2) building pmtiles z14 -> buildings ----
const BUILDING_SOURCES = ["tokyo-survey-buildings", "saitama-buildings", "chiba-buildings", "kanagawa-buildings"];
const BW = Object.fromEntries(BUILDING_SOURCES.map((s) => [s, writer(`buildings_${s}`)])); // one file per source: keeps each well under 4 GB
const seen = new Set();
let bid = 1;
for (const file of BUILDING_SOURCES) {
  const B = BW[file];
  let n = 0, dup = 0;
  for (const t of openPm(path.join(PACK, `${file}.pmtiles`)).tiles(14)) {
    const layer = new VectorTile(new Pbf(new Uint8Array(t.data))).layers.building; if (!layer) continue;
    for (let i = 0; i < layer.length; i++) {
      const f = layer.feature(i).toGeoJSON(t.x, t.y, t.z); if (!isPoly(f.geometry)) continue;
      const key = crypto.createHash("md5").update(JSON.stringify(f.geometry.coordinates)).digest("base64").slice(0, 16);
      if (seen.has(key)) { dup++; continue; } seen.add(key);
      const p = f.properties, lv = Number(p.levels);
      const height = Number(p.height) > 0 ? Number(p.height) : lv > 0 ? Math.round(lv * 3.3 * 10) / 10 : 9;
      B.put(feat(f.geometry, { id: bid++, height })); n++;
    }
  }
  console.log(`  ${file}: ${n} buildings (${dup} duplicates dropped)`);
}
await Promise.all([...Object.values(W), ...Object.values(BW)].map((w) => w.end()));

// ---- 3) planetiler schema + run ----
const layers = [
  ["water", "water", "polygon", 5, []], ["parks", "parks", "polygon", 8, ["area"]], ["commercial", "commercial", "polygon", 9, ["type", "area"]],
  ["airports", "airports", "polygon", 6, []], ["city_labels", "city_labels", "point", 5, ["name", "label_type", "place"]],
  ["suburb_labels", "suburb_labels", "point", 9, ["name", "label_type", "place"]], ["neighborhood_labels", "neighborhood_labels", "point", 11, ["name", "label_type", "place"]],
  ...BUILDING_SOURCES.map((s) => ["buildings", `buildings_${s}`, "polygon", 12, ["id", "height"]]),
];
const yml = [
  "schema_name: Greater Tokyo (Transitline) game tiles",
  "schema_description: Basemap tiles in the layer layout Subway Builder v1.7.1 reads for a city",
  // single-quoted YAML scalar: a bare ": " inside the text is a YAML syntax error
  `attribution: '<a href="https://www.openstreetmap.org/copyright" target="_blank">&copy; OpenStreetMap contributors</a>; buildings - Tokyo Metropolitan Government land use survey R3 (CC BY 4.0) and OSM'`,
  "sources:", ...layers.map(([, src]) => `  ${src}:\n    type: geojson\n    local_path: ${src}.geojsonl`),
  "layers:", ...[...new Set(layers.map(([id]) => id))].flatMap((id) => [`- id: ${id}`, "  features:", ...layers.filter(([i]) => i === id).flatMap(([, src, geom, minz, attrs]) => [`  - source: ${src}`, `    geometry: ${geom}`, `    min_zoom: ${minz}`, ...(attrs.length ? ["    attributes:", ...attrs.map((a) => `    - key: ${a}`)] : [])])]),
].join("\n") + "\n";
fs.writeFileSync(path.join(WORK, "schema.yml"), yml);
if (process.argv.includes("--no-build")) { console.log("wrote GeoJSON + schema.yml only (--no-build)"); process.exit(0); }

const jar = process.env.PLANETILER_JAR || path.join(ROOT, "data-raw/planetiler.jar");
if (!fs.existsSync(jar)) throw new Error(`planetiler.jar not found at ${jar} - set PLANETILER_JAR`);
const out = path.join(OUT, "tiles.pmtiles");
console.log("planetiler ...");
const r = spawnSync("java", ["-Xmx8g", "-jar", jar, "generate-custom", "--schema=schema.yml", `--output=${out}`, "--minzoom=5", "--maxzoom=15", "--force", "--download_dir=" + path.join(WORK, "sources"), "--tmpdir=" + path.join(WORK, "tmp")], { cwd: WORK, stdio: "inherit" });
if (r.status !== 0) throw new Error(`planetiler exited with ${r.status}`);
console.log("wrote", out, (fs.statSync(out).size / 1e6).toFixed(1), "MB");
