# B19-E3 신도시 철도 분담금·지자체/시행사 협약 엔진

`engine/src/management/new-town-rail-contribution.mjs`(순수 모듈) + `game.mjs`/`scenario-runtime.mjs`/`index.mjs` 좁은 연결 + `engine/test/new-town-rail-contribution.test.mjs`(21개). 기준 master `9b9506f`.

신도시 개발과 철도 사업 사이의 "**누가 어떤 조건에서 얼마를 부담하기로 했는가**"를 감사 가능한 경영 계약(`transitline.new-town-rail-contribution/1`)으로 기록한다. 금액·부담자·수령자·조건·연결 대상은 **플레이어 또는 시나리오가 명시한 값만** 쓴다. 신도시의 면적·용도·인구·수요·입주 사실에서 금액이나 보조금을 만들지 않고(코드에서 그 필드를 읽지 않으며 입력에 섞여 와도 기록하지 않는다), 추정·분할·기본값이 없다.

## 값의 규칙

`null`=명시되지 않음, `0`=명시된 0, `[]`=명시된 "없음". 이 셋은 어디서나 구분한다(`statedAmountYen`, `phaseIds`, `conditions`, 연결 목록).

## 상태 전이표

`draft → proposed → agreed → funded → released`, 그리고 `proposed|agreed|funded → delayed → (원래 상태)`, `released`를 뺀 어디서나 `terminated`.

| 단계 | 시작 상태 | 개발·지도 확인 | 하는 일 | 현금·원장 |
|---|---|---|---|---|
| `draftNewTownRailContribution(input)` | — | 개발 기록이 있고 취소되지 않아야 함 | 명시값만 기록, 개발 revision·팩을 그 시점 것으로 기록 | 없음 |
| `proposeNewTownRailContribution(id, ctx)` | draft | **필요** | → proposed | 없음 |
| `agreeNewTownRailContribution(id, terms, ctx)` | proposed | **필요** | → agreed. 금액·조건이 명시돼 있어야 함 | **없음** |
| `fundNewTownRailContribution(id, confirmation, ctx)` | agreed | **필요** | 지급 확정 사실 기록 → funded | **없음** |
| `releaseNewTownRailContribution(id, ctx)` | funded | **필요** + 조건 확인 + 연결 대상 확인 | → released | **여기서만 원장에 1회** |
| `delayNewTownRailContribution(id, reason)` | proposed·agreed·funded | 불필요 | → delayed (출발 상태 기억) | 없음 |
| `resumeNewTownRailContribution(id, ctx)` | delayed | **필요** | → 출발 상태 | 없음 |
| `terminateNewTownRailContribution(id, reason)` | draft·proposed·agreed·funded·delayed | 불필요 | → terminated | 없음 |

`released`와 `terminated`는 종착이다. 모든 변경은 `ManagementGame.transact` 안에서 일어나, 실패하면 계약·현금·원장·이벤트·RNG·ID 순서가 함께 되돌아간다.

## 실제 현금·원장 반영 시점

- **합의(agree)와 지급 확정(fund)은 현금을 만들지 않는다.** fund는 외부 부담자가 지급을 확정했다는 *사실*(`confirmedAmountYen`, `confirmedBy`, `reference`)만 기록한다. 기존 원장에는 "제한 자금"에 해당하는 개념이 없어 그것을 새로 만들지 않았다.
- **release만** 원장에 `+statedAmount`를 올리고(`category: "new-town-rail-contribution"`, `reference: contributionId`), 그 항목 ID를 `release.ledgerEntryId`에 남긴다. 그 직후 `transact`가 `player.cash`를 원장에 맞춘다.
- release가 돈을 올리지 **않는** 경우(상태는 released가 되고 `release.ledgerEffect: "none"`, 이유 기록): 부담자가 플레이어(`payer-is-the-player-no-cash-created`), 수령자가 `other`(`payee-is-not-the-player-side`), 확정 금액이 명시된 0(`stated-zero`). 수령자가 `player-railway`/`project`이고 부담자가 지자체·시행사·기타이며 금액이 0보다 클 때만 올린다.
- 중복 방지는 두 겹이다: released에서는 release가 막히고, 같은 계약 ID의 분담금 원장 항목이 이미 있으면 상태와 무관하게 거부한다.
- 확정 후 풀리지 않은 funded를 terminate해도 되돌릴 현금이 없다(`termination.fundedNotReleased: true`).

## 개발·지도 확인(게이트)

propose·agree·fund·release·resume은 다음을 모두 요구한다. 하나라도 어기면 막고 이유를 말한다(미상은 통과가 아니다).

| 막는 이유 | 코드 |
|---|---|
| 계약이 기억한 개발 revision이 없음 | `development-revision-unknown` |
| 계약이 기억한 팩이 없음 | `source-pack-unknown` |
| E1 개발 기록 없음 / 다른 기록 | `development-record-missing` / `-mismatch` |
| E1 개발이 취소됨 | `development-cancelled` |
| 개발 revision·팩이 계약 작성 때와 다름 | `development-revision-mismatch` / `source-pack-mismatch` |
| geometry가 없음·낡음·다른 팩·비활성·알 수 없음 | `geometry-missing` / `-stale` / `-invalid` / `-inactive` + E1 이유 |
| 연결한 단계가 개발에 없음·취소됨·확인 불가 | `phase-unknown:<id>` / `phase-cancelled:<id>` / `linked-phases-unverifiable` |

delay·terminate는 geometry 없이도, 개발이 취소돼도 된다. `gate`에는 마지막으로 받아들인 시점의 개발 revision·팩·개발 상태·마지막 전이 ID·geometry 상태가 남는다.

## release의 추가 확인

- **조건**: 계약의 `conditions`가 `[{conditionId, text}]`로 명시돼 있으면, `ctx.conditionConfirmations: [{conditionId, note?}]`가 **모든 조건을 정확히 한 번씩** 확인해야 한다. 조건은 자동으로 충족되지 않는다. 확인 기록은 `release.conditionConfirmations`에 남는다.
- **연결 대상이 현재인지**: `linkedProjectIds`는 게임의 projects에 있고 취소되지 않았는지, `linkedPlanIds`/`linkedStationSiteIds`는 호출자가 준 `ctx.currentLinks = { planIds, stationSiteIds }`에 들어 있는지 검사한다. 명시한 연결이 있는데 확인할 목록이 없으면 `linked-…-not-verifiable`로 막는다(`null`/`[]`은 확인할 것이 없다).

## 계약 필드 (B19-C1 UI가 읽을 표)

`newTownRailContributionReport(id?)` 또는 `ScenarioRuntime.report().newTownRailContributions`의 항목:

| 필드 | 값 |
|---|---|
| `schema`, `contractVersion` | `"transitline.new-town-rail-contribution/1"`, `1` |
| `contributionId` | `new-town-rail-contribution:N` (단조 증가, 재사용 없음) |
| `name` | 텍스트 또는 null |
| `developmentRecordId`, `developmentId`, `developmentRevision`, `sourcePack` | E1 기록 ID / M1 개발 ID / 작성 시 revision(미상이면 null) / `{packId, packVersion}` 또는 null |
| `phaseIds` | `null`(개발 전체) / `[]`(연결 단계 없음 선언) / 목록 |
| `payerKind` | `municipality` `developer` `player` `other` |
| `payeeKind` | `player-railway` `project` `other` |
| `statedPurpose` | `station` `rail-extension` `access` `depot` `other` |
| `statedAmountYen` | 0 이상 정수 / null |
| `linkedProjectIds`, `linkedPlanIds`, `linkedStationSiteIds` | 목록 / `[]` / null |
| `conditions` | `[{conditionId, text}]` / `[]` / null |
| `status` | 위 상태 |
| `gate` | 마지막 확인 시점 `{developmentRevision, sourcePack, developmentStatus, developmentLastTransitionId, geometryStatus, checkedAtMinute}` 또는 null |
| `agreement` | `{agreedAtMinute, statedAmountYen, conditions}` 또는 null |
| `funding` | `{fundedAtMinute, confirmedAmountYen, confirmedBy, reference}` 또는 null |
| `release` | `{releasedAtMinute, amountYen, ledgerEffect: posted/none, ledgerEffectReason, ledgerEntryId, conditionConfirmations}` 또는 null |
| `delay` | `{reason, delayedAtMinute, fromStatus, resumedAtMinute}` 또는 null |
| `termination` | `{reason, terminatedAtMinute, fromStatus, fundedNotReleased}` 또는 null |
| `history[]` | `{transitionId: "<id>:transition:<n>", sequence, kind, from, to, atMinute, reason}` 추가만 |

## API (`ManagementGame`, `ScenarioRuntime`에 같은 이름)

| 메서드 | 설명 |
|---|---|
| `assessNewTownRailContribution({ id, geometry?, currentLinks?, terms?, confirmation?, conditionConfirmations? })` | **읽기 전용.** 단계별 `{allowed, blockers}`와 `releaseEffect: {kind: post/none, amountYen, reason}`. 입력이 없으면 허용이 아니라 차단 이유로 나온다 |
| `draftNewTownRailContribution(input)` | `{developmentRecordId, payerKind, payeeKind, statedPurpose, statedAmountYen?, phaseIds?, linkedProjectIds?, linkedPlanIds?, linkedStationSiteIds?, conditions?, name?}`. 종류 세 가지는 필수(기본값 없음) |
| `propose…(id, ctx)`, `agree…(id, terms, ctx)`, `fund…(id, confirmation, ctx)`, `release…(id, ctx)`, `delay…(id, reason)`, `resume…(id, ctx)`, `terminate…(id, reason)` | 위 표. `ctx = {geometry, currentLinks, conditionConfirmations}`, `terms = {statedAmountYen?, conditions?}`, `confirmation = {confirmedAmountYen, confirmedBy, reference}` |
| `newTownRailContributionReport(id?)` | 읽기 전용 복사본 |
| `newTownRailContributionHooks(id)` | `transitline.new-town-rail-contribution-hooks/1`: `hookId`(=contributionId), 개발·revision·팩, `phaseHookIds`(`<개발 기록 ID>:phase:<phaseId>`, E1의 단계 hook과 같은 ID), 부담자·수령자·목적·금액, 연결 목록, `funded`/`released`, `ledger: {entryId, amountYen}`, 전이 ID들 |

B15 수요 후보(B19-E2)는 자동으로 승인·적용하지 않고, B14 사건도 만들지 않는다. 안정 hook ID만 둔다. 이벤트 로그에는 `new-town-rail-contribution-*` 8종만 남는다(스케줄된 일 없음).

## 아직 하지 않은 것 (경계)

- **토지 가격, 사업성·수익성, 보조금·분담금 산정**: 하지 않는다. 금액은 사람이 말한 정수뿐이다.
- **수요 변환**: 신도시 면적·인구·입주를 수요나 승객·운임으로 바꾸지 않고, 분담금과 수요를 연결하지도 않는다.
- **조건의 자동 판정·자동 지급**: 조건 충족은 호출자의 확인으로만, 지급은 호출자의 release로만.
- **제한 자금(escrow) 원장**: 새 원장 개념을 만들지 않았다. 지급 확정은 사실 기록이고 release 전에는 어떤 돈도 보이지 않는다.
- **금액 수정·부분 지급·분할 release**: 없다. fund의 확정 금액은 합의된 금액과 같아야 하고, release는 전액 한 번이다. 합의 후 금액이 바뀌면 종료하고 새 계약을 만든다.
- **프로젝트 자금 계정**: 프로젝트 쪽 별도 장부는 없어서 `project` 수령자도 플레이어 원장에 올리고 `reference`로 계약 ID를 남긴다(연결 프로젝트는 `linkedProjectIds`).
- 합성 개발·예제 geometry로만 확인했고, UI·`main.mjs` 연결은 없다.

## 호환성

저장본에 `newTownRailContributions`/`nextNewTownRailContributionSequence`가 없으면 빈 목록과 1로 복원된다. 카운터가 없어도 기존 최대 ID+1을 쓰므로 ID가 재사용되지 않는다.

## 검증

21개: 모든 상태×모든 단계 일관성(허용/차단이 `assess`와 같고 차단 시 상태 불변), 초안의 명시값·0/null/[] 구분, 금액 자동 산정 없음(입력에 섞인 면적·인구·수요는 기록되지 않음), 합의 조건, 돈 이동 시점(propose~fund·delay·resume·assess·report가 원장·현금을 바꾸지 않고 release만 1회), 중복 release 차단(상태·원장 이중), release 효과 4종, fund 확정 검증 10가지, 조건 확인 6가지, 연결 대상 확인 8가지, 게이트(stale·다른 팩·팩 버전·팩 없음·비활성·미상·없음·다른 개발·E1 취소·revision 미상) 전 단계 차단과 delay/terminate 허용, 단계 확인, 지연·복귀, 실제 `transact` 롤백(8개 단계 + 원장 post 실패 + ID 반환), 저장·불러오기 deepEqual/바이트 비교/구저장본/ID 단조성, assess·report의 상태·RNG·시계·원장 불변과 얼린 입력, 입력·출력 비공유, hooks, ScenarioRuntime 위임·저장·불러오기, 소스 검사(시계·난수·면적/인구/수요 접근·산술 없음, 원장 post는 release에 한 곳뿐, 모든 변경이 `transact` 안).

변이 확인 13개(release 중복 허용, 플레이어 부담자에게 현금, release의 게이트 제거, fund 금액 불일치 허용, 조건 미검사, 취소된 개발 통과, 금액 미명시 합의, released 종료, 0원 post, 연결 대상 미검사, 원장 중복 검사 제거, 없는 geometry 통과, 조건 미명시 통과) — 각각 테스트가 실패하는 것을 확인하고 되돌렸다.
