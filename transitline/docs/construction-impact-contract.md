# 공사 사건·대응 공간 계약 (지도 → 경영 엔진)

경영 엔진(`engine/src/management/**`)이 사건(사고/민원/자재 부족/인허가 지연/지장물 충돌/예상 못한 지반/접근 차단)의 발생 확률·심각도·비용·지연·평판 손실과 플레이어 대응의 결과를 계산한다. 이 코드는 그 값을 만들지 않고 `management`를 import하지도 않으며(테스트가 검사), **사건이 일어났는지 자체도 결정하지 않는다** — 엔진이 이미 보고한 사건이 "어디서" 일어났는지, 그 자리가 무엇과 겹치는지, [construction-site-contract.md](construction-site-contract.md)의 공구 후보지(수직구/작업장/자재 적치장/공사용 도로 진입점/차량 반입 지점) 중 무엇과 이어지는지만 답한다.

## 코드 (모두 `engine/src/map/`)

| 파일 | 역할 |
|---|---|
| `construction-impact.mjs` | 사건 → `ConstructionImpactGeometry`. 진입점 `buildConstructionImpact()`/`buildConstructionImpactExport()` |
| `construction-impact-editor.mjs` | 사건별 대응 선택 문서(선택한 대체 후보 ID 또는 직접 수정한 영향권 폴리곤): 저장·복원. 순수 데이터, `eventId`(엔진이 준 ID)로 키를 삼는다 |
| `construction-impact-view.mjs` | `report.constructionMarkers`/`report.constructionPackages` 읽기 전용 표시: 사건 종류·상태별 마커, 선택한 사건의 영향권·연결 공구·후보 구분, 위치 없는 사건은 공구 중심점에 `locationUnknown` 표시로 대신 그림 |
| `construction-impact-ui.mjs` | 브라우저 마운트: 마커 클릭으로 사건 선택, 후보 클릭으로 대응 선택, 영향권 직접 수정(다각형 그리기) |
| `scripts/build-construction-impact-examples.mjs` | 예제 생성(`npm run construction-impact-examples`) |

`construction-site.mjs`의 `ringFacts()`(건물/수역/기존철도 겹침, 주거지 거리)와 `nearestRoadAt()`(가장 가까운 도로)를 그대로 재사용해, 공구 자체 계약과 같은 방식으로 사실을 낸다.

## 사건 종류 (`EVENT_KINDS`, 엔진이 지정)

`incident`(사고), `complaint`(민원), `material-shortage`(자재 부족), `permit-delay`(인허가 지연), `utility-conflict`(지장물 충돌), `unexpected-ground`(예상 못한 지반), `access-blocked`(접근 차단).

사건마다 어떤 후보 종류로 대응할 수 있는지는 지도 쪽이 고정해 둔다(`RESPONSE_KINDS`, 비용·확률과 무관한 순수 공간 분류):

| eventKind | 대응 후보 종류 |
|---|---|
| `incident` | `accessRoad`, `vehicleAccess`, `workArea` |
| `complaint` | `workArea`, `materialYard` |
| `material-shortage` | `materialYard`, `accessRoad`, `vehicleAccess` |
| `permit-delay` | (없음 — 공구 전체에 걸린 서류상 보류) |
| `utility-conflict` | `workArea`, `shaft` |
| `unexpected-ground` | `shaft`, `workArea` |
| `access-blocked` | `accessRoad`, `vehicleAccess` |

## 입력 (엔진 → 지도)

```js
// drawn
{ eventId, eventKind, constructionSiteId,
  location?: [lon, lat],                    // 엔진이 준 사건 위치
  candidateRef?: { kind, id },               // 또는 공구의 기존 후보를 가리킴(위치는 그 후보에서 읽음)
  selectedResponseCandidateId?: string|null, // 플레이어가 이미 고른 대응(대응 편집기 문서에서 옴)
  customAffectedPolygon?: [[lon,lat]...] }   // 플레이어가 직접 수정한 영향권
```

`eventId`는 엔진이 준 값을 그대로 쓴다(따로 해시하지 않음) — 저장·재로딩에도 같은 ID가 유지된다.

## 출력 `ConstructionImpactGeometry`

`schema: "transitline.construction-impact-geometry/1"`, `contractVersion: 1`. 사용자가 지정한 계약 필드 그대로:

```js
{
  schema, contractVersion,
  eventId, constructionSiteId, eventKind,
  eventLocation, affectedPolygon,
  spatialFacts, linkedCandidateIds, alternativeCandidates, selectedResponseCandidateId,
  dataQuality, unknown, unknownReasons,
}
```

| 필드 | 내용 |
|---|---|
| `eventLocation` | `[lon, lat]`(반올림 6자리). `drawn.location`이 있으면 그대로, 없으면 `candidateRef`가 가리키는 후보의 위치(점 후보는 `location`, 면 후보는 폴리곤 중심). 둘 다 없으면 `null`+`"no-event-location"` |
| `affectedPolygon` | 우선순위: `customAffectedPolygon` > `permit-delay`는 공구 전체 폴리곤 > `workArea`/`materialYard`에 연결된 사건은 그 후보의 폴리곤 그대로 > `eventLocation` 중심의 원(반지름은 사건 종류별 `IMPACT_MODEL.affectedRadiusMeters`, 손해 반경이 아니라 "이 사건이 대략 덮는 땅") |
| `spatialFacts` | `connected{planId,segmentIds,stationId,depotSiteId}`(공구 자체 연결, `construction-site-contract.md`와 동일), `intersectedBuildingCount`, `waterOverlapCount`, `roadsOccupied`, `existingRailwayOverlapCount`, `distanceToResidentialMeters`+`residentialBasis`, `nearestMajorRoad{roadClass,distanceMeters}`, `majorRoadAccessible` |
| `linkedCandidateIds` | `candidateRef`로 지정된 후보 + 사건 위치에서 `IMPACT_MODEL.linkRadiusMeters`(60 m) 안에 있는 그 공구의 다른 후보들. `{kind, id}[]` |
| `alternativeCandidates` | 같은 대응 후보 종류를, 이 사건에 연결되지 않은 것들 중 전체 팩에서 가까운 순으로(반경 `alternativeSearchRadiusMeters`=1500 m, 최대 `maxAlternatives`=5개). `{kind, id, constructionSiteId, distanceMeters, location}[]` |
| `selectedResponseCandidateId` | `drawn.selectedResponseCandidateId`가 `linkedCandidateIds`나 `alternativeCandidates`에 실제로 있을 때만 유지, 없으면 `null`+경고(`selected-response-candidate-missing`) — 대응 편집기가 스스로 검증하지 않고 지도가 매번 다시 검증한다 |
| `dataQuality`/`unknown`/`unknownReasons` | 다른 계약과 같은 규칙: 값을 못 구하면 0이 아니라 `null`+이름+사유 |

계약에 없는 것: 확률·심각도·비용·지연월수·평판 손실·하자책임·보상금·향후 입찰 경쟁력 — 전부 경영 엔진의 몫이다(테스트가 필드명에 금지어 정규식으로 검사).

## 대응 편집기 (`construction-impact-editor.mjs`)

```js
newImpactResponseDoc(packId, packVersion)   // { version, packId, packVersion, entries: [] }
setResponseCandidate(doc, eventId, candidateId)
setCustomAffectedPolygon(doc, eventId, polygon)
clearResponse(doc, eventId)
responseFor(doc, eventId)
serializeImpactResponseDoc(doc) / restoreImpactResponseDoc(text, pack)
```

`entries`는 `eventId`(엔진 고유 ID)로 키를 삼는다 — 별도 ID를 만들지 않으므로 저장 후 다시 열어도 같은 사건에 같은 선택이 남는다. `restoreImpactResponseDoc`은 다른 팩에는 적용하지 않고(`impact-response-doc-other-pack`), 팩 버전이 다르면 경고(`pack-version-mismatch`), 읽을 수 없으면 빈 문서+`impact-response-doc-unreadable`.

## 표시 (`construction-impact-view.mjs`, 읽기 전용)

- `buildImpactMarkerViews(report, constructionExport)` — `report.constructionMarkers[]`마다 한 마커. `kind`별 색·기호, `status`(`unresolved`/`responding`/`resolved`/`ignored`)별 테두리색. **엔진이 상태를 안 주면 "상태 불명"으로 표시할 뿐 추정하지 않는다.** 마커에 `location`이 없으면 그 사건이 속한 공구의 중심점을 임시 위치로 쓰고 `locationUnknown: true`를 같이 낸다.
- `buildImpactDetailView(impact, constructionExport)` — 선택한 사건의 연결 공구 폴리곤, `linkedCandidates`(실선)와 `alternativeCandidates`(점선) 구분, `selectedResponseCandidateId`와 일치하는 후보에 `selected: true` 표시.
- `drawImpactMarkers`/`drawImpactDetail`/`renderImpactPanel` — 캔버스에 그리거나 패널에 텍스트로 낼 뿐, 엔진 상태·현금을 절대 바꾸지 않는다(테스트가 입력을 얼려서 확인).

## 브라우저 마운트 (`construction-impact-ui.mjs`)

```js
mountConstructionImpact({ canvas, projection, pack, getConstructionExport, getReport, getSpatial, onChange, enabled, autoRefreshMs })
```

`station-selection-ui.mjs`/`construction-selection-ui.mjs`와 같은 패턴: 자체 오버레이 캔버스, 자체 패널, DOM 이벤트(`transitline:construction-impact`), `main.mjs`/`index.html`/`style.css`는 건드리지 않는다. 대응 문서는 `localStorage` 키 `transitline.impact-responses.v1:<packId>`에 저장한다. 마커 클릭으로 사건을 고르고, 후보(선/폴리곤) 클릭으로 대응을 고르며, "영향권 직접 수정" 버튼으로 다각형을 새로 그려 `customAffectedPolygon`을 저장할 수 있다(Enter/더블클릭/"완료" 버튼으로 확정).

## 결측 규칙

`construction-site-contract.md`와 같다: 0이 아니라 `null`+`unknown[]`+`unknownReasons`. 이 계약에서 더 쓰는 사유는 `no-event-location`(사건 위치도 연결 후보도 없음) 하나뿐이고, 나머지는 기존 어휘(`no-layer`, `outside-coverage`, `no-polygon` 등)를 그대로 쓴다.

## ID 규칙

`eventId`는 엔진이 준 값을 그대로 계약의 `eventId`로 쓴다 — 별도 해시를 만들지 않는다. 대응 편집기 문서도 같은 `eventId`로 키를 삼으므로, 저장·재로딩·배치 재계산 모두 같은 사건이면 같은 응답을 낸다(예제 테스트가 바이트 단위로 확인).

## 예제

`packs/tokyo/construction-impact-examples/`(8), `packs/example-radial/construction-impact-examples/`(8), `packs/example-corridor/construction-impact-examples/`(8). 모두 같은 팩의 `construction-examples/`가 이미 낸 공구(수직구·작업장·자재 적치장·도로 진입점 후보 포함)에 연결한다.

| # | 종류 | 설명 |
|---|---|---|
| 01 | 터널 사고 + 수직구 연결 | `incident`, 수직구 후보에 연결, 접근로·차량 반입·작업장 대안 제시 |
| 02 | 주거지 인접 고가 민원 | `complaint`, `distanceToResidentialMeters` 확인 |
| 03 | 개착 구간 접근 차단 | `access-blocked`, 공사용 도로 진입점 연결, `majorRoadAccessible` |
| 04 | 자재 적치장 사용 불가 + 대안 | `material-shortage`, 대체 적치장이 `alternativeCandidates`에 뜸 |
| 05 | 지장물 충돌 | `utility-conflict`, 작업장 후보에 연결 |
| 06 | 예상 못한 지반 | `unexpected-ground`, 수직구(합성/도쿄 팩) 또는 작업장(코리더 팩, 수직구가 없는 고가 공구) |
| 07 | 위치 불명 자재 부족 | 위치·연결 후보 모두 없음 — `eventLocation`/`affectedPolygon`/대안 전부 `null`+사유 |
| 08 | 공간자료 전혀 없음 | 레이어를 주입하지 않음 — 겹침·거리·최근접 도로 전부 `null`+`"no-layer"` |

`example-corridor` 팩은 터널 공구가 없어(고가·차량기지만) 수직구 후보가 없다 — 06번 예제는 수직구 대신 작업장 후보로 대응을 연결한다(계약상 `unexpected-ground`는 `shaft`/`workArea` 둘 다 허용).

## 알려진 한계 / 경영 엔진 합의사항

- `affectedPolygon`의 원 반지름(사건 종류별 60/120/40/0/30/80/40 m)은 **손해 범위가 아니라 지도 표시용 대략의 넓이**다. 실제 영향 반경은 엔진이 심각도로 정해야 한다면, 그 값을 다시 `customAffectedPolygon`으로 이 모듈에 넘겨 덮어쓸 수 있다.
- `linkRadiusMeters`(60 m)·`alternativeSearchRadiusMeters`(1500 m)는 순수 공간 상수이며 비용·확률과 무관하다. 엔진이 다른 반경을 원하면 `IMPACT_MODEL`을 그대로 노출해 뒀으니 읽어서 검증에 쓸 수 있다.
- `report.constructionMarkers[].status`는 `unresolved`/`responding`/`resolved`/`ignored` 네 값을 사용한다. 옛 개발 세이브의 `awaiting-response`는 불러올 때 `unresolved`로 변환한다.
- `report.constructionPackages`와 `report.constructionMarkers`는 별도 최상위 자료이며 `constructionSiteId`로 연결한다. 한 공구에 여러 사건이 존재할 수 있다.
- `eventId`는 한 게임에서 단조 증가하고 저장·복원 후에도 번호를 재사용하지 않는다. 지도 `localStorage`의 선택은 엔진에 자동 반영하지 않으며 플레이어가 화면의 `지도 후보 적용`을 명시적으로 눌러야 한다.
- 지하수·연약지반·지장물 자료는 어떤 팩에도 없다(`constraintUnknown`은 공구 계약과 같은 세 가지를 그대로 물려받는다).
- 대응 문서는 브라우저 `localStorage`(팩별 키)에만 저장된다.
