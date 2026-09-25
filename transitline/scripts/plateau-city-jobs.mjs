// Per-building workers for one PLATEAU city: fit workers-per-floor-area by building use, then distribute each chome's
// real 2021 Economic Census worker total over its buildings. One config-driven script for every city in
// plateau-cities.json (replaces the per-city saitama-/kawasaki-/... *-job-coefficients + *-jobs-buildings pairs).
// Usage: node scripts/plateau-city-jobs.mjs <slug> <plateau-<slug>.json from plateau-buildings.mjs>
//
// Method (same as tokyo-job-coefficients.mjs): non-negative weighted least squares (weight 1/(workers+200)) of chome
// workers on chome floor area by 用途, no intercept. Buildings go to chome by point-in-polygon; floor area is the
// surveyed 延床面積 or, where missing, mesh footprint x a learned floor/footprint ratio (plateau-chome.mjs).
// Outputs (packs/tokyo/): job-coefficients-<slug>.json, jobs-buildings-<slug>.json(+.gz), an entry in
// plateau-jobs-index.json, and manifest.json (files.plateauJobs, compressed[...], one PLATEAU attribution line).
// MODELED: chome totals are measured, the split among buildings is not; each chome is normalized to its census
// total, so coefficient bias affects the split, never the total.
import fs from "fs";
import zlib from "zlib";
import { fileURLToPath } from "url";
import { readPackJson } from "./pack-json.mjs";
import { chomeIndex, buildingRecords } from "./plateau-chome.mjs";

const T = fileURLToPath(new URL("../packs/tokyo/", import.meta.url));
const [slug, src] = process.argv.slice(2);
if (!slug || !src) throw new Error("usage: plateau-city-jobs.mjs <slug> <plateau-<slug>.json>");
const city = JSON.parse(fs.readFileSync(fileURLToPath(new URL("./plateau-cities.json", import.meta.url)), "utf8")).cities.find((c) => c.slug === slug);
if (!city) throw new Error(`no city '${slug}' in plateau-cities.json`);

const bld = JSON.parse(fs.readFileSync(src, "utf8"));
const sw = readPackJson(T + `subward-${city.pref}.json`), jobs = readPackJson(T + `jobs-${city.pref}.json`);
const { areas, locate } = chomeIndex(sw.wards, city.wards[0], city.wards[1]);
if (!areas.length) throw new Error(`no chome found for wards ${city.wards} in subward-${city.pref}.json`);
const { records, stat } = buildingRecords(bld, locate);

// ---- 1. aggregate floor area by chome x 用途 and fit ----
const agg = new Map(), useSet = new Set();
for (const b of records) {
  const cls = b.use ?? "不明";
  useSet.add(cls);
  const o = agg.get(b.chome) ?? agg.set(b.chome, {}).get(b.chome);
  o[cls] = (o[cls] ?? 0) + b.floorM2;
}
const U = [...useSet].sort(), p = U.length;
const rows = [];
for (const [id, fa] of agg) {
  const W = jobs.areas[areas[id].code]?.w;
  if (W == null) continue;
  rows.push({ code: areas[id].code, ward: areas[id].ward, W, x: U.map((u) => fa[u] ?? 0) });
}
if (rows.length < 5) throw new Error(`only ${rows.length} chome with both buildings and census workers - check the ward range / files`);
function fit(rs) {
  const wt = rs.map((r) => 1 / (r.W + 200)), beta = new Array(p).fill(0.01), col = U.map((_, j) => rs.map((r) => r.x[j]));
  const res = rs.map((r) => r.W - r.x.reduce((s, v, j) => s + v * beta[j], 0));
  for (let it = 0; it < 3000; it++) for (let j = 0; j < p; j++) {
    let num = 0, den = 0;
    for (let i = 0; i < rs.length; i++) { const x = col[j][i]; num += wt[i] * x * (res[i] + x * beta[j]); den += wt[i] * x * x; }
    const nb = den > 0 ? Math.max(0, num / den) : 0, d = nb - beta[j];
    if (d) { for (let i = 0; i < rs.length; i++) res[i] -= col[j][i] * d; beta[j] = nb; }
  }
  return beta;
}
const predict = (beta, r) => r.x.reduce((s, v, j) => s + v * beta[j], 0);
const r2of = (rs, beta) => { const m = rs.reduce((s, r) => s + r.W, 0) / rs.length; let a = 0, b = 0; for (const r of rs) { a += (r.W - predict(beta, r)) ** 2; b += (r.W - m) ** 2; } return 1 - a / b; };
const beta = fit(rows);
const wardCodes = [...new Set(rows.map((r) => r.ward))].sort();
const perWard = {};
if (wardCodes.length > 1) for (const wc of wardCodes) { // leave-ward-out only makes sense with more than one ward
  const inW = rows.filter((r) => r.ward === wc), bo = fit(rows.filter((r) => r.ward !== wc));
  const obs = inW.reduce((s, r) => s + r.W, 0), pin = inW.reduce((s, r) => s + predict(beta, r), 0), pout = inW.reduce((s, r) => s + predict(bo, r), 0);
  perWard[wc] = { chome: inW.length, workers: obs, r2InSample: +r2of(inW, beta).toFixed(3), r2LeaveWardOut: +r2of(inW, bo).toFixed(3), biasInSamplePct: +((pin / obs - 1) * 100).toFixed(1), biasLeaveWardOutPct: +((pout / obs - 1) * 100).toFixed(1) };
}
const totFa = Object.fromEntries(U.map((u) => [u, 0]));
for (const fa of agg.values()) for (const [u, v] of Object.entries(fa)) totFa[u] += v;
const r2 = +r2of(rows, beta).toFixed(3);
const coef = Object.fromEntries(U.map((u, j) => [u, +(beta[j] * 1000).toFixed(2)]));
fs.writeFileSync(T + `job-coefficients-${slug}.json`, JSON.stringify({
  formatVersion: 1, modeled: true, city: `${city.ja} (${wardCodes.length} ward${wardCodes.length > 1 ? "s" : ""})`,
  method: "Non-negative weighted least squares (weight 1/(workers+200)), chome workers ~ sum over 用途 of floor area, no intercept. Buildings assigned to chome by point-in-polygon; unsurveyed floor area = mesh footprint x learned floor/footprint ratio by height band.",
  sources: [`国土交通省 Project PLATEAU 3D都市モデル ${city.ja} (${city.year}年度), https://www.geospatial.jp/ckan/dataset/${city.dataset}; PDL1.0. Modified: extracted and aggregated by chome.`, `2021 Economic Census - Activity Survey, e-Stat (jobs-${city.pref}.json)`],
  buildingIds: stat.ids, floorAreaSurveyed: stat.surveyed, floorAreaEstimated: stat.estimated, floorRatioSource: stat.ratioSource, outsideChome: stat.outside, skippedNoFloorArea: stat.noArea,
  chomeUsed: rows.length, r2, perWard: wardCodes.length > 1 ? perWard : null,
  perWardNote: wardCodes.length > 1 ? "r2LeaveWardOut refits without that ward and scores on it (out-of-sample); bias = predicted/observed - 1 over the ward total." : "single unit (no wards): no leave-ward-out check is possible; r2 is in-sample.",
  useJobsPer1000m2: coef, useFloorAreaM2: Object.fromEntries(U.map((u) => [u, Math.round(totFa[u])])),
}, null, 1));

// ---- 2. distribute each chome's census total over its buildings ----
const UNKNOWN = coef["不明"] ?? (() => { const fa = U.reduce((s, u) => s + totFa[u], 0); return U.reduce((s, u) => s + coef[u] * totFa[u], 0) / fa; })();
const coefPerM2 = (use) => (use == null || use === "その他" ? UNKNOWN : coef[use] ?? UNKNOWN) / 1000; // その他 is a handful of buildings: over-fit, treat as unknown
const byChome = new Map();
for (const b of records) (byChome.get(b.chome) ?? byChome.set(b.chome, []).get(b.chome)).push(b);
const out = {}, tot = { chome: 0, workers: 0, noBuildingsChome: 0, noBuildingsWorkers: 0, listed: 0, surveyedWorkers: 0 };
let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
for (const [ci, a] of areas.entries()) {
  const W = jobs.areas[a.code]?.w;
  if (W == null) continue;
  const bs = byChome.get(ci);
  if (!bs?.length) { tot.noBuildingsChome++; tot.noBuildingsWorkers += W; continue; }
  const raw = bs.map((b) => b.floorM2 * coefPerM2(b.use));
  let sum = raw.reduce((s, v) => s + v, 0);
  const wts = sum > 0 ? raw : bs.map((b) => b.floorM2); // chome of only zero-coefficient uses: fall back to floor area
  if (sum <= 0) sum = wts.reduce((s, v) => s + v, 0);
  const exact = wts.map((v) => (v / sum) * W), fl = exact.map(Math.floor);
  let rem = W - fl.reduce((s, v) => s + v, 0);
  exact.map((v, i) => [v - fl[i], i]).sort((x, y) => y[0] - x[0]).slice(0, rem).forEach(([, i]) => fl[i]++);
  const list = [];
  bs.forEach((b, i) => {
    if (fl[i] < 1) return;
    list.push({ id: b.id, use: b.use, floor_m2: Math.round(b.floorM2), area_m2: Math.round(b.footprintM2), levels: b.storeys, basement_levels: b.basementLevels, floor_area_surveyed: b.surveyed, workers: fl[i], location: [b.lon, b.lat] });
    if (b.surveyed) tot.surveyedWorkers += fl[i];
    x0 = Math.min(x0, b.lon); x1 = Math.max(x1, b.lon); y0 = Math.min(y0, b.lat); y1 = Math.max(y1, b.lat);
  });
  out[a.code] = { name_ja: a.name_ja, workers_total: W, buildings: list };
  tot.chome++; tot.workers += W; tot.listed += list.length;
}
const doc = {
  formatVersion: 1,
  note: `MODELED, not measured: each chome's real 2021 Economic Census worker total (jobs-${city.pref}.json) distributed over ${city.ja}'s PLATEAU buildings by floor area x fitted workers-per-m2 for the building's 用途 (job-coefficients-${slug}.json). Floor area is the surveyed 延床面積 where the city's survey has it (floor_area_surveyed=true), otherwise mesh footprint x a floor/footprint ratio learned from surveyed buildings by height band (floor_area_surveyed=false). basement_levels is real survey data where present. Only buildings receiving >= 1 worker are listed. Source: 国土交通省 Project PLATEAU 3D都市モデル ${city.ja} (${city.year}年度), PDL1.0; modified.`,
  areas: out,
};
const json = JSON.stringify(doc), gz = zlib.gzipSync(json, { level: 9 });
fs.writeFileSync(T + `jobs-buildings-${slug}.json`, json);
fs.writeFileSync(T + `jobs-buildings-${slug}.json.gz`, gz);

// ---- 3. index + manifest ----
const idxPath = T + "plateau-jobs-index.json";
const idx = fs.existsSync(idxPath) ? JSON.parse(fs.readFileSync(idxPath, "utf8")) : { formatVersion: 1, note: "Cities with PLATEAU-based per-building workers (MODELED). Each entry's file holds the buildings; bbox = [minLon, minLat, maxLon, maxLat] of the listed buildings. surveyedWorkersShare = share of the city's workers landing on buildings whose floor area is surveyed (the rest use the learned-ratio estimate).", cities: [] };
const entry = {
  slug, ja: city.ja, ko: city.ko, file: `jobs-buildings-${slug}.json`, bbox: [x0, y0, x1, y1].map((v) => +v.toFixed(4)),
  chome: tot.chome, buildings: tot.listed, workers: tot.workers, unmatchedWorkers: tot.noBuildingsWorkers,
  r2, surveyedWorkersShare: +(tot.surveyedWorkers / tot.workers).toFixed(3), year: city.year, dataset: city.dataset,
};
idx.cities = [...idx.cities.filter((c) => c.slug !== slug), entry].sort((a, b) => a.slug.localeCompare(b.slug));
fs.writeFileSync(idxPath, JSON.stringify(idx, null, 1));

const mp = T + "manifest.json", raw0 = fs.readFileSync(mp, "utf8"), m = JSON.parse(raw0);
for (const k of Object.keys(m.files)) if (/^jobsBuildings[A-Z]/.test(k)) delete m.files[k]; // legacy per-city keys
m.files.plateauJobs = "plateau-jobs-index.json";
m.compressed = { ...m.compressed, [`jobs-buildings-${slug}.json`]: { file: `jobs-buildings-${slug}.json.gz`, encoding: "gzip", bytes: Buffer.byteLength(json), gzBytes: gz.length } };
const attr = "建物別従業者数 (plateau-jobs-index.json が指す jobs-buildings-<市>.json, job-coefficients-<市>.json): 国土交通省 Project PLATEAU 3D都市モデル (各市の年度・URLは plateau-jobs-index.json), PDL1.0. 加工: 建物属性を町丁別・用途別に集計し経済センサス従業者数と回帰、建物ごとに配分 (推定値)。";
m.data.attribution = m.data.attribution.filter((a) => !/PLATEAU/.test(a) || !/従業者/.test(a));
m.data.attribution.push(attr);
m.data.sources = m.data.sources.filter((s) => !/PLATEAU 3D都市モデル/.test(s.name));
m.data.sources.push({ name: "国土交通省 Project PLATEAU 3D都市モデル (per-city datasets listed in plateau-jobs-index.json)", url: "https://www.mlit.go.jp/plateau/open-data/", license: "PDL1.0 (commercial use and modification allowed, CC BY 4.0 compatible)" });
fs.writeFileSync(mp, JSON.stringify(m, null, 2) + (raw0.endsWith("\n") ? "\n" : ""));

console.log(JSON.stringify({ slug, ...entry, floorRatio: stat.ratioSource, surveyed: stat.surveyed, estimated: stat.estimated, jsonMB: +(json.length / 1e6).toFixed(1), gzMB: +(gz.length / 1e6).toFixed(1) }));
