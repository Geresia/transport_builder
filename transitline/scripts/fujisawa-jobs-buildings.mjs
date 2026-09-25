// Distribute each Fujisawa City chome's real 2021 Economic Census worker total over its PLATEAU buildings,
// weighted by floor area x fitted jobs-per-m2 for the building's 用途 (job-coefficients-fujisawa.json).
// Usage: node scripts/fujisawa-jobs-buildings.mjs <plateau-fujisawa.json>
// Output: packs/tokyo/jobs-buildings-fujisawa.json (+ .gz, registered in manifest). Same shape as jobs-buildings.json:
// areas[chome code] = { name_ja, workers_total, buildings[] }. Only buildings that receive >= 1 worker are listed.
// MODELED: chome totals are measured, the split among buildings is not. Because each chome is normalized to its
// census total, the coefficient bias seen in job-coefficients-fujisawa.json affects the split, never the total.
import fs from "fs";
import zlib from "zlib";
import { fileURLToPath } from "url";
import { readPackJson } from "./pack-json.mjs";
import { chomeIndex, buildingRecords } from "./plateau-chome.mjs";

const T = fileURLToPath(new URL("../packs/tokyo/", import.meta.url));
const src = process.argv[2];
if (!src) throw new Error("pass path to plateau-fujisawa.json");
const rows = JSON.parse(fs.readFileSync(src, "utf8"));
const sw = readPackJson(T + "subward-kanagawa.json"), jobs = readPackJson(T + "jobs-kanagawa.json");
const coefFile = JSON.parse(fs.readFileSync(T + "job-coefficients-fujisawa.json", "utf8"));
const UNKNOWN = coefFile.useJobsPer1000m2["不明"];
// その他 (17 buildings, ~0 m2) fitted to an absurd 832; treat it like an unknown use
const coefPerM2 = (use) => (use == null || use === "その他" ? UNKNOWN : coefFile.useJobsPer1000m2[use] ?? UNKNOWN) / 1000;

const { areas, locate } = chomeIndex(sw.wards, 14205, 14205);
const { records, stat } = buildingRecords(rows, locate);
const byChome = new Map();
for (const b of records) (byChome.get(b.chome) ?? byChome.set(b.chome, []).get(b.chome)).push(b);

const out = {}, tot = { chome: 0, workers: 0, noBuildings: 0, noBuildingsWorkers: 0, censusOnly: 0, listed: 0 };
for (const [ci, a] of areas.entries()) {
  const W = jobs.areas[a.code]?.w;
  if (W == null) continue;
  const bs = byChome.get(ci);
  if (!bs?.length) { tot.noBuildings++; tot.noBuildingsWorkers += W; continue; }
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
  });
  out[a.code] = { name_ja: a.name_ja, workers_total: W, buildings: list };
  tot.chome++; tot.workers += W; tot.listed += list.length;
}
const doc = {
  formatVersion: 1,
  note: "MODELED, not measured: each chome's real 2021 Economic Census worker total (jobs-kanagawa.json) distributed over Fujisawa City's PLATEAU buildings by floor area x fitted workers-per-m2 for the building's 用途 (job-coefficients-fujisawa.json). Floor area is the surveyed 延床面積 (survey year varies (2025 export)) or, for unsurveyed buildings, mesh footprint x round(height/3 m) (floor_area_surveyed=false). Only buildings receiving >= 1 worker are listed. `basement_levels` (地下階数) is real survey data where present, null where the survey left it blank - Saitama's own file has no such field at all. Source: 国土交通省 Project PLATEAU 3D都市モデル 藤沢市 (2025年度), PDL1.0; modified.",
  areas: out,
};
const json = JSON.stringify(doc);
fs.writeFileSync(T + "jobs-buildings-fujisawa.json", json);
const gz = zlib.gzipSync(json, { level: 9 });
fs.writeFileSync(T + "jobs-buildings-fujisawa.json.gz", gz);
const mp = T + "manifest.json", m = JSON.parse(fs.readFileSync(mp, "utf8"));
m.files.jobsBuildingsFujisawa = "jobs-buildings-fujisawa.json";
m.compressed = { ...m.compressed, "jobs-buildings-fujisawa.json": { file: "jobs-buildings-fujisawa.json.gz", encoding: "gzip", bytes: Buffer.byteLength(json), gzBytes: gz.length } };
fs.writeFileSync(mp, JSON.stringify(m, null, 2) + "\n");
console.log({ ...tot, buildingRecords: records.length, stat, jsonMB: +(json.length / 1e6).toFixed(1), gzMB: +(gz.length / 1e6).toFixed(1) });
