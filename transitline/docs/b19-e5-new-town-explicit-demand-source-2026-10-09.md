# B19-E5 승인된 신도시 후보 → B15 명시 수요 원천 브리지 — 인수 문서

B19-E4에서 **`accepted`이고 근거가 아직 `current`인 intake**만 "명시 수요 원천" 기록으로 옮기는 경계다. 기준은 master `4884f24`. 이 단계는 **B15가 읽을 입력 한 장을 따로 보관할 뿐**이다: 수요 노드를 만들거나 지우거나 합치지 않고, `accessLinks`를 바꾸지 않고, 기존 수요 원천을 덮어쓰지 않고, B15 정책을 승인하지 않으며, 승객·운임·혼잡·비용·점수·확률을 계산하지 않는다. residents/jobs 수치는 플레이어가 적은 그대로 복사한다(`0`은 명시 0, `null`은 미상, 합산·환산·비율 없음).

## 파일

| 파일 | 역할 |
|---|---|
| `engine/src/new-town-explicit-demand-source.mjs` | 계약·문턱·standing·적용/철회 (import 없음, 순수 함수 + 운영 상태의 한 키만 씀) |
| `engine/src/scenario-runtime.mjs` | runtime bridge 4개 메서드 + `report().newTownExplicitDemandSources` |
| `engine/test/new-town-explicit-demand-source.test.mjs` | 11개 (실제 `ScenarioRuntime`, 실제 M1 예제 geometry) |

`management/**`, `main.mjs`, `index.html`, `style.css`, `map/**`는 건드리지 않았다.

## 계약

`transitline.new-town-explicit-demand-source/1` — intake 하나당 하나, id는 `new-town-explicit-demand-source:<intakeId>` (intake id가 재사용되지 않으므로 결정적이고 재사용 없음).

```js
{
  schema, contractVersion: 1, sourceId,
  intakeId, candidateId, developmentRecordId, developmentId, phaseId, lifecycleHookId,
  sourcePack: { packId, packVersion },              // 승인 때의 팩 (packVersion은 null일 수 있다)
  developmentRevision, phaseRevision,               // 승인 때의 지도 revision
  lifecycle: { status, phaseStatus, transitionIds },// 승인 때의 생애주기
  statedDemandFactIds: [...],                       // 플레이어가 고른 사실 id
  statedDemandFacts: [{ factId, sequence, recordedAtMinute, kind, unit, quantity, source, note }],   // 사실 그대로. unit == kind(residents|jobs)
  basis: { derivation: "copied-as-stated", statedBy: "player", approvedBy: "new-town-demand-intake", intakeSchema },
}
```

`transitline.new-town-explicit-demand-sources/1`은 읽기 전용 평가 결과: `{ sourcePackId, sourcePackVersion, sources, excluded, notComputed }`.
- `sources`: **accepted intake만**. 항목마다 `standing: { status: current|stale|unverified|withdrawn, reasons }`, `applied: null|"applied"|"withdrawn"`, `apply: { allowed, blockers }`.
- `excluded`: accepted가 아닌 intake(held/rejected/revoked)는 `{ intakeId, candidateId, status, reasons }`로 **사실만** 적고 수치나 source 객체는 만들지 않는다. pending(결정 기록 없음)은 intake 자체가 없으므로 아무것도 나오지 않는다.

적용된 기록은 운영 상태 `operationalState.newTownExplicitDemandSources = { schema: "transitline.new-town-explicit-demand-source-application/1", contractVersion: 1, sources: [{ …계약, status: "applied"|"withdrawn", appliedAtSimMinute, withdrawal: null|{ reason, atSimMinute } }] }`에 쌓인다. 이 한 키 말고는 운영 상태의 어떤 것도 읽거나 바꾸지 않는다(테스트가 나머지 전부가 같음을 검사). 통합 저장은 운영 상태의 일반 키를 그대로 싣고, 이전 저장본(키 없음)은 빈 목록으로 읽힌다.

## runtime API (`ScenarioRuntime`)

| 메서드 | 입력 | 하는 일 |
|---|---|---|
| `assessNewTownExplicitDemandSources({ geometry? })` | geometry: M1 개발 하나 또는 M1 export | 읽기 전용. 위 평가 결과 |
| `applyNewTownExplicitDemandSource({ intakeId, geometry })` | | **명시 명령**. 문턱을 통과한 intake 하나를 source로 적용. `transact` + 운영 상태 롤백 |
| `withdrawNewTownExplicitDemandSource(sourceId, reason)` | | 적용된 source를 거둠(지도 불필요). 기록은 `withdrawn`으로 남고 다시 적용할 수 없다 |
| `newTownExplicitDemandSourceReport({ geometry? })` | | 적용된 source 복사본 + 지금의 standing |

`report().newTownExplicitDemandSources`는 geometry 없이 계산한 standing을 담는다(그래서 기껏해야 `unverified`).

## 적용 문턱 (blockers, 오류 메시지 `New town explicit demand source for intake <id> cannot be applied: …`)

- `intake-not-found`, `intake-not-accepted:<held|rejected|revoked>` — **accepted가 아니면 B15 입력을 절대 만들지 않는다**
- `intake-stale` + 사유(E4가 알려 준 stale 사유 그대로: 지도 revision·팩·입주 사실·생애주기 변경 등), `intake-unverified` + 사유(지도를 안 줘서 확인 못 함)
- `source-pack-differs-from-scenario:<packId>`, `source-pack-version-differs-from-scenario:<v>` — 시나리오 팩과 다른 팩의 승인은 섞지 않는다 (버전이 한쪽 `null`이면 불일치로 보지 않는다)
- `intake-already-applied:<sourceId>`, `intake-source-withdrawn:<sourceId>` — 같은 intake는 한 번만
- `candidate-already-has-source:<sourceId>` — **후보당 살아 있는 source는 하나.** 다시 승인한 새 intake는 옛 source를 먼저 철회해야 적용된다 (덮어쓰기 없음)

## 적용 뒤의 변화: standing

적용된 source는 **자동으로 지워지거나 고쳐지거나 다시 적용되지 않는다.** 지금의 상태만 보고한다.

| `standing.status` | 뜻 |
|---|---|
| `current` | intake가 accepted이고 E4 검증이 `current`이며 source가 intake와 같다. **이것만 다음 단계가 쓴다** |
| `stale` | `intake-revoked` 등 intake가 더 이상 accepted가 아님(`intake-<status>`), `intake-record-missing`, `source-differs-from-intake`, 또는 E4 stale 사유 전부(`geometry-stale|inactive|other-pack`, `geometry-revision-changed`, `occupancy-facts-changed`, `lifecycle-*`, `source-pack-changed`…) |
| `unverified` | 바뀐 것은 없지만 지도를 안 줘서 확인 못 함 |
| `withdrawn` | 플레이어가 거둠 |

## 다음 단계가 지킬 것

- 읽을 수 있는 것은 `status === "applied"`이고 `standing.status === "current"`인 source뿐이다 (호출 때 geometry를 넘겨 확인).
- `statedDemandFacts`를 합산하지 말고 residents↔jobs로 바꾸지 않으며 비율로 만들지 않는다. 한 source에 residents와 jobs가 함께 있으면 각각 따로 쓴다.
- B15에 쓰는 일(수요 노드·접근권 연결·정책)은 별도 명시 명령이어야 하고, 쓰는 시점에 다시 `current`를 확인한다.

## 검증

단위 테스트 11개: 승인 없으면 source 0건(pending·held·rejected·revoked), 계약 필드 전체와 `0`·`null` 보존, 명시 적용이 다른 운영 상태·B15 보고서·팩 수요를 바꾸지 않음, 지도·팩·입주 사실·생애주기·철회로 stale이 되어도 기록은 그대로이고 재적용 불가, 후보당 하나·철회 후 재적용 불가, 팩/버전 혼입 거절(버전 `null` 보존), 저장·복원·구저장본·`transact` 롤백(운영 상태와 관리 상태 모두), frozen 입력 불변·복사본·난수/시계/돈 불변, 같은 단계의 같은 바이트(읽기 순서 무관), 소스 규칙(import 없음, 수치 연산 없음).

## 한계

- 이 단계는 B15 쪽 소비자를 만들지 않는다: 지금 B15 배분은 팩 `demand.points`의 노드만 읽으므로, 적용된 source를 접근권·배분에 쓰는 것은 B15의 다음 명시 단계다.
- 지도 revision이 승인 때로 돌아오면 같은 source가 다시 `current`가 된다 (E4와 같은 규칙; 막으려면 철회).
- 한 intake의 source를 철회하면 다시 적용할 수 없다. 같은 후보를 다시 쓰려면 intake를 철회하고 새로 승인한다.
- UI와 `main.mjs` 연결은 이 작업에 없다 (B19-M6 지도 오버레이와 B19-C2 Codex 연결).
