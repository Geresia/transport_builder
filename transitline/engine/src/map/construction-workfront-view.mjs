// Read-only view of work fronts: the construction site itself, each work front's polygon, its hand-drawn
// assembly/storage sub-areas, its equipment access point, and whatever the engine reports about contractor
// assignment and placement feasibility. Nothing here computes cost, duration, a feasibility verdict or a
// contractor recommendation — every judgement value shown here comes verbatim from the engine's own report.
export const KIND_STYLE = {
  site: { label: "공구", color: "#4cc9f0", dash: [10, 6] },
  workfront: { label: "작업면", color: "#ffe66d", dash: [] },
  assembly: { label: "조립장", color: "#2dd4bf", dash: [4, 4] },
  storage: { label: "적치장", color: "#f4a261", dash: [4, 4] },
  access: { label: "반입점", color: "#e5484d", dash: [] },
};
const CANDIDATE_LABEL = { shaft: "수직구", workArea: "작업장" };
const PLACEMENT_LABEL = { feasible: "배치 가능", conditional: "조건부", infeasible: "배치 불가" };

const ACCESS_ID_FIELD = { accessRoad: "roadAccessId", vehicleAccess: "vehicleAccessId" };
const ACCESS_LIST_FIELD = { accessRoad: "accessRoadCandidates", vehicleAccess: "vehicleAccessCandidates" };

// One list-row view per work front the player has placed (`workfronts`: already-built ConstructionWorkfrontGeometry
// objects, one per doc entry — the map layer computes these, this module only styles them).
export function buildWorkfrontMarkerViews(workfronts) {
  return workfronts.map((w) => ({
    workfrontId: w.workfrontId,
    constructionSiteId: w.constructionSiteId,
    kind: w.candidateRef.kind,
    kindLabel: CANDIDATE_LABEL[w.candidateRef.kind] ?? w.candidateRef.kind,
    location: w.location,
    style: KIND_STYLE.workfront,
  }));
}

// workfront: the selected ConstructionWorkfrontGeometry. entry: the same work front's editor-doc entry (carries
// the hand-drawn assembly/storage polygons, which the contract itself only reduces to an area number).
// constructionExport: to draw the site's own outline and resolve the linked access candidate's location.
export function buildWorkfrontDetailView(workfront, entry, constructionExport) {
  if (!workfront) return { active: false };
  const site = constructionExport?.sites?.find((s) => s.constructionSiteId === workfront.constructionSiteId) ?? null;
  let accessLocation = null;
  if (workfront.linkedAccessCandidateRef) {
    const { kind, id } = workfront.linkedAccessCandidateRef;
    accessLocation = site?.[ACCESS_LIST_FIELD[kind]]?.find((c) => c[ACCESS_ID_FIELD[kind]] === id)?.location ?? null;
  }
  return {
    active: true,
    workfrontId: workfront.workfrontId,
    constructionSiteId: workfront.constructionSiteId,
    sitePolygon: site?.polygon ?? null,
    workfrontPolygon: workfront.polygon,
    assemblyPolygon: entry?.assemblyPolygon ?? null,
    storagePolygon: entry?.storagePolygon ?? null,
    accessLocation,
    usableAreaSquareMeters: workfront.usableAreaSquareMeters,
    nearestMajorRoad: workfront.nearestMajorRoad,
    majorRoadAccessible: workfront.majorRoadAccessible,
    equipmentAccessFacts: workfront.equipmentAccessFacts,
    stagingFacts: workfront.stagingFacts,
    spatialFlags: workfront.spatialFlags,
    missing: workfront.unknown.map((f) => ({ field: f, reason: workfront.unknownReasons[f] })),
  };
}

// report: ScenarioRuntime.report() or an equivalent plain object. Looks for this work front among
// report.equipmentAssignments[] (by workfrontId, falling back to constructionSiteId) and reads its contractorId /
// packageContractId / placement verdict exactly as the engine wrote them — never computed, never guessed.
export function buildEquipmentReportView(report, workfront) {
  if (!workfront) return { found: false };
  const list = report?.equipmentAssignments ?? [];
  const a = list.find((x) => x.workfrontId === workfront.workfrontId) ?? list.find((x) => x.constructionSiteId === workfront.constructionSiteId) ?? null;
  if (!a) return { found: false, contractorId: report?.contractorId ?? null, packageContractId: report?.packageContractId ?? null };
  const status = a.placementStatus ?? a.status ?? null;
  return {
    found: true,
    contractorId: a.contractorId ?? report?.contractorId ?? null,
    packageContractId: a.packageContractId ?? report?.packageContractId ?? null,
    placementStatus: status,
    placementLabel: status ? (PLACEMENT_LABEL[status] ?? status) : "상태 불명",
  };
}

const trace = (ctx, pts, screen, close = false) => {
  ctx.beginPath();
  pts.map(screen).forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  if (close) ctx.closePath();
};
function outline(ctx, ring, screen, style, selected) {
  if (!ring) return;
  ctx.save();
  ctx.strokeStyle = style.color;
  ctx.lineWidth = selected ? 3.5 : 2;
  if (style.dash.length) ctx.setLineDash(style.dash);
  trace(ctx, ring, screen, true);
  ctx.stroke();
  ctx.restore();
}

// `screen` maps [lon, lat] to canvas pixels. Draws a small dot per work-front marker view, colour by kind.
export function drawWorkfrontMarkers(ctx, markerViews, screen, selectedWorkfrontId = null) {
  ctx.save();
  for (const mv of markerViews) {
    if (!mv.location) continue;
    const [x, y] = screen(mv.location);
    const selected = mv.workfrontId === selectedWorkfrontId;
    ctx.fillStyle = mv.style.color;
    ctx.strokeStyle = "#111318";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(x, y, selected ? 8 : 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

// Draws the selected work front's site outline, its own polygon, assembly/storage areas and access point —
// each in its KIND_STYLE colour, so the player can tell them apart on sight.
export function drawWorkfrontDetail(ctx, view, screen) {
  if (!view?.active) return;
  outline(ctx, view.sitePolygon, screen, KIND_STYLE.site, false);
  outline(ctx, view.workfrontPolygon, screen, KIND_STYLE.workfront, true);
  outline(ctx, view.assemblyPolygon, screen, KIND_STYLE.assembly, false);
  outline(ctx, view.storagePolygon, screen, KIND_STYLE.storage, false);
  if (view.accessLocation) {
    const [x, y] = screen(view.accessLocation);
    ctx.save();
    ctx.fillStyle = KIND_STYLE.access.color;
    ctx.strokeStyle = "#111318";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, y - 7);
    ctx.lineTo(x + 7, y + 6);
    ctx.lineTo(x - 7, y + 6);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }
}

export function renderWorkfrontPanel(container, markerViews, detailView, equipmentView) {
  container.replaceChildren();
  container.hidden = markerViews.length === 0 && !detailView?.active;
  const doc = container.ownerDocument;
  const el = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const num = (v, digits = 0) => (v === null || v === undefined ? "미상" : v.toLocaleString("en-US", { maximumFractionDigits: digits }));
  const yn = (v) => (v === null ? "미상" : v ? "예" : "아니오");
  if (markerViews.length) container.append(el("div", "section-label", `작업면 ${markerViews.length}개`));
  if (detailView?.active) {
    container.append(el("div", "section-label", `선택한 작업면: ${detailView.workfrontId.slice(0, 18)}…`));
    container.append(el("div", "diag info", `사용 면적 ${num(detailView.usableAreaSquareMeters)} m² · 진입폭 ${num(detailView.equipmentAccessFacts.entryWidthMeters)} m · 회전공간 ${num(detailView.equipmentAccessFacts.turningSpaceSquareMeters)} m²`));
    container.append(el("div", "diag info", `조립장 ${num(detailView.stagingFacts.assemblyAreaSquareMeters)} m² · 적치장 ${num(detailView.stagingFacts.storageAreaSquareMeters)} m² · 반출 접근 ${yn(detailView.stagingFacts.spoilRemovalAccess)} · 반입 접근 ${yn(detailView.stagingFacts.deliveryAccess)}`));
    container.append(el("div", "diag info", `주요 도로: ${detailView.nearestMajorRoad ? `${num(detailView.nearestMajorRoad.distanceMeters, 1)} m` : "미상"} · 접근 가능 ${yn(detailView.majorRoadAccessible)}`));
    if (detailView.spatialFlags.length) container.append(el("div", "diag info", `표시: ${detailView.spatialFlags.join(", ")}`));
    if (detailView.missing.length) container.append(el("div", "diag warning", `⚠ 미상: ${detailView.missing.map((m) => `${m.field}(${m.reason})`).join(", ")}`));
    if (equipmentView) {
      const line = equipmentView.found
        ? `시공사 ${equipmentView.contractorId ?? "미상"} · 계약 ${equipmentView.packageContractId ?? "미상"} · 배치 판정: ${equipmentView.placementLabel}`
        : "엔진 시공사·배치 판정 없음";
      container.append(el("div", "diag info", line));
    }
  }
}
