import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { keyedDevelopmentId, keyedPhaseId } from "../src/map/new-town-development.mjs";
import { NEW_TOWN_UI_EVENT, mountNewTownDevelopment } from "../src/map/new-town-development-ui.mjs";
import { NODE_NOTICE, RAIL_NOTICE, SCOPE_NOTICE } from "../src/map/new-town-development-panel.mjs";
import { makeSpatialContext, polygonLayer, roadLayerFromGeojson, waterLayerFromBarriers } from "../src/map/spatial.mjs";
import { BANNED_TEXT, browser, deepFreeze, find, hasButton, hasText, layerOf, panelOf, press, projection, screenOf, texts } from "./helpers/fake-browser.mjs";

globalThis.CustomEvent ??= class { constructor(type, init) { this.type = type; this.detail = init?.detail; } };
const here = path.dirname(fileURLToPath(import.meta.url));
const P = "tl-nt-panel";
const json = (value) => JSON.stringify(value);
// the shared banned words minus two that are ordinary Korean ("복원", "시간표" is not used), plus the figures this mount must never show
const BANNED = new RegExp(`${BANNED_TEXT.source.replace(/원\|/, "").replace("|시간|", "|")}|인구|수요|입주|사업성|교통량|혼잡|운임|수익`);

const pack = (over = {}) => ({
  manifest: { id: "nt-ui", version: "1", origin: [139, 35], bbox: [138, 34, 141, 36], data: { license: "CC0-1.0", attribution: [] }, ...over },
  demand: { points: [{ id: "node-inside", location: [139.007, 35.006], residents: 900, jobs: 7777 }, { id: "node-far", location: [139.05, 35.05], residents: 1, jobs: 2 }] },
});
// screen: x = (lon - 139) * 20000, y = (35.01 - lat) * 20000
const A = [[139.002, 35.002], [139.012, 35.002], [139.012, 35.008], [139.002, 35.008]]; // 60..260 x 40..160
const B = [[139.016, 35.002], [139.024, 35.002], [139.024, 35.008], [139.016, 35.008]];
const mapExport = () => ({
  plans: [{ planId: "plan:1", name: "Plan one", stationCandidates: [{ id: "stn:a", location: [139.007, 35.005] }, { id: "stn:b", location: [139.04, 35.004] }], segments: [{ id: "seg:1", alignment: [[139.014, 35.003], [139.03, 35.003]] }] }],
  externalNetworks: [{ id: "ext:1", stations: [{ id: "e1", location: [139.02, 35.005] }, { id: "e2", location: [139.02, 35.001] }], lines: [{ id: "L1", name: "Line one", stationIds: ["e1", "e2"] }] }],
});
const layers = (over = {}) => ({
  water: waterLayerFromBarriers({ barriers: [{ kind: "water", polygon: [[[139.01, 35.006], [139.014, 35.006], [139.014, 35.01], [139.01, 35.01]]] }] }, { quality: "medium", source: { name: "stub water", license: "x" } }),
  roads: roadLayerFromGeojson({ features: [{ geometry: { coordinates: [[139.005, 35.0], [139.005, 35.01]] }, properties: { roadClass: "major" } }] }, { quality: "high", source: { name: "stub roads", license: "x" } }),
  buildings: polygonLayer([{ rings: [[[139.1, 35.1], [139.101, 35.1], [139.101, 35.101], [139.1, 35.101]]], kind: "house" }], { quality: "high", source: { name: "stub buildings", license: "x" } }),
  ...over,
});

function mount({ map = mapExport(), spatial = null, p = pack(), env = browser(), ...extra } = {}) {
  const changes = [];
  const state = { map, spatial };
  const bridge = mountNewTownDevelopment({
    canvas: env.canvas, projection, pack: p, getMapExport: () => state.map, getSpatial: () => state.spatial, onChange: (out) => changes.push(out), autoRefreshMs: 0, ...extra,
  });
  return { env, bridge, changes, state };
}
const field = (env, caption, nth = 0) => {
  const label = find(panelOf(env, P), (n) => n.tag === "label" && n.className === "field" && n.children[0]?.textContent === caption)[nth];
  assert.ok(label, `field ${caption}`);
  return label.children[1];
};
const typeIn = (env, caption, value, nth = 0) => { const input = field(env, caption, nth); input.value = value; input.dispatchEvent({ type: "change" }); };
const tap = (env, point) => { let taken = false; env.canvas.dispatchEvent({ type: "pointerdown", clientX: point[0], clientY: point[1], pointerId: 1, stopImmediatePropagation() { taken = true; } }); return taken; };
const tapAt = (env, lonLat) => tap(env, screenOf(lonLat));
const moveTo = (env, point) => env.canvas.dispatchEvent({ type: "pointermove", clientX: point[0], clientY: point[1], stopImmediatePropagation() {} });
const release = (env) => env.canvas.dispatchEvent({ type: "pointerup", stopImmediatePropagation() {} });
const dbl = (env, point) => env.canvas.dispatchEvent({ type: "dblclick", clientX: point[0], clientY: point[1] });
const key = (env, k) => env.win.fire("keydown", { key: k, preventDefault() {} });
const panelText = (env) => texts(panelOf(env, P)).join("\n");
const draw = (env, ring) => { press(env, P, "다각형 그리기"); for (const pt of ring) tapAt(env, pt); press(env, P, "완료"); };
// a development with one phase whose polygon is `ring`
function started(over = {}, ring = A) {
  const m = mount(over);
  press(m.env, P, "＋ 개발 구역");
  press(m.env, P, "＋ 단계");
  draw(m.env, ring);
  return m;
}
const phaseDocs = (m) => m.bridge.output().document.developments[0].phases;
const exportPhases = (m) => m.bridge.output().export.developments[0].phases;
const dimmed = (env) => layerOf(env).calls.some((c) => c[0] === "stroke" && c[1] === "rgba(45, 212, 191, 0.4)");

test("mounting makes its own overlay, panel and style, returns exactly the six functions and an output of exactly four parts, and uses no storage", () => {
  const touched = [];
  const env = browser();
  for (const name of ["getItem", "setItem"]) { const original = env.win.localStorage[name]; env.win.localStorage[name] = (...a) => { touched.push(name); return original(...a); }; }
  const m = mount({ env });
  assert.deepEqual(Object.keys(m.bridge).sort(), ["destroy", "loadDoc", "output", "refresh", "serialize", "setEnabled"]);
  assert.deepEqual(Object.keys(m.bridge.output()), ["document", "export", "selected", "warnings"]);
  assert.ok(panelOf(env, P));
  assert.ok(env.doc.head.children.some((c) => c.id === "transitline-new-town-development-style"));
  assert.ok(hasText(env, P, SCOPE_NOTICE));
  assert.ok(hasText(env, P, "개발 구역 0곳"));
  assert.deepEqual([m.bridge.output().selected, m.bridge.output().warnings, m.bridge.output().export.developments], [null, [], []]);
  press(env, P, "＋ 개발 구역");
  press(env, P, "＋ 단계");
  m.bridge.serialize();
  m.bridge.loadDoc(m.bridge.serialize());
  assert.deepEqual(touched, [], "nothing was read from or written to the browser storage");
  m.bridge.destroy();
  assert.equal(panelOf(env, P), undefined);
});

test("create a development and a phase, draw the polygon by clicking, finish it (button, Enter), cancel it (button, Esc), and refuse fewer than three points", () => {
  const m = mount();
  const { env } = m;
  press(env, P, "＋ 개발 구역");
  assert.deepEqual(m.bridge.output().selected && [m.bridge.output().selected.developmentKey, m.bridge.output().selected.phaseKey], ["town-1", null]);
  assert.ok(hasText(env, P, "신도시 1"));
  press(env, P, "＋ 단계");
  assert.equal(m.bridge.output().selected.phaseKey, "phase-1");
  assert.equal(tap(env, [500, 500]), false, "a click on nothing goes on to the map");
  press(env, P, "다각형 그리기");
  assert.equal(m.bridge.output().selected.mode, "draw");
  assert.ok(hasText(env, P, "찍은 점 0개"));
  assert.equal(tap(env, screenOf(A[0])), true, "while drawing every click is taken");
  assert.equal(tapAt(env, A[1]), true);
  assert.ok(hasText(env, P, "찍은 점 2개"));
  press(env, P, "완료");
  assert.ok(hasText(env, P, "다각형은 점이 3개 이상이어야 합니다"));
  assert.equal(m.bridge.output().selected.mode, "draw", "refused: still drawing");
  assert.equal(phaseDocs(m)[0].polygon, null);
  tapAt(env, A[2]);
  key(env, "Backspace");
  assert.ok(hasText(env, P, "찍은 점 2개"));
  tapAt(env, A[2]);
  tapAt(env, A[3]);
  key(env, "Enter");
  assert.equal(m.bridge.output().selected.mode, null);
  assert.equal(phaseDocs(m)[0].polygon.length, 4);
  assert.ok(Math.abs(phaseDocs(m)[0].polygon[0][0] - 139.002) < 1e-9);
  assert.ok(Math.abs(exportPhases(m)[0].areaSquareMeters - 609_000) < 6_000, `${exportPhases(m)[0].areaSquareMeters}`); // 0.01 x 0.006 degrees at latitude 35
  // cancel by button and by Escape: the polygon stays as it was
  const before = json(phaseDocs(m)[0].polygon);
  press(env, P, "다시 그리기");
  tapAt(env, B[0]);
  press(env, P, "취소");
  assert.equal(json(phaseDocs(m)[0].polygon), before);
  press(env, P, "다시 그리기");
  tapAt(env, B[0]);
  key(env, "Escape");
  assert.equal(m.bridge.output().selected.mode, null);
  assert.equal(json(phaseDocs(m)[0].polygon), before);
  // redrawing replaces the polygon and keeps the key and the id
  const id = exportPhases(m)[0].phaseId;
  press(env, P, "다시 그리기");
  for (const pt of B) tapAt(env, pt);
  key(env, "Enter");
  assert.equal(exportPhases(m)[0].phaseId, id);
  assert.ok(Math.abs(phaseDocs(m)[0].polygon[0][0] - 139.016) < 1e-9);
});

test("vertices: pick one by clicking, drag it, insert one by double-clicking an edge, delete with Delete or the button, and never go below three", () => {
  const m = started();
  const { env } = m;
  const area = () => exportPhases(m)[0].areaSquareMeters;
  const before = area();
  assert.equal(tap(env, screenOf(A[1])), true, "a vertex of the picked phase is taken");
  assert.equal(m.bridge.output().selected.vertexIndex, 1);
  moveTo(env, [340, 160]);
  assert.ok(Math.abs(phaseDocs(m)[0].polygon[1][0] - 139.017) < 1e-9, "the document follows the drag");
  assert.equal(area(), before, "the facts are rebuilt when the drag ends");
  release(env);
  assert.ok(area() > before * 1.15, `${area()} vs ${before}`);
  assert.equal(phaseDocs(m)[0].polygon.length, 4);
  // an edge: double-click away from every vertex
  dbl(env, [300, 100]); // the middle of the edge from the dragged vertex (340, 160) to (260, 40)
  assert.equal(phaseDocs(m)[0].polygon.length, 5);
  assert.equal(m.bridge.output().selected.vertexIndex, 2);
  key(env, "Delete");
  assert.equal(phaseDocs(m)[0].polygon.length, 4);
  assert.equal(m.bridge.output().selected.vertexIndex, null);
  dbl(env, screenOf(A[0])); // on a vertex: no insertion
  assert.equal(phaseDocs(m)[0].polygon.length, 4);
  tap(env, screenOf(A[0]));
  press(env, P, "점 삭제");
  assert.equal(phaseDocs(m)[0].polygon.length, 3);
  tap(env, screenOf(phaseDocs(m)[0].polygon[0]));
  key(env, "Delete");
  assert.equal(phaseDocs(m)[0].polygon.length, 3, "refused: a polygon needs three");
  assert.ok(m.bridge.output().warnings.some((w) => w.code === "new-town-edit-refused" && /at least three/.test(w.message)));
  assert.ok(hasText(env, P, "편집이 거절되었습니다"));
  // a click on nothing leaves the selection; the vertex step of Escape comes before the phase's
  key(env, "Escape");
  assert.equal(m.bridge.output().selected.vertexIndex, null);
  assert.equal(m.bridge.output().selected.phaseKey, "phase-1");
  key(env, "Escape");
  assert.equal(m.bridge.output().selected.phaseKey, null);
  assert.equal(m.bridge.output().selected.developmentKey, "town-1");
  key(env, "Escape");
  assert.equal(m.bridge.output().selected, null);
});

test("clicking a phase selects it (the one drawn last wins where they overlap); a click outside every phase is left to the map", () => {
  const m = started();
  const { env } = m;
  press(env, P, "＋ 단계");
  draw(env, B);
  press(env, P, "＋ 단계");
  draw(env, [[139.008, 35.004], [139.02, 35.004], [139.02, 35.006], [139.008, 35.006]]); // overlaps A and B
  key(env, "Escape");
  key(env, "Escape");
  assert.equal(tap(env, screenOf([139.004, 35.003])), true);
  assert.equal(m.bridge.output().selected.phaseKey, "phase-1");
  assert.equal(tap(env, screenOf([139.022, 35.003])), true);
  assert.equal(m.bridge.output().selected.phaseKey, "phase-2");
  assert.equal(tap(env, screenOf([139.009, 35.005])), true, "inside the overlap: the later phase");
  assert.equal(m.bridge.output().selected.phaseKey, "phase-3");
  assert.equal(tap(env, [900, 900]), false);
  assert.equal(m.bridge.output().selected.phaseKey, "phase-3", "an untaken click does not change the selection");
  assert.ok(exportPhases(m)[2].spatialFlags.includes("overlaps-other-phase"));
});

test("phases reorder with the arrows: the sequence changes and the keys and ids do not", () => {
  const m = started();
  const { env } = m;
  press(env, P, "＋ 단계");
  draw(env, B);
  const ids = Object.fromEntries(exportPhases(m).map((p) => [p.key, p.phaseId]));
  assert.deepEqual(exportPhases(m).map((p) => [p.key, p.sequence]), [["phase-1", 1], ["phase-2", 2]]);
  press(env, P, "▲", 0); // the first cannot go up
  assert.deepEqual(exportPhases(m).map((p) => p.key), ["phase-1", "phase-2"]);
  press(env, P, "▼", 0);
  assert.deepEqual(exportPhases(m).map((p) => [p.key, p.sequence]), [["phase-2", 1], ["phase-1", 2]]);
  assert.deepEqual(Object.fromEntries(exportPhases(m).map((p) => [p.key, p.phaseId])), ids);
  assert.ok(hasText(env, P, "1. 단계 2"));
  press(env, P, "▲", 1);
  assert.deepEqual(exportPhases(m).map((p) => p.key), ["phase-1", "phase-2"]);
  press(env, P, "▼", 1); // the last cannot go down
  assert.deepEqual(exportPhases(m).map((p) => p.key), ["phase-1", "phase-2"]);
});

test("switching off is never hiding: a phase or a development stays on the map, faint and dashed, keeps its facts, and comes back as it was", () => {
  const m = started();
  const { env } = m;
  const before = json(m.bridge.output().export);
  layerOf(env).calls.length = 0;
  press(env, P, "단계 비활성");
  assert.equal(phaseDocs(m)[0].active, false);
  assert.equal(exportPhases(m)[0].active, false);
  assert.equal(exportPhases(m)[0].areaSquareMeters > 0, true, "its facts are still there");
  assert.ok(dimmed(env), "drawn with the faint stroke");
  assert.ok(layerOf(env).calls.some((c) => c[0] === "setLineDash" && json(c[2]) === "[3,4]"), "and dashed");
  assert.ok(layerOf(env).calls.some((c) => c[0] === "fillText" && /\(비활성\)/.test(c[2])), "its label says so");
  assert.ok(hasText(env, P, "(비활성)"));
  assert.ok(hasButton(env, P, "단계 복원"));
  press(env, P, "단계 복원");
  assert.equal(json(m.bridge.output().export), before);
  layerOf(env).calls.length = 0;
  press(env, P, "구역 비활성");
  assert.equal(m.bridge.output().document.developments[0].active, false);
  assert.ok(dimmed(env));
  assert.ok(hasText(env, P, "(비활성) · 단계 1"));
  assert.equal(tap(env, screenOf([139.004, 35.003])), true, "a switched-off phase can still be picked");
  press(env, P, "구역 복원");
  layerOf(env).calls.length = 0;
  key(env, "Escape");
  assert.equal(dimmed(env), false);
  assert.equal(json(m.bridge.output().export), before);
});

test("names, land use and delivery order are declared as the player writes them; unstated stays null, a bad value is refused and changes nothing", () => {
  const m = started();
  const { env } = m;
  assert.deepEqual([exportPhases(m)[0].playerDeclaredLandUse, exportPhases(m)[0].playerDeclaredDeliveryOrder], [null, null]);
  assert.ok(hasText(env, P, "선언한 용도: 미상 (말하지 않음)"));
  const id = exportPhases(m)[0].phaseId;
  const revision = exportPhases(m)[0].phaseRevision;
  typeIn(env, "단계 이름", "첫 단계");
  typeIn(env, "구역 이름", "내 신도시");
  assert.deepEqual([phaseDocs(m)[0].name, m.bridge.output().document.developments[0].name, exportPhases(m)[0].phaseRevision, exportPhases(m)[0].phaseId], ["첫 단계", "내 신도시", revision, id], "a name is not part of an id or a revision");
  typeIn(env, "용도 선언", "housing");
  assert.equal(exportPhases(m)[0].playerDeclaredLandUse, "housing");
  press(env, P, "복합");
  assert.equal(exportPhases(m)[0].playerDeclaredLandUse, "mixed");
  typeIn(env, "용도 선언", "달 기지");
  assert.equal(exportPhases(m)[0].playerDeclaredLandUse, "달 기지", "any word, as written");
  assert.ok(hasText(env, P, "제안 목록에 없는 용도 낱말입니다"));
  press(env, P, "용도 지우기");
  assert.equal(exportPhases(m)[0].playerDeclaredLandUse, null);
  typeIn(env, "인도 순서", "3");
  assert.equal(exportPhases(m)[0].playerDeclaredDeliveryOrder, 3);
  assert.notEqual(exportPhases(m)[0].phaseRevision, revision);
  for (const bad of ["abc", "0", "2.5", "-1"]) {
    typeIn(env, "인도 순서", bad);
    assert.equal(exportPhases(m)[0].playerDeclaredDeliveryOrder, 3, `${bad} is refused`);
  }
  assert.ok(m.bridge.output().warnings.some((w) => w.code === "new-town-edit-refused"));
  typeIn(env, "인도 순서", "");
  assert.equal(exportPhases(m)[0].playerDeclaredDeliveryOrder, null, "an empty field takes the declaration back: not stated");
  typeIn(env, "용도 선언", "x".repeat(65));
  assert.equal(phaseDocs(m)[0].playerDeclaredLandUse, null);
  assert.equal(exportPhases(m)[0].phaseId, id);
});

test("station sites and rail lines: pick them on the map or type an id; none stated, stated none and a list read differently; a reference the map lost is shown as stale", () => {
  const m = started({}, A);
  const { env } = m;
  assert.ok(hasText(env, P, "지정한 역: 미상 (말하지 않음)"));
  assert.ok(hasText(env, P, "지정한 선로: 미상 (말하지 않음)"));
  assert.deepEqual([exportPhases(m)[0].stationSiteRefs, exportPhases(m)[0].unknownReasons.stationSiteRefs], [null, "not-stated"]);
  // stations on the map
  press(env, P, "지도에서 역 고르기");
  assert.equal(m.bridge.output().selected.mode, "pick-station");
  assert.ok(layerOf(env).calls.some((c) => c[0] === "arc"), "the stations are drawn while picking");
  assert.equal(tap(env, [700, 500]), true, "while picking every click is taken");
  assert.equal(phaseDocs(m)[0].stationRefs, null, "a click near nothing picks nothing");
  assert.equal(tapAt(env, [139.007, 35.005]), true);
  assert.deepEqual(phaseDocs(m)[0].stationRefs, [{ stationId: "stn:a", stationKind: "plan" }]);
  tapAt(env, [139.007, 35.005]);
  assert.equal(phaseDocs(m)[0].stationRefs.length, 1, "the same station twice is one");
  tapAt(env, [139.02, 35.005]);
  assert.deepEqual(phaseDocs(m)[0].stationRefs.map((r) => [r.stationId, r.stationKind]), [["stn:a", "plan"], ["e1", "external"]]);
  press(env, P, "고르기 끝내기");
  assert.equal(m.bridge.output().selected.mode, null);
  assert.deepEqual(exportPhases(m)[0].stationSiteRefs.map((s) => [s.stationId, s.insideArea]), [["e1", false], ["stn:a", true]]);
  // typed ids
  typeIn(env, "역 ID 입력", "stn:b");
  press(env, P, "역 ID로 추가");
  assert.equal(phaseDocs(m)[0].stationRefs.length, 3);
  typeIn(env, "역 ID 입력", "nowhere");
  press(env, P, "역 ID로 추가");
  assert.ok(hasText(env, P, "지도에서 찾을 수 없는 역 ID입니다"));
  assert.equal(phaseDocs(m)[0].stationRefs.length, 3);
  // taking them away one by one goes back to "not stated"; "none" is a statement of its own
  press(env, P, "빼기", 0); press(env, P, "빼기", 0); press(env, P, "빼기", 0);
  assert.equal(phaseDocs(m)[0].stationRefs, null);
  press(env, P, "없다고 선언", 0);
  assert.deepEqual(phaseDocs(m)[0].stationRefs, []);
  assert.deepEqual(exportPhases(m)[0].stationSiteRefs, []);
  assert.ok(hasText(env, P, "지정한 역: 없음 (플레이어가 없다고 선언)"));
  press(env, P, "말하지 않음으로 되돌리기", 0);
  assert.equal(phaseDocs(m)[0].stationRefs, null);
  // rail lines on the map
  press(env, P, "지도에서 선로 고르기");
  assert.equal(tap(env, [900, 20]), true);
  assert.equal(phaseDocs(m)[0].railRefs, null);
  tapAt(env, [139.02, 35.0035]); // near the existing line (x = 400) and the planned segment (y = 140)
  assert.ok(phaseDocs(m)[0].railRefs.length >= 1);
  press(env, P, "고르기 끝내기");
  assert.ok(exportPhases(m)[0].railAccessCandidates.some((c) => c.declaredByPlayer), "the line the player named is marked as theirs");
  press(env, P, "없다고 선언", 1);
  assert.deepEqual(phaseDocs(m)[0].railRefs, []);
  assert.ok(hasText(env, P, "지정한 선로: 없음 (플레이어가 없다고 선언)"));
  press(env, P, "말하지 않음으로 되돌리기", 1);
  assert.equal(phaseDocs(m)[0].railRefs, null);
  // a station the map no longer has: stale, said so, kept
  press(env, P, "지도에서 역 고르기");
  tapAt(env, [139.007, 35.005]);
  press(env, P, "고르기 끝내기");
  m.state.map = { ...mapExport(), plans: [{ ...mapExport().plans[0], stationCandidates: [{ id: "stn:b", location: [139.04, 35.004] }] }] };
  m.bridge.refresh();
  assert.ok(hasText(env, P, "오래된 참조: 지도에서 찾을 수 없는 역입니다"));
  assert.ok(m.bridge.output().warnings.some((w) => w.code === "station-ref-missing" && w.stationId === "stn:a"));
  assert.deepEqual(phaseDocs(m)[0].stationRefs, [{ stationId: "stn:a", stationKind: "plan" }], "the player's reference stays in the document");
});

test("the facts panel keeps unknown, measured empty, measured zero and stated-none apart, shows distances and never a connection, and no node number", () => {
  const bare = started({ spatial: makeSpatialContext() });
  assert.ok(hasText(bare.env, P, "겹치는 수역 수: 미상 (레이어 없음)"));
  assert.ok(hasText(bare.env, P, "구역을 지나는 도로 수: 미상 (레이어 없음)"));
  assert.ok(hasText(bare.env, P, "도로 후보 (반경 300 m): 미상 (레이어 없음)"));
  assert.ok(hasText(bare.env, P, "지반 고도: 미상 (레이어 없음)"));
  assert.ok(hasText(bare.env, P, "레이어 결측 (레이어 없음)"));
  assert.ok(bare.bridge.output().warnings.some((w) => w.code === "layer-missing" && w.reason === "no-layer" && w.fields.includes("waterOverlapCount")));
  // layers that cover the place and hold nothing here: a measured 0 and "none found"
  const empty = started({ spatial: makeSpatialContext(layers({ water: waterLayerFromBarriers({ barriers: [{ kind: "water", polygon: [[[139.5, 35.5], [139.6, 35.5], [139.6, 35.6], [139.5, 35.6]]] }] }, { quality: "medium", source: { name: "far water", license: "x" } }), roads: roadLayerFromGeojson({ features: [{ geometry: { coordinates: [[139.5, 35.5], [139.6, 35.6]] }, properties: { roadClass: "major" } }] }, { quality: "high", source: { name: "far roads", license: "x" } }) })) });
  assert.ok(hasText(empty.env, P, "겹치는 수역 수: 0"));
  assert.ok(hasText(empty.env, P, "겹치는 건물 수: 0"));
  assert.ok(hasText(empty.env, P, "도로 후보 (반경 300 m): 없음 (측정됨)"));
  assert.ok(hasText(empty.env, P, "구역을 지나는 도로 수: 고속 0 · 간선 0 · 이면 0"));
  // a layer that does not cover the place: unknown for another reason
  const away = started({ spatial: makeSpatialContext(layers({ water: waterLayerFromBarriers({ barriers: [] }, { covers: () => false, quality: "medium", source: { name: "no coverage", license: "x" } }) })) });
  assert.ok(hasText(away.env, P, "겹치는 수역 수: 미상 (레이어 범위 밖)"));
  assert.ok(away.bridge.output().warnings.some((w) => w.code === "layer-missing" && w.reason === "outside-coverage"));
  // facts with data: overlap, roads, nodes (ids only), rail as distance
  const full = started({ spatial: makeSpatialContext(layers()) });
  const text = panelText(full.env);
  assert.match(text, /겹치는 수역 수: 1/);
  assert.match(text, /구역을 지나는 도로 수: 고속 0 · 간선 1 · 이면 0/);
  assert.match(text, /측정된 표지: .*수역과 겹침/);
  assert.match(text, /구역 안의 노드 ID \(위치만\): node-inside/);
  assert.equal(/900|7777/.test(text), false, "no number of the node is shown");
  assert.match(text, /선로 후보 \(반경 2,000 m\)/);
  assert.match(text, /계획 구간 .* 가까이 있음 · \d/);
  assert.ok(hasText(full.env, P, RAIL_NOTICE) && hasText(full.env, P, NODE_NOTICE));
  assert.equal(/연결 가능|개통 가능|접속 가능/.test(text), false);
  // the node list that is empty is "none measured", never zero demand
  const nodeFree = started({ p: { ...pack(), demand: { points: [{ id: "n", location: [139.5, 35.5] }] } } });
  assert.ok(hasText(nodeFree.env, P, "구역 안의 노드 ID (위치만): 없음 (측정됨)"));
  const noNodes = started({ p: { ...pack(), demand: { points: [] } } });
  assert.ok(hasText(noNodes.env, P, "구역 안의 노드 ID (위치만): 미상 (팩에 노드 기록 없음)"));
  // a phase without a polygon: everything about it is unknown, not zero
  const none = mount();
  press(none.env, P, "＋ 개발 구역");
  press(none.env, P, "＋ 단계");
  assert.ok(hasText(none.env, P, "면적: 미상 (다각형 없음)"));
  assert.ok(hasText(none.env, P, "겹치는 수역 수: 미상 (다각형 없음)"));
  assert.ok(hasText(none.env, P, "다각형이 없습니다 (미상)."));
  // the development as a whole, before any phase is picked
  key(none.env, "Escape");
  assert.ok(hasText(none.env, P, "활성 단계 면적의 합 (겹침은 두 번 셈): 미상 (다각형 없는 활성 단계가 있음)"));
});

test("serialize and loadDoc: the document comes back with the same ids; another pack, an unreadable or an unknown version is refused and the current document stays", () => {
  const a = started({ spatial: makeSpatialContext(layers()) });
  press(a.env, P, "＋ 단계");
  draw(a.env, B);
  typeIn(a.env, "용도 선언", "housing");
  press(a.env, P, "＋ 단계");
  press(a.env, P, "단계 삭제", 2);
  const text = a.bridge.serialize();
  assert.equal(typeof text, "string");
  const same = mount({ spatial: makeSpatialContext(layers()) });
  assert.deepEqual(same.bridge.loadDoc(text), []);
  assert.equal(json(same.bridge.output().document), json(a.bridge.output().document));
  assert.equal(json(same.bridge.output().export), json(a.bridge.output().export));
  assert.equal(same.bridge.output().selected, null, "a loaded document starts with nothing picked");
  assert.deepEqual(same.bridge.output().export.developments[0].phases.map((p) => p.phaseId), a.bridge.output().export.developments[0].phases.map((p) => p.phaseId));
  tap(same.env, screenOf([139.004, 35.003]));
  assert.ok(hasText(same.env, P, "삭제한 단계 key 1개는 다시 쓰지 않습니다."));
  // an object works as well as a string
  const fromObject = mount();
  assert.deepEqual(fromObject.bridge.loadDoc(JSON.parse(text)), []);
  assert.equal(fromObject.bridge.serialize(), text);
  // another pack's document
  const other = mount({ p: pack({ id: "another-pack" }) });
  press(other.env, P, "＋ 개발 구역");
  const mineBefore = other.bridge.serialize();
  const warned = other.bridge.loadDoc(text);
  assert.deepEqual(warned, [{ code: "new-town-doc-other-pack", savedPackId: "nt-ui" }]);
  assert.equal(other.bridge.serialize(), mineBefore, "the document being edited was not touched");
  assert.ok(hasText(other.env, P, "다른 팩의 저장 문서라 불러오지 않았습니다"));
  assert.ok(other.bridge.output().warnings.some((w) => w.code === "new-town-doc-other-pack"));
  assert.deepEqual(other.bridge.loadDoc("{ not json").map((w) => w.code), ["new-town-doc-unreadable"]);
  assert.deepEqual(other.bridge.loadDoc(JSON.stringify({ ...JSON.parse(text), version: 9 })).map((w) => w.code), ["new-town-doc-version"]);
  assert.equal(other.bridge.serialize(), mineBefore);
  assert.deepEqual(other.bridge.loadDoc(null), []);
  // the same pack at another version: loaded, and said
  const newer = mount({ p: pack({ version: "2" }) });
  assert.deepEqual(newer.bridge.loadDoc(text).map((w) => w.code), ["pack-version-mismatch"]);
  assert.ok(hasText(newer.env, P, "저장 문서와 팩 버전이 다릅니다"));
  assert.equal(newer.bridge.output().document.developments.length, 1);
});

test("ids stay with the key: renaming, reordering, redrawing and moving keep them, and a removed key is never given out again", () => {
  const m = started();
  const { env } = m;
  const dev = keyedDevelopmentId("nt-ui", "town-1");
  assert.equal(m.bridge.output().export.developments[0].developmentId, dev);
  assert.equal(exportPhases(m)[0].phaseId, keyedPhaseId(dev, "phase-1"));
  const revision = m.bridge.output().export.developments[0].developmentRevision;
  typeIn(env, "구역 이름", "다른 이름");
  assert.equal(m.bridge.output().export.developments[0].developmentRevision, revision);
  tap(env, screenOf(A[2]));
  moveTo(env, [280, 30]);
  release(env);
  assert.equal(exportPhases(m)[0].phaseId, keyedPhaseId(dev, "phase-1"));
  assert.notEqual(m.bridge.output().export.developments[0].developmentRevision, revision, "a moved vertex changes the revision, not the id");
  // phases
  press(env, P, "＋ 단계");
  press(env, P, "단계 삭제", 1);
  assert.ok(hasText(env, P, "삭제한 단계 key 1개는 다시 쓰지 않습니다."));
  press(env, P, "＋ 단계");
  assert.deepEqual(phaseDocs(m).map((p) => [p.key, p.deleted]), [["phase-1", false], ["phase-2", true], ["phase-3", false]]);
  // developments
  press(env, P, "구역 삭제", 0);
  assert.equal(m.bridge.output().selected, null);
  assert.ok(hasText(env, P, "삭제한 개발 구역 key 1개는 다시 쓰지 않습니다."));
  press(env, P, "＋ 개발 구역");
  assert.deepEqual(m.bridge.output().document.developments.map((d) => [d.key, d.deleted]), [["town-1", true], ["town-2", false]]);
  assert.equal(m.bridge.output().export.developments.length, 1);
  assert.equal(m.bridge.output().export.developments[0].developmentId, keyedDevelopmentId("nt-ui", "town-2"));
});

test("the inputs are only read: frozen map export, layers and pack work, nothing is changed, and nothing of the output is shared", () => {
  const map = deepFreeze(mapExport());
  const frozenLayers = layers();
  for (const l of Object.values(frozenLayers)) deepFreeze(l.items);
  const p = deepFreeze(pack());
  const before = json([map, p, Object.values(frozenLayers).map((l) => l.items)]);
  const m = started({ map, p, spatial: makeSpatialContext(frozenLayers) });
  press(m.env, P, "지도에서 역 고르기");
  tapAt(m.env, [139.007, 35.005]);
  press(m.env, P, "고르기 끝내기");
  m.bridge.refresh();
  assert.equal(json([map, p, Object.values(frozenLayers).map((l) => l.items)]), before);
  // the output is its own copy
  const out = m.bridge.output();
  out.document.developments[0].phases[0].polygon.length = 0;
  out.export.developments.length = 0;
  out.warnings.length = 0;
  if (out.selected) out.selected.phase = null;
  assert.equal(m.bridge.output().document.developments[0].phases[0].polygon.length, 4);
  assert.equal(m.bridge.output().export.developments.length, 1);
  // loading does not keep a reference to what the host handed over
  const handed = JSON.parse(m.bridge.serialize());
  const other = mount();
  other.bridge.loadDoc(handed);
  handed.developments[0].phases[0].polygon.length = 0;
  assert.equal(other.bridge.output().document.developments[0].phases[0].polygon.length, 4);
});

test("while switched off the mount is out of the way: no panel, no overlay, clicks and keys go on to the map; switched on again it is as it was", () => {
  const m = started();
  const { env } = m;
  const before = json(m.bridge.output());
  m.bridge.setEnabled(false);
  assert.equal(panelOf(env, P).hidden, true);
  assert.equal(layerOf(env).style.display, "none");
  assert.equal(tap(env, screenOf([139.004, 35.003])), false);
  key(env, "Escape");
  key(env, "Delete");
  assert.equal(json(m.bridge.output()), before);
  m.bridge.setEnabled(true);
  assert.equal(panelOf(env, P).hidden, false);
  assert.equal(json(m.bridge.output().document), json(JSON.parse(before).document));
  // starting to draw and switching off ends the drawing
  press(env, P, "다시 그리기");
  m.bridge.setEnabled(false);
  m.bridge.setEnabled(true);
  assert.equal(m.bridge.output().selected.mode, null);
  // destroy takes everything away, listeners included
  m.bridge.destroy();
  assert.equal(panelOf(env, P), undefined);
  assert.equal(layerOf(env), undefined);
  assert.equal(tap(env, screenOf([139.004, 35.003])), false);
  for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel", "dblclick"]) assert.deepEqual(env.canvas.listeners[type] ?? [], [], type);
});

test("the host is told once per change and not at all when nothing changed; the event carries the same output", () => {
  const m = mount();
  const events = [];
  m.env.canvas.addEventListener(NEW_TOWN_UI_EVENT, (e) => events.push(e.detail));
  m.bridge.refresh();
  m.env.win.fire("resize", {});
  const idle = m.changes.length;
  m.env.win.fire("resize", {});
  assert.equal(m.changes.length, idle, "nothing changed, nothing announced");
  press(m.env, P, "＋ 개발 구역");
  assert.ok(m.changes.length > idle);
  assert.deepEqual(Object.keys(m.changes.at(-1)), ["document", "export", "selected", "warnings"]);
  assert.equal(json(events.at(-1)), json(m.changes.at(-1)));
  assert.equal(m.changes.at(-1).document.developments.length, 1);
});

test("nothing on the panel or in the output is a figure of people, demand, cost, traffic or a verdict, and the mount imports no management and no storage", () => {
  const m = started({ spatial: makeSpatialContext(layers()) });
  const { env } = m;
  const seen = [panelText(env)];
  typeIn(env, "용도 선언", "housing");
  typeIn(env, "인도 순서", "2");
  press(env, P, "지도에서 역 고르기");
  tapAt(env, [139.007, 35.005]);
  seen.push(panelText(env));
  press(env, P, "고르기 끝내기");
  press(env, P, "지도에서 선로 고르기");
  seen.push(panelText(env));
  press(env, P, "고르기 끝내기");
  press(env, P, "＋ 단계");
  draw(env, B);
  press(env, P, "단계 비활성", 1);
  seen.push(panelText(env));
  key(env, "Escape");
  key(env, "Escape");
  seen.push(panelText(env));
  for (const t of seen) { const found = t.match(BANNED); assert.equal(found, null, `banned word ${found?.[0]}`); }
  const keys = [];
  const walk = (value) => { if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) { keys.push(k); walk(v); } };
  walk(m.bridge.output());
  const banned = new Set(["population", "residents", "jobs", "demand", "cost", "price", "score", "rank", "feasibility", "occupancy", "revenue", "duration", "schedule", "traffic", "ridership"]);
  assert.deepEqual(keys.filter((k) => !/^(demandNodeRefsInside|nearestDemandNode)$/.test(k) && k.split(/(?=[A-Z])|-/).some((w) => banned.has(w.toLowerCase()))), []);
  for (const file of ["new-town-development-ui.mjs", "new-town-development-view.mjs", "new-town-development-panel.mjs", "new-town-development-tools.mjs"]) {
    const src = fs.readFileSync(path.join(here, "..", "src", "map", file), "utf8");
    assert.ok(src.length < 40_000, `${file} holds code, not data`);
    for (const imp of src.matchAll(/from "([^"]+)"/g)) assert.match(imp[1], /^\.\/[a-z-]+\.mjs$/, `${file} imports ${imp[1]}`);
    const code = src.replace(/\/\/.*$/gm, "");
    assert.equal(/management|scenario-runtime|main\.mjs/.test(code), false, file);
    assert.equal(/localStorage|sessionStorage|indexedDB|Date\.now|new Date|Math\.random|node:fs|fetch\(/.test(code), false, file);
    assert.equal(/ledger|\.commit\(|\.settle\(|\.post\(/.test(code), false, file);
  }
});
