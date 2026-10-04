// Read-only view of what the management engine returned: construction phase per plan and
// errors / conditional verdicts / missing data per plan, station or segment.
//
// The map only DISPLAYS engine output. Nothing here writes to the report, the plans, or any
// cash/contract/construction state, and nothing here imports ./management — the report is plain data.
import { octilinear } from "../geometry.mjs";
import { stableId } from "./ids.mjs";

export const PHASES = Object.freeze({
  planned: { label: "계획", color: "#8c93a4", dash: [4, 6] },
  underReview: { label: "심사 중", color: "#4cc9f0", dash: [10, 6] },
  underConstruction: { label: "공사 중", color: "#ffd60a", dash: [14, 5] },
  halted: { label: "공사 중단", color: "#e5484d", dash: [3, 3] }, // suspended: can resume
  cancelled: { label: "✕ 사업 취소", color: "#b0798a", dash: [1, 9] }, // over: never resumes, so it must not look like a pause
  inspection: { label: "검사 중", color: "#9b5de5", dash: [] },
  available: { label: "사용 가능", color: "#2fbf71", dash: [] },
});
const UNKNOWN_STYLE = { label: "상태 불명", color: "#6b7d85", dash: [2, 4] };

// Engine status -> map phase. `estimated` sits before any contract, so it reads as review, not construction.
// `suspended` (and `halted`) are pauses that can resume; `cancelled` is final and has its own colour and legend entry.
// A delay inside underConstruction stays "공사 중" and is flagged `delayed`.
const PROJECT_PHASE = {
  estimated: "underReview", approved: "underReview", contracted: "underConstruction", underConstruction: "underConstruction",
  inspection: "inspection", available: "available", cancelled: "cancelled", suspended: "halted", halted: "halted",
};
// Plan-record status (before a project exists, or when the report carries no project). needs-information and
// rejected are still just a drawing — the reason is shown as engine diagnostics, not as a phase.
const PLAN_RECORD_PHASE = {
  "needs-information": "planned", rejected: "planned", assessed: "underReview", approved: "underReview",
  "in-project": "underReview", "assets-available": "available", commissioned: "available",
};

const SEVERITY_RANK = { error: 0, warning: 1, info: 2 };
const asMap = (x) => new Map((Array.isArray(x) ? x : Object.entries(x ?? {}).map(([planId, v]) => ({ planId, ...v }))).map((v) => [v.planId, v]));

// Engine messages are free text; find which station/segment they are about. Unmatched -> the plan itself.
function targetOf(text, plan) {
  let m = /^Segment (\d+)\b/.exec(text) ?? /^segments\.(\d+)\./.exec(text);
  if (m && plan.segments[Number(m[1])]) return { type: "segment", id: plan.segments[Number(m[1])].id };
  m = /^(?:Station|Duplicate station) (\S+)/.exec(text) ?? /^stationCandidates\.([^.]+)\./.exec(text);
  if (m && plan.stationCandidates.some((s) => s.id === m[1])) return { type: "station", id: m[1] };
  return { type: "plan", id: plan.planId };
}

export function buildOverlayModel(mapExport, report = {}) {
  const projects = asMap(report.projects);
  const records = asMap(report.plans);
  const assessments = report.assessments ?? {};
  const diagnostics = [];
  const add = (plan, source, severity, code, target, message) =>
    diagnostics.push({ id: stableId("diag", plan.planId, source, code, target.type, target.id, message), planId: plan.planId, source, severity, code, target, message });

  const plans = mapExport.plans.map((plan) => {
    const project = projects.get(plan.planId);
    const record = records.get(plan.planId);
    const status = project?.status ?? record?.status ?? null;
    const phase = status === null ? "planned" : (project ? PROJECT_PHASE : PLAN_RECORD_PHASE)[status] ?? null;
    if (phase === null) add(plan, "engine", "warning", "unknown-status", { type: "plan", id: plan.planId }, `엔진이 알 수 없는 상태 '${status}'를 반환했습니다. 임의로 해석하지 않고 상태 불명으로 표시합니다.`);

    if (project?.status === "suspended") add(plan, "engine", "info", "engine-suspended", { type: "plan", id: plan.planId }, `공사 중단 — ${project.suspensionReason ?? "사유 미기재"}. 재개하면 공정과 기성금 지급이 다시 진행됩니다.`);
    if (project?.status === "cancelled") add(plan, "engine", "info", "engine-cancelled", { type: "plan", id: plan.planId }, "사업 취소 — 다시 시작할 수 없습니다.");

    const verdict = assessments[plan.planId];
    if (verdict) {
      for (const text of verdict.violations ?? []) add(plan, "engine", "error", "engine-violation", targetOf(text, plan), `위반 — ${text}`);
      for (const text of verdict.missingInputs ?? []) add(plan, "engine", "warning", "engine-missing-input", targetOf(text, plan), `누락 자료 — ${text}`);
      if (verdict.buildable === "conditional") add(plan, "engine", "warning", "engine-conditional", { type: "plan", id: plan.planId }, "조건부 판정 — 누락 자료가 채워지기 전에는 건설 가능 여부를 확정할 수 없습니다.");
      if (verdict.buildable === "unknown") add(plan, "engine", "warning", "engine-unknown", { type: "plan", id: plan.planId }, "판정 불가(unknown) — 엔진이 건설 가능 여부를 판단하지 못했습니다.");
    }
    for (const w of plan.warnings) add(plan, "map", "warning", `map-${w.code}`, { type: "plan", id: plan.planId }, `지도 입력 경고 — ${w.code}${w.value ? ` (${w.value})` : ""}`);
    if (plan.segments.some((s) => s.constraintUnknown.length)) add(plan, "map", "info", "map-ground-unknown", { type: "plan", id: plan.planId }, `지반 자료 없음 — ${[...new Set(plan.segments.flatMap((s) => s.constraintUnknown))].join(", ")} 은(는) 어떤 팩에도 없어 확인되지 않았습니다.`);
    for (const [items, type] of [[plan.stationCandidates, "station"], [plan.segments, "segment"]]) {
      for (const item of items) {
        if (!item.unknown.length && !item.inferred.length) continue;
        const why = (k) => (item.unknownReasons?.[k] ? `${k}(${item.unknownReasons[k]})` : k);
        const parts = [item.unknown.length ? `누락: ${item.unknown.map(why).join(", ")}` : null, item.inferred.length ? `추정: ${item.inferred.join(", ")}` : null].filter(Boolean);
        add(plan, "map", "info", "map-unknown-data", { type, id: item.id }, parts.join(" · "));
      }
    }

    const worst = new Map();
    for (const d of diagnostics) if (d.planId === plan.planId) worst.set(`${d.target.type}:${d.target.id}`, Math.min(worst.get(`${d.target.type}:${d.target.id}`) ?? 9, SEVERITY_RANK[d.severity]));
    const severityOf = (type, id) => ["error", "warning", "info"][worst.get(`${type}:${id}`)] ?? null;
    const at = new Map(plan.stationCandidates.map((s) => [s.id, s.location]));
    return {
      planId: plan.planId, name: plan.name, phase, status,
      delayed: project?.status === "underConstruction" && (project.delayMonths ?? 0) > 0,
      progress: project?.progress ?? null,
      planSeverity: severityOf("plan", plan.planId),
      segments: plan.segments.map((s) => ({ id: s.id, from: at.get(s.from), to: at.get(s.to), severity: severityOf("segment", s.id) })),
      stations: plan.stationCandidates.map((s) => ({ id: s.id, location: s.location, name: s.name, severity: severityOf("station", s.id) })),
    };
  });

  diagnostics.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || (a.planId < b.planId ? -1 : a.planId > b.planId ? 1 : 0) || (a.id < b.id ? -1 : 1));
  return { plans, diagnostics };
}

const MARKER = { error: "#e5484d", warning: "#ffb703", info: "#4895ef" };

function marker(ctx, severity, [x, y]) {
  ctx.fillStyle = MARKER[severity];
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  if (severity === "warning") {
    ctx.moveTo(x, y - 8); ctx.lineTo(x + 8, y + 6); ctx.lineTo(x - 8, y + 6); ctx.closePath();
  } else {
    ctx.arc(x, y, severity === "error" ? 8 : 5, 0, Math.PI * 2);
  }
  ctx.fill();
  ctx.stroke();
  if (severity !== "info") {
    ctx.fillStyle = "#111318";
    ctx.font = "bold 10px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("!", x, y + (severity === "warning" ? 1.5 : 0.5));
  }
}

// Wide translucent underlay per segment coloured (and dash-patterned, so colour is not the only cue) by phase,
// then severity markers on the stations/segments the engine or the map flagged.
export function drawPlanOverlay(ctx, model, screen) {
  ctx.save();
  for (const plan of model.plans) {
    const style = PHASES[plan.phase] ?? UNKNOWN_STYLE;
    ctx.globalAlpha = 0.6;
    ctx.strokeStyle = style.color;
    ctx.lineWidth = 16;
    ctx.lineCap = "butt";
    ctx.lineJoin = "round";
    ctx.setLineDash(plan.delayed ? [2, 7] : style.dash);
    for (const seg of plan.segments) {
      const pts = octilinear(screen(seg.from), screen(seg.to));
      ctx.beginPath();
      pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;

    const first = plan.segments[0];
    if (first) {
      const [ax, ay] = screen(first.from);
      const [bx, by] = screen(first.to);
      const text = `${style.label}${plan.delayed ? " · 지연" : ""}${plan.progress !== null && plan.phase === "underConstruction" ? ` ${Math.round(plan.progress * 100)}%` : ""}`;
      ctx.font = "bold 11px Inter, system-ui, 'Malgun Gothic', sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.lineJoin = "round";
      ctx.lineWidth = 3;
      ctx.strokeStyle = "#111318";
      ctx.strokeText(text, (ax + bx) / 2, (ay + by) / 2 - 18);
      ctx.fillStyle = style.color;
      ctx.fillText(text, (ax + bx) / 2, (ay + by) / 2 - 18);
    }
    for (const seg of plan.segments) {
      if (!seg.severity || seg.severity === "info") continue;
      const [ax, ay] = screen(seg.from);
      const [bx, by] = screen(seg.to);
      marker(ctx, seg.severity, [(ax + bx) / 2, (ay + by) / 2]);
    }
    // Candidate stations must remain visible even when the plan has no
    // operational line yet. Severity markers are added on top below.
    for (const st of plan.stations) {
      const [x, y] = screen(st.location);
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fillStyle = "#111318";
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = style.color;
      ctx.stroke();
    }
    for (const st of plan.stations) {
      if (!st.severity || st.severity === "info") continue;
      const [x, y] = screen(st.location);
      marker(ctx, st.severity, [x + 10, y - 10]);
    }
  }
  ctx.restore();
}

// Player-controlled text (line and station names) only ever goes through textContent.
export function renderDiagnosticsPanel(container, diagnostics, limit = 40) {
  container.replaceChildren();
  container.hidden = diagnostics.length === 0;
  if (!diagnostics.length) return;
  const doc = container.ownerDocument;
  const head = doc.createElement("div");
  head.className = "section-label";
  head.textContent = `검토 항목 ${diagnostics.length}건`;
  container.append(head);
  for (const d of diagnostics.slice(0, limit)) {
    const row = doc.createElement("div");
    row.className = `diag ${d.severity}`;
    row.textContent = `${d.severity === "error" ? "⛔" : d.severity === "warning" ? "⚠" : "ⓘ"} ${d.message}`;
    row.title = `${d.source} · ${d.code} · ${d.target.type}`;
    container.append(row);
  }
  if (diagnostics.length > limit) {
    const more = doc.createElement("div");
    more.className = "diag info";
    more.textContent = `…외 ${diagnostics.length - limit}건`;
    container.append(more);
  }
}

// Legend for the phase underlay: colour chip + label, same styles the map draws (textContent only).
export function renderPhaseLegend(container, phases = PHASES) {
  container.replaceChildren();
  const doc = container.ownerDocument;
  const head = doc.createElement("div");
  head.className = "section-label";
  head.textContent = "공사 상태 (엔진 반환값)";
  container.append(head);
  for (const style of Object.values(phases)) {
    const row = doc.createElement("div");
    row.className = "phase-legend-row";
    const chip = doc.createElement("i");
    chip.className = "phase-chip";
    chip.style.borderTopColor = style.color;
    chip.style.borderTopStyle = style.dash.length ? "dashed" : "solid";
    const label = doc.createElement("span");
    label.textContent = style.label;
    row.append(chip, label);
    container.append(row);
  }
}

// The overlay models live on `state` because render.mjs reads them there, but they are display data: keep them
// non-enumerable so the integrated save (snapshotOperationalState walks Object.entries) and a load never carry them.
export function defineViewSlots(state, names = ["mapOverlay", "depotView", "stationView", "constructionView", "throughHandoverView"]) {
  for (const name of names) Object.defineProperty(state, name, { value: null, writable: true, enumerable: false, configurable: true });
  return state;
}
