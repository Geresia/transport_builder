// Lodging occupancy model -> packs/tokyo/lodging-demand.json: how full the hotels are, by prefecture, month, area and kind, so a viewer/engine
// can say "on this date N people sleep in this hotel" and move them out from there.
// Level (official, measured): 観光庁 宿泊旅行統計調査 2025 (令和7年), per prefecture x month - 延べ宿泊者数 (table 2), 利用客室数 (7), 客室稼働率 (8),
//   県内/県外 residents (9), by facility type. Occupancy comes per type; hotel = リゾート+ビジネス+シティ, inn = 旅館+簡易宿所 (rooms-weighted).
//   persons per occupied room = table 2 / table 7. Available rooms = used rooms / occupancy.
// Where inside Tokyo (measured): NTT docomo 宿泊 (2-4am) visitors per municipality x month (tourism.json), weighted by how likely each origin sleeps
//   in a hotel (surveys: Tokyo residents / other domestic / foreign). Only Tokyo has this; the other prefectures get the prefecture level everywhere.
// Capacity: hotels.json (OSM rooms, mostly modeled) scaled per prefecture+group so their total equals the official available rooms
//   (OSM does not list every hotel, so each mapped one stands for its share of the unmapped ones).
// NOT measured: the day-of-week shape (no source; a flagged placeholder, normalised per month so month means stay official) and public holidays.
// Usage: node scripts/tokyo-lodging-occupancy.mjs   (downloads the workbook + the domestic survey into data-raw/tourism/ on first run)
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { readXlsx, unzip } from "./xlsx-min.mjs";
import { readPackJson } from "./pack-json.mjs";
import { writeChecked } from "./safe-write.mjs";
const T = fileURLToPath(new URL("../packs/tokyo/", import.meta.url));
const RAW = fileURLToPath(new URL("../data-raw/tourism/", import.meta.url));
fs.mkdirSync(RAW, { recursive: true });
const YEAR = 2025;
const PREFS = { "11": "埼玉", "12": "千葉", "13": "東京", "14": "神奈川" };
const DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const GROUP_OF_KIND = { hotel: "hotel", motel: "hotel", guest_house: "inn", hostel: "inn", apartment: "inn", chalet: "inn" };
// facility-type columns of tables 7 and 8: Q 旅館, R リゾートホテル, S ビジネスホテル, T シティホテル, U 簡易宿所, V 会社・団体の宿泊所 (in neither group)
const GROUP_COLS = { hotel: ["R", "S", "T"], inn: ["Q", "U"] };
// ponytail: placeholder, no source. Sun..Sat. Replace with measured daily data if any appears; months are re-normalised to mean 1.
const DAY_OF_WEEK = [0.88, 0.95, 1.03, 1.05, 1.05, 1.02, 1.02];

async function download(url, file) {
  if (fs.existsSync(RAW + file)) return fs.readFileSync(RAW + file);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  fs.writeFileSync(RAW + file, buf);
  return buf;
}

// ---- 1. official prefecture x month statistics ----
const wanted = [];
for (const n of [2, 7, 8, 9]) for (let m = 1; m <= 12; m++) wanted.push(`第${n}表(${m}月)`);
const wb = readXlsx(await download("https://www.mlit.go.jp/kankocho/content/002010340.xlsx", "shukuhaku-2025.xlsx"), wanted);
const num = (v) => { const x = parseFloat(v); return Number.isFinite(x) ? x : null; };
function tableRow(n, m, pref) {
  const rows = wb[`第${n}表(${m}月)`];
  if (!rows) throw new Error(`sheet 第${n}表(${m}月) missing`);
  const head = rows.find((r) => r.A && r.A.startsWith("施設所在地"));
  const want = { 2: "延べ宿泊者数", 7: "利用客室数", 8: "客室稼働率", 9: "延べ宿泊者数" }[n];
  if (!head || !head.B.replace(/\s/g, "").includes(want)) throw new Error(`第${n}表(${m}月): unexpected layout, column B is "${head?.B}"`);
  if (n === 7 || n === 8) {
    const t = rows.find((r) => r.Q && r.Q.includes("旅館"));
    if (!t || !t.U?.includes("簡易宿所") || !t.V?.includes("会社")) throw new Error(`第${n}表(${m}月): facility-type columns moved`);
  }
  const row = rows.find((r) => r.A && new RegExp(`^\\s*${pref}`).test(r.A));
  if (!row) throw new Error(`第${n}表(${m}月): no row for ${pref}`);
  return row;
}
const r3 = (x) => Math.round(x * 1000) / 1000;
const prefectures = {};
for (const [p, name] of Object.entries(PREFS)) {
  const o = { name, persons: [], personsPerRoom: [], occupancyAll: [], occupancyHotel: [], occupancyInn: [], residentShare: [], tourismShare: [], _avail: { hotel: [], inn: [] } };
  for (let m = 1; m <= 12; m++) {
    const P = num(tableRow(2, m, p).B), U = tableRow(7, m, p), O = tableRow(8, m, p), R = tableRow(9, m, p);
    o.persons.push(P);
    o.personsPerRoom.push(r3(P / num(U.B)));
    o.occupancyAll.push(r3(num(O.B) / 100));
    o.residentShare.push(r3(num(R.C) / (num(R.C) + num(R.D))));
    o.tourismShare.push(r3(num(U.C) / (num(U.C) + num(U.D)))); // share of used rooms in facilities where 50%+ of the guests are there for tourism (table 7 C vs D)
    for (const [g, cols] of Object.entries(GROUP_COLS)) {
      let used = 0, avail = 0;
      for (const c of cols) { const u = num(U[c]), oc = num(O[c]); if (u > 0 && oc > 0) { used += u; avail += u / (oc / 100); } }
      if (!(avail > 0)) throw new Error(`${name} ${m}月 ${g}: no usable type rows`);
      o[g === "hotel" ? "occupancyHotel" : "occupancyInn"].push(r3(used / avail));
      o._avail[g].push(avail / DAYS[m - 1]); // available rooms (average per night that month)
    }
  }
  prefectures[p] = o;
}

// ---- 2. capacity: OSM rooms per prefecture and group, scaled to the official available rooms ----
const hotelsFile = readPackJson(T + "hotels.json");
const osm = {};
for (const h of hotelsFile.hotels) {
  const g = GROUP_OF_KIND[h.kind], p = h.muni.slice(0, 2);
  if (!g || !PREFS[p]) continue;
  osm[p] ??= { hotel: 0, inn: 0 };
  osm[p][g] += h.rooms;
}
for (const [p, o] of Object.entries(prefectures)) {
  o.roomsOfficial = {}; o.roomsOsm = osm[p] ?? { hotel: 0, inn: 0 }; o.scale = {};
  for (const g of ["hotel", "inn"]) {
    o.roomsOfficial[g] = Math.round(o._avail[g].reduce((a, b) => a + b, 0) / 12);
    o.scale[g] = o.roomsOsm[g] > 0 ? r3(o.roomsOfficial[g] / o.roomsOsm[g]) : null;
  }
  delete o._avail;
}

// ---- 3. who sleeps in a hotel: shares from the two surveys (multi-answer, so shares of respondents) ----
await download("https://data.tourism.metro.tokyo.lg.jp/data/jittai-para/files/jittai-para-jp.zip", "jittai-para.zip");
function surveyShares() {
  const inner = (buf, name) => { const z = unzip(buf); const k = Object.keys(z).find((n) => n.includes(name)); if (!k) throw new Error(`survey file ${name} not in zip`); return z[k](); };
  const idx = (rows) => Object.fromEntries(Object.entries(rows[0]).map(([c, n]) => [String(n).replace(/(?<=泊数)[ァ-ヶー]+$/, ""), c]));
  // domestic (観光地点パラメータ調査 R7): overnight in Tokyo, residence prefecture 13 vs others, 都内宿泊施設 option 3 = ホテル
  const para = readXlsx(inner(fs.readFileSync(RAW + "jittai-para.zip"), "【R7】"), ["R7（2025）"])["R7（2025）"];
  const pc = idx(para), hot = pc["都内宿泊施設_3"];
  if (!hot || !pc["うち都内泊数"] || !pc["都道府県名"]) throw new Error("domestic survey layout changed");
  const c = { tk: [0, 0], other: [0, 0] };
  for (const r of para.slice(1)) {
    if (!(+r[pc["うち都内泊数"]] > 0)) continue;
    const k = +r[pc["都道府県名"]] === 13 ? "tk" : "other";
    c[k][0]++; if (+r[hot] === 1) c[k][1]++;
  }
  // foreign (国・地域別外国人旅行者行動特性調査 R7): 宿泊施設1 = ホテル
  const fo = readXlsx(inner(fs.readFileSync(RAW + "kunibetsu.zip"), "【R7】"), ["2025"])["2025"];
  const fc = idx(fo), fh = fc["宿泊施設1"];
  if (!fh || !fc["都内泊数"]) throw new Error("foreign survey layout changed");
  let fn = 0, fy = 0;
  for (const r of fo.slice(1)) { if (!(+r[fc["都内泊数"]] > 0)) continue; fn++; if (+r[fh] === 1) fy++; }
  return { tokyoResidents: r3(c.tk[1] / c.tk[0]), otherDomestic: r3(c.other[1] / c.other[0]), foreign: r3(fy / fn), n: { tokyoResidents: c.tk[0], otherDomestic: c.other[0], foreign: fn } };
}
const hotelShare = surveyShares();

// ---- 4. where inside Tokyo: NTT overnight visitors per municipality x month, hotel-weighted, vs the rooms there ----
const tourism = readPackJson(T + "tourism.json");
const rooms = {}; // muni -> { hotel, inn } OSM rooms
for (const h of hotelsFile.hotels) if (h.muni.startsWith("13") && GROUP_OF_KIND[h.kind]) (rooms[h.muni] ??= { hotel: 0, inn: 0 })[GROUP_OF_KIND[h.kind]] += h.rooms;
const SUPPRESSED = 50; // NTT suppresses < 100 people: impute the midpoint rather than 0
const w = {}, rep = {};
for (const [code, r] of Object.entries(rooms)) {
  const mm = tourism.municipalities[code];
  if (!mm) continue;
  const ori = Object.entries(mm.domesticByOrigin), tot = ori.reduce((s, [, v]) => s + (v.stay ?? 0), 0);
  const hDom = tot > 0 ? ori.reduce((s, [k, v]) => s + (v.stay ?? 0) * (k === "13" ? hotelShare.tokyoResidents : hotelShare.otherDomestic), 0) / tot : hotelShare.otherDomestic;
  w[code] = mm.monthly.domestic.stay.map((d, t) => (d ?? SUPPRESSED) * hDom + (mm.monthly.foreign.stay[t] ?? SUPPRESSED) * hotelShare.foreign);
  rep[code] = r.hotel * (prefectures["13"].scale.hotel ?? 1) + r.inn * (prefectures["13"].scale.inn ?? 1);
}
const codes = Object.keys(w), sumRep = codes.reduce((s, c) => s + rep[c], 0);
// The raw ratio is far too noisy to use as is (0.05-16): NTT "overnight visitors" also counts people sleeping at relatives' and friends' homes, so
// dormitory suburbs with a 20-room hotel show 10x. Damp it (power SHRINK), keep it within [LAMBDA_MIN, LAMBDA_MAX], then re-centre per month so the
// room-weighted mean is exactly 1 and the prefecture keeps the official occupancy. A modeling choice, recorded in the file.
const SHRINK = 0.5, LAMBDA_MIN = 0.6, LAMBDA_MAX = 1.3;
const municipalities = {};
for (const c of codes) municipalities[c] = { lambda: [] };
for (let t = 0; t < 12; t++) {
  const W = codes.reduce((s, k) => s + w[k][t], 0);
  const damped = Object.fromEntries(codes.map((c) => [c, Math.min(LAMBDA_MAX, Math.max(LAMBDA_MIN, Math.pow((w[c][t] / W) / (rep[c] / sumRep), SHRINK)))]));
  const mean = codes.reduce((s, c) => s + rep[c] * damped[c], 0) / sumRep;
  for (const c of codes) municipalities[c].lambda.push(r3(damped[c] / mean));
}

const out = {
  formatVersion: 1, year: YEAR,
  source: "観光庁「宿泊旅行統計調査」令和7年 (第2・7・8・9表, e-Stat, 政府標準利用規約2.0); 東京都観光データカタログ — モバイル空間統計(NTTドコモ)を加工して作成 と 観光地点パラメータ調査・国・地域別外国人旅行者行動特性調査 (R7); OSM hotels.json (ODbL)",
  note: "occupancy[hotel|inn][month] = official 客室稼働率 of that facility group in that prefecture (measured). personsPerRoom = 延べ宿泊者数 / 利用客室数. "
    + "For a hotel on day d: occupancy = min(1, occ[group][month] x lambda[municipality][month] x dowNormalised(d)); guests that night = occupancy x rooms x scale[prefecture][group] x personsPerRoom[month]. "
    + `lambda (Tokyo municipalities only) = that municipality's share of hotel-weighted NTT overnight visitors divided by its share of rooms, damped (power ${SHRINK}), limited to ${LAMBDA_MIN}-${LAMBDA_MAX} and re-centred to a room-weighted mean of 1 each month, because NTT overnight also counts stays at relatives' homes; 1 elsewhere. `
    + "scale = official available rooms / OSM rooms of the group (OSM is incomplete and its room counts are mostly modeled: see hotels.json sizeBasis). "
    + "dayOfWeek is an ASSUMED placeholder (no source), re-normalised so each month's mean stays the official value; public holidays are not modeled. "
    + "tourismShare[month] = share of used rooms in facilities where tourism is 50%+ of the guests (official table 7): a facility-level proxy for the leisure share of guests, the rest is treated as business/other. "
    + "Official facilities are those with 10+ employees; 会社・団体の宿泊所 and 民泊 are outside both groups.",
  hotelShare: { ...hotelShare, basis: "share of overnight respondents in Tokyo who used a hotel (multi-answer): domestic 観光地点パラメータ調査 R7, foreign 国・地域別外国人旅行者行動特性調査 R7" },
  groups: { hotel: "OSM hotel, motel <-> official リゾートホテル+ビジネスホテル+シティホテル", inn: "OSM guest_house, hostel, apartment, chalet <-> official 旅館+簡易宿所" },
  dayOfWeek: { assumed: true, sunToSat: DAY_OF_WEEK },
  daysInMonth: DAYS,
  prefectures, municipalities,
};
writeChecked(T + "lodging-demand.json", JSON.stringify(out), { count: (j) => Object.keys(j.prefectures).length + Object.keys(j.municipalities).length, label: "entries" });
// diagnostics
for (const o of Object.values(prefectures)) console.log(`${o.name}: occ hotel ${o.occupancyHotel.join(" ")} | inn ${o.occupancyInn[0]}..${o.occupancyInn[11]} | persons/room ${o.personsPerRoom[0]}..${o.personsPerRoom[11]} | rooms official ${JSON.stringify(o.roomsOfficial)} vs OSM ${JSON.stringify(o.roomsOsm)} -> scale ${JSON.stringify(o.scale)} | resident share Jan ${o.residentShare[0]}`);
const lam = Object.values(municipalities).flatMap((m) => m.lambda);
console.log("hotelShare", JSON.stringify(hotelShare), "| Tokyo municipalities with lambda:", codes.length, "| lambda range", Math.min(...lam), "-", Math.max(...lam), "|", (fs.statSync(T + "lodging-demand.json").size / 1024).toFixed(0), "KB");
