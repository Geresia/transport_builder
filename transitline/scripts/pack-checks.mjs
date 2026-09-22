// Data-level checks for a CityPack, run from validate-pack.mjs. Dependency-free.
// Tiers (same idea as the registry's check-formatting / check-registry-invariants + integrity cache):
//   1. format     - every pack *.json parses, has no BOM (readers differ on BOM handling)
//   2. compressed - manifest.compressed siblings exist, match the recorded sizes, and are not stale vs the plain file
//   2b. schema    - manifest.json and demand.json against schemas/citypack-*.schema.json (built-in subset validator)
//   3. invariants - cross-file identities that must hold (municipality codes, O/D row sums, chome sums, per-building sums)
// Each check declares the files it reads; if every file's (size, mtime) is unchanged since the last run the stored
// result is reused instead of re-parsing ~100 MB of JSON. Cache: <transitline>/.cache/pack-checks.json (`--no-cache` to bypass).
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { checkAnswers, computeQuality, RUBRIC_VERSION } from "./quality-rubric.mjs";

const CACHE_FILE = path.join(fileURLToPath(new URL("..", import.meta.url)), ".cache", "pack-checks.json");
const useCache = !process.argv.includes("--no-cache");
let cache = {};
try { if (useCache) cache = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")); } catch { cache = {}; }

const sig = (files) => files.map((f) => { try { const s = fs.statSync(f); return `${f}:${s.size}:${Math.floor(s.mtimeMs)}`; } catch { return `${f}:missing`; } }).join("|");
const stats = { ran: 0, cached: 0 };

// This file's own content is part of every cache signature, so editing a check invalidates every cached
// result for it automatically - without this, a bug fix here would silently keep reusing pre-fix verdicts
// (code-review-2026-09-22.md D-04).
const SELF_SIG = crypto.createHash("sha256").update(fs.readFileSync(fileURLToPath(import.meta.url))).digest("hex").slice(0, 16);

// Run fn() -> {errors, warnings} unless the inputs are unchanged since a previous successful run.
// (Named distinctly from the `cached` that runPackChecks defines below, which wraps this one -
// reusing the name there would put it in the temporal dead zone of its own `const` declaration.)
function runCached(key, files, fn) {
  const s = SELF_SIG + "|" + sig(files), hit = cache[key];
  if (hit && hit.sig === s) { stats.cached++; return hit; }
  stats.ran++;
  const r = { errors: [], warnings: [] };
  fn((m) => r.errors.push(m), (m) => r.warnings.push(m));
  cache[key] = { sig: s, errors: r.errors, warnings: r.warnings };
  return cache[key];
}

// Read a pack JSON that may exist as plain, as .gz, or both.
const rdJson = (p) => {
  const strip = (t) => (t.charCodeAt(0) === 0xfeff ? t.slice(1) : t); // BOM is reported by the format check, not a crash here
  if (fs.existsSync(p)) return JSON.parse(strip(fs.readFileSync(p, "utf8")));
  if (fs.existsSync(p + ".gz")) return JSON.parse(strip(zlib.gunzipSync(fs.readFileSync(p + ".gz")).toString("utf8")));
  return null;
};
const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const exists = (p) => fs.existsSync(p) || fs.existsSync(p + ".gz");
const inputs = (dir, names) => names.flatMap((n) => [path.join(dir, n), path.join(dir, n + ".gz")]);

// Minimal JSON Schema (draft 2020-12 subset) validator, dependency-free. It supports exactly the keywords our schemas use and
// throws on any other validation keyword, so the schema can never silently stop being enforced.
const ANNOTATION = new Set(["$schema", "$id", "title", "description", "examples", "format", "default"]);
function validateSchema(v, s, at, errs) {
  const type = (x) => (x === null ? "null" : Array.isArray(x) ? "array" : Number.isInteger(x) ? "integer" : typeof x);
  const ok = (sub, val = v) => { const e = []; validateSchema(val, sub, at, e); return e.length === 0; };
  for (const [k, rule] of Object.entries(s)) {
    if (ANNOTATION.has(k)) continue;
    switch (k) {
      case "type": { const t = type(v), want = [].concat(rule); if (!want.includes(t) && !(t === "integer" && want.includes("number"))) errs.push(`${at}: expected ${want.join("|")}, got ${t}`); break; }
      case "const": if (JSON.stringify(v) !== JSON.stringify(rule)) errs.push(`${at}: must be ${JSON.stringify(rule)}`); break;
      case "enum": if (!rule.some((x) => JSON.stringify(x) === JSON.stringify(v))) errs.push(`${at}: must be one of ${JSON.stringify(rule)}`); break;
      case "pattern": if (typeof v === "string" && !new RegExp(rule).test(v)) errs.push(`${at}: '${v}' does not match ${rule}`); break;
      case "minLength": if (typeof v === "string" && v.length < rule) errs.push(`${at}: shorter than ${rule}`); break;
      case "minimum": if (typeof v === "number" && v < rule) errs.push(`${at}: ${v} < ${rule}`); break;
      case "maximum": if (typeof v === "number" && v > rule) errs.push(`${at}: ${v} > ${rule}`); break;
      case "minItems": if (Array.isArray(v) && v.length < rule) errs.push(`${at}: fewer than ${rule} items`); break;
      case "maxItems": if (Array.isArray(v) && v.length > rule) errs.push(`${at}: more than ${rule} items`); break;
      case "items": if (Array.isArray(v)) v.forEach((x, i) => validateSchema(x, rule, `${at}[${i}]`, errs)); break;
      case "required": if (v && typeof v === "object" && !Array.isArray(v)) for (const r of rule) if (!(r in v)) errs.push(`${at}: missing required '${r}'`); break;
      case "properties": if (v && typeof v === "object" && !Array.isArray(v)) for (const [p, sub] of Object.entries(rule)) if (p in v) validateSchema(v[p], sub, `${at}.${p}`, errs); break;
      case "additionalProperties":
        if (v && typeof v === "object" && !Array.isArray(v)) {
          const known = new Set(Object.keys(s.properties ?? {}));
          for (const p of Object.keys(v)) {
            if (known.has(p)) continue;
            if (rule === false) errs.push(`${at}: unknown property '${p}' (declare it in the schema)`);
            else if (rule && typeof rule === "object") validateSchema(v[p], rule, `${at}.${p}`, errs);
          }
        }
        break;
      case "oneOf": if (rule.filter((sub) => ok(sub)).length !== 1) errs.push(`${at}: must match exactly one of the allowed forms`); break;
      case "anyOf": if (!rule.some((sub) => ok(sub))) errs.push(`${at}: matches none of the allowed forms`); break;
      case "allOf": rule.forEach((sub) => validateSchema(v, sub, at, errs)); break;
      case "not": if (ok(rule)) errs.push(`${at}: matches a forbidden form`); break;
      case "if": if (ok(rule) && s.then) validateSchema(v, s.then, at, errs); else if (!ok(rule) && s.else) validateSchema(v, s.else, at, errs); break;
      case "then": case "else": break; // handled with "if"
      default: throw new Error(`schema keyword '${k}' at ${at} is not supported by scripts/pack-checks.mjs - extend validateSchema`);
    }
  }
}

export function runPackChecks(dir, manifest, { fail, warn }) {
  const collect = (label, r) => { for (const e of r.errors) fail(`${label}: ${e}`); for (const w of r.warnings) warn(`${label}: ${w}`); };
  const jsonFiles = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  const at = (f) => path.join(dir, f);
  // Every check below reads the already-parsed `manifest` object (which file names, quality answers, etc.
  // come from), but most pass only the *target* files' paths to cached() - manifest.json's own (size, mtime)
  // was never part of the signature, so editing manifest.json (a different `files.demand` path, a changed
  // quality answer, ...) without touching the target files could keep reusing a stale cached verdict
  // (code-review-2026-09-22.md D-04). Folding manifest.json into every signature here covers all call sites
  // below at once, since they all go through this shadowed `cached`.
  const manifestPath = at("manifest.json");
  const cached = (key, files, fn) => runCached(key, [manifestPath, ...files], fn);

  // 1. format ------------------------------------------------------------------------------------
  for (const f of jsonFiles) {
    collect(`format ${f}`, cached(`${dir}|format|${f}`, [at(f)], (e) => {
      const b = fs.readFileSync(at(f));
      if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) e("starts with a UTF-8 BOM (write JSON without BOM)");
      try { JSON.parse(b.toString("utf8").replace(/^﻿/, "")); } catch (x) { e(`invalid JSON: ${x.message}`); }
    }));
  }

  // 2. compressed siblings -----------------------------------------------------------------------
  for (const [name, c] of Object.entries(manifest.compressed ?? {})) {
    const plain = at(name), gz = at(c.file ?? name + ".gz");
    collect(`compressed ${name}`, cached(`${dir}|gz|${name}`, [plain, gz], (e, w) => {
      if (!fs.existsSync(gz)) return e(`${path.basename(gz)} is listed in manifest.compressed but missing`);
      const gzBuf = fs.readFileSync(gz);
      if (c.gzBytes !== undefined && gzBuf.length !== c.gzBytes) e(`gz size ${gzBuf.length} != manifest gzBytes ${c.gzBytes}`);
      let raw;
      try { raw = zlib.gunzipSync(gzBuf); } catch (x) { return e(`not valid gzip: ${x.message}`); }
      if (c.bytes !== undefined && raw.length !== c.bytes) e(`decompressed size ${raw.length} != manifest bytes ${c.bytes}`);
      if (fs.existsSync(plain)) {
        const p = fs.readFileSync(plain);
        if (!p.equals(raw)) e(`stale: plain ${name} (sha ${sha(p).slice(0, 12)}) differs from ${path.basename(gz)} (sha ${sha(raw).slice(0, 12)}) - rerun scripts/pack-compress.mjs`);
      } else w(`plain ${name} not present; loaders fall back to the .gz`);
    }));
  }

  // 1b. PMTiles: magic + version 3, and the per-building tile layers must carry the modeled value fields the viewer/engine read
  const REQUIRED_TILE_FIELDS = { buildingTilesSurvey: ["lu", "levels", "pop", "jobs", "emp"], buildingTiles: ["pop"] };
  for (const [key, val] of Object.entries(manifest.files ?? {})) {
    for (const rel of [].concat(val)) {
      if (typeof rel !== "string" || !rel.endsWith(".pmtiles") || !fs.existsSync(at(rel))) continue;
      collect(`pmtiles ${rel}`, cached(`${dir}|pmtiles|${rel}`, [at(rel)], (e) => {
        const fd = fs.openSync(at(rel), "r");
        try {
          const h = Buffer.alloc(127); fs.readSync(fd, h, 0, 127, 0);
          if (h.toString("latin1", 0, 7) !== "PMTiles" || h[7] !== 3) return e("not a PMTiles v3 archive (bad magic/version)");
          const need = REQUIRED_TILE_FIELDS[key];
          if (!need) return;
          const off = Number(h.readBigUInt64LE(24)), len = Number(h.readBigUInt64LE(32)), comp = h[97];
          let meta = Buffer.alloc(len); fs.readSync(fd, meta, 0, len, off);
          if (comp === 2) meta = zlib.gunzipSync(meta); else if (comp > 2) return e(`unsupported metadata compression ${comp}`);
          const fields = new Set((JSON.parse(meta.toString("utf8")).vector_layers ?? []).flatMap((l) => Object.keys(l.fields ?? {})));
          for (const f of need) if (!fields.has(f)) e(`tile layer has no '${f}' field (files.${key} must carry ${need.join(", ")})`);
        } finally { fs.closeSync(fd); }
      }));
    }
  }

  // A malformed `files` map is reported by validate-pack and the schema check below; the checks that follow assume path strings.
  const filesOk = Object.values(manifest.files ?? {}).flat().every((v) => typeof v === "string");

  // 2b. schemas: the manifest and demand.json must satisfy schemas/citypack-*.schema.json
  const schemaDir = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "schemas");
  const schemaTargets = [["manifest", "citypack-manifest.schema.json", "manifest.json"]];
  if (manifest.files?.demand) schemaTargets.push(["demand", "citypack-demand.schema.json", manifest.files.demand]);
  for (const [label, sf, target] of schemaTargets) {
    if (!exists(at(target))) continue;
    collect(`schema ${target}`, cached(`${dir}|schema|${target}`, [path.join(schemaDir, sf), ...inputs(dir, [target])], (e) => {
      const errs = [];
      validateSchema(rdJson(at(target)), JSON.parse(fs.readFileSync(path.join(schemaDir, sf), "utf8")), label, errs);
      for (const m of errs.slice(0, 20)) e(m);
      if (errs.length > 20) e(`... ${errs.length - 20} more`);
    }));
  }

  if (!filesOk) return stats;

  // 3. invariants --------------------------------------------------------------------------------
  const demand = manifest.files?.demand && exists(at(manifest.files.demand)) ? rdJson(at(manifest.files.demand)) : null;
  if (!demand) return stats;
  const codeOf = (p) => (p.jisCode !== undefined ? String(p.jisCode).slice(0, 5) : p.code);
  const byCode = new Map();

  collect("invariant demand", cached(`${dir}|inv-demand`, inputs(dir, [manifest.files.demand]), (e, w) => {
    const ids = new Set(), codes = new Set();
    for (const p of demand.points) {
      if (ids.has(p.id)) e(`duplicate id ${p.id}`); ids.add(p.id);
      const c = codeOf(p);
      if (c !== undefined) { if (codes.has(c)) e(`duplicate municipality code ${c} (${p.id})`); codes.add(c); }
      if (p.residents !== undefined && !(Number.isInteger(p.residents) && p.residents >= 0)) e(`${p.id}: residents must be a non-negative integer`);
      if (p.jobs !== undefined && !(Number.isInteger(p.jobs) && p.jobs >= 0)) e(`${p.id}: jobs must be a non-negative integer`);
      if (p.residentsEst2026 !== undefined && p.popDate !== "2020") e(`${p.id}: residentsEst2026 present but popDate is ${p.popDate}`);
      if (p.popDate !== undefined && !["2020", "2020-derived"].includes(p.popDate)) w(`${p.id}: popDate '${p.popDate}' is not a census vintage (2020)`);
    }
  }));
  for (const p of demand.points) { const c = codeOf(p); if (c !== undefined) byCode.set(c, p); }

  // O/D: origins/dests are demand municipalities, row sums add up, and demand.points[].jobs (if present) is the O/D workplace-here count
  if (manifest.files?.od && exists(at(manifest.files.od))) {
    collect("invariant od", cached(`${dir}|inv-od`, inputs(dir, [manifest.files.od, manifest.files.demand]), (e) => {
      const od = rdJson(at(manifest.files.od));
      for (const c of byCode.keys()) if (!od.origins[c]) e(`demand municipality ${c} has no O/D row`);
      const here = {};
      for (const [o, r] of Object.entries(od.origins)) {
        if (!byCode.has(o)) { e(`O/D origin ${o} is not a demand municipality`); continue; }
        let s = r.self + (r.unknown ?? 0) + r.out;
        here[o] = (here[o] ?? 0) + r.self;
        for (const [d, n] of Object.entries(r.dest)) { if (!byCode.has(d)) e(`O/D ${o} -> ${d}: destination not in demand`); s += n; here[d] = (here[d] ?? 0) + n; }
        if (s !== r.workers) e(`O/D ${o}: self+unknown+out+sum(dest)=${s} != workers ${r.workers}`);
        if (r.home > r.self) e(`O/D ${o}: home ${r.home} > self ${r.self}`);
      }
      const jobbed = demand.points.filter((p) => p.jobs !== undefined);
      if (jobbed.length > 0 && jobbed.length !== demand.points.length) e(`demand.points: ${jobbed.length}/${demand.points.length} have 'jobs' - expected all or none`);
      for (const p of jobbed) { const c = codeOf(p); if (here[c] !== p.jobs) e(`${p.id}: demand.jobs ${p.jobs} != O/D workplace-here count ${here[c]} (rerun scripts/tokyo-demand-jobs.mjs)`); }
    }));
  }

  // sub-ward layers: chome residents sum to the demand municipality total (census identity), workers agree with jobs.json
  const subFiles = Object.entries(manifest.files ?? {}).filter(([k]) => /^subward/.test(k)).map(([, v]) => v);
  const extraSub = jsonFiles.filter((f) => /^subward(-[a-z]+)?\.json$/.test(f));
  for (const f of new Set([...subFiles, ...extraSub])) {
    if (!exists(at(f))) continue;
    collect(`invariant ${f}`, cached(`${dir}|inv-sub|${f}`, inputs(dir, [f, manifest.files.demand]), (e, w) => {
      const sw = rdJson(at(f));
      for (const wd of Object.values(sw.wards)) {
        const p = byCode.get(String(wd.estat_code));
        if (!p) { w(`ward ${wd.estat_code} has no demand point`); continue; }
        const sum = wd.areas.reduce((t, a) => t + (a.residents || 0), 0);
        if (p.residents !== undefined && sum !== p.residents) e(`${wd.estat_code}: chome residents ${sum} != demand residents ${p.residents}`);
      }
    }));
  }

  // employed residents: covers every sub-ward chome, adds up to the census municipality total, and reconciles with the O/D table
  // (employed = workers with a stated workplace [od.workers] + workplace not stated) - two independent census tables
  if (manifest.files?.employed && exists(at(manifest.files.employed))) {
    const subs = [...new Set([...subFiles, ...extraSub])].filter((f) => exists(at(f)));
    const odf = manifest.files.od && exists(at(manifest.files.od)) ? manifest.files.od : null;
    collect("invariant employed", cached(`${dir}|inv-emp`, inputs(dir, [manifest.files.employed, manifest.files.demand, ...(odf ? [odf] : []), ...subs]), (e) => {
      const emp = rdJson(at(manifest.files.employed)), odj = odf ? rdJson(at(odf)) : null;
      const sums = {}; let missing = 0, over = 0;
      for (const f of subs) for (const wd of Object.values(rdJson(at(f)).wards)) for (const a of wd.areas) {
        const v = emp.areas[a.code];
        if (v === undefined) { if (missing++ < 5) e(`chome ${a.code} has no employed count`); continue; }
        if (!(Number.isInteger(v) && v >= 0)) e(`chome ${a.code}: employed must be a non-negative integer`);
        if (v > (a.residents || 0) && over++ < 5) e(`chome ${a.code}: employed ${v} exceeds residents ${a.residents}`);
        sums[wd.estat_code] = (sums[wd.estat_code] || 0) + v;
      }
      if (missing > 5) e(`... ${missing - 5} more chomes without an employed count`);
      const areaSet = new Set(Object.keys(emp.areas));
      for (const c of emp.estimated ?? []) if (!areaSet.has(c)) e(`estimated chome ${c} is not in areas`);
      for (const [m, s] of Object.entries(sums)) {
        const mu = emp.municipalities?.[m];
        if (!mu) { e(`municipality ${m} missing from employed.municipalities`); continue; }
        if (mu.employed !== s) e(`municipality ${m}: chome employed ${s} != census municipality total ${mu.employed}`);
        const o = odj?.origins?.[m];
        if (o && mu.employed !== o.workers + mu.unstated) e(`municipality ${m}: employed ${mu.employed} != O/D workers ${o.workers} + workplace-not-stated ${mu.unstated}`);
      }
    }));
  }

  // per-building jobs: each chome's buildings sum to the chome's worker total, which equals the census-derived jobs.json
  if (manifest.files?.jobsBuildings && exists(at(manifest.files.jobsBuildings))) {
    const jf = manifest.files.jobs;
    collect("invariant jobs-buildings", cached(`${dir}|inv-jobsb`, inputs(dir, [manifest.files.jobsBuildings, ...(jf ? [jf] : [])]), (e, w) => {
      const jb = rdJson(at(manifest.files.jobsBuildings)), jobs = jf && exists(at(jf)) ? rdJson(at(jf)) : null;
      let bad = 0;
      for (const [code, a] of Object.entries(jb.areas)) {
        const s = a.buildings.reduce((t, b) => t + (b.workers || 0), 0);
        if (s !== a.workers_total && bad++ < 5) e(`chome ${code}: sum(building workers) ${s} != workers_total ${a.workers_total}`);
        const jw = jobs?.areas?.[code]?.w;
        if (jw !== undefined && jw !== a.workers_total && bad++ < 5) e(`chome ${code}: workers_total ${a.workers_total} != jobs.json ${jw}`);
      }
      if (bad > 5) e(`... ${bad - 5} more`);
    }));
  }

  // quality block: every answer is a rubric value, and stored scores equal a fresh computation (registry CI does the same)
  if (manifest.quality) {
    const blocks = [["quality", manifest.quality], ...Object.entries(manifest.quality.areas ?? {}).map(([k, v]) => [`quality.areas.${k}`, v])];
    for (const [label, q] of blocks) {
      const bad = checkAnswers(q.answers);
      for (const m of bad) fail(`manifest.${label}: ${m}`);
      if (bad.length) continue;
      const fresh = computeQuality(q.answers);
      if (q.computed) {
        if (q.computed.tier !== fresh.tier) fail(`manifest.${label}.computed.tier is '${q.computed.tier}' but the answers score '${fresh.tier}' - run scripts/pack-quality.mjs --write`);
        if (Math.abs(q.computed.weighted_score - fresh.weighted_score) > 0.0005 || Math.abs(q.computed.raw_score - fresh.raw_score) > 0.0005) {
          fail(`manifest.${label}.computed scores (${q.computed.weighted_score}/${q.computed.raw_score}) differ from the answers (${fresh.weighted_score}/${fresh.raw_score}) - run scripts/pack-quality.mjs --write`);
        }
      } else warn(`manifest.${label} has no computed scores (run scripts/pack-quality.mjs --write)`);
    }
    if (manifest.quality.rubric_version !== RUBRIC_VERSION) fail(`manifest.quality.rubric_version ${manifest.quality.rubric_version} != ${RUBRIC_VERSION}: re-score deliberately after a rubric change`);
    if (manifest.quality.answers?.od_metric && manifest.quality.answers.od_metric !== "none" && !manifest.files?.od) fail("manifest.quality claims an O/D metric but files.od is not declared");
  }
  return stats;
}

export function saveCache() {
  if (!useCache) return;
  try { fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true }); fs.writeFileSync(CACHE_FILE, JSON.stringify(cache)); } catch { /* cache is best-effort */ }
}
export { stats as checkStats };
