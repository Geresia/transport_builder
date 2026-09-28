# 공사 구역·공정 지도 계약 (지도 → 경영 엔진)

노선을 공사 공구(터널/개착/고가·교량/전력·신호·궤도/역/차량기지)로 나누고, 각 공구의 **공간 사실만** 계약으로 낸다. 공사비·기간·사고확률·민원점수·공법 추천은 경영 엔진이 계산하며, 이 코드는 그 값을 만들지 않고 `management`를 import하지도 않는다(테스트가 검사). PlanGeometry·StationSiteGeometry·DepotSiteGeometry와 같은 규칙([map-plan-contract.md](map-plan-contract.md), [station-site-contract.md](station-site-contract.md), [depot-site-contract.md](depot-site-contract.md))을 쓴다.

## 코드 (모두 `engine/src/map/`)

| 파일 | 역할 |
|---|---|
| `construction-site.mjs` | 공구 → `ConstructionSiteGeometry`. 진입점 `buildConstructionExport()` |
| `construction-editor.mjs` | 공구 문서: 추가·구간 이동·분할·병합·삭제·복원, 저장·복원. 순수 데이터 |
| `construction-view.mjs` | 엔진이 반환한 공사 단계(착공 전/공사 중/지연/일시중단/시험 중/완료/취소) 읽기 전용 표시, 공정률에 따른 완성·미완성 구간 구분, 사고·민원·자재 부족 마커 |
| `construction-ui.mjs` | 브라우저 조작(구간 선택으로 공구 만들기, 분할, 이동, 병합, 삭제) |
| `construction-selection.mjs` | 공사용 후보지(수직구·작업장·자재 적치장·공사용 도로 진입점·차량 반입 지점) 선택 코어 |
| `construction-selection-view.mjs` | 선택 후보 강조, 후보 사실 읽기 전용 패널 |
| `construction-selection-ui.mjs` | 후보 선택 브라우저 마운트(독립 API, `main.mjs`/`index.html`/`style.css` 불필요) |
| `scripts/build-construction-examples.mjs` | 예제 생성(`npm run construction-examples`) |

## 공구(package) 종류

| kind | 뜻 | 연결 입력 |
|---|---|---|
| `tunnel` | 터널 공구(수직구 후보 포함) | `planId` + `segmentIds[]` |
| `cutCover` | 개착 공구 | `planId` + `segmentIds[]` |
| `viaduct` | 고가·교량 공구 | `planId` + `segmentIds[]` |
| `systems` | 전력·신호·궤도 설치 구간 | `planId` + `segmentIds[]` |
| `station` | 역 공구 | `planId` + `stationId`(계획의 역 후보 ID) |
| `depot` | 차량기지 공구 | `depotSiteId`(DepotSiteGeometry의 ID) |

선분(구간) 공구는 한 계획(`PlanGeometry`)의 **구간(segment) 단위**로 나눈다. 구간은 이미 안정 ID를 가지므로 공구 경계는 항상 구간 경계와 일치하며, 임의의 중간 지점에서 끊지 않는다.

## 공구 편집 (`construction-editor.mjs`)

- **추가**: `addPackage(doc, { kind, planId, segmentIds })` 등. 편집기는 `package-1, package-2…` 중 삭제된 것까지 포함해 비어 있는 가장 작은 키를 준다.
- **구간 이동**("경계 이동"): `reassignSegment(doc, fromKey, toKey, segmentId)` — 한 구간을 인접한 같은 계획의 공구로 옮긴다.
- **분할**: `splitPackage(doc, key, atSegmentId, order)` — `order`(계획의 구간 ID 순서)를 기준으로 지정한 구간부터 새 공구로 나눈다. 새 공구는 새 키(새 ID)를 받는다.
- **병합**: `mergePackages(doc, keyA, keyB, order)` — 같은 계획·같은 kind인 두 공구의 구간을 합쳐 `keyA`에 남기고 `keyB`는 완전히 지운다(복원 불가 — 병합은 삭제와 달리 그 공구가 더는 존재하지 않는다는 뜻이므로).
- **삭제·복원**: `removePackage`/`restorePackage` — 표시(tombstone)만 하므로 복원하면 같은 ID가 돌아온다.
- **저장·복원**: `serializeConstructionDoc`/`restoreConstructionDoc` — 다른 팩에는 적용하지 않고(`construction-doc-other-pack`), 팩 버전이 다르면 경고(`pack-version-mismatch`).

## 출력 `ConstructionSiteGeometry`

`schema: "transitline.construction-site-geometry/1"`, `contractVersion: 1`. `buildConstructionExport()`는 `{ schema: "transitline.construction-export/1", packId, packVersion, sites[], warnings[] }`를 낸다(`constructionSiteId` 순 정렬).

| 분류 | 필드 (단위) |
|---|---|
| 식별·연결 | `constructionSiteId`, `sourcePackId`, `sourcePackVersion`, `kind`, `name`, `coordinateReference`, `connectedPlanId`, `connectedSegmentIds[]`, `connectedStationId`, `connectedDepotSiteId` |
| 형상 | `polygon`(공사구역 폴리곤: 구간 공구는 선형을 감싼 리본 코리도, 역·차량기지 공구는 역 발판/차량기지 자체 폴리곤), `areaSquareMeters`, `lengthMeters`(구간 공구만, 역·차량기지는 `null`) |
| 지형 | `groundElevationMeters`, `elevationRangeMeters`, `averageSlopePercent`, `maximumSlopePercent` |
| 겹침 | `intersectedBuildingCount`, `waterOverlapCount`, `roadsOccupied{highway,major,minor}`, `existingFacilityCrossingCount`(기존 철도·차량기지 부지 겹침) |
| 주변 | `distanceToResidentialMeters`(+`residentialBasis`, 검색반경 `residentialSearchRadiusMeters`=300 m) |
| 횡단(구간 공구만) | `waterCrossingCount`+`waterCrossings[{location}]`, `roadCrossingCount`+`roadCrossings[{location,class}]`, `existingRailwayCrossingCount`+`existingRailwayCrossings[{location}]` — 개수는 겹친 항목 수(같은 것을 두 번 지나도 1건), 위치는 실제 교차점 전부(최대 `model.maxCrossingLocations`=10건) |
| 공사용 후보지 | `shaftCandidates[]`(터널 공구만, 시작·끝 포탈), `workAreaCandidates[]`(구간 양끝 또는 역·차량기지 발판 사방), `materialYardCandidates[]`(구간을 따라 간격 배치 또는 발판 옆 1곳), `accessRoadCandidates[]`(경계에서 가까운 도로), `vehicleAccessCandidates[]`(경계에서 가까운 **주요** 도로만) |
| 위험 | `spatialFlags[]`: `building-collision`, `water-overlap`, `existing-facility-overlap`, `near-residential`(≤100 m), `steep-corridor`(평균경사 ≥3%), `crosses-water`, `crosses-existing-railway`. 사실 표시이지 점수가 아니다 |
| 자료 | `dataQuality`, `unknown[]`, `unknownReasons`, `constraintUnknown`(지하수·연약지반·지장물), `warnings[]`, `sourceLayers[]`, `license`, `model`(코리도 폭·후보지 크기 등 쓴 상수 전부) |

역·차량기지 공구는 `waterCrossingCount` 등 "횡단" 계열 필드를 아예 내지 않는다(경로가 없으므로 개념 자체가 적용되지 않음 — 결측이 아니라 해당 없음). 부지 겹침 계열(`intersectedBuildingCount` 등)은 모든 kind에 적용된다.

## 결측 규칙

값을 구할 수 없으면 **0이 아니라 `null`**, 이름을 `unknown[]`에, 사유를 `unknownReasons`에 적는다. `no-layer`(레이어 미주입), `outside-coverage`(자료가 그 자리를 덮지 못함), `no-dem-value`, `no-depth`(계획에 깊이 자료 없음) 등 기존 계약과 같은 어휘를 쓴다. 자료가 덮고 대상이 없으면 그것은 사실이다(겹침 0, 횡단 0).

## 공사 단계 표시 (엔진 → 지도, 읽기 전용)

`buildConstructionView(exp, report)`가 공구별로 한 단계를 고른다.

| 반환 | 표시 |
|---|---|
| `report.constructionPackages[constructionSiteId]`(공구별 상세, 엔진이 아직 안 줄 수도 있음) | 있으면 최우선 |
| 없으면 `report.projects[]`의 그 계획 프로젝트 상태 | `estimated/approved`→착공 전, `contracted/underConstruction`→공사 중(`delayMonths>0`→지연), `inspection`→시험 중, `available`→완료, `suspended/halted`→일시중단, `cancelled`→취소 |
| 둘 다 없음 | 상태 불명(추정하지 않음) |

공사 중일 때 `progress`(0~1)가 있으면 코리도 폴리곤을 완성 구간(`doneRing`, 초록)과 미완성 구간(`remainingRing`, 단계 색)으로 나눠 그린다. `report.constructionMarkers: [{constructionSiteId, kind: "incident"|"complaint"|"material-shortage", location?, message?}]`를 그대로 마커로 표시한다 — 위치·확률·점수를 지도가 계산하지 않는다.

## 공사용 후보지 선택 (`construction-selection*.mjs`)

수직구·작업장·자재 적치장·공사용 도로 진입점·차량 반입 지점 중 **하나**를 선택한다(다중 선택 아님 — 다시 누르면 해제). 출력 `transitline.construction-selection/1`:

```js
{ schema, contractVersion: 1, packId,
  constructionSiteId, kind, candidateId,   // 없으면 모두 null
  facts }   // 그 후보의 공간 사실(위치 또는 폴리곤, 면적, 도로 거리, 수직구 깊이 등) — id 자체는 제외
```

경영 엔진에는 후보 ID와 공간 사실만 전달되고 비용·점수는 없다. `mountConstructionSelection({canvas, projection, getConstructionExport, onChange})`으로 붙이며, station-selection과 같은 패턴(자체 오버레이 캔버스·패널, DOM 이벤트 `transitline:construction-selection`, `setEnabled(false)`로 다른 도구와 전환).

## ID 규칙

- `key`가 있으면 `constructionSiteId`는 팩ID+`key`. 구간 이동·저장 후 다시 열기에도 유지된다.
- `key`가 없으면 구간 공구는 `kind`+`planId`+구간 ID 집합(순서 무관, 계획 순서로 정렬해 해시), 역 공구는 `planId`+`stationId`, 차량기지 공구는 `depotSiteId`에서 나온다.
- 분할로 생긴 새 공구는 항상 새 키(새 ID)를 받는다. 병합으로 사라진 공구의 ID는 되살아나지 않는다.
- 후보지(수직구 등) ID는 `constructionSiteId`+슬롯/좌표에서 나와 공구가 같은 입력으로 재생성되는 한 안정적이다.

## PlanGeometry·StationSiteGeometry·DepotSiteGeometry와의 연결 검증

`connectedPlanId`/`connectedSegmentIds`/`connectedStationId`는 같은 `buildMapExport()` 결과의 `plans`에 있어야 하고, `connectedDepotSiteId`는 호출자가 넘긴 `depotExport`(`buildDepotExport()`의 결과)에 있어야 한다. 없으면 그 공구는 `null`이 되고 `warnings`에 `connection-plan-missing`/`connection-segment-missing`/`connection-station-missing`/`connection-depot-missing`이 남는다. 예제 테스트는 `packs/<id>/construction-examples`의 모든 연결이 같은 팩의 실제 plan-examples(및 depot-examples)를 가리키는지 확인한다.

## 예제

`packs/tokyo/construction-examples/`(9), `packs/example-radial/construction-examples/`(9), `packs/example-corridor/construction-examples/`(3). 도쿄는 계획 예제 `05-station-variants-scratch`(지상/고가/개착/대심도/실드 5개 구간)와 `02-east-river-crossing-existing`(스미다강 횡단), 차량기지 예제 `01-ota-railway-land-existing`에 연결한다. 합성 팩은 자체 `04-station-variants` 계획과 생성 레이어(`scripts/lib/synthetic-layers.mjs`)를 쓴다.

| # | 종류 | 설명 |
|---|---|---|
| 01 | 일반 도심 터널 | 실드 구간, 수직구 2곳 |
| 02 | 좁은 개착 구간 | 개착 구간 |
| 03 | 하천 횡단 | 실드 구간이 하천을 가로지름(`waterCrossings` 다건) |
| 04 | 주거지 인접 고가 | 고가 구간, `near-residential` |
| 05 | 깊은 터널 수직구 | 대심도 구간, 수직구 깊이 계산됨 |
| 06 | 차량기지 연결 공사 | `depot` kind, DepotSiteGeometry 폴리곤 재사용 |
| 07 | 역 공구 | `station` kind |
| 08 | 전력·신호·궤도 설치 구간 | `systems` kind, 노선 전체(긴 구간이라 일부는 자료 범위 밖) |
| 09 | 일부 공간자료가 없는 사례 | 레이어 전혀 주입하지 않음 — 전부 `null`+사유 |

## 알려진 한계

- **코리도 폴리곤은 근사 리본 버퍼다.** 실제 굴착·개착 단면이 아니며, 급커브에서는 폭이 줄거나 자기교차할 수 있다.
- 역·차량기지 공구의 "발판"은 실제 역 설계가 아니다(역 공구는 60 m 고정 패드; 차량기지 공구는 DepotSiteGeometry 폴리곤을 그대로 쓴다).
- 횡단 개수는 **닿은 항목 수**이며, 위치는 최대 10건까지만 낸다.
- `전력·신호·궤도` 공구처럼 노선 전체를 감싸는 긴 구간은 단일 레이어 커버리지(도쿄는 23구, 합성 팩은 팩 생성 범위)를 벗어나기 쉬워 결측이 흔하다.
- 지하수·연약지반·지장물 자료는 어떤 팩에도 없다(`constraintUnknown`).
- 공사 단계는 엔진이 공구 단위 상세(`constructionPackages`)를 아직 안 줄 수 있어, 그 경우 계획 전체 프로젝트 상태로 대신 표시한다(공구별 정밀도가 떨어질 수 있음).
- 공구 문서는 브라우저 localStorage(팩별 키)에만 저장된다.
