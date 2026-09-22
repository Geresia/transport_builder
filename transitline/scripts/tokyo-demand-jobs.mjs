// Fill demand.json's per-municipality `jobs` (workplace attractiveness for the engine's gravity model) from od.json:
// jobs(muni) = workers who WORK in muni, counted over the same 2020-census full O/D matrix that feeds destination choice
// (self-employed-here + everyone whose `dest` lands on muni). Consistent method across all 242 municipalities.
//
// Why not the Economic Census (jobs.json / jobs-<pref>.json, used for the building-level split in job-coefficients.json)?
// That table only covers Tokyo's 23 wards and the outer 3 prefectures - not Tokyo's 30 Tama-area municipalities, so it can't
// fill every point. Mixing sources would also create a step at the Tama boundary: OD-derived counts run ~30% below the
// Economic Census in the wards (documented in README: Chiyoda 792k O/D vs 1.20M Economic Census - commute survey vs
// establishment survey, a real methodological gap, not an error) - using OD everywhere keeps that gap uniform instead of
// concentrated at one edge. This `jobs` field feeds ONLY the engine's per-station gravity attractiveness; it is unrelated to
// job-coefficients.json's per-building split, which still fits to the Economic Census.
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { writeChecked } from "./safe-write.mjs";
const T = fileURLToPath(new URL("../packs/tokyo/", import.meta.url));
const demandPath = T + "demand.json";
const demand = JSON.parse(fs.readFileSync(demandPath, "utf8"));
const od = JSON.parse(fs.readFileSync(T + "od.json", "utf8")).origins;
const code = (p) => (p.jisCode !== undefined ? String(p.jisCode).slice(0, 5) : p.code);

const here = {};
for (const [o, r] of Object.entries(od)) { here[o] = (here[o] || 0) + r.self; for (const [dst, n] of Object.entries(r.dest)) here[dst] = (here[dst] || 0) + n; }
for (const p of demand.points) { const c = code(p); if (here[c] === undefined) throw new Error(`no O/D workplace count for ${p.id} (${c})`); }

let text = fs.readFileSync(demandPath, "utf8");
const parts = text.split(/(?="id":)/);
const out = parts.map((chunk, i) => {
  if (i === 0) return chunk;
  const m = chunk.match(/"(?:jisCode|code)":\s*"?(\d{5})/);
  const jobs = here[m[1]];
  if (/"jobs":/.test(chunk)) return chunk.replace(/"jobs":\s*\d+/, `"jobs":  ${jobs}`);
  return chunk.replace(/("residents":\s*\d+)/, `$1,\n                       "jobs":  ${jobs}`);
});
text = out.join("");
writeChecked(demandPath, text, { label: "points with jobs", count: (j) => j.points.filter((p) => p.jobs !== undefined).length });
const d2 = JSON.parse(text);
console.log("points", d2.points.length, "with jobs", d2.points.filter((p) => p.jobs !== undefined).length, "sum jobs", d2.points.reduce((s, p) => s + p.jobs, 0));
