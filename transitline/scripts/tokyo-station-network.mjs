// Builds packs/tokyo/station-network.json: the real Kanto rail network at STATION level (station name, operator, position,
// lines with their ordered stations). Companion of tokyo-existing-network.mjs, which collapses the same OSM route
// relations onto 242 municipality demand points; this one keeps the real stations so fares (per operator, by distance),
// transfers, through-running and express can be modelled (docs/subway-builder-mechanics-study.md section 6, priority 1).
//
// Step 1 (fetch, resumable): one Overpass query for every railway=station/halt/tram_stop in the pack bbox -> data-raw/
// rail-network/raw/stations.json (the route relations are already cached by tokyo-existing-network.mjs).
// Step 2 (build): each route relation's ordered stop nodes are matched to the nearest station within MATCH_M (preferring
// a station of the relation's own operator), consecutive duplicates collapse, direction/short-turn duplicates of one
// named line merge into the fullest variant (same rule as the existing script), and the result is written.
// OSM data (c) OpenStreetMap contributors, ODbL - see packs/tokyo/ATTRIBUTION.md.
//
// usage: node scripts/tokyo-station-network.mjs   (from transitline/)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACK = path.join(ROOT, "packs/tokyo");
const RAW = path.join(ROOT, "data-raw/rail-network/raw");
const BBOX = "34.90298,138.18086,37.1533,140.86554"; // packs/tokyo/manifest.json's bbox (south,west,north,east)
const MIRRORS = ["https://overpass.kumi.systems/api/interpreter", "https://overpass.monicz.dev/api/interpreter"];
const MATCH_M = 400; // a route's stop position lies within this of its station node
const CELL = 0.005; // grid cell in degrees (~500 m)

async function fetchOverpass(ql) {
  let lastErr = new Error("no mirror succeeded");
  for (const mirror of MIRRORS) {
    // A busy mirror answers 429 while its query slots are full (kumi.systems /api/status shows "Rate limit: 0" for us):
    // back off 15 s, 30 s, 45 s ... instead of hammering it.
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const r = await fetch(mirror, { method: "POST", body: "data=" + encodeURIComponent(ql) });
        if (!r.ok) { lastErr = new Error(`${mirror}: HTTP ${r.status}`); console.log("  ", lastErr.message, `(attempt ${attempt + 1}/5)`); await new Promise((s) => setTimeout(s, 15000 * (attempt + 1))); continue; }
        return await r.json();
      } catch (e) { lastErr = e; console.log("  ", mirror, e.message); await new Promise((s) => setTimeout(s, 15000 * (attempt + 1))); }
    }
  }
  throw lastErr;
}

// Public Overpass mirrors answered 429 to the single pack-wide query (2026-09-26, three runs), so the query is split by
// tag and limited to greater Tokyo (FETCH_BBOX) - stations outside it will not match route stops.
const FETCH_BBOX = BBOX; // pack-wide again (narrowing to greater Tokyo was the fallback if 429 persists)
async function ensureStationsFetched() {
  const f = path.join(RAW, "stations.json");
  if (fs.existsSync(f)) { console.log("stations cached"); return; }
  const elements = [];
  for (const tag of ["station", "halt", "tram_stop"]) {
    console.log(`fetching railway=${tag} from Overpass (bbox ${FETCH_BBOX})...`);
    const data = await fetchOverpass(`[out:json][timeout:120][bbox:${FETCH_BBOX}];nwr[railway=${tag}];out center tags;`);
    console.log("  elements:", data.elements.length);
    elements.push(...data.elements);
    await new Promise((s) => setTimeout(s, 5000));
  }
  fs.writeFileSync(f, JSON.stringify({ bbox: FETCH_BBOX, elements }));
}

const haversine = ([lon1, lat1], [lon2, lat2]) => {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
};
const opsOf = (s) => (s ?? "").split(";").map((x) => x.trim()).filter(Boolean);
const sharesOperator = (a, b) => a.some((x) => b.includes(x));

function build() {
  const raw = JSON.parse(fs.readFileSync(path.join(RAW, "stations.json"), "utf8"));
  const stations = [];
  const grid = new Map();
  for (const e of raw.elements) {
    const lon = e.lon ?? e.center?.lon, lat = e.lat ?? e.center?.lat, t = e.tags ?? {};
    if (lon === undefined || !t.name) continue;
    const st = { id: `osm-${e.type[0]}${e.id}`, name: t.name, name_en: t["name:en"] ?? null, operators: opsOf(t.operator), location: [Number(lon.toFixed(6)), Number(lat.toFixed(6))], lines: [] };
    stations.push(st);
    const key = `${Math.floor(lon / CELL)},${Math.floor(lat / CELL)}`;
    (grid.get(key) ?? grid.set(key, []).get(key)).push(st);
  }
  const near = (c) => {
    const out = [], cx = Math.floor(c[0] / CELL), cy = Math.floor(c[1] / CELL);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const s of grid.get(`${cx + dx},${cy + dy}`) ?? []) {
      const d = haversine(c, s.location);
      if (d <= MATCH_M) out.push({ s, d });
    }
    return out;
  };

  const KIND_ORDER = { subway: 0, train: 1, light_rail: 2, tram: 3 };
  const relations = [];
  let stops = 0, unmatched = 0;
  for (const kind of Object.keys(KIND_ORDER)) {
    const data = JSON.parse(fs.readFileSync(path.join(RAW, `${kind}.json`), "utf8"));
    const coord = new Map();
    for (const e of data.elements) if (e.type === "node") coord.set(e.id, [e.lon, e.lat]);
    for (const r of data.elements.filter((e) => e.type === "relation")) {
      const t = r.tags ?? {}, ops = opsOf(t.operator), path_ = [];
      for (const m of r.members) {
        if (m.type !== "node" || !/^(stop|stop_entry_only|stop_exit_only)/.test(m.role)) continue;
        const c = coord.get(m.ref);
        if (!c) continue;
        stops++;
        const cand = near(c);
        if (!cand.length) { unmatched++; continue; }
        const own = cand.filter((x) => sharesOperator(x.s.operators, ops));
        const pick = (own.length ? own : cand).reduce((a, b) => (b.d < a.d ? b : a)).s;
        if (path_[path_.length - 1] !== pick.id) path_.push(pick.id);
      }
      if (path_.length < 2) continue;
      let color = t.colour ?? null;
      if (color && !/^#?[0-9a-fA-F]{6}$/.test(color)) color = null;
      if (color && !color.startsWith("#")) color = "#" + color;
      const interval = /^\d+(\.\d+)?$/.test(t.interval ?? "") ? Number(t.interval) : null;
      relations.push({ osmRelationId: r.id, kind, name: t.name ?? t.ref ?? `relation ${r.id}`, name_en: t["name:en"] ?? null, operator: t.operator ?? null, operators: ops, network: t.network ?? null, color: color?.toLowerCase() ?? null, intervalMin: interval, stationIds: path_, set: [...new Set(path_)].sort() });
    }
  }
  console.log("stops", stops, "unmatched to a station (no station within", MATCH_M, "m)", unmatched);

  const groups = new Map();
  for (const r of relations) {
    const key = `${r.operator ?? ""}|${r.name}`;
    (groups.get(key) ?? groups.set(key, []).get(key)).push(r);
  }
  const kept = [];
  for (const list of groups.values()) {
    list.sort((a, b) => b.set.length - a.set.length);
    const accepted = [];
    for (const r of list) {
      if (accepted.some((s) => r.set.every((id) => s.includes(id)))) continue;
      accepted.push(r.set); kept.push(r);
    }
  }
  const bySet = new Map();
  for (const r of kept) {
    const k = r.set.join(",");
    const prev = bySet.get(k);
    if (!prev || (r.color && !prev.color) || r.stationIds.length > prev.stationIds.length) bySet.set(k, r);
  }
  const final = [...bySet.values()].sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.name.localeCompare(b.name, "ja"));

  const lines = final.map((r, i) => ({ id: `line-${i + 1}`, name: r.name, name_en: r.name_en, operator: r.operator, operators: r.operators, network: r.network, kind: r.kind, color: r.color, intervalMin: r.intervalMin, stationIds: r.stationIds, osmRelationId: r.osmRelationId }));
  const byId = new Map(stations.map((s) => [s.id, s]));
  for (const l of lines) for (const id of new Set(l.stationIds)) byId.get(id).lines.push(l.id);
  const used = stations.filter((s) => s.lines.length).sort((a, b) => a.id.localeCompare(b.id));

  const byKind = {};
  for (const l of lines) byKind[l.kind] = (byKind[l.kind] ?? 0) + 1;
  console.log("lines", lines.length, byKind, "stations used", used.length, "of", stations.length, "named station elements");
  console.log("through-running lines (several operators):", lines.filter((l) => l.operators.length > 1).length);
  const out = {
    formatVersion: 1,
    note: "Real Kanto stations and rail/subway/tram lines at station level, from the OSM snapshot below (route relations matched to the nearest station node within 400 m, preferring the relation's own operator). Direction and short-turn duplicates of one named line are merged into the fullest variant. intervalMin is OSM's plain `interval` tag when it is a single number (minutes), else null. Not yet loaded by the engine; existing-network.json (demand-point level) is still the start network. See packs/tokyo/README.md.",
    osmSnapshot: JSON.parse(fs.readFileSync(path.join(RAW, "train.json"), "utf8")).osm3s.timestamp_osm_base,
    stations: used,
    lines,
  };
  const file = path.join(PACK, "station-network.json");
  fs.writeFileSync(file, JSON.stringify(out));
  console.log("station-network.json bytes", fs.statSync(file).size);
}

await ensureStationsFetched();
build();
console.log("DONE");
