# 타사 철도 우회운행 공간 사실 계약 `transitline.railway-detour-service-geometry/1`

B14-M9. 철도 장애 뒤 플레이어가 M7 관제 후보 중 **우회(detour)** 하나를 고르면, 그 우회가 지도 위에서 어떤 구간을 어떤 순서로 지나는지, 구간마다 어떤 ID가 붙는지, 어디서 다음 구간과 만나고 그 접속이 측정됐는지를 **공간·연결 사실**로만 낸다. 운행 가능 여부, 기술호환, 선로용량, 배차간격, 열차 수, 비용·접근료·보상·매출·수요·평판, 공기·지연 확률, 계약 상태는 지도가 말하지 않는다. 판단·계약·정산은 경영 엔진(Codex)이 한다.

## 경계

- 지도는 사실만 낸다. 출력 키에 위 목록에 해당하는 이름이 들어가지 않는다 (테스트가 키 이름을 전부 훑는다).
- `null` = 자료 부족 또는 측정 불가 (반드시 `unknown[]` + `unknownReasons`), `false` = 측정 결과 연결되지 않음, `[]` = 조사·선언 결과 후보 없음. `null`을 `false`·0·`[]`로 바꾸지 않는다. `unknown[]`과 `unknownReasons`는 항상 1:1이고 `unknown`에 든 값은 `null`이다.
- **기존선(외부선)은 역 단위 자료뿐이다.** 선형이 없으면 접속을 `true`로 만들지 않는다: 접속·간격은 `null`(`external-topology-not-in-source`)이다.
- **선로 소유자는 출처나 입력이 말한 값만 쓴다.** 직통 경로 leg가 적은 값, 기존 인프라 카탈로그가 적은 값, 기존망 노선 자료가 적은 값. 운영사 태그(`operator`)·이름·노선망으로 추정하지 않는다. 출처끼리 다르면 `null`(`owner-sources-disagree`)이고 경고한다.
- 외부 기술사양·카탈로그는 **식별·출처 연결에만** 쓴다 (`externalSpecificationId`/`Revision`). 궤간·전압·차량한계 등 기술 사실과 `capacityTrainsPerHour`·`status`는 옮기지 않는다.
- 플레이어가 그린 선(연결선·환승 동선)은 `basis: "player"`로 보존하고 **접속의 근거가 되지 않는다**: 접속 `true`/`false`/`null`은 출처의 측정만이 정한다.
- 지도 모듈은 management, 열차, 현금, 장애 상태를 import하지도 읽지도 쓰지도 않는다. view는 읽기 전용이다.

## 파일

| 파일 | 역할 |
|---|---|
| `engine/src/map/railway-detour-service.mjs` | `buildRailwayDetourService`, `buildRailwayDetourServiceExport`, `detourGeometryIdOf` |
| `engine/src/map/railway-detour-service-candidates.mjs` | 구간 순서, leg·접속·역·환승 연결, 플레이어 그림의 측정 (40 KB 제한으로 나눔) |
| `engine/src/map/railway-detour-service-editor.mjs` | 선택·해제·그림 편집·저장·복원 (순수 데이터) |
| `engine/src/map/railway-detour-service-view.mjs` | 표시 모델, 캔버스 오버레이, 패널, 범례 (읽기 전용) |
| `scripts/build-railway-detour-service-examples.mjs` | 예제 생성 (`npm run railway-detour-service-examples`, `--out <dir>`) |
| `packs/*/railway-detour-service-examples/` | 예제 8개 (radial 4, corridor 1, tokyo 3) |

## 입력

```
document: { eventId, detourCandidateId, selectedOnControlGeometryRevision?,
            connections?:   [{ key?, name?, polyline: [[lon,lat]...] }],   // 플레이어가 그린 연결선
            transferPaths?: [{ key?, name?, polyline: [[lon,lat]...] }],   // 플레이어가 그린 임시 환승 동선
            active? }
ctx:      { pack, site: RailwayDisruptionSiteGeometry v1 (M6), control: RailwayServiceControlGeometry v1 (M7),
            railGeometry?: RailCapacityGeometry v1 (M5), application?: rail-capacity-application/1,
            routes?: [ThroughRouteGeometry v1], externalCatalog?: transitline.external-infrastructure-catalog/1,
            externalNetworks?: [기존망], stationSites?: [StationSiteGeometry] }
```

- **거절** (다른 revision의 입력을 쓰지 않는다): `event-missing`, `detour-candidate-missing`, `site-schema-invalid`, `control-schema-invalid`, `site-other-pack`, `control-other-pack`, `document-event-mismatch`, `control-site-mismatch`, `control-site-revision-mismatch`(control이 만들어진 사이트 revision ≠ 현재), `control-rail-geometry-revision-mismatch`, `selection-revision-mismatch`(선택 시점의 control revision ≠ 현재), `detour-not-offered`(고른 id가 현재 control의 `detourCandidates`에 없음 — 위치 없는 열차 이벤트도 여기), `rail-geometry-schema-invalid`, `rail-geometry-other-pack`, `rail-geometry-mismatch`, `rail-geometry-revision-mismatch`(M5), `detour-section-missing`, `detour-path-inconsistent`.
- **무시하고 경고** (없어도 되는 입력이 오래됐을 때): `application-stale`(M5 application의 geometry/revision이 control과 다름), `through-route-stale`(직통 경로의 `geometryRevision` ≠ geometry의 `routeGeometryRevision`), `catalog-ignored`(스키마·팩이 다른 카탈로그).
- `railGeometry`가 없으면 leg는 id와 구간만 남고 역·선형·간격이 `null`(`rail-geometry-not-supplied`)이다.

## 출력 필드

`schema`, `contractVersion`, `detourGeometryId`, `detourGeometryRevision`, `sourcePackId/Version`, `eventId`, `disruptionSiteId/Revision`, `controlGeometryId/Revision`, `railGeometryId/Revision`, `throughRouteId`, `operationalLineId`, `selectedDetourCandidateId`, `scope`, `originalBoundaryStationIds`, `affectedSectionIds`, `affectedTrackSegmentIds`, `affectedBlockIds`, `externalLineIds`, `handoverIds`, `infrastructureOwnerIds`, `lengthMeters`, `alignment`, `physicalConnection`, `legs`, `connections`, `stations`, `transferLinks`, `playerConnections`, `playerTransferPaths`, `walkNetwork`, `spatialFlags`, `dataQuality`, `unknown`, `unknownReasons`, `warnings`, `sourceLayers`, `license`.

- **`detourGeometryId = stableId("railway-detour-service", packId, eventId, detourCandidateId)`.** 이름·배열 순서·그린 방향·플레이어 그림이 바뀌어도 같다. 그림은 `detourGeometryRevision`만 바꾼다. 같은 입력은 JSON이 바이트까지 같고 입력 객체는 바뀌지 않는다.
- `originalBoundaryStationIds`: 영향 구간(원래 운행선)의 두 경계역 = 우회의 출발·도착 역 (M7은 역 id가 작은 쪽을 먼저 둔다; 지리적 방향이 아니다). `affectedSectionIds`/`affectedTrackSegmentIds`/`affectedBlockIds`는 M7의 값 그대로.
- `physicalConnection`: M7 우회 후보의 값 — `connections[]` 전체가 `true`면 `true`, 하나라도 `false`면 `false`, 아니면 `null`.
- `handoverIds`: 직통 경로가 말한 연결 ID. `infrastructureOwnerIds`: leg 소유자 모두 알 때만 (아니면 `null`). `lengthMeters`/`alignment`: 모든 leg의 선형이 있고 handover 틈이 없을 때만.

### `legs[]` (우회 구간 후보, `basis: "source"`)

출발 경계역에서 도착 경계역 방향으로 순서대로.

| 필드 | 뜻 |
|---|---|
| `legId`, `sequenceIndex` | `stableId("railway-detour-leg", detourGeometryId, sectionId)`와 순서 |
| `sectionId`, `sourceKind`, `planId`, `segmentId` | M5 구간과 그 출처 (`plan` 또는 `external`) |
| `trackSegmentId`, `trackSegmentIds` | application이 이 구간에 대응시킨 운행 선로구간. 정확히 하나면 값, 여럿이면 `trackSegmentId: null`(`several-track-segments-for-section`), application이 없거나 오래되면 둘 다 `null` |
| `externalNetworkId`, `externalLineId` | 기존선 구간만 |
| `externalSpecificationId/Revision` | 카탈로그에서 찾은 식별자만 (없으면 `null`: `no-catalog` / `line-not-in-catalog`) |
| `throughLegId` | 직통 경로의 leg id |
| `fromStationId`, `toStationId` | 우회가 이 구간을 지나는 방향 |
| `alignment`, `lengthMeters` | 선형이 있을 때만 (기존선은 `null`, `external-alignment-not-in-source`) |
| `infrastructureOwnerId`, `infrastructureOwnerBasis` | 출처가 말한 소유자와 근거(`through-route` / `external-catalog` / `external-network`) |
| `spatialConstraints` | 그 구간의 공간 사실: 최소 곡선반경, 지반·설계 경사, 구조 힌트, 플레이어가 적은 선로 수와 근거, 건물·물·도로·기존 철도 교차 수. 기존선은 전부 `null`, geometry가 없으면 `null` |

### `connections[]` (접속 후보)

영향 구간 → 첫 우회 구간 → … → 마지막 우회 구간 → 영향 구간 순서의 접속점 `legs.length + 1`개. `basis: "source"`.

- `kind`: `shared-station`(두 구간이 같은 역에서 만남) / `handover-link`(직통 경로가 서로 다른 두 역을 하나의 연결로 말함).
- `stationId`/`location` (shared) 또는 `viaStationIds`/`viaLocations` (link), `fromSectionId`, `toSectionId`, `handoverId`, `junctionResourceIds`.
- `physicalConnection`: **true** = 측정된 두 선형의 끝점이 1 m 이내; **false** = 직통 경로가 측정한 간격이 50 m 초과 (계획선끼리의 handover); **null** = 근접(1~50 m), 기존선, 기록 없음.
- `gapMeters` + `evidence`: `measured-alignments`(같은 역에서 만나는 두 선형의 끝점 거리), `through-route-handover`(직통 경로가 기록한 간격), `no-measurement`(`gapMeters: null`, 이유 `external-alignment-not-in-source` / `external-topology-not-in-source` / `rail-geometry-not-supplied`).
- 직통 경로 없이 만들어진 link는 `handoverId: null`(`no-through-route`)이다.

### `stations[]`

`{ stationId, role: "origin-boundary"|"detour-via"|"destination-boundary", location, external, handoverEndpoint, isInterchange, stationSiteId, entrances, platformType }`.

- `isInterchange`: 서로 다른 계획선·기존선의 구간이 만나는 역.
- `entrances`: 역 부지(StationSiteGeometry, `connectedStationId`로만 연결)의 출입구. 부지가 없으면 `null`(`no-station-site`), 기존선 역은 `null`(`external-station-detail-not-in-source`).
- `platformType`: 역 부지의 계획 힌트에 있을 때만. 없으면 `null`(`platform-detail-not-in-source` / `no-station-site` / `external-station-detail-not-in-source`). 승강장·정거장 상세는 더 없다.

### `transferLinks[]` (환승·연결 후보)

`handover-link`마다 하나: `{ transferLinkId, basis: "source", connectionId, handoverId, fromStationId, toStationId, straightDistanceMeters, entrancePairs }`.

- **보행망 자료가 없으므로 직선 거리만 낸다** (`walkNetwork: null`, `walk-network-not-in-source`). 보행 경로·보행 시간·보행 거리 보정은 없다. (역 부지 계약의 `walkingDistanceMeters`는 직선 × 계수의 추정이라 쓰지 않는다.)
- `entrancePairs`: 양쪽 역의 출입구가 모두 알려졌을 때만 출입구 쌍의 직선 거리 (아니면 `null`, `entrance-data-missing`).
- 같은 역에서 만나는 접속(`shared-station`)은 환승 연결이 아니라 `isInterchange`로만 드러난다.

### 플레이어가 그린 것 (`basis: "player"`)

입력이 없으면 `null`(`no-player-connection-stated` / `no-player-transfer-path-stated`), 플레이어가 `[]`을 선언하면 `[]`.

- `playerConnections[]`: `{ playerConnectionId, key, name, polyline, lengthMeters, ends[], measuredAgainst: "station-location", joinedAtBothEnds, bridgesConnectionIds }`. 시작은 출발 경계역에 가까운 끝. 각 끝은 가장 가까운 우회 역과 거리를 재고 `attached`: 15 m 이내 `true`, 50 m 초과 `false`, 사이 `null`. **역의 기록된 위치에 대한 측정이지 기존선의 선로 위치가 아니다.** `joinedAtBothEnds`: 두 끝이 서로 다른 두 역에 닿으면 `true`, 하나라도 떨어지면 `false`, 그 외 `null`. `bridgesConnectionIds`: 두 끝이 한 `handover-link`의 두 역에 각각 닿으면 그 접속 ID. **그림은 `connections[].physicalConnection`도 최상위 `physicalConnection`도 바꾸지 않는다.**
- `playerTransferPaths[]`: `{ transferPathId, key, name, polyline, lengthMeters, ends[], stationIdsAtEnds }`. 각 끝에서 가장 가까운 역과 출입구(출입구 자료가 없으면 `nearestEntranceId: null`)까지의 거리만 잰다.
- ID는 `key`가 있으면 그것으로, 없으면 그린 좌표로 정해지고 그린 방향과 무관하다. 같은 ID가 둘이면 JSON이 작은 쪽을 남기고 경고한다.

## spatialFlags

`existing-line-leg`, `external-alignment-unknown`, `connection-unmeasured`, `connection-measured-apart`, `all-connections-measured-joined`, `handover-between-different-stations`, `infrastructure-owner-unknown`, `through-route-not-supplied`, `existing-line-not-in-catalog`, `entrance-data-missing`, `platform-detail-missing`, `player-connection-drawn`, `player-transfer-path-drawn`, `player-connection-not-at-stations`, `operational-track-unmapped`, `long-detour`.

## 편집기 `railway-detour-service-editor.mjs`

문서 `{ version, packId, packVersion, plans: [...] }`, 계획은 `eventId` + 고른 우회 후보 ID로 키를 잡는다. 지도는 후보를 제공하고 플레이어의 **선택**을 ID로 저장한다. 실행·판단은 Codex.

- `addPlan(doc, eventId, candidateId, control)`: control이 내놓은 우회 후보만 (아니면 throw). 고른 시점의 `controlGeometryRevision` 기록.
- `pick(doc, eventId, candidateId, kind, itemId, detour)` / `unpick` / `clearPicks`: `kind`는 `leg`(`legs[].legId`), `connection`(`connections[].connectionId` 또는 `playerConnections[].playerConnectionId`), `transfer`(`transferLinks[].transferLinkId` 또는 `playerTransferPaths[].transferPathId`). 만들어진 우회 geometry가 내놓은 ID만 받고, 다른 종류의 ID는 거절한다. 고른 시점의 `detourGeometryRevision`을 기록한다.
- `setConnection`/`removeConnection`, `setTransferPath`/`removeTransferPath`(키로 덮어쓰기, 복사 보관), `declareNone(kind)`: 입력 없음(`null`)과 "없음" 선언(`[]`)을 구분.
- `reconcilePlan(doc, eventId, candidateId, control, detour?)` → `{ offered, outdated, stale[] }`.
- `deactivatePlan`/`restorePlan`: 계획은 삭제하지 않고 끈다 (삭제 함수 없음). `serializeRailwayDetourDoc`/`restoreRailwayDetourDoc(text, pack)`: 저장 후 ID 유지, 다른 팩 저장본·읽을 수 없는 본·다른 버전은 새 문서로 시작하고 경고.
- `toDetourDocument(plan)`: 빌더 입력. `picksOf(doc)`: `{ "<eventId>|<detourCandidateId>": { legIds, connectionIds, transferIds } }`.

## view `railway-detour-service-view.mjs`

`buildRailwayDetourView({ exportData, picks, selectedId })`, `drawRailwayDetourOverlay(ctx, model, screen)`, `renderRailwayDetourPanel`, `renderRailwayDetourLegend`. 계획선 leg(파란 실선), 기존선 leg(선형이 없으므로 선을 그리지 않고 역에 ◇와 "기존선 역(상세 자료 없음)"), 서로 다른 두 역을 잇는 연결(회색 점선 — 직선은 표시용), 플레이어 연결선(노란 실선)과 환승 동선(분홍 점선), 접속(● 이어짐 / ✕ 떨어짐 / ? 미상), 소유자(없으면 "소유자 자료 없음")를 서로 다르게 그린다. 고른 것은 흰 테두리와 ✔. 패널·범례는 판정·호환·요금·시간·계약 문구를 쓰지 않는다.

## Codex가 엔진에 연결할 입력 필드와 ID 매핑

1. **입력:** `buildRailwayDetourService(toDetourDocument(plan), { pack, site, control, railGeometry, application, routes, externalCatalog, externalNetworks, stationSites })`. `site`는 M6 `buildRailwayDisruptionSiteExport`, `control`은 M7 `buildRailwayServiceControlExport`의 같은 이벤트 항목, `application`은 `applyRailCapacityGeometry`의 결과, `routes`는 `control.throughRouteId`의 직통 경로, `externalCatalog`는 `buildExternalInfrastructureCatalog`의 결과를 그대로 넘긴다. 어느 하나가 오래됐으면 위 거절 코드로 돌려보낸다.
2. **계획 식별:** `detourGeometryId`/`detourGeometryRevision` ↔ 계획. M6·M7과는 `eventId`, `disruptionSiteId`, `controlGeometryId`, `selectedDetourCandidateId`.
3. **운행 쪽 구간:** `legs[].trackSegmentId`(application 경유; `null`이면 매핑되지 않은 구간 — `operational-track-unmapped`), 영향 구간은 `affectedTrackSegmentIds`. 역은 `stationId` (`originalBoundaryStationIds`, `legs[].fromStationId/toStationId`, `stations[]`).
4. **타사 선로 계약·정산의 키:** `legs[].infrastructureOwnerId`(+`infrastructureOwnerBasis`), `legs[].externalNetworkId`/`externalLineId`/`externalSpecificationId`, `handoverIds`/`connections[].handoverId`, `throughRouteId`/`legs[].throughLegId`. 접근료·정산은 엔진의 몫이다 (B12-4).
5. **판정에 쓸 공간 사실:** `connections[].physicalConnection`(`true`/`false`/`null`)과 `gapMeters`, `legs[].alignment`/`lengthMeters`, `legs[].spatialConstraints`. **`null`을 "가능"이나 "접속됨"으로 보지 말고 미확인으로 다룬다.** 플레이어가 그린 연결선은 `playerConnections[]`에 따로 있고 접속 사실이 아니다.
6. **선택:** `picksOf(doc)`의 `legIds`/`connectionIds`/`transferIds`가 위 ID들이다. 실제 우회 운행 명령으로 바꾸는 것은 경영 엔진이다. `index.html`·`main.mjs`·DOM 연결은 지도 쪽에서 만들지 않았다.

## 예제 (합성)

이벤트·application·직통 경로·소유자·플레이어의 선택과 그림은 **합성**이다 (`source.synthetic: true`, `source.note`). 계획선은 같은 팩의 실제 plan 예제, 역 부지는 팩의 station 예제, 카탈로그는 팩의 외부 인프라 카탈로그 예제다. M7 예제 기반(`source.m7Example`)은 그 예제의 기록된 입력으로 사이트와 control을 다시 만들고 ID·revision이 배포된 예제와 같은지 **생성기가 확인한다** (다르면 실패, 테스트도 확인). `custom`은 생성기 안의 작은 설계다.

| 팩 | 예제 | 보여 주는 것 |
|---|---|---|
| radial | 01-measured-joined-detour | 계획선 세 구간을 도는 우회, 모든 접속이 측정으로 이어짐(간격 0), 타사 소유자, 출입구가 있는 역, 고른 leg·접속 |
| radial | 02-player-transfer-passage | 위와 같은 우회에 플레이어가 그린 환승 동선 (끝을 가장 가까운 역·출입구에 대해서만 측정) |
| radial | 03-measured-apart-detour | 서로 다른 두 역(359 m·1,302 m 떨어짐)을 잇는 handover 둘 → 접속 `false`, 간격 기록 |
| radial | 04-player-connection-across-a-gap | 위 우회에 플레이어가 두 역을 잇는 선을 그림: 끝은 역에 닿지만(`joinedAtBothEnds: true`) 접속은 `false` 그대로 |
| corridor | 05-bypass-track-owner-unknown | 같은 역 사이에 그린 우회 선로, 접속 `true`, 직통 경로 없음·소유자 자료 없음(`null`) |
| tokyo | 06-existing-line-alignment-unknown | 기존선(도영 신주쿠선 역 단위)을 도는 우회: 선형·길이·접속·간격 `null`, 역 상세 없음, 카탈로그 없음 |
| tokyo | 07-existing-line-identified-by-catalog | 같은 우회에 카탈로그 식별자(사양 ID/revision)만 연결, 기술 사실은 옮기지 않음 |
| tokyo | 08-player-connection-on-an-unmeasured-link | 플레이어가 미측정 link 위에 연결선을 그림: `bridgesConnectionIds`가 채워지지만 접속은 `null` 그대로 |

## 데이터 한계

- 기존선은 역 단위 위치뿐이다. 선형·길이·실제 접속·곡선·경사·구조가 없어서 접속은 항상 `null`, 소유자는 입력이 있을 때만 있다 (팩의 기존망 자료에는 소유자가 없다).
- 접속 `false`는 직통 경로가 **계획선끼리**의 handover에서 측정한 간격이 50 m를 넘을 때만 나온다. 같은 역 ID를 공유하는 구간은 측정으로 이어지므로 `true`이거나 `null`이다.
- 승강장 상세는 계획 힌트의 `platformType`이 전부다. 환승 보행망이 없어 직선 거리뿐이다.
- 우회 후보 나열은 M7의 한계를 따른다 (geometry의 구간과 직통 경로의 연결만, 6구간까지).
- 브라우저 확인과 DOM 컨트롤러는 만들지 않았다. view는 가짜 캔버스·DOM 테스트로만 확인했다.

## 검증

`npm test`(`engine/test/railway-detour-service.test.mjs`, 39개), `npm run validate`, `git diff --check`, 예제 생성기 두 번 실행 후 SHA-256 비교(테스트가 `--out`으로 다시 만들어 바이트 비교, M6/M7 예제 ID 회귀 테스트 포함).
