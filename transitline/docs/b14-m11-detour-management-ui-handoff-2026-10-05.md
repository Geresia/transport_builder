# B14-M11 우회철도 운행 관리 패널 인계

작성일: 2026-10-05. 대상: `main.mjs`에 연결할 작업자(Codex). 기준 커밋 `eea403c`.

M10(지도)에서 만든 `RailwayDetourServiceGeometry`와 플레이어의 선택(picks)을 받아, 플레이어가 우회운행을 **검토 → 승인 → 임시 운행 시작**하는 독립 패널이다. 판정·비용·호환성·운행 가능 여부는 하지도 추정하지도 않는다. 엔진이 돌려준 값을 그대로 보여 준다. `main.mjs`/`index.html`/`style.css`/`scenario-runtime.mjs`/`management/**`/`map/**`는 수정하지 않았다.

## 파일

- `engine/src/railway-detour-management-ui.mjs` — 마운트와 순수 뷰 빌더
- `engine/test/railway-detour-management-ui.test.mjs` — 14개 (가짜 DOM, 스파이 runtime, 실제 `ScenarioRuntime` 전 과정)

## mount API

```js
import { mountRailwayDetourManagementPanel } from "./railway-detour-management-ui.mjs";

const panel = mountRailwayDetourManagementPanel({
  container,                         // 필수. 패널을 채울 요소
  runtime,                           // 필수. ScenarioRuntime (아래 5개 메서드가 없으면 던진다)
  getDetourOutput,                   // M10 bridge.output() -> { export: { detours }, picks }
  getExternalInfrastructureCatalog,  // (geometry) => 이 우회안의 buildExternalInfrastructureCatalog 결과 (없으면 null)
  getTrackAccessAgreements,          // 선택. 선로사용 계약 목록
  onChange,                          // 승인/운행 시작이 성공한 뒤 호출 (저장 시점으로 쓰면 된다)
});
panel.refresh();                     // 외부 상태(엔진 시계, M10 출력)가 바뀌면 호출
```

사용하는 runtime 메서드는 이 5개뿐이다: `assessRailwayDetourAuthorization`, `authorizeRailwayDetour`, `railwayDetourAuthorizationReport`, `startRailwayDetourOperation`, `railwayDetourOperationReport`. (정산 `settleRailwayDetourOperations`와 시간 진행은 이 패널이 호출하지 않는다.)

순수 헬퍼 `buildRailwayDetourManagementView({ detours, picks, authorizations, operations })`도 export한다 (DOM 없이 표시 데이터를 시험할 수 있다).

## 화면 흐름

1. **우회 목록·상태.** eventId, geometry revision, 우회 거리(알 수 없으면 "미상"), 선택 구간/접속 수, 접속별 상태(● true / ✕ false / ? null)와 간격(없으면 "미상"). "지도에서 그린 선은 접속 사실을 바꾸지 않는다"는 안내가 항상 나온다.
2. **입력.** 관제명령 ID(텍스트), 차량 모델, 시간당 운행횟수, 선로사용 계약(체크), "접속 미확인 확인", "조건부 기술호환 확인".
3. **사전 검토.** `assessRailwayDetourAuthorization` 결과를 그대로 표시: possible/conditional/unknown/impossible, 그리고 위반(violations)·누락 정보(missingInputs)·조건(conditions)을 따로 나열. 엔진이 던진 오류는 문구 그대로 표시한다.
4. **승인.** 검토 결과가 `possible`일 때만 버튼이 켜지고 `authorizeRailwayDetour`를 **검토와 같은 payload**로 호출한다. 같은 관제명령에 중복 승인이면 엔진 오류("already has an authorized detour")가 그대로 보인다. 입력을 바꾸거나 geometry revision이 바뀌면 검토 결과는 폐기되고 승인 버튼이 꺼진다.
5. **임시 운행 시작.** 상태가 `authorized`인 승인만 고를 수 있고 `startRailwayDetourOperation({ authorizationId })` — 키가 `authorizationId` 하나뿐이다. 운행 상태, 누적 열차-km, **정산된** 운행비·선로사용료, 종료 사유는 `railwayDetourOperationReport()`의 값을 읽기 전용으로 보여 준다. "실제 시간표·열차 경로는 M5~M7 연결 뒤에 확장된다"는 안내가 항상 나온다.

## Codex가 main.mjs에 연결할 방법

```js
const runtime = /* 이미 있는 ScenarioRuntime */;
const detourBridge = /* M10 mountRailwayDetourService(...) 결과 */;
mountRailwayDetourManagementPanel({
  container: document.getElementById("detour-management"),   // 새 컨테이너가 필요하다 (index.html 수정)
  runtime,
  getDetourOutput: () => detourBridge.output(),
  getExternalInfrastructureCatalog: (geometry) => catalogForRoute(geometry.throughRouteId),
  getTrackAccessAgreements: () => runtime.game.trackAccessAgreements,
  onChange: () => saveIntegrated(),                           // 통합 저장 호출
});
```

- M10 `onChange`/`transitline:railway-detour-service` 이벤트 안에서 `panel.refresh()`를 부르면 지도 선택이 바뀔 때 목록이 따라온다. 게임 루프 틱이 상태를 바꾸므로(운행 종료, 누적 거리) 일정 주기 또는 tick 후 `refresh()`도 필요하다. 패널은 스스로 폴링하지 않는다.
- 스타일은 포함하지 않았다. 클래스 이름: `detour-notice`, `detour-empty`, `detour-field`, `detour-metrics`/`detour-metric`, `detour-connection state-true|false|null`, `detour-check`, `detour-actions`, `detour-result`, `detour-error`, `detour-assessment <verdict>`, `detour-diag detour-violations|missingInputs|conditions`, `detour-authorization <status>`, `detour-operation <status>`. `style.css`에 맞춰 입히면 된다.
- 컨테이너의 `ownerDocument`를 쓰므로 iframe/가짜 DOM에서도 동작한다.

## 필요한 getter와 저장 주의점

- 승인, 운행, 비용, 계약 상태는 **엔진 통합 저장이 유일한 진실**이다. 이 모듈은 `localStorage`/`sessionStorage`를 읽지도 쓰지도 않는다 (테스트로 확인). 폼 입력(선택한 차량, 운행횟수, 체크 상태)은 마운트 클로저에만 있고 새로고침하면 사라진다 — 의도된 것이다.
- 패널은 입력(`getDetourOutput`, 카탈로그, 계약)을 복사해서 엔진에 넘기며 원본을 바꾸지 않는다.
- `getTrackAccessAgreements`를 주지 않으면 요청에 `trackAccessAgreements` 키를 넣지 않으므로 runtime이 자기 `game.trackAccessAgreements`로 대신한다. 이때는 계약 목록이 화면에 나오지 않고 계약 체크도 할 수 없다 (엔진은 해당 소유자·운영자 계약이 하나뿐이면 자동으로 맞춘다).

## 미구현 한계

- **관제명령 ID는 손으로 입력한다.** M9 geometry에는 `controlOrderId`가 없다 (`eventId`·`controlGeometryId`만 있다). 허용된 5개 API에는 관제명령 목록 조회가 없어서 패널이 대신 찾지 못한다. 나중에 geometry나 호스트가 힌트를 주면(`controlOrderId`) 입력칸이 미리 채워진다. 엔진이 모르는 ID면 오류가 그대로 보인다.
- 차량 모델 목록은 `VEHICLE_MODELS`(읽기만)에서 온다. 각 모델이 우회 구간과 호환되는지는 엔진만 판정한다.
- **누적 미정산액은 표시하지 않는다.** 운행 report에는 정산된 금액(`settled*`)과 누적 열차-km/분만 있고, 미정산액 계산은 `railwayDetourSettlementDue`의 몫이다. UI가 열차-km에서 금액을 계산하면 규칙을 이중으로 갖게 되어 하지 않았다. 정산 버튼도 이 패널에 없다 (`settleRailwayDetourOperations`는 허용된 API 목록 밖).
- 열차 경로·시간표는 없다 (M5~M7 연결 뒤). 이 패널이 보여 주는 운행은 누적 거리·비용 기록뿐이다.
- 접속은 대부분 `null`(미확인)이다. 기존선은 선형이 없어 지도 사실이 없다. 플레이어는 "접속 미확인 확인"으로 진행할 수 있지만, 소유자·용량·기술사양 결측은 확인으로 넘어갈 수 없다 (엔진 규칙).
- 브라우저 확인은 headless Chrome에서 스텁 runtime으로 한 번 했다 (select 값 유지, 입력 시 검토 폐기, 승인·시작 payload, 오류 표시). 실제 게임 화면 안에서의 시각 확인은 `main.mjs` 연결 뒤에 해야 한다.
