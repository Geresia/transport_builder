// Extract 常住人口 (night) and 昼間人口 (day) per municipality from 令和2年国勢調査 従業地・通学地 第1-1表 (e-Stat statInfId 000032214141).
// Usage: node muni-pop-2020.mjs <sheet1.xml> <sharedStrings.xml> <out.json>   (rows: 男女=総数, 年齢=総数)
import fs from 'node:fs';
import { writeChecked } from './safe-write.mjs';
const [sheetP, ssP, outP] = process.argv.slice(2);
const strs = [...fs.readFileSync(ssP, 'utf8').matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m => m[1].replace(/<[^>]+>/g, ''));
const s = fs.readFileSync(sheetP, 'utf8'), out = {};
for (const row of s.split('</row>')) {
  const c = {};
  for (const m of row.matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>(?:<v>([^<]*)<\/v>)?<\/c>)/g)) if (m[3] !== undefined) c[m[1]] = /t="s"/.test(m[2]) ? strs[+m[3]] : m[3];
  if (c.D !== '0_総数' || c.E !== '00_総数') continue;
  const mm = (c.C || '').match(/^(\d{5})_(.*)$/); if (!mm) continue;
  out[mm[1]] = { name: mm[2], night: Number(c.F), day: Number(c.R) };
}
writeChecked(outP, JSON.stringify(out), { label: 'municipalities', count: (j) => Object.keys(j).length });
console.log('municipalities', Object.keys(out).length);
