# B12-5 직통열차 실제 운행 연결 1차

## 목적

B12-4는 호출자가 넘긴 하루 실적을 정산했다. B12-5 1차는 지도 시뮬레이션에서 실제로 움직인 직통열차와 도착 승객을 일자별 실적으로 기록하고, 완료된 운행일을 B12-4 정산에 자동 공급한다.

구현 경계는 다음과 같다.

- `engine/src/through-operation-integration.mjs`: 운행선 바인딩, 실제 실적 기록, 일자별 실제값 출력
- `engine/src/trains.mjs`: 실제 이동거리와 실제 정차를 기록
- `engine/src/passengers.mjs`: 개별 승객 엔진의 직통 승객을 기록
- `engine/src/pop-sim.mjs`: 집단 승객 엔진의 실제 인원수를 기록
- `engine/src/scenario-runtime.mjs`: 전용 직통 운행선 개통, 상태 동기화, 완료일 자동 정산과 원자적 롤백

## 운행 바인딩 계약

스키마는 `transitline.through-operation-binding/1`이다. 승인된 `ThroughService` 하나와 실제 시뮬레이션의 운행선 하나를 다음 ID로 연결한다.

- `throughServiceId`, `throughRouteId`, `routeGeometryRevision`
- `operationalLineId`
- `trackAccessAgreementIds`
- `segmentAccessAgreementIds[]`: 실제 운행선의 각 물리 구간에 적용되는 선로사용 계약
- `stationAccessAgreementIds[][]`: 각 역 정차 때 적용되는 계약
- `passengerMode`, `passengerWeight`
- `startDay`, `startedAtSimMinute`, `startedAtGameMinute`

구간·역 매핑은 호출자가 명시한다. 경영 엔진이나 지도 엔진이 외부 구간 길이와 정차역을 추측하지 않는다. 연결된 모든 선로사용 계약은 적어도 한 구간 또는 한 역에 나타나야 하며, 연결되지 않은 계약 ID는 거부한다.

일반 영업 서비스가 이미 사용하는 `operationalLineId`는 직통 정산에 다시 연결할 수 없다. 직통 서비스는 `commissionThroughServiceOperation()`으로 별도의 실제 운행선을 만드는 것이 기본 흐름이다.

## 실제 실적

운행 중 다음 누계를 시뮬레이션 날짜별로 기록한다.

- 실제 직통 승객 수
- 실제 직통열차 주행 km
- 계약별 실제 외부 구간 주행 km
- 계약별 실제 역 정차 횟수

기본 승객 모드는 `terminal-to-terminal`이다. 직통 운행선의 양 끝 역 사이를 환승 없이 한 번에 이용해 도착한 승객만 연락운임 승객으로 센다. 중간역 이용객과 다른 노선을 환승한 이용객은 B12-4의 전 구간 연락운임 인원에서 제외한다. 개별 승객 엔진은 `passengerWeight`를 적용하고, pop 엔진은 이미 실제 인원 집단이므로 해당 인원수를 그대로 기록한다.

열차-km와 정차 횟수는 계획 운행량이나 계약 고정값으로 추정하지 않는다. `stepTrains()`가 실제로 이동시킨 거리와 `dispatchTrains()`/역 도착 때 발생한 실제 정차를 기록한다.

## 자동 정산과 원자성

`ScenarioRuntime.settleOperatingDays()`는 현재 진행 중인 날짜를 제외한 완료일을 순서대로 B12-4에 전달한다. 성공한 날짜의 원시 지도 누계는 제거되고 감사 가능한 정산 보고서는 경영 엔진에 남는다.

한 배치 안에서 다음을 함께 처리한다.

- 기존 일반 노선 정산
- 직통 서비스 일별 정산
- 운영금융 달력 정산
- 게임 시계 정렬

중간 하나라도 실패하면 게임 원장·시계·계약 누계·직통 정산·지도 실적·노선 상태를 배치 시작 전으로 되돌린다. 실패한 날짜의 원시 실적은 재시도를 위해 보존한다.

## 상태와 저장

- 직통 서비스가 `suspended`, `assessed`, `terminated`가 되면 실제 직통 운행선을 중단하고 운행 중 열차를 제거한다.
- 다시 `approved`가 되면 운행선을 재개한다.
- 바인딩과 미정산 일별 실적은 통합 저장의 `operations`에 포함된다.
- 구저장본처럼 관련 키가 없으면 읽기 전용 보고는 빈 배열을 반환하고 원본 상태를 변경하지 않는다.

## 현재 한계와 다음 단계

- 운행선의 역 순서와 계약별 구간·역 매핑은 아직 UI에서 입력하지 않는다.
- 연락운임 승객은 전 구간 종점 간 승객만 센다. OD별 부분 연락운임은 후속 범위다.
- 직통열차용 차량 편성은 선택 차량 모델의 차량 수를 사용하지만, 실제 차량 유닛 배정·고장·예비편성은 아직 일반 서비스 자원 풀과 연결하지 않았다.
- 클루드의 직통운행 지도 뷰 계약이 완료되면 이 바인딩의 `operationalLineId`와 일별 실적을 읽기 전용으로 넘겨 지도 표시를 연결한다.
- 다음 구현은 직통 서비스·연락운임·차량개조·실적을 조작하는 경영 UI다.
