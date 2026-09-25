// P1: construction cost model of the reference game (doc "건설비 산식"). Pure functions, USD.
// track  = length x baseTrackCost x laneMult x [elev x (1-w) + elev x waterMult x w]   (yard track x0.5)
// station = baseStationCost x laneMult x layoutMult x (0.75 + 0.25 x min(fitCars/maxCars, 1)) x [same land/water split]
// Elevation class and multiplier come from the group's AVERAGE elevation (start/end of its first track).
import { RULES, TRAIN_TYPES, DEFAULT_TRAIN_TYPE } from "./rules.mjs";

const C = RULES.construction;
const type = (id = DEFAULT_TRAIN_TYPE) => TRAIN_TYPES[id] ?? TRAIN_TYPES[DEFAULT_TRAIN_TYPE];

export function elevationClass(e) {
  const t = C.thresholds;
  if (e <= t.deepBore) return "deepBore";
  if (e <= t.standardTunnel) return "standardTunnel";
  if (e <= t.trenched) return "cutAndCover";
  if (e <= t.atGrade) return "trenched";
  if (e <= t.ramp) return "atGrade";
  if (e < t.elevated) return "ramp";
  return "elevated";
}

export const elevationMultiplier = (e) => C.elevationMultiplier[elevationClass(e)];

// Blend of the land share and the water share (waterPct 0..100). 100x classes are "not buildable over water".
export function finalMultiplier(e, waterPct = 0) {
  const cls = elevationClass(e);
  const m = C.elevationMultiplier[cls];
  const w = Math.min(Math.max(waterPct, 0), 100) / 100;
  return (1 - w) * m + w * m * C.waterMultiplier[cls];
}

const laneMult = (lanes) => (lanes === "single" || lanes === 1 ? C.lane.single : lanes === "quad" || lanes >= 4 ? C.lane.quad : C.lane.parallel);

// Cars that fit a platform: (length + 0.2 tolerance - buffer) / carLength, rounded down to whole car sets, capped at maxCars.
export function stationMaxCars({ platformLengthM, trainType, allowZero = false }) {
  const t = type(trainType);
  const raw = Math.floor((platformLengthM + 0.2 - C.stationLengthBufferM) / t.carLength);
  const fit = Math.min(Math.floor(raw / t.carSet) * t.carSet, t.maxCars);
  return allowZero ? fit : Math.max(fit, t.carSet);
}

export const stationLengthRangeM = (trainType) => {
  const t = type(trainType);
  return { min: t.stationCarLength * t.minCars + C.stationLengthBufferM, max: t.stationCarLength * t.maxCars + C.stationLengthBufferM };
};

export function trackCost({ lengthM, trainType, lanes = 2, elevation, waterPct = 0, yard = false }) {
  const base = type(trainType).baseTrackCostPerM * laneMult(lanes) * (yard ? C.yardTrackMultiplier : 1);
  return lengthM * base * finalMultiplier(elevation, waterPct);
}

// layout: "island" (default 1.0), "side" 0.75, "express"/"quad" 1.25. platformLengthM optional (omit = full-length price).
export function stationCost({ trainType, lanes = 2, layout = "island", platformLengthM, elevation, waterPct = 0 }) {
  const t = type(trainType);
  let base = t.baseStationCost * laneMult(lanes) * (C.platformLayout[layout] ?? 1);
  if (platformLengthM != null) {
    const f = C.stationLengthCostFactor;
    base *= 1 - f + f * Math.min(stationMaxCars({ platformLengthM, trainType, allowZero: true }) / t.maxCars, 1);
  }
  return base * finalMultiplier(elevation, waterPct);
}

// A contiguous deep-bore stretch pays a fixed TBM mobilisation; the same amount (capped at the stretch's per-metre cost)
// is carved out of its track cost, so a short bore costs the mobilisation only and a long one costs its raw cost.
export function deepBoreSegment(rawTrackCost) {
  const carve = Math.min(rawTrackCost, C.tbmMobilizationUsd);
  return { mobilization: rawTrackCost > 0 ? C.tbmMobilizationUsd : 0, trackCost: rawTrackCost - carve };
}

// Elevated viaduct spanning a building: premium long-span superstructure + straddle piers.
export function buildingOverpassCost({ spanM, heightM, trainType }) {
  const o = C.buildingOverpass;
  const rate = type(trainType).baseTrackCostPerM * C.elevationMultiplier.elevated;
  const span = Math.max(0, spanM);
  const perMeter = rate * o.costPremium * (span / o.standardSpanM);
  return Math.round(Math.max(0, (perMeter - rate) * span) + o.pierUsdPerMeterHeight * Math.max(0, heightM));
}
