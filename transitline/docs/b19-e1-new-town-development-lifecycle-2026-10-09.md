# B19-E1 신도시 개발 경영 상태·생애주기 엔진

`engine/src/management/new-town-development.mjs`(순수 모듈) + `game.mjs`/`scenario-runtime.mjs`/`index.mjs` 좁은 연결 + `engine/test/new-town-development-lifecycle.test.mjs`(26개). 기준 master `f21ad75`.

신도시 개발을 **철도 사업과 분리하되 연결할 수 있는 경영 상태**로 기록한다. 입주 사실, 개발 계약, 지자체·개발사 부담 구조를 남기고, 이후 B15 수요·B14 사건·B18 운행 연결이 읽을 수 있는 읽기 전용 보고를 만든다. **수요·인구는 만들지 않는다.**

## 원칙

- 지도 geometry는 **읽기 전용 입력**이다. 게임이 저장하지 않고 호출마다 `{ geometry }`로 받는다.
- geometry가 없거나(null) 알 수 없거나(`active`가 boolean이 아님) 비활성·낡았으면 **앞으로 나아가는 단계는 막힌다**. 모름은 통과가 아니다. 멈추는 단계(지연·취소)는 geometry 없이도 된다.
- 돈·계약 상태 변경은 모두 `ManagementGame.transact` 안에서만 한다. 난수와 시계는 쓰지 않는다(시계는 읽기만).
- 입주율·인구·수요·지가·비용·사업성은 **계산하지 않는다**(`NEW_TOWN_NOT_COMPUTED`).

## 상태 전이표

개발 상태: `draft → proposed → agreed → servicing ⇄ occupied`, 어느 단계에서든 `delayed`(복귀 가능), `cancelled`(종료).

| 단계 \ 현재 상태 | draft | proposed | agreed | servicing | occupied | delayed | cancelled |
|---|---|---|---|---|---|---|---|
| propose (geometry 필요) | → proposed | | | | | | |
| agree (geometry 필요, 상대방 이름 필요) | | → agreed | | | | | |
| startServicing (geometry 필요, 계획 상태 단계 필요) | | | → servicing | 유지 | 유지 | | |
| recordOccupancy (geometry 필요) | | | | → occupied | 유지 | | |
| delay | | | → delayed | → delayed | → delayed | | |
| resume (geometry 필요) | | | | | | → 지연 전 상태 | |
| cancel | → cancelled | → cancelled | → cancelled | → cancelled | → cancelled | → cancelled | |

- 단계(phase) 상태: `planned → servicing → occupied`, 취소 시 아직 끝나지 않은 단계는 `cancelled`, 이미 입주한 단계는 `occupied`로 남는다.
- `occupied`는 "진술된 입주 사실이 하나 이상 기록됨"일 뿐 비율이 아니다.
- 한 개발(developmentId)에 취소되지 않은 기록은 하나뿐이다.

## API (`ManagementGame`, `ScenarioRuntime`에 같은 이름)

| 메서드 | 설명 |
|---|---|
| `assessNewTownDevelopment({ id?, geometry })` | 읽기 전용. 단계별 `{allowed, blockers}`, 생성 가능 여부(`create`), geometry 상태 |
| `draftNewTownDevelopment(input)` | 초안. geometry 없이 `developmentId`만으로도 가능(단계는 `null`=미상) |
| `proposeNewTownDevelopment(input)` | 초안 생성+제안, 또는 `input.id`의 초안을 제안 |
| `agreeNewTownDevelopment(id, agreement, { geometry })` | 부담 구조·연결 조건 합의 |
| `startNewTownServicing(id, { geometry, phaseIds? })` | 단계 순서대로 서비스 개시 |
| `recordNewTownOccupancy(id, phaseId, facts, { geometry })` | 진술된 입주 사실 추가(덧붙이기만) |
| `delayNewTownDevelopment(id, reason)` / `resumeNewTownDevelopment(id, { geometry })` | 지연 / 복귀 |
| `cancelNewTownDevelopment(id, reason)` | 취소(종료) |
| `newTownDevelopmentReport(id?)`, `report().newTownDevelopments` | 읽기 전용 보고(복사본) |
| `newTownDevelopmentHooks(id)` | B15/B14 브리지용 안정 ID와 진술 사실 |

`input`: `{ id?, developmentId?, geometry?, name?, parties?, links?, phaseSupply? }`. `agreement`: `{ burdens: [{ itemId, bearers, statedAmountJPY?, note? }], connectionConditions?, parties? }`. `facts`: `{ statedOccupiedUnits?, statedPlannedUnits?, unit?, source, note? }` (둘 중 하나 이상 필요, 0은 0).

## 지도 M1이 채울 필드

최소 형태(읽기 전용 입력):

| 필드 | 형 | 없거나 틀리면 |
|---|---|---|
| `schema` | `"transitline.new-town-development-geometry/1"` | `invalid` |
| `contractVersion` | `1` | `invalid` |
| `developmentId` | 문자열 | `invalid` |
| `developmentRevision` | 문자열(지도가 바꿀 때마다 바뀜) | `invalid` |
| `sourcePackId` | 문자열(이 geometry를 만든 팩) | 없음/null/빈 문자열=`invalid`(`geometry-source-pack-unknown`) |
| `sourcePackVersion` | 문자열 또는 생략/null | 문자열이 아니면 `invalid`. 생략하면 기록에 `null`(미상)로 남고 그것만으로는 막지 않음 |
| `active` | boolean | boolean 아님=`invalid`, `false`=`inactive` |
| `phases[]` | `{ phaseId, sequence, playerDeclaredLandUse }` | 없음/빈 목록/중복=`invalid` |

경영 기록은 **처음 geometry에 연결될 때**(초안에 geometry를 줬을 때, 또는 geometry 없는 초안을 처음 제안할 때) `sourcePack: { packId, packVersion }`을 저장한다. 같은 `developmentId`라도 다른 팩의 geometry는 아래처럼 막힌다.

경영 기록이 기억한 `developmentRevision`·단계 목록·토지 용도·팩과 달라지면 `stale`(이유: `geometry-revision-changed` / `geometry-phases-changed` / `geometry-other-development` / `geometry-source-pack-changed` / `geometry-source-pack-version-changed`). 팩 버전은 기록과 geometry가 둘 다 진술했고 서로 다를 때만 막는다. 지도가 새 revision을 내면 호스트가 그 geometry로 다음 단계를 부르고, 낡은 채로는 앞으로 못 간다.

## 이후 연결 고리 (`newTownDevelopmentHooks`)

- **B15 수요 브리지**: 안정 ID `<id>:phase:<phaseId>`, 단계의 `playerDeclaredLandUse`, 진술된 공급(`statedSupply`)과 입주 사실(`factId`), `geometryStatus`. 수요 변환은 여기서 하지 않는다.
- **B14 사건 브리지**: 개발 ID, `transitionId`(`<id>:transition:<n>`) 이력, 지연·취소 이유. 경영 이벤트 로그에는 `new-town-development-*` 7종이 남는다.
- 연결 참조 `linkedPlanIds` / `linkedStationSiteIds` / `linkedServicePlanIds`는 **참조일 뿐 조회·검증하지 않는다**(미진술=`null`).

## 아직 계산하지 않는 것과 이유

| 항목 | 이유 |
|---|---|
| 인구·수요 | B19-E2 범위. 여기서 만들면 B15에 몰래 주입하는 셈 |
| 입주율 | 진술된 숫자에서 비율을 만들면 판정이 됨 |
| 지가·비용 추정·사업성 | B19-E3 범위, 근거 데이터 미확정 |
| 돈 이동 | 부담은 담당자와 진술 금액(JPY)만 기록. 실제 정산은 이후 단계 |
| geometry로부터의 입주·수요 유추 | 금지. geometry는 단계 목록과 선언된 용도만 알려 준다 |

## 호환성

저장본에 `newTownDevelopments`/`nextNewTownDevelopmentSequence`가 없으면 빈 목록과 1로 복원된다. 카운터가 없어도 기존 최대 ID+1을 쓰므로 ID가 재사용되지 않는다.

팩 정보가 없는 구저장본 기록(`sourcePack` 키 없음)은 복원 때 아무것도 채우지 않는다. 보고서·훅은 `sourcePack: null`(미상)로 알리고, geometry가 이미 연결된 기록은 앞으로 나아가는 단계에서 `stale` / `record-source-pack-unknown`으로 막힌다(현재 팩이라고 추정하지 않음). 지연·취소는 그대로 된다. 한 번도 geometry에 연결되지 않은 초안은 비교할 대상이 없으므로 첫 geometry로 연결된다.

## 검증

26개 테스트: geometry 판정표(null·미상·비활성·낡음), 다른 팩 geometry 혼입 차단(5개 전진 단계 모두)·팩 정보 없는 geometry·구저장본 미상 보고, 모든 상태×모든 단계 일관성(허용/차단이 `assess`와 일치, 차단 시 상태 불변), 합의 거부 17가지, 변환 롤백, 저장·불러오기 deepEqual, 구버전 저장, ID 단조성, 읽기 전용 보고가 상태·난수·시계를 바꾸지 않음, 돈 불변, 소스 검사. 변이 확인: 미상 `active` 통과, 낡은 revision 무시, geometry 불필요, 복귀 상태 무시, 팩 불일치 무시, 구기록을 현재 팩으로 추정, `sourcePackId` 없는 geometry 허용, 최초 연결 때 팩 미저장 → 각각 실패 확인 후 복원. (카운터 미복원은 기록을 지우지 않아 동치 변이.)
