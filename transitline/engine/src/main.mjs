import { loadPack } from "./pack.mjs";
import {
  createState, addLine, clearLines, deleteLine, renameLine, setBandFrequency, setCarsPerTrain,
  LINE_COLORS, BANDS, nextLineColor, bandAt, lineLetter, badgeTextColor, trainCapacity, MIN_CARS, MAX_CARS,
} from "./state.mjs";
import { targetTrains } from "./trains.mjs";
import { makeProjection } from "./projection.mjs";
import { buildDemandModel } from "./demand-engine.mjs";
import { attachInput } from "./input.mjs";
import { startLoop } from "./loop.mjs";

const params = new URLSearchParams(location.search);
const packPath = params.get("pack") ?? "../packs/example-radial";

const $ = (id) => document.getElementById(id);
const canvas = $("game");
const ctx = canvas.getContext("2d");
const errorEl = $("error");
const hud = {
  packName: $("pack-name"),
  waiting: $("hud-waiting"),
  onboard: $("hud-onboard"),
  delivered: $("hud-delivered"),
  abandoned: $("hud-abandoned"),
  clock: $("hud-clock"),
  day: $("hud-day"),
};

// All text goes through textContent — line names are player input.
function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

function makeBadge(line) {
  const b = el("span", "badge", lineLetter(line.id));
  b.style.background = line.color;
  b.style.color = badgeTextColor(line.color);
  return b;
}

let selectedColor = LINE_COLORS[0];
let selectedLineId = null;

function renderPalette() {
  const box = $("palette");
  box.innerHTML = "";
  for (const color of LINE_COLORS) {
    const swatch = el("div", "swatch" + (color === selectedColor ? " selected" : ""));
    swatch.style.background = color;
    swatch.title = "Pick this color for the next line";
    swatch.addEventListener("click", () => {
      selectedColor = color;
      renderPalette();
    });
    box.appendChild(swatch);
  }
}

function renderLines(state) {
  const box = $("lines");
  box.innerHTML = "";
  for (const line of state.lines) {
    const row = el("div", "line-row" + (line.id === selectedLineId ? " selected" : ""));
    row.append(makeBadge(line), el("span", "name", line.name));
    row.addEventListener("click", () => {
      selectedLineId = line.id;
      renderLines(state);
      renderRoutePanel(state);
    });
    box.appendChild(row);
  }
}

const perHourText = (perHour) =>
  perHour > 0 ? `${(60 / perHour).toFixed(0)} min · ${perHour} trains/hr` : "No service";

function renderRoutePanel(state) {
  const panel = $("route-panel");
  const line = state.lines.find((l) => l.id === selectedLineId);
  if (!line) {
    panel.hidden = true;
    panel.innerHTML = "";
    return;
  }
  panel.hidden = false;
  panel.innerHTML = "";

  const name = el("span", "rp-name", line.name);
  name.title = "Click to rename";
  name.addEventListener("click", () => {
    const next = window.prompt("Line name:", line.name);
    if (next) renameLine(state, line.id, next);
    renderLines(state);
    renderRoutePanel(state);
  });
  const close = el("button", "close", "×");
  close.type = "button";
  close.addEventListener("click", () => {
    selectedLineId = null;
    renderLines(state);
    renderRoutePanel(state);
  });
  const head = el("div", "rp-head");
  head.append(makeBadge(line), name, close);
  panel.appendChild(head);

  const trains = el("div", "rp-trains");
  trains.append("Trains in service: ", el("b", "", "0"), " · Target: ", el("b", "", "0"));
  trains.id = "rp-trains";
  panel.appendChild(trains);

  panel.appendChild(el("div", "section-label", "Train configuration"));
  const carsRow = el("div", "band");
  const carsInfo = el("div", "band-info");
  const carsLabel = el("div", "band-label", "Cars per train");
  const carsRate = el("div", "band-rate", "");
  carsInfo.append(carsLabel, el("div", "band-hours", `${MIN_CARS}-${MAX_CARS} cars`), carsRate);
  const carsMinus = el("button", "", "−");
  const carsPlus = el("button", "", "+");
  const carsValue = el("span", "", "");
  carsMinus.type = carsPlus.type = "button";
  const showCars = () => {
    carsValue.textContent = line.carsPerTrain;
    carsRate.textContent = `${trainCapacity(line)} capacity per train`;
  };
  carsMinus.addEventListener("click", () => {
    setCarsPerTrain(state, line.id, line.carsPerTrain - 1);
    showCars();
  });
  carsPlus.addEventListener("click", () => {
    setCarsPerTrain(state, line.id, line.carsPerTrain + 1);
    showCars();
  });
  showCars();
  const carsStepper = el("div", "stepper");
  carsStepper.append(carsMinus, carsValue, carsPlus);
  carsRow.append(carsInfo, carsStepper);
  panel.appendChild(carsRow);

  panel.appendChild(el("div", "section-label", "Service frequency"));
  for (const band of BANDS) {
    const row = el("div", "band");
    row.dataset.band = band.id;

    const info = el("div", "band-info");
    const label = el("div", "band-label", band.label);
    label.style.color = band.color;
    const rate = el("div", "band-rate", perHourText(line.frequency[band.id]));
    info.append(label, el("div", "band-hours", band.hours), rate);

    const stepper = el("div", "stepper");
    const minus = el("button", "", "−");
    const plus = el("button", "", "+");
    const value = el("span", "", String(line.frequency[band.id]));
    minus.type = plus.type = "button";
    const bump = (delta) => {
      setBandFrequency(state, line.id, band.id, line.frequency[band.id] + delta);
      value.textContent = line.frequency[band.id];
      rate.textContent = perHourText(line.frequency[band.id]);
    };
    minus.addEventListener("click", () => bump(-1));
    plus.addEventListener("click", () => bump(1));
    stepper.append(minus, value, plus);

    row.append(info, stepper);
    panel.appendChild(row);
  }

  const del = el("button", "delete", "Delete line");
  del.type = "button";
  del.addEventListener("click", () => {
    deleteLine(state, line.id);
    selectedLineId = null;
    renderLines(state);
    renderRoutePanel(state);
  });
  panel.appendChild(del);
}

function updateRoutePanelLive(state) {
  const line = state.lines.find((l) => l.id === selectedLineId);
  if (!line) return;
  const band = bandAt(state);
  const current = state.trains.filter((t) => t.lineId === line.id).length;
  const bs = $("rp-trains")?.querySelectorAll("b");
  if (bs && bs.length === 2) {
    bs[0].textContent = current;
    bs[1].textContent = targetTrains(state, line, band.id).toFixed(1);
  }
  for (const row of $("route-panel").querySelectorAll(".band")) {
    row.classList.toggle("active", row.dataset.band === band.id);
  }
}

function buildHist(id) {
  const box = $(id);
  box.innerHTML = "";
  return Array.from({ length: 24 }, () => {
    const bar = document.createElement("i");
    box.appendChild(bar);
    return bar;
  });
}

function setHist(bars, values) {
  const max = Math.max(1, ...values);
  bars.forEach((bar, h) => {
    bar.style.height = `${(values[h] / max) * 100}%`;
  });
}

function updateAnalysis(state, depBars, arrBars) {
  const { delivered, abandoned, spawnedByHour, deliveredByHour, modeShare, spawned } = state.stats;
  for (const mode of ["transit", "driving", "walking"]) {
    const share = spawned ? Math.round((modeShare[mode] / spawned) * 100) : 0;
    $(`an-${mode}`).textContent = `${modeShare[mode]} · ${share}%`;
    $(`an-${mode}-bar`).style.width = `${share}%`;
  }
  const total = delivered + abandoned;
  const pct = (n) => (total ? Math.round((n / total) * 100) : 0);
  $("an-delivered").textContent = `${delivered} · ${pct(delivered)}%`;
  $("an-abandoned").textContent = `${abandoned} · ${pct(abandoned)}%`;
  $("an-delivered-bar").style.width = `${pct(delivered)}%`;
  $("an-abandoned-bar").style.width = `${pct(abandoned)}%`;
  setHist(depBars, spawnedByHour);
  setHist(arrBars, deliveredByHour);
}

async function main() {
  const pack = await loadPack(packPath);
  const state = createState(pack);
  const demandModel = buildDemandModel(state, pack.demand, params.get("od") === "0" ? null : pack.od); // ?od=0 forces gravity destinations
  const projection = makeProjection(pack.manifest.bbox, pack.manifest.origin);

  // Canvas backing store kept equal to its CSS size (no devicePixelRatio
  // scaling yet) so input.mjs's hit-testing needs no extra conversion.
  function resize() {
    canvas.width = canvas.clientWidth;
    canvas.height = canvas.clientHeight;
    projection.fitToCanvas(canvas.width, canvas.height);
  }
  window.addEventListener("resize", resize);
  resize();

  hud.packName.textContent = pack.manifest.name;
  $("clear-lines").addEventListener("click", () => {
    clearLines(state);
    selectedLineId = null;
    renderLines(state);
    renderRoutePanel(state);
  });

  // Bottom bar: pause / speed / analysis toggle.
  let lastSpeed = 1;
  const playBtn = $("btn-play");
  const speedBtns = [...document.querySelectorAll("#bar-ui .speed")];
  function syncBar() {
    playBtn.textContent = state.speed === 0 ? "▶" : "❚❚";
    for (const b of speedBtns) b.classList.toggle("active", state.speed !== 0 && Number(b.dataset.speed) === state.speed);
  }
  function togglePlay() {
    if (state.speed === 0) state.speed = lastSpeed;
    else {
      lastSpeed = state.speed;
      state.speed = 0;
    }
    syncBar();
  }
  playBtn.addEventListener("click", (e) => {
    togglePlay();
    e.currentTarget.blur();
  });
  for (const b of speedBtns) {
    b.addEventListener("click", (e) => {
      state.speed = lastSpeed = Number(b.dataset.speed);
      syncBar();
      e.currentTarget.blur();
    });
  }
  window.addEventListener("keydown", (e) => {
    if (e.code === "Space" && e.target === document.body) {
      e.preventDefault();
      togglePlay();
    }
  });
  syncBar();

  const analysisEl = $("analysis");
  const depBars = buildHist("hist-dep");
  const arrBars = buildHist("hist-arr");
  $("btn-analysis").addEventListener("click", (e) => {
    analysisEl.hidden = !analysisEl.hidden;
    e.currentTarget.classList.toggle("active", !analysisEl.hidden);
    e.currentTarget.blur();
  });

  renderPalette();
  renderLines(state);
  renderRoutePanel(state);

  const input = attachInput(canvas, state, projection, (stationIds) => {
    const defaultName = `Line ${state.nextLineId}`;
    const name = window.prompt("Name this line:", defaultName) || defaultName;
    const line = addLine(state, stationIds, { name, color: selectedColor });
    selectedColor = nextLineColor(state); // suggest a fresh color for the next line
    selectedLineId = line.id;
    renderPalette();
    renderLines(state);
    renderRoutePanel(state);
  });

  // Panels refresh ~4x/second — no need to rewrite the DOM every frame.
  let lastUi = 0;
  startLoop(state, demandModel, projection, ctx, canvas, hud, input, (now) => {
    if (now - lastUi < 250) return;
    lastUi = now;
    updateRoutePanelLive(state);
    if (!analysisEl.hidden) updateAnalysis(state, depBars, arrBars);
  });
}

main().catch((err) => {
  console.error(err);
  errorEl.textContent = `Failed to load pack '${packPath}': ${err.message}`;
  errorEl.hidden = false;
});
