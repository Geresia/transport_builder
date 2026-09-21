// Korean label points for named parks / schools / hospitals (areas.pmtiles) and named large buildings (building-labels.pmtiles).
// Output: labels.geojsonl (Point features: ko, ja, cls, size) -> planetiler -> labels.pmtiles
import fs from "fs";
import { createRequire } from "module";
const req = createRequire(process.cwd() + "/x.js");
const { PMTiles } = req("pmtiles");
const { VectorTile } = req("@mapbox/vector-tile");
const { PbfReader } = req("pbf");
const kuromoji = req("kuromoji");
const PACK = "C:/Users/이상재/transport_builder/transitline/packs/tokyo/";
const POSTAL = "C:/Users/이상재/AppData/Local/Temp/claude/c--Users-----transport-builder/387512dd-6762-47d6-97f9-d5307e723e6f/scratchpad/utf_ken_all.csv";
const OUT = process.argv[2] || "labels.geojsonl";

// ---- kana -> hangul (same table as viewer.html)
const html = fs.readFileSync(PACK + "viewer.html", "utf8");
const src = html.slice(html.indexOf("const KANA_TABLE"), html.indexOf("async function loadJSON"));
const { muniKo } = new Function(src + ";return {muniKo}")();
const kana2ko = (k) => muniKo(k, false) || k;

// ---- place-name readings from the Japan Post CSV (Kanto only)
const townKana = new Map();
const stripP = (s) => s.replace(/（.*$/, "").replace(/\(.*$/, "").trim();
for (const line of fs.readFileSync(POSTAL, "utf8").split(/\r?\n/)) {
  const f = line.split(","); if (f.length < 9) continue;
  const code = f[0].replace(/"/g, ""); if (!/^1[1-4]/.test(code)) continue;
  const q = (i) => f[i].replace(/"/g, "");
  const town = stripP(q(8)).replace(/^大字|^字/, "").replace(/[一二三四五六七八九十]+丁目$/, ""), tk = stripP(q(5)).replace(/^ダイジ|^アザ/, "").replace(/[イニサヨゴロナハキジュウチョウメッ]+チョウメ$/, "");
  if (town && town !== "以下に掲載がない場合" && town.length >= 2 && /^[゠-ヿー]+$/.test(tk) && !townKana.has(town)) townKana.set(town, tk);
  const city = q(7), ck = q(4);
  const cb = city.slice(0, -1), cbk = ck.replace(/(ク|シ|マチ|チョウ|ムラ|ソン|グン)$/, "");
  if (cb.length >= 2 && cbk && !townKana.has(cb)) townKana.set(cb, cbk);
}
console.log("place readings", townKana.size);

const SUFFIX = new Map([["小学校", "초등학교"], ["中学校", "중학교"], ["高等学校", "고등학교"], ["高校", "고교"], ["短期大学", "단기대학"], ["大学院", "대학원"], ["大学", "대학교"],
  ["学園", "학원"], ["学院", "학원"], ["幼稚園", "유치원"], ["保育園", "어린이집"], ["保育所", "어린이집"], ["認定こども園", "인정어린이집"], ["こども園", "어린이집"],
  ["児童遊園", "어린이공원"], ["児童公園", "어린이공원"], ["公園", "공원"], ["緑地", "녹지"], ["広場", "광장"], ["運動場", "운동장"], ["霊園", "영원"], ["墓地", "묘지"],
  ["総合病院", "종합병원"], ["病院", "병원"], ["医院", "의원"], ["クリニック", "클리닉"], ["神社", "신사"], ["稲荷", "이나리"], ["八幡宮", "하치만궁"], ["寺", "사"], ["教会", "교회"],
  ["区立", " 구립 "], ["市立", " 시립 "], ["町立", " 정립 "], ["村立", " 촌립 "], ["県立", " 현립 "], ["都立", " 도립 "], ["私立", " 사립 "], ["国立", " 국립 "],
  ["丁目", "정목"], ["第", "제"], ["体育館", "체육관"], ["図書館", "도서관"], ["美術館", "미술관"], ["博物館", "박물관"], ["ホテル", "호텔"], ["ビルディング", "빌딩"], ["ビルヂング", "빌딩"], ["ビルデング", "빌딩"], ["ビル", "빌딩"], ["ヒルズ", "힐스"], ["ステーション", "스테이션"], ["学部", "학부"], ["研究所", "연구소"], ["研究科", "연구과"], ["センター", "센터"], ["タワー", "타워"]]);
const sufKeys = [...SUFFIX.keys()].sort((a, b) => b.length - a.length);
const townKeys = new Set(townKana.keys());
const maxTown = 8;
const NUM = { "０": 0, "１": 1, "２": 2, "３": 3, "４": 4, "５": 5, "６": 6, "７": 7, "８": 8, "９": 9 };

const tokenizer = await new Promise((res, rej) => kuromoji.builder({ dicPath: "node_modules/kuromoji/dict" }).build((e, t) => e ? rej(e) : res(t)));
const hira2kata = (s) => s.replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));
function toKo(ja) {
  let s = ja.normalize("NFKC").trim();
  // 漢数字 + 号 → 아라비아 숫자 (環状七号線 → 環状7号線)
  const KN = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  s = s.replace(/([一二三四五六七八九十]+)(?=号)/g, (m) => m === "十" ? "10" : m.length === 1 ? String(KN[m]) : m.startsWith("十") ? String(10 + KN[m[1]]) : m.endsWith("十") ? String(KN[m[0]] * 10) : String(KN[m[0]] * 10 + KN[m[2]]));
  const out = [];
  let raw = "";
  const flushRaw = () => {
    if (!raw) return;
    for (const tk of tokenizer.tokenize(raw)) {
      const r = tk.reading && tk.reading !== "*" ? tk.reading : null;
      if (/^[\x21-\x7e\s]+$/.test(tk.surface_form)) out.push(tk.surface_form);
      else if (r && /^[゠-ヿー]+$/.test(r)) out.push(kana2ko(r));
      else out.push(kana2ko(hira2kata(tk.surface_form)) || tk.surface_form);
    }
    raw = "";
  };
  for (let i = 0; i < s.length;) {
    let hit = null;
    for (const k of sufKeys) if (s.startsWith(k, i)) { hit = ["suf", k]; break; }
    if (!hit) for (let L = Math.min(maxTown, s.length - i); L >= 2; L--) { const w = s.substr(i, L); if (townKeys.has(w) && /[一-鿿]/.test(w)) { hit = ["town", w]; break; } }
    if (hit) { flushRaw(); if (hit[0] === "suf") out.push(SUFFIX.get(hit[1])); else out.push(kana2ko(townKana.get(hit[1]))); i += hit[1].length; }
    else { raw += s[i]; i++; }
  }
  flushRaw();
  // "第" + number -> 제N ; tidy spaces around suffix words
  let ko = out.join("").replace(/제 ?/g, "제").replace(/\s+/g, " ").trim();
  return ko;
}
// readable spacing: put a space before school/park/... suffixes if the stem is long
const spaced = (ko) => ko.replace(/(?<=\S)(고속도로|대로|거리|가도|도로|바이패스|초등학교|중학교|고등학교|고교|대학교|대학원|단기대학|유치원|어린이집|어린이공원|공원|녹지|광장|운동장|병원|종합병원|의원|클리닉|신사|체육관|도서관|미술관|박물관|호텔|빌딩|센터|타워)/g, " $1");


// ---- road-specific suffixes
for (const [k, v] of [["首都高速", "수도고속 "], ["高速道路", "고속도로"], ["高速", "고속"], ["自動車道", "자동차도"], ["国道", "국도 "], ["県道", "현도 "], ["都道", "도도 "], ["号線", "호선 "], ["号", "호 "], ["環状", "환상"], ["大通り", "대로"], ["通り", "거리"], ["街道", "가도"], ["道路", "도로"], ["バイパス", "바이패스"], ["橋", "교"], ["線", "선"]]) SUFFIX.set(k, v);
sufKeys.length = 0; sufKeys.push(...[...SUFFIX.keys()].sort((a, b) => b.length - a.length));

// ---- decode road-name tiles
const open = (f) => { const fd = fs.openSync(f, "r"); return new PMTiles({ getKey: () => f, getBytes: async (o, l) => { const b = Buffer.alloc(l); fs.readSync(fd, b, 0, l, o); return { data: b.buffer.slice(b.byteOffset, b.byteOffset + l) }; } }); };
const Z = 14, x0 = 14480, x1 = 14620, y0 = 6230, y1 = 6520;
const t2lon = (x) => x / 2 ** Z * 360 - 180;
const t2lat = (y) => { const n = Math.PI - 2 * Math.PI * y / 2 ** Z; return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))); };
const pm = open(process.argv[3]);
const cache = new Map(); const w = fs.openSync(OUT, "w"); let buf = [], n = 0; const ex = [];
const seen = new Set();
for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) {
  const r = await pm.getZxy(Z, tx, ty); if (!r) continue;
  const L = new VectorTile(new PbfReader(new Uint8Array(r.data))).layers.rname; if (!L) continue;
  const lw = t2lon(tx), le = t2lon(tx + 1), ln = t2lat(ty), ls = t2lat(ty + 1), E = L.extent;
  for (let i = 0; i < L.length; i++) {
    const f = L.feature(i); if (f.type !== 2) continue;
    const p = f.properties; const ja = p.name_ko || p.name || "";
    let ko = p.name_ko;
    if (!ko) {
      if (ja) { ko = cache.get(ja); if (ko === undefined) { ko = spaced(toKo(ja)); cache.set(ja, ko); } }
      else if (p.ref) ko = /^[0-9]+$/.test(p.ref) ? "국도 " + p.ref + "호" : p.ref; else continue;
    }
    if (p.ref && /^[A-Z][A-Za-z0-9\-]*$/.test(p.ref) && (p.kind === "motorway" || p.kind === "trunk") && !ko.includes(p.ref)) ko = ko + " (" + p.ref + ")";
    for (const part of f.loadGeometry()) {
      if (part.length < 2) continue;
      if (part.every((q) => q.x < 0 || q.x > E || q.y < 0 || q.y > E)) continue;
      const coords = part.map((q) => [+(lw + q.x / E * (le - lw)).toFixed(6), +(ln - q.y / E * (ln - ls)).toFixed(6)]);
      const key = ko + "|" + coords[0].join(",") + "|" + coords[coords.length - 1].join(",");
      if (seen.has(key)) continue; seen.add(key);
      buf.push(JSON.stringify({ type: "Feature", properties: { ko, kind: p.kind }, geometry: { type: "LineString", coordinates: coords } }));
      n++; if (ex.length < 20 && n % 3001 === 0) ex.push(ja + " -> " + ko);
    }
    if (buf.length > 20000) { fs.writeSync(w, buf.join("\n") + "\n"); buf = []; }
  }
}
if (buf.length) fs.writeSync(w, buf.join("\n") + "\n");
fs.closeSync(w);
console.log("written", n, "\n" + ex.join("\n"));
for (const s of ["明治通り", "青梅街道", "首都高速4号新宿線", "国道20号", "甲州街道", "山手通り", "新宿中央通り", "六本木通り", "環状七号線"]) console.log(s, "->", spaced(toKo(s)));
