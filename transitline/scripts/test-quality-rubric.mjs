// node scripts/test-quality-rubric.mjs - the rubric implementation must reproduce the registry's published worked example.
import { computeQuality, checkAnswers, LADDERS } from "./quality-rubric.mjs";
let fail = 0;
const check = (ok, msg) => { console.log(ok ? "ok  " : "FAIL", msg); if (!ok) fail++; };

// Registry docs/data-quality.md, "JP" row (Yukina): raw composite 0.76, weighted 0.81, tier Very high; pillars workplace 0.77 / resident 0.77 / O/D 0.70 (raw).
const jp = { workplace_count: "physical_measured", workplace_granularity: "mesh_500", workplace_resolution: "mesh_250", workplace_intensity: "measured_per_unit",
  resident_count: "employed_residents", resident_granularity: "adm4", resident_resolution: "mesh_250", resident_intensity: "measured_per_unit", od_metric: "full_matrix", od_granularity: "adm3" };
const c = computeQuality(jp);
check(c.raw_score.toFixed(2) === "0.76", `JP raw composite 0.76 (got ${c.raw_score})`);
check(c.weighted_score.toFixed(2) === "0.81", `JP weighted composite 0.81 (got ${c.weighted_score})`);
check(c.tier === "very-high" && c.grade === "A", "JP tier very-high (A)");
check([c.pillars.workplace.raw, c.pillars.resident.raw, c.pillars.od.raw].map((x) => x.toFixed(2)).join() === "0.77,0.77,0.70", "JP raw pillars 0.77 / 0.77 / 0.70");

// floor and monotonicity
const worst = { workplace_count: "none", workplace_granularity: "none", workplace_resolution: "admin_polygon", workplace_intensity: "uniform", resident_count: "none", resident_granularity: "none", resident_resolution: "admin_polygon", resident_intensity: "uniform", od_metric: "none", od_granularity: null };
check(computeQuality(worst).tier === "absent", "no census anchor anywhere -> absent (F)");
check(computeQuality({ ...jp, od_granularity: null }).weighted_score > computeQuality({ ...jp, od_granularity: "adm3" }).weighted_score, "null O/D granularity applies no G penalty");
for (const [k, ladder] of Object.entries({ resident_count: "resident_count", workplace_count: "workplace_count" })) {
  const vals = Object.values(LADDERS[ladder]);
  check(vals.every((v, i) => i === 0 || v <= vals[i - 1]), `${k} ladder is ordered best -> worst`);
}
// validation
check(checkAnswers({ ...jp, workplace_resolution: "building_modeled" }).length === 1, "an invented value is rejected");
check(checkAnswers({ ...jp, extra: 1 }).length === 1, "an unknown question is rejected");
check(checkAnswers({ ...jp, od_granularity: undefined }).length === 1, "a missing answer is rejected");
process.exit(fail ? 1 : 0);
