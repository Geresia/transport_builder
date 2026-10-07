# B15-E3 P2 — 보행 접근 모델 (`station-demand-walking-model.mjs`)

기준 커밋 `f46b96f`. 대상: B15-E3 P1(수요 배분)을 구현하는 작업자.
`engine/src/station-demand-walking-model.mjs`는 B15-M1 접근권 export의 `walkLinks`·`transfers`를 엔진이 쓸 수 있는 **"쓸 수 있는가 · 측정 길이 · 보행 분 · 확인할 것"** 으로만 바꾼다. 순수 함수이며 비용·수요·운임·혼잡·점수·승객·난수·시계·management를 읽거나 만들지 않는다. `main.mjs`, `scenario-runtime.mjs`, `management/**`, `map/**`, E1은 수정하지 않았다.

## 1. 호출

```js
import { buildStationDemandWalkingAccess } from "./station-demand-walking-model.mjs";

const walking = buildStationDemandWalkingAccess({
  stationDemandAccess,      // 필수. transitline.station-demand-access-export/1 (application.access 그대로)
  pack,                     // 필수. CityPack (id·version만 쓴다)
  policy,                   // 선택. 아래 2절. 없으면 전부 기본값
  expectedRevisions,        // 선택. { [stationAccessId]: stationAccessRevision } — 결정을 내린 시점의 revision
  knownTargetStationIds,    // 선택. 지금도 존재하는 계획·기존 역 ID 목록 (환승 대상 삭제 검사)
});
```

던지는 경우: export 스키마·`contractVersion`(명시했는데 1이 아님)·팩 id·팩 버전 불일치, `sites`가 배열이 아님, 정책 값이 잘못됨, `expectedRevisions`가 객체가 아님. 그 외의 문제(끊긴 링크, 낡은 revision…)는 던지지 않고 레코드의 `status`/`reasons`로 알린다.

### 입력 계약 — 읽는 필드

| 출처 | 읽는 필드 |
|---|---|
| export | `schema`, `contractVersion`(없어도 됨, 3절·10절), `packId`, `packVersion`, `sites[]` |
| site | `schema`, `contractVersion`, `stationAccessId`, `stationAccessRevision`, `sourcePackId`, `sourcePackVersion`, `location`, `connectedPlanId`, `connectedStationId` |
| `entrances[]` | `entranceId`, `location`, `insideBuildingCount`, `insideWaterCount` |
| `accessPoints[]` | `accessPointId`, `location`, `insideBuildingCount`, `insideWaterCount`, `drawnConnection.connected` |
| `demandZones[]` | `demandZoneId`, `centroid`, `drawnConnection.connected`, `demandNodeRefs[].{demandNodeId, location}` |
| `walkLinks[]` | `walkLinkId`, `from{kind,id}`, `to{kind,id}`, `alignment`, `lengthMeters`, `straightDistanceMeters`, `widthMeters`, `crossings.{river,railway,building}`, `unknownReasons["crossings.*"]` |
| `transfers[]` | `transferId`, `basis`, `targetStationId`, `targetKind`, `targetNetworkId`, `targetLocationBasis`, `from{kind,id}`, `alignment`, `straightDistanceMeters`, `passageLengthMeters`, `widthMeters`, `crossings.*` |

수요 값(거주자·종사자)은 어디서도 읽지 않는다.

## 2. 정책 (`policy`, 모두 선택)

| 필드 | 기본 | 의미 |
|---|---|---|
| `walkEstimate` | `"none"` | `"straight-line"`이면 **그린 연결이 전혀 없는** 대상에만 직선거리 × 1.3 추정을 허용한다. 막힌·미확인 그린 경로는 추정으로 덮지 않는다 |
| `acknowledgedWalkLinkIds` | `[]` | 플레이어가 "다리·통로가 있다"고 확인한 보행 링크 ID. 막힘(강·철도·건물)과 미확인 레이어를 풀어 준다. 길이 미상·끊김·물 위 끝점은 못 푼다 |
| `acknowledgedTransferIds` | `[]` | 위와 같은 확인, 환승 통로용 (보행 링크 확인은 환승에 적용되지 않는다) |
| `acceptUnmeasuredLayers` | `false` | `true`면 **측정 못 한 레이어**(null)만 받아들인다. 실제로 가로지른 것(> 0)은 절대 풀지 않는다 |

잘못된 값은 던진다. 같은 ID가 여러 번 있어도 정렬·중복 제거 후 `policy`에 되돌려 준다.

## 3. 규칙과 상태

**시간:** `max(1, round(meters / 80))`분, 정수. 0 m도 1분이다(0 m는 측정된 사실). 길이가 유한한 0 이상의 수가 아니면 시간은 `null`이다. 경로의 시간은 **총 길이**에서 계산하며 링크별 반올림 합이 아니다 (30 m + 30 m = 60 m → 1분, 링크별이면 2분).

**길이:** 그려진 선의 `lengthMeters`만 쓴다. 폭(`widthMeters`)은 시간에 영향이 없다.

**상태(`status`)** — 한 레코드에 하나. 우선순위 `stale > broken > blocked > unknown > …`:

| status | 뜻 | `usable` |
|---|---|---|
| `usable` | 그린 선이 있고 막힘·미확인이 없거나 확인됨 | true |
| `estimated` | 그린 선이 없고 정책이 직선 추정을 허용 (`estimated: true`, 플래그 `barriers-not-checked`) | true |
| `blocked` | 강·철도·건물을 **가로지름(> 0)** 또는 끝점이 물 위 | false |
| `unknown` | 길이 미측정, 또는 레이어가 없어 가로지름을 **알 수 없음**(null), 또는 환승 대상 위치가 시구 중심점 | false |
| `not-drawn` | 지도가 연결을 그리지 않았다 (`connected: false`). **걸을 수 없다는 뜻이 아니다** | false |
| `broken` | 끝점이 없거나 같음, 선 모양이 잘못됨, 환승 대상·출입구가 사라짐, 지도는 연결됐다는데 그 경로의 링크가 깨짐 | false |
| `stale` | `expectedRevisions`와 revision이 다름, 또는 site의 팩 id/버전이 export와 다름 | false |

`null` ≠ `false` ≠ `0`: 장벽 `count`는 `0`(깨끗), `> 0`(가로지름), `null`(측정 못 함)을 따로 보인다. 지도의 `drawnConnection.connected`는 `mapReportedConnection`에 `true/false/null`로 그대로 둔다 (필드가 없으면 `null`, `false`로 바꾸지 않는다).

`export`의 `contractVersion` 필드는 **없어도 받는다.** `buildStationDemandAccessExport`는 버전을 스키마 문자열(`…/1`)에만 넣고 `contractVersion` 필드는 붙이지 않는다. 다른 값을 명시하면 거부한다. (E1은 필드를 요구하므로 실제 지도 export와 맞지 않는다 — 10절.)

## 4. 출력 `transitline.station-demand-walking-access/1`

```
{ schema, contractVersion: 1, sourcePackId, sourcePackVersion,
  policy,            // 정규화된 정책
  model,             // { metersPerMinute: 80, minMinutes: 1, estimateDetourFactor: 1.3, rounding, barrierKinds }
  sites[], links[], paths[], nodes[], transfers[], warnings[] }
```

모든 배열은 ID 순으로 정렬되어 있고 입력 순서와 무관하게 바이트 동일하다. 레코드마다 `stationAccessId`를 달고 있어 평평하게 훑을 수 있다.

### `sites[]`
`stationAccessId`, `stationAccessRevision`, `status`(`current`/`stale`/`broken`), `reasons[]`, `connectedPlanId`, `connectedStationId`.

### `links[]` — 그린 보행 연결 1개당 1개
| 필드 | 의미 |
|---|---|
| `walkLinkId` | 지도의 ID 그대로 |
| `stationAccessId`, `from{kind,id}`, `to{kind,id}` | |
| `status`, `usable` | 3절 |
| `meters` | 측정 길이. 미측정이면 `null` (0으로 바꾸지 않음) |
| `walkMinutes` | `meters`에서 계산. **`usable`을 먼저 확인할 것** — 막힌 링크도 "확인되면 몇 분인지" 보여 주려고 채운다 |
| `straightMeters`, `widthMeters` | 참고값. 폭은 양수가 아니면 `null` + `width-invalid` |
| `barrier.{river,railway,building}` | `{ state: "clear"\|"crossed"\|"unmeasured", count: 수\|null, reason: 문자열\|null }` |
| `acknowledged`, `acknowledgeable` | 플레이어가 확인했는가 / 확인하면 풀리는가 |
| `reasons[]` | `crosses-river\|railway\|building`, `barrier-unmeasured:<종류>:<이유>`, `length-unmeasured`, `endpoint-in-water:<id>`, `endpoint-missing:from\|to`, `endpoints-identical`, `alignment-invalid`, `stale-map-revision`, `site-pack-mismatch`, `site-schema-invalid` |
| `flags[]` | `zero-length-drawn`, `width-invalid`, `endpoint-inside-building:<id>`, `acknowledged:<reason>`, `accepted:<reason>` |

### `paths[]` — 접근점·수요 구역 → 역
`pathId`, `stationAccessId`, `subject{kind: "access-point"\|"demand-zone", id}`, `status`, `usable`, `meters`, `walkMinutes`(usable일 때만, 아니면 `null`), `estimated`, `linkIds[]`(지나는 링크), `acknowledgeLinkIds[]`(확인하면 이 경로가 풀리는 링크), `mapReportedConnection`, `reasons[]`, `flags[]`.
경로는 **쓸 수 있는 링크만으로** 최단을 구하고, 없으면 미확인 링크를 허용한 최단 → 막힌 링크까지 허용한 최단 순으로 찾아 그 사유를 보고한다. 역과 출입구는 한 점으로 본다 (지도와 같음).

### `nodes[]` — **P1이 읽을 레코드**: 수요 노드 → 역
`nodeAccessId`, `stationAccessId`, `demandNodeId`, `via{kind:"demand-zone", id}`, `pathId`, `status`, `usable`, `meters`, `walkMinutes`, `estimated`, `components[]`, `acknowledgeLinkIds[]`, `reasons[]`, `flags[]`.
- `components[]`: `{kind:"drawn-path", meters, linkIds}` + `{kind:"zone-residual-straight", meters}`(그린 경로는 구역 중심에서 끝나므로 구역 중심→노드의 **직선 실측**, 우회계수 없음), 추정이면 `{kind:"straight-line-estimate", straightMeters, detourFactor, meters}`.
- `meters`는 구성요소의 합, `walkMinutes`는 그 합에서 한 번 계산한다.
- **한 노드가 같은 역의 두 구역에 들면 레코드가 둘이다** (`nodeAccessId`가 다름). 어느 쪽을 쓸지는 P1의 규칙이다. 이 모듈은 고르지 않는다.
- 노드 값(거주자·종사자)은 싣지 않는다. 지도가 `demandNodeRefs`를 주지 않은 구역(null)은 노드가 없고 `zone-demand-nodes-not-supplied` 경고가 난다.

### `transfers[]` — 환승 통로 (수요 노드 접근과 별개)
`transferId`, `stationAccessId`, `targetStationId`, `targetKind`, `targetNetworkId`, `basis`(`player-passage`/`nearby`), `from`, `status`, `usable`, `estimated`, `meters`(그린 통로 길이, `nearby`는 정책이 추정할 때만), `straightMeters`, `passageWalkMinutes`, `widthMeters`, `barrier`, `acknowledged`, `acknowledgeable`, **`usedForDemandAllocation: false`(항상)**, `reasons[]`, `flags[]`.
- `nearby`(500 m 안 이웃 역, 통로 안 그림)는 `not-drawn` + `no-passage-drawn`. 직선 추정은 정책이 허용할 때만 `estimated`.
- 대상이 시구 중심점이면 `unknown` + `target-location-coarse`.
- `passageWalkMinutes`는 **통로 걷는 시간만** 80 m/분으로 센 값이다. 층 변경·개찰 시간은 없고, `station-flow`의 환승 시간(75 m/분 + 층 0.75분 + 개찰 1분)과 다른 값이다. 접근 시간으로 쓰지 말 것.
- 환승을 넣고 빼도 `links`·`paths`·`nodes`는 바이트 동일하다 (테스트).

### `warnings[]`
`site-without-id`, `duplicate-station-access`, `walk-link-without-id`, `duplicate-walk-link-id`, `transfer-without-id`, `zone-demand-nodes-not-supplied`, `expected-station-missing`, `acknowledged-link-not-in-map`, `acknowledged-transfer-not-in-map`.

## 5. P1이 받아야 할 것 — 정확한 입력·출력 표

### P1이 이 모듈에 넘길 입력

| 인자 | 어디서 | 비고 |
|---|---|---|
| `stationDemandAccess` | `stationDemandAccessApplicationReport(state).access` | E1이 저장한 export 복사본. P1이 정책을 묶은 revision과 같은 것 |
| `pack` | `runtime.pack` | id·version 검사용 |
| `policy.walkEstimate` | P1 정책의 `defaults.walkEstimate` | `"none"`/`"straight-line"` |
| `policy.acknowledgedWalkLinkIds` | P1 정책의 `acknowledgedWalkLinkIds` | |
| `policy.acknowledgedTransferIds`, `policy.acceptUnmeasuredLayers` | 필요하면 | P1 정책에 필드가 없으면 생략 (기본 `[]`/`false`) |
| `expectedRevisions` | P1 규칙의 `boundTo` / 접근권 revision 맵 | 다르면 그 역은 `stale` |
| `knownTargetStationIds` | 지금 지도 export의 계획·기존 역 ID | 생략하면 환승 대상 삭제를 검사하지 않는다 |

### P1이 읽을 출력

| 용도 | 읽을 필드 | 쓰는 법 |
|---|---|---|
| 노드→역 접근 가능 여부 | `nodes[].usable` | `false`면 링크를 만들지 않는다. `estimated`면 만들 수 있으나 `estimated`/`flags`를 기록 |
| 도보 분 → `accessLinks.walkMinutes` | `nodes[].walkMinutes` | `usable`일 때만 정수. 엔진은 0 초과를 요구하고 이 값은 항상 ≥ 1 |
| 안정 ID | `nodes[].stationAccessId`, `nodes[].demandNodeId`, `nodes[].nodeAccessId` | 링크의 출처 표시·재계산 키 |
| 사유 → 확인 요청 UI | `nodes[].reasons[]`, `nodes[].acknowledgeLinkIds[]` | 확인하면 풀리는 링크 ID. 비어 있으면 확인으로 못 푼다 |
| 길이 근거 | `nodes[].meters`, `nodes[].components[]` | 가정 목록(`assumptions`)에 추정 여부와 잔여거리를 옮길 것 |
| 낡음 | `sites[].status`, `nodes[].status === "stale"` | 낡으면 배분 링크를 만들지 않는다 |
| 접근권이 아직 없는 대상 | `nodes[].status === "not-drawn"` | "접근 불가"가 아니라 "안 그림" (B15 설계 문서 T11) |
| 환승 | `transfers[]` | **배분에 쓰지 않는다** (`usedForDemandAllocation: false`) |

### P1이 지켜야 할 것
1. `usable !== true`인 레코드의 `walkMinutes`·`meters`로 링크를 만들지 않는다 (`walkMinutes`가 숫자여도 `blocked`일 수 있다).
2. `nodes[]`는 "노드가 이 역에 닿는 길이 있는가"만 말한다. **노드가 이 접근권에 속하는가(단독/공유/미상)는 E1/P1의 몫**이고 이 모듈은 판단하지 않는다 — 노드 레코드가 있다고 배분 대상인 것이 아니다.
3. 한 `(stationAccessId, demandNodeId)`에 레코드가 여럿일 수 있다. 하나를 고르는 규칙을 P1이 명시할 것.
4. `status: "unknown"`/`"blocked"` 노드를 확인으로 풀고 싶으면 `policy.acknowledgedWalkLinkIds`에 `acknowledgeLinkIds`의 ID를 넣고 다시 호출한다. 이 모듈은 상태를 저장하지 않는다.

## 6. 의도적으로 하지 않은 것
- 수요·인구·비용·운임·혼잡·점수·승객 생성, 걸음 외 교통수단, 역 안 이동(출입구→승강장), 환승 시간(층·개찰), 보행로 폭에 따른 용량.
- 지도 요소 복원이나 수정. 입력은 읽기만 한다 (동결 입력 테스트).
- 노드가 어느 접근권에 드는지의 판단과 겹침 처리 (E1/P1).
- 접근 링크를 `state`에 쓰는 일 (P3).

## 7. 설계 문서와 달라진 점 (의도)
`b15-e2-allocation-policy-design`는 시간을 0.1분 단위로 적었다. 이번 지시에 따라 **정수 분**(`max(1, round(m / 80))`)으로 한다. 80 m/분은 `plan-geometry`의 `ACCESS`와 같고 `station-flow`의 75 m/분은 역 안 이동용으로 따로 둔다 (통합하면 기존 결과가 바뀐다).

## 8. 테스트 (`engine/test/station-demand-walking-model.test.mjs`, 31개)
시간표·총길이 반올림, 잔여거리 구성, 폭 무관, 0 m/null/NaN/문자열/음수, 안 그림 ≠ 미상 ≠ 0, 추정 기본 없음·명시 허용·막힌 경로를 덮지 않음, 강·철도·건물, 레이어 결측 ≠ 깨끗함, 확인·수용 정책, 물 위 끝점, 우회로 선택, 끊긴 끝점·삭제된 대상, stale revision·팩 불일치·스키마, 사라진 역 경고, 환승 분리·불변성·`nearby`·시구 중심점·대상 삭제, 안정 ID·구역별 노드, 순서 무관 바이트 동일, 동결 입력 불변, 계약 거부, 금지 필드 검사(키 전수), 소스 import 검사(management·시계·난수·저장소 없음), 그리고 실제 `buildStationDemandAccessExport` 출력(건물·강이 있는 도면과 레이어 없는 도면)으로 끝에서 끝까지.

## 9. 한계
- 지도가 낸 `lengthMeters`(0.1 m 반올림)를 믿는다. 정렬선에서 다시 재지 않는다.
- 도로 횡단은 장벽이 아니다. 지하 매설물은 무시한다. 건물을 가로지르는 선(아케이드·통로)은 플레이어가 확인해야 쓸 수 있다.
- 직선 추정은 장벽을 검사하지 않는다 (`barriers-not-checked`).
- 구역 안 잔여거리는 구역 중심에서 노드까지의 직선이다. 구역이 크면 실제와 다를 수 있다 (구성요소로 분리해 보인다).
- `knownTargetStationIds`를 안 주면 삭제된 환승 대상을 알 수 없다.

## 10. 발견: E1과 실제 지도 export의 불일치 (이 브랜치에서 고치지 않음)
`buildStationDemandAccessExport`의 반환값에는 `contractVersion` 필드가 없다 (`schema: "…-export/1"`만 있다). E1 `requireAccessExport`는 `access.contractVersion !== 1`이면 던진다. **실제로 확인했다:** 이 브랜치에서 지도 빌더로 만든 export를 `assessStationDemandAccess`에 넣으면 `StationDemandAccessExport v1 is required`가 난다. `main.mjs`의 "역 접근권 적용" 버튼은 `stationDemandAccessUi.output().export`를 그대로 `runtime.applyStationDemandAccess`에 넘긴다. 기존 E1·통합 테스트는 `contractVersion: 1`을 손으로 붙인 export를 써서 이것을 잡지 못한다. 고치는 방법은 (a) 지도 export에 `contractVersion: 1`을 추가하거나 (b) E1이 필드 부재를 허용한다 (이 모듈이 취한 방식). 이 작업의 범위 밖이라 건드리지 않았다.
