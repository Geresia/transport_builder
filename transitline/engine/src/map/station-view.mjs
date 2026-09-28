// Display of station candidate sites as separate layers — body, entrances, transfer passages, construction work
// areas, spatial risk markers — plus the management engine's verdict as a read-only layer of its own.
// Read-only over a StationExport (and over the overlay model for the engine layer): nothing here changes the
// export, the report, the plans or any cash / construction state, and nothing says anything about cost or score.
import { REASON_LABELS as DEPOT_REASONS } from "./depot-view.mjs";

export const LAYERS = Object.freeze(["body", "entrance", "transfer", "work", "risk", "engine"]);
export const LAYER_LABELS = Object.freeze({ body: "역 본체", entrance: "출입구", transfer: "환승통로", work: "작업구", risk: "위험 마커", engine: "엔진 판정" });

export const FLAG_LABELS = Object.freeze({
  "body-building-overlap": "본체 건물 중첩",
  "body-water-overlap": "본체 수역 중첩",
  "steep-site": "경사 부지",
  "no-entrance-candidate": "출입구 후보 없음",
  "all-entrances-blocked": "출입구 전부 막힘",
  "no-roadside-entrance": "도로변 출입구 없음",
  "no-clear-work-area": "작업구 후보 전부 막힘",
  "transfer-through-buildings": "환승통로 건물 관통",
});
export const ENTRANCE_FLAG_LABELS = Object.freeze({ "building-collision": "건물 충돌", "in-water": "수역 위", "not-roadside": "도로변 아님" });
export const REASON_LABELS = Object.freeze({
  ...DEPOT_REASONS,
  "no-heading": "방향 미상", "no-alignment": "선형 없음", "no-depth": "깊이 미입력", "no-structure-height": "고가 높이 자료 없음",
  "no-attribute": "속성 자료 없음", "no-parcel-data": "지적 자료 없음", "no-slope-grid": "경사 격자 없음", "not-provided": "입력 없음", unspecified: "원인 미상",
});

// The engine's word for this station, from what the report returned (the overlay model), never from the map.
// null = the engine has said nothing about it yet.
const CONSTRUCTED = { underConstruction: "공사 중", inspection: "공사 중", available: "완공", halted: "공사 중단", cancelled: "사업 취소" };
const APPROVED_STATUS = new Set(["estimated", "approved", "in-project"]);
export function engineStatusFor(site, overlay) {
  const plan = overlay?.plans?.find((p) => p.planId === site.connectedPlanId);
  if (!plan) return null;
  const station = plan.stations.find((s) => s.id === site.connectedStationId);
  if (CONSTRUCTED[plan.phase]) return { label: CONSTRUCTED[plan.phase], tone: plan.phase };
  if (station?.severity === "error") return { label: "불가", tone: "error" };
  if (station?.severity === "warning" || plan.planSeverity === "warning") return { label: "조건부", tone: "warning" };
  if (APPROVED_STATUS.has(plan.status)) return { label: "승인", tone: "approved" };
  return null;
}

const num = (v, digits = 0) => v.toLocaleString("en-US", { maximumFractionDigits: digits });
const unit = (v, u, digits = 0) => (v === null || v === undefined ? null : `${num(v, digits)} ${u}`);
const mid = (pts) => pts[Math.floor(pts.length / 2)];

// [label, text or null when unknown, the unknown[] field that explains a null]
function facts(s) {
  const road = s.nearestRoad ? `${s.nearestRoad.roadClass} ${num(s.nearestRoad.distanceMeters, 0)} m` : s.unknown.includes("nearestRoad") ? null : "60 m 안에 없음";
  const roads = s.roadsThroughBody ? Object.entries(s.roadsThroughBody).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`).join(", ") || "없음" : null;
  return [
    ["본체 길이×폭", s.bodyPolygon ? `${num(s.bodyLengthMeters)} × ${num(s.bodyWidthMeters)} m (${num(s.bodyHeadingDegrees, 1)}°)` : null, "bodyPolygon"],
    ["본체 면적", unit(s.bodyAreaSquareMeters, "m²"), "bodyAreaSquareMeters"],
    ["지표고", unit(s.groundElevationMeters, "m", 1), "groundElevationMeters"],
    ["계획 선로고", unit(s.plannedTrackElevationMeters, "m", 1), "plannedTrackElevationMeters"],
    ["경사 평균/최대", s.averageSlopePercent === null ? null : `${num(s.averageSlopePercent, 1)} / ${num(s.maximumSlopePercent, 1)} %`, "averageSlopePercent"],
    ["건물 중첩", unit(s.intersectedBuildingCount, "동"), "intersectedBuildingCount"],
    ["수역 중첩", unit(s.waterOverlapCount, "곳"), "waterOverlapCount"],
    ["본체를 지나는 도로", roads, "roadsThroughBody"],
    ["가장 가까운 도로", road, "nearestRoad"],
    ["출입구 후보", `${s.entranceCandidates.length}개`, null],
    ["환승 후보", `${s.transferCandidates.length}개`, null],
    ["작업구 후보", s.workAreaCandidates.length ? `${s.workAreaCandidates.length}개 (막힘 ${s.workAreaCandidates.filter((w) => w.spatialFlags.length).length})` : null, "workAreaCandidates"],
    ["보행권 수요지점", `${s.demandAccess.length}곳`, null],
  ];
}
export const factRows = (s) => facts(s).map(([label, text, field]) => ({ label, text: text ?? "미상", missing: text === null, reason: text === null && field ? s.unknownReasons[field] ?? null : null }));

export function buildStationView(stationExport, overlay = null, selectedId = null) {
  const sites = stationExport.sites.map((s) => {
    const flags = s.spatialFlags.map((flag) => ({
      flag, label: FLAG_LABELS[flag],
      at: flag === "transfer-through-buildings" ? mid(s.transferCandidates.find((t) => t.crossings.building > 0)?.alignment ?? [s.location]) : s.location,
    }));
    for (const e of s.entranceCandidates) for (const flag of e.spatialFlags) flags.push({ flag: `entrance:${flag}`, label: ENTRANCE_FLAG_LABELS[flag], at: e.location });
    for (const w of s.workAreaCandidates) if (w.spatialFlags.length) flags.push({ flag: "work-area-blocked", label: "작업구 막힘", at: mid(w.polygon) });
    return {
      id: s.stationSiteId, name: s.name, location: s.location, selected: s.stationSiteId === selectedId,
      body: s.bodyPolygon, heading: s.bodyHeadingDegrees, quality: s.dataQuality,
      entrances: s.entranceCandidates.map((e) => ({ id: e.entranceId, location: e.location, blocked: e.spatialFlags.includes("building-collision") || e.spatialFlags.includes("in-water"), unknownCollision: e.collidingBuildingCount === null })),
      transfers: s.transferCandidates.map((t) => ({ id: t.transferId, alignment: t.alignment, basis: t.basis, target: t.targetName ?? t.targetStationId, distance: t.walkingDistanceMeters })),
      workAreas: s.workAreaCandidates.map((w) => ({ id: w.workAreaId, polygon: w.polygon, slot: w.slot, blocked: w.spatialFlags.length > 0 })),
      flags,
      missing: s.unknown.map((f) => ({ field: f, reason: REASON_LABELS[s.unknownReasons[f]] ?? s.unknownReasons[f] })),
      warnings: s.warnings,
      engine: engineStatusFor(s, overlay),
      facts: factRows(s),
    };
  });
  return { sites, warnings: stationExport.warnings };
}

const BODY = "#4895ef";
const GREEN = "#2fbf71";
const BAD = "#e5484d";
const PURPLE = "#c77dff";
const ORANGE = "#ff9f1c";
const RISK = "#ffb703";
const ENGINE_TONE = { error: BAD, warning: RISK, approved: "#4cc9f0", underConstruction: "#ffd60a", inspection: "#ffd60a", available: GREEN, halted: BAD, cancelled: "#b0798a" };

const path = (ctx, pts, screen, close = false) => {
  ctx.beginPath();
  pts.map(screen).forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  if (close) ctx.closePath();
};
function riskMarker(ctx, [x, y], label) {
  ctx.fillStyle = RISK;
  ctx.strokeStyle = "#111318";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x, y - 8); ctx.lineTo(x + 8, y + 6); ctx.lineTo(x - 8, y + 6); ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "#111318";
  ctx.font = "bold 10px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("!", x, y + 1.5);
  ctx.fillStyle = "#f1f2f5";
  ctx.font = "10px Inter, system-ui, 'Malgun Gothic', sans-serif";
  ctx.textAlign = "left";
  ctx.fillText(label, x + 11, y);
}

// `screen` maps [lon, lat] to canvas pixels; `layers` says which of LAYERS to draw.
export function drawStationOverlay(ctx, view, screen, layers = new Set(LAYERS)) {
  ctx.save();
  for (const s of view.sites) {
    if (layers.has("work")) {
      ctx.strokeStyle = ORANGE;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]);
      for (const w of s.workAreas) {
        ctx.fillStyle = w.blocked ? "rgba(229, 72, 77, 0.22)" : "rgba(255, 159, 28, 0.16)";
        path(ctx, w.polygon, screen, true);
        ctx.fill();
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }
    if (layers.has("transfer")) {
      ctx.strokeStyle = PURPLE;
      ctx.lineWidth = 2.5;
      for (const t of s.transfers) {
        ctx.setLineDash(t.basis === "player-passage" ? [] : [3, 5]);
        path(ctx, t.alignment, screen);
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }
    if (layers.has("body") && s.body) {
      ctx.strokeStyle = BODY;
      ctx.fillStyle = s.selected ? "rgba(72, 149, 239, 0.42)" : "rgba(72, 149, 239, 0.24)";
      ctx.lineWidth = s.selected ? 3 : 2;
      path(ctx, s.body, screen, true);
      ctx.fill();
      ctx.stroke();
    }
    if (layers.has("body")) {
      const [lx, ly] = screen(s.location);
      const label = `역 ${s.name ?? "후보"}`;
      ctx.font = "bold 11px Inter, system-ui, 'Malgun Gothic', sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.lineJoin = "round";
      ctx.lineWidth = 3;
      ctx.strokeStyle = "#111318";
      ctx.strokeText(label, lx, ly);
      ctx.fillStyle = BODY;
      ctx.fillText(label, lx, ly);
      if (!s.body) { ctx.strokeStyle = BODY; ctx.lineWidth = 2; ctx.strokeRect(lx - 7, ly - 7, 14, 14); }
    }
    if (layers.has("entrance")) {
      for (const e of s.entrances) {
        const [x, y] = screen(e.location);
        ctx.fillStyle = e.blocked ? BAD : e.unknownCollision ? "#8c93a4" : GREEN;
        ctx.strokeStyle = "#111318";
        ctx.lineWidth = 1.5;
        ctx.fillRect(x - 5, y - 5, 10, 10);
        ctx.strokeRect(x - 5, y - 5, 10, 10);
        if (e.blocked) { ctx.strokeStyle = "#ffffff"; ctx.beginPath(); ctx.moveTo(x - 3, y - 3); ctx.lineTo(x + 3, y + 3); ctx.moveTo(x + 3, y - 3); ctx.lineTo(x - 3, y + 3); ctx.stroke(); }
      }
    }
    if (layers.has("risk")) s.flags.forEach((f, i) => { const [fx, fy] = screen(f.at); riskMarker(ctx, [fx + 12, fy - 14 - (i % 4) * 16], f.label); });
    if (layers.has("engine") && s.engine) {
      const [x, y] = screen(s.location);
      const text = `엔진: ${s.engine.label}`;
      ctx.font = "bold 10px Inter, system-ui, 'Malgun Gothic', sans-serif";
      const w = ctx.measureText(text).width + 10;
      ctx.fillStyle = "#111318";
      ctx.strokeStyle = ENGINE_TONE[s.engine.tone] ?? "#f1f2f5";
      ctx.lineWidth = 2;
      ctx.fillRect(x - w / 2, y + 14, w, 16);
      ctx.strokeRect(x - w / 2, y + 14, w, 16);
      ctx.fillStyle = ENGINE_TONE[s.engine.tone] ?? "#f1f2f5";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(text, x, y + 22.5);
    }
  }
  if (view.draft?.length) { // a passage waypoint list being placed
    ctx.fillStyle = "#f1f2f5";
    for (const [x, y] of view.draft.map(screen)) { ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2); ctx.fill(); }
  }
  ctx.restore();
}

// Player-controlled text (site and entrance names) only ever goes through textContent.
export function renderStationDetail(container, site) {
  container.replaceChildren();
  if (!site) return;
  const doc = container.ownerDocument;
  const el = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  container.append(el("div", "section-label", `${site.name ?? site.id} · 공간 사실 (자료 품질 ${site.quality})`));
  const table = el("table", "depot-table");
  for (const row of site.facts) {
    const tr = el("tr");
    const td = el("td", row.missing ? "missing" : "", row.text);
    if (row.reason) td.title = REASON_LABELS[row.reason] ?? row.reason;
    tr.append(el("th", "", row.label), td);
    table.append(tr);
  }
  container.append(table);
  if (site.engine) container.append(el("div", "diag info", `엔진 판정(읽기 전용): ${site.engine.label}`));
  else container.append(el("div", "diag info", "엔진 판정 없음: 아직 반환된 상태가 없습니다."));
  if (site.missing.length) container.append(el("div", "diag warning", `⚠ 미상: ${site.missing.map((m) => `${m.field}(${m.reason})`).join(", ")}`));
  for (const f of site.flags) container.append(el("div", "diag warning", `⚠ ${f.label}`));
  for (const w of site.warnings) container.append(el("div", "diag warning", `⚠ ${w.code}`));
}
