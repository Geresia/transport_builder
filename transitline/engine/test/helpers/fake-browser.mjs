// A minimal browser for the map mount tests: elements with children and listeners, a canvas that records its calls, a
// localStorage that can be blocked, and a window with key listeners and a (never fired) interval. No timers run: tests call
// bridge.refresh() themselves, so nothing here depends on a clock.
import assert from "node:assert/strict";

export class Node_ {
  constructor(tag, doc) { Object.assign(this, { tag, ownerDocument: doc, children: [], className: "", textContent: "", hidden: false, style: {}, listeners: {}, parentNode: null, width: 800, height: 600, id: "", type: "" }); }
  append(...kids) { for (const k of kids) { k.parentNode = this; this.children.push(k); } }
  replaceChildren(...kids) { this.children = []; this.append(...kids); }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((c) => c !== this); this.parentNode = null; }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] ?? []).filter((f) => f !== fn); }
  dispatchEvent(ev) { for (const fn of [...(this.listeners[ev.type] ?? [])]) fn(ev); return true; }
  getBoundingClientRect() { return { left: 0, top: 0, width: this.width, height: this.height }; }
  getContext() {
    this.calls ??= [];
    this.ctx ??= new Proxy({}, { get: (target, name) => (name in target ? target[name] : (...args) => { this.calls.push([name, target.strokeStyle, ...args]); }), set: (target, name, value) => { target[name] = value; if (name === "strokeStyle") this.calls.push(["set-strokeStyle", value]); return true; } });
    return this.ctx;
  }
}

export function browser({ storage = new Map(), blocked = false } = {}) {
  const win = {
    listeners: {}, intervals: 0,
    localStorage: { getItem: (k) => { if (blocked) throw new Error("blocked"); return storage.has(k) ? storage.get(k) : null; }, setItem: (k, v) => { if (blocked) throw new Error("blocked"); storage.set(k, v); } },
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }, removeEventListener(type, fn) { this.listeners[type] = (this.listeners[type] ?? []).filter((f) => f !== fn); },
    setInterval() { this.intervals += 1; return 1; }, clearInterval() {}, fire(type, ev) { for (const fn of this.listeners[type] ?? []) fn(ev); },
  };
  const doc = { defaultView: win, head: null, body: null, createElement: (tag) => new Node_(tag, doc), getElementById: (id) => doc.head.children.find((c) => c.id === id) ?? null };
  doc.head = new Node_("head", doc);
  doc.body = new Node_("body", doc);
  const canvas = new Node_("canvas", doc);
  doc.body.append(canvas);
  return { win, doc, canvas, storage };
}

export const projection = { toScreen: ([lon, lat]) => [(lon - 139) * 20000, (35.01 - lat) * 20000] };
export const screenOf = (p) => projection.toScreen(p);
export const texts = (node) => [node.textContent, ...node.children.flatMap(texts)].filter(Boolean);
export const find = (node, pred) => [pred(node) ? node : null, ...node.children.flatMap((c) => find(c, pred))].filter(Boolean);
export const panelOf = (env, cls) => env.doc.body.children.find((c) => c.className === cls);
export const layerOf = (env) => env.canvas.parentNode?.children.find((c) => c.tag === "canvas" && c !== env.canvas);
export const click = (env, point, type = "pointerdown") => env.canvas.dispatchEvent({ type, clientX: point[0], clientY: point[1], stopImmediatePropagation() {} });
export const clickAt = (env, lonLat) => click(env, screenOf(lonLat));
export const press = (env, cls, label, nth = 0) => {
  const b = find(panelOf(env, cls), (n) => n.tag === "button" && n.textContent === label)[nth];
  assert.ok(b, `button ${label}`);
  b.dispatchEvent({ type: "click", stopPropagation() {} });
};
export const hasButton = (env, cls, label) => find(panelOf(env, cls), (n) => n.tag === "button" && n.textContent === label).length > 0;
export const hasText = (env, cls, part) => texts(panelOf(env, cls)).some((t) => t.includes(part));
export const deepFreeze = (o) => { if (o && typeof o === "object") { Object.values(o).forEach(deepFreeze); Object.freeze(o); } return o; };
// words a map panel must never use: a verdict, a price, a time, a size, a score
export const BANNED_TEXT = /원|비용|공기|승인|확률|가능|불가|복구|지연|보상|평판|손실|시간|용량|수송력|점수|순위|접근료|계약|판정/;
