// Read-only B24 host panel. It cannot receive a runtime or invoke Unity.
import { CONSTRUCTION_3D_PREFLIGHT_SCHEMA } from "./construction-3d-preflight.mjs";
const clone = (value) => structuredClone(value);
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const el = (doc, tag, props = {}, ...children) => { const node = doc.createElement(tag); Object.assign(node, props); node.append(...children); return node; };
const text = (doc, tag, cls, value) => el(doc, tag, { className: cls, textContent: value });
const show = (value) => value === null || value === undefined ? "unknown" : Array.isArray(value) ? (value.length ? value.join(", ") : "empty list") : String(value);
export function mountConstruction3dPreflightPanel({ container, getPreflight } = {}) {
  if (!container) throw new Error("A construction 3D preflight container is required");
  if (typeof getPreflight !== "function") throw new Error("getPreflight() is required");
  const doc = container.ownerDocument ?? document; let report = null; let error = null;
  const render = () => { const out = [text(doc, "p", "construction-3d-preflight-notice", "Optional 3D preflight only. This panel does not load Unity, render, approve, or apply changes.")]; if (error) out.push(text(doc, "div", "construction-3d-preflight-error", error)); else { out.push(text(doc, "div", "construction-3d-preflight-mode", report.readyForOptional3d ? "3D may be offered" : "2D-only fallback"), text(doc, "div", "construction-3d-preflight-fallback", `Fallback: ${show(report.fallback)}`), text(doc, "div", "construction-3d-preflight-sources", `Current sources: ${show(report.sources?.sources?.length)}`), text(doc, "div", "construction-3d-preflight-blockers", `Session blockers: ${show(report.session?.blockers)}`), text(doc, "div", "construction-3d-preflight-audit", `Audit blockers: ${show(report.audit?.blockers)}`), text(doc, "div", "construction-3d-preflight-warnings", `Warnings: ${show([...(report.sources?.warnings ?? []), ...(report.session?.warnings ?? []), ...(report.audit?.warnings ?? [])].map((entry) => typeof entry === "string" ? entry : entry.code))}`)); } container.replaceChildren(...out); };
  const api = { refresh() { try { const next = getPreflight(); if (!isObject(next) || next.schema !== CONSTRUCTION_3D_PREFLIGHT_SCHEMA) throw new Error("construction-3d-preflight-invalid"); report = next; error = null; } catch (reason) { report = null; error = reason instanceof Error ? reason.message : String(reason); } render(); return api.output(); }, output() { return { report: report === null ? null : clone(report), error }; } };
  api.refresh(); return api;
}
