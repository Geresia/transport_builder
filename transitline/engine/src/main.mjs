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
import { withStationAccess } from "./access-demand.mjs";
import { buildMapExport, drawnLinesFromState } from "./map/plan-geometry.mjs";
import { buildOverlayModel, renderDiagnosticsPanel } from "./map/overlay.mjs";
import { planIdForKey, planningDefaults, ScenarioRuntime, stablePlanKey } from "./scenario-runtime.mjs";

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
  const state = createState(pack);
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
  refreshMapOverlay = () => {
    currentMapExport = buildMapExport({ pack, mode: networkMode, drawnLines: drawnLinesFromState(state) });
    const report = runtime?.report() ?? engineReport ?? {};
    state.mapOverlay = scenarioPlay ? buildOverlayModel(currentMapExport, report) : null;
    renderDiagnosticsPanel($("map-diagnostics"), state.mapOverlay?.diagnostics ?? []);
  };
  window.transitlineMap = { setEngineReport(report) { engineReport = report; refreshMapOverlay(); } };
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
    const scenarioPanel = $("scenario-panel");
    const profile = $("scenario-profile");
    const structure = $("scenario-structure");
    const platform = $("scenario-platform");
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

    refreshScenarioPanel = () => {
      scenarioPanel.hidden = false;
      const line = selectedDraft();
      const plan = selectedPlan();
      const record = plan ? runtime.latestPlan(plan.planId) : null;
      const project = plan ? runtime.projectForPlan(plan.planId) : null;
      const order = project ? runtime.game.vehicleOrders.find((item) => item.id === `fleet:${project.planId.replace(/[^a-zA-Z0-9_-]/g, "-")}`) : null;
      const constructionActive = Boolean(project && ["contracted", "underConstruction", "inspection", "suspended"].includes(project.status));
      const vehicleActive = Boolean(order && order.stage !== "accepted" && order.stage !== "cancelled");
      $("scenario-country").textContent = countryId === "JP" ? `일본 · ${difficulty}` : `한국 · ${difficulty}`;
      $("scenario-cash").textContent = yen.format(runtime.game.ledger.cash);
      $("scenario-plan").textContent = line?.name ?? "없음";
      $("scenario-phase").textContent = project ? `${project.status} ${Math.round(project.progress * 100)}%` : record?.status ?? (line ? "draft" : "계획 필요");
      $("scenario-submit").disabled = !plan || ["approved", "in-project", "assets-available", "commissioned"].includes(record?.status);
      $("scenario-approve").disabled = record?.status !== "assessed";
      $("scenario-contract").disabled = !project || !["estimated", "approved"].includes(project.status);
      $("scenario-prepare").disabled = !project || !["contracted", "underConstruction", "inspection", "suspended"].includes(project.status) || Boolean(order);
      $("scenario-month").disabled = !constructionActive && !vehicleActive;
      $("scenario-year").disabled = $("scenario-month").disabled;
      $("scenario-suspend").disabled = !project || !["contracted", "underConstruction", "inspection", "suspended"].includes(project.status);
      $("scenario-suspend").textContent = project?.status === "suspended" ? "공사 재개" : "공사 중단";
      $("scenario-open").disabled = project?.status !== "available" || order?.stage !== "accepted";
      for (const control of [profile, structure, platform]) control.disabled = !line || Boolean(record && !["needs-information", "rejected"].includes(record.status));
      if (line) {
        profile.value = line.technicalProfileId ?? "medium_steel";
        structure.value = line.planningOptions?.structure ?? "elevated";
        platform.value = line.planningOptions?.platformType ?? "island";
      }
    };

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
    $("scenario-prepare").addEventListener("click", () => run(() => {
      const result = runtime.prepareFleet(selectedPlan().planId);
      message(`차량기지 ${result.depot.capacitySets}편성 규모 확보, 차량 ${result.order.quantity}편성을 발주했습니다.`);
    }));
    $("scenario-month").addEventListener("click", () => run(() => { runtime.advanceMonths(1); message("공사와 차량 제작을 1개월 진행했습니다."); }));
    $("scenario-year").addEventListener("click", () => run(() => { runtime.advanceMonths(12); message("공사와 차량 제작을 12개월 진행했습니다."); }));
    $("scenario-suspend").addEventListener("click", () => run(() => {
      const planId = selectedPlan().planId;
      if (runtime.projectForPlan(planId).status === "suspended") { runtime.resume(planId); message("중단했던 공사를 재개했습니다."); }
      else { runtime.suspend(planId, "Player decision"); message("공사를 일시 중단했습니다. 공정과 기성금 지급이 멈춥니다."); }
    }));
    $("scenario-open").addEventListener("click", () => run(() => {
      const draft = selectedDraft();
      const result = runtime.open(selectedPlan().planId, { color: draft.color });
      deleteLine(state, draft.id);
      selectedLineId = result.commissioned.lineId;
      message("통합시험과 인허가를 통과해 실제 영업 노선으로 개통했습니다.");
    }));
    $("scenario-save").addEventListener("click", () => run(() => { localStorage.setItem(storageKey, runtime.save()); message("지도·공사·차량·회사 상태를 함께 저장했습니다."); }));
    $("scenario-load").addEventListener("click", () => run(() => {
      const save = localStorage.getItem(storageKey);
      if (!save) throw new Error("불러올 통합 저장본이 없습니다.");
      runtime.load(save);
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
  startLoop(state, demandModel, projection, ctx, canvas, hud, input, (now) => {
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
