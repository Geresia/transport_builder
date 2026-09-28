// Display of depot candidate sites: parcel, connection track, spatial risk markers, a comparison table and
// missing-data warnings. Read-only over a DepotExport, and separate from the construction-phase overlay
// (overlay.mjs): nothing here says anything about cost, opposition or score.

export const FLAG_LABELS = Object.freeze({
  "building-overlap": "건물 중첩",
  "water-overlap": "수역 중첩",
  "steep-site": "경사 부지",
  "near-residential": "주거지 인접",
  "connection-crosses-water": "연결선 수역 횡단",
  "connection-through-buildings": "연결선 건물 관통",
});
const CONNECTION_FLAGS = new Set(["connection-crosses-water", "connection-through-buildings"]);
export const REASON_LABELS = Object.freeze({
  "no-layer": "자료 없음", "outside-coverage": "자료 범위 밖", "no-polygon": "부지 폴리곤 없음", "no-connection": "본선 미선택",
  "connection-unresolved": "연결 대상 확인 불가", "no-dem-value": "고도 자료 결측", "no-stations": "역 없음", "no-terminal": "종점 없음",
});
const REUSE_LABELS = { within: "철도부지 안", overlaps: "철도부지와 겹침", adjacent: "철도부지 인접", none: "없음" };

const num = (v, digits = 0) => v.toLocaleString("en-US", { maximumFractionDigits: digits });
const withUnit = (v, unit, digits = 0) => (v === null || v === undefined ? null : `${num(v, digits)} ${unit}`);

// [column label, cell text or null when unknown, the unknown[] field that explains a null]
const columns = (s) => [
  ["면적", withUnit(s.areaSquareMeters, "m²"), "areaSquareMeters"],
  ["본선 직선거리", withUnit(s.distanceToMainlineMeters, "m"), "distanceToMainlineMeters"],
  ["입출고선 길이", withUnit(s.connectionTrackLengthMeters, "m"), "connectionTrackLengthMeters"],
  ["최근접 역", withUnit(s.distanceToNearestStationMeters, "m"), "distanceToNearestStationMeters"],
  ["종점 거리", withUnit(s.distanceToTerminalMeters, "m"), "distanceToTerminalMeters"],
  ["경사 평균/최대", s.averageSlopePercent === null ? null : `${num(s.averageSlopePercent, 1)} / ${num(s.maximumSlopePercent, 1)} %`, "averageSlopePercent"],
  ["건물 중첩", withUnit(s.intersectedBuildingCount, "동"), "intersectedBuildingCount"],
  ["도로 횡단", withUnit(s.roadCrossingCount, "곳"), "roadCrossingCount"],
  ["수역 횡단", withUnit(s.waterCrossingCount, "곳"), "waterCrossingCount"],
  ["주거지 거리", s.distanceToResidentialMeters !== null ? withUnit(s.distanceToResidentialMeters, "m") : s.unknown.includes("distanceToResidentialMeters") ? null : `${num(s.residentialSearchRadiusMeters)} m 초과`, "distanceToResidentialMeters"],
  ["주변 건물 밀도", withUnit(s.surroundingBuildingDensity, "동/km²"), "surroundingBuildingDensity"],
  ["기존 철도부지", s.existingFacilityReuse ? REUSE_LABELS[s.existingFacilityReuse.status] : null, "existingFacilityReuse"],
];

export function comparisonRows(sites) {
  return sites.map((s) => ({
    depotSiteId: s.depotSiteId,
    name: s.name ?? s.depotSiteId,
    quality: s.dataQuality,
    cells: columns(s).map(([label, text, field]) => ({ label, text: text ?? "미상", missing: text === null, reason: text === null ? s.unknownReasons[field] ?? null : null })),
  }));
}

export function buildDepotView(depotExport, selectedId = null) {
  const sites = depotExport.sites.map((s) => {
    const mid = s.connectionAlignment ? s.connectionAlignment[Math.floor(s.connectionAlignment.length / 2)] : null;
    return {
      id: s.depotSiteId, name: s.name, kind: s.geometryKind, polygon: s.polygon, location: s.location,
      alignment: s.connectionAlignment, attach: s.connectionAttachPoint, quality: s.dataQuality,
      selected: s.depotSiteId === selectedId,
      flags: s.spatialFlags.map((flag) => ({ flag, label: FLAG_LABELS[flag], at: CONNECTION_FLAGS.has(flag) && mid ? mid : s.location, onConnection: CONNECTION_FLAGS.has(flag) })),
      missing: s.unknown.filter((f) => f !== "polygon").map((f) => ({ field: f, reason: REASON_LABELS[s.unknownReasons[f]] ?? s.unknownReasons[f] })),
      warnings: s.warnings,
    };
  });
  return { sites, rows: comparisonRows(depotExport.sites), warnings: depotExport.warnings };
}

const TEAL = "#2dd4bf";
const ORANGE = "#ff9f1c";
const RISK = "#ffb703";

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

// `screen` maps [lon, lat] to canvas pixels.
export function drawDepotOverlay(ctx, view, screen) {
  ctx.save();
  for (const s of view.sites) {
    if (s.alignment) {
      ctx.strokeStyle = ORANGE;
      ctx.lineWidth = 3;
      ctx.setLineDash([8, 5]);
      ctx.beginPath();
      s.alignment.map(screen).forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.stroke();
      ctx.setLineDash([]);
      const [ax, ay] = screen(s.attach);
      ctx.fillStyle = ORANGE;
      ctx.beginPath();
      ctx.arc(ax, ay, 4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.strokeStyle = TEAL;
    ctx.fillStyle = s.selected ? "rgba(45, 212, 191, 0.40)" : "rgba(45, 212, 191, 0.22)";
    ctx.lineWidth = s.selected ? 3 : 2;
    if (s.polygon) {
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      s.polygon.map(screen).forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.setLineDash([]);
    } else {
      const [x, y] = screen(s.location);
      ctx.fillRect(x - 7, y - 7, 14, 14);
      ctx.strokeRect(x - 7, y - 7, 14, 14);
    }
    const [lx, ly] = screen(s.location);
    const label = `차량기지 ${s.name ?? "후보"}`;
    ctx.font = "bold 11px Inter, system-ui, 'Malgun Gothic', sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    ctx.lineWidth = 3;
    ctx.strokeStyle = "#111318";
    ctx.strokeText(label, lx, ly);
    ctx.fillStyle = TEAL;
    ctx.fillText(label, lx, ly);
    s.flags.forEach((f, i) => { const [fx, fy] = screen(f.at); riskMarker(ctx, [fx + 12, fy - 14 - i * 16], f.label); });
  }
  // the parcel being drawn right now
  if (view.draft?.length) {
    const pts = view.draft.map(screen);
    ctx.strokeStyle = "#f1f2f5";
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 5]);
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#f1f2f5";
    for (const [x, y] of pts) { ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2); ctx.fill(); }
  }
  ctx.restore();
}

// Player-controlled text (site names) only ever goes through textContent.
export function renderDepotCompare(container, view) {
  container.replaceChildren();
  container.hidden = view.sites.length === 0;
  if (!view.sites.length) return;
  const doc = container.ownerDocument;
  const el = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  container.append(el("div", "section-label", `차량기지 후보 비교 ${view.sites.length}곳`));
  const table = el("table", "depot-table");
  const head = el("tr");
  head.append(el("th", "", "후보지"), ...view.rows[0].cells.map((c) => el("th", "", c.label)), el("th", "", "자료 품질"));
  table.append(head);
  for (const row of view.rows) {
    const tr = el("tr");
    tr.append(el("th", "", row.name));
    for (const cell of row.cells) {
      const td = el("td", cell.missing ? "missing" : "", cell.text);
      if (cell.reason) td.title = REASON_LABELS[cell.reason] ?? cell.reason;
      tr.append(td);
    }
    tr.append(el("td", "", row.quality));
    table.append(tr);
  }
  container.append(table);
  for (const s of view.sites) {
    if (s.missing.length) container.append(el("div", "diag warning", `⚠ ${s.name ?? s.id} 미상: ${s.missing.map((m) => `${m.field}(${m.reason})`).join(", ")}`));
    for (const w of s.warnings) container.append(el("div", "diag warning", `⚠ ${s.name ?? s.id}: ${w.code}`));
    for (const f of s.flags) container.append(el("div", "diag warning", `⚠ ${s.name ?? s.id}: ${f.label}`));
  }
  for (const w of view.warnings) container.append(el("div", "diag warning", `⚠ ${w.code}`));
}
