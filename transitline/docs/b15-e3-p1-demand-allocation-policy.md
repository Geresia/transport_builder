# B15-E3 P1 — 역 접근권 수요 노드 배분 정책 (순수 엔진 모듈)

기준 커밋 `f46b96f`, 브랜치 `b15-e3-p1-demand-allocation-policy`. 설계는 `b15-e2-allocation-policy-design-2026-10-05.md`(이하 설계 문서)의 P1 단계다.

**하는 일은 하나다: "어느 수요 노드가 어느 역 접근 site에 닿을 수 있는가"를 정한다.** 현금, 운임, 승객 생성, 혼잡, 시간 진행, 난수, 경영 상태는 읽지도 쓰지도 않는다. 걸음 시간도 계산하지 않는다(P2). 입력은 바꾸지 않고, 같은 입력은 바이트까지 같은 출력이다.

- 신규: `engine/src/station-demand-allocation-policy.mjs` (import는 `./map/ids.mjs`, E1 `station-demand-access-assessment.mjs`의 스키마 상수뿐)
- 신규: `engine/test/station-demand-allocation-policy.test.mjs` (39개)
- 수정 없음: `scenario-runtime.mjs`, `main.mjs`, `management/**`, `access-demand.mjs`, E1·E2 모듈, `engine/src/map/**`

## 입력

```js
allocateStationDemand({ access, assessment, policy = null, legacyAccessLinks = null })
allocateStationDemand({ application, policy, legacyAccessLinks })   // application = stationDemandAccessApplicationReport(state): { access, assessment }
```

| 입력 | 내용 |
|---|---|
| `access` | 지도 M1 `transitline.station-demand-access-export/1` (공간 증거, 수요 출처 `demandSourceRefs`) |
| `assessment` | E1 `transitline.station-demand-access-input/1` (`assessStationDemandAccess` 결과) |
| `policy` | 플레이어가 쓴 정책 문서(아래) 또는 `null` = 정책 없음 |
| `legacyAccessLinks` | 선택. 엔진의 기존 `[{ demandNodeId, stationId, … }]` 링크. **읽기만 한다** |

스키마가 틀리거나 `assessment`가 다른 팩·버전의 것이면 **예외**를 던진다(조용히 빈 결과를 내지 않는다). 정책이 잘못된 경우는 예외가 아니라 `policyStatus: "rejected"` 결과다.

## 정책 문서 `transitline.station-demand-allocation-policy/1`

```jsonc
{
  "schema": "transitline.station-demand-allocation-policy/1", "contractVersion": 1, "policyId": "policy:1",
  "defaults": {
    "exclusive": "hold",             // "hold"(기본) | "assign": 단독 접근 노드를 그 역에 100% — 명시했을 때만
    "shared": "hold",                // "hold"만 허용. 겹침은 규칙으로만 배정한다
    "areaNodeInclusion": "reject"    // "reject"(기본) | "centroid": 면적형 해상도(parcel/block/mesh-*)의 노드를 중심점으로 본다고 명시
  },
  "rules": [{
    "ruleId": "rule:1",
    "scope": { "demandNodeIds": ["n1"] },            // 또는 { "stationAccessIds": ["A","B"] } — 그 노드를 주장하는 역의 정확한 집합
    "boundTo": { "A": "<stationAccessRevision>", "B": "<…>" },   // 규칙을 쓸 때의 접근권 revision (필수)
    "mode": "assign-all", "stationAccessId": "A"     // 한 역에 100%
    // 또는 "mode": "fixed-shares", "shares": { "A": 0.6, "B": 0.4 }   // 각 0 < s ≤ 1, 합 ≤ 1 (나머지는 미배정)
  }]
}
```

`route-choice`, `nearest-by-walk` 같은 걸음 시간·경로가 필요한 모드는 P1 범위가 아니라 `policy-rule-mode-unsupported`로 **거절**한다(추측해서 쓰지 않는다).

저장·복원: `serializeStationDemandAllocationPolicy(policy)`는 키·규칙 순서와 무관한 정규 텍스트를 쓰고, `restoreStationDemandAllocationPolicy(text)`는 예외 없이 `{ policy, policyRevision, issues }`를 돌려준다(읽을 수 없음 `policy-unreadable`, 스키마 틀림 `policy-schema-invalid`, 규칙 오류는 이슈 목록, 이슈가 있으면 `policy: null`). `newStationDemandAllocationPolicy(id)`는 아무것도 배정하지 않는 빈 정책이다. `bindStationDemandAllocationRule(rule, { assessment })`는 플레이어가 규칙을 **다시 확인**하는 유일한 길로, `boundTo`를 현재 revision으로 채운 복사본을 돌려준다(배분 계산은 이를 대신 하지 않는다).

## 정책 규칙 (구현된 그대로)

1. **미상 노드는 값도 배정도 없다.** 다음은 모두 `state: "unknown"`, `residents/jobs/unallocatedShare/unallocated: null`, `assignments: []`이고 어떤 규칙·기본값도 풀지 못한다(규칙이 겨냥하면 `policy-cannot-unlock-unknown` 경고로 무시).
   - E1이 `unknown`으로 본 것(출처 없음·저품질·거침·값 누락 등).
   - **E1을 믿지 않고 지도 export에서 다시 검사한다**: `demand-points` 출처 없음, 품질이 `high/medium`이 아님, 해상도 미기재, `municipality|ward|city|prefecture|district|centroid`(대소문자 무시), 허용되지 않은 해상도. 평가 문서를 고쳐서 `available`로 바꿔도 통과하지 못한다.
   - 면적형 해상도(`parcel`, `block`, `mesh-250m`, `mesh-500m`)는 `area-footprint-unavailable`. 정책이 `areaNodeInclusion: "centroid"`를 명시하면 허용하고 `assumptions`에 기록한다.
   - 평가와 지도 export의 접근권 revision이 다르면 `assessment-revision-mismatch`, 지도에 역이 없으면 `access-site-missing`.
   - 같은 노드를 주장하는 역들의 값이 서로 다르면 `demand-node-values-conflict`.
2. **`confirmed-empty`만 정확한 0이다.** 역 `coverage`가 `empty-confirmed`면 `allocated/heldExclusive/sharedUnallocated`가 `{0,0}`이고, `not-drawn`·`empty-unseen`이면 셋 다 `null`이다. 알려진 노드가 없고 미상 노드가 있는 역의 합계도 `null`이다. 실제 `0/0` 노드는 값 0으로 배정될 수 있다(미상 `null`과 구분).
3. **단독 노드는 명시 없이는 배정하지 않는다.** 기본은 `held / exclusive-needs-policy`. `defaults.exclusive: "assign"` 또는 노드·집합 규칙이 있을 때만 배정한다(`ruleBasis: "default"|"node-rule"|"set-rule"`). 같은 역의 여러 접근권 다각형이 한 노드를 덮는 것은 공유가 아니다.
4. **공유 노드는 기본 미배정이다.** 주장하는 역을 **직접 세어** 2개 이상이면 지도의 겹침 기록이 없어도 `shared`다. `held / shared-needs-policy`, 값은 `sharedUnallocated`(후보 풀, 역 사이에 더해지지 않는다)에만 보인다. 균등분할·최근접·임의 동률해소·중복 배정은 코드에 없다. 규칙의 `shares`만 배정한다.
5. **비율은 정책이 말한 만큼만.** 각 값은 `0 < s ≤ 1`의 유한한 수, 합은 `1 + 1e-9` 이하(`0.1+0.2+0.7`은 1로 받는다). 합이 1보다 작으면 나머지는 `unallocatedShare`로 남는다. 합이 1을 넘거나 0·음수·NaN·Infinity·문자열·빈 `shares`면 **정책 전체를 거절**한다(`policyStatus: "rejected"`, `status: "policy-rejected"`, 어떤 노드도 배정하지 않는다 — 올바른 규칙도 적용하지 않는다). 한 노드는 한 규칙만 결정하므로 노드별 합은 그 규칙의 합이다.
6. **우선순위와 충돌.** 노드 지정 규칙 > 역 집합 규칙 > 기본값. 같은 노드를 결정할 수 있는 규칙이 둘, 같은 역 집합 규칙이 둘, 같은 `ruleId`가 둘이면 거절(`policy-rule-conflict`, `policy-rule-id-duplicate`). 세 역이 겹치는 노드는 정확히 그 3개 집합 규칙만 걸린다(쌍 규칙은 `unmatched`). 규칙이 그 노드를 주장하지 않는 역을 가리키면 `rule-station-not-claimant`로 정책 전체 거절.
7. **낡은 규칙은 재결합하지 않는다.** `boundTo`의 revision이 현재와 다르거나 역이 없어졌으면 규칙은 `stale`이고, 그 규칙이 겨냥한 노드는 `held / rule-stale`(기본값으로 되돌아가지도 않는다), 결과 `status: "stale"`, 규칙 `staleStationAccessIds`에 역이 적힌다. 노드 규칙이 묶이지 않은 새 역이 그 노드를 주장하기 시작하면 `rule-claimants-changed`(역시 stale).
8. **legacy 링크는 건드리지 않고 사실만 보고한다.** `legacyAccessLinks`를 주면 노드마다 `legacy: { supplied, linkCount, stationIds, conflictsWithAllocation, overrideRequired, activeWhileUnallocated }`를 낸다. `overrideRequired` = 새 배정이 있는 노드에 legacy 링크도 있음. `conflictsWithAllocation` = legacy 링크가 배정된 역이 아닌 곳으로 감(역 연결 정보가 없으면 `null`). `activeWhileUnallocated` = 정책이 일부라도 배정하지 않은 노드에 legacy 링크가 살아 있음. 링크 목록을 안 주면 모두 `null`(미상)이고, 빈 배열을 주면 `linkCount: 0`(사실)이다. 입력 배열은 바뀌지 않고 `walkMinutes` 같은 값은 결과에 복사되지 않는다.
9. **null은 0·false·[]가 되지 않는다.** 위 2번과 미상 노드의 `null`, 합계 `null`, 정책이 거절되어도 미상 노드는 `unknown` 그대로.

## 결과 `transitline.station-demand-allocation/1`

| 필드 | 의미 |
|---|---|
| `schema`, `contractVersion`, `allocationId` | `allocationId`는 팩 + 정책 revision + 모든 접근권 revision에서 정해지는 결정적 ID |
| `sourcePackId`, `sourcePackVersion`, `policyId`, `policyRevision` | 정책이 없거나 거절되면 `policyRevision: null` |
| `policyStatus` | `"none"` / `"valid"` / `"rejected"`, `policyIssues[]` |
| `status` | `"current"` / `"stale"`(낡은 규칙 있음) / `"policy-rejected"` |
| `nodes[]` | `demandNodeId`, `claimants[]`, `state`(`exclusive`/`shared`/`unknown`), `decision`(`assigned`/`shares`/`held`/`unknown`), `ruleId`, `ruleBasis`, `reasons[]`, `residents`, `jobs`(미상이면 `null`), `assignments[]`, `unallocatedShare`, `unallocated`, `legacy` |
| `nodes[].assignments[]` | `stationAccessId`, `share`, `residents`, `jobs`(노드 값 × 비율, 소수 6자리), `connectedPlanId`, `connectedStationId` |
| `stations[]` | `stationAccessId`, `stationAccessRevision`, `coverage`, `allocated`, `heldExclusive`, `sharedUnallocated`(`{residents, jobs}` 또는 `null`), `unknownNodeCount`, `complete`, `reasons[]` |
| `rules[]` | `ruleId`, `scope`, `status`(`applied`/`unmatched`/`stale`/`rejected`), `matchedNodeIds`, `appliedNodeIds`, `staleStationAccessIds`, `reasons` |
| `totals` | 노드 수 집계(`nodes`, `exclusive`, `shared`, `unknown`, `assigned`, `partlyAssigned`, `held`) |
| `legacy` | `supplied`, `nodesWithLegacyLinks`, `overrideRequiredNodeIds`, `conflictNodeIds` (링크 미제공이면 `null`) |
| `assumptions[]`, `warnings[]` | `area-node-centroid-inclusion`, `policy-cannot-unlock-unknown`, `rule-node-not-claimed` |

결과에는 운임·비용·혼잡·승객·시간·난수를 뜻하는 키가 **없다**(테스트가 모든 키를 훑는다). `residents/jobs`는 노드의 거주·종사 값이지 승객 수가 아니다. 배정은 "접근 가능"의 결정이며 발생량(`demand-engine`)은 전혀 건드리지 않는다.

## 테스트 (39개, `engine/test/station-demand-allocation-policy.test.mjs`)

무정책 단독·공유 미배정, 명시 `assign` 기본, 명시 비율 분할(0.6/0.4)과 합 미만 나머지, 합계 > 1 거절과 올바른 규칙의 미적용, 부동소수 합, 0·음수·NaN·Infinity·문자열·빈 `shares` 거절, 비소유 역 규칙 거절, 규칙·집합·ID 충돌, 우선순위, 3역 겹침의 쌍 규칙 미적용, 같은 역 이중 다각형, 겹침 기록 없는 공유 감지, 단독 노드 부분 비율, 낡은 revision 규칙(재결합 없음, 명시 재바인드만), 주장 역 변경에 의한 stale, stale이 기본값을 덮음, 거친/저품질/출처 없음/미승인 해상도 9종 차단과 경고, **변조된 평가 문서 방어**, revision·역 불일치, 면적 해상도와 중심점 가정 기록, 미상 노드를 겨냥한 규칙, 값 충돌, null과 0의 구분(0/0 노드, `empty-confirmed`/`empty-unseen`/`not-drawn`, 미상만 있는 역), legacy 링크 보고(불변, 미제공 `null`), **400건 무작위 성질 시험**(합 ≤ 1, 중복 배정 없음, 미상은 무배정, 정책 없이는 무배정, 공유 노드는 규칙으로만, 값 초과 없음, 결정성), 순서를 섞어도 바이트 동일·`allocationId` 동일, 동결 입력 불변과 결과가 입력과 객체를 공유하지 않음, `application` 입력, 스키마·팩 불일치 예외, 정책 스키마·기본값, 미지원 모드 거절, 저장·복원(정규 텍스트, 순서 무관, 재배분 동일), 복원 비예외, import·금지 API·금지 키, **실제 도쿄 M1 예제**(시구 중심점·저품질 → 가장 관대한 정책에서도 배정 0, 값 `null`).

## 실제 한계

- **도쿄에서는 지금 아무것도 배정되지 않는다.** `demand.json`은 시구 중심점(`low`)이라 모든 노드가 미상이다. 이것이 올바른 결과다. 의미 있는 배정은 건물·소지역 수요가 국소 해상도·`medium` 이상으로 연결된 뒤에야 나온다. 배정 시험은 합성 픽스처로만 했다(정책 논리의 증명일 뿐 도쿄 수요의 증거가 아니다).
- 걸음 시간·장벽·경로 선택 모드(`route-choice`, `nearest-by-walk`)는 없다(P2 이후). 그래서 P1의 링크는 "접근 가능한 역과 비율"까지이고 `walkMinutes`가 없다.
- 운행 역 대응(`operationalStationId`)과 링크 생성은 P3다. 결과의 `connectedStationId`는 계획 역 ID일 뿐 `state.stations`의 역이 아니다. legacy 충돌 판정은 이 계획 역 ID와의 비교다.
- 한 노드에 대한 규칙은 하나뿐이라 "여러 규칙의 비율 합산"은 없다(합산하면 거절이 아니라 충돌이다).
- 정책 문서의 모르는 필드는 정규화에서 버려진다(거절하지 않는다).
- 이 모듈은 상태를 저장하지 않는다. 정책·결과의 보관, 낡음 표시, 되돌리기는 P3(런타임)의 일이다.

## Codex 런타임 연결 (P3)

| | |
|---|---|
| **입력** | `stationDemandAccessApplicationReport(state)` → `{ access, assessment }`; 정책 = 플레이어/시나리오가 저장한 문서(`restoreStationDemandAllocationPolicy`로 검증); 선택적으로 `state.accessLinks`(읽기 전용 복사본)를 `legacyAccessLinks`로 |
| **미리보기** | `assessStationDemandAllocation(policy)` → `allocateStationDemand(...)`의 결과를 그대로 반환. 상태 변경 없음 |
| **적용** | `policyStatus === "valid"`이고 `status === "current"`일 때만 저장·링크 생성. `rejected`/`stale`이면 플레이어에게 이슈를 보이고 적용하지 않는다. 낡은 규칙은 `bindStationDemandAllocationRule`로 플레이어가 다시 확인해야 한다 |
| **링크로 옮길 것** | `nodes[].assignments[]` 중 `share > 0`인 것만. `share`는 정책이 말한 비율이고 `unallocatedShare > 0`인 몫은 링크로 만들지 않는다. 역은 `connectedStationId`로 운행 역을 정확히 하나로 풀고, 0개·2개 이상이면 링크 없이 사유를 남긴다 |
| **걸음 시간** | 이 결과에는 없다. P2(길이→분)가 `access`의 `walkLinks[].lengthMeters` 등으로 계산해 링크의 `walkMinutes`를 채운다 |
| **legacy** | `legacy.overrideRequiredNodeIds`/`conflictNodeIds`를 보고 기존 링크·0분 자기 역 어댑터를 노드 단위로 끌지 정한다(설계 Q5). 이 모듈은 끄지 않는다 |
| **보존** | 정책 텍스트 + `allocationId`/`policyRevision`을 상태에 저장하고, 접근권 export가 바뀌면 `allocateStationDemand`를 다시 불러 `status: "stale"`로 보고한다(자동 재적용 없음) |
| **하지 말 것** | 결과를 승객 수로 읽기, `residents/jobs` 합으로 발생량 바꾸기, `held` 노드를 링크로 만들기 |
