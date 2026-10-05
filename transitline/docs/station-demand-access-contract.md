# 역 접근권·수요권 공간 계약 `transitline.station-demand-access-geometry/1`

B15-M1. 한 역의 **출입구, 도보 접근점, 환승 통로, 플레이어가 그린 접근권 경계, 생활권 수요 구역**이 어디에 있고, 플레이어가 그린 **보행 연결**이 그것들을 어떻게 잇는지를 공간 사실로만 낸다. 기존 수요·OD 자료는 **출처와 품질만** 연결한다.

## 경계

- 지도는 공간 사실만 낸다. 승객 수, 운임, 혼잡, 노선 선택, 도보 시간, 점수, 비용, 확률은 **어떤 것도 계산하지 않는다.** 경영 엔진과 운행 시뮬레이션(`management`, `scenario-runtime`, `state`)을 import하지 않고 읽기 전용이다(테스트로 고정: import는 `./이름.mjs`와 `../projection.mjs`뿐, 경영 이름·시계·난수·파일 접근 없음).
- 걸음 **시간**(`walkMinutes`)은 내지 않는다. 같은 이유로 `walkingDistance × 우회계수` 같은 추정도 하지 않는다. 지도가 내는 것은 그려진 선의 **길이(m)** 와 직선거리뿐이다. 시간과 혼잡은 엔진이 길이를 입력으로 받아 계산한다.
- 출력에는 승객·운임·혼잡·시간·점수·확률을 뜻하는 **키가 없다**(테스트: 이름 정규식으로 전체 출력을 훑는다). 수요 자료의 **값**(거주자·종사자·OD 인원)도 어디에도 복사하지 않는다(테스트: 픽스처의 고유 숫자가 출력 문자열에 없음).
- 값을 알 수 없으면 `null` + `unknown[]` + `unknownReasons`. `0`, `false`, `[]`로 바꾸지 않는다. `unknown[]`과 `unknownReasons`는 항상 1:1이고 `unknown`에 든 값은 `null`이다. 레이어가 그 장소를 덮는데 아무것도 없으면 그것은 사실이다(`0`, `[]`).
- **연결되어 있지 않다**와 **걸을 수 없다**는 다르다. 플레이어가 선을 안 그린 것은 `drawnConnection: { connected: false }`이고, 그 자체로 접근 불가를 뜻하지 않는다(실제 도로가 있을 수 있다). 판정은 엔진의 몫이다.

## 파일

| 파일 | 역할 |
|---|---|
| `engine/src/map/station-demand-access.mjs` | `buildStationDemandAccess`, `buildStationDemandAccessExport`, `demandSourceRefsOf`, `stationAccessIdOf`, 스키마·열거 상수 |
| `engine/src/map/station-demand-access-editor.mjs` | 순수 데이터 편집·저장·복원 (역은 삭제하지 않고 비활성, 요소는 삭제하되 키 재사용 없음) |
| `scripts/build-station-demand-access-examples.mjs` | 예제 생성 (`npm run station-demand-access-examples`, `--out <dir>`) |
| `packs/*/station-demand-access-examples/` | 예제 10개 (radial 5, corridor 2, tokyo 3) |
| `engine/test/station-demand-access.test.mjs` | 계약·편집·저장·예제 재생성 테스트 |

## 입력

```
drawn: { key?, name?, connect?: { planId, stationId } | { externalNetworkId, stationId }, location?: [lon,lat],
         entrances?:    [{ key?, name?, location }],
         accessPoints?: [{ key?, name?, location, kind? }],            // kind: street | crossing | plaza | bus-stop | other
         walkLinks?:    [{ key?, name?, from: End, to: End, via?: [[lon,lat]...], widthMeters? }],
         transfers?:    [{ targetStationId, via?: [[lon,lat]...], fromEntranceKey?, widthMeters? }],
         catchments?:   [{ key?, name?, polygon, entranceKey? }],       // 접근권 경계
         demandZones?:  [{ key?, name?, polygon, kind? }] }             // 생활권 수요 구역; kind: residential | employment | mixed | school | visitor | other
End:   { kind: "station" } | { kind: "entrance" | "access-point" | "demand-zone", key }
ctx:   { pack, spatial, plans, externalNetworks, demandNodes?, demandSources? }
```

- 역의 자리는 `location`(플레이어) → 연결한 계획 역 → 연결한 기존 역 순으로 정한다. 어느 것도 없으면 만들지 않는다(`null`, 내보내기에서 `station-no-location`).
- `plans`, `externalNetworks`, `demandNodes`는 `buildMapExport` 결과(`plans`, `externalNetworks`, `demandNodes`)를 그대로 넘긴다. `spatial`은 기존 `makeSpatialContext(layers)`다. 내보내기는 기존 규칙대로 `withRailLayer`로 철도 레이어를 더한다(blank map에는 외부 철도가 없으므로 그 교차 0은 사실).
- `demandNodes`를 안 넘기면(`null`) 수요 노드 관련 필드는 미상이고, 빈 배열을 넘기면 "팩에 수요 노드가 없다"는 사실이다.
- 보행 연결·접근점·구역은 **키로 서로를 가리킨다.** 키가 없는 요소(좌표로 ID가 정해지는 요소)는 참조될 수 없다. 편집기는 항상 키를 준다.

## 거부와 경고

만들지 않음: 자리가 없다(`buildStationDemandAccess`는 `null`, 내보내기는 `station-no-location`).
경고(해당 항목만 빠지거나 비움, 나머지는 만든다):

| 코드 | 의미 |
|---|---|
| `connection-plan-missing`, `connection-network-missing`, `connection-station-missing`, `connection-target-missing` | 연결 대상을 못 찾음 (자리는 `location`으로 만들 수 있으면 만든다) |
| `station-location-invalid` | `location` 형식이 틀림 |
| `entrance-no-location`, `access-point-no-location`, `duplicate-entrance`, `duplicate-access-point` | 출입구·접근점 |
| `access-point-kind-invalid`, `demand-zone-kind-invalid` | 열거에 없는 종류 — 항목은 만들고 `kind: null`(`not-provided`) |
| `demand-zone-degenerate`, `catchment-degenerate`, `duplicate-demand-zone`, `duplicate-catchment` | 점 3개 미만·면적 0·스스로 교차하는 다각형 |
| `catchment-entrance-missing` | 출입구 범위 경계인데 그 출입구가 없음 (경계를 버린다) |
| `walk-link-endpoint-missing`, `walk-link-same-endpoints`, `walk-link-via-invalid`, `duplicate-walk-link` | 보행 연결 (연결을 버린다) |
| `width-invalid` | 폭이 양수 아님 — 폭 `null`(`width-invalid`) |
| `transfer-target-missing`, `transfer-via-invalid`, `transfer-entrance-missing` | 환승 통로 (출입구를 못 찾으면 역 중심에서 시작하고 경고) |
| `external-station-locations-coarse` | 기존 역 위치가 수요 노드 중심(시구 중심)이라 거침 |

요소를 지워도 그것을 가리키던 보행 연결·환승 통로·경계는 문서에 남는다. 지도는 그것을 `…-missing` 경고로 알리고 출력에서만 뺀다. 편집기의 `referencesTo`가 지우기 전에 무엇이 가리키는지 알려 준다.

## 출력 (사이트)

| 필드 | 의미 |
|---|---|
| `schema`, `contractVersion`, `stationAccessId`, `stationAccessRevision`, `sourcePackId`, `sourcePackVersion` | `stationAccessRevision`은 공간 사실(자리·요소·연결·경계·구역·출처 연결)만 해시한다 |
| `name`, `location`, `locationBasis` | `"player"` / `"plan-station"` / `"external-station"` |
| `stationKind` | `"plan"` / `"external"` / `"free"`(연결 없음) |
| `connectedPlanId`, `connectedStationId`, `connectedNetworkId`, `offsetFromConnectedStationMeters` | 연결이 없으면 `null` + `no-connection`, 못 풀면 `connection-unresolved` |
| `entrances[]` | `entranceId`, `key`, `name`, `location`, `distanceToStationMeters`, `insideBuildingCount`, `insideWaterCount`, `roadsNearby`(`{highway,major,minor}`, 60 m), `spatialFlags`(`inside-building`, `in-water`), `linkedWalkLinkIds` |
| `accessPoints[]` | 위와 같고 `accessPointId`, `kind`, `drawnConnection` |
| `walkLinks[]` | `walkLinkId`, `from`/`to`(`{kind,id}`), `alignment`(그린 선, 양 끝 포함), `alignmentBasis: "player"`, `lengthMeters`, `straightDistanceMeters`, `widthMeters`(플레이어가 준 값, 없으면 `null`), `crossings`(`river`/`road`/`railway`/`building`/`utility`, 기존 `spatial.crossings`) |
| `transfers[]` | `transferId`, `basis`(`"nearby"` 500 m 이내 직선 / `"player-passage"` 그린 통로), `target…`(역·종류·네트워크·선·위치·위치 근거), `from`, `alignment`, `alignmentBasis`, `straightDistanceMeters`, `passageLengthMeters`, `widthMeters`, `crossings` |
| `catchments[]` | `catchmentId`, `scope`(`"station"`/`"entrance"`, 후자는 `entranceId`), `polygon`(정규 링), `polygonBasis: "player"`, `areaSquareMeters`, `containsStation`, `containsEntranceIds`, `containsAccessPointIds`, `demandZoneIds`(겹치는 구역), `demandNodeIdsInside`, `buildingCount`, `waterOverlapCount`, `spatialFlags`(`excludes-station`, `excludes-own-entrance`) |
| `demandZones[]` | `demandZoneId`, `kind`, `polygon`, `areaSquareMeters`, `centroid`, `buildingCount`, `waterOverlapCount`, `demandNodeRefs`(구역 안의 수요 노드: `demandNodeId`, `name`, `location`, `nodeKind`, `fieldsPresent`), `nearestDemandNode`, `nearestEntrance`, `demandSourceRefIds`, `linkedWalkLinkIds`, `drawnConnection`, `spatialFlags` |
| `demandSourceRefs[]` | 수요·OD 파일의 **출처** 연결(아래) |
| `spatialFlags` | `no-entrance-drawn`, `entrance-inside-building`, `no-catchment-drawn`, `catchment-excludes-station`, `no-demand-zone-drawn`, `demand-zone-without-walk-link`, `access-point-without-walk-link`, `walk-through-buildings`, `walk-crosses-river`, `walk-crosses-railway`, `external-station-locations-coarse` — 사실 표식이며 판정이 아니다 |
| `model`, `dataQuality`, `unknown[]`, `unknownReasons`, `warnings`, `sourceLayers`, `license` | `model`은 측정에 쓴 상수(환승 반경 500 m, 도로 탐색 60 m). `unknown`은 하위 항목의 미상까지 `컬렉션:ID:필드` 경로로 모은다 |

내보내기: `{ schema: "transitline.station-demand-access-export/1", packId, packVersion, sites[], catchmentOverlaps[], inactive[], warnings[] }`.
`catchmentOverlaps[]`는 **서로 다른 역**의 접근권 경계가 땅을 공유하는 쌍 `{ stationAccessIds, catchmentIds }`이다. 겹침을 어떻게 나눌지(수요 배분)는 엔진의 몫이다.

### 보행 연결의 의미 (`drawnConnection`)

접근점과 구역에만 있다. 역과 모든 출입구를 한 점("역 쪽")으로 보고, 플레이어가 그린 `walkLinks`만 간선으로 하여 그 점에서 가장 짧은(그려진 길이 합) 경로를 찾는다.

- 닿으면 `{ connected: true, lengthMeters, linkIds }` — 길이는 그려진 선의 합(0.1 m).
- 못 닿으면 `{ connected: false }` — **키가 `connected` 하나뿐**이다. 길이를 `0`/`null`로 채우지 않는다.
- 같은 길이면 ID 순으로 정해 결정적이다.

### 수요·OD 자료 연결

`demandSourceRefsOf(documents, packId)`는 `[{ file, kind, document, attribution?, spatialResolution?, quality?, license? }]`를 받아 **파일이 스스로 밝힌** `formatVersion`, `model`, `source`, `unit`만 복사한다. 파일 안의 값(거주자, 종사자, OD 인원)은 읽지도 합치지도 않는다.

- `kind`: `demand-points` / `od-commute` / `od-school` / `special-demand` / `other`.
- `spatialResolution`과 `quality`(`high`/`medium`/`low`)는 **호출자가 말한다**(생성 스크립트는 도쿄 수요 노드가 시구 중심이라 `low`로 적는다). 열거에 없는 품질은 `null`(`not-assessed`). 파일이 밝히지 않은 `source`/`unit`/`model`은 `null`(`not-stated-in-file`).
- 구역의 `demandNodeRefs`는 "이 노드가 구역 안에 있다"와 "그 노드가 가진 필드 이름"(`fieldsPresent`)만 낸다. 값은 팩 파일에 있고, 엔진이 `demandNodeId`로 찾아 쓴다.
- 구역 안에 노드가 없으면 `demandNodeRefs: []`(사실, `no-demand-node-inside`)이고 가장 가까운 노드는 `nearestDemandNode`로 낸다. 시구 중심 노드는 작은 구역 안에 거의 들지 않는다 — 이것이 이 자료의 한계다.
- **품질**: 사이트 `dataQuality`는 그림 자체의 미상 수(이름·폭·수요 출처 메타데이터 제외)와 연결한 수요 출처 중 가장 낮은 품질 중 나쁜 쪽이다. 출처를 안 넘기면 `demandSourceRefs: null`(`no-source-supplied`)이다.

## ID

모두 결정적이다(시계·난수·그린 순서 없음). 키가 있으면 키로, 없으면 위치로 정한다.

| ID | 구성 |
|---|---|
| `stationAccessId` | `stn-access:` + 팩 + 키(없으면 위치). 계획 역이 아니라 **그림의 키**를 따른다 |
| `entranceId`, `accessPointId`, `walkLinkId`, `catchmentId`, `demandZoneId` | `acc-ent`, `acc-pt`, `acc-walk`, `acc-catch`, `acc-zone` + `stationAccessId` + 키(없으면 좌표/양 끝+경유점) |
| `transferId` | `acc-xfer` + `stationAccessId` + 대상 역 ID |
| `sourceId` | `demand-source` + 팩 + 파일 이름 |

이동·이름 변경·순서 변경·저장·다시 열기로 키 있는 요소의 ID는 바뀌지 않는다. 같은 입력은 바이트까지 같은 출력이다.

## 편집과 저장 (`station-demand-access-editor.mjs`)

플레이어가 **접근권 경계**와 **보행 연결**을 지정·수정하는 순수 데이터 함수다. 문서는 `{ version: 1, packId, packVersion, stations[] }`.

| 하고 싶은 일 | 함수 |
|---|---|
| 문서·역 | `newStationDemandAccessDoc`, `addStation`(키를 주면 그 키, 이미 쓰였으면 오류), `updateStation`, `removeStation`/`restoreStation`(비활성), `activeStations` |
| 출입구·접근점·구역·경계·보행 연결 추가 | `addEntrance`, `addAccessPoint`, `addDemandZone`, `addCatchment`, `addWalkLink` (`addElement`로 일반화) |
| 수정 | `updateElement`(키는 못 바꾼다), `moveElement`(점), `removeElement` |
| 경계·구역 다각형 | `moveVertex`, `insertVertex`, `removeVertex`(3점 미만 불가) |
| 보행 연결 | `setWalkLinkVia`(굽이), `setWalkLinkEnds`(양 끝) |
| 환승 통로 | `setTransfer`(대상 역당 하나, 다시 부르면 교체), `clearTransfer` |
| 역 전체 | `moveStation`, `rotateStation` — 담긴 모든 점이 함께 움직이고 ID는 그대로 |
| 참조 | `referencesTo` — 이 요소를 가리키는 연결·통로·경계 목록(지우기 전 확인용) |
| 지도 입력 | `toDrawnStation(station)` → `buildStationDemandAccess` / `…Export`의 `stations[]` |
| 저장·복원 | `serializeStationDemandAccessDoc`, `restoreStationDemandAccessDoc(text, pack)` |

- 요소 키는 `entrance-3`, `walk-link-1`처럼 **올라가기만 하는 카운터**(`station.seq`)로 준다. 지운 키는 다시 주지 않으므로, 지운 출입구를 가리키던 연결이 다른 출입구에 붙는 일이 없다.
- 복원 거부: 읽을 수 없음 `station-demand-access-doc-unreadable`, 버전·모양 틀림 `…-doc-version`, 다른 팩 `…-doc-other-pack` — 거부하면 빈 문서(해당 팩)를 돌려주고 호출자의 현재 문서는 건드리지 않는다. 팩 버전만 다르면 `pack-version-mismatch` 경고와 함께 그림은 그대로 불러온다(숨기지 않는다).

## 예제 (`packs/*/station-demand-access-examples/`)

| 팩 | 예제 |
|---|---|
| example-radial | `01-full-drawing`(출입구·접근점·보행 연결·경계·구역 전부), `02-entrance-through-buildings`(출입구·연결이 건물 위), `03-zone-and-points-without-links`(연결 없음, 경계가 역을 벗어남), `04-transfer-passage`(다른 계획의 역으로 가는 통로), `05-partial-layers`(지형·도로만 있음) |
| example-corridor | `01-no-layers`(레이어 없음 → 레이어 사실이 모두 미상), `02-nothing-drawn`(아무것도 안 그림) |
| tokyo | `01-shinjuku-inside-building-coverage`(건물 자료가 있는 구역), `02-ward-station-outside-coverage`(기존망 모드, 건물 자료 밖, 수요 노드가 구역 안에 듦, 시구 중심이라 거친 환승), `03-external-station-no-drawing`(기존 역에 연결, 그림 없음) |

모든 예제 파일은 `source`에 어떻게 만들었는지(`case[]`, `synthetic: true`, `note`, 레이어 출처, 입력 그림, `generatedBy`)를 적는다. **그림(출입구·연결·경계·구역)은 손으로 놓은 합성이며 실제 역의 것이 아니다.** 도쿄 예제의 공간 레이어는 저장소에 추적되는 것(물 `barriers.json`, 건물 `obstacles.json` 4개 구)만 쓴다. DEM과 도로는 git 제외 개발 자료라 쓰지 않아 그 사실이 미상으로 나온다. 수요·OD 파일은 출처·품질로만 연결한다. 테스트가 생성 스크립트를 임시 폴더에 돌려 모든 예제와 바이트까지 같은지 확인한다.

## Codex가 연결해야 할 것

지도 쪽은 계약·편집·저장·예제까지다. 아래는 `main.mjs`/엔진 쪽 일이다(이 브랜치는 건드리지 않았다).

1. **문서 보관**: 통합 저장 필드에 `serializeStationDemandAccessDoc(doc)` 문자열을 넣고, 불러올 때 `restoreStationDemandAccessDoc(text, pack)`를 부른다. 경고는 화면에 알린다. B14 파이프라인의 통합 저장 봉투에 다섯 번째 문서로 넣는 것이 자연스럽다.
2. **사이트 만들기**:
   ```js
   const mapExport = buildMapExport({ pack, mode, drawnLines, spatial });                 // 기존 호출 그대로
   const demandSources = demandSourceRefsOf(                                              // 팩 파일 헤더만 읽는다
     [{ file: "demand.json", kind: "demand-points", document: pack.demand, attribution, spatialResolution, quality }, ...], packId);
   const access = buildStationDemandAccessExport({ pack, mapExport, stations: activeStations(doc).map(toDrawnStation), spatial, demandSources });
   ```
   `access.sites[]`가 입력이다. 계획이나 지형이 바뀔 때마다 다시 만들면 된다(순수·결정적).
3. **엔진이 쓰는 법** (여기서부터는 경영 엔진/시뮬레이션의 계산이다):
   - 걸음 시간·혼잡·접근 용량은 `walkLinks[].lengthMeters`, `transfers[].passageLengthMeters`, `widthMeters`(알 때만)를 입력으로 엔진이 계산한다. 지도는 시간을 주지 않는다.
   - 접근권 경계는 `catchments[].polygon`과 `containsStation`, `demandNodeIdsInside`로 엔진이 수요 노드를 고른다. 인구·종사자 값은 `demandNodeId`로 팩 파일에서 찾는다.
   - 역 연결은 `connectedPlanId`/`connectedStationId`/`connectedNetworkId`로 엔진의 역과 잇는다(`stationKind: "free"`는 연결 없음).
   - `catchmentOverlaps`의 수요 배분 규칙은 엔진이 정한다.
4. **화면(선택)**: 이 브랜치에는 오버레이·패널(`…-view.mjs`, `…-ui.mjs`)이 **없다.** 지도 위에서 그리는 마운트는 B14 마운트(`map-mount-kit.mjs` 패턴)처럼 편집기 함수를 부르면 되고, 경계·연결 편집 도구가 필요하면 후속 작업이다.

## 한계

- 수요 자료가 거칠다: 도쿄 `demand.json`은 시구 중심점이고 `od.json`/`od-school.json`은 시구 간 표다. 작은 접근권 구역 안에는 노드가 거의 들지 않으므로 역 단위 수요는 이 계약만으로는 나오지 않는다. 품질을 `low`로 적고 그 사실을 `demandSourceRefs[].quality`·`spatialResolution`으로 보인다. 건물·소지역 수요(`building-population.json`, `subward*.json`)는 아직 연결하지 않았다.
- 레이어는 팩이 가진 만큼이다: 도쿄 건물 자료는 4개 구뿐이고 DEM·도로는 개발 환경에만 있다. 레이어가 없거나 덮지 않으면 해당 사실은 `null` + 이유다.
- 출입구의 공공용지 여부, 지하 통로의 실제 구조, 보행로 폭·계단·승강기는 자료가 없다. 폭은 플레이어가 말한 값만 싣는다. 지하 매설물(`crossings.utility`)은 어느 팩에도 자료가 없어 항상 `null` + `no-dataset`이고, 품질 계산에는 넣지 않는다.
- 기존 역의 위치는 시구 중심이라 거칠다(`external-station-locations-coarse`). 그 환승은 `dataQuality: "low"`다.
- 접근점의 `kind`(버스 정류장 등)는 플레이어의 표지일 뿐 다른 교통수단의 자료가 아니다.
- 이 브랜치는 지도 계약만이다. 수요·혼잡·운임 계산, 화면, 저장 연결은 하지 않았다.
