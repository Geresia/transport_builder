import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ASSUMPTIONS_STORAGE_PREFIX, SCOPE_NOTICE, TRACK_COUNT_NOTICE, mountServicePlanAssumptionsPanel } from "../src/service-plan-assumptions-ui.mjs";
import { restoreAssumptionsDoc } from "../src/service-plan-assumptions-editor.mjs";

// --- a minimal DOM: elements, listeners, replaceChildren ---
class Node_ {
  constructor(tag) { Object.assign(this, { tag, children: [], className: "", textContent: "", value: "", checked: false, disabled: false, listeners: {} }); }
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
const control = (container, caption, nth = 0) => {
  const label = all(container, (n) => n.tag === "label" && n.children[0]?.textContent === caption)[nth];
  assert.ok(label, `field ${caption}`);
  return label.children[1];
};
const change = (container, caption, value, nth = 0) => { const c = control(container, caption, nth); c.value = value; c.fire("change"); };
const press = (container, label, nth = 0) => { const b = all(container, (n) => n.tag === "button" && n.textContent === label)[nth]; assert.ok(b, `button ${label}`); b.fire("click"); };
const hasButton = (container, label) => all(container, (n) => n.tag === "button" && n.textContent === label).length > 0;
const deepFreeze = (o) => { if (o && typeof o === "object") { Object.values(o).forEach(deepFreeze); Object.freeze(o); } return o; };
const json = (v) => JSON.stringify(v);

const PACK = { manifest: { id: "assume-ui", version: "1", data: { license: "CC0-1.0", attribution: [] } }, demand: { model: "gravity", points: [], attractors: [] } };
const plan = (over = {}) => ({ servicePlanId: "service-plan:aaaa", servicePlanRevision: "service-plan-revision:1", name: "Line A", operationalLineId: "line:1", route: { sections: [{ trackSegmentId: "ab" }, { trackSegmentId: "bc" }] }, ...over });
function storageOf(initial = new Map(), blocked = false) {
  return { map: initial, getItem(k) { if (blocked) throw new Error("blocked"); return initial.has(k) ? initial.get(k) : null; }, setItem(k, v) { if (blocked) throw new Error("blocked"); initial.set(k, v); } };
}
function mount({ plans = [plan()], profiles = null, storage = storageOf(), pack = PACK } = {}) {
  const container = newContainer();
  let current = plans;
  const changes = [];
  const panel = mountServicePlanAssumptionsPanel({ container, pack, getServicePlans: () => current, getTechnicalProfiles: profiles ? () => profiles : null, storage, onChange: (o) => changes.push(o) });
  return { container, panel, storage, changes, setPlans(next) { current = next; panel.refresh(); } };
}
const open = (m, id = "service-plan:aaaa") => { m.panel.select(id); return m; };
const doc = (m) => m.panel.output().document;
const statements = (m, id = "service-plan:aaaa") => doc(m).entries.find((e) => e.servicePlanId === id)?.statements ?? null;
const notesOf = (m) => m.panel.output().warnings.map((w) => w.code);
const BANNED = /비용|운임|수요|혼잡|승객|점수|수익|확률|판정|가능|불가|지연|정시/;

test("the panel opens with its notice, lists the map's plans without any assumption, and makes no entry before the player states something", () => {
  const m = mount();
  assert.ok(shows(m.container, SCOPE_NOTICE));
  assert.ok(shows(m.container, "Line A · 전제 없음"));
  assert.equal(m.panel.output().export.sets.length, 0);
  open(m);
  assert.ok(shows(m.container, "모든 값은 플레이어가 적은 가정입니다 (basis: player-stated-assumption)"));
  assert.equal(control(m.container, "단·복선").value, "");
  assert.ok(shows(m.container, TRACK_COUNT_NOTICE));
  assert.ok(shows(m.container, "서비스 계획 1건 · 전제 0건"));
  assert.equal(doc(m).entries.length, 0);
  assert.ok(shows(mount({ plans: [] }).container, "지도에 서비스 계획이 없습니다"));
});

test("a statement is made one field at a time; the first one makes the entry and every other field stays unknown with its reason", () => {
  const m = open(mount());
  change(m.container, "단·복선", "double");
  assert.equal(statements(m).directionMode, "double");
  assert.deepEqual(Object.entries(statements(m)).filter(([, v]) => v !== null).map(([k]) => k), ["directionMode"]);
  assert.ok(shows(m.container, "적은 항목: 단·복선"));
  assert.ok(shows(m.container, "최소 시격(분): 미상 (minimum-headway-not-stated)"));
  assert.ok(shows(m.container, "요일 유형: 적지 않아서 시간표 심사 쪽 처리(weekday-by-the-runtime)가 적용됩니다 — 플레이어가 정한 값이 아닙니다"));
  assert.ok(shows(m.container, "수용 비율(0~1): 적지 않아서 시간표 심사 쪽 처리(1-by-the-runtime)가 적용됩니다"));
  change(m.container, "단·복선", "");
  assert.equal(statements(m).directionMode, null);
});

test("a minimum headway that is 0, negative or not a number is refused and changes nothing; a blank puts it back to unknown", () => {
  const m = open(mount());
  change(m.container, "최소 시격(분)", "3");
  assert.equal(statements(m).minimumHeadwayMinutes, 3);
  const before = m.panel.serialize();
  for (const bad of ["0", "-2", "abc", "1441", "3분"]) {
    change(m.container, "최소 시격(분)", bad);
    assert.equal(m.panel.serialize(), before, bad);
  }
  assert.ok(notesOf(m).includes("service-plan-assumptions-refused"));
  assert.ok(shows(m.container, "최소 시격(분): 숫자가 아닙니다"));
  change(m.container, "최소 시격(분)", "");
  assert.equal(statements(m).minimumHeadwayMinutes, null);
});

test("a ratio of 0 is a stated zero and stays 0; null, 0 and an empty declaration look different on screen and in the output", () => {
  const m = open(mount());
  change(m.container, "수용 비율(0~1)", "0");
  assert.equal(statements(m).minimumAcceptanceRatio, 0);
  assert.equal(control(m.container, "수용 비율(0~1)").value, "0");
  assert.equal(m.panel.assessInput("service-plan:aaaa").minimumAcceptanceRatio, 0);
  change(m.container, "수용 비율(0~1)", "1.5");
  assert.equal(statements(m).minimumAcceptanceRatio, 0);
  change(m.container, "해당 없는 항목", "none");
  assert.deepEqual(statements(m).notApplicable, []);
  assert.equal(control(m.container, "해당 없는 항목").value, "none");
  change(m.container, "해당 없는 항목", "gaugeMm");
  assert.deepEqual(statements(m).notApplicable, ["gaugeMm"]);
  change(m.container, "해당 없는 항목", "");
  assert.equal(statements(m).notApplicable, null);
  assert.equal(m.panel.assessInput("service-plan:aaaa").minimumAcceptanceRatio, 0);
});

test("closure windows are typed per track segment: a window, 'none' as a statement, or unstated; a bad window is refused", () => {
  const m = open(mount());
  assert.ok(shows(m.container, "ab"));
  assert.ok(shows(m.container, " · 미기재"));
  change(m.container, "시작(분)", "300", 0); change(m.container, "끝(분)", "330", 0); change(m.container, "사유", "inspection", 0);
  press(m.container, "시간창 추가", 0);
  assert.deepEqual(statements(m).closureWindowsBySectionId, { ab: [{ startMinute: 300, endMinute: 330, reason: "inspection" }] });
  assert.ok(shows(m.container, "300–330분(inspection)"));
  change(m.container, "시작(분)", "400", 0); change(m.container, "끝(분)", "300", 0);
  const before = m.panel.serialize();
  press(m.container, "시간창 추가", 0);
  assert.equal(m.panel.serialize(), before);
  change(m.container, "시작(분)", "x", 0);
  press(m.container, "시간창 추가", 0);
  assert.ok(shows(m.container, "폐쇄 시간창: 시작과 끝을 분(숫자)으로 적으세요"));
  assert.equal(m.panel.serialize(), before);
  press(m.container, "없음으로 선언", 1);
  assert.deepEqual(statements(m).closureWindowsBySectionId.bc, []);
  assert.ok(shows(m.container, " · 없음(선언됨)"));
  assert.deepEqual(m.panel.output().export.sets[0].closureSectionsNotStated, []);
  press(m.container, "미기재로", 0);
  assert.deepEqual(Object.keys(statements(m).closureWindowsBySectionId), ["bc"]);
  press(m.container, "모든 구간 없음으로 선언");
  assert.deepEqual(statements(m).closureWindowsBySectionId, { ab: [], bc: [] });
  press(m.container, "폐쇄 시간창을 적지 않은 상태로");
  assert.equal(statements(m).closureWindowsBySectionId, null);
});

test("an explicit technical specification is JSON the editor checks; unknown fields and impossible values are refused, a blank is unknown", () => {
  const m = open(mount());
  change(m.container, "명시적 기술사양 (JSON)", '{"minCars":4,"signalSystemIds":["ats-p"]}');
  assert.deepEqual(statements(m).technicalSpecification, { minCars: 4, signalSystemIds: ["ats-p"] });
  assert.equal(control(m.container, "명시적 기술사양 (JSON)").value, '{"minCars":4,"signalSystemIds":["ats-p"]}');
  const before = m.panel.serialize();
  for (const bad of ["{", '{"colour":"red"}', '{"minCars":-1}', '{"minCars":8,"maxCars":4}', "[1]"]) { change(m.container, "명시적 기술사양 (JSON)", bad); assert.equal(m.panel.serialize(), before, bad); }
  assert.ok(notesOf(m).includes("service-plan-assumptions-refused"));
  change(m.container, "시간당 열차 수(직접 적은 값)", "20");
  assert.equal(statements(m).capacityTrainsPerHour, 20);
  assert.equal(statements(m).minimumHeadwayMinutes, null); // the two are never derived from each other
  change(m.container, "명시적 기술사양 (JSON)", "");
  assert.equal(statements(m).technicalSpecification, null);
  assert.deepEqual(m.panel.technicalSpecs(), { "line:1": { capacityTrainsPerHour: 20 } });
});

test("a technical profile is chosen from the host's catalog (or typed when there is none); one that is not in the catalog is refused", () => {
  const withCatalog = open(mount({ profiles: [{ id: "medium_steel", name: "중형 철륜" }, { id: "small_steel", name: "소형 철륜" }] }));
  const select = control(withCatalog.container, "기술 프로필");
  assert.equal(select.tag, "select");
  assert.deepEqual(select.children.map((o) => o.value), ["", "medium_steel", "small_steel"]);
  change(withCatalog.container, "기술 프로필", "medium_steel");
  assert.equal(statements(withCatalog).technicalProfileId, "medium_steel");
  assert.equal(withCatalog.panel.set("service-plan:aaaa", { technicalProfileId: "steam" }), false);
  assert.equal(statements(withCatalog).technicalProfileId, "medium_steel");
  assert.ok(notesOf(withCatalog).includes("service-plan-assumptions-refused"));
  change(withCatalog.container, "기술 프로필", "");
  assert.equal(statements(withCatalog).technicalProfileId, null);
  const typed = open(mount());
  assert.equal(control(typed.container, "기술 프로필").tag, "input");
  change(typed.container, "기술 프로필", "medium_steel");
  assert.deepEqual(typed.panel.technicalSpecs(), { "line:1": { technicalProfileId: "medium_steel" } });
});

test("what is handed on is only what was stated, and the preview on screen is exactly that", () => {
  const m = open(mount());
  assert.equal(m.panel.assessInput("service-plan:aaaa"), null); // no entry yet
  change(m.container, "요일 유형", "weekend");
  change(m.container, "단·복선", "single");
  change(m.container, "최소 시격(분)", "4");
  const input = m.panel.assessInput("service-plan:aaaa");
  assert.deepEqual(input, { technicalSpecs: {}, infrastructureAssumptions: { directionMode: "single", minimumHeadwayMinutes: 4 }, dayType: "weekend" });
  const preview = all(m.container, (n) => classes(n).includes("svcassume-preview"))[0];
  assert.equal(preview.textContent, JSON.stringify(input, null, 2));
  assert.equal(m.panel.assessInput("service-plan:nope"), null);
  assert.deepEqual(m.panel.output().assessInputs, { "service-plan:aaaa": input });
  assert.equal(m.panel.output().export.sets[0].basis, "player-stated-assumption");
});

test("when the plan changes the assumptions are stale: kept and shown, not handed on, until the player confirms them", () => {
  const m = open(mount());
  change(m.container, "단·복선", "double");
  change(m.container, "최소 시격(분)", "3");
  assert.ok(m.panel.assessInput("service-plan:aaaa"));
  m.setPlans([plan({ servicePlanRevision: "service-plan-revision:2" })]);
  assert.ok(shows(m.container, "Line A · 계획이 바뀜 (낡음)"));
  assert.ok(shows(m.container, "계획이 바뀌어 이 전제는 낡았습니다"));
  assert.ok(shows(m.container, "시간표 심사 입력: 넘기지 않음"));
  assert.equal(m.panel.assessInput("service-plan:aaaa"), null);
  assert.deepEqual(m.panel.technicalSpecs(), {});
  assert.deepEqual(m.panel.output().assessInputs, {});
  assert.equal(control(m.container, "최소 시격(분)").value, "3"); // what was written is still there
  change(m.container, "최소 시격(분)", "4"); // editing does not confirm it
  assert.equal(m.panel.assessInput("service-plan:aaaa"), null);
  press(m.container, "계획이 바뀐 것을 확인했고 이 전제를 계속 씁니다");
  assert.deepEqual(m.panel.assessInput("service-plan:aaaa").infrastructureAssumptions, { directionMode: "double", minimumHeadwayMinutes: 4 });
  assert.equal(hasButton(m.container, "계획이 바뀐 것을 확인했고 이 전제를 계속 씁니다"), false);
});

test("a plan that left the map keeps its assumptions in the document; they are shown as orphaned and can be removed", () => {
  const m = open(mount());
  change(m.container, "단·복선", "double");
  m.setPlans([]);
  assert.ok(shows(m.container, "service-plan:aaaa · 지도에 없는 계획의 전제 (문서에는 그대로 남음)"));
  assert.equal(statements(m).directionMode, "double");
  assert.equal(m.panel.assessInput("service-plan:aaaa"), null);
  m.panel.select("service-plan:aaaa");
  assert.ok(shows(m.container, "이 계획은 지금 지도에 없습니다"));
  assert.equal(m.panel.set("service-plan:aaaa", { dayType: "weekday" }), false);
  press(m.container, "전제 삭제");
  assert.equal(doc(m).entries.length, 0);
});

test("two plans of one line with different technical profiles are reported as a conflict and neither is handed on", () => {
  const m = mount({ plans: [plan(), plan({ servicePlanId: "service-plan:bbbb", name: "Line B" })] });
  m.panel.set("service-plan:aaaa", { technicalProfileId: "medium_steel" });
  m.panel.set("service-plan:bbbb", { technicalProfileId: "small_steel" });
  assert.deepEqual(m.panel.technicalSpecs(), {});
  assert.equal(m.panel.output().technicalConflicts[0].operationalLineId, "line:1");
  assert.ok(shows(m.container, "같은 노선에 서로 다른 기술사양을 적은 계획이 있어"));
  m.panel.set("service-plan:bbbb", { technicalProfileId: "medium_steel" });
  assert.deepEqual(m.panel.technicalSpecs(), { "line:1": { technicalProfileId: "medium_steel" } });
});

test("the document is saved after each statement and a new panel restores it with the same ids; another pack's document is refused", () => {
  const storage = storageOf();
  const first = open(mount({ storage }));
  change(first.container, "단·복선", "double");
  change(first.container, "최소 시격(분)", "3");
  assert.ok(shows(first.container, "저장됨"));
  assert.equal(first.panel.storageKey, `${ASSUMPTIONS_STORAGE_PREFIX}assume-ui`);
  const second = mount({ storage });
  assert.deepEqual(second.panel.output().document, first.panel.output().document);
  assert.equal(json(second.panel.output().export), json(first.panel.output().export));
  // a document of another pack in the storage is refused and the panel starts empty
  const foreign = storageOf(new Map([[`${ASSUMPTIONS_STORAGE_PREFIX}assume-ui`, JSON.stringify({ ...JSON.parse(first.panel.serialize()), packId: "someone-else" })]]));
  const refused = mount({ storage: foreign });
  assert.equal(refused.panel.output().document.entries.length, 0);
  assert.ok(refused.panel.output().warnings.some((w) => w.code === "service-plan-assumptions-doc-other-pack"));
  // loadDoc: a foreign document leaves the current one untouched, an own one replaces it
  const before = first.panel.serialize();
  assert.deepEqual(first.panel.loadDoc(JSON.stringify({ ...JSON.parse(before), packId: "someone-else" })).map((w) => w.code), ["service-plan-assumptions-doc-other-pack"]);
  assert.equal(first.panel.serialize(), before);
  assert.deepEqual(first.panel.loadDoc("{").map((w) => w.code), ["service-plan-assumptions-doc-unreadable"]);
  assert.equal(first.panel.serialize(), before);
  const other = mount({ plans: [plan()] });
  other.panel.set("service-plan:aaaa", { dayType: "holiday" });
  assert.deepEqual(first.panel.loadDoc(other.panel.serialize()), []);
  assert.equal(statements(first).dayType, "holiday");
  assert.equal(JSON.parse(storage.map.get(first.panel.storageKey)).entries[0].statements.dayType, "holiday");
  assert.deepEqual(first.panel.loadDoc(null), []);
  assert.equal(restoreAssumptionsDoc(first.panel.serialize(), PACK).rejected, false);
});

test("a blocked storage is a note, not an exception; with no storage the host saves through serialize()", () => {
  const blocked = open(mount({ storage: storageOf(new Map(), true) }));
  change(blocked.container, "단·복선", "single");
  assert.equal(statements(blocked).directionMode, "single");
  assert.ok(shows(blocked.container, "저장하지 못함"));
  assert.ok(notesOf(blocked).includes("service-plan-assumptions-doc-not-saved"));
  const noStorage = mount({ storage: null });
  assert.equal(noStorage.panel.storageKey, null);
  assert.ok(shows(noStorage.container, "저장소 없음 (호스트가 serialize()로 저장)"));
});

test("the same inputs and the same steps give the same output on two panels; frozen plans are never changed", () => {
  const run = () => {
    const m = open(mount({ plans: [deepFreeze(plan())] }));
    change(m.container, "단·복선", "double");
    change(m.container, "최소 시격(분)", "3");
    change(m.container, "요일 유형", "weekday");
    press(m.container, "모든 구간 없음으로 선언");
    change(m.container, "수용 비율(0~1)", "0.5");
    return json(m.panel.output());
  };
  assert.equal(run(), run());
  const frozenPlans = deepFreeze([plan()]);
  const before = json(frozenPlans);
  const m = open(mount({ plans: frozenPlans }));
  change(m.container, "단·복선", "single");
  assert.equal(json(frozenPlans), before);
  const out = m.panel.output();
  out.document.entries[0].statements.directionMode = "double";
  assert.equal(statements(m).directionMode, "single");
});

test("onChange is called for each change with the whole output", () => {
  const m = open(mount());
  const n = m.changes.length;
  change(m.container, "단·복선", "double");
  assert.ok(m.changes.length > n);
  const last = m.changes.at(-1);
  assert.equal(last.document.entries[0].statements.directionMode, "double");
  assert.deepEqual(Object.keys(last).sort(), ["assessInputs", "document", "export", "selectedServicePlanId", "technicalConflicts", "technicalSpecs", "warnings"]);
});

test("nothing on the panel claims a result: no verdict, price, demand or schedule in any state", () => {
  const states = [];
  const m = mount({ profiles: [{ id: "medium_steel", name: "중형 철륜" }] });
  states.push(texts(m.container).join("\n"));
  open(m);
  states.push(texts(m.container).join("\n"));
  change(m.container, "단·복선", "double"); change(m.container, "최소 시격(분)", "3"); change(m.container, "시간당 열차 수(직접 적은 값)", "20"); change(m.container, "수용 비율(0~1)", "0"); change(m.container, "요일 유형", "holiday");
  change(m.container, "최소 시격(분)", "-1");
  press(m.container, "모든 구간 없음으로 선언");
  states.push(texts(m.container).join("\n"));
  m.setPlans([plan({ servicePlanRevision: "service-plan-revision:9", route: null, operationalLineId: null })]);
  states.push(texts(m.container).join("\n"));
  m.setPlans([]);
  states.push(texts(m.container).join("\n"));
  for (const t of states) assert.equal(BANNED.test(t), false, `banned word ${t.match(BANNED)?.[0]}`);
  assert.ok(states.some((t) => t.includes("플레이어가 적은 가정")));
});

test("the panel imports no management or map geometry, runs no clock or randomness and touches no storage itself", () => {
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "service-plan-assumptions-ui.mjs"), "utf8");
  for (const m of src.matchAll(/from "([^"]+)"/g)) assert.match(m[1], /^\.\/(service-plan-assumptions|service-plan-assumptions-editor|map\/map-mount-kit|map\/service-plan-tools)\.mjs$/, `imports ${m[1]}`);
  const code = src.replace(/\/\/.*$/gm, "").replace(/localStorage: storage/g, "");
  assert.equal(/management|scenario-runtime|ledger|\.commit\(|\.settle\(|\.post\(|node:fs|Date\.now|new Date|Math\.random|performance\.now|setTimeout|localStorage|sessionStorage|fetch\(/.test(code), false);
  assert.equal(/60\s*\/|\/\s*60\b|Math\.floor\(/.test(code), false);
});
