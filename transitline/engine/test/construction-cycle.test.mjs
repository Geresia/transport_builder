import test from "node:test";
import assert from "node:assert/strict";
import {
  advanceConstructionMonth,
  createConstructionCycleReport,
  getCountryProfile,
  integratedConstructionProgressGate,
  Ledger,
  ManagementGame,
  makeRng,
  SimulationClock,
} from "../src/management/index.mjs";

function geometry(id = "cycle") {
  return {
    contractVersion: 1,
    schema: "transitline.plan-geometry/1",
    planId: id,
    coordinateReference: "EPSG:4326",
    sourcePackId: "synthetic",
    sourcePackVersion: "1",
    stationCandidates: [
      { id: "a", location: [139, 35], platformType: "side", platformLengthM: 100, structure: "surface" },
      { id: "b", location: [139.01, 35], platformType: "side", platformLengthM: 100, structure: "surface" },
    ],
    segments: [{ id: "ab", from: "a", to: "b", lengthMeters: 1_000, structureHint: "surface", constraintFlags: [], dataQuality: "high" }],
    accessLinks: [],
  };
}

function weightedProject(progress = 0) {
  return {
    id: "project:cycle",
    progress,
    tasks: [
      { id: "design", weight: 0.12 },
      { id: "civil", weight: 0.58 },
      { id: "systems", weight: 0.2 },
      { id: "testing", weight: 0.1 },
    ],
  };
}

test("a critical civil delay caps the physical project at the civil phase boundary", () => {
  const project = weightedProject(0.6);
  const schedule = {
    projectId: project.id,
    currentMonth: 8,
    tasks: [
      { id: "civil:1", kind: "segment-civil", critical: true, status: "delayed", notBeforeFinishMonth: 11, source: { type: "project-phase", phaseId: "civil" }, dependencies: [] },
      { id: "testing:1", kind: "integrated-testing", status: "pending", source: { type: "project-phase", phaseId: "testing" }, dependencies: [] },
    ],
  };
  const gate = integratedConstructionProgressGate(schedule, project);
  assert.equal(gate.cap, 0.699999);
  assert.equal(gate.reasons[0].code, "critical-task-delay");
});

test("integrated testing cannot start before vehicle, depot and infrastructure dependencies finish", () => {
  const project = weightedProject(0.89);
  const schedule = {
    projectId: project.id,
    currentMonth: 20,
    tasks: [
      { id: "systems", status: "complete", source: { type: "project-phase", phaseId: "systems" }, dependencies: [] },
      { id: "vehicle", status: "active", source: { type: "vehicle-order" }, dependencies: [] },
      { id: "testing", kind: "integrated-testing", status: "pending", source: { type: "project-phase", phaseId: "testing" }, dependencies: ["systems", "vehicle"] },
    ],
  };
  const gate = integratedConstructionProgressGate(schedule, project);
  assert.equal(gate.cap, 0.9);
  assert.equal(gate.reasons.at(-1).code, "testing-dependencies");
  schedule.tasks.find((task) => task.id === "vehicle").status = "complete";
  assert.equal(integratedConstructionProgressGate(schedule, project).cap, 1);
});

test("a schedule cap stops both physical progress and monthly progress payment", () => {
  const game = new ManagementGame({ openingCash: 100_000_000_000, seed: 11 });
  const project = game.createProject(geometry("payment-cap"), "medium_steel");
  game.contractProject(project.id);
  project.status = "underConstruction";
  project.progress = 0.699999;
  const beforePaid = project.paid;
  const beforeCash = game.ledger.cash;
  const result = advanceConstructionMonth(project, game.ledger, game.clock, makeRng(1), getCountryProfile("JP"), { randomRisk: false, progressCap: 0.699999 });
  assert.equal(result.blocked, true);
  assert.equal(result.payment, 0);
  assert.equal(project.progress, 0.699999);
  assert.equal(project.paid, beforePaid);
  assert.equal(game.ledger.cash, beforeCash);
});

test("inspection takes three actual inspection months even after a delayed build", () => {
  const project = {
    ...weightedProject(1),
    status: "inspection",
    elapsedMonths: 100,
    inspectionElapsedMonths: 0,
    estimate: { durationMonths: 40 },
    planGeometry: geometry("inspection"),
    paid: 10,
    stationDeliveryPackages: [],
  };
  const ledger = new Ledger(100);
  ledger.commit({ id: `construction:${project.id}`, atMinute: 0, amount: 10, category: "construction", reference: project.id });
  const clock = new SimulationClock(0);
  const args = [project, ledger, clock, makeRng(1), getCountryProfile("JP")];
  advanceConstructionMonth(...args);
  advanceConstructionMonth(...args);
  assert.equal(project.status, "inspection");
  advanceConstructionMonth(...args);
  assert.equal(project.status, "available");
  assert.ok(project.assets.some((asset) => asset.kind === "track-segment"));
});

test("monthly cycle report reconciles known payments and survives save/load", () => {
  const report = createConstructionCycleReport({
    atMinute: 43_200,
    cashBeforeJPY: 1_000,
    cashAfterJPY: 820,
    construction: [{ projectId: "p", status: "underConstruction", progress: 0.2, progressDelta: 0.1, payment: 100 }],
    vehicles: [{ orderId: "v", payment: 50 }],
    depots: [{ depotId: "d", payment: 30 }],
    schedules: [{ id: "s", delayMonths: 2 }],
    generatedEvents: [{ id: "e1" }],
    autoResolvedEvents: [{ eventId: "e0" }],
  });
  assert.equal(report.payments.knownTotalJPY, 180);
  assert.equal(report.cashChangeJPY, -180);
  assert.deepEqual(report.generatedEventIds, ["e1"]);

  const game = new ManagementGame({ openingCash: 100_000_000_000, seed: 7 });
  const project = game.createProject(geometry("cycle-save"), "medium_steel");
  game.contractProject(project.id);
  const month = game.advanceMonth();
  assert.equal(month.cycleReport.schema, "transitline.construction-cycle-report/1");
  assert.equal(game.constructionCycleReport(1).length, 1);
  const restored = ManagementGame.load(game.save());
  assert.deepEqual(restored.constructionCycleReport(), game.constructionCycleReport());
});
