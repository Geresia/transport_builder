// What the new-town demand overlay shows, and how it is drawn: for every phase the player drew, the facts the engines already keep - its
// lifecycle state, whether the map still matches the lifecycle record (geometry current / stale / inactive / other-pack), the B19-E2 candidate,
// the B19-E4 decision (pending / accepted / held / rejected / stale / revoked) and whether a B19-E5 explicit demand source was handed over,
// with the reasons it was not.  Read-only over plain objects the host passes in: nothing here counts, sums, scales or predicts anything.
// A figure the player stated is listed as "명시 수치", one by one; no size, thickness or colour depth depends on it, and a colour only
// tells the state apart - it never says that something is good or bad.  A stale, revoked, withdrawn or switched-off item is drawn faint
// and dashed, never hidden.
export const NEW_TOWN_DEMAND_VIEW_SCHEMA = "transitline.new-town-demand-overlay-view/1";

// colours separate states from each other; they carry no judgement and no amount
export const INTAKE_STYLE = Object.freeze({
  none: { color: "#94a3b8", fill: 0.04, label: "후보 없음" },
  pending: { color: "#7dd3fc", fill: 0.16, label: "대기(pending)" },
  accepted: { color: "#38bdf8", fill: 0.32, label: "승인됨(accepted)" },
  held: { color: "#fbbf24", fill: 0.2, label: "보류(held)" },
  rejected: { color: "#a8a29e", fill: 0.1, label: "거절(rejected)" },
  stale: { color: "#fb923c", fill: 0.1, label: "낡음(stale)" },
  revoked: { color: "#94a3b8", fill: 0.05, label: "철회(revoked)" },
});
export const GEOMETRY_STYLE = Object.freeze({
  current: { stroke: "#e2e8f0", dash: [], label: "current" },
  stale: { stroke: "#fb923c", dash: [6, 4], label: "stale" },
  "other-pack": { stroke: "#f472b6", dash: [6, 4], label: "other-pack" },
  inactive: { stroke: "#94a3b8", dash: [3, 5], label: "inactive" },
  unknown: { stroke: "#94a3b8", dash: [1, 4], label: "unknown" },
});
export const SOURCE_LABEL = Object.freeze({ none: "원천 없음", current: "원천 current", stale: "원천 stale", unverified: "원천 unverified", withdrawn: "원천 withdrawn" });
const FADED = new Set(["stale", "revoked"]);

const list = (v) => (Array.isArray(v) ? v : []);
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const byText = (a, b) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0);
const point = (p) => (Array.isArray(p) && p.length === 2 && p.every(Number.isFinite) ? [p[0], p[1]] : null);
// the middle of a drawn polygon, for its caption (geometry only)
function meanOf(ring) {
  if (!ring?.length) return null;
  let x = 0; let y = 0;
  for (const p of ring) { x += p[0]; y += p[1]; }
  return [x / ring.length, y / ring.length];
}
const recordNumber = (id) => Number(String(id).match(/:(\d+)$/)?.[1] ?? 0);

// identity comparison of the lifecycle record against the drawn development - used only for a phase that has no candidate (a candidate carries
// its own geometry state from B19-E2)
function identityGeometry(record, dev, phase) {
  const basis = "identity-comparison";
  if (!record) return { status: "unknown", reasons: ["development-record-missing"], basis };
  if (dev.active === false || phase.active === false) return { status: "inactive", reasons: [dev.active === false ? "geometry-inactive" : "phase-inactive"], basis };
  if (record.developmentRevision === null || record.developmentRevision === undefined) return { status: "unknown", reasons: ["lifecycle-revision-unknown"], basis };
  if (record.sourcePack && record.sourcePack.packId !== dev.sourcePackId) return { status: "other-pack", reasons: ["geometry-source-pack-changed"], basis };
  const reasons = [];
  if (record.sourcePack && record.sourcePack.packVersion !== null && dev.sourcePackVersion !== null && dev.sourcePackVersion !== undefined && record.sourcePack.packVersion !== dev.sourcePackVersion) reasons.push("geometry-source-pack-version-changed");
  if (record.developmentRevision !== dev.developmentRevision) reasons.push("geometry-revision-changed");
  return reasons.length ? { status: "stale", reasons, basis } : { status: "current", reasons: [], basis };
}

// why the phase has no explicit demand source handed over, in the order the facts apply; [] when it was
function notDelivered({ record, candidate, intake, source }) {
  if (source.delivered) return [];
  if (!record) return ["development-record-missing"];
  if (!candidate) return ["no-candidate:no-occupancy-fact-stated"];
  const why = [];
  if (candidate.statedFacts === null) why.push("no-stated-demand-fact");
  if (candidate.eligibleForB15 !== true) why.push(`candidate-not-eligible:${candidate.eligibleForB15}`);
  if (intake.state !== "accepted") why.push(`intake-${intake.state}`);
  else if (intake.verification && intake.verification.status !== "current") why.push(`intake-${intake.verification.status}`);
  if (source.state === "none" && intake.state === "accepted" && intake.verification?.status === "current") why.push("source-not-created");
  if (source.state !== "none" && source.state !== "current") why.push(`source-${source.state}`);
  return why;
}

// geometryExport: the B19-M1 export; developments: B19-E1 records; candidates: B19-E2 outputs (one per development); intakes: B19-E4 report items
// (with standing); sources: B19-E5 applied-source report items (with standing); selected: { developmentId, phaseId } | null
export function buildNewTownDemandOverlayView({ geometryExport = null, developments = [], candidates = [], intakes = [], sources = [], selected = null } = {}) {
  const exportedDevs = list(geometryExport?.developments).filter(isObject);
  const records = list(developments).filter(isObject);
  const outputs = list(isObject(candidates) && !Array.isArray(candidates) ? [candidates] : candidates).filter(isObject);
  const intakeItems = list(intakes).filter(isObject);
  const sourceItems = list(sources).filter(isObject);
  const claimed = { intakes: new Set(), sources: new Set() };
  const views = exportedDevs.map((dev) => {
    const mine = records.filter((r) => r.developmentId === dev.developmentId).sort((a, b) => recordNumber(a.id) - recordNumber(b.id));
    const record = mine.at(-1) ?? null;
    const output = record ? outputs.find((o) => o.sourceReferences?.lifecycle?.developmentHookId === record.id) ?? outputs.find((o) => o.developmentId === dev.developmentId && !o.sourceReferences) ?? null : null;
    const phases = list(dev.phases).filter(isObject).sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0) || byText(a.phaseId, b.phaseId)).map((phase) => {
      const recordPhase = list(record?.phases).find((p) => p.phaseId === phase.phaseId) ?? null;
      const cand = list(output?.candidates).find((c) => c.phaseId === phase.phaseId) ?? null;
      const candidate = cand ? {
        candidateId: cand.candidateId, completeness: cand.inputCompleteness?.status ?? null, eligibleForB15: cand.eligibleForB15 ?? null, occupancyFactIds: [...list(cand.occupancyFactIds)],
        statedFacts: cand.statedDemandFacts === null || cand.statedDemandFacts === undefined ? null : cand.statedDemandFacts.map((f) => ({ factId: f.factId, kind: f.kind, quantity: f.quantity })),
      } : null;
      const candidateGeometry = cand?.geometryStatus?.status;
      const geometry = cand
        ? { status: Object.hasOwn(GEOMETRY_STYLE, candidateGeometry) ? candidateGeometry : "unknown", reasons: [...list(cand.geometryStatus?.reasons)], basis: "candidate" }
        : identityGeometry(record, dev, phase);
      const mineIntakes = record && cand ? intakeItems.filter((i) => i.developmentRecordId === record.id && i.candidateId === cand.candidateId) : [];
      for (const i of mineIntakes) claimed.intakes.add(i.id);
      const live = mineIntakes.find((i) => i.status !== "revoked") ?? null;
      const revoked = mineIntakes.filter((i) => i.status === "revoked").map((i) => i.id);
      const intake = {
        state: live ? live.standing?.currentStatus ?? live.status : revoked.length ? "revoked" : cand ? "pending" : "none",
        intakeId: live?.id ?? null, verification: live?.standing?.verification ? { status: live.standing.verification.status, reasons: [...live.standing.verification.reasons] } : null, revokedIntakeIds: revoked,
      };
      const mineSources = record && cand ? sourceItems.filter((s) => s.developmentRecordId === record.id && s.candidateId === cand.candidateId) : [];
      for (const s of mineSources) claimed.sources.add(s.sourceId);
      const own = mineSources.find((s) => s.status === "applied") ?? mineSources.at(-1) ?? null;
      const sourceState = !own ? "none" : own.status === "withdrawn" ? "withdrawn" : own.standing?.status ?? "unverified";
      const source = { state: sourceState, sourceId: own?.sourceId ?? null, reasons: own ? [...list(own.standing?.reasons)] : [], delivered: sourceState === "current", otherSourceIds: mineSources.filter((s) => s !== own).map((s) => s.sourceId) };
      const polygon = list(phase.polygon).map(point).filter(Boolean);
      const dim = FADED.has(intake.state) || source.state === "withdrawn" || source.state === "stale" || dev.active === false || phase.active === false || geometry.status === "inactive";
      return {
        phaseId: phase.phaseId, name: phase.name ?? null, sequence: phase.sequence ?? null, active: phase.active !== false, landUse: phase.playerDeclaredLandUse ?? null,
        polygon: polygon.length >= 3 ? polygon : null, labelAt: point(phase.location) ?? meanOf(polygon.length >= 3 ? polygon : null),
        lifecycle: { development: record?.status ?? null, phase: recordPhase?.status ?? cand?.phaseLifecycleStatus ?? null },
        geometry, candidate, intake, source, dim, notDeliveredReasons: notDelivered({ record, candidate, intake, source }),
        selected: selected?.developmentId === dev.developmentId && selected?.phaseId === phase.phaseId,
      };
    });
    return { developmentId: dev.developmentId, developmentRecordId: record?.id ?? null, otherRecordIds: mine.slice(0, -1).map((r) => r.id), name: dev.name ?? null, active: dev.active !== false, lifecycleStatus: record?.status ?? null, developmentRevision: dev.developmentRevision ?? null, phases };
  }).sort((a, b) => byText(a.developmentId, b.developmentId));
  return {
    schema: NEW_TOWN_DEMAND_VIEW_SCHEMA, developments: views,
    // decisions and sources that no drawn phase accounts for: kept in sight, never dropped
    unmatched: {
      intakes: intakeItems.filter((i) => !claimed.intakes.has(i.id)).map((i) => ({ intakeId: i.id, candidateId: i.candidateId, developmentRecordId: i.developmentRecordId, state: i.standing?.currentStatus ?? i.status })).sort((a, b) => byText(a.intakeId, b.intakeId)),
      sources: sourceItems.filter((s) => !claimed.sources.has(s.sourceId)).map((s) => ({ sourceId: s.sourceId, intakeId: s.intakeId, candidateId: s.candidateId, state: s.status === "withdrawn" ? "withdrawn" : s.standing?.status ?? "unverified" })).sort((a, b) => byText(a.sourceId, b.sourceId)),
    },
    selected: views.some((d) => d.phases.some((p) => p.selected)) ? { developmentId: selected.developmentId, phaseId: selected.phaseId } : null,
  };
}

export const rgba = (hex, alpha) => {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
};
const path = (ctx, pts, close = false) => { ctx.beginPath(); pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); if (close) ctx.closePath(); };
export const phaseCaption = (phase) => `${phase.sequence ?? "?"}. ${phase.name ?? "단계"} · ${phase.lifecycle.phase ?? "생애주기 미상"} · ${INTAKE_STYLE[phase.intake.state].label} · ${phase.source.delivered ? "원천 전달됨" : SOURCE_LABEL[phase.source.state]}`;

// `screen` maps [lon, lat] to canvas pixels.  The fill colour is the decision state, the outline is the map-versus-lifecycle state; nothing
// drawn depends on a stated figure.
export function drawNewTownDemandOverlay(ctx, model, screen) {
  ctx.save();
  ctx.lineJoin = "round";
  for (const dev of model.developments) {
    for (const phase of dev.phases) {
      if (!phase.polygon) continue;
      const style = INTAKE_STYLE[phase.intake.state];
      const outline = GEOMETRY_STYLE[phase.geometry.status] ?? GEOMETRY_STYLE.unknown;
      ctx.fillStyle = rgba(style.color, style.fill * (phase.dim ? 0.5 : 1));
      ctx.strokeStyle = rgba(outline.stroke, phase.dim ? 0.55 : 1);
      ctx.lineWidth = phase.selected ? 3.5 : 2;
      ctx.setLineDash(phase.dim ? [3, 4] : outline.dash);
      path(ctx, phase.polygon.map(screen), true);
      ctx.fill();
      ctx.stroke();
      ctx.setLineDash([]);
      const [lx, ly] = screen(phase.labelAt ?? phase.polygon[0]);
      // the source marker: filled when a source was handed over (current), hollow and dashed for any other source state, absent for none
      if (phase.source.state !== "none") {
        ctx.lineWidth = 2;
        ctx.strokeStyle = rgba(style.color, phase.dim ? 0.6 : 1);
        ctx.setLineDash(phase.source.delivered ? [] : [2, 2]);
        ctx.fillStyle = rgba(style.color, 0.9);
        ctx.beginPath();
        ctx.rect(lx - 5, ly - 21, 10, 10);
        if (phase.source.delivered) ctx.fill();
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.font = "bold 11px Inter, system-ui, 'Malgun Gothic', sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.lineWidth = 3;
      ctx.strokeStyle = "#111318";
      ctx.strokeText(phaseCaption(phase), lx, ly);
      ctx.fillStyle = phase.dim ? "rgba(241, 242, 245, 0.55)" : "#f1f2f5";
      ctx.fillText(phaseCaption(phase), lx, ly);
    }
  }
  ctx.restore();
}
