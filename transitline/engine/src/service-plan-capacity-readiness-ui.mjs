// Rail capacity readiness panel for map service plans (B16-M6): an independent, READ-ONLY panel (a container element) that shows, per
// service plan, which facts of the rail capacity map are stated and which are not, why that matters to the pre-screening, and where on
// the map the missing ones are filled. It states facts only ("명시됨", "미상", "없음(선언됨)", "적용 결과에 없음"): it says nothing about
// whether a plan can run, computes no headway or capacity and builds no timetable. The player's B16-M4 assumptions are shown in their own
// block, never merged with the map's facts. The panel changes nothing and touches no engine state; "open the editor" is a callback the host
// gives (`onOpenEditor(request)`), and without one there is no such button.
//
//   const panel = mountCapacityReadinessPanel({ container, getServicePlans, getRailGeometries, getApplications, getAssumptions, onOpenEditor, onChange });
import { buildCapacityReadinessView, editorRequestOf } from "./service-plan-capacity-readiness.mjs";

export const READINESS_UI_EVENT = "transitline:service-plan-capacity-readiness";
export const SCOPE_NOTICE = "이 패널은 철도 용량 지도에 적힌 사실 중 비어 있는 곳과 그것을 채울 곳만 보여 줍니다. 운행이 되는지 판단하거나 시격·수송 능력을 계산하지 않고, 아무것도 바꾸지 않습니다. 플레이어가 적은 가정은 지도 사실과 따로 표시합니다.";
export const ASSUMPTION_NOTICE = "플레이어 가정 (지도 사실이 아님) — 사전심사의 선로 항목은 위의 지도 사실을 읽으며, 이 가정은 그것을 채우지 않습니다.";
const STYLE_ID = "transitline-service-plan-capacity-readiness-style";
const CSS = ".svccap-card{margin:6px 0;padding:6px;border:1px solid #2a2f3a;border-radius:6px}.svccap-card.map-fact{border-left:3px solid #4cc9f0}.svccap-assumption{margin-top:6px;padding:4px 6px;border:1px dashed #b5a1e5;border-radius:4px;color:#d9ccf5}.svccap-gap{margin:3px 0;padding:3px 6px;border-left:3px solid #ffb703}.svccap-section{display:block;margin-top:6px;color:#ffe66d}.svccap-note{color:#aab1c0;font-size:11px}.svccap-fact{margin:2px 0}.svccap-detail{margin-left:12px}.svccap-metrics{margin:4px 0}";
const APPLICATION_TEXT = Object.freeze({ current: "현재", stale: "낡음 (지도가 바뀐 뒤의 결과)", none: "없음", "line-not-stated": "운영 노선 연결 안 됨", "other-geometry": "다른 철도 용량 지도의 결과", unknown: "확인할 수 없음 (적용 결과 목록을 받지 못함)" });
const MAPPING_TEXT = Object.freeze({ mapped: "적용 결과의 트랙 구간에 매핑됨", "not-in-application": "적용 결과에 없음", "application-unavailable": "적용 결과가 없어 확인할 수 없음" });
const TERMINAL_TEXT = Object.freeze({ "in-application": "종착 설비가 적용 결과에 있음", "not-in-application": "고른 종착 설비가 적용 결과에 없음", "terminal-data-unknown": "종착 자료가 지도에 없음 (미상)", "not-selected": "종착 설비를 고르지 않음", "application-unavailable": "적용 결과가 없어 확인할 수 없음" });
const TURNBACK_TEXT = Object.freeze({
  attached: "회차선이 접속됨 (지도에서 측정)", "not-attached": "회차선이 접속되지 않음 (지도에서 측정)", unverified: "회차선 접속이 확인되지 않음 (미상)", "candidate-not-in-application": "고른 회차 후보가 적용 결과에 없음",
  "turnback-data-unknown": "회차선 자료가 지도에 없음 (미상)", "not-selected": "회차 후보를 고르지 않음", "no-candidate-stated": "이 설비에 회차 후보가 적혀 있지 않음", "terminal-not-in-application": "설비를 찾을 수 없어 확인할 수 없음", "terminal-not-selected": "설비를 고르지 않아 확인할 수 없음", "terminal-not-readable": "적용 결과를 읽을 수 없음",
});
const FIELD_LABEL = Object.freeze({ technicalProfileId: "기술 프로필", technicalSpecification: "기술사양", notApplicable: "해당 없는 항목", capacityTrainsPerHour: "시간당 열차 수", directionMode: "단·복선", minimumHeadwayMinutes: "최소 시격", closureWindowsBySectionId: "폐쇄 시간창", dayType: "요일 유형", minimumAcceptanceRatio: "수용 비율" });
const el = (doc, tag, props = {}, ...kids) => { const node = doc.createElement(tag); Object.assign(node, props); node.append(...kids); return node; };
const txt = (doc, tag, className, value) => el(doc, tag, { className, textContent: value });
const short = (id) => (typeof id === "string" && id.includes(":") ? `…${id.slice(-4)}` : String(id));

// how one stated-or-unknown value is written (never a default): null is "미상", [] is "없음(선언됨)", a listed set has its count
export function factText(fact, kind) {
  if (fact === null || fact === undefined) return "확인할 수 없음";
  if (kind === "mode") return fact.state === "stated" ? (fact.value === "single" ? "단선(명시)" : "복선(명시)") : "미상";
  if (fact.state === "unknown") return "미상";
  if (fact.state === "declared-none") return "없음(선언됨)";
  return `${fact.count}개 (${fact.ids.map(short).join(", ")})`;
}

export function mountCapacityReadinessPanel({ container, getServicePlans, getRailGeometries = null, getApplications = null, getAssumptions = null, onOpenEditor = null, onChange = () => {} } = {}) {
  if (!container) throw new Error("A readiness container is required");
  if (typeof getServicePlans !== "function") throw new Error("getServicePlans() returning the B16 service plans is required");
  const doc = container.ownerDocument ?? document;
  if (doc.head && doc.getElementById && !doc.getElementById(STYLE_ID)) doc.head.append(el(doc, "style", { id: STYLE_ID, textContent: CSS }));
  let view = null;
  let selectedId = null;
  const given = (getter) => { const v = typeof getter === "function" ? getter() : null; return v === undefined ? null : v; };
  const recompute = () => { view = buildCapacityReadinessView({ servicePlans: given(getServicePlans) ?? [], railGeometries: given(getRailGeometries), applications: given(getApplications), assumptions: given(getAssumptions) }); };
  const button = (label, fn) => { const b = el(doc, "button", { type: "button", textContent: label }); b.addEventListener("click", fn); return b; };
  const outputNow = () => ({ view: structuredClone(view), selectedServicePlanId: selectedId });

  function sectionsBlock(p) {
    const nodes = [txt(doc, "strong", "svccap-section", "구간 사실 (철도 용량 적용 결과 / 철도 용량 지도 원본)")];
    if (!p.sections.length) nodes.push(txt(doc, "div", "svccap-note", "계획에 고른 구간이 없습니다 (미상)."));
    for (const s of p.sections) {
      const geo = (field, kind) => (s[field].geometry ? ` / 지도 원본 ${factText(s[field].geometry, kind)}` : "");
      nodes.push(txt(doc, "div", "svccap-fact", `${s.order}. 구간 ${short(s.sectionId)} · ${MAPPING_TEXT[s.mapping]}${s.trackSegmentId ? ` (트랙 ${s.trackSegmentId})` : ""}`));
      if (s.mapping === "mapped") {
        nodes.push(txt(doc, "div", "svccap-fact svccap-detail", `단·복선 ${factText(s.directionMode.application, "mode")}${geo("directionMode", "mode")} · 폐색 ${factText(s.blockIds.application)}${geo("blockIds")} · 분기기 ${factText(s.junctionResourceIds.application)}${geo("junctionResourceIds")}`));
        if (s.trackSegmentIdDiffers) nodes.push(txt(doc, "div", "svccap-note", `계획이 가진 트랙 번호(${s.planTrackSegmentId})와 적용 결과의 트랙 번호가 다릅니다.`));
      }
    }
    return nodes;
  }
  function turnbacksBlock(p) {
    const nodes = [txt(doc, "strong", "svccap-section", "회차·종착 사실")];
    if (p.turnbacks.state === "not-stated") nodes.push(txt(doc, "div", "svccap-fact", "회차를 적지 않았습니다 (미상)."));
    else if (!p.turnbacks.items.length) nodes.push(txt(doc, "div", "svccap-fact", "회차 없음으로 선언했습니다."));
    for (const t of p.turnbacks.items) {
      nodes.push(txt(doc, "div", "svccap-fact", `${t.key ?? "회차"} · 역 ${short(t.stationId)} · 종착 설비 ${t.terminalResourceId ? short(t.terminalResourceId) : "고르지 않음"}: ${TERMINAL_TEXT[t.terminalState]}`));
      nodes.push(txt(doc, "div", "svccap-fact svccap-detail", `회차 후보 ${t.turnbackCandidateId ? short(t.turnbackCandidateId) : "고르지 않음"}: ${TURNBACK_TEXT[t.turnbackState]}${t.candidateCount === null ? "" : ` · 후보 ${t.candidateCount}개 중 접속 ${t.attachedCandidateCount}개`}`));
    }
    return nodes;
  }
  function assumptionBlock(p) {
    const a = p.assumptions;
    if (!a.supplied) return [];
    const box = el(doc, "div", { className: "svccap-assumption" }, txt(doc, "div", "svccap-note", ASSUMPTION_NOTICE));
    if (!a.present) { box.append(txt(doc, "div", "svccap-fact", "이 계획에 대해 적은 가정이 없습니다.")); return [box]; }
    box.append(txt(doc, "div", "svccap-fact", `가정 상태: ${a.state === "current" ? "현재" : a.state === "stale" ? "계획이 바뀜 (낡음)" : "지도에 없는 계획"} · 적은 항목 ${a.statedFields.length ? a.statedFields.map((f) => FIELD_LABEL[f] ?? f).join(", ") : "없음"}`));
    for (const c of a.compare) {
      const map = c.mapFact.values.length ? c.mapFact.values.map((v) => (v === "single" ? "단선" : "복선")).join("·") + (c.mapFact.allSectionsStated ? "" : " (일부 구간만 명시)") : "미상";
      const mine = c.assumption.value === null ? "적지 않음" : c.assumption.value === "single" ? "단선" : "복선";
      box.append(txt(doc, "div", "svccap-fact", `단·복선 — 지도 사실: ${map} / 플레이어 가정: ${mine}${c.differs === true ? " (서로 다름)" : ""}`));
    }
    box.append(txt(doc, "div", "svccap-fact", `시간당 열차 수(직접 적은 값): ${a.capacityTrainsPerHour === null ? "적지 않음 (미상)" : a.capacityTrainsPerHour} · 최소 시격(분, 직접 적은 값): ${a.minimumHeadwayMinutes === null ? "적지 않음 (미상)" : a.minimumHeadwayMinutes}`));
    return [box];
  }
  function gapsBlock(p) {
    const nodes = [txt(doc, "strong", "svccap-section", `채워야 할 지도 입력 ${p.gaps.length}건`)];
    if (!p.gaps.length) nodes.push(txt(doc, "div", "svccap-note", "지도 사실이 비어 있는 곳이 없습니다 (적힌 사실만 확인함)."));
    for (const gap of p.gaps) {
      const row = el(doc, "div", { className: `svccap-gap ${gap.kind}` }, txt(doc, "div", "", `${gap.message}${gap.turnbackKey ? ` — 회차 ${gap.turnbackKey}` : ""}${gap.sectionIds ? ` — 구간 ${gap.sectionIds.map(short).join(", ")}` : ""}`), txt(doc, "div", "svccap-note", `채울 곳: ${gap.label} (사전심사 항목 ${gap.checkId})`));
      if (typeof onOpenEditor === "function") row.append(button(gap.kind === "capacity-map" ? "철도 용량 편집 열기" : "서비스 계획 편집 열기", () => onOpenEditor(editorRequestOf(p, gap))));
      nodes.push(row);
    }
    return nodes;
  }
  function card(p) {
    const node = el(doc, "div", { className: "svccap-card map-fact" });
    node.append(txt(doc, "div", "svccap-title", `${p.name ?? p.servicePlanId}${p.active === false ? " · 꺼진 계획" : ""}`), el(doc, "div", { className: "svccap-id" }, txt(doc, "span", "", "지도 계획 ID "), txt(doc, "code", "", p.servicePlanId)));
    node.append(txt(doc, "div", "svccap-fact", `운영 노선 ${p.operationalLineId ?? "미상(연결 안 됨)"} · 철도 용량 적용 결과: ${APPLICATION_TEXT[p.application.state]}${p.application.applicationId ? ` (${short(p.application.applicationId)}, 개정 ${short(p.application.applicationRailGeometryRevision)} / 지도 개정 ${short(p.railGeometryRevision)})` : ""}`));
    for (const w of p.warnings) node.append(txt(doc, "div", "svccap-note", `⚠ ${w.code}`));
    node.append(...sectionsBlock(p), ...turnbacksBlock(p), ...gapsBlock(p), ...assumptionBlock(p));
    return node;
  }

  function refresh() {
    recompute();
    const c = view.counts;
    const children = [txt(doc, "p", "svccap-notice", SCOPE_NOTICE),
      txt(doc, "div", "svccap-metrics", `서비스 계획 ${c.plans}건 · 적용 결과 현재 ${c.applicationCurrent} · 낡음 ${c.applicationStale} · 없음/연결 안 됨 ${c.applicationNone} · 채워야 할 지도 입력 ${c.gaps}건`)];
    if (!view.plans.length) children.push(txt(doc, "p", "svccap-empty", "서비스 계획이 없습니다."));
    for (const p of view.plans) {
      children.push(el(doc, "div", { className: `svccap-row${p.servicePlanId === selectedId ? " picked" : ""}` }, txt(doc, "span", "", `${p.name ?? p.servicePlanId} · 적용 결과 ${APPLICATION_TEXT[p.application.state]} · 채워야 할 입력 ${p.counts.gaps}건`), button(p.servicePlanId === selectedId ? "접기" : "자세히", () => { selectedId = p.servicePlanId === selectedId ? null : p.servicePlanId; refresh(); })));
      if (p.servicePlanId === selectedId) children.push(card(p));
    }
    container.replaceChildren(...children);
    const out = outputNow();
    onChange(out);
    container.dispatchEvent?.(new CustomEvent(READINESS_UI_EVENT, { detail: out }));
  }
  refresh();

  return {
    output: outputNow, view: () => structuredClone(view),
    select(id) { selectedId = view.plans.some((p) => p.servicePlanId === id) ? id : null; refresh(); return selectedId === id; },
    deselect() { selectedId = null; refresh(); },
    refresh, get selectedServicePlanId() { return selectedId; }, destroy() { container.replaceChildren(); },
  };
}
