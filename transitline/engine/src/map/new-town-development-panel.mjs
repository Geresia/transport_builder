// The panel of the new-town development editor mount: the developments and phases the player drew, the fields they may declare, the
// station sites and rail lines they may name, and - for the selected phase - the spatial FACTS the map holds.  Pure DOM building over
// what the mount hands in; it edits through `act` and never touches a document itself.  Wording rules: an unknown value (null) says
// so and says why; a list the player stated empty and a list the map measured empty read differently; a measured 0 stays "0"; a
// distance to a rail line or a station is a distance and the panel says that it is not a connection.  No figure about people,
// homes, jobs, demand, traffic, cost or schedule appears, because none is made.
import { LAND_USE_SUGGESTIONS } from "./new-town-development.mjs";
import { FLAG_LABELS, LAND_USE_LABELS, REASON_LABELS, RELATION_LABELS, shortId, showDeclared, showMeasured, showValue } from "./new-town-development-tools.mjs";

export const SCOPE_NOTICE = "이 화면은 지도에 그린 공간 사실만 보여 줍니다. 숫자로 헤아리거나 판단하지 않고, 어떤 상태도 바꾸지 않습니다.";
export const RAIL_NOTICE = "선로 후보는 거리와 겹침의 사실일 뿐, 접속이나 개통을 뜻하지 않습니다.";
export const NODE_NOTICE = "노드는 위치만 보여 줍니다. 구역 안에 노드가 없다는 것은 아무것도 뜻하지 않습니다.";
export const STORAGE_NOTICE = "이 화면은 저장소를 쓰지 않습니다. 저장 문자열은 호스트가 serialize()로 받아 보관합니다.";

const n = (v, digits = 1) => v.toLocaleString("en-US", { maximumFractionDigits: digits });
const KIND = { plan: "계획", external: "기존" };
const stationText = (s) => `${shortId(s.stationId)} (${KIND[s.stationKind] ?? s.stationKind})`;

function railRow(c) {
  const where = c.refKind === "plan-segment" ? `계획 구간 ${shortId(c.segmentId)}` : `기존 선로 ${shortId(c.externalLineId)}`;
  return `${where}${c.declaredByPlayer ? " · 플레이어 지정" : ""} · ${RELATION_LABELS[c.relation] ?? c.relation} · ${n(c.distanceMeters)} m`;
}
const roadRow = (c) => `${c.roadClass ?? "분류 없음"} 도로 ${shortId(c.roadRefId)} · ${RELATION_LABELS[c.relation] ?? c.relation} · ${n(c.distanceMeters)} m`;
const refRow = (ref) => (ref.planId ? `계획 구간 ${shortId(ref.segmentId ?? "*")}` : `기존 선로 ${shortId(ref.externalLineId)}`);

function factRows(parent, el, phase) {
  const f = phase.spatialFacts;
  const r = phase.unknownReasons;
  const row = (label, text) => parent.append(el("div", "fact", `${label}: ${text}`));
  row("면적", showValue(phase.areaSquareMeters === null ? null : `${n(phase.areaSquareMeters)} m²`, r.areaSquareMeters));
  row("둘레", showValue(phase.perimeterMeters === null ? null : `${n(phase.perimeterMeters)} m`, r.perimeterMeters));
  row("팩 범위 안", showValue(f.withinPackBoundingBox, r.withinPackBoundingBox));
  row("구역 안의 역", showMeasured(f.stationsInside, r.stationsInside, stationText));
  row("가장 가까운 계획 역", f.nearestPlannedStation ? `${shortId(f.nearestPlannedStation.stationId)} · ${n(f.nearestPlannedStation.distanceMeters)} m` : showValue(null, r.nearestPlannedStation));
  row("가장 가까운 기존 역", f.nearestExistingStation ? `${shortId(f.nearestExistingStation.stationId)} · ${n(f.nearestExistingStation.distanceMeters)} m` : showValue(null, r.nearestExistingStation));
  row("구역 안의 노드 ID (위치만)", showMeasured(f.demandNodeRefsInside, r.demandNodeRefsInside));
  row("가장 가까운 노드", f.nearestDemandNode ? `${f.nearestDemandNode.nodeId} · ${n(f.nearestDemandNode.distanceMeters)} m` : showValue(null, r.nearestDemandNode));
  row("구역을 지나는 도로 수", f.roadsThroughArea ? `고속 ${f.roadsThroughArea.highway} · 간선 ${f.roadsThroughArea.major} · 이면 ${f.roadsThroughArea.minor}` : showValue(null, r.roadsThroughArea));
  row("겹치는 수역 수", showValue(f.waterOverlapCount, r.waterOverlapCount));
  row("겹치는 건물 수", showValue(f.intersectedBuildingCount, r.intersectedBuildingCount));
  row("지반 고도", showValue(f.groundElevationMeters === null ? null : `${n(f.groundElevationMeters)} m`, r.groundElevationMeters));
  row("경사 평균 / 최대", f.averageSlopePercent === null ? showValue(null, r.averageSlopePercent) : `${n(f.averageSlopePercent, 2)} / ${n(f.maximumSlopePercent, 2)} %`);
  row("겹치는 다른 단계", showMeasured(f.overlapsPhaseIds, r.overlapsPhaseIds, shortId));
  row("측정된 표지", phase.spatialFlags.length ? phase.spatialFlags.map((x) => FLAG_LABELS[x] ?? x).join(", ") : "없음 (측정된 것만 해당; 미상 항목은 포함하지 않음)");
  parent.append(el("div", "diag info", RAIL_NOTICE));
  row(`선로 후보 (반경 ${n(f.railSearchRadiusMeters, 0)} m)`, phase.railAccessCandidates === null ? showValue(null, r.railAccessCandidates) : phase.railAccessCandidates.length ? "" : "없음 (측정됨)");
  for (const cand of phase.railAccessCandidates ?? []) parent.append(el("div", "fact sub", railRow(cand)));
  row(`도로 후보 (반경 ${n(f.roadSearchRadiusMeters, 0)} m)`, phase.roadAccessCandidates === null ? showValue(null, r.roadAccessCandidates) : phase.roadAccessCandidates.length ? "" : "없음 (측정됨)");
  for (const cand of phase.roadAccessCandidates ?? []) parent.append(el("div", "fact sub", roadRow(cand)));
  parent.append(el("div", "diag info", NODE_NOTICE));
  row("자료 품질", phase.dataQuality);
  row("읽은 레이어", phase.sourceLayers.length ? phase.sourceLayers.map((s) => s.layer).join(", ") : "없음");
  if (phase.unknown.length) parent.append(el("div", "diag warning", `미상 항목: ${phase.unknown.map((u) => `${u} (${REASON_LABELS[r[u]] ?? r[u]})`).join(", ")}`));
}

export function renderNewTownDevelopmentPanel(box, h, c) {
  const { el } = h;
  const act = c.act;
  box.append(el("div", "section-label", "신도시 개발 지도"), el("div", "diag info", SCOPE_NOTICE));
  if (c.mode === "draw") box.append(el("div", "diag info", `지도를 눌러 꼭짓점을 찍고 '완료'(Enter)를 누르세요. 찍은 점 ${c.draftCount}개 (Backspace: 마지막 점 지우기, Esc: 취소)`));
  if (c.mode === "pick-station") box.append(el("div", "diag info", "지도에서 역 표시를 눌러 역 부지로 지정하세요."));
  if (c.mode === "pick-rail") box.append(el("div", "diag info", "지도에서 선로를 눌러 참조로 지정하세요."));
  for (const w of c.warnings) box.append(el("div", "diag warning", `⚠ ${w.text}`));

  // --- developments ---
  box.append(el("div", "section-label", `개발 구역 ${c.model.developments.length}곳`));
  h.button(box, "＋ 개발 구역", act.createDevelopment);
  for (const dev of c.model.developments) {
    const row = el("div", `row${dev.selected ? " picked" : ""}`);
    h.button(row, `${dev.selected ? "▶ " : ""}${dev.name ?? dev.key}${dev.active ? "" : " (비활성)"} · 단계 ${dev.phases.length}`, () => act.selectDevelopment(dev.key));
    h.button(row, dev.active ? "구역 비활성" : "구역 복원", () => act.toggleDevelopment(dev.key));
    h.button(row, "구역 삭제", () => act.removeDevelopment(dev.key));
    box.append(row);
  }
  if (c.removed.developments) box.append(el("div", "diag info", `삭제한 개발 구역 key ${c.removed.developments}개는 다시 쓰지 않습니다.`));

  const dev = c.devDoc;
  if (!dev) { box.append(el("div", "diag info", STORAGE_NOTICE)); return; }
  const devView = c.model.developments.find((d) => d.key === dev.key);
  box.append(el("div", "section-label", "선택한 개발 구역"));
  h.input(box, "구역 이름", dev.name ?? "", act.renameDevelopment);
  box.append(el("div", "diag info", `개발 ID ${c.devOut ? shortId(c.devOut.developmentId) : "미상"} · key ${dev.key}`));
  h.button(box, "＋ 단계", act.createPhase);
  for (const phase of devView.phases) {
    const row = el("div", `row${phase.selected ? " picked" : ""}`);
    h.button(row, `${phase.selected ? "▶ " : ""}${phase.sequence}. ${phase.name ?? "단계"}${phase.landUse ? ` · ${phase.landUse}` : ""}${phase.active ? "" : " (비활성)"}${phase.polygon ? "" : " · 다각형 없음"}`, () => act.selectPhase(dev.key, phase.key));
    h.button(row, "▲", () => act.reorderPhase(phase.key, -1));
    h.button(row, "▼", () => act.reorderPhase(phase.key, 1));
    h.button(row, phase.active ? "단계 비활성" : "단계 복원", () => act.togglePhase(dev.key, phase.key));
    h.button(row, "단계 삭제", () => act.removePhase(dev.key, phase.key));
    box.append(row);
  }
  if (c.removed.phases) box.append(el("div", "diag info", `삭제한 단계 key ${c.removed.phases}개는 다시 쓰지 않습니다.`));

  // --- the selected phase ---
  const phase = c.phaseDoc;
  if (!phase) {
    if (c.devOut) {
      box.append(el("div", "section-label", "개발 구역의 공간 사실"));
      const row = (label, text) => box.append(el("div", "fact", `${label}: ${text}`));
      row("단계 수 / 활성 단계 수", `${c.devOut.phaseCount} / ${c.devOut.activePhaseCount}`);
      row("활성 단계 면적의 합 (겹침은 두 번 셈)", showValue(c.devOut.phaseAreaSumSquareMeters === null ? null : `${n(c.devOut.phaseAreaSumSquareMeters)} m²`, c.devOut.unknownReasons.phaseAreaSumSquareMeters));
      row("측정된 표지", c.devOut.spatialFlags.length ? c.devOut.spatialFlags.map((x) => FLAG_LABELS[x] ?? x).join(", ") : "없음 (측정된 것만 해당)");
      row("자료 품질", c.devOut.dataQuality);
    }
    box.append(el("div", "diag info", STORAGE_NOTICE));
    return;
  }
  box.append(el("div", "section-label", "선택한 단계"));
  h.input(box, "단계 이름", phase.name ?? "", act.renamePhase);
  h.input(box, "용도 선언", phase.playerDeclaredLandUse ?? "", act.setLandUse);
  const uses = el("div", "row");
  for (const key of LAND_USE_SUGGESTIONS) h.button(uses, LAND_USE_LABELS[key] ?? key, () => act.setLandUse(key));
  h.button(uses, "용도 지우기", () => act.setLandUse(""));
  box.append(uses);
  box.append(el("div", "diag info", `선언한 용도: ${showValue(phase.playerDeclaredLandUse, "not-stated")} (플레이어의 말 그대로)`));
  h.input(box, "인도 순서", phase.playerDeclaredDeliveryOrder === null ? "" : String(phase.playerDeclaredDeliveryOrder), act.setDeliveryOrder, { narrow: true });
  box.append(el("div", "diag info", `단계 순서(sequence) ${c.phaseOut?.sequence ?? "미상"} · 선언한 인도 순서 ${showValue(phase.playerDeclaredDeliveryOrder, "not-stated")} · 단계 ID ${c.phaseOut ? shortId(c.phaseOut.phaseId) : "미상"} · key ${phase.key}`));

  const draw = el("div", "row");
  if (c.mode === "draw") { h.button(draw, "완료", act.finishDraw); h.button(draw, "취소", act.cancelDraw); }
  else h.button(draw, phase.polygon ? "다시 그리기" : "다각형 그리기", act.startDraw);
  if (c.vertexIndex !== null && phase.polygon) { h.button(draw, "점 삭제", act.removeVertex); h.button(draw, "점 선택 해제", act.deselectVertex); }
  box.append(draw);
  box.append(el("div", "diag info", phase.polygon ? `꼭짓점 ${phase.polygon.length}개${c.vertexIndex !== null ? ` · ${c.vertexIndex + 1}번째 점 선택됨` : ""} · 점을 끌어 옮기고, 변을 더블클릭해 점을 넣고, Delete로 점을 지웁니다.` : "다각형이 없습니다 (미상)."));

  // station sites and rail lines the player names: null = not stated, [] = states there are none
  box.append(el("div", "section-label", "역 부지 (플레이어 지정)"));
  box.append(el("div", "diag info", `지정한 역: ${showDeclared(phase.stationRefs, "not-stated", (s) => `${shortId(s.stationId)} (${KIND[s.stationKind] ?? "종류 미상"})`)}`));
  for (const [i, ref] of (phase.stationRefs ?? []).entries()) { const row = el("div", "row"); row.append(el("span", "", `${shortId(ref.stationId)} (${KIND[ref.stationKind] ?? "종류 미상"})`)); h.button(row, "빼기", () => act.removeStationRef(i)); box.append(row); }
  const sBar = el("div", "row");
  h.button(sBar, c.mode === "pick-station" ? "고르기 끝내기" : "지도에서 역 고르기", () => act.setMode(c.mode === "pick-station" ? null : "pick-station"));
  h.button(sBar, "없다고 선언", act.declareNoStations);
  h.button(sBar, "말하지 않음으로 되돌리기", act.clearStations);
  box.append(sBar);
  h.input(box, "역 ID 입력", c.drafts.stationId, act.draftStationId);
  h.button(box, "역 ID로 추가", act.addStationById);
  box.append(el("div", "section-label", "선로 참조 (플레이어 지정)"));
  box.append(el("div", "diag info", `지정한 선로: ${showDeclared(phase.railRefs, "not-stated", refRow)}`));
  for (const [i, ref] of (phase.railRefs ?? []).entries()) { const row = el("div", "row"); row.append(el("span", "", refRow(ref))); h.button(row, "빼기", () => act.removeRailRef(i)); box.append(row); }
  const rBar = el("div", "row");
  h.button(rBar, c.mode === "pick-rail" ? "고르기 끝내기" : "지도에서 선로 고르기", () => act.setMode(c.mode === "pick-rail" ? null : "pick-rail"));
  h.button(rBar, "없다고 선언", act.declareNoRail);
  h.button(rBar, "말하지 않음으로 되돌리기", act.clearRail);
  box.append(rBar);
  box.append(el("div", "diag info", `지도에서 읽은 역 ${c.map.stations}개 · 선로 ${c.map.railLines}개`));

  // --- the facts the map holds for this phase ---
  box.append(el("div", "section-label", "선택한 단계의 공간 사실"));
  if (c.phaseOut) factRows(box, el, c.phaseOut);
  else box.append(el("div", "diag info", "공간 사실을 아직 만들지 못했습니다 (미상)."));
  box.append(el("div", "diag info", STORAGE_NOTICE));
}
