# B15-M3 — 수요 배분 정책 관리 패널 (`station-demand-allocation-management-ui.mjs`)

기준 커밋 `4a11e8b`. 대상: `main.mjs`에 연결할 작업자(Codex).
지도 M2(접근권 그리기)와 런타임 E4(배분 적용) 사이의 독립 패널이다. 플레이어가 **정책 작성 → 엔진 미리보기 → 적용**을 한다. 수요·비용·운임·혼잡·시간은 계산하지 않고, 유효성·낡음·보행·운행역 판정은 전부 엔진 결과를 그대로 보여 준다. `main.mjs`/`index.html`/`style.css`/`scenario-runtime.mjs`/`management/**`/`map/**`와 기존 E1~E4 파일은 수정하지 않았다.

## mount API

```js
import { mountStationDemandAllocationManagementPanel } from "./station-demand-allocation-management-ui.mjs";

const panel = mountStationDemandAllocationManagementPanel({
  container,     // 필수
  runtime,       // 필수 (아래 4개 메서드가 없으면 던진다)
  onChange,      // 정책 적용이 성공한 뒤에만, 한 번 호출
});
panel.refresh();             // 외부 상태(지도 접근권 적용, 불러오기, 틱)가 바뀌면 호출 — 패널은 폴링하지 않는다
panel.serialize();           // 정책 초안 → 문자열 (호스트가 통합 저장에 넣는다)
panel.loadDoc(textOrObject); // → { ok, issues }. 거부하면 현재 초안은 그대로
panel.document;              // 초안 복사본 (읽기 전용)
```

패널이 쓰는 `ScenarioRuntime` 메서드는 이 4개뿐이다.

| 메서드 | 종류 | 언제 |
|---|---|---|
| `stationDemandAccessReport()` | 읽기 | 마운트·`refresh`·편집마다. 접근권 사실(역, 노드, revision) |
| `stationDemandAllocationReport()` | 읽기 | 위와 같음. 적용된 배분(현재/오래됨, 링크 수) |
| `assessStationDemandAllocation({policy, walkingPolicy})` | 미리보기 (상태 불변) | **"미리보기" 버튼만** |
| `applyStationDemandAllocation({policy, walkingPolicy})` | **상태 변경** | **"정책 적용" 버튼만**, 직전 미리보기와 같은 입력으로 |

마운트와 입력 변경은 `assess`/`apply`를 부르지 않는다 (테스트: 호출 0회).

## host가 main.mjs에 연결할 코드

`index.html`에 컨테이너 하나를 추가한다 (예: `<div id="scenario-station-demand-allocation"></div>`, 기존 `scenario-station-demand-access-apply` 버튼 근처).

```js
import { mountStationDemandAllocationManagementPanel } from "./station-demand-allocation-management-ui.mjs";
let stationDemandAllocationManagement = null;
// ... runtime이 만들어진 뒤, 다른 관리 패널을 mount하는 곳에서:
stationDemandAllocationManagement = mountStationDemandAllocationManagementPanel({
  container: $("scenario-station-demand-allocation"),
  runtime,
  onChange: () => queueMicrotask(() => { refreshMapOverlay(); refreshScenarioPanel(); }),
});

// 1) 역 접근권 사실을 적용한 직후 (기존 "scenario-station-demand-access-apply" 핸들러 끝):
stationDemandAllocationManagement?.refresh();
// 2) 지도 pointerup 뒤 refresh 목록, 그리고 refreshScenarioPanel() 안에도:
stationDemandAllocationManagement?.refresh();

// 3) 통합 저장 — payload에 한 필드를 더한다:
//    stationDemandAllocationDraft: stationDemandAllocationManagement?.serialize() ?? null,
// 4) 통합 불러오기 — runtime.load(...) 뒤에:
//    if (wrapped && payload.stationDemandAllocationDraft) stationDemandAllocationManagement?.loadDoc(payload.stationDemandAllocationDraft);
//    stationDemandAllocationManagement?.refresh();   // 불러온 엔진 상태(적용된 배분)를 화면에 반영
```

적용된 배분(정책·링크·상태)은 이미 `runtime.save()`에 들어 있다 (E4: `stationDemandAllocationApplication`, `stationDemandAllocationLinks`). **패널이 따로 저장하는 것은 정책 초안뿐**이고 `localStorage`/`sessionStorage`는 쓰지 않는다 (테스트).
스타일은 포함하지 않았다. 클래스: `alloc-notice`, `alloc-empty`, `alloc-check`, `alloc-section`, `alloc-station`, `alloc-node`, `alloc-coverage`, `alloc-note`, `alloc-field`, `alloc-share`, `alloc-binding current|unbound|outdated|missing`, `alloc-actions`, `alloc-result`, `alloc-error`, `alloc-issue`, `alloc-rule-status <status>`, `alloc-group-title <group>`, `alloc-line <group>`, `alloc-metrics`/`alloc-metric`, `alloc-applied <status>`, `alloc-warning`, `alloc-walk-link`, `alloc-apply-blocked`. DOM은 `textContent`만 쓴다 (HTML 삽입 없음).

## serialize 저장 필드

`panel.serialize()`는 키·규칙 순서와 무관한 같은 텍스트를 낸다.

```jsonc
{ "schema": "transitline.station-demand-allocation-draft/1", "version": 1,
  "policyId": "policy:player",
  "areaNodeInclusion": "reject",                 // "reject" | "centroid"
  "walking": { "walkEstimate": "none", "acknowledgedWalkLinkIds": [] },   // "none" | "straight-line"
  "rules": [
    { "ruleId": "exclusive:<stationAccessId>", "kind": "station-exclusive", "stationAccessId": "…", "boundTo": null | { "<stationAccessId>": "<revision>" } },
    { "ruleId": "node:<demandNodeId>", "kind": "node-assign", "demandNodeId": "…", "stationAccessId": null | "…", "boundTo": … },
    { "ruleId": "node:<demandNodeId>", "kind": "node-shares", "demandNodeId": "…", "shares": { "<stationAccessId>": "60" }, "boundTo": … }
  ] }
```

- `shares`는 **플레이어가 친 퍼센트 문자열 그대로** 저장한다(빈 칸은 `""`). 엔진에는 `Number(text) / 100`으로 넘어가고, 숫자가 아니면 NaN이 그대로 가서 엔진이 거절한다.
- `boundTo`가 `null`이면 "묶이지 않음"이다. 저장본에 옛 revision이 있으면 그대로 두고 "오래됨"으로 표시한다 — 불러올 때 현재 revision으로 **다시 묶지 않는다**.
- 미리보기·적용 결과·오류는 저장하지 않는다 (엔진이 진실).
- `loadDoc`은 문서 전체를 검증한다. 하나라도 틀리면 거부한다: `draft-unreadable`, `draft-schema-invalid`, `draft-policy-id-invalid`, `draft-area-inclusion-invalid`, `draft-walking-invalid`, `draft-rule-invalid:<id>`, `draft-rule-id-duplicate:<id>`. 현재 초안과 화면은 건드리지 않고 엔진도 부르지 않는다. 성공하면 미리보기가 폐기된다.

## 정책 UX 흐름

1. **접근권 사실 확인.** 엔진에 접근권 적용이 없으면 이유(`역 접근권 사실이 아직 엔진에 없습니다 … '역 접근권 적용'을 먼저 누르세요`)만 나오고 버튼은 없다. 적용은 있는데 역이 없으면 그렇게 안내한다.
2. **단독 접근권(역마다).** `보류` / `단독 노드 100% 배정`. 100%를 고르면 `exclusive:<역>` 규칙(그 역 하나가 주장하는 노드에 대한 역 집합 규칙)이 생긴다. 단독 노드가 없는 역은 선택할 수 없다. 미상 노드 수와 미상 사유가 역 아래에 보인다.
3. **겹친 수요 노드.** 여러 역이 주장하는 노드마다 `규칙 없음(미배정)` / `한 역에 100%`(역을 직접 고른다 — 기본 선택 없음) / `역별 명시 비율`(역마다 % 입력). 값(거주·종사)은 엔진 평가 그대로 보인다(`0`은 0, 모르면 `미상`). **미상 노드는 목록에만 나오고 규칙을 줄 수 없다.**
4. **bind.** 규칙은 묶이지 않은 채 만들어진다. `현재 revision에 묶기`(규칙별) 또는 `모든 규칙을 현재 revision에 묶기`를 눌러야 `boundTo`가 현재 접근권 revision(노드 규칙은 그 노드를 주장하는 모든 역 포함)으로 채워진다. 접근권이 바뀌면 `오래됨 — 다시 묶어야 함`이 되고 자동으로 다시 묶이지 않는다.
5. **보행 정책.** `그린 보행선이 없을 때`: `추정하지 않음`(기본) / `직선거리 × 1.3 추정 허용`. 장벽 링크 확인: 미리보기 결과의 보행 링크 중 **확인하면 풀리는 것**(강·철도·건물 가로지름, 레이어 미측정)만 체크박스로 나오고, 체크하면 `acknowledgedWalkLinkIds`에 들어간다. 길이 미상·끊김·물 위 끝점은 확인으로 못 풀기 때문에 나오지 않는다. 면적형 수요 자료(격자·필지·블록) 중심점 가정도 체크박스로 명시한다(기본 꺼짐).
6. **미리보기** (엔진 호출, 상태 불변). 구분해서 보인다: 배정(역·비율·미배정 몫) · 미배정(보류, 사유) · 미상(배분 불가, 사유) · 보행 차단·미확인(엔진의 보행 판정과 사유) · 운행역 미연결(`station-not-operational`/`station-operational-ambiguous`) · 오래된 규칙 · 적용하면 생기는 링크(엔진이 계산한 도보 분). 정책 이슈와 규칙별 상태(`적용됨/해당 노드 없음/오래됨/거절됨`), 기존 접근 링크를 대체하는 노드도 엔진 값 그대로 보인다.
7. **적용.** `정책 적용`은 미리보기가 있고, 정책이 유효하고, 상태가 `current`일 때만 켜진다. 꺼진 이유는 버튼 옆에 적힌다. 눌러도 `runtime.applyStationDemandAllocation`만 호출하며 입력은 **직전 미리보기와 같은 복사본**이다. 성공하면 `onChange()`를 한 번 부른다. 엔진 오류는 문구 그대로 보이고 미리보기는 남는다(`onChange` 없음).
8. **적용된 배분.** 항상 읽기 전용으로: 상태(현재/오래됨), 정책 ID, **엔진이 만든 링크 수**와 링크 목록(노드 → 운행역, 도보 분), 막힌 링크 수, 적용 시각(`0분`은 0, 값이 없으면 `미상`). 지도 접근권이 바뀌면 `오래됨 — 기존 링크는 그대로이고 다시 적용해야 갱신됨`과 사유가 나온다.

정책 초안(규칙·보행 정책·가정)이 바뀌면 **미리보기가 즉시 폐기**되고 `정책 적용`이 꺼진다 (선택·체크·입력·bind·불러오기 모두). 미리보기를 만든 뒤 접근권 적용이 바뀌어도 폐기된다.

## 분수 배정(fixed-shares)

E5부터 비율이 1이 아닌 배정도 적용할 수 있습니다. 라우터는 노드·역할(출발/도착)별 결정론적 분할 일정을 저장해 각 역의 누적 선택 횟수가 입력 비율에서 1건 이내가 되게 합니다. 남는 비율이나 막힌 역의 비율은 기존 접근 경로로 되돌아가지 않고 경로 없음으로 남습니다. 패널은 비율을 직접 계산하거나 보정하지 않고, 엔진 미리보기와 적용 결과만 표시합니다.

## 테스트 — 23개 (`engine/test/station-demand-allocation-management-ui.test.mjs`)

- 가짜 DOM + 스파이 runtime 20개: 마운트 시 `assess/apply` 0회·동결 입력 불변, 접근권 사실 없음 안내, 단독 접근권·겹친 노드 편집, 규칙은 묶이지 않은 채 생성·명시 bind, 엔진 정책 payload 정확성, 비율 입력(÷100, 빈 칸=없음, 비숫자=NaN 통과), 엔진 이슈 표시, 보행 정책·장벽 링크 확인, **편집 시 미리보기 폐기**, 적용은 직전 미리보기와 같은 입력으로만·`onChange` 1회, 분수 배정 적용, 낡음·미준비 정책 적용 불가와 이유, 엔진 오류 그대로·`onChange` 없음, 적용 결과 읽기·낡음 표시·옛 미리보기 폐기·**`0`과 `미상` 구분**, 오래된 규칙 표시(자동 재결합 없음), 초안 저장·복원·거부·복사본, 초안 검증 코드, 저장소 미사용·금지 출력·소스 import/runtime 메서드 4개 검사, 마운트 거부.
- **실제 `ScenarioRuntime` 3개**: 접근권 없음 → 적용 → 정책 작성·bind·미리보기·**적용으로 엔진이 링크 2개 생성**·패널이 그 링크를 읽어 표시 → 지도 export 변경으로 `오래됨`(링크는 그대로) → 규칙 오래됨 → 다시 bind 후 적용 가능, 미리보기·편집 중 엔진 상태 스냅샷 불변; 분수 60/40은 미리보기와 적용이 가능하고 두 링크의 비율이 보존됨, 80/80은 엔진이 거절한 이유 표시; 저장한 초안을 새 패널에 복원해 같은 정책을 미리보기.
- headless Chrome(스텁 runtime): select 값이 재그리기 뒤에도 유지, 퍼센트 입력 중 입력칸·포커스 유지, 분수 미리보기 뒤 적용, 저장소 키 0개.

## 한계

- 분수 배정에서 경로가 없는 몫은 다른 역이나 레거시 접근으로 자동 전환되지 않는다. 따라서 일부 비율이 미배정이거나 출발·도착에 같은 역이 선택되면, 이후 승객의 난수 흐름은 100% 배정 실행과 달라질 수 있다(E5의 의도된 한계).
- 패널이 쓰는 규칙은 **단독 접근권(역 하나짜리 역 집합 규칙)** 과 **노드 규칙** 두 가지다. 엔진이 받는 "여러 역이 겹치는 같은 집합" 규칙(그 집합을 주장하는 모든 노드에 한 번에 적용)은 UI에 없고, 겹친 노드마다 규칙을 줘야 한다.
- 겹친 노드 목록은 엔진 평가(E1)에서 **둘 이상의 역이 주장하는 노드를 센** 것이다(P1이 직접 세는 것과 같은 정의). 최종 단독/공유/미상 판정은 미리보기의 엔진 결과가 기준이다.
- 보행 확인은 보행 **링크** 단위(`acknowledgedWalkLinkIds`)만 한다. 환승 통로 확인, 미측정 레이어 일괄 수용 옵션은 UI에 없다 (엔진은 지원).
- 장벽 확인 목록은 **미리보기를 한 번 실행해야** 나온다 (보행 사실은 엔진 미리보기가 계산한다). 접근권이 바뀌면 목록이 비워진다.
- 정책 ID는 `policy:player` 고정이다 (초안 문서에는 `policyId`가 있으나 UI에서 바꾸는 입력은 없다).
- 도쿄 팩은 수요 자료가 시구 중심점(저품질)이라 지금은 모든 노드가 미상이고 이 패널에서 배정할 수 있는 노드가 없다. 의도된 결과다.
- 게임 화면 안의 배치·스타일은 `main.mjs`/`index.html`/`style.css` 연결 뒤에 확인해야 한다.
