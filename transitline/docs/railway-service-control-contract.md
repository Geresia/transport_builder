# 장애 관제명령 공간 후보 계약 `transitline.railway-service-control-geometry/1`

B14-M7. 운행장애(`transitline.railway-disruption-site-geometry/1`)가 난 뒤 플레이어가 고를 수 있는 **회차·부분운휴·타사 선로 우회·대피 접근** 후보를 공간 사실로만 나열한다. 어느 후보가 좋은지, 열차를 운행할 수 있는지, 비용·복구시간·승객 손실·평판·보상액은 지도가 말하지 않는다. 후보를 고르고 실제 관제명령을 실행하는 것은 경영 엔진(Codex)이다.

## 경계

- 지도는 후보와 그 공간 사실만 낸다. 후보에는 점수·순위·추천·"가능/불가능"이 없다. 출력 키에 비용·시간·지연·복구·손실·보상·평판·점수·순위가 들어가지 않는다 (테스트가 키 이름을 전부 훑는다).
- 값을 알 수 없으면 `null` + `unknown[]` + `unknownReasons`. `0`, `false`, `[]`로 바꾸지 않는다. `unknown[]`과 `unknownReasons`는 항상 1:1이고 `unknown`에 든 값은 `null`이다. `[]`는 "측정했거나 선언했더니 없다"는 뜻이다.
- **`physicalAttachment: true`는 선로에 물리적으로 붙어 있다는 뜻일 뿐 열차가 회차할 수 있다는 판정이 아니다.** `physicalConnection: true`도 같다: 끝점이 측정으로 이어졌다는 뜻이지 운행 가능, 기술 호환, 용량 충분이 아니다.
- 지도 모듈은 management, 열차, 현금, 장애 상태를 import하지도 읽지도 쓰지도 않는다. 읽기 전용 view는 어떤 상태도 바꾸지 않는다.

## 파일

| 파일 | 역할 |
|---|---|
| `engine/src/map/railway-service-control.mjs` | `buildRailwayServiceControl`, `buildRailwayServiceControlExport`, `controlGeometryIdOf` |
| `engine/src/map/railway-service-control-candidates.mjs` | 회차·부분운휴·우회·대피 후보 계산 (지도 파일은 40 KB 이하라 나눔) |
| `engine/src/map/railway-service-control-editor.mjs` | 선택·해제·저장·복원 (순수 데이터, 삭제 없음) |
| `engine/src/map/railway-service-control-view.mjs` | 표시 모델, 캔버스 오버레이, 패널, 범례 (읽기 전용) |
| `scripts/build-railway-service-control-examples.mjs` | 예제 생성 (`npm run railway-service-control-examples`, `--out <dir>`) |
| `packs/*/railway-service-control-examples/` | 예제 11개 (radial 5, corridor 3, tokyo 3) |

## 입력

```
document: { eventId, accessPoints?: [{ key?, kind: "entrance"|"road-access", location, stationId?, roadWidthMeters?, basis: "player"|"source", name? }],
            emergencyVehicleWidthMeters?, active? }      // 플레이어가 지정한 관제 후보 문서
ctx:      { pack, site: RailwayDisruptionSiteGeometry v1, railGeometry: RailCapacityGeometry v1,
            application?: rail-capacity-application/1, routes?: [ThroughRouteGeometry v1],
            externalNetworks?: [기존 철도망], stationSites?: [StationSiteGeometry], spatial?: 공간 컨텍스트(도로 레이어) }
```

- `site`와 `railGeometry`는 같은 팩, 같은 `railGeometryId`, **같은 `railGeometryRevision`**이어야 한다. 아니면 거절한다 (`site-other-pack`, `site-geometry-mismatch`, `site-geometry-revision-mismatch`, `rail-geometry-other-pack`, `rail-geometry-schema-invalid`, `site-schema-invalid`, `document-event-mismatch`, `event-missing`, `affected-section-missing`, `several-affected-sections`). 지도에서 장애 사이트를 다시 만든 뒤에 호출한다.
- `application`은 같은 geometry·revision일 때만 쓴다. 오래됐으면 무시하고 경고(`application-stale`)한다.
- `routes`는 geometry가 만들어진 직통 경로(`throughRouteId`)이고 `geometryRevision`이 geometry의 `routeGeometryRevision`과 같을 때만 쓴다. 오래됐으면 무시하고 경고(`through-route-stale`).
- 구간이 없는 사이트(차량 고장, 구간 연결 없음)는 거절하지 않는다. 모든 후보 목록이 `null`이고 이유(`train-position-not-in-map`, `no-section-link`)가 `unknownReasons`에 든다.

## 출력 필드

`schema`, `contractVersion`, `controlGeometryId`, `controlGeometryRevision`, `sourcePackId/Version`, `eventId`, `disruptionSiteId`, `disruptionSiteRevision`, `railGeometryId`, `railGeometryRevision`, `throughRouteId`, `operationalLineId`, `affectedTrackSegmentIds`, `affectedSectionIds`, `affectedBlockIds`, `scope`(`section`/`block`/`train`), `affectedAlignment`, `disruptionLocation`, `turnbackCandidates`, `partialSuspensionCandidates`, `detourCandidates`, `evacuationAccessCandidates`, `spatialFlags`, `dataQuality`, `unknown`, `unknownReasons`, `warnings`, `sourceLayers`, `license`.

- `affectedTrackSegmentIds`: 영향 구간에 대응하는 운영 선로구간. application이 있으면 그 `sections[]`에서, 없으면 이벤트가 이름 붙인 `trackSegmentId` 하나뿐이다.
- `affectedBlockIds`: 구간 전체 장애는 그 구간의 모든 폐색, 폐색 장애는 그 폐색 하나. 폐색 자료가 없으면 `null`.
- `affectedAlignment`, `disruptionLocation`: 사이트의 선형·위치를 그대로 옮긴 표시용 사실. 위치 미상이면 `null`이다 (구간 중앙에 두지 않는다).
- 이벤트의 시각·심각도·소유자·운영자·책임은 싣지 않는다.

## 회차 후보 `turnbackCandidates`

영향 구간의 두 끝 역에서 **영향 구간을 쓰지 않고** 닿는 모든 역 (양쪽 모두). 역 하나가 후보 하나다.

| 필드 | 뜻 |
|---|---|
| `candidateId` | `stableId("railway-control-turnback", controlGeometryId, stationId)` |
| `stationId`, `location` | 역과 그 좌표 |
| `terminalResourceId` | 그 역에 대해 플레이어가 기록한 종착 자원. 기록이 없으면 `null` (`terminal-not-stated` / geometry에 종착 자료가 없으면 `no-terminal-data`) |
| `junctionResourceIds` | 종착 시설이 지나는 분기기 + 역에서 50 m 이내의 분기기. 분기기 자료가 없으면 `null` |
| `approachSectionIds` | 그 역에 닿는 영향 밖 구간 |
| `platformCandidateIds` | 승강장 후보. 종착이 기록됐고 승강장을 안 적으면 `null`, 승강장 없음으로 선언했으면 `[]` |
| `turnbackTrackCandidateIds` | 회차·인상·유치 선로 후보 (같은 규칙) |
| `physicalAttachment` | `true`: 시설 선로 하나라도 접근 선로에 측정으로 붙음(1 m 이내). `false`: 기록된 시설이 전부 측정으로 떨어짐(50 m 초과)이거나 시설이 없음으로 선언. `null`: 자료 없음·근접(1~50 m)·미측정 |
| `facilityAttachments` | 시설별 `{ kind, facilityId, attached }` |
| `adjacentToDisruption`, `sectionsFromDisruption` | 영향 구간 끝 역이면 `true` / 영향 구간에서 몇 구간 떨어졌는가 |

종착 기록이 없는 역(중간역)도 후보다. 그 역의 시설 필드는 전부 `null`이다 — 회차 가능 여부를 지도가 정하지 않는다.

## 부분운휴 후보 `partialSuspensionCandidates`

영향 구간을 포함한 **연속 구간 범위**와 그 경계 역 쌍. 영향 구간의 한쪽 끝에서 바깥으로 0~3구간(`MAX_SUSPENSION_EXTENSION_SECTIONS`), 다른 쪽도 0~3구간 뻗은 모든 조합을 나열한다 (경계 역은 그 범위의 끝 역). 3구간을 넘는 후보는 나열하지 않고 `spatialFlags`에 `partial-suspension-enumeration-limited`를 넣는다.

`candidateId`, `startStationId`, `endStationId`, `suspendedSectionIds`, `suspendedBlockIds`(범위 안 모든 구간의 폐색; 한 구간이라도 폐색 자료가 없으면 `null`), `retainedSectionIds`(나머지 구간), `boundaryJunctionResourceIds`(운휴 구간과 유지 구간을 함께 잇는 분기기), `isolatedStationIds`(닿는 모든 구간이 운휴라 열차가 남지 않는 역; 선로 끝 역 포함), `replacementConnectionStationIds`(범위 안 역 중 운휴 아닌 **기존선** 구간이 닿는 역; geometry에 기존선이 없으면 `null`, 있는데 없으면 `[]`), `startTurnbackCandidateId`/`endTurnbackCandidateId`(경계 역의 회차 후보 id), `geometry`(경계 좌표, 구간별 선형, 총 길이 — 외부선이 끼면 길이 `null`).

폐색 하나가 장애여도 운휴 범위는 **구간 전체**다 (구간이 가장 작은 단위). 후보의 좋고 나쁨은 판단하지 않는다.

## 우회 후보 `detourCandidates`

영향 구간의 두 끝 역을 잇는 **다른 경로**. geometry의 구간과, 직통 경로가 말하는 handover만 따라간다 (직통 경로의 handover가 서로 다른 두 역을 잇는 경우 그 둘은 명시적인 연결이다). 연결 후보가 없으면 `[]`이고 `no-detour-in-geometry`를 flag한다. 6구간(`MAX_DETOUR_SECTIONS`)보다 긴 경로는 나열하지 않고 `detour-enumeration-limited`를 flag한다.

`candidateId`, `sectionIds`(시작 역→끝 역 순), `externalLineIds`, `handoverIds`(직통 경로가 없거나 오래됐으면 `null`), `junctionResourceIds`(연결점에서 두 구간을 함께 잇는 분기기), `infrastructureOwnerIds`(경로 구간 하나라도 소유자를 모르면 `null`: 직통 경로 leg의 소유자, 없으면 기존 철도망 선의 소유자), `alignment`(외부선이 끼거나 handover 틈이 있으면 `null`), `physicalConnection`, `connections[]`, `startStationId`, `endStationId`, `viaStationIds`.

`physicalConnection`: `connections[]`(영향 구간→우회 첫 구간→…→영향 구간) 전체. 하나라도 `false`면 `false`, 전부 `true`면 `true`, 아니면 `null`. 연결 하나는 측정된 두 선형이 끝점에서 이어지면(1 m 이내) `true`, 붙어 있다고 한 끝점이 1~50 m면 `null`(`endpoints-near-not-joined`), 직통 경로 handover의 `physicalConnection`을 따른다. **외부선(기존선)은 선형·접속이 자료에 없으므로 `null` (`external-topology-not-in-source`)이고, 운행 가능·기술 호환·용량 충분을 판단하지 않는다.**

## 대피 접근 후보 `evacuationAccessCandidates`

영향 구간 양 끝 역에서 닿을 수 있는 확인된 접근점. 종류: `station`(양 끝 역), `entrance`(그 역에 연결된 역 부지의 출입구 후보), `player-access-point`(플레이어가 기록한 출입구·도로 접근점), `road-point`(도로 레이어에서 장애 위치에 가장 가까운 도로 위 점).

각 후보: `distanceMeters`(장애 위치가 있으면 위치까지, 없으면 영향 구간 선형까지, 둘 다 없으면 `null`; `distanceBasis`), `roadAdjacent`(50 m 이내에 도로: 도로 레이어가 없거나 범위 밖이면 `null`), `nearestRoad`, `roadWidthMeters`(**플레이어가 기록한 값만.** 도로 레이어에는 폭이 없다), `roadWidthAtLeastVehicleWidth`(도로 폭과 플레이어가 입력한 `emergencyVehicleWidthMeters`의 단순 비교. 폭 자료가 없으면 `null`), `nearestOfKind`(같은 종류 중 측정 거리가 가장 짧은 것; 동률이면 모두).

**도로가 있다는 사실과 긴급차량이 지나갈 수 있다는 판단은 다르다.** 지도는 앞의 것만 말한다. 소방·구급차 통과 여부는 도로 폭 자료가 없으면 `null`이다 — 필드 이름도 `…AtLeastVehicleWidth`로 폭 비교임을 드러낸다.

## spatialFlags

`whole-section-affected`, `single-block-affected`, `train-position-not-in-map`, `location-unknown`, `single-track-section-affected`, `double-track-section-affected`, `track-count-unknown`(플레이어가 적은 선로 수만 쓴다), `partial-suspension-enumeration-limited`, `detour-enumeration-limited`, `no-detour-in-geometry`, `through-route-not-supplied`, `terminal-data-missing`, `no-turnback-facility-stated`, `turnback-attachment-confirmed`, `turnback-not-attached`, `road-data-missing`, `entrance-data-missing`, `external-alignment-unknown`, `duplicate-section-id`.

## ID와 결정성

- `controlGeometryId = stableId("railway-service-control", packId, eventId)`: 이벤트와 팩만으로 정해진다. 이름·배열 순서·그린 방향·플레이어 선택·접근점이 바뀌어도 id는 같다. 후보 id는 `controlGeometryId`와 역·구간·분기기·handover id에서만 만든다.
- `controlGeometryRevision`: 공간 사실만의 해시. 접근점을 더하면 revision이 바뀐다.
- 같은 입력은 JSON이 바이트까지 같다. 입력 객체는 바꾸지 않는다 (동결된 입력 테스트).

## 편집기 `railway-service-control-editor.mjs`

문서는 `eventId`로 키를 잡는다 (`{ version, packId, packVersion, controls: [{ eventId, active, accessPoints, emergencyVehicleWidthMeters, selected }] }`). 지도는 후보를 제공할 뿐이고 플레이어의 **선택**을 후보 id로 저장한다. 실행은 Codex.

- `selectCandidate(doc, eventId, kind, candidateId, control)`: `kind`는 `turnback` / `partialSuspension` / `detour` / `evacuation`. 후보 id는 `control`이 실제로 내놓은 것이어야 한다(아니면 throw). 회차·우회·대피는 여러 개, 부분운휴는 한 번에 한 쌍 (새 선택이 이전 것을 대체). 고른 시점의 `controlGeometryRevision`을 함께 저장한다.
- `deselectCandidate`, `clearSelection(kind?)`, `reconcileSelections(doc, eventId, control)` → `{ current: [{ kind, candidateId, outdated }], stale: [{ kind, candidateId, reason }] }`: 지금 geometry가 더는 내놓지 않는 선택은 `stale`, id는 있는데 revision이 바뀌었으면 `outdated`.
- `addAccessPoint`, `removeAccessPoint`, `setEmergencyVehicleWidth`: 플레이어의 진술. 폭은 모르면 쓰지 않는다 (`null`).
- `deactivateControl` / `restoreControl`: 항목은 삭제하지 않고 끈다. 삭제 함수는 없다.
- `serializeRailwayServiceControlDoc` / `restoreRailwayServiceControlDoc(text, pack)`: 저장 후 id가 유지된다. 다른 팩 저장본, 읽을 수 없는 본, 다른 버전은 새 문서로 시작하고 경고한다.
- `toControlDocument(entry)`: `buildRailwayServiceControl`의 입력. `selectionsOf(doc)`: view와 경영 엔진이 읽는 `{ [eventId]: { turnback: [id], … } }`.

## view `railway-service-control-view.mjs`

`buildRailwayServiceControlView({ exportData, selections, selectedEventId })`, `drawRailwayServiceControlOverlay(ctx, model, screen)`, `renderRailwayServiceControlPanel`, `renderRailwayServiceControlLegend`. 다섯 가지가 서로 다른 색·선·글리프다.

| 대상 | 표시 |
|---|---|
| 장애 영향 범위 | 빨간 실선, 위치가 있으면 ✕ 배지 (위치 미상이면 배지 없이 "위치 미상—영향 범위 전체") |
| 회차 후보 | 초록 ◆ — 붙음(채움) / 떨어짐(✕) / 접속 미상(속 빈 점선 원) |
| 부분운휴 경계 | 보라 ‖ 배지 (선택하면 운휴 범위가 굵은 점선) |
| 우회 경로 | 파란 점선 (접속이 측정으로 떨어짐이면 성긴 점선), 선형이 없으면 그리지 않고 패널에 "선형 미상" |
| 대피 접근점 | 노란 배지 (역 ◉, 출입구 ▣, 지정 점 ◈, 도로 점 ═), 종류별 가장 가까운 것은 채움 |
| 선택된 후보 | 흰 테두리와 ✔ |

그리기는 `ctx`와 입력 모델만 쓰고 열차·현금·장애 상태를 호출하지 않는다. 플레이어가 적은 문자열은 `textContent`로만 넣는다.

## Codex가 연결할 것

1. `applyRailCapacityGeometry`가 만든 application을 `ctx.application`으로 준다. 장애 사이트는 M6 `buildRailwayDisruptionSiteExport`로 만든다.
2. 플레이어의 `selectionsOf(doc)`를 읽어 실제 회차·부분운휴·우회 명령으로 바꾸는 것은 경영 엔진이다. 후보 id → 엔진 ID는 이 문서의 필드로 잇는다: 역 `stationId`, 구간 `sectionId`(→ `affectedTrackSegmentIds`), 폐색 `blockId`, 종착·분기기 `terminalResourceId` / `junctionResourceId`, handover `handoverId`, 선로 소유자 `infrastructureOwnerIds`.
3. 접근 계약(`transitline.track-access/…`)과 우회 후보의 `handoverIds`·`infrastructureOwnerIds`는 id로만 잇는다. 접근료·정산은 지도가 모른다 (B12-4).
4. `index.html`/`main.mjs` 연결과 DOM 컨트롤러는 Codex 몫이다.

## 알려진 한계

- 우회·부분운휴 후보는 geometry에 든 구간과 직통 경로가 말한 연결만 쓴다. geometry에 없는 실제 노선은 없는 것이 아니라 **나열되지 않은 것**이다.
- 후보 나열 한계: 부분운휴 0~3구간, 우회 6구간. 넘으면 flag.
- 기존선은 역 단위뿐이라 선형·접속이 `null`이다. 직통 경로의 외부 handover도 접속을 알 수 없다.
- 도로 레이어에 폭이 없다. 폭은 플레이어가 적은 값뿐이다.
- 영향 구간이 둘 이상이거나 열차 이벤트(지도에 위치 없음)는 구간 후보를 내지 않는다 (후자는 `null` + 이유).
- **M5 `rail-capacity-geometry` 이슈(수정하지 않음, 금지 경로):** 같은 선이 같은 두 역 사이를 두 번 지나면(도쿄 도영 신주쿠선 예: `ward-koto`↔`ward-sumida`) 구간 id가 같아져 `sections[]`에 같은 `sectionId`가 둘 생긴다. 이 계약은 이를 `duplicate-section-id` 경고와 flag로 드러내고, 그래프에서는 한 구간으로 본다. 근본 수정은 M5의 sectionId에 선의 역 순번을 더하는 것이다.
- 브라우저 확인과 DOM 컨트롤러는 만들지 않았다. view는 가짜 캔버스·DOM 테스트로만 확인했다.

## 예제 (합성)

이벤트·application·직통 경로 loop·종착/폐색/분기기 같은 선로 사실은 전부 **합성**이다 (`source.synthetic: true`, `source.note`). 계획선은 같은 팩의 실제 plan 예제다. 각 파일의 `source.input`에 생성 입력(설계, 경로, 이벤트, application, 저장된 선택 문서)이 있고, `source.selection`은 편집기로 고른 후보 id다.

| 팩 | 예제 | 보여 주는 것 |
|---|---|---|
| radial | 01-terminal-turnback | 종착역 회차: 양 끝 종착에 붙은 승강장·회차 선로 (`physicalAttachment: true`) |
| radial | 02-midway-turnback-candidate | 중간역 회차 후보: 종착 기록이 없는 역은 시설 필드가 `null` |
| radial | 03-partial-suspension-around-the-event | 장애 앞뒤 부분운휴: 경계 역 쌍과 회차 후보 id의 연결, 편집기로 고른 선택 |
| radial | 04-detour-over-another-companys-track | 타사 선로 우회: 다른 회사 소유 선로를 도는 우회 (측정으로 이어짐), 소유자 id |
| radial | 05-evacuation-access-with-roads-and-entrances | 합성 도로 레이어·역 출입구·플레이어 접근점, 폭 `null`과 입력된 폭 비교 |
| corridor | 01-terminal-turnback-with-facilities | 승강장 둘·인상선·유치선이 있는 종착역 |
| corridor | 02-no-turnback-facility-data | 회차 시설 자료 없음: 모든 시설 필드 `null` |
| corridor | 03-single-track-one-block | 단선 구간의 폐색 하나가 장애 |
| tokyo | 01-existing-line-detour-connection-unknown | 기존선(역 단위)을 도는 우회: 선형·접속 미상, `duplicate-section-id` 경고 |
| tokyo | 02-no-evacuation-access-data | 도로·출입구 자료가 없는 대피 접근, 장애 위치 미상 |
| tokyo | 03-vehicle-failure-train-position-unknown | 차량 고장: 모든 후보 `null` |

## 검증

`npm test`(`engine/test/railway-service-control.test.mjs`, 41개), `npm run validate`, `git diff --check`, 예제 생성기 두 번 실행 후 바이트 비교(테스트가 `--out`으로 다시 만들어 비교).
