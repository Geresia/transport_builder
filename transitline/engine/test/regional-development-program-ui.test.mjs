import test from "node:test";
import assert from "node:assert/strict";
import { parseReferenceList, REGIONAL_DEVELOPMENT_PROGRAM_UI_NOTICE, mountRegionalDevelopmentProgramEditor } from "../src/map/regional-development-program-ui.mjs";

class Node_ { constructor(tag) { Object.assign(this, { tag, children: [], className: "", textContent: "", value: "", listeners: {}, type: "" }); } append(...items) { this.children.push(...items); } replaceChildren(...items) { this.children = []; this.append(...items); } addEventListener(type, listener) { (this.listeners[type] ??= []).push(listener); } fire(type) { for (const listener of this.listeners[type] ?? []) listener({ type }); } }
const dom = { createElement: (tag) => new Node_(tag) };
const root = () => Object.assign(new Node_("div"), { ownerDocument: dom });
const all = (node) => [node, ...node.children.flatMap(all)];
const byClass = (node, name) => all(node).filter((item) => String(item.className).split(" ").includes(name));
const text = (node) => all(node).map((item) => item.textContent).filter(Boolean);
const click = (node, name) => { const item = byClass(node, name)[0]; assert.ok(item, name); item.fire("click"); };
const pack = { manifest: { id: "example-radial", version: "1", data: { license: "CC0", attribution: [] } } };

test("reference list syntax keeps unstated null distinct from an explicit empty declaration", () => {
  assert.equal(parseReferenceList(""), null);
  assert.deepEqual(parseReferenceList("[]"), []);
  assert.deepEqual(parseReferenceList(" b, a, b "), ["a", "b"]);
  assert.throws(() => parseReferenceList("a,,b"), /Reference IDs/);
});

test("mount edits only a B20-M1 document and emits an export on explicit actions", () => {
  const container = root(); const changes = [];
  const panel = mountRegionalDevelopmentProgramEditor({ container, pack, onChange: (output) => changes.push(output) });
  assert.ok(text(container).includes(REGIONAL_DEVELOPMENT_PROGRAM_UI_NOTICE));
  assert.equal(changes.length, 0);
  click(container, "regional-program-add");
  assert.equal(changes.length, 1);
  const program = panel.output().document.programs[0];
  assert.equal(panel.output().export.programs.length, 1);
  panel.addMilestone(program.key, { linkedDevelopmentIds: [], targetMonth: 0 });
  const milestone = panel.output().export.programs[0].milestones[0];
  assert.deepEqual(milestone.linkedDevelopmentIds, []);
  assert.equal(milestone.targetMonth, 0);
});

test("sources are passed only to the map export, while missing source collections stay unknown", () => {
  const panel = mountRegionalDevelopmentProgramEditor({ container: root(), pack });
  const program = panel.addProgram({ key: "p" });
  panel.addMilestone(program.key, { linkedDevelopmentIds: ["new-town:1"] });
  const result = panel.output().export.programs[0];
  assert.equal(result.linkFacts[0].found, null);
  assert.ok(result.unknown.includes("linkFacts:development"));
});

test("serialized documents restore for the same pack and refuse another pack without replacing current work", () => {
  const panel = mountRegionalDevelopmentProgramEditor({ container: root(), pack });
  panel.addProgram({ key: "kept" }); const saved = panel.serialize();
  const other = JSON.stringify({ ...JSON.parse(saved), packId: "tokyo" });
  panel.loadDoc(other);
  assert.equal(panel.output().document.programs[0].key, "kept");
  assert.equal(panel.output().warnings[0], "program-document-other-pack");
  const restored = mountRegionalDevelopmentProgramEditor({ container: root(), pack }); restored.loadDoc(saved);
  assert.equal(restored.output().document.programs[0].key, "kept");
});

test("output is detached and the editor can be destroyed without any runtime command", () => {
  const container = root(); const panel = mountRegionalDevelopmentProgramEditor({ container, pack });
  panel.addProgram({ key: "a" }); const output = panel.output(); output.document.programs[0].key = "mutated";
  assert.equal(panel.output().document.programs[0].key, "a");
  panel.destroy(); assert.equal(container.children.length, 0);
  panel.refresh(); assert.equal(container.children.length, 0);
});
