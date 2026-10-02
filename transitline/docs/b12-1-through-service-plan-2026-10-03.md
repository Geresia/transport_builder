# B12-1 — 직통 경로와 인프라 소유·운행 분리

## 확정 구조

B12-1은 지도 사실과 경영 상태를 별도 계약으로 유지한다.

- 지도: `transitline.through-route-geometry/1`
- 경영: `transitline.through-service/1`
- B11-3 선로사용 계약은 확장하지 않고 ID로 연결한다.

지도 구간 종류는 다음 의미로 고정한다.

- `planned`: 아직 사업화·준공되지 않은 계획선
- `existing`: 플레이어가 계획한 뒤 준공한 자기 시설
- `external`: 팩에 들어 있는 읽기 전용 타사 기존망

지도는 구간 순서, 역, 선형, 길이, 소유자 원천값, 경계의 물리적 접속 여부만 제공한다. 비용·사용료·용량·시간표와 `possible/conditional/impossible/unknown` 판정은 경영 엔진이 담당한다. `physicalConnection: null`은 미상이며 `false`로 바꾸지 않는다.

## 작업 순서와 소유권

1. P1 정산 원자성·시계 정렬 — Codex
2. M1 지도 직통 경로 사실 계약 — Claude 별도 worktree, Codex 통합
3. E1 직통 서비스 경영 상태 — Codex
4. E2 게임 API·저장·복원 — Codex
5. E3 B11-3 계약 ID 연결 — Codex
6. R1 런타임 읽기 전용 보고 — Codex

Claude/Ruflo는 `engine/src/management/**`와 `scenario-runtime.mjs`를 수정하지 않는다. 지도 구현 후에는 읽기 전용 계약·통합 리뷰를 맡는다.

## P1에서 고친 선행 결함

- 지도 시뮬레이션 일자와 게임 회계 일자를 분리했다. 승객·열차 거리 커서는 지도 일자를 사용하고, 선로사용료·차량 중복 배차는 동기화된 게임 일자를 사용한다.
- `settleIntegratedServiceDay()`가 운행 수입, 계약 누계, 차량 상태, 월 손익, 시설 마모와 금융 정산을 하나의 게임 트랜잭션에서 처리한다.
- 여러 노선을 한 번에 정산할 때 시계 전진이나 뒤쪽 노선 정산이 실패하면 게임과 지도 상태 전체를 손실 없는 메모리 스냅샷으로 되돌린다.
- `settleTrackAccessForService()`는 활성 게임 트랜잭션 밖에서 직접 호출할 수 없다.

### P1 사후 검토 보강

`3dcbeaf` 사후 검토에서 달력 월을 수동 전진한 뒤 지도 운행일이 같은 게임 날짜를 재사용하는 회귀와, 실제 운행하지 않은 달력일의 선로사용료를 다음 운행에 몰아 청구하는 문제가 발견되었다. 후속 수정은 시간축을 다음처럼 분리한다.

- 차량 배차·수리의 중복 방지 키는 실제 지도 운행일(`simulationDay`)이다.
- 게임 달력은 정산할 실제 운행일 수만큼 항상 전진하며, 이미 달력이 앞서 있어도 멈추지 않는다.
- 선로사용 계약의 시작·종료는 달력 기준이지만 요금은 전달받은 실제 운행일 창과 겹친 날짜만 청구한다. 쉬었던 날짜는 소급 청구하지 않는다.
- 운행·금융 정산이 전혀 없으면 `settleOperatingDays()`는 게임/지도 전체 스냅샷을 만들기 전에 즉시 반환한다.
- 배차 0편성인 날의 지도 운행 빈도는 0으로 유지하고, 정산 직후 단순 `available` 대수로 다시 높이지 않는다.
- 트랜잭션 깊이 값이 없거나 손상된 경우 선로사용료 직접 정산은 fail-closed로 거절한다.
- JSON에서 초기 배차 시각 `-Infinity`가 `null`로 바뀌는 저장 특성을 복원 시 다시 `-Infinity`로 정규화한다.

## M1 지도 계약

구현과 전체 필드는 [through-route-contract.md](through-route-contract.md)에 있다. 핵심 연결키는 `throughRouteId`, `legId`, `handoverId`다. 50m 임계값은 접속 가능 판정이 아니라, 두 계획선 끝점이 가깝지만 정확히 맞닿지 않아 배선 확인이 필요한 `unknown` 영역을 구분하는 값이다.

## E1 직통 서비스 경영 상태

`through-service/1`은 플레이어가 선로 소유자인 경우와 타사 선로의 게스트인 경우를 같은 구조로 표현한다. 최소 필드는 다음과 같다.

- 서비스·경로: `throughServiceId`, `throughRouteId`, `status`, `guestModelId`, `trainsPerHour`
- 역할: `operatorId`, `payerOperatorId`, `payeeOwnerId`
- 연결: `legs[]`, `handoverIds[]`, `trackAccessAgreementIds[]`
- 판정: `assessment.verdict`, `violations[]`, `conditions[]`, `missingInputs[]`

외부 철도회사의 전체 경영 상태는 B12-1에서 만들지 않는다. 팩의 `externalNetworkId`와 원천 `infrastructureOwnerId`를 읽기 전용 인프라 카탈로그로 사용한다. 실제 운행량 기반 사용료와 게스트 비용은 B12-3·B12-4에서 정산한다.

구현 계약과 판정표는 [through-service-contract.md](through-service-contract.md)에 있다. 순수 E1 모듈과 E2의 `ManagementGame` 컬렉션·트랜잭션·재심사·승인·저장/복원 연결까지 완료됐다. 구저장본은 빈 컬렉션으로 로드하고 저장 스키마 버전은 올리지 않으며, 판정은 RNG를 소비하지 않는다. 다음 단계 E3은 B11-3 계약 상태와 직통 서비스 상태를 ID로 연결한다.
