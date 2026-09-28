// Builds packs/tokyo/station-network.json from MLIT's 国土数値情報 N02 (Railway) dataset - a real Kanto station-level
// network with station name, operator and line name, needed before fares/transfers/express can be modelled for Tokyo
// (docs/subway-builder-mechanics-study.md section 6, priority 1). Companion of tokyo-station-network.mjs (the
// Overpass/OSM attempt), which as of 2026-09-28 could not fetch any data: both public Overpass mirrors answered
// persistent 429 across five attempts over two days, even after a machine reboot. N02 is downloadable directly and
// carries station/operator/line names as attributes, so no name-matching to a separate station layer is needed.
//
// N02 ships two national GeoJSON layers (Station, RailroadSection) that are NOT already ordered/deduplicated the way
// OSM's route relations were:
//  - Station: one record per (station, line, operator) it serves - the SAME physical station appears once per line,
//    each with its own nearby-but-different coordinate (a large terminal's platforms can be 600-700 m apart). These
//    are clustered into one physical station per name+proximity (scripts/lib/rail-topology.mjs's clusterStations).
//  - RailroadSection: one record per inter-station segment, unordered. Segment endpoints snap EXACTLY to a Station
//    record's coordinates (verified 2026-09-28 on a 500-station sample), so segments are grouped per (line name,
//    operator) into a graph and walked into one ordered path with longestPath (drops short spurs/branches - a real
//    branch beyond the two farthest points of that named line is not represented; a loop line is approximated by its
//    longest chord, which fits this engine's point-to-point line model anyway - see rail-topology.mjs).
//
// Source: 国土数値情報(国土交通省) N02 鉄道データ, PDL1.0 (commercial and non-commercial use allowed; attribution
// required; a derived/filtered dataset like this one must say so - see packs/tokyo/ATTRIBUTION.md). Downloads the
// official zip (~17 MB) to data-raw/rail-network/raw/ and extracts it via PowerShell's Expand-Archive (this project
// targets Windows; see CLAUDE.md) unless already extracted.
//
// KNOWN, VERIFIED LIMITATION (2026-09-28): a line's Station-layer records are not guaranteed to cover every stop it
// makes - where several lines share a corridor (JR's Yamanote Line is the clear case: verified against real station
// order), some real stops only got a Station record filed under a DIFFERENT line/operator sharing that track, whose
// coordinate can sit 100-600 m from the segment endpoint that actually needs it (their physically separate parallel
// tracks). Exact-coordinate snapping (this script) then treats the segment as leaving the resolved network, and
// longestPath silently returns whatever shorter fragment stays connected - Yamanote came out as a 4-station stub
// instead of its real ~29. Overall the exact-match rate is a reasonable 85% of in-bbox segments, but do NOT trust a
// specific line's shape from this script without checking it: a naive distance-tolerance snap was NOT applied here
// because the gaps are large enough (hundreds of metres) to risk snapping onto the wrong nearby station in dense
// junction areas - it needs a smarter fix (e.g. reading the GML's richer schema for an explicit adjacent-station
// reference) before this is safe to load into the engine. packs/tokyo/station-network.json is therefore NOT
// generated/committed from this script yet; rerun it once that's fixed.
//
// usage: node scripts/tokyo-station-network-mlit.mjs   (from transitline/)
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { clusterStations, longestPath } from "./lib/rail-topology.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACK = path.join(ROOT, "packs/tokyo");
const RAW = path.join(ROOT, "data-raw/rail-network/raw");
const YEAR = "22"; // N02-22 = 令和4年度(2022), the latest release as of 2026-09-28
const ZIP_URL = `https://nlftp.mlit.go.jp/ksj/gml/data/N02/N02-${YEAR}/N02-${YEAR}_GML.zip`;
const SOURCE_NOTE = `国土交通省 国土数値情報 鉄道データ(N02-${YEAR}, PDL1.0) https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N02.html を加工して作成`;
const BBOX = [138.18086, 34.90298, 140.86554, 37.1533]; // [west, south, east, north] - same coverage as packs/tokyo/manifest.json
const CLUSTER_M = 700; // same-named station records within this are one physical station (see rail-topology.mjs)

async function ensureRawFetched() {
  const zipPath = path.join(RAW, `N02-${YEAR}_GML.zip`);
  const extractDir = path.join(RAW, `N02-${YEAR}`);
  const utf8Dir = path.join(extractDir, "UTF-8");
  if (fs.existsSync(path.join(utf8Dir, `N02-${YEAR}_Station.geojson`))) return utf8Dir;
  fs.mkdirSync(RAW, { recursive: true });
  if (!fs.existsSync(zipPath)) {
    console.log("downloading", ZIP_URL);
    const res = await fetch(ZIP_URL);
    if (!res.ok) throw new Error(`${ZIP_URL}: HTTP ${res.status}`);
    fs.writeFileSync(zipPath, Buffer.from(await res.arrayBuffer()));
  }
  console.log("extracting via PowerShell Expand-Archive...");
  execFileSync("powershell.exe", ["-NoProfile", "-Command", `Expand-Archive -Path '${zipPath}' -DestinationPath '${extractDir}' -Force`]);
  return utf8Dir;
}

const inBbox = ([lon, lat]) => lon >= BBOX[0] && lon <= BBOX[2] && lat >= BBOX[1] && lat <= BBOX[3];
const anyInBbox = (coords) => coords.some(inBbox);
const round5 = ([lon, lat]) => `${lon.toFixed(5)},${lat.toFixed(5)}`;
const haversine = ([lon1, lat1], [lon2, lat2]) => {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
};

// N02_001 railway-category code (KSJ spec) -> a coarse, informational "kind" (not read by the engine's routing).
const KIND_BY_CODE = { 11: "jr", 12: "rail", 13: "funicular", 14: "monorail", 15: "monorail", 16: "agt", 17: "trolleybus", 21: "tram", 22: "tram", 23: "monorail", 24: "agt", 25: "maglev" };

function build(utf8Dir) {
  const stationRaw = JSON.parse(fs.readFileSync(path.join(utf8Dir, `N02-${YEAR}_Station.geojson`), "utf8"));
  const sectionRaw = JSON.parse(fs.readFileSync(path.join(utf8Dir, `N02-${YEAR}_RailroadSection.geojson`), "utf8"));

  // One record per (station, line, operator); its geometry's points are used both to cluster it with the same
  // physical station's other records AND to snap RailroadSection segment endpoints onto that cluster.
  const stationRecords = [];
  for (const f of stationRaw.features) {
    const coords = f.geometry.coordinates;
    if (!anyInBbox(coords)) continue;
    const p = f.properties;
    if (!p.N02_005) continue;
    stationRecords.push({ name: p.N02_005, point: coords[0], coords, operator: p.N02_004, lineName: p.N02_003, code: p.N02_001 });
  }
  const clusters = clusterStations(stationRecords, CLUSTER_M);
  const stations = clusters.map((c, i) => ({
    id: `mlit-${i}`,
    name: c.name,
    name_en: null,
    operators: [...new Set(c.members.map((m) => m.operator))],
    location: c.location,
    lines: [], // filled once lines are built
  }));
  const coordToStation = new Map();
  clusters.forEach((c, i) => { for (const m of c.members) for (const coord of m.coords) coordToStation.set(round5(coord), i); });

  const groups = new Map(); // "line|operator" -> { name, operator, code, segments: [{from,to,lengthM}] }
  let droppedNoStation = 0;
  for (const f of sectionRaw.features) {
    const coords = f.geometry.coordinates;
    if (!anyInBbox(coords)) continue;
    const from = coordToStation.get(round5(coords[0]));
    const to = coordToStation.get(round5(coords[coords.length - 1]));
    if (from === undefined || to === undefined) { droppedNoStation++; continue; }
    const p = f.properties;
    const key = `${p.N02_003}|${p.N02_004}`;
    let lengthM = 0;
    for (let i = 0; i < coords.length - 1; i++) lengthM += haversine(coords[i], coords[i + 1]);
    const g = groups.get(key) ?? groups.set(key, { name: p.N02_003, operator: p.N02_004, code: p.N02_001, segments: [] }).get(key);
    g.segments.push({ from, to, lengthM });
  }

  const lines = [];
  for (const g of groups.values()) {
    const path_ = longestPath(g.segments);
    if (!path_) continue;
    const id = `mlit-line-${lines.length + 1}`;
    lines.push({ id, name: g.name, name_en: null, operator: g.operator, operators: [g.operator], network: null, kind: KIND_BY_CODE[g.code] ?? "rail", color: null, stationIds: path_.map((i) => stations[i].id) });
  }
  for (const l of lines) for (const sid of new Set(l.stationIds)) stations.find((s) => s.id === sid).lines.push(l.id);
  const used = stations.filter((s) => s.lines.length);

  console.log("station records", stationRecords.length, "-> physical stations", clusters.length, "used", used.length);
  console.log("line groups", groups.size, "-> lines with a resolvable path", lines.length);
  console.log("segments dropped (endpoint outside a resolved station)", droppedNoStation);
  console.log("through-running lines (several operators):", lines.filter((l) => l.operators.length > 1).length, "(N02 does not record through-running: always 1 here - see note)");

  const out = {
    formatVersion: 1,
    note: `Real Kanto stations and rail/subway/tram/monorail lines built from ${SOURCE_NOTE}. Same-named station records within ${CLUSTER_M} m are one physical station; each line's ordered station sequence is the longest path through its segment graph (drops short spurs/branches; a loop line is approximated by its longest chord). N02 records one operator per line, so through-running services are not merged across operators here (unlike tokyo-existing-network.json, which merges them from OSM route relations). DRAFT: see this file's header - lines on a shared corridor (e.g. Yamanote) can come out badly truncated; do not load into the engine before that is fixed.`,
    mlitDataset: `N02-${YEAR}`,
    stations: used,
    lines,
  };
  // Written as a .draft.json, not station-network.json: this script's header explains a verified, unresolved
  // accuracy gap (shared-corridor lines can be badly truncated). Rename it once that is fixed.
  const file = path.join(PACK, "station-network.draft.json");
  fs.writeFileSync(file, JSON.stringify(out));
  console.log("station-network.draft.json bytes", fs.statSync(file).size);
  console.log("WARNING: known accuracy gap on shared-corridor lines (see this script's header) - spot-check before using this file for anything.");
}

build(await ensureRawFetched());
console.log("DONE");
