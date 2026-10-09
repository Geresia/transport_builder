# B19-M3 신도시 개발 생애주기 관리 패널 — 인수 문서

플레이어가 신도시 개발의 생애주기(B19-E1)를 지도의 개발(B19-M2)과 맞춰 보고, **버튼을 눌렀을 때만** 런타임에 명령을 보내는 **독립 패널**이다. 기준은 master `b6f893c`. `main.mjs`·`index.html`·`style.css`·`management/**`·`scenario-runtime.mjs`·`map/**`는 건드리지 않았다. 호스트(Codex)가 아래 "연결 예"대로 붙이면 된다.

## 파일

| 파일 | 역할 |
|---|---|
| `engine/src/new-town-development-management-ui.mjs` | `mountNewTownDevelopmentManagementPanel` — DOM, 입력 초안, 버튼→런타임 호출, serialize/loadDoc |
| `engine/src/new-town-development-management-view.mjs` | 순수 표시 모델 `buildNewTownManagementView` (지도 export·E1 기록·assess·E2 후보를 개발별 행으로 묶음) |
| `engine/test/new-town-development-management-ui.test.mjs` | 18개 (실제 `ScenarioRuntime` + B19-M1 실제 export) |

import는 형제 `./이름.mjs`뿐(`new-town-demand-candidates.mjs`, 서로), 각 파일 40 KB 미만, `management/`·`scenario-runtime`·`localStorage`·`sessionStorage`·시계·난수·네트워크 이름이 없다(소스 검사 테스트).

## mount API

```js
import { mountNewTownDevelopmentManagementPanel } from "./new-town-development-management-ui.mjs";

const panel = mountNewTownDevelopmentManagementPanel({
  container,                 // 패널이 들어갈 DOM 요소 (패널이 자기 <style>을 한 번 넣는다)
  runtime,                   // ScenarioRuntime (또는 ManagementGame) — 아래 11개 메서드가 있어야 한다
  getGeometryExport,         // () => B19-M2 output().export  (transitline.new-town-development-export/1)
  onChange,                  // (event) => {}   선택 { kind: "ui", selectedRowKey } / 명령 성공 { kind: "command", action, recordId, developmentId, status }
});
```

필요한 runtime 메서드: `newTownDevelopmentReport`, `assessNewTownDevelopment`, `newTownDevelopmentHooks`(읽기 전용 3개)와 `draftNewTownDevelopment`, `proposeNewTownDevelopment`, `agreeNewTownDevelopment`, `startNewTownServicing`, `recordNewTownOccupancy`, `delayNewTownDevelopment`, `resumeNewTownDevelopment`, `cancelNewTownDevelopment`(명령 8개).

| 반환 | 하는 일 |
|---|---|
| `refresh()` | 지도 export와 런타임을 **읽기만** 해서 다시 그린다. 호스트가 런타임을 직접 바꾸거나 지도가 바뀐 뒤 부른다 (타이머 없음) |
| `select(rowKey)` / `deselect()` | 행을 펼침/접음. 없는 행이면 `false` |
| `selectedRowKey` | 현재 펼친 행 (`record:<기록 id>` 또는 `map:<developmentId>`) |
| `view()` / `output()` | 표시 모델 복사본 / `{ view, selectedRowKey }` |
| `serialize()` / `loadDoc(doc)` | **UI 선택 상태와 쓰던 입력 초안만**. 런타임 기록은 런타임 save가 맡는다 |
| `destroy()` | 컨테이너를 비우고 멈춘다. 이후 늦은 클릭은 아무것도 보내지 않는다 |

### 연결 예 (Codex)

```js
const newTown = mountNewTownDevelopment({ canvas, projection, pack, getMapExport, getSpatial, onChange: () => managePanel.refresh() });   // B19-M2
const managePanel = mountNewTownDevelopmentManagementPanel({
  container: document.getElementById("newTownManagement"),
  runtime: scenarioRuntime,
  getGeometryExport: () => newTown.output().export,
  onChange: (e) => { if (e.kind === "command") saveRuntime(); },     // 런타임 상태는 호스트가 runtime.save()로 저장
});
// 저장 문서(선택·입력 초안)는 호스트가 원하는 곳에 둔다
const uiDoc = managePanel.serialize();           // 다른 팩/스키마 문서는 loadDoc이 거절하고 아무것도 바꾸지 않는다
managePanel.loadDoc(uiDoc);
// 시나리오가 런타임을 load한 뒤에는 managePanel.refresh()
```

## 행과 지도 대조

행은 **생애주기 기록 하나**, 또는 **지도에는 있고 살아 있는(취소 안 된) 기록이 없는 개발 하나**다. `developmentId`로 지도와 기록을 이어 붙인다. 지도 대조는 런타임의 `assessNewTownDevelopment({ id, geometry }).geometry` 결과를 그대로 쓰고, 팩 비교만 더한다.

| `mapState` | 뜻 | 근거 |
|---|---|---|
| `no-record` | 지도에 있음 · 생애주기 기록 없음 | 기록 없음 (초안 만들기 버튼) |
| `current` | 현재 지도와 같음 | assess `current` |
| `stale` | 낡음 (revision·단계·팩 버전이 기록과 다름) | assess `stale` |
| `inactive` | 지도에서 꺼져 있음 | assess `inactive` |
| `other-pack` | 다른 팩의 기록 | 기록의 `sourcePack.packId` ≠ export의 `packId`, 또는 assess 사유 `geometry-source-pack-changed` |
| `map-missing` | 현재 지도에 없음 | 같은 `developmentId`가 export에 없음 (또는 export를 못 읽음) |
| `invalid` | 지도 geometry를 쓸 수 없음 | assess `invalid` |

런타임의 말(`stale — geometry-revision-changed` 등)도 항상 같이 보여 준다. export를 못 읽으면(없음·스키마 불일치·던짐) 사유(`geometry-export-not-provided` …)를 그대로 쓰고 모든 기록은 `map-missing`이다.

## 단계 전환 — 버튼과 호출

각 줄은 `버튼 + 막힘 사유`다. 사유는 `assessNewTownDevelopment`가 돌려준 `blockers` **문자열 그대로**이고, 막힘이 있으면 버튼이 닫히며 그 단계의 입력 폼은 보이지 않는다. 패널은 자기 판정이나 기본값이 없다.

| 버튼 | 호출 | 입력 (빈 칸은 보내지 않거나 `null`) |
|---|---|---|
| 초안 만들기 (지도만 있는 행) | `draftNewTownDevelopment({ geometry, name?, parties? })` | 이름, 지자체/개발자: 적지 않음(미상) · 이름 명시 `{partyId?, name?}` · 없음 명시 `{absent:true}` |
| 제안(propose) | `proposeNewTownDevelopment({ id, geometry })` | — |
| 합의(agree) | `agreeNewTownDevelopment(id, { burdens, connectionConditions?, parties? }, { geometry })` | 부담 항목(항목 ID, 부담 주체 체크 3종, 금액 JPY, 메모), 연결 조건(적지 않음→생략 / 없음으로 선언→`[]` / 조건을 적음→목록), 당사자(기록대로 둠→생략 / 이름 / 없음) |
| 서비스 시작 | `startNewTownServicing(id, { geometry, phaseIds? })` | 단계 체크 (고르지 않으면 `phaseIds`를 보내지 않아 런타임 규칙에 따름) |
| 입주 사실 기록 | `recordNewTownOccupancy(id, phaseId, facts, { geometry })` | 단계, `statedOccupiedUnits`, `statedPlannedUnits`, `unit`, `source`, 메모 |
| 지연(delay) | `delayNewTownDevelopment(id, reason)` | 사유 |
| 재개(resume) | `resumeNewTownDevelopment(id, { geometry })` | — |
| 취소(cancel) | `cancelNewTownDevelopment(id, reason)` | 사유 |

- **0 / null / []**: 숫자 칸이 비면 `null`(적지 않음), `"0"`은 `0`. 연결 조건은 "적지 않음"=`null`(생략), "없음으로 선언"=`[]`, 목록=목록. 화면에도 `null(적지 않음)` / `0` / `[] (없음으로 선언)`로 구분해 쓴다. 숫자로 읽히지 않는 글자(`abc`, `-5`, `12.5`)는 UI가 막지 않고 런타임에 보내 그 오류를 그대로 보여 준다.
- **보내기 직전 재확인**: 버튼을 누르면 `getGeometryExport()`를 **다시 읽고** `assess`를 **다시 물어** 막힘이 있으면 명령을 보내지 않고 `막힘 — … 명령을 보내지 않았습니다.` + 사유를 보여 준다. 그려진 뒤에 지도가 바뀌어 낡아졌거나 닫힌 버튼에 클릭이 들어와도 낡은 geometry는 전진하지 못한다. 지연·취소는 지도를 요구하지 않는다(런타임 규칙 그대로).
- **런타임 오류**: 던져진 메시지를 `런타임 오류(원문): …`로 그대로 보여 준다. 런타임은 트랜잭션으로 되돌리므로 기록은 바뀌지 않고, 쓰던 입력도 그대로 남는다. `onChange`는 성공한 명령에만 `command`를 보낸다.
- 명령이 성공하면 `onChange({ kind: "command", … })`가 한 번 온다. 초안 만들기 뒤에는 새 기록 행이 선택된다.

## E2 후보 (읽기 전용)

`buildNewTownDemandCandidates({ hooks: runtime.newTownDevelopmentHooks(id), geometry })`를 행마다 읽고 **`후보 대조(E2)` 상태, 단계별 `completeness`(complete/incomplete/blocked), `eligibleForB15`(true/false/`null(미상)`)만** 보여 준다. 입력한 수량·단위는 후보 줄에 나오지 않는다. 입주 사실이 없는 단계는 "후보 없는 단계"로 적는다. B15에 적용하지 않고 수요 노드를 만들지 않으며, E2의 `notComputed` 목록을 그대로 적는다. E2 입력 문법상 `unit`이 정확히 `residents` 또는 `jobs`인 사실만 후보가 되므로 입주 사실 폼에 그 안내를 적어 두었다.

## 하지 않는 것

수요·인구·비용·입주율·승객·운임·혼잡의 계산·추정·표시, 자체 단계 판정이나 기본값, B15 적용, `localStorage`/`sessionStorage`, 타이머(자동 새로 고침 없음), `main.mjs`/`index.html`/`style.css` 수정. 패널 글에는 그런 낱말이 없다(테스트가 모든 상태의 글을 검사).

## 검증

- 단위 테스트 18개: mount 시 명령 0회(읽기 3종만, 런타임 save 동일, 현금 불변), 인자 검사, 상태 6종 구분, 기록 없음/취소 뒤 행, **클릭만으로 전체 흐름이 직접 API와 같은 기록**(+ hooks 동일), 막힘 사유 원문 일치(모든 행·단계), 낡은 geometry 불전진, 런타임 오류 원문과 상태 불변, 0/null/[] 구분, E2 후보 표시와 geometry 추종, serialize/loadDoc 왕복과 다른 문서 17종 거부(상태 불변), 소스 규칙, frozen 입력 불변·결정성·복사본, export 문제, 금칙어, destroy, 서비스 단계 지정, 런타임 save/load 뒤 표시.
- 실제 headless Chrome(실제 `ScenarioRuntime` + 실제 M1 export): 마우스 클릭·키 입력으로 초안 → 제안 → 합의 → 서비스 시작 → 입주 사실 → (빈 입력 오류 원문) → 지도 변경 후 낡은 채 클릭(명령 안 나감) → 재읽기 → 지연 → 낡은 채 재개 불가 → 지도 복원·재읽기 → 재개 → 취소. 콘솔 오류 0, 저장소 사용 0.

## 한계

- 초안의 `links`(연결 계획·역 부지·서비스 계획 id)와 `phaseSupply`(단계별 적어 둔 공급량)는 입력 폼이 없다(`null`로 남는다). 합의의 `connectionConditions` 안 `linkedStationSiteId`/`linkedServicePlanId`는 직접 입력한 id 문자열이다.
- 지도가 한 번 낡으면 E1에는 기록을 새 revision에 다시 잇는 API가 없다. 지도를 기록된 revision으로 되돌리거나 취소 뒤 새 초안을 만드는 수밖에 없다 (패널은 이 둘만 보여 준다).
- 초안 생성+제안을 한 번에 하는 `proposeNewTownDevelopment` 형태는 쓰지 않는다(초안 → 제안 두 번 클릭).
- E3(철도 기여 합의)는 이 패널의 범위가 아니다.
