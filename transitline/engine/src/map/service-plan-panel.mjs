// The controls of the service plan editor panel: what the player picks and types, as plain DOM built from a state object the
// mount hands over. It decides nothing: every button calls an action of the mount, which edits the player's document through
// service-plan-editor.mjs. Values the player has not stated stay visibly unstated ("미상"), a requested number is always called a
// request, and nothing here says whether the plan can be run.
import { sectionLabel, showValue, stationLabel } from "./service-plan-tools.mjs";
import { REASON_LABELS, TURNBACK_STATES, renderServicePlanFacts, renderServicePlanLegend } from "./service-plan-view.mjs";

export const SCOPE_NOTICE = "이 화면에 적는 배차 간격·편성 수·량 수는 요청한 값이며, 그대로 운행된다는 뜻이 아닙니다. 지도 위의 선로 사실은 읽기만 합니다.";
export const PLAN_KIND_LABELS = Object.freeze({ regular: "평시 계획", "disruption-response": "장애 대응 계획" });
export const PATTERN_LABELS = Object.freeze({ full: "전 구간 운행", "short-turn": "단축 운행(중간 역에서 회차)", "partial-section": "일부 구간만 운행" });
export const INTENT_LABELS = Object.freeze({ "route-end": "노선 끝에서 회차", intermediate: "중간 역에서 회차" });
export const ROLE_LABELS = Object.freeze({ "pull-in": "입고", "pull-out": "출고", both: "입·출고" });
export const MODE_HINTS = Object.freeze({ "pick-section": "지도에서 노선 구간을 순서대로 클릭하세요. 이미 고른 구간을 다시 클릭하면 빼냅니다. 끝내려면 Esc.", "pick-turnback": "지도에서 회차할 역을 클릭하세요. 끝내려면 Esc." });

export const clock = (minute) => `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
const un = (reason) => showValue(null, reason, REASON_LABELS);
const orUn = (value, reasons, field, text = String) => (value === null || value === undefined ? un(reasons?.[field] ?? null) : text(value));

export function renderServicePlanPanel(box, h, s) {
  const { el, button } = h;
  const act = s.act;
  box.replaceChildren();
  const label = (text) => box.append(el("div", "section-label", text));
  const info = (text, cls = "diag info") => box.append(el("div", cls, text));
  const row = () => { const r = el("div", "row"); box.append(r); return r; };

  label("운행계획 편집 (요청 입력)");
  info(SCOPE_NOTICE);

  // --- the map and the application the plan is made on ---
  label("철도 용량 지도와 용량 적용 결과");
  if (!s.geometries.length) info("고를 수 있는 철도 용량 지도가 없습니다.", "diag warning");
  else {
    h.select(row(), "지도", s.geometryId ?? "", [{ value: "", label: "(고르지 않음)" }, ...s.geometries.map((g) => ({ value: g.id, label: `${g.label} · 구간 ${g.sections} · 개정 …${g.revision.slice(-4)}` }))], act.selectGeometry);
    if (s.geometry) {
      if (!s.applications.length) info("이 지도에 적용된 용량 적용 결과가 없습니다 (계획은 만들 수 있고, 노선 연결은 미상으로 남습니다).");
      h.select(row(), "용량 적용 결과", s.applicationLine ?? "", [{ value: "", label: "(연결 안 함)" }, ...s.applications.map((a) => ({ value: a.lineId, label: `${a.lineId} · ${a.state === "current" ? "현재" : "낡음 (지도가 바뀜)"}` }))], act.selectApplication);
      const picked = s.applications.find((a) => a.lineId === s.applicationLine);
      if (picked && picked.state !== "current") info("낡은 용량 적용 결과입니다. 구간별 트랙 번호는 연결되지 않습니다.", "diag warning");
    }
  }

  // --- plans ---
  label(`운행계획 ${s.plans.length}건`);
  const create = row();
  h.input(create, "이름", s.drafts.planName, (v) => act.draft("planName", v));
  button(create, "새 계획 만들기", act.createPlan);
  for (const p of s.plans) {
    const r = el("div", `row${p.key === s.selectedKey ? " picked" : ""}`);
    box.append(r);
    const flags = [!p.active ? "꺼짐" : null, p.state === "stale" ? "지도 낡음" : p.state === "not-recorded" ? "개정 미기록" : null, p.state === null ? "만들 수 없음" : null].filter(Boolean);
    r.append(el("span", "", `${p.key}${p.name ? ` · ${p.name}` : ""}${flags.length ? ` · ${flags.join(" · ")}` : ""}`));
    button(r, "선택", () => act.selectPlan(p.key));
    button(r, p.active ? "끄기" : "켜기", () => (p.active ? act.deactivatePlan(p.key) : act.restorePlan(p.key)));
    button(r, "삭제", () => act.removePlan(p.key));
  }
  if (s.removedKeys.length) info(`삭제한 계획 ${s.removedKeys.length}건 (${s.removedKeys.join(", ")}) — 번호는 다시 쓰지 않습니다.`);

  const plan = s.plan;
  if (plan) {
    const out = s.planOut;
    label(`선택한 계획: ${plan.key}`);
    for (const b of s.model.banners) info(`↻ ${b.text}`, "diag warning");
    if (!out) info("이 계획은 지금 지도에서 읽을 수 없습니다 (지도가 없거나 다른 지도입니다).", "diag warning");
    if (out && out.revision.state !== "current") button(box, "현재 지도로 다시 확인", act.rebind);
    h.input(row(), "이름", plan.name ?? "", (v) => act.setPlanField("name", v === "" ? null : v));
    h.select(row(), "종류", plan.planKind ?? "", [{ value: "", label: "(고르지 않음 · 미상)" }, ...Object.entries(PLAN_KIND_LABELS).map(([value, text]) => ({ value, label: text }))], (v) => act.setPlanField("planKind", v || null));
    h.select(row(), "운행 방식", plan.operatingPattern ?? "", [{ value: "", label: "(고르지 않음 · 미상)" }, ...Object.entries(PATTERN_LABELS).map(([value, text]) => ({ value, label: text }))], (v) => act.setPlanField("operatingPattern", v || null));

    // --- route ---
    label("노선 구간 (고른 순서)");
    const modeButton = (parent, text, kind) => button(parent, text, () => act.setMode(kind), s.mode === kind ? "on" : "");
    const rb = row();
    modeButton(rb, "지도에서 구간 고르기", "pick-section");
    button(rb, "노선 반전", act.reverseRoute);
    button(rb, "구간 모두 비우기", act.clearRoute);
    if (s.mode && MODE_HINTS[s.mode]) info(MODE_HINTS[s.mode]);
    const ids = plan.route?.sectionIds ?? null;
    if (ids === null) info(`구간을 아직 고르지 않았습니다 (${un("route-not-selected")}).`);
    else if (!ids.length) info("구간 없음으로 비워 두었습니다.");
    const known = new Map((out?.route?.sections ?? []).map((x) => [x.sectionId, x]));
    const facts = new Map((out?.spatialFacts?.sections ?? []).map((x) => [x.sectionId, x]));
    (ids ?? []).forEach((id, i) => {
      const r = row();
      const k = known.get(id);
      const f = facts.get(id);
      const way = k ? (k.traversal === "forward" ? "정방향" : k.traversal === "reverse" ? "역방향" : un(k.unknownReasons.traversal)) : "지도에 없는 구간";
      const mode = f ? (f.directionMode === null ? `단·복선 ${un(f.unknownReasons.directionMode)}` : f.directionMode === "single" ? "단선" : "복선") : "";
      r.append(el("span", "", `${i + 1}. ${sectionLabel(id)} · ${way}${mode ? ` · ${mode}` : ""}`));
      if (i > 0) button(r, "▲", () => act.moveSection(i, i - 1));
      if (i < ids.length - 1) button(r, "▼", () => act.moveSection(i, i + 1));
      button(r, "삭제", () => act.removeSection(id));
    });
    if (out?.route) {
      const rt = out.route;
      info(`시작 ${orUn(rt.fromStationId, rt.unknownReasons, "fromStationId", stationLabel)} → 끝 ${orUn(rt.toStationId, rt.unknownReasons, "toStationId", stationLabel)}`);
    }

    // --- directions ---
    label("방향");
    const ends = out?.route?.fromStationId && out?.route?.toStationId;
    const db = row();
    button(db, "양방향 만들기", () => act.addDirections("both"));
    button(db, "정방향만", () => act.addDirections("forward"));
    button(db, "역방향만", () => act.addDirections("reverse"));
    if (!ends) info(`시작·끝 역을 읽을 수 없어 한 번에 만들기는 쓸 수 없습니다 (${un(out?.route?.unknownReasons?.fromStationId ?? "route-not-selected")}). 아래에서 역을 직접 고르세요.`);
    const stationChoices = (out?.route?.stationIds ?? s.routeStations).map((id) => ({ value: id, label: stationLabel(id) }));
    const manual = row();
    h.select(manual, "출발", s.drafts.dirFrom ?? "", [{ value: "", label: "(역 고르기)" }, ...stationChoices], (v) => act.draft("dirFrom", v));
    h.select(manual, "도착", s.drafts.dirTo ?? "", [{ value: "", label: "(역 고르기)" }, ...stationChoices], (v) => act.draft("dirTo", v));
    button(manual, "방향 추가", act.addManualDirection);
    if (plan.directions === null) info(`방향을 적지 않았습니다 (${un("directions-not-stated")}).`);
    else if (!plan.directions.length) info("방향 없음으로 비워 두었습니다.");
    for (const d of plan.directions ?? []) {
      const r = row();
      const built = out?.directions?.find((x) => x.key === d.key);
      r.append(el("span", "", `${d.key} · ${stationLabel(d.fromStationId)} → ${stationLabel(d.toStationId)} · ${built ? (built.orderedSectionIds === null ? un(built.unknownReasons.orderedSectionIds) : `${built.orderedSectionIds.length}개 구간`) : "읽을 수 없음"}`));
      button(r, "삭제", () => act.removeDirection(d.key));
    }
    if (plan.directions !== null) button(box, "방향을 적지 않은 상태로", () => act.clearList("direction"));

    // --- bands ---
    label("시간대 (분은 하루 안의 분, 값은 모두 요청)");
    const d = s.drafts.band;
    const f1 = row();
    h.input(f1, "이름", d.label, (v) => act.draftBand("label", v));
    h.input(f1, "기간 구분", d.periodId, (v) => act.draftBand("periodId", v));
    const f2 = row();
    h.input(f2, "시작(분)", d.startMinute, (v) => act.draftBand("startMinute", v), { narrow: true });
    h.input(f2, "끝(분)", d.endMinute, (v) => act.draftBand("endMinute", v), { narrow: true });
    const f3 = row();
    h.input(f3, "배차 간격 요청(분)", d.headwayMinutes, (v) => act.draftBand("headwayMinutes", v), { narrow: true });
    h.input(f3, "요청 편성 수", d.trainsets, (v) => act.draftBand("trainsets", v), { narrow: true });
    h.input(f3, "요청 량 수", d.formationCars, (v) => act.draftBand("formationCars", v), { narrow: true });
    if (plan.directions?.length) {
      const f4 = row();
      f4.append(el("span", "", "방향"));
      for (const dir of plan.directions) h.check(f4, `${dir.key}${dir.label ? ` ${dir.label}` : ""}`, d.directionKeys === null || d.directionKeys.includes(dir.key), (on) => act.draftBandDirection(dir.key, on));
    }
    const f5 = row();
    button(f5, d.editing ? "시간대 저장" : "시간대 추가", act.saveBand);
    if (d.editing) button(f5, "수정 취소", act.cancelBandEdit);
    if (plan.serviceBands === null) info(`시간대를 적지 않았습니다 (${un("service-bands-not-stated")}).`);
    for (const b of plan.serviceBands ?? []) {
      const r = row();
      const built = out?.serviceBands?.find((x) => x.key === b.key);
      const part = (field, text = String) => (built ? orUn(built[field], built.unknownReasons, field, text) : "읽을 수 없음");
      r.append(el("span", "", `${b.key}${b.label ? ` ${b.label}` : ""}${b.active === false ? " · 꺼짐" : ""} · ${clock(b.startMinute)}–${clock(b.endMinute)} (${b.startMinute}–${b.endMinute}분) · 배차 간격 요청 ${part("playerRequestedHeadwayMinutes", (v) => `${v}분`)} · 요청 편성 수 ${part("playerRequestedTrainsets")} · 요청 량 수 ${part("playerRequestedFormationCars")} · 방향 ${built ? orUn(built.directionKeys, built.unknownReasons, "directionKeys", showValue) : "읽을 수 없음"}`));
      button(r, "수정", () => act.editBand(b.key));
      button(r, b.active === false ? "켜기" : "끄기", () => act.toggleBand(b.key));
      button(r, "삭제", () => act.removeBand(b.key));
    }

    // --- turnbacks ---
    label("회차 (역과 종착 설비 고르기)");
    const tb = row();
    modeButton(tb, "지도에서 회차역 고르기", "pick-turnback");
    button(tb, "회차 없음으로 선언", act.declareNoTurnbacks);
    if (plan.turnbacks !== null) button(tb, "회차를 적지 않은 상태로", () => act.clearList("turnback"));
    if (plan.turnbacks === null) info(`회차를 적지 않았습니다 (${un("turnbacks-not-stated")}).`);
    else if (!plan.turnbacks.length) info("회차 없음으로 선언했습니다.");
    for (const t of plan.turnbacks ?? []) {
      const r = row();
      const built = out?.turnbacks?.find((x) => x.key === t.key);
      const view = s.model.turnbacks.find((x) => x.turnbackId === built?.turnbackId);
      r.append(el("span", "", `${t.key} · ${stationLabel(t.stationId)} · ${built?.position === "start" ? "노선 시작" : built?.position === "end" ? "노선 끝" : built?.position === "middle" ? "중간" : "위치 미상"} · ${view ? `${TURNBACK_STATES[view.state].glyph} ${view.text}` : "읽을 수 없음"}`));
      const facilities = out?.terminals?.find((x) => x.stationId === t.stationId)?.facilities ?? null;
      const r2 = row();
      h.select(r2, "종류", t.intent ?? "", [{ value: "", label: "(고르지 않음)" }, ...Object.entries(INTENT_LABELS).map(([value, text]) => ({ value, label: text }))], (v) => act.setTurnback(t.key, { intent: v || null }));
      h.select(r2, "종착 설비", t.terminalResourceId ?? "", [{ value: "", label: facilities === null ? "(종착 자료 없음 · 미상)" : "(고르지 않음)" }, ...(facilities ?? []).map((f) => ({ value: f.terminalResourceId, label: `…${f.terminalResourceId.slice(-4)} · 승강장 ${f.platformCandidates === null ? "미상" : f.platformCandidates.length} · 회차선 ${f.turnbackCandidates === null ? "미상" : f.turnbackCandidates.length}` }))], (v) => act.setTurnback(t.key, { terminalResourceId: v || null, turnbackCandidateId: null }));
      const chosen = (facilities ?? []).find((f) => f.terminalResourceId === t.terminalResourceId);
      const cands = chosen?.turnbackCandidates ?? null;
      h.select(r2, "회차 후보", t.turnbackCandidateId ?? "", [{ value: "", label: !chosen ? "(설비를 먼저 고르세요)" : cands === null ? "(회차선 자료 없음 · 미상)" : "(고르지 않음)" }, ...(cands ?? []).map((c) => ({ value: c.turnbackCandidateId, label: `…${c.turnbackCandidateId.slice(-4)} · ${c.kind} · 접속 ${c.attached === null ? "미상" : c.attached ? "예" : "아니오"}` }))], (v) => act.setTurnback(t.key, { turnbackCandidateId: v || null }));
      button(r2, "삭제", () => act.removeTurnback(t.key));
    }

    // --- vehicle, depot, assumptions ---
    label("차량 · 차량기지 · 가정 (참조와 글, 맞는지는 확인하지 않음)");
    const vi = s.drafts.vehicle;
    const v1 = row();
    if (s.catalogs.vehicleModels) h.select(v1, "차량 모델", vi.vehicleModelId, [{ value: "", label: "(고르지 않음)" }, ...s.catalogs.vehicleModels.map((m) => ({ value: m.id, label: m.name ?? m.id }))], (v) => act.draftVehicle("vehicleModelId", v));
    else h.input(v1, "차량 모델 ID", vi.vehicleModelId, (v) => act.draftVehicle("vehicleModelId", v));
    h.input(v1, "요청 량 수", vi.requestedCars, (v) => act.draftVehicle("requestedCars", v), { narrow: true });
    h.input(v1, "요청 편성 수", vi.requestedTrainsets, (v) => act.draftVehicle("requestedTrainsets", v), { narrow: true });
    button(v1, "차량 저장", act.saveVehicle);
    const vo = out?.vehicleIntent;
    info(vo ? `차량 모델 ${orUn(vo.vehicleModelId, vo.unknownReasons, "vehicleModelId")} · 요청 량 수 ${orUn(vo.requestedCars, vo.unknownReasons, "requestedCars")} · 요청 편성 수 ${orUn(vo.requestedTrainsets, vo.unknownReasons, "requestedTrainsets")}` : "차량: 읽을 수 없음");
    const dp = s.drafts.depot;
    const d1 = row();
    if (s.catalogs.depots) h.select(d1, "차량기지", dp.depotSiteId, [{ value: "", label: "(고르지 않음)" }, ...s.catalogs.depots.map((m) => ({ value: m.id, label: m.name ?? m.id }))], (v) => act.draftDepot("depotSiteId", v));
    else h.input(d1, "차량기지 ID", dp.depotSiteId, (v) => act.draftDepot("depotSiteId", v));
    h.select(d1, "연결 역", dp.stationId, [{ value: "", label: "(고르지 않음)" }, ...(out?.route?.stationIds ?? s.routeStations).map((id) => ({ value: id, label: stationLabel(id) }))], (v) => act.draftDepot("stationId", v));
    h.select(d1, "입·출고 구분", dp.role, [{ value: "", label: "(고르지 않음)" }, ...Object.entries(ROLE_LABELS).map(([value, text]) => ({ value, label: text }))], (v) => act.draftDepot("role", v));
    button(d1, "입·출고 참조 추가", act.addDepot);
    for (const x of out?.playerInputs?.depotRefs ?? []) {
      const r = row();
      r.append(el("span", "", `${x.key ?? x.depotRefId} · ${x.depotSiteId ?? "차량기지 미상"} · ${x.stationId ? stationLabel(x.stationId) : "역 미상"} · ${x.role ? ROLE_LABELS[x.role] : un("depot-role-not-stated")} · 노선 위 ${orUn(x.stationOnRoute, x.unknownReasons, "stationOnRoute", showValue)}`));
      button(r, "삭제", () => act.removeDepot(x.key));
    }
    const a1 = row();
    h.input(a1, "운영 가정", s.drafts.assumption, (v) => act.draft("assumption", v));
    button(a1, "가정 추가", act.addAssumption);
    for (const x of plan.assumptions ?? []) { const r = row(); r.append(el("span", "", `${x.key} · ${x.text}`)); button(r, "삭제", () => act.removeAssumption(x.key)); }

    const factsBox = el("div");
    box.append(factsBox);
    renderServicePlanFacts(factsBox, el, out);
    button(box, "계획 선택 해제", act.deselect);
  }

  const legend = el("div");
  box.append(legend);
  renderServicePlanLegend(legend, el);
  info(s.saved === null ? "저장 전" : s.saved ? "저장됨 (이 브라우저에 저장)" : "저장하지 못함 (저장소를 쓸 수 없음)");
  for (const n of s.notes) info(`⚠ ${n.code}${n.message ? ` — ${n.message}` : ""}`, "diag warning");
  for (const w of s.exportWarnings) info(`⚠ ${w.code}${w.reasons?.[0]?.code ? ` (${w.reasons[0].code})` : ""}`, "diag warning");
}
