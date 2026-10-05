# B15-M2 역 접근권 지도 편집·표시 mount — Codex 인수 문서

B15-M1의 `transitline.station-demand-access-geometry/1`(계약 문서 `station-demand-access-contract.md`)을 **지도에서 그리고 고치고 지우고 저장·복원**하는 독립 브라우저 mount. 출입구, 접근점, 보행 연결, 환승 통로, 접근권 경계, 수요 구역을 다룬다.

- 기준: B15-M1 커밋 `4c2706b` 위. 브랜치 `b15-m2-station-access-mount`.
- `main.mjs`, `index.html`, `style.css`, `management/**`, `scenario-runtime.mjs`는 건드리지 않았다. 기존 M1·B14 계약도 바꾸지 않았다.

## 경계

지도는 공간 사실만 다룬다. 이용자 수, 운임, 혼잡, 걸음 소요, 점수, 비용은 **계산하지도 표시하지도 않는다.** 패널에는 장소·모양·그려진 길이(m)·개수·미상만 나온다(테스트: 패널 글자에 판정·금액·시간·크기 낱말이 없음, 출력에 해당 키가 없음). 그리지 않은 것은 그려지지 않고 모르는 값은 "미상"으로 적힌다. 수요·OD 자료는 출처·품질·노드 ID로만 연결한다(값 없음).

## 파일

| 파일 | 역할 |
|---|---|
| `engine/src/map/station-demand-access-ui.mjs` (36 KB) | `mountStationDemandAccess` — 상태, 편집 동작, 포인터·키 처리, 패널, 저장 |
| `engine/src/map/station-demand-access-view.mjs` | 표시 모델·캔버스 오버레이·패널·범례 (M1 export를 읽기만 함) |
| `engine/src/map/station-demand-access-tools.mjs` | 클릭이 무엇을 가리키는지(출입구·접근점·역·선·다각형·꼭짓점·변) 순수 화면 기하 |
| `engine/test/station-demand-access-ui.test.mjs` | 26개 테스트 (가짜 브라우저) |
| `.gitattributes` | M1 예제 JSON을 LF로 고정하는 한 줄 (아래 "M1에서 고친 것") |

저장·편집 데이터는 M1의 `station-demand-access-editor.mjs`를 그대로 쓴다(새 저장 형식 없음). 공용 껍데기는 B14의 `map-mount-kit.mjs`(오버레이 캔버스, 패널, `<style>`, localStorage 저장소)다.

## mount

```js
import { mountStationDemandAccess } from "./src/map/station-demand-access-ui.mjs";
import { demandSourceRefsOf } from "./src/map/station-demand-access.mjs";

const access = mountStationDemandAccess({
  canvas, projection, pack,
  getPlans: () => mapExport.plans,                       // buildMapExport 결과의 plans (또는 { plans })
  getExternalNetworks: () => mapExport.externalNetworks, // 기존 네트워크 (스크래치 모드면 [])
  getDemandNodes: () => mapExport.demandNodes,           // 생략하면 팩의 demand 점에서 만든다
  getDemandSources: () => demandSources,                 // demandSourceRefsOf(...) 결과. 생략하면 "출처 미상"
  getSpatial: () => spatial,                             // makeSpatialContext(layers). 생략하면 레이어 없음 → 레이어 사실은 미상
  onChange: (out) => { /* 저장·엔진에 전달 */ },
});
```

- 호스트 페이지에서 필요한 것은 캔버스, 그 투영(`toScreen([lon,lat], w, h)`), 팩뿐이다. 오버레이 캔버스, 패널(`.tl-access-panel`), `<style>`(`transitline-station-access-style`)은 mount가 스스로 만든다. 지도의 포인터 이벤트는 캡처 단계에서 받으며, 모드가 없을 때는 **무언가를 맞혔을 때만** 지도에서 뺏는다(빈 곳 클릭은 지도로 흘려보낸다).
- `getPlans` 등은 목록, 한 객체, `{ plans }` 같은 묶음, `null` 모두 받는다(예외 없음). 호스트가 준 입력은 바꾸지 않는다(얼린 입력 테스트).
- 입력이 바뀌면(계획 역 이동·삭제, 외부 네트워크 변경, 수요 노드·출처 변경, `getSpatial()`이 다른 객체를 돌려줌) 다음 `refresh()`(기본 250 ms 타이머)에서 다시 만든다. 바뀐 게 없으면 `onChange`도 없다.

### 출력 `bridge.output()` / `onChange(out)` / `CustomEvent("transitline:station-demand-access")`

```
{ document,            // 플레이어의 저장 문서 (복사본)
  export,              // M1 transitline.station-demand-access-export/1 — 엔진이 읽을 것
  sites,               // export.sites (역별 StationDemandAccessGeometry)
  selected,            // 고른 역의 site (없으면 null)
  selectedStationKey, selection: { type, key } | null,
  warnings }           // mount 메모 + export 경고 + 각 site 경고(stationAccessId 포함)
```

`output.export`가 엔진 입력이다. 편집 한 번(여러 단계가 이어져도)은 `onChange` 한 번이다.

### 호출 API (패널과 같은 동작을 코드로)

| 분류 | 함수 (모두 성공이면 `true`, 거절이면 `false` + 경고 `station-demand-access-edit-refused`) |
|---|---|
| 역 | `startStation({ planId, stationId } \| { externalNetworkId, stationId } \| { location })`, `selectStation(key)`, `deselect()`, `removeStation(key?)`(끄기), `restoreStation(key)` |
| 요소 추가 | `addEntrance(loc, {name})`, `addAccessPoint(loc, {kind,name})`, `addCatchment(points, {entranceKey,name})`, `addDemandZone(points, {kind,name})`, `addWalkLink({from,to,via,widthMeters,name})`, `setTransfer(targetStationId, via, {fromEntranceKey,widthMeters})` |
| 수정 | `moveElement(type,key,loc)`(출입구·접근점), `moveDrawing(loc)`(역 그림 전체), `moveVertex/insertVertex/removeVertex(type,key,index,loc)`(경계·구역은 꼭짓점, 보행 연결·통로는 굽이), `update(type,key,patch)`(이름·종류·폭·경계 기준 출입구만) |
| 삭제 | `removeElement(type,key)` (`type`: `entrance`/`access-point`/`walk-link`/`transfer`/`catchment`/`demand-zone`) |
| 선택·모드 | `selectElement(type,key)`, `setMode(mode, {pointKind, zoneKind})`, `finishDraft()`, `addDraftPoint(loc)` |
| 저장·상태 | `serialize()`, `loadDoc(textOrObject)`, `save()`, `refresh()`, `setEnabled(bool)`, `destroy()`, 읽기 `selectedStationKey`, `selection`, `mode`, `document`, `storageKey` |

거절하는 경우: 없는 대상, 모양이 틀린 좌표, 3점 미만 다각형, 알 수 없는 종류, 양수 아닌 폭, 같은 끝끼리·없는 끝의 보행 연결, 같은 계획의 역으로 가는 통로, 3점 이하로 줄이는 꼭짓점 삭제, 선을 점처럼 이동.

## 화면에서 하는 법

| 하고 싶은 일 | 방법 |
|---|---|
| 역 정하기 | 패널의 "접근 그리기 시작"(계획 역), "지도에서 역 고르기"(작은 점들 중 클릭 → 기존 역·계획 역), "새 역 위치 지정"(빈 곳 클릭) |
| 출입구·접근점 | "출입구 추가"/"접근점 추가" 후 지도 클릭(연속, Esc로 끝). 접근점 종류는 종류 버튼(거리·횡단 지점·광장·정류장·기타) |
| 접근권 경계·수요 구역 | "접근권 경계 그리기"/"수요 구역 그리기" 후 점을 클릭하고 완료(Enter, 더블클릭, 버튼). 출입구를 고른 뒤 "출입구 기준 경계"도 가능. 구역 종류는 종류 버튼 |
| 보행 연결 | "보행 연결 그리기": 출입구·접근점·역·구역(안쪽)을 클릭 → 빈 곳 클릭으로 굽이 → 끝 대상 클릭 |
| 환승 통로 | "환승 통로 그리기": 빈 곳 클릭으로 굽이 → 대상 역(작은 점) 클릭. 출입구를 골라 두면 그 출입구에서 시작 |
| 고르기 | 모드 없이 지도 클릭 (출입구·접근점 > 역 > 연결선 > 다각형 테두리 > 구역 안쪽 > 경계 안쪽) |
| 이동 | 점을 고른 뒤 "이동" → 새 위치 클릭. 역을 고르면 그림 전체가 같은 만큼 이동(계획 역의 자리는 그대로) |
| 모양 고치기 | 경계·구역·연결·통로를 고른 뒤 "꼭짓점 이동"(클릭 → 새 위치 클릭), "꼭짓점 추가"(변 위 클릭), "꼭짓점 지움" |
| 이름·폭 | 입력칸 + "이름 적용"/"폭 적용"/"폭 지움" (폭은 플레이어가 말한 값, 없으면 미상) |
| 삭제 | "삭제" 또는 Delete 키. 역은 "끄기"(지우지 않고 비활성, "되살리기"로 복귀) |

요소를 지워도 그것을 가리키던 보행 연결·통로·경계는 문서에 남는다. 지도는 `walk-link-endpoint-missing` 같은 경고로 알리고 출력에서만 뺀다. 패널은 지우기 전에 "이 요소를 가리키는 연결 N개는 경고로 남습니다"라고 알린다. 지운 요소의 키는 다시 쓰지 않는다.

## 저장·복원

- 편집마다 localStorage `transitline.station-demand-access.v1:<packId>`에 `serializeStationDemandAccessDoc` 결과(`{ version: 1, packId, packVersion, stations[] }`)를 쓴다. 다시 열면 같은 문서·같은 출력(바이트 동일, 테스트와 Chrome 확인).
- 저장소가 막혀 있어도 예외 없이 동작하고 경고 `station-demand-access-doc-not-saved`만 남긴다.
- **호스트 저장**: 통합 저장에는 `access.serialize()` 문자열을 넣고, 불러올 때 마운트 직후 `access.loadDoc(text)`를 부른다. 반환값은 경고 목록이다. 다른 팩의 문서(`…-doc-other-pack`), 읽을 수 없는 문서(`…-doc-unreadable`), 다른 버전·모양(`…-doc-version`)은 **통째로 거부하고 현재 그림을 건드리지 않는다.** 팩 버전만 다르면 `pack-version-mismatch` 경고와 함께 불러온다. 불러온 뒤 선택은 비워진다.

## 배치와 CSS

패널 클래스 `tl-access-panel`(기본 위치: 오른쪽, 위에서 64 px, 폭 360 px, 최대 높이 56vh, 넘치면 스크롤). 고른 역의 도구는 패널 위쪽에, 역 목록은 그 아래에 있다. B14 파이프라인의 네 패널(`tl-rail-panel`, `tl-disruption-panel`, `tl-control-panel`, `tl-detour-panel`)과 함께 쓰면 겹칠 수 있으므로 호스트(또는 파이프라인 레이아웃 스타일)가 자리를 정한다. 오버레이 캔버스는 지도 캔버스 위에 `pointer-events:none`으로 놓이고 지도 크기를 따라간다. 지도의 포인터는 mount가 모드 중일 때만, 선택은 맞혔을 때만 가져간다.

## B14 파이프라인과의 관계

`map-input-pipeline.mjs`는 건드리지 않았다. 이 mount는 파이프라인과 **독립**이며 레일 용량·장애·관제·우회와 데이터를 주고받지 않는다(역 접근은 레일 문서가 아니다). 통합 저장 봉투에 넣으려면 호스트가 `access.serialize()`를 다섯 번째 문서로 따로 보관하면 된다(파이프라인 봉투 스키마는 바꾸지 않았다).

## M1에서 고친 것

M1의 예제 JSON은 Windows에서 새로 checkout하면 CRLF가 되어, 생성 스크립트가 쓰는 LF와 달라져 "생성 스크립트가 모든 예제를 바이트까지 재현한다" 테스트가 실패했다(M1 작업 폴더에서는 파일을 직접 생성해 LF였기 때문에 가려져 있었다). `rail-capacity-examples`와 같은 방식으로 `.gitattributes`에 `packs/*/station-demand-access-examples/*.json text eol=lf` 한 줄을 더했다. 예제 내용은 바뀌지 않았다(M1 커밋과 동일). M1 브랜치를 따로 가져갈 때도 이 한 줄이 필요하다.

## 검증

- 단위 테스트 26개 (`engine/test/station-demand-access-ui.test.mjs`): 마운트·패널·스타일·낱말 검사, 입력 이상 모양, 역 시작·기존 역·새 위치·끄기·되살리기, 출입구·접근점·경계·구역·보행 연결·환승 통로 그리기, 고르기 우선순위와 지도 이벤트 통과, 이름·폭·이동·꼭짓점 편집, 삭제와 남는 경고, 저장·복원·거부·막힌 저장소, 입력 변화 따라가기, 얼린 입력, 출력에 금지 키 없음, 켜기·끄기·destroy, 임포트·금지 API 검사. `engine/test/map-layer.test.mjs`의 파일 크기·임포트 검사도 통과한다.
- **실제 headless Chrome**(DevTools 프로토콜, 진짜 마우스 클릭 5번 포함): 역 시작 → 출입구 클릭 → 접근점 클릭 → 보행 연결(굽이 포함) → 수요 구역(주거) → 접근권 경계 → 구역으로 가는 보행 연결 → 기존 역으로 가는 환승 통로 → 이름·폭 적용 → 이동 → 꼭짓점 이동 → 새로고침 후 문서·출력 바이트 동일 → 다른 팩 문서·깨진 문서 거부(현재 그림 그대로) → 삭제 후 연결이 경고로 남음. 콘솔 오류 0. 건물 위를 지나는 연결은 주황 점선과 경고, 레이어가 없는 값은 "미상"으로 표시됨을 확인.

## 데이터 한계

- 합성 월드와 합성 레이어(`syntheticLayers`)로만 확인했다. 실제 도쿄 위 화면 확인과 도쿄 건물·도로 레이어 연결은 하지 않았다(호스트가 `getSpatial`로 주는 만큼만 사실이 나온다).
- 수요 노드가 시구 중심이라 작은 구역 안에는 거의 들지 않는다(M1 한계 그대로). 구역 패널은 "안에 수요 노드 없음 / 가장 가까운 수요 노드"로 보여 준다.
- 드래그 편집은 없다. 이동과 꼭짓점 편집은 "고른 뒤 새 위치 클릭"이다(공용 mount 껍데기가 pointerdown만 받는다).
- 모바일·터치와 키보드만으로 하는 편집, 되돌리기(undo)는 만들지 않았다.
- 역 목록은 계획 역만 나열한다(기존 역은 "지도에서 역 고르기"). 기존 네트워크가 크면 점이 많이 보인다.
- 접근점 종류·구역 종류는 플레이어의 표지일 뿐 다른 교통수단·토지이용 자료가 아니다.

## Codex가 할 일

1. `main.mjs`에서 위 예시처럼 마운트하고 `onChange(out)`에서 `out.export`를 보관한다(엔진 입력).
2. 통합 저장에 `access.serialize()`를 넣고 불러올 때 `access.loadDoc(text)`를 부른다. 경고는 화면에 알린다.
3. `getDemandSources`는 팩의 `demand.json`·`od.json`·`od-school.json` 헤더로 `demandSourceRefsOf`를 불러 만든다(해상도·품질은 호출자가 적는다. 도쿄는 시구 중심이라 `low`).
4. 엔진은 `output.export.sites[]`의 `walkLinks[].lengthMeters`, `transfers[].passageLengthMeters`, `widthMeters`(알 때만), `catchments[]`, `demandZones[].demandNodeRefs`로 걸음 소요·혼잡·수요 배분을 계산한다. 지도는 그 계산을 하지 않는다.
5. 패널 자리를 정한다(B14 패널 네 개와 겹침 방지). 필요하면 `setEnabled(false)`로 숨긴다.
