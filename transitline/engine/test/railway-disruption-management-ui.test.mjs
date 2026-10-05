import test from "node:test";
import assert from "node:assert/strict";
import { buildRailwayDisruptionManagementView, mountRailwayDisruptionManagementPanel } from "../src/railway-disruption-management-ui.mjs";

class Node_ {
  constructor(tag) { Object.assign(this, { tag, children: [], className: "", textContent: "", value: "", disabled: false, listeners: {} }); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  addEventListener(type, handler) { (this.listeners[type] ??= []).push(handler); }
  fire(type) { for (const handler of this.listeners[type] ?? []) handler({ type }); }
}
const doc = { createElement: (tag) => new Node_(tag) };
const box = () => Object.assign(new Node_("div"), { ownerDocument: doc });
const all = (root, predicate = () => true) => [predicate(root) ? root : null, ...root.children.flatMap((entry) => all(entry, predicate))].filter(Boolean);
const find = (root, tag, content) => all(root, (entry) => entry.tag === tag && entry.textContent === content)[0];
const deepFreeze = (value) => { if (value && typeof value === "object") { Object.values(value).forEach(deepFreeze); Object.freeze(value); } return value; };
const event = (status = "active") => ({ id: "event:1", kind: "signal-failure", status, lineId: "line:1", trackSegmentId: "track:1", blockId: null, trainId: null, expectedEndMinute: 90, effect: { closed: true, speedLimitMps: 0 }, response: null });
const options = Object.freeze([{ id: "standard-recovery", label: "Standard recovery", directCostJPY: 35_000_000, revisedRemainingMinutes: 40 }]);

function runtime(initial = event()) {
  let current = structuredClone(initial); const calls = [];
  return {
    calls,
    railwayDisruptionReport() { return { events: [structuredClone(current)] }; },
    railwayDisruptionResponseOptions(id) { assert.equal(id, "event:1"); return structuredClone(options); },
    respondRailwayDisruption(id, responseId) { calls.push({ id, responseId }); current = { ...current, status: "responding", response: { responseId, label: "Standard recovery", directCostJPY: 35_000_000, revisedRemainingMinutes: 40 } }; return current.response; },
  };
}

test("view exposes engine facts and options without deriving a disruption or effect", () => {
  const frozen = deepFreeze({ events: [event()] });
  const view = buildRailwayDisruptionManagementView({ report: frozen, responsesFor: () => options });
  assert.equal(view[0].effect.closed, true);
  assert.equal(view[0].responseOptions[0].directCostJPY, 35_000_000);
  assert.deepEqual(frozen.events[0], event());
});

test("mounting is read-only and a selected engine response is forwarded exactly once", () => {
  const game = runtime(); const host = box(); const changed = [];
  mountRailwayDisruptionManagementPanel({ container: host, runtime: game, onChange: () => changed.push(1) });
  assert.equal(game.calls.length, 0);
  const select = all(host, (entry) => entry.tag === "select")[0];
  select.value = "standard-recovery"; select.fire("change");
  find(host, "button", "Commit recovery response").fire("click");
  assert.deepEqual(game.calls, [{ id: "event:1", responseId: "standard-recovery"}]);
  assert.equal(changed.length, 1);
  assert.ok(all(host, (entry) => entry.className === "railway-disruption-response").length);
});

test("responding and resolved events remain read-only, while engine errors are shown", () => {
  for (const status of ["responding", "resolved"]) {
    const host = box(); mountRailwayDisruptionManagementPanel({ container: host, runtime: runtime(event(status)) });
    assert.equal(all(host, (entry) => entry.tag === "button" && entry.textContent === "Commit recovery response").length, 0);
  }
  const game = runtime(); game.respondRailwayDisruption = () => { throw new Error("response rejected"); };
  const host = box(); mountRailwayDisruptionManagementPanel({ container: host, runtime: game });
  const select = all(host, (entry) => entry.tag === "select")[0]; select.value = "standard-recovery"; select.fire("change");
  find(host, "button", "Commit recovery response").fire("click");
  assert.ok(all(host, (entry) => entry.className === "railway-disruption-error" && entry.textContent === "response rejected").length);
});

test("an empty report is honest and mount rejects an incomplete runtime", () => {
  const host = box();
  mountRailwayDisruptionManagementPanel({ container: host, runtime: { railwayDisruptionReport: () => ({ events: [] }), railwayDisruptionResponseOptions: () => [], respondRailwayDisruption: () => {} } });
  assert.ok(all(host, (entry) => entry.className === "railway-disruption-empty").length);
  assert.throws(() => mountRailwayDisruptionManagementPanel({ container: box(), runtime: {} }), /railwayDisruptionReport/);
});
