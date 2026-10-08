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
import { buildMapExport, drawnLinesFromState, existingNetworkToExternal, withRailLayer } from "./map/plan-geometry.mjs";
import { demandSourceRefsOf } from "./map/station-demand-access.mjs";
import { mountStationDemandAccess } from "./map/station-demand-access-ui.mjs";
import { mountStationDemandAllocationOverlay } from "./map/station-demand-allocation-ui.mjs";
import { mountServicePlanEditor } from "./map/service-plan-ui.mjs";
import { mountServicePlanAssumptionsPanel } from "./service-plan-assumptions-ui.mjs";
import { spatialContextFromPack } from "./map/pack-spatial.mjs";
import { buildOverlayModel, defineViewSlots, renderDiagnosticsPanel, renderPhaseLegend } from "./map/overlay.mjs";
import { attachDepotEditor } from "./map/depot-ui.mjs";
import { attachStationEditor } from "./map/station-ui.mjs";
import { mountStationSelection } from "./map/station-selection-ui.mjs";
import { attachConstructionEditor } from "./map/construction-ui.mjs";
import { mountConstructionSelection } from "./map/construction-selection-ui.mjs";
import { mountConstructionImpact } from "./map/construction-impact-ui.mjs";
import { mountConstructionWorkfront } from "./map/construction-workfront-ui.mjs";
import { attachThroughHandoverEditor } from "./map/through-handover-ui.mjs";
import { mountSiteDesignBridge } from "./map/site-design-bridge.mjs";
import { planIdForKey, planningDefaults, ScenarioRuntime, stablePlanKey } from "./scenario-runtime.mjs";
import { mountStationManagementPanel } from "./station-management-ui.mjs";
import { mountConstructionContractorPanel } from "./construction-contractor-ui.mjs";
import { mountThroughServiceManagementPanel } from "./through-service-management-ui.mjs";
import { mountRailReplacementManagementPanel } from "./rail-replacement-management-ui.mjs";
import { mountRailwayDetourManagementPanel } from "./railway-detour-management-ui.mjs";
import { mountRailCapacityApplicationPanel } from "./rail-capacity-application-ui.mjs";
import { mountRailwayDisruptionManagementPanel } from "./railway-disruption-management-ui.mjs";
import { mountRailwayServiceControlManagementPanel } from "./railway-service-control-management-ui.mjs";
import { mountStationDemandAllocationManagementPanel } from "./station-demand-allocation-management-ui.mjs";
import { mountServicePlanManagementPanel } from "./service-plan-management-ui.mjs";
import { mountRailwayTimetableLifecyclePanel } from "./railway-timetable-lifecycle-ui.mjs";
import { TECHNICAL_PROFILES } from "./management/construction.mjs";
import { mountMapInputPipeline } from "./map/map-input-pipeline.mjs";
import { externalInfrastructureCatalogForRoute } from "./through-route-planning-integration.mjs";

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
  const external = existingNetworkToExternal(pack);
  for (const line of pack.existingNetwork.lines) {
    const stationIds = line.stationIds.filter((id) => state.stations.has(id));
    // dedupe consecutive repeats defensively (e.g. two source stops that map to the same station)
    const path = stationIds.filter((id, i) => id !== stationIds[i - 1]);
    if (path.length < 2) continue;
    const operationalLine = addLine(state, path, { name: line.name, color: line.color ?? undefined, external: true });
    const externalLine = line.osmRelationId !== undefined
      ? external.lines.find((candidate) => candidate.osmRelationId === line.osmRelationId)
      : external.lines.find((candidate) => candidate.name === line.name && candidate.stationIds.join("\u0000") === path.join("\u0000"));
    operationalLine.externalNetworkId = external.id;
    operationalLine.externalLineId = externalLine?.id ?? null;
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
  const state = defineViewSlots(createState(pack), ["mapOverlay", "depotView", "stationView", "constructionView", "throughHandoverView"]); // display-only: kept out of saves
  seedExistingNetwork(state, pack);
  syncNetworkModeUI(pack);

  const networkMode = params.get("network") === "scratch" || !pack.existingNetwork ? "scratch" : "existing";
  const countryId = params.get("country") === "KR" ? "KR" : "JP";
  const difficulty = ["easy", "normal", "hard"].includes(params.get("difficulty")) ? params.get("difficulty") : "normal";
  const fundingMode = params.get("funding") === "sandbox" ? "sandbox" : "limited";
  const runtime = scenarioPlay ? new ScenarioRuntime({ pack, operationalState: state, countryId, networkMode, fundingMode, difficulty }) : null;
  const packSpatial = spatialContextFromPack(pack);

  // Map -> engine is data only: player plans become PlanGeometry; the management engine's report
  // (statuses, verdicts) comes back through setEngineReport and is only displayed, never written.
  let engineReport = null;
  let currentMapExport = null;
  let depotUi = null;
  let stationUi = null;
  let stationDemandAccessUi = null;
  let stationDemandAccessOutput = null;
  let stationDemandAllocationOverlay = null;
  let servicePlanEditor = null;
  let servicePlanAssumptions = null;
  let servicePlanManagement = null;
  let railwayTimetableLifecycle = null;
  let stationSelection = null;
  let stationSelectionOutput = null;
  let constructionUi = null;
  let constructionSelection = null;
  let constructionSelectionOutput = null;
  let constructionImpact = null;
  let constructionImpactOutput = null;
  let constructionWorkfront = null;
  let throughHandoverUi = null;
  let throughServiceManagement = null;
  let railReplacementManagement = null;
  let railwayDetourManagement = null;
  let railCapacityApplicationManagement = null;
  let railwayDisruptionManagement = null;
  let railwayServiceControlManagement = null;
  let railReplacementGeometries = [];
  let mapInputPipeline = null;
  let mapInputOutput = null;
  const getCurrentSpatial = () => withRailLayer(packSpatial, currentMapExport?.externalNetworks ?? []);
  refreshMapOverlay = () => {
    currentMapExport = buildMapExport({ pack, mode: networkMode, drawnLines: drawnLinesFromState(state), spatial: packSpatial });
    const report = runtime?.report() ?? engineReport ?? {};
    state.mapOverlay = scenarioPlay ? buildOverlayModel(currentMapExport, report) : null;
    renderDiagnosticsPanel($("map-diagnostics"), state.mapOverlay?.diagnostics ?? []);
    depotUi?.refresh(); // depot connections are checked against the plans just exported
    stationUi?.refresh(); // station sites are checked against the plans just exported, and show the engine verdict
    stationDemandAccessUi?.refresh();
    stationDemandAllocationOverlay?.refresh();
    servicePlanEditor?.refresh();
    servicePlanAssumptions?.refresh();
    $("btn-station-3d").disabled = !stationUi?.selectedSite;
    stationSelection?.refresh();
    constructionUi?.refresh();
    constructionSelection?.refresh();
    constructionImpact?.refresh();
    constructionWorkfront?.refresh();
    throughHandoverUi?.refresh();
    mapInputPipeline?.refresh();
    railwayDetourManagement?.refresh();
    railCapacityApplicationManagement?.refresh();
    railwayDisruptionManagement?.refresh();
    railwayServiceControlManagement?.refresh();
    servicePlanManagement?.refresh();
    railwayTimetableLifecycle?.refresh();
  };
  window.transitlineMap = {
    setEngineReport(report) { engineReport = report; refreshMapOverlay(); },
    // This is the narrow M8 -> operations boundary. Map code can publish completed geometry,
    // but never prices or validates an operating decision.
    setRailReplacementGeometries(geometries) {
      railReplacementGeometries = structuredClone(Array.isArray(geometries) ? geometries : []);
      railReplacementManagement?.refresh();
    },
    mapInputPipelineOutput() { return structuredClone(mapInputPipeline?.output() ?? mapInputOutput); },
  };
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
  depotUi = attachDepotEditor({ canvas, projection, pack, state, getMapExport: () => currentMapExport, getSpatial: getCurrentSpatial, panel: $("depot-panel"), compare: $("depot-compare"), button: $("btn-depot") });
  // Station sites: spatial facts for stations, entrances, transfers and work areas; the engine verdict is drawn read-only
  stationUi = attachStationEditor({ canvas, projection, pack, state, getMapExport: () => currentMapExport, getSpatial: getCurrentSpatial, getOverlay: () => state.mapOverlay, panel: $("station-panel"), button: $("btn-station") });
  const stationDemandSources = () => {
    const tokyoCoarse = pack.manifest?.id === "tokyo";
    const quality = tokyoCoarse ? "low" : "medium";
    const spatialResolution = tokyoCoarse ? "municipality-centroid" : "individual-demand-node";
    const documents = [{ file: "demand.json", kind: "demand-points", document: pack.demand, quality, spatialResolution, license: pack.manifest?.data?.license ?? null }];
    if (pack.od) documents.push({ file: "od.json", kind: "od-commute", document: pack.od, quality, spatialResolution, license: pack.manifest?.data?.license ?? null });
    if (pack.odSchool) documents.push({ file: "od-school.json", kind: "od-school", document: pack.odSchool, quality, spatialResolution, license: pack.manifest?.data?.license ?? null });
    return demandSourceRefsOf(documents, pack.manifest?.id);
  };
  stationDemandAccessUi = mountStationDemandAccess({
    canvas, projection, pack, enabled: false,
    getPlans: () => currentMapExport?.plans ?? [], getExternalNetworks: () => currentMapExport?.externalNetworks ?? [],
    getDemandNodes: () => currentMapExport?.demandNodes ?? [], getDemandSources: stationDemandSources, getSpatial: getCurrentSpatial,
    onChange: (out) => { stationDemandAccessOutput = out; },
  });
  if (runtime) {
    stationDemandAllocationOverlay = mountStationDemandAllocationOverlay({
      canvas,
      projection,
      pack,
      enabled: false,
      getAllocationReport: () => runtime.stationDemandAllocationReport(),
      getAccessReport: () => runtime.stationDemandAccessReport(),
      getDemandNodes: () => state.demandNodes,
      getStations: () => state.stations,
    });
  }
  const stationDemandAccessButton = $("btn-station-demand-access");
  stationDemandAccessButton.hidden = false;
  stationDemandAccessButton.addEventListener("click", () => {
    const enabled = !stationDemandAccessButton.classList.contains("active");
    stationDemandAccessButton.classList.toggle("active", enabled);
    stationDemandAccessUi.setEnabled(enabled);
    stationDemandAccessButton.blur();
  });
  const stationDemandAllocationButton = $("btn-station-demand-allocation");
  if (runtime) {
    stationDemandAllocationButton.hidden = false;
    stationDemandAllocationButton.addEventListener("click", () => {
      const enabled = !stationDemandAllocationButton.classList.contains("active");
      stationDemandAllocationButton.classList.toggle("active", enabled);
      stationDemandAllocationOverlay?.setEnabled(enabled);
      stationDemandAllocationButton.blur();
    });
  }
  constructionUi = attachConstructionEditor({
    canvas,
    projection,
    pack,
    state,
    getMapExport: () => currentMapExport,
    getDepotExport: () => depotUi?.depotExport,
    getSpatial: getCurrentSpatial,
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
        if ($("btn-through-handover").classList.contains("active")) $("btn-through-handover").click();
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
      if (enabled) for (const id of ["btn-depot", "btn-station", "btn-construction", "btn-through-handover", "btn-station-design"]) if ($(id).classList.contains("active")) $(id).click();
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
      getSpatial: getCurrentSpatial,
      enabled: false,
      onChange: (output) => { constructionImpactOutput = output; queueMicrotask(() => refreshScenarioPanel()); },
    });
    const impactButton = $("btn-construction-impact");
    impactButton.hidden = false;
    impactButton.addEventListener("click", () => {
      const enabled = !impactButton.classList.contains("active");
      if (enabled) for (const id of ["btn-depot", "btn-station", "btn-construction", "btn-through-handover", "btn-station-design", "btn-construction-select"]) if ($(id).classList.contains("active")) $(id).click();
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
      getSpatial: getCurrentSpatial,
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
      if (enabled) for (const id of ["btn-depot", "btn-station", "btn-construction", "btn-through-handover", "btn-station-design", "btn-construction-select", "btn-construction-impact"]) if ($(id).classList.contains("active")) $(id).click();
      workfrontButton.classList.toggle("active", enabled);
      constructionWorkfront.setEnabled(enabled);
      workfrontButton.blur();
    });
    for (const editorButton of [$("btn-depot"), $("btn-station"), $("btn-construction"), $("btn-station-design"), $("btn-construction-select"), impactButton]) editorButton.addEventListener("click", () => {
      if (editorButton.classList.contains("active") && workfrontButton.classList.contains("active")) workfrontButton.click();
    });

    // Through-running connection editor: the map contributes only measured geometry. The management engine
    // prices, permits and builds the selected site through the stable handoverSiteId/revision contract.
    throughHandoverUi = attachThroughHandoverEditor({
      canvas,
      projection,
      pack,
      state,
      getRoutes: () => (runtime.report().throughRoutes ?? []).map((entry) => entry.route),
      getMapExport: () => currentMapExport,
      getSpatial: getCurrentSpatial,
      getExternalAlignments: () => [],
      panel: $("through-handover-panel"),
      summary: $("through-handover-summary"),
      legend: $("through-handover-legend"),
      button: $("btn-through-handover"),
      onChange: () => queueMicrotask(() => throughServiceManagement?.refresh()),
    });
    $("btn-through-handover").hidden = false;

    // B14 map inputs are spatial/player facts only.  They become engine state only when a later
    // explicit ScenarioRuntime command accepts a current application, control choice or detour.
    const pipelineButton = $("btn-railway-control");
    const throughRoutesForMap = () => (runtime.report().throughRoutes ?? []).map((entry) => entry?.route ?? entry)
      .filter((route) => route?.schema === "transitline.through-route-geometry/1");
    // A catalog is route-specific. Combining entries for two through routes that use the same
    // external line would make ownership/specification evidence ambiguous.
    const externalCatalogForDetour = (detour = null) => {
      const routes = throughRoutesForMap();
      const route = detour?.throughRouteId
        ? routes.find((candidate) => candidate.throughRouteId === detour.throughRouteId)
        : routes.length === 1 ? routes[0] : null;
      if (!route) return null;
      try { return externalInfrastructureCatalogForRoute(pack, route); }
      catch { return null; }
    };
    mapInputPipeline = mountMapInputPipeline({
      canvas,
      projection,
      pack,
      getPlans: () => currentMapExport?.plans ?? [],
      getRoutes: throughRoutesForMap,
      getExternalNetworks: () => currentMapExport?.externalNetworks ?? [],
      // A multi-route generic catalog would merge duplicate external-line evidence. The selected
      // detour gets its precise route catalog in the management panel below.
      getExternalCatalog: () => externalCatalogForDetour(),
      getStationSites: () => stationUi?.stationExport?.sites ?? [],
      getSpatial: getCurrentSpatial,
      getRailCapacityApplication: () => runtime.railCapacityApplicationReport(),
      getDisruptionEvents: () => runtime.railwayDisruptionReport().events,
      enabled: false,
      onChange: (output) => {
        mapInputOutput = output;
        queueMicrotask(() => refreshScenarioPanel());
      },
    });
    servicePlanEditor = mountServicePlanEditor({
      canvas,
      projection,
      pack,
      enabled: false,
      getRailGeometries: () => mapInputPipeline?.output().railGeometries ?? [],
      getApplications: () => runtime.railCapacityApplicationReport(),
      getDepots: () => runtime.game.depots ?? [],
      onChange: () => queueMicrotask(() => {
        servicePlanAssumptions?.refresh();
        servicePlanManagement?.refresh();
        railwayTimetableLifecycle?.refresh();
      }),
    });
    servicePlanAssumptions = mountServicePlanAssumptionsPanel({
      container: $("scenario-service-plan-assumptions"),
      pack,
      getServicePlans: () => servicePlanEditor?.output().export?.plans ?? [],
      getTechnicalProfiles: () => Object.values(TECHNICAL_PROFILES).map((profile) => ({ id: profile.id, name: profile.id })),
      storage: window.localStorage,
      onChange: () => queueMicrotask(() => {
        servicePlanManagement?.refresh();
        railwayTimetableLifecycle?.refresh();
        refreshScenarioPanel();
      }),
    });
    const servicePlanButton = $("btn-service-plan");
    servicePlanButton.hidden = false;
    servicePlanButton.addEventListener("click", () => {
      const enabled = !servicePlanButton.classList.contains("active");
      servicePlanButton.classList.toggle("active", enabled);
      servicePlanEditor?.setEnabled(enabled);
      servicePlanButton.blur();
    });
    pipelineButton.hidden = false;
    pipelineButton.addEventListener("click", () => {
      const enabled = !pipelineButton.classList.contains("active");
      if (enabled) for (const id of ["btn-depot", "btn-station", "btn-construction", "btn-through-handover", "btn-station-design", "btn-construction-select", "btn-construction-impact", "btn-construction-workfront"]) {
        if ($(id).classList.contains("active")) $(id).click();
      }
      pipelineButton.classList.toggle("active", enabled);
      mapInputPipeline.setEnabled(enabled);
      pipelineButton.blur();
    });

    // 3D station-site editor (packs/tokyo/site-design.html), opened for the currently selected station
    // candidate. The bridge owns the iframe/postMessage plumbing and spatial collision recheck; this module
    // only decides what "submitted" means for the management engine (request → approve, or reject with a
    // reason) — never a cost, duration or bid eligibility judgement of its own.
    const siteDesignBridge = mountSiteDesignBridge({
      pack,
      getSpatial: getCurrentSpatial,
      onSubmit: (edit, { collisionResult }) => {
        const deliveryPackage = runtime.game.stationPackages.find((p) => p.stationSiteId === edit.stationSiteId);
        if (!deliveryPackage) return { accepted: false, reason: "이 역은 아직 시공사 낙찰까지 진행되지 않아 설계변경을 접수할 수 없습니다." };
        const planId = deliveryPackage.connectedPlanId;
        let proposal = null;
        try {
          proposal = runtime.requestStationDesignChange(planId, deliveryPackage.id, { designEdit: edit, collisionResult });
          const blocking = proposal.collision?.blocking === true;
          const unconfirmed = proposal.collision?.status === "unknown";
          if (proposal.violations?.length || blocking || unconfirmed) {
            const reasons = [
              ...proposal.violations.map((v) => v.code ?? JSON.stringify(v)),
              ...(blocking ? ["확인된 건물·수역 충돌"] : []),
              ...(unconfirmed ? ["충돌 재확인 대기 중 (다시 제출해 주세요)"] : []),
            ];
            runtime.rejectStationDesignChange(planId, deliveryPackage.id, proposal.id, reasons.join("; "));
            refreshMapOverlay();
            refreshScenarioPanel();
            return { accepted: false, reason: reasons.join("; ") };
          }
          runtime.approveStationDesignChange(planId, deliveryPackage.id, proposal.id);
          refreshMapOverlay();
          refreshScenarioPanel();
          return { accepted: true };
        } catch (error) {
          // Approval can fail after the proposal was created (for example, insufficient cash).
          // Finalize it as rejected so it cannot block the player's next revision attempt.
          if (proposal?.id) {
            try { runtime.rejectStationDesignChange(planId, deliveryPackage.id, proposal.id, `approval-failed: ${error.message}`); }
            catch { /* already finalized; preserve the original failure */ }
          }
          refreshMapOverlay();
          refreshScenarioPanel();
          return { accepted: false, reason: error.message };
        }
      },
      // cancelled: nothing changes — the bridge itself never touches game state for a cancel either way.
      onCancel: () => {},
    });
    const site3dButton = $("btn-station-3d");
    site3dButton.hidden = false;
    site3dButton.addEventListener("click", () => {
      const site = stationUi?.selectedSite;
      if (!site) return;
      const deliveryPackage = runtime.game.stationPackages.find((p) => p.stationSiteId === site.stationSiteId);
      const baseRevision = deliveryPackage ? runtime.stationDesignRevision(deliveryPackage.id) : "unawarded";
      siteDesignBridge.open(site, { baseRevision });
      site3dButton.blur();
    });
  }
  // Map editors own the pointer while active: keep exactly one drawing editor on.
  const drawingButtons = [$("btn-depot"), $("btn-station"), $("btn-station-demand-access"), $("btn-station-demand-allocation"), $("btn-construction"), $("btn-through-handover"), $("btn-railway-control"), $("btn-service-plan")];
  for (const activeButton of drawingButtons) {
    activeButton.addEventListener("click", () => {
      if (!activeButton.classList.contains("active")) return;
      for (const other of drawingButtons) if (other !== activeButton && other.classList.contains("active")) other.click();
      for (const id of ["btn-station-design", "btn-construction-select", "btn-construction-impact", "btn-construction-workfront"]) {
        if ($(id).classList.contains("active")) $(id).click();
      }
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
    let stationDemandAllocationManagement = null;
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

    const renderOperatingEconomy = () => {
      const container = $("scenario-operations-economy");
      container.replaceChildren();
      if (!runtime.game.services.length) {
        const empty = document.createElement("div");
        empty.className = "operations-economy-empty";
        empty.textContent = "노선 개통 후 실제 승객·열차 운행 결과가 월별 손익으로 집계됩니다.";
        container.append(empty);
        return;
      }
      const disruptionReport = runtime.railwayDisruptionReport();
      if (disruptionReport.events.length) {
        const disruptionBox = document.createElement("section");
        disruptionBox.className = "railway-disruption-summary";
        const disruptionTitle = document.createElement("strong");
        disruptionTitle.textContent = `운행 장애·속도제한 · 활성 ${disruptionReport.activeCount}건`;
        disruptionBox.append(disruptionTitle);
        for (const event of [...disruptionReport.events].reverse().slice(0, 8)) {
          const row = document.createElement("div");
          row.className = `railway-disruption-row ${event.status}`;
          const target = event.trackSegmentId ? `구간 ${event.trackSegmentId}` : `열차 ${event.trainId}`;
          const effect = event.effect.closed ? "운행 차단" : `제한 ${Math.round(event.effect.speedLimitMps * 3.6)}km/h`;
          row.textContent = `${event.kind} · ${target} · ${effect} · ${event.status}`;
          disruptionBox.append(row);
        }
        container.append(disruptionBox);
      }
      const corporate = runtime.game.corporateFinancialStatements({ fromMonth: Math.max(0, Math.floor(runtime.game.clock.minute / (30 * 1440)) - 5) });
      const corporateLatest = corporate.monthly.at(-1);
      const corporateCard = document.createElement("article");
      corporateCard.className = "operations-economy-card operations-corporate-card";
      const corporateTitle = document.createElement("div");
      corporateTitle.className = "operations-economy-head";
      const corporateName = document.createElement("b");
      corporateName.textContent = "회사 연결재무";
      const corporateMonth = document.createElement("span");
      corporateMonth.textContent = `${corporate.throughMonth}월 결산`;
      corporateTitle.append(corporateName, corporateMonth);
      corporateCard.append(corporateTitle);
      const corporateMetrics = document.createElement("div");
      corporateMetrics.className = "operations-economy-metrics";
      for (const [label, value] of [
        ["현금", yen.format(corporate.balanceSheet.cashJPY)],
        ["가용현금", yen.format(corporate.balanceSheet.availableCashJPY)],
        ["고정자산", yen.format(corporate.balanceSheet.fixedAssetsJPY)],
        ["건설부채", yen.format(corporate.balanceSheet.constructionDebtJPY)],
        ["자기자본", yen.format(corporate.balanceSheet.equityJPY)],
        ["월 EBITDA", yen.format(corporateLatest.ebitdaJPY)],
        ["월 세전손익", yen.format(corporateLatest.pretaxProfitJPY)],
        ["영업현금흐름", yen.format(corporateLatest.cashFlow.operatingJPY)],
      ]) {
        const cell = document.createElement("div");
        const name = document.createElement("span");
        const number = document.createElement("b");
        name.textContent = label;
        number.textContent = value;
        cell.append(name, number);
        corporateMetrics.append(cell);
      }
      corporateCard.append(corporateMetrics);
      container.append(corporateCard);
      const poolReports = runtime.operatingResourcePoolReport();
      for (const pool of poolReports) {
        const poolCard = document.createElement("article");
        poolCard.className = "operations-economy-card operations-resource-pool-card";
        const poolHead = document.createElement("div");
        poolHead.className = "operations-economy-head";
        const poolName = document.createElement("b");
        poolName.textContent = `공동운용 · ${pool.name}`;
        const poolStatus = document.createElement("span");
        poolStatus.textContent = pool.warnings.length ? `제약 ${pool.warnings.join(", ")}` : "정상 배분";
        poolHead.append(poolName, poolStatus);
        const poolMetrics = document.createElement("div");
        poolMetrics.className = "operations-economy-metrics";
        for (const [label, value] of [
          ["소속 노선", `${pool.assignments.length}개`],
          ["주력 편성", `${pool.capacity.assignedPrimarySets}편성`],
          ["공동 예비", `${pool.capacity.sharedReserveSets}편성`],
          ["동시근무", `${pool.capacity.assignedStaffConcurrent.toFixed(1)} / ${pool.capacity.totalStaffConcurrent.toFixed(1)}명`],
          ["유치 용량", `${pool.capacity.totalVehicleSets} / ${pool.capacity.totalDepotCapacitySets}편성`],
          ["일일 검사", `${pool.capacity.totalInspectionSetsPerDay}편성`],
        ]) {
          const cell = document.createElement("div");
          const name = document.createElement("span");
          const number = document.createElement("b");
          name.textContent = label;
          number.textContent = value;
          cell.append(name, number);
          poolMetrics.append(cell);
        }
        poolCard.append(poolHead, poolMetrics);
        container.append(poolCard);
      }
      const unassignedServices = runtime.game.services.filter((service) => !service.resourcePoolId);
      if (unassignedServices.length >= 2) {
        const createPool = document.createElement("button");
        createPool.type = "button";
        createPool.className = "operations-create-pool";
        createPool.textContent = `미배정 ${unassignedServices.length}개 노선 공동운용 시작`;
        createPool.addEventListener("click", () => run(() => {
          const id = `operating-pool:${runtime.game.operatingResourcePools.length + 1}`;
          const vehicleOrderIds = [...new Set(unassignedServices.map((service) => service.vehicleOrderId))];
          const depotIds = [...new Set(unassignedServices.map((service) => service.depotId))];
          const totalStaffConcurrent = Math.ceil(unassignedServices.reduce((sum, service) => sum + service.fleetRequirement.serviceSets * service.staffPerSet, 0) * 1.1);
          runtime.createOperatingResourcePool({ id, name: `통합 운용본부 ${runtime.game.operatingResourcePools.length + 1}`, vehicleOrderIds, depotIds, totalStaffConcurrent });
          unassignedServices.forEach((service, index) => runtime.assignServiceToOperatingResourcePool(service.id, id, { priority: unassignedServices.length - index, homeDepotId: service.depotId }));
          message(`${unassignedServices.length}개 노선의 차량·예비편성·인력·차량기지를 공동운용합니다.`);
          return runtime.operatingResourcePoolReport(id);
        }));
        container.append(createPool);
      }
      for (const service of runtime.game.services) {
        const reports = runtime.game.operatingMonthReport(service.id).sort((a, b) => b.month - a.month);
        const latest = reports[0] ?? null;
        const resources = runtime.game.resolveOperatingResources(service.id);
        const trackAccess = runtime.trackAccessReport(service.id);
        const accessImpact = trackAccess.impacts[service.id];
        const units = resources.units;
        const due = units.filter((unit) => unit.status === "inspection-due").length;
        const repairing = units.filter((unit) => unit.status === "repairing").length;
        const averageCondition = units.length ? units.reduce((sum, unit) => sum + (unit.condition ?? 1), 0) / units.length : null;
        const card = document.createElement("article");
        card.className = "operations-economy-card";
        const head = document.createElement("div");
        head.className = "operations-economy-head";
        const title = document.createElement("b");
        title.textContent = service.name ?? service.id;
        const status = document.createElement("span");
        status.textContent = `${service.status} · 재무 ${service.financialStatus ?? "current"}`;
        head.append(title, status);
        card.append(head);

        const metrics = document.createElement("div");
        metrics.className = "operations-economy-metrics";
        const values = latest ? [
          ["선로사용 수입", yen.format(latest.money.trackAccessRevenueJPY ?? 0)],
          ["운용 자원", resources.poolId ? `공동 풀 ${resources.poolId}` : "노선 전용"],
          ["운송수입", yen.format(latest.operatingIncomeJPY)],
          ["운영비", yen.format(latest.operatingCostJPY)],
          ["금융비", yen.format(latest.financeCostJPY)],
          ["갱신투자", yen.format(latest.capitalCostJPY ?? 0)],
          ["월 순현금", yen.format(latest.netCashJPY)],
          ["수송인원", `${Math.round(latest.passengers).toLocaleString("ko-KR")}명`],
          ["열차 주행", `${Math.round(latest.trainKm).toLocaleString("ko-KR")}km`],
          ["차량 평균상태", averageCondition === null ? "-" : `${(averageCondition * 100).toFixed(1)}%`],
          ["시설 평균상태", latest.infrastructure.averageCondition === null ? "-" : `${(latest.infrastructure.averageCondition * 100).toFixed(1)}%`],
          ["검사 대기", `${due}편성`],
          ["고장 수리", `${repairing}편성`],
          ["월 고장", `${latest.reliability?.failures ?? 0}건`],
          ["예비 대체", `${latest.reliability?.reserveSubstitutions ?? 0}회`],
          ["평균 정시율", latest.reliability?.averagePunctuality === null || latest.reliability?.averagePunctuality === undefined ? "-" : `${(latest.reliability.averagePunctuality * 100).toFixed(2)}%`],
          ["고장 수리비", yen.format(latest.money.vehicleRepairJPY ?? 0)],
          ["시장점유율", latest.market?.averagePlayerShare === null || latest.market?.averagePlayerShare === undefined ? "-" : `${(latest.market.averagePlayerShare * 100).toFixed(1)}%`],
          ["경쟁사업자", `${service.operatingCompetitors?.length ?? 0}개사`],
        ] : [
          ["운영 정산", "첫 영업일 대기"],
          ["차량", `${units.length}편성`],
          ["운용 자원", resources.poolId ? `공동 풀 ${resources.poolId}` : "노선 전용"],
        ];
        for (const [label, value] of values) {
          const cell = document.createElement("div");
          const name = document.createElement("span");
          const number = document.createElement("b");
          name.textContent = label;
          number.textContent = value;
          cell.append(name, number);
          metrics.append(cell);
        }
        card.append(metrics);
        const project = runtime.game.projects.find((entry) => entry.id === service.projectId);
        const activePrograms = runtime.game.infrastructureMaintenanceReport(service.projectId).filter((entry) => entry.status === "active");
        const maintenanceAssets = (project?.assets ?? []).filter((asset) => !asset.maintenanceProgramId && (asset.condition ?? 1) < 0.75);
        const maintenance = document.createElement("div");
        maintenance.className = "operations-maintenance-actions";
        const maintenanceStatus = document.createElement("span");
        maintenanceStatus.textContent = activePrograms.length
          ? `보수 진행 ${activePrograms.map((entry) => `${entry.strategyId} ${entry.elapsedDays}/${entry.durationDays}일`).join(" · ")}`
          : maintenanceAssets.length ? `보수 필요 자산 ${maintenanceAssets.length}개` : "보수 필요 자산 없음";
        maintenance.append(maintenanceStatus);
        for (const [strategyId, label] of [["night", "야간보수"], ["intensive", "집중보수"], ["renewal", "전면갱신"]]) {
          const button = document.createElement("button");
          button.type = "button";
          button.textContent = label;
          const targets = strategyId === "renewal" ? maintenanceAssets.filter((asset) => (asset.condition ?? 1) < 0.55) : maintenanceAssets;
          button.disabled = !targets.length;
          button.addEventListener("click", () => run(() => {
            const program = runtime.game.startInfrastructureMaintenance(service.projectId, { assetIds: targets.map((asset) => asset.id), strategyId });
            message(`${label} 착수 · ${program.durationDays}일 · ${yen.format(program.totalCostJPY)}`);
            return program;
          }));
          maintenance.append(button);
        }
        card.append(maintenance);
        const policy = document.createElement("div");
        policy.className = "operations-policy-actions";
        const fare = document.createElement("input");
        fare.type = "number";
        fare.min = "100";
        fare.max = "2000";
        fare.step = "10";
        fare.value = String(service.averageFare);
        fare.title = "기본운임(JPY)";
        const frequency = document.createElement("input");
        frequency.type = "number";
        frequency.min = "0.5";
        frequency.max = "30";
        frequency.step = "0.5";
        frequency.value = String(service.trainsPerHour);
        frequency.title = "시간당 운행횟수";
        const staffing = document.createElement("select");
        for (const [value, label] of [["lean", "최소인력"], ["balanced", "균형인력"], ["resilient", "예비인력"]]) staffing.append(new Option(label, value));
        staffing.value = service.staffingPolicyId ?? "balanced";
        const electricity = document.createElement("select");
        for (const [value, label] of [["spot", "시장연동 전력"], ["fixed", "고정단가 전력"], ["renewable", "재생에너지"]]) electricity.append(new Option(label, value));
        electricity.value = service.electricityContractId ?? "spot";
        const applyPolicy = document.createElement("button");
        applyPolicy.type = "button";
        applyPolicy.textContent = "운영정책 적용";
        applyPolicy.addEventListener("click", () => run(() => {
          const result = runtime.updateServicePolicy(service.id, { fareJPY: Number(fare.value), trainsPerHour: Number(frequency.value), staffingPolicyId: staffing.value, electricityContractId: electricity.value });
          message(`운영정책 개정 ${result.policy.revision} · 수요계수 ${result.policy.forecastDemandMultiplier.toFixed(2)}${result.warnings.length ? ` · 경고 ${result.warnings.join(", ")}` : ""}`);
          return result;
        }));
        const addCompetitor = document.createElement("button");
        addCompetitor.type = "button";
        addCompetitor.textContent = "경쟁사업자 진입";
        addCompetitor.disabled = (service.operatingCompetitors?.length ?? 0) >= 3;
        addCompetitor.addEventListener("click", () => run(() => {
          const index = (service.operatingCompetitors?.length ?? 0) + 1;
          const competitor = runtime.addOperatingCompetitor(service.id, { id: `rival:${service.id}:${index}`, name: `경쟁교통 ${index}`, fareJPY: Math.max(100, service.averageFare + (index - 2) * 20), trainsPerHour: Math.max(1, service.trainsPerHour + (index % 2 ? 1 : -1)), punctuality: 0.96 + index * 0.005 });
          message(`${competitor.name}이 동일 교통시장에 진입했습니다.`);
          return competitor;
        }));
        const policyLabels = document.createElement("span");
        policyLabels.textContent = "운임(JPY) · 시간당 운행 · 인력 · 전력계약";
        policy.append(policyLabels, fare, frequency, staffing, electricity, applyPolicy, addCompetitor);
        if (service.resourcePoolId) {
          const leavePool = document.createElement("button");
          leavePool.type = "button";
          leavePool.textContent = "공동운용 해제";
          leavePool.addEventListener("click", () => run(() => {
            runtime.removeServiceFromOperatingResourcePool(service.id);
            message(`${service.name ?? service.id} 노선을 전용 차량·차량기지 운용으로 되돌렸습니다.`);
            return true;
          }));
          policy.append(leavePool);
        }
        card.append(policy);
        const accessBox = document.createElement("div");
        accessBox.className = "operations-track-access";
        const accessSummary = document.createElement("span");
        const currentAgreement = [...trackAccess.agreements].reverse().find((entry) => ["active", "suspended"].includes(entry.status));
        const currentOpportunity = [...trackAccess.opportunities].reverse().find((entry) => ["announced", "offers-received"].includes(entry.status));
        if (currentAgreement) {
          const utilisation = accessImpact.hostCapacityTrainsPerHour
            ? `${(accessImpact.utilisation * 100).toFixed(1)}%`
            : "-";
          accessSummary.textContent = `선로사용 계약 · ${currentAgreement.guestOperatorName} · 경쟁사 ${currentAgreement.trainsPerHour}회/시 · 용량 사용률 ${utilisation} · ${currentAgreement.status}`;
          const statusButton = document.createElement("button");
          statusButton.type = "button";
          statusButton.textContent = currentAgreement.status === "active" ? "계약 일시중단" : "계약 재개";
          statusButton.addEventListener("click", () => run(() => {
            const nextStatus = currentAgreement.status === "active" ? "suspended" : "active";
            const changed = runtime.setTrackAccessAgreementStatus(currentAgreement.id, nextStatus);
            message(`선로사용 계약을 ${nextStatus === "active" ? "재개" : "일시중단"}했습니다.`);
            return changed;
          }));
          const terminateButton = document.createElement("button");
          terminateButton.type = "button";
          terminateButton.textContent = "계약 해지";
          terminateButton.addEventListener("click", () => run(() => {
            const changed = runtime.setTrackAccessAgreementStatus(currentAgreement.id, "terminated");
            message(`${currentAgreement.guestOperatorName} 선로사용 계약을 해지했습니다.`);
            return changed;
          }));
          accessBox.append(accessSummary, statusButton, terminateButton);
        } else if (!currentOpportunity) {
          accessSummary.textContent = "남는 선로 용량을 경쟁사에 판매해 사용료 수입을 얻을 수 있습니다.";
          const announceButton = document.createElement("button");
          announceButton.type = "button";
          announceButton.textContent = "선로사용권 공모";
          announceButton.addEventListener("click", () => run(() => {
            const capacity = Math.min(40, Math.max(Math.ceil(service.trainsPerHour + 2), Math.ceil(service.trainsPerHour * 1.5)));
            const spare = Math.max(1, Math.floor(capacity - service.trainsPerHour));
            const opportunity = runtime.announceTrackAccessOpportunity(service.id, {
              name: `${service.name ?? service.id} 선로사용권`,
              hostCapacityTrainsPerHour: capacity,
              minimumGuestTrainsPerHour: 1,
              maximumGuestTrainsPerHour: Math.min(4, spare),
            });
            message(`${opportunity.name} 공모를 발표했습니다.`);
            return opportunity;
          }));
          accessBox.append(accessSummary, announceButton);
        } else if (currentOpportunity.status === "announced") {
          accessSummary.textContent = `선로사용권 공모 중 · 공급 가능 ${currentOpportunity.minimumGuestTrainsPerHour}~${currentOpportunity.maximumGuestTrainsPerHour}회/시`;
          const solicitButton = document.createElement("button");
          solicitButton.type = "button";
          solicitButton.textContent = "경쟁사 제안 받기";
          solicitButton.addEventListener("click", () => run(() => {
            const offers = runtime.solicitTrackAccessOffers(currentOpportunity.id);
            message(offers.length ? `${offers.length}개 경쟁사 제안을 받았습니다.` : "참여한 경쟁사가 없습니다. 새 조건으로 다시 공모할 수 있습니다.", !offers.length);
            return offers;
          }));
          accessBox.append(accessSummary, solicitButton);
        } else {
          accessSummary.textContent = `경쟁사 제안 ${currentOpportunity.ranking.length}건 · 기술점수와 사용료 수입을 함께 비교하세요.`;
          accessBox.append(accessSummary);
          for (const offer of currentOpportunity.ranking) {
            const offerRow = document.createElement("div");
            offerRow.className = "operations-track-access-offer";
            const details = document.createElement("span");
            details.textContent = `${offer.bidderName} · ${offer.trainsPerHour}회/시 · 기술 ${offer.technicalScore.toFixed(1)} · 연 ${yen.format(offer.projectedAnnualHostRevenueJPY)}`;
            const awardButton = document.createElement("button");
            awardButton.type = "button";
            awardButton.textContent = "낙찰";
            awardButton.addEventListener("click", () => run(() => {
              const agreement = runtime.awardTrackAccessOffer(currentOpportunity.id, offer.id);
              message(`${agreement.guestOperatorName}에 선로사용권을 낙찰했습니다.`);
              return agreement;
            }));
            offerRow.append(details, awardButton);
            accessBox.append(offerRow);
          }
        }
        card.append(accessBox);
        if (reports.length) {
          const table = document.createElement("table");
          table.className = "operations-economy-history";
          const header = document.createElement("tr");
          for (const label of ["월", "정시율", "고장", "영업손익", "금융비", "갱신", "순현금"]) {
            const th = document.createElement("th");
            th.textContent = label;
            header.append(th);
          }
          const thead = document.createElement("thead");
          thead.append(header);
          const tbody = document.createElement("tbody");
          for (const report of reports.slice(0, 6)) {
            const row = document.createElement("tr");
            const punctuality = report.reliability?.averagePunctuality;
            for (const value of [`${report.month}`, punctuality === null || punctuality === undefined ? "-" : `${(punctuality * 100).toFixed(1)}%`, `${report.reliability?.failures ?? 0}`, yen.format(report.operatingProfitJPY), yen.format(report.financeCostJPY), yen.format(report.capitalCostJPY ?? 0), yen.format(report.netCashJPY)]) {
              const td = document.createElement("td");
              td.textContent = value;
              row.append(td);
            }
            tbody.append(row);
          }
          table.append(thead, tbody);
          card.append(table);
        }
        container.append(card);
      }
    };

    const renderConstructionCycle = (plan, project) => {
      const container = $("scenario-construction-cycle");
      container.replaceChildren();
      if (!project) {
        const empty = document.createElement("div");
        empty.className = "construction-cycle-empty";
        empty.textContent = plan ? "아직 이 계획의 건설 사업이 만들어지지 않았습니다." : "계획선을 선택하세요.";
        container.append(empty);
        return;
      }
      const reports = runtime.constructionCycleReport()
        .filter((report) => report.projects.some((entry) => entry.projectId === project.id)
          || report.schedules.some((entry) => entry.projectId === project.id))
        .sort((a, b) => b.atMinute - a.atMinute);
      if (!reports.length) {
        const empty = document.createElement("div");
        empty.className = "construction-cycle-empty";
        empty.textContent = "월을 진행하면 공정·기성금·지연을 한 장부에서 추적합니다.";
        container.append(empty);
        return;
      }

      const latest = reports[0];
      const projectCycle = latest.projects.find((entry) => entry.projectId === project.id) ?? null;
      const schedule = latest.schedules.find((entry) => entry.projectId === project.id) ?? null;
      const reasonLabels = {
        "construction-package-procurement": "공구별 입찰·낙찰 미완료",
        "equipment-workfront-infeasible": "중장비 반입 작업면 부적합",
        "integrated-schedule": "통합 공정의 임계 지연 또는 시험 선행조건 미충족",
        "construction-funding-gap": "물가조정분을 반영할 가용 예산 부족",
        suspended: "사업자 결정으로 공사 일시중단",
      };
      const card = document.createElement("article");
      card.className = "construction-cycle-latest";
      const head = document.createElement("div");
      head.className = "construction-cycle-head";
      const title = document.createElement("b");
      title.textContent = `${latest.month}개월차 통합 정산`;
      const stateLabel = document.createElement("span");
      stateLabel.textContent = projectCycle ? `${projectCycle.status ?? project.status} · ${Math.round((projectCycle.progress ?? project.progress) * 100)}%` : project.status;
      head.append(title, stateLabel);
      card.append(head);

      const metrics = document.createElement("div");
      metrics.className = "construction-cycle-metrics";
      const values = [
        ["당월 공사 기성금", yen.format(projectCycle?.paymentJPY ?? 0)],
        ["전체 차량·기지 지급", yen.format(latest.payments.vehiclesJPY + latest.payments.depotsJPY)],
        ["당월 현금 증감", yen.format(latest.cashChangeJPY)],
        ["누적 개통 지연", schedule ? `${schedule.delayMonths}개월` : "공정표 미연결"],
        ["공사비 지수", latest.constructionPrice ? `${latest.constructionPrice.currentIndex.toFixed(3)} (2026=100)` : "-"],
        ["기준 개통월", schedule ? `${schedule.baselineOpeningMonth}개월차` : "-"],
        ["예상 개통월", schedule ? `${schedule.forecastOpeningMonth}개월차` : "-"],
      ];
      for (const [label, value] of values) {
        const cell = document.createElement("div");
        const name = document.createElement("span");
        const amount = document.createElement("b");
        name.textContent = label;
        amount.textContent = value;
        cell.append(name, amount);
        metrics.append(cell);
      }
      card.append(metrics);

      if (projectCycle?.blocked) {
        const blocker = document.createElement("div");
        blocker.className = "construction-cycle-blocker";
        const gateDetails = (projectCycle.gateReasons ?? []).map((entry) => {
          if (entry.code === "critical-task-delay") return `임계 작업 ${entry.taskId} · ${entry.releaseMonth}개월차까지 제한`;
          if (entry.code === "testing-dependencies") return `종합시험 선행작업 ${entry.dependencyTaskIds.length}개 미완료`;
          return entry.code;
        });
        blocker.textContent = `진행 정지: ${reasonLabels[projectCycle.reason] ?? projectCycle.reason ?? "원인 미상"}${gateDetails.length ? ` · ${gateDetails.join(" · ")}` : ""}`;
        card.append(blocker);
      } else {
        const ok = document.createElement("div");
        ok.className = "construction-cycle-ok";
        ok.textContent = `이번 달 공정 +${Math.round((projectCycle?.progressDelta ?? 0) * 1000) / 10}%p · 신규 사건 ${latest.generatedEventIds.length}건`;
        card.append(ok);
      }
      container.append(card);

      const fundingCase = runtime.game.constructionFundingReport(project.id)
        .find((entry) => ["open", "suspended"].includes(entry.status));
      if (fundingCase) {
        const funding = document.createElement("article");
        funding.className = "construction-funding-case";
        const fundingTitle = document.createElement("b");
        fundingTitle.textContent = `공사비 부족 ${yen.format(fundingCase.fundingGapJPY)}`;
        const fundingMeta = document.createElement("p");
        fundingMeta.textContent = `지수 ${fundingCase.priceIndex.toFixed(3)} · 발주자 조정액 ${yen.format(fundingCase.ownerAdjustmentJPY)} · 현재 가용현금 ${yen.format(fundingCase.availableCashJPY)}`;
        const choices = document.createElement("div");
        choices.className = "construction-funding-options";
        for (const option of runtime.constructionFundingOptions(fundingCase.id)) {
          const button = document.createElement("button");
          button.type = "button";
          button.textContent = option.label;
          const detail = document.createElement("small");
          detail.textContent = option.id === "suspend"
            ? "지급과 공정을 멈추고 나중에 재원 대책을 선택"
            : `조달 ${yen.format(option.fundingJPY)}${option.delayMonths ? ` · ${option.delayMonths}개월 지연` : ""}${option.futureMonthlyCostJPY ? ` · 향후 월 부담 ${yen.format(option.futureMonthlyCostJPY)}` : ""}`;
          button.append(detail);
          button.addEventListener("click", () => run(() => {
            const result = runtime.resolveConstructionFundingCase(fundingCase.id, option.id);
            message(option.id === "suspend"
              ? `공사비 부족으로 사업을 중단했습니다. 재원 대책을 선택하면 재개할 수 있습니다.`
              : `${option.label}으로 ${yen.format(result.option.fundingJPY ?? 0)}을 조달하고 물가조정분을 계약과 총사업비에 반영했습니다.`);
            return result;
          }));
          choices.append(button);
        }
        funding.append(fundingTitle, fundingMeta, choices);
        container.append(funding);
      }
      const financing = runtime.game.constructionFinanceReport(project.id);
      if (financing.length) {
        const financeBox = document.createElement("div");
        financeBox.className = "construction-finance-summary";
        const debt = financing.filter((entry) => entry.kind === "construction-loan").reduce((sum, entry) => sum + entry.balanceJPY, 0);
        const monthly = financing.reduce((sum, entry) => sum + entry.futureMonthlyCostJPY, 0);
        const publicFunding = financing.filter((entry) => entry.kind === "supplementary-budget").reduce((sum, entry) => sum + entry.netConstructionFundingJPY, 0);
        const equity = financing.filter((entry) => entry.kind === "sponsor-equity").reduce((sum, entry) => sum + entry.netConstructionFundingJPY, 0);
        financeBox.textContent = `확정 재원 · 추가예산 ${yen.format(publicFunding)} · 추가출자 ${yen.format(equity)} · 건설대출 잔액 ${yen.format(debt)} · 향후 월 부담 ${yen.format(monthly)}`;
        container.append(financeBox);
      }

      const table = document.createElement("table");
      table.className = "construction-cycle-history";
      const header = document.createElement("tr");
      for (const label of ["월", "공정", "공사비", "지연"]) {
        const cell = document.createElement("th");
        cell.textContent = label;
        header.append(cell);
      }
      const thead = document.createElement("thead");
      thead.append(header);
      const tbody = document.createElement("tbody");
      for (const report of reports.slice(0, 6)) {
        const entry = report.projects.find((item) => item.projectId === project.id);
        const reportSchedule = report.schedules.find((item) => item.projectId === project.id);
        const row = document.createElement("tr");
        for (const value of [
          `${report.month}`,
          entry ? `${Math.round(entry.progress * 100)}%` : "-",
          entry ? yen.format(entry.paymentJPY) : "-",
          reportSchedule ? `${reportSchedule.delayMonths}개월` : "-",
        ]) {
          const cell = document.createElement("td");
          cell.textContent = value;
          row.append(cell);
        }
        tbody.append(row);
      }
      table.append(thead, tbody);
      container.append(table);
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
      renderConstructionCycle(plan, project);
      renderOperatingEconomy();
      renderConstructionEvents(plan, project);
      stationManagement?.refresh();
      constructionContractorManagement?.refresh();
      throughServiceManagement?.refresh();
      railReplacementManagement?.refresh();
      railwayDetourManagement?.refresh();
      railCapacityApplicationManagement?.refresh();
      railwayDisruptionManagement?.refresh();
      railwayServiceControlManagement?.refresh();
      stationDemandAllocationManagement?.refresh();
      servicePlanManagement?.refresh();
      railwayTimetableLifecycle?.refresh();
    };

    stationManagement = mountStationManagementPanel({
      container: $("scenario-station-management"),
      runtime,
      getPlanId: () => selectedPlan()?.planId ?? null,
      getSelectedSite: () => stationUi?.stationExport?.sites.find((site) => site.stationSiteId === stationSelectionOutput?.stationSiteId) ?? stationUi?.selectedSite ?? null,
      getSelection: () => stationSelectionOutput,
      onChange: () => queueMicrotask(() => { refreshMapOverlay(); refreshScenarioPanel(); }),
    });
    stationDemandAllocationManagement = mountStationDemandAllocationManagementPanel({
      container: $("scenario-station-demand-allocation"),
      runtime,
      onChange: () => queueMicrotask(() => { refreshMapOverlay(); refreshScenarioPanel(); }),
    });
    const servicePlanPrescreenContext = () => {
      const technicalSpecs = {};
      for (const service of runtime.game.services) {
        const line = state.lines.find((entry) => String(entry.managementServiceId) === String(service.id));
        const project = runtime.game.projects.find((entry) => entry.id === service.projectId);
        // A known project profile is a real technical fact. Capacity is not
        // derived here: absent evidence must remain unknown for E1/B13.
        if (line && project?.technicalProfileId) technicalSpecs[String(line.id)] = { technicalProfileId: project.technicalProfileId };
      }
      const assumptionOutput = servicePlanAssumptions?.output();
      // Conflicting player statements deliberately hide this line's facts. A
      // project-profile fallback would otherwise turn that explicit conflict
      // into a silently usable technical specification.
      for (const conflict of assumptionOutput?.technicalConflicts ?? []) delete technicalSpecs[String(conflict.operationalLineId)];
      Object.assign(technicalSpecs, assumptionOutput?.technicalSpecs ?? {});
      return { technicalSpecs };
    };
    const servicePlanAssessmentInput = (plan) => {
      const assumptions = servicePlanAssumptions?.assessInput(plan?.servicePlanId);
      if (!assumptions) throw new Error("운행 전제가 없거나 지도 계획 revision과 맞지 않습니다. 운행 전제 패널에서 값을 적고 확인하세요.");
      return { ...servicePlanPrescreenContext(), ...assumptions };
    };
    const servicePlanBatchAssessmentInput = (entries) => {
      const inputs = entries.map(({ servicePlan }) => {
        const assumptions = servicePlanAssumptions?.assessInput(servicePlan?.servicePlanId);
        if (!assumptions) throw new Error(`운행계획 ${servicePlan?.servicePlanId ?? "(미상)"}의 전제가 없거나 낡았습니다.`);
        return assumptions;
      });
      const pickOne = (field) => {
        const values = inputs.map((input) => input[field]).filter((value) => value !== undefined);
        const unique = [...new Set(values.map((value) => JSON.stringify(value)))];
        if (unique.length > 1) throw new Error(`같은 시간표 묶음의 ${field} 전제가 서로 다릅니다. 같은 용량 지도 revision의 계획은 하나의 값을 명시해야 합니다.`);
        return values[0];
      };
      const infrastructureAssumptions = {};
      for (const field of ["directionMode", "minimumHeadwayMinutes"]) {
        const values = inputs.map((input) => input.infrastructureAssumptions?.[field]).filter((value) => value !== undefined);
        const unique = [...new Set(values.map((value) => JSON.stringify(value)))];
        if (unique.length > 1) throw new Error(`같은 시간표 묶음의 ${field} 전제가 서로 다릅니다. 같은 용량 지도 revision의 계획은 하나의 값을 명시해야 합니다.`);
        const value = values[0];
        if (value !== undefined) infrastructureAssumptions[field] = value;
      }
      const closureWindowsBySectionId = {};
      for (const input of inputs) for (const [sectionId, windows] of Object.entries(input.closureWindowsBySectionId ?? {})) {
        if (sectionId in closureWindowsBySectionId && JSON.stringify(closureWindowsBySectionId[sectionId]) !== JSON.stringify(windows)) {
          throw new Error(`구간 ${sectionId}의 폐쇄 시간창 전제가 서로 다릅니다.`);
        }
        closureWindowsBySectionId[sectionId] = structuredClone(windows);
      }
      const output = { ...servicePlanPrescreenContext() };
      if (Object.keys(infrastructureAssumptions).length) output.infrastructureAssumptions = infrastructureAssumptions;
      if (Object.keys(closureWindowsBySectionId).length) output.closureWindowsBySectionId = closureWindowsBySectionId;
      for (const field of ["dayType", "minimumAcceptanceRatio"]) {
        const value = pickOne(field);
        if (value !== undefined) output[field] = value;
      }
      return output;
    };
    servicePlanManagement = mountServicePlanManagementPanel({
      container: $("scenario-service-plans"),
      runtime,
      getServicePlans: () => servicePlanEditor?.output().export?.plans ?? [],
      getPrescreenContext: servicePlanPrescreenContext,
      onChange: () => queueMicrotask(() => refreshScenarioPanel()),
    });
    railwayTimetableLifecycle = mountRailwayTimetableLifecyclePanel({
      container: $("scenario-timetable-lifecycle"),
      runtime,
      getServicePlans: () => servicePlanEditor?.output().export?.plans ?? [],
      getBindings: () => servicePlanManagement?.document ?? { bindings: [] },
      getAssessmentInput: (plan) => servicePlanAssessmentInput(plan),
      assessmentEnabled: false,
      onChange: () => queueMicrotask(() => refreshScenarioPanel()),
    });
    constructionContractorManagement = mountConstructionContractorPanel({
      container: $("scenario-construction-contractors"),
      runtime,
      getPlanId: () => selectedPlan()?.planId ?? null,
      onChange: () => queueMicrotask(() => { refreshMapOverlay(); refreshScenarioPanel(); }),
    });
    throughServiceManagement = mountThroughServiceManagementPanel({
      container: $("scenario-through-services"),
      runtime,
      getMapExport: () => currentMapExport,
      // Only a saved route whose every source has a commissioned operational line and whose handovers are
      // physically confirmed can become a simulator line. Unknown external topology stays blocked.
      getOperationDraft: (service) => runtime.throughOperationDraft(service.throughServiceId, currentMapExport),
      getSelectedHandoverSite: () => throughHandoverUi?.selectedSite ?? null,
      onChange: () => queueMicrotask(() => { refreshMapOverlay(); refreshScenarioPanel(); }),
    });
    railReplacementManagement = mountRailReplacementManagementPanel({
      container: $("scenario-rail-replacement"),
      runtime,
      getReplacementGeometries: () => railReplacementGeometries,
      onChange: () => queueMicrotask(() => { refreshMapOverlay(); refreshScenarioPanel(); }),
    });
    railCapacityApplicationManagement = mountRailCapacityApplicationPanel({
      container: $("scenario-rail-capacity-application"),
      runtime,
      getRailGeometries: () => mapInputPipeline?.output().railGeometries ?? [],
      onChange: () => queueMicrotask(() => { refreshMapOverlay(); refreshScenarioPanel(); }),
    });
    railwayDisruptionManagement = mountRailwayDisruptionManagementPanel({
      container: $("scenario-railway-disruptions"),
      runtime,
      onChange: () => queueMicrotask(() => { refreshMapOverlay(); refreshScenarioPanel(); }),
    });
    railwayServiceControlManagement = mountRailwayServiceControlManagementPanel({
      container: $("scenario-railway-service-control"),
      runtime,
      // Unlike the pipeline summary, the M7 stage also preserves the player's candidate selections.
      getServiceControlOutput: () => mapInputPipeline?.stages.serviceControl.output() ?? { controls: [], selections: {} },
      onChange: () => queueMicrotask(() => { refreshMapOverlay(); refreshScenarioPanel(); }),
    });
    railwayDetourManagement = mountRailwayDetourManagementPanel({
      container: $("scenario-railway-detour"),
      runtime,
      // The pipeline's top-level output intentionally stores only the M10 export. M11 also
      // needs the player picks, which are preserved by the M10 stage itself.
      getDetourOutput: () => mapInputPipeline?.stages.detour.output() ?? { export: { detours: [] }, picks: {} },
      getExternalInfrastructureCatalog: externalCatalogForDetour,
      getTrackAccessAgreements: () => runtime.game.trackAccessAgreements,
      onChange: () => queueMicrotask(() => { refreshMapOverlay(); refreshScenarioPanel(); }),
    });
    canvas.addEventListener("pointerup", () => queueMicrotask(() => {
      stationManagement?.refresh();
      throughServiceManagement?.refresh();
      railwayDetourManagement?.refresh();
      railCapacityApplicationManagement?.refresh();
      railwayDisruptionManagement?.refresh();
      railwayServiceControlManagement?.refresh();
      stationDemandAllocationManagement?.refresh();
      servicePlanManagement?.refresh();
      railwayTimetableLifecycle?.refresh();
    }), true);

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
    $("scenario-station-demand-access-apply").addEventListener("click", () => run(() => {
      const output = stationDemandAccessUi?.output() ?? stationDemandAccessOutput;
      const access = output?.export;
      if (!access?.sites?.length) throw new Error("지도에서 적용할 역 접근권을 먼저 그리세요.");
      const application = runtime.applyStationDemandAccess(access);
      message(`역 접근권 공간 사실 ${application.assessment.sites.length}개를 엔진에 적용했습니다. 수요 배분 규칙은 아직 적용하지 않아 승객 수는 바뀌지 않습니다.`);
      return application;
    }));
    $("scenario-month").addEventListener("click", () => run(() => {
      const result = runtime.advanceMonths(1)[0];
      const cycle = result.cycleReport;
      const currentProject = runtime.projectForPlan(selectedPlan()?.planId);
      const current = cycle?.projects.find((entry) => entry.projectId === currentProject?.id);
      const blocked = current?.blocked ? ` · 진행 정지 ${current.reason}` : "";
      message(`1개월 진행 · 지급 ${yen.format(cycle?.payments.knownTotalJPY ?? 0)} · 현금 증감 ${yen.format(cycle?.cashChangeJPY ?? 0)} · 신규 사건 ${result.generatedEvents?.length ?? 0}건${blocked}`);
      return result;
    }));
    $("scenario-year").addEventListener("click", () => run(() => {
      const results = runtime.advanceMonths(12);
      const generated = results.reduce((sum, result) => sum + (result.generatedEvents?.length ?? 0), 0);
      const resolved = results.reduce((sum, result) => sum + (result.autoResolvedEvents?.length ?? 0), 0);
      const paid = results.reduce((sum, result) => sum + (result.cycleReport?.payments.knownTotalJPY ?? 0), 0);
      const cashChange = results.reduce((sum, result) => sum + (result.cycleReport?.cashChangeJPY ?? 0), 0);
      message(`12개월 진행 · 지급 ${yen.format(paid)} · 현금 증감 ${yen.format(cashChange)} · 신규 사건 ${generated}건 · 자동 대응 ${resolved}건.`);
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
    $("scenario-service-plan-assess").addEventListener("click", () => run(() => {
      const ready = servicePlanManagement?.readyPlans() ?? [];
      if (!ready.length) throw new Error("시간표 심사 준비가 끝난 운행계획이 없습니다. 서비스 연결, 기술사양·차량·선로 사실, 지도 및 용량 application 상태를 확인하세요.");
      const plans = servicePlanEditor?.output().export?.plans ?? [];
      try {
        const assessed = ready.map(({ servicePlanId, serviceId }) => {
          const plan = plans.find((entry) => entry.servicePlanId === servicePlanId);
          const result = { timetable: plan ? { servicePlan: plan, binding: { servicePlanId, serviceId } } : null };
          if (!result.timetable) throw new Error(`운행계획 ${servicePlanId}은(는) 다시 확인이 필요합니다.`);
          return result.timetable;
        });
        const result = runtime.assessServicePlanTimetableBatch(assessed, servicePlanBatchAssessmentInput(assessed));
        if (!railwayTimetableLifecycle?.recordBatchAssessment({ entries: assessed, result })) throw new Error("시간표 심사 기록을 화면에 연결하지 못했습니다.");
        $("scenario-service-plan-result").textContent = `${assessed.length}개 운행계획을 B13 시간표 심사에 제출했습니다. 승인과 활성화는 다음 단계에서 별도로 진행합니다.`;
      } catch (error) {
        throw error;
      }
    }));
    $("scenario-save").addEventListener("click", () => run(() => {
      const payload = JSON.stringify({
        schemaVersion: 1,
        runtime: runtime.save(),
        workfrontDoc: constructionWorkfront?.workfrontDoc ?? null,
        // M8 geometry is player-authored map state. Preserve its exact revision so an operating
        // order cannot silently attach to a freshly recalculated, different road route on load.
        railReplacementGeometries,
        mapInputPipelineDoc: mapInputPipeline?.serialize() ?? null,
        stationDemandAccessDoc: stationDemandAccessUi?.serialize() ?? null,
        stationDemandAllocationDraft: stationDemandAllocationManagement?.serialize() ?? null,
        servicePlanDoc: servicePlanEditor?.serialize() ?? null,
        servicePlanAssumptionsDoc: servicePlanAssumptions?.serialize() ?? null,
        servicePlanBindingDoc: servicePlanManagement?.serialize() ?? null,
        railwayTimetableLifecycleDoc: railwayTimetableLifecycle?.serialize() ?? null,
      });
      localStorage.setItem(storageKey, payload);
      message("지도·공사·차량·회사 상태와 작업면·대체수송 계획을 함께 저장했습니다.");
    }));
    $("scenario-load").addEventListener("click", () => run(() => {
      const saved = localStorage.getItem(storageKey);
      if (!saved) throw new Error("불러올 통합 저장본이 없습니다.");
      let payload = null;
      try { payload = JSON.parse(saved); } catch { /* not JSON at all: definitely the old plain runtime.save() string */ }
      const wrapped = payload && typeof payload === "object" && typeof payload.runtime === "string";
      runtime.load(wrapped ? payload.runtime : saved); // older saves stored runtime.save()'s own JSON string directly
      if (wrapped && payload.workfrontDoc) constructionWorkfront?.loadDoc(payload.workfrontDoc);
      railReplacementGeometries = wrapped && Array.isArray(payload.railReplacementGeometries)
        ? structuredClone(payload.railReplacementGeometries)
        : [];
      if (wrapped && payload.mapInputPipelineDoc) mapInputPipeline?.loadDoc(payload.mapInputPipelineDoc);
      else mapInputPipeline?.refresh();
      if (wrapped && payload.stationDemandAccessDoc) {
        stationDemandAccessUi?.loadDoc(payload.stationDemandAccessDoc);
        stationDemandAccessOutput = stationDemandAccessUi?.output() ?? null;
      }
      if (wrapped && payload.stationDemandAllocationDraft) stationDemandAllocationManagement?.loadDoc(payload.stationDemandAllocationDraft);
      if (wrapped && payload.servicePlanDoc) servicePlanEditor?.loadDoc(payload.servicePlanDoc);
      else servicePlanEditor?.refresh();
      if (wrapped && payload.servicePlanAssumptionsDoc) servicePlanAssumptions?.loadDoc(payload.servicePlanAssumptionsDoc);
      else servicePlanAssumptions?.refresh();
      if (wrapped && payload.servicePlanBindingDoc) servicePlanManagement?.loadDoc(payload.servicePlanBindingDoc);
      else servicePlanManagement?.refresh();
      if (wrapped && payload.railwayTimetableLifecycleDoc) railwayTimetableLifecycle?.loadDoc(payload.railwayTimetableLifecycleDoc);
      else railwayTimetableLifecycle?.refresh();
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
      railwayDisruptionManagement?.refresh();
      railwayServiceControlManagement?.refresh();
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
