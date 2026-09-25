// Chome-level (町丁・字等) residents + boundaries for Tokyo's 30 Tama-area municipalities -> packs/tokyo/subward-tama.json.
// Same shape as subward-kanagawa.json etc. Source: NII Geoshape 令和2年国勢調査 小地域 (e-Stat 境界 + 人口・世帯), CC BY 4.0,
//   https://geoshape.ex.nii.ac.jp/ka/topojson/2020/13/r2ka<5-digit municipality code>.topojson  (cached in data-raw/tama/).
// The chome residents must add up to demand.json's municipality total (both are raw 2020 census); the script refuses to write otherwise.
// reading_kana is not filled in here (the 23-ward/3-prefecture files got it from Japan Post's zip code CSV).
// Usage: node scripts/tama-subward.mjs
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { readPackJson } from "./pack-json.mjs";
import { writeChecked } from "./safe-write.mjs";
const T = fileURLToPath(new URL("../packs/tokyo/", import.meta.url));
const RAW = fileURLToPath(new URL("../data-raw/tama/", import.meta.url));
fs.mkdirSync(RAW, { recursive: true });

const demand = readPackJson(T + "demand.json");
const tama = demand.points.filter((p) => p.code && String(p.code).startsWith("13") && Number(p.code) > 13123);
if (tama.length !== 30) throw new Error(`expected 30 Tama-area municipalities in demand.json, found ${tama.length}`);

async function topo(code) {
  const f = `${RAW}r2ka${code}.topojson`;
  if (!fs.existsSync(f)) {
    const r = await fetch(`https://geoshape.ex.nii.ac.jp/ka/topojson/2020/13/r2ka${code}.topojson`);
    if (!r.ok) throw new Error(`geoshape ${code}: HTTP ${r.status}`);
    fs.writeFileSync(f, Buffer.from(await r.arrayBuffer()));
  }
  const t = JSON.parse(fs.readFileSync(f, "utf8"));
  if (t.transform) throw new Error(`${code}: topojson has a quantization transform; decoder does not handle it`);
  return t;
}

// arcs are absolute lon/lat (no `transform`); a ring is its arcs joined end to start, a negative index (~i) means arc i reversed.
function ring(t, idxs) {
  const pts = [];
  for (const i of idxs) {
    const a = i >= 0 ? t.arcs[i] : t.arcs[~i].slice().reverse();
    for (let k = pts.length ? 1 : 0; k < a.length; k++) pts.push(a[k]);
  }
  return pts.map(([x, y]) => [Math.round(x * 1e5) / 1e5, Math.round(y * 1e5) / 1e5]);
}

const wards = {};
let areas = 0, residents = 0;
for (const p of tama) {
  const code = String(p.code), t = await topo(code);
  const list = [];
  for (const g of t.objects.town.geometries) {
    const pr = g.properties;
    if (pr.JINKO == null) throw new Error(`${pr.KEY_CODE}: no JINKO`);
    const polys = g.type === "Polygon" ? [g.arcs] : g.arcs;
    list.push({
      code: pr.KEY_CODE, name_ja: pr.S_NAME, residents: pr.JINKO, households: pr.SETAI, area_m2: pr.AREA,
      location: [pr.X_CODE, pr.Y_CODE], polygons: polys.map((poly) => poly.map((r) => ring(t, r))),
    });
  }
  // The source has one feature per disjoint piece (飛び地) of a chome, all with the same KEY_CODE. Merge them: sums for
  // residents/households/area, all polygons kept, the label point of the most-populated (then largest) piece.
  const byCode = new Map();
  for (const a of list) {
    const m = byCode.get(a.code);
    if (!m) { byCode.set(a.code, { ...a, _best: [a.residents, a.area_m2] }); continue; }
    m.residents += a.residents; m.households += a.households; m.area_m2 += a.area_m2; m.polygons.push(...a.polygons);
    if (a.residents > m._best[0] || (a.residents === m._best[0] && a.area_m2 > m._best[1])) { m.location = a.location; m._best = [a.residents, a.area_m2]; }
  }
  const merged = [...byCode.values()].map(({ _best, ...a }) => ({ ...a, area_m2: Math.round(a.area_m2 * 10) / 10 }));
  const sum = merged.reduce((s, a) => s + a.residents, 0);
  if (sum !== p.residents) throw new Error(`${code} ${p.name}: chome residents ${sum} != demand.json residents ${p.residents}`);
  wards[code] = { name: p.name, estat_code: code, popDate: "2020", areas: merged };
  areas += merged.length; residents += sum;
}
writeChecked(T + "subward-tama.json", JSON.stringify({ formatVersion: 1, prefecture: "tokyo-tama", wards }), { label: "chomes", count: (j) => Object.values(j.wards).reduce((s, w) => s + w.areas.length, 0) });
console.log({ municipalities: tama.length, areas, residents });
