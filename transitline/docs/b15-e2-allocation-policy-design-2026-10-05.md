# B15 접근권 수요 배분 정책 — 설계와 테스트 계획

작성일: 2026-10-05. **설계 문서이며 코드는 수정하지 않았다.** 대상: 배분 정책을 구현할 작업자.
기준: master `93bfdd4` (B15-E1 판정 `cde6f08`, 런타임 보관 `station-demand-access-integration.mjs` 포함).

> **이름 충돌.** 저장소에는 이미 `docs/b15-e2-station-demand-access-runtime-…`(접근권 export 보관, 완료)이 "E2"로 있고, 그 문서는 이번 배분 정책을 "B15-E3"이라 부른다. 반면 E1 문서는 배분 정책을 "E2"라 부른다. 이 문서는 요청대로 **"배분 정책"** 으로 부르고, 구현 브랜치 이름은 `b15-e3-…`로 쓰길 권한다. (결정 Q1)

---

## 1. 먼저 알아야 할 사실 (코드로 확인함)

**F1. 수요 엔진은 "역"이 아니라 "수요 노드"에서 승객을 만든다.**
`demand-engine.mjs`는 노드마다 `residents × 상수`로 발생률을 정하고, `access-demand.mjs`의 `resolveTrip`이 `state.accessLinks`(`demandNodeId → stationId, walkMinutes`)에서 **출발·도착 링크 쌍 중 총시간(열차 + 도보)이 가장 짧은 쌍**을 고른다.
→ 배분은 "역에 인구를 더하는 것"이 아니라 **"어느 노드가 어느 역으로 접근할 수 있는가(링크)"를 정하는 일**이다. 발생량은 배분과 무관하게 그대로여야 한다 (불변식 I1).
→ 한 노드에 링크가 둘이면 엔진은 이미 **최단시간 승자독식**으로 가른다. 이것은 암묵적인 배분 정책이므로 "명시적 정책 전에는 자동 분할 금지"를 지키려면 **링크 생성 자체를 정책이 통제**해야 한다.

**F2. E1 `totals`는 0과 미상을 구분하지 못한다.** 도쿄 예제 3개를 E1에 실제로 넣어 보았다.

| 예제 | E1 `catchmentStatus` | E1 `totals.exclusive` | 사실 |
|---|---|---|---|
| 01 신주쿠 | `empty` | `{0, 0}` | 출처가 `low`·`municipality-centroid`라 노드가 안 보일 뿐, 0명이라는 사실이 아니다 |
| 02 구 역 | `unknown` | `{0, 0}` | 노드 `ward-minato`는 `unknown`인데 합계는 0 |
| 03 그림 없음 | `not-drawn` | `{0, 0}` | 안 그렸을 뿐인데 0 |

원인: `sumKnown([])`이 빈 목록에서 `0`을 낸다. E2는 `totals`를 읽지 않고 노드별 `status`만 읽거나, E1을 먼저 고친다 (P0).

**F3. E1의 `shared`는 `catchmentOverlaps`(지도가 계산한 쌍)에만 의존한다.** 경계 허용오차 등으로 겹침 기록이 빠지면 같은 노드가 두 역에서 모두 `available`이 되어 **이중 계산**된다. 배분 단계는 "노드가 몇 개 역의 평가에 나오는가"를 직접 세어 막아야 한다 (불변식 I2).

**F4. E1 허용 해상도에 `mesh-250m/500m`, `block`, `parcel`이 있지만 수요 노드는 점 하나뿐이다.** 중심점이 접근권 안이라고 격자 전체가 안에 있는 것이 아니다. 작은 접근권에 격자 전체를 배분하게 된다.

**F5. 도보 상수가 둘, 자동 링크 경로가 둘 더 있다.**
- 거리→분: `plan-geometry.mjs ACCESS`(80 m/분, 우회 1.3, 최소 1분)와 `station-flow.mjs FLOW_ASSUMPTIONS.walkingMetersPerMinute`(75 m/분, 역 안 이동용).
- `plan-geometry.accessLinksFor`(반경 800 m, 최대 3개)가 `commissionProject`에서 `addStationAccessLink`로 들어간다. 이것은 **E1을 거치지 않고** 시구 중심점 노드를 작은 역에 이어 붙일 수 있다 (사용자 규칙 "시구 중심점은 배분 금지"와 충돌 가능, Q6).
- `state.addStationAccessLink`는 `demandNodeId|stationId` 키로 **덮어쓴다**. 배분 링크가 같은 키를 쓰면 기존 링크를 지우거나 지워진다.

**F6. 접근권 export의 역(`stationAccessId`)은 운행 역(`state.stations`)이 아니다.** 연결 정보는 `connectedPlanId/connectedStationId`(계획 역)와 `connectedNetworkId`(기존 역)뿐이다. 운행 역은 `commissionProject`가 `addPhysicalStation({ sourceStationId })`로 만든다. 링크를 만들려면 이 대응을 정확히 하나로 풀어야 한다.

**F7. 환승 통로(`transfers[]`)는 역↔역 보행이다.** 수요 노드의 접근과 무관하며 경로 탐색 그래프(`network.mjs`)는 이 값을 읽지 않는다 (환승 페널티는 `routing.mjs`가 따로 가진다). 걸음 시간 계산은 `station-flow.assessStationFlow`가 `distanceMeters/75 + 층 변경×0.75 + 개찰 1`로 한다.

---

## 2. 정책 한 줄 요약

> **링크는 "정책 또는 플레이어 선택으로 확정된 것"만 만든다.** 그 밖의 노드는 지금처럼 동작한다(변화 0). 발생량은 어떤 경우에도 늘거나 줄지 않는다. 미상은 어떤 정책으로도 풀리지 않는다.

### 불변식 (모든 구현과 테스트가 지킬 것)

| ID | 불변식 |
|---|---|
| I1 | 배분은 노드의 발생률·목적지 선택을 바꾸지 않는다. 같은 시드에서 `spawned`가 같다 |
| I2 | 한 노드의 배분 비율 합 ≤ 1. 합이 1 미만인 나머지는 `unallocated`로 남는다. 합이 1을 넘거나 2개 이상의 역에 전부를 주는 일은 없다 |
| I3 | `unknown` 노드는 값도 링크도 없다. 정책·확인 체크로 풀 수 없다 (자료가 좋아져 E1이 `available`로 바꿔야만 풀린다) |
| I4 | 정책이 명시하지 않은 겹침은 `unallocated`다. 자동 균등분할·자동 최근접·자동 중복 없음 |
| I5 | 정책이 없거나 비어 있으면 엔진 동작은 현재와 **바이트 단위로 같다** |
| I6 | 입력(접근권 export, E1 평가, 정책, 팩)은 변경하지 않는다. 같은 입력은 같은 출력이다 (순서 무관) |
| I7 | `null`(미상)과 `0`(사실)을 섞지 않는다. 안 그린 접근권·출처가 못 보는 접근권은 `null`이다 |

---

## 3. 접근권 상태와 수요 상태의 의미

### 3.1 접근권(역 단위) — `coverage`

| 값 | 조건 | 의미 | 합계 | 엔진 동작 |
|---|---|---|---|---|
| `not-drawn` | 접근권 다각형 0개 | 플레이어가 아직 안 그림. **접근 불가가 아님** | `null` | 변화 없음 (기존 레거시·반경 링크가 그대로) |
| `empty-confirmed` | 다각형 ≥1, 출처 통과(국소·품질 high/medium), 안에 노드 0개 | "이 구역에는 수요 노드가 없다"는 사실 | `{0,0}` | 배분 링크 없음 |
| `empty-unseen` | 다각형 ≥1, 안에 노드 0개, **출처가 거침/저품질/없음** | 노드가 안 보이는 것이지 수요가 없다는 뜻이 아님 | `null` | 변화 없음 |
| `unknown` | 노드가 있으나 하나라도 `unknown` | 일부만 판정 가능 | 알려진 합 + `complete:false` | 알려진 노드만 정책 대상 |
| `shared` / `available` | 위 외 | E1 정의 그대로 | 값 + `complete` | 정책에 따름 |

E1은 `empty-unseen`을 `empty`로 낸다. **P0에서 분리**한다. 퇴화(점 3개 미만·면적 0) 다각형은 M1이 이미 버린다. `catchment-excludes-station`은 사실 표식이며 배분을 막지 않는다. 같은 역의 역 범위와 출입구 범위 다각형이 한 노드를 함께 덮어도 **한 역이므로 공유가 아니다** (E1이 이미 노드 단위로 중복 제거).

### 3.2 수요 노드 — 상태 3종

| 상태 | 정의 | 기본 처리 |
|---|---|---|
| `unknown` | E1 `unknown`이거나 E2 추가 가드에 걸림 (아래 3.3) | 값 `null`, 링크 없음 (I3) |
| `exclusive` | 어느 접근권에 들었는지가 **정확히 한 역**뿐 (재계산한 소유자 수 = 1) | 정책 `exclusive: "assign"`이면 100% 그 역 (도보가 정해질 때) |
| `shared` | 소유자가 2개 이상 (E1 겹침 기록 **또는** 교차 집계) | 기본 `hold` → `unallocated`, 값은 `sharedCandidate`로만 보고 |

### 3.3 E2가 E1 위에 얹는 가드 (노드를 `unknown`으로 되돌린다)

1. **교차 소유자 집계**: 어떤 노드가 서로 다른 두 `stationAccessId`의 `demandNodeInputs`에 나오면 겹침 기록과 상관없이 `shared`다 (F3, 불변식 I2).
2. **면적형 해상도**(`parcel`, `block`, `mesh-*`): 노드에 면적이 없으므로 기본은 `unknown / area-footprint-unavailable`. 정책 `areaNodeInclusion: "centroid"`를 **명시**하면 중심점 규칙으로 허용하고 `assumptions`에 남긴다 (F4, Q4). 점형(`individual-demand-node`, `point`, `node`, `building`)은 그대로 허용한다.
3. **값 검사**: `residents`, `jobs`가 유한한 0 이상 수가 아니면 노드 전체 `unknown` (E1 규칙 그대로, 한쪽만 쓰지 않는다). `0/0`은 유효한 사실이다.
4. 출처 검사는 **E1이 한 번만** 한다. E2는 다시 판정하지 않고 E1의 `status`만 읽는다 (E1은 `unknown` 노드의 값을 `null`로 내므로 E2가 값을 새게 할 수 없다).

---

## 4. 배분 정책 문서 `transitline.station-demand-allocation-policy/1`

플레이어 또는 시나리오가 쓴다. 엔진 상태에 저장하고, 접근권 export의 **revision에 묶인다**.

```jsonc
{
  "schema": "transitline.station-demand-allocation-policy/1",
  "contractVersion": 1,
  "policyId": "policy:1",
  "defaults": {
    "exclusive": "assign",            // "assign" | "hold"        (기본 assign)
    "shared": "hold",                 // 현재는 "hold"만. 예외는 rules로만
    "walkEstimate": "none",           // "none" | "straight-line"  (기본 none, 5절)
    "areaNodeInclusion": "reject"     // "reject" | "centroid"     (기본 reject)
  },
  "acknowledgedWalkLinkIds": [],      // 장벽(강·철도·건물)을 지나는 그린 보행 연결 중 플레이어가 "다리/통로가 있다"고 확인한 것
  "rules": [
    {
      "ruleId": "rule:1",
      "scope": { "demandNodeIds": ["n1"] },                    // 또는 { "stationAccessIds": ["A","B"] }  (겹침을 이루는 정확한 집합)
      "boundTo": { "A": "<stationAccessRevision>", "B": "<…>" }, // 규칙을 쓸 때의 접근권 revision
      "mode": "assign-all",           // "assign-all" | "fixed-shares" | "route-choice" | "nearest-by-walk"
      "stationAccessId": "A",         // assign-all
      "shares": { "A": 0.6, "B": 0.4 }// fixed-shares (합 ≤ 1, 각 0 < s ≤ 1, 나머지는 unallocated)
    }
  ]
}
```

### 규칙 `mode` 의미

| mode | 하는 일 | 비고 |
|---|---|---|
| `assign-all` | 한 역에 100% | 그 역은 소유자여야 한다 |
| `fixed-shares` | 플레이어가 준 비율 | 합 < 1이면 나머지 `unallocated`. 합 > 1·음수·NaN·비소유자 역은 **정책 전체 거부** |
| `route-choice` | 소유자 전부에 링크를 만들고 **비율은 정하지 않음**. 엔진의 기존 최단시간 선택에 맡김 | `share: null`, 역별 합계는 `routeChoice` 풀로만 보고. 모든 소유자의 도보가 알려져 있어야 링크가 생긴다 |
| `nearest-by-walk` | 도보 분이 **모두 알려진** 소유자 중 최단 하나에 100% | 하나라도 미상이면 `unallocated`. **동률도 `unallocated`** (임의 순서로 풀지 않는다) |

### 규칙 우선순위
노드 지정 규칙 > 겹침 집합 규칙 > 기본값(`shared: hold`). **같은 구체성의 규칙이 둘 이상 같은 노드에 걸리면 정책 거부** (조용한 "나중 것이 이김" 금지). 3개 역이 겹치는 노드는 **정확히 그 3개 집합**을 가리키는 규칙이 있어야 하며, 쌍 규칙은 걸리지 않는다.

### 낡은 규칙
`boundTo`의 revision이 현재 접근권 revision과 다르면 그 규칙은 **`stale`로 무시**하고 해당 노드는 `unallocated`(`rule-stale`)로 돌아간다. 새 revision에 조용히 다시 묶지 않는다. 사용자는 규칙을 다시 확인해 저장해야 한다 (M7/M10 `selection-outdated`와 같은 방식).

### 노드를 푸는 정책은 없다
`unknown` 노드를 겨냥한 규칙은 **경고**(`policy-cannot-unlock-unknown`)와 함께 무시한다 (불변식 I3). 정책 거부가 아니라 무시인 이유: 데이터가 바뀌어 노드가 일시적으로 `unknown`이 되었을 때 정책 전체를 못 쓰게 만들지 않기 위해서다.

---

## 5. 도보 길이 → 시간 (`walkMinutes`)

엔진이 `accessLinks`에 요구하는 값은 **0 초과 분**이다 (`addStationAccessLink`). 지도는 길이(m)만 주고 시간은 엔진이 계산한다.

```
walkMinutes = max(1, round1( meters / ACCESS_WALK_METERS_PER_MINUTE ))   // round1 = 0.1분 단위
ACCESS_WALK_METERS_PER_MINUTE = 80      // plan-geometry ACCESS와 같은 값: 기존 접근 링크와 일관
```

- 역 **안** 이동(출입구→승강장, 환승 통로)은 `station-flow`의 75 m/분을 그대로 쓰고 여기에 합치지 않는다. 두 상수는 **통합하지 않는다**(바꾸면 기존 결과가 바뀐다). 별도 이름의 엔진 상수로 둔다.
- 길이가 유한한 0 이상 수가 아니면 도보 미상이다. `0` m도 1분으로 올린다 (엔진이 0분을 거부).

### 길이의 출처 (우선순위, 가장 좋은 근거부터)

1. **`drawn-path`**: 노드가 든 수요 구역의 `drawnConnection.connected === true`이면 `lengthMeters`(그려진 선 길이의 합) + 구역 중심→노드 직선거리(측정값, 우회계수 없음)를 **구성요소로 나눠** 기록한다. (구역 끝점은 구역 중심이다 — `station-demand-access.mjs:209`)
2. **`straight-line-estimate`**: 정책 `walkEstimate: "straight-line"`을 **명시했을 때만**. `노드→가장 가까운 출입구(없으면 역 위치) 직선거리 × 1.3`. 결과에 `estimated: true`.
3. 그 밖: `walk-length-unknown` → 링크 없음, 노드는 `unallocated`.

`drawnConnection: { connected: false }`는 **"플레이어가 선을 안 그렸다"**일 뿐 걸을 수 없다는 뜻이 아니다(M1 계약). 따라서 `unreachable`이라 쓰지 않고 2번 정책이 없으면 길이 미상으로 둔다. 기본이 `none`인 이유다 (Q3).

### 장벽
그린 보행 연결의 `crossings.river|railway|building`이 **> 0**이면 링크를 만들지 않는다(`walk-crosses-barrier`). `acknowledgedWalkLinkIds`에 그 `walkLinkId`가 있으면 허용하고 `assumptions`에 남긴다. 값이 `null`(레이어 없음)이면 막지 않되 `barrier-unknown` 표식을 단다. 도로 횡단은 장벽이 아니다. **보행로 폭은 시간에 영향이 없다**(폭은 입구 용량이며 후속 단계 몫).

### 환승 통로
`transfers[]`는 **수요 노드 접근이 아니다.** 환승 통로는 링크·배분·역별 인구에 어떤 영향도 주지 않는다 (불변식 + 테스트 T30). 환승 시간은 `station-flow`가 계산하며 경로 탐색 그래프에 넣는 일은 이 설계의 범위 밖이다. 기존 역 환승 대상의 위치가 시구 중심점일 때(`external-station-locations-coarse`)는 계속 `low`로 취급한다.

---

## 6. 입력·출력 계약

### 6.1 순수 함수 (P1)

```js
allocateStationDemand({ application, policy, state = null })  ->  StationDemandAllocation
```

- `application`: `stationDemandAccessApplicationReport(state)` — `{ access, assessment, applicationId, … }` (이미 존재).
- `policy`: 4절 문서 또는 `null`(정책 없음 = 기본값).
- `state`: 읽기 전용. 운행 역 대응(F6)에만 쓴다. `null`이면 모든 링크가 `station-not-operational`(계획 단계 미리보기).
- 부수효과 없음, 입력 불변, 같은 입력 → 같은 출력(노드·역 순서 무관).

### 6.2 출력 `transitline.station-demand-allocation/1`

```jsonc
{
  "schema": "transitline.station-demand-allocation/1", "contractVersion": 1,
  "allocationId": "…stableId(pack, policyRevision, 접근권 revision들)",
  "policyId": "policy:1", "policyRevision": "…",
  "accessApplicationId": "…", "sourcePackId": "…", "sourcePackVersion": "…",
  "status": "current",                                    // "stale": 접근권 revision이 바뀐 뒤 (6.4)
  "nodes": [{
    "demandNodeId": "n1",
    "claimants": ["A"],                                   // 정렬된 stationAccessId (교차 집계 결과)
    "state": "exclusive",                                 // "exclusive" | "shared" | "unknown"
    "reasons": [],                                        // unknown·unallocated 사유 코드
    "residents": 120, "jobs": 80,                         // unknown이면 null
    "decision": "assigned",                               // "assigned" | "shares" | "route-choice" | "held" | "unknown"
    "ruleId": null,
    "assignments": [{
      "stationAccessId": "A", "share": 1,                 // route-choice만 null
      "operationalStationId": "station:7",                // 대응 못 풀면 null
      "walk": { "minutes": 6.3, "meters": 480, "basis": "drawn-path", "estimated": false,
                "components": [{ "kind": "drawn-link", "meters": 430 }, { "kind": "zone-residual-straight", "meters": 50 }],
                "flags": [] },                            // walk가 미상이면 null
      "linkable": true, "linkBlockedBy": []
    }],
    "unallocatedShare": 0                                 // 1 - Σshare (route-choice는 0)
  }],
  "stations": [{
    "stationAccessId": "A", "coverage": "available",
    "allocated": { "residents": 120, "jobs": 80 },        // null 조건은 3.1
    "sharedUnallocated": { "residents": 0, "jobs": 0 },
    "routeChoice": { "nodeCount": 0, "residents": 0, "jobs": 0 },
    "unknownNodeCount": 0, "complete": true,
    "reasons": []
  }],
  "links": [                                              // P3가 상태에 옮길 것. 이것만이 엔진에 닿는다
    { "demandNodeId": "n1", "stationId": "station:7", "stationAccessId": "A", "walkMinutes": 6.3, "share": 1, "basis": "station-demand-allocation" }
  ],
  "assumptions": [], "warnings": []
}
```

출력 금지 키: 운임·비용·혼잡·확률·승객 수. (`walkMinutes`는 엔진 계산값이므로 허용. 값은 노드의 거주·종사자 수뿐이고 "승객 수"가 아니다.)

### 6.3 운행 역 대응 (F6)
`site.connectedStationId`(계획 역) → `state.stations`에서 `sourceStationId === connectedStationId`이고 프로젝트가 같은 역 **정확히 하나**. 0개 또는 2개 이상이면 `operationalStationId: null`, `linkBlockedBy: ["station-not-operational"|"station-ambiguous"]`로 두고 링크를 만들지 않는다 (`railway-service-control`의 `operationalStationId`와 같은 방식). 기존 역(`connectedNetworkId`)은 노드 = 레거시 역 ID로 대응된다. `stationKind: "free"`는 대응 없음.

### 6.4 런타임 명령 (P3, `ScenarioRuntime`)

| 메서드 | 상태 변경 | 역할 |
|---|---|---|
| `assessStationDemandAllocation(policy)` | **없음** | 미리보기(드라이런). 결과 6.2를 돌려줌 |
| `applyStationDemandAllocation(policy)` | 있음 (`game.transact` + 체크포인트 롤백) | 정책 검증 → 정책·링크 저장 → `accessVersion` 증가 |
| `clearStationDemandAllocation()` | 있음 | 정책과 링크 제거, 레거시 동작 복귀 |
| `stationDemandAllocationReport()` | 없음 | 저장된 정책 + 현재/낡음 상태 + 6.2 (복사본) |

기존 `applyStationDemandAccess(export)`는 **배분을 건드리지 않는다.** export가 바뀌면 배분은 `stale`로 보고되고, 다시 적용하거나 지우는 것은 플레이어의 명시적 명령이다 (Q7).

### 6.5 상태 저장 (P3)
- `state.stationDemandAllocation = { policy, allocation, appliedAtSimMinute }` — 정책과 마지막 계산 결과.
- **배분 링크는 `state.accessLinks`에 섞지 않고** `state.stationDemandAllocationLinks`에 따로 둔다 (F5의 키 덮어쓰기 방지, 지우기 단순). `access-demand.mjs availableAccessByDemandNode`가 두 컬렉션을 합친다.
- 합칠 때 규칙(Q5): 한 노드에 배분 링크가 있으면 **그 노드의 레거시 0분 자기 역 어댑터와 기존 `accessLinks`는 쓰지 않는다**(플레이어가 확정한 접근이 우선). 배분 링크가 없는 노드는 현재와 같다.
- 통합 저장(`integrated-save.mjs`)은 일반 JSON 필드를 그대로 보존한다. 이전 저장본에는 필드가 없어 `null`로 복원한다 (E2 런타임 보관과 같은 방식).
- `management/integration.mjs`의 `operationalCheckpoint`가 `accessLinks/accessVersion`을 복원하므로, 개통(commission) 후 배분 링크를 다시 풀 때는 이 체크포인트에 새 필드도 넣어야 한다.

---

## 7. 영향 파일

| 파일 | 변경 | 단계 |
|---|---|---|
| `engine/src/station-demand-access-assessment.mjs` | **수정(추가형)**: `totals` 0↔`null` 수정, `empty`→`empty-confirmed/empty-unseen` 분리, 노드별 `claimedByStationAccessIds`(교차 집계) | P0 |
| `engine/test/station-demand-access-assessment.test.mjs` | 기대값 갱신 + 새 케이스 | P0 |
| `engine/src/station-demand-allocation.mjs` | **신규**: `allocateStationDemand`, 정책 검증, 상수 | P1 |
| `engine/src/station-access-walk.mjs` | **신규** (또는 위 파일 안): 길이→시간, 출처 우선순위, 장벽 | P2 |
| `engine/src/station-demand-allocation-integration.mjs` | **신규**: 정책·링크 저장, 대응(F6), 낡음 판정 (기존 `station-demand-access-integration.mjs`와 같은 형태) | P3 |
| `engine/src/scenario-runtime.mjs` | 4개 메서드 + `report()` 필드 (기존 `applyStationDemandAccess` 옆) | P3 |
| `engine/src/access-demand.mjs` | 배분 링크 합치기 + 레거시 억제 (Q5), 캐시 버전 | P3 |
| `engine/src/management/integration.mjs` | 체크포인트에 새 필드 (개통 후 재해결을 넣을 때) | P3 |
| `engine/src/integrated-save.mjs` | 변경 없음 예상 (일반 필드). **복원 테스트만 추가** | P3 |
| `engine/src/state.mjs` | 변경 없음 (`addStationAccessLink` 그대로, 배분 링크는 별도 컬렉션) | — |
| `engine/src/demand-engine.mjs`, `passengers.mjs`, `routing.mjs` | **변경 금지.** 발생량 불변식 I1의 근거 | — |
| `engine/src/map/**` | 변경 없음 (지도는 값을 계산하지 않는 계약 유지) | — |
| UI (플레이어가 규칙을 고르는 패널) | 이 설계 밖. 6.2/6.4만 소비하면 된다 | P5 |
| `docs/…` | 구현 후 인계 문서 | 각 단계 |

**건드리지 않을 것**: `main.mjs`, `index.html`, `style.css` (연결은 별도 작업).

---

## 8. 필수 회귀 테스트

표기: **[E1]** E1 쪽 수정이 필요한 것, **[ENG]** 엔진 통합 필요. 모든 테스트는 입력을 `deepFreeze`해서 돌린다(I6).

### A. 미상 유지 — 시구 중심점·저품질 (최우선)
- T1 도쿄 실제 예제 01~03을 정책 `exclusive: assign, walkEstimate: straight-line`(가장 관대한 정책)으로 돌려도 **배정 0, 링크 0, 노드 값 `null`, 역 합계 `null`**. 사유는 `demand-source-quality-insufficient`/`…-coarse`.
- T2 `municipality|ward|city|prefecture|district|centroid` 해상도(대소문자·`municipality-centroid` 같은 합성어 포함)는 `quality: high`여도 배정 0.
- T3 `quality: low|null|누락`은 국소 해상도여도 배정 0.
- T4 `unknown` 노드를 겨냥한 `assign-all`/`fixed-shares`/`route-choice` 규칙은 **무시 + 경고**, 링크 0 (I3). 규칙이 `acknowledged…`를 갖든 말든 동일.
- T5 값 부분 누락(거주만 있음)·음수·NaN·문자열 → 노드 전체 `unknown`. `0/0`은 유효, 배정 가능하고 합계 `0`(≠`null`).
- T6 팩에 없는 노드 ID, 팩에 같은 ID가 둘 → 결정적으로 `unknown`(`demand-node-missing-from-pack`) 또는 첫 번째 사용 (E1 규칙 고정).
- T7 면적형 해상도(`parcel|block|mesh-250m|mesh-500m`)는 기본 `area-footprint-unavailable`. `areaNodeInclusion: centroid`를 줄 때만 배정되고 `assumptions`에 기록.
- T8 같은 역에 국소 출처와 거친 출처가 섞이면 그 역 전체 `unknown`.

### B. 단독(exclusive)
- T9 단독 노드 + 알려진 도보 → 비율 1, 링크 1개, 분 계산 정확.
- T10 같은 역의 역 범위·출입구 범위 두 접근권이 한 노드를 덮음 → **공유 아님**, 배정 1회.
- T11 단독이지만 도보 미상(그린 연결 없음) + `walkEstimate: none` → `unallocated`, 사유 `walk-length-unknown`, 링크 0, `drawnConnection:false`를 "접근 불가"로 표기하지 않음.
- T12 `exclusive: hold` → 아무것도 배정 안 됨.

### C. 겹침(shared) — 자동 중복·자동 분할 금지
- T13 정책 없음/기본: 겹친 노드는 `unallocated`, `sharedUnallocated`에만 값 표시, 링크 0.
- T14 **성질 시험**: 시드 고정 난수로 만든 정책·접근권 조합 수백 개에서 항상 노드별 Σshare ≤ 1, 역별 `allocated` 합 ≤ 노드 알려진 수요 합 (I2). 균등분할(0.5/0.5)이 규칙 없이 생기는 경우 0.
- T15 `fixed-shares` 합 < 1이면 나머지가 `unallocated`. 합 > 1, 음수, NaN, 0, 비소유자 역, 빈 `shares` → **정책 거부**(상태 불변).
- T16 `assign-all`이 비소유자 역을 가리키면 정책 거부.
- T17 `route-choice`: 소유자 전부에 링크, `share: null`, 역별 `allocated`에는 **더하지 않고** `routeChoice` 풀로만 보고. 소유자 중 하나라도 도보 미상이면 링크 없이 `unallocated`.
- T18 `nearest-by-walk`: 모두 알려지면 최단 하나, **동률 → `unallocated`**, 하나라도 미상 → `unallocated`.
- T19 우선순위: 노드 규칙 > 겹침 집합 규칙 > 기본. 같은 구체성 충돌 → 정책 거부.
- T20 3개 역이 겹치는 노드는 정확히 그 3개 집합 규칙만 적용, 쌍 규칙은 미적용.
- T21 **[E1]** 교차 소유자: 겹침 기록 없이 두 역 평가에 모두 나오는 노드는 `shared`로 취급 → 이중 배정 0 (F3 회귀).
- T22 겹침 기록은 있으나 노드는 한 접근권에만 든 경우 → 단독(E1 현행 유지).
- T23 낡은 규칙: 접근권 revision이 바뀌면 규칙 무시, `rule-stale`, 노드는 `unallocated`. 새 revision에 자동 재결합 없음.
- T24 역 비활성화(`inactive[]`)로 소유자가 줄면 노드 상태가 `shared→exclusive`로 바뀌는지 **미리보기에서만** 보이고, 저장된 배분은 명시적 재적용 전까지 그대로(`stale`).

### D. 도보 길이→시간
- T25 공식 표: 0 m→1.0분, 80 m→1.0, 400 m→5.0, 1000 m→12.5, 1234 m→15.4(0.1 반올림). `Infinity`/음수/NaN/문자열 → 미상.
- T26 그린 경로가 있으면 `straight-line-estimate`가 있어도 **그린 경로 우선**, 정책이 없으면 추정 안 함, 추정은 `estimated:true` + 우회 1.3.
- T27 구성요소 분리: `drawn-link` + `zone-residual-straight`가 합쳐 `meters`가 되고 각각 기록.
- T28 장벽: 강·철도·건물 횡단 > 0이면 링크 없음(`walk-crosses-barrier`), `acknowledgedWalkLinkIds`에 있으면 허용 + 가정 기록, `null`이면 막지 않고 `barrier-unknown`.
- T29 보행로 `widthMeters`를 바꿔도 분·배정·링크 불변.
- T30 **환승 통로 불변성**: `transfers[]`를 넣고 빼도 배정·링크·역별 인구가 **완전히 같다**. 환승 통로가 링크를 만드는 코드 경로 없음.
- T31 단일 상수 점검: 접근 도보는 80, `station-flow`는 75 — 서로 영향 없음(두 상수의 값이 각자 고정됨).

### E. 접근권 상태 의미
- T32 `not-drawn`: 역 합계 `null`(0 아님), 링크 0, 엔진 변화 0.
- T33 **[E1]** `empty-confirmed`(국소 출처 + 노드 0)는 `{0,0}`, `empty-unseen`(거친 출처 + 노드 0)은 `null`. 도쿄 01이 후자.
- T34 **[E1]** 모든 노드가 `unknown`인 역의 `totals.*`는 `null`이지 `0`이 아님 (F2 회귀: 도쿄 02).
- T35 `catchment-excludes-station` 표식이 있어도 배분은 진행되고 경고만 남음. 퇴화 다각형은 무시.

### F. 엔진 통합 [ENG]
- T36 **정책 없음 → 현재와 동일**: 기존 전체 스위트 통과 + 고정 시드에서 `spawned`, `stats`, 승객 목록이 적용 전/후(정책 `null`) 바이트 동일 (I5).
- T37 **발생량 보존**: 배분 적용 전후 `model.rate(node)`와 시드 고정 `spawned`가 같다 (I1). 배분은 목적지 선택·발생률을 안 바꾼다.
- T38 `resolveTrip`은 배분 링크를 쓴다. 배분 링크가 있는 노드는 레거시 자기 역 어댑터를 쓰지 않고, 없는 노드는 이전과 같다 (Q5).
- T39 배분 링크와 `plan-geometry` 링크가 같은 `demandNodeId|stationId`여도 서로 덮어쓰지 않는다 (별도 컬렉션).
- T40 저장·복원: 정책·배분·링크가 JSON 왕복 후 동일, 이전 저장본(필드 없음)은 `null`로 복원, 복원 후 `accessVersion` 캐시가 새로 만든다.
- T41 드라이런 `assessStationDemandAllocation`은 상태·원장·시계를 바꾸지 않는다(`deepEqual` 스냅샷). 잘못된 정책의 `apply`는 전부 롤백된다.
- T42 접근권 export를 바꿔 다시 `applyStationDemandAccess`하면 기존 배분은 `stale`로 보고되고 링크는 **그대로**(조용한 변경 없음). 명시적 재적용이 새 링크로 바꾼다.
- T43 운행 역 대응(F6): 0개/2개 이상이면 링크 없음 + 사유. 이후 `commissionProject`로 역이 생기고 재적용하면 링크가 생긴다. 개통 실패 롤백이 배분 필드도 되돌린다.
- T44 결정성: 노드·역·규칙·정책 키 순서를 섞어도 출력이 바이트 동일. 같은 입력의 `allocationId`가 같다.
- T45 입력 `deepFreeze`(접근권 export, 평가, 정책, 팩)를 변경하지 않는다.
- T46 팩 변형 끝에서 끝으로: `example-radial`(gravity)은 정상 배분, `example-corridor`(matrix: 노드에 거주·종사자 없음)는 전부 `demand-node-values-missing`으로 `unknown`이며 matrix 발생 모델은 손대지 않는다.
- T47 출력 전체를 이름 정규식으로 훑어 운임·비용·혼잡·확률·승객 키가 없음을 확인한다.

---

## 9. 단계적 구현안

| 단계 | 내용 | 끝났다는 증거 | 위험 |
|---|---|---|---|
| **P0** E1 보강 | 합계 0↔`null`, `empty` 분리, 교차 소유자 필드(추가형) | T21·T33·T34 + 기존 E1 테스트 갱신 통과 | 바뀌는 기대값은 `station-demand-access-assessment.test.mjs:58`(값 누락 노드의 `totals.exclusive`가 `{0,0}` → `null`)과 `:37`(`"empty"` → `"empty-confirmed"`)뿐. `…-integration.test.mjs`(`:27`, `:41`)는 그대로 통과해야 한다 (확인함) |
| **P1** 배분 순수 함수 | 상태 3종, 정책 검증, 규칙 4종, 우선순위, 낡음 | A·B·C 그룹 통과, 상태/런타임 import 없음 | 규칙 해석 경계 (T14 성질 시험으로 방어) |
| **P2** 도보 모델 | 길이→분, 출처 우선순위, 장벽 | D 그룹 통과 | 80 vs 75 혼용 (T31) |
| **P3** 런타임 연결 | 4개 명령, 별도 링크 컬렉션, `access-demand` 합치기/억제, 저장·복원, 롤백 | F 그룹 통과, **기존 전체 스위트 무변화** | `withStationAccess` 캐시(`accessVersion`)·`resolveTrip` 경로 변경 — T36/T37이 안전망 |
| **P4** 끝에서 끝 | 시드 고정 시나리오: 접근권 → 정책 → 적용 → 틱 → 저장 → 복원 | T36~T46 | 도쿄는 현재 전부 `unknown`이라 **실제 배분 시험은 합성 팩(국소 해상도)** 으로만 가능 |
| **P5** UI·연결 | 플레이어가 겹침 규칙을 고르는 패널(M7/M13 방식), `main.mjs` 연결 | 별도 작업 | 이 문서 밖 |

각 단계는 **독립 커밋·독립 롤백**이 가능하고 P0~P2는 엔진 동작을 바꾸지 않는다. 동작이 바뀌는 최초 지점은 P3이며, 그 전까지 현재와 100% 같다.

### 현재 팩에서 기대하는 결과 (정직한 한계)
도쿄 `demand.json`은 시구 중심점(`low`)이라 배분은 **전부 `unknown`, 링크 0**이다. 이것이 올바른 결과다. 작은 접근권에 의미 있는 배분이 나오려면 건물·소지역 수요(`building-population.json`, `subward*.json`)가 **국소 해상도·`medium` 이상**으로 `demandSourceRefs`에 연결돼야 한다 (M1 문서 한계 절). 합성 팩 시험은 정책 논리의 증명일 뿐 도쿄 수요의 증거가 아니다.

---

## 10. 결정이 필요한 것 (권고 포함)

| # | 질문 | 권고 |
|---|---|---|
| Q1 | 이름: 이미 "E2 = 런타임 보관(완료)"인데 배분 정책도 "E2"로 불린다 | 배분 정책은 **E3**로 부른다 (런타임 문서와 일치) |
| Q2 | 단독 노드를 `apply` 명령 시 자동 배정(`exclusive: assign`)해도 되나, 아니면 노드별 확인이 필요한가 | **자동 배정**. 단독은 플레이어가 그린 경계 안의 사실이고, 적용 자체가 명시적 명령이다 |
| Q3 | 그린 보행 연결이 없을 때 직선 추정(`× 1.3`)을 기본으로 켤까 | **기본 `none`**. 켜는 것은 시나리오/플레이어의 명시적 선택 (M1 "연결 안 됨 ≠ 못 걸음") |
| Q4 | E1이 허용한 면적형 해상도(`mesh-*`, `block`, `parcel`)를 E2에서 좁힐까 | **좁힌다** (기본 거부, 중심점 규칙은 명시). E1 허용 목록 자체는 두고 E2 가드로 처리 |
| Q5 | 배분 링크가 있는 노드의 레거시 자기 역 0분 어댑터와 기존 링크를 끌까 | **끈다** (노드 단위). 안 끄면 0분 자기 역이 항상 이겨서 접근권이 의미 없다 |
| Q6 | `plan-geometry.accessLinksFor`(반경 800 m)가 시구 중심점 노드를 작은 역에 잇는 기존 경로(`commissionProject`)는? | 이번 설계는 **건드리지 않고 보고만** 한다(`legacyAccessLinks` 목록). 막으려면 별도 결정: 거친 출처 노드의 반경 링크를 개통 시 제외 |
| Q7 | 접근권 export가 바뀌면 이미 적용한 배분을 자동으로 지울까 | **지우지 않고 `stale` 표시**. 변경은 명시적 명령만 (E2 런타임 문서의 "자동 적용하지 않는다" 원칙과 동일) |

---

## 11. 하지 않는 것 (범위 밖)

- 승객 수·운임·혼잡·용량 계산, 역 출입구 `demandShare` 갱신(접근권 `entranceId`는 필드만 예약), 환승 통로를 경로 그래프에 넣는 일.
- 매트릭스 팩의 OD 흐름을 역에 배분하는 일 (노드에 거주·종사자가 없다. T46에서 `unknown`으로 고정).
- 접근권 다각형과 노드 면적의 교차 비율 배분 (면적 자료 필요 — Q4의 후속).
- 지도·UI 코드와 `main.mjs` 연결.
