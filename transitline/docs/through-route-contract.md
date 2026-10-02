# 직통 경로 출력 계약 (지도 → 경영 엔진)

지도가 직통운전 경로의 **순수 공간 사실**만 만들어 넘기는 계약이다. 직통 경로가 어느 구간들을 어떤 순서로 지나는지, 구간 사이 경계가 어디인지, 그린 선로가 그 경계에서 실제로 만나는지만 담는다. 비용·사용료·현금·공기·용량·시간표·점수와 **가능/조건부/불가능/미상 최종 판정**은 경영 엔진이 한다. 이 코드는 그 값을 만들지 않고 `management`를 import하지도 않는다(테스트가 검사). 결측·ID 규칙은 [depot-site-contract.md](depot-site-contract.md), [map-plan-contract.md](map-plan-contract.md)와 같은 방식이다.

경영 쪽 짝은 `transitline.through-service/1`(B12-1 E1)이며, 이 계약의 `throughRouteId`와 `legId`/`handoverId`로 연결한다. 기존 B11-3 선로사용 계약은 이 계약을 확장하지 않고 ID로만 이어진다.

## 코드 위치

| 파일 | 역할 |
|---|---|
| `engine/src/map/through-route.mjs` | 그린 경로 → `ThroughRouteGeometry`. 진입점 `buildThroughRouteExport()` / `buildThroughRoute()`, 저장 문서 `newThroughRouteDoc` / `serializeThroughRouteDoc` / `restoreThroughRouteDoc` |
| `engine/test/through-route.test.mjs` | 계약 테스트와 예제 검증 |
| `scripts/build-through-route-examples.mjs` | 예제 생성(`npm run through-route-examples`). 시계·난수·공간 레이어를 쓰지 않아 다시 만들면 바이트 단위로 같다 |
| `packs/<id>/through-route-examples/*.through-route.json` | 예제. 같은 팩의 `plan-examples`와 기존망을 가리킨다 |

## 입력 (호출하는 쪽이 지정한 것)

```js
{ key?, name?, legs: [{
    sourceKind: "planned" | "existing" | "external",
    sequence?, key?,
    planId?, projectId?,                    // planned / existing
    externalNetworkId?, externalLineId?,    // external
    fromStationId?, toStationId?,           // 생략하면 대상의 첫 역 → 마지막 역
    infrastructureOwnerId?                  // 호출하는 쪽이 게임 상태에서 아는 값만
}] }
```

| `sourceKind` | 뜻 | 형상의 출처 |
|---|---|---|
| `planned` | 플레이어가 그린 계획선(아직 사업 전) | 지도가 내보낸 `PlanGeometry`(`planId` 필수) |
| `existing` | 사업이 되어 지어진 자기 시설 | 같은 `PlanGeometry` + 호출자가 넘긴 불투명한 `projectId`(필수). 지도는 사업 상태를 모른다 |
| `external` | 읽기 전용 기존망의 노선 | 지도가 내보낸 `ExternalNetwork`의 `externalLineId` |

- 경로는 구간(leg)을 순서대로 이은 것이다. 모든 구간이 `sequence`(정수·중복 없음)를 갖거나 모두 갖지 않는다. 갖지 않으면 배열 순서가 경로 순서다. 섞으면 거절한다(`leg-sequence-mixed`).
- 구간은 `fromStationId`에서 `toStationId`까지 대상을 따라간다. `from`이 `to`보다 뒤면 거꾸로 달린다(역·구간·선형이 그 방향으로 나온다).
- 같은 계획선을 두 구간으로 쪼개 쓸 수 있다(역 범위가 달라야 한다).

## 출력 `ThroughRouteGeometry`

`schema: "transitline.through-route-geometry/1"`, `contractVersion: 1`. `buildThroughRouteExport()`는 `{ schema: "transitline.through-route-export/1", packId, packVersion, routes[], warnings[] }`를 낸다(`throughRouteId` 순 정렬).

### 경로

| 필드 | 설명 |
|---|---|
| `schema`, `contractVersion` | 계약 식별 |
| `throughRouteId` | 결정론적 ID(아래 ID 규칙) |
| `key` | 저장된 key. 없으면 `null` |
| `sourcePackId`, `sourcePackVersion` | 원본 팩 |
| `name` | 표시용. ID에 쓰이지 않는다 |
| `coordinateReference` | `EPSG:4326` |
| `legs[]` | 구간. **`sequence` 순으로 정렬**되어 있다 |
| `handovers[]` | 구간 사이 경계. `legs[i]` → `legs[i+1]`이 `handovers[i]` |
| `totalLengthMeters` | 구간 길이의 합(m). 하나라도 미상이면 `null` |
| `dataQuality` | `high\|medium\|low`. 미상 필드 수로 정하고, 원천 자료 품질이 더 나쁘면 그것을 따른다. 미상이 있으면 `high`가 아니다 |
| `unknown[]`, `unknownReasons` | 미상 경로 목록과 사유(아래) |
| `warnings[]` | 결과를 막지 않는 경고(`owner-input-conflicts-source`) |
| `sourceLayers[{layer,quality,name,license}]` | 이 사실들이 실제로 나온 원천만: `plan-geometry`, `existing-network`. 계획의 지형·건물·수역 레이어는 이 사실에 쓰이지 않으므로 싣지 않는다 |
| `license{pack,attribution}` | 팩 라이선스와 출처 표기 |

### 구간 `legs[]`

| 필드 | 설명 |
|---|---|
| `legId` | 결정론적 ID |
| `sequence` | 0부터 연속. 경로에서의 실제 순서 |
| `sourceKind` | `planned\|existing\|external` |
| `connectedPlanId` | 형상을 가져온 `planId`. `external`이면 `null`(해당 없음) |
| `connectedProjectId` | 호출자가 넘긴 사업 ID. 없으면 `null` |
| `externalNetworkId`, `externalLineId` | 기존망 ID. 계획선이면 `null`(해당 없음) |
| `infrastructureOwnerId` | 소유자. **원천 자료가 말하는 값만**. 모르면 `null` |
| `segmentIds[]` | 지나는 `PlanGeometry` 구간 ID(달리는 순서). 기존망은 구간 ID가 없어 `[]` |
| `stationIds[]` | 지나는 역 ID(달리는 순서) |
| `alignment` | 선형 `[[lon,lat]…]`(달리는 순서). 기존망은 `null` |
| `lengthMeters` | 그린 선형의 지표 길이(m). 기존망은 `null` |
| `unknown[]`, `unknownReasons` | 이 구간의 미상 필드와 사유 |

### 경계 `handovers[]`

| 필드 | 설명 |
|---|---|
| `handoverId` | 결정론적 ID |
| `sequence` | 0부터 연속 |
| `stationId`, `location` | 앞 구간의 끝과 뒤 구간의 시작이 **같은 역**이면 그 역 ID·좌표. 다르면 `null` |
| `fromLegId`, `toLegId` | 앞·뒤 구간 |
| `fromStationId`, `toStationId` | 앞 구간의 끝 역 / 뒤 구간의 시작 역(항상 채워짐) |
| `physicalConnection` | `true \| false \| null` |
| `gapMeters` | 두 끝점 사이 거리(m). 구할 수 없으면 `null` |
| `unknown[]`, `unknownReasons` | 미상 필드와 사유 |

## `physicalConnection`: 세 값을 섞지 않는다

**`null`은 미상이며 `false`가 아니다.** `null`이면 `unknownReasons.physicalConnection`에 사유가 반드시 있다.

| 값 | 조건 | 사유 |
|---|---|---|
| `true` | 두 구간이 계획선이고 끝점이 **같은 점**(같은 역 ID = 소수 6자리까지 같은 좌표) | — |
| `false` | 두 구간이 계획선이고 끝점이 `NEAR_ENDPOINT_METERS`(50 m)보다 멀다 | — (사실이므로 `unknown`에 넣지 않는다) |
| `null` | 끝점이 같은 점은 아니지만 50 m 안 | `endpoints-near-not-joined` |
| `null` | 한쪽이라도 기존망 구간 | `external-topology-not-in-source` |

- `true`는 **그린 선형의 끝점이 만난다**는 뜻이다. 분기기·선로 배선 가능 여부, 신호·전기 접속은 지도가 알 수 없고 판단하지 않는다.
- 기존망은 역이 수요점(구청 중심점)에 겹쳐 있어 실제 선로 위치·접속이 자료에 없다. 그래서 외부 구간이 낀 경계는 항상 `null`이다. 거리가 멀어도 `false`로 단정하지 않는다.
- 구간 중간의 분기점은 찾지 않는다. 경계는 구간의 끝과 시작에서만 본다.

## 결측 규칙

값을 구할 수 없으면 **0이나 `false`가 아니라 `null`**, 이름을 `unknown[]`에, 사유를 `unknownReasons`에 적는다. 해당 없음(계획선의 `externalNetworkId` 등)은 결측이 아니므로 `unknown`에 넣지 않는다. 경로 수준 `unknown[]`은 `leg:<legId>:<필드>`, `handover:<handoverId>:<필드>`, `totalLengthMeters` 형태의 경로다.

| 사유 | 뜻 |
|---|---|
| `owner-not-in-source-data` | 원천 자료에 소유자가 없다 |
| `external-network-has-no-segment-ids` | 기존망에는 구간 ID가 없다 |
| `external-location-basis:<basis>` | 기존망 위치가 `<basis>`(현재 `demand-node`)라 선형·길이를 알 수 없다 |
| `legs-end-at-different-stations` | 앞 구간 끝과 뒤 구간 시작이 다른 역이라 경계 역·좌표가 없다 |
| `endpoints-near-not-joined` | 끝점이 가깝지만 같은 점이 아니다 |
| `external-topology-not-in-source` | 기존망의 선로 연결이 자료에 없다 |
| `leg-length-unknown` | 구간 길이 중 미상이 있어 합계를 낼 수 없다 |

### 소유자를 추정하지 않는다

`infrastructureOwnerId`는 다음 값만 쓴다. 이름·운영사 태그·노선이 속한 망으로 추정하지 않는다.

1. 기존망 노선/망 자료가 말한 `infrastructureOwnerId`(원천 자료). 호출자 값과 다르면 원천 값을 쓰고 `owner-input-conflicts-source` 경고를 남긴다.
2. 원천 자료에 없으면 호출자가 게임 상태에서 아는 값(예: 사업이 된 자기 시설의 소유자).
3. 둘 다 없으면 `null` + `owner-not-in-source-data`.

기존망 파일의 `operator`는 운영사이지 소유자가 아니다. 현재 팩에는 소유자 필드가 없어 기존망 구간의 소유자는 항상 `null`이다. `externalNetworkId`도 원천 자료(`ExternalNetwork.id`)에 있는 값만 쓴다.

## ID 규칙

- `key`가 있으면 `throughRouteId`는 팩ID+`key`에서 나온다(`keyedThroughRouteId`). 구간을 고치거나 다른 계획선으로 바꾸거나 이름을 바꿔도 같고, 저장 후 다시 열어도 같다.
- `key`가 없으면 구간(대상 + 시작·끝 역)을 경로 순서로 이은 모양에서 나온다. **그린 방향이 반대여도 같은 ID**다(정방향·역방향 중 사전순으로 앞선 쪽을 쓴다). 배열 순서가 아니라 `sequence`(또는 배열 순서가 곧 경로 순서일 때의 그 순서)가 경로의 순서다.
- `legId`는 `throughRouteId` + 구간의 `key`(있으면) 또는 대상과 역 범위에서 나온다. 방향과 무관하다. 이름·배열 순서는 쓰이지 않는다.
- `handoverId`는 `throughRouteId`와 앞뒤 `legId`에서 나온다.
- 같은 `legId`가 두 번 나오면 경로를 거절한다(`duplicate-leg`). 같은 `throughRouteId`가 두 번 나오면 하나만 내고 `duplicate-through-route` 경고를 남긴다.

## 거절과 경고

경로를 만들 수 없으면 `route`는 `null`이고 사유를 돌려준다(`buildThroughRouteExport`는 `through-route-rejected`로 모은다). 구간 대상을 짐작해서 채우지 않는다.

`route-too-short`(구간 2개 미만), `leg-sequence-mixed`, `leg-sequence-invalid`, `duplicate-leg`, `leg-source-kind-invalid`, `leg-plan-missing`, `leg-plan-other-pack`(다른 팩에서 만든 계획), `leg-project-missing`(`existing`에 `projectId` 없음), `leg-external-line-missing`, `leg-station-missing`, `leg-degenerate`(시작=끝), `leg-segment-missing`.

## 저장 문서

`{ version: 1, packId, packVersion, routes[] }`. 경로는 `key`를 평생 유지한다. `restoreThroughRouteDoc()`은 다른 팩의 저장본을 적용하지 않고(`through-route-doc-other-pack`, 빈 문서 반환), 팩 버전이 다르면 경고(`pack-version-mismatch`)하며, 읽을 수 없거나 버전이 다르면 빈 문서(`through-route-doc-unreadable` / `through-route-doc-version`)를 돌려준다.

## 만들지 않는 것

`cost`, `fee`, `cash`, `score`, `verdict`, `possible`, `conditional`, `impossible` 등 경영 필드. 시간표·용량·궤간/전압/신호 호환·요금도 이 계약에 없다(경영 엔진 몫, B12-2 이후). 테스트가 출력의 모든 키 이름을 검사한다.

## 예제

| 팩 | 파일 | 내용 | 경계 `physicalConnection` |
|---|---|---|---|
| tokyo | `01-bay-spine-east-river-separated` | 계획선 두 개, 끝이 멀리 떨어짐 | `false` |
| tokyo | `02-east-river-koto-line-external` | 계획선 → 기존망(고토 노선) | `null` |
| tokyo | `03-east-river-koto-shinjuku-three-legs` | 계획 → 기존망 → 계획. 구간을 순서 없이 나열하고 `sequence`로 고정 | `null`, `null` |
| tokyo | `04-station-variants-split-joined` | 한 계획선을 두 구간으로 쪼개 공유 역에서 잇기 | `true` |
| example-radial | `01-spoke-to-ring-joined` | 스포크 → 링 호, 공유 역 | `true` |
| example-radial | `02-spoke-to-cross-city-joined` | 스포크 끝 → 크로스시티 시작(`sequence` 사용) | `true` |
| example-radial | `03-ring-arc-to-transfer-stub-separated` | 서로 만나지 않는 두 계획선 | `false` |
| example-corridor | `01-corridor-trunk-split` | 한 계획선을 두 구간으로 쪼갬 | `true` |

`physicalConnection`이 `endpoints-near-not-joined`(`null`)인 경우와 `existing`(`projectId` 있는 지어진 시설) 구간은 같은 팩 예제 계획선이 맞는 모양이 없고 사업 ID를 만들어 낼 수 없어, 단위 테스트의 합성 입력으로만 검증한다.

## 알려진 한계

- 기존망(도쿄 `existing-network.json`)은 역이 수요점에 겹쳐 있고 소유자 필드가 없다. 외부 구간의 선형·길이·소유자·선로 연결은 항상 `null`이다.
- `true`는 그린 선형의 끝점 일치이며 실제 분기·배선 설계가 있다는 뜻이 아니다.
- 구간 중간의 평면 교차·분기점은 찾지 않는다.
- `existing`은 사업 상태를 지도가 모르므로 호출자가 `projectId`와 소유자를 넘긴다.
- ID 해시는 `ids.mjs`의 64비트 FNV로, 전역 유일을 보장하지 않는다.
