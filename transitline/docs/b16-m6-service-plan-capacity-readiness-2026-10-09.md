# B16-M6 운행계획용 철도용량 준비도·연결 패널 — Codex 인수 문서

B16 운행계획(M2/M3/M4)이 철도용량 지도(B13 rail-capacity geometry/application)의 **단선·복선, 폐색, 분기기, 종착·회차 자원 사실**이 비어 있을 때 E1 사전심사에서 unknown으로 막힌다. 이 패널은 플레이어가 **"왜 막혔는지 / 어느 지도 입력을 채워야 하는지"**를 이해하도록, 계획마다 지도 사실이 **적혀 있는지·비어 있는지**와 **채울 곳**만 보여 주는 읽기 전용 독립 패널이다. 기준은 master `9bd3f59`, 브랜치 `b16-m6-rail-capacity-readiness`.

## 경계

- **사실 상태만 표시한다.** "명시됨 / 미상 / 없음(선언됨) / 적용 결과에 없음 / 접속됨 / 접속 안 됨 / 확인되지 않음". 운행이 가능한지 불가능한지 판정하지 않고, 시격·용량을 계산하지 않으며, 시간표·비용·수요·혼잡·운임을 만들지 않는다(출력 키·패널 문구·소스를 테스트가 검사한다). 요약에도 "준비 완료/차단" 같은 판정 단어를 쓰지 않는다(`ready`, `blocked`, `possible` 같은 키가 없음).
- **아무것도 바꾸지 않는다.** 입력(계획 export, 철도용량 geometry/application, M4 export)은 읽기만 한다(얼린 입력 테스트). "철도 용량 편집 열기" / "서비스 계획 편집 열기"는 **호스트가 준 콜백**(`onOpenEditor(request)`)을 부를 뿐이며, 콜백이 없으면 버튼이 없다. `main.mjs`, 엔진, `management/**`, `scenario-runtime.mjs`, `index.html`, `style.css`, 기존 `map/` 모듈은 수정하지 않았다. 새 view 모듈은 **아무것도 import하지 않고**, 패널은 view 모듈 하나만 import한다(테스트로 고정).
- **지도 사실과 플레이어 가정을 섞지 않는다.** M4 가정은 점선 테두리의 별도 블록("플레이어 가정 (지도 사실이 아님)")에만 나오고, 지도 사실 줄·`gaps`에는 영향이 없다(테스트: 가정을 주든 안 주든 `sections`와 `gaps`가 바이트까지 같다).

## 파일

| 파일 | 역할 |
|---|---|
| `engine/src/service-plan-capacity-readiness.mjs` | 순수 view `buildCapacityReadinessView`, `listState`/`modeState`, `editorRequestOf` (import 없음) |
| `engine/src/service-plan-capacity-readiness-ui.mjs` | `mountCapacityReadinessPanel` — 컨테이너에 그리는 독립 패널(자기 `<style>` 포함) |
| `scripts/lib/capacity-readiness-world.mjs` | 합성 B16 세계: 실제 `applyRailCapacityGeometry`로 적용한 운영 노선 + 실제 편집기·계약으로 만든 계획 5가지 사례(브라우저에서도 로드됨) |
| `engine/test/service-plan-capacity-readiness.test.mjs` | view 13개 |
| `engine/test/service-plan-capacity-readiness-ui.test.mjs` | 패널 10개(fake DOM) |

## 입력과 출력

```js
import { mountCapacityReadinessPanel } from "./service-plan-capacity-readiness-ui.mjs";
const readiness = mountCapacityReadinessPanel({
  container: $("scenario-service-plan-capacity-readiness"),
  getServicePlans:   () => servicePlanEditor?.output().export?.plans ?? [],     // B16-M1/M2 계획 (필수)
  getRailGeometries: () => railCapacityDesign?.output().railGeometries ?? null, // 선택: RailCapacityGeometry v1 목록 (지도 원본 값 표시)
  getApplications:   () => runtime.railCapacityApplicationReport(),             // 선택이지만 사실상 필요: rail-capacity-application/1 목록
  getAssumptions:    () => servicePlanAssumptions?.output().export ?? null,     // 선택: B16-M4 export (없으면 가정 블록이 없음)
  onOpenEditor: (request) => { /* 호스트가 편집기를 연다 */ },                  // 선택
  onChange: (out) => {},
});
```

- `getApplications`를 안 주면 적용 결과 목록을 볼 수 없다: 계획 자신의 `capacityApplicationState`만 쓰고(`detailsAvailable: false`) 구간 사실은 "적용 결과가 없어 확인할 수 없음"으로 나온다.
- `output()` → `{ view, selectedServicePlanId }`, `view()` → 아래 view의 복사본, `select(id)`, `deselect()`, `refresh()`, `destroy()`. `onChange`와 `CustomEvent("transitline:service-plan-capacity-readiness")`는 `refresh()`마다 한 번 나온다. 입력은 `refresh()`에서만 다시 읽는다(호스트가 변경 시 부른다).

### view `transitline.service-plan-capacity-readiness/1`

```
{ schema, contractVersion, basis: "map-fact",
  plans: [ { servicePlanId, name, active, operationalLineId, railGeometryId, railGeometryRevision,
             application: { state: "current"|"stale"|"none"|"line-not-stated"|"other-geometry"|"unknown", detailsAvailable, applicationId, applicationRailGeometryRevision, basis: "map-fact" },
             geometry: null | { railGeometryRevision, terminals|blocks|junctions: { state, count, ids } },
             sections: [ { order, sectionId, mapping: "mapped"|"not-in-application"|"application-unavailable", trackSegmentId, planTrackSegmentId, trackSegmentIdDiffers,
                           directionMode: { application, geometry }   // { state: "stated"|"unknown", value }
                           blockIds / junctionResourceIds: { application, geometry } }   // { state: "listed"|"declared-none"|"unknown", count, ids }
             turnbacks: { state: "not-stated"|"declared-none"|"listed", items: [ { key, stationId, terminalResourceId, turnbackCandidateId, terminalState, turnbackState, attached, candidateCount, attachedCandidateCount } ] },
             gaps: [ { checkId, field, kind: "capacity-map"|"service-plan", label, reason, message, sectionIds?, turnbackKey? } ],
             assumptions: { supplied, present?, basis: "player-stated-assumption", state, usable, statedFields, capacityTrainsPerHour, minimumHeadwayMinutes, compare: [ … ] },
             warnings, counts } ],
  counts: { plans, applicationCurrent, applicationStale, applicationNone, gaps } }
```

- **표시 사실** = 철도용량 **application**(E1이 읽는 것)의 값. 선택적으로 같은 계획의 `spatialFacts`(지도 원본)도 옆에 `geometry`로 둔다. 둘이 다르면 그대로 둘 다 보인다.
- `gaps[].checkId`는 사전심사(E1)의 track 항목 이름이다: `rail-capacity-application`, `direction-mode`, `block-data`, `junction-resource`, `terminal-resource`, `turnback-connection`, 그리고 E1 항목은 아니지만 계획 구간 매핑을 알리는 `section-not-in-application`. 테스트가 같은 application으로 E1을 실제로 돌려 **E1이 unknown으로 읽는 곳 = 이 view의 gap**임을 확인한다(예: `direction-mode`, `junction-resource`는 unknown, `block-data`와 종착·회차는 possible → gap 없음).
- `gaps[].kind`가 채울 곳을 가른다: `capacity-map`(철도 용량 지도에서 채움), `service-plan`(서비스 계획 편집에서 채움).

### 편집 요청 descriptor

`editorRequestOf(plan, gap)` →
`{ action: "open-capacity-editor" | "open-service-plan-editor", servicePlanId, operationalLineId, railGeometryId, field, checkId, sectionIds | null }`. 호스트(Codex)가 이를 받아 철도용량 mount(B13-M5)나 서비스 계획 편집(B16-M2)을 열고 해당 구간·항목을 가리키면 된다. 패널은 직접 열지 않는다.

## 상태 구분 (null / false / 0 / [])

| 사실 | 상태 | 패널 문구 |
|---|---|---|
| 단·복선 | `stated`(`single`/`double`) / `unknown` | `단선(명시)` · `복선(명시)` / `미상` |
| 폐색·분기기 | `null` → `unknown` | `미상` (**개수를 쓰지 않음**) |
| | `[]` → `declared-none` (`count: 0`) | `없음(선언됨)` (`0개`라고 쓰지 않음) |
| | 목록 → `listed` | `3개 (…id, …)` |
| 회차 목록 | 안 적음 / `[]` / 목록 | `회차를 적지 않았습니다 (미상)` / `회차 없음으로 선언했습니다` / 항목 |
| 회차선 접속 | `true` / `false` / `null` | `접속됨 (지도에서 측정)` / `접속되지 않음 (지도에서 측정)`(측정된 사실이라 gap이 아님) / `확인되지 않음 (미상)`(gap) |
| 적용 결과 | | `현재` / `낡음` / `없음` / `운영 노선 연결 안 됨` / `다른 철도 용량 지도의 결과` / `확인할 수 없음` |

## 계획 구간 ↔ application 매핑

계획 구간 `route.sections[].sectionId`를 application의 `sections[].railCapacitySectionId`와 맞춘다(E1이 노선의 `trackSegmentIds`로 읽는 것과 같은 application). `mapped` / `not-in-application`(→ gap `section-not-in-application`, 그 구간은 단·복선·폐색·분기기 gap에서 빼서 이중으로 세지 않음) / `application-unavailable`. 계획이 가진 트랙 번호와 application의 트랙 번호가 다르면 `trackSegmentIdDiffers`로 알린다.

## 합성 사례 (실제 B16 계획)

`scripts/lib/capacity-readiness-world.mjs`의 `buildReadinessWorld(case)`: B16 서비스 계획 세계(실제 지도 파이프라인)에 운영 노선을 얹고 **실제 `applyRailCapacityGeometry`**로 지도를 적용한 뒤, 실제 편집기·계약으로 계획을 만든다. 사례 `partial`(단선 일부·분기기 미상, 회차 하나는 설비 선택·접속, 하나는 미선택), `bare`(지도에 아무 사실도 없음), `stale`(적용 뒤 지도 개정이 바뀜), `no-application`(적용 결과 없음), `no-line`(운영 노선 미연결).

## 검증

- view 13 + 패널 10개: 실제 적용 결과의 사실 상태, 종착·회차 사실, 아무것도 적히지 않은 지도, 적용 결과 5상태, 구간 매핑 실패, `[]`/0/목록 구분, 종착 자료 없음·설비 없음·접속 안 됨·미확인, 플레이어 가정 분리, **E1과의 일치**, 같은 입력 = 같은 출력(입력 순서 무관), 얼린 입력 불변·출력 비공유, 이상한 입력, 편집 요청 descriptor, 판정·계산 키·import·시계·저장소 없음, 모든 사례의 패널 문구에 판정·비용·수요 낱말 없음, 콜백 없으면 버튼 없음, 엔진 상태 불변.
- **실제 headless Chrome**(진짜 마우스): `자세히`로 계획 열기 → 구간·회차 사실과 채울 곳 확인 → `철도 용량 편집 열기`·`서비스 계획 편집 열기` 클릭이 호스트 콜백에 descriptor 2건을 전달 → 계획이 낡은 지도 사례로 바뀌면 `낡음 1`과 gap 갱신 → 아무것도 적히지 않은 지도 사례(채울 입력 5건). 콘솔 오류 0.

## 한계

- 합성 계획·합성 지도로만 확인했고 실제 도쿄 계획은 확인하지 않았다.
- 같은 노선에 대한 application이 여러 개인 경우 같은 지도(`railGeometryId`)의 것을 우선 쓰고, 없으면 다른 지도의 것 하나를 `other-geometry`로 알린다(목록순 추측은 하지 않고 지도 ID 정렬).
- 분기기·종착의 **연결 세부**(`attachedToAllSections`, 누락 역할 등)는 표시하지 않는다(E1이 판단하는 영역). 이 패널은 "적혀 있는가"와 회차선 접속 사실까지만 본다.
- 채울 곳은 문구와 descriptor일 뿐, 어느 화면을 열지·어떤 구간을 가리킬지는 호스트가 정한다.
- 한 번에 계획 하나만 펼친다(목록은 계획마다 한 줄 요약).
