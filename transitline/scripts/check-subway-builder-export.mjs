// Checks transitline/subway-builder-export/*.json against the game's own type shapes
// (compatibility-test-mod's src/types/{game-state,index}.d.ts: DemandDataFile, BuildingsIndex - MIT-licensed
// type definitions, used here to check conformance, not copied as code) plus cross-file referential integrity.
// Usage: node scripts/check-subway-builder-export.mjs
import fs from "node:fs";
import { fileURLToPath } from "node:url";
const DIR = fileURLToPath(new URL("../subway-builder-export/", import.meta.url));
let errors = 0;
const fail = (m) => { console.error("FAIL", m); errors++; };
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const isCoord = (v) => Array.isArray(v) && v.length === 2 && isNum(v[0]) && isNum(v[1]);

// --- demand_data*.json (the 242-municipality file and/or the chome-level demand_data.chome.json) ---
// Uses Maps throughout (not Array.find) so a ~300k-pop chome-level file validates in seconds, not hours.
const T_PACK = fileURLToPath(new URL("../packs/tokyo/", import.meta.url));
function checkDemandFile(filePath, label) {
  const d = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!Array.isArray(d.points)) { fail(`${label}: points is not an array`); return; }
  if (!Array.isArray(d.pops)) { fail(`${label}: pops is not an array`); return; }
  const pointById = new Map();
  for (const [i, p] of d.points.entries()) {
    if (typeof p.id !== "string" || !p.id) fail(`${label}: points[${i}].id missing`);
    if (pointById.has(p.id)) fail(`${label}: points[${i}].id duplicated: ${p.id}`);
    pointById.set(p.id, p);
    if (!isCoord(p.location)) fail(`${label}: points[${i}].location must be [lon, lat]`);
    if (!isNum(p.jobs) || p.jobs < 0) fail(`${label}: points[${i}].jobs must be a non-negative number`);
    if (!isNum(p.residents) || p.residents < 0) fail(`${label}: points[${i}].residents must be a non-negative number`);
    if (!Array.isArray(p.popIds)) fail(`${label}: points[${i}].popIds must be an array`);
  }
  const popById = new Map();
  let sizeSum = 0;
  for (const [i, pop] of d.pops.entries()) {
    if (typeof pop.id !== "string" || !pop.id) fail(`${label}: pops[${i}].id missing`);
    if (popById.has(pop.id)) fail(`${label}: pops[${i}].id duplicated: ${pop.id}`);
    popById.set(pop.id, pop);
    if (!isNum(pop.size) || pop.size <= 0) fail(`${label}: pops[${i}].size must be a positive number`);
    if (!pointById.has(pop.residenceId)) fail(`${label}: pops[${i}].residenceId '${pop.residenceId}' is not a known point`);
    if (!pointById.has(pop.jobId)) fail(`${label}: pops[${i}].jobId '${pop.jobId}' is not a known point`);
    if (!isNum(pop.drivingSeconds) || pop.drivingSeconds < 0) fail(`${label}: pops[${i}].drivingSeconds must be a non-negative number`);
    if (!isNum(pop.drivingDistance) || pop.drivingDistance < 0) fail(`${label}: pops[${i}].drivingDistance must be a non-negative number`);
    // homeDepartureTime/workDepartureTime are NOT part of this on-disk shape (confirmed against the real
    // game's own installed Tokyo data, 2026-09-23: 0/82662 pops have them) - only checked if present, since
    // some other exporter might legitimately add extra fields the game simply ignores.
    if (pop.homeDepartureTime !== undefined && !isNum(pop.homeDepartureTime)) fail(`${label}: pops[${i}].homeDepartureTime must be a number if present`);
    if (pop.workDepartureTime !== undefined && !isNum(pop.workDepartureTime)) fail(`${label}: pops[${i}].workDepartureTime must be a number if present`);
    if (pop.drivingPath !== undefined && !(Array.isArray(pop.drivingPath) && pop.drivingPath.every(isCoord))) fail(`${label}: pops[${i}].drivingPath must be Coordinate[] if present`);
    sizeSum += pop.size;
  }
  // referential integrity the other direction: every point's popIds reference pops that touch it, and every
  // pop is listed by the point(s) it touches (so the game's per-point pop lookup is complete).
  let listed = 0;
  for (const [i, p] of d.points.entries()) {
    for (const pid of p.popIds) {
      const pop = popById.get(pid);
      if (!pop) { fail(`${label}: points[${i}].popIds references unknown pop '${pid}'`); continue; }
      if (pop.residenceId !== p.id && pop.jobId !== p.id) fail(`${label}: points[${i}].popIds lists '${pid}' but that pop does not touch this point`);
      listed++;
    }
  }
  const expectedListings = d.pops.reduce((s, pop) => s + (pop.residenceId === pop.jobId ? 1 : 2), 0);
  if (listed !== expectedListings) fail(`${label}: points list ${listed} pop references, expected ${expectedListings} (each pop belongs on its residence point and, if different, its job point)`);
  console.log(`${label}: ${d.points.length} points, ${d.pops.length} pops, total pop size ${sizeSum}`);
  return d;
}

let demandFiles = fs.readdirSync(DIR).filter((f) => /^demand_data.*.json$/.test(f));
if (demandFiles.length === 0) console.log("demand_data*.json: none present, skipped");
const demandByFile = {};
for (const f of demandFiles) demandByFile[f] = checkDemandFile(DIR + f, f);

// The chome-level file is "game-native": it must follow the four internal rules measured on the real game's own
// installed Tokyo file (2026-09-24, read locally for comparison only): (1) every pop is one fixed size (200),
// (2) each point's residents/jobs equal the sum of pop sizes naming it as residence/job, (3) no pop has
// residenceId === jobId, (4) no point has both residents and jobs at 0. On top of that its pops must add back up
// (per municipality pair) to the real census O/D in od.json, to within one 200-person unit: the exporter spreads
// flows by systematic sampling, whose running error stays under one unit. Municipality = first 5 digits of a
// chome code; a single-point Tama-area municipality's point id IS its 5-digit code, and its within-municipality
// flow is dropped by design (residence === job would be a same-point pop).
const chomeName = "demand_data.chome.json";
if (demandByFile[chomeName]) {
  const d = demandByFile[chomeName], UNIT = 200;
  let bad = 0;
  const complain = (m) => { if (bad++ < 8) fail(m); };
  const resSum = new Map(), jobSum = new Map();
  for (const pop of d.pops) {
    if (pop.size !== UNIT) complain(`${chomeName}: pop ${pop.id} has size ${pop.size}, game-native pops are exactly ${UNIT}`);
    if (pop.residenceId === pop.jobId) complain(`${chomeName}: pop ${pop.id} has residenceId === jobId (${pop.residenceId}); the real game has none`);
    resSum.set(pop.residenceId, (resSum.get(pop.residenceId) || 0) + pop.size);
    jobSum.set(pop.jobId, (jobSum.get(pop.jobId) || 0) + pop.size);
  }
  for (const pt of d.points) {
    if (pt.residents !== (resSum.get(pt.id) || 0)) complain(`${chomeName}: point ${pt.id} residents ${pt.residents} != sum of its pops as residence ${resSum.get(pt.id) || 0}`);
    if (pt.jobs !== (jobSum.get(pt.id) || 0)) complain(`${chomeName}: point ${pt.id} jobs ${pt.jobs} != sum of its pops as job ${jobSum.get(pt.id) || 0}`);
    if (pt.residents === 0 && pt.jobs === 0) complain(`${chomeName}: point ${pt.id} has neither residents nor jobs`);
  }
  if (bad > 8) fail(`${chomeName}: ... ${bad - 8} more game-rule violations`);

  if (fs.existsSync(T_PACK + "od.json")) {
    const od = JSON.parse(fs.readFileSync(T_PACK + "od.json", "utf8")).origins;
    const singlePoint = new Set(d.points.filter((pt) => pt.id.length === 5).map((pt) => pt.id));
    const want = new Map(), got = new Map();
    let wantTotal = 0, gotTotal = 0;
    for (const [o, r] of Object.entries(od)) {
      const add = (dm, n) => { if (!(n > 0)) return; if (o === dm && singlePoint.has(o)) return; want.set(o + ">" + dm, n); wantTotal += n; };
      add(o, r.self); for (const [dm, n] of Object.entries(r.dest)) add(dm, n);
    }
    for (const pop of d.pops) { const k = pop.residenceId.slice(0, 5) + ">" + pop.jobId.slice(0, 5); got.set(k, (got.get(k) || 0) + pop.size); gotTotal += pop.size; }
    let off = 0, worst = 0;
    for (const [k, n] of want) { const e = Math.abs((got.get(k) || 0) - n); worst = Math.max(worst, e); if (e > UNIT && off++ < 5) fail(`${chomeName}: municipality flow ${k} sums to ${got.get(k) ?? 0}, od.json says ${n} (more than one ${UNIT}-person unit apart)`); }
    for (const k of got.keys()) if (!want.has(k) && off++ < 5) fail(`${chomeName}: has a flow ${k} that od.json does not`);
    if (off > 5) fail(`${chomeName}: ... ${off - 5} more municipality-flow mismatches`);
    if (Math.abs(gotTotal - wantTotal) > UNIT) fail(`${chomeName}: total ${gotTotal} vs od.json placeable total ${wantTotal} differ by more than one ${UNIT}-person unit`);
    console.log(`${chomeName}: game rules hold; ${want.size} municipality flows re-aggregate to od.json within ${UNIT} people (worst ${worst}), total ${gotTotal} vs ${wantTotal}`);
  }
}

// --- buildings_index.*.json (may be several, one per exported ward) ---
// V8 can't materialize a JS string over ~536 MB (ERR_STRING_TOO_LONG), so a whole-file readFileSync+JSON.parse
// stops working once the export covers many wards. Above STREAM_THRESHOLD we validate by streaming instead -
// checkBuildingsIndexStreaming() below - which never holds the file's text in memory all at once.
const STREAM_THRESHOLD = 200 * 1024 * 1024;

function checkBuildingsIndexSmall(text, label) {
  const b = JSON.parse(text);
  for (const k of ["cellSize", "minLon", "maxLon", "minLat", "maxLat", "cols", "rows"]) if (!isNum(b[k])) fail(`${label}: ${k} must be a number`);
  if (!Array.isArray(b.cells)) fail(`${label}: cells must be an array`);
  else if (b.cells.length !== b.cols * b.rows) fail(`${label}: cells.length ${b.cells.length} != cols*rows ${b.cols * b.rows}`);
  if (!Array.isArray(b.buildings)) { fail(`${label}: buildings must be an array`); return; }
  const ids = new Set();
  for (const [i, bd] of b.buildings.entries()) {
    if (typeof bd.id !== "string" || !bd.id) fail(`${label}: buildings[${i}].id missing`);
    if (ids.has(bd.id)) fail(`${label}: buildings[${i}].id duplicated: ${bd.id}`);
    ids.add(bd.id);
    checkOneBuilding(bd, `${label}: buildings[${i}]`);
  }
  if (Array.isArray(b.cells)) {
    for (const [ci, cell] of b.cells.entries()) {
      if (!Array.isArray(cell)) { fail(`${label}: cells[${ci}] must be an array`); continue; }
      for (const idx of cell) if (!(idx >= 0 && idx < b.buildings.length)) fail(`${label}: cells[${ci}] references out-of-range building index ${idx}`);
    }
  }
  if (b.buildingCount !== b.buildings.length) fail(`${label}: buildingCount ${b.buildingCount} != buildings.length ${b.buildings.length}`);
  console.log(`${label}: ${b.buildingCount} buildings, ${b.cols}x${b.rows} grid, ${b.nonEmptyCells} non-empty cells`);
}

// Shared per-building checks (bounds sane, polygon a closed ring, foundationDepth non-negative).
function checkOneBuilding(bd, prefix) {
  const bb = bd.bounds;
  if (!bb || !isNum(bb.minX) || !isNum(bb.minY) || !isNum(bb.maxX) || !isNum(bb.maxY)) fail(`${prefix}.bounds incomplete`);
  else if (bb.minX > bb.maxX || bb.minY > bb.maxY) fail(`${prefix}.bounds min > max`);
  if (!Array.isArray(bd.polygon) || bd.polygon.length < 4 || !bd.polygon.every(isCoord)) fail(`${prefix}.polygon must be a closed ring of >=4 coordinates`);
  else {
    const first = bd.polygon[0], last = bd.polygon[bd.polygon.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) fail(`${prefix}.polygon ring is not closed`);
  }
  if (!isNum(bd.foundationDepth) || bd.foundationDepth < 0) fail(`${prefix}.foundationDepth must be a non-negative number`);
}

// Streaming validator for files too large to load as one string. Exploits that this repo's own writer
// (export-subway-builder-buildings.mjs) never puts a brace/bracket/comma inside a string value anywhere in
// this file (ids are "bldg-<n>", every other field is numeric) - so brace/bracket depth alone, with no
// string-literal awareness, safely finds each top-level element. This is a targeted parser for OUR OWN known
// output shape, not a general-purpose JSON streamer.
async function checkBuildingsIndexStreaming(filePath, label) {
  const BUILDINGS_MARKER = ',"buildings":[';
  const size = fs.statSync(filePath).size;

  // 1) header (everything up to the buildings array) - bounded by the `cells` grid's size, expected to stay
  //    well under the string-length ceiling even for a full 23-ward export.
  let header = "", headerDone = false, bytesRead = 0;
  const rl1 = fs.createReadStream(filePath, { encoding: "utf8", highWaterMark: 4 * 1024 * 1024 });
  let markerIdx = -1;
  for await (const chunk of rl1) {
    header += chunk;
    bytesRead += chunk.length;
    markerIdx = header.indexOf(BUILDINGS_MARKER);
    if (markerIdx >= 0) { headerDone = true; rl1.destroy(); break; }
    if (header.length > 400 * 1024 * 1024) throw new Error(`${label}: header (cells grid) exceeds 400MB - streaming assumption broken`);
  }
  if (!headerDone) return fail(`${label}: could not find the buildings array marker`);
  let headerJson;
  try { headerJson = JSON.parse(header.slice(0, markerIdx) + "}"); }
  catch (e) { return fail(`${label}: header (up to "cells") is not valid JSON: ${e.message}`); }
  for (const k of ["cellSize", "minLon", "maxLon", "minLat", "maxLat", "cols", "rows"]) if (!isNum(headerJson[k])) fail(`${label}: ${k} must be a number`);
  if (!Array.isArray(headerJson.cells)) fail(`${label}: cells must be an array`);
  else if (headerJson.cells.length !== headerJson.cols * headerJson.rows) fail(`${label}: cells.length ${headerJson.cells.length} != cols*rows ${headerJson.cols * headerJson.rows}`);

  // 2) tail (everything after the buildings array closes) - also small and bounded, read directly.
  const TAIL_PROBE = 4096;
  const fd = fs.openSync(filePath, "r");
  const tailBuf = Buffer.alloc(Math.min(TAIL_PROBE, size));
  fs.readSync(fd, tailBuf, 0, tailBuf.length, size - tailBuf.length);
  fs.closeSync(fd);
  const tailText = tailBuf.toString("utf8");
  const tailMatch = tailText.match(/\],"buildingCount":(\d+),"nonEmptyCells":(\d+),"maxFoundationDepth":([\d.]+)\}\s*$/);
  if (!tailMatch) return fail(`${label}: could not find/parse the trailing buildingCount/nonEmptyCells/maxFoundationDepth fields`);
  const declaredCount = Number(tailMatch[1]);

  // 3) stream the buildings array itself, one object at a time, using brace/bracket depth to find each
  //    element's boundaries (see the string-safety note above).
  let n = 0, badIds = 0, errBudget = 20;
  const reportErr = (msg) => { if (errBudget-- > 0) fail(msg); else if (errBudget === 0) fail(`${label}: further building errors suppressed`); };
  let buf = header.slice(markerIdx + BUILDINGS_MARKER.length); // leftover after the marker, already read
  let depth = 0, objStart = -1, scanned = 0;
  const consume = (text) => {
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c === 123 /* { */ || c === 91 /* [ */) { if (depth === 0 && c === 123) objStart = scanned + i; depth++; }
      else if (c === 125 /* } */ || c === 93 /* ] */) {
        depth--;
        if (depth === 0 && c === 125 && objStart >= 0) {
          const objText = (scanned + i + 1 <= scanned + text.length) ? fullSlice(objStart, scanned + i + 1) : null;
          handleBuilding(objText);
          objStart = -1;
        } else if (depth < 0) { /* the closing `]` of the buildings array itself */ return true; }
      }
    }
    return false;
  };
  // We need random-access slicing across chunk boundaries for the rare object split across reads; keep a
  // rolling buffer instead of a global growing string (bounded by one object's size, a few hundred bytes).
  let rolling = "";
  let rollingBase = 0; // `scanned` value corresponding to rolling[0]
  const fullSlice = (a, b) => rolling.slice(a - rollingBase, b - rollingBase);
  function handleBuilding(text) {
    if (!text) return;
    let bd;
    try { bd = JSON.parse(text); } catch (e) { reportErr(`${label}: buildings[${n}] is not valid JSON (${e.message})`); n++; return; }
    if (bd.id !== `bldg-${n}`) { badIds++; if (badIds <= 5) reportErr(`${label}: buildings[${n}].id is '${bd.id}', expected 'bldg-${n}'`); }
    checkOneBuildingBudgeted(bd, `${label}: buildings[${n}]`);
    n++;
  }
  let suppressedGeometry = 0;
  function checkOneBuildingBudgeted(bd, prefix) {
    if (errBudget <= 0) { suppressedGeometry++; return; } // avoid flooding output if something is systematically wrong
    const before = errors;
    checkOneBuilding(bd, prefix);
    if (errors > before) errBudget--;
  }

  let closed = false;
  const feed = (text) => {
    rolling += text;
    const startLen = rolling.length;
    closed = closed || consume(text);
    scanned += text.length;
    // trim the rolling buffer down to just the still-open object (or nothing, if none is open)
    const keepFrom = objStart >= 0 ? objStart : scanned;
    if (keepFrom > rollingBase) { rolling = rolling.slice(keepFrom - rollingBase); rollingBase = keepFrom; }
  };
  feed(buf);
  if (!closed) {
    const rl2 = fs.createReadStream(filePath, { encoding: "utf8", start: bytesRead, highWaterMark: 8 * 1024 * 1024 });
    for await (const chunk of rl2) { feed(chunk); if (closed) { rl2.destroy(); break; } }
  }

  if (n !== declaredCount) fail(`${label}: streamed ${n} buildings but the file declares buildingCount ${declaredCount}`);
  if (badIds > 0) fail(`${label}: ${badIds} building(s) have an id that doesn't match their position (bldg-<index>)`);
  let nonEmptyCells = 0;
  if (Array.isArray(headerJson.cells)) {
    let outOfRange = 0;
    for (const [ci, cell] of headerJson.cells.entries()) {
      if (!Array.isArray(cell)) { fail(`${label}: cells[${ci}] must be an array`); continue; }
      if (cell.length > 0) nonEmptyCells++;
      for (const idx of cell) if (!(idx >= 0 && idx < n)) outOfRange++;
    }
    if (outOfRange > 0) fail(`${label}: cells reference ${outOfRange} out-of-range building index(es)`);
  }
  const declaredNonEmpty = Number(tailMatch[2]);
  if (nonEmptyCells !== declaredNonEmpty) fail(`${label}: actual non-empty cells ${nonEmptyCells} != declared nonEmptyCells ${declaredNonEmpty}`);
  if (suppressedGeometry > 0) console.log(`${label}: geometry checks stopped early after enough errors; ${suppressedGeometry} more building(s) were not checked`);
  console.log(`${label}: ${n} buildings (streamed, ${(size / 1e6).toFixed(0)} MB), ${headerJson.cols}x${headerJson.rows} grid, ${nonEmptyCells} non-empty cells`);
}

for (const f of fs.readdirSync(DIR).filter((f) => f.startsWith("buildings_index."))) {
  const path = DIR + f, size = fs.statSync(path).size;
  if (size > STREAM_THRESHOLD) await checkBuildingsIndexStreaming(path, f);
  else checkBuildingsIndexSmall(fs.readFileSync(path, "utf8"), f);
}

// --- roads.*.geojson (empty placeholder, or real per-ward exports from export-subway-builder-roads.mjs) ---
const ROAD_CLASSES = new Set(["highway", "major", "minor"]);
const ROAD_STRUCTURES = new Set(["bridge", "normal", "tunnel"]);
for (const f of fs.readdirSync(DIR).filter((f) => /^roads.*\.geojson$/.test(f))) {
  const r = JSON.parse(fs.readFileSync(DIR + f, "utf8"));
  if (r.type !== "FeatureCollection" || !Array.isArray(r.features)) { fail(`${f}: not a GeoJSON FeatureCollection`); continue; }
  let named = 0; const byClass = {}, byStruct = {};
  for (const [i, feat] of r.features.entries()) {
    const p = feat.properties ?? {};
    if (!ROAD_CLASSES.has(p.roadClass)) fail(`${f}: features[${i}].properties.roadClass '${p.roadClass}' is not one of ${[...ROAD_CLASSES].join("/")}`);
    else byClass[p.roadClass] = (byClass[p.roadClass] || 0) + 1;
    if (!ROAD_STRUCTURES.has(p.structure)) fail(`${f}: features[${i}].properties.structure '${p.structure}' is not one of ${[...ROAD_STRUCTURES].join("/")}`);
    else byStruct[p.structure] = (byStruct[p.structure] || 0) + 1;
    if (typeof p.name !== "string") fail(`${f}: features[${i}].properties.name must be a string (possibly empty)`);
    else if (p.name) named++;
    const g = feat.geometry;
    if (!g || g.type !== "LineString" || !Array.isArray(g.coordinates) || g.coordinates.length < 2 || !g.coordinates.every(isCoord)) fail(`${f}: features[${i}].geometry must be a LineString with >=2 coordinates`);
  }
  const namedPct = r.features.length ? ((named / r.features.length) * 100).toFixed(1) + "%" : "n/a";
  console.log(`${f}: ${r.features.length} roads, class ${JSON.stringify(byClass)}, structure ${JSON.stringify(byStruct)}, ${named} named (${namedPct})`);
}

console.log(errors ? `\n${errors} check(s) failed` : "\nall checks passed");
process.exit(errors ? 1 : 0);
