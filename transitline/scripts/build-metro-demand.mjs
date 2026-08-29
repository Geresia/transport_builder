import { readFileSync, writeFileSync } from "node:fs";
const SP = process.argv[2];
// argv[3]: comma-separated region codes, each either a 2-digit 시도 or a 5-digit
// 시군구 (so a build can pull a whole province or a single city). Default = 수도권.
const SCOPE = new Set((process.argv[3] || "11,28,41").split(","));
const inScope = (code) => SCOPE.has(code.slice(0, 2)) || SCOPE.has(code.slice(0, 5));

// ---- population: EUC-KR CSV, join key = 행정기관코드 (10 digits) == adm_cd2
const csv = new TextDecoder("euc-kr").decode(readFileSync(`${SP}/pop.csv`));
const rows = csv.split(/\r?\n/).filter((l) => l.trim());
const head = rows[0].split(",");
const iCode = head.indexOf("행정기관코드"), iTot = head.indexOf("계");
const iSido = head.indexOf("시도명"), iSgg = head.indexOf("시군구명"), iDong = head.indexOf("읍면동명");
const pop = new Map();
let popMetro = 0;
for (const line of rows.slice(1)) {
  const c = line.split(",");
  const code = c[iCode]?.trim();
  if (!code) continue;
  const rec = { total: Number(c[iTot]) || 0, sido: c[iSido], sgg: c[iSgg], dong: c[iDong] };
  pop.set(code, rec);
  if (inScope(code)) popMetro++;
}

// ---- geometry
const gj = JSON.parse(readFileSync(`${SP}/hjd.geojson`, "utf8"));
const metro = gj.features.filter(
  (f) => SCOPE.has(String(f.properties.sido)) || SCOPE.has(String(f.properties.sgg)),
);

// 출장소 rows carry population but have no boundary of their own — their people
// live inside the parent 읍/면 polygon. Fold each into the boundary whose 읍/면
// name it starts with, in the same 시군구, so the count is not silently dropped.
// (다사읍서재출장소 = 37k people; not trivial.)
const metroCodes = new Set(metro.map((f) => String(f.properties.adm_cd2)));
let folded = 0;
for (const [code, rec] of pop) {
  if (!inScope(code) || metroCodes.has(code)) continue;
  const parent = metro
    .map((f) => pop.get(String(f.properties.adm_cd2)))
    .find((p) => p && p.sgg === rec.sgg && rec.dong.startsWith(p.dong) && rec.dong !== p.dong);
  if (parent) { parent.total += rec.total; folded += rec.total; pop.delete(code); }
}
if (folded) console.log(`folded ${folded} people from 출장소 rows into parent 읍/면`);

// Area via local equirectangular projection (metres), shoelace per ring.
const R = 6378137;
const areaKm2 = (rings) => {
  let total = 0;
  for (const [ri, ring] of rings.entries()) {
    const lat0 = (ring.reduce((a, p) => a + p[1], 0) / ring.length) * Math.PI / 180;
    const kx = (Math.PI / 180) * R * Math.cos(lat0), ky = (Math.PI / 180) * R;
    let s = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      s += (ring[j][0] * kx) * (ring[i][1] * ky) - (ring[i][0] * kx) * (ring[j][1] * ky);
    }
    total += (ri === 0 ? 1 : -1) * Math.abs(s / 2); // ring 0 outer, rest holes
  }
  return total / 1e6;
};

// Douglas-Peucker in degrees, tolerance scaled so it is ~uniform in metres.
const perpDist = (p, a, b) => {
  const kx = Math.cos(a[1] * Math.PI / 180);
  const x = (p[0] - a[0]) * kx, y = p[1] - a[1];
  const bx = (b[0] - a[0]) * kx, by = b[1] - a[1];
  const L = bx * bx + by * by;
  if (L === 0) return Math.hypot(x, y);
  const t = Math.max(0, Math.min(1, (x * bx + y * by) / L));
  return Math.hypot(x - bx * t, y - by * t);
};
const dp = (pts, tol) => {
  if (pts.length < 3) return pts;
  let idx = 0, max = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = perpDist(pts[i], pts[0], pts[pts.length - 1]);
    if (d > max) { max = d; idx = i; }
  }
  if (max <= tol) return [pts[0], pts[pts.length - 1]];
  return [...dp(pts.slice(0, idx + 1), tol).slice(0, -1), ...dp(pts.slice(idx), tol)];
};
const TOL = 0.00035; // ~35 m
const round = (p) => [Number(p[0].toFixed(4)), Number(p[1].toFixed(4))];

const out = [];
let noPop = 0, ptsBefore = 0, ptsAfter = 0;
const matchedCodes = new Set();
let minLon = 999, maxLon = -999, minLat = 999, maxLat = -999; // for the renderer's initial VIEW

for (const f of metro) {
  const code = String(f.properties.adm_cd2);
  const rec = pop.get(code);
  if (!rec) { noPop++; }
  else matchedCodes.add(code);

  // MultiPolygon must not be truncated — islands and 강화도 live in later polygons.
  const polys = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
  const keptPolys = [];
  let aKm2 = 0;
  for (const poly of polys) {
    aKm2 += areaKm2(poly);
    const simplified = poly
      .map((ring) => { ptsBefore += ring.length; const s = dp(ring, TOL).map(round); ptsAfter += s.length; return s; })
      .filter((ring) => ring.length >= 4);
    if (simplified.length) keptPolys.push(simplified);
  }
  if (!keptPolys.length || aKm2 <= 0) continue;
  for (const poly of keptPolys) for (const ring of poly) for (const p of ring) {
    if (p[0] < minLon) minLon = p[0]; if (p[0] > maxLon) maxLon = p[0];
    if (p[1] < minLat) minLat = p[1]; if (p[1] > maxLat) maxLat = p[1];
  }

  const total = rec ? rec.total : null;
  out.push({
    c: code,
    n: f.properties.adm_nm,
    sd: f.properties.sidonm,
    sg: f.properties.sggnm,
    p: total,
    a: Number(aKm2.toFixed(3)),
    d: total === null ? null : Math.round(total / aKm2),
    g: keptPolys,
  });
}

const orphanPop = [...pop.keys()].filter((k) => inScope(k) && !matchedCodes.has(k));
const withPop = out.filter((f) => f.p !== null);
const totalPop = withPop.reduce((a, f) => a + f.p, 0);
const dens = withPop.map((f) => f.d).sort((a, b) => a - b);

const report = {
  boundaries_metro: metro.length,
  rendered: out.length,
  boundaries_without_population: noPop,
  population_rows_metro: popMetro,
  population_rows_without_boundary: orphanPop.length,
  orphan_sample: orphanPop.slice(0, 6).map((k) => `${k} ${pop.get(k).sido} ${pop.get(k).sgg} ${pop.get(k).dong}`),
  folded_chuljangso: folded,
  total_population: totalPop,
  density_min: dens[0], density_median: dens[dens.length >> 1], density_max: dens[dens.length - 1],
  bbox: [minLon, minLat, maxLon, maxLat].map((v) => Number(v.toFixed(4))), // renderer VIEW start
  points_before: ptsBefore, points_after: ptsAfter,
  reduction: `${(100 * (1 - ptsAfter / ptsBefore)).toFixed(1)}%`,
};
console.log(JSON.stringify(report, null, 2));

writeFileSync(`${SP}/metro.json`, JSON.stringify({
  meta: { asOf: "2026-07-31", boundaryVersion: "20260701", ...report },
  features: out,
}));
console.log("metro.json MB:", (readFileSync(`${SP}/metro.json`).length / 1048576).toFixed(2));
