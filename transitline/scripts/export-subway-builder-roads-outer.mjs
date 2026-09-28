// Adds roads OUTSIDE the 23 special wards, so driving-demand routing doesn't just vanish at the ward border
// (found in-game 2026-09-28: leaving Tokyo-proper, roads disappear and unnamed stations fall back to a generic
// "Station" label). export-subway-builder-roads.mjs only ever fetched the 23 wards via Overpass; this script
// instead reuses roads already in this pack - packs/tokyo/{saitama,chiba,kanagawa,tokyo}-roads.pmtiles - which
// cover the rest of Kanto (Saitama/Chiba/Kanagawa prefectures, and Tokyo's Tama-area municipalities).
//
// Same {roadClass, structure, name} shape as roads.all.geojson (roadClass mapping copied from there), but these
// prefecture tiles carry no name field at all (`name: ""` for every feature - close to the real game's own file,
// which only names ~7% of segments anyway).
//
// tokyo-roads.pmtiles' bbox is much bigger than Tokyo prefecture (looks like most of Japan), and its road ids
// are NOT guaranteed disjoint from the 23-ward roads.all.geojson (which strips ids after de-duplicating, so we
// can't match by id here). Kept simple: only take tokyo-roads.pmtiles features that fit inside the Tama
// municipalities' own bbox (from subward-tama.json) - by construction that can't overlap a special-ward road.
//
// Usage: node --max-old-space-size=4096 scripts/export-subway-builder-roads-outer.mjs
//   out: subway-builder-export/roads.outer.geojson (consumed by install-subway-builder-city.mjs, merged with
//   roads.all.geojson into the staged roads.geojson - see that script)
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { tileIdToZxy } from "pmtiles";
import { VectorTile } from "@mapbox/vector-tile";
import { PbfReader as Pbf } from "pbf";
import { gunzipSync } from "fflate";

const PACK = fileURLToPath(new URL("../packs/tokyo/", import.meta.url));
const OUT = fileURLToPath(new URL("../subway-builder-export/", import.meta.url));

const HIGHWAY_CLASS = { // copied from export-subway-builder-roads.mjs, must stay identical
  motorway: "highway", motorway_link: "highway",
  trunk: "major", trunk_link: "major", primary: "major", primary_link: "major",
  secondary: "minor", secondary_link: "minor", tertiary: "minor", tertiary_link: "minor",
  unclassified: "minor", residential: "minor",
};

function openPm(file) {
  const fd = fs.openSync(file, "r");
  const read = (off, len) => { const b = Buffer.alloc(len); fs.readSync(fd, b, 0, len, off); return b; };
  const h = read(0, 127), u64 = (o) => Number(h.readBigUInt64LE(o));
  const hd = { rootOff: u64(8), rootLen: u64(16), leafOff: u64(40), dataOff: u64(56), internalComp: h[97], tileComp: h[98] };
  const unz = (b, comp) => (comp === 2 ? Buffer.from(gunzipSync(new Uint8Array(b))) : b);
  function dir(buf) {
    let pos = 0; const rd = () => { let v = 0n, s = 0n, c; do { c = buf[pos++]; v |= BigInt(c & 127) << s; s += 7n; } while (c & 128); return Number(v); };
    const n = rd(), e = new Array(n); let id = 0;
    for (let i = 0; i < n; i++) { id += rd(); e[i] = { tileId: id, run: 0, length: 0, offset: 0 }; }
    for (let i = 0; i < n; i++) e[i].run = rd();
    for (let i = 0; i < n; i++) e[i].length = rd();
    for (let i = 0; i < n; i++) { const o = rd(); e[i].offset = o === 0 && i > 0 ? e[i - 1].offset + e[i - 1].length : o - 1; }
    return e;
  }
  function* tiles(zoom) {
    const stack = [[hd.rootOff, hd.rootLen]];
    while (stack.length) {
      const [off, len] = stack.pop();
      for (const e of dir(unz(read(off, len), hd.internalComp))) {
        if (e.run === 0) { stack.push([hd.leafOff + e.offset, e.length]); continue; }
        for (let k = 0; k < e.run; k++) { const [z, x, y] = tileIdToZxy(e.tileId + k); if (z === zoom) yield { z, x, y, data: unz(read(hd.dataOff + e.offset, e.length), hd.tileComp) }; }
      }
    }
  }
  return { tiles };
}

// Tama municipalities' own bbox (subward-tama.json), used as a hard extraction window - anything outside it
// can't be a special-ward road, so this can't create duplicates with roads.all.geojson.
const tamaWards = JSON.parse(fs.readFileSync(PACK + "subward-tama.json", "utf8")).wards;
let tamaMinLon = Infinity, tamaMinLat = Infinity, tamaMaxLon = -Infinity, tamaMaxLat = -Infinity;
for (const w of Object.values(tamaWards)) for (const a of w.areas) for (const poly of a.polygons) for (const ring of poly) for (const [lon, lat] of ring) {
  if (lon < tamaMinLon) tamaMinLon = lon; if (lon > tamaMaxLon) tamaMaxLon = lon;
  if (lat < tamaMinLat) tamaMinLat = lat; if (lat > tamaMaxLat) tamaMaxLat = lat;
}
console.log("Tama bbox:", { tamaMinLon, tamaMinLat, tamaMaxLon, tamaMaxLat });
const inTama = ([lon, lat]) => lon >= tamaMinLon && lon <= tamaMaxLon && lat >= tamaMinLat && lat <= tamaMaxLat;

const seenTileId = new Set(); // a way can repeat across neighbouring tiles at the same zoom
const features = [];
function extract(file, { tamaOnly = false } = {}) {
  let kept = 0, dropped = 0;
  for (const t of openPm(PACK + file).tiles(14)) {
    const layer = new VectorTile(new Pbf(new Uint8Array(t.data))).layers.road; if (!layer) continue;
    for (let i = 0; i < layer.length; i++) {
      const f = layer.feature(i);
      if (seenTileId.has(f.id)) continue; seenTileId.add(f.id);
      const roadClass = HIGHWAY_CLASS[f.properties.kind];
      if (!roadClass) { dropped++; continue; }
      const geo = f.toGeoJSON(t.x, t.y, t.z);
      if (tamaOnly && !geo.geometry.coordinates.every(inTama)) { dropped++; continue; }
      const structure = f.properties.bridge === "yes" ? "bridge" : f.properties.tunnel === "yes" ? "tunnel" : "normal";
      features.push({ type: "Feature", properties: { roadClass, structure, name: "" }, geometry: geo.geometry });
      kept++;
    }
  }
  console.log(`${file}: ${kept} kept, ${dropped} dropped`);
}
extract("saitama-roads.pmtiles");
extract("chiba-roads.pmtiles");
extract("kanagawa-roads.pmtiles");
extract("tokyo-roads.pmtiles", { tamaOnly: true });

fs.writeFileSync(OUT + "roads.outer.geojson", JSON.stringify({ type: "FeatureCollection", features }));
console.log({ features: features.length, bytes: fs.statSync(OUT + "roads.outer.geojson").size, outPath: OUT + "roads.outer.geojson" });
