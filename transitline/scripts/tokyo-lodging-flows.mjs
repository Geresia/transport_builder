// Where do hotel guests go? -> packs/tokyo/lodging-flows.json: for each Tokyo municipality with hotels, the share of its guests' daily outings that
// go to each Tokyo municipality. Gravity model, with the distance exponent FITTED to measured data instead of picked:
//   attractiveness A_j = NTT foreign visitors to j + w x NTT domestic visitors to j (whole year, tourism.json) - measured counts
//   P(j | i) = A_j * max(d_ij, MIN_KM)^-beta / sum_k (...)          d = km between the municipalities' demand.json points
//   (w, beta) = the pair whose predicted share of visits to each of the 24 named tourist areas best matches the foreign-visitor survey
//          (tourism.json gateways: share of respondents who visited each area), weighting origins by hotel rooms.
// tripsPerGuestNight = the same survey: named areas visited per respondent / nights slept in Tokyo (0.835; 15,296 respondents, 6.66 nights, 5.56 areas).
//   Only outings to the 24 named areas are counted, and foreign tourists' behaviour is applied to every guest - both are limits, see the note.
// Only hotels in Tokyo get flows (the measured attractiveness covers Tokyo's municipalities only).
// Usage: node scripts/tokyo-lodging-flows.mjs
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { readPackJson } from "./pack-json.mjs";
import { writeChecked } from "./safe-write.mjs";
const T = fileURLToPath(new URL("../packs/tokyo/", import.meta.url));
const MIN_KM = 2; // floor on distance: a hotel and a destination inside the same ward are not 0 km apart
const TRIPS_PER_GUEST_NIGHT = 0.835; // from the foreign survey, see above (scripts/tokyo-tourism.mjs reads the same microdata; re-derive there if the year changes)

const tourism = readPackJson(T + "tourism.json"), hotels = readPackJson(T + "hotels.json"), demand = readPackJson(T + "demand.json");
const loc = {};
for (const p of demand.points) loc[p.jisCode ? String(p.jisCode).slice(0, 5) : String(p.code)] = p.location;
const dests = Object.keys(tourism.municipalities).filter((c) => loc[c]);
const attract = (w) => dests.map((c) => (tourism.municipalities[c].foreign.all ?? 0) + w * (tourism.municipalities[c].domestic.all ?? 0));
const km = (a, b) => {
  const r = Math.PI / 180, dx = (b[0] - a[0]) * r * Math.cos(((a[1] + b[1]) / 2) * r), dy = (b[1] - a[1]) * r;
  return 6371 * Math.hypot(dx, dy);
};
const rooms = {}; // origin municipality -> hotel rooms
for (const h of hotels.hotels) if (h.muni.startsWith("13") && loc[h.muni]) rooms[h.muni] = (rooms[h.muni] ?? 0) + h.rooms;
const origins = Object.keys(rooms);
const dist = Object.fromEntries(origins.map((i) => [i, dests.map((j) => Math.max(km(loc[i], loc[j]), MIN_KM))]));
const probs = (beta, dw) => Object.fromEntries(origins.map((i) => {
  const A = attract(dw), w = dests.map((j, k) => A[k] * Math.pow(dist[i][k], -beta)), s = w.reduce((a, b) => a + b, 0);
  return [i, w.map((x) => x / s)];
}));

// observed: share of respondents who visited each named area, averaged over entry airports by respondents (foreign survey)
const area = tourism.surveyAreas.filter((a) => a.wardCodes.length && a.wardCodes.every((c) => dests.includes(c)));
const nResp = tourism.gateways.reduce((s, g) => s + g.respondents, 0);
const obsRaw = area.map((a) => tourism.gateways.reduce((s, g) => s + g.respondents * (g.visitedAreaShare[a.name] ?? 0), 0) / nResp);
const norm = (v) => { const s = v.reduce((a, b) => a + b, 0); return v.map((x) => x / s); };
const obs = norm(obsRaw), totalRooms = Object.values(rooms).reduce((a, b) => a + b, 0);
const predict = (P) => norm(area.map((a) => origins.reduce((s, i) => s + (rooms[i] / totalRooms) * a.wardCodes.reduce((t, c) => t + P[i][dests.indexOf(c)], 0), 0)));
const corr = (x, y) => {
  const n = x.length, mx = x.reduce((a, b) => a + b) / n, my = y.reduce((a, b) => a + b) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let k = 0; k < n; k++) { sxy += (x[k] - mx) * (y[k] - my); sxx += (x[k] - mx) ** 2; syy += (y[k] - my) ** 2; }
  return sxy / Math.sqrt(sxx * syy);
};
const grid = [];
for (const dw of [0, 0.05, 0.1, 0.25, 0.5, 1]) for (let b = 0; b <= 3.001; b += 0.25) {
  const pred = predict(probs(b, dw));
  grid.push({ dw, beta: Math.round(b * 100) / 100, sse: pred.reduce((s, x, k) => s + (x - obs[k]) ** 2, 0), r: corr(pred, obs) });
}
const best = grid.reduce((a, b) => (b.sse < a.sse ? b : a));
const P = probs(best.beta, best.dw);
const self = origins.reduce((s, i) => s + (rooms[i] / totalRooms) * P[i][dests.indexOf(i)], 0);
const top = (k) => [...origins].sort((a, b) => rooms[b] - rooms[a]).slice(0, k);

const out = {
  formatVersion: 1, year: tourism.year,
  note: "P(destination j | hotel in municipality i) for Tokyo hotels: (NTT foreign visitors to j + domesticWeight x domestic visitors) x distance^-beta, normalised. beta and domesticWeight are fitted so the predicted share of visits to the 24 named tourist areas matches the foreign-visitor survey "
    + "(tourism.json gateways), not chosen by hand. tripsPerGuestNight = named-area visits per respondent / nights in Tokyo from that survey: it counts only the 24 named areas and applies foreign tourists' behaviour to every guest "
    + "(business travellers and Japanese guests move differently). Hotels outside Tokyo have no flows. Distances are between municipality demand points, so the destination is a municipality, not a place inside it.",
  params: { beta: best.beta, domesticWeight: best.dw, minKm: MIN_KM, tripsPerGuestNight: TRIPS_PER_GUEST_NIGHT, fit: { r: Math.round(best.r * 1000) / 1000, areas: area.length, grid: grid.map((g) => ({ domesticWeight: g.dw, beta: g.beta, sse: Math.round(g.sse * 1e5) / 1e5, r: Math.round(g.r * 1000) / 1000 })) } },
  destinations: dests,
  origins: Object.fromEntries(origins.map((i) => [i, P[i].map((x) => Math.round(x * 1e4) / 1e4)])),
};
writeChecked(T + "lodging-flows.json", JSON.stringify(out), { count: (j) => Object.keys(j.origins).length, label: "origin municipalities" });
console.log(`beta ${best.beta}, domesticWeight ${best.dw}, r ${best.r.toFixed(3)} over ${area.length} areas; ${origins.length} origins x ${dests.length} destinations; share of outings staying in the hotel's own municipality ${(self * 100).toFixed(1)}%`);
for (const dw of [0, 0.05, 0.1, 0.25, 0.5, 1]) console.log("dw", dw, "r by beta:", grid.filter((g) => g.dw === dw).map((g) => `${g.beta}:${g.r.toFixed(2)}`).join(" "));
const names = (c) => tourism.municipalities[c].name;
console.log("observed vs predicted share (top areas):", area.map((a, k) => ({ a: a.name, obs: obs[k], pred: predict(P)[k] })).sort((x, y) => y.obs - x.obs).slice(0, 8).map((x) => `${x.a} ${(x.obs * 100).toFixed(1)}/${(x.pred * 100).toFixed(1)}`).join(" | "));
for (const i of top(3)) console.log(names(i), "->", dests.map((j, k) => [names(j), P[i][k]]).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([n, p]) => `${n} ${(p * 100).toFixed(0)}%`).join(", "));
console.log((fs.statSync(T + "lodging-flows.json").size / 1024).toFixed(0), "KB");
