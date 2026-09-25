// Timetable router of the reference game (doc "경로탐색", rRAPTOR limits in RULES.pathfinding). Earliest arrival by rounds
// (round k = journeys with k rides), so maxTransfers is enforced exactly. Output is the pop-journey segment list:
//   [{ kind: "walk"|"transit", routeId, fromStopId, toStopId, departureTime, arrivalTime, fromStopCoords?, toStopCoords? }]
// Waiting is the gap between consecutive segments (perceivedTransitTime reads it that way).
// Service model: a pattern is a stop sequence a train drives once (an out-and-back line lists its stations twice), with
// trips leaving stop 0 every headwayS from phaseS. Trips are closed-form, so no timetable is materialised.
// ponytail: plain earliest arrival (the game's rRAPTOR range search is approximated by delaying the leading walk so the
// traveller leaves as late as possible); walking only (no park-and-ride drive access); linear scan for nearby stations.
import { RULES } from "./rules.mjs";
import { haversineMetres } from "./projection.mjs";

const P = RULES.pathfinding;
export const WALK_MPS = 1.4;
const MIN_TRANSFER_S = 30;

// Expanded stop sequence of an out-and-back line: s0..sn..s0, times from per-leg running seconds and dwell.
export function outAndBackPattern({ routeId, stationIds, legSeconds, dwellS, headwayS, phaseS = 0 }) {
  const stops = [...stationIds, ...stationIds.slice(0, -1).reverse()];
  const legs = [...legSeconds, ...[...legSeconds].reverse()];
  const arr = [0], dep = [dwellS]; // a dispatched train stands at its first station for one dwell
  for (let j = 1; j < stops.length; j++) {
    arr[j] = dep[j - 1] + legs[j - 1];
    dep[j] = arr[j] + dwellS;
  }
  return { routeId, stops, arr, dep, headwayS, phaseS };
}

// stations: Map|Object id -> { location: [lon, lat] }; patterns: see above.
export function buildTimetable({ stations, patterns }, opts = {}) {
  const walkMps = opts.walkMps ?? WALK_MPS;
  const list = stations instanceof Map ? [...stations] : Object.entries(stations);
  const loc = new Map(list.map(([id, s]) => [id, s.location]));
  const served = new Set();
  const live = patterns.filter((p) => p.headwayS > 0 && p.stops.length > 1);
  const byStop = new Map();
  live.forEach((p, pi) => p.stops.forEach((s, j) => { served.add(s); (byStop.get(s) ?? byStop.set(s, []).get(s)).push({ pi, j }); }));
  const ids = [...served].filter((s) => loc.has(s));
  const near = new Map(ids.map((s) => [s, []]));
  const maxT = opts.maxTransferWalkS ?? P.maxTransferWalkS;
  for (let a = 0; a < ids.length; a++) for (let b = a + 1; b < ids.length; b++) {
    const w = haversineMetres(loc.get(ids[a]), loc.get(ids[b])) / walkMps;
    if (w <= maxT) { near.get(ids[a]).push({ id: ids[b], walkS: w }); near.get(ids[b]).push({ id: ids[a], walkS: w }); }
  }
  return { patterns: live, byStop, loc, ids, near, walkMps, maxTransfers: opts.maxTransfers ?? P.maxTransfers, maxWalkS: opts.maxWalkToStationS ?? P.maxWalkToStationS, rangeS: opts.rangeWindowS ?? P.rangeWindowS };
}

const tripDeparture = (p, k, j) => p.phaseS + k * p.headwayS + p.dep[j];
const firstTripAtOrAfter = (p, j, t) => Math.max(0, Math.ceil((t - p.phaseS - p.dep[j]) / p.headwayS - 1e-9));

// Earliest-arrival journey from originLoc to destLoc leaving no earlier than departureS (seconds). null if none.
export function routeJourney(tt, originLoc, destLoc, departureS) {
  const nearby = (pt) => tt.ids.map((id) => ({ id, walkS: haversineMetres(pt, tt.loc.get(id)) / tt.walkMps })).filter((c) => c.walkS <= tt.maxWalkS);
  const access = nearby(originLoc), egress = nearby(destLoc);
  if (!access.length || !egress.length) return null;
  const walkSeg = (from, to, dep, walkS, extra = {}) => ({ kind: "walk", routeId: "walking", fromStopId: from, toStopId: to, departureTime: dep, arrivalTime: dep + walkS, ...extra });

  const best = new Map(); // stop -> label { t, parent, seg }
  let prev = new Map();
  for (const { id, walkS } of access) {
    const label = { t: departureS + walkS, parent: null, seg: walkSeg(null, id, departureS, walkS) };
    best.set(id, label);
    prev.set(id, label);
  }
  let final = null; // { label, walkS, t }
  const tryEgress = () => {
    for (const { id, walkS } of egress) {
      const l = best.get(id);
      if (l && l.t + walkS < (final?.t ?? Infinity)) final = { label: l, walkS, t: l.t + walkS };
    }
  };

  for (let round = 1; round <= tt.maxTransfers + 1 && prev.size; round++) {
    const first = new Map(); // pattern index -> lowest marked position
    for (const stop of prev.keys()) for (const { pi, j } of tt.byStop.get(stop) ?? []) if (j < (first.get(pi) ?? Infinity)) first.set(pi, j);
    const cur = new Map();
    for (const [pi, from] of first) {
      const p = tt.patterns[pi];
      let trip = null; // { k, boardJ, label }
      for (let j = from; j < p.stops.length; j++) {
        const stop = p.stops[j];
        if (trip && trip.seen.has(stop)) trip = null; // the turn-back: pop-journey only boards toward a train's first leg
        if (trip) {
          trip.seen.add(stop);
          const t = p.phaseS + trip.k * p.headwayS + p.arr[j];
          if (t < (best.get(stop)?.t ?? Infinity) && t < (final?.t ?? Infinity)) {
            const seg = { kind: "transit", routeId: p.routeId, fromStopId: p.stops[trip.boardJ], toStopId: stop, departureTime: tripDeparture(p, trip.k, trip.boardJ), arrivalTime: t, fromStopCoords: tt.loc.get(p.stops[trip.boardJ]), toStopCoords: tt.loc.get(stop) };
            const label = { t, parent: trip.label, seg };
            best.set(stop, label);
            cur.set(stop, label);
          }
        }
        const pl = prev.get(stop);
        if (pl && j < p.stops.length - 1) {
          const k = firstTripAtOrAfter(p, j, pl.t + (pl.seg.kind === "transit" ? MIN_TRANSFER_S : 0));
          if (!trip || k < trip.k) trip = { k, boardJ: j, label: pl, seen: new Set([stop]) };
        }
      }
    }
    for (const [stop, label] of [...cur]) {
      for (const { id, walkS } of tt.near.get(stop) ?? []) {
        const t = label.t + walkS;
        if (t < (best.get(id)?.t ?? Infinity) && t < (final?.t ?? Infinity)) {
          const l = { t, parent: label, seg: walkSeg(stop, id, label.t, walkS, { fromStopCoords: tt.loc.get(stop), toStopCoords: tt.loc.get(id) }) };
          best.set(id, l);
          cur.set(id, l);
        }
      }
    }
    tryEgress();
    prev = cur;
  }
  if (!final) return null;

  const segments = [];
  for (let l = final.label; l; l = l.parent) segments.push(l.seg);
  segments.reverse();
  const last = segments.at(-1);
  if (final.walkS > 0) segments.push(walkSeg(last.toStopId, null, last.arrivalTime, final.walkS));
  // Leave as late as the first boarding allows (bounded by the range window): waiting at the stop costs more than a late start.
  if (segments[0].kind === "walk" && segments[1]?.kind === "transit") {
    const slack = Math.min(segments[1].departureTime - segments[0].arrivalTime, tt.rangeS);
    if (slack > 0) { segments[0].departureTime += slack; segments[0].arrivalTime += slack; }
  }
  return { segments, departureTime: segments[0].departureTime, arrivalTime: segments.at(-1).arrivalTime, rides: segments.filter((s) => s.kind === "transit").length };
}
