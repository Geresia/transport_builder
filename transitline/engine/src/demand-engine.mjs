// Turns a pack's demand into a spawn model. Two CityPack models are supported:
//   gravity - residents/jobs per point, trips inferred by distance decay
//   matrix  - measured origin-destination flows, optionally per day type/period
// Both expose the same interface: rate(state, originId) in trips per
// sim-minute, and pick(state, originId) for a destination.
import { haversineMetres } from "./projection.mjs";
import { GridIndex } from "./spatial-index.mjs";
import { odRowsByStation } from "./od-flows.mjs";

const MIN_DISTANCE_M = 300; // floor so a point right next to itself doesn't blow up
const OFF_HOURS_FACTOR = 0.1; // engine's own fallback for a calendar gap, not spec-mandated

// Tuned for a legible spawn rate, not demographic realism (Phase 3 owns
// realism): example-radial's ~481k residents * this constant is ~1
// trip/sim-minute citywide, which at loop.mjs's 2 sim-minutes/real-second
// is roughly 2 new passengers/real-second across all 31 stations.
const TRIPS_PER_RESIDENT_PER_SIM_MINUTE = 0.000002;
// Same target for matrix packs: example-corridor's morning peak sums to
// ~8.7k trips over 140 minutes, which this scales to ~1.2 trips/sim-minute.
const MATRIX_TRIP_SCALE = 0.02;

// Distance-decay exponent per attractor kind. Subway Builder assigns a decay
// exponent per special-demand type (lower = draws from farther away); these
// values are this engine's own defaults, not copied from anywhere. An
// attractor's `decayExponent` field overrides its kind's value.
const BASE_DECAY_EXPONENT = 2;
const KIND_DECAY_EXPONENT = {
  airport: 1,
  university: 1.5,
  stadium: 1.5,
  sports_facility: 1.5,
  hospital: 1.5,
  shopping_center: 1.5,
};
const REFERENCE_DISTANCE_M = 5000; // distance at which every exponent weighs the same

function pickFromRow(row, total, rand) {
  if (total <= 0 || row.length === 0) return null;
  let r = rand() * total;
  for (const { id, weight } of row) {
    r -= weight;
    if (r <= 0) return id;
  }
  return row[row.length - 1].id;
}

// `od` / `odSchool` (optional, from manifest.files.od / .odSchool): measured commuter and school-commute
// flows. Under gravity, having either one replaces two things:
//  - destination choice: the measured origin->destination shares instead of distance decay;
//  - origin volume: split in proportion to each origin's real trip-makers (od.workers + odSchool.students)
//    instead of total residents - the people who actually travel are the ones who generate trips.
// The pack-wide spawn volume is unchanged (same total as gravity), so switching either on redistributes
// trips rather than adding any. When both are present their rows are merged into one undifferentiated
// pool per origin (this engine tracks no separate "commuter" vs "student" trip kind - see od-flows.mjs).
// Origins without any O/D row keep their gravity volume and destination choice. Ignored for matrix packs.
export function buildDemandModel(state, demand, od = null, odSchool = null) {
  if (demand.model === "matrix") return buildMatrixModel(state, demand);
  const gravity = buildGravityModel(state);
  if (!od && !odSchool) return gravity;
  // Keep only destinations that are stations in this run (fixed for the model's lifetime), once, not per pick.
  // Merge od + odSchool per origin: concatenate both files' weighted destinations and sum both volumes, so
  // an origin present in only one file still works exactly like the single-file case did before.
  const rows = new Map();
  for (const source of [od, odSchool]) {
    if (!source) continue;
    for (const [id, r] of odRowsByStation(demand, source)) {
      const demandNodes = state.demandNodes ?? state.stations;
      if (!demandNodes.has(id)) continue;
      const row = r.row.filter((x) => demandNodes.has(x.id));
      const total = row.reduce((t, x) => t + x.weight, 0);
      if (total <= 0) continue;
      const prev = rows.get(id);
      if (prev) { prev.row.push(...row); prev.total += total; prev.volume += r.volume; }
      else rows.set(id, { row: [...row], total, volume: r.volume });
    }
  }
  let poolBase = 0, poolVolume = 0;
  for (const [id, r] of rows) { poolBase += gravity.baseRate(id); poolVolume += r.volume; }
  const base = (id) => (rows.has(id) && poolVolume > 0 ? (poolBase * rows.get(id).volume) / poolVolume : gravity.baseRate(id));
  return {
    ...gravity,
    measuredOrigins: rows.size,
    baseRate: base,
    rate: (s, originId) => base(originId) * currentDemandFactor(s),
    pick: (s, originId, rand = Math.random) => {
      const r = rows.get(originId);
      return (r && pickFromRow(r.row, r.total, rand)) ?? gravity.pick(s, originId, rand);
    },
  };
}

function buildGravityModel(state) {
  // Attractors get their own location in the format, but Phase 1 stations
  // are exactly demand.json's points — an attractor with no nearby station
  // would generate trips nobody could ever board. Folding it into its
  // nearest station's residents/jobs is an engine-side simplification, not
  // part of the CityPack format itself.
  const demandNodes = state.demandNodes ?? state.stations;
  const effective = new Map();
  for (const s of demandNodes.values()) {
    effective.set(s.id, { residents: s.residents, jobs: s.jobs, exponentMass: s.jobs * BASE_DECAY_EXPONENT });
  }
  const stationIndex = new GridIndex([...demandNodes.values()][0]?.location[1] ?? 0);
  for (const s of demandNodes.values()) stationIndex.insert(s.id, s.location);
  for (const a of state.attractors) {
    const nearestId = stationIndex.nearest(a.location)?.id ?? null;
    if (nearestId === null) continue;
    const split = a.residentialSplit ?? 0;
    const exponent = a.decayExponent ?? KIND_DECAY_EXPONENT[a.kind] ?? BASE_DECAY_EXPONENT;
    const draw = a.capacity * (1 - split);
    const e = effective.get(nearestId);
    e.residents += a.capacity * split;
    e.jobs += draw;
    e.exponentMass += draw * exponent;
  }
  // A station's exponent is the job-weighted mean of its base jobs and attractors.
  for (const e of effective.values()) e.exponent = e.jobs > 0 ? e.exponentMass / e.jobs : BASE_DECAY_EXPONENT;

  const ids = [...demandNodes.keys()];
  const weights = new Map();
  for (const originId of ids) {
    const origin = effective.get(originId);
    const row = [];
    let total = 0;
    for (const destId of ids) {
      if (destId === originId) continue;
      const dest = effective.get(destId);
      const d = Math.max(
        haversineMetres(demandNodes.get(originId).location, demandNodes.get(destId).location),
        MIN_DISTANCE_M
      );
      // Baseline is jobs/d^2; a lower exponent boosts the pull at long range.
      const w = ((origin.residents * dest.jobs) / (d * d)) * Math.pow(d / REFERENCE_DISTANCE_M, BASE_DECAY_EXPONENT - dest.exponent);
      if (w > 0) {
        row.push({ id: destId, weight: w });
        total += w;
      }
    }
    weights.set(originId, { row, total, spawnRate: origin.residents * TRIPS_PER_RESIDENT_PER_SIM_MINUTE });
  }

  return {
    origins: ids,
    baseRate: (originId) => weights.get(originId)?.spawnRate ?? 0, // per sim-minute before the calendar factor
    rate: (s, originId) => (weights.get(originId)?.spawnRate ?? 0) * currentDemandFactor(s),
    pick: (_s, originId, rand = Math.random) => {
      const entry = weights.get(originId);
      return entry ? pickFromRow(entry.row, entry.total, rand) : null;
    },
  };
}

// Flow semantics follow docs/citypack-format.md: a flow naming a period is
// that many trips within the period; one that doesn't is a daily total scaled
// by calendar.factors. Active flows are grouped once per (dayType, period).
function buildMatrixModel(state, demand) {
  const flows = demand.flows ?? [];
  const cache = new Map();

  function activeTable(s) {
    const { dayType, period } = s.calendar ? currentDayTypeAndPeriod(s) : {};
    const key = `${dayType?.id}|${period?.id}`;
    const hit = cache.get(key);
    if (hit) return hit;

    const factor = currentDemandFactor(s);
    const table = new Map();
    for (const f of flows) {
      if (s.calendar) {
        if (f.dayType !== undefined && f.dayType !== dayType.id) continue;
        if (f.period !== undefined && f.period !== period?.id) continue;
      }
      const perMinute =
        s.calendar && f.period !== undefined
          ? f.trips / (period.endMinute - period.startMinute)
          : (f.trips / 1440) * factor;
      const demandNodes = s.demandNodes ?? s.stations;
      if (perMinute <= 0 || !demandNodes.has(f.from) || !demandNodes.has(f.to)) continue;
      const entry = table.get(f.from) ?? { row: [], total: 0 };
      entry.row.push({ id: f.to, weight: perMinute });
      entry.total += perMinute;
      table.set(f.from, entry);
    }
    cache.set(key, table);
    return table;
  }

  return {
    origins: [...(state.demandNodes ?? state.stations).keys()],
    rate: (s, originId) => (activeTable(s).get(originId)?.total ?? 0) * MATRIX_TRIP_SCALE,
    pick: (s, originId, rand = Math.random) => {
      const entry = activeTable(s).get(originId);
      return entry ? pickFromRow(entry.row, entry.total, rand) : null;
    },
  };
}

export function currentDayTypeAndPeriod(state) {
  const { calendar, simMinutes } = state;
  const clockMinute = ((simMinutes % 1440) + 1440) % 1440;
  const dayIndex = Math.floor(simMinutes / 1440);
  const sequence = calendar.dayTypes.flatMap((dt) => Array(Math.max(1, Math.round(dt.weight))).fill(dt));
  const dayType = sequence[dayIndex % sequence.length];
  let serviceMinute = clockMinute;
  let period = calendar.periods.find((p) => clockMinute >= p.startMinute && clockMinute < Math.min(p.endMinute, 1440));
  if (!period) {
    serviceMinute = clockMinute + 1440;
    period = calendar.periods.find((p) => p.endMinute > 1440 && serviceMinute >= p.startMinute && serviceMinute < p.endMinute);
  }
  return { dayType, period, dayIndex, serviceMinute };
}

export function currentDemandFactor(state) {
  if (!state.calendar) return 1;
  const { dayType, period } = currentDayTypeAndPeriod(state);
  if (!period) return OFF_HOURS_FACTOR;
  return state.calendar.factors?.[dayType.id]?.[period.id] ?? 1;
}

export function currentDayLabel(state) {
  if (!state.calendar) return null;
  const { dayType, period } = currentDayTypeAndPeriod(state);
  return `${dayType.name} · ${period?.id ?? "off-hours"}`;
}
