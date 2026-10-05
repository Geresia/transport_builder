import test from "node:test";
import assert from "node:assert/strict";
import { buildRailCapacityApplicationView, mountRailCapacityApplicationPanel } from "../src/rail-capacity-application-ui.mjs";

class Node_ {
  constructor(tag) { Object.assign(this, { tag, children: [], className: "", textContent: "", value: "", listeners: {} }); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  addEventListener(type, handler) { (this.listeners[type] ??= []).push(handler); }
  fire(type) { for (const handler of this.listeners[type] ?? []) handler({ type }); }
}
const doc = { createElement: (tag) => new Node_(tag) };
const container = () => Object.assign(new Node_("div"), { ownerDocument: doc });
const all = (root, predicate = () => true) => [predicate(root) ? root : null, ...root.children.flatMap((child) => all(child, predicate))].filter(Boolean);
const find = (root, tag, content) => all(root, (entry) => entry.tag === tag && entry.textContent === content)[0];
const geometry = Object.freeze({ schema: "transitline.rail-capacity-geometry/1", contractVersion: 1, railGeometryId: "geometry:1", railGeometryRevision: "revision:1", revision: { state: "current" }, sections: [{ sectionId: "section:1" }] });
const line = Object.freeze({ id: "line:1", name: "Blue", trackSegmentIds: ["track:1"], stationIds: ["station:1", "station:2"], suspended: false });

function runtime({ fail = null } = {}) {
  const calls = [];
  const applications = [];
  return {
    calls,
    applyRailCapacityGeometry(lineId, selected) {
      calls.push({ lineId, selected });
      if (fail) throw new Error(fail);
      const application = { operationalLineId: lineId, railGeometryId: selected.railGeometryId, railGeometryRevision: selected.railGeometryRevision, sections: [{ trackSegmentId: "track:1" }] };
      applications.push(application);
      return structuredClone(application);
    },
    railCapacityApplicationReport() { return structuredClone(applications); },
    operationalLineReport() { return [structuredClone(line)]; },
  };
}

test("the view exposes only current geometry, operational-line facts and applied mappings", () => {
  const view = buildRailCapacityApplicationView({ geometries: [geometry, { ...geometry, railGeometryId: "stale", revision: { state: "stale" } }], operationalLines: [line], applications: [] });
  assert.deepEqual(view.geometries, [{ id: "geometry:1", revision: "revision:1", sectionCount: 1 }]);
  assert.equal(view.operationalLines[0].trackSegmentCount, 1);
});

test("mounting is read-only, and a player click passes the exact selected geometry to the runtime", () => {
  const game = runtime(); const changed = [];
  const box = container();
  const panel = mountRailCapacityApplicationPanel({ container: box, runtime: game, getRailGeometries: () => [geometry], onChange: (value) => changed.push(value) });
  assert.equal(game.calls.length, 0);
  find(box, "button", "Apply rail design to line").fire("click");
  assert.equal(game.calls.length, 1);
  assert.deepEqual(game.calls[0], { lineId: "line:1", selected: geometry });
  assert.notEqual(game.calls[0].selected, geometry);
  assert.equal(changed.length, 1);
  assert.ok(all(box, (entry) => entry.className === "rail-capacity-apply-ok").length);
  panel.refresh();
});

test("engine rejection is displayed and does not publish a change", () => {
  const game = runtime({ fail: "No rail capacity section matches track:1" }); const box = container(); const changed = [];
  mountRailCapacityApplicationPanel({ container: box, runtime: game, getRailGeometries: () => [geometry], onChange: (value) => changed.push(value) });
  find(box, "button", "Apply rail design to line").fire("click");
  assert.equal(changed.length, 0);
  assert.ok(all(box, (entry) => entry.className === "rail-capacity-apply-error" && entry.textContent.includes("No rail capacity section")).length);
});

test("mount rejects an incomplete runtime and does not invent missing map or operational inputs", () => {
  assert.throws(() => mountRailCapacityApplicationPanel({ container: container(), runtime: {} }), /applyRailCapacityGeometry/);
  const box = container();
  mountRailCapacityApplicationPanel({ container: box, runtime: runtime(), getRailGeometries: () => [] });
  assert.ok(all(box, (entry) => entry.className === "rail-capacity-apply-empty").length >= 1);
});
