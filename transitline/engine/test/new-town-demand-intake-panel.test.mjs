import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { ScenarioRuntime } from "../src/scenario-runtime.mjs";
import { createState } from "../src/state.mjs";
import { NEW_TOWN_DEMAND_INTAKE_PANEL_DOC_SCHEMA, mountNewTownDemandIntakePanel, newTownDemandIntakePanelDocument, restoreNewTownDemandIntakePanelDocument } from "../src/new-town-demand-intake-panel.mjs";

class Node_ { constructor(tag) { Object.assign(this, { tag, children: [], className: "", textContent: "", value: "", checked: false, disabled: false, listeners: {} }); } append(...kids) { this.children.push(...kids); } replaceChildren(...kids) { this.children = []; this.append(...kids); } addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); } fire(type) { for (const fn of this.listeners[type] ?? []) fn({ type }); } }
const dom = { createElement: (tag) => new Node_(tag) };
const container = () => Object.assign(new Node_("div"), { ownerDocument: dom });
const all = (node, predicate = () => true) => [predicate(node) ? node : null, ...node.children.flatMap((child) => all(child, predicate))].filter(Boolean);
const byClass = (node, name) => all(node, (entry) => String(entry.className).split(" ").includes(name));
const click = (node) => node.fire("click");
const read = (rel) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const geometry = JSON.parse(read("../../packs/example-radial/new-town-development-examples/01-two-phases-with-synthetic-pond-and-road.new-town.json"));
const pack = { manifest: { id: "example-radial", version: "0.1.0", data: { license: "CC0-1.0", attribution: [] } }, demand: { model: "gravity", points: [], attractors: [] } };
const COMMANDS = new Set(["acceptNewTownDemandCandidate", "holdNewTownDemandCandidate", "rejectNewTownDemandCandidate", "revokeNewTownDemandCandidate", "applyNewTownExplicitDemandSource", "withdrawNewTownExplicitDemandSource"]);

function world() {
  const real = new ScenarioRuntime({ pack, operationalState: createState(pack) });
  const development = real.proposeNewTownDevelopment({ geometry, parties: { municipality: { name: "Example City" }, developer: { name: "Example Dev" } } });
  real.agreeNewTownDevelopment(development.id, { burdens: [{ itemId: "land", bearers: ["developer"] }] }, { geometry });
  real.startNewTownServicing(development.id, { geometry, phaseIds: [geometry.phases[0].phaseId] });
  real.recordNewTownOccupancy(development.id, geometry.phases[0].phaseId, { statedOccupiedUnits: 0, unit: "residents", source: "player-stated" }, { geometry });
  const calls = { commands: [], reads: [] };
  const runtime = new Proxy(real, { get(target, prop) { const value = target[prop]; if (typeof value !== "function") return value; return (...args) => { (COMMANDS.has(prop) ? calls.commands : calls.reads).push(prop); return value.apply(target, args); }; } });
  const root = container(); const changes = [];
  const panel = mountNewTownDemandIntakePanel({ container: root, runtime, getGeometryExport: () => ({ schema: "transitline.new-town-development-export/1", packId: "example-radial", packVersion: "0.1.0", developments: [geometry] }), onChange: (event) => changes.push(event) });
  return { real, runtime, calls, root, panel, changes, development };
}

test("mount, refresh, selection, and document operations only read runtime facts", () => {
  const w = world(); const before = JSON.stringify(w.real.game.snapshot());
  const key = w.panel.output().view.candidates[0].key;
  w.panel.refresh(); w.panel.select(key); const saved = w.panel.serialize(); w.panel.loadDoc(saved);
  assert.deepEqual(w.calls.commands, []);
  assert.equal(JSON.stringify(w.real.game.snapshot()), before);
  assert.ok(w.calls.reads.length > 0);
  assert.deepEqual(w.changes, []);
  const out = w.panel.output(); out.view.candidates[0].candidate.currentStatus = "changed";
  assert.notEqual(w.panel.output().view.candidates[0].candidate.currentStatus, "changed");
});

test("only an explicit selected fact can be accepted, then copied as an explicit source and withdrawn without changing B15 state", () => {
  const w = world(); const item = w.panel.output().view.candidates[0]; w.panel.select(item.key);
  const beforeLinks = structuredClone(w.real.operationalState.accessLinks);
  click(byClass(w.root, "ntdi-accept")[0]);
  assert.equal(w.real.newTownDemandIntakeReport().length, 0, "no fact selection means no acceptance");
  assert.ok(byClass(w.root, "ntdi-error").some((node) => node.textContent.includes("stated-demand-fact-ids-not-chosen")));
  const choice = byClass(w.root, "ntdi-fact-choice")[0]; choice.checked = true; choice.fire("change");
  click(byClass(w.root, "ntdi-accept")[0]);
  const intake = w.real.newTownDemandIntakeReport(null, { geometry })[0];
  assert.equal(intake.status, "accepted");
  assert.deepEqual(intake.acceptance.statedDemandFacts.map((fact) => [fact.kind, fact.quantity]), [["residents", 0]], "a stated zero is copied exactly");
  assert.deepEqual(w.real.operationalState.accessLinks, beforeLinks);
  click(byClass(w.root, "ntdi-apply-source")[0]);
  const source = w.real.newTownExplicitDemandSourceReport({ geometry })[0];
  assert.equal(source.status, "applied");
  assert.deepEqual(w.real.operationalState.accessLinks, beforeLinks, "source application did not make a B15 link");
  const withdrawal = byClass(w.root, "ntdi-withdrawal-input")[0]; withdrawal.value = "player withdrew statement"; withdrawal.fire("input");
  click(byClass(w.root, "ntdi-withdraw-source")[0]);
  assert.equal(w.real.newTownExplicitDemandSourceReport({ geometry })[0].status, "withdrawn");
  assert.deepEqual(w.calls.commands, ["acceptNewTownDemandCandidate", "applyNewTownExplicitDemandSource", "withdrawNewTownExplicitDemandSource"]);
  assert.deepEqual(w.changes.map((event) => event.action), ["accept", "apply-source", "withdraw-source"]);
});

test("saved unsent choices reject another pack and do not alter the current choice", () => {
  const document = newTownDemandIntakePanelDocument({ packId: "example-radial", packVersion: "0.1.0", selectedCandidateKey: "r|c", forms: { "r|c": { factIds: ["a"], note: "n", decisionReason: "d", withdrawalReason: "w" } } });
  assert.equal(document.schema, NEW_TOWN_DEMAND_INTAKE_PANEL_DOC_SCHEMA);
  const current = { selectedCandidateKey: "keep", forms: {} };
  const other = restoreNewTownDemandIntakePanelDocument({ ...document, packId: "tokyo" }, { packId: "example-radial", packVersion: "0.1.0", current });
  assert.equal(other.rejected, true); assert.deepEqual(other.document, current);
});

test("the panel has no hidden B15 write path, storage, clock, RNG, or economic calculation", () => {
  const source = read("../src/new-town-demand-intake-panel.mjs");
  for (const token of ["localStorage", "sessionStorage", "Math.random", "Date.now", "applyStationDemandAllocation", "stationDemandAllocationLinks", "accessLinks", "ledger"]) assert.equal(source.includes(token), false, token);
  const runtimeCalls = [...source.matchAll(/runtime\.([A-Za-z0-9_]+)/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(runtimeCalls)].sort(), [...COMMANDS, "newTownDevelopmentReport", "assessNewTownDemandIntake", "newTownDemandIntakeReport", "assessNewTownExplicitDemandSources", "newTownExplicitDemandSourceReport"].sort());
});
