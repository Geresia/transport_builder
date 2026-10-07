import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { ScenarioRuntime } from "../src/scenario-runtime.mjs";
import { ALLOCATION_VIEW_SCHEMA, buildAllocationOverlayView, drawAllocationOverlay, hitAllocationNode, percentText, renderAllocationLegend, renderAllocationPanel } from "../src/map/station-demand-allocation-view.mjs";
import { ALLOCATION_UI_EVENT, SCOPE_NOTICE, mountStationDemandAllocationOverlay } from "../src/map/station-demand-allocation-ui.mjs";
import { ALLOCATION_VARIANTS, accessExport, buildAppliedWorld, overlayPack, overlayWorld } from "../../scripts/lib/allocation-overlay-world.mjs";
import { BANNED_TEXT, browser, clickAt, deepFreeze, find, hasText, layerOf, panelOf, projection, texts } from "./helpers/fake-browser.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const PANEL = "tl-alloc-panel";
const worlds = Object.fromEntries(ALLOCATION_VARIANTS.map((v) => [v, buildAppliedWorld(v)]));
const viewOf = (w, extra = {}) => buildAllocationOverlayView({ report: w.report, access: w.access, demandNodes: w.demandNodes, stations: w.stations, ...extra });
const nodeOf = (view, id) => view.nodes.find((n) => n.demandNodeId === id);
const screenOf = (ll) => projection.toScreen(ll);
const A = [139.007, 35.0013]; // node:a on the fake screen

function recordingCtx() {
  const calls = [];
  const ctx = new Proxy({}, { get: (t, k) => (k in t ? t[k] : (...args) => calls.push([k, ...args])), set: (t, k, v) => { t[k] = v; calls.push(["set", k, v]); return true; } });
  return { ctx, calls };
}
const drawn = (view) => { const { ctx, calls } = recordingCtx(); drawAllocationOverlay(ctx, view, screenOf); return calls; };
const written = (calls) => calls.filter((c) => c[0] === "fillText" || c[0] === "strokeText").map((c) => c[1]);
const panelLines = (view) => { const env = browser(); const box = env.doc.createElement("div"); renderAllocationPanel(box, view); return texts(box); };

function mount(world = worlds.split, { live = {}, options = {} } = {}) {
  const env = browser();
  const state = { report: world.report, access: world.access, demandNodes: world.demandNodes, stations: world.stations, ...live };
  const changes = [];
  const fired = [];
  env.canvas.addEventListener(ALLOCATION_UI_EVENT, (e) => fired.push(e));
  const bridge = mountStationDemandAllocationOverlay({
    canvas: env.canvas, projection, pack: world.pack, getAllocationReport: () => state.report, getAccessReport: () => state.access, getDemandNodes: () => state.demandNodes, getStations: () => state.stations,
    onChange: (o) => changes.push(o), autoRefreshMs: 0, ...options,
  });
  return { env, state, bridge, changes, fired };
}

// --- what the engine really produced ---
test("the worlds come from the real engine path and have the shapes the overlay is built for", () => {
  assert.equal(worlds.split.report.status, "current");
  assert.equal(worlds.split.report.links.length, 3);
  assert.deepEqual(worlds.split.report.splitNodes.map((s) => s.demandNodeId), ["node:a"]);
  assert.equal(worlds.stale.report.status, "stale");
  assert.equal(worlds.blocked.report.blockedLinks.length, 2);
  assert.equal(worlds.unknown.report.links.length, 0);
  const runtime = new ScenarioRuntime({ pack: overlayPack(), operationalState: overlayWorld(), networkMode: "scratch", seed: 3 });
  runtime.applyStationDemandAccess(accessExport());
  runtime.applyStationDemandAllocation({ policy: worlds.split.report.allocationPolicy });
  const view = buildAllocationOverlayView({ report: runtime.stationDemandAllocationReport(), access: runtime.stationDemandAccessReport(), demandNodes: runtime.operationalState.demandNodes, stations: runtime.operationalState.stations });
  assert.equal(view.lines.length, 3, "the report the runtime hands out is what the overlay reads");
});

// --- the view model ---
test("no applied allocation is a plain statement, not an empty success", () => {
  const view = buildAllocationOverlayView({});
  assert.equal(view.schema, ALLOCATION_VIEW_SCHEMA);
  assert.deepEqual([view.status, view.stale, view.totals, view.nodes, view.lines], ["none", false, null, [], []]);
  assert.equal(view.banner, "적용된 배정이 없습니다.");
});

test("a 60 / 40 split shows both expected shares and both links; a whole-node assignment is told apart from it", () => {
  const view = viewOf(worlds.split);
  const a = nodeOf(view, "node:a");
  assert.deepEqual([a.visual.key, a.state, a.decision], ["split", "shared", "assigned"]);
  assert.deepEqual(a.assignments.map((x) => [x.siteName, x.percent, x.linkState, x.stationId]), [["Alpha", "60%", "linked", "physical:a"], ["Beta", "40%", "linked", "physical:b"]]);
  assert.deepEqual(view.lines.filter((l) => l.demandNodeId === "node:a").map((l) => [l.percent, l.fractional, l.kind]), [["60%", true, "link"], ["40%", true, "link"]]);
  const b = nodeOf(view, "node:b");
  assert.deepEqual([b.visual.key, b.assignments[0].percent], ["assigned", "100%"]);
  assert.deepEqual(view.lines.filter((l) => l.demandNodeId === "node:b").map((l) => l.fractional), [false]);
  assert.deepEqual(view.totals, { nodes: 2, assigned: 1, split: 1, held: 0, unknown: 0, links: 3, blocked: 0 });
});

test("a share the policy left out and a share no link takes are two different facts, each shown as it was reported", () => {
  const a = nodeOf(viewOf(worlds.partial), "node:a");
  assert.deepEqual([a.visual.key, a.decision, a.unallocatedText, a.unroutedText], ["split", "shares", "30%", "30%"]);
  const whole = nodeOf(viewOf(worlds.split), "node:a");
  assert.deepEqual([whole.unallocatedShare, whole.unroutedShare], [0, 0], "0 is a stated fact: nothing left over");
  const none = nodeOf(viewOf(worlds.held), "node:b");
  assert.equal(none.unroutedShare, null, "a node that is not split has no unrouted figure: unknown, not 0");
});

test("a blocked link is drawn to the access site it could not reach and names why; the node still shows its other share", () => {
  const view = viewOf(worlds.blocked);
  const a = nodeOf(view, "node:a");
  assert.deepEqual(a.assignments.map((x) => [x.percent, x.linkState, x.blockLabel]), [["60%", "linked", null], ["40%", "blocked", "운행 역이 아직 없음"]]);
  assert.deepEqual([a.unroutedShare, a.unroutedText], [0.4, "40%"]);
  const stop = view.lines.find((l) => l.kind === "blocked" && l.demandNodeId === "node:a");
  assert.deepEqual([stop.stationId, stop.label, stop.to], [null, "운행 역이 아직 없음", worlds.blocked.access.access.sites[1].location]);
  assert.equal(view.totals.blocked, 2);
});

test("a node nobody was assigned (held) and a node that is unknown are different things, and neither gets a line", () => {
  const held = nodeOf(viewOf(worlds.held), "node:a");
  assert.deepEqual([held.visual.key, held.decision, held.assignments, held.unallocatedShare, held.reasons.map((r) => r.label)], ["held", "held", [], 1, ["겹치는 노드 · 배정 규칙 없음"]]);
  assert.equal(held.residents, 4000, "its values are known; it simply was not given to a station");
  const view = viewOf(worlds.unknown);
  for (const n of view.nodes) assert.deepEqual([n.visual.key, n.decision, n.residents, n.jobs, n.residentsText, n.jobsText, n.unallocatedShare, n.unallocatedText, n.assignments], ["unknown", "unknown", null, null, "미상", "미상", null, null, []]);
  assert.deepEqual(view.lines, []);
  assert.ok(nodeOf(view, "node:a").reasons.some((r) => r.label === "수요 자료가 시구 단위로 거침" || r.label === "수요 자료 품질이 낮음"));
});

test("a stale allocation is marked and faded — never hidden, never refreshed", () => {
  const view = viewOf(worlds.stale);
  assert.deepEqual([view.status, view.stale, view.staleReasons], ["stale", true, ["station-demand-access-revision-changed"]]);
  assert.match(view.banner, /낡은 배정/);
  assert.equal(view.lines.length, 3, "the links it applied are still shown");
  const calls = drawn(view);
  assert.ok(calls.some((c) => c[0] === "set" && c[1] === "globalAlpha" && c[2] === 0.5));
  assert.ok(written(calls).some((t) => t.includes("낡음")));
  assert.ok(!written(drawn(viewOf(worlds.split))).some((t) => t.includes("낡음")));
});

test("null, 0 and false stay apart: a real 0/0 node, an unknown value, an unknown legacy fact", () => {
  const report = structuredClone(worlds.split.report);
  const [a, b] = report.allocation.nodes;
  Object.assign(b, { residents: 0, jobs: 0 }); // a real zero
  Object.assign(a, { residents: null, jobs: 5, unallocatedShare: 0 });
  a.legacy = { supplied: true, linkCount: 0, stationIds: [], conflictsWithAllocation: false, overrideRequired: null, activeWhileUnallocated: null };
  const view = buildAllocationOverlayView({ report, access: worlds.split.access, demandNodes: worlds.split.demandNodes, stations: worlds.split.stations, selectedNodeId: "node:a" });
  assert.deepEqual([nodeOf(view, "node:b").residentsText, nodeOf(view, "node:b").jobsText], ["0", "0"]);
  assert.deepEqual([nodeOf(view, "node:a").residentsText, nodeOf(view, "node:a").jobsText], ["미상", "5"]);
  assert.equal(nodeOf(view, "node:a").unallocatedText, "0%");
  const lines = panelLines(view);
  assert.ok(lines.some((t) => t.includes("기존 링크 0개 · 새 배정과 충돌 없음 · 대체 필요 미상")), "0 links, false conflict, null override");
  assert.ok(lines.some((t) => t.includes("거주 미상 · 종사 5")));
  assert.equal(percentText(null), "미상");
  assert.equal(percentText(0), "0%");
  assert.equal(percentText(0.6), "60%");
  // a report that never said legacy: not "no conflict", unknown
  const noLegacy = structuredClone(worlds.split.report);
  for (const n of noLegacy.allocation.nodes) n.legacy = { supplied: false, linkCount: null, stationIds: null, conflictsWithAllocation: null, overrideRequired: null, activeWhileUnallocated: null };
  const bare = buildAllocationOverlayView({ report: noLegacy, access: worlds.split.access, demandNodes: worlds.split.demandNodes, stations: worlds.split.stations, selectedNodeId: "node:b" });
  assert.ok(panelLines(bare).some((t) => t.includes("기존 링크 정보: 미상")));
});

test("a place the engine did not give is never invented: the node is listed, not drawn", () => {
  const view = buildAllocationOverlayView({ report: worlds.split.report, access: worlds.split.access, demandNodes: worlds.split.demandNodes.filter((n) => n.id !== "node:a"), stations: worlds.split.stations.filter((s) => s.id !== "physical:b") });
  assert.equal(nodeOf(view, "node:a").location, null);
  assert.deepEqual(view.missing, { nodes: ["node:a"], stations: ["physical:b"], sites: [] });
  assert.ok(view.lines.every((l) => l.demandNodeId !== "node:a"), "no line from a node with no place");
  assert.ok(view.lines.every((l) => l.stationId !== "physical:b"), "no line to a station with no place");
  assert.ok(!written(drawn(view)).join("|").includes("node:a"));
  const lines = panelLines(view);
  assert.ok(lines.some((t) => t.includes("node:a") && t.includes("위치 미상")));
  assert.ok(lines.some((t) => t.includes("위치를 모르는 것은 그리지 않습니다")));
});

test("Maps and lists of nodes and stations give the same picture; the order of anything does not matter", () => {
  const w = worlds.split;
  const lists = viewOf(w);
  const asMap = (list) => new Map(list.map((x) => [x.id, x]));
  assert.equal(JSON.stringify(viewOf({ ...w, demandNodes: asMap(w.demandNodes), stations: asMap(w.stations) })), JSON.stringify(lists));
  assert.equal(JSON.stringify(viewOf({ ...w, demandNodes: [...w.demandNodes].reverse(), stations: [...w.stations].reverse() })), JSON.stringify(lists));
  const shuffled = structuredClone(w.report);
  shuffled.links.reverse();
  shuffled.allocation.nodes.reverse();
  shuffled.allocation.stations.reverse();
  assert.equal(JSON.stringify(viewOf({ ...w, report: shuffled })), JSON.stringify(lists));
});

test("the same input always gives the same view, and the input is never changed", () => {
  const frozen = ALLOCATION_VARIANTS.map((v) => deepFreeze(structuredClone({ report: worlds[v].report, access: worlds[v].access, demandNodes: worlds[v].demandNodes, stations: worlds[v].stations })));
  const before = JSON.stringify(frozen);
  for (const input of frozen) {
    const first = buildAllocationOverlayView({ ...input, selectedNodeId: "node:a" });
    const second = buildAllocationOverlayView({ ...input, selectedNodeId: "node:a" });
    assert.equal(JSON.stringify(first), JSON.stringify(second));
    drawn(first);
    const env = browser();
    const box = env.doc.createElement("div");
    renderAllocationPanel(box, first);
    renderAllocationLegend(box);
  }
  assert.equal(JSON.stringify(frozen), before);
});

test("the view never turns a share into a number of people, and no key names a quantity the map must not compute", () => {
  for (const v of ["split", "partial"]) {
    const view = viewOf(worlds[v], { selectedNodeId: "node:a" });
    const everything = [...panelLines(view), ...written(drawn(view))].join("\n");
    for (const product of ["2,400", "1,600", "2,000", "800", "60"]) assert.ok(!everything.includes(`거주 ${product}`) && !everything.includes(`종사 ${product}`), `${v}: ${product}`);
    const keys = new Set();
    const walk = (x) => { if (Array.isArray(x)) x.forEach(walk); else if (x && typeof x === "object") for (const [k, y] of Object.entries(x)) { keys.add(k); walk(y); } };
    walk(view);
    assert.deepEqual([...keys].filter((k) => /passenger|ridership|fare|crowd|congest|score|cost|cash|price|probab|forecast/i.test(k)), []);
  }
});

test("hitting a node: the nearest within the radius, nothing beyond it, no place no hit", () => {
  const view = viewOf(worlds.split);
  const [x, y] = screenOf(A);
  assert.equal(hitAllocationNode(view, screenOf, [x + 3, y - 2]), "node:a");
  assert.equal(hitAllocationNode(view, screenOf, [x + 40, y]), null);
  const gone = buildAllocationOverlayView({ report: worlds.split.report, access: worlds.split.access, demandNodes: [], stations: [] });
  assert.equal(hitAllocationNode(gone, screenOf, [x, y]), null);
});

// --- the drawing ---
test("each state has its own look: shape, glyph, dashes and words, not colour alone", () => {
  const split = written(drawn(viewOf(worlds.split)));
  for (const word of ["예상 60%", "예상 40%", "예상 100%", "node:a · 비율 배정", "node:b · 전부 배정", "Alpha", "Beta"]) assert.ok(split.includes(word), word);
  assert.ok(split.includes("%") && split.includes("✓"), "glyphs");
  assert.ok(written(drawn(viewOf(worlds.unknown))).includes("?"));
  assert.ok(written(drawn(viewOf(worlds.held))).includes("‖"));
  assert.ok(written(drawn(viewOf(worlds.partial))).includes("경로 없음 30%"));
  assert.ok(written(drawn(viewOf(worlds.blocked))).some((t) => t.includes("차단: 운행 역이 아직 없음")));
  const dashes = (v) => drawn(viewOf(worlds[v])).filter((c) => c[0] === "setLineDash").map((c) => JSON.stringify(c[1]));
  assert.ok(dashes("split").includes("[6,3]"), "a fractional link is dashed");
  assert.ok(dashes("blocked").includes("[3,4]"), "a blocked link is dotted");
  assert.ok(dashes("unknown").includes("[2,3]"), "an unknown node has a dotted outline");
  assert.ok(!dashes("whole").includes("[6,3]"), "a whole link is solid (the [8,4] dashes are the catchments)");
});

test("a thicker line is only a bigger share of the node, the catchments are drawn faintly, and an empty view draws nothing", () => {
  const widths = (v) => drawn(viewOf(worlds[v])).filter((c) => c[0] === "set" && c[1] === "lineWidth").map((c) => c[2]);
  assert.ok(widths("split").includes(1.5 + 4 * 0.6) && widths("split").includes(1.5 + 4 * 0.4) && widths("split").includes(1.5 + 4));
  assert.ok(drawn(viewOf(worlds.split)).some((c) => c[0] === "closePath"), "the catchment polygons");
  const none = drawn(buildAllocationOverlayView({}));
  assert.ok(!none.some((c) => c[0] === "fillText" || c[0] === "arc"));
});

// --- the panel text ---
test("the panel and the legend use no verdict, price, time, size or score word, and say what they are not", () => {
  for (const v of ALLOCATION_VARIANTS) {
    const view = viewOf(worlds[v], { selectedNodeId: "node:a" });
    const env = browser();
    const box = env.doc.createElement("div");
    renderAllocationPanel(box, view);
    renderAllocationLegend(box);
    for (const line of [...texts(box), ...written(drawn(view))]) assert.doesNotMatch(line, BANNED_TEXT, `${v}: ${line}`);
  }
  assert.doesNotMatch(SCOPE_NOTICE, BANNED_TEXT);
  assert.match(SCOPE_NOTICE, /승객을 만들거나 세지 않고/);
});

test("the selected node's detail names its sites, shares and what became of each, in plain words", () => {
  const lines = panelLines(viewOf(worlds.blocked, { selectedNodeId: "node:a" }));
  assert.ok(lines.includes("선택한 노드: node:a"));
  assert.ok(lines.some((t) => t.startsWith("Alpha · 예상 비율 60% · 연결됨 (운행 역 physical:a")));
  assert.ok(lines.some((t) => t === "Beta · 예상 비율 40% · 차단: 운행 역이 아직 없음"));
  assert.ok(lines.some((t) => t.includes("경로 없음 40% (다른 접근으로 보내지 않음)")));
  assert.ok(lines.some((t) => t.includes("거주 4,000 · 종사 100")));
});

// --- the mount ---
test("mounting makes its own layer, panel and style, says what it is not, and reports once", () => {
  const m = mount();
  assert.ok(m.env.doc.head.children.some((c) => c.tag === "style"));
  assert.ok(panelOf(m.env, PANEL) && layerOf(m.env));
  assert.ok(hasText(m.env, PANEL, SCOPE_NOTICE));
  assert.equal(m.changes.length, 1);
  assert.equal(m.fired.length, 1);
  const out = m.bridge.output();
  assert.deepEqual([out.status, out.selectedNodeId, out.warnings], ["current", null, []]);
  assert.equal(out.view.lines.length, 3);
  assert.ok(hasText(m.env, PANEL, "노드 2 · 전부 배정 1 · 비율 배정 1 · 보류 0 · 미상 0"));
  assert.ok(layerOf(m.env).calls.length > 0, "something was drawn");
});

test("a click on a node selects it and is taken from the map; a click anywhere else goes on to the map", () => {
  const m = mount();
  const taken = [];
  const click = (ll, extra = [0, 0]) => { const p = screenOf(ll); m.env.canvas.dispatchEvent({ type: "pointerdown", clientX: p[0] + extra[0], clientY: p[1] + extra[1], stopImmediatePropagation() { taken.push(1); } }); };
  click(A);
  assert.equal(m.bridge.selectedNodeId, "node:a");
  assert.equal(taken.length, 1);
  assert.ok(hasText(m.env, PANEL, "선택한 노드: node:a"));
  click(A, [90, 90]);
  assert.equal(taken.length, 1, "a click that hit no node is left to the map");
  assert.equal(m.bridge.selectedNodeId, "node:a", "and changes nothing");
  m.env.win.fire("keydown", { key: "Escape" });
  assert.equal(m.bridge.selectedNodeId, null);
  assert.equal(m.bridge.select("nope"), false);
  assert.equal(m.bridge.select("node:b"), true);
  assert.equal(m.changes.at(-1).selectedNodeId, "node:b");
});

test("it follows what the engine reports: a stale mark, a new allocation, a cleared one — and says nothing when nothing changed", () => {
  const m = mount(worlds.split);
  const calls = m.changes.length;
  m.bridge.refresh();
  assert.equal(m.changes.length, calls, "no change, no report");
  m.state.report = worlds.stale.report;
  m.bridge.refresh();
  assert.equal(m.changes.length, calls + 1);
  assert.equal(m.bridge.output().status, "stale");
  assert.ok(hasText(m.env, PANEL, "낡은 배정"));
  assert.deepEqual(m.bridge.output().warnings, [{ code: "station-demand-access-revision-changed" }]);
  m.state.report = worlds.partial.report;
  m.state.access = worlds.partial.access;
  m.bridge.refresh();
  assert.equal(m.bridge.output().status, "current");
  assert.ok(hasText(m.env, PANEL, "비율 배정 1"));
  m.state.report = null;
  m.bridge.refresh();
  assert.equal(m.bridge.output().status, "none");
  assert.ok(hasText(m.env, PANEL, "적용된 배정이 없습니다."));
  assert.equal(m.bridge.output().view.nodes.length, 0);
});

test("a position that is missing is reported as a warning, not drawn and not guessed", () => {
  const m = mount(worlds.split, { live: { demandNodes: worlds.split.demandNodes.filter((n) => n.id !== "node:a") } });
  assert.deepEqual(m.bridge.output().warnings, [{ code: "position-unknown-nodes", ids: ["node:a"] }]);
  assert.ok(hasText(m.env, PANEL, "위치를 모르는 것은 그리지 않습니다: 노드 node:a"));
});

test("getters that are missing or odd give a quiet, empty picture; the pack's own points are the default places", () => {
  const env = browser();
  const bare = mountStationDemandAllocationOverlay({ canvas: env.canvas, projection, pack: worlds.split.pack, autoRefreshMs: 0 });
  assert.equal(bare.output().status, "none");
  const odd = mount(worlds.split, { live: { report: undefined, access: undefined, demandNodes: null, stations: undefined } });
  assert.equal(odd.bridge.output().status, "none");
  const env2 = browser();
  const defaulted = mountStationDemandAllocationOverlay({ canvas: env2.canvas, projection, pack: worlds.split.pack, getAllocationReport: () => worlds.split.report, getAccessReport: () => worlds.split.access, getStations: () => new Map(worlds.split.stations.map((s) => [s.id, s])), autoRefreshMs: 0 });
  assert.equal(defaulted.output().view.lines.length, 3, "node places come from pack.demand.points");
});

test("it is read-only: nothing is stored, the report is untouched, and its own clicks and keys write nothing", () => {
  const writes = [];
  const env = browser();
  const realSet = env.win.localStorage.setItem;
  env.win.localStorage.setItem = (...args) => { writes.push(args); return realSet(...args); };
  const frozen = { report: deepFreeze(structuredClone(worlds.split.report)), access: deepFreeze(structuredClone(worlds.split.access)), nodes: deepFreeze(structuredClone(worlds.split.demandNodes)), stations: deepFreeze(structuredClone(worlds.split.stations)) };
  const before = JSON.stringify(frozen);
  const bridge = mountStationDemandAllocationOverlay({ canvas: env.canvas, projection, pack: worlds.split.pack, getAllocationReport: () => frozen.report, getAccessReport: () => frozen.access, getDemandNodes: () => frozen.nodes, getStations: () => frozen.stations, autoRefreshMs: 0 });
  clickAt(env, A);
  bridge.select("node:b");
  env.win.fire("keydown", { key: "Escape" });
  bridge.setEnabled(false);
  bridge.setEnabled(true);
  bridge.refresh({ force: true });
  assert.deepEqual(writes, []);
  assert.equal(JSON.stringify(frozen), before);
  const out = bridge.output();
  out.view.nodes[0].assignments.push("scribble");
  assert.equal(JSON.stringify(frozen), before, "the output shares no object with the input");
  bridge.select("node:a");
  assert.equal(find(panelOf(env, PANEL), (n) => n.tag === "button").every((b) => b.textContent === "선택 해제"), true, "the only button deselects");
});

test("disabling hides it and ignores clicks; destroying takes everything away", () => {
  const m = mount();
  m.bridge.setEnabled(false);
  assert.equal(panelOf(m.env, PANEL).hidden, true);
  clickAt(m.env, A);
  assert.equal(m.bridge.selectedNodeId, null);
  m.bridge.setEnabled(true);
  assert.equal(panelOf(m.env, PANEL).hidden, false);
  m.bridge.destroy();
  assert.equal(panelOf(m.env, PANEL), undefined);
  assert.equal(layerOf(m.env), undefined);
  assert.deepEqual(m.env.canvas.listeners.pointerdown, []);
});

// --- boundaries ---
test("the new modules import only their map neighbours and reach no engine state, management, clock or random source", () => {
  for (const file of ["station-demand-allocation-view.mjs", "station-demand-allocation-ui.mjs"]) {
    const code = fs.readFileSync(path.join(root, "engine", "src", "map", file), "utf8");
    const imports = [...code.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
    assert.ok(imports.every((i) => /^\.\/[a-z-]+\.mjs$/.test(i)), `${file}: ${imports}`);
    assert.ok(imports.every((i) => ["./station-demand-allocation-view.mjs", "./map-mount-kit.mjs"].includes(i)), `${file}: ${imports}`);
    assert.doesNotMatch(code.replace(/\/\/.*$/gm, ""), /management|ledger|node:fs|Date\.now|Math\.random|performance\.now|localStorage|sessionStorage|\.commit\(|\.settle\(|\.post\(/);
    assert.ok(code.length < 40_000, file);
  }
});

// --- shipped examples ---
const exampleDir = path.join(root, "packs", "example-radial", "station-demand-allocation-overlay-examples");
test("the shipped examples are the overlay's view of the real engine path, say how they were made, and regenerate byte for byte", () => {
  const files = fs.readdirSync(exampleDir).filter((f) => f.endsWith(".overlay.json")).sort();
  assert.equal(files.length, ALLOCATION_VARIANTS.length);
  for (const f of files) {
    const example = JSON.parse(fs.readFileSync(path.join(exampleDir, f), "utf8"));
    assert.equal(example.schema, ALLOCATION_VIEW_SCHEMA, f);
    assert.equal(example.source.generatedBy, "scripts/build-station-demand-allocation-overlay-examples.mjs");
    assert.equal(example.source.synthetic, true);
    assert.ok(example.source.case.length > 0);
    for (const n of example.nodes) if (n.visual.key === "unknown") assert.deepEqual([n.residents, n.jobs, n.unallocatedShare], [null, null, null], `${f}: ${n.demandNodeId}`);
  }
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "alloc-overlay-examples-"));
  const run = spawnSync(process.execPath, [path.join(root, "scripts", "build-station-demand-allocation-overlay-examples.mjs"), "--out", out], { cwd: root, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(fs.readdirSync(path.join(out, "example-radial")).sort(), files);
  for (const f of files) assert.equal(fs.readFileSync(path.join(out, "example-radial", f), "utf8"), fs.readFileSync(path.join(exampleDir, f), "utf8"), f);
  fs.rmSync(out, { recursive: true, force: true });
});
