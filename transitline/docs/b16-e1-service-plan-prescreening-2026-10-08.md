# B16-E1 운행계획 기술·자원 사전심사

## 한 줄

운행계획 하나가 기대는 **사실**(열차 사양, 편성 수, 회차·분기·종착 자원, 단선/복선·폐색·용량 자료)이 있는지, 계획과 맞는지, 모르는지를 `possible / conditional / impossible / unknown`으로 알려 준다. 시간표 충돌을 판정하지 않는다. 그것은 B13 몫이다.

`engine/src/service-plan-prescreening.mjs` (순수 모듈). `ScenarioRuntime`·`main.mjs`·`management/**`는 건드리지 않았다.

## B16 감사 문서와의 관계

[b16-service-planning-integration-audit](b16-service-planning-integration-audit-2026-10-08.md)는 B13의 용량·충돌·시간표 판정을 다시 만들지 말라고 정했다. 이 모듈은 그 선을 지킨다.

| 이 모듈이 하는 것 | B13에 남기는 것 (`deferredToB13`) |
|---|---|
| 필요한 사실이 **있는가·없는가·모르는가** | `minimum-headway` 최소시격 |
| 열차 사양과 노선 사양이 **맞는가** | `hourly-capacity` 시간당 용량 |
| 차량이 **몇 편성 있는가·누가 쓰고 있는가** | `single-track-conflict` 단선 충돌 |
| 회차 자원·분기기가 **그려져 있는가·연결됐는가** | `junction-conflict` 분기기 충돌 |
| 단선/복선·폐색·용량 자료가 **명시돼 있는가** | `turnback-conflict` 회차 점유 충돌 |
| | `closure-window` 폐쇄 시간창 |

그래서 `possible`은 "검사한 사실에 막힘도 미상도 없다"는 뜻이지 시간표 승인이 아니다. 계획에 `trainsPerHour`, `headwayMinutes`를 넣어도 판정이 달라지지 않는다(테스트가 확인). 수요·운임·비용·혼잡·수익은 계산하지 않고 보고서에 필드도 없다.

## 입력

```js
prescreenServicePlan(plan, context)      // → 보고서
prescreenServicePlans(plans, context)    // → servicePlanId 순 보고서 목록 (입력 순서 무관)
```

### `plan` — B16-M1 연결 필드

M1이 아직 없으므로 아래는 **합성 계약**이다. B16 감사 문서의 `servicePlans[]` 표(`serviceId`, `terminalResourceId` 등)와 M1이 보존하기로 한 `servicePlanId`·revision에 맞췄다. M1이 필드명을 다르게 정하면 이 모듈은 건드리지 않고 M1 어댑터가 옮기면 된다.

| 필드 | 뜻 | 없을 때 |
|---|---|---|
| `servicePlanId` | M1 운행계획 ID | `plan-identity` unknown |
| `serviceId` | 개통된 관리 서비스. 운행선은 `line.managementServiceId`로 찾는다 | `operational-line` unknown |
| `vehicleModelId` | 선택한 열차(`VEHICLE_MODELS`의 키) | `vehicle-model` unknown |
| `requestedSets` | 필요한 편성 수(양의 정수) | `fleet-sets` unknown |
| `terminalResourceId` | 종점 회차 자원(B13 `terminalResourceId`와 같은 이름) | 종착·회차 unknown |
| `turnbackCandidateId`? | 고른 회차선 후보 | 후보 전체를 본다 |
| `junctionResourceIds`? | 계획이 직접 지목한 분기 자원 | 선로 구간의 분기만 본다 |
| `mapRevision.state` | `current` / `stale` (M1이 지도 revision 대조 결과를 줌) | `map-revision` unknown |

### `context` — 읽기 전용

`undefined`는 "주지 않았다"(→ unknown), `[]`는 "없다"는 뜻이다. 둘을 섞지 않는다.

| 필드 | 출처 | 비고 |
|---|---|---|
| `operationalState` | `runtime.operationalState` | `lines`, `stations`, `trackSegments`, `railCapacityApplications` |
| `technicalSpecs[lineId]` | 외부선 `ExternalInfrastructureCatalog` 항목 또는 자체 노선 프로필 | `{ technicalSpecification?, technicalProfileId?, notApplicable?, capacityTrainsPerHour? }` |
| `vehicleOrders` | `runtime.game.vehicleOrders` | 차량 보유(`units[].status`)와 발주 중 수량 |
| `operatingResourcePools` | `runtime.report().operatingResourcePools` | 다른 서비스에 배정된 편성(`assignments[].primaryUnitIds`) |

기술 비교는 새로 만들지 않고 B12-2의 `assessTechnicalCompatibility()`를 그대로 쓴다(12개 항목: 주행방식·궤간·집전·차폭·축중·곡선·구배·신호·승강장 높이·문 배치·편성 수·정비체계).

## 보고서

```js
{ schema: "transitline.service-plan-prescreening/1", contractVersion: 1,
  servicePlanId, serviceId, lineId,
  verdict,                    // 전체 판정
  areas: { plan, line, technical, fleet, track },   // 영역별 판정
  checks: [{ checkId, area, status, reason, facts }],
  blockers: [...],            // impossible 사유
  missingInputs: [...],       // unknown 사유
  conditions: [...],          // conditional 사유
  deferredToB13: [...] }
```

전체 판정은 가장 나쁜 항목이다. 순서는 **impossible > unknown > conditional > possible** (B12-2 `verdictOf`와 같다). 확실한 막힘은 모르는 것보다 먼저 보이고, 모르는 것은 조건부보다 먼저 보인다. 미상이 하나라도 있으면 `possible`이 될 수 없다.

### 검사 항목

| 영역 | checkId | possible | conditional | impossible | unknown |
|---|---|---|---|---|---|
| plan | `map-revision` | `current` | | `stale` | 명시 없음 |
| line | `operational-line` | 서비스에 운행선 1개 | | 운행선 없음 | 여러 개 / 상태 없음 |
| line | `line-suspension` | 운행 중 | `suspended` | | 명시 없음 |
| line | `station-state`, `track-state` | 모두 `available` | | 역·구간이 없거나 `available`이 아님 | `status` 미명시 / 목록 없음 |
| technical | `technical:*` (12개) | `compatible` | `conditional` | `incompatible` | 자료 없음, 모델·사양 미선택, 프로필 불명 |
| fleet | `fleet-sets` | 배정되지 않은 가용 편성 ≥ 요청 | 재배정·수리 복귀·발주 인도가 있으면 충족 (`facts.needs`) | 보유+발주를 모두 더해도 모자람 | 배정 자료 없음, 편성 상태 불명, 요청 수 오류 |
| track | `rail-capacity-application` | 적용 있음 | | | 없음 |
| track | `direction-mode` | 모든 구간 명시 | | | `null`, 적용에 없는 구간 |
| track | `block-data` | 모든 구간 명시(`[]`도 명시) | | | `null` |
| track | `junction-resource` | 분기 없음(명시)이거나 모두 연결 확인 | | 분리됨 / 계획이 지목한 분기가 없음 | 분기 자료 `null`, 연결 미확인, 구성 불완전 |
| track | `terminal-resource` | 종착 자원이 운행선 위에 있음 | | 적용에 없는 ID / 노선 밖 | 선택 안 함 / 종착 자료 `null` |
| track | `turnback-connection` | 연결된 회차선 후보 있음 | 승강장 회차만 그려짐 | 회차선이 없거나 모두 미연결 / 지목 후보 없음 | 연결 `null` / 자료 `null` |
| track | `capacity-data` | 용량이 양수로 명시 | | | 없음 |

`capacity-data`와 `direction-mode`는 **자료가 명시돼 있다**는 사실만 본다. 단선이어서 위험한지, 용량이 모자란지는 판정하지 않는다.

## null 처리

- 모르는 값은 통과가 아니다. `null`·`undefined`·누락·형식 오류는 모두 `unknown`이다.
- `unknown`과 `impossible`을 구분한다. "회차 자원이 적용에 없다"는 이미 그려진 목록에 없다는 확실한 사실이라 `impossible`, "종착 자료 자체가 `null`"이면 `unknown`이다.
- 배열의 의미를 지키기 위해 `blockIds: []`, `junctionResourceIds: []`는 "없다고 명시"로 읽고, `null`은 미상으로 읽는다(M5 지도 계약과 같은 규칙).
- 외부선 사양의 `gaugeMm: null`은 `notApplicable`에 있으면 맞는 것으로, 없으면 미상으로 읽는다(B12-2와 같음).
- 어떤 입력도 `0`·`false`·`[]`로 바꿔 채우지 않는다. 잘못된 계획(`null`, 문자열, 빈 객체)도 예외 없이 `unknown` 보고서가 된다.

## 연결 방법 (Codex)

`ScenarioRuntime`은 수정하지 않았다. 호출 쪽에서 아래처럼 읽어 넘기면 된다.

```js
import { prescreenServicePlan } from "./service-plan-prescreening.mjs";
const report = prescreenServicePlan(plan, {
  operationalState: runtime.operationalState,
  technicalSpecs,                                        // 노선별 기술사양 (지도 카탈로그에서)
  vehicleOrders: runtime.game.vehicleOrders,
  operatingResourcePools: runtime.report().operatingResourcePools,
});
```

권장 순서는 감사 문서와 같다: M1 계획 → **E1 사전심사** → `assessOperationalRailwayTimetable()` → 승인 → 활성화. 사전심사가 `impossible`/`unknown`이면 B13 심사를 열기 전에 사유를 먼저 보여 줄 수 있다. 사전심사가 `possible`이어도 B13 심사는 반드시 거친다.

## 읽기 전용·결정론

입력을 바꾸지 않는다(상태 직렬화 바이트 동일을 테스트로 확인). `Math.random`·`Date.now`를 함정으로 바꿔도 동작하고, 반환값을 고쳐도 입력이 바뀌지 않는다(`structuredClone`). 현금·경영 원장·시계·RNG를 읽거나 쓰지 않는다.

## 테스트

`engine/test/service-plan-prescreening.test.mjs` — 25개. 운행 상태·B13 적용은 실제 `createState` + `applyRailCapacityGeometry`로 만들고, M1 계획만 합성한다.

변이 확인: 회차선 `attached: null`과 배정 자료 없음을 통과로 바꾸면 테스트 2개가 실패하는 것을 확인하고 되돌렸다. (처음에는 사유만 비교해 변이가 살아남았기에, 사유와 판정을 함께 확인하는 `assertReason`으로 고쳤다.)

## 한계

- **M1 계약이 없다.** 계획 필드는 합성이다. M1의 실제 필드명과 맞추는 일은 M1 연결 단계에 남는다.
- **직통 운행(여러 노선)은 한 번에 보지 않는다.** 계획 하나는 서비스 하나, 운행선 하나로 푼다. 서비스가 운행선 여러 개에 걸리면 `unknown`(`service-maps-to-several-lines`)이다.
- **편성 예약을 하지 않는다.** 가용 편성이 충분한지만 보며 두 계획이 같은 편성을 동시에 쓰려 해도 서로 모른다. 예약은 감사 문서가 "아직 하지 않는 것"으로 둔 항목이다.
- **차량기지·승무 인력·정비 용량은 보지 않는다.** B16의 인력 단계 몫이다.
- **진행 중인 운행 장애·관제 명령은 보지 않는다.** 노선의 `suspended`, 역·구간의 `status`만 본다.
- **`capacityTrainsPerHour`의 방향별 의미를 해석하지 않는다.** 값이 명시됐는지만 본다.
- **회차 후보를 계획이 고르지 않으면 "연결된 후보가 하나라도 있는가"만 본다.** 어느 후보를 쓰는지는 정하지 않는다.
- **외부선 사양은 노선 단위 한 값이다.** 구간마다 다른 값은 표현하지 못한다([외부 철도 기술사양 계약](external-rail-technical-specification-contract.md)의 한계와 같다).
- **지도 revision을 이 모듈이 대조하지 않는다.** M1이 준 `mapRevision.state`를 믿는다.
