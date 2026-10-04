# 철도 운행장애 공간 계약 `transitline.railway-disruption-site-geometry/1`

B14-M6. 운행장애 이벤트(`transitline.railway-disruption/1`)가 철도 공간 사실(`transitline.rail-capacity-geometry/1`) 위의 **어디에 있고 무엇을 건드리는가**를 낸다. 영향받는 구간·폐색·신호 위치 후보·분기기·역·종착과, 같은 구간에 접근하는 다른 길을 공간 사실로만 낸다.

## 경계

- 지도는 공간 사실만 낸다. 장애가 얼마나 오래 가는지, 비용, 확률, 열차를 계속 운행할 수 있는지, 복구 계획과 시간, 지연, 책임과 정산은 전부 경영 엔진·운행 시뮬레이션의 몫이다. 이 모듈은 경영 엔진과 운행 상태(`railway-disruptions`, `railway-traffic-control`, `trains`, `state`, `scenario-runtime`)를 import하지 않고, 읽기 전용이라 어떤 상태도 바꾸지 않는다(테스트로 고정).
- 이벤트의 시각(`startedAtMinute`, `expectedEndMinute`, `resolvedAtMinute`), 심각도, 소유자·운영자·책임은 출력에 싣지 않는다. 지도가 읽는 것은 이벤트의 **대상**(`trackSegmentId`/`blockId`/`trainId`), `kind`, `status`, `effect`뿐이다.
- 값을 알 수 없으면 `null` + `unknown[]` + `unknownReasons`. `0`, `false`, `[]`로 바꾸지 않는다. `unknown[]`과 `unknownReasons`는 항상 1:1이고 `unknown`에 든 값은 `null`이다.
- **위치를 모르는 사건은 구간 중앙에 두지 않는다.** `location: null`이고 영향 범위는 구간 전체(또는 해당 폐색)다.

## 파일

| 파일 | 역할 |
|---|---|
| `engine/src/map/railway-disruption-site.mjs` | `buildRailwayDisruptionSite`, `buildRailwayDisruptionSiteExport`, `disruptionSiteIdOf`, `snapToSection` |
| `engine/src/map/railway-disruption-site-editor.mjs` | 순수 데이터 편집·저장·복원 (삭제 없음, 비활성/복원) |
| `engine/src/map/railway-disruption-site-view.mjs` | 표시 모델, 캔버스 오버레이, 패널, 범례 |
| `scripts/build-railway-disruption-site-examples.mjs` | 예제 생성 (`npm run railway-disruption-examples`, `--out <dir>`) |
| `packs/*/railway-disruption-examples/` | 예제 12개 (radial 6, corridor 3, tokyo 3) |

## 입력

```
drawn: { eventId, location?: [lon,lat], locationBasis?: "player"|"source", affectedPolygon?: [[lon,lat]...],
         railCapacitySectionId?, designedRailGeometryRevision?, railGeometryId?, active? }
ctx:   { pack, events: [transitline.railway-disruption/1], railGeometry: RailCapacityGeometry v1,
         applications?: [transitline.rail-capacity-application/1] }
```

이벤트에서 읽는 필드: `id`, `kind`, `status`(`active`/`responding`/`resolved`), `lineId`, `trackSegmentId`, `blockId`, `trainId`, `effect: { closed, speedLimitMps }`. 위치와 영향권은 플레이어가 직접 지정한다(`drawn`).

**구간 연결**: 엔진의 `trackSegmentId`(운영 선로구간)는 지도의 `sectionId`와 다른 ID다. 세 가지 길로 잇는다.
1. `applications[]`(Codex의 `applyRailCapacityGeometry` 결과): 같은 `railGeometryId`·`operationalLineId`의 `sections[].trackSegmentId → railCapacitySectionId`. application의 `railGeometryRevision`이 현재 geometry와 다르면 이 연결은 쓰지 않는다(`rail-capacity-link-stale`).
2. 폐색 ID: `blockId`는 지도의 `blockId` 그대로이므로 폐색이 속한 구간이 곧 구간 연결이다.
3. 명시 `railCapacitySectionId`.

여러 길이 가리키는 구간이 서로 다르면 거절한다(`section-link-conflict`, `block-section-mismatch`). 연결할 길이 하나도 없으면 거절하지 않고 `railCapacitySectionId: null`(`no-section-link`)이며 공간 사실은 모두 null이다.

## 거부와 경고

거부(`site: null`): `event-missing`, `event-schema-invalid`, `event-kind-invalid`, `event-target-missing`(구간도 열차도 없음), `rail-geometry-schema-invalid`, `rail-geometry-other-pack`, `block-data-missing`(폐색 ID가 있는데 geometry에 폐색 자료가 없음), `block-missing`, `block-section-mismatch`, `section-link-conflict`, `section-missing`, `location-invalid`, `location-basis-invalid`.
경고(항목만 비움): `kind-not-known`(알 수 없는 종류는 그대로 싣는다), `status-not-recognized`, `polygon-degenerate`, `revision-stale`, `revision-not-recorded`.

## 출력 필드 전체

| 필드 | 의미 |
|---|---|
| `schema`, `contractVersion`, `disruptionSiteId`, `siteRevision`, `sourcePackId`, `sourcePackVersion` | `siteRevision`은 공간 사실만 해시 |
| `eventId`, `lineId`, `trackSegmentId`, `blockId`, `trainId` | 이벤트의 대상(그대로) |
| `railGeometryId`, `railGeometryRevision`, `designedRailGeometryRevision` | 연결한 철도 공간 사실과 그 개정, 위치·영향권을 그린 때 기준 개정 |
| `railCapacitySectionId`, `sectionLinkBasis` | 지도 구간, 연결 근거(`"application"`/`"block"`/`"explicit"`) |
| `kind`, `status` | 이벤트의 종류·상태. 인식 못 하는 `status`는 `null`(`status-not-recognized`) |
| `scope` | `"section"`(`blockId` null: 구간 전체), `"block"`(그 폐색만), `"train"`(열차 대상) |
| `effect` | `{ closed, speedLimitMps }` 이벤트가 말한 그대로. 형식이 틀리면 `null`(`effect-not-stated`) |
| `location`, `locationBasis` | 플레이어가 지정한 위치와 근거. 없으면 `null`(`location-not-stated`) |
| `locationAttach` | 위치를 구간에 대어 잰 값 `{ sectionId, alongMeters, distanceToSectionMeters, onSection, withinAffectedExtent }` |
| `alignment` | 영향받는 선형. 구간 전체면 구간 선형, 폐색이면 그 폐색의 잘라낸 선형 |
| `affectedExtent` | `{ startLocation, endLocation, lengthMeters }` 영향 범위의 양 끝과 길이 |
| `affectedPolygon`, `polygonFacts` | 플레이어가 그린 영향권(정규 링), 그 안의 공간 사실 |
| `affectedSectionIds`, `affectedBlockIds`, `affectedSignalCandidateIds`, `affectedJunctionResourceIds`, `affectedStationIds`, `affectedTerminalResourceIds` | 영향받는 구간·폐색·신호 후보·분기기·역·종착 |
| `alternativeAccessCandidates` | 같은 구간에 닿는 다른 길(아래) |
| `spatialFlags` | 공간 사실 표식(판정 아님) |
| `dataQuality`, `unknown[]`, `unknownReasons`, `warnings`, `sourceLayers`, `license` | `unknown`은 하위 항목의 미상까지 `locationAttach:…`, `polygonFacts:…` 같은 경로로 모은다 |

내보내기: `{ schema: "transitline.railway-disruption-site-export/1", packId, packVersion, sites[], inactive[], warnings[] }`. `inactive[]`는 비활성으로 둔 사이트의 `{ eventId, disruptionSiteId }`(만들지 않지만 ID는 유지).

## 구간 전체와 특정 폐색

| | `blockId` null (`scope: "section"`) | `blockId` 있음 (`scope: "block"`) |
|---|---|---|
| `affectedSectionIds` | `[구간]` | `[구간]` |
| `affectedBlockIds` | 구간의 모든 블록. 폐색 자료가 없으면 `null`(`no-block-data`) | `[그 폐색]` |
| `affectedSignalCandidateIds` | 구간의 모든 신호 후보 | 폐색 경계에 선 후보(양쪽 경계, 양방향)와 그 폐색을 보호하는 후보 |
| `affectedJunctionResourceIds` | 구간에 닿는 모든 분기기 | 구간 위 위치가 폐색 안(±1 m)인 분기기 |
| `affectedStationIds` | 구간 양 끝역 | 폐색이 구간 끝에 닿는 쪽의 역. **구간 중간의 폐색은 `[]`**(역에 안 닿는다는 사실) |
| `affectedTerminalResourceIds` | 접근 구간이 이 구간인 종착 | 위와 같되 폐색이 그 종착역에 닿을 때만 |
| `alignment`, `affectedExtent` | 구간 전체 | 폐색만 |

신호 후보는 실제 신호가 아니라 폐색 경계에서 신호를 세울 수 있는 위치 후보다(철도 공간 사실 계약과 같다).

## true / false / null / [] 의 의미

- **`null`**: 자료가 없어 말할 수 없음. 이유는 `unknownReasons`에 있다(`no-section-link`, `train-position-not-in-map`, `external-alignment-not-in-source`, `no-block-data`, `no-junction-data`, `no-terminal-data`, `location-not-stated`, `no-polygon-drawn`, `design-revision-stale`, …).
- **`[]`**: 측정(또는 선언)했더니 없다는 사실. 예) 구간 중간의 폐색은 닿는 역이 `[]`, 분기기 자료가 있는 구간에 분기기가 없으면 `[]`. 자료가 없는 것(`null`)과 다르다.
- **`locationAttach.onSection`**: 위치가 구간 선형에서 1 m 이내면 `true`, 50 m 초과면 `false`, 그 사이는 `null`(가깝지만 닿았다고 할 수 없음). `withinAffectedExtent`: 위치가 영향 범위 안인가(구간 전체면 구간 안, 폐색이면 그 폐색 안). 구간에서 떨어진 위치는 `null`(`location-not-on-section`).
- **`polygonFacts.coversLocation`**: 영향권이 위치를 덮으면 `true`, 덮지 않으면 `false`, 위치가 없으면 `null`.
- `false`/`true`는 모두 공간 측정이며 운행 가부나 판정이 아니다.

## 위치·영향권·개정

- 위치와 영향권은 플레이어(또는 `source`)가 직접 지정한다. 지도는 위치를 만들어내지 않는다.
- 영향권 폴리곤은 정규 링으로 저장한다(가장 낮은 꼭짓점부터, 반시계). 그 안의 `sectionIdsCrossed`, `stationIdsInside`, `junctionResourceIdsInside`, `signalCandidateIdsInside`는 측정값이다. 선형이 없는 구간(기존선)은 폴리곤과 겹치는지 말할 수 없어 `sectionIdsNotMeasured`로 따로 둔다.
- 위치·영향권은 그린 때의 철도 공간 사실 개정(`designedRailGeometryRevision`)에 대해서만 측정한다. 현재 개정과 다르면(`design-revision-stale`) 기록이 없으면(`design-revision-not-recorded`) `locationAttach`와 `polygonFacts`는 `null`이고 경고가 붙는다. 플레이어가 그린 위치·폴리곤 자체는 그대로 남고, 이벤트가 직접 가리키는 구간·폐색은 현재 geometry에서 읽는다.

## 대체 접근 후보 `alternativeAccessCandidates[]`

영향 구간 양 끝의 역(`kind: "station"`, `relation: "section-start"|"section-end"`)과 그 끝에서 이어지는 다른 구간(`kind: "joined-section"`, `relation: "joined-at-start"|"joined-at-end"`). 항목은 `{ candidateId, kind, refId, relation, distanceMeters, unknown, unknownReasons }`이고, `distanceMeters`는 위치에서 그 끝까지의 구간을 따라 잰 거리다(위치를 모르면 `null`, `location-not-stated`). 쓸 수 있는지, 얼마나 걸리는지는 판정하지 않는다. 선형이 없는 구간은 목록 전체가 `null`이다. 분기기·종착 쪽 인접은 `affected…Ids`와 철도 공간 사실의 `junctions`/`terminals`로 읽는다.

## ID

`disruptionSiteId = stableId("railway-disruption-site", packId, eventId)`. 이름, 입력 배열 순서, 위치·영향권 편집과 무관하며, 같은 이벤트는 같은 ID다. 대체 후보 ID는 사이트 ID와 `(kind, refId, relation)`에서 파생한다.

## 편집과 저장 (`railway-disruption-site-editor.mjs`)

`addSite`(이벤트 하나에 사이트 하나, 철도 공간 사실 개정 기록), `setLocation`(구간 선형에 50 m 이내로 스냅), `clearLocation`, `setAffectedPolygon`, `clearAffectedPolygon`, `setSectionLink`, `rebindRailGeometry`(현재 개정 재확인), `deactivateSite`/`restoreSite`(**삭제 없음**: 비활성이어도 ID·위치·영향권이 남고 복원하면 그대로다), `activeSites`, `toDrawnSite`, `serializeRailwayDisruptionDoc`, `restoreRailwayDisruptionDoc`. 문서는 엔진이 준 `eventId`를 키로 삼는다. 다른 팩의 저장본은 거부(`railway-disruption-doc-other-pack`)하고 빈 문서를 돌려주며, 팩 버전만 다르면 `pack-version-mismatch` 경고다. 엔진 상태는 읽지도 쓰지도 않는다.

## 표시 (`railway-disruption-site-view.mjs`)

상태: 발생 중(진하게) / 대응 중(흰 윤곽을 더함) / 해결됨(흐리게, ✓). **폐쇄**는 빨강 실선 굵은 선과 ✕, **속도 제한**은 주황 점선과 ▼와 `속도 제한 N km/h`(m/s를 km/h로 환산해 보일 뿐이다), 효과 미상은 회색. 영향권은 반투명 면. **위치를 모르는 사건은 마커를 두지 않고** 영향 구간 전체를 강조한 뒤 구간 시작점 옆에 `위치 미상—구간 전체`(폐색이면 `위치 미상—해당 폐색`, 열차면 `위치 미상—열차`)라고 적는다. 선형이 없는 구간은 선을 그리지 않고 `선형 자료 없음`이라고 적는다. 비용·확률·가능 여부·복구 시간은 표시하지 않는다. 패널은 `textContent`만 쓰며 엔진을 바꾸지 않는다.

## 예제 (`packs/*/railway-disruption-examples/`)

이벤트와 application은 사람이 쓴 **합성 입력**(`source.synthetic: true`)이고, geometry는 같은 팩의 실제 철도 용량 예제다.

| 팩 | 파일 | 사례 |
|---|---|---|
| radial | 01 | 신호 장애, 구간 전체(폐색 3개, 신호 후보 4개) |
| radial | 02 | 선로 지장물, 특정 폐색 하나(대응 중, 영향권 폴리곤) |
| radial | 03 | 악천후 속도 제한, 분기기가 있는 구간 + 영향권(위치 미지정) |
| radial | 04 | 공사 사고, 평면교차 옆 구간(폐색 자료 없음) |
| radial | 05 | 위치 미상, 구간 전체, 폐색 자료 없음 |
| radial | 06 | 해결된 선로 지장물(특정 폐색) |
| corridor | 01 | 종착 접근 구간의 선로 지장물(분기기·종착 포함) |
| corridor | 02 | 단선 구간의 한 폐색 신호 장애 |
| corridor | 03 | 폐색 자료가 없는 구간의 공사 사고 |
| tokyo | 01 | 기존선(선형 없음)의 신호 장애: 외부선 자료 미상 |
| tokyo | 02 | 실제 수역·건물 레이어 위의 악천후 속도 제한 + 영향권 |
| tokyo | 03 | 차량 고장: 열차 대상이라 지도 위치 없음 |

## Codex가 연결해야 할 것

| 경영·운행 쪽 | 이 계약 |
|---|---|
| 이벤트 `id` | `eventId`, `disruptionSiteId`(`railway-disruption-site` + 팩 + 이벤트) |
| `trackSegmentId` ↔ 지도 구간 | `railCapacitySectionId`. `applyRailCapacityGeometry`가 만든 application을 `ctx.applications`로 준다 |
| `blockId` | 지도 `blockId`와 같음(`affectedBlockIds`) |
| 영향 폐색·분기기·종착 | `affectedBlockIds`, `affectedJunctionResourceIds`, `affectedTerminalResourceIds` (B13-4 연동기의 자원 ID와 같다) |
| `effect.closed`/`speedLimitMps` | `effect`(그대로 복사한 값) |
| 대응 선택(B14-2) | `alternativeAccessCandidates`는 후보 목록일 뿐이다. 선택·비용·시간은 경영 쪽 |

이벤트에 `railCapacitySectionId`나 위치가 없어도 괜찮다: 구간 연결이 안 되어 있으면 `null`과 이유가 오고, 위치가 없으면 구간 전체로 읽는다.

## 한계

- 이벤트의 위치는 엔진이 주지 않으므로 플레이어(또는 `source`)가 지정해야 한다. 지정이 없으면 항상 위치 미상이다.
- 열차 대상 이벤트(차량 고장)는 열차의 지도 위치를 모르므로 공간 사실이 모두 `null`이다.
- 기존 외부선은 역 단위 좌표뿐이라 선형·길이·위치 측정·대체 접근 후보가 미상이다.
- 폐색·신호·분기기·종착 자료는 철도 공간 사실에 플레이어가 입력한 것만 있다. 없으면 해당 영향 목록은 `null`이다.
- 영향권은 사람이 그린 도형이며 지도가 날씨나 지반에서 만들어내지 않는다.
- 두 계획이 같은 선로를 겹쳐 그리면 구간이 둘로 나오는 철도 공간 사실의 한계를 그대로 가진다.
