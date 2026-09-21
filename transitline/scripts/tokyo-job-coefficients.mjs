// Derive per-use job coefficients for the Tokyo pack and re-distribute jobs-buildings.json.
// Usage: node scripts/tokyo-job-coefficients.mjs <path to R03建物現況.dbf>
// Data: Tokyo Metropolitan Govt Land Use Survey R3 (23 wards, building-level use + floors, CC BY 4.0)
//       x 2021 Economic Census workers per chome (packs/tokyo/jobs.json).
// Method: non-negative weighted least squares of chome workers on chome floor area (footprint x
//         above-ground floors) by survey use class; then workers per m2 by class -> OSM kind mapping.
import fs from "fs";
import { fileURLToPath } from "url";
import { readDbf } from "./tokyo-lu-dbf.mjs";
const T = fileURLToPath(new URL("../packs/tokyo/", import.meta.url));
const dbf = process.argv[2];
if (!dbf) throw new Error("pass path to R03建物現況.dbf");
const U = [111,112,113,114,121,122,123,124,125,131,132,141,142,143,150];

// 1. aggregate floor area by chome x use class
const agg = {};
for (const r of readDbf(dbf)) {
  if (!(r.BV_3 > 0) || r.BV_6 < 111 || r.BV_6 > 150) continue;
  const key = String(r.CODE5).slice(0, 5) + "|" + r.NAME2;
  const o = (agg[key] ??= { n: 0, fa: {} });
  o.n++; o.fa[r.BV_6] = (o.fa[r.BV_6] || 0) + r.AREA * r.BV_3;
}
// 2. join to census workers (skip names that are ambiguous within a ward)
const rd = (f) => JSON.parse(fs.readFileSync(T + f, "utf8"));
const sw = rd("subward.json"), jobs = rd("jobs.json");
const seen = {};
for (const w of Object.values(sw.wards)) for (const a of w.areas) { const k = w.estat_code + "|" + a.name_ja; seen[k] = (seen[k] || 0) + 1; }
const rows = [];
for (const w of Object.values(sw.wards)) for (const a of w.areas) {
  const k = w.estat_code + "|" + a.name_ja;
  if (seen[k] > 1 || !agg[k] || !jobs.areas[a.code]) continue;
  rows.push({ code: a.code, key: k, W: jobs.areas[a.code].w, x: U.map((u) => agg[k].fa[u] || 0) });
}
// 3. weighted NNLS by coordinate descent (weight 1/(W+200))
const p = U.length, wt = rows.map((r) => 1 / (r.W + 200));
const beta = new Array(p).fill(0.01), col = U.map((_, j) => rows.map((r) => r.x[j]));
const res = rows.map((r) => r.W - r.x.reduce((s, v, j) => s + v * beta[j], 0));
for (let it = 0; it < 3000; it++) for (let j = 0; j < p; j++) {
  let num = 0, den = 0;
  for (let i = 0; i < rows.length; i++) { const x = col[j][i]; num += wt[i] * x * (res[i] + x * beta[j]); den += wt[i] * x * x; }
  const nb = den > 0 ? Math.max(0, num / den) : 0, d = nb - beta[j];
  if (d) { for (let i = 0; i < rows.length; i++) res[i] -= col[j][i] * d; beta[j] = nb; }
}
const mean = rows.reduce((s, r) => s + r.W, 0) / rows.length;
let ssr = 0, sst = 0;
rows.forEach((r) => { const pr = r.x.reduce((s, v, j) => s + v * beta[j], 0); ssr += (r.W - pr) ** 2; sst += (r.W - mean) ** 2; });
const B = Object.fromEntries(U.map((u, j) => [u, beta[j]]));
const totFa = {}; for (const c of Object.values(agg)) for (const [u, v] of Object.entries(c.fa)) totFa[u] = (totFa[u] || 0) + v;
const blend = (us) => us.reduce((s, u) => s + B[u] * totFa[u], 0) / us.reduce((s, u) => s + totFa[u], 0);

// 4. OSM sourceKind -> workers per m2 of floor area
const KIND = {
  office: B[121], commercial: blend([121, 122, 123]), "commercial;hotel": blend([121, 122, 123, 124]),
  retail: B[122], shop: B[122], service: B[122], hotel: B[124],
  school: B[112], kindergarten: B[112], university: B[112], college: B[112], museum: B[112], church: B[112], temple: B[112],
  shrine: B[112], chapel: B[112], convent: B[112], religious: B[112], concert_hall: B[112],
  hospital: B[113], public: B[111], "yes;public": B[111], government: B[111], civic: B[111], fire_station: B[111],
  sports_hall: B[125], industrial: B[141], manufacture: B[141], warehouse: B[143], barn: B[143],
  train_station: B[143], transportation: B[143],
  detached: B[131], house: B[131], terrace: B[131], allotment_house: B[131],
  apartments: B[131], residential: B[131], dormitory: B[131], // fitted 132 is 0 (ground-floor shops sit in survey class 123); use the fitted home-based figure instead
  roof: 0, carport: 0, mechanical_lifts: 0, boathouse: 0, ruins: 0,
};
// untagged ("yes"): local survey-derived average of that chome, else city-wide average
const cityAvg = blend(U);
const localAvg = (key) => { const c = agg[key]; if (!c) return cityAvg; let f = 0, w = 0; for (const [u, v] of Object.entries(c.fa)) { f += v; w += B[u] * v; } return f > 0 ? w / f : cityAvg; };
const keyOf = {}; for (const r of rows) keyOf[r.code] = r.key;
for (const w of Object.values(sw.wards)) for (const a of w.areas) { const k = w.estat_code + "|" + a.name_ja; if (!keyOf[a.code] && agg[k] && seen[k] === 1) keyOf[a.code] = k; }

// 5. redistribute
const jb = rd("jobs-buildings.json");
let unmapped = new Set();
for (const [code, area] of Object.entries(jb.areas)) {
  const coef = (b) => { const c = KIND[b.sourceKind]; if (c !== undefined) return c; if (b.sourceKind === "yes") return localAvg(keyOf[code]); unmapped.add(b.sourceKind); return cityAvg; };
  const raw = area.buildings.map((b) => { b.jobs_per_1000m2 = +(coef(b) * 1000).toFixed(2); return b.area_m2 * b.levels * coef(b); });
  let sum = raw.reduce((s, v) => s + v, 0);
  const wts = sum > 0 ? raw : area.buildings.map((b) => b.area_m2); if (sum <= 0) sum = wts.reduce((s, v) => s + v, 0);
  const exact = wts.map((v) => (v / sum) * area.workers_total), fl = exact.map(Math.floor);
  let rem = area.workers_total - fl.reduce((s, v) => s + v, 0);
  exact.map((v, i) => [v - fl[i], i]).sort((a, b) => b[0] - a[0]).slice(0, rem).forEach(([, i]) => fl[i]++);
  area.buildings.forEach((b, i) => (b.workers = fl[i]));
}
jb.note = "MODELED, not measured: each chome's real 2021 Economic Census worker total distributed over real OSM building footprints by floor area (footprint x levels; levels default 1 when OSM has no tag, except Marunouchi 1-chome which uses the chome median) x jobs-per-m2 coefficient by building use. Coefficients (jobs_per_1000m2 on each building, table in job-coefficients.json) are fitted from Tokyo's 2021 Land Use Survey floor areas vs Economic Census workers across ~3,100 chome (see README).";
fs.writeFileSync(T + "jobs-buildings.json", JSON.stringify(jb));
fs.writeFileSync(T + "job-coefficients.json", JSON.stringify({
  formatVersion: 1, modeled: true,
  method: "Non-negative weighted least squares (weight 1/(workers+200)), chome workers ~ sum over survey use class of (footprint x above-ground floors), no intercept.",
  sources: ["Tokyo Metropolitan Government Urban Development Bureau, Land Use Survey R3 (2021), 23 wards, building data (CC BY 4.0)", "2021 Economic Census - Activity Survey, e-Stat table 32-1-13 (jobs.json)"],
  chomeUsed: rows.length, r2: +(1 - ssr / sst).toFixed(3),
  surveyClassJobsPer1000m2: Object.fromEntries(U.map((u) => [u, +(B[u] * 1000).toFixed(2)])),
  osmKindJobsPer1000m2: Object.fromEntries(Object.entries(KIND).map(([k, v]) => [k, +(v * 1000).toFixed(2)])),
  untaggedYes: "per-chome floor-area-weighted average of survey classes; city-wide fallback " + (cityAvg * 1000).toFixed(2),
  surveyClassCodes: { 111: "government", 112: "education/culture", 113: "health/medical", 114: "utilities", 121: "office", 122: "commercial only", 123: "mixed residential-commercial", 124: "lodging/entertainment", 125: "sports/venues", 131: "detached housing", 132: "apartments", 141: "factory", 142: "factory-residence mix", 143: "warehouse/transport", 150: "agri/fishery" },
}, null, 1));
console.log("chome", rows.length, "R2", (1 - ssr / sst).toFixed(3), "unmapped", [...unmapped]);
