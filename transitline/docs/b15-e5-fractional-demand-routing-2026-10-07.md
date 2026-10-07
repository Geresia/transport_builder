# B15-E5 — fixed-shares를 실제 승객 접근 경로에 적용

기준 커밋 `4a11e8b`, 브랜치 `b15-e5-fractional-demand-routing`. B15-E4가 "비율이 1이 아닌 배정을 거부"하던 한계를 없앤다. **발생량(rate)과 목적지 선택은 바꾸지 않고, 한 노드의 승객이 어느 접근 역으로 나가는지만** 정책의 비율대로 정한다.

## 무엇이 바뀌었나

| 파일 | 변경 |
|---|---|
| `engine/src/access-demand.mjs` | 링크의 `share`를 읽어 분할 노드를 만들고, 결정론적 일정(schedule)으로 역을 고른다 |
| `engine/src/passengers.mjs` | `resolveTrip`이 `{ unrouted: true }`를 주면 레거시 경로로 되돌리지 않고 경로 없음으로 처리한다 (분기 한 줄) |
| `engine/src/state.mjs` | 링크를 교체하면 분할 일정의 카운트도 지운다 (`replaceStationDemandAllocationLinks`) |
| `engine/src/station-demand-allocation-integration.mjs` | 분수 배정을 막던 코드와 `apply`의 예외를 없애고, 링크에 실제 `share`를 싣고, `splitNodes` 요약을 추가한다 |
| `engine/test/station-demand-fractional-routing.test.mjs` | 새 테스트 30개 |
| `engine/test/helpers/legacy-access-demand.mjs` | B15-E4 시점의 `access-demand.mjs` 동결 사본 (동치 비교용, 테스트 전용) |

`management/**`, `main.mjs`, `index.html`, `style.css`, `demand-engine.mjs`, `scenario-runtime.mjs`, 지도 코드는 건드리지 않았다. 기존 800 m·계획 링크 원본(`state.accessLinks`)은 수정하지 않는다.

## 분할 선택 알고리즘

노드별·역할별(`origin` / `destination`)로 따로, **난수 없이** 정한다.

1. 노드의 유효한 배분 링크(역이 있고, `walkMinutes > 0`, `0 < share ≤ 1`)를 모은다. 링크가 **하나뿐이고 `share`가 1**이면 분할이 아니다 → 기존 동작 그대로(일정도 만들지 않는다).
2. 그 밖은 분할 노드다. 같은 역의 링크는 합친다(비율 합, 짧은 걸음). 슬롯은 역 ID 순이고, 비율은 **백만분율 정수**(`round(share × 1e6)`)로 둔다. `1 − Σ비율`이 남으면 **"아무 역도 아님" 슬롯**(`""`)이 하나 더 생긴다. 이것이 배분되지 않은 나머지(또는 막히거나 사라진 역의 몫)다.
3. 승객 경로를 정할 때마다(`resolveTrip` 호출마다) 그 노드·역할의 카운트 `total`을 1 올리고, 슬롯별 **부족분** `micro × total − taken × 1e6` 이 가장 큰 슬롯을 고른다(동률이면 앞선 슬롯 = 낮은 역 ID). 정수 계산만 쓴다.
4. 이렇게 하면 `n`번째까지 각 슬롯이 `n × 비율`과 1건 이내로 맞는다: 60/40이면 `A B A B A | A B A B A …`, 25/75면 4건마다 정확히 1건.
5. 뽑힌 슬롯이 역이면 그 한 역(과 그 링크의 걸음)만 후보가 되고, 반대편 후보와 가장 빠른 경로를 고르는 기존 루프를 그대로 쓴다. "아무 역도 아님"이면 그 승객은 **경로 없음**이다.
6. 출발 노드와 도착 노드가 모두 분할이면 각자의 일정을 독립으로 진행한다(한쪽이 경로 없음이어도 다른 쪽 카운트는 올라간다).
7. 뽑힌 역에서 상대편으로 가는 경로가 없으면 **다른 역으로 바꾸지 않고** 경로 없음이다(비율을 무시하고 가까운 역으로 몰아주지 않는다).

RNG(`state.rng`)는 읽지도 쓰지도 않는다. `Math.random`, 시계, 경영 상태도 쓰지 않는다(테스트가 소스와 `rng.snapshot()`을 확인).

## 경로 없음 (unrouted)

`resolveTrip`이 `{ unrouted: true, route: null, … }`을 주면 `spawnPassengers`는 레거시 `findRoute`로 되돌아가지 않는다. 이 승객은 `stats.spawned`에는 세어지고(발생량은 그대로) 교통수단 선택에서 대중교통 후보가 없어 걷기·자동차가 되며, `state.passengers`에는 들어가지 않는다. **배분되지 않은 몫이 레거시 접근으로 몰래 가지 않는다**는 요구를 이렇게 지킨다.

## 저장 필드

| 필드 | 내용 |
|---|---|
| `stationDemandAllocationLinks[].share` | 링크가 가진 노드의 몫. 분수 배정의 비율(예: 0.6). E4까지의 저장본은 `1`이거나 필드가 없고, 없으면 1로 읽는다 |
| `stationDemandAllocationApplication.splitNodes[]` | 적용 시 요약 `{ demandNodeId, shares: [{ stationId, share }], unroutedShare }` (보고용, 라우터는 링크에서 다시 계산한다) |
| `stationDemandAllocationCursors` | **처음 분할이 쓰일 때 생기는** 일정의 카운트. `{ "<role>\|<nodeId>": { signature, total, taken: { "<stationId>": n, "": n } } }` |

`stationDemandAllocationCursors`는 `createState`에 넣지 않았다. 분할을 한 번도 쓰지 않은 상태는 이 키가 없고, 저장 바이트가 예전과 같다. 일반 `snapshotOperationalState`가 열거 가능한 필드를 저장하므로 별도 저장 코드는 없다. 복원 후 다음 승객의 선택은 이어서 같다(테스트). `signature`(슬롯과 비율)가 바뀌면 그 노드의 카운트는 0에서 다시 시작하고, 링크를 교체(적용·제거)하면 카운트 전체를 지운다.

## 기존 동작 보존 증거

- 정책·링크가 없으면 `access`, `splits`, 일정, 커서 모두 비어 있고 `resolveTrip`의 코드 경로는 E4와 같다. **동결 사본(E4)과 신규 모델이 모든 노드 쌍에서 같은 답**을 낸다(테스트, 레거시 전용 노선이 있는 세계와 없는 세계).
- 100% 링크(`share: 1` 또는 `share` 없음)도 모든 쌍에서 E4와 같은 답이고 커서가 생기지 않는다.
- **3시간 시뮬레이션을 새 모델과 E4 사본으로 각각 돌려 `snapshotOperationalState` JSON 바이트가 같고 `rng.snapshot()`도 같다**(정책 없음, 100% 링크 두 경우).
- 모든 트립이 경로를 가지는 60/40 분할은 `stats.spawned`, `spawnedByHour`, 난수 소비 수, 목적지 선택이 100% 단일 역 실행과 같다.
- 링크를 제거(`replace([])`)하면 그 노드는 한 번도 정책이 없던 상태와 같은 선택으로 돌아온다.

## 테스트

새 테스트 30개(`station-demand-fractional-routing.test.mjs`): 60/40, 25/75, 10/20/70의 정확한 비율과 순서, 100% 링크 불변, 배분되지 않은 나머지(0.5+0.2)가 레거시 경로로 가지 않음, 일부 링크만 쓸 수 있을 때, 모든 링크가 쓸 수 없을 때 E4 동작, 뽑힌 역에 경로가 없을 때, 출발·도착 동시 분할, 같은 노드의 두 역할 분리, RNG·시계 미사용, 저장·복원 후 같은 선택, 비율 변경 시 재시작·링크 교체 시 삭제, 링크 제거 시 레거시 복귀, 동결 사본과의 동치(모든 쌍·100%·3시간 바이트 동일), 분할이 발생량과 난수 소비를 바꾸지 않음, 분할 시뮬레이션의 결정성과 중간 저장, 경로 없음이 승객을 만들지 않음, 실제 적용 경로(두 링크와 `splitNodes`, 나머지 미배정, 역 미완공 시 차단 후 한쪽만 적용, stale·거절·무정책·미상 정책은 링크 없음과 상태 불변, 지도 변경 후 stale에서도 링크와 일정 유지), 100%만 있는 정책의 E4 동치, 저장·복원 동일성, 입력 불변·미리보기 무변경, 금지 임포트·API 검사.

## 알려진 한계

- **난수 흐름과의 결합.** 분할 자체는 난수를 쓰지 않지만, 경로가 없는 승객은 교통수단 선택에서 난수를 1개 덜 쓴다(원래 경로 없는 승객이 그렇다). 그래서 **배분되지 않은 몫이 있거나 출발·도착 역이 같아지는 분할**에서는 이후 난수 흐름이 달라져 실현된 발생 수가 100% 배정 실행과 달라질 수 있다. 기대 발생량(`model.rate`)과 목적지 선택 규칙은 그대로다. 모든 승객이 경로를 가지는 분할에서는 발생 수와 시간대 분포까지 같다(테스트).
- **같은 역이 출발과 도착이 되는 승객.** 도착 노드의 뽑힌 역이 출발 역과 같으면 대중교통 경로가 없고(`hops` 0) 그 승객은 경로 없음이다. 접근권이 겹치는 역에서 자연스럽게 생기며, 분할 비율을 지키려는 대가다(다른 역으로 바꾸지 않는다).
- **쓸 수 있는 링크가 하나도 없는 노드는 기존 접근으로 돌아간다**(E4와 같음). 분할 정책의 일부 몫만 막힌 노드는 막힌 몫이 경로 없음이 되지만, 전부 막힌 노드는 정책이 없는 것과 같다. 막힌 이유는 `blockedLinks`에 남는다.
- 일정은 노드·역할별 호출 순서에 묶인다. 같은 시드·같은 호출 순서면 같은 선택이다(시뮬레이션 속도가 호출 순서를 바꾸지 않는다).
- 분할 비율은 접근 역을 정하는 것이지 역 용량·혼잡·운임을 정하지 않는다. 걸음 시간은 링크의 `walkMinutes`(적용 시점에 보행 모델이 계산한 값)다.
- 정책을 다시 적용하면 카운트가 0에서 다시 시작한다(적용마다 링크를 교체하므로).
- 실제 도쿄 팩에서는 수요 노드가 시구 중심점이라 정책이 배분을 허용하지 않아 이 경로가 쓰이지 않는다. 합성 세계에서만 확인했다.

## Codex 연결

- 새 명령은 없다. `ScenarioRuntime.applyStationDemandAllocation({ policy, walkingPolicy })`가 이제 `fixed-shares` 정책을 거부하지 않고 적용한다. `stationDemandAllocationReport()`와 미리보기에 `splitNodes`가 더해진다.
- 화면에서 비율 배정을 보여 주려면 보고서의 `splitNodes[].shares`와 `unroutedShare`, `blockedLinks`를 읽으면 된다.
- 적용 후 지도 export가 바뀌면 E4와 같이 `stale`로 표시되고 링크·일정은 그대로 유지된다. 다시 적용해야 갱신된다.
