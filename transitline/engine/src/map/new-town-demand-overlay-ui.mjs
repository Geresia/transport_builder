// Read-only mount of the new-town demand overlay (B19-M6).  It draws, over the map, each phase the player drew together with what the engines
// keep about it - lifecycle (B19-E1), the candidate (B19-E2), the decision (B19-E4) and the explicit demand source (B19-E5) - and lists the
// same facts in a panel.  Every input is a plain object handed in by a getter; the mount never calls the engine, has no command, stores
// nothing (no localStorage), reads no clock and draws no random number.  The only interaction is choosing a phase to look at: a view state,
// never a decision.  A stated figure is listed one by one as "명시 수치"; nothing is added up, and no size or colour depth follows from it.
import { INTAKE_STYLE, SOURCE_LABEL, buildNewTownDemandOverlayView, drawNewTownDemandOverlay } from "./new-town-demand-overlay-view.mjs";
import { clone, createShell } from "./map-mount-kit.mjs";

export const NEW_TOWN_DEMAND_OVERLAY_EVENT = "transitline:new-town-demand-overlay";
export const SCOPE_NOTICE = "지도 위에서 신도시 단계마다 엔진이 가진 사실(생애주기·지도 일치·후보·승인 기록·명시 수요 원천)을 그대로 보여 줍니다. 수요·인구를 계산하거나 합산하지 않고, 색은 상태를 구분할 뿐 좋고 나쁨을 뜻하지 않습니다. 명시 수요 원천은 B15 수요 노드에 아직 적용되지 않았습니다.";
export const STALE_NOTICE = "낡음(stale)·철회(revoked)·거둔(withdrawn) 항목은 숨기지 않고 흐리게 보입니다. 이 화면은 아무것도 고치거나 다시 승인하거나 전달하지 않습니다.";
const CSS = ".tl-nt-demand{position:fixed;right:12px;top:64px;width:380px;max-height:70vh;overflow:auto;padding:9px 10px;border:1px solid #334155;border-radius:8px;background:rgba(15,23,42,.95);color:#e2e8f0;font:12px/1.45 system-ui,'Malgun Gothic',sans-serif}.tl-nt-demand .ntd-title{font-weight:700;color:#93c5fd;margin:6px 0 2px}.tl-nt-demand .ntd-note{color:#94a3b8;margin:4px 0}.tl-nt-demand .ntd-row{margin:3px 0;padding:3px 5px;background:rgba(255,255,255,.04);overflow-wrap:anywhere}.tl-nt-demand .ntd-dim{opacity:.6}.tl-nt-demand .ntd-warn{color:#fbbf24;margin:2px 0}.tl-nt-demand button{margin:2px 3px 2px 0}";
const list = (v) => (v === undefined || v === null ? [] : v);
const reasons = (r) => (r.length ? ` — ${r.join(", ")}` : "");
const eligibleText = (v) => (v === true ? "true" : v === false ? "false" : "null (미상)");

export function mountNewTownDemandOverlay({ canvas, projection, pack, getGeometryExport, getDevelopments, getCandidates, getIntakes, getSources, onChange = () => {}, enabled = true, autoRefreshMs = 250 } = {}) {
  const shell = createShell({ canvas, projection, pack, styleId: "transitline-nt-demand-style", css: CSS, panelClass: "tl-nt-demand", layerZ: 8, panelZ: 9 });
  let selected = null; let enabledNow = Boolean(enabled); let model = buildNewTownDemandOverlayView(); let notes = [];
  let fingerprint = null; let version = 0; let drawn = -1; let paneled = -1; let rect = "";

  const read = (name, getter, fallback) => { try { const v = getter?.(); return v === undefined || v === null ? fallback : v; } catch { notes.push({ code: "input-unreadable", input: name }); return fallback; } };
  const warnings = () => [
    ...notes,
    ...model.developments.flatMap((d) => d.phases.filter((p) => !p.polygon).map((p) => ({ code: "phase-polygon-unknown", developmentId: d.developmentId, phaseId: p.phaseId }))),
    ...model.unmatched.intakes.map((i) => ({ code: "intake-not-on-the-map", ...i })),
    ...model.unmatched.sources.map((s) => ({ code: "source-not-on-the-map", ...s })),
  ];
  const output = () => ({ view: clone(model), selected: selected ? { ...selected } : null, warnings: warnings() });

  function phaseRows(box, el, button, dev, phase) {
    const row = el("div", `ntd-row${phase.dim ? " ntd-dim" : ""}`);
    row.style.borderLeft = `3px solid ${INTAKE_STYLE[phase.intake.state].color}`;
    row.append(el("div", "ntd-title", `${phase.sequence ?? "?"}. ${phase.name ?? "단계"} · ${phase.phaseId}`));
    row.append(el("div", "", `생애주기: 개발 ${phase.lifecycle.development ?? "미상"} · 단계 ${phase.lifecycle.phase ?? "미상"}`));
    row.append(el("div", "", `지도 일치: ${phase.geometry.status}${reasons(phase.geometry.reasons)}`));
    row.append(el("div", "", phase.candidate
      ? `후보: ${phase.candidate.candidateId} · 입력 ${phase.candidate.completeness ?? "미상"} · eligibleForB15 ${eligibleText(phase.candidate.eligibleForB15)}`
      : "후보 없음 — 입주 사실이 기록되지 않음"));
    row.append(el("div", "", `승인 기록: ${INTAKE_STYLE[phase.intake.state].label}${phase.intake.intakeId ? ` · ${phase.intake.intakeId}` : ""}${phase.intake.verification ? ` · 근거 ${phase.intake.verification.status}${reasons(phase.intake.verification.reasons)}` : ""}${phase.intake.revokedIntakeIds.length ? ` · 철회된 기록 ${phase.intake.revokedIntakeIds.join(", ")}` : ""}`));
    row.append(el("div", "", phase.source.delivered
      ? `B15 입력 원천: 전달됨 · ${phase.source.sourceId} (current)`
      : `B15 입력 원천: 전달 안 됨 — ${phase.source.sourceId ? `${SOURCE_LABEL[phase.source.state]} ${phase.source.sourceId}${reasons(phase.source.reasons)} · ` : ""}원인 ${phase.notDeliveredReasons.join(", ")}`));
    const facts = phase.candidate?.statedFacts;
    row.append(el("div", "", phase.selected
      ? (facts === null || facts === undefined ? "명시 수치 없음(null)" : `명시 수치(플레이어가 적은 그대로, 합계 없음): ${facts.map((f) => `${f.kind} ${f.quantity}`).join(" · ")}`)
      : `명시 사실 ${facts === null || facts === undefined ? "없음(null)" : `${facts.length}건`}`));
    box.append(row);
    button(box, phase.selected ? "선택 해제" : "지도에서 강조", () => select(phase.selected ? null : dev.developmentId, phase.phaseId));
  }

  function render() {
    const { box, el, button } = shell;
    box.replaceChildren();
    box.hidden = !enabledNow;
    if (!enabledNow) return;
    box.append(el("div", "ntd-title", "신도시 수요 원천 지도"), el("div", "ntd-note", SCOPE_NOTICE), el("div", "ntd-note", STALE_NOTICE));
    for (const w of warnings()) box.append(el("div", "ntd-warn", `${w.code}${w.phaseId ? ` · ${w.phaseId}` : w.intakeId ? ` · ${w.intakeId} (${w.state})` : w.sourceId ? ` · ${w.sourceId} (${w.state})` : w.input ? ` · ${w.input}` : ""}`));
    if (!model.developments.length) box.append(el("div", "ntd-note", "지도에 신도시 개발이 없습니다."));
    for (const dev of model.developments) {
      box.append(el("div", "ntd-title", `${dev.name ?? "개발"} · ${dev.developmentId}`), el("div", "ntd-note", `개발 기록 ${dev.developmentRecordId ?? "없음"} · 상태 ${dev.lifecycleStatus ?? "미상"}${dev.active ? "" : " · 지도에서 꺼짐"}`));
      for (const phase of dev.phases) phaseRows(box, el, button, dev, phase);
    }
  }

  const refresh = ({ force = false } = {}) => {
    notes = [];
    const input = {
      geometryExport: read("getGeometryExport", getGeometryExport, null), developments: list(read("getDevelopments", getDevelopments, [])), candidates: read("getCandidates", getCandidates, []),
      intakes: list(read("getIntakes", getIntakes, [])), sources: list(read("getSources", getSources, [])),
    };
    const stamp = JSON.stringify([input, selected, notes]);
    if (force || stamp !== fingerprint) {
      fingerprint = stamp;
      model = buildNewTownDemandOverlayView({ ...input, selected });
      if (selected && !model.selected) selected = null;
      version += 1;
      const out = output();
      onChange(out);
      canvas.dispatchEvent(new CustomEvent(NEW_TOWN_DEMAND_OVERLAY_EVENT, { detail: out }));
    }
    const next = shell.fit(enabledNow);
    if (drawn !== version || rect !== next) {
      drawn = version; rect = next;
      const ctx = shell.layer.getContext("2d");
      ctx.clearRect(0, 0, shell.layer.width, shell.layer.height);
      if (enabledNow) drawNewTownDemandOverlay(ctx, model, shell.screen);
    }
    if (paneled !== version) { paneled = version; render(); }
  };
  const select = (developmentId, phaseId) => {
    selected = developmentId && phaseId ? { developmentId, phaseId } : null;
    refresh({ force: true });
  };
  const detach = shell.attach({ onPointerDown: () => {}, onDblClick: () => {}, onKey: (e) => { if (enabledNow && e.key === "Escape" && selected !== null && !shell.typing()) select(null); }, refresh, autoRefreshMs });
  refresh({ force: true });
  return {
    output, refresh, select, deselect: () => select(null),
    setEnabled(value) { enabledNow = Boolean(value); version += 1; refresh({ force: true }); },
    destroy: detach,
  };
}
