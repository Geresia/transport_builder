# B16-M1 운행계획 지도 계약과 편집기 (`transitline.service-plan-geometry/1`)

플레이어가 **어느 구간을, 어느 방향으로, 어느 시간대에, 얼마 간격·몇 편성·몇 량으로, 어디서 회차하며 돌리고 싶은가**를 적은 것(운행 의도)과, 지도가 그 구간에서 **읽을 수 있는 선로 사실**(복선/단선, 폐색, 분기기, 종착 설비, 접속)을 한 문서에 담되 서로 섞지 않는다. 기준은 master `7051046`(B13 철도 용량 사실 → B14 장애·관제 → B15 접근권·수요 배분 이후), 브랜치 `b16-m1-service-plan-geometry`.

## 1. 계약 목적과 경계

- 지도는 **판정하지 않는다.** 플레이어가 "5분 간격"을 적은 것과 5분 간격 운행이 가능한 것은 다르다. 이 계약에는 가능 여부, 실제 간격, 수송력, 수요, 승객 수, 운임, 비용, 혼잡, 정시성, 수익, 공사 기간, 시간표가 **없다**(필드 이름 검사로 테스트가 고정한다). 요청한 값은 항상 `playerRequested…` 이름이거나 `playerInputs`·`basis: "player"` 블록 안에 있다.
- "이 역에서 회차"를 고른 것(`turnbacks`)과 회차 설비가 충분한 것은 다르다. 설비는 `terminals[]`·`turnbacks[].facilityFacts`에 **있다/없다/모른다**만 읽어 온다.
- "8량 편성", "양방향"도 같다: 차량·승강장·전력·신호가 맞는지, 단선에서 교행이 되는지는 Codex 경영 엔진이 판단한다. 지도는 `directionMode`(단선/복선, 플레이어가 적은 경우에만), 폐색 ID, 분기기 ID를 **넘기기만** 한다.
- 새 모듈은 `engine/src/map/`에만 있고 `./ids.mjs`, `./local-geometry.mjs`, `./rail-capacity-geometry.mjs`(스키마 상수만)만 import한다. management·엔진 상태·시계·난수·저장소·파일을 건드리지 않는다.

## 2. 파일

| 파일 | 역할 |
|---|---|
| `engine/src/map/service-plan-geometry.mjs` | `buildServicePlan(drawn, ctx)`, `buildServicePlanExport({pack, railGeometries, applications, plans})`, `keyedServicePlanId`, `keylessServicePlanId` |
| `engine/src/map/service-plan-editor.mjs` | 순수 데이터 편집기: 문서 생성, 계획/구간/방향/시간대/회차/차량/가정/차량기지 편집, 비활성화·복원, 저장·복원 |
| `engine/test/service-plan-geometry.test.mjs` | 40개 테스트 |
| `scripts/build-service-plan-examples.mjs` (+ `--out`), `npm run service-plan-examples` | 예제 10개 생성 |
| `packs/{example-radial,example-corridor,tokyo}/service-plan-examples/` | 예제 파일 |

## 3. 입력과 출력

**입력 `drawn`** (편집기의 `toDrawnPlan`이 만든다):

```
{ key?, name?, active?, planKind?: "regular"|"disruption-response", operatingPattern?: "full"|"short-turn"|"partial-section",
  railGeometryId, designedRailGeometryRevision?, operationalLineId?,
  route?: null | { sectionIds: [순서대로], fromStationId?, toStationId? },
  directions?: null | [{ key?, label?, fromStationId, toStationId }],
  serviceBands?: null | [{ key?, label?, startMinute, endMinute, periodId?, directionKeys?, active?, headwayMinutes?, trainsets?, formationCars?, note? }],
  turnbacks?: null | [{ key?, stationId, intent?: "route-end"|"intermediate", terminalResourceId?, turnbackCandidateId? }],
  vehicleIntent?: { vehicleModelId?, requestedCars?, requestedTrainsets? }, assumptions?: [{ key?, text }],
  depotRefs?: null | [{ key?, depotSiteId?, stationId?, role?: "pull-in"|"pull-out"|"both" }] }
```

`ctx = { pack, railGeometry: RailCapacityGeometry v1, application?: rail-capacity-application/1 }`. 결과는 `{ plan, warnings }`이고, 지도에 묶을 수 없으면 `plan: null`과 사유다(`rail-geometry-schema-invalid`, `rail-geometry-other-pack`, `rail-geometry-mismatch`, `route-sections-invalid`, `route-section-duplicate`, `key-or-sections-required`).

**출력** — 최상위 필드:

| 필드 | 뜻 |
|---|---|
| `schema`, `contractVersion` | `transitline.service-plan-geometry/1`, `1` |
| `servicePlanId`, `servicePlanRevision` | 계획 식별자, 내용 개정(6장) |
| `sourcePackId`, `sourcePackVersion`, `key`, `name` | 팩, 팩 버전, 플레이어 key(없으면 `null`), 이름(표시용) |
| `railGeometryId`, `railGeometryRevision` | 이 계획을 읽은 철도 용량 지도의 ID·현재 개정 |
| `revision` | `{ state: "current"\|"stale"\|"not-recorded", designedRailGeometryRevision, currentRailGeometryRevision }` |
| `operationalLineId` | 플레이어(또는 호스트)가 적은 운영 노선 ID, 없으면 `null` |
| `capacityApplicationId`, `capacityApplicationRevision`, `capacityApplicationState` | 그 노선에 적용된 용량 application의 ID, **그 application이 만들어진 `railGeometryRevision`**(application에는 자체 개정 번호가 없다), `"current"\|"stale"\|null` |
| `active` | 플레이어가 켜 둔 계획인가(`false`여도 export에 남는다) |
| `planKind` | `"regular"`(평시) / `"disruption-response"`(장애 대응) / `null`(미기재) |
| `playerInputs` | 계획 전체에 대한 플레이어 진술: `planKind`, `operatingPattern`, `operationalLineId`, `assumptions[]`, `depotRefs`, `basis: "player"` |
| `route` | 구간 순서와 읽은 사실(아래) |
| `directions` | 방향 목록. 안 적었으면 `null`, `[]`는 "없음" 선언 |
| `serviceBands` | 시간대 목록(같은 규칙) |
| `terminals` | 계획이 관심 두는 역(노선 시작·끝, 회차 역)의 설비 사실 |
| `turnbacks` | 플레이어가 고른 회차 + 그 설비 사실(안 적었으면 `null`) |
| `vehicleIntent` | 차량 형식 참조, 요청 량 수, 요청 편성 수 |
| `spatialFacts` | 고른 구간의 선로 사실, `spatialFlags`, `dataQuality` |
| `unknown`, `unknownReasons` | 모든 미상의 경로와 사유(1:1) |
| `warnings`, `sourceLayers`, `license` | 경고, 출처, 라이선스 |

**`route`**: `sectionIds`(플레이어가 준 순서 그대로), `playerFromStationId`/`playerToStationId`(진술), `fromStationId`/`toStationId`/`stationIds`(순서에서 읽은 역), `sections[]`(`order`, `sectionId`, `enterStationId`, `exitStationId`, `traversal: "forward"|"reverse"`(구간의 from→to에 대해), `trackSegmentId`(application이 현재일 때만)), `links[]`(이웃 구간 사이 `viaStationId`, `sharedStation`, `physicalJoin`), `stationsShared`, `physicallyJoined`, `includesExternal`, `externalSectionIds`, `coversWholeGeometry`, `omittedSectionIds`, `missingSectionIds`.

**`directions[]`**: `directionId`, `key`, `label`, `fromStationId`, `toStationId`(진술) + `orderedSectionIds`, `orderedStationIds`, `physicalConnection`, `reversalTurnbackIds`(그 방향의 도착역에서 회차를 고른 `turnbackId`들). 노선의 일부만 가는 방향도 허용한다.

**`serviceBands[]`**: `bandId`, `key`, `label`, `periodId`, `startMinute`/`endMinute`(하루 안의 분, 0–1440, 자정을 넘으면 두 시간대로 나눈다), `directionKeys`, `operating`(플레이어가 켠 시간대인가), `playerRequestedHeadwayMinutes`, `playerRequestedTrainsets`, `playerRequestedFormationCars`, `basis: "player"`, `note`.

**`terminals[]`**: `stationId`, `roles`(`route-start`/`route-end`/`turnback`), `playerSelectedTerminalResourceIds`, `facilities`(그 역에 지도가 아는 종착 설비: `terminalResourceId`, `playerSelected`, `platformCandidates[]`(`connected`, `approachReachesTerminalStation`), `turnbackCandidates[]`(`kind`, `attached`, `viaJunctionResourceId`)).

**`turnbacks[]`**: `turnbackId`, `key`, `stationId`, `intent`, `playerSelected: true`, `terminalResourceId`, `turnbackCandidateId`(진술) + `onRoute`, `position: "start"|"middle"|"end"`, `facilityFacts`(`terminalResourceIdsAtStation`, `terminalResourceKnown`).

**`spatialFacts.sections[]`** (플레이어가 고른 순서): `sectionId`, `sourceKind`, `planId`, `externalLineId`, `fromStationId`, `toStationId`, `lengthMeters`, `minimumCurveRadiusMeters`, `groundGradientPermille`, `directionMode`(`"single"`/`"double"`/`null`), `directionModeBasis`, `blockIds`, `junctionResourceIds`, `closureTarget`. `spatialFlags`: `revision-stale`, `revision-not-recorded`, `capacity-application-stale`, `track-count-unknown`, `single-track-section-on-route`, `block-data-missing`, `terminal-data-missing`, `external-section-on-route`, `route-section-missing`, `route-sections-share-no-station`.

## 4. 플레이어 입력과 지도 사실의 분리

| 플레이어가 적는 것 | 이름 | 지도가 읽는 사실(같은 곳에 놓지 않는다) | 이름 |
|---|---|---|---|
| 대상 구간과 순서 | `route.sectionIds` | 구간이 지도에 있는가, 길이·곡선·구배 | `missingSectionIds`, `spatialFacts.sections[]` |
| 시작역·끝역 | `route.playerFromStationId/ToStationId` | 순서에서 읽은 역 | `route.fromStationId/toStationId/stationIds` |
| 양방향/한쪽 방향 | `directions[].fromStationId/toStationId` | 방향이 지나는 구간·역·접속 | `orderedSectionIds`, `orderedStationIds`, `physicalConnection` |
| 시간대 | `startMinute`, `endMinute`, `periodId`, `operating` | — (지도는 시간에 대해 아무것도 모른다) | — |
| 배차 간격·편성 수·량 수 | `playerRequestedHeadwayMinutes/Trainsets/FormationCars` | **실제 간격·수송력은 없다** | — |
| 회차 위치와 고른 설비 | `turnbacks[]`, `terminalResourceId` | 그 역에 설비가 있는가, 승강장·회차선 접속 | `terminals[].facilities`, `facilityFacts` |
| 부분·단축 운행 | `operatingPattern` | 노선이 지도 전체를 덮는가 | `route.coversWholeGeometry`, `omittedSectionIds` |
| 차량 형식·요청 량 수 | `vehicleIntent` | **호환 여부는 없다** | — |
| 평시/장애 대응 | `planKind` | — | — |
| 운영 가정(글) | `playerInputs.assumptions[]` | — | — |
| 입·출고 참조 | `playerInputs.depotRefs[]` | 그 역이 노선 위에 있는가 | `stationOnRoute` |
| 단선/복선 | **플레이어가 지도에 적은 경우만** | 값과 `directionModeBasis` | `spatialFacts.sections[].directionMode` |

한 객체 안에 둘이 같이 있는 경우(`directions[]`, `turnbacks[]`)는 진술 필드(`fromStationId`, `stationId`, `intent`, …)와 읽은 필드(`orderedSectionIds`, `position`, `facilityFacts`, …)를 이름으로 구분한다.

## 5. null / false / 0 / [] 규칙

- **`null` = 알 수 없음.** 이름이 `unknown[]`에, 사유가 `unknownReasons`에 같은 개수로 있다(모든 객체에서 1:1, 테스트가 전수 검사). 단선/복선이 자료에 없으면 `directionMode: null`(`track-count-not-stated`)이고 **복선으로 두지 않는다.** 폐색 목록이 없으면 `blockIds: null`(`no-block-data`), 빈 배열이 아니다.
- **`false` = 자료가 있고 실제로 아니다.** `physicalJoin: false`는 두 구간의 끝이 **측정되어** 만나지 않는다는 뜻이다. 외부선처럼 선형이 없으면 `false`가 아니라 `null`(`external-alignment-not-in-source`)이다.
- **`0` = 자료가 있고 실제로 0.** `playerRequestedTrainsets: 0`은 플레이어가 0이라고 적은 것이다. 간격 `0`, 량 수 `0`은 의미가 없어 `null` + 경고(`headwayMinutes-invalid`, `formationCars-invalid`, `requestedCars-invalid`)다.
- **`[]` = 플레이어가 없다고 선언했거나 대상이 실제로 없다.** `turnbacks: []`는 "회차 없음" 선언이고 `turnbacks: null`은 "아직 안 적음"(`turnbacks-not-stated`)이다. `directions`, `serviceBands`, `depotRefs`도 같다. 종착 설비는 `facilities: null`이면 자료 없음(지도의 사유 그대로, 예 `no-terminal-data`), `facilities: []`는 "종착 자료가 있고 이 역에는 없다"이다. 외부선 역의 종착 설비는 `null`(`external-station-terminal-not-in-source`).
- **편집기에서 마지막 항목을 지우면 `[]`가 된다**(플레이어가 "없음"을 말한 것). 다시 "안 적음"으로 되돌리려면 `clearList`.

## 6. ID / revision / stale 규칙

- **`servicePlanId`**: `key`가 있으면 `팩 + key`로만 정한다. 이름, 구간, 시간대, 방향 어느 것을 고쳐도, 저장·복원·재열기를 해도 같다. key가 없으면 `팩 + railGeometryId + planKind + 구간 ID의 정렬된 집합`이다: 구간을 **다른 순서나 반대 방향으로** 적어도 ID는 같고(`servicePlanRevision`은 다르다), 구간 집합이나 `planKind`가 바뀌면 다른 계획이다. 같은 집합·같은 종류의 key 없는 계획 둘은 `duplicate-service-plan`으로 뒤쪽이 거절된다. key도 구간도 없으면 거절(`key-or-sections-required`).
- **방향 ID**(`directionId`), **시간대 ID**(`bandId`), **회차 ID**(`turnbackId`), 가정·차량기지 ID는 `servicePlanId` + 항목 key(없으면 역/시간 범위)에서 나온다. 이름·라벨·배열 순서·클릭 순서·시계·난수에 의존하지 않는다. `export`의 `plans`는 ID순, 항목 배열도 ID순이다(구간 순서 `route.sectionIds`만 플레이어가 준 순서).
- **`servicePlanRevision`**: 플레이어가 적은 것과 읽은 사실 전체의 해시. 이름·라벨·경고는 포함하지 않는다. 같은 입력은 바이트까지 같은 JSON이다.
- **stale**: 편집기는 계획을 만들 때(`addPlan`)와 `rebindRevision`을 부를 때만 `designedRailGeometryRevision`을 기록한다. 편집은 이를 바꾸지 않는다. 현재 지도 개정과 다르면 `revision.state = "stale"`과 경고 `revision-stale`, 기록이 없으면 `"not-recorded"`(경고 `revision-not-recorded`). **stale이어도 사실은 현재 지도에서 읽어 온다**(읽는 쪽이 `revision.state`를 보고 플레이어가 새 지도를 확인했는지 안다). 구간 ID가 사라졌으면 `missingSectionIds`와 `route-section-missing`.
- **application**: 계획이 `operationalLineId`를 적었고, 넘겨받은 application이 같은 `railGeometryId`·같은 노선일 때만 쓴다. application의 `railGeometryRevision`이 현재 지도와 다르면 `capacityApplicationState: "stale"`, 경고 `application-stale`, 구간별 `trackSegmentId`는 `null`(`capacity-application-stale`). 이때도 `capacityApplicationId`/`Revision`은 그 application이 만들어진 값을 그대로 적는다. 노선을 안 적으면 application을 찾지 않는다(`operational-line-not-stated`).
- 팩 버전이 지도의 팩 버전과 다르면 `pack-version-mismatch` 경고(기존 계약과 같은 방식). 다른 팩의 지도는 읽지 않는다.

## 7. Codex가 E1에서 읽어야 할 필드

E1(`operational-timetable-integration.mjs`의 `buildOperationalRailwayTimetableInput`)의 `servicePlans[]`에 필요한 것과의 대응:

| E1에 필요한 것 | 이 계약의 필드 |
|---|---|
| 서비스 식별(`serviceId`) | `servicePlanId`(key가 있으면 `key`도) |
| 운영 노선 | `operationalLineId` |
| 대상 구간(트랙) 순서 | `route.sections[].trackSegmentId`(application 현재일 때), 아니면 `route.sectionIds` |
| 구간별 진행 방향(`sectionDirections`) | `route.sections[].traversal` |
| 왕복 여부(`includeReturnPaths`) | `directions[]` |
| 첫·막차 분(`firstDepartureMinute`/`lastDepartureMinute`) | `serviceBands[].startMinute/endMinute`, `operating` |
| 배차 간격(`headwayMinutes`) | `serviceBands[].playerRequestedHeadwayMinutes` — **요청이지 가능한 값이 아니다** |
| 회차 자원(`terminalResourceId`) | `turnbacks[].terminalResourceId`, 설비 사실은 `terminals[].facilities` |
| 폐색·분기기·단복선 | `spatialFacts.sections[].blockIds/junctionResourceIds/directionMode` |
| 요청한 편성 | `serviceBands[].playerRequestedTrainsets/FormationCars`, `vehicleIntent` |

읽는 순서: ① `revision.state`와 `capacityApplicationState`가 `"current"`인가 ② `active` ③ `unknownReasons`에 있는 항목은 기본값으로 채우지 말고 경영 엔진의 명시적 가정(`infrastructureAssumptions`)으로 다룰 것 ④ 가능/불가능, 실제 간격, 비용은 Codex가 계산한다.

## 8. 데이터 한계

- 어느 팩에도 단선/복선, 폐색, 분기기, 종착 설비 원자료가 없다. 플레이어가 철도 용량 지도에 적은 것만 읽는다(예제의 선로 사실은 합성).
- 지도는 차량 형식(`vehicleModelId`), 차량기지(`depotSiteId`) 카탈로그를 모른다. ID는 **참조로만** 받고 존재 여부를 확인하지 않는다.
- 외부선(기존 노선)은 역 단위뿐이라 길이·선형·접속이 미상이다. 계획 구간과 외부 구간은 **같은 역 ID를 공유해야** 순서가 읽힌다. 도쿄 팩에서는 둘이 같은 역 ID를 쓰지 않아 `stationIds`가 `null`(`route-sections-share-no-station`)이다(예제 `tokyo/01`). 직통 경로(ThroughRoute)의 인계 정보는 읽지 않는다.
- 역 순서는 같은 역을 공유하며 이어지는 구간 목록에서만 읽는다. 갈라지는 노선, 순환, 같은 두 역 사이 구간이 둘인 경우는 `route-station-order-ambiguous`로 `null`이다.
- 시간은 하루 안의 분뿐이다. 요일 유형은 `periodId` 문자열을 그대로 전달할 뿐 해석하지 않는다.
- 겹치는 시간대는 경고(`bands-overlap`)만 낸다. 판정이 아니다.
- 화면(UI)은 만들지 않았다.

## 9. 예제 (10개, 선로 사실은 합성 + 계획은 실제 팩의 계획 예제)

| 팩 | 파일 | 사례 | 보여 주는 것 |
|---|---|---|---|
| example-radial | `01-double-track-both-directions` | 복선 일반 노선, 양방향, 종점 회차 | 3구간 모두 복선, 방향 2개, 시간대 2개, 서쪽 끝은 설비를 골랐고 동쪽 끝은 설비가 있어도 고르지 않음 |
| example-radial | `02-short-working` | 일부 구간만 운행(단축) | 앞 2구간만 운행, 3번째 역 회차, `coversWholeGeometry: false`, 장애 대응 계획 |
| example-radial | `03-midway-turnback-no-facility-data` | 회차 설비 자료 없는 중간역 회차 | 종착 자료 없음 → `terminalResourceIdsAtStation: null`, 짧은 방향을 쓰는 시간대 |
| example-radial | `04-stale-geometry-revision` | 지도 개정이 바뀌어 stale | 중간 구간에 폐색 경계가 새로 그려져 `revision.state: "stale"`, application도 stale |
| example-radial | `05-inactive-saved-restored` | inactive로 저장·복원 | `active: false`, 저장 문서가 그대로 복원됨 |
| example-corridor | `01-single-track-meeting-unknown` | 단선 구간 포함, 교행·폐색 미상 | 가운데 구간만 단선, 나머지 구간은 단·복선 미상, 폐색 `null` |
| example-corridor | `02-terminal-resource-stated` | 종착 자원이 명시된 노선 | 승강장 2·유치선·인상선, 플레이어가 자원과 인상선 후보를 고름(`terminalResourceKnown: true`) |
| example-corridor | `03-several-blocks` | 폐색 목록이 여러 개인 구간 | 구간마다 폐색 2–3개 |
| tokyo | `01-external-through-service` | 외부선 포함 직통 | 새 계획 구간 + 기존선 2구간, 접속·선형 미상, `stationIds: null` |
| tokyo | `02-almost-no-track-data` | 선로 자료가 거의 없음 | 구간만 고른 계획, 방향·시간대 안 적음(`null`), 단·복선·폐색·종착 모두 미상 |

각 파일 `source`에는 사례 이름(`case[]`), 합성 표시(`synthetic: true`), 입력(철도 용량 설계, application, **플레이어가 저장한 문서**), 생성기 이름이 있다. 생성기는 편집기로 계획을 쓰고 저장·복원한 뒤에 계약을 만든다. 테스트가 생성기를 다시 돌려 바이트까지 같은지 확인한다.

## 10. UI 연결 방법

UI는 이 작업의 범위가 아니다. 호스트는 편집기 API를 호출하면 된다.

```js
import { newServicePlanDoc, addPlan, setRoute, addBothDirections, addBand, drawnPlansOf,
         serializeServicePlanDoc, restoreServicePlanDoc } from "./src/map/service-plan-editor.mjs";
import { buildServicePlanExport } from "./src/map/service-plan-geometry.mjs";

// 다른 팩의 저장본이면 rejected: true 이고 doc === current (지금 편집 중인 문서는 그대로)
const restored = restoreServicePlanDoc(savedText, pack, { current: doc });
doc = restored.doc;
addPlan(doc, { railGeometry, planKind: "regular", operationalLineId });   // 지도 개정이 기록된다
setRoute(doc, key, { sectionIds }, railGeometry);                        // 지도에 없는 구간은 throw
addBothDirections(doc, key, fromStationId, toStationId);
addBand(doc, key, { startMinute: 420, endMinute: 540, headwayMinutes: 5, trainsets: 6, formationCars: 8 });
const out = buildServicePlanExport({ pack, railGeometries, applications, plans: drawnPlansOf(doc) });
const toSave = serializeServicePlanDoc(doc);                             // 저장은 호스트가 한다
```

- **편집 기능 ↔ 함수**: 계획 생성 `addPlan` · 구간 선택/순서 `setRoute`, `appendSection`, `removeSection`, `moveSection`, `reverseRoute` · 방향 `addDirection`, `addBothDirections`, `updateDirection`, `removeDirection` · 시간대 `addBand`, `updateBand`, `deactivateBand`, `restoreBand`, `removeBand` · 회차 `addTurnback`, `updateTurnback`, `removeTurnback` · 부분·단축 운행 `updatePlan({operatingPattern})` + 짧은 방향 · 차량 `setVehicleIntent` · 가정/차량기지 `addAssumption`, `addDepotRef` · 계획 비활성화/복원 `deactivatePlan`/`restorePlan` · 삭제 `removePlan`(무덤으로 남아 key를 다시 쓰지 못한다) · 지도 재확인 `rebindRevision` · 저장/복원 `serializeServicePlanDoc`/`restoreServicePlanDoc`.
- 편집기는 ID·개정·항목 key를 플레이어가 직접 바꾸게 두지 않는다(허용 필드만 반영).
- 지도 사실이 바뀌어도 편집기는 자동으로 확인 처리하지 않는다. 사용자가 새 지도를 보고 계속 쓰겠다고 할 때만 `rebindRevision`.
- 목록을 안 적은 상태(`null`)와 "없음"(`[]`)을 UI에서 구분해 보여 주어야 한다(`declareNone`, `clearList`).

## 11. 검증

- `engine/test/service-plan-geometry.test.mjs` 40개: 계약 필드, 순서·역·접속, null/false/0/[] 구분, 외부선 미상, 같은 입력 = 같은 바이트, 이름·배열 순서 불변, key/key 없음 ID 규칙, revision·stale·application stale, 거절 사유, export 정렬·중복, 얼린 입력 불변, 편집 세션 전체, 삭제 key 재사용 금지, 저장·복원 바이트 동일, 다른 팩 저장본 거부(현재 문서 유지), 팩 버전 경고, 금지 낱말·import·시계·난수·저장소 검사, 예제 재생성.
- 실제 headless Chrome(같은 모듈): 편집 흐름(생성 → 구간 → 방향 → 시간대 → 비활성화 → 저장 → 복원 → 다른 팩 거부)이 맞았고, 예제 8개(radial 5, corridor 3)를 저장된 입력으로 브라우저에서 다시 만든 결과가 파일 본문과 바이트까지 같았으며 콘솔 오류는 없었다.

## 12. 하지 않은 것

화면(UI)·지도 오버레이·`main.mjs` 연결. 가능 여부·실제 간격·수송력·시간표·수요·운임·비용·혼잡·정시성 계산. 차량·차량기지 카탈로그 확인. 직통 경로 인계 정보 읽기. `.gitattributes` 변경(예제 비교는 줄바꿈을 정규화한다). 기존 B13/B14/B15 계약 변경.
