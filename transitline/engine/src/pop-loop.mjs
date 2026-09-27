// `?model=pop` frame loop: same canvas and old-HUD fields as loop.mjs, but the pop-based game-style simulation drives the
// clock and the money panel replaces the individual-passenger counters (docs: subway-builder-mechanics-study.md, section 5).
import { currentDayLabel } from "./demand-engine.mjs";
import { draw } from "./render.mjs";
import { createPopSim, popSimStep, popSummary, takeBond } from "./pop-sim.mjs";
import { RULES } from "./rules.mjs";

const SIM_SECONDS_PER_REAL_SECOND = 120; // same pace as loop.mjs at 1x
const money = (x) => `${x < 0 ? "-" : ""}$${(Math.abs(x) / 1e6).toFixed(1)}M`;

function buildPanel(sim) {
  const panel = document.createElement("div");
  panel.className = "panel";
  panel.id = "pop-hud";
  panel.style.cssText = "position:fixed;left:12px;bottom:12px;min-width:250px;font-size:12px;line-height:1.5;z-index:5";
  const title = document.createElement("h1");
  title.textContent = "Pop model";
  const body = document.createElement("div");
  const bonds = document.createElement("div");
  for (const kind of Object.keys(RULES.economy.bonds)) {
    const b = document.createElement("button");
    b.textContent = `${kind} bond`;
    b.title = "Needs yesterday's revenue above the bond's threshold";
    b.addEventListener("click", () => { if (!takeBond(sim, kind)) b.title = "Not eligible yet: yesterday's revenue is too low"; });
    bonds.append(b);
  }
  panel.append(title, body, bonds);
  document.body.append(panel);
  return body;
}

function renderPanel(body, state, s) {
  const rows = [
    ["Balance", money(s.money)],
    ["Revenue today / yesterday", `${money(s.revenueToday)} / ${money(s.yesterdayRevenue)}`],
    ["Operating cost today", money(s.costToday)],
    ["Maintenance so far", money(s.stats.maintenanceCost)],
    ["Waiting · aboard · walking", `${s.waiting} · ${s.onboard} · ${s.walking}`],
    ["Trains near capacity", String(s.nearCapacity)],
    ["Bonds", String(s.bonds)],
  ];
  for (const w of s.warnings.slice(0, 3)) rows.push([`⚠ ${state.stations.get(w.stationId)?.name ?? w.stationId}`, `${w.count} waiting (level ${w.level}+)`]);
  body.replaceChildren(...rows.map(([k, v]) => {
    const row = document.createElement("div");
    row.className = "row";
    const a = document.createElement("span"), b = document.createElement("span");
    a.textContent = k; b.textContent = v;
    row.append(a, b);
    return row;
  }));
}

export function startPopLoop(state, demandModel, projection, ctx, canvas, hud, input, onFrame) {
  const sim = createPopSim(state, demandModel);
  const body = buildPanel(sim);
  let lastTime = performance.now(), acc = 0, lastPanel = 0;

  function frame(now) {
    const realDt = Math.min((now - lastTime) / 1000, 0.25);
    lastTime = now;
    acc += realDt * SIM_SECONDS_PER_REAL_SECOND * state.speed;
    for (; acc >= 1; acc -= 1) popSimStep(sim, state, 1);

    draw(ctx, state, projection, canvas.width, canvas.height, input);
    if (now - lastPanel > 250) {
      lastPanel = now;
      const s = popSummary(sim);
      renderPanel(body, state, s);
      hud.waiting.textContent = s.waiting;
      hud.onboard.textContent = s.onboard;
      hud.delivered.textContent = s.stats.ridersDelivered;
      hud.abandoned.textContent = s.stats.dropped;
    }
    const h = Math.floor(state.simMinutes / 60) % 24, m = Math.floor(state.simMinutes % 60);
    hud.clock.textContent = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
    const label = currentDayLabel(state);
    hud.day.textContent = `Day ${Math.floor(state.simMinutes / 1440) + 1}` + (label ? ` · ${label}` : "");
    onFrame?.(now);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
