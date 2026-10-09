# B18-E2 운영 캘린더 엔진 연결 — 인수 문서

기준은 master `df0dbcc`(B18-C1 운영 캘린더), 브랜치 `b18-e2-operational-calendar-runtime`. B18-C1이 만든 `operationalCalendar`(`transitline.operational-calendar/1`)를 `ScenarioRuntime`에서 **트랜잭션으로** 바꾸는 API를 만들고, 저장·복원·롤백·시간표 재적용에 미치는 영향을 검증했다. 휴일 매핑을 바꿔도 기존 평일/주말 시간표는 건드리지 않는다. 새 배차 규칙, 비용·수요 계산, RNG·시계 사용은 없다. 변경한 소스는 `scenario-runtime.mjs` 하나다(`main.mjs`, 지도 UI, 스타일은 수정하지 않았다).

## API (`ScenarioRuntime`)

| 메서드 | 하는 일 |
|---|---|
| `assessOperationalCalendar(calendar)` | **읽기 전용** 미리보기. `{ accepted, rejections, calendar, changedDays, activeTimetables }`. 아무것도 바꾸지 않는다 |
| `setOperationalCalendar(calendar)` | 같은 검사를 하고 통과하면 **한 번의 대입**으로 반영한다. 거절되면 `Error("Operational calendar change rejected: <코드>")`를 던지고(`error.rejections`에 상세) 아무것도 움직이지 않는다. 반환은 `assess`와 같은 계획 |
| `operationalCalendarReport()` | 읽기 전용 현황: `calendar`, `currentDay`, `currentDayType`, `holidayDays`, `supportsHoliday`, `activeTimetables[{timetableId, dayType, supported}]`, `warnings` |

- `calendar`는 `{ schema: "transitline.operational-calendar/1", contractVersion: 1, dayTypesByOperatingDay: { "<day>": "weekday"|"weekend"|"holiday" } }`. `null`은 캘린더를 지운다(기본 월~금 평일, 토·일 주말, 휴일 없음).
- `changedDays`는 **실제로 유형이 바뀌는 날만** `{ day, from, to }`로 준다. 기본값과 같은 항목(예: 평일인 날에 `weekday`)은 변경이 아니다.
- 상태는 입력과 객체를 공유하지 않는다(입력·반환값·보고서를 고쳐도 엔진 상태는 그대로).

## 거절 사유 (전부 변경 전에 계산하므로 롤백할 것이 없다)

| 코드 | 의미 |
|---|---|
| `operational-calendar-invalid` (+`warnings`) | 스키마·항목이 올바르지 않다. **일부만 버리고 받지 않고 통째로 거절**한다(`…-entry-invalid:<day>`, `…-schema-invalid`, `…-days-invalid`) |
| `calendar-changes-started-day` (+`days`, `currentDay`) | 이미 시작된 날(`day ≤ 현재 운행일`)의 유형을 바꾸려 한다. **적용된 시간표 dispatch 항목이 하나라도 있을 때만** 거절한다. 그 날의 출발은 이미 옛 유형으로 배차·집계되었기 때문이다. 시간표가 없으면 지난 날도 바꿀 수 있다 |
| `calendar-leaves-active-holiday-timetable-without-holiday-day` (+`timetableIds`) | 활성 휴일 시간표가 있는데 새 캘린더에 휴일이 하나도 없다. 활성화·불러오기가 쓰는 `calendarSupportsDayType`와 같은 기준이라, 허용하면 다음 불러오기에서 그 시간표가 막힌다 |

## 시간표 재적용 영향

- **캘린더를 바꿔도 시간표를 다시 적용하지 않는다.** dispatch 항목은 요일형(`weekday`/`weekend`/`holiday`)을 키로 가지며, 배차기(`trains.mjs`)가 **날마다** 그 날의 유형을 캘린더에서 조회한다. 그래서 휴일 매핑을 바꿔도 평일·주말 항목의 `timetableId`, `serviceId`, `missedDepartures`, `lastCheckedSimMinute`, 열차는 바이트까지 그대로다(테스트로 고정).
- 휴일로 바뀐 날에는 평일 시간표가 그 날 배차·집계되지 않고, 다음 날 평일이 되면 같은 항목으로 이어진다. **휴일 시간표가 없는 노선은 그 날 빈도 배차로 돌아간다**(C1의 기존 동작; `unscheduledDispatchedTrains`로 센다).
- 휴일 시간표 활성화는 캘린더에 휴일이 있어야 하고, 없으면 기존처럼 거절·롤백된다. 휴일 시간표를 활성화해도 평일·주말 항목은 그대로다(같은 요일형만 교체).
- 휴일을 다른 날로 옮기는 변경은 허용된다(휴일이 하나 이상 남음). 옮긴 뒤 휴일 열차는 휴일 시간표의 `timetableId`/`managementServiceId`를 가진다.

## 저장·복원

- `operationalCalendar`는 운영 상태에 들어 있어 저장본에 그대로 들어간다. 불러오면 **시간표를 다시 적용하기 전에** 캘린더를 읽어 정규화한다(`load()`).
- 구저장본(캘린더가 생기기 전): 키가 없다 → `null`, 경고 없음.
- 손상된 캘린더: 엔진이 어차피 무시하던 항목은 상태에서 **버리고** `operationalCalendarReport().warnings`에 이름을 남긴다. 스키마가 읽히지 않으면 캘린더 없음(`null`)과 `operational-calendar-schema-invalid`. 이후 `setOperationalCalendar`가 성공하면 경고 기록은 지워진다.
- 활성 휴일 시간표가 있는데 저장본의 캘린더가 없거나 읽히지 않으면, 불러오기가 그 시간표를 **막힌 항목**으로 두고(`blockedReason` = "…calendar mapping", `operationalTimetableWarnings`에 기록), B17-E2 규칙에 따라 그 항목이 가진 카운트·확인 시각을 보존한다. 평일 항목은 영향이 없다.
- 불러오기는 RNG·관리 시계를 쓰지 않으며 저장 전후 캘린더 보고서가 같다. 저장→불러오기를 중간에 낀 실행과 끊김 없는 실행의 결과(항목·카운터)가 같다.

## 검증

- `engine/test/operational-calendar-runtime.test.mjs` 8개 (실제 `ScenarioRuntime`·실제 노선): 변경·미리보기·지우기·분리된 복사본, 잘못된 입력 7가지가 통째로 거절, 평일·주말 시간표 불변과 휴일 날의 동작, 활성 휴일 시간표(활성화 조건·고아 방지·옮기기·휴일 열차의 provenance), 저장·불러오기(보고서·항목·이어 달리기 동일), 구저장본·손상본·막힌 휴일 시간표, 시작된 날 규칙, 수락·거절 모두 RNG·시계·저장 문자열 불변.
- 전체 `npm test`, `npm run validate`, `git diff --check`는 최종 보고에 수치를 적는다.

## 한계

- 이미 시작된 날(0일차 포함)은 시간표가 적용되어 있으면 재분류할 수 없다. 새 시나리오의 0일차를 휴일로 하려면 시간표를 적용하기 전에 설정해야 한다.
- 휴일 시간표가 없는 노선의 휴일은 빈도 배차로 돌아간다. 평일 시간표를 휴일에 그대로 돌리는 규칙은 만들지 않았다.
- 불러오기는 활성 시간표를 요일형 이름순으로 다시 적용하므로 `line.timetableDispatches`의 키 순서가 저장 전과 다를 수 있다(내용은 같음). 한 번의 훑기가 서로 다른 요일형의 출발 두 개를 동시에 처리하는 드문 경우에는 열차 번호 부여 순서가 달라질 수 있다.
- `operationalDayType(simMinutes)`(`operational-timetable-integration.mjs`)는 캘린더를 받지 않아 기본 규칙만 돌려준다. 지금은 소스 호출처가 없지만, 캘린더를 아는 곳에서는 `operationalDayTypeAt(simMinutes, state.operationalCalendar)`를 써야 한다(`operationalCalendarReport().currentDayType`이 그렇게 한다).
- 합성 노선으로만 확인했고 실제 도쿄 시간표·휴일 목록으로는 확인하지 않았다. 공휴일을 추정하는 기능은 없다(C1 규칙 그대로, 명시한 날만 휴일).
