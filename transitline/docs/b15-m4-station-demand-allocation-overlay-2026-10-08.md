# B15-M4 역 접근권 수요 배정 지도 overlay — Codex 인수 문서

이미 적용된 `runtime.stationDemandAllocationReport()`(B15-E4/E5)를 **읽기 전용으로** 지도에 보여 주는 독립 mount와 view API. 기준은 B15-E5 커밋 `0b2ec64`(분수 배정 `splitNodes`가 있는 보고서)다. 브랜치 `b15-m4-allocation-overlay`.

## 경계

- **읽기 전용이다.** 편집·저장(localStorage 포함)·상태 변경이 없다. 클릭은 노드를 맞혔을 때만 가져가 그 노드의 상세를 보여 주고, 그 밖의 클릭은 지도로 흘려 보낸다.
- 수요, 혼잡, 운임, 비용, 점수, **걸음 시간을 계산하지 않는다.** 비율은 **정책이 정한 예상 몫**이며 실제 승객을 만들거나 세지 않는다(점선 링크의 굵기와 "예상 60%"는 몫의 표시일 뿐이다). 엔진이 링크에 적어 둔 걸음 분은 "엔진의 걸음 N분"으로 **그대로 옮겨 적기만** 한다.
- **null / 0 / false를 섞지 않는다.** 값이 `null`이면 "미상"이고, `0`이면 "0"이며, 보고서가 말하지 않은 것은 그리지도 쓰지도 않는다. 위치를 모르는 노드·역은 지도에 놓지 않고 패널에 "위치를 모르는 것은 그리지 않습니다"로 적는다(경고 코드 `position-unknown-nodes|stations|sites`).
- `main.mjs`, `index.html`, `style.css`, `scenario-runtime.mjs`, `management/**`는 건드리지 않았다. `engine/src/map/`의 새 모듈은 `./map-mount-kit.mjs`와 서로만 import한다(테스트로 고정: management·엔진 상태·시계·난수·저장소 접근 없음).

## 파일

| 파일 | 역할 |
|---|---|
| `engine/src/map/station-demand-allocation-view.mjs` | `buildAllocationOverlayView`(보고서 → 표시 모델), `drawAllocationOverlay`(캔버스), `hitAllocationNode`, `renderAllocationPanel`, `renderAllocationLegend`, 라벨 상수 |
| `engine/src/map/station-demand-allocation-ui.mjs` | `mountStationDemandAllocationOverlay` — 자체 오버레이·패널·`<style>` |
| `engine/test/station-demand-allocation-overlay.test.mjs` | 26개 테스트 |
| `scripts/lib/allocation-overlay-world.mjs` | 합성 세계를 **실제 엔진 적용 경로**로 돌려 7가지 보고서를 만든다 (테스트·예제·브라우저 확인 공용) |
| `scripts/build-station-demand-allocation-overlay-examples.mjs` | 예제 생성 (`npm run station-demand-allocation-overlay-examples`, `--out <dir>`) |
| `packs/example-radial/station-demand-allocation-overlay-examples/` | 예제 7개 (`01-split` … `07-whole`) |
| `.gitattributes`, `package.json` | 예제 JSON을 LF로 고정하는 한 줄, npm 스크립트 한 줄 |

## mount

```js
import { mountStationDemandAllocationOverlay } from "./src/map/station-demand-allocation-ui.mjs";

const overlay = mountStationDemandAllocationOverlay({
  canvas, projection, pack,
  getAllocationReport: () => runtime.stationDemandAllocationReport(),   // 없으면 null → "적용된 배정이 없습니다."
  getAccessReport: () => runtime.stationDemandAccessReport(),           // 접근 역의 이름·위치·접근권 다각형 (선택)
  getDemandNodes: () => runtime.operationalState.demandNodes,          // Map 또는 [{ id, location }]. 생략하면 pack.demand.points
  getStations: () => runtime.operationalState.stations,                // Map 또는 [{ id, location }] — 운행 역의 위치
  onChange: (out) => { /* 필요하면 */ },
});
```

- 필요한 것은 캔버스, 투영(`toScreen([lon,lat], w, h)`), 팩과 getter다. 오버레이 캔버스·패널(`.tl-alloc-panel`, 왼쪽 아래, 폭 340 px)·`<style>`(`transitline-station-demand-allocation-style`)은 mount가 만든다. getter가 없거나 `null`/이상한 모양이면 빈 그림이고 예외는 없다.
- 보고서가 바뀌었는지는 **보고서의 식별자·크기**(`applicationId`, `status`, `allocationId`, `appliedAtSimMinute`, `staleReasons`, 링크·차단·분할·노드 개수)와 위치 목록 크기로 판단한다(기본 250 ms마다). 호스트가 보고서를 같은 식별자로 제자리 수정했다면 `overlay.refresh({ force: true })`를 부른다. 바뀌지 않으면 `onChange`도 없다.
- 호스트의 입력은 바꾸지 않는다(얼린 입력 테스트). 출력은 입력과 객체를 공유하지 않는다.

### 출력과 호출

`overlay.output()` / `onChange(out)` / `CustomEvent("transitline:station-demand-allocation-overlay")` → `{ view, status, selectedNodeId, warnings }`.
`status`는 `"none"`(적용된 배정 없음) / `"current"` / `"stale"`. 호출: `select(nodeId)`(없는 ID면 `false`), `deselect()`, `refresh({ force })`, `setEnabled(bool)`, `destroy()`, 읽기 `selectedNodeId`. Esc는 선택을 푼다.

## 표시 모델 `transitline.station-demand-allocation-map-view/1`

`buildAllocationOverlayView({ report, access, demandNodes, stations, selectedNodeId })`(순수, 같은 입력은 같은 출력, 입력 순서와 무관).

| 필드 | 의미 |
|---|---|
| `status`, `stale`, `staleReasons`, `banner` | 적용 상태. 낡으면 배너와 사유 |
| `sites[]` | 접근 역: `stationAccessId`, `name`, `location`(모르면 `null`), `coverage`, `polygons`(접근권) |
| `nodes[]` | `demandNodeId`, `location`, `state`(단독/겹침/미상), `decision`, `visual`(`assigned`/`split`/`held`/`unknown`), `residents`·`jobs`(미상이면 `null`)와 글자, `reasons[]`(사유와 한국어 라벨), `assignments[]`(역, **예상 비율**, `linkState`: `linked`/`blocked`/`none`, 운행 역, 엔진의 걸음 분, 차단 사유), `unallocatedShare`(정책이 배정하지 않은 몫), `unroutedShare`(링크가 받지 못한 몫), `legacy` |
| `lines[]` | 엔진이 만든 링크(노드 → 운행 역, `fractional`)와 만들지 못한 링크(`kind: "blocked"`, 노드 → 접근 역, 사유) |
| `totals`, `missing` | 개수, 위치를 모르는 노드·운행 역·접근 역 |

## 화면에서 구분하는 것

| 상태 | 그림 | 글자 |
|---|---|---|
| 전부 배정 | 초록 ✓, 실선 링크 | 예상 100% |
| 비율 배정 (예: 60/40) | 하늘색 %, **점선 링크**(굵기는 몫) | 예상 60% / 예상 40% |
| 보류 (배정 규칙 없음) | 노랑 ‖, 속 빈 점선 원, 링크 없음 | 단독/겹치는 노드 · 배정 규칙 없음 |
| 미상 | 회색 ?, 속 빈 점선 원, 링크 없음 | 수요 자료가 시구 단위로 거침 / 품질이 낮음 … |
| 경로 없는 몫 | 노드 위 짧은 회색 점선 | 경로 없음 30% (다른 접근으로 보내지 않음) |
| 차단된 링크 | 붉은 짧은 점선(노드 → 접근 역) | 차단: 운행 역이 아직 없음 / 걸어갈 경로가 그려지지 않음 |
| 낡은 배정 | 전체가 흐림, 접근 역 이름에 "낡음", 배너 | 낡은 배정 — 지도 개정이 바뀌었습니다 |
| 접근권 | 하늘색 점선 다각형 | |

색에만 기대지 않고 글리프·점선 모양·글자로 구분한다. "정책이 배정하지 않은 몫"(`unallocatedShare`)과 "경로 없음"(`unroutedShare`)은 서로 다른 사실이라 따로 적는다.

## 예제

`packs/example-radial/station-demand-allocation-overlay-examples/`의 7개는 합성 세계(접근 역 2곳, 수요 노드 3개, 운행 역 3곳)를 **실제 엔진 적용 경로**로 돌려 얻은 보고서의 표시 모델이다: `01-split`(60/40), `02-partial`(50/20, 나머지 30% 미배정·경로 없음), `03-blocked`(운행 역 미완공으로 한 몫 차단), `04-held`(겹치는 노드에 규칙 없음), `05-unknown`(시구 단위 자료), `06-stale`(지도 개정 후 낡음), `07-whole`(한 역 100%). 각 파일 `source`에 합성임과 만든 방법을 적었고, 테스트가 생성 스크립트를 돌려 바이트까지 같은지 확인한다. 실제 도쿄는 수요 노드가 시구 중심점이라 전부 `05-unknown`처럼 나온다.

## 검증

- 단위·DOM 테스트 26개: 실제 엔진 경로의 보고서 7종과 `ScenarioRuntime` 보고서, 60/40·50/20·차단·보류·미상·낡음의 표시 모델, null/0/false 구분, 위치 없는 노드, 순서·Map·입력 모양과 무관한 결정성, 얼린 입력 불변과 출력의 비공유, 비율을 사람 수로 바꾼 값이 어디에도 없음, 상태별 그림(글리프·점선·글자), 금지 낱말 검사, 클릭 선택과 지도로 흘려 보내기, 보고서 변화 추적과 `onChange` 한 번, 위치 경고, 이상한 getter, 읽기 전용(저장 쓰기 0), 켜기·끄기·destroy, import·금지 API 검사, 예제 재생성.
- **실제 headless Chrome**(진짜 마우스 클릭): 합성 세계를 브라우저 안에서 엔진 경로로 만들어 마운트 → 노드를 클릭하면 선택되고 상세(Alpha 예상 60% · Beta 예상 40%, 거주·종사)가 뜬다 → 7가지 보고서로 바꿔 가며 상태·링크·차단·경로 없음·미상·보류·낡음이 화면에 맞게 나온다 → 콘솔 오류 0.

## 한계

- 노드·운행 역의 **위치는 호스트가 준 것만** 쓴다. 보고서의 링크는 운행 역 ID만 갖고 있어 `getStations`가 없으면 링크를 그릴 수 없다(그리지 않고 경고).
- 링크는 노드와 운행 역을 **직선**으로 잇는다. 실제 보행선(M1 `walkLinks`)은 그리지 않는다.
- 접근권 다각형·접근 역 위치·이름은 `getAccessReport`가 있어야 나온다.
- 노드가 아주 많으면(도쿄 242개) 패널은 처음 30개만 나열한다. 겹침 처리는 없다.
- 합성 세계와 합성 레이어로만 확인했고, 실제 도쿄 위 화면 확인은 하지 않았다.
- 패널 자리(왼쪽 아래)는 호스트가 정한다. M2 편집 패널(오른쪽 위)·B14 패널들과 겹칠 수 있다.
- 분할의 실제 집계(어느 승객이 어느 역으로 갔는지)는 보여 주지 않는다. 엔진의 일정 카운트(`stationDemandAllocationCursors`)는 일부러 읽지 않는다.

## Codex가 할 일

1. `main.mjs`에서 위 예시처럼 마운트한다(`runtime`의 두 보고서와 두 위치 목록).
2. 배정을 적용·해제·재적용한 뒤에는 따로 부를 필요가 없다(식별자가 바뀌면 다음 갱신에서 반영). 같은 식별자로 보고서를 제자리 수정하는 경우에만 `refresh({ force: true })`.
3. 패널 자리를 정한다. 필요하면 `setEnabled(false)`로 숨긴다.
