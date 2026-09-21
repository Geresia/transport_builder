// Validates a CityPack. Dependency-free on purpose — this runs in CI before
// anything is installed, and it enforces the licensing boundary, not just shape.
//   node scripts/validate-pack.mjs packs/example-radial
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const dir = resolve(process.argv[2] ?? "");
if (!process.argv[2]) {
  console.error("usage: node scripts/validate-pack.mjs <pack-dir>");
  process.exit(2);
}

const errors = [];
const warnings = [];
const fail = (m) => errors.push(m);
const warn = (m) => warnings.push(m);

const readJson = (p) => {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch (e) {
    fail(`${p}: ${e.message}`);
    return null;
  }
};

const manifest = existsSync(join(dir, "manifest.json"))
  ? readJson(join(dir, "manifest.json"))
  : (fail("manifest.json is missing"), null);

if (manifest) {
  if (manifest.formatVersion !== 1) fail(`unsupported formatVersion: ${manifest.formatVersion}`);
  for (const k of ["id", "name", "version", "bbox", "origin", "data", "files"]) {
    if (manifest[k] === undefined) fail(`manifest.${k} is required`);
  }
  if (manifest.id && !/^[a-z0-9][a-z0-9-]*$/.test(manifest.id)) fail(`manifest.id is not a valid slug: ${manifest.id}`);
  if (Array.isArray(manifest.bbox)) {
    const [w, s, e, n] = manifest.bbox;
    if (manifest.bbox.length !== 4) fail("manifest.bbox must have 4 numbers");
    else if (!(w < e && s < n)) fail(`manifest.bbox is degenerate or inverted: ${JSON.stringify(manifest.bbox)}`);
  }

  // --- Rule 3: the pack declares its own obligations, and we hold it to them.
  const lic = manifest.data?.license;
  const attr = manifest.data?.attribution;
  if (!lic) fail("manifest.data.license is required");
  if (!Array.isArray(attr)) fail("manifest.data.attribution must be an array");
  else if (lic && lic !== "CC0-1.0" && attr.length === 0) {
    fail(`license '${lic}' requires at least one manifest.data.attribution entry`);
  }
  if (lic === "ODbL-1.0") {
    for (const f of ["LICENSE-DATA", "ATTRIBUTION.md"]) {
      if (!existsSync(join(dir, f))) fail(`ODbL pack must ship ${f} (see LICENSING.md Rule 2)`);
    }
    if (!Array.isArray(manifest.data?.sources) || manifest.data.sources.length === 0) {
      fail("ODbL pack must record manifest.data.sources");
    }
  }

  // --- Declared files must exist.
  for (const [key, val] of Object.entries(manifest.files ?? {})) {
    // a key may list several files (e.g. tokyo's buildingTilesRegional)
    for (const rel of Array.isArray(val) ? val : [val]) {
      if (!existsSync(join(dir, rel))) fail(`files.${key} points at missing file: ${rel}`);
    }
  }
  if (!manifest.files?.demand) fail("files.demand is required");
  if (!manifest.files?.obstacles) warn("no obstacles layer — placement collision will be disabled");
  if (!manifest.files?.basemap) warn("no basemap layer — the pack renders as abstract geometry");
}

const demandPath = manifest?.files?.demand && join(dir, manifest.files.demand);
const demand = demandPath && existsSync(demandPath) ? readJson(demandPath) : null;

if (demand) {
  if (demand.formatVersion !== 1) fail(`demand.formatVersion unsupported: ${demand.formatVersion}`);
  if (!["matrix", "gravity"].includes(demand.model)) fail(`demand.model must be 'matrix' or 'gravity', got ${demand.model}`);
  if (!Array.isArray(demand.points) || demand.points.length === 0) fail("demand.points must be a non-empty array");

  const ids = new Set();
  for (const [i, p] of (demand.points ?? []).entries()) {
    const at = `points[${i}]`;
    if (!p.id) fail(`${at}.id is required`);
    else if (ids.has(p.id)) fail(`${at}.id is duplicated: ${p.id}`);
    else ids.add(p.id);
    if (!Array.isArray(p.location) || p.location.length !== 2 || p.location.some((n) => typeof n !== "number")) {
      fail(`${at}.location must be [lon, lat]`);
    } else if (manifest?.bbox?.length === 4) {
      const [lon, lat] = p.location;
      const [w, s, e, n] = manifest.bbox;
      if (lon < w || lon > e || lat < s || lat > n) fail(`${at} (${p.id}) lies outside manifest.bbox`);
    }
    if (demand.model === "gravity" && p.residents === undefined && p.jobs === undefined) {
      fail(`${at} (${p.id}): gravity model needs residents and/or jobs`);
    }
  }

  if (demand.model === "matrix") {
    if (!Array.isArray(demand.flows) || demand.flows.length === 0) fail("matrix model requires demand.flows");
    for (const [i, f] of (demand.flows ?? []).entries()) {
      if (!ids.has(f.from)) fail(`flows[${i}].from references unknown point: ${f.from}`);
      if (!ids.has(f.to)) fail(`flows[${i}].to references unknown point: ${f.to}`);
      if (typeof f.trips !== "number" || f.trips < 0) fail(`flows[${i}].trips must be a non-negative number`);
    }
  } else if (demand.flows) {
    warn("demand.flows is ignored under the gravity model");
  }

  for (const [i, a] of (demand.attractors ?? []).entries()) {
    const at = `attractors[${i}]`;
    for (const k of ["id", "kind", "location", "capacity"]) {
      if (a[k] === undefined) fail(`${at}.${k} is required`);
    }
    if (a.residentialSplit !== undefined && (a.residentialSplit < 0 || a.residentialSplit > 1)) {
      fail(`${at}.residentialSplit must be between 0 and 1`);
    }
    if (a.decayExponent !== undefined && !(typeof a.decayExponent === "number" && a.decayExponent > 0)) {
      fail(`${at}.decayExponent must be a number greater than 0`);
    }
  }
}


// --- calendar: day types and time-of-day structure (optional, additive to v1)
const cal = demand?.calendar;
const dayTypeIds = new Set();
const periodIds = new Set();
if (cal) {
  if (!Array.isArray(cal.dayTypes) || cal.dayTypes.length === 0) fail("calendar.dayTypes must be a non-empty array");
  for (const [i, d] of (cal.dayTypes ?? []).entries()) {
    if (!d.id) fail(`calendar.dayTypes[${i}].id is required`);
    else if (dayTypeIds.has(d.id)) fail(`calendar.dayTypes[${i}].id is duplicated: ${d.id}`);
    else dayTypeIds.add(d.id);
    if (typeof d.weight !== "number" || d.weight < 0) fail(`calendar.dayTypes[${i}].weight must be a non-negative number`);
  }
  const totalWeight = (cal.dayTypes ?? []).reduce((a, d) => a + (d.weight ?? 0), 0);
  if (totalWeight !== 7) warn(`calendar.dayTypes weights sum to ${totalWeight}, not 7 — intentional?`);

  if (!Array.isArray(cal.periods) || cal.periods.length === 0) fail("calendar.periods must be a non-empty array");
  const periods = [...(cal.periods ?? [])];
  for (const [i, r] of periods.entries()) {
    if (!r.id) fail(`calendar.periods[${i}].id is required`);
    else if (periodIds.has(r.id)) fail(`calendar.periods[${i}].id is duplicated: ${r.id}`);
    else periodIds.add(r.id);
    if (typeof r.startMinute !== "number" || typeof r.endMinute !== "number") {
      fail(`calendar.periods[${i}] needs numeric startMinute and endMinute`);
    } else if (r.endMinute <= r.startMinute) {
      fail(`calendar.periods[${i}] (${r.id}) ends at or before it starts`);
    }
  }
  // Periods must tile the service day: no gaps, no overlaps.
  const sorted = periods.filter((r) => typeof r.startMinute === "number").sort((a, b) => a.startMinute - b.startMinute);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1], cur = sorted[i];
    if (cur.startMinute > prev.endMinute) fail(`calendar.periods: gap between '${prev.id}' and '${cur.id}' (${prev.endMinute} -> ${cur.startMinute})`);
    else if (cur.startMinute < prev.endMinute) fail(`calendar.periods: '${prev.id}' and '${cur.id}' overlap`);
  }

  // factors must cover every dayType x period.
  if (typeof cal.factors !== "object" || cal.factors === null) fail("calendar.factors must be an object");
  else {
    for (const dt of dayTypeIds) {
      if (!cal.factors[dt]) { fail(`calendar.factors is missing dayType '${dt}'`); continue; }
      for (const pd of periodIds) {
        if (typeof cal.factors[dt][pd] !== "number") fail(`calendar.factors['${dt}']['${pd}'] is missing or not a number`);
      }
    }
    for (const dt of Object.keys(cal.factors)) {
      if (!dayTypeIds.has(dt)) fail(`calendar.factors references unknown dayType '${dt}'`);
      else for (const pd of Object.keys(cal.factors[dt])) {
        if (!periodIds.has(pd)) fail(`calendar.factors['${dt}'] references unknown period '${pd}'`);
      }
    }
  }
}

// Flow day-type/period references are only checkable against a calendar.
for (const [i, f] of (demand?.flows ?? []).entries()) {
  if (f.dayType !== undefined) {
    if (!cal) fail(`flows[${i}].dayType is set but the pack has no calendar`);
    else if (!dayTypeIds.has(f.dayType)) fail(`flows[${i}].dayType references unknown dayType: ${f.dayType}`);
  }
  if (f.period !== undefined && cal && !periodIds.has(f.period)) {
    fail(`flows[${i}].period references unknown period: ${f.period}`);
  }
}

for (const w of warnings) console.log(`  note  ${w}`);
if (errors.length) {
  console.error(`\nFAIL  ${dir}`);
  for (const e of errors) console.error(`  ✗ ${e}`);
  process.exit(1);
}
const n = demand?.points?.length ?? 0;
const a = demand?.attractors?.length ?? 0;
console.log(`\nOK    ${manifest.name} (${manifest.id}) — ${n} points, ${a} attractors, ${manifest.data.license}`);
