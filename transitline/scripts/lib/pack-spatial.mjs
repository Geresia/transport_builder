// Dev-time loaders shared by the example generators (build-plan-examples, build-depot-examples).
// They read pack files and the local, git-ignored DEM / roads, and hand them to engine/src/map as spatial
// layers; the engine layer itself holds no geometry (LICENSING.md rule 2). A layer whose file is missing is
// skipped, so its fields come out unknown (null) — never 0.
//
// Vector tiles (areas / buildings) need dev-only packages that are not in package.json:
//   npm i --no-save pmtiles @mapbox/vector-tile pbf
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import {
  makeSpatialContext, waterLayerFromBarriers, buildingLayerFromObstacles, roadLayerFromGeojson, regionCovers, polygonLayer,
} from "../../engine/src/map/spatial.mjs";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const readJson = (p) => JSON.parse(fs.readFileSync(path.join(root, p), "utf8"));
export const exists = (p) => fs.existsSync(path.join(root, p));

export function loadPack(id) {
  const dir = `packs/${id}`;
  const manifest = readJson(`${dir}/manifest.json`);
  return {
    dir, manifest,
    demand: readJson(`${dir}/${manifest.files.demand}`),
    existingNetwork: manifest.files.existingNetwork ? readJson(`${dir}/${manifest.files.existingNetwork}`) : null,
  };
}

// --- GSI DEM10B 31 m grid (data-raw/terrain/README.md documents the pixel formula) ---
export function loadDem() {
  const base = "data-raw/terrain/derived";
  if (!exists(`${base}/elev-31m.i16`) || !exists(`${base}/slope-31m.u8`)) return null;
  const g = readJson(`${base}/grid.json`);
  const raw = fs.readFileSync(path.join(root, `${base}/elev-31m.i16`));
  const elev = new Int16Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length));
  const slope = fs.readFileSync(path.join(root, `${base}/slope-31m.u8`));
  const world = 256 * 2 ** g.zoom;
  const cell = ([lon, lat]) => {
    const px = ((lon + 180) / 360) * world;
    const latR = (lat * Math.PI) / 180;
    const py = ((1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2) * world;
    const x = Math.floor((px - g.originTileX * 256) / g.cellPixels);
    const y = Math.floor((py - g.originTileY * 256) / g.cellPixels);
    return x >= 0 && y >= 0 && x < g.width && y < g.height ? y * g.width + x : -1;
  };
  return {
    elevationAt: (pt) => { const i = cell(pt); return i < 0 || elev[i] === -32768 ? null : elev[i]; },
    slopeAt: (pt) => { const i = cell(pt); return i < 0 || slope[i] === 255 ? null : slope[i]; },
    quality: "medium", // 31 m mean cells: cliffs and cuttings narrower than that are averaged away
    source: { name: "国土地理院 数値標高モデル DEM10B (dem_png z14), 31 m mean grid", license: "GSI terms of use (credit: 国土地理院)" },
  };
}

const wardPolygons = (pack) => readJson(`${pack.dir}/wards-reference.json`).wards.flatMap((w) => w.polygons);

// OSM roads were fetched for the 23 wards only: coverage = the 23 ward polygons
export function roadsLayer(pack) {
  return roadLayerFromGeojson(readJson("subway-builder-export/roads.all.geojson"), {
    covers: regionCovers(wardPolygons(pack)), quality: "high",
    source: { name: "OpenStreetMap roads (23 wards), subway-builder-export/roads.all.geojson", license: "ODbL-1.0" },
  });
}

// Layers the plan examples use (obstacles.json footprints cover four districts only).
export function tokyoSpatial(pack) {
  const layers = {};
  const dem = loadDem();
  if (dem) layers.dem = dem;

  if (exists(`${pack.dir}/barriers.json`)) {
    const [w, s, e, n] = pack.manifest.bbox;
    layers.water = waterLayerFromBarriers(readJson(`${pack.dir}/barriers.json`), {
      covers: ([x, y]) => x >= w && x <= e && y >= s && y <= n, quality: "medium",
      source: { name: "国土交通省 国土数値情報 water polygons (via smartnews-smri/japan-topography), packs/tokyo/barriers.json", license: "MLIT-KSJ-terms" },
    });
  }
  if (exists(`${pack.dir}/obstacles.json`)) {
    layers.buildings = buildingLayerFromObstacles(readJson(`${pack.dir}/obstacles.json`), {
      quality: "high", source: { name: "OpenStreetMap building footprints, packs/tokyo/obstacles.json", license: "ODbL-1.0" },
    });
  }
  if (exists("subway-builder-export/roads.all.geojson")) layers.roads = roadsLayer(pack);
  const status = Object.fromEntries(["dem", "water", "buildings", "roads"].map((k) => [k, Boolean(layers[k])]));
  return { spatial: makeSpatialContext(layers), status, layers };
}

// --- vector tiles -> polygons -----------------------------------------------------------------
class FileSource {
  constructor(p) { this.fd = fs.openSync(p, "r"); this.p = p; }
  getKey() { return this.p; }
  async getBytes(offset, length) {
    const b = Buffer.alloc(length);
    fs.readSync(this.fd, b, 0, length, offset);
    return { data: b.buffer.slice(b.byteOffset, b.byteOffset + length) };
  }
}
const lon2x = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z);
const lat2y = (lat, z) => Math.floor(((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) * 2 ** z);

// Polygons of one tile layer over bbox [w,s,e,n], at zoom 14. Features are clipped per tile, so with `owned`
// a feature is kept only in the tile that holds its top-left corner (each building is counted once).
export async function tilePolygons(file, layerName, bbox, { z = 14, owned = false } = {}) {
  const { PMTiles } = await import("pmtiles");
  const { VectorTile } = await import("@mapbox/vector-tile");
  const PbfModule = await import("pbf");
  const Pbf = [PbfModule.default, PbfModule.Pbf, ...Object.values(PbfModule)].find((v) => typeof v === "function"); // export name differs across pbf versions
  const pm = new PMTiles(new FileSource(path.join(root, file)));
  const out = [];
  for (let x = lon2x(bbox[0], z); x <= lon2x(bbox[2], z); x++) {
    for (let y = lat2y(bbox[3], z); y <= lat2y(bbox[1], z); y++) {
      const tile = await pm.getZxy(z, x, y);
      if (!tile) continue;
      let buf = Buffer.from(tile.data);
      if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
      const layer = new VectorTile(new Pbf(buf)).layers[layerName];
      if (!layer) continue;
      for (let i = 0; i < layer.length; i++) {
        const ft = layer.feature(i);
        if (ft.type !== 3) continue;
        if (owned) {
          const pts = ft.loadGeometry().flat();
          const minX = Math.min(...pts.map((p) => p.x));
          const minY = Math.min(...pts.map((p) => p.y));
          if (!(minX > 0 && minY > 0 && minX < layer.extent && minY < layer.extent)) continue;
        }
        const g = ft.toGeoJSON(x, y, z).geometry;
        for (const poly of g.type === "Polygon" ? [g.coordinates] : g.coordinates) out.push({ rings: poly, kind: ft.properties.sourceKind ?? ft.properties.kind });
      }
    }
  }
  return out;
}

// Layers only the depot examples need, decoded around the given bounding box.
export async function tokyoDepotLayers(pack, bbox, base = tokyoSpatial(pack).layers) {
  const layers = { ...base };
  delete layers.buildings; // the four-district footprints are replaced by the 23-ward tiles below
  if (exists(`${pack.dir}/tokyo-buildings.pmtiles`)) {
    layers.buildings = polygonLayer(await tilePolygons(`${pack.dir}/tokyo-buildings.pmtiles`, "building", bbox, { owned: true }), {
      covers: regionCovers(wardPolygons(pack)), quality: "high",
      source: { name: "OpenStreetMap building footprints (23 wards), packs/tokyo/tokyo-buildings.pmtiles z14", license: "ODbL-1.0" },
    });
  }
  if (exists(`${pack.dir}/areas.pmtiles`)) {
    const [w, s, e, n] = pack.manifest.bbox;
    const inPack = ([x, y]) => x >= w && x <= e && y >= s && y <= n;
    const areas = await tilePolygons(`${pack.dir}/areas.pmtiles`, "area", bbox);
    const src = { license: "ODbL-1.0" };
    layers.residential = polygonLayer(areas.filter((a) => a.kind === "residential"), { covers: inPack, quality: "high", source: { ...src, name: "OpenStreetMap landuse=residential, packs/tokyo/areas.pmtiles z14" } });
    // every mapped area kind (park, school, cemetery, ...): station entrances read the land use at their point
    layers.landuse = polygonLayer(areas.filter((a) => a.kind), { covers: inPack, quality: "high", source: { ...src, name: "OpenStreetMap landuse / leisure / amenity areas, packs/tokyo/areas.pmtiles z14" } });
    layers.railFacilities = polygonLayer(areas.filter((a) => a.kind === "railway").map((a) => ({ ...a, kind: "railway-land" })), { covers: inPack, quality: "high", source: { ...src, name: "OpenStreetMap landuse=railway, packs/tokyo/areas.pmtiles z14" } });
  }
  return layers;
}
