import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildServicePlanWorld } from "../../scripts/lib/service-plan-world.mjs";
import { buildServicePlanExport, keyedServicePlanId } from "../src/map/service-plan-geometry.mjs";
import { mountServicePlanEditor, SERVICE_PLAN_STORAGE_PREFIX, SERVICE_PLAN_UI_EVENT } from "../src/map/service-plan-ui.mjs";
import { buildServicePlanView, drawServicePlanOverlay } from "../src/map/service-plan-view.mjs";
import { hitSection, hitStation, parseNumber, showValue, stationsOf } from "../src/map/service-plan-tools.mjs";
import { BANNED_TEXT, browser, deepFreeze, find, hasText, panelOf, press, projection, screenOf, texts } from "./helpers/fake-browser.mjs";

globalThis.CustomEvent ??= class { constructor(type, init) { this.type = type; this.detail = init?.detail; } };
const here = path.dirname(fileURLToPath(import.meta.url));
const CLS = "tl-plan-panel";
const W = buildServicePlanWorld("base");
const NEXT = buildServicePlanWorld("next");
const BARE = buildServicePlanWorld("bare");
// the shared banned words minus "시간"/"용량" (a time band and the capacity application are what this editor is about), plus the computed things this editor must never claim
const BANNED = new RegExp(`${BANNED_TEXT.source.replace("|시간|용량|", "|")}|시간표|운임|수요|혼잡|승객|수익|정시|소요`);

function mount(world = W, { apps = world.applications, geometries = world.geometries, catalogs = true, ...rest } = {}, env = browser()) {
  let g = geometries;
  let a = apps;
  const changes = [];
  const bridge = mountServicePlanEditor({
    canvas: env.canvas, projection, pack: world.pack, getRailGeometries: () => g, getApplications: () => a,
    getVehicleModels: catalogs ? () => world.vehicleModels : null, getDepots: catalogs ? () => world.depots : null, onChange: (o) => changes.push(o), autoRefreshMs: 0, ...rest,
  });
  return { env, bridge, changes, set(next) { if (next.geometries) g = next.geometries; if (next.apps) a = next.apps; bridge.refresh(); } };
}
const panelText = (env) => texts(panelOf(env, CLS)).join("\n");
const controlOf = (env, caption, nth = 0) => {
  const label = find(panelOf(env, CLS), (n) => n.tag === "label" && n.children[0]?.textContent === caption)[nth];
  assert.ok(label, `field ${caption}`);
  return label.children[1];
};
const setField = (env, caption, value, nth = 0) => { const c = controlOf(env, caption, nth); c.value = value; c.dispatchEvent({ type: c.tag === "select" ? "change" : "input" }); };
const hit = (env, point) => { let taken = false; env.canvas.dispatchEvent({ type: "pointerdown", clientX: point[0], clientY: point[1], stopImmediatePropagation() { taken = true; } }); return taken; };
const clickAt = (env, lonLat) => hit(env, screenOf(lonLat));
const mid = (section) => { const [a, b] = [section.startLocation, section.endLocation]; return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; };
const saved = (env, world = W) => JSON.parse(env.storage.get(`${SERVICE_PLAN_STORAGE_PREFIX}${world.pack.manifest.id}`));
const layerOf = (env) => env.canvas.parentNode.children.find((c) => c.tag === "canvas" && c !== env.canvas);
const layerCalls = (env) => layerOf(env).calls ?? [];
const planWithRoute = (m, world = W) => { const key = m.bridge.createPlan(); m.bridge.addSection(world.A0.sectionId); m.bridge.addSection(world.A1.sectionId); return key; };

test("mounting makes its own overlay, panel and style, shows the notice and hides with setEnabled(false)", () => {
  const m = mount();
  const panel = panelOf(m.env, CLS);
  assert.ok(panel);
  assert.ok(m.env.doc.head.children.some((c) => c.id === "transitline-service-plan-style"));
  assert.ok(hasText(m.env, CLS, "요청한 값이며, 그대로 운행된다는 뜻이 아닙니다"));
  assert.equal(panel.hidden, false);
  m.bridge.setEnabled(false);
  assert.equal(panel.hidden, true);
  m.bridge.setEnabled(true);
  m.bridge.destroy();
  assert.equal(panelOf(m.env, CLS), undefined);
});

test("one geometry is chosen by itself, several are not; a plan cannot be made before a geometry is chosen", () => {
  const one = mount();
  assert.equal(one.bridge.output().geometryId, W.G.railGeometryId);
  assert.ok(hasText(one.env, CLS, "현재"));
  const other = { ...W.G, railGeometryId: "rail-geometry:other", name: "Other" };
  const two = mount(W, { geometries: [W.G, other] });
  assert.equal(two.bridge.output().geometryId, null);
  assert.equal(two.bridge.createPlan(), null);
  assert.ok(two.bridge.output().warnings.some((w) => w.code === "service-plan-no-geometry-selected"));
  assert.equal(two.bridge.selectGeometry(W.G.railGeometryId), true);
  assert.equal(two.bridge.createPlan(), "plan-1");
  assert.equal(mount(W, { geometries: [] }).bridge.createPlan(), null);
  assert.ok(hasText(mount(W, { geometries: null }).env, CLS, "고를 수 있는 철도 용량 지도가 없습니다"));
});

test("creating a plan from the panel records the geometry revision, selects it and saves it", () => {
  const m = mount();
  setField(m.env, "이름", "Line A");
  press(m.env, CLS, "새 계획 만들기");
  const out = m.bridge.output();
  assert.equal(out.selectedKey, "plan-1");
  assert.equal(out.document.plans[0].name, "Line A");
  assert.equal(out.document.plans[0].designedRailGeometryRevision, W.G.railGeometryRevision);
  assert.equal(out.selected.servicePlanId, keyedServicePlanId(W.pack.manifest.id, "plan-1"));
  assert.equal(out.selected.revision.state, "current");
  assert.equal(saved(m.env).plans[0].key, "plan-1");
  assert.ok(hasText(m.env, CLS, "저장됨"));
  assert.ok(hasText(m.env, CLS, "구간을 아직 고르지 않았습니다"));
});

test("choosing an application connects the plan to its line; no application or a stale one is told apart", () => {
  const none = mount(W, { apps: [] });
  none.bridge.createPlan();
  assert.ok(hasText(none.env, CLS, "이 지도에 적용된 용량 적용 결과가 없습니다"));
  assert.ok(hasText(none.env, CLS, "운영 노선(용량 적용 결과)을 연결하지 않았습니다"));
  const m = mount();
  m.bridge.createPlan();
  assert.ok(hasText(m.env, CLS, "운영 노선(용량 적용 결과)을 연결하지 않았습니다"));
  setField(m.env, "용량 적용 결과", "line:1");
  assert.equal(m.bridge.output().document.plans[0].operationalLineId, "line:1");
  assert.equal(m.bridge.output().selected.capacityApplicationState, "current");
  assert.equal(hasText(m.env, CLS, "운영 노선(용량 적용 결과)을 연결하지 않았습니다"), false);
  // the geometry changes under an application made for the older one
  m.bridge.addSection(W.A0.sectionId);
  m.set({ geometries: NEXT.geometries });
  assert.equal(m.bridge.output().selected.capacityApplicationState, "stale");
  assert.ok(hasText(m.env, CLS, "낡음 (지도가 바뀜)"));
  assert.ok(hasText(m.env, CLS, "연결한 용량 적용 결과가 현재 지도보다 낡았습니다"));
  assert.equal(m.bridge.output().selected.route.sections[0].trackSegmentId, null);
});

test("sections are picked on the map in order; a second click takes one out; a click on nothing goes on to the map", () => {
  const m = mount();
  m.bridge.createPlan();
  assert.equal(clickAt(m.env, mid(W.A0)), false); // no mode yet
  press(m.env, CLS, "지도에서 구간 고르기");
  assert.equal(m.bridge.mode, "pick-section");
  assert.ok(hasText(m.env, CLS, "지도에서 노선 구간을 순서대로 클릭하세요"));
  assert.equal(clickAt(m.env, mid(W.A1)), true);
  assert.equal(clickAt(m.env, mid(W.A0)), true);
  assert.deepEqual(m.bridge.output().document.plans[0].route.sectionIds, [W.A1.sectionId, W.A0.sectionId]);
  assert.equal(clickAt(m.env, [139.005, 35.02]), false); // far from every section
  assert.equal(clickAt(m.env, mid(W.A1)), true); // picked again: out
  assert.deepEqual(m.bridge.output().document.plans[0].route.sectionIds, [W.A0.sectionId]);
  assert.equal(clickAt(m.env, mid(W.E1)), true); // an existing line known only station to station can be picked too
  assert.deepEqual(m.bridge.output().document.plans[0].route.sectionIds, [W.A0.sectionId, W.E1.sectionId]);
});

test("the route can be reversed, reordered, shortened and emptied; the plan id never moves", () => {
  const m = mount();
  planWithRoute(m);
  const id = m.bridge.output().selected.servicePlanId;
  assert.deepEqual(m.bridge.output().selected.route.stationIds, [W.stations.a0, W.stations.a1, W.stations.a2]);
  press(m.env, CLS, "노선 반전");
  assert.deepEqual(m.bridge.output().document.plans[0].route.sectionIds, [W.A1.sectionId, W.A0.sectionId]);
  assert.deepEqual(m.bridge.output().selected.route.stationIds, [W.stations.a2, W.stations.a1, W.stations.a0]);
  press(m.env, CLS, "▲");
  assert.deepEqual(m.bridge.output().document.plans[0].route.sectionIds, [W.A0.sectionId, W.A1.sectionId]);
  press(m.env, CLS, "삭제", 1); // the first 삭제 in the panel belongs to the plan row, the second to the first section
  assert.deepEqual(m.bridge.output().document.plans[0].route.sectionIds, [W.A1.sectionId]);
  assert.equal(m.bridge.output().selected.servicePlanId, id);
  press(m.env, CLS, "구간 모두 비우기");
  assert.equal(m.bridge.output().document.plans[0].route, null);
  assert.ok(hasText(m.env, CLS, "구간을 아직 고르지 않았습니다"));
});

test("directions: both ways, one way, by hand; a duplicate is refused; without a readable route the quick buttons say why", () => {
  const m = mount();
  m.bridge.createPlan();
  press(m.env, CLS, "양방향 만들기");
  assert.ok(m.bridge.output().warnings.some((w) => w.code === "service-plan-route-ends-unknown"));
  assert.ok(hasText(m.env, CLS, "시작·끝 역을 읽을 수 없어"));
  m.bridge.addSection(W.A0.sectionId);
  m.bridge.addSection(W.A1.sectionId);
  press(m.env, CLS, "정방향만");
  press(m.env, CLS, "역방향만");
  assert.deepEqual(m.bridge.output().document.plans[0].directions.map((d) => [d.fromStationId, d.toStationId]), [[W.stations.a0, W.stations.a2], [W.stations.a2, W.stations.a0]]);
  press(m.env, CLS, "양방향 만들기");
  assert.ok(m.bridge.output().warnings.some((w) => w.message === "Those directions are already there"));
  setField(m.env, "출발", W.stations.a0);
  setField(m.env, "도착", W.stations.a1);
  press(m.env, CLS, "방향 추가");
  assert.equal(m.bridge.output().document.plans[0].directions.length, 3);
  const built = m.bridge.output().selected.directions.find((d) => d.key === "direction-3");
  assert.deepEqual(built.orderedSectionIds, [W.A0.sectionId]);
  assert.ok(hasText(m.env, CLS, "direction-3"));
  assert.equal(m.bridge.addDirection(W.stations.a0, W.stations.a0), false);
  m.bridge.removeDirection("direction-3");
  press(m.env, CLS, "방향을 적지 않은 상태로");
  assert.equal(m.bridge.output().document.plans[0].directions, null);
  assert.ok(hasText(m.env, CLS, "방향을 적지 않았습니다"));
});

test("a time band is typed in minutes; every number is called a request; a blank is not stated; 0 stays 0", () => {
  const m = mount();
  planWithRoute(m);
  m.bridge.addDirections("both");
  setField(m.env, "시작(분)", "420");
  setField(m.env, "끝(분)", "540");
  setField(m.env, "배차 간격 요청(분)", "5");
  setField(m.env, "요청 편성 수", "0", 0);
  setField(m.env, "요청 량 수", "8", 0);
  press(m.env, CLS, "시간대 추가");
  const band = m.bridge.output().document.plans[0].serviceBands[0];
  assert.deepEqual([band.key, band.startMinute, band.endMinute, band.headwayMinutes, band.trainsets, band.formationCars], ["band-1", 420, 540, 5, 0, 8]);
  assert.deepEqual(band.directionKeys, ["direction-1", "direction-2"]);
  assert.ok(hasText(m.env, CLS, "07:00–09:00 (420–540분) · 배차 간격 요청 5분 · 요청 편성 수 0 · 요청 량 수 8"));
  // blanks are not stated (null), shown as unknown with the reason
  setField(m.env, "시작(분)", "0");
  setField(m.env, "끝(분)", "60");
  press(m.env, CLS, "시간대 추가");
  assert.ok(hasText(m.env, CLS, "배차 간격 요청 미상 (배차 요청을 적지 않음)"));
  assert.ok(hasText(m.env, CLS, "요청 편성 수 미상 (요청 편성 수를 적지 않음)"));
  assert.equal(m.bridge.output().selected.serviceBands.find((b) => b.key === "band-2").playerRequestedHeadwayMinutes, null);
  // edit, switch off, switch on, delete
  press(m.env, CLS, "수정", 0);
  assert.equal(controlOf(m.env, "끝(분)").value, "540");
  setField(m.env, "배차 간격 요청(분)", "6");
  press(m.env, CLS, "시간대 저장");
  assert.equal(m.bridge.output().document.plans[0].serviceBands[0].headwayMinutes, 6);
  press(m.env, CLS, "끄기", 1);
  assert.equal(m.bridge.output().selected.serviceBands.find((b) => b.key === "band-1").operating, false);
  assert.ok(hasText(m.env, CLS, "band-1 · 꺼짐"));
  press(m.env, CLS, "켜기", 0);
  assert.equal(m.bridge.output().selected.serviceBands.find((b) => b.key === "band-1").operating, true);
  m.bridge.removeBand("band-2");
  assert.equal(m.bridge.output().document.plans[0].serviceBands.length, 1);
});

test("a band the player mistyped is refused or flagged, never silently fixed", () => {
  const m = mount();
  planWithRoute(m);
  const before = JSON.stringify(m.bridge.output().document);
  setField(m.env, "시작(분)", "7시");
  setField(m.env, "끝(분)", "540");
  press(m.env, CLS, "시간대 추가");
  assert.equal(JSON.stringify(m.bridge.output().document), before);
  assert.ok(m.bridge.output().warnings.some((w) => w.code === "service-plan-edit-refused" && /startMinute is not a number/.test(w.message)));
  setField(m.env, "시작(분)", "");
  press(m.env, CLS, "시간대 추가");
  assert.ok(m.bridge.output().warnings.some((w) => /needs a start and an end/.test(w.message || "")));
  // a number the builder rejects (a headway of 0, a band that ends before it starts) is kept as typed and flagged in the panel
  setField(m.env, "시작(분)", "100");
  setField(m.env, "끝(분)", "200");
  setField(m.env, "배차 간격 요청(분)", "0");
  press(m.env, CLS, "시간대 추가");
  assert.equal(m.bridge.output().document.plans[0].serviceBands[0].headwayMinutes, 0);
  assert.equal(m.bridge.output().selected.serviceBands[0].playerRequestedHeadwayMinutes, null);
  assert.ok(hasText(m.env, CLS, "배차 요청 값이 올바르지 않아 비웠음"));
  m.bridge.addBand({ startMinute: 600, endMinute: 500 });
  assert.ok(hasText(m.env, CLS, "시간대의 분 범위가 올바르지 않아 뺐음"));
});

test("a turnback is picked on the map; the terminal and the turnback candidate are chosen from what the map knows", () => {
  const m = mount();
  planWithRoute(m);
  press(m.env, CLS, "지도에서 회차역 고르기");
  assert.equal(clickAt(m.env, [139.02, 35]), true);
  assert.equal(clickAt(m.env, [139, 35]), true);
  assert.equal(clickAt(m.env, [139.02, 35]), true); // the same station again: refused, not duplicated
  const tbs = m.bridge.output().document.plans[0].turnbacks;
  assert.deepEqual(tbs.map((t) => [t.key, t.stationId, t.intent]), [["turnback-1", W.stations.a2, "route-end"], ["turnback-2", W.stations.a0, "route-end"]]);
  assert.ok(m.bridge.output().warnings.some((w) => w.message === "A turnback is already there"));
  // at a2 the stated terminal data names no terminal; at a0 it names one
  assert.ok(hasText(m.env, CLS, "종착 자료에 이 역의 설비가 없음"));
  assert.ok(hasText(m.env, CLS, "이 역에 종착 설비가 있으나 고르지 않음"));
  setField(m.env, "종착 설비", W.terminalId("t-a0"), 1);
  assert.ok(hasText(m.env, CLS, "고른 종착 설비가 지도에 있음"));
  const tb2 = m.bridge.output().selected.turnbacks.find((t) => t.key === "turnback-2");
  assert.equal(tb2.facilityFacts.terminalResourceKnown, true);
  const cand = m.bridge.output().selected.terminals.find((t) => t.stationId === W.stations.a0).facilities[0].turnbackCandidates[0];
  setField(m.env, "회차 후보", cand.turnbackCandidateId, 1);
  assert.equal(m.bridge.output().document.plans[0].turnbacks[1].turnbackCandidateId, cand.turnbackCandidateId);
  setField(m.env, "종착 설비", "rail-terminal:elsewhere", 1);
  assert.ok(hasText(m.env, CLS, "고른 종착 설비가 이 역에 없음"));
  assert.ok(hasText(m.env, CLS, "rail-terminal:elsewhere (목록에 없음)"));
  assert.equal(m.bridge.output().document.plans[0].turnbacks[1].turnbackCandidateId, null); // changing the terminal drops the candidate chosen for the old one
  press(m.env, CLS, "회차 없음으로 선언");
  assert.deepEqual(m.bridge.output().document.plans[0].turnbacks, []);
  assert.ok(hasText(m.env, CLS, "회차 없음으로 선언했습니다"));
  press(m.env, CLS, "회차를 적지 않은 상태로");
  assert.equal(m.bridge.output().document.plans[0].turnbacks, null);
  assert.ok(hasText(m.env, CLS, "회차를 적지 않았습니다"));
});

test("a turnback where there is no terminal data at all is shown as unknown, not as none", () => {
  const m = mount(BARE);
  m.bridge.createPlan();
  m.bridge.addSection(BARE.A0.sectionId);
  m.bridge.addTurnback(BARE.stations.a0);
  assert.equal(m.bridge.output().view.turnbacks[0].state, "unknown");
  assert.ok(hasText(m.env, CLS, "종착 자료 없음 (미상)"));
  assert.ok(hasText(m.env, CLS, "단·복선 미상 (단·복선을 지도에 적지 않음)"));
  assert.ok(hasText(m.env, CLS, "폐색 미상 (폐색 자료 없음)"));
});

test("vehicle model, depot reference and assumptions are references and text; with no catalog they are typed", () => {
  const m = mount();
  planWithRoute(m);
  setField(m.env, "차량 모델", "vehicle-model:8-car");
  setField(m.env, "요청 량 수", "8", 1); // the second of its name: the first is the time band form
  setField(m.env, "요청 편성 수", "6", 1);
  press(m.env, CLS, "차량 저장");
  assert.deepEqual(m.bridge.output().document.plans[0].vehicleIntent, { vehicleModelId: "vehicle-model:8-car", requestedCars: 8, requestedTrainsets: 6 });
  assert.ok(hasText(m.env, CLS, "차량 모델 vehicle-model:8-car · 요청 량 수 8 · 요청 편성 수 6"));
  setField(m.env, "차량기지", "depot:north");
  setField(m.env, "연결 역", W.stations.a0);
  setField(m.env, "입·출고 구분", "pull-out");
  press(m.env, CLS, "입·출고 참조 추가");
  const dep = m.bridge.output().selected.playerInputs.depotRefs[0];
  assert.deepEqual([dep.depotSiteId, dep.role, dep.stationOnRoute], ["depot:north", "pull-out", true]);
  assert.ok(hasText(m.env, CLS, "출고"));
  press(m.env, CLS, "입·출고 참조 추가");
  assert.ok(m.bridge.output().warnings.some((w) => /needs a depot or a station/.test(w.message || "")));
  setField(m.env, "운영 가정", "  Doors open on the left  ");
  press(m.env, CLS, "가정 추가");
  assert.deepEqual(m.bridge.output().document.plans[0].assumptions.map((a) => a.text), ["Doors open on the left"]);
  m.bridge.removeAssumption("assumption-1");
  m.bridge.removeDepotRef("depot-1");
  assert.deepEqual([m.bridge.output().document.plans[0].assumptions, m.bridge.output().document.plans[0].depotRefs], [[], []]);
  m.bridge.setVehicle({ requestedCars: "many" });
  assert.ok(m.bridge.output().warnings.some((w) => /requestedCars is not a number/.test(w.message || "")));
  const typed = mount(W, { catalogs: false });
  planWithRoute(typed);
  setField(typed.env, "차량 모델 ID", "vehicle-model:custom");
  press(typed.env, CLS, "차량 저장");
  assert.equal(typed.bridge.output().document.plans[0].vehicleIntent.vehicleModelId, "vehicle-model:custom");
  setField(typed.env, "차량기지 ID", "depot:custom");
  press(typed.env, CLS, "입·출고 참조 추가");
  assert.equal(typed.bridge.output().document.plans[0].depotRefs[0].depotSiteId, "depot:custom");
});

test("plan type, operating pattern and name are the player's statements; unset is shown as unknown", () => {
  const m = mount();
  m.bridge.createPlan();
  assert.equal(m.bridge.output().selected.unknownReasons.planKind, "planKind-not-stated");
  setField(m.env, "종류", "disruption-response");
  setField(m.env, "운행 방식", "short-turn");
  assert.deepEqual([m.bridge.output().selected.planKind, m.bridge.output().selected.playerInputs.operatingPattern], ["disruption-response", "short-turn"]);
  setField(m.env, "종류", "");
  assert.equal(m.bridge.output().document.plans[0].planKind, null);
  // typing a name does not rebuild the panel under the player's hands
  const before = controlOf(m.env, "이름", 1);
  setField(m.env, "이름", "Night plan", 1);
  assert.equal(m.bridge.output().document.plans[0].name, "Night plan");
  assert.equal(controlOf(m.env, "이름", 1), before);
});

test("plans are switched off, switched on and deleted; a deleted plan keeps its number out of reach", () => {
  const m = mount();
  m.bridge.createPlan();
  m.bridge.createPlan();
  press(m.env, CLS, "끄기", 0);
  assert.ok(hasText(m.env, CLS, "plan-1 · 꺼짐"));
  assert.equal(m.bridge.output().plans.find((p) => p.key === "plan-1").active, false);
  press(m.env, CLS, "켜기", 0);
  assert.equal(m.bridge.output().plans.find((p) => p.key === "plan-1").active, true);
  press(m.env, CLS, "삭제", 1);
  assert.deepEqual(m.bridge.output().plans.map((p) => p.key), ["plan-1"]);
  assert.ok(hasText(m.env, CLS, "삭제한 계획 1건 (plan-2) — 번호는 다시 쓰지 않습니다"));
  assert.equal(m.bridge.createPlan(), "plan-3");
  assert.equal(m.bridge.selectPlan("plan-2"), false);
  assert.equal(m.bridge.selectedKey, null);
  assert.equal(saved(m.env).plans.find((p) => p.key === "plan-2").deleted, true);
});

test("the map shows the route in order, the directions, the turnbacks and the joins; a stale plan is dimmed", () => {
  const m = mount();
  planWithRoute(m);
  m.bridge.addDirections("both");
  m.bridge.addTurnback(W.stations.a0);
  const calls = layerCalls(m.env);
  assert.ok(calls.filter((c) => c[0] === "stroke" && c[1] === "#4cc9f0").length >= 2, "both route sections are stroked in the route colour");
  assert.deepEqual([...new Set(calls.filter((c) => c[0] === "fillText" && ["1", "2"].includes(c[2])).map((c) => c[2]))].sort(), ["1", "2"]);
  assert.ok(calls.some((c) => c[0] === "fillText" && c[2] === "●"), "the join of the two sections was read");
  assert.ok(calls.filter((c) => c[0] === "fill").length > 4, "direction chevrons and stations");
  assert.ok(calls.some((c) => c[0] === "fillText" && c[2] === "○"), "the turnback station has a facility the player did not pick");
  assert.equal(layerOf(m.env).ctx.globalAlpha, 1);
  m.set({ geometries: NEXT.geometries });
  assert.equal(layerOf(m.env).ctx.globalAlpha, 0.55);
  assert.ok(layerCalls(m.env).some((c) => c[0] === "stroke" && c[1] === "#ffb703"));
});

test("a section known only station to station is dashed, and an unknown join is a question mark, not a tick or a cross", () => {
  const m = mount();
  m.bridge.createPlan();
  m.bridge.addSection(W.E1.sectionId);
  m.bridge.addSection(W.E2.sectionId);
  const calls = layerCalls(m.env);
  assert.ok(calls.some((c) => c[0] === "setLineDash" && c[2].join() === "7,5"));
  assert.ok(calls.some((c) => c[0] === "fillText" && c[2] === "?"));
  assert.equal(calls.some((c) => c[0] === "fillText" && (c[2] === "●" || c[2] === "✕")), false);
  assert.ok(hasText(m.env, CLS, "선로가 이어짐 미상 (접속을 지도에서 읽을 수 없음)"));
  assert.ok(hasText(m.env, CLS, "기존선 포함 예"));
});

test("a plan made on an older geometry is stale until the player confirms it; confirming records the new revision", () => {
  const m = mount();
  planWithRoute(m);
  assert.equal(m.bridge.output().selected.revision.state, "current");
  m.set({ geometries: NEXT.geometries });
  assert.equal(m.bridge.output().selected.revision.state, "stale");
  assert.ok(hasText(m.env, CLS, "지도가 바뀐 뒤 다시 확인하지 않은 계획입니다"));
  assert.ok(hasText(m.env, CLS, "plan-1 · 지도 낡음"));
  m.bridge.setPlanField("planKind", "regular"); // editing something else does not confirm it
  assert.equal(m.bridge.output().selected.revision.state, "stale");
  press(m.env, CLS, "현재 지도로 다시 확인");
  assert.equal(m.bridge.output().selected.revision.state, "current");
  assert.equal(m.bridge.output().document.plans[0].designedRailGeometryRevision, NEXT.G.railGeometryRevision);
  assert.equal(hasText(m.env, CLS, "지도가 바뀐 뒤 다시 확인하지 않은 계획입니다"), false);
  // a plan whose geometry is gone is told so, not hidden
  m.set({ geometries: [] });
  assert.ok(hasText(m.env, CLS, "지금 지도에서 읽을 수 없습니다"));
  assert.equal(m.bridge.output().selected, null);
  assert.ok(m.bridge.output().warnings.some((w) => w.code === "service-plan-rejected"));
});

test("unknown, no, zero and declared-empty are told apart in what the map knows", () => {
  const doctored = structuredClone(W.G);
  const s0 = doctored.sections.find((s) => s.sectionId === W.A0.sectionId);
  s0.blockIds = [];
  s0.junctionResourceIds = [];
  s0.ends[1].state = false;
  s0.ends[1].joinedSectionIds = [];
  const m = mount(W, { geometries: [doctored] });
  planWithRoute(m);
  const text = panelText(m.env);
  assert.match(text, /폐색 없음\(선언됨\) · 분기기 없음\(선언됨\)/); // [] declared
  assert.match(text, /선로가 이어짐 아니오/); // false: measured apart
  assert.match(text, /단·복선 미상 \(단·복선을 지도에 적지 않음\)/); // null: not stated
  assert.match(text, /단·복선 단선/); // a stated value
  const joins = layerCalls(m.env).filter((c) => c[0] === "fillText" && ["●", "✕", "?"].includes(c[2])).map((c) => c[2]);
  assert.deepEqual(joins, ["✕"]);
  m.bridge.addBand({ startMinute: 0, endMinute: 60, trainsets: 0 });
  assert.ok(hasText(m.env, CLS, "요청 편성 수 0"));
});

test("the view model is a pure function: the same input gives the same output and nothing is changed", () => {
  const plan = { key: "k", railGeometryId: W.G.railGeometryId, designedRailGeometryRevision: W.G.railGeometryRevision, route: { sectionIds: [W.A0.sectionId, W.A1.sectionId] }, directions: [{ key: "d", fromStationId: W.stations.a0, toStationId: W.stations.a2 }], turnbacks: [{ key: "t", stationId: W.stations.a0 }] };
  const out = deepFreeze(buildServicePlanExport({ pack: W.pack, railGeometries: [W.G], applications: [W.application], plans: [plan] }).plans[0]);
  const geometry = deepFreeze(structuredClone(W.G));
  const a = buildServicePlanView({ geometry, planOut: out });
  assert.equal(JSON.stringify(buildServicePlanView({ geometry, planOut: out })), JSON.stringify(a));
  assert.equal(a.status, "plan");
  assert.deepEqual(a.sections.filter((s) => s.onRoute).map((s) => s.order), [1, 2]);
  assert.equal(buildServicePlanView().status, "no-geometry");
  assert.equal(buildServicePlanView({ geometry }).status, "no-plan");
  drawServicePlanOverlay({ save() {}, restore() {} }, null, screenOf);
  assert.equal(parseNumber(""), undefined);
  assert.equal(Number.isNaN(parseNumber("x")), true);
  assert.equal(showValue(null), "미상");
  assert.equal(showValue([]), "없음(선언됨)");
  assert.equal(showValue(0), "0");
  assert.equal(showValue(false), "아니오");
  assert.equal(hitSection(geometry, screenOf, screenOf(mid(W.A0)))?.sectionId, W.A0.sectionId);
  assert.equal(hitSection(geometry, screenOf, [5000, 5000]), null);
  assert.equal(hitStation(stationsOf(geometry), screenOf, screenOf([139.01, 35])), W.stations.a1);
});

test("the document is saved after every edit and a new mount restores the same plans with the same ids", () => {
  const first = mount();
  planWithRoute(first);
  first.bridge.addDirections("both");
  first.bridge.addBand({ startMinute: 420, endMinute: 540, headwayMinutes: 5, trainsets: 6, formationCars: 8 });
  first.bridge.deactivatePlan();
  const id = first.bridge.output().selected.servicePlanId;
  const exportBefore = JSON.stringify(first.bridge.output().export);
  const second = mount(W, {}, browser({ storage: first.env.storage }));
  assert.deepEqual(second.bridge.output().document, first.bridge.output().document);
  assert.equal(JSON.stringify(second.bridge.output().export), exportBefore);
  second.bridge.selectPlan("plan-1");
  assert.equal(second.bridge.output().selected.servicePlanId, id);
  assert.equal(second.bridge.output().selected.active, false);
  assert.equal(second.bridge.createPlan(), "plan-2");
});

test("another pack's saved document is refused, in storage and through loadDoc, and the current plans are left alone", () => {
  const other = buildServicePlanWorld("base", "someone-else");
  const writer = mount(other);
  writer.bridge.createPlan();
  const foreign = writer.bridge.serialize();
  const env = browser();
  env.storage.set(`${SERVICE_PLAN_STORAGE_PREFIX}${W.pack.manifest.id}`, foreign);
  const m = mount(W, {}, env);
  assert.equal(m.bridge.output().document.plans.length, 0);
  assert.ok(m.bridge.output().warnings.some((w) => w.code === "service-plan-doc-other-pack"));
  m.bridge.createPlan();
  const before = JSON.stringify(m.bridge.output().document);
  assert.deepEqual(m.bridge.loadDoc(foreign).map((w) => w.code), ["service-plan-doc-other-pack"]);
  assert.equal(JSON.stringify(m.bridge.output().document), before);
  assert.deepEqual(m.bridge.loadDoc("{").map((w) => w.code), ["service-plan-doc-unreadable"]);
  assert.deepEqual(m.bridge.loadDoc(JSON.stringify({ version: 9, packId: W.pack.manifest.id, plans: [] })).map((w) => w.code), ["service-plan-doc-version"]);
  assert.equal(JSON.stringify(m.bridge.output().document), before);
  // a document of this pack replaces it and is saved
  const mine = mount();
  mine.bridge.createPlan();
  mine.bridge.createPlan();
  assert.deepEqual(m.bridge.loadDoc(mine.bridge.serialize()), []);
  assert.equal(m.bridge.output().document.plans.length, 2);
  assert.equal(saved(env).plans.length, 2);
  assert.deepEqual(m.bridge.loadDoc(null), []);
  const old = JSON.parse(mine.bridge.serialize());
  old.packVersion = "0.5";
  assert.deepEqual(m.bridge.loadDoc(old).map((w) => w.code), ["pack-version-mismatch"]);
});

test("a blocked or full storage is a note, never an exception, and the editor keeps working", () => {
  const m = mount(W, {}, browser({ blocked: true }));
  assert.equal(m.bridge.createPlan(), "plan-1");
  assert.ok(m.bridge.output().warnings.some((w) => w.code === "service-plan-doc-not-saved"));
  assert.ok(hasText(m.env, CLS, "저장하지 못함"));
  assert.equal(m.bridge.addSection(W.A0.sectionId), true);
});

test("the same inputs and the same steps give the same output, ids included, on two mounts", () => {
  const run = () => {
    const m = mount();
    planWithRoute(m);
    m.bridge.addDirections("both");
    m.bridge.addBand({ startMinute: 420, endMinute: 540, headwayMinutes: 5, trainsets: 6, formationCars: 8 });
    m.bridge.addTurnback(W.stations.a0);
    m.bridge.setVehicle({ vehicleModelId: "vehicle-model:8-car", requestedCars: 8 });
    m.bridge.addAssumption("x");
    return JSON.stringify(m.bridge.output());
  };
  assert.equal(run(), run());
  const m = mount();
  planWithRoute(m);
  const plans = m.bridge.output().document.plans.map(({ seq: _s, deleted: _d, ...p }) => p);
  assert.equal(JSON.stringify(m.bridge.output().export), JSON.stringify(buildServicePlanExport({ pack: W.pack, railGeometries: [W.G], applications: [W.application], plans })));
});

test("frozen inputs are never changed and the output shares no object with them", () => {
  const geometries = deepFreeze(structuredClone(W.geometries));
  const apps = deepFreeze(structuredClone(W.applications));
  const models = deepFreeze(structuredClone(W.vehicleModels));
  const before = JSON.stringify([geometries, apps, models]);
  const env = browser();
  const m = mountServicePlanEditor({ canvas: env.canvas, projection, pack: deepFreeze(structuredClone(W.pack)), getRailGeometries: () => geometries, getApplications: () => apps, getVehicleModels: () => models, getDepots: () => deepFreeze(structuredClone(W.depots)), autoRefreshMs: 0 });
  m.createPlan();
  m.addSection(W.A0.sectionId);
  m.addSection(W.A1.sectionId);
  m.addDirections("both");
  m.addTurnback(W.stations.a0);
  assert.equal(JSON.stringify([geometries, apps, models]), before);
  const out = m.output();
  out.document.plans[0].name = "mutated";
  out.selected.route.sectionIds.push("x");
  assert.equal(m.output().document.plans[0].name, null);
  assert.equal(m.output().selected.route.sectionIds.length, 2);
});

test("odd getter results become an empty editor, not an exception", () => {
  for (const value of [null, "x", 3, {}, [null, 4, "y"], { designs: "no" }]) {
    const m = mount(W, { geometries: value, apps: value });
    assert.equal(m.bridge.createPlan(), null);
    assert.ok(panelOf(m.env, CLS).children.length > 0);
  }
  assert.equal(mount(W, { geometries: { railGeometries: W.geometries }, apps: { applications: W.applications } }).bridge.createPlan(), "plan-1");
});

test("Escape ends the mode first and then deselects; a change is announced once, as a callback and as an event", () => {
  const m = mount();
  const events = [];
  m.env.canvas.addEventListener(SERVICE_PLAN_UI_EVENT, (e) => events.push(e.detail.selectedKey));
  m.bridge.createPlan();
  const n = m.changes.length;
  m.bridge.refresh();
  m.bridge.refresh();
  assert.equal(m.changes.length, n);
  m.bridge.setMode("pick-section");
  m.env.win.fire("keydown", { key: "Escape" });
  assert.equal(m.bridge.mode, null);
  assert.equal(m.bridge.selectedKey, "plan-1");
  m.env.win.fire("keydown", { key: "Escape" });
  assert.equal(m.bridge.selectedKey, null);
  assert.ok(events.length >= 2 && events.includes("plan-1"));
  assert.equal(m.bridge.setMode("pick-section"), false); // needs a plan
  m.bridge.setEnabled(false);
  assert.equal(clickAt(m.env, mid(W.A0)), false);
});

test("the panel never states a verdict, a price, a size or a time to run: every text of every state is checked", () => {
  const all = [];
  const m = mount();
  all.push(panelText(m.env));
  planWithRoute(m);
  m.bridge.addDirections("both");
  m.bridge.addBand({ startMinute: 420, endMinute: 540, headwayMinutes: 5, trainsets: 6, formationCars: 8, label: "Peak" });
  m.bridge.addBand({ startMinute: 5, endMinute: 4 });
  m.bridge.addTurnback(W.stations.a0);
  m.bridge.addTurnback(W.stations.a2);
  m.bridge.setVehicle({ vehicleModelId: "vehicle-model:8-car", requestedCars: 8, requestedTrainsets: 6 });
  m.bridge.addDepotRef({ depotSiteId: "depot:north", stationId: W.stations.a0, role: "both" });
  m.bridge.addAssumption("note");
  m.bridge.setMode("pick-section");
  all.push(panelText(m.env));
  m.set({ geometries: NEXT.geometries });
  all.push(panelText(m.env));
  m.bridge.addSection(W.E1.sectionId);
  m.bridge.setPlanField("operationalLineId", "line:9");
  all.push(panelText(m.env));
  m.set({ geometries: [] });
  all.push(panelText(m.env));
  const bare = mount(BARE, { apps: [] });
  bare.bridge.createPlan();
  bare.bridge.addSection(BARE.A0.sectionId);
  bare.bridge.addSection(BARE.A1.sectionId);
  bare.bridge.addDirections("both");
  bare.bridge.addTurnback(BARE.stations.a0);
  all.push(panelText(bare.env));
  for (const t of all) {
    const words = t.replaceAll("용량 적용 결과", "").replaceAll("시간대", "");
    const found = words.match(BANNED);
    assert.equal(found, null, `banned word ${found?.[0]} in: ${found ? words.slice(Math.max(0, found.index - 25), found.index + 25) : ""}`);
  }
  assert.ok(all.some((t) => t.includes("요청")));
});

test("nothing the editor shows is a computed number about running the plan", () => {
  const m = mount();
  planWithRoute(m);
  m.bridge.addBand({ startMinute: 420, endMinute: 540, headwayMinutes: 5, trainsets: 6, formationCars: 8 });
  const keys = new Set();
  const walk = (v) => { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { keys.add(k); walk(x); } };
  walk(m.bridge.output());
  assert.deepEqual([...keys].filter((k) => /headway/i.test(k)).sort(), ["headwayMinutes", "playerRequestedHeadwayMinutes"]);
  assert.equal([...keys].some((k) => /^(actual|expected|achievable|feasible|cost|fare|demand|crowd|score|passenger)/i.test(k)), false);
});

test("the new map modules import no management, engine state or file system and read no clock, randomness or storage themselves", () => {
  for (const file of ["service-plan-tools", "service-plan-view", "service-plan-panel", "service-plan-ui"]) {
    const src = fs.readFileSync(path.join(here, "..", "src", "map", `${file}.mjs`), "utf8");
    assert.ok(src.length < 40_000, `${file} holds code, not data`);
    for (const m of src.matchAll(/from "([^"]+)"/g)) assert.match(m[1], /^\.\/[a-z-]+\.mjs$/, `${file} imports ${m[1]}`);
    assert.equal(/from\s+["'][^"']*management/.test(src), false, file);
    assert.equal(/from\s+["'][^"']*(scenario-runtime|state|trains|game|passengers|access-demand|rail-capacity-integration|service-plan-adapter)\.mjs/.test(src), false, file);
    assert.equal(/ledger|\.commit\(|\.settle\(|\.post\(|node:fs|Date\.now|new Date|Math\.random|performance\.now|setTimeout|localStorage|sessionStorage|indexedDB|fetch\(/.test(src.replace(/\/\/.*$/gm, "")), false, file);
  }
});

test("a stand-in engine state is unchanged after mounting, editing, saving and restoring", () => {
  const state = deepFreeze({ cash: 1_000_000, ledger: [{ id: 1 }], trains: [{ id: "train:7" }], services: [{ serviceId: "service:1", headwayMinutes: 6 }] });
  const before = JSON.stringify(state);
  const m = mount();
  planWithRoute(m);
  m.bridge.addDirections("both");
  m.bridge.loadDoc(m.bridge.serialize());
  m.bridge.destroy();
  assert.equal(JSON.stringify(state), before);
});
