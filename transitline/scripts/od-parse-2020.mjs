// Parse 令和2年国勢調査 従業地・通学地 第3表 (常住地 x 従業地・通学地, 市区町村) xlsx -> compact JSON.
// Usage: node od-parse-2020.mjs <sheet1.xml> <sharedStrings.xml> <out.json> [originPrefix...]
// Output: { origins: { "13101": { self: N, home: N, dest: { "13102": N, ... } } } } workers (15歳以上就業者) only.
import fs from 'node:fs';
const [sheetP, ssP, outP, ...pref] = process.argv.slice(2);
const ss = fs.readFileSync(ssP, 'utf8');
const strs = [...ss.matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m => m[1].replace(/<[^>]+>/g, ''));
const code = s => (s || '').match(/^(\d{5})_/)?.[1];
const out = {}, names = {};
const fd = fs.openSync(sheetP, 'r');
const buf = Buffer.alloc(1 << 24);
let carry = '', pos = 0, n;
const cellRe = /<c r="([A-Z]+)\d+"[^>]*?(?:t="s"[^>]*)?(?:\/>|>(?:<v>([^<]*)<\/v>)?<\/c>)/g;
function handleRow(row) {
  const cells = {};
  for (const m of row.matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>(?:<v>([^<]*)<\/v>)?<\/c>)/g)) {
    if (m[3] === undefined) continue;
    cells[m[1]] = /t="s"/.test(m[2]) ? strs[+m[3]] : m[3];
  }
  if (cells.A !== '0_総数') return;
  const o = code(cells.D); if (!o) return;
  if (pref.length && !pref.some(p => o.startsWith(p))) return;
  const w = Number(cells.L); if (!Number.isFinite(w)) return;
  const f = cells.F || '', d = code(cells.I);
  const rec = out[o] ??= { self: 0, home: 0, dest: {} };
  if (cells.E === '2' && f.startsWith('01_')) rec.self = w;           // 自市区町村で従業
  else if (cells.E === '3' && f.startsWith('011_')) rec.home = w;      // うち自宅
  else if (cells.E === '2' && f.startsWith('02_') && d && d !== '00000') {
    const nm = (cells.I || '').slice(6);
    names[d] = nm;
    rec.dest[d] = w;
  }
}
while ((n = fs.readSync(fd, buf, 0, buf.length, pos)) > 0) {
  pos += n;
  const s = carry + buf.toString('utf8', 0, n);
  const parts = s.split('</row>');
  carry = parts.pop();
  for (const p of parts) { const i = p.lastIndexOf('<row '); if (i >= 0) handleRow(p.slice(i)); }
}
// drop aggregate destinations (prefecture xx000, designated-city parents, 特別区部) to avoid double counting
const agg = new Set(Object.keys(names).filter(c => c.endsWith('000') || names[c] === '特別区部' ||
  Object.keys(names).some(o => o !== c && o.slice(0, 3) === c.slice(0, 3) && names[o].startsWith(names[c]) && names[o].length > names[c].length)));
for (const r of Object.values(out)) for (const c of Object.keys(r.dest)) if (agg.has(c)) delete r.dest[c];
fs.writeFileSync(outP, JSON.stringify({ source: '令和2年国勢調査 従業地・通学地 第3表', unit: '15歳以上就業者', origins: out }));
console.log('origins', Object.keys(out).length);
