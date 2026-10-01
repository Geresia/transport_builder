# B11-2 — 복수 노선 공동운용 자원 풀

작성일: 2026-10-01
통화: 일본 엔(JPY)
상태: 구현 및 자동 테스트 완료

## 목적

기존 엔진은 노선마다 차량 주문과 차량기지를 하나씩 독점한다고 가정했다. B11-2는 같은 회사의 여러 노선이 차량·예비편성·동시근무 인력·차량기지 유치 및 검사 용량을 함께 쓰게 한다. 공동운용을 설정하지 않은 기존 노선은 이전 규칙으로 그대로 운행한다.

일본 철도 사례 조사에서 확인한 물리 선로와 운행 서비스의 분리, 차량기지 공동 사용, 상호직통 운전의 기반 가운데 **회사 내부 자원 공유**까지만 이번 단계에 포함했다. 다른 회사와의 선로사용료·정산·직통협약은 B11-3 이후 범위다.

## 플레이 규칙

1. 플레이어는 하나 이상의 차량 주문과 차량기지를 묶어 공동운용 풀을 만든다.
2. 풀에 노선을 배정하고 우선순위와 기본 차량기지를 지정한다.
3. 엔진은 노선의 필요 운용편성을 주력 편성으로 중복 없이 고정 배정한다.
4. 남은 호환 편성은 모든 소속 노선이 사용할 수 있는 공동 예비편성이 된다.
5. 주력차 고장 시 같은 형식의 공동 예비차가 대신 운행한다.
6. 한 영업일에 이미 운행한 편성은 다른 노선에 다시 투입할 수 없다.
7. 동시근무 인력이 부족하면 우선순위에 따라 실제 운행 가능 편성이 줄어든다.
8. 차량기지 유치 용량 부족은 경고로 표시하고, 검사 처리량은 노선의 필요 편성 비율로 나눈다.
9. 차량기지 임차비와 부대수입도 같은 비율로 배분하여 노선 손익에 중복 계상하지 않는다.

## 데이터 계약

스키마는 `transitline.operating-resource-pool/1`, 계약 버전은 1이다.

주요 필드:

- 식별: `id`, `name`, `revision`
- 포함 자원: `vehicleOrderIds[]`, `depotIds[]`, `totalStaffConcurrent`
- 노선 배정: `assignments[]`
- 노선별 배정: `serviceId`, `priority`, `homeDepotId`, `primaryUnitIds[]`, `requestedPrimarySets`, `staffRequired`, `staffAssigned`, `maximumStaffedSets`, `shortfalls[]`, `status`
- 공동 예비: `sharedReserveUnitIds[]`
- 총용량: `capacity.totalVehicleSets`, `assignedPrimarySets`, `sharedReserveSets`, `totalDepotCapacitySets`, `totalInspectionSetsPerDay`, `depotStorageShortfallSets`

대표 경고 어휘는 `primary-fleet-shortfall`, `staff-shortfall`, `depot-storage-shortfall`이다.

## 엔진 연결

- `ManagementGame.createOperatingResourcePool(input)`
- `ManagementGame.assignServiceToOperatingResourcePool(serviceId, poolId, options)`
- `ManagementGame.removeServiceFromOperatingResourcePool(serviceId)`
- `ManagementGame.rebalanceOperatingResourcePool(poolId)`
- `ManagementGame.operatingResourcePoolReport(poolId?)`
- `ManagementGame.resolveOperatingResources(serviceId)`

일반 일일 운행과 실제 지도 운행량을 사용하는 통합 정산이 모두 같은 자원 해석 함수를 사용한다. 노선 정책에서 운행횟수를 바꾸면 필요 편성을 다시 계산하고 풀도 재배분한다. 차량 주문의 제작이 끝나 편성이 늘어난 경우에는 월 진행 때 재배분한다.

저장본에는 `operatingResourcePools[]`, 노선의 `resourcePoolId`, 차량의 마지막 투입 영업일이 함께 저장된다. 구버전 저장본에는 이 배열이 없으므로 빈 배열로 복원하며 기존 전용운용이 유지된다.

## 화면

`개통 후 월별 운영손익` 패널에 다음을 추가했다.

- 공동운용 풀별 소속 노선, 주력 편성, 공동 예비, 동시근무 인력, 유치 용량, 검사 처리량
- 제약 및 부족 경고
- 미배정 노선이 2개 이상일 때 통합 운용본부를 만드는 버튼
- 노선별 공동운용 여부와 공동운용 해제 버튼

자동 생성 버튼은 미배정된 개통 노선을 한 풀로 묶고, 현재 차량 주문·차량기지를 포함하며, 필요 동시근무 인력에 10% 여유를 더한다. 이후 정밀한 인력 채용·해고와 차량 전속 변경은 후속 단계에서 별도 명령으로 확장한다.

## 검증

- 서로 다른 노선에 같은 주력 편성을 배정하지 않음
- 공동 예비편성이 고장 편성을 대체함
- 같은 영업일의 공동 예비편성 중복 투입 차단
- 우선순위에 따른 동시근무 인력 부족과 감편
- 운행횟수 변경 후 자동 재배분
- 차량기지 유치·검사 용량 집계와 부족 경고
- 저장·복원 후 풀, 배정, 노선 연결 유지
- 풀을 사용하지 않는 기존 노선의 동작 유지
- 전체 테스트: 535개 중 533개 통과, 실패 0개, 기존 건너뜀 2개

## 남은 한계와 다음 단계

- 현재 풀은 한 회사 내부 자원만 공유한다. 타사 차량 대차, 선로사용료, 수익배분은 없다.
- 차량 형식 호환은 `modelId` 일치로 판단한다. 궤간·전압·신호·차상장치의 구간별 호환은 B12-2 대상이다.
- 인력은 총 동시근무 인원으로만 계산한다. 직종·교대·노조협약·교육 자격은 아직 없다.
- 차량기지 검사 처리량은 필요 편성 비율로 정적 배분한다. 실제 입고시각과 검사선 점유 스케줄은 아직 없다.
- 다음 B11-3은 경쟁회사와의 선로사용 계약, 직통운전 협약, 사용료·운임수입 배분을 구현한다.
