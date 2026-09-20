// Each trip picks walking, driving or transit by lowest (noisy) travel time,
// as Subway Builder's pops do. Speeds follow its game constants where the
// modding types state them (walking 1 m/s); driving is depot's 30 kph default
// with a road-winding factor and a fixed parking allowance — engine choices.
import { haversineMetres } from "./projection.mjs";
import { bandAt } from "./state.mjs";

const WALK_MPS = 1;
const DRIVE_MPS = 30 / 3.6;
const ROAD_FACTOR = 1.3;
const PARKING_SECONDS = 300;

// Expected wait for the first train: half the headway of the current band.
function waitSeconds(state, hop) {
  const line = state.lines.find((l) => l.id === hop.lineId);
  const perHour = line ? line.frequency[bandAt(state).id] : 0;
  return perHour > 0 ? 1800 / perHour : Infinity;
}

export function chooseMode(state, origin, destination, route) {
  const metres = haversineMetres(origin.location, destination.location);
  const options = [
    ["walking", metres / WALK_MPS],
    ["driving", (metres * ROAD_FACTOR) / DRIVE_MPS + PARKING_SECONDS],
  ];
  if (route) options.push(["transit", route.seconds + waitSeconds(state, route.hops[0])]);

  let best = "driving";
  let bestCost = Infinity;
  for (const [mode, cost] of options) {
    const noisy = cost * (0.8 + 0.4 * Math.random()); // ±20% so mode share isn't all-or-nothing
    if (noisy < bestCost) {
      bestCost = noisy;
      best = mode;
    }
  }
  return best;
}
