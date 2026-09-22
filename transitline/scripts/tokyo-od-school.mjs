// Build packs/tokyo/od-school.json: municipality-level home->school commuter flows, ALL AGES
// (column N, "15歳未満を含む通学者" - the census table's own all-ages reference figure, chosen over
// the 15+-only column M so this counts every student, not just high-school/university), from the same
// 令和2年国勢調査 従業地・通学地 第3表 as od.json (COL=N node od-parse-2020.mjs ... ->
// data-raw/od2020/od-school-<pref>.json). Structure mirrors tokyo-od.mjs's od.json exactly, one field
// renamed (workers -> students) - see that file for the field meanings (self/home/unknown/out/dest).
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { writeChecked } from './safe-write.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));
const demand = JSON.parse(fs.readFileSync(`${root}packs/tokyo/demand.json`, 'utf8'));
const code = p => p.jisCode ? String(p.jisCode).slice(0, 5) : p.code;
const codes = new Set(demand.points.map(code));
const raw = {};
for (const pf of [11, 12, 13, 14]) Object.assign(raw, JSON.parse(fs.readFileSync(`${root}data-raw/od2020/od-school-${pf}.json`, 'utf8')).origins);
const origins = {};
let flows = 0, outTotal = 0, all = 0, skipped = 0;
for (const p of demand.points) {
  const c = code(p), r = raw[c];
  if (!r) { skipped++; continue; } // island municipalities (e.g. 御蔵島村) that demand.json itself excludes can be missing here too
  const dest = {}; let out = 0;
  for (const [d, n] of Object.entries(r.dest)) { if (codes.has(d) && d !== c) { dest[d] = n; flows++; } else if (d !== c) out += n; }
  origins[c] = { students: r.self + Object.values(r.dest).reduce((a, b) => a + b, 0), self: r.self, home: r.home, unknown: r.dest[c] ?? 0, out, dest };
  outTotal += out; all += origins[c].students;
}
const json = {
  formatVersion: 1,
  source: '令和2年国勢調査 従業地・通学地による人口・就業状態等集計 第3表 (常住地), 総務省統計局 / e-Stat',
  unit: '通学者 (15歳未満を含む全年齢), 人',
  note: 'students = self + unknown + out + sum(dest). Same table and field meanings as od.json (workers), column N (R1_（別掲）15歳未満通学者を含む通学者) instead of L (11_15歳以上就業者) - all-ages, so elementary/junior-high pupils are included, not just 15+. self: 自市区町村内(うち自宅 home) / dest: 領域内の他市区町村コード別 / out: 領域外 / unknown: 通学地不詳・外国 (統計局注記により常住市区町村に計上).',
  origins,
};
writeChecked(`${root}packs/tokyo/od-school.json`, JSON.stringify(json), { label: 'school O/D flows', count: (j) => Object.values(j.origins).reduce((t, o) => t + Object.keys(o.dest).length, 0) });
console.log({ origins: Object.keys(origins).length, skipped, flows, students: all, outShare: (outTotal / all).toFixed(4) });
