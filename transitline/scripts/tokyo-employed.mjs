// Employed residents (15+) per chome for the four prefectures, from 令和2年国勢調査 小地域集計 第16-2表
// 男女，従業地・通学地別就業者数（15歳以上）－町丁・字等 (e-Stat statInfId 000032226887/888/889/890 = Saitama/Chiba/Tokyo/Kanagawa, fileKind=1 CSV,
// Shift-JIS, saved as data-raw/emp2020/h16_02_<pref>.csv). Output: packs/tokyo/employed.json
//
// The census hides small cells ("X", 秘匿処理). A hidden chome's count is folded into a designated surviving chome (合算地域あり);
// we split that combined total over the group in proportion to residents (largest remainder) and list those chomes under `estimated`.
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { readPackJson } from "./pack-json.mjs";
import { writeChecked } from "./safe-write.mjs";
const T = fileURLToPath(new URL("../packs/tokyo/", import.meta.url));
const RAW = fileURLToPath(new URL("../data-raw/emp2020/", import.meta.url));

function csvRow(line) {
  const o = []; let i = 0;
  while (i <= line.length) {
    if (line[i] === '"') { let j = i + 1, s = ""; while (j < line.length) { if (line[j] === '"') { if (line[j + 1] === '"') { s += '"'; j += 2; continue; } break; } s += line[j++]; } o.push(s); i = j + 2; }
    else { const j = line.indexOf(",", i), k = j < 0 ? line.length : j; o.push(line.slice(i, k)); i = k + 1; }
  }
  return o;
}
const num = (s) => (s === "-" ? 0 : /^\d+$/.test(s) ? Number(s) : null); // null = hidden (X)

// residents per chome from the pack's own sub-ward layers (needed to split hidden groups)
const residents = new Map(), packAreas = new Set();
for (const f of ["subward.json", "subward-kanagawa.json", "subward-saitama.json", "subward-chiba.json"])
  for (const w of Object.values(readPackJson(T + f).wards)) for (const a of w.areas) { residents.set(a.code, a.residents || 0); packAreas.add(a.code); }

const areas = {}, estimated = [], municipalities = {};
let hiddenGroups = 0;
for (const pref of [11, 12, 13, 14]) {
  const rows = new TextDecoder("shift_jis").decode(fs.readFileSync(`${RAW}h16_02_${pref}.csv`)).split(/\r?\n/).map(csvRow).filter((r) => r[1] === "総数" && r[2]);
  const byCode = new Map();
  for (const r of rows) {
    const code = r[2] + (r[3] === "-" ? "" : r[3]);
    byCode.set(code, r);
    if (r[3] === "-") municipalities[r[2]] = { employed: num(r[12]), unstated: num(r[21]) }; // municipality total row; 従業地・通学地「不詳」
  }
  const hiddenBy = new Map(); // surviving code -> hidden member codes
  for (const r of rows) if (r[5] === "秘匿地域") { const surv = r[2] + r[6]; (hiddenBy.get(surv) ?? hiddenBy.set(surv, []).get(surv)).push(r[2] + r[3]); }
  // 1) ordinary chomes
  for (const [code, r] of byCode) {
    if (!packAreas.has(code) || r[12] === "X" || hiddenBy.has(code)) continue;
    areas[code] = num(r[12]);
  }
  // 2) hidden groups. The surviving row carries the group's published total; it may itself be a chome (then it is a member) or a
  //    町-level aggregate (e.g. 永田町 = 一丁目 + 二丁目) that the pack does not have. Members = survivor (if in the pack) + hidden chomes.
  for (const [surv, hidden] of hiddenBy) {
    const r = byCode.get(surv); if (!r || num(r[12]) === null) continue;
    const total = num(r[12]);
    hiddenGroups++;
    const group = [...new Set([surv, ...hidden])].filter((c) => packAreas.has(c));
    if (!group.length) continue;
    const w = group.map((c) => residents.get(c) || 0), wsum = w.reduce((x, y) => x + y, 0);
    const share = group.map((_, i) => (wsum > 0 ? w[i] / wsum : 1 / group.length));
    const exact = share.map((p) => total * p), fl = exact.map(Math.floor);
    let rem = total - fl.reduce((x, y) => x + y, 0);
    exact.map((v, i) => [v - fl[i], i]).sort((x, y) => y[0] - x[0]).slice(0, rem).forEach(([, i]) => fl[i]++);
    group.forEach((c, i) => { areas[c] = fl[i]; estimated.push(c); });
  }
}
const missing = [...packAreas].filter((c) => areas[c] === undefined);
// municipality sums must reproduce the census municipality row
const sums = {};
for (const [c, e] of Object.entries(areas)) { const m = c.slice(0, 5); sums[m] = (sums[m] || 0) + e; }
const bad = Object.entries(sums).filter(([m, s]) => municipalities[m] && municipalities[m].employed !== s);
writeChecked(T + "employed.json", JSON.stringify({
  formatVersion: 1,
  source: "令和2年国勢調査 小地域集計 第16-2表 男女，従業地・通学地別就業者数（15歳以上）－町丁・字等 (e-Stat), 総務省統計局",
  unit: "employed residents aged 15+, by place of residence (常住地); 総数(男女)",
  note: "areas: chome code (same codes as subward*.json) -> employed residents. estimated: chomes whose census cell is hidden and folded into a neighbouring chome; their value is that group's published total split by residents. municipalities: 5-digit code -> census municipality total and workers whose workplace is not stated.",
  areas, estimated: [...new Set(estimated)].sort(), municipalities,
}), { label: "chomes", count: (j) => Object.keys(j.areas).length });
console.log({ areas: Object.keys(areas).length, packAreas: packAreas.size, missing: missing.length, estimated: new Set(estimated).size, hiddenGroups, municipalityMismatches: bad.length, sample: bad.slice(0, 5) });
