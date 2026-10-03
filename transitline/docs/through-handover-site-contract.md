# 직통 접속부(연락선·분기기) 공간 계약 `transitline.through-handover-site-geometry/1`

B12-6 M4. `ThroughRouteGeometry`(`transitline.through-route-geometry/1`)의 handover 하나에 대해, 플레이어가 고른 양쪽 접속점·그린 연락선·분기기·작업구역과 그 공간 사실을 낸다. 외부 기존망은 선로 선형 자료가 없어 `handover.physicalConnection`이 `null`인데, 이 계약이 "그린 연락선이 양쪽 선로에 실제로 이어졌는가"라는 **공간 증거**를 제공한다.

## 경계

- 지도 모듈은 공간 사실만 계산한다. 비용·가격·공기·승인·확률·점수와 possible/conditional/impossible 판정은 경영 엔진의 몫이며 이 모듈은 경영 엔진을 import하지 않는다(테스트로 고정).
- 값을 알 수 없으면 `null` + `unknown[]` + `unknownReasons`. `0`, `false`, `[]`로 바꾸지 않는다.
- 외부선 접속점 선택, 외부역 중심점, 노선 이름, 운영사 태그는 접속 증거가 아니다. 외부선의 실제 선형(`externalAlignments`)이 공급될 때만 외부 측이 측정 가능해진다.

## 파일

| 파일 | 역할 |
|---|---|
| `engine/src/map/through-handover-site.mjs` | `buildThroughHandoverSite`, `buildThroughHandoverExport`, `snapToLegAlignment`, `turnoutCandidatesNear` |
| `engine/src/map/through-handover-editor.mjs` | 순수 데이터 편집·저장·복원 |
| `engine/src/map/through-handover-view.mjs` | 표시 모델, 캔버스 오버레이, 패널, 범례 |
| `engine/src/map/through-handover-ui.mjs` | DOM 편집기(index.html 연결은 Codex) |
| `scripts/build-through-handover-examples.mjs` | 예제 생성 (`npm run through-handover-examples`) |
| `packs/*/through-handover-examples/` | 예제 12개 (tokyo 3, radial 7, corridor 2) |

## 입력

```
drawn: {
  key?, name?,
  throughRouteId, handoverId, fromLegId, toLegId,   // route의 handover와 정확히 일치해야 함
  routeGeometryRevision,                            // 설계 당시 route.geometryRevision
  fromConnectionPoint?, toConnectionPoint?,         // [lon,lat]
  connectionAlignment?,                             // [[lon,lat]...] 어느 방향으로 그려도 from→to로 정규화
  turnoutCandidates?: [{ key?, location, selected? }],   // selected 기본 true
  workAreas?: [{ key?, polygon }]
}
ctx: { pack, route, plans?, externalNetworks?, externalAlignments?, spatial? }
```

`externalAlignments`: `[{ externalNetworkId?, externalLineId, alignments: [[[lon,lat]...]...], quality?, source: { name, license } }]`. 외부선의 실제 선형 자료. 없으면 외부 측은 항상 미상.

`externalNetworks`를 주면 기존 철도 레이어(역 사이 직선, **조잡함**, quality `low`)가 만들어진다. 주지 않으면 `existingRailwayCrossingCount`는 `null`(`no-layer`).

## 거부(`site: null`, 코드가 있는 warning)

`route-schema-invalid`, `through-route-id-mismatch`, `handover-missing`, `handover-legs-mismatch`(from/to leg가 handover와 다르거나 뒤바뀜), `leg-missing`, `connection-point-invalid`, `connection-alignment-invalid`. 작업구역·분기기 좌표 하나가 잘못되면 그 항목만 버리고 warning(`work-area-degenerate`, `work-area-self-intersecting`, `turnout-location-invalid`, `duplicate-turnout`).

## 출력 필드

| 필드 | 의미 |
|---|---|
| `schema`, `contractVersion`, `handoverSiteId`, `siteRevision`, `key`, `sourcePackId`, `sourcePackVersion`, `name` | `siteRevision`은 공간 사실만 해시(이름 제외) |
| `throughRouteId`, `routeGeometryRevision`, `handoverId`, `fromLegId`, `toLegId` | route의 현재 값. `designedRouteGeometryRevision`은 설계 기준 |
| `fromConnectionPoint`, `toConnectionPoint` | 아래 "접속점" |
| `connectionAlignment`, `connectionLengthMeters` | 그린 연락선(from→to 정규화), 길이(m). 안 그렸으면 `null` |
| `minimumCurveRadiusMeters` | 연락선 꺾임점의 최소 반경(PlanGeometry와 같은 꼭짓점 필렛 규칙). 직선(꼭짓점 2개)은 상한값 `100000`. 안 그렸거나 길이 0이면 `null` |
| `structureHint`, `structureHintBasis` | 연락선 구조형식. **플레이어가 지정한 값만**(`STRUCTURE_HINTS` 중 하나, basis `"player"`). 건물·수역 교차로 추정하지 않으며 미지정은 `null`(`structure-not-stated`) |
| `turnoutCandidates[]` | 플레이어가 찍은 분기기 후보 전체 `turnoutId, key, location, selected` |
| `endpointGapMeters` | 양쪽 `gapMeters` 중 큰 값. 한쪽이라도 측정 불가면 `null` |
| `selectedTurnoutPoints[]` | 선택된 분기기 `turnoutId, key, location, nearestLegId, distanceToFromLegMeters, distanceToToLegMeters, distanceToConnectionAlignmentMeters, distanceToFromPointMeters, distanceToToPointMeters, onTrack`. `turnoutId` 순 |
| `connectedPlanSegmentIds[]` | 접속점이 놓인 계획 노선 구간 ID(계획 측만). 접속점 미선택·계획 없음이면 `null` |
| `externalNetworkId`, `externalLineId`, `externalSides[]` | route가 말하는 외부 leg의 ID. 외부 leg가 없거나 두 외부 leg가 다르면 단일 필드는 `null`(`externalSides`가 정본). 소유자는 route 값 그대로 |
| `buildingIntersectionCount`, `waterCrossingCount`, `roadCrossingCount` (+`roadCrossingsByClass`), `existingRailwayCrossingCount` | 연락선이 건드린 서로 다른 항목 수. 레이어 없음·범위 밖이면 `null` |
| `averageSlopePercent`, `maximumSlopePercent` | 연락선을 25 m 간격으로 샘플한 **지반 경사**(선로 기울기 아님). DEM 없으면 `null` |
| `workAreaCandidates[]` | `workAreaId, key, polygon(정규 링), location, areaSquareMeters, buildingIntersectionCount, waterOverlapCount, containsFromConnectionPoint, containsToConnectionPoint, coversConnectionAlignment, containedTurnoutIds, unknown, unknownReasons` |
| `spatialFlags[]` | 공간 사실 표식(점수 아님): `no-connection-drawn, connection-separated, connection-gap-within-near-distance, leg-alignment-unknown, route-revision-stale, connection-through-buildings, connection-crosses-water, connection-crosses-road, connection-crosses-existing-railway, connection-point-away-from-leg-end, no-turnout-selected, turnout-not-on-track, work-area-building-overlap, work-area-water-overlap` |
| `physicalConnectionEvidence` | 아래 |
| `dataQuality`, `unknown[]`, `unknownReasons`, `warnings`, `sourceLayers`, `license` | 사용한 레이어만 `sourceLayers`에 기록. 사용 레이어 품질이 낮으면 `dataQuality`도 내려감 |

### 접속점 `fromConnectionPoint` / `toConnectionPoint`

`legId, sourceKind, location, legAlignmentKnown, legAlignmentKind("plan-alignment"|"external-alignment"|null), onLegAlignment, distanceToLegAlignmentMeters, planSegmentId, alongLegMeters, distanceToHandoverEndMeters, unknown, unknownReasons`.
`onLegAlignment`은 선택점이 그 leg의 **알려진 선형** 위(1 m 이내)인가: true/false, 선형을 모르면 `null`.

## `physicalConnectionEvidence` — 정확한 의미

```
{ connected: true|false|null, basis, reason, toleranceMeters: 1, nearDistanceMeters: 50,
  designedAgainstCurrentRoute: true|false|null, sides: [from, to] }
sides[i]: { side, legId, legAlignmentKind, connectionEndToPointMeters, pointToLegAlignmentMeters, gapMeters, joined, reason }
```

각 쪽의 간극 = max(연락선 끝↔선택한 접속점, 접속점↔그 leg 선형). 이 값으로:

- **true**: 양쪽 모두 알려진 선형이 있고 간극 ≤ 1 m. "그린 연락선이 양쪽 선로에 실제로 이어졌다"는 측정 증거.
- **false**: 어느 한쪽이라도 간극 > 50 m로 **측정**됨. 다른 쪽이 미상이어도 false다(이미 떨어져 있음이 측정됐으므로).
- **null** (`unknown[]`에 `physicalConnectionEvidence`, 이유는 `reason`/`unknownReasons`):
  - `point-not-selected`, `no-connection-drawn`
  - `external-alignment-not-in-source` / `leg-alignment-not-in-route`: 그 leg의 선형 자료가 없음
  - `endpoints-near-not-joined`: 간극이 1 m 초과 50 m 이하. M1과 같은 규칙으로 "가깝지만 이어졌다고 할 수 없음"이며 false가 아님. 측정한 간극은 `endpointGapMeters`에 남음
  - `route-revision-stale`: 설계 기준 revision ≠ 현재 route revision. 측정값은 보고하되 증거는 확정하지 않는다
  - `design-revision-not-recorded`: 설계 기준 revision이 없음

true/false는 "지도가 측정한 공간 사실"일 뿐 직통운행 가부가 아니다. 가부 판정은 경영 엔진이 한다.

## ID

- `handoverSiteId`: `key`가 있으면 `stableId("through-handover-site", packId, "key", key)`(편집·재그리기·handover 변경 후에도 유지). `key`가 없으면 `(packId, throughRouteId, handoverId)`에서 파생. 이름·그린 순서·좌표로 만들지 않는다.
- `turnoutId`, `workAreaId`: 사이트 ID + 항목 `key`(없으면 좌표). 출력 배열은 ID 순, 연락선은 항상 from→to 방향이라 그린 순서·방향에 무관하다.

## 편집·저장

`through-handover-editor.mjs`: `addSite`(handover 선택, 설계 기준 revision 기록), `selectHandover`(대상 변경: 그림은 지우고 key 유지), `setConnectionPoint`(route를 주면 알려진 선형에 50 m 이내로 스냅), `addWaypoint/moveWaypoint/removeWaypoint/clearWaypoints`, `addTurnout/moveTurnout/setTurnoutSelected/removeTurnout`, `addWorkArea/redrawWorkArea/removeWorkArea`, `rebindRoute`(플레이어가 현재 route를 다시 확인했음을 기록), `toDrawnSite`, `serializeThroughHandoverDoc`, `restoreThroughHandoverDoc`.

- 편집은 설계 기준 revision을 바꾸지 않는다. route가 바뀐 뒤에는 `rebindRoute`로 명시적으로 확인하기 전까지 stale이다.
- 다른 팩의 저장본은 거부(`through-handover-doc-other-pack`)하고 빈 문서를 돌려준다. 팩 버전만 다르면 `pack-version-mismatch` 경고.

## 표시 (`through-handover-view.mjs`)

원래 두 leg(파랑), 그린 연락선, 접속 상태 배지, 선택 분기기(◆), 작업구역, 건물·수역·도로·철도 충돌 마커. 접속 상태는 세 모양이 다르다: true = 초록 실선 ✓, false = 빨강 실선 ✕, null = 노랑 점선 ?(경로가 바뀌면 보라 점선 ↻). 충돌 마커는 발견 = 채운 원+개수, 미상 = 속 빈 ?, 0 = 표시 없음. 선형 자료가 없는 접속점은 속 빈 고리 + "선형 자료 없음". 충돌 마커는 정확한 교차 위치가 아니라 연락선 중간에 모아 표시한다. 비용·공기·승인 결과는 표시하지 않는다. 패널은 `textContent`만 사용한다.

## 한계

- 외부 기존망 자료는 역 단위 좌표뿐이라 외부 측 접속은 항상 미상이다(Wikidata/OSM에서 실제 선형을 가져오기 전까지).
- 기존 철도 교차는 역 사이 직선(조잡) 기준이다.
- 경사는 DEM 31 m 격자의 지반 경사이며 선로 기울기가 아니다.
- 건물 자료는 팩마다 범위가 다르다(Tokyo `obstacles.json`은 4개 구역). 범위 밖은 `outside-coverage`로 미상이다.
- 연락선이 건물 위로 지나가는지는 알지만 지하·고가 여부는 모른다.
