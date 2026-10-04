# 철도 용량 공간 사실 계약 `transitline.rail-capacity-geometry/1`

B13-M5. 철도 운영 모델(시간표·폐색·분기·종착 진로)이 지도에서 받아야 하는 **공간 사실만** 낸다. 물리 구간과 그 연결, 한 구간 안의 폐색 경계와 신호 위치 후보, 분기기·평면교차, 종착 승강장과 회차·인상·유치선 후보, 선로 공간 제약이다.

## 경계

- 지도는 공간 사실만 계산한다. 수송력·시격·시간표·해방시간·처리량·회차시간, 비용·공기·현금·사고 확률·지연, possible/impossible 같은 판정은 전부 경영 엔진의 몫이다. 이 모듈은 경영 엔진을 import하지 않는다(테스트로 고정). 출력에는 `trainsPerHour`, `capacity`, `headway`, `timetable`, `verdict`, `cost`, `delay` 같은 이름의 필드가 없다(테스트가 키를 검사한다).
- 값을 알 수 없으면 `null` + `unknown[]` + `unknownReasons`. `0`, `false`, `[]`로 바꾸지 않는다. `unknown[]`과 `unknownReasons`는 모든 항목에서 1:1이고, `unknown`에 든 값은 항상 `null`이다.
- **어느 팩에도 단선/복선, 신호, 폐색 경계, 분기기, 종착 자료가 없다.** 이 값들은 플레이어(또는 이름이 붙은 출처)가 명시한 경우에만 존재하며 `basis`로 표시한다. 역, 운영사 태그, 노선 이름으로 추정하지 않는다. 운영사·소유자는 출력에 싣지 않는다.

## 파일

| 파일 | 역할 |
|---|---|
| `engine/src/map/rail-capacity-geometry.mjs` | `buildRailGeometry`, `buildRailGeometryExport`, `planRevisionOf`: 구간·폐색·신호 후보·제약·개정·ID |
| `engine/src/map/rail-capacity-facilities.mjs` | 분기기·평면교차(진로 조합)와 종착(승강장·회차선) 계산 |
| `engine/src/map/rail-capacity-editor.mjs` | 순수 데이터 편집·저장·복원 |
| `engine/src/map/rail-capacity-view.mjs` | 표시 모델, 캔버스 오버레이, 패널, 범례 |
| `scripts/build-rail-capacity-examples.mjs` | 예제 생성 (`npm run rail-capacity-examples`, `--out <dir>`) |
| `packs/*/rail-capacity-examples/` | 예제 14개 (tokyo 3, radial 8, corridor 3) |

## 입력

```
drawn: {
  key?, name?,
  planIds: [planId...],                  // PlanGeometry v1 (필수, 1개 이상)
  externalLineIds?: [extLineId...],      // 기존선: 역 단위 구간(선형 없음)
  throughRouteId?,                       // ThroughRouteGeometry v1 연결
  designedRevisions?: { plans: { [planId]: planRevision }, routes: { [throughRouteId]: geometryRevision } },
  sectionFacts?: [{ ref, directionMode?: "single"|"double", basis: "player"|"source", sourceName?, designedGradientPermille? }],
      // ref = { planId, segmentId } 또는 { externalLineId, fromStationId, toStationId }
  blockBoundaries?: null | [{ key?, planId, segmentId, measuredFromStationId, alongMeters, basis, sourceName? }],
  junctions?: null | [{ key?, kind: "turnout"|"crossing", location, connections: [{ planId, segmentId, role }], handoverId? }],
  terminals?: null | [{ key?, stationId, platforms?: [{ key?, approach, polyline, platformLengthMeters?, viaJunctionKeys? }],
                        turnbackTracks?: [{ key?, kind: "turnback"|"pull-out"|"stabling", polyline, viaJunctionKey? }] }]
}
ctx: { pack, plans, externalNetworks?, routes?, stationSites?, spatial? }
```

- `blockBoundaries`, `junctions`, `terminals`, 터미널의 `platforms`/`turnbackTracks`: **없음(null/생략) = 자료 없음, `[]` = "없다"고 플레이어가 선언**. 선언한 빈 목록은 사실이고, 없는 자료는 미상이다.
- `alongMeters`는 `measuredFromStationId`(그 구간의 두 끝역 중 하나)에서 잰 거리다. 어느 끝에서 재든 같은 경계이며 그린 방향에 의존하지 않는다.
- 분기기 `role`: turnout은 `stem/main/branch`, crossing은 `a1/a2/b1/b2`(a1·a2는 한 선의 양쪽, b1·b2는 다른 선의 양쪽).
- `externalNetworks`를 주면 기존 철도 레이어(역 사이 직선, 조잡, 품질 `low`)가 만들어진다. 안 주면 `existingRailwayCrossingCount`는 `null`(`no-layer`).

## 거부와 경고

거부(`design: null`): `plans-missing`, `plan-missing`, `plan-other-pack`, `external-line-missing`, `through-route-missing`.
항목 단위 경고(그 항목만 버림): `section-fact-section-missing`, `direction-mode-invalid`, `gradient-invalid`, `boundary-section-missing`, `boundary-station-invalid`, `boundary-position-invalid`, `boundary-basis-invalid`, `boundary-duplicate`, `junction-kind-invalid`, `junction-location-invalid`, `junction-section-missing`, `junction-role-invalid`, `junction-role-duplicate`, `junction-handover-missing`, `terminal-station-missing`, `platform-polyline-invalid`, `platform-approach-missing`, `platform-junction-missing`, `turnback-kind-invalid`, `turnback-polyline-invalid`, `turnback-junction-missing`, `external-station-missing`, `revision-stale`, `revision-not-recorded`.

## 출력 필드 전체

### 설계 전체

| 필드 | 의미 |
|---|---|
| `schema`, `contractVersion`, `railGeometryId`, `railGeometryRevision`, `key`, `sourcePackId`, `sourcePackVersion`, `name`, `coordinateReference` | `railGeometryRevision`은 공간 사실만 해시(이름 제외) |
| `planIds`, `planRevisions[{planId, planRevision}]`, `externalLineIds` | 연결 대상 |
| `throughRouteId`, `routeGeometryRevision` | 직통 경로 연결(없으면 null) |
| `revision` | `{ state: "current"\|"stale"\|"not-recorded", mismatches[], missing[] }` |
| `sections[]` | 물리 구간 |
| `blocks[]`, `signalCandidates[]`, `signalSystem` | 폐색, 신호 위치 후보. `signalSystem`은 항상 `null`(`signal-system-not-in-source`) |
| `junctions[]`, `terminals[]` | 분기기·평면교차, 종착 |
| `closureTargets[]` | `{ sectionId, blockIds, lengthMeters }`: 공사·장애 때 폐쇄 대상으로 지목할 수 있는 구간 ID와 그 안의 블록 ID. 폐쇄 가능 여부 판단이 아니라 지목에 쓸 ID와 길이다 |
| `spatialFlags[]` | 공간 사실 표식(점수 아님) |
| `dataQuality`, `unknown[]`, `unknownReasons`, `warnings`, `sourceLayers`, `license` | `unknown`은 `section:<id>:<field>`, `junction:<id>:<field>`, `terminal:<id>:…` 같은 경로 문자열로 하위 항목의 미상까지 모은다 |

### 물리 구간 `sections[]`

계획 노선의 segment 하나, 또는 기존선의 연속 역 쌍 하나가 구간 하나다.

| 필드 | 의미 |
|---|---|
| `sectionId` | `stableId("rail-section", packId, "plan", planId, 정렬된 두 끝역 ID)` (기존선은 `ext`, 네트워크·선·정렬된 두 역). 방향이 있는 `segmentId`가 아니라 끝역 쌍이라, 계획을 반대로 그려도 같다 |
| `sourceKind` | `"plan"` \| `"external"` |
| `planId`, `segmentId`, `externalNetworkId`, `externalLineId`, `throughLegIds` | 연결 ID. `throughLegIds`는 직통 경로가 있을 때 그 구간을 지나는 leg(없는 경로면 `null`, `no-through-route`) |
| `fromStationId`, `toStationId`, `startLocation`, `endLocation` | 구간 양끝 |
| `alignment`, `lengthMeters` | 선형과 길이. 기존선은 `null`(`external-alignment-not-in-source`) |
| `ends[]` | `{ endpoint: "start"\|"end", stationId, location, joinedSectionIds, nearSectionIds, externalSectionIdsAtStation, state }` |
| `directionMode`, `directionModeBasis`, `directionModeSource` | `"single"`/`"double"`은 명시된 때만. 없으면 `null`(`track-count-not-stated`, 기존선은 `external-track-data-not-in-source`) |
| `minimumCurveRadiusMeters`, `structureHint`, `structureHintBasis` | PlanGeometry segment가 낸 값 그대로(직선은 100000). 구조 hint의 `basis`로 플레이어 지정인지 추정인지 구분한다 |
| `groundGradientPermille` | 계획이 낸 **지반** 구배(양 끝 고도 차). 선로 구배가 아니다 |
| `designedGradientPermille` | 플레이어가 지정한 설계 구배만. 없으면 `null`(`track-profile-not-designed`) |
| `buildingIntersectionCount`, `waterCrossingCount`, `roadCrossingCount`, `roadCrossingsByClass`, `existingRailwayCrossingCount` | 이번 호출의 레이어로 **다시 잰** 횡단 수. 레이어 없음·범위 밖은 `null` |
| `blockIds`, `junctionResourceIds` | 구간 안의 블록, 구간에 닿는 분기기. 자료가 없으면 `null` |

`ends[].state`: **true** = 이 설계의 다른 구간 중 측정된 선형이 1 m 이내에서 만난다. **false** = 50 m 이내에 다른 구간이 없고 같은 역 ID의 기존선 구간도 없다(이 설계 안의 구간만 본다). **null** = 1~50 m는 `endpoints-near-not-joined`, 같은 역 ID에 기존선 구간이 있으면 `external-alignment-not-in-source`, 이 구간이 선형이 없으면 `external-alignment-not-in-source`. 기존선과 같은 역 ID라는 사실은 접속의 증거가 아니다.

### 폐색 `blocks[]` 와 신호 후보 `signalCandidates[]`

폐색 자료가 없으면(`blockBoundaries` 생략) `blocks`·`signalCandidates`는 `null`(`no-block-data`)이다. **구간 하나 = 폐색 하나로 임의 생성하지 않는다.** `blockBoundaries: []`로 선언하면 구간마다 폐색 하나(`declaredWithoutIntermediateBoundary: true`)다. 기존선 구간은 선형이 없어 폐색을 둘 수 없다.

| 필드 | 의미 |
|---|---|
| `blockId` | `stableId("rail-block", sectionId, 두 경계 ref를 정렬)`. 경계 ref는 `key:<key>`, 키가 없으면 `at:<거리>`, 구간 끝은 `station:<역ID>` |
| `sectionId`, `startAlongMeters`, `endAlongMeters`, `blockLengthMeters`, `startLocation`, `endLocation` | 구간 시작점 기준 거리와 위치. 한 구간의 블록 길이 합 = 구간 길이 |
| `startBoundary`, `endBoundary` | `{ kind: "section-end"\|"boundary", boundaryId, basis: "player"\|"source"\|null, sourceName }`: 폐색 경계의 근거 |
| `declaredWithoutIntermediateBoundary`, `signalCandidateIds` | |

`signalCandidates[]`: 명시된 경계마다 양쪽 끝역을 향한 후보 하나씩. `{ signalCandidateId, sectionId, boundaryId, alongMeters, location, facingStationId, protectsBlockId, basis, sourceName }`. `protectsBlockId`는 그 신호가 바라보는 쪽의 블록이다. 신호가 실제로 있다는 뜻이 아니라 경계에서 신호를 세울 수 있는 위치 후보다. 신호방식은 어디에도 추정하지 않는다.

### 분기기·평면교차 `junctions[]`

| 필드 | 의미 |
|---|---|
| `junctionResourceId` | 경영 엔진의 `junctionResourceIds[]`에 대응. `key`가 있으면 `stableId("rail-junction", packId, "key", key)`, 없으면 종류와 `역할=구간ID`들에서 파생(연결 순서·위치·이름 무관) |
| `key`, `kind`, `turnoutId`, `crossingId`, `location`, `handoverId` | `handoverId`는 직통 경로에 실제로 있을 때만 |
| `connections[]` | `{ sectionId, role, distanceToSectionMeters, alongMeters, remainingToFarEndMeters, attached }`: 연결된 물리 구간과 분기기의 위치(구간 시작점 기준 거리, 먼 끝까지 남은 거리). `attached`는 아래 |
| `sectionIds`, `missingRoles` | 닿는 구간, 아직 지정되지 않은 역할 |
| `attachedToAllSections` | 지정된 연결이 모두 구간에 붙었는가: true / false / null |
| `routeCombinations[]` | `{ comboId, fromSectionId, toSectionId, fromRole, toRole, passLocation, passDistanceMeters, conflictsWith[] }` |

`attached`: 분기기 위치가 구간 선형에서 1 m 이내면 true, 50 m 초과면 false, 그 사이거나 선형을 모르면 null(측정한 거리는 `distanceToSectionMeters`에 남는다).

`routeCombinations`: turnout은 `stem-main`, `stem-branch`, crossing은 `a1-a2`, `b1-b2`. `conflictsWith`는 같은 분기기의 다른 조합과 **공간 관계**만 낸다. `{ comboId, basis: "shared-section" }`은 두 조합이 같은 구간을 쓴다는 뜻이고, `basis: "crossing-point"`는 분기기 지점에서 두 조합의 진행 방향이 서로를 가르며 교차한다는 뜻이다(4개 방향이 번갈아 놓일 때. 2도 미만으로 겹치는 방향은 접촉일 뿐 교차가 아니다). `[]`는 측정해서 충돌이 없다는 사실이고, 선형을 몰라 측정할 수 없으면 `null`(`section-alignment-not-in-source`)이다. `passDistanceMeters`는 조합의 두 연결점 사이 직선거리다. 해방시간, 처리량, 열차/시간은 계산하지 않는다.

### 종착 `terminals[]`

| 필드 | 의미 |
|---|---|
| `terminalResourceId` | 경영 엔진의 `terminalTurnback.resourceId`에 대응. `key`가 있으면 키 기반, 없으면 `(planId, stationId)` |
| `stationId`, `planId`, `location`, `platformType`, `stationSiteId` | 종착역(계획 역). `stationSiteId`는 이 역에 연결된 StationSiteGeometry가 주어졌을 때만 |
| `approachSectionIds` | 종착역에 닿는 물리 구간(접근 구간) |
| `platformCandidates` | `null`(`no-platform-data`) 또는 목록 |
| `turnbackCandidates` | `null`(`no-turnback-data`) 또는 목록 |

`platformCandidates[]`: `{ platformCandidateId, key, approachSectionId, approachReachesTerminalStation, polyline, location, trackLengthMeters, platformLengthMeters, distanceFromStationMeters, entryRoute: { fromSectionId, viaJunctionResourceIds, entryGapMeters }, connected }`. `entryRoute`는 승강장별 진입 진로(접근 구간 → 통과 분기기들)다. `connected`는 승강장 선로의 시작점이 진입 지점(마지막 경유 분기기 위치, 없으면 접근 구간이 종착역과 만나는 끝)에서 1 m 이내면 true, 50 m 초과면 false, 사이거나 선형을 모르면 null. `platformLengthMeters`는 명시된 값만(없으면 `null`, `platform-length-not-stated`)이고 선로 길이에서 추정하지 않는다.

`turnbackCandidates[]`: `{ turnbackCandidateId, key, kind, polyline, lengthMeters, viaJunctionResourceId, attachSectionId, attachGapMeters, attached, distanceFromTerminalMeters }`. `kind`는 `turnback`(회차선), `pull-out`(인상선), `stabling`(유치선). `attached`는 `connected`와 같은 규칙이다. 운행 가능 판정과 회차시간은 경영 엔진이 한다.

### `spatialFlags`

`section-direction-unknown`, `external-alignment-unknown`, `block-data-missing`, `junction-data-missing`, `terminal-data-missing`, `revision-stale`, `revision-not-recorded`, `junction-separated`, `junction-attachment-unverified`, `junction-sections-incomplete`, `crossing-without-crossing-geometry`, `platform-not-connected`, `platform-connection-unverified`, `approach-not-at-terminal`, `turnback-not-connected`, `turnback-connection-unverified`. 모두 공간 사실의 표식이며 점수나 판정이 아니다.

## true / false / null 의 정확한 의미

| 값 | 의미 |
|---|---|
| `true` | 양쪽의 **알려진 선형**이 1 m 이내로 만난다고 측정됨 |
| `false` | 측정된 거리가 50 m를 넘어 떨어져 있음 (또는 50 m 안에 다른 구간이 하나도 없음) |
| `null` | 자료가 없어 어느 쪽도 말할 수 없음: 선형을 모름(기존선), 1~50 m(가깝지만 접속 미확인), 대상이 지정되지 않음 |

`false`는 "측정했고 떨어져 있다"이고 `null`은 "모른다"다. 이 계약의 어떤 `true`/`false`도 운행 가부가 아니다.

## ID

모든 ID는 저장된 key와 연결 대상 ID에서 결정론적으로 만든다. 이름, 입력 배열 순서, 그린 방향에 의존하지 않는다.

- `railGeometryId`: `key`가 있으면 `stableId("rail-geometry", packId, "key", key)`, 없으면 `(packId, 정렬된 planIds, throughRouteId)`.
- `sectionId`, `blockId`, `junctionResourceId`, `terminalResourceId`, `platformCandidateId`, `turnbackCandidateId`, `signalCandidateId`는 위 표의 규칙. 출력 배열은 모두 ID 순이다.
- 계획을 반대 방향으로 다시 그리면 PlanGeometry의 `segmentId`는 바뀌지만(PlanGeometry의 성질) 이 계약의 `sectionId`는 같다. 다만 `planRevision`은 방향이 바뀐 것도 변경으로 보므로 이전 설계는 stale이 되고, 설계가 `segmentId`로 지목한 항목은 다시 지목해야 한다.
- 경계 위치는 끝역 기준이라 어느 쪽에서 재도 같다. 승강장·회차선 폴리라인은 방향을 정규화하므로 뒤집어 그려도 같은 항목이다.

## 개정과 stale

`planRevisionOf(plan)`는 역 위치와 구간(끝점·길이·선형)만 해시한다(이름 제외). 설계는 만든 시점의 개정(`designedRevisions`)을 기록하고, 현재 계획·직통 경로의 개정과 다르면 `revision.state = "stale"`, 기록이 없으면 `"not-recorded"`다. 이때 **위치에 의존하는 설계 항목**(`blocks`, `signalCandidates`, `junctions`, `terminals`)은 `null`이 되고 이유는 `design-revision-stale` / `design-revision-not-recorded`다. 물리 구간 자체와 단·복선 명시는 현재 계획 기준의 사실이므로 남는다. 설계하지 않은 항목은 stale과 무관하게 `no-…-data`다. stale은 플레이어가 `rebindRevisions`로 확인할 때까지 유지된다(편집은 개정을 바꾸지 않는다).

## 편집과 저장

`rail-capacity-editor.mjs`: `addDesign`(대상 계획·직통 경로의 개정 기록), `rebindRevisions`, `setSectionFact`/`clearSectionFact`, `declareBlockBoundaries`/`clearBlockBoundaries`, `addBlockBoundary`/`moveBlockBoundary`/`removeBlockBoundary`, `declareJunctions`/`clearJunctions`, `addJunction`/`moveJunction`/`connectJunction`/`disconnectJunction`/`removeJunction`, `declareTerminals`/`clearTerminals`, `addTerminal`/`removeTerminal`, `addPlatform`/`removePlatform`, `addTurnbackTrack`/`removeTurnbackTrack`, `toDrawnDesign`, `serializeRailCapacityDoc`, `restoreRailCapacityDoc`. 같은 key는 편집 후에도 같은 ID다. 다른 팩의 저장본은 거부(`rail-capacity-doc-other-pack`)하고 빈 문서를 돌려주며, 팩 버전만 다르면 `pack-version-mismatch` 경고다.

## 표시 (`rail-capacity-view.mjs`)

복선(굵은 선, 가운데를 비움)·단선(가는 선)·단복선 미상(회색 점선)·선형 없는 구간(선 없이 "선형 자료 없음"), 구간 끝의 접속 상태(✓ 초록 / ✕ 빨강 / ? 노랑 점선), 폐색 경계(╲), 신호 위치 후보(▢), 분기기(△)·평면교차(✕)와 충돌 진로쌍 수, 종착 승강장(굵은 선)·회차·인상·유치선(점선). unknown(노랑 점선 ?)과 false(빨강 실선 ✕)는 모양·색·선이 다르다. 수송력·시간표·비용·판정은 표시하지 않는다. 패널은 `textContent`만 쓴다.

## 예제 (`packs/*/rail-capacity-examples/`)

| 팩 | 파일 | 사례 |
|---|---|---|
| radial | 01 | 복선 구간 (+설계 구배) |
| radial | 02 | 단선 구간 |
| radial | 03 | 한 구간(3.7 km) 안의 복수 폐색 + 신호 후보 |
| radial | 04 | 두 노선(간선·순환선)이 공유하는 분기기 |
| radial | 05 | 평면교차 |
| radial | 06 | 신호·폐색 자료 없음 |
| radial | 07 | 일부 공간 레이어 없음 |
| radial | 08 | 노선 개정으로 stale |
| corridor | 01 | 종착 승강장 2개 + 유치선 + 인상선 후보 |
| corridor | 02 | 자료 없는 구간만 |
| corridor | 03 | 단선 구간 + 복수 폐색 |
| tokyo | 01 | 기존선(역 단위, 선형 없음) + 직통 경로 연결, 신호·폐색 자료 없음 |
| tokyo | 02 | 복선 + 폐색 경계 (실제 수역·건물 레이어) |
| tokyo | 03 | 단선, 공간 레이어 없음 |

모든 예제의 `source`에 입력(`drawnDesign`), 레이어 명세, 생성 스크립트가 기록되어 있고 재생성하면 바이트 단위로 같다. radial·corridor는 합성 레이어(`synthetic-fixture`)이고 Tokyo는 팩의 추적 파일(`barriers.json`, `obstacles.json`)과 역 단위 기존선만 쓴다.

## 경영 엔진이 연결해야 할 것 (Codex)

| 경영 쪽 | 이 계약 |
|---|---|
| 시간표 구간 `sectionId` | `sections[].sectionId` (또는 `blockId`로 폐색 단위 확장) |
| `fromNodeId`, `toNodeId` | `fromStationId`, `toStationId` (분기기 지점을 노드로 쓰려면 `junctionResourceId`) |
| `directionMode` (`single`/`double`) | `sections[].directionMode` — `null`이면 B13-2의 "플레이어 명시 가정 필요" 규칙을 그대로 적용 |
| `junctionResourceIds[]` | `sections[].junctionResourceIds` / `junctions[].junctionResourceId` (`null`은 자료 없음, `[]`는 없음) |
| `terminalTurnback.resourceId` | `terminals[].terminalResourceId` |
| `closureWindowsBySectionId` 키 | `closureTargets[].sectionId` |
| B13-3의 "`trackSegment` 하나 = 블록 하나" | `blocks[]`가 있으면 한 구간 안의 복수 블록으로 확장. `blocks`가 `null`이면 종전대로 구간 하나 = 블록 하나(그 안의 경계는 미상) |

주의: 구간은 계획 segment 단위이므로 두 계획이 같은 선로를 겹쳐 그리면 구간이 둘로 나온다(같은 물리 선로의 통합은 이 계약의 범위가 아니다). 경영 쪽 `trackSegment`와의 매핑은 역 쌍과 선형으로 Codex 쪽 어댑터가 한다.

## 한계

- 단선/복선, 신호, 폐색 경계, 분기기, 종착 시설은 어느 팩에도 원자료가 없다. 플레이어가 명시하기 전에는 항상 미상이다.
- 기존 외부선은 역 단위 좌표뿐이라 선형·길이·곡선·횡단·접속이 항상 미상이다. 실제 선형(OSM/Wikidata 등)을 가져오는 일은 하지 않았다.
- `groundGradientPermille`은 지반 구배(DEM 31 m 격자, 양 끝 고도 차)이고 선로 구배가 아니다. `minimumCurveRadiusMeters`와 `structureHint`는 PlanGeometry의 값이며 구조 hint는 일부가 추정(`structureHintBasis`로 구분)이다.
- 기존 철도 횡단은 역 사이 직선 기준의 조잡한 값(품질 `low`)이다.
- 분기기는 구간 끝점 또는 구간 위 한 점에 붙는 것으로만 표현한다. 구간 중간에서 갈라지는 분기를 위해 구간을 쪼개지는 않으며 `alongMeters`/`remainingToFarEndMeters`로 위치만 알려준다. 승강장·회차선은 구간이 아니라 별도 선(폴리라인)이다.
- 평면교차 충돌은 분기기 지점에서 30 m 떨어진 방향을 기준으로 판정한다(교차 각도를 정밀하게 재는 것이 아니다).
- 건물 자료는 팩마다 범위가 다르다(Tokyo `obstacles.json`은 4개 구역). 범위 밖은 `outside-coverage`로 미상이다.
