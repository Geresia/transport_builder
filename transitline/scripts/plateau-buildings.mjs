// Extract per-building attributes from PLATEAU 3D Tiles (b3dm batch tables) into compact JSON.
// PLATEAU building tiles carry lon/lat centroids (_x/_y) plus survey attributes from the city's
// 都市計画基礎調査 (建物利用現況), so the glTF geometry never has to be decoded.
// Usage: node scripts/plateau-buildings.mjs <dir-with-b3dm> <out.json> [--stats]
// Fields per building: [lon, lat, 用途, 地上階数, 建築面積 m2, 延床面積 m2, 調査年, 建物利用現況_小分類, 構造, 図上面積 m2 (from geometry), 計測高さ m, 建物ID, part footprint m2 from mesh (roof+floor)/2, 地下階数]
// NOTE: 建物ID-level attributes (建築面積, 延床面積, 図上面積, 用途) repeat on every 枝番 part of a building.
// Cities vary in which fields exist and how they're stored: some (Saitama) inline small ints as a plain JSON
// array, others (Kawasaki's 調査年) reference the shared binary buffer instead (any GL component type, not
// just DOUBLE) - field() below reads either form. Missing fields (e.g. no 地下階数, no 図上面積) come back null.
// New fields are appended, never inserted, so column indices stay stable across cities and re-extractions.
//
// Two generations of PLATEAU export exist, both handled here via FIELDS' fallback name lists (first name
// found wins): older FME 2020-2023 exports (Saitama, Kawasaki, Sagamihara, ...) use ad-hoc Japanese keys
// (用途, 建物利用現況_延床面積, 地上階数, ...); newer "standard product spec V3+" exports (Chiba-shi 2024,
// Atsugi/Fujisawa/Kamakura/Kisarazu/Yachiyo/Mobara's only available vintage) use standard CityGML/UBLD
// keys (bldg:usage, uro:BuildingDetailAttribute_uro:totalFloorArea, bldg:storeysAboveGround, ...) with the
// same real survey values underneath, just different names - initially misread as "no floor area" before
// this was found. The newer schema has no old-style multi-part-building 建物ID/枝番 split (its buildingID
// is already unique per feature, verified against several cities' samples), so buildingRecords() in
// plateau-chome.mjs still works unchanged - groups of size 1 there are a no-op.
import fs from "fs";
import path from "path";
import { meshHorizontalArea } from "./plateau-footprint.mjs";

const [dir, out] = process.argv.slice(2);
if (!dir || !out) throw new Error("usage: plateau-buildings.mjs <dir> <out.json>");

function* walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (p.endsWith(".b3dm")) yield p;
  }
}

const seen = new Set(), rows = [];
let tiles = 0, dup = 0, dracoTiles = 0;
for (const f of walk(dir)) {
  tiles++;
  const b = fs.readFileSync(f);
  const ftJ = b.readUInt32LE(12), ftB = b.readUInt32LE(16), btJ = b.readUInt32LE(20);
  const start = 28 + ftJ + ftB;
  const bt = JSON.parse(b.subarray(start, start + btJ).toString("utf8"));
  const n = JSON.parse(b.subarray(28, 28 + ftJ).toString("utf8")).BATCH_LENGTH;
  const bin = start + btJ;
  const mesh = meshHorizontalArea(b, n); // null if the tile is Draco-compressed (see plateau-footprint.mjs); treated as all-zero below
  if (mesh == null) dracoTiles++;
  // GL component type -> bytes-per-element and the Buffer read method, for fields stored in the shared
  // binary blob instead of inline as a JSON array (varies per city and even per field within one city).
  const READERS = {
    BYTE: [1, "readInt8"], UNSIGNED_BYTE: [1, "readUInt8"],
    SHORT: [2, "readInt16LE"], UNSIGNED_SHORT: [2, "readUInt16LE"],
    INT: [4, "readInt32LE"], UNSIGNED_INT: [4, "readUInt32LE"],
    FLOAT: [4, "readFloatLE"], DOUBLE: [8, "readDoubleLE"],
  };
  // key can be a single field name or [oldSchemaName, newSchemaName, ...] - first one present in this
  // tile's batch table wins (a city uses one schema consistently, but the field name still varies by field:
  // e.g. Yokosuka's old-schema tile still lacks 図上面積, same as a name simply not existing anywhere).
  const field = (key, i) => {
    for (const k of Array.isArray(key) ? key : [key]) {
      const m = bt[k];
      if (m == null) continue;
      if (Array.isArray(m)) return m[i] ?? null;
      const r = READERS[m.componentType];
      if (!r) continue;
      const [size, method] = r;
      return b[method](bin + m.byteOffset + size * i);
    }
    return null;
  };
  const round1 = (v) => (v == null ? null : +v.toFixed(1));
  const numOrNull = (v) => (v == null ? null : Number(v));
  const buildingIdKey = ["建物ID", "uro:BuildingIDAttribute_uro:buildingID"];
  for (let i = 0; i < n; i++) {
    // 枝番 (multi-part branch number) only exists in the old schema; the new schema's buildingID is already
    // one-per-feature (verified per-city, see the file header), so a missing 枝番 here just means "no branches".
    const id = `${field(buildingIdKey, i)}-${bt["建物ID_枝番"]?.[i]}`;
    if (seen.has(id)) { dup++; continue; }
    seen.add(id);
    rows.push([
      +field("_x", i).toFixed(6), +field("_y", i).toFixed(6),
      field(["用途", "bldg:usage"], i), field(["地上階数", "bldg:storeysAboveGround"], i),
      field(["建物利用現況_建築面積", "uro:BuildingDetailAttribute_uro:buildingFootprintArea"], i),
      field(["建物利用現況_延床面積", "uro:BuildingDetailAttribute_uro:totalFloorArea"], i),
      numOrNull(field(["建物利用現況_調査年", "uro:BuildingDetailAttribute_uro:surveyYear"], i)),
      field(["建物利用現況_小分類", "bldg:class"], i), field(["建物構造_自治体独自分類", "uro:BuildingDetailAttribute_uro:buildingStructureType"], i),
      field("建物利用現況_図上面積", i), round1(field(["計測高さ", "bldg:measuredHeight"], i)),
      field(buildingIdKey, i), mesh == null ? 0 : +(mesh[i] / 2).toFixed(1), field(["地下階数", "bldg:storeysBelowGround"], i),
    ]);
  }
}
fs.writeFileSync(out, JSON.stringify(rows));

const tally = (i) => { const c = {}; for (const r of rows) c[r[i]] = (c[r[i]] ?? 0) + 1; return Object.entries(c).sort((a, b) => b[1] - a[1]); };
const nn = (i) => rows.filter((r) => r[i] != null).length;
console.log({ tiles, dracoTiles, buildings: rows.length, duplicatesSkipped: dup, withStoreys: nn(3), withFloorArea: nn(5), withUse: nn(2) });
if (dracoTiles) console.log(`NOTE: ${dracoTiles}/${tiles} tiles are Draco-compressed and could not be decoded for a mesh-fallback footprint - buildings there without a surveyed 延床面積 will be skipped downstream (0 footprint -> noArea), not estimated.`);
console.log("years", tally(6).slice(0, 6));
console.log("用途", tally(2).slice(0, 20));
