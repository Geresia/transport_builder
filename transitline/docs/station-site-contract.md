# 역 후보지 출력 계약 (지도 → 경영 엔진)

지도가 역 후보 하나에 대해 **공간 사실만** 만들어 넘기는 계약이다. 역 종류, 승강장 형식, 공법, 공사비, 공사기간, 수용력, 환승점수, 보상비는 경영 엔진이 정하며, 이 코드는 그 값을 만들지 않고 `management`를 import하지도 않는다(테스트가 검사: 필드 이름에 cost·price·score·capacity·compensation·duration·method 등이 없음). PlanGeometry·DepotSiteGeometry와 같은 규칙([map-plan-contract.md](map-plan-contract.md), [depot-site-contract.md](depot-site-contract.md))을 쓴다.

## 코드 위치

| 파일 | 역할 |
|---|---|
| `engine/src/map/station-site.mjs` | 후보 → `StationSiteGeometry`. 진입점 `buildStationExport()` |
| `engine/src/map/station-editor.mjs` | 후보 문서(추가·이동·회전·크기·삭제·복원, 출입구·환승통로)와 저장·복원. 순수 데이터 |
| `engine/src/map/station-view.mjs` | 레이어별 표시(본체·출입구·환승통로·작업구·위험 마커)와 **엔진 판정 읽기 전용 레이어**, 공간 사실 표 |
| `engine/src/map/station-ui.mjs` | 브라우저 조작. 편집 화면 `#btn-station` |
| `engine/src/map/local-geometry.mjs` | 차량기지와 공유하는 평면 기하 |
| `scripts/build-station-examples.mjs` | 예제 생성(`npm run station-examples`) |

## 입력 (플레이어가 지정한 것)

```js
{ key?, name?, connect?: { planId, stationId }, location?: [lon,lat],
  headingDegrees?, lengthMeters?, widthMeters?,
  entrances?: [{ key?, name?, location }],
  transfers?: [{ targetStationId, via?: [[lon,lat]...] }],
  workAreas?: [{ key?, polygon }] }
```

- 연결할 역은 지도가 내보낸 PlanGeometry의 `planId` + `stationId`. `location`을 생략하면 그 역의 좌표를 쓰고, 주면(플레이어가 옮김) 그 자리를 쓴다. 둘 다 없으면 후보는 내보내지 않고 `station-no-location` 경고를 남긴다.
- 본체 방향은 플레이어 값 > 연결한 계획 선형의 진행 방향. 둘 다 없으면 **본체를 지어내지 않는다**(`bodyPolygon: null`, 사유 `no-heading`).
- 본체 길이는 플레이어 값 > 계획 역의 `platformLengthM` > 기본 160 m, 폭은 플레이어 값 > 기본 24 m. 기본값은 충돌 검사를 위한 자리표시 크기이며 `bodyDimensionBasis`(`player|plan-platform-length|default`)로 밝힌다.

## 출력 `StationSiteGeometry`

`schema: "transitline.station-site-geometry/1"`, `contractVersion: 1`. `buildStationExport()`는 `{ schema: "transitline.station-export/1", packId, packVersion, sites[], warnings[] }`를 낸다(`stationSiteId` 순 정렬).

| 분류 | 필드 (단위) |
|---|---|
| 식별·좌표계 | `stationSiteId`, `sourcePackId`, `sourcePackVersion`, `name`, `coordinateReference`("EPSG:4326"), `location` |
| 계획 연결 | `connectedPlanId`, `connectedStationId`, `connectedSegmentIds[]`(그 역에 닿는 구간), `connectionBasis`, `planStationIndex`, `planTerminalEnd`(`start\|end\|null`), `offsetFromPlanStationMeters`, `planHints{structure, structureBasis, depthMeters, platformType}` — 계획 역이 가진 값을 **그대로 복사**한 것이지 지도가 정한 값이 아니다 |
| 선로 | `trackHeadingDegrees`(정북 기준 시계방향, 계획 진행 방향), `plannedDepthMeters`, `plannedTrackElevationMeters`(= 지표고 − 계획 깊이. 고가·교량은 높이 자료가 없어 `null`) |
| 본체 | `bodyPolygon`(반시계·정규화된 열린 고리), `bodyHeadingDegrees`+`bodyHeadingBasis`(`player\|alignment`), `bodyLengthMeters`, `bodyWidthMeters`, `bodyDimensionBasis`, `bodyAreaSquareMeters` (m²) |
| 지형 | `groundElevationMeters`(본체 평균), `elevationRangeMeters`, `averageSlopePercent`, `maximumSlopePercent` (%) |
| 겹침·주변 도로 | `intersectedBuildingCount`, `waterOverlapCount`, `roadsThroughBody{highway,major,minor}`, `roadsNearby{…}`(60 m 안), `nearestRoad{roadClass, distanceMeters}`, `roadWidthMeters`(도로 자료가 등급만 담아 **항상 `null`**, 사유 `no-attribute`/`no-layer`) |
| 다른 역 | `nearestExistingStation`(기존망), `nearestPlannedStation`(**다른 계획**의 역), 각 `{stationId, name, networkId, lineIds, distanceMeters, locationBasis}`. 같은 계획의 이웃 역과, 다른 계획이 같은 자리에 둔 같은 역(같은 ID)은 제외. 빈 지도 시작에는 기존망이 없으므로 `null`이 사실 |
| 환승 후보 | `transferCandidates[]` — 반경 500 m 안의 기존역·다른 계획 역(`basis: "nearby"`)과 플레이어가 그린 통로(`basis: "player-passage"`). 대상마다 하나(그린 통로가 근처 후보를 대체). `transferId`, `targetStationId/Kind/Name/NetworkId/LineIds/LocationBasis`, `straightDistanceMeters`(본체→대상), `alignment`, `passageLengthMeters`, `walkingDistanceMeters`(그린 통로는 그 길이, 근처 후보는 직선×1.3), `crossings{river,road,railway,building,utility}`, `dataQuality`, `unknown[]`, `unknownReasons`. 기존망 역은 시구정촌 중심점에 뭉쳐져 있어 `targetLocationBasis: "demand-node"`, `dataQuality: "low"`이고 사이트에 `external-station-locations-coarse` 경고가 붙는다 |
| 출입구 후보 | `entranceCandidates[]` — `entranceId`, `location`, `collidingBuildingCount`(6 m 발자국 기준), `waterOverlapCount`, `nearestRoad`, `roadsideDistanceMeters`, `roadside`(≤ 15 m), `landUses[]`(그 점을 덮는 OSM 토지 종류), `publicLand`(`true`\|`null`)+`publicLandEvidence`(`osm-open-space\|road-edge`), `distanceToBodyMeters`, `spatialFlags`, `dataQuality`, `unknown[]`, `unknownReasons` |
| 수요지점 접근 | `demandAccess[]` — 800 m 안 수요지점(가까운 순 최대 8): `demandNodeId`, `distanceMeters`(가장 가까운 출입구에서, 출입구가 없으면 본체에서), `walkMinutes`(직선×1.3÷80 m/분, 최소 1분), `measuredFrom`, `entranceId`. 범위 안에 없으면 `[]`(사실) — 역이 없는 수요지점도 정상 |
| 공사용 공간 | `workAreaCandidates[]` — 본체 양끝·양옆에 40×30 m 네 곳(`end-forward/end-backward/side-right/side-left`)과 플레이어가 그린 폴리곤(`player`). `workAreaId`, `slot`, `polygon`, `areaSquareMeters`, `intersectedBuildingCount`, `waterOverlapCount`, `roadsThrough`, `nearestRoad`, `nearestMajorRoad`(300 m 안 고속·간선), `averageSlopePercent`, `maximumSlopePercent`, `spatialFlags`, `unknown[]`, `unknownReasons` |
| 연장 공간 | `extensionSpace[]` — 본체 양끝 방향으로 곧게 400 m까지 10 m씩 훑어 처음 건물·수역에 막히는 지점: `end`(`forward\|backward`), `freeLengthMeters`, `blockedBy`. 회차·연장이 가능한지는 판단하지 않는 **거리 사실**이다 |
| 위험 | `spatialFlags[]`: `body-building-overlap`, `body-water-overlap`, `steep-site`(평균경사 ≥ 3%), `no-entrance-candidate`, `all-entrances-blocked`, `no-roadside-entrance`, `no-clear-work-area`, `transfer-through-buildings`. 사실 표시이며 점수가 아니다 |
| 자료 | `dataQuality`(`high\|medium\|low`, 지반 자료가 없어 `high` 없음), `unknown[]`, `unknownReasons`, `unknownSummary[]`(하위 항목 포함, `entranceCandidates[].publicLand` 형태), `constraintUnknown`(`groundwater`, `soft-ground`, `utilities`), `warnings[]`, `sourceLayers[{layer,quality,name,license}]`, `license{pack,attribution}`, `model`(쓴 상수 전부) |

## 결측 규칙

값을 구할 수 없으면 **0이 아니라 `null`**, 이름을 `unknown[]`에, 사유를 `unknownReasons`에 적는다. 하위 항목(출입구·작업구·환승·연장)도 각자 `unknown[]`/`unknownReasons`를 가진다.

| 사유 | 뜻 |
|---|---|
| `no-layer` | 그 자료가 주입되지 않음 |
| `outside-coverage` | 자료는 있으나 그 자리를 덮지 못함(예: 건물·도로는 23구만) |
| `no-dem-value` | DEM이 덮이지만 그 칸에 값 없음 |
| `no-heading` | 방향을 알 수 없어 본체를 만들지 못함 → 겹침·경사·작업구·연장 모두 미상 |
| `no-alignment` / `no-connection` / `connection-unresolved` | 연결한 계획에서 선형을 못 얻음 / 연결 안 함 / 고른 계획·역이 지도 출력에 없음 |
| `no-depth` | 계획 역에 깊이가 없어 선로고를 못 구함 |
| `no-structure-height` | 고가·교량: 계획에 구조물 높이가 없음 |
| `no-attribute` | 도로 자료에 폭 속성이 없음 |
| `no-parcel-data` | 지적·소유 자료가 없어 공공용지 여부를 알 수 없음 |

- 자료가 덮고 대상이 없는 것은 사실이다: 겹침 0동, 근처 도로 없음(`nearestRoad: null`이지만 `unknown`에는 없음), 범위 안에 수요지점 없음(`[]`).
- **공공용지**: OSM에는 소유 정보가 없다. 공원·놀이터 등 열린 공간 안이거나 도로 가장자리(≤ 5 m)면 근거와 함께 `true`, 그 외는 "공공이 아니다"가 아니라 **`null` + `no-parcel-data`**.
- 연장 공간은 건물·수역 자료가 하나라도 없거나 덮지 못하면 `freeLengthMeters: null`이다(빠진 자료가 장애물을 숨길 수 있으므로 틀린 답보다 무응답).

## ID 규칙

- `key`가 있으면 `stationSiteId`는 팩ID+`key`에서 나온다. 이동·회전·크기 변경·이름 변경·삭제 후 복원·다시 열기에서도 같다. 편집기는 `station-1, station-2…` 중 **삭제된 것까지 포함해** 비어 있는 가장 작은 키를 준다(삭제한 키는 재사용하지 않음).
- `key`가 없으면 중심 좌표에서 나온다(이름·방향·크기·연결과 무관).
- 출입구 ID는 사이트 ID+출입구 `key`(없으면 좌표). 편집기는 사이트별 일련번호 `entrance-N`을 주며 삭제한 번호를 다시 쓰지 않는다. 그린 순서는 결과에 영향이 없다(ID 순 정렬).
- 환승 ID는 사이트 ID+대상 역 ID, 작업구 ID는 사이트 ID+슬롯(또는 `key`/정규화된 폴리곤).
- 삭제는 표시(`deleted`)만 하므로 복원하면 같은 ID가 돌아온다. 저장 문서(`{version, packId, packVersion, sites[]}`)는 다른 팩에는 적용하지 않고(`station-doc-other-pack`) 팩 버전이 다르면 경고(`pack-version-mismatch`)한다.

## 엔진 판정 표시 (엔진 → 지도, 읽기 전용)

지도 화면은 엔진이 돌려준 보고서로 만든 오버레이 모델만 읽어 역마다 한 단어를 표시한다. 지도가 판정하지 않는다.

| 엔진이 반환한 것 | 표시 |
|---|---|
| 그 역을 지목한 위반(`Station <id> …`) | 불가 |
| 그 역·계획의 누락 입력·조건부 판정 | 조건부 |
| 계획 기록 `approved`/`in-project`, 프로젝트 `estimated`/`approved` | 승인 |
| 프로젝트 `contracted`/`underConstruction`/`inspection` | 공사 중 |
| 프로젝트 `available`, 기록 `assets-available`/`commissioned` | 완공 |
| 프로젝트 `suspended` / `cancelled` | 공사 중단 / 사업 취소 (서로 다른 표시) |
| 아무것도 없음, 계획에 연결되지 않은 후보 | 표시 없음 |

## PlanGeometry와의 연결 검증

`connectedPlanId`/`connectedStationId`/`connectedSegmentIds`는 같은 `buildMapExport()` 결과의 `plans`에 있어야 한다. 없으면 연결 관련 값은 `null`, `warnings`에 `connection-plan-missing`/`connection-station-missing`. 예제 테스트는 `packs/<id>/station-examples`의 모든 연결이 같은 팩 `plan-examples`의 실제 ID를 가리키는지 확인한다.

## 예제

`packs/tokyo/station-examples/`(8), `packs/example-radial/station-examples/`(8), `packs/example-corridor/station-examples/`(1). 도쿄 예제는 계획 예제 `05-station-variants-scratch`(지상·고가·개착 12 m·대심도 38 m·실드 24 m·종착)를, 합성 팩은 `04-station-variants`와 환승 대상 `05-transfer-stub`을 연결한다.

| # | 종류 | 도쿄 | 합성 |
|---|---|---|---|
| 01 | 지상 상대식 일반역 | 세타가야 | 외곽 |
| 02 | 고가 섬식 일반역 | 메구로 | 내부 |
| 03 | 얕은 지하 개착역 | 시부야 12 m | 11 m |
| 04 | 깊은 지하역 | 신주쿠 38 m | CBD 36 m |
| 05 | 환승역 | 기존망 시나가와(그린 통로) | 다른 계획 역(그린 통로) |
| 06 | 종착·회차 후보 | 다이토 종점(양쪽 연장이 건물에서 막힘) | 외곽 종점 |
| 07 | 건물 충돌·출입구 확보 실패 | 신주쿠(출입구 셋이 모두 건물 위) | 조밀 블록 |
| 08 | 일부 레이어 없음 | 하치오지(건물·도로 자료 범위 밖) | 지형·도로만 |

자료: 고도·경사 국토지리원 DEM10B(31 m), 수역 국토수치정보, 건물·도로·토지 이용 OSM(ODbL-1.0, 23구 밖은 건물·도로 없음). 합성 팩은 `scripts/lib/synthetic-layers.mjs`가 만든 가상의 지형·강·도로·건물·공원(CC0-1.0)이며 실제 장소가 아니다.

## 알려진 한계

- **본체 크기는 자리표시다.** 플레이어가 조정하지 않으면 계획의 승강장 길이 또는 160×24 m로 충돌을 볼 뿐, 실제 역 규모가 아니다.
- **건물·도로는 23구뿐**, 그 밖은 `outside-coverage`. 도로 폭·차로 수는 자료에 없다. 지하 도로·고가 도로 구분 없이 도로를 센다.
- **공공용지 판정은 근거가 있을 때만**(공원류·도로 가장자리). 지적 자료가 없다.
- **지하수·연약지반·지장물(지하 매설물) 자료는 어떤 팩에도 없다**(`constraintUnknown`).
- 기존망 역 위치는 시구정촌 중심점이라 환승 거리는 거칠다(`low`). 실제 승강장·출입구 위치가 아니다.
- DEM은 31 m 평균 셀이라 얇은 절토·성토는 평균에 묻히고, 본체 하나의 경사는 셀 몇 개의 값이다.
- 연장 공간은 직선 400 m까지의 건물·수역만 본다(도로·지하 장애물·지형은 보지 않는다).
- 후보 문서는 브라우저 localStorage(팩별 키 `transitline.stations.v1:<packId>`)에만 저장된다.
- 일반 모드에서는 계획 노선(`planOnly`)이 지도에 없으므로 계획 역에 연결하려면 시나리오 모드에서 그려야 한다. 연결 없이 좌표만으로도 후보를 둘 수 있다.
