# B14-M13 지도 관제선택 → 철도 관제명령 발령 패널 인계

작성일: 2026-10-05. 대상: `main.mjs`에 연결할 작업자(Codex). 기준 커밋 `de04cfd`.

M7 `RailwayServiceControlGeometry`와 플레이어가 지도에서 고른 후보를 읽어, 실제 `ScenarioRuntime.issueRailwayControlSelection(...)`을 호출하는 독립 관리 패널이다. 비용·시간·운행 가능 여부·우회 효과는 계산하지도 추정하지도 않는다. 유효성, 구간 매핑, 회차 가능성, null 접속 확인은 전부 엔진이 최종 판정하고 엔진 오류는 문구 그대로 보여 준다. `main.mjs`/`index.html`/`style.css`/`scenario-runtime.mjs`/`management/**`/`map/**`와 기존 M5~M12 파일은 수정하지 않았다.

## 파일

- `engine/src/railway-service-control-management-ui.mjs` — 마운트와 순수 뷰 빌더
- `engine/test/railway-service-control-management-ui.test.mjs` — 15개 (가짜 DOM, 스파이 runtime, 실제 `ScenarioRuntime` 발령·종료·저장복원)

## mount API

```js
import { mountRailwayServiceControlManagementPanel } from "./railway-service-control-management-ui.mjs";

const panel = mountRailwayServiceControlManagementPanel({
  container,                  // 필수
  runtime,                    // 필수. 아래 3개 메서드가 없으면 던진다
  getServiceControlOutput,    // M7 stage.output()
  onChange,                   // 발령이 성공한 뒤에만 호출
});
panel.refresh();              // 외부 상태가 바뀌면 호출 (패널은 폴링하지 않는다)
```

사용하는 runtime 메서드: `issueRailwayControlSelection`, `railwayControlOrderReport`, `railwayDisruptionReport`. (회수 `clearRailwayControlOrder`는 호출하지 않는다.)

`getServiceControlOutput()`은 M7 `bridge.output()`의 모양을 읽는다: `{ controls, selections, document }` (`controls` 대신 `export.controls`도 받는다).

- `controls[]`: `transitline.railway-service-control-geometry/1` (이벤트마다 하나)
- `selections[eventId]`: `{ turnback, partialSuspension, detour, evacuation }` 후보 ID 목록 (활성 항목만)
- `document.controls[].selected[kind][].designedControlGeometryRevision`: 선택이 이루어진 revision. 있으면 현재 revision과 비교해 오래된 선택을 걸러 낸다. 없으면 이 검사는 건너뛴다.

순수 헬퍼 `buildRailwayServiceControlView({ controls, selections, document, events })`도 export한다.

## 엔진 호출 payload

```js
runtime.issueRailwayControlSelection({
  eventId,
  controlGeometry,                    // 복사본
  controlGeometryRevision,            // controlGeometry.controlGeometryRevision
  selection,                          // selections[eventId] 복사본
  confirmUnknownPhysicalAttachment,   // 아래 규칙
});
```

`confirmUnknownPhysicalAttachment`는 선택된 회차 후보 중 `physicalAttachment === null`이 있고 플레이어가 "미확인 접속을 인지함"을 체크했을 때만 `true`다. 체크는 정확히 그 선택(이벤트·revision·선택 후보)에만 묶이며, 선택이 바뀌면 해제된다.

## 화면 흐름과 규칙

1. 장애 이벤트별로 관제 geometry id/revision, 엔진이 보고한 이벤트 상태, 선택한 부분운휴 후보(구간 수, 운휴 길이 — 모르면 "미상")와 회차 후보(접속 ● true / ✕ false / ? null)를 보여 준다. "정확히 1개여야 하며 최종 검증은 엔진"이라는 안내가 붙는다.
2. **발령 버튼은 다음일 때만 켜진다:** 관제 geometry가 현재 형식이고, 엔진 이벤트가 진행 중(`active`/`responding`)이며, 부분운휴 선택이 있고, 선택이 현재 geometry에 아직 있고 현재 revision 위에서 이루어졌을 때. 아니면 경고만 표시하고 엔진은 호출하지 않는다. (경고 코드: `control-geometry-missing|invalid`, `event-unknown`, `event-not-ongoing`, `selection-missing|stale|outdated`.)
3. 지도 사실 `physicalAttachment === false`는 그대로 "분리(false)"로 표시한다. 체크박스를 주지 않고 발령 가능으로 바꾸지도 않는다. 버튼은 남기므로 엔진의 거부 문구("physically detached")가 그대로 보인다.
4. 엔진 오류는 그대로 표시하고 `onChange`는 부르지 않는다. 엔진은 발령 실패 시 상태를 원자적으로 되돌린다.
5. 관제명령 목록(`railwayControlOrderReport()`): 발령 중/종료, 종류, 잔존 운행구간(`A→B / C→D`), 운휴 선로, 제외 역, 발령·종료 시각(시뮬레이션 분), 종료 사유, 가정(`assumptions`)을 읽기 전용으로 보여 준다. 수정·회수 버튼은 없다.
6. 우회·대피 선택은 "보존만 되며 발령에 쓰이지 않는다"고 안내한다 (엔진도 아직 실행하지 않는다).

## Codex가 main.mjs에 연결할 방법

```js
railwayServiceControlManagement = mountRailwayServiceControlManagementPanel({
  container: $("scenario-railway-service-control"),            // index.html에 새 컨테이너 필요
  runtime,
  getServiceControlOutput: () => mapInputPipeline?.stages.serviceControl.output() ?? { controls: [], selections: {} },
  onChange: () => queueMicrotask(() => { refreshMapOverlay(); refreshScenarioPanel(); }),
});
```

- `main.mjs`의 기존 M11 연결처럼 `canvas`의 `pointerup` 뒤 `queueMicrotask`에서 `railwayServiceControlManagement?.refresh()`를 같이 불러야 지도에서 후보를 고를 때 목록이 따라온다. 틱이 이벤트를 끝내거나 명령을 종료시키므로 `refreshScenarioPanel()` 쪽에서도 `refresh()`가 필요하다.
- 최상위 `pipeline.output()`은 `serviceControls`(= M7 export)만 담고 플레이어의 선택(`selections`/`document`)은 담지 않는다. 그래서 M11처럼 stage의 `output()`을 직접 읽어야 한다.
- 스타일은 포함하지 않았다. 클래스: `control-notice`, `control-empty`, `control-field`, `control-metrics`/`control-metric`, `control-warning <code>`, `control-label`, `control-selected attachment-true|false|null`, `control-note`, `control-check`, `control-actions`, `control-error`, `control-section`, `control-order active|ended`, `control-assumptions`.
- 컨테이너의 `ownerDocument`를 쓰고 `textContent`만 사용한다 (HTML 삽입 없음).

## 저장

이 모듈은 `localStorage`/`sessionStorage`를 읽지도 쓰지도 않고 어떤 상태도 따로 저장하지 않는다 (테스트로 확인). 관제명령은 runtime 통합 저장(`snapshotOperationalState`)이 유일한 진실이며, 실제 `ScenarioRuntime`으로 발령 → 종료 → 저장 → 복원 후 새 패널이 같은 명령을 표시하는 것까지 시험했다. 체크박스·선택한 이벤트 같은 폼 상태는 마운트 클로저에만 있다. 입력(M7 출력, 엔진 report)은 읽기만 하고 엔진에는 복사본을 넘긴다.

## 남은 한계

- 발령 가능 여부의 패널 쪽 조건은 "표시용 사전 조건"일 뿐이다. 진행 중 이벤트·현재 revision이어도 구간 매핑, 회차 경계 일치, 한 노선당 활성 명령 1개 같은 판정은 엔진이 하고, 실패하면 오류가 그대로 나온다.
- 선택된 부분운휴가 정확히 1개가 아니어도 (2개 이상) 버튼은 켜진다. 최종 검증은 엔진에 맡겼고 오류가 표시된다. 0개일 때만 "선택 누락"으로 막는다.
- 오래된 선택 검사는 M7 `document`가 함께 오는 경우에만 동작한다. `selections`만 넘기면 revision 검사는 못 한다 (엔진의 revision 검사는 항상 동작).
- 이 패널은 관제명령을 **회수(종료)하지 못한다.** 장애가 끝나면 엔진이 자동으로 종료시키고 목록에 "종료"로 나온다. 수동 회수 UI는 범위 밖이다.
- 우회·대피 후보는 발령되지 않는다. 우회는 M11 패널이 별도로 다룬다.
- 시각 확인은 headless Chrome에서 스텁 runtime으로 한 번 했다 (미확인 접속 거부 → 체크 → 발령, payload 키, 저장소 미사용). 실제 게임 화면 안의 배치·스타일 확인은 `main.mjs` 연결 뒤에 해야 한다.
