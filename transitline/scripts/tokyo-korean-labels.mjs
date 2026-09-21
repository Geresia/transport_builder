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
const spaced = (ko) => ko.replace(/(?<=\S)(초등학교|중학교|고등학교|고교|대학교|대학원|단기대학|유치원|어린이집|어린이공원|공원|녹지|광장|운동장|병원|종합병원|의원|클리닉|신사|체육관|도서관|미술관|박물관|호텔|빌딩|센터|타워)/g, " $1");

// ---- decode tiles
const open = (f) => { const fd = fs.openSync(f, "r"); return new PMTiles({ getKey: () => f, getBytes: async (o, l) => { const b = Buffer.alloc(l); fs.readSync(fd, b, 0, l, o); return { data: b.buffer.slice(b.byteOffset, b.byteOffset + l) }; } }); };
const Z = 14, x0 = 14480, x1 = 14620, y0 = 6230, y1 = 6520;
const t2lon = (x) => x / 2 ** Z * 360 - 180;
const t2lat = (y) => { const n = Math.PI - 2 * Math.PI * y / 2 ** Z; return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))); };
async function eachFeature(file, layer, cb) {
  const pm = open(file); let n = 0;
  for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) {
    const r = await pm.getZxy(Z, tx, ty); if (!r) continue;
    const L = new VectorTile(new PbfReader(new Uint8Array(r.data))).layers[layer]; if (!L) continue;
    const lw = t2lon(tx), le = t2lon(tx + 1), ln = t2lat(ty), ls = t2lat(ty + 1), E = L.extent;
    for (let i = 0; i < L.length; i++) {
      const f = L.feature(i); if (f.type !== 3) continue;
      const b = [Infinity, Infinity, -Infinity, -Infinity];
      for (const ring of f.loadGeometry()) for (const p of ring) { const lon = lw + p.x / E * (le - lw), lat = ln - p.y / E * (ln - ls); b[0] = Math.min(b[0], lon); b[1] = Math.min(b[1], lat); b[2] = Math.max(b[2], lon); b[3] = Math.max(b[3], lat); }
      cb(f.properties, b); n++;
    }
  }
  return n;
}
const near = (a, b, d) => a[0] - d <= b[2] && b[0] - d <= a[2] && a[1] - d <= b[3] && b[1] - d <= a[3];
const groups = []; // {key, p, b}
const byKey = new Map();
function add(key, p, b, cls) {
  let list = byKey.get(key); if (!list) byKey.set(key, list = []);
  const hits = list.filter((g) => near(g.b, b, 0.0004));
  if (hits.length === 0) { const g = { p, b: [...b], cls }; list.push(g); groups.push(g); return; }
  const g = hits[0];
  for (const h of hits.slice(1)) { g.b = [Math.min(g.b[0], h.b[0]), Math.min(g.b[1], h.b[1]), Math.max(g.b[2], h.b[2]), Math.max(g.b[3], h.b[3])]; h.dead = true; list.splice(list.indexOf(h), 1); }
  g.b = [Math.min(g.b[0], b[0]), Math.min(g.b[1], b[1]), Math.max(g.b[2], b[2]), Math.max(g.b[3], b[3])];
}
console.log("areas ...");
console.log(await eachFeature(PACK + "areas.pmtiles", "area", (p, b) => { if (!["park", "education", "hospital"].includes(p.cls)) return; if (!p.name && !p.name_ko) return; add((p.name_ko || p.name) + "|" + p.cls, p, b, p.cls); }));
console.log("buildings ...");
console.log(await eachFeature(PACK + "building-labels.pmtiles", "label", (p, b) => { if (!p.name && !p.name_ko) return; add((p.name_ko || p.name) + "|building", p, b, "building"); }));
const live = groups.filter((g) => !g.dead && /[^0-9\s.,/()\-–—]/.test((g.p.name_ko || g.p.name) || ""));
console.log("label groups", live.length);

const cache = new Map();
const w = fs.openSync(OUT, "w"); let buf = [], n = 0, ex = [];
for (const g of live) {
  const ja = g.p.name || g.p.name_ko;
  let ko = g.p.name_ko;
  if (!ko) { ko = cache.get(ja); if (ko === undefined) { ko = spaced(toKo(ja)); cache.set(ja, ko); } }
  if (ex.length < 25 && n % 997 === 0) ex.push(ja + " -> " + ko);
  const size = (g.b[2] - g.b[0]) * (g.b[3] - g.b[1]) * 1e6;
  buf.push(JSON.stringify({ type: "Feature", properties: { ko, ja, cls: g.cls, size: +size.toFixed(2) }, geometry: { type: "Point", coordinates: [+((g.b[0] + g.b[2]) / 2).toFixed(6), +((g.b[1] + g.b[3]) / 2).toFixed(6)] } }));
  n++; if (buf.length > 20000) { fs.writeSync(w, buf.join("\n") + "\n"); buf = []; }
}
if (buf.length) fs.writeSync(w, buf.join("\n") + "\n");
fs.closeSync(w);
console.log("written", n, "\n" + ex.join("\n"));
for (const s of ["渋谷区立千駄谷小学校", "港区立本村公園", "北里大学薬学部", "桜十字白金リハビリテーション病院", "代々木公園", "明治神宮", "さいたま市立仲本小学校", "本太2丁目第2公園"]) console.log(s, "->", spaced(toKo(s)));
