// Fetches real OSM roads (Overpass) and writes them in the `roadClass`/`structure`/`name` shape the game reads
// (RoadProperties in compatibility-test-mod's src/types/index.d.ts, MIT-licensed API types - reused as a target
// format). For one ward, or for all 23 ("all": fetch every ward not yet on disk, then merge + de-duplicate).
//
// Query and roadClass mapping adapted from Subway-Builder-Modded/map-manager's map_scripts/download_data.js
// (ISC license, "for any purpose with or without fee" - reused directly, not just read for ideas):
// fetchRoadData()'s Overpass query + `roadTypes` map (motorway[_link]->highway, trunk/primary[_link]->major,
// secondary/tertiary[_link]/unclassified/residential->minor) and getStreetName()'s name-preference logic. Two
// things added beyond that reference: (1) it always writes structure:"normal" (no bridge/tunnel split) - here
// bridge=yes/tunnel=yes are read from OSM tags and mapped to the game's other two `structure` values, confirmed to
// exist by reading the real installed game's own roads.geojson (see subway-builder-export/README.md); (2) it
// queries one ward's polygon (from wards-reference.json) instead of a bounding box.
//
// A way that crosses a ward boundary is returned by both wards' queries, so per-ward files keep the OSM way id as
// the GeoJSON Feature `id` (a standard top-level member, not one of the three game properties) and the merged
// roads.all.geojson de-duplicates on it and then strips it - the file the game reads carries exactly
// {roadClass, structure, name} per feature, like the real one.
//
// Resumable: a ward whose roads.<slug>.geojson already exists is skipped (delete it to refetch).
// Usage: node scripts/export-subway-builder-roads.mjs <wardSlug|千代田区|all>
import fs from "node:fs";
import { fileURLToPath } from "node:url";
const T = fileURLToPath(new URL("../packs/tokyo/", import.meta.url));
const OUT = fileURLToPath(new URL("../subway-builder-export/", import.meta.url));
fs.mkdirSync(OUT, { recursive: true });

const WARD_EN = { chiyoda: "千代田区", chuo: "中央区", minato: "港区", shinjuku: "新宿区", bunkyo: "文京区", taito: "台東区", sumida: "墨田区", koto: "江東区", shinagawa: "品川区", meguro: "目黒区", ota: "大田区", setagaya: "世田谷区", shibuya: "渋谷区", nakano: "中野区", suginami: "杉並区", toshima: "豊島区", kita: "北区", arakawa: "荒川区", itabashi: "板橋区", nerima: "練馬区", adachi: "足立区", katsushika: "葛飾区", edogawa: "江戸川区" };
const arg = process.argv[2];
if (!arg) throw new Error("usage: export-subway-builder-roads.mjs <wardSlug|千代田区-style name|all>");
const wardsRef = JSON.parse(fs.readFileSync(T + "wards-reference.json", "utf8")).wards;

const HIGHWAY_CLASS = {
  motorway: "highway", motorway_link: "highway",
  trunk: "major", trunk_link: "major", primary: "major", primary_link: "major",
  secondary: "minor", secondary_link: "minor", tertiary: "minor", tertiary_link: "minor",
  unclassified: "minor", residential: "minor",
};
const MIRRORS = ["https://overpass.kumi.systems/api/interpreter", "https://overpass.monicz.dev/api/interpreter", "https://maps.mail.ru/osm/tools/overpass/api/interpreter"];

async function runQuery(q) {
  let lastErr;
  for (const mirror of MIRRORS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(mirror, { method: "POST", body: `data=${encodeURIComponent(q)}`, headers: { "User-Agent": "transitline (research; contact via github.com/subway-builder-modded)" } });
        if (!res.ok) { lastErr = new Error(`${mirror}: HTTP ${res.status}`); await new Promise((r) => setTimeout(r, 4000)); continue; }
        return await res.json();
      } catch (e) { lastErr = e; await new Promise((r) => setTimeout(r, 4000)); }
    }
    console.log(`    mirror failed (${lastErr?.message}), trying next`);
  }
  throw lastErr ?? new Error("all Overpass mirrors failed");
}

// getStreetName, unchanged from the reference: prefer an explicit English name, fall back to the OSM `name` tag,
// then `ref` (route number); empty string otherwise. This is why the real game's own roads.geojson names only
// ~7% of segments - most residential streets carry no name:en/ref.
function getStreetName(tags, preferLocale = "en") {
  if (tags.noname === "yes") return "";
  const localized = tags[`name:${preferLocale}`];
  if (localized && localized.trim()) return localized.trim();
  if (tags.name && tags.name.trim()) return tags.name.trim();
  if (tags.ref && tags.ref.trim()) return tags.ref.trim();
  return "";
}

async function fetchWard(slug) {
  const nameJa = WARD_EN[slug] || slug;
  const ward = wardsRef.find((w) => w.name_ja === nameJa);
  if (!ward) throw new Error(`ward not found: ${slug} (tried name_ja='${nameJa}')`);
  const ring = ward.polygons[0][0]; // Overpass wants "lat lon lat lon ..."; drop the closing duplicate point
  const poly = ring.slice(0, -1).map(([lon, lat]) => `${lat} ${lon}`).join(" ");
  const ways = Object.keys(HIGHWAY_CLASS).map((h) => `  way["highway"="${h}"](poly:"${poly}");`).join("\n");
  const data = await runQuery(`[out:json][timeout:300];\n(\n${ways}\n);\nout geom;`);
  const features = data.elements.map((el) => {
    const roadClass = HIGHWAY_CLASS[el.tags.highway];
    if (!roadClass) return null;
    const structure = el.tags.bridge === "yes" ? "bridge" : el.tags.tunnel === "yes" ? "tunnel" : "normal";
    return { type: "Feature", id: el.id, properties: { roadClass, structure, name: getStreetName(el.tags) }, geometry: { type: "LineString", coordinates: el.geometry.map((c) => [c.lon, c.lat]) } };
  }).filter(Boolean);
  fs.writeFileSync(`${OUT}roads.${slug}.geojson`, JSON.stringify({ type: "FeatureCollection", features }));
  return features.length;
}

if (arg !== "all") {
  const slug = Object.entries(WARD_EN).find(([s, ja]) => s === arg || ja === arg)?.[0];
  if (!slug) throw new Error(`unknown ward '${arg}'`);
  console.log(`fetching ${slug} ...`);
  console.log(`${slug}: ${await fetchWard(slug)} ways`);
} else {
  const failed = [];
  for (const slug of Object.keys(WARD_EN)) {
    const file = `${OUT}roads.${slug}.geojson`;
    if (fs.existsSync(file) && fs.statSync(file).size > 100) { console.log(`${slug}: already on disk, skipped`); continue; }
    const t0 = Date.now();
    try { console.log(`${slug}: ${await fetchWard(slug)} ways (${((Date.now() - t0) / 1000).toFixed(0)}s)`); }
    catch (e) { console.log(`${slug}: FAILED - ${e.message}`); failed.push(slug); }
    await new Promise((r) => setTimeout(r, 3000)); // one request at a time, with a pause - public Overpass mirrors throttle bursts
  }
  // merge whatever wards exist on disk, de-duplicating ways that straddle ward boundaries
  const seen = new Set(), merged = []; let raw = 0, wardsMerged = 0;
  for (const slug of Object.keys(WARD_EN)) {
    const file = `${OUT}roads.${slug}.geojson`;
    if (!fs.existsSync(file)) continue;
    const fc = JSON.parse(fs.readFileSync(file, "utf8"));
    if (fc.features.some((f) => f.id === undefined)) { console.log(`${slug}: per-ward file has no way ids (older export) - delete it and refetch to merge it`); failed.push(slug); continue; }
    wardsMerged++;
    for (const f of fc.features) { raw++; if (seen.has(f.id)) continue; seen.add(f.id); merged.push({ type: "Feature", properties: f.properties, geometry: f.geometry }); }
  }
  fs.writeFileSync(`${OUT}roads.all.geojson`, JSON.stringify({ type: "FeatureCollection", features: merged }));
  const byClass = {}, byStruct = {}; let named = 0;
  for (const f of merged) { byClass[f.properties.roadClass] = (byClass[f.properties.roadClass] || 0) + 1; byStruct[f.properties.structure] = (byStruct[f.properties.structure] || 0) + 1; if (f.properties.name) named++; }
  console.log({ wardsMerged, rawFeatures: raw, uniqueWays: merged.length, duplicatesRemoved: raw - merged.length, byClass, byStruct, named, namedPct: ((named / merged.length) * 100).toFixed(1) + "%", failedWards: failed, bytes: fs.statSync(`${OUT}roads.all.geojson`).size });
}
