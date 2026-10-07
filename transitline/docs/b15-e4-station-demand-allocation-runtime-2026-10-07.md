# B15-E4 — 역 접근권 수요 배분 런타임 연결

## 현재 동작

`ScenarioRuntime`에는 다음 명령이 추가됐다.

- `assessStationDemandAllocation({ policy, walkingPolicy })`: 읽기 전용 미리보기.
- `applyStationDemandAllocation({ policy, walkingPolicy })`: 명시적으로 적용한다.
- `stationDemandAllocationReport()`: 저장된 적용 결과의 복사본.

적용 전에는 B15-M2 지도 export를 `applyStationDemandAccess(export)`로 먼저 검증·보관해야 한다. 적용 결과는 별도 `stationDemandAllocationLinks` 컬렉션에 저장된다. 기존 계획선의 `accessLinks`는 수정하지 않는다.

## 안전 규칙

- 적용 링크가 있는 수요 노드만 기존 0분 레거시 역과 자동 800m 접근 링크를 대체한다.
- 정책·보행 미리보기는 상태, 현금, 시계, RNG를 바꾸지 않는다.
- 지도 access export의 revision이 바뀌면 기존 링크를 지우거나 재계산하지 않고, 저장된 배분만 `stale`로 표시한다.
- 실제 운행 역(`sourceStationId`)이 정확히 하나고, 보행 결과가 `usable`이며, 배정 비율이 100%일 때만 라우팅 링크가 생긴다.
- 정책이 없거나 거부됐거나 stale이면 적용을 거부하고 트랜잭션 전체를 되돌린다.

## (해소됨) 분수 배정 한계

> **B15-E5(`b15-e5-fractional-demand-routing-2026-10-07.md`)에서 해소했다.** 아래는 E4 시점의 기록이며, 지금은 `fixed-shares`가 노드별 비율대로 적용되고 거부되지 않는다.

## E4 시점의 의도적 한계

`fixed-shares`처럼 한 수요 노드를 60/40으로 나누는 정책은 P1에서 미리보기·보고까지 된다. 하지만 현 승객 라우터는 단일 노드의 분수 배정 개념이 없고 여러 접근 링크가 있으면 최단 경로 하나를 고른다. 따라서 E4는 비율이 1이 아닌 배정을 **거부**한다. 비율을 무시한 채 적용해 최단 역으로 몰아버리지 않기 위한 차단이다.

이를 지원하려면 별도 후속 작업에서 승객 스폰/경로 선택에 결정론적 분수 배정 모델을 추가해야 한다. 그 작업 전까지는 `assign-all`과 단독 역 100% 배정만 실제 운행에 적용할 수 있다.

## 저장

통합 저장은 운영 상태의 열거 가능한 필드를 저장하므로 아래가 함께 보존된다.

- 공간 사실 평가 `stationDemandAccessApplication`
- 적용 정책·보행 정책·배정·보행 결과 `stationDemandAllocationApplication`
- 실제 라우팅 링크 `stationDemandAllocationLinks`

이전 저장본에 이 필드가 없으면 빈 상태로 복원돼 기존 수요·승객 동작을 유지한다.
