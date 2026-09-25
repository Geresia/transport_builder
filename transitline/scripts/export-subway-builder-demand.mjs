// Converts our real Tokyo data (demand.json + od.json) into the exact `demand_data.json` shape the
// Subway Builder game reads (DemandDataFile in compatibility-test-mod's src/types/index.d.ts, MIT-licensed
// API type definitions - reused here as a target format, not copied code).
//
//   points[]: { id, location, jobs, residents, popIds }
//   pops[]:   { id, size, residenceId, jobId, drivingSeconds, drivingDistance, drivingPath? }
//
// Confirmed 2026-09-23 against the real game's own installed Tokyo (TOK) demand_data.json (read locally for
// comparison only, never copied into this repo): no pop in that file - 0 of 82,662 - carries
// homeDepartureTime/workDepartureTime or drivingPath. Those fields exist only on game-state.d.ts's runtime
// `Pop` (what getDemandData() returns after the game computes them), not on this on-disk file's `Pop`. An
// earlier version of this script added fixed departure times, conflating the two types; removed.
//
// What's real: every point (242 municipalities), residents/jobs, and every pop's size (census O/D flow count).
// This is the EXACT-O/D reference file: pop sizes are the real census flow counts (not the game's fixed 200-person
// units), and point residents/jobs are the census values, not sums of pops - so it does not follow the real game's
// internal rules (see export-subway-builder-demand-chome.mjs, the game-native file the mod actually loads).
// What's approximated (flagged, not measured):
//   - drivingSeconds/drivingDistance: no routing engine on hand, so this is straight-line distance x a detour
//     factor / distance-dependent speed, calibrated on the real game's own medians (subway-builder-driving.mjs).
//     A real value needs OSRM/Valhalla over the actual road network.
//   - drivingPath: omitted (optional field) - would need the same routing engine.
// Excluded flows: `out` (commutes outside the 242-municipality region: no destination point to link to) and
// `unknown` (workplace not stated: no destination either). Both are real numbers, just not placeable as a pop
// without a destination point.
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { drivingFor } from "./subway-builder-driving.mjs";
const T = fileURLToPath(new URL("../packs/tokyo/", import.meta.url));
const OUT = fileURLToPath(new URL("../subway-builder-export/", import.meta.url));
fs.mkdirSync(OUT, { recursive: true });

const demand = JSON.parse(fs.readFileSync(T + "demand.json", "utf8"));
const od = JSON.parse(fs.readFileSync(T + "od.json", "utf8")).origins;
const code = (p) => (p.jisCode !== undefined ? String(p.jisCode).slice(0, 5) : p.code);

const byCode = new Map(demand.points.map((p) => [code(p), p]));
const points = demand.points.map((p) => ({ id: p.id, location: p.location, jobs: p.jobs ?? 0, residents: p.residents ?? 0, popIds: [] }));
const pointById = new Map(points.map((p) => [p.id, p]));

const pops = [];
let excludedOut = 0, excludedUnknown = 0, includedFlow = 0;
for (const [originCode, r] of Object.entries(od)) {
  const originPoint = byCode.get(originCode);
  if (!originPoint) throw new Error(`od.json origin ${originCode} has no matching demand point`);
  const legs = [[originCode, r.self]]; // same-municipality commute (residenceId === jobId)
  for (const [destCode, n] of Object.entries(r.dest)) legs.push([destCode, n]);
  excludedOut += r.out;
  excludedUnknown += r.unknown ?? 0;
  for (const [destCode, size] of legs) {
    if (!(size > 0)) continue;
    const destPoint = byCode.get(destCode);
    if (!destPoint) throw new Error(`od.json destination ${destCode} has no matching demand point`);
    const id = `pop-${originCode}-${destCode}`;
    pops.push({
      id,
      size,
      residenceId: originPoint.id,
      jobId: destPoint.id,
      ...drivingFor(originPoint.location, destPoint.location),
    });
    pointById.get(originPoint.id).popIds.push(id);
    if (destPoint.id !== originPoint.id) pointById.get(destPoint.id).popIds.push(id);
    includedFlow++;
  }
}

const file = { points, pops };
fs.writeFileSync(OUT + "demand_data.json", JSON.stringify(file));

const totalOd = Object.values(od).reduce((s, r) => s + r.workers, 0);
console.log({
  points: points.length,
  pops: pops.length,
  totalPopSize: pops.reduce((s, p) => s + p.size, 0),
  totalOdWorkers: totalOd,
  excludedOut,
  excludedUnknown,
  coverage: ((pops.reduce((s, p) => s + p.size, 0) / totalOd) * 100).toFixed(2) + "%",
});
