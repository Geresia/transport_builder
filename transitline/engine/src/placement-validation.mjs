// P1: live placement checks of the reference game while drawing track (doc "선로 배치 검증"). Pure functions; each
// returns an array of { code, message } errors (empty = placeable). Geometry inputs are numbers the caller measured
// from the drawn alignment (length, elevations, smallest turn radius, total bend), so this works with any map layer.
// Not modelled (data-dependent or unconfirmed): building demolition/overpass classification, road grade crossings,
// scissors/portal extras, different-train-type junction lookups beyond the boolean below.
import { RULES, TRAIN_TYPES, DEFAULT_TRAIN_TYPE } from "./rules.mjs";
import { stationLengthRangeM } from "./construction-cost.mjs";

const C = RULES.construction;
const err = (code, message) => ({ code, message });
const type = (t = DEFAULT_TRAIN_TYPE) => TRAIN_TYPES[t];

export const LENGTH_TOLERANCE_M = 0.1; // the game allows 10 000 m + 0.1
export const STATION_LENGTH_TOLERANCE_M = 0.2;
export const STATION_LEVEL_TOLERANCE_M = 0.1; // platforms are flat
export const JUNCTION_HEIGHT_M = 0.02; // crossing tracks closer than this in height are joined
export const SEABED_CLEARANCE_M = 5; // elevated crossings of water must clear the ground by this much

// A plain (non-station) track piece.
export function validateTrack({ points = 2, lengthM, elevationStartM = 0, elevationEndM = 0, minRadiusM = Infinity, trainType }) {
  const t = type(trainType), errors = [];
  if (points < 2) errors.push(err("points", "A track needs at least two points"));
  if (lengthM < C.minTrackLengthM) errors.push(err("too-short", `Track is shorter than ${C.minTrackLengthM} m`));
  if (lengthM > C.maxTrackLengthM + LENGTH_TOLERANCE_M) errors.push(err("too-long", `Track is longer than ${C.maxTrackLengthM} m`));
  for (const e of [elevationStartM, elevationEndM]) {
    if (e < C.minElevationM || e > C.maxElevationM) errors.push(err("elevation-range", `Elevation ${e} m is outside ${C.minElevationM}..${C.maxElevationM} m`));
  }
  if (lengthM > 0 && (Math.abs(elevationEndM - elevationStartM) / lengthM) * 100 > t.maxSlopePct) errors.push(err("slope", `Slope exceeds ${t.maxSlopePct}% for ${t.name}`));
  if (minRadiusM < t.minTurnRadius) errors.push(err("curve", `Curve radius ${Math.round(minRadiusM)} m is below ${t.minTurnRadius} m`));
  return errors;
}

// A station platform track: fits the train set, flat, and (nearly) straight.
export function validateStationTrack({ lengthM, elevationStartM = 0, elevationEndM = 0, minRadiusM = Infinity, totalBendRad = 0, trainType }) {
  const t = type(trainType), errors = [];
  const { min, max } = stationLengthRangeM(trainType);
  if (lengthM < min) errors.push(err("station-short", `Platform is shorter than the minimum train (${min.toFixed(1)} m)`));
  if (lengthM > max + STATION_LENGTH_TOLERANCE_M) errors.push(err("station-long", `Platform is longer than the maximum train (${max.toFixed(1)} m)`));
  if (Math.abs(elevationEndM - elevationStartM) > STATION_LEVEL_TOLERANCE_M) errors.push(err("station-level", "A platform must be level"));
  if (minRadiusM < t.minStationTurnRadius) errors.push(err("station-curve", `Platform curve radius is below ${t.minStationTurnRadius} m`));
  if (totalBendRad > lengthM / t.minStationTurnRadius) errors.push(err("station-bend", "The platform bends too much"));
  return errors;
}

// Two track pieces whose footprints overlap, measured at the crossing point. Same height = a junction (same train type
// only); at least a station's height apart = a grade-separated crossing; anything between is an error. Stations must
// always be separated by that full height.
export function validateOverlap({ heightDiffM, sameTrainType = true, involvesStation = false }) {
  const dz = Math.abs(heightDiffM);
  if (dz >= C.stationHeightM) return [];
  if (involvesStation) return [err("station-overlap", `Tracks must be ${C.stationHeightM} m clear of a station`)];
  if (dz < JUNCTION_HEIGHT_M) return sameTrainType ? [] : [err("junction-type", "Tracks of different train types cannot connect")];
  return [err("overlap", `Crossing tracks need a height difference of 0 or at least ${C.stationHeightM} m`)];
}

// Track over water: below the seabed is fine (a tunnel); above it only as a viaduct clearing the ground by 5 m.
export function validateWater({ trackElevationM, seabedElevationM, groundElevationM = 0 }) {
  if (trackElevationM <= seabedElevationM) return [];
  if (trackElevationM - groundElevationM >= SEABED_CLEARANCE_M) return [];
  return [err("water", "Track above the seabed must be a viaduct at least 5 m above ground, or go below the seabed")];
}
