# B20-D0 광역 성장·30년 캠페인 연결 감사

기준은 master `4884f24`(B19-M1~M4, E1~E4 포함). **코드 수정 없음, 문서만.** B19-E4(승인 기록)는 이 문서를 쓰는 도중 병합되어 §2.4에 **실제 계약**을 적었다. B19-E5(명시 수요 원천)는 아직 master에 없으므로 그 계약은 가정하지 않고 B20이 요구하는 것만 적는다(§2, §9).

읽은 것: `scenario-runtime.mjs`(report / save / load / `settleOperatingDays`), `integrated-save.mjs`, `management/{core,game,integration,operating-economy,railway-timetable,scenarios}.mjs`, `state.mjs`, `simulation.mjs`, `loop.mjs`, `demand-engine.mjs`, `passengers.mjs`, `railway-traffic-control.mjs`, `main.mjs`(수요 모델 생성부), 문서 B12-B20 로드맵·B15-E4·B17-E2·B18-E3·B19 설계 메모와 E1~E3·M1~M4.
직접 측정한 것(합성, 같은 기계, 아래 §4·§7에 표시): 운영 시뮬레이션 1시간 비용, `transact` 비용 대 원장·이벤트 크기.

## 0. 한눈에

1. **재사용할 시간 축은 둘뿐이다**: 경영 시계 `game.clock.minute`(30일 = 1개월)와 운영 시계 `operationalState.simMinutes`(1초 스텝, 운영일 = 1440분). B20은 **세 번째 시계를 만들지 않는다.**
2. **"연도"는 기존 코드에 없다.** 개월(30일)만 있다. 캠페인 연도를 **12개월 = 360일**로 못 박는 것이 새 축을 만들지 않는 유일한 길이다(결정 D-2). 30년 = 360개월 = 10,800일.
3. **B15는 `state.demandNodes`를 한 번 읽어 수요 모델을 만들고 끝난다**(`main.mjs:437`, O(노드²) 가중치 선계산). 노드를 나중에 바꿔도 승객 발생에는 반영되지 않는다. 그래서 B19/B20은 **`demandNodes`에 직접 쓰지 않고**, 적용은 호스트가 소유한 명시적 단계(노드 추가 + 모델 재생성)로만 한다(§2). 이 단계는 지금 **존재하지 않는다**(결정 D-3).
4. **가장 큰 열린 문제는 운영 정산이다.** 일일 정산(`settleIntegratedServiceDay`)은 **시뮬레이션 일수**로만 일어난다. 운임 수입은 시뮬레이션이 실제로 태운 승객에서만 생기고, 고정비·공적 지급은 경과 운영일에 비례한다. 즉 시뮬레이션을 돌리지 않으면 그 기간은 **정산 자체가 없고**, 일수 카운터만 앞당기면 고정비·공적 지급만 정산되고 운임은 0이다. 일 단위 시뮬레이션을 30년 돌리는 것은 빈 노선으로도 최소 약 2시간, 실제 망에서는 훨씬 더 걸린다(§4). **결정이 필요하다(D-1).**
5. **이력을 새로 만들지 않는다.** 투자·개통·분담금·수요 원천·시간표 이력은 이미 각자 소유자가 있다. B20은 `{종류, ID, revision}` 참조와 선언 시점의 상태 문자열만 저장하고, 금액·수량은 읽을 때 소유자에게서 읽는다(§3).
6. **`null` = 모름, `0` = 명시된 0, `false` = 명시된 아님, `[]` = 명시된 없음.** B19와 같다(§5).
7. **30년 저장의 실제 위험**: 원장·이벤트 증가에 따른 `transact` 비용(0.5초/건 수준), 일 단위 통계의 무한 증가, `ManagementGame.save()`의 `savedAt` 시각(바이트 비결정), 플로트 시각 누적, 구저장본 이월(§7).
8. **개별 시민 시뮬레이션은 필요 없고 해서도 안 된다**(§8).

## 1. 재사용할 시간 축과 저장 필드

### 1.1 두 개의 시계

| | 경영 시계 | 운영 시계 |
|---|---|---|
| 위치 | `ManagementGame.clock` (`SimulationClock`) | `operationalState.simMinutes` |
| 단위 | 분. `day = floor(minute / 1440) + 1`, 월 = `floor(minute / (30 × 1440))` (`MONTH_MINUTES`) | 분(소수). 운영일 = `floor(simMinutes / 1440)`, **시작 06:00(360분)** |
| 전진 | `clock.advance(분)`, `advanceMonth()`(30일), `settleOperatingDays()`가 운영일에 맞춰 전진 | `advanceSimulation(...)` — **1초 고정 스텝**, UI 속도 120 sim초/실초(`loop.mjs`) |
| 저장 | `snapshot().clock = {minute, queue, nextEventId}` | `snapshotOperationalState` — `simMinutes` 포함 |
| 쓰는 곳 | 원장 `atMinute`, 이벤트 로그, B19 전이 `atMinute`, 월 정산, 건설 월 진행 | 승객 발생, 열차 배차, 시간표(B17), 운영 캘린더(B18) |

### 1.2 둘을 잇는 곳

- 서비스에 `operationsStartedAtGameMinute` / `operationsStartedAtSimMinute`(`scenario-runtime.mjs:843-844`)와 `engineCursor.day`(마지막으로 정산한 운영일)가 있다.
- `ScenarioRuntime.settleOperatingDays()`가 "운영일이 지났는데 정산 안 된 서비스"를 찾아 경영 시계를 **운영 시계가 간 만큼** 앞으로 보낸 뒤 `settleIntegratedServiceDay`를 부른다. 즉 **운영 일수가 경영 시간을 끌고 간다.** 경영 시계 혼자 `advanceMonth()`로도 갈 수 있다(건설·금융·정비·가격).
- 구조적 결론: B20은 둘 중 어느 쪽도 바꾸지 않고, **둘 다 읽기만** 한다. 마일스톤 시각은 경영 시계의 **개월 번호**로 적는다(운영일 번호가 필요하면 `floor(minute / 1440)`로 같은 시계에서 구한다).

### 1.3 "연도" (결정 D-2)

기존 코드에 연도가 없다. 월은 항상 30일이고 `corporateFinancialStatements`, 건설 가격, `operatingMonthReports`가 모두 `floor(minute / MONTH_MINUTES)`를 쓴다. 따라서 **캠페인 연도 = 12개월 = 360일, 분기 = 3개월**로 정의한다(파생 표시일 뿐 저장하지 않는다). 현실 달력의 365일 연도를 쓰면 월 축과 어긋나므로 쓰지 않는다. (참고: 일일 정산 일부가 `annualX / 365 × days`를 쓰지만 이는 비용 환산 상수이지 달력이 아니다.)

### 1.4 저장 필드 (B20이 의존하는 것)

통합 저장(`saveIntegratedGame`) = `{schemaVersion: 1, packId, packVersion, management: game.snapshot(), operations: snapshotOperationalState}`. `packId`·`packVersion`이 다르면 불러오기를 거절한다.

| 영역 | 필드 | B20의 쓰임 |
|---|---|---|
| 경영 | `clock.{minute,queue,nextEventId}` | 읽기. **`queue`는 쓰지 않는다**(§4.1) |
| 경영 | `ledger.{openingCash,entries[],commitments[]}`, `events.entries[]` | 읽기(참조 ID만). 추가는 기존 단계가 한다 |
| 경영 | `operatingMonthReports[]`(월×서비스), `constructionFinancing`, `projects`, `schedules`, `services`, `railwayTimetables`, `newTownDevelopments`, `newTownRailContributions` + `next*Sequence` 카운터들 | 읽기(참조) |
| 운영 | `simMinutes`, `operationalCalendar.dayTypesByOperatingDay`(희소 맵), `demandNodes`, `accessLinks`, `stationDemandAllocationLinks`/`…Version`, `stats.railwayTrafficByLine[line].days`, `lines`, `trains`, `passengers`, `rngState` | 읽기. **`demandNodes`·링크 쓰기 금지**(§2) |
| 신규 | `campaignPrograms[]` + `nextCampaignProgramSequence` (E1) | B20만 쓴다. 항상 존재하는 빈 기본값(B19와 같은 구저장본 규칙) |

## 2. B19 신도시 수요 원천이 B15에 적용되는 정확한 경계

### 2.1 사슬과 소유

| 단계 | 소유 | 무엇을 만든다 | 승인/적용 |
|---|---|---|---|
| B19-E1 | 경영 | 개발 생애주기, 플레이어가 명시한 입주 사실 | — |
| B19-E2 | 순수 브리지(master) | **후보** `new-town-demand-candidates/1` (`eligibleForB15`는 입력 완전성 상태일 뿐) | 승인 아님 |
| B19-E4 *(병합됨)* | 경영 | **승인 기록** `new-town-demand-intake:N` — 저장 상태 accepted / held / rejected / revoked, `pending`·`stale`은 입력에서 계산, 플레이어가 고른 factId | 승인은 사람 |
| B19-E5 *(미병합)* | 브리지 | accepted 기록만 **"명시 수요 원천"** 계약으로 복사 | 적용 아님 |
| B20-E2 | 경영(캠페인) | 마일스톤이 **어떤 승인된 원천을 활성화 대상으로 지정했다**는 기록 | 적용 아님 |
| **B15 적용 단계** | **호스트(Codex) + B15 모듈** | 노드 추가 + 모델 재생성 + 접근 배분 승인 | **미구현** |

### 2.2 B15가 실제로 읽는 것 (코드 사실)

- `state.demandNodes`: `Map<id, {id, name, location, residents, jobs, kind}>`. `createState(pack)`가 팩의 `demand.points`에서 만든다. **런타임에 이를 바꾸는 API가 없다.**
- gravity 모델은 `buildDemandModel`에서 **한 번** 만들어지고 `main.mjs:437`에서 마운트 때 고정된다. 가중치 표는 노드 쌍마다 미리 계산한다(O(N²)). 노드를 나중에 고치면 승객 발생은 그대로다. → 적용에는 **모델 재생성**이 따라야 하고, 이는 호스트 소관이다.
- 팩의 모델이 `matrix`(예: `example-corridor`)이면 발생량은 `flows`에서 오고 `residents/jobs`는 쓰지 않는다. **residents/jobs 명시 원천은 matrix 팩에 효과가 없다** → B20-E2/E5는 matrix 팩을 `unsupported`로 보고해야 한다(Tokyo·radial은 gravity).
- 측정된 O/D 행이 없는 노드는 gravity 발생량을 유지한다(`buildDemandModel`). 새 노드가 자동으로 O/D를 얻는 일은 없다.
- 역 접근은 별도: `accessLinks`(계획선 기하), `stationDemandAllocationLinks`(B15-E4 승인 배분). 새 노드가 역에 닿으려면 **B15-M2 접근 평가 → 플레이어 승인 배분**을 거친다. B19/B20이 만들거나 바꾸지 않는다.

### 2.3 B20이 지키는 규칙

1. B19/B20 코드는 **`demandNodes`, `accessLinks`, `stationDemandAllocationLinks`에 쓰지 않는다.** 기존 노드를 덮어쓰거나 합치지 않는다.
2. 활성화 기록(B20-E2)은 **E4가 accepted로 둔 원천의 참조**(`intakeId`, `demandSourceId`)와 그 revision 튜플만 갖는다. 승인을 새로 만들지 않는다.
3. 참조한 원천·후보·intake·geometry·lifecycle 중 revision이 하나라도 달라지면 활성화는 `stale`(적용 금지)이다. 자동 복구 없음, 재승인은 E4에서 새 intake로.
4. 수량을 합산·환산·비율화하지 않는다. 여러 fact는 나열한다. (B19-E2와 같다.)
5. 적용 단계(§2.1 마지막 줄)는 B20의 범위가 아니다. B20-E2의 출력은 "적용 대기열이 아니라 **적용 가능 여부의 사실 목록**"까지다.

### 2.4 E4의 실제 계약과 E5에 요구하는 것

**E4(병합됨, `docs/b19-e4-new-town-demand-intake-2026-10-09.md`)가 이미 주는 것 — B20 요구를 충족한다:**

- **안정 ID**: `id: "new-town-demand-intake:N"`(재사용 없음), `developmentRecordId`, `developmentId`, `candidateId`, `phaseId`, `lifecycleHookId`, 이력 `decisionId`(`<id>:decision:N`).
- **승인 당시 튜플** `acceptance`: `{acceptedAtMinute, statedDemandFactIds, statedDemandFacts, occupancyFactIds, developmentRevision, phaseRevision, sourcePack, lifecycle{status, phaseStatus, transitionIds}}`. B20-E2의 `revisionTuple`은 이것을 **참조**하면 되고 복사본을 만들 필요가 없다.
- 저장 상태 `accepted / held / rejected / revoked`; `pending`·`stale`은 **현재 입력에서 계산**(`standing.currentStatus`)하고 저장하지 않는다. 승인은 자동으로 고쳐지거나 다시 승인되지 않는다.
- **읽기 시 확인**: `newTownDemandIntakeReport(id?, { geometry })`의 `standing.verification.status`가 `current / stale / unverified / not-applicable`. **`current`는 geometry를 넘겼을 때만** 나온다. geometry 없이 부르는 `report().newTownDemandIntakes`는 승인을 기껏해야 `unverified`로 보여 준다.

**B20이 조심할 점 (E4의 실제 동작에서):**

1. B20-E2/E3는 intake를 읽을 때 **geometry를 호출마다 넘겨야** 한다(E1·E3와 같은 방식). 안 넘기면 모든 승인이 `unverified`이므로 `applicable`을 `true`로 둘 수 없다.
2. **승인이 쉽게 `stale`이 된다**: 승인 뒤 E1 이력이 하나라도 늘면(`lifecycle-transitions-changed`, 같은 개발의 다른 단계 입주 기록도 포함) 모든 승인이 stale이다. 캠페인에서는 이것이 **정상 경로**이므로 B20은 stale을 오류로 던지지 말고 활성화를 `stale`로 표시하고 재결정을 기다린다.
3. 같은 후보에 다시 결정하면 **새 기록(새 id)**이 생기고 철회된 기록은 남는다. B20 참조는 `id`(기록) 단위이며 `candidateId`만으로 가리키지 않는다.
4. 같은 종류(residents/jobs)를 둘 이상 함께 고를 수 없다(합쳐질 위험). 활성화 기록은 이 선택을 그대로 둔다.

**E5(미병합)에 요구하는 것:**

- E4의 accepted·`current` 기록만 입력으로 받고, 위 `acceptance` 튜플을 복사한 `demandSourceId`와 `current/stale` 판정(읽기 전용)을 줄 것. 값(residents/jobs)은 사실 그대로(0 = 명시된 0), 합산·환산 없음.

## 3. 이미 있는 투자·개통·분담금 이력을 중복하지 않는 법

원칙: **B20은 참조를 저장하고 값은 읽을 때 소유자에게서 읽는다.** 저장하는 것은 (a) 프로그램·마일스톤이 그 대상을 가리켰다는 사실, (b) 마일스톤을 선언한 시점의 대상 **상태 문자열**(예: `released`, `active`, `accepted`)과 `atMinute`뿐이다. 금액·승객·수량의 복사본은 만들지 않는다.

| B20-E3가 보여 줄 사실 | 소유자·위치 | 식별자 | 읽는 방법 |
|---|---|---|---|
| 건설·투자 | `projects`, `schedules`, `constructionFinancing`, 원장 항목 | `project.id`, `financing.id`, `ledger.entries[].reference`·`category` | `runtime.report().projects/.constructionFinancing`, 원장은 reference로 검색 |
| 개통 | `services[]`(`status`, `operationsStartedAtGameMinute`) | `service.id` | `report().services` |
| 시간표 활성화 | `railwayTimetables[]`(`activatedAtMinute`, `approvedAtMinute`, `withdrawnAtMinute`) | `railway-timetable:N` | `report().railwayTimetables`, B17 `railwayTimetableOperationReport()`, B18 `operationalServiceCoverageReport` |
| 월별 운영 결과 | `operatingMonthReports`(월×서비스) | `serviceId` + `month` | `report().operatingMonths` — **이미 월 단위로 쌓인다** |
| 법인 재무 | 원장에서 파생 | 월 | `corporateFinancialStatements({fromMonth})` |
| 신도시 개발 | `newTownDevelopments[]` | `new-town-development:N`, 단계 hook `<id>:phase:<phaseId>` | `newTownDevelopmentReport/Hooks` |
| 철도 분담금 | `newTownRailContributions[]` | `new-town-rail-contribution:N`, `release.ledgerEntryId` | `newTownRailContributionReport/Hooks` (hooks의 `ledger: {entryId, amountYen}`) |
| 수요 원천 | E4/E5 | `intakeId`, `demandSourceId` | E5 보고 |
| B15 접근 배분 | `stationDemandAllocationLinks` | 링크 키 | `report().stationDemandAllocation` |

`ScenarioRuntime.report()`가 이미 이 읽기 표면이다. B20-E3은 **같은 보고를 조합할 뿐** 새 장부를 만들지 않는다. 월별 운영 결과가 이미 있으므로 "연도별 합계"를 저장하지 않는다(합계는 B20-E3 금지 목록: ROI·비용 합산·성공 판정).

## 4. 일 단위 반복 없이 연도/분기/마일스톤 단위로 처리하는 방법

### 4.1 캠페인 계층은 시간을 "진행시키지" 않는다

- 시간은 **호스트의 기존 루프**가 앞으로 보낸다(`advanceMonth()`, `settleOperatingDays()`). B20은 전진하지 않고 **현재 `clock.minute`를 읽어** 마일스톤의 **도래 여부(`due`)를 읽을 때 계산해 표시**한다.
- 마일스톤 **상태 전이는 항상 명시 행동**(플레이어/시나리오)이다. "목표 월을 지났다"는 전이를 일으키지 않는다. 지연(`delayed`)도 사람이 선언한다.
- `SimulationClock.queue`(예약 이벤트)는 쓰지 않는다. `clock.advance(minutes, dispatch)`는 `dispatch` 콜백을 넘기는 호출자만 실행하고, 큐는 저장·복원 대상이라 숨은 실행 경로가 된다. 캠페인 상태가 큐에 의존하면 저장·복원·롤백 증명이 어려워진다.

### 4.2 처리 단위

| 단위 | 정의 | 어디서 쓰나 |
|---|---|---|
| 개월 | `floor(minute / MONTH_MINUTES)` — 기존 | 마일스톤 `targetMonth`, 월 보고 |
| 분기 | 3개월 묶음 — 표시 전용 | E3 타임라인 묶기, 저장 안 함 |
| 캠페인 연도 | 12개월(360일) — 표시 전용 | E3·M3 |
| 마일스톤 | 플레이어가 적은 `targetMonth`(또는 기간) + 순번 | E1 상태 |

호스트가 30년을 도는 방법은 `advanceMonth()` 360회(건설·금융·정비·가격이 월 단위로 처리됨)와, 운영 쪽은 §4.4의 결정에 따른다. 캠페인 계층의 비용은 **마일스톤 수에 비례**하고 일수와 무관하다.

### 4.3 비용 예산

| 항목 | 값 | 근거 |
|---|---|---|
| 월 진행 호출 | 360회 / 30년 | `advanceMonth()`는 월마다 `transact` 1회 |
| `transact` 1회 비용 | 원장 1천건 6 ms, 2만건 99 ms, **10만건(+이벤트 10만) 487 ms** | 합성 측정(§7.2). `snapshot()` 전체 복제 + 불변식 검사 |
| 장기 후반 월 진행 | 건당 수백 ms → 360회 합계 분~십수 분 | 원장 규모에 따라 |
| 캠페인 전이 | 수십~수백 회 / 30년 | 마일스톤 수. 같은 `transact` 비용 |

### 4.4 **열린 문제: 운영 정산이 시뮬레이션 일수에 묶여 있다 (결정 D-1)**

사실(코드): `settleIntegratedServiceDay`는

- 운임 수입 = `deliveredAgents(커서 이후) × passengerWeight × 평균운임` — **시뮬레이션이 실제로 태운 승객**에서만 생긴다.
- 고정비·공적 지급·차량기지·접근료 등은 `days = simulationDay − cursor.day`에 **비례**한다. `simulationDay`는 `simMinutes`에서 온다.
- 경영 쪽 `advanceMonth()`는 건설·금융·정비·가격만 월 단위로 처리하고 **운영 정산을 하지 않는다.**
- 따라서 시뮬레이션을 돌리지 않으면 그 기간은 운영 정산이 **아예 없고**, 일수 카운터(`simMinutes`)만 시뮬레이션 없이 앞당기면 그 일수 × 고정비·공적 지급은 정산되지만 **운임은 0**이다.

일 단위 시뮬레이션 비용(합성 측정): 빈 노선(열차·승객 라우팅 없음, 31 노드)에서 **1시간 = 29 ms → 1일 ≈ 0.7초 → 30년(10,800일) ≈ 2.1시간.** 이는 **하한**이다(실제 망은 열차·승객·라우팅이 더해져 훨씬 느리다). 실시간 UI 속도(120 sim초/실초)로는 30년 = 90일이 걸린다.

선택지(결정은 사용자/Codex 몫이며 D0는 정하지 않는다):

| | 방안 | 장단점 |
|---|---|---|
| A | 렌더 없이 **빠른 일괄 시뮬레이션**으로 모든 날을 실제로 돌림(배치) | 기존 규칙 그대로·정확. 느림(시간~일 단위), 진행 중 상태 크기·원장 증가 큼 |
| B | **대표일 외삽**(몇 날만 돌려 나머지를 환산) | 빠름. 하지만 **새 추정 모델**이 되어 "자동 수요·비용 추정 금지" 규칙과 충돌 — 별도 승인 설계가 있어야 함 |
| C | 캠페인은 **구간별 실제 플레이 창**(예: 개통 전후 N일)만 시뮬레이션하고 나머지 기간은 **운영 정산을 하지 않고 "정산 안 됨"으로 표시** | 정직하나 장기 재무가 비어 있음, 장기 평가 불가 |

D0 권고: **A를 기본 경로로 두고(추정 없음), B는 별도 설계 승인 전에는 만들지 않는다.** B20-E1/E2/E3은 어느 방안이든 같게 동작하도록 시간 진행에 관여하지 않는다.

## 5. null / 0 / false / [] 의미 (B20 전용)

| 값 | 뜻 | 예 |
|---|---|---|
| `null` | **모름 / 명시되지 않음** | 마일스톤 `targetMonth: null` = 목표 월을 말하지 않음. 연결 geometry를 찾을 수 없음. 팩 정보 없음 |
| `0` | **명시된 0** | `durationMonths: 0`(당일 마감 선언), 분담 금액 0. 우선순위는 1 이상 정수 또는 `null`(0은 우선순위가 아님) |
| `false` | **측정/선언된 "아님"** | `delayed: false` = 지연 선언 없음. 알 수 없음이 아니다 |
| `[]` | **명시된 "없음"** | `linkedPlanIds: []` = 연결 계획이 없다고 말함. `null`이면 말하지 않음 |
| 정의 전 목록 | `null` | `milestones`가 아직 정의되지 않았으면 `null`, "마일스톤 없음"으로 명시했을 때만 `[]` |
| 결측 값 | 0·안전·통과로 바꾸지 않음 | E3 보고에서 원천이 없으면 `null` + 이유(`unknownReasons`), 합계에 0으로 넣지 않음 |

금지: `null`을 `0`/`[]`로, `false`를 `null`로, "원천 없음"을 "문제 없음"으로 바꾸는 모든 변환.

## 6. 최소 계약 필드

> M1·E1·E2·E3의 **최소 제안**이다. 이름은 구현자가 정하되 구분과 ID 규칙은 B19의 것을 따른다(결정적 ID, 삭제 key 재사용 금지, `unknown[]`/`unknownReasons{}`). 지도 계약(M1)은 **지도 ID**만, 경영 계약(E1~E3)은 **경영 ID**만 참조한다.

### 6.1 B20-M1 광역 개발 프로그램 지도 계약 (`…/1`, 순수 map 모듈)

| 필드 | 값 | 비고 |
|---|---|---|
| `schema`, `contractVersion` | | |
| `programId` | 팩 ID + `key`로 결정 | 이름·순서 변경에 불변 |
| `programRevision` | 연결·마일스톤 계획·정책이 바뀌면 바뀜 | 이름 제외 |
| `sourcePackId`, `sourcePackVersion` | | 다른 팩 거절 기준 |
| `key`, `name`, `active` | | |
| `milestones[]` | `{milestoneId(key로 결정), key, sequence, name, targetMonth: 정수\|null, durationMonths: 정수\|null, linkedDevelopmentIds, linkedPlanIds, linkedStationSiteIds, linkedServicePlanIds}` | 시간은 **개월 번호**(§1.3). 연결은 `null`/`[]`/목록 |
| 프로그램 수준 `linkedDevelopmentIds`, `linkedPlanIds`, `linkedStationSiteIds`, `linkedServicePlanIds` | 목록/`[]`/`null` | **참조일 뿐**, 자동 타당성 판정 없음 |
| `playerStatedPolicy` | 문자열 \| null | 플레이어 말 그대로 |
| `playerStatedPriority` | 1 이상 정수 \| null | 점수가 아님 |
| `linkFacts[]` | 연결마다 `{refKind, refId, found: true\|false\|null, geometryStatus: current\|stale\|inactive\|other-pack\|missing, referencedRevision}` | 사실 표시. 판정·점수 없음 |
| `unknown[]`, `unknownReasons{}`, `warnings[]`, `license` | | B19-M1과 동일 형식 |

계산하지 않는 것: 비용, 인구, 수요, 점수, 승객, 운임, 성공 확률.

### 6.2 B20-E1 장기 캠페인 기간·마일스톤 엔진 (경영, `transact`)

레코드 `campaign-program:N`:

| 필드 | 값 |
|---|---|
| `programId`, `programRevision`, `sourcePack{packId,packVersion}\|null` | 처음 geometry에 연결될 때 기록(B19-E1과 같은 규칙) |
| `status` | `draft → adopted → monitoring → completed`, `delayed`(출발 상태 기억), `cancelled` |
| `milestones[]` | `{milestoneId, sequence, targetMonth\|null, status: planned\|reached\|delayed\|cancelled, declaredAtMinute\|null, reason\|null, observedRefs[]}` — `observedRefs`는 선언 시점의 `{refKind, refId, state, atMinute}`뿐 |
| `linkedDevelopmentRecordIds`, `linkedContributionIds`, `linkedDemandSourceIds`, `linkedProjectIds`, `linkedServiceIds`, `linkedTimetableIds` | **경영 ID 참조**(`null`/`[]`/목록). 존재·상태 검증은 읽기 시점 |
| `geometry`(상태) | 마지막으로 받아들인 `{programRevision, status, reasons, checkedAtMinute}` |
| `history[]` | `{transitionId: "<id>:transition:<n>", kind, from, to, atMinute, reason}` 추가만 |

규칙: 전진 전이(`adopt`, `monitor`, `complete`, 마일스톤 `reach`)는 geometry가 `current`이고 팩·revision이 일치해야 한다. `delay`·`cancel`은 geometry 없이 가능. 현재 시각은 `clock.minute`를 **읽기만**, 큐·난수·원장 쓰기 없음. `report()`에 `campaignPrograms`, `hooks`(안정 ID) 제공.

### 6.3 B20-E2 마일스톤별 B19/B15 원천 활성화 브리지

레코드 `campaign-activation:N`: `{activationId, programId, milestoneId, refs: {intakeId, demandSourceId, contributionId, developmentRecordId}, revisionTuple: {programRevision, developmentRevision, sourcePack, intakeRevision, lifecycleRevision}, activatedAtMinute, status: recorded|stale|withdrawn, applicable: true\|false\|null, blockers[]}`.
- 대상은 **E4가 accepted이고 `standing.verification.status === "current"`인 기록뿐**(geometry를 넘겨 확인). 아니면 레코드를 만들지 않는다(차단 사유 반환).
- `refs.intakeId`는 E4의 `new-town-demand-intake:N`이다. `revisionTuple`은 그 기록의 `acceptance`(§2.4)를 **가리키고**, 달라진 것이 하나라도 있으면(E4 `standing`이 stale) 활성화도 `stale`. `applicable`은 입력 상태(§2.3 5번)이며 "적용했다"가 아니다.

### 6.4 B20-E3 장기 투자·개통 이력 사실 보고서 (읽기 전용)

`campaign-fact-report/1`: 프로그램마다 `{milestones + history, linkedDevelopments(상태·단계 hook), linkedContributions(상태·release.ledgerEntryId·원장 reference), linkedDemandSources(current|stale|missing + 이유), linkedServicePlans/timetables/openings(활성화·개통 시각)}` 와 `unknown/unknownReasons`. **합계·ROI·점수·성공 판정 없음**, 결측은 `null`+이유. 항목 순서는 ID 정렬로 고정(순서 독립성).

## 7. 30년 저장·복원과 결정성 위험

### 7.1 위험표

| # | 위험 | 근거 | 완화·테스트 요구 |
|---|---|---|---|
| R1 | **`transact` 비용이 원장·이벤트에 비례** | `transact`가 매번 `snapshot()` 전체 복제 후 실패 시 `restore`. 합성 측정: 항목 2만건 99 ms, 10만건 487 ms, 스냅샷 JSON 14.6 MB(원장 10만+이벤트 10만) | 장기 후반 `transact` 비용을 B20-R1에서 측정하고 한도 기록. 캠페인 상태는 작게 유지(참조만) |
| R2 | `Ledger.cash`가 모든 항목의 합(접근마다 O(n)), `assertInvariant`가 매 `transact` 호출 | `core.mjs` | 위와 같음. B20이 새 원장 항목을 만들지 않는다(E1~E3는 0건) |
| R3 | **일 단위 통계 무한 증가** | `stats.railwayTrafficByLine[line].days`는 운영일마다 15개 숫자 행을 추가(삭제 없음) | 30년 × 노선 수로 크기 예측해 R1에서 검증. 보고서는 월 단위 합산 표시(저장 변경은 하지 않음) |
| R4 | **`ManagementGame.save()`는 `savedAt: new Date().toISOString()`을 넣는다**(`encodeSave`) | `core.mjs:134` | 바이트 결정성 테스트는 **`saveIntegratedGame`/`snapshot()` 문자열**로 한다. `ManagementGame.save()` 바이트는 비교 대상이 아니다 |
| R5 | JSON은 `±Infinity`/`NaN`을 `null`로 바꾼다 | `integrated-save.mjs`가 `lastDispatch`의 `-Infinity`를 수동 복원 | 캠페인 필드에 비유한 수 금지. 새 센티널을 만들지 않는다 |
| R6 | 운영 시각이 소수 누적(`simMinutes += seconds/60`) | `simulation.mjs` | 일 경계 판정은 결정적이지만 부동소수 누적 의존. B20은 `simMinutes`를 직접 비교하지 않고 개월 번호(정수)로만 말한다 |
| R7 | RNG 소비 순서 | 경영 RNG, 건설 이벤트 RNG, 운영 RNG가 따로 있음 | B20-E1~E3는 **난수를 쓰지 않는다**(테스트: 호출 전후 RNG 상태 동일). 전이는 RNG를 건드리지 않는다 |
| R8 | 불러오기 시 재적용이 상태를 바꿀 수 있음 | `ScenarioRuntime.load()`가 활성 시간표를 다시 적용하고 캘린더 항목을 정리(B17-E2가 dispatch 사실은 고침) | 저장→불러오기→저장 **동일 바이트** 테스트를 캠페인 상태가 있는 저장본으로 수행 |
| R9 | 팩·스키마 이월 | `schemaVersion: 1`, `packId`·`packVersion` 정확 일치 | 캠페인 레코드는 `sourcePack`을 기억하고, 구저장본(필드 없음)은 `null`로 정직하게 복원. 팩 버전이 바뀌면 프로그램은 `stale` |
| R10 | 구저장본 | B19와 같은 패턴 | 키가 없으면 빈 배열 + 카운터 1, 카운터가 없어도 기존 최대 ID + 1 |
| R11 | 수요 모델은 마운트 때 한 번 | `main.mjs:437` | 적용 단계(D-3)가 저장 가능한 **명시 상태**를 가져야 한다. 모델 재생성 결과가 저장본에서 재현돼야 함 |

### 7.2 측정 방법 (재현 가능)

합성 `ManagementGame`에 원장 항목과 이벤트를 각 N건 넣고 `transact("probe", () => ({}))` 1회와 `JSON.stringify(snapshot())`를 측정했다. 운영 쪽은 `example-radial` 수요(31 노드, 노선 없음)로 `advanceSimulation(state, model, runtime, 3600)`를 측정했다. 같은 기계에서 한 번 잰 값이며 실제 30년 플레이의 원장 크기는 **추정하지 않았다**(서비스·노선 수에 달림). R1에서 실제 시나리오로 다시 잰다.

## 8. 개별 시민 agent 시뮬레이션이 필요 없는 이유

1. **현재 수요 모델이 이미 집계다.** 노드당 `residents/jobs`와 중력 가중치로 **발생률**을 정하고, 승객은 그 비율로 난수 표본을 뽑아 만든 **가중 이동 단위**다(`passengerWeight`, 기본 100명/단위). 시민이라는 개체는 어디에도 없다. B20이 개체를 도입하면 기존 규칙과 두 벌이 된다.
2. **B19가 다루는 사실이 집계다.** 입주 사실은 플레이어가 적은 `residents`/`jobs` 수치이며 개체 식별이 없다. 후보→승인→원천 사슬은 "무엇이 승인되었는가"의 기록이지 인구 생성이 아니다.
3. **개체 데이터가 없고 만들면 추정이다.** 마이크로데이터 라이선스는 확인되지 않았고(관광 수요 메모), 개체를 만들려면 속성 분포를 가정해야 한다. 프로젝트 규칙(자동 인구·수요 추정 금지)과 충돌한다.
4. **비용이 맞지 않는다.** 집계 모델만으로도 30년 일 단위 시뮬레이션은 §4.4의 수준이다. 개체 단위는 불가능하다.
5. **캠페인의 질문은 개체 수준이 아니다.** "언제 무엇이 승인·개통·분담되었는가"는 마일스톤·상태·원장 참조로 완전히 답할 수 있다.

## 9. 소유 경계와 열린 결정

### 9.1 누가 무엇을 바꾸는가

| 대상 | 쓰기 소유 | B20의 접근 |
|---|---|---|
| `clock.minute`, `simMinutes` | 호스트의 기존 루프 | 읽기 |
| 원장·이벤트 | 기존 경영 단계 | 참조 읽기, 쓰기 없음 |
| `demandNodes`, `accessLinks`, 배분 링크 | B15 + 호스트 적용 단계 | **쓰기 금지** |
| 신도시 개발·분담금 | B19-E1/E3 | 읽기 참조 |
| 수요 원천 승인 | B19-E4 | 읽기 참조 |
| 캠페인 프로그램·마일스톤·활성화 | **B20-E1/E2 (경영 `transact`)** | 쓰기 |
| 프로그램 지도 계약 | B20-M1 (map) | 쓰기 |
| 화면·저장 문자열 연결 | Codex(B20-C1) | — |

### 9.2 열린 결정 (사용자/Codex)

| ID | 결정 | 영향 |
|---|---|---|
| **D-1** | 운영 기간 처리: 일괄 시뮬레이션(A) / 대표일 외삽(B) / 정산 안 함 표시(C) | 장기 재무의 의미. §4.4 |
| **D-2** | 캠페인 연도 = 12개월(360일), 분기 = 3개월을 확정할지 | M1·E1 시간 필드 |
| **D-3** | B15 적용 단계(노드 추가 + 모델 재생성 + 접근 승인)의 소유자와 API | E5/E2의 `applicable`이 가리킬 곳. 지금은 없음 |
| D-4 | 캠페인 계층이 `management/**`에 들어가는 것 확인 (E1/E2는 `transact`·snapshot 필요) | 파일 소유 |
| D-5 | matrix 수요 팩의 residents/jobs 원천은 `unsupported`로 둘지 | E2/E5 |
| D-6 | **E4는 확정·병합됨**(§2.4). E5 계약을 B20이 요구하는 형태로 확정 | E2·E3 |

## 10. 한계

- B19-E5가 미병합이라 §2.4의 E5 부분과 §6.3의 `demandSourceId` 관련 필드는 **요구사항**이다. 확정 계약과 다르면 이 문서를 갱신한다. (E4는 병합되어 실제 계약을 적었다.)
- §4·§7의 수치는 합성 측정이다. 실제 도쿄 시나리오의 크기는 R1에서 측정한다.
- 이 문서는 코드를 바꾸지 않았고, 새 스키마는 모두 제안이다.
