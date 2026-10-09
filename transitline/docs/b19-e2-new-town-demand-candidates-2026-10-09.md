# B19-E2 신도시 수요 후보 브리지

`engine/src/new-town-demand-candidates.mjs` (+ `engine/test/new-town-demand-candidates.test.mjs` 13개). 기준 master `e6275af`.

B19-E1 생애주기의 `newTownDevelopmentHooks(id)`와 B19-M1 geometry(개발 한 건, 또는 export 전체)를 **읽기만 해서**, "이 단계에 플레이어가 명시한 입주 사실이 있다"는 **수요 후보 계약**을 만드는 순수 함수다. B15 수요 모델이 나중에 읽는다. 아무것도 import하지 않고, B15 state·수요 노드를 바꾸지 않으며, 기존 노드를 대체하거나 합치지 않는다.

```js
import { buildNewTownDemandCandidates } from "./new-town-demand-candidates.mjs";
const result = buildNewTownDemandCandidates({
  hooks,      // ManagementGame / ScenarioRuntime 의 newTownDevelopmentHooks(id)
  geometry,   // M1 development 하나 또는 buildNewTownDevelopmentExport 결과 전체 (없으면 null)
});
```

`hooks`가 E1 hooks가 아니면 던진다. `geometry`가 없거나 틀린 것은 던지지 않고 **보고**한다(아래 상태).

## 하지 않는 것

주택 면적·용도·공급량(`statedSupply`)에서 인구·직장 수를 만들지 않는다. 입주율, 수요, 통행, 승객, 운임, 혼잡, 비용, 점수, 확률을 계산하지 않는다. "occupied"라는 상태만으로 residents/jobs를 만들지 않는다. 플레이어가 준 숫자는 **복사만** 하고 더하거나 고르거나 합치지 않는다. 출력 키 이름에 그런 낱말이 없고(테스트), 소스에 산술·`Math`·`reduce`가 없다.

## 명시 수요 사실의 입력 문법

E1을 바꾸지 않으므로 입력은 E1의 **입주 사실**(`recordNewTownOccupancy(id, phaseId, facts, …)`)이다.

```js
game.recordNewTownOccupancy(id, phaseId, { statedOccupiedUnits: 120, unit: "residents", source: "player-stated", note: "…" }, { geometry });
```

| 조건 | 결과 |
|---|---|
| `unit`이 정확히 `"residents"` 또는 `"jobs"` (`STATED_DEMAND_KINDS`) **이고** `statedOccupiedUnits`가 0 이상 정수 | 명시 수요 사실. `kind = unit`, `quantity = statedOccupiedUnits` 그대로 (**0도 명시된 0**) |
| `unit` 없음 | 제외, 이유 `occupancy-unit-not-stated` |
| `unit`이 다른 낱말(`housing-units`, 대소문자 다른 `Residents` 등) | 제외, `occupancy-unit-not-a-demand-kind:<unit>` |
| `statedOccupiedUnits`가 null/없음 (`statedPlannedUnits`만 있음) | 제외, `occupancy-fact-states-no-occupied-quantity` |
| 음수·소수 | 제외, `occupancy-quantity-invalid` |

- 한 단계에 사실이 여러 개면 **순서대로 모두** 나열한다. 최신을 고르거나 합산하지 않는다(같은 kind가 둘 이상이면 경고 `several-stated-facts-for-one-kind-not-merged`).
- 제외된 사실은 `warnings`의 `occupancy-facts-without-a-demand-kind`(factIds, reasons)에 남고, `occupancyFactIds`에는 계속 들어 있다.
- 쓸 수 있는 사실이 하나도 없으면 후보는 **유지**하고 `statedDemandFacts: null` + `unknownReasons.statedDemandFacts`(`no-occupancy-fact-states-a-demand-kind`).
- 입주 사실이 하나도 없는 단계는 후보가 없고 `phasesWithoutCandidate`에 나온다.

## 계약 필드 (B15가 읽을 표)

### 최상위 `transitline.new-town-demand-candidates/1` (`contractVersion: 1`)

| 필드 | 값 | 미상일 때 |
|---|---|---|
| `developmentId` | M1 개발 ID (hooks) | |
| `developmentRevision` | hooks가 기억한 revision | null + `unknown` |
| `sourcePackId`, `sourcePackVersion` | hooks의 `sourcePack` | 구저장본이면 둘 다 null, `unknownReasons`=`lifecycle-source-pack-unknown`. 버전만 없으면 `not-stated` |
| `lifecycleStatus` | E1 개발 상태 (`draft…cancelled`) | |
| `geometryStatus` | `{status, reasons}` — 아래 geometry 상태 | |
| `candidates[]` | 아래 | `sequence`, `phaseId` 순 |
| `phasesWithoutCandidate[]` | `{phaseId, phaseLifecycleStatus, reason: "no-occupancy-fact"}` | |
| `unknown[]`, `unknownReasons{}` | 필드 이름 / 이유 (M1과 같은 형식) | |
| `warnings[]` | `development-delayed`, `development-cancelled` | |
| `sourceReferences` | `lifecycle: {schema, developmentHookId, transitionIds[]}`, `geometry: {schema, developmentId, developmentRevision, sourcePackId, sourcePackVersion}` 또는 null(개발 건이 아예 없을 때) | |
| `notComputed[]` | 계산하지 않는 것의 목록 | |

### candidate

| 필드 | 값 | 비고 |
|---|---|---|
| `candidateId` | `new-town-demand-candidate:<developmentId>:<phaseId>` | 결정적. 다시 그려 revision이 바뀌어도 불변 |
| `developmentId`, `phaseId` | | |
| `phaseRevision` | M1 `phaseRevision` 또는 null | geometry가 그 단계를 알 때 |
| `lifecycleHookId` | E1 `hookId` (`<기록 id>:phase:<phaseId>`) | |
| `sequence` | E1 단계 순서 | |
| `geometryStatus` | `{status, reasons}` | `current` `stale` `inactive` `other-pack` `pack-unknown` `missing` `invalid` |
| `recordedGeometryStatus` | E1이 마지막으로 받아들인 geometry 상태 | 참고용 |
| `lifecycleStatus`, `phaseLifecycleStatus` | 개발 상태 / 단계 상태 | `delayed`는 숨기지 않고 그대로 |
| `state` | `{stale, inactive, otherPack, cancelled, delayed}` 모두 true/false | false는 측정된 "아님" |
| `playerDeclaredLandUse` | 플레이어의 말 그대로 / null(`unknownReasons`=`not-stated`) | |
| `location` | `[lon, lat]` 또는 null | **현재(current) geometry의 단계 위치**만. 아니면 null + `geometry-<상태>` 또는 M1의 이유 |
| `statedDemandFacts` | `[{factId, sequence, recordedAtMinute, kind, quantity, source, note}]` 또는 null | 위 문법. `[]`는 내지 않는다 |
| `occupancyFactIds` | E1 입주 사실 ID 전부 | |
| `demandNodeRefsInside` | M1 공간 사실의 노드 **ID**만 / `[]`(기록된 노드가 안에 없음 — 수요 0이 아님) / null(알 수 없음 + 이유) | 값(residents/jobs)은 복사하지 않는다 |
| `inputCompleteness` | `{status: complete/incomplete/blocked, blockers[], missing[]}` | 규칙 판정이 아니라 입력 상태 |
| `eligibleForB15` | `true`(complete) / `false`(blocked) / `null`(incomplete) | 아래 |
| `unknown[]`, `unknownReasons{}`, `warnings[]` | | |
| `basis` | `{derivation: "copied-as-stated", statedBy: "player", lifecycleSchema, geometryDevelopmentRevision}` | |

### geometry 상태

| 상태 | 뜻 | `eligibleForB15` |
|---|---|---|
| `current` | 같은 개발·팩·revision이고 활성, 단계도 활성이며 land use 같음 | (아래 완전성에 따름) |
| `stale` | 다른 개발, revision/팩 버전 변경, 단계가 geometry에 없음, land use 변경 | **false** (`geometry-stale`) |
| `other-pack` | `sourcePackId`가 기록과 다름 | **false** |
| `inactive` | 개발 또는 단계가 꺼져 있음 | **false** |
| `missing` / `invalid` | geometry 없음·읽을 수 없음(`sourcePackId` 없음, `active` 미상 등) | **null** (`geometry-missing`/`-invalid`) |
| `pack-unknown` | 생애주기 기록에 팩 정보가 없음(구저장본) — 현재 팩이라고 추정하지 않음 | **null** |

그 밖에 생애주기 `cancelled`(개발 또는 단계)는 **false**. 막힘(blocked)이 있으면 항상 false가 우선이다. 막힘이 없으면 `statedDemandFacts`와 `location`이 모두 있을 때만 `complete`(true), 하나라도 없으면 `incomplete`(null).

## 아직 하지 않은 것 (경계)

- 실제 수요 배분, 노드 생성·대체·병합, 거주자·직장 환산, 승객·통행·운임·혼잡 생성은 하지 않는다 — B15가 이 후보를 읽어 **자기 규칙으로** 결정한다. 이 계약은 "플레이어가 무엇을 명시했고, 어디이며, 입력이 온전한가"까지만 말한다.
- 후보를 B15 state에 쓰는 코드, UI, `main.mjs` 연결은 없다.
- 여러 사실 중 무엇을 쓸지(최신/합계/평균)는 정하지 않았다. 그 선택은 B15의 몫이고, 그래서 모두 나열한다.
- `statedSupply`(공급량)와 `statedPlannedUnits`는 수요로 읽지 않는다.
- E1이 입주 사실에 `residents`/`jobs` 전용 필드를 갖고 있지 않아 `unit` 낱말로 종류를 표시한다. 전용 필드가 필요하면 E1 쪽 변경이 따로 필요하다.

## 검증

13개: 실제 `ManagementGame`(E1)과 실제 M1 예제 geometry로 만든 hooks 연결, 명시값 없는 occupied가 인구가 되지 않음(4가지 입력과 각각의 이유), 0/null/[]/false 구분, 사실 비합산, stale·inactive·다른 팩·팩 버전·다른 개발·단계 부재·land use 변경·cancelled 차단, geometry 없음·틀림(11가지)·팩 정보 없는 생애주기는 null, delayed 유지, export 전체 입력, 결정성(단계 순서 뒤집기 포함)과 revision 변경 시 ID 불변, 얼린 입력 불변·출력 비공유·생애주기 snapshot 불변, 잘못된 hooks 거부, 금지 낱말 키 없음, 소스 검사(import·B15/management/엔진·시계·난수·저장소·산술 없음).

변이 확인 8개(널을 0으로, 아무 단위나 수요로, 다른 팩 통과, cancelled 미차단, 미상 geometry를 완전으로, 0을 미상으로, 낡은 revision 통과, delayed 숨김) — 각각 테스트가 실패하는 것을 확인하고 되돌렸다. 첫 변이는 이유 문자열만 달라져 처음엔 살아남았고, 이유를 단언하도록 테스트를 보강한 뒤 잡혔다.
