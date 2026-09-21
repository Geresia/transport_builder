// Data-level checks for a CityPack, run from validate-pack.mjs. Dependency-free.
// Tiers (same idea as the registry's check-formatting / check-registry-invariants + integrity cache):
//   1. format     - every pack *.json parses, has no BOM (readers differ on BOM handling)
//   2. compressed - manifest.compressed siblings exist, match the recorded sizes, and are not stale vs the plain file
//   3. invariants - cross-file identities that must hold (municipality codes, O/D row sums, chome sums, per-building sums)
// Each check declares the files it reads; if every file's (size, mtime) is unchanged since the last run the stored
// result is reused instead of re-parsing ~100 MB of JSON. Cache: <transitline>/.cache/pack-checks.json (`--no-cache` to bypass).
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const CACHE_FILE = path.join(fileURLToPath(new URL("..", import.meta.url)), ".cache", "pack-checks.json");
const useCache = !process.argv.includes("--no-cache");
let cache = {};
try { if (useCache) cache = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")); } catch { cache = {}; }

const sig = (files) => files.map((f) => { try { const s = fs.statSync(f); return `${f}:${s.size}:${Math.floor(s.mtimeMs)}`; } catch { return `${f}:missing`; } }).join("|");
const stats = { ran: 0, cached: 0 };

// Run fn() -> {errors, warnings} unless the inputs are unchanged since a previous successful run.
function cached(key, files, fn) {
  const s = sig(files), hit = cache[key];
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

export function runPackChecks(dir, manifest, { fail, warn }) {
  const collect = (label, r) => { for (const e of r.errors) fail(`${label}: ${e}`); for (const w of r.warnings) warn(`${label}: ${w}`); };
  const jsonFiles = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
  const at = (f) => path.join(dir, f);

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
      if (p.residentsEst2026 !== undefined && p.popDate !== "2020") e(`${p.id}: residentsEst2026 present but popDate is ${p.popDate}`);
      if (p.popDate !== undefined && !["2020", "2020-derived"].includes(p.popDate)) w(`${p.id}: popDate '${p.popDate}' is not a census vintage (2020)`);
    }
  }));
  for (const p of demand.points) { const c = codeOf(p); if (c !== undefined) byCode.set(c, p); }

  // O/D: origins/dests are demand municipalities, row sums add up
  if (manifest.files?.od && exists(at(manifest.files.od))) {
    collect("invariant od", cached(`${dir}|inv-od`, inputs(dir, [manifest.files.od, manifest.files.demand]), (e) => {
      const od = rdJson(at(manifest.files.od));
      for (const c of byCode.keys()) if (!od.origins[c]) e(`demand municipality ${c} has no O/D row`);
      for (const [o, r] of Object.entries(od.origins)) {
        if (!byCode.has(o)) { e(`O/D origin ${o} is not a demand municipality`); continue; }
        let s = r.self + (r.unknown ?? 0) + r.out;
        for (const [d, n] of Object.entries(r.dest)) { if (!byCode.has(d)) e(`O/D ${o} -> ${d}: destination not in demand`); s += n; }
        if (s !== r.workers) e(`O/D ${o}: self+unknown+out+sum(dest)=${s} != workers ${r.workers}`);
        if (r.home > r.self) e(`O/D ${o}: home ${r.home} > self ${r.self}`);
      }
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

  // quality block: the registry answer keys must all be present
  if (manifest.quality) {
    const need = ["workplace_count", "workplace_granularity", "workplace_resolution", "workplace_intensity", "resident_count", "resident_granularity", "resident_resolution", "resident_intensity", "od_metric"];
    for (const k of need) if (!manifest.quality.answers?.[k]) fail(`manifest.quality.answers.${k} is missing`);
    if (manifest.quality.answers?.od_metric && manifest.quality.answers.od_metric !== "none" && !manifest.files?.od) fail("manifest.quality claims an O/D metric but files.od is not declared");
  }
  return stats;
}

export function saveCache() {
  if (!useCache) return;
  try { fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true }); fs.writeFileSync(CACHE_FILE, JSON.stringify(cache)); } catch { /* cache is best-effort */ }
}
export { stats as checkStats };
