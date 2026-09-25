// Hotels and other lodging inside the tokyo pack's municipality layers -> packs/tokyo/hotels.json.
// Source: OpenStreetMap via Overpass (ODbL): tourism=hotel|motel|guest_house|hostel|apartment|chalet, plus building=hotel.
// OSM is not a complete register (unmapped or unnamed places are missing) - this is "what OSM has", not every licensed inn.
// Size: OSM rarely tags room counts, so `rooms` is (1) the tagged `rooms` when present, else (2) MODELED from the mapped building
// footprint: area x levels / GFA_PER_ROOM (levels default LEVELS_DEFAULT when untagged), else (3) a flat DEFAULT_ROOMS for a bare point.
// `sizeBasis` says which one, so nothing modeled passes as measured.
// Fetch: bbox tiles, one request at a time (the mirrors accept ~1 concurrent request), retry with backoff, tile split on repeated failure,
// per-tile cache in data-raw/hotels/ so an interrupted run resumes. Usage: node scripts/tokyo-hotels.mjs   (needs network)
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { readPackJson } from "./pack-json.mjs";
import { writeChecked } from "./safe-write.mjs";
const T = fileURLToPath(new URL("../packs/tokyo/", import.meta.url));
const RAW = fileURLToPath(new URL("../data-raw/hotels/", import.meta.url));
fs.mkdirSync(RAW, { recursive: true });

// Mirrors drift in and out (2026-09-25: lz4.overpass-api.de answered, monicz/private.coffee hung, z./overpass-api.de gave 504) - order = try order.
const MIRRORS = ["https://lz4.overpass-api.de/api/interpreter", "https://z.overpass-api.de/api/interpreter", "https://overpass-api.de/api/interpreter", "https://overpass.monicz.dev/api/interpreter"];
const TILE = 0.2; // degrees
const GFA_PER_ROOM = 35; // m2 of gross floor area per room: order-of-magnitude for a Japanese city hotel, modeled
const LEVELS_DEFAULT = 3;
const DEFAULT_ROOMS = 20;
const MAX_ROOMS = 2000; // for a tagged `rooms` value
const MAX_MODELED_ROOMS = 1000; // for a footprint-derived value: mixed-use towers (offices + a hotel) would otherwise swallow the whole floor area; Tokyo's biggest hotels are ~1,500 rooms
const KINDS = new Set(["hotel", "motel", "guest_house", "hostel", "apartment", "chalet"]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- zones: the municipality polygons the viewer draws (kanto-region.json + the 23 wards) ----
const zones = [];
const addZone = (code, polygons) => zones.push({ code, polys: polygons.map((rings) => {
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  for (const [x, y] of rings[0]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return { bbox: [x0, y0, x1, y1], rings };
}) });
for (const m of readPackJson(T + "kanto-region.json").municipalities) addZone(String(m.code), m.polygons);
for (const w of readPackJson(T + "wards-reference.json").wards) addZone(String(w.code).slice(0, 5), w.polygons);
const inRing = (x, y, ring) => {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < xi + ((y - yi) * (xj - xi)) / (yj - yi)) c = !c;
  }
  return c;
};
const zoneOf = (x, y) => {
  for (const z of zones) for (const p of z.polys) {
    const [x0, y0, x1, y1] = p.bbox;
    if (x < x0 || x > x1 || y < y0 || y > y1) continue;
    if (inRing(x, y, p.rings[0]) && !p.rings.slice(1).some((r) => inRing(x, y, r))) return z.code;
  }
  return null;
};

// ---- fetch ----
async function overpass(bbox) {
  const [w, s, e, n] = bbox, b = `${s},${w},${n},${e}`;
  const q = `[out:json][timeout:60];(nwr["tourism"~"^(${[...KINDS].join("|")})$"](${b});nwr["building"="hotel"](${b}););out geom tags;`;
  let lastErr;
  for (let attempt = 0; attempt < 6; attempt++) {
    const url = MIRRORS[attempt % MIRRORS.length];
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": "transitline-hotels/0.1 (research)", accept: "application/json" }, body: "data=" + encodeURIComponent(q), signal: AbortSignal.timeout(80000) });
      if (r.ok) { const j = await r.json(); if (j.remark && /error|timed out/i.test(j.remark)) throw new Error(j.remark); return j.elements; }
      lastErr = `HTTP ${r.status} ${url}`;
    } catch (err) { lastErr = `${err.message} ${url}`; }
    console.log(`  attempt ${attempt + 1} failed: ${lastErr}`);
    await sleep(2000 * (attempt + 1));
  }
  throw new Error(lastErr);
}
async function tileElements(bbox, depth = 0) { // cached per bbox; splits in four when a tile keeps failing
  const key = RAW + `tile_${bbox.map((v) => v.toFixed(3)).join("_")}.json`;
  if (fs.existsSync(key)) return JSON.parse(fs.readFileSync(key, "utf8"));
  let els;
  try { els = await overpass(bbox); }
  catch (err) {
    if (depth >= 2) throw new Error(`tile ${bbox} failed after splitting: ${err.message}`);
    const [w, s, e, n] = bbox, mx = (w + e) / 2, my = (s + n) / 2;
    console.log(`  split ${bbox.map((v) => v.toFixed(2))} (${err.message})`);
    els = [];
    for (const sub of [[w, s, mx, my], [mx, s, e, my], [w, my, mx, n], [mx, my, e, n]]) els.push(...(await tileElements(sub, depth + 1)));
    fs.writeFileSync(key, JSON.stringify(els));
    return els;
  }
  fs.writeFileSync(key, JSON.stringify(els));
  await sleep(1500);
  return els;
}

// ---- geometry ----
const ringArea = (g) => { // closed lat/lon ring -> m2 (equirectangular around its own latitude)
  if (g.length < 4) return 0;
  const k = Math.cos((g[0].lat * Math.PI) / 180) * 111320, kl = 111320;
  let a = 0;
  for (let i = 0, j = g.length - 1; i < g.length; j = i++) a += (g[j].lon * k) * (g[i].lat * kl) - (g[i].lon * k) * (g[j].lat * kl);
  return Math.abs(a) / 2;
};
const closed = (g) => g.length > 3 && g[0].lat === g[g.length - 1].lat && g[0].lon === g[g.length - 1].lon;
function place(el) { // -> { lon, lat, areaM2 }
  if (el.type === "node") return { lon: el.lon, lat: el.lat, areaM2: 0 };
  if (el.type === "way" && el.geometry) {
    const g = el.geometry;
    return { lon: g.reduce((s, p) => s + p.lon, 0) / g.length, lat: g.reduce((s, p) => s + p.lat, 0) / g.length, areaM2: closed(g) ? ringArea(g) : 0 };
  }
  if (el.type === "relation" && el.bounds) {
    const outers = (el.members ?? []).filter((m) => m.role === "outer" && m.geometry && closed(m.geometry));
    return { lon: (el.bounds.minlon + el.bounds.maxlon) / 2, lat: (el.bounds.minlat + el.bounds.maxlat) / 2, areaM2: outers.reduce((s, m) => s + ringArea(m.geometry), 0) };
  }
  return null;
}
const num = (v) => { const n = parseInt(String(v ?? "").replace(/[^\d]/g, ""), 10); return Number.isFinite(n) && n > 0 ? n : null; };

// ---- run ----
const [W, S, E, N] = readPackJson(T + "manifest.json").bbox;
const tiles = [];
for (let x = W; x < E; x += TILE) for (let y = S; y < N; y += TILE) tiles.push([x, y, Math.min(x + TILE, E), Math.min(y + TILE, N)]);
// skip tiles that touch no municipality polygon (sea, far mountains)
const touches = (t) => zones.some((z) => z.polys.some((p) => !(p.bbox[2] < t[0] || p.bbox[0] > t[2] || p.bbox[3] < t[1] || p.bbox[1] > t[3])));
const wanted = tiles.filter(touches);
console.log(`${wanted.length} of ${tiles.length} tiles overlap the municipality layers`);
const raw = new Map(); // "type/id" -> element (a way can appear in two tiles)
let done = 0;
for (const t of wanted) {
  for (const el of await tileElements(t)) raw.set(`${el.type}/${el.id}`, el);
  if (++done % 5 === 0 || done === wanted.length) console.log(`  tile ${done}/${wanted.length}, ${raw.size} elements`);
}

const stat = { elements: raw.size, outsideZones: 0, noPlace: 0, duplicates: 0 };
const list = [];
for (const el of raw.values()) {
  const tags = el.tags ?? {};
  const kind = KINDS.has(tags.tourism) ? tags.tourism : tags.building === "hotel" ? "hotel" : null;
  const p = kind && place(el);
  if (!p) { stat.noPlace++; continue; }
  const muni = zoneOf(p.lon, p.lat);
  if (!muni) { stat.outsideZones++; continue; }
  const rooms = num(tags.rooms), levels = num(tags["building:levels"] ?? tags.levels);
  let size, basis;
  if (rooms) { size = rooms; basis = "rooms"; }
  else if (p.areaM2 > 0) { size = (p.areaM2 * (levels ?? LEVELS_DEFAULT)) / GFA_PER_ROOM; basis = levels ? "footprint" : "footprint-assumed-levels"; }
  else { size = DEFAULT_ROOMS; basis = "default"; }
  list.push({
    id: `${el.type[0]}${el.id}`, name: tags.name ?? tags["name:ja"] ?? tags["name:en"] ?? tags.brand ?? null, kind,
    location: [Math.round(p.lon * 1e6) / 1e6, Math.round(p.lat * 1e6) / 1e6], muni,
    rooms: Math.max(1, Math.min(basis === "rooms" ? MAX_ROOMS : MAX_MODELED_ROOMS, Math.round(size))), sizeBasis: basis,
    ...(p.areaM2 > 0 ? { areaM2: Math.round(p.areaM2) } : {}), ...(levels ? { levels } : {}),
  });
}
// the same hotel is often mapped twice (a node on the building way): same name within ~100 m -> keep the better-sized one
const RANK = { rooms: 3, footprint: 2, "footprint-assumed-levels": 1, default: 0 };
const grid = new Map(), keep = [];
const norm = (s) => s.toLowerCase().replace(/[\s　・･\-－]/g, "");
list.sort((a, b) => RANK[b.sizeBasis] - RANK[a.sizeBasis] || b.rooms - a.rooms);
for (const h of list) {
  if (h.name) {
    const cx = Math.floor(h.location[0] * 1000), cy = Math.floor(h.location[1] * 1000), nm = norm(h.name);
    let dup = false;
    for (let dx = -1; dx <= 1 && !dup; dx++) for (let dy = -1; dy <= 1 && !dup; dy++)
      for (const o of grid.get(`${cx + dx}|${cy + dy}`) ?? []) {
        if (o.nm === nm && Math.hypot((o.h.location[0] - h.location[0]) * 91000, (o.h.location[1] - h.location[1]) * 111000) < 100) { dup = true; break; }
      }
    if (dup) { stat.duplicates++; continue; }
    const k = `${cx}|${cy}`;
    (grid.get(k) ?? grid.set(k, []).get(k)).push({ nm, h });
  }
  keep.push(h);
}
keep.sort((a, b) => (a.muni < b.muni ? -1 : a.muni > b.muni ? 1 : b.rooms - a.rooms));

const count = (f) => keep.reduce((m, h) => ((m[f(h)] = (m[f(h)] ?? 0) + 1), m), {});
const out = {
  formatVersion: 1,
  source: "© OpenStreetMap contributors (ODbL-1.0), via Overpass: tourism=hotel|motel|guest_house|hostel|apartment|chalet and building=hotel, inside the municipality polygons of kanto-region.json + wards-reference.json",
  fetched: new Date().toISOString().slice(0, 10),
  note: `What OSM has, not a complete register. rooms: sizeBasis "rooms" = tagged in OSM; "footprint" = MODELED area x building:levels / ${GFA_PER_ROOM} m2 per room; "footprint-assumed-levels" = same with levels assumed ${LEVELS_DEFAULT}; "default" = a bare point, flat ${DEFAULT_ROOMS}. Capped at ${MAX_ROOMS} (tagged) / ${MAX_MODELED_ROOMS} (modeled). Same-name duplicates within 100 m merged. muni = 5-digit municipality code (wards: 131xx).`,
  stats: { hotels: keep.length, totalRooms: keep.reduce((s, h) => s + h.rooms, 0), byKind: count((h) => h.kind), bySizeBasis: count((h) => h.sizeBasis), byPrefecture: count((h) => h.muni.slice(0, 2)), ...stat },
  hotels: keep,
};
writeChecked(T + "hotels.json", JSON.stringify(out), { count: (j) => j.hotels.length, label: "hotels" });
console.log(JSON.stringify(out.stats), (fs.statSync(T + "hotels.json").size / 1024 / 1024).toFixed(1) + " MB");
