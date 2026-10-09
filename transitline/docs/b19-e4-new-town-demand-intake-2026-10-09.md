# B19-E4 신도시 수요 후보 승인 기록 엔진 — 인수 문서

B19-E2 후보(`buildNewTownDemandCandidates`)는 사실을 읽기만 한다. 이 엔진은 그 후보에 대해 **플레이어가 명시적으로 내린 승인·보류·거절·철회**를 `ManagementGame.transact` 안에서 기록하는 안전 경계다. 기준은 master `7f85cfc`. **다음 단계(B15에 쓰는 단계)가 읽을 입력 경계만** 만든다: B15 state·accessLinks·demandNodes를 읽지도 바꾸지도 않고, 수요 노드를 만들지 않으며, 인구·수요·승객·통행·운임·혼잡·비용·점수·확률을 계산하지 않는다. 후보의 수량은 합산하지도 residents↔jobs로 바꾸지도 않는다. `null`(적지 않음) / `0` / `[]`은 그대로 보존한다.

## 파일

| 파일 | 역할 |
|---|---|
| `engine/src/management/new-town-demand-intake.mjs` | 계약·상태·문턱(blockers)·standing 판정 (순수 함수, import는 E1 `new-town-development.mjs`와 E2 `../new-town-demand-candidates.mjs`뿐) |
| `engine/src/management/game.mjs` | `ManagementGame`: 저장 목록 `newTownDemandIntakes`, 카운터, 6개 메서드, snapshot/restore |
| `engine/src/management/index.mjs` | `export *` 한 줄 |
| `engine/src/scenario-runtime.mjs` | 같은 6개 메서드 위임 + `report().newTownDemandIntakes` |
| `engine/test/new-town-demand-intake.test.mjs` | 11개 (실제 M1 예제 geometry, 실제 `ManagementGame`/`ScenarioRuntime`) |

## 계약 `transitline.new-town-demand-intake/1`

```js
{
  schema, contractVersion: 1,
  id: "new-town-demand-intake:N",                 // 순번, 재사용 없음
  developmentRecordId,                            // E1 기록 id (new-town-development:N)
  developmentId, candidateId, phaseId, lifecycleHookId,   // 후보 id는 E2가 정한 결정적 id
  status: "accepted" | "held" | "rejected" | "revoked",
  acceptance: null | {                            // 승인된 때의 근거를 그대로 보존 (철회 뒤에도 남는다)
    acceptedAtMinute, note,                       // note: 없으면 null
    statedDemandFactIds: [...],                   // 플레이어가 고른 사실 id (고른 순서)
    statedDemandFacts: [{ factId, sequence, recordedAtMinute, kind, quantity, source, note }],   // E2가 복사한 그대로. 합계·변환 없음
    occupancyFactIds: [...],                      // 승인 때 그 단계의 입주 사실 전체
    developmentRevision, phaseRevision,           // 승인 때의 지도 revision
    sourcePack: { packId, packVersion },
    lifecycle: { status, phaseStatus, transitionIds },
  },
  revocation: null | { reason, revokedAtMinute, fromStatus },
  history: [{ decisionId: "<id>:decision:N", sequence, kind, from, to, atMinute, reason }],
  createdAtMinute, updatedAtMinute,
}
```

저장되는 상태는 `accepted / held / rejected / revoked`. **`pending`(살아 있는 기록 없음)과 `stale`(승인 뒤 근거가 바뀜)은 현재 입력에서 계산되는 상태**이며 저장하지 않는다(`standing.currentStatus`).

### 전이

`none`은 그 후보에 살아 있는(철회되지 않은) 기록이 없음.

| 명령 | 시작 상태 | 비고 |
|---|---|---|
| accept | none · held · rejected | 아래 문턱 전부 통과해야 함. 사실 id를 플레이어가 고름 |
| hold | none · rejected | 사유 필수(≤200자) |
| reject | none · held | 사유 필수 |
| revoke | accepted | 사유 필수. **지도가 필요 없다** (언제나 거둘 수 있다) |

`revoked`는 끝이다. 같은 후보에 다시 결정하면 **새 기록(새 id)**이 생기고 철회된 기록은 그대로 남는다. 살아 있는 기록이 이미 `accepted`면 hold/reject/accept는 `status-not-allowed:accepted`로 막힌다 (철회 먼저).

## accept 문턱

`assessNewTownDemandIntake`의 `blockers`(문자열)와 던져지는 오류 메시지(`New town demand candidate <id> cannot accept: …`)가 같다.

- `candidate-not-found` — 그 개발 기록의 E2 후보에 없는 id (다른 개발·다른 단계·지어낸 id). 입주 사실이 없는 단계는 후보 자체가 없다.
- `status-not-allowed:<state>`
- `candidate-not-eligible:<true|false|null>` — **`eligibleForB15 !== true`면 거절** (null=불완전, false=막힘)
- `candidate-blocker:<…>` (E2 `inputCompleteness.blockers`: `geometry-stale`·`geometry-inactive`·`geometry-other-pack`·`lifecycle-cancelled`·`phase-cancelled`), `candidate-missing:<…>` (사실·위치·geometry 누락)
- `geometry-<status>` + 사유 (E2의 개발 수준 geometry 상태가 `current`가 아닐 때: stale / inactive / other-pack / missing / invalid / pack-unknown)
- 사실 id: `stated-demand-fact-ids-not-chosen`(없음·빈 목록·배열 아님), `stated-demand-fact-id-invalid:<i>`, `stated-demand-fact-id-duplicate:<id>`, `stated-demand-fact-not-in-candidate:<id>`(없는 id·**다른 후보의 사실 id**), `stated-demand-fact-kind-repeated:<kind>`(같은 종류 두 개를 함께 고르면 합쳐질 위험이 있어 막음)

residents 한 개와 jobs 한 개는 함께 고를 수 있고, 각각 그대로(예: `quantity: 0`) 보존된다.

## 승인 뒤의 변화: standing

`newTownDemandIntakeReport(id?, { geometry? })`의 각 항목은 저장된 기록에 `standing: { currentStatus, verification: { status, reasons } }`가 붙는다. 승인은 **자동으로 고쳐지거나 다시 승인되지 않는다**.

| `verification.status` | 뜻 |
|---|---|
| `current` | 승인 근거가 전부 그대로 (geometry를 줬을 때만 가능) |
| `stale` | 바뀐 것이 있다 → `currentStatus: "stale"` |
| `unverified` | 바뀐 것은 없지만 확인할 수 없다 (geometry 없음·쓸 수 없음). `currentStatus`는 `accepted`로 남지만 **쓰는 쪽은 `current`일 때만 믿어야 한다** |
| `not-applicable` | accepted가 아님 |

stale 사유: `lifecycle-cancelled`, `phase-cancelled`, `source-pack-changed`, `development-revision-changed`, `lifecycle-status-changed`, `phase-lifecycle-status-changed`, `lifecycle-transitions-changed`(승인 뒤 E1 이력이 하나라도 늘면 — 지연→재개 같은 되돌림도 포함), `occupancy-facts-changed`(그 단계의 입주 사실 목록이 달라짐), `stated-demand-fact-missing/changed:<id>`, `geometry-stale|inactive|other-pack` + E2 사유, `geometry-missing`+`geometry-development-not-in-export`(지도에서 사라짐), `geometry-revision-changed`, `phase-revision-changed`, `candidate-no-longer-eligible:false`, `candidate-not-found`. `unverified` 사유: `geometry-missing`/`geometry-not-provided`, `geometry-invalid`, `geometry-pack-unknown`, `candidate-eligibility-unknown`.

런타임의 `report().newTownDemandIntakes`는 geometry 없이 계산한 standing을 담는다(승인은 기껏해야 `unverified`). 지도를 쥔 호스트가 `runtime.newTownDemandIntakeReport(null, { geometry })`로 확인한다. 지도가 승인 때의 revision으로 되돌아오면 근거가 같으므로 다시 `current`가 된다(승인이 거둬진 적은 없다). 입주 사실·생애주기는 되돌릴 수 없다.

## runtime API (`ScenarioRuntime`, 같은 이름이 `ManagementGame`에도 있다)

| 메서드 | 입력 | 하는 일 |
|---|---|---|
| `assessNewTownDemandIntake(input)` | `{ developmentRecordId, geometry?, candidateId?, statedDemandFactIds? }` | 읽기 전용. 그 개발의 후보마다 `currentStatus`·`verification`·`accept/hold/reject/revoke` 문턱. `candidateId`를 주면 `selected`에 그 후보(사실 id 검사 포함) |
| `acceptNewTownDemandCandidate(input)` | `{ developmentRecordId, candidateId, statedDemandFactIds, geometry, note? }` | 승인 |
| `holdNewTownDemandCandidate(input)` | `{ developmentRecordId, candidateId, reason, geometry? }` | 보류 |
| `rejectNewTownDemandCandidate(input)` | 위와 같음 | 거절 |
| `revokeNewTownDemandCandidate(id, reason)` | 기록 id | 승인 철회 |
| `newTownDemandIntakeReport(id?, { geometry? })` | | 읽기 전용 복사본 + standing |

`geometry`는 E1/E2처럼 호출마다 넘기는 읽기 전용 일반 객체다(M1 개발 하나, 또는 M1 export 전체). 명령은 모두 `transact` 안에서 처리되어 오류 시 기록·id 카운터·이벤트 로그가 통째로 되돌아간다. 난수·시계·돈을 건드리지 않는다. 저장은 `snapshot()/restore()`가 `newTownDemandIntakes`와 `nextNewTownDemandIntakeSequence`를 실어 나르고, 복원 때 카운터는 `max(저장된 카운터, 가장 큰 기존 id + 1)`이라 id가 재사용되지 않는다. 이 기능 이전의 저장(필드 없음)은 빈 목록으로 복원된다.

## 다음 단계(B15 입력)가 지킬 것

- 쓸 수 있는 것은 `standing.currentStatus === "accepted"`이고 `standing.verification.status === "current"`인 기록뿐이다 (geometry를 넘겨 확인한 결과).
- `acceptance.statedDemandFacts`는 플레이어가 고른 사실이다. 합산하지 말고, residents/jobs를 서로 바꾸지 말고, 고른 것 밖의 사실을 보태지 않는다.
- 이 엔진은 B15에 아무것도 적용하지 않는다. 적용 단계는 별도 명령이어야 하고, 적용 시점에 다시 `current`를 확인해야 한다.

## 한계

- 후보 id는 E2의 `새 도시 개발 id + 단계 id`라서, 같은 geometry 개발의 취소된 기록과 새 기록은 `developmentRecordId`로 구분한다 (기록은 개발 기록별로 따로 산다).
- 승인 뒤 E1 이력이 늘면 같은 개발의 다른 단계 입주 기록만으로도 모든 승인이 stale이 된다 (보수적 선택: 다시 결정하면 된다).
- 지도 revision이 돌아오면 같은 승인이 다시 `current`가 된다. 이를 막으려면 철회가 필요하다.
- UI와 `main.mjs` 연결은 이 작업에 없다.
