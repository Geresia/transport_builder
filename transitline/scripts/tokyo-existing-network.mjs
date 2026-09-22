// Builds packs/tokyo/existing-network.json: the real Kanto rail/subway/tram network as of an OSM
// snapshot, as a set of game lines the engine can pre-draw. One-off tool, no npm dependencies.
//
// Step 1 (fetch, ~10 min, resumable): pulls every OSM route=train/subway/light_rail/tram relation
// in the pack bbox from Overpass, caching each to data-raw/rail-network/raw/<kind>.json.
// Step 2 (build): collapses each relation's ordered real stops onto demand.json's 242
// municipality-level points (point-in-polygon against wards-reference.json / kanto-region.json —
// same points engine/src/state.mjs already uses as "stations"), merges direction/short-turn
// duplicates of the same named line, and writes existing-network.json.
//
// usage: node transitline/scripts/tokyo-existing-network.mjs   (run from the repo root)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACK = path.join(ROOT, "packs/tokyo");
const RAW = path.join(ROOT, "data-raw/rail-network/raw");
const BBOX = "34.90298,138.18086,37.1533,140.86554"; // south,west,north,east — packs/tokyo/manifest.json's bbox
const MIRRORS = ["https://overpass.kumi.systems/api/interpreter", "https://overpass.monicz.dev/api/interpreter"];
// Public Overpass mirrors are shared and load-varies a lot run to run (see packs/tokyo/README.md's
// Overpass notes): overpass-api.de/lz4/z all answer 406 for this project's queries; kumi.systems and
// monicz.dev both work but which one is fast/up flips, so both are tried, in rotation, per route kind.

// ---------------------------------------------------------------- step 1: fetch
async function fetchOverpass(ql) {
  let lastErr = new Error("no mirror succeeded");
  for (const mirror of MIRRORS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await fetch(mirror, { method: "POST", body: "data=" + encodeURIComponent(ql) });
        if (!r.ok) { lastErr = new Error(`${mirror}: HTTP ${r.status}`); await new Promise((s) => setTimeout(s, 10000)); continue; }
        return await r.json();
      } catch (e) { lastErr = e; await new Promise((s) => setTimeout(s, 8000)); }
    }
  }
  throw lastErr;
}

async function ensureRawFetched() {
  fs.mkdirSync(RAW, { recursive: true });
  for (const kind of ["train", "subway", "light_rail", "tram"]) {
    const f = path.join(RAW, `${kind}.json`);
    if (fs.existsSync(f)) { console.log(kind, "cached"); continue; }
    console.log("fetching", kind, "from Overpass (can take 30s-3min)...");
    const ql = `[out:json][timeout:150][bbox:${BBOX}];relation[route=${kind}];out body;>;out skel qt;`;
    const data = await fetchOverpass(ql);
    fs.writeFileSync(f, JSON.stringify(data));
    console.log(" ", kind, "elements:", data.elements.length);
  }
}

// ---------------------------------------------------------------- step 2: build
function bbox(polygons) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const poly of polygons) for (const ring of poly) for (const [x, y] of ring) {
    if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}
function inPolygons(lon, lat, polygons) {
  let c = false;
  for (const poly of polygons) for (const ring of poly) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if (yi > lat !== yj > lat && lon < xi + ((lat - yi) * (xj - xi)) / (yj - yi)) c = !c;
    }
  }
  return c;
}
const haversine = ([lon1, lat1], [lon2, lat2]) => {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
};

function build() {
  const demand = JSON.parse(fs.readFileSync(path.join(PACK, "demand.json"), "utf8"));
  const wardsRef = JSON.parse(fs.readFileSync(path.join(PACK, "wards-reference.json"), "utf8"));
  const kantoRegion = JSON.parse(fs.readFileSync(path.join(PACK, "kanto-region.json"), "utf8"));
  const pointByJis = new Map(demand.points.filter((p) => p.jisCode).map((p) => [p.jisCode, p.id]));
  const pointByCode = new Map(demand.points.filter((p) => p.code).map((p) => [p.code, p.id]));
  const pointLoc = new Map(demand.points.map((p) => [p.id, p.location]));

  const zones = [];
  for (const w of wardsRef.wards) { const id = pointByJis.get(w.code); if (id) zones.push({ pointId: id, polygons: w.polygons, bbox: bbox(w.polygons) }); }
  for (const m of kantoRegion.municipalities) { const id = pointByCode.get(m.code); if (id) zones.push({ pointId: id, polygons: m.polygons, bbox: bbox(m.polygons) }); }

  let fallbackCount = 0;
  function pointToDemandId(lon, lat) {
    for (const z of zones) {
      if (lon < z.bbox[0] || lon > z.bbox[2] || lat < z.bbox[1] || lat > z.bbox[3]) continue;
      if (inPolygons(lon, lat, z.polygons)) return z.pointId;
    }
    fallbackCount++;
    let best = null, bestD = Infinity;
    for (const [id, loc] of pointLoc) { const d = haversine([lon, lat], loc); if (d < bestD) { bestD = d; best = id; } }
    return bestD < 5000 ? best : null; // beyond 5km of the nearest point's own location: outside pack coverage
  }

  const KIND_ORDER = { subway: 0, train: 1, light_rail: 2, tram: 3 };
  const routeRelations = [];
  let totalStops = 0, unresolvedStops = 0;
  for (const kind of Object.keys(KIND_ORDER)) {
    const raw = JSON.parse(fs.readFileSync(path.join(RAW, `${kind}.json`), "utf8"));
    const nodeCoord = new Map();
    for (const e of raw.elements) if (e.type === "node") nodeCoord.set(e.id, [e.lon, e.lat]);
    for (const r of raw.elements.filter((e) => e.type === "relation")) {
      const path_ = [];
      for (const m of r.members) {
        if (m.type !== "node") continue;
        const c = nodeCoord.get(m.ref); if (!c) continue;
        totalStops++;
        const id = pointToDemandId(c[0], c[1]);
        if (!id) { unresolvedStops++; continue; }
        if (path_[path_.length - 1] !== id) path_.push(id);
      }
      if (path_.length < 2) continue;
      const t = r.tags ?? {};
      let color = t.colour ?? null;
      if (color && !/^#?[0-9a-fA-F]{6}$/.test(color)) color = null;
      if (color && !color.startsWith("#")) color = "#" + color;
      routeRelations.push({
        osmId: r.id, kind, name: t.name ?? t.ref ?? `relation ${r.id}`, name_en: t["name:en"] ?? null,
        operator: t.operator ?? null, network: t.network ?? null, color: color ? color.toLowerCase() : null,
        path: path_, set: [...new Set(path_)].sort(),
      });
    }
  }
  console.log("stops seen", totalStops, "unresolved (outside pack coverage)", unresolvedStops, `(${fallbackCount} resolved via nearest-point fallback)`);

  // Dedupe: group by operator+name; within a group a path whose station SET is a subset of an
  // already-kept path's set is dropped (collapses up/down-direction pairs and short-turn variants
  // into their fullest version). A final global pass then collapses identical sets that survived
  // under two different group keys (an OSM naming quirk between the two directions).
  const groups = new Map();
  for (const r of routeRelations) {
    const key = `${r.operator ?? ""}|${r.name}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const kept = [];
  for (const list of groups.values()) {
    list.sort((a, b) => b.set.length - a.set.length);
    const acceptedSets = [];
    for (const r of list) {
      if (acceptedSets.some((s) => r.set.every((id) => s.includes(id)))) continue;
      acceptedSets.push(r.set); kept.push(r);
    }
  }
  const bySet = new Map();
  for (const r of kept) {
    const k = r.set.join(",");
    const prev = bySet.get(k);
    if (!prev || (r.color && !prev.color) || r.path.length > prev.path.length) bySet.set(k, r);
  }
  const final = [...bySet.values()].sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.name.localeCompare(b.name, "ja"));

  const touched = new Set(final.flatMap((r) => r.path));
  const byKind = {}; for (const r of final) byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
  console.log("lines kept", final.length, "from", routeRelations.length, "usable relations,", groups.size, "name groups. by kind:", byKind);
  console.log("demand points touched by >= 1 line:", touched.size, "/", demand.points.length);

  const out = {
    formatVersion: 1,
    note: "Real Kanto rail/subway/tram lines as of the OSM snapshot below, collapsed onto demand.json's " +
      "242 municipality-level points (one line per OSM route relation; direction and short-turn duplicates " +
      "of the same named line are merged into the fullest variant). Loaded by engine/src/main.mjs as the " +
      "starting network unless the page is opened with ?network=scratch. See packs/tokyo/README.md.",
    osmSnapshot: JSON.parse(fs.readFileSync(path.join(RAW, "train.json"), "utf8")).osm3s.timestamp_osm_base,
    lines: final.map((r) => ({
      name: r.name, name_en: r.name_en, operator: r.operator, network: r.network,
      kind: r.kind, color: r.color, stationIds: r.path, osmRelationId: r.osmId,
    })),
  };
  fs.writeFileSync(path.join(PACK, "existing-network.json"), JSON.stringify(out));
  console.log("existing-network.json bytes", fs.statSync(path.join(PACK, "existing-network.json")).size);
}

await ensureRawFetched();
build();
console.log("DONE");
