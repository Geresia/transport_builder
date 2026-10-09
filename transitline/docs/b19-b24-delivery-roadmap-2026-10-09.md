# B19~B24 실행 로드맵과 기반선

## 목적과 고정 원칙

이 문서는 신도시(B19)에서 30년 캠페인(B20)을 거쳐, **평상시 2D 운영 / 건설할 때만 3D**인 Unity 전환(B21~B24)까지의 구현 순서와 소유 경계를 고정한다.

- 운영 지도, 수요, 열차, 시간표, 원장은 계속 JavaScript 2D 엔진이 정본이다.
- Unity는 B21부터 건설·부지·역·선로의 공간 검토와 편집에만 쓴다. 시민별 이동, 운임 정산, AI 경쟁사, 원장 계산을 Unity에 복제하지 않는다.
- 지도 사실, 플레이어 진술, 경영 판정, 저장된 결정은 서로 다른 계약으로 둔다.
- `null`은 미상/미진술, `0`은 명시된 0, `false`는 명시된 아님, `[]`는 명시된 없음이다. 결측을 안전·0·빈 목록으로 바꾸지 않는다.
- 모든 경영 상태 변경은 `ManagementGame.transact` 안에서, 모든 3D 편집 결과는 검증된 문서로만 2D 엔진에 들어간다.
- 각 단계의 완료는 코드 존재가 아니라 단위 시험, 저장·복원, 팩 혼입 거절, 실제 브라우저 또는 Unity 어댑터 시험으로 증명한다.

## 현재 기준선

| 영역 | 현재 정본 | 상태 |
| --- | --- | --- |
| B19 지도 개발안 | `new-town-development-export/1` | 완료, main 지도 편집 연동 완료 |
| B19 개발 생애주기 | `newTownDevelopments` | 완료, main 패널 연동 완료 |
| B19 철도 분담금 | `newTownRailContributions` | 완료, main 패널 연동 완료 |
| B19 수요 후보 | `new-town-demand-candidates/1` | 완료, 읽기 전용 |
| B19 후보 승인 | `newTownDemandIntakes` | 완료 |
| B19 명시 수요 원천 | `newTownExplicitDemandSources` | 완료. B15 수요 노드에는 아직 적용하지 않음 |
| B20 시간·성능 감사 | `b20-campaign-integration-audit-2026-10-09.md` | 완료 |
| B21~B24 Unity | 없음 | 이 문서의 신규 계획 |

## B19 마감선

### B19-M5 — 수요 후보 승인 패널

입력은 B19-E2 후보와 B19-E4 intake 보고서다. 플레이어는 후보별 사실 ID를 선택하여 승인, 보류, 거절, 철회한다.

- 승인 전에는 B15 또는 `newTownExplicitDemandSources`를 절대 쓰지 않는다.
- `accepted + geometry current`만 “명시 수요 원천 만들기”를 누를 수 있다. 이 버튼은 B19-E5의 apply API를 한 번만 부른다.
- 후보의 residents/jobs 숫자를 합산하거나 원 크기·점수로 표현하지 않는다.
- stale/revoked/withdrawn은 숨기지 않으며 자동 재승인·자동 재적용하지 않는다.
- 저장 대상은 선택과 미제출 폼뿐이다. intake와 source는 runtime save의 소유다.

완료 증명: 실제 `ScenarioRuntime`에서 후보 → 승인 → source 적용 → stale → 철회, 저장·복원, 다른 팩 거절, 명령이 클릭 밖에서 0회임을 검증한다.

### B19-C2 — 메인 연결과 통합 저장

Codex 소유다.

- M5를 시나리오 패널에 mount한다.
- 지도 문서, M3/M4/M5의 UI 문서, runtime 저장 상태를 통합 저장에 각각 보존한다.
- `newTownExplicitDemandSources`는 운영 상태에 있으므로 별도 복사 저장하지 않는다.
- E5 source는 아직 B15 `demandNodes`·`accessLinks`를 바꾸지 않는다는 한계를 화면에 표시한다.

### B19-R1 — 경계 감사

다음 불변식을 자동 시험한다.

1. 승인되지 않은 후보는 source 0건이다.
2. source 적용은 B15 노드·접근 링크·배분 링크를 바꾸지 않는다.
3. 지도/팩/lifecycle/입주 사실 변화는 source를 stale로만 만들며 자동 수정하지 않는다.
4. source 철회는 과거 기록을 지우지 않고 재적용을 막는다.
5. B19 상태가 있는 통합 저장본은 저장→복원→보고에서 같은 ID·revision·결정 이력을 보인다.

## B20 — 30년 광역 캠페인

### B20의 범위

B20은 여러 B19 개발, 철도 계획, 분담금, 승인 수요 원천, 서비스·시간표를 하나의 **광역 개발 프로그램**과 명시 마일스톤으로 묶는다. B20이 소유하는 것은 프로그램과 마일스톤의 상태·참조·이력뿐이다.

다음은 B20 범위 밖이다.

- 시민 개체 생성 또는 개별 이동
- 신도시 면적·용도·입주 수치에서 수요/비용/지가/ROI를 추정하는 일
- 원장·운임·시간표 규칙을 B20 안에서 재구현하는 일
- B15 노드·접근·배분을 자동 변경하는 일

### 시간 기준

- 새 시계를 만들지 않는다. 경영 시계 `game.clock.minute`만 읽는다.
- 캠페인 월은 기존 30일 월의 번호, 분기는 3개월, 캠페인 연도는 12개월(360일)인 **표시용 파생값**이다.
- 프로그램은 시간을 전진시키지 않는다. 마일스톤 도래 여부는 읽기 계산이고 상태 전이는 플레이어 또는 시나리오의 명시 행동이다.
- 30년 운영 정산은 별도 결정이다. 기본선은 “기존 운영 시뮬레이션을 실제로 돌린 기간만 정산됨”이며, 대표일 외삽은 별도 승인 전까지 구현하지 않는다.

### 작업 그래프

| 순서 | 작업 | 소유 | 입력 | 산출 | 병렬성 |
| --- | --- | --- | --- | --- | --- |
| D0 | 연결·성능 감사 | 완료 | B15/B18/B19 | 결정·위험표 | 완료 |
| M1 | 광역 프로그램 지도 계약 | map | B19 exports, 기존 계획 | `regional-development-program/1` | E1의 사전 조건 |
| E1 | 프로그램·마일스톤 생애주기 | management | M1 geometry | `campaignPrograms` | M2와 병렬 가능 |
| M2 | 프로그램 지도 편집기·오버레이 | map | M1 | player document/export | E1과 병렬 가능 |
| E2 | 승인 원천 활성화 기록 | management | E1, E4/E5, geometry | `campaignActivations` | E1/E5 뒤 |
| E3 | 장기 사실 보고 | read-only engine | E1/E2 + 기존 report | `campaign-fact-report/1` | M3의 사전 조건 |
| M3 | 캠페인 타임라인·현황 패널 | UI | E3 | 읽기/명령 UI | E3 뒤 |
| R1 | 30년 저장·성능 감사 | test/report | 전부 | 기준 수치·회귀 시험 | 마지막 |
| C1 | main·통합 저장 연결 | Codex | M2/M3/E1/E2 | 플레이 가능 흐름 | 마지막 |

### B20-M1 최소 계약

`transitline.regional-development-program/1`은 순수 지도 계약이다.

- `programId`: `packId + player key` 기반 결정적 ID. 이름·배열 순서와 무관하다.
- `programRevision`: 연결·순서·목표 월·플레이어 선언 변경 시 달라진다.
- `sourcePackId`, `sourcePackVersion`, `active`, `key`, `name`.
- `milestones`: 명시 순서와 `targetMonth | null`, `durationMonths | null`, 연결된 B19 development/plan/station/service ID 목록.
- 프로그램 수준의 참조 목록, `playerStatedPolicy | null`, `playerStatedPriority | null`.
- `linkFacts`: 링크를 찾았는지/미상인지와 참조 revision만. 비용·수요·판정은 없다.
- `unknown`, `unknownReasons`, `warnings`, 라이선스·출처.

### B20-E1/E2 경영 경계

E1은 `campaign-program:N` 상태를 `draft → adopted → monitoring → completed`, 그리고 `delayed`·`cancelled`로 관리한다. 전진에는 current geometry가 필요하고, delay/cancel은 지도 없이도 가능하다.

E2는 B19-E4에서 승인되고 B19-E5에서 current인 source를 특정 마일스톤에 **활성화 대상으로 참조**한다. 이는 B15 적용이 아니다. 참조한 intake, source, map, lifecycle revision 중 하나라도 달라지면 activation은 stale이며 자동 회복하지 않는다.

### B20-R1 성능 기준

- 30년은 360개월이다. B20 전이는 마일스톤 수에 비례해야 하며 일수에 비례하면 안 된다.
- B20 자체는 원장 항목·이벤트·난수를 만들지 않는다.
- `transact`는 스냅샷 전체를 복제하므로 프로그램 이력은 참조와 짧은 상태 문자열만 저장한다.
- 실제 팩에서 1년/10년/30년 저장 크기와 `transact` 시간, `advanceMonth` 시간을 측정해 문서화한다. 측정 결과를 일반화하지 않는다.

## B21 — Unity 건설 모드 기반

### 목표

웹 2D 운영을 끊지 않고, 사용자가 “3D 건설 검토”를 열었을 때만 Unity가 동일한 공간 문서를 읽고 결과를 검증된 변경 문서로 돌려주는 기반을 만든다.

### B21-P1: 3D 교환 계약

- Unity에 보내는 입력은 pack ID/version, plan/station/depot/new-town/program의 안정 ID·revision, 좌표 기준, 필요한 공간 사실이다.
- Unity가 돌려주는 출력은 `transitline.construction-3d-change-set/1`의 **제안**이다. 적용/거절은 JavaScript 경영 엔진이 결정한다.
- Unity는 cash, ledger, demand, passengers, timetables, RNG, game clock을 읽거나 쓰지 않는다.
- 모든 reference는 pack·revision·source document를 포함한다. stale/other-pack이면 적용할 수 없다.

### B21-P2: Unity 어댑터와 수명주기

- 별도 Unity WebGL/desktop build 어댑터, capability handshake, version compatibility, graceful unavailable 상태를 만든다.
- 게임 저장에는 Unity 실행 상태나 binary blob을 넣지 않는다. 적용된 change-set 문서와 선택 상태만 저장한다.
- Unity가 없거나 로드 실패해도 2D 게임은 완전히 동작한다.

### B21-P3: 좌표·정밀도 시험

- 투영 원점, metres-per-unit, 고도 기준, axis 방향, 지리 좌표 왕복 허용 오차를 계약화한다.
- Tokyo처럼 큰 좌표에서 floating-origin을 Unity 내부 표시 문제로 처리하되, 2D 정본 좌표를 바꾸지 않는다.
- 같은 입력은 같은 scene manifest를 만든다. 시계·난수·GPU 상태는 manifest에 영향이 없다.

## B22 — 3D 선로·역·부지 설계 검토

- B13 rail capacity geometry, B8 station design, depot/site/new-town geometry를 3D scene manifest에 **표시**한다.
- 지형·수역·건물·도로 레이어가 없으면 3D에서 그럴듯한 대체물을 만들지 않고 `unknown`으로 표시한다.
- 편집 제안은 선로 고도/구배, 역 부지 외곽, 출입구, 작업면처럼 이미 존재하는 2D 계약 필드에만 매핑한다.
- 3D 충돌 결과는 `clear / conflict / unknown` 사실이다. 공사 가능/비용/허가 판정은 JavaScript 엔진에 남는다.
- 지상역·고가역·지하역은 표현 모드가 다르지만 경영 ID는 변하지 않는다.

## B23 — 3D 공사·시공 단계 검토

- B14 사건, 작업면, 공사 패키지, 임시 동선, 대체수송을 공간적으로 재생한다.
- 3D는 공정 진척을 계산하지 않고 기존 공정/계약 상태를 시간 슬라이더로 표시한다.
- 공사 단계에서 낸 change-set은 새 예산·지연·보상을 직접 쓰지 않는다. B8/B14의 기존 승인 경로에 제안으로만 들어간다.
- 2D 지도와 3D 장면이 같은 package/workfront/site ID와 revision을 보인다는 왕복 시험을 만든다.

## B24 — 2D/3D 통합 캠페인 검증·성능선

- B20 프로그램 → B21 scene manifest → B22/B23 change-set → 기존 2D 승인/저장 경로의 end-to-end 시나리오를 만든다.
- Unity를 열지 않은 2D 플레이의 초기 로드, 메모리, 프레임 시간은 B20 이전과 비교해 퇴행하지 않아야 한다.
- Unity가 없을 때, 오래된 change-set, 다른 pack, 다른 좌표계, stale revision, 부분 저장본을 모두 안전하게 거절하거나 읽기 전용으로 표시한다.
- Tokyo 및 두 합성 팩에서 저장→복원→다시 열기→동일 scene manifest 검증을 한다.
- B24 종료 검토에서 Unity를 운영 시뮬레이션으로 확장할지 여부를 다시 결정한다. 기본 답은 “아니오”다.

## 각 단계의 완료 게이트

1. 계약: 결정적 ID, source pack/revision, null 삼상 규칙, 금지 필드 시험.
2. 엔진: transaction rollback, old-save migration, RNG/clock 무변경 또는 의도된 변경의 증명.
3. UI: 명령은 click에서만, mount/refresh는 읽기 전용, 실제 browser/Unity interaction 확인.
4. 통합: 통합 저장 한 번, 2D/3D source-of-truth가 하나임을 증명.
5. 성능: 실제 팩 측정값, 상한·실패 시 graceful fallback, 추정 수치로 통과 주장 금지.

