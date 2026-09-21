// Build packs/tokyo/od.json: municipality-level home->work commuter flows (15歳以上就業者)
// from 令和2年国勢調査 従業地・通学地 第3表 (parsed by od-parse-2020.mjs into data-raw/od2020/od-<pref>.json).
// Origins/destinations are limited to the demand.json municipalities; commuters to anywhere else are kept as `out`.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const demand = JSON.parse(fs.readFileSync(`${root}packs/tokyo/demand.json`, 'utf8'));
const code = p => p.jisCode ? String(p.jisCode).slice(0, 5) : p.code;
const codes = new Set(demand.points.map(code));
const raw = {};
for (const pf of [11, 12, 13, 14]) Object.assign(raw, JSON.parse(fs.readFileSync(`${root}data-raw/od2020/od-${pf}.json`, 'utf8')).origins);
const origins = {};
let flows = 0, outTotal = 0, all = 0;
for (const p of demand.points) {
  const c = code(p), r = raw[c];
  if (!r) throw new Error(`no OD origin for ${c} ${p.name}`);
  const dest = {}; let out = 0;
  for (const [d, n] of Object.entries(r.dest)) { if (codes.has(d) && d !== c) { dest[d] = n; flows++; } else if (d !== c) out += n; }
  // The census books workers with unknown/foreign workplace to the home municipality, inside the 他市区町村 group under the
  // origin's own code; keep them as `unknown` so that self + unknown + out + sum(dest) === workers.
  origins[c] = { workers: r.self + Object.values(r.dest).reduce((a, b) => a + b, 0), self: r.self, home: r.home, unknown: r.dest[c] ?? 0, out, dest };
  outTotal += out; all += origins[c].workers;
}
const json = {
  formatVersion: 1,
  source: '令和2年国勢調査 従業地・通学地による人口・就業状態等集計 第3表 (常住地), 総務省統計局 / e-Stat',
  unit: '15歳以上就業者 (通学者を除く), 人',
  note: 'workers = self + unknown + out + sum(dest). self: 自市区町村内(うち自宅 home) / dest: 領域内の他市区町村コード別 / out: 領域外 / unknown: 従業地不詳・外国 (統計局注記により常住市区町村に計上).',
  origins,
};
fs.writeFileSync(`${root}packs/tokyo/od.json`, JSON.stringify(json));
console.log({ origins: Object.keys(origins).length, flows, workers: all, outShare: (outTotal / all).toFixed(4) });
