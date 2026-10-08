# B16 — 운행계획 통합 경계 감사

## 결론

B16은 새 시간표·용량 엔진을 만드는 단계가 아니다. 이미 B13이 다음을 처리한다.

- `management/railway-timetable.mjs`: 경로 시간, 최소시격, 단선 충돌, 시간당 용량, 분기기, 회차 자원, 폐쇄시간대 심사와 승인.
- `operational-timetable-integration.mjs`: 실제 운행선·선로 구간으로 시간표 입력을 만들고, 활성 시간표를 실제 열차 출발에 적용.
- `ScenarioRuntime.assessOperationalRailwayTimetable()`: 위 입력 작성과 경영 시간표 심사의 단일 진입점.
- `ScenarioRuntime.approveRailwayTimetable()` / `activateRailwayTimetable()`: 트랜잭션 승인과 실제 운행 적용.

따라서 B16의 역할은 플레이어가 지도에서 작성한 의도를 기존 B13 입력으로 안전하게 변환하고, B13의 심사 결과를 되돌려 보여 주는 것이다. 같은 용량 판정, 시간표 충돌 판정, 열차 경로 생성기를 다시 만들면 안 된다.

## 기존 B13 진입점

```js
const assessed = runtime.assessOperationalRailwayTimetable({
  dayType,
  servicePlans,
  closureWindowsBySectionId,
  infrastructureAssumptions,
  minimumAcceptanceRatio,
});
runtime.approveRailwayTimetable(assessed.id);
runtime.activateRailwayTimetable(assessed.id);
```

`servicePlans[]`의 현재 최소 형식은 다음과 같다.

| 필드 | B13 의미 |
|---|---|
| `serviceId` | 이미 개통되어 실제 운행선에 연결된 관리 서비스 ID |
| `firstDepartureMinute`, `lastDepartureMinute` | 한 영업일 안의 첫차·막차 |
| `headwayMinutes` 또는 `trainsPerHour` | 플레이어 요청 배차 |
| `commercialSpeedKph` | 운전시분 도출에 쓸 서비스 속도 |
| `dwellMinutes` | 구간 뒤 정차 시간 |
| `terminalResourceId`, `turnbackMinutes` | 종점 회차 자원과 점유 시간 |
| `includeReturnPaths` | 왕복 운행 여부 |
| `operatorId`, `priority` | 운행사와 배정 우선순위 |

B13은 이미 입력의 노선 연속성, 복편 duty, 구간 충돌, 회차 충돌, 폐쇄 충돌을 판정한다. `possible` 외 결과는 승인할 수 없다.

## B16-M1이 만들어야 할 것

M1 지도 계약은 플레이어가 쓴 운행계획의 원본이어야 하며, B13 시간표 자체를 복제해서는 안 된다. 아래 필드는 B13 어댑터가 읽을 수 있게 안정적으로 제공한다.

| B16 지도 의도 | B13 어댑터 출력 |
|---|---|
| 개통된 서비스 또는 운행선 선택 | `serviceId` |
| 평일/주말 시간대 | `dayType`, `firstDepartureMinute`, `lastDepartureMinute` |
| 요청 배차 | `headwayMinutes` 또는 `trainsPerHour` |
| 운전·정차 가정 | `commercialSpeedKph`, `dwellMinutes` |
| 종점 회차 선택 | `terminalResourceId`, `turnbackMinutes` |
| 왕복/편도 선택 | `includeReturnPaths` |
| 운영 우선순위 | `priority` |
| 명시적 인프라 가정 | `infrastructureAssumptions` |
| 명시적 폐쇄 시간창 | `closureWindowsBySectionId` |

M1의 지도 출력은 `servicePlanId`, revision, key, source pack 및 지도 연결 근거를 보존해야 한다. B13에 없는 map-only 필드(그린 회차 위치, 선택 후보, 공간 결측 사유)는 그대로 저장하되 B13에 임의 수치로 바꾸지 않는다.

## B16-E1의 올바른 범위

E1은 독립 판정 엔진이 아니라 **순수 어댑터·입력 준비도 보고서**여야 한다.

1. B16 지도 계약의 플레이어 입력을 검증한다.
2. 실제 개통 서비스 ID와 운행선 매핑을 확인한다.
3. B13에 넘길 `servicePlans[]` 및 명시적 가정을 만든다.
4. 지도 결측, revision 불일치, 외부선 미상, 회차 자원 미상은 `unknown` 또는 준비도 이슈로 남긴다.
5. 용량·단선·분기기·회차 충돌의 최종 판정은 B13 `assessOperationalRailwayTimetable()` 결과를 그대로 사용한다.

E1은 다음을 새로 계산하면 안 된다.

- 최소시격 또는 시간당 용량
- 개별 출발 시각 확대
- 단선·분기기·회차 충돌
- 운전시분·통과시각
- 열차 편성 예약
- 수요, 승객, 운임, 비용, 혼잡, 수익

## Fail-closed 규칙

| 사실 | B16 어댑터 처리 |
|---|---|
| 실제 운행선이 없음 | 입력 준비 불가 |
| 선로 연결이 `false` | 입력 준비 불가 |
| 선로 연결이 `null` | `unknown`, B13에 임의 연결을 넣지 않음 |
| 단선/복선이 `null` | 명시적 `infrastructureAssumptions.directionMode` 없이는 B13이 거절하도록 유지 |
| 최소시격이 `null` | 명시적 `minimumHeadwayMinutes` 가정 없이는 B13이 거절하도록 유지 |
| 회차 자원 `false` | 입력 준비 불가 |
| 회차 자원 `null` | `unknown`; 임의 회차 자원을 만들지 않음 |
| 폐색이 `null` | 미상으로 남김; B13 block 모델을 지어내지 않음 |
| 폐쇄 시간창 없음 | 빈 배열로 추정하지 않음. 명시한 시간창만 B13에 전달 |
| stale 지도 revision | 기존 시간표 승인·활성화 대상이 아님 |

## B16 통합 순서

1. M1: 지도에서 운행 의도를 작성·저장한다.
2. E1: 지도 계약을 B13 입력 후보로 바꾸고, 준비도·결측·stale를 보고한다.
3. Codex: `ScenarioRuntime.assessOperationalRailwayTimetable()`로 실제 B13 심사를 실행한다.
4. 플레이어: B13 심사 결과와 거절 경로를 검토한다.
5. Codex: 승인·활성화 API를 호출한다.
6. 기존 B13-2: 활성 시간표의 승인된 출발만 실제 열차 시뮬레이션에 적용한다.

## 아직 하지 않는 것

- B16 지도 계약에서 생성한 계획을 `main.mjs`에 연결하는 UI
- B16 지도 문서의 통합 저장
- 편성 수·차량 보유량의 예약 및 운영 인력 배정
- 다일·공휴일 달력, 야간 운행, 회복시간표
- B15 접근권 수요를 실제 시간표의 혼잡·대기시간으로 되먹이는 모델

이 항목들은 M1/E1이 병합된 뒤에 B16 통합 단계에서 순서대로 처리한다.
