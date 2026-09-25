// Tourism demand for Tokyo -> packs/tokyo/tourism.json. Sources (東京都産業労働局 観光データカタログ, https://data.tourism.metro.tokyo.lg.jp/):
//   mobile-jp.zip    モバイルデータを活用した訪都旅行者動態調査 (NTT docomo モバイル空間統計), R7 = 2025: visitors per Tokyo 区市町村 -
//                    domestic by residence prefecture, foreign by world region, monthly. Measured, but rounded to 100 and <100 suppressed.
//   kunibetsu-jp.zip 国・地域別外国人旅行者行動特性調査, R7 = 2025: respondent-level survey -> entry airport x visited area x transport.
//                    A survey sample (unweighted, interviewed in Tokyo), so it gives shares, not volumes.
//   e-Stat 000031561675  幹線鉄道旅客流動実態調査 H27 (2015) 都道府県間相互発着表: Shinkansen + limited express riders into the four
//                    prefectures per year, by origin prefecture (`railInbound`). All trip purposes, and 2015, not 2025.
// Unit of the mobile numbers: 延べ - a person is counted once per area per month, then months are summed. A visitor to two wards is in both,
// so wards must not be added up to a Tokyo total. Wards' `stay` (2-4am present) and `dayTrip` (rest) are disjoint.
// The "visitor to Tokyo" definition is the source's: Kanto residents >= 40 km one way or >= 4 h, others >= 80 km or >= 8 h; commuting excluded.
// Usage: node scripts/tokyo-tourism.mjs   (downloads into data-raw/tourism/ on first run; that dir is not committed)
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { writeChecked } from "./safe-write.mjs";
import { unzip, readXlsx } from "./xlsx-min.mjs";
const T = fileURLToPath(new URL("../packs/tokyo/", import.meta.url));
const RAW = fileURLToPath(new URL("../data-raw/tourism/", import.meta.url));
const BASE = "https://data.tourism.metro.tokyo.lg.jp/data/";
const YEAR = 2025;
fs.mkdirSync(RAW, { recursive: true });

async function xlsxIn(dataset, prefix) { // an .xlsx from the dataset's zip whose name starts with `prefix`
  const zip = RAW + dataset + ".zip";
  if (!fs.existsSync(zip)) {
    const r = await fetch(`${BASE}${dataset}/files/${dataset}-jp.zip`);
    if (!r.ok) throw new Error(`${dataset}: HTTP ${r.status}`);
    fs.writeFileSync(zip, Buffer.from(await r.arrayBuffer()));
  }
  const z = unzip(fs.readFileSync(zip));
  const name = Object.keys(z).find((k) => k.split("/").pop().startsWith(prefix));
  if (!name) throw new Error(`${dataset}: no file starting ${prefix}`);
  return z[name]();
}
const header = (rows) => Object.fromEntries(Object.entries(rows[0]).map(([col, name]) => [name, col]));

// ---- 1. mobile spatial statistics: per municipality ----
const mob = readXlsx(await xlsxIn("mobile", "【R7】"));
const master = readXlsx(await xlsxIn("mobile", "モバイルデータを活用した訪都旅行者動態調査_マスタ"));
const kind = { stay: "stay", day_trip: "dayTrip" };
const rowsOf = (sheet) => mob[sheet].slice(1);
const blank = () => ({ stay: Array(12).fill(null), dayTrip: Array(12).fill(null) });
const munis = {};
for (const r of master["市区町村"].slice(1)) munis[r.A] = { name: r.C, domestic: null, foreign: null, domesticByOrigin: {}, foreignByRegion: {}, monthly: { domestic: blank(), foreign: blank() } };
const M = (code) => { if (!munis[code]) throw new Error(`municipality ${code} not in master`); return munis[code]; };
const tot = { domestic: {}, foreign: {} }; // "code|time" -> summed population, incl. the source's All rows
for (const r of rowsOf("滞在人数分析_居住地別")) { // A year, B time, C area, D residence (prefecture code), E population
  if (+r.A !== YEAR) throw new Error(`unexpected year ${r.A}`);
  const m = M(r.C);
  tot.domestic[r.C + "|" + r.B] = (tot.domestic[r.C + "|" + r.B] ?? 0) + +r.E;
  if (r.B !== "All") (m.domesticByOrigin[String(r.D).padStart(2, "0")] ??= {})[kind[r.B]] = +r.E; // All = stay + day trip
}
for (const r of rowsOf("訪日外国人_市区町村別_滞在人数分析")) { // A year, B time, C area, D region, E population
  const m = M(r.C);
  tot.foreign[r.C + "|" + r.B] = (tot.foreign[r.C + "|" + r.B] ?? 0) + +r.E;
  if (r.B !== "All") (m.foreignByRegion[r.D] ??= {})[kind[r.B]] = +r.E;
}
for (const [sheet, who] of [["区市町村別_月別旅行者数_国内旅行者", "domestic"], ["区市町村別_月別旅行者数_外国人旅行者", "foreign"]]) {
  for (const r of rowsOf(sheet)) { // A year, B month, C time, D area, E population
    if (r.C !== "All") M(r.D).monthly[who][kind[r.C]][+r.B - 1] = +r.E;
  }
}
for (const [code, m] of Object.entries(munis)) {
  for (const who of ["domestic", "foreign"]) {
    const t = tot[who];
    m[who] = { stay: t[code + "|stay"] ?? null, dayTrip: t[code + "|day_trip"] ?? null, all: t[code + "|All"] ?? null };
  }
}

// ---- 2. foreign visitor survey: entry airport x visited area x transport (R7 codes; codes are renumbered every survey year) ----
const AIRPORT = { 1: "成田", 2: "羽田", 3: "関西", 4: "中部（名古屋）", 5: "福岡", 6: "新千歳", 7: "那覇", 8: "富士山静岡", 9: "その他" };
// [survey name, ward/city codes it lies in]. Names are R7 マスタ order (checked below); the codes are HAND-MAPPED, approximate where an area spans wards.
const AREA = [
  ["東京駅周辺・丸の内・日本橋", ["13101", "13102"]], ["秋葉原", ["13101"]], ["銀座", ["13102"]], ["築地", ["13102"]],
  ["原宿・表参道・青山", ["13113", "13103"]], ["渋谷", ["13113"]], ["六本木・赤坂", ["13103"]], ["新宿・大久保", ["13104"]],
  ["恵比寿・代官山", ["13113"]], ["池袋", ["13116"]], ["上野", ["13106"]], ["浅草", ["13106"]], ["墨田・両国", ["13107"]],
  ["亀有・柴又", ["13122"]], ["新橋・汐留", ["13103"]], ["品川", ["13103", "13109"]], ["蒲田", ["13111"]], ["お台場・東京湾", ["13103", "13108"]],
  ["豊洲", ["13108"]], ["吉祥寺・三鷹", ["13203", "13204"]], ["立川", ["13202"]], ["八王子・高尾山", ["13201"]], ["青梅・御岳山", ["13205"]],
  ["奥多摩", ["13308"]], ["伊豆諸島・小笠原諸島", []], ["その他", []],
];
for (const a of AREA) for (const c of a[1]) if (!munis[c]) throw new Error(`survey area ${a[0]}: ${c} is not a municipality in the mobile data`);
const TRANSPORT = ["JR", "京成電鉄", "モノレール", "京急電鉄", "地下鉄", "鉄道（上記以外）", "空港リムジンバス", "貸切バス", "定期観光バス", "路線バス", "タクシー", "水上バス・屋形船", "船（都内移動のみ）", "自転車", "電動キックボード", "親族・知人の車", "レンタカー", "その他"];
const kmaster = readXlsx(await xlsxIn("kunibetsu", "国・地域別外国人旅行者行動特性調査_マスタ"), ["B2_入国空海港", "F4_交通", "G2_訪問地"]);
for (const [sheet, ours] of [["B2_入国空海港", Object.values(AIRPORT)], ["F4_交通", TRANSPORT], ["G2_訪問地", AREA.map((a) => a[0])]]) {
  const got = kmaster[sheet].slice(1).map((r) => r.B); // first value column = R7
  ours.forEach((n, i) => { if (!got[i]?.startsWith(n)) throw new Error(`${sheet} code ${i + 1}: expected "${n}", master says "${got[i]}" - R7 code list changed`); });
}
const survey = readXlsx(await xlsxIn("kunibetsu", "【R7】"))["2025"];
const col = header(survey);
const flagCols = (prefix, n) => Array.from({ length: n }, (_, i) => col[prefix + String(i + 1).padStart(2, "0")] ?? (() => { throw new Error(`survey column ${prefix}${i + 1} missing`); })());
const areaCols = flagCols("訪問地", AREA.length), trCols = flagCols("交通", TRANSPORT.length);
const stat = { rows: 0, notTokyo: 0, noAirport: 0 };
const acc = {}; // airport code -> { n, area: [], transport: [] }
for (const r of survey.slice(1)) {
  stat.rows++;
  if (+r[col["訪都有無"]] !== 1) { stat.notTokyo++; continue; }
  const ap = +r[col["入国空港"]];
  if (!AIRPORT[ap]) { stat.noAirport++; continue; }
  const a = (acc[ap] ??= { n: 0, area: Array(AREA.length).fill(0), transport: Array(TRANSPORT.length).fill(0) });
  a.n++;
  areaCols.forEach((c, i) => { if (+r[c] === 1) a.area[i]++; });
  trCols.forEach((c, i) => { if (+r[c] === 1) a.transport[i]++; });
}
const share = (k, n) => Math.round((k / n) * 1000) / 1000;
const gateways = Object.entries(acc).map(([ap, a]) => ({
  airport: AIRPORT[ap], respondents: a.n,
  visitedAreaShare: Object.fromEntries(AREA.map(([nm], i) => [nm, share(a.area[i], a.n)]).filter(([, s]) => s > 0)),
  transportShare: Object.fromEntries(TRANSPORT.map((nm, i) => [nm, share(a.transport[i], a.n)]).filter(([, s]) => s > 0)),
})).sort((x, y) => y.respondents - x.respondents);

// ---- 3. rail inbound to the four prefectures: 国土交通省 幹線鉄道旅客流動実態調査 H27 (2015), the latest full survey ----
// Shinkansen + main-line limited express, ALL trip purposes (business, commuting, tourism), not tourists only. One-way trips per year
// (survey weekday + holiday in Oct/Nov, expanded to a year by MLIT), thousand persons, origin OUTSIDE 埼玉/千葉/東京/神奈川 -> destination inside.
// Origin "海外" = the trip started overseas. Trips between the four prefectures are not counted.
const FOUR = { "11": "埼玉", "12": "千葉", "13": "東京", "14": "神奈川" };
const RAIL_XLSX = RAW + "rail-od-h27.xlsx";
if (!fs.existsSync(RAIL_XLSX)) {
  const r = await fetch("https://www.e-stat.go.jp/stat-search/file-download?statInfId=000031561675&fileKind=0");
  if (!r.ok) throw new Error(`e-Stat rail OD: HTTP ${r.status}`);
  fs.writeFileSync(RAIL_XLSX, Buffer.from(await r.arrayBuffer()));
}
const SHEET = "片道 平休年拡大";
const rail = readXlsx(fs.readFileSync(RAIL_XLSX), [SHEET])[SHEET];
const strip = (s) => String(s).replace(/[\s　]/g, "");
if (!rail.some((r) => Object.values(r).some((v) => /千人/.test(v)))) throw new Error("rail OD: expected unit 千人 not found");
const railHead = rail.find((r) => r.C && strip(r.C) === "北海道");
const railCol = Object.fromEntries(Object.entries(railHead).map(([c, n]) => [strip(n), c]));
const prefCode = Object.fromEntries(master["都道府県"].slice(1).map((r) => [r.A, r.B]));
const codeOf = (n) => (n === "海外" ? "overseas" : Object.keys(prefCode).find((c) => prefCode[c].startsWith(n)) ?? (() => { throw new Error(`rail OD: no prefecture for ${n}`); })());
const toFour = { "11": 0, "12": 0, "13": 0, "14": 0 }, byOrigin = {};
for (const r of rail) {
  const name = r.B && strip(r.B);
  if (!name || name === "合計" || !(name in railCol) || strip(railHead[railCol[name]] ?? "") !== name) continue;
  const o = codeOf(name);
  if (o in FOUR) continue;
  for (const d of Object.keys(FOUR)) {
    const v = +(r[railCol[FOUR[d]]] ?? 0);
    toFour[d] += v; byOrigin[o] = (byOrigin[o] ?? 0) + v;
  }
}
const railTotal = Object.values(toFour).reduce((a, b) => a + b, 0);
// 44 origins = 43 other prefectures + overseas
if (Object.keys(byOrigin).length !== 44 || !(railTotal > 5e4 && railTotal < 2e5)) throw new Error(`rail OD: implausible result (${Object.keys(byOrigin).length} origins, total ${railTotal})`);
const railInbound = {
  source: "国土交通省「幹線鉄道旅客流動実態調査」平成27年(2015) 都道府県間相互発着表 片道 平休年拡大 (e-Stat statInfId 000031561675). 新幹線+幹線特急, 全目的 (観光客のみではない).",
  year: 2015, unit: "thousand persons per year, one way, origin outside the four prefectures",
  toPrefecture: Object.fromEntries(Object.entries(toFour).map(([k, v]) => [k, Math.round(v)])),
  total: Math.round(railTotal), perDay: Math.round((railTotal * 1000) / 365),
  byOrigin: Object.fromEntries(Object.entries(byOrigin).map(([k, v]) => [k, Math.round(v)])), // keyed by prefecture code (01-47) or "overseas"
};

const out = {
  formatVersion: 1, year: YEAR,
  source: "東京都産業労働局「東京都観光データカタログ」 — 訪都旅行者動態調査 (NTTドコモ モバイル空間統計) R7(2025) と 国・地域別外国人旅行者行動特性調査 R7(2025). 出典：モバイル空間統計。モバイル空間統計を加工して作成。",
  note: "municipalities[code]: measured visitors (延べ: once per area per month, summed over the year; 100-rounded, <100 suppressed -> null/absent). domesticByOrigin is keyed by residence prefecture code (01-47); foreignByRegion by world region. Do not sum municipalities (a visitor to two wards counts in both). surveyAreas + gateways: unweighted survey SHARES (respondents per entry airport who visited each area / used each transport), not volumes; interviewed in Tokyo, so airports other than Narita/Haneda are small samples. surveyAreas[].wardCodes are hand-mapped and approximate.",
  visitorDefinition: "Kanto (1都3県) residents: >= 40 km one way or >= 4 h stay; other residents: >= 80 km or >= 8 h; regular commuting excluded. Foreign: NTT docomo roaming data.",
  municipalities: munis,
  railInbound,
  surveyAreas: AREA.map(([name, wardCodes]) => ({ name, wardCodes })),
  gateways,
};
writeChecked(T + "tourism.json", JSON.stringify(out), { count: (j) => Object.keys(j.municipalities).length, label: "municipalities" });
const withData = Object.values(munis).filter((m) => m.domestic.all != null).length;
console.log(JSON.stringify(stat), "-> munis", Object.keys(munis).length, "with domestic data", withData, "| gateways", gateways.map((g) => `${g.airport}:${g.respondents}`).join(" "), "|", (fs.statSync(T + "tourism.json").size / 1024).toFixed(0), "KB");
