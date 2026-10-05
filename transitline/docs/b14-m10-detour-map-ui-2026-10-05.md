# B14-M10 타사 철도 우회운행 지도 편집 UI

작성일: 2026-10-05. 대상: `main.mjs`/경영 엔진을 연결할 작업자(Codex).

M9 `transitline.railway-detour-service-geometry/1`을 플레이어가 지도에서 **선택·검토·편집**하는 독립 마운트다. 지도 사실과 플레이어의 선택만 다룬다. 우회 운행 판정, 기술호환, 접근협정, 비용, 배차, 정산, 열차 운행은 하지도 추정하지도 않는다. 이 단계에서 `main.mjs`·`index.html`·`style.css`에는 연결하지 않았다.

## 파일

- `engine/src/map/railway-detour-service-ui.mjs` — 마운트와 순수 헬퍼
- `engine/test/railway-detour-service-ui.test.mjs` — 26개 (가짜 DOM으로 마운트 전체를 시험)
- M9 지도 파일은 수정하지 않았다.

## API

```js
const bridge = mountRailwayDetourService({
  canvas, projection, pack,
  getRailGeometry, getRailCapacityApplication, getDisruptionSites, getServiceControls,
  getThroughRoutes, getExternalCatalog, getExternalNetworks, getStationSites, getSpatial,
  onChange, enabled = true, autoRefreshMs = 250,
});
```

- 입력 getter는 콜백이다. 값은 객체 하나, 목록, 또는 각 export(`{designs}`, `{sites}`, `{controls}`, `{routes}`, `{networks}`)여도 된다. 없으면(`null`/`undefined`) 빈 목록으로 본다. `getSpatial`은 M9가 공간 레이어를 읽지 않으므로 받기만 하고 쓰지 않는다(다른 지도 UI와 같은 getter를 넘길 수 있게).
- 입력은 읽기만 한다 (동결된 입력으로 시험). 입력의 revision 지문이 바뀔 때만 M9를 다시 계산한다.
- `bridge.output()` →
  `{ document, export, picks, selected, selectedPlan, warnings }`
  - `document`: 현재 plan 문서 (M9 편집기 문서, 복사본)
  - `export`: `buildRailwayDetourServiceExport(...)` 결과
  - `picks`: `picksOf(document)` = `{ "<eventId>|<detourCandidateId>": { legIds, connectionIds, transferIds } }`
  - `selected`: 선택한 계획의 `RailwayDetourServiceGeometry` (없거나 만들 수 없으면 `null`)
  - `selectedPlan`: `{ eventId, candidateId }` 또는 `null`
  - `warnings`: UI 메모 + export 경고 + 계획 상태(`railway-detour-plan-outdated`, `-plan-not-offered`, `-control-missing`, `-pick-stale`)
- `onChange(output)`와 캔버스의 `transitline:railway-detour-service` 이벤트(`detail` = output)는 값이 바뀔 때만 한 번씩 나간다.
- 조작: `choose(eventId, candidateId)`(=`select`), `deselect()`, `pick(kind, id)`, `unpick(kind, id)`, `togglePick`, `clearPicks()`, `setPlanActive(bool)`, `rebind()`, `startDrawing("connection"|"transfer")`, `addDraftPoint([lon,lat])`, `finishDrawing()`, `cancelDrawing()`, `addPlayerConnection(polyline, {key,name})`, `addPlayerTransferPath(...)`, `redraw(kind, key)`, `removeDrawing(kind, key)`, `save()`, `serialize()`, `loadDoc(textOrObject)`, `refresh()`, `setEnabled(bool)`, `destroy()`. 읽기: `selectedPlan`, `mode`, `document`, `storageKey`.
- 순수 헬퍼(DOM 없이 시험 가능): `readDetourInputs`, `candidatesOf(controls)`, `pickDetourItem(model, screen, point)`, `snapDetourPoint(model, screen, point, {entrances})`, `rebindDetourPlan(doc, eventId, candidateId, control, detour)`.

## 저장 구조

`localStorage["transitline.railway-detour.v1:<packId>"]` = M9 편집기 문서 JSON `{ version: 1, packId, packVersion, plans: [{ eventId, detourCandidateId, active, selectedOnControlGeometryRevision, selectedOnDetourGeometryRevision, picked: { legIds, connectionIds, transferIds }, connections: null|[{key,name,polyline}], transferPaths: null|[…] }] }`.

- 열린 선택(어느 계획을 보고 있는가)은 저장하지 않는다. ID와 revision은 키·후보 ID에서 정해지므로 저장 전후로 같다 (브라우저에서 확인).
- 다른 팩 저장본, 읽을 수 없는 본, 다른 버전은 **거부**: 경고만 남기고 지금 계획과 저장본을 그대로 둔다 (`loadDoc`도 같다). 팩 버전 불일치는 경고(`pack-version-mismatch`)하고 계획은 받아들인다.
- 저장소가 막혀 있으면 메모리에서 계속하고 `railway-detour-doc-not-saved`를 남긴다.

## 플레이어 조작 흐름

1. 패널 "우회 후보"에 활성 M7 control geometry의 `detourCandidates`만 나온다. "계획 만들기"(또는 지도의 흐린 후보 선을 클릭)로 계획을 만들고 선택한다. 후보가 없으면 메시지만 나온다.
2. M9 geometry가 지도에 나온다: 계획선 leg는 선, 기존선 leg는 선을 지어내지 않고 역 위치와 "기존선 역(상세 자료 없음)", 서로 다른 두 역을 잇는 연결은 점선(표시용 직선).
3. 선택: 패널 행의 "선택/해제" 또는 지도에서 leg·접속 표시·환승 연결·그린 선을 클릭(다시 클릭하면 해제). 접속 표시 > 그린 선 > 환승 연결 > leg 순으로 가까운 것을 고른다.
4. 그리기: "연결선 그리기"/"환승 동선 그리기" → 점을 클릭(역 가까이면 역에, 환승 동선은 출입구에도 붙음) → 완료/더블클릭/Enter, 취소/Esc. 키는 `connection-N`/`transfer-N`. "다시 그리기"는 같은 키로 선만 바꾸므로 ID가 유지되고, "삭제"는 선과 그 선택을 지운다.
5. 계획은 삭제하지 않고 "계획 끄기/켜기"만 있다.
6. 관제 후보가 바뀌어 계획이 오래되면: 값을 추정하지 않고 경고만 나온다. "현재 관제 후보로 다시 확인"을 누르면 새 revision이 기록되고 그림은 남는다 (더는 없는 선택은 이 때 정리된다).

## 접속 표시

| 값 | 패널 | 지도 고리 |
|---|---|---|
| true | ● 측정상 연결(true) | 초록 실선 |
| false | ✕ 실제로 끊김(false) | 빨강 실선 |
| null | ? 측정 못 함·미상(null) | 회색 점선 |

패널에는 항상 "플레이어가 그린 연결선은 접속 사실(true/false/null)을 바꾸지 않습니다."가 나온다. 그림은 `connections[].physicalConnection`도 최상위 `physicalConnection`도 바꾸지 않는다 (true·false·null 세 세계에서 시험).

## Codex가 main.mjs/경영 엔진에 연결할 것

- **입력(getter):** `getRailGeometry`(M5 `buildRailGeometry` 결과들), `getRailCapacityApplication`(`applyRailCapacityGeometry`가 만든 application), `getDisruptionSites`(M6 export의 `sites`), `getServiceControls`(M7 export의 `controls`), `getThroughRoutes`(`control.throughRouteId`의 직통 경로), `getExternalCatalog`(`buildExternalInfrastructureCatalog` 결과), `getExternalNetworks`, `getStationSites`.
- **출력(`onChange`/이벤트/`output()`):** `export.detours[]`의 각 항목이 경영 엔진 입력이다 — 계획은 `detourGeometryId`/`detourGeometryRevision`, 구간은 `legs[].trackSegmentId`·`legs[].infrastructureOwnerId`·`legs[].externalLineId`/`externalSpecificationId`, 접속은 `connections[].physicalConnection`/`gapMeters`/`handoverId`, 선택은 `picks`. 판정·계약·정산은 엔진의 몫이고 `null`은 미확인으로 다룬다.
- 저장: 이 마운트는 자기 localStorage 키만 쓴다. 게임 통합 저장에 넣으려면 `bridge.document`로 읽고 `bridge.loadDoc(...)`로 되돌리면 된다 (같은 검증).
- `index.html`/`main.mjs`/`style.css` 연결은 하지 않았다. 패널·오버레이·`<style>`은 마운트가 직접 만든다.

## 지도 데이터 한계

- 기존선은 역 단위뿐이라 선형이 없고 접속은 항상 `null`이다. UI는 선을 만들지 않는다.
- 플레이어가 그린 선은 역의 기록된 위치에 대해서만 재며, 접속의 근거가 아니다.
- 환승 연결은 직선 거리뿐이다 (보행망 없음). 출입구·승강장은 역 부지 자료가 있는 역에만 있다.
- 지도에 미리 보이는 후보 선은 M7 후보의 `alignment`가 있을 때만이다 (기존선이 낀 후보는 목록에만 나온다).
- 브라우저 확인: headless Chrome에서 실제 포인터 이벤트로 후보 선택 → 연결선 그리기(역에 붙음) → leg 선택 → 저장 → 재로딩 → 복원(ID·revision·그림·선택 동일)을 확인했다. 오래된 계획의 다시 확인과 거부된 저장본 처리는 단위 테스트로만 확인했다 (이후 Chrome 도구 서버가 응답하지 않아 중단).
