// P2: train motion, curve/slope speed limits and time-of-day train counts of the reference game (doc sections
// "열차 이동", "곡선·경사 속도", "노선 구조·편수·스케줄"). Pure functions.
import { RULES, TRAIN_TYPES, DEFAULT_TRAIN_TYPE, GAME_SECONDS_PER_TICK } from "./rules.mjs";

const M = RULES.motion;
const round4 = (x) => Math.round(x * M.roundTo) / M.roundTo;
const type = (id = DEFAULT_TRAIN_TYPE) => TRAIN_TYPES[id] ?? TRAIN_TYPES[DEFAULT_TRAIN_TYPE];

// One 0.5 s tick toward `target`. Jerk limits only the growth of acceleration; braking is immediate up to maxDec.
export function motionStep({ speed, accel = 0, target, maxAcc, maxDec }, dt = GAME_SECONDS_PER_TICK) {
  const diff = target - speed;
  if (Math.abs(diff) < M.speedMargin) return { speed: target === 0 ? 0 : speed, accel: 0 };
  if (diff > 0) {
    let inc = Math.min(maxAcc * dt, diff);
    const prev = accel * dt;
    if (inc - prev > M.maxJerk * dt * dt) inc = prev + M.maxJerk * dt * dt;
    inc = Math.max(inc, 0);
    return { speed: round4(speed + inc), accel: round4(inc / dt) };
  }
  const dec = Math.max(-maxDec * dt, diff);
  return { speed: round4(speed + dec), accel: round4(dec / dt) };
}

// Distance covered while changing speed from `speed` to `target` (used for braking distance). Capped at 1000 ticks.
export function distanceToReachSpeed({ speed, accel = 0, target, maxAcc, maxDec }, dt = GAME_SECONDS_PER_TICK) {
  let s = { speed, accel };
  let dist = 0;
  for (let i = 0; i < 1000 && Math.abs(s.speed - target) >= M.speedMargin; i++) {
    s = motionStep({ ...s, target, maxAcc, maxDec }, dt);
    dist += s.speed * dt;
  }
  return dist;
}

// Speed cap (integer m/s) from curve radius, average train length and slope. Station stretches use half the lateral limit.
// Slope tiers: >=95% of the type's max slope -> x0.6, >=80% -> x0.75, >=60% -> x0.9 of max speed.
export function speedLimit({ trainType, radiusM = Infinity, slopePct = 0, inStation = false }) {
  const t = type(trainType);
  const slopeShare = Math.abs(slopePct) / t.maxSlopePct;
  const slopeFactor = slopeShare >= 0.95 ? 0.6 : slopeShare >= 0.8 ? 0.75 : slopeShare >= 0.6 ? 0.9 : 1;
  const cap = inStation ? t.maxSpeedLocalStation : t.maxSpeed;
  const capped = cap * slopeFactor;
  if (!Number.isFinite(radiusM)) return capped;
  const avgLen = ((t.minCars + t.maxCars) / 2) * t.carLength;
  const curve = Math.sqrt(t.maxLateralAcc * Math.max(radiusM, t.minTurnRadius)) * (inStation ? 0.5 : 1) * Math.max(0.5, 1 - avgLen / 200);
  return Math.round(Math.min(curve, capped));
}

export const demandLevel = (hour) => RULES.demandLevelByHour[Math.floor(hour) % 24];

const countFor = (schedule, level) => (level === "high" ? schedule.high : level === "medium" ? schedule.medium : level === "low" ? schedule.low : schedule.veryLow ?? schedule.low);

// Hour boundaries where the demand level changes: [{ at (s), from, to }].
export const demandTransitions = () => {
  const out = [];
  for (let h = 0; h < 24; h++) {
    const from = demandLevel(h), to = demandLevel(h + 1);
    if (from !== to) out.push({ at: ((h + 1) % 24) * 3600, from, to });
  }
  return out;
};

// Concurrent trains a route should run at `secondsOfDay`. Around each level change the count fades linearly over
// +-min(cycleTime, 90 min) (30 min when the cycle is unknown). schedule = { high, medium, low, veryLow? }.
// ponytail: windows wrap across midnight here; the game's boundary handling at 00:00 is not confirmed.
export function idealTrainCount(schedule, secondsOfDay, cycleTimeS) {
  if (!schedule) return 0;
  const W = Math.min(cycleTimeS > 0 ? cycleTimeS : RULES.time.transitionWindowS, RULES.time.transitionWindowMaxS);
  for (const tr of demandTransitions()) {
    let dt = secondsOfDay - (tr.at - W);
    if (dt < 0) dt += 86400;
    if (dt <= 2 * W) {
      const k = Math.min(Math.max(dt / (2 * W), 0), 1);
      const a = countFor(schedule, tr.from), b = countFor(schedule, tr.to);
      return Math.round(a + (b - a) * k);
    }
  }
  return countFor(schedule, demandLevel(Math.floor(secondsOfDay / 3600)));
}

// Train number `index` (0-based) runs in a level only if index < that level's train count (nested schedule).
export function operatingLevels(index, schedule) {
  if (!schedule) return { high: true, medium: true, low: true, veryLow: true };
  const veryLow = schedule.veryLow ?? schedule.low;
  return { high: index < schedule.high, medium: index < schedule.medium, low: index < schedule.low, veryLow: index < veryLow };
}
