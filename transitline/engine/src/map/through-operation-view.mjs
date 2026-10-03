// Read-only map view of one through service (see docs/through-operation-map-contract.md): the whole route, which
// legs are planned / the player's own / external, who owns and who operates each leg, the handovers, the service
// state and verdict the management engine returned, the latest actual running record, and trains if the map
// simulation reports any.
//
// The map only DISPLAYS. It never computes whether a through service is possible, and no cost, cash, revenue, fare,
// profit or settlement: the verdict, the legs' compatibility and the settlement are read as the engine returned
// them, and money in a settlement is not even copied (the management screen shows it). Nothing here writes to the
// inputs, calls a management API, touches storage, or imports ./management — the reports are plain data.
//
// Missing data: a value that is not there is `null` with its name in `unknown[]` and a reason in `unknownReasons`.
// `physicalConnection: null` is "unknown", never "separated". A leg with `alignment: null` (an external leg) is never
// drawn as a made-up straight line, and a train with no position is never given one.
import { haversineMetres } from "../projection.mjs";
import { roundTo } from "./ids.mjs";

export const THROUGH_OPERATION_MAP_VIEW_SCHEMA = "transitline.through-operation-map-view/1";
const SERVICE_SCHEMA = "transitline.through-service/1";
const ROUTE_SCHEMA = "transitline.through-route-geometry/1";
const SETTLEMENT_SCHEMA = "transitline.through-operating-settlement/1";

// How a leg is drawn. Order of resolution (first match wins): terminated, suspended, impossible, unknown, then who
// owns and who operates. A leg with no alignment is `no-alignment` (nothing to draw; see `stateKey` for its state).
export const LEG_STYLES = Object.freeze({
  "player-owned-player-operated": { label: "자기 선로 · 자기 운행", color: "#2fbf71", dash: [], width: 5 },
  "external-owned-player-operated": { label: "타사 선로 · 자기 운행", color: "#4cc9f0", dash: [10, 5], width: 5 },
  "player-owned-external-operated": { label: "자기 선로 · 타사 운행", color: "#ffb703", dash: [10, 5, 2, 5], width: 5 },
  "external-owned-external-operated": { label: "타사 선로 · 타사 운행", color: "#b19cd9", dash: [3, 4], width: 5 },
  suspended: { label: "운행 중단", color: "#ff9f1c", dash: [3, 3], width: 5 },
  terminated: { label: "종료", color: "#6b7280", dash: [1, 9], width: 4 },
  unknown: { label: "판정 미상", color: "#c3c9d6", dash: [2, 4], width: 4 },
  impossible: { label: "확정 불가능", color: "#e5484d", dash: [], width: 6 },
  "no-alignment": { label: "선형 없음 (경계 마커로 표시)", color: "#8c93a4", dash: [], width: 0 },
});
export const HANDOVER_STYLES = Object.freeze({
  joined: { label: "접속 확인", color: "#2fbf71", glyph: "●" },
  separated: { label: "분리됨", color: "#e5484d", glyph: "✕" },
  unknown: { label: "접속 미상", color: "#ffb703", glyph: "?" },
});
export const TRAIN_STYLE = Object.freeze({ label: "열차 (지도 시뮬레이션 보고)", color: "#ffffff", delayedColor: "#ff9f1c" });
const STATUS_LABELS = { draft: "초안", assessed: "판정됨", approved: "승인", suspended: "운행 중단", terminated: "종료" };
const VERDICT_LABELS = { possible: "가능", conditional: "조건부", unknown: "미상", impossible: "불가능" };
const SOURCE_KIND_LABELS = { planned: "계획선", existing: "기존선", external: "외부 철도" };

const isText = (v) => typeof v === "string" && v.trim() !== "";
const text = (v) => (isText(v) ? v : null);
const isInt = (v) => Number.isSafeInteger(v) && v >= 0;
const finite = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const isPoint = (p) => Array.isArray(p) && p.length === 2 && p.every((n) => typeof n === "number" && Number.isFinite(n));
const copy = (v) => (v === undefined ? null : structuredClone(v));
const byCode = (a, b) => { const x = JSON.stringify(a); const y = JSON.stringify(b); return x < y ? -1 : x > y ? 1 : 0; };

// Where a train is, given its progress (0..1 in its direction of travel) along a leg's drawn alignment.
function interpolate(alignment, progress, direction) {
  const lengths = alignment.slice(1).map((p, i) => haversineMetres(alignment[i], p));
  const total = lengths.reduce((s, v) => s + v, 0);
  if (!(total > 0)) return null;
  const along = (direction === "reverse" ? 1 - progress : progress) * total;
  let walked = 0;
  for (let i = 0; i < lengths.length; i++) {
    if (along <= walked + lengths[i] || i === lengths.length - 1) {
      const t = lengths[i] > 0 ? Math.min(1, Math.max(0, (along - walked) / lengths[i])) : 0;
      const [a, b] = [alignment[i], alignment[i + 1]];
      return [roundTo(a[0] + (b[0] - a[0]) * t, 6), roundTo(a[1] + (b[1] - a[1]) * t, 6)];
    }
    walked += lengths[i];
  }
  return null;
}

function roleKey(ownerId, operatorId, playerId) {
  if (ownerId === null || operatorId === null) return null;
  const ownerIsPlayer = ownerId === playerId;
  const operatorIsPlayer = operatorId === playerId;
  return `${ownerIsPlayer ? "player" : "external"}-owned-${operatorIsPlayer ? "player" : "external"}-operated`;
}

// input: { route, service, settlements?, liveActuals?, playerOperatorId? } — the shapes the management engine and the map
// simulation hand over. Throws (with `.code`) when route and service are not the same through route; everything else
// that is wrong with an optional part (a settlement, a train) is dropped with a warning instead.
export function buildThroughOperationView({ route, service, settlements = [], liveActuals = null, playerOperatorId = "player" } = {}) {
  const fail = (code, message) => Object.assign(new Error(message), { code });
  if (route?.schema !== ROUTE_SCHEMA || route.contractVersion !== 1 || !isText(route.throughRouteId)) throw fail("route-invalid", "ThroughRouteGeometry v1 is required");
  if (service?.schema !== SERVICE_SCHEMA || service.contractVersion !== 1 || !isText(service.throughServiceId)) throw fail("service-invalid", "ThroughService v1 is required");
  if (service.throughRouteId !== route.throughRouteId) throw fail("route-service-mismatch", `Service ${service.throughServiceId} runs over ${service.throughRouteId}, not ${route.throughRouteId}`);

  const warnings = [];
  const unknownReasons = {};
  const unknown = [];
  const mark = (field, reason) => { if (!(field in unknownReasons)) unknown.push(field); unknownReasons[field] = reason; };
  const status = text(service.status);
  const verdict = text(service.assessment?.verdict);
  if (status === null) mark("status", "service-has-no-status");
  if (verdict === null) mark("assessmentVerdict", "service-has-no-assessment");
  const routeRevision = text(route.geometryRevision);
  const serviceRevision = text(service.routeGeometryRevision);
  if (routeRevision === null) mark("routeGeometryRevision", "route-has-no-geometry-revision");
  if (serviceRevision === null) mark("serviceRouteGeometryRevision", "service-has-no-route-geometry-revision");
  const stale = routeRevision !== null && serviceRevision !== null && routeRevision !== serviceRevision;
  if (stale) warnings.push({ code: "route-revision-mismatch", serviceRevision, routeRevision });

  // --- the engine's per-leg and per-handover findings, read by id out of the assessment's issue lists ---
  const issuesOf = (prefix) => {
    const rows = [];
    for (const [kind, list] of [["violation", service.assessment?.violations], ["condition", service.assessment?.conditions], ["missing", service.assessment?.missingInputs]]) {
      for (const entry of Array.isArray(list) ? list : []) if (typeof entry === "string" && entry.startsWith(prefix)) rows.push({ kind, code: entry.slice(prefix.length) });
    }
    return rows.sort(byCode);
  };

  // --- latest actual running record: only settlements of this service, newest operating day first ---
  const valid = [];
  for (const [index, entry] of (Array.isArray(settlements) ? settlements : []).entries()) {
    const ref = text(entry?.settlementId) ?? `#${index}`;
    if (entry?.schema !== SETTLEMENT_SCHEMA || entry.contractVersion !== 1) warnings.push({ code: "settlement-invalid", settlementId: ref, problem: "schema" });
    else if (entry.throughServiceId !== service.throughServiceId) warnings.push({ code: "settlement-other-service", settlementId: ref, throughServiceId: entry.throughServiceId ?? null });
    else if (!isInt(entry.operatingDay)) warnings.push({ code: "settlement-invalid", settlementId: ref, problem: "operatingDay" });
    else valid.push(entry);
  }
  valid.sort((a, b) => b.operatingDay - a.operatingDay || (finite(b.settledAtMinute) ?? -1) - (finite(a.settledAtMinute) ?? -1) || String(b.settlementId ?? "").localeCompare(String(a.settlementId ?? "")));
  const latest = valid[0] ?? null;
  if (latest && valid.filter((s) => s.operatingDay === latest.operatingDay).length > 1) warnings.push({ code: "settlement-duplicate-day", operatingDay: latest.operatingDay });
  if (latest === null) mark("latestSettlement", "no-settlement-for-service");
  const usageByAgreement = new Map();
  const latestSettlement = latest && {
    settlementId: text(latest.settlementId),
    operatingDay: latest.operatingDay,
    settledAtMinute: finite(latest.settledAtMinute),
    passengers: finite(latest.passengers),
    trainKm: finite(latest.trainKm),
    carKm: finite(latest.carKm),
    trackAccessUsage: (Array.isArray(latest.trackAccessUsage) ? latest.trackAccessUsage : [])
      .map((u) => ({ agreementId: text(u?.agreementId), infrastructureOwnerId: text(u?.infrastructureOwnerId), trainKm: finite(u?.trainKm), stationStops: finite(u?.stationStops) }))
      .filter((u) => u.agreementId !== null)
      .sort((a, b) => (a.agreementId < b.agreementId ? -1 : 1)),
  };
  for (const u of latestSettlement?.trackAccessUsage ?? []) usageByAgreement.set(u.agreementId, u);

  // --- legs: the route's geometry joined to the engine's role/compatibility by legId only ---
  const serviceLegs = new Map((Array.isArray(service.legs) ? service.legs : []).map((l) => [l.legId, l]));
  const routeLegIds = new Set((route.legs ?? []).map((l) => l.legId));
  for (const id of [...serviceLegs.keys()].filter((id) => !routeLegIds.has(id)).sort()) warnings.push({ code: "service-leg-not-on-route", legId: id });
  const playerId = playerOperatorId;
  // findings that name no leg and no handover concern the whole service (e.g. a missing operator, a bad agreement id)
  const namesPart = (entry) => typeof entry === "string" && (entry.startsWith("leg:") || entry.startsWith("handover:"));
  const wholeServiceViolation = (Array.isArray(service.assessment?.violations) ? service.assessment.violations : []).some((e) => !namesPart(e));
  const wholeServiceUnknown = (Array.isArray(service.assessment?.missingInputs) ? service.assessment.missingInputs : []).some((e) => !namesPart(e));
  const legs = [...(route.legs ?? [])].sort((a, b) => a.sequence - b.sequence).map((leg) => {
    const own = serviceLegs.get(leg.legId) ?? null;
    if (!own) warnings.push({ code: "route-leg-not-in-service", legId: leg.legId });
    const legUnknown = [];
    const legReasons = {};
    const legMark = (f, r) => { legUnknown.push(f); legReasons[f] = r; };
    const ownerId = text(own?.infrastructureOwnerId) ?? text(leg.infrastructureOwnerId);
    const operatorId = text(own?.operatorId) ?? text(service.operatorId);
    if (ownerId === null) legMark("infrastructureOwnerId", own ? "owner-not-stated" : "leg-not-in-service");
    if (operatorId === null) legMark("operatorId", "operator-not-stated");
    const compatibility = text(own?.compatibility);
    if (compatibility === null) legMark("compatibility", own ? "service-leg-has-no-compatibility" : "leg-not-in-service");
    const alignment = Array.isArray(leg.alignment) && leg.alignment.length >= 2 && leg.alignment.every(isPoint) ? copy(leg.alignment) : null;
    if (alignment === null) legMark("alignment", text(leg.unknownReasons?.alignment) ?? "route-leg-has-no-alignment");
    const role = roleKey(ownerId, operatorId, playerId);
    const issues = issuesOf(`leg:${leg.legId}:`);
    // The verdict is the engine's and is shown as it is. A leg's colour turns red / grey only when the finding is about
    // THIS leg (its own violation, its own unknown or incompatible compatibility) or about the whole service (a finding
    // that names no leg and no handover); a separated handover colours the handover marker, not both legs.
    const incompatible = compatibility === "incompatible" || own?.technicalCompatibility?.verdict === "impossible" || issues.some((i) => i.kind === "violation");
    const unsure = compatibility === "unknown" || own?.technicalCompatibility?.verdict === "unknown" || role === null || issues.some((i) => i.kind === "missing");
    const stateKey = status === "terminated" ? "terminated"
      : status === "suspended" ? "suspended"
        : incompatible || (verdict === "impossible" && wholeServiceViolation) ? "impossible"
          : unsure || (verdict === "unknown" && wholeServiceUnknown) ? "unknown"
            : role;
    const agreementId = text(own?.trackAccessAgreementId);
    const usage = agreementId === null ? null : usageByAgreement.get(agreementId) ?? null;
    return {
      legId: leg.legId,
      sequence: leg.sequence,
      sourceKind: leg.sourceKind,
      sourceKindLabel: SOURCE_KIND_LABELS[leg.sourceKind] ?? null,
      connectedPlanId: leg.connectedPlanId ?? null,
      connectedProjectId: leg.connectedProjectId ?? null,
      externalNetworkId: leg.externalNetworkId ?? null,
      externalLineId: leg.externalLineId ?? null,
      stationIds: copy(leg.stationIds ?? []),
      alignment,
      lengthMeters: leg.lengthMeters ?? null,
      infrastructureOwnerId: ownerId,
      operatorId,
      role,
      compatibility,
      technicalVerdict: text(own?.technicalCompatibility?.verdict),
      infrastructureStatus: text(own?.infrastructureStatus),
      capacityTrainsPerHour: finite(own?.capacityTrainsPerHour),
      trackAccessAgreementId: agreementId,
      agreementUsage: usage && { trainKm: usage.trainKm, stationStops: usage.stationStops },
      issues,
      conditional: issues.some((i) => i.kind === "condition"),
      stateKey,
      display: alignment === null ? "none" : "line",
      style: { key: alignment === null ? "no-alignment" : stateKey, ...LEG_STYLES[alignment === null ? "no-alignment" : stateKey] },
      unknown: legUnknown,
      unknownReasons: legReasons,
    };
  });
  const legById = new Map(legs.map((l) => [l.legId, l]));

  // --- handovers: the boundary between two legs, drawn where the route says it is, never where we would like it ---
  const handovers = [...(route.handovers ?? [])].sort((a, b) => a.sequence - b.sequence).map((h) => {
    const connectionState = h.physicalConnection === true ? "joined" : h.physicalConnection === false ? "separated" : "unknown";
    const from = legById.get(h.fromLegId);
    const to = legById.get(h.toLegId);
    const fromEnd = from?.alignment?.at(-1) ?? null;
    const toStart = to?.alignment?.[0] ?? null;
    const given = isPoint(h.location) ? h.location : null;
    const at = given ?? fromEnd ?? toStart;
    const basis = given ? "handover-location" : fromEnd ? "from-leg-end" : toStart ? "to-leg-start" : null;
    const hUnknown = [];
    const hReasons = {};
    if (at === null) { hUnknown.push("at"); hReasons.at = "no-location-and-no-adjacent-alignment"; }
    if (h.physicalConnection === null || h.physicalConnection === undefined) { hUnknown.push("physicalConnection"); hReasons.physicalConnection = text(h.unknownReasons?.physicalConnection) ?? "route-does-not-state-connection"; }
    return {
      handoverId: h.handoverId,
      sequence: h.sequence,
      fromLegId: h.fromLegId,
      toLegId: h.toLegId,
      stationId: h.stationId ?? null,
      physicalConnection: h.physicalConnection ?? null,
      connectionState,
      gapMeters: finite(h.gapMeters),
      at: copy(at),
      atBasis: basis,
      fromEnd: copy(fromEnd),
      toStart: copy(toStart),
      issues: issuesOf(`handover:${h.handoverId}:`),
      style: { key: connectionState, ...HANDOVER_STYLES[connectionState] },
      unknown: hUnknown,
      unknownReasons: hReasons,
    };
  });
  const serviceHandoverIds = Array.isArray(service.handoverIds) ? [...service.handoverIds].sort() : null;
  const routeHandoverIds = handovers.map((h) => h.handoverId).sort();
  if (serviceHandoverIds !== null && JSON.stringify(serviceHandoverIds) !== JSON.stringify(routeHandoverIds)) warnings.push({ code: "handover-ids-mismatch", service: serviceHandoverIds, route: routeHandoverIds });
  for (const h of handovers) if (h.at === null) warnings.push({ code: "handover-position-unknown", handoverId: h.handoverId });
  for (const l of legs) if (l.alignment === null) warnings.push({ code: "leg-not-drawable", legId: l.legId, reason: l.unknownReasons.alignment });

  // --- trains the map simulation reports; a position is only what was reported or what a drawn alignment and a progress give ---
  const live = liveActuals && typeof liveActuals === "object" ? liveActuals : null;
  const trainMarkers = [];
  const seen = new Set();
  const duplicates = new Set();
  for (const t of Array.isArray(live?.trains) ? live.trains : []) {
    if (isText(t?.trainRunId)) { if (seen.has(t.trainRunId)) duplicates.add(t.trainRunId); seen.add(t.trainRunId); }
  }
  for (const id of [...duplicates].sort()) warnings.push({ code: "duplicate-train-run", trainRunId: id });
  for (const [index, t] of (Array.isArray(live?.trains) ? live.trains : []).entries()) {
    const ref = text(t?.trainRunId) ?? `#${index}`;
    if (!isText(t?.trainRunId)) { warnings.push({ code: "train-invalid", trainRunId: ref, problem: "trainRunId" }); continue; }
    if (duplicates.has(t.trainRunId)) continue;
    if (t.throughServiceId !== service.throughServiceId) { warnings.push({ code: "train-other-service", trainRunId: ref, throughServiceId: t.throughServiceId ?? null }); continue; }
    const leg = legById.get(t.legId);
    if (!leg) { warnings.push({ code: "train-leg-unknown", trainRunId: ref, legId: t.legId ?? null }); continue; }
    const tUnknown = [];
    const tReasons = {};
    const progress = finite(t.progress);
    if (t.progress !== null && t.progress !== undefined && (progress === null || progress < 0 || progress > 1)) warnings.push({ code: "train-progress-invalid", trainRunId: ref });
    const validProgress = progress !== null && progress >= 0 && progress <= 1 ? progress : null;
    const direction = t.direction === "forward" || t.direction === "reverse" ? t.direction : null;
    if (t.direction !== null && t.direction !== undefined && direction === null) warnings.push({ code: "train-direction-invalid", trainRunId: ref });
    const reported = isPoint(t.location) ? t.location : null;
    if (t.location !== null && t.location !== undefined && reported === null) warnings.push({ code: "train-location-invalid", trainRunId: ref });
    let location = null;
    let basis = null;
    if (reported !== null) { location = copy(reported); basis = "reported"; }
    else if (validProgress !== null && leg.alignment !== null && direction !== null) { location = interpolate(leg.alignment, validProgress, direction); basis = location ? "interpolated" : null; }
    if (location === null) {
      tUnknown.push("location");
      tReasons.location = leg.alignment === null ? "leg-has-no-alignment" : validProgress === null ? "no-location-and-no-progress" : direction === null ? "direction-unknown-for-progress" : "alignment-has-no-length";
    }
    trainMarkers.push({
      trainRunId: t.trainRunId,
      throughServiceId: service.throughServiceId,
      legId: leg.legId,
      progress: validProgress,
      direction,
      delayMinutes: finite(t.delayMinutes),
      location,
      locationBasis: basis,
      drawable: location !== null,
      unknown: tUnknown,
      unknownReasons: tReasons,
    });
  }
  trainMarkers.sort((a, b) => (a.trainRunId < b.trainRunId ? -1 : 1));

  const totals = service.throughOperatingTotals;
  const operatingTotals = totals && typeof totals === "object"
    ? { days: finite(totals.days), passengers: finite(totals.passengers), trainKm: finite(totals.trainKm), lastOperatingDay: isInt(service.lastThroughOperatingDay) ? service.lastThroughOperatingDay : null }
    : null;
  if (operatingTotals === null) mark("operatingTotals", "service-has-no-operating-totals");
  const liveSummary = live && {
    operatingDay: isInt(live.operatingDay) ? live.operatingDay : null,
    serviceMinute: finite(live.serviceMinute),
    passengers: finite(live.passengers),
    trainKm: finite(live.trainKm),
    trackAccessUsage: (Array.isArray(live.trackAccessUsage) ? live.trackAccessUsage : [])
      .map((u) => ({ agreementId: text(u?.agreementId), trainKm: finite(u?.trainKm), stationStops: finite(u?.stationStops) }))
      .filter((u) => u.agreementId !== null)
      .sort((a, b) => (a.agreementId < b.agreementId ? -1 : 1)),
  };

  return {
    schema: THROUGH_OPERATION_MAP_VIEW_SCHEMA,
    contractVersion: 1,
    throughServiceId: service.throughServiceId,
    throughRouteId: route.throughRouteId,
    routeGeometryRevision: routeRevision,
    serviceRouteGeometryRevision: serviceRevision,
    stale,
    name: text(route.name),
    status,
    statusLabel: STATUS_LABELS[status] ?? null,
    assessmentVerdict: verdict,
    assessmentVerdictLabel: VERDICT_LABELS[verdict] ?? null,
    assessment: {
      violations: [...(service.assessment?.violations ?? [])].sort(),
      conditions: [...(service.assessment?.conditions ?? [])].sort(),
      missingInputs: [...(service.assessment?.missingInputs ?? [])].sort(),
    },
    operatorId: text(service.operatorId),
    playerOperatorId: playerId,
    trainsPerHour: finite(service.trainsPerHour),
    retrofitProgramIds: [...(service.approvedRetrofitProgramIds ?? [])].sort(),
    legs,
    handovers,
    trainMarkers,
    latestSettlement,
    operatingTotals,
    live: liveSummary,
    warnings: warnings.sort(byCode),
    unknown,
    unknownReasons,
  };
}

// --- drawing: `screen` maps [lon, lat] to canvas pixels ---
const path = (ctx, pts, screen) => {
  ctx.beginPath();
  pts.map(screen).forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
};

function handoverMarker(ctx, handover, screen) {
  const style = handover.style;
  if (handover.connectionState === "separated" && handover.fromEnd && handover.toStart) {
    ctx.strokeStyle = style.color;
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 4]);
    path(ctx, [handover.fromEnd, handover.toStart], screen);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  if (!handover.at) return;
  const [x, y] = screen(handover.at);
  ctx.fillStyle = style.color;
  ctx.strokeStyle = "#111318";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(x, y, handover.connectionState === "joined" ? 5 : 8, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  if (handover.connectionState !== "joined") {
    ctx.fillStyle = "#111318";
    ctx.font = "bold 10px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(style.glyph, x, y + 0.5);
  }
}

// Legs with no alignment are not drawn at all; their handover markers and the panel carry the warning.
export function drawThroughOperationOverlay(ctx, model, screen) {
  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  for (const leg of model.legs) {
    if (leg.display !== "line" || !leg.alignment) continue;
    ctx.strokeStyle = "#111318";
    ctx.lineWidth = leg.style.width + 3;
    ctx.setLineDash([]);
    path(ctx, leg.alignment, screen);
    ctx.stroke();
    ctx.strokeStyle = leg.style.color;
    ctx.lineWidth = leg.style.width;
    ctx.setLineDash(leg.style.dash);
    path(ctx, leg.alignment, screen);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  for (const handover of model.handovers) handoverMarker(ctx, handover, screen);
  for (const train of model.trainMarkers) {
    if (!train.drawable) continue;
    const [x, y] = screen(train.location);
    ctx.fillStyle = (train.delayMinutes ?? 0) > 0 ? TRAIN_STYLE.delayedColor : TRAIN_STYLE.color;
    ctx.strokeStyle = "#111318";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

// Player-controlled text (route and operator names) only ever goes through textContent.
export function renderThroughOperationPanel(container, model) {
  container.replaceChildren();
  container.hidden = !model;
  if (!model) return;
  const doc = container.ownerDocument;
  const el = (tag, cls, content) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (content !== undefined) e.textContent = content; return e; };
  const dash = (v) => (v === null || v === undefined ? "미상" : String(v));
  container.append(el("div", "section-label", `직통운행 ${model.name ?? model.throughServiceId}`));
  container.append(el("div", "diag info", `상태 ${model.statusLabel ?? dash(model.status)} · 경영 판정 ${model.assessmentVerdictLabel ?? dash(model.assessmentVerdict)} · 운행사 ${dash(model.operatorId)}`));
  if (model.stale) container.append(el("div", "diag warning", "⚠ 경로가 서비스 판정 이후 바뀌었습니다. 경영 엔진의 재판정이 필요합니다."));
  for (const leg of model.legs) {
    container.append(el("div", "diag info", `${leg.sequence + 1}. ${leg.sourceKindLabel ?? dash(leg.sourceKind)} · 소유 ${dash(leg.infrastructureOwnerId)} → 운행 ${dash(leg.operatorId)} · ${leg.style.label} · 호환 ${dash(leg.compatibility)}${leg.trackAccessAgreementId ? ` · 선로사용 계약 ${leg.trackAccessAgreementId}` : ""}`));
    if (leg.display === "none") container.append(el("div", "diag warning", `⚠ ${leg.sequence + 1}번 구간은 선형이 없어 지도에 그리지 않습니다 (${dash(leg.unknownReasons.alignment)}).`));
    for (const issue of leg.issues) container.append(el("div", `diag ${issue.kind === "violation" ? "error" : "warning"}`, `${leg.sequence + 1}번 구간 — ${issue.code}`));
  }
  for (const h of model.handovers) {
    container.append(el("div", h.connectionState === "joined" ? "diag info" : "diag warning", `경계 ${h.sequence + 1}: ${h.style.label}${h.gapMeters !== null ? ` · 간격 ${h.gapMeters} m` : ""}${h.unknown.includes("physicalConnection") ? ` (${h.unknownReasons.physicalConnection})` : ""}`));
    for (const issue of h.issues) container.append(el("div", `diag ${issue.kind === "violation" ? "error" : "warning"}`, `경계 ${h.sequence + 1} — ${issue.code}`));
  }
  if (model.latestSettlement) {
    const s = model.latestSettlement;
    container.append(el("div", "diag info", `최근 운행정산 ${s.operatingDay}일 · 승객 ${dash(s.passengers)} · 열차-km ${dash(s.trainKm)}`));
    for (const u of s.trackAccessUsage) container.append(el("div", "diag info", `선로사용 ${u.agreementId}: ${dash(u.trainKm)} 열차-km · 정차 ${dash(u.stationStops)}회`));
  } else container.append(el("div", "diag info", "최근 운행정산 없음"));
  if (model.operatingTotals) container.append(el("div", "diag info", `누계 ${dash(model.operatingTotals.days)}일 · 승객 ${dash(model.operatingTotals.passengers)} · 열차-km ${dash(model.operatingTotals.trainKm)}`));
  if (model.live) container.append(el("div", "diag info", `실시간(표시용, 정산 아님) ${model.live.operatingDay === null ? "" : `${model.live.operatingDay}일 `}열차 ${model.trainMarkers.length}대`));
  for (const t of model.trainMarkers) container.append(el("div", t.drawable ? "diag info" : "diag warning", `열차 ${t.trainRunId}${t.delayMinutes !== null ? ` · 지연 ${t.delayMinutes}분` : ""}${t.drawable ? "" : ` · 위치 미상 (${t.unknownReasons.location})`}`));
  for (const w of model.warnings) container.append(el("div", "diag warning", `⚠ ${w.code}`));
}

// Legend (textContent only): every leg style, handover marker and the train marker the overlay draws.
export function renderThroughOperationLegend(container) {
  container.replaceChildren();
  const doc = container.ownerDocument;
  const row = (label, color, dash) => {
    const r = doc.createElement("div");
    r.className = "phase-legend-row";
    const chip = doc.createElement("i");
    chip.className = "phase-chip";
    chip.style.borderTopColor = color;
    chip.style.borderTopStyle = dash && dash.length ? "dashed" : "solid";
    const span = doc.createElement("span");
    span.textContent = label;
    r.append(chip, span);
    container.append(r);
  };
  const title = doc.createElement("div");
  title.className = "section-label";
  title.textContent = "직통운행 (경영 엔진 반환값)";
  container.append(title);
  for (const style of Object.values(LEG_STYLES)) row(style.label, style.color, style.dash);
  for (const style of Object.values(HANDOVER_STYLES)) row(`경계 ${style.glyph} ${style.label}`, style.color, []);
  row(TRAIN_STYLE.label, TRAIN_STYLE.color, []);
}
