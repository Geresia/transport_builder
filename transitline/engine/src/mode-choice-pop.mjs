// P3: income-based mode choice of the reference game (doc "수단 선택", "체감시간"). Runs per PERSON inside a pop and is
// deterministic (same pop -> same split). Costs are in dollars; the cheapest of driving / transit / walking wins, ties go
// driving > transit > walking. Sits beside the old noisy-minimum-time engine/src/mode-choice.mjs (which stays as is).
import { RULES } from "./rules.mjs";

const M = RULES.mode;
const PT = RULES.perceived;

// Acklam's rational approximation of the inverse normal CDF; p is clamped to [1e-4, 0.9999] as in the game.
const A = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
const B = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
const C = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
const D = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
export function inverseNormalCDF(p) {
  p = Math.max(1e-4, Math.min(0.9999, p));
  const tail = (q) => (((((C[0] * q + C[1]) * q + C[2]) * q + C[3]) * q + C[4]) * q + C[5]) / ((((D[0] * q + D[1]) * q + D[2]) * q + D[3]) * q + 1);
  if (p < 0.02425) return tail(Math.sqrt(-2 * Math.log(p)));
  if (p > 1 - 0.02425) return -tail(Math.sqrt(-2 * Math.log(1 - p)));
  const q = p - 0.5, r = q * q;
  return ((((((A[0] * r + A[1]) * r + A[2]) * r + A[3]) * r + A[4]) * r + A[5]) * q) / (((((B[0] * r + B[1]) * r + B[2]) * r + B[3]) * r + B[4]) * r + 1);
}

// Income of person i of n: evenly spread quantiles of N(mean x mult, std), floored/capped, with a hash-based twist:
// very poor draws are re-drawn from the 10-95% band, and 10% of the rest earn up to $100k extra.
export function incomeForPerson(i, n, mult = 1) {
  const mean = M.incomeMean * mult;
  let income = Math.max(M.minIncome, Math.min(mean + inverseNormalCDF(i / Math.max(n - 1, 1)) * M.incomeStd, M.maxIncome));
  const h = ((i * 362436069) % 1e6) / 1e6;
  if (income <= M.minIncome + 5000) income = mean + inverseNormalCDF(0.1 + h * 0.85) * M.incomeStd;
  else if (h < 0.1) income += (((i * 123456789) % 1e6) / 1e6) * 1e5;
  return income;
}

// Hour of day -> traffic multiplier on driving times (0.8 night ... 1.5 rush), from the larger of home/work demand.
export function drivingTimeMultiplier(hour) {
  const row = RULES.timeOfDay.find(([s, e]) => hour >= s && hour < e) ?? RULES.timeOfDay[0];
  return M.drivingTimeByDemand[Math.max(row[2], row[3])];
}

// Perceived driving seconds: traffic scaling, a congestion premium that grows with the multiplier, plus parking at both ends.
export function perceivedDrivingTime(seconds, trafficMult) {
  const congested = Math.min(1, Math.max(0, (trafficMult - 1) / (M.congestionFullAtMultiplier - 1)));
  return seconds * trafficMult * (1 + congested * (PT.congestedDriving - 1)) + M.parkingSeconds * 2 * PT.parkingSearch;
}

// Perceived transit seconds of a path (segments: { departureTime, arrivalTime, kind: "walk"|"drive"|"transit" }): riding 1.0,
// walking x1.39, waiting (gaps between segments) x1.37, leaving later than requested x0.4.
export function perceivedTransitTime(segments, requestedDeparture) {
  let inVehicle = 0, walk = 0, drive = 0, sum = 0;
  for (const s of segments) {
    const d = s.arrivalTime - s.departureTime;
    sum += d;
    if (s.kind === "drive") drive += d;
    else if (s.kind === "walk") walk += d;
    else inVehicle += d;
  }
  const total = segments.length ? segments.at(-1).arrivalTime - segments[0].departureTime : 0;
  const wait = Math.max(0, total - sum);
  const shift = segments.length ? Math.max(0, segments[0].departureTime - requestedDeparture) : 0;
  return { perceivedTime: inVehicle + drive + walk * PT.walk + wait * PT.wait + shift * PT.departureShift, inVehicle, walk, drive, wait, departureShift: shift };
}

export function modeForPerson({ i, n, drivingTime, drivingDistance, drivingMoneyCost, transitTime, transitCost, walkTime, airport = false, college = false }) {
  const mult = airport ? M.airportIncomeMult : college ? M.collegeIncomeMult : 1;
  const income = Math.min(Math.max(incomeForPerson(i, n, mult), M.minIncome), M.maxIncome);
  const perSecond = income / M.workHoursPerYear / 3600;
  const shortTrip = drivingDistance < M.minSensibleDrivingM ? 1 + (M.minSensibleDrivingM - drivingDistance) / M.minSensibleDrivingM : 1;
  const driving = (drivingTime * perSecond + drivingMoneyCost) * shortTrip;
  const transit = transitTime * perSecond + transitCost;
  const walking = walkTime * perSecond;
  const best = Math.min(driving, transit, walking);
  return driving === best ? "driving" : transit === best ? "transit" : "walking";
}

// Split of `population` people at one demand point. Fewer than 10 transit choosers are all moved to driving (game rule).
export function modeSplit({ population, drivingTime, drivingDistance, transitTime, walkTime, drivingTimeMultiplier: tm = 1, transitCost = RULES.economy.defaultFare, airport = false, college = false }) {
  const pDrive = perceivedDrivingTime(drivingTime, tm);
  const pWalk = airport ? walkTime * PT.airportWalk : walkTime;
  const moneyCost = (drivingDistance / 1000) * M.drivingUsdPerKm + M.parkingUsd * (airport ? M.airportParkingMult : 1);
  const out = { driving: 0, transit: 0, walking: 0 };
  for (let i = 0; i < population; i++) {
    out[modeForPerson({ i, n: population, drivingTime: pDrive, drivingDistance, drivingMoneyCost: moneyCost, transitTime, transitCost, walkTime: pWalk, airport, college })]++;
  }
  if (out.transit < M.minTransitPerPoint) {
    out.driving += out.transit;
    out.transit = 0;
  }
  return out;
}
