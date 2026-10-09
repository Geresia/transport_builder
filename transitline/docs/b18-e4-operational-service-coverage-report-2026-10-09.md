# B18-E4 운영일별 서비스·시간표 커버리지 사실 보고서 — 인수 문서

기준은 master `0c56381`, 브랜치 `b18-e4-service-coverage-report`. **오늘(현재 시뮬레이션 일) 각 운영 노선에 어떤 배차 원천이 적용되는가**만 사실로 보고한다. 배차가 가능한지·충분한지, 시격·용량·비용·수요·혼잡·정시성은 계산하지도 담지도 않는다. B17 운영 보고서(`railwayTimetableOperationReport`)가 하는 시간표별 실행 사실(카운터, 열차, 적용 상태)은 **다시 집계하지 않는다**: 이 보고서는 "오늘 어느 규칙이 적용되는가"만 담당한다.

## API

- `engine/src/operational-service-coverage-report.mjs`: `buildOperationalServiceCoverageReport({ operationalState, services })` — 순수 읽기 전용.
- `ScenarioRuntime.operationalServiceCoverageReport()` — 읽기 전용 래퍼 하나(`operationalState`와 `game.services`를 넘겨 호출).

## 계약 `transitline.operational-service-coverage-report/1`

```
{ schema, contractVersion: 1, basis: "engine-state-facts",
  simMinutes, currentDay, currentDayType, currentDayTypeSource: "operating-calendar" | "default-rule" | null, bandId,
  lines: [ { operationalLineId, managementServiceId, managementServiceIdSource: "line" | "service-link" | "service" | null, serviceStatus,
             lineSuspended, planOnly, currentDayType,
             currentDispatchEntry,        // 현재 요일형의 line.timetableDispatches 기록 그대로(복사) 또는 null
             dispatchEntryDayTypes,       // 이 노선이 기록을 가진 요일형 목록 ([] = 기록 없음이 선언된 사실)
             dispatchSource,              // timetable / legacy-frequency / suspended / no-operational-line / unknown
             timetableId, timetableDayType,
             legacyFrequency,             // { bandId, trainsPerHour } — 빈도 규칙이 읽히는 노선만
             reasons: [...], warnings: [...] } ],
  counts: { rows, bySource: { … } }, warnings: [ …운영 캘린더 경고 ] }
```

- 현재 요일형은 운영 캘린더(명시한 날)가 우선이고 없으면 기본 월~금/토·일 규칙이다(`currentDayTypeSource`). 시간이 숫자가 아니면 `null`과 `sim-minutes-unknown`.
- `lines`는 운영 노선 한 줄씩과, **운영 노선이 없는 경영 서비스** 한 줄씩(`no-operational-line`, `operationalLineId`는 null이거나 상태에 없는 번호)이다. 노선이 있는 서비스는 노선 행에만 나온다(중복 없음).
- `managementServiceId`는 노선의 `managementServiceId`를 먼저 쓰고, 노선에 없고 서비스 한 개만 그 노선을 가리킬 때만 그 서비스를 쓴다(`management-service-found-through-service-link`). 서비스가 여러 개 가리키거나 서로 가리키는 값이 다르면 경고(`…-ambiguous`, `…-mismatch`). 관리 상태에 없는 서비스의 `serviceStatus`는 null이다.

## `dispatchSource` — 배차기(`trains.mjs`)의 판단 순서 그대로

| 순서 | 조건 | `dispatchSource` | 비고 |
|---|---|---|---|
| 1 | 노선이 없음(서비스 행) | `no-operational-line` | `service-has-no-operational-line` / `operational-line-missing` |
| 2 | 현재 요일형을 알 수 없음 | `unknown` | `day-type-unknown`(+`sim-minutes-unknown`) |
| 3 | `line.suspended`가 참 | `suspended` | 보유한 항목은 `currentDispatchEntry`로 사실만 보이고 `timetableId`는 비움 |
| 4 | 현재 요일형의 항목이 있음 | `timetable` | `timetableId`, `timetableDayType`는 항목의 기록. 막힌 항목은 `dispatch-entry-blocked` 경고(엔진은 이때 빈도로 돌아가지 않는다) |
| 5 | 항목 없음, `line.frequency[대역]`이 숫자 | `legacy-frequency` | 기존 `line.frequency` 기반 배차라는 사실만. 값이 `0`이면 숫자 0 그대로와 `frequency-is-zero-in-current-band` |
| 6 | 항목 없음, 빈도가 숫자가 아님 | `unknown` | `legacyFrequency.trainsPerHour: null` + `frequency-unrecorded-for-current-band` |

- 항목이 없을 때 이유는 둘로 갈린다: 아무 기록이 없음(`no-dispatch-entry-for-current-day-type`) / 다른 요일형에만 있음(`dispatch-entries-only-for-other-day-types`, 예: 평일 시간표만 있는데 오늘이 주말·휴일).
- **planOnly**: 배차기는 `planOnly`를 읽지 않는다(시나리오 모드의 계획선은 `suspended: true`로 만들어져 배차되지 않을 뿐). 그래서 `planOnly`는 사실(`plan-only-line`)로만 보이고 원천은 정지 여부를 따른다. 계획선인데 정지가 아니면 `plan-only-line-not-suspended` 경고.
- 정지 플래그가 기록되지 않은 노선은 `lineSuspended: null`과 `suspended-flag-unrecorded`, 원천은 엔진 규칙(없음 = 정지 아님)을 따른다.
- 활성 철도 통제 명령이 있으면 `partial-service-control-order-active`(이유만; 배차 원천은 바꾸지 않는다).

## null / false / 0 / []

`lineSuspended`·`planOnly`: 기록된 `true/false`, 기록이 없으면 `null`. `trainsPerHour`: 기록된 숫자(0 포함) 또는 `null`. `currentDispatchEntry`: 기록 또는 `null`. `dispatchEntryDayTypes`: 기록이 없다는 것이 알려진 사실이므로 `[]`. 어느 것도 서로로 바뀌지 않는다. 이유·경고 코드는 `COVERAGE_REASONS`에 문서화되어 있다(보고서가 내는 코드는 모두 그 안에 있다는 테스트).

## 읽기 전용·결정성

호출은 상태·RNG·시계·저장 문자열·카운터를 바꾸지 않는다(`railwayTrafficStats`처럼 기록을 만드는 함수를 쓰지 않는다). 출력은 입력과 객체를 공유하지 않으며(항목은 복사), 입력 순서와 무관하게 같은 결과이고, 동결 입력에서 동작한다. 저장 → 불러오기 뒤 보고서가 같다.

## B17-E2 / B18-E2와의 관계

- 항목은 저장·복원에서 `missedDepartures`, `lastCheckedSimMinute`가 이어지므로, `currentDispatchEntry`가 불러온 뒤에도 같다(테스트로 고정). 이 보고서는 그 카운터를 해석하지 않고 항목 그대로 복사만 한다.
- 운영 캘린더(`operationalCalendar`)를 읽어 현재 요일형을 정한다. 손상된 캘린더의 경고는 `warnings`로 전달한다.

## 검증

- `engine/test/operational-service-coverage-report.test.mjs` 10개 (실제 `ScenarioRuntime`·실제 노선): 평일·주말·명시 휴일(휴일 시간표 없음/있음), 정지·planOnly·정지 미기록, 기록 없음·빈도 0·빈도 없음·막힌 항목, 운영 노선 없는 서비스, 관리 서비스 연결(노선 우선·서비스 쪽 발견·불일치·모호), 저장·복원과 손상·누락 캘린더, 동결 입력·RNG·시계·저장 문자열 불변·결정성·입력 순서 무관, 빈·이상 입력, 판정·B17 카운터 키가 없음과 소스 검사.
- 전체 `npm test`, `npm run validate`, `git diff --check`는 최종 보고에 수치를 적는다.

## 한계

- 빈도 규칙의 **실제 열차 수는 계산하지 않는다**(`trainsPerHour`는 기록된 값). 빈도 배차가 실제로 열차를 내는지(대역·마지막 배차 시각)는 보지 않는다.
- `suspended` 원천은 "엔진이 지금 이 노선에서 배차하지 않는다"는 사실이지, 왜 정지했는지는 말하지 않는다.
- 관리 서비스 상태(`serviceStatus`)는 기록된 문자열이며 의미를 해석하지 않는다. 직통(through) 서비스는 이 보고서의 행에 넣지 않았다.
- 휴일 시간표가 없는 휴일의 평일 시간표 대체는 만들지 않았다(엔진은 빈도로 돌아가며 보고서가 그 사실을 이유로 보인다).
- 합성 노선으로만 확인했고 실제 도쿄 시간표로는 확인하지 않았다.
