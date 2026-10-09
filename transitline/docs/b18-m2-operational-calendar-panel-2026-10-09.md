# B18-M2 운영 캘린더 편집 패널

`engine/src/operational-calendar-panel.mjs` (+ `engine/test/operational-calendar-panel.test.mjs` 21개). 기준 master `df0dbcc`(B18-C1 운영일력 기반).

시뮬레이션의 각 날(운영일 번호)이 **평일 / 주말 / 휴일** 중 무엇인지 플레이어가 직접 정하는 독립 패널이다. 엔진의 운영일력 계약(`transitline.operational-calendar/1`, `engine/src/operational-calendar.mjs`)을 그대로 쓰고 새 규칙을 만들지 않는다. 기존 파일은 하나도 바꾸지 않았다(`scenario-runtime.mjs`, `main.mjs`, 엔진 상태 코드 포함).

## 규칙 (엔진의 것 그대로)

- 달력은 `dayTypesByOperatingDay`에 **플레이어가 이름 붙인 날만** 담는다. 나머지 날은 엔진의 기본 규칙(월~금 평일, 토·일 주말; 운영일 0번이 월요일)을 따른다.
- 공휴일은 추정하지 않는다. **휴일은 플레이어가 그날을 '휴일'로 지정했을 때만 생긴다.** 이 패널에는 공휴일 목록·자동 채우기·실제 달력 날짜 변환이 없다(운영일 번호는 실제 날짜와 연결되어 있지 않다).
- 휴일 시간표는 달력에 휴일이 하나라도 있어야 개통·dispatch된다(`calendarSupportsDayType`). 패널은 "휴일 지정이 있는가"만 보여 주고, 시간표를 개통할 수 있는지는 엔진이 판단한다.

## 구분해서 보여 주는 것

| 상태 | 화면 |
|---|---|
| 달력이 아예 없음(`null`) | "엔진의 달력: 없음 (null)" / "초안: 달력 없음 (null)" |
| 달력은 있으나 이름 붙인 날이 0일 | "달력 있음 — 명시한 날 0일" (`{}`) — `null`과 다르다. 비운 초안은 `null`이 아니라 빈 달력이고 엔진과 다르다고 표시됨 |
| 미지정인 날 | "미지정 → 기본 규칙에 따라 평일/주말" (항목 없음) |
| 기본 규칙과 같은 값을 직접 지정한 날 | "명시: 평일 (기본 규칙과 같음)" — 미지정과 다르다(항목이 있다) |
| 기본 규칙과 다르게 지정한 날 | "명시: 휴일", 토요일을 "명시: 평일" 등 |

각 줄의 `select`는 `미지정(기본 규칙) / 평일 / 주말 / 휴일`이다. 미지정을 고르면 항목이 지워진다.

## Mount API

```js
import { mountOperationalCalendarPanel } from "./operational-calendar-panel.mjs";

const panel = mountOperationalCalendarPanel({
  container,                                                    // 필수
  getCalendar: () => runtime.operationalState.operationalCalendar ?? null,   // 필수. 엔진의 현재 달력(없으면 null)
  onApply: (calendar) => { /* 호스트가 엔진에 적용 */ },          // 필수. calendar는 완성된 달력 또는 null
  getCurrentDay: () => Math.floor(runtime.operationalState.simMinutes / 1440),   // 선택. 현재 운영일 번호
  getSaveIdentity: () => ({ packId, packVersion }),             // 선택. 이 게임(저장본)을 가리키는 식별 정보
});
panel.refresh();            // 엔진의 달력·현재 날을 다시 읽는다
panel.serialize();          // 초안 문서(JSON 문자열)
panel.loadDoc(text);        // -> { ok, issues }
panel.draft / panel.applied / panel.dirty
panel.showDay(day);         // 그 날이 있는 주로 이동
```

패널은 **엔진을 받지 않는다.** 엔진을 바꾸는 유일한 곳은 호스트의 `onApply`이고, "엔진에 적용" 버튼을 눌렀을 때만 불린다(편집·새로고침·불러오기는 엔진 상태를 바꾸지 않는다 — 테스트가 상태 직렬화 동일을 확인).

### host가 `onApply`에서 할 일

`ScenarioRuntime`에는 달력을 바꾸는 메서드가 아직 없다. 호스트는 엔진의 기존 함수를 쓰면 된다.

```js
import { setOperationalCalendar } from "./operational-calendar.mjs";
onApply: (calendar) => setOperationalCalendar(runtime.operationalState, calendar)   // { calendar, warnings } 를 돌려줌
```

`setOperationalCalendar`가 돌려주는 `{ warnings }`를 그대로 반환하면 패널이 "엔진 경고"로 보여 준다. 던지면 패널이 오류를 보여 주고 초안을 그대로 둔다. `state.operationalCalendar`는 통합 저장에 이미 포함된다(운영 상태의 모든 키가 복제됨). 나중에 runtime에 전용 메서드가 생기면 그것으로 바꾸면 된다.

### refresh 시점

패널은 스스로 갱신하지 않는다(타이머 없음). 호스트가 `refresh()`를 부른다: 패널을 열 때, 저장본을 불러온 직후, 시뮬레이션 시간이 하루 넘어갈 때(현재 날 표시 갱신). **손대지 않은 초안은 엔진의 달력을 따라가고, 편집한 초안은 그대로 유지**되며 엔진과의 차이가 줄마다 표시된다. 엔진의 달력을 읽지 못하면 "달력 없음"으로 바꾸지 않고 마지막으로 읽은 값을 두고 경고한다.

## 초안 문서와 다른 저장본 거부

```json
{ "schema": "transitline.operational-calendar-draft/1", "version": 1,
  "identity": { "packId": "tokyo", "packVersion": "1" },
  "calendar": { "schema": "transitline.operational-calendar/1", "contractVersion": 1, "dayTypesByOperatingDay": { "10": "holiday" } } }
```

- `calendar`가 `null`이면 "달력 없음" 초안이다(빈 달력 `{}`과 다르게 저장·복원됨).
- `loadDoc`은 문서의 `identity`가 현재 `getSaveIdentity()`와 **같을 때만** 받는다. 다른 팩/버전이면 `calendar-draft-other-save`, 한쪽만 식별 정보가 없으면 `calendar-draft-save-unverifiable`(같은 게임인지 알 수 없으므로), 둘 다 없으면 서로만 받는다. 식별 정보로 무엇을 넣을지는 호스트가 정한다(팩 id·버전 외에 시나리오 id나 시드를 넣으면 더 엄격해진다).
- 항목이 하나라도 올바르지 않으면(날짜가 음수·소수·`"01"`, 종류가 셋 중 하나가 아님, 형식이 다름) 문서 전체를 거절하고 현재 초안은 그대로다.
- 불러온 초안은 **적용되지 않는다.** 엔진은 그대로이고 "엔진에 아직 적용하지 않은 변경"으로 표시된다.
- 저장은 호스트 몫이다(localStorage 없음).

## 화면 구성

엔진 달력 요약(경고 포함) → 초안 요약과 숫자(휴일/평일/주말 지정 수, 엔진과 다른 날, 새로 지정·바꿈·지정 해제) → 휴일 지정 여부 → 버튼(엔진에 적용 / 초안 되돌리기 / 달력 없음으로) → 28일 창(이전·다음 4주, 현재 날로, 번호로 이동) → 범위 지정(처음~끝 날, 최대 366일) → 직접 지정한 날 목록(처음 100개, 줄마다 지정 해제). 클래스는 `opcal-*`이고 스타일은 호스트가 입힌다.

## 한계

- 이미 지난 날도 편집할 수 있다. 달력을 바꿔서 이미 지나간 날의 dayType이 달라졌을 때 dispatch 기록이 어떻게 되는지는 엔진의 일이며 이번에 검증하지 않았다. 미래 날을 지정하는 용도로 쓰는 것이 안전하다.
- 운영일 번호와 실제 날짜의 연결이 없으므로 실제 공휴일을 도와줄 수 없다(의도적).
- `ScenarioRuntime`에 전용 적용 메서드가 없어 호스트가 엔진 함수를 직접 부른다.
- 초안은 한 벌뿐이다(여러 초안 보관 없음).

## 검증

`node --test engine/test/operational-calendar-panel.test.mjs` — 21개: 달력 없음에서 아무것도 휴일이 아님, 창·이동·요일 이름, 미지정/명시/기본과 같은 명시/휴일 구분, `null`과 빈 달력 구분, 범위 지정과 거부, 편집 중 엔진 불변, 적용 때만 호스트 호출(정규 형식·엔진 경고 없음·엔진이 그 날을 휴일로 판단), `null` 적용과 빈 달력 적용, 호스트 오류·무시, 새로고침(손대지 않은/편집한 초안), 엔진 달력의 잘못된 항목 경고, 읽기 실패 유지, 문서 왕복·**다른 저장본 거부**·잘못된 문서 전체 거절, 동결 입력·복사본, 소스 검사(엔진·저장소·타이머·시계·난수·공휴일 목록 없음).

변이 확인: 다른 저장본 허용, 빈 달력을 `null`로 합침, 기본값과 같은 지정을 지움, 주말을 휴일로 미리 채움, 읽기 실패를 "달력 없음"으로 바꿈 — 각각 해당 테스트가 실패하는 것을 확인하고 되돌렸다.

headless Chrome(실제 DOM 이벤트): 휴일 지정, 범위 지정, 주 이동, 적용, 엔진 달력 확인(경고 0, `operationalDayTypeAtDay`가 지정대로), 다른 저장본 문서 거부, 저장한 초안 다시 불러오기, 잘못된 JSON 거부, 달력 없음 적용. 콘솔 오류 0, localStorage/sessionStorage 접근 0, 타이머 0.
