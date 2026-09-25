// Fit workers-per-floor-area coefficients by building use for Kamakura City (single), same method as
// tokyo-job-coefficients.mjs but with PLATEAU buildings (per-building 用途 / 地上階数 / 延床面積, survey 2015).
// Usage: node scripts/kamakura-job-coefficients.mjs <plateau-kamakura.json from plateau-buildings.mjs>
// Buildings are assigned to chome by point-in-polygon (subward-kanagawa.json polygons), not by name.
// Buildings are grouped by 建物ID (survey attributes repeat on every 枝番 part; counting parts double-counts).
// Floor area = 延床面積 when surveyed, else mesh footprint (plateau-footprint.mjs) x round(計測高さ / 3 m).
// Buildings with no 用途 form their own class ("不明"). Fit: chome census workers (jobs-kanagawa.json)
// ~ sum over 用途 of floor area, non-negative weighted least squares (weight 1/(W+200)), no intercept.
// Output: packs/tokyo/job-coefficients-kamakura.json (coefficients only; building rows are not redistributed).
import fs from "fs";
import { fileURLToPath } from "url";
import { readPackJson } from "./pack-json.mjs";
import { chomeIndex, buildingRecords } from "./plateau-chome.mjs";

const T = fileURLToPath(new URL("../packs/tokyo/", import.meta.url));
const src = process.argv[2];
if (!src) throw new Error("pass path to plateau-kamakura.json");
const bld = JSON.parse(fs.readFileSync(src, "utf8")); // rows: see plateau-buildings.mjs
const sw = readPackJson(T + "subward-kanagawa.json"), jobs = readPackJson(T + "jobs-kanagawa.json");

const { areas, locate } = chomeIndex(sw.wards, 14204, 14204);
const { records, stat } = buildingRecords(bld, locate);
const byId = { size: stat.ids }, { surveyed, estimated, outside, noArea } = stat;
const agg = new Map(), useSet = new Set();
for (const b of records) {
  const cls = b.use ?? "不明";
  useSet.add(cls);
  const o = agg.get(b.chome) ?? agg.set(b.chome, {}).get(b.chome);
  o[cls] = (o[cls] ?? 0) + b.floorM2;
}
const used = surveyed + estimated;
const U = [...useSet].sort();
const rows = [];
for (const [id, fa] of agg) {
  const W = jobs.areas[areas[id].code]?.w;
  if (W == null) continue;
  rows.push({ code: areas[id].code, ward: areas[id].ward, W, x: U.map((u) => fa[u] ?? 0) });
}

// --- weighted NNLS by coordinate descent (identical to the Tokyo fit) ---
const p = U.length;
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

const perWard = {};
for (const wc of [...new Set(rows.map((r) => r.ward))].sort()) {
  const inW = rows.filter((r) => r.ward === wc), outW = rows.filter((r) => r.ward !== wc), bo = fit(outW);
  const obs = inW.reduce((s, r) => s + r.W, 0), pin = inW.reduce((s, r) => s + predict(beta, r), 0), pout = inW.reduce((s, r) => s + predict(bo, r), 0);
  perWard[wc] = { chome: inW.length, workers: obs, r2InSample: +r2of(inW, beta).toFixed(3), r2LeaveWardOut: +r2of(inW, bo).toFixed(3), biasInSamplePct: +((pin / obs - 1) * 100).toFixed(1), biasLeaveWardOutPct: +((pout / obs - 1) * 100).toFixed(1) };
}
const totFa = Object.fromEntries(U.map((u) => [u, 0]));
for (const fa of agg.values()) for (const [u, v] of Object.entries(fa)) totFa[u] += v;

const result = {
  formatVersion: 1, modeled: true, city: "Kamakura City (single)",
  method: "Non-negative weighted least squares (weight 1/(workers+200)), chome workers ~ sum over 用途 of floor area, no intercept. Buildings assigned to chome by point-in-polygon.",
  sources: [
    "国土交通省 Project PLATEAU 3D都市モデル 鎌倉市 (2024年度), building attributes from the city's 都市計画基礎調査 建物利用現況 (survey year varies (2024 export)); PDL1.0. Modified: extracted and aggregated by chome.",
    "2021 Economic Census - Activity Survey, e-Stat table 32-1-11 (jobs-kanagawa.json)",
  ],
  parts: bld.length, buildingIds: stat.ids, buildingsUsed: used, floorAreaSurveyed: surveyed, floorAreaEstimatedFromMeshAndHeight: estimated, outsideKamakuraCityChome: outside, skippedNoFloorArea: noArea,
  chomeUsed: rows.length, chomeWithJobs: Object.keys(jobs.areas).length,
  r2: +r2of(rows, beta).toFixed(3), perWard,
  perWardNote: "r2LeaveWardOut refits without that ward and scores on it (out-of-sample); bias = predicted/observed - 1 over the ward total. Judge extending the coefficients by these, not the in-sample R2.",
  useJobsPer1000m2: Object.fromEntries(U.map((u, j) => [u, +(beta[j] * 1000).toFixed(2)])),
  useFloorAreaM2: Object.fromEntries(U.map((u) => [u, Math.round(totFa[u])])),
};
fs.writeFileSync(T + "job-coefficients-kamakura.json", JSON.stringify(result, null, 1));
console.log({ ids: byId.size, surveyed, estimated, outside, noArea, chome: rows.length, r2: result.r2 });
console.log("jobs/1000m2", result.useJobsPer1000m2);
console.table(perWard);
