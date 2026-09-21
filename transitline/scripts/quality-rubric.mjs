// Data-quality rubric used to self-assess a pack. The rubric itself (pillars, ladders, weights, tiers) is the
// Subway-Builder-Modded registry's published spec (registry docs/data-quality.md); this file is our own
// implementation of that spec so packs can be scored and compared on the same scale. The registry's code is GPL-3.0
// and is deliberately not copied - only the documented numbers are used.
//
//   pillar (weighted)  = (0.5*count + 0.5*R*I) * G      pillar (raw) = count * R * I * G
//   O/D pillar         = metric * G(od granularity)     (no split: raw == weighted)
//   score              = 0.50*workplace + 0.35*resident + 0.15*od
// The tier comes from the *weighted* composite.
export const RUBRIC_VERSION = 1;
export const PILLAR_WEIGHTS = { workplace: 0.5, resident: 0.35, od: 0.15 };

export const LADDERS = {
  workplace_count: { physical_measured: 1, physical_inferred: 0.85, registered_self_declared: 0.7, size_bands: 0.5, estimated_proxy: 0.3, none: 0 },
  resident_count: { employed_residents: 1, working_age: 0.7, total_population: 0.4, none: 0 },
  resolution: { exact_footprints: 1, mesh_125_or_adm5: 0.9, mesh_250: 0.85, mesh_500: 0.75, ml_hybrid_footprints: 0.7, osm_footprints: 0.6, mesh_1km: 0.5, admin_polygon: 0.3 },
  intensity: { measured_per_unit: 1, fine_types_calibrated: 0.85, fine_types_generic: 0.6, coarse_sector: 0.5, binary_split: 0.4, size_only: 0.25, uniform: 0.1 },
  granularity: { mesh_125: 1, mesh_250: 0.95, mesh_500: 0.9, mesh_1km: 0.85, mesh_coarse: 0.65, adm5: 0.95, adm4: 0.9, adm3: 0.7, adm2: 0.5, adm1: 0.3, none: 0 },
  od_metric: { full_matrix: 1, structured_marginals: 0.75, marginal_od: 0.5, synthetic_measured_marginals: 0.25, prior_informed_synthetic: 0.1, none: 0 },
};

// answer key -> ladder it must belong to (od_granularity may be null when the O/D rung has no measured grain)
export const ANSWER_LADDER = {
  workplace_count: "workplace_count", workplace_granularity: "granularity", workplace_resolution: "resolution", workplace_intensity: "intensity",
  resident_count: "resident_count", resident_granularity: "granularity", resident_resolution: "resolution", resident_intensity: "intensity",
  od_metric: "od_metric", od_granularity: "granularity",
};

export const TIERS = [
  { tier: "very-high", grade: "A", min: 0.75 }, { tier: "high", grade: "B", min: 0.6 }, { tier: "medium", grade: "C", min: 0.45 },
  { tier: "low", grade: "D", min: 0.3 }, { tier: "very-low", grade: "E", min: 0.15 }, { tier: "absent", grade: "F", min: 0 },
];

// Returns a list of problems (empty = every answer is a known rung).
export function checkAnswers(a) {
  const errs = [];
  for (const [key, ladder] of Object.entries(ANSWER_LADDER)) {
    const v = a?.[key];
    if (key === "od_granularity" && v === null) continue;
    if (v === undefined) errs.push(`answers.${key} is missing`);
    else if (!(v in LADDERS[ladder])) errs.push(`answers.${key}: '${v}' is not a rubric value (one of ${Object.keys(LADDERS[ladder]).join(", ")})`);
  }
  for (const k of Object.keys(a ?? {})) if (!(k in ANSWER_LADDER)) errs.push(`answers.${k} is not a rubric question`);
  return errs;
}

const round = (x, d = 3) => Math.round(x * 10 ** d) / 10 ** d;

export function computeQuality(a) {
  const problems = checkAnswers(a);
  if (problems.length) throw new Error(problems.join("; "));
  const L = LADDERS;
  const pillar = (count, res, int, gran) => {
    const c = L[count.ladder][count.v], ri = L.resolution[res] * L.intensity[int], g = L.granularity[gran];
    return { raw: c * ri * g, weighted: (0.5 * c + 0.5 * ri) * g };
  };
  const workplace = pillar({ ladder: "workplace_count", v: a.workplace_count }, a.workplace_resolution, a.workplace_intensity, a.workplace_granularity);
  const resident = pillar({ ladder: "resident_count", v: a.resident_count }, a.resident_resolution, a.resident_intensity, a.resident_granularity);
  const odv = L.od_metric[a.od_metric] * (a.od_granularity === null ? 1 : L.granularity[a.od_granularity]);
  const od = { raw: odv, weighted: odv };
  const mix = (k) => PILLAR_WEIGHTS.workplace * workplace[k] + PILLAR_WEIGHTS.resident * resident[k] + PILLAR_WEIGHTS.od * od[k];
  const weighted = mix("weighted");
  const t = TIERS.find((x) => weighted >= x.min);
  return {
    raw_score: round(mix("raw")), weighted_score: round(weighted), tier: t.tier, grade: t.grade,
    pillars: { workplace: { raw: round(workplace.raw), weighted: round(workplace.weighted) }, resident: { raw: round(resident.raw), weighted: round(resident.weighted) }, od: { raw: round(od.raw), weighted: round(od.weighted) } },
  };
}
