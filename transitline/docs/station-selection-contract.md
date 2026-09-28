# 역 선택 브리지 (지도 → 역 UI)

지도에서 역 후보·출입구·환승통로·작업장을 고르고, 고른 것을 **ID만** 내보내는 독립 API다. 고른 항목은 지도에서 강조하고, 경영 엔진이 돌려준 공사 상태·오류를 **읽기 전용**으로 함께 보여 준다. 비용·기간·점수·공법·보상·낙찰은 계산하지 않고 `management`를 import하지도 않는다(테스트가 검사). `main.mjs`·`index.html`·`style.css`를 고치지 않아도 붙는다.

## 코드 (모두 `engine/src/map/`)

| 파일 | 역할 |
|---|---|
| `station-selection.mjs` | 순수 코어: 선택 상태, 선택 동작, 출력, 저장 복원, 클릭 판정 |
| `station-selection-view.mjs` | 강조 모델, 캔버스 그리기, 엔진 상태·오류 읽기 전용 패널 |
| `station-selection-ui.mjs` | 브라우저 마운트 `mountStationSelection()`: 자체 오버레이 캔버스·패널·`<style>`을 만든다 |

## 출력 `transitline.station-selection/1`

```js
{ schema, contractVersion: 1, packId,
  stationSiteId,            // 고른 역 후보 (없으면 null)
  selectedEntranceIds[],    // entranceId, 정렬됨
  selectedTransferIds[],    // transferId, 정렬됨
  selectedWorkAreaId,       // workAreaId | null (하나만)
  connectedPlanId, connectedStationId }   // 그 후보가 연결된 계획 역 (확인용 복사)
```

- ID는 `StationSiteGeometry`([station-site-contract.md](station-site-contract.md))의 `stationSiteId`/`entranceId`/`transferId`/`workAreaId` 그대로다. 후보 문서를 저장하고 다시 열어도 같아서 저장한 선택을 `restore()`로 되살릴 수 있다.
- 출력에는 엔진이 계산한 값이 없다. 고른 순서와 무관하게 같은 선택은 같은 출력이다.

## 선택 규칙

- 항목은 한 역 후보에 속한다. 다른 역을 고르거나 다른 역의 항목을 누르면 그 역으로 옮기고 기존 하위 선택은 비운다.
- 출입구·환승통로: 그냥 누르면 그것만, **Shift/Ctrl/⌘**는 추가·해제. 이미 하나만 골랐다면 다시 눌러 해제. 작업장은 하나만(다시 누르면 해제).
- 고른 역의 본체를 다시 누르면 역만 남기고 하위 선택을 비운다. 빈 곳을 누르면(추가 키 없이) 전부 해제, Esc도 같다.
- 내보내기에서 사라진 항목(삭제한 출입구, 사라진 역)은 `pruneSelection()`이 떨어뜨리고 `selected-…-missing` 경고를 낸다.
- 클릭 우선순위: 출입구 > 환승통로 > 작업장 > 역 본체. 멀리 줌아웃해 역이 몇 픽셀일 때 중심을 누르면 역이 잡히도록, 본체 위에서는 출입구·통로가 중심보다 **가까울 때만** 이긴다.

## 엔진 상태·오류 표시 (읽기 전용)

`getOverlay()`가 주는 오버레이 모델(엔진 보고서로 만든 것)에서 고른 역과 관련된 것만 읽는다.

- `construction`: 공사 상태(계획/심사 중/공사 중/공사 중단/사업 취소/검사 중/사용 가능, 지연·진행률은 엔진이 준 값)
- `status`: 불가/조건부/승인/공사 중/완공 (역 후보 표시와 같은 규칙)
- `errors[]`: 그 역·그 역에 닿는 구간·계획 전체에 붙은 엔진 위반·누락 입력·경고(`scope: station|segment|plan`)
- `mapNotes[]`: 지도 쪽 결측 정보(엔진 것과 분리)
- 계획 역에 연결되지 않은 후보, 보고서가 없을 때는 `linked: false`/`null`이다. 지도가 상태를 추정하지 않는다.
- 항목(출입구·통로·작업장)별 엔진 판정은 엔진이 주지 않으므로 표시하지 않는다.

## 붙이는 법

```js
import { mountStationSelection } from "./map/station-selection-ui.mjs";
const bridge = mountStationSelection({
  canvas, projection,
  getStationExport: () => stationUi.stationExport,   // 역 편집기의 내보내기
  getOverlay: () => state.mapOverlay,                // 엔진 상태 오버레이 모델
  onChange: (output) => { /* 선택 출력 */ },
});
bridge.output(); bridge.view(); bridge.select("entrance", id, { additive: true });
bridge.clear(); bridge.restore(savedOutput); bridge.setEnabled(false); bridge.destroy();
```

- 같은 출력이 캔버스의 DOM 이벤트 `transitline:station-selection`(`detail` = 출력)으로도 나가므로 import 없이 들을 수 있다.
- 켜져 있는 동안 캔버스의 포인터를 가져간다(캡처 단계). 다른 도구(노선 그리기, 역 편집기)를 쓸 때는 `setEnabled(false)`.
- 엔진 상태가 늦게 도착해도 200 ms 주기로 다시 그린다(`autoRefreshMs`, 0이면 `refresh()`를 직접 호출).
- 순수 코어만 쓰려면 `station-selection.mjs`와 `station-selection-view.mjs`만 import하면 된다(`drawStationSelection(ctx, view, screen)`).

## 한계

- 선택은 메모리에만 있다. 저장하려면 출력을 호스트가 보관하고 `restore()`로 되살린다.
- 강조는 별도 캔버스라 호스트 렌더 순서와 무관하게 맨 위에 그려진다. 화면 확대·이동이 생기면 `refresh()`가 필요하다(현재 투영은 창 크기 변경에만 바뀐다).
- 지도가 만든 결측(`mapNotes`)은 엔진 오류가 아니다. 엔진 오류만 "오류 있음" 칩에 반영된다.
