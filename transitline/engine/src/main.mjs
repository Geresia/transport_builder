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
import { startPopLoop } from "./pop-loop.mjs";
import { withStationAccess } from "./access-demand.mjs";
import { buildMapExport, drawnLinesFromState } from "./map/plan-geometry.mjs";
import { buildOverlayModel, defineViewSlots, renderDiagnosticsPanel, renderPhaseLegend } from "./map/overlay.mjs";
import { attachDepotEditor } from "./map/depot-ui.mjs";
import { attachStationEditor } from "./map/station-ui.mjs";
import { mountStationSelection } from "./map/station-selection-ui.mjs";
import { attachConstructionEditor } from "./map/construction-ui.mjs";
import { mountConstructionSelection } from "./map/construction-selection-ui.mjs";
import { mountConstructionImpact } from "./map/construction-impact-ui.mjs";
import { mountConstructionWorkfront } from "./map/construction-workfront-ui.mjs";
import { planIdForKey, planningDefaults, ScenarioRuntime, stablePlanKey } from "./scenario-runtime.mjs";
import { mountStationManagementPanel } from "./station-management-ui.mjs";
import { mountConstructionContractorPanel } from "./construction-contractor-ui.mjs";

const params = new URLSearchParams(location.search);
const packPath = params.get("pack") ?? "../packs/example-radial";
const scenarioPlay = params.get("play") !== "sandbox";

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
let refreshScenarioPanel = () => {};

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

// Recomputes the map-side plan view (PlanGeometry + engine phase/diagnostics overlay). Assigned in main().
let refreshMapOverlay = () => {};

function renderLines(state) {
  refreshMapOverlay();
  const box = $("lines");
  box.innerHTML = "";
  for (const line of state.lines) {
    const row = el("div", "line-row" + (line.id === selectedLineId ? " selected" : ""));
    row.append(makeBadge(line), el("span", "name", `${line.name}${line.planOnly ? " · 계획" : ""}`));
    row.addEventListener("click", () => {
      selectedLineId = line.id;
      renderLines(state);
      renderRoutePanel(state);
      refreshScenarioPanel();
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

  if (line.planOnly) {
    panel.appendChild(el("div", "rp-trains", "설계안입니다. 심사·계약·공사·검사를 마쳐야 운행할 수 있습니다."));
    const del = el("button", "delete", "계획 삭제");
    del.type = "button";
    del.disabled = Boolean(line.planLocked);
    if (line.planLocked) del.title = "심사를 통과한 계획은 사업 기록과 연결되어 삭제할 수 없습니다.";
    del.addEventListener("click", () => {
      deleteLine(state, line.id);
      selectedLineId = null;
      renderLines(state);
      renderRoutePanel(state);
      refreshScenarioPanel();
    });
    panel.appendChild(del);
    return;
  }

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

// Two starting-network play modes, chosen by ?network= (both read the same pack — only whether
// the real-world lines are pre-drawn differs):
//   "existing" (default, when the pack has existingNetwork): keep + extend today's real network.
//   "scratch": ignore it and start from a blank map, same as a pack with no existingNetwork at all.
// A player can always reach the "scratch" state from "existing" via the Clear lines button too;
// this flag only controls what's on the map when the pack first loads.
function seedExistingNetwork(state, pack) {
  if (!pack.existingNetwork || params.get("network") === "scratch") return;
  for (const line of pack.existingNetwork.lines) {
    const stationIds = line.stationIds.filter((id) => state.stations.has(id));
    // dedupe consecutive repeats defensively (e.g. two source stops that map to the same station)
    const path = stationIds.filter((id, i) => id !== stationIds[i - 1]);
    if (path.length < 2) continue;
    addLine(state, path, { name: line.name, color: line.color ?? undefined, external: true });
  }
}

function syncNetworkModeUI(pack) {
  const row = $("network-mode");
  if (!pack.existingNetwork) { row.hidden = true; return; }
  const scratch = params.get("network") === "scratch";
  row.hidden = false;
  $("network-mode-label").textContent = scratch ? "빈 지도" : "기존 철도망";
  const link = $("network-mode-switch");
  link.textContent = scratch ? "불러오기" : "새로 시작";
  const url = new URL(location.href);
  if (scratch) url.searchParams.delete("network"); else url.searchParams.set("network", "scratch");
  link.href = url.href;
}

async function main() {
  const pack = await loadPack(packPath);
  const state = defineViewSlots(createState(pack), ["mapOverlay", "depotView", "stationView", "constructionView"]); // display-only: kept out of saves
  seedExistingNetwork(state, pack);
  syncNetworkModeUI(pack);

  const networkMode = params.get("network") === "scratch" || !pack.existingNetwork ? "scratch" : "existing";
  const countryId = params.get("country") === "KR" ? "KR" : "JP";
  const difficulty = ["easy", "normal", "hard"].includes(params.get("difficulty")) ? params.get("difficulty") : "normal";
  const fundingMode = params.get("funding") === "sandbox" ? "sandbox" : "limited";
  const runtime = scenarioPlay ? new ScenarioRuntime({ pack, operationalState: state, countryId, networkMode, fundingMode, difficulty }) : null;

  // Map -> engine is data only: player plans become PlanGeometry; the management engine's report
  // (statuses, verdicts) comes back through setEngineReport and is only displayed, never written.
  let engineReport = null;
  let currentMapExport = null;
  let depotUi = null;
  let stationUi = null;
  let stationSelection = null;
  let stationSelectionOutput = null;
  let constructionUi = null;
  let constructionSelection = null;
  let constructionSelectionOutput = null;
  let constructionImpact = null;
  let constructionImpactOutput = null;
  let constructionWorkfront = null;
  refreshMapOverlay = () => {
    currentMapExport = buildMapExport({ pack, mode: networkMode, drawnLines: drawnLinesFromState(state) });
    const report = runtime?.report() ?? engineReport ?? {};
    state.mapOverlay = scenarioPlay ? buildOverlayModel(currentMapExport, report) : null;
    renderDiagnosticsPanel($("map-diagnostics"), state.mapOverlay?.diagnostics ?? []);
    depotUi?.refresh(); // depot connections are checked against the plans just exported
    stationUi?.refresh(); // station sites are checked against the plans just exported, and show the engine verdict
    stationSelection?.refresh();
    constructionUi?.refresh();
    constructionSelection?.refresh();
    constructionImpact?.refresh();
    constructionWorkfront?.refresh();
  };
  window.transitlineMap = { setEngineReport(report) { engineReport = report; refreshMapOverlay(); } };
  if (scenarioPlay) renderPhaseLegend($("map-legend"));
  $("map-legend").hidden = !scenarioPlay;
  // ?od=0 forces gravity destinations, for both files - it means "ignore measured O/D", not "ignore commuters only"
  const useOd = params.get("od") !== "0";
  const demandModel = withStationAccess(buildDemandModel(state, pack.demand, useOd ? pack.od : null, useOd ? pack.odSchool : null), state);
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

  // Depot candidate sites: spatial facts for the management engine, drawn and compared on this map
  depotUi = attachDepotEditor({ canvas, projection, pack, state, getMapExport: () => currentMapExport, panel: $("depot-panel"), compare: $("depot-compare"), button: $("btn-depot") });
  // Station sites: spatial facts for stations, entrances, transfers and work areas; the engine verdict is drawn read-only
  stationUi = attachStationEditor({ canvas, projection, pack, state, getMapExport: () => currentMapExport, getOverlay: () => state.mapOverlay, panel: $("station-panel"), button: $("btn-station") });
  constructionUi = attachConstructionEditor({
    canvas,
    projection,
    pack,
    state,
    getMapExport: () => currentMapExport,
    getDepotExport: () => depotUi?.depotExport,
    getReport: () => runtime?.report() ?? engineReport ?? {},
    panel: $("construction-panel"),
    phasePanel: $("construction-phase-panel"),
    legend: $("construction-legend"),
    button: $("btn-construction"),
  });
  if (runtime) {
    stationSelection = mountStationSelection({
      canvas,
      projection,
      getStationExport: () => stationUi?.stationExport,
      getOverlay: () => state.mapOverlay,
      enabled: false,
      onChange: (output) => { stationSelectionOutput = output; queueMicrotask(() => refreshScenarioPanel()); },
    });
    const selectionButton = $("btn-station-design");
    selectionButton.hidden = false;
    selectionButton.addEventListener("click", () => {
      const enabled = !selectionButton.classList.contains("active");
      if (enabled) {
        if ($("btn-depot").classList.contains("active")) $("btn-depot").click();
        if ($("btn-station").classList.contains("active")) $("btn-station").click();
        if ($("btn-construction").classList.contains("active")) $("btn-construction").click();
      }
      selectionButton.classList.toggle("active", enabled);
      stationSelection.setEnabled(enabled);
      if (!enabled) stationSelection.clear();
      selectionButton.blur();
    });
    for (const editorButton of [$("btn-depot"), $("btn-station")]) editorButton.addEventListener("click", () => {
      if (editorButton.classList.contains("active") && selectionButton.classList.contains("active")) selectionButton.click();
    });
    constructionSelection = mountConstructionSelection({
      canvas,
      projection,
      getConstructionExport: () => constructionUi?.constructionExport,
      enabled: false,
      onChange: (output) => { constructionSelectionOutput = output; queueMicrotask(() => refreshScenarioPanel()); },
    });
    const constructionSelectionButton = $("btn-construction-select");
    constructionSelectionButton.hidden = false;
    constructionSelectionButton.addEventListener("click", () => {
      const enabled = !constructionSelectionButton.classList.contains("active");
      if (enabled) for (const id of ["btn-depot", "btn-station", "btn-construction", "btn-station-design"]) if ($(id).classList.contains("active")) $(id).click();
      constructionSelectionButton.classList.toggle("active", enabled);
      constructionSelection.setEnabled(enabled);
      if (!enabled) constructionSelection.clear();
      constructionSelectionButton.blur();
    });
    for (const editorButton of [$("btn-depot"), $("btn-station"), $("btn-construction"), $("btn-station-design")]) editorButton.addEventListener("click", () => {
      if (editorButton.classList.contains("active") && constructionSelectionButton.classList.contains("active")) constructionSelectionButton.click();
    });
    constructionImpact = mountConstructionImpact({
      canvas,
      projection,
      pack,
      getConstructionExport: () => constructionUi?.constructionExport,
      getReport: () => runtime.report(),
      enabled: false,
      onChange: (output) => { constructionImpactOutput = output; queueMicrotask(() => refreshScenarioPanel()); },
    });
    const impactButton = $("btn-construction-impact");
    impactButton.hidden = false;
    impactButton.addEventListener("click", () => {
      const enabled = !impactButton.classList.contains("active");
      if (enabled) for (const id of ["btn-depot", "btn-station", "btn-construction", "btn-station-design", "btn-construction-select"]) if ($(id).classList.contains("active")) $(id).click();
      impactButton.classList.toggle("active", enabled);
      constructionImpact.setEnabled(enabled);
      impactButton.blur();
    });
    for (const editorButton of [$("btn-depot"), $("btn-station"), $("btn-construction"), $("btn-station-design"), $("btn-construction-select")]) editorButton.addEventListener("click", () => {
      if (editorButton.classList.contains("active") && impactButton.classList.contains("active")) impactButton.click();
    });
    // Work fronts: a shaft/work-area candidate the player places on a construction site, plus its equipment
    // access point and hand-drawn assembly/storage areas. Every change is pushed to the engine's own placement
    // assessment (feasible/conditional/infeasible) — cost, duration and contractor selection stay the engine's.
    constructionWorkfront = mountConstructionWorkfront({
      canvas,
      projection,
      pack,
      getConstructionExport: () => constructionUi?.constructionExport,
      getReport: () => runtime.report(),
      enabled: false,
      onChange: (output) => {
        if (output?.connectedPlanId) {
          try { runtime.applyConstructionWorkfront(output.connectedPlanId, output); }
          catch { /* this plan's construction packages are not linked to a schedule yet */ }
        }
        queueMicrotask(() => refreshScenarioPanel());
      },
    });
    const workfrontButton = $("btn-construction-workfront");
    workfrontButton.hidden = false;
    workfrontButton.addEventListener("click", () => {
      const enabled = !workfrontButton.classList.contains("active");
      if (enabled) for (const id of ["btn-depot", "btn-station", "btn-construction", "btn-station-design", "btn-construction-select", "btn-construction-impact"]) if ($(id).classList.contains("active")) $(id).click();
      workfrontButton.classList.toggle("active", enabled);
      constructionWorkfront.setEnabled(enabled);
      workfrontButton.blur();
    });
    for (const editorButton of [$("btn-depot"), $("btn-station"), $("btn-construction"), $("btn-station-design"), $("btn-construction-select"), impactButton]) editorButton.addEventListener("click", () => {
      if (editorButton.classList.contains("active") && workfrontButton.classList.contains("active")) workfrontButton.click();
    });
  }
  // Map editors own the pointer while active: keep exactly one drawing editor on.
  const drawingButtons = [$("btn-depot"), $("btn-station"), $("btn-construction")];
  for (const activeButton of drawingButtons) {
    activeButton.addEventListener("click", () => {
      if (!activeButton.classList.contains("active")) return;
      for (const other of drawingButtons) if (other !== activeButton && other.classList.contains("active")) other.click();
      if ($("btn-station-design").classList.contains("active")) $("btn-station-design").click();
    });
  }

  hud.packName.textContent = pack.manifest.name;
  $("clear-lines").addEventListener("click", () => {
    if (scenarioPlay) {
      for (const line of [...state.lines]) if (line.planOnly && !line.planLocked) deleteLine(state, line.id);
    } else clearLines(state);
    selectedLineId = null;
    renderLines(state);
    renderRoutePanel(state);
    refreshScenarioPanel();
  });

  const playModeLink = $("btn-play-mode");
  const playModeUrl = new URL(location.href);
  if (scenarioPlay) playModeUrl.searchParams.set("play", "sandbox");
  else playModeUrl.searchParams.delete("play");
  playModeLink.href = playModeUrl.href;
  playModeLink.textContent = scenarioPlay ? "Sandbox" : "Scenario";

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

  if (runtime) {
    let stationManagement = null;
    let constructionContractorManagement = null;
    const scenarioPanel = $("scenario-panel");
    const profile = $("scenario-profile");
    const structure = $("scenario-structure");
    const platform = $("scenario-platform");
    const depotStructure = $("scenario-depot-structure");
    const depotMitigation = $("scenario-depot-mitigation");
    const depotCommunity = $("scenario-depot-community");
    const depotControls = [depotStructure, depotMitigation, depotCommunity, $("scenario-depot-operator-share"), $("scenario-depot-national-share"), $("scenario-depot-local-share")];
    const storageKey = `transitline-integrated-${pack.manifest.id}-${countryId}-${networkMode}`;
    const yen = new Intl.NumberFormat("ko-KR", { notation: "compact", style: "currency", currency: "JPY", maximumFractionDigits: 1 });
    const selectedDraft = () => state.lines.find((line) => line.id === selectedLineId && line.planOnly) ?? null;
    const selectedPlan = () => {
      const line = selectedDraft();
      return line ? currentMapExport?.plans.find((plan) => plan.planId === planIdForKey(pack.manifest.id, line.key)) ?? null : null;
    };
    const message = (text, error = false) => {
      $("scenario-message").textContent = text;
      $("scenario-message").style.color = error ? "#e5484d" : "";
    };
    const run = (action) => {
      try {
        const result = action();
        refreshMapOverlay();
        renderLines(state);
        renderRoutePanel(state);
        refreshScenarioPanel();
        return result;
      } catch (error) {
        message(error.message, true);
        refreshMapOverlay();
        refreshScenarioPanel();
        return null;
      }
    };
    const syncDraftOptions = () => {
      const line = selectedDraft();
      if (!line) return;
      line.technicalProfileId = profile.value;
      line.planningOptions = planningDefaults(profile.value, structure.value, platform.value);
      refreshMapOverlay();
      refreshScenarioPanel();
    };
    for (const control of [profile, structure, platform]) control.addEventListener("change", syncDraftOptions);

    const selectedDepotOptions = () => {
      const operatorShare = Number($("scenario-depot-operator-share").value) / 100;
      const nationalGovernmentShare = Number($("scenario-depot-national-share").value) / 100;
      const localGovernmentShare = Number($("scenario-depot-local-share").value) / 100;
      if ([operatorShare, nationalGovernmentShare, localGovernmentShare].some((value) => !Number.isFinite(value) || value < 0) || Math.abs(operatorShare + nationalGovernmentShare + localGovernmentShare - 1) > 1e-9) {
        throw new Error("차량기지 사업자·국가·지자체 부담률 합계는 100%여야 합니다.");
      }
      return {
        depotSite: depotUi?.selectedSite ?? null,
        depotStructure: depotStructure.value,
        depotStrategy: depotStructure.value === "shared" ? "shared" : "terminal",
        mitigationPackageId: depotMitigation.value,
        communityPackageId: depotCommunity.value,
        comparisonCount: depotUi?.depotExport?.sites.length ?? 0,
        fundingShares: { operatorShare, nationalGovernmentShare, localGovernmentShare },
      };
    };

    const renderConstructionEvents = (plan, project) => {
      const container = $("scenario-construction-events");
      container.replaceChildren();
      const events = runtime.game.constructionEvents
        .filter((event) => !plan || event.planId === plan.planId)
        .sort((a, b) => b.occurredAtMinute - a.occurredAtMinute || b.id.localeCompare(a.id));
      const pending = events.filter((event) => ["unresolved", "responding"].includes(event.status));
      $("scenario-construction-event-count").textContent = String(pending.length);
      if (project?.constructionMetrics) {
        const metrics = document.createElement("div");
        metrics.className = "construction-metrics";
        const value = project.constructionMetrics;
        metrics.textContent = `안전 ${value.safety} · 품질 ${value.quality} · 지역신뢰 ${value.communityTrust} · 시공사관계 ${value.contractorRelationship}`;
        container.append(metrics);
      }
      if (!events.length) {
        const empty = document.createElement("div");
        empty.className = "construction-event-empty";
        empty.textContent = plan ? "이 계획에서 발생한 공사 사건이 없습니다." : "계획선을 선택하세요.";
        container.append(empty);
        return;
      }
      for (const event of events.slice(0, 6)) {
        const card = document.createElement("article");
        card.className = `construction-event-card ${["resolved", "ignored"].includes(event.status) ? "resolved" : "pending"}`;
        const title = document.createElement("div");
        title.className = "construction-event-title";
        const name = document.createElement("b");
        name.textContent = event.title;
        const stateLabel = document.createElement("span");
        const statusLabel = { unresolved: "해결 전", responding: "대응 중", resolved: "해결", ignored: "무시" }[event.status] ?? event.status;
        stateLabel.textContent = `${event.severity} · ${statusLabel}`;
        title.append(name, stateLabel);
        const meta = document.createElement("div");
        meta.className = "construction-event-meta";
        meta.textContent = `${event.constructionSiteId} · 피할 수 없는 지연 ${event.unavoidableDelayMonths}개월 · 공구 노출액 ${yen.format(event.packageExposureJPY)}`;
        card.append(title, meta);
        if (["unresolved", "responding"].includes(event.status)) {
          const actions = document.createElement("div");
          actions.className = "construction-event-responses";
          const mapButton = document.createElement("button");
          mapButton.type = "button";
          mapButton.textContent = constructionImpactOutput?.eventId === event.id && constructionImpactOutput.selectedResponseCandidateId
            ? `지도 후보 적용 · ${constructionImpactOutput.selectedResponseCandidateId}`
            : "지도에서 대응 후보 선택";
          mapButton.addEventListener("click", () => {
            if (constructionImpactOutput?.eventId === event.id && constructionImpactOutput.selectedResponseCandidateId) {
              run(() => {
                const result = runtime.applyConstructionImpact(event.id, constructionImpactOutput);
                message(`지도 대응 후보를 적용했습니다. 비용계수 ${result.adjustment.costMultiplier}, 공기조정 ${result.adjustment.delayDelta}개월입니다.`);
                return result;
              });
              return;
            }
            if (!$("btn-construction-impact").classList.contains("active")) $("btn-construction-impact").click();
            constructionImpact?.select(event.id);
            message("지도에서 연결 후보나 대체 후보를 선택한 뒤 ‘지도 후보 적용’을 누르세요.");
          });
          actions.append(mapButton);
          for (const response of event.responses) {
            const button = document.createElement("button");
            button.type = "button";
            button.textContent = response.label;
            const detail = document.createElement("small");
            detail.textContent = `비용 ${yen.format(response.upfrontCostJPY)} · 추가 ${response.delayMonths}개월 · 안전 ${response.safetyDelta >= 0 ? "+" : ""}${response.safetyDelta} · 품질 ${response.qualityDelta >= 0 ? "+" : ""}${response.qualityDelta} · 평판 ${response.reputationDelta >= 0 ? "+" : ""}${response.reputationDelta}`;
            button.append(detail);
            button.addEventListener("click", () => run(() => {
              const result = runtime.respondConstructionEvent(event.id, response.id);
              message(`${event.title}에 ‘${response.label}’로 대응했습니다. 비용 ${yen.format(result.outcome.upfrontCostJPY)}, 추가 지연 ${result.outcome.responseDelayMonths}개월입니다.`);
              return result;
            }));
            actions.append(button);
          }
          const ignore = document.createElement("button");
          ignore.type = "button";
          ignore.className = "construction-event-ignore";
          ignore.textContent = "대응하지 않음 · 추가 지연과 안전·평판 손실";
          ignore.addEventListener("click", () => run(() => {
            const result = runtime.ignoreConstructionEvent(event.id);
            message(`${event.title} 대응을 포기했습니다. 추가 지연 ${result.outcome.responseDelayMonths}개월, 평판 ${result.outcome.reputationDelta}입니다.`, true);
            return result;
          }));
          actions.append(ignore);
          card.append(actions);
        } else if (event.outcome) {
          const outcome = document.createElement("div");
          outcome.className = "construction-event-outcome";
          const response = event.responses.find((entry) => entry.id === event.selectedResponseId);
          outcome.textContent = `${event.outcome.automatic ? "자동 대응" : "선택 대응"} · ${response?.label ?? event.selectedResponseId} · ${yen.format(event.outcome.upfrontCostJPY)} · 추가 ${event.outcome.responseDelayMonths}개월`;
          card.append(outcome);
        }
        container.append(card);
      }
    };

    refreshScenarioPanel = () => {
      scenarioPanel.hidden = false;
      const line = selectedDraft();
      const plan = selectedPlan();
      const record = plan ? runtime.latestPlan(plan.planId) : null;
      const project = plan ? runtime.projectForPlan(plan.planId) : null;
      const order = project ? runtime.game.vehicleOrders.find((item) => item.id === `fleet:${project.planId.replace(/[^a-zA-Z0-9_-]/g, "-")}`) : null;
      const depot = project ? runtime.game.depots.find((item) => item.id === `depot:${project.planId.replace(/[^a-zA-Z0-9_-]/g, "-")}`) : null;
      const opportunity = runtime.scenarioOpportunity();
      const opportunityViewed = runtime.opportunityViewed();
      const constructionActive = Boolean(project && ["contracted", "underConstruction", "inspection", "suspended"].includes(project.status));
      const vehicleActive = Boolean(order && order.stage !== "accepted" && order.stage !== "cancelled");
      const depotActive = depot?.status === "underConstruction";
      $("scenario-opportunity-status").textContent = opportunityViewed ? "확인 완료" : "미확인";
      $("scenario-opportunity-title").textContent = opportunity?.title ?? "공고 없음";
      $("scenario-opportunity-authority").textContent = opportunity?.authority ?? "-";
      $("scenario-opportunity-process").textContent = opportunity?.processLabel ?? "-";
      $("scenario-opportunity-scope").textContent = opportunity ? `${opportunity.scope.minimumRouteKm}km · ${opportunity.scope.minimumStations}역 · 일 ${opportunity.scope.targetDailyPassengers.toLocaleString("ko-KR")}명` : "-";
      $("scenario-opportunity-deadline").textContent = opportunity ? `${Math.floor(opportunity.deadlineMinute / 1440)}일 이내` : "-";
      $("scenario-opportunity-qualification").textContent = opportunity ? `현금 ${yen.format(opportunity.qualification.minimumCash)} · 평판 ${opportunity.qualification.minimumReputation}` : "-";
      $("scenario-opportunity-view").disabled = opportunityViewed;
      $("scenario-opportunity-view").textContent = opportunityViewed ? "공고 확인 완료" : "공고 확인";
      const tenderOpen = opportunity?.status === "announced";
      $("scenario-research-basic").disabled = !opportunityViewed || !tenderOpen || (opportunity?.researchLevel ?? 0) >= 1;
      $("scenario-research-detailed").disabled = !opportunityViewed || !tenderOpen || (opportunity?.researchLevel ?? 0) >= 2;
      const researchResult = $("scenario-research-result");
      researchResult.hidden = !opportunity?.researchReport;
      if (opportunity?.researchReport) {
        const report = opportunity.researchReport;
        const capital = report.capitalCostRange?.map((value) => yen.format(value)).join(" ~ ") ?? "미산정";
        researchResult.textContent = `${report.level === 2 ? "정밀" : "기초"}조사 · 예상사업비 ${capital} · 수요 ${Math.round(report.demandRange[0]).toLocaleString("ko-KR")}~${Math.round(report.demandRange[1]).toLocaleString("ko-KR")}명/년 · 확인 위험 ${report.knownRiskCount}종`;
      }
      const paymentInput = $("scenario-bid-payment");
      const tenderKey = opportunity ? `${opportunity.id}:${opportunity.retenderCount ?? 0}` : "";
      if (opportunity && paymentInput.dataset.opportunityId !== tenderKey) {
        paymentInput.dataset.opportunityId = tenderKey;
        paymentInput.value = String(Math.round(opportunity.fixedAnnualPayment / 100_000_000));
      }
      const decision = opportunity?.investmentDecision;
      const playerBid = opportunity?.bids.find((bid) => bid.isPlayer);
      paymentInput.disabled = !opportunityViewed || !tenderOpen || Boolean(decision);
      $("scenario-bid-go").disabled = !opportunityViewed || !tenderOpen || Boolean(decision);
      $("scenario-bid-no").disabled = !opportunityViewed || !tenderOpen || Boolean(decision);
      const memoBox = $("scenario-bid-memo");
      memoBox.hidden = !decision;
      if (decision) {
        const memo = decision.memo;
        memoBox.textContent = `${decision.decision === "bid" ? "Bid 승인" : "No Bid"} · P50 ${yen.format(memo.p50Profit)} · P90 ${yen.format(memo.p90Profit)} · 판단 ${memo.recommendation}`;
      }
      $("scenario-tender-submit").disabled = !tenderOpen || decision?.decision !== "bid" || record?.status !== "assessed" || Boolean(playerBid);
      $("scenario-tender-evaluate").disabled = !playerBid || opportunity?.status !== "announced";
      $("scenario-tender-review").disabled = opportunity?.status !== "single-bid-review";
      $("scenario-tender-award").disabled = opportunity?.status !== "preferred-bidder" || opportunity?.preferredBidderId !== runtime.game.player.id;
      $("scenario-tender-fail").disabled = opportunity?.status !== "preferred-bidder" || opportunity?.preferredBidderId !== runtime.game.player.id;
      $("scenario-tender-retender").disabled = !["failed-no-bids", "failed-technical", "retender"].includes(opportunity?.status);
      const tenderResult = $("scenario-tender-result");
      tenderResult.hidden = !playerBid;
      if (playerBid) {
        const winner = opportunity.preferredBidderId ?? opportunity.awardedBidderId;
        const winnerName = winner === runtime.game.player.id ? "플레이어" : runtime.game.competitors.find((company) => company.id === winner)?.name ?? "평가 전";
        tenderResult.textContent = `상태 ${opportunity.status} · 참가 ${opportunity.bids.length}개사 · 기술 ${playerBid.technicalScore.toFixed(1)}점 · 준비비 ${yen.format(opportunity.preparationCost)} · 보증 ${yen.format(opportunity.bidBond)} · 선두 ${winnerName}`;
      }
      $("scenario-country").textContent = countryId === "JP" ? `일본 · ${difficulty}` : `한국 · ${difficulty}`;
      $("scenario-cash").textContent = yen.format(runtime.game.ledger.cash);
      $("scenario-plan").textContent = line?.name ?? "없음";
      $("scenario-phase").textContent = project ? `${project.status} ${Math.round(project.progress * 100)}%` : record?.status ?? (line ? "draft" : "계획 필요");
      $("scenario-submit").disabled = !tenderOpen || Boolean(playerBid) || opportunity?.investmentDecision?.decision !== "bid" || !plan || ["approved", "in-project", "assets-available", "commissioned"].includes(record?.status);
      $("scenario-approve").disabled = !runtime.hasPlayerAward() || record?.status !== "assessed";
      $("scenario-contract").disabled = !project || !["estimated", "approved"].includes(project.status) || project.stationPackageCoverageComplete !== true;
      $("scenario-prepare").disabled = !project || !["contracted", "underConstruction", "inspection", "suspended"].includes(project.status) || Boolean(order);
      $("scenario-depot-evaluate").disabled = !project || Boolean(order);
      for (const control of depotControls) control.disabled = Boolean(order);
      const constructionSitesForPlan = constructionUi?.constructionExport?.sites?.filter((site) => site.connectedPlanId === plan?.planId) ?? [];
      $("scenario-construction-link").disabled = !project || !runtime.constructionSchedule(plan?.planId)?.id || constructionSitesForPlan.length === 0;
      $("scenario-month").disabled = !constructionActive && !vehicleActive && !depotActive;
      $("scenario-year").disabled = $("scenario-month").disabled;
      $("scenario-suspend").disabled = !project || !["contracted", "underConstruction", "inspection", "suspended"].includes(project.status);
      $("scenario-suspend").textContent = project?.status === "suspended" ? "공사 재개" : "공사 중단";
      $("scenario-cancel").disabled = !project || ["available", "cancelled"].includes(project.status);
      $("scenario-open").disabled = project?.status !== "available" || order?.stage !== "accepted" || depot?.status !== "secured" || (runtime.constructionSchedule(plan?.planId) && !runtime.constructionSchedule(plan.planId).ready);
      for (const control of [profile, structure, platform]) control.disabled = !line || Boolean(record && !["needs-information", "rejected"].includes(record.status));
      if (line) {
        profile.value = line.technicalProfileId ?? "medium_steel";
        structure.value = line.planningOptions?.structure ?? "elevated";
        platform.value = line.planningOptions?.platformType ?? "island";
      }
      renderConstructionEvents(plan, project);
      stationManagement?.refresh();
      constructionContractorManagement?.refresh();
    };

    stationManagement = mountStationManagementPanel({
      container: $("scenario-station-management"),
      runtime,
      getPlanId: () => selectedPlan()?.planId ?? null,
      getSelectedSite: () => stationUi?.stationExport?.sites.find((site) => site.stationSiteId === stationSelectionOutput?.stationSiteId) ?? stationUi?.selectedSite ?? null,
      getSelection: () => stationSelectionOutput,
      onChange: () => queueMicrotask(() => { refreshMapOverlay(); refreshScenarioPanel(); }),
    });
    constructionContractorManagement = mountConstructionContractorPanel({
      container: $("scenario-construction-contractors"),
      runtime,
      getPlanId: () => selectedPlan()?.planId ?? null,
      onChange: () => queueMicrotask(() => { refreshMapOverlay(); refreshScenarioPanel(); }),
    });
    canvas.addEventListener("pointerup", () => queueMicrotask(() => stationManagement?.refresh()), true);

    $("scenario-opportunity-view").addEventListener("click", () => run(() => {
      const opportunity = runtime.viewOpportunity();
      message(`${opportunity.authority}의 공고를 확인했습니다. 요구규모에 맞는 계획안을 그려 기술심사에 제출하세요.`);
    }));
    $("scenario-research-basic").addEventListener("click", () => run(() => {
      const result = runtime.researchOpportunity(1);
      message(`기초조사비 ${yen.format(result.cost)}를 지출했습니다. 사업비와 수요의 초기 범위를 확보했습니다.`);
    }));
    $("scenario-research-detailed").addEventListener("click", () => run(() => {
      const result = runtime.researchOpportunity(2);
      message(`정밀조사비 ${yen.format(result.cost)}를 지출했습니다. 지반·지하수·지장물·주민협의 위험까지 확인했습니다.`);
    }));
    $("scenario-bid-go").addEventListener("click", () => run(() => {
      const payment = Number($("scenario-bid-payment").value) * 100_000_000;
      const decision = runtime.decideBid("bid", payment);
      message(`사내 투자심의가 Bid로 결정됐습니다. P50 손익 ${yen.format(decision.memo.p50Profit)}, P90 손익 ${yen.format(decision.memo.p90Profit)}입니다.`);
    }));
    $("scenario-bid-no").addEventListener("click", () => run(() => {
      runtime.decideBid("no-bid", Number($("scenario-bid-payment").value) * 100_000_000);
      message("No Bid를 결정해 이번 공모에서 철수했습니다. 새 게임에서 다른 사업을 선택할 수 있습니다.");
    }));
    $("scenario-tender-submit").addEventListener("click", () => run(() => {
      const plan = selectedPlan();
      if (!plan) throw new Error("기술심사를 통과한 계획선을 선택하세요.");
      const bid = runtime.submitTenderProposal(plan.planId);
      message(`제안준비비와 입찰보증을 반영해 제안서를 제출했습니다. 기술점수는 ${bid.technicalScore.toFixed(1)}점입니다.`);
    }));
    $("scenario-tender-evaluate").addEventListener("click", () => run(() => {
      const result = runtime.evaluateTender();
      const first = result.ranking[0];
      const winner = first?.bidderId === runtime.game.player.id ? "플레이어" : runtime.game.competitors.find((company) => company.id === first?.bidderId)?.name ?? "없음";
      if (result.status === "single-bid-review") message(`적격 제안이 1개뿐입니다. ${winner}의 원가와 계약 적정성을 추가 심사해야 합니다.`);
      else if (!first) message(`평가 결과는 ${result.status}입니다. 조건을 조정해 재공고할 수 있습니다.`, true);
      else message(`총 ${result.ranking.length}개 적격 제안을 평가했습니다. 우선협상자는 ${winner}입니다.`, first.bidderId !== runtime.game.player.id);
    }));
    $("scenario-tender-review").addEventListener("click", () => run(() => {
      const result = runtime.reviewSingleBid(true);
      message(`단독응찰 원가·적정성 심사를 통과했습니다. 우선협상자 ${result.preferredBidderId === runtime.game.player.id ? "플레이어" : result.preferredBidderId}와 협상합니다.`);
    }));
    $("scenario-tender-award").addEventListener("click", () => run(() => {
      const contract = runtime.concludeAward();
      message(`30년 사업계약 ${contract.id}을 체결했습니다. 이제 실시계획 승인과 사업화를 진행할 수 있습니다.`);
    }));
    $("scenario-tender-fail").addEventListener("click", () => run(() => {
      runtime.failPreferredNegotiation();
      const next = runtime.scenarioOpportunity();
      message(next.status === "retender" ? "우선협상이 결렬되어 재공고가 필요합니다." : `협상이 결렬되어 차순위자 ${next.preferredBidderId}로 전환됐습니다.`, true);
    }));
    $("scenario-tender-retender").addEventListener("click", () => run(() => {
      const opportunity = runtime.reannounceTender({ deadlineDays: 90, paymentAdjustment: 1.05 });
      message(`지급조건을 5% 조정해 ${Math.floor((opportunity.deadlineMinute - runtime.game.clock.minute) / 1440)}일 일정으로 재공고했습니다. 공고를 다시 확인하세요.`);
    }));

    $("scenario-submit").addEventListener("click", () => run(() => {
      syncDraftOptions();
      const line = selectedDraft();
      const plan = selectedPlan();
      const result = runtime.submit(plan, line.technicalProfileId);
      line.planLocked = result.status === "assessed";
      message(result.status === "assessed" ? "기술심사를 통과했습니다. 승인·사업화를 진행할 수 있습니다." : `심사 결과: ${result.status}. 지도 진단을 확인하세요.`, result.status !== "assessed");
    }));
    $("scenario-approve").addEventListener("click", () => run(() => {
      const result = runtime.approveAndCreate(selectedPlan().planId);
      message(`사업화 완료: P50 ${yen.format(result.estimate.totalP50)}, 예정 ${result.estimate.durationMonths}개월.`);
    }));
    $("scenario-contract").addEventListener("click", () => run(() => {
      runtime.contract(selectedPlan().planId);
      message("건설 계약을 체결하고 계약금을 지급했습니다.");
    }));
    $("scenario-depot-evaluate").addEventListener("click", () => run(() => {
      const plan = selectedPlan();
      if (!plan) throw new Error("먼저 사업화할 계획선을 선택하세요.");
      const options = selectedDepotOptions();
      const result = runtime.evaluateDepotCandidate(plan.planId, { ...options, operatorShare: options.fundingShares.operatorShare });
      const { assessment } = result;
      const box = $("scenario-depot-result");
      box.hidden = false;
      box.textContent = `${result.usedEstimatedSite ? "추정 후보" : "선택 후보"} · ${assessment.siteClass} · ${assessment.feasibility} · P50 ${yen.format(assessment.economics.totalP50)} · P90 ${yen.format(assessment.economics.totalP90)} · 사업자 ${yen.format(result.operatorCapex)} · 회송 ${yen.format(assessment.economics.deadhead.totalAnnualCost)}/년 · 반대압력 ${assessment.community.oppositionPressure.toFixed(1)} · ${assessment.schedule.durationMonths}개월 · 종합 ${assessment.scores.overall.toFixed(1)}점`;
      message("차량기지 후보 평가를 완료했습니다. 비용·회송·수용성 결과를 확인한 뒤 계약하세요.", assessment.feasibility !== "feasible");
    }));
    $("scenario-prepare").addEventListener("click", () => run(() => {
      const result = runtime.prepareFleet(selectedPlan().planId, selectedDepotOptions());
      message(`${result.usedEstimatedSite ? "추정 후보" : "지도에서 선택한 후보"}에 차량기지 ${result.depot.capacitySets}편성 규모를 계약했습니다. 사업자 부담 ${yen.format(result.agreement.operatorCapex)}, 예정 ${result.depot.assessment.schedule.durationMonths}개월이며 차량 ${result.order.quantity}편성도 발주했습니다.`);
    }));
    $("scenario-construction-link").addEventListener("click", () => run(() => {
      const plan = selectedPlan();
      if (!plan) throw new Error("공구를 연결할 계획선을 선택하세요.");
      const selection = constructionSelectionOutput?.candidateId ? [constructionSelectionOutput] : [];
      const reports = runtime.configureConstructionPackages(plan.planId, constructionUi.constructionExport, selection);
      // Work fronts placed before the schedule existed have nothing to assess against yet; push them now.
      for (const workfront of constructionWorkfront?.builtWorkfronts ?? []) {
        if (workfront.connectedPlanId !== plan.planId) continue;
        try { runtime.applyConstructionWorkfront(plan.planId, workfront); } catch { /* still not linkable */ }
      }
      message(`공사 공구 ${Object.keys(reports).length}곳을 통합 공정표에 연결했습니다${selection.length ? ` · 선택 후보 ${selection[0].kind}` : ""}.`);
      return reports;
    }));
    $("scenario-month").addEventListener("click", () => run(() => {
      const result = runtime.advanceMonths(1)[0];
      message(`공사와 차량 제작을 1개월 진행했습니다. 신규 사건 ${result.generatedEvents?.length ?? 0}건 · 자동 대응 ${result.autoResolvedEvents?.length ?? 0}건.`);
      return result;
    }));
    $("scenario-year").addEventListener("click", () => run(() => {
      const results = runtime.advanceMonths(12);
      const generated = results.reduce((sum, result) => sum + (result.generatedEvents?.length ?? 0), 0);
      const resolved = results.reduce((sum, result) => sum + (result.autoResolvedEvents?.length ?? 0), 0);
      message(`공사와 차량 제작을 12개월 진행했습니다. 신규 사건 ${generated}건 · 자동 대응 ${resolved}건.`);
      return results;
    }));
    $("scenario-suspend").addEventListener("click", () => run(() => {
      const planId = selectedPlan().planId;
      if (runtime.projectForPlan(planId).status === "suspended") { runtime.resume(planId); message("중단했던 공사를 재개했습니다."); }
      else { runtime.suspend(planId, "Player decision"); message("공사를 일시 중단했습니다. 공정과 기성금 지급이 멈춥니다."); }
    }));
    $("scenario-cancel").addEventListener("click", () => {
      const plan = selectedPlan();
      if (!plan) return;
      if (!window.confirm("사업을 취소하면 이미 지급한 공사비는 매몰비용으로 남고 나머지 약정만 해제됩니다. 계속할까요?")) return;
      run(() => {
        const result = runtime.cancel(plan.planId);
        message(`사업을 취소했습니다. 매몰비용은 ${yen.format(result.sunkCost)}입니다.`, true);
        return result;
      });
    });
    $("scenario-open").addEventListener("click", () => run(() => {
      const draft = selectedDraft();
      const result = runtime.open(selectedPlan().planId, { color: draft.color });
      deleteLine(state, draft.id);
      selectedLineId = result.commissioned.lineId;
      message("통합시험과 인허가를 통과해 실제 영업 노선으로 개통했습니다.");
    }));
    $("scenario-save").addEventListener("click", () => run(() => {
      const payload = JSON.stringify({ schemaVersion: 1, runtime: runtime.save(), workfrontDoc: constructionWorkfront?.workfrontDoc ?? null });
      localStorage.setItem(storageKey, payload);
      message("지도·공사·차량·회사 상태와 작업면을 함께 저장했습니다.");
    }));
    $("scenario-load").addEventListener("click", () => run(() => {
      const saved = localStorage.getItem(storageKey);
      if (!saved) throw new Error("불러올 통합 저장본이 없습니다.");
      let payload = null;
      try { payload = JSON.parse(saved); } catch { /* not JSON at all: definitely the old plain runtime.save() string */ }
      const wrapped = payload && typeof payload === "object" && typeof payload.runtime === "string";
      runtime.load(wrapped ? payload.runtime : saved); // older saves stored runtime.save()'s own JSON string directly
      if (wrapped && payload.workfrontDoc) constructionWorkfront?.loadDoc(payload.workfrontDoc);
      selectedLineId = null;
      message("통합 저장본을 불러왔습니다.");
    }));
    refreshMapOverlay();
    refreshScenarioPanel();
  }

  const input = attachInput(canvas, state, projection, (stationIds) => {
    const defaultName = `Line ${state.nextLineId}`;
    const name = window.prompt("Name this line:", defaultName) || defaultName;
    const planningOptions = planningDefaults("medium_steel", "elevated", "island");
    const line = addLine(state, stationIds, scenarioPlay ? {
      name,
      color: selectedColor,
      key: stablePlanKey(pack.manifest.id, stationIds),
      suspended: true,
      planOnly: true,
      technicalProfileId: "medium_steel",
      planningOptions,
    } : { name, color: selectedColor });
    selectedColor = nextLineColor(state); // suggest a fresh color for the next line
    selectedLineId = line.id;
    renderPalette();
    renderLines(state);
    renderRoutePanel(state);
    refreshScenarioPanel();
  });

  // Panels refresh ~4x/second — no need to rewrite the DOM every frame.
  let lastUi = 0;
  // ?model=pop: game-style pop simulation beside the default individual-passenger one (docs: mechanics study, section 5)
  (params.get("model") === "pop" ? startPopLoop : startLoop)(state, demandModel, projection, ctx, canvas, hud, input, (now) => {
    if (now - lastUi < 250) return;
    lastUi = now;
    updateRoutePanelLive(state);
    if (runtime) {
      const settlements = runtime.settleOperatingDays();
      if (settlements.length) refreshScenarioPanel();
    }
    if (!analysisEl.hidden) updateAnalysis(state, depBars, arrBars);
  });
}

main().catch((err) => {
  console.error(err);
  errorEl.textContent = `Failed to load pack '${packPath}': ${err.message}`;
  errorEl.hidden = false;
});
