// Where do hotel guests go? -> packs/tokyo/lodging-flows.json: for each Tokyo municipality with hotels, the share of its guests' daily outings that
// go to each Tokyo municipality, separately for leisure and business guests. Gravity model with FITTED parameters, not hand-picked ones:
//   P(j | i) = A_j * max(d_ij, MIN_KM)^-beta / sum_k (...)          d = km between the municipalities' demand.json points
//   leisure : A_j = NTT foreign visitors to j + w x NTT domestic visitors to j   (tourism.json, measured counts)
//   business: A_j = (1 - psi) x share of NTT foreign visitors + psi x share of jobs in j (demand.json, census jobs)
//   the parameters (w | psi, beta) are those whose predicted share of visits to each of the 24 named tourist areas best matches the foreign-visitor
//   survey answered by that purpose (tourism.json purposes: leisure 13,325 respondents, business incl. conferences 682), origins weighted by hotel rooms.
// outings per guest-night = the same survey by purpose: named areas visited / nights slept in Tokyo (tourism.json purposes[].namedAreasPerNight).
// Limits: only the 24 named areas are counted, foreign travellers' behaviour is applied to every guest of that purpose, and the business sample is small.
// Only hotels in Tokyo get flows (the measured visitor counts cover Tokyo's municipalities only).
// Usage: node scripts/tokyo-lodging-flows.mjs
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { readPackJson } from "./pack-json.mjs";
import { writeChecked } from "./safe-write.mjs";
const T = fileURLToPath(new URL("../packs/tokyo/", import.meta.url));
const MIN_KM = 2; // floor on distance: a hotel and a destination inside the same ward are not 0 km apart

const tourism = readPackJson(T + "tourism.json"), hotels = readPackJson(T + "hotels.json"), demand = readPackJson(T + "demand.json");
if (!tourism.purposes) throw new Error("tourism.json has no `purposes`: rerun scripts/tokyo-tourism.mjs");
const loc = {}, jobsOf = {};
for (const p of demand.points) { const c = p.jisCode ? String(p.jisCode).slice(0, 5) : String(p.code); loc[c] = p.location; jobsOf[c] = p.jobs ?? 0; }
const dests = Object.keys(tourism.municipalities).filter((c) => loc[c]);
const M = (c) => tourism.municipalities[c];
const norm = (v) => { const s = v.reduce((a, b) => a + b, 0); return v.map((x) => x / s); };
const F = dests.map((c) => M(c).foreign.all ?? 0), D = dests.map((c) => M(c).domestic.all ?? 0), J = dests.map((c) => jobsOf[c]);
const Fn = norm(F), Jn = norm(J);
const ATTRACT = { // purpose -> (param) -> attractiveness per destination
  leisure: (w) => F.map((f, k) => f + w * D[k]),
  business: (psi) => Fn.map((f, k) => (1 - psi) * f + psi * Jn[k]),
};
const PARAMS = { leisure: [0, 0.05, 0.1, 0.25, 0.5, 1], business: [0, 0.25, 0.5, 0.75, 1] }; // domestic weight w | jobs weight psi
const BETAS = Array.from({ length: 13 }, (_, k) => k * 0.25);
const km = (a, b) => {
  const r = Math.PI / 180, dx = (b[0] - a[0]) * r * Math.cos(((a[1] + b[1]) / 2) * r), dy = (b[1] - a[1]) * r;
  return 6371 * Math.hypot(dx, dy);
};
const rooms = {}; // origin municipality -> hotel rooms
for (const h of hotels.hotels) if (h.muni.startsWith("13") && loc[h.muni]) rooms[h.muni] = (rooms[h.muni] ?? 0) + h.rooms;
const origins = Object.keys(rooms), totalRooms = Object.values(rooms).reduce((a, b) => a + b, 0);
const dist = Object.fromEntries(origins.map((i) => [i, dests.map((j) => Math.max(km(loc[i], loc[j]), MIN_KM))]));
const probs = (purpose, param, beta) => {
  const A = ATTRACT[purpose](param);
  return Object.fromEntries(origins.map((i) => { const w = dests.map((j, k) => A[k] * Math.pow(dist[i][k], -beta)); return [i, norm(w)]; }));
};
const area = tourism.surveyAreas.filter((a) => a.wardCodes.length && a.wardCodes.every((c) => dests.includes(c)) && a.name in (tourism.purposes.leisure.visitedAreaShare));
const predict = (P) => norm(area.map((a) => origins.reduce((s, i) => s + (rooms[i] / totalRooms) * a.wardCodes.reduce((t, c) => t + P[i][dests.indexOf(c)], 0), 0)));
const corr = (x, y) => {
  const n = x.length, mx = x.reduce((a, b) => a + b) / n, my = y.reduce((a, b) => a + b) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let k = 0; k < n; k++) { sxy += (x[k] - mx) * (y[k] - my); sxx += (x[k] - mx) ** 2; syy += (y[k] - my) ** 2; }
  return sxy / Math.sqrt(sxx * syy);
};

const params = { minKm: MIN_KM }, originsOut = {}, report = [];
for (const purpose of ["leisure", "business"]) {
  const pp = tourism.purposes[purpose];
  const obs = norm(area.map((a) => pp.visitedAreaShare[a.name] ?? 0)), grid = [];
  for (const param of PARAMS[purpose]) for (const beta of BETAS) {
    const pred = predict(probs(purpose, param, beta));
    grid.push({ param, beta, sse: pred.reduce((s, x, k) => s + (x - obs[k]) ** 2, 0), r: corr(pred, obs) });
  }
  const best = grid.reduce((a, b) => (b.sse < a.sse ? b : a));
  const P = probs(purpose, best.param, best.beta), pred = predict(P);
  originsOut[purpose] = Object.fromEntries(origins.map((i) => [i, P[i].map((x) => Math.round(x * 1e4) / 1e4)]));
  params[purpose] = {
    beta: best.beta, [purpose === "leisure" ? "domesticWeight" : "jobsWeight"]: best.param, outingsPerGuestNight: pp.namedAreasPerNight,
    fit: { r: Math.round(best.r * 1000) / 1000, areas: area.length, respondents: pp.respondents, grid: grid.map((g) => ({ [purpose === "leisure" ? "domesticWeight" : "jobsWeight"]: g.param, beta: g.beta, sse: Math.round(g.sse * 1e5) / 1e5, r: Math.round(g.r * 1000) / 1000 })) },
  };
  const self = origins.reduce((s, i) => s + (rooms[i] / totalRooms) * P[i][dests.indexOf(i)], 0);
  report.push(`${purpose}: beta ${best.beta}, ${purpose === "leisure" ? "domesticWeight" : "jobsWeight"} ${best.param}, r ${best.r.toFixed(3)} (${area.length} areas, ${pp.respondents} respondents), ${pp.namedAreasPerNight} outings/night, ${(self * 100).toFixed(1)}% stay in own ward`
    + `\n   observed vs predicted: ` + area.map((a, k) => ({ a: a.name.split("・")[0], o: obs[k], p: pred[k] })).sort((x, y) => y.o - x.o).slice(0, 6).map((x) => `${x.a} ${(x.o * 100).toFixed(0)}/${(x.p * 100).toFixed(0)}`).join(" | "));
}

const out = {
  formatVersion: 2, year: tourism.year,
  note: "P(destination j | hotel in municipality i) for Tokyo hotels, per guest purpose: distance^-beta x attractiveness (leisure: NTT foreign + w x domestic visitors; business: mix of foreign-visitor share and jobs share), normalised. "
    + "Parameters are fitted so the predicted share of visits to the 24 named areas matches the foreign-visitor survey answered by that purpose (tourism.json purposes), not chosen by hand. outingsPerGuestNight = named-area visits per night slept in Tokyo from the same survey. "
    + "Limits: only the 24 named areas are counted, foreign travellers' behaviour stands in for every guest of that purpose, the business sample is small, the destination is a municipality (its demand point), hotels outside Tokyo have no flows.",
  params, destinations: dests, origins: originsOut,
};
writeChecked(T + "lodging-flows.json", JSON.stringify(out), { count: (j) => Object.keys(j.origins.leisure).length, label: "origin municipalities" });
console.log(report.join("\n"));
console.log(`${origins.length} origins x ${dests.length} destinations, ${(fs.statSync(T + "lodging-flows.json").size / 1024).toFixed(0)} KB`);
