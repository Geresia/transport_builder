# 차량기지 후보지 출력 계약 (지도 → 경영 엔진)

지도가 차량기지 후보지의 **순수 공간정보**만 만들어 넘기는 계약이다. 토지비·건설비·주민반대·지자체 협상·회송 운영비·공사기간·후보지 점수는 경영 엔진이 계산하며, 이 코드는 그 값을 만들지 않고 `management`를 import하지도 않는다(테스트가 검사). PlanGeometry 쪽 규칙은 [map-plan-contract.md](map-plan-contract.md)와 같다.

## 코드 위치

| 파일 | 역할 |
|---|---|
| `engine/src/map/depot-site.mjs` | 후보지 → `DepotSiteGeometry`. 진입점 `buildDepotExport()` |
| `engine/src/map/depot-editor.mjs` | 후보지 문서(추가·이동·다시 그리기·삭제)와 저장·복원. 순수 데이터 |
| `engine/src/map/depot-view.mjs` | 부지·연결선·위험 마커·비교표·결측 경고 표시. 공사 상태 오버레이(`overlay.mjs`)와 분리 |
| `engine/src/map/depot-ui.mjs` | 브라우저 조작(그리기·끌어 옮기기·본선 선택·경유점·localStorage). 편집 화면 `#btn-depot` |
| `scripts/build-depot-examples.mjs` | 예제 생성(`npm run depot-examples`). 도쿄는 팩의 벡터 타일을 디코딩 |

## 입력 (플레이어가 지정한 것)

```js
{ key?, name?, polygon?: [[lon,lat]...], location?: [lon,lat],
  connect?: { planId?, segmentId?, externalNetworkId?, externalLineId?, via?: [[lon,lat]...] } }
```

- 부지는 폴리곤이거나 점이다. 점 후보는 면적·겹침을 알 수 없어 `null`이 된다.
- 연결할 본선은 지도가 내보낸 PlanGeometry의 `planId`(+ 선택적으로 `segmentId`) 또는 기존망의 `externalLineId`. `segmentId`를 생략하면 가장 가까운 구간을 고르고 `connectionBasis: "nearest-segment"`로 표시한다.
- `via`는 플레이어가 그린 입출고선 경유점(부지 → 본선 순서).

## 출력 `DepotSiteGeometry`

`schema: "transitline.depot-site-geometry/1"`, `contractVersion: 1`. `buildDepotExport()`는 `{ schema: "transitline.depot-export/1", packId, packVersion, sites[], warnings[] }`를 낸다(`depotSiteId` 순 정렬).

| 분류 | 필드 (단위) |
|---|---|
| 식별 | `depotSiteId`, `sourcePackId`, `sourcePackVersion`, `name`, `geometryKind`(`polygon`\|`point`) |
| 형상 | `location`(면적 중심), `polygon`(정규화된 열린 고리, 반시계), `areaSquareMeters`(m²) |
| 본선 연결 | `connectedPlanId`, `connectedSegmentId`, `connectedExternalNetworkId`, `connectedExternalLineId`, `connectionBasis`, `connectionAlignment`(부지 경계 → 경유점 → 접속점), `connectionAttachPoint`, `connectionTrackLengthMeters`(m, 그린 선형 길이), `distanceToMainlineMeters`(m, 경계~접속점 직선) |
| 역·종점 | `nearestStationId`/`nearestStationKind`(`plan`\|`external`)/`distanceToNearestStationMeters`(부지까지, 안이면 0), `terminalStationId`/`distanceToTerminalMeters`(연결한 본선의 가까운 종점까지 직선) |
| 지형 | `groundElevationMeters`(평균), `elevationRangeMeters`, `averageSlopePercent`, `maximumSlopePercent` (%, DEM 셀 경사각 → tan×100) |
| 겹침·횡단 | `intersectedBuildingCount`, `waterOverlapCount`, `roadsThroughSite{highway,major,minor}` — 부지가 겹치는 것. `connectionCrossings{river,road{…},railway,building,utility}`, `roadCrossingCount`, `waterCrossingCount` — 입출고선이 가로지르는 것 |
| 주변 | `distanceToResidentialMeters`(+`residentialBasis`, 검색반경 `residentialSearchRadiusMeters`=2000), `surroundingBuildingCount`, `surroundingBuildingDensity`(동/km², 부지 경계 300 m 안, 버퍼 넓이는 면적+둘레×r+πr²) |
| 재사용 | `existingFacilityReuse: { status: within\|overlaps\|adjacent\|none, facilities[{id,kind,relation,distanceMeters}] }` — 기존 철도부지와의 **공간 관계**만. 재사용 가능 여부의 판단은 엔진 몫 |
| 위험 | `spatialFlags[]`: `building-overlap`, `water-overlap`, `steep-site`(평균경사 ≥ 3%), `near-residential`(≤ 100 m), `connection-crosses-water`, `connection-through-buildings`. 사실 표시이지 점수가 아니다 |
| 자료 | `dataQuality`(`high\|medium\|low`), `unknown[]`, `unknownReasons{필드: 사유}`, `constraintUnknown`(지하수·연약지반), `warnings[]`, `sourceLayers[{layer,quality,name,license}]`, `license{pack,attribution}` |

## 결측 규칙

값을 구할 수 없으면 **0이 아니라 `null`**, 이름을 `unknown[]`에, 사유를 `unknownReasons`에 적는다.

| 사유 | 뜻 |
|---|---|
| `no-layer` | 그 자료가 주입되지 않음 |
| `outside-coverage` | 자료는 있으나 부지·주변을 덮지 못함 (예: 건물은 23구만) |
| `no-polygon` | 점 후보라 면적·겹침을 알 수 없음 |
| `no-connection` / `connection-unresolved` | 본선을 고르지 않음 / 고른 계획·구간·노선이 지도 출력에 없음 |
| `no-dem-value` | DEM에 값이 없는 칸(바다 등) |
| `no-stations`, `no-terminal` | 비교할 역이 없음 |

- 자료가 있고 덮이는데 대상이 없으면 그것은 사실이다: 겹침 0동, 검색반경 안에 주거지 없음(`distanceToResidentialMeters: null`이지만 `unknown`에는 없음).
- `dataQuality`는 미상 필드 수로 정하고, 지반 자료가 없어 현재는 `high`가 나오지 않는다.

## ID 규칙

- `key`가 있으면 `depotSiteId`는 팩ID+`key`에서 나온다. 이동·다시 그리기·이름 변경·본선 변경에도 유지되고 저장 후 다시 열어도 같다(편집기는 `depot-1, depot-2…` 중 비어 있는 가장 작은 키를 준다).
- `key`가 없으면 부지 모양에서 나온다. 폴리곤은 소수 6자리 반올림·중복점/닫는 점 제거·반시계·가장 낮은 꼭짓점부터로 정규화하므로 **그리는 순서·시작점·방향이 달라도 같은 부지는 같은 ID**다. 점 후보는 좌표로.
- 같은 ID가 두 번 나오면 하나만 내고 `duplicate-depot-site` 경고. 자기교차·퇴화 폴리곤은 경고(`polygon-self-intersecting`/`polygon-degenerate`)를 남기고 점 후보처럼 다룬다.
- 저장 문서(`{version, packId, packVersion, sites[]}`)는 다른 팩에는 적용하지 않고(`depot-doc-other-pack`), 팩 버전이 다르면 경고(`pack-version-mismatch`)한다.

## PlanGeometry와의 연결 검증

`connectedPlanId`/`connectedSegmentId`는 같은 `buildMapExport()` 결과의 `plans`에 있어야 한다. 없으면 연결 관련 값은 `null`, `warnings`에 `connection-plan-missing` / `connection-segment-missing` / `connection-line-missing`. 예제 테스트는 `packs/<id>/depot-examples`의 모든 연결이 같은 팩 `plan-examples`의 실제 planId·segmentId를 가리키는지 확인한다.

## 사용한 실제 자료 (도쿄 예제)

| 값 | 자료 | 라이선스 |
|---|---|---|
| 고도·경사 | 국토지리원 DEM10B, 31 m 평균 격자 | GSI 이용약관(출처 표기) |
| 수역 겹침·횡단 | 국토수치정보 수역 다각형(`barriers.json`) | MLIT-KSJ-terms |
| 건물 겹침·밀도·주거 건물 | OSM 건물(`tokyo-buildings.pmtiles`, z14) — 23구 | ODbL-1.0 |
| 주거지역, 기존 철도부지 | OSM `landuse=residential`/`railway`(`areas.pmtiles`, z14) — 관동 전역 | ODbL-1.0 |
| 도로 | OSM 도로(`roads.all.geojson`) — 23구 | ODbL-1.0 |

`engine/src/map/`은 이 자료를 담지 않는다. 호출하는 쪽이 레이어로 주입하고(`LICENSING.md` rule 2), 각 후보지에 쓴 레이어의 이름·라이선스와 팩 라이선스를 `sourceLayers`/`license`에 남긴다.

## 알려진 한계

- **건물·도로는 23구뿐.** 그 밖(예: 하치오지)은 `outside-coverage`로 `null`.
- **기존 차량기지 자료는 없다.** `existingFacilityReuse`는 OSM `landuse=railway` 부지와의 공간 관계이고, 실제 차량기지인지·소유자·유휴 여부는 알 수 없다.
- 벡터 타일은 타일 경계에서 잘려 있다. 건물은 왼쪽 위 모서리 규칙으로 한 번만 세지만, 넓은 철도부지·주거지 조각은 잘린 채여서 걸친 부지의 `within`이 `overlaps`로 나올 수 있다.
- DEM은 31 m 평균 셀이라 부지 안의 얇은 절토·성토·제방은 평균에 묻힌다. 점 후보의 경사는 한 셀의 값이다.
- 주거지 거리는 직선거리이며 소음·진동·시야는 다루지 않는다.
- 지하수·연약지반·지장물 자료가 어떤 팩에도 없다(`constraintUnknown`).
- 편집 화면에서는 팩의 무거운 데이터를 불러오지 않으므로 기하만 계산되고(면적·본선거리·연결선·최근접 역), 지형·겹침·주거·밀도는 `미상`으로 표시된다. 값이 채워진 결과는 예제 생성 스크립트 경로에서 나온다.
- 편집기는 일반 모드에서는 기존망 노선에만 연결할 수 있다. 계획 노선(`planOnly`)은 시나리오 모드에서 그린 것만 계획으로 내보내진다.
- 후보지 문서는 브라우저 localStorage(팩별 키)에만 저장된다.
