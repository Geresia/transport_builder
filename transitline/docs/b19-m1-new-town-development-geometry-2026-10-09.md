# B19-M1 신도시 개발 공간 계획 지도 계약 — 인수 문서

플레이어가 "어디에 어떤 신도시 개발 구역을 만들 것인가"를 지도 위에서 설계·저장·복원하는 **순수 지도 계약**이다(`transitline.new-town-development-geometry/1`). 기준은 master `f21ad75`, 브랜치 `b19-m1-new-town-development-geometry`(커밋하지 않음). B19 설계 메모(`b19-new-town-rail-development-design-2026-10-05.md`)의 금지 규칙을 그대로 따른다: 계획 인구를 승객·수익으로 바꾸지 않고, 지도 데이터가 없는 토지 소유·지하 조건·입주율을 확정 사실로 만들지 않는다.

## 경계

- **계산하지 않는다**: 인구, 주택 수, 수요, 비용, 토지 가격, 사업성, 공기, 점수, 입주율, 시격·용량. 출력 키에 그런 낱말이 없고(테스트가 낱말 단위로 검사), 팩의 수요 노드가 가진 `residents`/`jobs` 숫자는 복사하지 않는다(노드의 **위치 관계**만 낸다).
- **판정하지 않는다**: 기존 철도·역·도로에 가까운 것은 **거리**이지 "연결 가능"이 아니다. `railAccessCandidates`는 그 구역과 거리 관계가 있는 선로 목록이며, 접속을 보장하거나 권하는 값이 아니다. 구역 안에 수요 노드가 없다는 것도 "수요 0"이 아니다.
- **없는 것은 null + 이유**: 레이어가 없거나 범위 밖이면 `null`이고 `unknown[]`에 이름, `unknownReasons`에 이유가 있다. `0`/`false`/`[]`는 "덮는 레이어에 그것이 없다"는 **측정값**일 때만 쓴다.
- 읽기 전용: 입력(그림 문서, 맵 export, 팩, 레이어)을 바꾸지 않고(얼린 입력 테스트), 출력은 입력과 객체를 공유하지 않는다. 시계·난수·저장소를 쓰지 않는다. management를 import하지 않는다(소스 검사 테스트). `main.mjs`, `index.html`, `style.css`, `scenario-runtime.mjs`, `management/**`는 수정하지 않았다.

## 파일

| 파일 | 역할 |
|---|---|
| `engine/src/map/new-town-development.mjs` | 계약 빌더 `buildNewTownDevelopment`, `buildNewTownDevelopmentExport`, ID 함수, 상수 |
| `engine/src/map/new-town-development-editor.mjs` | 편집 문서(생성·다각형 편집·단계 생성/순서 변경·비활성/복원·삭제), `serializeNewTownDoc`/`restoreNewTownDoc` |
| `scripts/build-new-town-examples.mjs` | 예제 생성기 (`npm run new-town-examples`, `--out <dir>`로 재생성 검사) |
| `packs/{tokyo,example-radial,example-corridor}/new-town-development-examples/*.new-town.json` | 예제 7개 |
| `engine/test/new-town-development-geometry.test.mjs` / `engine/test/new-town-development-editor.test.mjs` | 12개 / 10개 |

독립 UI는 만들지 않았다. 편집기는 문서(순수 객체)이고, 저장은 `serializeNewTownDoc(doc)`가 주는 문자열을 호출자가 보관한다(편집기는 `localStorage` 등 저장소를 쓰지 않는다).

## 계약 필드

### development

| 필드 | 값 | 비고 |
|---|---|---|
| `schema`, `contractVersion` | `"transitline.new-town-development-geometry/1"`, `1` | |
| `developmentId` | `new-town:<16 hex>` | 팩 ID + `key`로 결정. 이름·순서·도형과 무관 |
| `developmentRevision` | `new-town-revision:<16 hex>` | 도형·선언·단계 순서가 바뀌면 바뀜. **이름은 포함하지 않음** |
| `sourcePackId`, `sourcePackVersion` | 문자열 / 문자열·null | |
| `key`, `name`, `active` | 플레이어의 key, 이름(null 가능), 활성 여부 | |
| `phaseCount`, `activePhaseCount` | 정수 | 기록된 사실(0이 가능) |
| `location`, `boundingBox` | `[lon,lat]`, `[w,s,e,n]` 또는 null | **다각형 있는 활성 단계** 기준(면적 가중 중심). 일부 단계만 다각형이 있으면 경고 `location-covers-only-phases-with-polygon` |
| `phaseAreaSumSquareMeters` | m² 또는 null | 활성 단계 자기 면적의 **합**. 겹침은 두 번 세어짐(이름이 "sum"인 이유) |
| `phases[]` | 아래 | `sequence` 순 |
| `spatialFlags[]` | 아래 단계 플래그의 합집합 | 사실 표지이며 점수·판정이 아님 |
| `sourceLayers[]` | `{layer, quality, name, license}` | 실제 읽은 레이어만 |
| `dataQuality` | `high`/`medium`/`low` | 지도로 알 수 없던 값의 개수만 센다. 플레이어가 말하지 않은 값은 세지 않는다. `constraintUnknown` 때문에 `high`는 나오지 않는다 |
| `unknown[]`, `unknownReasons{}` | 필드 이름 목록 / `{필드: 이유}` | 기존 계약(`depot-site` 등)과 같은 객체 형식 |
| `constraintUnknown[]` | `land-ownership`, `underground-conditions`, `zoning-and-permits`, `occupancy-rate` | 어떤 팩에도 없는 사실 — 부재를 "문제 없음"으로 읽지 말 것 |
| `warnings[]` | `{code, …}` | |
| `license` | `{pack, attribution[]}` | |

### phase

| 필드 | 값 | 비고 |
|---|---|---|
| `phaseId` | `new-town-phase:<16 hex>` | 개발 ID + 단계 `key` |
| `phaseRevision` | `new-town-phase-revision:<16 hex>` | 이름 제외 |
| `key`, `name`, `active` | | |
| `sequence` | 1..n | **플레이어가 정한 순서**(편집기의 단계 목록 위치). 순서 변경이 바꾸는 값. 비활성 단계도 자리를 가진다 |
| `polygon` | 정규화된 링(`[lon,lat]`, 반시계, 최저 꼭짓점 시작) 또는 null | 변이 교차하거나 퇴화하면 null + 이유 |
| `location`, `areaSquareMeters`, `perimeterMeters` | | 다각형이 없으면 null |
| `playerDeclaredLandUse` | 문자열 또는 null | **플레이어의 말 그대로**(앞뒤 공백만 제거, 64자 이하). 제안 어휘 `housing` `employment` `mixed` `public-space` `commercial` `education` `civic` `transport-facility` `utility` `reserved`; 그 밖의 낱말도 받되 경고 `land-use-not-in-suggested-vocabulary` |
| `playerDeclaredDeliveryOrder` | 1 이상 정수 또는 null | 플레이어가 말한 인도(공급) 순서. `sequence`와 다를 수 있고 같은 값이 겹쳐도 된다. 말하지 않으면 null + `not-stated` |
| `stationSiteRefs` | 목록 / `[]` / null | 플레이어가 지정한 역 부지 참조(계획 역 후보 또는 기존 역). `null`=말하지 않음, `[]`=없다고 말함. 항목: `{stationId, stationKind, location, insideArea, distanceMeters}` |
| `railAccessCandidates` | 목록 / `[]` / null | 반경 2,000 m 안의 계획 구간·기존 노선 + 플레이어가 지정한 노선. 항목: `{refKind, planId, segmentId, externalNetworkId, externalLineId, declaredByPlayer, relation, distanceMeters}`, `relation` = `within`/`crosses`/`near`/`beyond-search-radius`(지정했으나 멀리 있음). 가까운 8개까지 |
| `roadAccessCandidates` | 목록 / `[]` / null | 반경 300 m 안의 도로(구역을 지나는 도로 포함). 항목: `{roadRefId, roadClass, relation: through-area/near, distanceMeters}`. `roadRefId`는 도로 레이어 항목에서 결정적으로 만든 ID |
| `spatialFacts` | 아래 | |
| `spatialFlags[]` | `building-overlap` `outside-pack-bbox` `overlaps-other-phase` `roads-through-area` `station-inside-area` `water-overlap` | 측정된 것만. 레이어가 없으면 플래그도 없다(깨끗하다는 뜻이 아님) |
| `sourceLayers[]`, `dataQuality`, `unknown[]`, `unknownReasons{}`, `warnings[]` | | |

### spatialFacts (단계별)

| 필드 | 값 | null이 되는 이유 |
|---|---|---|
| `withinPackBoundingBox` | true/false | `no-polygon`/`no-pack-bbox` |
| `stationsInside` | `[{stationId, stationKind}]` | `no-polygon`, `no-station-data` |
| `nearestPlannedStation`, `nearestExistingStation` | `{stationId, distanceMeters}` (안에 있으면 0) | `no-planned-stations`, `no-existing-stations`, `no-station-data` |
| `demandNodeRefsInside` | 노드 ID 목록. **`[]`는 "기록된 노드 위치가 안에 없다"일 뿐 수요 0이 아니다** | `no-demand-nodes-in-pack` |
| `nearestDemandNode` | `{nodeId, distanceMeters}` | 위와 같음 |
| `roadsThroughArea` | `{highway, major, minor}` 개수 | `no-layer`, `outside-coverage` |
| `waterOverlapCount`, `intersectedBuildingCount` | 겹치는 레이어 항목 수(0 가능) | `no-layer`, `outside-coverage` |
| `groundElevationMeters`, `elevationRangeMeters`, `averageSlopePercent`, `maximumSlopePercent` | DEM이 있을 때만 | `no-layer`, `no-dem-value` |
| `overlapsPhaseIds` | 같은 개발의 겹치는 단계 ID | `no-polygon` |
| `railSearchRadiusMeters`, `roadSearchRadiusMeters` | 2000, 300 | |

이유 어휘: `no-polygon` `polygon-degenerate` `polygon-self-intersecting` `polygon-invalid-coordinates` `no-layer` `outside-coverage` `no-dem-value` `no-station-data` `no-planned-stations` `no-existing-stations` `no-rail-data` `no-demand-nodes-in-pack` `no-pack-bbox` `not-stated` `invalid` `no-active-phase` `active-phase-without-polygon`.

경고 코드: `polygon-*`, `land-use-invalid`, `land-use-not-in-suggested-vocabulary`, `delivery-order-not-a-positive-integer`, `station-ref-missing`/`-ambiguous`, `station-refs-invalid`, `rail-ref-missing`, `rail-refs-invalid`, `phase-no-key`, `phase-duplicate-key`, `development-has-no-phase`, `location-covers-only-phases-with-polygon`; export: `development-no-key`, `duplicate-development`.

## ID 규칙

- `developmentId = f(packId, key)`, `phaseId = f(developmentId, phaseKey)`. **이름 변경, 배열 순서, 다각형 수정, 단계 순서 변경은 ID를 바꾸지 않는다**(테스트로 고정). 다른 팩은 다른 ID.
- 단계 순서는 입력 배열의 위치가 아니라 명시한 `sequence`(편집기가 써 줌)로 정한다. 같은 입력을 어떤 순서로 줘도 출력 JSON이 같다.
- `key`는 평생 유지되고 다시 쓰이지 않는다: 삭제한 개발·단계는 문서에 **묘비**(`deleted: true`)로 남고, 카운터(`town-N`, `phase-N`)는 올라가기만 한다. 저장본에서 카운터가 줄어 있어도 불러올 때 남은 key로 다시 계산한다. 직접 준 key가 묘비와 겹치면 거절한다. 검증에서 거절된 단계는 key를 쓰지 않는다.

## 편집기 (`new-town-development-editor.mjs`)

| 함수 | 하는 일 |
|---|---|
| `newNewTownDoc(packId, packVersion?)` | 빈 문서 `{version:1, packId, packVersion, developments:[]}` |
| `addDevelopment` / `updateDevelopment` / `deactivateDevelopment` / `restoreDevelopment` / `removeDevelopment` / `moveDevelopment` | 개발 구역 생성(key `town-N` 또는 지정), 이름 변경, 끄기·켜기(잃지 않음), 묘비 삭제, 모든 단계 평행이동 |
| `addPhase` / `updatePhase` / `setStationRefs` / `setRailRefs` | 단계 생성(key `phase-N`), 이름·land use·인도 순서 변경, 역 부지·노선 지정(`null`/`[]`/목록) |
| `setPolygon` / `insertVertex` / `moveVertex` / `removeVertex` / `movePhase` | 다각형 편집(3점 미만·비유한 좌표는 거절하고 아무것도 바꾸지 않음) |
| `reorderPhase(doc, key, phaseKey, toIndex)` | 단계 순서 변경(key·ID 불변, `sequence` 변경). 묘비는 뒤에 남음 |
| `deactivatePhase` / `restorePhase` / `removePhase` | 끄기·켜기·묘비 삭제 |
| `toDrawnDevelopment(dev)` / `drawnDevelopmentsOf(doc)` | 빌더 입력으로 변환(삭제 제외, 비활성 포함·`active:false`, `sequence` 기록) |
| `serializeNewTownDoc(doc)` / `restoreNewTownDoc(text, pack, {current})` | 문자열 저장·복원. 읽을 수 없는 문서, 다른 버전, **다른 팩 문서는 거절**하고 `current`를 그대로 둔다(`rejected: true`). 같은 팩의 다른 버전은 `pack-version-mismatch` 경고와 함께 받는다 |

입력으로 준 객체는 복사해서 저장하므로 호출자가 나중에 고쳐도 문서는 바뀌지 않는다.

## 엔진으로 넘길 최소 ID 목록 (지도 → 엔진)

| ID | 의미 | 안정성 |
|---|---|---|
| `developmentId` | 개발 구역 | key로 결정, 영구 |
| `developmentRevision` | 그 구역의 현재 그림 | 이름 제외, 그림·선언·순서가 바뀌면 바뀜 → 엔진의 오래된 계획 판별용 |
| `phaseId`, `phaseRevision` | 단계와 그 단계의 그림 | 위와 같음 |
| `phases[].sequence`, `playerDeclaredDeliveryOrder` | 지도상 순서 / 플레이어가 말한 인도 순서 | 둘은 별개 |
| `sourcePackId`, `sourcePackVersion` | 팩 | 다른 팩 문서 거절의 기준 |
| `stationSiteRefs[].stationId` (+`stationKind`) | 플레이어가 지정한 역 부지 | 계획 역 후보 ID(`stn:…`) 또는 기존 역 ID |
| `railAccessCandidates[]`의 `planId`+`segmentId` / `externalNetworkId`+`externalLineId` | 거리 관계가 있는 선로 | B16 서비스 계획·B13 구간 ID와 같은 공간 |
| `spatialFacts.demandNodeRefsInside[]`, `nearestDemandNode.nodeId` | 구역과 겹치는 수요 노드의 **ID** | 수요 값은 엔진이 자기 엔진에서 읽는다 |
| `roadAccessCandidates[].roadRefId` | 도로 후보 | 도로 레이어 항목의 결정적 ID |

## Codex 연결 입출력 표

| 방향 | 대상 | 내용 |
|---|---|---|
| 입력(UI → 편집기) | 편집 문서 `doc` | 위 편집기 함수 호출. UI는 문서를 보관하고 `serializeNewTownDoc(doc)` 결과를 자기 저장소에 넣는다 |
| 입력(저장소 → 편집기) | `restoreNewTownDoc(text, pack, {current})` | `rejected`/`warnings`를 사용자에게 알린다 |
| 입력(UI → 빌더) | `drawnDevelopmentsOf(doc)` | |
| 입력(맵 파이프라인 → 빌더) | `mapExport = { plans, externalNetworks }`(`buildMapExport` 결과) | 계획 역·구간, 기존 역·노선 |
| 입력(팩 → 빌더) | `pack`(`manifest`, `demand.points`) | 위치만 읽음 |
| 입력(레이어 → 빌더) | `spatial = makeSpatialContext({ dem?, water?, roads?, buildings? })` | 없는 레이어는 그냥 빼면 null + `no-layer` |
| 출력(빌더 → 엔진/UI) | `buildNewTownDevelopmentExport({ pack, mapExport, developments, spatial })` → `{schema:"transitline.new-town-development-export/1", packId, packVersion, developments[], warnings[]}` | `developments`는 `developmentId` 순 |
| 출력(엔진 → UI) | (B19-2 이후) `developmentId`/`phaseId`로 상태를 붙여 보여 준다 | 이 모듈은 상태를 갖지 않는다 |

B19 엔진(수요 엔진 연결·입주율·재원)은 이 계약을 **읽기만** 하면 되고, 위 ID로 자기 상태를 연결한다. 이 계약에는 엔진 상태(입주율, 인구, 공급량)를 넣는 자리가 없다.

## 예제

`npm run new-town-examples`(또는 `node scripts/build-new-town-examples.mjs [packId] [--out dir]`)가 만든다. 모두 편집기로 그린 뒤 저장·복원을 거친 문서에서 만들며, `source`에 편집 문서와 빌더 입력, 사용한 레이어를 적는다. 시각·난수를 쓰지 않고, 레이어는 **커밋된 파일만** 읽어 기기와 무관하게 같은 바이트가 나온다(테스트가 임시 폴더에 재생성해 바이트 비교).

| 팩 | 예제 | 보여 주는 것 |
|---|---|---|
| tokyo | 01 에도가와 해안 2단계 / 02 하치오지 구릉 혼합 / 03 고토 매립지(기존 노선 지정, 비활성 단계) | 기존 노선·역과의 거리, 수역(`barriers.json`) 겹침, 도로·DEM은 null + `no-layer` |
| example-radial | 01 합성 연못·도로와 2단계 / 02 미선언·순서 변경·비활성·삭제된 key / 03 계획 역을 둘러싼 겹치는 단계 | 측정된 플래그, null 사유, 삭제한 `phase-3`이 다시 쓰이지 않음, 역 내부 |
| example-corridor | 01 회랑 구역 | 최소 예 |

radial 01의 연못·도로는 손으로 쓴 **합성** 레이어이며 `sourceLayers.name`에 그렇게 적혀 있다.

## 검증

- 계약 12개: 필드·ID, 같은 입력 = 같은 바이트(배열 순서·이름 변경·꼭짓점 시작/방향·맵 순서에도 ID 불변, 도형 수정은 revision만 변경), 측정값(역·철도·도로·수역·건물·지형·팩 범위·겹침), 레이어 없음/범위 밖/빈 답(`null`+이유 / `null`+이유 / 실제 0·`[]`), 팩이 갖지 못한 자료, 플레이어 선언(`null`/`[]`/목록, 잘못된 값), 쓸 수 없는 다각형 5종, 단계 없음·모두 끔·잘못된 key, 얼린 입력과 출력 비공유, 금지어·management import·시계·난수 없음, 예제 7개와 재생성 바이트 비교.
- 편집기 10개: 키가 올라가기만 함·삭제한 key 재사용 금지(저장·복원 후, 카운터 손상 후 포함), 다각형 편집과 거절 시 불변, 순서 변경, 끄기·켜기 무손실, 이름·선언 변경, 참조 복사, 직렬화 왕복, **다른 팩·버전·손상 문서 거절과 현재 문서 보존**, 저장소·시계·import 없음.

## 데이터 한계

- 거리·교차는 **직선 근사**다: 기존 노선은 역과 역을 잇는 선(실제 선형이 아님, `sourceLayers`에 `quality: "low"`로 표시), 계획 구간은 그린 선형이다. 지하·고가·실제 접속 가능성은 모른다.
- 도로·건물·수역·DEM은 팩이 가진 범위만 안다. Tokyo 예제는 수역만 쓰고 건물(4개 구 발자국)·도로·DEM은 로컬 자료라 의도적으로 넣지 않았다 → 해당 사실은 null이다.
- 수요 노드는 **위치만** 쓴다. 노드가 구역 안에 없거나 팩에 노드가 없다는 것은 수요에 대해 아무것도 말하지 않는다.
- 토지 소유, 지하 조건, 용도지역·인허가, 입주율은 어떤 팩에도 없다(`constraintUnknown`).
- 면적은 구역 중심 위도의 평면 근사(오차 약 0.5% 안쪽, 큰 구역일수록 커짐)이며, 단계 면적의 합은 겹침을 두 번 센다.
- `railAccessCandidates`/`roadAccessCandidates`는 가까운 순 8개까지만 담는다(플레이어가 지정한 노선은 항상 포함).
- 단계의 `sequence`와 `playerDeclaredDeliveryOrder`의 일관성은 검사하지 않는다(플레이어의 선언이므로).
- 합성 팩·Tokyo 예제로만 확인했고 실제 신도시 계획으로는 확인하지 않았다.
