// Chome-level, game-native `demand_data.chome.json`: the granularity (~12,900 points for Tokyo) and the internal
// rules of the demand file the real game ships for its own built-in Tokyo (TOK).
//
// The real game's file follows rules our first attempt broke (measured 2026-09-23/24 on the installed TOK file,
// read locally for comparison only - see subway-builder-export/README.md):
//   1. every pop is exactly 200 people (82,662 of 82,662), duplicates of the same (residence, job) pair allowed;
//   2. every point's `residents` and `jobs` equal the sum of pop sizes that name it as residence / job (100%);
//   3. no pop has residenceId === jobId (0 of 82,662);
//   4. no point has both residents and jobs at 0.
// This exporter produces those properties by construction.
//
// What is real: the municipality-to-municipality commuter flows (2020 census, od.json) and the chome-level
// weights that decide where inside each municipality they live/work (employed residents, employed.json; workers
// by workplace, jobs.json/jobs-<pref>.json - all census/Economic-Census small-area tables).
// What is MODELED (flagged, not measured): the chome-to-chome split itself - our O/D source is only measured at
// municipality granularity - and the quantisation into 200-person pops. Each municipality-pair flow of N people is
// N/200 pop-units, spread over chome pairs in proportion to (origin chome's employed residents x destination
// chome's workers) by SYSTEMATIC sampling carried along one global ordering, so
//   - every chome pair's expected units equal its exact share (no top-K truncation bias toward big chomes),
//   - the running error never exceeds one unit, hence every municipality pair (and every prefix of the ordering)
//     is within 200 people of od.json, and the overall total is preserved to within 200 people.
// This is the same "real aggregate spread over finer real units by a real proxy" technique this project already
// uses for buildings (job-coefficients.json) and hidden census cells (tokyo-employed.mjs).
//
// Dropped, and reported: flows that cannot be placed without a same-point pop. Inside a municipality the
// same-chome share is removed and renormalised over the other chome pairs (commuting from a chome to itself is
// not a trip between two points). Tokyo's 30 Tama-area municipalities have chome-level data since 2026-09-25
// (subward-tama.json / jobs-tama.json, scripts/tama-*.mjs; employed.json covers them). A municipality without
// chome data would still become ONE point and lose its within-municipality flow.
//
// Driving distance/time come from subway-builder-driving.mjs (calibrated against the real file's medians).
// Usage: node --max-old-space-size=4096 scripts/export-subway-builder-demand-chome.mjs
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { drivingFor } from "./subway-builder-driving.mjs";
import { writeChecked } from "./safe-write.mjs";
const T = fileURLToPath(new URL("../packs/tokyo/", import.meta.url));
const OUT = fileURLToPath(new URL("../subway-builder-export/", import.meta.url));
fs.mkdirSync(OUT, { recursive: true });

const UNIT = 200;
const rd = (f) => JSON.parse(fs.readFileSync(T + f, "utf8"));
const sw = [rd("subward.json"), rd("subward-saitama.json"), rd("subward-chiba.json"), rd("subward-kanagawa.json"), rd("subward-tama.json")];
const jobsFiles = [rd("jobs.json"), rd("jobs-saitama.json"), rd("jobs-chiba.json"), rd("jobs-kanagawa.json"), rd("jobs-tama.json")];
const employed = rd("employed.json");
const od = rd("od.json").origins;
const demand242 = rd("demand.json");
const code242 = (p) => (p.jisCode !== undefined ? String(p.jisCode).slice(0, 5) : p.code);
const muniIds = new Set(demand242.points.map(code242));

// ---- chome table: location + the two proxy weights; muni -> its chomes (file order = deterministic) ----
const chome = new Map(), muniChomes = new Map();
for (const swf of sw) for (const w of Object.values(swf.wards)) {
  const muni = String(w.estat_code);
  if (!muniIds.has(muni)) continue;
  const list = muniChomes.get(muni) ?? muniChomes.set(muni, []).get(muni);
  for (const a of w.areas) {
    const code = String(a.code);
    const jobsW = jobsFiles.map((j) => j.areas[code]?.w).find((v) => v !== undefined) ?? 0;
    chome.set(code, { location: a.location, ow: employed.areas[code] ?? 0, dw: jobsW, muni });
    list.push(code);
  }
}
const singlePointMunis = [];
for (const p of demand242.points) {
  const m = code242(p);
  if (muniChomes.has(m)) continue;
  chome.set(m, { location: p.location, ow: p.residents ?? 0, dw: p.jobs ?? 0, muni: m }); // weights only matter relative within a municipality: one point -> irrelevant
  muniChomes.set(m, [m]);
  singlePointMunis.push(m);
}
for (const m of muniIds) if (!muniChomes.has(m)) throw new Error(`municipality ${m} has no chomes - coverage gap`);
console.log(`chome table: ${chome.size} points (${singlePointMunis.length} single-point Tama-area municipalities), ${muniChomes.size}/${muniIds.size} municipalities`);

// ---- systematic sampling of pop-units over chome pairs, one global ordering ----
const pops = []; // {id,size,residenceId,jobId,drivingSeconds,drivingDistance}
const resUnits = new Map(), jobUnits = new Map();
let cum = 0;               // running expected units so far (all placed flows)
const OFFSET = 0.5;
const dropped = { flows: 0, workers: 0, tamaSelfWorkers: 0 };
let placedWorkers = 0;
const perFlow = new Map();  // "O>D" -> units emitted, kept for the report

function placeFlow(oMuni, dMuni, N) {
  if (!(N > 0)) return;
  const oc = muniChomes.get(oMuni), dc = muniChomes.get(dMuni);
  let sumO = 0, sumD = 0, diag = 0;
  for (const c of oc) sumO += chome.get(c).ow;
  for (const c of dc) sumD += chome.get(c).dw;
  if (oMuni === dMuni) for (const c of oc) diag += chome.get(c).ow * chome.get(c).dw;
  const sumW = sumO * sumD - diag; // total weight of all pairs with residence !== job
  if (!(sumW > 0)) {
    dropped.flows++; dropped.workers += N;
    if (oMuni === dMuni && singlePointMunis.includes(oMuni)) dropped.tamaSelfWorkers += N;
    return;
  }
  placedWorkers += N;
  const unitsTotal = N / UNIT;
  const scale = unitsTotal / sumW;
  let flowUnits = 0;
  for (const a of oc) {
    const ca = chome.get(a);
    if (!(ca.ow > 0)) continue;
    for (const b of dc) {
      if (a === b) continue;
      const cb = chome.get(b);
      if (!(cb.dw > 0)) continue;
      const u = ca.ow * cb.dw * scale;
      const before = Math.floor(cum + OFFSET);
      cum += u;
      const n = Math.floor(cum + OFFSET) - before;
      if (n > 0) {
        const d = drivingFor(ca.location, cb.location);
        for (let k = 0; k < n; k++) pops.push({ id: String(pops.length), size: UNIT, residenceId: a, jobId: b, ...d });
        resUnits.set(a, (resUnits.get(a) || 0) + n);
        jobUnits.set(b, (jobUnits.get(b) || 0) + n);
        flowUnits += n;
      }
    }
  }
  perFlow.set(oMuni + ">" + dMuni, flowUnits);
}

const t0 = Date.now();
let processed = 0;
for (const [oMuni, r] of Object.entries(od)) {
  placeFlow(oMuni, oMuni, r.self);
  for (const [dMuni, n] of Object.entries(r.dest)) placeFlow(oMuni, dMuni, n);
  if (++processed % 60 === 0) console.log(`  ${processed}/${Object.keys(od).length} municipalities (${((Date.now() - t0) / 1000).toFixed(0)}s, ${pops.length} pops)`);
}

// ---- points: exactly the chomes some pop touches; residents/jobs derived from pops (rule 2) ----
const popIdsByPoint = new Map();
const ref = (pt, id) => (popIdsByPoint.get(pt) ?? popIdsByPoint.set(pt, []).get(pt)).push(id);
for (const p of pops) { ref(p.residenceId, p.id); ref(p.jobId, p.id); }
const points = [];
let unused = 0;
for (const [id, c] of chome) {
  const residents = (resUnits.get(id) || 0) * UNIT, jobs = (jobUnits.get(id) || 0) * UNIT;
  if (residents === 0 && jobs === 0) { unused++; continue; } // rule 4
  points.push({ id, location: c.location, jobs, residents, popIds: popIdsByPoint.get(id) ?? [] });
}
const outPath = OUT + "demand_data.chome.json";
writeChecked(outPath, JSON.stringify({ points, pops }), { label: "points", count: (j) => j.points.length });

const totalOd = Object.values(od).reduce((s, r) => s + r.workers, 0);
const placedPeople = pops.length * UNIT;
console.log({
  points: points.length, pops: pops.length, unusedChomesDropped: unused,
  peoplePlaced: placedPeople, odWorkersTotal: totalOd, odWorkersInPlacedFlows: placedWorkers,
  placedVsFlowsError: placedPeople - placedWorkers,
  droppedFlows: dropped.flows, droppedWorkers: dropped.workers, ofWhichTamaSelfCommutes: dropped.tamaSelfWorkers,
  seconds: ((Date.now() - t0) / 1000).toFixed(1), bytes: fs.statSync(outPath).size,
});
