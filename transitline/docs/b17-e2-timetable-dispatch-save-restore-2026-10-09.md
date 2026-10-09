# B17-E2 시간표 dispatch 저장·복원 정확성 — 인수 문서

기준은 master `c0aa82b`(B17-E0 provenance, B17-E1 보고서 포함), 브랜치 `b17-e2-dispatch-save-restore`. B17-E1 보고서가 찾아낸 엔진 상태 보존 결함을 고쳤다. 새 배차 규칙, 비용·수요·혼잡 계산, RNG·시계 사용은 없다.

## 결함

`line.timetableDispatches[요일형]`(적용된 시간표 항목)은 저장본에 그대로 들어가지만, `ScenarioRuntime.load()`가 활성 시간표를 다시 적용하면서(`applyActiveRailwayTimetable`) 항목을 **지우고 새로 만들었다**. 그 결과 불러오기만 해도 항목의 `missedDepartures`(놓친 출발 수)가 사라지고 `lastCheckedSimMinute`(마지막으로 출발을 훑은 시각)가 불러온 시각으로 바뀌었다. 노선·운행일 카운터(`stats.railwayTrafficByLine`)는 남았으므로 "이 시간표·이 요일형에서 몇 번 놓쳤는가"만 잃었다.

## 변경

| 파일 | 변경 |
|---|---|
| `engine/src/operational-timetable-integration.mjs` | 새 `carriedDispatchFacts(previous, {timetableId, serviceId, dayType}, simMinutes)`. `applyActiveRailwayTimetable`은 **삭제 전에** 같은 노선·요일형의 기존 항목에서 사실을 읽어 새 항목에 이어 쓰고, `blockUnmappedRailwayTimetable`도 같은 규칙을 쓴다. 새 항목은 이제 `missedDepartures`를 항상 가진다 |
| `engine/src/trains.mjs` | `dispatchScheduledTrains`: `missedDepartures === null`이면 증가시키지 않고 null로 둔다(그 외는 기존과 같음) |
| `engine/src/railway-timetable-operation-report.mjs` | B17-E1 보고서의 문구만 수정: `counter-not-created` 사유와 `limits` 한 줄이 "불러오면 카운터가 사라진다"고 적혀 있어 사실과 달라졌다. 로직은 그대로 |
| `engine/test/timetable-dispatch-restore.test.mjs` | 신규 10개 |
| `engine/test/railway-timetable-operation-report.test.mjs` | 기대값 3곳(처음 값이 null → 기록된 0, 불러온 뒤 null → 보존) |
| `docs/b17-e1-railway-timetable-operation-report-2026-10-09.md` | "놓친 출발" 한 줄 |

`scenario-runtime.mjs`, `state.mjs`, 저장 경로(`integrated-save.mjs`)는 고칠 필요가 없었다(저장본에는 항목이 이미 통째로 들어 있다).

## 이어받는 규칙 (`carriedDispatchFacts`)

같은 `timetableId` + `serviceId`(경영 서비스 ID) + `dayType`의 기존 항목이 있을 때만 이어받는다.

| 기존 항목 | `lastCheckedSimMinute` | `missedDepartures` |
|---|---|---|
| 없음, 또는 다른 시간표·서비스·요일형의 것 | 지금(적용 시각) | `0` — 새로 적용했으니 놓친 것이 없다는 **기록된 0** |
| 둘 다 기록됨 | 기록된 값 그대로 | 기록된 값 그대로 |
| 카운터 없음 (이 카운터를 남기지 않던 옛 저장본) | 기록된 값 | `null` — 미상. 0으로 바꾸지 않는다 |
| 카운터가 정수 ≥ 0이 아님(`-1`, `1.5`, `"2"`, `NaN`, `null`) | 기록된 값 | `null` (숫자로 고치지 않는다) |
| 확인 시각 없음/비정상 | 지금(불러온 시각) — `trains.mjs`가 이미 쓰던 대체 규칙 | 위와 같음 |

- `timetableId`, `serviceId`(= 열차의 `managementServiceId`), `dayType`, `infrastructureRevision`은 시간표에서 다시 만들기 때문에 provenance는 그대로이고, 다른 시간표의 카운터를 물려받지 않는다.
- 막힌 항목(저장본의 인프라 개정이 달라 재적용 실패)도 같은 규칙으로 사실을 보존한다. 막힌 항목은 배차하지 않으므로 의미가 있는 것은 놓친 출발 수뿐이다.
- 활성화 실패(경로 불일치)는 이전과 같이 관리·운영 상태를 되돌리며, 새 코드는 변경 전에 읽기만 하므로 이전 항목의 사실이 그대로 남는다(테스트로 고정).

## 구저장본 동작

- 저장본의 항목에 `missedDepartures`가 **없다** → 불러온 뒤 `null`. 이후 놓친 출발이 생겨도 이 항목의 카운터는 `null`로 남는다(불러온 시점부터의 개수를 전체 개수처럼 보이지 않게 하려는 것). 노선 카운터(`railwayTrafficByLine.missedDepartures`)는 계속 모든 놓침을 센다.
- 숫자가 **있다** → 그대로 유지(예전 엔진은 놓침이 있으면 숫자를 저장했다).
- `lastCheckedSimMinute`가 없다 → 불러온 시각(과거 출발을 다시 훑지 않는다).
- 항목 자체가 없다(적용 전 저장) → 새 적용으로 기록된 `0`.

## 이중 배차·재집계가 없는 이유

`lastCheckedSimMinute`는 엔진이 마지막으로 훑은 시각이다. 예전에는 불러올 때 이 값이 "지금"으로 바뀌어, 저장 시각과 불러온 시각 사이에 훑지 않은 출발이 있으면 조용히 사라졌다. 이제는 저장된 값을 이어받아 **저장 없이 계속 달린 경우와 같은 훑기**를 한다: 이미 배차했거나 놓침으로 센 출발은 `lastChecked`보다 앞이라 다시 세지 않고, 아직 훑지 않은 출발은 정확히 한 번 처리된다(테스트: 저장 후 불러온 실행과 끊김 없는 실행의 열차·카운터·항목이 같다).

## 검증

- 신규 테스트 10개 (`engine/test/timetable-dispatch-restore.test.mjs`, 실제 `ScenarioRuntime`·실제 노선):
  1. 저장 → 불러오기 뒤 항목 전체(`missedDepartures`, `lastCheckedSimMinute`, provenance)와 노선 카운터 보존, 불러오기가 RNG·관리 시계를 쓰지 않음
  2. 불러온 직후 과거 출발이 다시 배차·집계되지 않음(확인 시각만 앞으로 감), 저장 시점에 확인 시각이 뒤처진 경우 "불러온 뒤 계속"과 "계속"이 같음
  3. 다음 출발과 다음 놓친 출발이 정확히 한 번씩, 하루 중간 저장이 무저장 실행과 같음
  4. 평일/주말 항목이 각자의 카운트를 유지, 정지된 노선·여러 활성 노선
  5. B17-E0 provenance(저장된 열차, 불러온 뒤 새로 배차한 열차)
  6. 구저장본 5가지(카운터 없음·숫자 있음·확인 시각 없음·비정상 값·항목 없음/다른 시간표)
  7. `carriedDispatchFacts` 단위 규칙, 재적용 실패(인프라 개정 변경) 시 막힌 항목의 사실 보존
  8. 불러오기 실패(잘못된 텍스트·다른 팩·다른 스키마)와 활성화 실패 뒤 저장 문자열·RNG·시계가 그대로
- 전체 `npm test`, `npm run validate`, `git diff --check` 결과는 최종 보고에 적는다.

## 남은 한계

- 구저장본에서 온 항목의 카운터는 `null`로 남는다. 알 수 없는 값을 추정하지 않기 위한 선택이며, 그 항목은 다음 시간표 교체(활성화)로 새 `0`부터 다시 시작한다.
- 이어받는 단위는 노선·요일형 항목이다. 경로(path) 단위의 놓침이나 놓친 이유는 기록하지 않는다(정지 노선과 늦은 확인이 모두 "놓침"으로 센다).
- 저장본의 `lastCheckedSimMinute`가 현재보다 많이 앞서 있으면(노선에 역 묶음이 없어 배차 검사를 건너뛴 경우 등) 불러온 뒤 첫 검사가 그 구간을 한 번에 훑어 놓침으로 센다. 저장 없이 계속 달렸어도 같은 결과다.
- 휴일 시간표는 이 작업에서 지원하지 않았다(재적용은 여전히 거절·막힘).
- 여러 활성 시간표가 같은 노선·같은 요일형을 가리킬 수 없다(활성화가 이전 것을 대체)는 기존 제약을 그대로 따른다.
- 합성 노선으로만 확인했고 실제 도쿄 시간표로는 확인하지 않았다.
