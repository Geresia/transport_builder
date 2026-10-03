# B12-5 직통 경로 계획 통합

## 목적

지도에서 선택한 노선 구간을 `ThroughRouteGeometry`로 만들고, 그 사실을 경영 엔진의 직통 서비스 심사로 넘긴다. 지도는 비용·기술 호환·선로사용권·승인 여부를 판단하지 않는다.

## 해결한 단절

`drawnLinesFromState()`는 개통된 플레이어 노선과 외부 기존망을 새 계획선에서 제외한다. 이는 중복 사업화를 막는 올바른 동작이지만, 직통 경로 선택 화면도 개통 노선을 볼 수 없게 했다.

`through-route-planning-integration.mjs`는 이 문제를 다음처럼 해결한다.

- 개통 사업: 경영 프로젝트에 보존된 원본 `project.planGeometry`를 `existing` 경로 원천으로 사용한다.
- 현재 계획선: 일반 `MapExport.plans`를 `planned` 원천으로 사용한다.
- 외부 기존망: `MapExport.externalNetworks`를 `external` 원천으로 사용한다.
- 동일한 `planId`가 개통 사업과 현재 편집 지도에 동시에 있으면, 시공 당시 확정된 프로젝트 형상을 우선한다.
- 외부선의 `operator` 태그를 소유자로 추정하지 않는다. 소유자 자료가 없으면 `null`이다.

## 저장 계약

플레이어 선택은 운영 상태의 `throughRoutePlans[]`에 저장되며 통합 저장본에 자동 포함된다.

각 항목은 다음을 가진다.

- `key`: 플레이어 경로의 안정적인 키
- `selection`: 순서가 있는 `sourceId`와 정·역방향 선택
- `route`: 생성 시점의 완전한 `transitline.through-route-geometry/1` 스냅샷

같은 키로 편집하면 `throughRouteId`를 유지한다. 이미 경영 직통 서비스에 연결된 경로는 삭제할 수 없다. 구버전 저장본에는 이 배열이 없으므로 빈 목록으로 읽는다.

## 플레이 흐름

1. 직통 경로 계획 패널에서 2개 이상의 계획선·개통선·외부선을 순서대로 선택한다.
2. 각 구간의 운행 방향을 고른다.
3. 차량 형식과 시간당 운행 횟수를 입력한다.
4. `buildThroughRoute()`가 물리 경로 사실과 인계 지점을 계산한다.
5. `ManagementGame.createThroughService()`가 기술 호환, 시설 상태, 용량, 선로사용계약을 심사한다.
6. 결과가 `possible`일 때만 기존 승인 절차로 넘어간다.

외부선은 현재 팩에 선로 선형이 없으므로 인계부의 `physicalConnection`이 `null`이다. 따라서 별도 접속 설계 자료가 들어오기 전에는 승인 가능한 것으로 간주하지 않는다.

## 운영선 연결

기존망을 시뮬레이션 상태에 심을 때 각 노선에 다음 ID를 함께 기록한다.

- `externalNetworkId`
- `externalLineId`

따라서 화면 표시 이름이 바뀌어도 외부 지도 노선과 실제 운행선을 안정적으로 연결할 수 있다. 플레이어 개통 사업은 `project.commissionedLineId`와 역 자산의 `sourceId`로 같은 연결을 제공한다.

## 남은 일

- 외부 기술사양 export를 패널에 연결해 실제 외부 노선의 기술 심사 입력을 제공한다.
- 물리 접속이 미상인 외부 인계부에 대해 분기기·연락선 설계 계약을 추가한다.
- 저장된 경로에서 역·구간별 실제 운행선 매핑을 만들어 `commissionThroughServiceOperation()` 입력으로 넘긴다.
- Claude의 B12-5 M3 지도 오버레이와 `throughRouteId`/`legId`로 결합한다.

## 검증

`through-route-planning-integration.test.mjs`가 다음을 검사한다.

- 개통·계획·외부 원천 분리
- 운영사 태그를 소유자로 오인하지 않음
- 외부 운행선 stable ID 연결
- 프로젝트 확정 형상 우선
- 입력 순서와 무관한 결정론적 결과
- 방향 반전
- 타 팩·잘못된 원천 거부
- 저장·편집·삭제 보호
- 보고서 원본 불변
- 경영 서비스 생성 및 통합 저장·복원
- 서비스 생성 실패 시 경로 초안이 남지 않는 원자성
