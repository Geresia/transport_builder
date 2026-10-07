# B15-E6 — 분수 배정 라우팅 진단 보고서

기준 커밋 `62618e1` (B15-E5 병합 후 master), 브랜치 `b15-e6-fractional-routing-diagnostics`.
B15-E5가 한 노드의 승객을 역 사이에 비율대로 나누는데, 플레이어는 그것이 **지금 어떤 상태인지** 볼 길이 없었다. 이 보고서가 그 길이다. 읽기 전용이며, 수요량·승객 수·운임·비용·혼잡을 계산하거나 바꾸지 않는다. 난수·시계·경영 상태를 건드리지 않는다.

## 파일

| 파일 | 변경 |
|---|---|
| `engine/src/station-demand-allocation-diagnostics.mjs` | **신규.** `buildStationDemandAllocationDiagnostics(state)` — 상태를 읽기만 한다 |
| `engine/src/access-demand.mjs` | **관측 카운터만 추가.** 라우팅 결과·난수·저장 구조의 기존 필드는 그대로 (아래 "E5 라우팅은 바뀌지 않았다") |
| `engine/src/scenario-runtime.mjs` | `stationDemandAllocationDiagnostics()` 메서드와 `report().stationDemandAllocationDiagnostics` 필드 |
| `engine/test/station-demand-allocation-diagnostics.test.mjs` | 새 테스트 27개 |
| `engine/test/helpers/e5-access-demand.mjs` | B15-E5 시점 `access-demand.mjs`의 동결 사본 (동치 비교 전용) |

`main.mjs`, `index.html`, `style.css`, `management/**`, 지도 코드, `demand-engine.mjs`, `passengers.mjs`, 정책·보행·통합 모듈은 수정하지 않았다.

## 왜 `access-demand.mjs`를 건드렸나 (정직하게)

E5의 저장 커서(`stationDemandAllocationCursors`)는 **선택 횟수**(`total`, `taken[역]`)만 센다. 그것만으로는 선택된 역에서 승객이 **왜 경로 없음이 됐는지**(그 역에 경로가 없음 / 도착과 같은 역 / 반대편에 접근이 없음 / 반대편이 "아무 역도 아님"을 뽑음)를 알 수 없다. 사유를 구분하라는 요구를 지키려면 선택 직후의 결과를 센 값이 상태에 있어야 한다.

그래서 라우터에 **수동 정수 카운터**를 더했다. 선택된 슬롯마다 `cursor.outcomes[역] = { routed, partnerNobody, partnerNoAccess, sameStation, noRoute }`를 1씩 올릴 뿐이고, 어떤 선택에도 읽히지 않으며, 난수를 쓰지 않고, 커서와 함께 새로 시작하고 링크를 교체하면 함께 지워진다. 분할이 한 번도 쓰이지 않은 상태에는 아무것도 생기지 않는다(저장 바이트 동일).

### E5 라우팅은 바뀌지 않았다 (증거)

- `resolveTrip`이 돌려주는 값이 같다: **동결된 E5 사본과 신규 라우터가 6가지 상황(60/40, 미배정 나머지, 선택된 역에 경로 없음, 같은 역, 반대편 접근 없음, 양쪽 분할+나머지) 각 60건에서 모두 같은 답**을 낸다. 커서 카운트와 `rng.snapshot()`도 같다(테스트).
- **3시간 시뮬레이션**을 신규와 E5 사본으로 각각 돌려 `outcomes`만 빼고 `snapshotOperationalState`, `stats`, `rng.snapshot()`이 같다. 분할을 쓰지 않는 상태(링크 없음, 100% 링크)는 저장 **바이트가 완전히 같다**.
- E5의 기존 테스트 30개가 그대로 통과한다. 변이 확인: 같은 역 사유 표시를 일부러 틀리게 하면 관련 테스트 2개가 실패하는 것을 확인하고 되돌렸다.
- `access-demand.mjs`에는 읽기 전용 export 두 개(`appliedAllocationLinksByDemandNode`, `splitOf`)와 상수 하나(`ALLOCATION_SCHEDULE`)도 더했다. 진단이 **라우터와 같은 분할**을 설명하게 하려는 것이며 동작은 같다.

## 보고서 구조 `transitline.station-demand-allocation-diagnostics/1`

```
{ schema, contractVersion: 1,
  status:      "no-allocation" | "links-without-application" | "current" | "stale",
  application: null | { applicationId, status, staleReasons[], appliedAtSimMinute, accessApplicationId,
                        currentAccessApplicationId, linksMatchApplication },
  totals: { splitNodes, singleStationNodes, legacyFallbackNodes,
            byRole: { origin: RoleTotals, destination: RoleTotals } },
  nodes: [Node],            // 링크가 있는 노드마다, 노드 ID 순
  orphanCursors: [{ key, total }],   // 더는 분할이 아닌 노드의 남은 커서
  limits: [Limit] }         // 항상 10개, 코드 고정
```

### `Node`

| `routing` | 뜻 | 담는 것 |
|---|---|---|
| `split` | 분수 배정(둘 이상의 역, 또는 한 역이 노드의 일부) | `configured`, `roles`, `droppedLinks` |
| `single-station` | 한 역이 노드 전부(100%) — 분할 아님 | `configured.stations` |
| `legacy-fallback` | 저장된 링크가 **전부** 쓸 수 없음 → 라우터는 정책이 없는 것으로 보고 기존 접근으로 돌아감 | `droppedLinks`(링크별 사유) |

`configured`(split): `stations[{stationId, walkMinutes, share, micro}]` 설정 비율(`micro` = 백만분율 정수), `noStationShare`(어느 역도 가져가지 않는 몫), `noStationComposition`(그 몫의 구성).

`noStationComposition` — 미배정 몫이 **왜** 생겼는지 설정 수준에서 나눈다:
`unallocatedByPolicy`(정책이 배정하지 않은 몫), `blockedAtApply[{stationAccessId, code, share}]`(적용 때 막힌 몫: 운행역 없음·보행 불가), `droppedSinceApply[{stationId, reason, share}]`(적용 뒤 무효가 된 링크: `station-missing`, `walk-minutes-invalid`, `share-invalid`, `demand-node-missing`), `unexplainedShare`(위 합으로 설명되지 않는 나머지 — 반올림이나 적용 뒤 편집; `null`이면 구성 요소를 알 수 없음). 아무 역도 아닌 몫을 뽑은 개별 선택이 이 중 무엇 때문인지는 알 수 없고, 구성 비율만 보인다.

### `roles.origin` / `roles.destination` — 같은 노드의 출발·도착은 따로 센다

| 필드 | 뜻 |
|---|---|
| `cursor` | `present` / `absent`(아직 이 역할로 쓰이지 않음 — 0은 **사실**) / `restarts-on-next-trip`(비율이 바뀌어 다음 승객에서 처음부터; `previous`에 옛 값) / `inconsistent` |
| `total` | 이 역할로 역을 고른 횟수 |
| `slots[]` | 슬롯마다 `{ slotId, kind("station"\|"no-station-share"), stationId, walkMinutes, configuredMicro, configuredShare, picks, expectedPicks, deviationPicks, withinOnePick, outcomes }` — 설정 비율 vs **실제 선택 수**, `expectedPicks = total × 비율`, `withinOnePick`은 E5의 보장(1건 이내) |
| `trips` | `{ picks, coverage("complete"\|"partial"\|"none"), exact, routed, unrouted, unroutedByReason{ noStationShare, partnerNobody, partnerNoAccess, sameStation, noRoute } }` |

**경로 없음 사유**(선택 하나는 정확히 하나로 센다):

| 사유 | 뜻 |
|---|---|
| `noStationShare` | 이 노드가 "아무 역도 아님" 몫을 뽑음 (`taken[""]`) |
| `partnerNobody` | 이 노드는 역을 뽑았는데 반대편 노드가 "아무 역도 아님"을 뽑음 |
| `partnerNoAccess` | 반대편 노드에 쓸 수 있는 역 접근이 아예 없음 |
| `sameStation` | 출발과 도착이 같은 역 (대중교통 경로 0) |
| `noRoute` | 뽑힌 역에서 상대 역까지 경로가 없음 |

`routed`는 경로가 있었던 선택 수다. `routed + unrouted`는 `total`과 같다(`exact: true`일 때, 테스트). **한 승객은 출발 노드 하나와 도착 노드 하나를 가지므로 역할 사이를 더하지 않는다** — `totals.byRole`은 역할별 합이다.

`exact`가 `false`면: E6 이전에 저장된 선택은 **선택 수만 있고 결과가 없다**. 이때 `coverage: "none"`이면 `routed`·`unrouted`·결과 사유는 `null`(모름), `"partial"`이면 센 만큼의 하한값이다. 지어내지 않는다.

### `limits[]` — E5의 알려진 한계를 **지금 상태에 대해** 말한다

각 항목은 `{ code, status, text, evidence }`이고 `status`는 `observed`(실제로 일어남) · `latent`(설정상 일어날 수 있음, 아직 안 일어남) · `active` · `info` · `none`.

| 코드 | 내용 |
|---|---|
| `unrouted-trips-shift-the-random-stream` | **E5 한계 1.** 경로 없음 승객은 교통수단 선택에서 난수를 1개 덜 쓰므로, 배분되지 않은 몫이나 같은 역 선택이 있으면 이후 난수 흐름과 **실현된 발생 수**가 100% 배정 실행과 달라질 수 있다. 기대 발생량(`rate`)과 목적지 선택 규칙은 그대로다. `observed`면 실제 경로 없음 선택 수를 증거로 보인다 |
| `same-station-trips` | **E5 한계 2.** 같은 역이 출발과 도착이 되면 경로 없음. 비율을 지키려고 다른 역으로 바꾸지 않는다. `latent`는 한 역을 두 노드가 쓸 때 |
| `share-without-station-is-not-routed` | 쓸 수 없는 링크의 몫은 다른 역·기존 접근으로 가지 않고 경로 없음 |
| `all-links-unusable-falls-back-to-legacy` | **E5 한계 3.** 링크가 전부 쓸 수 없는 노드는 정책 밖의 기존 접근으로 돌아간다 (경로 없음이 아님) |
| `outcome-counters-incomplete` | E6 이전 저장본의 선택은 결과 사유를 알 수 없음 |
| `counts-restart-with-the-links` | 선택 수는 링크 재적용·비율 변경 시점부터. 게임 시작부터의 누적이 아님 |
| `schedule-follows-call-order` | 일정은 호출 순서에 묶임 |
| `application-is-stale` | 지도 접근권이 바뀐 뒤에도 링크와 일정은 그대로 쓰임 |
| `mode-choice-is-not-observed` | 역을 얻은 승객도 걷기·자동차를 고를 수 있음. 이 보고서는 역 선택과 경로 유무까지만 봄 |
| `counts-selections-not-demand` | 이 숫자는 선택 횟수일 뿐 수요·승객 수·운임·혼잡이 아님 |

## 읽기 전용·결정성·저장

- 상태에 **아무것도 쓰지 않는다.** 아직 없는 커서를 만들지도 않는다(상태를 `Object.freeze`하고 호출해도 던지지 않음, 커서 부재가 유지됨, 호출 전후 저장 바이트·`rng.snapshot()`·시계가 같음 — 테스트). `Math.random`/`Date.now`를 던지게 해 두고 호출해도 통과한다. 소스에는 `delete`·상태 대입·`??=`·`structuredClone`이 없고 임포트는 `./access-demand.mjs` 하나뿐이다.
- 같은 상태는 항상 같은 보고서이며, 링크·커서의 저장 순서에 영향받지 않는다(바이트 동일).
- 반환값은 복사본이다. 고쳐도 상태에 닿지 않는다.
- **저장/복원:** 복원한 상태의 보고서는 저장 직전 보고서와 `deepEqual`이고, 복원 뒤 다음 13번의 선택은 저장하지 않고 이어 간 실행의 선택과 같으며, 그 뒤 보고서도 같다. 2시간 실행과 1시간+저장·복원+1시간의 최종 보고서가 같다. 실제 `ScenarioRuntime.save()`/`load()`로도 같은 보고서를 얻는다. 카운터는 기존 저장(`stationDemandAllocationCursors`) 안에 들어가므로 별도 저장 코드가 없고, 옛 저장본은 `outcomes` 없이 복원되어 위 `exact: false`로 정직하게 보고된다.

## Codex 연결 방법

```js
runtime.stationDemandAllocationDiagnostics();          // 보고서 (복사본)
runtime.report().stationDemandAllocationDiagnostics;   // 같은 값
```

- `main.mjs`/UI는 수정하지 않았다. 화면에 보이려면 위 값을 읽기만 하면 된다. 추천: 역할별 `slots`(설정 비율 vs 실제 선택 수), `trips.unroutedByReason`, `limits[].status !== "none"`인 항목의 `text`, `status`가 `stale`일 때 경고.
- 선택 수는 게임이 진행되면 계속 바뀌므로 화면은 틱마다(또는 패널을 볼 때) 다시 읽어야 한다. 보고서 계산은 분할 노드 수에 비례하고 상태를 바꾸지 않는다. `report()`에도 들어 있으므로 `report()`를 자주 부르는 곳이 있으면 그 비용에 포함된다.
- M3 정책 패널의 "적용된 배분" 영역에 붙이면 자연스럽다(`application`과 `totals`부터).

## 한계

- 사유별 집계는 **E6 이후** 선택부터다. 그 전 저장본은 선택 수만 있다(`coverage`가 `none`/`partial`).
- 미배정 몫의 **구성**(정책이 비움 / 적용 때 막힘 / 적용 뒤 무효)은 설정 수준이다. 아무 역도 아닌 몫을 뽑은 개별 선택이 그중 무엇 때문인지는 알 수 없고 구성 비율만 보인다.
- `routed`는 "대중교통 경로가 있었다"까지다. 그 승객이 실제로 대중교통을 탔는지는 교통수단 선택(난수 사용)에 달려 있고 여기서는 보지 않는다.
- E5의 난수 결합 한계는 **없애지 않고 드러내기만** 한다. `observed`/`latent`는 가능성과 규모를 말하며, 100% 배정 실행과의 발생 수 차이를 직접 재지는 않는다.
- 선택 수는 호출 순서에 묶인다(같은 시드·같은 호출 순서면 같다). 게임 시작부터의 누적이 아니라 링크를 마지막으로 바꾼 시점부터다.
- 실제 도쿄 팩에서는 수요 노드가 시구 중심점이라 정책이 배분을 허용하지 않으므로 이 보고서는 `no-allocation`이다. 분할 시험은 합성 세계에서만 했다.
