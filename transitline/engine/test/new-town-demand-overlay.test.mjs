import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  GEOMETRY_STYLE, INTAKE_STYLE, NEW_TOWN_DEMAND_VIEW_SCHEMA, buildNewTownDemandOverlayView, drawNewTownDemandOverlay, phaseCaption, rgba,
} from "../src/map/new-town-demand-overlay-view.mjs";
import { NEW_TOWN_DEMAND_OVERLAY_EVENT, SCOPE_NOTICE, STALE_NOTICE, mountNewTownDemandOverlay } from "../src/map/new-town-demand-overlay-ui.mjs";
import { buildNewTownDemandCandidates } from "../src/new-town-demand-candidates.mjs";
import { ScenarioRuntime } from "../src/scenario-runtime.mjs";
import { createState } from "../src/state.mjs";
import { browser, deepFreeze, find, layerOf, panelOf, press, texts } from "./helpers/fake-browser.mjs";

globalThis.CustomEvent ??= class { constructor(type, init) { this.type = type; this.detail = init?.detail; } };
const here = path.dirname(fileURLToPath(import.meta.url));
const P = "tl-nt-demand";
const read = (rel) => fs.readFileSync(path.join(here, rel), "utf8");
// a real B19-M1 development (drawn in the editor, built by the M1 builder)
const EXAMPLE = JSON.parse(read("../../packs/example-radial/new-town-development-examples/01-two-phases-with-synthetic-pond-and-road.new-town.json"));
const [P1, P2] = EXAMPLE.phases.map((p) => p.phaseId);
const PARTIES = { municipality: { name: "Example City" }, developer: { name: "Example Dev" } };
const PACK = { manifest: { id: "example-radial", version: "0.1.0", origin: [0.06, 0.04], data: { license: "test", attribution: [] } }, demand: { model: "gravity", points: [], attractors: [] } };
const RESIDENTS = { statedOccupiedUnits: 120, unit: "residents", source: "player-stated" };
const JOBS = { statedOccupiedUnits: 0, unit: "jobs", source: "player-stated" };
const HOUSING = { statedOccupiedUnits: 3, unit: "housing-units", source: "s" };
const projection = { toScreen: ([lon, lat]) => [(lon - 0.06) * 20000, (0.04 - lat) * 20000] };
const factId = (n, phase = P1) => `new-town-development:1:phase:${phase}:occupancy:${n}`;
const exportOf = (devs = [EXAMPLE]) => ({ schema: "transitline.new-town-development-export/1", packId: "example-radial", packVersion: "0.1.0", developments: devs, warnings: [] });
const geo = (over = {}) => ({ ...structuredClone(EXAMPLE), ...over });
const phaseOf = (view, phaseId = P1) => view.developments[0].phases.find((p) => p.phaseId === phaseId);

// the real engines, the inputs read the way the host reads them
function world({ facts = { [P1]: [RESIDENTS, JOBS] }, packId = "example-radial" } = {}) {
  const pack = { ...PACK, manifest: { ...PACK.manifest, id: packId } };
  const real = new ScenarioRuntime({ pack, operationalState: createState(pack) });
  const development = real.proposeNewTownDevelopment({ geometry: EXAMPLE, parties: PARTIES });
  real.agreeNewTownDevelopment(development.id, { burdens: [{ itemId: "land", bearers: ["developer"] }] }, { geometry: EXAMPLE });
  real.startNewTownServicing(development.id, { geometry: EXAMPLE, phaseIds: [P1, P2] });
  for (const [phaseId, list] of Object.entries(facts)) for (const fact of list) real.recordNewTownOccupancy(development.id, phaseId, fact, { geometry: EXAMPLE });
  const w = { real, development, map: exportOf(), mapOff: false };
  w.inputs = () => {
    const geometry = w.mapOff ? null : w.map;
    const developments = real.newTownDevelopmentReport();
    return {
      geometryExport: w.map, developments,
      candidates: developments.map((d) => buildNewTownDemandCandidates({ hooks: real.newTownDevelopmentHooks(d.id), geometry })),
      intakes: real.newTownDemandIntakeReport(null, { geometry }), sources: real.newTownExplicitDemandSourceReport({ geometry }),
    };
  };
  w.view = (selected = null) => buildNewTownDemandOverlayView({ ...w.inputs(), selected });
  w.accept = (ids = [factId(1)]) => real.acceptNewTownDemandCandidate({ developmentRecordId: development.id, candidateId: `new-town-demand-candidate:${EXAMPLE.developmentId}:${P1}`, statedDemandFactIds: ids, geometry: w.map });
  w.createSource = (intakeId = "new-town-demand-intake:1") => real.applyNewTownExplicitDemandSource({ intakeId, geometry: w.map });
  return w;
}
function recorder() {
  const calls = []; const state = {};
  const ctx = new Proxy(state, {
    get(t, name) { if (name in t) return t[name]; return (...args) => { if (name === "setLineDash") t.__dash = args[0]; calls.push({ op: name, args, fillStyle: t.fillStyle, strokeStyle: t.strokeStyle, lineWidth: t.lineWidth, dash: t.__dash }); }; },
    set(t, name, value) { t[name] = value; return true; },
  });
  return { ctx, calls };
}
const drawn = (view) => { const r = recorder(); drawNewTownDemandOverlay(r.ctx, view, projection.toScreen); return r.calls; };
const firstFill = (calls, nth = 0) => calls.filter((c) => c.op === "fill")[nth];
const mount = (w, extra = {}) => {
  const env = browser();
  const changes = [];
  const overlay = mountNewTownDemandOverlay({
    canvas: env.canvas, projection, pack: PACK, autoRefreshMs: 0, onChange: (out) => changes.push(out),
    getGeometryExport: () => w.inputs().geometryExport, getDevelopments: () => w.inputs().developments, getCandidates: () => w.inputs().candidates, getIntakes: () => w.inputs().intakes, getSources: () => w.inputs().sources, ...extra,
  });
  return { env, overlay, changes };
};
const panelText = (env) => texts(panelOf(env, P)).join("\n");

test("a phase with nothing stated yet: the drawn phase has lifecycle and geometry but no candidate, no decision and no source - and says why nothing was handed over", () => {
  const w = world();
  const view = w.view();
  assert.equal(view.schema, NEW_TOWN_DEMAND_VIEW_SCHEMA);
  assert.equal(view.developments.length, 1);
  const dev = view.developments[0];
  assert.deepEqual([dev.developmentId, dev.developmentRecordId, dev.lifecycleStatus, dev.active], [EXAMPLE.developmentId, w.development.id, "occupied", true]);
  const p2 = phaseOf(view, P2);
  assert.deepEqual([p2.candidate, p2.intake.state, p2.source.state, p2.source.delivered], [null, "none", "none", false]);
  assert.deepEqual(p2.notDeliveredReasons, ["no-candidate:no-occupancy-fact-stated"]);
  assert.deepEqual(p2.lifecycle, { development: "occupied", phase: "servicing" });
  assert.deepEqual([p2.geometry.status, p2.geometry.basis], ["current", "identity-comparison"], "no candidate: the drawn development is compared with the lifecycle record by identity");
  assert.ok(p2.polygon.length >= 3 && p2.labelAt);
  const p1 = phaseOf(view, P1);
  assert.deepEqual([p1.candidate.completeness, p1.candidate.eligibleForB15, p1.intake.state, p1.source.state], ["complete", true, "pending", "none"]);
  assert.deepEqual(p1.candidate.statedFacts, [{ factId: factId(1), kind: "residents", quantity: 120 }, { factId: factId(2), kind: "jobs", quantity: 0 }], "each stated figure on its own; a stated zero stays 0");
  assert.deepEqual(p1.notDeliveredReasons, ["intake-pending"]);
  assert.equal(p1.geometry.basis, "candidate");
  assert.ok(p1.sequence < p2.sequence, "phases keep the order the player gave");
  assert.equal(p1.dim, false);
});

test("the decision states are shown apart: pending / accepted / held / rejected / stale / revoked, each with its reason, and none is hidden", () => {
  const w = world();
  const id = `new-town-demand-candidate:${EXAMPLE.developmentId}:${P1}`;
  const dev = w.development.id;
  const state = () => phaseOf(w.view()).intake;
  assert.equal(state().state, "pending");
  w.real.holdNewTownDemandCandidate({ developmentRecordId: dev, candidateId: id, reason: "waiting", geometry: w.map });
  assert.equal(state().state, "held");
  assert.equal(phaseOf(w.view()).dim, false);
  w.real.rejectNewTownDemandCandidate({ developmentRecordId: dev, candidateId: id, reason: "no", geometry: w.map });
  assert.equal(state().state, "rejected");
  w.accept();
  let p = phaseOf(w.view());
  assert.deepEqual([p.intake.state, p.intake.verification.status, p.intake.intakeId], ["accepted", "current", "new-town-demand-intake:1"]);
  assert.deepEqual(p.notDeliveredReasons, ["source-not-created"]);
  w.real.delayNewTownDevelopment(dev, "late");
  p = phaseOf(w.view());
  assert.deepEqual([p.intake.state, p.intake.verification.status, p.dim], ["stale", "stale", true]);
  assert.ok(p.intake.verification.reasons.includes("lifecycle-transitions-changed"));
  assert.deepEqual(p.notDeliveredReasons, ["intake-stale"]);
  w.real.revokeNewTownDemandCandidate("new-town-demand-intake:1", "changed");
  p = phaseOf(w.view());
  assert.deepEqual([p.intake.state, p.intake.intakeId, p.intake.revokedIntakeIds, p.dim], ["revoked", null, ["new-town-demand-intake:1"], true], "a revoked decision stays in sight, faint");
  assert.deepEqual(p.notDeliveredReasons, ["intake-revoked"]);
  // without the map an accepted decision is unverified, never shown as current
  const fresh = world();
  fresh.accept();
  fresh.mapOff = true;
  const q = phaseOf(fresh.view());
  assert.deepEqual([q.intake.state, q.intake.verification.status], ["accepted", "unverified"]);
  assert.deepEqual(q.notDeliveredReasons, ["candidate-not-eligible:null", "intake-unverified"], "no map: the candidate itself is not known to be complete");
});

test("whether the explicit demand source was handed over: delivered only when it exists and is current; every other case says what is missing, and stale / withdrawn stay visible", () => {
  const w = world();
  w.accept();
  assert.deepEqual(phaseOf(w.view()).notDeliveredReasons, ["source-not-created"]);
  w.createSource();
  let p = phaseOf(w.view());
  assert.deepEqual([p.source.state, p.source.delivered, p.source.sourceId, p.notDeliveredReasons], ["current", true, "new-town-explicit-demand-source:new-town-demand-intake:1", []]);
  assert.equal(p.dim, false);
  w.real.delayNewTownDevelopment(w.development.id, "late");
  p = phaseOf(w.view());
  assert.deepEqual([p.source.state, p.source.delivered, p.dim], ["stale", false, true]);
  assert.ok(p.source.reasons.includes("lifecycle-transitions-changed"));
  assert.deepEqual(p.notDeliveredReasons, ["intake-stale", "source-stale"]);
  w.real.withdrawNewTownExplicitDemandSource(p.source.sourceId, "plan changed");
  p = phaseOf(w.view());
  assert.deepEqual([p.source.state, p.source.delivered, p.dim], ["withdrawn", false, true]);
  assert.ok(p.notDeliveredReasons.includes("source-withdrawn"));
  // a revoked decision whose source is still on record: both are shown
  const v = world();
  v.accept(); v.createSource();
  v.real.revokeNewTownDemandCandidate("new-town-demand-intake:1", "changed my mind");
  const r = phaseOf(v.view());
  assert.deepEqual([r.intake.state, r.source.state, r.source.reasons], ["revoked", "stale", ["intake-revoked"]]);
  assert.equal(r.source.delivered, false);
  // a phase with no usable stated fact: the candidate exists, the figure is null, and nothing is handed over
  const h = world({ facts: { [P1]: [RESIDENTS], [P2]: [HOUSING] } });
  const q = phaseOf(h.view(), P2);
  assert.deepEqual([q.candidate.statedFacts, q.candidate.eligibleForB15], [null, null]);
  assert.deepEqual(q.notDeliveredReasons, ["no-stated-demand-fact", "candidate-not-eligible:null", "intake-pending"]);
});

test("the map against the lifecycle record: current, stale (revision), other-pack, inactive, unknown - for a phase with and without a candidate", () => {
  const w = world({ facts: { [P1]: [RESIDENTS] } });
  const check = (map, expected, phaseId) => {
    w.map = exportOf([map]);
    w.mapOff = false;
    const p = phaseOf(w.view(), phaseId);
    assert.equal(p.geometry.status, expected, `${phaseId === P1 ? "candidate" : "no candidate"}: ${expected}`);
    return p;
  };
  check(EXAMPLE, "current", P1); check(EXAMPLE, "current", P2);
  check(geo({ developmentRevision: "new-town-revision:0000000000000000" }), "stale", P1);
  assert.deepEqual(check(geo({ developmentRevision: "new-town-revision:0000000000000000" }), "stale", P2).geometry.reasons, ["geometry-revision-changed"]);
  check(geo({ sourcePackId: "other-pack" }), "other-pack", P2);
  check(geo({ active: false }), "inactive", P2);
  assert.equal(check(geo({ active: false }), "inactive", P1).dim, true, "a switched-off development is faint");
  const off = geo(); off.phases = off.phases.map((p) => (p.phaseId === P2 ? { ...p, active: false } : p));
  assert.deepEqual([check(off, "inactive", P2).active, phaseOf(w.view(), P1).geometry.status], [false, "current"]);
  const bare = new ScenarioRuntime({ pack: PACK, operationalState: createState(PACK) });
  const view = buildNewTownDemandOverlayView({ geometryExport: exportOf(), developments: bare.newTownDevelopmentReport() });
  assert.deepEqual([phaseOf(view, P1).geometry.status, phaseOf(view, P1).lifecycle, phaseOf(view, P1).notDeliveredReasons], ["unknown", { development: null, phase: null }, ["development-record-missing"]]);
  assert.ok(Object.keys(GEOMETRY_STYLE).includes("other-pack"));
});

test("decisions and sources that no drawn phase accounts for are kept in the view, not dropped", () => {
  const w = world();
  w.accept(); w.createSource();
  const inputs = w.inputs();
  const view = buildNewTownDemandOverlayView({ ...inputs, geometryExport: exportOf([]) });
  assert.equal(view.developments.length, 0);
  assert.deepEqual(view.unmatched.intakes.map((i) => [i.intakeId, i.state]), [["new-town-demand-intake:1", "accepted"]]);
  assert.deepEqual(view.unmatched.sources.map((s) => [s.sourceId, s.state]), [["new-town-explicit-demand-source:new-town-demand-intake:1", "current"]]);
  const ghost = buildNewTownDemandOverlayView({ ...inputs, intakes: [...inputs.intakes, { id: "new-town-demand-intake:9", developmentRecordId: "x", candidateId: "gone", status: "accepted", standing: { currentStatus: "stale", verification: { status: "stale", reasons: [] } } }] });
  assert.deepEqual(ghost.unmatched.intakes.map((i) => [i.intakeId, i.state]), [["new-town-demand-intake:9", "stale"]]);
});

test("the drawing: the fill is the decision state, the outline is the map state, the source marker says handed over; stale and revoked are faint and dashed, never skipped", () => {
  const w = world();
  const colourOf = (state, faint = 1) => rgba(INTAKE_STYLE[state].color, INTAKE_STYLE[state].fill * faint);
  assert.equal(firstFill(drawn(w.view())).fillStyle, colourOf("pending"));
  w.accept();
  let calls = drawn(w.view());
  assert.equal(firstFill(calls).fillStyle, colourOf("accepted"));
  const outline = calls.find((c) => c.op === "stroke");
  assert.equal(outline.strokeStyle, rgba(GEOMETRY_STYLE.current.stroke, 1));
  assert.deepEqual(outline.dash, []);
  assert.equal(calls.filter((c) => c.op === "rect").length, 0, "no source: no marker");
  w.createSource();
  calls = drawn(w.view());
  assert.equal(calls.filter((c) => c.op === "rect").length, 1);
  const marker = calls.findIndex((c) => c.op === "rect");
  assert.equal(calls.slice(marker).find((c) => c.op === "fill").fillStyle, rgba(INTAKE_STYLE.accepted.color, 0.9), "a handed-over source is a filled marker");
  w.real.delayNewTownDevelopment(w.development.id, "late");
  calls = drawn(w.view());
  assert.equal(firstFill(calls).fillStyle, colourOf("stale", 0.5), "stale: faint");
  assert.deepEqual(calls.find((c) => c.op === "stroke").dash, [3, 4], "stale: dashed");
  const staleMarker = calls.findIndex((c) => c.op === "rect");
  assert.ok(staleMarker >= 0 && calls.slice(staleMarker, staleMarker + 2).every((c) => c.op !== "fill"), "a stale source is a hollow marker, not a filled one");
  w.real.revokeNewTownDemandCandidate("new-town-demand-intake:1", "changed");
  calls = drawn(w.view());
  assert.equal(firstFill(calls).fillStyle, colourOf("revoked", 0.5), "revoked: still drawn, faint");
  assert.equal(calls.filter((c) => c.op === "fill").length >= 2, true, "both phases are drawn");
  assert.ok(calls.some((c) => c.op === "fillText" && c.args[0].includes("철회(revoked)")), "and named");
});

test("nothing drawn depends on a stated figure: two worlds that differ only in the quantities stated draw exactly the same", () => {
  const small = world({ facts: { [P1]: [{ statedOccupiedUnits: 1, unit: "residents", source: "s" }, { statedOccupiedUnits: 0, unit: "jobs", source: "s" }] } });
  const huge = world({ facts: { [P1]: [{ statedOccupiedUnits: 987654321, unit: "residents", source: "s" }, { statedOccupiedUnits: 55555, unit: "jobs", source: "s" }] } });
  for (const w of [small, huge]) { w.accept([factId(1), factId(2)]); w.createSource(); }
  assert.equal(JSON.stringify(drawn(small.view())), JSON.stringify(drawn(huge.view())), "the same canvas calls");
  assert.notEqual(JSON.stringify(small.view()), JSON.stringify(huge.view()), "the figures themselves are still in the view");
  const written = drawn(huge.view()).filter((c) => c.op === "fillText" || c.op === "strokeText").map((c) => c.args[0]).join("|");
  assert.ok(!/987654321|55555/.test(written));
  assert.ok(phaseCaption(phaseOf(huge.view())).includes("승인됨(accepted)"));
});

test("the mount is read-only: it draws and lists the facts, the only control is choosing a phase to look at, and the figures are listed one by one with no total", () => {
  const w = world({ facts: { [P1]: [RESIDENTS, JOBS], [P2]: [HOUSING] } });
  w.accept([factId(1), factId(2)]); w.createSource();
  const before = JSON.stringify(w.real.game.snapshot());
  const { env, overlay, changes } = mount(w);
  const text = panelText(env);
  assert.ok(text.includes(SCOPE_NOTICE) && text.includes(STALE_NOTICE));
  assert.ok(text.includes("B15 입력 원천: 전달됨 · new-town-explicit-demand-source:new-town-demand-intake:1 (current)"));
  assert.ok(text.includes("승인 기록: 승인됨(accepted) · new-town-demand-intake:1 · 근거 current"));
  assert.ok(text.includes("B15 입력 원천: 전달 안 됨 —") && text.includes("원인 no-stated-demand-fact, candidate-not-eligible:null, intake-pending"));
  assert.ok(text.includes("명시 사실 2건") && text.includes("명시 사실 없음(null)"));
  assert.ok(!text.includes("residents 120"), "figures appear only for the phase being looked at");
  assert.equal(JSON.stringify(w.real.game.snapshot()), before, "mounting changed nothing in the engine");
  const buttons = find(panelOf(env, P), (n) => n.tag === "button").map((b) => b.textContent);
  assert.deepEqual([...new Set(buttons)], ["지도에서 강조"], "the only control");
  press(env, P, "지도에서 강조", 0);
  const picked = panelText(env);
  assert.ok(picked.includes("명시 수치(플레이어가 적은 그대로, 합계 없음): residents 120 · jobs 0"));
  assert.deepEqual(overlay.output().selected, { developmentId: EXAMPLE.developmentId, phaseId: P1 });
  assert.equal(phaseOf(overlay.output().view).selected, true);
  assert.ok(!/합계:|총합|\b120 \+|합산/.test(picked.replace(SCOPE_NOTICE, "").replace(STALE_NOTICE, "").replace("합계 없음", "")), "no total anywhere but the notices that say there is none");
  assert.deepEqual(Object.keys(overlay.output()), ["view", "selected", "warnings"]);
  assert.ok(changes.length >= 2);
  env.win.fire("keydown", { key: "Escape", preventDefault() {} });
  assert.equal(overlay.output().selected, null);
  const events = []; env.canvas.addEventListener(NEW_TOWN_DEMAND_OVERLAY_EVENT, (e) => events.push(e.detail));
  overlay.select(EXAMPLE.developmentId, P2);
  assert.equal(JSON.stringify(events.at(-1)), JSON.stringify(overlay.output()));
  overlay.select(EXAMPLE.developmentId, "no-such-phase");
  assert.equal(overlay.output().selected, null, "choosing something that is not drawn selects nothing");
});

test("stale, revoked and withdrawn items are listed in the panel, flagged, and never hidden", () => {
  const w = world();
  w.accept(); w.createSource();
  w.real.delayNewTownDevelopment(w.development.id, "late");
  const { env } = mount(w);
  let text = panelText(env);
  assert.ok(text.includes("낡음(stale)") && text.includes("원천 stale") && text.includes("lifecycle-transitions-changed"));
  assert.ok(find(panelOf(env, P), (n) => String(n.className).includes("ntd-dim")).length >= 1, "faint rows");
  w.real.revokeNewTownDemandCandidate("new-town-demand-intake:1", "changed");
  w.real.withdrawNewTownExplicitDemandSource("new-town-explicit-demand-source:new-town-demand-intake:1", "gone");
  const second = mount(w);
  text = panelText(second.env);
  assert.ok(text.includes("철회(revoked)") && text.includes("철회된 기록 new-town-demand-intake:1") && text.includes("원천 withdrawn"));
  assert.ok(text.includes("source-withdrawn"));
});

test("unreadable inputs, switched-off and removed mounts: a failing getter is a warning, not a pass; disabled hides; destroy removes everything", () => {
  const w = world();
  w.accept();
  const { env, overlay } = mount(w, { getSources: () => { throw new Error("sources broke"); }, getIntakes: () => { throw new Error("intakes broke"); } });
  const out = overlay.output();
  assert.deepEqual(out.warnings.filter((x) => x.code === "input-unreadable").map((x) => x.input).sort(), ["getIntakes", "getSources"]);
  const p = phaseOf(out.view);
  assert.deepEqual([p.intake.state, p.source.state, p.source.delivered], ["pending", "none", false], "what cannot be read is not turned into a decision or a source");
  assert.ok(panelText(env).includes("input-unreadable"));
  overlay.setEnabled(false);
  assert.equal(panelOf(env, P).hidden, true);
  assert.equal(layerOf(env).style.display, "none");
  overlay.setEnabled(true);
  assert.equal(panelOf(env, P).hidden, false);
  overlay.destroy();
  assert.equal(panelOf(env, P), undefined);
  assert.equal(layerOf(env), undefined);
  // a mount with no getters at all
  const empty = browser();
  const bare = mountNewTownDemandOverlay({ canvas: empty.canvas, projection, pack: PACK, autoRefreshMs: 0 });
  assert.deepEqual(bare.output().view.developments, []);
  assert.ok(texts(panelOf(empty, P)).join("\n").includes("지도에 신도시 개발이 없습니다"));
});

test("the same inputs give the same view whatever order they come in, frozen inputs are fine and are not changed, and the mount stores nothing", () => {
  const w = world({ facts: { [P1]: [RESIDENTS, JOBS], [P2]: [HOUSING] } });
  w.accept([factId(1)]); w.createSource();
  const inputs = w.inputs();
  const a = JSON.stringify(buildNewTownDemandOverlayView(inputs));
  const shuffled = { ...inputs, intakes: [...inputs.intakes].reverse(), sources: [...inputs.sources].reverse(), developments: [...inputs.developments].reverse(), geometryExport: { ...inputs.geometryExport, developments: [{ ...EXAMPLE, phases: [...EXAMPLE.phases].reverse() }] } };
  assert.equal(JSON.stringify(buildNewTownDemandOverlayView(shuffled)), a);
  const frozen = deepFreeze(structuredClone(inputs));
  const before = JSON.stringify(frozen);
  assert.equal(JSON.stringify(buildNewTownDemandOverlayView(frozen)), a);
  assert.equal(JSON.stringify(frozen), before);
  const view = buildNewTownDemandOverlayView(inputs);
  view.developments[0].phases[0].intake.state = "tampered";
  assert.equal(JSON.stringify(buildNewTownDemandOverlayView(inputs)), a, "the view shares nothing with its inputs or earlier views");
  // nothing is stored, and no timer starts when auto refresh is off
  const env = browser();
  env.win.localStorage = new Proxy({}, { get() { throw new Error("storage touched"); } });
  mountNewTownDemandOverlay({ canvas: env.canvas, projection, pack: PACK, autoRefreshMs: 0, getGeometryExport: () => inputs.geometryExport, getDevelopments: () => inputs.developments, getCandidates: () => inputs.candidates, getIntakes: () => inputs.intakes, getSources: () => inputs.sources });
  assert.equal(env.win.intervals, 0);
  assert.equal(env.storage.size, 0);
});

test("the module keeps its promises: no engine, no storage, no clock, no random number, no arithmetic on stated quantities, no word of people, totals, cost or traffic", () => {
  const w = world();
  w.accept([factId(1), factId(2)]); w.createSource();
  const { env, overlay } = mount(w);
  overlay.select(EXAMPLE.developmentId, P1);
  const seen = [panelText(env).replace(SCOPE_NOTICE, "").replace(STALE_NOTICE, ""), JSON.stringify(drawn(overlay.output().view).filter((c) => c.op === "fillText").map((c) => c.args[0]))];
  for (const t of seen) assert.equal(/합계|총합|합산|인구 추정|수요 예측|승객|운임|혼잡|사업성|\bROI\b|점수|순위|확률/.test(t.replace("합계 없음", "")), false);
  const keys = [];
  const walk = (value) => { if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) { keys.push(k); walk(v); } };
  walk(overlay.output());
  const banned = new Set(["population", "total", "sum", "score", "rank", "cost", "price", "feasibility", "revenue", "traffic", "ridership", "passengers", "fare", "demand", "ratio", "rate"]);
  assert.deepEqual(keys.filter((k) => k.split(/(?=[A-Z])|-/).some((word) => banned.has(word.toLowerCase()))), []);
  for (const file of ["new-town-demand-overlay-view.mjs", "new-town-demand-overlay-ui.mjs"]) {
    const src = read(`../src/map/${file}`);
    assert.ok(src.length < 40_000, `${file} holds code, not data`);
    for (const imp of src.matchAll(/from "([^"]+)"/g)) assert.match(imp[1], /^\.\/[a-z-]+\.mjs$/, `${file} imports ${imp[1]}`);
    const code = src.replace(/\/\/.*$/gm, "").replace(/"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g, '""');
    assert.equal(/management|scenario-runtime|main\.mjs|runtime\./.test(code), false, file);
    assert.equal(/localStorage|sessionStorage|indexedDB|Date\.now|new Date|Math\.random|node:fs|fetch\(|setTimeout/.test(code), false, file);
    assert.equal(/ledger|\.commit\(|\.settle\(|\.post\(/.test(code), false, file);
    assert.equal(/\.quantity\s*[-+*/]|[-+*/]\s*\w*\.quantity|\breduce\(|Math\.|parseFloat|toFixed/.test(code), false, `${file}: a stated figure is never computed`);
  }
});
