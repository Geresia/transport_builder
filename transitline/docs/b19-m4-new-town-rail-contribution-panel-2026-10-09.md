# B19-M4 신도시 철도 분담금 관리 패널 — Codex 인수 문서

`engine/src/new-town-rail-contribution-management-panel.mjs` (+ `engine/test/new-town-rail-contribution-management-panel.test.mjs` 16개). 기준 master `b6f893c`.

B19-E3 분담금 엔진을 **버튼 클릭으로만** 조작하는 독립 패널이다. 분담금 계약을 읽어 사실 그대로 보여 주고(`newTownRailContributionReport`), 엔진이 단계마다 무엇이 막는지 말한 것(`assessNewTownRailContribution`)과 안정 ID(`newTownRailContributionHooks`)를 옮겨 적는다. 패널은 금액·현금·원장을 계산하거나 고치지 않고, `main.mjs`·`index.html`·`style.css`·`management/**`·`scenario-runtime.mjs`·`map/**`를 바꾸지 않았다(아무것도 import하지 않음).

## Mount API

```js
import { mountNewTownRailContributionManagementPanel } from "./new-town-rail-contribution-management-panel.mjs";

const panel = mountNewTownRailContributionManagementPanel({
  container,                                   // 필수
  runtime,                                     // ScenarioRuntime (읽기 3 + 명령 8 메서드를 가진 것)
  getGeometryExport: () => newTownDevelopmentOutput.export,   // B19-M1 export (transitline.new-town-development-export/1)
  getNewTownDevelopments: () => runtime.newTownDevelopmentReport(),   // B19-E1 개발 기록 목록
  getCurrentLinks: () => ({ planIds: [...], stationSiteIds: [...] }), // 호스트가 말하는 "지금 있는" 계획·역 부지 ID
  onChange: () => {},                          // 명령이 성공한 뒤에만 호출
});
panel.refresh();                // 다시 읽어 그린다 (명령 없음)
panel.select(id);               // 자세히 볼 계약 선택
panel.serialize();              // 선택 + 초안 입력만 담은 문자열
panel.loadDoc(textOrObject);    // → { ok, issues }  (명령 없음)
panel.results();                // 화면에 있는 것의 복사본 (계약 ID, 상태, 연결 사실, 엔진 판정, hooks)
```

마운트 시 던지는 오류: `container` 없음, 세 getter 중 하나가 함수가 아님, `runtime`에 `newTownRailContributionReport` / `assessNewTownRailContribution` / `newTownRailContributionHooks`가 없음.

호스트가 채울 값:

| 인자 | 무엇 | 비고 |
|---|---|---|
| `getGeometryExport` | M1 `buildNewTownDevelopmentExport` 결과 (`developments[]`) | `main.mjs`에서는 `newTownDevelopmentUi.output().export`. 읽을 수 없으면(던지거나 객체가 아님) 패널은 "geometry 없음"으로 엔진에 전달한다 |
| `getNewTownDevelopments` | E1 개발 기록 배열 | 초안 양식의 개발 선택지와 "E1 개발 기록" 연결 표시에만 쓴다. 통과 여부는 엔진이 자기 기록으로 정한다 |
| `getCurrentLinks` | `{ planIds, stationSiteIds }` | 지도의 현재 서비스 계획 ID들, 현재 역 부지 ID들(M1 `stationSiteRefs[].stationId`와 같은 공간). `null`/던짐이면 엔진이 "확인할 수 없음"으로 막는다. 연결 프로젝트는 엔진이 게임의 projects에서 직접 확인한다 |
| `onChange` | 콜백 | draft/propose/agree/fund/release/delay/resume/terminate **성공 뒤에만**. 실패·마운트·refresh·loadDoc에는 호출하지 않는다 |

### host가 refresh할 시점

스스로 갱신하지 않는다. 호스트가 `refresh()`를 부른다: 패널을 열 때, 지도 편집으로 geometry export가 바뀐 뒤, E1 개발 기록을 바꾼 뒤(제안·합의·취소 등), 저장본을 불러온 뒤, 연결 프로젝트가 바뀐 뒤. 화면의 "엔진 판정 다시 읽기" 버튼도 같은 일을 한다(명령 아님).

## 엔진 호출 (모두 버튼 클릭에서만)

| 버튼 | 호출 | 입력 |
|---|---|---|
| 초안 만들기 | `runtime.draftNewTownRailContribution(input)` | 폼의 값 전부. **기본값 없음**: 개발 기록·부담자·수령자·목적을 고르지 않으면 호출하지 않고 이유를 보여 준다 |
| 제안 | `proposeNewTownRailContribution(id, {geometry, currentLinks})` | |
| 합의 | `agreeNewTownRailContribution(id, terms, ctx)` | `terms`: 금액 칸을 채웠을 때만 `statedAmountYen`, 조건을 바꿨을 때만 `conditions`. 비워 두면 초안 값 유지 |
| 지급 확정 기록 | `fundNewTownRailContribution(id, {confirmedAmountYen, confirmedBy, reference}, ctx)` | 금액은 직접 입력(합의 금액을 미리 채우지 않음) |
| release | `releaseNewTownRailContribution(id, {geometry, currentLinks, conditionConfirmations})` | 체크한 조건만 `{conditionId, note?}`로 보냄 |
| 지연 / 재개 / 종료 | `delay…(id, reason)` / `resume…(id, ctx)` / `terminate…(id, reason)` | 이유는 직접 입력 |

`geometry`는 지도 export에서 **같은 `developmentId`인 개발 하나**를 그대로(복사해서) 보낸다. 없거나 둘 이상이면 보내지 않는다(엔진이 `geometry-missing`). revision·팩이 달라도 **고쳐서 보내지 않고 그대로** 보내 엔진이 `geometry-stale` 등으로 막게 한다.

읽기: `newTownRailContributionReport()`, `assessNewTownRailContribution({id, geometry, currentLinks, conditionConfirmations?, confirmation?})`, `newTownRailContributionHooks(id)`뿐이다. 마운트·refresh·select·serialize·loadDoc·다시 읽기 버튼은 명령을 한 번도 부르지 않는다(테스트가 프록시로 센다).

## 화면

| 구역 | 내용 |
|---|---|
| 안내 | 범위 안내(`SCOPE_NOTICE`): 직접 입력한 값만 쓰고 면적·인구·수요로 금액을 계산하지 않음 |
| 초안 양식 | 개발 기록(E1) · 부담자/수령자/목적 선택 · 금액(숫자만) · 이름 · 연결 단계/프로젝트/계획/역 부지 각각 `미명시(null)`/`없음으로 명시([])`/`목록 입력` + 조건(한 줄에 `조건ID: 내용`) |
| 계약 카드 | 계약 ID · 개발 기록 ID · 개발 ID(지도) · 개발 revision · 팩 · 부담자→수령자 · 목적 · 금액 · 연결 단계 · 연결 프로젝트/계획/역 부지 · 조건 |
| 지도·개발 기록 연결 | 지도 geometry의 revision·팩 ID·팩 버전 일치/다름/미상, 활성 여부, E1 기록의 상태·개발 ID·revision·팩 일치 여부 — **표시만**, 통과 여부는 엔진 |
| 단계 사실 | 합의 / 지급 확정(현금 아님) / release(원장 반영됨 또는 반영 안 함+이유) / 지연 / 종료 |
| 엔진 판정 | 지금 할 수 있는 단계마다 "지금 가능" 또는 "막힘" + 엔진 blockers(한국어 설명 + 코드 병기, 모르는 코드는 그대로) + release 효과(엔진의 `releaseEffect` 그대로) |
| 실행 | 상태에 맞는 단계만 버튼과 입력칸이 있다. 엔진이 막고 있어도 버튼은 눌린다(눌러서 엔진의 거절 이유를 본다. 막힌 버튼엔 `engine-blocked` 클래스) |
| release | 안내(`RELEASE_NOTICE`): 원장에 한 번 반영될 수 있는 유일한 단계 / 조건마다 체크박스(처음엔 모두 해제) + 메모 / 엔진 판정 |
| 자세히 | 선택한 카드: 마지막으로 받아들인 시점의 개발 상태, hook ID, 단계 hook ID, 원장 연결, 이력, 계산하지 않는 것 |

### null / 0 / []

| 값 | 문구 |
|---|---|
| 금액 `null` | `미명시(null) — 금액을 말하지 않음` |
| 금액 `0` | `0엔 — 0으로 명시함` |
| 금액 n | `3,000,000,000엔` (표시용 쉼표뿐, 입력은 쉼표 불가) |
| 연결 단계 `null` / `[]` | `미지정(null) — 개발 전체` / `연결 단계 없음으로 명시함([])` |
| 연결 목록 `null` / `[]` | `미명시(null)` / `없음으로 명시함([])` |
| 조건 `null` / `[]` | `조건 미명시(null)` / `조건 없음으로 명시함([])` |

### 종결 상태

`released`(`release 완료 — 종결`)와 `terminated`(`종료 — 종결`)는 카드에 종결 안내만 있고 **실행 버튼도 엔진 판정도 없다**. 엔진도 이 상태에서는 모든 단계를 `status-not-allowed`로 거절한다.

## 금액 입력

숫자만(`/^\d+$/`, 안전한 정수 범위). 쉼표·소수점·부호·계산식·전각 숫자는 거절하고 엔진을 부르지 않는다. 비우면 `미명시(null)`, `0`은 명시된 0. 패널은 신도시 면적·용도·인구·수요·입주 사실을 읽지 않는다(소스 검사로 확인).

## 저장 문서 (`serialize` / `loadDoc`)

`transitline.new-town-rail-contribution-panel-doc/1`: `{schema, version: 1, selectedContributionId, draft: {…}}`. **선택과 초안 입력만** 담고(계약·금액 사실·이력은 없음, 엔진이 가진다), 초안 입력은 문자열이다. 읽을 수 없는 문서·다른 스키마·알 수 없는 필드·문자열이 아닌 값은 문서 전체를 거절하고 현재 화면은 그대로다. 엔진을 부르지 않는다. 패널은 localStorage/sessionStorage를 쓰지 않으니 저장은 호스트가 이 문자열을 보관한다.

## 호스트가 알아야 할 것

- 스타일은 없다(`style.css` 금지). 클래스는 `ntrc-*`이고 호스트가 입힌다(`ntrc-card`, `ntrc-status`, `engine-blocked`, `ntrc-release-form`, `ntrc-terminal` 등).
- 텍스트 입력은 변경 시 다시 그리지 않고(버튼 클릭을 놓치지 않으려고) 버튼·체크박스·선택 때만 다시 그린다. 다시 그려도 입력한 값은 유지된다. 입력을 바꾼 뒤의 엔진 판정은 "엔진 판정 다시 읽기"를 눌러야 갱신된다.
- 패널은 연결 프로젝트가 있는지, 계획·역 부지가 현재인지를 스스로 판단하지 않는다. `getCurrentLinks`와 엔진이 한다.

## 검증

- 단위 16개(가짜 DOM + 실제 `ScenarioRuntime`): 마운트·refresh·select·serialize·loadDoc·다시 읽기에서 명령 0회와 엔진 snapshot 불변, 버튼 클릭만으로 draft→propose→agree→fund→release와 현금·원장 변화 시점(release에서만 1회), 같은 release 버튼 두 번 클릭 거절, 종결 상태 표시, null/0/[] 문구, 금액 입력 거절 10가지와 기본값 없음, stale·다른 팩·팩 버전·비활성·팩 없음·geometry 없음·export 읽기 실패·취소된 개발 차단과 엔진 blockers 표시(클릭 경로로 엔진이 거절한 문구 포함), 조건 확인 정확히 한 번씩, 연결 대상 확인, release 효과 4종, 실패 트랜잭션 롤백(스냅샷 바이트 동일)과 재시도, delay/resume/terminate, 연결 사실 표시, 저장 문서 엄격성, 입력 유지, 얼린 입력, 소스 검사(import·저장소·타이머·엔진 내부·금액 산술 없음, 명령 8개와 읽기 3개만, 명령은 클릭 경로에서만).
- 변이 확인 9개(+보강 후 재확인): 조건 자동 확인, 쉼표 금액 허용, 부담자 기본값, null 금액을 0으로 표시, 지도 revision이 다르면 geometry를 숨겨 전달, 초안 양식 미초기화, 지급 확정 금액 자동 채움, 비어 있는 목록을 "없음"으로 처리, 종결 안내 삭제 — 각각 테스트가 실패하는 것을 확인하고 되돌렸다. 처음에 살아남은 두 변이(쉼표 금액, 지도 숨김)는 테스트를 정확하게 고쳐 잡았다.
- 개발 중 테스트가 패널 버그 하나를 잡았다: 비워 둔 합의 금액이 `null`로 보내져 엔진이 `amount-not-stated`로 막았다(비워 두면 아무것도 보내지 않도록 수정).
- headless Chrome(실제 DOM·실제 `element.click()`·실제 `ScenarioRuntime`) 36개 항목 모두 통과: 전체 생애주기, release 1회 원장 반영과 낡은 버튼 재클릭 거절, 지도 stale/다른 팩/비활성에서 propose 거절, 실패 트랜잭션의 스냅샷 바이트 동일과 재시도, null/0/[] 문구, 종결 상태 버튼 없음, 저장 문서 왕복. 콘솔 오류 0, storage 접근 0, 타이머 0.

## 한계

- 합성 개발·예제 geometry로만 확인했고 `main.mjs` 연결은 하지 않았다.
- 토지 가격·사업성·수요 변환·금액 추정은 없다(E3의 경계와 같다). 엔진에 없는 제한 자금(escrow) 개념도 만들지 않았다.
- 한 번에 그리는 카드 수 제한은 없다.
