// Build packs/tokyo/special-demand.json (CityPack `attractors` format, docs/citypack-format.md) from MLIT
// 国土数値情報: P29-23 学校 (CC BY 4.0) and P04-20 医療機関 (open data, commercial OK).
// P27 文化施設 is deliberately NOT used: only the 2013 edition exists and it is non-commercial.
// Usage: node scripts/tokyo-special-demand.mjs [dataDir]   (default data-raw/mlit; prefectures 11,12,13,14)
// Real: locations, names, 病床数, 学校分類. Modeled: `capacity` (daily people). Neither dataset has visitor or
// enrollment counts, so capacity = beds x HOSPITAL_PER_BED / a flat per-class figure, marked capacityBasis "modeled".
import fs from "fs";
import { fileURLToPath } from "url";

const T = fileURLToPath(new URL("../packs/tokyo/", import.meta.url));
const dir = process.argv[2] ?? fileURLToPath(new URL("../data-raw/mlit/", import.meta.url));
const PREFS = [11, 12, 13, 14]; // Saitama, Chiba, Tokyo, Kanagawa
const manifest = JSON.parse(fs.readFileSync(T + "manifest.json", "utf8"));
const [W, S, E, N] = manifest.bbox;

const HOSPITAL_MIN_BEDS = 100; // smaller hospitals/clinics are local and already inside residents/jobs
const HOSPITAL_PER_BED = 3; // daily people per bed (patients + visitors + staff): order-of-magnitude, modeled
// P29_003 school class -> [kind, label, modeled daily people]. K-12 are neighbourhood trips, so only tertiary here.
const SCHOOL = {
  16005: ["university", "高等専門学校", 1000],
  16006: ["university", "短期大学", 1500],
  16007: ["university", "大学", 4000],
};

const read = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const inBox = ([x, y]) => x >= W && x <= E && y >= S && y <= N;
const attractors = [], stat = { university: { seen: 0, closed: 0, outside: 0 }, hospital: { seen: 0, small: 0, outside: 0 } };
const round = (v) => Math.round(v * 1e5) / 1e5;

for (const p of PREFS) {
  const sc = read(`${dir}/P29-23_${p}_GML/P29-23_${p}_GML/P29-23_${p}.geojson`);
  for (const f of sc.features) {
    const pr = f.properties, cls = SCHOOL[pr.P29_003];
    if (!cls) continue;
    stat.university.seen++;
    if (pr.P29_007 !== "0") { stat.university.closed++; continue; }
    const loc = f.geometry.coordinates;
    if (!inBox(loc)) { stat.university.outside++; continue; }
    attractors.push({
      id: `SCH-${pr.P29_002}-${pr.P29_008}`, name: pr.P29_004 + (pr.P29_009 ? `（${pr.P29_009}）` : ""), kind: cls[0], subType: cls[1],
      location: [round(loc[0]), round(loc[1])], capacity: cls[2], capacityBasis: "modeled",
      maxDistance: null, residentialSplit: 0,
    });
  }
  const hp = read(`${dir}/P04-20_${p}_GML/P04-20_${p}_GML/P04-20_${p}.geojson`);
  hp.features.forEach((f, i) => {
    const pr = f.properties;
    if (pr.P04_001 !== 1) return; // 1 = 病院 (2 = 一般診療所, 3 = 歯科診療所)
    stat.hospital.seen++;
    if (!(pr.P04_008 >= HOSPITAL_MIN_BEDS)) { stat.hospital.small++; return; }
    const loc = f.geometry.coordinates;
    if (!inBox(loc)) { stat.hospital.outside++; return; }
    attractors.push({
      id: `HOS-${p}-${i}`, name: pr.P04_002.replace(/^[（(][^）)]*[）)]\s*/, "").replace(/^\s+/, ""), kind: "hospital",
      location: [round(loc[0]), round(loc[1])], capacity: pr.P04_008 * HOSPITAL_PER_BED, capacityBasis: "modeled",
      beds: pr.P04_008, emergency: pr.P04_009 === 1, disasterBase: pr.P04_010 === 1 || pr.P04_010 === 2,
      maxDistance: null, residentialSplit: 0,
    });
  });
}

const out = {
  formatVersion: 1,
  source: "MLIT 国土数値情報 P29-23 学校データ (CC BY 4.0) and P04-20 医療機関データ (令和2年, オープンデータ). Locations, names and bed counts are source data; `capacity` is modeled.",
  note: `Universities/colleges/kosen (open, in bbox) and hospitals with >= ${HOSPITAL_MIN_BEDS} beds. Modeled capacity: hospital = beds x ${HOSPITAL_PER_BED}; university 4000, junior college 1500, kosen 1000 people/day.`,
  attractors,
};
fs.writeFileSync(T + "special-demand.json", JSON.stringify(out));
const by = {};
for (const a of attractors) by[a.kind] = (by[a.kind] ?? 0) + 1;
console.log(JSON.stringify(stat), JSON.stringify(by), "->", attractors.length, "attractors,", (fs.statSync(T + "special-demand.json").size / 1024).toFixed(0), "KB");
