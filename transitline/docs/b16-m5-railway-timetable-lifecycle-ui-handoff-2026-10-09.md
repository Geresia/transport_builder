# B16-M5 시간표 심사·승인·개통 패널 — Codex 인수 문서

`engine/src/railway-timetable-lifecycle-ui.mjs` (+ `engine/test/railway-timetable-lifecycle-ui.test.mjs`, 26개). 기존 파일은 `service-plan-management-ui.mjs`에 `export` 한 단어(`issueText`)만 더했다. `main.mjs`·`index.html`·`style.css`·`management/**`·`scenario-runtime.mjs`·`map/**`는 수정하지 않았다.

## 하는 일

B13 시간표 엔진을 다시 만들지 않고, 서비스 계획 하나의 **심사 → 승인 → 개통**을 플레이어가 한 단계씩 누르게 한다.

| 버튼 | 부르는 runtime 메서드 | 누를 수 있는 때 |
|---|---|---|
| 시간표 심사 | `runtime.assessServicePlanTimetable(plan, binding, input)` | 서비스에 연결됨, 전제 입력을 읽을 수 있음, 아직 같은 전제로 심사한 기록이 없음(또는 낡음/대체됨) |
| 승인 | `runtime.approveRailwayTimetable(timetableId)` | 심사 기록이 낡지 않았고 엔진 상태가 `assessed` |
| 개통 | `runtime.activateRailwayTimetable(timetableId)` | 심사 기록이 낡지 않았고 엔진 상태가 `approved` |

- **엔진 명령은 클릭 핸들러 한 곳에서만 부른다.** `mount`·`refresh`·`loadDoc`은 `runtime.railwayTimetableReport()`(읽기)만 부른다(테스트가 명령 호출 0회, 상태 불변을 확인).
- 클릭마다 **그 시점의 전제를 다시 계산**하고, 낡았거나 순서가 아니면 엔진을 부르지 않는다(버튼이 비활성인데 눌려도 마찬가지).
- 엔진 호출 중에 들어온 같은 클릭은 무시한다(재진입 방어). 더블클릭은 한 번만 실행된다.
- 단계를 건너뛰지 않고, 자동으로 이어 실행하지 않는다(심사가 끝나도 승인은 별도 클릭).

## 엔진이 하는 일과 패널이 하는 일

화면의 판정·수용/거절 경로·위반·부족한 입력·오류는 전부 엔진이 준 값을 그대로 보여 준다.

- 엔진 상태(`assessed / approved / active / superseded`), 판정(`possible / conditional / impossible / unknown`), 요청·수용·거절 경로 수, 수용률, 요구 수용률
- `assessment.missingInputs`(부족한 입력), `assessment.violations`(위반)
- 수용된 경로(경로 ID, 서비스, 방향, 출발→도착)와 **거절된 경로**(경로 ID, 사유, 상세, 구간, 충돌 경로) — 각각 처음 20개까지, 나머지는 개수만
- 심사를 눌렀을 때의 C1 변환 결과(상태, 사유)와 E1 사전심사 요약. 시간표가 만들어지지 않으면 이 사유만 보인다
- 엔진/패널 오류는 문구 그대로 표시한다(`Railway timetable assessment is conditional`, `Timetable service … is not available for operation` 등)

패널은 최소 시격·용량·운행 가능 여부를 계산하지 않는다. 승인 버튼도 판정이 `possible`인지 미리 보지 않는다 — 엔진이 거절하면 그 오류가 보이고 상태는 그대로다. (테스트: headway 1분 계획은 엔진이 `possible`이 아니라고 판정하고, 승인은 엔진이 거절해 아무것도 바뀌지 않음.)

## Mount API

```js
import { mountRailwayTimetableLifecyclePanel } from "./railway-timetable-lifecycle-ui.mjs";

const panel = mountRailwayTimetableLifecyclePanel({
  container,                         // 필수. DOM 요소(ownerDocument를 쓴다)
  runtime,                           // 필수. ScenarioRuntime
  getServicePlans: () => plans,      // 필수. B16-M2 export의 plans[] (또는 { plans })
  getBindings: () => bindings,       // 필수. B16-M3 panel.document ({ bindings }) 또는 bindings[]
  getAssessmentInput: (plan, binding) => input,   // 필수. 아래 참조
  onChange: () => {},                // 선택. 엔진 상태나 심사 기록이 바뀐 뒤에만
});
panel.refresh();       // 지도·연결·전제·엔진 기록을 다시 읽어 그린다 (엔진 명령 없음)
panel.serialize();     // 심사 기록 문서(JSON 문자열)
panel.loadDoc(text);   // -> { ok, issues }. 거절되면 현재 기록 그대로, 엔진 호출 없음, onChange 없음
panel.document;        // 문서 복사본
panel.results();       // 계획별 { servicePlanId, serviceId, timetableId, stale, staleReasons, engineStatus, verdict, acceptedPaths, rejectedPaths, canAssess, canApprove, canActivate, error } 복사본
```

마운트 시 던지는 오류: `container` 없음, 세 getter 중 하나가 함수가 아님, runtime에 `assessServicePlanTimetable / approveRailwayTimetable / activateRailwayTimetable / railwayTimetableReport` 중 하나가 없음.

### `getAssessmentInput(plan, binding)` — 전제 입력

M4(전제 입력)의 구조를 패널이 가정하지 않는다.

- 반환값을 **그대로** `runtime.assessServicePlanTimetable`의 세 번째 인자(`input`)로 넘긴다(복사본으로). 패널은 키를 읽거나 보태거나 바꾸지 않는다. E2의 `input`이 받는 키(`technicalSpecs`, `vehicleOrders`, `operatingResourcePools`, `dayType`, `closureWindowsBySectionId`, `infrastructureAssumptions`, `minimumAcceptanceRatio`)를 호스트가 채운다.
- 인자는 `(plan 복사본, { servicePlanId, serviceId })`. 호출 시점은 `refresh`(낡음 판정용 지문 계산)와 심사 클릭이다. 호스트 콜백이므로 엔진 명령이 아니다.
- 객체여야 한다(`{}` 가능). 던지거나 객체가 아니면 그 계획은 심사할 수 없고, 이미 심사한 기록은 "전제 입력을 읽을 수 없음"으로 낡음 처리한다.
- **전제가 바뀌었는지는 이 반환값의 지문으로 안다.** 같은 상태에서 같은 값을 돌려줘야 한다(키 순서는 무관). 돌려주는 값에 시계·난수가 섞이면 매번 낡음이 된다.

## 낡음(stale)

패널은 심사 클릭 때 세 가지의 지문을 기록 문서에 남긴다: 서비스 계획 전체(`planDigest`), 연결한 서비스 ID, 전제 입력(`inputDigest`). 이후 하나라도 달라지면 그 심사는 **낡음**이다.

| 사유 | 뜻 |
|---|---|
| `plan-changed` | 서비스 계획 내용이 바뀜 — 지도 revision 상태, 용량 application 상태, 배차·시간대·구간 모두 포함 |
| `plan-missing` | 지도에서 계획이 사라짐(기록은 "지도에 없는 계획의 심사 기록"으로 남음) |
| `binding-changed` / `binding-missing` | 연결한 개통 서비스가 바뀌었거나 연결이 해제됨 |
| `input-changed` / `input-unavailable` | 전제 입력이 바뀌었거나 읽을 수 없음 |
| `timetable-missing` | 엔진에 그 시간표가 없음(다른 저장본을 불러왔거나 삭제됨) |
| `timetable-mismatch` | 같은 ID의 시간표가 엔진에 있지만 다른 서비스 것이거나 다른 시각에 만들어짐(저장본이 달라 ID가 재사용된 경우) |

낡은 심사는 **이전 결과(경로·판정)를 화면에서 숨기고**, 승인·개통을 막고(버튼 비활성 + 클릭이 와도 엔진 호출 안 함), 다시 심사하게 한다. 다시 심사하면 기록이 새 시간표로 바뀐다. 이전 클릭의 오류·알림도 전제가 바뀌면 지운다.

**낡음으로 잡지 못하는 것:** 서비스 계획·연결·입력에 나타나지 않는 운행선·선로의 변경(예: 실제 선로 편집). 이런 변경은 엔진이 개통 때 `Timetable infrastructure revision … is stale`로 거절하고 롤백하며, 패널은 그 오류를 그대로 보여 준다.

## 저장 문서

```json
{
  "schema": "transitline.railway-timetable-lifecycle-doc/1",
  "version": 1,
  "entries": [
    { "servicePlanId": "map-plan:1", "serviceId": "service:3", "timetableId": "railway-timetable:2",
      "createdAtMinute": 0, "planDigest": "…", "inputDigest": "…" }
  ]
}
```

- 호스트가 `panel.serialize()`를 통합 저장(예: M3의 `servicePlanBindingDoc` 옆)에 넣고, 불러올 때 **엔진을 먼저 복원한 뒤** `panel.loadDoc()`을 부른다. 순서가 반대여도 `refresh`가 `timetable-missing`으로 보여 줄 뿐 오류는 아니다.
- 엔진 시간표 자체는 통합 저장(runtime)에 들어 있다. 이 문서는 "어느 계획이 어느 시간표를 어떤 전제로 심사했는가"만 담는다.
- 지도에 없는 계획의 기록도 문서에 남는다("기록 지우기"로 지움). 같은 `servicePlanId`가 둘이거나 필드가 틀리면 문서 전체를 거절한다: `lifecycle-doc-unreadable`, `lifecycle-doc-schema-invalid`, `lifecycle-doc-entries-invalid`, `entry-invalid:<id>`, `entry-duplicate-plan:<id>`.
- 저장은 호스트 몫이다. 패널은 localStorage를 쓰지 않는다.

## refresh 시점

스스로 갱신하지 않는다(타이머 없음). 호스트가 다음에 `refresh()`를 부른다.

- 패널을 열 때
- M2 지도 계획 export를 다시 만들었을 때, M3 연결을 바꿨을 때(M3 `onChange` 뒤)
- 전제 입력의 원천이 바뀐 뒤(기술사양, 차량 발주·배정, 가정, 폐쇄 시간창)
- 엔진 상태를 직접 바꾼 뒤(저장본 불러오기, 시간표를 다른 경로로 승인·개통)
- 이 패널의 클릭은 스스로 다시 그린다. `onChange`는 클릭으로 기록/엔진이 바뀐 뒤 호출되므로 다른 패널을 `refresh()`할 때 쓴다

## 화면

카드마다 계획 ID / 서비스 ID(M3와 같이 다른 종류로 표시), 3단계 표시(심사·승인·개통, 끝난 단계는 ✓), 3개 버튼, 엔진 상태·판정·경로 목록, 낡음 안내, 마지막 클릭의 알림/오류/C1 결과. 클래스는 `ttlife-*`이며 스타일은 호스트가 입힌다.

## 연결 예 (main.mjs)

```js
timetableLifecycle = mountRailwayTimetableLifecyclePanel({
  container: $("scenario-timetable-lifecycle"),
  runtime,
  getServicePlans: () => servicePlanEditor?.output().export?.plans ?? [],
  getBindings: () => servicePlanManagement?.document ?? { bindings: [] },
  getAssessmentInput: (plan, binding) => ({ ...servicePlanPrescreenContext(), /* + dayType 등 M4 전제 */ }),
  onChange: () => queueMicrotask(() => refreshScenarioPanel()),
});
// 저장: timetableLifecycleDoc: timetableLifecycle.serialize()
// 복원: runtime.load(...) 다음에 timetableLifecycle.loadDoc(payload.timetableLifecycleDoc)
```

기존 `scenario-service-plan-assess` 버튼(여러 계획 일괄 심사)과 이 패널의 심사 버튼은 같은 `assessServicePlanTimetable`을 부른다. 둘 다 쓰면 같은 계획의 시간표가 중복으로 생길 수 있으니 한쪽으로 정하는 것이 좋다(일괄 심사가 만든 시간표는 이 패널의 심사 기록에 없어 "심사됨"으로 인식되지 않는다).

## 검증

- `node --test engine/test/railway-timetable-lifecycle-ui.test.mjs` — 26개, 모두 **실제 `ScenarioRuntime`**(호출 횟수를 세는 얇은 포장만 씌움). 심사→승인→개통과 엔진 상태·`activeTimetableId`, 엔진이 가능하지 않다고 판정한 심사의 거절 경로 표시와 승인 거절, C1이 시간표를 만들지 않는 경우, 엔진의 개통 거절(서비스가 열려 있지 않음)과 롤백, 단계 건너뛰기, 낡음(계획·지도 revision·용량 application·연결·입력·엔진 저장본 되돌리기·ID 재사용), 낡은 승인 후 개통 차단, 더블클릭·재진입, 엔진 오류, 입력 불가, 문서 왕복·거절, 동결 입력, 소스 검사(localStorage·시계·난수·B13 규칙 문자열 없음, 엔진 명령 호출 위치 2곳).
- 변이 확인: 낡음에서 승인 허용, 중복 클릭 방어 제거, 입력 변경 무시, 엔진 상태 확인 없이 개통 허용, 낡은 상세 계속 표시 — 각각 해당 테스트가 실패하는 것을 확인하고 되돌렸다. (중복 클릭 방어는 처음에 살아남아서, 엔진 호출 도중의 재진입을 시험하도록 테스트를 고쳤다.)
- headless Chrome: 실제 `ScenarioRuntime`을 브라우저에서 불러 마운트 직후 명령 0회 → 더블클릭 심사 1회 → 더블클릭 승인 1회 → 계획 변경 후 `plan-changed`로 개통 차단(엔진 호출 0회) → 재심사 → 승인 → 개통(`activeTimetableId` 설정) → 저장·불러오기·잘못된 문서 거절. 콘솔 오류 0, localStorage/sessionStorage 접근 0.

## 한계

- 낡음 판정은 계획·연결·전제 입력의 지문이다. 실제 선로 편집처럼 거기에 나타나지 않는 변경은 개통 때 엔진 오류로만 드러난다.
- 낡아져서 버려진 시간표(예: 승인까지 갔다가 다시 심사한 이전 것)는 엔진에 `approved` 상태로 남는다. 엔진에 시간표를 지우거나 되돌리는 명령이 없어 패널이 정리할 수 없다. 같은 날짜 유형의 활성 시간표가 개통 때 `superseded`가 되는 것은 엔진 규칙이다.
- 서비스 하나에 계획 하나(C1/M3와 같다). 계획마다 독립된 기록이지만, 같은 서비스에 연결된 두 계획을 둘 다 개통하면 엔진이 뒤의 것으로 대체한다.
- 전제 입력(`getAssessmentInput`)의 내용은 호스트 책임이다. 비어 있으면 C1/E1이 미상으로 막고 시간표가 만들어지지 않는다(사유가 보인다).
- 심사 후 `dayType` 등을 바꾸는 UI는 없다. 호스트가 `getAssessmentInput`으로 정한다.
- 스타일이 없다(`style.css` 금지).
