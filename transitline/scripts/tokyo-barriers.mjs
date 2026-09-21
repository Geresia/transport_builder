// Builds packs/tokyo/barriers.json: water polygons (from basemap.pmtiles, z12) and the bridges
// (from *-roads.pmtiles, z14) that cross them, for "people cannot walk across water" routing.
// One-off tool, not part of the engine. Needs: npm i pmtiles @mapbox/vector-tile pbf polygon-clipping @turf/area
// usage (from a folder with those packages installed): node --max-old-space-size=6000 tokyo-barriers.mjs
import fs from "node:fs";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { PMTiles } from "pmtiles";
import { VectorTile } from "@mapbox/vector-tile";
import { PbfReader as Pbf } from "pbf";
import polygonClipping from "polygon-clipping";
import area from "@turf/area";

export class FileSource {
  constructor(p) { this.p = p; this.fd = fs.openSync(p, "r"); }
  getKey() { return this.p; }
  async getBytes(offset, length) {
    const b = Buffer.alloc(length); fs.readSync(this.fd, b, 0, length, offset);
    return { data: b.buffer.slice(b.byteOffset, b.byteOffset + length) };
  }
}
export const open = (p) => new PMTiles(new FileSource(p));
export const lonlat2tile = (lon, lat, z) => {
  const n = 2 ** z, x = Math.floor((lon + 180) / 360 * n);
  const r = lat * Math.PI / 180, y = Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n);
  return [x, y];
};
export async function readTile(pm, z, x, y) {
  const t = await pm.getZxy(z, x, y);
  if (!t) return null;
  let buf = Buffer.from(t.data);
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
  return new VectorTile(new Pbf(buf));
}



const PACK = fileURLToPath(new URL("../packs/tokyo/", import.meta.url));
const DROP = new Set(["swimming_pool", "fountain", "drain", "ditch", "stream"]);
const MIN_AREA_M2 = 10000;
const r5 = (v) => Math.round(v * 1e5) / 1e5;
const tileRange = (h, z) => {
  const n = 2 ** z, lon2x = (l) => Math.floor((l + 180) / 360 * n);
  const lat2y = (l) => { const r = l * Math.PI / 180; return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n); };
  return [lon2x(h.minLon), lon2x(h.maxLon), lat2y(h.maxLat), lat2y(h.minLat)];
};

// ---- 1. water polygons ----
const bm = open(PACK + "basemap.pmtiles"); const bh = await bm.getHeader();
const [wx0, wx1, wy0, wy1] = tileRange(bh, 12);
const parts = [];
for (let x = wx0; x <= wx1; x++) for (let y = wy0; y <= wy1; y++) {
  const vt = await readTile(bm, 12, x, y); const w = vt?.layers.water; if (!w) continue;
  for (let i = 0; i < w.length; i++) {
    const f = w.feature(i); if (f.type !== 3 || DROP.has(f.properties.kind)) continue;
    const g = f.toGeoJSON(x, y, 12).geometry;
    for (const p of (g.type === "Polygon" ? [g.coordinates] : g.coordinates)) parts.push([p]);
  }
}
const merged = polygonClipping.union(...parts);
const water = merged.filter((c) => area({ type: "Polygon", coordinates: c }) >= MIN_AREA_M2)
  .map((c) => c.map((ring) => ring.map(([lo, la]) => [r5(lo), r5(la)])));
console.log("water polygons", water.length, "of", merged.length, "(>= " + MIN_AREA_M2 + " m2)");

// ---- 2. point-in-water: even-odd ray cast over all rings, edges bucketed by latitude band ----
const BAND = 0.0005; const bands = new Map();
for (const poly of water) for (const ring of poly) for (let i = 0; i < ring.length - 1; i++) {
  const [x1, y1] = ring[i], [x2, y2] = ring[i + 1]; if (y1 === y2) continue;
  const lo = Math.floor(Math.min(y1, y2) / BAND), hi = Math.floor(Math.max(y1, y2) / BAND);
  const e = [x1, y1, x2, y2];
  for (let b = lo; b <= hi; b++) { let a = bands.get(b); if (!a) bands.set(b, a = []); a.push(e); }
}
const inWater = (lon, lat) => {
  let c = false;
  for (const [x1, y1, x2, y2] of bands.get(Math.floor(lat / BAND)) ?? []) {
    if ((y1 > lat) !== (y2 > lat) && lon < x1 + (lat - y1) * (x2 - x1) / (y2 - y1)) c = !c;
  }
  return c;
};
globalThis.__inWater = inWater;

// ---- 3. bridges crossing water ----
const NO_WALK = new Set(["motorway", "motorway_link", "trunk", "trunk_link"]);
const crossings = new Map(); let bridgeLines = 0;
for (const area_ of ["tokyo", "saitama", "chiba", "kanagawa"]) {
  const pm = open(PACK + area_ + "-roads.pmtiles"); const h = await pm.getHeader();
  const [x0, x1, y0, y1] = tileRange(h, 14);
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
    const vt = await readTile(pm, 14, x, y); if (!vt) continue;
    for (const layer of ["road", "path"]) {
      const L = vt.layers[layer]; if (!L) continue;
      for (let i = 0; i < L.length; i++) {
        const f = L.feature(i); const br = f.properties.bridge;
        if (!br || br === "no" || f.type !== 2) continue;
        if (layer === "road" && NO_WALK.has(f.properties.kind)) continue;
        const g = f.toGeoJSON(x, y, 14).geometry;
        for (const line of (g.type === "LineString" ? [g.coordinates] : g.coordinates)) {
          bridgeLines++;
          // sample every ~10 m along the line; a bridge counts if any sample is over water
          let over = false;
          for (let s = 0; s < line.length - 1 && !over; s++) {
            const [ax, ay] = line[s], [bx, by] = line[s + 1];
            const steps = Math.max(1, Math.ceil(Math.hypot((bx - ax) * 91000, (by - ay) * 111000) / 10));
            for (let k = 0; k <= steps; k++) if (inWater(ax + (bx - ax) * k / steps, ay + (by - ay) * k / steps)) { over = true; break; }
          }
          if (!over) continue;
          const pts = line.map(([lo, la]) => [r5(lo), r5(la)]);
          crossings.set(JSON.stringify(pts), { kind: layer === "path" ? "footbridge" : "bridge", sub: f.properties.kind, line: pts });
        }
      }
    }
  }
}
console.log("bridge lines seen", bridgeLines, "-> crossing water:", crossings.size);

const out = {
  formatVersion: 1,
  note: "Areas people cannot walk across (water) and the bridges that cross them. Even-odd rings: polygon[0] outer, rest holes.",
  barriers: water.map((polygon) => ({ kind: "water", polygon })),
  crossings: [...crossings.values()],
};
fs.writeFileSync(PACK + "barriers.json", JSON.stringify(out));
console.log("barriers.json bytes", fs.statSync(PACK + "barriers.json").size);

