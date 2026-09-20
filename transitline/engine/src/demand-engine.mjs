// Turns a pack's gravity-model points into a trip distribution, and (if the
// pack has a calendar) a time-of-day demand multiplier.
import { haversineMetres } from "./projection.mjs";

const MIN_DISTANCE_M = 300; // floor so a point right next to itself doesn't blow up
// Tuned for a legible spawn rate, not demographic realism (Phase 3 owns
// realism): example-radial's ~481k residents * this constant is ~1
// trip/sim-minute citywide, which at loop.mjs's 2 sim-minutes/real-second
// is roughly 2 new passengers/real-second across all 31 stations.
const TRIPS_PER_RESIDENT_PER_SIM_MINUTE = 0.000002;
const OFF_HOURS_FACTOR = 0.1; // engine's own fallback for a calendar gap, not spec-mandated

export function buildGravityModel(state) {
  // Attractors get their own location in the format, but Phase 1 stations
  // are exactly demand.json's points — an attractor with no nearby station
  // would generate trips nobody could ever board. Folding it into its
  // nearest station's residents/jobs is an engine-side simplification, not
  // part of the CityPack format itself.
  const effective = new Map();
  for (const s of state.stations.values()) effective.set(s.id, { residents: s.residents, jobs: s.jobs });
  for (const a of state.attractors) {
    let nearestId = null;
    let nearestDist = Infinity;
    for (const s of state.stations.values()) {
      const d = haversineMetres(a.location, s.location);
      if (d < nearestDist) {
        nearestDist = d;
        nearestId = s.id;
      }
    }
    if (nearestId === null) continue;
    const split = a.residentialSplit ?? 0;
    const e = effective.get(nearestId);
    e.residents += a.capacity * split;
    e.jobs += a.capacity * (1 - split);
  }

  const ids = [...state.stations.keys()];
  const weights = new Map();
  for (const originId of ids) {
    const origin = effective.get(originId);
    const row = [];
    let total = 0;
    for (const destId of ids) {
      if (destId === originId) continue;
      const dest = effective.get(destId);
      const d = Math.max(
        haversineMetres(state.stations.get(originId).location, state.stations.get(destId).location),
        MIN_DISTANCE_M
      );
      const w = (origin.residents * dest.jobs) / (d * d);
      if (w > 0) {
        row.push({ id: destId, weight: w });
        total += w;
      }
    }
    weights.set(originId, { row, total, spawnRate: origin.residents * TRIPS_PER_RESIDENT_PER_SIM_MINUTE });
  }

  return { weights };
}

export function pickDestination(model, originId, rand = Math.random) {
  const entry = model.weights.get(originId);
  if (!entry || entry.total <= 0) return null;
  let r = rand() * entry.total;
  for (const { id, weight } of entry.row) {
    r -= weight;
    if (r <= 0) return id;
  }
  return entry.row[entry.row.length - 1]?.id ?? null;
}

function serviceDayLength(calendar) {
  return Math.max(1440, ...calendar.periods.map((p) => p.endMinute));
}

function currentDayTypeAndPeriod(state) {
  const { calendar, simMinutes } = state;
  const dayLength = serviceDayLength(calendar);
  const serviceMinute = simMinutes % dayLength;
  const dayIndex = Math.floor(simMinutes / dayLength);
  const sequence = calendar.dayTypes.flatMap((dt) => Array(Math.max(1, Math.round(dt.weight))).fill(dt));
  const dayType = sequence[dayIndex % sequence.length];
  const period = calendar.periods.find((p) => serviceMinute >= p.startMinute && serviceMinute < p.endMinute);
  return { dayType, period };
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
