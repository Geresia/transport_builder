# 대체수송 노선·정류장 공간 후보 계약 `transitline.rail-replacement-transport-geometry/1`

B14-M8. 플레이어가 철도 부분운휴 후보(M7 `partialSuspension`)를 고른 뒤, 그 운휴 범위를 대체버스·대체수송으로 메우려 할 때 필요한 **공간 사실**만 낸다: 범위 안 역을 철도 순서대로, 역 출입구와 도로변 정류장 후보, 플레이어가 그린 경로·임시 정류장·회차 장소·제약이 도로와 역에 어떻게 닿는가, 운휴로 갈라진 양쪽 경계역이 남은 철도로 이어지는가. 비용, 운행시간 판정, 차량 수, 수송력, 수요, 점수, 순위, 계약, 현금, 평판, 실제 운행 가능 여부는 지도가 말하지 않는다. 실제 대체수송을 돌리는 것은 경영 엔진(Codex)이다.

## 경계

- **지도는 도로 경로를 찾지 않는다.** 도로 자료는 선 모음이고 연결 그래프가 아니다. 그래서 최단경로·추천 경로를 만들지 않는다 (`derivedRouteCandidates`는 항상 `null`, 이유 `road-graph-not-in-source`). 경로는 **플레이어가 그렸기 때문에** 있다 (`basis: "player"`). 지도가 재는 것은 그린 선이 주변 도로·역과 어떻게 닿는가뿐이다. 직선 연결을 도로 노선처럼 내놓지 않는다.
- 도로 폭은 도로 자료에 없다. 폭은 플레이어가 적은 값만 있고, 그렇지 않으면 `null`이다. 대형버스가 지나갈 수 있다는 판단은 하지 않는다: 플레이어가 입력한 차량 폭과의 단순 비교(`roadWidthAtLeastVehicleWidth`)만 한다. 둘 다 있을 때만 `true`/`false`, 아니면 `null`.
- 출입구 자료가 없으면 역 중심점을 정류장으로 가장하지 않는다. 정류장 후보는 (a) 출입구가 도로변(50 m 이내)에 있다고 **측정된** 경우의 도로 위 가장 가까운 점, (b) 플레이어가 적은 임시 정류장뿐이다.
- 값을 알 수 없으면 `null` + `unknown[]` + `unknownReasons`. `unknown[]`과 `unknownReasons`는 항상 1:1이고 `unknown`에 든 값은 `null`이다.
  - `null`: 자료 부족.
  - `false`: 측정 결과 접속하지 않음 (예: 경로 끝점이 도로에서 50 m 넘게 떨어짐).
  - `[]`: 조사하거나 선언한 결과 후보 없음 (예: 출입구가 없다고 적은 역 부지, 플레이어가 "없음"을 선언한 목록).
- 출력 키에 비용·시간·차량 수·수송력·수요·점수·순위·계약·현금·평판·손실·가능/불가능이 들어가지 않는다 (테스트가 키 이름을 훑는다).
- 지도 모듈은 management, 열차, 현금, 장애 상태를 import하지도 읽지도 쓰지도 않는다. view는 읽기 전용이다.

## 파일

| 파일 | 역할 |
|---|---|
| `engine/src/map/rail-replacement-transport.mjs` | `buildRailReplacementTransport`, `buildRailReplacementTransportExport`, `replacementGeometryIdOf` |
| `engine/src/map/rail-replacement-transport-candidates.mjs` | 역 순서, 출입구·정류장, 플레이어 경로·정류장·장소·제약의 측정 (40 KB 제한으로 나눔) |
| `engine/src/map/rail-replacement-transport-editor.mjs` | 선택·그림 편집·저장·복원 (순수 데이터) |
| `engine/src/map/rail-replacement-transport-view.mjs` | 표시 모델, 캔버스 오버레이, 패널, 범례 (읽기 전용) |
| `scripts/build-rail-replacement-transport-examples.mjs` | 예제 생성 (`npm run rail-replacement-transport-examples`, `--out <dir>`) |
| `packs/*/rail-replacement-transport-examples/` | 예제 12개 (radial 9, corridor 1, tokyo 2) |

## 입력

```
document: { eventId, partialSuspensionCandidateId, turnbackCandidateIds?, selectedOnControlGeometryRevision?,
            routes?:          [{ key?, name?, polyline: [[lon,lat]...], roadWidthMeters? }],
            temporaryStops?:  [{ key?, stationId, location, name?, roadWidthMeters? }],
            turnaroundAreas?: [{ key?, kind?: "turnaround"|"waiting"|"boarding", location?, polygon?, name? }],
            constraints?:     [{ key?, kind: "bridge"|"tunnel"|"height-limit"|"weight-limit"|"width-limit", location, value?, unit?: "m"|"t", basis?: "player"|"source" }],
            vehicleWidthMeters?, active? }
ctx:      { pack, site: RailwayDisruptionSiteGeometry v1, control: RailwayServiceControlGeometry v1, railGeometry?: RailCapacityGeometry v1,
            application?: rail-capacity-application/1, stationSites?: [StationSiteGeometry], spatial?: 공간 컨텍스트(도로·건물·물 레이어) }
```

- `site`와 `control`은 같은 팩·같은 이벤트·같은 `disruptionSiteId`여야 하고, `control.disruptionSiteRevision === site.siteRevision`, `control.railGeometryRevision === site.railGeometryRevision`이어야 한다. **하나라도 어긋나면 거절한다** (오래된 M6/M7). 지도에서 사이트·관제 geometry를 다시 만든 뒤에 호출한다.
- `partialSuspensionCandidateId`는 `control.partialSuspensionCandidates`에 실제로 있어야 하고, `turnbackCandidateIds`는 `control.turnbackCandidates`에 있어야 한다. `selectedOnControlGeometryRevision`(편집기가 선택 시점에 기록)이 있으면 현재 `controlGeometryRevision`과 같아야 한다.
- `railGeometry`(M5)는 ID 검증과 역 순서·구간 선형을 위해 쓴다. 주어지면 `railGeometryId`/revision이 control과 같고 운휴 구간이 모두 있어야 한다. 없으면 범위는 경계역 둘뿐이고 `stationSequence`·`railSections`·`railLengthMeters`·`boundaryStationsConnectedByRetainedRail`이 `null`(`rail-geometry-not-supplied`)이다.
- `application`은 운휴 구간 → 운행 선로구간(`suspendedTrackSegmentIds`)에만 쓴다. 같은 geometry·revision일 때만 쓰고, 오래됐으면 무시하고 경고(`application-stale`).
- 거절 코드: `event-missing`, `partial-suspension-missing`, `site-schema-invalid`, `control-schema-invalid`, `site-other-pack`, `control-other-pack`, `document-event-mismatch`, `control-site-mismatch`, `control-site-revision-mismatch`, `control-rail-geometry-revision-mismatch`, `selection-revision-mismatch`, `partial-suspension-not-offered`, `turnback-not-offered`, `rail-geometry-schema-invalid`, `rail-geometry-other-pack`, `rail-geometry-mismatch`, `rail-geometry-revision-mismatch`, `suspended-section-missing`.

## 출력 필드

`schema`, `contractVersion`, `replacementGeometryId`, `replacementGeometryRevision`, `sourcePackId/Version`, `eventId`, `disruptionSiteId`, `disruptionSiteRevision`, `controlGeometryId`, `controlGeometryRevision`, `railGeometryId`, `railGeometryRevision`, `operationalLineId`, `partialSuspensionCandidateId`, `selectedTurnbackCandidateIds`, `startStationId`, `endStationId`, `suspendedSectionIds`, `suspendedTrackSegmentIds`, `suspendedBlockIds`, `retainedSectionIds`, `stationSequence`, `railSections`, `railLengthMeters`, `boundaryStationsConnectedByRetainedRail`, `boundaryConnections`, `stations`, `stopCandidates`, `routeCandidates`, `derivedRouteCandidates`, `turnaroundAreas`, `spatialConstraints`, `walkNetwork`, `vehicleWidthMeters`, `spatialFlags`, `dataQuality`, `unknown`, `unknownReasons`, `warnings`, `sourceLayers`, `license`.

- **ID/revision 연결:** 사이트(`disruptionSiteId`, `disruptionSiteRevision`), 관제(`controlGeometryId`, `controlGeometryRevision`), 철도 공간 사실(`railGeometryId`, `railGeometryRevision`), 고른 운휴 후보(`partialSuspensionCandidateId`), 고른 회차 후보(`selectedTurnbackCandidateIds`)를 모두 싣는다.
- **`replacementGeometryId = stableId("rail-replacement-transport", packId, eventId, partialSuspensionCandidateId)`.** 같은 이벤트에서 같은 운휴 후보를 고르면 이름·배열 순서·그린 방향·그림의 변화와 무관하게 같다. 다른 후보를 고르면 다른 계획이다. `replacementGeometryRevision`은 공간 사실의 해시이고 그림이 바뀌면 바뀐다.
- `startStationId`/`endStationId`: M7 후보의 경계역. `stationSequence`: 시작역에서 끝역까지 운휴 구간을 걸으며 만든 **철도 순서의 역 목록**. (M7은 역 id가 작은 쪽을 시작으로 삼으므로 방향은 지리적 방향이 아니라 결정적 방향이다.)
- `railSections[]`: 순서대로 `{ sectionId, fromStationId, toStationId, sourceKind, lengthMeters, alignment, blockIds }`. 외부선 구간은 `alignment`·`lengthMeters`가 `null`(`external-alignment-not-in-source`)이고 `railLengthMeters`도 `null`.
- `boundaryStationsConnectedByRetainedRail`: 운휴 구간을 뺀 geometry에서 시작역이 끝역에 이어지면 `true`(운휴 구간 밖으로 도는 선로가 남음), 아니면 `false`. 선형이면 보통 `false`이고 `boundary-stations-separated`를 flag한다.
- `boundaryConnections[]`: 경계역 둘의 `{ stationId, side, retainedSectionIds, turnbackCandidateId, turnbackSelected, routeIdsReaching, stopCandidateIds }`. 남은 쪽 철도 구간, M7 회차 후보 id와 선택 여부, 그 역에 닿는 플레이어 경로, 그 역의 정류장 후보를 한 곳에 모은다.

### `stations[]`

`{ stationId, sequenceIndex, role: "start-boundary"|"interior"|"end-boundary", location, external, isolated, turnbackCandidateId, turnbackSelected, stationSiteId, entrances, derivedStopCandidateIds, playerStopCandidateIds, walkLinks }`.

- `external`: 그 역에 닿는 구간이 모두 기존선(외부)이면 `true`. 외부 철도역은 역 단위 자료뿐이라 `entrances`는 `null`(`external-station-detail-not-in-source`).
- `entrances`: 역 부지(StationSiteGeometry, `connectedStationId`로만 연결)의 출입구 후보. 부지가 없으면 `null`(`no-station-site`), 출입구가 없다고 적힌 부지는 `[]`. 각 출입구는 `{ entranceId, location, roadside, roadsideDistanceMeters, nearestRoad }`; `roadside`는 도로가 50 m 이내면 `true`, 측정으로 더 멀면 `false`, 도로 자료가 없거나 범위 밖이면 `null`.
- `derivedStopCandidateIds`: 출입구가 도로변인 만큼의 정류장 후보. 출입구 자료가 없으면, 도로 자료가 없거나 범위 밖이면 `null`. 출입구가 있는데 모두 도로에서 멀면 `[]`.
- `playerStopCandidateIds`: 플레이어가 적은 임시 정류장. 입력 목록이 없으면 `null`(`no-temporary-stop-stated`).
- `walkLinks[]`: `{ walkLinkId, entranceId, stopCandidateId, straightDistanceMeters, withinNearDistance }` — 같은 역의 출입구와 정류장 사이 **직선 거리**(≤ 50 m면 `withinNearDistance: true`). 보행망 자료가 없으므로 보행 경로 선형은 없다 (최상위 `walkNetwork: null`, 이유 `walk-network-not-in-source`).

### `stopCandidates[]`

`{ stopCandidateId, kind: "entrance-roadside"|"player-temporary", stationId, entranceId, key, name, location, basis: "source"|"player", roadAdjacent, nearestRoad, roadWidthMeters, roadWidthAtLeastVehicleWidth }`. 자료 기반(`entrance-roadside`)은 도로 폭이 항상 `null`(`road-width-not-in-source`). 어느 쪽도 있을 수 없으면(출입구·도로·플레이어 정류장 모두 자료 없음) 목록 전체가 `null`(`no-stop-candidate-data`).

### `routeCandidates[]` (플레이어가 그린 경로만)

입력이 없으면 `null`(`no-route-stated`), 플레이어가 `[]`을 선언하면 `[]`. 각 경로:

| 필드 | 뜻 |
|---|---|
| `routeId` | `key`가 있으면 그것으로, 없으면 그린 좌표로. 그린 방향과 무관 |
| `basis` | 항상 `"player"` |
| `polyline`, `lengthMeters` | 시작역에 가까운 끝에서 출발하도록 돌려놓은 그림(원본은 바뀌지 않음)과 그 길이 |
| `stationApproaches[]`, `visitedStationIds`, `orderMatchesRail` | 범위 안 각 역에서 선까지의 거리·선 위 위치·50 m 이내 여부. 지나는 역을 지나는 순서대로, 그 순서가 철도 순서와 같은가 (두 역 미만이면 `null`) |
| `reachesStartStation`, `reachesEndStation` | 두 경계역을 50 m 이내로 지나는가 |
| `alongRoad` | 20 m 간격으로 잰 도로와의 관계: `onRoadCount`(15 m 이내), `nearRoadCount`(15~50 m), `offRoadCount`(50 m 초과), `unmeasuredCount`, `offRoadRuns[]`(도로에서 떨어진 연속 구간), `fullyOnRoad`. 도로 자료가 없으면 `null`(`no-road-layer`) |
| `roadAttachment` | 시작·끝 끝점이 도로에 닿는가: 15 m 이내 `true`, 50 m 초과 `false`, 사이는 `null` |
| `roadClassesNear` | 선 위(15 m 이내)에서 만난 도로 종류 |
| `roadWidthMeters`, `roadWidthAtLeastVehicleWidth` | 플레이어가 적은 폭과 입력 차량 폭의 비교 |
| `waterCrossingCount`, `buildingIntersectionCount` | 물·건물 레이어를 지나는 수 (레이어가 없으면 `null`) |
| `constraintIdsNear` | 30 m 이내의 제약 id (제약 입력이 없으면 `null`) |
| `stopCandidateIdsNear` | 50 m 이내의 정류장 후보 |

`fullyOnRoad`: 측정이 안 된 표본이 있으면 `null`(`outside-road-coverage`), 떨어진 표본이 하나라도 있으면 `false`, 전부 15 m 이내면 `true`, 그 외는 `null`(`near-a-road-not-on-it`). **끊어진 접속**은 `offRoadRuns`와 `fullyOnRoad: false`로 드러난다.

### `turnaroundAreas[]`, `spatialConstraints[]`

- `turnaroundAreas[]` (대체버스 회차·대기·임시 승강 공간, 플레이어가 표시): `{ turnaroundAreaId, kind, basis: "player", location, polygon, areaSquareMeters, roadAdjacent, nearestRoad, buildingOverlapCount, waterOverlapCount, distancesToStationsMeters, routeIdsNear }`. 입력이 없으면 `null`, 선언한 "없음"은 `[]`. 점만 준 장소는 면적이 `null`(`no-polygon-drawn`). 자기교차 다각형·알 수 없는 종류는 경고하고 버린다.
- `spatialConstraints[]` (교량·터널·높이·중량·폭 제한): **원본이나 플레이어가 적은 것만.** 도로 레이어에는 이런 속성이 없으므로 입력이 없으면 `null`(`no-constraint-data`)이다. 값을 모르면 `value`가 `null`.

## 측정 상수

도로 위 15 m (`ROAD_ON_METERS`), 도로 가까이 50 m (`ROAD_NEAR_METERS`), 표본 간격 20 m, 역 가까이 50 m (`STATION_NEAR_METERS`), 제약 가까이 30 m (`CONSTRAINT_NEAR_METERS`). 손으로 그린 선이라 M5의 1 m 접속 기준보다 넓다. 도로 검색은 점 주변 약 400 m 안의 도로만 본다 (그 안에 도로가 없으면 `false`이고 거리는 `null`, `no-road-within-search-margin`).

## spatialFlags

`no-road-graph`(항상), `road-layer-missing`, `entrance-data-missing`, `external-station-detail-missing`, `stations-left-without-rail`, `boundary-stations-joined-by-retained-rail`, `boundary-stations-separated`, `player-route-drawn`, `player-route-off-road`, `player-route-road-contact-unmeasured`, `route-order-differs-from-rail`, `turnaround-not-stated`, `selected-turnback-not-at-boundary`.

## 편집기 `rail-replacement-transport-editor.mjs`

문서는 `{ version, packId, packVersion, plans: [...] }`이고 계획은 `eventId` + 고른 운휴 후보 id로 키를 잡는다.

- `addPlan(doc, eventId, candidateId, control)`: 관제 geometry가 실제로 내놓은 후보만 받는다 (아니면 throw). 고른 시점의 `controlGeometryRevision`을 기록한다. 같은 선택은 같은 계획을 돌려준다.
- `selectTurnback` / `deselectTurnback`: 회차 후보 선택. `setRoute`, `setTemporaryStop`, `setTurnaroundArea`, `setConstraint`(키로 덮어쓰기)와 `removeRoute`… (플레이어 자기 그림 삭제), `declareNone(kind)`(그 목록이 `[]`임을 선언 — 입력 없음 `null`과 다르다), `setVehicleWidth`.
- `reconcilePlan(doc, eventId, candidateId, control)` → `{ offered, outdated, staleTurnbackCandidateIds }`.
- `deactivatePlan` / `restorePlan`: 계획은 삭제하지 않고 끈다. 계획 삭제 함수는 없다.
- `serializeRailReplacementDoc` / `restoreRailReplacementDoc(text, pack)`: 저장 후 id가 유지된다. 다른 팩 저장본·읽을 수 없는 본·다른 버전은 새 문서로 시작하고 경고한다. 문서는 그림을 복사해 보관하고 호출자의 객체와 공유하지 않는다.
- `toReplacementDocument(plan)`: `buildRailReplacementTransport`의 입력.

## view `rail-replacement-transport-view.mjs`

`buildRailReplacementTransportView({ exportData, selectedId })`, `drawRailReplacementTransportOverlay(ctx, model, screen)`, `renderRailReplacementTransportPanel`, `renderRailReplacementTransportLegend`. 자료 기반과 플레이어 그림이 서로 다른 색·선·글리프다.

| 대상 | 표시 |
|---|---|
| 운휴 구간 | 보라 점선 |
| 범위 안 역 | ◆ (경계역은 큰 마름모, 철도가 남지 않는 역은 속 빈 마름모), 출입구는 작은 점 |
| 출입구 인근 도로변 정류장 후보(자료 기반) | 하늘색 ■ |
| 플레이어 임시 정류장 | 노란 ▲ |
| 출입구–정류장 직선 거리 | 회색 점선 (보행 경로가 아님을 범례에 적음) |
| 플레이어 경로 | 도로 위 초록 실선 / 떨어진 구간 있음 빨강 긴 점선 / 미측정 회색 점선. 이름은 "플레이어 경로" |
| 플레이어 장소 | 분홍 배지(↻ 회차, ▭ 대기, ⇅ 임시 승강) |
| 제약 | 주황 ⚠ |

패널·범례는 비용·시간·수송력·점수·판정 문구를 쓰지 않고 "지도는 경로를 찾지 않는다"를 적는다. 플레이어가 적은 문자열은 `textContent`로만 넣는다.

## Codex가 경영 엔진에 연결할 것

1. **ID:** `replacementGeometryId`(+`replacementGeometryRevision`)로 계획을 식별하고, `eventId`/`disruptionSiteId`/`controlGeometryId`/`partialSuspensionCandidateId`로 M6·M7과 잇는다. 운행 쪽 구간은 `suspendedTrackSegmentIds`(application을 거친 값)와 `startStationId`/`endStationId`/`stationSequence`의 역 id를 쓴다.
2. **경로·정류장:** 대체버스 경로는 `routeCandidates[].routeId`/`polyline`(플레이어가 그린 것)이고, 정류장은 `stopCandidates[].stopCandidateId`/`location`/`stationId`, 회차·대기 장소는 `turnaroundAreas[].turnaroundAreaId`/`location`이다. 지도는 도로 노선을 만들지 않는다.
3. **판정은 엔진의 몫:** `alongRoad.fullyOnRoad`, `roadAttachment.*.attached`, `roadWidthAtLeastVehicleWidth`, `orderMatchesRail`, `boundaryStationsConnectedByRetainedRail`은 공간 사실이다. `null`을 "가능"으로 보지 말고 엔진이 미확인으로 다룬다 (M7 `physicalAttachment: null`을 대하는 방식과 같게).
4. 회차 후보 선택은 M7 규칙 그대로 `selectedTurnbackCandidateIds`에 담긴다.
5. `index.html`/`main.mjs` 연결과 DOM 컨트롤러는 이번 단계에서 만들지 않았다.

## 실제 도로 자료의 한계

- 도로 레이어(`roadLayerFromGeojson`)는 선과 도로 종류(`highway`/`major`/`minor`)뿐이다. **폭·차로 수·일방통행·교량·터널·높이 제한·연결(노드) 정보가 없다.** 그래서 경로 탐색을 하지 않고, 폭·제약은 플레이어 진술이 있을 때만 값이 생긴다.
- 선이 끝점에서 만난다고 연결로 간주하지 않는다 (같은 OSM 도로가 쪼개져 있을 수도, 교차로가 아닐 수도 있다).
- 팩에 실제 도로 레이어가 들어 있는 곳은 없다 (Tokyo는 도로 자료를 추적하지 않는다). 예제의 도로는 **합성**(합성 팩의 stand-in 레이어, 또는 예제 스크립트가 철도 선형 옆에 그어 둔 선)이다.
- 역 출입구는 역 부지 예제가 있는 역에만 있다. 외부(기존선) 철도역은 역 단위 위치뿐이다.
- 보행망 자료가 없어 출입구–정류장은 직선 거리만 낸다.

## 예제 (합성)

플레이어의 선택·경로·정류장·장소·제약·차량 폭·도로 선은 **합성**이다 (`source.synthetic: true`, `source.note`). 계획선은 같은 팩의 실제 plan 예제이고 역 부지는 팩의 station 예제다. 사이트와 관제 geometry는 이름 붙인 M7 예제(`source.m7Example`)의 기록된 입력으로 다시 만들고, **생성기가 ID와 revision이 배포된 M7 예제와 같은지 확인한다** (다르면 생성 실패, 테스트도 같은 확인을 한다). `source.input.savedDocument`에 편집기가 저장한 계획 문서가 있다.

| 팩 | 예제 | 보여 주는 것 |
|---|---|---|
| radial | 01-middle-section-bus-between-boundary-stations | 중간 구간 운휴 후 양쪽 경계역을 잇는 경로 (도로 위, 한쪽 역만 출입구 자료, 반대 방향으로 그림) |
| radial | 02-line-end-suspension-bus | 종점부 운휴: 선로 끝 역이 철도에서 고립됨, 임시 정류장, 출입구 보행 연결 |
| radial | 03-several-stations-in-order | 여러 역을 순서대로 (4역), 경로가 지나는 순서 = 철도 순서, 일부 구간만 가는 경로 |
| radial | 04-entrances-and-temporary-stop | 역 출입구 → 도로변 정류장 후보, 플레이어 임시 정류장, 직선 보행 거리 |
| radial | 05-player-drawn-road-route-with-constraints | 도로를 따라 그린 경로, 도로 폭·제약(중량·교량), 도로 자료 범위를 벗어난 뒤는 미측정 |
| radial | 06-route-disconnected-from-the-road | 도로 자료가 중간에 끊긴 곳을 지나는 경로(떨어진 구간 명시)와 도로가 없는 곳에 그린 경로(끝점 접속 `false`) |
| radial | 07-road-width-unknown-and-stated | 폭 7 m(`true`) / 2 m(`false`) / 미입력(`null`), 입력 차량 폭 2.5 m |
| radial | 10-turnaround-and-waiting-space | 회차·대기·임시 승강 장소와 건물 겹침·도로 접함·경로 근접 |
| radial | 11-outside-the-road-data | 도로 자료 범위 밖: 모든 도로 관계가 `null`(`outside-road-coverage`) |
| corridor | 08-entrance-data-unknown | 출입구 자료 없음: 정류장 후보는 플레이어 것뿐, 보행 연결 `null` |
| tokyo | 09-no-road-layer | 도로 레이어 없음: 경로는 있고 도로와의 관계는 `null` |
| tokyo | 12-external-stations-without-detail | 외부 철도역(기존선): 출입구·선형·길이 `null` |

## 작업 중 발견한 기존 문제

- M6(`build-railway-disruption-site-examples.mjs`)·M5·M4 예제 스크립트의 `only` 인자 파싱이 `i !== outFlag + 1`이라 `--out`이 없으면 첫 인자(팩 id)를 무시한다 (`npm run … tokyo`가 모든 팩을 만든다). M7·M8 스크립트는 고쳤다. 기존 스크립트는 이번 지시에서 건드리지 않았다.
- M7 `startStationId`는 역 id가 작은 쪽이라 지리적 시작이 아니다. M8의 `stationSequence`도 같은 방향 규칙을 따른다 (결정적이지만 "서쪽에서 동쪽"이 아니다).
- 실제 도로 자료에 폭·교량·터널·연결 정보가 없다 (위 한계).

## 검증

`npm test`(`engine/test/rail-replacement-transport.test.mjs`, 40개), `npm run validate`, `git diff --check`, 예제 생성기 두 번 실행 후 SHA-256 비교(테스트가 `--out`으로 다시 만들어 바이트 비교, 기존 M6/M7 예제 id 회귀 테스트 포함).
