# B18-M3 운영일·시간표 커버리지 패널

`engine/src/operational-service-coverage-panel.mjs` (+ `engine/test/operational-service-coverage-panel.test.mjs` 17개). 기준 master `0c56381`.

B18-E4 커버리지 보고서를 **읽기만 해서** 현재 운영일과 요일 유형, 노선마다 지금 열차가 어디서 나오는지(시간표 / 기존 빈도 운행 / 운휴 / 운행선 아님 / 미상)를 보여 주는 독립 패널이다. 기존 파일은 하나도 바꾸지 않았다.

## 실제 E4 계약에 맞춘 통합

초기 패널은 E4가 커밋되기 전에 작성되어 필드명을 가정했다. 통합 시 실제
`transitline.operational-service-coverage-report/1` 계약으로 맞췄다. 패널은 이제
`currentDay`, `currentDayType`, `currentDayTypeSource`, `lineSuspended` 및
`no-operational-line`을 읽는다. 이전 `operatingDay`, `dayType`,
`not-service-line` 어댑터는 제공하지 않는다.

## 작성 당시의 계약 가정 (통합 전 기록)

이 모듈을 만들 때 B18-E4 보고서는 master에도 `b18-e4-service-coverage-report` 브랜치에도 아직 없었다(브랜치는 master와 같은 커밋이고 작업 파일도 없었다). 지시문에는 `dispatchSource`의 다섯 값과 표시 항목만 있었기 때문에 **필드 이름은 이 문서가 가정한 것**이다. 이름이 다르면 E4 쪽을 아래에 맞추거나, 이 패널의 읽는 곳(모듈 머리말 표와 `lineCard`/`header`)을 고치면 된다. 필드를 읽는 곳은 그 두 군데뿐이다.

### 패널이 읽는 보고서 (`transitline.operational-service-coverage-report/1`)

| 필드 | 값 | 없을 때 |
|---|---|---|
| `schema` | 위 문자열 (다르면 보고서 전체 거부) | |
| `currentDay` | 0 이상의 정수 또는 `null` (그 밖의 값이면 거부) | `미상` |
| `currentDayType` | `weekday` / `weekend` / `holiday` / `null` (그 밖의 문자열은 원문 그대로) | `미상` |
| `currentDayTypeSource` | 문자열 또는 `null` — 요일 유형이 어디서 왔는지 | 줄 자체를 안 보여 줌 |
| `lines` | 행의 목록, 또는 `null`(보고서에 노선이 없음). 목록도 `null`도 아니면 거부 | |
| 행 `operationalLineId`, `name` | | `미상` |
| 행 `dispatchSource` | `timetable` / `legacy-frequency` / `suspended` / `no-operational-line` / `unknown` | 없거나 `null`이면 `미상`, 다른 코드면 "알 수 없는 원천 코드: …" |
| 행 `timetableId` (+`timetableIdReason`) | 문자열 또는 `null` | `미상` + 이유 |
| 행 `timetableDayType`, `serviceStatus` | 문자열 / `null`(`serviceStatus`는 없으면 줄을 안 보여 줌) | `미상` |
| 행 `managementServiceId` (+`…Reason`) | | `미상` + 이유 |
| 행 `lineSuspended` | `true` / `false` / `null` | `미상` |
| 행 `legacyFrequency` | 아무 값(선택) | 줄을 안 보여 줌. 있으면 JSON 그대로 |
| `issues`, `limits` | 선택. `issues`는 `{code, …}`, `limits`는 `{id, text}`의 목록 | 없으면 구역을 안 보여 줌 |

## Mount API

```js
import { mountOperationalServiceCoveragePanel } from "./operational-service-coverage-panel.mjs";

const panel = mountOperationalServiceCoveragePanel({
  container,
  getReport: () => coverageReport,        // B18-E4 보고서. 패널은 runtime을 받지 않는다
});
panel.refresh();                          // getReport()를 다시 불러 그린다
panel.setFilter({ dispatchSource, timetableId });   // 읽기 전용 필터
panel.filter;                             // 현재 필터
panel.report;                             // 지금 보여 주는 보고서의 복사본(없으면 null)
```

마운트 시 던지는 오류: `container` 없음, `getReport`가 함수가 아님. `getReport`가 던지거나 보고서가 위 표를 어기면 **이유 한 줄만** 보이고 다른 것은 그리지 않는다.

패널은 runtime을 받지 않으므로 엔진 명령을 부를 수 없고(소스 검사로 확인), 저장소·타이머가 없고, 시계·난수를 읽지 않으며, B17 시간표 운행 보고서나 `timetableDispatches`·열차 목록을 다시 계산하지 않는다. 필터는 화면 상태일 뿐 어디에도 저장하지 않는다.

### host가 refresh할 시점

스스로 갱신하지 않는다. 호스트가 `refresh()`를 부른다: 패널을 열 때, 운영 캘린더를 적용한 직후(B18-M2 `onApply` 뒤), 시간표를 심사·승인·개통·철회한 직후, 저장본을 불러온 직후, 시뮬레이션 시간이 하루 넘어갈 때. 필터를 바꾸는 것만으로는 보고서를 다시 읽지 않는다.

## 화면

| 구역 | 내용 |
|---|---|
| 오늘 | 현재 운영일 번호, 오늘의 요일 유형(평일 / 주말 / 휴일, 원문 코드 병기), 있으면 요일 유형의 출처 |
| 요약 | 표시한 노선 수, 배차 원천별 노선 수(0도 `0`), "원천 코드를 알 수 없음", "휴일인데 시간표 없이 기존 빈도로 운행"하는 노선 수 |
| 필터 | 배차 원천(다섯 값 + 보고서에 있는 알 수 없는 코드), 시간표(시간표 ID들 + "(시간표 없음)") — 둘을 함께 쓰면 둘 다 만족하는 행 |
| 노선 카드 | 현재 배차 원천(한국어 + 코드), 원천의 이유, 시간표 ID, 시간표의 요일 유형, 시간표 상태, 경영 서비스, 노선 정지, 노선에 설정된 기존 빈도 |
| issues / limits | 보고서의 것을 원문 그대로(issues는 "판정이 아님" 안내) |

노선은 처음 100개까지 보이고 나머지는 개수만 말한다. 객체가 아닌 항목은 건너뛰고 개수를 알린다.

### 휴일인데 시간표가 없을 때

`dayType`이 `holiday`이고 행이 `legacy-frequency`이며 `timetableId`가 `null`이면, 그 줄에 다음 안내가 붙는다(보고서의 두 사실을 겹쳐 보여 주는 것이며 새로 계산한 값이 아니다).

> 오늘은 휴일인데 이 노선에는 시간표가 없어, 엔진이 기존 노선 빈도(frequency)로 열차를 내고 있다는 것이 보고서의 사실입니다. 이 화면은 그 운행이 얼마나 충분한지(서비스 품질·수송력·비용·혼잡)를 추정하지 않습니다.

평일·주말이거나 요일 유형이 `null`이면 붙지 않는다(미상을 휴일로 보지 않는다). 시간표가 있는 `legacy-frequency` 행이나 운휴 행에도 붙지 않는다. 그 밖에 시간표의 요일 유형과 오늘의 요일 유형이 다르게 보고되면 "보고서 값 그대로" 양쪽을 나란히 적는다 — 이유나 옳고 그름은 말하지 않는다.

## 결측 표시 규칙

| 값 | 화면 |
|---|---|
| `null` / 없음 | `미상` (이유가 있으면 `미상 (코드 — 설명)`) |
| `0` | `0` |
| `false` / `true` | `아니오` / `예` |
| `[]` | `빈 목록` |
| 객체 | JSON 그대로(`{}`는 `{}`) |
| `lines: null` | "노선 목록이 보고서에 포함되지 않았습니다" — 빈 목록 `[]`("보고서에 노선이 없습니다(빈 목록)")과 다르다 |

## 한계

- 보고서 계약이 가정이다(위). E4가 확정되면 필드 이름을 맞춰야 한다.
- 알려진 이유 코드는 3개뿐이고 나머지는 원문으로 나온다.
- 패널은 보고서가 말하는 것만 보여 준다: 기존 빈도 운행의 양이나 충분함, 시간표의 수송력, 비용, 혼잡은 모른다.
- 스타일이 없다(`style.css` 금지). 클래스는 `cov-*`이며 호스트가 입힌다.
- `main.mjs`에는 연결하지 않았다.

## 검증

`node --test engine/test/operational-service-coverage-panel.test.mjs` — 16개: 다섯 `dispatchSource` 전부와 개수, 알 수 없는/없는 원천 코드, 운영일·요일 유형(평일/주말/휴일/미상/모르는 값), 시간표 ID·요일 유형·상태·이유, 휴일 대체 운행 안내(휴일 아님·시간표 있음·운휴·요일 유형 미상에는 안 붙음), null/false/0/빈 목록 구분, 필터(원천·시간표·"시간표 없음"·결합·해제·새로고침 유지), issues/limits 원문, 긴 목록과 읽을 수 없는 항목, **잘못된 보고서 거부**(12가지), 동결 입력 불변·복사본·결정성, 추정 낱말·숫자 없음, 소스 검사(저장소·타이머·시계·난수·runtime 이름·import 없음).

변이 확인: null을 0으로, false를 미상으로, 빈 목록을 미상으로, 휴일 조건 제거, 모르는 코드를 다섯 중 하나로 취급, 잘못된 스키마 허용, 시간표 필터 무시 — 각각 해당 테스트가 실패하는 것을 확인하고 되돌렸다.

headless Chrome(실제 선택·이벤트): 다섯 원천이 한국어+코드로 표시, 필터 조합, "시간표 없음" 필터, 휴일→평일 갱신 시 안내가 사라짐, 잘못된 스키마 거부. 콘솔 오류 0, localStorage/sessionStorage 접근 0, 타이머 0.
