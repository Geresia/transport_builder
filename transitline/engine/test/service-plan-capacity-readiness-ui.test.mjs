import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ASSUMPTION_NOTICE, SCOPE_NOTICE, factText, mountCapacityReadinessPanel } from "../src/service-plan-capacity-readiness-ui.mjs";
import { buildAssumptionExport } from "../src/service-plan-assumptions.mjs";
import { newAssumptionsDoc, setAssumptions } from "../src/service-plan-assumptions-editor.mjs";
import { READINESS_CASES, buildReadinessWorld } from "../../scripts/lib/capacity-readiness-world.mjs";

// --- a minimal DOM: elements, listeners, replaceChildren ---
class Node_ {
  constructor(tag) { Object.assign(this, { tag, children: [], className: "", textContent: "", value: "", listeners: {} }); }
  append(...kids) { this.children.push(...kids); }
  replaceChildren(...kids) { this.children = []; this.append(...kids); }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  fire(type) { for (const fn of this.listeners[type] ?? []) fn({ type }); }
}
const dom = { createElement: (tag) => new Node_(tag) };
const newContainer = () => Object.assign(new Node_("div"), { ownerDocument: dom });
const all = (node, pred = () => true) => [pred(node) ? node : null, ...node.children.flatMap((c) => all(c, pred))].filter(Boolean);
const texts = (node) => all(node).map((n) => n.textContent).filter(Boolean);
const shows = (node, part) => texts(node).some((t) => t.includes(part));
const classes = (node) => String(node.className).split(" ");
const press = (container, label, nth = 0) => { const b = all(container, (n) => n.tag === "button" && n.textContent === label)[nth]; assert.ok(b, `button ${label}`); b.fire("click"); };
const buttons = (container, label) => all(container, (n) => n.tag === "button" && n.textContent === label).length;
const deepFreeze = (o) => { if (o && typeof o === "object") { Object.values(o).forEach(deepFreeze); Object.freeze(o); } return o; };
const json = (v) => JSON.stringify(v);
const BANNED = /가능|불가|판정|비용|운임|수요|혼잡|승객|수익|점수|확률|지연|정시|시간표/;

function mount(world, { assumptions = null, onOpenEditor = null, apps = world.applications, geometries = world.geometries } = {}) {
  const container = newContainer();
  const state = { plans: world.servicePlans, apps, geometries, assumptions };
  const changes = [];
  const panel = mountCapacityReadinessPanel({ container, getServicePlans: () => state.plans, getRailGeometries: () => state.geometries, getApplications: () => state.apps, getAssumptions: () => state.assumptions, onOpenEditor, onChange: (o) => changes.push(o) });
  return { container, panel, state, changes };
}
const openFirst = (m) => { m.panel.select(m.panel.view().plans[0].servicePlanId); return m; };

test("the panel opens with its notice and a one-line summary per plan; a plan opens into its facts and closes again", () => {
  const w = buildReadinessWorld("partial");
  const m = mount(w);
  assert.ok(shows(m.container, SCOPE_NOTICE));
  assert.ok(shows(m.container, "서비스 계획 1건 · 적용 결과 현재 1 · 낡음 0 · 없음/연결 안 됨 0 · 채워야 할 지도 입력 3건"));
  assert.ok(shows(m.container, "Line A · 적용 결과 현재 · 채워야 할 입력 3건"));
  assert.equal(shows(m.container, "구간 사실"), false);
  press(m.container, "자세히");
  assert.ok(shows(m.container, "구간 사실"));
  assert.equal(m.panel.selectedServicePlanId, w.servicePlans[0].servicePlanId);
  press(m.container, "접기");
  assert.equal(shows(m.container, "구간 사실"), false);
  assert.equal(m.panel.select("service-plan:nope"), false);
});

test("the facts of a plan are written as the map states them: stated, unknown, a count, and where each came from", () => {
  const w = buildReadinessWorld("partial");
  const m = openFirst(mount(w));
  assert.ok(shows(m.container, "철도 용량 적용 결과: 현재"));
  assert.ok(shows(m.container, "1. 구간"));
  assert.ok(shows(m.container, "적용 결과의 트랙 구간에 매핑됨 (트랙 ab)"));
  assert.ok(shows(m.container, "단·복선 미상 / 지도 원본 미상 · 폐색 3개"));
  assert.ok(shows(m.container, "단·복선 단선(명시) / 지도 원본 단선(명시) · 폐색 1개"));
  assert.ok(shows(m.container, "분기기 미상 / 지도 원본 미상"));
  assert.ok(shows(m.container, "종착 설비가 적용 결과에 있음"));
  assert.ok(shows(m.container, "회차선이 접속됨 (지도에서 측정)"));
  assert.ok(shows(m.container, "후보 1개 중 접속 1개"));
  assert.ok(shows(m.container, "종착 설비를 고르지 않음"));
  assert.ok(shows(m.container, "설비를 고르지 않아 확인할 수 없음"));
  assert.ok(shows(m.container, "구간의 단·복선이 지도에 적혀 있지 않음"));
  assert.ok(shows(m.container, "채울 곳: 철도 용량 지도 > 단·복선 지정 (사전심사 항목 direction-mode)"));
  assert.ok(shows(m.container, "채울 곳: 서비스 계획 편집 > 회차의 종착 설비 고르기 (사전심사 항목 terminal-resource)"));
  assert.ok(shows(m.container, "채워야 할 지도 입력 3건"));
});

test("a fact the map declares empty is 'none (declared)', never a count and never 'unknown'; a missing one is 'unknown', never none", () => {
  assert.equal(factText({ state: "declared-none", count: 0, ids: [] }), "없음(선언됨)");
  assert.equal(factText({ state: "unknown", count: null, ids: null }), "미상");
  assert.equal(factText({ state: "listed", count: 2, ids: ["a:1234", "b:5678"] }), "2개 (…1234, …5678)");
  assert.equal(factText(null), "확인할 수 없음");
  assert.equal(factText({ state: "stated", value: "double" }, "mode"), "복선(명시)");
  assert.equal(factText({ state: "unknown", value: null }, "mode"), "미상");
  const w = buildReadinessWorld("partial");
  const app = structuredClone(w.applications[0]);
  app.sections[0].blockIds = [];
  app.sections[0].junctionResourceIds = [];
  const m = openFirst(mount(w, { apps: [app] }));
  assert.ok(shows(m.container, "폐색 없음(선언됨)"));
  assert.ok(shows(m.container, "분기기 없음(선언됨)"));
  assert.equal(shows(m.container, "폐색 0개"), false);
  assert.equal(shows(m.container, "폐색 미상 / 지도 원본 미상"), false);
});

test("the capacity application is shown as current, stale, none or not tied to a line, each with its gap", () => {
  const word = { stale: "낡음 (지도가 바뀐 뒤의 결과)", "no-application": "없음", "no-line": "운영 노선 연결 안 됨" };
  for (const [name, expected] of Object.entries(word)) {
    const m = openFirst(mount(buildReadinessWorld(name)));
    assert.ok(shows(m.container, `철도 용량 적용 결과: ${expected}`), name);
    assert.ok(shows(m.container, "사전심사 항목 rail-capacity-application"), name);
  }
  const stale = openFirst(mount(buildReadinessWorld("stale")));
  assert.ok(shows(stale.container, "적용된 철도 용량 결과가 현재 지도보다 낡음"));
  assert.ok(shows(stale.container, "낡음 1"));
  const none = openFirst(mount(buildReadinessWorld("no-application")));
  assert.ok(shows(none.container, "적용 결과가 없어 확인할 수 없음"));
  assert.ok(shows(none.container, "채울 곳: 철도 용량 지도에서 현재 지도를 노선에 적용"));
  const noLine = openFirst(mount(buildReadinessWorld("no-line")));
  assert.ok(shows(noLine.container, "채울 곳: 서비스 계획 편집 > 용량 적용 결과 연결"));
  // nothing stated on the map at all
  const bare = openFirst(mount(buildReadinessWorld("bare")));
  assert.ok(shows(bare.container, "구간의 폐색 자료가 지도에 없음"));
  assert.ok(shows(bare.container, "채울 곳: 철도 용량 지도 > 폐색 경계 놓기 또는 '경계 없음으로 선언'"));
  assert.ok(shows(bare.container, "채울 곳: 철도 용량 지도 > 분기기·평면교차 놓기"));
});

test("the player's assumptions are in their own block marked as assumptions, set apart from the map's facts and never counted as them", () => {
  const w = buildReadinessWorld("partial");
  const doc = newAssumptionsDoc(w.pack.manifest.id, "1");
  setAssumptions(doc, w.servicePlans[0], { directionMode: "double", minimumHeadwayMinutes: 3, capacityTrainsPerHour: 20 });
  const assumptions = buildAssumptionExport({ pack: w.pack, doc, servicePlans: w.servicePlans });
  const withA = openFirst(mount(w, { assumptions }));
  const without = openFirst(mount(w));
  const box = all(withA.container, (n) => classes(n).includes("svccap-assumption"))[0];
  assert.ok(box, "an assumption block");
  assert.ok(shows(box, ASSUMPTION_NOTICE));
  assert.ok(shows(box, "단·복선 — 지도 사실: 단선 (일부 구간만 명시) / 플레이어 가정: 복선 (서로 다름)"));
  assert.ok(shows(box, "시간당 열차 수(직접 적은 값): 20 · 최소 시격(분, 직접 적은 값): 3"));
  const card = all(withA.container, (n) => classes(n).includes("svccap-card"))[0];
  assert.equal(card.children.filter((c) => classes(c).includes("svccap-assumption")).length, 1);
  // the assumption is not in any map-fact line and changes none of them
  const boxTexts = new Set(texts(box));
  const mapLines = card.children.filter((c) => !classes(c).includes("svccap-assumption")).flatMap((c) => texts(c)).filter((t) => !boxTexts.has(t));
  assert.equal(mapLines.some((t) => t.includes("복선(명시)") || t.includes("가정")), false);
  assert.equal(json(withA.panel.view().plans[0].gaps), json(without.panel.view().plans[0].gaps));
  assert.equal(shows(without.container, "플레이어 가정"), false);
  // an entry that does not exist for this plan is said so
  const empty = openFirst(mount(w, { assumptions: buildAssumptionExport({ pack: w.pack, doc: newAssumptionsDoc(w.pack.manifest.id, "1"), servicePlans: w.servicePlans }) }));
  assert.ok(shows(empty.container, "이 계획에 대해 적은 가정이 없습니다."));
});

test("with an editor callback every gap has a button that hands the host a request; without one there is no button; the panel changes nothing", () => {
  const w = buildReadinessWorld("partial");
  assert.equal(buttons(openFirst(mount(w)).container, "철도 용량 편집 열기"), 0);
  const requests = [];
  const m = openFirst(mount(w, { onOpenEditor: (r) => requests.push(r) }));
  assert.equal(buttons(m.container, "철도 용량 편집 열기"), 2);
  assert.equal(buttons(m.container, "서비스 계획 편집 열기"), 1);
  const before = json(m.panel.view());
  press(m.container, "철도 용량 편집 열기", 0);
  press(m.container, "서비스 계획 편집 열기", 0);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0], { action: "open-capacity-editor", servicePlanId: w.servicePlans[0].servicePlanId, operationalLineId: w.lineId, railGeometryId: w.geometries[0].railGeometryId, field: "directionMode", checkId: "direction-mode", sectionIds: requests[0].sectionIds });
  assert.equal(requests[0].sectionIds.length, 1);
  assert.deepEqual([requests[1].action, requests[1].field], ["open-service-plan-editor", "terminalResourceId"]);
  assert.equal(json(m.panel.view()), before);
});

test("the panel follows its inputs: when the map's facts change, a refresh shows them; a plan with nothing missing says so", () => {
  const w = buildReadinessWorld("partial");
  const m = openFirst(mount(w));
  assert.ok(shows(m.container, "채워야 할 지도 입력 3건"));
  const full = structuredClone(w.applications[0]);
  full.sections[0].directionMode = "double";
  for (const s of full.sections) s.junctionResourceIds = [];
  m.state.apps = [full];
  m.state.plans = w.servicePlans.map((p) => ({ ...p, turnbacks: [p.turnbacks[0]] }));
  m.panel.refresh();
  assert.ok(shows(m.container, "채워야 할 지도 입력 0건"));
  assert.ok(shows(m.container, "지도 사실이 비어 있는 곳이 없습니다 (적힌 사실만 확인함)."));
  assert.ok(m.changes.length >= 2);
  m.state.plans = [];
  m.panel.refresh();
  assert.ok(shows(m.container, "서비스 계획이 없습니다."));
});

test("the same inputs give the same panel text on every mount; frozen inputs are never changed", () => {
  const run = () => texts(openFirst(mount(buildReadinessWorld("partial"))).container).join("\n");
  assert.equal(run(), run());
  const w = buildReadinessWorld("stale");
  const frozen = deepFreeze(structuredClone({ servicePlans: w.servicePlans, geometries: w.geometries, applications: w.applications }));
  const before = json(frozen);
  const m = openFirst(mount({ servicePlans: frozen.servicePlans }, { apps: frozen.applications, geometries: frozen.geometries }));
  assert.ok(shows(m.container, "낡음"));
  assert.equal(json(frozen), before);
  const out = m.panel.output();
  out.view.plans[0].sections.length = 0;
  assert.equal(m.panel.view().plans[0].sections.length, 2);
});

test("nothing on the panel says whether a plan can run, prices it or builds a schedule: every text of every case is checked", () => {
  const states = [];
  for (const c of READINESS_CASES) {
    const w = buildReadinessWorld(c);
    const doc = newAssumptionsDoc(w.pack.manifest.id, "1");
    setAssumptions(doc, w.servicePlans[0], { directionMode: "single", minimumHeadwayMinutes: 4 });
    const m = mount(w, { assumptions: buildAssumptionExport({ pack: w.pack, doc, servicePlans: w.servicePlans }), onOpenEditor: () => {} });
    states.push(texts(m.container).join("\n"));
    openFirst(m);
    states.push(texts(m.container).join("\n"));
  }
  for (const t of states) assert.equal(BANNED.test(t), false, `banned word ${t.match(BANNED)?.[0]}`);
  assert.ok(states.every((t) => t.includes("계산하지 않고")));
});

test("the panel imports only its own view module and changes no engine state: no clock, randomness, storage or arithmetic between headway and capacity", () => {
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "service-plan-capacity-readiness-ui.mjs"), "utf8");
  assert.deepEqual([...src.matchAll(/from "([^"]+)"/g)].map((m) => m[1]), ["./service-plan-capacity-readiness.mjs"]);
  const code = src.replace(/\/\/.*$/gm, "");
  assert.equal(/management|scenario-runtime|ledger|\.commit\(|\.settle\(|\.post\(|node:fs|Date\.now|new Date|Math\.random|performance\.now|setTimeout|localStorage|sessionStorage|fetch\(/.test(code), false);
  assert.equal(/60\s*\/|\/\s*60\b|Math\.floor\(|trainsPerHour\s*=/.test(code), false);
  const state = deepFreeze({ cash: 1_000_000, ledger: [{ id: 1 }], lines: [{ id: "line:1" }] });
  const before = json(state);
  const m = openFirst(mount(buildReadinessWorld("partial"), { onOpenEditor: () => {} }));
  press(m.container, "철도 용량 편집 열기", 0);
  m.panel.destroy();
  assert.equal(json(state), before);
  assert.equal(m.container.children.length, 0);
});
