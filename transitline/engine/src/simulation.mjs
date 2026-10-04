import { buildRouteGraph } from "./network.mjs";
import { dispatchTrains, stepTrains } from "./trains.mjs";
import { expirePassengers, retryPendingRoutes, spawnPassengers } from "./passengers.mjs";
import { advanceRailwayDisruptions } from "./railway-disruptions.mjs";

export const FIXED_SIM_STEP_SECONDS = 1;

export function createSimulationRuntime(state) {
  return { graph: buildRouteGraph(state), accumulatorSeconds: 0 };
}

export function simulationStep(state, demandModel, runtime, seconds = FIXED_SIM_STEP_SECONDS) {
  if (state.networkDirty) {
    runtime.graph = buildRouteGraph(state);
    retryPendingRoutes(state, runtime.graph);
    state.networkDirty = false;
  }
  if (seconds <= 0) return;
  state.simMinutes += seconds / 60;
  advanceRailwayDisruptions(state);
  spawnPassengers(state, demandModel, runtime.graph, seconds / 60);
  expirePassengers(state);
  dispatchTrains(state);
  stepTrains(state, seconds);
}

export function advanceSimulation(state, demandModel, runtime, simSeconds) {
  runtime.accumulatorSeconds += Math.max(0, simSeconds);
  let steps = 0;
  while (runtime.accumulatorSeconds + 1e-9 >= FIXED_SIM_STEP_SECONDS) {
    simulationStep(state, demandModel, runtime, FIXED_SIM_STEP_SECONDS);
    runtime.accumulatorSeconds -= FIXED_SIM_STEP_SECONDS;
    steps++;
  }
  if (simSeconds === 0 && state.networkDirty) simulationStep(state, demandModel, runtime, 0);
  return steps;
}
