# B17-M2 시간표 실제 운행 상세 패널

`engine/src/railway-timetable-operation-panel.mjs` (+ `engine/test/railway-timetable-operation-panel.test.mjs` 20개). 기준 master `c0aa82b`.

플레이어가 "왜 이 시간표가 실제로 안 나갔는지", "레거시 운행인지", "저장 이후 무엇이 미상인지"를 읽을 수 있게, **B17-E1 보고서만** 읽어서 상세하게 보여 주는 독립 패널이다. B17-M1 지도 모듈(`map/railway-timetable-operation-*.mjs`)은 건드리지 않았고 기능을 겹쳐 만들지도 않았다(지도는 그리기, 이 패널은 사실의 상세 목록).

## 하지 않는 것

엔진 명령 호출, 저장, localStorage, 자동 새로고침(타이머·폴링), 시간표·배차·지연·비용·수요·혼잡 계산, 사실을 판정으로 바꾸기. 패널은 runtime을 **받지 않는다** — 받는 것은 보고서를 돌려주는 함수 하나뿐이라 구조적으로 명령을 부를 수 없다(소스 검사로 확인). 유일하게 기억하는 것은 플레이어가 고른 읽기 전용 필터이며 저장하지 않는다.

## Mount API

```js
import { mountRailwayTimetableOperationPanel } from "./railway-timetable-operation-panel.mjs";

const panel = mountRailwayTimetableOperationPanel({
  container,                                              // 필수. DOM 요소(ownerDocument를 쓴다)
  getReport: () => runtime.railwayTimetableOperationReport(),   // 필수. B17-E1 보고서(transitline.railway-timetable-operation-report/1)
});
panel.refresh();                         // getReport()를 다시 불러 그린다
panel.setFilter({ timetableId });        // 또는 { lineId } 또는 null(전체)
panel.filter;                            // 현재 필터 { timetableId } | { lineId } | null
panel.report;                            // 지금 보여 주는 보고서의 복사본(없으면 null)
```

마운트 시 던지는 오류: `container` 없음, `getReport`가 함수가 아님. `getReport`가 던지거나, 객체가 아니거나, 다른 형식(`schema`)을 주면 패널은 그 이유만 보여 주고 다른 것은 보여 주지 않는다.

## host가 refresh할 시점

패널은 스스로 갱신하지 않는다(타이머 없음). 필터를 바꿔도 보고서를 다시 읽지 않는다(화면이 일관되게 같은 보고서를 보도록). 호스트가 다음에 `panel.refresh()`를 부른다.

- 패널을 열 때
- 시간표를 심사·승인·개통·철회한 직후(수명주기 패널의 `onChange`)
- 저장본을 불러온 직후
- 시뮬레이션이 진행되는 동안 보고 싶다면 호스트가 정한 주기로(예: 1초). 읽기만 하므로 상태는 바뀌지 않지만 열차가 많으면 보고서를 만드는 비용이 든다.

연결 예:

```js
timetableOperationPanel = mountRailwayTimetableOperationPanel({
  container: $("scenario-timetable-operation"),
  getReport: () => runtime.railwayTimetableOperationReport(),
});
// 수명주기 패널 onChange / 불러오기 뒤: timetableOperationPanel.refresh()
```

## 화면

| 구역 | 내용 (모두 보고서의 값 그대로) |
|---|---|
| 요약 | 스키마, 엔진 시각, `status`, 입력이 없을 때의 이유(`unavailable`), 상태별 시간표 개수(활성·승인됨·심사됨·철회됨·대체됨·기타), dispatch 수, 열차 구성(시간표/출처 미기록 예정/레거시 빈도, 운행 중/위치 미상/done) |
| 필터 | "시간표 보기"와 "노선 보기" 선택. 하나를 고르면 다른 쪽은 해제 |
| 시간표 카드 | 생애주기 상태(active / approved / assessed / withdrawn / superseded), 요일 유형, 엔진 판정, 요청·수락·거절 경로 수, 대상 서비스, 생애주기 시각(심사·승인·활성·대체·철회), 철회 직전 상태, 실제 운행 연결(dispatch 수·노선·놓친 출발), 이 시간표의 지금 열차, **완료한 열차 수** |
| dispatch 카드 | 노선·요일 유형·시간표·서비스, 예정 출발(하루 횟수·출발 분), **놓친 출발**, **막힘 사유**, **노선 정지**, 마지막 확인 시각 |
| 노선 카드 | 경영 서비스, 정지, 엔진이 기록한 운행 통계(개수), 지금 열차 구성 |
| 열차 카드 | **출처(provenance)**, 시간표 ID, 경영 서비스 ID, 예정 출발·완료, 상태, **위치 미상 이유**, 구간 번호·방향·진행도, 신호 대기 이유·보류 해제 시각 |
| issues | 코드 + 보고서가 준 필드를 `이름: 값`으로 그대로. "판정이 아님" 안내 |
| limits | 보고서의 `id`와 `text`를 **원문 그대로**. 아는 id에는 짧은 한국어 설명을 덧붙임 |

열차는 처음 50대, issues는 처음 100개까지 보이고 나머지는 개수만 말한다(필터로 좁혀 볼 수 있다).

## 결측 표시 규칙

| 보고서 값 | 화면 |
|---|---|
| `null` | `미상`, 이유가 있으면 `미상 (이유 코드 — 한국어 설명)` |
| `0` | `0` |
| `false` / `true` | `아니오` / `예` |
| `[]` | `빈 목록` |
| 키 자체가 없음 | `미상` |
| 목록 전체가 `null`(보고서에 포함 안 됨) | "(보고서에 포함되지 않음)" + 이유. 빈 목록 `[]`("표시할 … 없음(빈 목록)")과 다르다 |
| 이유가 없는 상태 필드의 `null`(막힘 사유, 신호 대기, 생애주기 시각) | E1이 "기록 없음/아직 일어나지 않음"을 뜻하는 필드이므로 `엔진에 기록된 막힘 사유 없음`, `기록 없음`, `없음 (아직 일어나지 않았거나 기록되지 않음)` |

완료한 열차 수는 항상 `미상 (finished-trains-are-removed-and-traffic-counters-are-per-line — …)`로 나온다(엔진이 끝난 열차를 지우고 통계가 노선 단위라서). 엔진이 `0`으로 기록한 값은 `0`으로 나온다.

## 열차 출처를 섞지 않는다

| `provenance` | 화면 | 시간표 ID |
|---|---|---|
| `timetable` | 시간표 열차 (timetableId 기록됨) | ID |
| `scheduled-provenance-unrecorded` | 예정 열차이나 출처 미기록 (B17-E0 이전 저장본) | 미상 + `dispatched-against-a-schedule-but-the-provenance-was-not-recorded` |
| `legacy-frequency` | 레거시 빈도 열차 (시간표 없이 노선 빈도로 운행) | 미상 + `dispatched-by-line-frequency-not-by-a-timetable` |

레거시 열차에는 "출처 미기록"이라는 말이, 출처 미기록 열차에는 "레거시"라는 말이 나오지 않는다(테스트).

## 필터 규칙 (읽기 전용 · 보고서는 바뀌지 않음)

- 시간표 `T`: `T`의 카드, `timetableId === T`인 dispatch·열차, 그 dispatch·열차가 있는 노선 행, `T`를 이름으로 가졌거나 그 열차를 가리키는 issue.
- 노선 `L`: `L`의 dispatch·열차·노선 행, 그 dispatch·열차가 가진 시간표 카드(`dispatchLineIds`에 `L`이 있는 것 포함), `L`을 가리키거나 그 열차를 가리키는 issue.
- 선택한 ID가 보고서에 없으면 "선택한 … 는 이 보고서에 없습니다"만 보이고 다른 것을 대신 보여 주지 않는다. 새로 고쳐도 필터는 유지되며 사라진 ID는 같은 문구로 표시된다.

## 한계

- E1 보고서의 한계가 그대로 이 패널의 한계다: 시간표별 완료 열차 수 없음, dispatch별 놓친 출발 카운터는 dispatch가 다시 적용될 때(저장본 불러오기 포함) 처음부터 다시 셈, 놓친 이유 없음, 지금 선로 위의 열차만 나옴. 패널은 이 내용을 `limits`에서 원문으로 보여 준다.
- "왜 안 나갔나"에 대한 **결론**은 내지 않는다. 시간표 상태, dispatch 유무, 막힘 사유, 노선 정지, 놓친 출발, 지금 열차 수를 나란히 보여 줄 뿐이다.
- 알려진 이유 코드·issue 코드·limit id에만 한국어 설명이 있다. 모르는 코드는 원문 그대로 나온다.
- 스타일이 없다(`style.css` 금지). 클래스는 `ttop-*`이며 호스트가 입힌다.
- 시각은 엔진의 분을 소수 둘째 자리까지 다듬어 `…분`으로 쓴다(표시만, 값은 같다).

## 검증

`node --test engine/test/railway-timetable-operation-panel.test.mjs` — 20개. 보고서는 실제 `ScenarioRuntime`에서 만든 것(다섯 상태, 활성 시간표의 열차, 레거시/출처 미기록 열차, 위치 미상·done·신호 대기)과 실제 E1 빌더에 합성 상태를 넣어 만든 것(null/0/false/[] 구분, 두 노선·두 시간표 필터)을 쓴다. 마운트·새로고침·필터 변경에서 엔진 명령 0회와 보고서 읽기 횟수, 동결 보고서 불변, 복사본 반환, 결정성, 소스 검사(저장소·타이머·시계·난수·runtime 이름 없음, import는 E1 스키마 이름 하나).

변이 확인: null을 0으로, false를 미상으로, 빈 목록을 미상으로, 레거시 설명을 출처 미기록 설명으로, 필터가 열차를 무시, issue에 판정 낱말 추가 — 각각 해당 테스트가 실패하는 것을 확인하고 되돌렸다.

headless Chrome: 실제 `ScenarioRuntime`(다섯 상태 시간표, 열차 2대)에 마운트해 필터 변경까지 확인. 콘솔 오류 0, localStorage/sessionStorage 접근 0, 타이머 0, 엔진 명령 0, 저장·시간표 보고서가 필터 조작 전후로 동일.
