import { loadPack } from "./pack.mjs";
import { createState, addLine, clearLines, setLineFrequency, renameLine, LINE_COLORS, nextLineColor } from "./state.mjs";
import { makeProjection } from "./projection.mjs";
import { buildGravityModel } from "./demand-engine.mjs";
import { attachInput } from "./input.mjs";
import { startLoop } from "./loop.mjs";

const params = new URLSearchParams(location.search);
const packPath = params.get("pack") ?? "../packs/example-radial";

const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");
const errorEl = document.getElementById("error");
const hud = {
  packName: document.getElementById("pack-name"),
  waiting: document.getElementById("hud-waiting"),
  onboard: document.getElementById("hud-onboard"),
  delivered: document.getElementById("hud-delivered"),
  abandoned: document.getElementById("hud-abandoned"),
  clock: document.getElementById("hud-clock"),
};

let selectedColor = LINE_COLORS[0];

function renderPalette() {
  const el = document.getElementById("palette");
  el.innerHTML = "";
  for (const color of LINE_COLORS) {
    const swatch = document.createElement("div");
    swatch.className = "swatch" + (color === selectedColor ? " selected" : "");
    swatch.style.background = color;
    swatch.title = "Pick this color for the next line";
    swatch.addEventListener("click", () => {
      selectedColor = color;
      renderPalette();
    });
    el.appendChild(swatch);
  }
}

// Route name/color/frequency are player-set, per Subway Builder rather than
// an abstract auto-assigned line — see engine/README.md.
function renderLines(state) {
  const el = document.getElementById("lines");
  el.innerHTML = "";
  for (const line of state.lines) {
    const row = document.createElement("div");
    row.className = "line-row";

    const dot = document.createElement("span");
    dot.className = "dot";
    dot.style.background = line.color;

    const name = document.createElement("span");
    name.className = "name";
    name.textContent = line.name;
    name.title = "Click to rename";
    name.addEventListener("click", () => {
      const next = window.prompt("Line name:", line.name);
      if (next) renameLine(state, line.id, next);
      renderLines(state);
    });

    const freq = document.createElement("span");
    freq.className = "freq";
    freq.title = "Trains on this line (frequency)";
    const minus = document.createElement("button");
    minus.type = "button";
    minus.textContent = "−";
    minus.addEventListener("click", () => {
      setLineFrequency(state, line.id, line.trainCount - 1);
      renderLines(state);
    });
    const count = document.createElement("span");
    count.textContent = line.trainCount;
    const plus = document.createElement("button");
    plus.type = "button";
    plus.textContent = "+";
    plus.addEventListener("click", () => {
      setLineFrequency(state, line.id, line.trainCount + 1);
      renderLines(state);
    });
    freq.append(minus, count, plus);

    row.append(dot, name, freq);
    el.appendChild(row);
  }
}

async function main() {
  const pack = await loadPack(packPath);
  const state = createState(pack);
  const gravityModel = buildGravityModel(state);
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
  document.getElementById("clear-lines").addEventListener("click", () => {
    clearLines(state);
    renderLines(state);
  });

  renderPalette();
  renderLines(state);

  const input = attachInput(canvas, state, projection, (stationIds) => {
    const defaultName = `Line ${state.nextLineId}`;
    const name = window.prompt("Name this line:", defaultName) || defaultName;
    addLine(state, stationIds, { name, color: selectedColor });
    selectedColor = nextLineColor(state); // suggest a fresh color for the next line
    renderPalette();
    renderLines(state);
  });

  startLoop(state, gravityModel, projection, ctx, canvas, hud, input);
}

main().catch((err) => {
  console.error(err);
  errorEl.textContent = `Failed to load pack '${packPath}': ${err.message}`;
  errorEl.hidden = false;
});
