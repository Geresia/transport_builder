# 공구별 작업면·중장비 반입 공간 계약 (지도 → 경영 엔진)

경영 엔진(`engine/src/management/**`)이 시공사 입찰 비용, 공사 기간, 낙찰, 장비 배치 가능/조건부/불가 판정을 계산한다. 이 코드는 그 값을 만들지 않고 `management`를 import하지도 않으며(테스트가 검사), [construction-site-contract.md](construction-site-contract.md)의 후보지(수직구·작업장) 중 하나를 시공사 장비가 실제로 서는 땅으로 읽어 사용 면적·경사·주요 도로 거리·건물/수역/기존철도 겹침·주변 후보와의 연결, 그리고 플레이어가 직접 그린 조립장·적치장 면적만 낸다.

## 코드 (모두 `engine/src/map/`)

| 파일 | 역할 |
|---|---|
| `construction-workfront.mjs` | 작업면 → `ConstructionWorkfrontGeometry`. 진입점 `buildConstructionWorkfront()`/`buildConstructionWorkfrontExport()` |
| `construction-workfront-editor.mjs` | 공구 하나에 여러 작업면을 두는 문서: 추가·삭제, 장비 반입점 선택, 조립장·적치장 폴리곤 직접 수정, 저장·복원. 순수 데이터 |
| `construction-workfront-view.mjs` | 공구·작업면·조립장·적치장·반입점을 서로 다르게 표시, `report.contractorId`/`packageContractId`/`equipmentAssignments`를 읽기 전용으로 표시 |
| `construction-workfront-ui.mjs` | 브라우저 마운트: 수직구/작업장 후보 클릭으로 작업면 배치, 반입점 선택 모드, 조립장/적치장 그리기 |
| `scripts/build-construction-workfront-examples.mjs` | 예제 생성(`npm run construction-workfront-examples`) |

`construction-site.mjs`의 `ringFacts()`(건물/수역/기존철도 겹침, 주거지 거리), `nearestRoadAt()`(가장 가까운 도로), `terrainFacts()`(경사·표고)를 그대로 재사용한다. 공사용 후보지 클릭 선택은 `construction-selection.mjs`의 `pickConstructionCandidate()`를 그대로 쓴다(새로 만들지 않음).

## 작업면은 무엇인가

작업면(work front)은 **그 공구의 수직구 또는 작업장 후보 그 자체**다(`WORKFRONT_CANDIDATE_KINDS = ["shaft", "workArea"]`) — 자재 적치장·도로 진입점·차량 반입점은 작업면이 아니라 작업면에 "연결된" 것들이다. 작업장 후보는 이미 폴리곤이 있어 그대로 쓰고, 수직구 후보는 점이므로 `footprintMeters`(없으면 기본 14 m) 한 변의 정사각형을 만들어 쓴다. 한 공구에 여러 작업면을 둘 수 있다(예: 터널 양끝 수직구 각각).

## 입력 (엔진/플레이어 → 지도)

```js
// drawn
{ workfrontId?, constructionSiteId,
  candidateRef: { kind: "shaft" | "workArea", id },
  accessCandidateRef?: { kind: "accessRoad" | "vehicleAccess", id }, // 미지정 시 가장 가까운 것을 자동 선택
  assemblyPolygon?: [[lon,lat]...],  // 조립장, 손으로 그린 것만 인정(자동 분할 없음)
  storagePolygon?: [[lon,lat]...] }  // 적치장, 마찬가지
```

`workfrontId`는 `(constructionSiteId, candidateRef)`에서 결정적으로 나온다(`workfrontIdFor()`) — 같은 후보를 다시 골라도 같은 ID, 저장 후 다시 열어도 같은 ID.

## 출력 `ConstructionWorkfrontGeometry`

`schema: "transitline.construction-workfront-geometry/1"`, `contractVersion: 1`.

| 필드 | 내용 |
|---|---|
| `workfrontId`, `constructionSiteId`, `connectedPlanId`, `candidateRef` | 식별·연결 |
| `polygon`, `location`, `usableAreaSquareMeters` | 작업면 자체의 실제 폴리곤(후보 폴리곤 그대로, 또는 수직구의 정사각 발판)과 그 면적 |
| `minimumWidthMeters`, `minimumLengthMeters` | 폴리곤의 인접 두 변 길이(작업면은 항상 사각형이므로 정확) |
| `averageSlopePercent`, `maximumSlopePercent` | `terrainFacts()`로 DEM 표본 |
| `nearestMajorRoad`, `majorRoadAccessible` | 반경 1500 m 안의 가장 가까운 주요/고속 도로 |
| `intersectedBuildingCount`, `waterOverlapCount`, `existingRailwayOverlapCount`, `distanceToResidentialMeters` | 작업면 폴리곤 위의 겹침·주거지 거리(`ringFacts()` 그대로, `roadsOccupied`는 이 계약에 없어 제외) |
| `linkedShaftId`, `linkedWorkAreaId`, `linkedMaterialYardId` | 같은 공구에서 60 m 안의 가장 가까운 각 종류 후보 ID. 작업면 자신이 그 종류면 자기 자신을 가리킴(자기 참조) |
| `linkedAccessCandidateRef` | 실제로 반입점 역할을 하는 후보(`{kind, id}`, 플레이어가 고른 것 또는 200 m 안에서 자동 선택된 것) — 없으면 `null` |
| `equipmentAccessFacts.entryWidthMeters` | 반입점에 가장 가까운 작업면 폴리곤 변의 길이("장비가 들어오는 입구 폭"). 반입점이 없으면 `null`+`"no-connection"` |
| `equipmentAccessFacts.turningSpaceSquareMeters` | 작업면(항상 사각형)에 내접하는 원의 넓이 = `π×(min(폭,길이)/2)²` — 사각형이므로 근사가 아니라 정확한 값 |
| `equipmentAccessFacts.roadWidthMeters` | **항상 `null`**. 어떤 팩의 도로 레이어도 폭 속성을 갖지 않는다(레이어가 없으면 사유 `"no-layer"`, 있어도 속성이 없으면 `"no-attribute"`) |
| `equipmentAccessFacts.overheadClearanceMeters` | **항상 `null`+`"no-layer"`**. 어떤 팩에도 고가선·구조물 높이 레이어가 없다 |
| `stagingFacts.assemblyAreaSquareMeters`, `storageAreaSquareMeters` | `drawn.assemblyPolygon`/`storagePolygon`을 손으로 그렸을 때만 값이 나온다(`null`+`"not-provided"`가 기본) — 작업면 폴리곤을 자동으로 나눠 추측하지 않는다 |
| `stagingFacts.spoilRemovalAccess` | `majorRoadAccessible`과 같은 값(대형 반출 차량은 주요 도로가 필요하므로), 사유도 그대로 물려받음 |
| `stagingFacts.deliveryAccess` | 반경 300 m 안에 **아무 등급이나** 도로가 있는지(반출과 달리 일반 배송은 소로도 가능) |
| `spatialFlags` | `building-collision`, `water-overlap`, `near-residential`(≤100 m), `steep-workfront`(평균경사 ≥3%), `no-major-road-access`. 점수가 아니라 사실 표시 |
| `dataQuality`, `unknown`, `unknownReasons` | 다른 계약과 같은 규칙 |
| `sourceLayers`, `license`, `model` | 자료 출처·라이선스·이 모듈이 쓴 상수 전부(`WORKFRONT_MODEL`) |

계약에 없는 것: 입찰 비용·공기·시공사·배치 가능/조건부/불가 판정 — 전부 경영 엔진의 몫이다(테스트가 필드명에 `cost`/`bid`/`duration`/`contractor`/`feasib` 등 금지어 정규식으로 검사).

## 작업면 편집기 (`construction-workfront-editor.mjs`)

```js
newWorkfrontDoc(packId, packVersion)              // { version, packId, packVersion, entries: [] }
addWorkfront(doc, { constructionSiteId, candidateRef })  // 같은 후보를 다시 넣으면 기존 항목을 그대로 반환(중복 없음)
removeWorkfront(doc, workfrontId)
setAccessCandidate(doc, workfrontId, candidateRef)
setAssemblyPolygon(doc, workfrontId, polygon)
setStoragePolygon(doc, workfrontId, polygon)
workfrontFor(doc, workfrontId) / workfrontsForSite(doc, constructionSiteId)
serializeWorkfrontDoc(doc) / restoreWorkfrontDoc(text, pack)
```

한 문서의 `entries[]`가 곧 `buildConstructionWorkfront()`의 `drawn` 입력이다(같은 모양) — 편집기가 저장한 그대로 지도가 다시 계산한다. `restoreWorkfrontDoc`은 다른 팩에는 적용하지 않고(`workfront-doc-other-pack`), 팩 버전이 다르면 경고(`pack-version-mismatch`), 읽을 수 없으면 빈 문서+`workfront-doc-unreadable`.

## 표시 (`construction-workfront-view.mjs`, 읽기 전용)

- `KIND_STYLE`: `site`(공구, 파란 점선), `workfront`(작업면, 노란 실선), `assembly`(조립장, 청록 점선), `storage`(적치장, 주황 점선), `access`(반입점, 빨간 삼각형) — 다섯 가지를 서로 다른 색·선으로 그린다.
- `buildWorkfrontMarkerViews(workfronts)` — 배치된 작업면마다 목록 한 줄(이미 계산된 `ConstructionWorkfrontGeometry[]`를 받는다 — 이 모듈은 지오메트리를 계산하지 않는다).
- `buildWorkfrontDetailView(workfront, entry, constructionExport)` — 선택한 작업면의 공구 외곽선, 작업면 자체, 손으로 그린 조립장·적치장, 반입점 위치(공구의 후보 목록에서 `linkedAccessCandidateRef`로 다시 찾음)를 한데 묶는다.
- `buildEquipmentReportView(report, workfront)` — `report.equipmentAssignments[]`에서 이 작업면(`workfrontId`, 없으면 `constructionSiteId`)을 찾아 `contractorId`/`packageContractId`/배치 판정을 **엔진이 쓴 값 그대로** 낸다. 판정값이 `feasible`/`conditional`/`infeasible`이면 한글 라벨로 보여 주고, 그 외 값은 엔진이 준 문자열을 그대로 보여 준다(추측하지 않음). 엔진이 아무것도 안 주면 `found: false`.
- `drawWorkfrontMarkers`/`drawWorkfrontDetail`/`renderWorkfrontPanel` — 캔버스에 그리거나 패널에 텍스트로 낼 뿐, 엔진 상태·현금을 절대 바꾸지 않는다(테스트가 입력을 얼려서 확인).

## 브라우저 마운트 (`construction-workfront-ui.mjs`)

```js
mountConstructionWorkfront({ canvas, projection, pack, getConstructionExport, getReport, getSpatial, onChange, enabled, autoRefreshMs })
```

다른 지도 마운트와 같은 패턴: 자체 오버레이 캔버스, 자체 패널, DOM 이벤트(`transitline:construction-workfront`), `main.mjs`/`index.html`/`style.css`는 건드리지 않는다. 문서는 `localStorage` 키 `transitline.workfronts.v1:<packId>`에 저장한다.

- 기본 모드: 지도에서 수직구·작업장 후보를 클릭하면 그 자리에 작업면을 배치(또는 이미 있으면 선택)한다. `pickConstructionCandidate()`를 그대로 써서 전체 공구의 모든 후보 중 가장 가까운 것을 고른다.
- "장비 반입점 선택": 클릭 한 번으로 공사용 도로 진입점/차량 반입점 후보를 골라 `linkedAccessCandidateRef`로 연결한다.
- "조립장 그리기"/"적치장 그리기": 점을 여러 번 클릭해 다각형을 그리고 완료(버튼/더블클릭/Enter)로 확정한다 — A6-2의 "영향권 직접 수정"과 같은 흐름.
- "작업면 삭제": 그 작업면 항목만 문서에서 지운다.

## 결측 규칙

`construction-site-contract.md`와 같다: 0이 아니라 `null`+`unknown[]`+`unknownReasons`. `roadWidthMeters`(도로 폭 속성 자체가 어느 팩에도 없음)·`overheadClearanceMeters`(고가·구조물 높이 자료가 어느 팩에도 없음)는 **항상** 결측이다. 조립장·적치장 면적은 플레이어가 그리기 전까지 `"not-provided"`로 항상 결측이며, 작업면 자신의 폴리곤을 잘라 자동으로 채우지 않는다.

## ID 규칙

`workfrontId = workfrontIdFor(constructionSiteId, candidateRef)`(결정적 해시) — 같은 후보를 다시 고르면 항상 같은 ID가 나오므로 편집기의 `addWorkfront()`는 중복을 만들지 않고 기존 항목을 그대로 돌려준다. 저장·재로딩·배치 재계산 모두 같은 입력이면 같은 출력이다(예제 테스트가 바이트 단위로 확인).

## 예제

`packs/tokyo/construction-workfront-examples/`(9), `packs/example-radial/construction-workfront-examples/`(9), `packs/example-corridor/construction-workfront-examples/`(7, 이 팩엔 터널 공구가 없어 수직구 시나리오 대신 작업장의 조립공간 부족으로 대체). 모두 같은 팩의 `construction-examples/`가 이미 낸 공구에 연결한다.

| # | 종류 | 설명 |
|---|---|---|
| 01 | 터널 TBM 조립공간 부족 | `shaft` 작업면 + 실제보다 훨씬 작은 조립장 폴리곤을 직접 지정(부족을 구체적 숫자로 보여줌) |
| 02 | 개착 작업면 | `workArea` 작업면 |
| 03 | 고가 크레인 작업면 | 고가 공구의 `workArea` 작업면 |
| 04 | 역 공사 | 역 공구의 `workArea` 작업면 |
| 05 | 차량기지 | 차량기지 공구의 `workArea` 작업면 |
| 06 | 주요도로 접근 가능 | `majorRoadAccessible: true` |
| 07 | 주요도로 접근 불가 | 도로 레이어는 있지만 소로만 있는 예제 전용 레이어로 `majorRoadAccessible: false`(레이어 결측이 아니라 실제 사실) |
| 08(도쿄)/06(합성) | 주거지 인접 | `spatialFlags`에 `near-residential` |
| 09(도쿄·radial)/07(corridor) | 공간자료 전혀 없음 | 레이어를 주입하지 않음 — 전부 `null`+`"no-layer"` |

## 알려진 한계

- `minimumWidthMeters`/`minimumLengthMeters`/`turningSpaceSquareMeters`는 작업면 폴리곤이 사각형이라는 전제로 계산한다(수직구는 정사각 발판, 작업장은 이미 사각형 후보) — 플레이어가 작업면 자체의 외곽선을 임의 다각형으로 손수 편집할 수 있게 되면 진짜 최소외접사각형 계산으로 바꿔야 한다.
- `entryWidthMeters`는 "반입점에 가장 가까운 작업면 변의 길이"로 근사한다 — 실제 게이트/개구부 폭이 아니다.
- `roadWidthMeters`·`overheadClearanceMeters`는 어떤 팩에도 원본 자료가 없어 항상 결측이다. 실제 차로 폭·구조물 높이 자료가 들어오면 이 두 필드부터 채울 수 있다.
- 작업면 문서는 브라우저 `localStorage`(팩별 키)에만 저장된다.

## Codex 경영 계약 확정

[작업면·중장비 배치 경영 연동 보고서](construction-workfront-management-integration-2026-09-28.md)에서 다음을 확정했다.

- `ScenarioRuntime.report().equipmentAssignments[]`를 최상위 평면 목록으로 제공한다.
- 정확한 연결 키는 `workfrontId`, `constructionSiteId`는 구버전 폴백이다.
- 배치 판정 어휘는 `feasible` / `conditional` / `infeasible`다.
- `contractorId`와 `packageContractId`는 각 장비 배정 항목 안에 둔다.
- 알려진 공간조건 실패는 입찰·공사를 막고, 결측은 `conditional`로 보존한다.
