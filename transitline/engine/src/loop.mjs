import { stepTrains } from "./trains.mjs";
import { spawnPassengers, retryPendingRoutes, expirePassengers } from "./passengers.mjs";
import { currentDemandFactor, currentDayLabel } from "./demand-engine.mjs";
import { buildRouteGraph } from "./network.mjs";
import { draw } from "./render.mjs";

// 2 sim-minutes per real second: a train hop takes roughly 1-2 real seconds
// and a service day cycles in about 12 real minutes — fast enough to
// playtest, not tuned for anything beyond that.
const SIM_SECONDS_PER_REAL_SECOND = 120;

export function startLoop(state, gravityModel, projection, ctx, canvas, hud, input) {
  let graph = buildRouteGraph(state);
  let lastTime = performance.now();

  function frame(now) {
    // Clamp so a backgrounded tab doesn't dump minutes of catch-up on return.
    const realDt = Math.min((now - lastTime) / 1000, 0.25);
    lastTime = now;
    const simSeconds = realDt * SIM_SECONDS_PER_REAL_SECOND;
    const simMinutes = simSeconds / 60;

    if (state.networkDirty) {
      graph = buildRouteGraph(state);
      retryPendingRoutes(state, graph);
      state.networkDirty = false;
    }

    state.simMinutes += simMinutes;
    const factor = currentDemandFactor(state);
    spawnPassengers(state, gravityModel, graph, factor, simMinutes);
    expirePassengers(state);
    stepTrains(state, simSeconds);

    draw(ctx, state, projection, canvas.width, canvas.height, input);
    updateHud(hud, state);

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

function updateHud(hud, state) {
  let waiting = 0;
  let onboard = 0;
  for (const p of state.passengers) {
    if (p.state === "waiting") waiting++;
    else if (p.state === "onboard") onboard++;
  }
  hud.waiting.textContent = waiting;
  hud.onboard.textContent = onboard;
  hud.delivered.textContent = state.stats.delivered;
  hud.abandoned.textContent = state.stats.abandoned;

  const label = currentDayLabel(state);
  if (label) {
    hud.clock.textContent = label;
  } else {
    const h = Math.floor(state.simMinutes / 60) % 24;
    const m = Math.floor(state.simMinutes % 60);
    hud.clock.textContent = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  }
}
