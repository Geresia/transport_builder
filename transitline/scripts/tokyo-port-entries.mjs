// Sea/land port entry into the tourism.json area -> `portGateways` in tourism.json. Source: 法務省 出入国管理統計 2025 (令和7年), monthly
// 「総括 港別出入国者」 tables (e-Stat, 政府標準利用規約2.0). Real, measured monthly foreign entrants per port (cruise ships land as a port, not an
// airport). Complements `gateways` (airport, from the tourism-catalog survey's respondents): this file is the official count for ALL entrants at
// each port, no survey sample, but no destination/transport breakdown - the survey doesn't interview arrivals at these ports.
// Kanto sea ports only (the ones the pack's four prefectures cover): 東京, 横浜, 横須賀, 川崎, 千葉, 木更津. Compared with Narita/Haneda for scale.
// Usage: node scripts/tokyo-port-entries.mjs   (downloads into data-raw/tourism/ on first run)
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { readXlsx } from "./xlsx-min.mjs";
import { writeChecked } from "./safe-write.mjs";
const T = fileURLToPath(new URL("../packs/tokyo/", import.meta.url));
const RAW = fileURLToPath(new URL("../data-raw/tourism/", import.meta.url));
fs.mkdirSync(RAW, { recursive: true });
const YEAR = 2025;
// statInfId per month, found via e-Stat's file listing for 港別出入国者 (総括 25-MM-01); no query-by-date endpoint, so these are hand-collected.
const MONTH_ID = { 1: "000040251384", 2: "000040265146", 3: "000040276795", 4: "000040279817", 5: "000040292924", 6: "000040302474", 7: "000040308667", 8: "000040326167", 9: "000040362028", 10: "000040374282", 11: "000040395421", 12: "000040403727" };
const PORTS = { "東京": "13", "横浜": "14", "横須賀": "14", "川崎": "14", "千葉": "12", "木更津": "12" }; // -> prefecture code, for reference only
const SCALE_PORTS = ["成田（空港）", "羽田（空港）"];

async function download(m) {
  const file = RAW + `port-entry-${YEAR}-${String(m).padStart(2, "0")}.xlsx`;
  if (!fs.existsSync(file)) {
    const r = await fetch(`https://www.e-stat.go.jp/stat-search/file-download?statInfId=${MONTH_ID[m]}&fileKind=4`);
    if (!r.ok) throw new Error(`port entries ${YEAR}-${m}: HTTP ${r.status}`);
    fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
  }
  return fs.readFileSync(file);
}

const monthly = Object.fromEntries([...Object.keys(PORTS), ...SCALE_PORTS].map((p) => [p, Array(12).fill(null)]));
for (let m = 1; m <= 12; m++) {
  const wb = readXlsx(await download(m));
  const sheet = wb[`${String(YEAR).slice(2)}-${String(m).padStart(2, "0")}-01`];
  if (!sheet) throw new Error(`port entries ${YEAR}-${m}: sheet not found (${Object.keys(wb).join(",")})`);
  if (!sheet.some((r) => r.A?.startsWith("全国") && r.B === "総数")) throw new Error(`port entries ${YEAR}-${m}: unexpected layout, no 全国 総数 row`);
  let pref = "";
  for (const r of sheet) {
    if (r.A) pref = r.A;
    if (r.B && monthly[r.B] && !pref.startsWith("全国")) {
      const v = +r.F; // F = 入国者 外国人 (foreign entrants)
      if (!Number.isFinite(v)) throw new Error(`port entries ${YEAR}-${m}: bad value at ${pref}/${r.B}`);
      monthly[r.B][m - 1] = v;
    }
  }
}
for (const [p, arr] of Object.entries(monthly)) if (arr.some((v) => v == null)) throw new Error(`port entries: ${p} missing a month (row not found every month - name may vary, e.g. 空港 suffix)`);

const portGateways = Object.keys(PORTS).map((name) => ({ name, prefecture: PORTS[name], monthly: monthly[name], total: monthly[name].reduce((a, b) => a + b, 0) }))
  .sort((a, b) => b.total - a.total);
const scaleCheck = Object.fromEntries(SCALE_PORTS.map((p) => [p, monthly[p].reduce((a, b) => a + b, 0)]));

const note = "Foreign entrants (外国人 入国者) per sea/land port, by month - official counts of ALL entrants at that port (not a survey sample). "
  + "Complements `gateways` (airport, from the tourism-catalog visitor survey's respondents, which has destination/transport shares but no port entrants outside Narita/Haneda/Kansai etc.). "
  + "These ports are tiny next to the airports (see `airportsForScale`): Tokyo + Yokohama + the other Kanto sea ports combined are under 0.05% of Narita+Haneda's foreign entrants in 2025. "
  + "Cruise-ship arrivals land as a port, so this is the source for their seasonality, but there is no destination or transport-mode breakdown for port arrivals - the tourism-catalog survey does not interview them.";
const source = "法務省「出入国管理統計」令和7年(2025年) 月次「総括 港別出入国者」(e-Stat 政府統計の総合窓口, 政府標準利用規約2.0)";

const tourismPath = T + "tourism.json";
const tourism = JSON.parse(fs.readFileSync(tourismPath, "utf8"));
tourism.portGateways = portGateways;
tourism.portGatewaysNote = note;
tourism.portGatewaysSource = source;
tourism.airportsForScale = scaleCheck;
writeChecked(tourismPath, JSON.stringify(tourism), { count: (j) => (j.portGateways ?? []).length, label: "port gateways", minRatio: 0 });
console.log(portGateways.map((p) => `${p.name}(${p.prefecture}) ${p.total}`).join(" | "), "| for scale:", JSON.stringify(scaleCheck));
console.log((fs.statSync(tourismPath).size / 1024).toFixed(0), "KB");
