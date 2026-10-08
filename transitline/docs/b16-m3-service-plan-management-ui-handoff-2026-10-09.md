# B16-M3 서비스 계획 관리 패널 — Codex 인수 문서

`engine/src/service-plan-management-ui.mjs` (+ `engine/test/service-plan-management-ui.test.mjs`, 28개). `main.mjs`·`index.html`·`style.css`·`management/**`·`scenario-runtime.mjs`·`map/**`는 수정하지 않았다.

## 하는 일

1. 지도 서비스 계획(`transitline.service-plan-geometry/1`, B16-M1) 목록을 `servicePlanId` 순으로 보여 준다.
2. 계획마다 **개통된 서비스**를 플레이어가 직접 고르게 한다. 고르기 전에는 연결이 비어 있다.
3. 두 ID가 **다른 종류**임을 항상 표시한다: `지도 계획 ID (설계 문서)` ↔ `개통 서비스 ID (경영 서비스)` + 안내문.
4. B16-E1 `prescreenServicePlan` 결과를 계획/운행선/기술사양/차량/선로·종착 다섯 영역으로 보여 준다. 막힘 없음 이외의 항목은 `checkId`·사유와 함께 나열한다.
5. B16-C1 `adaptServicePlanToOperationalTimetable` 결과(`ready / unknown / blocked / unsupported`)와 모든 `issues[]`를 한국어 설명 + 엔진 코드로 보여 준다.
6. **"시간표 심사 준비 완료"는 C1이 `ready`이고, 그 서비스에 연결된 계획이 이것 하나뿐일 때만** 표시한다.

하지 않는 일: `assessOperationalRailwayTimetable` / `approveRailwayTimetable` / `activateRailwayTimetable` 호출(테스트가 호출 시 실패하도록 가로채 확인하고, 소스에 호출 표현이 없음을 검사한다), 수요·운임·비용·혼잡·시간표·용량 계산, localStorage 사용, 입력·엔진·지도 계약 변경.

## 두 ID

| | 뜻 | 만드는 곳 |
|---|---|---|
| `servicePlanId` | 플레이어가 지도에서 만든 **설계 문서**의 식별자 | B16-M1 |
| `serviceId` | 경영에서 **개통되어 운행 중인 서비스**의 식별자 (`runtime.report().services[].id`, 직통은 `throughServices[].throughServiceId`) | 경영 엔진 |

패널은 이름·번호·순서·같은 문자열로 둘을 잇지 않는다(계획 ID와 같은 서비스 ID가 있어도 연결은 비어 있다 — 테스트로 고정). 연결은 플레이어의 선택(`select`)만이 만든다.

## Mount API

```js
import { mountServicePlanManagementPanel } from "./service-plan-management-ui.mjs";

const panel = mountServicePlanManagementPanel({
  container,                       // 필수. DOM 요소(ownerDocument를 쓴다)
  runtime,                         // 필수. ScenarioRuntime (아래 getter)
  getServicePlans: () => plans,    // 필수. B16-M1 export의 plans[] (ServicePlanGeometry 배열)
  getPrescreenContext: () => ({ technicalSpecs, vehicleOrders, operatingResourcePools }),  // 선택
  onChange: () => {},              // 선택. 플레이어가 연결을 바꾼 뒤에만 호출
});
panel.refresh();      // 엔진·지도를 다시 읽어 그린다
panel.serialize();    // 연결 문서(JSON 문자열). 저장은 호스트가 한다
panel.loadDoc(text);  // -> { ok, issues }. 거절되면 현재 연결은 그대로, 엔진 호출 없음, onChange 없음
panel.document;       // 연결 문서의 복사본
panel.results();      // 화면의 행(계획별 readiness, C1 결과 전체)의 복사본
panel.readyPlans();   // [{ servicePlanId, serviceId, operationalRequest }] — "준비 완료"인 것만, 복사본
```

잘못된 인자는 마운트 시 던진다: `container` 없음, `getServicePlans`가 함수가 아님, `runtime`에 `report()`/`operationalState`가 없음.

### 필요한 runtime getter (모두 읽기 전용)

| 읽는 것 | 출처 | 비고 |
|---|---|---|
| 실제 운행선·선로·철도 용량 application | `runtime.operationalState` | `lines`, `trackSegments`, `railCapacityApplications`, `throughServiceBindings` |
| 개통 서비스 | `runtime.report().services` | 선택지와 C1 입력 |
| 직통 서비스 | `runtime.report().throughServices` | 선택은 되지만 C1이 `unsupported` |
| 운영 자원 풀 | `runtime.report().operatingResourcePools` | E1의 차량 배정 판정 |
| 차량 발주 | `runtime.game.vehicleOrders` (**없으면 `getPrescreenContext().vehicleOrders`**) | `report()`에는 없다. 없으면 `undefined` → 차량 `unknown` |
| 노선별 기술사양 | **`getPrescreenContext().technicalSpecs[lineId]`** | `{ technicalSpecification?, technicalProfileId?, notApplicable?, capacityTrainsPerHour? }`. 없으면 기술사양·용량 `unknown`. 지도 `ExternalInfrastructureCatalog` 항목 또는 자체 노선 프로필에서 만든다 |

`getPrescreenContext()`가 돌려준 키가 기본값을 덮어쓴다. **빠진 값은 `undefined`로 두어야 한다.** `[]`나 `{}`로 채우면 "없음"이라는 사실로 읽힌다(E1 규칙: `undefined`=미상, `[]`=없음).

## refresh 시점

패널은 스스로 갱신하지 않는다(타이머·폴링 없음). 호스트가 다음 때 `refresh()`를 부른다.

- 패널을 열 때
- 지도 서비스 계획 export를 다시 만든 뒤 (지도 편집, 철도 용량 지도 변경)
- 철도 용량 application을 적용·갱신한 뒤
- 서비스를 개통하거나 바꾼 뒤, 직통 서비스 연결을 바꾼 뒤
- 차량 발주·인수·배정이 바뀐 뒤
- 노선 기술사양 카탈로그를 바꾼 뒤
- 불러오기(`loadDoc`)는 스스로 다시 그린다

매 틱마다 부르지 않는다. `refresh()`는 `runtime.report()`(구조 복제)를 한 번 부르고 계획마다 C1·E1을 실행한다.

## 저장 시 보존할 binding 문서

```json
{
  "schema": "transitline.service-plan-binding-doc/1",
  "version": 1,
  "bindings": [
    { "servicePlanId": "map-plan:1", "serviceId": "service:3", "servicePlanRevision": "rev:abc" }
  ]
}
```

- `panel.serialize()`가 만들고 `panel.loadDoc()`이 읽는다. 항목은 `servicePlanId` 순으로 정렬되고, 같은 문서는 같은 바이트로 직렬화된다.
- `servicePlanRevision`은 **연결한 시점**의 계획 개정이다. 지도 계획이 그 뒤 바뀌면 패널은 "연결한 뒤 지도 계획이 바뀜" 경고만 띄우고 연결은 유지한다(저장된 개정은 자동으로 바꾸지 않는다).
- **지도에 없는 계획의 연결도 문서에 그대로 남긴다**(지도가 잠시 비어 있어도 연결을 잃지 않는다). 목록에서 "연결 지우기"로 지우면 문서에서도 빠진다.
- 같은 `servicePlanId`가 두 번 있거나 항목이 올바르지 않으면 문서 전체를 거절한다(일부만 불러오지 않는다): `binding-doc-unreadable`, `binding-doc-schema-invalid`, `binding-doc-bindings-invalid`, `binding-invalid:<id>`, `binding-revision-invalid:<id>`, `binding-duplicate-plan:<id>`.
- 한 서비스에 계획 둘을 연결해 둘 수는 있지만(문서는 허용) 패널이 둘 다 "연결 중복"으로 막는다.
- 이 문서는 통합 저장(`integrated-save`)에 아직 들어 있지 않다. 호스트가 별도 슬롯으로 저장하거나, 통합 저장에 한 칸을 추가해야 한다.

## E2 통합 (Codex) 사용 방법

```js
for (const { servicePlanId, serviceId, operationalRequest } of panel.readyPlans()) {
  const assessed = runtime.assessOperationalRailwayTimetable(operationalRequest);   // B13 심사: 호스트가 부른다
  // 이후 승인·활성화도 플레이어의 별도 선택으로
}
```

`operationalRequest`는 C1이 만든 값 그대로의 복사본이다. 패널은 이것을 만들거나 고치지 않는다.

## 화면에 보이는 상태

| 표시 | 뜻 |
|---|---|
| 시간표 심사 준비 완료 | C1 `ready` + 다른 계획과 서비스 중복 없음 |
| 서비스 연결 필요 | 아직 연결하지 않음 (C1 사유도 함께 표시) |
| 같은 서비스에 여러 계획이 연결됨 | 패널의 추가 차단. C1이 ready여도 넘기지 않는다 |
| 미상 — 심사 준비 안 됨 | C1 `unknown` (예: 편도, 종착 자원 미선택, 사전심사 미상) |
| 차단 | C1 `blocked` (stale 지도·용량 application, 비활성 계획, 실제 운행선/구간 불일치, E1 `impossible`) |
| 지원하지 않는 계획 | C1 `unsupported` (단축·부분 구간 운행, 복수 시간대, 직통 서비스) |

사전심사 영역별 표시: `막힘 없음 (possible)` / `조건부 (conditional)` / `불가 (impossible)` / `미상 (unknown)`. 미상은 막힘 없음으로 바뀌지 않는다. E1이 `conditional`인데 C1이 `ready`이면(예: 차량 인도 대기) C1의 판단대로 "준비 완료"이고 조건은 사전심사 항목에 그대로 나온다.

## 검증

- `node --test engine/test/service-plan-management-ui.test.mjs` — 28개: 읽기 전용(동결 입력), 금지된 B13 호출 가로채기, 두 ID 표시, 이름/ID로 자동 연결 안 함, 연결·해제·중복·고아 연결, E1 다섯 영역과 미상 유지, C1 사유(stale, 운행선 불일치, 구간 불일치, 단축·부분, 편도, 복수 시간대, 종착 누락, 직통, 없는 서비스), 문서 왕복·거절, refresh, 복사본 반환, 소스 검사(localStorage·시계·난수·금지 호출), 실제 `ScenarioRuntime` 읽기.
- 변이 확인: 중복 연결 검사 삭제, 미상을 막힘 없음으로 표시, 준비 안 된 계획까지 `readyPlans`에 포함 — 각각 해당 테스트가 실패하는 것을 확인하고 되돌렸다.
- headless Chrome: 같은 모듈을 브라우저에서 불러 실제 DOM에 마운트해 연결 → 준비 완료 → 중복 차단 → 해제 → 저장 → 불러오기 → 잘못된 문서 거절을 확인했다. 콘솔 오류 0, `localStorage`/`sessionStorage` 접근 0, 금지된 B13 호출 0.

## 한계

- 스타일이 없다(`style.css` 금지). 클래스 이름은 `svcplan-*`이며 호스트가 입힌다.
- 한 서비스에 한 계획만 "준비 완료"가 된다. 시간대별 여러 계획을 한 서비스에 묶는 것은 B13 입력이 한 시간대만 받는 현재 구조에서는 지원하지 않는다(C1 한계).
- 직통 서비스는 선택은 되지만 C1이 지원하지 않는다.
- `runtime.game.vehicleOrders`는 공개 getter가 아니라 내부 필드를 읽는 것이다. 호스트가 `getPrescreenContext().vehicleOrders`를 주면 그것이 우선한다. 공개 getter가 생기면 그쪽으로 바꾸는 것이 좋다.
- 노선 기술사양(`technicalSpecs`)을 만드는 공개 경로가 아직 없다. 주지 않으면 기술사양·용량은 항상 미상이라 계획이 "준비 완료"가 되지 못한다(의도된 안전 측 동작).
- 연결 문서는 통합 저장에 포함되지 않았다.
