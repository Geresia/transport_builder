import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  PANEL_DOC_SCHEMA, RELEASE_NOTICE, SCOPE_NOTICE, TERMINAL_NOTICE, amountText, blockerText, conditionsText, idListText, mountNewTownRailContributionManagementPanel,
  newPanelDoc, phaseText, restorePanelDoc, serializePanelDoc,
} from "../src/new-town-rail-contribution-management-panel.mjs";
import { NEW_TOWN_RAIL_CONTRIBUTION_LEDGER_CATEGORY as CATEGORY } from "../src/management/index.mjs";
import { ScenarioRuntime } from "../src/scenario-runtime.mjs";
import { createState } from "../src/state.mjs";

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
const hasClass = (node, name) => classes(node).includes(name);
const click = (node) => node.fire("click");
const deepFreeze = (o) => { if (o && typeof o === "object") { Object.values(o).forEach(deepFreeze); Object.freeze(o); } return o; };

const read = (rel) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
// a real B19-M1 development (drawn in the editor, built by the M1 builder)
const EXAMPLE = JSON.parse(read("../../packs/example-radial/new-town-development-examples/01-two-phases-with-synthetic-pond-and-road.new-town.json"));
const [P1, P2] = EXAMPLE.phases.map((p) => p.phaseId);
const PARTIES = { municipality: { name: "Example City" }, developer: { name: "Example Dev" } };
const PACK = { manifest: { id: "ntrc-panel", version: "1", data: { license: "test", attribution: [] } }, demand: { model: "gravity", points: [], attractors: [] } };
const scenarioGeometry = () => ({ ...structuredClone(EXAMPLE), sourcePackId: PACK.manifest.id, sourcePackVersion: PACK.manifest.version });
const COMMANDS = ["draft", "propose", "agree", "fund", "release", "delay", "resume", "terminate"].map((n) => `${n}NewTownRailContribution`);
const READS = ["assessNewTownRailContribution", "newTownRailContributionHooks", "newTownRailContributionReport"];
const AMOUNT = 3_000_000_000;

// the runtime is the real ScenarioRuntime; the proxy only counts what the panel calls
function spyRuntime(real) {
  const calls = { commands: [], reads: [] };
  const proxy = new Proxy(real, {
    get(target, prop) {
      const value = target[prop];
      if (typeof value !== "function") return value;
      return (...args) => { (COMMANDS.includes(prop) ? calls.commands : calls.reads).push(prop); return value.apply(target, args); };
    },
  });
  return { runtime: proxy, calls };
}
function setup({ geometry = scenarioGeometry(), mountIt = true } = {}) {
  const real = new ScenarioRuntime({ pack: PACK, operationalState: createState(PACK) });
  const development = real.proposeNewTownDevelopment({ geometry, parties: PARTIES });
  real.game.projects.push({ id: "project:1", status: "active" });
  const world = { geometries: [structuredClone(geometry)], links: { planIds: ["plan:1"], stationSiteIds: ["site:1"] } };
  const { runtime, calls } = spyRuntime(real);
  const container = newContainer();
  const changes = [];
  const options = {
    container, runtime, onChange: () => changes.push(1),
    getGeometryExport: () => ({ schema: "transitline.new-town-development-export/1", packId: geometry.sourcePackId, packVersion: geometry.sourcePackVersion, developments: world.geometries, warnings: [] }),
    getNewTownDevelopments: () => real.newTownDevelopmentReport(),
    getCurrentLinks: () => world.links,
  };
  const panel = mountIt ? mountNewTownRailContributionManagementPanel(options) : null;
  return { real, runtime, calls, container, panel, world, development, changes, options };
}
const ledgerRows = (real) => real.game.ledger.entries.filter((e) => e.category === CATEGORY);

// --- finding things on screen ---
const fieldNode = (scope, label) => all(scope, (n) => n.tag === "label" && n.children[0]?.textContent === label).map((l) => l.children.find((c, i) => i > 0 && ["input", "select", "textarea"].includes(c.tag)))[0];
const setField = (scope, label, value) => { const node = fieldNode(scope, label); assert.ok(node, `field ${label}`); node.value = value; node.fire("change"); return node; };
const boxes = (scope) => all(scope, (n) => n.tag === "input" && n.type === "checkbox");
const checkBox = (scope, partOfLabel) => all(scope, (n) => n.tag === "label").find((l) => l.children.some((c) => c.tag === "span" && c.textContent.includes(partOfLabel))).children.find((c) => c.tag === "input");
const buttonOf = (scope, name) => all(scope, (n) => n.tag === "button" && hasClass(n, `ntrc-${name}`))[0];
const cardOf = (container, id) => all(container, (n) => hasClass(n, "ntrc-card")).find((card) => all(card, (n) => hasClass(n, "ntrc-id"))[0]?.children[1]?.textContent === id);
const factOf = (card, label) => all(card, (n) => hasClass(n, "ntrc-fact")).find((f) => f.children[0].textContent === label)?.children[1].textContent;

function fillDraft(ctx, over = {}) {
  const f = { developmentRecordId: ctx.development.id, payerKind: "municipality", payeeKind: "player-railway", statedPurpose: "station", amount: String(AMOUNT), phaseMode: "list", phaseText: P1,
    projectMode: "unstated", projectText: "", planMode: "list", planText: "plan:1", siteMode: "list", siteText: "site:1", conditionMode: "list", conditionText: "c1: The station opens before phase 1 is serviced", ...over };
  const c = ctx.container;
  setField(c, "개발 기록 (E1)", f.developmentRecordId); setField(c, "부담자 종류", f.payerKind); setField(c, "수령자 종류", f.payeeKind); setField(c, "목적", f.statedPurpose);
  setField(c, "분담 금액(엔)", f.amount);
  for (const [label, mode, textValue] of [["연결 단계", f.phaseMode, f.phaseText], ["연결 프로젝트", f.projectMode, f.projectText], ["연결 계획", f.planMode, f.planText], ["연결 역 부지", f.siteMode, f.siteText]]) {
    setField(c, label, mode); setField(c, `${label} 목록`, textValue);
  }
  setField(c, "조건", f.conditionMode); setField(c, "조건 목록", f.conditionText);
  if (f.name) setField(c, "이름(선택)", f.name);
}
function draftIt(ctx, over = {}) {
  fillDraft(ctx, over);
  click(buttonOf(ctx.container, "draft"));
  return ctx.real.newTownRailContributionReport().at(-1)?.contributionId;
}
// bring one to a status by clicking only
function drive(ctx, to, over = {}) {
  const id = draftIt(ctx, over);
  const fundAmount = over.amount !== undefined ? over.amount : String(AMOUNT);
  for (const step of ["propose", "agree", "fund", "release"]) {
    if (ctx.real.newTownRailContributionReport(id)[0].status === to) return id;
    const card = cardOf(ctx.container, id);
    if (step === "fund") { setField(card, "확정 금액(엔)", fundAmount); setField(card, "확정한 주체", "payer"); setField(card, "근거(문서·결의 등)", "council resolution"); }
    if (step === "release") for (const box of boxes(card)) box.checked = true;
    click(buttonOf(card, step));
  }
  return id;
}

test("mounting needs its parts, and mount / refresh / select / serialize / loadDoc / the re-read button call no engine command", () => {
  const w = setup({ mountIt: false });
  for (const bad of [{ container: null }, { getGeometryExport: undefined }, { getNewTownDevelopments: undefined }, { getCurrentLinks: undefined }, { runtime: {} }, { runtime: null }]) {
    assert.throws(() => mountNewTownRailContributionManagementPanel({ ...w.options, ...bad }), Error, JSON.stringify(Object.keys(bad)));
  }
  const id = w.real.draftNewTownRailContribution({ developmentRecordId: w.development.id, payerKind: "municipality", payeeKind: "other", statedPurpose: "access" }).contributionId;
  const before = JSON.stringify(w.real.game.snapshot());
  const panel = mountNewTownRailContributionManagementPanel(w.options);
  assert.ok(shows(w.container, SCOPE_NOTICE) && cardOf(w.container, id));
  panel.refresh(); panel.refresh(); panel.select(id); panel.select(null); panel.serialize(); panel.loadDoc(panel.serialize());
  click(all(w.container, (n) => hasClass(n, "ntrc-reread"))[0]);
  click(all(w.container, (n) => hasClass(n, "ntrc-select-card"))[0]);
  assert.deepEqual(w.calls.commands, [], "no command");
  assert.deepEqual(w.changes, [], "the host was not told of a change");
  assert.ok(w.calls.reads.length > 0 && w.calls.reads.every((name) => READS.includes(name)), `only the three reads: ${[...new Set(w.calls.reads)].join()}`);
  assert.equal(JSON.stringify(w.real.game.snapshot()), before, "mounting and refreshing changed nothing in the engine");
  // the empty state
  const empty = setup();
  assert.ok(shows(empty.container, "분담금 계약이 없습니다") && shows(empty.container, "분담금 계약 0건"));
});

test("the whole lifecycle through button clicks: draft, propose, agree, fund, release; cash and the ledger move only at release, once", () => {
  const ctx = setup();
  const { real, container } = ctx;
  const cash0 = real.game.ledger.cash;
  const id = draftIt(ctx);
  assert.equal(id, "new-town-rail-contribution:1");
  const draft = real.newTownRailContributionReport(id)[0];
  assert.deepEqual([draft.status, draft.payerKind, draft.payeeKind, draft.statedPurpose, draft.statedAmountYen, draft.phaseIds, draft.linkedProjectIds, draft.linkedPlanIds, draft.linkedStationSiteIds], ["draft", "municipality", "player-railway", "station", AMOUNT, [P1], null, ["plan:1"], ["site:1"]]);
  assert.deepEqual(draft.conditions, [{ conditionId: "c1", text: "The station opens before phase 1 is serviced" }]);
  assert.equal(ctx.panel.selected, id, "the new draft is selected");
  assert.equal(fieldNode(container, "분담 금액(엔)").value, "", "the draft form starts empty again: nothing is carried over to the next draft");
  assert.equal(fieldNode(container, "부담자 종류").value, "");
  assert.deepEqual(ctx.calls.commands, ["draftNewTownRailContribution"]);
  assert.equal(ctx.changes.length, 1);
  assert.ok(shows(container, "초안 만들기 완료"));

  click(buttonOf(cardOf(container, id), "propose"));
  assert.equal(real.newTownRailContributionReport(id)[0].status, "proposed");
  assert.ok(shows(cardOf(container, id), "현금은 만들어지지 않습니다"), "the agree button says so");
  click(buttonOf(cardOf(container, id), "agree"));
  assert.equal(real.newTownRailContributionReport(id)[0].status, "agreed");
  assert.equal(real.game.ledger.cash, cash0, "an agreement is not cash");

  // fund: the confirmed amount is typed by the player; nothing is filled in from the agreement
  let card = cardOf(container, id);
  click(buttonOf(card, "fund"));
  assert.ok(shows(container, "지급을 확정한 금액을 입력하세요"), "no amount, no call");
  assert.equal(ctx.calls.commands.filter((n) => n === "fundNewTownRailContribution").length, 0);
  assert.equal(fieldNode(cardOf(container, id), "확정 금액(엔)").value, "", "not pre-filled with the agreed amount");
  card = cardOf(container, id);
  setField(card, "확정 금액(엔)", String(AMOUNT - 1)); setField(card, "확정한 주체", "payer"); setField(card, "근거(문서·결의 등)", "council resolution");
  click(buttonOf(card, "fund"));
  assert.ok(shows(container, "confirmed-amount-differs-from-stated"), "the engine's refusal is shown");
  assert.equal(real.newTownRailContributionReport(id)[0].status, "agreed");
  card = cardOf(container, id);
  assert.equal(fieldNode(card, "확정 금액(엔)").value, String(AMOUNT - 1), "what was typed is kept after a refusal");
  setField(card, "확정 금액(엔)", String(AMOUNT));
  click(buttonOf(card, "fund"));
  assert.equal(real.newTownRailContributionReport(id)[0].status, "funded");
  assert.equal(real.game.ledger.cash, cash0, "a payer's confirmed payment is not cash");
  assert.equal(ledgerRows(real).length, 0);
  assert.ok(shows(cardOf(container, id), "지급 확정(현금 아님)"));

  // release: every condition must be confirmed, once
  card = cardOf(container, id);
  assert.ok(shows(card, RELEASE_NOTICE) && shows(card, "원장에 반영될 수 있음"));
  assert.ok(shows(card, `release하면 원장에 ${amountText(AMOUNT)}이 한 번 반영됩니다 (엔진 판정)`), "the engine's releaseEffect is repeated");
  click(buttonOf(card, "release"));
  assert.ok(shows(container, "condition-not-confirmed:c1"), "no confirmation, the engine refuses");
  assert.equal(real.newTownRailContributionReport(id)[0].status, "funded");
  assert.equal(ledgerRows(real).length, 0);
  card = cardOf(container, id);
  checkBox(card, "c1:").checked = true;
  setField(card, "확인 메모(선택)", "opened on schedule");
  const release = buttonOf(card, "release");
  click(release);
  assert.equal(real.newTownRailContributionReport(id)[0].status, "released");
  assert.equal(real.game.ledger.cash, cash0 + AMOUNT, "the ledger got the stated amount once");
  assert.equal(ledgerRows(real).length, 1);
  assert.deepEqual(real.newTownRailContributionReport(id)[0].release.conditionConfirmations, [{ conditionId: "c1", note: "opened on schedule" }]);
  assert.deepEqual(ctx.calls.commands.filter((n) => n === "releaseNewTownRailContribution"), ["releaseNewTownRailContribution", "releaseNewTownRailContribution"], "two clicks reached the engine: the refused one and the accepted one");

  // a second click on the same (now stale) button is refused by the engine and counts nothing twice
  const cash1 = real.game.ledger.cash;
  click(release);
  assert.ok(shows(container, "status-not-allowed:released"), "the duplicate is refused");
  assert.equal(real.game.ledger.cash, cash1);
  assert.equal(ledgerRows(real).length, 1, "one ledger entry, however often it is clicked");
  assert.equal(real.newTownRailContributionReport(id)[0].status, "released");
});

test("released and terminated are shown as final: no action button, the final notice, and what the engine recorded", () => {
  const ctx = setup();
  const released = drive(ctx, "released");
  const terminated = drive(ctx, "agreed");
  setField(cardOf(ctx.container, terminated), "종료 이유", "the municipality withdrew");
  click(buttonOf(cardOf(ctx.container, terminated), "terminate"));
  for (const [id, status, label] of [[released, "released", "release 완료 — 종결"], [terminated, "terminated", "종료 — 종결"]]) {
    const card = cardOf(ctx.container, id);
    assert.equal(ctx.real.newTownRailContributionReport(id)[0].status, status);
    assert.ok(hasClass(card, "terminal") && hasClass(card, status));
    assert.deepEqual(all(card, (n) => n.tag === "button" && hasClass(n, "ntrc-act")), [], `${status}: no action button`);
    assert.ok(shows(card, `${label} — ${TERMINAL_NOTICE}`));
    assert.equal(all(card, (n) => hasClass(n, "ntrc-step")).length, 0, `${status}: no steps offered`);
  }
  assert.ok(shows(cardOf(ctx.container, released), "반영됨(원장 항목"));
  assert.ok(shows(cardOf(ctx.container, terminated), "the municipality withdrew") && shows(cardOf(ctx.container, terminated), "합의됨"));
  // a final contribution cannot be driven even through the engine
  assert.throws(() => ctx.real.terminateNewTownRailContribution(released, "undo"), /status-not-allowed:released/);
});

test("null, 0 and [] read differently: amount, phases, links and conditions", () => {
  assert.equal(amountText(null), "미명시(null) — 금액을 말하지 않음");
  assert.equal(amountText(0), "0엔 — 0으로 명시함");
  assert.equal(amountText(1234567), "1,234,567엔");
  assert.equal(phaseText(null), "미지정(null) — 개발 전체");
  assert.equal(phaseText([]), "연결 단계 없음으로 명시함([])");
  assert.equal(phaseText(["a", "b"]), "a, b");
  assert.equal(idListText(null), "미명시(null)");
  assert.equal(idListText([]), "없음으로 명시함([])");
  assert.equal(conditionsText(null), "조건 미명시(null)");
  assert.equal(conditionsText([]), "조건 없음으로 명시함([])");
  assert.equal(new Set([amountText(null), amountText(0)]).size, 2);
  const ctx = setup();
  const unstated = draftIt(ctx, { amount: "", phaseMode: "unstated", planMode: "unstated", siteMode: "unstated", conditionMode: "unstated" });
  const stated = draftIt(ctx, { amount: "0", phaseMode: "none", projectMode: "none", planMode: "none", siteMode: "none", conditionMode: "none" });
  const a = cardOf(ctx.container, unstated); const b = cardOf(ctx.container, stated);
  assert.equal(ctx.real.newTownRailContributionReport(unstated)[0].statedAmountYen, null);
  assert.ok(Object.is(ctx.real.newTownRailContributionReport(stated)[0].statedAmountYen, 0));
  assert.equal(factOf(a, "분담 금액"), amountText(null));
  assert.equal(factOf(b, "분담 금액"), amountText(0));
  assert.equal(factOf(a, "연결 단계"), phaseText(null));
  assert.equal(factOf(b, "연결 단계"), phaseText([]));
  assert.equal(factOf(a, "연결 프로젝트"), idListText(null));
  assert.equal(factOf(b, "연결 프로젝트"), idListText([]));
  assert.equal(factOf(a, "조건"), conditionsText(null));
  assert.equal(factOf(b, "조건"), conditionsText([]));
  assert.deepEqual(ctx.real.newTownRailContributionReport(stated)[0].phaseIds, []);
  assert.equal(ctx.real.newTownRailContributionReport(unstated)[0].phaseIds, null);
});

test("an amount is only a whole number the player typed: nothing is computed, completed or accepted in another form", () => {
  const ctx = setup();
  for (const bad of ["3,000", "1.5", "-1", "abc", "1e3", "2*3", "３０００", " 0x10", "10 000", "9007199254740993"]) {
    const before = ctx.calls.commands.length;
    fillDraft(ctx, { amount: bad });
    click(buttonOf(ctx.container, "draft"));
    assert.equal(ctx.calls.commands.length, before, `${bad}: the engine was not called`);
    assert.ok(shows(ctx.container, bad === "9007199254740993" ? "금액이 너무 큽니다" : "금액은 0 이상의 정수(엔)만 입력할 수 있습니다"), bad);
  }
  assert.equal(ctx.real.newTownRailContributionReport().length, 0);
  const id = draftIt(ctx, { amount: "  42  " });
  assert.equal(ctx.real.newTownRailContributionReport(id)[0].statedAmountYen, 42, "only surrounding blanks are ignored");
  // the development's own facts are in the engine (an occupancy fact of 9000 residents) and are not read into any amount
  const dev = ctx.development.id;
  ctx.real.agreeNewTownDevelopment(dev, { burdens: [{ itemId: "land", bearers: ["developer"] }] }, { geometry: ctx.world.geometries[0] });
  ctx.real.startNewTownServicing(dev, { geometry: ctx.world.geometries[0] });
  ctx.real.recordNewTownOccupancy(dev, P1, { statedOccupiedUnits: 9000, unit: "residents", source: "survey" }, { geometry: ctx.world.geometries[0] });
  ctx.panel.refresh();
  const blank = draftIt(ctx, { amount: "" });
  assert.equal(ctx.real.newTownRailContributionReport(blank)[0].statedAmountYen, null);
  assert.ok(!shows(cardOf(ctx.container, blank), "9,000") && !shows(cardOf(ctx.container, blank), "9000"));
  // nothing is chosen for the player
  const keys = { "개발 기록 (E1)": "developmentRecordId", "부담자 종류": "payerKind", "수령자 종류": "payeeKind", 목적: "statedPurpose" };
  for (const [label, key] of Object.entries(keys)) {
    fillDraft(ctx, { [key]: "" });
    const before = ctx.calls.commands.length;
    click(buttonOf(ctx.container, "draft"));
    assert.equal(ctx.calls.commands.length, before, `${label} is required`);
    assert.ok(shows(ctx.container, "선택(입력)하세요 — 기본값이 없습니다"), label);
  }
  // a list the player chose to type but left empty is a mistake, not a "none"
  const count = ctx.calls.commands.length;
  fillDraft(ctx, { projectMode: "list", projectText: "  " });
  click(buttonOf(ctx.container, "draft"));
  assert.equal(ctx.calls.commands.length, count);
  assert.ok(shows(ctx.container, "비어 있습니다"));
  fillDraft(ctx, { conditionMode: "list", conditionText: "no colon here" });
  click(buttonOf(ctx.container, "draft"));
  assert.equal(ctx.calls.commands.length, count);
  assert.ok(shows(ctx.container, "조건ID: 내용"));
});

test("a map that is stale, from another pack, inactive, missing or a cancelled development never gets a forward step through; the engine's blockers are shown", () => {
  const cases = {
    "stale revision": [(g) => ({ ...g, developmentRevision: "new-town-revision:0000000000000000" }), ["geometry-stale", "geometry-revision-changed"], "revision 다름"],
    "other pack": [(g) => ({ ...g, sourcePackId: "other-pack" }), ["geometry-stale", "geometry-source-pack-changed"], "팩 ID 다름"],
    "pack version": [(g) => ({ ...g, sourcePackVersion: "9.9.9" }), ["geometry-stale", "geometry-source-pack-version-changed"], "팩 버전 다름"],
    inactive: [(g) => ({ ...g, active: false }), ["geometry-inactive"], "활성 아니오"],
    "no pack in the geometry": [(g) => ({ ...g, sourcePackId: null }), ["geometry-invalid", "geometry-source-pack-unknown"], "팩 ID 미상"],
  };
  for (const [name, [make, codes, linkLine]] of Object.entries(cases)) {
    const ctx = setup();
    const id = drive(ctx, "draft");
    ctx.world.geometries = [make(ctx.world.geometries[0])];
    ctx.panel.refresh();
    const card = cardOf(ctx.container, id);
    for (const code of codes) assert.ok(shows(card, `(${code})`), `${name}: ${code} shown`);
    assert.ok(shows(card, linkLine), `${name}: link facts say "${linkLine}"`);
    assert.ok(hasClass(buttonOf(card, "propose"), "engine-blocked"));
    click(buttonOf(card, "propose"));
    assert.equal(ctx.real.newTownRailContributionReport(id)[0].status, "draft", `${name}: not proposed`);
    const refusal = all(ctx.container, (n) => hasClass(n, "ntrc-error")).map((n) => n.textContent).join(" ");
    assert.ok(refusal.includes("제안(propose) 실패"), name);
    for (const code of codes) assert.ok(refusal.includes(code), `${name}: the engine's refusal itself names ${code} (so the panel sent the map as it is)`);
    // stopping is still possible
    setField(cardOf(ctx.container, id), "종료 이유", "map changed");
    click(buttonOf(cardOf(ctx.container, id), "terminate"));
    assert.equal(ctx.real.newTownRailContributionReport(id)[0].status, "terminated", `${name}: terminate needs no map`);
  }
  // the geometry is missing from the export, or two geometries share the id
  for (const [name, geometries, line] of [["not in the export", [], "지도 export에 이 개발 ID의 geometry가 없음"], ["ambiguous", [scenarioGeometry(), scenarioGeometry()], "같은 개발 ID가 여럿"]]) {
    const ctx = setup();
    const id = drive(ctx, "agreed");
    ctx.world.geometries = geometries;
    ctx.panel.refresh();
    const card = cardOf(ctx.container, id);
    assert.ok(shows(card, line), name);
    assert.ok(shows(card, "(geometry-missing)"), name);
    setField(card, "확정 금액(엔)", String(AMOUNT)); setField(card, "확정한 주체", "payer"); setField(card, "근거(문서·결의 등)", "resolution");
    click(buttonOf(card, "fund"));
    assert.equal(ctx.real.newTownRailContributionReport(id)[0].status, "agreed", name);
    assert.ok(shows(ctx.container, "geometry-missing"), name);
  }
  // an export that cannot be read at all
  const unreadable = setup({ mountIt: false });
  unreadable.options.getGeometryExport = () => { throw new Error("export broke"); };
  const panel = mountNewTownRailContributionManagementPanel(unreadable.options);
  const unreadableId = unreadable.real.draftNewTownRailContribution({ developmentRecordId: unreadable.development.id, payerKind: "municipality", payeeKind: "other", statedPurpose: "access" }).contributionId;
  panel.refresh();
  assert.ok(shows(cardOf(unreadable.container, unreadableId), "지도 export를 읽을 수 없음"));
  assert.ok(shows(cardOf(unreadable.container, unreadableId), "(geometry-missing)"));
  // a cancelled development: the engine refuses even though the map is current
  const ctx = setup();
  const funded = drive(ctx, "funded");
  ctx.real.cancelNewTownDevelopment(ctx.development.id, "the town was dropped");
  ctx.panel.refresh();
  const card = cardOf(ctx.container, funded);
  assert.ok(shows(card, "(development-cancelled)") && shows(card, "E1 개발 기록: 상태 cancelled"));
  checkBox(card, "c1:").checked = true;
  click(buttonOf(card, "release"));
  assert.equal(ctx.real.newTownRailContributionReport(funded)[0].status, "funded");
  assert.equal(ledgerRows(ctx.real).length, 0, "a cancelled development releases no money");
  assert.ok(shows(ctx.container, "development-cancelled"));
});

test("release needs each condition confirmed exactly once, by the player; the panel sends only what was ticked", () => {
  const ctx = setup();
  const id = drive(ctx, "agreed", { conditionText: "c1: Station opens\nc2: Depot land handed over" });
  let card = cardOf(ctx.container, id);
  setField(card, "확정 금액(엔)", String(AMOUNT)); setField(card, "확정한 주체", "payer"); setField(card, "근거(문서·결의 등)", "resolution");
  click(buttonOf(card, "fund"));
  card = cardOf(ctx.container, id);
  assert.equal(boxes(card).length, 2, "one confirmation per stated condition");
  assert.ok(shows(card, "c1: Station opens — 충족을 확인함") && shows(card, "c2: Depot land handed over — 충족을 확인함"));
  assert.ok(boxes(card).every((box) => box.checked === false), "nothing is pre-confirmed");
  checkBox(card, "c1:").checked = true;
  click(buttonOf(card, "release"));
  assert.ok(shows(ctx.container, "condition-not-confirmed:c2"));
  assert.equal(ledgerRows(ctx.real).length, 0);
  assert.equal(ctx.real.newTownRailContributionReport(id)[0].status, "funded");
  card = cardOf(ctx.container, id);
  assert.equal(checkBox(card, "c1:").checked, true, "a ticked box stays ticked after a refusal");
  assert.equal(checkBox(card, "c2:").checked, false);
  assert.ok(shows(card, "(condition-not-confirmed:c2)"), "the engine's assessment lists the missing one");
  checkBox(card, "c2:").checked = true;
  click(buttonOf(card, "release"));
  assert.equal(ctx.real.newTownRailContributionReport(id)[0].status, "released");
  assert.deepEqual(ctx.real.newTownRailContributionReport(id)[0].release.conditionConfirmations.map((c) => c.conditionId), ["c1", "c2"]);
  assert.equal(ledgerRows(ctx.real).length, 1);
  // stated "none": nothing to confirm, and the screen says so
  const none = drive(ctx, "funded", { conditionMode: "none" });
  assert.ok(shows(cardOf(ctx.container, none), "확인할 조건이 없습니다 — 조건 없음으로 명시됨([])"));
  click(buttonOf(cardOf(ctx.container, none), "release"));
  assert.equal(ctx.real.newTownRailContributionReport(none)[0].status, "released");
});

test("the linked plans, station sites and projects are checked by the engine with what the host says is current; nothing is assumed", () => {
  const ctx = setup();
  const id = drive(ctx, "funded", { projectMode: "list", projectText: "project:1" });
  ctx.world.links = { planIds: ["plan:9"], stationSiteIds: ["site:1"] };
  ctx.panel.refresh();
  let card = cardOf(ctx.container, id);
  assert.ok(shows(card, "(linked-plan-not-current:plan:1)"));
  checkBox(card, "c1:").checked = true;
  click(buttonOf(card, "release"));
  assert.equal(ledgerRows(ctx.real).length, 0);
  assert.ok(shows(ctx.container, "linked-plan-not-current:plan:1"));
  ctx.world.links = null;
  ctx.panel.refresh();
  assert.ok(shows(cardOf(ctx.container, id), "(linked-plans-not-verifiable)") && shows(cardOf(ctx.container, id), "(linked-station-sites-not-verifiable)"));
  ctx.world.links = { planIds: ["plan:1"], stationSiteIds: ["site:1"] };
  ctx.real.game.projects[0].status = "cancelled";
  ctx.panel.refresh();
  assert.ok(shows(cardOf(ctx.container, id), "(linked-project-cancelled:project:1)"));
  ctx.real.game.projects[0].status = "active";
  ctx.panel.refresh();
  card = cardOf(ctx.container, id);
  checkBox(card, "c1:").checked = true;
  click(buttonOf(card, "release"));
  assert.equal(ctx.real.newTownRailContributionReport(id)[0].status, "released");
  assert.equal(ledgerRows(ctx.real).length, 1);
});

test("the release effect shown is the engine's: it posts only for a payer other than the player paying the player's side", () => {
  const ctx = setup();
  const cases = [
    [{ payerKind: "municipality", payeeKind: "player-railway" }, /원장에 3,000,000,000엔이 한 번 반영됩니다/, AMOUNT, true],
    [{ payerKind: "player", payeeKind: "player-railway" }, /원장에는 반영되지 않습니다 — payer-is-the-player-no-cash-created/, AMOUNT, false],
    [{ payerKind: "developer", payeeKind: "other" }, /원장에는 반영되지 않습니다 — payee-is-not-the-player-side/, AMOUNT, false],
    [{ payerKind: "developer", payeeKind: "player-railway", amount: "0" }, /원장에는 반영되지 않습니다 — stated-zero/, 0, false],
  ];
  for (const [over, pattern, amount, posts] of cases) {
    const id = drive(ctx, "funded", over);
    const card = cardOf(ctx.container, id);
    assert.ok(texts(card).some((t) => pattern.test(t)), `${JSON.stringify(over)}: ${texts(card).filter((t) => t.includes("release")).join(" | ")}`);
    const cashBefore = ctx.real.game.ledger.cash;
    checkBox(card, "c1:").checked = true;
    click(buttonOf(card, "release"));
    assert.equal(ctx.real.game.ledger.cash, cashBefore + (posts ? amount : 0), JSON.stringify(over));
    assert.equal(ctx.real.newTownRailContributionReport(id)[0].release.ledgerEffect, posts ? "posted" : "none");
  }
  assert.equal(ledgerRows(ctx.real).length, 1);
});

test("a failed transaction leaves the contribution, cash, ledger and the engine state exactly as they were, and the panel says so", () => {
  const ctx = setup();
  const id = drive(ctx, "funded");
  const before = JSON.stringify(ctx.real.game.snapshot());
  const cash = ctx.real.game.ledger.cash;
  const real = ctx.real.game.ledger.assertInvariant.bind(ctx.real.game.ledger);
  ctx.real.game.ledger.assertInvariant = () => { throw new Error("ledger broke after the step"); };
  const card = cardOf(ctx.container, id);
  checkBox(card, "c1:").checked = true;
  const changes = ctx.changes.length;
  click(buttonOf(card, "release"));
  ctx.real.game.ledger.assertInvariant = real;
  assert.ok(shows(ctx.container, "release 실패") && shows(ctx.container, "ledger broke after the step"));
  assert.equal(JSON.stringify(ctx.real.game.snapshot()), before, "state, ledger, rng, events and counters are all back");
  assert.equal(ctx.real.game.ledger.cash, cash);
  assert.equal(ledgerRows(ctx.real).length, 0);
  assert.equal(ctx.real.newTownRailContributionReport(id)[0].status, "funded");
  assert.equal(ctx.changes.length, changes, "no change was announced");
  assert.ok(buttonOf(cardOf(ctx.container, id), "release"), "the player can try again");
  // the retry works and counts once
  const retry = cardOf(ctx.container, id);
  checkBox(retry, "c1:").checked = true;
  click(buttonOf(retry, "release"));
  assert.equal(ledgerRows(ctx.real).length, 1);
  assert.equal(ctx.real.game.ledger.cash, cash + AMOUNT);
  assert.equal(ctx.changes.length, changes + 1);
});

test("delay, resume and terminate are buttons too, with the reason the player gives", () => {
  const ctx = setup();
  const id = drive(ctx, "agreed");
  let card = cardOf(ctx.container, id);
  click(buttonOf(card, "delay"));
  assert.ok(shows(ctx.container, "지연 이유을(를) 선택(입력)하세요"));
  assert.equal(ctx.real.newTownRailContributionReport(id)[0].status, "agreed");
  card = cardOf(ctx.container, id);
  setField(card, "지연 이유", "budget is late");
  click(buttonOf(card, "delay"));
  assert.equal(ctx.real.newTownRailContributionReport(id)[0].status, "delayed");
  card = cardOf(ctx.container, id);
  assert.ok(shows(card, "budget is late") && shows(card, "아직 재개 안 함"));
  assert.equal(buttonOf(card, "fund"), undefined, "a delayed contribution cannot be funded");
  click(buttonOf(card, "resume"));
  assert.equal(ctx.real.newTownRailContributionReport(id)[0].status, "agreed");
  card = cardOf(ctx.container, id);
  setField(card, "종료 이유", "the town was redesigned");
  click(buttonOf(card, "terminate"));
  assert.equal(ctx.real.newTownRailContributionReport(id)[0].termination.reason, "the town was redesigned");
  assert.deepEqual(ctx.calls.commands.filter((n) => /delay|resume|terminate/.test(n)), ["delayNewTownRailContribution", "resumeNewTownRailContribution", "terminateNewTownRailContribution"], "the click without a reason reached no engine call");
});

test("the development record, the contribution and the map are linked by developmentId + revision + pack and shown as facts", () => {
  const ctx = setup();
  const id = drive(ctx, "draft");
  const card = cardOf(ctx.container, id);
  assert.equal(factOf(card, "개발 기록 ID (E1)"), ctx.development.id);
  assert.equal(factOf(card, "개발 ID (지도)"), EXAMPLE.developmentId);
  assert.equal(factOf(card, "개발 revision"), EXAMPLE.developmentRevision);
  assert.equal(factOf(card, "팩"), "ntrc-panel 1");
  assert.ok(shows(card, "지도 geometry: revision 일치 · 팩 ID 일치 · 팩 버전 일치 · 활성 예"));
  assert.ok(shows(card, "E1 개발 기록: 상태 proposed · 개발 ID 일치 · revision 일치 · 팩 ID 일치 · 팩 버전 일치"));
  const result = ctx.panel.results()[0];
  assert.deepEqual([result.contributionId, result.status, result.terminal, result.link.geometry.found, result.link.geometry.sourcePackId, result.link.record.status], [id, "draft", false, true, "same", "proposed"]);
  assert.equal(result.hooks.hookId, id);
  assert.deepEqual(result.assessment.transitions.propose, { allowed: true, blockers: [] });
  assert.ok(shows(card, "지금 가능(엔진 판정)"));
  // an E1 record list that does not know the record
  const ctx2 = setup({ mountIt: false });
  ctx2.options.getNewTownDevelopments = () => [];
  const panel = mountNewTownRailContributionManagementPanel(ctx2.options);
  const id2 = ctx2.real.draftNewTownRailContribution({ developmentRecordId: ctx2.development.id, payerKind: "municipality", payeeKind: "other", statedPurpose: "access" }).contributionId;
  panel.refresh();
  assert.ok(shows(cardOf(ctx2.container, id2), "E1 개발 기록 목록에 이 기록이 없음"));
  assert.ok(shows(ctx2.container, "(개발 기록을 고르세요)") && !all(ctx2.container, (n) => n.tag === "option").some((o) => o.value === ctx2.development.id), "the draft form offers only the records it was given");
});

test("only the selection and the draft form are saved: serialize / loadDoc are strict, call no command, and carry no contribution data", () => {
  const ctx = setup();
  const id = drive(ctx, "agreed");
  fillDraft(ctx, { amount: "777", payerKind: "developer", conditionMode: "none" });
  setField(ctx.container, "이름(선택)", "second draft");
  const commandsBefore = ctx.calls.commands.length;
  const text = ctx.panel.serialize();
  const doc = JSON.parse(text);
  assert.deepEqual(Object.keys(doc).sort(), ["draft", "schema", "selectedContributionId", "version"]);
  assert.equal(doc.schema, PANEL_DOC_SCHEMA);
  assert.equal(doc.selectedContributionId, id);
  assert.deepEqual([doc.draft.amount, doc.draft.payerKind, doc.draft.conditionMode, doc.draft.name], ["777", "developer", "none", "second draft"]);
  assert.ok(!/statedAmountYen|3000000000|history|ledger|"status"/.test(text), "no contribution data in the document");
  assert.deepEqual(ctx.panel.document, doc);
  // a fresh panel on the same engine state restores the selection and the draft, and still calls no command
  const other = setup({ mountIt: false });
  other.real.game.restore(ctx.real.game.snapshot());
  const panel = mountNewTownRailContributionManagementPanel(other.options);
  assert.deepEqual(panel.loadDoc(text), { ok: true, issues: [] });
  assert.equal(panel.selected, id);
  assert.equal(fieldNode(other.container, "분담 금액(엔)").value, "777");
  assert.equal(fieldNode(other.container, "부담자 종류").value, "developer");
  assert.equal(fieldNode(other.container, "이름(선택)").value, "second draft");
  assert.deepEqual(other.calls.commands, []);
  assert.equal(ctx.calls.commands.length, commandsBefore, "serialize called no command");
  // bad documents are refused whole and change nothing
  const before = panel.serialize();
  for (const bad of ["not json", "{}", JSON.stringify({ ...doc, schema: "other/1" }), JSON.stringify({ ...doc, version: 2 }), JSON.stringify({ ...doc, selectedContributionId: 5 }),
    JSON.stringify({ ...doc, draft: { ...doc.draft, amount: 777 } }), JSON.stringify({ ...doc, draft: { ...doc.draft, surprise: "x" } }), JSON.stringify({ ...doc, draft: { ...doc.draft, phaseMode: "maybe" } }), JSON.stringify({ ...doc, draft: "x" })]) {
    const result = panel.loadDoc(bad);
    assert.equal(result.ok, false, bad.slice(0, 40));
    assert.ok(result.issues.length > 0);
  }
  assert.equal(panel.serialize(), before);
  assert.deepEqual(restorePanelDoc(newPanelDoc()).issues, []);
  assert.throws(() => serializePanelDoc({ schema: "x" }), /invalid/);
  assert.equal(JSON.parse(serializePanelDoc(newPanelDoc())).draft.phaseMode, "unstated");
});

test("typed input survives a redraw; blockers are explained in words with the engine's code kept beside them", () => {
  const ctx = setup();
  const id = drive(ctx, "agreed");
  let card = cardOf(ctx.container, id);
  setField(card, "확정 금액(엔)", "123"); setField(card, "근거(문서·결의 등)", "typed but not sent");
  click(all(card, (n) => hasClass(n, "ntrc-select-card"))[0]); // deselects (the new draft was selected)
  card = cardOf(ctx.container, id);
  assert.equal(fieldNode(card, "확정 금액(엔)").value, "123");
  assert.equal(fieldNode(card, "근거(문서·결의 등)").value, "typed but not sent");
  assert.ok(!hasClass(card, "selected"));
  click(all(card, (n) => hasClass(n, "ntrc-select-card"))[0]); // selects
  card = cardOf(ctx.container, id);
  assert.equal(fieldNode(card, "확정 금액(엔)").value, "123");
  assert.ok(hasClass(card, "selected") && shows(card, "자세히 (엔진이 기록한 그대로)") && shows(card, `${id}:transition:3 · agree`));
  assert.ok(shows(card, "단계 hook ID") && shows(card, "계산하지 않는 것:"));
  assert.equal(blockerText("geometry-stale"), "지도 geometry가 낡음(stale) (geometry-stale)");
  assert.equal(blockerText("condition-not-confirmed:c9"), "확인하지 않은 조건 (condition-not-confirmed:c9)");
  assert.equal(blockerText("brand-new-code"), "brand-new-code", "an unknown code is shown as it is");
});

test("frozen inputs are fine, the panel changes none of them, and a throwing getter is shown as missing data, not as a pass", () => {
  const ctx = setup({ mountIt: false });
  const geometries = deepFreeze([scenarioGeometry()]);
  const links = deepFreeze({ planIds: ["plan:1"], stationSiteIds: ["site:1"] });
  ctx.options.getGeometryExport = () => deepFreeze({ schema: "transitline.new-town-development-export/1", developments: geometries });
  ctx.options.getCurrentLinks = () => links;
  mountNewTownRailContributionManagementPanel(ctx.options);
  const id = draftIt(ctx);
  click(buttonOf(cardOf(ctx.container, id), "propose"));
  assert.equal(ctx.real.newTownRailContributionReport(id)[0].status, "proposed");
  assert.equal(JSON.stringify(geometries), JSON.stringify([scenarioGeometry()]));
  const broken = setup({ mountIt: false });
  broken.options.getCurrentLinks = () => { throw new Error("links broke"); };
  broken.options.getNewTownDevelopments = () => { throw new Error("records broke"); };
  mountNewTownRailContributionManagementPanel(broken.options);
  const id2 = draftIt(broken);
  assert.ok(id2);
  const card = cardOf(broken.container, id2);
  assert.ok(shows(card, "E1 개발 기록 목록에 이 기록이 없음"));
  click(buttonOf(card, "propose"));
  assert.equal(broken.real.newTownRailContributionReport(id2)[0].status, "proposed", "the engine alone decides; the host's failing record list is only display");
  // links the host cannot give are not "current": release is refused
  const funded = drive(broken, "funded");
  const fundedCard = cardOf(broken.container, funded);
  assert.ok(shows(fundedCard, "(linked-plans-not-verifiable)"));
  checkBox(fundedCard, "c1:").checked = true;
  click(buttonOf(fundedCard, "release"));
  assert.equal(broken.real.newTownRailContributionReport(funded)[0].status, "funded");
  assert.equal(ledgerRows(broken.real).length, 0);
});

test("the module keeps its promises: no storage, no timer, no engine internals, no money arithmetic, only the contribution API", () => {
  const source = read("../src/new-town-rail-contribution-management-panel.mjs").replace(/^\s*\/\/.*$/gm, "");
  const code = source.replace(/"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g, '""');
  assert.deepEqual([...source.matchAll(/^import .*$/gm)].map((m) => m[0]), [], "it imports nothing");
  assert.ok(!/localStorage|sessionStorage|indexedDB|document\.cookie|setTimeout|setInterval|requestAnimationFrame|Date\.|Math\.random|performance\.now/.test(code));
  assert.ok(!/runtime\.game|runtime\.ledger|\.cash\b|\boperationalState\b|\.snapshot\(|\.restore\(|\.transact\(/.test(code), "no engine internals, ledger or cash");
  assert.ok(!/areaSquareMeters|statedSupply|occupancyFacts|statedOccupiedUnits|playerDeclaredLandUse|residents|jobs|population|demandNode|demand-engine/.test(code), "nothing about the development's size, use, people or occupancy is read");
  assert.ok(!/\bamount\w*\s*[*/+-]\s*\w|[*/]\s*amount|\bparseFloat\b|\btoFixed\b|\bMath\./.test(code), "no amount is computed");
  const used = new Set([...code.matchAll(/runtime\.(\w+)/g)].map((m) => m[1]));
  assert.deepEqual([...used].sort(), [...COMMANDS, ...READS].sort(), "exactly the eight commands and three reads");
  // every command call sits in the click path (draftNow / stepNow), never in mount, refresh or the readers
  for (const name of COMMANDS) {
    for (const at of [...code.matchAll(new RegExp(`runtime\\.${name}\\(`, "g"))].map((m) => m.index)) {
      const before = code.slice(0, at);
      const enclosing = Math.max(before.lastIndexOf("function draftNow"), before.lastIndexOf("const stepNow"));
      assert.ok(enclosing >= 0 && !/function (refresh|recompute|draftForm|card|assessInput)\b/.test(before.slice(enclosing)), `${name} is only called from draftNow / stepNow`);
    }
  }
  assert.ok(SCOPE_NOTICE.includes("계산하거나 추정하지 않습니다") && RELEASE_NOTICE.includes("직접 고치지 않습니다"));
});
