// P4: money flow of the reference game (doc "승객 이동·승하차·수익", section 1 economy). Pure functions, USD.
import { RULES, TRAIN_TYPES, DEFAULT_TRAIN_TYPE } from "./rules.mjs";

const E = RULES.economy;

// Fare is paid on ARRIVAL, per rider, scaled by FARE_MULTIPLIER. A per-journey fare (journey.fareCost) beats the default.
export const journeyRevenue = (pop, defaultFare = E.defaultFare) => (pop.journey?.transit ?? pop.size) * (pop.journey?.fareCost ?? defaultFare) * E.fareMultiplier;

// Operating cost of one train for `seconds` of running: (fixed + cars x per-car) per hour x the same 365 scale.
// Parked (yard) trains are not charged. The game bills every 15 game minutes for the elapsed time.
export function trainOperatingCost({ trainType = DEFAULT_TRAIN_TYPE, cars, seconds, parked = false }) {
  if (parked) return 0;
  const t = TRAIN_TYPES[trainType];
  return (seconds / 3600) * (t.opCostPerHour + cars * t.opCostPerCarHour) * E.timeMultiplier;
}

// Cars are bought one by one: a route can raise cars-per-train only while enough unassigned cars are owned.
export const carsNeeded = (trains, carsPerTrain) => trains * carsPerTrain;

export function issueBond(kind, yesterdayRevenue) {
  const b = E.bonds[kind];
  if (!b) throw new Error(`unknown bond ${kind}`);
  if (yesterdayRevenue < b.requiredDailyRevenue) return null; // not eligible yet
  return { kind, ...b, remaining: b.principal };
}

// One game hour: interest on the REMAINING principal at daily/24, repayment as a fraction of the ORIGINAL principal.
export function bondHour(bond) {
  const interest = (bond.remaining * bond.dailyInterest) / 24;
  const repay = Math.min(bond.principal * bond.hourlyRepay, bond.remaining);
  return { bond: { ...bond, remaining: bond.remaining - repay }, interest, repay };
}
