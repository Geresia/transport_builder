# B17-E1 철도 시간표 실제 운행 보고서

`engine/src/railway-timetable-operation-report.mjs` (+ `ScenarioRuntime.railwayTimetableOperationReport()`, `engine/test/railway-timetable-operation-report.test.mjs` 19개). 기준 master `ff4b739`.

## 하는 일

엔진이 **이미 만든 사실만** 모아 읽기 전용으로 보여 준다. 새 배차 규칙, 열차 생성 규칙, 시간표 판정, 지연·비용·수요·혼잡 계산, RNG, 시계 변경, management 상태 변경은 없다. B17-E0이 열차에 붙인 `timetableId` / `managementServiceId`와 B17-M1 지도 표시(`map/railway-timetable-operation-view.mjs`)는 건드리지 않았고, 이 보고서는 지도가 아니라 **숫자와 사실**을 낸다.

## 사실의 출처

| 보고서 항목 | 엔진의 어디에서 읽나 |
|---|---|
| 시간표 상태·판정·경로 수·생애주기 분 | `railwayTimetableReport()` (management) |
| 선로별 dispatch(예정 출발, 놓친 출발, 막힘 사유) | `line.timetableDispatches[dayType]` |
| 운행 중 열차와 provenance | `state.trains[].timetableId / managementServiceId / scheduledDepartureMinute` |
| 노선별 누적 카운터 | `state.stats.railwayTrafficByLine[lineId]` (개수만: `TRAFFIC_COUNTERS`) |
| 노선 정지 | `line.suspended` |

## 사용법

```js
runtime.railwayTimetableOperationReport();
// 또는
buildRailwayTimetableOperationReport({ operationalState, timetables })   // timetables = runtime.railwayTimetableReport()
```

호출은 상태·RNG·시계·게임 snapshot·`save()`를 바꾸지 않고(테스트), 같은 입력이면 같은 결과이며 열차·시간표 저장 순서와 무관하다. 반환값은 복사본이다.

## 보고서 구조 (`transitline.railway-timetable-operation-report/1`)

| 필드 | 내용 |
|---|---|
| `simMinutes`, `status` | 엔진 시각(분)과 `available` / `none` / `unavailable` |
| `unavailable` | 주지 않은 입력의 이유(`the-timetable-report-was-not-provided`, `the-operational-state-was-not-provided`) |
| `totals` | `timetablesByStatus`(active / approved / assessed / withdrawn / superseded / other 개수), `dispatches`, `liveTrains`(total, withTimetable, scheduledProvenanceUnrecorded, legacyFrequency, running, positionUnknown, done) |
| `timetables[]` | 시간표별: `status`, `dayType`, `verdict`, `paths{requested, accepted, rejected}`, `serviceIds`, `lifecycle{created/approved/activated/superseded/withdrawn 분, withdrawnFromStatus}`, `dispatchCount`, `dispatchLineIds`, `missedDepartures`, `trains{live, running, positionUnknown, done, managementServiceIds, trainIds}`, `completedTrains` |
| `dispatches[]` | 실제 운행선에 적용된 dispatch: `operationalLineId`, `dayType`, `timetableId`, `serviceId`, `blockedReason`, `lineSuspended`, `scheduledDeparturesPerDay`, `departureMinutes`, `lastCheckedSimMinute`, `missedDepartures` |
| `lines[]` | dispatch·운행 열차·기록된 통계 중 하나라도 있는 노선: `managementServiceId`, `suspended`, `dispatchDayTypes`, `traffic`(엔진이 기록한 개수 그대로), `trains{live, withTimetable, scheduledProvenanceUnrecorded, legacyFrequency}` |
| `trains[]` | 지금 선로 위의 열차: `trainId`, `operationalLineId`, `provenance`, `timetableId`, `managementServiceId`, `scheduledDepartureMinute`, `scheduledCompletionMinute`, `status`, `positionUnknownReasons`, `segIndex`, `direction`, `progress`, `waitingForSignalReason`, `holdUntilSimMinute` |
| `issues[]` | 서로 어긋나는 사실의 목록(아래) |
| `limits[]` | 이 보고서가 말할 수 없는 것 4가지 |

정렬: 시간표는 ID 숫자 순(`railway-timetable:2` < `:10`), 선로·열차도 숫자 순.

## 열차 provenance

| `provenance` | 뜻 | `timetableId` |
|---|---|---|
| `timetable` | B17-E0 이후 시간표가 만든 열차 | 시간표 ID |
| `scheduled-provenance-unrecorded` | 예정 출발이 있는데 provenance가 없음(B17-E0 이전 저장본) | `null` + 이유. **활성 시간표의 열차로 추정하지 않는다** |
| `legacy-frequency` | 노선 빈도로 만든 옛 방식 열차 | `null` + `dispatched-by-line-frequency-not-by-a-timetable` |

## 열차 상태

엔진 필드와 역 표만으로 판단하고 위치를 계산하지 않는다.

- `done` — `train.done === true`. 엔진은 끝난 열차를 같은 스텝에서 목록에서 지우므로 거의 보이지 않으며, 정상 종료인지는 말해 주지 않는다.
- `running` — 노선·역 목록·구간 번호·방향·진행도(0~1)·역 표가 모두 쓸 수 있음.
- `position-unknown` — 못 쓰는 필드마다 이유: `line-missing`, `service-stations-missing`, `segment-index-invalid`, `direction-invalid`, `progress-invalid`, `station-missing`. 쓸 수 없는 값은 `0`이 아니라 `null`(예: `progress: null`).

## 결측 규칙

모르는 값은 `null`이고 옆에 `…Reason`이 붙는다. `0`/`false`/`[]`로 바꾸지 않는다.

- 전달하지 않은 입력: `timetables: null`(전달했지만 비어 있으면 `[]`), `lines/trains/dispatches: null`.
- 아직 만들어지지 않은 전이: `lifecycle.approvedAtMinute: null` 등(`lifecycleNote`).
- **놓친 출발**: dispatch 항목의 카운터는 엔진이 *첫 번째로 놓쳤을 때* 비로소 만든다. 없으면 `missedDepartures: null` + `counter-not-created…`(0으로 적지 않는다). 놓친 적이 있으면 숫자. 시간표 합계는 dispatch 하나라도 `null`이면 `null`.
- **완료한 열차 수**: `completedTrains: null` + `finished-trains-are-removed-and-traffic-counters-are-per-line`. 끝난 열차는 목록에서 사라지고 엔진의 통계는 노선 단위라 시간표별로 셀 수 없다. 노선별 `traffic.completedTrains` 등은 엔진이 기록한 숫자 그대로 `lines[].traffic`에 있다(기록이 없으면 `traffic: null` + 이유). 엔진이 `0`으로 기록한 것은 `0`이다.
- 지연 합계·비율은 복사하지 않는다(`TRAFFIC_COUNTERS`는 개수만).

## issues — 어긋나는 사실 (판정이 아니다)

`dispatch-timetable-unknown`, `dispatch-timetable-not-active`, `dispatch-blocked`, `suspended-line-with-dispatch`, `active-timetable-without-dispatch`, `scheduled-train-without-provenance`, `train-position-unknown`, `train-timetable-unknown`, `train-timetable-differs-from-line-dispatch`(예: 대체 개통 뒤에도 옛 시간표 열차가 달리는 중). 시간표 목록을 주지 않으면 시간표를 아는 척하는 항목은 만들지 않는다.

## 한계

- **완료 열차는 시간표별로 알 수 없다**(위).
- **dispatch별 놓친 출발 카운터는 dispatch가 다시 적용될 때마다 처음부터 다시 센다.** 새 시간표를 개통할 때뿐 아니라 **저장본을 불러올 때도** 엔진이 활성 시간표를 다시 적용하므로(`ScenarioRuntime.load`) 카운터가 사라진다. 보고서는 이때 0이 아니라 `null` + 이유를 낸다. 노선 단위 `traffic.missedDepartures`는 저장본을 거쳐도 남는다(테스트로 확인). 이 동작은 기존 엔진의 것이며 바꾸지 않았다.
- 놓친 출발의 **원인**(노선 정지인지 확인 지연인지)은 엔진이 기록하지 않아 알 수 없다.
- 지금 선로 위의 열차만 나온다. 노선 정지로 열차가 지워지는 경우(`suspended`) 그 열차는 기록이 없다.
- 오늘 어느 요일 유형이 적용되는지는 판단하지 않는다(`dayType`만 보여 준다).
- 위치 좌표·지도 그리기는 B17-M1의 몫이다.

## Codex 연결

- `ScenarioRuntime.railwayTimetableOperationReport()`만 부르면 된다. `report()`에는 넣지 않았다(구조 복제 비용).
- 패널에 연결한다면 시간표 수명주기 패널이 `refresh()`될 때(심사·승인·개통·철회 직후, 저장본 불러온 직후)와 시뮬레이션이 진행되는 동안 주기적으로(예: 1초) 다시 읽는다. 읽기만 하므로 자주 불러도 상태가 바뀌지 않지만, 열차가 많으면 비용이 든다.
- `issues[]`를 화면에 올리면 "열차가 이미 대체된 시간표로 달리는 중" 같은 상황을 설명할 수 있다.
- 읽기 전용 이용자(지도, 수명주기 패널)는 `timetables[].status`와 `trains[].status`를 그대로 쓰면 된다. 판정을 다시 계산하지 말 것.

## 검증

`node --test engine/test/railway-timetable-operation-report.test.mjs` — 19개, 실제 `createState`·`ScenarioRuntime`·`dispatchTrains`·`stepTrains`로 열차를 만든다: 입력 없음/일부만, 활성 시간표의 provenance 집계와 경로 수, 5가지 상태, 대체 개통 뒤 옛 열차, 옛 방식 빈도 열차, 저장본 이전 열차, 놓친 출발(없음/있음), 정지 노선, 위치 미상·완료·신호 대기, 완료 열차 `null`, 어긋남 목록, 읽기 전용(동결 입력, 상태·snapshot·RNG·시계·save 불변, `Math.random`/`Date.now` 차단), 결정성·순서 독립·복사본, 저장·불러오기, 금지 낱말 키 없음, 소스 검사.

변이 확인: 옛 방식 열차를 다른 분류로 표시, 없는 카운터를 0으로, 진행도 검사 제거, 완료 열차를 0으로, 기록 없는 통계를 0으로, 보고서가 열차에 쓰기 — 각각 해당 테스트가 실패하는 것을 확인하고 되돌렸다.
