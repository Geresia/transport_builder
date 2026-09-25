// Workers per chome for Tokyo's 30 Tama-area municipalities -> packs/tokyo/jobs-tama.json (same shape as jobs.json).
// Source: 令和3年経済センサス‐活動調査 第32-1-13表 経営組織(5区分)別全事業所数及び従業者数－市区町村、町丁・大字 (e-Stat statInfId 000040068157,
// b2_032-1_13.xlsx, cached in data-raw/tama/). The table names towns, not codes, so rows are matched to subward-tama.json by name:
// full-width digits / kanji chome numerals / ヶ-ケ spelling normalised, a name that several chomes share is split by area, a row that
// names a whole 町 while the census-area layer has 丁目 under it is split over those 丁目 by area. Workers are 総数 (private + national/local
// government), by workplace. What does not match is reported, not invented; the script refuses to write below 98% matched.
// Usage: node scripts/tama-jobs.mjs
import fs from "node:fs";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { readPackJson } from "./pack-json.mjs";
import { writeChecked } from "./safe-write.mjs";
const T = fileURLToPath(new URL("../packs/tokyo/", import.meta.url));
const RAW = fileURLToPath(new URL("../data-raw/tama/", import.meta.url));
fs.mkdirSync(RAW, { recursive: true });
const XLSX = RAW + "b2_032-1_13.xlsx";
if (!fs.existsSync(XLSX)) {
  const r = await fetch("https://www.e-stat.go.jp/stat-search/file-download?statInfId=000040068157&fileKind=0");
  if (!r.ok) throw new Error(`e-Stat download: HTTP ${r.status}`);
  fs.writeFileSync(XLSX, Buffer.from(await r.arrayBuffer()));
}

// ---- minimal xlsx reader (zip central directory + raw inflate), no dependency ----
function unzip(buf) {
  let e = buf.length - 22;
  while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0) throw new Error("not a zip file");
  const n = buf.readUInt16LE(e + 10);
  let p = buf.readUInt32LE(e + 16);
  const files = {};
  for (let i = 0; i < n; i++) {
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), nl = buf.readUInt16LE(p + 28), xl = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nl);
    const lho = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
    const data = buf.subarray(lho, lho + csize);
    files[name] = () => (method === 0 ? data : zlib.inflateRawSync(data)).toString("utf8");
    p += 46 + nl + xl + cl;
  }
  return files;
}
const z = unzip(fs.readFileSync(XLSX));
const strs = [...z["xl/sharedStrings.xml"]().matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join(""));
const rows = [...z["xl/worksheets/sheet1.xml"]().matchAll(/<row [^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)].map((r) => {
  const o = {};
  for (const c of r[2].matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const v = (c[3] || "").match(/<v>([\s\S]*?)<\/v>/);
    if (v) o[c[1]] = /t="s"/.test(c[2]) ? strs[+v[1]] : v[1];
  }
  return o;
});
// columns: B municipality code, E town name (empty on the municipality total row), F 事業所数 総数, G 従業者数 総数
if (!rows.some((o) => o.A === "13100_東京都特別区部")) throw new Error("unexpected sheet layout");

// ---- name normalisation ----
const KD = { 〇: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
function kanjiNum(s) {
  if (s.includes("十")) { const [a, b] = s.split("十"); return (a ? KD[a] : 1) * 10 + (b ? KD[b] : 0); }
  return [...s].reduce((n, c) => n * 10 + KD[c], 0);
}
const norm = (s) => s
  .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
  .replace(/[〇一二三四五六七八九十]+(?=丁目)/g, (m) => String(kanjiNum(m)))
  .replace(/[ヶヵケ]/g, "ケ").replace(/ノ|之/g, "ノ").replace(/髙/g, "高").replace(/﨑/g, "崎").replace(/澤/g, "沢").replace(/邊/g, "辺").replace(/齋/g, "斎").replace(/齊/g, "斉").replace(/條/g, "条")
  .replace(/^大字/, "").replace(/\s|　/g, "");
const townOf = (n) => n.replace(/\d+丁目$/, ""); // 町-level name of a 丁目 row

const sw = readPackJson(T + "subward-tama.json");
const areas = {}, wards = {};
let allTotal = 0, allMatched = 0;
for (const [muni, w] of Object.entries(sw.wards)) {
  const own = rows.filter((o) => o.B === muni);
  const totalRow = own.find((o) => o.E === undefined);
  if (!totalRow) throw new Error(`${muni}: no municipality total row`);
  const byName = new Map(), byTown = new Map();
  for (const a of w.areas) {
    const k = norm(a.name_ja);
    (byName.get(k) ?? byName.set(k, []).get(k)).push(a);
    if (/丁目$/.test(k)) (byTown.get(townOf(k)) ?? byTown.set(townOf(k), []).get(townOf(k))).push(a);
  }
  let matchedW = 0, matchedE = 0, matchedRows = 0, dataRows = 0;
  const unmatched = [];
  const add = (a, e, wk) => { const o = (areas[a.code] ??= { e: 0, w: 0 }); o.e += e; o.w += wk; };
  const split = (list, e, wk) => { // largest-remainder split by area, integers
    const tot = list.reduce((s, a) => s + (a.area_m2 || 1), 0);
    for (const [v, key] of [[e, "e"], [wk, "w"]]) {
      const ex = list.map((a) => v * ((a.area_m2 || 1) / tot)), fl = ex.map(Math.floor);
      const rem = v - fl.reduce((s, x) => s + x, 0);
      ex.map((x, i) => [x - fl[i], i]).sort((x, y) => y[0] - x[0]).slice(0, rem).forEach(([, i]) => fl[i]++);
      list.forEach((a, i) => { (areas[a.code] ??= { e: 0, w: 0 })[key] += fl[i]; });
    }
  };
  for (const o of own) {
    if (o.E === undefined) continue;
    dataRows++;
    const e = o.F === "-" ? 0 : Number(o.F), wk = o.G === "-" ? 0 : Number(o.G), k = norm(o.E);
    if (!Number.isFinite(e) || !Number.isFinite(wk)) { unmatched.push([o.E, "non-numeric"]); continue; }
    // 1) same name  2) a 町 row over 丁目 areas  3) a 丁目 row whose census area is the whole 町 (chome numbers introduced after 2020)
    // 4) a 大字 row over areas the layer cuts into pieces named "<大字><suffix>" - each fallback splits by area
    const hit = byName.get(k) ?? byTown.get(k) ?? byName.get(townOf(k))
      ?? (k.length >= 2 ? (() => { const l = w.areas.filter((a) => norm(a.name_ja).startsWith(k)); return l.length ? l : undefined; })() : undefined);
    if (!hit) { unmatched.push([o.E, wk]); continue; }
    if (hit.length === 1) add(hit[0], e, wk); else split(hit, e, wk);
    matchedRows++; matchedW += wk; matchedE += e;
  }
  const total = Number(totalRow.G);
  wards[muni] = { workers_total: total, workers_matched: matchedW, establishments_matched: matchedE, areas_matched: matchedRows, areas: dataRows };
  allTotal += total; allMatched += matchedW;
  const lost = unmatched.filter(([, v]) => typeof v === "number" && v > 0).sort((a, b) => b[1] - a[1]);
  console.log(`${muni} ${w.name}: workers ${matchedW}/${total} (${(100 * matchedW / total).toFixed(1)}%), rows ${matchedRows}/${dataRows}` + (lost.length ? `  unmatched: ${lost.slice(0, 4).map(([n, v]) => n + "=" + v).join(", ")}${lost.length > 4 ? " ..." : ""}` : ""));
}
const cover = allMatched / allTotal;
console.log(`TOTAL workers ${allMatched}/${allTotal} = ${(100 * cover).toFixed(2)}%`);
if (cover < 0.98 && process.env.ALLOW_LOW_MATCH !== "1") throw new Error(`refusing to write jobs-tama.json: only ${(100 * cover).toFixed(2)}% of workers matched a chome (set ALLOW_LOW_MATCH=1 if understood)`);
writeChecked(T + "jobs-tama.json", JSON.stringify({
  formatVersion: 1, prefecture: "tokyo-tama",
  source: "2021 Economic Census - Activity Survey (e-Stat), table 32-1-13, establishments and workers by town (cho/chome), Tokyo, Tama-area municipalities. Workers include private and public (national/local government) establishments, by workplace location. Matched to subward-tama.json by name (scripts/tama-jobs.mjs).",
  year: 2021, wards, areas,
}), { label: "chomes", count: (j) => Object.keys(j.areas).length });
console.log({ areasWithWorkers: Object.keys(areas).length });
